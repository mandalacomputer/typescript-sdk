/**
 * `mandala ssh`, `ssh-key`, `ssh-access` and `ssh-config`: real OpenSSH to a
 * computer, through the Mandala SSH gateway.
 *
 * The gateway is a jump host. A connection is two hops: OpenSSH to the gateway
 * on port 2222 as `mandala`, and through it to the computer's own sshd on port
 * 22 as `user`. The gateway checks the key you offer on the first hop, and the
 * computer checks it again on the second.
 *
 * The jump is an explicit ProxyCommand rather than `-J`, because ssh does not
 * apply `-o` options from its own command line to a `-J` hop: the gateway's
 * pinned host key would never reach it and the jump would fail host key
 * verification. The config-file form (`ssh-config`) uses a `Host` block for the
 * gateway, which `ProxyJump` does honour.
 *
 * Host keys live in one known_hosts file this CLI manages: the gateway's pinned
 * lines first, and each computer's key trusted on first use under
 * `HostKeyAlias=<computer id>`, so a rename does not look like a new machine.
 *
 * There is no fallback to `mandala terminal`. A computer that cannot take an
 * SSH session is a non-zero exit that says what to do, never a different
 * program running in its place.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { resolveComputer } from './cli-commands.js';
import { CliError } from './cli-options.js';
import { type Output, terminalSafe } from './cli-output.js';
import type { CliIO } from './cli-runtime.js';
import type { Computer } from './computer.js';
import { ConflictError } from './errors.js';
import type { Client, Listing, SshAccess, SshKey } from './index.js';

/** The public gateway. `MANDALA_SSH_GATEWAY` overrides it (`host:port`). */
export const GATEWAY_HOST = 'ssh.mandala.computer';
export const GATEWAY_PORT = 2222;
/** The gateway ignores the user name it is given; this is the one to give it. */
export const GATEWAY_USER = 'mandala';
/** The gateway's host key, pinned. `MANDALA_SSH_GATEWAY_KNOWN_HOSTS` overrides it. */
export const GATEWAY_KEY =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJlZegWyY5KLksV9y22mZHnDI4qm++st9qZnbpSId1DR';
/** The account every computer's sshd logs you in as. */
export const GUEST_USER = 'user';
/** The `Host` name the `ssh-config` snippet gives the gateway. */
export const GATEWAY_ALIAS = 'mandala-gateway';
/** The public keys `--setup` and `ssh-key add` look for, in this order. */
export const DEFAULT_KEYS = ['id_ed25519.pub', 'id_ecdsa.pub', 'id_rsa.pub'] as const;
/** The CLI's own directory, shared with the saved credentials. */
export const CONFIG_DIR = '.mandala';
/** The known_hosts file the CLI manages, in {@link CONFIG_DIR}. */
export const KNOWN_HOSTS = 'ssh_known_hosts';

/** What the SSH commands need from the machine they run on; replaced in tests. */
export type SshRuntime = {
  home: () => string;
  /** The absolute path of `ssh` on PATH, or undefined. */
  which: (env: NodeJS.ProcessEnv) => string | undefined;
  /** Run `argv` on this terminal and return its exit status. */
  run: (argv: string[]) => Promise<number>;
  windows: boolean;
};

export const defaultSshRuntime: SshRuntime = {
  home: () => os.homedir(),
  windows: process.platform === 'win32',
  which: (env) => {
    const names = process.platform === 'win32' ? ['ssh.exe', 'ssh'] : ['ssh'];
    for (const dir of (env.PATH ?? '').split(path.delimiter)) {
      if (!dir) continue;
      for (const name of names) {
        const candidate = path.join(dir, name);
        try {
          fs.accessSync(candidate, fs.constants.X_OK);
          if (fs.statSync(candidate).isFile()) return candidate;
        } catch {}
      }
    }
    return undefined;
  },
  // Node cannot replace its own process, so ssh runs as a child on this
  // terminal and its status becomes this one's.
  run: ([file, ...args]) =>
    new Promise((resolve, reject) => {
      const child = spawn(file!, args, { stdio: 'inherit' });
      // Ctrl-C belongs to ssh: the terminal delivers it to both processes, and
      // this one must outlive it to report ssh's exit status.
      const ignore = () => {};
      const forward = (signal: NodeJS.Signals) => () => child.kill(signal);
      const term = forward('SIGTERM');
      const hup = forward('SIGHUP');
      process.on('SIGINT', ignore);
      process.on('SIGTERM', term);
      process.on('SIGHUP', hup);
      const done = () => {
        process.off('SIGINT', ignore);
        process.off('SIGTERM', term);
        process.off('SIGHUP', hup);
      };
      child.on('error', (error) => {
        done();
        reject(error);
      });
      child.on('exit', (code, signal) => {
        done();
        resolve(code ?? 128 + (signal ? (os.constants.signals[signal] ?? 0) : 0));
      });
    }),
};

