/**
 * Routes, fields and headers the platform documents that this client used to
 * leave unread or unsent: build cancel, SSH key proof of possession, paged
 * webhook deliveries, the webhooks a key revoke reports, the retained result
 * and artifact listings, a computer's host pause and egress failure, a
 * webhook's last error and creator, the retained output reason, activity
 * result kinds, and the keyed create replayed as an operation.
 */

import { describe, expect, it } from 'vitest';
import { errorForStatus } from '../src/errors.js';
import {
  APIError,
  Client,
  ConflictError,
  isTransient,
  MandalaError,
  ValidationError,
} from '../src/index.js';
import {
  ACTIVITY,
  ACTIVITY_RESULTS,
  anyRoute,
  BASE,
  COMPUTER,
  EXEC_OK,
  json,
  type Responder,
  recorder,
  SSH_KEY_CHALLENGE,
  TEMPLATE_BUILD,
  WEBHOOK,
} from './harness.js';

const setup = (respond: Responder = anyRoute) => {
  const rec = recorder(respond);
  return { rec, client: new Client({ apiKey: 'k', baseUrl: BASE, fetch: rec.fetch }) };
};

describe('builds.cancel', () => {
  it('posts the cancel and answers the build as it stands', async () => {
    const { rec, client } = setup();
    const build = await client.builds.cancel('bld-1');
    expect(rec.routes()).toEqual([['POST', 'builds/bld-1/cancel']]);
    expect(build.id).toBe('bld-1');
    expect(build.status).toBe('running');
  });

  it('is a ConflictError for a build that has finished', async () => {
    const { client } = setup(() =>
      json({ error: 'The build has already finished.' }, { status: 409 }),
    );
    await expect(client.builds.cancel('bld-1')).rejects.toBeInstanceOf(ConflictError);
  });

  it('refuses an answer that is not a build', async () => {
    const { client } = setup(() => json([TEMPLATE_BUILD], { status: 202 }));
    await expect(client.builds.cancel('bld-1')).rejects.toThrow(
      /expected a build from POST builds\/bld-1\/cancel/,
    );
  });
});

describe('SSH key proof of possession', () => {
  it('issues a challenge', async () => {
    const { rec, client } = setup();
    const c = await client.sshKeys.challenge();
    expect(rec.routes()).toEqual([['POST', 'ssh-keys/challenge']]);
    expect(c).toEqual({
      challenge: SSH_KEY_CHALLENGE.challenge,
      namespace: SSH_KEY_CHALLENGE.namespace,
      expiresAt: SSH_KEY_CHALLENGE.expires_at,
      signCommand: SSH_KEY_CHALLENGE.sign_command,
      raw: SSH_KEY_CHALLENGE,
    });
  });

  it.each(['challenge', 'namespace'])('refuses a challenge without its %s', async (key) => {
    const { client } = setup(() => json({ ...SSH_KEY_CHALLENGE, [key]: '' }, { status: 201 }));
    await expect(client.sshKeys.challenge()).rejects.toThrow(new RegExp(`carry its ${key}`));
  });

  it('sends the challenge and the signature with the key', async () => {
    const { rec, client } = setup();
    await client.sshKeys.add({
      publicKey: 'ssh-ed25519 AAAAC3Nz laptop',
      challenge: SSH_KEY_CHALLENGE.challenge,
      signature: '-----BEGIN SSH SIGNATURE-----\nU1NIU0lH\n-----END SSH SIGNATURE-----',
    });
    expect(rec.last().body).toEqual({
      public_key: 'ssh-ed25519 AAAAC3Nz laptop',
      challenge: SSH_KEY_CHALLENGE.challenge,
      signature: '-----BEGIN SSH SIGNATURE-----\nU1NIU0lH\n-----END SSH SIGNATURE-----',
    });
  });

  it.each([
    [{ challenge: 'sshkc-1' }, /go together/],
    [{ signature: 'sig' }, /go together/],
    [{ challenge: ' ', signature: 'sig' }, /challenge must not be empty/],
    [{ challenge: 'sshkc-1', signature: '' }, /signature must not be empty/],
  ])('refuses %j before sending', async (proof, refusal) => {
    const { rec, client } = setup();
    const err = await client.sshKeys
      .add({ publicKey: 'ssh-ed25519 AAAAC3Nz laptop', ...proof })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as Error).message).toMatch(refusal);
    expect(rec.calls).toEqual([]);
  });

  it("reads a key's possession, and null from a platform that does not say", async () => {
    const { client } = setup((call) =>
      call.path === '/ssh-keys'
        ? json([
            { ...anyKey(), possession: 'unproven' },
            { ...anyKey(), id: 'sshk-2', possession: undefined },
          ])
        : anyRoute(call),
    );
    const [unproven, unsaid] = await client.sshKeys.list();
    expect(unproven?.possession).toBe('unproven');
    expect(unsaid?.possession).toBeNull();
  });
});

