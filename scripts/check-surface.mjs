#!/usr/bin/env node
/**
 * Diff the mirrors in test/allowlist.ts against the real tables in the platform
 * repo — the routes, and the parameters each route takes.
 *
 * The mirror is what keeps this SDK honest about what exists, and a mirror
 * nobody compares is just a comment. That is not hypothetical:
 * `computers/:id/exec/:pid` (both verbs) and `GET computers/:id/snapshots`
 * reached the platform without any SDK's surface test noticing, because "every
 * call lands on an allowlisted route" stays true when the allowlist is the stale
 * one. mandala-computer-python has since grown its own checker
 * (`scripts/check_surface.py`) and mandala-computer-mcp has a copy of this one,
 * so all three now say so.
 *
 * The parameter half exists because the route half was not enough. Every route
 * was reachable and four documented parameters were not: `stop?force`,
 * `screenshot?fresh`, `exec`'s `env` and a snapshot's `name`. A route table
 * cannot see any of them — the call lands on the right route either way, and
 * the only thing missing is the argument that made it worth making. Two of the
 * four were the difference between a call that works and a call that works
 * wrongly and says nothing: a graceful stop for a guest that will not come
 * down, and a cached frame for a model deciding where to click next.
 *
 * Exits 0 and says so when the platform repo is not checked out. That is the
 * ordinary case in CI on this repository, and failing over it would make the
 * check something people learn to ignore. What is not that case is an operator
 * who named a directory: `MANDALA_PLATFORM_REPO` is an assertion that the repo
 * is at that path, and a path that turns out not to hold it is a mistake to
 * report rather than a repo to go looking for elsewhere.
 *
 * Where it is enforced is the platform's own CI, which checks this repo out
 * beside itself and runs this script against it (OPL-3916). That is deliberate
 * rather than incidental: what this prints is the routes, parameters and
 * constant values that have not shipped yet, and this repository's Actions logs
 * are world-readable the day it goes public, where the platform's are not.
 * Running it here would also put a read key for a private repo inside a public
 * one, which is the wrong direction for a credential to point.
 *
 * So on a machine that has both this is what catches drift before a push, and
 * everywhere else it is what the platform runs.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  balanced,
  entries,
  leadingArrayLiteral,
  listItems,
  moduleDeclarations,
  objectFields,
  stringLiteral,
  stripComments,
  topLevelField,
  topLevelKeys,
  topLevelValueAt,
} from './surface-text.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');

// One marker identifies the checkout, and the rest of the layout is then
// required of it rather than searched for. Asking for both at once conflates
// two different answers: "this directory is not the platform, so there is
// nothing here to compare" and "this is the platform and a file this reads has
// moved" — and the second, answered as the first, takes the ROUTE half of the
// gate down as well, silently, over a file the route half never opens.
const MARKER = 'web/lib/surface.ts';
const ALSO_READ = ['web/lib/apidoc.ts'];

/** The platform checkout to compare against, or null when there is none. */
function platformRepo() {
  // Resolved against this repo the way the guesses below are. Left raw it
  // resolves against the working directory instead, so the same value means two
  // different directories depending on where npm was invoked, and the "Looked
  // in" line prints one relative path beside two absolute ones — which reads as
  // the directory the operator meant rather than the one that was searched.
  const asked = process.env.MANDALA_PLATFORM_REPO
    ? resolve(repo, process.env.MANDALA_PLATFORM_REPO)
    : undefined;
  const candidates = [
    asked,
    resolve(repo, '..', 'mandala-computer'),
    resolve(repo, '..', 'app'),
  ].filter(Boolean);

  if (asked && !existsSync(join(asked, MARKER))) {
    // The one machine where this gate is enforced is the one that sets this
    // variable, for three SDKs at once. A checkout path that moves, or a
    // variable that fails to expand, would otherwise be indistinguishable from
    // "no platform here" — three green no-ops, three surface mirrors nobody
    // compared, on the only run that compares them.
    console.error(
      `check:surface — MANDALA_PLATFORM_REPO is set to ${asked}, which does not hold ${MARKER}.\n` +
        '  Point it at a platform checkout, or unset it to skip the comparison.',
    );
    process.exitCode = 1;
    return null;
  }

  const found = candidates.find((dir) => existsSync(join(dir, MARKER)));
  if (!found) {
    console.log(
      'check:surface — platform repo not found, skipping.\n' +
        `  Looked in: ${candidates.join(', ')}\n` +
        '  Set MANDALA_PLATFORM_REPO to compare against web/lib.',
    );
    return null;
  }

  const missing = ALSO_READ.filter((file) => !existsSync(join(found, file)));
  if (missing.length) {
    console.error(
      `check:surface — ${found} is a platform checkout missing ${missing.join(', ')}.\n` +
        '  The file moved or was renamed. Until this reader is pointed at the new one\n' +
        '  the comparison below is partly blind, which is worse than it failing.',
    );
    process.exitCode = 1;
    return null;
  }
  return found;
}

