import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { completion } from '../src/cli-completion.js';
import { manifest } from '../src/cli-manifest.js';
import {
  COMMANDS,
  type Command,
  type Flag,
  GLOBAL_FLAGS,
  help,
  parseArgs,
} from '../src/cli-options.js';

const expectedCommands = [
  'login',
  'logout',
  'whoami',
  'version',
  'account',
  'usage',
  'computers list',
  'computers create',
  'computers get',
  'computers start',
  'computers stop',
  'computers suspend',
  'computers restart',
  'computers delete',
  'computers clone',
  'computers rename',
  'computers resize',
  'computers browser-proxy set',
  'computers browser-proxy clear',
  'computers view',
  'computers screenshot',
  'computers exec',
  'computers wait',
  'templates list',
  'templates get',
  'templates validate',
  'templates publish',
  'templates build',
  'templates watch',
  'templates retire',
  'snapshots list',
  'snapshots create',
  'snapshots restore',
  'snapshots clone',
  'snapshots delete',
  'snapshots holdings',
  'snapshots schedule get',
  'snapshots schedule set',
  'snapshots schedule clear',
  'snapshots retention',
  'webhooks list',
  'webhooks create',
  'webhooks get',
  'webhooks update',
  'webhooks delete',
  'webhooks rotate',
  'webhooks test',
  'webhooks deliveries',
  'secrets list',
  'secrets set',
  'secrets rm',
  'api-keys list',
  'api-keys create',
  'api-keys revoke',
  'files list',
  'files upload',
  'files download',
  'agent run',
  'ssh',
  'ssh-key list',
  'ssh-key add',
  'ssh-key rm',
  'ssh-access',
  'ssh-config',
  'terminal',
  'scp',
  'manifest',
  'completion',
];

const valueFor = (flag: Flag) =>
  flag.type === 'boolean' ? [] : [flag.choices?.[0] ?? (flag.type === 'number' ? '7' : 'value')];
const positionals = (command: Command) =>
  command.args
    .filter((name) => !name.endsWith('?'))
    .map((name) => command.argumentChoices?.[name]?.[0] ?? name);
const baseArgs = (command: Command) => [
  ...command.path.split(' '),
  ...positionals(command),
  ...command.flags.filter((f) => f.required).flatMap((f) => [`--${f.name}`, ...valueFor(f)]),
];
/**
 * `flag` in a position the command reads it from. A passthrough command hands
 * everything after its positionals to another program, so its own flags go
 * before them.
 */
const withFlag = (command: Command, args: string[], flag: string[]) =>
  command.passthrough
    ? [...command.path.split(' '), ...flag, ...args.slice(command.path.split(' ').length)]
    : [...args, ...flag];

async function offline(args: string[]) {
  let out = '';
  let err = '';
  const code = await main(args, {
    env: {},
    stdin: Object.assign(Readable.from([]), { isTTY: false }),
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
      throw new Error('offline commands must not create a client');
    },
  });
  return { code, out, err };
}

