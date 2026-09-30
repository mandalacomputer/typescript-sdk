/**
 * `~/.mandala/defaults.json`: the default workspace `mandala workspaces use`
 * saves for a profile (OPL-5499).
 *
 * It is a file of its own, beside credentials.json, because every released
 * reader of credentials.json has a closed profile schema: a new field there,
 * or a new file version, would lock older installs out of every profile.
 * Older clients never open this file. It is read and replaced with the same
 * checks as credentials.json (a private 0700 directory, a 0600 regular file
 * owned by this user, its own sibling lock, a flushed temporary file renamed
 * into place), under `.defaults.lock`.
 *
 * ```json
 * {"version":1,"profiles":{"work":{"account_id":"acc-…","workspace":{"id":"wsp-…","name":"…"}}}}
 * ```
 *
 * `account_id` is the profile's account when the default was saved: a profile
 * logged in again to another account does not carry the default over.
 */

import {
  CredentialsError,
  credentialError,
  type LocalStore,
  MAX_CREDENTIAL_BYTES,
  readLocalStore,
  rewriteLocalStore,
  validateProfileName,
} from './credentials.js';

export type WorkspaceDefault = {
  account_id: string;
  workspace: { id: string; name: string };
};
export type DefaultsFile = { version: 1; profiles: Record<string, WorkspaceDefault> };

/** The file's place, as the CLI's sentences name it. */
export const DEFAULTS_PATH = '~/.mandala/defaults.json';

const REASONS: Record<string, string> = {
  invalid_utf8: 'it is not UTF-8 text',
  invalid_json: 'it is not valid JSON',
  invalid_schema: 'its contents are not in the expected form',
  invalid_profile: 'it names a profile that is not a valid profile name',
  unsupported_version: 'it is a version this CLI does not read',
  too_many_profiles: 'it holds more than 100 profiles',
  file_too_large: 'it is larger than 64 KiB',
  unsafe_file: 'it must be a regular file with mode 0600, owned by you',
  unsafe_directory: '~/.mandala must be a directory with mode 0700, owned by you',
  home_unavailable: 'the home directory could not be found',
  unsupported_file_protection: 'this platform cannot protect it',
  read_timeout: 'reading it timed out',
  writer_lock_timeout: 'another process held its lock',
};

/** The failures of a file that is there but cannot be read: never overwritten. */
const UNREADABLE = new Set([
  'invalid_utf8',
  'invalid_json',
  'invalid_schema',
  'invalid_profile',
  'unsupported_version',
  'too_many_profiles',
  'file_too_large',
  'unsafe_file',
]);

/** A defaults.json that cannot be used, or changed; `code` is the failed stage. */
export class DefaultsError extends CredentialsError {
  constructor(
    code: string,
    /** Why, in a few words, for "ignoring ~/.mandala/defaults.json: <reason>". */
    readonly reason: string,
    message = `${DEFAULTS_PATH} cannot be used: ${reason}`,
  ) {
    super(code, message);
  }
}

