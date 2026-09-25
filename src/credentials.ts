import { randomUUID } from 'node:crypto';
import fs, { type Stats } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  type CredentialEnvironment,
  type CredentialOptions,
  type CredentialProfile,
  CredentialsError,
  type CredentialsFile,
  credentialEnvironment,
  credentialError,
  MAX_CREDENTIAL_BYTES,
  parseCredentials,
  type ResolvedCredentials,
  resolveSuppliedCredential,
  selectCredentials,
  selectedProfile,
  validateCredentials,
  validateProfileName,
} from './credentials-browser.js';

export * from './credentials-browser.js';

const same = (a: Stats, b: Stats): boolean => a.dev === b.dev && a.ino === b.ino;
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
function supported(): void {
  if (
    process.platform === 'win32' ||
    typeof process.getuid !== 'function' ||
    !fs.constants.O_NOFOLLOW
  )
    credentialError('unsupported_file_protection');
}
function protection(info: Stats, directory: boolean): void {
  if (
    info.uid !== process.getuid!() ||
    (info.mode & 0o7777) !== (directory ? 0o700 : 0o600) ||
    (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)
  )
    credentialError(directory ? 'unsafe_directory' : 'unsafe_file');
}
function size(info: Stats): void {
  if (info.size > MAX_CREDENTIAL_BYTES) credentialError('file_too_large');
}
type Directory = { name: string; fd: number; info: Stats; deadline: number };
function checkDirectory(dir: Directory, readCtimeNs?: bigint): void {
  if (performance.now() >= dir.deadline) credentialError('read_timeout');
  const descriptor = fs.fstatSync(dir.fd);
  const named = fs.lstatSync(dir.name);
  protection(descriptor, true);
  protection(named, true);
  if (!same(dir.info, descriptor) || !same(dir.info, named)) credentialError('unsafe_directory');
  if (readCtimeNs !== undefined && fs.fstatSync(dir.fd, { bigint: true }).ctimeNs !== readCtimeNs)
    credentialError('unsafe_directory');
}
function openDirectory(create = false): Directory | undefined {
  supported();
  const deadline = performance.now() + 5000;
  let name: string;
  try {
    const home = os.homedir();
    if (!path.isAbsolute(home)) credentialError('home_unavailable');
    name = path.join(home, '.mandala');
  } catch {
    credentialError('home_unavailable');
  }
  let fd: number | undefined;
  try {
    if (create) {
      try {
        fs.mkdirSync(name, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    const info = fs.lstatSync(name);
    protection(info, true);
    fd = fs.openSync(
      name,
      fs.constants.O_RDONLY |
        fs.constants.O_NOFOLLOW |
        fs.constants.O_DIRECTORY |
        fs.constants.O_NONBLOCK,
    );
    const directory = { name, fd, info, deadline };
    checkDirectory(directory);
    return directory;
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    if (error instanceof CredentialsError) throw error;
    if (!create && missing(error)) return undefined;
    credentialError('unsafe_directory');
  }
}

/** Verify both the opened object and its named path, before and after bounded reads. */
function readDirectory(dir: Directory): CredentialsFile | undefined {
  let fd: number | undefined;
  const name = path.join(dir.name, 'credentials.json');
  try {
    // Node has no atomic directory-relative open. Pin the directory's change
    // timestamp for this read as well as its identity to detect rename/restore
    // substitutions around the named file operations. Bigint retains the
    // filesystem's native timestamp precision. Each writer read starts after
    // its own lock or temporary-file creation, never across those mutations.
    const readCtimeNs = fs.fstatSync(dir.fd, { bigint: true }).ctimeNs;
    if (typeof readCtimeNs !== 'bigint') credentialError('unsupported_file_protection');
    checkDirectory(dir, readCtimeNs);
    let before: Stats;
    try {
      before = fs.lstatSync(name);
    } catch (error) {
      if (missing(error)) {
        checkDirectory(dir, readCtimeNs);
        return undefined;
      }
      throw error;
    }
    protection(before, false);
    size(before);
    checkDirectory(dir, readCtimeNs);
    fd = fs.openSync(
      name,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    const opened = fs.fstatSync(fd);
    protection(opened, false);
    size(opened);
    if (!same(before, opened)) credentialError('unsafe_file');
    checkDirectory(dir, readCtimeNs);
    const bytes = new Uint8Array(MAX_CREDENTIAL_BYTES + 1);
    let count = 0;
    while (count <= MAX_CREDENTIAL_BYTES) {
      checkDirectory(dir, readCtimeNs);
      const read = fs.readSync(fd, bytes, count, bytes.length - count, count);
      count += read;
      if (count > MAX_CREDENTIAL_BYTES) credentialError('file_too_large');
      if (!read) break;
    }
    const after = fs.fstatSync(fd);
    protection(after, false);
    size(after);
    const named = fs.lstatSync(name);
    protection(named, false);
    size(named);
    if (
      !same(before, after) ||
      !same(before, named) ||
      opened.size !== after.size ||
      opened.mtimeMs !== after.mtimeMs ||
      opened.ctimeMs !== after.ctimeMs
    )
      credentialError('unsafe_file');
    checkDirectory(dir, readCtimeNs);
    return parseCredentials(bytes.subarray(0, count));
  } catch (error) {
    if (error instanceof CredentialsError) throw error;
    credentialError('unsafe_file');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
export function readCredentials(): CredentialsFile | undefined {
  const dir = openDirectory();
  if (!dir) return undefined;
  try {
    return readDirectory(dir);
  } finally {
    fs.closeSync(dir.fd);
  }
}
export function resolveCredentials(
  options: CredentialOptions = {},
  env: CredentialEnvironment = credentialEnvironment(),
): ResolvedCredentials {
  const key = resolveSuppliedCredential(options, env);
  if (key) return key;
  const profile = selectedProfile(options, env);
  const file = readCredentials();
  if (!file) credentialError('missing_credentials');
  return selectCredentials(file, profile, options, env);
}

export type SavedCredentials = { profile: string; path: string; saved: true };
export class CredentialSaveError extends CredentialsError {
  constructor(readonly committed: boolean) {
    super(
      'credential_save_failed',
      committed
        ? 'Credentials were saved, but durable persistence could not be confirmed. Check Settings and revoke the device-named key before a fresh login if the file is unusable.'
        : 'Could not save credentials after authorization. Revoke the device-named key in Settings before a fresh explicit login.',
    );
  }
}
const pause = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const done = () => {
      signal?.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(done, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(signal?.reason);
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
function removeOwned(name: string, info: Stats): void {
  try {
    if (same(fs.lstatSync(name), info)) fs.unlinkSync(name);
  } catch {
    /* Never remove a replacement or hide the persistence result during cleanup. */
  }
}

/** Lock only the final merge. A timeout never steals another attempt's lock. */
export async function saveCredentials(
  entry: CredentialProfile,
  profile?: string,
  options: { signal?: AbortSignal; lockTimeoutMs?: number } = {},
): Promise<SavedCredentials> {
  if (profile !== undefined) validateProfileName(profile);
  return rewriteLocked(
    options,
    (old, file) => {
      const name = profile ?? old?.default_profile ?? 'default';
      const profiles: Record<string, CredentialProfile> = Object.assign(
        Object.create(null),
        old?.profiles,
      );
      profiles[name] = entry;
      return {
        next: { version: 1, default_profile: old?.default_profile ?? name, profiles },
        result: { profile: name, path: file, saved: true as const },
      };
    },
    (committed) => new CredentialSaveError(committed),
  );
}

/** What {@link removeCredentials} did. */
export type RemovedCredentials = {
  /** The profile asked for: the named one, or the default. */
  profile: string;
  /** False when the store held no such profile; nothing was written then. */
  removed: boolean;
  path: string;
  /** The removed profile's key id, which still authenticates until it is revoked. */
  keyId?: string;
  /**
   * The default profile afterwards: unchanged, or — when the default itself was
   * removed and others remain — the first of them by name. `null` when no
   * profile remains, and the store file is gone.
   */
  defaultProfile: string | null;
};

/** The failure of a removal, told apart from a login's save: there is no key to revoke here. */
export class CredentialRemoveError extends CredentialsError {
  constructor(readonly committed: boolean) {
    super(
      'credential_remove_failed',
      committed
        ? 'The profile was removed, but durable persistence could not be confirmed. Check ~/.mandala/credentials.json.'
        : 'Could not remove the profile; the credentials file was not changed.',
    );
  }
}

/**
 * Remove one profile from the store — `mandala logout` — under the same lock
 * and checks as a save.
 *
 * The key stays valid on the platform: this forgets it on this machine and
 * does nothing else. A default that is removed while other profiles remain is
 * replaced by the first of them by name, as the store has to name one; the
 * last profile removed takes the file with it, because the store's own schema
 * has no spelling for an empty one.
 */
export async function removeCredentials(
  profile?: string,
  options: { signal?: AbortSignal; lockTimeoutMs?: number } = {},
): Promise<RemovedCredentials> {
  if (profile !== undefined) validateProfileName(profile);
  return rewriteLocked<RemovedCredentials>(
    { ...options, create: false },
    (old, file) => {
      const name = profile ?? old?.default_profile ?? 'default';
      if (!old || !Object.hasOwn(old.profiles, name)) {
        return {
          result: {
            profile: name,
            removed: false,
            path: file,
            defaultProfile: old?.default_profile ?? null,
          },
        };
      }
      const keyId = old.profiles[name]!.key_id;
      const profiles: Record<string, CredentialProfile> = Object.assign(
        Object.create(null),
        old.profiles,
      );
      delete profiles[name];
      const left = Object.keys(profiles).sort();
      if (!left.length) {
        return {
          next: null,
          result: { profile: name, removed: true, path: file, keyId, defaultProfile: null },
        };
      }
      const defaultProfile = old.default_profile === name ? left[0]! : old.default_profile;
      return {
        next: { version: 1, default_profile: defaultProfile, profiles },
        result: { profile: name, removed: true, path: file, keyId, defaultProfile },
      };
    },
    (committed) => new CredentialRemoveError(committed),
  );
}

/**
 * The store's one writer: take the lock, read, compute the next store, and
 * replace the file with it (or remove it, for `next: null`), checking at every
 * step that nothing moved underneath. `next` absent writes nothing. With
 * `create: false` a missing ~/.mandala is left missing: the computation sees no
 * store, and must then write nothing.
 */
async function rewriteLocked<T>(
  options: { signal?: AbortSignal; lockTimeoutMs?: number; create?: boolean },
  compute: (
    old: CredentialsFile | undefined,
    file: string,
  ) => { next?: CredentialsFile | null; result: T },
  failure: (committed: boolean) => CredentialsError,
): Promise<T> {
  const lockTimeoutMs = options.lockTimeoutMs ?? 5000;
  if (!Number.isFinite(lockTimeoutMs) || lockTimeoutMs < 0 || lockTimeoutMs > 30_000)
    credentialError('invalid_lock_timeout');
  const { signal } = options;
  signal?.throwIfAborted();
  const create = options.create ?? true;
  const dir = openDirectory(create);
  if (!dir) {
    // No ~/.mandala: there is no store to change, so the caller's answer is
    // computed from nothing, and nothing is created on the way to giving it.
    const { next, result } = compute(
      undefined,
      path.join(os.homedir(), '.mandala', 'credentials.json'),
    );
    if (next === undefined) return result;
    throw failure(false);
  }
  const lock = path.join(dir.name, '.credentials.lock');
  const store = path.join(dir.name, 'credentials.json');
  let lockFd: number | undefined;
  let lockInfo: Stats | undefined;
  let temp: string | undefined;
  let tempInfo: Stats | undefined;
  let tempFd: number | undefined;
  let committed = false;
  try {
    const deadline = performance.now() + lockTimeoutMs;
    let attempted = false;
    for (;;) {
      signal?.throwIfAborted();
      if (attempted && performance.now() >= deadline) credentialError('writer_lock_timeout');
      attempted = true;
      // The lock acquisition has its own explicit bound; each store read is separately bounded.
      dir.deadline = performance.now() + 5000;
      checkDirectory(dir);
      try {
        lockFd = fs.openSync(
          lock,
          fs.constants.O_WRONLY |
            fs.constants.O_CREAT |
            fs.constants.O_EXCL |
            fs.constants.O_NOFOLLOW,
          0o600,
        );
        lockInfo = fs.fstatSync(lockFd);
        fs.fchmodSync(lockFd, 0o600);
        lockInfo = fs.fstatSync(lockFd);
        protection(lockInfo, false);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        let released = false;
        try {
          protection(fs.lstatSync(lock), false);
        } catch (inspectionError) {
          if (!missing(inspectionError)) throw inspectionError;
          // The current owner can finish between our exclusive open and lstat.
          // Retry creation; disappearance never grants permission to remove a lock.
          released = true;
        }
        if (performance.now() >= deadline) credentialError('writer_lock_timeout');
        if (released) continue;
        await pause(Math.min(50, Math.max(1, deadline - performance.now())), signal);
      }
    }
    const old = readDirectory(dir);
    const { next, result } = compute(old, store);
    if (next === undefined) return result;
    let bytes: Buffer | undefined;
    if (next !== null) {
      validateCredentials(next);
      bytes = Buffer.from(`${JSON.stringify(next, null, 2)}\n`);
      if (bytes.length > MAX_CREDENTIAL_BYTES) credentialError('file_too_large');
      signal?.throwIfAborted();
      checkDirectory(dir);
      temp = path.join(dir.name, `.credentials-${randomUUID()}.tmp`);
      tempFd = fs.openSync(
        temp,
        fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          fs.constants.O_NOFOLLOW,
        0o600,
      );
      tempInfo = fs.fstatSync(tempFd);
      fs.fchmodSync(tempFd, 0o600);
      tempInfo = fs.fstatSync(tempFd);
      protection(tempInfo, false);
      fs.writeFileSync(tempFd, bytes);
      fs.fsyncSync(tempFd);
    }
    signal?.throwIfAborted();
    checkDirectory(dir);
    if ((temp && !same(fs.lstatSync(temp), tempInfo!)) || !same(fs.lstatSync(lock), lockInfo!))
      credentialError('unsafe_file');
    // The old store was validated under the lock. Verify it still names the same complete state.
    const latest = readDirectory(dir);
    if (JSON.stringify(latest) !== JSON.stringify(old)) credentialError('unsafe_file');
    signal?.throwIfAborted();
    if (temp) fs.renameSync(temp, store);
    else fs.unlinkSync(store);
    committed = true;
    // After rename cancellation reports saved state; it must never remove the new store.
    checkDirectory(dir);
    try {
      fs.fsyncSync(dir.fd);
    } catch (error) {
      if (!['EINVAL', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
    return result;
  } catch (error) {
    if (!committed && signal?.aborted) throw signal.reason;
    if (error instanceof CredentialsError && !committed) throw error;
    throw failure(committed);
  } finally {
    for (const fd of [tempFd, lockFd, dir.fd]) {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          /* Cleanup must not hide a committed save or its failure. */
        }
      }
    }
    if (temp && tempInfo && !committed) removeOwned(temp, tempInfo);
    if (lockInfo) removeOwned(lock, lockInfo);
  }
}
