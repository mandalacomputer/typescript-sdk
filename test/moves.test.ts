/** The resize that needs the computer moved, from the refusal to the outcome. */

import { describe, expect, it } from 'vitest';
import {
  Client,
  ConflictError,
  isTransient,
  MandalaError,
  type Move,
  type MoveArgs,
  MoveRequiredError,
  TimeoutError,
  ValidationError,
} from '../src/index.js';
import {
  anyRoute,
  BASE,
  errorJson,
  json,
  MOVE_DONE,
  MOVE_STARTED,
  type Responder,
  recorder,
} from './harness.js';

// OPL-3773. A resize past what a computer's host can run is refused with an
// OFFER — `move: {required, possible}` on the body — and this SDK bound neither
// half of it. There was no method to take it up, and `isTransient` said the
// refusal was worth retrying, which it never is: the host cannot run that size
// and will not grow.
//
// So what is pinned here is the seam rather than the move. The platform's own
// tests own whether a move works; these own whether a caller can tell this 409
// from the ones that clear, and whether the four terminal states stay four
// different things — `moved` most of all, because that is the one where the
// computer HAS changed hardware and reading it as a failure sends somebody
// looking for a machine that is no longer where it was.

const client = (respond: Responder) => {
  const rec = recorder(respond);
  return { rec, client: new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch }) };
};

/** A 409 carrying the platform's move offer, which is what makes it one. */
const offering = (possible: boolean): Responder => {
  return (call) =>
    call.method === 'PATCH'
      ? json(
          {
            error: '26000 MB of RAM is more than the host this computer is on can run.',
            move: { required: true, possible },
          },
          { status: 409 },
        )
      : anyRoute(call);
};

