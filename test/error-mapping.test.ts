import { afterEach, describe, expect, it, vi } from 'vitest';
import { errorForEventStatus, errorForStatus } from '../src/errors.js';
import {
  APIError,
  AuthenticationError,
  Client,
  Computer,
  ConflictError,
  ConnectionError,
  type ErrorMetadata,
  FileExistsError,
  GatewayTimeoutError,
  isTransient,
  MethodNotAllowedError,
  MoveRequiredError,
  NotFoundError,
  OriginResponseError,
  OriginTLSError,
  OriginUnreachableError,
  RangeNotSatisfiableError,
  RateLimitError,
  TooLargeError,
} from '../src/index.js';
import { Transport } from '../src/transport.js';
import { BASE, COMPUTER, recorder } from './harness.js';

const setup = (reply: () => Response, retries = 2) => {
  const rec = recorder(reply);
  const options = {
    apiKey: 'com_test',
    baseUrl: BASE,
    fetch: rec.fetch,
    retries: { idempotent: retries },
  };
  return { rec, t: new Transport(options), client: new Client(options) };
};
const failure = async (pending: Promise<unknown>): Promise<APIError> => {
  try {
    await pending;
  } catch (error) {
    expect(error).toBeInstanceOf(APIError);
    if (error instanceof APIError) return error;
    throw error;
  }
  throw new Error('expected an HTTP refusal');
};
const headers = {
  'x-ReQuEsT-Id': 'header-id',
  Allow: 'GET, HEAD, OPTIONS',
  'WWW-Authenticate': 'Bearer',
};
const metadata: ErrorMetadata = {
  requestId: 'header-id',
  allow: headers.Allow,
  wwwAuthenticate: 'Bearer',
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('finite response errors', () => {
  it.each(['GET, HEAD, POST, OPTIONS', 'GET, HEAD, OPTIONS', undefined])(
    'maps 405 and its specific Allow (%s)',
    async (allow) => {
      const body = {
        error: 'method not allowed',
        request_id: 'body-id',
        allow: 'ignored',
        www_authenticate: 'ignored',
      };
      const { t, rec } = setup(() =>
        Response.json(body, {
          status: 405,
          headers: {
            'X-Request-ID': 'method-id',
            ...(allow === undefined ? {} : { Allow: allow }),
          },
        }),
      );
      const error = await failure(t.json('PUT', '/computers'));
      expect(error).toBeInstanceOf(MethodNotAllowedError);
      expect(error).toMatchObject({
        status: 405,
        message: body.error,
        body,
        requestId: 'method-id',
      });
      expect(error.allow).toBe(allow);
      expect(error.wwwAuthenticate).toBeUndefined();
      expect(isTransient(error)).toBe(false);
      expect(rec.calls).toHaveLength(1);
    },
  );

  it.each([
    [{ error: 'credential missing', reason: 'missing' }, 'missing', 'Bearer', 'credential missing'],
    [
      { error: 'credential invalid', reason: 'invalid' },
      'invalid',
      'Bearer error="invalid_token"',
      'credential invalid',
    ],
    [
      { error: 'credential revoked', reason: 'revoked' },
      'revoked',
      'Bearer error="invalid_token"',
      'credential revoked',
    ],
    [
      { error: { message: 'run revoked', reason: 'revoked', code: 503 } },
      'revoked',
      'Bearer error="invalid_token"',
      'run revoked',
    ],
    [
      { error: { message: 'provider refused', code: 503 } },
      undefined,
      undefined,
      'provider refused',
    ],
    [
      { error: 'future classification', reason: 'new-reason' },
      'new-reason',
      undefined,
      'future classification',
    ],
    [
      { error: { message: 'nested reason', reason: 'revoked' }, reason: 42 },
      'revoked',
      undefined,
      'nested reason',
    ],
    [
      { error: { message: 'top wins', reason: 'revoked' }, reason: 'top-reason' },
      'top-reason',
      undefined,
      'top wins',
    ],
    [
      { error: { message: 'malformed reason', reason: 42 } },
      undefined,
      undefined,
      'malformed reason',
    ],
  ])(
    'keeps the HTTP 401 classification and nested message (%j)',
    async (payload, reason, challenge, message) => {
      const body = {
        ...payload,
        request_id: 'body-auth',
        usage: { input_tokens: 17 },
        steps: [{ action: 'click' }],
        extra: 'retained',
      };
      const { t, rec } = setup(() =>
        Response.json(body, {
          status: 401,
          headers: {
            'X-Request-ID': 'header-auth',
            ...(challenge ? { 'WWW-Authenticate': challenge } : {}),
          },
        }),
      );
      const error = await failure(t.json('GET', '/computers'));
      expect(error).toBeInstanceOf(AuthenticationError);
      expect(error).toMatchObject({ status: 401, body, message, requestId: 'header-auth' });
      expect(error.reason).toBe(reason);
      expect(error.wwwAuthenticate).toBe(challenge);
      expect(isTransient(error)).toBe(false);
      expect(rec.calls).toHaveLength(1);
    },
  );

  it.each([null, [], 42, { message: {} }, { message: [] }, { message: '   ' }])(
    'does not coerce malformed nested messages (%j)',
    async (nested) => {
      const { t } = setup(() =>
        Response.json({ error: nested, detail: 'safe detail' }, { status: 400 }),
      );
      expect((await failure(t.json('GET', '/computers'))).message).toBe('safe detail');
    },
  );

  it.each([
    ['header', 'body', 'header'],
    ['', 'body', 'body'],
    ['  ', 'body', 'body'],
    [undefined, ' opaque body ', ' opaque body '],
    [undefined, 123, undefined],
    [undefined, {}, undefined],
    [undefined, '', undefined],
    [undefined, '  ', undefined],
  ])('uses nonblank header-first top-level correlation (%j, %j)', async (header, id, expected) => {
    const body = { error: { message: 'refused', request_id: 'nested-id' }, request_id: id };
    const { t } = setup(() =>
      Response.json(body, {
        status: 401,
        headers: header === undefined ? {} : { 'X-Request-ID': header },
      }),
    );
    expect((await failure(t.json('GET', '/computers'))).requestId).toBe(expected);
  });

  it.each([null, '<html>refused</html>', '{"error":'])(
    'keeps headers with an empty or unreadable body (%j)',
    async (body) => {
      const { t } = setup(() => new Response(body, { status: 405, headers }));
      expect(await failure(t.json('GET', '/computers'))).toMatchObject(metadata);
    },
  );

  it('keeps HEAD headers with no body', async () => {
    const { t, rec } = setup(() => new Response(null, { status: 405, headers }));
    expect(await failure(t.json('HEAD', '/computers'))).toMatchObject({
      ...metadata,
      status: 405,
      message: 'HTTP 405',
    });
    expect(rec.last().method).toBe('HEAD');
    expect(Object.keys(rec.last().headers).map((name) => name.toLowerCase())).not.toContain(
      'x-request-id',
    );
  });

  it.each([401, 405, 429])(
    'keeps known %s headers after a body reset, without retry',
    async (status) => {
      const { t, rec } = setup(
        () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{"error":'));
              },
              pull(controller) {
                controller.error(
                  new TypeError('terminated', {
                    cause: Object.assign(new Error('closed'), { code: 'ECONNRESET' }),
                  }),
                );
              },
            }),
            { status, headers: { ...headers, 'Retry-After': '7' } },
          ),
      );
      expect(await failure(t.json('GET', '/computers'))).toMatchObject({
        ...metadata,
        status,
        retryAfterMs: 7000,
      });
      expect(rec.calls).toHaveLength(1);
    },
  );

  it('reports only the exhausted final response ID', async () => {
    vi.useFakeTimers();
    let attempt = 0;
    const { t, rec } = setup(() =>
      Response.json(
        { error: 'unavailable', request_id: `body-${++attempt}` },
        { status: 503, headers: { 'X-Request-ID': `attempt-${attempt}` } },
      ),
    );
    const pending = failure(t.json('GET', '/computers'));
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ requestId: 'attempt-3', body: { request_id: 'body-3' } });
    expect(rec.calls).toHaveLength(3);
  });

  it('does not carry another response ID into an uncorrelated response or connection error', async () => {
    const rec = recorder((call) => {
      if (call.path === '/sizes')
        return Response.json(
          { error: 'bad' },
          { status: 401, headers: { 'X-Request-ID': 'sizes-id' } },
        );
      if (call.path === '/computers') return Response.json({ error: 'bad' }, { status: 401 });
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }),
      });
    });
    const t = new Transport({ apiKey: 'test', baseUrl: BASE, fetch: rec.fetch });
    const [first, second] = await Promise.all([
      failure(t.json('GET', '/sizes')),
      failure(t.json('GET', '/computers')),
    ]);
    expect(first.requestId).toBe('sizes-id');
    expect(second.requestId).toBeUndefined();
    await expect(t.json('GET', '/builds')).rejects.toBeInstanceOf(ConnectionError);
  });
});

