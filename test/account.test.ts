import { describe, expect, it } from 'vitest';
import {
  Account,
  type AccountQuota,
  AuthenticationError,
  Client,
  MandalaError,
  PermissionDeniedError,
  PlanLimitError,
  RateLimitError,
  UnavailableError,
} from '../src/index.js';
import { toAccountQuota } from '../src/models.js';
import { BASE, json, recorder } from './harness.js';

const report = () => ({
  scope: 'account',
  advisory: true,
  observed_at: '2026-09-16T12:34:56.123Z',
  plan: { id: 'standard', label: 'Standard' },
  limits: {
    max_computers: 5,
    vcpu_pool: 24,
    ram_pool_mb: 32768,
    disk_pool_gb: 400,
    snapshot_storage_bytes: 107374182400,
  },
  per_computer: { max_vcpu: 16, max_ram_mb: 16384, max_disk_gb: 200 },
  capabilities: { windows: false },
  complete: { computers: true, snapshots: true },
  usage: {
    kept_computers: 3,
    configured_vcpu: 14,
    configured_disk_gb: 120,
    running_or_reserved_computers: 2,
    running_or_reserved_vcpu: 6,
    running_or_reserved_ram_mb: 8192,
    snapshot_storage_bytes: 1073741825,
  },
  remaining: {
    kept_computers: 2,
    configured_vcpu: 10,
    configured_disk_gb: 280,
    running_or_reserved_ram_mb: 24576,
    snapshot_storage_bytes: 106300440575,
  },
});

type Wire = Record<string, unknown>;
const partial = (computers: boolean, snapshots: boolean): Wire => {
  const data: Wire = report();
  data.complete = { computers, snapshots };
  for (const section of ['usage', 'remaining']) {
    for (const key of Object.keys(data[section] as Wire)) {
      if (!(key === 'snapshot_storage_bytes' ? snapshots : computers))
        (data[section] as Wire)[key] = null;
    }
  }
  return data;
};
const answering = (data: unknown) => {
  const rec = recorder(() => json(data));
  return { rec, client: new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch }) };
};
const camel = (name: string) => name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

it('exposes Account and sends one authenticated GET without selectors or a body', async () => {
  const { rec, client } = answering(report());
  expect(client.account).toBeInstanceOf(Account);
  const quota: AccountQuota = await client.account.read();
  expect(rec.routes()).toEqual([['GET', 'account']]);
  expect(rec.last().query).toEqual({});
  expect(rec.last().body).toBeUndefined();
  expect(rec.last().headers.Authorization).toBe('Bearer com_test');
  expect(quota.scope).toBe('account');
  expect(quota.advisory).toBe(true);
  expect(quota.observedAt).toBe(report().observed_at);
  for (const section of [
    'plan',
    'limits',
    'per_computer',
    'capabilities',
    'complete',
    'usage',
    'remaining',
  ]) {
    const wire = (report() as Wire)[section] as Wire;
    expect((quota as unknown as Wire)[camel(section)]).toEqual(
      Object.fromEntries(Object.entries(wire).map(([key, value]) => [camel(key), value])),
    );
  }
  // A fresh observation on each read; there is no SDK quota cache.
  await client.account.read();
  expect(rec.calls).toHaveLength(2);
});

it.each([
  [false, true],
  [true, false],
  [false, false],
])(
  'preserves independent incomplete groups: computers=%s snapshots=%s',
  async (computers, snapshots) => {
    const data = partial(computers, snapshots);
    const { client } = answering(data);
    const quota = await client.account.read();
    expect(quota.complete).toEqual({ computers, snapshots });
    for (const section of ['usage', 'remaining'] as const) {
      for (const [key, value] of Object.entries(data[section] as Wire))
        expect((quota[section] as unknown as Wire)[camel(key)]).toBe(value);
    }
    expect(quota.limits.vcpuPool).toBe(24);
  },
);

