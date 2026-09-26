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

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

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
    expect(built.mock.calls[0]![0]!.timeoutMs).toBe(40);
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
  it.each([undefined, new Error('cancelled'), new MandalaError('cancelled'), 'cancelled'])(
    'preserves reason %s when an acknowledged start is cancelled during its refresh',
    async (reason) => {
      const controller = new AbortController();
      const rec = recorder((call) => {
        if (call.path === '/computers') return json(computer('stopped', 0));
        if (call.path.endsWith('/start')) return json({ ok: true });
        queueMicrotask(() => controller.abort(reason));
        return new Promise<Response>(() => {});
      });
      const client = new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch });
      const error = await client.computers
        .launch({}, { signal: controller.signal })
        .catch((err) => err);
      expect(controller.signal.aborted).toBe(true);
      expect(error).toBe(controller.signal.reason);
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(rec.routes()).toEqual([
        ['POST', 'computers'],
        ['POST', 'computers/launch-42/start'],
        ['GET', 'computers/launch-42'],
      ]);
    },
  );

  it('preserves an acknowledged start refresh failure when the caller did not cancel', async () => {
    const rec = recorder((call) => {
      if (call.path === '/computers') return json(computer('stopped', 0));
      if (call.path.endsWith('/start')) return json({ ok: true });
      return json({ error: 'key revoked' }, { status: 401 });
    });
    const client = new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch });
    const error = await client.computers.launch().catch((err) => err);
    expect(error).toBeInstanceOf(MandalaError);
    expect(error).not.toBeInstanceOf(TimeoutError);
    expect(error.message).toContain('launch-42');
    expect(error.cause).toBeInstanceOf(AuthenticationError);
    expect(error.cause.body).toEqual({ error: 'key revoked' });
    expect(rec.routes()).toEqual([
      ['POST', 'computers'],
      ['POST', 'computers/launch-42/start'],
      ['GET', 'computers/launch-42'],
    ]);
  });

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

it.each([true, false])(
  'does not replay a start admitted during disk preparation (initial: %s)',
  async (initial) => {
    let reads = 0;
    let replayed = false;
    const rec = recorder((call) => {
      if (call.path === '/computers') return json(computer('building', initial ? 2048 : 0));
      if (call.path.endsWith('/start')) {
        replayed = true;
        return json(computer());
      }
      if (call.path.endsWith('/exec')) return json(guest);
      reads += 1;
      if (!initial && reads === 1) return json(computer('building', 2048));
      return json(replayed ? computer() : computer('stopped', 0));
    });
    const client = new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch });
    const result = client.computers.launch({}, { pollMs: 1 });
    await expect(result).rejects.toBeInstanceOf(MandalaError);
    await expect(result).rejects.toThrow('launch-42');
    expect(replayed).toBe(false);
    expect(rec.calls.some((call) => call.path.endsWith('/exec') || call.method === 'DELETE')).toBe(
      false,
    );
  },
);

it.each([undefined, '', ['stopped'], 'unrecognized'])(
  'waits on unreadable or unknown build status %j without entering another stage',
  async (status) => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const rec = recorder(() => {
      if (rec.calls.length === 2) now = 100;
      return json({ ...computer('building', 0), status });
    });
    const client = new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch });
    const error = await client.computers.launch({}, { timeoutMs: 100 }).catch((err) => err);
    expect(error).toBeInstanceOf(TimeoutError);
    expect(error.message).toContain('launch-42');
    expect(error.message).not.toContain('still building');
    expect(rec.routes()).toEqual([
      ['POST', 'computers'],
      ['GET', 'computers/launch-42'],
    ]);
  },
);

it('preserves a permanent build refresh refusal even when its response spends the budget', async () => {
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const rec = recorder(() => {
    if (rec.calls.length === 1) return json(computer('building', 0));
    now = 100;
    return json({ error: 'key revoked' }, { status: 401 });
  });
  const client = new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch });
  const error = await client.computers.launch({}, { timeoutMs: 100 }).catch((err) => err);
  expect(error).toBeInstanceOf(AuthenticationError);
  expect(error.message).toContain('launch-42');
  expect(rec.calls).toHaveLength(2);
});

