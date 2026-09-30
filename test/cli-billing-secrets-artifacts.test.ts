import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { completion } from '../src/cli-completion.js';
import { manifest } from '../src/cli-manifest.js';
import { help } from '../src/cli-options.js';
import type { CliIO } from '../src/cli-runtime.js';
import { Client } from '../src/index.js';
import {
  anyRoute,
  BASE,
  type Call,
  COMPUTER,
  errorJson,
  json,
  type Responder,
  recorder,
  SECRET_BINDINGS,
  USAGE,
} from './harness.js';

function harness(respond: Responder = anyRoute) {
  // The listing holds demo as a name, not as an id: its direct route is 404.
  const rec = recorder((call) =>
    call.method === 'GET' && call.path === `/computers/${COMPUTER.name}`
      ? errorJson(404, 'no such computer ID')
      : respond(call),
  );
  const stdout: Uint8Array[] = [];
  const stderr: Uint8Array[] = [];
  const io: Partial<CliIO> = {
    stdin: Object.assign(Readable.from([]), { isTTY: true }),
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
    env: { MANDALA_API_KEY: 'com_cli_test' },
    createClient: () => new Client({ apiKey: 'com_cli_test', baseUrl: BASE, fetch: rec.fetch }),
  };
  return {
    rec,
    async run(args: string[], jsonMode = true) {
      const code = await main([...args, ...(jsonMode ? ['--json'] : [])], io);
      const out = Buffer.concat(stdout).toString();
      const err = Buffer.concat(stderr).toString();
      return { code, out, err, frame: jsonMode && out.trim() ? JSON.parse(out) : undefined };
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

const ACCOUNT = {
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

const billingRoutes =
  (usage: unknown = USAGE): Responder =>
  (call) =>
    call.path === '/account'
      ? json(ACCOUNT)
      : call.path === '/usage'
        ? json(usage)
        : anyRoute(call);

describe('billing', () => {
  it('reads the plan and the current period in one finite JSON result', async () => {
    const h = harness(billingRoutes());
    const result = await h.run(['billing']);
    expect(result.code).toBe(0);
    expect(h.rec.routes().sort()).toEqual([
      ['GET', 'account'],
      ['GET', 'usage'],
    ]);
    // The current billing period: no window is invented.
    expect(h.rec.calls.find((c) => c.path === '/usage')?.query).toEqual({});
    expect(result.frame).toMatchObject({
      command: 'billing',
      ok: true,
      data: {
        account: { plan: { id: 'standard', label: 'Standard' }, limits: { max_computers: 5 } },
        usage: {
          period: USAGE.period,
          usage: { run_hours: 12.5, vcpu_hours: 25 },
          reported_through: '2026-08-20',
        },
      },
    });
    expect(result.frame.data.account).not.toHaveProperty('raw');
    expect(result.frame.data.usage).not.toHaveProperty('raw');
  });

  it('shows the plan, the totals and the computers that ran longest', async () => {
    const computers = [1, 9, 4, 7, 2, 6].map((hours, i) => ({
      id: `vm-${i}`,
      name: `box-${i}`,
      run_hours: hours,
      vcpu_hours: hours * 2,
      ram_gb_hours: hours * 4,
    }));
    const h = harness(billingRoutes({ ...USAGE, usage: { ...USAGE.usage, computers } }));
    const result = await h.run(['billing'], false);
    expect(result.code).toBe(0);
    const lines = result.out.trimEnd().split('\n');
    expect(lines[0]).toBe('Plan: Standard (standard)');
    expect(result.out).toContain(
      'Billing period: 2026-08-04T00:00:00.000Z to 2026-09-04T00:00:00.000Z (subscription)',
    );
    expect(result.out).toContain('Run hours: 12.5; vCPU-hours: 25; RAM GB-hours: 50');
    const top = lines.slice(lines.indexOf('Top computers by run hours:') + 1);
    expect(top.slice(0, 6)).toEqual([
      '  box-1 (vm-1): 9 run hours; 18 vCPU-hours',
      '  box-3 (vm-3): 7 run hours; 14 vCPU-hours',
      '  box-5 (vm-5): 6 run hours; 12 vCPU-hours',
      '  box-2 (vm-2): 4 run hours; 8 vCPU-hours',
      '  box-4 (vm-4): 2 run hours; 4 vCPU-hours',
      '  and 1 more; mandala usage lists every one',
    ]);
  });

  it('says when the breakdown was withheld rather than calling it empty', async () => {
    const { computers: _c, ...withheld } = USAGE.usage;
    const result = await harness(billingRoutes({ ...USAGE, usage: withheld })).run(
      ['billing'],
      false,
    );
    expect(result.code).toBe(0);
    expect(result.out).toContain('Top computers: withheld for this credential');
  });

  it('refuses a malformed usage report rather than printing defaults', async () => {
    const result = await harness(billingRoutes({ ...USAGE, degraded: 'no' })).run(['billing']);
    expect(result.code).toBe(1);
    expect(result.frame.error.message).toMatch(/degraded must be a boolean/);
  });
});

describe('computers secrets', () => {
  it('reads the bindings, which hold no value', async () => {
    const h = harness();
    const result = await h.run(['computers', 'secrets', 'get', 'vm-1']);
    expect(result.code).toBe(0);
    expect(h.rec.routes()).toEqual([
      ['GET', 'computers'],
      ['GET', 'computers/vm-1/secrets'],
    ]);
    expect(result.frame.data).toEqual(SECRET_BINDINGS);
  });

  it('replaces the list, resolving each secret by name as computers create does', async () => {
    const h = harness();
    const result = await h.run([
      'computers',
      'secrets',
      'set',
      'demo',
      '--secret',
      'OPENAI_API_KEY',
      '--as',
      'API_TOKEN',
    ]);
    expect(result.code).toBe(0);
    expect(h.rec.routes()).toEqual([
      ['GET', 'computers'],
      ['GET', 'computers/demo'],
      ['GET', 'secrets'],
      ['PUT', 'computers/vm-1/secrets'],
    ]);
    expect(h.rec.last().body).toEqual({
      secrets: [{ secret_id: 'csec-0123456789abcdef', env: 'API_TOKEN' }],
    });
    // A typed variable name is never printed back: it may be a value typed
    // where the name was meant, which the value check can miss.
    expect(result.out).not.toContain('API_TOKEN');
    expect(result.frame.data.secrets[0]).toMatchObject({ env: '[REDACTED]' });
    expect(result.frame.data.secrets[1]).toMatchObject({ file: 'kubeconfig' });
  });

  it('removes every binding with --clear', async () => {
    const h = harness();
    const result = await h.run(['computers', 'secrets', 'set', 'vm-1', '--clear']);
    expect(result.code).toBe(0);
    expect(h.rec.routes()).toEqual([
      ['GET', 'computers'],
      ['PUT', 'computers/vm-1/secrets'],
    ]);
    expect(h.rec.last().body).toEqual({ secrets: [] });
  });

  it.each([
    [['computers', 'secrets', 'set', 'vm-1'], /--secret or --secret-file, or --clear/],
    [['computers', 'secrets', 'set', 'vm-1', '--clear', '--secret', 'OPENAI_API_KEY'], /conflicts/],
    [
      ['computers', 'secrets', 'set', 'vm-1', '--as', 'API_TOKEN'],
      /--as names what the --secret directly before it is bound as/,
    ],
  ])('refuses %j before any request', async (args, message) => {
    const h = harness();
    const result = await h.run(args);
    expect(result.code).not.toBe(0);
    expect(result.frame.error.message).toMatch(message);
    expect(h.rec.calls).toEqual([]);
  });

  it("refuses a value typed as --as without sending or repeating it, as create's check does", async () => {
    const token = 'ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
    const h = harness();
    const result = await h.run([
      'computers',
      'secrets',
      'set',
      'vm-1',
      '--secret',
      'OPENAI_API_KEY',
      '--as',
      token,
    ]);
    expect(result.code).toBe(1);
    expect(result.frame.error.message).toMatch(/--as looks like a secret's value/);
    expect(result.out + result.err).not.toContain(token);
    expect(h.rec.calls).toEqual([]);
  });

  it('says a name that matches no secret left the bindings unchanged', async () => {
    const h = harness();
    const result = await h.run(['computers', 'secrets', 'set', 'vm-1', '--secret', 'NO_SUCH']);
    expect(result.code).toBe(1);
    expect(result.frame.error.message).toBe(
      '--secret #1: no secret by that name or id in this scope; no binding was changed',
    );
    expect(h.rec.routes()).not.toContainEqual(['PUT', 'computers/vm-1/secrets']);
  });

  it("passes the platform's refusal to bind a running computer through, less the typed name", async () => {
    const refusal =
      'computer vm-1 is running: stop it before binding its first secrets (API_TOKEN)';
    const h = harness((call: Call) =>
      call.method === 'PUT' && call.path === '/computers/vm-1/secrets'
        ? errorJson(409, refusal)
        : anyRoute(call),
    );
    const result = await h.run([
      'computers',
      'secrets',
      'set',
      'vm-1',
      '--secret',
      'OPENAI_API_KEY',
      '--as',
      'API_TOKEN',
    ]);
    expect(result.code).toBe(1);
    expect(result.frame.error.message).toContain(
      'computer vm-1 is running: stop it before binding its first secrets ([REDACTED])',
    );
    expect(result.out).not.toContain('API_TOKEN');
  });
});

const AID = 'art_0123456789abcdef0123456789abcdef';
const CONTENT = new TextEncoder().encode('report contents\n');
const HASH = createHash('sha256').update(CONTENT).digest('hex');
const artifactRow = (size = CONTENT.length, sha256 = HASH) => ({
  artifact_id: AID,
  kind: 'artifact',
  state: 'ready',
  computer_id: 'vm-1',
  workspace_id: null,
  created_at: '2026-09-15T12:00:00Z',
  expires_at: '2026-09-16T12:00:00Z',
  size,
  sha256,
  execution_association: null,
});
const b64 = (text: string) => Buffer.from(text).toString('base64');

function artifactRoutes(
  opts: {
    exec?: { exit_code: number; stdout: string; stderr?: string };
    body?: Uint8Array;
    manifest?: ReturnType<typeof artifactRow>;
  } = {},
): Responder {
  return (call) => {
    if (call.path === '/computers/vm-1/exec') {
      const e = opts.exec ?? { exit_code: 0, stdout: `${CONTENT.length}\n${HASH}  -\n` };
      return json({
        exit_code: e.exit_code,
        stdout_b64: b64(e.stdout),
        stderr_b64: b64(e.stderr ?? ''),
        timed_out: false,
      });
    }
    if (call.path.endsWith('/download')) {
      const body = opts.body ?? CONTENT;
      return new Response(body, {
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(body.length),
        },
      });
    }
    if (call.method === 'DELETE' && call.path.includes('/artifacts/'))
      return new Response(null, { status: 204 });
    if (call.path.includes('/artifacts'))
      return json(opts.manifest ?? artifactRow(), { status: call.method === 'POST' ? 201 : 200 });
    return anyRoute(call);
  };
}

describe('artifacts', () => {
  it('reads one artifact', async () => {
    const h = harness(artifactRoutes());
    const result = await h.run(['artifacts', 'get', 'demo', AID]);
    expect(result.code).toBe(0);
    expect(h.rec.routes()).toEqual([
      ['GET', 'computers'],
      ['GET', 'computers/demo'],
      ['GET', `computers/vm-1/artifacts/${AID}`],
    ]);
    expect(result.frame.data).toMatchObject({
      artifact_id: AID,
      size: CONTENT.length,
      sha256: HASH,
      expires_at: '2026-09-16T12:00:00Z',
    });
  });

  it('exports a guest file, reading its size and SHA-256 on the computer first', async () => {
    const h = harness(artifactRoutes());
    const path = "/home/user/it's here.txt";
    const result = await h.run(['artifacts', 'export', 'vm-1', path]);
    expect(result.code).toBe(0);
    expect(h.rec.routes()).toEqual([
      ['GET', 'computers'],
      ['POST', 'computers/vm-1/exec'],
      ['POST', 'computers/vm-1/artifacts'],
    ]);
    // The path is one shell word, its own quote escaped.
    const command = (h.rec.calls[1]!.body as { command: string }).command;
    expect(command).toContain(`'/home/user/it'\\''s here.txt'`);
    expect(h.rec.last().body).toEqual({
      path,
      expected_size: CONTENT.length,
      expected_sha256: HASH,
    });
    expect(result.frame.data).toMatchObject({ artifact_id: AID });
  });

  it('exports with a given --size and --sha256 without reading on the computer', async () => {
    const h = harness(artifactRoutes());
    const result = await h.run([
      'artifacts',
      'export',
      'vm-1',
      '/tmp/report.txt',
      '--size',
      String(CONTENT.length),
      '--sha256',
      HASH,
      '--max-bytes',
      '1024',
      '--retention-seconds',
      '3600',
    ]);
    expect(result.code).toBe(0);
    expect(h.rec.routes()).toEqual([
      ['GET', 'computers'],
      ['POST', 'computers/vm-1/artifacts'],
    ]);
    expect(h.rec.last().body).toEqual({
      path: '/tmp/report.txt',
      expected_size: CONTENT.length,
      expected_sha256: HASH,
      max_bytes: 1024,
      retention_seconds: 3600,
    });
  });

  it('publishes nothing when the file cannot be read on the computer', async () => {
    const h = harness(
      artifactRoutes({ exec: { exit_code: 2, stdout: '', stderr: 'not a regular file\n' } }),
    );
    const result = await h.run(['artifacts', 'export', 'vm-1', '/tmp/missing']);
    expect(result.code).toBe(1);
    expect(result.frame.error).toMatchObject({ code: 'artifact_unavailable' });
    expect(result.frame.error.message).toContain('/tmp/missing on vm-1: not a regular file');
    expect(result.frame.error.message).toContain('--size and --sha256');
    expect(h.rec.routes()).not.toContainEqual(['POST', 'computers/vm-1/artifacts']);
  });

  it('trusts no size or SHA-256 from a read that exited nonzero', async () => {
    const h = harness(
      artifactRoutes({
        exec: { exit_code: 1, stdout: `${CONTENT.length}\n${HASH}  -\n`, stderr: 'read error\n' },
      }),
    );
    const result = await h.run(['artifacts', 'export', 'vm-1', '/tmp/report.txt']);
    expect(result.code).toBe(1);
    expect(result.frame.error).toMatchObject({ code: 'artifact_unavailable' });
    expect(h.rec.routes()).not.toContainEqual(['POST', 'computers/vm-1/artifacts']);
  });

  it('refuses a file over the size limit after reading it, naming --max-bytes', async () => {
    const h = harness(artifactRoutes({ exec: { exit_code: 0, stdout: `9000000\n${HASH}  -\n` } }));
    const result = await h.run(['artifacts', 'export', 'vm-1', '/tmp/big']);
    expect(result.code).toBe(1);
    expect(result.frame.error.message).toMatch(
      /9000000 bytes, over the 8388608-byte limit.*--max-bytes/,
    );
    expect(h.rec.routes()).not.toContainEqual(['POST', 'computers/vm-1/artifacts']);
  });

  it('does not wake a computer that is not running to read the file', async () => {
    const h = harness((call) =>
      call.path === '/computers' ? json([{ ...COMPUTER, status: 'suspended' }]) : anyRoute(call),
    );
    const result = await h.run(['artifacts', 'export', 'vm-1', '/tmp/report.txt']);
    expect(result.code).toBe(1);
    expect(result.frame.error).toMatchObject({ code: 'not_running' });
    expect(h.rec.routes()).toEqual([['GET', 'computers']]);
  });

  it.each([
    [['artifacts', 'export', 'vm-1', '/tmp/x', '--size', '3'], /--size and --sha256 go together/],
    [['artifacts', 'export', 'vm-1', 'relative/path'], /artifact path must be absolute/],
    [['artifacts', 'get', 'vm-1', 'art_nothex'], /<artifact> must be an artifact id/],
    [['artifacts', 'download', 'vm-1', '../etc'], /<artifact> must be an artifact id/],
    [['artifacts', 'rm', 'vm-1', AID], /cannot be undone.*--yes/],
  ])('refuses %j before any request', async (args, message) => {
    const h = harness(artifactRoutes());
    const result = await h.run(args);
    expect(result.code).not.toBe(0);
    expect(result.frame.error.message).toMatch(message);
    expect(h.rec.calls).toEqual([]);
  });

  it('downloads verified bytes to the file named by -o', async () => {
    const dir = await tempDir();
    const dest = join(dir, 'report.txt');
    const h = harness(artifactRoutes());
    const result = await h.run(['artifacts', 'download', 'vm-1', AID, '-o', dest]);
    expect(result.code).toBe(0);
    expect(h.rec.routes()).toEqual([
      ['GET', 'computers'],
      ['GET', `computers/vm-1/artifacts/${AID}`],
      ['GET', `computers/vm-1/artifacts/${AID}/download`],
    ]);
    expect(new Uint8Array(await readFile(dest))).toEqual(CONTENT);
    expect(result.frame.data).toEqual({ artifact_id: AID, path: dest, bytes: CONTENT.length });
  });

  it("downloads an artifact over the SDK's default 8 MiB cap", async () => {
    const dir = await tempDir();
    const dest = join(dir, 'big.bin');
    const big = new Uint8Array(9 * 1024 * 1024).fill(7);
    const bigHash = createHash('sha256').update(big).digest('hex');
    const h = harness(artifactRoutes({ body: big, manifest: artifactRow(big.length, bigHash) }));
    const result = await h.run(['artifacts', 'download', 'vm-1', AID, '-o', dest]);
    expect(result.code).toBe(0);
    expect((await stat(dest)).size).toBe(big.length);
  });

  it('writes nothing when the bytes do not match the SHA-256', async () => {
    const dir = await tempDir();
    const dest = join(dir, 'report.txt');
    const tampered = new TextEncoder().encode('report c0ntents\n');
    const h = harness(artifactRoutes({ body: tampered }));
    const result = await h.run(['artifacts', 'download', 'vm-1', AID, '-o', dest]);
    expect(result.code).toBe(1);
    expect(result.frame.error.message).toMatch(/SHA-256 mismatch/);
    await expect(stat(dest)).rejects.toThrow();
  });

  it('deletes with --yes', async () => {
    const h = harness(artifactRoutes());
    const result = await h.run(['artifacts', 'rm', 'vm-1', AID, '--yes']);
    expect(result.code).toBe(0);
    expect(h.rec.routes()).toEqual([
      ['GET', 'computers'],
      ['DELETE', `computers/vm-1/artifacts/${AID}`],
    ]);
    expect(result.frame.data).toEqual({ artifact_id: AID, deleted: true });
  });
});

describe('the new commands in help, manifest and completion', () => {
  const added = [
    'billing',
    'computers secrets get',
    'computers secrets set',
    'artifacts get',
    'artifacts export',
    'artifacts download',
    'artifacts rm',
  ];

  it('lists each one in help and the manifest', () => {
    const paths = manifest().commands.map((c) => c.path.join(' '));
    for (const path of added) {
      expect(paths).toContain(path);
      expect(help('')).toContain(`mandala ${path}`);
    }
    const set = manifest().commands.find((c) => c.path.join(' ') === 'computers secrets set')!;
    const create = manifest().commands.find((c) => c.path.join(' ') === 'computers create')!;
    // One binding syntax: the same flags, spelled and described the same.
    for (const name of ['secret', 'as', 'secret-file', 'path', 'no-value-check'])
      expect(set.flags.find((f) => f.name === name)).toEqual(
        create.flags.find((f) => f.name === name),
      );
  });

  it.each(['bash', 'zsh'])('completes the new groups and flags in %s', (shell) => {
    const script = completion(shell);
    expect(script).toContain("'artifacts') candidates='get export download rm");
    expect(script).toMatch(/'computers secrets'\) candidates='get set/);
    expect(script).toMatch(/'computers secrets set'\) candidates='[^']*--as [^']*--clear/);
    expect(script).toMatch(/'' *\) candidates='[^']*billing/);
  });

  it('says the desktop computers view opens needs no password', () => {
    expect(help('computers view')).toContain('needs no VNC password');
  });
});
