#!/usr/bin/env node
/**
 * Drive the event stream against a REAL computer, once, and delete it.
 *
 * The rest of this repository injects a mock `fetch` and a stand-in websocket,
 * which is the right way to pin behaviour and the wrong way to learn what the
 * platform actually sends: the fixtures were written from the same reading of
 * the reference that produced the code they check, so a wrong reading is
 * asserted rather than caught. This file is the other direction. Its first run
 * found `Computer.windows()` broken against the live platform — a method every
 * mock in the suite says works, because the fixture agreed with the bug.
 *
 * Not read-only, and unlike `smoke-live.mjs` there is no read-only half to fall
 * back to: it CREATES a computer, drives it for about fifteen seconds and
 * deletes it in a `finally`. That is somebody's hypervisor and a few minutes of
 * billable time, so it is its own script rather than a flag on the other one,
 * and it is never part of `npm test`.
 *
 *   MANDALA_API_KEY=com_... npm run smoke:events
 *
 * What it proves, in the order the checks run: that a desktop announces itself
 * rather than being screenshotted for; that a second wait on an up desktop
 * returns at once instead of forever; that the opening frame carries the
 * vocabulary and the desktop; that a background command's exit arrives off the
 * wire with its code; that a nominated tree comes back normalised, arms as an
 * event, and reports a file written under it; that a window opening is
 * described, with the same coordinates the listing gives; that a cursor
 * resumes; and that a suspended computer is refused with a sentence naming the
 * suspend.
 */

const key = process.env.MANDALA_API_KEY?.trim();
if (!key) {
  console.log('smoke-events — no MANDALA_API_KEY, so nothing to call. Skipped.');
  process.exit(0);
}

// Imported after the key check and dynamically, for the reason smoke-live.mjs
// says: `dist` is gitignored, and a static import makes the promised skip
// unreachable on a clean checkout.
const { Client } = await import('../dist/index.js').catch(() => {
  console.error(
    'smoke-events — no build to test. Run `npm run build` first, or `npm run smoke:events`.',
  );
  process.exit(1);
});

const c = new Client({ apiKey: key });
const t0 = Date.now();
const el = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;

