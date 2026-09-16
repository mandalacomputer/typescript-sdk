import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AuthenticationError,
  Client,
  Computer,
  MandalaError,
  TimeoutError,
  ValidationError,
} from '../src/index.js';
import { BASE, json, recorder } from './harness.js';

const computer = (status = 'running', held = 1024) => ({
  id: 'launch-42',
  status,
  running_ram_mb: held,
});
const guest = { exit_code: 0, stdout_b64: '', stderr_b64: '' };

afterEach(() => vi.restoreAllMocks());

describe('computers.launch', () => {
  it('creates once and returns a refreshed running computer after a guest probe', async () => {
    const rec = recorder((call) =>
      json(call.path.endsWith('/exec') ? guest : { ...computer(), name: call.method }),
    );
    const client = new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch });
    const c = await client.computers.launch({ size: 'large' });
    expect(c.id).toBe('launch-42');
    expect(c.name).toBe('GET');
    expect(rec.routes()).toEqual([
      ['POST', 'computers'],
      ['GET', 'computers/launch-42'],
      ['POST', 'computers/launch-42/exec'],
    ]);
    expect(rec.calls[0]!.body).toEqual({ size: 'large', start: true });
    expect(rec.last().body).toMatchObject({ command: 'exit 0' });
  });
});