it.each([
  [400, {}, APIError],
  [405, {}, MethodNotAllowedError],
  [429, {}, RateLimitError],
  [409, { move: { required: true, possible: true } }, MoveRequiredError],
  [409, { move: { required: true, possible: false } }, MoveRequiredError],
  [409, { code: 'template_image_preparing' }, ConflictError],
  [409, { reason: 'exists' }, FileExistsError],
  [416, {}, RangeNotSatisfiableError],
  [504, {}, GatewayTimeoutError],
  [520, {}, OriginResponseError],
  [521, {}, OriginUnreachableError],
  [525, {}, OriginTLSError],
])('all finite constructor branches carry metadata (%s, %j)', async (status, extra, cls) => {
  const body = { ...extra, request_id: 'body-branch' };
  const { t } = setup(
    () =>
      Response.json(body, {
        status,
        headers: { ...headers, 'Retry-After': '13', 'Content-Range': 'bytes */12345' },
      }),
    0,
  );
  const error = await failure(t.json('GET', '/computers'));
  expect(error).toBeInstanceOf(cls);
  expect(error).toMatchObject({ ...metadata, body, status, retryAfterMs: 13000 });
  if (error instanceof RangeNotSatisfiableError) expect(error.total).toBe(12345);
  if (error instanceof MoveRequiredError)
    expect(error.movePossible).toBe((extra as { move: { possible: boolean } }).move.possible);
});

