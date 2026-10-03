/**
 * `mandala workspaces use` and `workspaces current` (OPL-5499): a default
 * workspace per saved profile, kept in ~/.mandala/defaults.json beside
 * credentials.json, which never changes.
 */

import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import { completion } from '../src/cli-completion.js';
import { manifest } from '../src/cli-manifest.js';
import { help } from '../src/cli-options.js';
import type { CliIO } from '../src/cli-runtime.js';
import {
  type CredentialProfile,
  CredentialsError,
  parseCredentials,
  readCredentials,
  saveCredentials,
} from '../src/credentials.js';
import {
  type DefaultsFile,
  parseDefaults,
  readDefaults,
  saveWorkspaceDefault,
  workspaceDefault,
} from '../src/defaults.js';
import { Client } from '../src/index.js';
import { anyRoute, BASE, type Responder, recorder, WORKSPACE } from './harness.js';

const OTHER = { id: 'wsp-ba9876543210', name: 'research', created_at: WORKSPACE.created_at };
const ACCOUNT_WIDE: CredentialProfile = {
  api_key: 'com_profile_key',
  base_url: 'https://app.mandala.computer/api/v1',
  key_id: 'key-000000000001',
  account: { id: 'acc-000000000001', name: 'Acme' },
  scope: { type: 'account' },
};
const CONFINED: CredentialProfile = {
  ...ACCOUNT_WIDE,
  key_id: 'key-000000000002',
  scope: { type: 'workspace', workspace_id: WORKSPACE.id, workspace_name: WORKSPACE.name },
};

