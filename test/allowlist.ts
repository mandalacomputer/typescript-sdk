/**
 * The platform's `/api/v1` route table, mirrored.
 *
 * Keep in step with `V1_ROUTES` in `web/lib/surface.ts` in the platform repo.
 * `scripts/check-surface.mjs` does that comparison whenever both repos are
 * checked out — a mirror nobody compares is just a comment, and the Python SDK
 * has no such script, which is how three routes reached the platform without it
 * ever noticing.
 *
 * This mirrors the table in FULL, including the routes this SDK cannot yet
 * call. Those are named in UNIMPLEMENTED, which is what keeps the distance
 * between the two visible rather than letting it grow quietly: "every call
 * lands on an allowlisted route" stays true no matter how few calls there are.
 */

export type Route = [method: string, pattern: string];

export const ALLOWED: ReadonlySet<string> = new Set(
  (
    [
      ['GET', 'templates'],
      // The template document format (platform OPL-3568): the published JSON
      // Schema, and a check of a document against it that stores nothing.
      ['GET', 'templates/schema'],
      ['POST', 'templates/validate'],
      // The store (platform OPL-3789, OPL-3830). Publish a document under a ref
      // of your own, read one back, retire one.
      ['POST', 'templates'],
      ['GET', 'templates/:namespace/:name'],
      ['DELETE', 'templates/:namespace/:name'],
      // Compiling a document into an image (platform OPL-3791, OPL-3794). The
      // job, its record, and the two halves of watching it — a poll and a
      // stream.
      ['POST', 'builds'],
      ['GET', 'builds'],
      ['GET', 'builds/:id'],
      ['GET', 'builds/:id/progress'],
      ['GET', 'builds/:id/events'],
      ['GET', 'sizes'],

      ['GET', 'computers'],
      ['POST', 'computers'],
      ['GET', 'computers/:id'],
      ['PATCH', 'computers/:id'],
      ['DELETE', 'computers/:id'],
      ['POST', 'computers/:id/start'],
      ['POST', 'computers/:id/stop'],
      ['POST', 'computers/:id/suspend'],
      ['POST', 'computers/:id/restart'],
      ['POST', 'computers/:id/clone'],

      // Taking up the offer a refused resize makes, and reading how it went.
      // `moves` is a collection rather than `computers/:id/move`, which is the
      // platform's decision: a per-computer read could not tell a computer with
      // no move from an id that does not exist.
      ['POST', 'computers/:id/move'],
      ['GET', 'moves'],

      // Computer use.
      ['GET', 'computers/:id/screenshot'],
      ['POST', 'computers/:id/input'],
      ['POST', 'computers/:id/exec'],
      ['GET', 'computers/:id/exec/:pid'],
      ['DELETE', 'computers/:id/exec/:pid'],
      ['GET', 'computers/:id/windows'],
      ['POST', 'computers/:id/windows/:window'],

      // The agent loop, and the same engine behind an OpenAI-shaped door.
      ['POST', 'computers/:id/agent'],
      ['POST', 'chat/completions'],

      // Files in and out of the guest.
      ['PUT', 'computers/:id/files'],
      ['GET', 'computers/:id/files'],

      // Snapshots.
      ['GET', 'snapshots'],
      ['GET', 'computers/:id/snapshots'],
      ['POST', 'computers/:id/snapshots'],
      ['POST', 'snapshots/:id/restore'],
      ['POST', 'snapshots/:id/clone'],
      ['DELETE', 'snapshots/:id'],
      ['GET', 'computers/:id/schedule'],
      ['PUT', 'computers/:id/schedule'],
      ['DELETE', 'computers/:id/schedule'],

      // What the account has used. Account-scoped like `moves`, and for a
      // related reason: the figures include computers that have since been
      // deleted, which is precisely the line an unexplained invoice is about.
      ['GET', 'usage'],

      // How long the automatic snapshots a schedule takes are kept. Account
      // scoped like `usage` and `moves`, and read-only on every surface: the
      // plan owns retention.
      ['GET', 'retention'],
    ] as Route[]
  ).map(([m, p]) => `${m} ${p}`),
);

/**
 * Routes the platform exposes that this SDK cannot yet call.
 *
 * Closing one means deleting its line from here, which is the point: the
 * alternative is a set of routes nobody is tracking, on a surface whose whole
 * design is that it is enumerable.
 */
