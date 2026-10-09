import { ToolsetConfigError } from '@anthropic-ai/sdk/helpers/beta/toolsets';
import { expect, it, vi } from 'vitest';
import { BrowserFilePolicy, MandalaBrowserToolset } from '../src/anthropic.js';
import { StagedFiles, safeFilename } from '../src/browser-files.js';
import type { Computer } from '../src/index.js';

it('binds a policy to one exact computer and toolset and retains the inherited confirmation requirement', async () => {
  const computer = {
    id: 'vm-one',
    createBrowserConnection: vi.fn(),
    revokeBrowserConnection: vi.fn(),
  } as unknown as Computer;
  const policy = new BrowserFilePolicy(computer, {
    taskId: 'task-a',
    maxFileBytes: 4,
    maxTotalBytes: 4,
  });
  expect(
    () =>
      new MandalaBrowserToolset(computer, {
        remoteFilePolicy: policy,
        configs: { file_upload: { enabled: true } },
      }),
  ).toThrow(ToolsetConfigError);
  expect(
    () => new MandalaBrowserToolset({ ...computer } as Computer, { remoteFilePolicy: policy }),
  ).toThrow('one computer');
  const browser = new MandalaBrowserToolset(computer, { remoteFilePolicy: policy });
  expect(() => new MandalaBrowserToolset(computer, { remoteFilePolicy: policy })).toThrow(
    'one toolset',
  );
  await browser.close();
  const files = new StagedFiles(policy);
  files.context = 'context';
  const item = files.add('../../safe.txt', Buffer.from('abc'), 'local');
  expect(item.filename).toBe('safe.txt');
  expect(item.id).toContain(item.sha256);
  expect(files.selected([item.id])[0]!.data.toString()).toBe('abc');
  for (const ids of [[item.id, item.id], ['file_unauthorized'], ['https://evil.test/file']])
    expect(() => files.selected(ids)).toThrow();
  expect(() => files.add('next.txt', Buffer.from('ab'), 'local')).toThrow();
  expect(() => files.add('evil.exe', Buffer.from('M'), 'local')).toThrow();
  expect(() => files.resolveUploadPaths()).toThrow();
  files.clear();
  expect(() => files.selected([item.id])).toThrow();
});
it.each([
  ['..\\evil.txt', 'evil.txt'],
  ['../../safe.txt', 'safe.txt'],
  ['a\u202etxt.exe', 'a_txt.exe'],
  ['\x00x.txt', '_x.txt'],
])('sanitizes %s', (name, expected) => {
  expect(safeFilename(name)).toBe(expected);
});

it.each([
  [{ url: 42, multiple: true }, false, 1],
  [{ url: 'https://example.test/', multiple: 'yes' }, false, 1],
  [{ url: 'https://example.test/', multiple: 1 }, false, 1],
  [{ url: 'https://example.test/' }, false, 1],
  [null, false, 1],
  [{ url: 'https://example.test/', multiple: false }, true, 1],
  [{ url: 'https://example.test/', multiple: false }, false, 2],
  [{ url: 'https://example.test/', multiple: true }, true, 2],
])(
  'requires a typed destination before upload confirmation: %j',
  async (destination, valid, count) => {
    const { BrowserFiles } = await import('../src/browser-file-session.js');
    const send = vi.fn(async (method: string) => {
      const replies: Record<string, object> = {
        'Page.getFrameTree': { frameTree: { frame: { id: 'frame' } } },
        'Page.createIsolatedWorld': { executionContextId: 1 },
        'DOM.resolveNode': { object: { objectId: 'input' } },
        'Runtime.callFunctionOn': { result: { value: destination } },
      };
      return replies[method] ?? {};
    });
    const backend = {
      closed: false,
      failed: false,
      fileLive: () => true,
      start: async () => {},
      send,
      fileTarget: () => ({ tab: 'tab', session: 'session', node: 1 }),
    };
    const computer = { id: 'vm' } as Computer;
    const files = new BrowserFiles(
      computer,
      new BrowserFilePolicy(computer, { taskId: 'task' }),
      backend as any,
    );
    files.context = files.adapter.context = 'context';
    const items = Array.from({ length: count }, (_, i) =>
      files.adapter.add(`upload-${i}.txt`, Buffer.from('approved'), 'local'),
    );
    const context = {
      toolUse: { id: 'call' },
      input: { target: { ref: 'upload' }, document_ids: items.map((item) => item.id) },
    } as any;
    if (valid) {
      const reviewed = await files.prepare(context);
      expect(reviewed.tabURL).toBe('https://example.test/');
      await files.approved(false);
    } else {
      await expect(files.prepare(context)).rejects.toThrow('Remote browser file operation');
    }
    expect(send.mock.calls.some(([method]) => method === 'Runtime.releaseObject')).toBe(true);
    await files.close();
  },
);

