/** The Computer handle — a cloud desktop and everything you can do to it. */

import {
  type AgentArgs,
  type AgentEvent,
  type AgentResult,
  toAgentEvent,
  toAgentResult,
} from './agent.js';
import {
  AuthenticationError,
  isTransient,
  MandalaError,
  NotFoundError,
  PermissionDeniedError,
  PlanLimitError,
  TimeoutError,
} from './errors.js';
import type {
  BackgroundExec,
  ExecResult,
  GuestWindow,
  Holdings,
  Point,
  Schedule,
  Snapshot,
  VncConnect,
} from './models.js';
import {
  toBackgroundExec,
  toExecResult,
  toGuestWindow,
  toHoldings,
  toSchedule,
  toSnapshot,
  toVncConnect,
} from './models.js';
import * as P from './paths.js';
import { MODEL_KEY_HEADER, type Transport } from './transport.js';

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
const isPermanent = (err: unknown): boolean =>
  err instanceof AuthenticationError ||
  err instanceof PermissionDeniedError ||
  err instanceof NotFoundError ||
  err instanceof PlanLimitError;

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true },
    );
  });

export type WaitOptions = {
  /** Milliseconds before giving up. */
  timeoutMs?: number;
  /** Milliseconds between polls. */
  pollMs?: number;
  signal?: AbortSignal;
};

