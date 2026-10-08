/**
 * Claude's computer toolset, driven against a Mandala computer (OPL-5851).
 *
 * Anthropic's SDK ships the class a computer-use driver subclasses,
 * `BetaAbstractComputerToolset20260801`, and no desktop for it to drive. This
 * is that driver. Give it a {@link Computer} and pass it as a `tools` entry to
 * the tool runner, and every action the model asks for runs on that computer:
 *
 * ```ts
 * import Anthropic from '@anthropic-ai/sdk';
 * import { Client } from 'mandala-computer';
 * import { MandalaComputerToolset } from 'mandala-computer/anthropic';
 *
 * const computer = await new Client().computers.get('vm-...');
 * const desktop = new MandalaComputerToolset(computer, { confirm: async () => true });
 * try {
 *   const runner = new Anthropic().beta.messages.toolRunner({
 *     model: 'claude-opus-5-5',
 *     max_tokens: 16000,
 *     tools: [desktop],
 *     messages: [{ role: 'user', content: 'Open a terminal and run date' }],
 *   });
 *   for await (const message of runner) console.log(message.content);
 * } finally {
 *   await desktop.close();
 * }
 * ```
 *
 * A SUBPATH, NOT THE PACKAGE ROOT. `@anthropic-ai/sdk` is an optional peer
 * dependency: `mandala-computer` itself must import without it, and this module
 * is the only one that needs it.
 *
 * `confirm` IS REQUIRED, by Anthropic's class rather than by this one: a toolset
 * that can type and press keys refuses to construct without a callable that
 * approves each call, unless `configs` turns those members off. Approving
 * everything, as above, is a decision to make about a throwaway computer only.
 *
 * Closing the toolset does not stop or delete the computer. It belongs to the
 * caller, who may run several toolsets against it in turn.
 */

import {
  BetaAbstractComputerToolset20260801,
  type BetaComputerCursorPositionResult,
  type BetaComputerToolsetOptions,
  type BetaScreenshotResult,
  type BetaToolsetCallContext,
  ToolError,
} from '@anthropic-ai/sdk/helpers/beta/toolsets';
import type {
  BetaComputerDoubleClickInput,
  BetaComputerHoldKeyInput,
  BetaComputerKeyInput,
  BetaComputerLeftClickDragInput,
  BetaComputerLeftClickInput,
  BetaComputerMiddleClickInput,
  BetaComputerMouseMoveInput,
  BetaComputerRightClickInput,
  BetaComputerScrollInput,
  BetaComputerTripleClickInput,
  BetaComputerTypeInput,
  BetaComputerWaitInput,
  BetaComputerZoomInput,
} from '@anthropic-ai/sdk/resources/beta';
import type { Computer } from './computer.js';
import { APIError } from './errors.js';

/** What {@link MandalaComputerToolset} takes beside the computer: Anthropic's own options. */
export type MandalaComputerToolsetOptions = BetaComputerToolsetOptions;

type Size = { width: number; height: number };
type Ctx = BetaToolsetCallContext;

/**
 * The largest image the toolset's models take: 2576 pixels on the long edge
 * and 4784 visual tokens, a token being a 28-pixel tile. The API refuses a
 * larger one outright rather than shrinking it, and a computer may be as large
 * as 3840x2160.
 */
const MAX_EDGE = 2576;
const MAX_TILES = 4784;
const TILE = 28;
/** The platform's floor for a shrunk screenshot's width. */
const MIN_WIDTH = 64;

/** The platform's ceiling on one `wait` or one held key, in seconds. */
const PLATFORM_HOLD = 30;
/** The toolset's own ceiling on `wait`, which this splits into platform waits. */
const MAX_WAIT = 300;
/** The toolset's ceiling on `key`'s `repeat`. */
const MAX_REPEAT = 100;
/** The platform's ceiling on one scroll's notches. */
const MAX_SCROLL = 50;
/** The most characters one platform `type` takes; longer text is typed in pieces. */
const TYPE_PIECE = 400;
/**
 * How many times a zoom measures and crops before giving up on a screen that
 * keeps being captured again in between; see {@link MandalaComputerToolset.zoom}.
 */
const ZOOM_ATTEMPTS = 3;

const SCROLL_DIRECTIONS = new Set(['up', 'down', 'left', 'right']);