describe('launch lifecycle and budget', () => {
  it('finishes building, starts once, and shares the remaining budget including start work', async () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const built = vi.spyOn(Computer.prototype, 'waitUntilBuilt');
    const running = vi.spyOn(Computer.prototype, 'waitUntilRunning');
    const ready = vi.spyOn(Computer.prototype, 'waitForGuest');
    const responses = [
      computer('building', 0),
      computer('stopped', 0),
      { ok: true },
      computer('stopped', 2048),
      { ...computer(), name: 'ready' },
      guest,
    ];
    const rec = recorder(() => {
      const i = rec.calls.length - 1;
      now = [10_000, 10_060, 10_080, 10_080, 10_090, 10_090][i]!;
      return json(responses[i]);
    });
    const client = new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch });
    const args = {
      name: 'example',
      template: 'base',
      templateTransfer: ' opaque-token ',
      cpu: 2,
      ramMb: 4096,
      diskGb: 40,
      resolution: '1920x1080',
      start: false,
    };
    const c = await client.computers.launch(args, { timeoutMs: 100, pollMs: 1 });
    expect(c.id).toBe('launch-42');
    expect(c.name).toBe('ready');
    expect(rec.routes()).toEqual([
      ['POST', 'computers'],
      ['GET', 'computers/launch-42'],
      ['POST', 'computers/launch-42/start'],
      ['GET', 'computers/launch-42'],
      ['GET', 'computers/launch-42'],
      ['POST', 'computers/launch-42/exec'],
    ]);
    expect(rec.calls[0]!.body).toEqual({
      name: 'example',
      template: 'base',
      template_transfer: ' opaque-token ',
      cpu: 2,
      ram_mb: 4096,
      disk_gb: 40,
      resolution: '1920x1080',
      start: false,
    });
    expect(built.mock.calls[0]![0]!.timeoutMs).toBe(100);
    expect(running.mock.calls[0]![0]!.timeoutMs).toBe(20);
    expect(ready.mock.calls[0]![0]!.timeoutMs).toBe(10);
  });

  it.each(['stopped', 'suspended'])(
    'waits for an admitted %s start without starting twice',
    async (status) => {
      const rec = recorder((call) =>
        json(
          rec.calls.length === 1
            ? computer(status, 2048)
            : call.path.endsWith('/exec')
              ? guest
              : computer(),
        ),
      );
      const client = new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch });
      await client.computers.launch();
      expect(rec.routes()).toEqual([
        ['POST', 'computers'],
        ['GET', 'computers/launch-42'],
        ['POST', 'computers/launch-42/exec'],
      ]);
    },
  );

  it.each(['stopped', 'suspended'])('starts a %s computer with no reservation', async (status) => {
    const rec = recorder((call) =>
      json(
        rec.calls.length === 1
          ? computer(status, 0)
          : call.path.endsWith('/exec')
            ? guest
            : computer(),
      ),
    );
    const client = new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch });
    await client.computers.launch();
    expect(rec.routes()).toEqual([
      ['POST', 'computers'],
      ['POST', 'computers/launch-42/start'],
      ['GET', 'computers/launch-42'],
      ['POST', 'computers/launch-42/exec'],
    ]);
  });

  it('does not interpret missing reservation data as permission to start again', async () => {
    const rec = recorder((call) =>
      json(
        rec.calls.length === 1
          ? { id: 'launch-42', status: 'stopped' }
          : call.path.endsWith('/exec')
            ? guest
            : computer(),
      ),
    );
    const client = new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch });
    await client.computers.launch();
    expect(rec.calls.filter((c) => c.path.endsWith('/start'))).toHaveLength(0);
  });

  it.each([NaN, Infinity, -1, 2_147_483_648])(
    'rejects timeout %s before creation',
    async (timeoutMs) => {
      const rec = recorder(() => json(computer()));
      const client = new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch });
      await expect(client.computers.launch({}, { timeoutMs })).rejects.toBeInstanceOf(
        ValidationError,
      );
      expect(rec.calls).toHaveLength(0);
    },
  );

  it.each([NaN, Infinity, -1, 0])('rejects poll interval %s before creation', async (pollMs) => {
    const rec = recorder(() => json(computer()));
    const client = new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch });
    await expect(client.computers.launch({}, { pollMs })).rejects.toBeInstanceOf(ValidationError);
    expect(rec.calls).toHaveLength(0);
  });

  it('preserves a typed guest timeout with the created id and leaves the computer intact', async () => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const rec = recorder((call) => {
      if (call.path.endsWith('/exec')) {
        now = 100;
        return json({ error: 'guest booting' }, { status: 503 });
      }
      return json(computer());
    });
    const client = new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch });
    const error = await client.computers.launch({}, { timeoutMs: 100 }).catch((e) => e);
    expect(error).toBeInstanceOf(TimeoutError);
    expect(error.message).toContain('launch-42');
    expect(error.message).toContain('guest did not respond');
    expect(rec.routes()).toEqual([
      ['POST', 'computers'],
      ['GET', 'computers/launch-42'],
      ['POST', 'computers/launch-42/exec'],
    ]);
  });

  it.each(['build', 'start'])(
    'does not dispatch another stage after %s spends the budget',
    async (stage) => {
      let now = 0;
      vi.spyOn(performance, 'now').mockImplementation(() => now);
      const rec = recorder(() => {
        if (rec.calls.length === 1)
          return json(computer(stage === 'build' ? 'building' : 'stopped', 0));
        now = 100;
        return json(computer(stage === 'build' ? 'stopped' : 'running', 0));
      });
      const client = new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch });
      const error = await client.computers.launch({}, { timeoutMs: 100 }).catch((e) => e);
      expect(error).toBeInstanceOf(TimeoutError);
      expect(error.message).toContain('launch-42');
      expect(rec.calls).toHaveLength(2);
    },
  );

  it.each([
    { ...computer('build-failed', 0), build_error: 'disk copy failed' },
    { ...computer('stopped', 0), start_error: 'boot refused' },
  ])('reports a failed create stage without retrying it: %j', async (result) => {
    const rec = recorder(() => json(result));
    const client = new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch });
    const error = await client.computers.launch().catch((e) => e);
    expect(error).toBeInstanceOf(MandalaError);
    expect(error).not.toBeInstanceOf(TimeoutError);
    expect(error.message).toContain('launch-42');
    expect(error.message).toContain('build_error' in result ? 'disk copy failed' : 'boot refused');
    expect(rec.calls).toHaveLength(1);
  });

  it.each(['create', 'start', 'running', 'guest'])(
    'preserves a permanent %s refusal',
    async (stage) => {
      const rec = recorder((call) => {
        const refuse =
          stage === 'create' ||
          (stage === 'start' && call.path.endsWith('/start')) ||
          (stage === 'running' && call.method === 'GET') ||
          (stage === 'guest' && call.path.endsWith('/exec'));
        if (refuse) return json({ error: 'key revoked' }, { status: 401 });
        return json(
          computer(stage === 'start' ? 'stopped' : 'running', stage === 'start' ? 0 : 1024),
        );
      });
      const client = new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch });
      const error = await client.computers.launch().catch((e) => e);
      expect(error).toBeInstanceOf(AuthenticationError);
      expect(error.body).toEqual({ error: 'key revoked' });
      expect(error.status).toBe(401);
      if (stage !== 'create') expect(error.message).toContain('launch-42');
      expect(rec.calls.filter((c) => c.method === 'POST' && c.path === '/computers')).toHaveLength(
        1,
      );
      expect(rec.calls.some((c) => c.method === 'DELETE')).toBe(false);
    },
  );
});

