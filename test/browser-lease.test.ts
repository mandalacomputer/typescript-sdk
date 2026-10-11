import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { MandalaBrowserToolset } from '../src/anthropic-browser.js';
import { BrowserCDP } from '../src/browser-cdp.js';
import {
  BrowserConnection,
  BrowserSessionLease,
  type BrowserSessionPolicy,
  browserSessionOptions,
} from '../src/browser-connection.js';
import type { Computer } from '../src/computer.js';
import {
  APIError,
  ConflictError,
  ConnectionError,
  isTransient,
  RateLimitError,
  UnavailableError,
} from '../src/errors.js';

const sockets = vi.hoisted(
  () =>
    [] as { ended: boolean; terminate(): void; pending?: number; message(value: unknown): void }[],
);
vi.mock('ws', () => ({
  default: class extends EventEmitter {
    ended = false;
    pending?: number;
    constructor() {
      super();
      sockets.push(this);
      queueMicrotask(() => this.emit('open'));
    }
    message(value: unknown) {
      this.emit('message', Buffer.from(JSON.stringify(value)));
    }
    send(raw: string, callback: () => void) {
      const { id, method, params } = JSON.parse(raw);
      queueMicrotask(() => {
        if (method === 'Runtime.evaluate' && params.expression === 'pending') {
          this.pending = id;
          callback();
          return;
        }
        this.message({
          id,
          result:
            method === 'Target.createBrowserContext'
              ? { browserContextId: 'context' }
              : method === 'Target.createTarget'
                ? { targetId: 'tab' }
                : {},
        });
        if (method === 'Target.createTarget')
          this.message({
            method: 'Target.attachedToTarget',
            params: {
              sessionId: 'session',
              targetInfo: { targetId: 'tab', type: 'page', browserContextId: 'context' },
            },
          });
        callback();
      });
    }
    terminate() {
      if (!this.ended) {
        this.ended = true;
        this.emit('close');
      }
    }
  },
}));
const ID = 'a'.repeat(32),
  TOKEN = `bcdp_${'b'.repeat(64)}`,
  epoch = Date.parse('2000-01-01T00:00:00Z');
const iso = (seconds: number) => new Date(epoch + seconds * 1000).toISOString();
function leaseData(server = 0, lease = 60, absolute = 120) {
  return {
    id: ID,
    lifecycle_version: 2,
    server_time: iso(server),
    attach_expires_at: iso(60),
    lease_expires_at: iso(lease),
    absolute_expires_at: iso(absolute),
    lease_seconds: 60,
    idle_timeout_seconds: 0,
  };
}
const snapshot = (server = 0, lease = 60, absolute = 120) =>
  BrowserSessionLease.fromApi(leaseData(server, lease, absolute), ID);
const connection = (policy?: BrowserSessionPolicy) =>
  BrowserConnection.fromApi(
    {
      id: ID,
      token: TOKEN,
      url: `wss://api.test/api/v1/computers/vm/browser-connections/${ID}/cdp`,
      expires_at: iso(60),
      ...(policy ? leaseData() : {}),
    },
    'https://api.test/api/v1',
    'computers/vm/browser-connections',
    policy,
  );
