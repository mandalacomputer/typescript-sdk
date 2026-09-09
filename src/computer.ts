/** The Computer handle — a cloud desktop and everything you can do to it. */

import {
  type AgentArgs,
  type AgentEvent,
  type AgentResult,
  toAgentEvent,
  toAgentResult,
} from './agent.js';
import {
  // TYPE-ONLY, both of them, and kept rather than dropped. Every reference to
  // either in this file is a `{@link}` in a doc comment — `APIError.reason` on
  // the two clipboard methods, `isTransient` on the retry advice beside them —
  // so as values they are dead, and `verbatimModuleSyntax` was emitting a
  // runtime import for two bindings nothing calls. Deleting them instead would
  // cost the links: `{@link}` resolves through a type import and not through
  // nothing, and the alternative is qualifying every target by module path.
  // The inline modifier rather than a second import statement, matching the
  // `./agent.js` line above.
  type APIError,
  ConnectionError,
  errorForEventStatus,
  type isTransient,
  MandalaError,
  NotFoundError,
  RangeNotSatisfiableError,
  TimeoutError,
  TooLargeError,
  ValidationError,
} from './errors.js';
import {
  answersWait,
  type ComputerEvent,
  ComputerEvents,
  type EventStreamOptions,
  STREAM_FRAME_TYPES,
  settled,
  unarmedTrees,
  watchList,
} from './events.js';
import type {
  BackgroundExec,
  ExecResult,
  GuestWindow,
  Holdings,
  Move,
  Point,
  Schedule,
  Snapshot,
  VncConnect,
  WindowResult,
} from './models.js';
import {
  acceptedCapture,
  belongsToComputer,
  count,
  isWindowResult,
  moveAnchor,
  moveRows,
  num,
  said,
  str,
  toBackgroundExec,
  toExecResult,
  toHoldings,
  toMove,
  toSchedule,
  toSnapshot,
  toVncConnect,
  toWindowListing,
  toWindowResult,
  unmatchableRows,
  vncEventsUrl,
  WIRE,
  windowContradiction,
  wire,
} from './models.js';
import * as P from './paths.js';
import type { CallOptions } from './resources.js';
import {
  type Bytes,
  bodyByteLength,
  MODEL_KEY_HEADER,
  type Query,
  type Transport,
} from './transport.js';

import {
  checkWait,
  deadlineSignal,
  isDeadlineAbort,
  isTransientForPoll,
  retryDelay,
  sleepUntilNextPoll,
  type WaitOptions,
} from './wait.js';

/**
 * What a computer renders at when its create did not ask for anything else.
 *
 * These were the guest's screen, full stop, until resolution became a
 * create-time choice. They are the default now — still what every existing
 * computer is, and still the right thing to assume about a platform too old to
 * report one. For a computer in hand read {@link Computer.screen} instead; it is
 * what coordinates are in.
 */
export const SCREEN_WIDTH = 1280;
export const SCREEN_HEIGHT = 800;
export const DEFAULT_RESOLUTION = `${SCREEN_WIDTH}x${SCREEN_HEIGHT}x24`;

/**
 * What {@link Computer.waitForGuest} runs to decide the guest is answering.
 *
 * A builtin of both bash and cmd.exe, so it works on either OS without asking
 * which one this is — and keeps working on an image with nothing installed.
 * `true` used to be the probe and silently made the wait Linux-only: cmd.exe
 * has no such command, so on Windows it could only spin until it timed out.
 */
export const GUEST_PROBE = 'exit 0';

/**
 * Trim and refuse a missing Anthropic key before it becomes an empty header.
 *
 * A {@link ValidationError} rather than a bare {@link MandalaError}: nothing has
 * been sent, and this is the caller's argument being wrong — the same class
 * every other local refusal in this SDK throws, so `catch (e) { if (e instanceof
 * ValidationError) }` catches this one too.
 */
const requireModelKey = (key: string | undefined, what: string): string => {
  const trimmed = key?.trim() ?? '';
  if (!trimmed) {
    throw new ValidationError(
      `${what} needs your own Anthropic API key as modelKey — the platform does not store one.`,
    );
  }
  return trimmed;
};

export type { WaitOptions } from './wait.js';

/** What {@link Computer.waitFor} accepts: a stream's options, plus a deadline. */
export type WaitForOptions = EventStreamOptions & {
  /** Milliseconds before giving up. Defaults to three minutes. */
  timeoutMs?: number;
};

/** Named once: the reachability rule below reads it three times. */
const FILE_CHANGED = 'file.changed';

/**
 * The refusal for a wait whose event cannot arrive, or `undefined`.
 *
 * Only when NONE of the wanted types is possible. A caller waiting for
 * `process.exited` or `computer.ready` on a guest with no watcher is still
 * waiting for something reachable, and refusing that would be this SDK
 * deciding the half it can have is not the half it meant.
 *
 * The three stream-control frames are always reachable and are never in the
 * advertised list, which is about the COMPUTER. Counting them as impossible
 * would refuse `waitFor('gap')` — a reasonable thing to wait for, and the one
 * this list has no opinion about.
 *
 * `file.changed` is the one type the advertised list gets wrong on its own. A
 * computer that CAN emit it says so, and still emits none unless this stream
 * nominated a tree — it is the only type that never arrives unasked. So a
 * `waitFor('file.changed')` with no `watch` is a wait for something the
 * platform has already been told not to send, and reads from inside a
 * `for await` exactly like a directory nobody has touched.
 */
function unreachableTypes(
  id: string,
  wanted: Set<string>,
  advertised: string[],
  nominated: number,
): Error | undefined {
  const reachable = new Set([...advertised, ...STREAM_FRAME_TYPES]);
  // Advertised but not asked for. Kept as its own answer so the sentence below
  // can be the true one: a computer that never advertised `file.changed` also
  // cannot emit it, and telling that caller to nominate a tree would send them
  // after a fix that changes nothing.
  const unasked = nominated === 0 && reachable.has(FILE_CHANGED) && wanted.has(FILE_CHANGED);
  if (nominated === 0) reachable.delete(FILE_CHANGED);
  const impossible = [...wanted].filter((t) => !reachable.has(t));
  if (impossible.length < wanted.size) return undefined;
  return settled(
    new MandalaError(
      `${id} cannot emit ${impossible.join(' or ')} on this stream, so waiting for it would ` +
        `never end. It advertises: ${advertised.join(', ') || 'nothing'}.` +
        (unasked
          ? ` ${FILE_CHANGED} is the one type that never arrives unasked — nominate a tree ` +
            `with watch: '/absolute/path' and it can.`
          : ''),
    ),
  );
}

export type ScrollOptions = CallOptions & {
  direction?: P.ScrollDirection;
  amount?: number;
  modifiers?: readonly string[];
};

export type DeleteOptions = {
  /**
   * Also destroy every snapshot of this computer. Requires `expect`.
   *
   * Opt-in because the wrong answer is unrecoverable: a snapshot kept by
   * mistake costs storage, one destroyed by mistake costs the disk it was the
   * last copy of.
   */
  deleteSnapshots?: boolean;
  /** The fingerprint from {@link Computer.holdings}. */
  expect?: string;
} & CallOptions;

/**
 * A window of a guest file, and where it sits in the whole one.
 *
 * The metadata is half the point of asking for a window: a request can come
 * back with fewer bytes than it asked for — a window past what one request
 * moves is trimmed rather than refused — so `offset` and `total` are the only
 * authority on where the answer starts and how much is left. Without them a
 * `Range` would be write-only.
 */
export type FileChunk = {
  bytes: Uint8Array;
  /** Where in the file these bytes start. */
  offset: number;
  /**
   * The file's whole length.
   *
   * `undefined` only for a file the guest cannot measure — see `seekable` —
   * where there is no total to promise rather than a total of zero.
   */
  total?: number;
  /**
   * Whether this is the window that was asked for rather than the whole file.
   *
   * `false` means the range was ignored and everything came, which is the
   * answer for a file no range can be served out of. The status is how a caller
   * tells; the byte count is not, since a window can legitimately be the whole
   * file.
   */
  partial: boolean;
  /**
   * Whether this file can be windowed at all.
   *
   * `false` for a file whose length the guest could not report — a `/proc`
   * entry, say. Those have no byte positions to name, so a range against one is
   * ignored and there is no total to page towards.
   */
  seekable: boolean;
};

/** What a caller is told about a 206 that cannot be placed in its file. */
const unplaceable = (path: string, why: string): MandalaError =>
  new MandalaError(
    `the platform answered 206 for ${path} ${why}, so where these bytes belong in the ` +
      'file is unknown',
  );

/**
 * A 206 that named no length to page towards.
 *
 * Its own sentence because both ends of a paged read can meet it, and both have
 * the same two bad answers available: stop, and hand back a truncated file
 * saying nothing, or ask on, and walk off the end into a 416.
 */
const noTotal = (path: string): MandalaError =>
  new MandalaError(
    `the platform answered 206 for ${path} without a total, so there is no length to page ` +
      'towards and no way to tell a short answer from the end of the file',
  );

/** {@link Bytes} off the files route, read as a window of a file. */
function toFileChunk(res: Bytes, path: string): FileChunk {
  const partial = res.status === 206;
  const seekable = res.acceptRanges !== 'none';
  if (!partial) {
    // No range was honoured, so the whole file arrived. Where there is a length
    // to state, that is it — a caller deciding whether to page has the answer
    // already and it is not a guess.
    //
    // A file the guest could not measure has no such number. The platform
    // declines to promise one precisely because the next read of a /proc entry
    // is a different length, and manufacturing one here out of the bytes that
    // happened to arrive would be this SDK asserting what the platform refused
    // to. `seekable` is the signal there, as the type says.
    return {
      bytes: res.bytes,
      offset: 0,
      total: seekable ? res.bytes.length : undefined,
      partial,
      seekable,
    };
  }
  if (!res.contentRange) {
    // A 206 whose Content-Range did not survive the trip — stripped by a proxy,
    // or unreadable. Refused rather than assumed to start at zero: these bytes
    // are somewhere in the file and nothing left says where, and a caller
    // writing them at a guessed offset corrupts the copy silently. This is the
    // one failure the status was added to prevent, so it is not papered over.
    throw unplaceable(path, 'without a readable Content-Range');
  }
  // The header and the body have to agree about how many bytes this is. They
  // are two statements of one fact and only the header is checked anywhere
  // else, so a disagreement leaves the same question open as a missing header:
  // an empty body reads to the paging loop as the end of the file — `scp` then
  // reports 0 bytes and exits 0 — and a body longer than its window carries the
  // offset past the total, which ends the loop as a complete file with extra
  // bytes in it. Both are silent, and both are answered here.
  const window = res.contentRange.end - res.contentRange.start + 1;
  if (res.bytes.length !== window) {
    throw unplaceable(path, `with ${res.bytes.length} bytes for a Content-Range naming ${window}`);
  }
  return {
    bytes: res.bytes,
    offset: res.contentRange.start,
    total: res.contentRange.total,
    partial,
    seekable,
  };
}

/**
 * A refusal for size, told what to do about it in this SDK's own words.
 *
 * The platform's message names the `Range` header, which is the right sentence
 * for the curl in its docs and the wrong one here — a caller of this SDK never
 * writes that header and has no way to guess which method does. Appended rather
 * than substituted: the platform's half carries the file's actual size and the
 * ceiling it met, and neither is knowable from this side.
 */
function pointPastTheCeiling(err: unknown): unknown {
  if (!(err instanceof TooLargeError)) return err;
  return new TooLargeError(
    `${err.message} — from this SDK that is readFileChunks(path), which pages a file of any ` +
      'size, or readFilePart(path, { offset, length }) for one window of it',
    err.status,
    err.body,
  );
}

/**
 * What a poll of `GET /moves` could not make out, where there was anything.
 *
 * A row that is not a JSON object cannot be attributed to any computer, so it
 * might have been this one's move — and a drop nobody counts is a listing
 * reported as complete when it was not. Empty string where there were none, so
 * a caller can test it.
 *
 * "THE LAST LISTING READ", said in the sentence rather than left to be assumed.
 * The count is the most recent successful poll's, and the wait clears it on any
 * later poll that read no listing — one that failed and one its own deadline cut
 * short — so the span it describes is never longer than one listing and the
 * reader is told which one.
 */
const blindness = (w: { unreadable: number; unmatchable: number }): string => {
  // TWO KINDS OF SHORT, said apart because they are not the same fact about the
  // answer and a caller chasing one would look in the wrong place for the other.
  // A row that is not a JSON object could not be read at all; a row that is one
  // and carries no string `computer_id` was read perfectly well and cannot be
  // attributed to any computer, this one included (OPL-4587). Both mean the same
  // thing for the verdict — the row might have been this move — and neither may
  // borrow the other's wording.
  const parts: string[] = [];
  if (w.unreadable > 0) {
    parts.push(`${w.unreadable} row(s) of the last listing read could not be read at all`);
  }
  if (w.unmatchable > 0) {
    parts.push(`${w.unmatchable} row(s) of it named no computer this client could match on`);
  }
  return parts.join(', and ');
};

/**
 * What a move wait ran out of time doing, in the sentence that is true of it.
 *
 * Seven different silences, and the wrong one sends somebody to the wrong
 * place: a copy still running is not a platform that stopped answering, that is
 * not a listing which answered every time and never carried this move, none of
 * them is a wait whose every poll was cut short by its own clock, and a wait
 * that did some of each may claim neither whole.
 *
 * WHICH VALUES SPEAK FOR WHICH SPAN. `reads`, `failures` and `aborts` are
 * cumulative and answer "was anything ever there to see", which is a question
 * about the whole wait. Everything else — `last`, `observed`, `absent`,
 * `unreadable` — is the MOST RECENT poll's and no earlier one's, for the reason
 * `observed` exists: those describe a listing in the present tense, and a wait
 * whose later polls all failed must not quote its first one to do it. Which is
 * why the loop clears the blindness count on EVERY poll that read no listing —
 * one that failed and one its own deadline cut short alike, since what makes
 * that count stale is having read nothing since, and neither of the two read
 * anything.
 */
const moveTimeoutText = (w: {
  id: string;
  timeoutMs: number;
  anchor: string;
  last: Move | undefined;
  observed: boolean;
  absent: boolean;
  unreadable: number;
  unmatchable: number;
  reads: number;
  failures: number;
  aborts: number;
}): string => {
  if (w.last && w.observed) {
    return (
      `${w.id} was still moving after ${w.timeoutMs}ms (state ${w.last.state}; ` +
      `the move has not stopped, only this wait has)`
    );
  }
  // Its row was there and then was not, without that ever adding up to the
  // refusal in the loop — which has exactly one way of happening, since a whole
  // listing missing this row ends the wait at once: rows this client could not
  // place were on it too, so any one of THOSE might be it. `absent` is only ever
  // set on such a poll, which is why the blindness is stated and not tested for.
  if (w.last && w.absent) {
    return (
      `${w.id}'s move stopped being listed by GET ${P.MOVES} within ${w.timeoutMs}ms, and ` +
      `${blindness(w)} — so whether it is gone cannot be told from that listing. When it last ` +
      `answered it was in state ${w.last.state}.`
    );
  }
  if (w.last) {
    return (
      `${w.id}'s move could not be reached for the last part of ${w.timeoutMs}ms; when it ` +
      `last answered it was in state ${w.last.state}. The move has not stopped, only this wait ` +
      `has — read moves.list for where it got to.`
    );
  }
  // Never seen at all, on listings that were READ — which, since a listing read
  // whole and missing this row ends the wait at once, means every one of those
  // reads was partial. Rows this client could not decode were on them, any of
  // which might have been this very move, and a poll that can only say "nobody
  // could tell" is evidence neither way. So nothing is asserted about where the
  // move got to; what is said is that no poll ever put the question.
  //
  // Two spans in one sentence, and they are marked as such. Whether anything was
  // EVER seen is the cumulative part — `reads`, `failures`, `aborts`, counted
  // over the whole wait. What could not be made out is the last poll's alone and
  // is worded "of the last listing read", because a poll that read two
  // undecodable rows and was then followed by a quarter-hour of failures says
  // nothing about the listing as it stands now.
  if (w.reads > 0) {
    const blind = blindness(w);
    return (
      `no move for ${w.id} that started at ${w.anchor} appeared on GET ${P.MOVES} within ` +
      `${w.timeoutMs}ms` +
      (blind ? `, and ${blind}` : '') +
      (w.failures > 0 ? `, and ${w.failures} poll(s) failed outright` : '') +
      `. No poll of it both accounted for every row and was missing this move, which is what it ` +
      `takes to call the row gone, so what became of the move is not something this wait read.`
    );
  }
  // No poll ever finished, and the THREE ways that happens are not one
  // sentence. Every attempt failing is the platform or the network; every
  // attempt being cut short by this wait's own deadline blames neither; and a
  // wait that did some of each blames only what it counted. "Every poll failed"
  // over a wait with one 503 and three deadline aborts is a bill sent to the
  // platform for three silences that were this deadline's own, so it is said
  // only where `aborts` is zero and every attempt really is accounted for by
  // `failures`.
  const gaveUp = `${w.id}'s move could not be observed within ${w.timeoutMs}ms: `;
  if (w.failures > 0 && w.aborts > 0) {
    return (
      `${gaveUp}no poll finished — ${w.failures} failed outright and ${w.aborts} were cut short ` +
      `by this wait's own deadline`
    );
  }
  return w.failures > 0
    ? `${gaveUp}every poll failed`
    : `${gaveUp}no poll finished before the deadline did, so nothing about the move was ever read`;
};

/**
 * What a capture's row disappearing means, which is the only thing it can mean.
 *
 * A failure after the 202 has no response left to fail in: the platform logs it
 * on the host, drops the `capturing` row and puts nothing in its place, and that
 * absence is the whole signal (platform OPL-4562). Said as a capture that FAILED
 * rather than as a snapshot that is missing, because a caller who reads the
 * latter goes looking for a row that was never stored.
 *
 * Only ever said of a listing this client read WHOLE — see
 * {@link Computer.snapshot}'s wait, which asks without `allow_partial` so that a
 * host which did not answer is a 503 the loop rides out rather than a short
 * listing read as a capture that died.
 */
const captureFailed = (computerId: string, snapshotId: string): string =>
  `the capture of ${computerId} failed: ${snapshotId} stopped being listed by GET ${P.SNAPSHOTS} ` +
  `before it landed, and a capture that fails leaves no snapshot and no row`;

/**
 * What a capture wait ran out of time doing, in the sentence that is true of it.
 *
 * {@link moveTimeoutText}'s shape and its reasons, over the silences this wait
 * has: a copy still running is not a platform that stopped answering, and
 * neither of those is a listing that could not be read as a whole one — where
 * the row being absent says nothing at all, since the rows this client never
 * saw, or saw under an id it could not match, might have held it.
 *
 * "COULD NOT BE READ AS A WHOLE ONE" rather than "was short", and "accounted for
 * every row" rather than "readable in full", because `shortLast` covers two
 * things now (OPL-4587). One is a listing that dropped rows. The other is a
 * listing that carried every one of them and held a row this client could not
 * match on, which is not short at all — and telling a caller rows went missing
 * sends them after a transport fault that did not happen (/code-review).
 *
 * `stillCapturing` and `shortLast` are the LAST poll's; `everSeen`, `reads`,
 * `failures` and `aborts` are the whole wait's. Kept apart for the reason the
 * move wait keeps them apart: the present tense belongs only to what the last
 * poll actually read, and everything else has to be said in the past.
 *
 * The id is in every one of them, because it is what a caller picks the wait
 * back up with — the id the 202 handed over, and the id the snapshot keeps.
 */
const captureTimeoutText = (w: {
  id: string;
  snapshotId: string;
  timeoutMs: number;
  stillCapturing: boolean;
  shortLast: boolean;
  everSeen: boolean;
  reads: number;
  failures: number;
  aborts: number;
}): string => {
  if (w.stillCapturing) {
    return (
      `${w.snapshotId} was still capturing after ${w.timeoutMs}ms (the capture of ${w.id} has ` +
      `not stopped, only this wait has; it is on snapshots.list() under that id)`
    );
  }
  if (w.shortLast) {
    return (
      `${w.snapshotId} was not on the last listing GET ${P.SNAPSHOTS} answered within ` +
      `${w.timeoutMs}ms, and that listing could not be read as a whole one — so whether the ` +
      `capture failed cannot be told from it, since the rows it did not carry, or carried under ` +
      `an id this client could not match, might have held this one`
    );
  }
  // Seen capturing, and then not reachable — which is a statement about the
  // polls rather than about the capture, and is worded as one. The row was
  // there, so "it stopped being listed" is exactly what this wait may not say.
  if (w.everSeen) {
    return (
      `the capture ${w.snapshotId} of ${w.id} could not be reached for the last part of ` +
      `${w.timeoutMs}ms; when the listing last carried it, it was still capturing. The capture ` +
      `has not stopped, only this wait has — read snapshots.list() for where it got to.`
    );
  }
  if (w.reads > 0) {
    return (
      `${w.snapshotId} never appeared on GET ${P.SNAPSHOTS} within ${w.timeoutMs}ms, on ` +
      `${w.reads} listing(s) that were read` +
      (w.failures > 0 ? ` and ${w.failures} poll(s) that failed outright` : '') +
      `. None of those listings both accounted for every row and was missing this one, which is ` +
      `what it takes to call the capture failed, so what became of it is not something this wait ` +
      `read.`
    );
  }
  // No poll ever finished, and the three ways that happens are three sentences
  // — Builds.wait's, for its reason: charging the platform for silences this
  // wait's own deadline caused is a bill sent to the wrong place.
  const gaveUp = `the capture ${w.snapshotId} of ${w.id} could not be observed within ${w.timeoutMs}ms: `;
  if (w.failures > 0 && w.aborts > 0) {
    return (
      `${gaveUp}no poll finished — ${w.failures} failed outright and ${w.aborts} were cut short ` +
      `by this wait's own deadline`
    );
  }
  return w.failures > 0
    ? `${gaveUp}every poll failed`
    : `${gaveUp}no poll finished before the deadline did, so nothing about the capture was ever read`;
};

