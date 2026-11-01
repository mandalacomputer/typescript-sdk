/**
 * The 2026-11 audit against the API reference (OPL-6305): batch checks, end-time
 * refusals before the wire, the expiring-key event stream, the retention header,
 * trial refusals made before anything was sent, and the CLI additions.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import type { CliIO } from '../src/cli-runtime.js';
import { errorForStatus } from '../src/errors.js';
import {
  APIError,
  Client,
  InputBatchError,
  isTransient,
  MandalaError,
  TimeoutError,
  trialUnavailable,
  UnavailableError,
  ValidationError,
} from '../src/index.js';
import { LIMITS } from '../src/limits.js';
import { type InputBatchAction, inputBatchBody } from '../src/paths.js';
import { parseFileUpload } from '../src/uploads.js';
import {
  API_KEY,
  anyRoute,
  BASE,
  COMPUTER,
  EXEC_OK,
  EXEC_STARTED,
  json,
  type Responder,
  recorder,
  WHOAMI,
} from './harness.js';

/** A computer as a key that expires is answered it, with no connect surface. */
const { vnc: _vnc, ...BARE } = COMPUTER as typeof COMPUTER & { vnc?: unknown };

const setup = (respond: Responder = anyRoute) => {
  const rec = recorder(respond);
  const client = new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch });
  return { rec, client, computer: () => client.computers.get('vm-1') };
};

describe('batch wait_for', () => {
  it('sends each condition as the reference spells it', async () => {
    const { rec, computer } = setup();
    const c = await computer();
    await c.inputBatch([
      { type: 'click', x: 1, y: 2, button: 'left' },
      { type: 'wait_for', until: 'screen_changed', region: { x: 0, y: 0, width: 10, height: 20 } },
      { type: 'wait_for', until: 'screen_stable', stable_ms: 100, timeout_ms: 0 },
      { type: 'wait_for', until: 'window_title', contains: 'Settings', timeout_ms: 30000 },
    ]);
    expect(rec.calls.at(-1)?.body).toEqual([
      { type: 'click', x: 1, y: 2, button: 'left' },
      {
        type: 'wait_for',
        until: 'screen_changed',
        region: { x: 0, y: 0, width: 10, height: 20 },
      },
      { type: 'wait_for', until: 'screen_stable', stable_ms: 100, timeout_ms: 0 },
      { type: 'wait_for', until: 'window_title', contains: 'Settings', timeout_ms: 30000 },
    ]);
  });

  it('accepts 256 bytes of contains, counted as bytes', () => {
    expect(
      inputBatchBody([{ type: 'wait_for', until: 'window_title', contains: 'é'.repeat(128) }]),
    ).toHaveLength(1);
  });

  it.each<[string, unknown]>([
    ['an unknown condition', { until: 'command' }],
    ['no condition', {}],
    ['a timeout past 30000', { until: 'screen_changed', timeout_ms: 30001 }],
    ['a negative timeout', { until: 'screen_changed', timeout_ms: -1 }],
    ['a fractional timeout', { until: 'screen_changed', timeout_ms: 1.5 }],
    ['a null timeout', { until: 'screen_changed', timeout_ms: null }],
    ['a short stable_ms', { until: 'screen_stable', stable_ms: 99 }],
    ['a long stable_ms', { until: 'screen_stable', stable_ms: 10001 }],
    ['stable_ms on another condition', { until: 'screen_changed', stable_ms: 500 }],
    ['contains on another condition', { until: 'screen_stable', contains: 'x' }],
    ['region on window_title', { until: 'window_title', contains: 'x', region: {} }],
    ['no contains', { until: 'window_title' }],
    ['an empty contains', { until: 'window_title', contains: '' }],
    ['257 bytes of contains', { until: 'window_title', contains: `${'é'.repeat(128)}a` }],
    ['an unknown field', { until: 'screen_changed', command: 'true' }],
    ['a region with no size', { until: 'screen_changed', region: { x: 0, y: 0 } }],
    [
      'a zero-width region',
      { until: 'screen_changed', region: { x: 0, y: 0, width: 0, height: 1 } },
    ],
    [
      'a negative region',
      { until: 'screen_changed', region: { x: -1, y: 0, width: 1, height: 1 } },
    ],
    [
      'a region with another field',
      { until: 'screen_changed', region: { x: 0, y: 0, width: 1, height: 1, z: 1 } },
    ],
  ])('refuses %s before anything is sent', (_what, step) => {
    const action = { type: 'wait_for', ...(step as object) } as unknown as InputBatchAction;
    expect(() => inputBatchBody([action])).toThrow(ValidationError);
  });

  it('types waited_ms on a passed check', async () => {
    const { computer } = setup((call) =>
      call.path.endsWith('/input')
        ? json({ ok: true, completed: 2, results: [{ ok: true }, { ok: true, waited_ms: 42 }] })
        : anyRoute(call),
    );
    const done = await (await computer()).inputBatch([
      { type: 'wait' },
      { type: 'wait_for', until: 'screen_stable' },
    ]);
    expect(done.results[0]?.waitedMs).toBeUndefined();
    expect(done.results[1]?.waitedMs).toBe(42);
  });

  it('refuses a waited_ms that is not a count', async () => {
    const { computer } = setup((call) =>
      call.path.endsWith('/input')
        ? json({ ok: true, completed: 1, results: [{ ok: true, waited_ms: 'soon' }] })
        : anyRoute(call),
    );
    await expect(
      (await computer()).inputBatch([{ type: 'wait_for', until: 'screen_stable' }]),
    ).rejects.toThrow(/waited_ms/);
  });

  it('raises a check that was not met as a stopped batch that is never transient', async () => {
    const { computer } = setup((call) =>
      call.path.endsWith('/input')
        ? json(
            {
              ok: false,
              completed: 1,
              failed_index: 1,
              error: 'condition not met',
              results: [{ ok: true }],
            },
            { status: 400 },
          )
        : anyRoute(call),
    );
    const err = await (await computer())
      .inputBatch([{ type: 'wait' }, { type: 'wait_for', until: 'screen_stable' }])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InputBatchError);
    expect((err as InputBatchError).status).toBe(400);
    expect((err as InputBatchError).result.failedIndex).toBe(1);
    expect(isTransient(err)).toBe(false);
  });
});

