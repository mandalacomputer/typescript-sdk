/**
 * OpenAI input batches (`POST computers/:id/input` with a JSON array): the body
 * is OpenAI's own actions, checked before anything is sent; a refusal before
 * dispatch is the ordinary error; a batch that stopped part-way is an
 * `InputBatchError` carrying how far it went, which is never called transient.
 */

import type { ComputerAction } from 'openai/resources/responses/responses';
import { describe, expect, it } from 'vitest';
import {
  Client,
  ComputerNotRunningError,
  ConflictError,
  InputBatchError,
  isTransient,
  MandalaError,
  type OpenAIComputerAction,
  ValidationError,
} from '../src/index.js';
import { anyRoute, BASE, json, type Responder, recorder, WINDOW } from './harness.js';

const setup = (respond: Responder = anyRoute, timeoutMs?: number) => {
  const rec = recorder(respond);
  const client = new Client({
    apiKey: 'com_test',
    baseUrl: BASE,
    fetch: rec.fetch,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  return { rec, computer: () => client.computers.get('vm-1') };
};

const onInput =
  (answer: (call: Parameters<Responder>[0]) => Response | Promise<Response>): Responder =>
  (call) =>
    call.path.endsWith('/input') ? answer(call) : anyRoute(call);

/** What the platform answers for a batch that stopped at `at` after `done` actions. */
const stopped = (done: number, at: number, status: number) =>
  json(
    {
      ok: false,
      completed: done,
      failed_index: at,
      error: `batch stopped at action ${at}: the computer is not running; earlier actions and part of this action may have applied; inspect the desktop before retrying`,
      results: Array.from({ length: done }, () => ({ ok: true })),
    },
    { status },
  );

describe('computer.inputBatch()', () => {
  it('sends the actions as a JSON array, in OpenAI’s spelling, and decodes the answer', async () => {
    const { rec, computer } = setup();
    const c = await computer();
    const result = await c.inputBatch([
      { type: 'click', x: 0, y: 0, button: 'right', keys: null },
      { type: 'double_click', x: 5, y: 6, keys: ['shift'] },
      { type: 'scroll', x: 10, y: 20, scroll_x: 0, scroll_y: -300 },
      {
        type: 'drag',
        path: [
          { x: 1, y: 2 },
          { x: 3, y: 4 },
          { x: 5, y: 6 },
        ],
      },
      { type: 'keypress', keys: ['CTRL', 'L'] },
      { type: 'type', text: 'héllo' },
      { type: 'wait' },
      { type: 'screenshot' },
    ]);
    const sent = rec.last();
    expect(sent.method).toBe('POST');
    expect(sent.path).toBe('/computers/vm-1/input');
    expect(sent.query).toEqual({});
    expect(sent.body).toEqual([
      { type: 'click', x: 0, y: 0, button: 'right' },
      { type: 'double_click', x: 5, y: 6, keys: ['shift'] },
      { type: 'scroll', x: 10, y: 20, scroll_x: 0, scroll_y: -300 },
      {
        type: 'drag',
        path: [
          { x: 1, y: 2 },
          { x: 3, y: 4 },
          { x: 5, y: 6 },
        ],
      },
      { type: 'keypress', keys: ['CTRL', 'L'] },
      { type: 'type', text: 'héllo' },
      { type: 'wait' },
      { type: 'screenshot' },
    ]);
    expect(result.ok).toBe(true);
    expect(result.completed).toBe(8);
    expect(result.results).toHaveLength(8);
    expect(result.results[5]?.mechanism).toBe('physical');
    expect(result.failedIndex).toBeUndefined();
    expect(result.context).toBeUndefined();
  });

  it('asks for the desktop after the batch with { context: true }', async () => {
    const { rec, computer } = setup();
    const result = await (await computer()).inputBatch([{ type: 'wait' }], { context: true });
    expect(rec.last().query).toEqual({ context: '1' });
    expect(result.context?.focused?.id).toBe(WINDOW.id);
  });

  it('takes the actions of an OpenAI computer call as they came', () => {
    // Compile-time: the `openai` package's own action type is accepted.
    const fromOpenAI: ComputerAction[] = [{ type: 'double_click', x: 1, y: 2, keys: null }];
    const accepted: readonly OpenAIComputerAction[] = fromOpenAI;
    expect(accepted).toHaveLength(1);
  });

  it('holds the request open past the client’s ordinary deadline', async () => {
    const { computer } = setup(
      onInput(async (call) => {
        await new Promise((r) => setTimeout(r, 60));
        return anyRoute(call);
      }),
      20,
    );
    const result = await (await computer()).inputBatch([{ type: 'wait' }]);
    expect(result.completed).toBe(1);
  });

  const bad: [string, unknown][] = [
    ['an empty batch', []],
    ['33 actions', Array.from({ length: 33 }, () => ({ type: 'wait' }))],
    ['not an array', { type: 'wait' }],
    ['an unknown type', [{ type: 'triple_click', x: 1, y: 1 }]],
    ['the flat dialect', [{ action: 'left_click', x: 1, y: 1 }]],
    ['a field the type does not read', [{ type: 'wait', duration: 2 }]],
    ['a zero-valued unused field', [{ type: 'keypress', keys: ['a'], x: 0 }]],
    ['a missing y', [{ type: 'move', x: 1 }]],
    ['a coordinate that is not a number', [{ type: 'move', x: '1', y: 2 }]],
    ['a NaN coordinate', [{ type: 'move', x: Number.NaN, y: 2 }]],
    ['a click with no button', [{ type: 'click', x: 1, y: 2 }]],
    ['a click with an unknown button', [{ type: 'click', x: 1, y: 2, button: 'middle' }]],
    ['a one-point drag', [{ type: 'drag', path: [{ x: 1, y: 2 }] }]],
    ['a drag point without y', [{ type: 'drag', path: [{ x: 1, y: 2 }, { x: 3 }] }]],
    [
      'a drag point with a field of its own',
      [
        {
          type: 'drag',
          path: [
            { x: 1, y: 2 },
            { x: 3, y: 4, keys: ['ctrl'] },
          ],
        },
      ],
    ],
    ['a scroll with no scroll_y', [{ type: 'scroll', x: 1, y: 2, scroll_x: 0 }]],
    ['a keypress with no keys', [{ type: 'keypress', keys: [] }]],
    ['keys that are not names', [{ type: 'move', x: 1, y: 2, keys: [1] }]],
    ['an empty type', [{ type: 'type', text: '' }]],
  ];
  it.each(bad)('refuses %s before anything is sent', async (_, actions) => {
    const { rec, computer } = setup();
    const c = await computer();
    const before = rec.calls.length;
    await expect(c.inputBatch(actions as OpenAIComputerAction[])).rejects.toThrow(ValidationError);
    expect(rec.calls).toHaveLength(before);
  });

  it('raises a refusal before dispatch as the ordinary error for its status', async () => {
    const { computer } = setup(
      onInput(() =>
        json({ error: 'computer is not running', reason: 'unavailable' }, { status: 409 }),
      ),
    );
    const err = await (await computer()).inputBatch([{ type: 'wait' }]).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect(err).not.toBeInstanceOf(InputBatchError);
    expect(err.reason).toBe('unavailable');
  });

  it.each([409, 502, 503, 400])(
    'raises a batch that stopped part-way, answered %i, as InputBatchError and never transient',
    async (status) => {
      const { rec, computer } = setup(onInput(() => stopped(2, 2, status)));
      const c = await computer();
      const before = rec.calls.length;
      const err = await c
        .inputBatch([{ type: 'wait' }, { type: 'wait' }, { type: 'move', x: 1, y: 1 }])
        .catch((e) => e);
      expect(err).toBeInstanceOf(InputBatchError);
      expect(err).not.toBeInstanceOf(ConflictError);
      expect(err).not.toBeInstanceOf(ComputerNotRunningError);
      expect(err.status).toBe(status);
      expect(err.message).toContain('batch stopped at action 2');
      expect(err.result).toMatchObject({ ok: false, completed: 2, failedIndex: 2 });
      expect(err.result.results).toHaveLength(2);
      expect(isTransient(err)).toBe(false);
      // Sent once: a batch is never replayed for the caller.
      expect(rec.calls).toHaveLength(before + 1);
    },
  );

  it.each([
    ['cut off', () => new Response('{"ok":false,"completed":2,', { status: 409 })],
    ['empty', () => new Response('', { status: 409 })],
    [
      'a proxy page',
      () =>
        new Response('<html>bad gateway</html>', {
          status: 502,
          headers: { 'content-type': 'text/html' },
        }),
    ],
    [
      'broken off mid-stream',
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"ok":false,'));
              controller.error(new Error('connection reset'));
            },
          }),
          { status: 409, headers: { 'content-type': 'application/json' } },
        ),
    ],
  ])('never calls a failure whose answer is %s worth sending again', async (_, answer) => {
    const { rec, computer } = setup(onInput(() => answer()));
    const c = await computer();
    const before = rec.calls.length;
    const err = await c.inputBatch([{ type: 'wait' }, { type: 'wait' }]).catch((e) => e);
    expect(err).toBeInstanceOf(MandalaError);
    expect(isTransient(err)).toBe(false);
    expect(rec.calls).toHaveLength(before + 1);
  });

  it('keeps a refusal in the ordinary shape as transient as its status says', async () => {
    // The input lane busy: nothing ran, and the platform's word says it clears.
    const { computer } = setup(
      onInput(() => json({ error: 'input is busy', reason: 'contention' }, { status: 409 })),
    );
    const err = await (await computer()).inputBatch([{ type: 'wait' }]).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect(isTransient(err)).toBe(true);
  });

  it('raises a success status carrying a stopped batch the same way', async () => {
    const { computer } = setup(
      onInput(() =>
        json({ ok: false, completed: 0, failed_index: 0, error: 'stopped', results: [] }),
      ),
    );
    const err = await (await computer()).inputBatch([{ type: 'wait' }]).catch((e) => e);
    expect(err).toBeInstanceOf(InputBatchError);
    expect(err.result).toMatchObject({ ok: false, completed: 0, failedIndex: 0 });
  });

  it.each([
    ['completed that does not count results', { ok: true, completed: 2, results: [{ ok: true }] }],
    ['no results', { ok: true, completed: 0 }],
    ['ok that is not a boolean', { ok: 'true', completed: 1, results: [{ ok: true }] }],
    ['a stopped batch that does not say where', { ok: false, completed: 0, results: [] }],
    ['a result without ok', { ok: true, completed: 1, results: [{}] }],
  ])('refuses an answer with %s', async (_, body) => {
    const { computer } = setup(onInput(() => json(body)));
    const err = await (await computer()).inputBatch([{ type: 'wait' }]).catch((e) => e);
    expect(err).toBeInstanceOf(MandalaError);
    expect(err).not.toBeInstanceOf(InputBatchError);
  });

  it('refuses a stopped batch whose answer cannot be read, rather than calling it a conflict', async () => {
    const { computer } = setup(
      onInput(() => json({ ok: false, completed: 'two', results: [] }, { status: 409 })),
    );
    const err = await (await computer()).inputBatch([{ type: 'wait' }]).catch((e) => e);
    expect(err).toBeInstanceOf(MandalaError);
    expect(err).not.toBeInstanceOf(ConflictError);
    expect(isTransient(err)).toBe(false);
  });
});
