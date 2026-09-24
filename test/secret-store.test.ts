/** The account's secret store and its CLI (OPL-4984, OPL-5026). */

import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import type { CliIO } from '../src/cli-runtime.js';
import {
  Client,
  ConflictError,
  isTransient,
  MandalaError,
  PermissionDeniedError,
  ValidationError,
} from '../src/index.js';
import { patternFor } from './allowlist.js';
import { BASE, type Call, json, type Responder, recorder, SECRET, SECRET_LIST } from './harness.js';

const ID = SECRET.id;
const REV = SECRET.revision_id;
const REV2 = 'csr-ffffffffffffffffffffffff';
const VALUE = 'sk-live-do-not-print-me';

const client = (respond: Responder) => {
  const rec = recorder(respond);
  return { rec, client: new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch }) };
};

describe('the secret store', () => {
  it('lists one scope, and names the workspace only when asked', async () => {
    const { rec, client: c } = client(() => json(SECRET_LIST));
    const list = await c.secrets.list();
    await c.secrets.list({ workspaceId: 'ws-1' });
    expect(rec.calls.map((x) => [x.method, x.path, x.query])).toEqual([
      ['GET', '/secrets', {}],
      ['GET', '/secrets', { workspace_id: 'ws-1' }],
    ]);
    expect(list.delivery).toBe(true);
    expect(list.limits).toEqual({
      nameMaxChars: 60,
      valueMaxBytes: 4096,
      activePerAccount: 100,
      createdPerAccount: 1000,
    });
    expect(list.secrets[0]).toMatchObject({
      id: ID,
      name: 'OPENAI_API_KEY',
      workspaceId: null,
      revisionId: REV,
      lastUsedAt: null,
    });
    expect(list.secrets[0]).not.toHaveProperty('value');
  });

  it('refuses a listing it cannot act on rather than reading it as empty', async () => {
    for (const bad of [
      [],
      { secrets: [] },
      { secrets: [], delivery: 'yes', limits: SECRET_LIST.limits },
      { ...SECRET_LIST, secrets: [{ ...SECRET, revision_id: '' }] },
      { ...SECRET_LIST, secrets: [{ ...SECRET, id: undefined }] },
      { ...SECRET_LIST, limits: {} },
    ]) {
      const { client: c } = client(() => json(bad));
      await expect(c.secrets.list()).rejects.toBeInstanceOf(MandalaError);
    }
  });

  it('creates, reads, replaces and deletes in the wire spelling', async () => {
    const { rec, client: c } = client((call) =>
      json(call.method === 'DELETE' ? { ok: true } : SECRET, {
        status: call.method === 'POST' ? 201 : 200,
      }),
    );
    const made = await c.secrets.create({ name: '  OPENAI_API_KEY ', value: VALUE });
    await c.secrets.get(made.id);
    await c.secrets.replace(made.id, { value: VALUE, revisionId: made.revisionId });
    await c.secrets.delete(made.id, { revisionId: made.revisionId, workspaceId: 'ws-1' });
    expect(rec.calls.map((x) => [x.method, x.path, x.query, x.body])).toEqual([
      ['POST', '/secrets', {}, { name: 'OPENAI_API_KEY', value: VALUE }],
      ['GET', `/secrets/${ID}`, {}, undefined],
      ['PUT', `/secrets/${ID}`, {}, { value: VALUE, revision_id: REV }],
      ['DELETE', `/secrets/${ID}`, { revision_id: REV, workspace_id: 'ws-1' }, undefined],
    ]);
  });

  it('requires the revision on a delete, and never sends one that is malformed', async () => {
    const { rec, client: c } = client(() => json({ ok: true }));
    await expect(c.secrets.delete(ID, undefined as any)).rejects.toBeInstanceOf(ValidationError);
    await expect(c.secrets.delete(ID, {} as any)).rejects.toBeInstanceOf(ValidationError);
    await expect(c.secrets.delete(ID, { revisionId: 'csr-1' })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(rec.calls).toEqual([]);
  });

  it('refuses what the platform would refuse, without ever quoting the value', async () => {
    const { rec, client: c } = client(() => json(SECRET));
    const refusals = [
      c.secrets.create({ name: '', value: VALUE }),
      c.secrets.create({ name: 'x'.repeat(61), value: VALUE }),
      c.secrets.create({ name: 'bad\u0007name', value: VALUE }),
      c.secrets.create({ name: 'OK', value: '' }),
      c.secrets.create({ name: 'OK', value: `${VALUE}${'x'.repeat(4096)}` }),
      c.secrets.create({ name: 'OK', value: `${VALUE}\ud800` }),
      c.secrets.create({ name: 'OK', value: VALUE, workspaceId: '' }),
      c.secrets.replace(ID, { value: VALUE, revisionId: 'nope' }),
      c.secrets.list({ workspaceId: ' ws-1' }),
    ];
    for (const refusal of refusals) {
      const err = await refusal.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ValidationError);
      expect(String((err as Error).message)).not.toContain(VALUE);
    }
    // A multi-byte value is measured in bytes, not characters.
    await expect(c.secrets.create({ name: 'OK', value: 'é'.repeat(2049) })).rejects.toThrow(
      /4098 bytes/,
    );
    expect(rec.calls).toEqual([]);
  });

  it('reduces the store routes without disturbing a computer’s bindings', () => {
    expect(patternFor(`secrets/${ID}`)).toBe('secrets/:id');
    expect(patternFor('secrets')).toBe('secrets');
    expect(patternFor('computers/vm-1/secrets')).toBe('computers/:id/secrets');
  });

  it('never replays a write answered 503, and does replay a read', async () => {
    let n = 0;
    const rec = recorder(() => {
      n++;
      return json({ error: 'the store could not answer' }, { status: 503 });
    });
    const c = new Client({
      apiKey: 'com_test',
      baseUrl: BASE,
      fetch: rec.fetch,
      retries: { idempotent: 2 },
    });
    const write = await c.secrets
      .replace(ID, { value: VALUE, revisionId: REV })
      .catch((e: unknown) => e);
    expect(n).toBe(1);
    // The outcome of a change answered 503 is unknown, so it is not transient.
    expect(isTransient(write)).toBe(false);
    n = 0;
    const read = await c.secrets.get(ID).catch((e: unknown) => e);
    expect(n).toBe(3);
    expect(isTransient(read)).toBe(true);
  });
});

