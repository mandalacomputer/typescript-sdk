/**
 * The computer toolset driver (OPL-5851), run through Anthropic's own pipeline.
 *
 * Every case goes in by `toolResult()`, which is the same path the tool runner
 * takes — Anthropic's confirm gate, its input handling and its rendering of the
 * result — and out through a real {@link Client} onto a recorded fetch, so what
 * is asserted is the request the platform would actually receive. The
 * screenshot route is modelled rather than stubbed: it crops and shrinks the
 * way the platform does, because the driver's arithmetic has to agree with the
 * platform's to the pixel and a stub that returned a fixed picture would agree
 * with anything.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { ToolsetConfigError } from '@anthropic-ai/sdk/helpers/beta/toolsets';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { MandalaComputerToolset } from '../src/anthropic.js';
import { Client } from '../src/index.js';
import { BASE, type Call, COMPUTER, errorJson, json, recorder } from './harness.js';

type Size = { width: number; height: number };

/** A PNG's signature and IHDR chunk, which is all of one the driver reads. */
function png({ width, height }: Size): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const v = new DataView(b.buffer);
  v.setUint32(8, 13);
  b.set(
    [...'IHDR'].map((c) => c.charCodeAt(0)),
    12,
  );
  v.setUint32(16, width);
  v.setUint32(20, height);
  return b;
}

function sizeOf(base64: string): Size {
  const b = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const v = new DataView(b.buffer);
  return { width: v.getUint32(16), height: v.getUint32(20) };
}

const fits = (s: Size) =>
  Math.max(s.width, s.height) <= 2576 && Math.ceil(s.width / 28) * Math.ceil(s.height / 28) <= 4784;

/**
 * A computer whose record says `screen` and whose display is `capture` — the
 * two differ on a desktop resumed from a capture taken at another size.
 * `captures` moves the display on, one per screenshot taken.
 */
function desktop(
  screen: Size,
  opts: {
    capture?: Size;
    captures?: Size[];
    input?: (body: Record<string, unknown>) => Response | undefined;
    ignoreWidth?: boolean;
  } = {},
) {
  let capture = opts.capture ?? screen;
  // The platform's frame cache: a request without `fresh` is answered from the
  // last capture taken, as the platform does within its reuse window, and only
  // a fresh one takes a new capture.
  let held: Size | undefined;
  const rec = recorder((call: Call) => {
    if (call.path === '/computers/vm-1') {
      return json({ ...COMPUTER, resolution: `${screen.width}x${screen.height}x24` });
    }
    if (call.path === '/computers/vm-1/screenshot') {
      let src: Size;
      if (call.query.fresh === '1' || !held) {
        src = capture;
        held = capture;
        const next = opts.captures?.shift();
        if (next) capture = next;
      } else {
        src = held;
      }
      if (call.query.region) {
        const [x, y, w, h] = call.query.region.split(',').map(Number) as [
          number,
          number,
          number,
          number,
        ];
        if (x + w > src.width || y + h > src.height) {
          return errorJson(400, `region reaches past the ${src.width}x${src.height} screen`);
        }
        src = { width: w, height: h };
      }
      let out = src;
      if (call.query.w && !opts.ignoreWidth) {
        const w = Math.min(Math.max(Number(call.query.w), 64), src.width);
        out = { width: w, height: Math.max(1, Math.floor((src.height * w) / src.width)) };
      }
      return new Response(png(out), { headers: { 'content-type': 'image/png' } });
    }
    if (call.path === '/computers/vm-1/input') {
      return opts.input?.(call.body as Record<string, unknown>) ?? json({ ok: true });
    }
    return errorJson(404, `no route ${call.path}`);
  });
  const client = new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch });
  const inputs = () =>
    rec.calls
      .filter((c) => c.path.endsWith('/input'))
      .map((c) => c.body as Record<string, unknown>);
  const shots = () => rec.calls.filter((c) => c.path.endsWith('/screenshot')).map((c) => c.query);
  return { client, rec, inputs, shots };
}

async function toolset(d: ReturnType<typeof desktop>) {
  const computer = await d.client.computers.get('vm-1');
  return new MandalaComputerToolset(computer, { confirm: () => true });
}

let n = 0;
const use = (name: string, input: Record<string, unknown> = {}) => ({
  type: 'tool_use' as const,
  id: `toolu_${++n}`,
  name,
  toolset_name: 'computer',
  input,
});