const policy = { leaseSeconds: 60, maxDurationSeconds: 120 };
function setup(
  renew = vi.fn(async () => snapshot(40, 100)),
  options: BrowserSessionPolicy = policy,
) {
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] });
  const create = vi.fn(async () => connection(options)),
    revoke = vi.fn(async () => {});
  const backend = new BrowserCDP(create, revoke, async () => {}, renew, options);
  return { backend, renew, create, revoke };
}
afterEach(() => {
  vi.useRealTimers();
  sockets.length = 0;
});
it('renews during a pending action without changing socket, context, or identity', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] });
  const initial = BrowserSessionLease.fromApi(
    { ...leaseData(), attach_expires_at: iso(6), lease_expires_at: iso(6) },
    ID,
  );
  const grant = {
    ...connection(policy),
    id: ID,
    url: connection(policy).url,
    token: TOKEN,
    lease: initial,
  } as BrowserConnection;
  const renew = vi.fn(async () =>
    BrowserSessionLease.fromApi({ ...leaseData(4, 64), attach_expires_at: iso(6) }, ID),
  );
  const backend = new BrowserCDP(
    async () => grant,
    async () => {},
    async () => {},
    renew,
    policy,
  );
  try {
    await backend.start();
    const before = backend.state();
    const ws = sockets[0]!;
    const pending = backend.send('Runtime.evaluate', { expression: 'pending' });
    await vi.advanceTimersByTimeAsync(4001);
    expect(renew).toHaveBeenCalledTimes(1);
    expect(ws.ended).toBe(false);
    expect(backend.state()).toEqual(before);
    ws.message({ id: ws.pending, result: { value: 5880 } });
    await expect(pending).resolves.toEqual({ value: 5880 });
    expect(sockets).toHaveLength(1);
  } finally {
    await backend.close();
  }
});
it('renews while awaiting the next action using server time despite wall-clock skew', async () => {
  const { backend, renew, create } = setup();
  try {
    await backend.start();
    const before = backend.state();
    const ws = sockets[0]!;
    await vi.advanceTimersByTimeAsync(40001);
    expect(renew).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(1);
    expect(ws.ended).toBe(false);
    expect(backend.state()).toEqual(before);
    expect(backend.sessionStatus()).toMatchObject({
      state: 'active',
      absoluteExpiresAt: new Date(iso(120)),
    });
    expect(backend.sessionStatus().remainingSeconds).toBeGreaterThan(59);
  } finally {
    await backend.close();
  }
});
it('auth renewal failure ends the socket and redacts credentials', async () => {
  const { backend } = setup(
    vi.fn(async () => {
      throw new Error(TOKEN);
    }),
  );
  try {
    await backend.start();
    await vi.advanceTimersByTimeAsync(40001);
    expect(sockets[0]!.ended).toBe(true);
    expect(backend.sessionStatus().terminalError).toContain('renewal failed');
    await expect(backend.start()).rejects.toThrow('renewal failed');
    expect(backend.sessionStatus().terminalError).not.toContain(TOKEN);
  } finally {
    await backend.close();
  }
});
it('close aborts renewal and a late response cannot revive the session', async () => {
  let deliver!: (value: BrowserSessionLease) => void;
  let signal: AbortSignal | undefined;
  const renew = vi.fn((_id: string, s: AbortSignal) => {
    signal = s;
    return new Promise<BrowserSessionLease>((r) => {
      deliver = r;
    });
  });
  const { backend, revoke } = setup(renew);
  await backend.start();
  await vi.advanceTimersByTimeAsync(40001);
  await backend.close();
  expect(signal?.aborted).toBe(true);
  deliver(snapshot(40, 100));
  await vi.advanceTimersByTimeAsync(180000);
  expect(backend.sessionStatus().state).toBe('ended');
  expect(renew).toHaveBeenCalledTimes(1);
  expect(revoke).toHaveBeenCalledTimes(1);
});
it('honors autoRenew false and ends at the lease deadline', async () => {
  const { backend, renew } = setup(
    vi.fn(async () => snapshot()),
    { ...policy, autoRenew: false },
  );
  try {
    await backend.start();
    await vi.advanceTimersByTimeAsync(60001);
    expect(renew).not.toHaveBeenCalled();
    expect(backend.sessionStatus().state).toBe('ended');
    expect(sockets[0]!.ended).toBe(true);
  } finally {
    await backend.close();
  }
});
it('does not renew past the absolute cap', async () => {
  const { backend, renew } = setup(vi.fn(async () => snapshot(40, 100, 120)));
  try {
    await backend.start();
    await vi.advanceTimersByTimeAsync(40001);
    renew.mockResolvedValue(snapshot(80, 120, 120));
    await vi.advanceTimersByTimeAsync(40000);
    await vi.advanceTimersByTimeAsync(40000);
    expect(renew).toHaveBeenCalledTimes(2);
    expect(backend.sessionStatus().state).toBe('ended');
  } finally {
    await backend.close();
  }
});
it.each([
  null,
  [],
  true,
  { leaseSeconds: null },
  { leaseSeconds: 59 },
  { leaseSeconds: 120, maxDurationSeconds: 60 },
  { maxDurationSeconds: 7201 },
  { autoRenew: 1 },
])('refuses invalid policy: %j', (value) => {
  expect(() => browserSessionOptions(value as BrowserSessionPolicy)).toThrow();
  expect(
    () =>
      new MandalaBrowserToolset({} as Computer, { sessionPolicy: value as BrowserSessionPolicy }),
  ).toThrow();
});
it('preserves valid policy values inherited through getters', async () => {
  class Policy {
    get leaseSeconds() {
      return 60;
    }
    get maxDurationSeconds() {
      return 120;
    }
    get autoRenew() {
      return false;
    }
  }
  const create = vi.fn(async () => connection(policy));
  const toolset = new MandalaBrowserToolset(
    {
      createBrowserConnection: create,
      revokeBrowserConnection: async () => {},
    } as unknown as Computer,
    { sessionPolicy: new Policy() },
  );
  // Public calls initialize lazily; the constructor passes an immutable policy
  // snapshot to the backend, inspected through the actual create call.
  try {
    await toolset.toolResult({
      type: 'tool_use',
      id: 'use',
      name: 'list_tabs',
      toolset_name: 'browser',
      input: {},
    });
    expect(create).toHaveBeenCalledWith({ sessionPolicy: { ...policy, autoRenew: false } });
  } finally {
    await toolset.close();
  }
});
it('refuses downgraded and inconsistent deadline responses', () => {
  expect(() =>
    BrowserConnection.fromApi(
      {
        id: ID,
        token: TOKEN,
        url: `wss://api.test/api/v1/computers/vm/browser-connections/${ID}/cdp`,
        expires_at: iso(60),
      },
      'https://api.test/api/v1',
      'computers/vm/browser-connections',
      policy,
    ),
  ).toThrow();
  for (const bad of [
    { id: 'b'.repeat(32) },
    { idle_timeout_seconds: 1 },
    { lease_expires_at: iso(121) },
    { server_time: iso(61) },
  ])
    expect(() => BrowserSessionLease.fromApi({ ...leaseData(), ...bad }, ID)).toThrow();
  const lease = snapshot();
  lease.absoluteExpiresAt.setTime(0);
  expect(+lease.absoluteExpiresAt).toBe(epoch + 120000);
});

