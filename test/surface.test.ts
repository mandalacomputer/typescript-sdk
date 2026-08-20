/**
 * Pins the SDK to the platform's curated /api/v1 surface.
 *
 * The platform allowlists routes server-side; anything else 404s. That check
 * lives there, but a client that calls a route the platform does not expose
 * fails at runtime in a user's hands rather than here.
 */

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { Client, VERSION } from '../src/index.js';
import { ALLOWED, patternFor, UNIMPLEMENTED } from './allowlist.js';
import { anyRoute, BASE, recorder } from './harness.js';

/** Call every method the SDK exposes that performs a request. */
async function exerciseEverything(client: Client): Promise<void> {
  await client.templates.list();
  await client.sizes.list();
  await client.computers.list();
  await client.computers.list({ allowPartial: true });
  await client.computers.get('vm-1');

  const c = await client.computers.create({ template: 'base' });
  await c.refresh();
  await c.start();
  await c.stop();
  await c.suspend();
  await c.restart();
  await c.clone('copy');
  await c.rename('renamed');
  await c.update({ cpu: 4 });

  await c.screenshot();
  await c.screenshot(320);
  await c.windows();
  await c.windows({ includeAll: true });
  await c.windowAction('0x1', 'focus');
  await c.windowAction('0x1', 'move', { x: 10, y: 20 });

  await c.move(1, 2);
  await c.click(1, 2);
  await c.click();
  await c.click(1, 2, ['shift']);
  await c.rightClick(1, 2);
  await c.middleClick(1, 2);
  await c.doubleClick(1, 2);
  await c.tripleClick(1, 2);
  await c.drag(9, 9, { x: 1, y: 2 });
  await c.mouseDown(1, 2);
  await c.mouseUp();
  await c.scroll(1, 2, { direction: 'up' });
  await c.scroll(undefined, undefined, { direction: 'right', modifiers: ['shift'] });
  await c.type('hi');
  await c.key('ctrl', 'c');
  await c.holdKey(['shift'], 1);
  await c.wait(1);
  await c.cursorPosition();

  await c.exec('true');
  await c.execBackground('sleep 100');
  await c.execPoll(42);
  await c.execKill(42);
  await c.open('https://example.com');

  await c.readFile('/home/user/out.txt');
  await c.writeFile('/home/user/in.txt', 'hello');

  await c.snapshot();
  await c.snapshot({ memory: true });
  await c.holdings();
  await c.schedule();
  await c.setSchedule({ enabled: true, hour: 4 });
  await c.clearSchedule();

  await c.agentOnce({ prompt: 'do a thing', modelKey: 'sk-test' });

  await client.snapshots.list();
  await client.snapshots.list({ computerId: 'vm-1', includeUnfinished: true });
  await client.snapshots.restore('snap-1');
  await client.snapshots.clone('snap-1');
  await client.snapshots.delete('snap-1');

  await c.delete();
}

const exercised = async (): Promise<Set<string>> => {
  const rec = recorder(anyRoute);
  await exerciseEverything(new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch }));
  return new Set(rec.routes().map(([m, p]) => `${m} ${patternFor(p)}`));
};

describe('surface', () => {
  it('every call lands on an allowlisted route', async () => {
    const called = await exercised();
    expect(called.size).toBeGreaterThan(0);
    const outside = [...called].filter((r) => !ALLOWED.has(r)).sort();
    expect(outside, 'SDK calls routes the platform does not expose').toEqual([]);
  });

  it('the unreached part of the surface is exactly what we think', async () => {
    const called = await exercised();
    const unreached = [...ALLOWED].filter((r) => !called.has(r)).sort();
    expect(unreached).toEqual([...UNIMPLEMENTED].sort());
  });

  it('reaches the routes that a v1-era client does not know exist', async () => {
    // Named individually rather than left to the count above, because these are
    // the ones a client written against the original surface silently lacks —
    // three of them were added to the platform without any client's mirror
    // learning about them, which is what scripts/check-surface.mjs now catches.
    // Asserted here so a refactor cannot quietly drop the harder half of the
    // surface while the two tests above stay green.
    const called = await exercised();
    for (const route of [
      'GET computers/:id/exec/:pid',
      'DELETE computers/:id/exec/:pid',
      'GET computers/:id/snapshots',
      'GET computers/:id/windows',
      'POST computers/:id/windows/:window',
      'POST computers/:id/agent',
    ]) {
      expect(called, route).toContain(route);
    }
  });

  it('does not reach the daemon internal routes', async () => {
    // The ops and plan-owned endpoints are not tenant API and never should be.
    // The test above proves the SDK stays inside ALLOWED; this proves ALLOWED
    // itself stays honest, so widening it later is a deliberate act rather than
    // a quiet one. These routes are not owner-scoped in the daemon.
    const internal = new Set(['audit', 'host', 'fleet', 'retention']);
    const heads = new Set([...ALLOWED].map((r) => r.split(' ')[1]!.split('/')[0]!));
    expect([...heads].filter((h) => internal.has(h))).toEqual([]);
  });

  it('patternFor treats ids as ids', () => {
    expect(patternFor('computers/vm-1/start')).toBe('computers/:id/start');
    expect(patternFor('snapshots/snap-1/clone')).toBe('snapshots/:id/clone');
    expect(patternFor('computers/vm-1/snapshots')).toBe('computers/:id/snapshots');
    expect(patternFor('computers/vm-1/exec/42')).toBe('computers/:id/exec/:pid');
    expect(patternFor('computers/vm-1/windows/0x2600003')).toBe('computers/:id/windows/:window');
    // A computer whose id looks like a route segment is still an id.
    expect(patternFor('computers/audit')).toBe('computers/:id');
    // And what follows such an id is still what it is. Keyed off the raw
    // previous segment, an id spelled 'exec' or 'windows' made the action after
    // it a ':pid' or a ':window' — a shape no route has, failing this suite for
    // a reason nothing about the failure would explain.
    expect(patternFor('computers/exec/start')).toBe('computers/:id/start');
    expect(patternFor('computers/windows/exec/42')).toBe('computers/:id/exec/:pid');
    expect(patternFor('snapshots/snapshots/restore')).toBe('snapshots/:id/restore');
  });

  it('exports a VERSION that matches the package', async () => {
    // A mirror nobody compares is just a comment — the reason this file exists
    // for the route table, applied to the other constant that duplicates
    // something outside the source. They agree today; the first release bump is
    // what would silently part them.
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    };
    expect(VERSION).toBe(pkg.version);
  });
});
