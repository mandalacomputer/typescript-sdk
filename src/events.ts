/**
 * The event stream, as an async iterator.
 *
 * `GET computers/:id/events` is a websocket that says what a computer is doing
 * without being asked, and it exists so that an agent stops paying for a
 * screenshot to learn that nothing has changed. What a caller wants out of that
 * is not a socket:
 *
 * ```ts
 * for await (const ev of computer.events()) { ... }
 * await computer.waitFor('computer.ready');
 * ```
 *
 * So this file is the part between the two — the reconnect, the cursor, the
 * opening frame's state, and the three frames that are not events.
 *
 * Everything here is written against the `events_url` entry in the platform's
 * `web/lib/apidoc.ts`, which is the reference this must not contradict.
 */

import { ConnectionError, MandalaError, ValidationError } from './errors.js';
import { type GuestWindow, toGuestWindow } from './models.js';
import { isRecord } from './paths.js';

/**
 * Who is describing this event.
 *
 * `daemon` means the platform observed it: a command exited, a machine changed
 * power state, the idle sweep came round. `guest` means the machine reported it
 * about itself — every `window.*`, `clipboard.changed`, and `computer.ready` —
 * and anyone with root inside that guest can make those say anything. They are
 * the tenant's own machine describing itself, which is exactly as much as they
 * are worth.
 *
 * Kept on the event rather than folded into the type, because the same caller
 * that trusts `process.exited` to end a wait may be putting a window title on a
 * page. Flattening the two would be this SDK deciding, on the platform's
 * behalf, that the distinction it bothered to send does not matter.
 *
 * Open, like every other string on this wire: an unrecognised word must read as
 * a word this client has not heard of rather than as `daemon`.
 */
export type EventSource = 'daemon' | 'guest' | (string & {});

/**
 * The event types this SDK knows the meaning of.
 *
 * Open on purpose. The reference says in as many words that the vocabulary
 * grows and that a client must ignore a `type` it does not recognise, so a
 * closed union here would turn a forward-compatible addition into a compile
 * error for everyone — and, worse, would tempt this file into dropping the
 * frame. Nothing is dropped: an unknown type arrives with its `data` intact and
 * none of the fields below set.
 */
export type ComputerEventType =
  | 'window.opened'
  | 'window.closed'
  | 'window.focused'
  | 'window.blurred'
  | 'clipboard.changed'
  | 'process.exited'
  | 'computer.ready'
  | 'computer.idle'
  | 'computer.started'
  | 'computer.stopped'
  | 'computer.suspended'
  | 'gap'
  | 'closed'
  | 'capabilities'
  | (string & {});

/**
 * The frames that are statements about the STREAM rather than about the
 * computer: a hole in the history, this host ending the socket on purpose, and
 * the vocabulary being revised under an open one.
 *
 * They arrive as events because a client cannot ignore what it was never
 * handed, and they are listed here because they are never in what the opening
 * frame advertises — that list is about what the machine can produce.
 */
export const STREAM_FRAME_TYPES: readonly ComputerEventType[] = ['gap', 'closed', 'capabilities'];

/** The event types the platform will only send when the GUEST can produce them. */
export const GUEST_EVENT_TYPES: readonly ComputerEventType[] = [
  'window.opened',
  'window.closed',
  'window.focused',
  'window.blurred',
  'clipboard.changed',
  'computer.ready',
];

/**
 * One frame off the stream.
 *
 * A single flat shape rather than a discriminated union, and the reason is the
 * vocabulary above: a union has to have a member for "a type this build has
 * never heard of", and in TypeScript that member's discriminant can only be
 * `string` — which puts it back inside every narrowing a caller writes, so
 * `ev.type === 'process.exited'` stops implying `ev.pid`. The union would buy
 * exactness on the eleven types named here and lose it on every type added
 * after this release, which is the wrong way round for a stream whose reference
 * promises more of them.
 *
 * So the payload is promoted onto the envelope as optional fields, each one
 * documented with the types that carry it, and {@link ComputerEvent.data} keeps
 * the object the platform actually sent for anything this SDK predates.
 */
