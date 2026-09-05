/** The resize that needs the computer moved, from the refusal to the outcome. */

import { describe, expect, it } from 'vitest';
import {
  Client,
  ConflictError,
  isTransient,
  MandalaError,
  type MoveArgs,
  MoveRequiredError,
  TimeoutError,
} from '../src/index.js';
import { anyRoute, BASE, errorJson, json, MOVE_DONE, type Responder, recorder } from './harness.js';

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
});

describe('waitForMove', () => {
  it('answers the move once it has stopped running', async () => {
    const { client: c } = client(anyRoute);
    const computer = await c.computers.get('vm-1');
    await computer.relocate({ ramMb: 26000 });
    const move = await computer.waitForMove({ pollMs: 1 });
    expect(move.live).toBe(false);
    expect(move.state).toBe('done');
    expect(move.finishedAt).toBeTruthy();
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
    const move = await computer.waitForMove({ pollMs: 1 });
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
    const move = await computer.waitForMove({ pollMs: 1 });

    expect(polls).toBeGreaterThan(1);
    expect(move.state).toBe('done');
    expect(move.startedAt).toBe('2026-08-23T01:00:00.000Z');
    // `finished_at: null` is the wire saying absent, not the empty string.
    expect(move.finishedAt).toBe('2026-08-23T02:00:00.000Z');
  });

  it('reads an empty finished_at as absent, not as a stamp that will not parse', async () => {
    // A Go struct with a plain `string` field and no `omitempty` serialises an
    // unset finish time as exactly `""` — the third spelling of absence, beside
    // an omitted key and a null. `??` does not fall back for it, so the row
    // sorted at `Date.parse('')` — NaN, therefore -Infinity — and the listing's
    // day-old row was handed back as the newest. The declared type says
    // finishedAt is absent while a move is live, and `''` is not a time.
    const yesterday = {
      ...MOVE_DONE,
      computer_id: 'vm-1',
      started_at: '2026-08-22T01:00:00.000Z',
      finished_at: '2026-08-22T02:00:00.000Z',
    };
    const today = {
      ...MOVE_DONE,
      computer_id: 'vm-1',
      state: 'moved',
      live: false,
      started_at: '2026-08-23T01:00:00.000Z',
      finished_at: '',
    };
    const { client: c } = client((call) =>
      call.path === '/moves' ? json({ moves: [yesterday, today] }) : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    const move = await computer.waitForMove({ pollMs: 1 });
    // `moved` and not `done`: the newer row wins on its readable startedAt, and
    // the two states are different outcomes — one changed hardware, one did not.
    expect(move.state).toBe('moved');
    expect(move.startedAt).toBe('2026-08-23T01:00:00.000Z');
    expect('finishedAt' in move).toBe(false);
    // And the raw response still carries what the platform actually sent.
    expect(move.raw.finished_at).toBe('');
  });

  it('refuses a body with no moves array rather than calling the computer deleted', async () => {
    // Read as `[]`, a malformed 200 reached the reaped-row branch — and that
    // branch says the platform reaps a move when its computer is DELETED.
    const { client: c } = client((call) =>
      call.path === '/moves' ? json({ ok: true }) : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    const err = await computer.waitForMove({ pollMs: 1, timeoutMs: 200 }).catch((e) => e);

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
    const err = await computer.waitForMove({ pollMs: 1, timeoutMs: 200 }).catch((e) => e);

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
      const move = await computer.waitForMove({ pollMs: 1 });
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
    const err = await computer.waitForMove({ timeoutMs: 30, pollMs: 5 }).catch((e) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    // The sentence has to say the move survives the wait, because it does: there
    // is no calling back a disk crossing between two hosts.
    expect((err as Error).message).toContain('has not stopped');
  });

  it('stops when the move stops being listed, which means the computer is gone', async () => {
    const { client: c } = client((call) =>
      call.path === '/moves' ? json({ moves: [] }) : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    const err = await computer.waitForMove({ timeoutMs: 500, pollMs: 1 }).catch((e) => e);
    // MandalaError and not a timeout: waiting longer cannot bring back a row the
    // platform reaped, and spending the whole deadline to say so is the failure
    // this branch exists to avoid.
    expect(err).toBeInstanceOf(MandalaError);
    expect(err).not.toBeInstanceOf(TimeoutError);
    expect((err as Error).message).toContain('deleted');
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
