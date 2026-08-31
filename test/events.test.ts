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
import { toComputerEvent, toHello, withCursor } from '../src/events.js';
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

  it('is not an event for hello, or for anything that is not a frame', () => {
    expect(toComputerEvent(hello())).toBeUndefined();
    expect(toComputerEvent(null)).toBeUndefined();
    expect(toComputerEvent('hello')).toBeUndefined();
    expect(toComputerEvent({ computer: 'vm-1' })).toBeUndefined();
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

  it('does not synthesize a second ready on a reconnect', async () => {
    // A second `computer.ready` means a desktop you have not seen before. One
    // manufactured on every reconnect would report a desktop replacement that
    // never happened, and the reference tells a client to act on that.
    const { computer: c } = await computer();
    const got = await collect(
      c.events({
        maxRetries: 1,
        backoffMs: 1,
        webSocket: socketFactory((s, n) => {
          s.emitOpen();
          s.send(hello({ ready: true }));
          if (n === 0) s.close();
          else {
            s.send(event({ type: 'computer.idle' }));
            s.close();
          }
        }),
      }),
      3,
    ).catch((err) => err);
    const types = Array.isArray(got) ? got.map((e: ComputerEvent) => e.type) : [];
    expect(types.filter((t) => t === 'computer.ready')).toHaveLength(1);
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
