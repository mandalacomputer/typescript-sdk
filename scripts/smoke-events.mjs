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
// unreachable on a clean checkout. Discriminated on the code rather than
// swallowed, for the reason that file gives too: an unbound catch reports a
// throwing top-level statement, a bad re-export or a broken transitive
// dependency inside a build that DOES exist as "no build to test", so the
// operator runs `npm run build`, it succeeds, and they read the same sentence
// again — the diagnostic destroyed on the one path these scripts exist for.
const { Client } = await import('../dist/index.js').catch((e) => {
  console.error(
    e?.code === 'ERR_MODULE_NOT_FOUND'
      ? 'smoke-events — no build to test. Run `npm run build` first, or `npm run smoke:events`.'
      : `smoke-events — dist/index.js failed to load:\n${e?.stack ?? e}`,
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

/**
 * The base URL is echoed for orientation, and `MANDALA_BASE_URL` may carry
 * userinfo — an unusual but legitimate shape for a staging proxy, which the
 * transport keeps verbatim — so the credential is blanked before it reaches a
 * terminal or a scrollback. A value that will not parse has no userinfo to
 * leak and is printed as it came.
 */
function redacted(u) {
  try {
    const url = new URL(u);
    if (!url.username && !url.password) return u;
    url.username = '';
    url.password = '';
    return url.href;
  } catch {
    return u;
  }
}

console.log(`smoke-events — ${redacted(c.baseUrl)}\n`);

const vm = await c.computers.create({ template: 'base', name: `sdk-events-${Date.now()}` });
console.log(`  created ${vm.id} (${vm.status}) ${el()}`);

/**
 * Guest setup, asserted. `exec` answers an `ExecResult`, and throwing it away
 * means a `mkdir` the guest refused surfaces fifty lines later as the file
 * event check for that tree failing — a diagnostic pointing at the SDK's event
 * handling rather than at the command that never ran.
 */
async function sh(cmd) {
  const r = await vm.exec(cmd);
  if (!r.ok) {
    throw new Error(
      `guest command failed (exit ${r.exitCode}): ${cmd} — ${r.stderr.trim().slice(0, 200) || '(no stderr)'}`,
    );
  }
  return r;
}

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
    // Narrowed to a string here rather than passed on as whatever arrived:
    // `{ since: undefined }` is not an error, it silently means "join at the
    // head", so an unusable cursor would otherwise change what the loops below
    // are testing without changing what they claim.
    kept = typeof stream.cursor === 'string' ? stream.cursor : undefined;
    check('the stream kept a cursor to resume from', kept !== undefined, String(stream.cursor));
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
  //
  // Bounded on the SIGNAL and `reconnect: false`, for the reason the watcher
  // below spells out and one more: `reconnect` defaults to true, so an exit
  // that never arrives reconnects forever, parks this loop, and never reaches
  // the `finally` that deletes the computer — a hang that bills somebody by
  // the hour. The sleep is four seconds; ninety is slack, not a wait.
  const stopExit = new AbortController();
  const exitTimer = setTimeout(() => stopExit.abort(), 90_000);
  let exited;
  try {
    for await (const ev of vm.events({ since: kept, reconnect: false, signal: stopExit.signal })) {
      if (ev.type === 'process.exited' && ev.pid === job.pid) {
        exited = ev;
        break;
      }
    }
  } finally {
    clearTimeout(exitTimer);
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
  await sh(`mkdir -p ${tree}`);
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
        await sh(`touch ${tree}/a.txt`);
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
  check(
    'and the arming moved the tree, so `watching` is its state and not hello’s claim',
    watcher.watching?.[0]?.armed === true,
    JSON.stringify(watcher.watching ?? null),
  );

  // And the wait ends on a CHANGE, not on the marker. This is the half a
  // fixture cannot settle: the arming is real here and arrives first, so a
  // `waitFor` matched on the type alone comes back with it. Nominated fresh,
  // because a tree this run already armed would never meet the marker at all —
  // which is the nondeterminism the rule exists to remove.
  const second = `${tree}-2`;
  await sh(`mkdir -p ${second}`);
  // Handled AT CREATION, not at the await below. `execBackground` yields to the
  // event loop, and a wait can reject before it comes back — a refused
  // handshake, or a computer the server already considers settled — landing on
  // a promise with no handler attached yet, which Node kills the process over.
  const changing = vm
    .waitFor('file.changed', { watch: second, timeoutMs: 120_000 })
    .catch((e) => e);
  // Written repeatedly, because nothing before the watch arms is ever reported
  // and this side cannot see when that happened.
  await vm.execBackground(`for i in $(seq 30); do touch ${second}/b.txt; sleep 1; done`);
  const change = await changing;
  check(
    'a wait for a file change ends on a change, not on the arming marker',
    change?.path === `${second}/b.txt` && change?.armed === undefined,
    change instanceof Error ? String(change).slice(0, 90) : JSON.stringify({ path: change?.path }),
  );

  // Started BEFORE the thing that causes it: a wait opened after the event has
  // happened is a wait that joins at the head and misses it. Handled at
  // creation for the reason the wait above gives — `open` is the await in
  // between, and an early rejection here has nobody holding the promise.
  const opening = vm.waitFor('window.opened', { timeoutMs: 90_000 }).catch((e) => e);
  await vm.open('https://example.com');
  const opened = await opening;
  check(
    'window.opened describes the window, and says the guest said so',
    !!opened?.window?.id && opened.source === 'guest',
    opened instanceof Error
      ? String(opened).slice(0, 90)
      : `${opened?.window?.windowClass} ${opened?.window?.id}`,
  );
  // Hoisted and guarded, because everything from here to the summary hangs off
  // it. Dereferenced bare, an absent window payload — the very thing the check
  // above admits is possible — is a TypeError out of the try, which takes the
  // remaining checks and the summary line that counts them with it.
  const wid = opened?.window?.id;

  // The coordinate convention, which the platform pins in its own e2e for the
  // same reason: an event and a listing that disagree send every click to the
  // wrong place. Through `Computer.windows()` again — this read went via raw
  // `fetch` while that method could not decode the route it calls, which is the
  // bug this branch fixes (OPL-4176), and leaving the workaround would mean the
  // one script that talks to the real platform never exercised the fix.
  const listed = wid === undefined ? undefined : (await vm.windows()).find((w) => w.id === wid);
  check(
    'the event and the listing put the window in the same place',
    !!listed && listed.x === opened.window?.x && listed.y === opened.window?.y,
    JSON.stringify({
      event: [opened?.window?.x, opened?.window?.y],
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
  // FAILED rather than skipped when there is nothing to act on. A window action
  // block that quietly does not run is three assertions the summary counts as
  // passed, which is the shape of green run this file exists to make impossible.
  if (wid === undefined) {
    for (const what of [
      'a window action answers with the window, not an acknowledgement',
      'and a minimised one does not',
      'a close reports gone with no window to describe',
    ]) {
      check(what, false, 'no window id to act on');
    }
  } else {
    const acted = await vm.windowAction(wid, 'minimize');
    check(
      'a window action answers with the window, not an acknowledgement',
      acted.window?.id === wid && acted.gone === false,
      JSON.stringify({ gone: acted.gone, id: acted.window?.id }),
    );
    const hidden = (await vm.windows()).find((w) => w.id === wid);
    check('and a minimised one does not', hidden?.visible === false, `visible=${hidden?.visible}`);
    const shut = await vm.windowAction(wid, 'close');
    check(
      'a close reports gone with no window to describe',
      shut.gone === true && shut.window === undefined,
      JSON.stringify({ gone: shut.gone, window: shut.window ?? null }),
    );
  }

  // What a process restart would do: come back from a stored cursor and be
  // handed what happened while nobody was listening.
  //
  // The cursor is taken HERE, and not reused from the opening frame at the top:
  // that one predates the `sleep 4; exit 7` job, so a resume from it replays
  // that older exit, breaks on it, and passes without the job below ever
  // arriving — an assertion that reads far stronger than what it tests. The pid
  // is matched for the same reason a boot process made necessary above.
  const marker = vm.events({ reconnect: false });
  let mark;
  try {
    await marker[Symbol.asyncIterator]().next();
    mark = typeof marker.cursor === 'string' ? marker.cursor : undefined;
  } finally {
    marker.close();
  }
  const restarted = await vm.execBackground('true');
  const seen = [];
  let replayed = false;
  if (mark === undefined) {
    check('a resume is handed what happened while it was gone', false, 'no cursor to resume from');
    check('and no manufactured readiness in front of it', false, 'no cursor to resume from');
  } else {
    // The deadline on the SIGNAL and not in the loop body, for the reason the
    // watcher above gives: a clock read only when an event arrives is never
    // read on the failure it is there to catch, which is a stream that says
    // nothing at all.
    const stopResume = new AbortController();
    const resumeTimer = setTimeout(() => stopResume.abort(), 45_000);
    try {
      for await (const ev of vm.events({
        since: mark,
        reconnect: false,
        signal: stopResume.signal,
      })) {
        seen.push(ev.type);
        if (ev.type === 'process.exited' && ev.pid === restarted.pid) {
          replayed = true;
          break;
        }
      }
    } finally {
      clearTimeout(resumeTimer);
    }
    check(
      'a resume is handed what happened while it was gone',
      replayed,
      seen.join(',') || 'nothing',
    );
    check(
      'and no manufactured readiness in front of it',
      !seen.includes('computer.ready'),
      seen.join(',') || 'nothing',
    );
  }

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
  // its own failure bills somebody for the bug it found. And COUNTED, because a
  // swallowed rejection followed by an unconditional "deleted" line is a run
  // that leaked a real computer, said in the log that it had not, and exited 0
  // reporting that all checks passed.
  try {
    await vm.delete();
    console.log(`  deleted ${vm.id} ${el()}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL ${el()} delete failed — ${vm.id} may still be billing — ${e}`);
  }
}

console.log(failures === 0 ? `\nsmoke-events — all checks passed ${el()}` : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
