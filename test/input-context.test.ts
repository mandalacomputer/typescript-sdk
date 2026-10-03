/**
 * The post-action window context on every input action, not only the clicks
 * (OPL-5523), and the User-Agent naming this SDK and its version.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  Client,
  type Computer,
  type InputContext,
  MandalaError,
  type TypeResult,
  ValidationError,
  VERSION,
} from '../src/index.js';
import { runtimeToken, userAgentHeader } from '../src/transport.js';
import { anyRoute, BASE, json, type Responder, recorder, WINDOW } from './harness.js';

const client = (respond: Responder, extra: Record<string, unknown> = {}) => {
  const rec = recorder(respond);
  return {
    rec,
    client: new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch, ...extra }),
  };
};

/** anyRoute, except that an input call answers `answer`. */
const inputAnswers =
  (answer: Record<string, unknown>): Responder =>
  (call) =>
    call.path.endsWith('/input') ? json(answer) : anyRoute(call);

const CONTEXT = { windows: [WINDOW], focused: WINDOW };

/** Every action but the clicks and `type`, asked and not asked. */
const actions = (c: Computer) => [
  {
    action: 'move',
    asked: () => c.move(1, 2, { context: true }),
    plain: () => c.move(1, 2),
  },
  {
    action: 'left_click_drag',
    asked: () => c.drag(5, 6, { x: 1, y: 2 }, { context: true }),
    plain: () => c.drag(5, 6, { x: 1, y: 2 }),
  },
  {
    action: 'left_mouse_down',
    asked: () => c.mouseDown(1, 2, { context: true }),
    plain: () => c.mouseDown(1, 2),
  },
  {
    action: 'left_mouse_up',
    asked: () => c.mouseUp(1, 2, { context: true }),
    plain: () => c.mouseUp(1, 2),
  },
  {
    action: 'scroll',
    asked: () => c.scroll(1, 2, { direction: 'up', context: true }),
    plain: () => c.scroll(1, 2, { direction: 'up' }),
  },
  {
    action: 'paste',
    asked: () => c.paste('hello', { context: true }),
    plain: () => c.paste('hello'),
  },
  {
    action: 'key',
    asked: () => c.key(['ctrl', 'l'], { context: true }),
    plain: () => c.key(['ctrl', 'l']),
  },
  {
    action: 'hold_key',
    asked: () => c.holdKey(['shift'], 1, { context: true }),
    plain: () => c.holdKey(['shift'], 1),
  },
  {
    action: 'wait',
    asked: () => c.wait(1, { context: true }),
    plain: () => c.wait(1),
  },
];

describe('input context on every action', () => {
  it('asks with ?context=1 and resolves to the windows after the action', async () => {
    const { client: c, rec } = client(inputAnswers({ ok: true, context: CONTEXT }));
    const computer = await c.computers.get('vm-1');
    for (const { action, asked } of actions(computer)) {
      const ctx = await asked();
      expect(rec.last().body, action).toMatchObject({ action });
      expect(rec.last().query, action).toEqual({ context: '1' });
      expect(
        ctx?.windows?.map((w) => w.id),
        action,
      ).toEqual([WINDOW.id]);
      expect(ctx?.focused?.windowClass, action).toBe(WINDOW.class);
      expect(ctx?.error, action).toBeNull();
    }
  });

  it('sends no query and resolves to undefined when not asked', async () => {
    const { client: c, rec } = client(inputAnswers({ ok: true, context: CONTEXT }));
    const computer = await c.computers.get('vm-1');
    for (const { action, plain } of actions(computer)) {
      expect(await plain(), action).toBeUndefined();
      expect(rec.last().query, action).toEqual({});
    }
    expect(await computer.key('ctrl', 'c')).toBeUndefined();
    expect(rec.last().query).toEqual({});
  });

  it('answers the reason when the windows could not be read, and the action still happened', async () => {
    const said = 'no active desktop session';
    const { client: c } = client(inputAnswers({ ok: true, context_error: said }));
    const computer = await c.computers.get('vm-1');
    for (const { action, asked } of actions(computer)) {
      expect(await asked(), action).toEqual({
        windows: null,
        focused: null,
        dom: null,
        error: said,
      });
    }
  });

  it('refuses an answer that carries neither', async () => {
    const { client: c } = client(inputAnswers({ ok: true }));
    const computer = await c.computers.get('vm-1');
    for (const { action, asked } of actions(computer)) {
      await expect(asked(), action).rejects.toThrow(MandalaError);
    }
  });

  it('refuses a context that is not a boolean before anything is sent', async () => {
    const { client: c, rec } = client(anyRoute);
    const computer = await c.computers.get('vm-1');
    const before = rec.calls.length;
    const bad = { context: 'yes' } as never;
    for (const call of [
      () => computer.move(1, 2, bad),
      () => computer.drag(5, 6, { x: 1, y: 2 }, bad),
      () => computer.mouseDown(1, 2, bad),
      () => computer.mouseUp(1, 2, bad),
      () => computer.scroll(1, 2, bad),
      () => computer.type('hi', bad),
      () => computer.paste('hi', bad),
      () => computer.key(['a'], bad),
      () => computer.holdKey(['a'], 1, bad),
      () => computer.wait(1, bad),
    ]) {
      await expect(call()).rejects.toThrow(/context must be a boolean/);
    }
    expect(rec.calls.length).toBe(before);
  });
});

