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

// The anchor every wait below is started from. `GET /moves` is account-wide and
// keeps a day of finished rows, so a wait with nothing tying it to one operation
// cannot tell this move's outcome from the last one's — which is why the
// argument is required, and why a test that omits it is a test of nothing.
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

  it('keeps polling while the only row for this computer finished yesterday', async () => {
    // THE BUG THE ANCHOR EXISTS FOR. The listing keeps a move that finished in
    // the last DAY beside the one running now, and a row the platform accepted
    // seconds ago need not be in an account-wide listing on the first poll. With
    // nothing to compare against, yesterday's row satisfied `!live` immediately
    // and was handed back as this operation's outcome — so the caller started
    // using a computer whose disk was still crossing between hosts.
    const yesterday = {
      ...MOVE_DONE,
      started_at: '2026-08-22T01:00:00.000Z',
      finished_at: '2026-08-22T02:00:00.000Z',
    };
    let polls = 0;
    const { client: c } = client((call) => {
      if (call.path !== '/moves') return anyRoute(call);
      polls += 1;
      // Not visible yet, then live, then finished — the ordinary life of a move
      // that was accepted a moment ago.
      if (polls === 1) return json({ moves: [yesterday] });
      if (polls === 2) return json({ moves: [yesterday, MOVE_STARTED] });
      return json({ moves: [yesterday, MOVE_DONE] });
    });
    const computer = await c.computers.get('vm-1');
    const accepted = await computer.relocate({ ramMb: 26000 });
    const move = await computer.waitForMove(accepted, { pollMs: 1, timeoutMs: 2_000 });

    // The identity of the row first: `state: 'done'` is true of yesterday's row
    // as well, so the stamp is the assertion that can tell the two apart.
    expect(move.startedAt).toBe(MOVE_STARTED.started_at);
    expect(polls).toBe(3);
    expect(move.state).toBe('done');
    expect(move.live).toBe(false);
  });

  it('takes an RFC3339 timestamp in place of the move', async () => {
    // For the process that restarted: the `startedAt` it persisted is the same
    // floor the Move carries, and the platform's clock is on both sides of the
    // comparison either way.
    const { client: c } = client(anyRoute);
    const computer = await c.computers.get('vm-1');
    expect((await computer.waitForMove(SINCE, { pollMs: 1 })).state).toBe('done');
  });

  it('refuses a timestamp it cannot place, before any request', async () => {
    // A stamp with no zone is the dangerous one: `Date.parse` reads it in the
    // LOCAL zone and answers a number, so it would become a floor hours away
    // from the instant it names — against rows stamped by the platform's clock.
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

  it('does not let a row that started later answer for the one being waited on', async () => {
    // One move runs per account at a time, but not one per WAIT: between two
    // polls another process can start a move on this same computer, and a live
    // row is the newer one by definition. Preferring it hands back the state and
    // detail of a relocate the caller never asked about — as the outcome of the
    // one they did. With the floor at the accepted move's own start, the row
    // nearest that floor already is this move, and forty minutes of distance is
    // what puts the newer one behind it.
    const later = {
      ...MOVE_STARTED,
      state: 'moving',
      detail: 'somebody else’s relocate',
      started_at: '2026-08-23T02:40:00.000Z',
    };
    const { client: c } = client((call) =>
      call.path === '/moves' ? json({ moves: [MOVE_DONE, later] }) : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    const move = await computer.waitForMove(SINCE, { pollMs: 1, timeoutMs: 300 });

    expect(move.startedAt).toBe(MOVE_STARTED.started_at);
    expect(move.state).toBe('done');
    expect(move.detail).not.toBe('somebody else’s relocate');
  });

  it('matches a row the listing rendered at a coarser precision than the 202', async () => {
    // The floor comes off a `POST …/move` body and the rows come out of a
    // listing: two renderings of the same platform clock, and nothing says they
    // print the same number of digits. A listing that truncates to whole seconds
    // puts every row for this move a fraction of a second BELOW its own floor,
    // at which point nothing ever matches and a wait that should answer in
    // seconds burns the entire fifteen-minute deadline while the move runs fine.
    const truncated = { ...MOVE_DONE, started_at: '2026-08-23T02:00:12Z' };
    const { client: c } = client((call) =>
      call.path === '/moves' ? json({ moves: [truncated] }) : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    const accepted = await computer.relocate({ ramMb: 26000 });
    const move = await computer.waitForMove(accepted, { pollMs: 1, timeoutMs: 300 });

    expect(move.state).toBe('done');
    expect(move.live).toBe(false);
  });

  it('does not answer with the move that finished seconds before this one started', async () => {
    // WHAT THE SLACK COSTS IF IT IS A WIDER NET RATHER THAN A TOLERANCE. The
    // minute below the floor is there so a listing that rounds this move's start
    // down still matches it — and it admits, with it, any move that genuinely
    // began inside that minute. `MOVE_DONE` is exactly one: the harness's own
    // "small overlay crosses in seconds", started 17s before this wait's floor
    // and finished 13s before it. Picked as the answer it satisfies `!live` on
    // the very first poll, so the wait returns `done` while the disk of the move
    // actually being waited on is still crossing between hosts — the failure the
    // anchor exists to close, back inside a 60-second window instead of a
    // 24-hour one. Distance from the floor is what keeps it out: 17s loses to 0.
    const floor = '2026-08-23T02:00:30.000Z';
    const running = { ...MOVE_STARTED, started_at: floor };
    const finished = {
      ...MOVE_DONE,
      started_at: floor,
      finished_at: '2026-08-23T02:00:44.000Z',
    };
    let polls = 0;
    const { client: c } = client((call) => {
      if (call.path !== '/moves') return anyRoute(call);
      polls += 1;
      return json({ moves: [MOVE_DONE, polls === 1 ? running : finished] });
    });
    const computer = await c.computers.get('vm-1');
    const move = await computer.waitForMove(floor, { pollMs: 1, timeoutMs: 5_000 });

    // The stamp before the state: `done` is true of the earlier row too, so it
    // is the identity of the row that says which one was chosen — and the poll
    // count says the wait did not end on the first one.
    expect(move.startedAt).toBe(floor);
    expect(move.finishedAt).toBe('2026-08-23T02:00:44.000Z');
    expect(polls).toBe(2);
  });

  it('breaks an exact tie in favour of the row at or after the floor', async () => {
    // Two rows the same distance from the floor is a coin toss that has to land
    // the same way every time, and it lands ABOVE: a row below the floor can
    // belong to an earlier operation, while one at or after it cannot have begun
    // before the move being waited on did. Of the two ways to be wrong, only the
    // row below ends a wait early on a computer whose disk is still moving.
    const floor = '2026-08-23T02:00:30.000Z';
    const below = {
      ...MOVE_DONE,
      detail: 'the move before this one',
      started_at: '2026-08-23T02:00:10.000Z',
      finished_at: '2026-08-23T02:00:20.000Z',
    };
    const above = {
      ...MOVE_DONE,
      detail: 'the move at or after the floor',
      started_at: '2026-08-23T02:00:50.000Z',
      finished_at: '2026-08-23T02:01:00.000Z',
    };
    const { client: c } = client((call) =>
      // Both orders, because a reduce that kept the first of two equals would
      // pass one of them and this tie-break is meant to be about the stamps.
      call.path === '/moves' ? json({ moves: [below, above] }) : anyRoute(call),
    );
    const { client: c2 } = client((call) =>
      call.path === '/moves' ? json({ moves: [above, below] }) : anyRoute(call),
    );
    for (const each of [c, c2]) {
      const computer = await each.computers.get('vm-1');
      const move = await computer.waitForMove(floor, { pollMs: 1, timeoutMs: 300 });
      expect(move.startedAt).toBe(above.started_at);
      expect(move.detail).toBe('the move at or after the floor');
    }
  });

  it('counts a row of this computer’s it could not place in time', async () => {
    // A row with no readable `started_at` sorts below every floor and is
    // dropped, and a drop nobody counts is a listing reported as complete when
    // it was not: the row might BE this move. So it has to reach the sentence
    // the wait ends with — and it has to keep the disappearance branch from
    // claiming the row is gone, for the same reason an undecodable row does.
    const { client: c } = client((call) =>
      call.path === '/moves'
        ? json({ moves: [{ ...MOVE_DONE, started_at: 'whenever' }] })
        : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    const err = await computer.waitForMove(SINCE, { pollMs: 1, timeoutMs: 60 }).catch((e) => e);

    expect(err).toBeInstanceOf(TimeoutError);
    expect((err as Error).message).toContain('carry no readable start');
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
    // `unreadable` and `undated` are written on a poll that READ the listing and
    // are not evidence about any other one, so a wait that decoded two bad rows
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

  it('waits for the LIVE row rather than a move that finished yesterday', async () => {
    // The listing keeps a finished move for a DAY beside the one running now,
    // so a computer moved yesterday and moving again today has two rows. Taking
    // the first ended the wait on the first poll and handed back a computer
    // whose disk was still crossing between hosts.
    const yesterday = {
      ...MOVE_DONE,
      computer_id: 'vm-1',
      started_at: '2026-08-22T01:00:00.000Z',
      finished_at: '2026-08-22T02:00:00.000Z',
    };
    const running = {
      ...MOVE_DONE,
      computer_id: 'vm-1',
      state: 'moving',
      live: true,
      started_at: '2026-08-23T01:00:00.000Z',
      finished_at: null,
    };
    let polls = 0;
    const { client: c } = client((call) => {
      if (call.path !== '/moves') return anyRoute(call);
      polls += 1;
      return json({
        moves: [
          yesterday,
          polls === 1
            ? running
            : { ...running, state: 'done', live: false, finished_at: '2026-08-23T02:00:00.000Z' },
        ],
      });
    });
    const computer = await c.computers.get('vm-1');
    const move = await computer.waitForMove('2026-08-23T01:00:00.000Z', { pollMs: 1 });

    expect(polls).toBeGreaterThan(1);
    expect(move.state).toBe('done');
    expect(move.startedAt).toBe('2026-08-23T01:00:00.000Z');
    // `finished_at: null` is the wire saying absent, not the empty string.
    expect(move.finishedAt).toBe('2026-08-23T02:00:00.000Z');
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
    // Both possibilities, neither asserted — and the floor, so somebody reading
    // the message can see which rows were being looked for.
    expect((err as Error).message).toContain('started at or after 2026-08-23T02:00:12.699Z');
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
