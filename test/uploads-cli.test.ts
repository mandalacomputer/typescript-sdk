import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { type LegacyCommands, runCli } from '../src/cli-commands.js';
import { CliError } from '../src/cli-options.js';
import { runtime } from '../src/cli-runtime.js';
import { Client } from '../src/index.js';
import { BASE, COMPUTER, json, type Responder, recorder } from './harness.js';

async function run(size: number, respond: Responder, extra: string[] = []) {
  const dir = await mkdtemp(join(tmpdir(), 'mandala-large-upload-'));
  const local = join(dir, 'large.bin');
  const handle = await open(local, 'w');
  await handle.truncate(size);
  await handle.close();
  const rec = recorder((call) =>
    call.path === '/computers'
      ? json([COMPUTER])
      : call.path === `/computers/${COMPUTER.id}`
        ? json(COMPUTER)
        : respond(call),
  );
  let stdout = '',
    stderr = '';
  try {
    const code = await main(
      ['files', 'upload', COMPUTER.id, local, '/tmp/file', '--json', ...extra],
      {
        env: { MANDALA_API_KEY: 'com_test' },
        createClient: () =>
          new Client({
            apiKey: 'com_test',
            baseUrl: BASE,
            fetch: rec.fetch,
            retries: { idempotent: 0 },
          }),
        stdout: new Writable({
          write(chunk, _encoding, done) {
            stdout += chunk;
            done();
          },
        }) as never,
        stderr: new Writable({
          write(chunk, _encoding, done) {
            stderr += chunk;
            done();
          },
        }) as never,
      },
    );
    return { code, data: JSON.parse(stdout), stderr, rec };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
describe('large upload CLI', () => {
  it('switches above 64 MiB, uses bounded reads, and cleans the receipt', async () => {
    const size = 64 * 1024 * 1024 + 1;
    const result = await run(size, (call) => {
      expect(call.path.endsWith('/files/uploads')).toBe(true);
      if (call.method === 'DELETE') return json({ ok: true });
      expect(call.raw!.length).toBeLessThanOrEqual(4 * 1024 * 1024);
      const offset = Number(call.query.offset) + call.raw!.length;
      return json({
        path: '/tmp/file',
        upload_id: call.query.upload_id,
        offset,
        size,
        complete: offset === size,
      });
    });
    expect(result.code).toBe(0);
    expect(result.data.data.bytes).toBe(size);
    expect(result.rec.calls.at(-1)?.method).toBe('DELETE');
  });
  it('surfaces ordinary create-only failures without an internal crash', async () => {
    const result = await run(
      64 * 1024 * 1024 + 1,
      () => json({ error: 'already exists', reason: 'exists' }, { status: 409 }),
      ['--no-overwrite'],
    );
    expect(result.code).toBe(1);
    expect(result.data.error.code).toBe('exists');
    expect(result.data.error.details.upload_id).toMatch(/^[a-f0-9]{32}$/);
    expect(result.data.error.details.status).toBe(409);
  });
  it('resumes the supplied ID and includes failed cleanup in the JSON result', async () => {
    const id = 'b'.repeat(32);
    const result = await run(
      6,
      (call) => {
        expect(call.query.upload_id).toBe(id);
        if (call.method === 'DELETE')
          return json({ error: 'not running', reason: 'unavailable' }, { status: 409 });
        const offset = call.method === 'GET' ? 3 : 6;
        if (call.method === 'PUT') {
          expect(call.query.offset).toBe('3');
          expect(call.raw).toHaveLength(3);
        }
        return json({ path: '/tmp/file', upload_id: id, offset, size: 6, complete: offset === 6 });
      },
      ['--upload-id', id],
    );
    expect(result.code).toBe(0);
    expect(result.data.data.cleanup_upload_id).toBe(id);
    expect(result.stderr).toBe('');
  });
});

it('retains the generated upload ID when Ctrl-C interrupts a PUT', async () => {
  let id = '';
  const result = await run(64 * 1024 * 1024 + 1, (call) => {
    id = String(call.query.upload_id);
    process.emit('SIGINT');
    throw new DOMException('interrupted', 'AbortError');
  });
  expect(result.code).toBe(130);
  expect(result.data.error.code).toBe('cancelled');
  expect(id, JSON.stringify({ data: result.data, routes: result.rec.routes() })).toMatch(
    /^[a-f0-9]{32}$/,
  );
  expect(result.data.error.details?.upload_id, JSON.stringify(result.data)).toBe(id);
  expect(result.data.error.message).toContain(id);
});
it('distinguishes cancelled cleanup from an incomplete transfer', async () => {
  const id = 'b'.repeat(32);
  const result = await run(
    3,
    (call) => {
      if (call.method === 'DELETE') {
        process.emit('SIGINT');
        throw new DOMException('cancelled', 'AbortError');
      }
      return json({ path: '/tmp/file', upload_id: id, offset: 3, size: 3, complete: true });
    },
    ['--upload-id', id],
  );
  expect(result.code).toBe(130);
  expect(result.data.error.details).toMatchObject({ upload_id: id, upload_complete: true });
  expect(result.data.error.message).toContain('Upload complete');
});

it('retains the nested recovery ID if cancellation follows a create-only refusal', async () => {
  const id = 'c'.repeat(32);
  let stdout = '';
  const code = await runCli(
    ['files', 'upload', COMPUTER.id, 'source.bin', '/tmp/file', '--json'],
    runtime({
      env: { MANDALA_API_KEY: 'com_test' },
      stdout: new Writable({
        write(chunk, _encoding, done) {
          stdout += chunk;
          done();
        },
      }) as never,
    }),
    {
      upload: async () => {
        const failure = new CliError('exists', 'Destination exists', { uploadId: id });
        // copyIn's async file-close can deliver SIGINT after wrapping the refusal.
        process.emit('SIGINT');
        throw failure;
      },
    } as unknown as LegacyCommands,
  );
  expect(code).toBe(130);
  expect(JSON.parse(stdout).error.details.upload_id).toBe(id);
});