export const UNIMPLEMENTED: ReadonlySet<string> = new Set([
  // The OpenAI-shaped door onto the agent loop. Deliberately not wrapped: a
  // caller who wants it already has an OpenAI client and points its baseURL
  // here, and a second, worse OpenAI client inside this SDK would be a
  // maintenance obligation with no user.
  'POST chat/completions',
  // The two template document routes were pinned here, behind a comment saying
  // they "become worth a method with publish and launch-by-ref". Publish shipped
  // in platform OPL-3789 and launch-by-ref in OPL-3788, so the line became
  // somebody's to delete and this is it (OPL-3835). Nothing has replaced them:
  // every route this SDK can reach, it calls.
]);

/**
 * Every query parameter, header and body field the platform documents, by route.
 *
 * The second mirror, and the one the first turned out to need. ALLOWED proves
 * the SDK can reach every route; it cannot say whether a call carries the
 * arguments that make the route worth reaching, and for four parameters it did
 * not. `POST computers/:id/stop` was reachable and `force` was not, so a guest
 * that would not shut down had no answer. `GET computers/:id/screenshot` was
 * reachable and `fresh` was not, so every drive loop read the screen as it was
 * up to 1.5 seconds before its own last click. Both routes were green in every
 * test in this directory.
 *
 * Mirrored from the DOCS table in `web/lib/apidoc.ts` in the platform repo,
 * compared by `scripts/check-surface.mjs` whenever both are checked out. That
 * table is the published contract — it is what generates the OpenAPI document
 * and the docs site — so a parameter absent from it is one no caller has been
 * told about, and a parameter here that is absent from it is one this SDK is
 * sending into a handler that ignores it.
 *
 * Kept in the wire spelling, not this SDK's: `ram_mb` and not `ramMb`, so the
 * comparison is against what the platform actually reads.
 */
export const PARAMETERS: ReadonlyMap<string, readonly string[]> = new Map([
  ['GET templates', []],
  ['GET templates/schema', []],
  ['POST templates/validate', []],
  ['POST templates', []],
  // `version` on both halves of the ref route, and the two mean different
  // things by omission: the newest on a read, every version on a retire. An
  // EMPTY one is refused by this SDK before it is sent — see
  // paths.templateVersion, and the platform defect it exists to be on the right
  // side of.
  ['GET templates/:namespace/:name', ['query:version']],
  ['DELETE templates/:namespace/:name', ['query:version']],
  ['POST builds', ['query:no_reuse']],
  // The third fan-out listing, and the last to be able to say so: the platform
  // has answered 503 on this route since it started merging across the fleet,
  // and only documented the way out of it in OPL-3840.
  ['GET builds', ['query:allow_partial']],
  ['GET builds/:id', []],
  ['GET builds/:id/progress', []],
  ['GET builds/:id/events', []],
  ['GET sizes', []],

  ['GET computers', ['query:allow_partial']],
  [
    'POST computers',
    [
      'body:name',
      'body:size',
      'body:template',
      'body:cpu',
      'body:ram_mb',
      'body:disk_gb',
      'body:resolution',
      'body:start',
    ],
  ],
  ['GET computers/:id', []],
  [
    'PATCH computers/:id',
    ['body:name', 'body:cpu', 'body:ram_mb', 'body:disk_gb', 'body:idle_suspend_min'],
  ],
  ['DELETE computers/:id', ['query:snapshots', 'query:expect']],
  ['POST computers/:id/start', []],
  ['POST computers/:id/stop', ['query:force']],
  ['POST computers/:id/suspend', []],
  ['POST computers/:id/restart', []],
  ['POST computers/:id/clone', ['body:name']],
  // The sizing group and nothing else. The platform reads only these three off a
  // move and ignores the rest, so a name sent here would be dropped silently —
  // which is why MoveArgs has no room for one.
  ['POST computers/:id/move', ['body:cpu', 'body:ram_mb', 'body:disk_gb']],
  ['GET moves', []],

  // Computer use.
  ['GET computers/:id/screenshot', ['query:w', 'query:fresh']],
  [
    'POST computers/:id/input',
    [
      'body:action',
      'body:x',
      'body:y',
      'body:coordinate',
      'body:start_coordinate',
      'body:text',
      'body:key',
      'body:keys',
      'body:button',
      'body:scroll_direction',
      'body:amount',
      'body:scroll_amount',
      'body:duration',
    ],
  ],
  [
    'POST computers/:id/exec',
    ['body:command', 'body:session', 'body:timeout_s', 'body:background', 'body:cwd', 'body:env'],
  ],
  ['GET computers/:id/exec/:pid', []],
  ['DELETE computers/:id/exec/:pid', []],
  ['GET computers/:id/windows', ['query:include']],
  [
    'POST computers/:id/windows/:window',
    ['body:action', 'body:x', 'body:y', 'body:width', 'body:height'],
  ],

  [
    'POST computers/:id/agent',
    [
      'header:X-Model-Key',
      'body:prompt',
      'body:system',
      'body:max_steps',
      'body:model',
      'body:stream',
    ],
  ],
  [
    'POST chat/completions',
    [
      'header:X-Model-Key',
      'body:computer_id',
      'body:messages',
      'body:model',
      'body:max_steps',
      'body:stream',
    ],
  ],

  // The file body is the file, raw — there are no named fields to mirror.
  ['PUT computers/:id/files', ['query:path']],
  ['GET computers/:id/files', ['query:path', 'header:Range']],

  ['GET snapshots', ['query:allow_partial', 'query:include']],
  ['GET computers/:id/snapshots', []],
  ['POST computers/:id/snapshots', ['body:name', 'body:memory']],
  ['POST snapshots/:id/restore', []],
  ['POST snapshots/:id/clone', ['body:name']],
  ['DELETE snapshots/:id', []],
  ['GET computers/:id/schedule', []],
  ['PUT computers/:id/schedule', ['body:enabled', 'body:hour', 'body:minute', 'body:tz']],
  ['DELETE computers/:id/schedule', []],

  // Both bounds, and both optional: with neither, the platform answers over the
  // account's current billing period.
  ['GET usage', ['query:from', 'query:to']],

  ['GET retention', []],
]);