const anyKey = () => ({
  id: 'sshk-1',
  name: 'laptop',
  public_key: 'ssh-ed25519 AAAA',
  fingerprint: 'SHA256:x',
  key_type: 'ssh-ed25519',
  created_at: '2026-09-16T12:00:00.000Z',
  last_used_at: null,
  reach: 'this_account',
});

describe('webhooks.deliveries paging and filter', () => {
  it('sends before, limit and state', async () => {
    const { rec, client } = setup();
    await client.webhooks.deliveries('whk-1', {
      before: 'whd-9f3c1a7e5b2d4c80',
      limit: 25,
      state: 'exhausted',
    });
    expect(rec.last().query).toEqual({
      before: 'whd-9f3c1a7e5b2d4c80',
      limit: '25',
      state: 'exhausted',
    });
  });

  it('sends nothing when asked for nothing', async () => {
    const { rec, client } = setup();
    await client.webhooks.deliveries('whk-1');
    expect(rec.last().query).toEqual({});
  });

  it.each([
    [{ limit: 0 }, /limit must be a whole number from 1 to 100/],
    [{ limit: 101 }, /limit must be a whole number from 1 to 100/],
    [{ limit: 1.5 }, /limit must be a whole number from 1 to 100/],
    [{ before: '' }, /before must be a delivery id/],
    [{ before: ' whd-1' }, /before must be a delivery id/],
    [{ state: '' }, /state must be a delivery state/],
  ])('refuses %j before sending', async (args, refusal) => {
    const { rec, client } = setup();
    await expect(client.webhooks.deliveries('whk-1', args)).rejects.toThrow(refusal);
    expect(rec.calls).toEqual([]);
  });
});

describe('apiKeys.revoke', () => {
  const revoked = (body: unknown) =>
    setup((call) =>
      call.method === 'DELETE' && call.path.startsWith('/api-keys/') ? json(body) : anyRoute(call),
    );

  it('answers the webhooks made through the key', async () => {
    const hooks = [{ id: 'whk-1', url: 'https://ci.example.com/m', enabled: true }];
    const { client } = revoked({ ok: true, webhooks: hooks });
    const answer = await client.apiKeys.revoke('key-a1b2c3d4e5f6');
    expect(answer.webhooks).toEqual([
      { id: 'whk-1', url: 'https://ci.example.com/m', enabled: true },
    ]);
  });

  it('answers none from a platform that does not list them', async () => {
    const { client } = revoked({ ok: true });
    expect((await client.apiKeys.revoke('key-a1b2c3d4e5f6')).webhooks).toEqual([]);
  });

  it.each([
    [{ ok: true, webhooks: 'whk-1' }, /webhooks is not a list/],
    [{ ok: true, webhooks: [{ url: 'https://x', enabled: true }] }, /webhook 0 has no id/],
    [{ ok: true, webhooks: [{ id: 'whk-1', url: 'https://x' }] }, /webhook 0 does not say/],
  ])('says the key was revoked when the list is unreadable (%j)', async (body, why) => {
    const { client } = revoked(body);
    const err = await client.apiKeys.revoke('key-a1b2c3d4e5f6').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MandalaError);
    expect((err as Error).message).toMatch(/^key-a1b2c3d4e5f6 was revoked, but/);
    expect((err as Error).message).toMatch(why);
  });
});

