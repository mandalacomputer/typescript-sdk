import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { parseArgs } from '../src/cli-options.js';
import type { CliIO } from '../src/cli-runtime.js';
import {
  configSnippet,
  configValue,
  ensureKnownHosts,
  fingerprint,
  GATEWAY_KEY,
  gateway,
  hostAlias,
  identityOptions,
  keyPath,
  knownHostsPath,
  mergeConfig,
  pinnedKnownHosts,
  proxyCommand,
  readPublicKey,
  type SshRuntime,
  shellWord,
  sshArgv,
  writeConfig,
} from '../src/cli-ssh.js';
import { Client, ConflictError, ValidationError } from '../src/index.js';
import {
  anyRoute,
  BASE,
  type Call,
  COMPUTER,
  json,
  type Responder,
  recorder,
  SSH_ACCESS,
  SSH_KEY,
} from './harness.js';

const temp: string[] = [];
afterEach(async () => {
  for (const path of temp.splice(0)) await rm(path, { recursive: true, force: true });
});
async function tempDir(prefix = 'mandala-ssh-') {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temp.push(path);
  return path;
}

/** A public key line whose fingerprint is SSH_KEY's. */
const PUBLIC = `${GATEWAY_KEY} me@laptop`;
const OTHER_KEY =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMxlN5MDRT9cXdHi871o7Ty3dKfNLt8mNmjSWtwv6DTw other';
const PIN = `[ssh.mandala.computer]:2222 ${GATEWAY_KEY}`;
const KH = '/home/me/.mandala/ssh_known_hosts';

// --- the command line -------------------------------------------------------

describe('ssh argv', () => {
  const gw = gateway({});

  it('is exact: guest options, then the pinned gateway in an explicit ProxyCommand, then the id', () => {
    expect(
      sshArgv({ ssh: '/usr/bin/ssh', computerId: 'vm-1', gateway: gw, knownHosts: KH }),
    ).toEqual([
      '/usr/bin/ssh',
      '-o',
      'User=user',
      '-o',
      'HostKeyAlias=vm-1',
      '-o',
      'StrictHostKeyChecking=accept-new',
      '-o',
      `UserKnownHostsFile=${KH}`,
      '-o',
      `ProxyCommand=/usr/bin/ssh -o UserKnownHostsFile=${KH} -o StrictHostKeyChecking=yes -p 2222 -W %h:%p mandala@ssh.mandala.computer`,
      'vm-1',
    ]);
  });

  it('passes extra args verbatim after the id, and offers a chosen key to the gateway too', () => {
    const argv = sshArgv({
      ssh: '/usr/bin/ssh',
      computerId: 'vm-1',
      gateway: gw,
      knownHosts: KH,
      extra: ['-i', '/k/work key', '-L', '8080:localhost:8080', '--', 'echo', 'two words', "it's"],
    });
    expect(argv[10]).toBe(
      `ProxyCommand=/usr/bin/ssh -o UserKnownHostsFile=${KH} -o StrictHostKeyChecking=yes -i '/k/work key' -p 2222 -W %h:%p mandala@ssh.mandala.computer`,
    );
    expect(argv.slice(11)).toEqual([
      'vm-1',
      '-i',
      '/k/work key',
      '-L',
      '8080:localhost:8080',
      '--',
      'echo',
      'two words',
      "it's",
    ]);
  });

  it('quotes a known_hosts path with spaces for ssh, then for the shell, and doubles %', () => {
    const kh = "/Users/Jo O'Neil/100%/kh";
    const argv = sshArgv({
      ssh: '/opt/my tools/ssh',
      computerId: 'vm-1',
      gateway: gw,
      knownHosts: kh,
    });
    expect(argv[8]).toBe(`UserKnownHostsFile="${kh}"`);
    expect(argv[10]).toBe(
      `ProxyCommand='/opt/my tools/ssh' -o 'UserKnownHostsFile="/Users/Jo O'"'"'Neil/100%%/kh"' -o StrictHostKeyChecking=yes -p 2222 -W %h:%p mandala@ssh.mandala.computer`,
    );
  });

  it('the ProxyCommand survives /bin/sh as the words it was built from', () => {
    const proxy = proxyCommand('/opt/my tools/ssh', gw, "/Users/Jo O'Neil/kh", [
      '-o',
      'IdentityFile=/k/a b',
    ]);
    const words = spawnSync('/bin/sh', ['-c', `printf '%s\\n' ${proxy}`], { encoding: 'utf8' })
      .stdout.trimEnd()
      .split('\n');
    expect(words).toEqual([
      '/opt/my tools/ssh',
      '-o',
      `UserKnownHostsFile="/Users/Jo O'Neil/kh"`,
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      'IdentityFile=/k/a b',
      '-p',
      '2222',
      '-W',
      '%h:%p',
      'mandala@ssh.mandala.computer',
    ]);
  });

  it('quotes for Windows when running there', () => {
    expect(proxyCommand('C:\\Program Files\\ssh.exe', gw, 'C:\\Users\\me\\kh', [], true)).toBe(
      '"C:\\Program Files\\ssh.exe" -o UserKnownHostsFile=C:\\Users\\me\\kh -o StrictHostKeyChecking=yes -p 2222 -W %h:%p mandala@ssh.mandala.computer',
    );
  });

  it('refuses a path with a double quote, and quotes an empty one', () => {
    expect(() => configValue('/a"b')).toThrow(/double quote/);
    expect(configValue('')).toBe('""');
    expect(configValue('/a\tb')).toBe('"/a\tb"');
  });

  it('shell words match shlex.quote', () => {
    expect(shellWord('%h:%p')).toBe('%h:%p');
    expect(shellWord('a b')).toBe("'a b'");
    expect(shellWord("it's")).toBe(`'it'"'"'s'`);
    expect(shellWord('')).toBe("''");
    expect(shellWord('$(x)')).toBe("'$(x)'");
  });
});

