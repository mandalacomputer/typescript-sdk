/** Private owner of a context's file lifecycle. */
import { randomUUID } from 'node:crypto';
import {
  type BetaConfirmContext,
  type BetaToolsetCallContext,
  ToolError,
} from '@anthropic-ai/sdk/helpers/beta/toolsets';
import type { BetaBrowserFileUploadInput } from '@anthropic-ai/sdk/resources/beta';
import type { BrowserCDP } from './browser-cdp.js';
import {
  type BrowserDownload,
  type BrowserFilePolicy,
  type BrowserStagedFile,
  canonicalPath,
  contentType,
  digest,
  FILE_ERROR,
  MIME_EXTENSIONS,
  StagedFiles,
  safeFilename,
} from './browser-files.js';
import { GUEST_HELPER } from './browser-guest.js';
import type { Computer } from './computer.js';

type Message = Record<string, any>;
const GUID = /^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/;
const INPUT_CHECK =
  "function(){if(!(this instanceof HTMLInputElement)||this.type!=='file'||!this.isConnected||this.ownerDocument!==document||this.disabled)throw Error();return {url:document.URL,multiple:this.multiple}}";
const UPLOAD =
  "function(files,url){if(!(this instanceof HTMLInputElement)||this.type!=='file'||!this.isConnected||this.ownerDocument!==document||document.URL!==url||this.disabled||(!this.multiple&&files.length>1))throw Error();const dt=new DataTransfer();for(const f of files){const s=atob(f.data),b=new Uint8Array(s.length);for(let i=0;i<s.length;i++)b[i]=s.charCodeAt(i);dt.items.add(new File([b],f.name,{type:f.type}))}Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'files').set.call(this,dt.files);this.dispatchEvent(new Event('input',{bubbles:true}));this.dispatchEvent(new Event('change',{bubbles:true}));}";