// --- the gateway ----------------------------------------------------------

export type Gateway = {
  host: string;
  port: number;
  /** known_hosts lines pinning the gateway's key. */
  knownHosts: readonly string[];
};

const tilde = (file: string, home: string): string =>
  file === '~' ? home : file.startsWith('~/') ? path.join(home, file.slice(2)) : file;

function hostPort(spelled: string): { host: string; port: number } {
  const refuse = (): never => {
    throw new CliError(
      'invalid_arguments',
      `MANDALA_SSH_GATEWAY is not host:port: ${JSON.stringify(spelled)}`,
    );
  };
  let host: string;
  let portText: string | undefined;
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(spelled);
  if (bracketed) [, host, portText] = bracketed as unknown as [string, string, string | undefined];
  else if (spelled.split(':').length === 2)
    [host, portText] = spelled.split(':') as [string, string];
  else host = spelled;
  if (!host || /\s/.test(host) || host.startsWith('-')) refuse();
  if (portText === undefined) return { host, port: GATEWAY_PORT };
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || port < 1 || port > 65535) refuse();
  return { host, port };
}

/**
 * The gateway to use: the public one, or the environment's override.
 *
 * `MANDALA_SSH_GATEWAY` is `host` or `host:port` (`[v6]:port` for an IPv6
 * address), port 2222 when none is given. `MANDALA_SSH_GATEWAY_KNOWN_HOSTS` is
 * a known_hosts line, or the path of a file of them, pinning its key. Without
 * it, the overridden gateway must present the public gateway's key.
 */
export function gateway(env: NodeJS.ProcessEnv, home = os.homedir()): Gateway {
  let host = GATEWAY_HOST;
  let port = GATEWAY_PORT;
  const spelled = env.MANDALA_SSH_GATEWAY?.trim();
  if (spelled) ({ host, port } = hostPort(spelled));
  const pinned = env.MANDALA_SSH_GATEWAY_KNOWN_HOSTS?.trim();
  let lines = [`${knownHostsName(host, port)} ${GATEWAY_KEY}`];
  if (pinned) {
    let text = pinned;
    const file = tilde(pinned, home);
    try {
      if (fs.statSync(file).isFile()) text = fs.readFileSync(file, 'utf8');
    } catch {}
    lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
    if (!lines.length)
      throw new CliError(
        'invalid_arguments',
        'MANDALA_SSH_GATEWAY_KNOWN_HOSTS holds no known_hosts line',
      );
    if (lines.some((line) => line.split(/\s+/).length < 3))
      throw new CliError(
        'invalid_arguments',
        'MANDALA_SSH_GATEWAY_KNOWN_HOSTS must be known_hosts lines (<host> <key type> <base64>), or a file of them',
      );
  }
  return { host, port, knownHosts: lines };
}

/** The known_hosts name ssh looks a host and port up by. */
export const knownHostsName = (host: string, port: number): string =>
  port === 22 ? host : `[${host}]:${port}`;

// --- the managed known_hosts file ------------------------------------------

export const knownHostsPath = (home: string): string => path.join(home, CONFIG_DIR, KNOWN_HOSTS);

