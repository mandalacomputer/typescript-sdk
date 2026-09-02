/**
 * Pins the SDK to the platform's curated /api/v1 surface — the routes, and the
 * parameters each route takes.
 *
 * The platform allowlists routes server-side; anything else 404s. That check
 * lives there, but a client that calls a route the platform does not expose
 * fails at runtime in a user's hands rather than here.
 *
 * Both halves compare this SDK to the platform. `./surface-inventory.ts` is the
 * third dimension and points inward: every public method of this SDK is NAMED in
 * `exerciseEverything`, not merely every route reached by one. Those are
 * different claims wherever two methods share a route, which here is most of
 * them — `exec`, `open` and `waitForGuest` are all `POST computers/:id/exec` —
 * so a method added beside an existing one and left out of the exercise shipped
 * with no coverage at all, on a suite whose whole design is that the surface is
 * enumerable (OPL-3911).
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
import { Client, type Computer, VERSION } from '../src/index.js';
import {
  ALLOWED,
  PARAMETERS,
  patternFor,
  UNIMPLEMENTED,
  UNIMPLEMENTED_PARAMETERS,
} from './allowlist.js';
import { anyRoute, BASE, type Call, EVENTS_HELLO, recorder, socketFactory } from './harness.js';
import { inventory, names, recordNamedCalls } from './surface-inventory.js';

/**
 * Every public method of this SDK that can put a request on the wire, by the
 * class that declares it — read out of `src` rather than listed here.
 */
const SURFACE = inventory();

/**
 * Call every method the SDK exposes that performs a request.
 *
 * Every optional argument is given somewhere, because this drives the parameter
 * coverage test as well as the route one: a parameter no call here passes is
 * one the test cannot tell from a parameter the SDK cannot send.
 */
