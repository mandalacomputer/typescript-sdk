import { expect, it, vi } from 'vitest';
import { Client } from '../src/index.js';
import { anyRoute, BASE, json, recorder } from './harness.js';

const AID = 'art_0123456789abcdef0123456789abcdef';
const HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const manifest = () => ({
  artifact_id: AID,
  kind: 'artifact',
  state: 'ready',
  computer_id: 'vm-1',
  workspace_id: null,
  created_at: '2026-09-15T12:00:00Z',
  expires_at: '2026-09-16T12:00:00Z',
  size: 0,
  sha256: HASH,
  execution_association: null,
});
const setup = async (
  override?: (call: import('./harness.js').Call) => Response | Promise<Response>,
) => {
  const rec = recorder((call) => {
    if (override && call.path !== '/computers/vm-1') return override(call);
    if (call.method === 'DELETE') return new Response(null, { status: 204 });
    if (call.path.endsWith('/download'))
      return new Response(new Uint8Array(), {
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': '0' },
      });
    if (call.path.includes('/artifacts'))
      return json(manifest(), { status: call.method === 'POST' ? 201 : 200 });
    return anyRoute(call);
  });
  const c = await new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch }).computers.get(
    'vm-1',
  );
  return { c, rec };
};
it('publishes only caller-nominated bytes with no guest preflight', async () => {
  const { c, rec } = await setup();
  expect(
    await c.publishArtifact('/tmp/report', { expectedSize: 0, expectedSha256: HASH }),
  ).toMatchObject({ artifactId: AID, size: 0 });
  expect(rec.routes().slice(1)).toEqual([['POST', 'computers/vm-1/artifacts']]);
  expect(rec.calls[1]?.body).toEqual({
    path: '/tmp/report',
    expected_size: 0,
    expected_sha256: HASH,
  });
});
it('reads artifact metadata once', async () => {
  const { c, rec } = await setup();
  expect(await c.artifact(AID)).toMatchObject({ artifactId: AID });
  expect(rec.routes().slice(1)).toEqual([['GET', `computers/vm-1/artifacts/${AID}`]]);
});
it('downloads a whole verified empty artifact using two fixed requests', async () => {
  const { c, rec } = await setup();
  expect(await c.downloadArtifact(AID)).toEqual(new Uint8Array());
  expect(rec.routes().slice(1)).toEqual([
    ['GET', `computers/vm-1/artifacts/${AID}`],
    ['GET', `computers/vm-1/artifacts/${AID}/download`],
  ]);
});
it('deletes one artifact without metadata or guest requests', async () => {
  const { c, rec } = await setup();
  expect(await c.deleteArtifact(AID)).toBeUndefined();
  expect(rec.routes().slice(1)).toEqual([['DELETE', `computers/vm-1/artifacts/${AID}`]]);
});

