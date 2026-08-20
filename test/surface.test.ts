/**
 * Pins the SDK to the platform's curated /api/v1 surface — the routes, and the
 * parameters each route takes.
 *
 * The platform allowlists routes server-side; anything else 404s. That check
 * lives there, but a client that calls a route the platform does not expose
 * fails at runtime in a user's hands rather than here.
 *
 * The parameter half is here for a failure the route half cannot see. A route
 * this SDK reaches without the argument that made it worth reaching passes
 * every test below the first two: `stop` was reachable and `force` was not, so
 * there was no answer for a guest that would not shut down, and `screenshot`
 * was reachable and `fresh` was not, so every drive loop read a frame that
 * could predate its own last click. Nothing was red.
 */

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { Client, VERSION } from '../src/index.js';
import {
  ALLOWED,
  PARAMETERS,
  patternFor,
  UNIMPLEMENTED,
  UNIMPLEMENTED_PARAMETERS,
} from './allowlist.js';
import { anyRoute, BASE, type Call, recorder } from './harness.js';

/**
 * Call every method the SDK exposes that performs a request.
 *
 * Every optional argument is given somewhere, because this drives the parameter
 * coverage test as well as the route one: a parameter no call here passes is
 * one the test cannot tell from a parameter the SDK cannot send.
 */
async function exerciseEverything(client: Client): Promise<void> {
  await client.templates.list();
  await client.sizes.list();
  await client.computers.list();
  await client.computers.list({ allowPartial: true });
  await client.computers.get('vm-1');

  const c = await client.computers.create({ template: 'base' });
  // A size names a template and a shape together, so the two spellings of a
  // create cannot be one call — see createBody.
  await client.computers.create({
    size: 'large',
    name: 'from-a-size',
    resolution: '1920x1080x24',
    start: false,
  });
  await client.computers.create({ template: 'base', cpu: 2, ramMb: 4096, diskGb: 40 });
  await c.refresh();
  await c.start();
  await c.stop();
  await c.stop({ force: true });
  await c.suspend();
  await c.restart();
  await c.clone('copy');
  await c.rename('renamed');
  await c.update({ cpu: 4 });
  await c.update({ name: 'resized', ramMb: 8192, diskGb: 80, idleSuspendMin: 30 });

  await c.screenshot();
  await c.screenshot(320);
  await c.screenshot(undefined, { fresh: true });
  await c.windows();
  await c.windows({ includeAll: true });
  await c.windowAction('0x1', 'focus');
  await c.windowAction('0x1', 'move', { x: 10, y: 20 });
  await c.windowAction('0x1', 'resize', { width: 800, height: 600 });

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
  await c.exec('make', { timeoutS: 60, desktop: true, cwd: '/src', env: { CI: '1' } });
  await c.execBackground('sleep 100');
  await c.execBackground('make', { desktop: true, cwd: '/src', env: { CI: '1' } });
  await c.execPoll(42);
  await c.execKill(42);
  await c.open('https://example.com');

  await c.readFile('/home/user/out.txt');
  await c.writeFile('/home/user/in.txt', 'hello');

  await c.snapshot();
  await c.snapshot({ memory: true, name: 'before-upgrade' });
  await c.holdings();
  await c.schedule();
  await c.setSchedule({ enabled: true, hour: 4 });
  await c.setSchedule({ enabled: true, hour: 3, minute: 30, tz: 'Europe/London' });
  await c.clearSchedule();

  await c.agentOnce({ prompt: 'do a thing', modelKey: 'sk-test' });
  await c.agentOnce({
    prompt: 'do a thing',
    system: 'be brief',
    maxSteps: 5,
    model: 'claude-opus-5',
    modelKey: 'sk-test',
  });

  await client.snapshots.list();
  await client.snapshots.list({
    computerId: 'vm-1',
    includeUnfinished: true,
    allowPartial: true,
  });
  await client.snapshots.restore('snap-1');
  await client.snapshots.clone('snap-1');
  await client.snapshots.clone('snap-1', 'from-snapshot');
  await client.snapshots.delete('snap-1');

  // Last, and both shapes: the purge is what `expect` binds, and a delete that
  // keeps the snapshots sends neither key.
  await (await client.computers.get('vm-2')).delete({ deleteSnapshots: true, expect: 'abc123' });
  await c.delete();
}