/** Replace `file` with `text` through a temporary sibling, at `mode`. */
function replaceFile(file: string, text: string, mode: number): void {
  const temp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${Date.now()}`,
  );
  try {
    fs.writeFileSync(temp, text, { mode: 0o600, flag: 'wx' });
    fs.chmodSync(temp, mode);
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

const readIfThere = (file: string): string | undefined => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
};

/** `current` with the gateway's lines first, and every other host's kept. */
export function pinnedKnownHosts(current: string, gw: Gateway): string {
  const pinned = new Set(gw.knownHosts.map((line) => line.split(/\s+/)[0]));
  const kept = current
    .split('\n')
    .filter((line) => line.trim() && !pinned.has(line.trim().split(/\s+/)[0]));
  return `${[...gw.knownHosts, ...kept].join('\n')}\n`;
}

/**
 * Make `file` pin the gateway, keeping every computer key already in it.
 *
 * Any other line for the pinned host names is dropped, so a changed pin
 * replaces the old one rather than sitting beside it. The directory is created
 * 0700 and the file 0600, and the file is rewritten only when its content
 * would change.
 */
export function ensureKnownHosts(gw: Gateway, file: string): void {
  const current = readIfThere(file);
  const wanted = pinnedKnownHosts(current ?? '', gw);
  if (wanted === current) return;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  replaceFile(file, wanted, 0o600);
}

// --- the ssh command line ----------------------------------------------------

/**
 * One value for an ssh `-o` option or config line, quoted if it must be.
 *
 * ssh splits these values on whitespace (`UserKnownHostsFile` takes a list), so
 * a path with a space in it is quoted, the one form OpenSSH reads back as a
 * single word.
 */
export function configValue(value: string): string {
  if (value === '' || /\s/.test(value) || value.includes('"')) {
    if (value.includes('"'))
      throw new CliError(
        'invalid_arguments',
        `cannot pass a path containing a double quote to ssh: ${JSON.stringify(value)}`,
      );
    return `"${value}"`;
  }
  return value;
}

/** One word for `/bin/sh`, as Python's `shlex.quote` spells it. */
export function shellWord(word: string): string {
  if (word === '') return "''";
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'"'"'`)}'`;
}

