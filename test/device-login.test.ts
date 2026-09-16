import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import { type CredentialProfile, readCredentials, saveCredentials } from '../src/credentials.js';
import { type DeviceLoginDependencies, deviceLogin, sleepForLogin } from '../src/device-login.js';

const corpus = JSON.parse(
  fs.readFileSync(new URL('./fixtures/credentials-v1.json', import.meta.url), 'utf8'),
);
const base = 'https://alpha.example.test/api/v1';
const deviceSecret = 'D'.repeat(43);
const apiKey = 'public-issued-key-canary';
const start = {
  device_code: deviceSecret,
  user_code: 'ABCD-2345',
  verification_uri: 'https://alpha.example.test/device',
  verification_uri_complete: 'https://alpha.example.test/device?user_code=ABCD-2345',
  expires_in: 600,
  interval: 5,
};
const authorized = {
  status: 'authorized',
  api_key: apiKey,
  key: { id: 'key_issued', name: 'Fixture laptop', created_at: '2026-09-16T00:00:00.000Z' },
  account: { id: 'account_issued', name: 'Issued account' },
  scope: { type: 'account' },
};
const entry: CredentialProfile = { ...corpus.base_document.profiles.default, api_key: apiKey };
let home: string;
let directory: string;
let file: string;
beforeEach(() => {
  home = fs.mkdtempSync(join(os.tmpdir(), 'mandala-login-'));
  directory = join(home, '.mandala');
  file = join(directory, 'credentials.json');
  vi.spyOn(os, 'homedir').mockReturnValue(home);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  fs.rmSync(home, { recursive: true, force: true });
});
function store(): void {
  fs.mkdirSync(directory, { mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(corpus.base_document), { mode: 0o600 });
}
function flow(
  replies: Array<Response | Error | ((init: RequestInit) => Promise<Response>)> = [
    Response.json(authorized),
  ],
) {
  let clock = 0;
  const waits: number[] = [];
  const secrets: string[] = [];
  const messages: string[] = [];
  const controller = new AbortController();
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    if (fetch.mock.calls.length === 1) return Response.json(start);
    const next = replies.shift();
    if (next instanceof Error) throw next;
    if (typeof next === 'function') return next(init!);
    if (!next) throw new Error('unexpected request');
    return next;
  });
  const deps: DeviceLoginDependencies = {
    fetch,
    now: () => clock,
    sleep: async (ms, signal) => {
      signal.throwIfAborted();
      waits.push(ms);
      clock += ms;
    },
    prompt: vi.fn(async () => {}),
    registerSecret: (s) => secrets.push(s),
    diagnostic: (s) => messages.push(s),
  };
  return {
    deps,
    fetch,
    waits,
    secrets,
    messages,
    controller,
    run: (workspace?: string) =>
      deviceLogin(
        { baseUrl: base, deviceName: 'Fixture laptop', workspace, signal: controller.signal },
        deps,
      ),
  };
}
async function cli(
  args: string[] = [],
  env: NodeJS.ProcessEnv = {},
  replies?: Parameters<typeof flow>[0],
) {
  const f = flow(replies);
  let out = '';
  let err = '';
  const browser = vi.fn(async () => false);
  const code = await main(['login', '--base-url', base, ...args, '--json'], {
    env,
    stdin: Readable.from([]),
    stdout: {
      write: ((s: unknown) => {
        out += s;
        return true;
      }) as NodeJS.WritableStream['write'],
    },
    stderr: {
      write: ((s: unknown) => {
        err += s;
        return true;
      }) as NodeJS.WritableStream['write'],
    },
    createClient: () => {
      throw new Error('login must not create an authenticated client');
    },
    login: { fetch: f.fetch, now: f.deps.now, sleep: f.deps.sleep, openBrowser: browser },
  });
  for (const secret of [deviceSecret, apiKey, env.MANDALA_API_KEY].filter(Boolean) as string[])
    expect(out + err).not.toContain(secret);
  return { code, out, err, result: JSON.parse(out), f, browser };
}

