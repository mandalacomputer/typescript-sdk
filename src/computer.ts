/** The Computer handle — a cloud desktop and everything you can do to it. */

import {
  type AgentArgs,
  type AgentEvent,
  type AgentResult,
  toAgentEvent,
  toAgentResult,
} from './agent.js';
import {
  APIError,
  errorForEventStatus,
  isTransient,
  MandalaError,
  NotFoundError,
  RangeNotSatisfiableError,
  TimeoutError,
  TooLargeError,
  ValidationError,
} from './errors.js';
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
} from './models.js';
import {
  count,
  num,
  said,
  toBackgroundExec,
  toExecResult,
  toGuestWindow,
  toHoldings,
  toMove,
  toSchedule,
  toSnapshot,
  toVncConnect,
} from './models.js';
import * as P from './paths.js';
import type { CallOptions } from './resources.js';
import { type Bytes, MODEL_KEY_HEADER, type Query, type Transport } from './transport.js';
import {
  checkWait,
  deadlineSignal,
  isDeadlineAbort,
  isPermanent,
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
 * A failure no amount of waiting will clear.
 *
 * The wait helpers poll through anything that might resolve on its own — a 409
 * while the guest agent comes up, a 503 from a host that cannot be reached — and
 * stop at these. A revoked key is not going to become valid three minutes from
 * now, and reporting it as a timeout names the wrong problem.
 */
/** Trim and refuse a missing Anthropic key before it becomes an empty header. */
const requireModelKey = (key: string | undefined, what: string): string => {
  const trimmed = key?.trim() ?? '';
  if (!trimmed) {
    throw new MandalaError(
      `${what} needs your own Anthropic API key as modelKey — the platform does not store one.`,
    );
  }
  return trimmed;
};

export type { WaitOptions } from './wait.js';

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

  get id(): string {
    return String(this.#data.id ?? '');
  }

  get name(): string {
    return String(this.#data.name ?? '');
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
    return String(this.#data.status ?? '');
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
    return this.status === 'suspended';
  }

  /** When this computer's session was saved, or `''` if it is not saved. */
  get suspendedAt(): string {
    const s = this.#data.suspended;
    return P.isRecord(s) ? String(s.at ?? '') : '';
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
    return String(this.#data.start_error ?? '');
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
    return this.status === 'building';
  }

  /**
   * True if this computer's disk copy never finished.
   *
   * It exists, is listed, holds whatever the copy got through, and has no usable
   * disk. Nothing will fix it on its own: delete it and clone again.
   */
  get buildFailed(): boolean {
    return this.status === 'build-failed';
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
    return P.isRecord(b) ? String(b.failed ?? '') : '';
  }

  get os(): string {
    return String(this.#data.os ?? '');
  }

  get template(): string {
    return String(this.#data.template ?? '');
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

  get diskGb(): number {
    return num(this.#data.disk_gb);
  }

  /**
   * The screen this computer renders at, as `"WIDTHxHEIGHTxDEPTH"`.
   *
   * This is the coordinate space every pointer method and every screenshot is
   * in. Read it rather than assuming 1280x800: since resolution became a
   * create-time choice, assuming makes every click land proportionally short on
   * any computer that asked for something else.
   */
  get resolution(): string {
    return String(this.#data.resolution || DEFAULT_RESOLUTION);
  }

  /**
   * {@link resolution} as `{ width, height }`, for arithmetic.
   *
   * What the computer-use tool definition wants — `display_width_px` and
   * `display_height_px` have to equal what screenshots actually are, or the
   * model's coordinates are wrong.
   */
  get screen(): { width: number; height: number } {
    const [w, h] = this.resolution.split('x').map(Number);
    if (!w || !h || !Number.isFinite(w) || !Number.isFinite(h)) {
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

  get createdAt(): string {
    return String(this.#data.created_at ?? '');
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
   */
  async start(opts: CallOptions = {}): Promise<this> {
    return this.#power('start', opts);
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

  async #power(action: string, opts: CallOptions = {}, query?: Query): Promise<this> {
    // The platform answers a power action with the computer, so this is one
    // round trip where the Python SDK spends two. Guarded anyway: a platform
    // that answered 204 would otherwise leave a handle reporting the state the
    // machine was in before the call.
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
   * behind it; {@link waitForMove} is the other half. One move runs per account
   * at a time.
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
    return toMove(data);
  }

  /**
   * Wait for this computer's move to stop running, and answer what happened.
   *
   * Polls the account's moves and picks out this computer's. It does NOT throw
   * for a move that ended badly, and that is the decision worth knowing: the
   * three failures are three different situations with three different remedies
   * — see {@link Move.state} — and collapsing them into one thrown error is
   * exactly how `moved`, where the computer HAS changed hardware, gets read as
   * "nothing happened". Read `state`.
   *
   * Throws {@link TimeoutError} if the move is still going when the timeout runs
   * out. The move is not stopped by that; only the waiting is, and there is no
   * cancelling a disk crossing between two hosts in any case.
   *
   * Throws {@link MandalaError} if the move stops being listed, which happens
   * when the computer is deleted — the platform reaps the row with it.
   *
   * The default timeout is generous because the work is: a small overlay crosses
   * in seconds and a full Windows disk takes minutes, plus minutes more when the
   * target has to be sent the image this computer was built from first.
   */
  async waitForMove(opts: WaitOptions = {}): Promise<Move> {
    const { timeoutMs = 900_000, pollMs = 3_000, signal } = opts;
    checkWait(timeoutMs, pollMs);
    const deadline = Date.now() + timeoutMs;
    let polled = false;
    let delayMs = pollMs;
    let last: Move | undefined;
    for (;;) {
      if (Date.now() >= deadline) {
        throw new TimeoutError(
          last
            ? `${this.id} was still moving after ${timeoutMs}ms (state ${last.state}; ` +
                'the move has not stopped, only this wait has)'
            : `${this.id}'s move could not be observed within ${timeoutMs}ms: every poll failed`,
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
        const rows = P.isRecord(moves) && Array.isArray(moves.moves) ? moves.moves : [];
        const mine = rows
          .filter(P.isRecord)
          .map(toMove)
          .find((m) => m.computerId === this.id);
        // A move that is no longer listed is one the platform reaped, and it
        // reaps for one reason: the computer is gone. Not a state to keep
        // polling for — and distinguishable from "not started yet" because this
        // is only reached after a move was accepted.
        if (!mine) {
          throw new MandalaError(
            `${this.id} has no move any more; the platform reaps one when its computer is deleted`,
          );
        }
        last = mine;
        if (!mine.live) return mine;
      } catch (err) {
        if (signal?.aborted) throw err;
        // Named rather than inferred from the clock. See the note in
        // waitUntilRunning: `AbortSignal.timeout` can fire a millisecond before
        // `Date.now()` reaches the deadline, and this loop then rethrew its own
        // deadline as if the platform had failed.
        if (!isDeadlineAbort(err) && !isTransient(err)) throw err;
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
    let polled = false;
    let delayMs = pollMs;
    for (;;) {
      if (this.buildFailed) throw this.#buildFailure();
      if (!this.isBuilding) return this;
      if (Date.now() >= deadline) {
        throw new TimeoutError(
          observed || !polled
            ? `${this.id} was still building after ${timeoutMs}ms ` +
                '(it has not stopped; only this wait has)'
            : `${this.id} could not be observed within ${timeoutMs}ms: every refresh failed`,
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
          if (!isDeadlineAbort(err) && !isTransient(err)) throw err;
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
   * session nobody has resumed.
   */
  async waitUntilRunning(opts: WaitOptions = {}): Promise<this> {
    const { timeoutMs = 120_000, pollMs = 2_000, signal } = opts;
    checkWait(timeoutMs, pollMs);
    const deadline = Date.now() + timeoutMs;
    // A create may return a stopped computer and the reason its first start
    // failed. refresh() correctly clears that one-attempt field, so retain it
    // for the failure this wait is about before the first poll replaces it.
    const initialStartError = this.startError;
    // Success is a verdict, and no verdict is reached on state observed before
    // this call: when every refresh fails transiently, the handle may be
    // holding data from an old list(), and "running" concluded from that —
    // while the host answers 503 — is a claim about a machine nobody has
    // actually looked at. The fail-fast throws below are NOT gated the same
    // way: neither a failed build nor a suspended session becomes "running" on
    // its own, so acting on the last data anyone has beats spinning out the
    // full timeout to learn the same thing — and the data may be fresh from a
    // get() one line before this call.
    let observed = false;
    for (;;) {
      let delayMs = pollMs;
      // Guarded rather than unconditional, so the sleep at the bottom of the
      // loop cannot hand the clock to a poll with no time left to read it.
      if (Date.now() < deadline) {
        try {
          // What is left of this wait, and not the client's own per-request
          // deadline: a wait told to give up after five seconds must not spend
          // another sixty inside a refresh it has stopped waiting for.
          await this.refresh({ signal: deadlineSignal(deadline - Date.now(), signal) });
          observed = true;
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
          if (!isDeadlineAbort(err) && !isTransient(err)) throw err;
          delayMs = retryDelay(pollMs, err);
        }
      }
      if (observed && this.status === 'running') return this;
      // A computer with no disk will never start on its own, and waiting out
      // the full timeout to say so helps nobody.
      if (this.buildFailed) throw this.#buildFailure();
      // Stopped is stable just like suspended: neither state progresses to
      // running without a start request. In particular, a create that returned
      // start_error used to lose that explanation on refresh and poll until the
      // full timeout while repeatedly observing the same stopped state.
      if (this.status === 'stopped') {
        const reason = this.startError || initialStartError;
        throw new MandalaError(
          reason
            ? `${this.id} is stopped after it failed to start: ${reason}. Call start() to try again`
            : `${this.id} is stopped and will not start on its own: call start() to start it`,
        );
      }
      // Nor will a suspended one. Left to spin it reports a machine that is
      // one call from running as a timeout — the least informative answer
      // available about the one case the caller can fix in a line.
      if (this.isSuspended) {
        throw new MandalaError(
          `${this.id} is suspended and will not start on its own: call start() to resume it`,
        );
      }
      if (Date.now() >= deadline) {
        // "was still X" is only claimed about a status this wait actually saw;
        // a handle nobody could refresh reports the refreshes, not the status.
        throw new TimeoutError(
          observed
            ? `${this.id} was still ${JSON.stringify(this.status)} after ${timeoutMs}ms`
            : `${this.id} could not be observed within ${timeoutMs}ms: every refresh failed`,
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
   * Throws rather than waiting out the timeout on a failed build, which nothing
   * inside will ever answer from. A *suspended* computer is not refused here,
   * unlike in {@link waitUntilRunning}: running a command resumes one, so the
   * probe both wakes the machine and gets its answer — which is a side effect
   * worth knowing about on a wait that reads as passive.
   */
  async waitForGuest(opts: WaitOptions = {}): Promise<this> {
    const { timeoutMs = 180_000, pollMs = 3_000, signal } = opts;
    checkWait(timeoutMs, pollMs);
    const deadline = Date.now() + timeoutMs;
    // A clone may be handed straight to this wait. There is no guest to probe
    // until its disk copy finishes, and only a state refresh can discover that
    // the copy failed while we were waiting.
    if (this.isBuilding) {
      await this.waitUntilBuilt({
        timeoutMs: Math.max(deadline - Date.now(), 0),
        pollMs,
        signal,
      });
    }
    for (;;) {
      let delayMs = pollMs;
      // Nothing inside a computer with no disk is ever going to answer, and
      // spending three minutes to say so helps nobody — waitUntilRunning's
      // rule, for its reason. Read off the handle rather than through a fresh
      // GET, because this wait probes the guest and never refreshes: what it
      // has is what the create, clone or get that produced this handle saw.
      if (this.buildFailed) throw this.#buildFailure();
      if (Date.now() < deadline) {
        try {
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
          // Everything else is polled through: a 409 means the agent is not up
          // yet, a 503 means its host could not be reached, and a guest agent that
          // is merely slow answers 502 for the first seconds of a boot. Those are
          // what this loop is for. A revoked key is not.
          if (isPermanent(err)) throw err;
          // Nor is a caller who cancelled. The wait's own deadline firing inside
          // a probe is not caught here — that is this loop ending, and the check
          // below is what names it.
          if (signal?.aborted) throw err;
          // The guest can answer 502 for the first seconds of a boot. Everything
          // else retried here is one of the same typed transient failures as the
          // two refresh-based waits; a malformed request must not be disguised as
          // three minutes of guest unavailability.
          if (
            Date.now() < deadline &&
            !(isTransient(err) || (err instanceof APIError && err.status === 502))
          ) {
            throw err;
          }
          delayMs = retryDelay(pollMs, err);
        }
      }
      if (Date.now() >= deadline) {
        throw new TimeoutError(`${this.id} guest did not respond within ${timeoutMs}ms`);
      }
      await sleepUntilNextPoll(delayMs, deadline, signal);
    }
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
   */
  async windows(opts: { includeAll?: boolean } & CallOptions = {}): Promise<GuestWindow[]> {
    const data = await this.#t.jsonArray('GET', P.computerAction(this.id, 'windows'), {
      query: { include: P.flag(opts.includeAll, 'includeAll') ? 'all' : undefined },
      signal: opts.signal,
    });
    return data.filter(P.isRecord).map(toGuestWindow);
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
   */
  async windowAction(
    windowId: string,
    action: P.WindowAction,
    geometry: { x?: number; y?: number; width?: number; height?: number } = {},
    opts: CallOptions = {},
  ): Promise<GuestWindow> {
    const path = P.windowPath(this.id, windowId);
    const data = await this.#t.json<Record<string, unknown>>('POST', path, {
      body: P.windowBody({ action, ...geometry }),
      signal: opts.signal,
    });
    if (!P.isRecord(data) || !data.id) {
      throw new MandalaError(`expected a window from POST ${path}`);
    }
    return toGuestWindow(data);
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
    const keys = first == null ? [] : spread ? [first, ...(rest as string[])] : [...first];
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
   * and at 125.3s with `timeoutS: 3600`: the ceiling belongs to a hop that never
   * saw the argument, so raising it buys nothing. The command survives the
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
    const data = await this.#t.json<Record<string, unknown>>(
      'POST',
      P.computerAction(this.id, 'exec'),
      {
        body: P.execBody({ command, timeoutS, desktop, cwd, env }),
        // The guest was just granted timeoutS to finish, so the HTTP request
        // has to outlive that. Under the fixed client deadline alone, any
        // timeoutS past it was guaranteed to be aborted client-side while the
        // command ran on in the guest with its output unreachable.
        minTimeoutMs: (timeoutS + 30) * 1_000,
        signal: opts.signal,
      },
    );
    return toExecResult(data ?? {});
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
    const data = await this.#t.json<Record<string, unknown>>(
      'POST',
      P.computerAction(this.id, 'exec'),
      {
        body: P.execBody({
          command,
          background: true,
          desktop: opts.desktop,
          cwd: opts.cwd,
          env: opts.env,
        }),
        signal: opts.signal,
      },
    );
    return toBackgroundExec(data ?? {});
  }

  /**
   * What a backgrounded command has printed since the last poll, and whether it
   * has finished.
   *
   * The output is a **cursor, not a buffer**: each poll gives you only the new
   * bytes, so two readers on one pid split the output between them rather than
   * each seeing all of it. When {@link BackgroundExec.more} is set there is
   * further output waiting — poll again straight away.
   */
  async execPoll(pid: number, opts: CallOptions = {}): Promise<BackgroundExec> {
    const data = await this.#t.json<Record<string, unknown>>('GET', P.execHandle(this.id, pid), {
      signal: opts.signal,
    });
    return toBackgroundExec(data ?? {});
  }

  /**
   * Kill a backgrounded command and everything it started.
   *
   * Answers with its final state, including whatever it printed that you had not
   * read.
   */
  async execKill(pid: number, opts: CallOptions = {}): Promise<BackgroundExec> {
    const data = await this.#t.json<Record<string, unknown>>('DELETE', P.execHandle(this.id, pid), {
      signal: opts.signal,
    });
    return toBackgroundExec(data ?? {});
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
   * Linux only, and refused rather than attempted on a Windows guest: the
   * command it sends is a POSIX one, and cmd.exe answering "'nohup' is not
   * recognized" through an ExecResult reads as anything but what went wrong.
   */
  async open(url: string, opts: { timeoutS?: number } & CallOptions = {}): Promise<ExecResult> {
    if (this.os === 'windows') {
      throw new MandalaError(
        `open() is Linux-only for now: ${this.id} runs Windows. ` +
          'Use exec() with a Windows launch command instead.',
      );
    }
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

    for (let first = true; ; first = false) {
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
        if (!first) {
          throw new MandalaError(
            `asked ${path} for bytes from ${offset} and was answered with the whole file; ` +
              'a paging read cannot go on from that',
          );
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
   * pass `contentLength` when you know it so the platform sees the size.
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
   * Capture a snapshot of this computer.
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
   */
  async snapshot(opts: { memory?: boolean; name?: string } & CallOptions = {}): Promise<Snapshot> {
    const path = P.computerAction(this.id, 'snapshots');
    const data = await this.#t.json<Record<string, unknown>>('POST', path, {
      body: P.snapshotBody(opts.memory, opts.name),
      signal: opts.signal,
    });
    if (!P.isRecord(data) || !data.id) {
      throw new MandalaError(`expected a snapshot from POST ${path}`);
    }
    return toSnapshot(data);
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
    // closest this type can come to saying so.
    return toSchedule(data ?? { enabled: false });
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
  async *agentStream(args: AgentArgs): AsyncGenerator<AgentEvent> {
    const modelKey = requireModelKey(args.modelKey, 'agent()');
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
      // replaced by this one.
      throw new MandalaError(
        `${this.id} was not deleted at the end of its block and is still billable: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
