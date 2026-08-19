#!/usr/bin/env node
/**
 * Diff the mirrored allowlist in test/allowlist.ts against the real one in the
 * platform repo.
 *
 * The mirror is what keeps this SDK honest about which routes exist, and a
 * mirror nobody compares is just a comment. mandala-computer-python has the
 * mirror and not this script, which is how `computers/:id/exec/:pid` (both
 * verbs) and `GET computers/:id/snapshots` reached the platform without its
 * surface test ever noticing — the test kept passing, because "every call lands
 * on an allowlisted route" stays true when the allowlist is the stale one.
 *
 * Exits 0 and says so when the platform repo is not checked out. That is the
 * ordinary case in CI on this repository, and failing over it would make the
 * check something people learn to ignore. Where it matters is on a machine that
 * has both, and in any job that checks out both.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');

const candidates = [
  process.env.MANDALA_PLATFORM_REPO,
  resolve(repo, '..', 'platform'),
  resolve(repo, '..', 'mandala-computer'),
  resolve(repo, '..', 'app'),
].filter(Boolean);

const platform = candidates.find((dir) => existsSync(join(dir, 'web/lib/surface.ts')));
if (!platform) {
  console.log(
    'check:surface — platform repo not found, skipping.\n' +
      `  Looked in: ${candidates.join(', ')}\n` +
      '  Set MANDALA_PLATFORM_REPO to compare against web/lib/surface.ts.',
  );
  process.exit(0);
}

const source = readFileSync(join(platform, 'web/lib/surface.ts'), 'utf8');

/** Pull one `export const NAME: Route[] = [...]` table out, balanced by bracket depth. */
function table(name) {
  const decl = `export const ${name}: Route[] = [`;
  const start = source.indexOf(decl);
  if (start === -1) throw new Error(`${name} not found in web/lib/surface.ts`);
  // The opening bracket of the table, not the one in `Route[]` a few characters
  // earlier — which is what an indexOf('[') from the declaration finds, and
  // which closes immediately.
  let depth = 0;
  let i = start + decl.length - 1;
  const from = i;
  for (; i < source.length; i++) {
    if (source[i] === '[') depth++;
    else if (source[i] === ']' && --depth === 0) break;
  }
  const body = source.slice(from + 1, i);
  const routes = [];
  // Comments are stripped first: the table is heavily commented, and several of
  // those comments quote route patterns. Matching over them invents routes.
  const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const re = /method:\s*'([A-Z]+)'[\s\S]*?pattern:\s*'([^']+)'/g;
  for (let m = re.exec(code); m; m = re.exec(code)) routes.push(`${m[1]} ${m[2]}`);
  return new Set(routes);
}

const platformRoutes = table('V1_ROUTES');

// Read the mirror out of the TypeScript rather than importing it, so this runs
// with no build step and no TypeScript loader.
const mirrorSource = readFileSync(join(repo, 'test/allowlist.ts'), 'utf8');
const mirrorBody = mirrorSource
  .slice(
    mirrorSource.indexOf('export const ALLOWED'),
    mirrorSource.indexOf('export const UNIMPLEMENTED'),
  )
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '');
const mirror = new Set(
  [...mirrorBody.matchAll(/\[\s*'([A-Z]+)'\s*,\s*'([^']+)'\s*\]/g)].map((m) => `${m[1]} ${m[2]}`),
);

const missing = [...platformRoutes].filter((r) => !mirror.has(r)).sort();
const extra = [...mirror].filter((r) => !platformRoutes.has(r)).sort();

if (!missing.length && !extra.length) {
  console.log(
    `check:surface — the mirror matches the platform (${mirror.size} routes, from ${platform}).`,
  );
  process.exit(0);
}

if (missing.length) {
  console.error('\ncheck:surface — routes the platform exposes that the mirror does not list:');
  for (const r of missing) console.error(`  + ${r}`);
  console.error(
    '\n  Add each to ALLOWED in test/allowlist.ts. If this SDK cannot call it yet,\n' +
      '  add it to UNIMPLEMENTED too, so the gap stays a number somebody has to edit down.',
  );
}
if (extra.length) {
  console.error('\ncheck:surface — routes the mirror lists that the platform does not expose:');
  for (const r of extra) console.error(`  - ${r}`);
  console.error(
    '\n  Either the platform dropped these, or the mirror invented them. A call to\n' +
      "  one of these 404s in a user's hands.",
  );
}
console.error(`\n  Platform: ${join(platform, 'web/lib/surface.ts')}`);
process.exit(1);
