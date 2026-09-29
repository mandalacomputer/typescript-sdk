/**
 * `Idempotency-Key` on every lifecycle call (platform OPL-5127): what is sent,
 * how often a key is made, what an unknown outcome carries, and the operations
 * filter that finds a call whose answer was lost.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { errorForStatus } from '../src/errors.js';
import {
  APIError,
  Client,
  type Computer,
  ConflictError,
  IDEMPOTENCY_KEY_HEADER,
  isTransient,
  ValidationError,
} from '../src/index.js';
import {
  anyRoute,
  BASE,
  type Call,
  COMPUTER,
  json,
  OPERATION,
  type Responder,
  recorder,
} from './harness.js';

function sdk(respond: Responder = anyRoute, timeoutMs?: number) {
  const rec = recorder(respond);
  return {
    rec,
    client: new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch, timeoutMs }),
  };
}

const KEY_SYNTAX = /^[\x21-\x7e]{1,255}$/;
const keyOf = (call: Call): string | undefined => call.headers[IDEMPOTENCY_KEY_HEADER];

/** Every lifecycle call this SDK makes, once each, on a fresh computer handle. */
const LIFECYCLE: [string, (client: Client, vm: Computer, key?: string) => Promise<unknown>][] = [
  ['create', (c, _vm, k) => c.computers.create({ template: 'base' }, { idempotencyKey: k })],
  ['start', (_c, vm, k) => vm.start({ idempotencyKey: k })],
  ['stop', (_c, vm, k) => vm.stop({ idempotencyKey: k })],
  ['suspend', (_c, vm, k) => vm.suspend({ idempotencyKey: k })],
  ['restart', (_c, vm, k) => vm.restart({ idempotencyKey: k })],
  ['clone', (_c, vm, k) => vm.clone('copy', { idempotencyKey: k })],
  ['update', (_c, vm, k) => vm.update({ ramMb: 4096 }, { idempotencyKey: k })],
  ['rename', (_c, vm, k) => vm.rename('renamed', { idempotencyKey: k })],
  ['ephemeral', (c, _vm, k) => c.computers.ephemeral({ template: 'base' }, { idempotencyKey: k })],
  ['relocate', (_c, vm, k) => vm.relocate({ ramMb: 32768 }, { idempotencyKey: k })],
  ['delete', (_c, vm, k) => vm.delete({ idempotencyKey: k })],
  ['snapshots.restore', (c, _vm, k) => c.snapshots.restore('snap-1', { idempotencyKey: k })],
  ['snapshots.clone', (c, _vm, k) => c.snapshots.clone('snap-1', 'copy', { idempotencyKey: k })],
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a lifecycle call', () => {
  it.each(LIFECYCLE)('%s sends an Idempotency-Key the platform accepts', async (_, run) => {
    const { rec, client } = sdk();
    const vm = await client.computers.get('vm-1');
    const before = rec.calls.length;
    await run(client, vm);
    const sent = rec.calls.slice(before).filter((c) => c.method !== 'GET');
    expect(sent).toHaveLength(1);
    expect(sent.map(keyOf)[0]).toMatch(KEY_SYNTAX);
  });

  it.each(LIFECYCLE)('%s sends a caller’s own key verbatim', async (_, run) => {
    const { rec, client } = sdk();
    const vm = await client.computers.get('vm-1');
    await run(client, vm, 'order-4711:create');
    const sent = rec.calls.filter((c) => c.method !== 'GET');
    expect(sent.map(keyOf)).toEqual(['order-4711:create']);
  });

  it('launch sends a caller’s key on its create only', async () => {
    // A launch resent after its answer was lost must not create a second
    // computer; the start it makes afterwards is a different call.
    const { rec, client } = sdk((call) =>
      call.method === 'POST' && call.path === '/computers'
        ? json({ ...COMPUTER, status: 'stopped', running_ram_mb: 0 })
        : anyRoute(call),
    );
    await client.computers.launch({ template: 'base' }, { idempotencyKey: 'order-4711:launch' });
    const posts = rec.calls.filter((c) => c.method === 'POST');
    expect(posts[0]!.path).toBe('/computers');
    expect(keyOf(posts[0]!)).toBe('order-4711:launch');
    const start = posts.find((c) => c.path === '/computers/vm-1/start');
    expect(start).toBeDefined();
    expect(keyOf(start!)).toMatch(KEY_SYNTAX);
    expect(keyOf(start!)).not.toBe('order-4711:launch');
  });

  it('ephemeral with a callback sends a caller’s key on its create', async () => {
    const { rec, client } = sdk();
    await client.computers.ephemeral({ template: 'base' }, async () => undefined, {
      idempotencyKey: 'order-4711:scratch',
    });
    const create = rec.calls.find((c) => c.method === 'POST' && c.path === '/computers');
    expect(keyOf(create!)).toBe('order-4711:scratch');
  });

  it('sends a different key on each call', async () => {
    const { rec, client } = sdk();
    const vm = await client.computers.get('vm-1');
    await vm.start();
    await vm.start();
    const keys = rec.calls.filter((c) => c.method === 'POST').map(keyOf);
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('never sends one on a read', async () => {
    const { rec, client } = sdk();
    await client.computers.get('vm-1');
    await client.operations.list();
    expect(rec.calls.map(keyOf)).toEqual([undefined, undefined]);
  });

  it('makes its key once per call, before the first attempt', async () => {
    const spy = vi.spyOn(globalThis.crypto, 'randomUUID');
    const { client } = sdk();
    const vm = await client.computers.get('vm-1');
    await vm.start();
    expect(spy).toHaveBeenCalledTimes(1);
    await client.computers.create({ template: 'base' });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['empty', ''],
    ['256 characters', 'k'.repeat(256)],
    ['a space', 'a b'],
    ['a newline', 'a\nb'],
    ['non-ASCII', 'café'],
  ])('refuses a key that is %s before sending anything', async (_, key) => {
    const { rec, client } = sdk();
    const vm = await client.computers.get('vm-1');
    await expect(vm.start({ idempotencyKey: key })).rejects.toThrow(ValidationError);
    await expect(client.computers.create({}, { idempotencyKey: key })).rejects.toThrow(
      ValidationError,
    );
    expect(rec.calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });
});

describe('an unknown outcome', () => {
  it('carries the key on a 5xx', async () => {
    const { client } = sdk((call) =>
      call.method === 'GET'
        ? anyRoute(call)
        : json({ error: 'No hypervisor could answer that right now.' }, { status: 503 }),
    );
    const vm = await client.computers.get('vm-1');
    const err = await vm.start({ idempotencyKey: 'k-503' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(APIError);
    expect((err as APIError).idempotencyKey).toBe('k-503');
  });

  it('carries the key the SDK made when the caller gave none', async () => {
    const { rec, client } = sdk((call) =>
      call.method === 'GET' ? anyRoute(call) : json({ error: 'boom' }, { status: 500 }),
    );
    const vm = await client.computers.get('vm-1');
    const err = (await vm.stop().catch((e: unknown) => e)) as APIError;
    expect(err.idempotencyKey).toBe(keyOf(rec.last()));
    expect(err.idempotencyKey).toMatch(KEY_SYNTAX);
  });

  it('carries the key on a timeout, which may have been received', async () => {
    const { client } = sdk(
      (call) => (call.method === 'GET' ? anyRoute(call) : new Promise<Response>(() => {})),
      50,
    );
    const vm = await client.computers.get('vm-1');
    const err = await vm.restart({ idempotencyKey: 'k-timeout' }).catch((e: unknown) => e);
    expect((err as { idempotencyKey?: string }).idempotencyKey).toBe('k-timeout');
  });

  it.each([
    ['idempotency_in_progress', { reason: 'contention' }],
    ['idempotency_outcome_unknown', {}],
  ])('carries the key on the platform’s 409 %s', async (code, extra) => {
    const { client } = sdk((call) =>
      call.method === 'GET'
        ? anyRoute(call)
        : json({ error: 'x', code, ...extra, operation_id: OPERATION.id }, { status: 409 }),
    );
    const vm = await client.computers.get('vm-1');
    const err = (await vm
      .suspend({ idempotencyKey: 'k-409' })
      .catch((e: unknown) => e)) as APIError;
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.idempotencyKey).toBe('k-409');
    // The body's code and operation, as fields rather than only on err.body.
    expect(err.code).toBe(code);
    expect(err.operationId).toBe(OPERATION.id);
  });

  it('names the operation a 5xx answer to a keyed call reserved', async () => {
    const { client } = sdk((call) =>
      call.method === 'GET'
        ? anyRoute(call)
        : json({ error: 'upstream failed', operation_id: OPERATION.id }, { status: 502 }),
    );
    const vm = await client.computers.get('vm-1');
    const err = (await vm.start({ idempotencyKey: 'k-502' }).catch((e: unknown) => e)) as APIError;
    expect(err.operationId).toBe(OPERATION.id);
    expect(err.code).toBeUndefined();
  });

  it('does not put the key on a refusal that released it', async () => {
    const { client } = sdk((call) =>
      call.method === 'GET'
        ? anyRoute(call)
        : json({ error: 'busy', reason: 'contention' }, { status: 409 }),
    );
    const vm = await client.computers.get('vm-1');
    const err = (await vm.start({ idempotencyKey: 'k-4xx' }).catch((e: unknown) => e)) as APIError;
    expect(err.idempotencyKey).toBeUndefined();
  });
});

describe('APIError.code and operationId', () => {
  it('are undefined when the body names neither, or names them with no text', () => {
    for (const body of [undefined, 'text', [], { error: 'x' }, { code: '', operation_id: 7 }]) {
      const err = errorForStatus(409, 'x', body, { method: 'POST' });
      expect(err.code, JSON.stringify(body)).toBeUndefined();
      expect(err.operationId, JSON.stringify(body)).toBeUndefined();
    }
  });
});

describe('isTransient on the keyed refusals', () => {
  const refusal = (status: number, body: Record<string, unknown>) =>
    errorForStatus(status, 'x', body, { method: 'POST' });

  it('is true while the keyed call is still running — the wait for its answer', () => {
    expect(
      isTransient(
        refusal(409, { error: 'x', code: 'idempotency_in_progress', reason: 'contention' }),
      ),
    ).toBe(true);
  });

  it('is false for an outcome the platform never heard', () => {
    expect(isTransient(refusal(409, { error: 'x', code: 'idempotency_outcome_unknown' }))).toBe(
      false,
    );
  });

  it('is false for a key reused on a different request', () => {
    expect(isTransient(refusal(422, { error: 'x', code: 'idempotency_key_reused' }))).toBe(false);
  });
});

describe('operations', () => {
  it('lists by idempotency key', async () => {
    const { rec, client } = sdk(() => json({ operations: [], next_cursor: null }));
    await client.operations.list({ idempotencyKey: 'order-4711:create' });
    expect(rec.last().query).toEqual({ idempotency_key: 'order-4711:create' });
  });

  it('refuses a filter no key could be, before sending it', async () => {
    const { rec, client } = sdk();
    await expect(client.operations.list({ idempotencyKey: 'a b' })).rejects.toThrow(
      ValidationError,
    );
    expect(rec.calls).toEqual([]);
  });

  it('decodes the key an operation was started with, and null where there is none', async () => {
    const { client } = sdk(() =>
      json({ ...OPERATION, kind: 'delete', idempotency_key: 'order-4711:create' }),
    );
    const op = await client.operations.get(OPERATION.id);
    expect(op.idempotencyKey).toBe('order-4711:create');
    expect(op.kind).toBe('delete');
    const { client: older } = sdk(() => json(OPERATION));
    expect((await older.operations.get(OPERATION.id)).idempotencyKey).toBeNull();
  });
});
