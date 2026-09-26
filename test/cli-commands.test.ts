import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os, { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import { dashboardUrl, type LegacyCommands, runCli } from '../src/cli-commands.js';
import { type Flag, GLOBAL_FLAGS, parseArgs } from '../src/cli-options.js';
import { type CliIO, runtime } from '../src/cli-runtime.js';
import { looksLikeSecretValue } from '../src/cli-secrets.js';
import { Client } from '../src/index.js';
import {
  anyRoute,
  BASE,
  BUILD_PROGRESS,
  buildEvents,
  type Call,
  COMPUTER,
  DIRECTORY,
  EXEC_OK,
  guestFile,
  json,
  type Responder,
  recorder,
  SECRET,
  SECRET_LIST,
  SNAPSHOT,
  TEMPLATE_CHECK,
  USAGE,
  WEBHOOK,
  WEBHOOK_CREATED,
  WEBHOOK_DELIVERY,
} from './harness.js';

const stamp = '2026-01-02T03:04:05.000Z';
function harness(
  respond: Responder = anyRoute,
  input?: string,
  environment: NodeJS.ProcessEnv = {},
) {
  // The collection contains demo as a name, not as an ID. Its direct route is 404.
  const rec = recorder((call) =>
    call.method === 'GET' && call.path === `/computers/${COMPUTER.name}`
      ? json({ error: 'no such computer ID' }, { status: 404 })
      : respond(call),
  );
  const stdout: Uint8Array[] = [];
  const stderr: Uint8Array[] = [];
  const stdin = Object.assign(Readable.from(input === undefined ? [] : [Buffer.from(input)]), {
    isTTY: input === undefined,
  });
  const io: Partial<CliIO> = {
    stdin,
    stdout: {
      write: ((s: string | Uint8Array) => {
        stdout.push(Buffer.from(s));
        return true;
      }) as NodeJS.WritableStream['write'],
    },
    stderr: {
      write: ((s: string | Uint8Array) => {
        stderr.push(Buffer.from(s));
        return true;
      }) as NodeJS.WritableStream['write'],
    },
    env: { MANDALA_API_KEY: 'com_cli_test', MANDALA_MODEL_KEY: 'model_cli_test', ...environment },
    createClient: () => new Client({ apiKey: 'com_cli_test', baseUrl: BASE, fetch: rec.fetch }),
    now: () => new Date(stamp),
  };
  return {
    rec,
    io,
    async run(args: string[], jsonMode = true) {
      const code = await main([...args, ...(jsonMode ? ['--json'] : [])], io);
      const out = Buffer.concat(stdout).toString();
      const err = Buffer.concat(stderr).toString();
      return {
        code,
        out,
        err,
        bytes: Buffer.concat(stdout),
        frames: jsonMode
          ? out
              .trim()
              .split('\n')
              .filter(Boolean)
              .map((line) => JSON.parse(line))
          : [],
      };
    },
  };
}
const temp: string[] = [];
afterEach(async () => {
  for (const path of temp.splice(0)) await rm(path, { recursive: true, force: true });
});
async function tempDir() {
  const path = await mkdtemp(join(tmpdir(), 'mandala-cli-'));
  temp.push(path);
  return path;
}

describe('account and historical usage commands', () => {
  it('reads instantaneous account quota with one authenticated GET', async () => {
    const h = harness(() => json(accountReport()));
    const result = await h.run(['account']);
    expect(result.code).toBe(0);
    expect(h.rec.routes()).toEqual([['GET', 'account']]);
    expect(h.rec.last().query).toEqual({});
    expect(h.rec.last().body).toBeUndefined();
    expect(h.rec.last().headers.Authorization).toBe('Bearer com_cli_test');
    expect(result.frames).toHaveLength(1);
    expect(result.frames[0]).toMatchObject({
      schema_version: 2,
      command: 'account',
      ok: true,
      exit_code: 0,
      data: {
        scope: 'account',
        advisory: true,
        observed_at: accountReport().observed_at,
        complete: { computers: true, snapshots: true },
        usage: { configured_vcpu: 14, running_or_reserved_vcpu: 6 },
        remaining: { configured_vcpu: 10, snapshot_storage_bytes: 106300440575 },
      },
    });
    expect(result.err).toBe('');
  });

  it('reads historical usage with no invented default bounds', async () => {
    const h = harness(() => json(USAGE));
    const result = await h.run(['usage']);
    expect(result.code).toBe(0);
    expect(h.rec.routes()).toEqual([['GET', 'usage']]);
    expect(h.rec.last().query).toEqual({});
    expect(h.rec.last().body).toBeUndefined();
    expect(result.frames).toHaveLength(1);
    expect(result.frames[0]).toMatchObject({
      schema_version: 2,
      command: 'usage',
      ok: true,
      exit_code: 0,
      data: {
        period: USAGE.period,
        from: USAGE.from,
        to: USAGE.to,
        usage: { vcpu_hours: 25, disk_gb_months: 0.66, computers: [{ id: 'vm-1' }] },
        degraded: false,
        unmetered: false,
        breakdown: true,
        reported_through: USAGE.reported_through,
      },
    });
    expect(result.err).toBe('');
  });

  it.each([
    [false, true],
    [true, false],
    [false, false],
  ])(
    'keeps independent unknown quota groups: computers=%s snapshots=%s',
    async (computers, snapshots) => {
      const report = accountReport();
      report.complete = { computers, snapshots };
      for (const section of [report.usage, report.remaining]) {
        for (const key of Object.keys(section)) {
          if (!(key === 'snapshot_storage_bytes' ? snapshots : computers))
            (section as Record<string, number | null>)[key] = null;
        }
      }
      const machine = await harness(() => json(report)).run(['account']);
      expect(machine.code).toBe(0);
      expect(machine.frames[0].data.complete).toEqual({ computers, snapshots });
      for (const section of ['usage', 'remaining'] as const) {
        for (const [key, value] of Object.entries(machine.frames[0].data[section])) {
          expect(value === null).toBe(!(key === 'snapshot_storage_bytes' ? snapshots : computers));
        }
      }
      expect(machine.frames[0].data.limits.vcpu_pool).toBe(24);
      const human = await harness(() => json(report)).run(['account'], false);
      expect(human.code).toBe(0);
      expect(human.out).toContain(`Computer inventory: ${computers ? 'complete' : 'unknown'}`);
      expect(human.out).toContain(`Snapshot inventory: ${snapshots ? 'complete' : 'unknown'}`);
      expect(human.out).toContain(
        `Configured vCPU: used ${computers ? '14' : 'unknown'}; limit 24; remaining ${computers ? '10' : 'unknown'}`,
      );
      expect(human.out).toContain(
        `Indexed snapshot storage (bytes): used ${snapshots ? '1073741825' : 'unknown'}; limit 107374182400; remaining ${snapshots ? '106300440575' : 'unknown'}`,
      );
    },
  );

  it.each(['zero', 'no plan', 'overage'])(
    'preserves quota %s without hiding usage or inventing unlimited capacity',
    async (state) => {
      const report = accountReport();
      if (state === 'zero') {
        for (const key of Object.keys(report.usage))
          (report.usage as Record<string, number>)[key] = 0;
        report.remaining = {
          kept_computers: 5,
          configured_vcpu: 24,
          configured_disk_gb: 400,
          running_or_reserved_ram_mb: 32768,
          snapshot_storage_bytes: 107374182400,
        };
      } else if (state === 'no plan') {
        report.plan = { id: 'none', label: 'No plan' };
        for (const section of [report.limits, report.per_computer, report.remaining])
          for (const key of Object.keys(section)) (section as Record<string, number>)[key] = 0;
      } else {
        report.limits.vcpu_pool = 4;
        report.remaining.configured_vcpu = 0;
      }
      const machine = await harness(() => json(report)).run(['account']);
      expect(machine.code).toBe(0);
      expect(machine.frames[0].data.usage.configured_vcpu).toBe(state === 'zero' ? 0 : 14);
      expect(machine.frames[0].data.remaining.configured_vcpu).toBe(state === 'zero' ? 24 : 0);
      expect(machine.frames[0].data.plan).toEqual(report.plan);
      const human = await harness(() => json(report)).run(['account'], false);
      expect(human.out).toContain(
        `Configured vCPU: used ${report.usage.configured_vcpu}; limit ${report.limits.vcpu_pool}; remaining ${report.remaining.configured_vcpu}`,
      );
      expect(human.out).not.toContain('unlimited');
      expect(human.out).not.toContain('unknown');
    },
  );

  it('labels quota units, distinct accounting and advisory limits in plain output', async () => {
    const h = harness(() => json(accountReport()), undefined, {
      NO_COLOR: '1',
      MANDALA_MODEL_KEY: '',
    });
    const result = await h.run(['account'], false);
    expect(h.rec.routes()).toEqual([['GET', 'account']]);
    expect(result.out).toContain('Account quota (instantaneous, account-wide)');
    expect(result.out).toContain(`Observed: ${accountReport().observed_at}`);
    expect(result.out).toContain('Plan: Standard (standard)');
    expect(result.out).toContain('not a reservation or host-capacity guarantee');
    expect(result.out).toContain('Configured disk (GiB): used 120');
    expect(result.out).toContain('Running/reserved vCPU: 6');
    expect(result.out).toContain('Running/reserved RAM (MiB): used 8192');
    expect(result.out).toContain('excludes in-flight capture reservations');
    expect(result.out).toContain('Per-computer maxima: 16 vCPU; 16384 MiB RAM; 200 GiB disk');
    expect(result.out).toContain('Windows capability: no');
    expect(result.out).not.toContain('\u001b');
    expect(result.err).toBe('');
  });

  it.each([
    { from: '2026-08-01T00:00:00+01:00' },
    { to: '2026-09-01t00:00:00z' },
    { from: '2026-08-01T00:00:00.123456Z', to: '2026-09-01T00:00:00-05:00' },
    { from: '2026-08-01T01:00:00+02:00', to: '2026-08-01T00:00:00Z' },
    { to: '2099-01-01T00:00:00Z' },
  ])('forwards timestamp bounds unchanged: %j', async (bounds) => {
    const h = harness(() => json(USAGE), undefined, { MANDALA_MODEL_KEY: '' });
    const result = await h.run([
      'usage',
      ...Object.entries(bounds).flatMap(([key, value]) => [`--${key}`, value]),
    ]);
    expect(result.code).toBe(0);
    expect(h.rec.routes()).toEqual([['GET', 'usage']]);
    expect(h.rec.last().query).toEqual(bounds);
    expect(h.rec.last().body).toBeUndefined();
    expect(h.rec.last().headers.Authorization).toBe('Bearer com_cli_test');
    // The API's measured bounds can differ from the requested window.
    expect(result.frames[0].data.from).toBe(USAGE.from);
    expect(result.frames[0].data.to).toBe(USAGE.to);
  });

  it.each([
    ['account', 'other-account'],
    ['account', '--account', 'other-account'],
    ['account', '--from', '2026-08-01T00:00:00Z'],
    ['usage', 'computer'],
    ['usage', '--computer', 'computer'],
    ['usage', '--from'],
    ['usage', '--to='],
    ['usage', '--from', '2026-08-01'],
    ['usage', '--to', '2026-08-01T00:00:00'],
    ['usage', '--from', '2026-13-45T00:00:00Z'],
    ['usage', '--to', '2026-08-01T25:00:00Z'],
    ['usage', '--to', '2026-08-01T00:00:00+25:00'],
    ['usage', '--from', '2026-09-01T00:00:00Z', '--to', '2026-08-01T00:00:00Z'],
    ['usage', '--from', '2026-08-01T01:00:00+01:00', '--to', '2026-08-01T00:00:00Z'],
    ['usage', '--from', '2026-08-01T00:00:00Z', '--from', '2026-08-02T00:00:00Z'],
  ])('rejects invalid arguments before client creation: %j', async (...args) => {
    const h = harness();
    const create = vi.fn(() => {
      throw new Error('must remain offline');
    });
    h.io.createClient = create;
    const result = await h.run(args);
    expect(result.code).toBe(1);
    expect(result.frames[0]).toMatchObject({
      ok: false,
      error: { code: 'invalid_arguments' },
      exit_code: 1,
    });
    expect(create).not.toHaveBeenCalled();
    expect(h.rec.calls).toEqual([]);
  });

  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])('preserves historical shortfalls: degraded=%s unmetered=%s', async (degraded, unmetered) => {
    const report = { ...USAGE, degraded, unmetered, reported_through: null };
    const result = await harness(() => json(report)).run(['usage']);
    expect(result.code).toBe(0);
    expect(result.frames[0].data).toMatchObject({
      degraded,
      unmetered,
      reported_through: null,
      usage: { vcpu_hours: 25, snapshot_gb_months: 0.13 },
    });
    const human = await harness(() => json(report)).run(['usage'], false);
    expect(human.out).toContain('Historical metered usage (account-wide)');
    expect(human.out).toContain(`Completeness: degraded=${degraded}; unmetered=${unmetered}`);
    expect(human.out.includes('totals may be too small')).toBe(degraded);
    expect(human.out.includes('retrying alone will not recover it')).toBe(unmetered);
    expect(human.out).toContain('Settled for billing through: none of this window');
    expect(human.out).toContain(`Measured window: ${USAGE.from} to ${USAGE.to}`);
    expect(human.out).toContain(
      `Billing period: ${USAGE.period.start} to ${USAGE.period.end} (subscription)`,
    );
    expect(human.out).toContain('RAM GB-hours: 50');
    expect(human.out).toContain('Disk GB-hours: 480; GB-months: 0.66');
    expect(human.out).toContain('Snapshot GB-hours: 96; GB-months: 0.13');
  });

  it('keeps a complete zero historical window distinct from withheld or incomplete usage', async () => {
    const report = {
      ...USAGE,
      to: USAGE.from,
      reported_through: null,
      usage: {
        run_hours: 0,
        vcpu_hours: 0,
        ram_gb_hours: 0,
        disk_gb_hours: 0,
        disk_gb_months: 0,
        snapshot_gb_hours: 0,
        snapshot_gb_months: 0,
        computers: [],
      },
    };
    const result = await harness(() => json(report)).run(['usage']);
    expect(result.code).toBe(0);
    expect(result.frames[0].data).toMatchObject({
      degraded: false,
      unmetered: false,
      breakdown: true,
      usage: {
        run_hours: 0,
        vcpu_hours: 0,
        ram_gb_hours: 0,
        disk_gb_months: 0,
        snapshot_gb_months: 0,
        computers: [],
      },
    });
    const human = await harness(() => json(report)).run(['usage'], false);
    expect(human.out).toContain('Run hours: 0');
    expect(human.out).toContain('Computer breakdown: empty');
    expect(human.out).not.toContain('Incomplete:');
  });

  it.each(['empty', 'withheld', 'deleted'])(
    'distinguishes a %s historical breakdown',
    async (state) => {
      const usage = { ...USAGE.usage } as Record<string, unknown>;
      if (state === 'withheld') delete usage.computers;
      else usage.computers = state === 'empty' ? [] : [{ ...USAGE.usage.computers[0], gone: true }];
      const report = { ...USAGE, usage };
      const result = await harness(() => json(report)).run(['usage']);
      expect(result.frames[0].data.breakdown).toBe(state !== 'withheld');
      expect(result.frames[0].data.usage.computers).toHaveLength(state === 'deleted' ? 1 : 0);
      const human = await harness(() => json(report)).run(['usage'], false);
      expect(human.out).toContain(
        `Computer breakdown: ${state === 'deleted' ? 'available' : state}`,
      );
      if (state === 'deleted')
        expect(human.out).toContain(
          'scratch (vm-1) [deleted]: 12.5 run hours; 25 vCPU-hours; 50 RAM GB-hours',
        );
    },
  );

  it.each([true, false])(
    'preserves named and unnamed live and deleted usage rows (JSON=%s)',
    async (jsonMode) => {
      const report = {
        ...USAGE,
        usage: {
          ...USAGE.usage,
          computers: [
            { id: 'named-live', name: 'desktop', run_hours: 1, vcpu_hours: 2, ram_gb_hours: 4 },
            { id: 'unnamed-live', run_hours: 2, vcpu_hours: 4, ram_gb_hours: 8 },
            {
              id: 'named-deleted',
              name: 'former',
              gone: true,
              run_hours: 3,
              vcpu_hours: 6,
              ram_gb_hours: 12,
            },
            {
              id: 'unnamed-deleted',
              gone: true,
              run_hours: 6.5,
              vcpu_hours: 13,
              ram_gb_hours: 26,
            },
          ],
        },
      };
      const h = harness(() => json(report));
      const result = await h.run(['usage'], jsonMode);
      expect(result.code).toBe(0);
      expect(result.err).toBe('');
      expect(h.rec.routes()).toEqual([['GET', 'usage']]);
      if (jsonMode) {
        expect(result.frames).toHaveLength(1);
        expect(result.frames[0]).toMatchObject({
          schema_version: 2,
          command: 'usage',
          ok: true,
          exit_code: 0,
          data: { breakdown: true },
        });
        expect(result.frames[0].data.usage).toEqual({
          run_hours: 12.5,
          vcpu_hours: 25,
          ram_gb_hours: 50,
          disk_gb_hours: 480,
          disk_gb_months: 0.66,
          snapshot_gb_hours: 96,
          snapshot_gb_months: 0.13,
          computers: [
            {
              id: 'named-live',
              name: 'desktop',
              run_hours: 1,
              vcpu_hours: 2,
              ram_gb_hours: 4,
              gone: false,
            },
            {
              id: 'unnamed-live',
              name: '',
              run_hours: 2,
              vcpu_hours: 4,
              ram_gb_hours: 8,
              gone: false,
            },
            {
              id: 'named-deleted',
              name: 'former',
              run_hours: 3,
              vcpu_hours: 6,
              ram_gb_hours: 12,
              gone: true,
            },
            {
              id: 'unnamed-deleted',
              name: '',
              run_hours: 6.5,
              vcpu_hours: 13,
              ram_gb_hours: 26,
              gone: true,
            },
          ],
        });
      } else {
        for (const line of [
          'Run hours: 12.5',
          'vCPU-hours: 25',
          'RAM GB-hours: 50',
          'Disk GB-hours: 480; GB-months: 0.66',
          'Snapshot GB-hours: 96; GB-months: 0.13',
          'desktop (named-live): 1 run hours; 2 vCPU-hours; 4 RAM GB-hours',
          'unnamed-live (unnamed-live): 2 run hours; 4 vCPU-hours; 8 RAM GB-hours',
          'former (named-deleted) [deleted]: 3 run hours; 6 vCPU-hours; 12 RAM GB-hours',
          'unnamed-deleted (unnamed-deleted) [deleted]: 6.5 run hours; 13 vCPU-hours; 26 RAM GB-hours',
        ]) {
          expect(result.out).toContain(line);
        }
      }
    },
  );

  it('accepts open period sources, empty names and future fields at every level', async () => {
    const report = {
      ...USAGE,
      period: { ...USAGE.period, source: 'future-period-basis', future_field: null },
      future_field: { extra: true },
      usage: {
        ...USAGE.usage,
        future_field: 'new total',
        computers: [
          { ...USAGE.usage.computers[0], name: '', gone: false, future_field: ['new detail'] },
        ],
      },
    };
    const machine = await harness(() => json(report)).run(['usage']);
    expect(machine.code).toBe(0);
    expect(machine.frames[0].data).toMatchObject({
      period: { source: 'future-period-basis' },
      usage: { computers: [{ id: 'vm-1', name: '', gone: false }] },
    });
    expect(machine.out).not.toContain('future_field');
    const human = await harness(() => json(report)).run(['usage'], false);
    expect(human.code).toBe(0);
    expect(human.out).toContain('(future-period-basis)');
    expect(human.out).toContain('vm-1 (vm-1): 12.5 run hours');
    expect(human.err).toBe('');
  });

  function withUsageField(field: string, value: unknown) {
    const report: Record<string, unknown> = structuredClone(USAGE);
    const keys = field.split('.');
    const last = keys.pop()!;
    let parent = report;
    for (const key of keys) parent = parent[key] as Record<string, unknown>;
    if (value === undefined) delete parent[last];
    else parent[last] = value;
    return report;
  }

  async function expectUsageFailure(respond: Responder, jsonMode: boolean) {
    const h = harness(respond);
    const result = await h.run(['usage'], jsonMode);
    expect(result.code).toBe(1);
    expect(h.rec.routes()).toEqual([['GET', 'usage']]);
    if (jsonMode) {
      expect(result.frames).toHaveLength(1);
      expect(result.frames[0]).toMatchObject({
        schema_version: 2,
        command: 'usage',
        ok: false,
        exit_code: 1,
        error: { code: 'failed', message: expect.stringContaining('Invalid usage report:') },
      });
      expect(result.frames[0]).not.toHaveProperty('data');
      expect(result.err).toBe('');
    } else {
      expect(result.out).toBe('');
      expect(result.err).toContain('mandala: Invalid usage report:');
    }
  }

  for (const jsonMode of [true, false]) {
    describe(`${jsonMode ? 'JSON' : 'human'} usage validation`, () => {
      it('rejects an empty totals object before displaying defaulted metadata or zeros', async () => {
        await expectUsageFailure(() => json({ usage: {} }), jsonMode);
        await expectUsageFailure(() => json({ ...USAGE, usage: {} }), jsonMode);
      });

      it.each([
        'usage.run_hours',
        'usage.vcpu_hours',
        'usage.ram_gb_hours',
        'usage.disk_gb_hours',
        'usage.disk_gb_months',
        'usage.snapshot_gb_hours',
        'usage.snapshot_gb_months',
        'usage.computers.0.run_hours',
        'usage.computers.0.vcpu_hours',
        'usage.computers.0.ram_gb_hours',
      ])('rejects missing, null or malformed numeric field %s', async (field) => {
        for (const value of [undefined, null, '0', false, -1, {}, []]) {
          await expectUsageFailure(() => json(withUsageField(field, value)), jsonMode);
        }
      });

      it('rejects nonfinite numbers parsed from valid JSON', async () => {
        for (const field of ['usage.vcpu_hours', 'usage.computers.0.run_hours']) {
          const body = JSON.stringify(withUsageField(field, 'overflow')).replace(
            '"overflow"',
            '1e400',
          );
          await expectUsageFailure(() => new Response(body), jsonMode);
        }
      });

      it('rejects missing or malformed period objects', async () => {
        for (const value of [undefined, null, [], 'broken', {}]) {
          await expectUsageFailure(() => json(withUsageField('period', value)), jsonMode);
        }
      });

      it.each(['from', 'to', 'period.start', 'period.end'])(
        'rejects missing or malformed timestamp %s',
        async (field) => {
          for (const value of [
            undefined,
            null,
            0,
            '',
            'broken',
            '2026-08-01',
            '2026-08-01T00:00:00',
            '2026-13-01T00:00:00Z',
            '2026-02-30T00:00:00Z',
            '2026-08-01T24:00:00Z',
          ]) {
            await expectUsageFailure(() => json(withUsageField(field, value)), jsonMode);
          }
        },
      );

      it('rejects a missing or malformed period source', async () => {
        for (const value of [undefined, null, 0, '', ' ']) {
          await expectUsageFailure(() => json(withUsageField('period.source', value)), jsonMode);
        }
      });

      it.each(['degraded', 'unmetered'])(
        'rejects a missing or malformed %s caveat',
        async (field) => {
          for (const value of [undefined, null, 0, 1, 'false', {}, []]) {
            await expectUsageFailure(() => json(withUsageField(field, value)), jsonMode);
          }
        },
      );

      it('requires an explicit null or valid settlement day', async () => {
        for (const value of [
          undefined,
          false,
          0,
          '',
          'broken',
          '2026-02-30',
          '2026-08-20T00:00:00Z',
        ]) {
          await expectUsageFailure(() => json(withUsageField('reported_through', value)), jsonMode);
        }
      });

      it('rejects malformed breakdown containers and rows without dropping them', async () => {
        for (const value of [null, 'broken', {}, [null], [true], [[]], [{}]]) {
          await expectUsageFailure(() => json(withUsageField('usage.computers', value)), jsonMode);
        }
      });

      it('rejects missing or malformed row IDs', async () => {
        for (const value of [undefined, null, 0, {}, [], '']) {
          await expectUsageFailure(
            () => json(withUsageField('usage.computers.0.id', value)),
            jsonMode,
          );
        }
      });

      it('rejects malformed present row names', async () => {
        for (const value of [null, 0, false, {}, []]) {
          await expectUsageFailure(
            () => json(withUsageField('usage.computers.0.name', value)),
            jsonMode,
          );
        }
      });

      it('rejects a malformed optional deletion flag', async () => {
        for (const value of [null, 0, 'true', {}, []]) {
          await expectUsageFailure(
            () => json(withUsageField('usage.computers.0.gone', value)),
            jsonMode,
          );
        }
      });
    });
  }

  it.each(['account', 'usage'])(
    'retains %s redaction and excludes untyped extra payload fields',
    async (command) => {
      const report =
        command === 'account'
          ? { ...accountReport(), plan: { id: 'standard', label: 'com_cli_test' } }
          : { ...USAGE, period: { ...USAGE.period, source: 'com_cli_test' } };
      for (const jsonMode of [true, false]) {
        const result = await harness(() =>
          json({ ...report, future_field: 'untyped-payload' }),
        ).run([command], jsonMode);
        expect(result.code).toBe(0);
        expect(result.out).toContain('[REDACTED]');
        expect(result.out).not.toContain('com_cli_test');
        expect(result.out).not.toContain('untyped-payload');
        if (jsonMode) expect(result.frames[0].data).not.toHaveProperty('raw');
      }
    },
  );

  it.each(['account', 'usage'])(
    'fails a malformed %s read instead of returning empty success',
    async (command) => {
      for (const body of [null, [], {}, { usage: [] }]) {
        const h = harness(() => json(body));
        const result = await h.run([command]);
        expect(result.code).toBe(1);
        expect(result.frames).toHaveLength(1);
        expect(result.frames[0]).toMatchObject({
          command,
          ok: false,
          exit_code: 1,
          error: { code: 'failed' },
        });
        expect(result.frames[0]).not.toHaveProperty('data');
        expect(h.rec.routes()).toEqual([['GET', command]]);
      }
    },
  );

  for (const command of ['account', 'usage']) {
    it.each([400, 401, 403, 402, 429, 503])(
      `preserves ${command} HTTP %i errors without retry or mutation`,
      async (status) => {
        const h = harness(() => json({ error: 'request failed com_cli_test' }, { status }));
        const result = await h.run([command]);
        expect(result.code).toBe(1);
        expect(result.frames[0]).toMatchObject({
          command,
          ok: false,
          exit_code: 1,
          error: { status },
        });
        expect(result.frames[0]).not.toHaveProperty('data');
        expect(result.out).toContain('[REDACTED]');
        expect(result.out).not.toContain('com_cli_test');
        expect(h.rec.routes()).toEqual([['GET', command]]);
      },
    );

    it.each(['SIGINT', 'SIGTERM'] as const)(
      `cancels ${command} with %s and restores listeners`,
      async (event) => {
        const h = harness(() => new Promise<Response>(() => {}));
        const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
        const pending = h.run([command]);
        await vi.waitFor(() => expect(h.rec.calls).toHaveLength(1));
        process.emit(event);
        const result = await pending;
        expect(result.code).toBe(130);
        expect(result.frames).toHaveLength(1);
        expect(result.frames[0]).toMatchObject({
          command,
          ok: false,
          exit_code: 130,
          error: { code: 'cancelled' },
        });
        expect(h.rec.routes()).toEqual([['GET', command]]);
        expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(before);
      },
    );
  }
});

