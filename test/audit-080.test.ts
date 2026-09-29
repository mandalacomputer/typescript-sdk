/**
 * The pre-0.8.0 parity fixes (OPL-5435): what the agent routes' 402 is, the
 * half-removed status, the saved-frame marker, the schedule the handle holds,
 * the template-publish conflicts, the rate-limit headers and the steps a
 * non-streaming agent run reports.
 */

import { describe, expect, it } from 'vitest';
import type { Computer } from '../src/index.js';
import {
  APIError,
  AuthenticationError,
  Client,
  ConflictError,
  IDEMPOTENCY_KEY_HEADER,
  isTransient,
  MandalaError,
  ModelProviderError,
  PlanLimitError,
  RateLimitError,
  TimeoutError,
} from '../src/index.js';
import { anyRoute, BASE, COMPUTER, json, type Responder, recorder } from './harness.js';

const client = (respond: Responder) => {
  const rec = recorder(respond);
  return { rec, client: new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch }) };
};

const errorStream = (payload: unknown) =>
  new Response(`event: error\ndata: ${JSON.stringify(payload)}\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  });

describe('a 402 from the agent routes', () => {
  const MODEL_402 = {
    error: 'model API: 402 billing_error: your credit balance is too low',
    status: 402,
    usage: { input_tokens: 10, output_tokens: 2 },
    steps: [{ n: 1, tool: 'computer', action: 'left_click' }],
  };

  it('is the model provider refusing the model key, not a plan limit, on agent()', async () => {
    const { client: c } = client((call) =>
      call.path.endsWith('/agent') ? errorStream(MODEL_402) : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    const err = await computer.agent({ prompt: 'go', modelKey: 'sk' }).catch((e) => e);
    expect(err).toBeInstanceOf(ModelProviderError);
    expect(err).toBeInstanceOf(APIError);
    expect(err).not.toBeInstanceOf(PlanLimitError);
    expect((err as APIError).status).toBe(402);
    expect((err as Error).message).toMatch(/X-Model-Key/);
    expect((err as Error).message).toMatch(/billing_error/);
    // The accounting still travels with it.
    expect((err as APIError).body).toMatchObject({ steps: [{ n: 1 }] });
    expect(isTransient(err)).toBe(false);
  });

  it('is the model provider refusing the model key on agentOnce()', async () => {
    const { client: c } = client((call) =>
      call.path.endsWith('/agent')
        ? json({ error: MODEL_402.error, usage: MODEL_402.usage, steps_taken: [] }, { status: 402 })
        : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    const err = await computer.agentOnce({ prompt: 'go', modelKey: 'sk' }).catch((e) => e);
    expect(err).toBeInstanceOf(ModelProviderError);
    expect(err).not.toBeInstanceOf(PlanLimitError);
    expect((err as APIError).method).toBe('POST');
    expect(isTransient(err)).toBe(false);
  });

  it('leaves every other agentOnce() status as it was', async () => {
    const { client: c } = client((call) =>
      call.path.endsWith('/agent')
        ? json({ error: 'revoked', reason: 'revoked' }, { status: 401 })
        : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    const err = await computer.agentOnce({ prompt: 'go', modelKey: 'sk' }).catch((e) => e);
    expect(err).toBeInstanceOf(AuthenticationError);
    expect((err as APIError).reason).toBe('revoked');
  });

  it('is still a PlanLimitError everywhere else', async () => {
    const { client: c } = client((call) =>
      call.method === 'POST' && call.path === '/computers'
        ? json({ error: 'your plan allows 4 computers' }, { status: 402 })
        : anyRoute(call),
    );
    const err = await c.computers.create({ template: 'base' }).catch((e) => e);
    expect(err).toBeInstanceOf(PlanLimitError);
    expect(err).not.toBeInstanceOf(ModelProviderError);
  });
});

describe('agentOnce() steps_taken', () => {
  it('decodes every step the non-streaming answer carried', async () => {
    const { client: c } = client((call) =>
      call.path.endsWith('/agent')
        ? json({
            steps: 2,
            stop: 'end_turn',
            text: 'done',
            steps_taken: [
              { n: 1, tool: 'computer', action: 'left_click', detail: 'clicked' },
              { tool: 'bash', detail: 'ls' },
            ],
          })
        : anyRoute(call),
    );
    const res = await (await c.computers.get('vm-1')).agentOnce({ prompt: 'go', modelKey: 'sk' });
    expect(res.stepsTaken).toEqual([
      { n: 1, tool: 'computer', action: 'left_click', detail: 'clicked', error: undefined },
      { n: 2, tool: 'bash', action: undefined, detail: 'ls', error: undefined },
    ]);
  });

  it('is absent when the answer carried none', async () => {
    const { client: c } = client((call) =>
      call.path.endsWith('/agent')
        ? json({ steps: 0, stop: 'end_turn', text: 'done' })
        : anyRoute(call),
    );
    const res = await (await c.computers.get('vm-1')).agentOnce({ prompt: 'go', modelKey: 'sk' });
    expect(res.stepsTaken).toBeUndefined();
    expect('stepsTaken' in res).toBe(false);
  });
});

describe('a half-removed computer', () => {
  const HALF = { ...COMPUTER, status: 'half-removed', running_ram_mb: 0 };
  const SAYS =
    /vm-1 is half-removed: its files were partly removed, it cannot be started .* delete\(\)/;

  it('is named on the handle', async () => {
    const { client: c } = client(() => json(HALF));
    const computer = await c.computers.get('vm-1');
    expect(computer.halfRemoved).toBe(true);
    expect(computer.buildFailed).toBe(false);
  });

  it.each([
    ['waitUntilRunning', 'waitUntilRunning'],
    ['waitForGuest', 'waitForGuest'],
    ['waitUntilBuilt', 'waitUntilBuilt'],
  ] as const)('fails %s at once rather than polling to a timeout', async (_, wait) => {
    const { client: c } = client(() => json(HALF));
    const computer = await c.computers.get('vm-1');
    const started = performance.now();
    const err = await computer[wait]({ timeoutMs: 2_000, pollMs: 10 }).then(
      () => 'returned',
      (e) => e,
    );
    expect(err).toBeInstanceOf(MandalaError);
    expect(err).not.toBeInstanceOf(TimeoutError);
    expect((err as Error).message).toMatch(SAYS);
    expect(performance.now() - started).toBeLessThan(1_500);
  });

  // The three waits launch runs after the guest answers, each on a record that
  // names what it would otherwise wait for: without the half-removed check
  // each would refuse with "call start()", which cannot help.
  it.each([
    [
      'waitForSecrets',
      { secrets: [{ secret_id: 'csec-0123456789abcdef', revision_id: 'csr-1', env: 'TOKEN' }] },
      (vm: Computer) => vm.waitForSecrets({ timeoutMs: 2_000, pollMs: 10, expectSecrets: true }),
    ],
    [
      'waitForBrowserProxy',
      { browser_proxy: { server: 'http://proxy.example.com:3128' } },
      (vm: Computer) =>
        vm.waitForBrowserProxy({ timeoutMs: 2_000, pollMs: 10, expectBrowserProxy: true }),
    ],
    [
      'waitForEgressProxy',
      {
        egress_proxy: {
          server: 'https://proxy.example.com:3128',
          credentials_secret_id: 'csec-0123456789abcdef',
        },
      },
      (vm: Computer) => vm.waitForEgressProxy({ timeoutMs: 2_000, pollMs: 10 }),
    ],
  ] as const)('fails %s at once rather than asking for a start', async (_, extra, wait) => {
    const { client: c } = client(() => json({ ...HALF, ...extra }));
    const computer = await c.computers.get('vm-1');
    const started = performance.now();
    const err = await wait(computer).then(
      () => 'returned',
      (e) => e,
    );
    expect(err).toBeInstanceOf(MandalaError);
    expect(err).not.toBeInstanceOf(TimeoutError);
    expect((err as Error).message).toMatch(SAYS);
    expect(performance.now() - started).toBeLessThan(1_500);
  });

  it('fails a launch at once when its computer turns half-removed', async () => {
    const { client: c } = client((call) =>
      call.method === 'POST' && call.path === '/computers'
        ? json({ ...COMPUTER, status: 'building' })
        : call.method === 'GET' && call.path === '/computers/vm-1'
          ? json(HALF)
          : anyRoute(call),
    );
    const err = await c.computers
      .launch({ template: 'base' }, { timeoutMs: 2_000, pollMs: 10 })
      .catch((e) => e);
    expect(err).toBeInstanceOf(MandalaError);
    expect(err).not.toBeInstanceOf(TimeoutError);
    expect((err as Error).message).toMatch(/^launch of vm-1 failed: /);
    expect((err as Error).message).toMatch(SAYS);
  });
});

describe('screenshotWithInfo()', () => {
  it('says when the picture is a suspended computer’s saved frame', async () => {
    const { client: c } = client((call) =>
      call.path.endsWith('/screenshot')
        ? new Response(Uint8Array.from([255, 216, 255]), {
            headers: { 'content-type': 'image/jpeg', 'x-gc-frame': 'suspended' },
          })
        : anyRoute(call),
    );
    const shot = await (await c.computers.get('vm-1')).screenshotWithInfo();
    expect(shot).toEqual({
      bytes: Uint8Array.from([255, 216, 255]),
      contentType: 'image/jpeg',
      suspended: true,
    });
  });

  it('reads a live capture as not suspended', async () => {
    const { client: c } = client((call) =>
      call.path.endsWith('/screenshot')
        ? new Response(Uint8Array.from([137, 80]), { headers: { 'content-type': 'image/png' } })
        : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    expect((await computer.screenshotWithInfo()).suspended).toBe(false);
    expect(await computer.screenshot()).toEqual(Uint8Array.from([137, 80]));
  });
});

describe('the schedule on the handle', () => {
  const WINDOW = { enabled: true, hour: 6, minute: 15, tz: 'Asia/Tokyo' };

  it('keeps a create’s startError through a setSchedule that reads the current window', async () => {
    // A refresh replaced the whole record, and with it the start_error the
    // waits fail fast on.
    const { client: c } = client((call) => {
      if (call.method === 'POST' && call.path === '/computers')
        return json({
          computer: { ...COMPUTER, status: 'stopped' },
          start_error: 'no host had room',
        });
      if (call.method === 'GET' && call.path === '/computers/vm-1')
        return json({ ...COMPUTER, status: 'stopped', snapshot_schedule: WINDOW });
      if (call.path.endsWith('/schedule')) return json(call.body);
      return anyRoute(call);
    });
    const computer = await c.computers.create({ template: 'base' });
    await computer.setSchedule({ enabled: false });
    expect(computer.startError).toBe('no host had room');
    expect(computer.snapshotSchedule).toEqual({ ...WINDOW, enabled: false });
  });

  it('writes what the platform stored into snapshotSchedule, and clears it', async () => {
    const { client: c } = client((call) => {
      if (call.method === 'PUT' && call.path.endsWith('/schedule')) return json(call.body);
      if (call.method === 'DELETE' && call.path.endsWith('/schedule')) return json({});
      return json({ ...COMPUTER, snapshot_schedule: WINDOW });
    });
    const computer = await c.computers.get('vm-1');
    expect(computer.snapshotSchedule).toEqual(WINDOW);
    await computer.setSchedule({ enabled: true, hour: 1, minute: 2, tz: 'UTC' });
    expect(computer.snapshotSchedule).toEqual({ enabled: true, hour: 1, minute: 2, tz: 'UTC' });
    await computer.clearSchedule();
    expect(computer.snapshotSchedule).toBeUndefined();
  });
});

describe('templates.publish() conflicts', () => {
  const DOC = 'apiVersion: mandala/v1\nkind: Template\n';

  it('are permanent to isTransient when the platform sent no reason', async () => {
    const { client: c } = client(() =>
      json(
        { error: 'acme/devbox@1.0.0 is already published, as a different document' },
        { status: 409 },
      ),
    );
    const err = await c.templates.publish(DOC).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as APIError).reason).toBe('exists');
    expect(isTransient(err)).toBe(false);
  });

  it('keep a reason the platform did send', async () => {
    const { client: c } = client(() =>
      json({ error: 'the store is full', reason: 'unavailable' }, { status: 409 }),
    );
    const err = await c.templates.publish(DOC).catch((e) => e);
    expect((err as APIError).reason).toBe('unavailable');
    expect(isTransient(err)).toBe(false);
  });

  it('leave a conflict from any other route transient, as it was', async () => {
    const { client: c } = client((call) =>
      call.path.endsWith('/start') ? json({ error: 'busy' }, { status: 409 }) : anyRoute(call),
    );
    const err = await (await c.computers.get('vm-1')).start().catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as APIError).reason).toBeUndefined();
    expect(isTransient(err)).toBe(true);
  });
});

describe('RateLimitError', () => {
  it('carries the RateLimit-* headers of the refusal', async () => {
    const { client: c } = client(
      () =>
        new Response(JSON.stringify({ error: 'slow down' }), {
          status: 429,
          headers: {
            'content-type': 'application/json',
            'retry-after': '3',
            'ratelimit-limit': '10800',
            'ratelimit-remaining': '0',
            'ratelimit-reset': '3',
          },
        }),
    );
    const err = await c.computers.create({ template: 'base' }).catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    const limited = err as RateLimitError;
    expect([limited.limit, limited.remaining, limited.resetSeconds]).toEqual([10800, 0, 3]);
    expect(limited.retryAfterMs).toBe(3_000);
  });

  it('leaves each one absent when it was not sent or not a count', async () => {
    const { client: c } = client(
      () =>
        new Response(JSON.stringify({ error: 'slow down' }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'ratelimit-remaining': '-1' },
        }),
    );
    const err = (await c.computers.create({ template: 'base' }).catch((e) => e)) as RateLimitError;
    expect([err.limit, err.remaining, err.resetSeconds]).toEqual([undefined, undefined, undefined]);
  });
});

describe('the key an error from launch() carries', () => {
  const STOPPED = { ...COMPUTER, status: 'stopped', running_ram_mb: 0 };
  // The create succeeds and comes back stopped; the start launch then makes
  // is refused before it reached anything (a 5xx naming no operation), which
  // releases the start's key.
  const respond = (call: Parameters<Responder>[0]) =>
    call.method === 'POST' && call.path === '/computers'
      ? json(STOPPED)
      : call.method === 'GET' && call.path === '/computers/vm-1'
        ? json(STOPPED)
        : call.method === 'POST' && call.path === '/computers/vm-1/start'
          ? json({ error: 'No hypervisor could answer that right now.' }, { status: 503 })
          : anyRoute(call);

  it.each([
    ['given', 'launch-key-1'],
    ['made', undefined],
  ] as const)('is the create key it was %s, never the start’s', async (_, key) => {
    const { rec, client: c } = client(respond);
    const err = await c.computers
      .launch(
        { template: 'base', start: false },
        { timeoutMs: 60_000, pollMs: 10, idempotencyKey: key },
      )
      .catch((e) => e);
    expect(err).toBeInstanceOf(APIError);
    expect((err as APIError).status).toBe(503);
    const create = rec.calls.find((x) => x.method === 'POST' && x.path === '/computers');
    const start = rec.calls.find((x) => x.method === 'POST' && x.path === '/computers/vm-1/start');
    const launchKey = create?.headers[IDEMPOTENCY_KEY_HEADER];
    const startKey = start?.headers[IDEMPOTENCY_KEY_HEADER];
    expect(launchKey).toBeDefined();
    expect(startKey).toBeDefined();
    expect(startKey).not.toBe(launchKey);
    if (key !== undefined) expect(launchKey).toBe(key);
    expect((err as MandalaError).idempotencyKey).toBe(launchKey);
    expect((err as MandalaError).idempotencyKey).not.toBe(startKey);
  });
});