type Result = { content?: unknown; is_error?: boolean; toolset_name?: string | null };
/** Where an input landed: the SDK sends a click's point as `x`/`y`, a drag's as `coordinate`. */
const at = (b: Record<string, unknown> | undefined) => (b?.coordinate ?? [b?.x, b?.y]) as number[];
const text = (r: Result) =>
  (r.content as { type: string; text?: string }[])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
const image = (r: Result) =>
  (r.content as { type: string; source?: { data: string } }[]).find((b) => b.type === 'image')!
    .source!.data;

describe('constructing the toolset', () => {
  it('needs a confirm callable while it can type, as Anthropic’s class requires', async () => {
    const d = desktop({ width: 1280, height: 800 });
    const computer = await d.client.computers.get('vm-1');
    expect(() => new MandalaComputerToolset(computer)).toThrow(ToolsetConfigError);
    // And not once the members that need one are off.
    const quiet = new MandalaComputerToolset(computer, {
      configs: { type: { enabled: false }, key: { enabled: false }, hold_key: { enabled: false } },
    });
    expect(quiet.toJSON().configs).toMatchObject({ type: { enabled: false } });
  });

  it('serves every member, so the tool entry turns none of them off', async () => {
    const t = await toolset(desktop({ width: 1280, height: 800 }));
    expect(t.toJSON()).toEqual({ type: 'computer_toolset_20260801' });
  });

  it('leaves the computer alone when it is closed', async () => {
    const d = desktop({ width: 1280, height: 800 });
    const t = await toolset(d);
    const before = d.rec.calls.length;
    await t.close();
    expect(d.rec.calls.length).toBe(before);
  });
});

