/** What a boolean field the client cannot read is allowed to mean. */

import { describe, expect, it } from 'vitest';
import { Client } from '../src/index.js';
import {
  anyRoute,
  BASE,
  EXEC_STARTED,
  json,
  MOVE_DONE,
  type Responder,
  recorder,
  SNAPSHOT,
  USAGE,
} from './harness.js';

// OPL-3850. The decoder these replace handled the stringified cases well —
// `"false"`, `"0"`, `""` and `"FALSE"` all read false — and then fell through
// to `Boolean(v)`, so a value it could NOT read read TRUE.
//
// For most of the twenty-odd flags it decoded that is the harmless direction:
// `unmatched`, `degraded` and the truncation flags all mean "there is more to
// this than you can see", and over-reporting one costs a caller a little time.
// For two it is the wrong direction, and both are controls rather than caveats:
// `valid` reports a document PUBLISHABLE, and `more` is a backoff switch whose
// documented loop polls again immediately while it is set.
//
// Nothing on the live platform produces that row today — a wire audit saw 16 of
// the 20 fields across ~230 real payloads and every one was a genuine JSON
// boolean. So what is pinned here is the DIRECTION each field falls in, which is
// the part a later edit can quietly get wrong, and the two readings are named
// rather than assumed: a claim needs the wire to have said it, a caveat survives
// a value nobody can read.

const client = (respond: Responder) => {
  const rec = recorder(respond);
  return { rec, client: new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch }) };
};

/** Every spelling of a boolean the platform could plausibly send. */
const READABLE_TRUE = [true, 1, '1', 'true', 'True', 'TRUE', ' true '];
const READABLE_FALSE = [false, 0, '0', 'false', 'False', 'FALSE', ' false '];
/**
 * Present, and not anything this client can read.
 *
 * All of them survive a round trip through JSON, which rules out the obvious
 * `NaN`: `JSON.stringify` writes it as `null`, and null is a state of its own
 * here rather than an unreadable one.
 */
const UNREADABLE = ['maybe', '', 'yes', 'no', 2, -1, 1.5, {}, [], [true]];

describe('recognising a boolean however it is spelled', () => {
  // The defect was TRUTHINESS, not recognition. A backend that encodes its
  // booleans as strings or as 0/1 is not sending anything unreadable, and must
  // not be told that every flag it sends is.
  it('reads every spelling of true and false the same way', async () => {
    for (const [spelling, expected] of [
      ...READABLE_TRUE.map((v) => [v, true] as const),
      ...READABLE_FALSE.map((v) => [v, false] as const),
    ]) {
      const { client: c } = client((call) =>
        call.path === '/templates/validate'
          ? json({ valid: spelling, problems: [] })
          : anyRoute(call),
      );
      const check = await c.templates.validate('apiVersion: mandala/v1');
      expect(`${JSON.stringify(spelling)}: ${check.valid}`).toBe(
        `${JSON.stringify(spelling)}: ${expected}`,
      );
    }
  });

  // `1` and `1.0` are one wire value and two JSON numbers. Recognising one and
  // not the other made the same payload decode two ways, which is what the
  // Python SDK's review of the same classifier caught.
  it('does not split an integral float from its integer', async () => {
    const { client: c } = client((call) =>
      call.path === '/templates/validate' ? json({ valid: 1.0, problems: [] }) : anyRoute(call),
    );
    expect((await c.templates.validate('apiVersion: mandala/v1')).valid).toBe(true);
  });
});

