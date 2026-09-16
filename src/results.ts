/** Finite immutable output versions. These observations are not task-success evidence. */
import { MandalaError, ValidationError } from './errors.js';
import { isExecutionId, isRecord, isResultId } from './paths.js';
import type { CallOptions } from './resources.js';
import type { BoundedBytes } from './transport.js';

export const RESULT_MANIFEST_BYTES = 8192;
export const RESULT_STREAM_MAX = 4 * 1024 * 1024;
export const RETENTION_MAX_S = 604800;
export type RetainOutputOptions = { maxBytesPerStream?: number; retentionSeconds?: number };
export type ResultStream = 'stdout' | 'stderr' | 'diagnostic';
export type ResultOutputOptions = {
  stream: ResultStream;
  offset: number;
  limit?: number;
} & CallOptions;
export type ResultOutput = {
  resultId: string;
  stream: ResultStream;
  offset: number;
  nextOffset: number;
  eof: boolean;
  bytes: Uint8Array;
};
export type ResultObservation =
  | { status: 'running'; observedAt: string }
  | { status: 'exited'; observedAt: string; exitCode: number };
export type ResultPrefix = {
  bytes: number;
  sha256: string;
  sourceOffset: 0;
  nextSourceOffset: number;
  endReason: 'observed_eof' | 'byte_limit';
};
export type SynchronousResultPrefix = Omit<ResultPrefix, 'endReason'> & {
  sourceResponseBytes: number;
  endReason: 'response_end' | 'byte_limit';
  upstreamTruncated: boolean;
};
type ResultBase = {
  version: 1;
  resultId: string;
  state: 'ready';
  accountId: string;
  computerId: string;
  workspaceId: string | null;
  captureStartedAt: string;
  capturedAt: string;
  expiresAt: string;
};
export type BackgroundResult = ResultBase & {
  kind: 'background-output';
  executionId: string;
  source: 'volatile_guest_files';
  executionObservation: ResultObservation;
  stdout: ResultPrefix;
  stderr: ResultPrefix;
  diagnostic: { bytes: number; sha256: string; source: 'wrapper'; diagnosticTruncated: boolean };
};
export type SynchronousResult = ResultBase & {
  kind: 'synchronous-output';
  executionId: null;
  source: 'exec_response';
  executionObservation: Extract<ResultObservation, { status: 'exited' }>;
  stdout: SynchronousResultPrefix;
  stderr: SynchronousResultPrefix;
  diagnostic: null;
};
export type RetainedResult = BackgroundResult | SynchronousResult;

export const integer = (v: unknown, min: number, max = Number.MAX_SAFE_INTEGER): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
export const digest = (v: unknown): v is string =>
  typeof v === 'string' && v.length === 64 && /^[a-f0-9]+$/.test(v);
export const scopeId = (v: unknown): v is string =>
  typeof v === 'string' && v.length >= 1 && v.length <= 100 && !/[^A-Za-z0-9_-]/.test(v);
/** Match the retained protocol's UTC-only RFC3339Nano, preserving its original spelling. */
export const retainedTime = (v: unknown): v is string =>
  typeof v === 'string' &&
  v.length <= 30 &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(v) &&
  v.endsWith('Z') &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString().slice(0, 19) === v.slice(0, 19);