describe('end time and expiry refusals before the wire', () => {
  it.each(['2026-12-01', 'Dec 1 2026', '2026-12-01T10:00:00', '2026-11-31T10:00:00Z'])(
    'refuses %s on every route that takes a time',
    async (when) => {
      const { rec, client, computer } = setup();
      const c = await computer();
      const before = rec.calls.length;
      await expect(c.update({ endsAt: when })).rejects.toThrow(ValidationError);
      await expect(client.computers.create({ endsAt: when })).rejects.toThrow(ValidationError);
      await expect(client.apiKeys.create({ expiresAt: when })).rejects.toThrow(ValidationError);
      expect(rec.calls.length).toBe(before);
    },
  );

  it.each([
    '2026-02-29T10:00:00Z',
    '2026-13-01T10:00:00Z',
    '2026-12-01T24:00:00Z',
    '2026-12-01T10:60:00Z',
    '2026-12-01T10:00:60Z',
    '2026-12-01T10:00:00+24:00',
  ])('refuses %s, which is no moment', async (when) => {
    const { client } = setup();
    await expect(client.computers.create({ endsAt: when })).rejects.toThrow(ValidationError);
  });

  it.each(['2028-02-29T10:00:00Z', '2026-12-01t10:00:00.5+01:00', '2026-12-01T10:00:00-05:30'])(
    'passes %s through as written',
    async (when) => {
      const { rec, client } = setup((call) =>
        call.method === 'POST' && call.path === '/computers'
          ? json(
              { ...COMPUTER, ends_at: new Date(Date.parse(when)).toISOString() },
              { status: 201 },
            )
          : anyRoute(call),
      );
      await client.computers.create({ endsAt: when });
      expect(rec.calls.at(-1)?.body).toMatchObject({ ends_at: when });
    },
  );

  it('refuses more than 8784 hours, and takes exactly that', async () => {
    const { rec, client, computer } = setup();
    const c = await computer();
    const before = rec.calls.length;
    await expect(c.update({ endsInHours: 8784.5 })).rejects.toThrow(/at most 8784/);
    await expect(client.computers.create({ endsInHours: 8785 })).rejects.toThrow(/at most 8784/);
    await expect(client.apiKeys.create({ expiresInHours: 8785 })).rejects.toThrow(/at most 8784/);
    expect(rec.calls.length).toBe(before);
    const { createBody } = await import('../src/paths.js');
    expect(createBody({ endsInHours: 8784 }).ends_in_hours).toBe(8784);
  });
});