// --- the CLI ----------------------------------------------------------------

type Store = { rows: (typeof SECRET)[] };

/** A small in-memory store that answers the way the platform does. */
const storeRoutes =
  (store: Store, opts: { conflictOnce?: boolean } = {}): Responder =>
  (call: Call) => {
    let conflict = opts.conflictOnce ?? false;
    const inner = (): Response => {
      if (call.path === '/secrets' && call.method === 'GET')
        return json({ ...SECRET_LIST, secrets: store.rows });
      if (call.path === '/secrets' && call.method === 'POST') {
        const body = call.body as { name: string };
        const row = { ...SECRET, id: 'csec-00000000000000aa', name: body.name, revision_id: REV };
        store.rows.push(row);
        return json(row, { status: 201 });
      }
      const row = store.rows.find((r) => call.path === `/secrets/${r.id}`);
      if (!row) return json({ error: 'No such secret.' }, { status: 404 });
      const sent =
        call.method === 'PUT'
          ? (call.body as { revision_id: string }).revision_id
          : call.query.revision_id;
      if (conflict || sent !== row.revision_id) {
        conflict = false;
        opts.conflictOnce = false;
        row.revision_id = REV2;
        return json(
          { error: 'This secret changed since you read it. Load it again and retry.' },
          { status: 409 },
        );
      }
      if (call.method === 'DELETE') {
        store.rows = store.rows.filter((r) => r !== row);
        return json({ ok: true });
      }
      row.revision_id = row.revision_id === REV ? REV2 : REV;
      return json(row);
    };
    return inner();
  };

async function cli(args: string[], respond: Responder, stdin: string | null) {
  const rec = recorder(respond);
  let out = '';
  let err = '';
  const io: Partial<CliIO> = {
    env: { MANDALA_API_KEY: 'com_cli_test' },
    stdin:
      stdin === null
        ? Object.assign(Readable.from([]), { isTTY: true })
        : Object.assign(Readable.from([Buffer.from(stdin)]), { isTTY: false }),
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
    createClient: () => new Client({ apiKey: 'com_cli_test', baseUrl: BASE, fetch: rec.fetch }),
    now: () => new Date('2026-09-16T00:00:00Z'),
  };
  const code = await main(args, io);
  return { code, out, err, rec };
}

