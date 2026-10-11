import { EventEmitter } from 'node:events';
import v8 from 'node:v8';
import vm from 'node:vm';
import { afterEach, expect, it, vi } from 'vitest';
import { BrowserCDP } from '../src/browser-cdp.js';
import type { BrowserConnection } from '../src/browser-connection.js';

type Command = {
  id: number;
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
};
type Socket = EventEmitter & {
  sent: Command[];
  /** Sessions Chromium no longer knows: every command on them is an error. */
  gone: Set<string>;
  /** Sessions whose commands are never answered. */
  silent: Set<string>;
  ended: boolean;
  message(value: unknown): void;
};
const sockets = vi.hoisted(() => [] as Socket[]);
vi.mock('ws', () => ({
  default: class extends EventEmitter {
    sent: Command[] = [];
    gone = new Set<string>();
    silent = new Set<string>();
    ended = false;
    constructor() {
      super();
      sockets.push(this as unknown as Socket);
      queueMicrotask(() => this.emit('open'));
    }
    message(value: unknown) {
      this.emit('message', Buffer.from(JSON.stringify(value)));
    }
    send(raw: string, callback: () => void) {
      const command = JSON.parse(raw) as Command;
      this.sent.push(command);
      queueMicrotask(() => {
        callback();
        const session = command.sessionId;
        if (session && this.silent.has(session)) return;
        if (session && this.gone.has(session)) {
          this.message({
            id: command.id,
            error: { code: -32001, message: 'Session with given id not found.' },
          });
          return;
        }
        const { method } = command;
        this.message({
          id: command.id,
          result:
            method === 'Target.createBrowserContext'
              ? { browserContextId: 'context' }
              : method === 'Target.createTarget'
                ? { targetId: 'tab' }
                : method === 'Target.closeTarget'
                  ? { success: true }
                  : {},
        });
        if (method === 'Target.createTarget')
          this.message({
            method: 'Target.attachedToTarget',
            params: {
              sessionId: 'session',
              targetInfo: { targetId: 'tab', type: 'page', browserContextId: 'context' },
            },
          });
      });
    }
    terminate() {
      if (!this.ended) {
        this.ended = true;
        this.emit('close');
      }
    }
  },
}));

afterEach(() => {
  vi.useRealTimers();
  sockets.length = 0;
});

async function started(
  policy: (tab: string | undefined, url: string) => Promise<void> = async () => {},
) {
  const backend = new BrowserCDP(
    async () => ({ id: 'grant', url: 'ws://unused', token: 'unused' }) as BrowserConnection,
    async () => {},
    policy,
  );
  await backend.start();
  return { backend, ws: sockets.at(-1)! };
}
// A target Chromium attached on its own, under `parent` (a session) or at the root.
function attach(ws: Socket, parent: string | undefined, session: string, type: string) {
  ws.message({
    method: 'Target.attachedToTarget',
    ...(parent ? { sessionId: parent } : {}),
    params: {
      sessionId: session,
      targetInfo: { targetId: `${session}-target`, type, browserContextId: 'context' },
      waitingForDebugger: true,
    },
  });
}
const paused = (ws: Socket, session: string, requestId: string, url: string) =>
  ws.message({
    method: 'Fetch.requestPaused',
    sessionId: session,
    params: { requestId, request: { url } },
  });
const on = (ws: Socket, session: string) =>
  ws.sent.filter((c) => c.sessionId === session).map((c) => c.method);
const named = (ws: Socket, method: string) => ws.sent.filter((c) => c.method === method);