export type ComputerEvent = {
  type: ComputerEventType;
  /** RFC 3339, UTC, as the platform wrote it. */
  at: string;
  /** The computer this is about. */
  computer: string;
  /**
   * Position in this computer's stream.
   *
   * `undefined` for the three frames that are statements ABOUT the stream
   * rather than positions in it — `gap`, `closed` and `capabilities` — and for
   * a {@link synthesized} event. A gap in particular carried `seq: 0` in an
   * early build of the platform, and a client applying the obvious rule (ignore
   * anything not newer than the last sequence I saw) discarded the one frame
   * that reports unrecoverable loss. Absent is what it means.
   */
  seq?: number;
  /**
   * Where to resume from, having consumed this event.
   *
   * Opaque, and counts events CONSUMED rather than naming the last one seen —
   * so this is the position AFTER this event, not at it. {@link ComputerEvents}
   * stores it for you and passes it as `since=` on every reconnect; it is here
   * for a caller who keeps their own place across a process restart.
   *
   * `''` on `closed` and `capabilities`, which carry no position.
   */
  cursor: string;
  source: EventSource;
  /** The payload verbatim, including fields this SDK predates. */
  data: Record<string, unknown>;

  // --- promoted payloads ----------------------------------------------
  //
  // Each is set for the types named on it and `undefined` everywhere else.

  /**
   * `window.opened` and `window.focused`: the window, in the shape
   * `GET computers/:id/windows` returns.
   *
   * Position and size are as they were AT THIS EVENT. Moving or resizing a
   * window produces no event at all, so a window's geometry right now is a
   * question for the listing rather than for the last event about it.
   */
  window?: GuestWindow;
  /**
   * `window.closed` and `window.blurred`: the window's id, and nothing else.
   *
   * There is deliberately no geometry on either — a window that is gone has no
   * position to report, and a window that lost focus is otherwise unchanged.
   * Match it against a window you were told about: `hello`'s
   * {@link ComputerEvents.windows}, or a `window.opened` or `window.focused`
   * this stream sent you.
   */
  windowId?: string;
  /** `process.exited`: the pid `execBackground` handed you. */
  pid?: number;
  /**
   * `process.exited`: what the command exited with.
   *
   * `undefined` exactly when {@link lost} is true, and the pair is the whole
   * point: `-1` is already a real exit code on this path, so it could not also
   * mean "no answer". Nothing is invented for a command whose outcome this
   * platform does not know.
   */
  exitCode?: number;
  /**
   * `process.exited`: the guest stopped knowing about this command — which is
   * what a restart of the machine underneath it looks like.
   *
   * The handle goes with it, so `execPoll(pid)` answers 404 from here on. The
   * event is sent so that a caller waiting on it stops waiting, not because
   * anything was learned about how the command ended.
   */
  lost?: boolean;
  /** `clipboard.changed`: `clipboard` or `primary`. The contents are not on this stream. */
  selection?: string;
  /** `computer.started` / `.stopped` / `.suspended`: the state it is in now. */
  status?: string;
  /**
   * `computer.started` / `.stopped` / `.suspended`: the state it was in before.
   *
   * Absent on the first transition a host reports for a computer after the
   * daemon restarts, which has no earlier status to have moved from.
   */
  previous?: string;
  /** `computer.idle`: how long nobody had touched it. */
  idleSeconds?: number;
  /**
   * `gap`: the oldest position this host can still replay from.
   *
   * Absent when it holds nothing at all. Resuming from it is legal and is not
   * what a gap is for — the events between where you were and here are gone,
   * and the listing is what reconciles that.
   */
  oldestCursor?: string;
  /**
   * `gap`, `closed` and `capabilities`: the platform's own sentence about what
   * just happened, meant to be read by a person.
   */
  detail?: string;
  /**
   * `capabilities`: the event types this computer can emit, replacing what the
   * opening frame advertised.
   *
   * It goes both ways. A guest that turns out to have no watcher — an image
   * built without the X bindings — withdraws the guest half after `hello`
   * promised it, and a computer stopped and started under an open socket can
   * ACQUIRE the channel its watcher runs over and get it back.
   */
  events?: string[];
  /**
   * True for a `computer.ready` this SDK made out of the opening frame's STATE
   * rather than one the platform sent as an event.
   *
   * `computer.ready` fires once per desktop session. Attach to a machine whose
   * desktop is already up — somebody else got there first, or this is a
   * reconnect — and the event has happened and will not happen again, so a
   * `waitFor('computer.ready')` over the raw socket waits forever on a computer
   * that has been ready for an hour. The opening frame says which it is, and
   * this is that answer arriving in the shape the caller is already reading.
   *
   * Only where the readiness could not arrive as an event: a connection that
   * resumed from a cursor either already had it or is about to be handed it
   * out of the backlog, so nothing is made up there. A gapped resume counts as
   * no continuity and does get one, because the backlog it would have been in
   * is what the gap says is gone.
   *
   * Flagged rather than passed off as the real thing because it is not one: it
   * has no {@link seq}, its {@link at} is when this client asked rather than
   * when the desktop came up, and its {@link cursor} is the opening frame's.
   * A caller counting desktop sessions wants it counted; a caller reconciling
   * against the platform's own record wants to know it was never there.
   */
  synthesized?: boolean;
};

/** The opening frame, once. */
export type Hello = {
  computer: string;
  /** Where this stream is for this client. Everything it sends comes after it. */
  cursor: string;
  /**
   * Whether the desktop has ALREADY been announced ready for the session it is
   * in. See {@link ComputerEvent.synthesized}, which is what this SDK does with
   * it.
   */
  ready: boolean;
  /**
   * What THIS computer can emit — not everything the platform knows how to.
   *
   * A guest with nowhere to run a watcher (a Windows one, or a Linux one whose
   * hardware carries no terminal channel) never produces the guest half, and
   * this list says so rather than leaving a caller waiting for something that
   * cannot arrive.
   */
  events: string[];
  /**
   * The desktop as this host last saw it, or `undefined`.
   *
   * Present — possibly as an empty array — on a connection with no continuity,
   * and ABSENT when a cursor was honoured, because a resuming client already
   * holds those windows. The two are different answers, so this is `undefined`
   * rather than `[]` for the second, and the difference is worth keeping: an
   * empty array means nothing is open.
   *
   * Last SEEN, not guaranteed live. A window whose close happened while this
   * host had lost its link to the guest is reported into a dead pipe and stays
   * in the picture. `GET computers/:id/windows` asks the machine and is the
   * authority on the present; this is what makes a later `window.closed`
   * correlatable.
   */
  windows?: GuestWindow[];
  raw: Record<string, unknown>;
};