/**
 * How long {@link Computer.snapshot} waits for a capture to land, and how often
 * it asks.
 *
 * A POLL DEADLINE, not a request budget, and it was the second of those in the
 * Python SDK until OPL-4568. `POST computers/:id/snapshots` no longer holds the
 * request open for the `qemu-img convert`: it settles every refusal, registers
 * the capture and answers 202 with a placeholder row (platform OPL-4562), so
 * the copying happens after the request and the number belongs on the loop that
 * watches it.
 *
 * 1800000 because that is what the PLATFORM allows a capture — it works to a
 * 30-minute budget, so this is that number rather than an estimate of it —
 * and because it is already {@link Builds.wait}'s default, this SDK's existing
 * figure for how long a platform-side image operation takes. The full half hour
 * is reachable now on every deployment, which it was not as a request budget: a
 * proxy that abandons one long request at about two minutes has nothing to
 * abandon in a wait made of many short listings (OPL-4563).
 *
 * Five seconds between polls is {@link Builds.wait}'s interval too, for its
 * reason: a capture is minutes, so this is a poll every few percent of the wait,
 * and the answer is a listing the dashboard reads on a timer anyway.
 */
const SNAPSHOT_WAIT_MS = 1_800_000;
const SNAPSHOT_POLL_MS = 5_000;

export class Computer {
  #t: Transport;
  #data: Record<string, unknown>;

  /**
   * Obtain one from a {@link Client} — `client.computers.create()`, `.get()`, or
   * `.list()` — rather than constructing it directly.
   *
   * @internal
   */
  constructor(transport: Transport, data: Record<string, unknown>) {
    this.#t = transport;
    this.#data = { ...data };
  }

  // --- fields ---------------------------------------------------------
  //
  // Every string here is read through `str()` rather than `String()`, which is
  // OPL-3850's fix applied to the whole set. `String()` THROWS rather than
  // coercing on a value with no primitive conversion — an object off the wire
  // whose `toString` is not callable, or one made with `Object.create(null)` —
  // and `computerRecord` requires only a truthy `id`, so such a record survives
  // construction and takes down the listing it was read from at the first
  // getter access. The fix reached `status` and stopped; `raw` still carries
  // whatever could not be read (OPL-4215).

