#!/usr/bin/env node
/**
 * Run the template-store and build surface against the REAL platform.
 *
 * Every other test in this repository injects a mock `fetch` through
 * `new Client({ fetch })`, which is the right way to pin behaviour and the
 * wrong way to learn what the platform actually sends. The fixtures in
 * test/harness.ts were written from the same reading of the platform that
 * produced the code they check, so a wrong reading is asserted rather than
 * caught — and this branch has already shipped one: `d8ca29c` claimed
 * `GET /builds` does not fail closed and `2a16c82` reverted it. A mock cannot
 * find that. Only a call can.
 *
 * Opt-in, and silent about it. Exits 0 and says why when there is no key, the
 * way check-surface.mjs exits 0 without the platform repo: this cannot run in
 * CI, and failing over it would make the suite red for everyone who is not
 * holding a credential.
 *
 *   MANDALA_API_KEY=com_... node scripts/smoke-live.mjs
 *
 * READ-ONLY by default. `--build` additionally compiles a throwaway document,
 * which is minutes of somebody's hypervisor and one off the account's daily
 * build allowance, so it is a flag rather than the default. The document it
 * builds is deliberately trivial and is built TWICE: the second is what proves
 * `reused`, which is the cheap path and the one an omitted `no_reuse` is
 * supposed to reach.
 *
 * It never publishes a TEMPLATE, retires one, or deletes anything: no call here
 * reaches `templates.publish`, `templates.retire`, or any DELETE. `builds.start`
 * compiles a document without claiming its ref — verified, not assumed: after a
 * build of `<account>/sdksmoke@1.0.0` the ref is still a 404 from
 * `templates.get`.
 *
 * `--build` DOES publish an image family, and saying "it publishes nothing" was
 * wrong of this comment rather than of the flag (adversarial review, second
 * pass). A build's whole product is a published image; that is what a build is.
 * It is behind a flag, off by default, and the read-only path — everything up to
 * the `--build` check — sends no request that mutates anything. The one place
 * that qualification is load-bearing is the `noReuse:"false"` refusal: a
 * `builds.start` held back only by a client-side guard is a POST one regression
 * away from being sent, so it is asserted against a client whose `fetch` fails
 * the run if it is called at all, and nothing leaves the process.
 */

const args = process.argv.slice(2);
const usage = 'usage: node scripts/smoke-live.mjs [--build] [--help]';
if (args.includes('--help') || args.includes('-h')) {
  console.log(usage);
  process.exit(0);
}
// Validated rather than sniffed. `argv.includes('--build')` is a common idiom
// and it means `--builds` selects the read-only path and exits 0 — a run that
// asked for the write path, did not get it, and reported success, which is the
// silent-green-on-mistyped-intent this file's whole doctrine argues against.
const unknown = args.filter((a) => a !== '--build');
if (unknown.length > 0) {
  console.error(`smoke-live — unrecognised argument(s): ${unknown.join(' ')}\n${usage}`);
  process.exit(2);
}
const wantBuild = args.includes('--build');

const key = process.env.MANDALA_API_KEY?.trim();
if (!key) {
  console.log('smoke-live — no MANDALA_API_KEY, so nothing to call. Skipped.');
  process.exit(0);
}

// Imported AFTER the key check, and dynamically, because `dist` is gitignored:
// a static import made the promised skip unreachable on a clean checkout — the
// module failed to resolve before this file ran a line. `npm run smoke:live`
// builds first for the same reason, so what runs is the working tree rather
// than whatever dist happened to be left behind (adversarial review, second
// pass, OPL-3835).
// The rejection is BOUND and discriminated. Unbound, a throwing top-level
// statement, a bad re-export or a broken transitive dependency inside a dist
// that exists all read as "no build to test": the operator builds, it succeeds,
// and the second run says the same thing — the real error unreachable on the
// one path this script exists to produce a diagnostic on.
const { Client, MandalaError, NotFoundError } = await import('../dist/index.js').catch((e) => {
  console.error(
    e?.code === 'ERR_MODULE_NOT_FOUND'
      ? 'smoke-live — no build to test. Run `npm run build` first, or `npm run smoke:live`.'
      : `smoke-live — dist/index.js failed to load:\n${e?.stack ?? e}`,
  );
  process.exit(1);
});

const c = new Client({ apiKey: key });

let failures = 0;
const t0 = Date.now();
const el = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;

/**
 * Asserted rather than printed. A smoke test that only logs is a smoke test
 * whose failures are read by nobody the second time it runs.
 */
