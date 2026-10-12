import { expect, it, vi } from 'vitest';
import { BrowserRequestOwners } from '../src/browser-request-owners.js';

it('proves same-process foreign ownership with a temporary, read-only attachment', async () => {
  let owners!: BrowserRequestOwners;
  let announced!: Promise<boolean>;
  let otherAttach!: Promise<boolean>;
  const send = vi.fn(async (method: string, params?: Record<string, any>) => {
    if (method === 'Target.getTargetInfo') throw new Error('No target');
    if (method === 'Target.getTargets')
      return { targetInfos: [{ targetId: 'foreign', type: 'page' }] };
    if (method === 'Target.attachToTarget') {
      // Chromium announces the manual attach before its command response.
      announced = owners.probeAttached('probe', 'foreign');
      otherAttach = owners.probeAttached('automatic', 'foreign');
      return { sessionId: 'probe' };
    }
    if (method === 'Page.getFrameTree')
      return { frameTree: { frame: { id: 'foreign' }, childFrames: [{ frame: { id: 'child' } }] } };
    if (method === 'Target.detachFromTarget') expect(params).toEqual({ sessionId: 'probe' });
    return {};
  });
  owners = new BrowserRequestOwners(
    'ours',
    send,
    () => [],
    () => true,
  );
  const [first, second] = await Promise.all([owners.resolve('child'), owners.resolve('child')]);
  expect(first).toMatchObject({ context: '', tab: undefined });
  expect(second).toBe(first);
  await expect(announced).resolves.toBe(true);
  await expect(otherAttach).resolves.toBe(false);
  expect(send.mock.calls.filter(([method]) => method === 'Target.attachToTarget')).toHaveLength(1);
  expect(send.mock.calls.map(([method]) => method)).not.toContain(
    'Runtime.runIfWaitingForDebugger',
  );
  expect(send.mock.calls.map(([method]) => method)).not.toContain('Page.enable');
  expect(send.mock.calls.at(-1)?.[0]).toBe('Target.detachFromTarget');
});

it('retains owned tombstones and cannot convert an owned frame into a foreign one', async () => {
  const send = vi.fn(async () => ({}));
  const owners = new BrowserRequestOwners(
    'ours',
    send,
    () => [],
    () => true,
  );
  owners.owned('child', 'tab', 'session', 'tab');
  owners.detached('session');
  await expect(owners.resolve('child')).resolves.toMatchObject({
    context: 'ours',
    tab: 'tab',
    live: false,
  });
  expect(() =>
    owners.target({ targetId: 'child', type: 'iframe', browserContextId: 'foreign' }),
  ).toThrow('ownership changed');
  expect(send).not.toHaveBeenCalled();
});

it('a foreign title update does not invalidate children in a pending ownership snapshot', async () => {
  let owners!: BrowserRequestOwners;
  const foreign = { targetId: 'foreign-root', type: 'page', browserContextId: 'foreign-context' };
  const send = vi.fn(async (method: string) => {
    if (method === 'Target.getTargetInfo') throw new Error('Not a Target');
    if (method === 'Target.getTargets') return { targetInfos: [foreign] };
    if (method === 'Target.attachToTarget') return { sessionId: 'probe' };
    if (method === 'Page.getFrameTree') {
      const before = owners.frames.get('foreign-root')!;
      const revision = before.revision;
      owners.target({ ...foreign, title: 'New title' });
      expect(owners.frames.get('foreign-root')).toBe(before);
      expect(before.revision).toBe(revision);
      return {
        frameTree: {
          frame: { id: 'foreign-root' },
          childFrames: [{ frame: { id: 'live-child' } }],
        },
      };
    }
    return {};
  });
  owners = new BrowserRequestOwners(
    'ours',
    send,
    () => [],
    () => true,
  );
  await expect(owners.resolve('live-child')).resolves.toMatchObject({ context: 'foreign-context' });
});

