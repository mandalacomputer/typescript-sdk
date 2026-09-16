import { expect, it, vi } from 'vitest';
import { Client, ConnectionInterruptedError } from '../src/index.js';
import { Transport } from '../src/transport.js';
import { anyRoute, BASE, json, recorder } from './harness.js';

const RID = `res_${'a'.repeat(32)}`;
const setup = async (response: () => Response) => {
  const rec = recorder((call) => (call.path.includes('/results/') ? response() : anyRoute(call)));
  const c = await new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch }).computers.get(
    'vm-1',
  );
  return { c, rec };
};
const headers = (length?: number) => ({
  'Content-Type': 'application/octet-stream',
  ...(length === undefined ? {} : { 'Content-Length': String(length) }),
  'X-Result-Offset': '0',
  'X-Result-Next-Offset': String(length ?? 0),
  'X-Result-EOF': 'true',
});
const streamed = (
  chunks: Uint8Array[],
  status = 200,
  extra: Record<string, string> = {},
  length?: number,
) => {
  let read = 0,
    cancel = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const chunk = chunks[read++];
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
      cancel() {
        cancel++;
      },
    },
    { highWaterMark: 0 },
  );
  return {
    response: new Response(body, { status, headers: { ...headers(length), ...extra } }),
    counts: () => ({ read, cancel }),
  };
};
it('accepts exact cap only after EOF and retains owned bytes across split chunks', async () => {
  const all = Uint8Array.from({ length: 256 }, (_, i) => i);
  const f = streamed([all.subarray(0, 239), all.subarray(239)], 200, {}, 256);
  const { c } = await setup(() => f.response);
  const result = await c.resultOutput(RID, { stream: 'stdout', offset: 0, limit: 256 });
  expect(result.bytes).toEqual(all);
  expect(f.counts()).toEqual({ read: 3, cancel: 0 });
  all.fill(42);
  expect(result.bytes[0]).toBe(0);
  expect(result.bytes[255]).toBe(255);
});
it('rejects cap plus one and cancels before pulling more chunks', async () => {
  const f = streamed([new Uint8Array(3), new Uint8Array(1), new Uint8Array(10000)], 200, {}, 3);
  const { c } = await setup(() => f.response);
  await expect(c.resultOutput(RID, { stream: 'stdout', offset: 0, limit: 3 })).rejects.toThrow(
    /limit/,
  );
  expect(f.counts()).toEqual({ read: 2, cancel: 1 });
});
it('rejects one enormous incoming chunk without retaining a successful prefix', async () => {
  const f = streamed([new Uint8Array(1024 * 1024), new Uint8Array(1)], 200, {}, 1);
  const { c } = await setup(() => f.response);
  await expect(c.resultOutput(RID, { stream: 'stdout', offset: 0, limit: 1 })).rejects.toThrow(
    /limit/,
  );
  expect(f.counts()).toEqual({ read: 1, cancel: 1 });
});
it('rejects early EOF despite a matching allowed Content-Length', async () => {
  const f = streamed([new Uint8Array(2)], 200, {}, 3);
  const { c } = await setup(() => f.response);
  await expect(c.resultOutput(RID, { stream: 'stdout', offset: 0, limit: 3 })).rejects.toThrow(
    /mismatch/,
  );
});
it.each([
  [206, {}, 3],
  [200, { 'Content-Range': 'bytes 0-2/3' }, 3],
  [200, { 'Content-Encoding': 'gzip' }, 3],
  [200, { 'Content-Type': 'text/plain' }, 3],
  [200, {}, undefined],
  [200, { 'Content-Length': '3, 3' }, 3],
  [200, { 'Content-Length': '03' }, 3],
  [200, {}, 4],
] as const)(
  'refuses invalid full-response headers/status %j before reading',
  async (status, extra, length) => {
    const f = streamed([new Uint8Array(3)], status, extra, length);
    const { c } = await setup(() => f.response);
    await expect(c.resultOutput(RID, { stream: 'stdout', offset: 0, limit: 3 })).rejects.toThrow();
    expect(f.counts()).toEqual({ read: 0, cancel: 1 });
  },
);
it('bounds chunked JSON without relying on Content-Length and requires EOF at its cap', async () => {
  const bytes = new TextEncoder().encode('{"x":1}');
  const exact = streamed([bytes], 200, { 'Content-Type': 'application/json' });
  const t = new Transport({ apiKey: 'com_test', baseUrl: BASE, fetch: async () => exact.response });
  expect(
    await t.boundedJson('GET', `computers/vm-1/results/${RID}`, { maxBytes: bytes.length }),
  ).toEqual({ x: 1 });
  expect(exact.counts().read).toBe(2);
  const over = streamed([bytes, new Uint8Array([32]), new Uint8Array(100000)], 200, {
    'Content-Type': 'application/json',
  });
  const t2 = new Transport({ apiKey: 'com_test', baseUrl: BASE, fetch: async () => over.response });
  await expect(
    t2.boundedJson('GET', `computers/vm-1/results/${RID}`, { maxBytes: bytes.length }),
  ).rejects.toThrow(/limit/);
  expect(over.counts()).toEqual({ read: 2, cancel: 1 });
});
it.each([new Uint8Array([255]), new TextEncoder().encode('[]'), new TextEncoder().encode('{')])(
  'rejects malformed finite JSON',
  async (bytes) => {
    const f = streamed([bytes], 200, { 'Content-Type': 'application/json' });
    const t = new Transport({ apiKey: 'com_test', baseUrl: BASE, fetch: async () => f.response });
    await expect(
      t.boundedJson('POST', 'computers/vm-1/artifacts', { maxBytes: 4096 }),
    ).rejects.toThrow(/unconfirmed/);
  },
);
it('preserves a body reset as interrupted, never successful partial bytes', async () => {
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(new TypeError('terminated', { cause: { code: 'UND_ERR_SOCKET' } }));
    },
  });
  const { c, rec } = await setup(() => new Response(body, { headers: headers(3) }));
  await expect(c.resultOutput(RID, { stream: 'stdout', offset: 0 })).rejects.toBeInstanceOf(
    ConnectionInterruptedError,
  );
  expect(rec.calls).toHaveLength(2);
});
it('cancels a held body on custom caller abort even when fetch ignores it', async () => {
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => {
    started = resolve;
  });
  let cancelled = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull() {
        started();
        return new Promise(() => {});
      },
      cancel() {
        cancelled++;
      },
    },
    { highWaterMark: 0 },
  );
  const { c } = await setup(() => new Response(body, { headers: headers(1) }));
  const ac = new AbortController();
  const reason = { reason: 'private cancellation' };
  const pending = c.resultOutput(RID, { stream: 'stdout', offset: 0, signal: ac.signal });
  await waiting;
  ac.abort(reason);
  await expect(pending).rejects.toBe(reason);
  expect(cancelled).toBe(1);
});
it('maps a held bounded body deadline to interrupted and cancels without waiting for peer cleanup', async () => {
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => {
    started = resolve;
  });
  let cancelled = 0;
  const { c } = await setup(
    () =>
      new Response(
        new ReadableStream(
          {
            pull() {
              started();
              return new Promise(() => {});
            },
            cancel() {
              cancelled++;
              return new Promise(() => {});
            },
          },
          { highWaterMark: 0 },
        ),
        { headers: headers(1) },
      ),
  );
  const deadline = new AbortController();
  const spy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
  try {
    const pending = c.resultOutput(RID, { stream: 'stdout', offset: 0 });
    await waiting;
    deadline.abort(new DOMException('deadline', 'TimeoutError'));
    await expect(pending).rejects.toBeInstanceOf(ConnectionInterruptedError);
    expect(cancelled).toBe(1);
  } finally {
    spy.mockRestore();
  }
});
it('preserves bounded HTTP error classes while cancelling a huge proxy body', async () => {
  const f = streamed([new Uint8Array(1 << 20), new Uint8Array(1 << 20)], 409, {
    'Content-Type': 'text/html',
  });
  const { c, rec } = await setup(() => f.response);
  await expect(c.resultOutput(RID, { stream: 'stdout', offset: 0 })).rejects.toMatchObject({
    status: 409,
  });
  expect(f.counts()).toEqual({ read: 1, cancel: 1 });
  expect(rec.calls).toHaveLength(2);
});
it('cancels a held HTTP error body with the original custom reason', async () => {
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => {
    started = resolve;
  });
  let cancelled = 0;
  const { c } = await setup(
    () =>
      new Response(
        new ReadableStream(
          {
            pull() {
              started();
              return new Promise(() => {});
            },
            cancel() {
              cancelled++;
            },
          },
          { highWaterMark: 0 },
        ),
        { status: 409 },
      ),
  );
  const ac = new AbortController();
  const reason = new Error('cancel');
  const pending = c.resultOutput(RID, { stream: 'stdout', offset: 0, signal: ac.signal });
  await waiting;
  ac.abort(reason);
  await expect(pending).rejects.toBe(reason);
  expect(cancelled).toBe(1);
});
it('refuses a redirect after one request without following its Location', async () => {
  const { c, rec } = await setup(
    () =>
      new Response(null, { status: 302, headers: { Location: 'https://foreign.test/private' } }),
  );
  await expect(c.result(RID)).rejects.toMatchObject({ status: 302 });
  expect(rec.calls).toHaveLength(2);
});
it('checks cancellation before dispatch for all retained methods', async () => {
  const { c, rec } = await setup(() => json({}));
  const ac = new AbortController();
  const reason = new Error('stop');
  ac.abort(reason);
  const opts = { signal: ac.signal };
  const aid = `art_${'a'.repeat(32)}`,
    eid = `exec_${'a'.repeat(32)}`;
  for (const call of [
    () => c.retainExecutionOutput(eid, opts),
    () => c.result(RID, opts),
    () => c.resultOutput(RID, { ...opts, stream: 'stdout', offset: 0 }),
    () => c.deleteResult(RID, opts),
    () => c.publishArtifact('/tmp/f', { ...opts, expectedSize: 0, expectedSha256: '0'.repeat(64) }),
    () => c.artifact(aid, opts),
    () => c.downloadArtifact(aid, opts),
    () => c.deleteArtifact(aid, opts),
  ])
    await expect(call()).rejects.toBe(reason);
  expect(rec.calls).toHaveLength(1);
});
it('waits for EOF at an exact cap and still permits caller cancellation there', async () => {
  let pull = 0,
    cancelled = 0,
    started!: () => void;
  const waiting = new Promise<void>((resolve) => {
    started = resolve;
  });
  const { c } = await setup(
    () =>
      new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              if (pull++ === 0) {
                controller.enqueue(new Uint8Array([1]));
                return;
              }
              started();
              return new Promise(() => {});
            },
            cancel() {
              cancelled++;
            },
          },
          { highWaterMark: 0 },
        ),
        { headers: headers(1) },
      ),
  );
  const ac = new AbortController();
  const reason = new Error('EOF never arrived');
  let settled = false;
  const pending = c.resultOutput(RID, { stream: 'stdout', offset: 0, limit: 1, signal: ac.signal });
  void pending.then(
    () => {
      settled = true;
    },
    () => {},
  );
  await waiting;
  expect(settled).toBe(false);
  ac.abort(reason);
  await expect(pending).rejects.toBe(reason);
  expect(cancelled).toBe(1);
});
it('bounds a stalled header request and disposes a late response without replay', async () => {
  let finish!: (r: Response) => void;
  let cancelled = 0;
  const fetch = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  const t = new Transport({ apiKey: 'com_test', baseUrl: BASE, fetch });
  const ac = new AbortController();
  const reason = new Error('cancel headers');
  const pending = t.boundedJson('POST', 'computers/vm-1/artifacts', {
    signal: ac.signal,
    maxBytes: 4096,
    expectedStatus: 201,
  });
  ac.abort(reason);
  await expect(pending).rejects.toBe(reason);
  finish(
    new Response(
      new ReadableStream(
        {
          cancel() {
            cancelled++;
          },
        },
        { highWaterMark: 0 },
      ),
      { status: 201 },
    ),
  );
  await Promise.resolve();
  await Promise.resolve();
  expect(cancelled).toBe(1);
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('does not accumulate per-chunk buffers for tiny pages', async () => {
  let reads = 0;
  const bytes = Uint8Array.of(0);
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (reads++ < 8192) controller.enqueue(bytes);
        else controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  const { c } = await setup(() => new Response(body, { headers: headers(8192) }));
  const result = await c.resultOutput(RID, { stream: 'stdout', offset: 0, limit: 8192 });
  expect(result.bytes.length).toBe(8192);
  expect(result.bytes.buffer.byteLength).toBe(8192);
  expect(reads).toBe(8193);
});
