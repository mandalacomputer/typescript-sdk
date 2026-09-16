import { expect, it } from 'vitest';
import { Client } from '../src/index.js';
import { anyRoute, BASE, EXEC_OK, json, recorder } from './harness.js';

const RID = 'res_0123456789abcdef0123456789abcdef';
const setup = async (patch: Record<string, unknown> = {}, status = 200) => {
  const rec = recorder((call) =>
    call.path.endsWith('/exec')
      ? json(
          { ...EXEC_OK, out_truncated: false, err_truncated: false, result_id: RID, ...patch },
          { status },
        )
      : anyRoute(call),
  );
  const c = await new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch }).computers.get(
    'vm-1',
  );
  return { c, rec };
};
it('opts in on the existing synchronous request and exposes an optional result', async () => {
  const { c, rec } = await setup();
  const result = await c.exec('true', { retainOutput: true });
  expect(rec.calls[1]?.body).toEqual({ command: 'true', timeout_s: 30, retain_output: true });
  expect(result.resultId).toBe(RID);
  expect(result.ok).toBe(true);
  expect(rec.routes().slice(1)).toEqual([['POST', 'computers/vm-1/exec']]);
});
it('leaves default exec wire behavior unchanged', async () => {
  const { c, rec } = await setup();
  expect((await c.exec('true')).ok).toBe(true);
  expect(rec.calls[1]?.body).toEqual({ command: 'true', timeout_s: 30 });
});

it.each([false, true, {}, { maxBytesPerStream: 17, retentionSeconds: 123 }])(
  'serializes explicit retention %j without a second request',
  async (retainOutput) => {
    const { c, rec } = await setup();
    await c.exec('true', { retainOutput });
    expect(rec.calls[1]?.body).toEqual({
      command: 'true',
      timeout_s: 30,
      ...(retainOutput === false
        ? {}
        : {
            retain_output:
              retainOutput === true
                ? true
                : Object.keys(retainOutput).length
                  ? { max_bytes_per_stream: 17, retention_seconds: 123 }
                  : {},
          }),
    });
    expect(rec.calls).toHaveLength(2);
  },
);
it.each([
  null,
  0,
  1,
  [],
  { signal: new AbortController().signal },
  { maxBytesPerStream: null },
  { maxBytesPerStream: 4194305 },
  { retentionSeconds: 0 },
  { retentionSeconds: 1.5 },
  { future: true },
])('rejects invalid opt-in %j before executing', async (retainOutput) => {
  const { c, rec } = await setup();
  await expect(c.exec('true', { retainOutput: retainOutput as never })).rejects.toThrow();
  expect(rec.calls).toHaveLength(1);
});
it.each([
  { result_id: undefined },
  { result_id: null },
  { result_id: 'bad' },
  { result_id: `${RID}\n` },
  { exit_code: '0' },
  { exit_code: 2147483648 },
  { timed_out: true },
  { out_truncated: undefined },
  { err_truncated: undefined },
  { stdout_b64: 'AB==' },
  { running: true },
  { pid: 42 },
])('preserves legacy interpretation for unconfirmed optional metadata %j', async (patch) => {
  const { c, rec } = await setup(patch);
  const result = await c.exec('true', { retainOutput: true });
  expect(result).not.toHaveProperty('resultId');
  expect(result.raw).toMatchObject(JSON.parse(JSON.stringify(patch)));
  expect(rec.calls).toHaveLength(2);
});
it('accepts a nonzero observed exit without claiming task success or eagerly decoding text', async () => {
  const { c } = await setup({ exit_code: -9, stdout_b64: 'AP/i', out_truncated: true });
  const result = await c.exec('false', { retainOutput: true });
  expect(result.resultId).toBe(RID);
  expect(result.ok).toBe(false);
  expect(result.truncated).toBe(true);
  expect(result.stdout).toEqual(new Uint8Array([0, 255, 226]));
  expect(Object.getOwnPropertyDescriptor(result, 'stdoutText')?.get).toBeTypeOf('function');
});
it('does not attach a retained ID to an accepted 202 response', async () => {
  const { c } = await setup({}, 202);
  const result = await c.exec('true', { retainOutput: true });
  expect(result.ok).toBe(true);
  expect(result).not.toHaveProperty('resultId');
});
it('keeps a large legal base64 response compatible without a regex stack overflow', async () => {
  const { c } = await setup({ stdout_b64: 'AAAA'.repeat(1024 * 1024) });
  const result = await c.exec('true', { retainOutput: true });
  expect(result.resultId).toBe(RID);
  expect(result.stdout.length).toBe(3 * 1024 * 1024);
});