  get id(): string {
    return str(this.#data.id);
  }

  get name(): string {
    return str(this.#data.name);
  }

  /**
   * State as of the last refresh.
   *
   * `"running"` or `"stopped"` for an ordinary computer, and `"suspended"` for
   * one whose session has been written to disk — see {@link isSuspended}. A
   * computer made by cloning starts as `"building"` while its disk is copied,
   * and becomes `"build-failed"` if that copy never finished.
   */
  get status(): string {
    return str(this.#data.status);
  }

  /**
   * Whether the platform SAID this computer is in the state named.
   *
   * Every decision below reads this rather than {@link status}, which is
   * coerced and therefore cannot classify: `String(['running'])` is `'running'`,
   * because an array of one joins to its element, so a malformed payload ended
   * `waitUntilRunning` on a machine nobody said was up. The same distinction
   * `terminalStatus` draws for a build and `liveMove` for a move — the coerced
   * value is what gets reported, not what gets decided on (OPL-3850, found
   * while fixing the same shape on a snapshot's `durable`).
   */
  #statusIs(name: string): boolean {
    return this.#data.status === name;
  }

  /**
   * Whether the platform sent a status this handle can classify at all.
   *
   * The other half of {@link #statusIs}, and it exists because a strict
   * comparison answers `false` for two different reasons: the status is some
   * other state, or there is no status here to compare. Every wait that acts on
   * the NEGATION of a state needs to tell those apart — `!isBuilding` is true
   * for a computer that has finished copying and equally true for a payload
   * that carried no status at all.
   */
  #statusKnown(): boolean {
    return typeof this.#data.status === 'string' && this.#data.status !== '';
  }

  /**
   * True while this computer's RAM is on disk rather than in the host.
   *
   * A suspend is a pause, not a stop: the session is written down, the host
   * gets its memory back, and the next {@link start} resumes the same processes
   * and the same open windows in about a second rather than booting.
   *
   * A computer can arrive here without anyone asking. Its host suspends anything
   * nobody has used for the host's idle window — 30 minutes by default — and
   * input, exec and file transfers resume it automatically. **Screenshots
   * deliberately do not count as use and do not resume it**, so a loop that only
   * polls the screen can be suspended out from under itself.
   */
  get isSuspended(): boolean {
    return this.#statusIs('suspended');
  }

  /** When this computer's session was saved, or `''` if it is not saved. */
  get suspendedAt(): string {
    const s = this.#data.suspended;
    return P.isRecord(s) ? str(s.at) : '';
  }

  /**
   * Why this computer was made but would not boot, or `''`.
   *
   * Only ever set on the response to a create that asked for a running machine
   * and got as far as building one. The computer exists and is billable, which
   * is why the platform answers with it rather than with an error alone; it is
   * simply stopped, and {@link start} may well work on a second attempt.
   *
   * Cleared by {@link refresh}, because it describes one start attempt rather
   * than the machine.
   */
  get startError(): string {
    return str(this.#data.start_error);
  }

  /**
   * True while this computer's disk is still being copied.
   *
   * A clone returns before its disk exists, because copying one can run for
   * minutes. Until it lands there is nothing to boot, and starting, stopping,
   * snapshotting or cloning it raises `ConflictError`. Wait with
   * {@link waitUntilBuilt}.
   */
  get isBuilding(): boolean {
    return this.#statusIs('building');
  }

  /**
   * True if this computer's disk copy never finished.
   *
   * It exists, is listed, holds whatever the copy got through, and has no usable
   * disk. Nothing will fix it on its own: delete it and clone again.
   */
  get buildFailed(): boolean {
    return this.#statusIs('build-failed');
  }

  /**
   * Why the disk copy failed, or `''` if it did not.
   *
   * `build.failed` and nothing else. The sibling `build.source` names what the
   * disk is being copied *from* and is present throughout a perfectly healthy
   * build, so reading it as a fallback reason answers "why did this fail" with
   * a snapshot id — `vm-1 could not be built: snap-42`, about a computer that
   * may still be building.
   */
  get buildError(): string {
    const b = this.#data.build;
    return P.isRecord(b) ? str(b.failed) : '';
  }

  get os(): string {
    return str(this.#data.os);
  }

  /**
   * The display protocol this computer's desktop speaks: `'wayland'`, `'x11'`,
   * or `undefined` where the platform did not say.
   *
   * THREE READINGS AND NOT TWO. `if (c.desktop)` is the wrong test — an
   * explicit `'x11'` passes it — and so is treating the absence as X11. Branch
   * on `=== 'wayland'`.
   *
   * READ IT BEFORE DRIVING A WINDOW. {@link os} is `linux` for a Wayland guest
   * and an X11 one alike, so this is the only field that separates them, and
   * two things a caller acts on change with it:
   *
   * - a {@link GuestWindow.id} is a Hyprland client address rather than an X
   *   window id. Same `0x`-and-hex shape, so nothing this API takes changes —
   *   but the id means nothing to `xdotool` or `xprop`, so anything that leaves
   *   here for X tooling through {@link exec} stops finding windows;
   * - a move or a resize of a TILED window is REFUSED rather than quietly
   *   applied to nothing. See {@link windowAction}, which is where the refusal
   *   arrives and where the way past it is written down.
   *
   * On the COMPUTER rather than only on {@link Template.desktop}, and the
   * platform publishes it in both places for the reason it gives at
   * `publicComputer`: a computer keeps the image it was cut from while a
   * template's version can advance, so the template answers a question about
   * the CATALOGUE and this one answers a question about the MACHINE.
   *
   * WHY THE ABSENCE IS NOT `'x11'` — the one place this getter parts company
   * with every other on this handle. A host deployed before OPL-4223 does not
   * send the field, and the platform passes that silence through rather than
   * naming a value, because naming one would assert a property of an image
   * nobody claimed. `str()`'s own fallback would answer `''`, a display
   * protocol no host speaks, and a fallback of `'x11'` would put the platform's
   * refused assertion back on this side of the wire. Code that reads the
   * absence as X11 is right today and wrong the first time a host is rolled
   * back.
   */
  get desktop(): string | undefined {
    const d = this.#data.desktop;
    return d == null ? undefined : str(d);
  }

  get template(): string {
    return str(this.#data.template);
  }

  // num() and not Number(), on all three: a field that is not a number at all
  // becomes NaN through Number(), and NaN CPUs fail every comparison a caller
  // writes — including the `>= 2` that was meant to be false. models.ts decodes
  // the same platform fields the same way; two rules for one payload is worse
  // than either.
  get cpu(): number {
    return num(this.#data.cpu);
  }

  get ramMb(): number {
    return num(this.#data.ram_mb);
  }

  /**
   * Guest RAM the platform LAST REPORTED it was holding for this computer, or
   * `undefined` where the payload this handle holds does not say.
   *
   * `ramMb` is what this computer is configured with; this is what it was
   * costing the account's running pool as of the last read — `ramMb` whenever a
   * process is live OR a start has been admitted for it, and 0 otherwise. The
   * two waits read it to tell a machine on its way up from one nobody is
   * starting, because `status` cannot: it is read from the guest process, and
   * an admitted start holds its memory before that process exists. So
   * `status === 'stopped'` with a non-zero value here is a boot in progress,
   * and `'suspended'` with one is a resume.
   *
   * A SNAPSHOT, not a live reading, and the distinction is the caller's to
   * keep: this is whatever the last successful read put on the handle, and a
   * refresh that failed leaves the previous value in place rather than turning
   * it into `undefined`. {@link refresh} is what makes it current.
   *
   * `number | undefined` rather than `num()`'s zero, which is the whole point:
   * a host too old to report it, one that could not be reached, or a response
   * the platform wrote before reading the computer back has said NOTHING, and
   * that is not the same as saying zero.
   */
  get runningRamMb(): number | undefined {
    const held = this.#data.running_ram_mb;
    return typeof held === 'number' && Number.isFinite(held) ? held : undefined;
  }

  get diskGb(): number {
    return num(this.#data.disk_gb);
  }

  /**
   * The screen this computer renders at, as `"WIDTHxHEIGHTxDEPTH"`.
   *
   * This is the coordinate space every pointer method and every screenshot is
   * in. Read it rather than assuming 1280x800: since resolution became a
   * create-time choice, assuming makes every click land proportionally short on
   * any computer that asked for something else. A control-plane row with no
   * host status or reported geometry returns `''`; only legacy host responses
   * fall back to the default.
   */
  get resolution(): string {
    return str(this.#data.resolution) || ('status' in this.#data ? DEFAULT_RESOLUTION : '');
  }

  /**
   * {@link resolution} as `{ width, height }`, for arithmetic.
   *
   * What the computer-use tool definition wants — `display_width_px` and
   * `display_height_px` have to equal what screenshots actually are, or the
   * model's coordinates are wrong. Unreachable, deleted and lost control-plane
   * records can report no geometry. Guard with `if (c.resolution)` before
   * reading `c.screen`; an empty resolution throws {@link ValidationError}.
   */
  get screen(): { width: number; height: number } {
    const resolution = this.resolution;
    if (!resolution) {
      throw new ValidationError(
        `${this.id} reports no resolution: check unreachable/state before reading its screen`,
      );
    }
    const [w, h] = resolution.split('x').map(Number);
    // `> 0` rather than truthiness: `!(-100)` is false, so a resolution of
    // `-100x-100` walked past a guard whose whole job is to hand back something
    // a screenshot could actually be. These two numbers become
    // `display_width_px` and `display_height_px` in a tool definition, and a
    // negative there is a model computing coordinates against a screen that
    // cannot exist.
    // Integrality subsumes the finiteness tests that used to stand here, and
    // closes the case they were extended for once rather than again: a pixel
    // count is a whole number, and `"1280.5x800.2"` otherwise came back as a
    // display_width_px of 1280.5, which is a screen no screenshot can be.
    // The platform will not send one — parseDisplay refuses anything Atoi
    // rejects, and refuses odd numbers on top of that — so this is the guard
    // holding the line the API already holds, not a live hazard.
    if (
      w === undefined ||
      h === undefined ||
      !(w > 0) ||
      !(h > 0) ||
      !Number.isInteger(w) ||
      !Number.isInteger(h)
    ) {
      return { width: SCREEN_WIDTH, height: SCREEN_HEIGHT };
    }
    return { width: w, height: h };
  }

  /** Minutes untouched before the host suspends it, or `undefined` for the host default. */
  get idleSuspendMin(): number | undefined {
    // A value that is not a number is the host's own window as far as this can
    // honestly say. Number() would answer NaN, which is a minute count that
    // silently fails every comparison rather than an absence a caller can see.
    return count(this.#data.idle_suspend_min);
  }

  /** The workspace containing this computer, or `''` when none was reported. */
  get workspaceId(): string {
    return str(this.#data.workspace_id);
  }

  /** A deep copy of the reported snapshot schedule, or `undefined` when absent or empty. */
  get snapshotSchedule(): Record<string, unknown> | undefined {
    const schedule = this.#data.snapshot_schedule;
    return P.isRecord(schedule) && Object.keys(schedule).length > 0
      ? structuredClone(schedule)
      : undefined;
  }

  /** Whether this request missed the host's answer; not a claim about the machine's health. */
  get unreachable(): boolean {
    const flag = wire(this.#data.unreachable);
    if (flag === WIRE.TRUE || flag === WIRE.FALSE) return flag === WIRE.TRUE;
    // Terminal control-plane rows also lack status, but their host is no longer
    // expected to answer. Only older responses need the status-presence fallback.
    if (this.state) return this.state === 'unreachable';
    return !('status' in this.#data);
  }

  get createdAt(): string {
    return str(this.#data.created_at);
  }

  /**
   * Where the control plane's own record says this computer has got to.
   *
   * `"live"`, `"unreachable"`, `"deleting"`, `"deleted"` or `"lost"` — see
   * {@link P.ComputerState} for what each one means. NOT the same question as
   * {@link status}: that is what the host says the machine is doing, this is
   * whether it exists at all, and the two are answered by different tiers. A
   * computer can be `"live"` and `"stopped"` at once.
   *
   * `''` on a computer that came from a route serving ONE of them, and that is
   * the platform's answer rather than an omission: such a response is served by
   * the host, so a computer that answered it is live by construction. The
   * listing is where this is carried.
   *
   * Read like {@link status} is read — coerced, and open to a word this SDK
   * predates. {@link P.ComputerState} is closed because it is only ever sent.
   */
  get state(): string {
    return str(this.#data.state);
  }

  /** When the delete was answered, RFC 3339, or `''` on a computer still there. */
  get deletedAt(): string {
    return str(this.#data.deleted_at);
  }

  /** When an operator wrote off this computer's host, RFC 3339, or `''`. */
  get lostAt(): string {
    return str(this.#data.lost_at);
  }

  /**
   * Credentials and URLs for this computer's live desktop, or `undefined`.
   *
   * What makes it possible to show somebody their own screen — in your page, not
   * the platform's dashboard — without a second call. See {@link VncConnect} for
   * why there are two credentials.
   *
   * `undefined` on a computer that came from `computers.list()`, and that is the
   * platform's decision rather than an omission: a desktop credential in every
   * list response is a credential in every log line that ever captured one,
   * whereas a caller holding a single machine is the caller about to connect to
   * it. Every response that *is* one computer carries it, so `(await
   * c.refresh()).vnc` is how a listed computer gets one.
   *
   * Also `undefined` when the platform could not reach the host holding this
   * computer, since a URL built over a missing credential answers 401 forever
   * rather than failing where it was built.
   */
  get vnc(): VncConnect | undefined {
    return toVncConnect(this.#data.vnc);
  }

  /** The API response verbatim, including any fields this SDK predates. */
  get raw(): Record<string, unknown> {
    // A deep copy. A shallow one shares every nested object, and
    // `raw.vnc.token = ...` silently rewriting this handle's own state is not
    // a copy of anything.
    return structuredClone(this.#data);
  }

  /**
   * {@link raw}, minus the desktop credentials.
   *
   * `JSON.stringify(computer)` is what a casual log line does, and a
   * credential in a log line is exactly what the platform strips them from
   * listings to prevent — see {@link vnc}. Read them deliberately, off
   * {@link vnc} or {@link raw}, not as a side effect of serializing.
   */
  toJSON(): Record<string, unknown> {
    const { vnc: _vnc, ...rest } = this.raw;
    return rest;
  }

  // --- lifecycle ------------------------------------------------------

  /**
   * Re-read this computer's state from the API.
   *
   * Also how a computer from `computers.list()` acquires a {@link vnc} connect
   * surface, which the list deliberately omits.
   */
  async refresh(opts: CallOptions = {}): Promise<this> {
    const data = P.computerPayload(
      await this.#t.json('GET', P.computer(this.id), { signal: opts.signal }),
    );
    // Guarded for the reason #power is guarded, on the route that has less
    // excuse: assigned unguarded, a 204 or an empty body flattens to `{}` and
    // this handle loses its id along with everything else — every field then
    // reads as absent, and the next call is aimed at `computers/`. #power can
    // fall back to a refresh; a refresh has nowhere to fall back to, so the
    // answer that was not a computer is named as such.
    if (!data.id) {
      throw new MandalaError(`expected a computer from GET ${P.computer(this.id)}`);
    }
    this.#data = data;
    return this;
  }

  /**
   * Start this computer, or resume it if its session was suspended.
   *
   * A suspended computer does not boot: its saved RAM is read back and the same
   * processes and windows come up roughly a second later.
   *
   * `resumeOnly` resumes only if a saved session still exists. Without one, the
   * request succeeds without booting the stopped computer. Success does not
   * guarantee it is running; this handle reflects the state returned by the
   * API, refreshed when the action returns only an acknowledgement.
   */
  async start(opts: { resumeOnly?: boolean } & CallOptions = {}): Promise<this> {
    return this.#power('start', opts, P.startQuery(opts.resumeOnly));
  }

  /**
   * Stop this computer, discarding a suspended session if it has one.
   *
   * Use {@link suspend} to keep it.
   *
   * The guest is asked to shut down and given time to do it. `force` skips the
   * asking and pulls the power — the equivalent of holding the button in. It is
   * what to reach for when a guest will not come down on its own, and it can
   * lose whatever had not been written to disk, so it is not the default and
   * should not be the first attempt.
   */
  async stop(opts: { force?: boolean } & CallOptions = {}): Promise<this> {
    return this.#power('stop', opts, P.stopQuery(opts.force));
  }

  /**
   * Write this computer's RAM to disk and give the host its memory back.
   *
   * A pause rather than a stop: {@link start} afterwards resumes the same
   * session — same processes, same open windows — in about a second instead of
   * booting. {@link stop} discards it and leaves an ordinary stopped computer.
   *
   * The computer must be running. Raises `ConflictError` for the states that
   * clear on their own — a capture or a clone reading the disk, a migration in
   * flight, or somebody driving the guest at that moment.
   */
  async suspend(opts: CallOptions = {}): Promise<this> {
    return this.#power('suspend', opts);
  }

  /**
   * Reset this computer.
   *
   * Raises `ConflictError` while a suspended session is saved, since a restart
   * would have to guess whether you meant to resume that session or throw it
   * away. Start it or stop it first.
   *
   * Desktop credentials do not survive this — see {@link vnc}.
   */
  async restart(opts: CallOptions = {}): Promise<this> {
    return this.#power('restart', opts);
  }

  async #refreshAfterMutation(mutation: string, opts: CallOptions): Promise<this> {
    try {
      return await this.refresh(opts);
    } catch (cause) {
      // The mutating request has already answered successfully. Keep that fact
      // out of the transient error taxonomy: retrying a start, stop, restart or
      // update because only this GET failed can repeat work that was applied.
      throw new MandalaError(
        `${mutation} succeeded, but refreshing ${this.id} failed; this handle still has its ` +
          'previous state. Do not retry the mutation solely because of this refresh failure.',
        { cause },
      );
    }
  }

  // The one action helper in this class whose argument is a variable rather
  // than a literal written at the call site, so it is the one place the route
  // builder's union has to be restated. Four values, all four of them power.
  async #power(
    action: 'start' | 'stop' | 'suspend' | 'restart',
    opts: CallOptions = {},
    query?: Query,
  ): Promise<this> {
    // Use a computer response directly, and refresh after an acknowledgement
    // or 204. In particular, a resume-only start can acknowledge success while
    // leaving the computer stopped; only the returned state tells us otherwise.
    const data = P.computerPayload(
      await this.#t.json('POST', P.computerAction(this.id, action), {
        query,
        signal: opts.signal,
      }),
    );
    if (data.id) {
      this.#data = data;
      return this;
    }
    return this.#refreshAfterMutation(`POST ${P.computerAction(this.id, action)}`, opts);
  }

  /**
   * Copy this computer into a new one. The source must be stopped.
   *
   * Returns as soon as the new computer exists, which is before its disk does:
   * copying a disk runs for minutes, so the clone comes back `"building"` and
   * fills in behind you. Follow with {@link waitUntilBuilt} before starting it.
   */
  async clone(name?: string, opts: CallOptions = {}): Promise<Computer> {
    const path = P.computerAction(this.id, 'clone');
    const data = P.computerPayload(
      await this.#t.json('POST', path, {
        body: P.nameBody(name),
        signal: opts.signal,
      }),
    );
    if (!data.id) throw new MandalaError(`expected a computer from POST ${path}`);
    return new Computer(this.#t, data);
  }

  /**
   * Change this computer's name, size, or idle window, and return it changed.
   *
   * A name is a label — nothing is derived from it, so a rename moves no bytes
   * and breaks no reference. The platform trims whitespace and control
   * characters and caps the result at 64 characters, so {@link name} afterwards
   * may not be exactly what was passed in.
   *
   * A resize needs the computer stopped, and disks grow only. The platform
   * refuses a rename combined with a resize, because one request cannot honour
   * both without applying half of it.
   *
   * Snapshots already taken keep the name they were captured under.
   */
  async update(args: P.UpdateArgs, opts: CallOptions = {}): Promise<this> {
    const data = P.computerPayload(
      await this.#t.json('PATCH', P.computer(this.id), {
        body: P.updateBody(args),
        signal: opts.signal,
      }),
    );
    // #power's guard, for #power's reason: a platform that answered 204 would
    // otherwise leave this handle holding `{}` — no id, no name, no status —
    // and reporting the update as applied.
    if (data.id) {
      this.#data = data;
      return this;
    }
    return this.#refreshAfterMutation(`PATCH ${P.computer(this.id)}`, opts);
  }

  /**
   * Move this computer to another host in its region, so a resize that its
   * current host cannot run becomes possible.
   *
   * THE SECOND HALF OF A REFUSED RESIZE, and only ever that. {@link update}
   * throws {@link MoveRequiredError} when the size asked for is more RAM than
   * the host this computer is on can run; `movePossible` on that error says
   * whether anywhere in the region can run it, and this is how a caller agrees
   * to go there. Calling it without having been refused first is an operation
   * nobody needed: a size that fits where the computer already is is answered
   * with a 409 rather than a pointless multi-gigabyte copy.
   *
   * A separate call rather than an option on {@link update}, deliberately, and
   * the platform draws the same line: this copies the computer's disk to
   * different hardware, and a resize that relocated a machine without being
   * asked is exactly what neither side will do.
   *
   * THE COMPUTER MUST BE STOPPED. Suspended is not stopped here, unlike a
   * resize — a saved desktop only loads on the host that wrote it, so it cannot
   * travel. Resume and stop it, or discard the session, first.
   *
   * ANSWERS BEFORE IT FINISHES. The returned {@link Move} is the operation as it
   * stood the moment it was accepted, with `live` true and the disk copy running
   * behind it; {@link waitForMove} is the other half, and it takes this value —
   * a `Move` carries no id, so the record returned here is what ties a wait to
   * this move rather than to one that finished earlier today. One move runs per
   * account at a time.
   *
   * Everything is decided again at the moment this runs — the plan, the state of
   * the computer, and which host it goes to — so it can still refuse even though
   * the resize offered it.
   *
   * NOT `move`, which on this class is the mouse pointer and has been since
   * before there was anything else to move. The platform calls the operation a
   * move and the record it returns is a {@link Move}; the verb here is
   * `relocate` because a `move(x, y)` that sometimes migrated a virtual machine
   * between hosts would be the worst overload in this file.
   */
  async relocate(args: P.MoveArgs, opts: CallOptions = {}): Promise<Move> {
    const data = await this.#t.json('POST', P.computerAction(this.id, 'move'), {
      body: P.moveBody(args),
      signal: opts.signal,
    });
    if (!P.isRecord(data)) {
      throw new MandalaError(`expected a move from POST ${P.computerAction(this.id, 'move')}`);
    }
    const move = toMove(data);
    // Refused here rather than left to the wait, the way `snapshotId` refuses a
    // row that names no snapshot. `toMove` coerces an absent `started_at` to
    // `''`, so a 202 that omitted or renamed it would return from here looking
    // perfectly well-formed and then make the very next documented line —
    // `waitForMove(move)` — throw a ValidationError blaming the CALLER for a
    // value this method handed them. A move with no start is also a move
    // nothing can be anchored to, which is the whole of what a wait does.
    if (Number.isNaN(Date.parse(move.startedAt))) {
      throw new MandalaError(
        `expected the move from POST ${P.computerAction(this.id, 'move')} to carry a readable ` +
          `started_at, which is what waitForMove anchors to; got: ` +
          `${`${JSON.stringify(data)}`.slice(0, 200)}`,
      );
    }
    return move;
  }

  /**
   * Wait for the move {@link relocate} accepted to stop running, and answer
   * what happened.
   *
   * ```ts
   * const move = await c.relocate({ ramMb: 32768 });
   * const outcome = await c.waitForMove(move);
   * ```
   *
   * THE MOVE IS REQUIRED, and it is the argument this method is about. A
   * {@link Move} carries no id, so the move's own `startedAt` is what says which
   * operation this wait is watching: a row of this computer's is this move iff
   * its `startedAt` EQUALS that string. See {@link moveAnchor} for why equality
   * is exact and safe — one row per computer, one stored string, one clock.
   *
   * `GET /moves` keeps a day of finished moves beside the ones running now, but
   * that is true ACROSS THE ACCOUNT and not for one computer: the platform keys
   * that table by computer id and writes a move with `INSERT OR REPLACE`, so at
   * most one row of it is ever this computer's. The anchor is not there to pick
   * between rows, then. It is there because `INSERT OR REPLACE` also means a
   * SECOND relocate on this same computer overwrites this move's row mid-wait,
   * and without an anchor the wait would report the new move's outcome as this
   * one's.
   *
   * An RFC3339 timestamp with a zone is accepted in its place, so a process that
   * restarted can still wait on a `startedAt` it persisted — but it must be the
   * value the platform stored, VERBATIM, since the match is string equality and
   * a re-formatted instant is a different string. Anything else — a stamp with
   * no zone, a `Move` with no readable start — is a {@link ValidationError}
   * before any request is made.
   *
   * Polls the account's moves and picks out this computer's. It does NOT throw
   * for a move that ended badly, and that is the decision worth knowing: the
   * three failures are three different situations with three different remedies
   * — see {@link Move.state} — and collapsing them into one thrown error is
   * exactly how `moved`, where the computer HAS changed hardware, gets read as
   * "nothing happened". Read `state`.
   *
   * A LISTING WITH NO ROW FOR THIS COMPUTER IS AN OUTCOME, and on the first
   * poll. The platform writes the row with `INSERT OR REPLACE` inside the
   * transaction that precedes the 202 and answers with a read-back of that row,
   * out of one database with no replica behind it — so by the time a caller
   * holds a move to wait on, the row exists. There is no "not visible yet" to
   * wait out, and absence on a listing this client read whole is a row that has
   * LEFT.
   *
   * Throws {@link MandalaError} at once if this computer's row carries a
   * DIFFERENT `startedAt`: on this platform that is another relocate having
   * taken the computer over and replaced the row, and the outcome of this move
   * is no longer recorded anywhere. Fast rather than polled, because that does
   * not un-happen.
   *
   * Throws {@link TimeoutError} if the move is still going, or still not
   * listed, when the timeout runs out. The move is not stopped by that; only
   * the waiting is, and there is no cancelling a disk crossing between two hosts
   * in any case.
   *
   * Throws {@link MandalaError} on the first poll of a listing this client could
   * read WHOLE that carries no row for this computer — the computer was deleted
   * and its move's row went with it, or a finished move was dismissed. Waiting
   * longer cannot bring back a row that has left, so spending the rest of the
   * deadline to say so would be its own defect. Rows that could not be decoded
   * are the exception: one of those might be this move, so a listing with any of
   * them says nothing either way and the wait goes on.
   *
   * The default timeout is generous because the work is: a small overlay crosses
   * in seconds and a full Windows disk takes minutes, plus minutes more when the
   * target has to be sent the image this computer was built from first.
   */
  async waitForMove(move: Move | string, opts: WaitOptions = {}): Promise<Move> {
    // Before the deadline is set, because a bad anchor is the caller's mistake
    // and nothing has been sent yet.
    const anchor = moveAnchor(move);
    const { timeoutMs = 900_000, pollMs = 3_000, signal } = opts;
    checkWait(timeoutMs, pollMs);
    const deadline = Date.now() + timeoutMs;
    let polled = false;
    let delayMs = pollMs;
    let last: Move | undefined;
    // Whether the MOST RECENT poll answered, as against whether any ever did —
    // Builds.wait's `observed`, for its reason. Without it a wait whose polls
    // all failed after the first quoted that first one and said the move "was
    // still moving": a claim about the present tense made from an observation
    // that may be the whole timeout old.
    let observed = false;
    // Whether the most recent poll read the listing, could not decode all of
    // it, and this move was not among what it could — the third thing a poll can
    // say, and one the other two flags cannot spell: `observed` false covers a
    // listing nobody could fetch as well, and those two end a wait with entirely
    // different sentences. A poll that read the listing WHOLE and did not find
    // the row never sets this, because it does not come back.
    let absent = false;
    // THE LAST SUCCESSFUL POLL'S, and cleared by every poll that read no
    // listing, which is what makes that true. Left standing across one they
    // would let a timeout describe the listing as it was a quarter of an hour
    // ago — two undecodable rows read once, then fifteen minutes of silence —
    // in a sentence written in the present tense about what can be made out
    // now. A poll the deadline cut short read no listing either, which is the
    // half of that this loop went on getting wrong after it stopped getting the
    // other half wrong.
    let unreadableLast = 0;
    // The other half of the last poll's shortfall, kept beside it rather than
    // added into it: a row that is not an object and a row that names no
    // computer are two different things to have found. See {@link blindness}.
    let unmatchableLast = 0;
    // Cumulative, and only for the sentence a timeout that never saw the move
    // ends with: "every poll failed" is a different statement from "they
    // answered and it was not there", and one wait can do both. `aborts` is the
    // third of those, kept apart from `failures` because a poll this wait's own
    // deadline cut short is not a poll the platform failed — counting the two
    // together is how a wait with one 503 and three expired polls reported that
    // every poll had failed.
    let reads = 0;
    let failures = 0;
    let aborts = 0;
    for (;;) {
      if (Date.now() >= deadline) {
        throw new TimeoutError(
          moveTimeoutText({
            id: this.id,
            timeoutMs,
            anchor,
            last,
            observed,
            absent,
            unreadable: unreadableLast,
            unmatchable: unmatchableLast,
            reads,
            failures,
            aborts,
          }),
        );
      }
      // The sleep comes before every poll but the first, as waitUntilBuilt's
      // does and for its reason: a move that finished while the caller was doing
      // something else is one round trip from being known to have finished.
      if (polled) await sleepUntilNextPoll(delayMs, deadline, signal);
      polled = true;
      delayMs = pollMs;
      if (Date.now() >= deadline) continue;
      try {
        const moves = await this.#t.json(`GET`, P.MOVES, {
          signal: deadlineSignal(deadline - Date.now(), signal),
        });
        // `moveRows` rather than `expectMoves`, because this listing is
        // account-WIDE: the filter below is here precisely because most of its
        // rows are other computers'. Refusing the whole listing over one of
        // those would abort a wait whose own move is present and readable.
        const { rows, unreadable } = moveRows(moves, 'GET', P.MOVES);
        // The rows that are objects and still cannot be attributed. The filter
        // below is `computer_id === this.id` on the RAW row — strict, so that a
        // coerced `String(['vm-1'])` cannot pick a malformed row out of this
        // account-wide listing and return it as this computer's move (OPL-3850)
        // — and the cost of that is a row carrying `['vm-1']` being dropped by
        // the filter while `unreadable` counts it as fine. Such a row might be
        // THIS computer's, so a listing holding one cannot support "your move is
        // not listed" (OPL-4587).
        const unmatchable = unmatchableRows(rows, 'computer_id');
        reads += 1;
        const ours = rows
          .map(toMove)
          // THE RAW row, for the reason the snapshot filter gives: `str()` is a
          // coercion and `String(['vm-1'])` is `'vm-1'`, so a malformed row was
          // picked out of this account-wide listing and returned as this
          // computer's move (Codex review, third pass, OPL-3850).
          .filter((m) => belongsToComputer(m.raw, this.id));
        // Exact equality on the stored string, which is all the selection this
        // needs: the platform keys its moves table by computer id, so `ours` has
        // at most one row, and that row's `started_at` and the anchor are the
        // same value out of the same database. The decoded `startedAt` on both
        // sides — the anchor came through `str()` in `toMove` too, so nothing is
        // being compared to something coerced differently.
        const mine = ours.find((m) => m.startedAt === anchor);
        // A row for this computer that is NOT this move. One row per computer
        // and `INSERT OR REPLACE` leave exactly one reading of that: another
        // relocate on this computer replaced our row, and the outcome of the
        // move this wait was started for is no longer recorded anywhere. Failing
        // fast is safe — the replacement cannot un-happen, and the row can only
        // have been written after ours — where polling on would spend the whole
        // deadline to reach the same sentence with less to say in it.
        if (!mine && ours.length > 0) {
          const other = ours.map((m) => m.startedAt || '(none)').join(', ');
          throw new MandalaError(
            `${this.id}'s move started at ${anchor}, but the row for it on GET ${P.MOVES} now ` +
              `starts at ${other} — a newer move replaced it, which is what a second relocate ` +
              `on this computer does. This move's outcome is no longer recorded; read the ` +
              `state of the move that took it over with moves.list`,
          );
        }
        if (!mine) {
          // Absence is conclusive AT ONCE, and the platform is what makes it so.
          // `insertMove` writes the row with `INSERT OR REPLACE` inside the
          // transaction that precedes the 202 and returns a read-back of it,
          // over one synchronous database keyed by computer id with no replica
          // behind it — so the row exists before the caller can hold anything to
          // wait on, and there is no "not visible yet" state to poll through.
          // What is left is a row that has LEFT, which this platform does do:
          // it drops the row when the computer is deleted, when a finished move
          // is dismissed, and when the sweep clears finished rows that have
          // aged out. Spending the rest of a quarter-hour deadline to reach that
          // same sentence with less in it would be its own defect.
          //
          // Rows this client could not decode are the one exception, and it is
          // not a hedge: any one of THOSE might be this very move, so an empty
          // result after dropping some says "nobody could tell" — a different
          // sentence, which must not borrow this one's certainty. Then the
          // deadline is left to be the answer.
          if (unreadable === 0 && unmatchable === 0) {
            throw new MandalaError(
              `${this.id}'s move is not listed by GET ${P.MOVES}, on a listing read in full; a ` +
                `move's row leaves that listing when its computer is deleted, and when a ` +
                `finished move is dismissed`,
            );
          }
          absent = true;
          observed = false;
          unreadableLast = unreadable;
          unmatchableLast = unmatchable;
          continue;
        }
        last = mine;
        observed = true;
        absent = false;
        unreadableLast = unreadable;
        unmatchableLast = unmatchable;
        if (!mine.live) return mine;
      } catch (err) {
        if (signal?.aborted) throw err;
        // Named rather than inferred from the clock. See the note in
        // waitUntilRunning: `AbortSignal.timeout` can fire a millisecond before
        // `Date.now()` reaches the deadline, and this loop then rethrew its own
        // deadline as if the platform had failed. `observed` is deliberately
        // left alone for it, as in Builds.wait: this wait's own timer firing
        // inside a poll is not the platform failing to answer.
        if (isDeadlineAbort(err)) {
          aborts += 1;
          // Both of the last poll's readings go, exactly as on the failure path
          // below and for the identical reason: each describes what the last
          // listing READ could or could not be made out to hold, and a poll cut
          // short read no listing. Left standing, one poll that saw two
          // undecodable rows and a quarter of an hour of aborts after it end in
          // a timeout describing that first listing in the present tense — the
          // sentence this wait was changed to stop writing, reached by the one
          // path that had not been closed. `absent` was half of that count and
          // was being kept while its own explanation was thrown away, which
          // leaves a timeout claiming the row stopped being listed and no
          // longer able to say why that is not decidable.
          absent = false;
          unreadableLast = 0;
          unmatchableLast = 0;
          continue;
        }
        if (!isTransientForPoll(err)) throw err;
        observed = false;
        // A poll that never got an answer says nothing about whether the move is
        // on the listing, so the flag that means "it answered, partly, and this
        // was not in the part" has to go with it. The blindness count goes too:
        // it is what the LAST listing could not make out, and this poll read no
        // listing, so keeping it would date the timeout's sentence to whenever
        // the last successful poll happened to be.
        absent = false;
        unreadableLast = 0;
        unmatchableLast = 0;
        failures += 1;
        delayMs = retryDelay(pollMs, err);
      }
    }
  }

  /** Give this computer a new name. Sugar over {@link update}. */
  async rename(name: string, opts: CallOptions = {}): Promise<this> {
    return this.update({ name }, opts);
  }

  /**
   * Destroy this computer and its disk.
   *
   * Its snapshots survive by default and become orphans, which can still be
   * cloned into a new computer but not restored — a restore puts the disk back
   * on a source that no longer exists.
   *
   * To destroy those too, read {@link holdings} first and pass its fingerprint:
   *
   * ```ts
   * const held = await c.holdings();
   * if (held.count === expectedCount) {
   *   await c.delete({ deleteSnapshots: true, expect: held.fingerprint });
   * }
   * ```
   *
   * The fingerprint is refused unless it still names the same set, so a capture
   * that finished after you looked cannot be swept up in a decision that was
   * never about it.
   *
   * @returns how many snapshots were destroyed, or `undefined` if the platform
   * did not say. Not defaulted to 0: that would turn "it did not say" into the
   * affirmative claim that nothing was destroyed, about an irreversible act.
   */
  async delete(opts: DeleteOptions = {}): Promise<number | undefined> {
    const res = await this.#t.json<{ snapshots_deleted?: number } | undefined>(
      'DELETE',
      P.computer(this.id),
      { query: P.deleteQuery(opts), signal: opts.signal },
    );
    // Normalized rather than handed back raw: a JSON null would otherwise
    // arrive against a type that says it cannot, and `=== undefined` — the
    // check a caller writes to find out whether the platform answered — is
    // false for it.
    return count(res?.snapshots_deleted);
  }

  // --- readiness ------------------------------------------------------

  /**
   * The one message for a disk copy that will not finish.
   *
   * Shared by the three waits that must not spin on one, so the sentence a
   * caller sees does not depend on which of them noticed.
   */
  #buildFailure(): MandalaError {
    return new MandalaError(
      `${this.id} could not be built: ${this.buildError || 'the disk copy failed'}`,
    );
  }

  /**
   * A lifecycle state a guest probe cannot recover from, or `undefined`.
   *
   * The states are the ones that do not become "the guest answers" by being
   * waited on: no disk, a boot that failed, and a machine that is not running.
   * A *suspended* computer is deliberately absent — `exec` is use, and use
   * resumes a suspended session, so the probe wakes it itself.
   *
   * OPL-4628 added the stopped case, which had been costing the full budget and
   * then reporting "guest did not respond" about a machine that was never
   * running. The Python SDK refuses the same state in the same place; these two
   * SDKs answered it as opposites until now.
   */
  #guestWaitFailure(): MandalaError | undefined {
    if (this.buildFailed) return this.#buildFailure();
    if (this.startError) {
      return new MandalaError(`${this.id} did not start: ${this.startError}`);
    }
    if (this.#statusIs('stopped') && this.#nothingAdmitted()) {
      return new MandalaError(
        `${this.id} is stopped and its guest cannot answer: call start() first`,
      );
    }
    return undefined;
  }

  /**
   * Whether the platform has said, in as many words, that nothing is on its way
   * up (OPL-4630).
   *
   * `status` cannot answer this. It is read from the guest process, and a start
   * that has been ADMITTED has no process yet: the platform has taken the
   * memory, decided the plan allows it, and is loading. Through the whole of
   * that window `status` reports what the computer was — `stopped` for a cold
   * boot, `suspended` for a resume, whose session record is only spent once the
   * load has worked. So the two waits below cannot read `stopped` as "nobody is
   * starting this", which is what they used to do in one direction each: this
   * SDK gave up on a boot in progress in waitUntilRunning, and Python's
   * wait_for_guest did the same.
   *
   * `running_ram_mb` is what the platform charges the account's running pool
   * for, and it is non-zero from admission rather than from boot — so a zero is
   * the platform saying it has admitted nothing.
   *
   * Three states, not two. UNDEFINED is a host that did not say: one too old to
   * report the field, one that could not be reached, or a response written
   * before the computer was read back. That is not a zero, and treating it as
   * one would refuse a wait on the strength of a sentence nobody uttered — so
   * "cannot tell" waits, which is the direction that costs a timeout rather
   * than a machine.
   */
  #nothingAdmitted(): boolean {
    const held = this.#data.running_ram_mb;
    return typeof held === 'number' && Number.isFinite(held) && held === 0;
  }

  /**
   * The other end of the same reading: the platform is holding memory for this
   * computer, so something IS on its way up.
   *
   * Not `!#nothingAdmitted()`, and the difference is the absent case. That one
   * is false here and false there, because a host that did not answer has
   * neither admitted a start nor said it will not — and the two questions want
   * that silence answered in opposite directions. "May I refuse?" must say no.
   * "Is a start under way?" must also say no.
   */
  #startAdmitted(): boolean {
    const held = this.#data.running_ram_mb;
    return typeof held === 'number' && Number.isFinite(held) && held > 0;
  }

  /**
   * Wait until a cloned computer's disk has been copied.
   *
   * Returns immediately for anything not being built, so it is safe to call on
   * any computer. Throws `MandalaError` if the copy failed, and `TimeoutError`
   * if it is still going when the timeout runs out — the computer keeps building
   * either way; only the waiting stops.
   *
   * The default timeout is generous because the work is: a compressed conversion
   * of a 40 GB Windows disk takes several minutes on a busy host.
   */
  async waitUntilBuilt(opts: WaitOptions = {}): Promise<this> {
    const { timeoutMs = 900_000, pollMs = 5_000, signal } = opts;
    checkWait(timeoutMs, pollMs);
    const deadline = Date.now() + timeoutMs;
    // waitUntilRunning's `observed`, for waitUntilRunning's reason: when every
    // refresh fails transiently this handle is still holding whatever it held
    // before the wait began, and "was still building" concluded from that is a
    // claim about a computer nobody has actually looked at.
    let observed = false;
    // Whether the MOST RECENT refresh answered, which is a different question
    // from whether any of them did, and the two were spelled with one flag.
    // `observed` has to mean "any", because that is what keeps a wait from
    // quoting data an old `list()` left on the handle; but the timeout sentence
    // needs "the latest", because "IS still building" is a claim about now. One
    // answer followed by 503s to the deadline satisfied "any", and the wait
    // reported a fifteen-minute-old reading in the present tense. Builds.wait
    // splits the same two meanings across its three messages (OPL-4201).
    let fresh = false;
    // Kept apart, as `waitForMove` keeps them apart and for its reason: a
    // refresh this wait's own deadline cut short is not a refresh the platform
    // failed, and both left `observed` false without counting anything. A wait
    // every attempt of which expired mid-request therefore told the caller that
    // every refresh had failed when none had.
    let failures = 0;
    let aborts = 0;
    let polled = false;
    let delayMs = pollMs;
    for (;;) {
      if (this.buildFailed) throw this.#buildFailure();
      // A READABLE status that is not `building`, not merely the absence of
      // one. `#statusIs` is a strict comparison precisely so a coerced value
      // cannot classify — `String(['building'])` is `'building'` — and this
      // wait inverted it: success was the negation, so `undefined`,
      // `['building']` and `['build-failed']` all read as a copy that had
      // finished. `buildFailed` is the same strict test, so the array form did
      // not throw either; the wait simply returned, and the caller started a
      // computer whose disk was still being written. `waitUntilRunning` gets
      // this right by requiring the state it wants rather than the absence of
      // the one it does not (OPL-3850's shape, on the method that kept it).
      if (this.#statusKnown() && !this.isBuilding) return this;
      if (Date.now() >= deadline) {
        throw new TimeoutError(
          // Present tense only from the latest refresh — or from no refresh at
          // all, where `timeoutMs: 0` returns the handle's own reading and the
          // wait has had no chance to age it.
          !polled || (fresh && this.#statusKnown())
            ? `${this.id} was still building after ${timeoutMs}ms ` +
                '(it has not stopped; only this wait has)'
            : observed && this.#statusKnown()
              ? `${this.id} could not be reached for the last part of ${timeoutMs}ms; when it ` +
                'last answered its disk was still being copied. The copy has not stopped, only ' +
                'this wait has — call refresh() for where it got to.'
              : observed
                ? `${this.id} answered within ${timeoutMs}ms without a status this client could ` +
                  `read (${JSON.stringify(this.#data.status)}), so whether its disk copy ` +
                  'finished is unknown'
                : // Nothing was ever read, and the three ways that happens are
                  // three sentences: the platform failing every time, this
                  // wait cutting every attempt short, and a wait that did some
                  // of each — which blames only what it counted.
                  failures > 0 && aborts > 0
                  ? `${this.id} could not be observed within ${timeoutMs}ms: no refresh ` +
                    `finished — ${failures} failed outright and ${aborts} were cut short by ` +
                    `this wait's own deadline`
                  : failures > 0
                    ? `${this.id} could not be observed within ${timeoutMs}ms: every refresh failed`
                    : `${this.id} could not be observed within ${timeoutMs}ms: no refresh ` +
                      `finished before the deadline did, so nothing about the disk copy was ` +
                      `ever read`,
        );
      }
      // The sleep comes before every poll but the first. A clone that finished
      // while the caller was doing something else is one round trip from being
      // known to have finished, and sleeping first holds that back by a whole
      // poll interval to read nothing. A computer that is not being built still
      // returns above without a request at all.
      if (polled) await sleepUntilNextPoll(delayMs, deadline, signal);
      polled = true;
      delayMs = pollMs;
      // Guarded rather than unconditional: a sleep that ran the clock out
      // leaves nothing to read the answer with, and the check at the top of the
      // loop is what names that.
      if (Date.now() < deadline) {
        try {
          // The poll carries what is left of this wait, as waitForGuest's probe
          // does. Under the client's own per-request deadline alone a wait told
          // to give up after five seconds spends up to another sixty inside a
          // refresh whose answer it has already stopped waiting for.
          await this.refresh({ signal: deadlineSignal(deadline - Date.now(), signal) });
          observed = true;
          fresh = true;
        } catch (err) {
          // A caller who cancelled leaves now, whatever their reason is named.
          if (signal?.aborted) throw err;
          // This wait's own deadline firing inside a poll is this wait ending
          // rather than a failure of the poll, and `isDeadlineAbort` is what
          // names it — the clock is not, for the reason waitUntilRunning's note
          // gives. Short of that: a 503 from a host busy doing exactly the disk
          // copy being waited on is the ordinary weather of a build, not a
          // verdict on it — the same rule waitUntilRunning applies. Anything
          // else is not weather.
          if (!isDeadlineAbort(err) && !isTransientForPoll(err)) throw err;
          // Cleared for a host that did not answer, and NOT for this wait's own
          // deadline landing inside the request: the platform did not fail
          // there, and the reading from the poll before it is one interval old
          // rather than a whole budget old. Builds.wait leaves its flag alone
          // in the same place, for the same reason.
          if (isDeadlineAbort(err)) aborts += 1;
          else {
            fresh = false;
            failures += 1;
          }
          delayMs = retryDelay(pollMs, err);
        }
      }
    }
  }

  /**
   * Wait until the machine is running.
   *
   * This is the *machine*, not the desktop: it returns as soon as the VM is up,
   * while the guest OS is still booting. Use {@link waitForGuest} when you need
   * something inside the guest to be ready.
   *
   * Throws rather than waiting out the timeout for states that will not become
   * "running" on their own — a failed build, a stopped machine, and a suspended
   * session nobody has resumed. "Nobody has" is the platform's word rather than
   * an inference from `status`: a start that has been admitted holds its memory
   * before its process exists, and reads as stopped or suspended meanwhile, so
   * this waits for one of those and refuses only a computer the platform says
   * is holding nothing. A host that does not say is waited on.
   */
  async waitUntilRunning(opts: WaitOptions = {}): Promise<this> {
    const { timeoutMs = 120_000, pollMs = 2_000, signal } = opts;
    checkWait(timeoutMs, pollMs);
    const deadline = Date.now() + timeoutMs;
    // A create may return a stopped computer and the reason its first start
    // failed. refresh() correctly clears that one-attempt field, so retain it
    // for the failure this wait is about before the first poll replaces it.
    // Retired the moment a reservation is seen: a create's failed attempt is
    // history once somebody has started the machine since, and holding it for
    // the life of the wait refused a computer that was coming up on the
    // strength of an error about a different attempt (Codex review).
    let initialStartError = this.startError;
    // Success is a verdict, and no verdict is reached on state observed before
    // this call: when every refresh fails transiently, the handle may be
    // holding data from an old list(), and "running" concluded from that —
    // while the host answers 503 — is a claim about a machine nobody has
    // actually looked at.
    //
    // A REFUSAL IS A VERDICT TOO, and this comment used to argue otherwise: the
    // fail-fast throws were ungated on the grounds that a stopped or suspended
    // reading cannot go stale in the caller's favour. It can. A start admitted
    // by anybody reads as stopped or suspended until its guest process exists
    // (OPL-4630), so the last data anyone has is exactly what may now be wrong,
    // and the wait spends its whole budget failing to find out. The power
    // refusals below are gated on `mayRefuse` for that reason. The failed build
    // is not: nothing recovers that computer into a startable one, so no later
    // reading could overturn it.
    let observed = false;
    // Whether the LATEST refresh answered — waitUntilBuilt's flag, for its
    // reason. `observed` cannot carry this second meaning as well: it is what
    // stops the wait quoting pre-call data, so it has to survive a failed poll,
    // and the timeout sentence below then read the first answer of the wait as
    // the state of the machine now (OPL-4201).
    let fresh = false;
    // Whether a poll was ever ATTEMPTED, which is not the same question as
    // whether one answered. A `timeoutMs: 0` budget never enters the block
    // below, so `observed` cannot become true however the machine actually is
    // — see the success test.
    let attempted = false;
    // Counted apart, as `waitForMove` counts them apart: an attempt this wait's
    // own deadline cut short is not an attempt the platform failed, and both
    // leave `observed` false. Together they said every refresh had failed over a
    // wait in which the host had refused nothing — the deadline had simply
    // landed inside each request before the answer did.
    let failures = 0;
    let aborts = 0;
    for (;;) {
      let delayMs = pollMs;
      // Guarded rather than unconditional, so the sleep at the bottom of the
      // loop cannot hand the clock to a poll with no time left to read it.
      if (Date.now() < deadline) {
        attempted = true;
        try {
          // What is left of this wait, and not the client's own per-request
          // deadline: a wait told to give up after five seconds must not spend
          // another sixty inside a refresh it has stopped waiting for.
          await this.refresh({ signal: deadlineSignal(deadline - Date.now(), signal) });
          observed = true;
          fresh = true;
          if (this.#startAdmitted()) initialStartError = '';
        } catch (err) {
          // A caller who cancelled leaves now, whatever their reason is named.
          if (signal?.aborted) throw err;
          // This wait's own deadline firing inside the poll is this wait
          // ending, and `isDeadlineAbort` names it FROM THE ERROR. It used to be
          // inferred from the clock — `Date.now() < deadline &&` — and that is a
          // race this suite caught in CI rather than a tidier spelling of the
          // same test: `AbortSignal.timeout(n)` fires up to a millisecond before
          // `Date.now()` has advanced `n`, measured here at 3.3% of short waits.
          // On those, the wait's own deadline read as a platform failure and the
          // raw `TimeoutError` DOMException reached the caller in place of this
          // SDK's `TimeoutError` — the documented type, and the one the caller
          // catches. `builds.wait` already judged it by name for this reason.
          //
          // Dropping the clock half also stops a real 401 arriving on the last
          // poll from being swallowed and reported as a timeout: past the
          // deadline every error used to be discarded, whatever it was.
          //
          // Short of that: a host that cannot be reached answers 503, which is
          // the ordinary weather of a machine still coming up, and letting it
          // out would abort the one method whose whole job is to keep asking.
          // Anything else — a revoked key, a computer that is gone — is not
          // weather.
          if (!isDeadlineAbort(err) && !isTransientForPoll(err)) throw err;
          // The host did not answer, so the timeout below drops to the past
          // tense. Not for this wait's own deadline arriving mid-request: that
          // is not the platform failing, and waitUntilBuilt and builds.wait
          // both hold their flag across it for the same reason.
          if (isDeadlineAbort(err)) aborts += 1;
          else {
            fresh = false;
            failures += 1;
          }
          delayMs = retryDelay(pollMs, err);
        }
      }
      // `observed` is what stops this wait quoting pre-call data as a reading of
      // its own — except where there was never going to be a poll. A
      // `timeoutMs: 0` budget skips the refresh above, so success could not be
      // reached however the machine actually was, and a handle already reading
      // `running` came back as a `TimeoutError` claiming every refresh had
      // failed when none was attempted. `waitUntilBuilt` special-cases the same
      // budget, and for the same reason (OPL-4215).
      if ((observed || !attempted) && this.#statusIs('running')) return this;
      // A computer with no disk will never start on its own, and waiting out
      // the full timeout to say so helps nobody. Unqualified, unlike the two
      // POWER states below: nothing can be admitted for a machine with no disk,
      // so no reading could change this answer.
      if (this.buildFailed) throw this.#buildFailure();
      // The power refusals need a reading OF THEIR OWN, on the same terms the
      // success above needs one (Codex review of #80; python-sdk #81 had the
      // same shape). They are claims about what the platform is doing NOW, and
      // a budget spent entirely on refreshes that failed has learned nothing: a
      // handle cached at `running_ram_mb: 0`, a host answering 503 for the
      // whole wait, and another caller starting the machine in between produced
      // "it is stopped, call start()" about a computer on its way up.
      //
      // `!attempted` keeps the zero-budget case this file already carves out
      // above: with no budget nothing COULD be read, so the handle the caller
      // passed in is all there is and naming the state beats a bare timeout.
      const mayRefuse = observed || !attempted;
      // Stopped is stable just like suspended: neither state progresses to
      // running without a start request. In particular, a create that returned
      // start_error used to lose that explanation on refresh and poll until the
      // full timeout while repeatedly observing the same stopped state.
      //
      // Unless a start has already been admitted, which is the whole of
      // OPL-4630: a boot that is loading reads `stopped` until its process
      // exists, and this throw abandoned it. Now it refuses only what the
      // platform has actually called idle. See #nothingAdmitted.
      //
      // A KNOWN FAILED BOOT is refused on weaker evidence than an ordinary
      // stopped machine, and has to be: `running_ram_mb` is absent from exactly
      // the response that carries `start_error` — a create that could not boot
      // its machine does not report the pool — so requiring an explicit zero
      // here polled out the whole timeout and lost the one sentence that said
      // why. Silence does not overturn a failure the platform has already
      // reported; only an actual reservation does, and that is a start somebody
      // made after it.
      const reason = this.startError || initialStartError;
      if (mayRefuse && this.#statusIs('stopped') && reason && !this.#startAdmitted()) {
        throw new MandalaError(
          `${this.id} is stopped after it failed to start: ${reason}. Call start() to try again`,
        );
      }
      if (mayRefuse && this.#statusIs('stopped') && this.#nothingAdmitted()) {
        throw new MandalaError(
          `${this.id} is stopped and will not start on its own: call start() to start it`,
        );
      }
      // Nor will a suspended one — with the same exception, and it bites harder
      // here. A RESUME holds its memory from admission too, and the suspend
      // record is spent only on the way out of a start that worked, so a resume
      // in flight reads `suspended` for its whole load. Refusing that told a
      // caller to call start() on a machine whose start was already running.
      if (mayRefuse && this.isSuspended && this.#nothingAdmitted()) {
        throw new MandalaError(
          `${this.id} is suspended and will not start on its own: call start() to resume it`,
        );
      }
      if (Date.now() >= deadline) {
        // "was still X" is only claimed about a status this wait actually saw
        // ON ITS LAST POLL; a handle nobody could refresh reports the
        // refreshes, and one whose refreshes stopped answering says when it
        // last looked rather than pretending the reading is current.
        throw new TimeoutError(
          !attempted
            ? `${this.id} was ${JSON.stringify(this.status)} and ${timeoutMs}ms left no time to ` +
                'look again'
            : !observed
              ? // No refresh ever answered, and the three ways that happens are
                // three sentences: the platform failing every time, this wait
                // cutting every attempt short, and a wait that did some of each
                // — which blames only what it counted.
                failures > 0 && aborts > 0
                ? `${this.id} could not be observed within ${timeoutMs}ms: no refresh ` +
                  `finished — ${failures} failed outright and ${aborts} were cut short by ` +
                  `this wait's own deadline`
                : failures > 0
                  ? `${this.id} could not be observed within ${timeoutMs}ms: every refresh failed`
                  : `${this.id} could not be observed within ${timeoutMs}ms: no refresh finished ` +
                    `before the deadline did, so nothing about the computer was ever read`
              : fresh
                ? `${this.id} was still ${JSON.stringify(this.status)} after ${timeoutMs}ms`
                : `${this.id} could not be reached for the last part of ${timeoutMs}ms; when it ` +
                  `last answered it was ${JSON.stringify(this.status)}`,
        );
      }
      await sleepUntilNextPoll(delayMs, deadline, signal);
    }
  }

  /**
   * Wait until the guest OS answers, by running a trivial command in it.
   *
   * Works on Linux and Windows: the probe is `exit 0`, a builtin of both bash
   * and cmd.exe, so it needs nothing on the guest's PATH and nothing about which
   * OS this is.
   *
   * What it establishes is that the *guest agent* answers, which is earlier than
   * the desktop being usable — on Windows especially, since the agent runs in
   * session 0 and replies well before anyone has logged in. When you need the
   * desktop rather than the machine, poll {@link screenshot}.
   *
   * Throws rather than waiting out the timeout on a failed build, a boot that
   * failed, or a machine that is stopped — nothing inside any of those will
   * ever answer, and `start()` is the fix for the last two. A *suspended*
   * computer is not refused here, unlike in {@link waitUntilRunning}: running a
   * command resumes one, so the probe both wakes the machine and gets its
   * answer — which is a side effect worth knowing about on a wait that reads as
   * passive.
   *
   * Not entirely passive in one more way since OPL-4628: a probe failure this
   * wait is going to sit out is followed by a state re-read, so a computer that
   * stops mid-wait is reported as stopped rather than as a quiet guest.
   */
  async waitForGuest(opts: WaitOptions = {}): Promise<this> {
    const { timeoutMs = 180_000, pollMs = 3_000, signal } = opts;
    checkWait(timeoutMs, pollMs);
    const deadline = Date.now() + timeoutMs;
    // A clone may be handed straight to this wait. There is no guest to probe
    // until its disk copy finishes, and only a state refresh can discover that
    // the copy failed while we were waiting.
    // Captured before the wait below can change it: the timeout message turns
    // on whether a disk copy actually ran, and by the time it is written this
    // computer is no longer building either way.
    const copied = this.isBuilding;
    if (copied) {
      await this.waitUntilBuilt({
        timeoutMs: Math.max(deadline - Date.now(), 0),
        pollMs,
        signal,
      });
    }
    // Whether the guest was ever actually asked. A clone handed straight to
    // this wait can spend the entire budget in the disk copy above, and the
    // timeout then reported "guest did not respond" about a guest no probe had
    // reached — naming the wrong phase, and pointing at the wrong fix.
    let probed = false;
    for (;;) {
      let delayMs = pollMs;
      // Nothing inside a computer with no disk is ever going to answer, and
      // spending three minutes to say so helps nobody — waitUntilRunning's
      // rule, for its reason. Same rule for a stopped machine, which is what a
      // resume-only start leaves behind when no saved session remained
      // (OPL-3619): its guest cannot answer either, and "call start() first" is
      // an answer the caller can act on where a three-minute silence is not.
      //
      // Read off the handle rather than through a fresh GET on the first pass.
      // A handle that says stopped came from a create, clone, get or start one
      // line before this call, and staleness is bounded by the refresh below:
      // every probe failure this loop waits out re-reads the state, so a
      // machine that stops mid-wait is noticed on the next pass rather than at
      // the deadline.
      const failure = this.#guestWaitFailure();
      if (failure) throw failure;
      if (Date.now() < deadline) {
        try {
          probed = true;
          // The probe carries what is left of this wait, as well as the caller's
          // signal. Under the client's own per-request deadline alone a wait told
          // to give up after 180 seconds spends up to another 60 inside a request
          // whose answer it has already stopped waiting for — and a caller's
          // abort could not interrupt a probe already in flight at all.
          const res = await this.exec(GUEST_PROBE, {
            timeoutS: 5,
            signal: deadlineSignal(deadline - Date.now(), signal),
          });
          if (res.ok) return this;
        } catch (err) {
          // A caller who cancelled is not a failed poll. The wait's own deadline
          // firing inside a probe is not caught here either — that is this loop
          // ending, and the check below is what names it.
          if (signal?.aborted) throw err;
          // Everything a booting guest legitimately answers is polled through: a
          // 409 means the agent is not up yet, a 503 means its host could not be
          // reached, and an agent that is merely slow answers 502 for the first
          // seconds of a boot. A revoked key or a malformed request is not, and
          // must not be disguised as three minutes of guest unavailability.
          //
          // One predicate now, where this was `isPermanent` plus `isTransient`
          // plus an inline `|| status === 502` (OPL-3724). All three said the
          // same thing badly: this loop retries by exception rather than by
          // permission, which is what isTransientForPoll is.
          //
          // Judged with NO `Date.now() < deadline` clause, which the first cut
          // of this kept from the code it replaced and which was a regression
          // (Codex adversarial review). `isPermanent` ran unconditionally, so a
          // revoked key reached the caller whenever it arrived. Folded behind
          // the clock it stopped doing that: a probe that takes longer than
          // what is left of the wait — which is every probe on the last poll,
          // and any probe at all against a slow edge — has its 401 replaced by
          // "guest did not respond", the least useful thing this method can say
          // about a 401. Builds.wait had already made exactly this correction.
          //
          // Which leaves the deadline to be named rather than inferred, as the
          // other four loops here do. deadlineSignal composes
          // AbortSignal.timeout, whose DOMException can fire a millisecond
          // before Date.now() reaches the deadline, and it is this wait ending
          // rather than a failure of the platform — so a predicate that has
          // never heard of it must not be the thing asked. That race is
          // documented and deterministically tested for waitUntilRunning; this
          // loop was the one still exposed to it.
          if (!isDeadlineAbort(err) && !isTransientForPoll(err)) throw err;
          delayMs = retryDelay(pollMs, err);
          // A failed probe may also mean the cached lifecycle state is stale,
          // and this is the read that turns "the guest is quiet" into "it is
          // stopped; call start()" — the check at the top of the next pass has
          // nothing else to work from. The Python SDK re-reads in the same
          // place for the same reason.
          //
          // Bounded by what is left of the wait, and its own transient failure
          // is no more final than the probe's: a host that cannot be reached
          // leaves the cached state alone and the loop waits the interval out.
          // A permanent one is the caller's to see, exactly as above.
          const left = deadline - Date.now();
          if (left > 0) {
            try {
              await this.refresh({ signal: deadlineSignal(left, signal) });
              // Acted on HERE rather than at the top of the next pass, which is
              // after the deadline check below: a refresh that read `stopped`
              // on the last poll of a wait would otherwise be thrown away and
              // the caller told the guest did not respond — about a machine
              // this loop had just learned was not running (Codex review).
              const found = this.#guestWaitFailure();
              if (found) throw found;
            } catch (inner) {
              // The caller's cancellation first, and before any predicate: the
              // outer catch has said so since OPL-3724 and this one did not, so
              // an abort landing inside the refresh came back as this wait's
              // own TimeoutError — the reason replaced by a symptom.
              if (signal?.aborted) throw inner;
              if (!isDeadlineAbort(inner) && !isTransientForPoll(inner)) throw inner;
              // A rate limit answered on the refresh is the platform's own
              // answer to "how long", and dropping it turned a 1s Retry-After
              // into the probe's 1ms interval. The longer of the two wins: the
              // probe's backoff is a floor this must not lower.
              delayMs = Math.max(delayMs, retryDelay(pollMs, inner));
            }
          }
        }
      }
      if (Date.now() >= deadline) {
        throw new TimeoutError(
          probed
            ? `${this.id} guest did not respond within ${timeoutMs}ms`
            : copied
              ? `${this.id}'s disk copy used the whole ${timeoutMs}ms, so its guest was never ` +
                `probed — the copy itself finished. Call waitForGuest again with a fresh timeout ` +
                `to ask the guest.`
              : // No copy ran, so blaming one names a phase this call never had.
                // `timeoutMs: 0` is a supported argument and reaches here on any
                // ordinary computer: the deadline is spent before the loop can
                // make its first request.
                `${this.id}'s ${timeoutMs}ms deadline had elapsed before its guest could be ` +
                `probed, so nothing was asked of it. Call waitForGuest with a longer timeout.`,
        );
      }
      await sleepUntilNextPoll(delayMs, deadline, signal);
    }
  }

  // --- events ---------------------------------------------------------

  /**
   * What this computer is doing, as an async iterator.
   *
   * The stream exists so that an agent stops paying for a screenshot to find
   * out that nothing has happened. Windows opening, closing and taking focus;
   * the clipboard changing hands; a background command exiting; the desktop
   * becoming ready; every power transition.
   *
   * ```ts
   * for await (const ev of c.events()) {
   *   if (ev.type === 'process.exited' && ev.pid === job.pid) break;
   * }
   * ```
   *
   * Breaking out of the loop closes the socket. So does the returned object's
   * `close()`, and so does an `AbortSignal` passed as `signal`.
   *
   * **It reconnects, and it keeps your place.** Every event carries an opaque
   * cursor; the position after the last event you actually CONSUMED is what a
   * reconnect resumes from, so a socket that drops mid-loop does not lose the
   * `process.exited` you were waiting for. Where this host can no longer replay
   * that far you are handed a `gap` event instead of silence — not an error and
   * not swallowed, because it is the signal to reconcile against
   * {@link windows} or {@link execPoll} rather than to assume nothing happened.
   *
   * Three frames are not events about the computer and arrive as events anyway,
   * because a client cannot ignore what it was never handed: `gap`, `closed`
   * (this host ending the stream deliberately, with a sentence saying whether
   * it is worth reopening) and `capabilities` (the vocabulary being revised
   * under an open socket). Ignore a `type` you do not recognise; the vocabulary
   * grows.
   *
   * `computer.ready` is the one with a trap in it, and this SDK takes it out.
   * It fires once per desktop SESSION, so a machine that has been up for an
   * hour will never send it again — a raw socket waiting for it waits forever.
   * The opening frame carries the state instead, and a stream that joins an
   * already-ready desktop yields a `computer.ready` marked
   * {@link ComputerEvent.synthesized} as its first event.
   *
   * Refused with a `409` on a suspended computer — this is the one part of the
   * API that does NOT resume one for you — and on a stopped one. Neither
   * reaches a websocket client as a status, so what you get is this SDK reading
   * the computer afterwards and saying which it was.
   */
  events(opts: EventStreamOptions = {}): ComputerEvents {
    return new ComputerEvents(
      (signal) => this.#eventsUrl(signal),
      (signal) => this.#eventsRefusal(signal, watchList(opts.watch)),
      opts,
    );
  }

  /**
   * Wait for one event, then stop.
   *
   * ```ts
   * await c.waitFor('computer.ready');                       // after a create
   * const done = await c.waitFor('process.exited');          // after execBackground
   * ```
   *
   * The call that replaces a polling loop. Everything {@link events} does about
   * cursors and reconnects applies, so this survives a socket that drops while
   * it waits; the socket is closed on the way out however this returns.
   *
   * Three things it refuses rather than waiting out:
   *
   * - an event type THIS computer cannot emit. The opening frame lists what it
   *   can — a Windows guest, or an image built without the X bindings the
   *   watcher needs, produces no `window.*` and no `computer.ready` — and
   *   waiting for one of those is waiting for something the platform has
   *   already said will not arrive. Checked again whenever a `capabilities`
   *   frame revises the list under an open socket.
   * - `file.changed` with no tree nominated, which the advertised list alone
   *   would call reachable and nothing would ever satisfy: it is the one type
   *   that never arrives unasked, so pass `watch` here as you would to
   *   {@link events}.
   * - a computer that is suspended or stopped, which is the `409` on the
   *   upgrade rather than anything about the wait.
   *
   * `computer.ready` returns at once on a desktop that is already up; see
   * {@link events} and {@link ComputerEvent.synthesized}.
   *
   * `file.changed` ends this wait only where something actually CHANGED. Three
   * shapes share that type and the other two are about the tree — it went live,
   * or the picture of it is incomplete — so a wait matched on the name alone
   * would come back with the arming marker on a fresh nomination and with a
   * real change on a tree somebody else had already armed, which is the same
   * call meaning two different things depending on who got there first. The
   * markers still arrive on {@link events}, and {@link ComputerEvents.watching}
   * folds them into each tree's state; they simply do not answer this question.
   * A timeout says which nominated tree never armed, because a watch that did
   * not arm is silent in exactly the way a tree where nothing happened is.
   */
  async waitFor(types: string | string[], opts: WaitForOptions = {}): Promise<ComputerEvent> {
    const wanted = new Set(typeof types === 'string' ? [types] : types);
    if (wanted.size === 0) {
      throw new ValidationError('waitFor needs at least one event type to wait for');
    }
    const { timeoutMs = 180_000, signal: caller, ...streamOpts } = opts;
    // The same refusal every other wait in this SDK makes, in the same words:
    // `timeoutMs: Number(unsetEnvVar)` is a deadline that never arrives, and a
    // wait that never returns is the one failure shape worse than a wrong
    // answer. The poll interval is not this wait's — there is no poll — so it
    // is passed as the one number checkWait will accept unremarkably.
    checkWait(timeoutMs, 1);
    const deadline = deadlineSignal(timeoutMs, caller);
    // What the vocabulary said, when it said this wait cannot end. Kept rather
    // than thrown from the hook: it runs inside the stream's own machinery,
    // where a throw would be caught by the reconnect logic and read as a
    // connection that failed.
    let impossible: Error | undefined;
    // How many trees this wait's own stream nominates. Read from the options
    // rather than off the stream, because `file.changed` being reachable is a
    // fact about the subscription and not about the computer — and it is the
    // same for every connection the wait makes.
    const nominated = watchList(streamOpts.watch).length;
    const stream = this.events({
      ...streamOpts,
      signal: deadline,
      // COMPOSED, not replaced. `onConnect` is an option on `WaitForOptions`
      // like any other, and this used to overwrite it — so a caller's hook was
      // accepted by the type, documented on the option, and silently never
      // called. `signal` above IS replaced, and that is not the same thing:
      // it is composed first, through `deadlineSignal`, so the caller's still
      // fires.
      //
      // Theirs first, because the check below can close the stream, and a hook
      // that never sees the connection it was promised is the defect this is
      // fixing rather than a smaller version of it.
      onConnect: (hello) => {
        // Read BEFORE their hook runs, not after it. `hello` is the live
        // opening frame, so a hook that pushes onto `events` — the mutation
        // `eventTypes` and `hello` are both copied to prevent — would
        // otherwise fake this computer into naming the very type this wait is
        // about to decide it can never emit, and the wait would run to its
        // deadline instead of saying so.
        const events = [...hello.events];
        streamOpts.onConnect?.(hello);
        impossible = unreachableTypes(this.id, wanted, events, nominated);
        if (impossible) stream.close();
      },
    });
    try {
      for await (const ev of stream) {
        if (answersWait(ev, wanted)) return ev;
        if (ev.type === 'capabilities' && ev.events) {
          impossible = unreachableTypes(this.id, wanted, ev.events, nominated);
          if (impossible) break;
        }
      }
    } finally {
      stream.close();
    }
    if (impossible) throw impossible;
    // A caller who cancelled gets their own reason, not a deadline this wait
    // set. `deadlineSignal` composes both, so the caller's is checked first —
    // the rule `waitUntilRunning` follows in every catch it has.
    if (caller?.aborted) throw caller.reason;
    if (deadline.aborted) {
      // The trees that were not being watched when this ended, named. A watch
      // that is not armed is silent in exactly the way a tree where nothing
      // happened is, and without this the difference — which is the whole of
      // what `armed` is for — reaches a caller as an ordinary timeout with
      // nothing in it to explain the wait. A sentence rather than an early
      // refusal: `unwatchable` recovers on its own, and this SDK cannot tell a
      // typo from a directory a job is about to create.
      //
      // "was not armed" rather than "never armed", because both a tree that
      // stayed dark and one that went live and was then taken back out by an
      // `unwatchable` end up here, and only the first never armed. The state at
      // the deadline is the claim this can actually make.
      const dark = unarmedTrees(stream.watching);
      throw new TimeoutError(
        `${this.id} did not emit ${[...wanted].join(' or ')} within ${timeoutMs}ms` +
          (dark.length > 0
            ? `. Its watch on ${dark.join(', ')} was not armed when this ended, so changes ` +
              `under it were not being reported`
            : ''),
      );
    }
    // Reached only with `reconnect: false`, where the socket ending IS the
    // answer. Reported as what happened rather than as a timeout that has not
    // elapsed.
    throw new MandalaError(
      `${this.id}'s event stream ended before ${[...wanted].join(' or ')} arrived`,
    );
  }

  /**
   * A fresh `events_url`, on every connection and every reconnect.
   *
   * Re-read rather than cached, because the credential in it is rotated by a
   * restart — and a restart is one of the ordinary reasons the socket dropped.
   * A reconnect over the old URL is a 401 that looks like a bug in the stream.
   */
  async #eventsUrl(signal?: AbortSignal): Promise<string> {
    try {
      await this.refresh({ signal });
    } catch (err) {
      // A read that will answer the same way forever ends the stream rather
      // than being retried behind it. Without this a deleted computer or a
      // revoked key is a reconnect loop with no `maxRetries` to stop it — the
      // default is to never give up — asking a question already answered, and
      // never saying the answer out loud.
      if (err instanceof Error && !isTransientForPoll(err)) throw settled(err);
      throw err;
    }
    // Read off the RAW connect surface, not only the decoded one.
    // `toVncConnect` answers `undefined` for a payload missing either desktop
    // credential, which is the right rule for the two URLs it builds over them
    // and the wrong one for this one: the platform sends `events_url` whole,
    // with the controlling credential already in it. Taken together, a payload
    // short a `view_token` and carrying a working stream URL fell into the
    // unreachable-host branch below and reconnected against it forever, with
    // `maxRetries` defaulting to never give up (OPL-4215).
    const url = this.vnc?.eventsUrl || vncEventsUrl(this.#data.vnc);
    if (url) return url;
    if (!P.isRecord(this.#data.vnc)) {
      // The platform could not reach the host holding this computer, so it sent
      // no connect surface at all. Weather, and the stream's own backoff is the
      // right response to it — deliberately NOT settled.
      //
      // Tested on the RAW field for the same reason the read above is: a
      // decoded `undefined` also means "present and short a credential", and
      // that is a computer whose host answered, so retrying it says nothing new.
      // Such a surface falls through to the settled throws below instead.
      throw new ConnectionError(
        `the platform did not return a connect surface for ${this.id}; its host may be unreachable`,
      );
    }
    if (this.os === 'windows') {
      throw settled(
        new MandalaError(
          `${this.id} runs Windows, which has no event stream: there is nowhere in the guest ` +
            'to run the watcher the guest half needs.',
        ),
      );
    }
    throw settled(
      new MandalaError(
        `${this.id} has no events_url. Its host may predate the event stream, or this ` +
          'credential may be a watch-only one, which is not given window titles.',
      ),
    );
  }

  /**
   * Why the upgrade was refused, read off the computer after the fact.
   *
   * A refused websocket tells its client nothing: a 409, a 401 and a TCP reset
   * all arrive as an error with an empty message and a 1006 close, and the
   * `WebSocket` API exposes neither the status nor the body. So the state is
   * asked for directly, and the two refusals the reference names are named back
   * — with `settled` on them, because neither a suspended computer nor a
   * stopped one becomes reachable by being asked again.
   */
  async #eventsRefusal(signal: AbortSignal | undefined, watch: readonly string[]): Promise<Error> {
    try {
      await this.refresh({ signal });
    } catch (err) {
      // The read IS the answer here. A 404 says the computer is gone and a 401
      // says the key is, which are better sentences than anything this method
      // could infer; a 503 says the host could not be reached, which is the
      // weather the stream's backoff exists for.
      if (err instanceof Error) return isTransientForPoll(err) ? err : settled(err);
      return new ConnectionError(`the event stream for ${this.id} was refused`);
    }
    if (this.isSuspended) {
      return settled(
        new MandalaError(
          `${this.id} is suspended, and the event stream is the one part of this API that does ` +
            'not resume a computer for you: call start() and open it again.',
        ),
      );
    }
    if (!this.#statusIs('running')) {
      return settled(
        new MandalaError(
          `${this.id} is ${JSON.stringify(this.status)}, and only a running computer has an ` +
            'event stream: call start() and open it again.',
        ),
      );
    }
    // It is running, so the refusal was about the connection rather than the
    // machine — a rotated credential, a host that moved, an edge in the way.
    // Retryable, and the reconnect is what retries it.
    //
    // A stream that nominates trees has two more ways to be refused, and both
    // arrive here looking identical to the three above: a path this host cannot
    // honour is a `400`, and a computer already watching its limit is a `409`.
    // Neither can be read off the socket, and neither can be told from a
    // rotated credential — so this stays retryable and says what it cannot
    // rule out, rather than guessing at one of them.
    if (watch.length > 0) {
      return new ConnectionError(
        `${this.id}'s event stream would not open, and it reports itself as running. This ` +
          `stream nominates ${watch.join(', ')} to watch, and a nomination this host cannot ` +
          `honour is refused the same silent way: a path it will not accept, or a computer ` +
          `already watching its limit of trees across every stream open on it. Open the stream ` +
          `without watch to tell that apart from a connection that simply failed`,
      );
    }
    return new ConnectionError(
      `${this.id}'s event stream would not open, and it reports itself as running`,
    );
  }

  // --- observing ------------------------------------------------------

  /**
   * Capture the screen.
   *
   * Full-resolution PNG by default. Passing `width` returns a downscaled JPEG
   * instead — much cheaper, and enough for a thumbnail or a "has anything
   * changed" check.
   *
   * **PASS `fresh` WHENEVER THE IMAGE IS FEEDING A DECISION.** Without it the
   * platform may serve a frame up to 1.5 seconds old, which is what makes N
   * watchers of one desktop cost a single screendump and what makes a drive
   * loop act on the screen as it was *before* its own last click. A model
   * handed that frame concludes the click missed and clicks again — which is
   * how a dialog gets dismissed twice, and how the second dismissal lands on
   * whatever the first one revealed. A thumbnail can have the cached frame; a
   * decision cannot.
   *
   * `fresh` and `width` cannot be combined, and asking for both is refused
   * rather than half-honoured: the platform serves every downscaled screenshot
   * from its cache, so a `fresh` alongside a width is a flag it would accept
   * and ignore. Anything deciding on the image wants the full frame anyway.
   *
   * A screenshot is not *use* as far as the platform's idle sweep is concerned,
   * and does not resume a suspended computer. A loop that only polls the screen
   * can therefore watch its own machine be suspended out from under it after the
   * host's idle window; anything that drives the desktop — {@link click},
   * {@link type}, {@link exec} — both counts as use and resumes it.
   */
  async screenshot(
    width?: number,
    opts: { fresh?: boolean } & CallOptions = {},
  ): Promise<Uint8Array> {
    const res = await this.#t.bytes('GET', P.computerAction(this.id, 'screenshot'), {
      query: P.screenshotQuery(width, opts.fresh),
      signal: opts.signal,
    });
    // A captive portal or a misconfigured proxy answers 200 with an HTML page,
    // and these bytes go straight into an image decoder or a model's context.
    // The JSON and SSE readers both name that failure; this route handed it
    // back as a PNG. readFile stays permissive on purpose — a guest file is
    // whatever the guest has — but a screenshot is an image or it is nothing.
    if (!res.contentType.toLowerCase().startsWith('image/')) {
      throw new MandalaError(
        `expected an image from GET ${P.computerAction(this.id, 'screenshot')}, ` +
          `got ${res.contentType}`,
      );
    }
    return res.bytes;
  }

  /**
   * The windows the window manager knows about (OPL-3583). Linux only.
   *
   * A screenshot says what the desktop looks like; this says what any of it is,
   * which is how you tell a browser that failed to open from one that has not
   * painted yet.
   *
   * Panels, the wallpaper and other furniture are excluded by default — a stock
   * guest with one terminal open has five windows, four of which are not
   * applications. Pass `{ includeAll: true }` for all of them.
   *
   * The rows are the same {@link GuestWindow} on either desktop, read off the X
   * server on an X11 guest and off the compositor on a Wayland one (OPL-4223).
   * Two fields carry a difference worth knowing about rather than a different
   * spelling — see {@link GuestWindow.id} and {@link GuestWindow.windowClass} —
   * and {@link desktop} is what says which you are reading.
   */
  async windows(opts: { includeAll?: boolean } & CallOptions = {}): Promise<GuestWindow[]> {
    const path = P.computerAction(this.id, 'windows');
    const data = await this.#t.json<Record<string, unknown>>('GET', path, {
      query: { include: P.flag(opts.includeAll, 'includeAll') ? 'all' : undefined },
      signal: opts.signal,
    });
    // A NAMED object, not a bare array (OPL-4176). This read `jsonArray` until
    // then and threw on every call ever made against the platform, because the
    // route answers `{"windows":[...]}` — deliberately, and the reference says
    // why: the shape has somewhere to grow, and an empty desktop answers
    // `{"windows":[]}` rather than `null`.
    //
    // The absent key is refused rather than read as an empty desktop, which is
    // where this parts company with mandala-computer-python's
    // `_windows_from_response`. `{}` is not a WindowList: the platform sends
    // the key for an empty desktop — verified against app.mandala.computer,
    // not read off the reference — so a body without it is a proxy or a
    // half-written response, and calling that "nothing is open" is the same
    // coercion `clipboard()` refuses one method along.
    if (!P.isRecord(data) || !Array.isArray(data.windows)) {
      throw new MandalaError(`expected a windows array from GET ${path}`);
    }
    // And every row in it names a window. `toGuestWindow` coerces an absent id
    // to `''` — it has to, because the same decoder runs inside the event
    // stream's message listener, where a throw would end a connection over one
    // frame — so the refusal lives here, on the surface whose whole purpose is
    // handing back handles the eight window actions take (OPL-4200).
    return toWindowListing(data.windows, `GET ${path}`);
  }

  /**
   * Focus, raise, minimize, maximize, unmaximize, close, move or resize one
   * window (OPL-3583).
   *
   * The reply is the window *afterwards*, not an acknowledgement — the window
   * manager places the frame and applications snap to their own grid, so a move
   * to 300,200 routinely lands at 305,229. Believe the response, not the
   * request.
   *
   * Prefer `focus` over `raise`: raising without focusing gives a window that is
   * visibly in front and silently not receiving keystrokes.
   *
   * A MOVE OR A RESIZE IS REFUSED ON A TILED WINDOW, on a computer whose
   * {@link desktop} is `wayland`. A tiled window's geometry belongs to the
   * compositor's layout rather than to the window, so Hyprland accepts the
   * dispatch and does nothing — and a caller reading that cannot tell "declined"
   * from "applied, and the numbers happen to match what they already were".
   * The daemon therefore asks whether the window floats BEFORE dispatching and
   * refuses when it does not, naming the way past it: float the window (Super+V
   * in a stock Omarchy) and the move or resize takes. Nothing like it happens
   * on X11, where a move on any window is simply accepted — which is why this
   * refusal reads as a fault to anyone who has only ever driven an X11 guest.
   *
   * It arrives as a 400, so as a plain {@link APIError}, and `errors.ts` opens
   * by saying a 400 never clears. That still holds for the REQUEST — repeating
   * it byte for byte will be refused again — but the state it complains about
   * is one the caller can change, and the message names the change. So this is
   * the 400 on this method to read rather than to give up on.
   *
   * A {@link WindowResult} rather than a window, because two outcomes have no
   * window to describe and only one of them is a `close`. See `gone`. This
   * method decoded the body as a bare window until OPL-4176 and threw on every
   * call; the platform has always answered
   * `{"ok":true,"gone":false,"window":{...}}`.
   */
  async windowAction(
    windowId: string,
    action: P.WindowAction,
    geometry: { x?: number; y?: number; width?: number; height?: number } = {},
    opts: CallOptions = {},
  ): Promise<WindowResult> {
    const path = P.windowPath(this.id, windowId);
    const data = await this.#t.json<Record<string, unknown>>('POST', path, {
      body: P.windowBody({ action, ...geometry }),
      signal: opts.signal,
    });
    // `window` is legitimately `null` on a close and on an action the guest
    // could not describe, so the VALUE cannot be required. The KEY can, and has
    // to be: without it `{}` and `{"ok":true}` decode into the one outcome a
    // caller is told not to retry — see `isWindowResult`.
    if (!P.isRecord(data) || !isWindowResult(data)) {
      throw new MandalaError(`expected a window result from POST ${path}`);
    }
    const result = toWindowResult(data);
    // A body that says the window is gone AND describes it says two things a
    // caller acts on differently, and this is the layer that has to choose
    // between them rather than leave the choice to whichever field the caller
    // read. The same split `builds.wait` makes: the reading is in models.ts and
    // the throw is at the call site that acts on it (OPL-4200).
    const contradiction = windowContradiction(result);
    if (contradiction !== null) throw new MandalaError(`${contradiction} (POST ${path})`);
    return result;
  }