describe('identity options for the gateway hop', () => {
  it.each([
    [
      ['-i', 'k'],
      ['-i', 'k'],
    ],
    [['-ik'], ['-i', 'k']],
    [
      ['-vi', 'k'],
      ['-i', 'k'],
    ],
    [
      ['-o', 'IdentityFile=k', '-o', 'Compression=yes'],
      ['-o', 'IdentityFile=k'],
    ],
    [['-oIdentitiesOnly yes'], ['-o', 'IdentitiesOnly yes']],
    [
      ['-o', 'identityagent=/s', '-o', 'CertificateFile /c'],
      ['-o', 'identityagent=/s', '-o', 'CertificateFile /c'],
    ],
    [
      ['-L', '1:h:2', '-i', 'k'],
      ['-i', 'k'],
    ],
    [
      ['-p', '-i', '-i', 'k'],
      ['-i', 'k'],
    ],
    [['--', '-i', 'k'], []],
    [['uname', '-i', 'k'], []],
    [['-', '-i', 'k'], []],
    [['-i'], []],
    [['-A', '-t'], []],
  ])('%j → %j', (extra, found) => {
    expect(identityOptions(extra)).toEqual(found);
  });
});

describe('ssh command-line parsing', () => {
  it('hands everything after the computer to ssh, unchanged', () => {
    expect(parseArgs(['ssh', 'dev', '-L', '8080:localhost:8080'])).toMatchObject({
      path: 'ssh',
      args: ['dev'],
      rest: ['-L', '8080:localhost:8080'],
    });
    expect(parseArgs(['ssh', 'dev', '--', 'uname', '-a']).rest).toEqual(['--', 'uname', '-a']);
    expect(parseArgs(['ssh', 'dev', '--json']).rest).toEqual(['--json']);
    expect(parseArgs(['ssh', '--json', 'dev']).json).toBe(true);
    expect(parseArgs(['ssh', '--', 'dev', '-v']).rest).toEqual(['-v']);
    expect(parseArgs(['ssh', 'dev']).rest).toEqual([]);
  });

  it('parses --setup normally, so --key and --json may follow the computer', () => {
    expect(parseArgs(['ssh', '--setup', 'dev', '--key', 'k.pub', '--json'])).toMatchObject({
      args: ['dev'],
      flags: { setup: true, key: 'k.pub' },
      json: true,
      rest: [],
    });
    expect(() => parseArgs(['ssh', '--setup', 'dev', 'extra'])).toThrow(/mandala ssh <computer>/);
    expect(() => parseArgs(['ssh', '--setup', 'dev', '-L', 'x'])).toThrow(/unknown option -L/);
  });

  it('takes optional positionals and checks their choices', () => {
    expect(parseArgs(['ssh-access', 'dev']).args).toEqual(['dev']);
    expect(parseArgs(['ssh-access', 'dev', 'off']).args).toEqual(['dev', 'off']);
    expect(() => parseArgs(['ssh-access', 'dev', 'maybe'])).toThrow(
      /state must be one of: on, off/,
    );
    expect(() => parseArgs(['ssh-access', 'dev', 'on', 'x'])).toThrow(
      /mandala ssh-access <computer> \[state\]/,
    );
    expect(parseArgs(['ssh-key', 'add']).args).toEqual([]);
    expect(() => parseArgs(['ssh-key', 'rm'])).toThrow(/ssh-key rm <id>/);
  });
});

// --- the gateway and known_hosts -------------------------------------------