it('keeps old constructor positional meanings and adds metadata at the end', () => {
  const body = { request_id: 'body-direct' };
  expect(new APIError('bad', 400, body, 17)).toMatchObject({
    retryAfterMs: 17,
    requestId: 'body-direct',
  });
  expect(new RateLimitError('bad', 429, body, 19, metadata)).toMatchObject({
    ...metadata,
    retryAfterMs: 19,
  });
  expect(new MoveRequiredError('move', 409, body, false, 23, metadata)).toMatchObject({
    ...metadata,
    movePossible: false,
    retryAfterMs: 23,
  });
  expect(new RangeNotSatisfiableError('range', 416, body, 37, 29, metadata)).toMatchObject({
    ...metadata,
    total: 37,
    retryAfterMs: 29,
  });
  expect(new RangeNotSatisfiableError('range', 416, body, 37, 29).total).toBe(37);
});

it.each([401, 402, 403, 404, 405])(
  'contradictory clearing reasons never make %s replayable',
  async (status) => {
    for (const body of [{ reason: 'starting' }, { error: { reason: 'contention' } }]) {
      const { t, rec } = setup(() => Response.json(body, { status }));
      const error = await failure(t.json('GET', '/computers'));
      expect(isTransient(error)).toBe(false);
      expect(rec.calls).toHaveLength(1);
    }
  },
);

it.each([400, 409])('exposes nested reasons without granting replay at %s', (status) => {
  expect(isTransient(errorForStatus(status, 'flat', { reason: 'starting' }))).toBe(true);
  const nested = errorForStatus(status, 'nested', { error: { reason: 'starting' } });
  expect(nested.reason).toBe('starting');
  expect(isTransient(nested)).toBe(false);
});

it.each(['readFile', 'readFilePart'] as const)(
  'uses the existing guest-file 404 type through %s and preserves a 400',
  async (method) => {
    for (const status of [404, 400]) {
      const message = status === 404 ? 'no such file in the guest' : 'permission denied';
      const { t, rec } = setup(() => Response.json({ error: message }, { status, headers }));
      const computer = new Computer(t, COMPUTER);
      const error = await failure(computer[method]('/tmp/missing'));
      expect(error.constructor).toBe(status === 404 ? NotFoundError : APIError);
      expect(error).toMatchObject({ ...metadata, message });
      expect(rec.last().path).toBe('/computers/vm-1/files');
      expect(rec.calls).toHaveLength(1);
    }
  },
);

it('keeps generic computer 404 separate and preserves the 413 file explanation metadata', async () => {
  const { client } = setup(() =>
    Response.json({ error: 'no such computer' }, { status: 404, headers }),
  );
  expect(await failure(client.computers.get('missing'))).toMatchObject({
    name: 'NotFoundError',
    message: 'no such computer',
    requestId: 'header-id',
  });
  const { t } = setup(() =>
    Response.json(
      { error: 'file needs a range' },
      { status: 413, headers: { ...headers, 'Retry-After': '11' } },
    ),
  );
  const error = await failure(new Computer(t, COMPUTER).readFile('/tmp/large'));
  expect(error).toBeInstanceOf(TooLargeError);
  expect(error).toMatchObject({
    ...metadata,
    retryAfterMs: 11000,
    body: { error: 'file needs a range' },
  });
  expect(error.message).toContain('readFileChunks');
});

