/** The transport: auth, status mapping, listings, streams. */

import { createServer } from 'node:http';
import { type AddressInfo, createServer as createSocketServer, type Socket } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import {
  errorForStatus,
  MAPPED_STATUSES,
  MoveRequiredError,
  TimeoutError,
  ValidationError,
} from '../src/errors.js';
import {
  APIError,
  AuthenticationError,
  Client,
  ConflictError,
  ConnectionError,
  ConnectionInterruptedError,
  DEFAULT_BASE_URL,
  isTransient,
  MandalaError,
  NotFoundError,
  PermissionDeniedError,
  PlanLimitError,
  RangeNotSatisfiableError,
  RateLimitError,
  TooLargeError,
  UnavailableError,
} from '../src/index.js';
import { MAX_TIMER_MS, Transport } from '../src/transport.js';
import { isTransientForPoll } from '../src/wait.js';
import { anyRoute, BASE, bytes, COMPUTER, errorJson, json, recorder, SNAPSHOT } from './harness.js';

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
    const savedKey = process.env.MANDALA_API_KEY;
    const savedBase = process.env.MANDALA_BASE_URL;
    process.env.MANDALA_API_KEY = 'com_from_env';
    process.env.MANDALA_BASE_URL = 'https://self.hosted/api/v1/';
    try {
      // The trailing slash is stripped, so paths do not double up on it.
      expect(new Client().baseUrl).toBe('https://self.hosted/api/v1');
    } finally {
      if (savedKey === undefined) delete process.env.MANDALA_API_KEY;
      else process.env.MANDALA_API_KEY = savedKey;
      if (savedBase === undefined) delete process.env.MANDALA_BASE_URL;
      else process.env.MANDALA_BASE_URL = savedBase;
    }
  });

  it('treats a blank configured base URL as missing', () => {
    const saved = process.env.MANDALA_BASE_URL;
    delete process.env.MANDALA_BASE_URL;
    try {
      expect(new Client({ apiKey: 'com_test', baseUrl: '' }).baseUrl).toBe(DEFAULT_BASE_URL);
      process.env.MANDALA_BASE_URL = '';
      expect(new Client({ apiKey: 'com_test' }).baseUrl).toBe(DEFAULT_BASE_URL);
    } finally {
      if (saved === undefined) delete process.env.MANDALA_BASE_URL;
      else process.env.MANDALA_BASE_URL = saved;
    }
  });

  it('sends the key as a bearer token and nothing else', async () => {
    const rec = recorder(anyRoute);
    await client(rec).computers.list();
    expect(rec.last().headers.Authorization).toBe('Bearer com_test');
  });

  it('trims a key with a trailing newline, which env files often have', async () => {
    const rec = recorder(anyRoute);
    await new Client({ apiKey: 'com_test\n', baseUrl: BASE, fetch: rec.fetch }).computers.list();
    expect(rec.last().headers.Authorization).toBe('Bearer com_test');
  });

  it('names an invalid base URL rather than throwing Invalid URL later', () => {
    expect(() => new Client({ apiKey: 'com_test', baseUrl: 'not-a-url' })).toThrow(
      /baseUrl must be an absolute URL/,
    );
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

  it('names a bad per-request timeout on every client, not only one with a deadline', async () => {
    // The validation used to sit BEHIND the early return, so the same mistake
    // was a ValidationError on a default client and silence on one built with
    // `timeoutMs: 0` — whether a caller was told depended on a setting made
    // somewhere else entirely.
    for (const opts of [{}, { timeoutMs: 0 }]) {
      const rec = recorder(anyRoute);
      const c = await client(rec, opts).computers.get('vm-1');
      await expect(c.readFile('/etc/hostname', { timeoutMs: Number.NaN })).rejects.toThrow(
        /the timeout for this request must be/,
      );
    }
  });

  it('refuses a delay that Node would wrap to one millisecond', () => {
    expect(
      () => new Client({ apiKey: 'com_test', baseUrl: BASE, timeoutMs: 2_147_483_648 }),
    ).toThrow(/2147483647/);
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

  // The same signal governs an error body, which used to be read outside the
  // rule: whatever went wrong reading it became an empty body, and the caller
  // was answered with the status. So a request abandoned on purpose came back
  // as ConflictError — which this SDK documents as the one worth retrying —
  // and a deadline came back as whatever the response happened to say.
  const stalledError = (status: number) =>
    (async (_url: unknown, init?: RequestInit) => {
      const signal = init?.signal;
      return new Response(
        // Headers arrived and said the status; the body never comes.
        new ReadableStream({
          start(ctrl) {
            signal?.addEventListener('abort', () => ctrl.error(signal.reason), { once: true });
          },
        }),
        { status },
      );
    }) as typeof globalThis.fetch;

  it("reports a cancellation while an error body stalls as the caller's", async () => {
    const ac = new AbortController();
    const c = new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: stalledError(409) });
    setTimeout(() => ac.abort(new Error('caller went away')), 5);
    const err = await c.computers.get('vm-1', { signal: ac.signal }).catch((e) => e);
    expect(err).not.toBeInstanceOf(MandalaError);
    expect(err.message).toBe('caller went away');
  });

  it('names a deadline that fires while an error body stalls', async () => {
    const c = new Client({
      apiKey: 'com_test',
      baseUrl: BASE,
      fetch: stalledError(409),
      timeoutMs: 40,
    });
    await expect(c.computers.get('vm-1')).rejects.toThrow(/timed out after 40ms/);
  });

  it('still answers with the status when the body is merely unreadable', async () => {
    // Not every failed read is the caller's doing. A body that errors for its
    // own reasons says nothing the status does not, and must not stop the
    // status being reported.
    const broken = (async () =>
      new Response(
        new ReadableStream({
          start(ctrl) {
            ctrl.error(new Error('connection reset'));
          },
        }),
        { status: 409 },
      )) as typeof globalThis.fetch;
    const c = new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: broken });
    const err = await c.computers.get('vm-1').catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.message).toBe('HTTP 409');
  });

  it('keeps the status when a real undici body reset kills the error body', async () => {
    // The test above this one uses a bare `Error`, which has no `code`, so it
    // went on passing when the OPL-3855 body-read branch was added and would
    // not have caught what that branch broke. A real reset carries a
    // SocketError as its cause, which the branch matched — so a 409 the
    // platform actually answered came back as a connection failure instead:
    // less information, and the opposite retry answer, over the label on a
    // body nobody needed.
    const broken = (async () =>
      new Response(
        new ReadableStream({
          pull(ctrl) {
            ctrl.error(
              Object.assign(new TypeError('terminated'), {
                cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
              }),
            );
          },
        }),
        { status: 409 },
      )) as typeof globalThis.fetch;
    const c = new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: broken });
    const err = await c.computers.get('vm-1').catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect(err).not.toBeInstanceOf(ConnectionError);
    expect(err.message).toBe('HTTP 409');
    // And the status is still the one a wait may poll on, which the connection
    // class it was becoming is not.
    expect(isTransient(err)).toBe(true);
  });

  it('preserves the original network failure as the connection error cause', async () => {
    const original = new Error('certificate verify failed');
    const broken = (async () => {
      throw original;
    }) as typeof globalThis.fetch;
    const c = new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: broken });
    const err = await c.computers.get('vm-1').catch((e) => e);
    expect(err).toBeInstanceOf(ConnectionError);
    expect(err.cause).toBe(original);
  });

  it('does not follow redirects, so a 301 is an error rather than a GET', async () => {
    // Fetch's default is `redirect: 'follow'`. A 301/302 on POST is converted
    // to GET with the body dropped, and Authorization is stripped on a
    // cross-origin hop. The recorder cannot catch that: it never follows, so
    // it would return the 301 either way. This one follows unless told not to.
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      if (init?.redirect === 'manual') {
        return new Response('', { status: 301, headers: { location: 'https://elsewhere/api/v1' } });
      }
      return json([]);
    }) as typeof globalThis.fetch;
    const c = new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: fetchImpl });
    const err = await c.computers.list().catch((e) => e);
    expect(err).toBeInstanceOf(APIError);
    expect(err.status).toBe(301);
  });
});