describe('gateway selection', () => {
  it('pins the public gateway by default', () => {
    expect(gateway({})).toEqual({ host: 'ssh.mandala.computer', port: 2222, knownHosts: [PIN] });
  });

  it('takes host, host:port and [v6]:port, with the public key pinned under that name', () => {
    expect(gateway({ MANDALA_SSH_GATEWAY: 'gw.example.test:2200' })).toEqual({
      host: 'gw.example.test',
      port: 2200,
      knownHosts: [`[gw.example.test]:2200 ${GATEWAY_KEY}`],
    });
    expect(gateway({ MANDALA_SSH_GATEWAY: 'gw.example.test' }).port).toBe(2222);
    expect(gateway({ MANDALA_SSH_GATEWAY: '[2001:db8::1]:22' })).toEqual({
      host: '2001:db8::1',
      port: 22,
      knownHosts: [`2001:db8::1 ${GATEWAY_KEY}`],
    });
  });

  it('takes known hosts as a line or a file', async () => {
    expect(
      gateway({ MANDALA_SSH_GATEWAY_KNOWN_HOSTS: '[gw]:1 ssh-ed25519 AAAA' }).knownHosts,
    ).toEqual(['[gw]:1 ssh-ed25519 AAAA']);
    const home = await tempDir();
    fs.writeFileSync(
      join(home, 'pins'),
      '# comment\n[gw]:1 ssh-ed25519 AAAA\n\n[gw]:1 ssh-rsa BBBB\n',
    );
    expect(gateway({ MANDALA_SSH_GATEWAY_KNOWN_HOSTS: '~/pins' }, home).knownHosts).toEqual([
      '[gw]:1 ssh-ed25519 AAAA',
      '[gw]:1 ssh-rsa BBBB',
    ]);
  });

  it('refuses malformed overrides', () => {
    for (const value of ['gw:0', 'gw:70000', 'gw:x', 'a b:22', '-gw'])
      expect(() => gateway({ MANDALA_SSH_GATEWAY: value })).toThrow(
        `MANDALA_SSH_GATEWAY is not host:port: ${JSON.stringify(value)}`,
      );
    expect(() => gateway({ MANDALA_SSH_GATEWAY_KNOWN_HOSTS: '/no/such/file' })).toThrow(
      'MANDALA_SSH_GATEWAY_KNOWN_HOSTS must be known_hosts lines (<host> <key type> <base64>), or a file of them',
    );
  });

  it('puts the pin first, replaces older lines for that host, and keeps the rest', () => {
    expect(pinnedKnownHosts('', gateway({}))).toBe(`${PIN}\n`);
    const current = `vm-1 ssh-ed25519 GUEST\n[ssh.mandala.computer]:2222 ssh-ed25519 OLD\n\nvm-2 ssh-rsa G2\n`;
    expect(pinnedKnownHosts(current, gateway({}))).toBe(
      `${PIN}\nvm-1 ssh-ed25519 GUEST\nvm-2 ssh-rsa G2\n`,
    );
  });

  it('creates the file 0600 in a 0700 directory, and rewrites it only on change', async () => {
    const home = await tempDir();
    const file = knownHostsPath(home);
    expect(file).toBe(join(home, '.mandala', 'ssh_known_hosts'));
    ensureKnownHosts(gateway({}), file);
    expect(fs.readFileSync(file, 'utf8')).toBe(`${PIN}\n`);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(join(home, '.mandala')).mode & 0o777).toBe(0o700);
    fs.appendFileSync(file, 'vm-1 ssh-ed25519 GUEST\n');
    const before = fs.statSync(file).ino;
    ensureKnownHosts(gateway({}), file);
    expect(fs.statSync(file).ino).toBe(before);
    expect(fs.readFileSync(file, 'utf8')).toBe(`${PIN}\nvm-1 ssh-ed25519 GUEST\n`);
  });
});

// --- public keys ------------------------------------------------------------

describe('public keys', () => {
  it('fingerprints the way ssh-keygen does', () => {
    expect(fingerprint(PUBLIC)).toBe('SHA256:09QlEDFrF+XXV/2u4X/pBAufS+8iaKwRzW6+EvIPVkg');
    expect(fingerprint(OTHER_KEY)).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    expect(() => fingerprint('ssh-ed25519')).toThrow('not an OpenSSH public key line');
    expect(() => fingerprint('ssh-ed25519 not*base64')).toThrow('not an OpenSSH public key line');
  });

  it('reads one key line and refuses anything else', async () => {
    const dir = await tempDir();
    const at = (name: string, text: string | Uint8Array) => {
      fs.writeFileSync(join(dir, name), text);
      return join(dir, name);
    };
    expect(readPublicKey(at('ok.pub', `\n${PUBLIC}\n`))).toBe(PUBLIC);
    const priv = at('id', '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n');
    expect(() => readPublicKey(priv)).toThrow(
      `${priv} is a private key; pass the .pub file beside it`,
    );
    const two = at('two.pub', `${PUBLIC}\n${OTHER_KEY}\n`);
    expect(() => readPublicKey(two)).toThrow(`${two} must hold exactly one public key line`);
    const binary = at('bin.pub', Uint8Array.from([0xff, 0xfe, 0x00]));
    expect(() => readPublicKey(binary)).toThrow(`${binary} is not an OpenSSH public key`);
    expect(() => readPublicKey(join(dir, 'missing.pub'))).toThrow(/cannot read .*ENOENT/);
  });

  it('discovers ed25519, then ecdsa, then rsa', async () => {
    const home = await tempDir();
    expect(() => keyPath(home)).toThrow(
      'no SSH public key found (looked for ~/.ssh/id_ed25519.pub, ~/.ssh/id_ecdsa.pub, ~/.ssh/id_rsa.pub); create one with ssh-keygen -t ed25519, or pass --key PATH',
    );
    fs.mkdirSync(join(home, '.ssh'));
    fs.writeFileSync(join(home, '.ssh', 'id_rsa.pub'), OTHER_KEY);
    expect(keyPath(home)).toBe(join(home, '.ssh', 'id_rsa.pub'));
    fs.writeFileSync(join(home, '.ssh', 'id_ecdsa.pub'), OTHER_KEY);
    expect(keyPath(home)).toBe(join(home, '.ssh', 'id_ecdsa.pub'));
    fs.writeFileSync(join(home, '.ssh', 'id_ed25519.pub'), PUBLIC);
    expect(keyPath(home)).toBe(join(home, '.ssh', 'id_ed25519.pub'));
    expect(keyPath(home, '~/.ssh/other.pub')).toBe(join(home, '.ssh', 'other.pub'));
  });

  it('refuses bad keys in the SDK body builder too, before any request', async () => {
    const rec = recorder(anyRoute);
    const client = new Client({ apiKey: 'k', baseUrl: BASE, fetch: rec.fetch });
    await expect(
      client.sshKeys.add({ publicKey: '-----BEGIN OPENSSH PRIVATE KEY-----' }),
    ).rejects.toThrow(ValidationError);
    await expect(client.sshKeys.add({ publicKey: '  ' })).rejects.toThrow(/must not be empty/);
    await expect(client.sshKeys.add({ publicKey: 'a\nb' })).rejects.toThrow(/single line/);
    await expect(client.sshKeys.add({ publicKey: PUBLIC, name: '' })).rejects.toThrow(
      /name must not be empty/,
    );
    expect(rec.calls).toEqual([]);
  });
});