describe('screenshots and points', () => {
  it('photographs a screen that fits whole, fresh, and passes points straight through', async () => {
    const d = desktop({ width: 1920, height: 1080 });
    const t = await toolset(d);
    const shot = await t.toolResult(use('screenshot'));
    expect(sizeOf(image(shot))).toEqual({ width: 1920, height: 1080 });
    expect(d.shots()).toEqual([{ fresh: '1' }]);
    await t.toolResult(use('left_click', { coordinate: [100, 200], text: 'ctrl+shift' }));
    expect(d.inputs()[0]).toMatchObject({ action: 'left_click' });
    expect(at(d.inputs()[0])).toEqual([100, 200]);
    expect(JSON.stringify(d.inputs()[0])).toContain('shift');
  });

  it('shrinks a screen too large for the model, and scales its points back up', async () => {
    const d = desktop({ width: 3840, height: 2160 });
    const t = await toolset(d);
    const shot = sizeOf(image(await t.toolResult(use('screenshot'))));
    expect(fits(shot)).toBe(true);
    expect(d.shots()[0]).toMatchObject({ w: String(shot.width), format: 'png', fresh: '1' });
    await t.toolResult(
      use('left_click', { coordinate: [Math.floor(shot.width / 2), Math.floor(shot.height / 2)] }),
    );
    const [x, y] = at(d.inputs()[0]);
    expect(Math.abs(x! - 1920)).toBeLessThanOrEqual(2);
    expect(Math.abs(y! - 1080)).toBeLessThanOrEqual(2);
  });

  it('scales from the picture it measured, not the one it asked for', async () => {
    // A desktop still at its capture's 1280x800 while its record says
    // 1920x1080: the platform takes points in the record's pixels.
    const d = desktop({ width: 1920, height: 1080 }, { capture: { width: 1280, height: 800 } });
    const t = await toolset(d);
    expect(sizeOf(image(await t.toolResult(use('screenshot'))))).toEqual({
      width: 1280,
      height: 800,
    });
    await t.toolResult(use('left_click', { coordinate: [640, 400] }));
    expect(at(d.inputs()[0])).toEqual([960, 540]);
  });

  it('retakes a picture too large for the model, sized past the platform’s rounding', async () => {
    // A record of 3840x2160 over a display of 3008x2000: the first picture,
    // 2576 wide, has too many tiles, and a retake worked out from its rounded
    // height came back one row over the limit.
    const d = desktop({ width: 3840, height: 2160 }, { capture: { width: 3008, height: 2000 } });
    const t = await toolset(d);
    const shot = sizeOf(image(await t.toolResult(use('screenshot'))));
    expect(fits(shot)).toBe(true);
    expect(d.shots()).toHaveLength(2);
    // And asked for at that size from then on.
    await t.toolResult(use('screenshot'));
    expect(d.shots()[2]!.w).toBe(d.shots()[1]!.w);
  });

  it('refuses rather than returns a picture that still does not fit', async () => {
    const d = desktop(
      { width: 1280, height: 800 },
      { capture: { width: 3840, height: 2160 }, ignoreWidth: true },
    );
    const t = await toolset(d);
    const r = await t.toolResult(use('screenshot'));
    expect(r.is_error).toBe(true);
    expect(text(r)).toContain('larger than the model can be shown');
  });

  it('refuses the first point after the screen changes size, then takes the next', async () => {
    // A point chosen before the model saw the new size is in the old picture's
    // pixels, and nothing in a call says which picture it was aimed at.
    const d = desktop(
      { width: 1920, height: 1080 },
      { capture: { width: 1280, height: 800 }, captures: [{ width: 1920, height: 1080 }] },
    );
    const t = await toolset(d);
    await t.toolResult(use('screenshot'));
    await t.toolResult(use('screenshot'));
    const refused = await t.toolResult(use('left_click', { coordinate: [640, 400] }));
    expect(refused.is_error).toBe(true);
    expect(text(refused)).toContain('screenshots are now 1920x1080');
    expect(d.inputs()).toHaveLength(0);
    await t.toolResult(use('left_click', { coordinate: [640, 400] }));
    expect(at(d.inputs()[0])).toEqual([640, 400]);
  });

  it.each([
    ['outside the picture', [1280, 0], 'outside the 1280x800 screenshot'],
    ['negative', [-1, 5], 'outside'],
    ['one number', [10], 'must be [x, y]'],
    ['strings', ['10', '20'], 'must be [x, y]'],
  ])('refuses a point %s without touching the desktop', async (_name, coordinate, says) => {
    const d = desktop({ width: 1280, height: 800 });
    const t = await toolset(d);
    const r = await t.toolResult(use('left_click', { coordinate }));
    expect(r.is_error).toBe(true);
    expect(text(r)).toContain(says);
    expect(d.inputs()).toHaveLength(0);
  });

  it('requires the points mouse_move and left_click_drag cannot do without', async () => {
    const d = desktop({ width: 1280, height: 800 });
    const t = await toolset(d);
    expect((await t.toolResult(use('mouse_move', {}))).is_error).toBe(true);
    expect((await t.toolResult(use('left_click_drag', { coordinate: [5, 5] }))).is_error).toBe(
      true,
    );
    expect(d.inputs()).toHaveLength(0);
    await t.toolResult(
      use('left_click_drag', { start_coordinate: [1, 2], coordinate: [30, 40], text: 'shift' }),
    );
    expect(d.inputs()[0]).toMatchObject({
      action: 'left_click_drag',
      start_coordinate: [1, 2],
      coordinate: [30, 40],
    });
  });

  it('answers the pointer in the picture’s pixels, and refuses one nothing has placed', async () => {
    let known = true;
    const d = desktop(
      { width: 3840, height: 2160 },
      {
        input: (b) =>
          b.action === 'cursor_position' ? json({ known, x: 1920, y: 1080 }) : undefined,
      },
    );
    const t = await toolset(d);
    const shot = sizeOf(image(await t.toolResult(use('screenshot'))));
    const at = await t.toolResult(use('cursor_position'));
    expect(text(at)).toBe(
      `X=${Math.floor((1920 * shot.width) / 3840)},Y=${Math.floor((1080 * shot.height) / 2160)}`,
    );
    known = false;
    expect((await t.toolResult(use('cursor_position'))).is_error).toBe(true);
  });
});

