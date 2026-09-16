import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  APIError,
  ConnectionError,
  ConnectionInterruptedError,
  ValidationError,
} from '../src/errors.js';
import { Client } from '../src/index.js';
import { MAX_TIMER_MS, Transport, type TransportOptions } from '../src/transport.js';

const disconnected = () =>
  new TypeError('terminated', {
    cause: Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }),
  });
const refused = () =>
  new TypeError('fetch failed', {
    cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }),
  });
const transport = (
  fetch: typeof globalThis.fetch,
  retries: TransportOptions['retries'] = { idempotent: 2 },
  extra: Partial<TransportOptions> = {},
) =>
  new Transport({
    apiKey: 'test-key',
    baseUrl: 'https://example.test/api/v1',
    fetch,
    retries,
    ...extra,
  });
const brokenBody = (prefix = '{"lost":', status = 200, headers: Record<string, string> = {}) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(prefix));
      },
      pull(c) {
        c.error(disconnected());
      },
    }),
    { status, headers },
  );
async function settle<T>(pending: Promise<T>): Promise<T> {
  // Attach before advancing timers so a deliberately rejected operation is handled.
  const result = pending.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  await vi.runAllTimersAsync();
  const outcome = await result;
  if ('error' in outcome) throw outcome.error;
  return outcome.value;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('retries a GET only when opted in', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(new Response('{}', { status: 503 }))
    .mockResolvedValueOnce(Response.json({ recovered: true }));
  await expect(
    settle(transport(fetch, { idempotent: 1 }).json('GET', '/computers')),
  ).resolves.toEqual({ recovered: true });
  expect(fetch).toHaveBeenCalledTimes(2);
});

it.each([undefined, { idempotent: 0 }])('defaults to one attempt (%j)', async (retries) => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(new Response('{}', { status: 503 }));
  const t = new Transport({ apiKey: 'test', fetch, retries });
  await expect(t.json('GET', '/computers')).rejects.toMatchObject({ status: 503 });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it.each([
  null,
  {},
  [],
  1,
  '1',
  { idempotent: -1 },
  { idempotent: 1.5 },
  { idempotent: NaN },
  { idempotent: Infinity },
  { idempotent: true },
  { idempotent: '2' },
  { idempotent: 1, other: true },
])('rejects malformed policy %j', (retries) => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  expect(() => transport(fetch, retries as TransportOptions['retries'])).toThrow(ValidationError);
  expect(fetch).not.toHaveBeenCalled();
});

it.each(['GET', 'HEAD'])('retries %s with identical URL, query and headers', async (method) => {
  const calls: { url: unknown; init: RequestInit | undefined }[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    calls.push({ url, init });
    return calls.length < 3
      ? new Response(null, { status: 502 })
      : new Response(null, { status: 204 });
  });
  await settle(
    transport(fetch).json(method, '/computers', {
      query: { tag: 'two words', count: 3 },
      headers: { 'X-Test': 'kept' },
    }),
  );
  expect(calls).toHaveLength(3);
  expect(calls[0]?.url).toBe('https://example.test/api/v1/computers?tag=two+words&count=3');
  expect(calls[0]?.init?.headers).toMatchObject({
    Authorization: 'Bearer test-key',
    'X-Test': 'kept',
  });
  for (const call of calls.slice(1)) expect(call).toEqual(calls[0]);
});

it.each([502, 503, 504])(
  'exhausts N additional attempts for %s and preserves final metadata',
  async (status) => {
    let calls = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ error: `failure ${++calls}` }, { status, headers: { 'Retry-After': '2' } }),
    );
    await expect(settle(transport(fetch).json('GET', '/computers'))).rejects.toMatchObject({
      status,
      body: { error: 'failure 3' },
      retryAfterMs: 2000,
    });
    expect(fetch).toHaveBeenCalledTimes(3);
  },
);

it.each([refused, disconnected])(
  'retries connection failures and preserves the final class',
  async (failure) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => {
      throw failure();
    });
    await expect(settle(transport(fetch).json('GET', '/computers'))).rejects.toBeInstanceOf(
      failure === refused ? ConnectionError : ConnectionInterruptedError,
    );
    expect(fetch).toHaveBeenCalledTimes(3);
  },
);

