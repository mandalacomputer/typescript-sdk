/** A random-access source; implementations must keep its contents unchanged. */
export interface UploadSource {
  size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}
export interface FileUpload {
  path: string;
  upload_id: string;
  offset: number;
  size: number;
  complete: boolean;
}
/** Retain uploadId and the unchanged source; uploadFile can resume from server status. */
export class UploadInterruptedError extends Error {
  override name = 'UploadInterruptedError';
  constructor(
    readonly uploadId: string,
    cause: unknown,
  ) {
    super(
      `Upload ${uploadId} interrupted. Retain the unchanged source and resume with this upload ID, or cancelFileUpload to remove staging. ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}
export function parseFileUpload(value: unknown, path: string, id: string): FileUpload {
  const p = value as Partial<FileUpload> | null;
  if (
    !p ||
    p.path !== path ||
    p.upload_id !== id ||
    !Number.isSafeInteger(p.offset) ||
    !Number.isSafeInteger(p.size) ||
    p.size! < 0 ||
    p.size! > 2147483648 ||
    p.offset! < 0 ||
    p.offset! > p.size! ||
    typeof p.complete !== 'boolean' ||
    (p.complete && p.offset !== p.size)
  )
    throw new Error('Server returned invalid upload progress; read upload status before retrying.');
  return p as FileUpload;
}