describe('zoom', () => {
  it('crops the capture’s pixels for the rectangle the model drew, shrunk to fit', async () => {
    const d = desktop({ width: 3840, height: 2160 });
    const t = await toolset(d);
    const shot = sizeOf(image(await t.toolResult(use('screenshot'))));
    const r = await t.toolResult(use('zoom', { region: [0, 0, shot.width, shot.height] }));
    expect(fits(sizeOf(image(r)))).toBe(true);
    // Measured off a capture taken whole, then cut from that same capture.
    expect(d.shots()[1]).toEqual({ fresh: '1' });
    expect(d.shots()[2]).toMatchObject({ region: '0,0,3840,2160', format: 'png' });
    expect(d.shots()[2]!.fresh).toBeUndefined();
  });

  it('takes a small region whole', async () => {
    const d = desktop({ width: 1280, height: 800 });
    const t = await toolset(d);
    await t.toolResult(use('screenshot'));
    const r = await t.toolResult(use('zoom', { region: [100, 100, 300, 200] }));
    expect(sizeOf(image(r))).toEqual({ width: 200, height: 100 });
    expect(d.shots()[2]).toMatchObject({ region: '100,100,200,100' });
    expect(d.shots()[2]!.w).toBeUndefined();
  });

  it('maps the region into a capture of another size than the record (found in review)', async () => {
    // A 3200x1800 capture under a 3840x2160 record shrinks to the same
    // 2576x1449 picture a 3840x2160 capture does, so the picture alone cannot
    // say which; the capture is measured.
    const d = desktop({ width: 3840, height: 2160 }, { capture: { width: 3200, height: 1800 } });
    const t = await toolset(d);
    expect(sizeOf(image(await t.toolResult(use('screenshot'))))).toEqual({
      width: 2576,
      height: 1449,
    });
    const r = await t.toolResult(use('zoom', { region: [1000, 500, 1200, 700] }));
    expect(r.is_error).toBeUndefined();
    expect(d.shots()[2]).toMatchObject({ region: '1242,621,249,249' });
  });

  it('cuts the crop from the capture it measured, not a later one (found in re-review)', async () => {
    // The display goes from 3200x1800 to 3840x2160 after the measurement. A
    // second fresh capture would be cut with the first one's arithmetic.
    const d = desktop(
      { width: 3840, height: 2160 },
      {
        capture: { width: 3200, height: 1800 },
        captures: [
          { width: 3200, height: 1800 },
          { width: 3840, height: 2160 },
        ],
      },
    );
    const t = await toolset(d);
    await t.toolResult(use('screenshot'));
    const r = await t.toolResult(use('zoom', { region: [1000, 500, 1200, 700] }));
    expect(r.is_error).toBeUndefined();
    expect(d.shots()[2]).toMatchObject({ region: '1242,621,249,249' });
    expect(d.shots()[2]!.fresh).toBeUndefined();
  });

  it('maps the region into an unshrunk capture smaller than the record', async () => {
    const d = desktop({ width: 1920, height: 1080 }, { capture: { width: 1280, height: 800 } });
    const t = await toolset(d);
    await t.toolResult(use('screenshot'));
    await t.toolResult(use('zoom', { region: [100, 100, 300, 200] }));
    expect(d.shots()[2]).toMatchObject({ region: '100,100,200,100' });
  });

  it('refuses a region outside the picture, and any region before a picture', async () => {
    const d = desktop({ width: 1280, height: 800 });
    const t = await toolset(d);
    const early = await t.toolResult(use('zoom', { region: [0, 0, 100, 100] }));
    expect(text(early)).toContain('take a screenshot before zooming');
    await t.toolResult(use('screenshot'));
    expect((await t.toolResult(use('zoom', { region: [0, 0, 2000, 10] }))).is_error).toBe(true);
    expect(d.shots()).toHaveLength(1);
  });
});

describe('the keyboard', () => {
  it('presses a repeated key once per press', async () => {
    const d = desktop({ width: 1280, height: 800 });
    const t = await toolset(d);
    await t.toolResult(use('key', { text: 'ctrl+Tab', repeat: 3 }));
    expect(d.inputs()).toHaveLength(3);
    expect(d.inputs().every((b) => b.action === 'key')).toBe(true);
    expect(JSON.stringify(d.inputs()[0])).not.toContain('repeat');
  });

  it.each([0, 101, 2.5, '3'])('refuses a repeat of %j before pressing anything', async (repeat) => {
    const d = desktop({ width: 1280, height: 800 });
    const t = await toolset(d);
    const r = await t.toolResult(use('key', { text: 'Tab', repeat }));
    expect(r.is_error).toBe(true);
    expect(text(r)).toBe('repeat must be a whole number from 1 to 100');
    expect(d.inputs()).toHaveLength(0);
  });

  it('says how far a repeated key got', async () => {
    let pressed = 0;
    const d = desktop(
      { width: 1280, height: 800 },
      { input: () => (++pressed > 2 ? errorJson(409, 'the guest went away') : undefined) },
    );
    const t = await toolset(d);
    const r = await t.toolResult(use('key', { text: 'Tab', repeat: 4 }));
    expect(r.is_error).toBe(true);
    expect(text(r)).toMatch(/^pressed 2 of 4 times, then: .*the guest went away/);
  });

  it('types long text in pieces the platform takes, without splitting a character', async () => {
    const d = desktop({ width: 1280, height: 800 });
    const t = await toolset(d);
    const long = `${'a'.repeat(399)}😀${'b'.repeat(500)}`;
    await t.toolResult(use('type', { text: long }));
    const pieces = d.inputs().map((b) => b.text as string);
    expect(pieces.map((p) => [...p].length)).toEqual([400, 400, 100]);
    expect(pieces.join('')).toBe(long);
  });

  it('holds a key for at most the platform’s 30 seconds', async () => {
    const d = desktop({ width: 1280, height: 800 });
    const t = await toolset(d);
    expect((await t.toolResult(use('hold_key', { text: 'shift', duration: 31 }))).is_error).toBe(
      true,
    );
    await t.toolResult(use('hold_key', { text: 'shift', duration: 2 }));
    expect(d.inputs()).toEqual([expect.objectContaining({ action: 'hold_key', duration: 2 })]);
  });
});