describe('mandala secrets', () => {
  it('lists names and revisions, never values', async () => {
    const store = { rows: [{ ...SECRET }] };
    const { code, out } = await cli(['secrets', 'list'], storeRoutes(store), null);
    expect(code).toBe(0);
    expect(out).toContain(`${ID}  OPENAI_API_KEY  ${REV}`);
    const json = await cli(
      ['secrets', 'list', '--json', '--workspace', 'ws-1'],
      storeRoutes(store),
      null,
    );
    expect(json.rec.calls[0]?.query).toEqual({ workspace_id: 'ws-1' });
    expect(JSON.parse(json.out).data.secrets[0].id).toBe(ID);
  });

  it('creates a new secret from stdin, less one trailing newline', async () => {
    const store: Store = { rows: [] };
    const { code, out, rec } = await cli(
      ['secrets', 'set', 'NEW_TOKEN'],
      storeRoutes(store),
      `${VALUE}\n`,
    );
    expect(code).toBe(0);
    expect(out).toMatch(/^created csec-00000000000000aa {2}NEW_TOKEN/);
    const post = rec.calls.find((x) => x.method === 'POST');
    expect(post?.body).toEqual({ name: 'NEW_TOKEN', value: VALUE });
    expect(out).not.toContain(VALUE);
  });

  it('replaces an existing one by name, case-folded as the platform folds it', async () => {
    const store = { rows: [{ ...SECRET }] };
    const { code, out, err, rec } = await cli(
      ['secrets', 'set', 'openai_api_key', '--json'],
      storeRoutes(store),
      VALUE,
    );
    expect(code).toBe(0);
    const put = rec.calls.find((x) => x.method === 'PUT');
    expect(put?.path).toBe(`/secrets/${ID}`);
    expect(put?.body).toEqual({ value: VALUE, revision_id: REV });
    expect(JSON.parse(out).data).toMatchObject({ id: ID, created: false, revision_id: REV2 });
    expect(out + err).not.toContain(VALUE);
    expect(rec.calls.some((x) => x.method === 'POST')).toBe(false);
  });

  it('reads the revision again when it moved underneath, and sends the fresh one', async () => {
    const store = { rows: [{ ...SECRET }] };
    const { code, rec } = await cli(
      ['secrets', 'set', 'OPENAI_API_KEY'],
      storeRoutes(store, { conflictOnce: true }),
      VALUE,
    );
    expect(code).toBe(0);
    const puts = rec.calls.filter((x) => x.method === 'PUT');
    expect(puts.map((x) => (x.body as { revision_id: string }).revision_id)).toEqual([REV, REV2]);
  });

  it('refuses a value on the command line, and an empty one', async () => {
    const store: Store = { rows: [] };
    const extra = await cli(['secrets', 'set', 'A', VALUE], storeRoutes(store), '');
    expect(extra.code).not.toBe(0);
    expect(extra.rec.calls).toEqual([]);
    const empty = await cli(['secrets', 'set', 'A'], storeRoutes(store), '\n');
    expect(empty.code).not.toBe(0);
    expect(empty.rec.calls.filter((x) => x.method !== 'GET')).toEqual([]);
  });

  it('will not prompt where it cannot hide what is typed', async () => {
    const { code, err, rec } = await cli(['secrets', 'set', 'A'], storeRoutes({ rows: [] }), null);
    expect(code).not.toBe(0);
    expect(err).toMatch(/pipe it on stdin/);
    expect(rec.calls).toEqual([]);
  });

  it('removes by name with the revision it read', async () => {
    const store = { rows: [{ ...SECRET }] };
    const { code, out, rec } = await cli(
      ['secrets', 'rm', 'OPENAI_API_KEY'],
      storeRoutes(store),
      null,
    );
    expect(code).toBe(0);
    expect(out).toContain(`deleted ${ID}`);
    const del = rec.calls.find((x) => x.method === 'DELETE');
    expect(del?.query).toEqual({ revision_id: REV });
    expect(store.rows).toEqual([]);
    const missing = await cli(['secrets', 'rm', 'NOPE'], storeRoutes(store), null);
    expect(missing.code).not.toBe(0);
  });

  it('does not retry a refusal that is not a revision conflict', async () => {
    const { code, rec } = await cli(
      ['secrets', 'rm', 'OPENAI_API_KEY'],
      (call) =>
        call.method === 'GET'
          ? json(SECRET_LIST)
          : json({ error: 'Owners only.' }, { status: 403 }),
      null,
    );
    expect(code).not.toBe(0);
    expect(rec.calls.filter((x) => x.method === 'DELETE')).toHaveLength(1);
    expect(new PermissionDeniedError('x', 403)).not.toBeInstanceOf(ConflictError);
  });
});