it.each([401, 400, 429, 504, 520])(
  'retains native stream evidence with isolated reason and headers (%s)',
  async (status) => {
    const body = {
      error: 'run stopped',
      status,
      reason: 'starting',
      request_id: 'frame-id',
      usage: { input_tokens: 31 },
      steps: [{ action: 'click' }],
    };
    const { t, rec } = setup(
      () =>
        new Response(`event: error\ndata: ${JSON.stringify(body)}\n\n`, {
          headers: { ...headers, 'Content-Type': 'text/event-stream', 'Retry-After': '99' },
        }),
    );
    const computer = new Computer(t, COMPUTER);
    for await (const event of computer.agentStream({ prompt: 'task', modelKey: 'sk-test' })) {
      expect(event.type).toBe('error');
      if (event.type === 'error') expect(event.raw).toEqual(body);
    }
    const error = await failure(computer.agent({ prompt: 'task', modelKey: 'sk-test' }));
    expect(error.requestId).toBe('frame-id');
    expect(error.reason).toBeUndefined();
    expect(error.allow).toBeUndefined();
    expect(error.wwwAuthenticate).toBeUndefined();
    expect(error.retryAfterMs).toBeUndefined();
    expect(error.body).toMatchObject({ usage: body.usage, steps: body.steps });
    if ([504, 520].includes(status)) expect(error.constructor).toBe(APIError);
    expect(rec.calls).toHaveLength(2);
    const nested = errorForEventStatus(status, 'nested', {
      error: { reason: 'starting', message: 'stopped' },
      request_id: 'nested-frame',
    });
    expect(nested.reason).toBeUndefined();
    expect(nested.requestId).toBe('nested-frame');
    if (status === 400) expect(isTransient(nested)).toBe(false);
  },
);

it('leaves raw OpenAI SSE envelopes and the terminator unchanged', async () => {
  const body = {
    error: { message: 'revoked', reason: 'revoked', usage: { input_tokens: 9 } },
    request_id: 'chat-frame',
  };
  const { t } = setup(
    () =>
      new Response(`data: ${JSON.stringify(body)}\n\ndata: [DONE]\n\n`, {
        headers: { 'Content-Type': 'text/event-stream' },
      }),
  );
  const frames = [];
  for await (const frame of t.sse('POST', '/chat/completions')) frames.push(frame);
  expect(frames.map((frame) => frame.data)).toEqual([body, '[DONE]']);
});

it.each(['json', 'bytes', 'listing', 'boundedJson', 'boundedBytes', 'sse'] as const)(
  'preserves headers through the %s response reader',
  async (mode) => {
    const { t } = setup(() => Response.json({ error: 'refused' }, { status: 401, headers }));
    let pending: Promise<unknown>;
    if (mode === 'listing') pending = t.listing('/computers');
    else if (mode === 'sse') pending = t.sse('POST', '/computers/vm-1/agent').next();
    else if (mode === 'boundedJson' || mode === 'boundedBytes')
      pending = t[mode]('GET', '/computers/vm-1/results/result-id', { maxBytes: 4096 });
    else pending = t[mode]('GET', '/computers');
    expect(await failure(pending)).toMatchObject(metadata);
  },
);

it.each([504, 520])('retains a named nested finite message at %s', async (status) => {
  const body = {
    error: { message: 'specific downstream refusal', reason: 'new-reason', code: 401 },
    request_id: 'body-id',
  };
  const { t } = setup(() => Response.json(body, { status, headers }), 0);
  expect(await failure(t.json('POST', '/chat/completions'))).toMatchObject({
    message: body.error.message,
    status,
    reason: 'new-reason',
    body,
    ...metadata,
  });
});

it.each([undefined, 'final-body'])(
  'does not reuse a previous attempt ID when final headers omit it (%s)',
  async (finalId) => {
    vi.useFakeTimers();
    let count = 0;
    const { t } = setup(
      () =>
        Response.json(
          { error: 'unavailable', ...(++count === 2 ? { request_id: finalId } : {}) },
          { status: 503, headers: count === 1 ? { 'X-Request-ID': 'first-id' } : {} },
        ),
      1,
    );
    const pending = failure(t.json('GET', '/computers'));
    await vi.runAllTimersAsync();
    expect((await pending).requestId).toBe(finalId);
  },
);

it('keeps concurrent request IDs distinct and the CLI error envelope unchanged', async () => {
  const { errorInfo } = await import('../src/cli-output.js');
  const rec = recorder((call) =>
    Response.json(
      { error: 'method not allowed' },
      { status: 405, headers: { 'X-Request-ID': call.path, Allow: 'GET, HEAD, OPTIONS' } },
    ),
  );
  const t = new Transport({ apiKey: 'test', baseUrl: BASE, fetch: rec.fetch });
  const errors = await Promise.all([
    failure(t.json('PUT', '/computers')),
    failure(t.json('PUT', '/sizes')),
  ]);
  expect(errors.map((error) => error.requestId)).toEqual(['/computers', '/sizes']);
  expect(errorInfo(errors[0])).toEqual({
    code: 'method_not_allowed',
    message: 'method not allowed',
    status: 405,
  });
});
