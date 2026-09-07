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
    //
    // A MISSPELT in-flight state is on the list for the reason an absent one is:
    // `capturin` is exactly as unreadable, and under "anything but capturing" it
    // read as landed — the same bug through a typo rather than an omission
    // (Codex review, gpt-5.6-sol).
    for (const state of [undefined, '', ['capturing'], 42, 'capturin', 'CAPTURING']) {
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

// OPL-4575. `DELETE /v1/snapshots/:id` answers 202 with the snapshot's row and
// runs the deletion afterwards (platform OPL-4572), and this SDK treated a
// DELETE as settled when it answered — correct against the 200, wrong against
// the 202, and a caller was told a snapshot was gone while it was still being
// destroyed.
//
// The mirror of the capture above, with the polarity reversed: a capture waits
// for a row to stop reading `capturing`, a deletion waits for the row to leave
// the listing. Reversed polarity is reversed danger, which is what most of these
// pin — there, reading absence wrongly reports a failure that did not happen;
// here it reports a snapshot as destroyed while it is still on a host.

/** The unfinished listing, which is the only one a deletion poll asks for. */
const unfinished = (rows: (call: { path: string }) => Response): Responder => {
  return (call) =>
    call.path === '/snapshots' && call.method === 'GET' ? rows(call) : anyRoute(call);
};

const DELETING = { ...SNAPSHOT, state: 'deleting' };

describe('snapshots.delete() waits for the row to go', () => {
  it('returns when the row has left the listing, not when the DELETE answers', async () => {
    let polls = 0;
    const { client: c } = client(
      unfinished(() => {
        polls += 1;
        return json(polls < 3 ? [DELETING] : []);
      }),
    );
    await c.snapshots.delete('snap-1', { pollMs: 1 });
    expect(polls).toBe(3);
  });

  it('waits on whatever state the 202 carries, because the answer does not say', async () => {
    // THE 202 DOES NOT SAY `deleting`. The intent is committed only after the
    // dependents are flattened — the sweep destroys what it finds in that state
    // WITHOUT flattening — so the row comes back exactly as it stood, which the
    // deployed platform confirmed by answering `durable` here. A client waiting
    // for the answer to say `deleting` would wait for something that never
    // comes; one reading the unchanged state as "nothing was accepted" would not
    // wait at all. So the body decides nothing and the listing decides
    // everything, and this holds for any state the 202 might carry.
    for (const state of ['durable', 'pending', 'deleting', undefined]) {
      let polls = 0;
      const { client: c } = client((call) => {
        if (call.method === 'DELETE') return json({ ...SNAPSHOT, state }, { status: 202 });
        if (call.path !== '/snapshots' || call.method !== 'GET') return anyRoute(call);
        polls += 1;
        return json(polls < 2 ? [SNAPSHOT] : []);
      });
      await c.snapshots.delete('snap-1', { pollMs: 1, timeoutMs: 5_000 });
      expect(`${state}: ${polls}`).toBe(`${state}: 2`);
    }
  });

  it('asks with include=unfinished, without which a stall reads as a deletion', async () => {
    // Not optional and not a nicety. Once the dependents are detached the daemon
    // marks the snapshot `deleting`, and a BARE listing leaves that state out —
    // so a poll without the flag reads a deletion that stalled as one that
    // finished, on the very first poll, and says a snapshot is gone while it is
    // still holding objects and still being billed.
    const { rec, client: c } = client(unfinished(() => json([])));
    await c.snapshots.delete('snap-1', { pollMs: 1 });
    const polled = rec.calls.filter((call) => call.path === '/snapshots' && call.method === 'GET');

    expect(polled.length).toBeGreaterThan(0);
    for (const call of polled) {
      expect(call.query.include).toBe('unfinished');
      // And without `allow_partial`, so a hypervisor that did not answer is a
      // 503 this loop rides out rather than a short listing read as a row that
      // is gone.
      expect(call.query).not.toHaveProperty('allow_partial');
    }
  });

  it('matches on the id, so somebody else’s deletion does not hold this one', async () => {
    const other = { ...SNAPSHOT, id: 'snap-other', state: 'deleting' };
    const { client: c } = client(unfinished(() => json([other])));
    await c.snapshots.delete('snap-1', { pollMs: 1, timeoutMs: 5_000 });
  });

  it('does not sit out the full interval on a deletion that finishes at once', async () => {
    // A deletion is usually seconds — 436ms for a lone snapshot at `pending` on
    // the deployed fleet — so a flat five-second interval would make the
    // ordinary call ten times slower than the synchronous one it replaced. The
    // sleep ramps from 250ms toward `pollMs` instead, so the first poll after
    // the 202 is not held behind a capture-sized interval (/code-review).
    let polls = 0;
    const { client: c } = client(
      unfinished(() => {
        polls += 1;
        return json(polls < 3 ? [SNAPSHOT] : []);
      }),
    );
    const before = Date.now();
    await c.snapshots.delete('snap-1', { timeoutMs: 60_000 });
    const took = Date.now() - before;

    expect(polls).toBe(3);
    // Two sleeps at the default 5000 ceiling would be 10s; ramped they are
    // 250ms and 500ms. Bounded generously — this pins the ramp, not a stopwatch.
    expect(took).toBeLessThan(3_000);
  });

  it('takes pollMs as a ceiling, so a caller’s own interval is never exceeded', async () => {
    // The ramp may only ever make a wait poll SOONER than asked. A caller who
    // set an interval to be kind to the platform must still get it.
    const { rec, client: c } = client(unfinished(() => json([SNAPSHOT])));
    const before = Date.now();
    await c.snapshots.delete('snap-1', { pollMs: 20, timeoutMs: 300 }).catch(() => {});
    const polled = rec.calls.filter((call) => call.path === '/snapshots' && call.method === 'GET');
    const elapsed = Date.now() - before;

    // At the 20ms ceiling a 300ms wait cannot fit more than ~16 polls; a ramp
    // that ignored the ceiling and kept doubling would fit far fewer, and one
    // that ignored it downward would fit far more.
    expect(polled.length).toBeGreaterThan(4);
    expect(polled.length).toBeLessThanOrEqual(Math.ceil(elapsed / 20) + 2);
  });

  it('returns at the 202 under wait: false, and polls nothing', async () => {
    const { rec, client: c } = client(anyRoute);
    const before = rec.calls.length;
    await c.snapshots.delete('snap-1', { wait: false });

    expect(rec.calls.length).toBe(before + 1);
    expect(rec.last().method).toBe('DELETE');
    expect(rec.last().path).toBe('/snapshots/snap-1');
  });

  it('costs one listing against a platform that deleted inside the request', async () => {
    // The pre-202 answer, 200 `{"ok":true}`, which this half still has to work
    // against. No predicate reads that body — the wait's own terminating
    // condition is already true of it, so the older platform costs one listing
    // and returns rather than needing an `acceptedCapture` of its own.
    const { rec, client: c } = client((call) =>
      call.method === 'DELETE' ? json({ ok: true }) : unfinished(() => json([]))(call),
    );
    const before = rec.calls.length;
    await c.snapshots.delete('snap-1', { pollMs: 1 });
    expect(rec.calls.length).toBe(before + 2);
  });
});

describe('a deletion that does not finish', () => {
  it('is reported as a deletion that stalled, with the platform’s own remedy', async () => {
    // A row that STAYS is the opposite polarity to a capture, where a row that
    // GOES is the failure. The remedy differs too and has to be said: the daemon
    // retries these itself every fifteen minutes, and a fresh delete of the same
    // id is accepted rather than refused.
    const { client: c } = client(unfinished(() => json([DELETING])));
    const err = await c.snapshots.delete('snap-1', { pollMs: 1, timeoutMs: 40 }).catch((e) => e);

    expect(err).toBeInstanceOf(TimeoutError);
    expect((err as Error).message).toContain('the deletion of snap-1 stalled');
    expect((err as Error).message).toContain('every fifteen minutes');
    expect((err as Error).message).toContain('still billed');
  });

  it('does not call a row in another state a stall, because the remedy differs', async () => {
    // `deleting` is committed AFTER the dependents are flattened, deliberately:
    // the platform's fifteen-minute sweep destroys what it finds in that state
    // without flattening, so a row marked deleting whose children were never
    // detached is a chain the next sweep breaks. The consequence for this
    // message is the whole point of splitting it — a row still reading `durable`
    // is one the sweep will never pick up, so "the platform retries these every
    // fifteen minutes" is false of it and the remedy is another delete.
    //
    // It is also the one conflict that arrives AFTER the 202: a dependent that
    // is itself being deleted cannot be flattened, and the delete fails there
    // having destroyed nothing.
    const { client: c } = client(unfinished(() => json([SNAPSHOT])));
    const err = await c.snapshots.delete('snap-1', { pollMs: 1, timeoutMs: 40 }).catch((e) => e);

    expect(err).toBeInstanceOf(TimeoutError);
    expect((err as Error).message).toContain('was still listed after');
    expect((err as Error).message).toContain('"durable"');
    expect((err as Error).message).toContain('destroyed nothing');
    expect((err as Error).message).toContain('deleting the id again');
    expect((err as Error).message).not.toContain('stalled');
  });

  it('reads the row on the unfinished view, not the one a bare listing would give', async () => {
    // The two views split exactly where a stall lives: a `deleting` row is left
    // out of a bare listing, so a poll reading that view sees an account the
    // snapshot has already left. Answered here as the platform splits them — the
    // bare listing without the row, the unfinished one with it — so a wait that
    // dropped the flag would return at once and call a stalled deletion done.
    const { rec, client: c } = client((call) => {
      if (call.path !== '/snapshots' || call.method !== 'GET') return anyRoute(call);
      return json(call.query.include === 'unfinished' ? [DELETING] : []);
    });
    const err = await c.snapshots.delete('snap-1', { pollMs: 1, timeoutMs: 40 }).catch((e) => e);

    expect(err).toBeInstanceOf(TimeoutError);
    expect((err as Error).message).toContain('stalled');
    const polled = rec.calls.filter((call) => call.path === '/snapshots' && call.method === 'GET');
    expect(polled.every((call) => call.query.include === 'unfinished')).toBe(true);
  });

  it('names an unreadable state once, rather than encoding it twice', async () => {
    // The state is the whole content of this branch, and it decides what the
    // caller does next. Held as a string and encoded again at the point of use,
    // a numeric 42 read back as the string `"42"` and an ABSENT state went
    // through `JSON.stringify(undefined)` — which answers the value `undefined`
    // rather than a string — to render as bare `undefined` out of a variable
    // typed `string` (/code-review).
    for (const [state, shown] of [
      [42, '42'],
      [['deleting'], '["deleting"]'],
      [undefined, 'undefined'],
      ['durable', '"durable"'],
    ] as const) {
      const row: Record<string, unknown> = { ...SNAPSHOT, state };
      if (state === undefined) delete row.state;
      const { client: c } = client(unfinished(() => json([row])));
      const err = await c.snapshots.delete('snap-1', { pollMs: 1, timeoutMs: 40 }).catch((e) => e);

      expect(err).toBeInstanceOf(TimeoutError);
      expect(`${shown}: ${(err as Error).message}`).toContain(`in state ${shown} rather than`);
    }
  });

  it('is not concluded gone over a row whose id this poll could not match on', async () => {
    // The hole `incomplete` does not cover, and the one that runs the dangerous
    // way (/code-review). The match is strict equality on the RAW id, precisely
    // so `String(['snap-1'])` cannot stand in for this snapshot — but a row
    // carrying `['snap-1']` is still a record, so the transport keeps it and
    // counts no shortfall, and the row is then missing from a listing that reads
    // whole. Returning on that says a snapshot is destroyed while it is still on
    // a host, still holding objects and still billed.
    for (const id of [['snap-1'], 42, null, undefined]) {
      const row: Record<string, unknown> = { ...SNAPSHOT, id };
      if (id === undefined) delete row.id;
      const { client: c } = client(unfinished(() => json([row])));
      const err = await c.snapshots.delete('snap-1', { pollMs: 1, timeoutMs: 40 }).catch((e) => e);

      // The wait ran out; it did not pronounce the snapshot gone.
      expect(`${JSON.stringify(id)}: ${err instanceof TimeoutError}`).toBe(
        `${JSON.stringify(id)}: true`,
      );
      expect((err as Error).message).toContain('that listing was short');
    }
  });

  it('is not concluded gone from a listing this client could not read whole', async () => {
    // The rule that matters most in this direction. Rows nobody could decode
    // might have been this one, so absence says NOTHING — and reading it as
    // "gone" reports a snapshot as destroyed while it is still on a host, still
    // holding objects and still billed.
    const { client: c } = client(unfinished(() => json([null, { id: 'snap-other' }])));
    const err = await c.snapshots.delete('snap-1', { pollMs: 1, timeoutMs: 40 }).catch((e) => e);

    expect(err).toBeInstanceOf(TimeoutError);
    expect((err as Error).message).toContain('that listing was short');
  });

  it('is not concluded gone from a listing the PLATFORM answered short', async () => {
    const { client: c } = client(
      unfinished(
        () =>
          new Response(JSON.stringify([]), {
            status: 200,
            headers: { 'content-type': 'application/json', 'X-GC-Incomplete': '1' },
          }),
      ),
    );
    const err = await c.snapshots.delete('snap-1', { pollMs: 1, timeoutMs: 40 }).catch((e) => e);

    expect(err).toBeInstanceOf(TimeoutError);
    expect((err as Error).message).toContain('that listing was short');
  });

  it('does not say a row it watched for a while was still listed at the end', async () => {
    // Seen, then the platform stops answering. "It was still listed" is a claim
    // about the present tense made from an observation the polls since have not
    // confirmed, and it sends a reader to the stall remedy for a wait that
    // simply lost the platform.
    let polls = 0;
    const { client: c } = client(
      unfinished(() => {
        polls += 1;
        return polls < 2 ? json([DELETING]) : errorJson(503, 'a hypervisor is away');
      }),
    );
    const err = await c.snapshots.delete('snap-1', { pollMs: 1, timeoutMs: 60 }).catch((e) => e);

    expect(err).toBeInstanceOf(TimeoutError);
    expect((err as Error).message).toContain('could not be reached for the last part');
    expect((err as Error).message).not.toContain('stalled');
  });

  it('rides out a poll the platform failed, and does not ride out a 401', async () => {
    let polls = 0;
    const { client: c } = client(
      unfinished(() => {
        polls += 1;
        return polls === 1 ? errorJson(503, 'a hypervisor is away') : json([]);
      }),
    );
    await c.snapshots.delete('snap-1', { pollMs: 1, timeoutMs: 5_000 });
    expect(polls).toBe(2);

    const { client: d } = client(unfinished(() => errorJson(401, 'that key is not valid')));
    const err = await d.snapshots.delete('snap-1', { pollMs: 1, timeoutMs: 5_000 }).catch((e) => e);
    expect(err).not.toBeInstanceOf(TimeoutError);
    expect((err as Error).message).toContain('that key is not valid');
  });

  it('counts a poll its own deadline cut short apart from one that failed', async () => {
    const { client: c } = client(
      unfinished(
        () =>
          new Promise<Response>(() => {
            /* never answers: every poll ends on this wait's own deadline */
          }) as unknown as Response,
      ),
    );
    const err = await c.snapshots.delete('snap-1', { pollMs: 1, timeoutMs: 60 }).catch((e) => e);

    expect(err).toBeInstanceOf(TimeoutError);
    expect((err as Error).message).toContain('no poll finished before the deadline did');
    expect((err as Error).message).not.toContain('every poll failed');
  });
});

describe('the deletion wait’s own numbers', () => {
  it('refuses them before anything is deleted, wait: false included', async () => {
    // A number this refuses is a mistake in the CALL, and finding it after a
    // deletion has begun is finding it too late to matter: the snapshot is
    // already going and the caller has no wait to hold it with.
    for (const bad of [{ timeoutMs: Number.NaN }, { pollMs: 0 }, { pollMs: Number.NaN }]) {
      const { rec, client: c } = client(anyRoute);
      const before = rec.calls.length;
      await expect(c.snapshots.delete('snap-1', bad)).rejects.toThrow(ValidationError);
      await expect(c.snapshots.delete('snap-1', { ...bad, wait: false })).rejects.toThrow(
        ValidationError,
      );
      expect(rec.calls.length).toBe(before);
    }
  });

  it('refuses a wait flag that is not a boolean, before any request', async () => {
    const { rec, client: c } = client(anyRoute);
    const before = rec.calls.length;
    for (const bad of ['false', 0, null]) {
      const err = await c.snapshots
        .delete('snap-1', { wait: bad as unknown as boolean })
        .catch((e: unknown) => e);
      expect(`${JSON.stringify(bad)}: ${err instanceof TypeError}`).toBe(
        `${JSON.stringify(bad)}: true`,
      );
    }
    expect(rec.calls.length).toBe(before);
  });
});