it('does not describe a stale build row as current after a transient refresh spends the budget', async () => {
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const rec = recorder(() => {
    if (rec.calls.length === 1) return json(computer('building', 0));
    now = 100;
    return json({ error: 'temporarily unavailable' }, { status: 503 });
  });
  const client = new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch });
  const error = await client.computers.launch({}, { timeoutMs: 100 }).catch((err) => err);
  expect(error).toBeInstanceOf(TimeoutError);
  expect(error.message).toContain('launch-42');
  expect(error.message).not.toContain('still building');
  expect(rec.calls).toHaveLength(2);
});

it('honours Retry-After and transient build reads before starting an unreserved computer once', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] });
  let reads = 0;
  const rec = recorder((call) => {
    if (call.path === '/computers') return json(computer('building', 0));
    if (call.path.endsWith('/exec')) return json(guest);
    if (call.path.endsWith('/start')) return json(computer());
    reads += 1;
    if (reads === 1)
      return json({ error: 'rate limited' }, { status: 429, headers: { 'Retry-After': '1' } });
    if (reads === 2) return json({ error: 'busy' }, { status: 503 });
    return json(reads === 3 ? computer('stopped', 0) : computer());
  });
  const client = new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch });
  const result = client.computers.launch({ start: false }, { timeoutMs: 2000, pollMs: 10 });
  await vi.advanceTimersByTimeAsync(0);
  expect(rec.calls).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(999);
  expect(rec.calls).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(rec.calls).toHaveLength(3);
  await vi.advanceTimersByTimeAsync(9);
  expect(rec.calls).toHaveLength(3);
  await vi.advanceTimersByTimeAsync(1);
  expect((await result).id).toBe('launch-42');
  expect(rec.calls.filter((call) => call.path.endsWith('/start'))).toHaveLength(1);
  expect(rec.calls[0]!.body).toEqual({ start: false });
});

// --- secrets (OPL-5048) -----------------------------------------------------

const BINDING = { secret_id: 'csec-0123456789abcdef', revision_id: 'csr-1', env: 'TOKEN' };
const RECEIPT = { generation: 1, applied_at: '2026-09-25T00:00:00Z', revisions: {} };
const bound = (delivering: boolean | undefined, extra: Record<string, unknown> = {}) => ({
  ...computer(),
  secrets: [BINDING],
  secrets_generation: 1,
  ...(delivering === undefined ? {} : { secrets_delivering: delivering }),
  ...extra,
});

