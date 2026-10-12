/** Private, bounded provenance for browser-root HTTP interception. */
type Message = Record<string, any>;
export type RequestOwner = {
  readonly tab?: string;
  readonly context: string;
  live: boolean;
  source?: string;
  parent?: string;
  revision: number;
  epoch: number;
};
const MAX_FRAMES = 8192;
const MAX_TARGETS = 128;
const MAX_LOOKUPS = 64;
const LOOKUP_MS = 5000;

export class BrowserRequestOwners {
  readonly frames = new Map<string, RequestOwner>();
  #revision = 0;
  #lookups = new Map<string, Promise<RequestOwner | undefined>>();
  #inventory?: Promise<void>;
  #probes = new Map<string, Promise<string | undefined>>();
  #probeSessions = new Set<string>();
  #refreshing = new Map<string, Promise<void>>();
  constructor(
    readonly context: string,
    private send: (method: string, params?: Message, session?: string) => Promise<Message>,
    private sessions: () => { session: string; tab: string }[],
    private live: () => boolean,
  ) {}

  #record(id: unknown, context: string, tab?: string, source?: string, parent?: unknown): void {
    if (typeof id !== 'string' || !id) throw new Error('Invalid frame identity');
    const previous = this.frames.get(id);
    if (previous && (previous.context !== context || previous.tab !== tab))
      throw new Error('Frame ownership changed');
    if (!previous && this.frames.size >= MAX_FRAMES) throw new Error('Frame provenance full');
    this.frames.set(id, {
      context,
      tab,
      source,
      parent: typeof parent === 'string' ? parent : previous?.parent,
      live: true,
      revision: ++this.#revision,
      epoch: previous?.epoch ?? 0,
    });
  }

  owned(id: unknown, tab: string, source: string, parent?: unknown): void {
    this.#record(id, this.context, tab, source, parent);
  }

  refused(id: string): void {
    this.#record(id, this.context);
    this.removed(id);
  }

  removed(id: string, descendantsOnly = false): void {
    const removed = new Set([id]);
    for (let changed = true; changed; ) {
      changed = false;
      for (const [frame, owner] of this.frames)
        if (owner.parent && removed.has(owner.parent) && !removed.has(frame)) {
          removed.add(frame);
          changed = true;
        }
    }
    if (descendantsOnly) removed.delete(id);
    for (const frame of removed) {
      const owner = this.frames.get(frame);
      if (owner) {
        owner.live = false;
        owner.epoch++;
        owner.revision = ++this.#revision;
      }
    }
  }

  navigated(id: string): void {
    // A new document retires descendants even when Chromium emits no detach
    // events. Do not advance the live root's epoch: a delayed error-document
    // event may arrive while the next allowed navigation is being checked.
    this.removed(id, true);
  }

  refresh(session: string, tab: string, snapshot?: Promise<Message>): Promise<void> {
    const pending = this.#refreshing.get(session);
    if (pending && !snapshot) return pending;
    const revision = this.#revision;
    const task = (async () => {
      try {
        const { frameTree } = await (snapshot ?? this.send('Page.getFrameTree', {}, session));
        if (this.live() && this.sessions().some((s) => s.session === session && s.tab === tab))
          this.#tree(frameTree, this.context, tab, session, revision);
      } catch {
        /* A failed restore leaves descendant requests refused. */
      }
    })().finally(() => {
      if (this.#refreshing.get(session) === task) this.#refreshing.delete(session);
    });
    this.#refreshing.set(session, task);
    return task;
  }

  detached(session: string): void {
    this.#probeSessions.delete(session);
    for (const owner of this.frames.values())
      if (owner.source === session) {
        owner.live = false;
        owner.epoch++;
        owner.revision = ++this.#revision;
      }
  }

  closedTab(tab: string): void {
    for (const owner of this.frames.values())
      if (owner.tab === tab) {
        owner.live = false;
        owner.epoch++;
        owner.revision = ++this.#revision;
      }
  }

  // Target metadata proves roots. An absent context identifies the default
  // profile only for page/iframe targets; others need an explicit context.
  target(info: Message): void {
    if (
      !info ||
      ![
        'page',
        'iframe',
        'tab',
        'worker',
        'shared_worker',
        'service_worker',
        'background_page',
        'browser_ui',
        'webview',
        'other',
      ].includes(info.type) ||
      typeof info.targetId !== 'string' ||
      (info.browserContextId !== undefined && typeof info.browserContextId !== 'string')
    )
      return;
    if (info.browserContextId === undefined && !['page', 'iframe'].includes(info.type)) return;
    if (info.browserContextId !== this.context) {
      const context = info.browserContextId ?? '';
      const previous = this.frames.get(info.targetId);
      if (previous) {
        if (previous.context !== context || previous.tab !== undefined)
          throw new Error('Frame ownership changed');
        // Titles, URLs and other Target metadata do not change immutable
        // ownership or invalidate a frame-tree snapshot already in flight.
        // Only frame lifecycle events should advance its revision/liveness.
        return;
      }
      this.#record(info.targetId, context);
    }
  }

  // A manual attach can be announced before its command response. Keep its
  // target intent until that response identifies the exact probe session;
  // concurrent auto-attachments still follow the normal release/detach path.
  async probeAttached(session: string, target: string): Promise<boolean> {
    if (this.#probeSessions.has(session)) return true;
    const pending = this.#probes.get(target);
    return pending !== undefined && (await pending) === session;
  }

  #tree(
    tree: Message,
    context: string,
    tab: string | undefined,
    source: string | undefined,
    revision: number,
    parent?: string,
    budget = { left: MAX_FRAMES },
  ): void {
    if (!tree?.frame || --budget.left < 0) throw new Error('Invalid frame tree');
    const id = tree.frame.id;
    const previous = this.frames.get(id);
    // Events newer than this snapshot, including detach tombstones, win.
    if (previous && previous.revision > revision) return;
    this.#record(id, context, tab, source, tree.frame.parentId ?? parent);
    for (const child of tree.childFrames ?? [])
      this.#tree(child, context, tab, source, revision, id, budget);
  }

  async #foreignTree(info: Message): Promise<void> {
    if (!this.live()) return;
    let publish!: (session: string | undefined) => void;
    const attached = new Promise<string | undefined>((resolve) => {
      publish = resolve;
    });
    this.#probes.set(info.targetId, attached);
    let session: string | undefined;
    try {
      const response = await this.send('Target.attachToTarget', {
        targetId: info.targetId,
        flatten: true,
      });
      if (typeof response.sessionId !== 'string') throw new Error('Invalid probe session');
      session = response.sessionId;
      this.#probeSessions.add(session);
      publish(session);
      if (!this.live()) return;
      const revision = this.#revision;
      const { frameTree } = await this.send('Page.getFrameTree', {}, session);
      if (this.live())
        this.#tree(frameTree, info.browserContextId ?? '', undefined, undefined, revision);
    } catch {
      // A vanished or unreadable target is no evidence about the request.
    } finally {
      publish(session);
      if (session) {
        try {
          await this.send('Target.detachFromTarget', { sessionId: session });
        } catch {
          /* Gone. */
        }
        this.#probeSessions.delete(session);
      }
      this.#probes.delete(info.targetId);
    }
  }

  async #scan(): Promise<void> {
    const own = this.sessions();
    if (own.length > MAX_TARGETS) throw new Error('Too many frame sessions');
    await Promise.all(
      own.map(async ({ session, tab }) => {
        const revision = this.#revision;
        try {
          const { frameTree } = await this.send('Page.getFrameTree', {}, session);
          if (this.live() && this.sessions().some((s) => s.session === session && s.tab === tab))
            this.#tree(frameTree, this.context, tab, session, revision);
        } catch {
          /* A detach is not proof of foreign ownership. */
        }
      }),
    );
    if (!this.live()) return;
    const { targetInfos } = await this.send('Target.getTargets');
    if (!Array.isArray(targetInfos) || targetInfos.length > MAX_TARGETS)
      throw new Error('Target inventory unavailable');
    const foreign = targetInfos.filter((info: Message) => {
      this.target(info);
      return (
        info.type === 'page' &&
        typeof info.targetId === 'string' &&
        (info.browserContextId === undefined || typeof info.browserContextId === 'string') &&
        info.browserContextId !== this.context
      );
    });
    // Bound temporary attachments even if the browser has many other pages.
    for (let i = 0; i < foreign.length && this.live(); i += 8)
      await Promise.all(foreign.slice(i, i + 8).map((info: Message) => this.#foreignTree(info)));
  }

  async resolve(id: unknown): Promise<RequestOwner | undefined> {
    if (typeof id !== 'string' || !id) return undefined;
    const known = this.frames.get(id);
    if (known && !known.live && known.context === this.context && this.#refreshing.size) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all(this.#refreshing.values()),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, LOOKUP_MS);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      return this.frames.get(id);
    }
    if (known) return known;
    const pending = this.#lookups.get(id);
    if (pending) return pending;
    if (this.#lookups.size >= MAX_LOOKUPS) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const task = Promise.race([
      (async () => {
        try {
          const { targetInfo } = await this.send('Target.getTargetInfo', { targetId: id });
          if (targetInfo?.targetId === id) this.target(targetInfo);
        } catch {
          /* Same-process frames have no Target; inspect their trees. */
        }
        if (!this.live()) return undefined;
        if (this.frames.has(id)) return this.frames.get(id);
        this.#inventory ??= this.#scan().finally(() => {
          this.#inventory = undefined;
        });
        await this.#inventory;
        return this.frames.get(id);
      })().catch(() => undefined),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), LOOKUP_MS);
      }),
    ]).finally(() => {
      clearTimeout(timer);
      this.#lookups.delete(id);
    });
    this.#lookups.set(id, task);
    return task;
  }
}
