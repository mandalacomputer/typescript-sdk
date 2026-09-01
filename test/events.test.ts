/**
 * The event stream: what comes off the wire, and what the iterator does with it.
 *
 * Two halves, and they fail differently. The parsing half is pure and is tested
 * against frames written the way the platform writes them — `server/events.go`
 * and `server/eventsocket.go`, whose shapes are quoted in the fixtures below.
 * The stream half is a socket, a queue and a reconnect, and every test in it
 * drives a {@link FakeSocket} rather than a mock of this SDK's own machinery:
 * a test that calls the frame handler directly proves the handler and not the
 * dispatcher above it, which is exactly how the platform shipped an inert fix
 * on this feature (OPL-3785, review 16).
 */

import { describe, expect, it } from 'vitest';
// Not on the package's export list, which is a gap of its own — every local
// refusal in this SDK is one of these and a caller cannot name the class.
import { ValidationError } from '../src/errors.js';
import { toComputerEvent, toHello, withCursor, withWatches } from '../src/events.js';
import {
  Client,
  type ComputerEvent,
  ConnectionError,
  isSettled,
  MandalaError,
  NotFoundError,
  TimeoutError,
} from '../src/index.js';
import {
  anyRoute,
  BASE,
  COMPUTER,
  EVENTS_HELLO,
  errorJson,
  type FakeSocket,
  json,
  type Responder,
  recorder,
  socketFactory,
} from './harness.js';

const client = (respond: Responder = anyRoute) => {
  const rec = recorder(respond);
  return { rec, client: new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch }) };
};

const computer = async (respond: Responder = anyRoute) => {
  const { client: c, rec } = client(respond);
  return { rec, computer: await c.computers.get('vm-1') };
};

/** One ordinary event, in the envelope the daemon writes. */
const event = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  seq: 7,
  cursor: 'ep-1:8',
  at: '2026-08-31T12:00:00Z',
  type: 'computer.idle',
  computer: 'vm-1',
  source: 'daemon',
  data: { idle_seconds: 1800 },
  ...over,
});

/** A window, in the shape `GET computers/:id/windows` returns. */
const WINDOW = {
  id: '0x3000003',
  title: 'Terminal',
  class: 'Xfce4-terminal',
  type: 'normal',
  x: 645,
  y: 429,
  width: 800,
  height: 500,
  focused: true,
  minimized: false,
};

/** Collect a whole stream, with a stop so a bug cannot hang the suite. */
async function collect(stream: AsyncIterable<ComputerEvent>, limit = 50): Promise<ComputerEvent[]> {
  const got: ComputerEvent[] = [];
  for await (const ev of stream) {
    got.push(ev);
    if (got.length >= limit) break;
  }
  return got;
}

const hello = (over: Record<string, unknown> = {}) => ({ ...EVENTS_HELLO, ...over });

describe('one frame, decoded', () => {
  it('reads the envelope every event carries', () => {
    const ev = toComputerEvent(event());
    expect(ev).toMatchObject({
      type: 'computer.idle',
      at: '2026-08-31T12:00:00Z',
      computer: 'vm-1',
      seq: 7,
      cursor: 'ep-1:8',
      source: 'daemon',
      idleSeconds: 1800,
    });
  });

  it('keeps `source`, because guest-reported is not the same claim as observed', () => {
    // The platform sends `guest` for everything the machine says about itself,
    // and anyone with root in that guest can make those say anything. Reading
    // it as `daemon` would launder a window title into an observation.
    expect(toComputerEvent(event({ source: 'guest' }))?.source).toBe('guest');
    // A word this build has not heard of stays the word it was. Defaulting an
    // unknown source to `daemon` is the same laundering by another route.
    expect(toComputerEvent(event({ source: 'appliance' }))?.source).toBe('appliance');
    expect(toComputerEvent(event({ source: 42 }))?.source).toBe('daemon');
  });

  it('describes an opened or focused window in full', () => {
    for (const type of ['window.opened', 'window.focused']) {
      const ev = toComputerEvent(event({ type, source: 'guest', data: WINDOW }));
      expect(ev?.window).toMatchObject({ id: '0x3000003', x: 645, y: 429, focused: true });
      expect(ev?.windowId).toBeUndefined();
    }
  });

  it('decodes a window frame it cannot read rather than throwing out of the socket', () => {
    // The listing refuses a window with no id and answers nothing for geometry
    // it could not read (OPL-4200). The refusal deliberately stops at the route:
    // `toGuestWindow` runs here, inside the message listener, where a throw is
    // not a rejected call a caller can catch but an exception out of a socket
    // callback — and this stream's policy for a frame it cannot read is to skip
    // it and read the next one, never to end the connection over it.
    const ev = toComputerEvent(
      event({ type: 'window.opened', source: 'guest', data: { title: 'Terminal', x: [7] } }),
    );
    expect(ev?.window).toMatchObject({ id: '', title: 'Terminal' });
    // And the coordinate is absent rather than 7 or 0, on this route as on the
    // other one: the two decode the same window through the same function.
    expect(ev?.window?.x).toBeUndefined();
  });

  it('names a closed or blurred window and invents no geometry for it', () => {
    // The platform sends `{id}` and nothing else on both, deliberately: a
    // window that is gone has no position, and a zero-valued one on the wire
    // would be fabricated geometry presented as fact.
    for (const type of ['window.closed', 'window.blurred']) {
      const ev = toComputerEvent(event({ type, source: 'guest', data: { id: '0x2600003' } }));
      expect(ev?.windowId).toBe('0x2600003');
      expect(ev?.window).toBeUndefined();
    }
  });

  it('reads an exit code, and reads its absence as absence', () => {
    const ok = toComputerEvent(event({ type: 'process.exited', data: { pid: 91, exit_code: 0 } }));
    expect(ok).toMatchObject({ pid: 91, exitCode: 0, lost: false });
  });

  it('never hands back an exit code beside `lost`', () => {
    // `-1` is a real exit code on this path, which is why the platform sends no
    // code at all rather than a sentinel. A decoder that let both through would
    // give a caller a number and a statement that there is no number.
    const lost = toComputerEvent(
      event({ type: 'process.exited', data: { pid: 91, lost: true, exit_code: -1 } }),
    );
    expect(lost).toMatchObject({ pid: 91, lost: true });
    expect(lost?.exitCode).toBeUndefined();
  });

  it('reads a clipboard selection and a power transition', () => {
    expect(
      toComputerEvent(event({ type: 'clipboard.changed', data: { selection: 'primary' } }))
        ?.selection,
    ).toBe('primary');
    const power = toComputerEvent(
      event({ type: 'computer.stopped', data: { status: 'stopped', previous: 'running' } }),
    );
    expect(power).toMatchObject({ status: 'stopped', previous: 'running' });
    // `previous` is absent on the first transition a host reports after the
    // daemon restarts, so it has to read as absent rather than as ''.
    expect(
      toComputerEvent(event({ type: 'computer.started', data: { status: 'running' } }))?.previous,
    ).toBeUndefined();
  });

  it('leaves a gap with no sequence number', () => {
    // A gap is a statement ABOUT the stream rather than a position in it. The
    // platform shipped it as `seq: 0` once, and a client applying the obvious
    // rule — ignore anything not newer than the last sequence I saw — dropped
    // the one frame that reports unrecoverable loss.
    const gap = toComputerEvent({
      cursor: 'ep-1:40',
      at: '2026-08-31T12:00:00Z',
      type: 'gap',
      computer: 'vm-1',
      source: 'daemon',
      data: {
        oldest_cursor: 'ep-1:12',
        detail: 'events happened that this computer cannot replay',
      },
    });
    expect(gap?.seq).toBeUndefined();
    expect(gap).toMatchObject({ cursor: 'ep-1:40', oldestCursor: 'ep-1:12' });
    expect(gap?.detail).toContain('cannot replay');
  });

  it('reads the two frames whose fields sit beside `type`, not inside `data`', () => {
    // `closed` and `capabilities` are written by the socket rather than by the
    // ring, and their fields are top-level. A decoder that looked in `data` for
    // them would find nothing and report a close with no reason.
    const closed = toComputerEvent({ type: 'closed', detail: 'fell too far behind' });
    expect(closed).toMatchObject({ type: 'closed', detail: 'fell too far behind' });
    const caps = toComputerEvent({
      type: 'capabilities',
      computer: 'vm-1',
      events: ['process.exited', 'computer.idle'],
      detail: 'this guest has no window bindings',
    });
    expect(caps?.events).toEqual(['process.exited', 'computer.idle']);
    expect(caps?.detail).toContain('bindings');
  });

  it('passes a type it has never heard of straight through', () => {
    // The reference says the vocabulary grows and that a client must ignore a
    // type it does not recognise. It cannot ignore what it was never handed.
    const ev = toComputerEvent(event({ type: 'file.changed', data: { path: '/tmp/x' } }));
    expect(ev?.type).toBe('file.changed');
    expect(ev?.data).toEqual({ path: '/tmp/x' });
  });

  it('reads all three shapes a file.changed arrives in', () => {
    // A typed model that assumes `path` is always there is wrong for two of
    // them. `watch` is the only field all three share, and it is the one that
    // says which nominated tree this is about.
    const change = toComputerEvent(
      event({
        type: 'file.changed',
        source: 'guest',
        data: { watch: '/home/user/p', path: '/home/user/p/a.txt', kind: 'created' },
      }),
    );
    expect(change).toMatchObject({
      watch: '/home/user/p',
      path: '/home/user/p/a.txt',
      kind: 'created',
      dir: false,
    });
    expect(change?.armed).toBeUndefined();
    expect(change?.lostReason).toBeUndefined();

    const madeDir = toComputerEvent(
      event({
        type: 'file.changed',
        source: 'guest',
        data: { watch: '/home/user/p', path: '/home/user/p/sub', kind: 'created', dir: true },
      }),
    );
    expect(madeDir?.dir).toBe(true);

    const armed = toComputerEvent(
      event({
        type: 'file.changed',
        source: 'guest',
        data: { watch: '/home/user/p', armed: true },
      }),
    );
    expect(armed).toMatchObject({ watch: '/home/user/p', armed: true });
    // Nothing is invented about a file this frame does not name — `dir: false`
    // here would describe a path that is not in it.
    expect(armed?.path).toBeUndefined();
    expect(armed?.kind).toBeUndefined();
    expect(armed?.dir).toBeUndefined();

    const lost = toComputerEvent(
      event({
        type: 'file.changed',
        source: 'guest',
        data: { watch: '/home/user/p', lost: 'flood' },
      }),
    );
    expect(lost).toMatchObject({ watch: '/home/user/p', lostReason: 'flood' });
    expect(lost?.path).toBeUndefined();
    expect(lost?.armed).toBeUndefined();
  });

  it('keeps file.changed’s `lost` off process.exited’s boolean of the same name', () => {
    // The wire spells both `lost`, and they are not the same thing: one is a
    // flag saying a command's outcome is unknown, the other a reason a tree's
    // picture is incomplete. Folded onto one field, `if (ev.lost)` over a
    // `file.changed` would read `"flood"` as a command that never ended.
    const ev = toComputerEvent(
      event({ type: 'file.changed', source: 'guest', data: { watch: '/w', lost: 'unwatchable' } }),
    );
    expect(ev?.lost).toBeUndefined();
    expect(ev?.lostReason).toBe('unwatchable');

    const exited = toComputerEvent(event({ type: 'process.exited', data: { pid: 5, lost: true } }));
    expect(exited?.lost).toBe(true);
    expect(exited?.lostReason).toBeUndefined();
  });

  it('says armed only where the platform did', () => {
    // The wire sends `armed` to announce a tree going live and never sends a
    // disarming, so a `false` here would be an event this client invented.
    const unreadable = toComputerEvent(
      event({ type: 'file.changed', source: 'guest', data: { watch: '/w', armed: 'yes' } }),
    );
    expect(unreadable?.armed).toBeUndefined();
  });

  it('is not an event for hello, or for anything that is not a frame', () => {
    expect(toComputerEvent(hello())).toBeUndefined();
    expect(toComputerEvent(null)).toBeUndefined();
    expect(toComputerEvent('hello')).toBeUndefined();
    expect(toComputerEvent({ computer: 'vm-1' })).toBeUndefined();
  });
});