/** A number, or `undefined` for anything that is not one. */
const int = (v: unknown): number | undefined => {
  if (typeof v !== 'number' && typeof v !== 'string') return undefined;
  if (typeof v === 'string' && v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** A string, or `undefined` for anything that is not one. Empty counts as absent. */
const text = (v: unknown): string | undefined =>
  typeof v === 'string' && v !== '' ? v : undefined;

const stringList = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((e): e is string => typeof e === 'string') : undefined;

/**
 * One text frame, as a {@link ComputerEvent}.
 *
 * `undefined` for `hello`, which is state rather than an event and is read by
 * {@link toHello}, and for anything that is not an object at all. Every other
 * frame comes through with its `type` intact, whether or not this build has
 * heard of it — the reference asks a client to ignore an unrecognised type, and
 * a client cannot ignore what it was never handed.
 */
export function toComputerEvent(frame: unknown): ComputerEvent | undefined {
  if (!isRecord(frame)) return undefined;
  const type = typeof frame.type === 'string' ? frame.type : '';
  if (!type || type === 'hello') return undefined;
  const data = isRecord(frame.data) ? frame.data : {};
  const ev: ComputerEvent = {
    type,
    at: typeof frame.at === 'string' ? frame.at : new Date().toISOString(),
    computer: typeof frame.computer === 'string' ? frame.computer : '',
    seq: int(frame.seq),
    cursor: typeof frame.cursor === 'string' ? frame.cursor : '',
    source: typeof frame.source === 'string' ? frame.source : 'daemon',
    data,
  };
  switch (type) {
    case 'window.opened':
    case 'window.focused':
      ev.window = toGuestWindow(data);
      break;
    case 'window.closed':
    case 'window.blurred':
      ev.windowId = text(data.id);
      break;
    case 'process.exited':
      ev.pid = int(data.pid);
      // `lost` and `exit_code` are exclusive on the wire and stay exclusive
      // here. A truthy `lost` beside a number would otherwise hand a caller
      // both an exit code and a statement that there is none.
      ev.lost = data.lost === true;
      ev.exitCode = ev.lost ? undefined : int(data.exit_code);
      break;
    case 'clipboard.changed':
      ev.selection = text(data.selection);
      break;
    case 'computer.started':
    case 'computer.stopped':
    case 'computer.suspended':
      ev.status = text(data.status);
      ev.previous = text(data.previous);
      break;
    case 'computer.idle':
      ev.idleSeconds = int(data.idle_seconds);
      break;
    case 'gap':
      ev.oldestCursor = text(data.oldest_cursor);
      ev.detail = text(data.detail);
      break;
    case 'closed':
      // Not an event frame: `detail` sits at the top level beside `type`, and
      // there is no cursor, sequence or source to read.
      ev.detail = text(frame.detail);
      break;
    case 'capabilities':
      ev.detail = text(frame.detail);
      ev.events = stringList(frame.events);
      break;
    default:
      break;
  }
  return ev;
}

/** The opening frame, or `undefined` for anything that is not one. */
export function toHello(frame: unknown): Hello | undefined {
  if (!isRecord(frame) || frame.type !== 'hello') return undefined;
  const windows = Array.isArray(frame.windows)
    ? frame.windows.filter(isRecord).map(toGuestWindow)
    : undefined;
  return {
    computer: typeof frame.computer === 'string' ? frame.computer : '',
    cursor: typeof frame.cursor === 'string' ? frame.cursor : '',
    // TRUE only. A readiness nobody claimed is a readiness to wait for, which
    // is the recoverable half of being wrong: waiting on a desktop that is up
    // ends at the caller's timeout, while concluding a desktop is up because a
    // field was malformed hands an agent a screen that is still booting.
    ready: frame.ready === true,
    events: stringList(frame.events) ?? [],
    windows,
    raw: { ...frame },
  };
}

// --- the socket -------------------------------------------------------------

/**
 * The part of a `WebSocket` this SDK uses.
 *
 * Structural rather than the DOM type, so that the global one Node 22 ships,
 * the `ws` package's, and a test's stand-in all satisfy it without any of them
 * being imported here. Nothing in this file sends: the stream is one-way, and
 * the reference says nothing a client writes to it means anything.
 */
export type EventSocket = {
  addEventListener(type: 'open', fn: () => void): void;
  addEventListener(type: 'message', fn: (ev: { data: unknown }) => void): void;
  addEventListener(type: 'error', fn: () => void): void;
  addEventListener(type: 'close', fn: () => void): void;
  close(): void;
};

/** How {@link ComputerEvents} opens a socket. Defaults to the global `WebSocket`. */
export type EventSocketFactory = (url: string) => EventSocket;

/**
 * The global `WebSocket`, refused by name when this Node is too old to have one.
 *
 * A dependency-free package is the whole reason this is not `ws`: a websocket
 * library would be this SDK's only runtime dependency, carried by every user of
 * it for the sake of one method. Node 22 is where the global landed, which is
 * what `engines` already says — and `mandala ssh` has required the same global
 * since it shipped.
 */
export const globalEventSocket: EventSocketFactory = (url) => {
  if (typeof WebSocket === 'undefined') {
    throw new MandalaError(
      'this Node has no global WebSocket — the event stream needs Node 22 or newer, or a ' +
        'webSocket factory passed to events()',
    );
  }
  return new WebSocket(url) as unknown as EventSocket;
};

export type EventStreamOptions = {
  /**
   * Resume from a cursor you kept, instead of joining at the head.
   *
   * What survives a process restart. Passing the cursor of the last event you
   * acted on is what makes "the command finished while we were down" arrive
   * rather than go unmentioned; if this host can no longer replay that far you
   * get a `gap` event, which is the same news said honestly.
   */
  since?: string;
  /**
   * Reopen the socket when it drops, resuming from the last event you consumed.
   * On by default, and it is most of what this class is for.
   *
   * A socket dies on every power transition, and a restart rotates the desktop
   * credential — so each reconnect re-reads the computer for a fresh
   * `events_url` rather than reusing the one that is now a 401 nobody can
   * explain.
   *
   * Turn it off and the iteration ends when the socket does, which is the right
   * shape for a caller running their own supervision.
   *
   * A `closed` frame is not treated differently from a socket that simply
   * died, and that is deliberate. The reference says the sentence in it is the
   * difference between a socket worth reopening at once and one that is not —
   * but matching on prose is a client depending on wording, and the same
   * question is answered by the reconnect itself: the fresh
   * `GET computers/:id` it makes first either hands back a URL, or fails in a
   * way that ends the stream. A computer this host no longer holds because it
   * MOVED gets the new host's URL and carries on, which no reading of the
   * sentence would have achieved; one that is gone answers 404, which ends it.
   */
  reconnect?: boolean;
  /** First backoff step, doubling up to {@link maxBackoffMs}. */
  backoffMs?: number;
  maxBackoffMs?: number;
  /**
   * Give up after this many CONSECUTIVE failures to reopen. `0` never gives up.
   *
   * Consecutive, so a stream that has been up for a week and drops twice has
   * not failed twice: one connection that reaches its opening frame resets the
   * count.
   */
  maxRetries?: number;
  /** Milliseconds to wait for the handshake and the opening frame. */
  connectTimeoutMs?: number;
  /**
   * How many frames may sit unread before this stream reopens itself.
   *
   * A websocket cannot be paused, so frames arrive whether or not the loop
   * consuming them is keeping up, and something has to bound that. Dropping
   * the oldest would be this SDK inventing the silent loss the whole stream
   * exists to prevent. What happens instead is that the SOCKET is closed the
   * moment the queue crosses this line: nothing more can arrive, everything
   * already queued is still delivered, and the reconnect that follows resumes
   * from wherever the caller had got to by then. Nothing is lost and nothing
   * is sent twice.
   *
   * The host reaches the same conclusion about a subscriber that has stopped
   * reading and puts it down with a `closed` frame saying so; this is that
   * policy on the near side of the socket, where the queue actually is. A
   * consumer that is permanently too slow will churn between the two, which is
   * a true statement about the consumer rather than something to hide.
   */
  maxQueued?: number;
  /**
   * Called with each connection's opening frame, before any of that
   * connection's events are yielded.
   *
   * What it is for is a wait that cannot end. `hello` names the event types
   * THIS computer can emit, and a caller waiting for one it does not name is
   * waiting for something the platform has already said will not arrive —
   * which is indistinguishable, from inside a `for await`, from a desktop that
   * is merely slow. This is the one place that answer is available before the
   * first event.
   *
   * Called again on every reconnect, because the answer can change: a computer
   * stopped and started under an open socket can acquire the channel its
   * watcher runs over. It runs inside the stream's own machinery, so anything
   * it throws would be caught by the reconnect logic and read as a connection
   * that failed — call {@link ComputerEvents.close} and remember the reason
   * instead.
   */
  onConnect?: (hello: Hello) => void;
  /** Swap in a websocket implementation. Defaults to {@link globalEventSocket}. */
  webSocket?: EventSocketFactory;
  /** Stops the stream. The iteration ends; it does not throw. */
  signal?: AbortSignal;
};

/** Defaults, exported so a caller can see what they are overriding. */
export const EVENT_STREAM_DEFAULTS = {
  reconnect: true,
  backoffMs: 500,
  maxBackoffMs: 15_000,
  maxRetries: 0,
  connectTimeoutMs: 15_000,
  maxQueued: 4_096,
} as const;

/**
 * How a stream gets a URL, and a fresh one on every reconnect.
 *
 * A function rather than a string, because the credential in `events_url` is
 * rotated by a restart — and a restart is one of the ordinary reasons the
 * socket dropped in the first place. Reusing the URL that was open a second ago
 * is how a reconnect turns into a 401 that looks like a bug in this file.
 */
export type EventUrlSource = (signal?: AbortSignal) => Promise<string>;

/**
 * Why the handshake failed, worked out after the fact.
 *
 * A websocket that is refused tells its client nothing. Measured on Node 22 and
 * on Node 26: a 409, a 401 and a TCP reset all arrive as an `error` event
 * carrying a `TypeError` whose message is the empty string, followed by `close`
 * with code 1006 — the status line and the body the platform wrote are not
 * exposed anywhere on the `WebSocket` API. So the two refusals the reference
 * names (`409` with `resume_required` on a suspended computer, `409` with
 * `reason: "unavailable"` on a stopped one) cannot be read off the failure.
 *
 * They can be read off the COMPUTER, which is what this does: one
 * `GET computers/:id` on the failure path, and the state it answers with is
 * what the message says. Inference, and named as such wherever it is reported —
 * but the alternative is "the connection failed" about a machine somebody
 * suspended, which is a true sentence that helps nobody.
 */
export type EventRefusal = (signal?: AbortSignal) => Promise<Error>;

type Frame =
  | { kind: 'frame'; value: unknown }
  | { kind: 'event'; value: ComputerEvent }
  | { kind: 'end' }
  | { kind: 'error'; err: Error };

/**
 * A one-writer, one-reader queue between the socket's listeners and the loop.
 *
 * The socket delivers in a listener and the caller pulls in a `for await`, and
 * those are two different clocks. Frames are never dropped here — see
 * {@link EventStreamOptions.maxQueued} for what happens when the reader cannot
 * keep up, which is a decision made in the loop rather than silently in a
 * buffer.
 */
class Frames {
  #items: Frame[] = [];
  #wake?: () => void;
  #full = false;

  /**
   * @param cap how many may sit unread before `onFull` is raised.
   * @param onFull raised ONCE, from inside the push that crossed the line —
   *   which is the only moment that can act on it. The reader is parked at a
   *   `yield` while a slow consumer thinks, so a check made when the loop next
   *   runs is a check made after the growth it was meant to bound.
   */
  constructor(
    private readonly cap: number,
    private readonly onFull: () => void,
  ) {}

  get size(): number {
    return this.#items.length;
  }

  push(f: Frame): void {
    this.#items.push(f);
    const wake = this.#wake;
    this.#wake = undefined;
    wake?.();
    if (!this.#full && this.#items.length > this.cap) {
      this.#full = true;
      this.onFull();
    }
  }

  /** Wake a waiting reader without queueing anything — how a stop is noticed. */
  interrupt(): void {
    const wake = this.#wake;
    this.#wake = undefined;
    wake?.();
  }

  /** The next frame, or `undefined` when `stopped()` becomes true first. */
  async take(stopped: () => boolean): Promise<Frame | undefined> {
    for (;;) {
      const next = this.#items.shift();
      if (next) return next;
      if (stopped()) return undefined;
      await new Promise<void>((resolve) => {
        // Re-checked inside, because both conditions can become true between
        // the check above and this line — and a reader parked on a wake that
        // has already happened never returns.
        if (this.#items.length > 0 || stopped()) return resolve();
        this.#wake = resolve;
      });
    }
  }
}

/**
 * A computer's event stream: an async iterable that reconnects, keeps the
 * cursor, and answers what the opening frame said.
 *
 * Single-consumer. One socket, one queue, one position — a second `for await`
 * over the same object would split the events between the two loops rather than
 * give each of them all, which is not what anybody writing the second loop
 * means, so it is refused instead.
 *
 * ```ts
 * for await (const ev of computer.events()) {
 *   if (ev.type === 'process.exited' && ev.pid === job.pid) break;
 * }
 * ```
 *
 * Breaking out closes the socket: the loop calls `return()` on the generator
 * and the `finally` there releases it. So does {@link close}, for a caller who
 * is not in a loop.
 */
export class ComputerEvents implements AsyncIterable<ComputerEvent> {
  readonly #url: EventUrlSource;
  readonly #refusal: EventRefusal;
  readonly #reconnect: boolean;
  readonly #backoffMs: number;
  readonly #maxBackoffMs: number;
  readonly #maxRetries: number;
  readonly #connectTimeoutMs: number;
  readonly #maxQueued: number;
  readonly #webSocket: EventSocketFactory;
  readonly #onConnect?: (hello: Hello) => void;
  readonly #signal?: AbortSignal;

  #iterated = false;
  #closed = false;
  #socket?: EventSocket;
  #frames?: Frames;
  /** The position to resume from: after the last event YIELDED, never received. */
  #cursor?: string;
  #hello?: Hello;
  #types?: string[];
  /** Whether a `computer.ready` has reached the caller on this stream, in any shape. */
  #sawReady = false;

  /** @internal — obtain one from `Computer.events()`. */
  constructor(url: EventUrlSource, refusal: EventRefusal, opts: EventStreamOptions = {}) {
    this.#url = url;
    this.#refusal = refusal;
    this.#reconnect = opts.reconnect ?? EVENT_STREAM_DEFAULTS.reconnect;
    this.#backoffMs = opts.backoffMs ?? EVENT_STREAM_DEFAULTS.backoffMs;
    this.#maxBackoffMs = opts.maxBackoffMs ?? EVENT_STREAM_DEFAULTS.maxBackoffMs;
    this.#maxRetries = opts.maxRetries ?? EVENT_STREAM_DEFAULTS.maxRetries;
    this.#connectTimeoutMs = opts.connectTimeoutMs ?? EVENT_STREAM_DEFAULTS.connectTimeoutMs;
    this.#maxQueued = opts.maxQueued ?? EVENT_STREAM_DEFAULTS.maxQueued;
    this.#webSocket = opts.webSocket ?? globalEventSocket;
    this.#onConnect = opts.onConnect;
    this.#signal = opts.signal;
    // Refused before a socket is opened, for the reason `checkWait` refuses its
    // own numbers there: `setTimeout(fn, NaN)` fires at once, so a non-finite
    // backoff is an unthrottled reconnect loop against the platform, and a
    // non-finite connect timeout is a handshake nobody ever gives up on.
    checkStreamNumbers({
      backoffMs: this.#backoffMs,
      maxBackoffMs: this.#maxBackoffMs,
      maxRetries: this.#maxRetries,
      connectTimeoutMs: this.#connectTimeoutMs,
      maxQueued: this.#maxQueued,
    });
    this.#cursor = opts.since;
  }

  /**
   * The opening frame of the connection currently open, or `undefined` before
   * the first one lands.
   *
   * Replaced on every reconnect, so {@link windows} is the desktop as of the
   * newest connection — and `undefined` there when that connection resumed from
   * a cursor, which is the platform saying "you already hold this picture"
   * rather than "nothing is open".
   */
  get hello(): Hello | undefined {
    return this.#hello;
  }

  /**
   * What this computer can emit, as last stated: the opening frame's list,
   * replaced by any `capabilities` frame since.
   *
   * The one thing worth checking it for is a wait that cannot end. An image
   * built without the X bindings the watcher needs emits no `window.*` and no
   * `computer.ready`, and a caller waiting on one of those is waiting for
   * something the platform has already said will not arrive.
   */
  get eventTypes(): string[] | undefined {
    return this.#types;
  }

  /** The desktop the newest connection joined, when it was sent one. */
  get windows(): GuestWindow[] | undefined {
    return this.#hello?.windows;
  }

  /**
   * The position after the last event this stream YIELDED — what a reconnect
   * resumes from, and what to store if you keep your own place.
   *
   * Advanced at the yield rather than on arrival, which is the whole of why a
   * reconnect does not lose the frames that were sitting unread in the queue:
   * they were never consumed, so the position never moved past them.
   */
  get cursor(): string | undefined {
    return this.#cursor;
  }

  /** Stop the stream and release the socket. Safe to call more than once. */
  close(): void {
    this.#closed = true;
    this.#shutSocket();
    this.#frames?.interrupt();
  }

  #stopped(): boolean {
    return this.#closed || this.#signal?.aborted === true;
  }

  #shutSocket(): void {
    const sock = this.#socket;
    this.#socket = undefined;
    if (!sock) return;
    try {
      sock.close();
    } catch {
      // A socket that is already gone is the state this is trying to reach.
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<ComputerEvent> {
    if (this.#iterated) {
      throw new MandalaError(
        'this event stream is already being consumed — open a second one with events() ' +
          'rather than iterating this one twice',
      );
    }
    this.#iterated = true;
    // A reader parked on the queue is woken by a frame arriving and by nothing
    // else, so an abort has to reach it deliberately. Without this a stream
    // whose caller gave up — every `waitFor` that times out, among others —
    // sits in `Frames.take` forever on a socket that is perfectly healthy and
    // simply has nothing to say.
    const onAbort = () => this.close();
    this.#signal?.addEventListener('abort', onAbort, { once: true });
    try {
      yield* this.#run();
    } finally {
      this.#signal?.removeEventListener('abort', onAbort);
      this.close();
    }
  }

  async *#run(): AsyncGenerator<ComputerEvent> {
    let failures = 0;
    let backoff = this.#backoffMs;
    for (;;) {
      if (this.#stopped()) return;
      // Closing the socket is the whole response to a queue that is filling:
      // it stops more arriving without discarding what has, and the `end` the
      // close produces sits behind the backlog rather than in front of it.
      const frames = new Frames(this.#maxQueued, () => this.#shutSocket());
      this.#frames = frames;
      // Events this connection actually handed to the caller. What resets the
      // failure count, and it is deliberately not "the handshake succeeded": a
      // host that accepts a socket and drops it a millisecond later succeeds at
      // every handshake, so a reset there is a reconnect loop that can never
      // reach `maxRetries` and never backs off. A connection that delivered
      // something was a working connection; one that did not is an attempt.
      let delivered = 0;
      try {
        await this.#connect(frames);
      } catch (err) {
        this.#shutSocket();
        if (this.#stopped()) return;
        // A refusal about the computer's STATE — suspended, stopped, gone — is
        // a decision rather than weather, and does not clear by being asked
        // again. Thrown whether or not reconnect is on, because the
        // alternative is this loop knocking on a machine that is off every
        // fifteen seconds for as long as the process lives.
        if (!this.#reconnect || isSettled(err)) throw err;
        failures += 1;
        if (this.#maxRetries > 0 && failures > this.#maxRetries) throw err;
        await delay(backoff, this.#signal);
        backoff = Math.min(backoff * 2, this.#maxBackoffMs);
        continue;
      }

      let fatal: Error | undefined;
      for (;;) {
        const item = await frames.take(() => this.#stopped());
        if (item === undefined) return;
        if (item.kind === 'end') break;
        if (item.kind === 'error') {
          fatal = item.err;
          break;
        }
        const ev = item.kind === 'event' ? item.value : this.#interpret(item.value);
        if (ev) {
          // BEFORE the yield, because the yield is the handover: a consumer
          // that takes this event and breaks out of its loop never resumes
          // this generator, so a line after the yield does not run for the one
          // event most likely to be the last. Left there, `cursor` was stale by
          // exactly one on every early exit and a caller storing it was handed
          // that event a second time on resume.
          //
          // What this must not do is move for an event nobody has been given,
          // and it does not: everything still in the queue when a socket dies
          // was never yielded, so the position never reached it and the
          // reconnect asks for it again.
          if (ev.cursor) this.#cursor = ev.cursor;
          delivered += 1;
          yield ev;
          if (this.#stopped()) return;
        }
      }

      this.#shutSocket();
      if (this.#stopped()) return;
      if (!this.#reconnect) {
        if (fatal) throw fatal;
        return;
      }
      if (delivered > 0) {
        failures = 0;
        backoff = this.#backoffMs;
      }
      failures += 1;
      if (this.#maxRetries > 0 && failures > this.#maxRetries) {
        throw fatal ?? new ConnectionError('the event stream closed and could not be reopened');
      }
      await delay(backoff, this.#signal);
      backoff = Math.min(backoff * 2, this.#maxBackoffMs);
    }
  }

  /**
   * Open one socket and read its opening frame.
   *
   * Returns only once `hello` has landed, so that everything this object can be
   * asked — the vocabulary, the desktop, whether the machine is already ready —
   * is true before the first event is yielded off the new connection.
   */
  async #connect(frames: Frames): Promise<void> {
    const signal = this.#signal;
    const url = withCursor(await this.#url(signal), this.#cursor);
    const sock = this.#webSocket(url);
    this.#socket = sock;

    let settleHello: ((h: Hello | undefined) => void) | undefined;
    const helloFrame = new Promise<Hello | undefined>((resolve) => {
      settleHello = resolve;
    });
    // Registered before anything is awaited. The opening frame is written the
    // moment the platform has upgraded, so it can arrive in the same turn as
    // `open` — a listener attached after the handshake resolves would miss it,
    // and this method would then wait out its whole connect timeout on a
    // perfectly healthy socket.
    sock.addEventListener('message', (ev) => {
      const frame = decode(ev.data);
      if (frame === undefined) return;
      if (settleHello) {
        const hello = toHello(frame);
        if (hello) {
          const settle = settleHello;
          settleHello = undefined;
          // Taken HERE rather than after the awaits below, so that anything
          // this connection sends next is queued behind it. A socket that says
          // hello and closes in the same turn — which is what a host putting a
          // subscriber down looks like — otherwise put its `end` in the queue
          // ahead of the readiness this frame implies, and the loop broke on
          // the end without ever yielding it.
          this.#acceptHello(hello, frames);
          settle(hello);
          return;
        }
      }
      frames.push({ kind: 'frame', value: frame });
    });

    let handshake: 'pending' | 'open' | 'failed' = 'pending';
    const opened = new Promise<void>((resolve, reject) => {
      const done = (fn: () => void) => {
        if (handshake !== 'pending') return;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(
        () =>
          done(() => {
            handshake = 'failed';
            reject(
              new ConnectionError(
                `the event stream did not open within ${this.#connectTimeoutMs}ms`,
              ),
            );
          }),
        this.#connectTimeoutMs,
      );
      sock.addEventListener('open', () =>
        done(() => {
          handshake = 'open';
          resolve();
        }),
      );
      // A close before open is a failed handshake, and so is an error: a
      // refused upgrade produces both and neither carries the status. See
      // EventRefusal, which is what turns that silence into a sentence.
      const refused = () =>
        done(() => {
          handshake = 'failed';
          reject(HANDSHAKE_REFUSED);
        });
      sock.addEventListener('error', refused);
      sock.addEventListener('close', refused);
    });

    sock.addEventListener('close', () => {
      // Only ever after a handshake that succeeded. Before that this is the
      // refusal above, and pushing an `end` for it would have the loop treat a
      // rejected connection as a connection that ended.
      settleHello?.(undefined);
      settleHello = undefined;
      if (handshake === 'open') frames.push({ kind: 'end' });
    });

    try {
      await opened;
    } catch (err) {
      if (err === HANDSHAKE_REFUSED) throw await this.#refusal(signal);
      throw err;
    }

    const hello = await withTimeout(
      helloFrame,
      this.#connectTimeoutMs,
      () => new ConnectionError(`the event stream said nothing within ${this.#connectTimeoutMs}ms`),
    );
    if (!hello) {
      throw new ConnectionError('the event stream closed before it said what it was');
    }
  }

  /** What the opening frame settles, in the order it has to settle it. */
  #acceptHello(hello: Hello, frames: Frames): void {
    this.#hello = hello;
    this.#types = hello.events;
    // The cursor a client stores when it disconnects before seeing an event.
    // Adopted only when nothing has been consumed, because it names a position
    // BEFORE the backlog this connection is about to deliver: taken while
    // events were queued it would resume in front of frames the caller has
    // already been given, and they would arrive twice.
    if (this.#cursor === undefined) this.#cursor = hello.cursor;
    // The readiness a subscriber would otherwise never hear about, and ONLY
    // where it could not arrive as an event.
    //
    // `windows` is present exactly when this connection has no continuity — no
    // cursor, or one that gapped — which is the platform's own test and the
    // reason it is read here rather than `since` being remembered. With
    // continuity there is nothing to make up: either this client was already
    // sent the readiness on an earlier connection, or the event that set the
    // latch is sitting in the backlog about to arrive. Manufacturing one there
    // puts a second `computer.ready` in front of the real one, and the
    // reference tells a client to read that as a desktop it has not seen —
    // so the invention would be a session replacement that never happened.
    //
    // Once per stream, not once per connection: `#sawReady` survives the
    // reconnects, for the same reason.
    if (hello.ready && hello.windows !== undefined && !this.#sawReady) {
      this.#sawReady = true;
      frames.push({ kind: 'event', value: readyFromHello(hello) });
    }
    // Last, so that everything a hook can read off this object — the
    // vocabulary, the desktop, the cursor — is already true, and so that a
    // hook which closes the stream closes one whose state it was allowed to
    // judge.
    this.#onConnect?.(hello);
  }

  /** One frame, as an event, with the bookkeeping that happens as it goes past. */
  #interpret(frame: unknown): ComputerEvent | undefined {
    const ev = toComputerEvent(frame);
    if (!ev) return undefined;
    if (ev.type === 'capabilities' && ev.events) this.#types = ev.events;
    if (ev.type === 'computer.ready') this.#sawReady = true;
    return ev;
  }
}

/** The rejection that means "the upgrade was refused and said nothing about why". */
const HANDSHAKE_REFUSED = Symbol('mandala.handshakeRefused');

/**
 * A `computer.ready` built out of the opening frame's `ready`.
 *
 * Not a replay of the event, and marked so. It carries hello's own cursor —
 * which is where this client IS, so storing it and reconnecting asks for what
 * comes next rather than for a position in the past — and no sequence, because
 * it never had one.
 */
function readyFromHello(hello: Hello): ComputerEvent {
  return {
    type: 'computer.ready',
    at: new Date().toISOString(),
    computer: hello.computer,
    cursor: hello.cursor,
    source: 'guest',
    data: {},
    synthesized: true,
  };
}

/**
 * A frame's JSON, or `undefined` for anything that is not a text frame of it.
 *
 * Binary frames are dropped rather than decoded: nothing on this stream sends
 * one, and a client that guessed at its meaning would be inventing a shape. So
 * is a text frame that is not JSON — a proxy's error page reaching a websocket
 * is not an event, and a parse failure is not worth ending a stream over.
 */
function decode(data: unknown): unknown {
  if (typeof data !== 'string') return undefined;
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}

/** `events_url` with a resume position on it, keeping the credential it carries. */
export function withCursor(url: string, cursor?: string): string {
  if (!cursor) return url;
  // Appended rather than assembled through `URL`, which normalises the path and
  // re-encodes the query it parsed. The token in this URL was percent-encoded
  // by the platform, and a round trip through a parser is a chance to change
  // one byte of a credential.
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}since=${encodeURIComponent(cursor)}`;
}

/**
 * Mark a refusal that will not clear by being tried again.
 *
 * The three the reference names — a suspended computer, a stopped one, and a
 * computer this platform no longer holds — are decisions rather than weather. A
 * reconnect loop over one is a client asking the same question every fifteen
 * seconds forever, and never saying the answer out loud.
 *
 * A symbol on the error rather than a class, because the error itself is
 * whatever the follow-up read produced — a `NotFoundError` for a computer that
 * is gone, this SDK's own sentence for one that is suspended — and wrapping
 * those in a new class would hide the type a caller already knows how to catch.
 */
const SETTLED = Symbol('mandala.settled');

export function settled<E extends Error>(err: E): E {
  (err as unknown as Record<symbol, boolean>)[SETTLED] = true;
  return err;
}

/** Whether {@link settled} marked this. */
export function isSettled(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as Record<symbol, unknown>)[SETTLED] === true;
}

function checkStreamNumbers(o: {
  backoffMs: number;
  maxBackoffMs: number;
  maxRetries: number;
  connectTimeoutMs: number;
  maxQueued: number;
}): void {
  const positive = (name: string, v: number) => {
    if (!Number.isFinite(v) || v <= 0) {
      throw new ValidationError(`${name} must be a positive finite number (got ${v})`);
    }
  };
  positive('backoffMs', o.backoffMs);
  positive('maxBackoffMs', o.maxBackoffMs);
  positive('connectTimeoutMs', o.connectTimeoutMs);
  positive('maxQueued', o.maxQueued);
  if (!Number.isFinite(o.maxRetries) || o.maxRetries < 0) {
    throw new ValidationError(
      `maxRetries must be a non-negative finite number (got ${o.maxRetries})`,
    );
  }
}

/** A promise with a deadline on it, for a socket that opened and then said nothing. */
async function withTimeout<T>(p: Promise<T>, ms: number, err: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(err()), ms);
      }),
    ]);
  } finally {
    // Cleared on both paths. Left running, a 15-second timer holds the process
    // open past the end of a stream that finished in a millisecond.
    if (timer) clearTimeout(timer);
  }
}

/** A sleep that ends early when the caller gives up, and does NOT throw for it. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    // The listener comes off on the ordinary path too. Left in place, a stream
    // that reconnects for a week adds one listener per attempt to the caller's
    // single signal — the leak `sleep` in wait.ts was fixed for.
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