describe('the event stream on a key that expires', () => {
  const NO_VNC = { ...BARE, state: 'live', unreachable: false };
  /** A computer answered with no `vnc`, and `whoami` as given. */
  const answering = (who: Response | (() => Response), computer: unknown = NO_VNC) => {
    const counts = { whoami: 0, computer: 0 };
    const respond: Responder = (call) => {
      if (call.path === '/whoami') {
        counts.whoami++;
        return typeof who === 'function' ? who() : who.clone();
      }
      if (call.path === '/computers/vm-1') {
        counts.computer++;
        return json(computer);
      }
      return anyRoute(call);
    };
    return { counts, respond };
  };
  const expiring = json({
    ...WHOAMI,
    key: { ...API_KEY, expires_at: '2030-01-01T00:00:00Z' },
  });
  const forever = json({ ...WHOAMI, key: { ...API_KEY, expires_at: null } });
  const fast = { backoffMs: 1, maxBackoffMs: 1 };

  it('ends with a final error naming the key, after one read of it', async () => {
    const { counts, respond } = answering(expiring);
    const { computer } = setup(respond);
    const c = await computer();
    const err = await (async () => {
      for await (const _ of c.events(fast));
    })().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MandalaError);
    expect((err as Error).message).toMatch(/key that expires/);
    expect((err as Error).message).toMatch(/no expiry/);
    expect(counts.whoami).toBe(1);
  });

  it('ends waitFor at once, not at its deadline', async () => {
    const { respond } = answering(expiring);
    const { computer } = setup(respond);
    const c = await computer();
    const err = await c
      .waitFor('computer.ready', { ...fast, timeoutMs: 60_000 })
      .catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(TimeoutError);
    expect((err as Error).message).toMatch(/key that expires/);
  });

  it('keeps retrying on a key with no expiry, reading the key once', async () => {
    const { counts, respond } = answering(forever);
    const { computer } = setup(respond);
    const c = await computer();
    const err = await c
      .waitFor('computer.ready', { ...fast, timeoutMs: 80 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    expect(counts.computer).toBeGreaterThan(2);
    expect(counts.whoami).toBe(1);
  });

  it('keeps retrying when the key cannot be read, and asks again', async () => {
    const { counts, respond } = answering(() => json({ error: 'nope' }, { status: 503 }));
    const { computer } = setup(respond);
    const c = await computer();
    await expect(c.waitFor('computer.ready', { ...fast, timeoutMs: 80 })).rejects.toBeInstanceOf(
      TimeoutError,
    );
    expect(counts.whoami).toBeGreaterThan(1);
  });

  it('never asks about the key while the host is unreachable', async () => {
    const { counts, respond } = answering(expiring, { id: 'vm-1', unreachable: true });
    const { computer } = setup(respond);
    const c = await computer();
    await expect(c.waitFor('computer.ready', { ...fast, timeoutMs: 80 })).rejects.toBeInstanceOf(
      TimeoutError,
    );
    expect(counts.whoami).toBe(0);
  });
});

describe('retained output', () => {
  const exec = (status: number, headers: Record<string, string>, body: unknown = EXEC_OK) =>
    setup((call) =>
      call.path.endsWith('/exec') ? json(body, { status, headers }) : anyRoute(call),
    );

  it('says unavailable when the platform does', async () => {
    const { computer } = exec(200, { 'X-GC-Retained-Output': 'unavailable' });
    const result = await (await computer()).exec('true', { retainOutput: true });
    expect(result.retainedOutput).toBe('unavailable');
    expect(result.resultId).toBeUndefined();
  });

  it('is absent when the header is', async () => {
    const { computer } = exec(200, {});
    expect((await (await computer()).exec('true')).retainedOutput).toBeUndefined();
  });

  it('carries it on a refused answer', async () => {
    const { computer } = exec(
      409,
      { 'X-GC-Retained-Output': 'unavailable' },
      { error: 'busy', reason: 'contention' },
    );
    const err = await (await computer())
      .exec('true', { retainOutput: true })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(APIError);
    expect((err as APIError).retainedOutput).toBe('unavailable');
  });
});

describe('trialUnavailable', () => {
  const trial = (code: string, status = 503, extra: object = {}) =>
    errorForStatus(status, 'x', { error: 'x', code, ...extra }, { method: 'POST' });

  it.each(['TRIAL_FULL', 'TRIAL_UNAVAILABLE'])('recognises %s', (code) => {
    const err = trial(code);
    expect(trialUnavailable(err)).toBe(true);
    expect(isTransient(err)).toBe(false);
  });

  it('declines everything else', () => {
    expect(trialUnavailable(trial('OTHER'))).toBe(false);
    expect(trialUnavailable(trial('TRIAL_FULL', 402))).toBe(false);
    expect(trialUnavailable(trial('TRIAL_FULL', 503, { operation_id: 'op_1' }))).toBe(false);
    expect(trialUnavailable(new UnavailableError('x', 503, { code: 'TRIAL_FULL' }))).toBe(false);
    expect(trialUnavailable(new Error('x'))).toBe(false);
  });
});

it('mirrors the run time limit', () => {
  expect(LIMITS['agent.runTimeoutSeconds']).toBe(3600);
});

it('reports a background command’s start time when the platform says', async () => {
  const STARTED = '2026-11-01T10:00:00Z';
  const { computer } = setup((call) =>
    call.path.endsWith('/exec')
      ? json({ ...EXEC_STARTED, started_at: STARTED }, { status: 202 })
      : anyRoute(call),
  );
  expect((await (await computer()).execBackground('sleep 1')).startedAt).toBe(STARTED);
});

it('throws a MandalaError for upload progress it cannot read', () => {
  expect(() => parseFileUpload({}, '/a', 'b')).toThrow(MandalaError);
});

describe('CLI', () => {
  function harness(respond: Responder) {
    const rec = recorder(respond);
    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    const sink = (into: Uint8Array[]) => ({
      write: ((s: string | Uint8Array) => {
        into.push(Buffer.from(s));
        return true;
      }) as NodeJS.WritableStream['write'],
    });
    const io: Partial<CliIO> = {
      stdin: Object.assign(Readable.from([]), { isTTY: true }),
      stdout: sink(stdout),
      stderr: sink(stderr),
      env: { MANDALA_API_KEY: 'com_cli_test' },
      createClient: () => new Client({ apiKey: 'com_cli_test', baseUrl: BASE, fetch: rec.fetch }),
    };
    return {
      rec,
      async run(args: string[]) {
        const code = await main(args, io);
        return {
          code,
          out: Buffer.concat(stdout).toString(),
          err: Buffer.concat(stderr).toString(),
        };
      },
    };
  }
  const ID = 'vm-0123456789ab';
  const PROXY = { server: 'http://proxy.example.com:3128', bypass: ['a.example'] };
  const record = (over: object = {}) => ({ ...COMPUTER, id: ID, ...over });
  const computers =
    (answer: (call: Parameters<Responder>[0]) => unknown): Responder =>
    (call) =>
      call.path === `/computers/${ID}` ? json(answer(call)) : anyRoute(call);

  it('browser-proxy get --json answers the setting', async () => {
    const h = harness(computers(() => record({ browser_proxy: PROXY })));
    const { code, out } = await h.run(['computers', 'browser-proxy', 'get', ID, '--json']);
    expect(code).toBe(0);
    expect(JSON.parse(out).data).toEqual({
      id: ID,
      name: COMPUTER.name,
      browser_proxy: PROXY,
      browser_proxy_pending: false,
    });
  });

  it('browser-proxy get says when there is none', async () => {
    const h = harness(computers(() => record()));
    const { out } = await h.run(['computers', 'browser-proxy', 'get', ID]);
    expect(out).toContain('no browser proxy');
  });

  it('egress-proxy get answers the setting', async () => {
    const h = harness(computers(() => record({ egress_proxy: { server: PROXY.server } })));
    const { out } = await h.run(['computers', 'egress-proxy', 'get', ID]);
    expect(out).toContain(`all outbound TCP through ${PROXY.server}`);
  });

  it('browser-proxy set --wait waits until the browsers have it', async () => {
    let reads = 0;
    const h = harness(
      computers((call) =>
        call.method === 'PATCH'
          ? record({ browser_proxy: PROXY, browser_proxy_pending: true })
          : record({ browser_proxy: PROXY, browser_proxy_pending: ++reads < 2 }),
      ),
    );
    const { code } = await h.run(['computers', 'browser-proxy', 'set', ID, PROXY.server, '--wait']);
    expect(code).toBe(0);
    expect(reads).toBeGreaterThanOrEqual(2);
  });

  it('browser-proxy clear --wait says a stopped computer gets it as it starts', async () => {
    const h = harness(computers(() => record({ status: 'stopped', running_ram_mb: 0 })));
    const { code, err } = await h.run(['computers', 'browser-proxy', 'clear', ID, '--wait']);
    expect(code).toBe(0);
    expect(err).toContain('applied as it starts');
  });

  it('--wait keeps waiting when it cannot say no start is under way', async () => {
    let reads = 0;
    const h = harness(
      computers((call) =>
        call.method === 'PATCH'
          ? record({ status: 'stopped', browser_proxy: PROXY })
          : ++reads < 3
            ? record({ status: 'stopped', browser_proxy: PROXY })
            : record({ browser_proxy: PROXY, browser_proxy_pending: false }),
      ),
    );
    const { code, err } = await h.run([
      'computers',
      'browser-proxy',
      'set',
      ID,
      PROXY.server,
      '--no-credentials',
      '--wait',
    ]);
    expect(code).toBe(0);
    expect(err).not.toContain('applied as it starts');
    expect(reads).toBeGreaterThanOrEqual(3);
  });

  it('clear --wait follows a stopped computer of unknown start through to applied', async () => {
    let reads = 0;
    const h = harness(
      computers((call) => {
        if (call.method === 'PATCH') return record({ status: 'stopped' });
        reads++;
        if (reads < 2) return record({ status: 'stopped' });
        return record({ browser_proxy_pending: reads < 4 });
      }),
    );
    const { code } = await h.run(['computers', 'browser-proxy', 'clear', ID, '--wait']);
    expect(code).toBe(0);
    expect(reads).toBeGreaterThanOrEqual(4);
  });

  it('--wait applies the stopped rule after a failed read too', async () => {
    let reads = 0;
    const h = harness((call) => {
      if (call.path !== `/computers/${ID}`) return anyRoute(call);
      if (call.method === 'PATCH') return json(record({ browser_proxy: PROXY }));
      if (++reads === 2) return json({ error: 'try again' }, { status: 503 });
      return json(record({ status: 'stopped', running_ram_mb: 0, browser_proxy: PROXY }));
    });
    const { code, err } = await h.run([
      'computers',
      'browser-proxy',
      'set',
      ID,
      PROXY.server,
      '--no-credentials',
      '--wait',
    ]);
    expect(code).toBe(0);
    expect(err).toContain('applied as it starts');
  });

  it.each([
    ['admitted', { running_ram_mb: 4096 }],
    ['unknown', {}],
  ])('--wait times out on a stopped computer whose start is %s', async (_what, ram) => {
    const start = Date.now();
    let ticks = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => start + 60_000 * ticks++);
    try {
      const h = harness(computers(() => record({ status: 'stopped', ...ram })));
      const { code, err } = await h.run(['computers', 'browser-proxy', 'clear', ID, '--wait']);
      expect(code).not.toBe(0);
      expect(err).not.toContain('applied as it starts');
      expect(err).toContain('last read stopped');
    } finally {
      clock.mockRestore();
    }
  });

  it.each([
    ['set', { running_ram_mb: 0 }, 'applied as it starts'],
    ['clear', { running_ram_mb: 0 }, 'applied as it starts'],
  ])('%s --wait reports a computer suspended part-way as stored', async (verb, ram, said) => {
    let reads = 0;
    const set = verb === 'set' ? { browser_proxy: PROXY } : {};
    const h = harness(
      computers((call) =>
        call.method === 'PATCH' || ++reads < 2
          ? record({ ...set, browser_proxy_pending: true })
          : record({ ...set, status: 'suspended', ...ram }),
      ),
    );
    const args = verb === 'set' ? ['set', ID, PROXY.server, '--no-credentials'] : ['clear', ID];
    const { code, err } = await h.run(['computers', 'browser-proxy', ...args, '--wait']);
    expect(code).toBe(0);
    expect(err).toContain(said);
  });

  it('--wait hands a computer still building to the SDK wait', async () => {
    let reads = 0;
    const h = harness(
      computers((call) =>
        call.method === 'PATCH' || ++reads < 2
          ? record({ status: 'starting', browser_proxy: PROXY, browser_proxy_pending: true })
          : record({ browser_proxy: PROXY, browser_proxy_pending: false }),
      ),
    );
    const { code } = await h.run([
      'computers',
      'browser-proxy',
      'set',
      ID,
      PROXY.server,
      '--no-credentials',
      '--wait',
    ]);
    expect(code).toBe(0);
  });

  it('--wait waits as long as a 429 asks', async () => {
    const at: number[] = [];
    let patched = false;
    const h = harness((call) => {
      if (call.path !== `/computers/${ID}`) return anyRoute(call);
      if (call.method === 'PATCH') {
        patched = true;
        return json(record());
      }
      if (!patched) return json(record());
      at.push(Date.now());
      return at.length === 1
        ? json({ error: 'slow down' }, { status: 429, headers: { 'Retry-After': '1' } })
        : json(record());
    });
    const { code } = await h.run(['computers', 'browser-proxy', 'clear', ID, '--wait']);
    expect(code).toBe(0);
    expect((at[1] ?? 0) - (at[0] ?? 0)).toBeGreaterThanOrEqual(2000);
  });

  it('--wait sends no read past its deadline', async () => {
    const start = Date.now();
    let ticks = 0;
    let reads = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => start + 60_000 * ticks++);
    try {
      const h = harness(
        computers((call) => {
          if (call.method === 'GET') reads++;
          return record({ status: 'stopped' });
        }),
      );
      const { code } = await h.run(['computers', 'browser-proxy', 'clear', ID, '--wait']);
      expect(code).not.toBe(0);
      expect(reads).toBeLessThanOrEqual(4);
    } finally {
      clock.mockRestore();
    }
  });

  it('--wait rides out a transient failure of its first read', async () => {
    let reads = 0;
    const h = harness((call) => {
      if (call.path !== `/computers/${ID}`) return anyRoute(call);
      if (call.method === 'PATCH') return json(record({ browser_proxy: PROXY }));
      if (++reads === 2) return json({ error: 'try again' }, { status: 503 });
      return json(record({ browser_proxy: PROXY, browser_proxy_pending: false }));
    });
    const { code } = await h.run([
      'computers',
      'browser-proxy',
      'set',
      ID,
      PROXY.server,
      '--no-credentials',
      '--wait',
    ]);
    expect(code).toBe(0);
    expect(reads).toBeGreaterThanOrEqual(3);
  });

  it('without --wait, browser-proxy set does not wait', async () => {
    let reads = 0;
    const h = harness(
      computers((call) => {
        if (call.method === 'GET') reads++;
        return record({ browser_proxy: PROXY, browser_proxy_pending: true });
      }),
    );
    const { code } = await h.run([
      'computers',
      'browser-proxy',
      'set',
      ID,
      PROXY.server,
      '--no-credentials',
    ]);
    expect(code).toBe(0);
    expect(reads).toBeLessThanOrEqual(1);
  });

  it('scp --upload-id resumes that upload', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mandala-scp-'));
    const path = join(dir, 'a.bin');
    writeFileSync(path, 'data');
    const UPLOAD = '0123456789abcdef0123456789abcdef';
    const h = harness((call) =>
      call.path === `/computers/${ID}/files/uploads`
        ? json({ path: '/tmp/a.bin', upload_id: UPLOAD, offset: 4, size: 4, complete: true })
        : call.path === `/computers/${ID}`
          ? json(record())
          : anyRoute(call),
    );
    const { code } = await h.run(['scp', '--upload-id', UPLOAD, path, `${ID}:/tmp/a.bin`]);
    expect(code).toBe(0);
    expect(h.rec.calls.some((c) => c.path.endsWith('/files/uploads'))).toBe(true);
  });

  it('refuses scp --upload-id on a download before any request', async () => {
    const h = harness(anyRoute);
    const { code } = await h.run([
      'scp',
      '--upload-id',
      '0123456789abcdef0123456789abcdef',
      `${ID}:/tmp/a.bin`,
      '/tmp/out.bin',
    ]);
    expect(code).not.toBe(0);
    expect(h.rec.calls.length).toBe(0);
  });

  it('screenshot refuses --capture beside --fresh', async () => {
    const h = harness(anyRoute);
    const { code } = await h.run([
      'computers',
      'screenshot',
      ID,
      '-o',
      '/tmp/x.png',
      '--fresh',
      '--capture',
      '0123456789abcdef',
    ]);
    expect(code).toBe(2);
  });

  it('terminal names the key when a key that expires has no terminal', async () => {
    const h = harness((call) =>
      call.path === '/whoami'
        ? json({ ...WHOAMI, key: { ...API_KEY, expires_at: '2030-01-01T00:00:00Z' } })
        : call.path === `/computers/${ID}`
          ? json({ ...BARE, id: ID })
          : anyRoute(call),
    );
    const { code, err } = await h.run(['terminal', ID]);
    expect(code).not.toBe(0);
    expect(err).toMatch(/key that expires/);
  });
});
