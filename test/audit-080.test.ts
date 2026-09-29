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

  // A start that fails naming its operation: the error then names two
  // operations' handles, and each must stay the one the docs say it is — the
  // key replays launch's create, the operation id is the failed start's.
  it('is the create key beside the failed start’s own operation id', async () => {
    const { rec, client: c } = client((call) =>
      call.method === 'POST' && call.path === '/computers/vm-1/start'
        ? json(
            { error: 'The start was not heard to end.', operation_id: 'op-start' },
            { status: 500 },
          )
        : respond(call),
    );
    const err = await c.computers
      .launch({ template: 'base', start: false }, { timeoutMs: 60_000, pollMs: 10 })
      .catch((e) => e);
    expect(err).toBeInstanceOf(APIError);
    expect((err as APIError).status).toBe(500);
    expect((err as APIError).operationId).toBe('op-start');
    const create = rec.calls.find((x) => x.method === 'POST' && x.path === '/computers');
    const start = rec.calls.find((x) => x.method === 'POST' && x.path === '/computers/vm-1/start');
    const launchKey = create?.headers[IDEMPOTENCY_KEY_HEADER];
    const startKey = start?.headers[IDEMPOTENCY_KEY_HEADER];
    expect(launchKey).toBeDefined();
    expect(startKey).toBeDefined();
    expect((err as MandalaError).idempotencyKey).toBe(launchKey);
    expect((err as MandalaError).idempotencyKey).not.toBe(startKey);
  });

  // A start refused with a 4xx settles nothing about the create's key, so the
  // error carries none: the docs send the caller to the computer it names, or
  // to the key they passed themselves, never to an absent err.idempotencyKey.
  it.each([
    [402, { error: 'plan RAM full' }],
    [409, { error: 'already starting' }],
  ] as const)(
    'is absent when the start is refused %s, and the prefix stays',
    async (status, body) => {
      const { client: c } = client((call) =>
        call.method === 'POST' && call.path === '/computers/vm-1/start'
          ? json(body, { status })
          : respond(call),
      );
      const err = await c.computers
        .launch({ template: 'base', start: false }, { timeoutMs: 60_000, pollMs: 10 })
        .catch((e) => e);
      expect(err).toBeInstanceOf(APIError);
      expect((err as APIError).status).toBe(status);
      expect((err as Error).message).toMatch(/^launch of vm-1 failed: /);
      expect((err as MandalaError).idempotencyKey).toBeUndefined();
    },
  );

  // The create itself failing is NOT the exception the docs carve out: the
  // error is the create's own, with no `launch of` prefix, and its key and
  // operation id both belong to that create, under the ordinary rules.
  it('is the create’s own error, key and operation id when the create fails', async () => {
    const { rec, client: c } = client((call) =>
      call.method === 'POST' && call.path === '/computers'
        ? json(
            { error: 'The create was not heard to end.', operation_id: 'op-create' },
            { status: 500 },
          )
        : respond(call),
    );
    const err = await c.computers
      .launch({ template: 'base' }, { timeoutMs: 60_000, pollMs: 10, idempotencyKey: 'lk-2' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(APIError);
    expect((err as APIError).status).toBe(500);
    expect((err as Error).message).not.toMatch(/^launch of /);
    expect((err as APIError).operationId).toBe('op-create');
    const creates = rec.calls.filter((x) => x.method === 'POST' && x.path === '/computers');
    expect(creates.map((x) => x.headers[IDEMPOTENCY_KEY_HEADER])).toContain('lk-2');
    expect((err as MandalaError).idempotencyKey).toBe('lk-2');
    // Nothing ran after it.
    expect(rec.calls.some((x) => x.path.startsWith('/computers/vm-1'))).toBe(false);
  });
});

