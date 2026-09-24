/**
 * `mandala secrets list | set | rm` — the account's secret store (OPL-4984).
 *
 * A value goes IN and never comes back out: the platform answers names, ids and
 * revisions only, so nothing here ever prints one. `set` reads it from stdin or
 * a hidden prompt, never from argv, where it would sit in shell history and in
 * every process listing on the machine.
 */

import { CliError } from './cli-options.js';
import type { Output } from './cli-output.js';
import { type CliIO, readSecretValue } from './cli-runtime.js';
import { ConflictError } from './errors.js';
import type { Client, Secret } from './index.js';
import * as P from './paths.js';

/** How many times `set` and `rm` re-read a secret whose revision moved under them. */
const REVISION_ATTEMPTS = 3;

const scope = (workspace: string | undefined): P.SecretScopeArgs =>
  workspace === undefined ? {} : { workspaceId: workspace };

/** A secret as the CLI prints it: the platform's own projection, which has no value in it. */
const shown = (s: Secret) => s.raw;

/**
 * The secret a name means in one scope, or `undefined`.
 *
 * The platform keeps names unique ignoring ASCII case, so `token` and `TOKEN`
 * are one secret: an exact match wins, and otherwise the one case-folded match.
 * An id (`csec-…`) is accepted as itself.
 */
async function find(
  client: Client,
  nameOrId: string,
  ws: P.SecretScopeArgs,
  signal: AbortSignal,
): Promise<Secret | undefined> {
  const { secrets } = await client.secrets.list({ ...ws, signal });
  const byId = secrets.find((s) => s.id === nameOrId);
  if (byId) return byId;
  const exact = secrets.find((s) => s.name === nameOrId.trim());
  if (exact) return exact;
  const fold = (v: string) => v.trim().replace(/[A-Z]/g, (c) => c.toLowerCase());
  return secrets.find((s) => fold(s.name) === fold(nameOrId));
}

/** `mandala secrets list [--workspace ID]`. */
export async function secretsList(
  client: Client,
  io: CliIO,
  output: Output,
  workspace: string | undefined,
  signal: AbortSignal,
): Promise<number> {
  const list = await client.secrets.list({ ...scope(workspace), signal });
  if (output.json)
    return output.result({
      secrets: list.secrets.map(shown),
      delivery: list.delivery,
      limits: list.raw.limits,
    });
  if (!list.secrets.length) io.stdout.write('no secrets in this scope\n');
  for (const s of list.secrets) {
    const used = s.lastUsedAt ? `last used ${s.lastUsedAt}` : 'never delivered';
    io.stdout.write(`${s.id}  ${s.name}  ${s.revisionId}  updated ${s.updatedAt}  ${used}\n`);
  }
  if (!list.delivery)
    output.diagnostic('Delivery is off on this platform: secrets can be stored but not bound.');
  return 0;
}

/**
 * `mandala secrets set NAME [--workspace ID]`: create it, or replace its value.
 *
 * Create-or-replace, against the revision it read. A replace whose revision
 * moved under it (somebody else replaced it first) is read again and sent again,
 * a few times — `set` means "make it this value", and the last writer is the one
 * who asked for that. A create that loses a race for the name becomes a replace.
 * A 503 is NOT retried: a write answered 503 may already have happened, so the
 * error says so and the caller decides.
 */
export async function secretsSet(
  client: Client,
  io: CliIO,
  output: Output,
  name: string,
  workspace: string | undefined,
  signal: AbortSignal,
): Promise<number> {
  const trimmed = P.secretName(name);
  const ws = scope(workspace);
  // Checked before the value is asked for, so a mistyped scope is not found
  // out only after someone has typed a secret into a prompt.
  P.secretScopeQuery(ws);
  const value = await readSecretValue(io, trimmed, signal);
  io.secrets?.add(value);
  if (!value)
    throw new CliError('invalid_arguments', 'the value is empty: pipe it on stdin or type it');
  // Validated (size, encoding) before anything is sent; never quoted.
  P.secretCreateBody({ name: trimmed, value, ...ws });

  let created = false;
  let result: Secret | undefined;
  for (let attempt = 1; !result; attempt++) {
    const current = await find(client, trimmed, ws, signal);
    try {
      if (current) {
        result = await client.secrets.replace(
          current.id,
          { value, revisionId: current.revisionId, ...ws },
          { signal },
        );
      } else {
        result = await client.secrets.create({ name: trimmed, value, ...ws }, { signal });
        created = true;
      }
    } catch (error) {
      // A stale revision, or a name somebody else just took: read again.
      if (!(error instanceof ConflictError) || attempt >= REVISION_ATTEMPTS) throw error;
    }
  }
  const stored = result as Secret;
  if (output.json) return output.result({ ...shown(stored), created });
  io.stdout.write(
    `${created ? 'created' : 'replaced'} ${stored.id}  ${stored.name}  ${stored.revisionId}\n`,
  );
  return 0;
}

/** `mandala secrets rm NAME [--workspace ID]`: delete it, by name or id. */
export async function secretsRemove(
  client: Client,
  io: CliIO,
  output: Output,
  nameOrId: string,
  workspace: string | undefined,
  signal: AbortSignal,
): Promise<number> {
  const ws = scope(workspace);
  P.secretScopeQuery(ws);
  let removed: Secret | undefined;
  for (let attempt = 1; !removed; attempt++) {
    const current = await find(client, nameOrId, ws, signal);
    if (!current)
      throw new CliError('not_found', `no secret named ${JSON.stringify(nameOrId)} in this scope`);
    try {
      await client.secrets.delete(
        current.id,
        { revisionId: current.revisionId, ...ws },
        { signal },
      );
      removed = current;
    } catch (error) {
      if (!(error instanceof ConflictError) || attempt >= REVISION_ATTEMPTS) throw error;
    }
  }
  const gone = removed as Secret;
  if (output.json) return output.result({ id: gone.id, name: gone.name, deleted: true });
  io.stdout.write(`deleted ${gone.id}  ${gone.name}\n`);
  return 0;
}