describe('scrolling and waiting', () => {
  it('scrolls where it is told, holding what it is told', async () => {
    const d = desktop({ width: 1280, height: 800 });
    const t = await toolset(d);
    await t.toolResult(
      use('scroll', {
        coordinate: [10, 20],
        scroll_direction: 'up',
        scroll_amount: 5,
        text: 'ctrl',
      }),
    );
    expect(d.inputs()[0]).toMatchObject({
      action: 'scroll',
      coordinate: [10, 20],
      scroll_direction: 'up',
    });
    for (const bad of [
      { scroll_direction: 'sideways', scroll_amount: 3 },
      { scroll_direction: 'down', scroll_amount: 51 },
      { scroll_direction: 'down', scroll_amount: 0 },
    ]) {
      expect((await t.toolResult(use('scroll', bad))).is_error).toBe(true);
    }
    expect(d.inputs()).toHaveLength(1);
  });

  it('waits out the toolset’s longer waits in the platform’s 30-second pieces', async () => {
    const d = desktop({ width: 1280, height: 800 });
    const t = await toolset(d);
    await t.toolResult(use('wait', { duration: 75 }));
    expect(d.inputs().map((b) => b.duration)).toEqual([30, 30, 15]);
    for (const duration of [0, -1, 301, Number.NaN]) {
      expect((await t.toolResult(use('wait', { duration }))).is_error).toBe(true);
    }
    expect(d.inputs()).toHaveLength(3);
  });
});

describe('failures', () => {
  it('tells the model what the platform said, as an error result', async () => {
    const d = desktop(
      { width: 1280, height: 800 },
      { input: () => errorJson(409, 'computer vm-1 is stopped') },
    );
    const t = await toolset(d);
    const r = await t.toolResult(use('left_click', { coordinate: [1, 1] }));
    expect(r).toMatchObject({ is_error: true, toolset_name: 'computer' });
    expect(text(r)).toContain('computer vm-1 is stopped');
  });
});