it.each([401, 402, 403, 408, 409, 429, 500, 501, 520, 522])(
  'never retries known HTTP %s, even with a dropped error body',
  async (status) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () => brokenBody('error', status, { 'Retry-After': '9' }));
    await expect(transport(fetch).json('GET', '/computers')).rejects.toMatchObject({
      status,
      retryAfterMs: 9000,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);

for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
  it.each(['status', 'connect', 'body'])(`${method} never retries %s failures`, async (shape) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      if (shape === 'connect') throw refused();
      return shape === 'body' ? brokenBody() : new Response(null, { status: 503 });
    });
    await expect(
      transport(fetch).json(method, '/computers', { body: { name: 'one' } }),
    ).rejects.toBeInstanceOf(Error);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
}

it.each(['/computers/vm/exec/12', '/computers/vm/exec/12/', '/computers/vm/exec/12?offset=0'])(
  'does not replay consuming legacy polls: %s',
  async (path) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => {
      throw disconnected();
    });
    await expect(transport(fetch).json('GET', path)).rejects.toBeInstanceOf(
      ConnectionInterruptedError,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);

it('retries independent execution output reads', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockRejectedValueOnce(disconnected())
    .mockResolvedValueOnce(Response.json({ output: 'once' }));
  await expect(
    settle(
      transport(fetch).json('GET', '/computers/vm/executions/run/output', {
        query: { offset: 17 },
      }),
    ),
  ).resolves.toEqual({ output: 'once' });
});

it.each(['json', 'listing', 'bytes', 'boundedJson', 'boundedBytes'] as const)(
  'restarts a dropped %s body without retaining the lost prefix',
  async (kind) => {
    const binary = kind === 'bytes' || kind === 'boundedBytes';
    const full = binary
      ? 'complete'
      : kind === 'listing'
        ? '[{"id":"complete"}]'
        : '{"id":"complete"}';
    const headers = {
      'content-type': binary ? 'application/octet-stream' : 'application/json',
      'content-length': String(full.length),
    };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(brokenBody('lost', 200, headers))
      .mockResolvedValueOnce(new Response(full, { headers }));
    const t = transport(fetch);
    const pending =
      kind === 'listing'
        ? t.listing('/computers')
        : kind === 'boundedJson' || kind === 'boundedBytes'
          ? t[kind]('GET', '/computers/vm/results/result/output', { maxBytes: 100 })
          : t[kind]('GET', '/computers');
    const result = await settle(pending);
    if (binary)
      expect(new TextDecoder().decode((result as { bytes: Uint8Array }).bytes)).toBe('complete');
    else
      expect(result).toEqual(
        kind === 'listing' ? { items: [{ id: 'complete' }], incomplete: null } : { id: 'complete' },
      );
    expect(fetch).toHaveBeenCalledTimes(2);
  },
);

it.each(['json', 'boundedJson'] as const)(
  'does not retry malformed successful %s',
  async (kind) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response('{bad', { headers: { 'content-type': 'application/json' } }));
    const t = transport(fetch);
    await expect(
      kind === 'json'
        ? t.json('GET', '/computers')
        : t.boundedJson('GET', '/computers', { maxBytes: 30 }),
    ).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);

it('does not retry retained integrity failures', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
    new Response('short', {
      headers: { 'content-type': 'application/octet-stream', 'content-length': '8' },
    }),
  );
  await expect(
    transport(fetch).boundedBytes('GET', '/computers/vm/artifacts/a/download', { maxBytes: 10 }),
  ).rejects.toThrow(/mismatch/);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('doubles backoff to the documented cap', async () => {
  const times: number[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async () => {
    times.push(Date.now());
    return new Response(null, { status: 503 });
  });
  await expect(
    settle(transport(fetch, { idempotent: 9 }).json('GET', '/computers')),
  ).rejects.toBeInstanceOf(APIError);
  expect(times.slice(1).map((time, i) => time - (times[i] ?? 0))).toEqual([
    250, 500, 1000, 2000, 4000, 8000, 16000, 30000, 30000,
  ]);
});

it.each([
  ['0', 250],
  ['3', 3000],
  ['-3', 250],
  ['1.5', 250],
  ['bad', 250],
  ['Wed, 01 Jan 2031 00:00:04 GMT', 4000],
])('honors Retry-After %s as a lower bound', async (header, delay) => {
  vi.setSystemTime(new Date('2031-01-01T00:00:00Z'));
  const times: number[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async () => {
    times.push(Date.now());
    return times.length === 1
      ? new Response(null, { status: 503, headers: { 'Retry-After': header } })
      : Response.json({});
  });
  await settle(transport(fetch).json('GET', '/computers'));
  expect((times[1] ?? 0) - (times[0] ?? 0)).toBe(delay);
});

