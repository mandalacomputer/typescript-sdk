/** The capture that outlives its request, from the 202 to the row that lands. */

import { describe, expect, it } from 'vitest';
import { Client, MandalaError, TimeoutError, ValidationError } from '../src/index.js';
import {
  anyRoute,
  BASE,
  CAPTURE_ACCEPTED,
  errorJson,
  json,
  type Responder,
  recorder,
  SNAPSHOT,
} from './harness.js';

// OPL-4568. `POST computers/:id/snapshots` answers 202 with a `capturing`
// placeholder and runs the capture afterwards (platform OPL-4562), and this SDK
// read that answer as the finished snapshot — so `snapshot()` returned an id
// that restore, clone and delete all 404 on, and called it a snapshot.
//
// What is pinned here is the seam rather than the capture. The platform's own
// tests own whether a disk copies; these own whether a caller can tell a capture
// that landed from one that failed from one this wait simply stopped watching —
// three outcomes with three remedies, and the SDK is the only thing standing
// between them and one another.

const client = (respond: Responder) => {
  const rec = recorder(respond);
  return { rec, client: new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch }) };
};

/** The listing route, with everything else answered as usual. */
const listing = (rows: (call: { path: string }) => Response): Responder => {
  return (call) =>
    call.path === '/snapshots' && call.method === 'GET' ? rows(call) : anyRoute(call);
};

