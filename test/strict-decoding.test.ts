/**
 * Rows and flags the decoder cannot read fail the call rather than being
 * dropped or read as false (OPL-6079). The same rule in all three clients.
 */

import { describe, expect, it } from 'vitest';
import { Client } from '../src/index.js';
import {
  anyRoute,
  BASE,
  BUILD_PROGRESS,
  json,
  type Responder,
  recorder,
  USAGE,
} from './harness.js';

const client = (respond: Responder) =>
  new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: recorder(respond).fetch });

const usageWith = (computers: unknown) =>
  client((call) =>
    call.path === '/usage'
      ? json({ ...USAGE, usage: { ...USAGE.usage, computers } })
      : anyRoute(call),
  );

describe('usage.read', () => {
  it.each([
    ['a row that is not an object', [null]],
    ['a breakdown that is not a list', 'broken'],
    ['a row with no id', [{ name: 'demo' }]],
    ['an unreadable gone', [{ id: 'vm-1', name: 'demo', gone: 'maybe' }]],
  ])('refuses %s', async (_, computers) => {
    await expect(usageWith(computers).usage.read()).rejects.toThrow(/expected usage computer/);
  });

  it('still reads an absent breakdown as withheld, and a missing gone as false', async () => {
    const withheld = await usageWith(undefined).usage.read();
    expect([withheld.breakdown, withheld.usage.computers]).toEqual([false, []]);
    const r = await usageWith([{ id: 'vm-1', name: 'demo' }]).usage.read();
    expect(r.usage.computers[0]?.gone).toBe(false);
  });
});

describe('builds.progress', () => {
  it.each([
    ['a step that is not an object', [null]],
    ['steps that are not a list', 'three'],
  ])('refuses %s', async (_, steps) => {
    const c = client((call) =>
      call.path.endsWith('/progress') ? json({ ...BUILD_PROGRESS, steps }) : anyRoute(call),
    );
    await expect(c.builds.progress('bld-1')).rejects.toThrow(/expected build step/);
  });
});