it.each([
  '/tmp/ report ',
  '/tmp/a\\b',
  'C:\\Temp\\report',
  'C:/Temp/report',
  '\\\\server\\share\\report',
  '/tmp/é',
])('preserves legal nominated path %s', async (path) => {
  const { c, rec } = await setup();
  await c.publishArtifact(path, { expectedSize: 0, expectedSha256: HASH });
  expect(rec.calls[1]?.body).toMatchObject({ path });
});
it.each(['relative', '~/file', '/tmp/\u0000x', '/tmp/\ud800', `/${'é'.repeat(2048)}`, ''])(
  'rejects invalid path before publication',
  async (path) => {
    const { c, rec } = await setup();
    await expect(
      c.publishArtifact(path, { expectedSize: 0, expectedSha256: HASH }),
    ).rejects.toThrow();
    expect(rec.calls).toHaveLength(1);
  },
);
it.each([
  { expectedSize: -1 },
  { expectedSize: true },
  { expectedSize: 0.5 },
  { expectedSize: 67108865 },
  { expectedSha256: 'A'.repeat(64) },
  { maxBytes: 0 },
  { maxBytes: null },
  { retentionSeconds: null },
  { retentionSeconds: 604801 },
  { executionId: null },
  { executionId: 'exec_no' },
  { extra: 1 },
  { expectedSize: 8388609 },
])('rejects invalid nomination %j before I/O', async (patch) => {
  const { c, rec } = await setup();
  await expect(
    c.publishArtifact('/tmp/f', { expectedSize: 0, expectedSha256: HASH, ...patch } as never),
  ).rejects.toThrow();
  expect(rec.calls).toHaveLength(1);
});
it('checks explicit association and publication size/hash echoes without retry', async () => {
  const eid = `exec_${'a'.repeat(32)}`;
  const good = {
    ...manifest(),
    execution_association: {
      kind: 'caller_selected',
      execution_id: eid,
      verified_at: '2026-09-15T11:59:59.123456789Z',
    },
    private: 'hidden',
  };
  const { c, rec } = await setup(() => json(good, { status: 201 }));
  const result = await c.publishArtifact('/tmp/f', {
    expectedSize: 0,
    expectedSha256: HASH,
    executionId: eid,
    maxBytes: 1,
    retentionSeconds: 1,
  });
  expect(result.executionAssociation).toEqual({
    kind: 'caller_selected',
    executionId: eid,
    verifiedAt: '2026-09-15T11:59:59.123456789Z',
  });
  expect(result).not.toHaveProperty('private');
  expect(result).not.toHaveProperty('accountId');
  expect(result).not.toHaveProperty('version');
  await expect(
    c.publishArtifact('/tmp/f', { expectedSize: 0, expectedSha256: HASH }),
  ).rejects.toThrow(/unconfirmed/);
  expect(rec.calls).toHaveLength(3);
});
it.each([
  ['artifact_id', `art_${'b'.repeat(32)}`],
  ['computer_id', 'other'],
  ['size', 67108865],
  ['size', false],
  ['sha256', `${HASH}\n`],
  ['kind', 'file'],
  ['state', 'pending'],
  ['expires_at', '2026-09-15T12:00:00Z'],
  ['created_at', '2026-02-30T12:00:00Z'],
  ['execution_association', {}],
  ['workspace_id', undefined],
])('rejects malformed artifact %s', async (key, value) => {
  const { c, rec } = await setup(() => json({ ...manifest(), [key]: value }));
  await expect(c.artifact(AID)).rejects.toThrow();
  expect(rec.calls).toHaveLength(2);
});
it('refuses over-cap metadata before any download request', async () => {
  const { c, rec } = await setup(() => json({ ...manifest(), size: 9 }));
  await expect(c.downloadArtifact(AID, { maxBytes: 8 })).rejects.toThrow(/cap/);
  expect(rec.calls).toHaveLength(2);
});
it('returns every byte only after whole-content verification, ignoring filenames and Location', async () => {
  const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
  const { c, rec } = await setup((call) =>
    call.path.endsWith('/download')
      ? new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(bytes.slice(0, 13));
              controller.enqueue(bytes.slice(13));
              controller.close();
            },
          }),
          {
            headers: {
              'Content-Type': 'application/octet-stream',
              'Content-Length': '256',
              'Content-Disposition': 'attachment; filename="evil.html"',
              Location: 'https://foreign.test',
            },
          },
        )
      : json({ ...manifest(), size: 256, sha256: hash }),
  );
  expect(await c.downloadArtifact(AID, { maxBytes: 256 })).toEqual(bytes);
  expect(rec.calls).toHaveLength(3);
  expect(rec.calls[2]?.query).toEqual({});
  expect(rec.calls[2]?.headers.Range).toBeUndefined();
  expect(rec.calls[2]?.headers['Accept-Encoding']).toBe('identity');
});
it('rejects same-sized different retained bytes without returning a prefix', async () => {
  const { c, rec } = await setup((call) =>
    call.path.endsWith('/download')
      ? new Response(new Uint8Array([1]), {
          headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': '1' },
        })
      : json({ ...manifest(), size: 1, sha256: HASH }),
  );
  await expect(c.downloadArtifact(AID)).rejects.toThrow(/SHA-256/);
  expect(rec.calls).toHaveLength(3);
});
it.each([401, 403, 404, 409, 429, 503])(
  'preserves HTTP%s between metadata and bytes with no fallback',
  async (status) => {
    const { c, rec } = await setup((call) =>
      call.path.endsWith('/download')
        ? json({ error: 'unavailable' }, { status })
        : json(manifest()),
    );
    await expect(c.downloadArtifact(AID)).rejects.toMatchObject({ status });
    expect(rec.calls).toHaveLength(3);
  },
);
it('requires crypto before any metadata request', async () => {
  const { c, rec } = await setup();
  vi.stubGlobal('crypto', undefined);
  try {
    await expect(c.downloadArtifact(AID)).rejects.toThrow(/Web Crypto/);
    expect(rec.calls).toHaveLength(1);
  } finally {
    vi.unstubAllGlobals();
  }
});
it('honors abort after the non-interruptible digest and returns no bytes', async () => {
  const { c } = await setup();
  const ac = new AbortController();
  const reason = new Error('cancel hash');
  const native = crypto.subtle.digest.bind(crypto.subtle);
  const spy = vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (...args) => {
    const digest = await native(...args);
    ac.abort(reason);
    return digest;
  });
  try {
    await expect(c.downloadArtifact(AID, { signal: ac.signal })).rejects.toBe(reason);
  } finally {
    spy.mockRestore();
  }
});
it('keeps repeated artifact deletion unavailable, with canonical identity validation', async () => {
  let count = 0;
  const { c, rec } = await setup(() =>
    ++count === 1 ? new Response(null, { status: 204 }) : json({ error: 'gone' }, { status: 404 }),
  );
  await c.deleteArtifact(AID);
  await expect(c.deleteArtifact(AID)).rejects.toMatchObject({ status: 404 });
  await expect(c.deleteArtifact('../x')).rejects.toThrow();
  expect(rec.calls).toHaveLength(3);
});
it('stops between metadata and content when the caller cancels', async () => {
  const ac = new AbortController();
  const reason = new Error('stop after metadata');
  const { c, rec } = await setup(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(JSON.stringify(manifest())));
            controller.close();
            queueMicrotask(() => ac.abort(reason));
          },
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
  );
  await expect(c.downloadArtifact(AID, { signal: ac.signal })).rejects.toBe(reason);
  expect(rec.calls).toHaveLength(2);
});
it.each([null, 0, 67108865, 1.1, true])(
  'rejects invalid independent download cap %j before I/O',
  async (maxBytes) => {
    const { c, rec } = await setup();
    await expect(c.downloadArtifact(AID, { maxBytes: maxBytes as never })).rejects.toThrow();
    expect(rec.calls).toHaveLength(1);
  },
);
it('rejects a short full artifact even with an internally consistent smaller header', async () => {
  const { c, rec } = await setup((call) =>
    call.path.endsWith('/download')
      ? new Response(new Uint8Array(), {
          headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': '0' },
        })
      : json({ ...manifest(), size: 1 }),
  );
  await expect(c.downloadArtifact(AID)).rejects.toThrow(/size mismatch/);
  expect(rec.calls).toHaveLength(3);
});