  /**
   * What is on the desktop's clipboard (platform OPL-3743, OPL-3768). Linux
   * only.
   *
   * The `CLIPBOARD` selection — what Ctrl-C writes and Ctrl-V pastes — not the
   * X `PRIMARY` selection that middle-click uses.
   *
   * This is the road that needs nothing of the HARDWARE — no cold boot, and no
   * permission from a browser. The other way text crosses is RFB extended cut
   * text over the desktop socket, which is live and needs a virtio-serial
   * channel a computer only acquires on a cold boot; see the note on
   * {@link VncConnect}.
   *
   * It does want one thing of the IMAGE, and unlike the socket's conditions it
   * is stated in the answer rather than left to be inferred: `xclip` in the
   * guest. Every golden built since August 2026 carries it, so in practice this is
   * a computer created before then — and a computer keeps the image it was
   * created from. The refusal is a 400 that says so, and it is PERMANENT:
   * install `xclip` in the guest, which you can do since you have root there,
   * or create a new computer. Do not retry it.
   *
   * A READ, not a subscription. Nothing notices a Ctrl-C in the guest on its
   * own, and this call does NOT resume a suspended computer — what somebody
   * copied is not worth waking a machine for, so a stopped or suspended
   * computer answers 409 rather than starting. That one carries
   * {@link APIError.reason} `unavailable`: the 409 here that never clears by
   * waiting, because `start()` is something only the caller can do. See
   * {@link setClipboard} for the rest of them; it is the other way round on the
   * resume.
   *
   * An empty clipboard is `''`, and a failure is an exception rather than an
   * empty string: the two are told apart here, which is the thing the `exec`
   * recipe this replaces could not do.
   */
  async clipboard(opts: CallOptions = {}): Promise<string> {
    const path = P.computerAction(this.id, 'clipboard');
    const data = await this.#t.json<Record<string, unknown>>('GET', path, { signal: opts.signal });
    // Checked rather than coerced. `String(undefined)` is "undefined" — a
    // four-word clipboard nobody copied, indistinguishable from a real one, and
    // pasted somewhere by whoever asked.
    if (!P.isRecord(data) || typeof data.text !== 'string') {
      throw new MandalaError(`expected clipboard text from GET ${path}`);
    }
    return data.text;
  }

