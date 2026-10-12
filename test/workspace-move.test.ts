import { describe, expect, it } from 'vitest';
import {
  Client,
  ConflictError,
  MandalaError,
  NotFoundError,
  PermissionDeniedError,
  UnavailableError,
  ValidationError,
} from '../src/index.js';
import { BASE, COMPUTER, json, type Responder, recorder } from './harness.js';

const DESTINATION = 'wsp-0123456789ab';
const ORIGINAL = { ...COMPUTER, status: 'stopped', workspace_id: 'wsp-aaaaaaaaaaaa' };
const ROUTE = `computers/${COMPUTER.id}/workspace`;

async function setup(respond: Responder) {
  const rec = recorder((call) => (call.method === 'GET' ? json(ORIGINAL) : respond(call)));
  const client = new Client({
    apiKey: 'com_test',
    baseUrl: BASE,
    fetch: rec.fetch,
    retries: { idempotent: 2 },
  });
  const computer = await client.computers.get(COMPUTER.id);
  rec.calls.length = 0;
  return { rec, computer };
}

describe('Computer.moveToWorkspace', () => {
  it.each([DESTINATION, null])(
    'sends an explicit destination %j and updates the same handle',
    async (workspaceId) => {
      const updated = { ...ORIGINAL, workspace_id: workspaceId, name: 'current name' };
      const { rec, computer } = await setup(() => json({ computer: updated }));
      const result = await computer.moveToWorkspace(workspaceId);
      expect(result).toBe(computer);
      expect(computer.raw).toEqual(updated);
      expect(computer.workspaceId).toBe(workspaceId ?? '');
      expect(rec.routes()).toEqual([['PUT', ROUTE]]);
      expect(rec.last().body).toEqual({ workspace_id: workspaceId });
      expect(rec.last().headers).not.toHaveProperty('Idempotency-Key');
    },
  );

  it.each([undefined, null, ''])(
    'recognizes public unassigned spelling %j',
    async (workspaceId) => {
      const updated = { ...ORIGINAL, workspace_id: workspaceId };
      const { computer } = await setup(() => json({ computer: updated }));
      expect(await computer.moveToWorkspace(null)).toBe(computer);
      expect(computer.workspaceId).toBe('');
    },
  );

  it.each([
    undefined,
    '',
    'unassigned',
    'customers',
    'wsp-0123456789a',
    'wsp-0123456789abc',
    'wsp-0123456789AB',
    'wsp-0123456789ab\n',
    ' wsp-0123456789ab',
    0,
    false,
    {},
    [],
    new String(DESTINATION),
  ])('refuses invalid destination %j locally, preserving the cache', async (destination) => {
    const { rec, computer } = await setup(() => json({ computer: ORIGINAL }));
    await expect(computer.moveToWorkspace(destination as string)).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(computer.raw).toEqual(ORIGINAL);
    expect(rec.calls).toEqual([]);
  });

  it.each([
    [403, PermissionDeniedError, 'workspace_scoped'],
    [404, NotFoundError, 'not_found'],
    [409, ConflictError, 'snapshots_exist'],
    [409, ConflictError, 'move_in_progress'],
    [503, UnavailableError, 'move_uncertain'],
  ] as const)(
    'preserves a structured %i refusal without retries or cleanup',
    async (status, ErrorType, reason) => {
      const body = { error: 'workspace move refused', reason, retryable: false };
      const { rec, computer } = await setup(() => json(body, { status }));
      const error = await computer.moveToWorkspace(DESTINATION).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(ErrorType);
      expect(error).toMatchObject({ status, body });
      expect(computer.raw).toEqual(ORIGINAL);
      expect(rec.routes()).toEqual([['PUT', ROUTE]]);
    },
  );

  it.each([DESTINATION, ORIGINAL.workspace_id, null])(
    'sends even no-op destination %j for server authorization',
    async (workspaceId) => {
      const { rec, computer } = await setup(() =>
        json({ error: 'account-wide credential required' }, { status: 403 }),
      );
      await expect(computer.moveToWorkspace(workspaceId)).rejects.toBeInstanceOf(
        PermissionDeniedError,
      );
      expect(rec.routes()).toEqual([['PUT', ROUTE]]);
      expect(computer.raw).toEqual(ORIGINAL);
    },
  );

  it.each([
    {},
    null,
    [],
    { ok: true },
    ORIGINAL,
    { computer: null },
    { computer: [] },
    { computer: {} },
    { computer: { ...ORIGINAL, id: 'vm-other', workspace_id: DESTINATION } },
    { computer: { ...ORIGINAL, id: 1, workspace_id: DESTINATION } },
    { computer: { ...ORIGINAL, workspace_id: null } },
    { computer: { ...ORIGINAL, workspace_id: false } },
    { computer: { ...ORIGINAL, workspace_id: {} } },
    { computer: { ...ORIGINAL, workspace_id: undefined } },
  ])('rejects malformed or mismatched success %j without replacing cached state', async (body) => {
    const { rec, computer } = await setup(() => json(body));
    await expect(computer.moveToWorkspace(DESTINATION)).rejects.toBeInstanceOf(MandalaError);
    expect(computer.raw).toEqual(ORIGINAL);
    expect(rec.routes()).toEqual([['PUT', ROUTE]]);
  });

  it.each([false, 0, [], {}, DESTINATION])(
    'does not mistake %j for unassigned',
    async (workspaceId) => {
      const { computer } = await setup(() =>
        json({ computer: { ...ORIGINAL, workspace_id: workspaceId } }),
      );
      await expect(computer.moveToWorkspace(null)).rejects.toBeInstanceOf(MandalaError);
      expect(computer.raw).toEqual(ORIGINAL);
    },
  );

  it.each([201, 202, 204])('requires 200, not %i, before updating cached state', async (status) => {
    const { rec, computer } = await setup(() =>
      status === 204
        ? new Response(null, { status })
        : json({ computer: { ...ORIGINAL, workspace_id: DESTINATION } }, { status }),
    );
    await expect(computer.moveToWorkspace(DESTINATION)).rejects.toBeInstanceOf(MandalaError);
    expect(computer.raw).toEqual(ORIGINAL);
    expect(rec.routes()).toEqual([['PUT', ROUTE]]);
  });

  it('passes cancellation through CallOptions and retains the cached state', async () => {
    let sent!: () => void;
    const started = new Promise<void>((resolve) => {
      sent = resolve;
    });
    const { rec, computer } = await setup(() => {
      sent();
      return new Promise<Response>(() => {});
    });
    const controller = new AbortController();
    const result = computer.moveToWorkspace(DESTINATION, { signal: controller.signal });
    await started;
    controller.abort();
    await expect(result).rejects.toBeDefined();
    expect(computer.raw).toEqual(ORIGINAL);
    expect(rec.routes()).toEqual([['PUT', ROUTE]]);
  });
});