it('shares startup and revokes a grant arriving after close', async () => {
  const { BrowserCDP } = await import('../src/browser-cdp.js');
  const { BrowserFiles } = await import('../src/browser-file-session.js');
  let ready!: () => void;
  const waiting = new Promise<void>((r) => {
    ready = r;
  });
  const create = vi.fn(async () => {
    await waiting;
    return { id: 'late', url: 'ws://unused', token: 'unused' } as any;
  });
  const revoke = vi.fn(async () => {});
  const backend = new BrowserCDP(create, revoke, async () => {});
  const computer = { id: 'vm' } as Computer;
  backend.files = new BrowserFiles(
    computer,
    new BrowserFilePolicy(computer, { taskId: 'task' }),
    backend,
  );
  const one = backend.files.stage(Buffer.from('a'), 'a.txt', 'local').catch((e) => e);
  const two = backend.files.stage(Buffer.from('b'), 'b.txt', 'local').catch((e) => e);
  await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  await backend.close();
  ready();
  expect(await one).toBeInstanceOf(Error);
  expect(await two).toBeInstanceOf(Error);
  expect(revoke).toHaveBeenCalledExactlyOnceWith('late');
});

it('reports cleanup failure and permits public close to retry it', async () => {
  const { BrowserFiles } = await import('../src/browser-file-session.js');
  const computer = {
    id: 'vm',
    createBrowserConnection: vi.fn(),
    revokeBrowserConnection: vi.fn(),
  } as unknown as Computer;
  const original = BrowserFiles.prototype.remote;
  const remote = vi.spyOn(BrowserFiles.prototype, 'remote').mockImplementation(async function (
    this: InstanceType<typeof BrowserFiles>,
    op,
  ) {
    if (op === 'close') {
      if (remote.mock.calls.length === 1) throw new Error('unavailable');
      return {};
    }
    return original.call(this, op);
  });
  vi.spyOn(BrowserFiles.prototype, 'live').mockImplementation(function (
    this: InstanceType<typeof BrowserFiles>,
  ) {
    this.created = true;
    return true;
  });
  try {
    // Mark a context as acquired without needing a guest in this lifecycle regression.
    vi.spyOn(BrowserFiles.prototype, 'stage').mockImplementation(async function (
      this: InstanceType<typeof BrowserFiles>,
    ) {
      this.live();
      throw new Error('staged fixture');
    });
    const browser = new MandalaBrowserToolset(computer, {
      remoteFilePolicy: new BrowserFilePolicy(computer, { taskId: 'task' }),
    });
    await expect(browser.stageLocalFile(Buffer.from('a'), { filename: 'a.txt' })).rejects.toThrow();
    await expect(browser.close()).rejects.toThrow('cleanup');
    expect(browser.sessionStatus.fileCleanupFailed).toBe(true);
    await browser.close();
    expect(browser.sessionStatus.fileCleanupFailed).toBe(false);
    expect(remote).toHaveBeenCalledTimes(2);
  } finally {
    vi.restoreAllMocks();
  }
});

it.each([false, true])(
  'waits for quarantine acquisition, preserving uncertainty=%s',
  async (uncertain) => {
    const { BrowserCDP } = await import('../src/browser-cdp.js');
    const { BrowserFiles } = await import('../src/browser-file-session.js');
    const computer = { id: 'vm' } as Computer;
    const backend = new BrowserCDP(vi.fn(), vi.fn(), async () => {});
    const files = new BrowserFiles(
      computer,
      new BrowserFilePolicy(computer, {
        taskId: 'task',
        downloads: true,
        approveDownload: () => true,
      }),
      backend,
    );
    files.execute = vi.fn(async () => Buffer.from('[65534,65534]'));
    let release!: () => void;
    const waiting = new Promise<void>((r) => {
      release = r;
    });
    let mounted = false;
    files.remote = vi.fn(async (op) => {
      if (op === 'create') {
        await waiting;
        if (uncertain) throw new Error('timeout');
        mounted = true;
        return { path: files.root + '/incoming' };
      }
      const removed = mounted;
      mounted = false;
      return { removed };
    });
    const setup = files.setup('context').catch((e) => e);
    await vi.waitFor(() => expect(files.remote).toHaveBeenCalledTimes(1));
    const closing = files.close();
    release();
    expect(await setup).toBeInstanceOf(Error);
    await closing;
    expect(mounted).toBe(false);
    expect(files.cleanupFailed).toBe(uncertain);
    expect(files.created).toBe(uncertain);
  },
);