function fits(s: Size): boolean {
  return (
    Math.max(s.width, s.height) <= MAX_EDGE &&
    Math.ceil(s.width / TILE) * Math.ceil(s.height / TILE) <= MAX_TILES
  );
}

/**
 * The largest picture of a `size` the model takes: the size itself when it
 * fits, otherwise the widest that does, with its height worked out as the
 * platform works out the height for a width — scaled by the same ratio and
 * rounded down. The two have to agree to the pixel, because the model aims in
 * this picture.
 */
function largestFit(size: Size): Size {
  if (fits(size)) return size;
  const heightAt = (w: number) => Math.max(1, Math.floor((size.height * w) / size.width));
  let width = size.width - 1;
  while (width > MIN_WIDTH && !fits({ width, height: heightAt(width) })) width--;
  return { width, height: heightAt(width) };
}

/**
 * How to have the platform shrink a crop of `size` to a picture the model
 * takes: nothing when it fits already, a width when one of at least
 * {@link MIN_WIDTH} does, and otherwise a scale.
 *
 * A width alone is not enough for a crop. The platform will not shrink below
 * 64 pixels wide by `w`, so a tall, narrow region — a strip down a portrait
 * screen — came back 64 pixels wide and still taller than the model takes. A
 * scale has no such floor. The platform rounds `scale` to the nearest pixel
 * where it floors `w`, so the scale is the largest whose ROUNDED size fits.
 */
function cropShrink(size: Size): { width?: number; scale?: number } {
  const fit = largestFit(size);
  if (same(fit, size)) return {};
  if (fits(fit)) return { width: fit.width };
  const at = (k: number) => ({
    width: Math.max(1, Math.round(size.width * k)),
    height: Math.max(1, Math.round(size.height * k)),
  });
  let scale = MAX_EDGE / Math.max(size.width, size.height);
  while (!fits(at(scale))) scale *= 0.99;
  return { scale };
}

const same = (a: Size, b: Size) => a.width === b.width && a.height === b.height;

/**
 * A PNG's size, read from its header, or undefined when the bytes are not a
 * PNG: the eight-byte signature, then the IHDR chunk, whose first two fields
 * are the width and height.
 */
function pngSize(bytes: Uint8Array): Size | undefined {
  const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || SIGNATURE.some((b, i) => bytes[i] !== b)) return undefined;
  if (String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR') return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  return width > 0 && height > 0 ? { width, height } : undefined;
}

function base64(bytes: Uint8Array): string {
  const B = (globalThis as { Buffer?: typeof Buffer }).Buffer;
  if (B) return B.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** A whole number from `min` to `max`, or the refusal the model reads. */
function whole(v: unknown, field: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw new ToolError(`${field} must be a whole number from ${min} to ${max}`);
  }
  return v;
}

/** Seconds, greater than 0 and at most `max`, or the refusal the model reads. */
function seconds(v: unknown, field: string, max: number, hint: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > max) {
    throw new ToolError(`${field} must be more than 0 and at most ${max} seconds${hint}`);
  }
  return v;
}

/** `ctrl+shift+t` as its keys. The toolset spells chords with `+`; the SDK takes a list. */
function chord(text: unknown, field: string): string[] {
  if (typeof text !== 'string') throw new ToolError(`${field} must be a key or a key combination`);
  if (text.trim() === '') return [];
  const keys = text.split('+').map((k) => k.trim());
  // An empty part is refused, not dropped (found in review): `+Delete` would
  // otherwise press Delete alone and `ctrl++` press ctrl alone — an action the
  // model did not ask for, reported as done.
  if (keys.some((k) => k === '')) {
    throw new ToolError(
      `${field} must be keys joined by +, such as ctrl+s; the + key itself is plus`,
    );
  }
  return keys;
}

/**
 * Text as the pieces the platform types, each at most {@link TYPE_PIECE}
 * code points — counted as the platform counts, so a piece never ends half way
 * through a character — and never ending between the two halves of a CRLF,
 * which is one Return together and a refused bare CR apart (found in review).
 */
function pieces(text: string): string[] {
  const points = [...text];
  const out: string[] = [];
  for (let i = 0; i < points.length; ) {
    let end = Math.min(i + TYPE_PIECE, points.length);
    if (end < points.length && points[end - 1] === '\r' && points[end] === '\n') end--;
    out.push(points.slice(i, end).join(''));
    i = end;
  }
  return out;
}