function accountReport() {
  return {
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
  };
}

describe('computer commands use distinct SDK requests', () => {
  it('lists selected state and preserves an incomplete inventory', async () => {
    const h = harness(() => json([COMPUTER], { headers: { 'X-GC-Incomplete': '2' } }));
    const result = await h.run(['computers', 'list', '--allow-partial', '--state', 'lost']);
    expect(h.rec.routes()).toEqual([['GET', 'computers']]);
    expect(h.rec.last().query).toEqual({ allow_partial: '1', state: 'lost' });
    expect(result.frames[0]).toMatchObject({
      schema_version: 2,
      command: 'computers list',
      ok: true,
      exit_code: 0,
      data: { incomplete: 2, items: [{ id: COMPUTER.id }] },
    });
    expect(result.out).not.toContain('vnc');
  });

  it('creates with every independent shape field intact', async () => {
    const h = harness();
    const result = await h.run([
      'computers',
      'create',
      '--name',
      'new desktop',
      '--template',
      'acme/dev@2.3.4',
      '--template-transfer',
      'preparation-token',
      '--cpu',
      '3',
      '--ram-mb',
      '7168',
      '--disk-gb',
      '43',
      '--resolution',
      '1440x900',
      '--no-start',
    ]);
    expect(h.rec.routes()).toEqual([['POST', 'computers']]);
    expect(h.rec.last().body).toEqual({
      name: 'new desktop',
      template: 'acme/dev@2.3.4',
      template_transfer: 'preparation-token',
      cpu: 3,
      ram_mb: 7168,
      disk_gb: 43,
      resolution: '1440x900',
      start: false,
    });
    expect(result.frames[0].data.id).toBe(COMPUTER.id);
  });

  it('creates a named size with the normal start default', async () => {
    const h = harness();
    await h.run(['computers', 'create', '--size', 'small']);
    expect(h.rec.last().body).toEqual({ size: 'small', start: true });
  });

  it('gets fresh public data by name', async () => {
    const h = harness((call) =>
      json(call.path === '/computers' ? [COMPUTER] : { ...COMPUTER, cpu: 7 }),
    );
    const result = await h.run(['computers', 'get', COMPUTER.name]);
    expect(h.rec.routes()).toEqual([
      ['GET', 'computers'],
      ['GET', `computers/${COMPUTER.name}`],
      ['GET', `computers/${COMPUTER.id}`],
    ]);
    expect(result.frames[0].data.cpu).toBe(7);
    expect(result.frames[0].data.vnc).toBeUndefined();
  });

  it.each([
    ['start', ['--resume-only'], { resume_only: 'true' }],
    ['stop', ['--force'], { force: 'true' }],
    ['suspend', [], {}],
    ['restart', [], {}],
  ] as const)('%s targets the selected ID with its own flags', async (verb, flags, query) => {
    const h = harness();
    const result = await h.run(['computers', verb, COMPUTER.name, ...flags]);
    expect(h.rec.routes()).toEqual([
      ['GET', 'computers'],
      ['GET', `computers/${COMPUTER.name}`],
      ['POST', `computers/${COMPUTER.id}/${verb}`],
    ]);
    expect(h.rec.last().query).toEqual(query);
    expect(result.code).toBe(0);
    expect(result.frames[0].data.id).toBe(COMPUTER.id);
  });

  it('clones with the requested name', async () => {
    const h = harness();
    const result = await h.run(['computers', 'clone', COMPUTER.name, '--name', 'fork-one']);
    expect(h.rec.routes()).toEqual([
      ['GET', 'computers'],
      ['GET', `computers/${COMPUTER.name}`],
      ['POST', `computers/${COMPUTER.id}/clone`],
    ]);
    expect(h.rec.last().body).toEqual({ name: 'fork-one' });
    expect(result.code).toBe(0);
  });

  it('deletes with the caller-supplied snapshot fingerprint', async () => {
    const h = harness((call) =>
      call.method === 'DELETE' ? json({ snapshots_deleted: 3 }) : anyRoute(call),
    );
    const result = await h.run([
      'computers',
      'delete',
      COMPUTER.name,
      '--delete-snapshots',
      '--expect',
      'fingerprint-7',
    ]);
    expect(h.rec.routes()).toEqual([
      ['GET', 'computers'],
      ['GET', `computers/${COMPUTER.name}`],
      ['DELETE', `computers/${COMPUTER.id}`],
    ]);
    expect(h.rec.last().query).toEqual({ snapshots: 'delete', expect: 'fingerprint-7' });
    expect(result.frames[0].data).toEqual({ id: COMPUTER.id, deleted: true, snapshots_deleted: 3 });
  });

  it('writes screenshot bytes exactly and returns a file result', async () => {
    const path = join(await tempDir(), 'screen.png');
    const bytes = Uint8Array.from([137, 80, 0, 255, 10]);
    const h = harness((call) =>
      call.path.endsWith('/screenshot')
        ? new Response(bytes, { headers: { 'content-type': 'image/png' } })
        : anyRoute(call),
    );
    const result = await h.run([
      'computers',
      'screenshot',
      COMPUTER.id,
      '-o',
      path,
      '--width',
      '640',
      '--fresh',
    ]);
    expect(h.rec.routes()).toEqual([
      ['GET', 'computers'],
      ['GET', `computers/${COMPUTER.id}/screenshot`],
    ]);
    expect(h.rec.last().query).toEqual({ w: '640', fresh: '1' });
    expect(await readFile(path)).toEqual(Buffer.from(bytes));
    expect(result.frames[0].data).toEqual({ path, bytes: bytes.length });
  });

  it('sends a screenshot region, scale, format and quality', async () => {
    const path = join(await tempDir(), 'screen.jpg');
    const bytes = Uint8Array.from([255, 216, 255]);
    const h = harness((call) =>
      call.path.endsWith('/screenshot')
        ? new Response(bytes, { headers: { 'content-type': 'image/jpeg' } })
        : anyRoute(call),
    );
    await h.run([
      'computers',
      'screenshot',
      COMPUTER.id,
      '-o',
      path,
      '--region',
      '0, 0,640,400',
      '--scale',
      '0.5',
      '--format',
      'jpeg',
      '--quality',
      '60',
    ]);
    expect(h.rec.last().query).toEqual({
      region: '0,0,640,400',
      scale: '0.5',
      format: 'jpeg',
      quality: '60',
    });
    expect(await readFile(path)).toEqual(Buffer.from(bytes));
  });

  it.each(['built', 'running', 'guest'])('waits until %s', async (until) => {
    const h = harness();
    const result = await h.run([
      'computers',
      'wait',
      COMPUTER.name,
      '--until',
      until,
      '--timeout-ms',
      '1000',
      '--poll-ms',
      '2',
    ]);
    expect(result.code).toBe(0);
    expect(h.rec.routes()).toEqual(
      until === 'guest'
        ? [
            ['GET', 'computers'],
            ['GET', `computers/${COMPUTER.name}`],
            ['POST', `computers/${COMPUTER.id}/exec`],
          ]
        : until === 'built'
          ? [
              ['GET', 'computers'],
              ['GET', `computers/${COMPUTER.name}`],
            ]
          : [
              ['GET', 'computers'],
              ['GET', `computers/${COMPUTER.name}`],
              ['GET', `computers/${COMPUTER.id}`],
            ],
    );
    if (until === 'guest') expect(h.rec.last().body).toMatchObject({ command: 'exit 0' });
    expect(result.frames[0].data.id).toBe(COMPUTER.id);
  });

  it('refuses ambiguous names before a mutation', async () => {
    const h = harness(() => json([COMPUTER, { ...COMPUTER, id: 'vm-other' }]));
    const result = await h.run(['computers', 'stop', COMPUTER.name]);
    expect(result.code).toBe(1);
    expect(result.frames[0].error.code).toBe('ambiguous_computer');
    expect(h.rec.routes()).toEqual([
      ['GET', 'computers'],
      ['GET', `computers/${COMPUTER.name}`],
    ]);
  });

  it('can resolve an ID when the inventory request fails', async () => {
    const h = harness((call) =>
      call.path === '/computers' ? json({ error: 'unavailable' }, { status: 503 }) : json(COMPUTER),
    );
    const result = await h.run(['computers', 'stop', COMPUTER.id]);
    expect(result.code).toBe(0);
    expect(h.rec.routes()).toEqual([
      ['GET', 'computers'],
      ['GET', `computers/${COMPUTER.id}`],
      ['POST', `computers/${COMPUTER.id}/stop`],
    ]);
  });
});

