/** Private CDP backend. Browser strings and protocol errors never become tool errors. */

import { type BetaBrowserState, ToolError } from '@anthropic-ai/sdk/helpers/beta/toolsets';
import type {
  BrowserConnection,
  BrowserSessionLease,
  BrowserSessionPolicy,
} from './browser-connection.js';

import type { BrowserFiles } from './browser-file-session.js';

// CDP is an extensible protocol. Values stay inside this backend; the Anthropic
// pipeline validates every member result before it reaches the model.
type Message = Record<string, any>;
export class BrowserDriverError extends Error {}
class RequestGone extends BrowserDriverError {}

function bounded(value: unknown, name: string, max: number, integer = false): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > max ||
    (integer && !Number.isInteger(value))
  ) {
    throw new BrowserDriverError(
      `${name} must be ${integer ? 'an integer' : 'a finite number'} between 0 and ${max}`,
    );
  }
  return value;
}
function append(map: Map<string, string[]>, tab: string, line: string): void {
  const lines = map.get(tab) ?? [];
  lines.push(line.slice(0, 2000));
  if (lines.length > 100) lines.shift();
  map.set(tab, lines);
}
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Owned by one toolset; Anthropic CallQueue serializes all public tool calls.
export class BrowserCDP {
  files?: BrowserFiles;
  #starting?: Promise<void>;
  fileLive(): boolean {
    return !this.#closed && !this.#failed;
  }
  fileActive(): string | undefined {
    return this.#active;
  }
  fileFail(): void {
    this.#fail();
  }
  fileChange(change: NonNullable<BetaBrowserState['state_changes']>[number]): void {
    if (this.fileLive()) this.#change(change);
  }
  fileTarget(data: Message): { tab: string; session: string; node: number } {
    const tab = data.tab_id ?? this.#active;
    const session = this.#sessions.get(tab),
      node = this.#refs.get(tab)?.get(data.target?.ref);
    if (!this.#tabs.has(tab) || !session || node === undefined)
      throw new BrowserDriverError(
        'Remote browser file operation was refused or could not complete.',
      );
    return { tab, session, node };
  }
  #ws: import('ws').default | undefined;
  #pending = new Map<
    number,
    { resolve: (value: Message) => void; reject: (error: Error) => void }
  >();
  #counter = 0;
  #grant: BrowserConnection | undefined;
  #context: string | undefined;
  #lease: BrowserSessionLease | undefined;
  #leaseDeadline = 0;
  #leaseTimer: ReturnType<typeof setTimeout> | undefined;
  #renewController: AbortController | undefined;
  #terminalError: string | undefined;
  #closed = false;
  #closing: Promise<void> | undefined;
  #failed = false;
  #tasks = new Set<Promise<void>>();
  #tabs = new Map<string, Message>();
  #sessions = new Map<string, string>();
  #ready = new Map<string, { promise: Promise<void>; resolve: () => void }>();
  #creating: { promise: Promise<void>; resolve: () => void } | undefined;
  #active: string | undefined;
  #buttons = new Map<string, number>();
  #refs = new Map<string, Map<string, number>>();
  #refCounter = 0;
  #console = new Map<string, string[]>();
  #network = new Map<string, string[]>();
  #changes: NonNullable<BetaBrowserState['state_changes']> = [];

  constructor(
    private create: () => Promise<BrowserConnection>,
    private revoke: (id: string) => Promise<void>,
    private policy: (tab: string | undefined, url: string) => Promise<void>,
    private renew?: (id: string, signal: AbortSignal) => Promise<BrowserSessionLease>,
    private sessionPolicy?: BrowserSessionPolicy,
  ) {}

  start(): Promise<void> {
    if (!this.fileLive())
      return Promise.reject(
        new BrowserDriverError(
          this.#terminalError ??
            'Browser connection ended. Create a new toolset for a fresh session.',
        ),
      );
    this.#starting ??= this.#start();
    return this.#starting;
  }
  async #start(): Promise<void> {
    if (this.#closed || this.#failed)
      throw new BrowserDriverError(
        this.#terminalError ??
          'Browser connection ended. Create a new toolset for a fresh session.',
      );
    if (this.#ws) return;
    try {
      const { default: WebSocket } = await import('ws');
      const requested = performance.now();
      this.#grant = await this.create();
      if (this.sessionPolicy) this.#acceptLease(this.#grant.lease, performance.now() - requested);
      if (this.#closed) {
        await this.revoke(this.#grant.id);
        this.#grant = undefined;
        throw new BrowserDriverError('Browser connection ended.');
      }
      const ws = new WebSocket(this.#grant.url, {
        headers: { Authorization: `Bearer ${this.#grant.token}` },
        followRedirects: false,
        handshakeTimeout: 15000,
        maxPayload: 8 * 1024 * 1024,
      });
      this.#ws = ws;
      ws.on('message', (raw) => {
        try {
          const message = JSON.parse(raw.toString()) as Message;
          if ('id' in message) {
            const pending = this.#pending.get(message.id);
            if (pending) {
              if (message.error)
                pending.reject(
                  new (message.error.code === -32602 &&
                  message.error.message === 'Invalid InterceptionId.'
                    ? RequestGone
                    : BrowserDriverError)('Chromium could not complete the browser action.'),
                );
              else pending.resolve(message.result ?? {});
            }
          } else {
            if (this.#tasks.size >= 256) {
              this.#fail();
              return;
            }
            const task = this.#event(message);
            this.#tasks.add(task);
            void task.finally(() => this.#tasks.delete(task));
          }
        } catch {
          this.#fail();
        }
      });
      ws.on('close', () => this.#fail());
      ws.on('error', () => this.#fail());
      await new Promise<void>((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', () =>
          reject(new BrowserDriverError('Browser connection could not be opened.')),
        );
        ws.once('close', () => reject(new BrowserDriverError('Browser connection ended.')));
      });
      this.#context = (
        await this.send('Target.createBrowserContext', {
          disposeOnDetach: true,
        })
      ).browserContextId;
      await this.send('Browser.setDownloadBehavior', {
        behavior: 'deny',
        browserContextId: this.#context,
      });
      if (this.files) await this.files.setup(this.#context!);
      await this.send('Target.setDiscoverTargets', { discover: true });
      await this.send('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
      });
      await this.#newTab();
      this.#scheduleLease();
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  #acceptLease(lease: BrowserSessionLease | undefined, elapsedMs: number): void {
    if (!lease)
      throw new BrowserDriverError(
        'The server did not provide the requested renewable browser session.',
      );
    const previous = this.#lease;
    if (
      previous &&
      (lease.id !== previous.id ||
        +lease.attachExpiresAt !== +previous.attachExpiresAt ||
        +lease.absoluteExpiresAt !== +previous.absoluteExpiresAt ||
        lease.leaseSeconds !== previous.leaseSeconds ||
        +lease.serverTime < +previous.serverTime ||
        +lease.leaseExpiresAt < +previous.leaseExpiresAt)
    )
      throw new BrowserDriverError('Browser renewal returned an inconsistent session lease.');
    const remaining = +lease.leaseExpiresAt - +lease.serverTime - elapsedMs;
    if (remaining <= 0)
      throw new BrowserDriverError('Browser session lease expired before its response arrived.');
    this.#lease = lease;
    this.#leaseDeadline = performance.now() + remaining;
  }

  sessionStatus(): {
    state: 'not_started' | 'active' | 'ended';
    leaseExpiresAt: Date | undefined;
    absoluteExpiresAt: Date | undefined;
    remainingSeconds: number;
    terminalError: string | undefined;
    fileCleanupFailed: boolean;
  } {
    return {
      state: this.#failed || this.#closed ? 'ended' : this.#ws ? 'active' : 'not_started',
      leaseExpiresAt: this.#lease?.leaseExpiresAt,
      absoluteExpiresAt: this.#lease?.absoluteExpiresAt,
      remainingSeconds:
        this.#lease && !this.#failed && !this.#closed
          ? Math.max(0, (this.#leaseDeadline - performance.now()) / 1000)
          : 0,
      terminalError: this.#terminalError,
      fileCleanupFailed: this.files?.cleanupFailed ?? false,
    };
  }

  #canRenew(): boolean {
    return !!(
      this.renew &&
      this.sessionPolicy?.autoRenew !== false &&
      this.#lease &&
      +this.#lease.leaseExpiresAt < +this.#lease.absoluteExpiresAt
    );
  }
  #scheduleLease(): void {
    clearTimeout(this.#leaseTimer);
    if (!this.#lease || this.#failed || this.#closed) return;
    const remaining = this.#leaseDeadline - performance.now();
    const delay = this.#canRenew() ? remaining - Math.min(60000, remaining / 3) : remaining;
    this.#leaseTimer = setTimeout(
      () => {
        void this.#maintainLease();
      },
      Math.max(0, delay),
    );
    this.#leaseTimer.unref?.();
  }
  async #maintainLease(): Promise<void> {
    if (this.#closed || this.#failed) return;
    const remaining = this.#leaseDeadline - performance.now();
    if (!this.#canRenew() || remaining <= 0) {
      this.#terminalError =
        'Browser session lease expired or its absolute limit was reached. Create a new toolset to continue.';
      this.#fail();
      return;
    }
    this.#renewController = new AbortController();
    try {
      const requested = performance.now();
      const signal = AbortSignal.any([
        this.#renewController.signal,
        AbortSignal.timeout(Math.max(1, Math.floor(Math.min(10000, remaining)))),
      ]);
      const lease = await this.renew!(this.#grant!.id, signal);
      if (this.#closed || this.#failed) return;
      this.#acceptLease(lease, performance.now() - requested);
      this.#scheduleLease();
    } catch {
      if (this.#closed || this.#failed) return;
      this.#terminalError =
        'Browser session renewal failed. The session ended; create a new toolset to continue.';
      this.#fail();
    } finally {
      this.#renewController = undefined;
    }
  }

  #fail(): void {
    this.#failed = true;
    void this.files?.close();
    clearTimeout(this.#leaseTimer);
    this.#renewController?.abort();
    for (const ready of this.#ready.values()) ready.resolve();
    for (const map of [
      this.#tabs,
      this.#sessions,
      this.#ready,
      this.#refs,
      this.#console,
      this.#network,
      this.#buttons,
    ])
      map.clear();
    this.#active = undefined;
    this.#changes = [];
    for (const pending of this.#pending.values())
      pending.reject(
        new BrowserDriverError(
          this.#terminalError ??
            'Browser connection ended. Create a new toolset for a fresh session.',
        ),
      );
    this.#ws?.terminate();
  }

  async send(method: string, params: Message = {}, sessionId?: string): Promise<Message> {
    if (!this.#ws || this.#failed)
      throw new BrowserDriverError(
        this.#terminalError ??
          'Browser connection ended. Create a new toolset for a fresh session.',
      );
    const id = ++this.#counter;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<Message>((resolve, reject) => {
        this.#pending.set(id, { resolve, reject });
        timer = setTimeout(() => {
          this.#fail();
          reject(new BrowserDriverError('Browser action timed out; its session was closed.'));
        }, 15000);
        this.#ws?.send(
          JSON.stringify({
            id,
            method,
            params,
            ...(sessionId ? { sessionId } : {}),
          }),
          (error) => {
            if (error) this.#fail();
          },
        );
      });
    } finally {
      clearTimeout(timer);
      this.#pending.delete(id);
    }
  }

  async #event(message: Message): Promise<void> {
    const { method, params: p = {}, sessionId: session } = message;
    let eventSession = session;
    try {
      if (method === 'Browser.downloadWillBegin' || method === 'Browser.downloadProgress') {
        await this.files?.event(method, p);
        return;
      }
      if (method === 'Target.attachedToTarget') {
        const info = p.targetInfo;
        const child: string = p.sessionId;
        if (
          info.browserContextId !== this.#context &&
          ![...this.#sessions.values()].includes(session)
        ) {
          await this.send('Runtime.runIfWaitingForDebugger', {}, child);
          await this.send('Target.detachFromTarget', { sessionId: child });
          return;
        }
        const target: string = info.targetId;
        if (!this.#ready.has(target) && this.#creating) await this.#creating.promise;
        if (info.type !== 'page' || !this.#ready.has(target)) {
          const result = await this.send('Target.closeTarget', {
            targetId: target,
          });
          if (!result.success)
            throw new BrowserDriverError('Unsupported browser target could not be closed.');
          return;
        }
        this.#sessions.set(target, child);
        this.#tabs.set(target, info);
        eventSession = child; // Initialization can race with this target's destruction.
        const initializers: [string, Message][] = [
          ['Page.enable', {}],
          ['Runtime.enable', {}],
          ['DOM.enable', {}],
          ['Accessibility.enable', {}],
          ['Network.enable', {}],
          ['Network.setBypassServiceWorker', { bypass: true }],
          [
            'Emulation.setDeviceMetricsOverride',
            { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false },
          ],
          ['Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }],
          [
            'Target.setAutoAttach',
            { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
          ],
        ];
        for (const [name, args] of initializers) await this.send(name, args, child);
        if (this.files) {
          const tree = await this.send('Page.getFrameTree', {}, child);
          this.files.frameTree(tree.frameTree, target);
        }
        await this.send('Runtime.runIfWaitingForDebugger', {}, child);
        this.#ready.get(target)?.resolve();
      } else if (method === 'Target.targetInfoChanged') {
        if (this.#tabs.has(p.targetInfo.targetId))
          this.#tabs.set(p.targetInfo.targetId, p.targetInfo);
      } else if (method === 'Target.targetDestroyed') {
        if (!this.#ready.has(p.targetId) && this.#creating) await this.#creating.promise;
        this.#dropTab(p.targetId);
      } else if (method === 'Fetch.requestPaused') {
        const tab = [...this.#sessions].find(([, s]) => s === session)?.[0];
        if (!tab) return; // Detached targets take their pending requests with them.
        let allowed = true;
        try {
          await this.#checkURL(p.request.url, tab);
        } catch {
          allowed = false;
        }
        if (this.#sessions.get(tab) !== session) return;
        if (!allowed) this.#change({ type: 'navigation_refused' });
        await this.send(
          allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest',
          {
            requestId: p.requestId,
            ...(allowed ? {} : { errorReason: 'BlockedByClient' }),
          },
          session,
        );
      } else if (method === 'Page.javascriptDialogOpening') {
        this.#change({
          type: 'dialog_dismissed',
          kind: p.type,
          message: String(p.message ?? '').slice(0, 1000),
        });
        await this.send('Page.handleJavaScriptDialog', { accept: false }, session);
      } else {
        const tab = [...this.#sessions].find(([, s]) => s === session)?.[0];
        if (!tab) return;
        if (method === 'Page.frameAttached') this.files?.frame(p.frameId, tab);
        if (method === 'Page.frameDetached') this.files?.frames.delete(p.frameId);
        if (method === 'Page.frameNavigated') {
          this.#refs.delete(tab);
          this.files?.frame(p.frame.id, tab);
        } else if (method === 'Runtime.consoleAPICalled')
          append(
            this.#console,
            tab,
            (p.args as Message[])
              .slice(0, 20)
              .map((a) => String(a.value ?? a.description ?? '').slice(0, 1000))
              .join(' '),
          );
        else if (method === 'Network.responseReceived')
          append(
            this.#network,
            tab,
            `${p.response.status} ${String(p.response.url).slice(0, 2000)}`,
          );
      }
    } catch (error) {
      if (method === 'Fetch.requestPaused' && error instanceof RequestGone) return;
      if (eventSession && ![...this.#sessions.values()].includes(eventSession)) return;
      this.#fail();
    }
  }
  #dropTab(target: string): void {
    if (this.files)
      for (const [frame, tab] of this.files.frames)
        if (tab === target) this.files.frames.delete(frame);
    this.#ready.get(target)?.resolve();
    for (const map of [
      this.#tabs,
      this.#sessions,
      this.#ready,
      this.#refs,
      this.#console,
      this.#network,
      this.#buttons,
    ])
      map.delete(target);
    if (this.#active === target) this.#active = this.#tabs.keys().next().value;
  }
  #change(change: NonNullable<BetaBrowserState['state_changes']>[number]): void {
    this.#changes.push(change);
    if (this.#changes.length > 100) this.#changes.shift();
  }

  async #checkURL(url: string, tab?: string): Promise<string> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new BrowserDriverError('Invalid URL.');
    }
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      !parsed.hostname ||
      parsed.username ||
      parsed.password
    )
      throw new BrowserDriverError(
        'Only HTTP and HTTPS URLs without embedded credentials are supported.',
      );
    if (url.length > 8192) throw new BrowserDriverError('URL exceeds 8192 characters.');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.policy(tab, url),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new BrowserDriverError('URL policy timed out.')), 5000);
        }),
      ]);
    } catch (error) {
      if (error instanceof ToolError) throw new BrowserDriverError(error.message);
      throw new BrowserDriverError('Navigation was refused by the URL policy or its deadline.');
    } finally {
      clearTimeout(timer);
    }
    return url;
  }

  async #newTab(): Promise<Message> {
    if (this.#tabs.size >= 10)
      throw new BrowserDriverError('At most ten browser tabs may be open.');
    const creating = deferred();
    this.#creating = creating;
    let target: string;
    const ready = deferred();
    try {
      target = (
        await this.send('Target.createTarget', {
          url: 'about:blank',
          browserContextId: this.#context,
        })
      ).targetId;
      if (this.#failed || this.#closed) throw new BrowserDriverError('Browser connection ended.');
      this.#ready.set(target, ready);
    } finally {
      creating.resolve();
      this.#creating = undefined;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        ready.promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            this.#fail();
            reject(new BrowserDriverError('Browser tab initialization timed out.'));
          }, 15000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    if (this.#failed || this.#closed) throw new BrowserDriverError('Browser connection ended.');
    if (!this.#tabs.has(target))
      throw new BrowserDriverError('Browser tab closed during initialization.');
    this.#active = target;
    return this.#tabState(target);
  }

  #tabState(target: string): {
    tab_id: string;
    url: string;
    title: string;
    active: boolean;
  } {
    const tab = this.#tabs.get(target) ?? {};
    return {
      tab_id: target,
      url: String(tab.url ?? '').slice(0, 4096),
      title: String(tab.title ?? '').slice(0, 1000),
      active: target === this.#active,
    };
  }
  state(): BetaBrowserState {
    if (!this.#active || !this.#tabs.has(this.#active))
      this.#active = this.#tabs.keys().next().value;
    const state = {
      tabs: [...this.#tabs.keys()].map((t) => this.#tabState(t)),
      state_changes: this.#changes,
    };
    this.#changes = [];
    return state;
  }
  async #evaluate(tab: string, expression: string): Promise<unknown> {
    const result = await this.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true, timeout: 5000 },
      this.#sessions.get(tab),
    );
    if (result.exceptionDetails)
      throw new BrowserDriverError(
        'JavaScript could not complete. Its exception text was withheld.',
      );
    return result.result?.value;
  }
  async #point(tab: string, target: Message): Promise<[number, number]> {
    if (target.type === 'coordinate')
      return [bounded(target.x, 'x', 1279, true), bounded(target.y, 'y', 719, true)];
    const node = this.#refs.get(tab)?.get(target.ref);
    if (!node)
      throw new BrowserDriverError('Unknown or stale element reference. Read the page again.');
    await this.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: node }, this.#sessions.get(tab));
    const result = await this.send(
      'DOM.getContentQuads',
      { backendNodeId: node },
      this.#sessions.get(tab),
    );
    const q = result.quads?.[0] as number[] | undefined;
    if (!q || q.length !== 8)
      throw new BrowserDriverError('Element is no longer visible. Read the page again.');
    return [
      bounded((q[0]! + q[2]! + q[4]! + q[6]!) / 4, 'element x', 1279),
      bounded((q[1]! + q[3]! + q[5]! + q[7]!) / 4, 'element y', 719),
    ];
  }

  async perform(name: string, data: Message): Promise<unknown> {
    validateInput(name, data);
    await this.start();
    if (name === 'new_tab') return this.#newTab();
    if (name === 'list_tabs') return [...this.#tabs.keys()].map((t) => this.#tabState(t));
    const tab: string | undefined = data.tab_id ?? this.#active;
    if (!tab || !this.#tabs.has(tab))
      throw new BrowserDriverError(
        'Tab is missing or closed. List the tabs and choose an open tab.',
      );
    const session = this.#sessions.get(tab);
    if (name === 'switch_tab') {
      await this.send('Target.activateTarget', { targetId: tab });
      this.#active = tab;
      return this.#tabState(tab);
    }
    if (name === 'close_tab') {
      await this.send('Target.closeTarget', { targetId: tab });
      this.#dropTab(tab);
      return;
    }
    if (name === 'navigate') {
      let url: string = data.url;
      if (url === 'back' || url === 'forward') {
        const history = await this.send('Page.getNavigationHistory', {}, session);
        const index = history.currentIndex + (url === 'back' ? -1 : 1);
        const entry = history.entries[index];
        if (!entry) throw new BrowserDriverError('No history entry in that direction.');
        await this.#checkURL(entry.url, tab);
        await this.send('Page.navigateToHistoryEntry', { entryId: entry.id }, session);
      } else if (url === 'reload') {
        await this.#checkURL(this.#tabs.get(tab)?.url ?? '', tab);
        await this.send('Page.reload', {}, session);
      } else {
        if (!url.split('/')[0]?.includes(':')) url = `https://${url}`;
        await this.#checkURL(url, tab);
        const result = await this.send('Page.navigate', { url }, session);
        if (result.errorText)
          throw new BrowserDriverError('Navigation failed or was refused by the URL policy.');
      }
      this.#refs.delete(tab);
      for (let n = 0; n < 100; n++) {
        try {
          if (
            ['interactive', 'complete'].includes(
              String(await this.#evaluate(tab, 'document.readyState')),
            )
          )
            break;
        } catch (error) {
          if (this.#failed || this.#closed || !(error instanceof BrowserDriverError)) throw error;
        }
        await delay(100);
      }
      return this.#evaluate(tab, '({url:location.href,title:document.title})');
    }
    if (name === 'screenshot' || name === 'zoom') {
      const args: Message = { format: 'png', captureBeyondViewport: false };
      if (name === 'zoom') {
        const r = data.region as number[];
        if (r.length !== 4) throw new BrowserDriverError('region must contain x1, y1, x2, y2');
        const x1 = bounded(r[0], 'x1', 1279, true),
          y1 = bounded(r[1], 'y1', 719, true),
          x2 = bounded(r[2], 'x2', 1280, true),
          y2 = bounded(r[3], 'y2', 720, true);
        if (x2 <= x1 || y2 <= y1)
          throw new BrowserDriverError('region must have positive width and height');
        const viewport = (await this.send('Page.getLayoutMetrics', {}, session)).cssVisualViewport;
        args.clip = {
          x: x1 + viewport.pageX,
          y: y1 + viewport.pageY,
          width: x2 - x1,
          height: y2 - y1,
          scale: 1,
        };
      }
      return {
        data: (await this.send('Page.captureScreenshot', args, session)).data,
        media_type: 'image/png',
      };
    }
    if (name === 'read_page' || name === 'find') {
      const nodes = (
        await this.send(
          'Accessibility.getFullAXTree',
          { depth: bounded(data.depth ?? 20, 'depth', 50, true) },
          session,
        )
      ).nodes as Message[];
      let selected: Set<string> | undefined;
      if (data.ref) {
        const backend = this.#refs.get(tab)?.get(data.ref);
        const found = nodes.find((n) => n.backendDOMNodeId === backend);
        if (!found)
          throw new BrowserDriverError('Unknown or stale element reference. Read the page again.');
        selected = new Set([found.nodeId]);
        for (const node of nodes)
          if (selected.has(node.nodeId)) for (const id of node.childIds ?? []) selected.add(id);
      }
      const refs = new Map<string, number>(),
        lines: string[] = [];
      const query = String(data.query ?? '').toLowerCase();
      if (query.length > 1000) throw new BrowserDriverError('query exceeds 1000 characters');
      const interactive = new Set([
        'button',
        'link',
        'textbox',
        'checkbox',
        'radio',
        'combobox',
        'slider',
        'spinbutton',
        'menuitem',
        'tab',
        'option',
        'switch',
      ]);
      for (const node of nodes) {
        const role = String(node.role?.value ?? ''),
          label = String(node.name?.value ?? '').slice(0, 1000),
          value = String(node.value?.value ?? '').slice(0, 1000);
        if (node.ignored || (selected && !selected.has(node.nodeId))) continue;
        if (data.filter === 'interactive' && !interactive.has(role)) continue;
        if (query && !`${role} ${label} ${value}`.toLowerCase().includes(query)) continue;
        let prefix = '';
        if (node.backendDOMNodeId) {
          const ref = `e${++this.#refCounter}`;
          refs.set(ref, node.backendDOMNodeId);
          prefix = `[${ref}] `;
        }
        lines.push(`${prefix}${role} ${label} ${value}`.trim());
        if (lines.length >= 500) break;
      }
      this.#refs.set(tab, refs);
      return lines.join('\n').slice(0, 24000) || 'No matching accessible elements.';
    }
    if (name === 'get_page_text')
      return this.#evaluate(tab, "(document.body?.innerText || '').slice(0,24000)");
    if (name === 'read_console' || name === 'read_network') {
      const source = name === 'read_console' ? this.#console : this.#network;
      const entries = source.get(tab);
      source.delete(tab);
      return entries?.join('\n').slice(-24000) || 'No entries recorded.';
    }
    if (name === 'javascript_exec') {
      if (data.text.length > 16000)
        throw new BrowserDriverError('JavaScript exceeds 16000 characters');
      return this.#evaluate(
        tab,
        `(async()=>{const r=await (0,eval)(${JSON.stringify(data.text)});return String(typeof r==='string'?r:JSON.stringify(r)).slice(0,24000)})()`,
      );
    }
    if (name === 'wait') {
      await delay(bounded(data.duration, 'duration', 30) * 1000);
      return;
    }
    if (name === 'type') {
      if (data.text.length > 16000) throw new BrowserDriverError('text exceeds 16000 characters');
      await this.send('Input.insertText', { text: data.text }, session);
      return;
    }
    if (name === 'form_input') {
      const node = this.#refs.get(tab)?.get(data.target.ref);
      if (!node)
        throw new BrowserDriverError('Unknown or stale element reference. Read the page again.');
      const objectId = (await this.send('DOM.resolveNode', { backendNodeId: node }, session)).object
        .objectId;
      try {
        const result = await this.send(
          'Runtime.callFunctionOn',
          {
            objectId,
            functionDeclaration: FORM_INPUT,
            arguments: [{ value: data.value }],
            returnByValue: true,
          },
          session,
        );
        if (result.exceptionDetails)
          throw new BrowserDriverError(
            'Reference is not a supported form field or its value is invalid.',
          );
      } finally {
        try {
          await this.send('Runtime.releaseObject', { objectId }, session);
        } catch {
          // Best-effort cleanup; preserve the action's original result/error.
          // Detach/navigation may have already released the object.
        }
      }
      return;
    }
    if (name === 'key' || name === 'hold_key') {
      const pieces = data.text.trim().split(/\s+/);
      if (pieces.length > (name === 'key' ? 100 : 1))
        throw new BrowserDriverError('Use up to 100 key chords, or one chord for hold_key.');
      const sequence = pieces.map(keyChord);
      const repeat = bounded(data.repeat ?? 1, 'repeat', 100, true),
        duration = bounded(data.duration ?? 0, 'duration', 10);
      if (repeat < 1) throw new BrowserDriverError('repeat must be at least one');
      for (let n = 0; n < repeat * sequence.length; n++) {
        const keys = sequence[n % sequence.length]!;
        const pressed: [string, number][] = [];
        let modifiers = 0;
        try {
          for (const [rawKey, code] of keys) {
            modifiers |= MODIFIERS[rawKey] ?? 0;
            const key =
              modifiers & 8 && rawKey.length === 1
                ? (SHIFTED_DIGITS[rawKey] ?? rawKey.toUpperCase())
                : rawKey;
            const character = key === 'Enter' ? '\r' : key.length === 1 ? key : '';
            await this.send(
              'Input.dispatchKeyEvent',
              {
                type: 'keyDown',
                key,
                windowsVirtualKeyCode: code,
                modifiers,
                ...(character && !(modifiers & 7) ? { text: character } : {}),
              },
              session,
            );
            pressed.push([key, code]);
          }
          if (duration) await delay(duration * 1000);
        } finally {
          for (const [key, code] of pressed.reverse()) {
            modifiers &= ~(MODIFIERS[key] ?? 0);
            await this.send(
              'Input.dispatchKeyEvent',
              { type: 'keyUp', key, windowsVirtualKeyCode: code, modifiers },
              session,
            );
          }
        }
      }
      return;
    }
    const [x, y] = await this.#point(tab, data.target);
    if (name === 'scroll_to') return;
    if (name === 'scroll') {
      const amount = bounded(data.scroll_amount ?? 3, 'scroll_amount', 50, true) * 100;
      const delta: Record<string, [number, number]> = {
        up: [0, -amount],
        down: [0, amount],
        left: [-amount, 0],
        right: [amount, 0],
      };
      const [deltaX, deltaY] = delta[data.scroll_direction]!;
      await this.send(
        'Input.dispatchMouseEvent',
        { type: 'mouseWheel', x, y, deltaX, deltaY },
        session,
      );
      return;
    }
    if (name === 'hover' || name === 'mouse_move') {
      await this.send(
        'Input.dispatchMouseEvent',
        {
          type: 'mouseMoved',
          x,
          y,
          buttons: this.#buttons.get(tab) ?? 0,
          button: this.#buttons.get(tab) ? 'left' : 'none',
        },
        session,
      );
      return;
    }
    if (name === 'left_click_drag') {
      const [fx, fy] = await this.#point(tab, data.from);
      await this.send(
        'Input.dispatchMouseEvent',
        { type: 'mousePressed', x: fx, y: fy, button: 'left', clickCount: 1 },
        session,
      );
      try {
        await this.send(
          'Input.dispatchMouseEvent',
          { type: 'mouseMoved', x, y, button: 'left', buttons: 1 },
          session,
        );
      } finally {
        await this.send(
          'Input.dispatchMouseEvent',
          { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 },
          session,
        );
      }
      return;
    }
    const button = name === 'right_click' ? 'right' : name === 'middle_click' ? 'middle' : 'left';
    const count = name === 'triple_click' ? 3 : name === 'double_click' ? 2 : 1;
    let modifiers = 0;
    if (data.modifiers)
      for (const [key] of keyChord(data.modifiers)) {
        if (!MODIFIERS[key])
          throw new BrowserDriverError('Click modifiers must be Alt, Control, Meta or Shift');
        modifiers |= MODIFIERS[key];
      }
    for (let clickCount = 1; clickCount <= count; clickCount++) {
      const args = { x, y, button, clickCount, modifiers };
      if (name !== 'left_mouse_up')
        await this.send('Input.dispatchMouseEvent', { ...args, type: 'mousePressed' }, session);
      if (name === 'left_mouse_down') this.#buttons.set(tab, 1);
      if (name !== 'left_mouse_down') {
        this.#buttons.delete(tab);
        await this.send('Input.dispatchMouseEvent', { ...args, type: 'mouseReleased' }, session);
      }
    }
  }

  async close(): Promise<void> {
    if (this.#closing) return this.#closing;
    if (this.#closed && !this.#grant && !this.files?.created) return;
    this.#closed = true;
    clearTimeout(this.#leaseTimer);
    this.#renewController?.abort();
    this.#closing = this.#cleanup().finally(() => {
      this.#closing = undefined;
    });
    return this.#closing;
  }

  async #cleanup(): Promise<void> {
    try {
      await this.files?.close();
      if (this.#ws) {
        if (this.#context && !this.#failed) {
          try {
            await this.send('Target.disposeBrowserContext', {
              browserContextId: this.#context,
            });
          } catch {
            /* Detach also disposes it. */
          }
        }
        this.#fail();
      }
      await Promise.allSettled(this.#tasks);
    } finally {
      this.#tabs.clear();
      if (this.#grant) {
        await this.revoke(this.#grant.id);
        this.#grant = undefined;
      }
    }
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const SHIFTED_DIGITS: Record<string, string> = Object.fromEntries(
  [...'1234567890'].map((key, i) => [key, '!@#$%^&*()'[i]!]),
);
const MODIFIERS: Record<string, number> = {
  Alt: 1,
  Control: 2,
  Meta: 4,
  Shift: 8,
};
const FORM_INPUT =
  "function(v){if(!this.isConnected)throw Error(); if(this instanceof HTMLInputElement && this.type==='file')throw Error(); if(this instanceof HTMLInputElement && ['checkbox','radio'].includes(this.type)){if(typeof v!=='boolean')throw Error(); if(this.checked!==v)this.click();}else if(this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement || this instanceof HTMLSelectElement){if(this instanceof HTMLSelectElement){const options=Array.from(this.options);const option=options.find(o=>o.value===String(v))||options.find(o=>o.label===String(v));if(!option||option.disabled||option.parentElement instanceof HTMLOptGroupElement&&option.parentElement.disabled)throw Error();v=option.value;}const p=this instanceof HTMLInputElement?HTMLInputElement.prototype:this instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLSelectElement.prototype; Object.getOwnPropertyDescriptor(p,'value').set.call(this,String(v));this.dispatchEvent(new Event('input',{bubbles:true}));this.dispatchEvent(new Event('change',{bubbles:true}));}else throw Error();}";
function keyChord(text: string): [string, number][] {
  const aliases: Record<string, string> = {
    ctrl: 'Control',
    control: 'Control',
    alt: 'Alt',
    shift: 'Shift',
    super: 'Meta',
    meta: 'Meta',
    cmd: 'Meta',
    return: 'Enter',
    enter: 'Enter',
    esc: 'Escape',
    escape: 'Escape',
    space: ' ',
    tab: 'Tab',
    backspace: 'Backspace',
    delete: 'Delete',
    up: 'ArrowUp',
    down: 'ArrowDown',
    left: 'ArrowLeft',
    right: 'ArrowRight',
    home: 'Home',
    end: 'End',
    pageup: 'PageUp',
    pagedown: 'PageDown',
  };
  const codes: Record<string, number> = {
    Control: 17,
    Alt: 18,
    Shift: 16,
    Meta: 91,
    Enter: 13,
    Escape: 27,
    ' ': 32,
    Tab: 9,
    Backspace: 8,
    Delete: 46,
    ArrowUp: 38,
    ArrowDown: 40,
    ArrowLeft: 37,
    ArrowRight: 39,
    Home: 36,
    End: 35,
    PageUp: 33,
    PageDown: 34,
  };
  const pieces = text.split('+');
  if (pieces.length > 5)
    throw new BrowserDriverError('Use one key or a chord of at most five keys, separated by +');
  return pieces.map((piece) => {
    const key = aliases[piece.toLowerCase()] ?? piece;
    const code =
      codes[key] ?? (/^[a-z0-9]$/i.test(key) ? key.toUpperCase().charCodeAt(0) : undefined);
    if (code === undefined)
      throw new BrowserDriverError('Unsupported browser key. Use a named key or a letter/digit.');
    return [key, code];
  });
}

// Anthropic's dispatcher casts tool input without validating its fields. Reject
// malformed model arguments as recoverable errors before allocating a session.
function validateInput(name: string, data: Message): void {
  const invalid = () => {
    throw new BrowserDriverError(
      'Invalid browser action input. Check the required fields and their types.',
    );
  };
  if (!data || typeof data !== 'object' || Array.isArray(data)) invalid();
  const string = (key: string, required = false, max = 16000) => {
    const value = data[key];
    if (value == null && !required) return;
    if (typeof value !== 'string' || value.length > max) invalid();
  };
  string('tab_id', name === 'close_tab' || name === 'switch_tab', 256);
  string('modifiers', false, 100);
  string('ref', false, 256);
  if (name === 'navigate') string('url', true, 8192);
  if (['type', 'key', 'hold_key', 'javascript_exec'].includes(name)) string('text', true);
  if (name === 'find') string('query', true, 1000);
  if (data.depth != null) bounded(data.depth, 'depth', 50, true);
  if (data.filter != null && !['all', 'interactive'].includes(data.filter)) invalid();
  if (name === 'wait' || name === 'hold_key')
    bounded(data.duration, 'duration', name === 'wait' ? 30 : 10);
  if (data.repeat != null && bounded(data.repeat, 'repeat', 100, true) < 1) invalid();
  if (name === 'zoom') {
    if (!Array.isArray(data.region) || data.region.length !== 4) invalid();
    for (const value of data.region) bounded(value, 'region', 1280, true);
  }
  const target = (value: unknown, coordinateOnly = false, refOnly = false) => {
    if (!value || typeof value !== 'object') return invalid();
    const t = value as Message;
    if (t.type === 'coordinate' && !refOnly) {
      bounded(t.x, 'x', 1279, true);
      bounded(t.y, 'y', 719, true);
    } else if (
      t.type === 'ref' &&
      !coordinateOnly &&
      typeof t.ref === 'string' &&
      t.ref.length <= 256
    ) {
      /* valid */
    } else invalid();
  };
  const coordinate = [
    'scroll',
    'mouse_move',
    'left_mouse_down',
    'left_mouse_up',
    'left_click_drag',
  ];
  if (
    [
      ...coordinate,
      'scroll_to',
      'hover',
      'form_input',
      'left_click',
      'right_click',
      'middle_click',
      'double_click',
      'triple_click',
    ].includes(name)
  )
    target(data.target, coordinate.includes(name), ['scroll_to', 'form_input'].includes(name));
  if (name === 'left_click_drag') target(data.from, true);
  if (name === 'scroll') {
    if (!['up', 'down', 'left', 'right'].includes(data.scroll_direction)) invalid();
    if (data.scroll_amount != null) bounded(data.scroll_amount, 'scroll_amount', 50, true);
  }
  if (name === 'form_input') {
    if (!['string', 'number', 'boolean'].includes(typeof data.value)) invalid();
    if (typeof data.value === 'string' && data.value.length > 16000) invalid();
    if (typeof data.value === 'number' && !Number.isFinite(data.value)) invalid();
  }
}
