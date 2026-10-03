/** A click's repeat count and the post-action window context (OPL-5472). */

import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  Client,
  type Computer,
  type InputContext,
  MandalaError,
  ValidationError,
} from '../src/index.js';
import { anyRoute, BASE, json, type Responder, recorder, WINDOW } from './harness.js';

const client = (respond: Responder) => {
  const rec = recorder(respond);
  return { rec, client: new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch }) };
};

/** anyRoute, except that an input call answers `answer`. */
const inputAnswers =
  (answer: Record<string, unknown>): Responder =>
  (call) =>
    call.path.endsWith('/input') ? json(answer) : anyRoute(call);

describe('click count', () => {
  it('sends count on the three single clicks, and nothing when it is left out', async () => {
    const { client: c, rec } = client(anyRoute);
    const computer = await c.computers.get('vm-1');
    await computer.click(1, 2, [], { count: 4 });
    expect(rec.last().body).toEqual({ action: 'left_click', x: 1, y: 2, count: 4 });
    await computer.rightClick(1, 2, ['ctrl'], { count: 2 });
    expect(rec.last().body).toEqual({ action: 'right_click', x: 1, y: 2, text: 'ctrl', count: 2 });
    await computer.middleClick(undefined, undefined, [], { count: 10 });
    expect(rec.last().body).toEqual({ action: 'middle_click', count: 10 });
    await computer.click(1, 2);
    expect(rec.last().body).not.toHaveProperty('count');
  });

  it('refuses a count the platform would, before anything is sent', async () => {
    const { client: c, rec } = client(anyRoute);
    const computer = await c.computers.get('vm-1');
    const before = rec.calls.length;
    for (const count of [0, 11, -1, 2.5, Number.NaN]) {
      await expect(computer.click(1, 2, [], { count })).rejects.toThrow(ValidationError);
    }
    await expect(computer.click(1, 2, [], { count: '3' as never })).rejects.toThrow(
      /whole number from 1 to 10/,
    );
    // Two and three by name: a count there would be a second answer.
    await expect(computer.doubleClick(1, 2, [], { count: 3 } as never)).rejects.toThrow(
      /double_click takes no count/,
    );
    await expect(computer.tripleClick(1, 2, [], { count: 2 } as never)).rejects.toThrow(
      /triple_click takes no count/,
    );
    expect(rec.calls.length).toBe(before);
  });
});

describe('click context', () => {
  it('asks with ?context=1 and answers the windows after the click', async () => {
    const other = { ...WINDOW, id: '0x1', title: 'terminal', focused: false };
    const { client: c, rec } = client(
      inputAnswers({ ok: true, context: { windows: [other, WINDOW], focused: WINDOW } }),
    );
    const computer = await c.computers.get('vm-1');
    const ctx = await computer.click(640, 400, [], { context: true });
    expect(rec.last().query).toEqual({ context: '1' });
    expect(ctx?.error).toBeNull();
    expect(ctx?.windows?.map((w) => w.id)).toEqual(['0x1', WINDOW.id]);
    expect(ctx?.focused?.id).toBe(WINDOW.id);
    expect(ctx?.focused?.windowClass).toBe(WINDOW.class);
  });

  it('works on every click, and a focused null is null', async () => {
    const { client: c, rec } = client(
      inputAnswers({ ok: true, context: { windows: [], focused: null } }),
    );
    const computer = await c.computers.get('vm-1');
    for (const call of [
      () => computer.rightClick(1, 2, [], { context: true }),
      () => computer.middleClick(1, 2, [], { context: true }),
      () => computer.doubleClick(1, 2, [], { context: true }),
      () => computer.tripleClick(1, 2, [], { context: true }),
    ]) {
      expect(await call()).toEqual({ windows: [], focused: null, dom: null, error: null });
      expect(rec.last().query).toEqual({ context: '1' });
    }
  });

  it('answers the reason when the windows could not be read, and the click still happened', async () => {
    const said = 'listing windows is not supported on Windows guests yet';
    const { client: c } = client(inputAnswers({ ok: true, context_error: said }));
    const computer = await c.computers.get('vm-1');
    expect(await computer.click(1, 2, [], { context: true })).toEqual({
      windows: null,
      focused: null,
      dom: null,
      error: said,
    });
  });

  it('refuses an answer that carries neither, rather than calling it an empty desktop', async () => {
    const { client: c } = client(inputAnswers({ ok: true }));
    const computer = await c.computers.get('vm-1');
    await expect(computer.click(1, 2, [], { context: true })).rejects.toThrow(MandalaError);
    const bad = client(inputAnswers({ ok: true, context: { windows: {}, focused: null } }));
    await expect(
      (await bad.client.computers.get('vm-1')).click(1, 2, [], { context: true }),
    ).rejects.toThrow(/context\.windows to be an array/);
  });

  it('sends no query and resolves to undefined when not asked', async () => {
    const { client: c, rec } = client(anyRoute);
    const computer = await c.computers.get('vm-1');
    expect(await computer.click(1, 2)).toBeUndefined();
    expect(rec.last().query).toEqual({});
    expect(await computer.click(1, 2, [], { context: false })).toBeUndefined();
    expect(rec.last().query).toEqual({});
    await expect(computer.click(1, 2, [], { context: 'yes' as never })).rejects.toThrow(
      /context must be a boolean/,
    );
  });
});

/**
 * Checked by `tsc --noEmit` (tsconfig includes test/), never run: a caller that
 * never asks for context keeps the `Promise<void>` it compiled against before
 * the option existed, and only `{ context: true }` is typed as the context.
 */
function clickTypes(c: Computer, dynamic: boolean): void {
  const plain: Promise<void> = c.click(1, 2);
  const retry = (fn: () => Promise<void>) => fn;
  retry(() => c.click(1, 2));
  retry(() => c.rightClick(1, 2, ['ctrl'], { count: 2 }));
  retry(() => c.middleClick());
  const voidFn = async (): Promise<void> => c.click(1, 2, [], { context: false });
  const twice: Promise<void> = c.doubleClick(1, 2);
  const thrice: Promise<void> = c.tripleClick(1, 2);
  const asked: Promise<InputContext> = c.click(1, 2, [], { context: true });
  const askedTwice: Promise<InputContext> = c.doubleClick(1, 2, [], { context: true });
  expectTypeOf(c.click(1, 2)).toEqualTypeOf<Promise<void>>();
  expectTypeOf(c.rightClick(1, 2, [], { context: true })).toEqualTypeOf<Promise<InputContext>>();
  expectTypeOf(c.middleClick(1, 2, [], { context: dynamic })).toEqualTypeOf<
    Promise<InputContext | undefined>
  >();
  expectTypeOf(c.tripleClick(1, 2, [], { context: true })).toEqualTypeOf<Promise<InputContext>>();
  void [plain, voidFn, twice, thrice, asked, askedTwice];
}

describe('click return types', () => {
  it('are pinned at compile time by clickTypes', () => {
    expect(typeof clickTypes).toBe('function');
  });
});
