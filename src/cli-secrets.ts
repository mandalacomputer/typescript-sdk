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
 * The secret a NAME means in one scope, or `undefined`.
 *
 * The platform keeps names unique ignoring ASCII case, so `token` and `TOKEN`
 * are one secret: an exact match wins, and otherwise the one case-folded match.
 * Never an id: a name may legally spell another secret's id, and `set` resolving
 * one as the other would overwrite an unrelated credential.
 */
function byName(secrets: readonly Secret[], name: string): Secret | undefined {
  const exact = secrets.find((s) => s.name === name.trim());
  if (exact) return exact;
  const fold = (v: string) => v.trim().replace(/[A-Z]/g, (c) => c.toLowerCase());
  return secrets.find((s) => fold(s.name) === fold(name));
}

async function scopeRows(
  client: Client,
  ws: P.SecretScopeArgs,
  signal: AbortSignal,
): Promise<Secret[]> {
  return (await client.secrets.list({ ...ws, signal })).secrets;
}

/**
 * The secret a name OR an id means, for the one command that accepts either.
 *
 * A name that spells a different secret's id is ambiguous, and refused: guessing
 * wrong deletes the wrong credential.
 */
function byNameOrId(
  secrets: readonly Secret[],
  key: string,
  unchanged = 'nothing was deleted',
  shownAs = JSON.stringify(key),
): Secret | undefined {
  const named = byName(secrets, key);
  const identified = secrets.find((s) => s.id === key);
  if (named && identified && named.id !== identified.id)
    throw new CliError(
      'ambiguous_secret',
      `${shownAs} is the name of ${named.id} and the id of another secret; ` +
        `${unchanged}: rename one of them first`,
    );
  return named ?? identified;
}

/** A secret id: `csec-` and sixteen hex characters. */
const SECRET_ID = /^csec-[0-9a-f]{16}$/;

/** One `--secret` or `--secret-file` on `computers create`, as typed. */
export type BindingSpec = {
  flag: '--secret' | '--secret-file';
  /** A secret's name or id. */
  key: string;
  /** The variable or file it is published as; absent means the secret's own name. */
  target?: string;
  /**
   * How an error names this binding. Never the whole of `key` once an `=` was
   * typed: see {@link bindingSpecs}.
   */
  label: string;
};

/**
 * The `--secret SECRET[=VAR]` and `--secret-file SECRET[=FILE]` values, split
 * and checked before any request.
 *
 * Split at the LAST `=`, since neither a variable nor a file name can hold one
 * and a secret's name can. Nothing after the FIRST `=` is ever quoted back: the
 * likely mistake is `--secret NAME=<the value itself>`, an error is the last
 * place that should print it, and a value can hold `=` itself (Base64 padding,
 * say), which the last-`=` split would move into the key. So once an `=` was
 * typed, an error names the binding by its flag, its position and the text
 * before the first `=` alone.
 */
export function bindingSpecs(
  envs: readonly string[] = [],
  files: readonly string[] = [],
): BindingSpec[] {
  const split = (flag: BindingSpec['flag'], typed: string, index: number): BindingSpec => {
    const at = typed.lastIndexOf('=');
    const key = (at < 0 ? typed : typed.slice(0, at)).trim();
    const label =
      at < 0
        ? `${flag} ${JSON.stringify(key)}`
        : `${flag} #${index + 1} (${JSON.stringify(`${typed.slice(0, typed.indexOf('=')).trim()}=…`)})`;
    if (!key) throw new CliError('invalid_arguments', `${flag} needs a secret name or id`);
    if (at < 0) return { flag, key, label };
    const target = typed.slice(at + 1);
    const [pattern, rule] =
      flag === '--secret'
        ? [P.SECRET_ENV, 'letters, digits and underscores, not starting with a digit, at most 64']
        : [P.SECRET_FILE, 'lowercase letters, digits, - and _, starting with a letter, at most 48'];
    if (!pattern.test(target))
      throw new CliError(
        'invalid_arguments',
        `${label}: what follows = must be ${rule} characters. ` +
          `It names where the value goes, never the value: store that with mandala secrets set`,
      );
    return { flag, key, target, label };
  };
  return [
    ...envs.map((typed, i) => split('--secret', typed, i)),
    ...files.map((typed, i) => split('--secret-file', typed, i)),
  ];
}

/**
 * The bindings a create sends, each secret found by name or id in the default
 * scope — the account-wide one, or the workspace an API key is confined to.
 *
 * An id that listing does not hold is sent as it is, for a secret in a scope
 * the listing did not cover; the platform refuses one it cannot bind, and the
 * create with it. A name it does not hold is refused here.
 *
 * Two bindings of one secret, or into one variable or file, are refused here
 * too, by label: the SDK's own check would quote a typed target, which may be
 * a value typed after `=` by mistake.
 */
export async function secretBindings(
  client: Client,
  specs: readonly BindingSpec[],
  signal: AbortSignal,
): Promise<P.SecretBindingArgs[]> {
  if (!specs.length) return [];
  const list = await client.secrets.list({ signal });
  if (!list.delivery)
    throw new CliError(
      'unsupported',
      'Delivery is off on this platform: secrets can be stored but not bound; nothing was created',
    );
  const seen = new Map<string, string>();
  const once = (slot: string, label: string, what: string) => {
    const first = seen.get(slot);
    if (first !== undefined)
      throw new CliError(
        'invalid_arguments',
        `${label} binds ${what} ${first} already binds; nothing was created`,
      );
    seen.set(slot, label);
  };
  return specs.map(({ flag, key, target, label }) => {
    const found = byNameOrId(list.secrets, key, 'nothing was created', label);
    if (!found && !SECRET_ID.test(key))
      throw new CliError(
        'not_found',
        `${label}: no secret by that name or id in this scope; nothing was created`,
      );
    const as = target ?? found?.name;
    const env = flag === '--secret';
    if (as === undefined)
      throw new CliError(
        'invalid_arguments',
        `${flag} ${key}: say what to bind it as, ${key}=${env ? 'VAR' : 'FILE'}`,
      );
    if (target === undefined && !(env ? P.SECRET_ENV : P.SECRET_FILE).test(as))
      throw new CliError(
        'invalid_arguments',
        `${flag} ${JSON.stringify(key)}: its name cannot be ${env ? 'a variable' : 'a file'} name as it is; ` +
          `name one: ${flag} ${JSON.stringify(`${key}=${env ? 'VAR' : 'FILE'}`)}`,
      );
    const secretId = found?.id ?? key;
    once(`id:${secretId}`, label, 'the secret');
    once(env ? `env:${as}` : `file:${as}`, label, env ? 'the variable' : 'the file');
    return env ? { secretId, env: as } : { secretId, file: as };
  });
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
    const current = byName(await scopeRows(client, ws, signal), trimmed);
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
    const current = byNameOrId(await scopeRows(client, ws, signal), nameOrId);
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
