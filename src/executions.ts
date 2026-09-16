/** Stable identity reads over volatile output; no retained results or implicit polling. */
import { MandalaError } from './errors.js';
import { base64Bytes } from './models.js';
import { isExecutionId, isRecord } from './paths.js';
import type { CallOptions } from './resources.js';

type ExecutionIdentity = {
  executionId: string;
  computerId: string;
  pid: number;
  startedAt: string;
  outputSource: 'volatile_guest_files';
  raw: Record<string, unknown>;
};

/** Last observed state, not proof that a computer is currently awake. */
export type ExecutionMetadata = ExecutionIdentity &
  (
    | { status: 'running' | 'lost'; endedAt?: never; exitCode?: never }
    | { status: 'exited'; endedAt: string; exitCode: number }
  );

export type ExecutionOutputOptions = CallOptions & {
  stdoutOffset: number;
  stderrOffset: number;
  /** Maximum bytes per stream: 1–1048576; defaults to 65536. */
  limit?: number;
};

export type ExecutionOutput = {
  executionId: string;
  stdout: Uint8Array;
  stderr: Uint8Array;
  /** Next byte positions for this reader; diagnostic bytes do not advance either. */
  stdoutOffset: number;
  stderrOffset: number;
  /** False means current EOF, including while the command is still running. */
  stdoutMore: boolean;
  stderrMore: boolean;
  /** Repeated in full on every response; separate from the command's stderr. */
  diagnostic: Uint8Array;
  diagnosticTruncated: boolean;
  raw: Record<string, unknown>;
};

function invalid(field: string): never {
  // Do not echo payload values: output and unexpected identifiers can contain secrets.
  throw new MandalaError(`invalid execution response: ${field}`);
}

function response(data: unknown, executionId: string): Record<string, unknown> {
  if (!isRecord(data)) invalid('expected an object');
  if (!isExecutionId(data.execution_id) || data.execution_id !== executionId) {
    invalid('execution_id does not match the requested execution');
  }
  return data;
}

function integer(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) invalid(field);
  return value;
}

function timestamp(value: unknown, field: string): string {
  if (typeof value !== 'string') invalid(field);
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(
      value,
    );
  if (!match || !Number.isFinite(Date.parse(value))) invalid(field);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > days[month - 1]! ||
    Number(match[4]) > 23 ||
    Number(match[5]) > 59 ||
    Number(match[6]) > 59
  )
    invalid(field);
  return value;
}

export function toExecutionMetadata(
  data: unknown,
  computerId: string,
  executionId: string,
): ExecutionMetadata {
  const d = response(data, executionId);
  if (d.computer_id !== computerId) invalid('computer_id does not match the requested computer');
  const pid = integer(d.pid, 'pid');
  if (pid <= 0) invalid('pid');
  const startedAt = timestamp(d.started_at, 'started_at');
  if (d.output_source !== 'volatile_guest_files') invalid('output_source');
  const identity: ExecutionIdentity = {
    executionId,
    computerId,
    pid,
    startedAt,
    outputSource: 'volatile_guest_files',
    raw: { ...d },
  };
  if (d.status === 'exited') {
    return {
      ...identity,
      status: 'exited',
      endedAt: timestamp(d.ended_at, 'ended_at'),
      exitCode: integer(d.exit_code, 'exit_code'),
    };
  }
  if (d.status !== 'running' && d.status !== 'lost') invalid('status');
  if ('exit_code' in d || 'ended_at' in d) invalid('non-exited state carries exit evidence');
  return { ...identity, status: d.status };
}

function bytes(value: unknown, field: string, max: number): Uint8Array {
  if (
    typeof value !== 'string' ||
    value.length > Math.ceil(max / 3) * 4 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value) ||
    value.length % 4 !== 0
  )
    invalid(field);
  // Standard padding must also have zero unused bits; permissive decoders accept AB== as AA==.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  if (padding && alphabet.indexOf(value[value.length - padding - 1]!) & (padding === 2 ? 15 : 3))
    invalid(field);
  const decoded = base64Bytes(value);
  if (!decoded || decoded.length > max) invalid(field);
  return decoded;
}

function flag(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') invalid(field);
  return value;
}

export function toExecutionOutput(
  data: unknown,
  executionId: string,
  query: {
    stdout_offset: number;
    stderr_offset: number;
    limit?: number;
  },
): ExecutionOutput {
  const d = response(data, executionId);
  const limit = query.limit ?? 65536;
  const stdout = bytes(d.stdout_b64, 'stdout_b64', limit);
  const stderr = bytes(d.stderr_b64, 'stderr_b64', limit);
  const diagnostic = bytes(d.diagnostic_b64, 'diagnostic_b64', 65536);
  const stdoutOffset = integer(d.stdout_offset, 'stdout_offset');
  const stderrOffset = integer(d.stderr_offset, 'stderr_offset');
  if (stdoutOffset !== query.stdout_offset + stdout.length)
    invalid('stdout_offset does not match decoded bytes');
  if (stderrOffset !== query.stderr_offset + stderr.length)
    invalid('stderr_offset does not match decoded bytes');
  const stdoutMore = flag(d.stdout_more, 'stdout_more');
  const stderrMore = flag(d.stderr_more, 'stderr_more');
  if ((stdoutMore && stdout.length !== limit) || (stderrMore && stderr.length !== limit)) {
    invalid('more flag without a full stream chunk');
  }
  return {
    executionId,
    stdout,
    stderr,
    stdoutOffset,
    stderrOffset,
    stdoutMore,
    stderrMore,
    diagnostic,
    diagnosticTruncated: flag(d.diagnostic_truncated, 'diagnostic_truncated'),
    raw: { ...d },
  };
}