describe('computer ID precedence and lookup uncertainty', () => {
  const target = 'vm-lost';
  const other = { ...COMPUTER, id: 'vm-live', name: target };
  const lost = { ...COMPUTER, id: target, name: 'archived desktop', state: 'lost' };

  it('deletes an exact ID omitted from the list instead of a colliding live name', async () => {
    const h = harness((call) => {
      if (call.path === '/computers') return json([other]);
      if (call.method === 'GET' && call.path === `/computers/${target}`) return json(lost);
      return json({ snapshots_deleted: 0 });
    });
    const result = await h.run(['computers', 'delete', target]);
    expect(result.code).toBe(0);
    expect(h.rec.routes()).toEqual([
      ['GET', 'computers'],
      ['GET', `computers/${target}`],
      ['DELETE', `computers/${target}`],
    ]);
    expect(result.frames[0].data.id).toBe(target);
  });

  it('uses a listed exact ID even when another computer has that name', async () => {
    const h = harness((call) =>
      call.path === '/computers' ? json([other, lost]) : json({ snapshots_deleted: 0 }),
    );
    const result = await h.run(['computers', 'delete', target]);
    expect(result.code).toBe(0);
    expect(h.rec.routes()).toEqual([
      ['GET', 'computers'],
      ['DELETE', `computers/${target}`],
    ]);
    expect(result.frames[0].data.id).toBe(target);
  });

  it('does not fall back to a name when the direct ID request loses its connection', async () => {
    const h = harness((call) => {
      if (call.path === '/computers') return json([other]);
      throw new TypeError('connection lost');
    });
    const result = await h.run(['computers', 'delete', target]);
    expect(result.code).toBe(1);
    expect(h.rec.routes()).toEqual([
      ['GET', 'computers'],
      ['GET', `computers/${target}`],
    ]);
  });

  it.each([401, 403, 429, 503])(
    'does not fall back to a name after HTTP %s from the ID lookup',
    async (status) => {
      const h = harness((call) =>
        call.path === '/computers'
          ? json([other])
          : json({ error: 'ID lookup refused' }, { status }),
      );
      const result = await h.run(['computers', 'delete', target]);
      expect(result.code).toBe(1);
      expect(result.frames[0].error.status).toBe(status);
      expect(h.rec.routes()).toEqual([
        ['GET', 'computers'],
        ['GET', `computers/${target}`],
      ]);
    },
  );

  it('falls back to a unique name only after a direct 404', async () => {
    const h = harness((call) => {
      if (call.path === '/computers') return json([other]);
      if (call.method === 'GET') return json({ error: 'no such ID' }, { status: 404 });
      return json({ snapshots_deleted: 0 });
    });
    const result = await h.run(['computers', 'delete', target]);
    expect(result.code).toBe(0);
    expect(h.rec.routes()).toEqual([
      ['GET', 'computers'],
      ['GET', `computers/${target}`],
      ['DELETE', 'computers/vm-live'],
    ]);
    expect(result.frames[0].data.id).toBe('vm-live');
  });

  it('does not select a name from an incomplete inventory even after a direct 404', async () => {
    const h = harness((call) =>
      call.path === '/computers'
        ? json([other], { headers: { 'X-GC-Incomplete': '0' } })
        : json({ error: 'no such ID' }, { status: 404 }),
    );
    const result = await h.run(['computers', 'delete', target]);
    expect(result.code).toBe(1);
    expect(h.rec.calls.every((call) => call.method === 'GET')).toBe(true);
  });

  it('refuses an ambiguous name after a direct 404', async () => {
    const h = harness((call) =>
      call.path === '/computers'
        ? json([other, { ...other, id: 'vm-second' }])
        : json({ error: 'no such ID' }, { status: 404 }),
    );
    const result = await h.run(['computers', 'delete', target]);
    expect(result.frames[0].error.code).toBe('ambiguous_computer');
    expect(h.rec.routes()).toEqual([
      ['GET', 'computers'],
      ['GET', `computers/${target}`],
    ]);
  });

  it('refuses a mismatched computer returned by the direct ID endpoint', async () => {
    const h = harness((call) =>
      call.path === '/computers' ? json([other]) : json({ ...lost, id: 'different-id' }),
    );
    const result = await h.run(['computers', 'delete', target]);
    expect(result.code).toBe(1);
    expect(h.rec.calls.every((call) => call.method === 'GET')).toBe(true);
  });
});

describe('exec preserves bytes, input and result semantics', () => {
  it('forwards seconds, cwd, env and desktop without changing the command', async () => {
    const h = harness((call) =>
      call.path.endsWith('/exec')
        ? json({
            ...EXEC_OK,
            exit_code: 7,
            stdout_b64: 'AP8=',
            stderr_b64: 'ZXJyCg==',
            out_truncated: true,
          })
        : anyRoute(call),
    );
    const text = "printf '%s\\n' '$HOME'\nexit 7";
    const result = await h.run([
      'computers',
      'exec',
      COMPUTER.id,
      '-c',
      text,
      '--timeout',
      '91',
      '--cwd',
      '/opt/work',
      '--env',
      'ONE=first',
      '--env',
      'TWO=second=2',
      '--desktop',
    ]);
    expect(h.rec.last().body).toEqual({
      command: text,
      timeout_s: 91,
      cwd: '/opt/work',
      env: { ONE: 'first', TWO: 'second=2' },
      session: 'desktop',
    });
    expect(result.code).toBe(7);
    expect(result.frames[0]).toMatchObject({
      ok: false,
      exit_code: 7,
      data: { exit_code: 7, stdout_base64: 'AP8=', stderr_base64: 'ZXJyCg==', out_truncated: true },
    });
    expect(result.err).toBe('');
  });

  it('reads piped command text unchanged', async () => {
    const input = 'echo first\nprintf second\n';
    const h = harness(anyRoute, input);
    expect((await h.run(['computers', 'exec', COMPUTER.id])).code).toBe(0);
    expect(h.rec.last().body).toEqual({ command: input, timeout_s: 30 });
  });

  it('returns a background handle and sends no foreground timeout', async () => {
    const h = harness();
    const result = await h.run([
      'computers',
      'exec',
      COMPUTER.name,
      '-c',
      'sleep 90',
      '--background',
      '--cwd',
      '/srv',
      '--env',
      'X=y',
      '--desktop',
    ]);
    expect(h.rec.last().body).toEqual({
      command: 'sleep 90',
      background: true,
      cwd: '/srv',
      env: { X: 'y' },
      session: 'desktop',
    });
    expect(result.frames[0].data).toMatchObject({ pid: 4242, running: true });
  });

  it('keeps plain stdout/stderr separate and reports incomplete output', async () => {
    const h = harness((call) =>
      call.path.endsWith('/exec')
        ? json({ ...EXEC_OK, stdout_b64: 'AP8=', stderr_b64: 'ZXJyCg==', err_truncated: true })
        : anyRoute(call),
    );
    const result = await h.run(['computers', 'exec', COMPUTER.id, '-c', 'print'], false);
    expect(result.bytes).toEqual(Buffer.from([0, 255]));
    expect(result.err).toContain('err\n');
    expect(result.err).toContain('incomplete');
  });

  it.each([
    [{ timed_out: true }, 124],
    [{ exit_code: null }, 1],
    [{ exit_code: 256 }, 1],
  ] as const)('does not report a failed or unknown execution as success', async (fields, code) => {
    const h = harness((call) =>
      call.path.endsWith('/exec') ? json({ ...EXEC_OK, ...fields }) : anyRoute(call),
    );
    expect((await h.run(['computers', 'exec', COMPUTER.id, '-c', 'work'])).code).toBe(code);
  });

  it.each([
    [['computers', 'exec', 'vm', '-c', 'echo hi'], 'piped input'],
    [['computers', 'exec', 'vm'], ''],
  ])('rejects conflicting or empty input before requests', async (args, input) => {
    const h = harness(anyRoute, input as string);
    const result = await h.run(args as string[]);
    expect(result.code).toBe(1);
    expect(h.rec.calls).toEqual([]);
  });
});

describe('executable process exit status', () => {
  it('normalizes fractional remote exit codes before the real entrypoint exits', async () => {
    const directory = await tempDir();
    const root = fileURLToPath(new URL('..', import.meta.url));
    execFileSync(
      process.execPath,
      [
        fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url)),
        '-p',
        'tsconfig.build.json',
        '--outDir',
        directory,
      ],
      { cwd: root, timeout: 30_000 },
    );
    await writeFile(
      join(directory, 'package.json'),
      JSON.stringify({
        type: 'module',
        imports: {
          '#credentials': {
            browser: './credentials-browser.js',
            node: './credentials.js',
            default: './credentials-browser.js',
          },
        },
      }),
    );
    const preload = join(directory, 'fetch.mjs');
    await writeFile(
      preload,
      `const computer = ${JSON.stringify(COMPUTER)};
globalThis.fetch = async (input) => new Response(JSON.stringify(String(input).endsWith('/exec') ? {exit_code:0.5,stdout_b64:'',stderr_b64:'',timed_out:false} : String(input).endsWith('/computers') ? [computer] : computer), {headers:{'content-type':'application/json'}});`,
    );
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        preload,
        join(directory, 'cli.js'),
        'computers',
        'exec',
        COMPUTER.id,
        '-c',
        'exit 0',
        '--json',
      ],
      {
        env: { ...process.env, MANDALA_API_KEY: 'com_executable_test', MANDALA_BASE_URL: BASE },
        encoding: 'utf8',
        timeout: 10_000,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      exit_code: 1,
      data: { exit_code: 0.5 },
    });
  }, 40_000);
});

describe('templates', () => {
  it('lists raw template fields and completeness', async () => {
    const h = harness(() => json([TEMPLATE_CHECK.template]));
    const result = await h.run(['templates', 'list']);
    expect(h.rec.routes()).toEqual([['GET', 'templates']]);
    expect(result.frames[0].data).toEqual({ items: [TEMPLATE_CHECK.template], incomplete: null });
  });

  it.each([
    ['get', 'GET'],
    ['retire', 'DELETE'],
  ])('%s uses namespace, name and explicit version', async (verb, method) => {
    const h = harness();
    const result = await h.run(['templates', verb!, 'acme', 'workbench', '--version', '2.3.4']);
    expect(h.rec.routes()).toEqual([[method, 'templates/acme/workbench']]);
    expect(h.rec.last().query).toEqual({ version: '2.3.4' });
    expect(result.code).toBe(0);
    expect(result.frames[0].data).toHaveProperty(verb === 'get' ? 'document' : 'retired');
  });

  it.each([
    ['validate', 'templates/validate'],
    ['publish', 'templates'],
    ['build', 'builds'],
  ])('%s sends the exact document bytes', async (verb, route) => {
    const document = '{"apiVersion":"mandala/v1","kind":"Template"}\n';
    const path = join(await tempDir(), 'template.json');
    await writeFile(path, document);
    const h = harness();
    const result = await h.run([
      'templates',
      verb!,
      path,
      ...(verb === 'build' ? ['--no-reuse'] : []),
    ]);
    expect(h.rec.routes()).toEqual([['POST', route]]);
    expect(Buffer.from(h.rec.last().raw!).toString()).toBe(document);
    expect(h.rec.last().query).toEqual(verb === 'build' ? { no_reuse: 'true' } : {});
    expect(result.code).toBe(0);
    expect(result.frames[0].data).toHaveProperty(
      verb === 'validate' ? 'valid' : verb === 'publish' ? 'document' : 'id',
    );
  });

  it('accepts template stdin and exposes invalid validation results', async () => {
    const h = harness(() => json({ valid: false, errors: ['invalid document'] }), 'bad document\n');
    const result = await h.run(['templates', 'validate', '-']);
    expect(result.code).toBe(1);
    expect(result.frames[0].data.valid).toBe(false);
    expect(Buffer.from(h.rec.last().raw!).toString()).toBe('bad document\n');
  });

  it('watches a build as NDJSON with a terminal summary', async () => {
    const h = harness(() => buildEvents());
    const result = await h.run(['templates', 'watch', 'bld-1']);
    expect(h.rec.routes()).toEqual([['GET', 'builds/bld-1/events']]);
    expect(result.code).toBe(0);
    expect(result.frames.map((f) => f.type)).toEqual(['progress', 'progress', 'done']);
    expect(result.frames.at(-1)).toMatchObject({
      schema_version: 2,
      command: 'templates watch',
      timestamp: stamp,
      data: { status: 'succeeded', done: true, exit_code: 0 },
    });
  });

  it.each(['failed', 'early EOF', 'stream error'])(
    'does not claim build success after %s',
    async (mode) => {
      const progress = {
        ...BUILD_PROGRESS,
        status: mode === 'failed' ? 'failed' : 'running',
        done: mode === 'failed',
      };
      const h = harness(
        () =>
          new Response(
            `event: ${mode === 'stream error' ? 'error' : mode === 'failed' ? 'done' : 'progress'}\ndata: ${JSON.stringify(progress)}\n\n`,
            { headers: { 'content-type': 'text/event-stream' } },
          ),
      );
      const result = await h.run(['templates', 'watch', 'build-other']);
      expect(result.code).toBe(1);
      expect(result.frames.at(-1).type).toBe(mode === 'failed' ? 'done' : 'error');
    },
  );
});