/** Both workspaces listed, each readable by id; everything else as the harness answers. */
const respond: Responder = (call) => {
  if (call.method === 'GET' && call.path === '/workspaces')
    return new Response(JSON.stringify([WORKSPACE, OTHER]), {
      headers: { 'content-type': 'application/json' },
    });
  if (call.method === 'GET' && call.path === `/workspaces/${OTHER.id}`)
    return new Response(JSON.stringify(OTHER), {
      headers: { 'content-type': 'application/json' },
    });
  return anyRoute(call);
};

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(join(os.tmpdir(), 'mandala-defaults-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});
const credentialsPath = () => join(home, '.mandala', 'credentials.json');
const defaultsPath = () => join(home, '.mandala', 'defaults.json');

/** The CLI with a saved profile in use: no MANDALA_API_KEY unless a test sets one. */
function cli(environment: NodeJS.ProcessEnv = {}, input?: string) {
  const rec = recorder(respond);
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const io: Partial<CliIO> = {
    stdin: Object.assign(Readable.from(input === undefined ? [] : [Buffer.from(input)]), {
      isTTY: input === undefined,
    }),
    stdout: {
      write: ((s: string | Uint8Array) => {
        stdout.push(Buffer.from(s));
        return true;
      }) as NodeJS.WritableStream['write'],
    },
    stderr: {
      write: ((s: string | Uint8Array) => {
        stderr.push(Buffer.from(s));
        return true;
      }) as NodeJS.WritableStream['write'],
    },
    env: { ...environment },
    createClient: () => new Client({ apiKey: 'com_profile_key', baseUrl: BASE, fetch: rec.fetch }),
    now: () => new Date('2026-01-02T03:04:05.000Z'),
  };
  return {
    rec,
    async run(args: string[]) {
      stdout.length = 0;
      stderr.length = 0;
      const code = await main(args, io);
      const out = Buffer.concat(stdout).toString();
      return {
        code,
        out,
        err: Buffer.concat(stderr).toString(),
        json: args.includes('--json') && out.trim() ? JSON.parse(out) : undefined,
      };
    },
  };
}

/** The workspace a recorded secrets or api-keys call was sent for, wherever it went. */
const sentWorkspace = (call: { query: Record<string, string>; body: unknown }) =>
  call.query.workspace_id ?? (call.body as { workspace_id?: string } | undefined)?.workspace_id;

describe('workspaces use', () => {
  it('saves the default in defaults.json alone, and current reports it', async () => {
    await saveCredentials(ACCOUNT_WIDE);
    const before = fs.readFileSync(credentialsPath());
    const h = cli();
    const r = await h.run(['workspaces', 'use', OTHER.id]);
    expect(r.code).toBe(0);
    expect(r.out).toBe(
      `Profile default now uses workspace research (${OTHER.id}) by default for secrets, api-keys create, computers create and computers list.\n`,
    );
    // Resolved through the API; no key minted.
    expect(h.rec.routes()).toEqual([
      ['GET', 'workspaces'],
      ['GET', `workspaces/${OTHER.id}`],
    ]);
    expect(fs.statSync(defaultsPath()).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(defaultsPath(), 'utf8'))).toEqual({
      version: 1,
      profiles: {
        default: {
          account_id: 'acc-000000000001',
          workspace: { id: OTHER.id, name: 'research' },
        },
      },
    });
    expect(fs.existsSync(join(home, '.mandala', '.defaults.lock'))).toBe(false);
    // credentials.json is byte for byte what it was, so an older reader,
    // whose profile schema is closed, still reads it.
    expect(fs.readFileSync(credentialsPath())).toEqual(before);
    expect(() => parseCredentials(fs.readFileSync(credentialsPath()))).not.toThrow();

    const current = await h.run(['workspaces', 'current', '--json']);
    expect(current.json.data).toEqual({
      profile: 'default',
      workspace: { id: OTHER.id, name: 'research' },
      source: 'profile',
    });
    const text = await h.run(['workspaces', 'current']);
    expect(text.out).toContain(`workspace research (${OTHER.id}): profile default's default`);
  });

  it('takes a workspace name, and answers JSON', async () => {
    await saveCredentials(ACCOUNT_WIDE, 'work');
    const r = await cli({ MANDALA_PROFILE: 'work' }).run([
      'workspaces',
      'use',
      'research',
      '--json',
    ]);
    expect(r.code).toBe(0);
    expect(r.json.data).toEqual({
      profile: 'work',
      workspace: { id: OTHER.id, name: 'research' },
      source: 'profile',
    });
    expect(readDefaults()?.profiles.work?.workspace.id).toBe(OTHER.id);
  });

  it('keeps every other profile default when one is saved', async () => {
    await saveCredentials(ACCOUNT_WIDE, 'home');
    await saveCredentials(ACCOUNT_WIDE, 'work');
    await cli().run(['--profile', 'home', 'workspaces', 'use', WORKSPACE.id]);
    await cli().run(['--profile', 'work', 'workspaces', 'use', OTHER.id]);
    expect(readDefaults()).toEqual({
      version: 1,
      profiles: {
        home: {
          account_id: 'acc-000000000001',
          workspace: { id: WORKSPACE.id, name: 'customers' },
        },
        work: { account_id: 'acc-000000000001', workspace: { id: OTHER.id, name: 'research' } },
      },
    });
  });

  it('refuses another workspace for a profile whose key is confined, writing nothing', async () => {
    await saveCredentials(CONFINED);
    const h = cli();
    const r = await h.run(['workspaces', 'use', OTHER.id]);
    expect(r.code).toBe(1);
    expect(r.err).toContain(
      `This profile's key is confined to workspace customers (${WORKSPACE.id}); it cannot use another workspace. Log in again without --workspace for an account-wide key.`,
    );
    expect(fs.existsSync(defaultsPath())).toBe(false);
    expect(h.rec.calls).toEqual([]);

    const own = await h.run(['workspaces', 'use', WORKSPACE.name]);
    expect(own.code).toBe(0);
    expect(own.out).toContain('is already confined to workspace customers');
    expect(fs.existsSync(defaultsPath())).toBe(false);

    const current = await h.run(['workspaces', 'current', '--json']);
    expect(current.json.data).toEqual({
      profile: 'default',
      workspace: { id: WORKSPACE.id, name: 'customers' },
      source: 'key',
    });
  });

  it('is refused while MANDALA_API_KEY supplies the key', async () => {
    await saveCredentials(ACCOUNT_WIDE);
    const h = cli({ MANDALA_API_KEY: 'com_env_key' });
    const r = await h.run(['workspaces', 'use', OTHER.id]);
    expect(r.code).toBe(1);
    expect(r.err).toContain(
      'workspaces use saves a default in a saved profile; MANDALA_API_KEY is set, so there is no profile to save it in.',
    );
    expect(fs.existsSync(defaultsPath())).toBe(false);
    expect(h.rec.calls).toEqual([]);
    const current = await h.run(['workspaces', 'current', '--json']);
    expect(current.json.data).toEqual({ profile: null, workspace: null, source: 'none' });
  });

  it('--clear removes the entry, idempotently, and needs no request', async () => {
    await saveCredentials(ACCOUNT_WIDE, 'home');
    await saveCredentials(ACCOUNT_WIDE, 'work');
    await saveWorkspaceDefault('home', { account_id: 'acc-000000000001', workspace: OTHER });
    await saveWorkspaceDefault('work', { account_id: 'acc-000000000001', workspace: OTHER });
    const h = cli({ MANDALA_PROFILE: 'work' });
    const r = await h.run(['workspaces', 'use', '--clear', '--json']);
    expect(r.json.data).toEqual({ profile: 'work', workspace: null, removed: true });
    expect(Object.keys(readDefaults()!.profiles)).toEqual(['home']);
    const again = await h.run(['workspaces', 'use', '--clear']);
    expect(again.code).toBe(0);
    expect(again.out).toContain('Profile work has no default workspace; nothing to clear.');
    expect(h.rec.calls).toEqual([]);
    // The last entry removed takes the file with it.
    await cli({ MANDALA_PROFILE: 'home' }).run(['workspaces', 'use', '--clear']);
    expect(fs.existsSync(defaultsPath())).toBe(false);
  });

  it('needs a workspace or --clear, not both and not neither', async () => {
    await saveCredentials(ACCOUNT_WIDE);
    const both = await cli().run(['workspaces', 'use', OTHER.id, '--clear']);
    expect(both.code).toBe(1);
    expect(both.err).toContain('give a workspace or --clear, not both');
    const neither = await cli().run(['workspaces', 'use']);
    expect(neither.code).toBe(1);
    expect(neither.err).toContain('say which workspace');
  });

  it('refuses to overwrite a defaults.json it cannot read', async () => {
    await saveCredentials(ACCOUNT_WIDE);
    fs.writeFileSync(defaultsPath(), '{"version":1,', { mode: 0o600 });
    const r = await cli().run(['workspaces', 'use', OTHER.id]);
    expect(r.code).toBe(1);
    expect(r.err).toContain(
      '~/.mandala/defaults.json cannot be read (it is not valid JSON), so it was not changed. Delete or fix it',
    );
    expect(fs.readFileSync(defaultsPath(), 'utf8')).toBe('{"version":1,');
    fs.writeFileSync(defaultsPath(), '{"version":2,"profiles":{}}');
    const newer = await cli().run(['workspaces', 'use', '--clear']);
    expect(newer.code).toBe(1);
    expect(newer.err).toContain('it is a version this CLI does not read');
    expect(fs.readFileSync(defaultsPath(), 'utf8')).toBe('{"version":2,"profiles":{}}');
  });
});

describe('the default applied', () => {
  it('scopes secrets list, set and rm, and api-keys create, unless --workspace or --clear', async () => {
    await saveCredentials(ACCOUNT_WIDE);
    const h = cli();
    await h.run(['workspaces', 'use', OTHER.id]);
    h.rec.calls.length = 0;

    const listed = await h.run(['secrets', 'list']);
    expect(listed.code).toBe(0);
    expect(listed.err).toContain(
      '(workspace research from `workspaces use`; `workspaces use --clear` for account-wide)',
    );
    expect(h.rec.last().query).toEqual({ workspace_id: OTHER.id });

    const removed = await h.run(['secrets', 'rm', 'OPENAI_API_KEY', '--json']);
    expect(removed.code).toBe(0);
    expect(h.rec.calls.filter((c) => c.path.startsWith('/secrets')).map(sentWorkspace)).toEqual(
      h.rec.calls.filter((c) => c.path.startsWith('/secrets')).map(() => OTHER.id),
    );

    h.rec.calls.length = 0;
    const minted = await h.run(['api-keys', 'create', '--name', 'ci', '--json']);
    expect(minted.code).toBe(0);
    expect(h.rec.last().body).toEqual({ name: 'ci', workspace_id: OTHER.id });
    // JSON mode keeps stderr for errors: no note.
    expect(minted.err).not.toContain('workspaces use');

    // An explicit --workspace always wins.
    await h.run(['secrets', 'list', '--workspace', WORKSPACE.id]);
    expect(h.rec.last().query).toEqual({ workspace_id: WORKSPACE.id });
    await h.run(['api-keys', 'create', '--workspace', WORKSPACE.id, '--json']);
    expect(h.rec.last().body).toEqual({ workspace_id: WORKSPACE.id });

    // --clear is the way back to account-wide.
    await h.run(['workspaces', 'use', '--clear']);
    const plain = await h.run(['secrets', 'list']);
    expect(h.rec.last().query).toEqual({});
    expect(plain.err).not.toContain('workspaces use');
    await h.run(['api-keys', 'create', '--json']);
    expect(h.rec.last().body).toEqual({});
  });

  it('scopes computers create and list (platform OPL-5543), unless --workspace or --clear', async () => {
    await saveCredentials(ACCOUNT_WIDE);
    const h = cli();
    await h.run(['workspaces', 'use', OTHER.id]);
    h.rec.calls.length = 0;
    const createSent = () =>
      h.rec.calls.filter((c) => c.method === 'POST' && c.path === '/computers');

    const listed = await h.run(['computers', 'list']);
    expect(listed.code).toBe(0);
    expect(h.rec.last().query).toEqual({ workspace_id: OTHER.id });
    expect(listed.err).toContain('(workspace research from `workspaces use`');

    const made = await h.run(['computers', 'create', '--template', 'base', '--json']);
    expect(made.code).toBe(0);
    expect(createSent().map((c) => sentWorkspace(c))).toEqual([OTHER.id]);

    // An explicit --workspace always wins, and the listing takes `unassigned`.
    h.rec.calls.length = 0;
    await h.run([
      'computers',
      'create',
      '--template',
      'base',
      '--workspace',
      WORKSPACE.id,
      '--json',
    ]);
    expect(createSent().map((c) => sentWorkspace(c))).toEqual([WORKSPACE.id]);
    await h.run(['computers', 'list', '--workspace', 'unassigned', '--json']);
    expect(h.rec.last().query).toEqual({ workspace_id: 'unassigned' });

    // --clear is the way back to the key's own scope.
    await h.run(['workspaces', 'use', '--clear']);
    h.rec.calls.length = 0;
    await h.run(['computers', 'list', '--json']);
    expect(h.rec.last().query).toEqual({});
    await h.run(['computers', 'create', '--template', 'base', '--json']);
    expect(createSent().map((c) => sentWorkspace(c))).toEqual([undefined]);
  });

  it('is not applied to computers create or list for a profile whose key is confined', async () => {
    await saveCredentials(CONFINED);
    await saveWorkspaceDefault('default', { account_id: 'acc-000000000001', workspace: OTHER });
    const h = cli();
    await h.run(['computers', 'list', '--json']);
    expect(h.rec.last().query).toEqual({});
    await h.run(['computers', 'create', '--template', 'base', '--json']);
    expect(h.rec.last().body).not.toHaveProperty('workspace_id');
  });

  it('sends the set in the default workspace', async () => {
    await saveCredentials(ACCOUNT_WIDE);
    await saveWorkspaceDefault('default', { account_id: 'acc-000000000001', workspace: OTHER });
    const h = cli({}, 'value-from-stdin');
    const r = await h.run(['secrets', 'set', 'NEW_SECRET', '--json']);
    expect(r.code).toBe(0);
    const writes = h.rec.calls.filter((c) => c.method !== 'GET');
    expect(writes.length).toBeGreaterThan(0);
    for (const call of writes) expect(sentWorkspace(call)).toBe(OTHER.id);
  });

  it('is not applied while MANDALA_API_KEY supplies the key', async () => {
    await saveCredentials(ACCOUNT_WIDE);
    await saveWorkspaceDefault('default', { account_id: 'acc-000000000001', workspace: OTHER });
    const h = cli({ MANDALA_API_KEY: 'com_env_key' });
    const r = await h.run(['secrets', 'list']);
    expect(r.code).toBe(0);
    expect(h.rec.last().query).toEqual({});
    expect(r.err).not.toContain('workspaces use');
  });

  it('is not applied to a profile whose key is confined', async () => {
    await saveCredentials(CONFINED);
    // A default saved while the profile held an account-wide key.
    await saveWorkspaceDefault('default', { account_id: 'acc-000000000001', workspace: OTHER });
    const h = cli();
    await h.run(['secrets', 'list']);
    expect(h.rec.last().query).toEqual({});
  });

  it('ignores a default saved for another account, and current says so', async () => {
    await saveCredentials(ACCOUNT_WIDE);
    await saveWorkspaceDefault('default', { account_id: 'acc-00000000000f', workspace: OTHER });
    const h = cli();
    const r = await h.run(['secrets', 'list']);
    expect(r.code).toBe(0);
    expect(h.rec.last().query).toEqual({});
    const current = await h.run(['workspaces', 'current', '--json']);
    expect(current.json.data).toEqual({ profile: 'default', workspace: null, source: 'none' });
    expect(current.err).toContain(
      `The default workspace research (${OTHER.id}) saved for profile default is ignored: it was saved for account acc-00000000000f`,
    );
    const text = await h.run(['workspaces', 'current']);
    expect(text.out).toContain('none: account-wide');
  });

  it.each([
    ['not JSON', '{"version":1,', 'it is not valid JSON'],
    ['another version', '{"version":2,"profiles":{}}', 'it is a version this CLI does not read'],
    ['a closed-schema miss', '{"version":1,"profiles":{},"x":1}', 'its contents are not'],
  ])('reads a defaults.json that is %s as none, with a note', async (_label, text, why) => {
    await saveCredentials(ACCOUNT_WIDE);
    fs.writeFileSync(defaultsPath(), text, { mode: 0o600 });
    const h = cli();
    const r = await h.run(['secrets', 'list']);
    expect(r.code).toBe(0);
    expect(h.rec.last().query).toEqual({});
    expect(r.err).toContain(`ignoring ~/.mandala/defaults.json: ${why}`);
    expect(r.err.split('\n').filter((l) => l.includes('defaults.json'))).toHaveLength(1);
    // --json keeps stderr quiet and still works.
    const quiet = await h.run(['secrets', 'list', '--json']);
    expect(quiet.code).toBe(0);
    expect(quiet.err).toBe('');
  });

  it('reads a defaults.json others can read as none, with a note', async () => {
    await saveCredentials(ACCOUNT_WIDE);
    await saveWorkspaceDefault('default', { account_id: 'acc-000000000001', workspace: OTHER });
    fs.chmodSync(defaultsPath(), 0o644);
    const h = cli();
    const r = await h.run(['secrets', 'list']);
    expect(r.code).toBe(0);
    expect(h.rec.last().query).toEqual({});
    expect(r.err).toContain('ignoring ~/.mandala/defaults.json: it must be a regular file');
  });
});

describe('an unreadable defaults.json and the commands that write', () => {
  const broken: [string, (path: string) => Promise<void> | void, string][] = [
    [
      'not JSON',
      (path) => fs.writeFileSync(path, '{"version":1,', { mode: 0o600 }),
      'it is not valid JSON',
    ],
    [
      'readable by others',
      async (path) => {
        await saveWorkspaceDefault('default', { account_id: 'acc-000000000001', workspace: OTHER });
        fs.chmodSync(path, 0o644);
      },
      'it must be a regular file',
    ],
  ];
  const writers: [string, string[]][] = [
    ['secrets set', ['secrets', 'set', 'NEW_SECRET']],
    ['secrets rm', ['secrets', 'rm', 'OPENAI_API_KEY']],
    ['api-keys create', ['api-keys', 'create', '--name', 'ci']],
    ['computers create', ['computers', 'create', '--template', 'base']],
  ];
  const cases = broken.flatMap(([label, make, why]) =>
    writers.flatMap(([command, args]) =>
      [false, true].map((json) => ({ label, make, why, command, args, json })),
    ),
  );

  it.each(cases)(
    '$command refuses, sending nothing, on a defaults.json $label (json: $json)',
    async ({ make, why, args, json }) => {
      await saveCredentials(ACCOUNT_WIDE);
      await make(defaultsPath());
      const before = fs.readFileSync(defaultsPath());
      const h = cli({}, 'value-from-stdin');
      const r = await h.run(json ? [...args, '--json'] : args);
      expect(r.code).not.toBe(0);
      const said = r.out + r.err;
      expect(said).toContain(`~/.mandala/defaults.json cannot be read (${why}`);
      expect(said).toContain('Pass --workspace, or fix or delete the file.');
      expect(h.rec.calls.filter((c) => c.method !== 'GET')).toEqual([]);
      expect(fs.readFileSync(defaultsPath())).toEqual(before);
    },
  );

  it.each(cases)(
    '$command with --workspace goes ahead on a defaults.json $label (json: $json)',
    async ({ make, args, json }) => {
      await saveCredentials(ACCOUNT_WIDE);
      await make(defaultsPath());
      const h = cli({}, 'value-from-stdin');
      const withFlag = [...args, '--workspace', WORKSPACE.id];
      const r = await h.run(json ? [...withFlag, '--json'] : withFlag);
      expect(r.code).toBe(0);
      const writes = h.rec.calls.filter((c) => c.method !== 'GET');
      expect(writes.length).toBeGreaterThan(0);
      for (const call of writes) expect(sentWorkspace(call)).toBe(WORKSPACE.id);
      expect(r.err).not.toContain('defaults.json');
    },
  );

  it('computers list reads past it with a note, as secrets list does', async () => {
    await saveCredentials(ACCOUNT_WIDE);
    fs.mkdirSync(join(home, '.mandala'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(defaultsPath(), '{"version":1,', { mode: 0o600 });
    const h = cli();
    const r = await h.run(['computers', 'list']);
    expect(r.code).toBe(0);
    expect(h.rec.last().query).toEqual({});
    expect(r.err).toContain('defaults.json');
  });

  it('does not refuse when the key is confined or MANDALA_API_KEY supplies it', async () => {
    fs.mkdirSync(join(home, '.mandala'), { recursive: true, mode: 0o700 });
    await saveCredentials(CONFINED);
    fs.writeFileSync(defaultsPath(), '{"version":1,', { mode: 0o600 });
    const confined = await cli().run(['api-keys', 'create', '--json']);
    expect(confined.code).toBe(0);
    await saveCredentials(ACCOUNT_WIDE);
    const env = await cli({ MANDALA_API_KEY: 'com_env_key' }).run(['api-keys', 'create', '--json']);
    expect(env.code).toBe(0);
  });
});

describe('logout', () => {
  it("removes the profile's default and keeps the others", async () => {
    await saveCredentials(ACCOUNT_WIDE, 'home');
    await saveCredentials(ACCOUNT_WIDE, 'work');
    await saveWorkspaceDefault('home', { account_id: 'acc-000000000001', workspace: OTHER });
    await saveWorkspaceDefault('work', { account_id: 'acc-000000000001', workspace: OTHER });
    const r = await cli().run(['logout', '--profile', 'work']);
    expect(r.code).toBe(0);
    expect(Object.keys(readDefaults()!.profiles)).toEqual(['home']);
    // The default profile, as logout resolves it.
    await cli().run(['logout']);
    expect(fs.existsSync(defaultsPath())).toBe(false);
    expect(readCredentials()).toBeUndefined();
  });

  it('still logs out when defaults.json cannot be changed, with a warning', async () => {
    await saveCredentials(ACCOUNT_WIDE);
    fs.writeFileSync(defaultsPath(), 'not json', { mode: 0o600 });
    const r = await cli().run(['logout']);
    expect(r.code).toBe(0);
    expect(r.err).toContain('Removed profile default');
    expect(r.err).toContain(
      'the profile was removed, but its default workspace in ~/.mandala/defaults.json was not: it is not valid JSON',
    );
    expect(readCredentials()).toBeUndefined();
  });
});

describe('defaults.json', () => {
  type Vectors = {
    valid: {
      name: string;
      text: string;
      lookups: {
        profile: string;
        account_id: string;
        entry: { id: string; name: string } | null;
        ignored: { id: string; name: string } | null;
      }[];
    }[];
    invalid: { name: string; text: string; code: string }[];
  };
  const vectors: Vectors = JSON.parse(
    fs.readFileSync(new URL('./fixtures/defaults-v1.json', import.meta.url), 'utf8'),
  );

  it.each(vectors.valid)('reads the shared vector: $name', ({ text, lookups }) => {
    const file: DefaultsFile = parseDefaults(new TextEncoder().encode(text));
    for (const l of lookups) {
      const found = workspaceDefault(file, l.profile, l.account_id);
      expect(found.entry?.workspace ?? null).toEqual(l.entry);
      expect(found.ignored?.workspace ?? null).toEqual(l.ignored);
    }
  });

  it.each(vectors.invalid)('refuses the shared vector: $name', ({ text, code }) => {
    let error: unknown;
    try {
      parseDefaults(new TextEncoder().encode(text));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CredentialsError);
    expect((error as CredentialsError).code).toBe(code);
  });
});

describe('command inventory', () => {
  it('lists workspaces use and current in help, the manifest and completion', () => {
    expect(help('workspaces')).toContain('mandala workspaces use [workspace]');
    expect(help('workspaces')).toContain('mandala workspaces current');
    const use = manifest().commands.find((c) => c.path.join(' ') === 'workspaces use');
    expect(use?.arguments).toEqual([{ name: 'workspace', required: false, type: 'string' }]);
    expect(use?.flags.map((f) => f.name)).toContain('clear');
    expect(manifest().commands.some((c) => c.path.join(' ') === 'workspaces current')).toBe(true);
    for (const shell of ['bash', 'zsh', 'fish']) {
      const script = completion(shell);
      expect(script).toContain('use');
      expect(script).toContain('current');
    }
  });
});