it('does not shorten an enormous Retry-After into an early attempt', async () => {
  const signal = new AbortController();
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation(
      async () =>
        new Response(null, { status: 503, headers: { 'Retry-After': '999999999999999' } }),
    );
  const pending = transport(fetch, { idempotent: 1 }, { timeoutMs: 0 }).json('GET', '/computers', {
    signal: signal.signal,
  });
  const error = pending.catch((error) => error);
  await vi.advanceTimersByTimeAsync(MAX_TIMER_MS + 1000);
  expect(fetch).toHaveBeenCalledTimes(1);
  const reason = { stop: true };
  signal.abort(reason);
  expect(await error).toBe(reason);
  expect(vi.getTimerCount()).toBe(0);
});

it('aborts backoff with the caller exact reason and removes its listener', async () => {
  const controller = new AbortController();
  const add = vi.spyOn(controller.signal, 'addEventListener');
  const remove = vi.spyOn(controller.signal, 'removeEventListener');
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation(async () => new Response(null, { status: 503 }));
  const error = transport(fetch, { idempotent: 3 }, { timeoutMs: 0 })
    .json('GET', '/computers', { signal: controller.signal })
    .catch((error) => error);
  await vi.advanceTimersByTimeAsync(100);
  const reason = new Error('stop now');
  controller.abort(reason);
  expect(await error).toBe(reason);
  await vi.runAllTimersAsync();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(remove.mock.calls.length).toBe(add.mock.calls.length);
});

it('uses one deadline across fetch, finite body and backoff', async () => {
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('deadline', 'TimeoutError')), ms);
    return controller.signal;
  });
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation(async () => new Response(null, { status: 503 }));
  await expect(
    settle(transport(fetch, { idempotent: 4 }, { timeoutMs: 600 }).json('GET', '/computers')),
  ).rejects.toBeInstanceOf(ConnectionInterruptedError);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(AbortSignal.timeout).toHaveBeenCalledTimes(1);
});

it.each(['json', 'bytes', 'boundedBytes'] as const)(
  'cancels an in-flight %s reader before exposing partial content',
  async (kind) => {
    const cancelled = vi.fn();
    const controller = new AbortController();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array([1]));
          },
          cancel: cancelled,
        }),
        { headers: { 'content-type': 'application/octet-stream', 'content-length': '2' } },
      ),
    );
    const t = transport(fetch, { idempotent: 2 }, { timeoutMs: 0 });
    const result = (
      kind === 'boundedBytes'
        ? t.boundedBytes('GET', '/computers/vm/results/r/output', {
            maxBytes: 2,
            signal: controller.signal,
          })
        : t[kind]('GET', '/computers', { signal: controller.signal })
    ).catch((error) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(cancelled).not.toHaveBeenCalled();
    const reason = new Error('done');
    controller.abort(reason);
    expect(await result).toBe(reason);
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);