describe('what the decoder refuses to invent', () => {
  it('leaves no sequence on a frame that carries one it should not', () => {
    // The platform shipped a gap with `"seq":0` once, and a client applying the
    // obvious rule — ignore anything not newer than the last sequence I saw —
    // dropped the one frame that reports unrecoverable loss. Copying that zero
    // through leaves this type's promise ("Absent is what it means") false
    // against exactly the build that made it necessary.
    for (const type of ['gap', 'closed', 'capabilities']) {
      expect(toComputerEvent({ ...event({ type }), seq: 0 })?.seq).toBeUndefined();
    }
    // And an ordinary event's own zero survives: sequence zero is a real
    // position, the first event a computer ever records.
    expect(toComputerEvent(event({ seq: 0 }))?.seq).toBe(0);
  });

  it('does not put this client’s clock where the platform’s timestamp goes', () => {
    // `at` is documented as the platform's own value. A `new Date()` there is
    // indistinguishable from one, so a frame that carried no time would have
    // the reader's wall clock read back as the writer's.
    expect(toComputerEvent({ type: 'closed', detail: 'gone' })?.at).toBe('');
    expect(toComputerEvent(event({ at: 12345 }))?.at).toBe('');
  });

  it('classifies `lost` the way this SDK classifies every other wire boolean', () => {
    // `=== true` read a string or a 1 as not-lost and then promoted the
    // exit_code beside it — the pair the comments say must never be handed over
    // together. The polarity is the opposite of `hello.ready`'s: an unreadable
    // `lost` is a command whose outcome is unknown, and `false` presents it as
    // one that finished.
    for (const lost of [true, 'true', 1, 'True']) {
      const ev = toComputerEvent(
        event({ type: 'process.exited', data: { pid: 91, lost, exit_code: -1 } }),
      );
      expect([ev?.lost, ev?.exitCode]).toEqual([true, undefined]);
    }
    // Unreadable is not a claim either way, so it stays out of `lost` — and the
    // code that came with it is still handed over.
    const odd = toComputerEvent(
      event({ type: 'process.exited', data: { pid: 91, lost: 'maybe', exit_code: 3 } }),
    );
    expect([odd?.lost, odd?.exitCode]).toEqual([false, 3]);
  });

  it('reads whole numbers only, where every field it reads is one', () => {
    // `ev.pid === job.pid` is what the whole `process.exited` wait rests on, so
    // a `91.5` arriving as a pid fails that comparison silently and looks like
    // a command that never ended. `toBackgroundExec` already refuses one.
    const ev = toComputerEvent(event({ type: 'process.exited', data: { pid: 91.5 } }));
    expect(ev?.pid).toBeUndefined();
    expect(toComputerEvent(event({ seq: 7.5 }))?.seq).toBeUndefined();
    expect(
      toComputerEvent(event({ type: 'computer.idle', data: { idle_seconds: 1800 } }))?.idleSeconds,
    ).toBe(1800);
  });
});

describe('the opening frame', () => {
  it('reads the vocabulary, the cursor and the desktop', () => {
    const h = toHello(hello({ windows: [WINDOW] }));
    expect(h).toMatchObject({ computer: 'vm-1', cursor: 'ep-1:0', ready: true });
    expect(h?.events).toContain('computer.ready');
    expect(h?.windows?.[0]).toMatchObject({ id: '0x3000003', title: 'Terminal' });
  });

  it('tells an absent desktop from an empty one', () => {
    // Present and empty means nothing is open; absent means you resumed from a
    // cursor and already hold the picture. A client that tested for length
    // rather than for the field would read the second as an empty screen.
    expect(toHello(hello({ windows: [] }))?.windows).toEqual([]);
    const { windows, ...resumed } = hello();
    expect(toHello(resumed)?.windows).toBeUndefined();
  });

  it('believes `ready` only when it was said', () => {
    // Waiting on a desktop that is up ends at the caller's timeout. Concluding
    // a desktop is up because a field was malformed hands an agent a screen
    // that is still booting, which is the half that cannot be recovered from.
    expect(toHello(hello({ ready: false }))?.ready).toBe(false);
    expect(toHello(hello({ ready: 'true' }))?.ready).toBe(false);
    const { ready, ...silent } = hello();
    expect(toHello(silent)?.ready).toBe(false);
  });

  it('is nothing for a frame that is not one', () => {
    expect(toHello(event())).toBeUndefined();
    expect(toHello(undefined)).toBeUndefined();
  });

  it('reads the trees this stream nominated, as the host spelled them back', () => {
    const h = toHello(
      hello({
        watching: [
          { path: '/home/user/p', armed: false },
          { path: '/srv/out', armed: true },
        ],
      }),
    );
    expect(h?.watching).toEqual([
      { path: '/home/user/p', armed: false },
      { path: '/srv/out', armed: true },
    ]);
  });

  it('leaves `watching` absent when nothing was nominated', () => {
    // Absent is the platform saying no `file.changed` can arrive on this socket
    // at all — a different answer from an empty list, so it is `undefined`.
    expect(toHello(hello())?.watching).toBeUndefined();
    expect(toHello(hello({ watching: [] }))?.watching).toEqual([]);
  });

  it('reads `armed` as true only, and keeps an entry it cannot read', () => {
    // TRUE only, for the reason `ready` is: a tree read as live when it is not
    // has a client taking silence for "nothing has changed" and never finding
    // out. Read as not-live when it is, the client waits — and a wait ends at
    // somebody's timeout.
    const h = toHello(
      hello({ watching: [{ path: '/w', armed: 'true' }, { armed: true }, 'not a tree'] }),
    );
    // The unreadable entry is still an entry the host answered with: dropping
    // it would make the length disagree with what was nominated, which is the
    // one thing this is read to check.
    expect(h?.watching).toEqual([
      { path: '/w', armed: false },
      { path: '', armed: true },
    ]);
  });
});

describe('the resume position on the URL', () => {
  it('adds `since` beside the credential already there', () => {
    expect(withCursor('wss://h/events?token=t', 'ep-1:8')).toBe(
      'wss://h/events?token=t&since=ep-1%3A8',
    );
    expect(withCursor('wss://h/events', 'ep-1:8')).toBe('wss://h/events?since=ep-1%3A8');
  });

  it('leaves the URL alone when there is nothing to resume from', () => {
    expect(withCursor('wss://h/events?token=t')).toBe('wss://h/events?token=t');
    expect(withCursor('wss://h/events?token=t', '')).toBe('wss://h/events?token=t');
  });

  it('repeats `watch` once per tree, beside the credential already there', () => {
    expect(withWatches('wss://h/events?token=t', ['/home/user/p', '/srv/o ut'])).toBe(
      'wss://h/events?token=t&watch=%2Fhome%2Fuser%2Fp&watch=%2Fsrv%2Fo%20ut',
    );
    expect(withWatches('wss://h/events', ['/w'])).toBe('wss://h/events?watch=%2Fw');
  });

  it('does not normalise a nomination on the way out', () => {
    // The HOST normalises, and its answer comes back in `hello.watching`. A
    // second normaliser here could only ever disagree with the one that
    // decides.
    expect(withWatches('wss://h/e?t=1', ['/home/user/./p/'])).toBe(
      'wss://h/e?t=1&watch=%2Fhome%2Fuser%2F.%2Fp%2F',
    );
  });

  it('leaves the URL alone when nothing was nominated', () => {
    expect(withWatches('wss://h/events?token=t', [])).toBe('wss://h/events?token=t');
  });
});