/**
 * A Mandala computer as Claude's computer toolset, `computer_toolset_20260801`.
 *
 * Every member is served, `zoom` included. A zoom is cut from one capture,
 * named: the platform names every capture it answers from, and the crop is
 * asked for by that name, so it cannot come from a later frame of another size
 * (platform OPL-5852, which a platform without it refuses to zoom on).
 * Screenshots are always fresh, because a cached frame
 * can predate the action it is meant to show and the model then repeats the
 * action. Coordinates arrive in the pixels of the last screenshot the model was
 * shown and are scaled to the computer's own screen before they are sent.
 *
 * A screen larger than the model will take a picture of is photographed
 * smaller, by the platform, and the model's points are scaled back up. And the
 * size of every screenshot is MEASURED rather than assumed, because the
 * picture can differ from the screen the computer reports: a desktop resumed
 * from a capture taken at another size can answer screenshots at the capture's
 * size while it takes pointer input at its own, until it is restarted.
 */
export class MandalaComputerToolset extends BetaAbstractComputerToolset20260801 {
  /** The computer the actions run on. Not stopped or deleted by {@link close}. */
  readonly computer: Computer;
  /** The screen the computer reports, which is the space the platform takes points in. */
  readonly #screen: Size;
  /** The size of the last screenshot the model was shown; before the first, the expected one. */
  #frame: Size;
  /** The width to have the platform shrink a screenshot to, once one needs it. */
  #request: number | undefined;
  #shown = false;
  /**
   * Set when a screenshot came back at a size other than the last one's. A
   * point chosen before that is in the old picture's pixels, and nothing in a
   * call says which picture it was aimed at — a model that asks for a
   * screenshot and a click in one reply chose the click before it saw the
   * screenshot. So the next action that carries a point is refused once, with
   * the new size in the refusal, and the model aims again.
   */
  #resized = false;

  constructor(computer: Computer, options: MandalaComputerToolsetOptions = {}) {
    super(options);
    this.computer = computer;
    // Throws when the computer reports no resolution, which is a record that
    // cannot be driven yet — better here than on the model's first click.
    this.#screen = computer.screen;
    // The picture asked for before any has been measured.
    const expected = largestFit(this.#screen);
    this.#frame = expected;
    this.#request = same(expected, this.#screen) ? undefined : expected.width;
  }

  protected override async screenshot(ctx: Ctx): Promise<BetaScreenshotResult> {
    let bytes = await this.#shoot(ctx, this.#request);
    let size = pngSize(bytes);
    if (!size) throw new ToolError('the screenshot came back in a format other than PNG');
    if (!fits(size)) {
      // A screen whose real size is not the one its computer reports. Taken
      // again at a size that fits, and asked for at that size from then on.
      // Worked out from a picture one row TALLER than the one measured: the
      // platform scales the capture it holds, not the picture it last
      // returned, and that picture's height was rounded down when it was
      // shrunk, so the capture's true shape is somewhere below one row more.
      this.#request = largestFit({ width: size.width, height: size.height + 1 }).width;
      bytes = await this.#shoot(ctx, this.#request);
      size = pngSize(bytes);
      if (!size || !fits(size)) {
        throw new ToolError('the screen came back larger than the model can be shown');
      }
    }
    if (this.#shown && !same(size, this.#frame)) this.#resized = true;
    this.#frame = size;
    this.#shown = true;
    return { data: base64(bytes), mediaType: 'image/png' };
  }

  protected override async cursor_position(ctx: Ctx): Promise<BetaComputerCursorPositionResult> {
    const at = await this.#call(ctx, (signal) => this.computer.cursorPosition({ signal }));
    if (!at)
      throw new ToolError(
        'the pointer has not been placed yet, so it has no position; move it first',
      );
    // In the pixels of the newest screenshot, which is where the model will
    // aim its next point.
    const frame = this.#frame;
    return {
      x: Math.floor((at.x * frame.width) / this.#screen.width),
      y: Math.floor((at.y * frame.height) / this.#screen.height),
    };
  }

  protected override async mouse_move(ctx: Ctx, input: BetaComputerMouseMoveInput): Promise<void> {
    const [at] = this.#points(true, input.coordinate);
    await this.#call(ctx, (signal) => this.computer.move(at![0], at![1], { signal }));
  }

  protected override async left_click(ctx: Ctx, input: BetaComputerLeftClickInput): Promise<void> {
    const [at] = this.#points(false, input.coordinate ?? undefined);
    const held = chord(input.text ?? '', 'text');
    await this.#call(ctx, (signal) => this.computer.click(at?.[0], at?.[1], held, { signal }));
  }

  protected override async right_click(
    ctx: Ctx,
    input: BetaComputerRightClickInput,
  ): Promise<void> {
    const [at] = this.#points(false, input.coordinate ?? undefined);
    const held = chord(input.text ?? '', 'text');
    await this.#call(ctx, (signal) => this.computer.rightClick(at?.[0], at?.[1], held, { signal }));
  }

  protected override async middle_click(
    ctx: Ctx,
    input: BetaComputerMiddleClickInput,
  ): Promise<void> {
    const [at] = this.#points(false, input.coordinate ?? undefined);
    const held = chord(input.text ?? '', 'text');
    await this.#call(ctx, (signal) =>
      this.computer.middleClick(at?.[0], at?.[1], held, { signal }),
    );
  }

  protected override async double_click(
    ctx: Ctx,
    input: BetaComputerDoubleClickInput,
  ): Promise<void> {
    const [at] = this.#points(false, input.coordinate ?? undefined);
    const held = chord(input.text ?? '', 'text');
    await this.#call(ctx, (signal) =>
      this.computer.doubleClick(at?.[0], at?.[1], held, { signal }),
    );
  }

  protected override async triple_click(
    ctx: Ctx,
    input: BetaComputerTripleClickInput,
  ): Promise<void> {
    const [at] = this.#points(false, input.coordinate ?? undefined);
    const held = chord(input.text ?? '', 'text');
    await this.#call(ctx, (signal) =>
      this.computer.tripleClick(at?.[0], at?.[1], held, { signal }),
    );
  }

  protected override async left_click_drag(
    ctx: Ctx,
    input: BetaComputerLeftClickDragInput,
  ): Promise<void> {
    const [from, to] = this.#points(true, input.start_coordinate, input.coordinate);
    const modifiers = chord(input.text ?? '', 'text');
    await this.#call(ctx, (signal) =>
      this.computer.drag(to![0], to![1], { x: from![0], y: from![1] }, { modifiers, signal }),
    );
  }