it('binds downgrade refusal to the policy sent before caller options change', async () => {
  const { Client } = await import('../src/index.js');
  const { recorder, json } = await import('./harness.js');
  let reply!: (value: Response) => void;
  let sent!: () => void;
  const started = new Promise<void>((r) => {
    sent = r;
  });
  const rec = recorder((call) => {
    if (call.method === 'POST') {
      sent();
      return new Promise<Response>((r) => {
        reply = r;
      });
    }
    return json(call.method === 'DELETE' ? { ok: true } : { id: 'vm', status: 'running' });
  });
  const client = new Client({
    apiKey: 'com_test',
    baseUrl: 'https://api.test/api/v1',
    fetch: rec.fetch,
  });
  const computer = await client.computers.get('vm');
  const options: { sessionPolicy?: BrowserSessionPolicy } = { sessionPolicy: { ...policy } };
  const pending = computer.createBrowserConnection(options);
  const rejected = expect(pending).rejects.toThrow('invalid browser session lease');
  await started;
  options.sessionPolicy = undefined;
  reply(
    json({
      id: ID,
      url: `wss://api.test/api/v1/computers/vm/browser-connections/${ID}/cdp`,
      token: TOKEN,
      expires_at: iso(60),
    }),
  );
  await rejected;
  expect(rec.calls.find((c) => c.method === 'POST')?.body).toEqual({
    lifecycle_version: 2,
    lease_seconds: 60,
    max_duration_seconds: 120,
  });
  expect(rec.last().method).toBe('DELETE');
});
it('renews with account authorization and an empty body', async () => {
  const { Client } = await import('../src/index.js');
  const { recorder, json } = await import('./harness.js');
  const rec = recorder((call) =>
    json(call.method === 'POST' ? leaseData() : { id: 'vm', status: 'running' }),
  );
  const c = await new Client({
    apiKey: 'com_test',
    baseUrl: 'https://api.test/api/v1',
    fetch: rec.fetch,
  }).computers.get('vm');
  const renewed = await c.renewBrowserConnection(ID);
  expect(renewed.id).toBe(ID);
  expect(rec.last().body).toEqual({});
  expect(new Headers(rec.last().headers).get('authorization')).toBe('Bearer com_test');
});