describe('retained listings', () => {
  const quota = { objects: 2, bytes: 40, max_objects: 256, max_bytes: 134217728 };
  const account = { objects: 5, bytes: 4096, max_objects: 2000, max_bytes: 536870912 };
  const usage = { computer: quota, account };
  const resultRow = {
    result_id: 'res_0123456789abcdef0123456789abcdef',
    kind: 'synchronous-output',
    bytes: 40,
    workspace_id: null,
    execution_id: null,
    started_at: '2026-11-09T12:00:00.000Z',
    expires_at: '2026-11-10T12:00:00.000Z',
  };
  const artifactRow = {
    artifact_id: 'art_0123456789abcdef0123456789abcdef',
    size: 12,
    workspace_id: 'ws-1',
    execution_id: 'exec_0123456789abcdef0123456789abcdef',
    started_at: '2026-11-09T12:00:00.000Z',
    expires_at: '2026-11-10T12:00:00.000Z',
  };
  const listing = (results: unknown, artifacts: unknown) => async () => {
    const { rec, client } = setup((call) => {
      if (call.method === 'GET' && call.path === '/computers/vm-1/results') return json(results);
      if (call.method === 'GET' && call.path === '/computers/vm-1/artifacts')
        return json(artifacts);
      return anyRoute(call);
    });
    return { rec, c: await client.computers.get('vm-1') };
  };
  const decodedUsage = {
    computer: { objects: 2, bytes: 40, maxObjects: 256, maxBytes: 134217728 },
    account: { objects: 5, bytes: 4096, maxObjects: 2000, maxBytes: 536870912 },
  };

  it('lists results and artifacts with their quota usage', async () => {
    const { rec, c } = await listing(
      { results: [resultRow], usage },
      { artifacts: [artifactRow], usage },
    )();
    expect(await c.results()).toEqual({
      results: [
        {
          resultId: resultRow.result_id,
          kind: 'synchronous-output',
          bytes: 40,
          workspaceId: null,
          executionId: null,
          startedAt: resultRow.started_at,
          expiresAt: resultRow.expires_at,
        },
      ],
      usage: decodedUsage,
    });
    expect(await c.artifacts()).toEqual({
      artifacts: [
        {
          artifactId: artifactRow.artifact_id,
          size: 12,
          workspaceId: 'ws-1',
          executionId: artifactRow.execution_id,
          startedAt: artifactRow.started_at,
          expiresAt: artifactRow.expires_at,
        },
      ],
      usage: decodedUsage,
    });
    expect(rec.routes().slice(1)).toEqual([
      ['GET', 'computers/vm-1/results'],
      ['GET', 'computers/vm-1/artifacts'],
    ]);
    expect(rec.calls[1]?.query).toEqual({});
  });

  it.each([
    ['a usage with no account', { computer: quota }],
    ['a quota with no maximum', { computer: { ...quota, max_bytes: undefined }, account }],
    ['a negative count', { computer: { ...quota, objects: -1 }, account }],
  ])('refuses %s rather than reading it as room', async (_, bad) => {
    const { c } = await listing({ results: [], usage: bad }, { artifacts: [], usage: bad })();
    await expect(c.results()).rejects.toThrow(/invalid retained result listing/);
    await expect(c.artifacts()).rejects.toThrow(/invalid retained artifact listing/);
  });

  it.each([
    ['an unreadable id', { result_id: 'art_x' }, { artifact_id: 'res_x' }],
    ['a missing size', { bytes: undefined }, { size: undefined }],
    ['a bad execution id', { execution_id: 'exec_1' }, { execution_id: 'exec_1' }],
    ['a bad time', { started_at: 'soon' }, { expires_at: 'later' }],
  ])('refuses a row with %s rather than dropping it', async (_, r, a) => {
    const { c } = await listing(
      { results: [{ ...resultRow, ...r }], usage },
      { artifacts: [{ ...artifactRow, ...a }], usage },
    )();
    await expect(c.results()).rejects.toThrow(/invalid retained result listing/);
    await expect(c.artifacts()).rejects.toThrow(/invalid retained artifact listing/);
  });
});