describe('snapshots', () => {
  it('lists with filters, unfinished rows and partial status', async () => {
    const unrelated = { ...SNAPSHOT, id: 'snapshot-other', computer_id: 'vm-other' };
    const h = harness(() => json([SNAPSHOT, unrelated], { headers: { 'X-GC-Incomplete': '1' } }));
    const result = await h.run([
      'snapshots',
      'list',
      '--computer',
      SNAPSHOT.computer_id,
      '--include-unfinished',
      '--allow-partial',
    ]);
    expect(h.rec.routes()).toEqual([['GET', 'snapshots']]);
    expect(h.rec.last().query).toEqual({ include: 'unfinished', allow_partial: '1' });
    expect(result.frames[0].data).toEqual({ items: [SNAPSHOT], incomplete: 1 });
  });

  it('captures with the requested name and memory without waiting', async () => {
    const h = harness();
    const result = await h.run([
      'snapshots',
      'create',
      COMPUTER.id,
      '--name',
      'checkpoint',
      '--memory',
      '--no-wait',
      '--timeout-ms',
      '93',
      '--poll-ms',
      '7',
    ]);
    expect(h.rec.routes()).toEqual([
      ['GET', 'computers'],
      ['POST', `computers/${COMPUTER.id}/snapshots`],
    ]);
    expect(h.rec.last().body).toEqual({ memory: true, name: 'checkpoint' });
    expect(result.frames[0].data.state).toBe('capturing');
  });

  it('waits for default snapshot capture completion', async () => {
    const h = harness();
    const result = await h.run(['snapshots', 'create', COMPUTER.id, '--poll-ms', '1']);
    expect(h.rec.routes()).toEqual([
      ['GET', 'computers'],
      ['POST', `computers/${COMPUTER.id}/snapshots`],
      ['GET', 'snapshots'],
    ]);
    expect(result.frames[0].data.state).toBe('durable');
  });

  it('restores the exact snapshot', async () => {
    const h = harness();
    const result = await h.run(['snapshots', 'restore', 'snapshot-8']);
    expect(h.rec.routes()).toEqual([['POST', 'snapshots/snapshot-8/restore']]);
    expect(result.frames[0].data).toEqual({ id: 'snapshot-8', restored: true });
  });

  it('clones the exact snapshot with a new computer name', async () => {
    const h = harness();
    const result = await h.run(['snapshots', 'clone', 'snapshot-8', '--name', 'recovered']);
    expect(h.rec.routes()).toEqual([['POST', 'snapshots/snapshot-8/clone']]);
    expect(h.rec.last().body).toEqual({ name: 'recovered' });
    expect(result.frames[0].data.id).toBe(COMPUTER.id);
  });

  // Platform OPL-4964: the two memory-clone flags map to the two options, and
  // the platform's answer about the session is in the output as it came.
  it.each([
    [['--disk-only'], { memory: false }],
    [['--inherit-secrets'], { inherit_secrets: true }],
  ])('clones with %j as %j', async (flags, body) => {
    const h = harness((call) =>
      call.path === '/snapshots/snapshot-8/clone'
        ? json({ ...COMPUTER, memory_dropped: true, memory_dropped_reason: 'secrets' })
        : anyRoute(call),
    );
    const result = await h.run(['snapshots', 'clone', 'snapshot-8', ...flags]);
    expect(h.rec.last().body).toEqual(body);
    expect(result.frames[0].data.memory_dropped).toBe(true);
    expect(result.frames[0].data.memory_dropped_reason).toBe('secrets');
  });

  it('refuses both memory-clone flags at once, before sending anything', async () => {
    const h = harness();
    const result = await h.run([
      'snapshots',
      'clone',
      'snapshot-8',
      '--disk-only',
      '--inherit-secrets',
    ]);
    expect(result.code).not.toBe(0);
    expect(h.rec.routes()).toEqual([]);
  });

  it.each([true, false])('deletes with no-wait=%s', async (noWait) => {
    const h = harness((call) => (call.path === '/snapshots' ? json([]) : anyRoute(call)));
    const result = await h.run([
      'snapshots',
      'delete',
      'snapshot-8',
      '--timeout-ms',
      '100',
      '--poll-ms',
      '1',
      ...(noWait ? ['--no-wait'] : []),
    ]);
    expect(h.rec.routes()).toEqual([
      ['DELETE', 'snapshots/snapshot-8'],
      ...(noWait ? [] : [['GET', 'snapshots']]),
    ]);
    expect(result.frames[0].data).toEqual({ id: 'snapshot-8', accepted: true, waited: !noWait });
  });

  it.each([
    [
      ['holdings'],
      'GET',
      `computers/${COMPUTER.id}/snapshots`,
      { count: 3, size_bytes: 4096, fingerprint: 'snapshot-set' },
    ],
    [
      ['schedule', 'get'],
      'GET',
      `computers/${COMPUTER.id}/schedule`,
      { enabled: true, hour: 11, minute: 23, tz: 'UTC' },
    ],
    [['schedule', 'clear'], 'DELETE', `computers/${COMPUTER.id}/schedule`, {}],
  ] as const)('%s returns the resource response', async (args, method, path, response) => {
    const h = harness((call) => (call.path === '/computers' ? json([COMPUTER]) : json(response)));
    const result = await h.run(['snapshots', ...args, COMPUTER.id]);
    expect(h.rec.routes()).toEqual([
      ['GET', 'computers'],
      [method, path],
    ]);
    expect(result.frames[0].data).toEqual(response);
  });

  it('sets a disabled schedule with distinct time fields', async () => {
    const h = harness((call) => (call.path === '/computers' ? json([COMPUTER]) : json(call.body)));
    const result = await h.run([
      'snapshots',
      'schedule',
      'set',
      COMPUTER.id,
      '--hour',
      '17',
      '--minute',
      '41',
      '--tz',
      'America/Chicago',
      '--disabled',
    ]);
    expect(h.rec.routes()).toEqual([
      ['GET', 'computers'],
      ['PUT', `computers/${COMPUTER.id}/schedule`],
    ]);
    expect(h.rec.last().body).toEqual({
      enabled: false,
      hour: 17,
      minute: 41,
      tz: 'America/Chicago',
    });
    expect(result.frames[0].data).toEqual(h.rec.last().body);
  });

  it('reads retention', async () => {
    const h = harness(() => json({ daily: 7, weekly: 4, monthly: 2 }));
    const result = await h.run(['snapshots', 'retention']);
    expect(h.rec.routes()).toEqual([['GET', 'retention']]);
    expect(result.frames[0].data).toEqual({ daily: 7, weekly: 4, monthly: 2 });
  });
});

describe('webhooks', () => {
  it.each([
    ['list', [], 'GET', 'webhooks', [WEBHOOK]],
    ['get', ['whk-1'], 'GET', 'webhooks/whk-1', WEBHOOK],
    ['delete', ['whk-1'], 'DELETE', 'webhooks/whk-1', { id: 'whk-1', deleted: true }],
    ['test', ['whk-1'], 'POST', 'webhooks/whk-1/test', WEBHOOK_DELIVERY],
    ['deliveries', ['whk-1'], 'GET', 'webhooks/whk-1/deliveries', [WEBHOOK_DELIVERY]],
  ] as const)(
    '%s uses the matching webhook resource',
    async (verb, args, method, path, expected) => {
      const h = harness();
      const result = await h.run(['webhooks', verb, ...args]);
      expect(h.rec.routes()).toEqual([[method, path]]);
      expect(result.frames[0].data).toEqual(expected);
    },
  );

  it('creates with repeated filters and prints the secret once', async () => {
    const h = harness();
    const result = await h.run([
      'webhooks',
      'create',
      'https://hooks.example.org/new',
      '--description',
      'build hook',
      '--event',
      'computer.ready',
      '--event',
      'process.exited',
      '--computer',
      'vm-a',
      '--computer',
      'vm-b',
      '--disabled',
    ]);
    expect(h.rec.routes()).toEqual([['POST', 'webhooks']]);
    expect(h.rec.last().body).toEqual({
      url: 'https://hooks.example.org/new',
      description: 'build hook',
      events: ['computer.ready', 'process.exited'],
      computers: ['vm-a', 'vm-b'],
      enabled: false,
    });
    expect(result.out.split(WEBHOOK_CREATED.secret)).toHaveLength(2);
    expect(result.err).not.toContain(WEBHOOK_CREATED.secret);
  });

  it('rotates once and prints only the newly returned secret', async () => {
    const h = harness();
    const result = await h.run(['webhooks', 'rotate', 'whk-1']);
    expect(h.rec.routes()).toEqual([['POST', 'webhooks/whk-1/rotate']]);
    expect(result.frames[0].data.secret).toBe(WEBHOOK_CREATED.secret);
    expect(result.err).not.toContain(WEBHOOK_CREATED.secret);
  });

  it.each([
    [
      [
        '--url',
        'https://hooks.example.org/changed',
        '--description',
        '',
        '--event',
        'computer.ready',
        '--computer',
        'vm-c',
        '--enable',
      ],
      {
        url: 'https://hooks.example.org/changed',
        description: '',
        events: ['computer.ready'],
        computers: ['vm-c'],
        enabled: true,
      },
    ],
    [
      ['--all-events', '--all-computers', '--disable'],
      { events: [], computers: [], enabled: false },
    ],
  ] as const)('updates without dropping filter semantics', async (flags, body) => {
    const h = harness();
    const result = await h.run(['webhooks', 'update', 'whk-1', ...flags]);
    expect(h.rec.routes()).toEqual([['PATCH', 'webhooks/whk-1']]);
    expect(h.rec.last().body).toEqual(body);
    expect(result.frames[0].data).toEqual(WEBHOOK);
  });

  it('does not expose a secret unexpectedly returned by a read', async () => {
    const h = harness(() => json(WEBHOOK_CREATED));
    const result = await h.run(['webhooks', 'get', 'whk-1']);
    expect(result.out).not.toContain(WEBHOOK_CREATED.secret);
    expect(result.frames[0].data.secret).toBeUndefined();
  });
});

describe('agent streams and cancellation', () => {
  it('uses the explicit target, prompt, options and model key with timestamped frames', async () => {
    const h = harness();
    const result = await h.run([
      'agent',
      'run',
      'Open the editor',
      '--computer',
      COMPUTER.id,
      '--max-steps',
      '13',
      '--model',
      'model-choice',
      '--system',
      'Use the desktop',
    ]);
    expect(h.rec.routes()).toEqual([
      ['GET', 'computers'],
      ['POST', `computers/${COMPUTER.id}/agent`],
    ]);
    expect(h.rec.last().body).toEqual({
      prompt: 'Open the editor',
      stream: true,
      max_steps: 13,
      model: 'model-choice',
      system: 'Use the desktop',
    });
    expect(h.rec.last().headers['X-Model-Key']).toBe('model_cli_test');
    expect(result.frames.map((frame) => frame.type)).toEqual(['step', 'done']);
    expect(result.frames[0].timestamp).toBe(stamp);
    expect(result.frames[1].data).toMatchObject({
      finished: true,
      steps: 1,
      stop: 'end_turn',
      exit_code: 0,
    });
    expect(result.out).not.toContain('model_cli_test');
    expect(result.out).not.toContain('com_cli_test');
  });

  it('keeps partial error accounting and does not emit a success summary', async () => {
    const data = {
      error: 'denied',
      status: 403,
      steps: [{ n: 1, tool: 'bash', detail: 'wrote file' }],
      usage: { input_tokens: 51, output_tokens: 17, cache_read_tokens: 12, cache_write_tokens: 4 },
    };
    const h = harness((call) =>
      call.path === '/computers'
        ? json([COMPUTER])
        : new Response(`event: error\ndata: ${JSON.stringify(data)}\n\n`, {
            headers: { 'content-type': 'text/event-stream' },
          }),
    );
    const result = await h.run(['agent', 'run', 'work', '--computer', COMPUTER.id]);
    expect(result.code).toBe(1);
    expect(result.frames.map((frame) => frame.type)).toEqual(['error']);
    expect(result.frames[0].data.error.details).toEqual({
      status: 403,
      steps: [{ n: 1, tool: 'bash', detail: 'wrote file' }],
      usage: { input_tokens: 51, output_tokens: 17, cache_read_tokens: 12, cache_write_tokens: 4 },
    });
  });

  it.each(['max_steps', 'refusal', 'rate_limited'])(
    'reports unfinished stop %s as nonzero',
    async (stop) => {
      const h = harness((call) =>
        call.path === '/computers'
          ? json([COMPUTER])
          : new Response(
              `event: done\ndata: ${JSON.stringify({ steps: 2, stop, text: 'stopped' })}\n\n`,
              { headers: { 'content-type': 'text/event-stream' } },
            ),
      );
      const result = await h.run(['agent', 'run', 'work', '--computer', COMPUTER.id]);
      expect(result.code).toBe(1);
      expect(result.frames[0].data).toMatchObject({ finished: false, stop, exit_code: 1 });
    },
  );

  it('fails when an agent stream ends before done', async () => {
    const h = harness((call) =>
      call.path === '/computers'
        ? json([COMPUTER])
        : new Response('event: text\ndata: {"text":"working"}\n\n', {
            headers: { 'content-type': 'text/event-stream' },
          }),
    );
    const result = await h.run(['agent', 'run', 'work', '--computer', COMPUTER.id]);
    expect(result.code).toBe(1);
    expect(result.frames.at(-1).type).toBe('error');
    expect(result.frames.some((frame) => frame.type === 'done')).toBe(false);
  });

  it('cancels a pending request and restores signal listeners', async () => {
    const h = harness(() => new Promise<Response>(() => {}));
    const before = process.listenerCount('SIGINT');
    const beforeTerm = process.listenerCount('SIGTERM');
    const pending = h.run(['computers', 'list']);
    await vi.waitFor(() => expect(h.rec.calls).toHaveLength(1));
    process.emit('SIGINT');
    const result = await pending;
    expect(result.code).toBe(130);
    expect(result.frames[0].error.code).toBe('cancelled');
    expect(process.listenerCount('SIGINT')).toBe(before);
    expect(process.listenerCount('SIGTERM')).toBe(beforeTerm);
  });

  it('plain output stays readable without color on pipes and NO_COLOR', async () => {
    const h = harness(anyRoute, undefined, { NO_COLOR: '1' });
    const result = await h.run(['agent', 'run', 'work', '--computer', COMPUTER.id], false);
    expect(result.out).toContain(`${stamp} step:`);
    expect(result.out).toContain(`${stamp} done:`);
    expect(result.out).not.toContain('\u001b');
  });
});

describe('legacy JSON modes', () => {
  it('rejects terminal --json before even creating a client', async () => {
    const h = harness();
    h.io.createClient = () => {
      throw new Error('must not connect');
    };
    const result = await h.run(['terminal', 'desktop']);
    expect(result.frames[0]).toMatchObject({ ok: false, error: { code: 'unsupported_mode' } });
    expect(h.rec.calls).toEqual([]);
  });

  it('refuses ssh --json with an error envelope before creating a client', async () => {
    const h = harness();
    h.io.createClient = () => {
      throw new Error('must not connect');
    };
    const result = await h.run(['--json', 'ssh', 'desktop'], false);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.out)).toMatchObject({
      ok: false,
      command: 'ssh',
      exit_code: 2,
      error: { code: 'unsupported_mode', message: 'ssh is interactive and has no --json output' },
    });
    expect(h.rec.calls).toEqual([]);
  });

  it('copies a binary download and reports one finite result', async () => {
    const path = join(await tempDir(), 'copy.bin');
    const h = harness(guestFile(Uint8Array.from([0, 255, 3, 4])));
    const result = await h.run(['scp', `${COMPUTER.name}:/tmp/input.bin`, path]);
    expect(await readFile(path)).toEqual(Buffer.from([0, 255, 3, 4]));
    expect(result.frames).toHaveLength(1);
    expect(result.frames[0].data).toEqual({
      source: `${COMPUTER.name}:/tmp/input.bin`,
      destination: path,
      bytes: 4,
      confirmed: true,
    });
    expect(h.rec.last().query).toEqual({ path: '/tmp/input.bin' });
  });

  it('copies an upload and distinguishes bytes sent from acknowledged', async () => {
    const path = join(await tempDir(), 'upload.bin');
    await writeFile(path, Uint8Array.from([0, 255, 9]));
    const h = harness((call) => (call.path === '/computers' ? json([COMPUTER]) : json({})));
    const result = await h.run(['scp', path, `${COMPUTER.name}:/tmp/out.bin`]);
    expect(h.rec.last().method).toBe('PUT');
    expect(h.rec.last().query).toEqual({ path: '/tmp/out.bin' });
    expect(h.rec.last().raw).toEqual(Uint8Array.from([0, 255, 9]));
    expect(result.frames[0].data).toMatchObject({
      bytes: 3,
      confirmed: false,
      accounting: '3 bytes sent',
    });
  });

  it('sends overwrite=false for scp --no-overwrite, and nothing otherwise (OPL-4994)', async () => {
    const path = join(await tempDir(), 'upload.bin');
    await writeFile(path, Uint8Array.from([1, 2]));
    const h = harness((call) =>
      call.path === '/computers' ? json([COMPUTER]) : json({ bytes: 2 }),
    );
    expect((await h.run(['scp', path, `${COMPUTER.name}:/tmp/out.bin`])).code).toBe(0);
    expect(h.rec.last().query).toEqual({ path: '/tmp/out.bin' });
    const result = await h.run(['scp', '--no-overwrite', path, `${COMPUTER.name}:/tmp/out.bin`]);
    expect(result.code).toBe(0);
    expect(h.rec.last().method).toBe('PUT');
    expect(h.rec.last().query).toEqual({ path: '/tmp/out.bin', overwrite: 'false' });
  });

  it('says plainly that scp --no-overwrite found the guest path taken', async () => {
    const path = join(await tempDir(), 'upload.bin');
    await writeFile(path, Uint8Array.from([1, 2]));
    const h = harness((call) =>
      call.path === '/computers'
        ? json([COMPUTER])
        : json({ error: 'a file already exists at that path', reason: 'exists' }, { status: 409 }),
    );
    const result = await h.run(['scp', '--no-overwrite', path, `${COMPUTER.name}:/tmp/out.bin`]);
    expect(result.code).toBe(1);
    expect(result.frames[0]).toMatchObject({
      ok: false,
      error: {
        code: 'exists',
        message: expect.stringContaining(`${COMPUTER.name}:/tmp/out.bin already exists`),
        details: { status: 409, reason: 'exists' },
      },
    });
    const human = await h.run(
      ['scp', '--no-overwrite', path, `${COMPUTER.name}:/tmp/out.bin`],
      false,
    );
    expect(human.code).toBe(1);
    expect(human.err).toContain('this upload wrote nothing');
    // A retry after a lost answer meets its own file; only THIS attempt is known.
    expect(human.err).toContain(
      "If an earlier attempt's outcome was unknown, the file may be yours: read it and compare",
    );
  });

  it.each([
    ['reasonless JSON', () => json({ error: 'a file already exists' }, { status: 409 })],
    ['an empty body', () => new Response('', { status: 409 })],
    ['a proxy page', () => new Response('<html>conflict</html>', { status: 409 })],
  ])(
    'never calls a create-only conflict with no usable reason `exists` in scp (%s)',
    async (_kind, answer) => {
      const path = join(await tempDir(), 'upload.bin');
      await writeFile(path, Uint8Array.from([1, 2]));
      const h = harness((call) => (call.path === '/computers' ? json([COMPUTER]) : answer()));
      const result = await h.run(['scp', '--no-overwrite', path, `${COMPUTER.name}:/tmp/out.bin`]);
      expect(result.code).toBe(1);
      expect(result.frames[0]).toMatchObject({
        ok: false,
        error: {
          code: 'conflict',
          message: expect.stringContaining('refused as a conflict, reason unknown'),
        },
      });
      const said = JSON.stringify(result.frames[0]);
      expect(said).not.toContain('already exists');
      // Even the JSON one: a reasonless 409 does not prove the write never landed.
      expect(said).not.toContain('wrote nothing');
      expect(said).toContain('whether this upload wrote anything is unconfirmed');
    },
  );

  it('refuses scp --no-overwrite on a download before any request', async () => {
    const path = join(await tempDir(), 'copy.bin');
    const h = harness(guestFile(Uint8Array.from([1])));
    const result = await h.run(['scp', '--no-overwrite', `${COMPUTER.name}:/tmp/in.bin`, path]);
    expect(result.code).toBe(1);
    expect(result.frames[0].error).toMatchObject({
      code: 'invalid_arguments',
      message: '--no-overwrite applies to an upload, not a download',
    });
    expect(h.rec.calls).toEqual([]);
  });
});