// --- ~/.ssh/config -----------------------------------------------------------

describe('ssh config', () => {
  const gw = gateway({});
  const GATEWAY_BLOCK = `# >>> mandala gateway >>>
Host mandala-gateway
  HostName ssh.mandala.computer
  Port 2222
  User mandala
  UserKnownHostsFile ${KH}
  StrictHostKeyChecking yes
# <<< mandala gateway <<<`;
  const computerBlock = (host: string, id = 'vm-1') => `# >>> mandala computer ${id} >>>
Host ${host}
  HostName ${id}
  User user
  ProxyJump mandala-gateway
  HostKeyAlias ${id}
  UserKnownHostsFile ${KH}
  StrictHostKeyChecking accept-new
# <<< mandala computer ${id} <<<`;
  const snippet = configSnippet('demo', 'vm-1', gw, KH);

  it('is a gateway block and a computer block', () => {
    expect(snippet).toBe(`${GATEWAY_BLOCK}\n\n${computerBlock('demo')}\n`);
    expect(configSnippet('demo', 'vm-1', gw, '/a b/kh')).toContain('UserKnownHostsFile "/a b/kh"');
  });

  it('names the host by id when the name cannot be one', () => {
    expect(hostAlias('my box', 'vm-2')).toBe('vm-2');
    expect(hostAlias('web*', 'vm-2')).toBe('vm-2');
    expect(hostAlias('', 'vm-2')).toBe('vm-2');
    expect(hostAlias('-x', 'vm-2')).toBe('vm-2');
    expect(hostAlias('dev.box_1', 'vm-2')).toBe('dev.box_1');
  });

  it('merges: appends once, replaces in place, keeps everything else byte for byte', () => {
    const mine = 'Host work\n  User me';
    const once = mergeConfig(mine, snippet);
    expect(once).toBe(`${mine}\n\n${GATEWAY_BLOCK}\n\n${computerBlock('demo')}\n`);
    expect(mergeConfig(once, snippet)).toBe(once);
    const later = `${once}\nHost after\n  User me\n`;
    const renamed = mergeConfig(later, configSnippet('renamed', 'vm-1', gw, KH));
    expect(renamed).toBe(later.replace('Host demo', 'Host renamed'));
    const both = mergeConfig(renamed, configSnippet('other', 'vm-2', gw, KH));
    expect(both).toBe(`${renamed}\n${computerBlock('other', 'vm-2')}\n`);
    expect(both.match(/Host mandala-gateway/g)).toHaveLength(1);
  });

  it('ignores a marker that is not a whole line', () => {
    const text = `# note: # >>> mandala gateway >>> is ours\n`;
    expect(mergeConfig(text, snippet).startsWith(`${text}\n${GATEWAY_BLOCK}`)).toBe(true);
  });

  it('creates a missing file 0600 and keeps an existing file’s mode', async () => {
    const home = await tempDir();
    const file = join(home, '.ssh', 'config');
    expect(writeConfig(file, snippet)).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe(snippet);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(join(home, '.ssh')).mode & 0o777).toBe(0o700);
    expect(writeConfig(file, snippet)).toBe(false);
    fs.chmodSync(file, 0o644);
    expect(writeConfig(file, configSnippet('renamed', 'vm-1', gw, KH))).toBe(true);
    expect(fs.statSync(file).mode & 0o777).toBe(0o644);
  });
});

// --- the commands, end to end over a recorded API ----------------------------

async function cli(
  args: string[],
  opts: {
    respond?: Responder;
    home?: string;
    ssh?: string | null;
    exit?: number;
    env?: NodeJS.ProcessEnv;
  } = {},
) {
  const home = opts.home ?? (await tempDir());
  const rec = recorder((call) =>
    call.method === 'GET' && call.path === `/computers/${COMPUTER.name}`
      ? json({ error: 'no such computer ID' }, { status: 404 })
      : (opts.respond ?? anyRoute)(call),
  );
  const ran: string[][] = [];
  let out = '';
  let err = '';
  let clients = 0;
  const runtime: SshRuntime = {
    home: () => home,
    windows: false,
    which: () => (opts.ssh === null ? undefined : (opts.ssh ?? '/usr/bin/ssh')),
    run: async (argv) => {
      ran.push(argv);
      return opts.exit ?? 0;
    },
  };
  const io: Partial<CliIO> = {
    env: { MANDALA_API_KEY: 'com_cli_test', ...opts.env },
    stdin: Object.assign(Readable.from([]), { isTTY: true }),
    stdout: {
      write: ((s: unknown) => {
        out += s;
        return true;
      }) as NodeJS.WritableStream['write'],
    },
    stderr: {
      write: ((s: unknown) => {
        err += s;
        return true;
      }) as NodeJS.WritableStream['write'],
    },
    createClient: () => {
      clients++;
      return new Client({ apiKey: 'com_cli_test', baseUrl: BASE, fetch: rec.fetch });
    },
    now: () => new Date('2026-09-16T00:00:00Z'),
    ssh: runtime,
  };
  const code = await main(args, io);
  return { code, out, err, ran, rec, home, clients };
}