describe('what the constructor will not build on', () => {
  it('names a runtime with no global fetch, rather than failing on `bind`', () => {
    const saved = globalThis.fetch;
    try {
      // @ts-expect-error — modelling a runtime that has none at all.
      delete globalThis.fetch;
      // Was `TypeError: Cannot read properties of undefined (reading 'bind')`,
      // which names neither fetch nor this SDK nor the way out of it.
      expect(() => new Client({ apiKey: 'com_test', baseUrl: BASE })).toThrow(/no global fetch/);
      // And the escape the message offers really is one.
      expect(
        () => new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: recorder(anyRoute).fetch }),
      ).not.toThrow();
    } finally {
      globalThis.fetch = saved;
    }
  });

  it('refuses a request that sets both raw and body', () => {
    // Documented as exclusive and never enforced: `raw` won and the JSON the
    // caller could see was dropped in silence. Unreachable from outside the
    // package — neither this class nor RequestOptions is exported — which is
    // why it is reached here through the transport directly.
    const rec = recorder(anyRoute);
    const t = new Transport({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch });
    return expect(
      t.json('PUT', 'computers/vm-1/files', {
        raw: new Uint8Array([1, 2, 3]),
        body: { path: '/tmp/x' },
      }),
    )
      .rejects.toThrow(/raw or body, not both/)
      .then(() => {
        expect(rec.calls).toHaveLength(0);
      });
  });
});

