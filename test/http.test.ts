/** The transport: auth, status mapping, listings, streams. */

import { describe, expect, it, vi } from 'vitest';
import {
  APIError,
  AuthenticationError,
  Client,
  ConflictError,
  isTransient,
  MandalaError,
  NotFoundError,
  PermissionDeniedError,
  PlanLimitError,
  UnavailableError,
} from '../src/index.js';
import { anyRoute, BASE, COMPUTER, errorJson, json, recorder } from './harness.js';

const client = (rec: ReturnType<typeof recorder>, opts = {}) =>
  new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch, ...opts });

describe('auth', () => {
  it('refuses to build without a key, naming where to get one', () => {
    const saved = process.env.MANDALA_API_KEY;
    delete process.env.MANDALA_API_KEY;
    try {
      expect(() => new Client()).toThrow(/Settings → API keys/);
    } finally {
      if (saved !== undefined) process.env.MANDALA_API_KEY = saved;
    }
  });

  it('reads the key and base URL from the environment', () => {
    process.env.MANDALA_API_KEY = 'com_from_env';
    process.env.MANDALA_BASE_URL = 'https://self.hosted/api/v1/';
    try {
      // The trailing slash is stripped, so paths do not double up on it.
      expect(new Client().baseUrl).toBe('https://self.hosted/api/v1');
    } finally {
      delete process.env.MANDALA_API_KEY;
      delete process.env.MANDALA_BASE_URL;
    }
  });

  it('sends the key as a bearer token and nothing else', async () => {
    const rec = recorder(anyRoute);
    await client(rec).computers.list();
    expect(rec.last().headers.Authorization).toBe('Bearer com_test');
  });

  it('keeps the key off the error, which is the thing that gets logged', async () => {
    const rec = recorder(() => errorJson(401, 'that key has been revoked'));
    const err = await client(rec)
      .computers.list()
      .catch((e) => e);
    expect(JSON.stringify({ message: err.message, body: err.body })).not.toContain('com_test');
  });
});

describe('status mapping', () => {
  const cases: [number, unknown][] = [
    [401, AuthenticationError],
    [402, PlanLimitError],
    [403, PermissionDeniedError],
    [404, NotFoundError],
    [409, ConflictError],
    [503, UnavailableError],
    [500, APIError],
  ];

  for (const [status, Cls] of cases) {
    it(`maps ${status}`, async () => {
      const rec = recorder(() => errorJson(status, 'the platform said so'));
      const err = await client(rec)
        .computers.list()
        .catch((e) => e);
      expect(err).toBeInstanceOf(Cls);
      // The platform's own message survives. These are written to be acted on,
      // and replacing them with a status line throws away the only part of the
      // response a caller can do anything with.
      expect(err.message).toBe('the platform said so');
      expect(err.status).toBe(status);
    });
  }

  it('falls back to the status line when there was no message', async () => {
    const rec = recorder(() => new Response('', { status: 500 }));
    const err = await client(rec)
      .computers.list()
      .catch((e) => e);
    expect(err.message).toBe('HTTP 500');
  });

  it('keeps a non-JSON error body, truncated', async () => {
    const rec = recorder(() => new Response('x'.repeat(2000), { status: 502 }));
    const err = await client(rec)
      .computers.list()
      .catch((e) => e);
    expect(err.message).toHaveLength(500);
  });

  it('knows which failures are worth retrying', () => {
    expect(isTransient(new ConflictError('', 409))).toBe(true);
    expect(isTransient(new UnavailableError('', 503))).toBe(true);
    expect(isTransient(new PlanLimitError('', 402))).toBe(false);
    expect(isTransient(new Error('boom'))).toBe(false);
  });
});