// A refusal as the real client raises it from a browser-connection route.
async function refusal(
  status: number,
  body: Record<string, unknown>,
  route: 'create' | 'renew' = 'renew',
): Promise<APIError> {
  const { Client } = await import('../src/index.js');
  const { recorder, json } = await import('./harness.js');
  const rec = recorder((call) =>
    call.method === 'GET' ? json({ id: 'vm', status: 'running' }) : json(body, { status }),
  );
  const c = await new Client({
    apiKey: 'com_test',
    baseUrl: 'https://api.test/api/v1',
    fetch: rec.fetch,
  }).computers.get('vm');
  const error = await (route === 'renew'
    ? c.renewBrowserConnection(ID)
    : c.createBrowserConnection({ sessionPolicy: policy })
  ).then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(error instanceof APIError)) throw new Error('expected an API error');
  return error;
}

it('retries a renewal that fails in passing, with backoff, on the same session', async () => {
  const renew = vi.fn(async () => snapshot(40, 100));
  renew.mockRejectedValueOnce(
    new UnavailableError('unavailable', 503, {}, undefined, { method: 'POST' }),
  );
  renew.mockRejectedValueOnce(new ConnectionError('connection reset'));
  const { backend, create } = setup(renew);
  try {
    await backend.start();
    // Renewal starts at 40 s; the backoff is 500 ms, then a second.
    await vi.advanceTimersByTimeAsync(40000);
    expect(renew).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(499);
    expect(renew).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(renew).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(999);
    expect(renew).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(renew).toHaveBeenCalledTimes(3);
    expect(backend.sessionStatus().state).toBe('active');
    expect(backend.sessionStatus().remainingSeconds).toBeGreaterThan(59);
    expect(create).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.ended).toBe(false);
  } finally {
    await backend.close();
  }
});

it('waits at least as long as Retry-After before renewing again', async () => {
  const renew = vi.fn(async () => snapshot(40, 100));
  renew.mockRejectedValueOnce(await refusal(429, { error: 'rate limited' }));
  renew.mockRejectedValueOnce(new RateLimitError('slow down', 429, {}, 5000));
  const { backend } = setup(renew);
  try {
    await backend.start();
    await vi.advanceTimersByTimeAsync(40500);
    expect(renew).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(4999);
    expect(renew).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(renew).toHaveBeenCalledTimes(3);
    expect(backend.sessionStatus().state).toBe('active');
  } finally {
    await backend.close();
  }
});

it.each([
  [401, {}],
  [403, { reason: 'revoked' }],
  [404, {}],
  [409, {}],
  [409, { reason: 'unavailable' }],
  // Whatever word a 409 carries, renewal will not make the session active again.
  [409, { reason: 'contention' }],
  [400, {}],
])('ends the session at once when renewal is refused with %i %j', async (status, extra) => {
  const error = await refusal(status, {
    error: 'browser connection is not an active renewable session',
    ...extra,
  });
  const renew = vi.fn(async (): Promise<BrowserSessionLease> => {
    throw error;
  });
  const { backend } = setup(renew);
  try {
    await backend.start();
    await vi.advanceTimersByTimeAsync(40001);
    expect(backend.sessionStatus()).toMatchObject({
      state: 'ended',
      terminalError: expect.stringContaining('renewal failed'),
    });
    expect(sockets[0]!.ended).toBe(true);
    await vi.advanceTimersByTimeAsync(20000);
    expect(renew).toHaveBeenCalledTimes(1);
  } finally {
    await backend.close();
  }
});