it('runs a cross-process frame under its page’s request policy and never closes it', async () => {
  const policy = vi.fn(async (_tab: string | undefined, url: string) => {
    if (url.includes('blocked')) throw new Error('refused');
  });
  const { backend, ws } = await started(policy);
  try {
    attach(ws, 'session', 'frame', 'iframe');
    await vi.waitFor(() => expect(on(ws, 'frame')).toContain('Runtime.runIfWaitingForDebugger'));
    // Interception is in place before the frame is let go.
    expect(on(ws, 'frame')).toEqual([
      'Network.enable',
      'Network.setBypassServiceWorker',
      'Fetch.enable',
      'Runtime.enable',
      'Target.setAutoAttach',
      'Runtime.runIfWaitingForDebugger',
    ]);
    // A cross-site frame inside that frame belongs to the same tab.
    attach(ws, 'frame', 'nested', 'iframe');
    await vi.waitFor(() => expect(on(ws, 'nested')).toContain('Runtime.runIfWaitingForDebugger'));
    paused(ws, 'frame', 'r1', 'https://blocked.test/');
    paused(ws, 'nested', 'r2', 'https://allowed.test/');
    await vi.waitFor(() =>
      expect([
        ...named(ws, 'Fetch.failRequest'),
        ...named(ws, 'Fetch.continueRequest'),
      ]).toHaveLength(2),
    );
    expect(named(ws, 'Fetch.failRequest')).toEqual([
      expect.objectContaining({
        sessionId: 'frame',
        params: { requestId: 'r1', errorReason: 'BlockedByClient' },
      }),
    ]);
    expect(named(ws, 'Fetch.continueRequest')).toEqual([
      expect.objectContaining({ sessionId: 'nested', params: { requestId: 'r2' } }),
    ]);
    expect(policy).toHaveBeenCalledWith('tab', 'https://blocked.test/');
    expect(policy).toHaveBeenCalledWith('tab', 'https://allowed.test/');
    expect(named(ws, 'Target.closeTarget')).toEqual([]);
    expect(backend.sessionStatus().state).toBe('active');
    expect(backend.state().tabs).toEqual([expect.objectContaining({ tab_id: 'tab' })]);
    // A detached frame's late requests are not answered for it.
    ws.message({
      method: 'Target.detachedFromTarget',
      sessionId: 'session',
      params: { sessionId: 'frame' },
    });
    paused(ws, 'frame', 'r3', 'https://allowed.test/late');
    await new Promise((r) => setTimeout(r, 10));
    expect(policy).not.toHaveBeenCalledWith('tab', 'https://allowed.test/late');
    expect(backend.sessionStatus().state).toBe('active');
  } finally {
    await backend.close();
  }
});

it('holds dedicated workers paused and still closes targets no owned page holds', async () => {
  const { backend, ws } = await started();
  try {
    attach(ws, 'session', 'frame', 'iframe');
    await vi.waitFor(() => expect(on(ws, 'frame')).toContain('Runtime.runIfWaitingForDebugger'));
    attach(ws, 'session', 'worker', 'worker');
    attach(ws, 'frame', 'frame-worker', 'worker');
    attach(ws, undefined, 'popup', 'page');
    attach(ws, 'stranger', 'orphan', 'iframe');
    await vi.waitFor(() => expect(named(ws, 'Target.closeTarget')).toHaveLength(2));
    expect(named(ws, 'Target.closeTarget').map((c) => c.params.targetId)).toEqual([
      'popup-target',
      'orphan-target',
    ]);
    // Never released, never detached (which would release it), never closed.
    expect(on(ws, 'worker')).toEqual([]);
    expect(on(ws, 'frame-worker')).toEqual([]);
    expect(named(ws, 'Target.detachFromTarget')).toEqual([]);
    expect(backend.sessionStatus().state).toBe('active');
  } finally {
    await backend.close();
  }
});

it('a frame that goes away during its setup leaves the session running', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const { backend, ws } = await started();
  try {
    ws.gone.add('gone');
    attach(ws, 'session', 'gone', 'iframe');
    // Chromium need not answer a command on a session that detached under it.
    ws.silent.add('silent');
    attach(ws, 'session', 'silent', 'iframe');
    await vi.waitFor(() => expect(on(ws, 'silent')).toEqual(['Network.enable']));
    ws.message({
      method: 'Target.detachedFromTarget',
      sessionId: 'session',
      params: { sessionId: 'silent' },
    });
    // Past every command deadline.
    await vi.advanceTimersByTimeAsync(20000);
    expect(on(ws, 'gone')).toEqual(['Network.enable']);
    expect(on(ws, 'silent')).toEqual(['Network.enable']);
    expect(backend.sessionStatus().state).toBe('active');
    expect(ws.ended).toBe(false);
  } finally {
    await backend.close();
  }
});