describe('anonymous device exchange', () => {
  it('starts with exact anonymous scope, paces pending/slow-down/unavailable, and returns a validated credential', async () => {
    const f = flow([
      Response.json({ status: 'pending', interval: 5 }, { status: 202 }),
      Response.json(
        {
          error: 'Wait',
          code: 'slow_down',
          request_id: 'request_test',
          interval: 10,
          retry_after: 12,
        },
        { status: 429, headers: { 'Retry-After': '15' } },
      ),
      Response.json(
        {
          error: 'Busy',
          code: 'temporarily_unavailable',
          request_id: 'request_test',
          retry_after: 20,
        },
        { status: 503 },
      ),
      Response.json(authorized),
    ]);
    expect((await f.run()).api_key).toBe(apiKey);
    expect(f.waits).toEqual([5000, 5000, 15000, 20000]);
    expect(f.secrets).toEqual([deviceSecret, apiKey]);
    for (const [url, init] of f.fetch.mock.calls) {
      expect(String(url)).toMatch(
        /^https:\/\/alpha\.example\.test\/api\/auth\/device\/(start|poll)$/,
      );
      expect(init).toMatchObject({ method: 'POST', credentials: 'omit', redirect: 'error' });
      expect(new Headers(init?.headers).has('authorization')).toBe(false);
      expect(new Headers(init?.headers).has('cookie')).toBe(false);
      expect(new Headers(init?.headers).has('x-model-key')).toBe(false);
    }
    expect(JSON.parse(f.fetch.mock.calls[0]![1]!.body as string)).toEqual({
      device_name: 'Fixture laptop',
      scope: 'account',
    });
  });
  it('requests an exact workspace and rejects broadening', async () => {
    const f = flow([
      Response.json({
        ...authorized,
        scope: { type: 'workspace', workspace_id: 'workspace_test', workspace_name: 'Research' },
      }),
    ]);
    expect((await f.run('Research')).scope.type).toBe('workspace');
    expect(JSON.parse(f.fetch.mock.calls[0]![1]!.body as string)).toEqual({
      device_name: 'Fixture laptop',
      scope: 'workspace',
      workspace_name: 'Research',
    });
    await expect(flow().run('Research')).rejects.toMatchObject({ code: 'invalid_device_response' });
  });
  it('normalizes a padded workspace before start and saves the authorized CLI credential', async () => {
    const scope = { type: 'workspace', workspace_id: 'workspace_test', workspace_name: 'Research' };
    const result = await cli(['--workspace', ' \tResearch\n '], {}, [
      Response.json({ ...authorized, scope }),
    ]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.f.fetch.mock.calls[0]![1]!.body as string)).toMatchObject({
      scope: 'workspace',
      workspace_name: 'Research',
    });
    expect(result.f.fetch).toHaveBeenCalledTimes(2);
    expect(readCredentials()!.profiles.default).toMatchObject({ api_key: apiKey, scope });
  });
  for (const workspace of [' \t\n ', 'x'.repeat(41)])
    it(`rejects an invalid workspace before start (${workspace.length} characters)`, async () => {
      const f = flow();
      await expect(f.run(workspace)).rejects.toMatchObject({ code: 'invalid_workspace' });
      expect(f.fetch).not.toHaveBeenCalled();
    });
  for (const header of [
    'Wed, 16 Sep 2026 00:01:05 GMT',
    'Wednesday, 16-Sep-26 00:01:05 GMT',
    'Wed Sep 16 00:01:05 2026',
  ])
    it(`honors HTTP-date Retry-After with a controlled wall clock: ${header}`, async () => {
      const f = flow([
        Response.json(
          { error: 'Wait', code: 'rate_limited', request_id: 'request_test', retry_after: 5 },
          { status: 429, headers: { 'Retry-After': header } },
        ),
        Response.json(authorized),
      ]);
      f.deps.wallNow = () => Date.UTC(2026, 8, 16) + f.deps.now();
      expect((await f.run()).api_key).toBe(apiKey);
      expect(f.waits).toEqual([5000, 60_000]);
      expect(f.fetch).toHaveBeenCalledTimes(3);
    });
  it('combines date pacing with a larger body delay and preserves the original expiry', async () => {
    const f = flow([
      Response.json(
        {
          error: 'Busy',
          code: 'temporarily_unavailable',
          request_id: 'request_test',
          retry_after: 90,
        },
        { status: 503, headers: { 'Retry-After': 'Wed, 16 Sep 2026 00:01:05 GMT' } },
      ),
      Response.json(
        { error: 'Wait', code: 'rate_limited', request_id: 'request_test' },
        { status: 429, headers: { 'Retry-After': 'Wed, 16 Sep 2026 01:00:00 GMT' } },
      ),
    ]);
    f.deps.wallNow = () => Date.UTC(2026, 8, 16) + f.deps.now();
    await expect(f.run()).rejects.toMatchObject({ code: 'expired_token' });
    expect(f.waits).toEqual([5000, 90_000, 505_000]);
    expect(f.fetch).toHaveBeenCalledTimes(3);
    expect(f.fetch.mock.calls.filter(([url]) => String(url).endsWith('/start'))).toHaveLength(1);
  });
  for (const [code, status] of [
    ['access_denied', 403],
    ['expired_token', 400],
    ['key_limit', 400],
    ['invalid_device_code', 400],
    ['cancelled', 400],
    ['already_consumed', 409],
  ] as const)
    it(`stops ${code} without restarting`, async () => {
      const f = flow([
        Response.json({ error: 'Stopped', code, request_id: 'request_test' }, { status }),
      ]);
      await expect(f.run()).rejects.toMatchObject({ code });
      expect(f.fetch).toHaveBeenCalledTimes(2);
    });
  it('a lost consuming response checks the same grant, then explains uncertain issuance', async () => {
    const f = flow([
      new Error(`connection ${deviceSecret}`),
      Response.json(
        { error: 'Consumed', code: 'already_consumed', request_id: 'request_test' },
        { status: 409 },
      ),
    ]);
    await expect(f.run()).rejects.toThrow(/Settings/);
    expect(f.waits).toEqual([5000, 10000]);
    expect(f.fetch).toHaveBeenCalledTimes(3);
    expect(f.messages.join()).not.toContain(deviceSecret);
  });
  it('honors the original expiry despite pending responses', async () => {
    const f = flow(
      Array.from({ length: 120 }, () =>
        Response.json({ status: 'pending', interval: 5 }, { status: 202 }),
      ),
    );
    await expect(f.run()).rejects.toMatchObject({ code: 'expired_token' });
    expect(f.waits.reduce((a, b) => a + b, 0)).toBe(600_000);
    expect(f.fetch.mock.calls.filter(([url]) => String(url).endsWith('/start'))).toHaveLength(1);
  });
  for (const [label, body] of [
    [
      'external URL',
      { ...start, verification_uri_complete: 'https://evil.test/device?user_code=ABCD-2345' },
    ],
    [
      'device secret in URL',
      {
        ...start,
        verification_uri_complete: `https://alpha.example.test/device?device_code=${deviceSecret}`,
      },
    ],
    ['wrong interval', { ...start, interval: 0 }],
    ['unknown secret', { ...start, approval_token: 'approval-canary' }],
  ] as const)
    it(`refuses ${label} before display/open`, async () => {
      const f = flow();
      f.fetch.mockImplementationOnce(async () => Response.json(body));
      await expect(f.run()).rejects.toMatchObject({ code: 'invalid_device_response' });
      expect(f.deps.prompt).not.toHaveBeenCalled();
      expect(f.fetch).toHaveBeenCalledTimes(1);
    });
  for (const [label, response] of [
    ['HTML', () => new Response('<h1>bad</h1>')],
    ['invalid JSON', () => new Response('{', { headers: { 'content-type': 'application/json' } })],
    [
      'oversized body',
      () => new Response(' '.repeat(16_385), { headers: { 'content-type': 'application/json' } }),
    ],
    [
      'redirect',
      () => new Response(null, { status: 302, headers: { Location: 'https://evil.test/' } }),
    ],
  ] as const)
    it(`refuses ${label}`, async () => {
      const f = flow();
      f.fetch.mockImplementationOnce(async () => response());
      await expect(f.run()).rejects.toMatchObject({ code: 'invalid_device_response' });
      expect(f.deps.prompt).not.toHaveBeenCalled();
    });
  it('abortable timers stop immediately', async () => {
    const controller = new AbortController();
    const waiting = sleepForLogin(60_000, controller.signal);
    const check = expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await check;
  });
  it('cancels a stalled fetch once, with a fresh bounded cleanup signal', async () => {
    vi.useFakeTimers();
    const f = flow([
      async () => {
        f.controller.abort();
        return new Promise<Response>(() => {});
      },
      async (init) => {
        expect(init.signal?.aborted).toBe(false);
        expect(JSON.parse(init.body as string).action).toBe('cancel');
        return new Promise<Response>(() => {});
      },
    ]);
    const result = expect(f.run()).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(2001);
    await result;
    expect(f.fetch).toHaveBeenCalledTimes(3);
  });
  it('aborts a stalled response body and rejects a late key', async () => {
    const f = flow([
      async () =>
        new Response(
          new ReadableStream({
            start() {
              queueMicrotask(() => f.controller.abort());
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      Response.json({ status: 'cancelled' }),
    ]);
    await expect(f.run()).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.fetch).toHaveBeenCalledTimes(3);
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe('credential writer corpus', () => {
  it(corpus.writer_cases[0].id, async () => {
    const previous = process.umask(0);
    try {
      const result = await cli();
      expect(result.code).toBe(0);
      expect(result.result.data).toEqual({
        profile: 'default',
        base_url: base,
        account: authorized.account,
        scope: authorized.scope,
        saved: true,
      });
      expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(readCredentials()!.profiles.default!.api_key).toBe(apiKey);
      expect(result.err).toContain(start.user_code);
      expect(result.err).toContain(start.verification_uri);
      expect(result.err).toContain('Browser could not be opened');
    } finally {
      process.umask(previous);
    }
  });
  it(corpus.writer_cases[1].id, async () => {
    store();
    const result = await cli(['--profile', 'New'], { MANDALA_API_KEY: 'environment-canary' });
    expect(result.code).toBe(0);
    const saved = readCredentials()!;
    expect(saved.default_profile).toBe('default');
    expect(saved.profiles.New!.api_key).toBe(apiKey);
    for (const [name, profile] of Object.entries(corpus.base_document.profiles))
      expect(saved.profiles[name]).toEqual(profile);
  });
  for (const [index, args, env, name] of [
    [2, [], {}, 'default'],
    [3, ['--profile', 'Work'], { MANDALA_PROFILE: 'default' }, 'Work'],
    [4, [], { MANDALA_PROFILE: 'Work' }, 'Work'],
  ] as const)
    it(corpus.writer_cases[index].id, async () => {
      store();
      expect((await cli([...args], env)).code).toBe(0);
      const saved = readCredentials()!;
      expect(saved.default_profile).toBe('default');
      expect(saved.profiles[name]!.api_key).toBe(apiKey);
    });
  it(corpus.writer_cases[5].id, async () => {
    store();
    const workerDir = join(home, 'writer-code');
    fs.mkdirSync(workerDir);
    fs.writeFileSync(join(workerDir, 'package.json'), '{"type":"module"}');
    for (const name of ['credentials', 'credentials-browser', 'errors']) {
      const source = fs.readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8');
      fs.writeFileSync(
        join(workerDir, `${name}.js`),
        ts.transpileModule(source, {
          compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
        }).outputText,
      );
    }
    fs.writeFileSync(
      join(workerDir, 'worker.mjs'),
      `import {saveCredentials} from './credentials.js';
        import fs from 'node:fs'; import path from 'node:path'; import {setTimeout} from 'node:timers/promises';
        const home=process.env.HOME;
        fs.writeFileSync(path.join(home,'ready-'+process.argv[2]),'ready');
        const deadline=Date.now()+2000;
        while(!['NewA','NewB'].every(name=>fs.existsSync(path.join(home,'ready-'+name)))) {
          if(Date.now()>deadline)throw Error('writer barrier timed out');await setTimeout(5);
        }
        const open=fs.openSync;
        fs.openSync=(name,...args)=>{
          // Both processes reach final save together. Holding the first writer here makes
          // a removed lock or pre-lock stale read fail by losing/refusing one update.
          if(String(name).endsWith('.tmp')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100);
          return open(name,...args);
        };
        await saveCredentials(${JSON.stringify(entry)},process.argv[2]);`,
    );
    const run = promisify(execFile);
    await Promise.all(
      ['NewA', 'NewB'].map((name) =>
        run(process.execPath, [join(workerDir, 'worker.mjs'), name], {
          env: { ...process.env, HOME: home },
          timeout: 6000,
        }),
      ),
    );
    const saved = readCredentials()!;
    expect(saved.profiles.NewA).toEqual(entry);
    expect(saved.profiles.NewB).toEqual(entry);
    expect(saved.default_profile).toBe('default');
  });
  for (const index of [6, 13])
    it(`${corpus.writer_cases[index].id} (lock deadline: 30 ms)`, async () => {
      store();
      const lock = join(directory, '.credentials.lock');
      fs.writeFileSync(lock, 'other writer', { mode: 0o600 });
      const startTime = performance.now();
      await expect(saveCredentials(entry, 'New', { lockTimeoutMs: 30 })).rejects.toMatchObject({
        code: 'writer_lock_timeout',
      });
      expect(performance.now() - startTime).toBeLessThan(1000);
      expect(fs.readFileSync(lock, 'utf8')).toBe('other writer');
    });
  it('retries when a contended lock disappears between exclusive open and inspection', async () => {
    store();
    const lock = join(directory, '.credentials.lock');
    fs.writeFileSync(lock, 'finishing writer', { mode: 0o600 });
    const open = fs.openSync;
    const lstat = fs.lstatSync;
    let opens = 0;
    let releaseBeforeInspection = false;
    vi.spyOn(fs, 'openSync').mockImplementation((name, flags, mode) => {
      if (name === lock) {
        opens++;
        if (opens === 1) releaseBeforeInspection = true;
      }
      return open(name, flags, mode);
    });
    vi.spyOn(fs, 'lstatSync').mockImplementation(((name: fs.PathLike, options?: any) => {
      if (name === lock && releaseBeforeInspection) {
        releaseBeforeInspection = false;
        fs.unlinkSync(lock);
      }
      return lstat(name, options);
    }) as typeof fs.lstatSync);
    await expect(saveCredentials(entry, 'New', { lockTimeoutMs: 1000 })).resolves.toMatchObject({
      saved: true,
    });
    expect(opens).toBe(2);
    expect(readCredentials()!.profiles.New).toEqual(entry);
    expect(readCredentials()!.profiles.Work).toEqual(corpus.base_document.profiles.Work);
    expect(fs.existsSync(lock)).toBe(false);
  });
  it('does not retry a released lock after the same acquisition deadline expires', async () => {
    store();
    const lock = join(directory, '.credentials.lock');
    const open = fs.openSync;
    const lstat = fs.lstatSync;
    fs.writeFileSync(lock, 'finishing writer', { mode: 0o600 });
    let clock = 0;
    let opens = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    vi.spyOn(fs, 'openSync').mockImplementation((name, flags, mode) => {
      if (name === lock) opens++;
      return open(name, flags, mode);
    });
    vi.spyOn(fs, 'lstatSync').mockImplementation(((name: fs.PathLike, options?: any) => {
      if (name === lock) {
        fs.unlinkSync(lock);
        clock = 30;
      }
      return lstat(name, options);
    }) as typeof fs.lstatSync);
    await expect(saveCredentials(entry, 'New', { lockTimeoutMs: 30 })).rejects.toMatchObject({
      code: 'writer_lock_timeout',
    });
    expect(opens).toBe(1);
    expect(readCredentials()!.profiles.New).toBeUndefined();
  });
  it(corpus.writer_cases[7].id, async () => {
    store();
    const lock = join(directory, '.credentials.lock');
    fs.symlinkSync(file, lock);
    await expect(saveCredentials(entry)).rejects.toMatchObject({ code: 'unsafe_file' });
    expect(fs.lstatSync(lock).isSymbolicLink()).toBe(true);
  });
  it(corpus.writer_cases[8].id, async () => {
    const f = flow();
    f.deps.prompt = async () => {
      expect(fs.existsSync(join(directory, '.credentials.lock'))).toBe(false);
      await saveCredentials(entry, 'Other');
    };
    await f.run();
    expect(readCredentials()!.profiles.Other).toEqual(entry);
  });
  it(corpus.writer_cases[9].id, async () => {
    store();
    const before = fs.readFileSync(file);
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    });
    const result = await cli();
    expect(result.code).toBe(1);
    expect(result.err + result.out).toContain('Settings');
    expect(fs.readFileSync(file)).toEqual(before);
    expect(fs.readdirSync(directory)).toEqual(['credentials.json']);
  });
  it(corpus.writer_cases[10].id, async () => {
    store();
    const controller = new AbortController();
    const rename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((...args) => {
      rename(...args);
      controller.abort();
    });
    expect(await saveCredentials(entry, 'New', { signal: controller.signal })).toMatchObject({
      saved: true,
    });
    expect(readCredentials()!.profiles.New).toEqual(entry);
  });
  it(corpus.writer_cases[11].id, async () => {
    store();
    const before = fs.readFileSync(file);
    const controller = new AbortController();
    const sync = fs.fsyncSync;
    vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
      sync(fd);
      controller.abort();
    });
    await expect(
      saveCredentials(entry, 'New', { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fs.readFileSync(file)).toEqual(before);
    expect(fs.readdirSync(directory)).toEqual(['credentials.json']);
  });
  it(corpus.writer_cases[12].id, async () => {
    store();
    const seen: string[] = [];
    const rename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((...args) => {
      seen.push(readCredentials()!.profiles.default!.api_key);
      rename(...args);
      seen.push(readCredentials()!.profiles.default!.api_key);
    });
    await saveCredentials(entry);
    expect(seen).toEqual([corpus.base_document.profiles.default.api_key, apiKey]);
  });
  it(corpus.writer_cases[14].id, async () => {
    store();
    vi.spyOn(fs, 'fsyncSync').mockImplementation(() => {
      throw new Error(`disk full ${apiKey}`);
    });
    const result = await cli();
    expect(result.code).toBe(1);
    expect(result.out).toContain('Settings');
    expect(
      result.f.fetch.mock.calls.filter(([url]) => String(url).endsWith('/start')),
    ).toHaveLength(1);
  });
});

it('reports a committed save when cancellation coincides with directory flush failure', async () => {
  store();
  const sync = fs.fsyncSync;
  vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
    if (fs.fstatSync(fd).isDirectory()) {
      process.emit('SIGINT');
      throw Object.assign(new Error('directory flush failed'), { code: 'EIO' });
    }
    sync(fd);
  });
  const result = await cli();
  expect(result.code).toBe(1);
  expect(result.out).toContain('Credentials were saved');
  expect(readCredentials()!.profiles.default!.api_key).toBe(apiKey);
});