/** One word for a Windows command line, as Python's `subprocess.list2cmdline` spells it. */
function windowsWord(word: string): string {
  if (word !== '' && !/[\s"]/.test(word)) return word;
  let out = '"';
  let slashes = 0;
  for (const c of word) {
    if (c === '\\') slashes++;
    else if (c === '"') {
      out += `${'\\'.repeat(slashes * 2)}\\"`;
      slashes = 0;
    } else {
      out += `${'\\'.repeat(slashes)}${c}`;
      slashes = 0;
    }
  }
  return `${out}${'\\'.repeat(slashes * 2)}"`;
}

/**
 * One word of the ProxyCommand: shell-quoted, with `%` doubled.
 *
 * ssh expands `%` tokens in a ProxyCommand and hands the result to a shell, so a
 * literal `%` must be written `%%` and every word quoted for that shell.
 */
const proxyWord = (word: string, windows: boolean): string =>
  (windows ? windowsWord(word) : shellWord(word)).replaceAll('%', '%%');

/** ssh's options that take an argument, so a scan knows where each one ends. */
const OPTS_WITH_ARG = new Set('BbcDEeFIiJLlmOoPpQRSWw');
/** `-o` settings that choose the key offered; the gateway checks the same key. */
const IDENTITY_SETTINGS = new Set([
  'identityfile',
  'identitiesonly',
  'identityagent',
  'certificatefile',
]);

/**
 * The key-choosing options among `extra`, spelled for the gateway hop.
 *
 * `-i PATH` (or `-iPATH`) and `-o IdentityFile=…`-style settings. A
 * ProxyCommand hop does not inherit the outer command line, so without this
 * `mandala ssh dev -i ~/.ssh/work` would offer that key to the computer and not
 * to the gateway in front of it. The scan stops where ssh's own does: at `--`
 * or the first word that is not an option, which begins the remote command.
 */
export function identityOptions(extra: readonly string[]): string[] {
  const found: string[] = [];
  for (let i = 0; i < extra.length; i++) {
    const word = extra[i]!;
    if (word === '--' || !word.startsWith('-') || word === '-') break;
    for (let j = 1; j < word.length; j++) {
      const letter = word[j]!;
      if (!OPTS_WITH_ARG.has(letter)) continue;
      let value = word.slice(j + 1);
      if (!value) {
        i++;
        if (i >= extra.length) return found;
        value = extra[i]!;
      }
      if (letter === 'i') found.push('-i', value);
      else if (letter === 'o') {
        const key = value.trim().split(/[\s=]/, 1)[0]!.toLowerCase();
        if (IDENTITY_SETTINGS.has(key)) found.push('-o', value);
      }
      break;
    }
  }
  return found;
}

/** The command that carries the connection through the gateway. */
export function proxyCommand(
  ssh: string,
  gw: Gateway,
  knownHosts: string,
  identity: readonly string[] = [],
  windows = false,
): string {
  const words = [
    ssh,
    '-o',
    `UserKnownHostsFile=${configValue(knownHosts)}`,
    '-o',
    'StrictHostKeyChecking=yes',
    ...identity,
    '-p',
    String(gw.port),
  ];
  return [
    ...words.map((w) => proxyWord(w, windows)),
    '-W',
    '%h:%p',
    proxyWord(`${GATEWAY_USER}@${gw.host}`, windows),
  ].join(' ');
}

/**
 * The whole `ssh` command line for one computer.
 *
 * The computer's id is the destination and its host key alias, so its key is
 * stored once however the computer is renamed. Everything in `extra` follows
 * the destination unchanged; any key it chooses is also offered to the gateway.
 */
export function sshArgv(opts: {
  ssh: string;
  computerId: string;
  gateway: Gateway;
  knownHosts: string;
  extra?: readonly string[];
  windows?: boolean;
}): string[] {
  const extra = opts.extra ?? [];
  return [
    opts.ssh,
    '-o',
    `User=${GUEST_USER}`,
    '-o',
    `HostKeyAlias=${opts.computerId}`,
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    `UserKnownHostsFile=${configValue(opts.knownHosts)}`,
    '-o',
    `ProxyCommand=${proxyCommand(opts.ssh, opts.gateway, opts.knownHosts, identityOptions(extra), opts.windows)}`,
    opts.computerId,
    ...extra,
  ];
}

// --- ~/.ssh/config --------------------------------------------------------

const markerBegin = (what: string) => `# >>> mandala ${what} >>>`;
const markerEnd = (what: string) => `# <<< mandala ${what} <<<`;

/** The `Host` a config block is written under: the name, where it can be one. */
export const hostAlias = (name: string, computerId: string): string =>
  name && /^[A-Za-z0-9._-]+$/.test(name) && !name.startsWith('-') ? name : computerId;

/**
 * The `~/.ssh/config` blocks for one computer, markers included: the gateway,
 * which `ProxyJump` does honour options for, and the computer, jumping through
 * it. `ssh <name>`, `scp`, `sftp` and VS Code's Remote-SSH all read them.
 */
export function configSnippet(
  name: string,
  computerId: string,
  gw: Gateway,
  knownHosts: string,
  host = hostAlias(name, computerId),
): string {
  const kh = configValue(knownHosts);
  const gatewayBlock = [
    markerBegin('gateway'),
    `Host ${GATEWAY_ALIAS}`,
    `  HostName ${gw.host}`,
    `  Port ${gw.port}`,
    `  User ${GATEWAY_USER}`,
    `  UserKnownHostsFile ${kh}`,
    '  StrictHostKeyChecking yes',
    markerEnd('gateway'),
  ].join('\n');
  const computerBlock = [
    markerBegin(`computer ${computerId}`),
    `Host ${host}`,
    `  HostName ${computerId}`,
    `  User ${GUEST_USER}`,
    `  ProxyJump ${GATEWAY_ALIAS}`,
    `  HostKeyAlias ${computerId}`,
    `  UserKnownHostsFile ${kh}`,
    '  StrictHostKeyChecking accept-new',
    markerEnd(`computer ${computerId}`),
  ].join('\n');
  return `${gatewayBlock}\n\n${computerBlock}\n`;
}

/** The first marked block for `label` in `text`, as [start, end). */
function findBlock(text: string, label: string): [number, number] | undefined {
  const begin = markerBegin(label);
  const end = markerEnd(label);
  let at = 0;
  while (true) {
    const start = text.indexOf(begin, at);
    if (start < 0) return undefined;
    at = start + begin.length;
    if ((start > 0 && text[start - 1] !== '\n') || text[at] !== '\n') continue;
    let from = at + 1;
    while (true) {
      const stop = text.indexOf(end, from);
      if (stop < 0) return undefined;
      const after = stop + end.length;
      if (text[stop - 1] === '\n' && (after === text.length || text[after] === '\n'))
        return [start, after];
      from = after;
    }
  }
}

/**
 * `current` with each marked block of `snippet` replaced, or appended.
 *
 * Everything outside the markers is kept byte for byte. A block already there
 * is replaced where it stands, so writing twice changes nothing.
 */
export function mergeConfig(current: string, snippet: string): string {
  let text = current;
  const labels = [...snippet.matchAll(/^# >>> mandala (.+?) >>>$/gm)].map((m) => m[1]!);
  for (const label of labels) {
    const own = findBlock(snippet, label)!;
    const block = snippet.slice(own[0], own[1]);
    const found = findBlock(text, label);
    if (found) {
      text = text.slice(0, found[0]) + block + text.slice(found[1]);
      continue;
    }
    if (text && !text.endsWith('\n')) text += '\n';
    if (text && !text.endsWith('\n\n')) text += '\n';
    text += `${block}\n`;
  }
  return text;
}

/**
 * Merge `snippet` into the ssh config at `file`. Whether it changed.
 *
 * A missing file is created 0600 (and its directory 0700); an existing one
 * keeps its mode.
 */
export function writeConfig(file: string, snippet: string): boolean {
  const current = readIfThere(file);
  const mode = current === undefined ? undefined : fs.statSync(file).mode & 0o7777;
  const merged = mergeConfig(current ?? '', snippet);
  if (current !== undefined && merged === current) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  replaceFile(file, merged, mode ?? 0o600);
  return true;
}

// --- public keys ----------------------------------------------------------

/** The first of {@link DEFAULT_KEYS} in `~/.ssh` that exists. */
export function findDefaultKey(home: string): string | undefined {
  for (const name of DEFAULT_KEYS) {
    const candidate = path.join(home, '.ssh', name);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return undefined;
}

export const noKeyMessage = (): string =>
  `no SSH public key found (looked for ${DEFAULT_KEYS.map((n) => `~/.ssh/${n}`).join(', ')}); create one with ssh-keygen -t ed25519, or pass --key PATH`;

/** The key file named, or the first default one. */
export function keyPath(home: string, given?: string): string {
  if (given !== undefined) return tilde(given, home);
  const found = findDefaultKey(home);
  if (!found) throw new CliError('no_ssh_key', noKeyMessage());
  return found;
}

/** The one key line in a `.pub` file, or an error saying what is wrong. */
export function readPublicKey(file: string): string {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(file);
  } catch (error) {
    throw new CliError(
      'invalid_arguments',
      `cannot read ${file}: ${(error as NodeJS.ErrnoException).code ?? String(error)}`,
    );
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new CliError('invalid_arguments', `${file} is not an OpenSSH public key`);
  }
  if (text.includes('PRIVATE KEY'))
    throw new CliError(
      'invalid_arguments',
      `${file} is a private key; pass the .pub file beside it`,
    );
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length !== 1)
    throw new CliError('invalid_arguments', `${file} must hold exactly one public key line`);
  return lines[0]!;
}

/** `SHA256:…` for a key line, exactly as `ssh-keygen -l` prints it. */
export function fingerprint(publicKey: string): string {
  const blob = publicKey.split(/\s+/)[1];
  if (!blob || !/^[A-Za-z0-9+/]*={0,2}$/.test(blob) || blob.length % 4 !== 0)
    throw new CliError('invalid_arguments', 'not an OpenSSH public key line');
  const digest = createHash('sha256').update(Buffer.from(blob, 'base64')).digest('base64');
  return `SHA256:${digest.replace(/=+$/, '')}`;
}

// --- commands -------------------------------------------------------------

const terminalHint = (target: string) =>
  `or use "mandala terminal ${shellWord(target)}" for a shell without a key`;
const predates = (label: string) =>
  `${label} was made from a template that predates SSH; create a new computer to use SSH`;

/** `mandala ssh <computer> [ssh-args…]`. Returns ssh's exit status. */
export async function sshConnect(
  client: Client,
  io: CliIO,
  rt: SshRuntime,
  target: string,
  extra: readonly string[],
  /** Cancels the lookups; `beforeRun` is called once they are done, just before ssh starts. */
  lookup: { signal?: AbortSignal; beforeRun?: () => void } = {},
): Promise<number> {
  const { signal } = lookup;
  const ssh = rt.which(io.env);
  if (!ssh)
    throw new CliError(
      'ssh_not_found',
      'no ssh command found on PATH; install OpenSSH, or use "mandala terminal <computer>" for a shell without it',
      undefined,
      127,
    );
  const home = rt.home();
  const gw = gateway(io.env, home);
  const quoted = shellWord(target);
  const computer = await resolveComputer(client, target, signal);
  const label = computer.name || computer.id;
  const access = await computer.sshAccess({ signal });
  if (access.available === false)
    throw new CliError('ssh_unavailable', `${predates(label)}, ${terminalHint(target)}`);
  if (!access.enabled)
    throw new CliError(
      'ssh_disabled',
      `SSH is off for ${label}; run "mandala ssh --setup ${quoted}" to turn it on, ${terminalHint(target)}`,
    );
  if (!(await client.sshKeys.list({ signal })).length)
    throw new CliError(
      'ssh_no_keys',
      `you have no SSH keys registered; run "mandala ssh --setup ${quoted}" to add one, ${terminalHint(target)}`,
    );
  const knownHosts = knownHostsPath(home);
  ensureKnownHosts(gw, knownHosts);
  signal?.throwIfAborted();
  lookup.beforeRun?.();
  return rt.run(
    sshArgv({ ssh, computerId: computer.id, gateway: gw, knownHosts, extra, windows: rt.windows }),
  );
}

/**
 * Register `line` unless the caller already has it. A duplicate-key conflict
 * is a race with another `add` when a second listing shows the key is now the
 * caller's, and somebody else's key otherwise.
 */
async function ensureKey(
  client: Client,
  line: string,
  print: string,
  signal?: AbortSignal,
): Promise<{ key: SshKey; added: boolean }> {
  const mine = async () =>
    (await client.sshKeys.list({ signal })).find((k) => k.fingerprint === print);
  const existing = await mine();
  if (existing) return { key: existing, added: false };
  try {
    return { key: await client.sshKeys.add({ publicKey: line }, { signal }), added: true };
  } catch (error) {
    if (!(error instanceof ConflictError)) throw error;
    const raced = await mine();
    if (raced) return { key: raced, added: false };
    throw error;
  }
}

/** `mandala ssh --setup <computer> [--key PATH]`. */
export async function sshSetup(
  client: Client,
  io: CliIO,
  output: Output,
  rt: SshRuntime,
  target: string,
  key: string | undefined,
  signal?: AbortSignal,
): Promise<number> {
  const home = rt.home();
  const file = keyPath(home, key);
  const line = readPublicKey(file);
  const print = fingerprint(line);
  const gw = gateway(io.env, home);
  const computer = await resolveComputer(client, target, signal);
  const label = computer.name || computer.id;
  // A computer known not to run SSH gets neither a key upload nor a switch.
  if ((await computer.sshAccess({ signal })).available === false)
    throw new CliError('ssh_unavailable', predates(label));
  const { key: registered, added } = await ensureKey(client, line, print, signal);
  const access = await computer.setSshAccess(true, { signal });
  // Nothing that reads as success is printed when SSH cannot work here.
  if (access.available === false) throw new CliError('ssh_unavailable', predates(label));
  if (access.error)
    throw new CliError(
      'ssh_refused',
      `the computer's host refused the SSH setting: ${access.error}`,
    );
  ensureKnownHosts(gw, knownHostsPath(home));
  const command = `mandala ssh ${shellWord(target)}`;
  if (output.json)
    output.result({
      computer: computer.id,
      name: computer.name,
      key: registered.raw,
      key_added: added,
      ssh: access.raw,
      command,
    });
  else
    io.stdout.write(
      `${terminalSafe(`key ${registered.fingerprint} (${registered.name}) ${added ? 'registered' : 'already registered'}`)}\n` +
        `${terminalSafe(`SSH is on for ${label}`)}\n` +
        `connect with: ${command}\n`,
    );
  if (access.pending)
    output.diagnostic(
      `mandala: ${label} has not received the setting yet; it is sent again automatically, and connecting sends it first`,
    );
  return 0;
}

/** Columns padded to their widest cell, the last one unpadded. */
function table(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const all = [header, ...rows];
  const widths = header.map((_, i) => Math.max(...all.map((row) => row[i]!.length)));
  return all
    .map((row) =>
      [...row.slice(0, -1).map((cell, i) => cell.padEnd(widths[i]!)), row[row.length - 1]!]
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

/** `mandala ssh-key list`. */
export async function sshKeyList(client: Client, io: CliIO, output: Output): Promise<number> {
  const keys = await client.sshKeys.list();
  if (output.json) return output.result(keys.map((k: SshKey) => k.raw));
  if (keys.length)
    io.stdout.write(
      `${table(
        ['ID', 'TYPE', 'FINGERPRINT', 'LAST USED', 'NAME'],
        // Escaped before the widths are measured, so the columns still line up.
        keys.map((k) =>
          [k.id, k.keyType, k.fingerprint, k.lastUsedAt ?? 'never', k.name].map((cell) =>
            terminalSafe(cell),
          ),
        ),
      )}\n`,
    );
  else output.diagnostic('no SSH keys');
  return 0;
}

/** `mandala ssh-key add [PATH] [--name NAME]`. */
export async function sshKeyAdd(
  client: Client,
  io: CliIO,
  output: Output,
  rt: SshRuntime,
  given: string | undefined,
  name: string | undefined,
): Promise<number> {
  const line = readPublicKey(keyPath(rt.home(), given));
  const key = await client.sshKeys.add({ publicKey: line, name });
  if (output.json) return output.result(key.raw);
  io.stdout.write(`${terminalSafe(`added ${key.id}  ${key.fingerprint}  ${key.name}`)}\n`);
  return 0;
}

/** `mandala ssh-key rm <id>`. */
export async function sshKeyRemove(
  client: Client,
  io: CliIO,
  output: Output,
  id: string,
): Promise<number> {
  await client.sshKeys.remove(id);
  if (output.json) return output.result({ id, removed: true });
  io.stdout.write(`removed ${id}\n`);
  return 0;
}

export function accessLines(label: string, access: SshAccess): string[] {
  const lines = [`SSH is ${access.enabled ? 'on' : 'off'} for ${label}`];
  if (access.available === false) lines.push(`  ${predates(label)}`);
  else if (access.available === null)
    lines.push(`  whether ${label} can run SSH is not known yet; it is checked at its next start`);
  if (access.enabled) lines.push(`  keys: ${access.keysPushed} of ${access.keyCount} delivered`);
  if (access.pending)
    lines.push("  pending: the computer's host has not received the current setting yet");
  if (access.error) lines.push(`  error: ${access.error}`);
  return lines;
}

/** `mandala ssh-access <computer> [on|off]`. */
export async function sshAccessCommand(
  computer: Computer,
  io: CliIO,
  output: Output,
  state: string | undefined,
): Promise<number> {
  const access =
    state === undefined ? await computer.sshAccess() : await computer.setSshAccess(state === 'on');
  if (output.json) return output.result(access.raw);
  io.stdout.write(
    `${accessLines(computer.name || computer.id, access)
      .map((line) => terminalSafe(line))
      .join('\n')}\n`,
  );
  return 0;
}

/** `mandala ssh-config <computer> [--write]`. */
export async function sshConfigCommand(
  computer: Computer,
  /** The listing the lookup read; absent when it resolved the computer another way. */
  listing: Listing<Computer> | undefined,
  io: CliIO,
  output: Output,
  rt: SshRuntime,
  write: boolean,
): Promise<number> {
  const home = rt.home();
  const gw = gateway(io.env, home);
  let host = hostAlias(computer.name, computer.id);
  // A name two computers share would send `ssh <name>` to whichever block
  // came first, so the id stands in for it.
  // Without a complete listing a shared name cannot be ruled out.
  if (host !== computer.id) {
    const reason =
      !listing || listing.incomplete !== null
        ? "could not check other computers' names"
        : listing.items.some((c) => c.name === computer.name && c.id !== computer.id)
          ? `another computer is also named ${computer.name}`
          : undefined;
    if (reason) {
      host = computer.id;
      output.diagnostic(`mandala: ${reason}; using Host ${computer.id} instead`);
    }
  }
  const knownHosts = knownHostsPath(home);
  ensureKnownHosts(gw, knownHosts);
  const snippet = configSnippet(computer.name, computer.id, gw, knownHosts, host);
  const file = path.join(home, '.ssh', 'config');
  const changed = write ? writeConfig(file, snippet) : null;
  if (output.json)
    return output.result({
      computer: computer.id,
      name: computer.name,
      host,
      config: snippet,
      path: write ? file : null,
      changed,
    });
  if (write)
    io.stdout.write(
      `${changed ? 'wrote' : 'already up to date:'} Host ${host} in ${file}\nconnect with: ssh ${host}\n`,
    );
  else io.stdout.write(snippet);
  return 0;
}