  /**
   * Put text on the desktop's clipboard, ready to paste (platform OPL-3768).
   * Linux only.
   *
   * This leaves the text on the clipboard and touches nothing on screen. Pair
   * it with `key(['ctrl', 'v'])` to get the text into whatever has focus.
   *
   * Unlike {@link clipboard}, this DRIVES the computer: a suspended one is
   * resumed to serve it, which is a start and is charged like one.
   *
   * At most 64 KiB of UTF-8 goes in — half what comes out, and the two are
   * different bounds on different channels rather than one number rounded
   * twice. Empty text and a NUL are refused here rather than on the wire; see
   * `MAX_CLIPBOARD_BYTES` in paths.ts for why that is the number.
   *
   * The platform confirms the write by reading the selection back before it
   * answers, so this returning means the desktop is holding the text, not
   * merely that a command ran.
   *
   * NOT EVERY {@link ConflictError} HERE IS WORTH RETRYING, and
   * {@link APIError.reason} is how they are told apart (platform OPL-3898).
   * `contention` is the one that clears by itself — "the desktop did not take
   * the text" means something else claimed the selection in that instant, a
   * clipboard manager settling, usually — and `starting` clears too, more
   * slowly: the guest agent has not answered inside its boot window yet.
   * `unavailable` does not clear at all, because the computer is not running
   * and `start()` is the fix rather than another attempt. Desktop-session and
   * X-server failures carry NO word, deliberately: the platform cannot tell a
   * guest still coming up from a logged-out desktop or a crashed window
   * manager, so it gives no retry advice and neither does this. Switch on the
   * word and never on the sentence, which is prose and is rewritten.
   *
   * {@link isTransient} reads it, so it no longer says yes to the stopped
   * computer — which is what it used to do, and what a blanket retry loop spun
   * on until somebody's deadline. An unclassified refusal still falls back to
   * the type answer, so bound a loop that meets one.
   *
   * And two 400s here never clear at all, which matters more on this method
   * than on the read for exactly that reason: the guest needs `xclip` in its
   * image (see {@link clipboard}), and Windows is refused outright. Both say
   * which they are.
   */
  async setClipboard(text: string, opts: CallOptions = {}): Promise<void> {
    await this.#t.json('PUT', P.computerAction(this.id, 'clipboard'), {
      body: P.clipboardBody(text),
      signal: opts.signal,
    });
  }

  // --- controlling ----------------------------------------------------

  async #input(
    body: Record<string, unknown>,
    opts: CallOptions = {},
    minTimeoutMs?: number,
  ): Promise<Record<string, unknown>> {
    return (
      (await this.#t.json<Record<string, unknown>>('POST', P.computerAction(this.id, 'input'), {
        body,
        minTimeoutMs,
        signal: opts.signal,
      })) ?? {}
    );
  }

  /**
   * Move the pointer to `(x, y)` in this computer's screen space.
   *
   * Coordinates are in the computer's own {@link resolution}, which is a
   * create-time choice — not a fixed 1280x800.
   */
  async move(x: number, y: number, opts: CallOptions = {}): Promise<void> {
    await this.#input(P.pointerBody('move', x, y), opts);
  }

  /**
   * Click. With no coordinate, clicks wherever the pointer already is.
   *
   * `modifiers` are held down for the click, e.g.
   * `click(100, 200, ['shift'])` to extend a selection.
   */
  async click(
    x?: number,
    y?: number,
    modifiers: readonly string[] = [],
    opts: CallOptions = {},
  ): Promise<void> {
    await this.#input(P.clickBody('left_click', x, y, modifiers), opts);
  }

  async rightClick(
    x?: number,
    y?: number,
    modifiers: readonly string[] = [],
    opts: CallOptions = {},
  ): Promise<void> {
    await this.#input(P.clickBody('right_click', x, y, modifiers), opts);
  }

  async middleClick(
    x?: number,
    y?: number,
    modifiers: readonly string[] = [],
    opts: CallOptions = {},
  ): Promise<void> {
    await this.#input(P.clickBody('middle_click', x, y, modifiers), opts);
  }

  async doubleClick(
    x?: number,
    y?: number,
    modifiers: readonly string[] = [],
    opts: CallOptions = {},
  ): Promise<void> {
    await this.#input(P.clickBody('double_click', x, y, modifiers), opts);
  }

  /** Three clicks, which is how most editors select a whole line. */
  async tripleClick(
    x?: number,
    y?: number,
    modifiers: readonly string[] = [],
    opts: CallOptions = {},
  ): Promise<void> {
    await this.#input(P.clickBody('triple_click', x, y, modifiers), opts);
  }

  /**
   * Press, move, release — one gesture.
   *
   * The pointer passes through intermediate positions, which is what makes this
   * a drag rather than two clicks: text selection, canvas tools and
   * drag-and-drop all watch for the motion between the ends.
   *
   * Without `from`, the drag starts wherever the pointer is. That is refused if
   * nothing has moved it yet, rather than guessing at an origin and selecting
   * the wrong thing.
   */
  async drag(toX: number, toY: number, from?: Point, opts: CallOptions = {}): Promise<void> {
    // `from` is an optional positional in front of `CallOptions`, so a
    // JavaScript `drag(x, y, { signal })` binds the options object here — and
    // an options object is a `Point` at runtime as far as anything could tell:
    // it simply has no `x` and no `y`. `start_coordinate` was then omitted, the
    // drag ran from wherever the pointer happened to be, and it selected a
    // different region while succeeding and reporting nothing (OPL-4215).
    // `!= null`, so a JavaScript `drag(x, y, null)` keeps reaching `from?.x` and
    // meaning "no starting point". Tested with `!== undefined` this guard
    // dereferenced null and threw a TypeError naming neither the argument nor
    // the call — the failure `nameBody` is fixed for one file over.
    if (from != null && (typeof from.x !== 'number' || typeof from.y !== 'number')) {
      throw new ValidationError(
        'drag() takes a { x, y } starting point; to pass CallOptions leave the point out — ' +
          'drag(toX, toY, undefined, { signal })',
      );
    }
    await this.#input(P.dragBody(toX, toY, from?.x, from?.y), opts);
  }

  /**
   * Press the left button and leave it down.
   *
   * Pair with {@link mouseUp}. Between the two the desktop is mid-gesture, so a
   * call that throws in between leaves the button held — wrap them in
   * `try`/`finally` if that matters.
   */
  async mouseDown(x?: number, y?: number, opts: CallOptions = {}): Promise<void> {
    await this.#input(P.buttonBody('left_mouse_down', x, y), opts);
  }

  /** Release the left button. */
  async mouseUp(x?: number, y?: number, opts: CallOptions = {}): Promise<void> {
    await this.#input(P.buttonBody('left_mouse_up', x, y), opts);
  }

  /**
   * Scroll the wheel, first moving to `(x, y)` when a point is given.
   *
   * With no coordinate it scrolls whatever is under the pointer.
   *
   * `direction` is up, down, left or right. Horizontal scrolling needs a
   * hypervisor running QEMU 7.1 or newer; an older one refuses it by name rather
   * than scrolling the wrong way.
   */
  async scroll(x?: number, y?: number, opts: ScrollOptions = {}): Promise<void> {
    // The mirror of the misbinding `requireModifiers` catches, and this method
    // is the one place it lands. `click(100, 200, ['shift'])` is correct, so
    // `scroll(100, 200, ['shift'])` is the natural thing to write next — and
    // here `modifiers` is a NAMED option inside the third parameter, so the
    // array binds to `opts`, `opts.modifiers` is undefined, and the scroll
    // happened with nothing held down (OPL-4215).
    if (Array.isArray(opts)) {
      throw new ValidationError(
        'scroll() takes its modifiers as an option, not a positional — ' +
          "scroll(x, y, { modifiers: ['shift'] })",
      );
    }
    const { direction = 'down', amount = 3, modifiers } = opts;
    await this.#input(P.scrollBody({ direction, amount, x, y, modifiers }), opts);
  }

  /**
   * Type text as keystrokes.
   *
   * Characters with no key mapping are skipped rather than raising, so a stray
   * emoji in a prompt cannot fail the whole call.
   */
  async type(text: string, opts: CallOptions = {}): Promise<void> {
    await this.#input(P.typeBody(text), opts);
  }

  /**
   * Press a chord, e.g. `key('ctrl', 'c')` or `key('Return')`.
   *
   * Both this SDK's names and X11 keysyms are accepted, so the spellings a
   * computer-use model produces — `Page_Down`, `BackSpace`, `period` — work
   * without translation. An unknown key raises and names itself rather than
   * being silently dropped from the chord.
   */
  async key(keys: readonly string[], opts?: CallOptions): Promise<void>;
  async key(...keys: string[]): Promise<void>;
  async key(
    first: string | readonly string[] | undefined,
    ...rest: (string | CallOptions | undefined)[]
  ): Promise<void> {
    // An array first is the form that can carry options — every other input
    // method takes a CallOptions, and this one could not, so a chord was the
    // one keystroke in this SDK that no signal could cancel. The rest-args
    // spelling stays exactly as it was, because it is the one in every example.
    const spread = typeof first === 'string';
    // A trailing options object in the rest-args spelling. TypeScript's
    // overloads reject it, but JavaScript reaches here — and every other input
    // method takes CallOptions last, so it is the natural thing to write. It
    // used to be JSON-serialised INTO `keys` as a third keystroke while the
    // signal it carried was dropped: not the chord that was asked for, and not
    // cancellable either. Refused rather than peeled, because the array form is
    // the documented spelling that carries options and quietly accepting a
    // second one is how two spellings drift apart.
    if (spread && rest.some((r) => r !== undefined && typeof r !== 'string')) {
      throw new ValidationError(
        'key(...) takes key names as separate strings; to pass CallOptions use the array form — ' +
          "key(['ctrl', 'c'], { signal })",
      );
    }
    const keys = first == null ? [] : spread ? [first, ...(rest as string[])] : [...first];
    // A HOLE in the chord, which the check above deliberately let through and
    // should not have. `JSON.stringify` turns an `undefined` array entry into
    // `null`, so `key('ctrl', undefined, 'c')` reached the platform as
    // `keys: ['ctrl', null, 'c']` — a chord with a keystroke nobody named, sent
    // rather than refused. Exactly the "JavaScript reaches here" case the
    // comment above is about: `key('ctrl', map.get('copy'))` is how one
    // arrives, and a caller who wrote that meant a two-key chord.
    //
    // Checked on the RESOLVED chord rather than on `rest`, because the hole is
    // the same hole in either spelling and the guard was gated on `spread`:
    // `key(['ctrl', undefined, 'c'])` is the array form of the very call this
    // refuses, and it went on the wire (OPL-4215).
    if (keys.some((k) => k === undefined)) {
      throw new ValidationError(
        'key(...) takes a key name in every position; one of them was undefined, which reaches ' +
          'the platform as a null keystroke rather than as the chord you asked for',
      );
    }
    await this.#input(P.keyBody(keys), spread ? {} : ((rest[0] as CallOptions) ?? {}));
  }

  /**
   * Hold a chord down for `seconds`, then release it.
   *
   * For the keys that mean something while held rather than when tapped — an
   * arrow key that repeats, a modifier that changes what a UI shows.
   */
  async holdKey(keys: readonly string[], seconds: number, opts: CallOptions = {}): Promise<void> {
    await this.#input(P.holdKeyBody(keys, seconds), opts, (seconds + 30) * 1_000);
  }

  /**
   * Pause, inside the platform, without holding this computer's monitor.
   *
   * Sleeping locally does the same thing for a script. This exists because a
   * computer-use model emits `wait` as an action, and because it does not block
   * the screenshot polls of anything else watching the desktop. Capped at 30
   * seconds by the platform.
   */
  async wait(seconds: number, opts: CallOptions = {}): Promise<void> {
    await this.#input(P.waitBody(seconds), opts, (seconds + 30) * 1_000);
  }

  /**
   * Where the pointer is, or `undefined` if nothing has placed it yet.
   *
   * This is where the *platform* last put the pointer. The virtual pointing
   * device accepts coordinates and reports none back, so there is nothing to
   * read from the guest: after a fresh boot, before anything has moved it, the
   * honest answer is that nobody knows — hence `undefined` rather than a
   * confident `(0, 0)`.
   */
  async cursorPosition(opts: CallOptions = {}): Promise<Point | undefined> {
    const res = await this.#input(P.cursorBody(), opts);
    // `known` is checked rather than assumed because the coordinates are still
    // present and still zero when it is false, which is indistinguishable from
    // the corner of the screen — the exact wrong answer to give a caller about
    // to move relative to it. TRUE only, for that same reason: a flag nobody
    // could read is not somebody saying where the pointer is (OPL-3850).
    if (!said(res.known)) return undefined;
    // And a `known` of true with a coordinate missing or unusable is the same
    // as unknown. `num`'s fallback answers 0 for a null, an empty string or an
    // object, which is that corner of the screen again — arrived at through the
    // other field, past the check written to prevent it (Codex review,
    // OPL-3850). Truncated the way the Python SDK's `int()` truncates, so one
    // payload cannot read two ways across the two clients.
    const x = count(res.x);
    const y = count(res.y);
    if (x === undefined || y === undefined) return undefined;
    return { x: Math.trunc(x), y: Math.trunc(y) };
  }

  // --- the guest ------------------------------------------------------

  /**
   * Run a shell command inside the guest.
   *
   * Uses the guest's native shell — bash on Linux, cmd.exe on Windows. A
   * non-zero exit is returned, not thrown; check {@link ExecResult.ok}.
   *
   * {@link ExecResult.stdout} and {@link ExecResult.stderr} are `Uint8Array` —
   * what the command actually wrote — with {@link ExecResult.stdoutText} and
   * {@link ExecResult.stderrText} beside them for the ordinary case of reading a
   * line of text back.
   *
   * By default the command runs in the system context: as `root` on Linux, with
   * no display attached. Pass `desktop: true` to run it in the logged-in desktop
   * session instead — as the desktop user, with `DISPLAY`, `HOME` and
   * `XAUTHORITY` set — which is what anything with a window needs.
   *
   * A GUI program does not exit on its own, so launch it detached or the call
   * blocks until `timeoutS` kills it. Or call {@link open} and let the SDK write
   * that line.
   *
   * For anything slower than a few seconds, use {@link execBackground} rather
   * than a longer timeout: a command that outlives `timeoutS` keeps running
   * inside the guest, and its output is then unreachable.
   *
   * Past about two minutes a longer timeout is not merely worse, it is
   * inoperative. The HTTP budget is derived from `timeoutS` and the platform
   * stretches its own deadline to match, but a proxy in front of the platform
   * abandons a request that has produced no response for roughly that long and
   * answers 524 — arriving as {@link GatewayTimeoutError}. Measured against
   * `app.mandala.computer`, `sleep 130` failed at 125.2s with `timeoutS: 300`
   * despite the larger guest budget. Foreground `timeoutS` must be an integer
   * from 1 through 600; the server limit does not extend the hosted proxy's
   * roughly 120-second ceiling. The command survives the
   * request that abandoned it, so the next call on this computer may report the
   * guest agent as busy with it.
   *
   * `env` adds variables for this command, and is the right way to hand a build
   * a token — the alternative is interpolating it into `command`, where the
   * guest's shell history and process list can both read it. On Linux it goes
   * on top of the guest's profile rather than replacing it: the command runs
   * through `bash -lc`, so `PATH` and the rest survive. On **Windows it
   * replaces** — `cmd.exe /c` sources no profile, so the command sees these
   * variables and nothing else, `PATH` and `SystemRoot` included. Pass what
   * that command needs, or set it inside `command`.
   */
  async exec(
    command: string,
    opts: {
      timeoutS?: number;
      desktop?: boolean;
      cwd?: string;
      env?: Readonly<Record<string, string>>;
    } & CallOptions = {},
  ): Promise<ExecResult> {
    const { timeoutS = 30, desktop, cwd, env } = opts;
    const path = P.computerAction(this.id, 'exec');
    // The guest was just granted timeoutS to finish, so the HTTP request has to
    // outlive that. Under the fixed client deadline alone, any timeoutS past it
    // was guaranteed to be aborted client-side while the command ran on in the
    // guest with its output unreachable.
    //
    // Validate the server's foreground limit before deriving the HTTP deadline.
    const body = P.execBody({ command, timeoutS, desktop, cwd, env });
    const minTimeoutMs = (timeoutS + 30) * 1_000;
    const data = await this.#t.json<Record<string, unknown>>('POST', path, {
      body,
      minTimeoutMs,
      signal: opts.signal,
    });
    // Checked rather than defaulted to `{}`. A 204 or an empty body decodes to
    // `undefined` here, and the decoder refuses that too — but it can only name
    // the FIELD it could not read. This names the ROUTE, which is what says
    // where to look; `clipboard()` and `agentOnce()` refuse a non-record for
    // the same reason (OPL-4215).
    if (!P.isRecord(data)) {
      throw new MandalaError(`expected an exec result from POST ${path}`);
    }
    return toExecResult(data);
  }

  /**
   * Start a command and return a handle instead of waiting (OPL-3584).
   *
   * For builds, installs, test suites and servers. Strictly better than
   * backgrounding with `&`, which throws away the exit code and the output.
   * Read what it prints with {@link execPoll}, stop it with {@link execKill}.
   */
  async execBackground(
    command: string,
    opts: {
      desktop?: boolean;
      cwd?: string;
      env?: Readonly<Record<string, string>>;
    } & CallOptions = {},
  ): Promise<BackgroundExec> {
    const path = P.computerAction(this.id, 'exec');
    const data = await this.#t.json<Record<string, unknown>>('POST', path, {
      body: P.execBody({
        command,
        background: true,
        desktop: opts.desktop,
        cwd: opts.cwd,
        env: opts.env,
      }),
      signal: opts.signal,
    });
    // Checked rather than defaulted to `{}`. A 204 or an empty body decodes to
    // `undefined` here, and `toBackgroundExec({})` throws "expected a
    // background command's pid, got null" — correct refusal of a fabricated
    // success, but it does not name the route the way `exec()` was fixed to
    // (OPL-4215).
    if (!P.isRecord(data)) {
      throw new MandalaError(`expected a background command from POST ${path}`);
    }
    return toBackgroundExec(data);
  }

  /**
   * What a backgrounded command has printed since the last poll, and whether it
   * has finished.
   *
   * The output is a **cursor, not a buffer**: each poll gives you only the new
   * bytes, so two readers on one pid split the output between them rather than
   * each seeing all of it. When {@link BackgroundExec.more} is set there is
   * further output waiting — poll again straight away.
   *
   * Those bytes are bytes: the platform cuts a poll at 1 MiB on a byte offset,
   * so a chunk can begin or end mid-rune. Write {@link BackgroundExec.stdout}
   * straight to a stream, or join the chunks and decode once —
   * {@link BackgroundExec.stdoutText} decodes each chunk on its own, which is
   * right for a line of output and lossy across a cut.
   */
  async execPoll(pid: number, opts: CallOptions = {}): Promise<BackgroundExec> {
    const path = P.execHandle(this.id, pid);
    const data = await this.#t.json<Record<string, unknown>>('GET', path, {
      signal: opts.signal,
    });
    if (!P.isRecord(data)) {
      throw new MandalaError(`expected a background command from GET ${path}`);
    }
    return toBackgroundExec(data);
  }

  /**
   * Kill a backgrounded command and everything it started.
   *
   * Answers with its final state, including whatever it printed that you had not
   * read.
   */
  async execKill(pid: number, opts: CallOptions = {}): Promise<BackgroundExec> {
    const path = P.execHandle(this.id, pid);
    const data = await this.#t.json<Record<string, unknown>>('DELETE', path, {
      signal: opts.signal,
    });
    if (!P.isRecord(data)) {
      throw new MandalaError(`expected a background command from DELETE ${path}`);
    }
    return toBackgroundExec(data);
  }

  /**
   * Open a URL in the guest's browser, on the screen.
   *
   * ```ts
   * await c.open('https://example.com');
   * ```
   *
   * Sugar over {@link exec} with `desktop: true`: it names a browser that works
   * on the image, quotes the URL, and detaches the launch so the call returns in
   * well under a second instead of blocking until `timeoutS`.
   *
   * The result describes the *launch*, not the page — a zero exit means the shell
   * started the browser, not that the URL resolved. On a cold browser the window
   * has taken as long as ten seconds to draw, so screenshot until the screen
   * changes rather than concluding from one frame that nothing launched.
   *
   * Linux only, and the refusal is the platform's rather than this SDK's. A
   * desktop session on a Windows guest is refused before the computer is asked
   * whether it is running (platform OPL-4208), carrying `reason: "unsupported"`
   * — which {@link APIError.reason} reads as settled, so a retry loop stops on
   * it rather than starting the computer and asking again.
   *
   * There is deliberately no OS check here. This SDK held one until OPL-4202,
   * for the single reason that the platform used to answer `not running` first
   * and refuse Windows several steps later, which sent a caller with a stopped
   * Windows computer round a loop with no exit. Ordering that refusal correctly
   * upstream retired the guard: the platform knows what the guest runs, and this
   * object knows only what its last payload said, so a computer whose `os` never
   * arrived would have been refused here for a command it could have run.
   */
  async open(url: string, opts: { timeoutS?: number } & CallOptions = {}): Promise<ExecResult> {
    return this.exec(P.openUrlCommand(url), {
      timeoutS: opts.timeoutS ?? 30,
      desktop: true,
      signal: opts.signal,
    });
  }

  // --- files ----------------------------------------------------------

  /**
   * Read one file out of the guest, as bytes.
   *
   * `path` is absolute, inside the guest — there is no shell and no working
   * directory behind this, so a relative path is refused before the request is
   * made. Works while the computer is running or suspended (a transfer resumes a
   * suspended computer, like any other use).
   *
   * `timeoutMs` extends the client's per-request deadline for this one
   * transfer — a large file can legitimately outlive the default 60 seconds,
   * and the exec docs send large output through this very path. Pass `0` to
   * disable the deadline for this transfer; a caller `signal` still cancels it.
   */
  async readFile(
    path: string,
    opts: { timeoutMs?: number } & CallOptions = {},
  ): Promise<Uint8Array> {
    return (await this.#readFileRequest(path, opts)).bytes;
  }

  /** {@link readFile}, decoded as UTF-8. */
  async readTextFile(
    path: string,
    opts: { timeoutMs?: number } & CallOptions = {},
  ): Promise<string> {
    const bytes = await this.readFile(path, opts);
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (cause) {
      throw new MandalaError(`${path} is not valid UTF-8`, { cause });
    }
  }

  /** The one request behind every read on this route. */
  async #readFileRequest(
    path: string,
    opts: { offset?: number; length?: number; timeoutMs?: number } & CallOptions,
  ): Promise<Bytes> {
    const headers = P.rangeHeaders(opts.offset, opts.length);
    try {
      return await this.#t.bytes('GET', P.computerAction(this.id, 'files'), {
        query: P.filesQuery(path),
        headers,
        noTimeout: opts.timeoutMs === 0,
        minTimeoutMs: opts.timeoutMs,
        signal: opts.signal,
      });
    } catch (err) {
      // Here rather than on readFile, which was the only method that had it —
      // readFilePart with no window is the same whole-file read and earned the
      // same refusal with none of the help. And only where no window was asked
      // for: the platform applies the ceiling to the file when there is no
      // range and to the WINDOW when there is, so a ranged request cannot earn
      // a 413 at all. Which makes the rewrite unambiguous rather than a guess —
      // wherever it fires, paging really is the answer.
      throw headers ? err : pointPastTheCeiling(err);
    }
  }

  /**
   * One window of a file, with where it starts and how much file there is.
   *
   * ```ts
   * const head = await c.readFilePart('/var/log/app.log', { length: 64 * 1024 });
   * const tail = await c.readFilePart('/var/log/app.log', { offset: -4096 });
   * console.log(`${head.bytes.length} of ${head.total} bytes`);
   * ```
   *
   * `offset` is where to start and `length` how much to ask for; a **negative**
   * offset is the tail — the last `-offset` bytes — and takes no length. With
   * neither, this is {@link readFile} with the answer's metadata attached.
   *
   * **You can get fewer bytes than you asked for.** A window larger than one
   * request moves is trimmed rather than refused, since the ceiling is not
   * knowable before you ask — so {@link FileChunk.offset} and the length of
   * what came back, not the numbers you passed, are where the next window
   * starts. {@link readFileChunks} is that loop, already written.
   *
   * A file whose length the guest cannot report — a `/proc` entry — has no byte
   * positions to name, so the range is ignored and the whole thing arrives with
   * `partial: false` and `seekable: false`.
   */
  async readFilePart(
    path: string,
    opts: { offset?: number; length?: number; timeoutMs?: number } & CallOptions = {},
  ): Promise<FileChunk> {
    return toFileChunk(await this.#readFileRequest(path, opts), path);
  }

  /**
   * A file of any size, in as many requests as it takes.
   *
   * ```ts
   * const out = await open('./build.tar', 'w');
   * for await (const chunk of c.readFileChunks('/home/user/build.tar')) {
   *   await out.write(chunk.bytes);
   * }
   * await out.close();
   * ```
   *
   * This is what `Range` exists for. One request moves a bounded number of
   * bytes across the guest agent — 64 MiB today, and not a number to hard-code
   * — so a 2 GB build output is something to page through rather than something
   * {@link readFile} refuses with a {@link TooLargeError}. Chunks arrive in
   * order and end to end, so writing each one where the last finished
   * reconstructs the file; nothing is buffered but the chunk in hand.
   *
   * `offset` and `length` narrow it to part of the file, spelled as on
   * {@link readFilePart} — a negative offset is the tail, which is paged from
   * its true start so the chunks still arrive in order. `chunkBytes` caps how
   * much any one request asks for, for a caller who wants to hold less than the
   * platform is willing to send; left out, each request asks for the rest and
   * takes whatever the ceiling allows.
   *
   * An empty file yields nothing. A file no range can be served out of yields
   * once, with `partial: false`.
   */
  async *readFileChunks(
    path: string,
    opts: {
      offset?: number;
      length?: number;
      chunkBytes?: number;
      timeoutMs?: number;
    } & CallOptions = {},
  ): AsyncGenerator<FileChunk> {
    const { chunkBytes } = opts;
    if (chunkBytes !== undefined && (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1)) {
      throw new ValidationError(`chunkBytes must be at least one byte (got ${chunkBytes})`);
    }
    // Judged against the spelling the caller used, before the tail below turns
    // it into something else. A `{ offset: -100, length: 10 }` is a range no
    // header can express and has to be refused as one — resolved first it would
    // instead become a silently ignored length, and a fractional offset would
    // be reported against a number the caller never passed.
    P.rangeHeader(opts.offset, opts.length);
    const each = { timeoutMs: opts.timeoutMs, signal: opts.signal };
    let offset = opts.offset ?? 0;
    let remaining = opts.length;
    let total: number | undefined;

    if (offset < 0) {
      // A tail, resolved to where it starts before anything is paged.
      //
      // The alternative — asking for `bytes=-N` and paging on from there —
      // cannot work: a tail longer than one request moves is trimmed at its
      // NEAR end, so the first answer would be the LAST chunk of the file and
      // everything after it would arrive backwards. One byte is enough to learn
      // the length, and from there this is an ordinary forward read whose start
      // is the tail's own start. That is not the mistake the trimming rule
      // warns about: the offset is derived from the file's real length rather
      // than assumed, so the window still ends where the file does.
      const wanted = -offset;
      const probe = await this.readFilePart(path, { offset: -1, ...each }).catch((err: unknown) => {
        // An empty file has no last byte, so the probe is refused with a
        // total of zero rather than answered with nothing.
        if (err instanceof RangeNotSatisfiableError && err.total === 0) return undefined;
        throw err;
      });
      if (!probe) return;
      if (!probe.partial) {
        // No range could be served out of this file, so the probe brought all
        // of it. There is nothing left to page towards.
        yield probe;
        return;
      }
      // A probe that WAS a window and named no total is the forward loop's
      // failure met one request earlier, and it has to be answered the same
      // way. Yielded and returned — which is what this did — it hands back the
      // file's last byte as though it were the tail that was asked for: a
      // one-byte `mandala scp` that reports success.
      if (probe.total === undefined) throw noTotal(path);
      total = probe.total;
      offset = Math.max(0, total - wanted);
      remaining = total - offset;
    }

    // `first` is "nothing is known about this file yet", not "this is request
    // number one" — and after a tail probe something is. The probe only falls
    // through to here having been served a 206 with a total, so ranges are
    // proven to work on this path and the loop opens at an offset derived from
    // that total. Entering with `first` set anyway hands both of the escapes
    // below to a file that has forfeited them: a whole-file answer is taken as
    // the honest unmeasurable-file case and yielded, which for a tail read is
    // the file's FIRST bytes returned as its last, and a 416 with a total of
    // zero ends the read as an empty file rather than as one truncated out from
    // under it. The platform can serve either — a guest file re-created between
    // two requests is measurable for one and not the next, and a Range on a file
    // whose length cannot be determined up front is ignored and answered 200 —
    // so this is not a shape only a broken origin can produce.
    for (let first = total === undefined; ; first = false) {
      const length =
        remaining === undefined
          ? chunkBytes
          : chunkBytes === undefined
            ? remaining
            : Math.min(remaining, chunkBytes);
      const chunk = await this.readFilePart(path, { offset, length, ...each }).catch(
        (err: unknown) => {
          // An empty file refuses every range, since there is no byte for one
          // to name. Nothing to yield, and not a failure to report — but only
          // on the first request: further along it would mean the file shrank
          // under the read, which is worth surfacing rather than reading as an
          // ordinary end.
          if (first && err instanceof RangeNotSatisfiableError && err.total === 0) return undefined;
          throw err;
        },
      );
      if (!chunk) return;
      if (!chunk.partial) {
        // The range was ignored and the whole file came instead. Honest as the
        // first answer — an unmeasurable file — and a contradiction as any
        // later one, where these would be the file's first bytes handed back in
        // the middle of a read that is already past them.
        //
        // Offset zero is neither, and it is why the forfeit is spelled as a
        // position rather than as `!first`: a tail wider than the file resolves
        // to a window that starts at byte zero and runs to the end, so the
        // whole file IS the answer that was asked for and yielding it hands
        // back nothing the caller did not want. Only once the loop has moved
        // past byte zero does a whole-file answer put the file's first bytes
        // somewhere they cannot belong.
        if (!first && offset > 0) {
          throw new MandalaError(
            `asked ${path} for bytes from ${offset} and was answered with the whole file; ` +
              'a paging read cannot go on from that',
          );
        }
        // Taking it as the answer is not taking it unmeasured. Where a total is
        // already known — the tail probe measured this file to work out where
        // byte zero of the window was — the whole file is only that window
        // while it is still the same file, and a guest file re-created larger
        // between the probe and this request comes back as a 200 carrying every
        // byte of the new one: more than the caller's `length`, and starting
        // before the tail that was resolved against the old size. Both bounds
        // every partial answer gets below are affordable here, and both are
        // conditioned on having measured something, because a plain read that
        // never did has neither number and keeps its documented behaviour of
        // yielding once with `partial: false`.
        if (total !== undefined) {
          if (length !== undefined && chunk.bytes.length > length) {
            throw new MandalaError(
              `asked ${path} for ${length} bytes from ${offset} and was answered with the whole ` +
                `file, ${chunk.bytes.length} bytes; a paging read cannot hand back more than it ` +
                'asked for',
            );
          }
          if (chunk.total !== undefined && chunk.total !== total) {
            throw new MandalaError(
              `the total for ${path} changed from ${total} to ${chunk.total} during a paging ` +
                'read; the chunks may belong to different versions of the file',
            );
          }
        }
        yield chunk;
        return;
      }
      if (chunk.offset !== offset) {
        throw new MandalaError(
          `asked ${path} for bytes from ${offset} and was answered from ${chunk.offset}; ` +
            'a paging read cannot go on from an answer that is not where it asked',
        );
      }
      // A window wider than the one asked for. Not something the platform can
      // do — it clamps to the request and then to its own ceiling — but a
      // caller who bounded the read with `length` bounded it, and quietly
      // handing back more than that is not a smaller wrong than handing back
      // less. toFileChunk has already made the body and the header agree, so
      // this is the request's own bound rather than a second check of theirs.
      if (length !== undefined && chunk.bytes.length > length) {
        throw new MandalaError(
          `asked ${path} for ${length} bytes from ${offset} and was answered with ` +
            `${chunk.bytes.length}; a paging read cannot hand back more than it asked for`,
        );
      }
      if (chunk.total === undefined) throw noTotal(path);
      if (total === undefined) {
        total = chunk.total;
      } else if (chunk.total !== total) {
        throw new MandalaError(
          `the total for ${path} changed from ${total} to ${chunk.total} during a paging read; ` +
            'the chunks may belong to different versions of the file',
        );
      }
      yield chunk;
      // Unreachable for a real answer: a Content-Range names at least one byte,
      // and toFileChunk refuses a 206 whose body does not fill the window it
      // names. Kept as the one thing standing between a future change there and
      // an unbounded request loop against the platform, which is the worst way
      // any of this could fail.
      if (chunk.bytes.length === 0) return;
      offset += chunk.bytes.length;
      if (remaining !== undefined) {
        remaining -= chunk.bytes.length;
        if (remaining <= 0) return;
      }
      if (offset >= total) return;
    }
  }

  /**
   * Write `data` to one file inside the guest, creating it if needed.
   *
   * A string is written as UTF-8. A `ReadableStream` is sent as the request
   * body so a large local file does not have to live as one Buffer first;
   * pass `contentLength` when you know it so the platform sees the size. It is
   * a stream's option: against a `Uint8Array` or a string the length is already
   * known here, and one that disagrees with it is refused rather than sent.
   * The path rules are {@link readFile}'s. The bytes land exactly as given —
   * this is how a credential reaches a guest `.env` without echoing it through
   * a shell command line.
   *
   * `timeoutMs` extends the client's per-request deadline for this one
   * transfer, as on {@link readFile}; `0` disables it.
   *
   * @returns how many bytes the platform says it wrote, or `undefined` if it
   * did not say. Not defaulted to what was sent: that would turn "it did not
   * say" into the affirmative claim that everything landed, which is the one
   * thing a caller checks this number to find out. Same reasoning as
   * {@link delete}'s undefined snapshot count.
   */
  async writeFile(
    path: string,
    data: Uint8Array | string | ReadableStream<Uint8Array>,
    opts: { timeoutMs?: number; contentLength?: number } & CallOptions = {},
  ): Promise<number | undefined> {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    // Validated before the header is formed: String(NaN) is "NaN", and Node
    // fetch then rejects the request as a connection failure rather than a
    // caller mistake. A custom fetch would send the malformed header.
    let headers: Record<string, string> | undefined;
    if (opts.contentLength != null) {
      if (!Number.isSafeInteger(opts.contentLength) || opts.contentLength < 0) {
        throw new ValidationError(
          `contentLength must be a non-negative whole number of bytes no larger than ${Number.MAX_SAFE_INTEGER} (got ${opts.contentLength})`,
        );
      }
      // A body already in hand has a length, and it is not a second opinion —
      // it is the number. Sending a different one is not a header disagreeing
      // with a header: undici frames the request with the CALLER's value, so
      // under-declaring hands the platform a prefix of the body and leaves the
      // rest of it desynchronising the connection (measured: the origin reads 5
      // of 20 bytes and the request ends in a 408), while over-declaring is
      // refused locally as a bare `TypeError: fetch failed`. Neither reaches the
      // caller as the mistake they made. The under-declared half is the one
      // that costs data rather than clarity: the platform streams this route
      // and carries the declared length through to the guest write, so exactly
      // that many bytes are written and answered 200 with a matching count —
      // the declaration and the body agree, and a truncated guest file is
      // reported as a complete write.
      //
      // A body whose size cannot be read off it is the only one the option is
      // for, and it is the only one that keeps the header unchecked. That set
      // is `bodyByteLength`'s, shared with the transport so the body this
      // client declines to measure is exactly the body it marks half-duplex —
      // the two questions are one and answering them separately gets one of
      // them wrong. Not `.length`, which an `ArrayBuffer` and a `Blob` do not
      // have even though undici sends both with a size it counts itself: read
      // off `.length` they would be waved through, and a caller who passed
      // `contentLength: 5` for twenty bytes gets five of them written and a 200
      // saying five, which is the truncation this check exists to stop.
      const sending = bodyByteLength(bytes);
      if (sending !== undefined && opts.contentLength !== sending) {
        throw new ValidationError(
          `contentLength is ${opts.contentLength} but the data is ${sending} bytes: ` +
            'the length is only worth passing for a ReadableStream, whose size cannot be read ' +
            'off the body',
        );
      }
      headers = { 'Content-Length': String(opts.contentLength) };
    }
    const res = await this.#t.json<{ bytes?: number } | undefined>(
      'PUT',
      P.computerAction(this.id, 'files'),
      {
        query: P.filesQuery(path),
        raw: bytes,
        headers,
        noTimeout: opts.timeoutMs === 0,
        minTimeoutMs: opts.timeoutMs,
        signal: opts.signal,
      },
    );
    return count(res?.bytes);
  }

  // --- snapshots ------------------------------------------------------

  /**
   * Capture a snapshot of this computer, and wait for it.
   *
   * Works while it is running. `memory: true` also captures live RAM and device
   * state, so a restore or fork resumes exactly where it was instead of booting
   * — the computer must be running for that, and the capture records the screen
   * resolution and the host's machine type, so it will only load onto a matching
   * one.
   *
   * `name` is worth giving. Snapshots outlive the computers they came from, and
   * an account's listing fills with generated names that say only when each was
   * taken — which is exactly the information a restore does not need. Omitted,
   * the platform generates one.
   *
   * THE REQUEST NO LONGER WAITS FOR THE CAPTURE; this method does. The route
   * answers **202** the moment the capture is accepted, with a placeholder row
   * in state `capturing` carrying the id the snapshot will keep (platform
   * OPL-4562). A capture is minutes and scales with how much has been written to
   * the disk, which is longer than an HTTP request survives. The POST ran on
   * this client's ordinary 60-second budget, which is less than the 119-124s the
   * smallest capture this platform will take was measured at three times over
   * (OPL-4561) — and widening that budget buys only until the proxy in front of
   * `app.mandala.computer` gives up at about two minutes, whatever the client
   * says (OPL-4563). A capture the client abandons is not cancelled: it finishes,
   * and before this change the caller never learned the id.
   *
   * So this polls `snapshots.list()` for that id and returns when the row stops
   * reading `capturing`. `pending` is where a finished capture lands and is the
   * point the snapshot can be restored, cloned or deleted; it is not waited for
   * BY NAME, because replication to backup storage can carry a small snapshot
   * on to `durable` between two polls and a loop watching for the literal string
   * would never match.
   *
   * RETURNING IS THE SNAPSHOT BEING USABLE, NOT THE COMPUTER BEING FREE. The
   * capture's claim on the COMPUTER is released only after the push to backup
   * storage — the step that makes the row `durable` — so a second capture of
   * this computer, and a {@link delete} that purges snapshots, are still
   * {@link ConflictError} until that finishes. Restoring, cloning and deleting
   * the snapshot itself work from `pending`.
   *
   * `wait: false` returns the placeholder instead, for a caller who would rather
   * hold the id and poll on their own schedule:
   *
   * ```ts
   * const held = await c.snapshot({ name: 'before-upgrade', wait: false });
   * held.capturing; // true — and held.id is already the final id
   * ```
   *
   * EVERY REFUSAL IS STILL SYNCHRONOUS and still carries the status it always
   * did: 404 for no such computer, {@link ConflictError} for a capture already
   * running or a disk still being copied, a plan limit for an allowance that
   * will not stretch, 400 for a memory snapshot of a computer that is not
   * running. A 202 means the capture started.
   *
   * Throws {@link MandalaError} if the capture FAILS. There is no response left
   * to carry that news by then, so the platform drops the `capturing` row and
   * stores nothing; the row disappearing is the whole signal, and it is the one
   * thing that tells a failed capture from one still running.
   *
   * Throws {@link TimeoutError} if the capture is still going when the timeout
   * runs out. The capture is not stopped by that, only the waiting is, and the
   * id in the message is the one to poll on. `timeoutMs` and `pollMs` are
   * checked before anything is captured, and whether or not `wait` is going to
   * use them: a number this refuses is a mistake in the CALL, and finding it
   * after a capture has started is finding it too late to be worth anything.
   */
  async snapshot(
    opts: { memory?: boolean; name?: string; wait?: boolean } & WaitOptions & CallOptions = {},
  ): Promise<Snapshot> {
    const { timeoutMs = SNAPSHOT_WAIT_MS, pollMs = SNAPSHOT_POLL_MS, signal } = opts;
    // Both before the POST, and both validated the way `memory` is: a `wait`
    // that is not a boolean is a DIFFERENT CALL from the one the caller wrote,
    // and the one it turns into leaves a capture running with nobody waiting on
    // it. See {@link P.flag}.
    const waitForIt = P.flag(opts.wait, 'wait') ?? true;
    checkWait(timeoutMs, pollMs);
    const path = P.computerAction(this.id, 'snapshots');
    const data = await this.#t.json<Record<string, unknown>>('POST', path, {
      body: P.snapshotBody(opts.memory, opts.name),
      signal,
    });
    // The id check stays AHEAD of both returns, which is where it already was
    // and where it matters more now. The id is the whole content of an accepted
    // capture — it is what a poll matches, and no route answers "the capture you
    // just started" — so a 202 without one is unusable to either caller, and the
    // one who asked not to wait is the worse off: handed something that looks
    // like a handle, cannot be polled, and leaving a snapshot billed for and
    // reachable only by guessing which row it is.
    if (!P.isRecord(data) || !data.id) {
      throw new MandalaError(`expected a snapshot from POST ${path}`);
    }
    const accepted = toSnapshot(data);
    // A row carrying a landed state this client can READ is a stored snapshot
    // and there is nothing to wait for — which is what a platform predating
    // OPL-4562 answers, having done the whole capture inside the request, and is
    // the honest reading of any future answer that arrives already landed.
    //
    // Read through {@link acceptedCapture} rather than off `accepted.capturing`,
    // and the two are deliberately not the same test: a state this client cannot
    // classify has to mean "wait" HERE and "landed" in the poll loop. See that
    // function — returning a placeholder unwaited is the whole of the bug this
    // change removes, and an omitted or renamed `state` would reinstate it in
    // silence.
    if (!waitForIt || !acceptedCapture(data)) return accepted;
    return this.#awaitCapture(accepted.id, timeoutMs, pollMs, signal);
  }

  /**
   * Poll the account's snapshots until this capture lands, fails, or runs out.
   *
   * The listing rather than a per-capture route, because there is no per-capture
   * route: `GET /snapshots` is where a capture in flight is visible, and the
   * dashboard's own panel polls exactly this.
   *
   * MATCHED ON THE ID, never on "the newest snapshot of this computer". The 202
   * hands over the id the snapshot will keep, so there is something exact to
   * match — and the guess it replaces is wrong precisely where it matters, since
   * a scheduled capture landing during a long manual one puts a stranger at the
   * front of a listing that has no account-wide ordering to read anything from
   * in any case.
   *
   * The raw `id` and strict equality, for the reason the move wait filters on
   * the raw row: `str()` is a coercion and `String(['snap-1'])` is `'snap-1'`,
   * so a coerced match would let a malformed row stand in for the capture and be
   * returned as the finished snapshot.
   *
   * Not filtered to this computer first. The id is unique across the account, so
   * such a filter could only ever remove the row that was asked for — and a
   * partial listing carries stubs with no `computer_id` at all, which is exactly
   * the shape that would then read as a capture that failed.
   *
   * ASKED WITHOUT `allow_partial`, which is what makes an absent row readable as
   * a failure: a host that did not answer is then a 503 this loop rides out,
   * rather than a short listing reported as a capture that died. The listing can
   * still come back short in the one way the platform cannot prevent — rows this
   * client could not decode — and on such a poll absence says nothing, since any
   * of those rows might have been this one.
   */
  async #awaitCapture(
    snapshotId: string,
    timeoutMs: number,
    pollMs: number,
    signal?: AbortSignal,
  ): Promise<Snapshot> {
    const deadline = Date.now() + timeoutMs;
    let polled = false;
    let delayMs = pollMs;
    // The LAST poll's, both of them, as in `waitForMove`: whether it read the
    // row still capturing, and whether it read a listing that was short and
    // did not carry the row. A poll that failed or was cut short read no
    // listing, so it clears both rather than letting a timeout describe a
    // listing from half an hour ago in the present tense.
    let stillCapturing = false;
    let shortLast = false;
    // Whether the row was EVER read, which the two above cannot say between
    // them: a wait that watched the capture for twenty minutes and then lost
    // the platform has something true to report that "it never appeared" is
    // not, and the two send a reader to different places.
    let everSeen = false;
    // Cumulative, and only for the sentence a timeout that never saw the row
    // ends with. `aborts` is kept apart from `failures` because a poll this
    // wait's own deadline cut short is not a poll the platform failed.
    let reads = 0;
    let failures = 0;
    let aborts = 0;
    for (;;) {
      if (Date.now() >= deadline) {
        throw new TimeoutError(
          captureTimeoutText({
            id: this.id,
            snapshotId,
            timeoutMs,
            stillCapturing,
            shortLast,
            everSeen,
            reads,
            failures,
            aborts,
          }),
        );
      }
      // The sleep comes before every poll but the first, as every other wait
      // here does it: a capture that landed while the caller was doing
      // something else is one round trip from being known to have landed.
      if (polled) await sleepUntilNextPoll(delayMs, deadline, signal);
      polled = true;
      delayMs = pollMs;
      if (Date.now() >= deadline) continue;
      try {
        const { items, incomplete } = await this.#t.listing(P.SNAPSHOTS, {
          signal: deadlineSignal(deadline - Date.now(), signal),
        });
        reads += 1;
        const row = items.find((d) => d.id === snapshotId);
        if (row) {
          const snap = toSnapshot(row);
          stillCapturing = snap.capturing;
          everSeen = true;
          shortLast = false;
          if (!snap.capturing) return snap;
          continue;
        }
        stillCapturing = false;
        // Absence is conclusive AT ONCE on a listing read in full, and the
        // platform is what makes it so. The capture is registered before the
        // 202 is answered, and `GET /v1/snapshots` reports in-flight captures
        // alongside stored rows, exactly once each — so a healthy capture is on
        // every listing from before the 202 until the snapshot itself is, with
        // no window between them. What is left is a row that has LEFT, which on this route
        // means one thing only: the capture failed and nothing was stored.
        // Spending the rest of a half-hour deadline to reach that same sentence
        // with less in it would be its own defect.
        //
        // A FAN-OUT, unlike the single computer-keyed table `waitForMove` fails
        // fast off, and that is what the `incomplete` test below is for rather
        // than an argument against failing fast at all (/code-review, OPL-4568).
        // The captures live in one hypervisor's memory, so a host that did not
        // answer would take this row with it — and the platform turns that
        // answer into a 503 for a caller who did not pass `allow_partial`, which
        // this poll deliberately does not. So a 200 with no shortfall is every
        // host having answered. The remaining shortfall is this client's own
        // undecodable rows, and that is what `incomplete` catches.
        //
        // `incomplete` DOES NOT CATCH ALL OF THEM (OPL-4587). A row whose `id`
        // is not a string is still a record, so it is kept and counted as
        // readable, and the strict match above — which is strict precisely so a
        // coerced `String(['snap-1'])` cannot stand in for this capture — cannot
        // match it either. The row is then missing from a listing this loop
        // believes it read whole, and the verdict below is reached over it: a
        // capture running normally reported as one that FAILED, about which the
        // caller is told there is nothing to find and nothing being billed.
        // Both false. See {@link unmatchableRows} — it is the same shortfall,
        // found in the one place `incomplete` cannot look, and it reads the
        // same way.
        if (incomplete === null && unmatchableRows(items, 'id') === 0) {
          throw new MandalaError(captureFailed(this.id, snapshotId));
        }
        shortLast = true;
      } catch (err) {
        if (signal?.aborted) throw err;
        // This wait's own timer firing inside a poll, which is not a failed
        // poll — `aborts` is counted apart for that reason. Both of the last
        // poll's readings still go, because a poll cut short read no listing at
        // all, and a timeout that quotes one from half an hour ago writes it in
        // the present tense. `everSeen` stays: it is a fact about the whole
        // wait rather than about the poll that just ended.
        if (isDeadlineAbort(err)) {
          aborts += 1;
          stillCapturing = false;
          shortLast = false;
          continue;
        }
        if (!isTransientForPoll(err)) throw err;
        stillCapturing = false;
        shortLast = false;
        failures += 1;
        delayMs = retryDelay(pollMs, err);
      }
    }
  }

  /**
   * How many snapshots this computer has, what they weigh, and the fingerprint
   * that names that exact set (OPL-3636).
   *
   * Read this before purging with {@link delete}: the fingerprint is what binds
   * the purge to the snapshots you were shown, so one that arrived after you
   * looked cannot be swept up in it. It cannot be reconstructed from a listing.
   *
   * This is **not** a listing of the snapshots themselves — for that, filter
   * `client.snapshots.list({ computerId })`.
   */
  async holdings(opts: CallOptions = {}): Promise<Holdings> {
    const path = P.computerAction(this.id, 'snapshots');
    const data = await this.#t.json<Record<string, unknown>>('GET', path, { signal: opts.signal });
    if (!P.isRecord(data) || !Object.keys(data).length) {
      throw new MandalaError(`expected snapshot holdings from GET ${path}`);
    }
    return toHoldings(data);
  }

  /** The automatic daily snapshot schedule. */
  async schedule(opts: CallOptions = {}): Promise<Schedule> {
    const data = await this.#t.json<Record<string, unknown>>(
      'GET',
      P.computerAction(this.id, 'schedule'),
      { signal: opts.signal },
    );
    // Guarded the way refresh() guards its own payload. An empty body decodes
    // to "disabled, midnight UTC" — a schedule this computer may never have
    // had, and indistinguishable from one it really has — which turns "the
    // platform did not answer" into a reading. clearSchedule below is the one
    // route where an empty body is a real answer, and it says so there.
    if (!P.isRecord(data) || !Object.keys(data).length) {
      throw new MandalaError(
        `expected a schedule from GET ${P.computerAction(this.id, 'schedule')}`,
      );
    }
    return toSchedule(data);
  }

  /** Set the automatic daily snapshot window, in the given IANA timezone. */
  async setSchedule(
    args: {
      enabled: boolean;
      hour?: number;
      minute?: number;
      tz?: string;
    },
    opts: CallOptions = {},
  ): Promise<Schedule> {
    const body = P.scheduleBody(args);
    const data = await this.#t.json<Record<string, unknown>>(
      'PUT',
      P.computerAction(this.id, 'schedule'),
      { body, signal: opts.signal },
    );
    // What was asked for, when the platform acknowledges with no body. It
    // applied this and said so with a 2xx; echoing it beats decoding `{}` into
    // a midnight nobody chose.
    return toSchedule(P.isRecord(data) && Object.keys(data).length ? data : body);
  }

  /**
   * Remove the schedule, as distinct from disabling it.
   *
   * `setSchedule({ enabled: false })` keeps the chosen time so toggling back on
   * restores it, and keeps the scheduler's bookkeeping with it. Clearing returns
   * the computer to never having had a schedule.
   */
  async clearSchedule(opts: CallOptions = {}): Promise<Schedule> {
    const data = await this.#t.json<Record<string, unknown>>(
      'DELETE',
      P.computerAction(this.id, 'schedule'),
      { signal: opts.signal },
    );
    // `{}` is a real answer here, and the only route where it is: a cleared
    // schedule has no window, and "disabled" with an hour nobody chose is the
    // closest this type can come to saying so. That licence is for an EMPTY
    // BODY and nothing else — an array or a scalar reached toSchedule, which
    // read enabled/hour/minute/tz off it, got undefined for every one and
    // fabricated the same "disabled, midnight UTC" with the garbage spread into
    // `raw`. So a non-object is dropped for `{}` — the empty body's meaning,
    // not the body's. Its two siblings refuse a shape they cannot read, and are
    // right to: they READ a state, so a body they cannot parse means they do
    // not know it. This one CONFIRMS an operation the DELETE already answered
    // 2xx to, and "there is no schedule now" is true whatever the body said —
    // refusing would fail a working call against a platform that acknowledges
    // with `"cleared"` or `[]`, and learn nothing by it.
    return toSchedule(P.isRecord(data) ? data : {});
  }

  // --- the agent loop -------------------------------------------------

  /**
   * Have the platform drive this computer until the task is done (OPL-3567).
   *
   * Screenshot, decide, click, type, repeat — inside the platform, on your own
   * Anthropic key, which it never stores. Use it to delegate a long stretch of
   * pixel work: ten clicks stop being ten images in your context.
   *
   * The computer must already be running.
   *
   * ```ts
   * const result = await c.agent({
   *   prompt: 'Open the settings and turn on dark mode.',
   *   modelKey: process.env.ANTHROPIC_API_KEY!,
   * });
   * if (!result.finished) console.warn(`did not finish: ${result.stop}`);
   * ```
   *
   * Throws `MandalaError` if the stream ends without a result. It does **not**
   * throw when a run ends unfinished: `max_steps`, `rate_limited` and `refusal`
   * leave real work on the desktop, and discarding the result would discard the
   * only account of what was done to the machine. Check
   * {@link AgentResult.finished}.
   */
  async agent(args: AgentArgs): Promise<AgentResult> {
    // Named here as well, though agentStream checks the same argument a line
    // later: it would name ITSELF, and this is the method the caller called.
    // agentOnce below does the same thing for the same reason.
    requireModelKey(args.modelKey, 'agent()');
    for await (const ev of this.agentStream(args)) {
      if (ev.type === 'done') {
        // A done event is terminal even if a proxy or server leaves the SSE
        // response open for heartbeats. Returning also cancels the reader in
        // Transport.sse's finally block.
        return ev.result;
      }
      if (ev.type === 'error') {
        // Stop consuming immediately. The stream has no request deadline, so a
        // server that reports an error and then stays open must not keep the
        // caller waiting forever. Returning from the generator also cancels
        // the response reader in Transport.sse's finally.
        const message = `the agent run failed: ${ev.error}`;
        throw ev.status ? errorForEventStatus(ev.status, message) : new MandalaError(message);
      }
    }
    throw new MandalaError('the agent stream ended without a result');
  }

  /**
   * {@link agent}, as a stream of events you can report on while it runs.
   *
   * A run is minutes of clicking, and something that says nothing until it is
   * over cannot be told from a hang.
   *
   * ```ts
   * for await (const ev of c.agentStream({ prompt, modelKey })) {
   *   if (ev.type === 'step') console.log(`${ev.step.n}. ${ev.step.detail}`);
   *   if (ev.type === 'done') console.log(ev.result.text);
   * }
   * ```
   *
   * Events this SDK does not model are skipped rather than thrown on — the
   * platform is free to add types, and falling over on the first unrecognised
   * one would turn a forward-compatible addition into an outage.
   */
  agentStream(args: AgentArgs): AsyncGenerator<AgentEvent> {
    // A plain method wrapping an inner generator, rather than `async *` with
    // the check in its body. A generator's body does not run until the first
    // next(), so `const s = c.agentStream({ prompt })` with no key SUCCEEDED
    // and the refusal surfaced wherever the stream was eventually consumed —
    // possibly in another function, possibly never. Every other local refusal
    // in this SDK happens where the mistake was made, and this is what it costs
    // to keep that true here. The name is passed too: it read `agent()`, about
    // a method the caller had not called.
    const modelKey = requireModelKey(args.modelKey, 'agentStream()');
    return this.#agentStream(args, modelKey);
  }

  async *#agentStream(args: AgentArgs, modelKey: string): AsyncGenerator<AgentEvent> {
    let steps = 0;
    for await (const raw of this.#t.sse('POST', P.computerAction(this.id, 'agent'), {
      body: P.agentBody({
        prompt: args.prompt,
        stream: true,
        system: args.system,
        maxSteps: args.maxSteps,
        model: args.model,
      }),
      headers: { [MODEL_KEY_HEADER]: modelKey },
      signal: args.signal,
    })) {
      const ev = toAgentEvent(raw.event, raw.data, steps);
      if (!ev) continue;
      if (ev.type === 'step') steps += 1;
      yield ev;
      // Both frames are terminal. Do not wait for a proxy or platform that
      // leaves the response open for heartbeats after announcing the outcome.
      // Returning also closes Transport.sse and cancels its response reader.
      if (ev.type === 'done' || ev.type === 'error') return;
    }
  }

  /**
   * The agent loop, without streaming — one request, one result.
   *
   * Simpler than {@link agent} and worse for anything long: nothing is reported
   * until the whole run is over, and a reverse proxy between you and the
   * platform may well close a request held open for minutes. Prefer
   * {@link agent} unless you specifically need a single non-streaming call.
   */
  async agentOnce(args: AgentArgs): Promise<AgentResult> {
    const modelKey = requireModelKey(args.modelKey, 'agentOnce()');
    const data = await this.#t.json<Record<string, unknown>>(
      'POST',
      P.computerAction(this.id, 'agent'),
      {
        body: P.agentBody({
          prompt: args.prompt,
          stream: false,
          system: args.system,
          maxSteps: args.maxSteps,
          model: args.model,
        }),
        headers: { [MODEL_KEY_HEADER]: modelKey },
        signal: args.signal,
        // One held request for a run that is minutes of clicking — the same
        // exemption the streaming route gets, for the same reason. The
        // ordinary deadline would end every run over a minute at exactly the
        // same place. A caller's own signal is what stops one early.
        noTimeout: true,
      },
    );
    if (!P.isRecord(data) || data.stop == null) {
      throw new MandalaError(
        `expected an agent result from POST ${P.computerAction(this.id, 'agent')}`,
      );
    }
    return toAgentResult(data);
  }
}

