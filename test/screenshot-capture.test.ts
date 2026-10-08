/**
 * Cutting a screenshot from a named capture (platform OPL-5852): the name and
 * size a live screenshot reports, `capture` on the way back, and the refusal of
 * a capture the platform has since replaced.
 */

import { describe, expect, it } from 'vitest';
import { Client, ConflictError, isTransient, ValidationError } from '../src/index.js';
import { anyRoute, BASE, json, type Responder, recorder } from './harness.js';

const client = (respond: Responder) => {
  const rec = recorder(respond);
  return { rec, client: new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch }) };
};

const NAME = '00000000000000a7';

/** A screenshot route answering with these headers beside a PNG content type. */
const answering = (headers: Record<string, string>) =>
  client((call) =>
    call.path.endsWith('/screenshot')
      ? new Response(Uint8Array.from([137, 80]), {
          headers: { 'content-type': 'image/png', ...headers },
        })
      : anyRoute(call),
  );

describe('the capture a screenshot names', () => {
  it('is read off a live answer with its size, and sent back as capture', async () => {
    const { rec, client: c } = answering({
      'x-gc-capture': NAME,
      'x-gc-capture-size': '3840x2160',
    });
    const computer = await c.computers.get('vm-1');
    const shot = await computer.screenshotWithInfo(64, { fresh: true });
    expect(shot.capture).toBe(NAME);
    expect(shot.captureSize).toEqual({ width: 3840, height: 2160 });

    await computer.screenshot(undefined, {
      capture: shot.capture,
      region: { x: 10, y: 20, width: 300, height: 200 },
      format: 'png',
    });
    const sent = rec.calls.filter((call) => call.path.endsWith('/screenshot')).at(-1)!;
    expect(sent.query).toEqual({ capture: NAME, region: '10,20,300,200', format: 'png' });
  });

  it.each([
    ['a name that is not one', { 'x-gc-capture': 'not-a-name', 'x-gc-capture-size': '10x10' }],
    ['upper-case hex', { 'x-gc-capture': NAME.toUpperCase(), 'x-gc-capture-size': '10x10' }],
    ['a size that is not one', { 'x-gc-capture': NAME, 'x-gc-capture-size': '10 x 10' }],
    ['a zero size', { 'x-gc-capture': NAME, 'x-gc-capture-size': '0x10' }],
    ['a name without a size', { 'x-gc-capture': NAME }],
    ['a size without a name', { 'x-gc-capture-size': '10x10' }],
    [
      'a saved frame',
      { 'x-gc-frame': 'suspended', 'x-gc-capture': NAME, 'x-gc-capture-size': '10x10' },
    ],
  ])('is absent, with its size, for %s', async (_case, headers) => {
    const { client: c } = answering(headers);
    const shot = await (await c.computers.get('vm-1')).screenshotWithInfo();
    expect(shot.capture).toBeUndefined();
    expect(shot.captureSize).toBeUndefined();
  });

  it('is absent from a platform that does not name its captures', async () => {
    const { client: c } = answering({});
    const shot = await (await c.computers.get('vm-1')).screenshotWithInfo();
    expect(shot).toEqual({
      bytes: Uint8Array.from([137, 80]),
      contentType: 'image/png',
      suspended: false,
    });
  });
});

describe('asking for a named capture', () => {
  it.each([
    ['beside fresh', { capture: NAME, fresh: true }, 'give fresh or capture, not both'],
    ['that is not a name', { capture: 'abc' }, 'capture must be the name a screenshot reported'],
    ['in upper case', { capture: NAME.toUpperCase() }, 'capture must be the name'],
  ])('is refused here %s, before anything is sent', async (_case, opts, says) => {
    const { rec, client: c } = answering({});
    const computer = await c.computers.get('vm-1');
    const before = rec.calls.length;
    const err = await computer.screenshot(undefined, opts).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as Error).message).toContain(says);
    expect(rec.calls.length).toBe(before);
  });

  it('beside fresh: false is a plain pinned read', async () => {
    const { rec, client: c } = answering({});
    await (await c.computers.get('vm-1')).screenshot(undefined, { capture: NAME, fresh: false });
    expect(rec.calls.at(-1)!.query).toEqual({ capture: NAME });
  });

  it('that has been replaced is a permanent conflict, sent once', async () => {
    const { rec, client: c } = client((call) =>
      call.path.endsWith('/screenshot')
        ? json(
            { error: 'the capture you named is no longer held', reason: 'stale_capture' },
            { status: 409, headers: { 'content-type': 'application/json' } },
          )
        : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    const err = await computer.screenshot(undefined, { capture: NAME }).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).reason).toBe('stale_capture');
    // The same request never works again: a new screenshot is the fix.
    expect(isTransient(err)).toBe(false);
    expect(rec.calls.filter((call) => call.path.endsWith('/screenshot'))).toHaveLength(1);
  });
});
