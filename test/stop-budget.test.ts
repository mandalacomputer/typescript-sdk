import { afterEach, expect, it, vi } from 'vitest';
import { Client } from '../src/index.js';

const BASE = 'https://api.test/api/v1';
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function clock() {
  vi.useFakeTimers();
  return vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), ms);
    return controller.signal;
  });
}
function transport() {
  let stops = 0;
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    if (init?.method !== 'POST') return Response.json({ id: 'vm-1', status: 'running' });
    stops++;
    return new Promise<Response>((resolve, reject) => {
      const signal = init.signal;
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', abort);
        resolve(Response.json({ id: 'vm-1', status: 'stopped' }));
      }, 65_000);
      const abort = () => {
        clearTimeout(timer);
        reject(signal?.reason);
      };
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
    });
  };
  return { fetch, count: () => stops };
}
it.each([5_000, 60_000, 180_000, 0])(
  'a 65-second stop succeeds with client timeout %s',
  async (timeoutMs) => {
    const deadlines = clock();
    const t = transport();
    const client = new Client({
      apiKey: 'gck_test',
      baseUrl: BASE,
      timeoutMs,
      fetch: t.fetch,
    });
    const computer = await client.computers.get('vm-1');
    deadlines.mockClear();
    const stopping = computer.stop();
    await vi.advanceTimersByTimeAsync(65_000);
    expect((await stopping).status).toBe('stopped');
    expect(t.count()).toBe(1);
    expect(deadlines.mock.calls.map(([ms]) => ms)).toEqual(
      timeoutMs === 0 ? [] : [Math.max(timeoutMs, 95_000)],
    );
  },
);
it('a caller may still cancel a stop', async () => {
  clock();
  const t = transport();
  const client = new Client({
    apiKey: 'gck_test',
    baseUrl: BASE,
    fetch: t.fetch,
  });
  const computer = await client.computers.get('vm-1');
  const controller = new AbortController();
  const stopping = computer.stop({ signal: controller.signal }).catch((e: unknown) => e);
  await vi.advanceTimersByTimeAsync(1000);
  controller.abort(new Error('caller cancelled'));
  expect(await stopping).toBeInstanceOf(Error);
  expect(t.count()).toBe(1);
});
