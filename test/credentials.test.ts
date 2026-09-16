import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CredentialsError,
  type CredentialsFile,
  canonicalBase,
  readCredentials,
  resolveCredentials,
  saveCredentials,
} from '../src/credentials.js';
import { AuthenticationError, Client } from '../src/index.js';

const fixtureBytes = fs.readFileSync(new URL('./fixtures/credentials-v1.json', import.meta.url));
const corpus = JSON.parse(fixtureBytes.toString());
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
let home: string;
let directory: string;
let file: string;
beforeEach(() => {
  home = fs.mkdtempSync(join(os.tmpdir(), 'mandala-credentials-'));
  directory = join(home, '.mandala');
  file = join(directory, 'credentials.json');
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  for (const name of ['MANDALA_API_KEY', 'MANDALA_BASE_URL', 'MANDALA_PROFILE'])
    vi.stubEnv(name, '');
});
afterEach(() => {
  Object.defineProperty(process, 'platform', platformDescriptor);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  // Permission-refusal cases leave the fixture unwritable. Restore only an
  // owned real directory through its descriptor, never a replacement symlink.
  let fd: number | undefined;
  try {
    fd = fs.openSync(
      directory,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
    );
    const info = fs.fstatSync(fd);
    if (info.isDirectory() && info.uid === process.getuid?.()) fs.fchmodSync(fd, 0o700);
  } catch (error) {
    if (!['ENOENT', 'ELOOP', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? ''))
      throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  fs.rmSync(home, { recursive: true, force: true });
});
function put(value: unknown = corpus.base_document): void {
  fs.mkdirSync(directory, { mode: 0o700, recursive: true });
  fs.writeFileSync(file, value instanceof Uint8Array ? value : JSON.stringify(value), {
    mode: 0o600,
  });
}
function patched(recipe: any): unknown {
  const value = structuredClone(corpus.base_document);
  for (const patch of recipe.patch ?? []) {
    const keys = patch.path
      .slice(1)
      .split('/')
      .map((key: string) => key.replace(/~1/g, '/').replace(/~0/g, '~'));
    let parent = value;
    for (const key of keys.slice(0, -1)) {
      expect(Object.hasOwn(parent, key)).toBe(true);
      parent = parent[key];
    }
    const name = keys.at(-1)!;
    if (patch.op === 'remove') delete parent[name];
    else
      Object.defineProperty(parent, name, {
        value: patch.value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
  }
  return value;
}
function check(expected: any, action: () => ReturnType<typeof resolveCredentials>): void {
  if (expected.outcome === 'credential') {
    const result = action();
    expect({
      key: result.apiKey,
      base_url: result.baseUrl,
      source: result.source,
      profile: result.profile,
    }).toEqual({
      key: expected.key,
      base_url: expected.base_url,
      source: expected.source,
      profile: expected.profile,
    });
  } else {
    let error: unknown;
    try {
      action();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CredentialsError);
    expect((error as CredentialsError).code).toBe(expected.rule);
    for (const secret of Object.values(corpus.synthetic_keys) as string[])
      expect(String(error)).not.toContain(secret);
  }
}
describe('shared credential corpus', () => {
  it('preserves the byte-identical V1 corpus', () => {
    expect(createHash('sha256').update(fixtureBytes).digest('hex')).toBe(
      '6af4cb6dbc8479602c6c7e637772593cb1f27a638d1e1c1bef0f4475223da076',
    );
  });
  for (const vector of corpus.resolution_cases)
    it(vector.id, () => {
      const input = vector.input;
      if (input.file === 'malformed-json') put(Buffer.from('{'));
      else if (input.file === 'symlink-file') {
        put();
        fs.renameSync(file, `${file}.original`);
        fs.symlinkSync(`${file}.original`, file);
      } else if (input.file !== 'missing')
        put(typeof input.file === 'object' ? patched(input.file) : corpus.base_document);
      if (input.platform)
        Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' });
      const lookup = vi.spyOn(os, 'homedir');
      lookup.mockClear();
      if (input.home_discovery)
        lookup.mockImplementation(() => {
          throw new Error('home must not be discovered');
        });
      const lstat = vi.spyOn(fs, 'lstatSync');
      const open = vi.spyOn(fs, 'openSync');
      const read = vi.spyOn(fs, 'readSync');
      const parse = vi.spyOn(JSON, 'parse');
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);
      const options = input.options ?? {};
      check(vector.expected, () =>
        resolveCredentials(
          { apiKey: options.api_key, baseUrl: options.base_url, profile: options.profile },
          input.env ?? {},
        ),
      );
      if (vector.expected.credential_file_io === 'zero') {
        for (const spy of [lookup, lstat, open, read, parse]) expect(spy).not.toHaveBeenCalled();
      } else expect(lookup).toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });
  for (const vector of corpus.schema_cases)
    it(vector.id, () => {
      put(patched(vector.file));
      check(vector.expected, () => resolveCredentials({}, {}));
    });
  for (const vector of corpus.payload_cases)
    it(vector.id, () => {
      let bytes: Buffer;
      if (vector.bytes_hex !== undefined) bytes = Buffer.from(vector.bytes_hex, 'hex');
      else if (vector.bytes_utf8 !== undefined) bytes = Buffer.from(vector.bytes_utf8, 'utf8');
      else if (vector.recipe.profile_count) {
        const recipe = vector.recipe;
        const profiles = Object.fromEntries(
          Array.from({ length: recipe.profile_count }, (_, i) => [
            `p${String(i).padStart(3, '0')}`,
            recipe.profile_template,
          ]),
        );
        bytes = Buffer.from(
          JSON.stringify({ version: 1, default_profile: recipe.default_profile, profiles }),
        );
      } else {
        const text = Buffer.from(JSON.stringify(corpus.base_document));
        bytes = Buffer.concat([
          text,
          Buffer.alloc(vector.recipe.pad_json_trailing_ascii_spaces_to_bytes - text.length, ' '),
        ]);
      }
      put(bytes);
      check(vector.expected, () => resolveCredentials({}, {}));
    });
  for (const vector of corpus.canonical_base_cases)
    it(vector.id, async () => {
      if (vector.expected.outcome === 'local_error') {
        expect(() => canonicalBase(vector.input)).toThrowError(
          expect.objectContaining({ code: vector.expected.rule }),
        );
        return;
      }
      const base = canonicalBase(vector.input);
      expect(base).toBe(vector.expected.value);
      expect(canonicalBase(base)).toBe(base);
      const doc = structuredClone(corpus.base_document);
      doc.profiles.default.base_url = base;
      put(doc);
      const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json([]));
      await new Client({ fetch }).computers.list();
      expect(String(fetch.mock.calls[0]?.[0])).toBe(`${base}/computers`);
    });
  it('native option presence: null is supplied and undefined is absent', () => {
    put();
    expect(() => resolveCredentials({ apiKey: null as never }, {})).toThrowError(
      expect.objectContaining({ code: 'invalid_explicit_key' }),
    );
    expect(resolveCredentials({ apiKey: undefined }, {}).source).toBe('file');
    expect(() => resolveCredentials({ profile: null as never }, {})).toThrowError(
      expect.objectContaining({ code: 'invalid_profile' }),
    );
    expect(() => resolveCredentials({ baseUrl: null as never }, {})).toThrowError(
      expect.objectContaining({ code: 'invalid_base_url' }),
    );
  });
});

describe('native credential objects', () => {
  it('F14 directory restored around every named file operation cannot select a replacement', () => {
    put();
    const replacement = join(home, '.replacement');
    const parked = join(home, '.parked-original');
    fs.mkdirSync(replacement, { mode: 0o700 });
    const other = structuredClone(corpus.base_document);
    other.default_profile = 'Work';
    fs.writeFileSync(join(replacement, 'credentials.json'), JSON.stringify(other), { mode: 0o600 });
    const lstat = fs.lstatSync;
    const open = fs.openSync;
    const before = lstat(directory, { bigint: true });
    let substitutions = 0;
    const whileReplaced = <T>(operation: () => T): T => {
      substitutions++;
      fs.renameSync(directory, parked);
      fs.renameSync(replacement, directory);
      try {
        return operation();
      } finally {
        fs.renameSync(directory, replacement);
        fs.renameSync(parked, directory);
      }
    };
    vi.spyOn(fs, 'lstatSync').mockImplementation(((name: fs.PathLike, options?: any) =>
      name === file
        ? whileReplaced(() => lstat(name, options))
        : lstat(name, options)) as typeof fs.lstatSync);
    vi.spyOn(fs, 'openSync').mockImplementation((name, flags, mode) =>
      name === file ? whileReplaced(() => open(name, flags, mode)) : open(name, flags, mode),
    );
    const started = performance.now();
    expect(() => resolveCredentials({}, {})).toThrowError(
      expect.objectContaining({ code: 'unsafe_directory' }),
    );
    expect(performance.now() - started).toBeLessThan(5000);
    expect(substitutions).toBeGreaterThan(0);
    const after = lstat(directory, { bigint: true });
    expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
    expect(after.ctimeNs).not.toBe(before.ctimeNs);
  });
  for (const vector of corpus.native_file_cases) {
    // These owner arrangements require a privileged test runner; the ordinary suite reports them as skipped.
    const ownerCase = ['F04', 'F05'].some((id) => vector.id.startsWith(id));
    it.skipIf(ownerCase && process.getuid?.() !== 0)(
      vector.id,
      async () => {
        put();
        let socket: net.Server | undefined;
        const id = vector.id.slice(0, 3);
        if (id === 'F02') fs.chmodSync(file, 0o644);
        if (id === 'F03') fs.chmodSync(directory, 0o755);
        if (id === 'F04') fs.chownSync(file, 1, 1);
        if (id === 'F05') fs.chownSync(directory, 1, 1);
        if (id === 'F06') {
          fs.renameSync(file, `${file}.original`);
          fs.symlinkSync(`${file}.original`, file);
        }
        if (id === 'F07') {
          fs.renameSync(directory, `${directory}.original`);
          fs.symlinkSync(`${directory}.original`, directory);
        }
        if (id === 'F08') fs.linkSync(file, `${file}.link`);
        if (['F09', 'F10', 'F11'].includes(id)) fs.unlinkSync(file);
        if (id === 'F09') execFileSync('mkfifo', [file]);
        if (id === 'F10') fs.mkdirSync(file, { mode: 0o600 });
        if (id === 'F11') {
          socket = net.createServer();
          await new Promise<void>((resolve, reject) => {
            socket!.once('error', reject);
            socket!.listen(file, resolve);
          });
        }
        if (id === 'F12') {
          const read = fs.readSync;
          vi.spyOn(fs, 'readSync').mockImplementation((...args: any[]) => {
            fs.appendFileSync(file, ' '.repeat(65_537));
            return (read as (...args: any[]) => number)(...args);
          });
        }
        if (id === 'F13' || id === 'F14') {
          const open = fs.openSync;
          let changed = false;
          vi.spyOn(fs, 'openSync').mockImplementation((name, flags, mode) => {
            if (name === file && !changed) {
              changed = true;
              if (id === 'F14') {
                fs.renameSync(directory, `${directory}.original`);
                const doc = structuredClone(corpus.base_document);
                doc.default_profile = 'Work';
                put(doc);
                return open(name, flags, mode);
              }
              const fd = open(name, flags, mode);
              fs.renameSync(file, `${file}.original`);
              const doc = structuredClone(corpus.base_document);
              doc.default_profile = 'Work';
              put(doc);
              return fd;
            }
            return open(name, flags, mode);
          });
        }
        if (id === 'F15') fs.chmodSync(file, 0o400);
        if (id === 'F16') fs.chmodSync(directory, 0o500);
        const start = performance.now();
        try {
          if (id === 'F01')
            expect(resolveCredentials({}, {}).apiKey).toBe(
              corpus.base_document.profiles.default.api_key,
            );
          else if (id === 'F13' || id === 'F14') {
            try {
              const result = resolveCredentials({}, {});
              expect({
                key: result.apiKey,
                base_url: result.baseUrl,
                profile: result.profile,
              }).toEqual(vector.original_identity);
            } catch (error) {
              expect(error).toBeInstanceOf(CredentialsError);
            }
          } else
            expect(() => resolveCredentials({}, {})).toThrowError(
              expect.objectContaining({ code: vector.expected.result }),
            );
          expect(performance.now() - start).toBeLessThan(vector.expected.completion_deadline_ms);
        } finally {
          if (socket) await new Promise<void>((resolve) => socket!.close(() => resolve()));
        }
      },
      5000,
    );
  }
});

describe('client credential snapshots', () => {
  it(corpus.instance_cases[0].id, async () => {
    put();
    const keys: string[] = [];
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      keys.push(new Headers(init?.headers).get('Authorization')!);
      return Response.json([]);
    };
    const original = new Client({ profile: 'Work', fetch });
    const entry = {
      ...corpus.base_document.profiles.Work,
      api_key: corpus.base_document.profiles.work.api_key,
    };
    await saveCredentials(entry, 'Work');
    const read = vi.spyOn(fs, 'readSync');
    read.mockClear();
    await original.computers.list();
    await original.computers.list();
    expect(read).not.toHaveBeenCalled();
    await new Client({ profile: 'Work', fetch }).computers.list();
    expect(keys).toEqual([
      `Bearer ${corpus.base_document.profiles.Work.api_key}`,
      `Bearer ${corpus.base_document.profiles.Work.api_key}`,
      `Bearer ${entry.api_key}`,
    ]);
  });
  for (const vector of [corpus.instance_cases[1], corpus.instance_cases[3]])
    it(vector.id, async () => {
      put();
      const fetch = vi.fn<typeof globalThis.fetch>(async () =>
        Response.json({ error: 'Revoked', reason: 'revoked' }, { status: 401 }),
      );
      const client = new Client({ profile: 'Work', fetch, retries: { idempotent: 3 } });
      await saveCredentials(corpus.base_document.profiles.work, 'Work');
      const read = vi.spyOn(fs, 'readSync');
      read.mockClear();
      const request =
        vector.request_method === 'POST'
          ? client.computers.create({ name: 'test' })
          : client.computers.list();
      await expect(request).rejects.toMatchObject({ status: 401, reason: 'revoked' });
      await request.catch((error) => expect(error).toBeInstanceOf(AuthenticationError));
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(read).not.toHaveBeenCalled();
      expect(new Headers(fetch.mock.calls[0]![1]?.headers).get('Authorization')).toBe(
        `Bearer ${corpus.base_document.profiles.Work.api_key}`,
      );
    });
  it(corpus.instance_cases[2].id, async () => {
    const doc: CredentialsFile = structuredClone(corpus.base_document);
    doc.profiles.Work!.account.id = 'forged';
    doc.profiles.Work!.scope = { type: 'account' };
    put(doc);
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json([]));
    await new Client({ profile: 'Work', fetch }).computers.list();
    const init = fetch.mock.calls[0]![1]!;
    expect(new Headers(init.headers).get('Authorization')).toBe(
      `Bearer ${corpus.base_document.profiles.Work.api_key}`,
    );
    expect(init.body).toBeUndefined();
    expect(readCredentials()!.profiles.Work!.account.id).toBe('forged');
  });
});
