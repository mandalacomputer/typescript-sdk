/**
 * What the OPL-5026 audit against the API reference found and fixed: fields the
 * docs define that this SDK did not decode, the input actions and file options
 * it could not send, and the retry answer for a change answered 503.
 */

import { describe, expect, it } from 'vitest';
import { errorForStatus } from '../src/errors.js';
import {
  type APIError,
  Client,
  ComputerNotRunningError,
  ConflictError,
  CreateOnlyConflictError,
  FileExistsError,
  type Holdings,
  isTransient,
  MandalaError,
  type Snapshot,
  UnavailableError,
  ValidationError,
} from '../src/index.js';
import { isTransientForPoll } from '../src/wait.js';
import {
  ACTIVITY_PAGE,
  ACTIVITY_RESULTS,
  BASE,
  COMPUTER,
  DIRECTORY,
  json,
  type Responder,
  recorder,
  SIGNAL_PAGE,
  SNAPSHOT,
} from './harness.js';

const client = (respond: Responder, retries = 0) => {
  const rec = recorder(respond);
  return {
    rec,
    client: new Client({
      apiKey: 'com_test',
      baseUrl: BASE,
      fetch: rec.fetch,
      retries: { idempotent: retries },
    }),
  };
};

const computerWith = async (extra: Record<string, unknown>) => {
  const { client: c } = client(() => json({ ...COMPUTER, ...extra }));
  return c.computers.get('vm-1');
};

describe('a computer’s secret fields', () => {
  it('reads secrets_pending as three answers and an absence', async () => {
    expect((await computerWith({ secrets_pending: true })).secretsPending).toBe(true);
    expect((await computerWith({ secrets_pending: false })).secretsPending).toBe(false);
    expect((await computerWith({ secrets_pending: null })).secretsPending).toBeNull();
    // Unknown, never a guess.
    expect((await computerWith({ secrets_pending: 'yes' })).secretsPending).toBeNull();
    expect((await computerWith({})).secretsPending).toBeUndefined();
  });

  it('reads the bindings, the generation, the receipt and the error', async () => {
    const c = await computerWith({
      secrets: [
        {
          secret_id: 'csec-0123456789abcdef',
          revision_id: 'csr-0123456789abcdef01234567',
          env: 'TOKEN',
        },
        {
          secret_id: 'csec-0123456789abcde0',
          revision_id: 'csr-0123456789abcdef01234568',
          file: 'kube',
        },
      ],
      secrets_generation: 4,
      secrets_applied: {
        generation: 4,
        applied_at: '2026-09-23T12:00:00Z',
        revisions: { 'csec-0123456789abcdef': 'csr-0123456789abcdef01234567' },
      },
      secrets_error: 'the desktop session did not accept the values',
    });
    expect(c.secretBindings).toEqual([
      {
        secretId: 'csec-0123456789abcdef',
        revisionId: 'csr-0123456789abcdef01234567',
        env: 'TOKEN',
      },
      {
        secretId: 'csec-0123456789abcde0',
        revisionId: 'csr-0123456789abcdef01234568',
        file: 'kube',
      },
    ]);
    expect(c.secretsGeneration).toBe(4);
    expect(c.secretsApplied).toEqual({
      generation: 4,
      appliedAt: '2026-09-23T12:00:00Z',
      revisions: { 'csec-0123456789abcdef': 'csr-0123456789abcdef01234567' },
    });
    expect(c.secretsError).toBe('the desktop session did not accept the values');
  });

  it('is absent on a computer that holds none, and refuses a binding it cannot read', async () => {
    const none = await computerWith({});
    expect([
      none.secretBindings,
      none.secretsGeneration,
      none.secretsApplied,
      none.secretsError,
    ]).toEqual([undefined, undefined, undefined, undefined]);
    const bad = await computerWith({ secrets: [{ secret_id: 'csec-1', revision_id: 'csr-1' }] });
    expect(() => bad.secretBindings).toThrow(MandalaError);
  });
});

