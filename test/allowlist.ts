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
]);

/**
 * Reduce a concrete path to its route shape, as the platform's proxy does.
 *
 * `:pid` and `:window` rather than a second `:id`, because that is how
 * surface.ts spells them and this table is compared against that one.
 */
export function patternFor(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts
    .map((seg, i) => {
      const prev = parts[i - 1];
      if (!prev) return seg;
      if (prev === 'computers' || prev === 'snapshots') return ':id';
      if (prev === 'exec') return ':pid';
      if (prev === 'windows') return ':window';
      return seg;
    })
    .join('/');
}