let failures = 0;
function check(what, good, detail = '') {
  if (good) {
    console.log(`  ok   ${el()} ${what}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures++;
    console.log(`  FAIL ${el()} ${what}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log(`smoke-events — ${c.baseUrl}\n`);

const vm = await c.computers.create({ template: 'base', name: `sdk-events-${Date.now()}` });
console.log(`  created ${vm.id} (${vm.status}) ${el()}`);
try {
  await vm.waitUntilRunning({ timeoutMs: 180_000 });

  // The headline. On a computer that has just been created this is the real
  // event; on one somebody else brought up it is the opening frame's state.
  const ready = await vm.waitFor('computer.ready', { timeoutMs: 240_000 });
  check('computer.ready arrives', ready.type === 'computer.ready', `source=${ready.source}`);

  // And now the desktop IS up, so the event cannot happen again for it. A raw
  // socket waiting here waits forever; this must not.
  const t = Date.now();
  const again = await vm.waitFor('computer.ready', { timeoutMs: 30_000 });
  check(
    'a second wait returns at once on an up desktop',
    again.synthesized === true && Date.now() - t < 15_000,
    `${Date.now() - t}ms`,
  );

  // Closed in a `finally`, and `reconnect: false`. Calling `.next()` parks the
  // generator at its `yield`: the socket stays open, keeps filling a
  // 4096-deep queue, and reconnects on its own while the waits below open
  // streams of their own. The close used to sit after those waits, so any throw
  // in between leaked it — a grok bug hunt found this, and it is the kind of
  // thing only a script that really connects can have wrong.
  const stream = vm.events({ reconnect: false });
  let kept;
  try {
    const first = await stream[Symbol.asyncIterator]().next();
    check('the opening frame lands before the first event', !first.done, String(first.value?.type));
    check(
      'it advertises the guest half of the vocabulary',
      (stream.eventTypes ?? []).includes('window.opened'),
      `${(stream.eventTypes ?? []).length} types`,
    );
    check(
      'it carries the desktop this stream joined',
      Array.isArray(stream.windows),
      `${stream.windows?.length} windows`,
    );
    kept = stream.cursor;
    check('the stream kept a cursor to resume from', typeof kept === 'string', kept);
  } finally {
    stream.close();
  }

  const job = await vm.execBackground('sleep 4; exit 7');
  // Matched on the PID, because `waitFor` returns the first exit on the whole
  // computer and a freshly booted guest has others of its own — session setup,
  // desktop autostart, whatever the template runs. Taking the first one made
  // the pid and code assertions below fail against a process nobody asked
  // about, on a run that looked like a real regression. The README's own
  // example filters the same way.
  let exited;
  for await (const ev of vm.events({ since: kept })) {
    if (ev.type === 'process.exited' && ev.pid === job.pid) {
      exited = ev;
      break;
    }
  }
  check(
    'process.exited carries the pid and the real code',
    exited?.pid === job.pid && exited?.exitCode === 7 && exited?.lost === false,
    JSON.stringify({ pid: exited?.pid, exitCode: exited?.exitCode }),
  );

  // `file.changed`, which is the only type that never arrives unasked and the
  // only one whose state is answered in the opening frame rather than by an
  // event. Both halves are readings of the reference that no fixture can
  // settle: a mock says back whatever the reading that wrote it said.
  const tree = '/tmp/sdk-watch';
  await vm.exec(`mkdir -p ${tree}`);
  const stopWatching = new AbortController();
  // A deadline on the SIGNAL and not on the loop body: a loop that checks the
  // clock only when an event arrives never checks it on the failure this is
  // here to catch, which is a tree that never arms and therefore says nothing.
  const watchTimer = setTimeout(() => stopWatching.abort(), 120_000);
  let nominated;
  // A trailing slash on the way out, on purpose. The host normalises it away
  // and the cleaned form is what every event carries, so this is the one check
  // that can catch a client matching on what it sent.
  const watcher = vm.events({
    watch: `${tree}/`,
    reconnect: false,
    signal: stopWatching.signal,
    onConnect: (hello) => {
      nominated ??= hello.watching;
    },
  });
  let armed;
  let created;
  try {
    for await (const ev of watcher) {
      if (ev.type !== 'file.changed') continue;
      if (ev.armed) {
        // Only NOW. inotify reports changes and not state, so a file written
        // before the watch is armed is never reported and never will be —
        // touching it any earlier is a check that fails for the right reason
        // and looks like a broken feature.
        armed = ev;
        await vm.exec(`touch ${tree}/a.txt`);
        continue;
      }
      if (ev.path) {
        created = ev;
        break;
      }
    }
  } finally {
    clearTimeout(watchTimer);
    watcher.close();
  }
  check(
    'the opening frame answers the nomination, normalised',
    nominated?.length === 1 && nominated[0].path === tree,
    JSON.stringify(nominated ?? null),
  );
  check(
    'and says the tree is not live yet, so the arming is an event',
    nominated?.[0]?.armed === false && armed?.watch === tree,
    JSON.stringify({ helloArmed: nominated?.[0]?.armed, event: armed?.watch ?? null }),
  );
  check(
    'a file created under it arrives as a created, inside the tree',
    created?.kind === 'created' && created?.path === `${tree}/a.txt` && created?.dir === false,
    JSON.stringify({ kind: created?.kind, path: created?.path, dir: created?.dir }),
  );

  // Started BEFORE the thing that causes it: a wait opened after the event has
  // happened is a wait that joins at the head and misses it.
  const opening = vm.waitFor('window.opened', { timeoutMs: 90_000 });
  await vm.open('https://example.com');
  const opened = await opening;
  check(
    'window.opened describes the window, and says the guest said so',
    !!opened.window?.id && opened.source === 'guest',
    `${opened.window?.windowClass} ${opened.window?.id}`,
  );

  // The coordinate convention, which the platform pins in its own e2e for the
  // same reason: an event and a listing that disagree send every click to the
  // wrong place. Through `Computer.windows()` again — this read went via raw
  // `fetch` while that method could not decode the route it calls, which is the
  // bug this branch fixes (OPL-4176), and leaving the workaround would mean the
  // one script that talks to the real platform never exercised the fix.
  const listed = (await vm.windows()).find((w) => w.id === opened.window?.id);
  check(
    'the event and the listing put the window in the same place',
    !!listed && listed.x === opened.window?.x && listed.y === opened.window?.y,
    JSON.stringify({
      event: [opened.window?.x, opened.window?.y],
      listing: [listed?.x, listed?.y],
    }),
  );

  // `visible` is the only thing that separates a minimised window from one on
  // the screen, and a click at the coordinates of the first lands on whatever
  // is really there. It replaced a `minimized` that read a key this wire has
  // never carried, so it was false for every window including the minimised
  // ones — a live minimise is the only check that could have caught that, and
  // is the only one that can keep catching it.
  check('a window on the screen reads as visible', listed?.visible === true);
  const acted = await vm.windowAction(opened.window.id, 'minimize');
  check(
    'a window action answers with the window, not an acknowledgement',
    acted.window?.id === opened.window.id && acted.gone === false,
    JSON.stringify({ gone: acted.gone, id: acted.window?.id }),
  );
  const hidden = (await vm.windows()).find((w) => w.id === opened.window?.id);
  check('and a minimised one does not', hidden?.visible === false, `visible=${hidden?.visible}`);
  const shut = await vm.windowAction(opened.window.id, 'close');
  check(
    'a close reports gone with no window to describe',
    shut.gone === true && shut.window === undefined,
    JSON.stringify({ gone: shut.gone, window: shut.window ?? null }),
  );

  // What a process restart would do: come back from a stored cursor and be
  // handed what happened while nobody was listening.
  await vm.execBackground('true');
  const seen = [];
  const deadline = Date.now() + 45_000;
  for await (const ev of vm.events({ since: kept, reconnect: false })) {
    seen.push(ev.type);
    if (ev.type === 'process.exited' || Date.now() > deadline) break;
  }
  check(
    'a resume is handed what happened while it was gone',
    seen.includes('process.exited'),
    seen.join(',') || 'nothing',
  );
  check(
    'and no manufactured readiness in front of it',
    !seen.includes('computer.ready'),
    seen.join(',') || 'nothing',
  );

  // The refusal that carries no status on a websocket, said as a sentence.
  await vm.suspend();
  const refused = await vm.waitFor('computer.ready', { timeoutMs: 20_000 }).catch((e) => e);
  check(
    'a suspended computer is refused, and the refusal names the suspend',
    /suspended/.test(String(refused)),
    String(refused)
      .replace(/^Error: /, '')
      .slice(0, 90),
  );
} finally {
  // In a `finally` and awaited: a smoke test that leaves a computer behind on
  // its own failure bills somebody for the bug it found.
  await vm.delete().catch((e) => console.log(`  delete failed: ${e}`));
  console.log(`  deleted ${vm.id} ${el()}`);
}

console.log(failures === 0 ? `\nsmoke-events — all checks passed ${el()}` : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