describe('launch with secrets bound', () => {
  it('waits for the secrets to land before returning, sharing the budget', async () => {
    const waited = vi.spyOn(Computer.prototype, 'waitForSecrets');
    let gets = 0;
    const rec = recorder((call) => {
      if (call.path.endsWith('/exec')) return json(guest);
      if (call.method === 'POST') return json(bound(true), { status: 201 });
      gets++;
      return json(gets < 3 ? bound(true) : bound(false, { secrets_applied: RECEIPT }));
    });
    const client = new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch });
    const c = await client.computers.launch(
      { secrets: [{ secretId: BINDING.secret_id, env: 'TOKEN' }] },
      { pollMs: 1 },
    );
    expect(c.secretsDelivering).toBe(false);
    expect(rec.routes()).toEqual([
      ['POST', 'computers'],
      ['GET', 'computers/launch-42'],
      ['POST', 'computers/launch-42/exec'],
      ['GET', 'computers/launch-42'],
      ['GET', 'computers/launch-42'],
    ]);
    expect(rec.calls[0]!.body).toMatchObject({ start: true, secrets: [{ env: 'TOKEN' }] });
    expect(waited).toHaveBeenCalledOnce();
    expect(waited.mock.calls[0]![0]!.timeoutMs).toBeLessThanOrEqual(180_000);
  });

  it('waits on a binding the record reports even when the create named none', async () => {
    let gets = 0;
    const rec = recorder((call) => {
      if (call.path.endsWith('/exec')) return json(guest);
      if (call.method === 'POST') return json(bound(true), { status: 201 });
      gets++;
      return json(gets < 3 ? bound(true) : bound(false));
    });
    const client = new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch });
    await client.computers.launch({}, { pollMs: 1 });
    expect(rec.calls.filter((c) => c.method === 'GET')).toHaveLength(3);
  });

  it('throws, naming why and the computer, when the delivery failed', async () => {
    const rec = recorder((call) => {
      if (call.path.endsWith('/exec')) return json(guest);
      if (call.method === 'POST') return json(bound(true), { status: 201 });
      if (rec.calls.filter((c) => c.method === 'GET').length === 1) return json(bound(true));
      return json({
        ...bound(false, { secrets_error: 'a secret could not be read' }),
        status: 'stopped',
        running_ram_mb: 0,
      });
    });
    const client = new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch });
    const error = await client.computers.launch({}, { pollMs: 1 }).catch((e) => e);
    expect(error).toBeInstanceOf(MandalaError);
    expect(error).not.toBeInstanceOf(TimeoutError);
    expect(error.message).toBe(
      "launch of launch-42 failed: launch-42's secrets were not delivered: a secret could not " +
        'be read. The platform stopped it; call start() to try again',
    );
    expect(rec.calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('does not take a read that leaves the bindings out for "nothing bound"', async () => {
    // The group is absent on a computer that holds none, and also on a record
    // served without its host's answer. Launch knows what it bound.
    let gets = 0;
    const { secrets: _left, ...unreported } = bound(false);
    const rec = recorder((call) => {
      if (call.path.endsWith('/exec')) return json(guest);
      if (call.method === 'POST') return json(bound(true), { status: 201 });
      gets++;
      if (gets === 1) return json(bound(true));
      return json(gets < 4 ? unreported : bound(false, { secrets_applied: RECEIPT }));
    });
    const client = new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch });
    const c = await client.computers.launch(
      { secrets: [{ secretId: BINDING.secret_id, env: 'TOKEN' }] },
      { pollMs: 1 },
    );
    expect(gets).toBe(4);
    expect(c.secretsApplied?.generation).toBe(1);
  });

  it('times out saying the bindings went unreported, not that they were delivered', async () => {
    const { secrets: _left, ...unreported } = bound(false);
    const rec = recorder((call) => {
      if (call.path.endsWith('/exec')) return json(guest);
      if (call.method === 'POST') return json(bound(true), { status: 201 });
      return json(
        rec.calls.filter((c) => c.method === 'GET').length === 1 ? bound(true) : unreported,
      );
    });
    const client = new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch });
    const c = await client.computers.get('launch-42');
    const error = await c
      .waitForSecrets({ timeoutMs: 20, pollMs: 1, expectSecrets: true })
      .catch((e) => e);
    expect(error).toBeInstanceOf(TimeoutError);
    expect(error.message).toBe(
      'launch-42 was read for 20ms without reporting its bindings, so whether its secrets ' +
        'arrived is unknown',
    );
    // Without being told, the same read is the platform saying nothing is bound.
    await expect(c.waitForSecrets({ pollMs: 1 })).resolves.toBe(c);
  });

  it('adds no request for a computer with nothing bound', async () => {
    const waited = vi.spyOn(Computer.prototype, 'waitForSecrets');
    const rec = recorder((call) => json(call.path.endsWith('/exec') ? guest : computer()));
    const client = new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch });
    await client.computers.launch();
    expect(waited).not.toHaveBeenCalled();
    expect(rec.calls).toHaveLength(3);
  });
});

