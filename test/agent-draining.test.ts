/**
 * A call that starts an agent run, refused while the platform updates
 * (OPL-6094): a `503` with `reason: "draining"` and a `Retry-After`, answered
 * before anything starts, so nothing ran and nothing was charged.
 * `isTransient` calls it safe to send again, and a client that opted into
 * `retries` sends it again after the wait, within the same budget. Retry stays
 * off by default, and nothing else these calls meet is resent.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { errorForStatus } from '../src/errors.js';
import {
  APIError,
  Client,
  type ClientOptions,
  type Computer,
  ConflictError,
  ConnectionError,
  isTransient,
  UnavailableError,
} from '../src/index.js';
import { anyRoute, BASE, type Call, json, type Responder, recorder } from './harness.js';

/** The platform's refusal, word for word. */
const DRAINING = {
  error:
    'New agent runs are paused for a few minutes while the platform updates; runs already going are not ' +
    'affected. Send the same request again after the Retry-After wait.',
  reason: 'draining',
};

const refusal = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  json(body, { status, headers: { 'content-type': 'application/json', ...headers } });

const draining = () => refusal(503, DRAINING, { 'Retry-After': '30', 'Cache-Control': 'no-store' });

const ARGS = { prompt: 'go', modelKey: 'sk' };

/** Every call that starts an agent run, each consumed to its end. */
const RUNNERS: Record<
  string,
  (client: Client, c: Computer, signal?: AbortSignal) => Promise<unknown>
> = {
  agent: (_, c, signal) => c.agent({ ...ARGS, signal }),
  agentStream: async (_, c, signal) => {
    for await (const _event of c.agentStream({ ...ARGS, signal }));
  },
  agentOnce: (_, c, signal) => c.agentOnce({ ...ARGS, signal }),
  'agentRuns.start': (client, _, signal) => client.agentRuns.start('vm-1', ARGS, { signal }),
  startAgentRun: (_, c, signal) => c.startAgentRun(ARGS, { signal }),
};
/** The three whose request has no deadline of its own: a stream, and agentOnce's held request. */
const UNBOUNDED = ['agent', 'agentStream', 'agentOnce'];

const startsRun = (call: Call) =>
  call.method === 'POST' && (call.path.endsWith('/agent') || call.path.endsWith('/agent/runs'));

/** Attempts at starting a run so far, in the test that is running. */
let attempts = 0;

/** Every call that starts a run answered by `answer(n)` for its `n`th attempt, from 0. */
const starting =
  (answer: (n: number, call: Call) => Response | undefined): Responder =>
  (call) => {
    if (!startsRun(call)) return anyRoute(call);
    return answer(attempts++, call) ?? anyRoute(call);
  };

async function sdk(
  respond: Responder,
  opts: Partial<ClientOptions> = {},
  { redirected = false }: { redirected?: boolean } = {},
) {
  const times: number[] = [];
  const rec = recorder((call) => {
    if (startsRun(call)) times.push(Date.now());
    return respond(call);
  });
  // A fetch that followed a redirect: the same answer, flagged as such.
  const fetch: typeof globalThis.fetch = redirected
    ? async (input, init) =>
        Object.defineProperty(await rec.fetch(input, init), 'redirected', { value: true })
    : rec.fetch;
  const client = new Client({ apiKey: 'com_test', baseUrl: BASE, fetch, ...opts });
  const c = await client.computers.get('vm-1');
  return { rec, client, c, times, starts: () => rec.calls.filter(startsRun) };
}

/** Run `pending` to its end, the fake clock included, and answer its value or its error. */
async function settle(pending: Promise<unknown>): Promise<unknown> {
  const outcome = pending.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await vi.runAllTimersAsync();
  const result = await outcome;
  return 'error' in result ? result.error : result.value;
}