/**
 * The sentence a machine that outlived its block is reported with.
 *
 * One function because there are two spellings of the feature and they must not
 * differ here. The `await using` spelling throws this out of the disposer below
 * and the runtime hangs it on `SuppressedError.error`; the callback spelling in
 * `Computers.ephemeral` builds the identical error for the identical field. A
 * caller who logs `err.error.message` gets the id either way, which is the only
 * thing on this path that costs money — and the top-level `.message` cannot be
 * that place, because the runtime writes its own generic text over it.
 */
export const strandedText = (id: string, err: unknown): string =>
  `${id} was not deleted at the end of its block and is still billable: ` +
  `${err instanceof Error ? err.message : String(err)}`;

/**
 * A computer that deletes itself at the end of the block.
 *
 * What `client.computers.ephemeral()` returns. Never constructed directly, and
 * never returned from anything else: `Symbol.asyncDispose` destroys a disk, and
 * putting it on the ordinary handle would make `await using c = await
 * client.computers.get(id)` silently delete somebody's machine.
 */
export class EphemeralComputer extends Computer {
  async [Symbol.asyncDispose](): Promise<void> {
    try {
      await this.delete();
    } catch (err) {
      // A 404 is the goal state already reached: the block deleted the
      // machine itself (the documented way to purge snapshots), and nothing
      // is billable or worth reporting.
      if (err instanceof NotFoundError) return;
      // Loud, and with the id: a machine that outlives its block is billable
      // until somebody finds it, and a swallowed failure here mentions it to
      // no one. When the block itself also threw, the runtime keeps that error
      // too — it arrives as SuppressedError.suppressed rather than being
      // replaced by this one, and THIS error arrives as SuppressedError.error.
      throw new MandalaError(strandedText(this.id, err));
    }
  }
}