/** anyRoute, with the SSH answers replaced. */
const withSsh =
  (access: Record<string, unknown>, keys: unknown[] = [SSH_KEY], put?: Record<string, unknown>) =>
  (call: Call): Response | Promise<Response> => {
    if (call.path === '/computers/vm-1/ssh')
      return json(call.method === 'PUT' ? (put ?? { ...access, enabled: true }) : access);
    if (call.path === '/ssh-keys' && call.method === 'GET') return json(keys);
    return anyRoute(call);
  };

const writes = (r: { rec: { routes: () => [string, string][] } }) =>
  r.rec.routes().filter(([m]) => m !== 'GET');

describe('mandala ssh', () => {
  it('reads the setting and the keys, then runs ssh and returns its status', async () => {
    const r = await cli(['ssh', 'demo', '-L', '8080:localhost:8080', '--', 'uname -a'], {
      exit: 42,
    });
    expect(r.code).toBe(42);
    expect(r.out).toBe('');
    expect(r.err).toBe('');
    expect(r.rec.routes()).toEqual([
      ['GET', 'computers'],
      ['GET', 'computers/demo'],
      ['GET', 'computers/vm-1/ssh'],
      ['GET', 'ssh-keys'],
    ]);
    const kh = knownHostsPath(r.home);
    expect(r.ran).toEqual([
      sshArgv({
        ssh: '/usr/bin/ssh',
        computerId: 'vm-1',
        gateway: gateway({}),
        knownHosts: kh,
        extra: ['-L', '8080:localhost:8080', '--', 'uname -a'],
      }),
    ]);
    expect(r.ran[0]!.slice(-5)).toEqual(['vm-1', '-L', '8080:localhost:8080', '--', 'uname -a']);
    expect(fs.readFileSync(kh, 'utf8')).toBe(`${PIN}\n`);
  });

  it('uses an overridden gateway in the ProxyCommand and the pin', async () => {
    const r = await cli(['ssh', 'vm-1'], {
      env: {
        MANDALA_SSH_GATEWAY: 'gw.example.test:2200',
        MANDALA_SSH_GATEWAY_KNOWN_HOSTS: '[gw.example.test]:2200 ssh-ed25519 AAAATEST',
      },
    });
    expect(r.code).toBe(0);
    expect(r.ran[0]![10]).toMatch(/ -p 2200 -W %h:%p mandala@gw\.example\.test$/);
    expect(fs.readFileSync(knownHostsPath(r.home), 'utf8')).toBe(
      '[gw.example.test]:2200 ssh-ed25519 AAAATEST\n',
    );
  });

  it.each([
    [
      'the template predates SSH',
      withSsh({ ...SSH_ACCESS, available: false, enabled: false }),
      'mandala: demo was made from a template that predates SSH; create a new computer to use SSH, or use "mandala terminal demo" for a shell without a key\n',
    ],
    [
      'SSH is off',
      withSsh({ ...SSH_ACCESS, enabled: false, key_count: 0, keys_pushed: 0 }, []),
      'mandala: SSH is off for demo; run "mandala ssh --setup demo" to turn it on, or use "mandala terminal demo" for a shell without a key\n',
    ],
    [
      'the caller has no key',
      withSsh(SSH_ACCESS, []),
      'mandala: you have no SSH keys registered; run "mandala ssh --setup demo" to add one, or use "mandala terminal demo" for a shell without a key\n',
    ],
  ])('refuses, and never runs anything, when %s', async (_, respond, line) => {
    const r = await cli(['ssh', 'demo'], { respond });
    expect(r.code).toBe(1);
    expect(r.out).toBe('');
    expect(r.err).toBe(line);
    expect(r.ran).toEqual([]);
    expect(writes(r)).toEqual([]);
  });

  it('labels by name and quotes the target it was given in the advice', async () => {
    const r = await cli(['ssh', 'vm-1'], {
      respond: (call) =>
        call.path === '/computers'
          ? json([{ ...COMPUTER, name: 'my box' }])
          : withSsh({ ...SSH_ACCESS, enabled: false })(call),
    });
    expect(r.err).toBe(
      'mandala: SSH is off for my box; run "mandala ssh --setup vm-1" to turn it on, or use "mandala terminal vm-1" for a shell without a key\n',
    );
  });

  it('connects while availability is still unknown', async () => {
    const r = await cli(['ssh', 'vm-1'], { respond: withSsh({ ...SSH_ACCESS, available: null }) });
    expect(r.code).toBe(0);
    expect(r.ran).toHaveLength(1);
  });

  it('exits 127 without touching the API when there is no ssh client', async () => {
    const r = await cli(['ssh', 'demo'], { ssh: null });
    expect(r.code).toBe(127);
    expect(r.err).toBe(
      'mandala: no ssh command found on PATH; install OpenSSH, or use "mandala terminal <computer>" for a shell without it\n',
    );
    expect(r.rec.calls).toEqual([]);
  });

  it('refuses --json and a stray --key with exit 2 before creating a client', async () => {
    const asJson = await cli(['ssh', '--json', 'demo']);
    expect(asJson.code).toBe(2);
    expect(JSON.parse(asJson.out)).toMatchObject({
      ok: false,
      exitCode: 2,
      error: {
        code: 'unsupported_mode',
        message: 'ssh is interactive and has no --json output',
      },
    });
    expect(asJson.clients).toBe(0);
    const human = await cli(['ssh', '--key', 'k.pub', 'demo']);
    expect(human.code).toBe(2);
    expect(human.err).toBe(
      'mandala: --key goes with --setup; to connect with a particular key, pass -i PATH after the computer\n',
    );
    expect(human.clients).toBe(0);
  });

  it('passes a --json after the computer on to ssh', async () => {
    const r = await cli(['ssh', 'vm-1', '--json']);
    expect(r.ran[0]!.slice(-2)).toEqual(['vm-1', '--json']);
  });
});