describe('under Anthropic’s tool runner', () => {
  it('is a tools entry the runner sends and answers', async () => {
    const t = await toolset(desktop({ width: 1280, height: 800 }));
    const message = (content: unknown[], stop_reason: string) => ({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5-5',
      content,
      stop_reason,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const replies = [
      message(
        [
          {
            type: 'tool_use',
            id: 'toolu_a',
            name: 'left_click',
            toolset_name: 'computer',
            input: { coordinate: [5, 5] },
          },
          {
            type: 'tool_use',
            id: 'toolu_b',
            name: 'screenshot',
            toolset_name: 'computer',
            input: {},
          },
        ],
        'tool_use',
      ),
      message([{ type: 'text', text: 'done' }], 'end_turn'),
    ];
    const sent: { tools: unknown[]; messages: { role: string; content: unknown }[] }[] = [];
    const anthropic = new Anthropic({
      apiKey: 'sk-ant-fixture-only',
      fetch: (async (_url: unknown, init?: RequestInit) => {
        sent.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify(replies.shift()), {
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch,
    });
    const runner = anthropic.beta.messages.toolRunner({
      model: 'claude-opus-5-5',
      max_tokens: 1024,
      tools: [t],
      messages: [{ role: 'user', content: 'go' }],
    });
    for await (const _ of runner) {
      // drained
    }
    expect(sent[0]!.tools).toEqual([{ type: 'computer_toolset_20260801' }]);
    const answers = sent[1]!.messages.at(-1)!.content as Result[];
    expect(answers.map((r) => r.toolset_name)).toEqual(['computer', 'computer']);
    expect(sizeOf(image(answers[1]!))).toEqual({ width: 1280, height: 800 });
  });
});

describe('the optional peer', () => {
  it('is imported by this module alone, so the package root needs none of it', () => {
    const src = new URL('../src/', import.meta.url);
    const importers = readdirSync(src).filter(
      (f) =>
        f.endsWith('.ts') &&
        readFileSync(new URL(f, src), 'utf8').includes("from '@anthropic-ai/sdk"),
    );
    expect(importers).toEqual(['anthropic.ts']);
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(pkg.peerDependenciesMeta['@anthropic-ai/sdk']).toEqual({ optional: true });
    expect(pkg.exports['./anthropic']).toEqual({
      types: './dist/anthropic.d.ts',
      default: './dist/anthropic.js',
    });
    expect(pkg.dependencies?.['@anthropic-ai/sdk']).toBeUndefined();
  });
});

describe('the README example', () => {
  // A whole program check of both packages' declarations, which takes seconds
  // and more under a parallel suite's load: given room rather than the default.
  it('type-checks against the installed declarations of both packages', { timeout: 60_000 }, () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    const start = '<!-- anthropic-toolset-example:start -->';
    const end = '<!-- anthropic-toolset-example:end -->';
    expect(readme.split(start)).toHaveLength(2);
    const section = readme.slice(readme.indexOf(start) + start.length, readme.indexOf(end)).trim();
    const match = /^```ts\r?\n([\s\S]*?)\r?\n```$/.exec(section);
    expect(match?.[1]).toBeTruthy();
    // This package's own names point at its source, which is what `dist`
    // is built from; Anthropic's resolve to the installed declarations.
    const source = match![1]!
      .replace(`from 'mandala-computer/anthropic'`, `from './src/anthropic.js'`)
      .replace(`from 'mandala-computer'`, `from './src/index.js'`);
    const root = fileURLToPath(new URL('../', import.meta.url));
    const filename = `${root}__anthropic_readme__.mts`;
    const config = ts.readConfigFile(`${root}tsconfig.json`, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
    const options = { ...parsed.options, noEmit: true };
    const host = ts.createCompilerHost(options);
    const original = host.getSourceFile.bind(host);
    host.getSourceFile = (path, version, onError, create) =>
      path === filename
        ? ts.createSourceFile(path, source, version, true)
        : original(path, version, onError, create);
    const program = ts.createProgram([filename], options, host);
    const errors = ts
      .getPreEmitDiagnostics(program)
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
    expect(errors).toEqual([]);
  });
});

describe('what the review found in the keyboard (OPL-5851)', () => {
  it.each(['+Delete', 'ctrl++', 'ctrl+ +s'])(
    'refuses the chord %j rather than pressing part of it',
    async (chord) => {
      const d = desktop({ width: 1280, height: 800 });
      const t = await toolset(d);
      const r = await t.toolResult(use('key', { text: chord }));
      expect(r.is_error).toBe(true);
      expect(text(r)).toContain('the + key itself is plus');
      expect(d.inputs()).toHaveLength(0);
    },
  );

  it('refuses a click whose modifiers are a bare +, and clicks with none when there are none', async () => {
    const d = desktop({ width: 1280, height: 800 });
    const t = await toolset(d);
    expect(
      (await t.toolResult(use('left_click', { coordinate: [1, 1], text: '+' }))).is_error,
    ).toBe(true);
    expect(d.inputs()).toHaveLength(0);
    await t.toolResult(use('left_click', { coordinate: [1, 1], text: '' }));
    expect(d.inputs()).toHaveLength(1);
  });

  it('never ends a piece of text between the halves of a CRLF', async () => {
    const d = desktop({ width: 1280, height: 800 });
    const t = await toolset(d);
    const typed = `${'a'.repeat(399)}\r\nb`;
    await t.toolResult(use('type', { text: typed }));
    const sent = d.inputs().map((b) => b.text as string);
    expect(sent).toEqual(['a'.repeat(399), '\r\nb']);
    expect(sent.join('')).toBe(typed);
  });

  it('says how much was typed when a later piece fails', async () => {
    let n = 0;
    const d = desktop(
      { width: 1280, height: 800 },
      { input: () => (++n > 1 ? errorJson(409, 'computer vm-1 is stopped') : undefined) },
    );
    const t = await toolset(d);
    const r = await t.toolResult(use('type', { text: `${'a'.repeat(400)}${'b'.repeat(450)}` }));
    expect(r.is_error).toBe(true);
    expect(text(r)).toMatch(/^typed 400 of 850 characters, then: .*computer vm-1 is stopped/);
    expect(text(r)).toContain('may have been typed in part');
  });
});