it('stops retrying renewal shortly before the lease deadline', async () => {
  const renew = vi.fn(async (): Promise<BrowserSessionLease> => {
    throw new ConnectionError('connection refused');
  });
  const { backend } = setup(renew);
  try {
    await backend.start();
    // The lease has 20 seconds left when renewal starts.
    await vi.advanceTimersByTimeAsync(40001);
    await vi.advanceTimersByTimeAsync(17000);
    expect(backend.sessionStatus()).toMatchObject({
      state: 'ended',
      terminalError: expect.stringContaining('renewal failed'),
    });
    const attempts = renew.mock.calls.length;
    expect(attempts).toBeGreaterThan(3);
    await vi.advanceTimersByTimeAsync(60000);
    expect(renew).toHaveBeenCalledTimes(attempts);
  } finally {
    await backend.close();
  }
});

it('close during a renewal backoff stops it and revokes once', async () => {
  const renew = vi.fn(async (): Promise<BrowserSessionLease> => {
    throw new ConnectionError('connection refused');
  });
  const { backend, revoke } = setup(renew);
  await backend.start();
  await vi.advanceTimersByTimeAsync(40001);
  expect(renew).toHaveBeenCalledTimes(1);
  await backend.close();
  await vi.advanceTimersByTimeAsync(60000);
  expect(renew).toHaveBeenCalledTimes(1);
  expect(revoke).toHaveBeenCalledTimes(1);
  expect(backend.sessionStatus().state).toBe('ended');
});

it.each([
  ['create', 'unsupported', false],
  ['create', 'unavailable', false],
  ['create', 'contention', true],
  ['renew', 'unavailable', false],
  ['renew', 'revoked', false],
  ['renew', 'unsupported', false],
  ['renew', 'contention', true],
] as const)(
  'classifies a browser-connection %s 409 by its reason %s',
  async (route, reason, transient) => {
    const error = await refusal(409, { error: 'refused', reason }, route);
    expect(error).toBeInstanceOf(ConflictError);
    expect(error.reason).toBe(reason);
    expect(isTransient(error)).toBe(transient);
  },
);

it.each([
  ['legacy', undefined],
  ['renewable', policy],
])('revokes a %s grant whose create response fails validation', async (_name, sessionPolicy) => {
  const { Client } = await import('../src/index.js');
  const { recorder, json } = await import('./harness.js');
  const rec = recorder((call) =>
    json(
      call.method === 'POST'
        ? {
            id: ID,
            url: 'wss://elsewhere.test/cdp',
            token: TOKEN,
            expires_at: iso(60),
            ...(sessionPolicy ? leaseData() : {}),
          }
        : call.method === 'DELETE'
          ? { ok: true }
          : { id: 'vm', status: 'running' },
    ),
  );
  const c = await new Client({
    apiKey: 'com_test',
    baseUrl: 'https://api.test/api/v1',
    fetch: rec.fetch,
  }).computers.get('vm');
  await expect(c.createBrowserConnection(sessionPolicy ? { sessionPolicy } : {})).rejects.toThrow(
    'invalid browser connection response',
  );
  expect(rec.last()).toMatchObject({
    method: 'DELETE',
    path: `/computers/vm/browser-connections/${ID}`,
  });
});

it('sends no revoke for a create response whose id it cannot trust', async () => {
  const { Client } = await import('../src/index.js');
  const { recorder, json } = await import('./harness.js');
  const rec = recorder((call) =>
    json(
      call.method === 'POST'
        ? { id: '../escape', url: 'wss://elsewhere.test/cdp', token: TOKEN, expires_at: iso(60) }
        : { id: 'vm', status: 'running' },
    ),
  );
  const c = await new Client({
    apiKey: 'com_test',
    baseUrl: 'https://api.test/api/v1',
    fetch: rec.fetch,
  }).computers.get('vm');
  await expect(c.createBrowserConnection()).rejects.toThrow('invalid browser connection response');
  expect(rec.calls.map((call) => call.method)).toEqual(['GET', 'POST']);
});