describe('decoding', () => {
  it('names the request when a proxy answers 200 with HTML', async () => {
    // A bare `SyntaxError: Unexpected token '<'` does not say which request
    // went wrong, and a captive portal is exactly when you need to know.
    const rec = recorder(
      () => new Response('<!DOCTYPE html><title>Sign in</title>', { status: 200 }),
    );
    await expect(client(rec).computers.list()).rejects.toThrow(
      /expected JSON from GET computers, got: <!DOCTYPE/,
    );
  });

  it('treats an empty body and a 204 as nothing, not as a parse failure', async () => {
    const rec = recorder(() => new Response(null, { status: 204 }));
    await expect(client(rec).snapshots.restore('snap-1')).resolves.toBeUndefined();
  });

  it('rewrites a network failure to name the platform, not the DNS error', async () => {
    const rec = recorder(() => {
      throw new TypeError('fetch failed');
    });
    await expect(client(rec).computers.list()).rejects.toThrow(
      new RegExp(`could not reach ${BASE}`),
    );
  });

  it('reports a timeout as a timeout, not as an abort', async () => {
    // Left raw, AbortSignal.timeout says only "the operation was aborted",
    // which is indistinguishable from a caller cancelling on purpose.
    const rec = recorder(async () => {
      await new Promise((r) => setTimeout(r, 50));
      return json([]);
    });
    await expect(client(rec, { timeoutMs: 5 }).computers.list()).rejects.toThrow(/timed out/);
  });

  it("composes the caller's cancellation with the client's deadline", async () => {
    // A request that has both must honour both, so the signal is composed with
    // AbortSignal.any rather than replacing the caller's.
    const ac = new AbortController();
    const rec = recorder(async () => {
      await new Promise((r) => setTimeout(r, 200));
      return json([]);
    });
    const c = client(rec, { timeoutMs: 10_000 });
    setTimeout(() => ac.abort(new Error('caller went away')), 5);
    const err = await c.computers.get('vm-1', { signal: ac.signal }).catch((e) => e);
    // Sent under the client's own 10s deadline, and still cancelled at 5ms —
    // which only happens if both signals are live on the one request.
    expect(String(err)).toMatch(/caller went away/);
  });

  it('still applies the deadline when a caller passes a signal that never fires', async () => {
    const rec = recorder(async () => {
      await new Promise((r) => setTimeout(r, 200));
      return json([]);
    });
    const never = new AbortController();
    await expect(
      client(rec, { timeoutMs: 10 }).computers.list({ signal: never.signal }),
    ).rejects.toThrow(/timed out/);
  });
});

describe('listings', () => {
  it('reports a short fleet read rather than passing it off as the whole one', async () => {
    // A short list reads exactly like the missing computers were deleted.
    const rec = recorder(
      () =>
        new Response(JSON.stringify([COMPUTER]), {
          status: 200,
          headers: { 'content-type': 'application/json', 'X-GC-Incomplete': '3' },
        }),
    );
    const { items, incomplete } = await client(rec).computers.listWithStatus({
      allowPartial: true,
    });
    expect(items).toHaveLength(1);
    expect(incomplete).toBe(3);
    expect(rec.last().query.allow_partial).toBe('1');
  });

  it('distinguishes a complete answer from a zero-count short one', async () => {
    // 0 is legitimate: a computer created during the outage was never cached
    // against the host now holding it. So presence is the signal.
    const short = recorder(
      () =>
        new Response('[]', {
          status: 200,
          headers: { 'content-type': 'application/json', 'X-GC-Incomplete': '0' },
        }),
    );
    expect((await client(short).computers.listWithStatus()).incomplete).toBe(0);

    const whole = recorder(() => json([]));
    expect((await client(whole).computers.listWithStatus()).incomplete).toBeNull();
  });

  it('does not ask for a partial answer unless told to', async () => {
    const rec = recorder(anyRoute);
    await client(rec).computers.list();
    expect(rec.last().query).not.toHaveProperty('allow_partial');
  });
});

describe('bytes', () => {
  it('returns the screenshot body untouched', async () => {
    const rec = recorder(anyRoute);
    const c = await client(rec).computers.get('vm-1');
    expect(new TextDecoder().decode(await c.screenshot())).toBe('png');
  });

  it('passes a downscale width as the platform spells it', async () => {
    const rec = recorder(anyRoute);
    const c = await client(rec).computers.get('vm-1');
    await c.screenshot(320);
    expect(rec.last().query.w).toBe('320');
  });
});