describe('waitForSecrets', () => {
  const handle = (respond: (n: number) => unknown) => {
    let n = 0;
    const rec = recorder(() => json(respond(++n)));
    const client = new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch });
    return { rec, get: () => client.computers.get('launch-42') };
  };

  it('reads again before answering, even when the handle already says delivered', async () => {
    const { rec, get } = handle((n) => (n === 1 ? bound(false) : bound(true)));
    const c = await get();
    const error = await c.waitForSecrets({ timeoutMs: 5, pollMs: 1 }).catch((e) => e);
    expect(error).toBeInstanceOf(TimeoutError);
    expect(error.message).toBe("launch-42's secrets were still being delivered after 5ms");
    expect(rec.calls.length).toBeGreaterThan(1);
  });

  it('answers at once for a computer with nothing bound', async () => {
    const { rec, get } = handle(() => computer());
    const c = await get();
    await c.waitForSecrets();
    expect(rec.calls).toHaveLength(2);
  });

  it('refuses a stopped computer with no start under way, rather than waiting', async () => {
    const { get } = handle(() => ({ ...bound(false), status: 'stopped', running_ram_mb: 0 }));
    const c = await get();
    await expect(c.waitForSecrets()).rejects.toThrow(
      'launch-42 is "stopped", and secrets are delivered only as it starts: call start()',
    );
  });

  it('waits through a start that is admitted but not yet booted', async () => {
    const { get } = handle((n) =>
      n <= 2 ? { ...bound(false), status: 'stopped', running_ram_mb: 1024 } : bound(false),
    );
    const c = await get();
    await c.waitForSecrets({ pollMs: 1 });
    expect(c.status).toBe('running');
  });

  it('waits, rather than refusing, when the host does not say whether a start is admitted', async () => {
    // running_ram_mb absent is "cannot tell", not zero: the same three states
    // waitUntilRunning reads, so a start under way on such a host is waited on.
    const { get } = handle((n) => {
      if (n > 2) return bound(false);
      const { running_ram_mb: _held, ...silent } = { ...bound(false), status: 'stopped' };
      return silent;
    });
    const c = await get();
    await c.waitForSecrets({ pollMs: 1 });
    expect(c.status).toBe('running');
  });

  it('refuses a stopped computer with nothing admitted even when the bindings are left out', async () => {
    // expectSecrets waits past a read that omits the bindings, but not one
    // that says outright nothing is starting: that is an answer whatever is
    // bound. The long timeout is the test.
    const { secrets: _left, ...unreported } = { ...bound(false), status: 'stopped' };
    const { get } = handle(() => ({ ...unreported, running_ram_mb: 0 }));
    const c = await get();
    const started = Date.now();
    const error = await c
      .waitForSecrets({ timeoutMs: 60_000, pollMs: 1, expectSecrets: true })
      .catch((e) => e);
    expect(error).toBeInstanceOf(MandalaError);
    expect(error).not.toBeInstanceOf(TimeoutError);
    expect(error.message).toBe(
      'launch-42 is "stopped", and secrets are delivered only as it starts: call start()',
    );
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('still waits past omitted bindings when the host does not say whether a start is admitted', async () => {
    const {
      secrets: _left,
      running_ram_mb: _held,
      ...silent
    } = {
      ...bound(false),
      status: 'stopped',
    };
    const { get } = handle(() => silent);
    const c = await get();
    const error = await c
      .waitForSecrets({ timeoutMs: 20, pollMs: 1, expectSecrets: true })
      .catch((e) => e);
    expect(error).toBeInstanceOf(TimeoutError);
    expect(error.message).toContain('without reporting its bindings');
  });

  describe("a create's failed start", () => {
    // The create's answer is the one response carrying start_error, and it
    // does not report the pool; every read after it has neither.
    const created = (reads: (n: number) => unknown) => {
      let gets = 0;
      const rec = recorder((call) => {
        if (call.method === 'POST') {
          const { running_ram_mb: _held, ...stopped } = { ...bound(false), status: 'stopped' };
          return json({ computer: stopped, start_error: 'no host had room' }, { status: 201 });
        }
        return json(reads(++gets));
      });
      const client = new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch });
      return client.computers.create({ secrets: [{ secretId: BINDING.secret_id, env: 'TOKEN' }] });
    };
    const silentStopped = (extra: Record<string, unknown> = {}) => {
      const { running_ram_mb: _held, ...stopped } = { ...bound(false), status: 'stopped' };
      return { ...stopped, ...extra };
    };

    it('is refused with its reason rather than waited on to the timeout', async () => {
      const c = await created(() => silentStopped());
      expect(c.startError).toBe('no host had room');
      const started = Date.now();
      const error = await c.waitForSecrets({ timeoutMs: 60_000, pollMs: 1 }).catch((e) => e);
      expect(error).toBeInstanceOf(MandalaError);
      expect(error).not.toBeInstanceOf(TimeoutError);
      expect(error.message).toBe(
        'launch-42 is stopped after it failed to start, so its secrets were not delivered: ' +
          'no host had room. Call start() to try again',
      );
      expect(Date.now() - started).toBeLessThan(1_000);
    });

    it('is refused when the reads leave the bindings out too', async () => {
      const { secrets: _left, ...unreported } = silentStopped();
      const c = await created(() => unreported);
      const error = await c
        .waitForSecrets({ timeoutMs: 60_000, pollMs: 1, expectSecrets: true })
        .catch((e) => e);
      expect(error).not.toBeInstanceOf(TimeoutError);
      expect(error.message).toContain('no host had room');
    });

    it('is retired by a start somebody made since', async () => {
      // A reservation, then a read that does not report the pool: the old
      // failure belongs to an earlier attempt and must not refuse this one.
      const c = await created((n) => {
        if (n === 1) return silentStopped({ running_ram_mb: 1024 });
        if (n === 2) return silentStopped();
        return bound(false);
      });
      await expect(c.waitForSecrets({ timeoutMs: 60_000, pollMs: 1 })).resolves.toBe(c);
      expect(c.status).toBe('running');
    });
  });

  it('waits after restart() until the redelivered secrets are applied', async () => {
    // A restart comes back running before its secrets are delivered again;
    // secrets_delivering reads true until they are.
    let gets = 0;
    const rec = recorder((call) => {
      if (call.path.endsWith('/restart')) return json(bound(true));
      gets++;
      if (gets === 1) return json(bound(false, { secrets_applied: RECEIPT }));
      return json(gets < 5 ? bound(true) : bound(false, { secrets_applied: RECEIPT }));
    });
    const client = new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch });
    const c = await client.computers.get('launch-42');
    await c.restart();
    await c.waitForSecrets({ pollMs: 1 });
    expect(gets).toBe(5);
    expect(c.secretsDelivering).toBe(false);
    expect(rec.routes().filter(([m]) => m === 'POST')).toEqual([
      ['POST', 'computers/launch-42/restart'],
    ]);
  });

  it('returns at once after restart() on a platform that does not report the redelivery', async () => {
    // What restart()'s documentation says of such a platform: delivering
    // reads false from the restart's own answer, with the old receipt still
    // current, so the wait has nothing to wait on and must not invent it.
    let gets = 0;
    const rec = recorder((call) => {
      if (call.path.endsWith('/restart')) return json(bound(false, { secrets_applied: RECEIPT }));
      gets++;
      return json(bound(false, { secrets_applied: RECEIPT }));
    });
    const client = new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch });
    const c = await client.computers.get('launch-42');
    await c.restart();
    expect(c.secretsDelivering).toBe(false);
    await c.waitForSecrets({ timeoutMs: 60_000, pollMs: 1 });
    expect(gets).toBe(2);
  });

  it('reads the receipt on a platform that predates secrets_delivering', async () => {
    const { rec, get } = handle((n) =>
      n <= 2 ? bound(undefined) : bound(undefined, { secrets_applied: RECEIPT }),
    );
    const c = await get();
    await c.waitForSecrets({ pollMs: 1 });
    expect(rec.calls).toHaveLength(3);
    expect(c.secretsDelivering).toBeUndefined();
  });

  it('rides out a host that cannot be reached', async () => {
    let n = 0;
    const rec = recorder(() => {
      n++;
      if (n === 2) return json({ error: 'host unreachable' }, { status: 503 });
      return json(n === 1 ? bound(true) : bound(false));
    });
    const client = new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch });
    const c = await client.computers.get('launch-42');
    await c.waitForSecrets({ pollMs: 1 });
    expect(rec.calls).toHaveLength(3);
  });
});