describe('one command inventory', () => {
  it('contains the entire supported tree with no deferred endpoints', () => {
    expect(COMMANDS.map((c) => c.path)).toEqual(expectedCommands);
    expect(new Set(COMMANDS.map((c) => c.path)).size).toBe(expectedCommands.length);
    const tree = manifest();
    expect(tree.commands.map((c) => c.path.join(' '))).toEqual(expectedCommands);
    expect(tree.commands.find((c) => c.path[0] === 'terminal')?.json_mode).toBe('unsupported');
    expect(tree.commands.find((c) => c.path[0] === 'ssh')).toMatchObject({
      json_mode: 'unsupported',
      passthrough: { unless: ['setup'] },
      arguments: [{ name: 'computer', required: true }],
    });
    expect(tree.commands.find((c) => c.path[0] === 'ssh-access')?.arguments).toEqual([
      { name: 'computer', required: true, type: 'string' },
      { name: 'state', required: false, type: 'string', choices: ['on', 'off'] },
    ]);
    expect(tree.commands.find((c) => c.path.join(' ') === 'ssh-key add')?.arguments).toEqual([
      { name: 'path', required: false, type: 'string' },
    ]);
    expect(tree.commands.find((c) => c.path.join(' ') === 'agent run')?.json_mode).toBe('ndjson');
    expect(tree.commands.find((c) => c.path.join(' ') === 'files download')?.arguments).toEqual([
      { name: 'computer', required: true, type: 'string' },
      { name: 'path', required: true, type: 'string' },
      { name: 'dest', required: false, type: 'string' },
    ]);
    const create = tree.commands.find((c) => c.path.join(' ') === 'computers create')!;
    expect(create.flags.filter((f) => f.name.startsWith('secret'))).toMatchObject([
      { name: 'secret', repeatable: true },
      { name: 'secret-file', repeatable: true },
    ]);
    // The flags that name a binding's variable or file say which flag they complete.
    expect(create.flags.filter((f) => f.follows)).toMatchObject([
      { name: 'as', repeatable: true, follows: 'secret' },
      { name: 'path', repeatable: true, follows: 'secret-file' },
    ]);
    expect(tree.commands.find((c) => c.path[0] === 'completion')?.arguments[0]).toMatchObject({
      choices: ['bash', 'zsh', 'fish'],
    });
  });

  it('advertises finite account and usage reads without resource selectors', () => {
    const entries = manifest().commands.filter((c) => ['account', 'usage'].includes(c.path[0]!));
    expect(
      entries.map((c) => ({ path: c.path, arguments: c.arguments, json_mode: c.json_mode })),
    ).toEqual([
      { path: ['account'], arguments: [], json_mode: 'finite' },
      { path: ['usage'], arguments: [], json_mode: 'finite' },
    ]);
    expect(entries[0]!.flags.map((f) => f.name)).toEqual(['profile', 'json', 'help']);
    expect(entries[1]!.flags.map((f) => f.name)).toEqual(['profile', 'json', 'help', 'from', 'to']);
    expect(help('usage')).toContain('RFC 3339 timestamp with a time zone');
  });

  for (const command of COMMANDS) {
    it(`parses and advertises every flag of ${command.path}`, () => {
      const entry = manifest().commands.find((c) => c.path.join(' ') === command.path)!;
      expect(entry.flags).toEqual([...GLOBAL_FLAGS, ...command.flags]);
      expect(parseArgs(baseArgs(command)).path).toBe(command.path);
      for (const flag of [...GLOBAL_FLAGS, ...command.flags]) {
        const args = baseArgs(command);
        const already = args.indexOf(`--${flag.name}`);
        if (already >= 0) args.splice(already, flag.type === 'boolean' ? 1 : 2);
        // A flag that completes another (--as after --secret) is typed after it.
        const leader = flag.follows ? [`--${flag.follows}`, 'value'] : [];
        const parsed = parseArgs(
          withFlag(command, args, [...leader, `--${flag.name}`, ...valueFor(flag)]),
        );
        expect(parsed.flags[flag.name]).toEqual(
          flag.repeatable
            ? valueFor(flag)
            : flag.type === 'boolean'
              ? true
              : flag.type === 'number'
                ? 7
                : valueFor(flag)[0],
        );
        expect(help(command.path)).toContain(`--${flag.name}`);
        if (flag.alias)
          expect(
            parseArgs(withFlag(command, args, [`-${flag.alias}`, ...valueFor(flag)])).flags[
              flag.name
            ],
          ).toEqual(parsed.flags[flag.name]);
      }
      for (const [i, arg] of entry.arguments.entries())
        expect(arg.required).toBe(!command.args[i]!.endsWith('?'));
    });
  }

  it('supports global flags before the command and -- before dash-prefixed operands', () => {
    expect(parseArgs(['--json', 'computers', 'get', 'demo']).json).toBe(true);
    expect(parseArgs(['computers', 'get', '--', '--name']).args).toEqual(['--name']);
    expect(parseArgs(['computers', 'exec', 'demo', '--command=--json']).flags.command).toBe(
      '--json',
    );
  });

  it('rejects duplicate singleton flags and malformed booleans', () => {
    expect(() => parseArgs(['computers', 'list', '--json', '--json'])).toThrow(/once/);
    expect(() => parseArgs(['computers', 'list', '--allow-partial=false'])).toThrow(
      /takes no value/,
    );
    expect(() => parseArgs(['computers', 'create', '--cpu', 'Infinity'])).toThrow(/finite number/);
  });
});