describe('server-sent events', () => {
  /** The stream for the agent route, and ordinary answers for everything else. */
  const streaming = (text: string) => (call: Parameters<typeof anyRoute>[0]) =>
    call.path.endsWith('/agent') ? stream(text) : anyRoute(call);

  const stream = (text: string, chunkSize = 7): Response => {
    const bytes = new TextEncoder().encode(text);
    let i = 0;
    return new Response(
      new ReadableStream({
        pull(ctrl) {
          if (i >= bytes.length) return ctrl.close();
          ctrl.enqueue(bytes.slice(i, i + chunkSize));
          i += chunkSize;
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  };

  it('reassembles events split across chunk boundaries', async () => {
    const rec = recorder(
      streaming(
        'event: step\ndata: {"n":1,"tool":"computer","action":"left_click"}\n\n' +
          'event: done\ndata: {"steps":1,"stop":"end_turn","text":"ok"}\n\n',
      ),
    );
    const c = await client(rec).computers.get('vm-1');
    const seen = [];
    for await (const ev of c.agentStream({ prompt: 'go', modelKey: 'sk' })) seen.push(ev);
    expect(seen.map((e) => e.type)).toEqual(['step', 'done']);
  });

  it('frames a stream a proxy reframed with CRLF', async () => {
    // Splitting on "\n\n" alone would never find a boundary, collapse the whole
    // run into one unparseable event, and lose the result of a run that had in
    // fact succeeded.
    const rec = recorder(
      streaming('event: done\r\ndata: {"steps":2,"stop":"end_turn","text":"ok"}\r\n\r\n'),
    );
    const c = await client(rec).computers.get('vm-1');
    const result = await c.agent({ prompt: 'go', modelKey: 'sk' });
    expect(result.finished).toBe(true);
    expect(result.steps).toBe(2);
  });

  it('yields a final event with no trailing blank line', async () => {
    const rec = recorder(streaming('event: done\ndata: {"stop":"end_turn"}\n'));
    const c = await client(rec).computers.get('vm-1');
    expect((await c.agent({ prompt: 'go', modelKey: 'sk' })).finished).toBe(true);
  });

  it('skips an event type this SDK does not model', async () => {
    // The platform is free to add types; falling over on the first unrecognised
    // one would turn a forward-compatible addition into an outage.
    const rec = recorder(
      streaming('event: heartbeat\ndata: {}\n\nevent: done\ndata: {"stop":"end_turn"}\n\n'),
    );
    const c = await client(rec).computers.get('vm-1');
    const seen = [];
    for await (const ev of c.agentStream({ prompt: 'go', modelKey: 'sk' })) seen.push(ev.type);
    expect(seen).toEqual(['done']);
  });

  it("is not cut short by the client's per-request deadline", async () => {
    // A stream is meant to stay open — an agent run is minutes of clicking — and
    // the ordinary deadline would kill every one of them at the same place.
    // Passing a dummy signal did NOT achieve this: the composition folds the
    // timeout in whenever there is one, so the stream needs an explicit exemption.
    const rec = recorder(async (call) => {
      if (!call.path.endsWith('/agent')) return anyRoute(call);
      await new Promise((r) => setTimeout(r, 60));
      return stream('event: done\ndata: {"stop":"end_turn"}\n\n');
    });
    const c = await client(rec, { timeoutMs: 20 }).computers.get('vm-1');
    const res = await c.agent({ prompt: 'go', modelKey: 'sk' });
    expect(res.finished).toBe(true);
  });

  it('still stops a stream when the caller says so', async () => {
    const ac = new AbortController();
    const rec = recorder(async (call) => {
      if (!call.path.endsWith('/agent')) return anyRoute(call);
      await new Promise((r) => setTimeout(r, 200));
      return stream('event: done\ndata: {"stop":"end_turn"}\n\n');
    });
    const c = await client(rec).computers.get('vm-1');
    setTimeout(() => ac.abort(new Error('caller went away')), 5);
    await expect(c.agent({ prompt: 'go', modelKey: 'sk', signal: ac.signal })).rejects.toThrow(
      /caller went away/,
    );
  });

  it('forwards the model key on the one route that runs a model', async () => {
    const rec = recorder(streaming('event: done\ndata: {"stop":"end_turn"}\n\n'));
    const c = await client(rec).computers.get('vm-1');
    await c.agent({ prompt: 'go', modelKey: 'sk-ant-test' });
    expect(rec.last().headers['X-Model-Key']).toBe('sk-ant-test');
  });

  it('refuses to start a run with no model key of your own', async () => {
    const rec = recorder(anyRoute);
    const c = await client(rec).computers.get('vm-1');
    await expect(c.agent({ prompt: 'go', modelKey: '' })).rejects.toThrow(/does not store one/);
  });
});

describe('MandalaError', () => {
  it('is the base of everything this SDK throws', () => {
    expect(new APIError('x', 400)).toBeInstanceOf(MandalaError);
    expect(new ConflictError('x', 409)).toBeInstanceOf(APIError);
  });
});

// Keep vi imported-and-used so the linter does not strip it in a future edit.
it('has a working test runner', () => {
  expect(vi.isMockFunction(() => {})).toBe(false);
});
