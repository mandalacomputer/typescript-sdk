/**
 * The classes the agent routes' statuses are raised as (OPL-5450), matching
 * mandala-computer-python's `_agent_route_error`: a 404, 413 or 429 the model
 * API answered (its `error` prefixed `model API: `) is the model provider's,
 * not the platform's, and a 504 `agentOnce()` gets with the run's usage or
 * steps is the platform answering, not an edge cut.
 */

import { describe, expect, it } from 'vitest';
import {
  APIError,
  Client,
  GatewayTimeoutError,
  isTransient,
  ModelProviderError,
  NotFoundError,
  RateLimitError,
  TooLargeError,
} from '../src/index.js';
import { anyRoute, BASE, type Responder, recorder } from './harness.js';

const client = (respond: Responder) =>
  new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: recorder(respond).fetch });

const errorStream = (payload: unknown) =>
  new Response(`event: error\ndata: ${JSON.stringify(payload)}\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  });

/** A non-streaming answer with the headers a refusal on the agent route carries. */
const refusal = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'x-request-id': 'req-agent',
      ...headers,
    },
  });

const BUDGET = {
  'retry-after': '7',
  'ratelimit-limit': '10800',
  'ratelimit-remaining': '0',
  'ratelimit-reset': '30',
};

const agentOnceError = async (response: () => Response) => {
  const c = client((call) => (call.path.endsWith('/agent') ? response() : anyRoute(call)));
  const computer = await c.computers.get('vm-1');
  return computer.agentOnce({ prompt: 'go', modelKey: 'sk' }).catch((e: unknown) => e);
};

const agentError = async (frame: unknown) => {
  const c = client((call) => (call.path.endsWith('/agent') ? errorStream(frame) : anyRoute(call)));
  const computer = await c.computers.get('vm-1');
  return computer.agent({ prompt: 'go', modelKey: 'sk' }).catch((e: unknown) => e);
};

const RUN = { usage: { input_tokens: 10, output_tokens: 2 }, steps_taken: [] };

describe('a 404 or 413 on agentOnce()', () => {
  it.each([404, 413])(
    'is a ModelProviderError when the model API answered a %i',
    async (status) => {
      const body = { error: `model API: ${status} not_found_error: model: claude-nope`, ...RUN };
      const err = await agentOnceError(() => refusal(status, body));
      expect(err).toBeInstanceOf(ModelProviderError);
      expect(err).not.toBeInstanceOf(NotFoundError);
      expect(err).not.toBeInstanceOf(TooLargeError);
      const e = err as APIError;
      expect(e.status).toBe(status);
      expect(e.body).toEqual(body);
      expect(e.message).toBe(body.error);
      expect(e.requestId).toBe('req-agent');
      expect(e.method).toBe('POST');
      expect(isTransient(e)).toBe(false);
    },
  );

  it('keeps the platform own unprefixed 404 a NotFoundError', async () => {
    const err = await agentOnceError(() => refusal(404, { error: 'no such computer' }));
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err).not.toBeInstanceOf(ModelProviderError);
  });

  it('keeps the platform own unprefixed 413 a TooLargeError', async () => {
    const err = await agentOnceError(() => refusal(413, { error: 'request body too large' }));
    expect(err).toBeInstanceOf(TooLargeError);
    expect(err).not.toBeInstanceOf(ModelProviderError);
  });

  it('reads the prefix only at the start of the error text', async () => {
    const err = await agentOnceError(() =>
      refusal(404, { error: 'no such computer (not a model API: failure)' }),
    );
    expect(err).toBeInstanceOf(NotFoundError);
  });
});

describe('a 429 on agentOnce()', () => {
  it('drops the Mandala budget fields when the model API answered it', async () => {
    const body = { error: 'model API: 429 rate_limit_error: slow down', ...RUN };
    const err = await agentOnceError(() => refusal(429, body, BUDGET));
    expect(err).toBeInstanceOf(RateLimitError);
    const e = err as RateLimitError;
    expect([e.limit, e.remaining, e.resetSeconds]).toEqual([undefined, undefined, undefined]);
    // The model API's own wait, forwarded, is kept.
    expect(e.retryAfterMs).toBe(7_000);
    expect(e.body).toEqual(body);
    expect(e.requestId).toBe('req-agent');
    expect(e.method).toBe('POST');
    expect(isTransient(e)).toBe(true);
  });

  it('keeps the budget fields on the platform own unprefixed 429', async () => {
    const err = await agentOnceError(() => refusal(429, { error: 'rate limited' }, BUDGET));
    expect(err).toBeInstanceOf(RateLimitError);
    const e = err as RateLimitError;
    expect([e.limit, e.remaining, e.resetSeconds]).toEqual([10800, 0, 30]);
    expect(e.retryAfterMs).toBe(7_000);
  });
});

describe('a 504 on agentOnce()', () => {
  it.each([
    ['usage and steps_taken', { error: 'model API: 504 timeout_error', ...RUN }],
    ['usage alone', { error: 'model API: 504 timeout_error', usage: RUN.usage }],
    ['steps_taken alone', { error: 'model API: 504 timeout_error', steps_taken: [] }],
  ])('is a plain APIError when its body carries %s', async (_, body) => {
    const err = await agentOnceError(() => refusal(504, body));
    expect(err).toBeInstanceOf(APIError);
    expect(err).not.toBeInstanceOf(GatewayTimeoutError);
    const e = err as APIError;
    expect(e.constructor).toBe(APIError);
    expect(e.status).toBe(504);
    expect(e.body).toEqual(body);
    expect(e.requestId).toBe('req-agent');
    expect(e.method).toBe('POST');
    expect(isTransient(e)).toBe(false);
  });

  it('stays a GatewayTimeoutError when body-less', async () => {
    const err = await agentOnceError(() => refusal(504, undefined));
    expect(err).toBeInstanceOf(GatewayTimeoutError);
  });

  it('stays a GatewayTimeoutError when the body has neither field', async () => {
    const err = await agentOnceError(() => refusal(504, { error: 'upstream timed out' }));
    expect(err).toBeInstanceOf(GatewayTimeoutError);
  });

  it('leaves a 524 a GatewayTimeoutError, whatever its body', async () => {
    const err = await agentOnceError(() => refusal(524, RUN));
    expect(err).toBeInstanceOf(GatewayTimeoutError);
    expect((err as APIError).status).toBe(524);
  });
});

describe('the same statuses reported mid-stream on agent()', () => {
  const STEPS = [{ n: 1, tool: 'computer', action: 'left_click' }];

  it.each([404, 413])('a %i the model API answered is a ModelProviderError', async (status) => {
    const frame = { error: `model API: ${status} not_found_error`, status, steps: STEPS };
    const err = await agentError(frame);
    expect(err).toBeInstanceOf(ModelProviderError);
    const e = err as APIError;
    expect(e.status).toBe(status);
    expect(e.method).toBe('POST');
    expect(e.body).toMatchObject({ steps: STEPS });
    expect(isTransient(e)).toBe(false);
  });

  it('an unprefixed 404 keeps its class', async () => {
    const err = await agentError({ error: 'computer went away', status: 404 });
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err).not.toBeInstanceOf(ModelProviderError);
  });

  it('an unprefixed 413 keeps its class', async () => {
    const err = await agentError({ error: 'too large', status: 413 });
    expect(err).toBeInstanceOf(TooLargeError);
    expect(err).not.toBeInstanceOf(ModelProviderError);
  });

  it('a 429 the model API answered has no budget fields', async () => {
    const err = await agentError({ error: 'model API: 429 rate_limit_error', status: 429 });
    expect(err).toBeInstanceOf(RateLimitError);
    const e = err as RateLimitError;
    expect([e.limit, e.remaining, e.resetSeconds]).toEqual([undefined, undefined, undefined]);
  });

  it('a 504 with the run in it is a plain APIError, as on agentOnce()', async () => {
    const err = await agentError({
      error: 'model API: 504 timeout_error',
      status: 504,
      usage: RUN.usage,
    });
    expect((err as APIError).constructor).toBe(APIError);
    expect((err as APIError).status).toBe(504);
  });
});