// --- browser proxy (OPL-5144) -----------------------------------------------

const PROXY = { server: 'http://proxy.example.com:3128', bypass: ['<local>'] };
const proxied = (pending: boolean | undefined, extra: Record<string, unknown> = {}) => ({
  ...computer(),
  browser_proxy: PROXY,
  ...(pending === undefined ? {} : { browser_proxy_pending: pending }),
  ...extra,
});

describe('waitForBrowserProxy', () => {
  const handle = (respond: (n: number) => unknown) => {
    let n = 0;
    const rec = recorder(() => json(respond(++n)));
    const client = new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch });
    return { rec, get: () => client.computers.get('launch-42') };
  };

  it('polls until the guest has the setting', async () => {
    const { rec, get } = handle((n) => proxied(n < 4 ? true : undefined));
    const c = await get();
    expect(c.browserProxyPending).toBe(true);
    await expect(c.waitForBrowserProxy({ pollMs: 1 })).resolves.toBe(c);
    expect(c.browserProxyPending).toBe(false);
    expect(c.browserProxy).toEqual(PROXY);
    expect(rec.calls).toHaveLength(4);
  });

  it('reads again before answering, even when the handle already says applied', async () => {
    const { rec, get } = handle((n) => (n === 1 ? proxied(undefined) : proxied(true)));
    const c = await get();
    const error = await c.waitForBrowserProxy({ timeoutMs: 5, pollMs: 1 }).catch((e) => e);
    expect(error).toBeInstanceOf(TimeoutError);
    expect(error.message).toBe("launch-42's browser proxy was still being applied after 5ms");
    expect(rec.calls.length).toBeGreaterThan(1);
  });

  it('waits out a removal whose files are still in the guest', async () => {
    // No setting, and pending: the files of the one just removed are still
    // there. That is not "nothing to wait for".
    const { rec, get } = handle((n) =>
      n < 3 ? { ...computer(), browser_proxy_pending: true } : computer(),
    );
    const c = await get();
    await c.waitForBrowserProxy({ pollMs: 1 });
    expect(c.browserProxy).toBeUndefined();
    expect(rec.calls).toHaveLength(3);
  });

  it('answers at once for a computer with none', async () => {
    const { rec, get } = handle(() => computer());
    const c = await get();
    await c.waitForBrowserProxy();
    expect(rec.calls).toHaveLength(2);
  });

  it('refuses a stopped computer with no start under way, rather than waiting', async () => {
    const { get } = handle(() => proxied(undefined, { status: 'stopped', running_ram_mb: 0 }));
    const c = await get();
    const started = Date.now();
    const error = await c.waitForBrowserProxy({ timeoutMs: 60_000, pollMs: 1 }).catch((e) => e);
    expect(error).toBeInstanceOf(MandalaError);
    expect(error).not.toBeInstanceOf(TimeoutError);
    expect(error.message).toBe(
      'launch-42 is "stopped", and its browser proxy is applied only as it starts: call start()',
    );
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('waits through a start that is admitted but not yet booted', async () => {
    // Never pending while not running, so the false on a stopped read is not
    // an answer; the admitted start is.
    const { get } = handle((n) =>
      n <= 2
        ? proxied(undefined, { status: 'stopped', running_ram_mb: 1024 })
        : n === 3
          ? proxied(true)
          : proxied(false),
    );
    const c = await get();
    await c.waitForBrowserProxy({ pollMs: 1 });
    expect(c.status).toBe('running');
  });

  it('waits through an admitted start after a removal made while stopped', async () => {
    // Cleared while stopped, then started: the old policy is still on the
    // disk, and the platform reports that pending only once the machine runs.
    // The admitted start is not "nothing to remove".
    const { rec, get } = handle((n) =>
      n <= 2
        ? { ...computer(), status: 'stopped', running_ram_mb: 1024 }
        : n === 3
          ? { ...computer(), browser_proxy_pending: true }
          : computer(),
    );
    const c = await get();
    await c.waitForBrowserProxy({ pollMs: 1 });
    expect(c.status).toBe('running');
    expect(rec.calls).toHaveLength(4);
  });

  it('answers at once for a stopped computer with none and nothing admitted', async () => {
    const { rec, get } = handle(() => ({ ...computer(), status: 'stopped', running_ram_mb: 0 }));
    const c = await get();
    await c.waitForBrowserProxy({ pollMs: 1 });
    expect(rec.calls).toHaveLength(2);
  });

  it('with expectBrowserProxy, times out on reads that never report the setting', async () => {
    const { get } = handle(() => computer());
    const c = await get();
    const error = await c
      .waitForBrowserProxy({ timeoutMs: 5, pollMs: 1, expectBrowserProxy: true })
      .catch((e) => e);
    expect(error).toBeInstanceOf(TimeoutError);
    expect(error.message).toBe(
      'launch-42 was read for 5ms without reporting its browser proxy, so whether its ' +
        'browsers have it is unknown',
    );
  });

  it('names a create whose first start failed', async () => {
    const rec = recorder((call) =>
      call.method === 'POST'
        ? json(
            { ...proxied(undefined), status: 'stopped', start_error: 'no room' },
            { status: 201 },
          )
        : json(proxied(undefined, { status: 'stopped', running_ram_mb: undefined })),
    );
    const client = new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch });
    const c = await client.computers.create({ browserProxy: PROXY });
    await expect(c.waitForBrowserProxy({ timeoutMs: 60_000, pollMs: 1 })).rejects.toThrow(
      'launch-42 is stopped after it failed to start, so its browser proxy was not applied: ' +
        'no room. Call start() to try again',
    );
  });

  it('rides out a host that cannot be reached, and says so on a timeout', async () => {
    let n = 0;
    const rec = recorder(() => {
      n++;
      if (n === 2) return json({ error: 'host unreachable' }, { status: 503 });
      return json(n === 1 ? proxied(true) : proxied(false));
    });
    const client = new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch });
    const c = await client.computers.get('launch-42');
    await c.waitForBrowserProxy({ pollMs: 1 });
    expect(rec.calls).toHaveLength(3);

    const down = recorder(() =>
      down.calls.length === 1
        ? json(proxied(true))
        : json({ error: 'host unreachable' }, { status: 503 }),
    );
    const other = new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: down.fetch });
    const d = await other.computers.get('launch-42');
    const error = await d.waitForBrowserProxy({ timeoutMs: 20, pollMs: 1 }).catch((e) => e);
    expect(error).toBeInstanceOf(TimeoutError);
    expect(error.message).toBe(
      'launch-42 could not be observed within 20ms, so whether its browsers have its proxy ' +
        'is unknown',
    );
  });
});