/**
 * Parameters the platform documents that this SDK deliberately never sends.
 *
 * Every one is an alternate spelling of something it does send. The input route
 * accepts Anthropic's computer-use vocabulary alongside this API's own, so a
 * model's `tool_use.input` block can be forwarded without translation — which
 * leaves several fields with two names apiece. Picking one and sending it
 * consistently is the point; sending both would be two ways for the same call
 * to mean different things.
 *
 * Not a gap, in other words, and the reason this set is separate from the
 * routes' UNIMPLEMENTED: that one is work to do, this one is a decision.
 * Parameters of a route in UNIMPLEMENTED are not listed here — a route nobody
 * calls sends none of its parameters, and repeating all six of chat/completions'
 * would say nothing the route's own line does not.
 */
export const UNIMPLEMENTED_PARAMETERS: ReadonlySet<string> = new Set([
  // `keys: ['ctrl', 'c']` is sent instead. The chord-as-one-string form cannot
  // express a key whose own name contains the separator.
  'POST computers/:id/input  body:key',
  // `scroll_direction` is sent instead — `button` is the flat vocabulary's name
  // for it, and on a route that also accepts a real mouse button that is a word
  // worth not overloading.
  'POST computers/:id/input  body:button',
  // `amount` is sent instead. Same value, two names.
  'POST computers/:id/input  body:scroll_amount',
]);

/**
 * Reduce a concrete path to its route shape, as the platform's proxy does.
 *
 * `:pid` and `:window` rather than a second `:id`, because that is how
 * surface.ts spells them and this table is compared against that one.
 */
export function patternFor(path: string): string {
  const parts = path.split('/').filter(Boolean);
  const out: string[] = [];
  for (const seg of parts) {
    // Keyed off what the previous segment was normalised TO, not what it was.
    // Read off the raw path, a computer whose id happens to be spelled "exec"
    // turns the action after it into a ':pid' — `computers/exec/start` becomes
    // `computers/:id/:pid`, a shape the platform has no route for, failing this
    // test for a reason nothing about the failure would explain. A segment that
    // already became a parameter is an id, and what follows an id is a literal.
    const prev = out[out.length - 1];
    if (prev === undefined || PATH_PARAMETERS.has(prev)) out.push(seg);
    else if (prev === 'computers' || prev === 'snapshots' || prev === 'builds') out.push(':id');
    else if (prev === 'exec') out.push(':pid');
    else if (prev === 'windows') out.push(':window');
    else out.push(seg);
  }
  // A template ref's two halves, pinned to a THREE-segment path under
  // `templates` — which is what keeps the two-segment literals,
  // `templates/schema` and `templates/validate`, reducing to themselves. The
  // platform's own patternFor pins them the same way and for the same reason,
  // and a mirror that reduced them differently would compare two different
  // tables and call them equal.
  //
  // After the loop rather than inside it, because the rule is about the path's
  // LENGTH: reading it per segment means deciding what `templates/schema` is
  // before knowing whether a third segment follows.
  //
  // Two placeholders and not one: a namespace is an account id and a name is
  // not, so a table entry reading `templates/:id/:id` would look like a typo.
  if (out[0] === 'templates' && out.length === 3) return `templates/:namespace/:name`;
  return out.join('/');
}

/** The placeholders {@link patternFor} produces — path parameters, not request ones. */
const PATH_PARAMETERS: ReadonlySet<string> = new Set([
  ':id',
  ':pid',
  ':window',
  ':namespace',
  ':name',
]);
