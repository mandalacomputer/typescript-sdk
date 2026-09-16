import { expect, it } from 'vitest';
import { Client } from '../src/index.js';
import { anyRoute, BASE, json, recorder } from './harness.js';

const RID = 'res_0123456789abcdef0123456789abcdef';
const EID = 'exec_0123456789abcdef0123456789abcdef';
const HASH = '0'.repeat(64);
const manifest = () => ({
  version: 1,
  result_id: RID,
  kind: 'background-output',
  state: 'ready',
  account_id: 'acct-1',
  computer_id: 'vm-1',
  workspace_id: null,
  execution_id: EID,
  capture_started_at: '2026-09-15T12:00:00Z',
  captured_at: '2026-09-15T12:00:01.123456789Z',
  expires_at: '2026-09-16T12:00:00Z',
  source: 'volatile_guest_files',
  execution_observation: { status: 'running', observed_at: '2026-09-15T12:00:00Z' },
  stdout: {
    bytes: 3,
    sha256: HASH,
    source_offset: 0,
    next_source_offset: 3,
    end_reason: 'observed_eof',
  },
  stderr: {
    bytes: 0,
    sha256: HASH,
    source_offset: 0,
    next_source_offset: 0,
    end_reason: 'byte_limit',
  },
  diagnostic: { bytes: 0, sha256: HASH, source: 'wrapper', diagnostic_truncated: false },
});
const setup = async (
  override?: (call: import('./harness.js').Call) => Response | Promise<Response>,
) => {
  const rec = recorder((call) => {
    if (override && call.path !== '/computers/vm-1') return override(call);
    if (call.method === 'DELETE') return new Response(null, { status: 204 });
    if (call.path.endsWith('/output'))
      return new Response(new Uint8Array([0, 255, 226]), {
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': '3',
          'X-Result-Offset': '0',
          'X-Result-Next-Offset': '3',
          'X-Result-EOF': 'true',
        },
      });
    if (call.path.endsWith('/retained-output')) return json(manifest(), { status: 201 });
    if (call.path.includes('/results/')) return json(manifest());
    return anyRoute(call);
  });
  const c = await new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch }).computers.get(
    'vm-1',
  );
  return { c, rec };
};
it('captures one explicit retained version without preflight', async () => {
  const { c, rec } = await setup();
  expect(await c.retainExecutionOutput(EID)).toMatchObject({ resultId: RID, executionId: EID });
  expect(rec.routes().slice(1)).toEqual([
    ['POST', `computers/vm-1/executions/${EID}/retained-output`],
  ]);
  expect(rec.calls[1]?.body).toEqual({});
});
it('gets a finite result without live guest I/O', async () => {
  const { c, rec } = await setup();
  expect(await c.result(RID)).toMatchObject({ resultId: RID, kind: 'background-output' });
  expect(rec.routes().slice(1)).toEqual([['GET', `computers/vm-1/results/${RID}`]]);
});
it('reads independent raw pages, including binary bytes', async () => {
  const { c, rec } = await setup();
  const first = await c.resultOutput(RID, { stream: 'stdout', offset: 0, limit: 3 });
  expect(first).toEqual({
    resultId: RID,
    stream: 'stdout',
    offset: 0,
    nextOffset: 3,
    eof: true,
    bytes: new Uint8Array([0, 255, 226]),
  });
  expect(await c.resultOutput(RID, { stream: 'stdout', offset: 0, limit: 3 })).toEqual(first);
  expect(rec.calls.slice(1).map((call) => call.query)).toEqual([
    { stream: 'stdout', offset: '0', limit: '3' },
    { stream: 'stdout', offset: '0', limit: '3' },
  ]);
});
it('deletes a result in one request without a preflight', async () => {
  const { c, rec } = await setup();
  expect(await c.deleteResult(RID)).toBeUndefined();
  expect(rec.routes().slice(1)).toEqual([['DELETE', `computers/vm-1/results/${RID}`]]);
});