it('keeps unknown fields only in a shallow raw copy and leaves input unchanged', () => {
  const data = {
    ...report(),
    usage: { ...report().usage, future_usage: 9 },
    future_field: { answer: 7 },
  };
  const before = structuredClone(data);
  Object.freeze(data.usage);
  Object.freeze(data);
  const quota = toAccountQuota(data);
  expect(data).toEqual(before);
  expect(quota.raw).toEqual(data);
  expect(quota.raw).not.toBe(data);
  expect(quota.raw.future_field).toBe(data.future_field);
  expect(quota).not.toHaveProperty('futureField');
  expect(quota.usage).not.toHaveProperty('futureUsage');
  expect(quota.raw.usage).toHaveProperty('future_usage', 9);
  expect(quota.usage).not.toBe(data.usage);
});

it('preserves complete zero, no-plan retained resources and overage', () => {
  const data = report();
  for (const key of Object.keys(data.usage)) (data.usage as Wire)[key] = 0;
  data.remaining = {
    kept_computers: 5,
    configured_vcpu: 24,
    configured_disk_gb: 400,
    running_or_reserved_ram_mb: 32768,
    snapshot_storage_bytes: 107374182400,
  };
  expect(toAccountQuota(data).usage.keptComputers).toBe(0);
  expect(toAccountQuota(data).remaining.snapshotStorageBytes).toBe(107374182400);
  const retained = report();
  retained.plan = { id: 'none', label: 'No plan' };
  for (const group of [retained.limits, retained.per_computer, retained.remaining])
    for (const key of Object.keys(group)) (group as Wire)[key] = 0;
  expect(toAccountQuota(retained).usage).toEqual(toAccountQuota(report()).usage);
  expect(Object.values(toAccountQuota(retained).remaining)).toEqual([0, 0, 0, 0, 0]);
  const overage = report();
  overage.limits.vcpu_pool = 4;
  overage.remaining.configured_vcpu = 0;
  expect(toAccountQuota(overage).usage.configuredVcpu).toBe(14);
  expect(toAccountQuota(overage).remaining.configuredVcpu).toBe(0);
});

it('accepts stopped resources, zero CPU, and equal active and kept CPU sums', () => {
  const data = report();
  data.usage.running_or_reserved_computers = 0;
  data.usage.running_or_reserved_vcpu = 0;
  data.usage.running_or_reserved_ram_mb = 0;
  data.remaining.running_or_reserved_ram_mb = data.limits.ram_pool_mb;
  expect(toAccountQuota(data).usage.configuredVcpu).toBe(14);
  data.usage.running_or_reserved_computers = 3;
  data.usage.running_or_reserved_ram_mb = 8192;
  data.remaining.running_or_reserved_ram_mb = 24576;
  data.usage.configured_vcpu = 0;
  data.remaining.configured_vcpu = 24;
  expect(toAccountQuota(data).usage.runningOrReservedVcpu).toBe(0);
  data.usage.configured_vcpu = 14;
  data.usage.running_or_reserved_vcpu = 14;
  data.remaining.configured_vcpu = 10;
  expect(toAccountQuota(data).usage.runningOrReservedVcpu).toBe(14);
});

const fields: [string, string | undefined][] = Object.entries(report()).flatMap<
  [string, string | undefined]
>(([key, value]) =>
  typeof value === 'object'
    ? Object.keys(value).map((nested): [string, string] => [key, nested])
    : [[key, undefined]],
);
const numericFields = fields.filter(([section]) =>
  ['limits', 'per_computer', 'usage', 'remaining'].includes(section),
);