it('never retries a timeout exception even before the operation deadline', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockRejectedValue(new DOMException('timeout', 'TimeoutError'));
  await expect(transport(fetch).json('GET', '/computers')).rejects.toBeInstanceOf(
    ConnectionInterruptedError,
  );
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('copies policy at construction and keeps concurrent counters independent', async () => {
  const policy = { idempotent: 1 };
  const counts = new Map<string, number>();
  const fetch = vi.fn<typeof globalThis.fetch>(async (url) => {
    const key = String(url);
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    return count === 1 ? new Response(null, { status: 503 }) : Response.json({ key });
  });
  const t = transport(fetch, policy);
  policy.idempotent = 0;
  await settle(Promise.all([t.json('GET', '/computers/a'), t.json('GET', '/computers/b')]));
  expect([...counts.values()]).toEqual([2, 2]);
});

it('retries SSE only before exposing its first application frame', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(
      brokenBody(': heartbeat\n\n', 200, { 'content-type': 'text/event-stream' }),
    )
    .mockResolvedValueOnce(
      new Response('event: ready\ndata: {"id":2}\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      }),
    );
  const collect = async () => {
    const events: unknown[] = [];
    for await (const event of transport(fetch).sse('GET', '/builds/b/events')) events.push(event);
    return events;
  };
  await expect(settle(collect())).resolves.toEqual([{ event: 'ready', data: { id: 2 } }]);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('never reopens SSE after exposing a frame', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(
      brokenBody('event: ready\ndata: {"id":1}\n\n', 200, { 'content-type': 'text/event-stream' }),
    );
  const events: unknown[] = [];
  const collect = async () => {
    for await (const event of transport(fetch).sse('GET', '/builds/b/events')) events.push(event);
  };
  await expect(collect()).rejects.toBeInstanceOf(ConnectionInterruptedError);
  expect(events).toHaveLength(1);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('never retries POST agent streams or public creates', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation(async () => new Response(null, { status: 503 }));
  const stream = transport(fetch).sse('POST', '/computers/vm/agent', { body: { task: 'one' } });
  await expect(stream.next()).rejects.toBeInstanceOf(APIError);
  const client = new Client({ apiKey: 'test', fetch, retries: { idempotent: 3 } });
  await expect(client.computers.create({ name: 'one', template: 'base' })).rejects.toBeInstanceOf(
    APIError,
  );
  expect(fetch).toHaveBeenCalledTimes(2);
});

it.each([
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'ERR_TLS_HANDSHAKE_TIMEOUT',
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
])('never retries native timeout cause %s', async (code) => {
  const failure = new TypeError('fetch failed', {
    cause: Object.assign(new Error('network phase timed out'), { code }),
  });
  const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(failure);
  await expect(transport(fetch).json('GET', '/computers')).rejects.toBeInstanceOf(ConnectionError);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('keeps template preparation single-shot with retries enabled', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation(async () => new Response(null, { status: 503 }));
  const client = new Client({ apiKey: 'test', fetch, retries: { idempotent: 3 } });
  await expect(
    client.computers.create({ template: 'base', templateTransfer: 'opaque-token' }),
  ).rejects.toBeInstanceOf(APIError);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('HEAD cannot replay a legacy consuming execution poll', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(disconnected());
  await expect(transport(fetch).json('HEAD', '/computers/vm/exec/12')).rejects.toBeInstanceOf(
    ConnectionInterruptedError,
  );
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('cancels a response that arrives after its fetch was abandoned', async () => {
  const cancelled = vi.fn();
  const controller = new AbortController();
  let finish: ((response: Response) => void) | undefined;
  const fetch = vi.fn<typeof globalThis.fetch>(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const failure = transport(fetch)
    .json('GET', '/computers', { signal: controller.signal })
    .catch((error) => error);
  const reason = new Error('cancel');
  controller.abort(reason);
  expect(await failure).toBe(reason);
  finish?.(new Response(new ReadableStream({ cancel: cancelled })));
  await vi.advanceTimersByTimeAsync(0);
  expect(cancelled).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('does not retry early when a digit-only Retry-After overflows Number', async () => {
  const controller = new AbortController();
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation(
      async () => new Response(null, { status: 503, headers: { 'Retry-After': '9'.repeat(309) } }),
    );
  const failure = transport(fetch, { idempotent: 2 }, { timeoutMs: 0 })
    .json('GET', '/computers', { signal: controller.signal })
    .catch((error) => error);
  await vi.advanceTimersByTimeAsync(1000);
  const reason = new Error('stop enormous wait');
  controller.abort(reason);
  expect(await failure).toBe(reason);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['json', 'sse'] as const)(
  'treats a malformed compressed %s body as terminal',
  async (kind) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => {
      const encoded = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('not a gzip body'));
          controller.close();
        },
      });
      return new Response(encoded.pipeThrough(new DecompressionStream('gzip')), {
        headers: {
          'content-type': kind === 'sse' ? 'text/event-stream' : 'application/json',
          'content-encoding': 'gzip',
        },
      });
    });
    const t = transport(fetch);
    await expect(
      kind === 'sse' ? t.sse('GET', '/builds/b/events').next() : t.json('GET', '/computers'),
    ).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  },
);

const readModes = ['json', 'listing', 'bytes', 'boundedJson', 'boundedBytes', 'sse'] as const;
type ReadMode = (typeof readModes)[number];
const readMode = (t: Transport, kind: ReadMode): Promise<unknown> => {
  if (kind === 'sse') return t.sse('GET', '/builds/b/events').next();
  if (kind === 'listing') return t.listing('/computers');
  if (kind === 'boundedJson' || kind === 'boundedBytes')
    return t[kind]('GET', '/computers/vm/results/r/output', { maxBytes: 100 });
  return t[kind]('GET', '/computers');
};
const modeHeaders = (kind: ReadMode) => ({
  'content-type':
    kind === 'sse'
      ? 'text/event-stream'
      : kind === 'bytes' || kind === 'boundedBytes'
        ? 'application/octet-stream'
        : 'application/json',
  'content-length': '2',
});
const recoveredRead = (kind: ReadMode) =>
  new Response(kind === 'sse' ? 'data: {}\n\n' : kind === 'listing' ? '[]' : '{}', {
    headers: modeHeaders(kind),
  });

for (const kind of readModes) {
  for (const status of [200, 429, 500, 502, 503, 504]) {
    for (const idempotent of [0, 1]) {
      it.each(['name', 'code', 'nested', 'unknown'])(
        `${kind} HTTP ${status} preserves terminal body failure %s with retries=${idempotent}`,
        async (shape) => {
          const failure =
            shape === 'name'
              ? Object.assign(new Error('body timed out'), { name: 'BodyTimeoutError' })
              : shape === 'code'
                ? Object.assign(new Error('body timed out'), { code: 'UND_ERR_BODY_TIMEOUT' })
                : shape === 'nested'
                  ? new TypeError('terminated', {
                      cause: new AggregateError([
                        new Error('another failure'),
                        new Error('body failed', {
                          cause: Object.assign(new Error('body timed out'), {
                            code: 'UND_ERR_BODY_TIMEOUT',
                          }),
                        }),
                      ]),
                    })
                  : new Error('unclassified body failure');
          const response = new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.error(failure);
              },
            }),
            { status, headers: { ...modeHeaders(kind), 'Retry-After': '9' } },
          );
          const fetch = vi
            .fn<typeof globalThis.fetch>()
            .mockResolvedValueOnce(response)
            .mockImplementation(async () => recoveredRead(kind));
          const error = await settle(
            readMode(transport(fetch, { idempotent }, { timeoutMs: 0 }), kind),
          ).catch((error) => error);
          expect(fetch).toHaveBeenCalledTimes(1);
          expect(error).toBeInstanceOf(Error);
          if (status !== 200) {
            expect(error).toBeInstanceOf(APIError);
            expect(error).toMatchObject({ status, retryAfterMs: 9000, body: undefined });
            // Preserve the default status error's public shape, including its absent cause.
            expect(error).not.toHaveProperty('cause');
            expect(error).toHaveProperty(
              'name',
              status === 429
                ? 'RateLimitError'
                : status === 503
                  ? 'UnavailableError'
                  : status === 504
                    ? 'GatewayTimeoutError'
                    : 'APIError',
            );
          }
          expect(vi.getTimerCount()).toBe(0);
        },
      );

      it(`${kind} HTTP ${status} does not replay native gzip failure with retries=${idempotent}`, async () => {
        // Native decompression completes outside Vitest's fake timer queue.
        vi.useRealTimers();
        const encoded = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('not a gzip body'));
            controller.close();
          },
        });
        const response = new Response(encoded.pipeThrough(new DecompressionStream('gzip')), {
          status,
          headers: { ...modeHeaders(kind), 'content-encoding': 'gzip', 'Retry-After': '0' },
        });
        const fetch = vi
          .fn<typeof globalThis.fetch>()
          .mockResolvedValueOnce(response)
          .mockImplementation(async () => recoveredRead(kind));
        const error = await readMode(
          transport(fetch, { idempotent }, { timeoutMs: 0 }),
          kind,
        ).catch((error) => error);
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(error).toBeInstanceOf(Error);
        if (status !== 200) {
          expect(error).toBeInstanceOf(APIError);
          expect(error).toMatchObject({ status, retryAfterMs: 0, body: undefined });
          expect(error).not.toHaveProperty('cause');
        }
      });
    }
  }

  for (const status of [502, 503, 504]) {
    it.each([0, 1])(
      `${kind} HTTP ${status} retains ordinary socket interruption behavior with retries=%s`,
      async (idempotent) => {
        const times: number[] = [];
        const fetch = vi.fn<typeof globalThis.fetch>(async () => {
          times.push(Date.now());
          return brokenBody('lost error body', status, { 'Retry-After': '9' });
        });
        const error = await settle(
          readMode(transport(fetch, { idempotent }, { timeoutMs: 0 }), kind),
        ).catch((error) => error);
        expect(fetch).toHaveBeenCalledTimes(idempotent + 1);
        expect(times.slice(1).map((time, index) => time - (times[index] ?? 0))).toEqual(
          idempotent ? [9000] : [],
        );
        expect(error).toBeInstanceOf(APIError);
        expect(error).toMatchObject({ status, retryAfterMs: 9000, body: undefined });
        expect(error).not.toHaveProperty('cause');
        expect(vi.getTimerCount()).toBe(0);
      },
    );
  }
}
