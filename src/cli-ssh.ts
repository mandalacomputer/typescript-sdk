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
 * `bytes` decoded as UTF-8, or `undefined` when one is not valid UTF-8. A
 * leading byte order mark is kept, so a file written back still has it.
 */
function strictUtf8(bytes: Buffer): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/**
 * The ssh config `bytes` as text, its line endings made `\n`, and whether a
 * byte in them is not valid UTF-8 (read as U+FFFD). A file saved with CRLF
 * (or lone CR) line endings holds its marker lines just the same, so `\r\n`
 * and `\r` are read as `\n`: otherwise no written block would be found in
 * it, and `--write` would add a second one beside each.
 */
function configText(bytes: Buffer): { text: string; undecodable: boolean } {
  const strict = strictUtf8(bytes);
  return {
    text: (strict ?? bytes.toString('utf8')).replace(/\r\n?/g, '\n'),
    undecodable: strict === undefined,
  };
}

/** The refusal for an ssh config at `file` that `--write` cannot rewrite intact. */
const notUtf8 = (file: string): CliError =>
  new CliError(
    'invalid_arguments',
    `${file} holds a byte that is not valid UTF-8; fix that byte, then run again`,
  );

/**
 * The ssh config at `file` as `configText` reads it, or `undefined` when
 * there is none. A byte that is not valid UTF-8 is refused with
 * `invalid_arguments`: read as U+FFFD, writing the text back would put that
 * in its place.
 */