describe('snapshots and holdings', () => {
  it('decodes restore_available and computer_unreachable', async () => {
    const { client: c } = client(() =>
      json([
        { ...SNAPSHOT, restore_available: false, computer_unreachable: true },
        { ...SNAPSHOT, id: 'snap-2', restore_available: true },
        { ...SNAPSHOT, id: 'snap-3' },
      ]),
    );
    const [a, b, d] = await c.snapshots.list();
    expect([a?.restoreAvailable, a?.computerUnreachable]).toEqual([false, true]);
    expect([b?.restoreAvailable, b?.computerUnreachable]).toEqual([true, undefined]);
    expect(d?.restoreAvailable).toBeUndefined();
  });

  it('decodes computer_present, capturing and deleting', async () => {
    const { client: c } = client((call) =>
      call.path.endsWith('/snapshots')
        ? json({
            count: 2,
            size_bytes: 10,
            fingerprint: 'fp',
            computer_present: true,
            capturing: 1,
            deleting: 0,
          })
        : json(COMPUTER),
    );
    const held = await (await c.computers.get('vm-1')).holdings();
    expect(held).toMatchObject({ computerPresent: true, capturing: 1, deleting: 0 });
  });

  it('answers a purge that is still queued in full, rather than as a count of 0', async () => {
    const queued = {
      ok: false,
      computer_deleted: true,
      snapshots_deleted: 0,
      purge: {
        selected: 1,
        confirmed: 0,
        queued: 1,
        failed: 0,
        unknown: 0,
        remaining: 1,
        unselected: null,
        complete: false,
      },
      error: 'The computer was deleted. Snapshot deletion is queued; review the remaining copies.',
    };
    const { client: c } = client((call) =>
      call.method === 'DELETE' ? json(queued, { status: 202 }) : json(COMPUTER),
    );
    const vm = await c.computers.get('vm-1');
    const res = await vm.delete({ deleteSnapshots: true, expect: 'fp', detailed: true });
    expect(res).toMatchObject({
      ok: false,
      computerDeleted: true,
      snapshotsDeleted: 0,
      error: queued.error,
      purge: { selected: 1, queued: 1, remaining: 1, unselected: null, complete: false },
    });
    // The plain form keeps its old answer.
    expect(await vm.delete({ deleteSnapshots: true, expect: 'fp' })).toBe(0);
  });
});