describe('launch cancellation', () => {
  it('rejects a pre-aborted signal before creating', async () => {
    const reason = new Error('cancelled');
    const rec = recorder(() => json(computer()));
    const client = new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch });
    await expect(client.computers.launch({}, { signal: AbortSignal.abort(reason) })).rejects.toBe(
      reason,
    );
    expect(rec.calls).toHaveLength(0);
  });

  it.each(['create', 'build', 'start', 'running', 'guest'])(
    'stops during %s with the original reason',
    async (stage) => {
      const controller = new AbortController();
      const reason = new MandalaError('cancelled by caller');
      const rec = recorder((call) => {
        const cancel =
          stage === 'create' ||
          ((stage === 'build' || stage === 'running') && call.method === 'GET') ||
          (stage === 'start' && call.path.endsWith('/start')) ||
          (stage === 'guest' && call.path.endsWith('/exec'));
        if (cancel) {
          queueMicrotask(() => controller.abort(reason));
          return new Promise<Response>(() => {});
        }
        return json(
          computer(
            stage === 'build' ? 'building' : stage === 'start' ? 'stopped' : 'running',
            stage === 'start' ? 0 : 1024,
          ),
        );
      });
      const client = new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch });
      await expect(client.computers.launch({}, { signal: controller.signal })).rejects.toBe(reason);
      expect(reason.message).toBe('cancelled by caller');
      const count = rec.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(rec.calls).toHaveLength(count);
      expect(rec.calls.some((c) => c.method === 'DELETE')).toBe(false);
    },
  );

  it('cancels a poll sleep before any later stage', async () => {
    const controller = new AbortController();
    const rec = recorder(() => {
      if (rec.calls.length === 2) setTimeout(() => controller.abort(), 0);
      return json(computer('building', 0));
    });
    const client = new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch });
    await expect(
      client.computers.launch({}, { signal: controller.signal, pollMs: 100 }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(rec.calls).toHaveLength(2);
  });
});

it('keeps the created id when a zero readiness budget leaves no time to start', async () => {
  const rec = recorder(() => json(computer('stopped', 0)));
  const client = new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch });
  const error = await client.computers.launch({}, { timeoutMs: 0 }).catch((e) => e);
  expect(error).toBeInstanceOf(TimeoutError);
  expect(error.message).toContain('launch-42');
  expect(rec.routes()).toEqual([['POST', 'computers']]);
});

it('starts an explicitly deferred create even when the response omits reservation data', async () => {
  const rec = recorder((call) =>
    json(
      rec.calls.length === 1
        ? { id: 'launch-42', status: 'stopped' }
        : call.path.endsWith('/exec')
          ? guest
          : computer(),
    ),
  );
  const client = new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch });
  await client.computers.launch({ start: false });
  expect(rec.calls[0]!.body).toEqual({ start: false });
  expect(rec.routes()).toEqual([
    ['POST', 'computers'],
    ['POST', 'computers/launch-42/start'],
    ['GET', 'computers/launch-42'],
    ['POST', 'computers/launch-42/exec'],
  ]);
});
