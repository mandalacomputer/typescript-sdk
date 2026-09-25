/**
 * `client.apiKeys` and `client.account.whoami()` (platform OPL-5053), and the
 * CLI commands on top of them: `whoami`, `api-keys list | create | revoke`,
 * `logout` and `--version`.
 */

import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import { parseArgs } from '../src/cli-options.js';
import type { CliIO } from '../src/cli-runtime.js';
import {
  type CredentialProfile,
  readCredentials,
  removeCredentials,
  saveCredentials,
} from '../src/credentials.js';
import {
  Client,
  MandalaError,
  NotFoundError,
  PermissionDeniedError,
  ValidationError,
  VERSION,
} from '../src/index.js';
import {
  API_KEY,
  API_KEY_CREATED,
  anyRoute,
  BASE,
  json,
  type Responder,
  recorder,
  WHOAMI,
} from './harness.js';

const NO_PERMISSION =
  'This API key cannot manage API keys. Turn on “Manage keys” for it under Credentials in the dashboard, or use a key that has it.';
const NO_ESCALATION =
  'An API key cannot mint a key that manages keys. Turn that on for the new key from the dashboard.';

function sdk(respond: Responder = anyRoute) {
  const rec = recorder(respond);
  return { rec, client: new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch }) };
}

describe('client.account.whoami', () => {
  it('reads GET whoami and decodes every part', async () => {
    const { rec, client } = sdk();
    const who = await client.account.whoami();
    expect(rec.routes()).toEqual([['GET', 'whoami']]);
    expect(who.user).toEqual({ id: 'usr-1', email: 'dana@example.com', name: 'Dana' });
    expect(who.account).toEqual({ id: 'acc-1', name: 'Acme', plan: 'team', status: 'active' });
    expect(who.role).toBe('owner');
    expect(who.workspace).toBeNull();
    expect(who.key).toMatchObject({ id: 'key-000000000001', name: 'laptop', manageKeys: true });
    expect(who.raw).toEqual(WHOAMI);
  });

  it('decodes a workspace-scoped key, a null key, and a suspended account', async () => {
    const { client } = sdk(() =>
      json({
        ...WHOAMI,
        account: { ...WHOAMI.account, name: null, status: 'suspended' },
        role: 'viewer',
        workspace: { id: 'wsp-1', name: 'ci', created_at: '2026-09-01T00:00:00.000Z' },
        key: null,
      }),
    );
    const who = await client.account.whoami();
    expect(who.workspace).toEqual({
      id: 'wsp-1',
      name: 'ci',
      createdAt: '2026-09-01T00:00:00.000Z',
    });
    expect(who.key).toBeNull();
    expect(who.account).toMatchObject({ name: null, status: 'suspended' });
    expect(who.role).toBe('viewer');
  });

  it.each([
    ['no user', { ...WHOAMI, user: undefined }],
    ['a user with no id', { ...WHOAMI, user: { email: 'x@example.com' } }],
    ['no role', { ...WHOAMI, role: '' }],
    ['a workspace with no id', { ...WHOAMI, workspace: { name: 'ci' } }],
    [
      'a key that cannot say whether it manages keys',
      { ...WHOAMI, key: { ...API_KEY, manage_keys: 'yes' } },
    ],
  ])('refuses an answer with %s', async (_what, body) => {
    const { client } = sdk(() => json(body));
    await expect(client.account.whoami()).rejects.toBeInstanceOf(MandalaError);
  });
});

