/** Explicit file staging. Model strings never cause local or guest reads. */
import { createHash, randomUUID } from 'node:crypto';
import {
  type BetaFilePolicy,
  type BetaURLContext,
  ToolError,
} from '@anthropic-ai/sdk/helpers/beta/toolsets';
import type { Computer } from './computer.js';

export const FILE_ERROR = 'Remote browser file operation was refused or could not complete.';
export const MIME_EXTENSIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'text/plain': ['.txt'],
  'text/csv': ['.csv'],
  'application/json': ['.json'],
  'application/pdf': ['.pdf'],
  'image/png': ['.png'],
  'image/jpeg': ['.jpg', '.jpeg'],
});
export function canonicalPath(value: string): string {
  if (
    typeof value !== 'string' ||
    !value.startsWith('/') ||
    value.length > 4096 ||
    value.includes('\\') ||
    [...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
    value
      .slice(1)
      .split('/')
      .some((p) => ['', '.', '..'].includes(p))
  )
    throw new Error(FILE_ERROR);
  return value;
}
export function safeFilename(value: string): string {
  if (typeof value !== 'string' || value.length > 4096) throw new Error(FILE_ERROR);
  const name = value
    .replaceAll('\\', '/')
    .split('/')
    .at(-1)!
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 120);
  if (!name) throw new Error(FILE_ERROR);
  return name;
}
export function digest(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}
export function contentType(name: string, data: Uint8Array, allowed: readonly string[]): string {
  const ext = name.includes('.') ? `.${name.split('.').at(-1)!.toLowerCase()}` : '';
  const mime = allowed.find((m) => MIME_EXTENSIONS[m]?.includes(ext));
  if (!mime) throw new Error(FILE_ERROR);
  const b = Buffer.from(data);
  let valid = true;
  if (mime === 'application/pdf') valid = b.subarray(0, 5).equals(Buffer.from('%PDF-'));
  else if (mime === 'image/png')
    valid = b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  else if (mime === 'image/jpeg') valid = b.subarray(0, 3).equals(Buffer.from([255, 216, 255]));
  else {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
    valid = !text.includes('\0');
    if (mime === 'application/json') JSON.parse(text);
  }
  if (!valid) throw new Error(FILE_ERROR);
  return mime;
}
export type BrowserStagedFile = Readonly<{
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  source: string;
  computerId: string;
  taskId: string;
  browserContextId: string;
}>;
export type BrowserDownload = Readonly<Omit<BrowserStagedFile, 'source'> & { url: string }>;
export interface BrowserFilePolicyOptions {
  taskId: string;
  guestUploadRoots?: readonly string[];
  allowedMimeTypes?: readonly string[];
  maxFileBytes?: number;
  maxTotalBytes?: number;
  maxFiles?: number;
  downloads?: boolean;
  approveDownload?: (file: BrowserDownload) => boolean | Promise<boolean>;
}
/** Immutable rules bound to one Computer and one toolset. Downloads require Linux root tmpfs support. */
export class BrowserFilePolicy {
  readonly taskId: string;
  readonly guestUploadRoots: readonly string[];
  readonly allowedMimeTypes: readonly string[];
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly maxFiles: number;
  readonly downloads: boolean;
  readonly approveDownload?: BrowserFilePolicyOptions['approveDownload'];
  readonly #computer: Computer;
  readonly #computerId: string;
  #bound = false;
  constructor(computer: Computer, options: BrowserFilePolicyOptions) {
    this.taskId = options.taskId;
    this.guestUploadRoots = Object.freeze([...(options.guestUploadRoots ?? [])]);
    this.allowedMimeTypes = Object.freeze([...(options.allowedMimeTypes ?? ['text/plain'])]);
    this.maxFileBytes = options.maxFileBytes ?? 1024 * 1024;
    this.maxTotalBytes = options.maxTotalBytes ?? 4 * 1024 * 1024;
    this.maxFiles = options.maxFiles ?? 8;
    this.downloads = options.downloads ?? false;
    this.approveDownload = options.approveDownload;
    this.#computer = computer;
    this.#computerId = computer.id;
    if (typeof this.taskId !== 'string' || this.taskId.length < 1 || this.taskId.length > 128)
      throw new Error('taskId must have 1 to 128 characters');
    for (const [value, lo, hi] of [
      [this.maxFileBytes, 1, 1024 * 1024],
      [this.maxTotalBytes, this.maxFileBytes, 4 * 1024 * 1024],
      [this.maxFiles, 1, 8],
    ] as const)
      if (!Number.isInteger(value) || value < lo || value > hi)
        throw new Error('Invalid browser file limit');
    if (
      typeof this.downloads !== 'boolean' ||
      (this.downloads && typeof this.approveDownload !== 'function')
    )
      throw new Error('downloads requires approveDownload');
    if (
      !Array.isArray(options.allowedMimeTypes ?? []) ||
      !this.allowedMimeTypes.length ||
      new Set(this.allowedMimeTypes).size !== this.allowedMimeTypes.length ||
      this.allowedMimeTypes.some((m) => !Object.hasOwn(MIME_EXTENSIONS, m))
    )
      throw new Error('Unsupported or duplicate MIME type');
    if (!Array.isArray(options.guestUploadRoots ?? []) || this.guestUploadRoots.length > 16)
      throw new Error('Use at most 16 canonical guest roots');
    this.guestUploadRoots.forEach(canonicalPath);
    Object.freeze(this);
  }
  /** @internal */ bind(computer: Computer): void {
    this.check(computer);
    if (this.#bound) throw new Error('A browser file policy belongs to one toolset');
    this.#bound = true;
  }
  /** @internal */ check(computer: Computer): void {
    if (computer !== this.#computer || computer.id !== this.#computerId)
      throw new Error('A browser file policy belongs to one computer');
  }
  /** @internal */ get computerId(): string {
    return this.#computerId;
  }
}
export class StagedFiles implements BetaFilePolicy {
  context = '';
  closed = false;
  readonly files = new Map<string, { file: BrowserStagedFile; data: Buffer }>();
  readonly visible = new Set<string>();
  constructor(readonly policy: BrowserFilePolicy) {}
  add(filename: string, data: Uint8Array, source: string): BrowserStagedFile {
    if (
      this.closed ||
      !this.context ||
      this.files.size >= this.policy.maxFiles ||
      data.byteLength > this.policy.maxFileBytes ||
      [...this.files.values()].reduce((n, f) => n + f.data.length, 0) + data.byteLength >
        this.policy.maxTotalBytes
    )
      throw new ToolError(FILE_ERROR);
    const snapshot = Buffer.from(data),
      name = safeFilename(filename),
      mime = contentType(name, snapshot, this.policy.allowedMimeTypes),
      sha = digest(snapshot);
    const file = Object.freeze({
      id: `mandala-file:${randomUUID().replaceAll('-', '')}:${name}:${data.byteLength}:${sha}`,
      filename: name,
      mimeType: mime,
      sizeBytes: data.byteLength,
      sha256: sha,
      source,
      computerId: this.policy.computerId,
      taskId: this.policy.taskId,
      browserContextId: this.context,
    });
    this.files.set(file.id, { file, data: snapshot });
    return file;
  }
  selected(ids: string[]): { file: BrowserStagedFile; data: Buffer }[] {
    if (
      this.closed ||
      !Array.isArray(ids) ||
      !ids.length ||
      ids.length > this.policy.maxFiles ||
      new Set(ids).size !== ids.length ||
      ids.some((i) => typeof i !== 'string' || !this.files.has(i))
    )
      throw new ToolError(FILE_ERROR);
    return ids.map((i) => this.files.get(i)!);
  }
  resolveUploadPaths(): never {
    throw new ToolError(
      'Stage guest or local files explicitly and use their document_ids handles.',
    );
  }
  resolveUploadDocuments(ctx: BetaURLContext, ids: string[]): string[] {
    if (!ctx.toolUseId) throw new ToolError(FILE_ERROR);
    this.selected(ids);
    return [...ids];
  }
  isPathVisible(path: string): boolean {
    return !this.closed && this.visible.has(path);
  }
  clear(): void {
    this.closed = true;
    this.files.clear();
    this.visible.clear();
  }
}