describe('input the docs define', () => {
  it('returns the mechanism a type used, and keeps a word it does not know', async () => {
    for (const mechanism of ['physical', 'unicode', 'mixed', 'future-word']) {
      const { client: c } = client((call) =>
        call.path.endsWith('/input') ? json({ ok: true, mechanism }) : json(COMPUTER),
      );
      const vm = await c.computers.get('vm-1');
      expect((await vm.type('héllo')).mechanism).toBe(mechanism);
    }
    const { client: old } = client((call) =>
      call.path.endsWith('/input') ? json({ ok: true }) : json(COMPUTER),
    );
    expect((await (await old.computers.get('vm-1')).type('hi')).mechanism).toBeUndefined();
  });

  it('refuses a type the platform would refuse, before anything is typed', async () => {
    const { rec, client: c } = client(() => json(COMPUTER));
    const vm = await c.computers.get('vm-1');
    await expect(vm.type('')).rejects.toBeInstanceOf(ValidationError);
    await expect(vm.type('x'.repeat(401))).rejects.toBeInstanceOf(ValidationError);
    // 400 characters, not 400 UTF-16 units: an emoji is one.
    await expect(vm.type('😀'.repeat(400))).resolves.toBeDefined();
    expect(rec.calls.filter((x) => x.path.endsWith('/input'))).toHaveLength(1);
  });

  it('pastes with the default shortcut, or the terminal one as keys', async () => {
    const { rec, client: c } = client((call) =>
      call.path.endsWith('/input') ? json({ ok: true }) : json(COMPUTER),
    );
    const vm = await c.computers.get('vm-1');
    await vm.paste('Café — 東京 😀');
    await vm.paste('ls -la', { shortcut: 'ctrl+shift+v' });
    const bodies = rec.calls.filter((x) => x.path.endsWith('/input')).map((x) => x.body);
    expect(bodies).toEqual([
      { action: 'paste', text: 'Café — 東京 😀' },
      { action: 'paste', text: 'ls -la', keys: ['ctrl', 'shift', 'v'] },
    ]);
    await expect(vm.paste('')).rejects.toBeInstanceOf(ValidationError);
    await expect(vm.paste('a\0b')).rejects.toBeInstanceOf(ValidationError);
    await expect(vm.paste('é'.repeat(4097))).rejects.toBeInstanceOf(ValidationError);
    await expect(vm.paste('x', { shortcut: 'shift+insert' as any })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});

describe('noWake transfers', () => {
  const refused =
    (body: unknown): Responder =>
    (call) =>
      call.path.endsWith('/files') ? json(body, { status: 409 }) : json(COMPUTER);

  it('sends no_wake=1 only when asked', async () => {
    const { rec, client: c } = client((call) =>
      call.path.endsWith('/files') && call.method === 'PUT' ? json({ bytes: 1 }) : json(COMPUTER),
    );
    const vm = await c.computers.get('vm-1');
    await vm.writeFile('/tmp/a', 'x', { noWake: true });
    await vm.writeFile('/tmp/a', 'x');
    const puts = rec.calls.filter((x) => x.method === 'PUT');
    expect(puts.map((x) => x.query)).toEqual([
      { path: '/tmp/a', no_wake: '1' },
      { path: '/tmp/a' },
    ]);
  });

  it('makes the reasonless 409 final rather than a conflict worth retrying', async () => {
    const { client: c } = client(refused({ error: 'the computer is not running' }));
    const vm = await c.computers.get('vm-1');
    for (const call of [
      vm.readFile('/tmp/a', { noWake: true }),
      vm.writeFile('/tmp/a', 'x', { noWake: true }),
    ]) {
      const err = await call.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ComputerNotRunningError);
      expect(err).toBeInstanceOf(ConflictError);
      expect(isTransient(err)).toBe(false);
      expect(isTransientForPoll(err)).toBe(false);
    }
    // Without noWake the same body is the ordinary conflict it always was.
    const plain = await vm.readFile('/tmp/a').catch((e: unknown) => e);
    expect(plain).not.toBeInstanceOf(ComputerNotRunningError);
  });

  it('keeps the platform’s word when it sends one', async () => {
    const { client: c } = client(refused({ error: 'not running', reason: 'unavailable' }));
    const vm = await c.computers.get('vm-1');
    const err = await vm.readFile('/tmp/a', { noWake: true }).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(ComputerNotRunningError);
    expect((err as APIError).reason).toBe('unavailable');
    expect(isTransient(err)).toBe(false);
    // A create-only upload with both options keeps its own, more careful class.
    const { client: c2 } = client(refused({ error: 'taken', reason: 'exists' }));
    const vm2 = await c2.computers.get('vm-1');
    const taken = await vm2
      .writeFile('/tmp/a', 'x', { noWake: true, overwrite: false })
      .catch((e: unknown) => e);
    expect(taken).toBeInstanceOf(FileExistsError);
  });

  it('answers a reasonless 409 to a create-only noWake upload as CreateOnlyConflictError', async () => {
    // Parity with the Python client: the class that claims nothing about the
    // path OR the computer's state, not FileExistsError and not ComputerNotRunningError.
    const { client: c } = client(refused({ error: 'conflict' }));
    const vm = await c.computers.get('vm-1');
    const err = await vm
      .writeFile('/tmp/a', 'x', { noWake: true, overwrite: false })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CreateOnlyConflictError);
    expect(err).not.toBeInstanceOf(ComputerNotRunningError);
    expect(err).not.toBeInstanceOf(FileExistsError);
    expect((err as APIError).reason).toBeUndefined();
    expect(isTransient(err)).toBe(false);
  });
});

describe('refusal words and the 503 on a change', () => {
  it('reads starting and contention as passing, exists and unavailable as not', () => {
    const on = (status: number, reason: string, method = 'POST') =>
      isTransient(errorForStatus(status, 'x', { error: 'x', reason }, { method }));
    expect(on(409, 'starting')).toBe(true);
    expect(on(409, 'contention')).toBe(true);
    expect(on(409, 'unavailable')).toBe(false);
    expect(on(409, 'unsupported')).toBe(false);
    expect(on(409, 'exists')).toBe(false);
    expect(on(403, 'revoked')).toBe(false);
    // A word this version does not know leaves the status answer standing.
    expect(on(409, 'a-word-from-later')).toBe(true);
    // A guest agent silent past its boot window is a 502: an unknown outcome.
    expect(isTransient(errorForStatus(502, 'x', { error: 'x' }, { method: 'POST' }))).toBe(false);
  });

  it('calls a read answered 503 transient, and a change answered 503 not', () => {
    const at = (method: string) => errorForStatus(503, 'x', { error: 'x' }, { method });
    expect(at('GET')).toBeInstanceOf(UnavailableError);
    expect(isTransient(at('GET'))).toBe(true);
    expect(isTransient(at('HEAD'))).toBe(true);
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE', 'post'])
      expect(isTransient(at(m))).toBe(false);
    // One built by hand has no method and keeps its old answer.
    expect(isTransient(new UnavailableError('x', 503))).toBe(true);
    // A word that clears cannot make a change answered 503 transient: the
    // outcome is still unknown. It still does on a read.
    for (const reason of ['contention', 'starting']) {
      const on = (method: string) => errorForStatus(503, 'x', { error: 'x', reason }, { method });
      for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(isTransient(on(m))).toBe(false);
      expect(isTransient(on('GET'))).toBe(true);
    }
  });

  it('records the method on every error it builds from a response', async () => {
    const { client: c } = client(() => json({ error: 'busy' }, { status: 503 }));
    const err = (await c.computers
      .create({ template: 'base' })
      .catch((e: unknown) => e)) as APIError;
    expect(err).toBeInstanceOf(UnavailableError);
    expect(err.method).toBe('POST');
    expect(isTransient(err)).toBe(false);
  });
});

describe('the routes that had no method', () => {
  it('lists a guest directory, strictly', async () => {
    const { rec, client: c } = client((call) =>
      call.path.endsWith('/files/list') ? json(DIRECTORY) : json(COMPUTER),
    );
    const vm = await c.computers.get('vm-1');
    const dir = await vm.listDirectory('/home/user/Desktop');
    expect(rec.calls.at(-1)?.query).toEqual({ path: '/home/user/Desktop' });
    expect(dir.entries).toEqual([
      { name: 'notes.txt', type: 'file', sizeBytes: 12 },
      { name: 'photos', type: 'directory' },
    ]);
    expect([dir.truncated, dir.skipped]).toEqual([false, 0]);
    await expect(vm.listDirectory('relative')).rejects.toBeInstanceOf(ValidationError);
    const { client: bad } = client((call) =>
      call.path.endsWith('/files/list')
        ? json({ ...DIRECTORY, truncated: undefined })
        : json(COMPUTER),
    );
    await expect((await bad.computers.get('vm-1')).listDirectory('/tmp')).rejects.toBeInstanceOf(
      MandalaError,
    );
  });

  it('pages activity history and its change journal', async () => {
    const { rec, client: c } = client((call) =>
      call.path.endsWith('/results')
        ? json(ACTIVITY_RESULTS)
        : call.path.endsWith('/activities')
          ? json(ACTIVITY_PAGE)
          : json(COMPUTER),
    );
    const vm = await c.computers.get('vm-1');
    const page = await vm.activities();
    expect(page.items[0]).toMatchObject({
      activityId: ACTIVITY_PAGE.items[0]!.activity_id,
      exitCode: 0,
    });
    expect([page.nextCursor, page.changesCursor, page.gap]).toEqual([null, 'chg-1', false]);
    await vm.activities({ cursor: page.changesCursor, changes: true });
    expect(rec.calls.at(-1)?.query).toEqual({ cursor: 'chg-1', changes: '1' });
    await expect(vm.activities({ changes: true })).rejects.toBeInstanceOf(ValidationError);
    const results = await vm.activityResults('act_0123456789abcdef0123456789abcdef');
    expect(results.items[0]?.id).toBe('res_0123456789abcdef0123456789abcdef');
  });

  it('reads platform signals, a baseline and a gap', async () => {
    const gap = {
      ...SIGNAL_PAGE,
      events: [],
      gap: {
        cursor: 'sig-9',
        at: '2026-09-16T12:00:00.000Z',
        type: 'gap',
        computer: 'vm-1',
        source: 'daemon',
        data: { detail: 'events happened that this computer can no longer replay' },
      },
    };
    const { rec, client: c } = client((call) =>
      call.path.endsWith('/signals')
        ? json(call.query.since === 'old' ? gap : SIGNAL_PAGE)
        : json(COMPUTER),
    );
    const vm = await c.computers.get('vm-1');
    const page = await vm.signals();
    expect(page.events[0]).toMatchObject({
      type: 'process.exited',
      data: { pid: 42, exit_code: 0 },
    });
    expect(rec.calls.at(-1)?.query).toEqual({});
    const reset = await vm.signals({ since: 'old', limit: 5 });
    expect(rec.calls.at(-1)?.query).toEqual({ since: 'old', limit: '5' });
    expect(reset.gap?.cursor).toBe('sig-9');
    await expect(vm.signals({ limit: 101 })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('additive fields stay additive', () => {
  it('still accepts the shapes callers built before this change', () => {
    // Compile-time: these are the pre-OPL-5026 shapes, and `tsc` checks this file.
    const held: Holdings = { count: 0, sizeBytes: 0, fingerprint: 'fp', raw: {} };
    const snap: Snapshot = {
      id: 'snap-1',
      computerId: 'vm-1',
      computerName: '',
      name: '',
      kind: 'disk',
      state: 'durable',
      sizeBytes: 0,
      createdAt: '',
      incremental: false,
      auto: false,
      durable: true,
      capturing: false,
      memory: false,
      orphaned: false,
      unreachable: false,
      os: 'linux',
      template: 'base',
      cpu: 1,
      ramMb: 1024,
      diskGb: 10,
      resolution: '1280x800x24',
      raw: {},
    };
    expect([held.computerPresent, snap.restoreAvailable, snap.computerUnreachable]).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });
});
