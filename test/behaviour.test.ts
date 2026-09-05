/** What the handles do, as distinct from where they send it. */

import { describe, expect, it, vi } from 'vitest';
import {
  APIError,
  AuthenticationError,
  Client,
  ConflictError,
  type FileChunk,
  GatewayTimeoutError,
  isTransient,
  MandalaError,
  OriginResponseError,
  OriginTLSError,
  OriginUnreachableError,
  RangeNotSatisfiableError,
  RateLimitError,
  TimeoutError,
  TooLargeError,
  ValidationError,
} from '../src/index.js';
import {
  anyRoute,
  BASE,
  COMPUTER,
  cloudflareJson,
  EXEC_OK,
  errorJson,
  guestFile,
  json,
  type Responder,
  recorder,
  SNAPSHOT,
  WAYLAND_COMPUTER,
  WINDOW,
} from './harness.js';

const client = (respond: Responder) => {
  const rec = recorder(respond);
  return {
    rec,
    client: new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch }),
  };
};

describe('the computer record', () => {
  it('reads the screen the computer actually renders at', async () => {
    // Assuming 1280x800 makes every click land proportionally short on a
    // computer that asked for something else.
    const { client: c } = client(() => json({ ...COMPUTER, resolution: '1920x1080x24' }));
    const computer = await c.computers.get('vm-1');
    expect(computer.resolution).toBe('1920x1080x24');
    expect(computer.screen).toEqual({ width: 1920, height: 1080 });
  });

  it('falls back to the default for a platform too old to report one', async () => {
    const { client: c } = client(() => json({ ...COMPUTER, resolution: undefined }));
    expect((await c.computers.get('vm-1')).screen).toEqual({ width: 1280, height: 800 });
  });

  it('falls back rather than returning NaN for a resolution it cannot parse', async () => {
    const { client: c } = client(() => json({ ...COMPUTER, resolution: 'wide' }));
    expect((await c.computers.get('vm-1')).screen).toEqual({ width: 1280, height: 800 });
  });

  it('keeps the id of a machine that was built and would not boot', async () => {
    // The machine exists and is billable, so it comes back rather than being
    // thrown away with an exception.
    const { client: c } = client(() =>
      json({ computer: { ...COMPUTER, status: 'stopped' }, start_error: 'no host had room' }),
    );
    const computer = await c.computers.create({ template: 'base' });
    expect(computer.id).toBe('vm-1');
    expect(computer.startError).toBe('no host had room');
    expect(computer.status).toBe('stopped');
  });

  it('offers no vnc surface rather than a URL built over a missing credential', async () => {
    // Such a URL is indistinguishable from a working one and answers 401 forever.
    const half = { ...COMPUTER.vnc, view_token: '' };
    const { client: c } = client(() => json({ ...COMPUTER, vnc: half }));
    expect((await c.computers.get('vm-1')).vnc).toBeUndefined();
  });

  it('reads both desktop credentials when the platform sent a full set', async () => {
    const { client: c } = client(anyRoute);
    const vnc = (await c.computers.get('vm-1')).vnc!;
    expect(vnc.token).toBe('t');
    expect(vnc.viewToken).toBe('v');
    expect(vnc.terminalUrl).toContain('/terminal');
  });

  it('keeps fields this SDK predates, in raw', async () => {
    const { client: c } = client(() => json({ ...COMPUTER, invented_next_week: 7 }));
    expect((await c.computers.get('vm-1')).raw.invented_next_week).toBe(7);
  });

  it('keeps the desktop credentials out of JSON.stringify', async () => {
    // Serializing a handle is what a casual log line does, and a credential in
    // a log line is exactly what the platform strips them from listings to
    // prevent. They are read deliberately, off vnc or raw.
    const { client: c } = client(anyRoute);
    const computer = await c.computers.get('vm-1');
    expect(computer.vnc?.token).toBe('t');
    expect(JSON.stringify(computer)).not.toContain('vnc');
    expect(computer.raw.vnc).toBeDefined();
  });

  it('hands out raw as a copy deep enough that nothing writes back through it', async () => {
    const { client: c } = client(anyRoute);
    const computer = await c.computers.get('vm-1');
    (computer.raw.vnc as Record<string, unknown>).token = 'overwritten';
    expect(computer.vnc?.token).toBe('t');
  });
});