describe('the stream', () => {
  it('yields what the socket sends, in order', async () => {
    const { computer: c } = await computer();
    const got = await collect(
      c.events({
        reconnect: false,
        webSocket: socketFactory((s) => {
          s.emitOpen();
          s.send(hello({ ready: false }));
          s.send(event({ seq: 1, cursor: 'ep-1:2', type: 'computer.started' }));
          s.send(event({ seq: 2, cursor: 'ep-1:3', type: 'computer.idle' }));
          s.close();
        }),
      }),
    );
    expect(got.map((e) => e.type)).toEqual(['computer.started', 'computer.idle']);
  });

  it('answers what the opening frame said before the first event', async () => {
    const { computer: c } = await computer();
    const stream = c.events({
      reconnect: false,
      webSocket: socketFactory((s) => {
        s.emitOpen();
        s.send(hello({ ready: false, windows: [WINDOW] }));
        s.send(event());
        s.close();
      }),
    });
    await collect(stream);
    expect(stream.hello?.cursor).toBe('ep-1:0');
    expect(stream.windows?.[0]?.id).toBe('0x3000003');
    expect(stream.eventTypes).toContain('computer.ready');
  });

  it('turns an already-ready desktop into the event that will never come again', async () => {
    // `computer.ready` fires once per desktop SESSION. Attach to a machine that
    // has been up for an hour and the event has happened; a raw socket waiting
    // for it waits forever. The opening frame carries the state instead.
    const { computer: c } = await computer();
    const got = await collect(
      c.events({
        reconnect: false,
        webSocket: socketFactory((s) => {
          s.emitOpen();
          s.send(hello({ ready: true }));
          s.close();
        }),
      }),
    );
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ type: 'computer.ready', synthesized: true, source: 'guest' });
    // Not passed off as the platform's own: it has no position in the stream,
    // and its cursor is where this client is rather than where the desktop
    // became ready.
    expect(got[0]?.seq).toBeUndefined();
    expect(got[0]?.cursor).toBe('ep-1:0');
  });

  it('tells a gapped resume the desktop is ready, even having said so before', async () => {
    // The decision is per CONNECTION and used to be per stream, kept by a
    // latch that survived the reconnects on the argument that this client had
    // already been told. It had been told about a DIFFERENT DESKTOP
    // (OPL-4206).
    //
    // A display manager restarting inside the guest destroys the desktop and
    // brings up a new one without the computer leaving `running`. If the socket
    // then drops and the resume GAPS, the new session's own `computer.ready` is
    // in the backlog the gap says is gone — and the latch suppressed the
    // synthesized one, so `waitFor('computer.ready')` ran to its timeout on a
    // desktop that was up.
    //
    // The latch could only ever suppress where `windows` is present, which is
    // the platform saying this connection has no continuity: it was live
    // exactly where the client has least information of its own.
    const { computer: c } = await computer();
    const got = await collect(
      c.events({
        maxRetries: 1,
        backoffMs: 1,
        webSocket: socketFactory((s, n) => {
          s.emitOpen();
          // `windows` present on both: no continuity either time, which is what
          // a gapped resume looks like.
          s.send(hello({ ready: true, windows: [] }));
          if (n > 0) s.send(event({ type: 'computer.idle' }));
          s.close();
        }),
      }),
      3,
    ).catch((err) => err);
    const types = Array.isArray(got) ? got.map((e: ComputerEvent) => e.type) : [];
    expect(types.filter((t) => t === 'computer.ready')).toHaveLength(2);
    // Both marked, so a caller can tell an inference from the platform's own
    // event and reconcile with the listing rather than trusting either.
    const readies = (got as ComputerEvent[]).filter((e) => e.type === 'computer.ready');
    expect(readies.every((e) => e.synthesized === true)).toBe(true);
  });

  it('does not repeat it for a reconnect that kept its place', async () => {
    // The half that must not have been lost with the latch. A reconnect WITH
    // continuity carries no `windows`, and there the readiness either already
    // reached this client or is in the backlog about to — so nothing is made
    // up, and no duplicate is invented for the ordinary drop-and-resume that
    // costs a caller a listing call to reconcile.
    const { computer: c } = await computer();
    const { windows: _w, ...resumed } = hello({ ready: true });
    const got = await collect(
      c.events({
        since: 'ep-1:2',
        maxRetries: 1,
        backoffMs: 1,
        webSocket: socketFactory((s, n) => {
          s.emitOpen();
          s.send(resumed);
          if (n > 0) s.send(event({ type: 'computer.idle' }));
          s.close();
        }),
      }),
      2,
    ).catch((err) => err);
    const types = Array.isArray(got) ? got.map((e: ComputerEvent) => e.type) : [];
    expect(types.filter((t) => t === 'computer.ready')).toHaveLength(0);
  });

  it('does not synthesize one for a resume, where the real event is still coming', async () => {
    // `hello.windows` is present exactly when a connection has no continuity,
    // which is the platform's own test for it. With continuity the readiness
    // either already reached this client or is in the backlog about to — and a
    // manufactured one in front of the real one is a second `computer.ready`,
    // which the reference tells a client to read as a desktop replacement that
    // never happened.
    const { computer: c } = await computer();
    const { windows, ...resumed } = hello({ ready: true });
    const got = await collect(
      c.events({
        since: 'ep-1:2',
        reconnect: false,
        webSocket: socketFactory((s) => {
          s.emitOpen();
          s.send(resumed);
          s.send(event({ seq: 5, cursor: 'ep-1:6', type: 'computer.ready', source: 'guest' }));
          s.close();
        }),
      }),
    );
    expect(got.map((e) => e.type)).toEqual(['computer.ready']);
    expect(got[0]?.synthesized).toBeUndefined();
    expect(got[0]?.seq).toBe(5);
  });

  it('does synthesize one for a resume that gapped, where the backlog is gone', async () => {
    // A gap counts as no continuity and the platform sends the desktop again
    // for exactly that reason. The readiness that would have been in the
    // backlog is what the gap says cannot be replayed.
    const { computer: c } = await computer();
    const got = await collect(
      c.events({
        since: 'ep-1:2',
        reconnect: false,
        webSocket: socketFactory((s) => {
          s.emitOpen();
          s.send(hello({ ready: true, windows: [] }));
          s.send({
            cursor: 'ep-1:2',
            at: '2026-08-31T12:00:00Z',
            type: 'gap',
            computer: 'vm-1',
            source: 'daemon',
            data: { detail: 'cannot replay that far' },
          });
          s.close();
        }),
      }),
    );
    expect(got.map((e) => e.type)).toEqual(['computer.ready', 'gap']);
    expect(got[0]?.synthesized).toBe(true);
  });

  it('does not rewind the stream behind the cursor it was resuming from', async () => {
    // A gapped resume is the case: `hello.cursor` names where the CONNECTION
    // starts, which is behind the `since` the caller already holds. Carried on
    // the synthesized event and then yielded, it moved the stream's own
    // position backwards and sat in front of the gap — so a wait that returned
    // on this event handed back a cursor pointing into history the same frame
    // was about to call unrecoverable.
    const { computer: c } = await computer();
    const stream = c.events({
      since: 'ep-1:9',
      maxRetries: 1,
      backoffMs: 1,
      webSocket: socketFactory((s) => {
        s.emitOpen();
        // hello.cursor is 'ep-1:0' — far behind the resume position.
        s.send(hello({ ready: true, windows: [] }));
        s.send({
          cursor: 'ep-1:9',
          at: '2026-08-31T12:00:00Z',
          type: 'gap',
          computer: 'vm-1',
          source: 'daemon',
          data: { detail: 'cannot replay that far' },
        });
        s.close();
      }),
    });
    const got: ComputerEvent[] = [];
    for await (const ev of stream) {
      got.push(ev);
      if (got.length === 1) break;
    }
    expect(got[0]).toMatchObject({ type: 'computer.ready', synthesized: true });
    expect(got[0]?.cursor).toBe('ep-1:9');
    expect(stream.cursor).toBe('ep-1:9');
  });

  it('does not synthesize one at all when the desktop is not up', async () => {
    const { computer: c } = await computer();
    const got = await collect(
      c.events({
        reconnect: false,
        webSocket: socketFactory((s) => {
          s.emitOpen();
          s.send(hello({ ready: false }));
          s.close();
        }),
      }),
    );
    expect(got).toEqual([]);
  });

  it('hands a gap over as an event rather than throwing or swallowing it', async () => {
    // Throwing would be wrong and swallowing would be worse: a gap is the one
    // signal that says what you missed is unrecoverable.
    const { computer: c } = await computer();
    const got = await collect(
      c.events({
        since: 'ep-1:2',
        reconnect: false,
        webSocket: socketFactory((s) => {
          s.emitOpen();
          s.send(hello({ ready: false, windows: [] }));
          s.send({
            cursor: 'ep-1:2',
            at: '2026-08-31T12:00:00Z',
            type: 'gap',
            computer: 'vm-1',
            source: 'daemon',
            data: { oldest_cursor: 'ep-1:12', detail: 'cannot replay that far' },
          });
          s.send(event({ seq: 12, cursor: 'ep-1:13' }));
          s.close();
        }),
      }),
    );
    expect(got.map((e) => e.type)).toEqual(['gap', 'computer.idle']);
    expect(got[0]?.oldestCursor).toBe('ep-1:12');
  });

  it('hands over the `closed` frame this host writes before it goes', async () => {
    const { computer: c } = await computer();
    const got = await collect(
      c.events({
        reconnect: false,
        webSocket: socketFactory((s) => {
          s.emitOpen();
          s.send(hello({ ready: false }));
          s.send({ type: 'closed', detail: 'this host no longer holds this computer' });
          s.close();
        }),
      }),
    );
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ type: 'closed' });
    expect(got[0]?.detail).toContain('no longer holds');
  });

  it('lets a capabilities frame revise what this computer can emit', async () => {
    const { computer: c } = await computer();
    const stream = c.events({
      reconnect: false,
      webSocket: socketFactory((s) => {
        s.emitOpen();
        s.send(hello({ ready: false }));
        s.send({
          type: 'capabilities',
          computer: 'vm-1',
          events: ['process.exited', 'computer.idle'],
          detail: 'this guest has no window bindings',
        });
        s.close();
      }),
    });
    await collect(stream);
    expect(stream.eventTypes).toEqual(['process.exited', 'computer.idle']);
  });

  it('drops a frame that is not text JSON without ending the stream', async () => {
    // A proxy's error page reaching a websocket is not an event, and nothing on
    // this stream sends binary. Neither is worth losing the connection over.
    const { computer: c } = await computer();
    const got = await collect(
      c.events({
        reconnect: false,
        webSocket: socketFactory((s) => {
          s.emitOpen();
          s.send(hello({ ready: false }));
          s.send('<html>502</html>');
          s.sendRaw(new Uint8Array([1, 2, 3]));
          s.send(event());
          s.close();
        }),
      }),
    );
    expect(got.map((e) => e.type)).toEqual(['computer.idle']);
  });

  it('hands out its state rather than a handle on it', async () => {
    // `eventTypes` is what decides whether a wait can end — `waitFor` refuses a
    // type that is not in it — so the live array would let
    // `stream.eventTypes.push(...)` talk a wait into hanging on a machine that
    // cannot produce the event.
    const { computer: c } = await computer();
    const stream = c.events({
      reconnect: false,
      webSocket: socketFactory((s) => {
        s.emitOpen();
        s.send(hello({ ready: false, windows: [WINDOW] }));
        s.close();
      }),
    });
    await collect(stream);
    stream.eventTypes?.push('window.invented');
    stream.windows?.pop();
    expect(stream.eventTypes).not.toContain('window.invented');
    expect(stream.windows).toHaveLength(1);
  });

  it('refuses a second consumer rather than splitting the events between two', async () => {
    const { computer: c } = await computer();
    const stream = c.events({
      reconnect: false,
      webSocket: socketFactory((s) => {
        s.emitOpen();
        s.send(hello({ ready: false }));
        s.close();
      }),
    });
    await collect(stream);
    await expect(collect(stream)).rejects.toThrow(/already being consumed/);
  });
});