main();

function main() {
  const platform = platformRepo();
  if (!platform) return;

  // --- reading TypeScript without a TypeScript loader ------------------------
  //
  // Both files are read as text and matched over, so this runs with no build
  // step and no dependency. Comments are stripped from anything matched, because
  // both are heavily commented and several of those comments quote the very
  // shapes being matched — over them, the regexes invent routes and parameters.
  // See scripts/surface-text.mjs, which is a copy of the same helpers in the MCP
  // server: a parser bug found in one is worth carrying to the other.

  // --- routes ---------------------------------------------------------------

  // Comments blanked once, over the whole file: every scan below reads this,
  // because a declaration or an entry quoted in a comment is source to a
  // pattern and prose to a reader, and the pattern wins. Blanked rather than
  // deleted, so every offset here still indexes the same character.
  const surfaceClean = stripComments(readFileSync(join(platform, 'web/lib/surface.ts'), 'utf8'));

  /**
   * Pull one `export const NAME: Route[] = [...]` table out, entry by entry.
   *
   * Split by brace depth rather than matched with one regex across the whole
   * table. A `/method:.*?pattern:/` over the flat text is correct only while
   * every entry happens to write its method first: reorder two fields and the
   * lazy match joins one entry's method to the next entry's pattern. What comes
   * out is a route neither table has — and a route that is in neither is not a
   * failure here, it is silence. A checker whose failure mode is a false
   * all-clear is worse than no checker, which is what the brace walk is for.
   *
   * Slicing the entry is only half of it. Within one entry the fields are read
   * at that entry's own depth, because a nested literal can quote a `pattern` of
   * its own — an options bag, a `handler: {}` with a path in it — and a regex
   * over the entry takes whichever comes first.
   *
   * The split itself is `entries`, which skips literals rather than counting
   * every brace it sees. A raw count is the same bug one level down: a lone `}`
   * in a string desyncs the depth for good, and the entries after it are dropped
   * without a word.
   *
   * The `!routes.size` guard below only catches a parse that found nothing at
   * all, which is exactly what a mispaired parse is not.
   */
  function routeTable(name) {
    // In module code, and exactly once. `indexOf` found the first spelling of
    // the declaration anywhere in the file, and anywhere includes inside a
    // regex literal — `export default /a; export const V1_ROUTES … ; z/;` is
    // legal, and the table written in it was read as the real one, ahead of the
    // real one further down.
    const declared = moduleDeclarations(surfaceClean, `export const ${name}: Route\\[\\] = \\[`);
    if (declared.length !== 1) {
      throw new Error(
        `${name} in web/lib/surface.ts is ${declared.length ? 'declared more than once' : 'not declared'} ` +
          'where this reader can read it',
      );
    }
    // The opening bracket of the table, not the one in `Route[]` a few
    // characters earlier — which is what an indexOf('[') from the declaration
    // finds, and which closes immediately.
    const body = balanced(surfaceClean, declared[0].index + declared[0].length - 1, '[', ']');
    const routes = new Set();
    for (const entry of entries(body)) {
      // Both, out of ONE entry and at that entry's own depth. An entry carrying
      // only half of the pair is not a route, and must borrow the other half
      // neither from its neighbour nor from a literal nested in it.
      const method = topLevelField(entry, 'method');
      const pattern = topLevelField(entry, 'pattern');
      // Refused rather than skipped. An entry this reader cannot read both
      // halves of is not a half-written route — it is a spelling the walk above
      // got wrong, or a value built from something it cannot see, and dropping
      // it reports a route the platform serves as one the mirror invented.
      if (!method || !pattern) {
        throw new Error(
          `an entry of ${name} in web/lib/surface.ts has no literal method and pattern ` +
            `this reader can read: ${JSON.stringify(entry.trim().slice(0, 60))}`,
        );
      }
      routes.add(`${method} ${pattern}`);
    }
    if (!routes.size)
      throw new Error(`parsed ${name} but found no routes — has its shape changed?`);
    return routes;
  }

  const platformRoutes = routeTable('V1_ROUTES');

  const mirrorSource = readFileSync(join(repo, 'test/allowlist.ts'), 'utf8');

  // Every scan of the mirror reads this, for the same reason the platform's side
  // does: a declaration name quoted in a comment is source to `indexOf` and prose
  // to a reader. Length-preserving, so offsets index either text alike.
  const mirrorClean = stripComments(mirrorSource);

  /**
   * The array literal one of the mirror's tables is built from.
   *
   * Read the way the platform's table is read, and for the reasons OPL-4784
   * established over there rather than as a matter of taste. What this replaced
   * took `indexOf('export const ALLOWED')` on the RAW source and ended the
   * section at `indexOf('export const UNIMPLEMENTED')`, which is three holes:
   *
   * - `indexOf` finds the first spelling anywhere, and anywhere includes inside a
   *   string, a regex literal or a nested scope. The comment strip came after the
   *   slice, so a name written in a comment beat the declaration under it.
   * - The end of a section was another `indexOf` of another name, so a table
   *   whose successor gets renamed silently swallows the rest of the file.
   * - `stripComments` ran on the slice, so the offsets inside it agreed with
   *   nothing else here.
   *
   * Bounded by the initializer's own parentheses instead, which cannot run past
   * the declaration however the file is reordered.
   */
  function mirrorTable(name) {
    const declared = moduleDeclarations(
      mirrorClean,
      `export const ${name}\\s*:[^=]*=\\s*new (?:Set|Map)\\(`,
    );
    if (declared.length !== 1) {
      throw new Error(
        `${name} in test/allowlist.ts is ${declared.length ? 'declared more than once' : 'not declared'} ` +
          'where this reader can read it',
      );
    }
    const initializer = balanced(mirrorClean, declared[0].index + declared[0].length - 1, '(', ')');
    return leadingArrayLiteral(initializer, `${name} in test/allowlist.ts`);
  }

  /**
   * One quoted string out of a table element, or a throw naming the element.
   *
   * Refused rather than skipped, which is the whole of what fail-closed means
   * here. The regexes this replaced matched single quotes only, so an entry
   * written — or reformatted — with double quotes was not a complaint, it was a
   * table shorter by however much it held: a route the mirror still lists and the
   * platform has dropped went unreported, because the comparison never saw the
   * mirror's copy of it.
   */
  function mirrorString(element, what) {
    const value = stringLiteral(element);
    if (value === undefined) {
      throw new Error(
        `${what} in test/allowlist.ts is not a plain quoted string this reader can read: ` +
          JSON.stringify(element.slice(0, 60)),
      );
    }
    return value;
  }

  const mirrorRoutes = new Set(
    listItems(mirrorTable('ALLOWED')).map((entry) => {
      // A `[method, pattern]` pair and nothing else. An element of another shape
      // is a spelling this reader got wrong, and calling it a route with one half
      // missing would put a line nobody serves into the comparison.
      const refuse = () => {
        throw new Error(
          'an entry of ALLOWED in test/allowlist.ts is not a [method, pattern] pair: ' +
            JSON.stringify(entry.trim().slice(0, 60)),
        );
      };
      const text = entry.trim();
      if (!text.startsWith('[') || !text.endsWith(']')) refuse();
      const pair = listItems(balanced(text, 0, '[', ']'));
      if (pair.length !== 2) refuse();
      return `${mirrorString(pair[0], "an ALLOWED entry's method")} ${mirrorString(pair[1], "an ALLOWED entry's pattern")}`;
    }),
  );

  // --- parameters -----------------------------------------------------------

  const docSource = readFileSync(join(platform, 'web/lib/apidoc.ts'), 'utf8');
  // Every scan below reads this rather than the raw file. A declaration or a
  // route key quoted in a comment — which is how apidoc.ts explains itself, and
  // its comment above ALLOW_PARTIAL spells out the very shape this file matches
  // on — is source to a regex and prose to a reader, and the regex wins.
  // Length-preserving by construction: comments are blanked, not deleted, so
  // every offset here indexes the same character in either text.
  const docClean = stripComments(docSource);

  /**
   * Module-level `const NAME: Query = {...}` entries.
   *
   * A route's `query` or `headers` array can reference one of these by
   * identifier instead of spelling it out — ALLOW_PARTIAL is shared by two
   * routes — so the identifier has to resolve to a parameter name or those
   * routes read as taking none. `Query` is the type of both lists over there
   * (`headers?: Query[]`), so what these name is a parameter of whichever list
   * cites it rather than a query parameter by construction.
   *
   * `export` and indentation are both allowed for, because neither changes what
   * the declaration means and a reader that insists on today's spelling reports
   * every route citing a re-spelled constant as taking no parameters at all.
   * Allowing indentation is also why this reads `docClean`: a superseded copy of
   * a declaration quoted in a block comment is indented under its `*`, so the
   * relaxed pattern reaches it, and the later copy wins the Map. Every route
   * citing the identifier then reports one missing and one extra parameter,
   * both naming the name nobody serves.
   *
   * Any identifier, and the name read as a literal in whichever quote style it
   * is written in. Both halves were a silent drop: a `const allowPartial:
   * Query` went unseen because the pattern asked for capitals, and a
   * `name: "limit"` went unread because the old match asked for single quotes —
   * and in either case every route citing the constant reported no parameters
   * at all while the scan's own "found nothing" guard stayed quiet, because the
   * other routes counted.
   */
  const sharedParams = new Map();
  for (const declaration of moduleDeclarations(
    docClean,
    '(?:export\\s+)?const ([A-Za-z_$][\\w$]*)\\s*:\\s*Query\\s*=\\s*\\{',
  )) {
    const [identifier] = declaration.groups;
    const body = balanced(docClean, declaration.index + declaration.length - 1, '{', '}');
    const named = topLevelField(body, 'name');
    if (named === undefined) {
      throw new Error(
        `the shared parameter ${identifier} in web/lib/apidoc.ts has no name this reader can read`,
      );
    }
    // Two declarations of one identifier is one of them winning by read order,
    // over a name every route citing it is compared against.
    if (sharedParams.has(identifier)) {
      throw new Error(`the shared parameter ${identifier} is declared twice in web/lib/apidoc.ts`);
    }
    sharedParams.set(identifier, named);
  }

  /** Every query, header and body field the platform documents, by route. */
  function platformParameters() {
    // In module code and exactly once, for the reason routeTable reads its
    // table that way: `indexOf` answers with the first spelling of the
    // declaration anywhere in the file, including inside a regex literal.
    const declared = moduleDeclarations(docClean, 'export const DOCS: Record<string, Doc> = \\{');
    if (declared.length !== 1) {
      throw new Error(
        `DOCS in web/lib/apidoc.ts is ${declared.length ? 'declared more than once' : 'not declared'} ` +
          'where this reader can read it',
      );
    }
    // The comments are already gone: the key is captured by a regex over this
    // text, and a comment quoting a route key — which is how apidoc.ts explains
    // itself — reads as an entry of its own; `table.set` then puts its empty
    // parameter set where the real route's belongs, and the route is compared
    // against nothing.
    const docs = balanced(docClean, declared[0].index + declared[0].length - 1, '{', '}');

    const table = new Map();
    // Every entry accounted for, rather than every entry a regex recognises.
    // `'([A-Z]+) ([^']+)':` reads the keys written in single quotes and passes
    // over the rest without a word: a route key spelled with double quotes is
    // then absent from this table, compared against nothing, and the scan's own
    // "found no routes" guard stays quiet because the others counted. A spread
    // or a computed key is refused here for the same reason — what it carries
    // cannot be seen, and a table short by an unknown amount must not read as
    // agreement.
    for (const [route, value] of objectFields(docs)) {
      if (!/^[A-Z]+ .+/.test(route)) {
        throw new Error(`web/lib/apidoc.ts DOCS holds a key this reader cannot read: '${route}'`);
      }
      if (value[0] !== '{') {
        throw new Error(
          `'${route}' in web/lib/apidoc.ts is documented in a shape this reader ` +
            'does not know — not an object literal.',
        );
      }
      const body = balanced(value, 0, '{', '}');
      const params = new Set();

      for (const [key, kind] of [
        ['query', 'query'],
        ['headers', 'header'],
      ]) {
        // At the entry's own depth, for the reason the body below is: a regex
        // over the whole entry answers with the first `query: [` at any depth,
        // so a description or a response example nesting one of its own supplies
        // the parameters and the route's real list — further down, at the
        // entry's own depth — is never read at all. A parameter set read out of
        // prose is then compared against the mirror as if the platform had
        // documented it, and the route's genuine parameters surface as ones the
        // mirror invented, which sends whoever reads the report to the wrong
        // file to delete entries that are correct. The guard for a scan that
        // counted nothing does not fire, because the other routes counted.
        //
        // It keeps what the regex was there for: the one space after the colon
        // is a spelling, not a shape, and a list the formatter wrapped —
        // `query:\n  [{ name: 'limit' }]` — is still found, because the key
        // pattern spans the whitespace either way.
        const at = topLevelValueAt(body, key);
        if (at === -1) continue;
        if (body[at] !== '[') {
          throw new Error(
            `'${route}' in web/lib/apidoc.ts documents ${key} in a shape this reader does not ` +
              'know — not an array literal.',
          );
        }
        const list = balanced(body, at, '[', ']');
        // Element by element, and every element accounted for. The two regexes
        // this replaces each had a hole of its own. `name:\s*'([^']+)'` read
        // the whole list flat, so a `name` nested in a schema counted as a
        // parameter of the route and a `name: "x"` counted as nothing; and the
        // identifier scan, reading the same flat text, could only be forgiving
        // of what it did not recognise, because the prose in each entry's
        // description is full of ordinary capitalised words — RFC, UTC — that
        // look exactly like a shared constant. Reading the elements is what
        // makes an unresolved identifier a real answer: there is no prose at
        // this depth to mistake for one.
        for (const item of listItems(list)) {
          if (item[0] === '{') {
            const inner = balanced(item, 0, '{', '}');
            if (inner.length + 2 !== item.length) {
              throw new Error(
                `'${route}' has a ${key} entry with an expression after its literal: ` +
                  JSON.stringify(item.slice(0, 60)),
              );
            }
            const name = topLevelField(inner, 'name');
            if (name === undefined) {
              throw new Error(
                `'${route}' has a ${key} entry with no name this reader can read: ` +
                  JSON.stringify(item.slice(0, 60)),
              );
            }
            params.add(`${kind}:${name}`);
          } else if (/^[A-Za-z_$][\w$]*$/.test(item)) {
            const shared = sharedParams.get(item);
            // Unresolved is refused rather than ignored: a constant this reader
            // cannot resolve is a parameter the route takes and the comparison
            // cannot see, which is the shape of every drift this script exists
            // to catch.
            if (shared === undefined) {
              throw new Error(
                `'${route}' cites ${item} in its ${key} list, which is not a shared ` +
                  'parameter this reader resolved.',
              );
            }
            params.add(`${kind}:${shared}`);
          } else {
            throw new Error(
              `'${route}' has a ${key} entry this reader cannot read: ` +
                JSON.stringify(item.slice(0, 60)),
            );
          }
        }
      }

      // Only the `object(...)` bodies have named fields. A raw one — the file
      // upload's and the template document's `{ type: 'string', format:
      // 'binary' }` — has none to name. Anything else spelled where a body goes
      // is a shape this cannot read, and reading it as no fields would say the
      // route documents no body at all: the mirror lists none for such a route
      // either, so the two agree about nothing.
      //
      // All three cases are decided at the entry's own depth. Asking the whole
      // entry text whether it holds a readable body lets a nested one answer:
      // a `body: { … }` inside a response example vouches for the entry's own
      // `body: SHARED_BODY`, the throw is skipped, and the route reports no
      // fields — which matches a mirror that lists none. That is the vacuous
      // all-clear this guard exists to refuse, arriving through the guard.
      const bodyAt = topLevelValueAt(body, 'body');
      if (bodyAt !== -1) {
        const object = /^object\s*\(/.exec(body.slice(bodyAt));
        const args = object && balanced(body, bodyAt + object[0].length - 1, '(', ')');
        // An `object(SHARED_FIELDS)` is as unreadable as a bare identifier is,
        // and it belongs in the message that names the route: fed to `balanced`
        // unchecked, its missing `{` came back as an offset assertion naming
        // neither the route nor the file it is in.
        const brace = args === null ? -1 : args.indexOf('{');
        if (brace !== -1) {
          for (const k of topLevelKeys(balanced(args, brace, '{', '}'))) params.add(`body:${k}`);
        } else if (body[bodyAt] !== '{') {
          throw new Error(
            `'${route}' documents a body in a form this reader does not know — ` +
              'neither object(...) nor a raw schema literal.',
          );
        }
      }
      table.set(route, params);
    }
    return table;
  }

  /**
   * The same, read out of the mirror's PARAMETERS map.
   *
   * Every entry accounted for, and every parameter inside it. The regex pair this
   * replaced skipped a route key it could not match and skipped a parameter name
   * it could not match, in both cases without a word — and the guard downstream
   * only notices a table that came back empty, which a table missing one entry is
   * not. Two spellings of one route are refused too: which of them won depended
   * on the order they were read in, which is a coin toss over a route's
   * parameters.
   */
  function mirrorParameters() {
    const table = new Map();
    for (const entry of listItems(mirrorTable('PARAMETERS'))) {
      const refuse = (why) => {
        throw new Error(
          `an entry of PARAMETERS in test/allowlist.ts ${why}: ` +
            JSON.stringify(entry.trim().slice(0, 60)),
        );
      };
      const text = entry.trim();
      if (!text.startsWith('[') || !text.endsWith(']')) refuse('is not a [route, params] pair');
      const pair = listItems(balanced(text, 0, '[', ']'));
      if (pair.length !== 2) refuse('is not a [route, params] pair');
      const route = mirrorString(pair[0], "a PARAMETERS entry's route");
      const list = pair[1].trim();
      if (!list.startsWith('[') || !list.endsWith(']')) refuse('has no literal parameter list');
      const params = new Set(
        listItems(balanced(list, 0, '[', ']')).map((p) =>
          mirrorString(p, `a parameter of ${JSON.stringify(route)}`),
        ),
      );
      if (table.has(route)) refuse('names a route the table already carries');
      table.set(route, params);
    }
    return table;
  }

  // --- the comparison -------------------------------------------------------

  const problems = [];

  const missingRoutes = [...platformRoutes].filter((r) => !mirrorRoutes.has(r)).sort();
  const extraRoutes = [...mirrorRoutes].filter((r) => !platformRoutes.has(r)).sort();

  if (missingRoutes.length) {
    problems.push(
      'routes the platform exposes that the mirror does not list:\n' +
        missingRoutes.map((r) => `  + ${r}`).join('\n') +
        '\n\n  Add each to ALLOWED in test/allowlist.ts. If this SDK cannot call it yet,\n' +
        '  add it to UNIMPLEMENTED too, so the gap stays a number somebody has to edit down.',
    );
  }
  if (extraRoutes.length) {
    problems.push(
      'routes the mirror lists that the platform does not expose:\n' +
        extraRoutes.map((r) => `  - ${r}`).join('\n') +
        '\n\n  Either the platform dropped these, or the mirror invented them. A call to\n' +
        "  one of these 404s in a user's hands.",
    );
  }

  const platformParams = platformParameters();
  const mirrorParams = mirrorParameters();

  // Only over the routes both tables agree exist. A route missing from the
  // mirror is already reported above, and reporting each of its parameters again
  // buries the one line that says what to do about it.
  const shared = [...platformRoutes].filter((r) => mirrorRoutes.has(r)).sort();
  const missingParams = [];
  const extraParams = [];
  let counted = 0;

  for (const route of shared) {
    const theirs = platformParams.get(route) ?? new Set();
    const ours = mirrorParams.get(route) ?? new Set();
    counted += theirs.size;
    for (const p of [...theirs].sort()) if (!ours.has(p)) missingParams.push(`${route}  ${p}`);
    for (const p of [...ours].sort()) if (!theirs.has(p)) extraParams.push(`${route}  ${p}`);
  }

  if (!platformParams.size) {
    problems.push(
      'no parameters could be read out of web/lib/apidoc.ts.\n\n' +
        '  The DOCS table moved or changed shape. This check is silently vacuous until\n' +
        '  the reader above is fixed — which is worse than it failing, so it fails.',
    );
  }
  // The number the success line prints is also the one thing that says the
  // comparison happened at all. Every route the platform documents carries at
  // least one parameter or field today, so a run that agrees about every route
  // and compared none of them read the DOCS keys in a shape that no longer
  // matches the mirror's — a green line over an empty loop.
  if (shared.length && !counted) {
    problems.push(
      `compared zero parameters across ${shared.length} shared routes.\n\n` +
        '  Both sides came back empty, so the parameter half agreed about nothing and\n' +
        '  said it matched. The route key format on one side or the other changed.',
    );
  }
  if (missingParams.length) {
    problems.push(
      'parameters the platform documents that the mirror does not list:\n' +
        missingParams.map((p) => `  + ${p}`).join('\n') +
        '\n\n  Add each to PARAMETERS in test/allowlist.ts. If this SDK cannot send it yet,\n' +
        '  add it to UNIMPLEMENTED_PARAMETERS too — which is the line that makes the gap\n' +
        "  somebody's to close rather than nobody's to notice.",
    );
  }
  if (extraParams.length) {
    problems.push(
      'parameters the mirror lists that the platform does not document:\n' +
        extraParams.map((p) => `  - ${p}`).join('\n') +
        '\n\n  Either the platform dropped these, or the mirror invented them. One the SDK\n' +
        '  actually sends is a field the platform ignores, silently.',
    );
  }

  if (!problems.length) {
    console.log(
      `check:surface — the mirror matches the platform (${mirrorRoutes.size} routes, ` +
        `${counted} parameters).`,
    );
    return;
  }

  for (const p of problems) console.error(`\ncheck:surface — ${p}`);
  // The checkout location is deliberately NOT printed. This output gets pasted
  // into pull requests on a public repository, and the absolute path of a
  // developer's checkout of the private platform repo has no business there.
  // Whoever runs this knows where they pointed it; set MANDALA_PLATFORM_REPO
  // if it needs saying.
  // Set rather than exited on. stdout and stderr are asynchronous when they are
  // a pipe, which is what CI gives them, and `process.exit` abandons whatever is
  // still queued — on the one path whose whole output is the report that says
  // what to fix. Returning lets node drain them and leave with this status.
  process.exitCode = 1;
}
