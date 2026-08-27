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
 * It publishes nothing. `builds.start` compiles a document without claiming its
 * ref — verified, not assumed: after a build of `<account>/sdksmoke@1.0.0` the
 * ref is still a 404 from `templates.get`. What it does leave behind is a build
 * record and a published image family, both of which are ordinary history.
 */

import { Client, MandalaError, NotFoundError } from '../dist/index.js';

const key = process.env.MANDALA_API_KEY?.trim();
if (!key) {
  console.log('smoke-live — no MANDALA_API_KEY, so nothing to call. Skipped.');
  process.exit(0);
}

const wantBuild = process.argv.includes('--build');
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

console.log(`smoke-live — ${c.baseUrl}\n`);

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
for (const kind of ['succeeded', 'failed']) {
  const b = finished.find((x) => x.status === kind);
  if (!b) {
    console.log(`  --   no ${kind} build on this account to read; skipped`);
    continue;
  }
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
  try {
    for await (const ev of c.builds.events(b.id)) seen.push(ev);
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
  }
}

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
try {
  await c.builds.start('apiVersion: mandala/v1\n', { noReuse: /** @type {never} */ ('false') });
  check('noReuse:"false" is refused before the request', false, 'it was sent');
} catch (e) {
  check(
    'noReuse:"false" is refused before the request',
    e instanceof TypeError && !(e instanceof MandalaError),
    e.name,
  );
}

// ---- the write path ------------------------------------------------------

if (!wantBuild) {
  console.log(`\n${el()} read-only. Pass --build to compile a throwaway document too.`);
  process.exit(failures === 0 ? 0 : 1);
}

const ns = builds[0]?.ref?.split('/')[0];
if (!ns?.startsWith('acc-')) {
  console.log("\n--build needs an existing build to learn this account's namespace from. Skipped.");
  process.exit(failures === 0 ? 0 : 1);
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
  for await (const ev of c.builds.events(b.id)) {
    seen.push(ev);
    console.log(`       ${el()} ${ev.phase} step=${ev.step}/${ev.of} done=${ev.done}`);
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
