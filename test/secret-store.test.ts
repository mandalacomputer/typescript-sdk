/** The account's secret store and its CLI (OPL-4984, OPL-5026). */

import { PassThrough, Readable } from 'node:stream';
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

/** A terminal that delivers these chunks, one read each, with raw mode recorded. */
const terminal = (chunks: Uint8Array[]) => {
  const modes: boolean[] = [];
  const stream = Object.assign(new PassThrough({ objectMode: true }), {
    isTTY: true,
    setRawMode: (mode: boolean) => modes.push(mode),
  });
  for (const c of chunks) stream.write(Buffer.from(c));
  return { stream, modes };
};

async function cli(
  args: string[],
  respond: Responder,
  stdin: string | Uint8Array | null | CliIO['stdin'],
) {
  const rec = recorder(respond);
  let out = '';
  let err = '';
  const io: Partial<CliIO> = {
    env: { MANDALA_API_KEY: 'com_cli_test' },
    stdin:
      stdin === null
        ? Object.assign(Readable.from([]), { isTTY: true })
        : typeof stdin === 'string' || stdin instanceof Uint8Array
          ? Object.assign(Readable.from([Buffer.from(stdin)]), { isTTY: false })
          : stdin,
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

describe('mandala secrets: which secret a word means', () => {
  // A name may legally spell another secret's id.
  const other = { ...SECRET, id: 'csec-00000000000000bb', name: 'OTHER' };
  const impostor = { ...SECRET, id: 'csec-00000000000000cc', name: other.id };

  it('set resolves by name only, never by id — with a matching name', async () => {
    const store = { rows: [{ ...other }, { ...impostor }] };
    const { code, rec } = await cli(['secrets', 'set', other.id], storeRoutes(store), VALUE);
    expect(code).toBe(0);
    const put = rec.calls.find((x) => x.method === 'PUT');
    expect(put?.path).toBe(`/secrets/${impostor.id}`);
    expect(rec.calls.some((x) => x.path === `/secrets/${other.id}`)).toBe(false);
  });

  it('set resolves by name only, never by id — without a matching name', async () => {
    const store = { rows: [{ ...other }] };
    const { code, rec } = await cli(['secrets', 'set', other.id], storeRoutes(store), VALUE);
    expect(code).toBe(0);
    // A new secret of that name, and the one whose id it spells is untouched.
    expect(rec.calls.find((x) => x.method === 'POST')?.body).toEqual({
      name: other.id,
      value: VALUE,
    });
    expect(rec.calls.some((x) => x.method === 'PUT')).toBe(false);
  });

  it('rm refuses a word that is one secret’s name and another’s id', async () => {
    const store = { rows: [{ ...other }, { ...impostor }] };
    const { code, err, out, rec } = await cli(
      ['secrets', 'rm', other.id, '--json'],
      storeRoutes(store),
      null,
    );
    expect(code).not.toBe(0);
    expect(out + err).toMatch(/ambiguous_secret/);
    expect(rec.calls.some((x) => x.method === 'DELETE')).toBe(false);
    expect(store.rows).toHaveLength(2);
  });

  it('rm accepts an id when no name collides, and a name', async () => {
    const byId = { rows: [{ ...other }] };
    const a = await cli(['secrets', 'rm', other.id], storeRoutes(byId), null);
    expect(a.code).toBe(0);
    expect(byId.rows).toEqual([]);
    const byName = { rows: [{ ...other }] };
    const b = await cli(['secrets', 'rm', 'other'], storeRoutes(byName), null);
    expect(b.code).toBe(0);
    expect(byName.rows).toEqual([]);
  });
});

describe('mandala secrets set: the value’s encoding', () => {
  const e = new TextEncoder().encode('é'); // two bytes

  // A leading U+FEFF is part of the value, not a byte-order mark to strip:
  // stripping it would store a different secret than the one given.
  const BOM = '\uFEFF';
  const bom = new TextEncoder().encode(`${BOM}test-token`);

  it('keeps a leading U+FEFF piped on stdin', async () => {
    const { code, rec } = await cli(['secrets', 'set', 'T'], storeRoutes({ rows: [] }), bom);
    expect(code).toBe(0);
    expect(rec.calls.find((x) => x.method === 'POST')?.body).toEqual({
      name: 'T',
      value: `${BOM}test-token`,
    });
  });

  it('keeps a leading U+FEFF typed at a terminal, whole or split across reads', async () => {
    for (const chunks of [[bom], [bom.slice(0, 1), bom.slice(1, 2), bom.slice(2)]]) {
      const { stream } = terminal([...chunks, new TextEncoder().encode('\r')]);
      const { code, rec } = await cli(['secrets', 'set', 'T'], storeRoutes({ rows: [] }), stream);
      expect(code).toBe(0);
      expect(rec.calls.find((x) => x.method === 'POST')?.body).toEqual({
        name: 'T',
        value: `${BOM}test-token`,
      });
    }
  });

  it('joins a multibyte character a terminal split across two reads', async () => {
    const store: Store = { rows: [] };
    const { stream, modes } = terminal([
      new TextEncoder().encode('caf'),
      e.slice(0, 1),
      e.slice(1),
      new TextEncoder().encode('\r'),
    ]);
    const { code, rec, out } = await cli(['secrets', 'set', 'T'], storeRoutes(store), stream);
    expect(code).toBe(0);
    expect(rec.calls.find((x) => x.method === 'POST')?.body).toEqual({ name: 'T', value: 'café' });
    expect(modes).toEqual([true, false]);
    expect(out).not.toContain('café');
  });

  it('refuses malformed UTF-8 at a terminal, before any request', async () => {
    const { stream, modes } = terminal([
      new Uint8Array([0x61, 0xff, 0x62]),
      new TextEncoder().encode('\r'),
    ]);
    const { code, rec, err, out } = await cli(
      ['secrets', 'set', 'T', '--json'],
      storeRoutes({ rows: [] }),
      stream,
    );
    expect(code).not.toBe(0);
    expect(out + err).toMatch(/invalid_input/);
    expect(rec.calls).toEqual([]);
    expect(modes).toEqual([true, false]);
  });

  it('refuses a character left half-typed at Enter', async () => {
    const { stream } = terminal([e.slice(0, 1), new TextEncoder().encode('\r')]);
    const { code, rec } = await cli(['secrets', 'set', 'T'], storeRoutes({ rows: [] }), stream);
    expect(code).not.toBe(0);
    expect(rec.calls).toEqual([]);
  });

  it('refuses malformed UTF-8 piped on stdin, before any request', async () => {
    for (const bytes of [new Uint8Array([0x61, 0xff]), e.slice(0, 1)]) {
      const { code, rec } = await cli(['secrets', 'set', 'T'], storeRoutes({ rows: [] }), bytes);
      expect(code).not.toBe(0);
      expect(rec.calls).toEqual([]);
    }
  });
});

describe('secret names, normalized as the platform normalizes them', () => {
  /**
   * A store that trims a name before keeping it and matches names ignoring
   * ASCII case, as the platform does (normalizeCustomerSecretName, and NOCASE).
   * A client that looked up the untrimmed name would miss the first row and
   * create a second secret.
   */
  const trimmingStore = (): Responder => {
    const rows: (typeof SECRET)[] = [];
    return (call: Call) => {
      if (call.path === '/secrets' && call.method === 'GET')
        return json({ ...SECRET_LIST, secrets: rows });
      if (call.path === '/secrets' && call.method === 'POST') {
        const name = String((call.body as { name: unknown }).name).trim();
        if (rows.some((r) => r.name.toLowerCase() === name.toLowerCase()))
          return json(
            { error: 'A secret with this name already exists in this scope.' },
            { status: 409 },
          );
        const row = { ...SECRET, name };
        rows.push(row);
        return json(row, { status: 201 });
      }
      const row = rows.find((r) => call.path === `/secrets/${r.id}`);
      if (!row) return json({ error: 'No such secret.' }, { status: 404 });
      row.revision_id = REV2;
      return json(row);
    };
  };

  it('sets a padded name twice as one create and then one replace', async () => {
    const store = trimmingStore();
    const first = await cli(['secrets', 'set', ' TOKEN '], store, VALUE);
    const second = await cli(['secrets', 'set', '  token\t'], store, VALUE);
    expect([first.code, second.code]).toEqual([0, 0]);
    const writes = [...first.rec.calls, ...second.rec.calls].filter((x) => x.method !== 'GET');
    expect(writes.map((x) => [x.method, x.path, x.body])).toEqual([
      ['POST', '/secrets', { name: 'TOKEN', value: VALUE }],
      ['PUT', `/secrets/${ID}`, { value: VALUE, revision_id: REV }],
    ]);
  });

  it('creates through the SDK under the trimmed name', async () => {
    const { rec, client: c } = client(trimmingStore());
    await c.secrets.create({ name: ' X ', value: VALUE });
    expect(rec.calls.at(-1)?.body).toEqual({ name: 'X', value: VALUE });
  });
});

describe('no failure of the secret store carries the value', () => {
  const failing = (fetch: typeof globalThis.fetch) =>
    new Client({ apiKey: 'com_test', baseUrl: BASE, fetch });
  const offline = failing(async () => {
    throw new TypeError('fetch failed');
  });
  const html500 = failing(
    async () => new Response('<html><body>oops</body></html>', { status: 500 }),
  );

  const cases: [string, () => Promise<unknown>][] = [
    ['a lone surrogate', () => offline.secrets.create({ name: 'A', value: `${VALUE}\ud800` })],
    [
      'a value over 4096 bytes',
      () => offline.secrets.create({ name: 'A', value: `${VALUE}${'x'.repeat(5000)}` }),
    ],
    [
      'a boxed String',
      () => offline.secrets.create({ name: 'A', value: new String(VALUE) as unknown as string }),
    ],
    ['a bad revision', () => offline.secrets.replace(ID, { value: VALUE, revisionId: 'bad' })],
    ['a fetch that throws', () => offline.secrets.create({ name: 'A', value: VALUE })],
    [
      'a fetch that throws, on a replace',
      () => offline.secrets.replace(ID, { value: VALUE, revisionId: REV }),
    ],
    ['an HTML 500', () => html500.secrets.create({ name: 'A', value: VALUE })],
    [
      'an HTML 500, on a replace',
      () => html500.secrets.replace(ID, { value: VALUE, revisionId: REV }),
    ],
  ];

  for (const [what, call] of cases) {
    it(`on ${what}`, async () => {
      const err = await call().then(
        () => {
          throw new Error('expected a failure');
        },
        (e: unknown) => e as Error,
      );
      expect(err).toBeInstanceOf(Error);
      for (const text of [err.message, String(err.stack), JSON.stringify(err), String(err)]) {
        expect(text).not.toContain(VALUE);
      }
    });
  }
});

describe('secrets.set: create or replace by name (OPL-5048)', () => {
  it('creates a name the scope does not hold, under the trimmed name', async () => {
    const store: Store = { rows: [] };
    const { rec, client: c } = client(storeRoutes(store));
    const made = await c.secrets.set({ name: '  GITHUB_TOKEN ', value: VALUE });
    expect(made.name).toBe('GITHUB_TOKEN');
    expect(rec.calls.map((x) => [x.method, x.path, x.body])).toEqual([
      ['GET', '/secrets', undefined],
      ['POST', '/secrets', { name: 'GITHUB_TOKEN', value: VALUE }],
    ]);
  });

  it('replaces the one it holds, matched ignoring ASCII case, with the revision it read', async () => {
    const store: Store = { rows: [{ ...SECRET }] };
    const { rec, client: c } = client(storeRoutes(store));
    await c.secrets.set({ name: 'openai_api_key', value: VALUE, workspaceId: 'ws-1' });
    expect(rec.calls.map((x) => [x.method, x.path, x.query, x.body])).toEqual([
      ['GET', '/secrets', { workspace_id: 'ws-1' }, undefined],
      ['PUT', `/secrets/${ID}`, {}, { value: VALUE, revision_id: REV, workspace_id: 'ws-1' }],
    ]);
  });

  it('reads again when the revision moved underneath, and sends the fresh one', async () => {
    const store: Store = { rows: [{ ...SECRET }] };
    const { rec, client: c } = client(storeRoutes(store, { conflictOnce: true }));
    await c.secrets.set({ name: 'OPENAI_API_KEY', value: VALUE });
    expect(
      rec.calls.map((x) => [x.method, (x.body as { revision_id?: string })?.revision_id]),
    ).toEqual([
      ['GET', undefined],
      ['PUT', REV],
      ['GET', undefined],
      ['PUT', REV2],
    ]);
  });

  it('gives up after three reads again, with the conflict', async () => {
    const { rec, client: c } = client((call) =>
      call.method === 'GET'
        ? json(SECRET_LIST)
        : json({ error: 'This secret changed since you read it.' }, { status: 409 }),
    );
    await expect(c.secrets.set({ name: 'OPENAI_API_KEY', value: VALUE })).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(rec.calls.filter((x) => x.method === 'PUT')).toHaveLength(4);
  });

  it('never sends a write again after a 503, whose outcome is unknown', async () => {
    const { rec, client: c } = client((call) =>
      call.method === 'GET'
        ? json({ ...SECRET_LIST, secrets: [] })
        : json({ error: 'the store could not answer' }, { status: 503 }),
    );
    await expect(c.secrets.set({ name: 'NEW_ONE', value: VALUE })).rejects.toBeInstanceOf(
      MandalaError,
    );
    expect(rec.calls.filter((x) => x.method === 'POST')).toHaveLength(1);
  });

  it('refuses what the platform would refuse before reading anything', async () => {
    const { rec, client: c } = client(() => json(SECRET_LIST));
    await expect(c.secrets.set({ name: 'X', value: '' })).rejects.toBeInstanceOf(ValidationError);
    await expect(c.secrets.set({ name: ' ', value: VALUE })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(rec.calls).toEqual([]);
  });
});