describe('browserProxy on the computer', () => {
  const read = async (body: Record<string, unknown>) => {
    const rec = recorder(() => json(body));
    const client = new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch });
    return client.computers.get('launch-42');
  };

  it('reads the setting, and leaves out fields this client does not know', async () => {
    const c = await read(proxied(true, { browser_proxy: { ...PROXY, later: 'field' } }));
    expect(c.browserProxy).toEqual(PROXY);
    expect(c.browserProxyPending).toBe(true);
    const bare = await read(proxied(undefined, { browser_proxy: { server: PROXY.server } }));
    expect(bare.browserProxy).toEqual({ server: PROXY.server });
    expect(bare.browserProxyPending).toBe(false);
  });

  it('refuses a value it cannot read rather than dropping it', async () => {
    // update() replaces the setting whole, so a bypass entry lost on the read
    // is one a caller's next update would remove without knowing.
    for (const value of [
      'http://proxy:1',
      { bypass: [] },
      { server: '' },
      { server: PROXY.server, bypass: 'a.com' },
      { server: PROXY.server, bypass: ['a.com', 7] },
    ]) {
      const c = await read(proxied(undefined, { browser_proxy: value }));
      expect(() => c.browserProxy).toThrow(MandalaError);
    }
    const c = await read(proxied(undefined, { browser_proxy_pending: 'yes' }));
    expect(() => c.browserProxyPending).toThrow(/browser_proxy_pending to be a boolean/);
  });

  it('sends a change alone, and null to remove it', async () => {
    const rec = recorder((call) =>
      json(
        call.method === 'PATCH' && (call.body as { browser_proxy?: unknown }).browser_proxy === null
          ? computer()
          : proxied(true),
      ),
    );
    const client = new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch });
    const c = await client.computers.get('launch-42');
    await c.update({ browserProxy: PROXY });
    expect(rec.calls[1]!.body).toEqual({ browser_proxy: PROXY });
    expect(c.browserProxyPending).toBe(true);
    await c.update({ browserProxy: null });
    expect(rec.calls[2]!.body).toEqual({ browser_proxy: null });
    expect(c.browserProxy).toBeUndefined();
  });
});