describe('computer diagnostics', () => {
  const read = async (extra: Record<string, unknown>) => {
    const { client } = setup((call) =>
      call.path === '/computers/vm-1' ? json({ ...COMPUTER, ...extra }) : anyRoute(call),
    );
    return client.computers.get('vm-1');
  };

  it('reads host_paused', async () => {
    const c = await read({ host_paused: { reason: 'disk_low', since: '2026-11-09T12:00:00Z' } });
    expect(c.status).toBe('running');
    expect(c.hostPaused).toEqual({ reason: 'disk_low', since: '2026-11-09T12:00:00Z' });
    expect((await read({})).hostPaused).toBeUndefined();
    expect((await read({ host_paused: null })).hostPaused).toBeUndefined();
  });

  it.each([['paused'], [{ reason: 'disk_low' }], [{ reason: '', since: 'x' }]])(
    'refuses a host_paused it cannot read (%j)',
    async (bad) => {
      const c = await read({ host_paused: bad });
      expect(() => c.hostPaused).toThrow(/host_paused/);
    },
  );

  it('reads egress_proxy_last_error', async () => {
    const c = await read({
      egress_proxy_last_error: {
        reason: 'credentials_refused',
        at: '2026-11-09T12:00:00Z',
        count: 3,
      },
    });
    expect(c.egressProxyLastError).toEqual({
      reason: 'credentials_refused',
      at: '2026-11-09T12:00:00Z',
      count: 3,
    });
    expect((await read({})).egressProxyLastError).toBeUndefined();
  });

  it.each([
    [{ reason: 'dns', at: '2026-11-09T12:00:00Z' }],
    [{ reason: 'dns', at: '2026-11-09T12:00:00Z', count: '3' }],
    [{ at: '2026-11-09T12:00:00Z', count: 1 }],
    [[]],
  ])('refuses an egress_proxy_last_error it cannot read (%j)', async (bad) => {
    const c = await read({ egress_proxy_last_error: bad });
    expect(() => c.egressProxyLastError).toThrow(/egress_proxy_last_error/);
  });
});

describe('webhook last_error and created_by', () => {
  const read = (extra: Record<string, unknown>) =>
    setup((call) =>
      call.path === '/webhooks/whk-1' ? json({ ...WEBHOOK, ...extra }) : anyRoute(call),
    ).client.webhooks.get('whk-1');

  it('reads both', async () => {
    const hook = await read({
      last_error: {
        at: '2026-11-09T12:00:00Z',
        status: null,
        error: 'timeout',
        delivery: 'whd-9f3c1a7e5b2d4c80',
      },
      created_by: 'apikey:key-a1b2c3d4e5f6',
    });
    expect(hook.lastError).toEqual({
      at: '2026-11-09T12:00:00Z',
      status: null,
      error: 'timeout',
      deliveryId: 'whd-9f3c1a7e5b2d4c80',
    });
    expect(hook.createdBy).toBe('apikey:key-a1b2c3d4e5f6');
  });

  it('keeps a null creator as null and an absent one absent', async () => {
    expect((await read({ created_by: null })).createdBy).toBeNull();
    const old = await read({});
    expect('createdBy' in old).toBe(false);
    expect((await read({ last_error: null })).lastError).toBeUndefined();
  });

  it.each([
    [{ at: '2026-11-09T12:00:00Z', status: 503, error: 'status 503' }],
    [{ at: '2026-11-09T12:00:00Z', status: '503', error: 'status 503', delivery: 'whd-1' }],
    ['timeout'],
  ])('refuses a last_error it cannot read (%j)', async (bad) => {
    await expect(read({ last_error: bad })).rejects.toThrow(/last_error/);
  });
});

