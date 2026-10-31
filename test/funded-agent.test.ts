/**
 * Agent runs on the account's AI credits (OPL-5866), and the credit ledger
 * that funds them: an omitted `modelKey` is a funded run, `maxCostUsd` is its
 * budget, the cost fields decode strictly, and the platform's 402 with
 * `top_up_url` is an `InsufficientCreditsError` rather than the model
 * provider's billing refusal.
 */

import { describe, expect, it } from 'vitest';
import { toAgentEvent } from '../src/agent.js';
import {
  type AgentEvent,
  APIError,
  AuthenticationError,
  Client,
  InsufficientCreditsError,
  isTransient,
  MandalaError,
  ModelProviderError,
  NotFoundError,
  PermissionDeniedError,
  PlanLimitError,
  ValidationError,
} from '../src/index.js';
import { toActivity, toCreditReport } from '../src/models.js';
import { ACTIVITY, anyRoute, BASE, CREDITS, json, type Responder, recorder } from './harness.js';

const setup = (respond: Responder = anyRoute) => {
  const rec = recorder(respond);
  const client = new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch });
  return { rec, client };
};

const sse = (...frames: [string, unknown][]) =>
  new Response(frames.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });

const onAgent =
  (answer: (call: Parameters<Responder>[0]) => Response): Responder =>
  (call) =>
    call.path.endsWith('/agent') ? answer(call) : anyRoute(call);

const USAGE = { input_tokens: 10, output_tokens: 2, cache_read_tokens: 0, cache_write_tokens: 0 };
const SHORT = { error: 'Insufficient AI credits', top_up_url: '/billing' };
const TOP_UP = 'https://api.test/billing';