describe('mandala ssh --setup', () => {
  async function homeWithKey(key = PUBLIC) {
    const home = await tempDir();
    fs.mkdirSync(join(home, '.ssh'));
    fs.writeFileSync(join(home, '.ssh', 'id_ed25519.pub'), `${key}\n`);
    return home;
  }

  it('registers the key, switches SSH on, and prints the connect command', async () => {
    const home = await homeWithKey();
    const r = await cli(['ssh', '--setup', 'demo'], {
      home,
      respond: withSsh({ ...SSH_ACCESS, enabled: false, key_count: 0 }, []),
    });
    expect(r.code).toBe(0);
    expect(r.rec.routes()).toEqual([
      ['GET', 'computers'],
      ['GET', 'computers/demo'],
      ['GET', 'ssh-keys'],
      ['POST', 'ssh-keys'],
      ['PUT', 'computers/vm-1/ssh'],
    ]);
    expect(r.rec.calls[3]!.body).toEqual({ public_key: PUBLIC });
    expect(r.rec.calls[4]!.body).toEqual({ enabled: true });
    expect(r.out).toBe(
      'key SHA256:09QlEDFrF+XXV/2u4X/pBAufS+8iaKwRzW6+EvIPVkg (laptop) registered\nSSH is on for demo\nconnect with: mandala ssh demo\n',
    );
    expect(r.err).toBe('');
    expect(r.ran).toEqual([]);
    expect(fs.readFileSync(knownHostsPath(home), 'utf8')).toBe(`${PIN}\n`);
  });

  it('is idempotent: a registered key is not uploaded again', async () => {
    const home = await homeWithKey();
    for (let i = 0; i < 2; i++) {
      const r = await cli(['ssh', '--setup', 'demo', '--json'], { home });
      expect(r.code).toBe(0);
      expect(writes(r)).toEqual([['PUT', 'computers/vm-1/ssh']]);
      expect(JSON.parse(r.out)).toEqual({
        schemaVersion: 1,
        command: 'ssh',
        ok: true,
        exitCode: 0,
        data: {
          computer: 'vm-1',
          name: 'demo',
          key: SSH_KEY,
          key_added: false,
          ssh: SSH_ACCESS,
          command: 'mandala ssh demo',
        },
      });
    }
  });

  it('uses --key, and settles a conflict that turns out to be its own key', async () => {
    const home = await tempDir();
    const key = join(home, 'throwaway.pub');
    fs.writeFileSync(key, PUBLIC);
    let lists = 0;
    const r = await cli(['ssh', '--setup', 'demo', '--key', key], {
      home,
      respond: (call) => {
        if (call.path === '/ssh-keys' && call.method === 'GET')
          return json(lists++ ? [SSH_KEY] : []);
        if (call.path === '/ssh-keys')
          return json({ error: 'That key is already registered.' }, { status: 409 });
        return anyRoute(call);
      },
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain('(laptop) already registered\n');
    expect(r.rec.routes().filter(([, p]) => p === 'ssh-keys')).toEqual([
      ['GET', 'ssh-keys'],
      ['POST', 'ssh-keys'],
      ['GET', 'ssh-keys'],
    ]);
  });

  it('reports a key somebody else holds, and switches nothing on', async () => {
    const home = await homeWithKey();
    const r = await cli(['ssh', '--setup', 'demo'], {
      home,
      respond: (call) => {
        if (call.path === '/ssh-keys' && call.method === 'GET') return json([]);
        if (call.path === '/ssh-keys')
          return json(
            { error: 'That key is already registered. A key can belong to one person only.' },
            { status: 409 },
          );
        return anyRoute(call);
      },
    });
    expect(r.code).toBe(1);
    expect(r.out).toBe('');
    expect(r.err).toBe(
      'mandala: That key is already registered. A key can belong to one person only.\n',
    );
    expect(writes(r)).toEqual([['POST', 'ssh-keys']]);
  });

  it('fails without a key, before any request', async () => {
    const r = await cli(['ssh', '--setup', 'demo', '--json']);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out).error).toEqual({
      code: 'no_ssh_key',
      message:
        'no SSH public key found (looked for ~/.ssh/id_ed25519.pub, ~/.ssh/id_ecdsa.pub, ~/.ssh/id_rsa.pub); create one with ssh-keygen -t ed25519, or pass --key PATH',
    });
    expect(r.rec.calls).toEqual([]);
  });

  it.each([
    [
      { available: false },
      'ssh_unavailable',
      'demo was made from a template that predates SSH; create a new computer to use SSH',
    ],
    [
      { error: 'refused: status 500' },
      'ssh_refused',
      "the computer's host refused the SSH setting: refused: status 500",
    ],
  ])(
    'prints nothing like success when the setting cannot work (%j)',
    async (change, code, message) => {
      const home = await homeWithKey();
      const respond = withSsh(SSH_ACCESS, [SSH_KEY], { ...SSH_ACCESS, ...change });
      const human = await cli(['ssh', '--setup', 'demo'], { home, respond });
      expect(human.code).toBe(1);
      expect(human.out).toBe('');
      expect(human.err).toBe(`mandala: ${message}\n`);
      expect(fs.existsSync(knownHostsPath(home))).toBe(false);
      const asJson = await cli(['ssh', '--setup', 'demo', '--json'], { home, respond });
      expect(asJson.code).toBe(1);
      expect(JSON.parse(asJson.out)).toEqual({
        schemaVersion: 1,
        command: 'ssh',
        ok: false,
        error: { code, message },
        exitCode: 1,
      });
    },
  );

  it('notes a setting the host has not received yet', async () => {
    const home = await homeWithKey();
    const r = await cli(['ssh', '--setup', 'demo'], {
      home,
      respond: withSsh(SSH_ACCESS, [SSH_KEY], { ...SSH_ACCESS, pending: true }),
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain('connect with: mandala ssh demo\n');
    expect(r.err).toBe(
      'mandala: demo has not received the setting yet; it is sent again automatically, and connecting sends it first\n',
    );
  });
});

describe('mandala ssh-key, ssh-access, ssh-config', () => {
  it('lists keys as a table, or as the wire rows', async () => {
    const human = await cli(['ssh-key', 'list']);
    expect(human.rec.routes()).toEqual([['GET', 'ssh-keys']]);
    expect(human.out).toBe(
      'ID                     TYPE         FINGERPRINT                                         LAST USED  NAME\n' +
        'sshk-a1b2c3d4e5f60718  ssh-ed25519  SHA256:09QlEDFrF+XXV/2u4X/pBAufS+8iaKwRzW6+EvIPVkg  never      laptop\n',
    );
    const asJson = await cli(['ssh-key', 'list', '--json']);
    expect(JSON.parse(asJson.out).data).toEqual([SSH_KEY]);
    const none = await cli(['ssh-key', 'list'], { respond: withSsh(SSH_ACCESS, []) });
    expect(none.out).toBe('');
    expect(none.err).toBe('no SSH keys\n');
  });

  it('adds a key with a name', async () => {
    const home = await tempDir();
    const file = join(home, 'k.pub');
    fs.writeFileSync(file, OTHER_KEY);
    const r = await cli(['ssh-key', 'add', file, '--name', 'ci'], { home });
    expect(r.code).toBe(0);
    expect(r.rec.routes()).toEqual([['POST', 'ssh-keys']]);
    expect(r.rec.last().body).toEqual({ public_key: OTHER_KEY, name: 'ci' });
    expect(r.out).toBe(
      'added sshk-a1b2c3d4e5f60718  SHA256:09QlEDFrF+XXV/2u4X/pBAufS+8iaKwRzW6+EvIPVkg  laptop\n',
    );
    const asJson = await cli(['ssh-key', 'add', file, '--json'], { home });
    expect(JSON.parse(asJson.out).data).toEqual(SSH_KEY);
    expect(asJson.rec.last().body).toEqual({ public_key: OTHER_KEY });
  });

  it('adds the default key', async () => {
    const home = await tempDir();
    fs.mkdirSync(join(home, '.ssh'));
    fs.writeFileSync(join(home, '.ssh', 'id_ecdsa.pub'), OTHER_KEY);
    const r = await cli(['ssh-key', 'add'], { home });
    expect(r.rec.last().body).toEqual({ public_key: OTHER_KEY });
  });

  it('removes a key by id', async () => {
    const r = await cli(['ssh-key', 'rm', 'sshk-a1b2c3d4e5f60718']);
    expect(r.rec.routes()).toEqual([['DELETE', 'ssh-keys/sshk-a1b2c3d4e5f60718']]);
    expect(r.out).toBe('removed sshk-a1b2c3d4e5f60718\n');
    const asJson = await cli(['ssh-key', 'rm', 'sshk-1', '--json']);
    expect(JSON.parse(asJson.out).data).toEqual({ id: 'sshk-1', removed: true });
  });

  it('shows and switches SSH for a computer', async () => {
    const read = await cli(['ssh-access', 'demo']);
    expect(read.rec.routes().at(-1)).toEqual(['GET', 'computers/vm-1/ssh']);
    expect(read.out).toBe('SSH is on for demo\n  keys: 1 of 1 delivered\n');
    const asJson = await cli(['ssh-access', 'demo', '--json']);
    expect(JSON.parse(asJson.out).data).toEqual(SSH_ACCESS);
    const off = await cli(['ssh-access', 'demo', 'off'], {
      respond: withSsh(SSH_ACCESS, [], {
        ...SSH_ACCESS,
        enabled: false,
        available: null,
        pending: true,
        error: 'refused: status 500',
      }),
    });
    expect(off.rec.routes().at(-1)).toEqual(['PUT', 'computers/vm-1/ssh']);
    expect(off.rec.last().body).toEqual({ enabled: false });
    expect(off.out).toBe(
      "SSH is off for demo\n  whether demo can run SSH is not known yet; it is checked at its next start\n  pending: the computer's host has not received the current setting yet\n  error: refused: status 500\n",
    );
    const on = await cli(['ssh-access', 'vm-1', 'on'], {
      respond: withSsh(SSH_ACCESS, [], { ...SSH_ACCESS, available: false }),
    });
    expect(on.rec.last().body).toEqual({ enabled: true });
    expect(on.out).toBe(
      'SSH is on for demo\n  demo was made from a template that predates SSH; create a new computer to use SSH\n  keys: 1 of 1 delivered\n',
    );
  });

  it('prints the config snippet, or writes it', async () => {
    const printed = await cli(['ssh-config', 'demo']);
    const kh = knownHostsPath(printed.home);
    expect(printed.out).toBe(configSnippet('demo', 'vm-1', gateway({}), kh));
    expect(fs.readFileSync(kh, 'utf8')).toBe(`${PIN}\n`);
    expect(fs.existsSync(join(printed.home, '.ssh', 'config'))).toBe(false);

    const written = await cli(['ssh-config', 'demo', '--write', '--json']);
    const file = join(written.home, '.ssh', 'config');
    expect(JSON.parse(written.out).data).toEqual({
      computer: 'vm-1',
      name: 'demo',
      host: 'demo',
      config: fs.readFileSync(file, 'utf8'),
      path: file,
      changed: true,
    });
    const again = await cli(['ssh-config', 'demo', '--write'], { home: written.home });
    expect(again.out).toBe(`already up to date: Host demo in ${file}\nconnect with: ssh demo\n`);
    const renamed = await cli(['ssh-config', 'vm-1', '--write'], {
      home: written.home,
      respond: (call) =>
        call.path === '/computers' ? json([{ ...COMPUTER, name: 'renamed' }]) : anyRoute(call),
    });
    expect(renamed.out).toBe(`wrote Host renamed in ${file}\nconnect with: ssh renamed\n`);
    const plain = await cli(['ssh-config', 'demo', '--json']);
    expect(JSON.parse(plain.out).data).toMatchObject({ path: null, changed: null });
  });

  it('uses the id as the Host when another computer shares the name', async () => {
    const r = await cli(['ssh-config', 'vm-1'], {
      respond: (call) =>
        call.path === '/computers' ? json([COMPUTER, { ...COMPUTER, id: 'vm-2' }]) : anyRoute(call),
    });
    expect(r.code).toBe(0);
    expect(r.err).toBe('mandala: another computer is also named demo; using Host vm-1 instead\n');
    expect(r.out).toContain('\nHost vm-1\n  HostName vm-1\n');
    expect(r.rec.routes()).toEqual([['GET', 'computers']]);
    const written = await cli(['ssh-config', 'vm-1', '--write', '--json'], {
      respond: (call) =>
        call.path === '/computers' ? json([COMPUTER, { ...COMPUTER, id: 'vm-2' }]) : anyRoute(call),
    });
    expect(JSON.parse(written.out).data.host).toBe('vm-1');
    expect(fs.readFileSync(join(written.home, '.ssh', 'config'), 'utf8')).toContain('Host vm-1\n');
  });
});

describe('SSH SDK methods', () => {
  const client = (respond: Responder) => {
    const rec = recorder(respond);
    return { rec, client: new Client({ apiKey: 'k', baseUrl: BASE, fetch: rec.fetch }) };
  };

  it('decode keys and settings, keeping nulls as nulls', async () => {
    const { client: c } = client(anyRoute);
    expect(await c.sshKeys.list()).toEqual([
      {
        id: SSH_KEY.id,
        name: 'laptop',
        publicKey: SSH_KEY.public_key,
        fingerprint: SSH_KEY.fingerprint,
        keyType: 'ssh-ed25519',
        createdAt: SSH_KEY.created_at,
        lastUsedAt: null,
        raw: SSH_KEY,
      },
    ]);
    const vm = await c.computers.get('vm-1');
    expect(await vm.sshAccess()).toEqual({
      computer: 'vm-1',
      enabled: true,
      available: true,
      pending: false,
      keyCount: 1,
      keysPushed: 1,
      error: null,
      raw: SSH_ACCESS,
    });
    const unknown = client((call) =>
      call.path.endsWith('/ssh')
        ? json({ ...SSH_ACCESS, available: null, error: 'refused: status 500' })
        : json(COMPUTER),
    );
    const other = await unknown.client.computers.get('vm-1');
    expect(await other.sshAccess()).toMatchObject({
      available: null,
      error: 'refused: status 500',
    });
  });

  it('refuses an empty setting and a non-boolean switch', async () => {
    const { client: c, rec } = client((call) =>
      call.path.endsWith('/ssh') ? json({}) : json(COMPUTER),
    );
    const vm = await c.computers.get('vm-1');
    await expect(vm.sshAccess()).rejects.toThrow(
      'expected an SSH setting from GET computers/vm-1/ssh',
    );
    const before = rec.calls.length;
    await expect(vm.setSshAccess('yes' as unknown as boolean)).rejects.toThrow(ValidationError);
    expect(rec.calls.length).toBe(before);
    await expect(c.sshKeys.remove('')).rejects.toThrow(/ssh key id must not be empty/);
  });

  it('maps a duplicate key to ConflictError', async () => {
    const { client: c } = client(() =>
      json({ error: 'That key is already registered.' }, { status: 409 }),
    );
    await expect(c.sshKeys.add({ publicKey: OTHER_KEY })).rejects.toBeInstanceOf(ConflictError);
  });
});
