/** What the handles do, as distinct from where they send it. */

import { describe, expect, it } from 'vitest';
import {
  AuthenticationError,
  Client,
  GatewayTimeoutError,
  isTransient,
  MandalaError,
  OriginResponseError,
  OriginUnreachableError,
  TimeoutError,
} from '../src/index.js';
import {
  anyRoute,
  BASE,
  COMPUTER,
  EXEC_OK,
  errorJson,
  json,
  type Responder,
  recorder,
  SNAPSHOT,
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
    ]) {
      await expect(wait()).rejects.toThrow(TypeError);
    }
    // Refused before the loop starts, so not one request went out.
    expect(rec.calls.length).toBe(before);
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

  it('refuses a window action with no window instead of inventing one', async () => {
    const { client: c } = client((call) =>
      /\/windows\/[^/]+$/.test(call.path) ? new Response(null, { status: 204 }) : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    await expect(computer.windowAction('0x1', 'focus')).rejects.toThrow(
      /expected a window from POST/,
    );
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

  it('does not expose NaN when a known position contains malformed coordinates', async () => {
    const { client: c } = client((call) =>
      call.path.endsWith('/input') ? json({ known: true, x: 'left', y: {} }) : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    expect(await computer.cursorPosition()).toEqual({ x: 0, y: 0 });
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
    expect(err.message).toMatch(/never arrived/);
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
    const { client: c } = client(() => new Response('', { status: 526 }));
    const err = await c.computers.get('vm-1').catch((e) => e);
    expect(err).toBeInstanceOf(OriginUnreachableError);
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

  it('refuses to open a URL on a Windows guest rather than sending a POSIX command', async () => {
    // cmd.exe answering "'nohup' is not recognized" through an ExecResult
    // reads as anything but what actually went wrong.
    const { client: c } = client(() => json({ ...COMPUTER, os: 'windows' }));
    const computer = await c.computers.get('vm-1');
    await expect(computer.open('https://example.com')).rejects.toThrow(/Linux-only/);
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

  it('does not let a cleanup failure replace the error the block was throwing', async () => {
    // Hiding the actual fault behind a secondary one is the worst outcome here.
    const { client: c } = client((call) =>
      call.method === 'DELETE' ? errorJson(409, 'a snapshot is in flight') : anyRoute(call),
    );
    await expect(
      c.computers.ephemeral({ template: 'base' }, async () => {
        throw new Error('the work failed');
      }),
    ).rejects.toThrow('the work failed');
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