describe('reconnecting', () => {
  it('resumes from the last event CONSUMED, not the last one received', async () => {
    // The whole reason the cursor advances at the yield: a socket that dropped
    // with frames still queued has not delivered them, and a position taken on
    // arrival would resume past events the caller never saw.
    const { computer: c } = await computer();
    const urls: string[] = [];
    const stream = c.events({
      maxRetries: 1,
      backoffMs: 1,
      webSocket: socketFactory((s, n) => {
        urls.push(s.url);
        s.emitOpen();
        s.send(hello({ ready: false }));
        if (n === 0) {
          s.send(event({ seq: 1, cursor: 'ep-1:2' }));
          // Two more arrive and are never consumed, because the loop below
          // stops after the first and the socket dies with them queued.
          s.send(event({ seq: 2, cursor: 'ep-1:3' }));
          s.send(event({ seq: 3, cursor: 'ep-1:4' }));
        }
        s.close();
      }),
    });
    const got: ComputerEvent[] = [];
    for await (const ev of stream) {
      got.push(ev);
      if (got.length === 1) break;
    }
    expect(got[0]?.cursor).toBe('ep-1:2');
    expect(stream.cursor).toBe('ep-1:2');
    expect(urls[0]).not.toContain('since=');
  });

  it('re-reads the computer for a fresh events_url on every connection', async () => {
    // A restart rotates the desktop credential and closes the live socket, so
    // the URL that was open a second ago answers 401 — a reconnect that reused
    // it would look like a bug in this file.
    const { computer: c, rec } = await computer();
    const before = rec.calls.length;
    const urls: string[] = [];
    await collect(
      c.events({
        maxRetries: 1,
        backoffMs: 1,
        webSocket: socketFactory((s, n) => {
          urls.push(s.url);
          s.emitOpen();
          s.send(hello({ ready: false }));
          if (n > 0) s.send(event({ cursor: 'ep-1:9' }));
          s.close();
        }),
      }),
      1,
    );
    const reads = rec.calls.slice(before).filter((call) => call.path === '/computers/vm-1');
    expect(reads.length).toBeGreaterThanOrEqual(2);
    expect(urls.length).toBeGreaterThanOrEqual(2);
  });

  it('carries the consumed cursor onto the next connection', async () => {
    const { computer: c } = await computer();
    const urls: string[] = [];
    await collect(
      c.events({
        maxRetries: 2,
        backoffMs: 1,
        webSocket: socketFactory((s, n) => {
          urls.push(s.url);
          s.emitOpen();
          s.send(hello({ ready: false }));
          if (n === 0) s.send(event({ seq: 1, cursor: 'ep-1:2' }));
          if (n === 1) s.send(event({ seq: 2, cursor: 'ep-1:3' }));
          s.close();
        }),
      }),
      2,
    );
    expect(urls[1]).toContain('since=ep-1%3A2');
  });

  it('ends rather than reopening when reconnect is off', async () => {
    const { computer: c } = await computer();
    let opened = 0;
    const got = await collect(
      c.events({
        reconnect: false,
        webSocket: socketFactory((s) => {
          opened += 1;
          s.emitOpen();
          s.send(hello({ ready: false }));
          s.close();
        }),
      }),
    );
    expect(got).toEqual([]);
    expect(opened).toBe(1);
  });

  it('gives up after maxRetries consecutive failures', async () => {
    const { computer: c } = await computer();
    let opened = 0;
    await expect(
      collect(
        c.events({
          maxRetries: 2,
          backoffMs: 1,
          webSocket: socketFactory((s) => {
            opened += 1;
            s.emitOpen();
            s.send(hello({ ready: false }));
            s.close();
          }),
        }),
      ),
    ).rejects.toThrow(ConnectionError);
    expect(opened).toBe(3);
  });

  it('closes the socket when the queue fills, and delivers what is already in it', async () => {
    // A websocket cannot be paused, so an unread queue has to be bounded by
    // something, and the reader is parked at a `yield` while a slow consumer
    // thinks — so the bound has to act from the push. Closing the socket stops
    // more arriving without discarding what has: nothing is lost, and the
    // reconnect resumes from where the caller actually got to.
    const { computer: c } = await computer();
    const urls: string[] = [];
    const got = await collect(
      c.events({
        maxQueued: 2,
        backoffMs: 1,
        webSocket: socketFactory((s, n) => {
          urls.push(s.url);
          s.emitOpen();
          s.send(hello({ ready: false }));
          if (n === 0) {
            for (let i = 1; i <= 5; i++) s.send(event({ seq: i, cursor: `ep-1:${i + 1}` }));
          } else {
            s.send(event({ seq: 9, cursor: 'ep-1:10', type: 'computer.stopped' }));
          }
        }),
      }),
      4,
    );
    // Three landed before the cap was crossed and all three are delivered; the
    // two the closed socket never sent are the ones the reconnect asks for.
    expect(got.map((e) => e.cursor)).toEqual(['ep-1:2', 'ep-1:3', 'ep-1:4', 'ep-1:10']);
    expect(urls[1]).toContain('since=ep-1%3A4');
  });

  it('holds the queue bound against a socket that goes on delivering while it closes', async () => {
    // The test above closes the socket and the stub stops dead, which is not
    // what a real one does: `close()` starts a handshake, the socket sits in
    // CLOSING, and everything already buffered still dispatches. `linger`
    // models that, so the bound has to come from the stream rather than from
    // the double — the queue stops accepting data frames and the message
    // listener is taken off the socket at the same moment.
    //
    // Refusing them is not silent loss: the cursor advances at the YIELD, so a
    // frame turned away here was never handed to anybody and the reconnect asks
    // for it again.
    const { computer: c } = await computer();
    const urls: string[] = [];
    const got = await collect(
      c.events({
        maxQueued: 2,
        backoffMs: 1,
        webSocket: socketFactory((s, n) => {
          urls.push(s.url);
          s.linger = true;
          s.emitOpen();
          s.send(hello({ ready: false }));
          if (n === 0) {
            // The stream closes the socket on the third of these, from inside
            // the push that crosses the cap. The socket is then CLOSING, not
            // closed, so four and five are still delivered to the listener —
            // and they arrive BEFORE the close handshake finishes, which is
            // what puts them ahead of the `end` that stops the reader.
            for (let i = 1; i <= 5; i++) s.send(event({ seq: i, cursor: `ep-1:${i + 1}` }));
            expect(s.closing).toBe(true);
            s.emitClose();
          } else {
            s.send(event({ seq: 9, cursor: 'ep-1:10', type: 'computer.stopped' }));
          }
        }),
      }),
      4,
    );
    // Exactly what the non-lingering socket delivers: three landed before the
    // cap was crossed, and the two that arrived after it are the ones the
    // reconnect asks for. Without the bound the lingering socket queues them
    // both and the resume is from ep-1:6.
    expect(got.map((e) => e.cursor)).toEqual(['ep-1:2', 'ep-1:3', 'ep-1:4', 'ep-1:10']);
    expect(urls[1]).toContain('since=ep-1%3A4');
  });

  it('does not let a caller edit the vocabulary it was handed', async () => {
    // `eventTypes` copies on the way out so a caller cannot fake what this
    // computer can emit — that list is what decides whether a wait can ever
    // end. `hello` used to return the frame those types live ON, which is the
    // same array through a door nobody had shut.
    const { computer: c } = await computer();
    const stream = c.events({
      webSocket: socketFactory((s) => {
        s.emitOpen();
        s.send(hello({ ready: false, events: ['process.exited'], windows: [WINDOW] }));
        s.send(event());
      }),
    });
    await collect(stream, 1);
    const windowsBefore = stream.windows?.length ?? 0;
    stream.hello?.events.push('window.opened');
    const first = stream.hello?.windows?.[0];
    if (first) stream.hello?.windows?.push({ ...first });
    // Neither door reaches the stream's own copy: `eventTypes` is what a wait
    // consults, and `windows` is the desktop it reports.
    expect(stream.eventTypes).toEqual(['process.exited']);
    expect(stream.hello?.events).toEqual(['process.exited']);
    expect(stream.windows?.length ?? 0).toBe(windowsBefore);
    expect(windowsBefore).toBe(1);
    stream.close();
  });

  it('does not let a caller edit the vocabulary a capabilities frame carried', async () => {
    // The sibling door to the one above: `#interpret` stores the array off the
    // `capabilities` event it is about to YIELD, so a consumer editing what it
    // was handed inside its own `for await` edits the list a wait consults.
    const { computer: c } = await computer();
    const stream = c.events({
      webSocket: socketFactory((s) => {
        s.emitOpen();
        s.send(hello({ ready: false, events: ['process.exited'] }));
        s.send({ type: 'capabilities', events: ['process.exited', 'computer.idle'] });
        s.send(event());
      }),
    });
    for await (const ev of stream) {
      if (ev.type === 'capabilities' && ev.events) ev.events.push('window.opened');
      if (ev.type === 'computer.idle') break;
    }
    expect(stream.eventTypes).toEqual(['process.exited', 'computer.idle']);
    stream.close();
  });

  it('does not let a connect hook edit the frame the stream kept', async () => {
    // `onConnect` is handed the live opening frame, so storing that same object
    // let the two getters over it disagree — `eventTypes` reporting what the
    // platform said while `hello.events` reported what the hook had added.
    const { computer: c } = await computer();
    const stream = c.events({
      onConnect: (h) => {
        h.events.push('window.opened');
        const first = h.windows?.[0];
        if (first) h.windows?.push({ ...first });
      },
      webSocket: socketFactory((s) => {
        s.emitOpen();
        s.send(hello({ ready: false, events: ['process.exited'], windows: [WINDOW] }));
        s.send(event());
      }),
    });
    await collect(stream, 1);
    expect(stream.eventTypes).toEqual(['process.exited']);
    expect(stream.hello?.events).toEqual(['process.exited']);
    expect(stream.windows?.length).toBe(1);
    stream.close();
  });

  it('says so when the queue filled and there is no reconnect to recover it', async () => {
    // Refusing frames past the cap is lossless only BECAUSE the reconnect asks
    // for them again from the cursor. With reconnect off there is nothing to
    // ask, so what was turned away is gone — and ending the loop cleanly would
    // read as the stream having finished rather than having been cut short.
    const { computer: c } = await computer();
    const stream = c.events({
      maxQueued: 2,
      reconnect: false,
      webSocket: socketFactory((s) => {
        s.linger = true;
        s.emitOpen();
        s.send(hello({ ready: false }));
        for (let i = 1; i <= 5; i++) s.send(event({ seq: i, cursor: `ep-1:${i + 1}` }));
        s.emitClose();
      }),
    });
    const got: ComputerEvent[] = [];
    const err = await (async () => {
      try {
        for await (const ev of stream) got.push(ev);
        return undefined;
      } catch (e) {
        return e;
      }
    })();
    // Everything queued before the cap is still delivered, and then it says
    // what happened to the rest rather than stopping quietly.
    expect(got.map((e) => e.cursor)).toEqual(['ep-1:2', 'ep-1:3', 'ep-1:4']);
    expect(String(err)).toContain('reconnect is off');
  });

  it('ends quietly when the queue never filled and there is no reconnect', async () => {
    const { computer: c } = await computer();
    const stream = c.events({
      maxQueued: 8,
      reconnect: false,
      webSocket: socketFactory((s) => {
        s.emitOpen();
        s.send(hello({ ready: false }));
        s.send(event({ seq: 1, cursor: 'ep-1:2' }));
        s.emitClose();
      }),
    });
    const got: ComputerEvent[] = [];
    for await (const ev of stream) got.push(ev);
    expect(got.map((e) => e.cursor)).toEqual(['ep-1:2']);
  });

  it('still reports a vocabulary the platform replaced mid-stream', async () => {
    const { computer: c } = await computer();
    const stream = c.events({
      webSocket: socketFactory((s) => {
        s.emitOpen();
        s.send(hello({ ready: false, events: ['process.exited'] }));
        s.send({ type: 'capabilities', events: ['process.exited', 'window.opened'] });
        s.send(event());
      }),
    });
    await collect(stream, 1);
    expect(stream.eventTypes).toEqual(['process.exited', 'window.opened']);
    stream.close();
  });

  it('stops when the caller aborts, and does not throw for it', async () => {
    const { computer: c } = await computer();
    const stop = new AbortController();
    const stream = c.events({
      signal: stop.signal,
      webSocket: socketFactory((s) => {
        s.emitOpen();
        s.send(hello({ ready: false }));
        s.send(event());
      }),
    });
    const got: ComputerEvent[] = [];
    for await (const ev of stream) {
      got.push(ev);
      // The socket is still open and has nothing more to say, so the loop is
      // parked in the queue: an abort has to reach a reader that is waiting on
      // a frame rather than only one between frames.
      stop.abort();
    }
    expect(got.map((e) => e.type)).toEqual(['computer.idle']);
  });
});

