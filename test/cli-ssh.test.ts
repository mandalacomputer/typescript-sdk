import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { CliError, parseArgs } from '../src/cli-options.js';
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
  namesAnotherDestination,
  pinnedKnownHosts,
  proxyCommand,
  readPublicKey,
  readsAsIPv4,
  type SshRuntime,
  shellWord,
  sshArgv,
  writeConfig,
  writtenHosts,
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
    expect(() => parseArgs(['ssh', '--setup', 'dev', 'extra'])).toThrow(
      /^1 argument too many: mandala ssh takes <computer> and nothing more/,
    );
    expect(usageOf(() => parseArgs(['ssh', '--setup', 'dev', 'extra']))).toContain(
      'mandala ssh <computer> [ssh-args...]',
    );
    expect(() => parseArgs(['ssh', '--setup', 'dev', '-L', 'x'])).toThrow(/unknown option -L/);
  });

  it('takes optional positionals and checks their choices', () => {
    expect(parseArgs(['ssh-access', 'dev']).args).toEqual(['dev']);
    expect(parseArgs(['ssh-access', 'dev', 'off']).args).toEqual(['dev', 'off']);
    expect(() => parseArgs(['ssh-access', 'dev', 'maybe'])).toThrow(
      /state must be one of: on, off/,
    );
    expect(() => parseArgs(['ssh-access', 'dev', 'on', 'x'])).toThrow(
      /^1 argument too many: mandala ssh-access takes <computer> \[state\] and nothing more/,
    );
    expect(usageOf(() => parseArgs(['ssh-access', 'dev', 'on', 'x']))).toContain(
      'mandala ssh-access <computer> [state]',
    );
    expect(parseArgs(['ssh-key', 'add']).args).toEqual([]);
    expect(() => parseArgs(['ssh-key', 'rm'])).toThrow(/^missing <id>$/);
    expect(usageOf(() => parseArgs(['ssh-key', 'rm']))).toContain('mandala ssh-key rm <id>');
  });
});