beforeEach(() => {
  attempts = 0;
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('isTransient on the draining refusal', () => {
  it.each(['POST', 'GET', undefined])(
    'a 503 with reason draining is safe to send again (method %s)',
    (method) => {
      const err = errorForStatus(503, DRAINING.error, DRAINING, { method, retryAfterMs: 30_000 });
      expect(err).toBeInstanceOf(UnavailableError);
      expect(err.reason).toBe('draining');
      expect(isTransient(err)).toBe(true);
    },
  );

  it('is the 503 rule for a POST without the word, unchanged', () => {
    const err = errorForStatus(
      503,
      'upstream failed',
      { error: 'upstream failed' },
      { method: 'POST' },
    );
    expect(isTransient(err)).toBe(false);
  });

  it('counts only the top-level word, not a nested run error', () => {
    const body = { error: { message: 'paused', reason: 'draining' } };
    const err = errorForStatus(503, 'paused', body, { method: 'POST' });
    expect(err.reason).toBe('draining');
    expect(isTransient(err)).toBe(false);
  });

  it.each([409, 400, 500, 502])('is a 503 rule: a %s with the word is not transient', (status) => {
    const err = errorForStatus(status, DRAINING.error, DRAINING, { method: 'POST' });
    expect(isTransient(err)).toBe(false);
  });

  it('reads a run that had started and then failed with the word as not transient', async () => {
    vi.useRealTimers();
    const frame = { error: 'paused', status: 503, reason: 'draining', steps: [] };
    const { c } = await sdk((call) =>
      startsRun(call)
        ? new Response(`event: error\ndata: ${JSON.stringify(frame)}\n\n`, {
            headers: { 'content-type': 'text/event-stream' },
          })
        : anyRoute(call),
    );
    const err = await c.agent(ARGS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(APIError);
    expect((err as APIError).status).toBe(503);
    expect((err as APIError).reason).toBeUndefined();
    expect(isTransient(err)).toBe(false);
  });
});

describe('retry is off by default', () => {
  it.each(Object.keys(RUNNERS))('%s throws the refusal after one attempt', async (name) => {
    const { client, c, starts } = await sdk(starting(() => draining()));
    const err = await settle(RUNNERS[name]!(client, c));
    expect(err).toBeInstanceOf(UnavailableError);
    expect(err).toMatchObject({
      status: 503,
      reason: 'draining',
      retryAfterMs: 30_000,
      message: DRAINING.error,
    });
    expect(isTransient(err)).toBe(true);
    expect(starts()).toHaveLength(1);
  });

  it.each(Object.keys(RUNNERS))('%s makes one attempt with retries: 0', async (name) => {
    const { client, c, starts } = await sdk(
      starting(() => draining()),
      { retries: { idempotent: 0 } },
    );
    expect(await settle(RUNNERS[name]!(client, c))).toBeInstanceOf(UnavailableError);
    expect(starts()).toHaveLength(1);
  });
});

describe('with retries opted in', () => {
  it.each(Object.keys(RUNNERS))(
    '%s sends the same request again after the Retry-After, and answers',
    async (name) => {
      const { client, c, starts, times } = await sdk(
        starting((n) => (n === 0 ? draining() : undefined)),
        { retries: { idempotent: 2 } },
      );
      const outcome = await settle(RUNNERS[name]!(client, c));
      expect(outcome).not.toBeInstanceOf(Error);
      const sent = starts();
      expect(sent).toHaveLength(2);
      expect(sent[1]!.path).toBe(sent[0]!.path);
      expect(sent[1]!.body).toEqual(sent[0]!.body);
      expect(sent[1]!.headers).toEqual(sent[0]!.headers);
      expect(times[1]! - times[0]!).toBe(30_000);
    },
  );

  it.each(UNBOUNDED)('%s stops at the budget and throws the last refusal', async (name) => {
    const { client, c, starts } = await sdk(
      starting(() => draining()),
      { retries: { idempotent: 2 } },
    );
    const err = await settle(RUNNERS[name]!(client, c));
    expect(err).toBeInstanceOf(UnavailableError);
    expect(err).toMatchObject({ reason: 'draining', retryAfterMs: 30_000 });
    expect(starts()).toHaveLength(3);
  });

  it.each(['agentRuns.start', 'startAgentRun'])(
    '%s keeps the one deadline: a wait that would pass it is not started',
    async (name) => {
      // The default 60-second deadline holds the first 30-second wait and not
      // the second, so the second refusal is thrown as it came.
      const { client, c, starts } = await sdk(
        starting(() => draining()),
        { retries: { idempotent: 5 } },
      );
      const err = await settle(RUNNERS[name]!(client, c));
      expect(err).toMatchObject({ status: 503, reason: 'draining', retryAfterMs: 30_000 });
      expect(starts()).toHaveLength(2);
    },
  );

  it('agentRuns.start without a deadline uses the whole budget', async () => {
    const { client, c, starts } = await sdk(
      starting(() => draining()),
      { retries: { idempotent: 2 }, timeoutMs: 0 },
    );
    expect(await settle(RUNNERS['agentRuns.start']!(client, c))).toBeInstanceOf(UnavailableError);
    expect(starts()).toHaveLength(3);
  });

  it('waits the backoff when the refusal names no wait', async () => {
    const { client, c, times } = await sdk(
      starting((n) => (n === 0 ? refusal(503, DRAINING) : undefined)),
      { retries: { idempotent: 1 } },
    );
    await settle(RUNNERS.agentOnce!(client, c));
    expect(times[1]! - times[0]!).toBe(250);
  });

  it.each(Object.keys(RUNNERS))('%s stops waiting when its signal is aborted', async (name) => {
    const { client, c, starts } = await sdk(
      starting(() => draining()),
      { retries: { idempotent: 2 } },
    );
    const controller = new AbortController();
    const reason = new Error('stop');
    const pending = RUNNERS[name]!(client, c, controller.signal).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    controller.abort(reason);
    expect(await pending).toBe(reason);
    expect(starts()).toHaveLength(1);
  });

  const OTHER_FAILURES: [string, () => Response | never][] = [
    [
      'a 503 without a reason',
      () => refusal(503, { error: 'host unreachable' }, { 'Retry-After': '1' }),
    ],
    [
      'a 503 with another reason',
      () => refusal(503, { error: 'x', reason: 'unavailable' }, { 'Retry-After': '1' }),
    ],
    [
      'a 503 whose word is nested in a run error',
      () => refusal(503, { error: { message: 'x', reason: 'draining' } }, { 'Retry-After': '1' }),
    ],
    ['a body-less 503', () => new Response(null, { status: 503 })],
    ['a 502', () => refusal(502, { error: 'bad gateway' })],
    ['a 409 with the word', () => refusal(409, DRAINING, { 'Retry-After': '1' })],
    [
      'a refused connection',
      () => {
        throw new TypeError('fetch failed', {
          cause: Object.assign(new Error('connect ECONNREFUSED'), {
            code: 'ECONNREFUSED',
            syscall: 'connect',
          }),
        });
      },
    ],
  ];
  for (const name of Object.keys(RUNNERS)) {
    it.each(OTHER_FAILURES)(`${name} does not resend %s`, async (_, answer) => {
      const { client, c, starts } = await sdk(
        starting(() => answer()),
        { retries: { idempotent: 3 } },
      );
      const err = await settle(RUNNERS[name]!(client, c));
      expect(err).toBeInstanceOf(Error);
      expect(isTransient(err)).toBe(err instanceof ConnectionError);
      expect(starts()).toHaveLength(1);
    });
  }

  it('resends nothing that does not start a run', async () => {
    const { client, rec } = await sdk(
      (call) => (call.method === 'POST' ? draining() : anyRoute(call)),
      { retries: { idempotent: 3 } },
    );
    rec.calls.length = 0;
    const err = await settle(client.computers.create({ name: 'one', template: 'base' }));
    expect(err).toBeInstanceOf(UnavailableError);
    expect(rec.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });

  it('never resends once a frame has arrived', async () => {
    const { client, c, starts } = await sdk(
      starting(
        () =>
          new Response(
            'event: step\ndata: {"n":1,"tool":"computer","action":"left_click","detail":"x"}\n\n' +
              `event: error\ndata: ${JSON.stringify({ error: 'paused', status: 503, reason: 'draining' })}\n\n`,
            { headers: { 'content-type': 'text/event-stream' } },
          ),
      ),
      { retries: { idempotent: 3 } },
    );
    const err = await settle(RUNNERS.agent!(client, c));
    expect(err).toBeInstanceOf(APIError);
    expect(isTransient(err)).toBe(false);
    expect(starts()).toHaveLength(1);
  });

  it('keeps a 409 refusal before the run as it was', async () => {
    const { client, c, starts } = await sdk(
      starting(() =>
        refusal(409, { error: 'This computer is already being driven.', reason: 'contention' }),
      ),
      { retries: { idempotent: 3 } },
    );
    const err = await settle(RUNNERS['agentRuns.start']!(client, c));
    expect(err).toBeInstanceOf(ConflictError);
    expect(isTransient(err)).toBe(true);
    expect(starts()).toHaveLength(1);
  });
});

// The refusal's own shape, and nothing else: a draining word on a body that
// reports a run, or on one that is not the refusal's, or on an answer that
// came through a redirect, is not the platform saying nothing started.
describe('what is not the draining refusal', () => {
  const RUN_RECORDS: [string, unknown][] = [
    ['usage', { input_tokens: 10, output_tokens: 2 }],
    ['steps', []],
    ['steps_taken', [{ n: 1, tool: 'computer', action: 'left_click', detail: 'x' }]],
    ['cost_usd', 0.01],
    ['thread_id', 'thr_0123456789abcdef01234567'],
    ['agent', { stop: 'error' }],
  ];
  const ERRORS: [string, unknown][] = [
    ['an object', { message: DRAINING.error }],
    ['null', null],
    ['a number', 503],
  ];
  const SHAPES: [string, Record<string, unknown>][] = [
    ...RUN_RECORDS.map(([key, value]): [string, Record<string, unknown>] => [
      `a body that also reports ${key}`,
      { ...DRAINING, [key]: value },
    ]),
    ...ERRORS.map(([what, error]): [string, Record<string, unknown>] => [
      `an error that is ${what}`,
      { ...DRAINING, error },
    ]),
    ['a body with no error', { reason: 'draining' }],
  ];

  it.each(SHAPES)('%s is not transient', (_, body) => {
    const err = errorForStatus(503, DRAINING.error, body, { method: 'POST', retryAfterMs: 30_000 });
    expect(err).toBeInstanceOf(UnavailableError);
    expect(err.reason).toBe('draining');
    expect(isTransient(err)).toBe(false);
  });

  it.each(SHAPES)('%s is not resent', async (_, body) => {
    const { client, c, starts } = await sdk(
      starting(() => refusal(503, body, { 'Retry-After': '30' })),
      { retries: { idempotent: 3 } },
    );
    const err = await settle(RUNNERS.agentOnce!(client, c));
    expect(err).toBeInstanceOf(UnavailableError);
    expect(isTransient(err)).toBe(false);
    expect(starts()).toHaveLength(1);
  });

  it.each(Object.keys(RUNNERS))(
    '%s neither resends nor calls transient a refusal reached through a redirect',
    async (name) => {
      const { client, c, starts } = await sdk(
        starting(() => draining()),
        { retries: { idempotent: 3 } },
        { redirected: true },
      );
      const err = await settle(RUNNERS[name]!(client, c));
      expect(err).toBeInstanceOf(UnavailableError);
      expect(err).toMatchObject({ reason: 'draining', retryAfterMs: 30_000 });
      expect(isTransient(err)).toBe(false);
      expect(starts()).toHaveLength(1);
    },
  );
});