it.each([
  [false, false],
  [true, false],
  [false, true],
  [true, true],
])(
  'composes foreign page/OOPIF snapshots while preserving events (detached: %s, unrelated event: %s)',
  async (detached, unrelatedEvent) => {
    let owners!: BrowserRequestOwners;
    let pageDone!: () => void;
    const pageSnapshotRecorded = new Promise<void>((resolve) => {
      pageDone = resolve;
    });
    let oopStarted!: () => void;
    const oopSnapshotStarted = new Promise<void>((resolve) => {
      oopStarted = resolve;
    });
    const send = vi.fn(async (method: string, params?: Record<string, any>, session?: string) => {
      if (method === 'Target.getTargetInfo') throw new Error('No target for nested frame');
      if (method === 'Target.getTargets')
        return {
          targetInfos: [
            { targetId: 'foreign-page', type: 'page', browserContextId: 'foreign-context' },
            { targetId: 'foreign-frame', type: 'iframe', browserContextId: 'foreign-context' },
            { targetId: 'own-frame', type: 'iframe', browserContextId: 'ours' },
            { targetId: 'foreign-worker', type: 'worker', browserContextId: 'foreign-context' },
          ],
        };
      if (method === 'Target.attachToTarget') {
        if (unrelatedEvent && params!.targetId === 'foreign-page') await oopSnapshotStarted;
        return { sessionId: `probe-${params!.targetId}` };
      }
      if (method === 'Page.getFrameTree') {
        if (session === 'probe-foreign-page')
          return {
            frameTree: {
              frame: { id: 'foreign-page' },
              childFrames: [{ frame: { id: 'foreign-frame' } }],
            },
          };
        expect(session).toBe('probe-foreign-frame');
        // In the interleaved case the OOPIF snapshot has already captured its
        // watermark, then an unrelated frame event advances the global revision
        // before the parent's snapshot starts. Its later watermark must not
        // make the placeholder invalidate the deeper OOPIF snapshot.
        if (unrelatedEvent) owners.owned('unrelated-child', 'own-tab', 'own-session');
        oopStarted();
        await pageSnapshotRecorded;
        if (detached) owners.removed('foreign-frame');
        return {
          frameTree: {
            frame: { id: 'foreign-frame', parentId: 'foreign-page' },
            childFrames: [{ frame: { id: 'nested-child' } }],
          },
        };
      }
      if (method === 'Target.detachFromTarget' && params!.sessionId === 'probe-foreign-page')
        pageDone();
      return {};
    });
    owners = new BrowserRequestOwners(
      'ours',
      send,
      () => [],
      () => true,
    );
    const owner = await owners.resolve('nested-child');
    if (detached) {
      expect(owner).toBeUndefined();
      expect(owners.frames.get('foreign-frame')?.live).toBe(false);
    } else {
      expect(owner).toMatchObject({ context: 'foreign-context', parent: 'foreign-frame' });
    }
    expect(
      send.mock.calls
        .filter(([method]) => method === 'Target.attachToTarget')
        .map(([, params]) => params!.targetId),
    ).toEqual(['foreign-page', 'foreign-frame']);
    expect(
      send.mock.calls
        .filter(([method]) => method === 'Target.detachFromTarget')
        .map(([, params]) => params!.sessionId),
    ).toEqual(['probe-foreign-page', 'probe-foreign-frame']);
    expect(send.mock.calls.map(([method]) => method)).not.toContain('Page.enable');
    expect(send.mock.calls.map(([method]) => method)).not.toContain(
      'Runtime.runIfWaitingForDebugger',
    );
  },
);

it('failed metadata and snapshots never prove foreign ownership', async () => {
  const send = vi.fn(async () => {
    throw new Error('gone');
  });
  const owners = new BrowserRequestOwners(
    'ours',
    send,
    () => [{ session: 'session', tab: 'tab' }],
    () => true,
  );
  await expect(owners.resolve('unknown')).resolves.toBeUndefined();
  expect(owners.frames.size).toBe(0);
});

it('does not infer foreign ownership from absent context on worker or other target metadata', async () => {
  const owners = new BrowserRequestOwners(
    'ours',
    async () => {
      throw new Error('unavailable');
    },
    () => [],
    () => true,
  );
  for (const type of ['worker', 'shared_worker', 'service_worker', 'tab', 'other', 'browser_ui']) {
    owners.target({ targetId: type, type });
    await expect(owners.resolve(type)).resolves.toBeUndefined();
  }
  owners.target({ targetId: 'explicit-worker', type: 'worker', browserContextId: 'foreign' });
  await expect(owners.resolve('explicit-worker')).resolves.toMatchObject({ context: 'foreign' });
});

it('waits for a restored tree before deciding requests from its previously retired children', async () => {
  let deliver!: (value: Record<string, any>) => void;
  const send = vi.fn(
    () =>
      new Promise<Record<string, any>>((resolve) => {
        deliver = resolve;
      }),
  );
  const owners = new BrowserRequestOwners(
    'ours',
    send,
    () => [{ session: 'session', tab: 'tab' }],
    () => true,
  );
  owners.owned('tab', 'tab', 'session');
  owners.owned('old-child', 'tab', 'session', 'tab');
  owners.owned('restored-child', 'tab', 'session', 'tab');
  owners.navigated('tab');
  const refresh = owners.refresh('session', 'tab');
  const request = owners.resolve('restored-child');
  deliver({
    frameTree: { frame: { id: 'tab' }, childFrames: [{ frame: { id: 'restored-child' } }] },
  });
  await refresh;
  await expect(request).resolves.toMatchObject({ tab: 'tab', live: true });
  expect(owners.frames.get('old-child')?.live).toBe(false);
});

it('bounds retained provenance without evicting owned frame tombstones', () => {
  const owners = new BrowserRequestOwners(
    'ours',
    async () => ({}),
    () => [],
    () => true,
  );
  owners.owned('old', 'tab', 'session');
  owners.removed('old');
  for (let i = 0; i < 8191; i++) owners.target({ targetId: `f-${i}`, type: 'page' });
  expect(() => owners.target({ targetId: 'overflow', type: 'page' })).toThrow('provenance full');
  expect(owners.frames.get('old')).toMatchObject({ context: 'ours', live: false });
});
