import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import type { CliIO } from '../src/cli-runtime.js';
import { Client } from '../src/index.js';
import {
  anyRoute,
  BASE,
  BUILD_PROGRESS,
  buildEvents,
  COMPUTER,
  EXEC_OK,
  guestFile,
  json,
  type Responder,
  recorder,
  SNAPSHOT,
  TEMPLATE_CHECK,
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
  const rec = recorder(respond);
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

describe('computer commands use distinct SDK requests', () => {
  it('lists selected state and preserves an incomplete inventory', async () => {
    const h = harness(() => json([COMPUTER], { headers: { 'X-GC-Incomplete': '2' } }));
    const result = await h.run(['computers', 'list', '--allow-partial', '--state', 'lost']);
    expect(h.rec.routes()).toEqual([['GET', 'computers']]);
    expect(h.rec.last().query).toEqual({ allow_partial: '1', state: 'lost' });
    expect(result.frames[0]).toMatchObject({
      schemaVersion: 1,
      command: 'computers list',
      ok: true,
      exitCode: 0,
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
      ['DELETE', `computers/${COMPUTER.id}`],
    ]);
    expect(h.rec.last().query).toEqual({ snapshots: 'delete', expect: 'fingerprint-7' });
    expect(result.frames[0].data).toEqual({ id: COMPUTER.id, deleted: true, snapshotsDeleted: 3 });
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
            ['POST', `computers/${COMPUTER.id}/exec`],
          ]
        : until === 'built'
          ? [['GET', 'computers']]
          : [
              ['GET', 'computers'],
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
    expect(h.rec.routes()).toEqual([['GET', 'computers']]);
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
      exitCode: 7,
      data: { exitCode: 7, stdoutBase64: 'AP8=', stderrBase64: 'ZXJyCg==', outTruncated: true },
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
      schemaVersion: 1,
      command: 'templates watch',
      timestamp: stamp,
      data: { status: 'succeeded', done: true, exitCode: 0 },
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
    const h = harness(() => json([SNAPSHOT], { headers: { 'X-GC-Incomplete': '1' } }));
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
      exitCode: 0,
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
      usage: { inputTokens: 51, outputTokens: 17, cacheReadTokens: 12, cacheWriteTokens: 4 },
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
      expect(result.frames[0].data).toMatchObject({ finished: false, stop, exitCode: 1 });
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
  it('rejects ssh --json before even creating a client', async () => {
    const h = harness();
    h.io.createClient = () => {
      throw new Error('must not connect');
    };
    const result = await h.run(['ssh', 'desktop']);
    expect(result.frames[0]).toMatchObject({ ok: false, error: { code: 'unsupported_mode' } });
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
        expect(result.frames[0].error).toMatchObject({ code: 'TimeoutError' });
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