describe('a claim needs the wire to have made it', () => {
  /**
   * The finding. `valid` is the field whose whole job is to say whether a
   * document is fit to publish, so an unreadable one reading true is fail-open
   * on exactly the question being asked.
   */
  it('does not call a document publishable on a verdict it cannot read', async () => {
    for (const value of UNREADABLE) {
      const { client: c } = client((call) =>
        call.path === '/templates/validate'
          ? json({ valid: value, problems: ['unreadable verdict'] })
          : anyRoute(call),
      );
      const check = await c.templates.validate('apiVersion: mandala/v1');
      expect(`${JSON.stringify(value)}: ${check.valid}`).toBe(`${JSON.stringify(value)}: false`);
    }
  });

  it('does not grant a size the plan never said was allowed', async () => {
    const { client: c } = client((call) =>
      call.path === '/sizes'
        ? json([{ id: 'big', label: 'Big', template: 'base', allowed: 'maybe' }])
        : anyRoute(call),
    );
    expect((await c.sizes.list())[0]?.allowed).toBe(false);
  });

  it('does not report a computer deleted, or a snapshot orphaned, unasked', async () => {
    const { client: c } = client((call) => {
      if (call.path === '/usage') {
        return json({
          ...USAGE,
          usage: { ...USAGE.usage, computers: [{ id: 'vm-1', name: 'demo', gone: 'maybe' }] },
        });
      }
      if (call.path === '/snapshots') return json([{ ...SNAPSHOT, orphaned: 'maybe', auto: {} }]);
      return anyRoute(call);
    });
    expect((await c.usage.read()).usage.computers[0]?.gone).toBe(false);
    const snap = (await c.snapshots.list())[0];
    // `orphaned` is what tells a caller a restore cannot work, and `auto` is
    // what decides whether the retention policy may delete it.
    expect([snap?.orphaned, snap?.auto]).toEqual([false, false]);
  });

  it('does not place the pointer on a `known` flag it cannot read', async () => {
    // The coordinates are present and zero whatever `known` says, and zero is
    // the corner of the screen — the wrong answer to hand somebody about to
    // click relative to it.
    const { client: c } = client((call) =>
      call.path.endsWith('/input') ? json({ known: 'maybe', x: 0, y: 0 }) : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    expect(await computer.cursorPosition()).toBeUndefined();
  });

  it('does not reach the same corner through an unusable coordinate', async () => {
    // The check above, arrived at through the other field: a `known` of true
    // with a null, empty or non-numeric coordinate is still nobody saying where
    // the pointer is, and a number fallback answers 0 for all three.
    for (const [x, y] of [
      [null, null],
      [0, null],
      ['', ''],
      ['left', 'top'],
      [{}, []],
      [12, undefined],
      // Arrays ALONE and paired with a valid coordinate. An array of one
      // coerces to its element and an empty one to zero, so `[]`/`[7]` walked
      // through a finiteness test and came out as `(0, 7)` while a case pairing
      // an array with an object still passed (Codex adversarial review).
      [[], [7]],
      [[7], []],
      [[12], 34],
      [12, [34]],
      [[], []],
      [true, false],
      // And a string of nothing but space, which is the empty string one
      // keystroke away: `Number('  ')` is 0 too, so catching only `''` left the
      // same corner reachable (Codex review, third pass).
      [' ', ' '],
      ['\t', '\n'],
      [' ', 12],
      [12, '  '],
    ] as const) {
      const { client: c } = client((call) =>
        call.path.endsWith('/input') ? json({ known: true, x, y }) : anyRoute(call),
      );
      const computer = await c.computers.get('vm-1');
      const at = await computer.cursorPosition();
      expect(`${JSON.stringify([x, y])}: ${JSON.stringify(at)}`).toBe(
        `${JSON.stringify([x, y])}: undefined`,
      );
    }
  });

  it('still answers a coordinate the platform did give', async () => {
    const { client: c } = client((call) =>
      call.path.endsWith('/input') ? json({ known: true, x: 640, y: '400' }) : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    expect(await computer.cursorPosition()).toEqual({ x: 640, y: 400 });
  });

  it('does not report a snapshot schedule running on a flag it cannot read', async () => {
    const { client: c } = client((call) =>
      call.path.endsWith('/schedule')
        ? json({ enabled: 'maybe', hour: 4, minute: 0, tz: 'UTC' })
        : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    expect((await computer.schedule()).enabled).toBe(false);
  });
});

describe('a caveat survives a value nobody can read', () => {
  // The other direction, and the reason this is two readings rather than one
  // rule: every one of these means "the answer you are holding may be short",
  // and a short answer that says nothing is indistinguishable from a whole one.
  it('keeps both shortfall flags on a usage report it cannot fully read', async () => {
    for (const value of UNREADABLE) {
      const { client: c } = client((call) =>
        call.path === '/usage'
          ? json({ ...USAGE, degraded: value, unmetered: value })
          : anyRoute(call),
      );
      const report = await c.usage.read();
      expect(`${JSON.stringify(value)}: ${report.degraded}/${report.unmetered}`).toBe(
        `${JSON.stringify(value)}: true/true`,
      );
    }
  });

  it('does not affirm a command that may never have finished', async () => {
    const { client: c } = client((call) =>
      call.path.endsWith('/exec')
        ? json({ exit_code: 0, stdout: 'out', stderr: '', timed_out: 'maybe' })
        : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    const result = await computer.exec('true');
    // `ok` is `exitCode === 0 && !timedOut`, so an unreadable `timed_out`
    // reading false would report success for a command that was cut off.
    expect([result.timedOut, result.ok]).toEqual([true, false]);
  });

  it('does not hand back a truncated stream as if it were whole', async () => {
    const { client: c } = client((call) =>
      call.path.endsWith('/exec')
        ? json({ exit_code: 0, stdout: 'x', stderr: '', out_truncated: {}, err_truncated: 'maybe' })
        : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    const result = await computer.exec('cat big');
    expect([result.outTruncated, result.errTruncated, result.truncated]).toEqual([
      true,
      true,
      true,
    ]);
  });

  it('says the step counter is unavailable rather than showing a wrong one', async () => {
    const { client: c } = client((call) =>
      call.path.endsWith('/progress')
        ? json({ id: 'bld-1', status: 'succeeded', unmatched: 'maybe' })
        : anyRoute(call),
    );
    expect((await c.builds.progress('bld-1')).unmatched).toBe(true);
  });

  // A host too old to send the field is not reporting a problem, and reading it
  // as one would put a caveat on every response such a host ever gives.
  it('does not invent a caveat out of a field that was never sent', async () => {
    const { client: c } = client((call) =>
      call.path === '/usage'
        ? json({ ...USAGE, degraded: undefined, unmetered: null })
        : anyRoute(call),
    );
    const report = await c.usage.read();
    expect([report.degraded, report.unmetered]).toEqual([false, false]);
  });
});

describe('more is a switch, not a caveat', () => {
  /**
   * The counter-example worth keeping. `more` READS like a caveat — "there is
   * output you have not seen" — and BEHAVES like a backoff switch: the loop in
   * this package's README sleeps a second only while it is clear, so the caveat
   * reading turns a poll every second into an unbounded zero-delay poll against
   * a metered endpoint.
   *
   * Sleeping costs nothing here, because `running` is what ends that loop.
   */
  it('reads false so a poll loop still sleeps, on a value nobody can read', async () => {
    for (const value of UNREADABLE) {
      const { client: c } = client((call) =>
        /\/exec\/\d+$/.test(call.path)
          ? json({ pid: 4242, running: true, more: value, stdout: '' })
          : anyRoute(call),
      );
      const computer = await c.computers.get('vm-1');
      const status = await computer.execPoll(4242);
      expect(`${JSON.stringify(value)}: ${status.more}`).toBe(`${JSON.stringify(value)}: false`);
    }
  });

  /**
   * And the reason it does not simply take the caveat reading anyway: the same
   * loop BREAKS on `running`, so that one needs affirmative evidence to stop.
   * An unreadable flag leaves the command running rather than abandoning it with
   * its output still queued — output a cursor-based poll can never fetch again.
   */
  it('keeps a background command running on a `running` it cannot read', async () => {
    const { client: c } = client((call) =>
      /\/exec\/\d+$/.test(call.path) ? json({ ...EXEC_STARTED, running: 'maybe' }) : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    expect((await computer.execPoll(4242)).running).toBe(true);
  });

  /**
   * AND STOPS ANYWAY ONCE AN EXIT CODE ARRIVES. The reading above, applied
   * without this one, is the only reading that can never end: the README's loop
   * breaks on `running`, so `{running: "maybe", exit_code: 0}` — a command that
   * has plainly exited — polls forever (Codex adversarial review, OPL-3850).
   *
   * The cross-product is the test. Varying `running` with no exit code, and the
   * exit code against a readable `running`, both passed while the pair that
   * matters did not exist.
   */
  it('lets an exit code outrank a `running` nobody can read', async () => {
    for (const [payload, expected] of [
      [{ pid: 42, running: 'maybe' }, true],
      [{ pid: 42, running: 'maybe', exit_code: '' }, true],
      [{ pid: 42, running: 'maybe', exit_code: null }, true],
      [{ pid: 42, running: 'maybe', exit_code: 0 }, false],
      [{ pid: 42, running: 'maybe', exit_code: 137 }, false],
      [{ pid: 42, running: {}, exit_code: 0 }, false],
      // A COERCIBLE exit code is not an exit code. `Number([])` is 0 and
      // `Number([7])` is 7, so these ended the poll and reported a clean exit
      // on a value nobody read — the earlier cases covered strings and objects
      // and stopped short of the arrays and booleans that coerce (Codex review,
      // third pass, OPL-3850).
      [{ pid: 42, running: 'maybe', exit_code: [] }, true],
      [{ pid: 42, running: 'maybe', exit_code: [0] }, true],
      [{ pid: 42, running: 'maybe', exit_code: false }, true],
      [{ pid: 42, running: 'maybe', exit_code: true }, true],
      [{ pid: 42, running: 'maybe', exit_code: ' ' }, true],
      // A readable `running` still wins over the exit code either way: the
      // fallback is for the values that said nothing, not for every value.
      [{ pid: 42, running: true, exit_code: 0 }, true],
      [{ pid: 42, running: false }, false],
    ] as const) {
      const { client: c } = client((call) =>
        /\/exec\/\d+$/.test(call.path) ? json(payload) : anyRoute(call),
      );
      const computer = await c.computers.get('vm-1');
      const status = await computer.execPoll(42);
      expect(`${JSON.stringify(payload)}: ${status.running}`).toBe(
        `${JSON.stringify(payload)}: ${expected}`,
      );
    }
  });

  it('still falls back to the exit code where the flag was never sent', async () => {
    // Absent and null are a host that said nothing, not a host saying no, and
    // what "running" means in the first place is that no exit code has arrived.
    for (const [payload, expected] of [
      [{ pid: 4242, stdout: '' }, true],
      [{ pid: 4242, running: null, exit_code: '' }, true],
      [{ pid: 4242, exit_code: 0 }, false],
      [{ pid: 4242, running: null, exit_code: 3 }, false],
    ] as const) {
      const { client: c } = client((call) =>
        /\/exec\/\d+$/.test(call.path) ? json(payload) : anyRoute(call),
      );
      const computer = await c.computers.get('vm-1');
      const status = await computer.execPoll(4242);
      expect(`${JSON.stringify(payload)}: ${status.running}`).toBe(
        `${JSON.stringify(payload)}: ${expected}`,
      );
    }
  });
});

describe('the two fields whose answer needs a second one', () => {
  /**
   * `live` cannot be read alone. `waitForMove` returns the moment it is false,
   * so an absent or unreadable one reading false hands back a half-copied disk
   * as a finished move — and reading it true instead polls a FINISHED move to
   * its deadline. Only a value the wire actually gave overrides the state.
   */
  it('answers an unreadable `live` from the move state', async () => {
    for (const [state, expected] of [
      ['moving', true],
      ['staging', true],
      ['resizing', true],
      ['done', false],
      ['moved', false],
      ['failed', false],
      ['lost', false],
    ] as const) {
      const { client: c } = client((call) =>
        call.path === '/moves'
          ? json({ moves: [{ ...MOVE_DONE, state, live: 'maybe' }] })
          : anyRoute(call),
      );
      const move = (await c.moves.list())[0];
      expect(`${state}: ${move?.live}`).toBe(`${state}: ${expected}`);
    }
  });

  it('does not read a state it cannot classify as a live move', async () => {
    // `String(['moving'])` is `'moving'`, because an array of one joins to its
    // element — so a coerced state classified as live and `waitForMove` polled
    // the garbage to its deadline (Codex adversarial review, OPL-3850). The
    // state is still REPORTED coerced; it is not decided on.
    for (const state of [['moving'], ['staging'], 42, {}, null, true]) {
      const { client: c } = client((call) =>
        call.path === '/moves'
          ? json({ moves: [{ computer_id: 'vm-1', state, live: 'maybe' }] })
          : anyRoute(call),
      );
      const move = (await c.moves.list())[0];
      expect(`${JSON.stringify(state)}: ${move?.live}`).toBe(`${JSON.stringify(state)}: false`);
    }
  });

  it('answers an absent `live` from the move state too', async () => {
    // The half the Python SDK's review found: a host that omits the flag and
    // says `moving` IS describing a live move, and returning false there ended
    // the wait on a disk still copying.
    const { client: c } = client((call) =>
      call.path === '/moves'
        ? json({ moves: [{ computer_id: 'vm-1', state: 'moving' }] })
        : anyRoute(call),
    );
    expect((await c.moves.list())[0]?.live).toBe(true);
  });

  it('lets a `live` the wire did give overrule the state', async () => {
    // Not merely a second reading of `state`: a platform that says the move is
    // over while its state still says `moving` is answered by the flag.
    const { client: c } = client((call) =>
      call.path === '/moves'
        ? json({ moves: [{ ...MOVE_DONE, state: 'moving', live: 'false' }] })
        : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    expect((await computer.waitForMove({ pollMs: 1 })).state).toBe('moving');
  });

  /**
   * `unreachable` means opposite things on the two rows it can appear on, so an
   * unreadable one is answered by the ROW. On a placeholder it is the marker
   * saying a listing is short; dropping it reports a confident count over an
   * incomplete answer.
   */
  it('keeps a placeholder in a filtered listing even where its flag is unreadable', async () => {
    const { client: c } = client((call) =>
      call.path === '/snapshots'
        ? json([
            { ...SNAPSHOT, computer_id: 'vm-other' },
            { id: 'snap-2', unreachable: 'maybe' },
          ])
        : anyRoute(call),
    );
    const listed = await c.snapshots.list({ computerId: 'vm-1' });
    expect(listed.map((s) => s.id)).toEqual(['snap-2']);
    expect(listed[0]?.unreachable).toBe(true);
  });

  it('does not admit another computer’s real snapshot, whatever its flag says', async () => {
    // The other direction, and why the flag alone will not do: this listing is
    // read just before an irreversible delete, and admitting a full row hands
    // somebody else's snapshots to a caller who filtered for their own.
    //
    // `true` BELONGS IN THIS LIST. Applying the row test only to the values this
    // client cannot read left the hole one branch over, which is where a
    // readable `unreachable: true` on a full row walked straight through (Codex
    // review, OPL-3850) — the same hole the Python SDK's review found.
    for (const flag of ['maybe', true, 1, 'true', null, {}]) {
      const { client: c } = client((call) =>
        call.path === '/snapshots'
          ? json([{ ...SNAPSHOT, computer_id: 'vm-other', unreachable: flag }])
          : anyRoute(call),
      );
      const listed = await c.snapshots.list({ computerId: 'vm-1' });
      expect(`${JSON.stringify(flag)}: ${listed.length}`).toBe(`${JSON.stringify(flag)}: 0`);
    }
  });

  it('reports the field as given even where the row is not a placeholder', async () => {
    // The field and the filter answer different questions, and only the filter
    // needs the row. A flag the wire actually said was true is preserved as
    // given, because this type's contract is that malformed input survives to
    // `raw` rather than being rejected — the caller reading one snapshot is not
    // the caller a wrong filter costs.
    const { client: c } = client((call) =>
      call.path === '/snapshots'
        ? json([{ ...SNAPSHOT, computer_id: 'vm-other', unreachable: true }])
        : anyRoute(call),
    );
    const listed = await c.snapshots.list();
    expect([listed.length, listed[0]?.unreachable, listed[0]?.computerId]).toEqual([
      1,
      true,
      'vm-other',
    ]);
  });

  it('does not match a computer id that only coerces to the one asked for', async () => {
    // The other coercion, on the other half of the same filter. The tests above
    // varied `unreachable` and never the type of `computer_id`, so a row whose
    // id arrived as `["vm-1"]` was admitted into vm-1's listing — a listing
    // usually read just before an irreversible delete (Codex adversarial
    // review, OPL-3850).
    for (const id of [['vm-1'], [['vm-1']], { toString: 'vm-1' }, null, 0]) {
      const { client: c } = client((call) =>
        call.path === '/snapshots'
          ? json([{ ...SNAPSHOT, id: 'snap-foreign', computer_id: id, state: 'durable' }])
          : anyRoute(call),
      );
      const listed = await c.snapshots.list({ computerId: 'vm-1' });
      expect(`${JSON.stringify(id)}: ${listed.length}`).toBe(`${JSON.stringify(id)}: 0`);
    }
  });

  it('still matches the id the platform actually sent', async () => {
    const { client: c } = client((call) =>
      call.path === '/snapshots'
        ? json([
            { ...SNAPSHOT, id: 'snap-mine', computer_id: 'vm-1' },
            { ...SNAPSHOT, id: 'snap-theirs', computer_id: 'vm-other' },
          ])
        : anyRoute(call),
    );
    const listed = await c.snapshots.list({ computerId: 'vm-1' });
    expect(listed.map((s) => s.id)).toEqual(['snap-mine']);
  });

  it('keeps a placeholder the platform added fields to', async () => {
    // A tolerant test, not an exact whitelist: a `created_at` or a `kind` on the
    // stub must not stop it being recognised, because filtering those out drops
    // precisely the markers saying an answer is short.
    const { client: c } = client((call) =>
      call.path === '/snapshots'
        ? json([{ id: 'snap-9', kind: 'disk', created_at: '2026-08-27T00:00:00Z', unreachable: 1 }])
        : anyRoute(call),
    );
    expect((await c.snapshots.list({ computerId: 'vm-1' })).map((s) => s.id)).toEqual(['snap-9']);
  });

  it('does not read a full row with no computer_id as a placeholder', async () => {
    // `POST /computers/:id/snapshots` answers without a `computer_id` — it is in
    // the path — so the missing key alone cannot mean placeholder. `state` is
    // what every real snapshot carries and no placeholder does.
    const { client: c } = client((call) =>
      call.path === '/snapshots'
        ? json([{ id: 'snap-3', state: 'pending', size_bytes: 10, unreachable: null }])
        : anyRoute(call),
    );
    const listed = await c.snapshots.list();
    expect([listed[0]?.unreachable, listed[0]?.state]).toEqual([false, 'pending']);
  });
});

describe('a coerced value is not the value', () => {
  /**
   * `ok` is the field a caller branches on, and it is a claim: the command ran
   * and exited zero. `Number([])` is 0, so an exit code nobody could read
   * decoded as a clean exit and `ok` affirmed a command that may never have run
   * (Codex review, third pass, OPL-3850). -1 is what "nobody sent one this
   * client can read" has always decoded as here; the coercible values simply
   * never reached it.
   */
  it('does not report success on an exit code it could not read', async () => {
    for (const code of [[], [0], false, true, ' ', {}, 'killed', 'signal:9']) {
      const { client: c } = client((call) =>
        call.path.endsWith('/exec')
          ? json({ exit_code: code, stdout: '', stderr: '', timed_out: false })
          : anyRoute(call),
      );
      const computer = await c.computers.get('vm-1');
      const result = await computer.exec('x');
      expect(`${JSON.stringify(code)}: ${result.exitCode}/${result.ok}`).toBe(
        `${JSON.stringify(code)}: -1/false`,
      );
    }
  });

  it('still reads an exit code the platform did send', async () => {
    for (const [code, expected] of [
      [0, 0],
      [137, 137],
      ['0', 0],
      ['137', 137],
    ] as const) {
      const { client: c } = client((call) =>
        call.path.endsWith('/exec')
          ? json({ exit_code: code, stdout: '', stderr: '', timed_out: false })
          : anyRoute(call),
      );
      const computer = await c.computers.get('vm-1');
      const result = await computer.exec('x');
      expect(`${JSON.stringify(code)}: ${result.exitCode}/${result.ok}`).toBe(
        `${JSON.stringify(code)}: ${expected}/${expected === 0}`,
      );
    }
  });

  /**
   * The same identity invariant the snapshot filter enforces, on the caller that
   * did not get it the first time. `waitForMove` picks this computer's row out
   * of an ACCOUNT-WIDE listing, so a coerced match returns somebody else's move
   * as this one's outcome — or polls it as this one's live move.
   */
  it('does not pick a move whose computer id only coerces to this one', async () => {
    const { client: c } = client((call) =>
      call.path === '/moves'
        ? json({ moves: [{ ...MOVE_DONE, computer_id: ['vm-1'], state: 'done', live: false }] })
        : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    // No row belongs to this computer, so the wait says the move is gone rather
    // than handing back a row it cannot attribute.
    await expect(computer.waitForMove({ pollMs: 1 })).rejects.toThrow(/has no move any more/);
  });

  it('still picks the move the platform did attribute to this computer', async () => {
    const { client: c } = client((call) =>
      call.path === '/moves'
        ? json({
            moves: [
              { ...MOVE_DONE, computer_id: 'vm-other', state: 'moving', live: true },
              { ...MOVE_DONE, computer_id: 'vm-1', state: 'done', live: false },
            ],
          })
        : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    expect((await computer.waitForMove({ pollMs: 1 })).state).toBe('done');
  });
});

describe('a coerced value cannot classify, on the fields it still decided', () => {
  /**
   * `durable` is the field a caller reads before believing a snapshot outlives
   * the host holding it, and `memory` decides whether a clone boots or resumes.
   * Both were tested against the COERCED state, and `String(['durable'])` is
   * `'durable'` (Codex review, fourth pass, OPL-3850).
   */
  it('does not claim backup durability from a state it cannot classify', async () => {
    for (const [state, kind] of [
      [['durable'], ['memory']],
      [[['durable']], [['memory']]],
      [{ toString: 'x' }, { toString: 'y' }],
      [null, null],
      [42, 42],
    ] as const) {
      const { client: c } = client((call) =>
        call.path === '/snapshots' ? json([{ ...SNAPSHOT, state, kind }]) : anyRoute(call),
      );
      const snap = (await c.snapshots.list())[0];
      expect(`${JSON.stringify([state, kind])}: ${snap?.durable}/${snap?.memory}`).toBe(
        `${JSON.stringify([state, kind])}: false/false`,
      );
    }
  });

  it('still reads the state and kind the platform did send', async () => {
    const { client: c } = client((call) =>
      call.path === '/snapshots'
        ? json([
            { ...SNAPSHOT, id: 'a', state: 'durable', kind: 'memory' },
            { ...SNAPSHOT, id: 'b', state: 'pending', kind: 'disk' },
          ])
        : anyRoute(call),
    );
    const [a, b] = await c.snapshots.list();
    expect([a?.durable, a?.memory, b?.durable, b?.memory]).toEqual([true, true, false, false]);
  });

  /**
   * The same shape one file over, on a computer's status — which is what
   * `waitUntilRunning` returns on, and what tells a stopped machine from a
   * suspended one. Not reported by the review; found by looking for siblings of
   * the finding above.
   */
  it('does not read a status it cannot classify as a running computer', async () => {
    for (const status of [['running'], ['stopped'], ['suspended'], ['building'], 42, {}]) {
      const { client: c } = client((call) =>
        call.path === '/computers' && call.method === 'GET'
          ? json([{ id: 'vm-1', name: 'demo', status }])
          : anyRoute(call),
      );
      const computer = (await c.computers.list())[0];
      expect(
        `${JSON.stringify(status)}: ${computer?.isSuspended}/${computer?.isBuilding}/${computer?.buildFailed}`,
      ).toBe(`${JSON.stringify(status)}: false/false/false`);
    }
  });

  it('still reads the status the platform did send', async () => {
    for (const [status, flags] of [
      ['suspended', [true, false, false]],
      ['building', [false, true, false]],
      ['build-failed', [false, false, true]],
      ['running', [false, false, false]],
    ] as const) {
      const { client: c } = client((call) =>
        call.path === '/computers' && call.method === 'GET'
          ? json([{ id: 'vm-1', name: 'demo', status }])
          : anyRoute(call),
      );
      const computer = (await c.computers.list())[0];
      expect(
        `${status}: ${[computer?.isSuspended, computer?.isBuilding, computer?.buildFailed]}`,
      ).toBe(`${status}: ${flags}`);
    }
  });

  it('does not end a readiness wait on a status nobody sent', async () => {
    // The consequence, and the reason this is not cosmetic: `waitUntilRunning`
    // returns the moment the status reads `running`.
    const { client: c } = client((call) => json({ id: 'vm-1', name: 'demo', status: ['running'] }));
    const computer = await c.computers.get('vm-1');
    await expect(computer.waitUntilRunning({ timeoutMs: 60, pollMs: 10 })).rejects.toThrow(
      /still \["running"\]|was still/,
    );
  });
});