function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
async function bounded<T>(operation: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(FILE_ERROR)), ms);
        abort = () => reject(new Error(FILE_ERROR));
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener('abort', abort);
  }
}
export class BrowserFiles {
  readonly adapter: StagedFiles;
  readonly scope = randomUUID().replaceAll('-', '');
  readonly root = `/run/mandala-browser-files/${this.scope}`;
  context = '';
  closed = false;
  created = false;
  cleanupFailed = false;
  #heartbeat?: ReturnType<typeof setTimeout>;
  #cleanup?: Promise<void>;
  #acquisition?: Promise<Message>;
  readonly #stop = new AbortController();
  readonly frames = new Map<string, string>();
  readonly downloads = new Map<string, Message>();
  #prepared?: Message;
  constructor(
    readonly computer: Computer,
    readonly policy: BrowserFilePolicy,
    readonly backend: BrowserCDP,
  ) {
    policy.bind(computer);
    this.adapter = new StagedFiles(policy);
  }
  live(): boolean {
    return !this.closed && this.backend.fileLive();
  }
  frame(id: string, tab: string): boolean {
    if (!this.frames.has(id) && this.frames.size >= 256) return false;
    this.frames.set(id, tab);
    return true;
  }
  frameTree(tree: Message, tab: string): void {
    if (!this.frame(tree.frame.id, tab)) return;
    for (const child of tree.childFrames ?? []) this.frameTree(child, tab);
  }
  async execute(command: string, desktop = false): Promise<Buffer> {
    this.policy.check(this.computer);
    if (Buffer.byteLength(command) > 120000) throw new Error(FILE_ERROR);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const result = await this.computer.exec(command, {
        desktop,
        timeoutS: 10,
        signal: controller.signal,
      });
      if (
        result.exitCode !== 0 ||
        result.timedOut ||
        result.truncated ||
        !(result.stdout instanceof Uint8Array) ||
        result.stdout.byteLength > 2 * 1024 * 1024
      )
        throw new Error(FILE_ERROR);
      return Buffer.from(result.stdout);
    } finally {
      clearTimeout(timer);
    }
  }
  async remote(op: string, values: Message = {}): Promise<Message> {
    const request = {
      version: 1,
      op,
      scope: this.scope,
      context: this.context,
      task: this.policy.taskId,
      maximum: this.policy.maxFileBytes,
      ...values,
    };
    const code = `import base64;exec(base64.b64decode('${Buffer.from(GUEST_HELPER).toString('base64')}'))`;
    const result = JSON.parse(
      (
        await this.execute(
          `python3 -c ${quote(code)} ${quote(Buffer.from(JSON.stringify(request)).toString('base64'))}`,
        )
      ).toString('utf8'),
    );
    if (!result || typeof result !== 'object' || Array.isArray(result) || 'error' in result)
      throw new Error(FILE_ERROR);
    return result;
  }
  decode(value: Message): Buffer {
    if (
      typeof value.data !== 'string' ||
      value.data.length > 4 * Math.ceil(this.policy.maxFileBytes / 3) ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.data)
    )
      throw new Error(FILE_ERROR);
    const data = Buffer.from(value.data, 'base64');
    if (
      value.data !== data.toString('base64') ||
      data.length !== value.size ||
      data.length > this.policy.maxFileBytes ||
      digest(data) !== value.sha256
    )
      throw new Error(FILE_ERROR);
    return data;
  }
  async setup(context: string): Promise<void> {
    this.context = context;
    this.adapter.context = context;
    if (!this.policy.downloads) return;
    const ids = JSON.parse(
      (
        await this.execute(
          "python3 -c 'import os,json;print(json.dumps([os.getuid(),os.getgid()]))'",
          true,
        )
      ).toString(),
    );
    if (!Array.isArray(ids) || ids.length !== 2 || ids.some((i) => !Number.isInteger(i) || i <= 0))
      throw new Error(FILE_ERROR);
    if (!this.live()) throw new Error(FILE_ERROR);
    this.created = true;
    this.#acquisition = this.remote('create', {
      uid: ids[0],
      gid: ids[1],
      total: this.policy.maxTotalBytes,
    });
    const result = await this.#acquisition;
    if (!this.live() || result.path !== `${this.root}/incoming`) throw new Error(FILE_ERROR);
    await this.backend.send('Browser.setDownloadBehavior', {
      behavior: 'allowAndName',
      browserContextId: context,
      downloadPath: result.path,
      eventsEnabled: true,
    });
    this.maintain();
  }
  maintain(): void {
    this.#heartbeat = setTimeout(async () => {
      if (!this.live()) return;
      try {
        await this.remote('heartbeat');
        if (this.live()) this.maintain();
      } catch {
        this.backend.fileFail();
      }
    }, 60000);
    this.#heartbeat.unref();
  }
  async stage(data: Uint8Array, filename: string, source: string): Promise<BrowserStagedFile> {
    try {
      if (!(data instanceof Uint8Array) || data.byteLength > this.policy.maxFileBytes)
        throw new Error(FILE_ERROR);
      const snapshot = Buffer.from(data);
      contentType(safeFilename(filename), snapshot, this.policy.allowedMimeTypes);
      await this.backend.start();
      if (!this.live()) throw new Error(FILE_ERROR);
      return this.adapter.add(filename, snapshot, source);
    } catch {
      throw new ToolError(FILE_ERROR);
    }
  }
  async stageGuest(path: string): Promise<BrowserStagedFile> {
    try {
      canonicalPath(path);
      if (!this.policy.guestUploadRoots.some((r) => path.startsWith(`${r}/`)))
        throw new Error(FILE_ERROR);
      await this.backend.start();
      const data = this.decode(
        await this.remote('read', { path, roots: this.policy.guestUploadRoots }),
      );
      return await this.stage(data, path.split('/').at(-1)!, 'guest');
    } catch {
      throw new ToolError(FILE_ERROR);
    }
  }
  async stageDocument(id: string, data: Uint8Array, filename: string): Promise<BrowserStagedFile> {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(id))
      throw new ToolError(FILE_ERROR);
    return this.stage(data, filename, `document:${id}`);
  }
  async releasePrepared(): Promise<void> {
    const p = this.#prepared;
    this.#prepared = undefined;
    if (p && this.live()) {
      try {
        await this.backend.send('Runtime.releaseObject', { objectId: p.object }, p.session);
      } catch {}
    }
  }
  async prepare(context: BetaConfirmContext): Promise<BetaConfirmContext> {
    await this.releasePrepared();
    try {
      const data = context.input as BetaBrowserFileUploadInput;
      if (!context.toolUse?.id || data.paths?.length) throw new Error(FILE_ERROR);
      const selected = this.adapter.selected(data.document_ids ?? []);
      await this.backend.start();
      const { tab, session, node } = this.backend.fileTarget(data);
      const tree = await this.backend.send('Page.getFrameTree', {}, session);
      const world = await this.backend.send(
        'Page.createIsolatedWorld',
        { frameId: tree.frameTree.frame.id, worldName: 'mandala-approved-files' },
        session,
      );
      const resolved = await this.backend.send(
        'DOM.resolveNode',
        { backendNodeId: node, executionContextId: world.executionContextId },
        session,
      );
      const object = resolved.object.objectId;
      const p = {
        call: context.toolUse.id,
        ids: selected.map((s) => s.file.id),
        selected,
        tab,
        session,
        object,
        approved: false,
        context: this.context,
        target: JSON.stringify(data.target),
        url: '',
      };
      this.#prepared = p;
      const result = await this.backend.send(
        'Runtime.callFunctionOn',
        { objectId: object, functionDeclaration: INPUT_CHECK, returnByValue: true },
        session,
      );
      if (
        result.exceptionDetails ||
        !this.live() ||
        (selected.length > 1 && !result.result.value.multiple)
      )
        throw new Error(FILE_ERROR);
      p.url = result.result.value.url;
      return { ...context, tabId: tab, tabURL: p.url };
    } catch {
      await this.releasePrepared();
      throw new ToolError(FILE_ERROR);
    }
  }
  async approved(allowed: boolean): Promise<void> {
    if (allowed === true && this.#prepared && this.live()) this.#prepared.approved = true;
    else await this.releasePrepared();
  }
  async upload(context: BetaToolsetCallContext, data: BetaBrowserFileUploadInput): Promise<void> {
    const p = this.#prepared;
    this.#prepared = undefined;
    try {
      if (
        !p ||
        !p.approved ||
        !this.live() ||
        p.context !== this.context ||
        context.toolUse?.id !== p.call ||
        data.paths?.length ||
        JSON.stringify(data.document_ids) !== JSON.stringify(p.ids) ||
        JSON.stringify(data.target) !== p.target ||
        (data.tab_id ?? this.backend.fileActive()) !== p.tab
      )
        throw new Error(FILE_ERROR);
      const result = await this.backend.send(
        'Runtime.callFunctionOn',
        {
          objectId: p.object,
          functionDeclaration: UPLOAD,
          arguments: [
            {
              value: p.selected.map((s: { file: BrowserStagedFile; data: Buffer }) => ({
                name: s.file.filename,
                type: s.file.mimeType,
                data: s.data.toString('base64'),
              })),
            },
            { value: p.url },
          ],
          returnByValue: true,
        },
        p.session,
      );
      if (result.exceptionDetails) throw new Error(FILE_ERROR);
    } catch {
      throw new ToolError(FILE_ERROR);
    } finally {
      if (p) {
        for (const id of p.ids) this.adapter.files.delete(id);
        if (this.live()) {
          try {
            await this.backend.send('Runtime.releaseObject', { objectId: p.object }, p.session);
          } catch {}
        }
      }
    }
  }
  async failDownload(guid: string): Promise<void> {
    const entry = this.downloads.get(guid)!;
    entry.state = 'failed';
    this.backend.fileChange({
      type: 'download_failed',
      download_id: guid,
      url: entry.url,
      error: FILE_ERROR,
    });
    if (this.live()) {
      try {
        await this.backend.send('Browser.cancelDownload', { guid, browserContextId: this.context });
      } catch {}
    }
    try {
      await this.remote('discard', { guid });
    } catch {
      /* The fixed quota and guardian contain this context. */
    }
  }
  async cancelUntracked(guid: string): Promise<void> {
    try {
      // Chromium scopes GUID lookup to this context, including foreign events.
      await this.backend.send('Browser.cancelDownload', { guid, browserContextId: this.context });
    } catch {
      return;
    }
    try {
      await this.remote('discard', { guid });
    } catch {
      /* Quota and guardian bound leftovers. */
    }
  }
  async event(method: string, p: Message): Promise<void> {
    if (!this.policy.downloads || !this.live() || typeof p.guid !== 'string' || !GUID.test(p.guid))
      return;
    const guid = p.guid;
    if (method === 'Browser.downloadWillBegin') {
      if (this.downloads.has(guid)) return;
      if (!this.frames.has(p.frameId)) {
        await this.cancelUntracked(guid);
        return;
      }
      if (this.downloads.size >= this.policy.maxFiles) {
        await this.cancelUntracked(guid);
        return;
      }
      const entry: Message = { url: String(p.url ?? '').slice(0, 4096), state: 'receiving' };
      this.downloads.set(guid, entry);
      try {
        entry.name = safeFilename(p.suggestedFilename);
        const extension = `.${entry.name.split('.').at(-1).toLowerCase()}`;
        if (!this.policy.allowedMimeTypes.some((m) => MIME_EXTENSIONS[m]!.includes(extension)))
          throw new Error(FILE_ERROR);
        this.backend.fileChange({ type: 'download_started', download_id: guid, url: entry.url });
      } catch {
        await this.failDownload(guid);
      }
    } else if (method === 'Browser.downloadProgress') {
      const entry = this.downloads.get(guid);
      if (!entry || entry.state !== 'receiving') return;
      if (
        [p.receivedBytes, p.totalBytes].some(
          (n) =>
            typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > this.policy.maxFileBytes,
        ) ||
        p.state === 'canceled'
      ) {
        await this.failDownload(guid);
        return;
      }
      if (p.state !== 'completed') return;
      entry.state = 'checking';
      try {
        const data = this.decode(await this.remote('seal', { guid }));
        const mime = contentType(entry.name, data, this.policy.allowedMimeTypes),
          sha = digest(data);
        const info: BrowserDownload = Object.freeze({
          id: guid,
          filename: entry.name,
          mimeType: mime,
          sizeBytes: data.length,
          sha256: sha,
          computerId: this.policy.computerId,
          taskId: this.policy.taskId,
          browserContextId: this.context,
          url: entry.url,
        });
        const allowed = await bounded(
          Promise.resolve().then(() => this.policy.approveDownload!(info)),
          30000,
          this.#stop.signal,
        );
        if (allowed !== true || !this.live()) throw new Error(FILE_ERROR);
        const published = await this.remote('publish', { guid, name: entry.name, sha256: sha });
        const path = `${this.root}/approved/${guid}-${entry.name}`;
        if (published.path !== path || !this.live()) throw new Error(FILE_ERROR);
        this.adapter.visible.add(path);
        entry.state = 'complete';
        this.backend.fileChange({
          type: 'download_completed',
          download_id: guid,
          url: entry.url,
          size_bytes: data.length,
          path,
        });
      } catch {
        await this.failDownload(guid);
      }
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    this.adapter.clear();
    this.#prepared = undefined;
    this.#stop.abort();
    clearTimeout(this.#heartbeat);
    if (this.created) {
      this.#cleanup ??= (async () => {
        // Closing cannot overtake acquisition and miss a late mount.
        let confirmed = this.#acquisition === undefined;
        try {
          const acquired = await this.#acquisition;
          confirmed = acquired?.path === `${this.root}/incoming` || this.#acquisition === undefined;
        } catch {
          /* Uncertain create still needs cleanup. */
        }
        try {
          const result = await bounded(this.remote('close'), 10000);
          // Exec timeout doesn't establish that a guest command has stopped.
          if (!confirmed && result.removed !== true) throw new Error(FILE_ERROR);
          this.created = false;
          this.cleanupFailed = false;
        } catch {
          this.cleanupFailed = true;
        }
      })();
      await this.#cleanup;
      if (this.cleanupFailed) this.#cleanup = undefined;
    }
  }
}