const consume = async (events: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> => {
  const seen: AgentEvent[] = [];
  for await (const ev of events) seen.push(ev);
  return seen;
};

describe('a run on AI credits', () => {
  it.each(['agent', 'agentOnce', 'agentStream'] as const)(
    '%s sends no X-Model-Key and forwards max_cost_usd',
    async (method) => {
      const { rec, client } = setup();
      const c = await client.computers.get('vm-1');
      const args = { prompt: 'go', maxCostUsd: 0.25 };
      if (method === 'agentStream') await consume(c.agentStream(args));
      else await c[method](args);
      const sent = rec.last();
      expect(sent.path).toBe('/computers/vm-1/agent');
      expect(Object.keys(sent.headers).map((h) => h.toLowerCase())).not.toContain('x-model-key');
      expect(sent.body).toMatchObject({ prompt: 'go', max_cost_usd: 0.25 });
    },
  );

  it('still sends the key, and the cap, when both are given', async () => {
    const { rec, client } = setup();
    const c = await client.computers.get('vm-1');
    await c.agentOnce({ prompt: 'go', modelKey: ' sk-own ', maxCostUsd: 20 });
    expect(rec.last().headers['X-Model-Key']).toBe('sk-own');
    expect(rec.last().body).toMatchObject({ max_cost_usd: 20 });
  });

  it('sends no max_cost_usd when none is given', async () => {
    const { rec, client } = setup();
    const c = await client.computers.get('vm-1');
    await c.agentOnce({ prompt: 'go' });
    expect(rec.last().body).not.toHaveProperty('max_cost_usd');
  });

  it.each([0.24, 20.01, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, '2' as unknown as number])(
    'refuses maxCostUsd %s before anything is sent',
    async (maxCostUsd) => {
      const { rec, client } = setup();
      const c = await client.computers.get('vm-1');
      const before = rec.calls.length;
      await expect(c.agent({ prompt: 'go', maxCostUsd })).rejects.toThrow(ValidationError);
      await expect(c.agentOnce({ prompt: 'go', maxCostUsd })).rejects.toThrow(ValidationError);
      expect(() => c.agentStream({ prompt: 'go', maxCostUsd })).toThrow(ValidationError);
      expect(rec.calls).toHaveLength(before);
    },
  );

  it.each(['', '   ', null, 7])(
    'refuses a modelKey that is given but not a key: %j',
    async (key) => {
      const { rec, client } = setup();
      const c = await client.computers.get('vm-1');
      const before = rec.calls.length;
      const modelKey = key as unknown as string;
      await expect(c.agent({ prompt: 'go', modelKey })).rejects.toThrow(ValidationError);
      await expect(c.agentOnce({ prompt: 'go', modelKey })).rejects.toThrow(ValidationError);
      expect(() => c.agentStream({ prompt: 'go', modelKey })).toThrow(ValidationError);
      expect(rec.calls).toHaveLength(before);
    },
  );
});

describe('what a funded run reports', () => {
  it('decodes cost on each step and on the result, and a negative balance', async () => {
    const { client } = setup(
      onAgent(() =>
        sse(
          ['step', { n: 1, tool: 'computer', cost_usd: 0.31, credits_remaining_usd: 4.5 }],
          ['step', { n: 2, tool: 'computer', cost_usd: 0.31, credits_remaining_usd: -0.12 }],
          ['done', { steps: 2, stop: 'max_cost', text: 'stopped', usage: USAGE, cost_usd: 1.87 }],
        ),
      ),
    );
    const c = await client.computers.get('vm-1');
    const events = await consume(c.agentStream({ prompt: 'go' }));
    const steps = events.flatMap((e) => (e.type === 'step' ? [e.step] : []));
    expect(steps.map((s) => [s.costUsd, s.creditsRemainingUsd])).toEqual([
      [0.31, 4.5],
      [0.31, -0.12],
    ]);
    const done = events.at(-1);
    expect(done?.type === 'done' && done.result).toMatchObject({
      stop: 'max_cost',
      finished: false,
      costUsd: 1.87,
    });
  });

  it('decodes the cost on a non-streaming result and its steps', async () => {
    const { client } = setup(
      onAgent(() =>
        json({
          steps: 1,
          stop: 'end_turn',
          text: 'done',
          usage: USAGE,
          cost_usd: 0.42,
          steps_taken: [{ n: 1, tool: 'bash', cost_usd: 0.42, credits_remaining_usd: 9.58 }],
        }),
      ),
    );
    const result = await (await client.computers.get('vm-1')).agentOnce({ prompt: 'go' });
    expect(result.costUsd).toBe(0.42);
    expect(result.stepsTaken?.[0]).toMatchObject({ costUsd: 0.42, creditsRemainingUsd: 9.58 });
  });

  it('leaves cost absent on a run on your own key, and on anything not a number', () => {
    const byok = toAgentEvent('done', { steps: 0, stop: 'end_turn', usage: USAGE }, 0);
    expect(byok?.type === 'done' && 'costUsd' in byok.result).toBe(false);
    for (const bad of ['0.5', -0.01, Number.NaN, null, [1], { usd: 1 }]) {
      const step = toAgentEvent('step', { n: 1, tool: 'x', cost_usd: bad }, 0);
      expect(step?.type === 'step' && step.step.costUsd).toBeUndefined();
      const done = toAgentEvent('done', { stop: 'end_turn', cost_usd: bad }, 0);
      expect(done?.type === 'done' && done.result.costUsd).toBeUndefined();
    }
    for (const bad of ['-1', Number.POSITIVE_INFINITY, true]) {
      const step = toAgentEvent('step', { n: 1, tool: 'x', credits_remaining_usd: bad }, 0);
      expect(step?.type === 'step' && step.step.creditsRemainingUsd).toBeUndefined();
    }
  });

  it('carries cost and the top-up link on an error frame', () => {
    const ev = toAgentEvent(
      'error',
      { ...SHORT, status: 402, cost_usd: 0, usage: USAGE, steps: [] },
      0,
      BASE,
    );
    expect(ev).toMatchObject({ type: 'error', status: 402, costUsd: 0, topUpUrl: TOP_UP });
  });

  it('keeps only an http(s) top-up link', () => {
    for (const url of ['javascript:alert(1)', '  ', 7]) {
      const ev = toAgentEvent('error', { error: 'x', status: 402, top_up_url: url }, 0, BASE);
      expect(ev?.type === 'error' && ev.topUpUrl).toBeUndefined();
    }
    const absolute = toAgentEvent(
      'error',
      { error: 'x', status: 402, top_up_url: 'https://billing.example/top-up' },
      0,
      BASE,
    );
    expect(absolute?.type === 'error' && absolute.topUpUrl).toBe('https://billing.example/top-up');
  });

  it('decodes funded and cost on an activity row', () => {
    const row = toActivity({ ...ACTIVITY, funded: true, cost_usd: 1.25 });
    expect(row).toMatchObject({ funded: true, costUsd: 1.25 });
    const byok = toActivity({ ...ACTIVITY, funded: false, cost_usd: 0 });
    expect(byok).toMatchObject({ funded: false, costUsd: 0 });
    const odd = toActivity({ ...ACTIVITY, funded: 'yes', cost_usd: '1' });
    expect(odd.funded).toBeUndefined();
    expect(odd.costUsd).toBeUndefined();
  });
});

describe('a funded run the credits cannot start', () => {
  it('is InsufficientCreditsError when refused before the stream, from agent() and agentStream()', async () => {
    const { client } = setup(onAgent(() => json(SHORT, { status: 402 })));
    const c = await client.computers.get('vm-1');
    const err = await c.agent({ prompt: 'go' }).catch((e) => e);
    expect(err).toBeInstanceOf(InsufficientCreditsError);
    expect(err).not.toBeInstanceOf(PlanLimitError);
    expect(err).not.toBeInstanceOf(ModelProviderError);
    expect(err.status).toBe(402);
    expect(err.topUpUrl).toBe(TOP_UP);
    expect(err.message).toContain(TOP_UP);
    expect(err.body).toMatchObject(SHORT);
    expect(isTransient(err)).toBe(false);
    const streamed = await consume(c.agentStream({ prompt: 'go' })).catch((e) => e);
    expect(streamed).toBeInstanceOf(InsufficientCreditsError);
    expect(streamed.topUpUrl).toBe(TOP_UP);
  });

  it('is InsufficientCreditsError from agentOnce()', async () => {
    const { client } = setup(
      onAgent(() =>
        json({ ...SHORT, cost_usd: 0, usage: USAGE, steps_taken: [] }, { status: 402 }),
      ),
    );
    const err = await (await client.computers.get('vm-1'))
      .agentOnce({ prompt: 'go' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(InsufficientCreditsError);
    expect(err.topUpUrl).toBe(TOP_UP);
  });

  it('is InsufficientCreditsError from agent() when it arrives as the error frame', async () => {
    const frame = { ...SHORT, status: 402, cost_usd: 0, usage: USAGE, steps: [] };
    const { client } = setup(onAgent(() => sse(['error', frame])));
    const c = await client.computers.get('vm-1');
    const err = await c.agent({ prompt: 'go' }).catch((e) => e);
    expect(err).toBeInstanceOf(InsufficientCreditsError);
    expect(err.topUpUrl).toBe(TOP_UP);
    const events = await consume(c.agentStream({ prompt: 'go' }));
    expect(events).toEqual([
      expect.objectContaining({ type: 'error', status: 402, topUpUrl: TOP_UP, costUsd: 0 }),
    ]);
  });

  it('leaves a 402 without top_up_url as the model provider’s on your own key', async () => {
    const { client } = setup(
      onAgent(() => json({ error: 'model API: billing', usage: USAGE }, { status: 402 })),
    );
    const err = await (await client.computers.get('vm-1'))
      .agentOnce({ prompt: 'go', modelKey: 'sk' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ModelProviderError);
  });

  it('does not blame a key nobody sent for a 402 without top_up_url on a funded run', async () => {
    const frame = { error: 'Mandala AI is unavailable', status: 402, usage: USAGE, steps: [] };
    const { client } = setup(onAgent(() => sse(['error', frame])));
    const err = await (await client.computers.get('vm-1')).agent({ prompt: 'go' }).catch((e) => e);
    expect(err).toBeInstanceOf(APIError);
    expect(err).not.toBeInstanceOf(ModelProviderError);
    expect(err).not.toBeInstanceOf(PlanLimitError);
    expect(err.message).not.toContain('X-Model-Key');
  });
});

describe('client.credits.read()', () => {
  it('reads the newest page with a bare GET and decodes every field', async () => {
    const { rec, client } = setup();
    const report = await client.credits.read();
    expect(rec.routes()).toEqual([['GET', 'credits']]);
    expect(rec.last().query).toEqual({});
    expect(report).toMatchObject({
      balanceMicros: 12_345_678,
      availableMicros: 11_845_678,
      heldMicros: 250_000,
      debtMicros: 250_000,
      frozen: false,
      grant: {
        periodStart: '2026-10-01T00:00:00.000Z',
        periodEnd: '2026-11-01T00:00:00.000Z',
        grantedMicros: 10_000_000,
        usedMicros: 2_654_322,
      },
      nextBefore: 41,
    });
    expect(report.lots[1]).toEqual({
      id: 'lot_topup',
      kind: 'topup',
      amountMicros: 5_000_000,
      remainingMicros: 5_000_000,
      expiresAt: '2027-10-02T09:30:00.000Z',
      createdAt: '2026-10-02T09:30:00.000Z',
    });
    expect(report.entries).toEqual([
      {
        id: 42,
        lotId: null,
        kind: 'debit',
        amountMicros: 1_234_567,
        debtMicros: 0,
        model: 'claude-sonnet-5-5',
        runId: 'run-1',
        step: 3,
        createdAt: '2026-10-09T12:00:00.000Z',
      },
      {
        id: 41,
        lotId: 'lot_grant',
        kind: 'credit',
        amountMicros: 10_000_000,
        debtMicros: 0,
        model: null,
        runId: null,
        step: null,
        createdAt: '2026-10-01T00:00:05.000Z',
      },
    ]);
    expect(report.raw).toEqual(CREDITS);
  });

  // OPL-6261: how the account pays, and on pay as you go its burn and runway.
  it('decodes the billing mode, burn and runway, and reads their absence as unknown', () => {
    const payg = toCreditReport(
      { ...CREDITS, billing_mode: 'payg', burn_micros_per_hour: 122_738, runway_seconds: 272_189 },
      'GET',
      '/credits',
    );
    expect(payg).toMatchObject({
      billingMode: 'payg',
      burnMicrosPerHour: 122_738,
      runwaySeconds: 272_189,
    });
    const idle = toCreditReport(
      { ...CREDITS, billing_mode: 'payg', burn_micros_per_hour: 0, runway_seconds: null },
      'GET',
      '/credits',
    );
    expect(idle).toMatchObject({ burnMicrosPerHour: 0, runwaySeconds: null });
    expect(toCreditReport(CREDITS, 'GET', '/credits')).toMatchObject({
      billingMode: null,
      burnMicrosPerHour: null,
      runwaySeconds: null,
    });
    expect(() =>
      toCreditReport(
        { ...CREDITS, billing_mode: 'payg', burn_micros_per_hour: -1 },
        'GET',
        '/credits',
      ),
    ).toThrow(/burn_micros_per_hour/);
    expect(() => toCreditReport({ ...CREDITS, billing_mode: 7 }, 'GET', '/credits')).toThrow(
      /billing_mode/,
    );
  });

  it('sends before and limit', async () => {
    const { rec, client } = setup();
    await client.credits.read({ before: 41, limit: 100 });
    expect(rec.last().query).toEqual({ before: '41', limit: '100' });
  });

  it.each([
    { before: 0 },
    { before: 1.5 },
    { before: -3 },
    { before: '41' as unknown as number },
    { before: Number.MAX_SAFE_INTEGER + 1 },
    { limit: 0 },
    { limit: 101 },
    { limit: 2.5 },
  ])('refuses %j before anything is sent', async (page) => {
    const { rec, client } = setup();
    await expect(client.credits.read(page)).rejects.toThrow(ValidationError);
    expect(rec.calls).toHaveLength(0);
  });

  it('reads a frozen account with no grant, an empty page and the last page', () => {
    const report = toCreditReport(
      {
        ...CREDITS,
        frozen: true,
        available_micros: 0,
        grant: null,
        lots: [],
        entries: [],
        next_before: null,
      },
      'GET',
      'credits',
    );
    expect(report).toMatchObject({ frozen: true, grant: null, lots: [], entries: [] });
    expect(report.nextBefore).toBeNull();
  });

  it('keeps a negative available balance and a kind it does not know', () => {
    const report = toCreditReport(
      {
        ...CREDITS,
        available_micros: -Number.MAX_SAFE_INTEGER,
        lots: [{ ...CREDITS.lots[0], kind: 'gift' }],
        entries: [{ ...CREDITS.entries[0], kind: 'refund' }],
      },
      'GET',
      'credits',
    );
    expect(report.availableMicros).toBe(-Number.MAX_SAFE_INTEGER);
    expect(report.lots[0]?.kind).toBe('gift');
    expect(report.entries[0]?.kind).toBe('refund');
  });

  const lot = CREDITS.lots[0]!;
  const entry = CREDITS.entries[0]!;
  it.each([
    ['the response', []],
    ['balance_micros', { ...CREDITS, balance_micros: '1' }],
    ['balance_micros', { ...CREDITS, balance_micros: -1 }],
    ['balance_micros', { ...CREDITS, balance_micros: 1.5 }],
    ['available_micros', { ...CREDITS, available_micros: undefined }],
    ['available_micros', { ...CREDITS, available_micros: Number.MAX_SAFE_INTEGER + 2 }],
    ['held_micros', { ...CREDITS, held_micros: null }],
    ['debt_micros', { ...CREDITS, debt_micros: -5 }],
    ['frozen', { ...CREDITS, frozen: 'false' }],
    ['grant', { ...CREDITS, grant: undefined }],
    ['grant.period_end', { ...CREDITS, grant: { ...CREDITS.grant, period_end: '2026-11-01' } }],
    ['grant.used_micros', { ...CREDITS, grant: { ...CREDITS.grant, used_micros: -1 } }],
    ['lots', { ...CREDITS, lots: null }],
    ['lots[0]', { ...CREDITS, lots: ['lot'] }],
    ['lots[0].id', { ...CREDITS, lots: [{ ...lot, id: '' }] }],
    ['lots[0].kind', { ...CREDITS, lots: [{ ...lot, kind: 3 }] }],
    ['lots[0].remaining_micros', { ...CREDITS, lots: [{ ...lot, remaining_micros: '5' }] }],
    [
      'lots[0].expires_at',
      { ...CREDITS, lots: [{ ...lot, expires_at: '2026-11-01T00:00:00+01:00' }] },
    ],
    ['lots[0].created_at', { ...CREDITS, lots: [{ ...lot, created_at: 'yesterday' }] }],
    ['entries', { ...CREDITS, entries: {} }],
    ['entries[0].id', { ...CREDITS, entries: [{ ...entry, id: 0 }] }],
    ['entries[0].lot_id', { ...CREDITS, entries: [{ ...entry, lot_id: undefined }] }],
    ['entries[0].amount_micros', { ...CREDITS, entries: [{ ...entry, amount_micros: -1 }] }],
    ['entries[0].debt_micros', { ...CREDITS, entries: [{ ...entry, debt_micros: undefined }] }],
    ['entries[0].model', { ...CREDITS, entries: [{ ...entry, model: 7 }] }],
    ['entries[0].run_id', { ...CREDITS, entries: [{ ...entry, run_id: '' }] }],
    ['entries[0].step', { ...CREDITS, entries: [{ ...entry, step: '3' }] }],
    ['entries[0].created_at', { ...CREDITS, entries: [{ ...entry, created_at: null }] }],
    ['next_before', { ...CREDITS, next_before: undefined }],
    ['next_before', { ...CREDITS, next_before: 0 }],
  ])('refuses a report whose %s is wrong', (field, body) => {
    expect(() => toCreditReport(body, 'GET', 'credits')).toThrow(MandalaError);
    expect(() => toCreditReport(body, 'GET', 'credits')).toThrow(field);
  });

  it('refuses a malformed report from read() too', async () => {
    const { client } = setup((call) =>
      call.path === '/credits' ? json({ ...CREDITS, held_micros: '0' }) : anyRoute(call),
    );
    await expect(client.credits.read()).rejects.toThrow(/held_micros/);
  });

  it('raises the workspace-key refusal as PermissionDeniedError', async () => {
    const { client } = setup((call) =>
      call.path === '/credits'
        ? json({ error: 'AI credits belong to the whole account.' }, { status: 403 })
        : anyRoute(call),
    );
    await expect(client.credits.read()).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});

describe('a funded run throttled by its provider after it acted', () => {
  // A funded run reports its provider's failures in the platform's own words,
  // without the `model API: ` prefix, so the relayed-429 rule cannot see it.
  // Replaying a run that has already acted repeats those actions all the same.
  const UNAVAILABLE = 'Mandala AI is unavailable';
  const STEP = { n: 1, tool: 'computer', action: 'left_click', cost_usd: 0.3 };

  it('is not transient from agent() once a step was streamed', async () => {
    const { client } = setup(
      onAgent(() =>
        sse(
          ['step', STEP],
          ['error', { error: UNAVAILABLE, status: 429, usage: USAGE, steps: [] }],
        ),
      ),
    );
    const err = await (await client.computers.get('vm-1')).agent({ prompt: 'go' }).catch((e) => e);
    expect(err.status).toBe(429);
    expect(isTransient(err)).toBe(false);
  });

  it('is not transient from agentOnce() when the body lists a step', async () => {
    const { client } = setup(
      onAgent(() =>
        json({ error: UNAVAILABLE, usage: USAGE, steps_taken: [STEP] }, { status: 429 }),
      ),
    );
    const err = await (await client.computers.get('vm-1'))
      .agentOnce({ prompt: 'go' })
      .catch((e) => e);
    expect(err.status).toBe(429);
    expect(isTransient(err)).toBe(false);
  });

  it('stays transient before any step, as the platform’s own 429 always was', async () => {
    const { client } = setup(onAgent(() => json({ error: 'rate limited' }, { status: 429 })));
    const err = await (await client.computers.get('vm-1'))
      .agentOnce({ prompt: 'go' })
      .catch((e) => e);
    expect(isTransient(err)).toBe(true);
    const frame = { error: UNAVAILABLE, status: 429, usage: USAGE, steps: [] };
    const { client: streaming } = setup(onAgent(() => sse(['error', frame])));
    const early = await (await streaming.computers.get('vm-1'))
      .agent({ prompt: 'go' })
      .catch((e) => e);
    expect(isTransient(early)).toBe(true);
  });
});

it('leaves an unprefixed 429 after a step on your own key as OPL-5446 left it', async () => {
  const frames = sse(
    ['step', { n: 1, tool: 'computer' }],
    ['error', { error: 'slow down', status: 429 }],
  );
  const { client } = setup(onAgent(() => frames));
  const err = await (await client.computers.get('vm-1'))
    .agent({ prompt: 'go', modelKey: 'sk' })
    .catch((e) => e);
  expect(isTransient(err)).toBe(true);
});

describe('a funded run whose provider failed, in the platform’s words', () => {
  const UNAVAILABLE = 'Mandala AI is unavailable';

  it.each([401, 403, 404, 413])(
    '%i is a plain APIError from agent() and agentOnce(), not the table class',
    async (status) => {
      const frame = { error: UNAVAILABLE, status, usage: USAGE, steps: [] };
      const { client } = setup(onAgent(() => sse(['error', frame])));
      const streamed = await (await client.computers.get('vm-1'))
        .agent({ prompt: 'go' })
        .catch((e) => e);
      expect(streamed.constructor).toBe(APIError);
      expect(streamed.status).toBe(status);
      const { client: once } = setup(
        onAgent(() => json({ error: UNAVAILABLE, usage: USAGE, steps_taken: [] }, { status })),
      );
      const answered = await (await once.computers.get('vm-1'))
        .agentOnce({ prompt: 'go' })
        .catch((e) => e);
      expect(answered.constructor).toBe(APIError);
      expect(answered.status).toBe(status);
    },
  );

  it('leaves the platform’s own refusals on a funded run in their classes', async () => {
    const frame = { error: 'no such computer', status: 404, usage: USAGE, steps: [] };
    const { client } = setup(onAgent(() => sse(['error', frame])));
    const err = await (await client.computers.get('vm-1')).agent({ prompt: 'go' }).catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    const revoked = { error: 'revoked', status: 401, reason: 'revoked', usage: USAGE, steps: [] };
    const { client: other } = setup(onAgent(() => sse(['error', revoked])));
    const auth = await (await other.computers.get('vm-1')).agent({ prompt: 'go' }).catch((e) => e);
    expect(auth).toBeInstanceOf(AuthenticationError);
  });

  it('leaves the same sentence on your own key to the status table', async () => {
    const frame = { error: UNAVAILABLE, status: 404, usage: USAGE, steps: [] };
    const { client } = setup(onAgent(() => sse(['error', frame])));
    const err = await (await client.computers.get('vm-1'))
      .agent({ prompt: 'go', modelKey: 'sk' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundError);
  });
});