describe('type with context', () => {
  it('adds the context to the TypeResult', async () => {
    const { client: c, rec } = client(
      inputAnswers({ ok: true, mechanism: 'physical', context: CONTEXT }),
    );
    const computer = await c.computers.get('vm-1');
    const res = await computer.type('hello', { context: true });
    expect(rec.last().query).toEqual({ context: '1' });
    expect(res.mechanism).toBe('physical');
    expect(res.context.focused?.id).toBe(WINDOW.id);
  });

  it('surfaces context_error on the TypeResult', async () => {
    const said = 'the guest did not list its windows within 3 seconds';
    const { client: c } = client(
      inputAnswers({ ok: true, mechanism: 'physical', context_error: said }),
    );
    const computer = await c.computers.get('vm-1');
    const res = await computer.type('hello', { context: true });
    expect(res.context).toEqual({ windows: null, focused: null, dom: null, error: said });
  });

  it('leaves the TypeResult as it was when not asked', async () => {
    const { client: c, rec } = client(
      inputAnswers({ ok: true, mechanism: 'physical', context: CONTEXT }),
    );
    const computer = await c.computers.get('vm-1');
    const res = await computer.type('hello');
    expect(rec.last().query).toEqual({});
    expect(res).not.toHaveProperty('context');
  });
});

/**
 * Checked by `tsc --noEmit` (tsconfig includes test/), never run: a call that
 * never asks keeps the type it compiled against before the option existed.
 */
function inputTypes(c: Computer, dynamic: boolean): void {
  const retry = (fn: () => Promise<void>) => fn;
  retry(() => c.move(1, 2));
  retry(() => c.drag(1, 2));
  retry(() => c.mouseDown());
  retry(() => c.mouseUp());
  retry(() => c.scroll(1, 2, { direction: 'up' }));
  retry(() => c.paste('x'));
  retry(() => c.key('ctrl', 'c'));
  retry(() => c.key(['ctrl', 'c']));
  retry(() => c.holdKey(['a'], 1));
  retry(() => c.wait(1));
  expectTypeOf(c.move(1, 2, { context: true })).toEqualTypeOf<Promise<InputContext>>();
  expectTypeOf(c.drag(1, 2, undefined, { context: true })).toEqualTypeOf<Promise<InputContext>>();
  expectTypeOf(c.scroll(1, 2, { context: dynamic })).toEqualTypeOf<
    Promise<InputContext | undefined>
  >();
  expectTypeOf(c.key(['a'], { context: true })).toEqualTypeOf<Promise<InputContext>>();
  expectTypeOf(c.wait(1, { context: false })).toEqualTypeOf<Promise<void>>();
  expectTypeOf(c.type('x')).toEqualTypeOf<Promise<TypeResult>>();
  expectTypeOf(c.type('x', { context: true })).toEqualTypeOf<
    Promise<TypeResult & { context: InputContext }>
  >();
}

describe('input return types', () => {
  it('are pinned at compile time by inputTypes', () => {
    expect(typeof inputTypes).toBe('function');
  });
});

describe('User-Agent', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  };

  it('names this SDK, its version and the runtime on every request', async () => {
    const { client: c, rec } = client(anyRoute);
    await c.computers.get('vm-1');
    expect(VERSION).toBe(pkg.version);
    expect(rec.last().headers['User-Agent']).toBe(
      `mandala-computer-ts/${VERSION} node/${process.versions.node}`,
    );
  });

  it("appends the caller's own token", async () => {
    const { client: c, rec } = client(anyRoute, { userAgent: 'my-app/1.2 (+ops)' });
    await c.computers.get('vm-1');
    expect(rec.last().headers['User-Agent']).toBe(
      `mandala-computer-ts/${VERSION} node/${process.versions.node} my-app/1.2 (+ops)`,
    );
  });

  it('refuses a token that is not printable ASCII', () => {
    for (const userAgent of ['', ' my-app', 'my-app\r\nX-Evil: 1', 'café/1', 3 as never]) {
      expect(
        () => new Client({ apiKey: 'com_test', baseUrl: BASE, userAgent }),
        JSON.stringify(userAgent),
      ).toThrow(ValidationError);
    }
  });

  it('sends none where the runtime reports no Node version, as a browser does not', () => {
    expect(runtimeToken(undefined)).toBeUndefined();
    expect(runtimeToken({ versions: {} })).toBeUndefined();
    expect(runtimeToken({ versions: { node: '22.1.0' } })).toBe('node/22.1.0');
    expect(userAgentHeader('mandala-computer-ts/1.0.0', 'my-app/1', undefined)).toBeUndefined();
    expect(userAgentHeader('mandala-computer-ts/1.0.0', undefined, 'node/22.1.0')).toBe(
      'mandala-computer-ts/1.0.0 node/22.1.0',
    );
  });
});