describe('offline discovery', () => {
  it.each([
    ['--help'],
    ['help'],
    ['computers', '--help'],
    ['snapshots', 'schedule', '--help'],
    ['terminal', '--help'],
    ['scp', '--help'],
    ['account', '--help'],
    ['usage', '--help'],
    ['usage', '--from', 'invalid', '--help'],
  ])('%j needs no credentials', async (...args) => {
    const result = await offline(args);
    expect(result.code).toBe(0);
    expect(result.out).toContain('mandala');
    expect(result.err).toBe('');
  });

  it('prints machine-readable manifest by default and an envelope with --json', async () => {
    const plain = await offline(['manifest']);
    const wrapped = await offline(['manifest', '--json']);
    expect(JSON.parse(plain.out)).toEqual(manifest());
    expect(JSON.parse(wrapped.out)).toEqual({
      schema_version: 2,
      command: 'manifest',
      ok: true,
      data: manifest(),
      exit_code: 0,
    });
  });

  it.each(['bash', 'zsh', 'fish'])(
    'prints %s completions without installation or network',
    async (shell) => {
      const plain = await offline(['completion', shell]);
      const wrapped = await offline(['completion', shell, '--json']);
      expect(plain.code).toBe(0);
      expect(plain.out).toBe(completion(shell));
      expect(JSON.parse(wrapped.out).data).toEqual({ shell, script: completion(shell) });
      for (const command of COMMANDS)
        for (const flag of command.flags)
          expect(plain.out).toContain(shell === 'fish' ? `-l ${flag.name}` : `--${flag.name}`);
    },
  );

  it('completes --as and --path after computers create', () => {
    for (const shell of ['bash', 'zsh'] as const)
      expect(completion(shell)).toMatch(/'computers create'\) candidates='[^']*--as [^']*--path /);
    expect(completion('fish')).toContain(
      'complete -c mandala -f -n "__mandala_matches_context \'computers create\'" -l as -r',
    );
    expect(completion('fish')).toContain(
      'complete -c mandala -f -n "__mandala_matches_context \'computers create\'" -l path -r',
    );
  });

  it('produces syntactically valid bash and zsh scripts', () => {
    execFileSync('/bin/bash', ['-n'], { input: completion('bash') });
    execFileSync('/bin/zsh', ['-n'], { input: completion('zsh') });
  });

  it('completes bash command groups and contextual flags', () => {
    const script = `${completion('bash')}\nCOMP_WORDS=(mandala snapshots sch); COMP_CWORD=2; _mandala_complete; printf '%s\\n' "\${COMPREPLY[@]}"\nCOMP_WORDS=(mandala computers exec demo --ti); COMP_CWORD=4; _mandala_complete; printf '%s\\n' "\${COMPREPLY[@]}"`;
    expect(execFileSync('/bin/bash', ['-c', script], { encoding: 'utf8' })).toBe(
      'schedule\n--timeout\n',
    );
    const values = `${completion('bash')}\nCOMP_WORDS=(mandala computers list --state lo); COMP_CWORD=4; _mandala_complete; printf '%s\\n' "\${COMPREPLY[@]}"`;
    expect(execFileSync('/bin/bash', ['-c', values], { encoding: 'utf8' })).toBe('lost\n');
    const reads = `${completion('bash')}\nCOMP_WORDS=(mandala acc); COMP_CWORD=1; _mandala_complete; printf '%s\\n' "\${COMPREPLY[@]}"\nCOMP_WORDS=(mandala usa); COMP_CWORD=1; _mandala_complete; printf '%s\\n' "\${COMPREPLY[@]}"\nCOMP_WORDS=(mandala usage --fr); COMP_CWORD=2; _mandala_complete; printf '%s\\n' "\${COMPREPLY[@]}"\nCOMP_WORDS=(mandala usage --to); COMP_CWORD=2; _mandala_complete; printf '%s\\n' "\${COMPREPLY[@]}"`;
    expect(execFileSync('/bin/bash', ['-c', reads], { encoding: 'utf8' })).toBe(
      'account\nusage\n--from\n--to\n',
    );
  });

  const fishAvailable = spawnSync('fish', ['--version'], { encoding: 'utf8' }).status === 0;
  // Fish may be absent locally. CI installs it and must execute every probe.
  it.skipIf(!fishAvailable && !process.env.CI).each([
    ['mandala computers li', 'list'],
    ['mandala --json computers li', 'list'],
    ['mandala --help computers li', 'list'],
    ['mandala -h computers li', 'list'],
    ['mandala --json computers exec desktop --ti', '--timeout'],
    ['mandala computers --json exec desktop --ti', '--timeout'],
    ['mandala --json snapshots schedule cl', 'clear'],
    ['mandala --json computers list --state lo', 'lost'],
    ['mandala acc', 'account'],
    ['mandala usa', 'usage'],
    ['mandala usage --fr', '--from'],
    ['mandala --json usage --to', '--to'],
  ])('fish completes %s from the actual command context', async (line, expected) => {
    expect(fishAvailable, 'CI requires fish for shell completion probes').toBe(true);
    const directory = await mkdtemp(join(tmpdir(), 'mandala-fish-'));
    try {
      const scriptPath = join(directory, 'completion.fish');
      // Fish 3.7 cannot read scripts from the socket Node supplies as stdin.
      await writeFile(scriptPath, `${completion('fish')}\ncomplete -C '${line}'\n`);
      const result = spawnSync('fish', ['--no-config', scriptPath], {
        encoding: 'utf8',
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toBe('');
      expect(
        result.stdout
          .trim()
          .split('\n')
          .map((entry) => entry.split('\t')[0]),
      ).toContain(expected);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps CLI modules outside the browser-compatible library import graph', async () => {
    const seen = new Set<string>();
    async function visit(name: string): Promise<void> {
      if (seen.has(name)) return;
      seen.add(name);
      const code = await readFile(new URL(`../src/${name}`, import.meta.url), 'utf8');
      expect(code).not.toMatch(/from ['"](?:node:|\.\/cli)/);
      for (const match of code.matchAll(/(?:from\s+|import\s*)['"]\.\/([^'"]+)\.js['"]/g))
        await visit(`${match[1]}.ts`);
    }
    await visit('index.ts');
    expect(seen.size).toBeGreaterThan(5);
  });
});
