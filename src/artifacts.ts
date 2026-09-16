/** Caller-nominated, immutable files. Association is selection, not provenance. */
import { MandalaError, ValidationError } from './errors.js';
import { checkPathText, isArtifactId, isExecutionId, isRecord } from './paths.js';
import type { CallOptions } from './resources.js';
import {
  digest,
  integer,
  optionRecord,
  RETENTION_MAX_S,
  retainedTime,
  scopeId,
} from './results.js';
export const ARTIFACT_MANIFEST_BYTES = 4096;
export const ARTIFACT_DEFAULT_BYTES = 8 * 1024 * 1024;
export const ARTIFACT_MAX_BYTES = 64 * 1024 * 1024;
export type ArtifactAssociation = {
  kind: 'caller_selected';
  executionId: string;
  verifiedAt: string;
};
export type Artifact = {
  artifactId: string;
  kind: 'artifact';
  state: 'ready';
  computerId: string;
  workspaceId: string | null;
  createdAt: string;
  expiresAt: string;
  size: number;
  sha256: string;
  executionAssociation: ArtifactAssociation | null;
};
export type PublishArtifactOptions = {
  expectedSize: number;
  expectedSha256: string;
  executionId?: string;
  maxBytes?: number;
  retentionSeconds?: number;
} & CallOptions;
export type DownloadArtifactOptions = { maxBytes?: number } & CallOptions;
export function artifactBody(path: string, value: unknown) {
  const v = optionRecord(value, [
    'expectedSize',
    'expectedSha256',
    'executionId',
    'maxBytes',
    'retentionSeconds',
    'signal',
  ]);
  checkPathText(path, 'artifact path', 4096);
  if (!path || !(path.startsWith('/') || path.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(path)))
    throw new ValidationError('artifact path must be absolute');
  if (
    !integer(v.expectedSize, 0, ARTIFACT_MAX_BYTES) ||
    !digest(v.expectedSha256) ||
    (v.executionId !== undefined && !isExecutionId(v.executionId)) ||
    (v.maxBytes !== undefined && !integer(v.maxBytes, 1, ARTIFACT_MAX_BYTES)) ||
    (v.retentionSeconds !== undefined && !integer(v.retentionSeconds, 1, RETENTION_MAX_S))
  )
    throw new ValidationError('invalid artifact nomination');
  if (v.expectedSize > ((v.maxBytes as number | undefined) ?? ARTIFACT_DEFAULT_BYTES))
    throw new ValidationError('expectedSize exceeds the artifact capture limit');
  return {
    path,
    expected_size: v.expectedSize,
    expected_sha256: v.expectedSha256,
    ...(v.executionId === undefined ? {} : { execution_id: v.executionId as string }),
    ...(v.maxBytes === undefined ? {} : { max_bytes: v.maxBytes as number }),
    ...(v.retentionSeconds === undefined
      ? {}
      : { retention_seconds: v.retentionSeconds as number }),
  };
}
export function artifactDownloadCap(value: unknown): number {
  const v = optionRecord(value, ['maxBytes', 'signal']);
  const cap = v.maxBytes === undefined ? ARTIFACT_DEFAULT_BYTES : v.maxBytes;
  if (!integer(cap, 1, ARTIFACT_MAX_BYTES))
    throw new ValidationError('maxBytes must be an integer from 1 through 67108864');
  return cap;
}
const invalid = (): never => {
  throw new MandalaError('invalid artifact response; any requested publication is unconfirmed');
};
export function toArtifact(
  value: unknown,
  computerId: string,
  artifactId?: string,
  nomination?: ReturnType<typeof artifactBody>,
): Artifact {
  if (!isRecord(value)) return invalid();
  const v = value;
  if (
    !isArtifactId(v.artifact_id) ||
    (artifactId !== undefined && v.artifact_id !== artifactId) ||
    v.kind !== 'artifact' ||
    v.state !== 'ready' ||
    !scopeId(v.computer_id) ||
    v.computer_id !== computerId ||
    !(v.workspace_id === null || scopeId(v.workspace_id)) ||
    !retainedTime(v.created_at) ||
    !retainedTime(v.expires_at) ||
    Date.parse(v.expires_at) <= Date.parse(v.created_at) ||
    Date.parse(v.expires_at) - Date.parse(v.created_at) > RETENTION_MAX_S * 1000 ||
    !integer(v.size, 0, ARTIFACT_MAX_BYTES) ||
    !digest(v.sha256)
  )
    return invalid();
  let association: ArtifactAssociation | null = null;
  if (v.execution_association !== null) {
    const a = v.execution_association;
    if (
      !isRecord(a) ||
      a.kind !== 'caller_selected' ||
      !isExecutionId(a.execution_id) ||
      !retainedTime(a.verified_at) ||
      Date.parse(a.verified_at) > Date.parse(v.created_at)
    )
      return invalid();
    association = {
      kind: 'caller_selected',
      executionId: a.execution_id,
      verifiedAt: a.verified_at,
    };
  }
  if (
    nomination &&
    (v.size !== nomination.expected_size ||
      v.sha256 !== nomination.expected_sha256 ||
      (association?.executionId ?? undefined) !== nomination.execution_id)
  )
    return invalid();
  return {
    artifactId: v.artifact_id,
    kind: 'artifact',
    state: 'ready',
    computerId: v.computer_id,
    workspaceId: v.workspace_id,
    createdAt: v.created_at,
    expiresAt: v.expires_at,
    size: v.size,
    sha256: v.sha256,
    executionAssociation: association,
  };
}
export function artifactCrypto(): typeof globalThis.crypto.subtle {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || typeof subtle.digest !== 'function')
    throw new ValidationError('artifact download requires Web Crypto SHA-256 support');
  return subtle;
}
export async function verifyArtifact(
  bytes: Uint8Array,
  manifest: Artifact,
  subtle: typeof globalThis.crypto.subtle,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  signal?.throwIfAborted();
  if (bytes.length !== manifest.size) throw new MandalaError('artifact download size mismatch');
  const hash = await subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  signal?.throwIfAborted();
  const hex = Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
  if (hex !== manifest.sha256) throw new MandalaError('artifact download SHA-256 mismatch');
  return bytes;
}
