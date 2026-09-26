/**
 * `mandala whoami`, `mandala api-keys list | create | revoke` and
 * `mandala logout` (platform OPL-5053).
 *
 * The three `api-keys` verbs need the calling key's "Manage keys" permission,
 * which only a dashboard session turns on. Without it the platform answers 403
 * with a sentence that says exactly that, and it is printed as it came: it
 * names the page and the checkbox, which nothing here could say better.
 *
 * `logout` touches nothing but this machine: it forgets a saved profile. The key
 * it held stays valid until it is revoked, and the output says so.
 */

import { CliError } from './cli-options.js';
import { type Output, terminalSafe } from './cli-output.js';
import type { CliIO } from './cli-runtime.js';
import { removeCredentials, selectedProfile } from './credentials.js';
import type { ApiKey, Client, Whoami } from './index.js';

const scopeText = (k: ApiKey): string =>
  k.workspaceId === null
    ? 'account-wide'
    : `workspace ${k.workspaceName ?? '?'} (${k.workspaceId})`;

/**
 * One key in a line: what the Credentials page shows for it. Escaped whole:
 * a key's name, and its workspace's, are whatever someone typed.
 */
const keyLine = (k: ApiKey): string =>
  terminalSafe(
    [
      k.id,
      k.name ?? '(unnamed)',
      k.prefix,
      scopeText(k),
      k.manageKeys ? 'manages keys' : '-',
      k.lastUsedAt ? `last used ${k.lastUsedAt}` : 'never used',
    ].join('  '),
  );

export async function apiKeysList(
  client: Client,
  io: CliIO,
  output: Output,
  signal: AbortSignal,
): Promise<number> {
  const keys = await client.apiKeys.list({ signal });
  // The platform's own projection, which never carries a raw key.
  if (output.json) return output.result(keys.map((k) => k.raw));
  if (!keys.length) io.stdout.write('no API keys this key can reach\n');
  for (const k of keys) io.stdout.write(`${keyLine(k)}\n`);
  return 0;
}

/**
 * `mandala api-keys create [--name NAME] [--workspace ID]`.
 *
 * The key is shown once. For a person it is the ONLY thing on stdout, so
 * `KEY=$(mandala api-keys create --name ci)` captures it and nothing else; what
 * it is and the warning go to stderr. `--json` answers the platform's object,
 * key included as `raw`.
 */
export async function apiKeysCreate(
  client: Client,
  io: CliIO,
  output: Output,
  args: { name?: string; workspace?: string },
  signal: AbortSignal,
): Promise<number> {
  const created = await client.apiKeys.create(
    {
      ...(args.name === undefined ? {} : { name: args.name }),
      ...(args.workspace === undefined ? {} : { workspaceId: args.workspace }),
    },
    { signal },
  );
  output.diagnostic(
    `Created ${created.id} (${created.name ?? 'unnamed'}, ${scopeText(created)}). ` +
      'Store the key now: it is shown once and cannot be read again.',
  );
  if (output.json) return output.result(created.raw);
  io.stdout.write(`${created.key}\n`);
  return 0;
}

export async function apiKeysRevoke(
  client: Client,
  output: Output,
  id: string,
  signal: AbortSignal,
): Promise<number> {
  await client.apiKeys.revoke(id, { signal });
  return output.result({ id, revoked: true });
}

function whoamiText(w: Whoami): string {
  const k = w.key;
  return (
    [
      `${w.user.name ? `${w.user.name} ` : ''}<${w.user.email}> (${w.user.id})`,
      `Account: ${w.account.name ?? '(unnamed)'} (${w.account.id}), plan ${w.account.plan}, ${w.account.status}`,
      `Role: ${w.role}`,
      `Scope: ${w.workspace ? `workspace ${w.workspace.name} (${w.workspace.id})` : 'the whole account'}`,
      k
        ? `Key: ${k.name ?? '(unnamed)'} (${k.id}, ${k.prefix}); ${k.manageKeys ? 'can' : 'cannot'} manage API keys`
        : 'Key: not reported',
    ]
      // Each line escaped on its own: a name holding a newline must not start one.
      .map((line) => terminalSafe(line))
      .join('\n')
  );
}

export async function whoamiCommand(
  client: Client,
  io: CliIO,
  output: Output,
  signal: AbortSignal,
): Promise<number> {
  const who = await client.account.whoami({ signal });
  if (output.json) return output.result(who.raw);
  io.stdout.write(`${whoamiText(who)}\n`);
  if (who.account.status === 'suspended')
    output.diagnostic('mandala: this account is suspended; other commands will be refused.');
  return 0;
}

/**
 * `mandala logout [--profile NAME]`: forget one saved profile — the one
 * `--profile` or `MANDALA_PROFILE` names, else the default.
 *
 * A profile that is not there is an error rather than a quiet success: the
 * person believes they are signed in somewhere, and "nothing to do" would let
 * them keep believing the wrong thing about which profile that was.
 */
export async function logoutCommand(
  profile: string | undefined,
  io: CliIO,
  output: Output,
  signal: AbortSignal,
): Promise<number> {
  const removed = await removeCredentials(selectedProfile({ profile }, io.env), { signal });
  if (!removed.removed)
    throw new CliError(
      'not_logged_in',
      `No saved profile named ${removed.profile}; nothing was removed.` +
        (removed.defaultProfile ? ` The default profile is ${removed.defaultProfile}.` : ''),
    );
  output.diagnostic(`Removed profile ${removed.profile} from ${removed.path}.`);
  output.diagnostic(
    `Its key ${removed.keyId} still works until it is revoked: revoke it under Credentials in the dashboard, ` +
      `or run mandala api-keys revoke ${removed.keyId} with a key that can manage keys.`,
  );
  if (removed.defaultProfile !== null && removed.defaultProfile !== removed.profile)
    output.diagnostic(`The default profile is ${removed.defaultProfile}.`);
  if (io.env.MANDALA_API_KEY?.trim())
    output.diagnostic(
      'MANDALA_API_KEY is set in this environment, and it still authenticates every command.',
    );
  if (!output.json) return 0;
  return output.result({
    profile: removed.profile,
    removed: true,
    path: removed.path,
    key_id: removed.keyId,
    default_profile: removed.defaultProfile,
  });
}