describe('a connection that fails after it was told hello', () => {
  it('does not spend a readiness the caller never received', async () => {
    // The latch has to sit where the event reaches the caller, not where it was
    // queued. A connection that fails between the two takes its whole queue
    // with it, and a latch set at the push leaves the stream believing it
    // delivered a readiness nobody got — so the next connection declines to
    // synthesize and a wait on an already-ready desktop waits for an event that
    // cannot happen twice.
    let connections = 0;
    const { computer: c } = await computer();
    const got = await collect(
      c.events({
        backoffMs: 1,
        maxRetries: 3,
        connectTimeoutMs: 200,
        // The first connection's hook throws, which is what discards its queue.
        onConnect: () => {
          if (connections++ === 0) throw new Error('the caller’s hook blew up');
        },
        webSocket: socketFactory((s) => {
          s.emitOpen();
          s.send(hello({ ready: true }));
        }),
      }),
      1,
    );
    expect(got.map((e) => e.type)).toEqual(['computer.ready']);
    expect(got[0]?.synthesized).toBe(true);
    expect(connections).toBe(2);
  });

  it('treats a throwing onConnect as the failed connection its docs promise', async () => {
    // The hook ran from the websocket message listener, so a throw was an
    // EventTarget exception: it skipped the hello handoff, and the connect
    // deadline expired reporting a stream that "said nothing" — while the
    // option documented the throw as being caught by the reconnect logic.
    // `waitFor` is written around that promise.
    const { computer: c } = await computer();
    const started = Date.now();
    const err = await collect(
      c.events({
        reconnect: false,
        connectTimeoutMs: 10_000,
        onConnect: () => {
          throw new Error('nope');
        },
        webSocket: socketFactory((s) => {
          s.emitOpen();
          s.send(hello({ ready: false }));
        }),
      }),
    ).catch((e) => e);
    expect(String(err)).toContain('nope');
    // Immediately, rather than after the connect deadline it used to wait out.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('gives up on a handshake that never completes, and releases the socket', async () => {
    // The socket IS released either way — `#run`'s catch shuts it — so this
    // asserts the outcome and not the promptness. Closing it at the point of
    // giving up rather than one catch further out is still right, and the
    // window it removes is a few microtasks wide: no test here can tell the two
    // apart without becoming a race, and a green test that cannot fail is worse
    // than a note saying so.
    const seen: FakeSocket[] = [];
    const { computer: c } = await computer();
    const err = await collect(
      c.events({
        reconnect: false,
        connectTimeoutMs: 60,
        // Never opens: the handshake deadline is what ends this.
        webSocket: socketFactory((s) => {
          seen.push(s);
        }),
      }),
    ).catch((e) => e);
    expect(String(err)).toContain('did not open within');
    expect(seen[0]?.closed).toBe(true);
  });

  it('spends one connect budget across the handshake and the opening frame', async () => {
    // Two sequential timers of `connectTimeoutMs` mean a caller who set five
    // seconds waits ten — on the one number they set to bound how long a dead
    // connection ties them up.
    //
    // The socket opens LATE and then says nothing, because that is the only
    // shape that can tell the two apart: a socket that opens at once spends
    // nothing on the first phase, so one budget and two are the same number and
    // the test cannot fail. Written the easy way first, it passed with the bug
    // reinstated.
    const { computer: c } = await computer();
    const started = Date.now();
    const err = await collect(
      c.events({
        reconnect: false,
        connectTimeoutMs: 300,
        webSocket: socketFactory((s) => {
          setTimeout(() => s.emitOpen(), 200);
        }),
      }),
    ).catch((e) => e);
    expect(String(err)).toContain('said nothing within');
    // One budget: ~300ms from the start. Two: 200 to open plus a fresh 300.
    expect(Date.now() - started).toBeLessThan(450);
  });
});