function check(what, ok, detail = '') {
  if (ok) {
    console.log(`  ok   ${what}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures++;
    console.log(`  FAIL ${what}${detail ? ` — ${detail}` : ''}`);
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

console.log(`smoke-live — ${redacted(c.baseUrl)}\n`);

// ---- the read path -------------------------------------------------------

console.log('templates');
const templates = await c.templates.list();
check(
  'list answers',
  Array.isArray(templates) && templates.length > 0,
  `${templates.length} template(s)`,
);
const base = templates.find((t) => t.ref.startsWith('system/base@'));
check('the base template is there and decodes', !!base, base?.ref);
// snake_case to camelCase, which is the half of the decoder a shape test cannot
// see: `ram_mb` reaching `ramMb` as a number rather than as undefined.
check(
  'hardware decodes off snake_case',
  typeof base?.ramMb === 'number' && base.ramMb > 0,
  `ramMb=${base?.ramMb}`,
);

console.log('\nbuilds');
const builds = await c.builds.list();
check('list answers', Array.isArray(builds), `${builds.length} build(s)`);

// A finished build is enough to exercise the whole event path, because
// attaching to one is not an error — one progress and one done arrive at once.
// So the read half of this file costs nothing and still covers the generator.
const finished = builds.filter((b) => b.status === 'succeeded' || b.status === 'failed');
let exercised = 0;
for (const kind of ['succeeded', 'failed']) {
  const b = finished.find((x) => x.status === kind);
  if (!b) {
    console.log(`  --   no ${kind} build on this account to read; skipped`);
    continue;
  }
  exercised++;
  const p = await c.builds.progress(b.id);
  check(
    `progress on a ${kind} build is terminal`,
    p.done === true,
    `done=${p.done} status=${JSON.stringify(p.status)} phase=${JSON.stringify(p.phase)}`,
  );
  check(`  its status survives the decoder`, p.status === kind, JSON.stringify(p.status));
  // The one an SDK gets wrong by being strict in the wrong place: a failed
  // build is DONE, and `wait` must hand it back rather than throw.
  const w = await c.builds.wait(b.id, { timeoutMs: 60_000 });
  check(
    `  wait returns a ${kind} build instead of throwing`,
    w.status === kind,
    `status=${JSON.stringify(w.status)}`,
  );

  const seen = [];
  // `sse` deliberately has no deadline, and `builds.events` forwards only a
  // signal, so a stream that never sends its terminal frame parks this loop for
  // good: the catch below cannot catch a hang, and the check named for draining
  // never evaluates. Whether the abort throws or just ends the generator, the
  // assertion on the last event decides it — sixty seconds is what `wait` above
  // already allows a build that has finished.
  const stopEvents = new AbortController();
  const eventsTimer = setTimeout(() => stopEvents.abort(), 60_000);
  try {
    for await (const ev of c.builds.events(b.id, { signal: stopEvents.signal })) seen.push(ev);
    check(
      `  events drains and returns`,
      seen.length > 0 && seen.at(-1)?.done === true,
      `${seen.length} event(s), last done=${seen.at(-1)?.done}`,
    );
    // The invariant the adversarial review put here: the last value yielded is
    // the outcome a caller reads, so it has to BE one. `failed` is terminal —
    // gating this on success would throw on every failed build there is.
    check(
      `  the final event carries a status`,
      !!seen.at(-1)?.status,
      JSON.stringify(seen.at(-1)?.status),
    );
  } catch (e) {
    check(`  events drains and returns`, false, `${e.name}: ${e.message.slice(0, 120)}`);
  } finally {
    clearTimeout(eventsTimer);
  }
}
// Asserted, because the two `--` lines above are the whole of the report on an
// account with no finished builds: every progress, wait and events check is
// skipped, nothing touches `failures`, and the run exits 0 all-clear having
// exercised none of the path it is named for.
check(
  'at least one finished build was available to exercise the event path',
  exercised > 0,
  `${exercised} of 2 build outcomes read`,
);

console.log('\nrefusals');
try {
  await c.templates.get('acc-does-not-exist', 'neither-does-this');
  check('a missing template is a NotFoundError', false, 'it resolved');
} catch (e) {
  check('a missing template is a NotFoundError', e instanceof NotFoundError, `${e.name}`);
}

// The document the platform rejects, and the SDK reporting the rejection rather
// than a `valid` it coerced out of a missing field.
const bad = await c.templates.validate(
  'apiVersion: mandala/v1\nkind: Template\nmetadata:\n  namespace: x\n  name: y\n  version: nope\n',
);
check(
  'an invalid document validates as invalid',
  bad.valid === false,
  `${bad.problems.length} problem(s)`,
);
check('  and says why', bad.problems.length > 0, JSON.stringify(bad.problems[0]?.slice(0, 80)));

// A boolean the SDK refuses locally, which is only observable here in that it
// costs no round trip. See P.noReuse — truthiness read `"false"` as "rebuild".
//
// The one call in the read-only half that would MUTATE if it got out, so it is
// made through a transport that cannot let it: `builds.start` is a POST, held
// back by exactly the guard whose absence this check is written to detect, in a
// section the header promises sends nothing that mutates. A `fetch` that fails
// the run if it is reached turns the promise into something the code enforces,
// and the request never leaves the process either way.
let reached;
const guarded = new Client({
  apiKey: key,
  fetch: async (input) => {
    reached = String(input instanceof Request ? input.url : input);
    throw new Error('the local guard did not hold');
  },
});
try {
  await guarded.builds.start('apiVersion: mandala/v1\n', {
    noReuse: /** @type {never} */ ('false'),
  });
  check('noReuse:"false" is refused before the request', false, 'it was sent');
} catch (e) {
  check(
    'noReuse:"false" is refused before the request',
    e instanceof TypeError && !(e instanceof MandalaError),
    e.name,
  );
}
check('  and nothing reached the transport', reached === undefined, reached ?? 'no request made');

// ---- the write path ------------------------------------------------------

if (!wantBuild) {
  console.log(`\n${el()} read-only. Pass --build to compile a throwaway document too.`);
  process.exit(failures === 0 ? 0 : 1);
}

// Every build, not `builds[0]`: the listing has no documented ordering and
// `ref` is optional on the model, so keying on the first entry degrades a
// --build run to read-only whenever that one entry happens to lack a ref.
const ns = builds.map((b) => b.ref?.split('/')[0]).find((n) => n?.startsWith('acc-'));
if (!ns) {
  // Non-zero, not "Skipped." The read half passing is not this run's question:
  // the write path was asked for by name and did not happen, and exiting 0 says
  // it did.
  console.error(
    `\n--build needs an existing build to learn this account's namespace from, and none of ${builds.length} build(s) carries one.`,
  );
  process.exit(1);
}

// Trivial on purpose: `apt` is minutes, and what is being tested is the SDK's
// handling of the stream rather than the compiler's handling of a package.
const doc = `apiVersion: mandala/v1
kind: Template
metadata:
  namespace: ${ns}
  name: sdksmoke
  version: 1.0.0
  label: SDK live smoke test
spec:
  os: linux
  from: system/base
  family: golden-${ns}-sdksmoke
  hardware:
    cpu: 2
    ram_mb: 2048
    disk_gb: 20
  build:
    - run:
        script: "true"
`;

console.log('\nvalidate');
const ok = await c.templates.validate(doc);
check('the smoke document is valid', ok.valid === true, ok.problems.join('; ') || ok.ref);
if (!ok.valid) process.exit(1);

/** One build, start to finish, over the event stream. */
async function build(label) {
  console.log(`\n${label}`);
  const b = await c.builds.start(doc, { noReuse: false });
  check(
    'start answers a running build',
    b.status === 'running',
    `${b.id} status=${JSON.stringify(b.status)}`,
  );
  check(
    '  and has not finished yet',
    b.finishedAt === undefined,
    `finishedAt=${b.finishedAt ?? '(absent)'}`,
  );
  const seen = [];
  // Bounded, for the reason the read path's drain is: `sse` has no deadline of
  // its own and a stalled stream would park here for good. The number is far
  // larger than the one there because this build is really compiling — it is a
  // ceiling on a hang, not a budget for the work.
  const stopEvents = new AbortController();
  const eventsTimer = setTimeout(() => stopEvents.abort(), 900_000);
  try {
    for await (const ev of c.builds.events(b.id, { signal: stopEvents.signal })) {
      seen.push(ev);
      console.log(`       ${el()} ${ev.phase} step=${ev.step}/${ev.of} done=${ev.done}`);
    }
  } finally {
    clearTimeout(eventsTimer);
  }
  check(
    '  events returns on a real terminal frame',
    seen.at(-1)?.done === true && !!seen.at(-1)?.status,
    `${seen.length} event(s), status=${JSON.stringify(seen.at(-1)?.status)}`,
  );
  const f = await c.builds.progress(b.id);
  check(
    '  the build succeeded',
    f.status === 'succeeded',
    `status=${JSON.stringify(f.status)} phase=${JSON.stringify(f.phase)}`,
  );
  return f;
}

// The first is `published` on an account that has never built this document and
// `reused` on one that has, so it is not asserted either way — the run that
// first proved this compiles at all took 14.2s and reported `published`, and
// every run since has reused it in under a second. The SECOND is the assertion,
// because it is the one that holds whichever of those happened.
const first = await build('build 1 — compiles, or reuses if this document has been built before');
const second = await build('build 2 — identical document, so it must reuse');

// The whole point of the parameter, and the reason getting `noReuse` wrong is
// expensive rather than merely wrong: an omitted `no_reuse` reaches this.
check(
  'the second build reused an existing image',
  second.phase === 'reused',
  `phase=${JSON.stringify(second.phase)} (first was ${JSON.stringify(first.phase)})`,
);

// Verified rather than assumed: a build compiles a document without claiming
// its ref, so this leaves the name free.
try {
  await c.templates.get(ns, 'sdksmoke');
  check('building does not claim the template ref', false, 'the ref is now taken');
} catch (e) {
  check('building does not claim the template ref', e instanceof NotFoundError, e.name);
}

console.log(`\n${el()} done — ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