describe('wait options and signal cleanup', () => {
  it.each(['computer', 'capture', 'deletion'])(
    'forwards the %s deadline and polling interval',
    async (kind) => {
      vi.useFakeTimers();
      const started = Date.now();
      const polls: number[] = [];
      const building = { ...COMPUTER, status: 'building' };
      const capturing = { ...SNAPSHOT, state: 'capturing' };
      const h = harness((call) => {
        if (call.path === '/computers') return json([building]);
        if (call.method === 'GET') {
          polls.push(Date.now() - started);
          return json(call.path === '/snapshots' ? [capturing] : building);
        }
        return json(capturing, { status: 202 });
      });
      const args =
        kind === 'computer'
          ? ['computers', 'wait', COMPUTER.id, '--until', 'built']
          : [
              'snapshots',
              kind === 'capture' ? 'create' : 'delete',
              kind === 'capture' ? COMPUTER.id : SNAPSHOT.id,
            ];
      const pending = h.run([...args, '--timeout-ms', '21', '--poll-ms', '8']);
      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(polls).toEqual([0]);
        await vi.advanceTimersByTimeAsync(16);
        expect(polls).toEqual([0, 8, 16]);
        await vi.advanceTimersByTimeAsync(5);
        const result = await pending;
        expect(result.code).toBe(1);
        expect(result.frames[0].error).toMatchObject({ code: 'timeout' });
        expect(result.frames[0].error.message).toContain('21ms');
      } finally {
        process.emit('SIGINT');
        await pending;
        vi.useRealTimers();
      }
    },
  );

  it('cancels while reading piped input without starting a request', async () => {
    const h = harness();
    const stdin = Object.assign(new Readable({ read() {} }), { isTTY: false });
    h.io.stdin = stdin;
    const before = process.listenerCount('SIGINT');
    const pending = h.run(['computers', 'exec', COMPUTER.id]);
    await vi.waitFor(() => expect(process.listenerCount('SIGINT')).toBe(before + 1));
    process.emit('SIGINT');
    const result = await pending;
    expect(result.code).toBe(130);
    expect(h.rec.calls).toEqual([]);
    expect(stdin.destroyed).toBe(true);
    expect(process.listenerCount('SIGINT')).toBe(before);
  });

  it('cancels an open agent stream through the fetch signal', async () => {
    let responseController: ReadableStreamDefaultController<Uint8Array>;
    let aborted = false;
    const h = harness((call) =>
      call.path === '/computers'
        ? json([COMPUTER])
        : new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                responseController = controller;
                controller.enqueue(
                  new TextEncoder().encode('event: step\ndata: {"n":1,"tool":"bash"}\n\n'),
                );
              },
            }),
            { headers: { 'content-type': 'text/event-stream' } },
          ),
    );
    h.io.createClient = () =>
      new Client({
        apiKey: 'com_cli_test',
        baseUrl: BASE,
        fetch: async (input, init) => {
          const response = await h.rec.fetch(input, init);
          // Native fetch rejects pending response-body reads when its signal aborts.
          if (String(input).endsWith('/agent'))
            init?.signal?.addEventListener(
              'abort',
              () => {
                aborted = true;
                responseController.error(init.signal?.reason);
              },
              { once: true },
            );
          return response;
        },
      });
    const before = process.listenerCount('SIGINT');
    const pending = h.run(['agent', 'run', 'work', '--computer', COMPUTER.id]);
    await vi.waitFor(() => expect(h.rec.calls).toHaveLength(2));
    process.emit('SIGINT');
    const result = await pending;
    expect(result.code).toBe(130);
    expect(result.frames.at(-1)).toMatchObject({
      type: 'error',
      data: { error: { code: 'cancelled' } },
    });
    expect(aborted).toBe(true);
    expect(process.listenerCount('SIGINT')).toBe(before);
  });
});

describe('malformed arguments are offline failures', () => {
  it.each([
    ['unknown'],
    ['computers'],
    ['computers', 'list', '--unknown'],
    ['computers', 'list', '--state', 'running'],
    ['computers', 'create', '--cpu', 'nan'],
    ['computers', 'create', '--cpu', '0'],
    ['computers', 'create', '--size', 'small', '--template', 'base'],
    ['computers', 'create', '--template-transfer', 'token'],
    ['computers', 'stop', 'vm', '--force=true'],
    ['computers', 'delete', 'vm', '--delete-snapshots'],
    ['computers', 'delete', 'vm', '--expect', 'fp'],
    ['computers', 'screenshot', 'vm'],
    ['computers', 'screenshot', 'vm', '-o', '/tmp/x', '--width', '-1'],
    ['computers', 'screenshot', 'vm', '-o', '/tmp/x', '--width', '320', '--scale', '0.5'],
    ['computers', 'screenshot', 'vm', '-o', '/tmp/x', '--scale', '2'],
    ['computers', 'screenshot', 'vm', '-o', '/tmp/x', '--region', '0,0,10'],
    ['computers', 'screenshot', 'vm', '-o', '/tmp/x', '--region', '0,0,-1,10'],
    ['computers', 'screenshot', 'vm', '-o', '/tmp/x', '--format', 'webp'],
    ['computers', 'screenshot', 'vm', '-o', '/tmp/x', '--quality', '60'],
    ['computers', 'exec', 'vm', '-c', 'true', '--background', '--timeout', '8'],
    ['computers', 'exec', 'vm', '-c', 'true', '--timeout', '601'],
    ['computers', 'exec', 'vm', '-c', 'true', '--env', 'bad'],
    ['computers', 'exec', 'vm', '-c', 'true', '--env', 'X=1', '--env', 'X=2'],
    ['computers', 'wait', 'vm', '--until', 'ready'],
    ['computers', 'wait', 'vm', '--poll-ms', '0'],
    ['snapshots', 'create', 'vm', '--timeout-ms', '-2'],
    ['snapshots', 'schedule', 'set', 'vm', '--hour', '24'],
    ['templates', 'get', 'acme', 'demo', '--version', 'bad'],
    ['webhooks', 'update', 'whk'],
    ['webhooks', 'update', 'whk', '--enable', '--disable'],
    ['webhooks', 'update', 'whk', '--event', 'x', '--all-events'],
    ['webhooks', 'update', 'whk', '--computer', 'x', '--all-computers'],
    ['webhooks', 'create', 'http://insecure.example.com'],
    ['agent', 'run', 'work'],
    ['agent', 'run', 'work', '--computer', 'vm', '--max-steps', '101'],
    ['completion', 'unknown'],
    ['computers', 'get', ''],
    ['computers', 'get', 'vm', 'extra'],
  ])('%j makes no requests', async (...argv) => {
    const h = harness();
    const result = await h.run(argv);
    expect(result.code).toBe(1);
    expect(h.rec.calls).toEqual([]);
  });
});