describe('retained output reason', () => {
  const exec = (status: number, headers: Record<string, string>, body: unknown = EXEC_OK) =>
    setup((call) =>
      call.path.endsWith('/exec') ? json(body, { status, headers }) : anyRoute(call),
    ).client.computers.get('vm-1');

  it('says why on a result', async () => {
    const c = await exec(200, {
      'X-GC-Retained-Output': 'unavailable',
      'X-GC-Retained-Output-Reason': 'account_quota',
    });
    const result = await c.exec('true', { retainOutput: true });
    expect(result.retainedOutput).toBe('unavailable');
    expect(result.retainedOutputReason).toBe('account_quota');
  });

  it('is absent without the header, and without unavailable beside it', async () => {
    const plain = await exec(200, { 'X-GC-Retained-Output': 'unavailable' });
    expect((await plain.exec('true', { retainOutput: true })).retainedOutputReason).toBeUndefined();
    const alone = await exec(200, { 'X-GC-Retained-Output-Reason': 'capacity' });
    expect((await alone.exec('true', { retainOutput: true })).retainedOutputReason).toBeUndefined();
  });

  it('says why on a refused answer', async () => {
    const c = await exec(
      409,
      { 'X-GC-Retained-Output': 'unavailable', 'X-GC-Retained-Output-Reason': 'capacity' },
      { error: 'busy', reason: 'contention' },
    );
    const err = await c.exec('true', { retainOutput: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(APIError);
    expect((err as APIError).retainedOutputReason).toBe('capacity');
  });
});

describe('activity result kinds', () => {
  it('reads an artifact item and the capture times of an available one', async () => {
    const items = [
      ...ACTIVITY_RESULTS.items,
      {
        id: 'art_0123456789abcdef0123456789abcdef',
        kind: 'artifact',
        association: 'caller_selected_artifact',
        availability: 'available',
        captured_at: '2026-11-09T12:00:00Z',
        expires_at: '2026-11-10T12:00:00Z',
        bytes: 12,
      },
    ];
    const { client } = setup((call) =>
      call.path.endsWith('/results') ? json({ ...ACTIVITY_RESULTS, items }) : anyRoute(call),
    );
    const c = await client.computers.get('vm-1');
    const page = await c.activityResults(ACTIVITY.activity_id);
    expect(page.items[0]?.capturedAt).toBeUndefined();
    expect(page.items[1]).toMatchObject({
      id: 'art_0123456789abcdef0123456789abcdef',
      kind: 'artifact',
      capturedAt: '2026-11-09T12:00:00Z',
      expiresAt: '2026-11-10T12:00:00Z',
    });
  });
});

describe('a keyed create replayed as its operation', () => {
  const operation = (computerId: string | null) => ({
    id: 'op_0123456789abcdef01234567',
    kind: 'create',
    computer_id: computerId,
    state: 'succeeded',
  });
  const replaying = (body: unknown) =>
    setup((call) => {
      if (call.method === 'POST' && (call.path === '/computers' || call.path.endsWith('/clone')))
        return json(body, { headers: { 'Idempotent-Replayed': 'true' } });
      if (call.method === 'GET' && call.path === '/computers/vm-7')
        return json({ ...COMPUTER, id: 'vm-7' });
      return anyRoute(call);
    });
  const replay = { operation_id: 'op_0123456789abcdef01234567', operation: operation('vm-7') };

  it('reads the computer the operation names', async () => {
    const { rec, client } = replaying(replay);
    const c = await client.computers.create({}, { idempotencyKey: 'k-1' });
    expect(c.id).toBe('vm-7');
    expect(rec.routes()).toEqual([
      ['POST', 'computers'],
      ['GET', 'computers/vm-7'],
    ]);
  });

  it('does the same for a clone and an ephemeral computer', async () => {
    const cloned = replaying(replay);
    expect((await cloned.client.snapshots.clone('snap-1', 'x', { idempotencyKey: 'k' })).id).toBe(
      'vm-7',
    );
    const scoped = replaying(replay);
    const e = await scoped.client.computers.ephemeral({}, { idempotencyKey: 'k' });
    expect(e.id).toBe('vm-7');
  });

  it.each([
    ['a null operation', { operation_id: 'op_0123456789abcdef01234567', operation: null }],
    ['an operation naming no computer', { ...replay, operation: operation(null) }],
  ])('refuses %s, naming the operation to read', async (_, body) => {
    const { client } = replaying(body);
    await expect(client.computers.create({}, { idempotencyKey: 'k' })).rejects.toThrow(
      /replay naming operation op_0123456789abcdef01234567 and no computer: read operations\.get/,
    );
  });

  it('leaves an ordinary create alone', async () => {
    const { rec, client } = setup();
    expect((await client.computers.create()).id).toBe(COMPUTER.id);
    expect(rec.routes()).toEqual([['POST', 'computers']]);
  });
});

describe('APIError.computerId and the macOS refusal', () => {
  it('reads computer_id off an in-progress refusal', () => {
    const err = errorForStatus(
      409,
      'still running',
      {
        error: 'still running',
        code: 'idempotency_in_progress',
        reason: 'contention',
        operation_id: 'op_1',
        computer_id: 'vm-7',
      },
      { method: 'POST' },
    ) as APIError;
    expect(err.computerId).toBe('vm-7');
    expect(err.operationId).toBe('op_1');
    expect((errorForStatus(409, 'x', { error: 'x' }, {}) as APIError).computerId).toBeUndefined();
  });

  it('treats unsupported_on_macos as final, even on a read answered 503', () => {
    const err = errorForStatus(
      503,
      'no',
      { error: 'no', reason: 'unsupported_on_macos' },
      { method: 'GET' },
    );
    expect(isTransient(err)).toBe(false);
  });
});
