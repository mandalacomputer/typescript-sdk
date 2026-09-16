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
  'computers list',
  'computers create',
  'computers get',
  'computers start',
  'computers stop',
  'computers suspend',
  'computers restart',
  'computers delete',
  'computers clone',
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
  'agent run',
  'ssh',
  'scp',
  'manifest',
  'completion',
];

const valueFor = (flag: Flag) =>
  flag.type === 'boolean' ? [] : [flag.choices?.[0] ?? (flag.type === 'number' ? '7' : 'value')];
const baseArgs = (command: Command) => [
  ...command.path.split(' '),
  ...command.args.map((name) => command.argumentChoices?.[name]?.[0] ?? name),
  ...command.flags.filter((f) => f.required).flatMap((f) => [`--${f.name}`, ...valueFor(f)]),
];

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
    expect(tree.commands.find((c) => c.path[0] === 'ssh')?.jsonMode).toBe('unsupported');
    expect(tree.commands.find((c) => c.path.join(' ') === 'agent run')?.jsonMode).toBe('ndjson');
    expect(tree.commands.find((c) => c.path[0] === 'completion')?.arguments[0]).toMatchObject({
      choices: ['bash', 'zsh', 'fish'],
    });
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
        const parsed = parseArgs([...args, `--${flag.name}`, ...valueFor(flag)]);
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
            parseArgs([...args, `-${flag.alias}`, ...valueFor(flag)]).flags[flag.name],
          ).toEqual(parsed.flags[flag.name]);
      }
      for (const arg of entry.arguments) expect(arg.required).toBe(true);
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
    ['ssh', '--help'],
    ['scp', '--help'],
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
      schemaVersion: 1,
      command: 'manifest',
      ok: true,
      data: manifest(),
      exitCode: 0,
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