function readConfig(file: string): string | undefined {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const { text, undecodable } = configText(bytes);
  if (undecodable) throw notUtf8(file);
  return text;
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
 * Whether some resolver may read `text` as an IPv4 address: one to four
 * dot-separated parts, each digits or `0x` and hex digits. That takes in
 * every form `inet_aton` reads (decimal, `0x` hex, leading-`0` octal, the
 * last part filling the bytes the others leave, so `10.5` is 10.0.0.5 and
 * `167772165` is too) and the looser ones macOS reads as well: `08.0.0.1` is
 * 8.0.0.1 there, `192.168.1.09` an address and `0x.1` 0.0.0.1. No range
 * check either: refusing a name no resolver would take costs only the name,
 * missing one some resolver takes lets a block capture that address. Pure:
 * no DNS.
 */
export function readsAsIPv4(text: string): boolean {
  const parts = text.split('.');
  return parts.length <= 4 && parts.every((part) => /^(?:0x[0-9a-f]*|[0-9]+)$/i.test(part));
}

/**
 * Whether ssh would also read `name`, as a `Host`, as some other destination.
 *
 * OpenSSH matches `Host` patterns without regard to case, so these are
 * compared lowercased: the gateway's own alias, `localhost`, a bare number
 * (`ssh 167772165` is 10.0.0.5), any IPv4 address in the forms a resolver
 * reads (`readsAsIPv4`), a dotted name shaped like a hostname (its last label
 * empty, as in `github.com.`, all letters like a top-level domain, or an
 * `xn--` one), and any listed computer's id, which is that computer's Host
 * when its own name cannot be one. A dotted name whose last label has a
 * digit, such as `ubuntu-24.04`, names no other place: no top-level domain
 * has one. This is mandala-py's rule (OPL-5392).
 */
export function namesAnotherDestination(
  name: string,
  computers: readonly { id: string }[],
): boolean {
  const folded = name.toLowerCase();
  if (folded === GATEWAY_ALIAS || folded === 'localhost') return true;
  if (/^(?:[0-9]+|0x[0-9a-f]*)$/.test(folded)) return true;
  if (folded.includes('.')) {
    if (readsAsIPv4(folded)) return true;
    const last = folded.slice(folded.lastIndexOf('.') + 1);
    if (!last || /^[a-z]+$/.test(last) || last.startsWith('xn--')) return true;
  }
  return computers.some((c) => c.id.toLowerCase() === folded);
}

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

/** The first marked block for `label` in `text` from `from` on, as [start, end). */
function findBlock(text: string, label: string, from = 0): [number, number] | undefined {
  const begin = markerBegin(label);
  const end = markerEnd(label);
  let at = from;
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
 * The arguments of `line` when it is a `Host` line, read as OpenSSH reads a
 * config line (`readconf` and `argv_split`): trailing space, tab and form
 * feed dropped; leading space or tab allowed; the keyword in any case and then
 * space or tab and/or one `=`. The arguments are split on space and tab only,
 * so a no-break space is part of an argument. `'` and `"` both quote, a quote
 * ending only at the same character. A backslash before `'`, `"` or `\` (or,
 * outside quotes, a space) stands for that character; before any other it is
 * kept. An unquoted argument starting with `#` ends the line as a comment.
 * `undefined` for any other line (a `Match` line included). Negated patterns
 * (`!x`) are kept here. A quote left open, which ssh refuses, is read to the
 * end of the line.
 */
function hostLineArgs(line: string): string[] | undefined {
  // Walked back by hand: a `[ \t...]+$` regex retries every start in a long
  // run of spaces that ends before a non-space, which is quadratic. Not
  // trimEnd, which would also drop a no-break space.
  let end = line.length;
  while (end > 0 && ' \t\r\n\f'.includes(line[end - 1]!)) end--;
  const text = line.slice(0, end);
  const keyword = /^[ \t]*host(?:[ \t]*=[ \t]*|[ \t]+|$)/i.exec(text);
  if (!keyword) return undefined;
  const rest = text.slice(keyword[0].length);
  const args: string[] = [];
  let i = 0;
  while (i < rest.length) {
    if (rest[i] === ' ' || rest[i] === '\t') {
      i++;
      continue;
    }
    if (rest[i] === '#') break;
    let arg = '';
    let quote = '';
    for (; i < rest.length; i++) {
      const c = rest[i]!;
      if (c === '\\') {
        const next = rest[i + 1];
        if (next === "'" || next === '"' || next === '\\' || (!quote && next === ' ')) {
          arg += next;
          i++;
        } else {
          arg += c;
        }
      } else if (!quote && (c === ' ' || c === '\t')) break;
      else if (!quote && (c === '"' || c === "'")) quote = c;
      else if (quote && c === quote) quote = '';
      else arg += c;
    }
    args.push(arg);
  }
  return args;
}

/** One marked computer block of an ssh config, as {@link writtenBlocks} reads it. */
interface WrittenBlock {
  id: string;
  /** Every alias of every `Host` line in the block, negated patterns left out. */
  hosts: string[];
  /** The arguments of each `Host` line in the block, one list per line. */
  hostLines: string[][];
  /** Where the block stands in the text it was read from, as [start, end). */
  at: [number, number];
}

/** The marked computer blocks in `text`, as {@link writtenHosts} describes. */
function writtenBlocks(text: string): WrittenBlock[] {
  const written: WrittenBlock[] = [];
  for (const begin of text.matchAll(/^# >>> mandala computer (.+?) >>>$/gm)) {
    const id = begin[1]!;
    const found = findBlock(text, `computer ${id}`, begin.index);
    if (!found || found[0] !== begin.index) continue;
    const hostLines = text
      .slice(found[0], found[1])
      .split('\n')
      .map(hostLineArgs)
      .filter((args) => args !== undefined);
    const hosts = hostLines.flat().filter((arg) => arg && !arg.startsWith('!'));
    written.push({ id, hosts, hostLines, at: found });
  }
  return written;
}

/**
 * The computer blocks written in the ssh config `text`: for each
 * `mandala computer <id>` block whose markers `mergeConfig` would find, its
 * id and every alias of every `Host` line inside it, as OpenSSH reads the
 * line (see `hostLineArgs`): a hand-edited `Host dev # mine`, `Host a b`,
 * `  host=x` or `Host "x"` counts. Negated patterns (`!x`) name no host and
 * are left out; wildcard patterns are kept as written, not expanded. A block
 * with no `Host` line has no hosts. Only the marked blocks are read; the
 * gateway's block, one with no end marker and anything outside the markers
 * are left out.
 */
export function writtenHosts(text: string): { id: string; hosts: string[] }[] {
  return writtenBlocks(text).map(({ id, hosts }) => ({ id, hosts }));
}

/**
 * `text` without any block for `label` that starts at `from` or later. Each
 * goes with its end marker's line break and, when a blank line comes before
 * it, that blank line: the shape an append left.
 */
function withoutLaterCopies(text: string, label: string, from: number): string {
  let out = text;
  let at = from;
  for (let found = findBlock(out, label, at); found; found = findBlock(out, label, at)) {
    let [start, end] = found;
    if (out[end] === '\n') end += 1;
    if (start >= 2 && out[start - 1] === '\n' && out[start - 2] === '\n') start -= 1;
    out = out.slice(0, start) + out.slice(end);
    at = start;
  }
  return out;
}

/**
 * `current` with each marked block of `snippet` replaced, or appended.
 *
 * Everything outside the markers is kept byte for byte. A block already there
 * is replaced where it stands, so writing twice changes nothing. A later copy
 * of a block `snippet` carries (one an earlier version appended to a CRLF
 * config, which it did not read as holding the first) is removed, with the
 * blank line before it; another label's copies are left as they are.
 */
export function mergeConfig(current: string, snippet: string): string {
  let text = current;
  const labels = [...snippet.matchAll(/^# >>> mandala (.+?) >>>$/gm)].map((m) => m[1]!);
  for (const label of labels) {
    const own = findBlock(snippet, label)!;
    const block = snippet.slice(own[0], own[1]);
    const found = findBlock(text, label);
    if (found) {
      text = withoutLaterCopies(text, label, found[1]);
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
 * keeps its mode. One holding a byte that is not valid UTF-8 is refused with
 * `invalid_arguments` and not changed.
 */
export function writeConfig(file: string, snippet: string): boolean {
  // Read with its line endings made `\n`, so a CRLF file's blocks are found
  // and replaced; a changed file is written back with `\n` endings, and an
  // unchanged one is left as it is. A file holding a byte that is not valid
  // UTF-8 is refused, changed or not, and left as it is.
  const current = readConfig(file);
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

/**
 * The blocks in the ssh config at `file` written for computers other than
 * `computerId`, as `writtenBlocks` reads them, and the text they stand in
 * (its line endings made `\n`). A file that is missing or cannot be read
 * holds none. A byte that is not valid UTF-8 is read as U+FFFD, so the
 * blocks are still seen, and `undecodable` says so: that text must never be
 * written back.
 */
function otherWrittenBlocks(
  file: string,
  computerId: string,
): { text: string; blocks: WrittenBlock[]; undecodable: boolean } {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(file);
  } catch {
    return { text: '', blocks: [], undecodable: false };
  }
  const { text, undecodable } = configText(bytes);
  return { text, blocks: writtenBlocks(text).filter((b) => b.id !== computerId), undecodable };
}

/** Whether `block` has `host` among its `Host` aliases, compared without regard to case. */
const usesHost = (block: WrittenBlock, host: string): boolean =>
  block.hosts.some((h) => h.toLowerCase() === host.toLowerCase());

/** `block`, read from `text`, with its one `Host` line made `Host <its id>`. */
function underItsId(text: string, block: WrittenBlock): string {
  return text
    .slice(block.at[0], block.at[1])
    .split('\n')
    .map((line) => (hostLineArgs(line) === undefined ? line : `Host ${block.id}`))
    .join('\n');
}

/** An id OpenSSH reads as one host, and one that cannot start an option. */
const SSH_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

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
  // The id goes into the config text as the marker, HostName, HostKeyAlias
  // and, on every fallback, the Host, so one that is not a plain host word
  // (a line break could start a ProxyCommand) is refused before anything is
  // read, printed or written. mandala-py's `_ssh_id` rule.
  if (!SSH_ID.test(computer.id))
    throw new CliError(
      'invalid_response',
      `the platform returned a computer id SSH cannot use: ${computer.id}`,
    );
  const home = rt.home();
  const gw = gateway(io.env, home);
  let host = hostAlias(computer.name, computer.id);
  // A name two computers share would send `ssh <name>` to whichever block
  // came first, so the id stands in for it.
  // Without a complete listing a shared name cannot be ruled out.
  // A name ssh would also read as some other destination is refused too: a
  // block under it would take over every connection the user makes there, so
  // a computer named github.com would send their pushes to it (OPL-5392,
  // mandala-py's rule).
  // The listing holds only this key's account, so the blocks already in
  // ~/.ssh/config count too: one written for another computer, from another
  // account say, under this name (or with it as its id) would get
  // `ssh <name>` whenever it came first. This computer's own block is the one
  // --write replaces, so it never counts.
  const file = path.join(home, '.ssh', 'config');
  const { text: config, blocks: others, undecodable } = otherWrittenBlocks(file, computer.id);
  const folded = computer.name.toLowerCase();
  let reason: string | undefined;
  if (host !== computer.id) {
    reason =
      !listing || listing.incomplete !== null
        ? "could not check other computers' names"
        : listing.items.some((c) => c.name === computer.name && c.id !== computer.id)
          ? `another computer is also named ${computer.name}`
          : namesAnotherDestination(computer.name, listing.items)
            ? `the name ${computer.name} cannot be a Host, since ssh would also use it for another destination`
            : others.some((b) => b.id.toLowerCase() === folded || usesHost(b, folded))
              ? `a block in ~/.ssh/config already uses the name ${computer.name} for another computer`
              : undefined;
    if (reason) host = computer.id;
  }
  // The id is the last Host there is. When another computer's block already
  // has it among its Host aliases (one named after this computer's id, say),
  // a second block under it would never be reached: `ssh <id>` would go to
  // that other computer. Refused, whatever put the id here, before anything
  // is written. Aliases are compared as written: a wildcard pattern such as
  // `vm-*` is not expanded.
  const holders = others.filter((b) => usesHost(b, host));
  let moved: WrittenBlock | undefined;
  if (holders.length) {
    const holder = holders[0]!;
    // One shape has a way out: the two computers are named after each
    // other's ids (they are in different accounts, so neither listing shows
    // the other). The holder is under this computer's id, which is its name,
    // and this computer's name is the holder's id. Whichever block is written
    // second falls back to its id, which the first holds, so removing a block
    // and running again only swaps which one refuses. The one state where
    // neither refuses is both under their ids, so --write moves the holder's
    // block there too: only its single Host line, which must be the one
    // alias the CLI writes, and only when no other block holds the holder's
    // id and that id can be a Host. Print and --json write nothing, so they
    // refuse and say how to get there.
    const mutual =
      holders.length === 1 &&
      host === computer.id &&
      folded === holder.id.toLowerCase() &&
      holder.id.toLowerCase() !== computer.id.toLowerCase() &&
      holder.hostLines.length === 1 &&
      holder.hostLines[0]!.length === 1 &&
      SSH_ID.test(holder.id) &&
      !others.some((b) => b !== holder && (b.id === holder.id || usesHost(b, holder.id)));
    // The move rewrites the file, which a byte that is not valid UTF-8 rules
    // out (see readConfig), so say why before pointing at --write.
    if (mutual && undecodable)
      throw new CliError(
        'conflict',
        `a block in ~/.ssh/config for computer ${holder.id} already uses Host ${host}, and ~/.ssh/config holds a byte that is not valid UTF-8; fix that byte, then run again`,
      );
    if (!mutual)
      throw new CliError(
        'conflict',
        `a block in ~/.ssh/config for computer ${holder.id} already uses Host ${host}; remove that block, then run again`,
      );
    if (!write)
      throw new CliError(
        'conflict',
        `a block in ~/.ssh/config for computer ${holder.id} already uses Host ${host}, and the two computers are named after each other's ids; run this command with --write to move both to their ids (Host ${holder.id} and Host ${computer.id})`,
      );
    moved = holder;
  }
  if (reason) output.diagnostic(`mandala: ${reason}; using Host ${computer.id} instead`);
  // writeConfig would refuse the file too; refusing here also leaves the
  // known_hosts file untouched.
  if (write && undecodable) throw notUtf8(file);
  const knownHosts = knownHostsPath(home);
  ensureKnownHosts(gw, knownHosts);
  const snippet = configSnippet(computer.name, computer.id, gw, knownHosts, host);
  // The moved block rides along with this computer's, so the one merge
  // replaces both where they stand; the printed and --json config stay this
  // computer's own.
  const changed = write
    ? writeConfig(file, moved ? `${snippet}${underItsId(config, moved)}\n` : snippet)
    : null;
  if (moved)
    output.diagnostic(
      `mandala: computer ${moved.id} is named after this computer's id; moved its block to Host ${moved.id} as well`,
    );
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