describe('nominating a tree to watch', () => {
  it('puts one `watch` on the URL per tree, and puts them back on every reconnect', async () => {
    // A nomination is not a cursor: it is fixed for the life of the
    // subscription, and without it no `file.changed` can arrive at all. A
    // reconnect that dropped it would come back to a socket that is healthy and
    // silent — the one failure a caller cannot tell from a quiet directory.
    const { computer: c } = await computer();
    const urls: string[] = [];
    await collect(
      c.events({
        watch: ['/home/user/p', '/srv/out'],
        backoffMs: 1,
        maxRetries: 1,
        webSocket: socketFactory((s, n) => {
          urls.push(s.url);
          s.emitOpen();
          s.send(hello({ ready: false, cursor: 'ep-1:0', watching: [] }));
          s.send(event({ cursor: 'ep-1:5' }));
          if (n === 0) return s.close();
        }),
      }),
      2,
    );
    expect(urls[0]).toBe('wss://host/events?token=t&watch=%2Fhome%2Fuser%2Fp&watch=%2Fsrv%2Fout');
    // And beside the resume position, which the reconnect adds on top.
    expect(urls[1]).toBe(
      'wss://host/events?token=t&watch=%2Fhome%2Fuser%2Fp&watch=%2Fsrv%2Fout&since=ep-1%3A5',
    );
  });

  it('takes a single path as well as a list', async () => {
    const { computer: c } = await computer();
    const urls: string[] = [];
    await collect(
      c.events({
        watch: '/home/user/p',
        reconnect: false,
        webSocket: socketFactory((s) => {
          urls.push(s.url);
          s.emitOpen();
          s.send(hello({ ready: false }));
          s.close();
        }),
      }),
    );
    expect(urls[0]).toBe('wss://host/events?token=t&watch=%2Fhome%2Fuser%2Fp');
  });

  it('surfaces what the host gave back, which is not what was sent', async () => {
    // The host normalises a nomination — a trailing slash and a `.` segment are
    // cleaned away — and the cleaned form is what every event carries. A client
    // matching on what it sent matches nothing.
    const { computer: c } = await computer();
    const stream = c.events({
      watch: '/home/user/./p/',
      reconnect: false,
      webSocket: socketFactory((s) => {
        s.emitOpen();
        s.send(hello({ ready: false, watching: [{ path: '/home/user/p', armed: false }] }));
        s.send(
          event({
            type: 'file.changed',
            source: 'guest',
            data: { watch: '/home/user/p', armed: true },
          }),
        );
        s.close();
      }),
    });
    const got = await collect(stream);
    expect(stream.watching).toEqual([{ path: '/home/user/p', armed: false }]);
    expect(got[0]?.watch).toBe('/home/user/p');
    expect(got[0]?.armed).toBe(true);
    // `hello` carries it too, and both are copies: a caller who edits what they
    // were handed has changed their own record, not this stream's next answer.
    stream.watching?.push({ path: '/hacked', armed: true });
    (stream.hello?.watching ?? []).push({ path: '/hacked', armed: true });
    expect(stream.watching).toHaveLength(1);
    // The ENTRIES too, and not only the array around them. Shared, the three
    // "snapshots" were one object: an edit to a tree handed out reached the
    // frame behind it, and the next read gave the edit back as though the host
    // had said it.
    const handed = stream.watching;
    if (handed?.[0]) handed[0].armed = true;
    const hello0 = stream.hello?.watching?.[0];
    if (hello0) hello0.path = '/hacked';
    expect(stream.watching).toEqual([{ path: '/home/user/p', armed: false }]);
  });

  it('hands a connect hook a frame it cannot edit this stream through', async () => {
    // `onConnect` is given the LIVE opening frame, which is the one door the
    // copies beside this were added to shut. A hook that edits an entry must
    // not be able to talk the stream into reporting a tree as live.
    const { computer: c } = await computer();
    const stream = c.events({
      watch: '/w',
      reconnect: false,
      onConnect: (h) => {
        const first = h.watching?.[0];
        if (first) first.armed = true;
      },
      webSocket: socketFactory((s) => {
        s.emitOpen();
        s.send(hello({ ready: false, watching: [{ path: '/w', armed: false }] }));
        s.send(event());
        s.close();
      }),
    });
    await collect(stream);
    expect(stream.watching).toEqual([{ path: '/w', armed: false }]);
  });

  it('re-answers arming per connection, because no event says it', async () => {
    // The guest answers a nomination once. A tree that was not live on the
    // connection that dropped can be live on the one that replaced it, and
    // there is no `armed` event for a client that was not there to hear the
    // first one.
    const { computer: c } = await computer();
    const stream = c.events({
      watch: '/w',
      backoffMs: 1,
      maxRetries: 1,
      webSocket: socketFactory((s, n) => {
        s.emitOpen();
        s.send(hello({ ready: false, watching: [{ path: '/w', armed: n > 0 }] }));
        s.send(event({ cursor: `ep-1:${n + 1}` }));
        if (n === 0) s.close();
      }),
    });
    await collect(stream, 2);
    expect(stream.watching).toEqual([{ path: '/w', armed: true }]);
  });

  it('refuses a nomination the platform would refuse silently', async () => {
    // A `400` for a path this host cannot honour, and a `409` for one tree too
    // many, reach a websocket client as the same empty 1006 close a rotated
    // credential gives — so with reconnect on, the default, they are a stream
    // that reopens forever and never says why. The two this SDK can refuse
    // locally are refused before a socket is opened at all.
    const { computer: c } = await computer();
    expect(() => c.events({ watch: 'home/user/p' })).toThrow(ValidationError);
    expect(() => c.events({ watch: 'C:\\Users\\p' })).toThrow(ValidationError);
    expect(() => c.events({ watch: '' })).toThrow(ValidationError);
    expect(() => c.events({ watch: ['/a', '/b', '/c', '/d', '/e'] })).toThrow(ValidationError);
    // A `watch` this SDK cannot make sense of is refused rather than read as a
    // stream that nominated nothing — which opens quietly and reports no file
    // change ever, on a call that asked for them.
    expect(() => c.events({ watch: 42 as unknown as string })).toThrow(ValidationError);
    // Four is the limit, not the refusal.
    expect(() => c.events({ watch: ['/a', '/b', '/c', '/d'] })).not.toThrow();
  });

  it('refuses the root, however it is spelled', async () => {
    // Watching everything is the one thing this feature exists to make
    // impossible to ask for by accident: it would spend the directory budget on
    // /usr before reaching anything the caller cares about and report `lost`
    // forever. The platform refuses it with a 400, which reaches a websocket
    // client as the same silence a rotated credential does.
    const { computer: c } = await computer();
    for (const root of ['/', '//', '/.', '/./', '/home/..', '/a/b/../..']) {
      expect(() => c.events({ watch: root })).toThrow(ValidationError);
    }
    // A path that merely PASSES THROUGH the root's spellings is a directory.
    expect(() => c.events({ watch: '/home/user/../user/./p/' })).not.toThrow();
  });

  it('refuses a path the platform bounds, before the upgrade does', async () => {
    const { computer: c } = await computer();
    // 256 bytes is the platform's own bound, and it counts BYTES.
    expect(() => c.events({ watch: `/${'a'.repeat(255)}` })).not.toThrow();
    expect(() => c.events({ watch: `/${'a'.repeat(256)}` })).toThrow(ValidationError);
    expect(() => c.events({ watch: `/${'é'.repeat(128)}` })).toThrow(ValidationError);
    // A newline in a path this host echoes back and logs is a caller choosing
    // what somebody else's terminal renders.
    expect(() => c.events({ watch: '/home/user/p\n/etc' })).toThrow(ValidationError);
    // A lone surrogate is the one bad path the upgrade would NOT refuse:
    // percent-encoding turns it into a replacement character, so the host is
    // handed a valid path that is not the one that was asked for.
    expect(() => c.events({ watch: '/home/\ud800/p' })).toThrow(ValidationError);
  });

  it('counts the cap in trees, the way the platform counts it', async () => {
    // The host cleans and de-duplicates BEFORE it applies the limit, so five
    // spellings of four directories is a stream it opens. Counting the array
    // instead refused a nomination the platform accepts — the same defect as
    // accepting one it refuses, pointed the other way.
    const { computer: c } = await computer();
    expect(() => c.events({ watch: ['/a/b', '/a/b/', '/a/./b', '/c', '/c/'] })).not.toThrow();
    expect(() => c.events({ watch: ['/a', '/b', '/c', '/d', '/e'] })).toThrow(
      /at most 4 directories on one stream \(got 5\)/,
    );
  });

  it('sends the nomination as it was written, not as it was counted', async () => {
    // The cleaning above is for the two refusals and for nothing else. What
    // goes on the wire is what the caller wrote, because the HOST's answer in
    // `hello.watching` is what a client matches on and a second normaliser here
    // could only ever disagree with the one that decides.
    const { computer: c } = await computer();
    const urls: string[] = [];
    await collect(
      c.events({
        watch: '/home/user/../user/./p/',
        reconnect: false,
        webSocket: socketFactory((s) => {
          urls.push(s.url);
          s.emitOpen();
          s.send(hello({ ready: false }));
          s.close();
        }),
      }),
    );
    expect(urls[0]).toContain(encodeURIComponent('/home/user/../user/./p/'));
  });

  it('names the nominations when a refused upgrade says nothing else', async () => {
    // The computer reports itself running, so the refusal was about the
    // connection — and a stream that nominates trees has two more ways to reach
    // exactly this silence. It stays retryable, because none of them can be
    // told apart from a rotated credential; what changes is that the sentence
    // stops pretending the watches are not a candidate.
    const { computer: c } = await computer();
    const err = await collect(
      c.events({
        watch: '/home/user/p',
        backoffMs: 1,
        maxRetries: 1,
        webSocket: socketFactory((s) => s.emitError()),
      }),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ConnectionError);
    expect(String(err)).toContain('/home/user/p');
    expect(String(err)).toContain('already watching its limit');
    expect(isSettled(err)).toBe(false);
  });
});