describe('snapshot() waits for the capture', () => {
  it('returns the landed row rather than the placeholder it was handed', async () => {
    let polls = 0;
    const { client: c } = client(
      listing(() => {
        polls += 1;
        return json([polls < 3 ? CAPTURE_ACCEPTED : SNAPSHOT]);
      }),
    );
    const computer = await c.computers.get('vm-1');
    const snap = await computer.snapshot({ pollMs: 1 });

    expect(polls).toBe(3);
    expect(snap.capturing).toBe(false);
    // The row that landed, and every field of it: a wait that returned the 202's
    // payload would answer the same id with none of the bytes.
    expect(snap.id).toBe(SNAPSHOT.id);
    expect(snap.sizeBytes).toBe(SNAPSHOT.size_bytes);
  });

  it('stops at any state that is not capturing, `durable` included', async () => {
    // NOT the literal string `pending`. Replication to backup storage can carry
    // a small snapshot on to `durable` between two polls, and a loop watching
    // for `pending` by name would watch it go past and never match.
    for (const state of ['pending', 'durable']) {
      const { client: c } = client(listing(() => json([{ ...SNAPSHOT, state }])));
      const computer = await c.computers.get('vm-1');
      const snap = await computer.snapshot({ pollMs: 1, timeoutMs: 500 });
      expect(`${state}: ${snap.state}`).toBe(`${state}: ${state}`);
    }
  });

  it('matches on the id, not on the newest snapshot of this computer', async () => {
    // The guess the platform allocated a stable id to remove, and it is wrong
    // exactly where a wait matters: a scheduled capture landing during a long
    // manual one is another row of this computer's, finished, on the same
    // listing. A wait that took the newest — or the first landed row it could
    // attribute to this computer — would answer somebody else's snapshot.
    const scheduled = { ...SNAPSHOT, id: 'snap-nightly', auto: true, state: 'durable' };
    let polls = 0;
    const { client: c } = client(
      listing(() => {
        polls += 1;
        return json(polls < 2 ? [scheduled, CAPTURE_ACCEPTED] : [scheduled, SNAPSHOT]);
      }),
    );
    const computer = await c.computers.get('vm-1');
    const snap = await computer.snapshot({ pollMs: 1, timeoutMs: 500 });

    expect(snap.id).toBe(SNAPSHOT.id);
    expect(polls).toBe(2);
  });

  it('polls without allow_partial, which is what makes an absent row readable', async () => {
    const { rec, client: c } = client(anyRoute);
    const computer = await c.computers.get('vm-1');
    await computer.snapshot({ pollMs: 1 });
    const polled = rec.calls.filter((call) => call.path === '/snapshots' && call.method === 'GET');

    expect(polled.length).toBeGreaterThan(0);
    // A short listing has to arrive as a 503 this loop rides out. Opting into a
    // partial answer would turn a hypervisor that did not answer into a capture
    // reported as failed.
    for (const call of polled) expect(call.query).not.toHaveProperty('allow_partial');
  });

  it('hands back the placeholder under wait: false, and polls nothing', async () => {
    const { rec, client: c } = client(anyRoute);
    const computer = await c.computers.get('vm-1');
    const before = rec.calls.length;
    const held = await computer.snapshot({ wait: false });

    expect(held.capturing).toBe(true);
    expect(held.id).toBe(SNAPSHOT.id);
    expect(held.state).toBe('capturing');
    // The POST and nothing else: the caller asked to poll on their own schedule.
    expect(rec.calls.length).toBe(before + 1);
  });

  it('waits on a 202 whose state it cannot read, rather than calling it landed', async () => {
    // The status is the protocol's signal — 202 against 200 — and the transport
    // does not carry one, so the body decides. A `state` that arrives missing,
    // empty or not a string must therefore mean "there is something to wait
    // for": read the other way, this hands back a placeholder with no bytes and
    // an id that restore, clone and delete all 404 on, which is the whole of the
    // bug this change removes (/code-review).
    for (const state of [undefined, '', ['capturing'], 42]) {
      const { rec, client: c } = client((call) =>
        call.path.endsWith('/snapshots') && call.method === 'POST'
          ? json({ ...CAPTURE_ACCEPTED, state }, { status: 202 })
          : anyRoute(call),
      );
      const computer = await c.computers.get('vm-1');
      const before = rec.calls.length;
      const snap = await computer.snapshot({ pollMs: 1, timeoutMs: 500 });
      // The listing is what settles it, and it costs exactly one poll when the
      // row has in fact landed.
      expect(`${JSON.stringify(state)}: ${rec.calls.length - before}`).toBe(
        `${JSON.stringify(state)}: 2`,
      );
      expect(snap.state).toBe(SNAPSHOT.state);
      expect(snap.sizeBytes).toBe(SNAPSHOT.size_bytes);
    }
  });

  it('does not poll a platform that answered with a finished snapshot', async () => {
    // The pre-202 answer, which this half still has to work against: a row that
    // is not `capturing` is a stored snapshot and there is nothing to wait for.
    const { rec, client: c } = client((call) =>
      call.path.endsWith('/snapshots') && call.method === 'POST' ? json(SNAPSHOT) : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    const before = rec.calls.length;
    const snap = await computer.snapshot();

    expect(snap.id).toBe(SNAPSHOT.id);
    expect(snap.capturing).toBe(false);
    expect(rec.calls.length).toBe(before + 1);
  });
});

describe('a capture that fails', () => {
  it('is reported as a failed capture, not as a timeout, the moment its row goes', async () => {
    // A failure after the 202 has no response left to fail in: the platform
    // drops the `capturing` row and stores nothing, so the absence is the whole
    // signal. Said in its own sentence because the remedy differs — there is
    // nothing to find and nothing being billed, where a timeout leaves a
    // snapshot still coming.
    let polls = 0;
    const { client: c } = client(
      listing(() => {
        polls += 1;
        return json(polls < 2 ? [CAPTURE_ACCEPTED] : []);
      }),
    );
    const computer = await c.computers.get('vm-1');
    const err = await computer.snapshot({ pollMs: 1, timeoutMs: 30_000 }).catch((e) => e);

    expect(err).toBeInstanceOf(MandalaError);
    expect(err).not.toBeInstanceOf(TimeoutError);
    expect((err as Error).message).toContain('the capture of vm-1 failed');
    expect((err as Error).message).toContain(SNAPSHOT.id);
    // At once, on the poll that read the whole listing without it. Spending the
    // rest of a half-hour deadline to reach the same sentence with less in it
    // would be its own defect.
    expect(polls).toBe(2);
  });

  it('is not concluded from a listing this client could not read whole', async () => {
    // Rows nobody could decode might have been this one, so absence says
    // nothing — the same exception `waitForMove` makes, for the same reason.
    // The wait goes on and the deadline is left to be the answer.
    const { client: c } = client(listing(() => json([null, { id: 'snap-other' }])));
    const computer = await c.computers.get('vm-1');
    const err = await computer.snapshot({ pollMs: 1, timeoutMs: 40 }).catch((e) => e);

    expect(err).toBeInstanceOf(TimeoutError);
    expect((err as Error).message).toContain('that listing was short');
    // The wait ran out; it did not pronounce on the capture.
    expect((err as Error).message).not.toContain('the capture of vm-1 failed');
  });

  it('is not concluded from a listing the PLATFORM answered short', async () => {
    // The other half of the same rule, and the one a fan-out actually produces:
    // `X-GC-Incomplete` on a 200 is a hypervisor that did not answer, which is
    // not a capture that died.
    const { client: c } = client(
      listing(
        () =>
          new Response(JSON.stringify([]), {
            status: 200,
            headers: { 'content-type': 'application/json', 'X-GC-Incomplete': '1' },
          }),
      ),
    );
    const computer = await c.computers.get('vm-1');
    const err = await computer.snapshot({ pollMs: 1, timeoutMs: 40 }).catch((e) => e);

    expect(err).toBeInstanceOf(TimeoutError);
    expect((err as Error).message).toContain('that listing was short');
  });
});

describe('the wait itself', () => {
  it('says the capture has not stopped, only the waiting has', async () => {
    const { client: c } = client(listing(() => json([CAPTURE_ACCEPTED])));
    const computer = await c.computers.get('vm-1');
    const err = await computer.snapshot({ pollMs: 1, timeoutMs: 40 }).catch((e) => e);

    expect(err).toBeInstanceOf(TimeoutError);
    expect((err as Error).message).toContain('was still capturing');
    // The id is what a caller picks the wait back up with.
    expect((err as Error).message).toContain(SNAPSHOT.id);
  });

  it('does not say a capture it watched for a while never appeared', async () => {
    // Seen capturing, then the platform stops answering. "It never appeared" is
    // false of that wait and sends a reader looking for a capture that never
    // started; what is true is that the polls stopped reaching it.
    let polls = 0;
    const { client: c } = client(
      listing(() => {
        polls += 1;
        return polls < 2 ? json([CAPTURE_ACCEPTED]) : errorJson(503, 'a hypervisor is away');
      }),
    );
    const computer = await c.computers.get('vm-1');
    const err = await computer.snapshot({ pollMs: 1, timeoutMs: 60 }).catch((e) => e);

    expect(err).toBeInstanceOf(TimeoutError);
    expect((err as Error).message).toContain('could not be reached for the last part');
    expect((err as Error).message).toContain('it was still capturing');
    expect((err as Error).message).not.toContain('never appeared');
  });

  it('rides out a poll the platform failed, and does not ride out a 401', async () => {
    let polls = 0;
    const { client: c } = client(
      listing(() => {
        polls += 1;
        if (polls === 1) return errorJson(503, 'a hypervisor is away');
        return json([SNAPSHOT]);
      }),
    );
    const computer = await c.computers.get('vm-1');
    expect((await computer.snapshot({ pollMs: 1, timeoutMs: 5_000 })).id).toBe(SNAPSHOT.id);
    expect(polls).toBe(2);

    const { client: d } = client(listing(() => errorJson(401, 'that key is not valid')));
    const denied = await d.computers.get('vm-1');
    const err = await denied.snapshot({ pollMs: 1, timeoutMs: 5_000 }).catch((e) => e);
    // The 401 itself, rather than a timeout half an hour later that names
    // nothing about the key.
    expect(err).not.toBeInstanceOf(TimeoutError);
    expect((err as Error).message).toContain('that key is not valid');
  });

  it('counts a poll its own deadline cut short apart from one that failed', async () => {
    // A wait whose every attempt expired mid-request is not a wait the platform
    // failed, and a timeout that says "every poll failed" is a bill sent to the
    // wrong place.
    const { client: c } = client(
      listing(
        () =>
          new Promise<Response>(() => {
            /* never answers: every poll ends on this wait's own deadline */
          }) as unknown as Response,
      ),
    );
    const computer = await c.computers.get('vm-1');
    const err = await computer.snapshot({ pollMs: 1, timeoutMs: 60 }).catch((e) => e);

    expect(err).toBeInstanceOf(TimeoutError);
    expect((err as Error).message).toContain('no poll finished before the deadline did');
    expect((err as Error).message).not.toContain('every poll failed');
  });

  it('refuses its own numbers before a capture is started', async () => {
    // A number this refuses is a mistake in the CALL, and finding it after a
    // capture has begun is finding it too late to be worth anything — the
    // caller is then billed for a snapshot nobody is holding the id of.
    for (const bad of [{ timeoutMs: Number.NaN }, { pollMs: 0 }, { pollMs: Number.NaN }]) {
      const { rec, client: c } = client(anyRoute);
      const computer = await c.computers.get('vm-1');
      const before = rec.calls.length;
      await expect(computer.snapshot(bad)).rejects.toThrow(ValidationError);
      // And under wait: false too, where they are never used.
      await expect(computer.snapshot({ ...bad, wait: false })).rejects.toThrow(ValidationError);
      expect(rec.calls.length).toBe(before);
    }
  });

  it('refuses a wait flag that is not a boolean, before any request', async () => {
    const { rec, client: c } = client(anyRoute);
    const computer = await c.computers.get('vm-1');
    const before = rec.calls.length;
    for (const bad of ['false', 0, null]) {
      const err = await computer
        .snapshot({ wait: bad as unknown as boolean })
        .catch((e: unknown) => e);
      expect(`${JSON.stringify(bad)}: ${err instanceof TypeError}`).toBe(
        `${JSON.stringify(bad)}: true`,
      );
    }
    expect(rec.calls.length).toBe(before);
  });

  it('refuses a 202 that carries no id, whether or not it was going to wait', async () => {
    // The id is the whole content of an accepted capture: it is what a poll
    // matches, and no route answers "the capture you just started". A caller
    // handed one without it holds something that looks like a handle, cannot be
    // polled, and has a capture running with nobody holding its id.
    const { client: c } = client((call) =>
      call.path.endsWith('/snapshots') && call.method === 'POST'
        ? json({ ...CAPTURE_ACCEPTED, id: '' }, { status: 202 })
        : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    for (const opts of [{ pollMs: 1, timeoutMs: 40 }, { wait: false }]) {
      const err = await computer.snapshot(opts).catch((e) => e);
      expect(err).toBeInstanceOf(MandalaError);
      expect((err as Error).message).toContain('expected a snapshot from POST');
    }
  });
});

describe('a capture in flight, on the listing', () => {
  it('reads as `capturing` off the raw state, and not off a coercion', async () => {
    // `String(['capturing'])` is `'capturing'`, so a coerced test would let a
    // malformed row stand for a capture still running — and this wait would then
    // poll a row it can never classify until its deadline. The safe direction
    // for this field is the one `durable` takes: a value nobody can classify is
    // not a claim.
    const { client: c } = client(
      listing(() => json([{ ...SNAPSHOT, state: ['capturing'] }, CAPTURE_ACCEPTED])),
    );
    const listed = await c.snapshots.list();
    expect(listed.map((s) => s.capturing)).toEqual([false, true]);
  });
});
