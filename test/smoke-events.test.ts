import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const source = readFileSync(
  new URL('../scripts/smoke-events.mjs', import.meta.url),
  'utf8',
).replace(/^#![^\n]*\n/, '');
// Execute the actual script, replacing only its SDK import. The fake process
// supplies no real credentials, and the SDK has no network implementation.
const sdkImport = "import('../dist/index.js')";
if (!source.includes(sdkImport)) throw new Error('update the smoke test SDK import seam');
const execute = new Function(
  'loadSdk',
  'process',
  'console',
  'setTimeout',
  'clearTimeout',
  `return (async () => { ${source.replace(sdkImport, 'loadSdk()')} })();`,
) as (...args: unknown[]) => Promise<void>;

class Exit extends Error {
  constructor(readonly status: number) {
    super(`exit ${status}`);
  }
}

type Fault = 'silent' | 'ended' | 'no cursor' | 'empty cursor' | 'error';

function run(args: string[] = [], faultAt = 0, fault?: Fault, key = 'offline-test') {
  const streams: { close: ReturnType<typeof vi.fn>; signal?: AbortSignal }[] = [];
  let background = 0;
  let suspended = false;
  let visible = true;
  const window = { id: 'window-1', x: 1, y: 2, windowClass: 'browser' };
  const vm = {
    id: 'computer-1',
    status: 'running',
    delete: vi.fn(async () => {}),
    waitUntilRunning: vi.fn(async () => {}),
    waitFor: vi.fn(async (type: string) => {
      if (suspended) throw new Error('computer is suspended');
      if (type === 'file.changed') return { path: '/tmp/sdk-watch-2/b.txt' };
      if (type === 'window.opened') return { window, source: 'guest' };
      return { type, synthesized: true, source: 'guest' };
    }),
    exec: vi.fn(async () => ({ ok: true })),
    execBackground: vi.fn(async () => ({ pid: ++background })),
    open: vi.fn(async () => {}),
    windows: vi.fn(async () => [{ ...window, visible }]),
    windowAction: vi.fn(async (_id: string, action: string) => {
      if (action === 'close') return { gone: true };
      visible = false;
      return { window, gone: false };
    }),
    suspend: vi.fn(async () => {
      suspended = true;
    }),
    events: vi.fn((options: { signal?: AbortSignal; onConnect?: (hello: unknown) => void }) => {
      const number = streams.length + 1;
      const broken = number === faultAt;
      const stream = {
        signal: options.signal,
        close: vi.fn(),
        cursor:
          broken && fault === 'no cursor'
            ? undefined
            : broken && fault === 'empty cursor'
              ? ''
              : `cursor-${number}`,
        eventTypes: ['window.opened'],
        windows: [],
        watching: [{ path: '/tmp/sdk-watch', armed: true }],
        async *[Symbol.asyncIterator]() {
          if (broken) {
            if (fault === 'error') throw new Error('stream failed');
            if (fault === 'ended') return;
            if (fault === 'silent') {
              await new Promise<void>((resolve) => {
                if (options.signal?.aborted) resolve();
                else options.signal?.addEventListener('abort', () => resolve(), { once: true });
              });
              return;
            }
          }
          if (number === 3) {
            options.onConnect?.({ watching: [{ path: '/tmp/sdk-watch', armed: false }] });
            yield { type: 'file.changed', armed: true, watch: '/tmp/sdk-watch' };
            yield {
              type: 'file.changed',
              kind: 'created',
              path: '/tmp/sdk-watch/a.txt',
              dir: false,
            };
          } else if (number === 2 || number === 5) {
            yield { type: 'process.exited', pid: background, exitCode: 7, lost: false };
          } else {
            yield { type: 'computer.ready' };
          }
        },
      };
      streams.push(stream);
      return stream;
    }),
  };
  const create = vi.fn(async () => vm);
  const constructed = vi.fn();
  class Client {
    baseUrl = 'https://offline.invalid';
    computers = { create };
    constructor() {
      constructed();
    }
  }
  const loadSdk = vi.fn(async () => ({ Client }));
  const log = vi.fn();
  const outcome = execute(
    loadSdk,
    {
      argv: ['node', 'smoke-events.mjs', ...args],
      env: { MANDALA_API_KEY: key },
      exit: (status: number) => {
        throw new Exit(status);
      },
    },
    { log, error: log },
    setTimeout,
    clearTimeout,
  ).then(
    () => ({ status: 0, error: undefined }),
    (error: unknown) => ({ status: error instanceof Exit ? error.status : 1, error }),
  );
  return { outcome, create, constructed, loadSdk, vm, streams, log };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('event smoke script', () => {
  it.each(['--help', '-h'])(
    'prints %s without loading the SDK or touching a computer',
    async (arg) => {
      const test = run([arg]);
      expect((await test.outcome).status).toBe(0);
      expect(test.log.mock.calls.flat().join('\n')).toContain('usage:');
      expect(test.constructed).not.toHaveBeenCalled();
      expect(test.loadSdk).not.toHaveBeenCalled();
      expect(test.create).not.toHaveBeenCalled();
    },
  );

  it.each(['offline-test', ''])(
    'rejects unknown arguments before checking credentials (%s)',
    async (key) => {
      const test = run(['--typo'], 0, undefined, key);
      expect((await test.outcome).status).toBe(2);
      expect(test.log.mock.calls.flat().join('\n')).toContain('--typo');
      expect(test.constructed).not.toHaveBeenCalled();
      expect(test.loadSdk).not.toHaveBeenCalled();
      expect(test.create).not.toHaveBeenCalled();
    },
  );

  it('still skips without credentials and no arguments', async () => {
    const test = run([], 0, undefined, '');
    expect((await test.outcome).status).toBe(0);
    expect(test.constructed).not.toHaveBeenCalled();
  });

  it('runs the no-argument checks and deletes the computer with no timers left', async () => {
    const test = run();
    expect((await test.outcome).status).toBe(0);
    expect(test.create).toHaveBeenCalledOnce();
    expect(test.vm.delete).toHaveBeenCalledOnce();
    expect(test.streams[0]?.close).toHaveBeenCalledOnce();
    expect(test.streams[3]?.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  for (const site of [1, 4]) {
    it(`bounds a silent cursor acquisition at stream ${site} and deletes the computer`, async () => {
      const test = run([], site, 'silent');
      await vi.advanceTimersByTimeAsync(0);
      expect(test.streams).toHaveLength(site);
      expect(test.streams[site - 1]?.signal).toBeInstanceOf(AbortSignal);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(30_000);
      expect((await test.outcome).status).toBe(1);
      expect(test.streams[site - 1]?.signal?.aborted).toBe(true);
      expect(test.streams[site - 1]?.close).toHaveBeenCalledOnce();
      expect(test.vm.delete).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    });

    it.each(['ended', 'no cursor', 'empty cursor', 'error'] as const)(
      `fails and cleans up when cursor stream ${site} has %s`,
      async (fault) => {
        const test = run([], site, fault);
        expect((await test.outcome).status).toBe(1);
        expect(test.streams).toHaveLength(site);
        expect(test.streams[site - 1]?.close).toHaveBeenCalledOnce();
        expect(test.vm.delete).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
      },
    );
  }
});