it('projects both finite kinds and preserves synchronous truncation separately', async () => {
  const base = manifest();
  const v = {
    ...base,
    kind: 'synchronous-output',
    execution_id: null,
    source: 'exec_response',
    diagnostic: null,
    execution_observation: { status: 'exited', observed_at: base.captured_at, exit_code: -9 },
    stdout: {
      ...base.stdout,
      source_response_bytes: 20,
      end_reason: 'byte_limit',
      upstream_truncated: true,
    },
    stderr: {
      ...base.stderr,
      source_response_bytes: 0,
      end_reason: 'response_end',
      upstream_truncated: false,
    },
    secret: 'discard',
  };
  const { c } = await setup(() => json(v));
  const result = await c.result(RID);
  expect(result).toMatchObject({
    kind: 'synchronous-output',
    executionId: null,
    diagnostic: null,
    executionObservation: { status: 'exited', exitCode: -9 },
    stdout: { sourceResponseBytes: 20, upstreamTruncated: true, endReason: 'byte_limit' },
  });
  expect(result).not.toHaveProperty('secret');
  expect(result).not.toHaveProperty('raw');
  expect(result.capturedAt).toBe(base.captured_at);
});
it.each([
  ['version', 2],
  ['kind', 'future'],
  ['state', 'pending'],
  ['result_id', `${RID}\n`],
  ['computer_id', 'foreign'],
  ['account_id', ''],
  ['workspace_id', {}],
  ['capture_started_at', '2026-02-30T12:00:00Z'],
  ['captured_at', '2026-09-15T12:00:01+00:00'],
  ['captured_at', '2026-09-15T12:00:01.1234567890Z'],
  ['expires_at', '2026-09-15T12:00:00Z'],
  ['expires_at', '2026-10-16T12:00:00Z'],
  ['execution_id', null],
  [
    'execution_observation',
    { status: 'running', observed_at: '2026-09-15T12:00:00Z', exit_code: 0 },
  ],
  [
    'execution_observation',
    { status: 'exited', observed_at: '2026-09-15T12:00:00Z', exit_code: 2147483648 },
  ],
  ['execution_observation', { status: 'running', observed_at: '2026-09-15T11:59:59Z' }],
  ['stdout', { ...manifest().stdout, next_source_offset: 4 }],
  ['stdout', { ...manifest().stdout, bytes: 4194305, next_source_offset: 4194305 }],
  ['stdout', { ...manifest().stdout, sha256: 'A'.repeat(64) }],
  ['diagnostic', null],
  ['diagnostic', { ...manifest().diagnostic, bytes: 65537 }],
])('refuses malformed result %s without fallback', async (key, value) => {
  const { c, rec } = await setup(() => json({ ...manifest(), [key]: value }));
  await expect(c.result(RID)).rejects.toThrow();
  expect(rec.calls).toHaveLength(2);
});
it.each([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])(
  'preserves %s fractional timestamp digits',
  async (digits) => {
    const value = manifest();
    value.captured_at = `2026-09-15T12:00:01${digits ? `.${'1'.repeat(digits)}` : ''}Z`;
    const { c } = await setup(() => json(value));
    expect((await c.result(RID)).capturedAt).toBe(value.captured_at);
  },
);
it('binds a capture to its requested execution and refuses a malformed successful publication once', async () => {
  const { c, rec } = await setup(() =>
    json({ ...manifest(), execution_id: `exec_${'f'.repeat(32)}` }, { status: 201 }),
  );
  await expect(c.retainExecutionOutput(EID)).rejects.toThrow(/unconfirmed/);
  expect(rec.calls).toHaveLength(2);
});
it.each([
  null,
  [],
  { maxBytesPerStream: 0 },
  { maxBytesPerStream: 4194305 },
  { maxBytesPerStream: 1.5 },
  { retentionSeconds: true },
  { retentionSeconds: null },
  { retentionSeconds: 604801 },
  { extra: 1 },
])('rejects invalid capture options %j before I/O', async (options) => {
  const { c, rec } = await setup();
  await expect(c.retainExecutionOutput(EID, options as never)).rejects.toThrow();
  expect(rec.calls).toHaveLength(1);
});
it.each([
  { stream: 'x', offset: 0 },
  { stream: 'stdout', offset: -1 },
  { stream: 'stdout', offset: 1.1 },
  { stream: 'stdout', offset: true },
  { stream: 'stdout', offset: 0, limit: 0 },
  { stream: 'stdout', offset: 0, limit: 65537 },
  { stream: 'stdout', offset: Number.MAX_SAFE_INTEGER },
  { stream: 'stdout', offset: 0, limit: null },
])('rejects invalid page input %j before I/O', async (options) => {
  const { c, rec } = await setup();
  await expect(c.resultOutput(RID, options as never)).rejects.toThrow();
  expect(rec.calls).toHaveLength(1);
});
it.each([401, 403, 404, 409, 429, 503])(
  'preserves HTTP%s without an empty fallback or retry',
  async (status) => {
    const { c, rec } = await setup(() =>
      json({ error: 'unavailable', code: 'result_stream_unavailable' }, { status }),
    );
    await expect(c.resultOutput(RID, { stream: 'diagnostic', offset: 0 })).rejects.toMatchObject({
      status,
    });
    expect(rec.calls).toHaveLength(2);
  },
);
it('accepts a page past EOF without inventing movement', async () => {
  const { c } = await setup(
    () =>
      new Response(new Uint8Array(), {
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': '0',
          'X-Result-Offset': '999',
          'X-Result-Next-Offset': '999',
          'X-Result-EOF': 'true',
        },
      }),
  );
  expect(await c.resultOutput(RID, { stream: 'stderr', offset: 999 })).toMatchObject({
    offset: 999,
    nextOffset: 999,
    eof: true,
    bytes: new Uint8Array(),
  });
});
it.each([
  ['X-Result-Offset', '00'],
  ['X-Result-Offset', '0, 0'],
  ['X-Result-Next-Offset', '2'],
  ['X-Result-Next-Offset', '3.0'],
  ['X-Result-EOF', 'TRUE'],
])('rejects malformed %s', async (key, value) => {
  const { c } = await setup(
    () =>
      new Response(new Uint8Array([1, 2, 3]), {
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': '3',
          'X-Result-Offset': '0',
          'X-Result-Next-Offset': '3',
          'X-Result-EOF': 'true',
          [key]: value,
        },
      }),
  );
  await expect(c.resultOutput(RID, { stream: 'stdout', offset: 0 })).rejects.toThrow();
});
it('rejects zero non-EOF progress', async () => {
  const { c } = await setup(
    () =>
      new Response(new Uint8Array(), {
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': '0',
          'X-Result-Offset': '0',
          'X-Result-Next-Offset': '0',
          'X-Result-EOF': 'false',
        },
      }),
  );
  await expect(c.resultOutput(RID, { stream: 'stdout', offset: 0 })).rejects.toThrow();
});
it('keeps concurrent stream readers independent', async () => {
  const { c, rec } = await setup(
    (call) =>
      new Response(new Uint8Array([Number(call.query.offset)]), {
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': '1',
          'X-Result-Offset': call.query.offset ?? '',
          'X-Result-Next-Offset': String(Number(call.query.offset) + 1),
          'X-Result-EOF': 'false',
        },
      }),
  );
  const [a, b] = await Promise.all([
    c.resultOutput(RID, { stream: 'stdout', offset: 7 }),
    c.resultOutput(RID, { stream: 'diagnostic', offset: 2 }),
  ]);
  expect(a.bytes).toEqual(new Uint8Array([7]));
  expect(b.bytes).toEqual(new Uint8Array([2]));
  expect(rec.calls).toHaveLength(3);
});
it('keeps deletion 404 truthful and rejects invalid identities locally', async () => {
  let count = 0;
  const { c, rec } = await setup(() =>
    ++count === 1 ? new Response(null, { status: 204 }) : json({ error: 'gone' }, { status: 404 }),
  );
  await c.deleteResult(RID);
  await expect(c.deleteResult(RID)).rejects.toMatchObject({ status: 404 });
  await expect(c.deleteResult(`${RID}\n`)).rejects.toThrow();
  await expect(c.result('../x')).rejects.toThrow();
  expect(rec.calls).toHaveLength(3);
});