async function exerciseEverything(client: Client): Promise<void> {
  await client.templates.list();
  // The document format, and the store on top of it (platform OPL-3568,
  // OPL-3789, OPL-3830). Both spellings of the ref routes, because `version` is
  // a parameter like any other and a call that never sends one is the gap the
  // parameter half of this test exists to see.
  await client.templates.schema();
  await client.templates.validate('apiVersion: mandala/v1');
  await client.templates.publish('apiVersion: mandala/v1');
  await client.templates.get('acc-1', 'devbox');
  await client.templates.get('acc-1', 'devbox', { version: '1.0.0' });
  await client.templates.retire('acc-1', 'devbox', { version: '1.0.0' });
  await client.templates.retire('acc-1', 'devbox');

  // Compiling one (platform OPL-3791, OPL-3794). `noReuse` on one of the two,
  // for the same reason.
  await client.builds.start('apiVersion: mandala/v1');
  await client.builds.start('apiVersion: mandala/v1', { noReuse: true });
  await client.builds.list();
  // Both spellings, the way the computer listing below is exercised: a build
  // listing fails closed on a degraded fleet like every other fan-out, and
  // OPL-3840 is what made the way out of it something a client can send.
  await client.builds.list({ allowPartial: true });
  // Both spellings of a listing: `list` is the plain answer and
  // `listWithStatus` is the one that says whether it was short. The first
  // delegates to the second, so the route half of this file cannot tell whether
  // the entry point was ever driven — see ./surface-inventory.ts, which can.
  await client.builds.listWithStatus({ allowPartial: true });
  await client.builds.get('bld-1');
  await client.builds.progress('bld-1');
  // The poll on top of progress, which shares `GET builds/:id/progress` with
  // the call above and is therefore invisible to the route check.
  await client.builds.wait('bld-1');
  for await (const _ of client.builds.events('bld-1')) break;

  await client.sizes.list();
  await client.computers.list();
  await client.computers.list({ allowPartial: true });
  await client.computers.listWithStatus({ allowPartial: true });
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
  // The create/delete pair as one scope, in both its shapes: the block form,
  // and the handle form whose disposal a caller normally leaves to `await
  // using`. Every route either of them reaches is reached by its own method
  // elsewhere here, so nothing but the inventory sees these three lines.
  await client.computers.ephemeral({ template: 'base' }, async () => undefined);
  const scratch = await client.computers.ephemeral({ template: 'base' });
  await scratch[Symbol.asyncDispose]();
  await c.refresh();
  // The three readiness waits, which poll routes the calls around them already
  // reach: `GET computers/:id` for the first two, and a `POST computers/:id/exec`
  // probe for the guest.
  await c.waitUntilBuilt();
  await c.waitUntilRunning();
  await c.waitForGuest();
  await c.start();
  await c.stop();
  await c.stop({ force: true });
  await c.suspend();
  await c.restart();
  await c.clone('copy');
  await c.rename('renamed');
  await c.update({ cpu: 4 });
  await c.update({ name: 'resized', ramMb: 8192, diskGb: 80, idleSuspendMin: 30 });
  // All three sizing fields in one call: the platform reads exactly these three
  // off a move body, and the parameter sweep is what proves the SDK sends them.
  // `move` on the class is the mouse pointer — see Computer.relocate.
  await c.relocate({ ramMb: 26000, cpu: 2, diskGb: 40 });
  // The wait on the move, which reads the same account-wide listing as
  // `moves.list()` below and is a different method for doing it.
  await c.waitForMove();
  await client.moves.list();

  await c.screenshot();
  await c.screenshot(320);
  await c.screenshot(undefined, { fresh: true });
  await c.windows();
  await c.windows({ includeAll: true });
  await c.windowAction('0x1', 'focus');
  await c.windowAction('0x1', 'move', { x: 10, y: 20 });
  await c.windowAction('0x1', 'resize', { width: 800, height: 600 });

  await c.clipboard();
  await c.setClipboard('on the clipboard');

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
  // The decoded spelling of the same read. Same route, same request, its own
  // entry point.
  await c.readTextFile('/home/user/out.txt');
  // The ranged forms as well as the whole-file one: `Range` is a parameter of
  // this route like any other, and a read that never sends it is exactly the
  // gap the parameter half of this test exists to see.
  await c.readFilePart('/home/user/out.txt', { offset: 0, length: 1024 });
  await c.readFilePart('/home/user/out.txt', { offset: -16 });
  for await (const _ of c.readFileChunks('/home/user/out.txt')) break;
  await c.writeFile('/home/user/in.txt', 'hello');

  await c.snapshot();
  await c.snapshot({ memory: true, name: 'before-upgrade' });
  await c.holdings();
  await c.schedule();
  await c.setSchedule({ enabled: true, hour: 4 });
  await c.setSchedule({ enabled: true, hour: 3, minute: 30, tz: 'Europe/London' });
  await c.clearSchedule();

  // The event stream, both entry points. Every connection re-reads the computer
  // for a fresh `events_url` — the credential in it is rotated by a restart —
  // so both of these are `GET computers/:id` on the wire and neither reaches a
  // route of its own. That is exactly the case the route half of this file
  // cannot see, and why they are named here.
  const stream = socketFactory((socket) => {
    socket.emitOpen();
    socket.send(EVENTS_HELLO);
  });
  for await (const _ of c.events({ webSocket: stream, reconnect: false })) break;
  await c.waitFor('computer.ready', { webSocket: stream, reconnect: false, timeoutMs: 5_000 });

  await c.agent({ prompt: 'do a thing', modelKey: 'sk-test' });
  // The streaming entry point the call above waits out for you. All three agent
  // methods are `POST computers/:id/agent`, so the route check sees one method
  // where there are three.
  for await (const _ of c.agentStream({ prompt: 'do a thing', modelKey: 'sk-test' })) break;
  await c.agentOnce({ prompt: 'do a thing', modelKey: 'sk-test' });
  await c.agentOnce({
    prompt: 'do a thing',
    system: 'be brief',
    maxSteps: 5,
    model: 'claude-opus-5',
    modelKey: 'sk-test',
  });

  // Both bounds, because a call that names neither cannot show the parameter
  // sweep that this SDK can send either.
  await client.usage.read();
  await client.usage.read({ from: new Date('2026-08-01T00:00:00Z'), to: '2026-08-22T00:00:00Z' });

  await client.snapshots.list();
  await client.snapshots.list({
    computerId: 'vm-1',
    includeUnfinished: true,
    allowPartial: true,
  });
  await client.snapshots.listWithStatus({ allowPartial: true });
  await client.snapshots.restore('snap-1');
  await client.snapshots.clone('snap-1');
  await client.snapshots.clone('snap-1', 'from-snapshot');
  await client.snapshots.delete('snap-1');

  // The other half of the schedule: when they are taken is a computer's, how
  // long they are kept is the account's.
  await client.snapshots.retention();

  // Account webhooks (platform OPL-4300, OPL-4301 here). Every field on the
  // create, and every field again on the update — the parameter half of this
  // file cannot tell a field the SDK never sends from one it cannot.
  await client.webhooks.list();
  await client.webhooks.create({
    url: 'https://ci.example.com/mandala',
    description: 'CI',
    events: ['process.exited'],
    computers: ['vm-1'],
    enabled: false,
  });
  await client.webhooks.get('whk-1');
  await client.webhooks.update('whk-1', {
    url: 'https://ci.example.com/mandala-2',
    description: 'CI, moved',
    events: [],
    computers: [],
    enabled: true,
  });
  await client.webhooks.rotate('whk-1');
  await client.webhooks.test('whk-1');
  await client.webhooks.deliveries('whk-1');
  await client.webhooks.delete('whk-1');

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

  it('every public method is named in the exercise', async () => {
    // The claim the route check above cannot make. `ALLOWED - called` proves
    // every route was reached by SOMETHING, and says nothing about a method
    // sharing a route with one already exercised — three methods are
    // `POST computers/:id/agent`, three are `POST computers/:id/exec`, and every
    // mouse and keyboard call is `POST computers/:id/input`. Thirteen methods
    // had gone through that hole by the time this was written (OPL-3911).
    //
    // The inventory is derived from the source, so closing this is adding the
    // call rather than editing a list, and a method added tomorrow is in the
    // inventory before anybody thinks about coverage.
    const rec = recorder(anyRoute);
    const client = new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch });
    const named = await recordNamedCalls(SURFACE, [exerciseEverything], () =>
      exerciseEverything(client),
    );
    const missed = [...names(SURFACE)].filter((m) => !named.has(m)).sort();
    expect(
      missed,
      'public methods exerciseEverything() never calls; sharing a route with a method that ' +
        'IS called is not coverage',
    ).toEqual([]);
  });

  it('catches a method that shares a route somebody else already reaches', async () => {
    // The regression test for the assertion above, on a real pair rather than a
    // contrived one. `Computer.open` is sugar over `Computer.exec`: same verb,
    // same route, different method. So the two exercises below reach an
    // IDENTICAL set of routes and every route-shaped check in this file is
    // equally happy with both — which is the hole. Only the inventory tells
    // them apart, and without this the new assertion would be as unfalsifiable
    // as the one it was written to shore up.
    const run = async (exercise: (c: Computer) => Promise<void>) => {
      const rec = recorder(anyRoute);
      const client = new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch });
      const computer = await client.computers.get('vm-1');
      const named = await recordNamedCalls(SURFACE, [exercise], () => exercise(computer));
      return { named, routes: new Set(rec.calls.slice(1).map(routeOf)) };
    };

    async function forgotOpen(c: Computer): Promise<void> {
      await c.exec('true');
    }
    async function calledOpen(c: Computer): Promise<void> {
      await c.exec('true');
      await c.open('https://example.com');
    }

    const forgetful = await run(forgotOpen);
    const complete = await run(calledOpen);

    expect(
      [...complete.routes].sort(),
      'the two exercises must reach the same routes, or this proves nothing about a method ' +
        'that shares one',
    ).toEqual([...forgetful.routes].sort());
    expect(names(SURFACE)).toContain('Computer.open');
    expect(forgetful.named).not.toContain('Computer.open');
    expect(complete.named).toContain('Computer.open');
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
    // The ops endpoints are not tenant API and never should be. The test above
    // proves the SDK stays inside ALLOWED; this proves ALLOWED itself stays
    // honest, so widening it later is a deliberate act rather than a quiet one.
    //
    // `retention` WAS in this set and came out of it deliberately (OPL-3767,
    // OPL-3783), which is the act this test exists to force. Two things had to
    // be true first. The platform put `GET retention` on its public allowlist —
    // so the READ is tenant API now, answered by the control plane from the plan
    // catalogue rather than forwarded to a daemon at all. And the reason written
    // here for withholding it was wrong: `PUT /retention` IS owner-scoped, it
    // sets the calling tenant's own policy. What keeps the WRITE off every
    // surface is that the plan owns retention, so a tenant setting its own would
    // be granting itself history it has not paid for — a different argument, and
    // one this SDK cannot violate, since a head-segment check cannot tell a GET
    // from a PUT. The verb check below is what holds that line.
    const internal = new Set(['audit', 'host', 'fleet']);
    const heads = new Set([...ALLOWED].map((r) => r.split(' ')[1]!.split('/')[0]!));
    expect([...heads].filter((h) => internal.has(h))).toEqual([]);
  });

  it('reaches retention only to read it', async () => {
    // What the head-segment check above can no longer say, now that `retention`
    // is a route this SDK may call: the plan owns the window, so a write to it
    // is a tenant granting itself a longer history than it pays for. The
    // platform refuses one on both its surfaces; this is the mirror of that
    // refusal, so a PUT could not be added here without deleting a test.
    const verbs = [...ALLOWED].filter((r) => r.endsWith(' retention')).map((r) => r.split(' ')[0]);
    expect(verbs).toEqual(['GET']);
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