describe('waiting', () => {
  it('does not spin on a suspended computer, which will not start on its own', async () => {
    // Left to spin it reports a machine that is one call from running as a
    // timeout — the least informative answer about the one case a caller can
    // fix in a line.
    const { client: c } = client(() => json({ ...COMPUTER, status: 'suspended' }));
    const computer = await c.computers.get('vm-1');
    await expect(computer.waitUntilRunning({ timeoutMs: 60_000 })).rejects.toThrow(
      /call start\(\) to resume it/,
    );
  });

  it('does not spin on a failed build, which nothing will fix', async () => {
    const { client: c } = client(() =>
      json({ ...COMPUTER, status: 'build-failed', build: { failed: 'the copy died' } }),
    );
    const computer = await c.computers.get('vm-1');
    await expect(computer.waitUntilRunning({ timeoutMs: 60_000 })).rejects.toThrow(/the copy died/);
  });

  it('does not spin on a stopped computer and preserves its create start error', async () => {
    const { rec, client: c } = client((call) => {
      if (call.method === 'POST' && call.path === '/computers') {
        return json({
          computer: { ...COMPUTER, status: 'stopped' },
          start_error: 'no host had room',
        });
      }
      return json({ ...COMPUTER, status: 'stopped' });
    });
    const computer = await c.computers.create({ template: 'base' });
    const err = await computer.waitUntilRunning({ timeoutMs: 50, pollMs: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(MandalaError);
    expect(err).not.toBeInstanceOf(TimeoutError);
    expect(err.message).toMatch(/no host had room/);
    expect(err.message).toMatch(/start\(\) to try again/);
    expect(rec.routes()).toEqual([
      ['POST', 'computers'],
      ['GET', 'computers/vm-1'],
    ]);
  });

  it('returns at once for a computer that is not being built', async () => {
    const { client: c } = client(anyRoute);
    const computer = await c.computers.get('vm-1');
    await expect(computer.waitUntilBuilt({ timeoutMs: 1 })).resolves.toBe(computer);
  });

  it('says a build has not stopped, only the waiting has', async () => {
    const { client: c } = client(() => json({ ...COMPUTER, status: 'building' }));
    const computer = await c.computers.get('vm-1');
    const err = await computer.waitUntilBuilt({ timeoutMs: 5, pollMs: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    expect(err.message).toMatch(/it has not stopped; only this wait has/);
  });

  it('describes an already-building handle accurately when no poll was allowed', async () => {
    const { client: c } = client(() => json({ ...COMPUTER, status: 'building' }));
    const computer = await c.computers.get('vm-1');
    const err = await computer.waitUntilBuilt({ timeoutMs: 0, pollMs: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    expect(err.message).toMatch(/was still building/);
    expect(err.message).not.toMatch(/every refresh failed/);
  });

  it('rides out a transient error from the host busy doing the copy being waited on', async () => {
    // A 503 during a minutes-long disk copy is the ordinary weather of a
    // build; one of them must not abort the whole wait.
    let polls = 0;
    const { client: c } = client((call) => {
      if (call.method === 'GET' && call.path === '/computers/vm-1') {
        polls += 1;
        if (polls === 1) return json({ ...COMPUTER, status: 'building' });
        if (polls === 2) return errorJson(503, 'host could not be reached');
        return json(COMPUTER);
      }
      return anyRoute(call);
    });
    const computer = await c.computers.get('vm-1');
    await expect(computer.waitUntilBuilt({ timeoutMs: 5_000, pollMs: 1 })).resolves.toBe(computer);
    expect(polls).toBe(3);
  });

  it('does not call a machine running on data it never observed', async () => {
    // A handle that last saw "running" must not return success while every
    // refresh inside the wait is failing with a 503 — that is a verdict on a
    // machine nobody has actually looked at.
    let gets = 0;
    const { client: c } = client((call) => {
      if (call.method === 'GET' && call.path === '/computers/vm-1') {
        gets += 1;
        return gets === 1 ? json(COMPUTER) : errorJson(503, 'host could not be reached');
      }
      return anyRoute(call);
    });
    const computer = await c.computers.get('vm-1'); // last saw "running"
    const err = await computer.waitUntilRunning({ timeoutMs: 10, pollMs: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    // Nor may the timeout message: 'was still "running"' would be the same
    // unobserved claim, one line lower.
    expect(err.message).toMatch(/could not be observed/);
    expect(err.message).not.toMatch(/was still/);
  });

  it('does not quote a status in the present tense after the polls stopped answering', async () => {
    // One refresh answers, then every later one fails to the deadline. `was
    // still "starting"` is a claim about now, made from a reading that is by
    // then as old as the wait itself — the flag that gates it means "any poll
    // in this wait saw a status", which is the wrong question for a tense
    // (OPL-4201).
    let gets = 0;
    const { client: c } = client((call) => {
      if (call.method === 'GET' && call.path === '/computers/vm-1') {
        gets += 1;
        return gets <= 2
          ? json({ ...COMPUTER, status: 'starting' })
          : errorJson(503, 'host could not be reached');
      }
      return anyRoute(call);
    });
    const computer = await c.computers.get('vm-1');
    const err = await computer.waitUntilRunning({ timeoutMs: 40, pollMs: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    expect(err.message).toContain('could not be reached for the last part');
    expect(err.message).toContain('when it last answered it was "starting"');
    expect(err.message).not.toMatch(/was still/);
    // Still the timeout it always was: only the sentence changed.
    expect(err.message).not.toMatch(/every refresh failed/);
  });

  it('still says a machine was still X when the last poll is the one that saw it', async () => {
    // The past tense is for a wait that lost the host, not for every timeout:
    // when the refreshes keep answering, the reading is current and the
    // present tense is the accurate one.
    const { client: c } = client(() => json({ ...COMPUTER, status: 'starting' }));
    const computer = await c.computers.get('vm-1');
    const err = await computer.waitUntilRunning({ timeoutMs: 20, pollMs: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    expect(err.message).toContain('was still "starting"');
  });

  it('fails fast on a suspended machine even while every refresh is failing', async () => {
    // The handle's data may be fresh from the get() one line before the wait,
    // and suspended does not become "running" on its own — spinning out the
    // full 120s to repeat what was already known helps nobody.
    let gets = 0;
    const { client: c } = client((call) => {
      if (call.method === 'GET' && call.path === '/computers/vm-1') {
        gets += 1;
        return gets === 1
          ? json({ ...COMPUTER, status: 'suspended' })
          : errorJson(503, 'host could not be reached');
      }
      return anyRoute(call);
    });
    const computer = await c.computers.get('vm-1'); // fresh: suspended
    await expect(computer.waitUntilRunning({ timeoutMs: 60_000, pollMs: 1 })).rejects.toThrow(
      /call start\(\) to resume it/,
    );
  });

  it('rides out the 409 that means the guest agent is still coming up', async () => {
    // Giving up here abandons a machine that was about to answer.
    let attempts = 0;
    const { client: c } = client((call) => {
      if (call.path.endsWith('/exec')) {
        attempts += 1;
        return attempts < 3
          ? errorJson(409, 'the guest agent is not answering yet')
          : json(EXEC_OK);
      }
      return anyRoute(call);
    });
    const computer = await c.computers.get('vm-1');
    await expect(computer.waitForGuest({ timeoutMs: 5_000, pollMs: 1 })).resolves.toBe(computer);
    expect(attempts).toBe(3);
  });

  it('retries a temporary network failure while waiting for the machine', async () => {
    let gets = 0;
    const { client: c } = client((call) => {
      if (call.method === 'GET' && call.path === '/computers/vm-1') {
        gets += 1;
        if (gets === 1) return json({ ...COMPUTER, status: 'starting' });
        if (gets === 2) throw new TypeError('fetch failed');
        return json(COMPUTER);
      }
      return anyRoute(call);
    });
    const computer = await c.computers.get('vm-1');
    await expect(computer.waitUntilRunning({ timeoutMs: 5_000, pollMs: 1 })).resolves.toBe(
      computer,
    );
    expect(gets).toBe(3);
  });

  /**
   * The regression the first cut of OPL-3724 introduced, caught by Codex's
   * adversarial review of the PR.
   *
   * `waitForGuest` used to run `isPermanent(err)` unconditionally, so a revoked
   * key reached the caller whenever it arrived. Collapsing that into the gated
   * check below it — `Date.now() < deadline && !isTransientForPoll(err)` —
   * quietly made a 401 conditional on the clock, and the condition fails
   * exactly when a probe outlives what was left of the wait. The caller then
   * got "guest did not respond within 5000ms" about a key that had been revoked
   * for a week.
   *
   * Pinned with the clock trick the deadline-race test below uses, for its
   * reason: the state is a probe that STARTED before the deadline and whose
   * answer arrives after it, and skewing the clock while the request is in
   * flight writes that down instead of waiting for it. Real time is untouched.
   */
  it('surfaces a permanent refusal from the guest probe however late it lands', async () => {
    for (const [status, name] of [
      [401, 'AuthenticationError'],
      [402, 'PlanLimitError'],
      [403, 'PermissionDeniedError'],
      [404, 'NotFoundError'],
    ] as const) {
      let skewMs = 0;
      const realNow = Date.now.bind(Date);
      // Restored in the `finally` rather than an afterEach: a lying clock left
      // behind by a failing test is every other test failing for a reason none
      // of them names.
      const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + skewMs);
      try {
        const { client: c } = client((call) => {
          if (call.path.endsWith('/exec')) {
            // The deadline passes while this probe is in flight. The abort
            // signal was built from the real interval and does not fire, so the
            // refusal arrives intact — which is the race, not a simulation of
            // one: a response and a timeout can both win.
            skewMs = 60_000;
            return errorJson(status, 'no');
          }
          return anyRoute(call);
        });
        const computer = await c.computers.get('vm-1');
        const err = await computer.waitForGuest({ timeoutMs: 5_000, pollMs: 1 }).catch((e) => e);
        // The status decides this, not the clock.
        expect(err).toBeInstanceOf(APIError);
        expect((err as APIError).status).toBe(status);
        expect(err.constructor.name).toBe(name);
        expect(err).not.toBeInstanceOf(TimeoutError);
      } finally {
        clock.mockRestore();
      }
    }
  });

  it('rides out an edge blip on the control plane instead of failing the wait', async () => {
    // The user-visible half of OPL-3724. waitUntilRunning polls
    // `GET computers/:id`, where a 502 or a 522 is a proxy having a moment —
    // and it used to ask isTransient, which named neither, so one blip during a
    // boot was reported to the caller as a machine that never came up. The
    // argument for keeping 502 fatal was about the GUEST agent going silent,
    // and waitForGuest is the only wait that ever sees that one.
    for (const status of [502, 504, 520, 522]) {
      let gets = 0;
      const { client: c } = client((call) => {
        if (call.method === 'GET' && call.path === '/computers/vm-1') {
          gets += 1;
          if (gets === 1) return json({ ...COMPUTER, status: 'starting' });
          if (gets === 2) return errorJson(status, `HTTP ${status}`);
          return json(COMPUTER);
        }
        return anyRoute(call);
      });
      const computer = await c.computers.get('vm-1');
      await expect(computer.waitUntilRunning({ timeoutMs: 5_000, pollMs: 1 })).resolves.toBe(
        computer,
      );
      expect(gets).toBe(3);
    }
  });

  it('still gives up on a wait whose failure describes the request', async () => {
    // The other side of the same line, and what keeps the deny-list honest: a
    // 401 or a 400 answers the same way on every poll, so swallowing one spends
    // the caller's whole timeout to report the wrong cause.
    for (const status of [400, 401, 403, 404]) {
      let gets = 0;
      const { client: c } = client((call) => {
        if (call.method === 'GET' && call.path === '/computers/vm-1') {
          gets += 1;
          // The handle first, so the wait is what meets the refusal.
          return gets === 1
            ? json({ ...COMPUTER, status: 'starting' })
            : errorJson(status, `HTTP ${status}`);
        }
        return anyRoute(call);
      });
      const computer = await c.computers.get('vm-1');
      const err = await computer.waitUntilRunning({ timeoutMs: 60_000, pollMs: 1 }).catch((e) => e);
      expect(err).toBeInstanceOf(APIError);
      expect((err as APIError).status).toBe(status);
    }
  });

  it('honours Retry-After while polling through a rate limit', async () => {
    let attempts = 0;
    const { client: c } = client((call) => {
      if (call.path.endsWith('/exec')) {
        attempts += 1;
        return attempts === 1
          ? errorJson(429, 'slow down', { 'Retry-After': '0.02' })
          : json(EXEC_OK);
      }
      return anyRoute(call);
    });
    const computer = await c.computers.get('vm-1');
    const started = Date.now();
    await expect(computer.waitForGuest({ timeoutMs: 5_000, pollMs: 1 })).resolves.toBe(computer);
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
    expect(attempts).toBe(2);
  });

  it('does not turn a malformed guest request into a readiness timeout', async () => {
    const { rec, client: c } = client((call) =>
      call.path.endsWith('/exec') ? errorJson(400, 'bad probe') : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    await expect(computer.waitForGuest({ timeoutMs: 60_000, pollMs: 1_000 })).rejects.toThrow(
      /bad probe/,
    );
    expect(rec.routes().filter(([, p]) => p.endsWith('/exec'))).toHaveLength(1);
  });

  it('gives up at once on a failure no amount of waiting will clear', async () => {
    // A revoked key is not going to become valid three minutes from now, and
    // reporting it as a timeout names the wrong problem. The long timeout here
    // is the test: it must not be reached.
    const { rec, client: c } = client((call) =>
      call.path.endsWith('/exec') ? errorJson(401, 'that key has been revoked') : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    const started = Date.now();
    await expect(computer.waitForGuest({ timeoutMs: 60_000, pollMs: 1_000 })).rejects.toThrow(
      /that key has been revoked/,
    );
    expect(Date.now() - started).toBeLessThan(1_000);
    // One probe, not a loop's worth.
    expect(rec.routes().filter(([, p]) => p.endsWith('/exec'))).toHaveLength(1);
  });

  it('keeps polling through a 502 from a guest agent that is merely slow', async () => {
    let attempts = 0;
    const { client: c } = client((call) => {
      if (call.path.endsWith('/exec')) {
        attempts += 1;
        return attempts < 3 ? errorJson(502, 'the guest agent did not answer') : json(EXEC_OK);
      }
      return anyRoute(call);
    });
    const computer = await c.computers.get('vm-1');
    await expect(computer.waitForGuest({ timeoutMs: 5_000, pollMs: 1 })).resolves.toBe(computer);
    expect(attempts).toBe(3);
  });

  it('refuses a timeout or a poll interval that would never expire', async () => {
    // `Date.now() >= NaN` is false and `setTimeout(fn, NaN)` fires at once, so
    // between them a NaN turns a wait into an unthrottled request loop that
    // never returns. `timeoutMs: Number(unsetEnvVar)` is how it arrives.
    const { rec, client: c } = client(anyRoute);
    const computer = await c.computers.get('vm-1');
    const before = rec.calls.length;
    for (const wait of [
      () => computer.waitUntilBuilt({ timeoutMs: Number.NaN }),
      () => computer.waitUntilRunning({ pollMs: Number.NaN }),
      () => computer.waitForGuest({ timeoutMs: Number.POSITIVE_INFINITY }),
      () => computer.waitUntilRunning({ timeoutMs: -1 }),
      () => computer.waitUntilBuilt({ pollMs: 2_147_483_648 }),
      () => computer.waitUntilRunning({ pollMs: 0 }),
    ]) {
      await expect(wait()).rejects.toThrow(TypeError);
    }
    // Refused before the loop starts, so not one request went out.
    expect(rec.calls.length).toBe(before);
  });

  /**
   * The test above catches this about one run in thirty, which is how it
   * reached CI green four times and then failed on the fifth (Node 24, run
   * 33033... on OPL-3835). This one catches it every time.
   *
   * `deadlineSignal` composes `AbortSignal.timeout`, and that fires up to a
   * millisecond BEFORE `Date.now()` has advanced by the interval it was given —
   * measured at 3.3% of short waits on this machine. The wait loops used to
   * decide whether an error was their own deadline by asking the clock
   * (`Date.now() < deadline &&`), so on those runs the wait's own abort read as
   * a platform failure and the raw DOMException — which is *named*
   * `TimeoutError` but is not this SDK's `TimeoutError` — reached the caller.
   * A caller catching the documented type would not have caught it.
   *
   * Pinned by rejecting with that exact DOMException while the deadline is
   * still comfortably ahead, which is the state the race produces and which no
   * timing here has to reproduce.
   */
  it('reports its own deadline as a TimeoutError even when the abort beats the clock', async () => {
    // The abort has to reach the loop as the RAW DOMException, and the transport
    // only rethrows it verbatim when the signal it was handed is the one that
    // fired (`opts.signal?.aborted`, judged first). So the poll below waits for
    // that signal rather than rejecting on its own — anything else is converted
    // to a ConnectionError, retried, and proves nothing.
    //
    // The clock is then made to lag five milliseconds from the moment that poll
    // starts, which is the race written down rather than waited for: the abort
    // arrives while `Date.now()` still reads before the deadline. Real time is
    // untouched, so the loop still terminates once it catches up.
    let gets = 0;
    let skewMs = 0;
    const realNow = Date.now.bind(Date);
    // Restored in the `finally` below rather than in an afterEach: a lying
    // clock left behind by a failing test is 152 other tests failing for a
    // reason none of them names.
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() - skewMs);
    const { client: c } = client((call) => {
      if (call.method === 'GET' && call.path === '/computers/vm-1') {
        gets += 1;
        // The handle has to exist before it can wait, and it has to be waiting
        // for something: a computer already `running` is one waitUntilRunning
        // answers without polling at all.
        if (gets === 1) return json({ ...COMPUTER, status: 'starting' });
        skewMs = 5;
        // A host that accepts the connection and then says nothing, so the
        // harness's own race is what rejects — with `signal.reason`, which is
        // the DOMException, exactly as a real fetch does.
        return new Promise<Response>(() => {});
      }
      return anyRoute(call);
    });
    let err: unknown;
    try {
      const computer = await c.computers.get('vm-1');
      err = await computer.waitUntilRunning({ timeoutMs: 30, pollMs: 1 }).catch((e) => e);
    } finally {
      clock.mockRestore();
    }
    // The SDK's class, and not merely something whose `name` reads the same: the
    // DOMException is itself called `TimeoutError`, so a check on the name
    // passes on the bug. Only the class tells them apart.
    expect(err).toBeInstanceOf(TimeoutError);
    expect(err).not.toBeInstanceOf(DOMException);
  });

  /** The values a boolean option must refuse, whichever option it is. */
  const NOT_BOOLEANS = ['false', 'true', 0, 1, null, new Boolean(false)];

  /**
   * The second sweep, after the first one missed these.
   *
   * The first pass swept `opts.X ?` in resources.ts and computer.ts and fixed
   * four options. It never looked in paths.ts, which is where the QUERIES are
   * built and where the two flags that matter most live — so it graded itself
   * clean while `deleteSnapshots` was still read by `!` (adversarial review,
   * second pass, OPL-3835).
   *
   * `deleteSnapshots: "false"` is the worst value on this surface. `!"false"`
   * is false, so a caller who wrote the word FALSE, with a fingerprint in hand
   * because they pass one every time, sent `snapshots=delete` and destroyed
   * every snapshot the computer had. Nothing undoes that. `force: "false"`
   * pulls the power on a machine whose caller asked for the graceful stop.
   *
   * Asserted as no request AT ALL, which is the only assertion worth making
   * about an irreversible call: a refusal that still sent it would have
   * destroyed the snapshots and then complained.
   *
   * These two are their own test, and were not until OPL-4203. The argument
   * above is about irreversibility and nothing else, and it used to sit on a
   * case that swept five more options that undo fine — so a reader had to work
   * out which half of the loop it was talking about. Splitting keeps it
   * attached to the calls it is actually about.
   */
  it('refuses a non-boolean flag on the two irreversible options, and sends nothing', async () => {
    for (const bad of NOT_BOOLEANS) {
      const v = bad as unknown as boolean;
      const { rec, client: c } = client(anyRoute);
      const computer = await c.computers.get('vm-1');
      const before = rec.calls.length;
      for (const call of [
        () => computer.delete({ deleteSnapshots: v, expect: 'fp-1' }),
        () => computer.stop({ force: v }),
      ]) {
        await expect(call()).rejects.toThrow(TypeError);
      }
      expect(rec.calls.length).toBe(before);
    }
  });

  /**
   * The same rule on the options where being wrong is recoverable.
   *
   * Nothing here destroys anything — a snapshot with the wrong memory flag, a
   * screenshot served from cache, a command run off the desktop session. The
   * rule is the rule anyway: a flag the caller did not mean is a DIFFERENT CALL
   * from the one they wrote, and a client that silently picks one has answered
   * a question nobody asked.
   *
   * Still asserted as no request at all, for the same reason it is worth
   * asserting on the irreversible pair: a refusal that has already sent the
   * request is not a refusal.
   *
   * `background` is not in the list because no caller can reach it:
   * execBackground passes the literal `true`. It is validated anyway, so that
   * the rule holds if that ever changes.
   */
  it('refuses a non-boolean flag on the recoverable options too', async () => {
    for (const bad of NOT_BOOLEANS) {
      const v = bad as unknown as boolean;
      const { rec, client: c } = client(anyRoute);
      const computer = await c.computers.get('vm-1');
      const before = rec.calls.length;
      for (const call of [
        () => computer.snapshot({ memory: v }),
        () => computer.windows({ includeAll: v }),
        () => computer.screenshot(undefined, { fresh: v }),
        () => computer.exec('ls', { desktop: v }),
        () => computer.execBackground('ls', { desktop: v }),
      ]) {
        await expect(call()).rejects.toThrow(TypeError);
      }
      expect(rec.calls.length).toBe(before);
    }
  });

  it('does not let a poll outlive the wait it belongs to', async () => {
    // The transport's deadline is the client's — 60 seconds by default — and a
    // refresh made under it runs on long past the moment the wait was told to
    // give up. What is left of the wait has to be what governs the request.
    let gets = 0;
    const { client: c } = client((call) => {
      if (call.method === 'GET' && call.path === '/computers/vm-1') {
        gets += 1;
        if (gets === 1) return json(COMPUTER);
        // A host that accepts the connection and then says nothing.
        return new Promise<Response>(() => {});
      }
      return anyRoute(call);
    });
    const computer = await c.computers.get('vm-1');
    const started = Date.now();
    const err = await computer.waitUntilRunning({ timeoutMs: 20, pollMs: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('reports the refreshes, not a stale status, when a build was never observed', async () => {
    // waitUntilRunning's rule, on the wait that did not have it: "was still
    // building" read off pre-wait data is a claim about a computer nobody
    // looked at.
    let gets = 0;
    const { client: c } = client((call) => {
      if (call.method === 'GET' && call.path === '/computers/vm-1') {
        gets += 1;
        return gets === 1
          ? json({ ...COMPUTER, status: 'building' })
          : errorJson(503, 'host could not be reached');
      }
      return anyRoute(call);
    });
    const computer = await c.computers.get('vm-1');
    const err = await computer.waitUntilBuilt({ timeoutMs: 10, pollMs: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    expect(err.message).toMatch(/could not be observed/);
    expect(err.message).not.toMatch(/was still building/);
  });

  it('does not claim a build is still running from a reading the wait outlived', async () => {
    // waitUntilRunning's rule, in the tense: one refresh answers "building" and
    // every later one 503s, so "is still building" is asserted about a computer
    // whose last actual reading is the whole budget old. builds.wait already
    // drops to "when it last answered" here (OPL-4201).
    let gets = 0;
    const { client: c } = client((call) => {
      if (call.method === 'GET' && call.path === '/computers/vm-1') {
        gets += 1;
        return gets <= 2
          ? json({ ...COMPUTER, status: 'building' })
          : errorJson(503, 'host could not be reached');
      }
      return anyRoute(call);
    });
    const computer = await c.computers.get('vm-1');
    const err = await computer.waitUntilBuilt({ timeoutMs: 40, pollMs: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    expect(err.message).toContain('could not be reached for the last part');
    expect(err.message).toContain('when it last answered its disk was still being copied');
    expect(err.message).not.toMatch(/was still building/);
    // The copy is the platform's, not this wait's, and that survives the tense.
    expect(err.message).toContain('only this wait has');
  });

  it('keeps the present tense for a build whose last poll answered', async () => {
    // Every refresh answers "building" to the deadline, so the reading quoted
    // is the current one and there is nothing to hedge.
    const { client: c } = client(() => json({ ...COMPUTER, status: 'building' }));
    const computer = await c.computers.get('vm-1');
    const err = await computer.waitUntilBuilt({ timeoutMs: 20, pollMs: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    expect(err.message).toMatch(/was still building/);
    expect(err.message).not.toMatch(/could not be reached/);
  });

  it('polls a build before its first sleep, not after it', async () => {
    // A clone that finished while the caller was doing something else is one
    // round trip from being known to have finished. The poll interval here is
    // a minute: sleeping first would make this test take one.
    let gets = 0;
    const { client: c } = client((call) => {
      if (call.method === 'GET' && call.path === '/computers/vm-1') {
        gets += 1;
        return gets === 1 ? json({ ...COMPUTER, status: 'building' }) : json(COMPUTER);
      }
      return anyRoute(call);
    });
    const computer = await c.computers.get('vm-1');
    const started = Date.now();
    await expect(computer.waitUntilBuilt({ timeoutMs: 5_000, pollMs: 60_000 })).resolves.toBe(
      computer,
    );
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('does not probe the guest of a computer that has no disk', async () => {
    // The README promises every wait fails fast on a failed build. This one
    // spun out its whole three minutes probing a machine with nothing to
    // answer from.
    const { rec, client: c } = client((call) =>
      call.method === 'GET' && call.path === '/computers/vm-1'
        ? json({ ...COMPUTER, status: 'build-failed', build: { failed: 'the copy died' } })
        : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    await expect(computer.waitForGuest({ timeoutMs: 60_000, pollMs: 1 })).rejects.toThrow(
      /the copy died/,
    );
    expect(rec.routes().filter(([, p]) => p.endsWith('/exec'))).toHaveLength(0);
  });

  it('refreshes a building clone so a failed copy stops guest probing', async () => {
    let gets = 0;
    const { rec, client: c } = client((call) => {
      if (call.method === 'GET' && call.path === '/computers/vm-1') {
        gets += 1;
        return gets === 1
          ? json({ ...COMPUTER, status: 'building' })
          : json({ ...COMPUTER, status: 'build-failed', build: { failed: 'copy failed' } });
      }
      return anyRoute(call);
    });
    const computer = await c.computers.get('vm-1');
    await expect(computer.waitForGuest({ timeoutMs: 60_000, pollMs: 1 })).rejects.toThrow(
      /copy failed/,
    );
    expect(rec.routes().filter(([, p]) => p.endsWith('/exec'))).toHaveLength(0);
  });

  it('waits through a suspended computer rather than refusing it, because exec resumes one', async () => {
    // The opposite of waitUntilRunning, deliberately: nothing resumes a machine
    // for that wait, and the probe here does it as a side effect.
    const { client: c } = client((call) =>
      call.method === 'GET' && call.path === '/computers/vm-1'
        ? json({ ...COMPUTER, status: 'suspended' })
        : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    await expect(computer.waitForGuest({ timeoutMs: 5_000, pollMs: 1 })).resolves.toBe(computer);
  });
});

describe('a chord', () => {
  it('takes an array with options, and still takes plain arguments', async () => {
    // key() was the one input method with no CallOptions, which made a chord
    // the one keystroke in this SDK that no signal could cancel.
    const { rec, client: c } = client(anyRoute);
    const computer = await c.computers.get('vm-1');
    await computer.key('ctrl', 'c');
    const spread = rec.last().body;
    await computer.key(['ctrl', 'c']);
    expect(rec.last().body).toEqual(spread);
    expect(spread).toEqual({ action: 'key', keys: ['ctrl', 'c'] });
  });

  it('refuses a trailing options object instead of sending it as a keystroke', async () => {
    // TypeScript's overloads reject this, but JavaScript reaches it — and every
    // other input method takes CallOptions last, so it is the natural thing to
    // write. It used to be serialised INTO `keys` as a third keystroke while
    // the signal it carried was dropped: not the chord asked for, and not
    // cancellable either.
    const { rec, client: c } = client(anyRoute);
    const computer = await c.computers.get('vm-1');
    const before = rec.calls.length;
    await expect(
      (computer.key as (...a: unknown[]) => Promise<void>)('ctrl', 'c', {
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/array form/);
    expect(rec.calls.length).toBe(before);
  });

  it('honours the signal the array form can carry', async () => {
    const { client: c } = client(anyRoute);
    const computer = await c.computers.get('vm-1');
    await expect(computer.key(['ctrl', 'c'], { signal: AbortSignal.abort() })).rejects.toThrow();
  });

  it('reports the validation error when JavaScript calls key with no arguments', async () => {
    const { client: c } = client(anyRoute);
    const computer = await c.computers.get('vm-1');
    await expect((computer.key as () => Promise<void>)()).rejects.toThrow(/at least one key/);
  });
});

describe('what a payload cannot be allowed to mean', () => {
  it('normalizes a null count to undefined, which is what the type promises', async () => {
    // `written === undefined` is the check a caller writes to find out whether
    // the platform answered. A raw null is not undefined, and `mandala scp`
    // printed "null bytes" because of it.
    const { client: c } = client((call) => {
      if (call.path.endsWith('/files') && call.method === 'PUT') return json({ bytes: null });
      if (call.method === 'DELETE') return json({ snapshots_deleted: null });
      return anyRoute(call);
    });
    const computer = await c.computers.get('vm-1');
    expect(await computer.writeFile('/tmp/f', 'hi')).toBeUndefined();
    expect(await computer.delete()).toBeUndefined();
  });

  it('refuses a screenshot that is not an image', async () => {
    // A captive portal answers 200 with an HTML page, and these bytes go
    // straight into an image decoder or a model's context.
    const { client: c } = client((call) =>
      call.path.endsWith('/screenshot')
        ? new Response('<!DOCTYPE html><title>Sign in</title>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          })
        : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    await expect(computer.screenshot()).rejects.toThrow(/expected an image/);
  });

  it('accepts a mixed-case image media type', async () => {
    const { client: c } = client((call) =>
      call.path.endsWith('/screenshot')
        ? new Response('png', { headers: { 'content-type': 'Image/PNG' } })
        : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    expect(new TextDecoder().decode(await computer.screenshot())).toBe('png');
  });

  it('reads a stringified false as false, not as the corner of the screen', async () => {
    // The platform this mirrors has a Python SDK, and `str(False)` is 'False'.
    const { client: c } = client((call) =>
      call.path.endsWith('/input') ? json({ known: 'false', x: 0, y: 0 }) : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    expect(await computer.cursorPosition()).toBeUndefined();
  });

  it('falls back rather than answering NaN on a shape that is not a number', async () => {
    // A NaN CPU count fails every comparison a caller writes, including the
    // `>= 2` that was meant to be false.
    const { client: c } = client(() => json({ ...COMPUTER, cpu: 'two', idle_suspend_min: 'soon' }));
    const computer = await c.computers.get('vm-1');
    expect(computer.cpu).toBe(0);
    expect(computer.idleSuspendMin).toBeUndefined();
  });

  /**
   * OPL-4260. The field a caller reads before driving a window.
   *
   * `os` is `linux` for a Wayland guest and an X11 one alike, so this is the
   * only thing on the payload that separates them — and two things a caller
   * acts on change with it: a window id is a compositor address rather than an
   * X window id, and a move or resize of a tiled window is refused rather than
   * quietly applied to nothing. `publicComputer` publishes it on the computer
   * as well as on the template because a computer keeps the image it was cut
   * from while a template's version can advance.
   */
  it('says which display protocol the desktop speaks', async () => {
    const { client: c } = client(() => json(WAYLAND_COMPUTER));
    const computer = await c.computers.get('vm-1');
    expect(computer.desktop).toBe('wayland');
    // Not distinguishable by `os`, which is the reason the field exists.
    expect(computer.os).toBe('linux');
  });

  /**
   * ABSENT, and not `'x11'` and not `''`.
   *
   * The one getter on this handle that cannot be a plain `str()`. A host
   * deployed before OPL-4223 does not send the field, and the platform passes
   * that silence through rather than naming a value, because naming one would
   * assert a property of an image nobody claimed. `str()`'s fallback would
   * answer `''` — a display protocol no host speaks — and a fallback of `'x11'`
   * would put the platform's refused assertion back on this side of the wire.
   * The same fault `cursorPosition` and the window geometry decoder each refuse
   * by name.
   */
  it('says nothing rather than x11 when the platform said nothing', async () => {
    const { client: c } = client(anyRoute);
    const computer = await c.computers.get('vm-1');
    expect(computer.desktop).toBeUndefined();
    // And explicitly not the empty string, which is what `str()` would give and
    // which reads as a protocol that was named rather than one that was not.
    expect(computer.desktop).not.toBe('');
  });

  it('keeps an x11 the platform did say', async () => {
    // The absence above is a host that has not been told about the field; a
    // host that HAS says so out loud, and flattening the two would lose the only
    // evidence a caller has that the platform answered the question at all.
    const { client: c } = client(() => json({ ...COMPUTER, desktop: 'x11' }));
    const computer = await c.computers.get('vm-1');
    expect(computer.desktop).toBe('x11');
  });

  it('refuses an answer that is not a computer, where the id would have gone missing', async () => {
    // refresh() already names this. get/create/clone built a handle with id ''
    // instead, and everything it could do then threw about an empty id from a
    // path builder, naming neither the route nor the empty answer.
    const { client: c } = client(() => json({}));
    await expect(c.computers.get('vm-1')).rejects.toThrow(/expected a computer from GET/);
    await expect(c.computers.create()).rejects.toThrow(/expected a computer from POST/);
    await expect(c.snapshots.clone('snap-1')).rejects.toThrow(/expected a computer from POST/);
  });

  it('guards the other two create-computer routes against an empty answer', async () => {
    const { client: c } = client((call) => (call.method === 'POST' ? json({}) : anyRoute(call)));
    const computer = await c.computers.get('vm-1');
    await expect(computer.clone()).rejects.toThrow(/expected a computer from POST/);
    await expect(c.computers.ephemeral()).rejects.toThrow(/expected a computer from POST/);
  });

  it('refuses empty single-record answers instead of inventing records', async () => {
    for (const route of ['snapshot', 'holdings', 'agentOnce'] as const) {
      const { client: c } = client((call) => {
        if (call.path.endsWith('/snapshots')) {
          if (route === 'snapshot' && call.method === 'POST') return json({});
          if (route === 'holdings' && call.method === 'GET') return json({});
        }
        if (route === 'agentOnce' && call.path.endsWith('/agent')) return json({});
        return anyRoute(call);
      });
      const computer = await c.computers.get('vm-1');
      const answer =
        route === 'snapshot'
          ? computer.snapshot()
          : route === 'holdings'
            ? computer.holdings()
            : computer.agentOnce({ prompt: 'go', modelKey: 'sk' });
      await expect(answer).rejects.toThrow(
        /expected (a snapshot|snapshot holdings|an agent result)/,
      );
    }
  });

  it('does not read an unreadable status as a disk copy that finished', async () => {
    // `#statusIs` is a strict comparison precisely so a coerced value cannot
    // classify — `String(['building'])` is `'building'` — and this wait
    // inverted it: success was the NEGATION, so an array status read as a copy
    // that had finished, `buildFailed` did not throw either, and the caller
    // started a computer whose disk was still being written.
    for (const status of [['building'], ['build-failed'], undefined, 42]) {
      const { client: c } = client(() => json({ ...COMPUTER, status }));
      const computer = await c.computers.get('vm-1');
      await expect(computer.waitUntilBuilt({ timeoutMs: 60, pollMs: 10 })).rejects.toThrow(
        TimeoutError,
      );
    }
    // A readable status that is not `building` still returns at once, which is
    // what makes this safe to call on any computer.
    const { client: ok } = client(() => json(COMPUTER));
    await expect((await ok.computers.get('vm-1')).waitUntilBuilt()).resolves.toBeDefined();
  });

  it('says the status was unreadable rather than that the copy is still running', async () => {
    const { client: c } = client(() => json({ ...COMPUTER, status: ['building'] }));
    const computer = await c.computers.get('vm-1');
    const err = await computer.waitUntilBuilt({ timeoutMs: 60, pollMs: 10 }).catch((e) => e);
    expect(String(err)).toContain('without a status this client could read');
  });

  it('does not blame a disk copy that never ran for a deadline that had elapsed', async () => {
    // `timeoutMs: 0` is a supported argument and reaches here on any ordinary
    // computer: the budget is gone before the loop can make its first request.
    // The message named a phase this call never had, and pointed at the wrong
    // fix — "the copy itself finished" about a computer that was never cloned.
    const { client: c } = client(anyRoute);
    const computer = await c.computers.get('vm-1');
    const err = await computer.waitForGuest({ timeoutMs: 0 }).catch((e) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    expect(String(err)).toContain('had elapsed before its guest could be probed');
    expect(String(err)).not.toContain('disk copy used the whole');
  });

  it('refuses a hole in a chord rather than sending a null keystroke', async () => {
    // `JSON.stringify` turns an `undefined` array entry into `null`, so
    // `key('ctrl', undefined, 'c')` reached the platform as
    // `keys: ['ctrl', null, 'c']` — a chord with a keystroke nobody named.
    // `key('ctrl', map.get('copy'))` is how one arrives.
    const { rec, client: c } = client(anyRoute);
    const computer = await c.computers.get('vm-1');
    const before = rec.calls.length;
    await expect(
      (computer.key as (...a: unknown[]) => Promise<void>)('ctrl', undefined, 'c'),
    ).rejects.toThrow(ValidationError);
    // Refused before anything was sent, which is the only assertion worth
    // making about a keystroke.
    expect(rec.calls.length).toBe(before);
    // The ordinary chord still goes.
    await computer.key('ctrl', 'c');
    expect(rec.last().body).toMatchObject({ action: 'key', keys: ['ctrl', 'c'] });
  });

  it('refuses a window action body that decodes into the one outcome not to retry', async () => {
    // `{}` and `{"ok":true}` decode perfectly: `window` absent is undefined,
    // `gone` absent is false — and that pair is documented as "the action
    // happened and the guest could not describe the result", which a caller is
    // told not to repeat. So a truncated 200 read as a deliberate no-op.
    for (const body of [{}, { ok: true }]) {
      const { client: c } = client((call) =>
        /\/windows\/[^/]+$/.test(call.path) ? json(body) : anyRoute(call),
      );
      const computer = await c.computers.get('vm-1');
      await expect(computer.windowAction('0x1', 'focus')).rejects.toThrow(
        /expected a window result/,
      );
    }
    // A null window WITH the key is the real close, and still decodes.
    const { client: ok } = client((call) =>
      /\/windows\/[^/]+$/.test(call.path)
        ? json({ ok: true, gone: true, window: null })
        : anyRoute(call),
    );
    const shut = await (await ok.computers.get('vm-1')).windowAction('0x1', 'close');
    expect([shut.window, shut.gone]).toEqual([undefined, true]);
  });

  it('lets a caller name the class every local refusal actually is', async () => {
    // The idiom `src/computer.ts` documents — `catch (e) { if (e instanceof
    // ValidationError) }` — was unwritable outside this package until
    // OPL-4176, because the class was not on the export list. `TypeError`
    // still catches it, which is what made the omission survivable and is why
    // exporting it breaks nothing.
    const { client: c } = client(anyRoute);
    const computer = await c.computers.get('vm-1');
    const err = await computer.readFile('relative/path').catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err).toBeInstanceOf(TypeError);
    expect(err).not.toBeInstanceOf(MandalaError);
  });

  it('refuses a window action that answered with nothing at all', async () => {
    // The floor, and only the floor: `window` is legitimately null on a close
    // and on an action the guest could not describe, so the guard is that a
    // BODY came back rather than that a window did.
    const { client: c } = client((call) =>
      /\/windows\/[^/]+$/.test(call.path) ? new Response(null, { status: 204 }) : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    await expect(computer.windowAction('0x1', 'focus')).rejects.toThrow(
      /expected a window result from POST/,
    );
  });

  /**
   * The two window routes, against the shapes the PLATFORM sends.
   *
   * Both were decoded wrongly and neither had ever worked against
   * app.mandala.computer — the listing was read as a bare array where the route
   * answers `{"windows":[...]}`, and an action as a bare window where it answers
   * `{"ok":true,"gone":false,"window":{...}}`. Every test passed throughout,
   * because `test/harness.ts` answered the shape the code expected. The
   * fixtures here are the live bodies (OPL-4176).
   */
  it('reads the windows out of the object the route answers with', async () => {
    const { client: c } = client(anyRoute);
    const computer = await c.computers.get('vm-1');
    const [w] = await computer.windows();
    expect(w).toMatchObject({
      id: '0x2a0002c',
      windowClass: 'firefox-esr',
      type: 'normal',
      x: 0,
      y: 51,
      focused: true,
      visible: true,
      pid: 1090,
    });
    // And the wire's own fields survive alongside the decoded ones, for
    // anything this SDK does not read.
    expect(w?.raw.class).toBe('firefox-esr');
  });

  it('separates a window with no pid from one whose pid is 0', async () => {
    // The daemon declares the field `PID *int` with `json:"pid,omitempty"`
    // precisely so these stay different things: a guest is free to advertise
    // `_NET_WM_PID` 0, and `num()` — 0 for an absent key — would report the
    // window that said nothing as owned by pid 0 and the one that said 0 as
    // indistinguishable from it.
    const bodies = [
      { ...WINDOW, pid: undefined },
      { ...WINDOW, pid: null },
      { ...WINDOW, pid: 0 },
      // Present and unreadable is not a pid either. A boolean is the one worth
      // pinning: `Number(true)` is 1, which would name a real process.
      { ...WINDOW, pid: true },
      { ...WINDOW, pid: [] },
      { ...WINDOW, pid: 'zsh' },
    ];
    const seen: (number | undefined)[] = [];
    for (const body of bodies) {
      const { client: c } = client((call) =>
        call.path.endsWith('/windows') ? json({ windows: [body] }) : anyRoute(call),
      );
      const [w] = await (await c.computers.get('vm-1')).windows();
      seen.push(w?.pid);
    }
    expect(seen).toEqual([undefined, undefined, 0, undefined, undefined, undefined]);
  });

  it('refuses a number that could not be a pid, rather than publishing it', async () => {
    // `count` is this file's general optional number and a pid is narrower: it
    // answers -5 for `-5` and 3.7 for `3.7`, and neither is a process on either
    // guest OS. The field is typed as a pid, so a caller is entitled to `kill`
    // what it finds there — which is why toBackgroundExec already draws this
    // line with `Number.isInteger` for the exec handle. Absent is a legitimate
    // answer here, so this refuses where that one throws.
    const bodies = [
      { ...WINDOW, pid: -5 },
      { ...WINDOW, pid: 3.7 },
      { ...WINDOW, pid: Number.NaN },
      // The decimal spellings a backend that stringifies its numbers really
      // sends ARE still read, which is the other half of the rule: the guard
      // must not tell such a host every pid it sends is unreadable.
      { ...WINDOW, pid: '1090' },
      { ...WINDOW, pid: 0 },
    ];
    const seen: (number | undefined)[] = [];
    for (const body of bodies) {
      const { client: c } = client((call) =>
        call.path.endsWith('/windows') ? json({ windows: [body] }) : anyRoute(call),
      );
      const [w] = await (await c.computers.get('vm-1')).windows();
      seen.push(w?.pid);
    }
    expect(seen).toEqual([undefined, undefined, undefined, 1090, 0]);
  });

  it('answers nothing for geometry it could not read, rather than the corner of the screen', async () => {
    // `num`'s fallback is 0, and 0 on these four fields is not a missing answer
    // but a place: the fixture beside this test has `x: 0` on a real window. So
    // a coordinate the wire did not carry came back indistinguishable from the
    // top-left corner, and the corner is where an agent then clicks.
    // `cursorPosition` refused exactly this and this decoder did not (OPL-4200).
    const bodies = [
      { ...WINDOW, x: undefined, y: null, width: [], height: '  ' },
      // The coercions `Number()` walks straight through. `Number([7])` is 7,
      // which is a coordinate this client invented rather than read (OPL-3850).
      { ...WINDOW, x: [7], y: {}, width: true, height: 'wide' },
    ];
    for (const body of bodies) {
      const { client: c } = client((call) =>
        call.path.endsWith('/windows') ? json({ windows: [body] }) : anyRoute(call),
      );
      const [w] = await (await c.computers.get('vm-1')).windows();
      expect([w?.x, w?.y, w?.width, w?.height]).toEqual([
        undefined,
        undefined,
        undefined,
        undefined,
      ]);
      // And the row is still a window: the identity half is what tells a
      // browser that failed to open from one that has not painted, and it is
      // readable whether or not the geometry was.
      expect(w?.id).toBe('0x2a0002c');
    }

    // A real 0 survives, which is the whole reason this is `count` and not a
    // truthiness test — the fixture's own `x` is one.
    const { client: real } = client(anyRoute);
    const [live] = await (await real.computers.get('vm-1')).windows();
    expect([live?.x, live?.y, live?.width, live?.height]).toEqual([0, 51, 1280, 749]);
  });

  it('refuses a listing carrying a window that names nothing', async () => {
    // `id` is the whole of what a listing is for — every window action takes it
    // — and `str()` answers `''` for one that is absent, null or unreadable.
    // That row is a window a caller can see and cannot touch, and it matches
    // nothing on the desktop. Dropping it instead would be the failure `buildId`
    // was written for: schema drift as a shorter inventory that looks complete.
    for (const bad of [
      { ...WINDOW, id: undefined },
      { ...WINDOW, id: null },
      { ...WINDOW, id: '' },
    ]) {
      const { client: c } = client((call) =>
        call.path.endsWith('/windows') ? json({ windows: [WINDOW, bad] }) : anyRoute(call),
      );
      const computer = await c.computers.get('vm-1');
      await expect(computer.windows()).rejects.toThrow(/answered a window with no id \(row 1 of 2/);
    }

    // The EVENT stream does not share the refusal: a frame is news rather than
    // an answer, and `toGuestWindow` runs inside a socket listener where a throw
    // ends the connection rather than one call.
    const { toGuestWindow } = await import('../src/models.js');
    expect(toGuestWindow({ title: 'x' }).id).toBe('');
  });

  it('reads an empty desktop as empty and a body with no windows key as broken', async () => {
    // `{"windows":[]}` is the platform's answer for a desktop with nothing on
    // it, so it must decode; `{}` is not a window list, and calling it "nothing
    // is open" is the coercion `clipboard()` refuses one method along.
    const empty = client((call) =>
      call.path.endsWith('/windows') ? json({ windows: [] }) : anyRoute(call),
    );
    expect(await (await empty.client.computers.get('vm-1')).windows()).toEqual([]);
    const broken = client((call) =>
      call.path.endsWith('/windows') ? json({ ok: true }) : anyRoute(call),
    );
    await expect((await broken.client.computers.get('vm-1')).windows()).rejects.toThrow(
      /expected a windows array/,
    );
  });

  it('reads `visible` off the wire, where `minimized` never was', async () => {
    // The daemon sends `visible` and has since the route shipped; there is no
    // `minimized` on this wire. Reading one meant every window on every desktop
    // came back not-minimised, including the minimised ones — and the daemon's
    // own comment says what that costs: "an agent that clicks at the
    // coordinates of one is clicking at whatever is actually there."
    const { client: c } = client((call) =>
      call.path.endsWith('/windows')
        ? json({ windows: [{ ...WINDOW, visible: false, minimized: true }] })
        : anyRoute(call),
    );
    const [w] = await (await c.computers.get('vm-1')).windows();
    expect(w?.visible).toBe(false);
    expect((w as unknown as { minimized?: boolean }).minimized).toBeUndefined();
  });

  it('believes `visible` and `focused` only where the wire said them', async () => {
    // TRUE only, and the polarity is the daemon's argument rather than a
    // convention: a window wrongly called minimised is one a caller skips, and
    // one wrongly called on-screen is a click landing somewhere nobody asked.
    // Unreadable is not a claim, so it reads as the harmless half.
    const { client: c } = client((call) =>
      call.path.endsWith('/windows')
        ? json({ windows: [{ ...WINDOW, visible: 'yes', focused: [] }] })
        : anyRoute(call),
    );
    const [w] = await (await c.computers.get('vm-1')).windows();
    expect([w?.visible, w?.focused]).toEqual([false, false]);

    // The spellings the wire really uses ARE read, which is the other half of
    // the same rule: a backend that encodes its booleans as strings or as 1/0
    // must not be told every flag it sends is unreadable.
    const spelled = client((call) =>
      call.path.endsWith('/windows')
        ? json({ windows: [{ ...WINDOW, visible: 'true', focused: 1 }] })
        : anyRoute(call),
    );
    const [t] = await (await spelled.client.computers.get('vm-1')).windows();
    expect([t?.visible, t?.focused]).toEqual([true, true]);
  });

  it('separates a window action that closed a window from one that could not describe it', async () => {
    // Two outcomes with no window to show, and `gone` is the only thing that
    // tells them apart. A decoder that returned the window alone could express
    // neither, and in fact threw on all three.
    const bodies = [
      { ok: true, gone: false, window: WINDOW },
      { ok: true, gone: true, window: null },
      { ok: true, gone: false, window: null },
    ];
    let n = 0;
    const { client: c } = client((call) =>
      /\/windows\/[^/]+$/.test(call.path) ? json(bodies[n++]) : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    const acted = await computer.windowAction('0x2a0002c', 'focus');
    expect(acted.window?.id).toBe('0x2a0002c');
    expect(acted.gone).toBe(false);

    const closed = await computer.windowAction('0x2a0002c', 'close');
    expect(closed.window).toBeUndefined();
    expect(closed.gone).toBe(true);

    const undescribed = await computer.windowAction('0x2a0002c', 'maximize');
    expect(undescribed.window).toBeUndefined();
    // NOT gone. An action that happened and could not be described is an
    // outcome, and reading it as a close would have a caller stop looking for a
    // window that is still on the screen.
    expect(undescribed.gone).toBe(false);
  });

  it('refuses an action that says the window is gone and describes it in the same body', async () => {
    // Two halves read by two different callers: one drives `result.window` and
    // keeps clicking at a window the body calls gone, the other branches on
    // `gone` and throws away a window the body describes. Both are correct
    // programs, so the disagreement has to be settled here rather than by
    // whichever field a caller happened to read (OPL-4200).
    const { client: c } = client((call) =>
      /\/windows\/[^/]+$/.test(call.path)
        ? json({ ok: true, gone: true, window: WINDOW })
        : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    await expect(computer.windowAction('0x2a0002c', 'close')).rejects.toThrow(
      /reports the window gone and describes window "0x2a0002c" in the same body/,
    );

    // Only a `gone` the wire SAID. Absent, null and unreadable are a host that
    // said nothing, not a contradiction — the same line `buildContradiction`
    // draws — so a body that carries a window and no verdict is the ordinary
    // successful action it looks like.
    const { windowContradiction, toWindowResult } = await import('../src/models.js');
    for (const gone of [undefined, null, 'maybe', false]) {
      expect(windowContradiction(toWindowResult({ ok: true, gone, window: WINDOW }))).toBe(null);
    }
    // And a close with no window to show is the shape the platform actually
    // sends, which must never be refused.
    expect(windowContradiction(toWindowResult({ ok: true, gone: true, window: null }))).toBe(null);
  });

  it('reads the clipboard, and refuses an answer with no text in it', async () => {
    // The empty string is a real clipboard and has to survive, so the guard is
    // on the TYPE rather than on truthiness. Coercing instead would turn a
    // malformed answer into the four-word clipboard "undefined" and paste it.
    const { rec, client: c } = client(anyRoute);
    const computer = await c.computers.get('vm-1');
    expect(await computer.clipboard()).toBe('on the clipboard');
    const read = rec.calls.at(-1)!;
    expect(read.method).toBe('GET');
    expect(read.path).toBe('/computers/vm-1/clipboard');

    for (const bad of [{}, { text: 42 }, { text: null }]) {
      const { client: c2 } = client((call) =>
        call.path.endsWith('/clipboard') ? json(bad) : anyRoute(call),
      );
      const c2vm = await c2.computers.get('vm-1');
      await expect(c2vm.clipboard()).rejects.toThrow(/expected clipboard text from GET/);
    }

    const { client: c3 } = client((call) =>
      call.path.endsWith('/clipboard') ? json({ text: '' }) : anyRoute(call),
    );
    expect(await (await c3.computers.get('vm-1')).clipboard()).toBe('');
  });

  it('writes the clipboard, and refuses locally what the platform would refuse', async () => {
    const { rec, client: c } = client(anyRoute);
    const computer = await c.computers.get('vm-1');
    await computer.setClipboard('hello');
    const wrote = rec.calls.at(-1)!;
    expect(wrote.method).toBe('PUT');
    expect(wrote.path).toBe('/computers/vm-1/clipboard');
    expect(wrote.body).toEqual({ text: 'hello' });

    // Asserted as no request AT ALL, the way the destructive-flag test above is:
    // a refusal that still sent the call would have spent the round trip it
    // exists to save. What each of these refusals is FOR is in building.test.ts.
    const before = rec.calls.length;
    for (const bad of ['', 'a\0b', '\ud800', '\udfff', 'x'.repeat(64 * 1024 + 1)]) {
      await expect(computer.setClipboard(bad)).rejects.toThrow(TypeError);
    }
    expect(rec.calls.length).toBe(before);
  });

  it('carries the platform word off a clipboard refusal, and stops the retry', async () => {
    // End to end, because the value of the word is that it survives the decode:
    // the platform sends `reason` beside `error` on a body this SDK otherwise
    // only reads a sentence out of (platform OPL-3898).
    const refuse = (reason: string) =>
      new Response(JSON.stringify({ error: 'this computer is not running', reason }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      });
    const { client: c } = client((call) =>
      call.path.endsWith('/clipboard') ? refuse('unavailable') : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    const err = await computer.clipboard().catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.reason).toBe('unavailable');
    // The message is untouched: it is the sentence for a person, and the word
    // is the part a program switches on.
    expect(err.message).toBe('this computer is not running');
    expect(isTransient(err)).toBe(false);

    const { client: c2 } = client((call) =>
      call.path.endsWith('/clipboard') ? refuse('contention') : anyRoute(call),
    );
    const busy = await (await c2.computers.get('vm-1')).setClipboard('x').catch((e) => e);
    expect(isTransient(busy)).toBe(true);
  });

  it('refuses a background exec with no pid, rather than a finished job on pid 0', async () => {
    const { client: c } = client((call) =>
      call.path.endsWith('/exec') ? json({}) : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    await expect(computer.execBackground('sleep 60')).rejects.toThrow(/pid/);
  });

  it('reads a missing `running` as still running, when nothing has exited', async () => {
    // False is the claim that the command is over, which is the finished-job
    // answer again by another route.
    const { client: c } = client((call) =>
      call.path.endsWith('/exec') ? json({ pid: 7 }) : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    expect((await computer.execBackground('sleep 60')).running).toBe(true);
  });

  it('also reads an empty exit code as no evidence that a background job exited', async () => {
    const { client: c } = client((call) =>
      call.path.endsWith('/exec') ? json({ pid: 7, exit_code: '' }) : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    expect((await computer.execBackground('sleep 60')).running).toBe(true);
  });

  it('refuses an empty schedule read rather than reporting midnight UTC', async () => {
    // `{}` decodes to "disabled, 00:00 UTC", which is indistinguishable from a
    // schedule this computer really has.
    const { client: c } = client((call) =>
      call.path.endsWith('/schedule') ? json({}) : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    await expect(computer.schedule()).rejects.toThrow(/expected a schedule from GET/);
  });

  it('echoes what was set when the platform acknowledges with no body', async () => {
    // It applied this and said so with a 2xx; decoding `{}` would answer with a
    // midnight nobody chose.
    const { client: c } = client((call) =>
      call.path.endsWith('/schedule') ? new Response(null, { status: 204 }) : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    const set = await computer.setSchedule({ enabled: true, hour: 23, minute: 30, tz: 'UTC' });
    expect(set).toMatchObject({ enabled: true, hour: 23, minute: 30, tz: 'UTC' });
    // A cleared schedule is the one place an empty body is a real answer.
    expect(await computer.clearSchedule()).toMatchObject({ enabled: false });
  });

  it('also treats a 200 empty object as an acknowledgement of the schedule body', async () => {
    const { client: c } = client((call) =>
      call.path.endsWith('/schedule') ? json({}) : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    await expect(
      computer.setSchedule({ enabled: true, hour: 23, minute: 30, tz: 'UTC' }),
    ).resolves.toMatchObject({ enabled: true, hour: 23, minute: 30, tz: 'UTC' });
  });
});

describe('the pointer', () => {
  it('says nobody knows where the pointer is, rather than guessing the corner', async () => {
    // The coordinates are present and zero when `known` is false, which is
    // indistinguishable from the corner of the screen.
    const { client: c } = client((call) =>
      call.path.endsWith('/input') ? json({ known: false, x: 0, y: 0 }) : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    expect(await computer.cursorPosition()).toBeUndefined();
  });

  it('reports a known position', async () => {
    const { client: c } = client((call) =>
      call.path.endsWith('/input') ? json({ known: true, x: 12, y: 34 }) : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    expect(await computer.cursorPosition()).toEqual({ x: 12, y: 34 });
  });

  it('answers unknown when a known position contains malformed coordinates', async () => {
    // Not NaN, and no longer `{x: 0, y: 0}` either. Zero is the corner of the
    // screen, which is the one answer this method exists to avoid inventing —
    // reaching it through the coordinate rather than through `known` is the same
    // wrong answer past the check written to prevent it (Codex review,
    // OPL-3850). The Python SDK refuses the same payload.
    const { client: c } = client((call) =>
      call.path.endsWith('/input') ? json({ known: true, x: 'left', y: {} }) : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    expect(await computer.cursorPosition()).toBeUndefined();
  });
});

describe('exec', () => {
  it('returns a non-zero exit rather than throwing it', async () => {
    const { client: c } = client((call) =>
      call.path.endsWith('/exec')
        ? json({ exit_code: 1, stdout: '', stderr: 'no such file', timed_out: false })
        : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    const res = await computer.exec('cat missing');
    expect(res.ok).toBe(false);
    expect(res.exitCode).toBe(1);
  });

  it('separates "it succeeded" from "the output is all of it"', async () => {
    // A command that succeeded and produced more than the guest agent would
    // carry is still a command that succeeded.
    const { client: c } = client((call) =>
      call.path.endsWith('/exec') ? json({ ...EXEC_OK, out_truncated: true }) : anyRoute(call),
    );
    const res = await (await c.computers.get('vm-1')).exec('cat huge');
    expect(res.ok).toBe(true);
    expect(res.truncated).toBe(true);
  });

  it('detaches the browser launch so open() returns in under a second', async () => {
    const { rec, client: c } = client(anyRoute);
    await (await c.computers.get('vm-1')).open('https://example.com');
    const body = rec.last().body as { command: string; session: string };
    expect(body.session).toBe('desktop');
    expect(body.command).toMatch(/^nohup firefox .* >\/dev\/null 2>&1 &$/);
  });

  it('does not report ok for an exec answer that named no exit code', async () => {
    // An empty or malformed response is not evidence the command succeeded,
    // and ok must not affirm what the platform never said.
    const { client: c } = client((call) =>
      call.path.endsWith('/exec') ? json({}) : anyRoute(call),
    );
    const res = await (await c.computers.get('vm-1')).exec('true');
    expect(res.ok).toBe(false);
  });

  it('does not read a null or empty exit code as success either', async () => {
    // An API that always emits every key spells "no exit code" as null, and
    // Number(null) is exactly the 0 that ok must not invent.
    for (const spelling of [null, '']) {
      const { client: c } = client((call) =>
        call.path.endsWith('/exec')
          ? json({ exit_code: spelling, stdout: '', stderr: '', timed_out: false })
          : anyRoute(call),
      );
      const res = await (await c.computers.get('vm-1')).exec('true');
      expect(res.exitCode).toBe(-1);
      expect(res.ok).toBe(false);
    }
  });

  it('reports a proxy giving up as more than a bare status', async () => {
    // Cloudflare content-negotiates its error page, and every request from this
    // client asks for JSON, so the 524 arrives with an EMPTY body — which left
    // err.message as the bare string 'HTTP 524': no cause, no way out.
    const { client: c } = client((call) =>
      call.path.endsWith('/exec') ? new Response('', { status: 524 }) : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    const err = await computer.exec('sleep 130', { timeoutS: 300 }).catch((e) => e);
    expect(err).toBeInstanceOf(GatewayTimeoutError);
    expect(err.status).toBe(524);
    expect(err.message).toMatch(/proxy/);
    expect(err.message).toMatch(/outlived the request/);
    expect(err.message).toMatch(/execBackground\(\)/);
  });

  it('discards the proxy error page rather than truncating it into the message', async () => {
    const { client: c } = client((call) =>
      call.path.endsWith('/exec')
        ? new Response('<!DOCTYPE html><html><body>error code: 524</body></html>', {
            status: 524,
            headers: { 'content-type': 'text/html' },
          })
        : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    const err = await computer.exec('sleep 130').catch((e) => e);
    expect(err.message).not.toMatch(/DOCTYPE/);
  });

  it('does not offer a proxy timeout to the retry loops', async () => {
    // Retrying reproduces it at the same place, because the hop that gave up
    // never saw how long the caller asked to wait.
    const { client: c } = client((call) =>
      call.path.endsWith('/exec') ? new Response('', { status: 524 }) : anyRoute(call),
    );
    const err = await (await c.computers.get('vm-1')).exec('sleep 130').catch((e) => e);
    expect(isTransient(err)).toBe(false);
  });

  it('keeps a structured message rather than overwriting it', async () => {
    // The substitution is for a body that said nothing, not for every 504. A
    // gateway status can be raised by any proxy in the chain, and one that
    // speaks JSON has said something more specific than this client can.
    const { client: c } = client((call) =>
      call.path.endsWith('/exec')
        ? errorJson(504, 'upstream unavailable before dispatch')
        : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    const err = await computer.exec('make').catch((e) => e);
    expect(err).toBeInstanceOf(GatewayTimeoutError);
    expect(err.message).toBe('upstream unavailable before dispatch');
  });

  it('does not promise a surviving command to a read', async () => {
    // A GET started nothing, so the wording must not claim otherwise.
    const { client: c } = client(() => new Response('', { status: 524 }));
    const err = await c.computers.get('vm-1').catch((e) => e);
    expect(err).toBeInstanceOf(GatewayTimeoutError);
    expect(err.message).toMatch(/Nothing was cancelled/);
    expect(err.message).toMatch(/Most often/);
    expect(err.message).not.toMatch(/whatever this request started is still running/);
  });

  it('tells an origin that was never reached apart from one that stopped answering', async () => {
    // Opposite implications for whether the work survived: a 524 means the
    // request arrived and is still being worked on, a 522 means it never
    // arrived, so nothing was started and nothing outlives anything.
    const { client: c } = client(() => new Response('', { status: 522 }));
    const err = await c.computers.get('vm-1').catch((e) => e);
    expect(err).toBeInstanceOf(OriginUnreachableError);
    expect(err).not.toBeInstanceOf(GatewayTimeoutError);
    expect(err.message).toMatch(/never sent/);
    expect(err.message).toMatch(/clears on its own/);
  });

  it('does not tell a 520 that its work never happened', async () => {
    // Cloudflare returns 520 when the origin DID receive the request and
    // answered unreadably. Filed with the unreachable statuses it inherited
    // "the request never arrived, so nothing was started" — said about a create
    // that may have just made a billable computer.
    const { client: c } = client(() => new Response('', { status: 520 }));
    const err = await c.computers.create({ template: 'base' }).catch((e) => e);
    expect(err).toBeInstanceOf(OriginResponseError);
    expect(err).not.toBeInstanceOf(OriginUnreachableError);
    expect(err.message).not.toMatch(/never arrived/);
    expect(err.message).toMatch(/did arrive/);
    expect(err.message).toMatch(/creates something/);
  });

  it('keeps a 520 body the platform may itself have written', async () => {
    const { client: c } = client(() => errorJson(520, 'the hypervisor closed the connection'));
    const err = await c.computers.get('vm-1').catch((e) => e);
    expect(err.message).toBe('the hypervisor closed the connection');
  });

  it('does not tell a bad certificate to wait it out', async () => {
    // Its own class, not the unreachable one it used to share: an origin that is
    // down is a passing outage, a certificate is a deployment somebody must fix,
    // and a caller asking whether to try again needs opposite answers.
    const { client: c } = client(() => new Response('', { status: 526 }));
    const err = await c.computers.get('vm-1').catch((e) => e);
    expect(err).toBeInstanceOf(OriginTLSError);
    expect(err).not.toBeInstanceOf(OriginUnreachableError);
    expect(err.message).toMatch(/TLS handshake/);
    expect(err.message).toMatch(/report it rather than waiting it out/);
  });

  it('leaves the retry policy exactly where it was', async () => {
    // Naming these statuses is not the same decision as retrying them, and this
    // SDK decides transience by class. Changing that belongs in its own change.
    const { client: c } = client(() => new Response('', { status: 522 }));
    const err = await c.computers.get('vm-1').catch((e) => e);
    expect(isTransient(err)).toBe(false);
  });

  it('says which status a substituted message stands in for', async () => {
    // Four classes, eight statuses, three of them sharing one sentence.
    // Explaining the failure in prose took the number out of err.message, which
    // the bare `HTTP 522` at least had.
    for (const status of [504, 520, 522, 526]) {
      const { client: c } = client(() => new Response('', { status }));
      const err = await c.computers.get('vm-1').catch((e) => e);
      expect(err.message).toMatch(new RegExp(`\\(HTTP ${status}\\)$`));
    }
  });

  it('does not stamp a status onto a message the platform wrote', async () => {
    // Its message is its own sentence and err.status already carries the number.
    const { client: c } = client(() => errorJson(504, 'upstream unavailable before dispatch'));
    const err = await c.computers.get('vm-1').catch((e) => e);
    expect(err.message).toBe('upstream unavailable before dispatch');
  });

  it("reads the edge's structured body rather than printing it", async () => {
    // Cloudflare answers Accept: application/json — every request from this
    // client — with RFC 9457 for the 5xx it generates, including the 500 and
    // 502 this SDK has no wording of its own for. Unread, the one readable
    // sentence arrives buried in 500 characters of raw JSON.
    const { client: c } = client(() => cloudflareJson(502));
    const err = await c.computers.get('vm-1').catch((e) => e);
    expect(err.message).toBe('The origin server returned an invalid response.');
    expect(err.message).not.toMatch(/[{}"]/);
    // The Ray ID support asks for survives on the body, as with the HTML page.
    expect((err.body as { ray_id?: string }).ray_id).toBe('8f2a1c0d9e4b7a31');
  });

  it("does not let the edge's own account displace advice it could not have", async () => {
    // The counterpart, and the reason `detail` is read but not deferred to. A
    // proxy cannot know the request under it was a foreground exec with a
    // ceiling over it, so its accurate sentence about itself is the one thing a
    // caller cannot act on. Reading the body must not cost the substitution.
    const { client: c } = client((call) =>
      call.path.endsWith('/exec') ? cloudflareJson(524) : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    const err = await computer.exec('sleep 130').catch((e) => e);
    expect(err).toBeInstanceOf(GatewayTimeoutError);
    expect(err.message).toMatch(/execBackground/);
    expect(err.message).not.toBe('The origin server returned an invalid response.');
  });

  it('keeps the edge error page on the error even though it never shows it', async () => {
    // The Ray ID support asks for is in that HTML and nowhere else.
    // Kept whole: on a real edge page it is in the footer, past the 500
    // characters the message is cut to.
    const page = `<html><body>${'padding '.repeat(200)}error code: 522 Ray ID: 8f2a1c</body></html>`;
    const { client: c } = client(
      () => new Response(page, { status: 522, headers: { 'content-type': 'text/html' } }),
    );
    const err = await c.computers.get('vm-1').catch((e) => e);
    expect(err.message).not.toMatch(/Ray ID/);
    expect(String(err.body)).toMatch(/8f2a1c/);
  });

  it('leaves the OS to the platform rather than refusing a guest it only half knows', async () => {
    // This SDK held an `os === 'windows'` guard until OPL-4202, and it survived
    // that review for one reason only: the platform answered "not running"
    // ahead of the Windows refusal, so a stopped Windows computer was told to
    // start and refused once it had. Platform OPL-4208 hoisted that refusal
    // above the running check, which retired the guard.
    //
    // Both rows go to the platform now — Windows because it answers better
    // than this object can, and an absent `os` because a payload that lost the
    // field says nothing about the guest, and refusing on it would have failed
    // a Linux computer for a command it could have run.
    for (const os of ['windows', undefined]) {
      const { rec, client: c } = client((call) =>
        call.path === '/computers/vm-1' && call.method === 'GET'
          ? json({ ...COMPUTER, os })
          : anyRoute(call),
      );
      const computer = await c.computers.get('vm-1');
      expect(computer.os).toBe(os ?? '');
      await computer.open('https://example.com');
      expect(rec.last().path).toBe('/computers/vm-1/exec');
      expect((rec.last().body as { session: string }).session).toBe('desktop');
    }
  });

  it('surfaces the platform refusal of a desktop session on Windows as settled', async () => {
    // What the caller gets instead of the old local throw. `unsupported` is
    // the word the hoisted refusal carries, and isTransient reading it as
    // permanent is the whole reason deleting the guard costs a retry loop
    // nothing: it stops here rather than starting the computer and asking
    // again for a fact that was true before it started.
    const { client: c } = client((call) =>
      call.path === '/computers/vm-1/exec'
        ? json(
            {
              error: 'session "desktop" is not supported on Windows guests yet',
              reason: 'unsupported',
            },
            { status: 409 },
          )
        : json({ ...COMPUTER, os: 'windows' }),
    );
    const computer = await c.computers.get('vm-1');
    const err = await computer.open('https://example.com').catch((e) => e);
    expect(err).toBeInstanceOf(APIError);
    expect((err as APIError).reason).toBe('unsupported');
    expect(isTransient(err)).toBe(false);
  });
});

describe('files', () => {
  it('writes a string as UTF-8 and reports what landed', async () => {
    const { rec, client: c } = client(anyRoute);
    const written = await (await c.computers.get('vm-1')).writeFile('/tmp/a.txt', 'hello');
    expect(rec.last().raw && new TextDecoder().decode(rec.last().raw)).toBe('hello');
    expect(rec.last().query.path).toBe('/tmp/a.txt');
    expect(written).toBe(5);
  });

  it('reads bytes back, and text on request', async () => {
    const { client: c } = client(anyRoute);
    const computer = await c.computers.get('vm-1');
    expect(await computer.readTextFile('/tmp/a.txt')).toBe('file');
  });

  it('refuses a text read of bytes that are not UTF-8', async () => {
    const { client: c } = client((call) =>
      call.path.endsWith('/files')
        ? new Response(Uint8Array.from([0xff, 0xfe]), { status: 200 })
        : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    await expect(computer.readTextFile('/tmp/a.bin')).rejects.toThrow(/not valid UTF-8/);
  });

  it('streams an upload instead of holding the whole file as one Buffer', async () => {
    const { rec, client: c } = client(anyRoute);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('hello'));
        controller.close();
      },
    });
    const written = await (await c.computers.get('vm-1')).writeFile('/tmp/a.txt', stream, {
      contentLength: 5,
    });
    expect(rec.last().raw && new TextDecoder().decode(rec.last().raw)).toBe('hello');
    expect(rec.last().headers['Content-Length']).toBe('5');
    expect(written).toBe(5);
  });

  it('refuses a contentLength that is not a whole number of bytes', async () => {
    // String(NaN) is "NaN"; Node fetch then reports a connection failure, and a
    // custom fetch would send the malformed header. Same class of mistake as a
    // fractional chunkBytes — refused here, before a PUT goes out.
    const { rec, client: c } = client(anyRoute);
    const computer = await c.computers.get('vm-1');
    await expect(computer.writeFile('/tmp/a.txt', 'hello', { contentLength: -1 })).rejects.toThrow(
      /contentLength/,
    );
    await expect(computer.writeFile('/tmp/a.txt', 'hello', { contentLength: 1.5 })).rejects.toThrow(
      /contentLength/,
    );
    await expect(
      computer.writeFile('/tmp/a.txt', 'hello', { contentLength: Number.NaN }),
    ).rejects.toThrow(/contentLength/);
    await expect(
      computer.writeFile('/tmp/a.txt', 'hello', { contentLength: Number.MAX_SAFE_INTEGER + 1 }),
    ).rejects.toThrow(/contentLength/);
    expect(rec.calls.filter((call) => call.method === 'PUT')).toEqual([]);
  });

  it('refuses a contentLength that contradicts a body it can measure', async () => {
    // undici frames the request with the CALLER's number, so an under-declared
    // length is not a header nobody believes — it is a shorter request. The
    // control plane streams this route and passes the declaration on, so the
    // guest gets a prefix of the file and the write answers 200 with a matching
    // count: truncation reported as success. Free to catch, since the body is
    // already in hand and the only body whose length is not is a stream.
    const { rec, client: c } = client(anyRoute);
    const computer = await c.computers.get('vm-1');
    await expect(computer.writeFile('/tmp/a.txt', 'hello', { contentLength: 3 })).rejects.toThrow(
      /contentLength is 3 but the data is 5 bytes/,
    );
    await expect(
      computer.writeFile('/tmp/a.bin', new Uint8Array(20), { contentLength: 40 }),
    ).rejects.toThrow(/contentLength is 40 but the data is 20 bytes/);
    // A string is measured as its UTF-8 bytes, which is how it goes on the
    // wire — counting characters would refuse every correct non-ASCII write.
    await expect(computer.writeFile('/tmp/a.txt', 'é', { contentLength: 1 })).rejects.toThrow(
      /contentLength is 1 but the data is 2 bytes/,
    );
    expect(rec.calls.filter((call) => call.method === 'PUT')).toEqual([]);
    // Agreeing is still accepted, so nothing that was correct has to change.
    expect(await computer.writeFile('/tmp/a.txt', 'hello', { contentLength: 5 })).toBe(5);
    expect(rec.last().headers['Content-Length']).toBe('5');
  });

  it('measures a body by its size, not by which realm built it', async () => {
    // Two questions turn on one answer, and they fail in opposite directions.
    // `.length` alone calls an `ArrayBuffer` and a `Blob` unmeasurable — undici
    // sends both with a size it counts itself, so a caller's short declaration
    // would be framed against bytes nobody checked and the guest file would be
    // truncated under a 200. An `instanceof ReadableStream` alone calls a
    // foreign stream measurable, compares its length to `undefined` and refuses
    // a write that would have worked. `byteLength` or `size` answers both.
    const { rec, client: c } = client(anyRoute);
    const computer = await c.computers.get('vm-1');
    const twenty = new Uint8Array(20);
    await expect(
      computer.writeFile('/tmp/a.bin', twenty.buffer as unknown as Uint8Array, {
        contentLength: 5,
      }),
    ).rejects.toThrow(/contentLength is 5 but the data is 20 bytes/);
    await expect(
      computer.writeFile('/tmp/a.bin', new DataView(twenty.buffer) as unknown as Uint8Array, {
        contentLength: 5,
      }),
    ).rejects.toThrow(/contentLength is 5 but the data is 20 bytes/);
    await expect(
      computer.writeFile('/tmp/a.bin', new Blob([twenty]) as unknown as Uint8Array, {
        contentLength: 5,
      }),
    ).rejects.toThrow(/contentLength is 5 but the data is 20 bytes/);
    expect(rec.calls.filter((call) => call.method === 'PUT')).toEqual([]);
    // A stream this realm did not build has no size to read, so its caller's
    // number is the only one there is and it goes out untouched.
    await expect(
      computer.writeFile('/tmp/a.bin', foreignStream(), { contentLength: 20 }),
    ).resolves.toBeDefined();
    expect(rec.last().headers['Content-Length']).toBe('20');
  });

  it('marks a body it cannot measure half-duplex, whatever built it', async () => {
    // undici refuses a body it cannot measure unless the request says
    // `duplex: 'half'`, and for a shape it reads as neither stream nor bytes it
    // does something worse than refuse — it stringifies the object to
    // `[object Object]` and frames THAT against the caller's Content-Length.
    // Asked as `instanceof ReadableStream`, every stream from another realm
    // lands in one of those two. This stand-in fetch consumes whatever it is
    // handed and enforces neither rule, so what the request asked for is all a
    // test here can see; the rule itself is undici's and is exercised by
    // `mandala scp`.
    const { rec, client: c } = client(anyRoute);
    const computer = await c.computers.get('vm-1');
    await computer.writeFile('/tmp/a.bin', foreignStream(), { contentLength: 20 });
    expect(rec.last().duplex).toBe('half');
    await computer.writeFile('/tmp/a.bin', bodyStream('hello'), { contentLength: 5 });
    expect(rec.last().duplex).toBe('half');
    // A measurable body must not carry it: undici works the length out itself,
    // and a custom fetch handed a duplex it never needed is being told
    // something about the request that is not true of it.
    await computer.writeFile('/tmp/a.bin', new Uint8Array(20), { contentLength: 20 });
    expect(rec.last().duplex).toBeUndefined();
    await computer.writeFile('/tmp/a.txt', 'hello');
    expect(rec.last().duplex).toBeUndefined();
    // Nor a JSON body, which is a string and never went near this.
    await computer.click(1, 2);
    expect(rec.last().duplex).toBeUndefined();
  });
});

/** A stream of `text`, the shape a caller in this realm would build. */
function bodyStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

/**
 * A stream this realm did not build: a polyfill, another realm's, or the Node
 * `Readable` undici accepts from an untyped caller. None is an instance of this
 * realm's `ReadableStream` and none has a size.
 */
function foreignStream(): ReadableStream<Uint8Array> {
  return {
    pipe: () => {},
    on: () => {},
    read: () => null,
    [Symbol.asyncIterator]: async function* () {
      yield new TextEncoder().encode('x'.repeat(20));
    },
  } as unknown as ReadableStream<Uint8Array>;
}

/** `n` bytes whose value at every position says which position it is. */
const filled = (n: number): Uint8Array => Uint8Array.from({ length: n }, (_, i) => i % 251);

const computerOn = async (respond: Responder) => {
  const { rec, client: c } = client(respond);
  return { rec, computer: await c.computers.get('vm-1') };
};

/** Every `Range` header a sequence of calls carried, in order. */
const rangesOf = (rec: ReturnType<typeof recorder>): (string | undefined)[] =>
  rec.calls.filter((call) => call.path.endsWith('/files')).map((call) => call.headers.Range);

describe('ranged reads', () => {
  it('asks for a window as bytes= and says where the answer landed', async () => {
    const { rec, computer } = await computerOn(guestFile(filled(1000)));
    const part = await computer.readFilePart('/tmp/big.bin', { offset: 100, length: 50 });
    expect(rangesOf(rec)).toEqual(['bytes=100-149']);
    expect(part).toMatchObject({ offset: 100, total: 1000, partial: true, seekable: true });
    expect(part.bytes).toEqual(filled(1000).slice(100, 150));
  });

  it('keeps the END of a tail that is longer than one request moves', async () => {
    // The trimming rule, and the one worth a test of its own: `bytes=-N` is
    // anchored at the end, so an over-long tail comes back as the tail of the
    // file rather than as the middle of it. A helper that re-derived the offset
    // itself would undo exactly this.
    const { rec, computer } = await computerOn(guestFile(filled(1000), { max: 100 }));
    const part = await computer.readFilePart('/tmp/big.bin', { offset: -400 });
    expect(rangesOf(rec)).toEqual(['bytes=-400']);
    expect(part.offset).toBe(900);
    expect(part.bytes).toEqual(filled(1000).slice(900));
  });

  it('reports fewer bytes than were asked for as the window they actually are', async () => {
    const { computer } = await computerOn(guestFile(filled(1000), { max: 64 }));
    const part = await computer.readFilePart('/tmp/big.bin', { offset: 10, length: 500 });
    expect(part.bytes).toHaveLength(64);
    expect(part).toMatchObject({ offset: 10, total: 1000 });
  });

  it('reads a whole file as one window when no range is asked for', async () => {
    const { rec, computer } = await computerOn(guestFile(filled(10)));
    const part = await computer.readFilePart('/tmp/small.bin');
    expect(rangesOf(rec)).toEqual([undefined]);
    expect(part).toMatchObject({ offset: 0, total: 10, partial: false, seekable: true });
  });

  it('marks a file no range can be served out of, rather than promising a total', async () => {
    // /proc: the guest cannot report a length, so the range is ignored and the
    // whole thing arrives with a 200. The status is how a caller tells.
    const { computer } = await computerOn(guestFile(filled(8), { measurable: false }));
    const part = await computer.readFilePart('/proc/cpuinfo', { offset: 0, length: 4 });
    expect(part).toMatchObject({ offset: 0, partial: false, seekable: false });
    expect(part.bytes).toHaveLength(8);
    // No total, and not the eight bytes that happened to arrive. The platform
    // declines to promise a length here because the next read is a different
    // one, and inventing it from the body would be this SDK asserting what the
    // platform refused to.
    expect(part.total).toBeUndefined();
  });

  it('refuses a 206 whose Content-Range did not survive the trip', async () => {
    // These bytes are somewhere in the file and nothing left says where.
    // Assuming zero would write them over the file's first bytes and say
    // nothing — the silent corruption the status exists to prevent.
    const { computer } = await computerOn((call) => {
      if (!call.path.endsWith('/files')) return anyRoute(call);
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 206,
        headers: { 'content-type': 'application/octet-stream', 'accept-ranges': 'bytes' },
      });
    });
    await expect(computer.readFilePart('/tmp/big.bin', { offset: 100 })).rejects.toThrow(
      /206 .* without a readable Content-Range/,
    );
  });

  it('refuses a 206 whose body does not fill the window it names', async () => {
    // The header and the body are two statements of one fact. An empty body
    // reads to the paging loop as the end of the file — `scp` then reports 0
    // bytes and exits 0 — and a body longer than its window carries the offset
    // past the total and ends the loop as a complete file with extra bytes in
    // it. Both are silent, so neither is allowed through.
    const window206 =
      (body: Uint8Array, contentRange: string): Responder =>
      (call) => {
        if (!call.path.endsWith('/files')) return anyRoute(call);
        return new Response(body, {
          status: 206,
          headers: {
            'content-type': 'application/octet-stream',
            'accept-ranges': 'bytes',
            'content-range': contentRange,
          },
        });
      };
    const short = await computerOn(window206(new Uint8Array(0), 'bytes 0-9/100'));
    await expect(short.computer.readFilePart('/tmp/a.bin', { offset: 0 })).rejects.toThrow(
      /0 bytes for a Content-Range naming 10/,
    );
    const long = await computerOn(window206(filled(20), 'bytes 0-9/100'));
    await expect(long.computer.readFilePart('/tmp/a.bin', { offset: 0 })).rejects.toThrow(
      /20 bytes for a Content-Range naming 10/,
    );
  });

  it('carries the file real length on a range that named no byte it has', async () => {
    const { computer } = await computerOn(guestFile(filled(1000)));
    const err = await computer.readFilePart('/tmp/big.bin', { offset: 5000 }).catch((e) => e);
    expect(err).toBeInstanceOf(RangeNotSatisfiableError);
    expect(err.status).toBe(416);
    expect(err.total).toBe(1000);
  });

  it('names the methods that page, on the refusal that is where you find out', async () => {
    // The platform's message names the `Range` header, which is the right
    // sentence for its own curl example and useless to somebody holding this
    // SDK. Both halves survive: the size and ceiling are the platform's, the
    // way out is ours.
    const { computer } = await computerOn(guestFile(filled(1000), { max: 100 }));
    for (const read of [
      () => computer.readFile('/tmp/big.bin'),
      // The same whole-file read through the other door. readFilePart with no
      // window earns the identical refusal and used to get none of the help.
      () => computer.readFilePart('/tmp/big.bin'),
    ]) {
      const err = await read().catch((e) => e);
      expect(err).toBeInstanceOf(TooLargeError);
      expect(err.message).toMatch(/that file is 1000 bytes/);
      expect(err.message).toMatch(/readFileChunks\(path\)/);
    }
  });

  it('leaves the platform to speak for a 413 that a window earned', async () => {
    // The rewrite says "ask for part of it", which is only an answer where no
    // part was asked for. The platform applies the ceiling to the file when
    // there is no range and to the window when there is, so this cannot happen
    // against it — and where the SDK cannot know better it says nothing.
    const { computer } = await computerOn((call) =>
      call.path.endsWith('/files') ? errorJson(413, 'that window is too large') : anyRoute(call),
    );
    const err = await computer
      .readFilePart('/tmp/big.bin', { offset: 0, length: 500 })
      .catch((e) => e);
    expect(err).toBeInstanceOf(TooLargeError);
    expect(err.message).toBe('that window is too large');
  });
});

describe('paging a file bigger than one request', () => {
  const rebuilt = async (chunks: AsyncIterable<{ bytes: Uint8Array }>): Promise<Uint8Array> => {
    const out: number[] = [];
    for await (const chunk of chunks) out.push(...chunk.bytes);
    return new Uint8Array(out);
  };

  it('reconstructs a file that no single request could move', async () => {
    const contents = filled(1000);
    const { rec, computer } = await computerOn(guestFile(contents, { max: 300 }));
    expect(await rebuilt(computer.readFileChunks('/tmp/big.bin'))).toEqual(contents);
    expect(rangesOf(rec)).toEqual(['bytes=0-', 'bytes=300-', 'bytes=600-', 'bytes=900-']);
  });

  it('stops at the end rather than walking off it into a 416', async () => {
    // The last window ends exactly on the file's length, and the total off the
    // Content-Range is the only thing that says so.
    const { rec, computer } = await computerOn(guestFile(filled(600), { max: 300 }));
    expect(await rebuilt(computer.readFileChunks('/tmp/big.bin'))).toHaveLength(600);
    expect(rangesOf(rec)).toHaveLength(2);
  });

  it.each([
    ['shrinks', 600],
    ['grows', 1300],
  ])('rejects a source that %s between pages', async (_change, changedTotal) => {
    let page = 0;
    const { rec, computer } = await computerOn((call) => {
      if (!call.path.endsWith('/files')) return anyRoute(call);
      const offset = page === 0 ? 0 : 300;
      const total = page++ === 0 ? 1000 : changedTotal;
      return new Response(filled(300), {
        status: 206,
        headers: {
          'content-type': 'application/octet-stream',
          'accept-ranges': 'bytes',
          'content-range': `bytes ${offset}-${offset + 299}/${total}`,
        },
      });
    });
    const chunks: FileChunk[] = [];

    await expect(
      (async () => {
        for await (const chunk of computer.readFileChunks('/tmp/changing.bin')) {
          chunks.push(chunk);
        }
      })(),
    ).rejects.toThrow(new RegExp(`changed from 1000 to ${changedTotal}`));
    expect(chunks).toHaveLength(1);
    expect(rangesOf(rec)).toEqual(['bytes=0-', 'bytes=300-']);
  });

  it('holds no more than chunkBytes at a time when asked to', async () => {
    const { rec, computer } = await computerOn(guestFile(filled(1000)));
    const sizes: number[] = [];
    for await (const chunk of computer.readFileChunks('/tmp/big.bin', { chunkBytes: 400 })) {
      sizes.push(chunk.bytes.length);
    }
    expect(sizes).toEqual([400, 400, 200]);
    expect(rangesOf(rec)).toEqual(['bytes=0-399', 'bytes=400-799', 'bytes=800-1199']);
  });

  it('pages a window rather than the whole file when given one', async () => {
    const { rec, computer } = await computerOn(guestFile(filled(1000), { max: 100 }));
    const got = await rebuilt(
      computer.readFileChunks('/tmp/big.bin', { offset: 250, length: 250 }),
    );
    expect(got).toEqual(filled(1000).slice(250, 500));
    expect(rangesOf(rec)).toEqual(['bytes=250-499', 'bytes=350-499', 'bytes=450-499']);
  });

  it('pages a tail forwards from where the tail actually starts', async () => {
    // One byte to learn the length, and then an ordinary forward read. Asking
    // for `bytes=-N` and paging on from it would deliver the file's LAST chunk
    // first and the rest of the tail backwards after it.
    const { rec, computer } = await computerOn(guestFile(filled(1000), { max: 100 }));
    const got = await rebuilt(computer.readFileChunks('/tmp/big.bin', { offset: -250 }));
    expect(got).toEqual(filled(1000).slice(750));
    expect(rangesOf(rec)).toEqual(['bytes=-1', 'bytes=750-999', 'bytes=850-999', 'bytes=950-999']);
  });

  it('gives a tail longer than the file the whole file, in order', async () => {
    const { computer } = await computerOn(guestFile(filled(50), { max: 20 }));
    expect(await rebuilt(computer.readFileChunks('/tmp/big.bin', { offset: -900 }))).toEqual(
      filled(50),
    );
  });

  it('yields nothing for an empty file rather than raising its refusal', async () => {
    // An empty file has no byte for a range to name, so every one of them is a
    // 416. Nothing to page is not a failure — but only on the first request:
    // further along it would mean the file shrank under the read.
    const { computer } = await computerOn(guestFile(filled(0)));
    const chunks: FileChunk[] = [];
    for await (const chunk of computer.readFileChunks('/tmp/empty.bin')) chunks.push(chunk);
    expect(chunks).toEqual([]);
    const tail: FileChunk[] = [];
    for await (const chunk of computer.readFileChunks('/tmp/empty.bin', { offset: -10 })) {
      tail.push(chunk);
    }
    expect(tail).toEqual([]);
  });

  it('yields a file no range can be served out of exactly once', async () => {
    const { rec, computer } = await computerOn(guestFile(filled(8), { measurable: false }));
    const chunks: FileChunk[] = [];
    for await (const chunk of computer.readFileChunks('/proc/cpuinfo')) chunks.push(chunk);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ partial: false, seekable: false });
    expect(rangesOf(rec)).toEqual(['bytes=0-']);
  });

  it('refuses to go on from an answer that is not where it asked', async () => {
    // A hop that rewrites the window would otherwise be reassembled into a file
    // whose bytes are in the wrong places, with nothing saying so.
    const { computer } = await computerOn((call) => {
      if (!call.path.endsWith('/files')) return anyRoute(call);
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 206,
        headers: {
          'content-type': 'application/octet-stream',
          'accept-ranges': 'bytes',
          'content-range': 'bytes 40-42/900',
        },
      });
    });
    const chunks: FileChunk[] = [];
    await expect(
      (async () => {
        for await (const chunk of computer.readFileChunks('/tmp/big.bin')) chunks.push(chunk);
      })(),
    ).rejects.toThrow(/was answered from 40/);
    // The first window was where it asked; it is the second that contradicts.
    expect(chunks).toHaveLength(0);
  });

  it('refuses a 206 with no total rather than handing back a short file', async () => {
    // Stopping would be silent truncation and asking on would walk into a 416.
    // This platform always names the total, so this is a hop rewriting it.
    const { computer } = await computerOn((call) => {
      if (!call.path.endsWith('/files')) return anyRoute(call);
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 206,
        headers: {
          'content-type': 'application/octet-stream',
          'accept-ranges': 'bytes',
          'content-range': 'bytes 0-2/*',
        },
      });
    });
    await expect(
      (async () => {
        for await (const _ of computer.readFileChunks('/tmp/big.bin')) {
          // Consumed for the second request, which is where the loop gives up.
        }
      })(),
    ).rejects.toThrow(/without a total/);
  });

  it('refuses a chunk size that is not a whole number of bytes', async () => {
    const { computer } = await computerOn(guestFile(filled(10)));
    await expect(computer.readFileChunks('/tmp/a.bin', { chunkBytes: 0 }).next()).rejects.toThrow(
      /chunkBytes/,
    );
    await expect(computer.readFileChunks('/tmp/a.bin', { chunkBytes: 1.5 }).next()).rejects.toThrow(
      /chunkBytes/,
    );
  });

  it('refuses a tail whose probe named no total, rather than copying one byte', async () => {
    // The probe is the file's LAST byte, not the tail that was asked for.
    // Yielded and returned it is a one-byte `mandala scp` reporting success —
    // the forward loop's own failure, met one request earlier.
    const { computer } = await computerOn((call) => {
      if (!call.path.endsWith('/files')) return anyRoute(call);
      return new Response(new Uint8Array([9]), {
        status: 206,
        headers: {
          'content-type': 'application/octet-stream',
          'accept-ranges': 'bytes',
          'content-range': 'bytes 999-999/*',
        },
      });
    });
    await expect(computer.readFileChunks('/tmp/big.bin', { offset: -250 }).next()).rejects.toThrow(
      /without a total/,
    );
  });

  it('gives a proven-rangeable file none of the first-request escapes', async () => {
    // The tail probe reaches the forward loop only having been served a 206
    // with a total, so this path can be windowed and the loop opens at an
    // offset derived from that total. Both escapes the loop keeps for its very
    // first request are then wrong here. A whole-file answer is the file's
    // FIRST bytes arriving as its last — a `mandala scp` writing the head of a
    // log into a tail and exiting 0 — rather than the unmeasurable file the
    // escape exists for; and a 416 with a total of zero is the file truncated
    // out from under the read rather than one that was always empty.
    const probed =
      (answer: () => Response): Responder =>
      (call) => {
        if (!(call.path.endsWith('/files') && call.method === 'GET')) return anyRoute(call);
        if (call.headers.Range !== 'bytes=-1') return answer();
        return new Response(filled(1000).slice(999), {
          status: 206,
          headers: {
            'content-type': 'application/octet-stream',
            'accept-ranges': 'bytes',
            'content-range': 'bytes 999-999/1000',
          },
        });
      };
    const unmeasured = await computerOn(
      probed(
        () =>
          new Response(filled(1000), {
            status: 200,
            headers: { 'content-type': 'application/octet-stream', 'accept-ranges': 'none' },
          }),
      ),
    );
    await expect(
      unmeasured.computer.readFileChunks('/tmp/big.bin', { offset: -250 }).next(),
    ).rejects.toThrow(/for bytes from 750 and was answered with the whole file/);
    const emptied = await computerOn(
      probed(() =>
        errorJson(416, 'that range is outside the file, which is 0 bytes', {
          'accept-ranges': 'bytes',
          'content-range': 'bytes */0',
        }),
      ),
    );
    await expect(
      emptied.computer.readFileChunks('/tmp/big.bin', { offset: -250 }).next(),
    ).rejects.toBeInstanceOf(RangeNotSatisfiableError);
  });

  it('takes the whole file as the answer to a tail wider than the file', async () => {
    // The forfeit above is a position, not a request number, because a tail
    // longer than the file resolves to a window starting at byte zero — and a
    // whole-file answer to THAT is the window, arriving under a 200 the way RFC
    // 9110 lets an origin or an intermediary answer a range it covers entirely.
    // Refusing it would reject a correct answer to `mandala scp` reading the
    // last 5kB of a 1kB log.
    const { computer } = await computerOn((call) => {
      if (!(call.path.endsWith('/files') && call.method === 'GET')) return anyRoute(call);
      if (call.headers.Range !== 'bytes=-1') {
        return new Response(filled(1000), {
          status: 200,
          headers: { 'content-type': 'application/octet-stream', 'accept-ranges': 'bytes' },
        });
      }
      return new Response(filled(1000).slice(999), {
        status: 206,
        headers: {
          'content-type': 'application/octet-stream',
          'accept-ranges': 'bytes',
          'content-range': 'bytes 999-999/1000',
        },
      });
    });
    expect(await rebuilt(computer.readFileChunks('/tmp/big.bin', { offset: -5000 }))).toEqual(
      filled(1000),
    );
  });

  it('still bounds that whole file by what the probe measured', async () => {
    // Taking a whole-file answer at byte zero is not taking it unmeasured. The
    // probe measured this file to find where the tail began, so a guest file
    // re-created between the two requests answers the second with every byte of
    // a different file — more than the caller's window and starting before it,
    // or the same window over contents that are no longer the ones the offset
    // was resolved against. Both are the checks a 206 already gets, and both
    // are affordable here for exactly the reason the forfeit was lifted: a
    // total is known.
    const wholeFileOf = (size: number): Responder => {
      let probed = false;
      return (call) => {
        if (!(call.path.endsWith('/files') && call.method === 'GET')) return anyRoute(call);
        if (!probed) {
          probed = true;
          return new Response(filled(1000).slice(999), {
            status: 206,
            headers: {
              'content-type': 'application/octet-stream',
              'accept-ranges': 'bytes',
              'content-range': 'bytes 999-999/1000',
            },
          });
        }
        return new Response(filled(size), {
          status: 200,
          headers: { 'content-type': 'application/octet-stream', 'accept-ranges': 'bytes' },
        });
      };
    };
    const grew = await computerOn(wholeFileOf(6000));
    await expect(
      rebuilt(grew.computer.readFileChunks('/tmp/big.bin', { offset: -5000 })),
    ).rejects.toThrow(/cannot hand back more than it asked for/);
    // Shrunk instead, the byte count is inside the window and only the total
    // says the file moved.
    const shrank = await computerOn(wholeFileOf(500));
    await expect(
      rebuilt(shrank.computer.readFileChunks('/tmp/big.bin', { offset: -5000 })),
    ).rejects.toThrow(/total for \/tmp\/big\.bin changed from 1000 to 500/);
  });

  it('refuses a window wider than the one it asked for', async () => {
    // A caller who bounded the read with `length` bounded it. Handing back more
    // is not a smaller wrong than handing back less.
    const { computer } = await computerOn((call) => {
      if (!call.path.endsWith('/files')) return anyRoute(call);
      return new Response(filled(40), {
        status: 206,
        headers: {
          'content-type': 'application/octet-stream',
          'accept-ranges': 'bytes',
          'content-range': 'bytes 0-39/1000',
        },
      });
    });
    await expect(computer.readFileChunks('/tmp/big.bin', { length: 10 }).next()).rejects.toThrow(
      /cannot hand back more than it asked for/,
    );
  });

  it('judges the window against the spelling the caller used', async () => {
    // Resolved first, a tail with a length would become a length silently
    // dropped, and a fractional offset would be reported against a number
    // derived from the file's size rather than the one that was passed.
    const { computer } = await computerOn(guestFile(filled(10)));
    await expect(
      computer.readFileChunks('/tmp/a.bin', { offset: -100, length: 10 }).next(),
    ).rejects.toThrow(/cannot also take a length/);
    await expect(computer.readFileChunks('/tmp/a.bin', { offset: -1.5 }).next()).rejects.toThrow(
      /got -1.5/,
    );
  });
});

describe('snapshots', () => {
  it('keeps unreachable placeholders when filtering to one computer', async () => {
    // A partial listing APPENDS one stub per snapshot it could not reach, with
    // no computer_id on it. Filtering on equality deletes precisely the markers
    // that say something is missing, and then reports a confident count.
    const { client: c } = client(() =>
      json([SNAPSHOT, { id: 'snap-2', computer_id: 'vm-2' }, { id: 'snap-3', unreachable: true }]),
    );
    const rows = await c.snapshots.list({ computerId: 'vm-1' });
    expect(rows.map((s) => s.id)).toEqual(['snap-1', 'snap-3']);
    expect(rows[1]!.unreachable).toBe(true);
  });

  it('decodes what a clone of a snapshot will come up as', async () => {
    // These describe the CAPTURE, not the computer: the source may be gone and
    // an orphan is still cloneable, and a computer resized since no longer says
    // what its old snapshots hold. Read off the snapshot or not at all.
    const { client: c } = client(() => json([SNAPSHOT]));
    const [snap] = await c.snapshots.list();
    expect(snap).toMatchObject({
      computerName: 'scratch',
      os: 'linux',
      template: 'base',
      cpu: 2,
      ramMb: 4096,
      diskGb: 40,
      resolution: '1920x1080x24',
    });
  });

  it('leaves an unreachable placeholder empty rather than inventing a shape', async () => {
    // Such a row carries an id and nothing else, because there was no host to
    // ask. A zero cpu is not a claim about the snapshot, and nothing should
    // read it as one — which is what `unreachable` is there to say.
    const { client: c } = client(() => json([{ id: 'snap-9', unreachable: true }]));
    const [snap] = await c.snapshots.list();
    expect(snap).toMatchObject({ unreachable: true, computerName: '', os: '', cpu: 0 });
  });

  it('reads the fingerprint that binds a purge to a set', async () => {
    const { client: c } = client((call) =>
      call.method === 'GET' && call.path === '/computers/vm-1/snapshots'
        ? json({ count: 3, size_bytes: 9_000, fingerprint: 'abc123' })
        : anyRoute(call),
    );
    const held = await (await c.computers.get('vm-1')).holdings();
    expect(held).toMatchObject({ count: 3, sizeBytes: 9_000, fingerprint: 'abc123' });
  });

  it('refuses a purge that is not bound to a set anybody looked at', async () => {
    const { client: c } = client(anyRoute);
    const computer = await c.computers.get('vm-1');
    await expect(computer.delete({ deleteSnapshots: true })).rejects.toThrow(/holdings\(\)/);
  });

  it('sends the interlock when it has one', async () => {
    // Only the DELETE answers with the count. Answering the get with it too
    // left the handle holding a payload with no id, which is a computer this
    // SDK now refuses to build a path for at all.
    const { rec, client: c } = client((call) =>
      call.method === 'DELETE' ? json({ snapshots_deleted: 3 }) : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    const purged = await computer.delete({ deleteSnapshots: true, expect: 'abc123' });
    expect(rec.last().query).toEqual({ snapshots: 'delete', expect: 'abc123' });
    expect(purged).toBe(3);
  });

  it('does not claim nothing was destroyed when the platform did not say', async () => {
    // `?? 0` here would be a false statement about an irreversible act.
    const { client: c } = client((call) => (call.method === 'DELETE' ? json({}) : anyRoute(call)));
    expect(await (await c.computers.get('vm-1')).delete()).toBeUndefined();
  });
});

/**
 * The three fields of a suppressed pair, read without naming a global.
 *
 * `SuppressedError` is a global in V8 13.4 and after, which is Node 24, and
 * this package's floor is Node 22 — so `err instanceof SuppressedError` is
 * itself a `ReferenceError` on the engine the fallback shape exists for, and a
 * test written that way passes only on the engine that never needed it. `name`
 * is what both shapes agree on.
 */
const pair = (err: unknown) => err as { name: string; error: unknown; suppressed: unknown };

describe('ephemeral', () => {
  it('deletes the computer when the block ends', async () => {
    const { rec, client: c } = client(anyRoute);
    await c.computers.ephemeral({ template: 'base' }, async (computer) => {
      expect(computer.id).toBe('vm-1');
    });
    expect(rec.routes()).toContainEqual(['DELETE', 'computers/vm-1']);
  });

  it('deletes it even when the block throws, and lets the block error out', async () => {
    const { rec, client: c } = client(anyRoute);
    await expect(
      c.computers.ephemeral({ template: 'base' }, async () => {
        throw new Error('the work failed');
      }),
    ).rejects.toThrow('the work failed');
    expect(rec.routes()).toContainEqual(['DELETE', 'computers/vm-1']);
  });

  it('keeps BOTH errors when the block threw and the cleanup delete failed too', async () => {
    // Two failures, and each one is unaffordable to lose. Replacing the block's
    // error hides the actual fault behind a secondary one; dropping the cleanup
    // failure — which is what a `.catch(() => {})` here did — strands a billable
    // cloud machine with nothing anywhere naming it, so nobody can go and find
    // it. `SuppressedError` is how the language already says both, and it is
    // what the `await using` spelling of this same feature gets from the
    // runtime: the two must not disagree about the one that costs money.
    const { client: c } = client((call) =>
      call.method === 'DELETE' ? errorJson(409, 'a snapshot is in flight') : anyRoute(call),
    );
    const block = new Error('the work failed');
    const err = await c.computers
      .ephemeral({ template: 'base' }, async () => {
        throw block;
      })
      .catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(pair(err).name).toBe('SuppressedError');
    // The block's own error, by identity: it is the fault to read first and it
    // arrives unwrapped.
    expect(pair(err).suppressed).toBe(block);
    // The cleanup failure, with the platform's reason and — the point of the
    // whole branch — the id of the machine still being billed for. On `.error`
    // and not only on the message, because `.error` is the field BOTH spellings
    // fill: the runtime writes its own generic text over `.message` for
    // `await using`, so a caller who reads the message there gets no id at all.
    expect(pair(err).error).toBeInstanceOf(MandalaError);
    expect((pair(err).error as Error).message).toMatch(/vm-1 was not deleted.*still billable/);
    expect((pair(err).error as Error).message).toContain('a snapshot is in flight');
  });

  it('names the machine on `.error` in the same words under either spelling', async () => {
    // The claim the README and the doc block both make, asserted rather than
    // hoped for. The `await using` spelling's `.error` is whatever the disposer
    // throws and its `.message` is the runtime's own text; if the callback
    // spelling put the raw transport failure on `.error` instead, then a caller
    // logging `err.error.message` would get the id under one spelling and a bare
    // "409" under the other, for the same pair of failures.
    const { client: c } = client((call) =>
      call.method === 'DELETE' ? errorJson(409, 'a snapshot is in flight') : anyRoute(call),
    );
    const viaCallback = await c.computers
      .ephemeral({ template: 'base' }, async () => {
        throw new Error('the work failed');
      })
      .catch((e) => e);
    const handle = await c.computers.ephemeral({ template: 'base' });
    const viaDisposer = await handle[Symbol.asyncDispose]().catch((e: unknown) => e);

    expect(viaDisposer).toBeInstanceOf(MandalaError);
    expect((pair(viaCallback).error as Error).message).toBe((viaDisposer as Error).message);
  });

  it('says both errors on an engine with no SuppressedError, which Node 22 is', async () => {
    // The global landed in V8 13.4 — Node 24 — and this package declares
    // `>=22`, where constructing it throws `ReferenceError` from inside the
    // handler whose whole job is to stop two failures becoming one. Both are
    // then destroyed and the caller is told about a missing global instead: a
    // strictly worse outcome than the `.catch(() => {})` this replaced, on the
    // engine at the very floor the package supports. The shape below is the one
    // TypeScript's own downlevel helper synthesises, so the fields read the same
    // either way.
    vi.stubGlobal('SuppressedError', undefined);
    try {
      const { client: c } = client((call) =>
        call.method === 'DELETE' ? errorJson(409, 'a snapshot is in flight') : anyRoute(call),
      );
      const block = new Error('the work failed');
      const err = await c.computers
        .ephemeral({ template: 'base' }, async () => {
          throw block;
        })
        .catch((e) => e);

      expect(err).toBeInstanceOf(Error);
      expect(pair(err).name).toBe('SuppressedError');
      expect(pair(err).suppressed).toBe(block);
      expect((pair(err).error as Error).message).toMatch(/vm-1 was not deleted.*still billable/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not wrap the block’s error when the cleanup delete 404s', async () => {
    // A 404 is the goal state already reached — the block deleted the machine
    // itself — so nothing is billable and there is no second failure to report.
    // Wrapping here would announce a leak that does not exist and bury the only
    // error that matters inside a `SuppressedError` nobody needed.
    const { client: c } = client((call) =>
      call.method === 'DELETE' ? errorJson(404, 'no such computer') : anyRoute(call),
    );
    const block = new Error('the work failed');
    const err = await c.computers
      .ephemeral({ template: 'base' }, async () => {
        throw block;
      })
      .catch((e) => e);

    expect(err).toBe(block);
    expect(pair(err).name).not.toBe('SuppressedError');
  });

  it('reports a delete that failed after the block succeeded, naming the machine', async () => {
    // Swallowed, this is a billable machine leaking with nothing ever going to
    // mention it — the opposite of the failing-block case above, where the
    // block's own error is the one that must survive.
    const { client: c } = client((call) =>
      call.method === 'DELETE' ? errorJson(409, 'a snapshot is in flight') : anyRoute(call),
    );
    await expect(c.computers.ephemeral({ template: 'base' }, async () => 'done')).rejects.toThrow(
      /vm-1.*still billable/,
    );
  });

  it('does not call a machine the block already deleted itself "still billable"', async () => {
    // delete({ deleteSnapshots: true, expect }) inside the block is the
    // documented way to purge snapshots; the wrapper's own delete then answers
    // 404, which is the goal state already reached — and the block's result
    // must survive it, not be replaced by a false claim.
    const { client: c } = client((call) =>
      call.method === 'DELETE' ? errorJson(404, 'no such computer') : anyRoute(call),
    );
    await expect(
      c.computers.ephemeral({ template: 'base' }, async () => 'an hour of work'),
    ).resolves.toBe('an hour of work');
  });

  it('treats an already-gone machine as cleaned up at the end of `await using` too', async () => {
    const { client: c } = client((call) =>
      call.method === 'DELETE' ? errorJson(404, 'no such computer') : anyRoute(call),
    );
    const attempt = async () => {
      await using computer = await c.computers.ephemeral({ template: 'base' });
      return computer.id;
    };
    await expect(attempt()).resolves.toBe('vm-1');
  });

  it('says which machine an `await using` block failed to delete', async () => {
    const { client: c } = client((call) =>
      call.method === 'DELETE' ? errorJson(409, 'a snapshot is in flight') : anyRoute(call),
    );
    const attempt = async () => {
      await using computer = await c.computers.ephemeral({ template: 'base' });
      expect(computer.id).toBe('vm-1');
    };
    await expect(attempt()).rejects.toThrow(/vm-1.*still billable/);
  });

  it('destroys itself at the end of an `await using` block', async () => {
    const { rec, client: c } = client(anyRoute);
    {
      await using computer = await c.computers.ephemeral({ template: 'base' });
      expect(computer.id).toBe('vm-1');
    }
    expect(rec.routes()).toContainEqual(['DELETE', 'computers/vm-1']);
  });

  it('does not put a self-destruct on an ordinary handle', async () => {
    // `await using c = await client.computers.get(id)` must not delete somebody's
    // machine.
    const { client: c } = client(anyRoute);
    const computer = await c.computers.get('vm-1');
    expect((computer as never as Record<symbol, unknown>)[Symbol.asyncDispose]).toBeUndefined();
  });
});

describe('the agent loop', () => {
  it('does not throw away the result of a run that ended unfinished', async () => {
    // max_steps leaves real work on the desktop, and discarding the result would
    // discard the only account of what was done to the machine.
    const { client: c } = client((call) =>
      call.path.endsWith('/agent')
        ? json({ steps: 20, stop: 'max_steps', text: 'got partway' })
        : anyRoute(call),
    );
    const res = await (await c.computers.get('vm-1')).agentOnce({
      prompt: 'go',
      modelKey: 'sk',
    });
    expect(res.finished).toBe(false);
    expect(res.stop).toBe('max_steps');
    expect(res.text).toBe('got partway');
  });

  it('refuses a whitespace-only model key rather than forwarding it', async () => {
    const { rec, client: c } = client(anyRoute);
    const computer = await c.computers.get('vm-1');
    await expect(computer.agentOnce({ prompt: 'go', modelKey: '   ' })).rejects.toThrow(/modelKey/);
    await expect(computer.agent({ prompt: 'go', modelKey: '   ' })).rejects.toThrow(/modelKey/);
    expect(rec.calls.every((call) => !call.path.endsWith('/agent'))).toBe(true);
  });

  it('throws when the stream ends with no result at all', async () => {
    const { client: c } = client((call) =>
      call.path.endsWith('/agent')
        ? new Response('event: step\ndata: {"n":1}\n\n', {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          })
        : anyRoute(call),
    );
    await expect(
      (await c.computers.get('vm-1')).agent({ prompt: 'go', modelKey: 'sk' }),
    ).rejects.toThrow(MandalaError);
  });

  it('stops consuming as soon as the stream reports an error', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(
          new TextEncoder().encode('event: error\ndata: {"error":"failed","status":500}\n\n'),
        );
      },
      cancel() {
        cancelled = true;
      },
    });
    const { client: c } = client((call) =>
      call.path.endsWith('/agent')
        ? new Response(body, { headers: { 'content-type': 'text/event-stream' } })
        : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    await expect(computer.agent({ prompt: 'go', modelKey: 'sk' })).rejects.toThrow(/failed/);
    expect(cancelled).toBe(true);
  });

  it('stops consuming as soon as the stream reports done', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(
          new TextEncoder().encode('event: done\ndata: {"stop":"end_turn","text":"ok"}\n\n'),
        );
      },
      cancel() {
        cancelled = true;
      },
    });
    const { client: c } = client((call) =>
      call.path.endsWith('/agent')
        ? new Response(body, { headers: { 'content-type': 'text/event-stream' } })
        : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error('done was ignored')), 100);
    try {
      await expect(
        computer.agent({ prompt: 'go', modelKey: 'sk', signal: ac.signal }),
      ).resolves.toMatchObject({ finished: true, text: 'ok' });
    } finally {
      clearTimeout(timer);
    }
    expect(cancelled).toBe(true);
  });

  it.each([
    ['done', '{"stop":"end_turn","text":"ok"}'],
    ['error', '{"error":"failed","status":500}'],
  ])('ends agentStream itself as soon as it reports %s', async (event, data) => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${data}\n\n`));
      },
      cancel() {
        cancelled = true;
      },
    });
    const { client: c } = client((call) =>
      call.path.endsWith('/agent')
        ? new Response(body, { headers: { 'content-type': 'text/event-stream' } })
        : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    const seen = [];
    for await (const ev of computer.agentStream({ prompt: 'go', modelKey: 'sk' }))
      seen.push(ev.type);
    expect(seen).toEqual([event]);
    expect(cancelled).toBe(true);
  });

  it('refuses a done event that has no stop reason', async () => {
    const { client: c } = client((call) =>
      call.path.endsWith('/agent')
        ? new Response('event: done\ndata: {"text":"ambiguous"}\n\n', {
            headers: { 'content-type': 'text/event-stream' },
          })
        : anyRoute(call),
    );
    await expect(
      (await c.computers.get('vm-1')).agent({ prompt: 'go', modelKey: 'sk' }),
    ).rejects.toThrow(/done event that had no stop reason/);
  });

  it('preserves a non-object error payload as the failure message', async () => {
    const { client: c } = client((call) =>
      call.path.endsWith('/agent')
        ? new Response('event: error\ndata: "model overloaded"\n\n', {
            headers: { 'content-type': 'text/event-stream' },
          })
        : anyRoute(call),
    );
    await expect(
      (await c.computers.get('vm-1')).agent({ prompt: 'go', modelKey: 'sk' }),
    ).rejects.toThrow(/model overloaded/);
  });
});

describe('a status that arrived on a stream', () => {
  const errorStream = (payload: string) =>
    new Response(`event: error\ndata: ${payload}\n\n`, {
      headers: { 'content-type': 'text/event-stream' },
    });

  it('is not read as a proxy that gave up', async () => {
    // The agent loop reports its own failures as events inside a 200. The event
    // reaching the caller is proof no proxy abandoned the request, which is the
    // one thing GatewayTimeoutError asserts — so a downstream 504 relayed this
    // way must not claim it.
    const { client: c } = client((call) =>
      call.path.endsWith('/agent')
        ? errorStream('{"error":"model provider timed out","status":504}')
        : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    const err = await computer.agent({ prompt: 'go', modelKey: 'sk' }).catch((e) => e);
    expect(err).toBeInstanceOf(MandalaError);
    expect(err).not.toBeInstanceOf(GatewayTimeoutError);
    expect(err.status).toBe(504);
  });

  it.each([504, 520, 521, 522, 523, 525, 526])(
    'does not read %i on a stream as the edge either',
    async (status) => {
      // The same argument as the 504 above, across the range. Any of these
      // arriving inside a stream that is demonstrably open cannot describe this
      // connection, which is the whole of what every class in that range says.
      // Asserted on the constructor rather than with `not.toBeInstanceOf`: the
      // four are siblings, so ruling one out leaves three that would pass.
      const { client: c } = client((call) =>
        call.path.endsWith('/agent')
          ? errorStream(`{"error":"model provider failed","status":${status}}`)
          : anyRoute(call),
      );
      const computer = await c.computers.get('vm-1');
      const err = await computer.agent({ prompt: 'go', modelKey: 'sk' }).catch((e) => e);
      expect(err.constructor).toBe(APIError);
      expect(err.status).toBe(status);
    },
  );

  it('still maps every status that means the same thing in both places', async () => {
    const { client: c } = client((call) =>
      call.path.endsWith('/agent')
        ? errorStream('{"error":"revoked","status":401}')
        : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    const err = await computer.agent({ prompt: 'go', modelKey: 'sk' }).catch((e) => e);
    expect(err).toBeInstanceOf(AuthenticationError);
  });

  it('keeps a relayed rate limit a rate limit', async () => {
    // 429 is the status the platform relays a model provider's rate budget
    // with, and it is reached by a branch of its own rather than through the
    // status table — so a status table consulted alone quietly loses it.
    const { client: c } = client((call) =>
      call.path.endsWith('/agent')
        ? errorStream('{"error":"model API: rate limited","status":429}')
        : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    const err = await computer.agent({ prompt: 'go', modelKey: 'sk' }).catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(isTransient(err)).toBe(true);
  });
});

describe('expired guest waits', () => {
  it('does not start a guest probe after its deadline has already elapsed', async () => {
    const { rec, client: c } = client(anyRoute);
    const computer = await c.computers.get('vm-1');
    rec.calls.length = 0;
    await expect(computer.waitForGuest({ timeoutMs: 0, pollMs: 1 })).rejects.toThrow(TimeoutError);
    expect(rec.calls).toHaveLength(0);
  });
});

describe('power', () => {
  it('reads the computer off the action response rather than re-fetching it', async () => {
    const { rec, client: c } = client(anyRoute);
    const computer = await c.computers.get('vm-1');
    rec.calls.length = 0;
    await computer.start();
    expect(rec.routes()).toEqual([['POST', 'computers/vm-1/start']]);
  });

  it('refreshes when the platform answered a power action with nothing', async () => {
    // A handle that reported the state the machine was in before the call would
    // be worse than a second round trip.
    const { rec, client: c } = client((call) =>
      call.path.endsWith('/start') ? new Response(null, { status: 204 }) : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    rec.calls.length = 0;
    await computer.start();
    expect(rec.routes()).toEqual([
      ['POST', 'computers/vm-1/start'],
      ['GET', 'computers/vm-1'],
    ]);
  });

  it('does not report a successful power action as retryable when only its refresh failed', async () => {
    let gets = 0;
    const { client: c } = client((call) => {
      if (call.method === 'GET' && call.path === '/computers/vm-1') {
        gets += 1;
        return gets === 1 ? json(COMPUTER) : errorJson(503, 'host could not be reached');
      }
      if (call.path.endsWith('/stop')) return new Response(null, { status: 204 });
      return anyRoute(call);
    });
    const computer = await c.computers.get('vm-1');
    const err = await computer.stop().catch((e) => e);
    expect(err).toBeInstanceOf(MandalaError);
    expect(isTransient(err)).toBe(false);
    expect(err.message).toMatch(/POST computers\/vm-1\/stop succeeded/);
    expect(err.message).toMatch(/Do not retry the mutation/);
    expect(err.cause).toBeInstanceOf(APIError);
    expect(computer.status).toBe('running');
  });
});

describe('answers that would leave a handle worse off', () => {
  it('refuses a refresh that answered with no computer, rather than emptying itself', async () => {
    // Assigned unguarded, a 204 flattens to `{}` and the handle loses its id
    // along with every other field — every call after it then aims at
    // `computers/`, the collection. #power has guarded this since it was
    // written; refresh had not, and #power's own fallback is a refresh.
    let gets = 0;
    const { client: c } = client((call) => {
      if (call.method === 'GET' && call.path === '/computers/vm-1') {
        gets += 1;
        return gets === 1 ? json(COMPUTER) : new Response(null, { status: 204 });
      }
      return anyRoute(call);
    });
    const computer = await c.computers.get('vm-1');
    await expect(computer.refresh()).rejects.toThrow(
      /expected a computer from GET computers\/vm-1/,
    );
    // And the handle still knows which machine it is.
    expect(computer.id).toBe('vm-1');
    expect(computer.status).toBe('running');
  });

  it('re-reads rather than emptying itself when an update answered with nothing', async () => {
    const { rec, client: c } = client((call) =>
      call.method === 'PATCH' ? new Response(null, { status: 204 }) : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    rec.calls.length = 0;
    await computer.update({ cpu: 4 });
    expect(rec.routes()).toEqual([
      ['PATCH', 'computers/vm-1'],
      ['GET', 'computers/vm-1'],
    ]);
    expect(computer.id).toBe('vm-1');
  });

  it('distinguishes an applied update from a failed follow-up refresh', async () => {
    let gets = 0;
    const { client: c } = client((call) => {
      if (call.method === 'GET' && call.path === '/computers/vm-1') {
        gets += 1;
        return gets === 1 ? json(COMPUTER) : errorJson(503, 'host could not be reached');
      }
      if (call.method === 'PATCH') return new Response(null, { status: 204 });
      return anyRoute(call);
    });
    const computer = await c.computers.get('vm-1');
    const err = await computer.rename('renamed').catch((e) => e);
    expect(err).toBeInstanceOf(MandalaError);
    expect(isTransient(err)).toBe(false);
    expect(err.message).toMatch(/PATCH computers\/vm-1 succeeded/);
    expect(err.message).toMatch(/previous state/);
    expect(err.cause).toBeInstanceOf(APIError);
    expect(computer.name).toBe('demo');
  });

  it('does not offer the snapshot a disk is copied from as the reason it failed', async () => {
    // build.source names what is being copied FROM and is present throughout a
    // healthy build. Read as a fallback reason it answers "why did this fail"
    // with a snapshot id, about a computer that may still be building.
    const { client: c } = client(() =>
      json({ ...COMPUTER, status: 'building', build: { source: 'snap-42' } }),
    );
    const computer = await c.computers.get('vm-1');
    expect(computer.buildError).toBe('');
    // And the wait's message falls back to its own words rather than the id.
    const { client: d } = client(() =>
      json({ ...COMPUTER, status: 'build-failed', build: { source: 'snap-42' } }),
    );
    const failed = await d.computers.get('vm-1');
    const err = await failed.waitUntilRunning({ timeoutMs: 10, pollMs: 1 }).catch((e) => e);
    expect(err.message).toMatch(/the disk copy failed/);
    expect(err.message).not.toContain('snap-42');
  });

  it('does not claim bytes landed that the platform never counted', async () => {
    // The docstring promises what the platform said it wrote, and `?? sent`
    // affirms what nobody said — the same false statement `delete()` refuses to
    // make about an irreversible act.
    const { client: c } = client((call) => (call.method === 'PUT' ? json({}) : anyRoute(call)));
    const computer = await c.computers.get('vm-1');
    expect(await computer.writeFile('/tmp/a.txt', 'hello')).toBeUndefined();
  });

  it('does not read a background command with no exit code as having succeeded', async () => {
    // Number('') is 0, and a command still running reported as having exited
    // successfully is the one wrong answer here that reads as fine. The same
    // guard toExecResult carries on the same field.
    const { client: c } = client((call) =>
      /\/exec$/.test(call.path) ? json({ pid: 42, running: true, exit_code: '' }) : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    const started = await computer.execBackground('sleep 60');
    expect(started.exitCode).toBeUndefined();
    expect(started.running).toBe(true);
  });

  it('does not read a background exit code it cannot parse as success', async () => {
    // num()'s implicit fallback is 0, so `"killed"` decoded to "exited
    // successfully" — the same wrong-answer-that-reads-as-fine the empty-string
    // guard above exists for. toExecResult passes -1 on the same field.
    for (const spelling of ['killed', 'signal:9', {}]) {
      const { client: c } = client((call) =>
        /\/exec$/.test(call.path)
          ? json({ pid: 42, running: false, exit_code: spelling })
          : anyRoute(call),
      );
      const started = await (await c.computers.get('vm-1')).execBackground('sleep 60');
      expect(started.exitCode).toBe(-1);
    }
  });

  it('does not read a stringified "false" as true, in either spelling', async () => {
    // Boolean('false') is true — the one coercion in the decoders that inverts
    // a field's meaning rather than blurring it. 'False' is the spelling most
    // likely to arrive: the platform's own SDK is Python's, and str(False)
    // capitalises.
    for (const no of ['false', 'False', 'FALSE']) {
      const { client: c } = client((call) =>
        /\/exec$/.test(call.path)
          ? json({ ...EXEC_OK, timed_out: no, out_truncated: no })
          : anyRoute(call),
      );
      const res = await (await c.computers.get('vm-1')).exec('true');
      expect(res.timedOut).toBe(false);
      expect(res.truncated).toBe(false);
      expect(res.ok).toBe(true);
    }
  });

  it('lets a caller abort a guest wait during the probe, not only between them', async () => {
    // The signal used to reach only the sleep between polls, so an abort waited
    // out whatever probe was already in flight — under the client's own
    // per-request deadline, not the wait's.
    const ac = new AbortController();
    const { client: c } = client((call) => {
      if (/\/exec$/.test(call.path)) {
        // After the transport is already waiting on it, which is the case that
        // used to be uninterruptible.
        setTimeout(() => ac.abort(new Error('caller changed their mind')), 5);
        return new Promise<Response>(() => {}); // never answers
      }
      return anyRoute(call);
    });
    const computer = await c.computers.get('vm-1');
    await expect(
      computer.waitForGuest({ timeoutMs: 60_000, pollMs: 1, signal: ac.signal }),
    ).rejects.toThrow(/changed their mind/);
  });
});

/**
 * The findings of the OPL-4215 hunt, at the level each one actually bites.
 *
 * Grouped by what went wrong rather than by file, because several of them are
 * one defect wearing two faces. The stream half of the hunt lives in
 * `events.test.ts`, where the fake socket is.
 */
describe('a chord with a hole in it', () => {
  it('refuses an undefined key in the array spelling, not only the rest-args one', async () => {
    // `JSON.stringify` turns an `undefined` array entry into `null`, so this
    // reached the platform as a chord with a keystroke nobody named. The guard
    // written for `key('ctrl', undefined, 'c')` was gated on the rest-args
    // spelling, and the array form is the DOCUMENTED one — it is the spelling
    // that carries CallOptions.
    const { client: c } = client(anyRoute);
    const computer = await c.computers.get('vm-1');
    await expect(computer.key(['ctrl', undefined as never, 'c'])).rejects.toThrow(ValidationError);
    await expect(computer.key('ctrl', undefined as never, 'c')).rejects.toThrow(ValidationError);
  });

  it('still sends the chords both spellings were always for', async () => {
    const { client: c, rec } = client(anyRoute);
    const computer = await c.computers.get('vm-1');
    await computer.key(['ctrl', 'c']);
    await computer.key('ctrl', 'v');
    expect(rec.last().body).toMatchObject({ action: 'key', keys: ['ctrl', 'v'] });
  });
});

describe('an options object where a point was expected', () => {
  it('refuses drag({ signal }) rather than dragging from wherever the pointer is', async () => {
    // An options object IS a `Point` at runtime as far as anything could tell:
    // it simply has no `x` and no `y`, so `start_coordinate` was omitted and
    // the drag selected a different region while succeeding.
    const { client: c } = client(anyRoute);
    const computer = await c.computers.get('vm-1');
    await expect(computer.drag(10, 20, { signal: undefined } as never)).rejects.toThrow(
      /takes a \{ x, y \} starting point/,
    );
  });

  it('still drags from a real point, and from none at all', async () => {
    const { client: c, rec } = client(anyRoute);
    const computer = await c.computers.get('vm-1');
    await computer.drag(10, 20, { x: 1, y: 2 });
    expect(rec.last().body).toMatchObject({ start_coordinate: [1, 2] });
    await computer.drag(30, 40);
    expect(rec.last().body).not.toHaveProperty('start_coordinate');
    // `null` is a point nobody gave, and reaches `from?.x` exactly as
    // `undefined` does. Guarded with `!== undefined` this dereferenced null and
    // threw a TypeError naming neither the argument nor the call.
    await computer.drag(50, 60, null as never);
    expect(rec.last().body).not.toHaveProperty('start_coordinate');
  });

  it('refuses an array bound to scroll()\u2019s options, which holds no modifiers', async () => {
    // The mirror of the click misbinding: `click(100, 200, ['shift'])` is
    // correct, so `scroll(100, 200, ['shift'])` is the natural next line — and
    // here `modifiers` is a named option, so the array binds to `opts` and the
    // scroll happened with nothing held down.
    const { client: c } = client(anyRoute);
    const computer = await c.computers.get('vm-1');
    await expect(computer.scroll(100, 200, ['shift'] as never)).rejects.toThrow(
      /takes its modifiers as an option/,
    );
    await computer.scroll(100, 200, { modifiers: ['shift'] });
  });

  it('refuses click({ signal }) rather than sending an uncancellable click', async () => {
    const { client: c } = client(anyRoute);
    const computer = await c.computers.get('vm-1');
    for (const call of [
      () => computer.click(1, 2, { signal: undefined } as never),
      () => computer.rightClick(1, 2, { signal: undefined } as never),
      () => computer.doubleClick(1, 2, { signal: undefined } as never),
    ]) {
      await expect(call()).rejects.toThrow(/must be an array of key names/);
    }
  });

  it('refuses windowAction(id, action, { signal }) rather than closing uncancellably', async () => {
    const { client: c } = client(anyRoute);
    const computer = await c.computers.get('vm-1');
    const { signal } = new AbortController();
    await expect(computer.windowAction('w-1', 'close', { signal } as never)).rejects.toThrow(
      /geometry takes only/,
    );
  });
});

describe('a body the route did not send', () => {
  it('refuses an empty exec body rather than reporting a command that failed', async () => {
    // `toExecResult({})` is `exitCode: -1, ok: false` — a command that ran and
    // failed, which is a sentence nobody said. Callers branch on `ok`.
    const { client: c } = client((call) =>
      call.path.endsWith('/exec') ? new Response(null, { status: 204 }) : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    await expect(computer.exec('true')).rejects.toThrow(/expected an exec result/);
  });

  it('refuses an empty background-exec body, naming the route', async () => {
    // `toBackgroundExec({})` throws "expected a background command's pid, got
    // null" — correct refusal of a fabricated success, but it does not name
    // the method or path the way `exec()` was fixed to (OPL-4215 leftover).
    const { client: c } = client((call) =>
      call.path.endsWith('/exec') ? new Response(null, { status: 204 }) : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    await expect(computer.execBackground('sleep 60')).rejects.toThrow(
      /expected a background command from POST computers\/vm-1\/exec/,
    );
  });

  it('refuses an empty poll or kill body, naming the method', async () => {
    const { client: c } = client((call) =>
      /\/exec\/\d+$/.test(call.path) ? new Response(null, { status: 204 }) : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    await expect(computer.execPoll(42)).rejects.toThrow(
      /expected a background command from GET computers\/vm-1\/exec\/42/,
    );
    await expect(computer.execKill(42)).rejects.toThrow(
      /expected a background command from DELETE computers\/vm-1\/exec\/42/,
    );
  });

  it('refuses a snapshot row that names nothing, the way a build row is refused', async () => {
    const { client: c } = client((call) =>
      call.path === '/snapshots' ? json([{ ...SNAPSHOT, id: undefined }]) : anyRoute(call),
    );
    await expect(c.snapshots.list()).rejects.toThrow(/expected a snapshot to carry an id/);
  });

  it('still admits the unreachable placeholder this listing exists to surface', async () => {
    // The row that fear about the refusal above lands on, and it is safe:
    // `projection.ts` sets `id` on every row it emits, bare ones included. What
    // a placeholder drops is `computer_id`, `state` and the rest — which is
    // what it is recognised by.
    const { client: c } = client((call) =>
      call.path === '/snapshots'
        ? json([{ id: 'snap-9', name: 'nightly', unreachable: true }])
        : anyRoute(call),
    );
    const [snap] = await c.snapshots.list();
    expect(snap?.id).toBe('snap-9');
    expect(snap?.unreachable).toBe(true);
  });
});

describe('a payload whose strings cannot be read', () => {
  it('answers the fallback rather than taking down the listing it was read from', async () => {
    // OPL-3850's own failure, on the getters the fix did not reach: `String()`
    // THROWS on a value with no primitive conversion, and `computerRecord`
    // requires only a truthy id, so such a row survives construction.
    const unreadable = { toString: 'not a function' };
    const { client: c } = client(() =>
      json({
        ...COMPUTER,
        name: unreadable,
        os: unreadable,
        template: unreadable,
        resolution: unreadable,
        created_at: unreadable,
        start_error: unreadable,
      }),
    );
    const computer = await c.computers.get('vm-1');
    expect(computer.id).toBe('vm-1');
    expect(computer.name).toBe('');
    expect(computer.os).toBe('');
    expect(computer.template).toBe('');
    expect(computer.createdAt).toBe('');
    expect(computer.startError).toBe('');
    // The default, not a throw and not an empty string: an unreadable
    // resolution is a resolution nobody sent.
    expect(computer.resolution).toBe('1280x800x24');
    // `raw` still carries what could not be read.
    expect(computer.raw.name).toEqual(unreadable);
  });
});

describe('a wait with no time to look', () => {
  it('returns a handle that already reads running rather than timing out on it', async () => {
    // Success required `observed`, and a zero budget skips the refresh that
    // would set it — so this came back as a TimeoutError claiming every refresh
    // had failed when none was attempted. `waitUntilBuilt` special-cases the
    // same budget.
    const { client: c, rec } = client(anyRoute);
    const computer = await c.computers.get('vm-1');
    const before = rec.calls.length;
    expect(await computer.waitUntilRunning({ timeoutMs: 0 })).toBe(computer);
    expect(rec.calls.length).toBe(before);
  });

  it('says a zero budget left no time, rather than blaming refreshes it never made', async () => {
    const { client: c } = client(() => json({ ...COMPUTER, status: 'building' }));
    const computer = await c.computers.get('vm-1');
    await expect(computer.waitUntilRunning({ timeoutMs: 0 })).rejects.toThrow(
      /left no time to look again/,
    );
  });

  it('still reports a real wait that never got an answer as refreshes failing', async () => {
    let first = true;
    const { client: c } = client((call) => {
      if (first) {
        first = false;
        return json(COMPUTER);
      }
      return errorJson(503, 'host could not be reached');
    });
    const computer = await c.computers.get('vm-1');
    await expect(computer.waitUntilRunning({ timeoutMs: 30, pollMs: 1 })).rejects.toThrow(
      TimeoutError,
    );
  });
});

describe('an exec deadline that cannot be represented', () => {
  it('names timeoutS rather than the request deadline derived from it', async () => {
    const { client: c } = client(anyRoute);
    const computer = await c.computers.get('vm-1');
    await expect(computer.exec('sleep 1', { timeoutS: 3_000_000 })).rejects.toThrow(
      /timeoutS must be no greater than/,
    );
  });

  it('catches the arguments whose derived deadline overflows to Infinity', async () => {
    // Tested on the product, `(1e308 + 30) * 1000` is Infinity, which is not
    // greater than MAX_TIMER_MS — so the largest arguments walked through the
    // ceiling and got the transport's generic sentence about the deadline,
    // which is the message this refusal exists to replace.
    const { client: c } = client(anyRoute);
    const computer = await c.computers.get('vm-1');
    await expect(computer.exec('sleep 1', { timeoutS: 1e308 })).rejects.toThrow(
      /timeoutS must be no greater than/,
    );
  });

  it('leaves a non-finite timeoutS to the refusal already written for it', async () => {
    const { client: c } = client(anyRoute);
    const computer = await c.computers.get('vm-1');
    await expect(computer.exec('sleep 1', { timeoutS: Number.POSITIVE_INFINITY })).rejects.toThrow(
      /finite/,
    );
  });

  it('still runs an ordinary command', async () => {
    const { client: c } = client(anyRoute);
    const computer = await c.computers.get('vm-1');
    expect((await computer.exec('true', { timeoutS: 60 })).ok).toBe(true);
  });
});