it('an action waiting on a tab that detaches fails at once, not the session', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const { backend, ws } = await started();
  try {
    ws.silent.add('session');
    const action = backend.perform('get_page_text', {});
    const failed = expect(action).rejects.toThrow(
      'Chromium could not complete the browser action.',
    );
    await vi.waitFor(() => expect(on(ws, 'session')).toContain('Runtime.evaluate'));
    ws.message({ method: 'Target.detachedFromTarget', params: { sessionId: 'session' } });
    await failed;
    await vi.advanceTimersByTimeAsync(20000);
    expect(backend.sessionStatus().state).toBe('active');
  } finally {
    await backend.close();
  }
});

it('detaches reach handlers even when every event slot is waiting on a gone target', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const { backend, ws } = await started();
  try {
    // 300 frames whose setup Chromium never answers: 256 hold every slot and
    // the rest of the attaches, then all the detaches, wait in the queue.
    for (let n = 0; n < 300; n++) {
      ws.silent.add(`frame-${n}`);
      attach(ws, 'session', `frame-${n}`, 'iframe');
    }
    await vi.waitFor(() =>
      expect(ws.sent.filter((c) => c.sessionId?.startsWith('frame-'))).toHaveLength(256),
    );
    for (let n = 0; n < 300; n++)
      ws.message({
        method: 'Target.detachedFromTarget',
        sessionId: 'session',
        params: { sessionId: `frame-${n}` },
      });
    await vi.advanceTimersByTimeAsync(20000);
    expect(backend.sessionStatus().state).toBe('active');
    // A frame already gone when its attach came up is not set up at all.
    expect(ws.sent.filter((c) => c.sessionId?.startsWith('frame-'))).toHaveLength(256);
    // And the session still works.
    paused(ws, 'session', 'after', 'https://allowed.test/');
    await vi.waitFor(() => expect(named(ws, 'Fetch.continueRequest')).toHaveLength(1));
  } finally {
    await backend.close();
  }
});

it.each([1, 300])(
  'a detach takes every session beneath it along, %i descendants waiting',
  async (count) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const policy = vi.fn(async () => {});
    const { backend, ws } = await started(policy);
    try {
      attach(ws, 'session', 'frame', 'iframe');
      await vi.waitFor(() => expect(on(ws, 'frame')).toContain('Runtime.runIfWaitingForDebugger'));
      // Descendants whose setup Chromium never answers; past 256 of them the
      // remaining attaches wait in the queue.
      for (let n = 0; n < count; n++) {
        ws.silent.add(`nested-${n}`);
        attach(ws, 'frame', `nested-${n}`, 'iframe');
      }
      await vi.waitFor(() =>
        expect(ws.sent.filter((c) => c.sessionId?.startsWith('nested-'))).toHaveLength(
          Math.min(count, 256),
        ),
      );
      // Chromium reports only the parent's detach.
      ws.message({
        method: 'Target.detachedFromTarget',
        sessionId: 'session',
        params: { sessionId: 'frame' },
      });
      await vi.advanceTimersByTimeAsync(20000);
      expect(backend.sessionStatus().state).toBe('active');
      expect(ws.sent.filter((c) => c.sessionId?.startsWith('nested-'))).toHaveLength(
        Math.min(count, 256),
      );
      // Nothing beneath it is still treated as part of the tab.
      paused(ws, 'nested-0', 'late', 'https://allowed.test/late');
      paused(ws, 'session', 'after', 'https://allowed.test/after');
      await vi.waitFor(() => expect(named(ws, 'Fetch.continueRequest')).toHaveLength(1));
      expect(policy).not.toHaveBeenCalledWith('tab', 'https://allowed.test/late');
    } finally {
      await backend.close();
    }
  },
);

it('a request whose target already detached does not end the session', async () => {
  const { backend, ws } = await started();
  try {
    ws.gone.add('session');
    paused(ws, 'session', 'r1', 'https://allowed.test/');
    await vi.waitFor(() => expect(named(ws, 'Fetch.continueRequest')).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 10));
    expect(backend.sessionStatus().state).toBe('active');
  } finally {
    await backend.close();
  }
});