// These checks use the real runtime factory, including the actual legacy terminal/SCP dispatch.
describe('credential-free discovery and profile dispatch', () => {
  it('O01-offline: discovery ignores an unavailable home and malformed unused profile', async () => {
    const lookup = vi.spyOn(os, 'homedir').mockImplementation(() => {
      throw new Error('home lookup forbidden');
    });
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal('fetch', fetch);
    try {
      for (const args of [['--help'], ['login', '--help'], ['manifest'], ['completion', 'bash']]) {
        const h = harness();
        const result = await h.run([...args, '--profile', '../unused']);
        expect(result.code).toBe(0);
      }
      expect(lookup).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      lookup.mockRestore();
      vi.unstubAllGlobals();
    }
  });
  it('O02-profile-cli-paths: list, account, usage, SSH and SCP use Work and its bound base', async () => {
    const home = await tempDir();
    const directory = join(home, '.mandala');
    fs.mkdirSync(directory, { mode: 0o700 });
    const fixture = JSON.parse(
      await readFile(new URL('./fixtures/credentials-v1.json', import.meta.url), 'utf8'),
    );
    fs.writeFileSync(join(directory, 'credentials.json'), JSON.stringify(fixture.base_document), {
      mode: 0o600,
    });
    const key = fixture.base_document.profiles.Work.api_key;
    const lookup = vi.spyOn(os, 'homedir').mockReturnValue(home);
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ error: `Revoked ${key}`, reason: 'revoked' }, { status: 401 }),
    );
    vi.stubGlobal('fetch', fetch);
    try {
      for (const args of [
        ['computers', 'list'],
        ['account'],
        ['usage'],
        ['terminal', 'demo'],
        ['scp', 'demo:/tmp/file', join(home, 'out')],
      ]) {
        let text = '';
        fetch.mockClear();
        const write = ((s: unknown) => {
          text += s;
          return true;
        }) as NodeJS.WritableStream['write'];
        expect(
          await main([...args, '--profile', 'Work'], {
            env: {},
            stdout: { write },
            stderr: { write },
            stdin: Readable.from([]),
          }),
        ).toBe(1);
        expect(fetch.mock.calls.length).toBeGreaterThan(0);
        for (const [url, init] of fetch.mock.calls) {
          expect(String(url)).toMatch(/^https:\/\/beta\.example\.test\/api\/v1\//);
          expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${key}`);
        }
        expect(text).not.toContain(key);
        expect(text).toContain('[REDACTED]');
      }
      for (const command of ['account', 'usage']) {
        const quota = accountReport();
        quota.plan.label = key;
        const usage = structuredClone(USAGE);
        usage.usage.computers[0]!.name = key;
        fetch.mockImplementation(async () => Response.json(command === 'account' ? quota : usage));
        let text = '';
        const write = ((s: unknown) => {
          text += s;
          return true;
        }) as NodeJS.WritableStream['write'];
        expect(
          await main([command, '--profile', 'Work'], {
            env: {},
            stdout: { write },
            stderr: { write },
          }),
        ).toBe(0);
        expect(text).not.toContain(key);
        expect(text).toContain('[REDACTED]');
      }
    } finally {
      lookup.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});

describe('one JSON casing and one error vocabulary (OPL-5048)', () => {
  it('prints the full usage under a mistyped command, counting the extra argument', async () => {
    const h = harness();
    const result = await h.run(['computers', 'exec', 'demo', '-c', 'echo', 'extra-arg'], false);
    expect(result.code).toBe(1);
    expect(result.err).toContain(
      'mandala: 1 argument too many: mandala computers exec takes <computer> and ' +
        'nothing more (quote a value that has spaces in it)',
    );
    expect(result.err).not.toContain('extra-arg');
    // The whole usage, not the one line that used to be the message.
    expect(result.err).toContain('  mandala computers exec <computer>\n');
    expect(result.err).toContain('--command');
    expect(result.err).toContain('--desktop');
    expect(h.rec.calls).toEqual([]);
  });

  it('carries the usage in the JSON error, beside a reason-style code', async () => {
    const h = harness();
    const result = await h.run(['computers', 'get']);
    expect(result.frames).toHaveLength(1);
    expect(result.frames[0]).toMatchObject({
      schema_version: 2,
      ok: false,
      exit_code: 1,
      error: {
        code: 'invalid_arguments',
        message: 'missing <computer>',
        usage: expect.stringContaining('mandala computers get <computer>'),
      },
    });
  });

  it('never echoes a secret value typed where secrets set reads stdin', async () => {
    // The usage error fires before any command has registered a value for
    // redaction, so the only protection is not quoting operands at all.
    const token = 'sk-live-0123456789-do-not-echo';
    for (const jsonMode of [true, false]) {
      const h = harness();
      const result = await h.run(['secrets', 'set', 'OPENAI_API_KEY', token], jsonMode);
      expect(result.code).toBe(1);
      expect(result.out + result.err).not.toContain(token);
      expect(result.out + result.err).toContain(
        '1 argument too many: mandala secrets set takes <name> and nothing more',
      );
      expect(h.rec.calls).toEqual([]);
    }
    // Nor one that starts with a dash, which the parser reads as an option.
    const h = harness();
    const dashed = `-${token}`;
    const result = await h.run(['secrets', 'set', 'OPENAI_API_KEY', dashed]);
    expect(result.code).toBe(1);
    expect(result.out + result.err).not.toContain(token);
    expect(result.frames[0].error.message).toBe(
      'unknown option, not repeated here, as under secrets it may be a secret value; secrets set ' +
        'reads the value from stdin or a hidden prompt, never argv',
    );
  });

  it('never echoes a secret shaped like an option name, or one typed after --', async () => {
    // `--sk-demo-123` reads exactly like a mistyped flag, and `-- --sk-demo-123`
    // is the standard way to pass a value that starts with a dash; neither may
    // come back in a diagnostic, in text or in --json.
    const secret = 'sk-demo-123';
    const cases: [string[], string][] = [
      [['--', `--${secret}`], '1 argument too many: mandala secrets set takes <name>'],
      [['--', secret, `--${secret}`], '2 arguments too many: mandala secrets set takes <name>'],
      [[`--${secret}`], 'unknown option, not repeated here, as under secrets it may be a secret'],
      [[`--keep-newline=${secret}`], 'unknown option, not repeated here'],
      [[`--workspace=ws-1`, `--${secret}`], 'unknown option, not repeated here'],
    ];
    for (const [tail, message] of cases)
      for (const jsonMode of [true, false]) {
        // --json goes first: after -- it would be one more operand.
        const h = harness();
        const argv = ['secrets', 'set', 'OPENAI_API_KEY', ...tail];
        const result = await h.run(jsonMode ? ['--json', ...argv] : argv, false);
        expect(result.code).toBe(1);
        if (jsonMode) expect(JSON.parse(result.out).error.code).toBe('invalid_arguments');
        expect(result.out + result.err).not.toContain(secret);
        expect(result.out + result.err).toContain(message);
        expect(h.rec.calls).toEqual([]);
      }
    // An option typed before the verb, or before secrets itself, is judged
    // by the command it was meant for, read past options, help and --. The
    // stdin hint belongs to secrets set, or to no verb at all.
    const setHint =
      'unknown option, not repeated here, as under secrets it may be a secret value; secrets set ' +
      'reads the value from stdin or a hidden prompt, never argv';
    for (const argv of [
      ['secrets', `--${secret}`, 'set', 'A'],
      [`--${secret}`, 'secrets', 'set', 'A'],
      ['--profile', 'p', `--${secret}`, 'secrets', 'set', 'A'],
      [`--${secret}`, '--profile', 'p', 'secrets', 'set', 'A'],
      [`--${secret}`, 'help', 'secrets', 'set'],
      [`--${secret}`, '--', 'secrets', 'set', 'A'],
      [`--${secret}`, 'help', 'secrets'],
      [`--${secret}`, '--', 'secrets'],
      ['secrets', `--${secret}`],
      [`--${secret}`, 'secrets', 'ls'],
      // --profile with its value left out: secrets is read as the command.
      [`--${secret}`, '--profile', 'secrets', 'set', 'A'],
      [`--${secret}`, '--profile', 'secrets'],
      // A profile named like a command is still read as one.
      [`--${secret}`, '--profile', 'computers', 'secrets', 'set', 'A'],
      // The same, with --profile typed first: parsing has already taken the
      // word as its value, and it is read as the command too.
      ['--profile', 'secrets', `--${secret}`, 'set', 'A'],
      ['--profile', 'secrets', `--${secret}`],
      ['--profile', 'computers', `--${secret}`, 'secrets', 'set', 'A'],
      // A verb under the group reached is command-shaped as well.
      ['secrets', `--${secret}`, '--profile', 'set', 'A'],
      ['secrets', '--profile', 'set', `--${secret}`, 'A'],
      // Read as the command, these pass over fewer words than read as a
      // profile: `usage` sits past a verb, and `0123` may be the value's tail.
      ['--profile', 'secrets', `--${secret}`, 'set', 'usage'],
      ['--profile', 'secrets', `--${secret}`, '0123', 'set', 'A'],
      [`--${secret}`, '--profile', 'secrets', 'set', 'usage'],
    ])
      for (const jsonMode of [true, false]) {
        // --json goes first: after -- it would be one more operand.
        const h = harness();
        const result = await h.run(jsonMode ? ['--json', ...argv] : argv, false);
        expect(result.code).toBe(1);
        if (jsonMode) {
          const error = JSON.parse(result.out).error;
          expect(error.code).toBe('invalid_arguments');
          expect(error.message).toBe(setHint);
        }
        expect(result.out + result.err).not.toContain(secret);
        expect(result.out + result.err).toContain(setHint);
        expect(h.rec.calls).toEqual([]);
      }
    // list and rm read no value, so they do not point at stdin, wherever the
    // option sits.
    for (const argv of [
      ['secrets', 'list', `--${secret}`],
      ['secrets', 'rm', 'A', `--${secret}`],
      ['secrets', `--${secret}`, 'list'],
      [`--${secret}`, 'secrets', 'list'],
      ['--profile', 'p', `--${secret}`, 'secrets', 'rm', 'A'],
      [`--${secret}`, 'help', 'secrets', 'list'],
      [`--${secret}`, '--', 'secrets', 'rm', 'A'],
      [`--${secret}`, '--profile', 'secrets', 'list'],
      ['--profile', 'secrets', `--${secret}`, 'list'],
      // A --profile value that is a verb under secrets is read as that verb.
      ['secrets', `--${secret}`, '--profile', 'list'],
      ['secrets', '--profile', 'list', `--${secret}`],
      ['secrets', `--${secret}`, '--profile', 'rm', 'A'],
    ]) {
      // --json goes first: after -- it would be one more operand.
      const result = await harness().run(['--json', ...argv], false);
      expect(result.code).toBe(1);
      expect(result.out + result.err).not.toContain(secret);
      expect(JSON.parse(result.out).error.message).toBe(
        'unknown option, not repeated here, as under secrets it may be a secret value',
      );
    }
    // A second --profile is refused as the parse would refuse it, before either
    // could be read as the one whose value was left out.
    for (const argv of [
      [`--${secret}`, '--profile', 'computers', '--profile', 'secrets', 'set', 'A'],
      [`--${secret}`, '--profile', 'computers', '--profile=secrets', 'set', 'A'],
      ['--profile', 'p', `--${secret}`, '--profile', 'secrets', 'set', 'A'],
      ['--profile', 'computers', `--${secret}`, '--profile', 'secrets', 'set', 'A'],
      ['--jsno', '--profile', 'a', '--profile', 'b', 'computers', 'list'],
    ]) {
      const result = await harness().run(['--json', ...argv], false);
      expect(result.code).toBe(1);
      expect(result.out + result.err).not.toContain(secret);
      expect(JSON.parse(result.out).error.message).toBe('--profile may only be supplied once');
    }
    // A word under secrets that is no verb is not repeated either: it is as
    // likely the value as a mistyped verb.
    for (const word of [secret, 'ls']) {
      const verb = await harness().run(['secrets', word]);
      expect(verb.code).toBe(1);
      if (word === secret) expect(verb.out + verb.err).not.toContain(word);
      expect(verb.frames[0].error.message).toBe(
        'unknown command under secrets; choose one of: list, set, rm (the word typed is not ' +
          'repeated here, as under secrets it may be a secret value)',
      );
    }
    // An option typed before any other command is still named.
    for (const argv of [
      ['--jsno', 'computers', 'list'],
      ['--jsno', 'help', 'computers', 'list'],
      ['--jsno', '--', 'computers', 'list'],
      ['--jsno', 'computers'],
      ['--jsno', '--profile', 'computers', 'list'],
      ['--profile', 'computers', '--jsno', 'list'],
      ['--profile', 'p', '--jsno', 'computers', 'list'],
      ['computers', '--jsno', '--profile', 'list'],
      // A profile given with = was not left out, so it is no command.
      ['--profile=secrets', '--jsno', 'set', 'A'],
      // A profile named secrets, before a command outside it: read as the
      // command, secrets would have to take computers for a value.
      ['--profile', 'secrets', '--jsno', 'computers', 'list'],
      ['--profile', 'secrets', '--jsno', 'computers'],
      ['--profile', 'secrets', 'computers', '--jsno', 'list'],
      ['--jsno', '--profile', 'secrets', 'computers', 'list'],
    ]) {
      const early = await harness().run(['--json', ...argv], false);
      expect(JSON.parse(early.out).error.message).toBe('unknown option --jsno');
    }
    // A --json past -- is an operand, so a usage error is not reported as JSON.
    const operand = await harness().run(['secrets', 'set', 'A', '--', '--json'], false);
    expect(operand.code).toBe(1);
    expect(operand.out).toBe('');
    expect(operand.err).toContain('1 argument too many: mandala secrets set takes <name>');
    expect(() => JSON.parse(operand.err)).toThrow();
    // Outside secrets, a mistyped flag is still named, which is the point of naming it.
    const typo = await harness().run(['computers', 'list', '--jsno']);
    expect(typo.frames[0].error.message).toBe('unknown option --jsno');
    const unknown = await harness().run(['computers', 'lsit']);
    expect(unknown.frames[0].error.message).toBe('unknown command computers lsit');
    // The same holds for an option shaped like a secret: that line was for
    // computers, run under a profile named secrets.
    const named = await harness().run(
      ['--json', '--profile', 'secrets', `--${secret}`, 'computers', 'list'],
      false,
    );
    expect(JSON.parse(named.out).error.message).toBe(`unknown option --${secret}`);
  });

  it('reads a left-out --profile again without counting the options after it twice', () => {
    // --profile is the only global option that takes a value today. With a
    // second one, the reading from where --profile's value sat walks over
    // that option again, and must not take it for one typed twice.
    const flags = GLOBAL_FLAGS as Flag[];
    flags.push({ name: 'region', type: 'string', description: 'test only' });
    try {
      for (const argv of [
        ['--profile', 'secrets', '--region', 'r', '--sk-demo-123', 'set', 'A'],
        ['--profile', 'secrets', '--region=r', '--sk-demo-123', 'set', 'A'],
      ])
        expect(() => parseArgs(argv)).toThrow(
          'unknown option, not repeated here, as under secrets it may be a secret value; ' +
            'secrets set reads the value from stdin',
        );
      // One typed twice is still refused, wherever the second sits.
      for (const argv of [
        ['--profile', 'secrets', '--region', 'r', '--sk-demo-123', '--region', 's', 'set'],
        ['--profile', 'secrets', '--sk-demo-123', '--region', 'r', '--region', 's', 'set'],
      ])
        expect(() => parseArgs(argv)).toThrow('--region may only be supplied once');
    } finally {
      flags.pop();
    }
  });

  it('waits for bound secrets with computers wait --until secrets', async () => {
    let gets = 0;
    const h = harness(() => {
      gets++;
      return json({
        ...COMPUTER,
        status: 'running',
        secrets: [{ secret_id: 'csec-0123456789abcdef', revision_id: 'csr-1', env: 'TOKEN' }],
        secrets_delivering: gets < 3,
      });
    });
    const result = await h.run([
      'computers',
      'wait',
      COMPUTER.id,
      '--until',
      'secrets',
      '--poll-ms',
      '1',
    ]);
    expect(result.code).toBe(0);
    expect(result.frames[0].data.secrets_delivering).toBe(false);
    expect(h.rec.routes().every(([method]) => method === 'GET')).toBe(true);
  });

  it('names an API refusal by what went wrong, never by a class name', async () => {
    const h = harness(() => json({ error: 'computer not found' }, { status: 404 }));
    const result = await h.run(['computers', 'get', 'vm-000000000000']);
    expect(result.frames[0].error).toEqual({
      code: 'not_found',
      message: 'computer not found',
      status: 404,
    });
  });

  it("passes the platform's reason word through beside the code", async () => {
    const h = harness(() => json({ error: 'not running', reason: 'unavailable' }, { status: 409 }));
    const result = await h.run(['computers', 'get', 'vm-000000000000']);
    expect(result.frames[0].error).toMatchObject({
      code: 'conflict',
      status: 409,
      reason: 'unavailable',
    });
  });

  it('writes no camelCase key in an envelope or in data the CLI decoded', async () => {
    const camel = /"[a-z]+[A-Z][A-Za-z0-9]*"\s*:/;
    for (const [args, respond] of [
      [['account'], () => json(accountReport())],
      [['usage'], () => json(USAGE)],
      [
        ['computers', 'exec', 'vm-000000000000', '-c', 'true'],
        (call: Call) => json(call.path.endsWith('/exec') ? EXEC_OK : COMPUTER),
      ],
      [['manifest'], anyRoute],
    ] as [string[], Responder][]) {
      const result = await harness(respond).run(args);
      expect(result.out, args.join(' ')).not.toMatch(camel);
      expect(result.frames[0].schema_version).toBe(2);
    }
  });
});

describe('files, rename, resize, view, and secrets bound at create', () => {
  const OTHER = { ...SECRET, id: 'csec-fedcba9876543210', name: 'gh-token' };
  const store = (list: unknown = { ...SECRET_LIST, secrets: [SECRET, OTHER] }): Responder => {
    return (call) =>
      call.path === '/secrets' && call.method === 'GET' ? json(list) : anyRoute(call);
  };

  it('binds a stored secret as a variable and another as a file, each found by name', async () => {
    const h = harness(store());
    const result = await h.run([
      'computers',
      'create',
      '--secret',
      'openai_api_key',
      '--secret-file',
      'gh-token',
    ]);
    expect(result.code).toBe(0);
    expect(h.rec.routes()).toEqual([
      ['GET', 'secrets'],
      ['POST', 'computers'],
    ]);
    // The default scope: nothing names a workspace.
    expect(h.rec.calls[0]!.query).toEqual({});
    // Matched ignoring ASCII case, and bound under the name the store keeps.
    expect(h.rec.last().body).toEqual({
      start: true,
      secrets: [
        { secret_id: SECRET.id, env: 'OPENAI_API_KEY' },
        { secret_id: OTHER.id, file: 'gh-token' },
      ],
    });
  });

  it('binds under the variable or file named after =, and accepts an id', async () => {
    const h = harness(store());
    await h.run([
      'computers',
      'create',
      '--secret',
      `${SECRET.id}=MY_KEY`,
      '--secret-file',
      'gh-token=gh',
    ]);
    expect(h.rec.last().body).toMatchObject({
      secrets: [
        { secret_id: SECRET.id, env: 'MY_KEY' },
        { secret_id: OTHER.id, file: 'gh' },
      ],
    });
  });

  it('splits at the last =, so a name holding one can still be bound', async () => {
    const odd = { ...SECRET, name: 'a=b' };
    const h = harness(store({ ...SECRET_LIST, secrets: [odd] }));
    await h.run(['computers', 'create', '--secret', 'a=b=AB']);
    expect(h.rec.last().body).toMatchObject({ secrets: [{ secret_id: odd.id, env: 'AB' }] });
  });

  it('sends an id the default scope does not list, and only with a name to bind it as', async () => {
    const unlisted = 'csec-00000000000000aa';
    const named = harness(store());
    await named.run(['computers', 'create', '--secret', `${unlisted}=WS_KEY`]);
    expect(named.rec.last().body).toMatchObject({
      secrets: [{ secret_id: unlisted, env: 'WS_KEY' }],
    });
    const bare = harness(store());
    const result = await bare.run(['computers', 'create', '--secret', unlisted]);
    expect(result.code).toBe(1);
    expect(result.frames[0].error).toMatchObject({
      code: 'invalid_arguments',
      message: expect.stringContaining(`--secret ${unlisted} --as VAR`),
    });
    expect(bare.rec.routes()).toEqual([['GET', 'secrets']]);
  });

  it('refuses a name the store does not hold, and creates nothing', async () => {
    const h = harness(store());
    const result = await h.run(['computers', 'create', '--secret', 'NOPE']);
    expect(result.code).toBe(1);
    expect(result.frames[0].error).toMatchObject({
      code: 'not_found',
      message: expect.stringContaining('nothing was created'),
    });
    expect(h.rec.routes()).toEqual([['GET', 'secrets']]);
  });

  it('refuses a default the name cannot be, and asks for one', async () => {
    // OPENAI_API_KEY is a fine variable and not a file: files are lowercase.
    const h = harness(store());
    const result = await h.run(['computers', 'create', '--secret-file', 'OPENAI_API_KEY']);
    expect(result.code).toBe(1);
    expect(result.frames[0].error.message).toContain('"OPENAI_API_KEY" --path FILE');
    expect(h.rec.routes()).toEqual([['GET', 'secrets']]);
  });

  it("refuses a secret whose name is another one's id, rather than guess", async () => {
    const trap = { ...OTHER, name: SECRET.id };
    const h = harness(store({ ...SECRET_LIST, secrets: [SECRET, trap] }));
    const result = await h.run(['computers', 'create', '--secret', `${SECRET.id}=X`]);
    expect(result.frames[0].error).toMatchObject({
      code: 'ambiguous_secret',
      message: expect.stringContaining('nothing was created'),
    });
    expect(h.rec.routes()).toEqual([['GET', 'secrets']]);
  });

  it('says delivery is off before creating a computer that could not hold them', async () => {
    const h = harness(store({ ...SECRET_LIST, delivery: false }));
    const result = await h.run(['computers', 'create', '--secret', 'OPENAI_API_KEY']);
    expect(result.frames[0].error).toMatchObject({ code: 'unsupported' });
    expect(h.rec.routes()).toEqual([['GET', 'secrets']]);
  });

  it('never quotes what follows =, which may be the value typed by mistake', async () => {
    const value = 'sk-live-do-not-print-me';
    const h = harness(store());
    for (const jsonMode of [true, false]) {
      const result = await h.run(
        ['computers', 'create', '--secret', `OPENAI_API_KEY=${value}`],
        jsonMode,
      );
      expect(result.code).toBe(1);
      expect(result.out + result.err).not.toContain(value);
      expect(result.out + result.err).toContain('never the value');
    }
    expect(h.rec.calls).toEqual([]);
  });

  it('never quotes a value holding =, which the last-= split would move into the key', async () => {
    // Base64 padding, an = inside the value, and one whose tail passes as a
    // variable name so the lookup (not the pattern) is what fails.
    for (const [typed, secretPart] of [
      ['OPENAI_API_KEY=c2VjcmV0dmFsdWU=', 'c2VjcmV0dmFsdWU'],
      ['K=abc=def-ghi', 'abc'],
      ['OPENAI_API_KEY=sk9livevalue=TAIL', 'sk9livevalue'],
    ]) {
      for (const jsonMode of [true, false]) {
        const h = harness(store());
        const result = await h.run(['computers', 'create', '--secret', typed!], jsonMode);
        expect(result.code, typed).toBe(1);
        const printed = result.out + result.err;
        expect(printed, typed).not.toContain(secretPart);
        expect(printed, typed).not.toContain('TAIL');
        // Still says which one: its flag, its position, what precedes the first =.
        expect(printed, typed).toContain('--secret #1');
        expect(printed, typed).toContain(`${typed!.slice(0, typed!.indexOf('='))}=…`);
        expect(h.rec.routes().filter(([m]) => m === 'POST')).toEqual([]);
      }
    }
  });

  it('refuses two bindings into one variable or file without quoting the target', async () => {
    for (const argv of [
      ['--secret', 'openai_api_key=SAMEVALUE1', '--secret', 'gh-token=SAMEVALUE1'],
      ['--secret-file', 'openai_api_key=samevalue1', '--secret-file', 'gh-token=samevalue1'],
    ]) {
      const h = harness(store());
      const result = await h.run(['computers', 'create', ...argv]);
      expect(result.code, argv.join(' ')).toBe(1);
      expect(result.frames[0].error).toMatchObject({
        code: 'invalid_arguments',
        message: expect.stringContaining('nothing was created'),
      });
      expect((result.out + result.err).toLowerCase()).not.toContain('samevalue1');
      expect(result.frames[0].error.message).toContain('#2');
      expect(h.rec.routes()).toEqual([['GET', 'secrets']]);
    }
  });

  it('refuses one secret bound twice, before the create is sent', async () => {
    const h = harness(store());
    const result = await h.run([
      'computers',
      'create',
      '--secret',
      'openai_api_key',
      '--secret-file',
      `${SECRET.id}=key`,
    ]);
    expect(result.frames[0].error).toMatchObject({
      code: 'invalid_arguments',
      message: expect.stringContaining('the secret'),
    });
    expect(h.rec.routes()).toEqual([['GET', 'secrets']]);
  });

  it('refuses a target that looks like a value, even one a variable name could be', async () => {
    // A classic GitHub token is letters, digits and underscores: a valid
    // variable name, so only the shape of it can say it is a value. Assembled
    // at run time so the source holds no token-shaped literal.
    const value = ['ghp', '_', 'aB3dE5fG7hJ9kL2mN4pQ6rS8tU0vW1xY2z4c'].join('');
    for (const [flag, jsonMode] of [
      ['--secret', true],
      ['--secret-file', false],
      ['--secret', false],
    ] as const) {
      const h = harness(store());
      const typed = flag === '--secret' ? value : value.toLowerCase();
      const result = await h.run(
        ['computers', 'create', flag, `openai_api_key=${typed}`],
        jsonMode,
      );
      expect(result.code).toBe(1);
      const printed = result.out + result.err;
      expect(printed).not.toContain(typed);
      expect(printed).toContain(`${flag} #1`);
      expect(printed).toContain('openai_api_key=…');
      expect(printed).toContain("looks like a secret's value");
      // Refused while the arguments are read: not even the store was listed.
      expect(h.rec.calls).toEqual([]);
    }
  });

  it('sends a flagged target with --no-value-check, and still prints it hidden', async () => {
    const hashed = 'cert-sha256-9f86d081884c7d659a2f';
    const bound = {
      ...COMPUTER,
      secrets: [{ secret_id: SECRET.id, revision_id: SECRET.revision_id, file: hashed }],
    };
    const respond = store();
    for (const jsonMode of [true, false]) {
      const refused = await harness(respond).run(
        ['computers', 'create', '--secret-file', `openai_api_key=${hashed}`],
        jsonMode,
      );
      expect(refused.code).toBe(1);
      expect(refused.out + refused.err).toContain('--no-value-check');
      const h = harness((call) =>
        call.method === 'POST' && call.path === '/computers' ? json(bound) : respond(call),
      );
      const result = await h.run(
        ['computers', 'create', '--secret-file', `openai_api_key=${hashed}`, '--no-value-check'],
        jsonMode,
      );
      expect(result.code).toBe(0);
      const create = h.rec.calls.find((c) => c.method === 'POST' && c.path === '/computers');
      expect(JSON.stringify(create?.body)).toContain(hashed);
      expect(result.out).not.toContain(hashed);
      expect(result.out).toContain('[REDACTED]');
    }
  });

  it('prints a typed variable or file as hidden, and the kind it was bound as', async () => {
    const bound = {
      ...COMPUTER,
      secrets: [
        { secret_id: SECRET.id, revision_id: SECRET.revision_id, env: 'MY_KEY' },
        { secret_id: 'csec-fedcba9876543210', revision_id: SECRET.revision_id, file: 'gh-token' },
      ],
    };
    const respond = store();
    for (const jsonMode of [true, false]) {
      const h = harness((call) =>
        call.method === 'POST' && call.path === '/computers' ? json(bound) : respond(call),
      );
      const result = await h.run(
        ['computers', 'create', '--secret', 'openai_api_key=MY_KEY', '--secret-file', 'gh-token'],
        jsonMode,
      );
      expect(result.code).toBe(0);
      expect(result.out).not.toContain('MY_KEY');
      expect(result.out).toContain('[REDACTED]');
      // Bound under the secret's own name: nothing was typed, nothing hidden.
      expect(result.out).toContain('gh-token');
      if (jsonMode)
        expect(result.frames[0].data.secrets).toEqual([
          expect.objectContaining({ env: '[REDACTED]' }),
          expect.objectContaining({ file: 'gh-token' }),
        ]);
    }
  });

  it("cuts a typed target out of the platform's refusal", async () => {
    const respond = store();
    for (const jsonMode of [true, false]) {
      const h = harness((call) =>
        call.method === 'POST' && call.path === '/computers'
          ? json({ error: 'secrets: env MY_ODD_NAME is reserved' }, { status: 400 })
          : respond(call),
      );
      const result = await h.run(
        ['computers', 'create', '--secret', 'openai_api_key=MY_ODD_NAME'],
        jsonMode,
      );
      expect(result.code).toBe(1);
      expect(result.out + result.err).not.toContain('MY_ODD_NAME');
      expect(result.out + result.err).toContain('env [REDACTED] is reserved');
    }
  });

  it('binds under the variable named by --as and the file named by --path', async () => {
    const bound = {
      ...COMPUTER,
      secrets: [
        { secret_id: SECRET.id, revision_id: SECRET.revision_id, env: 'MY_KEY' },
        { secret_id: OTHER.id, revision_id: SECRET.revision_id, file: 'gh' },
      ],
    };
    const respond = store();
    for (const jsonMode of [true, false]) {
      const h = harness((call) =>
        call.method === 'POST' && call.path === '/computers' ? json(bound) : respond(call),
      );
      const result = await h.run(
        [
          'computers',
          'create',
          '--secret',
          SECRET.id,
          '--as',
          'MY_KEY',
          '--secret-file=gh-token',
          '--path=gh',
        ],
        jsonMode,
      );
      expect(result.code).toBe(0);
      expect(h.rec.last().body).toMatchObject({
        secrets: [
          { secret_id: SECRET.id, env: 'MY_KEY' },
          { secret_id: OTHER.id, file: 'gh' },
        ],
      });
      // A typed target prints as [REDACTED] however it was given: the value
      // check cannot catch every value typed where a name was meant. It keeps
      // its kind, and nothing is deprecated.
      expect(result.out).not.toContain('MY_KEY');
      expect(result.out).toContain('[REDACTED]');
      if (jsonMode)
        expect(result.frames[0].data.secrets).toEqual([
          expect.objectContaining({ env: '[REDACTED]' }),
          expect.objectContaining({ file: '[REDACTED]' }),
        ]);
      expect(result.err).not.toContain('deprecated');
    }
  });

  it('pairs each --as with its own --secret, beside bindings that take the default', async () => {
    const third = { ...SECRET, id: 'csec-0123456789abcdee', name: 'db_url' };
    const h = harness(store({ ...SECRET_LIST, secrets: [SECRET, OTHER, third] }));
    const result = await h.run([
      'computers',
      'create',
      '--secret',
      'openai_api_key',
      '--secret',
      'db_url',
      '--as',
      'DATABASE_URL',
      '--secret-file',
      'gh-token',
    ]);
    expect(result.code).toBe(0);
    expect(h.rec.last().body).toMatchObject({
      secrets: [
        { secret_id: SECRET.id, env: 'OPENAI_API_KEY' },
        { secret_id: third.id, env: 'DATABASE_URL' },
        { secret_id: OTHER.id, file: 'gh-token' },
      ],
    });
  });

  it('takes the whole --secret as the secret when --as names the variable, = and all', async () => {
    const odd = { ...SECRET, name: 'a=b' };
    const h = harness(store({ ...SECRET_LIST, secrets: [odd] }));
    const result = await h.run(['computers', 'create', '--secret', 'a=b', '--as', 'AB']);
    expect(result.code).toBe(0);
    expect(h.rec.last().body).toMatchObject({ secrets: [{ secret_id: odd.id, env: 'AB' }] });
    expect(result.err).not.toContain('deprecated');
  });

  it('never quotes a value typed after = even when --as names the variable', async () => {
    const value = 'sk-live-do-not-print-me';
    for (const jsonMode of [true, false]) {
      const h = harness(store());
      const result = await h.run(
        ['computers', 'create', '--secret', `OPENAI_API_KEY=${value}`, '--as', 'MY_KEY'],
        jsonMode,
      );
      expect(result.code).toBe(1);
      expect(result.frames[0]?.error?.code ?? 'not_found').toBe('not_found');
      expect(result.out + result.err).not.toContain(value);
      expect(result.out + result.err).toContain('OPENAI_API_KEY=…');
      expect(h.rec.routes()).toEqual([['GET', 'secrets']]);
    }
  });

  it('refuses an --as or --path that looks like a value, and never prints it', async () => {
    // Assembled at run time so the source holds no token-shaped literal. Each
    // but the sk-live- one is a valid variable (or, for --path, file) name,
    // so the naming rules alone would have sent it as one.
    const alphabet = 'aB3dE5fG7hJ9kL2mN4pQ6rS8tU0vW1xY';
    const body = (n: number) =>
      Array.from({ length: n }, (_, i) => alphabet[(i * 7 + 3) % alphabet.length]).join('');
    const cases = [
      ['--secret', 'openai_api_key', '--as', ['ghp', '_', body(36)].join('')],
      ['--secret', 'openai_api_key', '--as', ['sk', '_live_', body(32)].join('')],
      ['--secret', 'openai_api_key', '--as', ['sk', '-live-', body(32)].join('')],
      ['--secret', 'openai_api_key', '--as', body(40)],
      [
        '--secret-file',
        'gh-token',
        '--path',
        ['xoxb', '-123456789012-4096409640964-ab12'].join(''),
      ],
    ] as const;
    for (const argv of cases)
      for (const jsonMode of [true, false]) {
        const h = harness(store());
        const result = await h.run(['computers', 'create', ...argv], jsonMode);
        const printed = result.out + result.err;
        expect(result.code, argv.join(' ')).toBe(1);
        expect(printed, argv[3]).not.toContain(argv[3]);
        const message = jsonMode ? result.frames[0].error.message : result.err;
        expect(message).toContain(
          `${argv[0]} "${argv[1]}": ${argv[2]} looks like a secret's value`,
        );
        expect(message).toContain('--no-value-check');
        if (jsonMode) expect(result.frames[0].error.code).toBe('invalid_arguments');
        // Refused while the arguments are read: not even the store was listed.
        expect(h.rec.calls).toEqual([]);
      }
  });

  it('keeps sending the names people bind as with --as and --path', async () => {
    for (const as of ['OPENAI_API_KEY', 'HF_TOKEN', 'MysqlReplicaPassword']) {
      const h = harness(store());
      const result = await h.run([
        'computers',
        'create',
        '--secret',
        'openai_api_key',
        '--as',
        as,
        '--secret-file',
        'gh-token',
        '--path',
        'config_token',
      ]);
      expect(result.code, as).toBe(0);
      expect(h.rec.last().body).toMatchObject({
        secrets: [
          { secret_id: SECRET.id, env: as },
          { secret_id: OTHER.id, file: 'config_token' },
        ],
      });
    }
  });

  it('sends a flagged --as or --path with --no-value-check, and never prints it', async () => {
    const token = ['ghp', '_', 'aB3dE5fG7hJ9kL2mN4pQ6rS8tU0vW1xY2z4c'].join('');
    const hashed = 'cert-sha256-9f86d081884c7d659a2f';
    const argv = [
      'computers',
      'create',
      '--secret',
      'openai_api_key',
      '--as',
      token,
      '--secret-file',
      'gh-token',
      '--path',
      hashed,
      '--no-value-check',
    ];
    const bound = {
      ...COMPUTER,
      secrets: [
        { secret_id: SECRET.id, revision_id: SECRET.revision_id, env: token },
        { secret_id: OTHER.id, revision_id: SECRET.revision_id, file: hashed },
      ],
    };
    const respond = store();
    for (const jsonMode of [true, false]) {
      const h = harness((call) =>
        call.method === 'POST' && call.path === '/computers' ? json(bound) : respond(call),
      );
      const result = await h.run(argv, jsonMode);
      expect(result.code).toBe(0);
      expect(h.rec.last().body).toMatchObject({
        secrets: [
          { secret_id: SECRET.id, env: token },
          { secret_id: OTHER.id, file: hashed },
        ],
      });
      expect(result.out + result.err).not.toContain(token);
      expect(result.out + result.err).not.toContain(hashed);
      if (jsonMode)
        expect(result.frames[0].data.secrets).toEqual([
          expect.objectContaining({ env: '[REDACTED]' }),
          expect.objectContaining({ file: '[REDACTED]' }),
        ]);
      // And the platform's refusal, which may name the binding it refused.
      const refused = harness((call) =>
        call.method === 'POST' && call.path === '/computers'
          ? json(
              { error: `secrets: env ${token} and file ${hashed} are reserved` },
              { status: 400 },
            )
          : respond(call),
      );
      const failed = await refused.run(argv, jsonMode);
      expect(failed.code).toBe(1);
      expect(failed.out + failed.err).not.toContain(token);
      expect(failed.out + failed.err).not.toContain(hashed);
      expect(failed.out + failed.err).toContain('env [REDACTED] and file [REDACTED] are reserved');
    }
  });

  it('never prints an --as or --path the value check misses', async () => {
    // Random tokens the heuristic lets through, assembled at run time. The
    // check is asserted here so neither can quietly become a flagged case,
    // which the tests above already cover.
    const token = ['Bhd7jydqqYgtn1Bac', 'RmG5YwbQsd34Ze0ZJloQaA2'].join('');
    const fileToken = ['gg9rvsaeiovmyb8w', '509qebwuesd29gys'].join('');
    expect(looksLikeSecretValue(token)).toBe(false);
    expect(looksLikeSecretValue(fileToken)).toBe(false);
    const argv = [
      'computers',
      'create',
      '--secret',
      'openai_api_key',
      '--as',
      token,
      '--secret-file',
      'gh-token',
      '--path',
      fileToken,
    ];
    const bound = {
      ...COMPUTER,
      secrets: [
        { secret_id: SECRET.id, revision_id: SECRET.revision_id, env: token },
        { secret_id: OTHER.id, revision_id: SECRET.revision_id, file: fileToken },
      ],
    };
    const respond = store();
    for (const jsonMode of [true, false]) {
      const h = harness((call) =>
        call.method === 'POST' && call.path === '/computers' ? json(bound) : respond(call),
      );
      const result = await h.run(argv, jsonMode);
      expect(result.code).toBe(0);
      // Sent as typed: only the printing changes.
      expect(h.rec.last().body).toMatchObject({
        secrets: [
          { secret_id: SECRET.id, env: token },
          { secret_id: OTHER.id, file: fileToken },
        ],
      });
      expect(result.out + result.err).not.toContain(token);
      expect(result.out + result.err).not.toContain(fileToken);
      if (jsonMode)
        expect(result.frames[0].data.secrets).toEqual([
          expect.objectContaining({ env: '[REDACTED]' }),
          expect.objectContaining({ file: '[REDACTED]' }),
        ]);
      const refused = harness((call) =>
        call.method === 'POST' && call.path === '/computers'
          ? json(
              { error: `secrets: env ${token} and file ${fileToken} are reserved` },
              { status: 400 },
            )
          : respond(call),
      );
      const failed = await refused.run(argv, jsonMode);
      expect(failed.code).toBe(1);
      expect(failed.out + failed.err).not.toContain(token);
      expect(failed.out + failed.err).not.toContain(fileToken);
      expect(failed.out + failed.err).toContain('env [REDACTED] and file [REDACTED] are reserved');
    }
  });

  it('never quotes a token typed as the secret, the operands of --as swapped', async () => {
    // `--secret "$GITHUB_TOKEN" --as GITHUB_TOKEN`: the store holds no secret
    // by that name, and the not-found error names the binding by position.
    const token = ['ghp', '_', 'aB3dE5fG7hJ9kL2mN4pQ6rS8tU0vW1xY2z4c'].join('');
    const fileToken = ['xoxb', '-123456789012-4096409640964-ab12'].join('');
    const cases = [
      ['--secret', token, '--as', 'GITHUB_TOKEN'],
      ['--secret-file', fileToken, '--path', 'slack-token'],
      ['--secret', token],
    ];
    for (const args of cases)
      for (const jsonMode of [true, false]) {
        const h = harness(store());
        const result = await h.run(['computers', 'create', ...args], jsonMode);
        expect(result.code, args.join(' ')).toBe(1);
        expect(result.out + result.err).not.toContain(args[1]);
        const message = jsonMode ? result.frames[0].error.message : result.err;
        expect(message).toContain(`${args[0]} #1: no secret by that name or id`);
        if (jsonMode) expect(result.frames[0].error.code).toBe('not_found');
        expect(h.rec.routes()).toEqual([['GET', 'secrets']]);
      }
    // A real name or id is still quoted, so the error reads clearly.
    const h = harness(store());
    const missing = await h.run(['computers', 'create', '--secret', 'no_such', '--as', 'X']);
    expect(missing.frames[0].error.message).toContain('--secret "no_such": no secret');
  });

  it('holds --as and --path to the naming rules, without quoting what was typed', async () => {
    for (const [argv, rule] of [
      [['--secret', 'openai_api_key', '--as', 'bad-name.x'], '--as must be letters'],
      [['--secret-file', 'gh-token', '--path', 'Upper.Case'], '--path must be lowercase'],
    ] as const) {
      const h = harness(store());
      const result = await h.run(['computers', 'create', ...argv]);
      expect(result.code, argv.join(' ')).toBe(1);
      expect(result.frames[0].error).toMatchObject({
        code: 'invalid_arguments',
        message: expect.stringContaining(rule),
      });
      expect(result.out + result.err).not.toContain(argv[3]);
      expect(h.rec.calls).toEqual([]);
    }
  });

  it('refuses an --as or --path that does not directly follow its own flag', async () => {
    const stray = 'stray-target-do-not-print';
    for (const [argv, says] of [
      [['--as', stray], '--as names what the --secret directly before it is bound as'],
      [['--path', stray, '--secret-file', 'gh-token'], 'right after one: --secret-file SECRET'],
      [
        ['--secret-file', 'gh-token', '--as', stray],
        '--as goes after --secret; --secret-file takes --path',
      ],
      [
        ['--secret', 'openai_api_key', '--path', stray],
        '--path goes after --secret-file; --secret takes --as',
      ],
      [
        ['--secret', 'openai_api_key', '--as', 'A', '--as', stray],
        '--as was given twice for one --secret',
      ],
      [
        ['--secret', 'openai_api_key', '--name', 'box', '--as', stray],
        '--secret directly before it',
      ],
      [['--secret', 'openai_api_key', '--no-start', '--as', stray], '--secret directly before it'],
    ] as const) {
      for (const jsonMode of [true, false]) {
        const h = harness(store());
        const result = await h.run(['computers', 'create', ...argv], jsonMode);
        expect(result.code, argv.join(' ')).toBe(1);
        const printed = result.out + result.err;
        expect(printed, argv.join(' ')).toContain(says);
        expect(printed, argv.join(' ')).not.toContain(stray);
        expect(h.rec.calls).toEqual([]);
      }
    }
  });

  it('prints help for --help beside a stray --as or --path, before it or after', async () => {
    const stray = 'stray-target-do-not-print';
    for (const argv of [
      ['--help', '--as', stray],
      ['--as', stray, '--help'],
      ['--secret-file', 'gh-token', '--as', stray, '--help'],
      ['--path', stray, '--secret-file', 'gh-token', '--help'],
    ]) {
      const h = harness(store());
      const result = await h.run(['computers', 'create', ...argv], false);
      expect(result.code, argv.join(' ')).toBe(0);
      expect(result.out, argv.join(' ')).toContain('mandala computers create');
      expect(result.out + result.err, argv.join(' ')).not.toContain(stray);
      expect(result.err, argv.join(' ')).not.toContain('--as');
      expect(h.rec.calls).toEqual([]);
    }
  });

  it('warns once on stderr that SECRET=VAR is deprecated, without the target, and still binds', async () => {
    for (const jsonMode of [true, false]) {
      const h = harness(store());
      const result = await h.run(
        [
          'computers',
          'create',
          '--secret',
          'openai_api_key=MY_KEY',
          '--secret',
          `${OTHER.id}=OTHER_KEY`,
        ],
        jsonMode,
      );
      expect(result.code).toBe(0);
      expect(h.rec.last().body).toMatchObject({
        secrets: [
          { secret_id: SECRET.id, env: 'MY_KEY' },
          { secret_id: OTHER.id, env: 'OTHER_KEY' },
        ],
      });
      const warnings = result.err.split('\n').filter((l) => l.includes('deprecated'));
      expect(warnings).toEqual([
        'mandala: --secret SECRET=VAR is deprecated; use --secret SECRET --as VAR',
      ]);
      expect(result.err).not.toContain('MY_KEY');
      expect(result.err).not.toContain('OTHER_KEY');
      // The JSON stream is untouched by it.
      if (jsonMode) expect(result.frames).toHaveLength(1);
    }
    const files = harness(store());
    const both = await files.run([
      'computers',
      'create',
      '--secret',
      'openai_api_key=MY_KEY',
      '--secret-file',
      'gh-token=gh',
    ]);
    expect(both.err).toContain(
      'mandala: --secret SECRET=VAR and --secret-file SECRET=FILE are deprecated; ' +
        'use --secret SECRET --as VAR and --secret-file SECRET --path FILE',
    );
    expect(both.err).not.toContain('=gh');
  });

  it('points a refused = target at --as and --no-value-check', async () => {
    const value = ['ghp', '_', 'aB3dE5fG7hJ9kL2mN4pQ6rS8tU0vW1xY2z4c'].join('');
    const h = harness(store());
    const result = await h.run(['computers', 'create', '--secret', `openai_api_key=${value}`]);
    expect(result.code).toBe(1);
    expect(result.frames[0].error.message).toContain(
      'give it with --as instead of = and send it as typed with --no-value-check',
    );
    expect(result.out + result.err).not.toContain(value);
  });

  it('creates with a browser proxy and its bypass list', async () => {
    const h = harness((call) =>
      call.method === 'POST' ? json({ ...COMPUTER }, { status: 201 }) : anyRoute(call),
    );
    const result = await h.run([
      'computers',
      'create',
      '--browser-proxy',
      'http://proxy.example.com:3128',
      '--browser-proxy-bypass',
      '<local>, *.example.com',
      '--browser-proxy-bypass',
      '10.0.0.0/8',
    ]);
    expect(result.code).toBe(0);
    expect(h.rec.last()).toMatchObject({
      method: 'POST',
      path: '/computers',
      body: {
        browser_proxy: {
          server: 'http://proxy.example.com:3128',
          bypass: ['<local>', '*.example.com', '10.0.0.0/8'],
        },
      },
    });
  });

  it('sets and clears a browser proxy through the resolved id', async () => {
    const h = harness((call) => (call.method === 'PATCH' ? json(COMPUTER) : anyRoute(call)));
    const set = await h.run([
      'computers',
      'browser-proxy',
      'set',
      COMPUTER.name,
      'socks5://127.0.0.1:1080',
      '--bypass',
      'example.com',
    ]);
    expect(set.code).toBe(0);
    expect(h.rec.last()).toMatchObject({
      method: 'PATCH',
      path: `/computers/${COMPUTER.id}`,
      body: { browser_proxy: { server: 'socks5://127.0.0.1:1080', bypass: ['example.com'] } },
    });
    const bare = await h.run(['computers', 'browser-proxy', 'set', COMPUTER.id, 'http://p:1']);
    expect(bare.code).toBe(0);
    expect(h.rec.last()!.body).toEqual({ browser_proxy: { server: 'http://p:1' } });
    const clear = await h.run(['computers', 'browser-proxy', 'clear', COMPUTER.id]);
    expect(clear.code).toBe(0);
    expect(h.rec.last()).toMatchObject({
      method: 'PATCH',
      path: `/computers/${COMPUTER.id}`,
      body: { browser_proxy: null },
    });
  });

  it("prints the platform's refusal of a proxy as it is", async () => {
    // The rules on a proxy URL are the platform's, and they grow; the CLI
    // sends what was typed and passes the sentence back.
    const sentence = 'browser_proxy.server: https:// is not supported yet';
    const h = harness((call) =>
      call.method === 'PATCH' ? json({ error: sentence }, { status: 400 }) : anyRoute(call),
    );
    const result = await h.run([
      'computers',
      'browser-proxy',
      'set',
      COMPUTER.id,
      'https://proxy.example.com:443',
    ]);
    expect(result.code).toBe(1);
    expect(h.rec.last()!.body).toEqual({
      browser_proxy: { server: 'https://proxy.example.com:443' },
    });
    expect(result.frames[0].error.message).toContain(sentence);
  });

  it('waits for the browser proxy with computers wait --until browser-proxy', async () => {
    let gets = 0;
    const h = harness(() => {
      gets++;
      return json({
        ...COMPUTER,
        status: 'running',
        browser_proxy: { server: 'http://proxy.example.com:3128' },
        ...(gets < 3 ? { browser_proxy_pending: true } : {}),
      });
    });
    const result = await h.run([
      'computers',
      'wait',
      COMPUTER.id,
      '--until',
      'browser-proxy',
      '--poll-ms',
      '1',
    ]);
    expect(result.code).toBe(0);
    expect(gets).toBe(3);
    expect(result.frames[0].data.browser_proxy).toEqual({
      server: 'http://proxy.example.com:3128',
    });
  });

  it('renames through the resolved id', async () => {
    const h = harness((call) =>
      call.method === 'PATCH' ? json({ ...COMPUTER, name: 'build box' }) : anyRoute(call),
    );
    const result = await h.run(['computers', 'rename', COMPUTER.name, 'build box']);
    expect(result.code).toBe(0);
    expect(h.rec.last()).toMatchObject({
      method: 'PATCH',
      path: `/computers/${COMPUTER.id}`,
      body: { name: 'build box' },
    });
    expect(result.frames[0].data).toMatchObject({ id: COMPUTER.id, name: 'build box' });
  });

  it('resizes only what was named', async () => {
    const h = harness();
    const result = await h.run([
      'computers',
      'resize',
      COMPUTER.id,
      '--cpu',
      '4',
      '--disk-gb',
      '80',
    ]);
    expect(result.code).toBe(0);
    expect(h.rec.last()).toMatchObject({
      method: 'PATCH',
      path: `/computers/${COMPUTER.id}`,
      body: { cpu: 4, disk_gb: 80 },
    });
  });

  it("passes a resize's refusal through with its code", async () => {
    const h = harness((call) =>
      call.method === 'PATCH'
        ? json(
            { error: 'this computer is running; stop it before changing its size' },
            { status: 409 },
          )
        : anyRoute(call),
    );
    const result = await h.run(['computers', 'resize', COMPUTER.id, '--ram-mb', '8192']);
    expect(result.code).toBe(1);
    expect(result.frames[0].error).toMatchObject({
      code: 'conflict',
      status: 409,
      message: expect.stringContaining('stop it before changing its size'),
    });
  });

  it('opens the dashboard page for the resolved id, and prints the URL', async () => {
    const opened: string[] = [];
    const h = harness();
    h.io.openBrowser = async (url) => {
      opened.push(url);
      return true;
    };
    const result = await h.run(['computers', 'view', COMPUTER.name]);
    expect(result.code).toBe(0);
    expect(opened).toEqual([`https://api.test/computers/${COMPUTER.id}`]);
    expect(result.frames[0].data).toEqual({
      id: COMPUTER.id,
      name: COMPUTER.name,
      url: `https://api.test/computers/${COMPUTER.id}`,
      opened: true,
    });
    // Never a desktop credential: the page asks the browser's own session.
    expect(result.out).not.toContain('token');
  });

  it('prints the URL alone with --no-open, and says so when no browser opens', async () => {
    const opened: string[] = [];
    const h = harness();
    h.io.openBrowser = async (url) => {
      opened.push(url);
      return false;
    };
    const quiet = await h.run(['computers', 'view', COMPUTER.id, '--no-open'], false);
    expect(quiet.out).toBe(`https://api.test/computers/${COMPUTER.id}\n`);
    expect(quiet.err).toBe('');
    expect(opened).toEqual([]);
    const h2 = harness();
    h2.io.openBrowser = async () => {
      throw new Error('no display');
    };
    const threw = await h2.run(['computers', 'view', COMPUTER.id], false);
    expect(threw.code).toBe(0);
    expect(threw.out).toBe(`https://api.test/computers/${COMPUTER.id}\n`);
    expect(threw.err).toContain('no browser could be opened');
  });

  it.each([
    ['https://app.mandala.computer/api/v1', 'https://app.mandala.computer/computers/vm-1'],
    ['https://app.mandala.computer/api/v1/', 'https://app.mandala.computer/computers/vm-1'],
    ['https://example.test/mandala/api/v1', 'https://example.test/mandala/computers/vm-1'],
    ['http://localhost:3000/elsewhere', 'http://localhost:3000/computers/vm-1'],
  ])('puts the dashboard beside the API: %s', (base, url) => {
    expect(dashboardUrl(base, 'vm-1')).toBe(url);
  });

  it('lists a guest directory, snake_case under --json', async () => {
    const h = harness();
    const result = await h.run(['files', 'list', COMPUTER.name, '/home/user/Desktop']);
    expect(result.code).toBe(0);
    expect(h.rec.last()).toMatchObject({
      method: 'GET',
      path: `/computers/${COMPUTER.id}/files/list`,
      query: { path: '/home/user/Desktop' },
    });
    expect(result.frames[0].data).toEqual(DIRECTORY);
  });

  it('lists a directory for a person, one line each, and says when it is partial', async () => {
    const partial = { ...DIRECTORY, truncated: true, skipped: 2 };
    const h = harness((call) =>
      call.path.endsWith('/files/list') ? json(partial) : anyRoute(call),
    );
    const result = await h.run(['files', 'list', COMPUTER.id, '/home/user/Desktop'], false);
    expect(result.code).toBe(0);
    expect(result.out.split('\n')).toEqual([
      'file                  12  notes.txt',
      'directory              -  photos/',
      '',
    ]);
    expect(result.err).toContain('unordered part of it');
    expect(result.err).toContain('2 names could not be shown');
  });

  it('uploads with files upload, create-only when asked', async () => {
    const path = join(await tempDir(), 'upload.bin');
    await writeFile(path, Uint8Array.from([7, 8, 9]));
    const h = harness((call) =>
      call.path === '/computers' ? json([COMPUTER]) : json({ bytes: 3 }),
    );
    const result = await h.run(['files', 'upload', COMPUTER.name, path, '/tmp/']);
    expect(result.code).toBe(0);
    expect(h.rec.last()).toMatchObject({ method: 'PUT', query: { path: '/tmp/upload.bin' } });
    expect(h.rec.last().raw).toEqual(Uint8Array.from([7, 8, 9]));
    expect(result.frames[0].data).toEqual({
      source: path,
      destination: `${COMPUTER.name}:/tmp/upload.bin`,
      bytes: 3,
      confirmed: true,
      accounting: '3 bytes',
    });
    await h.run(['files', 'upload', '--no-overwrite', COMPUTER.name, path, '/tmp/x.bin']);
    expect(h.rec.last().query).toEqual({ path: '/tmp/x.bin', overwrite: 'false' });
  });

  it('downloads with files download into a directory under the guest name', async () => {
    const dir = await tempDir();
    const h = harness(guestFile(Uint8Array.from([0, 255, 3])));
    const result = await h.run(['files', 'download', COMPUTER.name, '/tmp/input.bin', dir]);
    expect(result.code).toBe(0);
    expect(await readFile(join(dir, 'input.bin'))).toEqual(Buffer.from([0, 255, 3]));
    expect(result.frames[0].data).toEqual({
      source: `${COMPUTER.name}:/tmp/input.bin`,
      destination: join(dir, 'input.bin'),
      bytes: 3,
      confirmed: true,
    });
  });

  it('downloads into the current directory when no destination is named', async () => {
    const seen: unknown[] = [];
    const legacy = {
      download: async (...args: unknown[]) => {
        seen.push(args.slice(0, 3));
        return { source: 's', destination: 'd', bytes: 0, confirmed: true };
      },
    } as unknown as LegacyCommands;
    const h = harness();
    const code = await runCli(
      ['files', 'download', 'demo', '/tmp/a.txt', '--json'],
      runtime(h.io),
      legacy,
    );
    expect(code).toBe(0);
    expect(seen).toEqual([['demo', '/tmp/a.txt', '.']]);
  });

  it.each([
    [['computers', 'resize', 'vm']],
    [['computers', 'resize', 'vm', '--cpu', '0']],
    [['computers', 'resize', 'vm', '--disk-gb', '1.5']],
    [['computers', 'rename', 'vm']],
    [['computers', 'view', 'vm', 'extra']],
    [['files', 'list', 'vm', 'relative/path']],
    [['files', 'list', 'vm']],
    [['files', 'upload', 'vm', 'local.txt']],
    [['computers', 'create', '--secret', '=X']],
    [['computers', 'create', '--secret', 'A=1BAD']],
    [['computers', 'create', '--secret-file', 'A=Upper']],
    [['computers', 'create', '--secret', 'A=']],
    [['computers', 'create', '--browser-proxy-bypass', 'a.com']],
    [['computers', 'create', '--browser-proxy', '']],
    [['computers', 'browser-proxy', 'set', 'vm']],
    [['computers', 'browser-proxy', 'set', 'vm', ' ']],
    [['computers', 'browser-proxy', 'clear']],
    // A bypass of blanks is refused as the SDK refuses a blank entry, rather
    // than sent as an empty list.
    [['computers', 'browser-proxy', 'set', 'vm', 'http://p:1', '--bypass', '']],
    [['computers', 'browser-proxy', 'set', 'vm', 'http://p:1', '--bypass', ',']],
    [['computers', 'browser-proxy', 'set', 'vm', 'http://p:1', '--bypass', 'a.com,']],
    [['computers', 'create', '--browser-proxy', 'http://p:1', '--browser-proxy-bypass', ' ']],
  ])('%j makes no requests', async (argv) => {
    const h = harness();
    const result = await h.run(argv);
    expect(result.code).toBe(1);
    expect(h.rec.calls).toEqual([]);
  });
});