describe('client.apiKeys', () => {
  it('lists keys, decoding each and never inventing a permission', async () => {
    const { rec, client } = sdk();
    const keys = await client.apiKeys.list();
    expect(rec.routes()).toEqual([['GET', 'api-keys']]);
    expect(keys).toEqual([
      {
        id: API_KEY.id,
        name: 'ci',
        prefix: API_KEY.prefix,
        createdAt: API_KEY.created_at,
        lastUsedAt: API_KEY.last_used_at,
        workspaceId: null,
        workspaceName: null,
        manageKeys: false,
        raw: API_KEY,
      },
    ]);
  });

  it('refuses a listing row without an id or a manage_keys boolean', async () => {
    for (const row of [
      { ...API_KEY, id: '' },
      { ...API_KEY, manage_keys: undefined },
    ]) {
      const { client } = sdk(() => json([row]));
      await expect(client.apiKeys.list()).rejects.toThrow(/API key 0/);
    }
  });

  it('mints with the name and workspace given, and never sends manage_keys', async () => {
    const { rec, client } = sdk();
    const created = await client.apiKeys.create({ name: 'ci', workspaceId: 'wsp-1' });
    expect(rec.routes()).toEqual([['POST', 'api-keys']]);
    expect(rec.last().body).toEqual({ name: 'ci', workspace_id: 'wsp-1' });
    expect(created.key).toBe(API_KEY_CREATED.raw);
    expect(created.id).toBe(API_KEY_CREATED.id);
    expect(created.manageKeys).toBe(false);
  });

  it('mints with an empty body when given nothing', async () => {
    const { rec, client } = sdk();
    await client.apiKeys.create();
    expect(rec.last().body).toEqual({});
  });

  it('refuses a mint answer that does not carry the key', async () => {
    const { raw: _raw, ...withoutKey } = API_KEY_CREATED;
    const { client } = sdk(() => json(withoutKey, { status: 201 }));
    await expect(client.apiKeys.create({ name: 'ci' })).rejects.toThrow(
      /answers it once, and it is not here/,
    );
  });

  it.each([
    [{ workspaceId: '' }, /workspaceId must be a workspace id/],
    [{ workspaceId: ' wsp-1' }, /workspaceId must be a workspace id/],
    [{ workspaceId: 7 }, /workspaceId/],
    [{ name: 7 }, /name/],
  ])('refuses %j before sending anything', async (args, message) => {
    const { rec, client } = sdk();
    await expect(client.apiKeys.create(args as never)).rejects.toThrow(message);
    await expect(client.apiKeys.create(args as never)).rejects.toBeInstanceOf(ValidationError);
    expect(rec.calls).toEqual([]);
  });

  it('revokes by id, and refuses an empty one before sending', async () => {
    const { rec, client } = sdk();
    await client.apiKeys.revoke('key-a1b2c3d4e5f6');
    expect(rec.routes()).toEqual([['DELETE', 'api-keys/key-a1b2c3d4e5f6']]);
    await expect(client.apiKeys.revoke('')).rejects.toBeInstanceOf(ValidationError);
    expect(rec.calls).toHaveLength(1);
  });

  it("surfaces the platform's 403 sentence as a PermissionDeniedError", async () => {
    const { client } = sdk(() => json({ error: NO_PERMISSION, request_id: 'r1' }, { status: 403 }));
    const error = await client.apiKeys.list().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PermissionDeniedError);
    expect((error as PermissionDeniedError).message).toContain(NO_PERMISSION);
  });

  it('reads a key out of reach as not found', async () => {
    const { client } = sdk(() => json({ error: 'API key not found' }, { status: 404 }));
    await expect(client.apiKeys.revoke('key-000000000009')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('does not retry a mint answered 503', async () => {
    const rec = recorder(() => json({ error: 'busy' }, { status: 503 }));
    const client = new Client({
      apiKey: 'com_test',
      baseUrl: BASE,
      fetch: rec.fetch,
      retries: { idempotent: 3 },
    });
    await expect(client.apiKeys.create({ name: 'ci' })).rejects.toThrow();
    expect(rec.calls).toHaveLength(1);
  });
});

// --- the CLI ------------------------------------------------------------------

function cli(respond: Responder = anyRoute, environment: NodeJS.ProcessEnv = {}) {
  const rec = recorder(respond);
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let clients = 0;
  const io: Partial<CliIO> = {
    stdin: Object.assign(Readable.from([]), { isTTY: true }),
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
    env: { MANDALA_API_KEY: 'com_cli_test', ...environment },
    createClient: () => {
      clients++;
      return new Client({ apiKey: 'com_cli_test', baseUrl: BASE, fetch: rec.fetch });
    },
    now: () => new Date('2026-01-02T03:04:05.000Z'),
  };
  return {
    rec,
    clients: () => clients,
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

describe('mandala whoami', () => {
  it('prints who the credential is', async () => {
    const h = cli();
    const r = await h.run(['whoami']);
    expect(r.code).toBe(0);
    expect(h.rec.routes()).toEqual([['GET', 'whoami']]);
    expect(r.out).toBe(
      [
        'Dana <dana@example.com> (usr-1)',
        'Account: Acme (acc-1), plan team, active',
        'Role: owner',
        'Scope: the whole account',
        'Key: laptop (key-000000000001, com_1a2b3c4d…); can manage API keys',
        '',
      ].join('\n'),
    );
  });

  it('answers the platform object under --json', async () => {
    const r = await cli().run(['whoami', '--json']);
    expect(r.json).toMatchObject({ command: 'whoami', ok: true, data: WHOAMI });
  });

  it('says so when the account is suspended', async () => {
    const h = cli(() =>
      json({
        ...WHOAMI,
        account: { ...WHOAMI.account, status: 'suspended' },
        workspace: { id: 'wsp-1', name: 'ci', created_at: 'x' },
      }),
    );
    const r = await h.run(['whoami']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Scope: workspace ci (wsp-1)');
    expect(r.err).toContain('this account is suspended');
  });
});

describe('mandala api-keys', () => {
  it('lists keys one to a line', async () => {
    const r = await cli().run(['api-keys', 'list']);
    expect(r.code).toBe(0);
    expect(r.out).toBe(
      `${API_KEY.id}  ci  ${API_KEY.prefix}  account-wide  -  last used ${API_KEY.last_used_at}\n`,
    );
  });

  it('lists the platform objects under --json', async () => {
    const r = await cli().run(['api-keys', 'list', '--json']);
    expect(r.json.data).toEqual([API_KEY]);
  });

  it('prints only the new key on stdout, and the warning on stderr', async () => {
    const h = cli();
    const r = await h.run(['api-keys', 'create', '--name', 'ci', '--workspace', 'wsp-1']);
    expect(r.code).toBe(0);
    expect(h.rec.last().body).toEqual({ name: 'ci', workspace_id: 'wsp-1' });
    expect(r.out).toBe(`${API_KEY_CREATED.raw}\n`);
    expect(r.err).toContain(`Created ${API_KEY_CREATED.id} (ci, account-wide)`);
    expect(r.err).toContain('shown once');
  });

  it('answers the key once under --json, as the platform names it', async () => {
    const r = await cli().run(['api-keys', 'create', '--json']);
    expect(r.json.data).toEqual(API_KEY_CREATED);
  });

  it('revokes by id', async () => {
    const h = cli();
    const r = await h.run(['api-keys', 'revoke', 'key-a1b2c3d4e5f6', '--json']);
    expect(h.rec.routes()).toEqual([['DELETE', 'api-keys/key-a1b2c3d4e5f6']]);
    expect(r.json.data).toEqual({ id: 'key-a1b2c3d4e5f6', revoked: true });
  });

  it.each([
    [['api-keys', 'list']],
    [['api-keys', 'create', '--name', 'ci']],
    [['api-keys', 'revoke', 'key-a1b2c3d4e5f6']],
  ])("prints the platform's sentence when %j lacks the permission", async (args) => {
    const h = cli(() => json({ error: NO_PERMISSION, request_id: 'r1' }, { status: 403 }));
    const r = await h.run(args);
    expect(r.code).toBe(1);
    expect(r.out).toBe('');
    expect(r.err).toBe(`mandala: ${NO_PERMISSION}\n`);
    const j = await h.run([...args, '--json']);
    expect(j.json).toMatchObject({
      ok: false,
      error: { code: 'permission_denied', status: 403, message: NO_PERMISSION },
    });
  });

  it('prints the escalation refusal as it came', async () => {
    const h = cli(() => json({ error: NO_ESCALATION }, { status: 403 }));
    const r = await h.run(['api-keys', 'create']);
    expect(r.err).toBe(`mandala: ${NO_ESCALATION}\n`);
  });

  it('refuses revoke without an id before any request', async () => {
    const h = cli();
    const r = await h.run(['api-keys', 'revoke']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('missing <id>');
    expect(h.rec.calls).toEqual([]);
  });
});

describe('mandala --version', () => {
  it.each([[['--version']], [['version']]])('%j prints the package version', async (args) => {
    const h = cli();
    const r = await h.run(args);
    expect(r.code).toBe(0);
    expect(r.out).toBe(`mandala ${VERSION}\n`);
    expect(h.clients()).toBe(0);
  });

  it('answers JSON with --json on either side', async () => {
    for (const args of [
      ['--version', '--json'],
      ['--json', '--version'],
    ]) {
      const r = await cli().run(args);
      expect(r.json).toMatchObject({ ok: true, data: { name: 'mandala', version: VERSION } });
    }
  });

  it("leaves templates get's own --version alone", () => {
    const parsed = parseArgs(['templates', 'get', 'acc-1', 'base', '--version', '3']);
    expect(parsed.path).toBe('templates get');
    expect(parsed.flags.version).toBe('3');
  });
});

// --- logout -------------------------------------------------------------------

const profile = (key: string, id: string): CredentialProfile => ({
  api_key: key,
  base_url: 'https://app.mandala.computer/api/v1',
  key_id: id,
  account: { id: 'acc-1', name: 'Acme' },
  scope: { type: 'account' },
});

describe('logout', () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(join(os.tmpdir(), 'mandala-logout-'));
    vi.spyOn(os, 'homedir').mockReturnValue(home);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const store = () => join(home, '.mandala', 'credentials.json');

  it('removes the default profile, and the file with the last one', async () => {
    await saveCredentials(profile('com_one', 'key-000000000001'));
    const h = cli(anyRoute, { MANDALA_API_KEY: '' });
    const r = await h.run(['logout']);
    expect(r.code).toBe(0);
    expect(r.out).toBe('');
    expect(r.err).toContain('Removed profile default');
    expect(r.err).toContain('Its key key-000000000001 still works until it is revoked');
    expect(r.err).not.toContain('MANDALA_API_KEY');
    expect(fs.existsSync(store())).toBe(false);
    expect(fs.existsSync(join(home, '.mandala', '.credentials.lock'))).toBe(false);
    expect(h.clients()).toBe(0);
    expect(h.rec.calls).toEqual([]);
  });

  it('removes only the named profile, keeping the default', async () => {
    await saveCredentials(profile('com_one', 'key-000000000001'), 'home');
    await saveCredentials(profile('com_two', 'key-000000000002'), 'work');
    const r = await cli().run(['logout', '--profile', 'work', '--json']);
    expect(r.json.data).toEqual({
      profile: 'work',
      removed: true,
      path: store(),
      key_id: 'key-000000000002',
      default_profile: 'home',
    });
    expect(Object.keys(readCredentials()!.profiles)).toEqual(['home']);
    expect(fs.statSync(store()).mode & 0o777).toBe(0o600);
  });

  it('names the new default when the default is removed and others remain', async () => {
    await saveCredentials(profile('com_one', 'key-000000000001'), 'main');
    await saveCredentials(profile('com_two', 'key-000000000002'), 'zeta');
    await saveCredentials(profile('com_three', 'key-000000000003'), 'alpha');
    const r = await cli().run(['logout']);
    expect(r.code).toBe(0);
    expect(r.err).toContain('The default profile is alpha.');
    expect(readCredentials()).toMatchObject({ default_profile: 'alpha' });
    expect(Object.keys(readCredentials()!.profiles).sort()).toEqual(['alpha', 'zeta']);
  });

  it('follows MANDALA_PROFILE, as every other command does', async () => {
    await saveCredentials(profile('com_one', 'key-000000000001'), 'home');
    await saveCredentials(profile('com_two', 'key-000000000002'), 'work');
    await cli(anyRoute, { MANDALA_PROFILE: 'work' }).run(['logout']);
    expect(Object.keys(readCredentials()!.profiles)).toEqual(['home']);
  });

  it('warns that an API key in the environment still authenticates', async () => {
    await saveCredentials(profile('com_one', 'key-000000000001'));
    const r = await cli().run(['logout']);
    expect(r.err).toContain('MANDALA_API_KEY is set in this environment');
  });

  it('refuses a profile that is not saved, and writes nothing', async () => {
    const none = await cli().run(['logout', '--json']);
    expect(none.code).toBe(1);
    expect(none.json.error).toMatchObject({ code: 'not_logged_in' });
    expect(fs.existsSync(store())).toBe(false);
    // Nothing to remove creates nothing either: no ~/.mandala appears.
    expect(fs.existsSync(join(home, '.mandala'))).toBe(false);
    await expect(removeCredentials('work')).resolves.toEqual({
      profile: 'work',
      removed: false,
      path: store(),
      defaultProfile: null,
    });
    expect(fs.existsSync(join(home, '.mandala'))).toBe(false);

    await saveCredentials(profile('com_one', 'key-000000000001'), 'home');
    const before = fs.readFileSync(store());
    const r = await cli().run(['logout', '--profile', 'work']);
    expect(r.code).toBe(1);
    expect(r.err).toContain(
      'No saved profile named work; nothing was removed. The default profile is home.',
    );
    expect(fs.readFileSync(store())).toEqual(before);
  });

  it('refuses an invalid profile name before touching the store', async () => {
    await expect(removeCredentials('../x')).rejects.toMatchObject({ code: 'invalid_profile' });
  });
});