it.each([
  'allow',
  'deny',
  'truthy',
  'content',
  'extension',
  'oversize',
  'canceled',
  'wrongpath',
  'throw',
  'unknown',
  'foreign',
  'timeout',
])('gates download visibility (%s)', async (mode) => {
  const { BrowserFiles } = await import('../src/browser-file-session.js');
  const { digest } = await import('../src/browser-files.js');
  const seen: any[] = [],
    changes: any[] = [],
    operations: string[] = [];
  const backend = {
    fileLive: () => true,
    fileChange: (event: any) => changes.push(event),
    send: vi.fn(async () => ({})),
  };
  const computer = { id: 'vm' } as Computer;
  const policy = new BrowserFilePolicy(computer, {
    taskId: 'task',
    downloads: true,
    maxFileBytes: 32,
    maxTotalBytes: 64,
    approveDownload: async (file) => {
      expect(files.adapter.visible.size).toBe(0);
      expect(file).not.toHaveProperty('path');
      seen.push(file);
      if (mode === 'throw') throw new Error('private callback error');
      if (mode === 'timeout') await new Promise(() => {});
      return (
        mode === 'allow' || mode === 'wrongpath' ? true : mode === 'truthy' ? 1 : false
      ) as boolean;
    },
  });
  const files = new BrowserFiles(computer, policy, backend as any);
  files.context = files.adapter.context = 'context';
  files.frame('frame', 'tab');
  const guid = '00000000-0000-0000-0000-000000000001';
  const data = Buffer.from(mode === 'content' ? '\0invalid' : 'hello');
  files.remote = async (op) => {
    operations.push(op);
    if (op === 'seal')
      return { data: data.toString('base64'), size: data.length, sha256: digest(data) };
    if (op === 'publish')
      return {
        path: mode === 'wrongpath' ? '/outside.txt' : `${files.root}/approved/${guid}-safe.txt`,
      };
    return {};
  };
  if (mode === 'foreign') backend.send.mockRejectedValue(new Error('foreign GUID'));
  if (mode === 'timeout') vi.useFakeTimers();
  try {
    await files.event('Browser.downloadWillBegin', {
      guid,
      frameId: ['unknown', 'foreign'].includes(mode) ? 'unknown' : 'frame',
      url: 'https://source.test/file',
      suggestedFilename: mode === 'extension' ? 'evil.exe' : '../../safe.txt',
    });
    expect(files.adapter.visible.size).toBe(0);
    const progress = files.event('Browser.downloadProgress', {
      guid,
      state: mode === 'canceled' ? 'canceled' : 'completed',
      receivedBytes: mode === 'oversize' ? 33 : data.length,
      totalBytes: data.length,
      filePath: '/untrusted-browser-path',
    });
    if (mode === 'timeout') await vi.advanceTimersByTimeAsync(30001);
    await progress;
    expect(files.adapter.visible.size).toBe(mode === 'allow' ? 1 : 0);
    if (mode === 'allow') {
      const path = [...files.adapter.visible][0]!;
      expect(files.adapter.isPathVisible(path)).toBe(true);
      expect(changes.at(-1).path).toBe(path);
      expect(seen[0].sha256).toBe(digest(data));
    } else expect(changes.every((e) => !('path' in e))).toBe(true);
    if (['content', 'extension', 'oversize', 'canceled', 'unknown', 'foreign'].includes(mode)) {
      expect(seen).toEqual([]);
      expect(operations).not.toContain('publish');
    }
    if (mode === 'foreign') expect(operations).toEqual([]);
    if (mode === 'unknown') expect(operations).toEqual(['discard']);
    expect(JSON.stringify(changes)).not.toContain('/untrusted-browser-path');
    await files.close();
    expect(files.adapter.visible.size).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