describe('a refusal on the upgrade', () => {
  it('reads a suspended computer off the computer, because the socket cannot say', async () => {
    // A 409, a 401 and a TCP reset all reach a WebSocket client as an error
    // with an empty message and a 1006 close. The state is asked for instead.
    const { computer: c } = await computer(() => json({ ...COMPUTER, status: 'suspended' }));
    const err = await collect(
      c.events({
        webSocket: socketFactory((s) => s.emitError()),
      }),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(MandalaError);
    expect(String(err)).toContain('suspended');
    // A decision, not weather: retried, this asks a machine that is off the
    // same question every fifteen seconds for as long as the process lives.
    expect(isSettled(err)).toBe(true);
  });

  it('says the same of a stopped one', async () => {
    const { computer: c } = await computer(() => json({ ...COMPUTER, status: 'stopped' }));
    const err = await collect(c.events({ webSocket: socketFactory((s) => s.emitClose()) })).catch(
      (e) => e,
    );
    expect(String(err)).toContain('"stopped"');
    expect(isSettled(err)).toBe(true);
  });

  it('retries when the computer says it is running', async () => {
    // Then the refusal was about the connection rather than the machine — a
    // rotated credential, an edge in the way — and that is what a reconnect is
    // for.
    const { computer: c } = await computer();
    let attempts = 0;
    const got = await collect(
      c.events({
        backoffMs: 1,
        maxRetries: 3,
        webSocket: socketFactory((s) => {
          attempts += 1;
          if (attempts < 3) return s.emitError();
          s.emitOpen();
          s.send(hello({ ready: false }));
          s.send(event());
          s.close();
        }),
      }),
      1,
    );
    expect(got.map((e) => e.type)).toEqual(['computer.idle']);
    expect(attempts).toBe(3);
  });

  it('lets the read that failed be the answer', async () => {
    // A 404 says the computer is gone and a 401 says the key is. Both are
    // better sentences than anything this SDK could infer from a 1006 — and
    // neither is worth reconnecting over.
    let reads = 0;
    const { computer: c } = await computer((call) => {
      if (call.path === '/computers/vm-1' && reads++ > 0) {
        return errorJson(404, 'no such computer');
      }
      return json(COMPUTER);
    });
    const err = await collect(
      c.events({ backoffMs: 1, webSocket: socketFactory((s) => s.emitError()) }),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect(isSettled(err)).toBe(true);
  });

  it('refuses a computer whose connect surface has no stream', async () => {
    const { computer: c } = await computer(() =>
      json({ ...COMPUTER, os: 'windows', vnc: { ...COMPUTER.vnc, events_url: undefined } }),
    );
    const err = await collect(c.events({ webSocket: socketFactory(() => {}) })).catch((e) => e);
    expect(String(err)).toContain('Windows');
    expect(isSettled(err)).toBe(true);
  });

  it('treats a missing connect surface as the unreachable host it is', async () => {
    // The platform omits `vnc` entirely when it could not reach the host
    // holding this computer. That clears; it is not a decision about the
    // machine, so it must not be marked settled.
    const { computer: c } = await computer(() => json({ ...COMPUTER, vnc: undefined }));
    const err = await collect(
      c.events({ reconnect: false, webSocket: socketFactory(() => {}) }),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ConnectionError);
    expect(isSettled(err)).toBe(false);
  });
});

describe('waitFor', () => {
  it('returns the first matching event and closes the socket', async () => {
    const { computer: c } = await computer();
    let socket: FakeSocket | undefined;
    const ev = await c.waitFor('process.exited', {
      timeoutMs: 2_000,
      webSocket: socketFactory((s) => {
        socket = s;
        s.emitOpen();
        s.send(hello({ ready: false }));
        s.send(event({ type: 'computer.idle' }));
        s.send(event({ type: 'process.exited', data: { pid: 91, exit_code: 0 } }));
      }),
    });
    expect(ev).toMatchObject({ type: 'process.exited', pid: 91, exitCode: 0 });
    expect(socket?.closed).toBe(true);
  });

  it('takes a list, and returns whichever arrives', async () => {
    const { computer: c } = await computer();
    const ev = await c.waitFor(['process.exited', 'computer.stopped'], {
      timeoutMs: 2_000,
      webSocket: socketFactory((s) => {
        s.emitOpen();
        s.send(hello({ ready: false }));
        s.send(event({ type: 'computer.stopped', data: { status: 'stopped' } }));
      }),
    });
    expect(ev.type).toBe('computer.stopped');
  });

  it('returns at once on a desktop that is already ready', async () => {
    // The call the whole feature exists for, on the machine it is most often
    // called about: one somebody else already brought up.
    const { computer: c } = await computer();
    const ev = await c.waitFor('computer.ready', {
      timeoutMs: 2_000,
      webSocket: socketFactory((s) => {
        s.emitOpen();
        s.send(hello({ ready: true }));
      }),
    });
    expect(ev).toMatchObject({ type: 'computer.ready', synthesized: true });
  });

  it('refuses an event this computer cannot emit rather than waiting it out', async () => {
    // A guest with no watcher never sends `window.opened`, and the opening
    // frame says so. Waiting is then indistinguishable, from inside the loop,
    // from a desktop that is slow.
    const { computer: c } = await computer();
    const err = await c
      .waitFor('window.opened', {
        timeoutMs: 30_000,
        webSocket: socketFactory((s) => {
          s.emitOpen();
          s.send(hello({ ready: false, events: ['process.exited', 'computer.idle'] }));
        }),
      })
      .catch((e) => e);
    expect(String(err)).toContain('cannot emit window.opened');
    expect(isSettled(err)).toBe(true);
  });

  it('refuses it even when a connect hook edited the vocabulary first', async () => {
    // `waitFor` composes the caller's `onConnect` AHEAD of its own check, so
    // the frame the hook is handed is the one the check then read. A hook that
    // pushed the wanted type onto `hello.events` made this computer look able
    // to emit the very thing the wait is about to prove it cannot, and the wait
    // ran to its deadline instead of saying so.
    const { computer: c } = await computer();
    const err = await c
      .waitFor('window.opened', {
        timeoutMs: 30_000,
        onConnect: (h) => h.events.push('window.opened'),
        webSocket: socketFactory((s) => {
          s.emitOpen();
          s.send(hello({ ready: false, events: ['process.exited', 'computer.idle'] }));
        }),
      })
      .catch((e) => e);
    expect(String(err)).toContain('cannot emit window.opened');
    expect(isSettled(err)).toBe(true);
  });

  it('waits when at least one of the wanted types is possible', async () => {
    const { computer: c } = await computer();
    const ev = await c.waitFor(['window.opened', 'process.exited'], {
      timeoutMs: 2_000,
      webSocket: socketFactory((s) => {
        s.emitOpen();
        s.send(hello({ ready: false, events: ['process.exited'] }));
        s.send(event({ type: 'process.exited', data: { pid: 5, exit_code: 0 } }));
      }),
    });
    expect(ev.pid).toBe(5);
  });

  it('gives up when a capabilities frame withdraws the type mid-wait', async () => {
    // The revision exists precisely so a caller stops waiting for something the
    // guest turned out to be unable to produce.
    const { computer: c } = await computer();
    const err = await c
      .waitFor('computer.ready', {
        timeoutMs: 30_000,
        webSocket: socketFactory((s) => {
          s.emitOpen();
          s.send(hello({ ready: false }));
          s.send({
            type: 'capabilities',
            computer: 'vm-1',
            events: ['process.exited', 'computer.idle'],
            detail: 'this guest has no window bindings',
          });
        }),
      })
      .catch((e) => e);
    expect(String(err)).toContain('cannot emit computer.ready');
  });

  it('waits for a stream frame the advertised list has no opinion about', async () => {
    // `gap`, `closed` and `capabilities` are never in what a computer says it
    // can emit — that list is about the machine — so refusing them would refuse
    // a reasonable wait.
    const { computer: c } = await computer();
    const ev = await c.waitFor('gap', {
      timeoutMs: 2_000,
      webSocket: socketFactory((s) => {
        s.emitOpen();
        s.send(hello({ ready: false }));
        s.send({
          cursor: 'ep-1:2',
          at: '2026-08-31T12:00:00Z',
          type: 'gap',
          computer: 'vm-1',
          source: 'daemon',
          data: { detail: 'cannot replay that far' },
        });
      }),
    });
    expect(ev.type).toBe('gap');
  });

  it('times out with this SDK’s own TimeoutError', async () => {
    const { computer: c } = await computer();
    await expect(
      c.waitFor('process.exited', {
        timeoutMs: 60,
        backoffMs: 1,
        webSocket: socketFactory((s) => {
          s.emitOpen();
          s.send(hello({ ready: false }));
        }),
      }),
    ).rejects.toThrow(TimeoutError);
  });

  it('hands a caller who cancelled their own reason, not a deadline', async () => {
    const { computer: c } = await computer();
    const stop = new AbortController();
    const reason = new Error('the agent moved on');
    setTimeout(() => stop.abort(reason), 20);
    const err = await c
      .waitFor('process.exited', {
        timeoutMs: 30_000,
        signal: stop.signal,
        webSocket: socketFactory((s) => {
          s.emitOpen();
          s.send(hello({ ready: false }));
        }),
      })
      .catch((e) => e);
    expect(err).toBe(reason);
  });

  it('calls the caller’s own onConnect as well as its own', async () => {
    // `onConnect` is an option on WaitForOptions like any other, and this used
    // to overwrite it — accepted by the type, documented on the option, and
    // silently never called. `signal` IS replaced, and that is not the same
    // thing: it is composed first, so the caller's still fires.
    const { computer: c } = await computer();
    const seen: string[] = [];
    const ev = await c.waitFor('process.exited', {
      timeoutMs: 2_000,
      onConnect: (h) => seen.push(h.cursor),
      webSocket: socketFactory((s) => {
        s.emitOpen();
        s.send(hello({ ready: false }));
        s.send(event({ type: 'process.exited', data: { pid: 5, exit_code: 0 } }));
      }),
    });
    expect(ev.pid).toBe(5);
    expect(seen).toEqual(['ep-1:0']);
  });

  it('refuses file.changed on a stream that nominated nothing', async () => {
    // The advertised list gets this one wrong on its own: the computer CAN emit
    // `file.changed` and still emits none, because it is the only type that
    // never arrives unasked. From inside the loop that is indistinguishable
    // from a directory nobody has touched.
    const { computer: c } = await computer();
    const err = await c
      .waitFor('file.changed', {
        timeoutMs: 30_000,
        webSocket: socketFactory((s) => {
          s.emitOpen();
          s.send(hello({ ready: false, events: ['file.changed', 'computer.idle'] }));
        }),
      })
      .catch((e) => e);
    expect(String(err)).toContain('never arrives unasked');
    expect(String(err)).toContain('watch:');
    expect(isSettled(err)).toBe(true);
  });

  it('waits for it once a tree is nominated', async () => {
    const { computer: c } = await computer();
    const ev = await c.waitFor('file.changed', {
      timeoutMs: 2_000,
      watch: '/home/user/p',
      webSocket: socketFactory((s) => {
        s.emitOpen();
        s.send(hello({ ready: false, events: ['file.changed'], watching: [] }));
        s.send(
          event({
            type: 'file.changed',
            source: 'guest',
            data: { watch: '/home/user/p', path: '/home/user/p/a.txt', kind: 'modified' },
          }),
        );
      }),
    });
    expect(ev).toMatchObject({
      watch: '/home/user/p',
      path: '/home/user/p/a.txt',
      kind: 'modified',
    });
  });

  it('does not send a caller after a watch when the computer cannot emit it at all', async () => {
    // Two different refusals, and the advice only fits one of them. Telling a
    // caller on an image without the watcher to nominate a tree sends them
    // after a fix that changes nothing.
    const { computer: c } = await computer();
    const err = await c
      .waitFor('file.changed', {
        timeoutMs: 30_000,
        webSocket: socketFactory((s) => {
          s.emitOpen();
          s.send(hello({ ready: false, events: ['computer.idle'] }));
        }),
      })
      .catch((e) => e);
    expect(String(err)).toContain('cannot emit file.changed');
    expect(String(err)).not.toContain('never arrives unasked');
  });

  it('waits when a nominated-nothing file.changed is only half of what is wanted', async () => {
    // The rule is unchanged: a refusal only where NONE of the wanted types can
    // arrive. The half that can is still the half the caller meant.
    const { computer: c } = await computer();
    const ev = await c.waitFor(['file.changed', 'process.exited'], {
      timeoutMs: 2_000,
      webSocket: socketFactory((s) => {
        s.emitOpen();
        s.send(hello({ ready: false, events: ['file.changed', 'process.exited'] }));
        s.send(event({ type: 'process.exited', data: { pid: 5, exit_code: 0 } }));
      }),
    });
    expect(ev.pid).toBe(5);
  });

  it('refuses a wait with nothing to wait for, and a deadline that is not a number', async () => {
    const { computer: c } = await computer();
    await expect(c.waitFor([])).rejects.toThrow(ValidationError);
    await expect(c.waitFor('computer.ready', { timeoutMs: Number.NaN })).rejects.toThrow(
      ValidationError,
    );
  });

  it('says what happened when the stream ends before the event arrives', async () => {
    // Only reachable with `reconnect: false`, where the socket ending IS the
    // answer — reporting it as a timeout would name a deadline that has not
    // elapsed.
    const { computer: c } = await computer();
    const err = await c
      .waitFor('process.exited', {
        timeoutMs: 30_000,
        reconnect: false,
        webSocket: socketFactory((s) => {
          s.emitOpen();
          s.send(hello({ ready: false }));
          s.close();
        }),
      })
      .catch((e) => e);
    expect(String(err)).toContain('ended before');
    expect(err).not.toBeInstanceOf(TimeoutError);
  });
});

describe('the numbers a stream is given', () => {
  it('refuses one past the ceiling a timer silently wraps at', async () => {
    // `setTimeout` stores its delay in a 32-bit signed int, so anything past
    // MAX_TIMER_MS wraps to 1ms and fires AT ONCE — a `backoffMs` of 2e10,
    // meant as "back off for ages", is the unthrottled reconnect loop against
    // the platform that a NaN would have produced. `checkWait` and `Transport`
    // both cap here; this did not.
    const { computer: c } = await computer();
    for (const opts of [
      { backoffMs: 2 ** 31 },
      { maxBackoffMs: 2 ** 31 },
      { connectTimeoutMs: 1e12 },
    ]) {
      expect(() => c.events(opts)).toThrow(ValidationError);
      expect(() => c.events(opts)).toThrow(/wraps to 1ms/);
    }
    // The ceiling itself is allowed, as it is in `checkWait`.
    expect(() => c.events({ backoffMs: 2 ** 31 - 1 })).not.toThrow();
  });

  it('refuses one that is not finite, before a socket is opened', async () => {
    // `setTimeout(fn, NaN)` fires at once, so a non-finite backoff is an
    // unthrottled reconnect loop against the platform, and nothing says so.
    const { computer: c } = await computer();
    expect(() => c.events({ backoffMs: Number.NaN })).toThrow(ValidationError);
    expect(() => c.events({ connectTimeoutMs: 0 })).toThrow(ValidationError);
    expect(() => c.events({ maxQueued: -1 })).toThrow(ValidationError);
    expect(() => c.events({ maxRetries: -1 })).toThrow(ValidationError);
    // Zero retries is "never give up", not a refusal.
    expect(() => c.events({ maxRetries: 0 })).not.toThrow();
  });
});

/**
 * A connect surface the platform sent short a desktop credential (OPL-4215).
 *
 * The shape that actually arrives is a VIEWER's, and it is worth writing it out
 * rather than inventing a tidier one: `web/lib/vncconnect.ts` answers a viewer
 * with `view_url`, `view_token`, `embed_url` and `clipboard` and nothing else —
 * no `token`, no `url`, and no `events_url`, because the stream URL is built
 * over the controlling credential and a watch-only one is not given window
 * titles.
 *
 * `toVncConnect` requires both credentials, so that surface decoded to
 * `undefined`, and `#eventsUrl` read the absence as "the platform could not
 * reach the host holding this computer" — weather, retried forever, on a
 * computer whose host had answered. The settled sentence written for exactly
 * this case sat below it and could not be reached.
 */
describe('a watch-only connect surface', () => {
  /** A viewer's surface, field for field as the platform builds it. */
  const viewer = {
    view_url: 'wss://host/vnc?token=v',
    view_token: 'v',
    embed_url: 'https://host/embed#v',
    clipboard: false,
  };
  const withVnc =
    (vnc: unknown): Responder =>
    (call) =>
      call.path === '/computers/vm-1' ? json({ ...COMPUTER, vnc }) : anyRoute(call);

  it('still offers no vnc surface, which is the rule that was always right', async () => {
    const { computer: c } = await computer(withVnc(viewer));
    expect(c.vnc).toBeUndefined();
  });

  it('tells a viewer the stream is not theirs, rather than retrying it forever', async () => {
    // The settled sentence, reached at last. Not weather: a watch-only
    // credential will not become a controlling one by asking again.
    const { computer: c } = await computer(withVnc(viewer));
    const err = await collect(
      c.events({ reconnect: false, webSocket: socketFactory(() => {}) }),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(MandalaError);
    expect(String(err)).toContain('has no events_url');
    expect(String(err)).toContain('watch-only');
    expect(isSettled(err)).toBe(true);
  });

  it('reads an events_url that arrives without both tokens, if one ever does', async () => {
    // Not a shape the platform sends today — a surface short a token has no
    // `events_url` — which is why this pins the DECODER's rule rather than
    // claiming a payload. `events_url` is not built over the two desktop
    // credentials, so it must not be dropped with them; a coupling that is safe
    // only because a second rule elsewhere never violates it is one platform
    // change away from not being safe.
    const { computer: c } = await computer(withVnc({ ...COMPUTER.vnc, view_token: '' }));
    const urls: string[] = [];
    const got = await collect(
      c.events({
        reconnect: false,
        webSocket: socketFactory((s) => {
          urls.push(s.url);
          s.emitOpen();
          s.send(hello({ ready: false }));
          s.send(event({ cursor: 'ep-1:2' }));
          s.close();
        }),
      }),
    );
    expect(got).toHaveLength(1);
    expect(urls[0]).toContain('wss://host/events');
  });

  it('keeps calling a genuinely absent surface an unreachable host', async () => {
    const { computer: c } = await computer(withVnc(undefined));
    const err = await collect(
      c.events({ reconnect: false, webSocket: socketFactory(() => {}) }),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ConnectionError);
    expect(isSettled(err)).toBe(false);
  });
});

describe('the stream numbers a caller sets', () => {
  it('treats an empty `since` as no position rather than as one it holds', async () => {
    // `since: ''` was stored, which blocked the hello frame's cursor from being
    // adopted, and was falsy in `withCursor`, so it never reached the URL
    // either. The stream believed it held a position and rejoined at the head
    // on every reconnect, replaying events the caller had already been given.
    // `?? ''` on a caller's own option is how one arrives.
    const { computer: c } = await computer();
    const urls: string[] = [];
    const stream = c.events({
      since: '',
      maxRetries: 2,
      backoffMs: 1,
      webSocket: socketFactory((s, n) => {
        urls.push(s.url);
        s.emitOpen();
        s.send(hello({ ready: false, cursor: 'ep-1:1' }));
        if (n === 0) s.send(event({ seq: 1, cursor: 'ep-1:2' }));
        if (n === 1) s.send(event({ seq: 2, cursor: 'ep-1:3' }));
        s.close();
      }),
    });
    await collect(stream, 2);
    expect(urls[0]).not.toContain('since=');
    expect(urls[1]).toContain('since=ep-1%3A2');
  });

  it('adopts the hello cursor for an empty `since`, as it does for an omitted one', async () => {
    const { computer: c } = await computer();
    const stream = c.events({
      since: '',
      reconnect: false,
      webSocket: socketFactory((s) => {
        s.emitOpen();
        s.send(hello({ ready: false, cursor: 'ep-1:1' }));
        s.close();
      }),
    });
    await collect(stream);
    expect(stream.cursor).toBe('ep-1:1');
  });

  it('caps the backoff RESET too, on a connection that delivered before it dropped', async () => {
    // The path the first fix missed. `delivered > 0` resets the backoff, and
    // the reset took the raw option while only the initial assignment had been
    // capped — so a stream that was working and then dropped slept the full
    // uncapped wait, which is the whole bug on the connection most likely to
    // hit it.
    const { computer: c } = await computer();
    const started = Date.now();
    await collect(
      c.events({
        maxRetries: 2,
        backoffMs: 3_000,
        maxBackoffMs: 5,
        webSocket: socketFactory((s, n) => {
          s.emitOpen();
          s.send(hello({ ready: false }));
          s.send(event({ seq: n + 1, cursor: `ep-1:${n + 2}` }));
          s.close();
        }),
      }),
      2,
    );
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('caps the FIRST reconnect sleep at maxBackoffMs, not only the ones after it', async () => {
    // The doubling was clamped and the initial value was not, so a caller who
    // set both got one wait past the ceiling they had just named.
    // `checkStreamNumbers` validates each number independently and never
    // compares the two.
    const { computer: c } = await computer();
    const started = Date.now();
    await collect(
      c.events({
        maxRetries: 1,
        backoffMs: 5_000,
        maxBackoffMs: 5,
        webSocket: socketFactory((s, n) => {
          s.emitOpen();
          s.send(hello({ ready: false }));
          if (n > 0) s.send(event({ cursor: 'ep-1:9' }));
          s.close();
        }),
      }),
      1,
    );
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