it('queues events past its concurrency in arrival order instead of ending the session', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const order: string[] = [];
  const { backend, ws } = await started(async (_tab, url) => {
    order.push(url);
    await gate;
  });
  try {
    for (let n = 0; n < 600; n++) paused(ws, 'session', `r${n}`, `https://example.test/${n}`);
    // Events this driver does not act on take no place in the queue.
    for (let n = 0; n < 10000; n++)
      ws.message({ method: 'Network.dataReceived', sessionId: 'session', params: {} });
    await vi.waitFor(() => expect(order).toHaveLength(256));
    expect(backend.sessionStatus().state).toBe('active');
    release();
    await vi.waitFor(() => expect(named(ws, 'Fetch.continueRequest')).toHaveLength(600));
    expect(order).toEqual(Array.from({ length: 600 }, (_, n) => `https://example.test/${n}`));
    expect(backend.sessionStatus().state).toBe('active');
  } finally {
    await backend.close();
  }
});

it('ends the session, with a reason, when a page floods it past the queue', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const { backend, ws } = await started(() => gate);
  try {
    for (let n = 0; n < 256 + 8192; n++) paused(ws, 'session', `r${n}`, 'https://example.test/');
    expect(backend.sessionStatus().state).toBe('active');
    paused(ws, 'session', 'last', 'https://example.test/');
    expect(backend.sessionStatus()).toMatchObject({
      state: 'ended',
      terminalError: expect.stringContaining('faster than the session could handle'),
    });
    expect(ws.ended).toBe(true);
  } finally {
    release();
    await backend.close();
  }
});

it('bounds the bytes waiting events hold, keeping only what it uses of page payloads', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const { backend, ws } = await started(() => gate);
  try {
    for (let n = 0; n < 256; n++) paused(ws, 'session', `r${n}`, 'https://example.test/');
    const huge = 'x'.repeat(1024 * 1024);
    // 40 MiB of console output waits as the 40 KiB read_console would keep.
    for (let n = 0; n < 40; n++)
      ws.message({
        method: 'Runtime.consoleAPICalled',
        sessionId: 'session',
        params: { type: 'log', args: [{ type: 'string', value: huge }] },
      });
    expect(backend.sessionStatus().state).toBe('active');
    // A payload the driver keeps whole counts whole.
    for (let n = 0; n < 40 && backend.sessionStatus().state === 'active'; n++)
      ws.message({
        method: 'Target.targetInfoChanged',
        params: {
          targetInfo: { targetId: 'other', type: 'page', url: `https://example.test/${huge}` },
        },
      });
    expect(backend.sessionStatus()).toMatchObject({
      state: 'ended',
      terminalError: expect.stringContaining('faster than the session could handle'),
    });
  } finally {
    release();
    await backend.close();
  }
});

it('keeps no page payload alive behind what it cut from it', async () => {
  // V8 can answer slice(), join() and template literals with a view of the
  // original string, so an excerpt can hold its whole payload alive.
  v8.setFlagsFromString('--expose-gc');
  const gc = vm.runInNewContext('gc') as () => void;
  const heap = () => {
    gc();
    gc();
    return v8.getHeapStatistics().used_heap_size;
  };
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const { backend, ws } = await started(() => gate);
  try {
    // Every handler busy, so everything below waits in the queue.
    for (let n = 0; n < 256; n++) paused(ws, 'session', `r${n}`, 'https://example.test/');
    const huge = 'x'.repeat(1024 * 1024);
    const before = heap();
    for (let n = 0; n < 40; n++) {
      ws.message({
        method: 'Runtime.consoleAPICalled',
        sessionId: 'session',
        params: { type: 'log', args: [{ type: 'string', value: huge }] },
      });
      ws.message({
        method: 'Page.javascriptDialogOpening',
        sessionId: 'session',
        params: { type: 'alert', message: huge },
      });
      ws.message({
        method: 'Network.responseReceived',
        sessionId: 'session',
        params: { response: { status: 200, url: `https://example.test/${huge}` } },
      });
    }
    const grown = heap() - before;
    expect(backend.sessionStatus().state).toBe('active');
    // 120 MiB of payloads arrived; what waits is a few hundred KiB of text.
    expect(grown).toBeLessThan(16 * 1024 * 1024);
  } finally {
    release();
    await backend.close();
  }
});
