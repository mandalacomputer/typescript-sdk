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
import { anyRoute, BASE, COMPUTER, errorJson, json, recorder, SNAPSHOT } from './harness.js';

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

describe('the client deadline', () => {
  it('refuses a timeout that is not a finite number, rather than disabling itself', () => {
    // `timeoutMs: Number(unsetEnvVar)` is the usual spelling. Absorbed, a NaN
    // reads as "no timeout" and silently removes the one guard against a
    // request hanging forever; a negative reaches the same place, and an
    // Infinity surfaces later as a baffling "could not reach <baseUrl>".
    for (const timeoutMs of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      expect(() => new Client({ apiKey: 'com_test', baseUrl: BASE, timeoutMs })).toThrow(
        /non-negative finite number/,
      );
    }
  });

  it('still takes 0, which is how the deadline is turned off', () => {
    expect(() => new Client({ apiKey: 'com_test', baseUrl: BASE, timeoutMs: 0 })).not.toThrow();
  });

  it('names a deadline that fires while the body is still arriving', async () => {
    // The composed signal governs the body as well as the headers, so a
    // download whose bytes stop arriving is aborted after the fetch already
    // resolved — outside the translation that names a timeout. Left raw it says
    // only "the operation was aborted", which is what a caller cancelling on
    // purpose says too. The stream is wired to the signal here because that is
    // what a real fetch does with one.
    const stalling = (async (_url: unknown, init?: RequestInit) => {
      const signal = init?.signal;
      return new Response(
        new ReadableStream({
          start(ctrl) {
            ctrl.enqueue(new TextEncoder().encode('{"id":'));
            signal?.addEventListener('abort', () => ctrl.error(signal.reason), { once: true });
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof globalThis.fetch;
    const c = new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: stalling, timeoutMs: 40 });
    await expect(c.computers.get('vm-1')).rejects.toThrow(/timed out after 40ms/);
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

  it("reports a caller's custom abort reason as the cancellation it is", async () => {
    // Judged by the signal, not the reason's name: a custom reason used to
    // fall through to the "could not reach" rewrite — a deliberate stop
    // reported as platform unreachability, to any retry logic keyed on
    // MandalaError.
    const ac = new AbortController();
    const rec = recorder(async () => {
      await new Promise((r) => setTimeout(r, 200));
      return json([]);
    });
    setTimeout(() => ac.abort(new Error('caller went away')), 5);
    const err = await client(rec)
      .computers.get('vm-1', { signal: ac.signal })
      .catch((e) => e);
    expect(err).not.toBeInstanceOf(MandalaError);
    expect(err.message).toBe('caller went away');
  });

  it('lets an exec outlive the client deadline it explicitly granted the guest', async () => {
    // exec(cmd, { timeoutS }) gives the guest that long to finish, so the HTTP
    // request has to outlive it — under the fixed client deadline alone, any
    // longer timeoutS was aborted client-side while the command ran on with
    // its output unreachable.
    const rec = recorder(async (call) => {
      if (!call.path.endsWith('/exec')) return anyRoute(call);
      await new Promise((r) => setTimeout(r, 50));
      return json({ exit_code: 0, stdout: '', stderr: '', timed_out: false });
    });
    const c = await client(rec, { timeoutMs: 10 }).computers.get('vm-1');
    await expect(c.exec('sleep 1', { timeoutS: 1 })).resolves.toMatchObject({ ok: true });
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

  it('refuses a timeout that is not a finite number, rather than absorbing it', async () => {
    // timeoutS: Number(unsetEnvVar) is the usual spelling of this mistake.
    // Absorbed, the NaN poisons Math.max, reads as "no deadline", and a hung
    // request hangs forever exactly where the client deadline used to fire;
    // an Infinity surfaces as a bogus "could not reach" out of fetch instead.
    const rec = recorder(anyRoute);
    const c = await client(rec).computers.get('vm-1');
    await expect(c.exec('true', { timeoutS: Number(undefined) })).rejects.toThrow(/finite/);
    await expect(c.exec('true', { timeoutS: Infinity })).rejects.toThrow(/finite/);
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

  it('takes the cached frame unless the caller asks for a live one', async () => {
    const rec = recorder(anyRoute);
    const c = await client(rec).computers.get('vm-1');
    await c.screenshot();
    expect(rec.last().query).not.toHaveProperty('fresh');
    await c.screenshot(undefined, { fresh: true });
    expect(rec.last().query.fresh).toBe('1');
  });
});

describe('the parameters a drive loop needs', () => {
  it('asks the guest to shut down unless force was given', async () => {
    const rec = recorder(anyRoute);
    const c = await client(rec).computers.get('vm-1');
    await c.stop();
    expect(rec.last().query).not.toHaveProperty('force');
    await c.stop({ force: true });
    // The daemon compares this against the string "true", so what reaches the
    // wire matters more than the type at the call site.
    expect(rec.last().query.force).toBe('true');
  });

  it('carries an exec environment on both the waiting and background forms', async () => {
    const rec = recorder(anyRoute);
    const c = await client(rec).computers.get('vm-1');
    await c.exec('make', { env: { CI: '1' } });
    expect((rec.last().body as { env?: unknown }).env).toEqual({ CI: '1' });
    await c.execBackground('make', { env: { CI: '1' } });
    expect((rec.last().body as { env?: unknown }).env).toEqual({ CI: '1' });
  });

  it('names a snapshot when asked, and lets the platform name it otherwise', async () => {
    const rec = recorder(anyRoute);
    const c = await client(rec).computers.get('vm-1');
    await c.snapshot();
    expect(rec.last().body).toEqual({ memory: false });
    await c.snapshot({ memory: true, name: 'before-upgrade' });
    expect(rec.last().body).toEqual({ memory: true, name: 'before-upgrade' });
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

  it('does not split an event whose CRLF straddles two chunks', async () => {
    // A chunk ending in a lone '\r' must not be normalised to a '\n' that then
    // pairs with the next chunk's real one into a spurious frame boundary —
    // that split one event in two, dropped its type, and lost the done result
    // of a run that had succeeded. Chunk size 12 puts the boundary exactly
    // inside the first CRLF: 'event: done\r' | '\ndata: ...'.
    const text = 'event: done\r\ndata: {"steps":2,"stop":"end_turn","text":"ok"}\r\n\r\n';
    const rec = recorder((call) =>
      call.path.endsWith('/agent') ? stream(text, 12) : anyRoute(call),
    );
    const c = await client(rec).computers.get('vm-1');
    const result = await c.agent({ prompt: 'go', modelKey: 'sk' });
    expect(result.finished).toBe(true);
    expect(result.steps).toBe(2);
  });

  it('yields a CR-framed event as soon as its chunk arrives, not one chunk late', async () => {
    // Holding a trailing '\r' back deferred the frame boundary until the NEXT
    // chunk — which for a progress stream may be minutes of clicking away. The
    // '\r' contributes exactly one '\n' whether it is a lone terminator or the
    // front half of a CRLF, so it is framed immediately; the failure mode here
    // is this test hanging on an event that was already complete on the wire.
    let ctrl!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        ctrl = c;
      },
    });
    const rec = recorder((call) =>
      call.path.endsWith('/agent')
        ? new Response(body, {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          })
        : anyRoute(call),
    );
    const c = await client(rec).computers.get('vm-1');
    ctrl.enqueue(
      new TextEncoder().encode(
        'event: step\rdata: {"n":1,"tool":"computer","action":"left_click"}\r\r',
      ),
    );
    const events = c.agentStream({ prompt: 'go', modelKey: 'sk' });
    // Nothing has closed the stream and no second chunk is coming yet: the
    // event must already be here.
    const first = await events.next();
    expect(first.value?.type).toBe('step');
    ctrl.close();
    await events.return(undefined);
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

  it('holds an agentOnce request open past the ordinary deadline', async () => {
    // One held request for a run that is minutes of clicking — the same
    // exemption the streaming route gets, for the same reason.
    const rec = recorder(async (call) => {
      if (!call.path.endsWith('/agent')) return anyRoute(call);
      await new Promise((r) => setTimeout(r, 60));
      return json({ steps: 1, stop: 'end_turn', text: 'done' });
    });
    const c = await client(rec, { timeoutMs: 20 }).computers.get('vm-1');
    const res = await c.agentOnce({ prompt: 'go', modelKey: 'sk' });
    expect(res.finished).toBe(true);
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

describe('filenameFrom', () => {
  it('reads a quoted filename through its semicolons', async () => {
    // `[^";]+` stopped at the semicolon inside the quotes and handed back half
    // the name. Guest filenames are arbitrary; a semicolon in one is legal.
    const { filenameFrom } = await import('../src/transport.js');
    expect(filenameFrom('attachment; filename="a;b.txt"')).toBe('a;b.txt');
    expect(filenameFrom('attachment; filename=plain.txt')).toBe('plain.txt');
    expect(filenameFrom(null)).toBeUndefined();
  });

  it('reports no name rather than garbage for a malformed disposition', async () => {
    const { filenameFrom } = await import('../src/transport.js');
    // A well-formed empty name is no name — not the literal string '""' that
    // falling through to the unquoted regex handed back.
    expect(filenameFrom('attachment; filename=""')).toBeUndefined();
    // An unterminated quote yields the bare name, not '"abc'.
    expect(filenameFrom('attachment; filename="abc')).toBe('abc');
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

describe('answers that are not what the route promised', () => {
  it('reads a mangled incomplete header as 0 rather than as a NaN', () => {
    // Presence is the signal — see Listing — so the warning has to survive a
    // header nobody can parse. Through Number() alone it became a NaN that
    // poisons the first sum a caller does with it.
    const rec = recorder(
      () =>
        new Response(JSON.stringify([COMPUTER]), {
          status: 200,
          headers: { 'content-type': 'application/json', 'X-GC-Incomplete': 'lots' },
        }),
    );
    return expect(
      client(rec)
        .computers.listWithStatus({ allowPartial: true })
        .then((l) => l.incomplete),
    ).resolves.toBe(0);
  });

  it('names the route when a list route answers with an object', async () => {
    // Cast and filtered, this was `data.filter is not a function` — an
    // anonymous TypeError naming neither the request nor the platform.
    const rec = recorder(() => json({ error: 'not a list' }));
    await expect(client(rec).templates.list()).rejects.toThrow(
      /expected a JSON array from GET templates/,
    );
    await expect(client(rec).sizes.list()).rejects.toThrow(/expected a JSON array from GET sizes/);
  });

  it('names the route when the two list routes a user calls answer with an object', async () => {
    // listing() is the path behind computers.list() and snapshots.list(), and
    // it cast to T[] where jsonArray checks — so a proxy answering
    // `{"computers": [...]}` died as `items.map is not a function`, one layer
    // further in and naming neither the request nor the platform.
    const rec = recorder(() => json({ computers: [] }));
    await expect(client(rec).computers.list()).rejects.toThrow(
      /expected a JSON array from GET computers/,
    );
    await expect(client(rec).snapshots.list()).rejects.toThrow(
      /expected a JSON array from GET snapshots/,
    );
  });

  it('drops a non-record element from a listing rather than decoding it', async () => {
    // toSnapshot reads d.id off every element, so one null in the array threw
    // "cannot read properties of null" from inside the decoder. The same
    // isRecord filter templates.list and sizes.list already apply.
    const rec = recorder((call) => json(call.path === '/snapshots' ? [null, SNAPSHOT] : [null]));
    expect(await client(rec).snapshots.list()).toHaveLength(1);
    expect(await client(rec).computers.list()).toHaveLength(0);
  });

  it('names the route when a stream route answers with a page', async () => {
    // A captive portal answering 200 with HTML parses to a stream of no events
    // and surfaced as "the agent stream ended without a result" — a sentence
    // about the platform, describing the proxy that answered instead of it.
    const rec = recorder((call) =>
      call.path.endsWith('/agent')
        ? new Response('<!DOCTYPE html><title>Sign in</title>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          })
        : anyRoute(call),
    );
    const c = await client(rec).computers.get('vm-1');
    await expect(c.agent({ prompt: 'go', modelKey: 'sk' })).rejects.toThrow(
      /expected an event stream from POST computers\/vm-1\/agent.*text\/html/s,
    );
  });

  it('keeps the status a failed agent run reported, as the typed error for it', async () => {
    // Thrown as a bare MandalaError, the one failure that reaches a caller
    // inside a stream was the one their `instanceof` checks could not classify.
    const rec = recorder((call) =>
      call.path.endsWith('/agent')
        ? new Response(
            'event: error\ndata: {"error":"that key has been revoked","status":401}\n\n',
            {
              status: 200,
              headers: { 'content-type': 'text/event-stream' },
            },
          )
        : anyRoute(call),
    );
    const c = await client(rec).computers.get('vm-1');
    const err = await c.agent({ prompt: 'go', modelKey: 'sk' }).catch((e) => e);
    expect(err).toBeInstanceOf(AuthenticationError);
    expect(err.status).toBe(401);
    expect(err.message).toContain('that key has been revoked');
  });
});