describe('launch with a browser proxy', () => {
  it('waits for the guest to have it before returning, sharing the budget', async () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const waited = vi.spyOn(Computer.prototype, 'waitForBrowserProxy');
    let gets = 0;
    const rec = recorder((call) => {
      if (call.path.endsWith('/exec')) {
        // The guest wait spends 30ms of the 100ms budget.
        now = 1_030;
        return json(guest);
      }
      if (call.method === 'POST') {
        now = 1_000;
        return json(proxied(true), { status: 201 });
      }
      gets++;
      return json(proxied(gets < 3));
    });
    const client = new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch });
    const c = await client.computers.launch({ browserProxy: PROXY }, { timeoutMs: 100, pollMs: 1 });
    expect(c.browserProxyPending).toBe(false);
    expect(rec.calls[0]!.body).toMatchObject({ start: true, browser_proxy: PROXY });
    expect(waited).toHaveBeenCalledOnce();
    expect(waited.mock.calls[0]![0]).toMatchObject({ timeoutMs: 70, expectBrowserProxy: true });
    expect(gets).toBe(3);
  });

  it('waits past a read that leaves the setting out, since the create carried one', async () => {
    // A running read with no browser_proxy is "none" to a caller who does not
    // know better; launch does, so it waits for a read that says.
    let gets = 0;
    const rec = recorder((call) => {
      if (call.path.endsWith('/exec')) return json(guest);
      if (call.method === 'POST') return json(proxied(true), { status: 201 });
      gets++;
      return json(gets < 3 ? computer() : proxied(false));
    });
    const client = new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch });
    const c = await client.computers.launch({ browserProxy: PROXY }, { pollMs: 1 });
    expect(c.browserProxy).toEqual(PROXY);
    expect(gets).toBe(3);
  });

  it('adds no request for a computer with none', async () => {
    const waited = vi.spyOn(Computer.prototype, 'waitForBrowserProxy');
    const rec = recorder((call) => json(call.path.endsWith('/exec') ? guest : computer()));
    const client = new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch });
    await client.computers.launch();
    expect(waited).not.toHaveBeenCalled();
    expect(rec.calls).toHaveLength(3);
  });
});