  protected override async left_mouse_down(ctx: Ctx): Promise<void> {
    await this.#call(ctx, (signal) => this.computer.mouseDown(undefined, undefined, { signal }));
  }

  protected override async left_mouse_up(ctx: Ctx): Promise<void> {
    await this.#call(ctx, (signal) => this.computer.mouseUp(undefined, undefined, { signal }));
  }

  protected override async scroll(ctx: Ctx, input: BetaComputerScrollInput): Promise<void> {
    const direction = input.scroll_direction;
    if (!SCROLL_DIRECTIONS.has(direction)) {
      throw new ToolError('scroll_direction must be up, down, left or right');
    }
    const amount = whole(input.scroll_amount, 'scroll_amount', 1, MAX_SCROLL);
    const [at] = this.#points(false, input.coordinate ?? undefined);
    const modifiers = chord(input.text ?? '', 'text');
    await this.#call(ctx, (signal) =>
      this.computer.scroll(at?.[0], at?.[1], { direction, amount, modifiers, signal }),
    );
  }

  protected override async type_(ctx: Ctx, input: BetaComputerTypeInput): Promise<void> {
    if (typeof input.text !== 'string' || input.text === '') {
      throw new ToolError('text must be the text to type');
    }
    const all = pieces(input.text);
    const total = [...input.text].length;
    let typed = 0;
    for (const piece of all) {
      ctx.signal?.throwIfAborted();
      try {
        await this.#call(ctx, (signal) => this.computer.type(piece, { signal }));
      } catch (error) {
        if (typed === 0 || !(error instanceof ToolError)) throw error;
        // Said, because what is already on the screen stays there: typing the
        // whole text again would type its start twice, and a newline in it
        // would run a command twice (found in review).
        throw new ToolError(
          `typed ${typed} of ${total} characters, then: ${error.message}. ` +
            'The piece that failed may have been typed in part.',
        );
      }
      typed += [...piece].length;
    }
  }

  protected override async key(ctx: Ctx, input: BetaComputerKeyInput): Promise<void> {
    const keys = chord(input.text, 'text');
    if (!keys.length) throw new ToolError('text must name a key, such as Return or ctrl+s');
    const times = input.repeat == null ? 1 : whole(input.repeat, 'repeat', 1, MAX_REPEAT);
    for (let pressed = 0; pressed < times; pressed++) {
      ctx.signal?.throwIfAborted();
      try {
        await this.#call(ctx, (signal) => this.computer.key(keys, { signal }));
      } catch (error) {
        if (pressed === 0 || !(error instanceof ToolError)) throw error;
        throw new ToolError(`pressed ${pressed} of ${times} times, then: ${error.message}`);
      }
    }
  }

  protected override async hold_key(ctx: Ctx, input: BetaComputerHoldKeyInput): Promise<void> {
    const keys = chord(input.text, 'text');
    if (!keys.length) throw new ToolError('text must name a key, such as shift');
    // A hold cannot be split the way a wait can: letting go half way is a
    // different gesture.
    const duration = seconds(
      input.duration,
      'duration',
      PLATFORM_HOLD,
      '; a key is held for 30 seconds at most',
    );
    await this.#call(ctx, (signal) => this.computer.holdKey(keys, duration, { signal }));
  }

  protected override async wait(ctx: Ctx, input: BetaComputerWaitInput): Promise<void> {
    let left = seconds(input.duration, 'duration', MAX_WAIT, '');
    // Waited out on the platform, which counts as use of the computer, in the
    // platform's 30-second pieces.
    while (left > 0) {
      ctx.signal?.throwIfAborted();
      const piece = Math.min(left, PLATFORM_HOLD);
      await this.#call(ctx, (signal) => this.computer.wait(piece, { signal }));
      left -= piece;
    }
  }

  /**
   * A close-up of the rectangle the model drew, in the pixels of the last
   * screenshot it was shown.
   *
   * The platform crops the capture it HOLDS, in that capture's own pixels,
   * which are not the screen's when the two differ and not the picture's when
   * the picture was shrunk: a 3200x1800 capture under a 3840x2160 record
   * shrinks to the same 2576x1449 picture a 3840x2160 one does. So each zoom
   * measures a capture taken now — a fresh thumbnail, whose headers carry the
   * capture's name and size, so the whole screen is not downloaded to be
   * measured — maps the rectangle into that capture's pixels, and asks for the
   * crop BY THE CAPTURE'S NAME.
   *
   * The name is what makes it exact. Asked for without one, the crop was cut
   * from whatever capture the platform held when the second request arrived,
   * and a capture at another size landing in between — another caller's, or
   * the platform's own once its 1.5-second reuse window had passed — gave the
   * wrong part of the screen as a success. Named, the platform answers from
   * that capture or refuses with `stale_capture` once a newer one has replaced
   * it, and the zoom measures again: at most {@link ZOOM_ATTEMPTS} times.
   *
   * A platform that does not name its captures is refused here rather than
   * cropped unpinned, which would be the guess this exists to stop making.
   */
  protected override async zoom(
    ctx: Ctx,
    input: BetaComputerZoomInput,
  ): Promise<BetaScreenshotResult> {
    const r = input.region;
    if (
      !Array.isArray(r) ||
      r.length !== 4 ||
      !r.every((n) => typeof n === 'number' && Number.isFinite(n))
    ) {
      throw new ToolError('region must be [x0, y0, x1, y1], in the pixels of the screenshot');
    }
    const [x0, y0, x1, y1] = r as [number, number, number, number];
    const frame = this.#frame;
    if (!(x0 >= 0 && y0 >= 0 && x1 > x0 && y1 > y0 && x1 <= frame.width && y1 <= frame.height)) {
      throw new ToolError(
        `region [${x0}, ${y0}, ${x1}, ${y1}] is not a rectangle inside the ` +
          `${frame.width}x${frame.height} screenshot`,
      );
    }
    this.#aiming();
    if (!this.#shown)
      throw new ToolError('take a screenshot before zooming, so the region has a picture to be in');
    for (let attempt = 1; ; attempt++) {
      const measured = await this.#call(ctx, (signal) =>
        this.computer.screenshotWithInfo(MIN_WIDTH, { fresh: true, signal }),
      );
      const { capture, captureSize: native } = measured;
      if (capture === undefined || native === undefined) {
        throw new ToolError(
          'zoom needs a platform that names the capture each screenshot is cut from, and this ' +
            'one does not, so the crop could not be pinned to the capture it was measured on; ' +
            'take a screenshot instead',
        );
      }
      const left = Math.floor((x0 * native.width) / frame.width);
      const top = Math.floor((y0 * native.height) / frame.height);
      const right = Math.min(native.width, Math.ceil((x1 * native.width) / frame.width));
      const bottom = Math.min(native.height, Math.ceil((y1 * native.height) / frame.height));
      const region = {
        x: left,
        y: top,
        width: Math.max(1, right - left),
        height: Math.max(1, bottom - top),
      };
      const { width, scale } = cropShrink(region);
      let bytes: Uint8Array;
      try {
        bytes = await this.computer.screenshot(width, {
          capture,
          region,
          ...(scale === undefined ? {} : { scale }),
          format: 'png',
          signal: ctx.signal ?? undefined,
        });
      } catch (error) {
        // The platform's refusal of a replaced capture, and only that: 409 and
        // the word together. The word on another status is some other failure,
        // and measuring again would bury it under a race that did not happen.
        const replaced =
          error instanceof APIError && error.status === 409 && error.reason === 'stale_capture';
        if (!replaced || ctx.signal?.aborted) throw this.#told(error, ctx);
        if (attempt < ZOOM_ATTEMPTS) continue;
        throw new ToolError(
          `the screen was captured again between measuring it and cropping it, ${ZOOM_ATTEMPTS} ` +
            'times running, so no crop could be cut from the capture it was measured on; take a ' +
            'screenshot and zoom again',
        );
      }
      const size = pngSize(bytes);
      if (!size || !fits(size))
        throw new ToolError('the zoomed picture came back larger than the model can be shown');
      return { data: base64(bytes), mediaType: 'image/png' };
    }
  }

  /** Refuses the first point after the screen changed size; see {@link #resized}. */
  #aiming(): void {
    if (!this.#resized) return;
    this.#resized = false;
    const { width, height } = this.#frame;
    throw new ToolError(
      `the screen changed size: screenshots are now ${width}x${height}. ` +
        'Aim again in the latest screenshot.',
    );
  }

  /**
   * The model's points, in the last screenshot's pixels, as points on the
   * screen. An optional point that is absent stays absent: a click with no
   * coordinate clicks where the pointer is. A point outside the picture is
   * refused rather than moved into it, which would be a click somewhere the
   * model did not aim.
   */
  #points(
    required: boolean,
    ...given: (readonly number[] | undefined)[]
  ): ([number, number] | undefined)[] {
    if (required && given.some((v) => v == null)) {
      throw new ToolError('a coordinate is required, as [x, y] in the pixels of the screenshot');
    }
    if (given.every((v) => v == null)) return given.map(() => undefined);
    const frame = this.#frame;
    const out = given.map((v) => {
      if (v == null) return undefined;
      if (
        !Array.isArray(v) ||
        v.length !== 2 ||
        !v.every((n) => typeof n === 'number' && Number.isFinite(n))
      ) {
        throw new ToolError('a coordinate must be [x, y], in the pixels of the screenshot');
      }
      const [x, y] = v as [number, number];
      if (x < 0 || y < 0 || x >= frame.width || y >= frame.height) {
        throw new ToolError(
          `[${x}, ${y}] is outside the ${frame.width}x${frame.height} screenshot`,
        );
      }
      return [
        Math.floor((x * this.#screen.width) / frame.width),
        Math.floor((y * this.#screen.height) / frame.height),
      ] as [number, number];
    });
    this.#aiming();
    return out;
  }

  #shoot(ctx: Ctx, width: number | undefined): Promise<Uint8Array> {
    return this.#call(ctx, (signal) =>
      this.computer.screenshot(
        width,
        width === undefined ? { fresh: true, signal } : { fresh: true, format: 'png', signal },
      ),
    );
  }

  /**
   * A platform call, with its failure told to the model in this SDK's own
   * words. An abort is left to propagate, so the tool runner sees the run
   * cancelled rather than an action that failed.
   */
  async #call<T>(ctx: Ctx, fn: (signal: AbortSignal | undefined) => Promise<T>): Promise<T> {
    try {
      return await fn(ctx.signal ?? undefined);
    } catch (error) {
      throw this.#told(error, ctx);
    }
  }

  /** A failure as {@link #call} hands it on. */
  #told(error: unknown, ctx: Ctx): unknown {
    if (error instanceof ToolError || ctx.signal?.aborted) return error;
    return new ToolError(error instanceof Error ? error.message : String(error));
  }
}