/** Every call the SDK made, with its route reduced to a pattern. */
const record = async (): Promise<Call[]> => {
  const rec = recorder(anyRoute);
  await exerciseEverything(new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch }));
  return rec.calls;
};

const routeOf = (call: Call): string => `${call.method} ${patternFor(call.path)}`;

const exercised = async (): Promise<Set<string>> => new Set((await record()).map(routeOf));

/**
 * The headers the platform documents as parameters, anywhere on the surface.
 *
 * Every request also carries `Authorization`, `Accept` and a `Content-Type`.
 * None is a parameter of a route — they are how any request is made rather than
 * what this one asks for — so they are not in the platform's table and must not
 * be compared against it. Restricting to the documented names rather than
 * excluding the three by hand means a header the platform adds later is
 * compared, instead of quietly falling through a denylist nobody updated.
 */
const DOCUMENTED_HEADERS: ReadonlySet<string> = new Set(
  [...PARAMETERS.values()].flat().flatMap((p) => (p.startsWith('header:') ? [p.slice(7)] : [])),
);

/** What one call actually carried, in the mirror's spelling. */
function parametersOf(call: Call): string[] {
  const sent = [
    ...Object.keys(call.query).map((k) => `query:${k}`),
    ...Object.keys(call.headers)
      .filter((h) => DOCUMENTED_HEADERS.has(h))
      .map((h) => `header:${h}`),
  ];
  // Only an object body has named fields. A file upload's body is the file.
  if (call.body && typeof call.body === 'object' && !Array.isArray(call.body)) {
    sent.push(...Object.keys(call.body).map((k) => `body:${k}`));
  }
  return sent;
}

/** Everything the SDK sent, by route. */
async function sentParameters(): Promise<Map<string, Set<string>>> {
  const byRoute = new Map<string, Set<string>>();
  for (const call of await record()) {
    const route = routeOf(call);
    const set = byRoute.get(route) ?? new Set<string>();
    for (const p of parametersOf(call)) set.add(p);
    byRoute.set(route, set);
  }
  return byRoute;
}

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

  it('every parameter the SDK sends is one the platform documents', async () => {
    // A field the platform does not read is a field it ignores, silently: the
    // call succeeds, and the thing the caller asked for does not happen.
    const outside: string[] = [];
    for (const [route, sent] of await sentParameters()) {
      const known = new Set(PARAMETERS.get(route) ?? []);
      for (const p of sent) if (!known.has(p)) outside.push(`${route}  ${p}`);
    }
    expect(outside.sort(), 'SDK sends parameters the platform does not document').toEqual([]);
  });

  it('the unsent part of the surface is exactly what we think', async () => {
    // The test that would have caught `force`, `fresh`, exec's `env` and a
    // snapshot's `name`. All four were documented, all four were on reachable
    // routes, and none of them was sendable — which every other test in this
    // file was structurally unable to notice.
    const sent = await sentParameters();
    const unsent: string[] = [];
    for (const [route, params] of PARAMETERS) {
      // A route nobody calls sends none of its parameters; its own line in
      // UNIMPLEMENTED already says so, and repeating it here per parameter
      // would bury the ones that are genuinely missing.
      if (UNIMPLEMENTED.has(route)) continue;
      const actual = sent.get(route) ?? new Set<string>();
      for (const p of params) if (!actual.has(p)) unsent.push(`${route}  ${p}`);
    }
    expect(unsent.sort()).toEqual([...UNIMPLEMENTED_PARAMETERS].sort());
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