describe('status mapping', () => {
  const cases: [number, unknown][] = [
    [401, AuthenticationError],
    [402, PlanLimitError],
    [403, PermissionDeniedError],
    [404, NotFoundError],
    [409, ConflictError],
    [429, RateLimitError],
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

  it('does not resolve a status through Object.prototype', () => {
    // The status table is a lookup keyed by a value that came off a response,
    // and a plain object literal inherits `constructor`, `toString` and the
    // rest. `BY_STATUS[status] ?? APIError` cannot fall back for an inherited
    // key, so `new Cls(...)` was `new Object.prototype.toString()` — a
    // TypeError thrown from inside the error path, destroying the failure it
    // was called to describe. `fetch` is caller-injectable and this file
    // already accepts that it must survive anything at all out of one.
    for (const status of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      const err = errorForStatus(status as unknown as number, 'the platform said so');
      expect(err, status).toBeInstanceOf(APIError);
      expect(err.message, status).toBe('the platform said so');
    }
  });

  it('builds an error for every status it maps, so no entry can be a non-constructor', () => {
    // The runtime half of what the table's type says. The null prototype above
    // is built with `Object.create(null)`, which is typed `any` — so unless the
    // assign is given a target to check the literal against, the annotation
    // checks nothing at all and an entry may be a string or a number. That is a
    // `TypeError: Cls is not a constructor` thrown from inside this function,
    // which destroys the failure it was called to describe: the same end as the
    // inherited key above, reached from the other side.
    //
    // Read out of the table rather than copied from it. A list written here by
    // hand covers the entries that existed the day it was written, so a status
    // added to the table later goes untested by the one test whose whole job is
    // to notice — the drift, not the mapping, is what this asserts against.
    // 418 and 500 are the unmapped pair that must still build an `APIError`.
    for (const status of [...MAPPED_STATUSES, 418, 500]) {
      const err = errorForStatus(status, 'the platform said so');
      expect(err, String(status)).toBeInstanceOf(APIError);
      expect(err.status, String(status)).toBe(status);
      // The message is not asserted: the 5xx wordings above are substituted on
      // purpose, and what is being pinned here is that each entry CONSTRUCTS.
      expect(err.message.length, String(status)).toBeGreaterThan(0);
    }
  });

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
    expect(isTransient(new RateLimitError('', 429))).toBe(true);
    expect(isTransient(new UnavailableError('', 503))).toBe(true);
    expect(isTransient(new ConnectionError('offline'))).toBe(true);
    expect(isTransient(new PlanLimitError('', 402))).toBe(false);
    expect(isTransient(new Error('boom'))).toBe(false);
  });

  // Platform OPL-3898, and it was filed about this predicate. A clipboard read
  // against a STOPPED computer and a write that lost the selection for an
  // instant are both 409s; this said yes to both, so a generic retry loop spun
  // against a stopped machine until somebody's deadline. The advice was to read
  // the message — prose the platform is free to reword, and the matching
  // OPL-3724 got three clients out of.
  it('tells the 409 that never clears from the two that do', () => {
    const stopped = errorForStatus(409, 'this computer is not running', {
      error: 'this computer is not running, so it has no clipboard',
      reason: 'unavailable',
    });
    const taken = errorForStatus(409, 'the desktop did not take the text', {
      error: 'the desktop did not take the text (something else claimed its clipboard); try again',
      reason: 'contention',
    });
    // Both ConflictError, and the answers differ — which is the whole point.
    expect([stopped instanceof ConflictError, taken instanceof ConflictError]).toEqual([
      true,
      true,
    ]);
    expect((stopped as APIError).reason).toBe('unavailable');
    expect(isTransient(stopped)).toBe(false);
    expect(isTransient(taken)).toBe(true);
    // A poll is the one caller for whom `unavailable` may still clear: a
    // computer coming up passes through it, and a wait only ever replays a read
    // under a deadline the caller set. The deliberate divergence of the two.
    expect(isTransientForPoll(stopped)).toBe(true);
  });

  it('reads the word off a 400 as readily as off a 409', () => {
    // `unavailable` arrives on both — whoever loses the race to the running
    // check hears the same fact, answered 400 — which is why the word is read
    // on APIError rather than on ConflictError.
    const underfoot = errorForStatus(400, 'the computer stopped underfoot', {
      error: 'the computer stopped underfoot',
      reason: 'unavailable',
    });
    const windows = errorForStatus(400, 'not supported on Windows computers', {
      error: 'the clipboard is not supported on Windows computers',
      reason: 'unsupported',
    });
    expect([(underfoot as APIError).reason, (windows as APIError).reason]).toEqual([
      'unavailable',
      'unsupported',
    ]);
    expect([isTransient(underfoot), isTransient(windows)]).toEqual([false, false]);
  });

  it('leaves a fifth word, and a malformed one, to the answer it had before', () => {
    // The platform states that an unrecognised value means "no classification
    // given", which is what makes a fifth word safe to add later. Both sets are
    // tested rather than one inferred from the other, so an unknown word falls
    // through to the type instead of reading as permanent.
    const fifth = errorForStatus(409, 'something new', { error: 'x', reason: 'wedged' });
    expect((fifth as APIError).reason).toBe('wedged');
    expect(isTransient(fifth)).toBe(true);
    // Shape-checked like the move offer, and for its reason: this decides a
    // retry policy, so a `reason` that is not a string reads as nothing said.
    const wrongType = errorForStatus(409, 'x', { error: 'x', reason: 5 });
    const unclassified = errorForStatus(409, 'x', { error: 'x' });
    expect([(wrongType as APIError).reason, (unclassified as APIError).reason]).toEqual([
      undefined,
      undefined,
    ]);
    expect([isTransient(wrongType), isTransient(unclassified)]).toEqual([true, true]);
  });

  it('publishes only what is safe to replay blind, and polls through the rest', () => {
    // The two questions, per status (OPL-3724). isTransient is exported, so its
    // caller may be wrapping a `create` — and every status below means the
    // outcome is unknown, which is how one computer becomes two. The waits ask
    // the other predicate and ride all of them out, because they only ever
    // replay a read, under a deadline the caller chose.
    for (const status of [502, 504, 520, 521, 522, 523]) {
      const err = errorForStatus(status, `HTTP ${status}`);
      expect(isTransient(err)).toBe(false);
      expect(isTransientForPoll(err)).toBe(true);
    }
  });

  it('polls through a status nobody has mapped, and stops on a bad request', () => {
    // Why the poll predicate is a deny-list rather than a wider allow-list.
    // Under an allow-list every status the edge invents next is fatal to a wait
    // until somebody notices and adds a class; a 5xx is a moment, and outlasting
    // one is what a poll loop is. The line is REQUEST versus MOMENT, written as
    // a range so an unmapped 4xx lands on the right side too.
    expect(isTransientForPoll(errorForStatus(500, 'HTTP 500'))).toBe(true);
    expect(isTransientForPoll(errorForStatus(507, 'HTTP 507'))).toBe(true);
    expect(isTransientForPoll(errorForStatus(400, 'HTTP 400'))).toBe(false);
    expect(isTransientForPoll(errorForStatus(405, 'HTTP 405'))).toBe(false);
    // 408 is the third 4xx that describes a moment: RFC 9110 defines it as a
    // request the client may repeat unchanged, and the edge does emit it.
    expect(isTransientForPoll(errorForStatus(408, 'HTTP 408'))).toBe(true);
    // A 3xx goes with the 4xx — hence `>= 500` rather than "not a 4xx". The
    // transport does not follow redirects and treats every non-2xx as an error,
    // so a baseUrl missing its trailing path answers 301.
    for (const status of [301, 302, 303, 307, 308]) {
      expect(isTransientForPoll(errorForStatus(status, `HTTP ${status}`))).toBe(false);
    }
    // 5xx has an upper bound too: the HTTP parser accepts any three digits, so
    // a broken origin answering 700 was polled to the caller's deadline.
    for (const status of [600, 700, 999]) {
      expect(isTransientForPoll(errorForStatus(status, `HTTP ${status}`))).toBe(false);
    }
    // 524 is the one status still matched by number: it shares
    // GatewayTimeoutError with 504, which IS worth another poll, and a type
    // cannot separate two statuses that share it.
    expect(isTransientForPoll(errorForStatus(504, 'HTTP 504'))).toBe(true);
    expect(isTransientForPoll(errorForStatus(524, 'HTTP 524'))).toBe(false);
    // A certificate fails identically on every retry, so waiting one out spends
    // the whole deadline to report the wrong cause.
    expect(isTransientForPoll(errorForStatus(525, 'HTTP 525'))).toBe(false);
    expect(isTransientForPoll(errorForStatus(526, 'HTTP 526'))).toBe(false);
  });

  it('does not poll through anything that is not a failed request', () => {
    // The floor a deny-list needs, and it is narrower than "our error": only an
    // APIError or a ConnectionError describes an exchange that did not work.
    //
    // The bare MandalaError is the case that actually bit. Every poll loop here
    // raises them as verdicts about a poll that SUCCEEDED — "this move is no
    // longer listed", "this build says done beside a running status" — thrown
    // from inside the same try that wraps the request. Polling through a verdict
    // is an infinite loop with a deadline on it, and three tests stopped
    // terminating when this predicate first used MandalaError as its floor.
    expect(isTransientForPoll(new MandalaError('that move is no longer listed'))).toBe(false);
    expect(isTransientForPoll(new TimeoutError('gave up'))).toBe(false);
    expect(isTransientForPoll(new TypeError('boom'))).toBe(false);
    expect(isTransientForPoll(new ValidationError('id must not be empty'))).toBe(false);
    // And a move offer, which is a 409 by status and a decision by nature.
    expect(isTransientForPoll(new MoveRequiredError('needs a move', 409, {}, true))).toBe(false);
    expect(isTransientForPoll(new ConflictError('the agent is not up yet', 409))).toBe(true);
  });

  it('keeps the rate limit retry interval', async () => {
    const rec = recorder(() => errorJson(429, 'slow down', { 'Retry-After': '1.5' }));
    const err = await client(rec)
      .computers.list()
      .catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.retryAfterMs).toBe(1_500);
  });

  it('clamps a huge Retry-After rather than wrapping a Node timer', async () => {
    const rec = recorder(() => errorJson(429, 'slow down', { 'Retry-After': '10000000000' }));
    const err = await client(rec)
      .computers.list()
      .catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.retryAfterMs).toBe(MAX_TIMER_MS);
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
    // Shaped like a refused socket, which is what a real one looks like: the
    // rejection is a `TypeError: fetch failed` and the phase is only legible on
    // its cause. Without one this is now read as a possible dispatch and gets
    // the other wording (OPL-3855), so the cause is what keeps this test about
    // the rewriting it was written for.
    const rec = recorder(() => {
      throw Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), {
          code: 'ECONNREFUSED',
          syscall: 'connect',
        }),
      });
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

  it('lets one file transfer explicitly disable the client deadline', async () => {
    const rec = recorder(async (call) => {
      if (!call.path.endsWith('/files')) return anyRoute(call);
      await new Promise((resolve) => setTimeout(resolve, 30));
      return call.method === 'GET' ? bytes('file', 'text/plain') : json({ bytes: 4 });
    });
    const computer = await client(rec, { timeoutMs: 10 }).computers.get('vm-1');
    await expect(computer.readFile('/tmp/file', { timeoutMs: 0 })).resolves.toHaveLength(4);
    await expect(computer.writeFile('/tmp/file', 'file', { timeoutMs: 0 })).resolves.toBe(4);
  });

  it('sends a streamed upload through Node fetch, which requires duplex', async () => {
    // The recorder consumes the stream itself and never constructs a Request,
    // so it cannot catch this: undici rejects a ReadableStream body unless
    // RequestInit.duplex is 'half'. Every `mandala scp file vm:/path` goes
    // through that check, against the package's default fetch.
    let uploaded: Buffer | undefined;
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        let json: unknown = COMPUTER;
        if (req.url?.includes('/files')) {
          uploaded = body;
          json = { bytes: body.length };
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(json));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const c = new Client({ apiKey: 'com_test', baseUrl: `http://127.0.0.1:${port}/api/v1` });
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('hello'));
          controller.close();
        },
      });
      const written = await (await c.computers.get('vm-1')).writeFile('/tmp/a.txt', stream, {
        contentLength: 5,
      });
      expect(written).toBe(5);
      expect(uploaded?.toString()).toBe('hello');
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
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

  it('lets held input outlive a shorter client deadline', async () => {
    const rec = recorder(async (call) => {
      if (!call.path.endsWith('/input')) return anyRoute(call);
      await new Promise((r) => setTimeout(r, 30));
      return json({});
    });
    const c = await client(rec, { timeoutMs: 5 }).computers.get('vm-1');
    await expect(c.holdKey(['shift'], 0.01)).resolves.toBeUndefined();
    await expect(c.wait(0.01)).resolves.toBeUndefined();
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

describe('a failure body from something that is not the platform', () => {
  it('stops reading it at the ceiling instead of holding all of it', async () => {
    // The platform's own failure body is a JSON message of a few hundred bytes.
    // Anything larger came from an edge or a captive portal, and only its first
    // pages are worth anything — the Ray ID support asks for sits in a footer a
    // few kilobytes in, well inside the ceiling. Read to the end, a hostile or
    // broken origin could put whatever it liked in this process's memory, with
    // the composed deadline bounding a SLOW body and not a large one.
    const over = 5_000;
    const page = 'x'.repeat((1 << 20) + over);
    const rec = recorder(
      () => new Response(page, { status: 502, headers: { 'content-type': 'text/html' } }),
    );
    const err = await client(rec)
      .computers.get('vm-1')
      .catch((e) => e);
    expect(err).toBeInstanceOf(APIError);
    expect((err as APIError).body).toHaveLength(1 << 20);
  });

  it('still keeps a page whole when it fits, so the Ray ID survives', async () => {
    const page = `<html><body>error</body><!-- Ray ID: 8f0c${'.'.repeat(20_000)} --></html>`;
    const rec = recorder(
      () => new Response(page, { status: 502, headers: { 'content-type': 'text/html' } }),
    );
    const err = await client(rec)
      .computers.get('vm-1')
      .catch((e) => e);
    expect((err as APIError).body).toBe(page);
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

  it('bounds an event that never sends a frame boundary', async () => {
    const oversized = `data: ${'x'.repeat((1 << 20) + 1)}`;
    const rec = recorder((call) =>
      call.path.endsWith('/agent') ? stream(oversized, oversized.length) : anyRoute(call),
    );
    const c = await client(rec).computers.get('vm-1');
    await expect(c.agent({ prompt: 'go', modelKey: 'sk' })).rejects.toThrow(
      /exceeded 1048576 characters without a boundary/,
    );
  });

  it('still frames a chunk larger than the cap when it carries boundaries', async () => {
    // The cap is checked BEFORE the concatenation now, so that the string it
    // refuses to hold is never built. That check must not cost the drain: a
    // chunk can legitimately be larger than the cap when it carries the
    // boundaries to split on, and refusing that would turn a working stream
    // into an error over an arithmetic shortcut.
    const step = (n: number) =>
      `event: step\ndata: {"n":${n},"tool":"computer","detail":"${'x'.repeat(200_000)}"}\n\n`;
    const body =
      step(1) +
      step(2) +
      step(3) +
      step(4) +
      step(5) +
      step(6) +
      'event: done\ndata: {"steps":6,"stop":"end_turn","text":"ok"}\n\n';
    // One read, larger than the cap, with every boundary already in it.
    const rec = recorder((call) =>
      call.path.endsWith('/agent') ? stream(body, body.length) : anyRoute(call),
    );
    const c = await client(rec).computers.get('vm-1');
    const seen = [];
    for await (const ev of c.agentStream({ prompt: 'go', modelKey: 'sk' })) seen.push(ev);
    expect(body.length).toBeGreaterThan(1 << 20);
    expect(seen.map((e) => e.type)).toEqual([
      'step',
      'step',
      'step',
      'step',
      'step',
      'step',
      'done',
    ]);
  });

  it('refuses an oversized event split across reads, before holding it', async () => {
    // The runaway case the cap is for: no boundary anywhere, arriving in
    // pieces, so the refusal has to come from the running total rather than
    // from any one chunk.
    const oversized = `data: ${'x'.repeat((1 << 20) + 1)}`;
    const rec = recorder((call) =>
      call.path.endsWith('/agent') ? stream(oversized, 64_000) : anyRoute(call),
    );
    const c = await client(rec).computers.get('vm-1');
    await expect(c.agent({ prompt: 'go', modelKey: 'sk' })).rejects.toThrow(
      /exceeded 1048576 characters without a boundary/,
    );
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

  /**
   * The sweep the build-flag defect prompted: `noReuse` was not the only option
   * on this surface read by truthiness, and it was not the worst one.
   *
   * `allowPartial` turns OFF the fail-closed guarantee `list` documents. Read by
   * truthiness, `allowPartial: "false"` — three characters a JavaScript caller
   * or an `any` can produce, and which say NO — sent `allow_partial=1` and
   * handed back part of the fleet as though it were all of it. That is the
   * failure the header, the `incomplete` count and the 503 all exist to prevent,
   * reached through the one door none of them watches.
   *
   * Asserted as no request at all: a refusal that still sent one would have
   * listed the wrong thing.
   */
  it('refuses a non-boolean flag rather than reading it as true', async () => {
    for (const bad of ['false', 'true', 0, 1, null, new Boolean(false)]) {
      const v = bad as unknown as boolean;
      const rec = recorder(anyRoute);
      const c = client(rec);
      const before = rec.calls.length;
      await expect(c.computers.list({ allowPartial: v })).rejects.toThrow(TypeError);
      await expect(c.computers.listWithStatus({ allowPartial: v })).rejects.toThrow(TypeError);
      await expect(c.snapshots.list({ includeUnfinished: v })).rejects.toThrow(TypeError);
      await expect(c.snapshots.list({ allowPartial: v })).rejects.toThrow(TypeError);
      // The third listing to take the flag, since OPL-3840. Swept in with the
      // other two rather than left to a case of its own: what this one is about
      // is that NO route on the surface reads the flag by truthiness, and a
      // route that gains it without being added here is exactly the gap.
      await expect(c.builds.list({ allowPartial: v })).rejects.toThrow(TypeError);
      await expect(c.builds.listWithStatus({ allowPartial: v })).rejects.toThrow(TypeError);
      expect(rec.calls.length).toBe(before);
    }
    // The values that ARE booleans still work, including the false that means
    // "leave the guarantee on".
    const rec = recorder(anyRoute);
    await client(rec).computers.list({ allowPartial: false });
    expect(rec.calls[0]?.query).not.toHaveProperty('allow_partial');
    await client(rec).computers.list({ allowPartial: true });
    expect(rec.calls[1]?.query.allow_partial).toBe('1');
    await client(rec).builds.list({ allowPartial: false });
    expect(rec.calls[2]?.query).not.toHaveProperty('allow_partial');
    await client(rec).builds.list({ allowPartial: true });
    expect(rec.calls[3]?.query.allow_partial).toBe('1');
  });

  it('drops a non-record element from a listing rather than decoding it', async () => {
    // toSnapshot reads d.id off every element, so one null in the array threw
    // "cannot read properties of null" from inside the decoder. The same
    // isRecord filter templates.list and sizes.list already apply.
    const rec = recorder((call) => json(call.path === '/snapshots' ? [null, SNAPSHOT] : [null]));
    expect(await client(rec).snapshots.list()).toHaveLength(1);
    expect(await client(rec).computers.list()).toHaveLength(0);
  });

  it('marks a listing short by the rows it dropped, and leaves a flagged one alone', async () => {
    // A dropped row and a row the fan-out never reached leave the same answer:
    // an array one shorter than the estate, handed to a caller who diffs it
    // against their own idea of that estate. `incomplete: null` on it is the
    // one sentence that makes the drop unrecoverable — the count is the only
    // trace the row was ever there.
    const dropped = recorder(() => json([null, SNAPSHOT, null]));
    const listed = await client(dropped).snapshots.listWithStatus();
    expect(listed.items).toHaveLength(1);
    expect(listed.incomplete).toBe(2);
    // Whole answers keep saying so: the count is a shortfall, not a row count.
    const whole = recorder(() => json([SNAPSHOT]));
    expect((await client(whole).snapshots.listWithStatus()).incomplete).toBeNull();
    // And the platform's own number survives a drop rather than being added to.
    // Presence is what a caller tests, and `X-GC-Incomplete: 0` means "short by
    // an amount that cannot be stated" — arithmetic on it would state one.
    const both = recorder(
      () =>
        new Response(JSON.stringify([null, SNAPSHOT]), {
          status: 200,
          headers: { 'content-type': 'application/json', 'X-GC-Incomplete': '0' },
        }),
    );
    expect((await client(both).snapshots.listWithStatus()).incomplete).toBe(0);
  });

  it('marks a listing with no body at all short, rather than empty', async () => {
    // A 204, or a 200 with nothing in it, from a route that has no empty
    // answer — no producer of one exists on any list path, so it is a broken
    // responder or a proxy answering for one. Still an empty array, because a
    // route that legitimately answers 204 must not be refused and the
    // documented contract is a list; but not an empty ESTATE, which is what
    // `incomplete: null` beside it would have said. The hazard is the one
    // `web/lib/surface.ts` names — a caller diffs the array against its own
    // idea of the world and tidies up the computers that "disappeared" — and
    // it does not care which hop lost the rows.
    const nothing = recorder(() => new Response(null, { status: 204 }));
    const listed = await client(nothing).computers.listWithStatus();
    expect(listed.items).toEqual([]);
    expect(listed.incomplete).toBe(0);
    const empty = recorder(
      () => new Response('', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    expect((await client(empty).snapshots.listWithStatus()).incomplete).toBe(0);
    // An account with nothing in it says so, and keeps saying so: `[]` is the
    // platform's own statement and is not this.
    const none = recorder(() => json([]));
    expect((await client(none).snapshots.listWithStatus()).incomplete).toBeNull();
  });

  it('names the computers route when a listed record has no id', async () => {
    const rec = recorder(() => json([{ name: 'missing its id' }]));
    await expect(client(rec).computers.listWithStatus()).rejects.toThrow(
      /expected a computer from GET computers/,
    );
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

describe('content ranges', () => {
  it('reads the window and the file length off a satisfied range', async () => {
    const { parseContentRange } = await import('../src/transport.js');
    expect(parseContentRange('bytes 0-1048575/2147483648')).toEqual({
      start: 0,
      end: 1048575,
      total: 2147483648,
    });
    expect(parseContentRange('BYTES  10 - 19 / 20')).toEqual({ start: 10, end: 19, total: 20 });
  });

  it('keeps the window when the total is missing or contradicts it', async () => {
    // Losing "how much is left" still leaves a caller with bytes they know the
    // position of. Losing the position leaves them with bytes they cannot place.
    const { parseContentRange } = await import('../src/transport.js');
    expect(parseContentRange('bytes 0-9/*')).toEqual({ start: 0, end: 9 });
    // `end` is inclusive, so a 10-byte file has no byte at 10 — a total that
    // does not exceed it is a header contradicting itself.
    expect(parseContentRange('bytes 0-9/9')).toEqual({ start: 0, end: 9 });
  });

  it('reports a window it cannot trust as no window at all', async () => {
    const { parseContentRange } = await import('../src/transport.js');
    expect(parseContentRange(null)).toBeUndefined();
    expect(parseContentRange('items 0-9/20')).toBeUndefined();
    expect(parseContentRange('bytes 9-0/20')).toBeUndefined();
    expect(parseContentRange('bytes */4096')).toBeUndefined();
  });

  it("reads the file's length off an unsatisfied range and nothing else", async () => {
    const { unsatisfiedTotal } = await import('../src/transport.js');
    expect(unsatisfiedTotal('bytes */4096')).toBe(4096);
    expect(unsatisfiedTotal('bytes */0')).toBe(0);
    expect(unsatisfiedTotal('bytes 0-9/20')).toBeUndefined();
    expect(unsatisfiedTotal(null)).toBeUndefined();
  });
});

describe('the statuses a transfer earns', () => {
  it('gives a size refusal its own class rather than the generic error', async () => {
    const rec = recorder((call) =>
      call.path.endsWith('/files')
        ? errorJson(413, 'that file is 200000000 bytes; this endpoint moves at most 67108864')
        : anyRoute(call),
    );
    const computer = await client(rec).computers.get('vm-1');
    const err = await computer.readFilePart('/tmp/big.bin').catch((e) => e);
    expect(err).toBeInstanceOf(TooLargeError);
    expect(err.status).toBe(413);
    // Not transient: no amount of waiting makes the file smaller.
    expect(isTransient(err)).toBe(false);
  });

  it('lifts the length off a 416 so nobody has to parse a header they never see', async () => {
    const rec = recorder((call) =>
      call.path.endsWith('/files')
        ? errorJson(416, 'that range is outside the file, which is 4096 bytes', {
            'content-range': 'bytes */4096',
          })
        : anyRoute(call),
    );
    const computer = await client(rec).computers.get('vm-1');
    const err = await computer.readFilePart('/tmp/a.bin', { offset: 9000 }).catch((e) => e);
    expect(err).toBeInstanceOf(RangeNotSatisfiableError);
    expect(err.total).toBe(4096);
    expect(err.message).toMatch(/4096 bytes/);
    expect(isTransient(err)).toBe(false);
  });

  it('leaves the length undefined rather than zero when the refusal carried none', async () => {
    // Zero is a real file length. Defaulting to it would turn "the response did
    // not say" into the claim that the file is empty.
    const rec = recorder((call) =>
      call.path.endsWith('/files')
        ? errorJson(416, 'that range is outside the file')
        : anyRoute(call),
    );
    const computer = await client(rec).computers.get('vm-1');
    const err = await computer.readFilePart('/tmp/a.bin', { offset: 9000 }).catch((e) => e);
    expect(err).toBeInstanceOf(RangeNotSatisfiableError);
    expect(err.total).toBeUndefined();
  });
});

describe('a connection failure after the request was sent (OPL-3855)', () => {
  // The hazard, as one sentence: `computers.create()` reaches the platform, the
  // platform builds the computer, and the socket dies while the response is
  // being read. Every client wrapped that in the class whose name says the
  // request never left, so `isTransient` said yes, an embedder replayed the
  // create, and the account paid for two computers.

  /** A TCP server that behaves however the test needs, and the base URL for it. */
  const serving = async (handler: (socket: Socket) => void, scheme: 'http' | 'https' = 'http') => {
    const open = new Set<Socket>();
    const server = createSocketServer((socket) => {
      open.add(socket);
      socket.on('close', () => open.delete(socket));
      handler(socket);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return {
      url: `${scheme}://127.0.0.1:${port}/api/v1`,
      // Sockets destroyed as well as the listener closed. `server.close` waits
      // for open connections, and the deadline case below deliberately leaves
      // one open — without this the test hangs on its own cleanup rather than
      // on anything it was written to catch.
      close: () =>
        new Promise<void>((resolve) => {
          for (const socket of open) socket.destroy();
          server.close(() => resolve());
        }),
    };
  };

  // Real sockets rather than the recorder, deliberately. What is under test is
  // whether undici's cause chain can be read to tell the two phases apart, and
  // a stub throwing a hand-made error would only test the classifier against
  // errors this file invented — the half that was never in doubt.
  const failureFrom = (url: string): Promise<unknown> =>
    new Client({ apiKey: 'com_test', baseUrl: url }).computers
      .list()
      .then(() => {
        throw new Error('expected the request to fail');
      })
      .catch((e: unknown) => e);

  it('says the request never left only when it can prove that', async () => {
    // Port 2 rather than an ephemeral one bound and closed here: the OS is free
    // to hand a just-released ephemeral port to another listener, and this file
    // binds dozens of them — a collision would dispatch the request and fail
    // below, pointing at the classifier rather than at the port. Not port 1,
    // which fetch refuses outright as a bad port, so it never reaches a connect.
    for (const url of ['http://127.0.0.1:2/api/v1', 'http://no-such-host-xyzzy.invalid/api/v1']) {
      const err = await failureFrom(url);
      expect(err, url).toBeInstanceOf(ConnectionError);
      expect(err, url).not.toBeInstanceOf(ConnectionInterruptedError);
      expect(isTransient(err), url).toBe(true);
      expect(isTransientForPoll(err), url).toBe(true);
    }
  });

  it('does not read a TLS alert after the handshake as a connect failure', async () => {
    // The prefix that used to be here — `ERR_SSL_` — is how Node spells every
    // OpenSSL reason, fatal alerts included, and an alert can arrive on any
    // record. A TLS-terminating proxy that dies while the response is being
    // read answers one of these with the request long since on the wire, so the
    // prefix put a possibly-dispatched failure into the class that says nothing
    // was sent. That is the bug this describe block is about, reintroduced by
    // the first fix for it.
    const failing = (code: string) =>
      new Client({
        apiKey: 'com_test',
        baseUrl: BASE,
        fetch: (async () => {
          throw Object.assign(new TypeError('fetch failed'), {
            cause: Object.assign(new Error(code), { code }),
          });
        }) as typeof globalThis.fetch,
      }).computers
        .list()
        .catch((e: unknown) => e);

    for (const code of [
      'ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR',
      'ERR_SSL_SSLV3_ALERT_BAD_RECORD_MAC',
      'ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC',
      // Node's own prefix is no safer, which is why neither survived:
      // renegotiation is by definition mid-connection.
      'ERR_TLS_RENEGOTIATION_DISABLED',
    ]) {
      const err = await failing(code);
      expect(err, code).toBeInstanceOf(ConnectionInterruptedError);
      expect(isTransient(err), code).toBe(false);
    }
    // And the handshake codes that ARE named still answer the other way, so
    // this is a narrowing rather than a surrender.
    for (const code of ['ERR_SSL_WRONG_VERSION_NUMBER', 'CERT_HAS_EXPIRED']) {
      const err = await failing(code);
      expect(err, code).toBeInstanceOf(ConnectionError);
      expect(err, code).not.toBeInstanceOf(ConnectionInterruptedError);
      expect(isTransient(err), code).toBe(true);
    }
  });

  it('treats a handshake failure as a connect failure', async () => {
    // TLS completes before the request exists, so a certificate or protocol
    // mismatch is still "never left" — here, https onto a plaintext port.
    const { url, close } = await serving((socket) => {
      socket.on('data', () => socket.write('not tls at all\r\n'));
    }, 'https');
    try {
      const err = await failureFrom(url);
      expect(err).toBeInstanceOf(ConnectionError);
      expect(err).not.toBeInstanceOf(ConnectionInterruptedError);
      expect(isTransient(err)).toBe(true);
    } finally {
      await close();
    }
  });

  it('does not promise a blind replay once the request is on the wire', async () => {
    // Three shapes of the same outcome — the platform got the request and the
    // answer was lost — and the phase is what they share, not the errno.
    const cases: Array<[string, (socket: Socket) => void]> = [
      ['reset with the request sent', (socket) => socket.on('data', () => socket.destroy())],
      [
        'a response that is not HTTP',
        (socket) =>
          socket.on('data', () => {
            socket.write('NOT HTTP AT ALL\r\n\r\n');
            socket.end();
          }),
      ],
      [
        'a body that dies mid-stream',
        (socket) =>
          socket.on('data', () => {
            socket.write(
              'HTTP/1.1 200 OK\r\nContent-Length: 100\r\nContent-Type: application/json\r\n\r\n[{"id":',
            );
            setTimeout(() => socket.destroy(), 30);
          }),
      ],
    ];
    for (const [what, handler] of cases) {
      const { url, close } = await serving(handler);
      try {
        const err = await failureFrom(url);
        expect(err, what).toBeInstanceOf(ConnectionInterruptedError);
        // Still a ConnectionError, which is what makes the split non-breaking:
        // an existing catch block, and the poll predicate's floor, see no change.
        expect(err, what).toBeInstanceOf(ConnectionError);
        // The two predicates, disagreeing on purpose. A create must not be
        // replayed blind; a GET the waits poll may be read again.
        expect(isTransient(err), what).toBe(false);
        expect(isTransientForPoll(err), what).toBe(true);
        expect((err as Error).message, what).toMatch(/unknown rather than undone/);
      } finally {
        await close();
      }
    }
  });

  it('does not call a timed-out create safe to replay', async () => {
    // Not obviously this bug, and it is. `timeoutMs` firing produced a plain
    // ConnectionError reading "timed out after 30ms" — and a timeout is the
    // shape where the request has most likely gone out and the platform is most
    // likely still working on it. It said "safe to replay blind" about the one
    // failure where that is least true.
    const { url, close } = await serving(() => {
      // Accept the connection and never answer.
    });
    try {
      const err = await new Client({ apiKey: 'com_test', baseUrl: url, timeoutMs: 50 }).computers
        .list()
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConnectionInterruptedError);
      expect((err as Error).message).toMatch(/timed out after 50ms/);
      expect(isTransient(err)).toBe(false);
      expect(isTransientForPoll(err)).toBe(true);
    } finally {
      await close();
    }
  });

  it('does not call an unrecognised transport failure a connect failure', () => {
    // The fail-closed half, and the reason a caller-supplied `fetch` cannot
    // widen the safe class by accident: anything this SDK has no rule for is
    // read as possibly dispatched.
    const rec = recorder(() => {
      throw new TypeError('fetch failed');
    });
    return client(rec)
      .computers.list()
      .catch((err: unknown) => {
        expect(err).toBeInstanceOf(ConnectionInterruptedError);
        expect(isTransient(err)).toBe(false);
        expect(isTransientForPoll(err)).toBe(true);
      });
  });
});