describe('the refusal that offers a move', () => {
  it('arrives as its own class, with the branch already read off the body', async () => {
    const { client: c } = client(offering(true));
    const computer = await c.computers.get('vm-1');
    const err = await computer.update({ ramMb: 26000 }).catch((e) => e);

    expect(err).toBeInstanceOf(MoveRequiredError);
    expect((err as MoveRequiredError).movePossible).toBe(true);
    // The platform's own sentence survives: it is the account of what will not
    // fit and what moving costs, written for whoever has to agree to it.
    expect((err as Error).message).toContain('more than the host this computer is on can run');
  });

  it('says so when there is nowhere in the region to move to', async () => {
    const { client: c } = client(offering(false));
    const computer = await c.computers.get('vm-1');
    const err = await computer.update({ ramMb: 999_999 }).catch((e) => e);
    // Still a MoveRequiredError — the resize still needs a move — and the flag
    // is what says there is nothing to call. `move.required` is true in both
    // cases, which is exactly why the second field is the one read.
    expect(err).toBeInstanceOf(MoveRequiredError);
    expect((err as MoveRequiredError).movePossible).toBe(false);
  });

  it('is not retryable, while every other conflict still is', async () => {
    // The bug, as two lines. isTransient is what the wait helpers retry on and
    // what a caller wraps their own loop in; before this it said yes to a
    // refusal that answers the same way forever.
    expect(isTransient(new MoveRequiredError('needs a move', 409, {}, true))).toBe(false);
    expect(isTransient(new ConflictError('the guest agent is not answering yet', 409))).toBe(true);
  });

  it('is still a ConflictError, so code matching the family keeps working', () => {
    // A subclass rather than a sibling: a caller branching on ConflictError to
    // render "the computer is in the wrong state for this" should go on doing
    // so. What changes is only the answer to "should I try again".
    expect(new MoveRequiredError('needs a move', 409, {}, false)).toBeInstanceOf(ConflictError);
  });

  it('leaves an ordinary 409 alone', async () => {
    const { client: c } = client((call) =>
      call.method === 'PATCH' ? errorJson(409, 'this computer is running') : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    const err = await computer.update({ ramMb: 4096 }).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect(err).not.toBeInstanceOf(MoveRequiredError);
    expect(isTransient(err)).toBe(true);
  });

  it('is not fooled by a body with a move-shaped key that is not one', async () => {
    // Absent and malformed get the same answer, and it is the conservative one.
    // A `move` that is a string, or an object with no boolean `possible`, must
    // not become an offer with `movePossible` quietly false — that would tell a
    // caller nowhere in the region can run their size on the strength of a field
    // nobody sent.
    for (const move of ['yes', { required: true }, { possible: true }, null]) {
      const { client: c } = client((call) =>
        call.method === 'PATCH'
          ? json({ error: 'refused', move }, { status: 409 })
          : anyRoute(call),
      );
      const computer = await c.computers.get('vm-1');
      const err = await computer.update({ ramMb: 4096 }).catch((e) => e);
      expect(`${JSON.stringify(move)}: ${err instanceof MoveRequiredError}`).toBe(
        `${JSON.stringify(move)}: false`,
      );
      expect(err).toBeInstanceOf(ConflictError);
    }
  });
});

describe('relocate', () => {
  it('sends the sizing group to the move route and answers the 202', async () => {
    const { rec, client: c } = client(anyRoute);
    const computer = await c.computers.get('vm-1');
    const move = await computer.relocate({ ramMb: 26000, cpu: 2 });

    const post = rec.calls.find((call) => call.method === 'POST');
    expect(post?.path).toBe('/computers/vm-1/move');
    expect(post?.body).toEqual({ ram_mb: 26000, cpu: 2 });
    // The 202, as the operation stood when it was accepted — not the outcome.
    // A method that pretended otherwise would report every move as finished the
    // instant it started.
    expect(move.live).toBe(true);
    expect(move.state).toBe('moving');
    expect(move.ramMb).toBe(26000);
  });

  it('refuses a call that could only ever be refused', async () => {
    // ramMb is required, unlike on update: the platform fills an omitted one
    // from the computer's current size and then refuses the move for not
    // needing one. Caught here rather than three tiers away.
    const { rec, client: c } = client(anyRoute);
    const computer = await c.computers.get('vm-1');
    // Cast because the point is the RUNTIME guard behind the type: a caller in
    // plain JavaScript, or one building args from a config file, reaches this.
    await expect(computer.relocate({ cpu: 4 } as unknown as MoveArgs)).rejects.toThrow(
      /ramMb is required/,
    );
    expect(rec.calls.some((call) => call.path.endsWith('/move'))).toBe(false);
  });

  it('has no room for a rename, which the platform would drop in silence', async () => {
    // MoveArgs carries the three sizing fields and nothing else. The platform
    // reads only those off a move body, so a name accepted here would be a
    // rename that copied a multi-gigabyte disk between hosts and then did not
    // happen.
    const { rec, client: c } = client(anyRoute);
    const computer = await c.computers.get('vm-1');
    // Cast for the same reason: what is being proved is the wire body, and a
    // caller who cannot spell this in TypeScript can still send it from JS.
    await computer.relocate({ ramMb: 26000, name: 'renamed' } as unknown as MoveArgs);
    const post = rec.calls.find((call) => call.method === 'POST');
    expect(post?.body).toEqual({ ram_mb: 26000 });
  });

  it('refuses a 202 with no readable started_at, naming the route', async () => {
    // `toMove` coerces an absent `started_at` to `''`, so a 202 that omitted or
    // renamed it returned from here looking perfectly well-formed — and then the
    // very next documented line, `await c.waitForMove(move)`, threw a
    // ValidationError about the value this method had just handed back, in the
    // class reserved for caller mistakes. The platform's omission is the
    // platform's, and a move with no start is a move nothing can be anchored to.
    const { client: c } = client((call) =>
      call.path.endsWith('/move') && call.method === 'POST'
        ? json({ ...MOVE_STARTED, started_at: undefined }, { status: 202 })
        : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    const err = await computer.relocate({ ramMb: 26000 }).catch((e) => e);

    expect(err).toBeInstanceOf(MandalaError);
    expect(err).not.toBeInstanceOf(ValidationError);
    expect((err as Error).message).toContain('POST computers/vm-1/move');
    expect((err as Error).message).toContain('started_at');
  });
});

// The anchor every wait below is started from, and the one the harness's own
// rows carry. The platform keys `computer_moves` by computer id and writes with
// `INSERT OR REPLACE`, so a row of this computer's is this move exactly when its
// `started_at` equals the anchor — and a row carrying a different one is this
// move's row having been replaced by a later relocate.
const SINCE = MOVE_STARTED.started_at;

describe('waitForMove', () => {
  it('answers the move once it has stopped running', async () => {
    const { client: c } = client(anyRoute);
    const computer = await c.computers.get('vm-1');
    const accepted = await computer.relocate({ ramMb: 26000 });
    const move = await computer.waitForMove(accepted, { pollMs: 1 });
    expect(move.live).toBe(false);
    expect(move.state).toBe('done');
    expect(move.finishedAt).toBeTruthy();
  });

  it('keeps polling while the row it can see is another computer’s', async () => {
    // The ordinary life of a move accepted a moment ago: not visible yet, then
    // live, then finished. A row the platform wrote seconds ago need not be on
    // an account-wide listing at the first poll, and what is on it meanwhile —
    // here another computer's day-old row — is not an answer about this one.
    const elsewhere = {
      ...MOVE_DONE,
      computer_id: 'vm-other',
      started_at: '2026-08-22T01:00:00.000Z',
      finished_at: '2026-08-22T02:00:00.000Z',
    };
    let polls = 0;
    const { client: c } = client((call) => {
      if (call.path !== '/moves') return anyRoute(call);
      polls += 1;
      if (polls === 1) return json({ moves: [elsewhere] });
      if (polls === 2) return json({ moves: [elsewhere, MOVE_STARTED] });
      return json({ moves: [elsewhere, MOVE_DONE] });
    });
    const computer = await c.computers.get('vm-1');
    const accepted = await computer.relocate({ ramMb: 26000 });
    const move = await computer.waitForMove(accepted, { pollMs: 1, timeoutMs: 2_000 });

    // The identity of the row first: `state: 'done'` is true of the other
    // computer's row as well, so the stamp is what tells the two apart.
    expect(move.startedAt).toBe(MOVE_STARTED.started_at);
    expect(polls).toBe(3);
    expect(move.state).toBe('done');
    expect(move.live).toBe(false);
  });

  it('takes an RFC3339 timestamp in place of the move', async () => {
    // For the process that restarted: the `startedAt` it persisted is the same
    // string the Move carries, which is the whole of what the match needs.
    const { client: c } = client(anyRoute);
    const computer = await c.computers.get('vm-1');
    expect((await computer.waitForMove(SINCE, { pollMs: 1 })).state).toBe('done');
  });

  it('refuses a timestamp it cannot place, before any request', async () => {
    // The shape test earns its place by catching a typo before any request is
    // made. A stamp with no zone is the one worth naming: it reads as a valid
    // instant to `Date.parse` and as an instant hours from the one it spells,
    // which is a sign the caller re-formatted a stamp rather than persisting the
    // platform's own — and a re-formatted stamp matches no row at all.
    const { rec, client: c } = client(anyRoute);
    const computer = await c.computers.get('vm-1');
    const before = rec.calls.length;
    for (const bad of ['yesterday', '2026-08-23 01:00:00', '2026-08-23T01:00:00', '', 'Z']) {
      const err = await computer.waitForMove(bad, { pollMs: 1, timeoutMs: 50 }).catch((e) => e);
      expect(`${bad}: ${err instanceof ValidationError}`).toBe(`${bad}: true`);
      expect((err as Error).message).toContain('move must be');
    }
    expect(rec.calls.length).toBe(before);
  });

  it('refuses a move whose startedAt the platform never sent', async () => {
    // `str(undefined)` is `''`, so an omitted `started_at` reaches this as an
    // empty string. A wait anchored to nothing would be the wait this argument
    // was added to replace.
    const { client: c } = client(anyRoute);
    const computer = await c.computers.get('vm-1');
    const err = await computer
      .waitForMove({ ...MOVE_DONE, startedAt: '' } as unknown as Move)
      .catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as Error).message).toContain('no readable startedAt');
  });

  it('says the row is gone once it has been seen and then is not, twice running', async () => {
    // The one disappearance that is evidence rather than inference: the row was
    // there, so it existed, and a row leaves this listing for reasons that are
    // all terminal for the wait. Waiting out the rest of a fifteen-minute
    // deadline to say so is what this branch exists to avoid — and two polls
    // rather than one is what keeps it from firing on a replica that is merely
    // behind.
    let polls = 0;
    const { client: c } = client((call) => {
      if (call.path !== '/moves') return anyRoute(call);
      polls += 1;
      return json({ moves: polls === 1 ? [MOVE_STARTED] : [] });
    });
    const computer = await c.computers.get('vm-1');
    const err = await computer.waitForMove(SINCE, { pollMs: 1, timeoutMs: 5_000 }).catch((e) => e);

    expect(err).toBeInstanceOf(MandalaError);
    expect(err).not.toBeInstanceOf(TimeoutError);
    expect((err as Error).message).toContain('no longer listed');
    // The wording has to leave room for the second way a row leaves: `Moves.list`
    // says this listing holds the finished moves that have not been DISMISSED,
    // so "the computer was deleted" is one cause asserted off an observation
    // that has two.
    expect((err as Error).message).toContain('dismissed');
    expect(polls).toBe(3);
  });

  it('keeps polling when the row is missing from one poll and back on the next', async () => {
    // The listing is eventually consistent — that premise is the whole reason
    // "not visible yet" is a branch at all — so a replica running behind can
    // drop a row it served a moment ago. Ending a healthy wait on one such poll
    // is the same false claim about a live computer, reached from the other
    // side, and it is unrecoverable: a MandalaError, not a retry.
    let polls = 0;
    const { client: c } = client((call) => {
      if (call.path !== '/moves') return anyRoute(call);
      polls += 1;
      if (polls === 1) return json({ moves: [MOVE_STARTED] });
      if (polls === 2) return json({ moves: [] });
      return json({ moves: [MOVE_DONE] });
    });
    const computer = await c.computers.get('vm-1');
    const move = await computer.waitForMove(SINCE, { pollMs: 1, timeoutMs: 5_000 });

    expect(move.state).toBe('done');
    expect(polls).toBe(3);
  });

  it('fails at once when this computer’s row carries a different startedAt', async () => {
    // THE ONE THING THE ANCHOR IS FOR. `computer_moves` is keyed by computer id
    // and written with `INSERT OR REPLACE`, so a second relocate on this
    // computer does not add a row — it OVERWRITES this move's. Without the
    // anchor the wait reads the newer move's `state` and `detail` and reports
    // them as the outcome of the relocate the caller asked about; here the row
    // says `failed` where the anchored move was mid-copy, which is somebody
    // being told a move did not happen while their disk crosses between hosts.
    //
    // And it fails on the FIRST poll rather than polling on: the replacement
    // cannot un-happen, and this move's outcome is no longer recorded anywhere,
    // so spending fifteen minutes to say the same thing is its own defect.
    const replaced = {
      ...MOVE_DONE,
      state: 'failed',
      detail: 'somebody else’s relocate',
      started_at: '2026-08-23T02:40:00.000Z',
      finished_at: '2026-08-23T02:41:00.000Z',
    };
    let polls = 0;
    const { client: c } = client((call) => {
      if (call.path !== '/moves') return anyRoute(call);
      polls += 1;
      return json({ moves: [replaced] });
    });
    const computer = await c.computers.get('vm-1');
    const err = await computer.waitForMove(SINCE, { pollMs: 1, timeoutMs: 5_000 }).catch((e) => e);

    expect(err).toBeInstanceOf(MandalaError);
    expect(err).not.toBeInstanceOf(TimeoutError);
    // Both stamps, because "a newer move replaced it" is a claim the reader has
    // to be able to check — and the one they persisted is half of it.
    expect((err as Error).message).toContain(SINCE);
    expect((err as Error).message).toContain('2026-08-23T02:40:00.000Z');
    expect((err as Error).message).toContain('replaced');
    // Fast, not a timeout dressed up as an error.
    expect(polls).toBe(1);
  });

  it('does not read a replaced row as the move having vanished', async () => {
    // The two ways this computer's row can stop being this move's row, told
    // apart. A row that is GONE is the computer deleted or the move dismissed —
    // a sentence about a listing. A row that is present and carries somebody
    // else's stamp is a relocate that took the computer over, which is a
    // sentence about a move, and it must not be reported as the first.
    const { client: c } = client((call) =>
      call.path === '/moves'
        ? json({ moves: [{ ...MOVE_DONE, started_at: '2026-08-23T02:40:00.000Z' }] })
        : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    const err = await computer.waitForMove(SINCE, { pollMs: 1, timeoutMs: 5_000 }).catch((e) => e);

    expect(err).toBeInstanceOf(MandalaError);
    expect((err as Error).message).not.toContain('no longer listed');
    expect((err as Error).message).not.toContain('deleted');
  });

  it('answers from the anchored row when it goes from live to terminal', async () => {
    // Outcome A, both halves. The same row throughout — one row per computer is
    // what the platform stores — so what changes between polls is the row's
    // state and not which row is being read. Live keeps the wait going; the
    // first terminal reading of it is the answer.
    let polls = 0;
    const { client: c } = client((call) => {
      if (call.path !== '/moves') return anyRoute(call);
      polls += 1;
      return json({ moves: [polls < 3 ? MOVE_STARTED : MOVE_DONE] });
    });
    const computer = await c.computers.get('vm-1');
    const move = await computer.waitForMove(SINCE, { pollMs: 1, timeoutMs: 5_000 });

    expect(polls).toBe(3);
    expect(move.startedAt).toBe(SINCE);
    expect(move.state).toBe('done');
    expect(move.live).toBe(false);
    // `finished_at: null` on the live rows is the wire saying absent; the
    // terminal one carries the real stamp.
    expect(move.finishedAt).toBe(MOVE_DONE.finished_at);
  });

  it('matches a row the platform rendered to whole seconds', async () => {
    // The regression an earlier round of this method introduced, pinned so it
    // cannot come back. Nothing says the platform prints milliseconds: it
    // stores one string and hands the same one to the 202 and to the listing,
    // and a whole-second spelling is as valid as any other. A rule that read
    // those stamps as NUMBERS and vetoed a row dated as finished "before" the
    // anchor threw away the only row this move will ever have — after which the
    // wait went on to report the computer as deleted. Equality on the string
    // has no arithmetic in it and so has nowhere to go wrong.
    const second = '2026-08-23T02:00:12Z';
    const row = { ...MOVE_DONE, started_at: second, finished_at: second };
    const { client: c } = client((call) =>
      call.path === '/moves' ? json({ moves: [row] }) : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    const move = await computer.waitForMove(second, { pollMs: 1, timeoutMs: 300 });

    expect(move.startedAt).toBe(second);
    expect(move.state).toBe('done');
  });

  it('does not say every poll failed when no poll failed', async () => {
    // A poll cut short by this wait's OWN deadline is a `continue` that
    // increments nothing — not the reads, not the failures — so a wait whose
    // only poll ended that way arrived at the last branch with both at zero and
    // announced that every poll had failed. Nothing had failed; the wait had
    // simply not been given long enough to finish one.
    const { client: c } = client((call) =>
      call.path === '/moves' ? new Promise<Response>(() => {}) : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    const err = await computer.waitForMove(SINCE, { pollMs: 1, timeoutMs: 40 }).catch((e) => e);

    expect(err).toBeInstanceOf(TimeoutError);
    expect((err as Error).message).not.toContain('every poll failed');
    expect((err as Error).message).toContain('no poll finished before the deadline');
  });

  it('does not say every poll failed when only the first of several did', async () => {
    // `failures` counts transient failures and NOTHING else — a poll cut short
    // by this wait's own deadline is a `continue` that increments no counter —
    // so "every poll failed" was reached by a wait in which one poll got a 503
    // and every other one simply ran out of clock. Three silences billed to the
    // platform that were this deadline's own. The count that was observed is the
    // most the sentence may claim.
    let polls = 0;
    const { client: c } = client((call) => {
      if (call.path !== '/moves') return anyRoute(call);
      polls += 1;
      return polls === 1
        ? errorJson(503, 'the moves listing is briefly unavailable')
        : new Promise<Response>(() => {});
    });
    const computer = await c.computers.get('vm-1');
    const err = await computer.waitForMove(SINCE, { pollMs: 1, timeoutMs: 60 }).catch((e) => e);

    expect(err).toBeInstanceOf(TimeoutError);
    expect(polls).toBeGreaterThan(1);
    expect((err as Error).message).not.toContain('every poll failed');
    expect((err as Error).message).toContain('1 failed outright');
    expect((err as Error).message).toContain("cut short by this wait's own deadline");
  });

  it('does not describe a listing read a quarter of an hour ago as what it can see now', async () => {
    // `unreadable` is written on a poll that READ the listing and is not
    // evidence about any other one, so a wait that decoded two bad rows
    // once and then failed for the rest of its deadline must not end by
    // describing that first listing in the present tense. It is the same mistake
    // `observed` exists to prevent, made with a different value: the timeout
    // here has one thing to report, which is that the polls stopped answering.
    let polls = 0;
    const { client: c } = client((call) => {
      if (call.path !== '/moves') return anyRoute(call);
      polls += 1;
      return polls === 1
        ? json({ moves: [42, 'not a row'] })
        : errorJson(503, 'the moves listing is briefly unavailable');
    });
    const computer = await c.computers.get('vm-1');
    const err = await computer.waitForMove(SINCE, { pollMs: 1, timeoutMs: 60 }).catch((e) => e);

    expect(err).toBeInstanceOf(TimeoutError);
    expect(polls).toBeGreaterThan(1);
    expect((err as Error).message).not.toContain('could not be read at all');
    expect((err as Error).message).toContain('poll(s) failed outright');
  });

  it('does not quote a stale listing when the polls after it were cut short instead', async () => {
    // The same sentence and the other way of never reading a listing again. A
    // poll this wait's own deadline cuts short read nothing at all, so it leaves
    // the counts of what could not be made out exactly as stale as a 503 does —
    // and clearing them on one path and not the other is a timeout that
    // describes a quarter-hour-old listing in the present tense whenever the
    // silence was the clock's rather than the platform's. Nothing here failed,
    // which is the point: there is no `failed outright` clause to carry the
    // reader past it.
    let polls = 0;
    const { client: c } = client((call) => {
      if (call.path !== '/moves') return anyRoute(call);
      polls += 1;
      return polls === 1 ? json({ moves: [42, 'not a row'] }) : new Promise<Response>(() => {});
    });
    const computer = await c.computers.get('vm-1');
    const err = await computer.waitForMove(SINCE, { pollMs: 1, timeoutMs: 60 }).catch((e) => e);

    expect(err).toBeInstanceOf(TimeoutError);
    expect(polls).toBeGreaterThan(1);
    expect((err as Error).message).not.toContain('could not be read at all');
    // Still the branch about a move never seen on a listing that WAS read, so
    // the fix is the counts going and not the sentence changing.
    expect((err as Error).message).toContain('appeared on GET moves');
  });

  it('picks this computer’s move out of the account’s', async () => {
    // The listing is account-wide, and one move runs at a time — but a finished
    // row for another computer stays for a day, so "the first row" is the wrong
    // answer often enough to be worth pinning.
    const { client: c } = client((call) =>
      call.path === '/moves'
        ? json({
            moves: [
              { ...MOVE_DONE, computer_id: 'vm-other', state: 'failed' },
              { ...MOVE_DONE, computer_id: 'vm-1' },
            ],
          })
        : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    const move = await computer.waitForMove(SINCE, { pollMs: 1 });
    expect(move.computerId).toBe('vm-1');
    expect(move.state).toBe('done');
  });

  it('refuses a body with no moves array rather than calling the computer deleted', async () => {
    // Read as `[]`, a malformed 200 reached the reaped-row branch — and that
    // branch says the platform reaps a move when its computer is DELETED.
    const { client: c } = client((call) =>
      call.path === '/moves' ? json({ ok: true }) : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    const err = await computer.waitForMove(SINCE, { pollMs: 1, timeoutMs: 200 }).catch((e) => e);

    expect(err).toBeInstanceOf(MandalaError);
    expect((err as Error).message).toContain('moves array');
    expect((err as Error).message).not.toContain('deleted');
  });

  it('refuses an empty GET /moves body as MandalaError, not a stringify TypeError', async () => {
    // Transport.json returns undefined for an empty 200/204. JSON.stringify of
    // that is undefined, so `.slice` threw TypeError instead of naming the
    // missing envelope.
    const { client: c } = client((call) =>
      call.path === '/moves' ? new Response('', { status: 200 }) : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    const err = await computer.waitForMove(SINCE, { pollMs: 1, timeoutMs: 200 }).catch((e) => e);

    expect(err).toBeInstanceOf(MandalaError);
    expect((err as Error).message).toContain('moves array');
    expect((err as Error).message).toMatch(/got: undefined/);
    expect((err as Error).message).not.toContain('deleted');
  });

  it('does NOT throw for a move that ended badly', async () => {
    // The decision worth stating out loud. `moved`, `failed` and `lost` are
    // three situations with three remedies, and a thrown error flattens them
    // into one — which is how `moved`, where the computer really has changed
    // hardware, gets read as "nothing happened". The caller reads `state`.
    for (const state of ['moved', 'failed', 'lost']) {
      const { client: c } = client((call) =>
        call.path === '/moves'
          ? json({ moves: [{ ...MOVE_DONE, state, detail: 'a reason' }] })
          : anyRoute(call),
      );
      const computer = await c.computers.get('vm-1');
      const move = await computer.waitForMove(SINCE, { pollMs: 1 });
      expect(`${state}: ${move.state} / ${move.detail}`).toBe(`${state}: ${state} / a reason`);
    }
  });

  it('gives up on its own deadline without stopping the move', async () => {
    const { client: c } = client((call) =>
      call.path === '/moves'
        ? json({ moves: [{ ...MOVE_DONE, state: 'moving', live: true }] })
        : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    const err = await computer.waitForMove(SINCE, { timeoutMs: 30, pollMs: 5 }).catch((e) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    // The sentence has to say the move survives the wait, because it does: there
    // is no calling back a disk crossing between two hosts.
    expect((err as Error).message).toContain('has not stopped');
  });

  it('does not call a computer deleted over a row that was never there', async () => {
    // This handle never relocated, so an empty listing is exactly what it should
    // have — and the sentence that ended this wait said the platform reaps a
    // move "when its computer is deleted", about a computer that is running. An
    // empty listing is a row not yet visible and a row reaped wearing one face,
    // and only the deadline can end a wait that cannot tell them apart.
    const { client: c } = client((call) =>
      call.path === '/moves' ? json({ moves: [] }) : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    const err = await computer.waitForMove(SINCE, { timeoutMs: 60, pollMs: 1 }).catch((e) => e);

    expect(err).toBeInstanceOf(TimeoutError);
    // Both possibilities, neither asserted — and the anchor, so somebody
    // reading the message can see which row was being looked for.
    expect((err as Error).message).toContain('that started at 2026-08-23T02:00:12.699Z');
    expect((err as Error).message).toContain('never accepted never appears at all');
  });
});

describe('client.moves', () => {
  it('lists the account’s moves, unwrapped', async () => {
    const { rec, client: c } = client(anyRoute);
    const moves = await c.moves.list();
    expect(rec.calls.map((call) => `${call.method} ${call.path}`)).toEqual(['GET /moves']);
    // The platform answers `{moves: [...]}`; a caller gets the array. The
    // envelope exists because the route is account-scoped and could grow a
    // sibling field, and unwrapping it here is what keeps that from being the
    // caller's problem.
    expect(Array.isArray(moves)).toBe(true);
    expect(moves[0]?.computerId).toBe('vm-1');
    expect(moves[0]?.live).toBe(false);
  });

  it('answers an empty list rather than throwing when there are none', async () => {
    const { client: c } = client((call) =>
      call.path === '/moves' ? json({ moves: [] }) : anyRoute(call),
    );
    expect(await c.moves.list()).toEqual([]);
  });
});