export function optionRecord(v: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(v) || Object.keys(v).some((k) => !keys.includes(k)))
    throw new ValidationError('invalid retained operation options');
  return v;
}
export function retainOutputBody(value: unknown): {
  max_bytes_per_stream?: number;
  retention_seconds?: number;
} {
  const v = optionRecord(value, ['maxBytesPerStream', 'retentionSeconds']);
  const out: { max_bytes_per_stream?: number; retention_seconds?: number } = {};
  if (v.maxBytesPerStream !== undefined) {
    if (!integer(v.maxBytesPerStream, 1, RESULT_STREAM_MAX))
      throw new ValidationError('maxBytesPerStream must be an integer from 1 through 4194304');
    out.max_bytes_per_stream = v.maxBytesPerStream;
  }
  if (v.retentionSeconds !== undefined) {
    if (!integer(v.retentionSeconds, 1, RETENTION_MAX_S))
      throw new ValidationError('retentionSeconds must be an integer from 1 through 604800');
    out.retention_seconds = v.retentionSeconds;
  }
  return out;
}
export function captureBody(value: unknown) {
  const v = optionRecord(value, ['maxBytesPerStream', 'retentionSeconds', 'signal']);
  return retainOutputBody({
    maxBytesPerStream: v.maxBytesPerStream,
    retentionSeconds: v.retentionSeconds,
  });
}
export function syncRetentionBody(
  value: unknown,
): true | ReturnType<typeof retainOutputBody> | undefined {
  if (value === undefined || value === false) return undefined;
  return value === true ? true : retainOutputBody(value);
}
const invalid = (): never => {
  throw new MandalaError(
    'invalid or unsupported retained result response; any requested publication is unconfirmed',
  );
};
export function toRetainedResult(
  value: unknown,
  computerId: string,
  resultId?: string,
  executionId?: string,
): RetainedResult {
  if (!isRecord(value)) return invalid();
  const v = value;
  if (
    v.version !== 1 ||
    !isResultId(v.result_id) ||
    (resultId !== undefined && v.result_id !== resultId) ||
    v.state !== 'ready' ||
    !scopeId(v.account_id) ||
    !scopeId(v.computer_id) ||
    v.computer_id !== computerId ||
    !(v.workspace_id === null || scopeId(v.workspace_id)) ||
    !retainedTime(v.capture_started_at) ||
    !retainedTime(v.captured_at) ||
    !retainedTime(v.expires_at)
  )
    return invalid();
  const start = Date.parse(v.capture_started_at),
    end = Date.parse(v.captured_at),
    expires = Date.parse(v.expires_at);
  if (end < start || expires <= end || expires - start > RETENTION_MAX_S * 1000) return invalid();
  const o = v.execution_observation;
  if (
    !isRecord(o) ||
    !retainedTime(o.observed_at) ||
    Date.parse(o.observed_at) < start ||
    Date.parse(o.observed_at) > end
  )
    return invalid();
  let observation: ResultObservation;
  if (o.status === 'running' && !('exit_code' in o))
    observation = { status: 'running', observedAt: o.observed_at };
  else if (o.status === 'exited' && integer(o.exit_code, -2147483648, 2147483647))
    observation = { status: 'exited', observedAt: o.observed_at, exitCode: o.exit_code };
  else return invalid();
  const base: ResultBase = {
    version: 1,
    resultId: v.result_id,
    state: 'ready',
    accountId: v.account_id,
    computerId: v.computer_id,
    workspaceId: v.workspace_id,
    captureStartedAt: v.capture_started_at,
    capturedAt: v.captured_at,
    expiresAt: v.expires_at,
  };
  const commonPrefix = (p: unknown) => {
    if (
      !isRecord(p) ||
      !integer(p.bytes, 0, RESULT_STREAM_MAX) ||
      !digest(p.sha256) ||
      p.source_offset !== 0 ||
      p.next_source_offset !== p.bytes
    )
      return invalid();
    return {
      bytes: p.bytes,
      sha256: p.sha256,
      sourceOffset: 0 as const,
      nextSourceOffset: p.bytes,
    };
  };
  if (v.kind === 'background-output') {
    if (
      v.source !== 'volatile_guest_files' ||
      !isExecutionId(v.execution_id) ||
      (executionId !== undefined && v.execution_id !== executionId)
    )
      return invalid();
    const prefix = (p: unknown): ResultPrefix => {
      const fields = commonPrefix(p);
      if (!isRecord(p) || (p.end_reason !== 'observed_eof' && p.end_reason !== 'byte_limit'))
        return invalid();
      return { ...fields, endReason: p.end_reason };
    };
    const d = v.diagnostic;
    if (
      !isRecord(d) ||
      !integer(d.bytes, 0, 65536) ||
      !digest(d.sha256) ||
      d.source !== 'wrapper' ||
      typeof d.diagnostic_truncated !== 'boolean'
    )
      return invalid();
    return {
      ...base,
      kind: 'background-output',
      executionId: v.execution_id,
      source: 'volatile_guest_files',
      executionObservation: observation,
      stdout: prefix(v.stdout),
      stderr: prefix(v.stderr),
      diagnostic: {
        bytes: d.bytes,
        sha256: d.sha256,
        source: 'wrapper',
        diagnosticTruncated: d.diagnostic_truncated,
      },
    };
  }
  if (
    v.kind !== 'synchronous-output' ||
    executionId !== undefined ||
    v.execution_id !== null ||
    v.source !== 'exec_response' ||
    v.diagnostic !== null ||
    observation.status !== 'exited'
  )
    return invalid();
  const prefix = (p: unknown): SynchronousResultPrefix => {
    const fields = commonPrefix(p);
    if (
      !isRecord(p) ||
      !integer(p.source_response_bytes, fields.bytes, 16 * 1024 * 1024) ||
      typeof p.upstream_truncated !== 'boolean' ||
      p.end_reason !== (p.source_response_bytes === fields.bytes ? 'response_end' : 'byte_limit')
    )
      return invalid();
    return {
      ...fields,
      sourceResponseBytes: p.source_response_bytes,
      endReason: p.end_reason as 'response_end' | 'byte_limit',
      upstreamTruncated: p.upstream_truncated,
    };
  };
  return {
    ...base,
    kind: 'synchronous-output',
    executionId: null,
    source: 'exec_response',
    executionObservation: observation,
    stdout: prefix(v.stdout),
    stderr: prefix(v.stderr),
    diagnostic: null,
  };
}
export function resultOutputQuery(value: unknown): {
  stream: ResultStream;
  offset: number;
  limit?: number;
} {
  const v = optionRecord(value, ['stream', 'offset', 'limit', 'signal']);
  if (
    (v.stream !== 'stdout' && v.stream !== 'stderr' && v.stream !== 'diagnostic') ||
    !integer(v.offset, 0) ||
    (v.limit !== undefined && !integer(v.limit, 1, 65536)) ||
    !Number.isSafeInteger(v.offset + ((v.limit as number | undefined) ?? 65536))
  )
    throw new ValidationError('invalid retained output stream, offset or limit');
  return {
    stream: v.stream,
    offset: v.offset,
    ...(v.limit === undefined ? {} : { limit: v.limit as number }),
  };
}
export function toResultOutput(
  data: BoundedBytes,
  resultId: string,
  query: ReturnType<typeof resultOutputQuery>,
): ResultOutput {
  const { offset, nextOffset, eof } = data;
  if (
    offset !== String(query.offset) ||
    nextOffset !== String(query.offset + data.bytes.length) ||
    (eof !== 'true' && eof !== 'false') ||
    (eof === 'false' && data.bytes.length === 0)
  )
    throw new MandalaError('invalid retained output page headers');
  return {
    resultId,
    stream: query.stream,
    offset: query.offset,
    nextOffset: query.offset + data.bytes.length,
    eof: eof === 'true',
    bytes: data.bytes,
  };
}
/** Optional metadata must never turn a completed legacy command into a parsing failure. */
export function synchronousResultId(v: Record<string, unknown>): string | undefined {
  if (
    !isResultId(v.result_id) ||
    v.timed_out !== false ||
    !integer(v.exit_code, -2147483648, 2147483647) ||
    typeof v.out_truncated !== 'boolean' ||
    typeof v.err_truncated !== 'boolean' ||
    v.running === true ||
    v.pid !== undefined
  )
    return undefined;
  const canonical = (s: unknown) => {
    if (
      typeof s !== 'string' ||
      s.length > 4 * Math.ceil((16 * 1024 * 1024) / 3) ||
      s.length % 4 !== 0
    )
      return false;
    const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
    if ((s.length / 4) * 3 - pad > 16 * 1024 * 1024) return false;
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    // Linear scan, not a quantified-regex stack proportional to a 16 MiB stream.
    for (let i = 0; i < s.length - pad; i++) {
      const code = s.charCodeAt(i);
      if (
        !(
          (code >= 65 && code <= 90) ||
          (code >= 97 && code <= 122) ||
          (code >= 48 && code <= 57) ||
          code === 43 ||
          code === 47
        )
      )
        return false;
    }
    return (
      pad === 0 || (alphabet.indexOf(s[s.length - pad - 1] ?? '') & (pad === 2 ? 15 : 3)) === 0
    );
  };
  return canonical(v.stdout_b64) && canonical(v.stderr_b64) ? v.result_id : undefined;
}
