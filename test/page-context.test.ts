/**
 * The page in the focused Chromium window, in an input action's context, and
 * the reason beside a context that has none.
 */

import { describe, expect, it } from 'vitest';
import { Client, MandalaError, type PageContext } from '../src/index.js';
import { toInputContext } from '../src/models.js';
import { anyRoute, BASE, json, type Responder, recorder, WINDOW } from './harness.js';

const client = (respond: Responder) => {
  const rec = recorder(respond);
  return { rec, client: new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch }) };
};

const inputAnswers =
  (answer: Record<string, unknown>): Responder =>
  (call) =>
    call.path.endsWith('/input') ? json(answer) : anyRoute(call);

const DOM = {
  url: 'https://mail.example/inbox',
  title: 'Inbox',
  elements: [
    {
      tag: 'button',
      role: '',
      name: 'Compose',
      text: 'Compose',
      x: 24,
      y: 188,
      width: 96,
      height: 32,
    },
    {
      tag: 'a',
      role: '',
      name: '',
      text: 'Next',
      href: 'https://mail.example/2',
      x: 1180,
      y: 188,
      width: 40,
      height: 18,
    },
  ],
  truncated: false,
};

const WHAT = 'POST /v1/computers/vm-1/input';

describe('page context', () => {
  it('decodes the page when the focused window is Chromium', async () => {
    const { client: c } = client(
      inputAnswers({ ok: true, context: { windows: [WINDOW], focused: WINDOW, dom: DOM } }),
    );
    const computer = await c.computers.get('vm-1');
    const ctx = await computer.click(1, 2, [], { context: true });
    const want: PageContext = DOM;
    expect(ctx.dom).toEqual(want);
    expect(ctx.error).toBeNull();
    expect(ctx.dom?.elements[1]?.href).toBe('https://mail.example/2');
    expect(ctx.dom?.elements[0]).not.toHaveProperty('href');
  });

  it('keeps the windows and says why when there is no page', async () => {
    const said = 'the focused window is not Chromium, so no page elements were read';
    const { client: c } = client(
      inputAnswers({
        ok: true,
        context: { windows: [WINDOW], focused: WINDOW },
        context_error: said,
      }),
    );
    const computer = await c.computers.get('vm-1');
    const ctx = await computer.key(['ctrl', 'l'], { context: true });
    expect(ctx.windows?.map((w) => w.id)).toEqual([WINDOW.id]);
    expect(ctx.focused?.id).toBe(WINDOW.id);
    expect(ctx.dom).toBeNull();
    expect(ctx.error).toBe(said);
  });

  it('decodes a context from a platform that predates page context', () => {
    const ctx = toInputContext({ ok: true, context: { windows: [], focused: null } }, WHAT);
    expect(ctx).toEqual({ windows: [], focused: null, dom: null, error: null });
  });

  it('refuses a page that is not one', () => {
    const el = DOM.elements[0];
    for (const dom of [
      'page',
      { ...DOM, url: 7 },
      { ...DOM, title: undefined },
      { ...DOM, truncated: 'no' },
      { ...DOM, elements: null },
      { ...DOM, elements: ['x'] },
      { ...DOM, elements: [{ ...el, tag: 1 }] },
      { ...DOM, elements: [{ ...el, text: undefined }] },
      { ...DOM, elements: [{ ...el, x: '24' }] },
      { ...DOM, elements: [{ ...el, width: 1.5 }] },
      { ...DOM, elements: [{ ...el, href: 3 }] },
    ]) {
      expect(
        () => toInputContext({ ok: true, context: { windows: [], focused: null, dom } }, WHAT),
        JSON.stringify(dom),
      ).toThrow(MandalaError);
    }
  });

  it('refuses a context_error that is not a string beside a context', () => {
    expect(() =>
      toInputContext({ ok: true, context: { windows: [], focused: null }, context_error: 3 }, WHAT),
    ).toThrow(MandalaError);
  });
});