/** The same failure, told as a {@link DefaultsError}. */
function asDefaultsError(error: unknown): unknown {
  if (!(error instanceof CredentialsError) || error instanceof DefaultsError) return error;
  return new DefaultsError(error.code, REASONS[error.code] ?? error.code);
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
function closed(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (
    !record(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    credentialError('invalid_schema');
}
function text(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.length || /[\ud800-\udfff]/u.test(value))
    credentialError('invalid_schema');
}

/** Check a parsed defaults.json; a {@link CredentialsError} names what is wrong. */
export function validateDefaults(value: unknown): asserts value is DefaultsFile {
  if (!record(value)) credentialError('invalid_schema');
  if (typeof value.version !== 'number' || !Number.isInteger(value.version))
    credentialError('invalid_schema');
  if (value.version !== 1) credentialError('unsupported_version');
  closed(value, ['version', 'profiles']);
  if (!record(value.profiles)) credentialError('invalid_schema');
  if (Object.keys(value.profiles).length > 100) credentialError('too_many_profiles');
  for (const [name, entry] of Object.entries(value.profiles)) {
    validateProfileName(name);
    closed(entry, ['account_id', 'workspace']);
    text(entry.account_id);
    closed(entry.workspace, ['id', 'name']);
    text(entry.workspace.id);
    text(entry.workspace.name);
  }
}

/** Decode and check defaults.json's bytes. */
export function parseDefaults(bytes: Uint8Array): DefaultsFile {
  if (bytes.length > MAX_CREDENTIAL_BYTES) credentialError('file_too_large');
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    credentialError('invalid_utf8');
  }
  let data: unknown;
  try {
    data = JSON.parse(decoded);
  } catch {
    credentialError('invalid_json');
  }
  validateDefaults(data);
  return data;
}

const DEFAULTS_STORE: LocalStore<DefaultsFile> = {
  file: 'defaults.json',
  lock: '.defaults.lock',
  tempPrefix: '.defaults-',
  parse: parseDefaults,
  encode: (next) => {
    validateDefaults(next);
    const bytes = Buffer.from(`${JSON.stringify(next, null, 2)}\n`);
    if (bytes.length > MAX_CREDENTIAL_BYTES) credentialError('file_too_large');
    return bytes;
  },
};

/**
 * Read defaults.json: undefined when it (or ~/.mandala) is missing. One that
 * cannot be used throws a {@link DefaultsError}; a command that only reads it
 * reports that and goes on without a default.
 */
export function readDefaults(): DefaultsFile | undefined {
  try {
    return readLocalStore(DEFAULTS_STORE);
  } catch (error) {
    throw asDefaultsError(error);
  }
}

/**
 * The default a profile's commands use: its entry, when it was saved for the
 * account the profile is logged in to now. `ignored` is an entry saved for
 * another account, which is not used.
 */
export function workspaceDefault(
  file: DefaultsFile | undefined,
  profile: string,
  accountId: string,
): { entry?: WorkspaceDefault; ignored?: WorkspaceDefault } {
  if (!file || !Object.hasOwn(file.profiles, profile)) return {};
  const entry = file.profiles[profile]!;
  return entry.account_id === accountId ? { entry } : { ignored: entry };
}

/** A change to defaults.json that did not happen, or was not confirmed durable. */
class DefaultsSaveError extends DefaultsError {
  constructor(readonly committed: boolean) {
    super(
      'defaults_save_failed',
      committed ? 'the change was made, but not confirmed durable' : 'it could not be changed',
      committed
        ? `${DEFAULTS_PATH} was changed, but durable persistence could not be confirmed.`
        : `Could not change ${DEFAULTS_PATH}; it was not changed.`,
    );
  }
}

/**
 * Run one change to defaults.json under its lock. A file that is there but
 * cannot be read is never overwritten: the sentence says to delete or fix it.
 */
async function rewriteDefaults<T>(
  create: boolean,
  compute: (
    old: DefaultsFile | undefined,
    file: string,
  ) => { next?: DefaultsFile | null; result: T },
  options: { signal?: AbortSignal; lockTimeoutMs?: number },
): Promise<T> {
  try {
    return await rewriteLocalStore(DEFAULTS_STORE, { ...options, create }, compute, (committed) => {
      return new DefaultsSaveError(committed);
    });
  } catch (error) {
    if (!(error instanceof CredentialsError) || error instanceof DefaultsError) throw error;
    const reason = REASONS[error.code] ?? error.code;
    throw new DefaultsError(
      error.code,
      reason,
      UNREADABLE.has(error.code)
        ? `${DEFAULTS_PATH} cannot be read (${reason}), so it was not changed. Delete or fix it, then run the command again.`
        : `${DEFAULTS_PATH} was not changed: ${reason}.`,
    );
  }
}

/** Save `entry` as `profile`'s default, keeping every other profile's. */
export async function saveWorkspaceDefault(
  profile: string,
  entry: WorkspaceDefault,
  options: { signal?: AbortSignal; lockTimeoutMs?: number } = {},
): Promise<void> {
  validateProfileName(profile);
  await rewriteDefaults(
    true,
    (old) => {
      const profiles: Record<string, WorkspaceDefault> = Object.assign(
        Object.create(null),
        old?.profiles,
      );
      profiles[profile] = {
        account_id: entry.account_id,
        workspace: { id: entry.workspace.id, name: entry.workspace.name },
      };
      return { next: { version: 1, profiles }, result: undefined };
    },
    options,
  );
}

/**
 * Remove `profile`'s default; false when it had none, and nothing was written.
 * The last one removed takes the file with it.
 */
export async function removeWorkspaceDefault(
  profile: string,
  options: { signal?: AbortSignal; lockTimeoutMs?: number } = {},
): Promise<boolean> {
  validateProfileName(profile);
  return rewriteDefaults(
    false,
    (old) => {
      if (!old || !Object.hasOwn(old.profiles, profile)) return { result: false };
      const profiles: Record<string, WorkspaceDefault> = Object.assign(
        Object.create(null),
        old.profiles,
      );
      delete profiles[profile];
      return {
        next: Object.keys(profiles).length ? { version: 1, profiles } : null,
        result: true,
      };
    },
    options,
  );
}
