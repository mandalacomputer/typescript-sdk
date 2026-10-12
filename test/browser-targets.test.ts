import { EventEmitter } from 'node:events';
import v8 from 'node:v8';
import vm from 'node:vm';
import { afterEach, expect, it, vi } from 'vitest';
import { BrowserFilePolicy } from '../src/anthropic.js';
import { BrowserCDP } from '../src/browser-cdp.js';
import type { BrowserConnection } from '../src/browser-connection.js';
import { BrowserFiles } from '../src/browser-file-session.js';
import { digest } from '../src/browser-files.js';
import type { Computer } from '../src/index.js';

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
  /** Methods whose replies the test sends itself. */
  held: Set<string>;
  /** Targets that close themselves first: closing them is a protocol error. */
  closeFails: Set<string>;
  /** Methods this Chromium does not have. */
  unknown: Set<string>;
  ended: boolean;
  message(value: unknown): void;
};
const sockets = vi.hoisted(() => [] as Socket[]);
vi.mock('ws', () => ({
  default: class extends EventEmitter {
    readyState = 1;
    sent: Command[] = [];
    tabs = 0;
    gone = new Set<string>();
    silent = new Set<string>();
    held = new Set<string>();
    closeFails = new Set<string>();
    unknown = new Set<string>();
    ended = false;
    constructor() {
      super();
      sockets.push(this as unknown as Socket);
      queueMicrotask(() => this.emit('open'));
    }
    message(value: unknown) {
      // Chromium sends a session's Page events only once Page is enabled on it.
      const event = value as { method?: string; sessionId?: string };
      if (
        event.method?.startsWith('Page.') &&
        event.sessionId &&
        !this.sent.some((c) => c.method === 'Page.enable' && c.sessionId === event.sessionId)
      )
        throw new Error(`${event.method} on ${event.sessionId}, which never enabled Page`);
      this.emit('message', Buffer.from(JSON.stringify(value)));
    }
    send(raw: string, callback: () => void) {
      const command = JSON.parse(raw) as Command;
      this.sent.push(command);
      queueMicrotask(() => {
        callback();
        const session = command.sessionId;
        if ((session && this.silent.has(session)) || this.held.has(command.method)) return;
        if (session && this.gone.has(session)) {
          this.message({
            id: command.id,
            error: { code: -32001, message: 'Session with given id not found.' },
          });
          return;
        }
        const { method } = command;
        if (this.unknown.has(method)) {
          this.message({
            id: command.id,
            error: { code: -32601, message: `'${method}' wasn't found` },
          });
          return;
        }
        const closing = command.params.targetId as string | undefined;
        if (method === 'Target.closeTarget' && closing && this.closeFails.has(closing)) {
          this.message({
            method: 'Target.detachedFromTarget',
            params: { sessionId: closing.replace(/-target$/, '') },
          });
          this.message({
            id: command.id,
            error: { code: -32602, message: 'No target with given id found' },
          });
          return;
        }
        const n = method === 'Target.createTarget' ? ++this.tabs : 0;
        const tab = n > 1 ? `tab-${n}` : 'tab';
        this.message({
          id: command.id,
          result:
            method === 'Target.createBrowserContext'
              ? { browserContextId: 'context' }
              : method === 'Target.createTarget'
                ? { targetId: tab }
                : method === 'Target.closeTarget'
                  ? { success: true }
                  : method === 'Page.getFrameTree'
                    ? {
                        frameTree: {
                          frame: {
                            id:
                              session === 'session'
                                ? 'tab'
                                : session?.startsWith('session-')
                                  ? session.replace('session', 'tab')
                                  : `${session}-target`,
                          },
                        },
                      }
                    : {},
        });
        if (method === 'Target.createTarget')
          this.message({
            method: 'Target.attachedToTarget',
            params: {
              sessionId: n > 1 ? `session-${n}` : 'session',
              targetInfo: { targetId: tab, type: 'page', browserContextId: 'context' },
            },
          });
      });
    }
    terminate() {
      if (!this.ended) {
        this.readyState = 3;
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
const paused = (
  ws: Socket,
  session: string,
  requestId: string,
  url: string,
  resourceType = 'Fetch',
  frameId = session === 'session' ? 'tab' : `${session}-target`,
) =>
  ws.message({
    method: 'Fetch.requestPaused',
    params: { requestId, resourceType, frameId, request: { url } },
  });
// Fill every slot of the lane that does not wait on caller code: frames whose
// setup Chromium never answers.
async function holdTargets(ws: Socket) {
  for (let n = 0; n < 256; n++) {
    ws.silent.add(`hold-${n}`);
    attach(ws, 'session', `hold-${n}`, 'iframe');
  }
  await vi.waitFor(() =>
    expect(ws.sent.filter((c) => c.sessionId?.startsWith('hold-'))).toHaveLength(256),
  );
}
// Frame tracking as the file session keeps it, 256 frames at most, with the
// download handler replaced by a spy on whether its frame was tracked.
function stubFiles(backend: BrowserCDP) {
  const event = vi.fn(async (_method: string, _p: unknown, _tracked?: boolean) => {});
  const frames = new Map<string, string>();
  backend.files = {
    frames,
    frame(id: string, tab: string) {
      if (!frames.has(id) && frames.size >= 256) return false;
      frames.set(id, tab);
      return true;
    },
    event,
    close: async () => {},
    created: false,
    cleanupFailed: false,
  } as unknown as NonNullable<BrowserCDP['files']>;
  return { event, frames };
}
const download = (ws: Socket, guid: string, frameId: string) =>
  ws.message({ method: 'Browser.downloadWillBegin', params: { guid, frameId } });
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
      'Runtime.enable',
      'Page.enable',
      'Page.addScriptToEvaluateOnNewDocument',
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
        params: { requestId: 'r1', errorReason: 'BlockedByClient' },
      }),
    ]);
    expect(named(ws, 'Fetch.continueRequest')).toEqual([
      expect.objectContaining({ params: { requestId: 'r2' } }),
    ]);
    expect(policy).toHaveBeenCalledWith('tab', 'https://blocked.test/');
    expect(policy).toHaveBeenCalledWith('tab', 'https://allowed.test/');
    expect(named(ws, 'Target.closeTarget')).toEqual([]);
    expect(backend.sessionStatus().state).toBe('active');
    expect(backend.state().tabs).toEqual([expect.objectContaining({ tab_id: 'tab' })]);
    // A detached frame's late requests are refused without invoking policy.
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

it('does not continue a late allow after a frame detaches and reappears', async () => {
  let release!: () => void;
  const policy = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const { backend, ws } = await started(policy);
  try {
    ws.message({
      method: 'Page.frameAttached',
      sessionId: 'session',
      params: { frameId: 'f', parentFrameId: 'tab' },
    });
    paused(ws, 'session', 'held', 'https://allowed.test/', 'Fetch', 'f');
    await vi.waitFor(() => expect(policy).toHaveBeenCalledTimes(1));
    ws.message({
      method: 'Page.frameDetached',
      sessionId: 'session',
      params: { frameId: 'f', reason: 'remove' },
    });
    ws.message({
      method: 'Page.frameAttached',
      sessionId: 'session',
      params: { frameId: 'f', parentFrameId: 'tab' },
    });
    release();
    await vi.waitFor(() => expect(named(ws, 'Fetch.failRequest')).toHaveLength(1));
    expect(named(ws, 'Fetch.continueRequest')).toEqual([]);
  } finally {
    release?.();
    await backend.close();
  }
});

it('retires descendant request ownership when a new document omits detach events', async () => {
  const policy = vi.fn(async () => {});
  const { backend, ws } = await started(policy);
  try {
    ws.message({
      method: 'Page.frameAttached',
      sessionId: 'session',
      params: { frameId: 'old-child', parentFrameId: 'tab' },
    });
    ws.message({
      method: 'Page.frameNavigated',
      sessionId: 'session',
      params: { frame: { id: 'tab', url: 'https://next.test/' } },
    });
    paused(ws, 'session', 'old-request', 'https://allowed.test/', 'Fetch', 'old-child');
    await vi.waitFor(() => expect(named(ws, 'Fetch.failRequest')).toHaveLength(1));
    expect(policy).not.toHaveBeenCalled();
    expect(named(ws, 'Fetch.continueRequest')).toEqual([]);
  } finally {
    await backend.close();
  }
});

it('a delayed error-document event does not refuse the next allowed root navigation', async () => {
  let release!: () => void;
  const policy = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const { backend, ws } = await started(policy);
  try {
    paused(ws, 'session', 'next', 'https://allowed.test/', 'Document', 'tab');
    await vi.waitFor(() => expect(policy).toHaveBeenCalledTimes(1));
    ws.message({
      method: 'Page.frameNavigated',
      sessionId: 'session',
      params: { frame: { id: 'tab', url: 'chrome-error://chromewebdata/' } },
    });
    release();
    await vi.waitFor(() => expect(named(ws, 'Fetch.continueRequest')).toHaveLength(1));
    expect(named(ws, 'Fetch.failRequest')).toEqual([]);
  } finally {
    release?.();
    await backend.close();
  }
});

it('does not initialize a frame detached during the probe-session check', async () => {
  const { backend, ws } = await started();
  try {
    attach(ws, 'session', 'gone-during-check', 'iframe');
    ws.message({
      method: 'Target.detachedFromTarget',
      sessionId: 'session',
      params: { sessionId: 'gone-during-check' },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(on(ws, 'gone-during-check')).toEqual([]);
    expect(backend.sessionStatus().state).toBe('active');
  } finally {
    await backend.close();
  }
});

it('disposes its context before detaching root interception when attribution times out', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const { backend, ws } = await started();
  try {
    ws.held.add('Target.getTargetInfo');
    ws.held.add('Target.disposeBrowserContext');
    paused(ws, 'session', 'uncertain', 'https://foreign.test/', 'Fetch', 'unobserved');
    await vi.advanceTimersByTimeAsync(5001);
    const disposal = named(ws, 'Target.disposeBrowserContext').at(-1)!;
    expect(disposal.params).toEqual({ browserContextId: 'context' });
    expect(ws.ended).toBe(false);
    expect(named(ws, 'Fetch.continueRequest')).toEqual([]);
    const closing = backend.close();
    expect(named(ws, 'Target.disposeBrowserContext')).toHaveLength(1);
    ws.message({ id: disposal.id, result: {} });
    await vi.advanceTimersByTimeAsync(1);
    await closing;
    expect(ws.ended).toBe(true);
    expect(backend.sessionStatus().terminalError).toContain('could not be attributed');
  } finally {
    ws.held.clear();
    await backend.close();
  }
});

it('keeps its context alive when foreign target metadata changes during a frame probe', async () => {
  const policy = vi.fn(async () => {});
  const { backend, ws } = await started(policy);
  const foreign = { targetId: 'foreign-root', type: 'page', browserContextId: 'foreign-context' };
  const command = async (method: string, sessionId?: string) => {
    await vi.waitFor(() =>
      expect(ws.sent.some((c) => c.method === method && c.sessionId === sessionId)).toBe(true),
    );
    return ws.sent.findLast((c) => c.method === method && c.sessionId === sessionId)!;
  };
  for (const method of [
    'Target.getTargetInfo',
    'Target.getTargets',
    'Target.attachToTarget',
    'Page.getFrameTree',
  ])
    ws.held.add(method);
  try {
    paused(ws, 'session', 'foreign-request', 'https://foreign.test/', 'Fetch', 'live-child');
    ws.message({
      id: (await command('Target.getTargetInfo')).id,
      error: { code: -32602, message: 'No target' },
    });
    ws.message({
      id: (await command('Page.getFrameTree', 'session')).id,
      result: { frameTree: { frame: { id: 'tab' } } },
    });
    ws.message({ id: (await command('Target.getTargets')).id, result: { targetInfos: [foreign] } });
    const attach = await command('Target.attachToTarget');
    ws.message({
      method: 'Target.attachedToTarget',
      params: { sessionId: 'probe', targetInfo: foreign },
    });
    ws.message({ id: attach.id, result: { sessionId: 'probe' } });
    const snapshot = await command('Page.getFrameTree', 'probe');
    ws.message({
      method: 'Target.targetInfoChanged',
      params: { targetInfo: { ...foreign, title: 'New title' } },
    });
    ws.message({
      id: snapshot.id,
      result: {
        frameTree: {
          frame: { id: 'foreign-root' },
          childFrames: [{ frame: { id: 'live-child' } }],
        },
      },
    });
    await vi.waitFor(() =>
      expect(named(ws, 'Fetch.continueRequest')).toEqual([
        expect.objectContaining({ params: { requestId: 'foreign-request' } }),
      ]),
    );
    expect(policy).not.toHaveBeenCalled();
    expect(named(ws, 'Target.disposeBrowserContext')).toEqual([]);
    expect(backend.sessionStatus().state).toBe('active');
  } finally {
    ws.held.clear();
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
    expect(
      named(ws, 'Target.closeTarget')
        .map((c) => c.params.targetId)
        .sort(),
    ).toEqual(['orphan-target', 'popup-target']);
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

it('continues known-frame requests at the browser root when page-session commands are unavailable', async () => {
  const { backend, ws } = await started();
  try {
    // Reject page-session commands without announcing a frame lifecycle change.
    ws.gone.add('session');
    paused(ws, 'session', 'r1', 'https://allowed.test/');
    await vi.waitFor(() => expect(named(ws, 'Fetch.continueRequest')).toHaveLength(1));
    const continuation = named(ws, 'Fetch.continueRequest')[0]!;
    expect(continuation.params).toEqual({ requestId: 'r1' });
    expect(continuation).not.toHaveProperty('sessionId');
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
    // Context disposal, not queue drainage, gates interceptor detachment.
    await vi.waitFor(() => expect(ws.ended).toBe(true));
    expect(named(ws, 'Target.disposeBrowserContext')).toHaveLength(1);
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
    await holdTargets(ws);
    for (let n = 0; n < 256; n++) paused(ws, 'session', `r${n}`, 'https://example.test/');
    const huge = 'x'.repeat(1024 * 1024);
    // 40 MiB of console output and dialogs keep only what is reported.
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
    }
    expect(backend.sessionStatus().state).toBe('active');
    // A paused request's URL is kept whole for the policy, and counts whole.
    for (let n = 0; n < 40 && backend.sessionStatus().state === 'active'; n++)
      paused(ws, 'session', `big-${n}`, `https://example.test/${huge}`);
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
    // Every slot busy, so everything below waits in the queue.
    await holdTargets(ws);
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

it('a slow URL policy holds back neither a new tab nor a dialog', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const { backend, ws } = await started(() => gate);
  try {
    // 256 requests wait on the policy and 768 more wait their turn.
    for (let n = 0; n < 1024; n++) paused(ws, 'session', `r${n}`, 'https://example.test/');
    const opened = backend.perform('new_tab', {});
    const stuck = new Promise((r) => setTimeout(() => r('stuck'), 2000));
    expect(await Promise.race([opened, stuck])).toMatchObject({ tab_id: 'tab-2' });
    ws.message({
      method: 'Page.javascriptDialogOpening',
      sessionId: 'session',
      params: { type: 'alert', message: 'hello' },
    });
    await vi.waitFor(() => expect(named(ws, 'Page.handleJavaScriptDialog')).toHaveLength(1));
    expect(named(ws, 'Fetch.continueRequest')).toHaveLength(0);
    expect(backend.sessionStatus().state).toBe('active');
  } finally {
    release();
    await backend.close();
  }
});

it('a backlog of subresource and frame requests holds back no top-level navigation', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const policy = vi.fn(async (_tab: string | undefined, url: string) => {
    if (url.includes('/sub/')) await gate;
  });
  const { backend, ws } = await started(policy);
  try {
    for (let n = 0; n < 512; n++) paused(ws, 'session', `r${n}`, `https://example.test/sub/${n}`);
    // Frame documents are documents too, but nothing waits on them.
    for (let n = 0; n < 512; n++) {
      ws.message({
        method: 'Page.frameAttached',
        sessionId: 'session',
        params: { frameId: `f-${n}`, parentFrameId: 'tab' },
      });
      paused(ws, 'session', `f${n}`, `https://example.test/sub/frame-${n}`, 'Document', `f-${n}`);
    }
    paused(ws, 'session', 'page', 'https://example.test/next', 'Document', 'tab');
    await vi.waitFor(() =>
      expect(named(ws, 'Fetch.continueRequest')).toEqual([
        expect.objectContaining({ params: { requestId: 'page' } }),
      ]),
    );
    expect(backend.sessionStatus().state).toBe('active');
  } finally {
    release();
    await backend.close();
  }
});

it('decides a download’s frame as it arrives, however long the download waits', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const { backend, ws } = await started(() => gate);
  try {
    // A frame attached behind a full target lane is still tracked when its
    // download begins.
    await holdTargets(ws);
    const { event } = stubFiles(backend);
    ws.message({
      method: 'Page.frameAttached',
      sessionId: 'session',
      params: { frameId: 'early' },
    });
    ws.message({
      method: 'Browser.downloadWillBegin',
      params: { guid: 'one', frameId: 'early' },
    });
    await vi.waitFor(() => expect(event).toHaveBeenCalledTimes(1));
    expect(event.mock.calls[0]![2]).toBe(true);
    // A download waiting its turn keeps the frame it began in, though the frame
    // is gone by the time the download is handled.
    for (let n = 0; n < 256; n++) paused(ws, 'session', `r${n}`, 'https://example.test/');
    ws.message({ method: 'Page.frameAttached', sessionId: 'session', params: { frameId: 'late' } });
    ws.message({ method: 'Browser.downloadWillBegin', params: { guid: 'two', frameId: 'late' } });
    ws.message({ method: 'Page.frameDetached', sessionId: 'session', params: { frameId: 'late' } });
    // And one from a frame never seen is not.
    ws.message({
      method: 'Browser.downloadWillBegin',
      params: { guid: 'three', frameId: 'stranger' },
    });
    expect(event).toHaveBeenCalledTimes(1);
    release();
    await vi.waitFor(() => expect(event).toHaveBeenCalledTimes(3));
    expect(event.mock.calls.slice(1).map((c) => c[2])).toEqual([true, false]);
  } finally {
    release();
    await backend.close();
  }
});

it('keeps a frame’s downloads tracked across a process swap, not past its removal', async () => {
  const { backend, ws } = await started();
  const { event } = stubFiles(backend);
  const detached = (frameId: string, reason: string) =>
    ws.message({
      method: 'Page.frameDetached',
      sessionId: 'session',
      params: { frameId, reason },
    });
  try {
    ws.message({ method: 'Page.frameAttached', sessionId: 'session', params: { frameId: 'f' } });
    // The frame navigates cross-site: its old process lets it go as a swap,
    // and it returns as a frame target of its own.
    detached('f', 'swap');
    attach(ws, 'session', 'f', 'iframe');
    await vi.waitFor(() => expect(on(ws, 'f')).toContain('Runtime.runIfWaitingForDebugger'));
    download(ws, 'one', 'f');
    download(ws, 'two', 'f-target');
    detached('f', 'remove');
    download(ws, 'three', 'f');
    await vi.waitFor(() => expect(event).toHaveBeenCalledTimes(3));
    expect(event.mock.calls.map((c) => c[2])).toEqual([true, true, false]);
  } finally {
    await backend.close();
  }
});

it('tracks the same-process frames inside a cross-process frame, and forgets them with it', async () => {
  const { backend, ws } = await started();
  const { event, frames } = stubFiles(backend);
  const frameEvent = (session: string, method: string, params: Record<string, unknown>) =>
    ws.message({ method, sessionId: session, params });
  try {
    frameEvent('session', 'Page.frameAttached', { frameId: 'x-target' });
    frameEvent('session', 'Page.frameDetached', { frameId: 'x-target', reason: 'swap' });
    attach(ws, 'session', 'x', 'iframe');
    await vi.waitFor(() => expect(on(ws, 'x')).toContain('Runtime.runIfWaitingForDebugger'));
    // Page is on before the frame runs, and what it already holds is tracked.
    expect(on(ws, 'x').indexOf('Page.enable')).toBeLessThan(
      on(ws, 'x').indexOf('Runtime.runIfWaitingForDebugger'),
    );
    expect(on(ws, 'x')).toContain('Page.getFrameTree');
    // Only the frame's own session reports a same-process frame inside it.
    frameEvent('x', 'Page.frameAttached', { frameId: 'inner', parentFrameId: 'x-target' });
    download(ws, 'one', 'inner');
    // The frame swaps back into its parent's process: its session goes, with
    // no detach for the frame inside it, and the parent reports the frame.
    ws.message({
      method: 'Target.detachedFromTarget',
      sessionId: 'session',
      params: { sessionId: 'x' },
    });
    frameEvent('session', 'Page.frameAttached', { frameId: 'x-target' });
    download(ws, 'two', 'inner');
    download(ws, 'three', 'x-target');
    await vi.waitFor(() => expect(event).toHaveBeenCalledTimes(3));
    expect(event.mock.calls.map((c) => c[2])).toEqual([true, false, true]);
    expect([...frames.keys()]).toEqual(['x-target']);
  } finally {
    await backend.close();
  }
});

it('frames that come and go do not use up frame tracking', async () => {
  const { backend, ws } = await started();
  const { event, frames } = stubFiles(backend);
  try {
    for (let n = 0; n < 300; n++) {
      attach(ws, 'session', `c${n}`, 'iframe');
      await vi.waitFor(() => expect(on(ws, `c${n}`)).toContain('Runtime.runIfWaitingForDebugger'), {
        interval: 1,
      });
      ws.message({
        method: 'Page.frameAttached',
        sessionId: `c${n}`,
        params: { frameId: `c${n}-inner` },
      });
      ws.message({
        method: 'Page.frameDetached',
        sessionId: 'session',
        params: { frameId: `c${n}-target`, reason: 'remove' },
      });
      ws.message({
        method: 'Target.detachedFromTarget',
        sessionId: 'session',
        params: { sessionId: `c${n}` },
      });
    }
    expect(frames.size).toBeLessThan(5);
    attach(ws, 'session', 'last', 'iframe');
    await vi.waitFor(() => expect(on(ws, 'last')).toContain('Runtime.runIfWaitingForDebugger'));
    ws.message({
      method: 'Page.frameAttached',
      sessionId: 'last',
      params: { frameId: 'last-inner' },
    });
    download(ws, 'late', 'last-inner');
    await vi.waitFor(() => expect(event).toHaveBeenCalledTimes(1));
    expect(event.mock.calls[0]![2]).toBe(true);
  } finally {
    await backend.close();
  }
});

it('a frame-tree reply that arrives with newer frame events does not undo them', async () => {
  const { backend, ws } = await started();
  const { event, frames } = stubFiles(backend);
  ws.held.add('Page.getFrameTree');
  const treeFor = async (session: string) => {
    await vi.waitFor(() =>
      expect(ws.sent.some((c) => c.method === 'Page.getFrameTree' && c.sessionId === session)).toBe(
        true,
      ),
    );
    return ws.sent.find((c) => c.method === 'Page.getFrameTree' && c.sessionId === session)!.id;
  };
  try {
    // A frame swaps back into its parent's process while its tree is on its
    // way: the reply, the detach and the parent's report land in one turn.
    attach(ws, 'session', 'x', 'iframe');
    const first = await treeFor('x');
    ws.gone.add('x');
    ws.message({
      id: first,
      result: {
        frameTree: { frame: { id: 'x-target' }, childFrames: [{ frame: { id: 'x-child' } }] },
      },
    });
    ws.message({
      method: 'Target.detachedFromTarget',
      sessionId: 'session',
      params: { sessionId: 'x' },
    });
    ws.message({
      method: 'Page.frameAttached',
      sessionId: 'session',
      params: { frameId: 'x-target' },
    });
    ws.message({
      method: 'Page.frameNavigated',
      sessionId: 'session',
      params: { frame: { id: 'x-target' } },
    });
    // A live frame whose child goes while its tree is on its way.
    attach(ws, 'session', 'y', 'iframe');
    const second = await treeFor('y');
    ws.message({
      id: second,
      result: {
        frameTree: { frame: { id: 'y-target' }, childFrames: [{ frame: { id: 'y-child' } }] },
      },
    });
    ws.message({
      method: 'Page.frameDetached',
      sessionId: 'y',
      params: { frameId: 'y-child', reason: 'remove' },
    });
    await vi.waitFor(() => expect(on(ws, 'y')).toContain('Runtime.runIfWaitingForDebugger'));
    await new Promise((r) => setTimeout(r, 10));
    download(ws, 'one', 'x-target');
    download(ws, 'two', 'x-child');
    download(ws, 'three', 'y-child');
    download(ws, 'four', 'y-target');
    await vi.waitFor(() => expect(event).toHaveBeenCalledTimes(4));
    expect(event.mock.calls.map((c) => c[2])).toEqual([true, false, false, true]);
    expect([...frames.keys()].sort()).toEqual(['x-target', 'y-target']);
  } finally {
    await backend.close();
  }
});

it('a cross-site frame changing documents leaves its old frames behind', async () => {
  const { backend, ws } = await started();
  const { event, frames } = stubFiles(backend);
  try {
    ws.message({
      method: 'Page.frameAttached',
      sessionId: 'session',
      params: { frameId: 'x-target', parentFrameId: 'tab' },
    });
    attach(ws, 'session', 'x', 'iframe');
    await vi.waitFor(() => expect(on(ws, 'x')).toContain('Runtime.runIfWaitingForDebugger'));
    // Across sites the frame keeps its session; Chromium reports the new
    // document and its children, and nothing about the old children.
    for (let n = 0; n < 300; n++) {
      ws.message({
        method: 'Page.frameNavigated',
        sessionId: 'x',
        params: { frame: { id: 'x-target', parentId: 'tab' } },
      });
      ws.message({
        method: 'Page.frameAttached',
        sessionId: 'x',
        params: { frameId: `child-${n}`, parentFrameId: 'x-target' },
      });
      ws.message({
        method: 'Page.frameAttached',
        sessionId: 'x',
        params: { frameId: `grandchild-${n}`, parentFrameId: `child-${n}` },
      });
    }
    expect([...frames.keys()].sort()).toEqual(['child-299', 'grandchild-299', 'x-target']);
    download(ws, 'one', 'grandchild-299');
    download(ws, 'two', 'child-298');
    await vi.waitFor(() => expect(event).toHaveBeenCalledTimes(2));
    expect(event.mock.calls.map((c) => c[2])).toEqual([true, false]);
  } finally {
    await backend.close();
  }
});

it('a frame-tree reply does not restore the children of a frame that changed documents', async () => {
  const { backend, ws } = await started();
  const { frames } = stubFiles(backend);
  ws.held.add('Page.getFrameTree');
  try {
    attach(ws, 'session', 'x', 'iframe');
    await vi.waitFor(() => expect(on(ws, 'x')).toContain('Page.getFrameTree'));
    const id = ws.sent.find((c) => c.method === 'Page.getFrameTree' && c.sessionId === 'x')!.id;
    ws.message({
      id,
      result: {
        frameTree: {
          frame: { id: 'x-target' },
          childFrames: [
            { frame: { id: 'old-child' }, childFrames: [{ frame: { id: 'old-grandchild' } }] },
          ],
        },
      },
    });
    ws.message({
      method: 'Page.frameNavigated',
      sessionId: 'x',
      params: { frame: { id: 'x-target', parentId: 'tab' } },
    });
    await vi.waitFor(() => expect(on(ws, 'x')).toContain('Runtime.runIfWaitingForDebugger'));
    expect([...frames.keys()]).toEqual(['x-target']);
  } finally {
    await backend.close();
  }
});

it('a frame below one it could not track is not tracked either', async () => {
  const { backend, ws } = await started();
  const { event, frames } = stubFiles(backend);
  const frame = (method: string, params: Record<string, unknown>) =>
    ws.message({ method, sessionId: 'session', params });
  try {
    frame('Page.frameNavigated', { frame: { id: 'tab' } });
    for (let n = 0; n < 254; n++)
      frame('Page.frameAttached', { frameId: `f${n}`, parentFrameId: 'tab' });
    frame('Page.frameAttached', { frameId: 'kept', parentFrameId: 'tab' });
    // Tracking is full: this frame is not tracked.
    frame('Page.frameAttached', { frameId: 'refused', parentFrameId: 'tab' });
    expect(frames.has('refused')).toBe(false);
    // Room again, but a frame below the untracked one could never be reached
    // when the frames above it change documents.
    frame('Page.frameDetached', { frameId: 'f0', reason: 'remove' });
    frame('Page.frameAttached', { frameId: 'orphan', parentFrameId: 'refused' });
    expect(frames.has('orphan')).toBe(false);
    frame('Page.frameNavigated', { frame: { id: 'tab' } });
    expect([...frames.keys()]).toEqual(['tab']);
    download(ws, 'one', 'orphan');
    await vi.waitFor(() => expect(event).toHaveBeenCalledTimes(1));
    expect(event.mock.calls[0]![2]).toBe(false);
  } finally {
    await backend.close();
  }
});

it('a document back from the back/forward cache has its frames tracked again', async () => {
  const { backend, ws } = await started();
  const { event, frames } = stubFiles(backend);
  ws.held.add('Page.getFrameTree');
  try {
    ws.message({
      method: 'Page.frameNavigated',
      sessionId: 'session',
      params: { frame: { id: 'tab' } },
    });
    ws.message({
      method: 'Page.frameNavigated',
      sessionId: 'session',
      params: { frame: { id: 'tab' }, type: 'BackForwardCacheRestore' },
    });
    await vi.waitFor(() =>
      expect(
        ws.sent.filter((c) => c.method === 'Page.getFrameTree' && c.sessionId === 'session'),
      ).toHaveLength(1),
    );
    const id = ws.sent.find(
      (c) => c.method === 'Page.getFrameTree' && c.sessionId === 'session',
    )!.id;
    ws.message({
      id,
      result: { frameTree: { frame: { id: 'tab' }, childFrames: [{ frame: { id: 'restored' } }] } },
    });
    await vi.waitFor(() => expect(frames.has('restored')).toBe(true));
    download(ws, 'one', 'restored');
    await vi.waitFor(() => expect(event).toHaveBeenCalledTimes(1));
    expect(event.mock.calls[0]![2]).toBe(true);
  } finally {
    await backend.close();
  }
});

// A back/forward cache restore of the tab's document whose frame tree the
// test answers itself; resolves to that request's id.
async function restoring(ws: Socket): Promise<number> {
  ws.held.add('Page.getFrameTree');
  ws.message({
    method: 'Page.frameNavigated',
    sessionId: 'session',
    params: { frame: { id: 'tab' } },
  });
  ws.message({
    method: 'Page.frameNavigated',
    sessionId: 'session',
    params: { frame: { id: 'tab' }, type: 'BackForwardCacheRestore' },
  });
  await vi.waitFor(() =>
    expect(ws.sent.some((c) => c.method === 'Page.getFrameTree' && c.sessionId === 'session')).toBe(
      true,
    ),
  );
  return ws.sent.find((c) => c.method === 'Page.getFrameTree' && c.sessionId === 'session')!.id;
}

it('a download during a cache restore waits for the restored frames', async () => {
  const { backend, ws } = await started();
  const { event } = stubFiles(backend);
  try {
    const id = await restoring(ws);
    download(ws, 'restored', 'r');
    download(ws, 'stranger', 's');
    await new Promise((r) => setTimeout(r, 20));
    expect(event).not.toHaveBeenCalled();
    ws.message({
      id,
      result: { frameTree: { frame: { id: 'tab' }, childFrames: [{ frame: { id: 'r' } }] } },
    });
    await vi.waitFor(() => expect(event).toHaveBeenCalledTimes(2));
    expect(event.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      [expect.objectContaining({ guid: 'restored' }), true],
      [expect.objectContaining({ guid: 'stranger' }), false],
    ]);
  } finally {
    await backend.close();
  }
});

it('a download during a cache restore that never answers is refused in time', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const { backend, ws } = await started();
  const { event } = stubFiles(backend);
  try {
    await restoring(ws);
    download(ws, 'restored', 'r');
    await vi.advanceTimersByTimeAsync(4999);
    expect(event).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(event).toHaveBeenCalledTimes(1));
    expect(event.mock.calls[0]![2]).toBe(false);
    expect(backend.sessionStatus().state).toBe('active');
  } finally {
    await backend.close();
  }
});

it('frames reported under a restored frame are tracked once the restore lands', async () => {
  const { backend, ws } = await started();
  const { event, frames } = stubFiles(backend);
  const frame = (method: string, params: Record<string, unknown>) =>
    ws.message({ method, sessionId: 'session', params });
  try {
    const id = await restoring(ws);
    // The restored frame 'a' is not tracked yet; its new child 'b' is
    // reported beneath it, and so is 'c', which goes again at once.
    frame('Page.frameAttached', { frameId: 'b', parentFrameId: 'a' });
    frame('Page.frameAttached', { frameId: 'c', parentFrameId: 'a' });
    frame('Page.frameAttached', { frameId: 'd', parentFrameId: 'c' });
    frame('Page.frameDetached', { frameId: 'c', reason: 'remove' });
    // The tree was read before 'c' went.
    ws.message({
      id,
      result: {
        frameTree: {
          frame: { id: 'tab' },
          childFrames: [
            {
              frame: { id: 'a' },
              childFrames: [{ frame: { id: 'b' } }, { frame: { id: 'c' } }],
            },
          ],
        },
      },
    });
    await vi.waitFor(() => expect(frames.has('b')).toBe(true));
    expect([...frames.keys()].sort()).toEqual(['a', 'b', 'tab']);
    download(ws, 'one', 'b');
    download(ws, 'two', 'd');
    await vi.waitFor(() => expect(event).toHaveBeenCalledTimes(2));
    expect(event.mock.calls.map((c) => c[2])).toEqual([true, false]);
  } finally {
    await backend.close();
  }
});

it.each(['completed', 'canceled'])(
  'a download %s while its start waits on a cache restore is still seen through',
  async (state) => {
    const { backend, ws } = await started();
    const computer = { id: 'vm-restore' } as unknown as Computer;
    const approved: unknown[] = [];
    const files = new BrowserFiles(
      computer,
      new BrowserFilePolicy(computer, {
        taskId: 'restore',
        downloads: true,
        approveDownload: async (file) => {
          approved.push(file);
          return true;
        },
      }),
      backend,
    );
    files.context = files.adapter.context = 'context';
    const guid = '00000000-0000-0000-0000-000000000001';
    const data = Buffer.from('hello');
    const operations: string[] = [];
    files.remote = async (op) => {
      operations.push(op);
      if (op === 'seal')
        return { data: data.toString('base64'), size: data.length, sha256: digest(data) };
      if (op === 'publish') return { path: `${files.root}/approved/${guid}-notes.txt` };
      return {};
    };
    backend.files = files;
    try {
      const id = await restoring(ws);
      ws.message({
        method: 'Browser.downloadWillBegin',
        params: {
          guid,
          frameId: 'r',
          url: 'https://example.test/notes.txt',
          suggestedFilename: 'notes.txt',
        },
      });
      ws.message({
        method: 'Browser.downloadProgress',
        params: { guid, state, receivedBytes: data.length, totalBytes: data.length },
      });
      await new Promise((r) => setTimeout(r, 20));
      ws.message({
        id,
        result: { frameTree: { frame: { id: 'tab' }, childFrames: [{ frame: { id: 'r' } }] } },
      });
      await vi.waitFor(() =>
        expect(files.downloads.get(guid)?.state).toBe(
          state === 'completed' ? 'complete' : 'failed',
        ),
      );
      expect(approved).toHaveLength(state === 'completed' ? 1 : 0);
      expect(operations).toContain(state === 'completed' ? 'publish' : 'discard');
    } finally {
      await backend.close();
    }
  },
);

it('a snapshot that events outrun is dropped rather than remembering them all', async () => {
  const { backend, ws } = await started();
  const { event, frames } = stubFiles(backend);
  try {
    const id = await restoring(ws);
    for (let n = 0; n < 300; n++)
      ws.message({
        method: 'Page.frameDetached',
        sessionId: 'session',
        params: { frameId: `gone-${n}`, reason: 'remove' },
      });
    ws.message({
      id,
      result: { frameTree: { frame: { id: 'tab' }, childFrames: [{ frame: { id: 'r' } }] } },
    });
    download(ws, 'one', 'r');
    await vi.waitFor(() => expect(event).toHaveBeenCalledTimes(1));
    expect(event.mock.calls[0]![2]).toBe(false);
    expect(frames.has('r')).toBe(false);
  } finally {
    await backend.close();
  }
});

it('re-reads at most 16 cache restores at once', async () => {
  const { backend, ws } = await started();
  stubFiles(backend);
  ws.held.add('Page.getFrameTree');
  try {
    ws.message({
      method: 'Page.frameNavigated',
      sessionId: 'session',
      params: { frame: { id: 'tab' } },
    });
    for (let n = 0; n < 20; n++)
      ws.message({
        method: 'Page.frameNavigated',
        sessionId: 'session',
        params: { frame: { id: 'tab' }, type: 'BackForwardCacheRestore' },
      });
    await new Promise((r) => setTimeout(r, 20));
    expect(named(ws, 'Page.getFrameTree')).toHaveLength(16);
    expect(backend.sessionStatus().state).toBe('active');
  } finally {
    await backend.close();
  }
});

it('makes Worker construction throw in every document of a tab and its frames, before they run', async () => {
  const { backend, ws } = await started();
  try {
    attach(ws, 'session', 'frame', 'iframe');
    await vi.waitFor(() => expect(on(ws, 'frame')).toContain('Runtime.runIfWaitingForDebugger'));
    for (const session of ['session', 'frame']) {
      const methods = on(ws, session);
      const script = ws.sent.find(
        (c) => c.sessionId === session && c.method === 'Page.addScriptToEvaluateOnNewDocument',
      )!;
      expect(methods.indexOf('Page.addScriptToEvaluateOnNewDocument')).toBeLessThan(
        methods.indexOf('Runtime.runIfWaitingForDebugger'),
      );
      expect(script.params.runImmediately).toBe(true);
      // The script's own effect, in a fresh realm.
      const realm = vm.createContext({ DOMException });
      vm.runInContext('globalThis.Worker = function Worker() {}', realm);
      vm.runInContext(String(script.params.source), realm);
      expect(() => vm.runInContext("new Worker('/w.js')", realm)).toThrow(
        'Dedicated workers are disabled',
      );
    }
  } finally {
    await backend.close();
  }
});

it('releases a page it did not open before closing it, offline and unable to start workers', async () => {
  const { backend, ws } = await started();
  try {
    attach(ws, undefined, 'popup', 'page');
    await vi.waitFor(() => expect(named(ws, 'Target.closeTarget')).toHaveLength(1));
    expect(on(ws, 'popup')).toEqual([
      'Page.enable',
      'Network.enable',
      'Network.setCacheDisabled',
      'Network.setBypassServiceWorker',
      'Network.emulateNetworkConditionsByRule',
      'Page.addScriptToEvaluateOnNewDocument',
      'Emulation.setScriptExecutionDisabled',
      'Target.setAutoAttach',
      'Runtime.runIfWaitingForDebugger',
    ]);
    // Offline for every request, without touching navigator.onLine.
    expect(
      ws.sent.find((c) => c.method === 'Network.emulateNetworkConditionsByRule')!.params,
    ).toMatchObject({ matchedNetworkConditions: [{ urlPattern: '', offline: true }] });
    // Released before it is closed: closing a held popup wedges its opener.
    const release = ws.sent.findIndex(
      (c) => c.sessionId === 'popup' && c.method === 'Runtime.runIfWaitingForDebugger',
    );
    const close = ws.sent.findIndex((c) => c.method === 'Target.closeTarget');
    expect(release).toBeLessThan(close);
    expect(named(ws, 'Target.closeTarget')[0]!.params).toEqual({ targetId: 'popup-target' });
    expect(named(ws, 'Fetch.enable').map((c) => c.sessionId)).toEqual([undefined]);
    // Its dialog is dismissed, and not reported as the tab's.
    ws.message({
      method: 'Page.javascriptDialogOpening',
      sessionId: 'popup',
      params: { type: 'alert', message: 'popup' },
    });
    await vi.waitFor(() =>
      expect(named(ws, 'Page.handleJavaScriptDialog').map((c) => c.sessionId)).toEqual(['popup']),
    );
    expect(backend.state().state_changes).toEqual([]);
    expect(backend.sessionStatus().state).toBe('active');
  } finally {
    await backend.close();
  }
});

it('a popup that goes during its fence does not end the session', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const { backend, ws } = await started();
  try {
    // One never answers and then detaches; one is gone by the time it is closed.
    ws.silent.add('gone-early');
    attach(ws, undefined, 'gone-early', 'page');
    await vi.waitFor(() => expect(on(ws, 'gone-early')).toEqual(['Page.enable']));
    ws.message({ method: 'Target.detachedFromTarget', params: { sessionId: 'gone-early' } });
    ws.closeFails.add('gone-late-target');
    attach(ws, undefined, 'gone-late', 'page');
    await vi.waitFor(() =>
      expect(on(ws, 'gone-late')).toContain('Runtime.runIfWaitingForDebugger'),
    );
    await vi.advanceTimersByTimeAsync(20000);
    expect(named(ws, 'Target.closeTarget').map((c) => c.params.targetId)).toEqual([
      'gone-late-target',
    ]);
    expect(backend.sessionStatus().state).toBe('active');
    expect(ws.ended).toBe(false);
  } finally {
    await backend.close();
  }
});

it('takes a popup offline the older way on a Chromium without per-rule emulation', async () => {
  const { backend, ws } = await started();
  try {
    ws.unknown.add('Network.emulateNetworkConditionsByRule');
    attach(ws, undefined, 'popup', 'page');
    await vi.waitFor(() => expect(named(ws, 'Target.closeTarget')).toHaveLength(1));
    expect(on(ws, 'popup')).toContain('Runtime.runIfWaitingForDebugger');
    expect(
      ws.sent.find((c) => c.method === 'Network.emulateNetworkConditions')!.params,
    ).toMatchObject({
      offline: true,
    });
    expect(backend.sessionStatus().state).toBe('active');
  } finally {
    await backend.close();
  }
});

it.each([false, true])(
  'a popup that detaches before its fence starts is refused quietly (tab being created: %s)',
  async (creating) => {
    const { backend, ws } = await started();
    try {
      ws.gone.add('early');
      // Its attach and its detach arrive together, before either is handled,
      // while a new tab may still be on its way.
      const opening = creating ? backend.perform('new_tab', {}) : undefined;
      attach(ws, undefined, 'early', 'page');
      ws.message({ method: 'Target.detachedFromTarget', params: { sessionId: 'early' } });
      ws.message({ method: 'Target.targetDestroyed', params: { targetId: 'early-target' } });
      await opening;
      await new Promise((r) => setTimeout(r, 20));
      expect(backend.sessionStatus().state).toBe('active');
      expect(named(ws, 'Target.closeTarget')).toEqual([]);
    } finally {
      await backend.close();
    }
  },
);