describe('malformed reports', () => {
  it.each([null, [], 7, 'private response text', {}])(
    'refuses an invalid envelope %j',
    async (value) => {
      await expect(answering(value).client.account.read()).rejects.toBeInstanceOf(MandalaError);
    },
  );

  it.each(fields)('requires %s.%s', (section, key) => {
    const data: Wire = report();
    if (key) delete (data[section] as Wire)[key];
    else delete data[section];
    expect(() => toAccountQuota(data)).toThrow(/expected an account quota report/);
  });

  it.each(numericFields)('checks the numeric domain of %s.%s', (section, key) => {
    for (const bad of [
      null,
      true,
      false,
      -1,
      1.5,
      '0',
      Number.NaN,
      Number.POSITIVE_INFINITY,
      2 ** 53,
    ]) {
      const data: Wire = report();
      (data[section] as Wire)[key!] = bad;
      expect(() => toAccountQuota(data)).toThrow(/nonnegative safe integer/);
    }
    const data: Wire = report();
    (data[section] as Wire)[key!] = Number.MAX_SAFE_INTEGER;
    expect(() => toAccountQuota(data)).not.toThrow();
  });

  it('refuses missing, numeric and malformed values in incomplete groups', () => {
    for (const section of ['usage', 'remaining']) {
      for (const key of Object.keys(report()[section as 'usage' | 'remaining'])) {
        for (const bad of [undefined, 0, 'unknown', false]) {
          const data = partial(false, false);
          (data[section] as Wire)[key] = bad;
          expect(() => toAccountQuota(data)).toThrow(/null when incomplete/);
        }
      }
    }
  });

  it('requires real booleans, account scope, advisory true and a UTC observation', () => {
    const invalid: [string, string | undefined, unknown][] = [
      ['scope', undefined, 'workspace'],
      ['advisory', undefined, false],
      ['advisory', undefined, 1],
      ['plan', 'id', ''],
      ['plan', 'label', 0],
      ['capabilities', 'windows', 'false'],
      ['complete', 'computers', 1],
      ['complete', 'snapshots', null],
      ...['yesterday', '2026-09-16', '2026-09-16T12:00:00', '2026-02-30T00:00:00Z'].map(
        (date): [string, undefined, string] => ['observed_at', undefined, date],
      ),
    ];
    for (const [section, key, bad] of invalid) {
      const data: Wire = report();
      if (key) (data[section] as Wire)[key] = bad;
      else data[section] = bad;
      expect(() => toAccountQuota(data)).toThrow(/expected an account quota report/);
    }
    const data = { ...report(), plan: { id: 'standard', label: { secret: 'response detail' } } };
    expect(() => toAccountQuota(data)).toThrow('plan.label must be a nonempty string');
    expect(() => toAccountQuota(data)).not.toThrow(/response detail/);
  });
});

it('carries caller cancellation through the existing transport', async () => {
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const rec = recorder(() => {
    started();
    return new Promise<Response>(() => {});
  });
  const client = new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch });
  const controller = new AbortController();
  const pending = client.account.read({ signal: controller.signal });
  const rejected = expect(pending).rejects.toThrow(/cancelled account read/);
  await ready;
  controller.abort(new Error('cancelled account read'));
  await rejected;
  expect(rec.routes()).toEqual([['GET', 'account']]);
});

it.each([
  [401, AuthenticationError],
  [402, PlanLimitError],
  [403, PermissionDeniedError],
  [429, RateLimitError],
  [503, UnavailableError],
] as const)('preserves HTTP %s and refusal metadata', async (status, ErrorType) => {
  const body = { error: 'Quota read refused', reason: 'account_suspended', request_id: 'body-id' };
  const rec = recorder(() =>
    json(body, {
      status,
      headers: {
        'Content-Type': 'application/json',
        'X-Request-ID': 'header-id',
        'WWW-Authenticate': 'Bearer',
        'Retry-After': '2',
      },
    }),
  );
  const client = new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch });
  const error = await client.account.read().catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ErrorType);
  expect(error).toMatchObject({
    status,
    body,
    reason: 'account_suspended',
    requestId: 'header-id',
    wwwAuthenticate: 'Bearer',
    retryAfterMs: 2000,
  });
  expect(rec.calls).toHaveLength(1);
});