describe('launch() resent under its key, when the create is replayed', () => {
  // The platform stores a create's whole 2xx answer and hands it back to a
  // resend under the same key (Idempotent-Replayed: true), start_error,
  // status and held RAM included. That answer describes the first attempt,
  // up to 24 hours ago, so launch must read the computer afresh before acting
  // on it, or the documented recovery (resend launch with the key) could
  // never converge.
  const replayed = (body: unknown) =>
    json(body, {
      status: 201,
      headers: { 'content-type': 'application/json', 'Idempotent-Replayed': 'true' },
    });
  // GET answers `before` until a start is sent, then a running computer.
  const flow = (create: Response, before: Record<string, unknown>) => {
    let started = false;
    return (call: Parameters<Responder>[0]) => {
      if (call.method === 'POST' && call.path === '/computers') return create.clone();
      if (call.method === 'POST' && call.path === '/computers/vm-1/start') {
        started = true;
        return json({ ...COMPUTER, status: 'running', running_ram_mb: 4096 });
      }
      if (call.method === 'GET' && call.path === '/computers/vm-1') {
        return json(started ? { ...COMPUTER, status: 'running', running_ram_mb: 4096 } : before);
      }
      return anyRoute(call);
    };
  };
  const starts = (rec: ReturnType<typeof recorder>) =>
    rec.calls.filter((x) => x.method === 'POST' && x.path === '/computers/vm-1/start').length;

  it('starts a computer suspended since the recorded answer said running', async () => {
    const { rec, client: c } = client(
      flow(replayed({ ...COMPUTER, status: 'running', running_ram_mb: 4096 }), {
        ...COMPUTER,
        status: 'suspended',
        running_ram_mb: 0,
      }),
    );
    const computer = await c.computers.launch(
      { template: 'base' },
      { timeoutMs: 60_000, pollMs: 10, idempotencyKey: 'K' },
    );
    expect(computer.status).toBe('running');
    expect(starts(rec)).toBe(1);
  });

  it('starts again rather than rethrowing the recorded start_error', async () => {
    const { rec, client: c } = client(
      flow(
        replayed({
          computer: { ...COMPUTER, status: 'stopped', running_ram_mb: 0 },
          start_error: 'no room',
        }),
        { ...COMPUTER, status: 'stopped', running_ram_mb: 0 },
      ),
    );
    const computer = await c.computers.launch(
      { template: 'base' },
      { timeoutMs: 60_000, pollMs: 10, idempotencyKey: 'K' },
    );
    expect(computer.status).toBe('running');
    expect(starts(rec)).toBe(1);
  });

  it('still throws a fresh create’s start_error, and sends no start', async () => {
    const { rec, client: c } = client(
      flow(
        json(
          {
            computer: { ...COMPUTER, status: 'stopped', running_ram_mb: 0 },
            start_error: 'no room',
          },
          { status: 201 },
        ),
        { ...COMPUTER, status: 'stopped', running_ram_mb: 0 },
      ),
    );
    const err = await c.computers
      .launch({ template: 'base' }, { timeoutMs: 60_000, pollMs: 10, idempotencyKey: 'K' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(MandalaError);
    expect((err as Error).message).toBe('launch of vm-1 failed: did not start: no room');
    expect(starts(rec)).toBe(0);
  });

  it('trusts a fresh create’s running answer without a start', async () => {
    const { rec, client: c } = client(
      flow(json({ ...COMPUTER, status: 'running', running_ram_mb: 4096 }, { status: 201 }), {
        ...COMPUTER,
        status: 'running',
        running_ram_mb: 4096,
      }),
    );
    await c.computers.launch({ template: 'base' }, { timeoutMs: 60_000, pollMs: 10 });
    expect(starts(rec)).toBe(0);
  });
});

describe('the reason word on an agent route’s 403', () => {
  // The docs tell a caller who must tell a revocation from the model key's own
  // permission_error which surface keeps the word: agent() withholds it from a
  // refusal that arrives as the run's error event, agentStream()'s raw and
  // agentOnce()'s HTTP error keep it, and a 403 answered before the stream
  // opens keeps it on agent() and agentStream() alike.
  const FRAME = { error: 'credential revoked', status: 403, reason: 'revoked' };

  it('is withheld from the error agent() throws', async () => {
    const { client: c } = client((call) =>
      call.path.endsWith('/agent') ? errorStream(FRAME) : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    const err = await computer.agent({ prompt: 'go', modelKey: 'sk' }).catch((e) => e);
    expect((err as APIError).status).toBe(403);
    expect((err as APIError).reason).toBeUndefined();
    expect(((err as APIError).body as Record<string, unknown>).reason).toBeUndefined();
  });

  it('is on agentStream()’s error event raw', async () => {
    const { client: c } = client((call) =>
      call.path.endsWith('/agent') ? errorStream(FRAME) : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    let raw: Record<string, unknown> | undefined;
    for await (const ev of computer.agentStream({ prompt: 'go', modelKey: 'sk' })) {
      if (ev.type === 'error') raw = ev.raw;
    }
    expect(raw?.reason).toBe('revoked');
  });

  it('is kept on agent() and agentStream() when the 403 comes before the stream', async () => {
    const { client: c } = client((call) =>
      call.path.endsWith('/agent')
        ? json({ error: 'credential revoked', reason: 'revoked' }, { status: 403 })
        : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    const err = await computer.agent({ prompt: 'go', modelKey: 'sk' }).catch((e) => e);
    expect((err as APIError).status).toBe(403);
    expect((err as APIError).reason).toBe('revoked');
    const events: unknown[] = [];
    const streamErr = await (async () => {
      for await (const ev of computer.agentStream({ prompt: 'go', modelKey: 'sk' })) {
        events.push(ev);
      }
    })().catch((e) => e);
    expect(events).toEqual([]);
    expect((streamErr as APIError).status).toBe(403);
    expect((streamErr as APIError).reason).toBe('revoked');
  });

  it('is kept on the error agentOnce() throws', async () => {
    const { client: c } = client((call) =>
      call.path.endsWith('/agent')
        ? json({ error: 'credential revoked', reason: 'revoked' }, { status: 403 })
        : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    const err = await computer.agentOnce({ prompt: 'go', modelKey: 'sk' }).catch((e) => e);
    expect((err as APIError).status).toBe(403);
    expect((err as APIError).reason).toBe('revoked');
  });
});