/** The full usage a parse refusal carries, which a person sees under the message. */
function usageOf(parse: () => unknown): string | undefined {
  try {
    parse();
  } catch (error) {
    if (error instanceof CliError) return error.usage;
    throw error;
  }
  throw new Error('expected the parse to be refused');
}

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

  // Every form some resolver reads, macOS's looser ones included: it takes
  // `08.0.0.1` as 8.0.0.1, `192.168.1.09` as an address and `0x.1` as
  // 0.0.0.1, where inet_aton refuses all three. No range check: a part too
  // big for its bytes still reads as an address to be safe.
  it.each([
    ['10.0.0.5', true],
    ['10.5', true],
    ['0x0A.0.0.5', true],
    ['0X0a.0.0.5', true],
    ['012.0.0.5', true],
    ['00.1', true],
    ['167772165', true],
    ['1.16777215', true],
    ['1.2.65535', true],
    ['08.0.0.1', true],
    ['192.168.1.09', true],
    ['0x.1', true],
    ['0X.1', true],
    ['0x.0.0.1', true],
    ['0x', true],
    ['1.2.3.256', true],
    ['256.1', true],
    ['1.16777216', true],
    ['1..2', false],
    ['1.2.3.', false],
    ['1.2.3.4.5', false],
    ['', false],
    ['ubuntu-24.04', false],
    ['a.1', false],
    ['0x1g.1', false],
  ])('reads %s as an IPv4 address: %s', (text, want) => {
    expect(readsAsIPv4(text)).toBe(want);
  });

  it('refuses a name ssh would read as another destination, and only such a name', () => {
    const taken = [
      'github.com',
      'GitHub.COM',
      'github.com.',
      'foo.xn--p1ai',
      '10.5',
      '0x1f',
      '08.0.0.1',
      '192.168.1.09',
      '0x.1',
      '0X.1',
    ];
    for (const name of taken) expect(namesAnotherDestination(name, []), name).toBe(true);
    for (const name of ['demo', 'ubuntu-24.04', 'py3.12', 'web-1', '1.2.3.4.5', 'x.y2'])
      expect(namesAnotherDestination(name, []), name).toBe(false);
    expect(namesAnotherDestination('VM-2', [{ id: 'vm-2' }])).toBe(true);
    expect(namesAnotherDestination('vm-3', [{ id: 'vm-2' }])).toBe(false);
  });

  it('lists the computer blocks written in a config, and only those', () => {
    const text = [
      'Host work',
      '  User me',
      '# >>> mandala computer vm-9 >>>',
      'Host outside-the-markers-before',
      '',
      GATEWAY_BLOCK,
      '',
      computerBlock('dev', 'vm-7'),
      '',
      computerBlock('vm-8', 'vm-8'),
      '# >>> mandala computer vm-6 >>>',
      'Host never-closed',
      '# <<< mandala computer vm-5 <<<',
      'Host after',
      '',
    ].join('\n');
    expect(writtenHosts(text)).toEqual([
      { id: 'vm-7', hosts: ['dev'] },
      { id: 'vm-8', hosts: ['vm-8'] },
    ]);
    expect(writtenHosts(mergeConfig('', snippet))).toEqual([{ id: 'vm-1', hosts: ['demo'] }]);
    expect(writtenHosts('')).toEqual([]);
    // A marker must stand on its own line, as mergeConfig reads it.
    expect(writtenHosts(` ${computerBlock('dev', 'vm-7')}\n`)).toEqual([]);
    expect(writtenHosts(computerBlock('dev', 'vm-7').replace('Host dev\n', ''))).toEqual([
      { id: 'vm-7', hosts: [] },
    ]);
    // A begin marker that does not end its line opens no block, so the block
    // after it is listed once.
    expect(
      writtenHosts(`# >>> mandala computer vm-7 >>>\r\n${computerBlock('dev', 'vm-7')}\n`),
    ).toEqual([{ id: 'vm-7', hosts: ['dev'] }]);
  });

  it.each([
    ['Host a b', ['a', 'b']],
    ['Host vm-1 # note', ['vm-1']],
    ['Host vm-1 #note b', ['vm-1']],
    ['Host a#b', ['a#b']],
    ['  host  x', ['x']],
    ['\tHOST\tx', ['x']],
    ['Host=x', ['x']],
    ['Host = x y', ['x', 'y']],
    ['Host "x y" z', ['x y', 'z']],
    ['Host "#x"', ['#x']],
    ['Host a !b', ['a']],
    ['Host "!b" c', ['c']],
    ['Host vm-*', ['vm-*']],
    ['Host', []],
    ['Host # only a comment', []],
    ['Hostname x', []],
    ['Match host x', []],
    ['# Host x', []],
    // OpenSSH splits on space and tab only, so a no-break space is part of an
    // argument and the `#` after it starts no comment.
    ['Host other\u00a0# vm-9', ['other\u00a0#', 'vm-9']],
    ['Host x\u00a0', ['x\u00a0']],
    ['Host\u00a0x', []],
    ['Host\fx', []],
    ['Host x\f', ['x']],
    // Single quotes quote too, a quote ends only at its own character, and a
    // backslash escapes a quote, a backslash or (outside quotes) a space.
    ["Host 'x y' z", ['x y', 'z']],
    ["Host 'dev'", ['dev']],
    [`Host 'a"b' "c'd"`, ['a"b', "c'd"]],
    ['Host de\\"v', ['de"v']],
    ["Host a\\'b a\\\\b", ["a'b", 'a\\b']],
    ['Host a\\ b', ['a b']],
    ['Host "a\\ b"', ['a\\ b']],
    ['Host a\\x', ['a\\x']],
    ["Host '#x' y", ['#x', 'y']],
  ])('reads every alias of a hand-edited Host line: %j', (line, hosts) => {
    const block = computerBlock('dev', 'vm-7').replace('Host dev', line);
    expect(writtenHosts(`${block}\n`)).toEqual([{ id: 'vm-7', hosts }]);
  });

  it('reads a Host line with a long run of spaces before an alias in linear time', () => {
    const line = `Host a${' '.repeat(100_000)}b${' \t'.repeat(50_000)}`;
    const block = computerBlock('dev', 'vm-7').replace('Host dev', line);
    const started = performance.now();
    expect(writtenHosts(`${block}\n`)).toEqual([{ id: 'vm-7', hosts: ['a', 'b'] }]);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('reads the aliases of every Host line in a block', () => {
    const block = computerBlock('dev', 'vm-7').replace('Host dev', 'Host dev\nHost other box');
    expect(writtenHosts(block)).toEqual([{ id: 'vm-7', hosts: ['dev', 'other', 'box'] }]);
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

  it('refuses before running ssh when every key is bound to another account (OPL-5653)', async () => {
    const elsewhere = { ...SSH_KEY, reach: 'another_account' };
    const r = await cli(['ssh', 'demo'], {
      respond: withSsh(SSH_ACCESS, [elsewhere, { ...elsewhere, id: 'sshk-2' }]),
    });
    expect(r.code).toBe(1);
    expect(r.out).toBe('');
    expect(r.err).toBe(
      "mandala: every SSH key you hold is bound to another account, so this account's computers refuse it; " +
        'run "mandala ssh --setup demo --key PATH" with a separate key, or re-add it from the dashboard\n',
    );
    expect(r.ran).toEqual([]);
    expect(writes(r)).toEqual([]);
    expect(fs.existsSync(knownHostsPath(r.home))).toBe(false);
  });

  it.each(['this_account', 'everywhere', null, 'some_new_word'])(
    'runs ssh when one key beside a refused one has reach %s (OPL-5653)',
    async (reach) => {
      const r = await cli(['ssh', 'demo'], {
        respond: withSsh(SSH_ACCESS, [
          { ...SSH_KEY, reach: 'another_account' },
          { ...SSH_KEY, id: 'sshk-2', reach },
        ]),
      });
      expect(r.code).toBe(0);
      expect(r.err).toBe('');
      expect(r.ran).toHaveLength(1);
    },
  );

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
      exit_code: 2,
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

  it('a Ctrl-C during the lookups cancels, and ssh never starts', async () => {
    const before = process.listenerCount('SIGINT');
    const r = await cli(['ssh', 'demo'], {
      respond: (call) => {
        if (call.path !== '/computers/vm-1/ssh') return anyRoute(call);
        process.emit('SIGINT');
        return new Promise<Response>(() => {});
      },
    });
    expect(r.code).toBe(130);
    expect(r.err).toBe('mandala: Cancelled\n');
    expect(r.ran).toEqual([]);
    expect(process.listenerCount('SIGINT')).toBe(before);
  });

  it('removes its own signal handlers before ssh runs', async () => {
    const before = process.listenerCount('SIGINT');
    let during = -1;
    const home = await tempDir();
    const rec = recorder(anyRoute);
    const code = await main(['ssh', 'vm-1'], {
      env: {},
      stdout: { write: (() => true) as NodeJS.WritableStream['write'] },
      stderr: { write: (() => true) as NodeJS.WritableStream['write'] },
      createClient: () => new Client({ apiKey: 'k', baseUrl: BASE, fetch: rec.fetch }),
      ssh: {
        home: () => home,
        windows: false,
        which: () => '/usr/bin/ssh',
        run: async () => {
          during = process.listenerCount('SIGINT');
          return 0;
        },
      },
    });
    expect(code).toBe(0);
    expect(during).toBe(before);
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
      ['GET', 'computers/vm-1/ssh'],
      ['GET', 'ssh-keys'],
      ['POST', 'ssh-keys'],
      ['PUT', 'computers/vm-1/ssh'],
    ]);
    expect(r.rec.calls[4]!.body).toEqual({ public_key: PUBLIC });
    expect(r.rec.calls[5]!.body).toEqual({ enabled: true });
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
        schema_version: 2,
        command: 'ssh',
        ok: true,
        exit_code: 0,
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

  it('refuses a listed key bound to another account, and switches nothing on (OPL-5617)', async () => {
    const home = await homeWithKey();
    const elsewhere = { ...SSH_KEY, reach: 'another_account' };
    const message =
      "key SHA256:09QlEDFrF+XXV/2u4X/pBAufS+8iaKwRzW6+EvIPVkg (laptop) is registered for another of your accounts, so this account's computers refuse it. To use it on every account, remove it and add it again from the dashboard (a computer's Settings, SSH tab); or use a separate key: mandala ssh --setup demo --key PATH";
    const human = await cli(['ssh', '--setup', 'demo'], {
      home,
      respond: withSsh(SSH_ACCESS, [elsewhere]),
    });
    expect(human.code).toBe(1);
    expect(human.out).toBe('');
    expect(human.err).toBe(`mandala: ${message}\n`);
    expect(writes(human)).toEqual([]);
    expect(fs.existsSync(knownHostsPath(home))).toBe(false);
    const asJson = await cli(['ssh', '--setup', 'demo', '--json'], {
      home,
      respond: withSsh(SSH_ACCESS, [elsewhere]),
    });
    expect(asJson.code).toBe(1);
    expect(JSON.parse(asJson.out)).toEqual({
      schema_version: 2,
      command: 'ssh',
      ok: false,
      error: { code: 'ssh_key_elsewhere', message },
      exit_code: 1,
    });
    expect(writes(asJson)).toEqual([]);
  });

  it('refuses a conflict that turns out to be its own key bound to another account (OPL-5617)', async () => {
    const home = await homeWithKey();
    let lists = 0;
    const r = await cli(['ssh', '--setup', 'demo', '--json'], {
      home,
      respond: (call) => {
        if (call.path === '/ssh-keys' && call.method === 'GET')
          return json(lists++ ? [{ ...SSH_KEY, reach: 'another_account' }] : []);
        if (call.path === '/ssh-keys')
          return json({ error: 'That key is already registered.' }, { status: 409 });
        return anyRoute(call);
      },
    });
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out).error.code).toBe('ssh_key_elsewhere');
    expect(writes(r)).toEqual([['POST', 'ssh-keys']]);
  });

  it.each(['everywhere', 'this_account', null])(
    'switches SSH on for a listed key whose reach is %s',
    async (reach) => {
      const home = await homeWithKey();
      const listed = reach === null ? { ...SSH_KEY, reach: undefined } : { ...SSH_KEY, reach };
      const r = await cli(['ssh', '--setup', 'demo'], {
        home,
        respond: withSsh(SSH_ACCESS, [listed]),
      });
      expect(r.code).toBe(0);
      expect(writes(r)).toEqual([['PUT', 'computers/vm-1/ssh']]);
      expect(r.out).toContain('(laptop) already registered\nSSH is on for demo\n');
    },
  );

  it('refuses a computer already known not to run SSH before uploading or switching anything', async () => {
    const home = await homeWithKey();
    for (const extra of [[], ['--json']]) {
      const r = await cli(['ssh', '--setup', 'demo', ...extra], {
        home,
        respond: withSsh({ ...SSH_ACCESS, available: false, enabled: false }, []),
      });
      expect(r.code).toBe(1);
      expect(writes(r)).toEqual([]);
      expect(r.rec.routes().at(-1)).toEqual(['GET', 'computers/vm-1/ssh']);
      const message =
        'demo was made from a template that predates SSH; create a new computer to use SSH';
      if (extra.length)
        expect(JSON.parse(r.out).error).toEqual({ code: 'ssh_unavailable', message });
      else {
        expect(r.out).toBe('');
        expect(r.err).toBe(`mandala: ${message}\n`);
      }
      expect(fs.existsSync(knownHostsPath(home))).toBe(false);
    }
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
        schema_version: 2,
        command: 'ssh',
        ok: false,
        error: { code, message },
        exit_code: 1,
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
      'ID                     TYPE         FINGERPRINT                                         LAST USED  REACH          NAME\n' +
        'sshk-a1b2c3d4e5f60718  ssh-ed25519  SHA256:09QlEDFrF+XXV/2u4X/pBAufS+8iaKwRzW6+EvIPVkg  never      every account  laptop\n',
    );
    expect(human.err).toBe('');
    const asJson = await cli(['ssh-key', 'list', '--json']);
    expect(JSON.parse(asJson.out).data).toEqual([SSH_KEY]);
    const none = await cli(['ssh-key', 'list'], { respond: withSsh(SSH_ACCESS, []) });
    expect(none.out).toBe('');
    expect(none.err).toBe('no SSH keys\n');
  });

  it("shows each key's reach, and what to do about one this account refuses (OPL-5653)", async () => {
    const keys = [
      SSH_KEY,
      { ...SSH_KEY, id: 'sshk-2', name: 'ci', reach: 'this_account' },
      { ...SSH_KEY, id: 'sshk-3', name: 'old\u001b[2Jbox', reach: 'another_account' },
      { ...SSH_KEY, id: 'sshk-4', name: 'legacy', reach: null },
    ];
    const human = await cli(['ssh-key', 'list'], { respond: withSsh(SSH_ACCESS, keys) });
    expect(human.code).toBe(0);
    expect(human.out).toBe(
      'ID                     TYPE         FINGERPRINT                                         LAST USED  REACH                           NAME\n' +
        'sshk-a1b2c3d4e5f60718  ssh-ed25519  SHA256:09QlEDFrF+XXV/2u4X/pBAufS+8iaKwRzW6+EvIPVkg  never      every account                   laptop\n' +
        'sshk-2                 ssh-ed25519  SHA256:09QlEDFrF+XXV/2u4X/pBAufS+8iaKwRzW6+EvIPVkg  never      this account                    ci\n' +
        'sshk-3                 ssh-ed25519  SHA256:09QlEDFrF+XXV/2u4X/pBAufS+8iaKwRzW6+EvIPVkg  never      another account (refused here)  old\\u001b[2Jbox\n' +
        'sshk-4                 ssh-ed25519  SHA256:09QlEDFrF+XXV/2u4X/pBAufS+8iaKwRzW6+EvIPVkg  never      -                               legacy\n',
    );
    expect(human.err).toBe(
      "mandala: key SHA256:09QlEDFrF+XXV/2u4X/pBAufS+8iaKwRzW6+EvIPVkg (old\\u001b[2Jbox) is registered for another of your accounts, so this account's computers refuse it. To use it on every account, remove it and add it again from the dashboard (a computer's Settings, SSH tab); or use a separate key: mandala ssh --setup <computer> --key PATH\n",
    );
    const asJson = await cli(['ssh-key', 'list', '--json'], { respond: withSsh(SSH_ACCESS, keys) });
    expect(JSON.parse(asJson.out).data).toEqual(keys);
    expect(asJson.err).toBe('');
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

  it('names both causes of a 404 on removal, keeping its code and status (OPL-5653)', async () => {
    const respond = (call: Call) =>
      call.method === 'DELETE' && call.path === '/ssh-keys/sshk-2'
        ? json(
            { error: 'ssh key not found' },
            { status: 404, headers: { 'x-request-id': 'req-1' } },
          )
        : anyRoute(call);
    const message =
      'no SSH key sshk-2 that this API key can remove: a key added from the dashboard (reach every ' +
      'account) or bound to another account (reach another account) is removed from the dashboard; ' +
      "`ssh-key list` shows each key's reach";
    const human = await cli(['ssh-key', 'rm', 'sshk-2'], { respond });
    expect(human.code).toBe(1);
    expect(human.out).toBe('');
    expect(human.err).toBe(`mandala: ${message}\nmandala: request id req-1\n`);
    const asJson = await cli(['ssh-key', 'rm', 'sshk-2', '--json'], { respond });
    expect(asJson.code).toBe(1);
    expect(JSON.parse(asJson.out)).toEqual({
      schema_version: 2,
      command: 'ssh-key rm',
      ok: false,
      error: { code: 'not_found', message, status: 404, request_id: 'req-1' },
      exit_code: 1,
    });
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

  // OpenSSH matches `Host` patterns case-sensitively (`ssh -G dev` and
  // `ssh -G Dev` pick different blocks, in either order), so names that differ
  // only in case are two working aliases and each keeps its own.
  it.each([
    ['vm-1', 'dev'],
    ['vm-2', 'Dev'],
  ])('keeps %s under its own name %s when another name differs only in case', async (id, name) => {
    const respond = (call: Call) =>
      call.path === '/computers'
        ? json([
            { ...COMPUTER, name: 'dev' },
            { ...COMPUTER, id: 'vm-2', name: 'Dev' },
          ])
        : anyRoute(call);
    const r = await cli(['ssh-config', id], { respond });
    expect(r.code).toBe(0);
    expect(r.err).toBe('');
    expect(r.out).toContain(`# >>> mandala computer ${id} >>>\nHost ${name}\n  HostName ${id}\n`);
    const asJson = await cli(['ssh-config', id, '--json'], { respond });
    expect(JSON.parse(asJson.out).data.host).toBe(name);
  });
});

describe('ssh-config under a name ssh would read as another destination', () => {
  const named = (name: string) => (call: Call) =>
    call.path === '/computers'
      ? json([
          { ...COMPUTER, name },
          { ...COMPUTER, id: 'vm-2', name: 'other' },
        ])
      : anyRoute(call);

  it.each([
    'github.com',
    'GitHub.COM',
    'github.com.',
    'corp.internal',
    'foo.xn--p1ai',
    '10.0.0.5',
    '10.5',
    '0x0A.0.0.5',
    '167772165',
    '0x0A000005',
    '08.0.0.1',
    '192.168.1.09',
    '0x.1',
    'localhost',
    'LOCALHOST',
    'mandala-gateway',
    'vm-2',
    'VM-2',
  ])('writes %s under the computer id, and says so', async (name) => {
    const r = await cli(['ssh-config', 'vm-1'], { respond: named(name) });
    expect(r.code).toBe(0);
    expect(r.err).toBe(
      `mandala: the name ${name} cannot be a Host, since ssh would also use it for another destination; using Host vm-1 instead\n`,
    );
    // The computer's own block, not the gateway's (whose Host is mandala-gateway).
    expect(r.out).toContain('# >>> mandala computer vm-1 >>>\nHost vm-1\n  HostName vm-1\n');
    const asJson = await cli(['ssh-config', 'vm-1', '--json'], { respond: named(name) });
    const data = JSON.parse(asJson.out).data;
    expect(data.host).toBe('vm-1');
    expect(data.config).toContain('\nHost vm-1\n');
  });

  it.each(['demo', 'ubuntu-24.04', 'py3.12', 'web-1', '1.2.3.4.5'])(
    'keeps %s as the Host',
    async (name) => {
      const r = await cli(['ssh-config', 'vm-1', '--json'], { respond: named(name) });
      expect(r.code).toBe(0);
      expect(r.err).toBe('');
      expect(JSON.parse(r.out).data.host).toBe(name);
    },
  );

  it('replaces a block an earlier version wrote under the name', async () => {
    const home = await tempDir();
    const kh = knownHostsPath(home);
    const file = join(home, '.ssh', 'config');
    fs.mkdirSync(join(home, '.ssh'));
    const mine = 'Host work\n  User me\n';
    fs.writeFileSync(
      file,
      mergeConfig(mine, configSnippet('github.com', 'vm-1', gateway({}), kh, 'github.com')),
    );
    expect(fs.readFileSync(file, 'utf8')).toContain('\nHost github.com\n');
    const r = await cli(['ssh-config', 'vm-1', '--write'], {
      home,
      respond: named('github.com'),
    });
    expect(r.code).toBe(0);
    expect(r.out).toBe(`wrote Host vm-1 in ${file}\nconnect with: ssh vm-1\n`);
    const after = fs.readFileSync(file, 'utf8');
    expect(after).toContain('\nHost vm-1\n  HostName vm-1\n');
    expect(after).not.toContain('Host github.com');
    expect(after.startsWith(mine)).toBe(true);
    expect(after.match(/# >>> mandala computer vm-1 >>>/g)).toHaveLength(1);
  });

  it('says only that the names could not be checked when the listing is partial', async () => {
    const r = await cli(['ssh-config', 'vm-1'], {
      respond: (call) =>
        call.path === '/computers'
          ? json([{ ...COMPUTER, name: 'github.com' }], { headers: { 'X-GC-Incomplete': '1' } })
          : anyRoute(call),
    });
    expect(r.code).toBe(0);
    expect(r.err).toBe(
      "mandala: could not check other computers' names; using Host vm-1 instead\n",
    );
  });

  it('says only that the name is shared when another computer has it too', async () => {
    const r = await cli(['ssh-config', 'vm-1'], {
      respond: (call) =>
        call.path === '/computers'
          ? json([
              { ...COMPUTER, name: 'github.com' },
              { ...COMPUTER, id: 'vm-2', name: 'github.com' },
            ])
          : anyRoute(call),
    });
    expect(r.err).toBe(
      'mandala: another computer is also named github.com; using Host vm-1 instead\n',
    );
  });
});

describe('ssh-config under a name a block in ~/.ssh/config already uses', () => {
  const named = (name: string) => (call: Call) =>
    call.path === '/computers' ? json([{ ...COMPUTER, name }]) : anyRoute(call);
  /** A home whose ssh config holds a block for vm-other, a computer the listing lacks. */
  const homeWith = async (host: string, id = 'vm-other') => {
    const home = await tempDir();
    fs.mkdirSync(join(home, '.ssh'));
    const file = join(home, '.ssh', 'config');
    const kh = knownHostsPath(home);
    fs.writeFileSync(
      file,
      mergeConfig('Host work\n  User me\n', configSnippet(host, id, gateway({}), kh, host)),
    );
    return { home, file };
  };

  it.each([
    ['dev', 'dev'],
    ['DEV', 'dev'],
    ['dev', 'Dev'],
    ['vm-other', 'dev'],
    ['VM-Other', 'dev'],
  ])('writes %s under the computer id when another block uses Host %s', async (name, written) => {
    const { home, file } = await homeWith(written);
    const before = fs.readFileSync(file, 'utf8');
    const note = `mandala: a block in ~/.ssh/config already uses the name ${name} for another computer; using Host vm-1 instead\n`;
    const printed = await cli(['ssh-config', 'vm-1'], { home, respond: named(name) });
    expect(printed.code).toBe(0);
    expect(printed.err).toBe(note);
    expect(printed.out).toContain('# >>> mandala computer vm-1 >>>\nHost vm-1\n  HostName vm-1\n');
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    const asJson = await cli(['ssh-config', 'vm-1', '--json'], { home, respond: named(name) });
    expect(asJson.err).toBe(note);
    const data = JSON.parse(asJson.out).data;
    expect(data.host).toBe('vm-1');
    expect(data.config).toContain('\nHost vm-1\n');
    const wrote = await cli(['ssh-config', 'vm-1', '--write'], { home, respond: named(name) });
    expect(wrote.err).toBe(note);
    expect(wrote.out).toBe(`wrote Host vm-1 in ${file}\nconnect with: ssh vm-1\n`);
    expect(writtenHosts(fs.readFileSync(file, 'utf8'))).toEqual([
      { id: 'vm-other', hosts: [written] },
      { id: 'vm-1', hosts: ['vm-1'] },
    ]);
  });

  it("keeps the name when the block under it is the computer's own", async () => {
    const { home, file } = await homeWith('dev', 'vm-1');
    const before = fs.readFileSync(file, 'utf8');
    const r = await cli(['ssh-config', 'vm-1', '--write'], { home, respond: named('dev') });
    expect(r.code).toBe(0);
    expect(r.err).toBe('');
    expect(r.out).toBe(`already up to date: Host dev in ${file}\nconnect with: ssh dev\n`);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('keeps the name when no block uses it, or there is no config to read', async () => {
    const { home } = await homeWith('other');
    const r = await cli(['ssh-config', 'vm-1', '--json'], { home, respond: named('dev') });
    expect(r.err).toBe('');
    expect(JSON.parse(r.out).data.host).toBe('dev');
    const bare = await cli(['ssh-config', 'vm-1', '--json'], { respond: named('dev') });
    expect(bare.err).toBe('');
    expect(JSON.parse(bare.out).data.host).toBe('dev');
    const unreadable = await tempDir();
    fs.mkdirSync(join(unreadable, '.ssh', 'config'), { recursive: true });
    const r2 = await cli(['ssh-config', 'vm-1', '--json'], {
      home: unreadable,
      respond: named('dev'),
    });
    expect(r2.code).toBe(0);
    expect(r2.err).toBe('');
    expect(JSON.parse(r2.out).data.host).toBe('dev');
  });

  describe('when another block already has the id as its Host', () => {
    const refusal =
      'a block in ~/.ssh/config for computer vm-other already uses Host vm-1; remove that block, then run again';
    /** Every mode refuses: nothing printed, nothing written, the file as it was. */
    const refusesEveryMode = async (
      home: string,
      file: string,
      respond: Responder,
      hosts: unknown[] = [expect.stringMatching(/^vm-1$/i)],
    ) => {
      const before = fs.readFileSync(file, 'utf8');
      for (const mode of [[], ['--write']]) {
        const r = await cli(['ssh-config', 'vm-1', ...mode], { home, respond });
        expect(r.code).toBe(1);
        expect(r.out).toBe('');
        expect(r.err).toBe(`mandala: ${refusal}\n`);
        expect(fs.readFileSync(file, 'utf8')).toBe(before);
      }
      const asJson = await cli(['ssh-config', 'vm-1', '--json'], { home, respond });
      expect(asJson.code).toBe(1);
      const parsed = JSON.parse(asJson.out || asJson.err);
      expect(parsed.data).toBeUndefined();
      expect(parsed.error).toMatchObject({ code: 'conflict', message: refusal });
      expect(fs.readFileSync(file, 'utf8')).toBe(before);
      expect(writtenHosts(fs.readFileSync(file, 'utf8'))).toEqual([{ id: 'vm-other', hosts }]);
      expect(fs.existsSync(knownHostsPath(home))).toBe(false);
    };

    // The shape where the two computers are named after each other's ids
    // (vm-other is named vm-1, this computer vm-1 is named vm-other) is
    // refused only while its block holds more than the one alias the CLI
    // writes, or its id is another block's Host too: --write moves it to its
    // id otherwise (see the describe below).
    it.each([
      ['a second alias', 'vm-1 spare', ['vm-1', 'spare']],
      ['a second Host line', 'vm-1\nHost spare', ['vm-1', 'spare']],
      ['a comment and a second alias', 'VM-1 spare # mine', ['VM-1', 'spare']],
    ])('refuses when the block named after this id has %s', async (_, written, hosts) => {
      const { home, file } = await homeWith(written);
      await refusesEveryMode(home, file, named('vm-other'), hosts);
    });

    it('refuses when the block named after this id has its own id taken as a Host', async () => {
      const { home, file } = await homeWith('vm-1');
      fs.appendFileSync(
        file,
        `\n${configSnippet('vm-other', 'vm-3', gateway({}), knownHostsPath(home), 'x vm-other')}`,
      );
      const before = fs.readFileSync(file, 'utf8');
      for (const mode of [[], ['--write'], ['--json'], ['--write', '--json']]) {
        const r = await cli(['ssh-config', 'vm-1', ...mode], { home, respond: named('vm-other') });
        expect(r.code).toBe(1);
        expect(r.out + r.err).toContain(refusal);
        expect(fs.readFileSync(file, 'utf8')).toBe(before);
      }
    });

    it('refuses when the block named after this id has an id that cannot be a Host', async () => {
      // A hand-edited marker: the id the block would move to is two words.
      const { home, file } = await homeWith('vm-1', 'vm other');
      const before = fs.readFileSync(file, 'utf8');
      const r = await cli(['ssh-config', 'vm-1', '--write'], { home, respond: named('vm other') });
      expect(r.code).toBe(1);
      expect(r.err).toBe(
        'mandala: a block in ~/.ssh/config for computer vm other already uses Host vm-1; remove that block, then run again\n',
      );
      expect(fs.readFileSync(file, 'utf8')).toBe(before);
    });

    it('refuses when two blocks hold the id', async () => {
      const { home, file } = await homeWith('vm-1');
      fs.appendFileSync(
        file,
        `\n${configSnippet('x', 'vm-3', gateway({}), knownHostsPath(home), 'vm-1')}`,
      );
      const before = fs.readFileSync(file, 'utf8');
      for (const mode of [['--write'], ['--write', '--json']]) {
        const r = await cli(['ssh-config', 'vm-1', ...mode], { home, respond: named('vm-other') });
        expect(r.code).toBe(1);
        expect(r.out + r.err).toContain(refusal);
        expect(fs.readFileSync(file, 'utf8')).toBe(before);
      }
    });

    it.each([
      ['the listing is partial', () => json([COMPUTER], { headers: { 'X-GC-Incomplete': '1' } })],
      ['the name cannot be a Host', () => json([{ ...COMPUTER, name: 'my box' }])],
      [
        'the name is shared',
        () =>
          json([
            { ...COMPUTER, name: 'dev' },
            { ...COMPUTER, id: 'vm-2', name: 'dev' },
          ]),
      ],
      [
        'ssh would read the name as another destination',
        () => json([{ ...COMPUTER, name: 'github.com' }]),
      ],
    ])('refuses when the id is the Host because %s', async (_, listing) => {
      const { home, file } = await homeWith('vm-1');
      await refusesEveryMode(home, file, (call) =>
        call.path === '/computers' ? listing() : anyRoute(call),
      );
    });
  });
});

describe("ssh-config for two computers named after each other's ids", () => {
  // vm-1 is named vm-other and vm-other is named vm-1, in two accounts, so
  // neither listing shows the other. Whichever is written second falls back
  // to its id, which the first block holds; ids for both is the one state
  // in which neither refuses (OPL-5421).
  const as = (id: string, name: string) => (call: Call) => {
    const c = { ...COMPUTER, id, name };
    if (call.path === '/computers') return json([c]);
    if (call.path === `/computers/${id}`) return json(c);
    return anyRoute(call);
  };
  const A = { id: 'vm-1', respond: as('vm-1', 'vm-other') };
  const B = { id: 'vm-other', respond: as('vm-other', 'vm-1') };
  const run = (who: typeof A, home: string, ...mode: string[]) =>
    cli(['ssh-config', who.id, ...mode], { home, respond: who.respond });
  const blockOf = (text: string, id: string) =>
    text.slice(
      text.indexOf(`# >>> mandala computer ${id} >>>`),
      text.indexOf(`# <<< mandala computer ${id} <<<`),
    );

  it.each([
    ['vm-1 first', A, B],
    ['vm-other first', B, A],
  ])('moves both to their ids on --write, %s', async (_, first, second) => {
    const home = await tempDir();
    fs.mkdirSync(join(home, '.ssh'));
    const file = join(home, '.ssh', 'config');
    fs.writeFileSync(file, 'Host work\n  User me\n');
    const firstRun = await run(first, home, '--write');
    expect(firstRun.code).toBe(0);
    // The first is written under its name, which is the second's id.
    expect(writtenHosts(fs.readFileSync(file, 'utf8'))).toEqual([
      { id: first.id, hosts: [second.id] },
    ]);
    const before = fs.readFileSync(file, 'utf8');
    const refusal = `a block in ~/.ssh/config for computer ${first.id} already uses Host ${second.id}, and the two computers are named after each other's ids; run this command with --write to move both to their ids (Host ${first.id} and Host ${second.id})`;
    const printed = await run(second, home);
    expect(printed.code).toBe(1);
    expect(printed.out).toBe('');
    expect(printed.err).toBe(`mandala: ${refusal}\n`);
    const asJson = await run(second, home, '--json');
    expect(asJson.code).toBe(1);
    const parsed = JSON.parse(asJson.out || asJson.err);
    expect(parsed.data).toBeUndefined();
    expect(parsed.error).toMatchObject({ code: 'conflict', message: refusal });
    expect(fs.readFileSync(file, 'utf8')).toBe(before);

    const wrote = await run(second, home, '--write', '--json');
    expect(wrote.code).toBe(0);
    expect(wrote.err).toBe(
      `mandala: a block in ~/.ssh/config already uses the name ${first.id} for another computer; using Host ${second.id} instead\n` +
        `mandala: computer ${first.id} is named after this computer's id; moved its block to Host ${first.id} as well\n`,
    );
    const data = JSON.parse(wrote.out).data;
    expect(data).toMatchObject({ host: second.id, changed: true, path: file });
    // The printed config is this computer's alone.
    expect(data.config).not.toContain(`mandala computer ${first.id}`);
    const after = fs.readFileSync(file, 'utf8');
    expect(writtenHosts(after)).toEqual([
      { id: first.id, hosts: [first.id] },
      { id: second.id, hosts: [second.id] },
    ]);
    // Only the moved block's Host line changed, where it stands.
    expect(blockOf(after, first.id)).toBe(
      blockOf(before, first.id).replace(`\nHost ${second.id}\n`, `\nHost ${first.id}\n`),
    );
    expect(after.startsWith(before.slice(0, before.indexOf('# >>> mandala computer')))).toBe(true);
    expect(after.match(/# >>> mandala computer/g)).toHaveLength(2);

    // Neither refuses from here on, in either order, in any mode.
    for (const who of [second, first, second]) {
      const again = await run(who, home, '--write');
      expect(again.code).toBe(0);
      expect(again.out).toBe(
        `already up to date: Host ${who.id} in ${file}\nconnect with: ssh ${who.id}\n`,
      );
      expect((await run(who, home)).code).toBe(0);
      expect((await run(who, home, '--json')).code).toBe(0);
    }
    expect(fs.readFileSync(file, 'utf8')).toBe(after);
  });
});

describe('ssh-config over a config with CRLF line endings', () => {
  const named = (name: string) => (call: Call) =>
    call.path === '/computers' ? json([{ ...COMPUTER, name }]) : anyRoute(call);
  const crlfHome = async (host: string, id: string) => {
    const home = await tempDir();
    fs.mkdirSync(join(home, '.ssh'));
    const file = join(home, '.ssh', 'config');
    const text = mergeConfig(
      'Host work\n  User me\n',
      configSnippet(host, id, gateway({}), knownHostsPath(home), host),
    );
    fs.writeFileSync(file, text.replace(/\n/g, '\r\n'));
    return { home, file };
  };

  it("falls back to the id when another computer's block uses the name", async () => {
    const { home, file } = await crlfHome('dev', 'vm-other');
    const before = fs.readFileSync(file, 'utf8');
    const r = await cli(['ssh-config', 'vm-1', '--json'], { home, respond: named('dev') });
    expect(r.code).toBe(0);
    expect(r.err).toBe(
      'mandala: a block in ~/.ssh/config already uses the name dev for another computer; using Host vm-1 instead\n',
    );
    expect(JSON.parse(r.out).data.host).toBe('vm-1');
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it("refuses when another computer's block holds the id", async () => {
    const { home, file } = await crlfHome('vm-1', 'vm-other');
    const before = fs.readFileSync(file, 'utf8');
    for (const mode of [[], ['--write'], ['--json']]) {
      const r = await cli(['ssh-config', 'vm-1', ...mode], { home, respond: named('my box') });
      expect(r.code).toBe(1);
      expect(r.out + r.err).toContain(
        'a block in ~/.ssh/config for computer vm-other already uses Host vm-1; remove that block, then run again',
      );
      expect(fs.readFileSync(file, 'utf8')).toBe(before);
    }
  });

  it('replaces its own block in place on --write, and writes LF line endings', async () => {
    const { home, file } = await crlfHome('old', 'vm-1');
    const unchanged = await crlfHome('dev', 'vm-1');
    const same = await cli(['ssh-config', 'vm-1', '--write'], {
      home: unchanged.home,
      respond: named('dev'),
    });
    expect(same.code).toBe(0);
    expect(same.out).toBe(
      `already up to date: Host dev in ${unchanged.file}\nconnect with: ssh dev\n`,
    );
    // An unchanged file is not rewritten, so it keeps its CRLF endings.
    expect(fs.readFileSync(unchanged.file, 'utf8')).toContain('\r\nHost dev\r\n');
    const r = await cli(['ssh-config', 'vm-1', '--write'], { home, respond: named('dev') });
    expect(r.code).toBe(0);
    expect(r.out).toBe(`wrote Host dev in ${file}\nconnect with: ssh dev\n`);
    const after = fs.readFileSync(file, 'utf8');
    expect(after).not.toContain('\r');
    expect(after.match(/# >>> mandala computer vm-1 >>>/g)).toHaveLength(1);
    expect(after.match(/# >>> mandala gateway >>>/g)).toHaveLength(1);
    expect(after.startsWith('Host work\n  User me\n')).toBe(true);
    expect(writtenHosts(after)).toEqual([{ id: 'vm-1', hosts: ['dev'] }]);
  });
});

describe('ssh-config over a config holding a duplicate block', () => {
  const named = (name: string) => (call: Call) =>
    call.path === '/computers' ? json([{ ...COMPUTER, name }]) : anyRoute(call);
  const WORK = 'Host work\n  User me\n';
  /** The gateway block and the computer block of a snippet, markers included. */
  const blocksOf = (snippet: string) => {
    const gap = snippet.indexOf('\n\n');
    return [snippet.slice(0, gap), snippet.slice(gap + 2, -1)] as const;
  };
  // Before CRLF line endings were read as `\n`, --write found no block in a
  // CRLF config and appended an LF copy of both after the originals.
  const homeWithCopy = async (first: string) => {
    const home = await tempDir();
    fs.mkdirSync(join(home, '.ssh'));
    const file = join(home, '.ssh', 'config');
    const kh = knownHostsPath(home);
    const original = mergeConfig(
      WORK,
      configSnippet(first, 'vm-1', gateway({}), kh, first),
    ).replace(/\n/g, '\r\n');
    const [gw, vm1] = blocksOf(configSnippet('stale', 'vm-1', gateway({}), kh, 'stale'));
    fs.writeFileSync(file, `${original}\n${gw}\n\n${vm1}\n`);
    return { home, file, kh };
  };

  it.each([
    ['an old Host', 'old'],
    ['the current Host', 'dev'],
  ])('removes the later copy when the first has %s', async (_, first) => {
    const { home, file, kh } = await homeWithCopy(first);
    const before = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    expect(writtenHosts(before).map((b) => b.id)).toEqual(['vm-1', 'vm-1']);
    const r = await cli(['ssh-config', 'vm-1', '--write'], { home, respond: named('dev') });
    expect(r.code).toBe(0);
    expect(r.out).toBe(`wrote Host dev in ${file}\nconnect with: ssh dev\n`);
    const after = fs.readFileSync(file, 'utf8');
    expect(after.match(/# >>> mandala computer vm-1 >>>/g)).toHaveLength(1);
    expect(after.match(/# >>> mandala gateway >>>/g)).toHaveLength(1);
    expect(after).not.toContain('stale');
    expect(after).not.toContain('\r');
    expect(writtenHosts(after)).toEqual([{ id: 'vm-1', hosts: ['dev'] }]);
    expect(after).toBe(mergeConfig(WORK, configSnippet('dev', 'vm-1', gateway({}), kh, 'dev')));
    const again = await cli(['ssh-config', 'vm-1', '--write'], { home, respond: named('dev') });
    expect(again.code).toBe(0);
    expect(again.out).toBe(`already up to date: Host dev in ${file}\nconnect with: ssh dev\n`);
    expect(fs.readFileSync(file, 'utf8')).toBe(after);
  });

  it("removes only the snippet's own copies, keeping every other line where it stands", () => {
    const snippet = (host: string, id: string) => configSnippet(host, id, gateway({}), KH, host);
    const [gw, vm1] = blocksOf(snippet('old', 'vm-1'));
    const [gwCopy, vm1Copy] = blocksOf(snippet('stale', 'vm-1'));
    const [, vm2] = blocksOf(snippet('a', 'vm-2'));
    const [, vm2Copy] = blocksOf(snippet('b', 'vm-2'));
    const text =
      `# before\n\n${gw}\n\n${vm1}\n# middle\n\n${gwCopy}\n\n${vm1Copy}\n\n` +
      `${vm2}\n\n${vm2Copy}\n# after\n`;
    const [newGw, newVm1] = blocksOf(snippet('dev', 'vm-1'));
    expect(mergeConfig(text, snippet('dev', 'vm-1'))).toBe(
      `# before\n\n${newGw}\n\n${newVm1}\n# middle\n\n${vm2}\n\n${vm2Copy}\n# after\n`,
    );
  });

  // OpenSSH ends a stanza at the next Host or Match line, not at a comment, so
  // a directive after a copy's end marker belongs to the copy's last Host.
  const copyFollowedBy = (tail: string) => {
    const snippet = (host: string) => configSnippet(host, 'vm-1', gateway({}), KH, host);
    return (
      `${mergeConfig('Host work\n  User me\n', snippet('dev'))}\n` +
      `Host *\n  ServerAliveInterval 30\n\n${snippet('stale')}${tail}`
    );
  };

  it('keeps a copy whose stanza goes on past its end marker, with what follows it', () => {
    const snippet = configSnippet('dev', 'vm-1', gateway({}), KH, 'dev');
    const [, staleVm1] = blocksOf(configSnippet('stale', 'vm-1', gateway({}), KH, 'stale'));
    const text = copyFollowedBy('ForwardAgent yes\n');
    const merged = mergeConfig(text, snippet);
    expect(merged).toBe(
      `${mergeConfig('Host work\n  User me\n', snippet)}\n` +
        `Host *\n  ServerAliveInterval 30\n\n${staleVm1}\nForwardAgent yes\n`,
    );
    expect(merged).not.toMatch(/ServerAliveInterval 30\n+ForwardAgent/);
    expect(mergeConfig(merged, snippet)).toBe(merged);
  });

  it.each([
    ['nothing', ''],
    ['blank and comment lines', '\n  \t\n# a note\n   # another\n'],
    ['blank lines and then a Host line', '\n# mine\nHost other\n  ForwardAgent yes\n'],
    ['a Match line', 'Match host other\n  ForwardAgent yes\n'],
  ])('still removes a copy followed by %s', (_, tail) => {
    const snippet = configSnippet('dev', 'vm-1', gateway({}), KH, 'dev');
    expect(mergeConfig(copyFollowedBy(tail), snippet)).toBe(
      `${mergeConfig('Host work\n  User me\n', snippet)}\n` +
        `Host *\n  ServerAliveInterval 30\n${tail}`,
    );
  });

  // A begin marker whose end marker is gone runs on to a later copy's end
  // marker, which OpenSSH does not care about but writtenHosts reads as the
  // orphan's own: removing that copy would hide the orphan's aliases from the
  // name-clash checks. The removal stops at the orphan.
  it('keeps a copy that lost its end marker, and everything after it', () => {
    const snippet = (host: string, id: string) => configSnippet(host, id, gateway({}), KH, host);
    const [gw, vm1] = blocksOf(snippet('old', 'vm-1'));
    const [, brokenFull] = blocksOf(snippet('broken', 'vm-1'));
    const broken = brokenFull.slice(0, brokenFull.lastIndexOf('\n'));
    expect(broken).not.toContain('<<<');
    const [, vm2] = blocksOf(snippet('a', 'vm-2'));
    const [, later] = blocksOf(snippet('later', 'vm-1'));
    const tail = `${broken}\n\n${vm2}\n\nHost mine\n  User x\n\n${later}\n`;
    const text = `${WORK}\n${gw}\n\n${vm1}\n\n${tail}`;
    const [newGw, newVm1] = blocksOf(snippet('dev', 'vm-1'));
    const merged = mergeConfig(text, snippet('dev', 'vm-1'));
    expect(merged).toBe(`${WORK}\n${newGw}\n\n${newVm1}\n\n${tail}`);
    expect(mergeConfig(merged, snippet('dev', 'vm-1'))).toBe(merged);
  });

  it('removes a whole copy before a copy that lost its end marker', () => {
    const snippet = (host: string) => configSnippet(host, 'vm-1', gateway({}), KH, host);
    const [gw, vm1] = blocksOf(snippet('old'));
    const [, stale] = blocksOf(snippet('stale'));
    const [, brokenFull] = blocksOf(snippet('broken'));
    const broken = brokenFull.slice(0, brokenFull.lastIndexOf('\n'));
    const [, later] = blocksOf(snippet('later'));
    const tail = `${broken}\n\n${later}\n`;
    const text = `${WORK}\n${gw}\n\n${vm1}\n\n${stale}\n\n${tail}`;
    const [newGw, newVm1] = blocksOf(snippet('dev'));
    expect(mergeConfig(text, snippet('dev'))).toBe(`${WORK}\n${newGw}\n\n${newVm1}\n\n${tail}`);
  });

  it('keeps a hand-written stanza after a stray gateway begin marker', () => {
    const snippet = (host: string) => configSnippet(host, 'vm-1', gateway({}), KH, host);
    const prod = 'Host prod\n  ProxyJump bastion\n  StrictHostKeyChecking yes\n';
    const stray = `\n# >>> mandala gateway >>>\n# half\n\n${prod}`;
    const [staleGw] = blocksOf(snippet('stale'));
    const text = `${mergeConfig(WORK, snippet('old'))}${stray}\n${snippet('stale')}`;
    const merged = mergeConfig(text, snippet('dev'));
    // The stray marker borrows the stale gateway copy's end marker, so that
    // copy stays; the stale computer copy after it goes.
    expect(merged).toBe(`${mergeConfig(WORK, snippet('dev'))}${stray}\n${staleGw}\n`);
    expect(merged).not.toContain('stale');
    expect(mergeConfig(merged, snippet('dev'))).toBe(merged);
  });

  // The regression round 2 of this change made: the orphan below borrows the
  // stale copy's end marker, and removing that copy dropped `dev` from
  // writtenHosts while OpenSSH still routed `ssh dev` to vm-1.
  describe('with a copy that lost its end marker before a whole copy', () => {
    const as = (id: string, name: string) => (call: Call) => {
      const c = { ...COMPUTER, id, name };
      if (call.path === '/computers') return json([c]);
      if (call.path === `/computers/${id}`) return json(c);
      return anyRoute(call);
    };
    const orphanHome = async () => {
      const home = await tempDir();
      fs.mkdirSync(join(home, '.ssh'));
      const file = join(home, '.ssh', 'config');
      const kh = knownHostsPath(home);
      const snippet = (host: string) => configSnippet(host, 'vm-1', gateway({}), kh, host);
      const [, devFull] = blocksOf(snippet('dev'));
      const orphan = devFull.slice(0, devFull.lastIndexOf('\n'));
      const [, stale] = blocksOf(snippet('stale'));
      fs.writeFileSync(file, `${mergeConfig(WORK, snippet('a'))}\n${orphan}\n\n${stale}\n`);
      return { home, file, snippet };
    };

    it("keeps the orphan's aliases in writtenHosts", async () => {
      const { file, snippet } = await orphanHome();
      const before = fs.readFileSync(file, 'utf8');
      const hosts = [
        { id: 'vm-1', hosts: ['a'] },
        { id: 'vm-1', hosts: ['dev', 'stale'] },
        { id: 'vm-1', hosts: ['stale'] },
      ];
      expect(writtenHosts(before)).toEqual(hosts);
      const merged = mergeConfig(before, snippet('a'));
      expect(merged).toBe(before);
      expect(writtenHosts(merged)).toEqual(hosts);
    });

    it("does not give the orphan's alias to another computer", async () => {
      const { home, file } = await orphanHome();
      const before = fs.readFileSync(file, 'utf8');
      const first = await cli(['ssh-config', 'vm-1', '--write'], {
        home,
        respond: as('vm-1', 'a'),
      });
      expect(first.code).toBe(0);
      expect(first.out).toBe(`already up to date: Host a in ${file}\nconnect with: ssh a\n`);
      expect(fs.readFileSync(file, 'utf8')).toBe(before);
      const second = await cli(['ssh-config', 'vm-2', '--write'], {
        home,
        respond: as('vm-2', 'dev'),
      });
      expect(second.code).toBe(0);
      expect(second.err).toBe(
        'mandala: a block in ~/.ssh/config already uses the name dev for another computer; using Host vm-2 instead\n',
      );
      expect(second.out).toBe(`wrote Host vm-2 in ${file}\nconnect with: ssh vm-2\n`);
      const after = writtenHosts(fs.readFileSync(file, 'utf8'));
      expect(after.filter((b) => b.hosts.includes('dev')).map((b) => b.id)).toEqual(['vm-1']);
      expect(after.at(-1)).toEqual({ id: 'vm-2', hosts: ['vm-2'] });
    });
  });
});

describe('ssh-config over a config that is not UTF-8', () => {
  const named = (name: string) => (call: Call) =>
    call.path === '/computers' ? json([{ ...COMPUTER, name }]) : anyRoute(call);
  /** `# café` in Latin-1: 0xE9 is not valid UTF-8 on its own. */
  const LATIN1 = Buffer.concat([Buffer.from('# caf'), Buffer.from([0xe9]), Buffer.from('\n')]);
  const homeWith = async (rest: string) => {
    const home = await tempDir();
    fs.mkdirSync(join(home, '.ssh'));
    const file = join(home, '.ssh', 'config');
    const bytes = Buffer.concat([LATIN1, Buffer.from(rest)]);
    fs.writeFileSync(file, bytes);
    return { home, file, bytes };
  };

  it.each([
    ['no block', () => 'Host work\n  User me\n'],
    [
      'a block under another Host',
      () => mergeConfig('', configSnippet('old', 'vm-1', gateway({}), KH, 'old')),
    ],
  ])('refuses --write and leaves the file byte for byte, over %s', async (_, rest) => {
    const { home, file, bytes } = await homeWith(rest());
    const refusal = `${file} holds a byte that is not valid UTF-8; fix that byte, then run again`;
    const r = await cli(['ssh-config', 'vm-1', '--write'], { home, respond: named('dev') });
    expect(r.code).toBe(1);
    expect(r.out).toBe('');
    expect(r.err).toBe(`mandala: ${refusal}\n`);
    const asJson = await cli(['ssh-config', 'vm-1', '--write', '--json'], {
      home,
      respond: named('dev'),
    });
    expect(asJson.code).toBe(1);
    expect(JSON.parse(asJson.out || asJson.err).error).toMatchObject({
      code: 'invalid_arguments',
      message: refusal,
    });
    expect(fs.readFileSync(file).equals(bytes)).toBe(true);
    // A refused --write has no other effect either.
    expect(fs.existsSync(knownHostsPath(home))).toBe(false);
    const printed = await cli(['ssh-config', 'vm-1'], { home, respond: named('dev') });
    expect(printed.code).toBe(0);
    expect(printed.out).toBe(
      configSnippet('dev', 'vm-1', gateway({}), knownHostsPath(home), 'dev'),
    );
    expect(fs.readFileSync(file).equals(bytes)).toBe(true);
  });

  it('writeConfig refuses it with invalid_arguments, even when nothing would change', async () => {
    const snippet = configSnippet('dev', 'vm-1', gateway({}), KH, 'dev');
    for (const rest of ['Host work\n', snippet]) {
      const { file, bytes } = await homeWith(rest);
      let thrown: unknown;
      try {
        writeConfig(file, snippet);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(CliError);
      expect((thrown as CliError).code).toBe('invalid_arguments');
      expect(fs.readFileSync(file).equals(bytes)).toBe(true);
    }
  });

  it("still sees another computer's block under the name", async () => {
    const { home, file, bytes } = await homeWith(
      mergeConfig('', configSnippet('dev', 'vm-other', gateway({}), KH, 'dev')),
    );
    const r = await cli(['ssh-config', 'vm-1'], { home, respond: named('dev') });
    expect(r.code).toBe(0);
    expect(r.err).toBe(
      'mandala: a block in ~/.ssh/config already uses the name dev for another computer; using Host vm-1 instead\n',
    );
    expect(r.out).toContain('\nHost vm-1\n');
    expect(fs.readFileSync(file).equals(bytes)).toBe(true);
  });

  it("refuses the move for two computers named after each other's ids", async () => {
    const as = (id: string, name: string) => (call: Call) => {
      const c = { ...COMPUTER, id, name };
      if (call.path === '/computers') return json([c]);
      if (call.path === `/computers/${id}`) return json(c);
      return anyRoute(call);
    };
    const home = await tempDir();
    fs.mkdirSync(join(home, '.ssh'));
    const file = join(home, '.ssh', 'config');
    fs.writeFileSync(file, 'Host work\n  User me\n');
    const first = await cli(['ssh-config', 'vm-1', '--write'], {
      home,
      respond: as('vm-1', 'vm-other'),
    });
    expect(first.code).toBe(0);
    const bytes = Buffer.concat([LATIN1, fs.readFileSync(file)]);
    fs.writeFileSync(file, bytes);
    const refusal =
      'a block in ~/.ssh/config for computer vm-1 already uses Host vm-other, and ~/.ssh/config holds a byte that is not valid UTF-8; fix that byte, then run again';
    for (const mode of [[], ['--write']]) {
      const r = await cli(['ssh-config', 'vm-other', ...mode], {
        home,
        respond: as('vm-other', 'vm-1'),
      });
      expect(r.code).toBe(1);
      expect(r.out).toBe('');
      expect(r.err).toBe(`mandala: ${refusal}\n`);
    }
    const asJson = await cli(['ssh-config', 'vm-other', '--write', '--json'], {
      home,
      respond: as('vm-other', 'vm-1'),
    });
    expect(asJson.code).toBe(1);
    expect(JSON.parse(asJson.out || asJson.err).error).toMatchObject({
      code: 'conflict',
      message: refusal,
    });
    expect(fs.readFileSync(file).equals(bytes)).toBe(true);
  });

  it('keeps a byte order mark on --write', async () => {
    const home = await tempDir();
    fs.mkdirSync(join(home, '.ssh'));
    const file = join(home, '.ssh', 'config');
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    fs.writeFileSync(file, Buffer.concat([bom, Buffer.from('Host work\n  User me\n')]));
    const r = await cli(['ssh-config', 'vm-1', '--write'], { home, respond: named('dev') });
    expect(r.code).toBe(0);
    const after = fs.readFileSync(file);
    expect(after.subarray(0, 3).equals(bom)).toBe(true);
    expect(after.subarray(3).toString('utf8')).toBe(
      mergeConfig(
        'Host work\n  User me\n',
        configSnippet('dev', 'vm-1', gateway({}), knownHostsPath(home), 'dev'),
      ),
    );
  });
});

describe('ssh-config against a hand-edited block', () => {
  const named = (name: string) => (call: Call) =>
    call.path === '/computers' ? json([{ ...COMPUTER, name }]) : anyRoute(call);
  const homeWith = async (hostLine: string) => {
    const home = await tempDir();
    fs.mkdirSync(join(home, '.ssh'));
    const file = join(home, '.ssh', 'config');
    const text = mergeConfig(
      '',
      configSnippet('x', 'vm-other', gateway({}), knownHostsPath(home), 'x'),
    ).replace('\nHost x\n', `\n${hostLine}\n`);
    fs.writeFileSync(file, text);
    return { home, file };
  };

  it.each([
    'Host dev # mine',
    'Host other dev',
    '  host=DEV',
    'Host "dev"',
    'Host x\nHost dev',
    "Host 'dev'",
    'Host other\u00a0# dev',
  ])('falls back to the id when %j names dev', async (line) => {
    const { home } = await homeWith(line);
    const r = await cli(['ssh-config', 'vm-1', '--json'], { home, respond: named('dev') });
    expect(r.code).toBe(0);
    expect(r.err).toBe(
      'mandala: a block in ~/.ssh/config already uses the name dev for another computer; using Host vm-1 instead\n',
    );
    expect(JSON.parse(r.out).data.host).toBe('vm-1');
  });

  it.each([
    'Host vm-1 extra',
    'Host extra VM-1 # mine',
    'Host=vm-1',
    // ssh reads `other<NBSP>#` and `vm-1`: a no-break space splits nothing.
    'Host other\u00a0# vm-1',
    "Host 'vm-1'",
  ])('refuses when %j holds the id', async (line) => {
    const { home, file } = await homeWith(line);
    const before = fs.readFileSync(file, 'utf8');
    for (const mode of [[], ['--write'], ['--json']]) {
      const r = await cli(['ssh-config', 'vm-1', ...mode], { home, respond: named('my box') });
      expect(r.code).toBe(1);
      expect(r.out + r.err).toContain(
        'a block in ~/.ssh/config for computer vm-other already uses Host vm-1; remove that block, then run again',
      );
      expect(fs.readFileSync(file, 'utf8')).toBe(before);
    }
  });

  it('does not count a negated pattern, and keeps the name', async () => {
    const { home } = await homeWith('Host x !dev');
    const r = await cli(['ssh-config', 'vm-1', '--json'], { home, respond: named('dev') });
    expect(r.err).toBe('');
    expect(JSON.parse(r.out).data.host).toBe('dev');
  });
});

describe('ssh-config for a computer id SSH cannot use', () => {
  // The id is written into the config text as the marker, HostName,
  // HostKeyAlias and, on a fallback, the Host, so an API that answers one
  // holding a line break could add a directive such as ProxyCommand to a
  // snippet the user pastes into ~/.ssh/config.
  it.each([
    ['a line break', 'vm-9\n  ProxyCommand touch /tmp/pwned\nHost x'],
    ['a leading dash', '-oProxyCommand=touch'],
    ['a space', 'vm 9'],
  ])('refuses an id with %s in every mode', async (_, id) => {
    const respond: Responder = (call) =>
      call.path === '/computers' ? json([{ ...COMPUTER, id }]) : anyRoute(call);
    const home = await tempDir();
    fs.mkdirSync(join(home, '.ssh'));
    const file = join(home, '.ssh', 'config');
    fs.writeFileSync(file, 'Host work\n  User me\n');
    const before = fs.readFileSync(file, 'utf8');
    for (const mode of [[], ['--write'], ['--json'], ['--write', '--json']]) {
      const r = await cli(['ssh-config', 'demo', ...mode], { home, respond });
      expect(r.code).toBe(1);
      if (mode.includes('--json')) {
        const parsed = JSON.parse(r.out || r.err);
        expect(parsed.data).toBeUndefined();
        expect(parsed.error).toMatchObject({
          code: 'invalid_response',
          message: `the platform returned a computer id SSH cannot use: ${id}`,
        });
        expect(r.out + r.err).not.toContain('HostName');
      } else {
        expect(r.out).toBe('');
        expect(r.err).toMatch(/^mandala: the platform returned a computer id SSH cannot use: /);
        expect(r.err).not.toContain('\n  ProxyCommand');
      }
      expect(fs.readFileSync(file, 'utf8')).toBe(before);
      expect(fs.existsSync(knownHostsPath(home))).toBe(false);
      expect(writes(r)).toEqual([]);
    }
  });

  it('takes an id with dots, dashes and underscores', async () => {
    const id = 'Vm_1.a-b';
    const r = await cli(['ssh-config', 'demo', '--json'], {
      respond: (call) =>
        call.path === '/computers' ? json([{ ...COMPUTER, id }]) : anyRoute(call),
    });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).data.computer).toBe(id);
  });
});

describe('ssh-config without a complete listing', () => {
  it.each([
    ['the listing failed', () => json({ error: 'boom' }, { status: 400 })],
    ['the listing is partial', () => json([COMPUTER], { headers: { 'X-GC-Incomplete': '1' } })],
  ])('uses the id when %s', async (_, listing) => {
    const r = await cli(['ssh-config', 'vm-1', '--write'], {
      respond: (call) => (call.path === '/computers' ? listing() : anyRoute(call)),
    });
    expect(r.code).toBe(0);
    expect(r.err).toBe(
      "mandala: could not check other computers' names; using Host vm-1 instead\n",
    );
    const file = join(r.home, '.ssh', 'config');
    expect(r.out).toBe(`wrote Host vm-1 in ${file}\nconnect with: ssh vm-1\n`);
    expect(fs.readFileSync(file, 'utf8')).toContain('\nHost vm-1\n  HostName vm-1\n');
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
        reach: 'everywhere',
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