export type ScrollOptions = {
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
};

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

  /** Why the disk copy failed, or `''` if it did not. */
  get buildError(): string {
    const b = this.#data.build;
    return P.isRecord(b) ? String(b.failed ?? b.source ?? '') : '';
  }

  get os(): string {
    return String(this.#data.os ?? '');
  }

  get template(): string {
    return String(this.#data.template ?? '');
  }

  get cpu(): number {
    return Number(this.#data.cpu ?? 0);
  }

  get ramMb(): number {
    return Number(this.#data.ram_mb ?? 0);
  }

  get diskGb(): number {
    return Number(this.#data.disk_gb ?? 0);
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
    const v = this.#data.idle_suspend_min;
    return v == null ? undefined : Number(v);
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
    return { ...this.#data };
  }

  toJSON(): Record<string, unknown> {
    return this.raw;
  }

  // --- lifecycle ------------------------------------------------------

  /**
   * Re-read this computer's state from the API.
   *
   * Also how a computer from `computers.list()` acquires a {@link vnc} connect
   * surface, which the list deliberately omits.
   */
  async refresh(): Promise<this> {
    this.#data = P.computerPayload(await this.#t.json('GET', P.computer(this.id)));
    return this;
  }

  /**
   * Start this computer, or resume it if its session was suspended.
   *
   * A suspended computer does not boot: its saved RAM is read back and the same
   * processes and windows come up roughly a second later.
   */
  async start(): Promise<this> {
    return this.#power('start');
  }

  /**
   * Stop this computer, discarding a suspended session if it has one.
   *
   * Use {@link suspend} to keep it.
   */
  async stop(): Promise<this> {
    return this.#power('stop');
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
  async suspend(): Promise<this> {
    return this.#power('suspend');
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
  async restart(): Promise<this> {
    return this.#power('restart');
  }

  async #power(action: string): Promise<this> {
    // The platform answers a power action with the computer, so this is one
    // round trip where the Python SDK spends two. Guarded anyway: a platform
    // that answered 204 would otherwise leave a handle reporting the state the
    // machine was in before the call.
    const data = P.computerPayload(await this.#t.json('POST', P.computerAction(this.id, action)));
    if (data.id) {
      this.#data = data;
      return this;
    }
    return this.refresh();
  }

  /**
   * Copy this computer into a new one. The source must be stopped.
   *
   * Returns as soon as the new computer exists, which is before its disk does:
   * copying a disk runs for minutes, so the clone comes back `"building"` and
   * fills in behind you. Follow with {@link waitUntilBuilt} before starting it.
   */
  async clone(name?: string): Promise<Computer> {
    const data = await this.#t.json('POST', P.computerAction(this.id, 'clone'), {
      body: P.nameBody(name),
    });
    return new Computer(this.#t, P.computerPayload(data));
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
  async update(args: P.UpdateArgs): Promise<this> {
    this.#data = P.computerPayload(
      await this.#t.json('PATCH', P.computer(this.id), { body: P.updateBody(args) }),
    );
    return this;
  }

  /** Give this computer a new name. Sugar over {@link update}. */
  async rename(name: string): Promise<this> {
    return this.update({ name });
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
      { query: P.deleteQuery(opts) },
    );
    return res?.snapshots_deleted;
  }

  // --- readiness ------------------------------------------------------

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
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.buildFailed) {
        throw new MandalaError(
          `${this.id} could not be built: ${this.buildError || 'the disk copy failed'}`,
        );
      }
      if (!this.isBuilding) return this;
      if (Date.now() >= deadline) {
        throw new TimeoutError(
          `${this.id} was still building after ${timeoutMs}ms ` +
            '(it has not stopped; only this wait has)',
        );
      }
      await sleep(pollMs, signal);
      await this.refresh();
    }
  }

  /**
   * Wait until the machine is running.
   *
   * This is the *machine*, not the desktop: it returns as soon as the VM is up,
   * while the guest OS is still booting. Use {@link waitForGuest} when you need
   * something inside the guest to be ready.
   *
   * Throws rather than waiting out the timeout for the two states that will not
   * become "running" on their own — a failed build, and a suspended session
   * nobody has resumed.
   */
  async waitUntilRunning(opts: WaitOptions = {}): Promise<this> {
    const { timeoutMs = 120_000, pollMs = 2_000, signal } = opts;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        await this.refresh();
      } catch (err) {
        // A host that cannot be reached answers 503, which is the ordinary
        // weather of a machine still coming up. Letting it out would abort the
        // one method whose whole job is to keep asking. Anything else — a
        // revoked key, a computer that is gone — is not weather.
        if (!isTransient(err)) throw err;
      }
      if (this.status === 'running') return this;
      // A computer with no disk will never start on its own, and waiting out
      // the full timeout to say so helps nobody.
      if (this.buildFailed) {
        throw new MandalaError(
          `${this.id} could not be built: ${this.buildError || 'the disk copy failed'}`,
        );
      }
      // Nor will a suspended one. Left to spin it reports a machine that is one
      // call from running as a timeout — the least informative answer available
      // about the one case the caller can fix in a line.
      if (this.isSuspended) {
        throw new MandalaError(
          `${this.id} is suspended and will not start on its own: call start() to resume it`,
        );
      }
      if (Date.now() >= deadline) {
        throw new TimeoutError(
          `${this.id} was still ${JSON.stringify(this.status)} after ${timeoutMs}ms`,
        );
      }
      await sleep(pollMs, signal);
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
   */
  async waitForGuest(opts: WaitOptions = {}): Promise<this> {
    const { timeoutMs = 180_000, pollMs = 3_000, signal } = opts;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const res = await this.exec(GUEST_PROBE, { timeoutS: 5 });
        if (res.ok) return this;
      } catch (err) {
        // Everything else is polled through: a 409 means the agent is not up
        // yet, a 503 means its host could not be reached, and a guest agent that
        // is merely slow answers 502 for the first seconds of a boot. Those are
        // what this loop is for. A revoked key is not.
        if (isPermanent(err)) throw err;
      }
      if (Date.now() >= deadline) {
        throw new TimeoutError(`${this.id} guest did not respond within ${timeoutMs}ms`);
      }
      await sleep(pollMs, signal);
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
   * A screenshot is not *use* as far as the platform's idle sweep is concerned,
   * and does not resume a suspended computer. A loop that only polls the screen
   * can therefore watch its own machine be suspended out from under it after the
   * host's idle window; anything that drives the desktop — {@link click},
   * {@link type}, {@link exec} — both counts as use and resumes it.
   */
  async screenshot(width?: number): Promise<Uint8Array> {
    const res = await this.#t.bytes('GET', P.computerAction(this.id, 'screenshot'), {
      query: P.screenshotQuery(width),
    });
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
  async windows(opts: { includeAll?: boolean } = {}): Promise<GuestWindow[]> {
    const data = await this.#t.json<unknown[]>('GET', P.computerAction(this.id, 'windows'), {
      query: { include: opts.includeAll ? 'all' : undefined },
    });
    return (data ?? []).filter(P.isRecord).map(toGuestWindow);
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
  ): Promise<GuestWindow> {
    const data = await this.#t.json<Record<string, unknown>>(
      'POST',
      P.windowPath(this.id, windowId),
      { body: P.windowBody({ action, ...geometry }) },
    );
    return toGuestWindow(data ?? {});
  }

  // --- controlling ----------------------------------------------------

  async #input(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return (
      (await this.#t.json<Record<string, unknown>>('POST', P.computerAction(this.id, 'input'), {
        body,
      })) ?? {}
    );
  }

  /**
   * Move the pointer to `(x, y)` in this computer's screen space.
   *
   * Coordinates are in the computer's own {@link resolution}, which is a
   * create-time choice — not a fixed 1280x800.
   */
  async move(x: number, y: number): Promise<void> {
    await this.#input(P.pointerBody('move', x, y));
  }

  /**
   * Click. With no coordinate, clicks wherever the pointer already is.
   *
   * `modifiers` are held down for the click, e.g.
   * `click(100, 200, ['shift'])` to extend a selection.
   */
  async click(x?: number, y?: number, modifiers: readonly string[] = []): Promise<void> {
    await this.#input(P.clickBody('left_click', x, y, modifiers));
  }

  async rightClick(x?: number, y?: number, modifiers: readonly string[] = []): Promise<void> {
    await this.#input(P.clickBody('right_click', x, y, modifiers));
  }

  async middleClick(x?: number, y?: number, modifiers: readonly string[] = []): Promise<void> {
    await this.#input(P.clickBody('middle_click', x, y, modifiers));
  }

  async doubleClick(x?: number, y?: number, modifiers: readonly string[] = []): Promise<void> {
    await this.#input(P.clickBody('double_click', x, y, modifiers));
  }

  /** Three clicks, which is how most editors select a whole line. */
  async tripleClick(x?: number, y?: number, modifiers: readonly string[] = []): Promise<void> {
    await this.#input(P.clickBody('triple_click', x, y, modifiers));
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
  async drag(toX: number, toY: number, from?: Point): Promise<void> {
    await this.#input(P.dragBody(toX, toY, from?.x, from?.y));
  }

  /**
   * Press the left button and leave it down.
   *
   * Pair with {@link mouseUp}. Between the two the desktop is mid-gesture, so a
   * call that throws in between leaves the button held — wrap them in
   * `try`/`finally` if that matters.
   */
  async mouseDown(x?: number, y?: number): Promise<void> {
    await this.#input(P.buttonBody('left_mouse_down', x, y));
  }

  /** Release the left button. */
  async mouseUp(x?: number, y?: number): Promise<void> {
    await this.#input(P.buttonBody('left_mouse_up', x, y));
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
    await this.#input(P.scrollBody({ direction, amount, x, y, modifiers }));
  }

  /**
   * Type text as keystrokes.
   *
   * Characters with no key mapping are skipped rather than raising, so a stray
   * emoji in a prompt cannot fail the whole call.
   */
  async type(text: string): Promise<void> {
    await this.#input(P.typeBody(text));
  }

  /**
   * Press a chord, e.g. `key('ctrl', 'c')` or `key('Return')`.
   *
   * Both this SDK's names and X11 keysyms are accepted, so the spellings a
   * computer-use model produces — `Page_Down`, `BackSpace`, `period` — work
   * without translation. An unknown key raises and names itself rather than
   * being silently dropped from the chord.
   */
  async key(...keys: string[]): Promise<void> {
    await this.#input(P.keyBody(keys));
  }

  /**
   * Hold a chord down for `seconds`, then release it.
   *
   * For the keys that mean something while held rather than when tapped — an
   * arrow key that repeats, a modifier that changes what a UI shows.
   */
  async holdKey(keys: readonly string[], seconds: number): Promise<void> {
    await this.#input(P.holdKeyBody(keys, seconds));
  }

  /**
   * Pause, inside the platform, without holding this computer's monitor.
   *
   * Sleeping locally does the same thing for a script. This exists because a
   * computer-use model emits `wait` as an action, and because it does not block
   * the screenshot polls of anything else watching the desktop. Capped at 30
   * seconds by the platform.
   */
  async wait(seconds: number): Promise<void> {
    await this.#input(P.waitBody(seconds));
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
  async cursorPosition(): Promise<Point | undefined> {
    const res = await this.#input(P.cursorBody());
    // `known` is checked rather than assumed because the coordinates are still
    // present and still zero when it is false, which is indistinguishable from
    // the corner of the screen — the exact wrong answer to give a caller about
    // to move relative to it.
    if (!res.known) return undefined;
    return { x: Number(res.x ?? 0), y: Number(res.y ?? 0) };
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
   */
  async exec(
    command: string,
    opts: { timeoutS?: number; desktop?: boolean; cwd?: string } = {},
  ): Promise<ExecResult> {
    const { timeoutS = 30, desktop, cwd } = opts;
    const data = await this.#t.json<Record<string, unknown>>(
      'POST',
      P.computerAction(this.id, 'exec'),
      { body: P.execBody({ command, timeoutS, desktop, cwd }) },
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
    opts: { desktop?: boolean; cwd?: string } = {},
  ): Promise<BackgroundExec> {
    const data = await this.#t.json<Record<string, unknown>>(
      'POST',
      P.computerAction(this.id, 'exec'),
      { body: P.execBody({ command, background: true, desktop: opts.desktop, cwd: opts.cwd }) },
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
  async execPoll(pid: number): Promise<BackgroundExec> {
    const data = await this.#t.json<Record<string, unknown>>('GET', P.execHandle(this.id, pid));
    return toBackgroundExec(data ?? {});
  }

  /**
   * Kill a backgrounded command and everything it started.
   *
   * Answers with its final state, including whatever it printed that you had not
   * read.
   */
  async execKill(pid: number): Promise<BackgroundExec> {
    const data = await this.#t.json<Record<string, unknown>>('DELETE', P.execHandle(this.id, pid));
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
   */
  async open(url: string, opts: { timeoutS?: number } = {}): Promise<ExecResult> {
    return this.exec(P.openUrlCommand(url), { timeoutS: opts.timeoutS ?? 30, desktop: true });
  }

  // --- files ----------------------------------------------------------

  /**
   * Read one file out of the guest, as bytes.
   *
   * `path` is absolute, inside the guest — there is no shell and no working
   * directory behind this, so a relative path is refused before the request is
   * made. Works while the computer is running or suspended (a transfer resumes a
   * suspended computer, like any other use).
   */
  async readFile(path: string): Promise<Uint8Array> {
    const res = await this.#t.bytes('GET', P.computerAction(this.id, 'files'), {
      query: P.filesQuery(path),
    });
    return res.bytes;
  }

  /** {@link readFile}, decoded as UTF-8. */
  async readTextFile(path: string): Promise<string> {
    return new TextDecoder().decode(await this.readFile(path));
  }

  /**
   * Write `data` to one file inside the guest, creating it if needed.
   *
   * A string is written as UTF-8. The path rules are {@link readFile}'s. The
   * bytes land exactly as given — this is how a credential reaches a guest
   * `.env` without echoing it through a shell command line.
   *
   * @returns how many bytes the platform says it wrote.
   */
  async writeFile(path: string, data: Uint8Array | string): Promise<number> {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    const res = await this.#t.json<{ bytes?: number } | undefined>(
      'PUT',
      P.computerAction(this.id, 'files'),
      { query: P.filesQuery(path), raw: bytes },
    );
    return res?.bytes ?? bytes.length;
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
   */
  async snapshot(opts: { memory?: boolean } = {}): Promise<Snapshot> {
    const data = await this.#t.json<Record<string, unknown>>(
      'POST',
      P.computerAction(this.id, 'snapshots'),
      { body: P.snapshotBody(Boolean(opts.memory)) },
    );
    return toSnapshot(data ?? {});
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
  async holdings(): Promise<Holdings> {
    const data = await this.#t.json<Record<string, unknown>>(
      'GET',
      P.computerAction(this.id, 'snapshots'),
    );
    return toHoldings(data ?? {});
  }

  /** The automatic daily snapshot schedule. */
  async schedule(): Promise<Schedule> {
    const data = await this.#t.json<Record<string, unknown>>(
      'GET',
      P.computerAction(this.id, 'schedule'),
    );
    return toSchedule(data ?? {});
  }

  /** Set the automatic daily snapshot window, in the given IANA timezone. */
  async setSchedule(args: {
    enabled: boolean;
    hour?: number;
    minute?: number;
    tz?: string;
  }): Promise<Schedule> {
    const data = await this.#t.json<Record<string, unknown>>(
      'PUT',
      P.computerAction(this.id, 'schedule'),
      { body: P.scheduleBody(args) },
    );
    return toSchedule(data ?? {});
  }

  /**
   * Remove the schedule, as distinct from disabling it.
   *
   * `setSchedule({ enabled: false })` keeps the chosen time so toggling back on
   * restores it, and keeps the scheduler's bookkeeping with it. Clearing returns
   * the computer to never having had a schedule.
   */
  async clearSchedule(): Promise<Schedule> {
    const data = await this.#t.json<Record<string, unknown>>(
      'DELETE',
      P.computerAction(this.id, 'schedule'),
    );
    return toSchedule(data ?? {});
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
    let result: AgentResult | undefined;
    let failure: { error: string; status: number } | undefined;
    for await (const ev of this.agentStream(args)) {
      if (ev.type === 'done') result = ev.result;
      else if (ev.type === 'error') failure = ev;
    }
    if (failure) {
      throw new MandalaError(`the agent run failed: ${failure.error}`);
    }
    if (!result) {
      throw new MandalaError('the agent stream ended without a result');
    }
    return result;
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
    if (!args.modelKey) {
      throw new MandalaError(
        'agent() needs your own Anthropic API key as modelKey — the platform does not store one.',
      );
    }
    let steps = 0;
    for await (const raw of this.#t.sse('POST', P.computerAction(this.id, 'agent'), {
      body: P.agentBody({
        prompt: args.prompt,
        stream: true,
        system: args.system,
        maxSteps: args.maxSteps,
        model: args.model,
      }),
      headers: { [MODEL_KEY_HEADER]: args.modelKey },
      signal: args.signal,
    })) {
      const ev = toAgentEvent(raw.event, raw.data, steps);
      if (!ev) continue;
      if (ev.type === 'step') steps += 1;
      yield ev;
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
    if (!args.modelKey) {
      throw new MandalaError(
        'agentOnce() needs your own Anthropic API key as modelKey — the platform does not store one.',
      );
    }
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
        headers: { [MODEL_KEY_HEADER]: args.modelKey },
        signal: args.signal,
      },
    );
    return toAgentResult(data ?? {});
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
    await this.delete();
  }
}
