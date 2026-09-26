import { CliError } from './cli-options.js';
import type { CliIO } from './cli-runtime.js';
import {
  APIError,
  AuthenticationError,
  ComputerNotRunningError,
  ConflictError,
  ConnectionError,
  ConnectionInterruptedError,
  CreateOnlyConflictError,
  FileExistsError,
  GatewayTimeoutError,
  MandalaError,
  MethodNotAllowedError,
  MoveRequiredError,
  NotFoundError,
  OperationFailedError,
  OriginResponseError,
  OriginTLSError,
  OriginUnreachableError,
  PermissionDeniedError,
  PlanLimitError,
  RangeNotSatisfiableError,
  RateLimitError,
  TimeoutError,
  TooLargeError,
  UnavailableError,
  ValidationError,
} from './errors.js';

/**
 * 2 since every key the CLI writes became snake_case, the envelope's own
 * included: `schemaVersion` and `exitCode` read `schema_version` and `exit_code`.
 */
export const SCHEMA_VERSION = 2;

/**
 * `camelCase` keys to `snake_case`, all the way down: the casing the API
 * itself answers in, so one `--json` output never mixes the two.
 *
 * For what this SDK DECODED — an exec result, a build's progress, an agent
 * step — and never for an API payload passed through, whose maps may be keyed
 * by names a person chose. Only a key spelled like a camelCase identifier is
 * touched: `MY_TOKEN` and `vm-1` come through as they are.
 */
export function snakeKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(snakeKeys);
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype)
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        /^[a-z][a-zA-Z0-9]*$/.test(k) ? k.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase() : k,
        snakeKeys(v),
      ]),
    );
  return value;
}

/**
 * The `error.code` a failure is reported under: one snake_case word naming
 * the KIND of failure, the same word in this CLI and in `mandala-py`. Never
 * a class name — those differ between the two SDKs. `error.status` carries the
 * HTTP status and `error.reason` the platform's own word, when either exists.
 * Most specific first: every conflict is a `ConflictError`.
 */
const API_CODES: readonly [new (...args: never[]) => APIError, string][] = [
  [FileExistsError, 'exists'],
  [CreateOnlyConflictError, 'conflict'],
  [MoveRequiredError, 'move_required'],
  [ComputerNotRunningError, 'not_running'],
  [ConflictError, 'conflict'],
  [AuthenticationError, 'unauthenticated'],
  [PlanLimitError, 'plan_limit'],
  [PermissionDeniedError, 'permission_denied'],
  [NotFoundError, 'not_found'],
  [MethodNotAllowedError, 'method_not_allowed'],
  [TooLargeError, 'too_large'],
  [RangeNotSatisfiableError, 'range_not_satisfiable'],
  [RateLimitError, 'rate_limited'],
  [UnavailableError, 'unavailable'],
  [GatewayTimeoutError, 'gateway_timeout'],
  [OriginUnreachableError, 'origin_unreachable'],
  [OriginTLSError, 'origin_tls'],
  [OriginResponseError, 'origin_error'],
];

export function errorCode(error: MandalaError): string {
  if (error instanceof APIError)
    return API_CODES.find(([cls]) => error instanceof cls)?.[1] ?? 'api_error';
  if (error instanceof ConnectionInterruptedError) return 'connection_interrupted';
  if (error instanceof ConnectionError) return 'connection_failed';
  if (error instanceof TimeoutError) return 'timeout';
  return 'failed';
}

/** Mask credentials even when a remote error or payload repeats their values. */
export function redact(
  value: unknown,
  env: NodeJS.ProcessEnv,
  secrets: Iterable<string> = [],
): unknown {
  if (typeof value === 'string') {
    for (const secret of [...secrets, env.MANDALA_API_KEY, env.MANDALA_MODEL_KEY].flatMap((key) =>
      key ? [key, key.trim()] : [],
    )) {
      if (secret) value = (value as string).split(secret).join('[REDACTED]');
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, env, secrets));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [redact(k, env, secrets), redact(v, env, secrets)]),
    );
  return value;
}

export function errorInfo(error: unknown): {
  code: string;
  message: string;
  status?: number;
  reason?: string;
  details?: unknown;
  usage?: string;
} {
  if (error instanceof CliError)
    return {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: snakeKeys(error.details) }),
      ...(error.usage === undefined ? {} : { usage: error.usage }),
    };
  if (error instanceof ValidationError)
    return { code: 'invalid_arguments', message: error.message };
  if (error instanceof APIError)
    return {
      code: errorCode(error),
      message: error.message,
      status: error.status,
      ...(error.reason === undefined ? {} : { reason: error.reason }),
    };
  if (error instanceof Error && error.name === 'AbortError')
    return { code: 'cancelled', message: 'Cancelled' };
  // Before the branch below, which would read the platform's own `code` —
  // `start_failed`, or nothing at all — as this CLI's error vocabulary. The
  // operation's code is kept, as a detail.
  if (error instanceof OperationFailedError)
    return {
      code: 'operation_failed',
      message: error.message,
      details: { operation: error.operation.raw },
    };
  if (error instanceof MandalaError) {
    // The local stages (credentials, device login) name their own failure, in
    // the same snake_case.
    const own = (error as { code?: unknown }).code;
    return { code: typeof own === 'string' ? own : errorCode(error), message: error.message };
  }
  // A system error from the local machine (a file that is not there, a pipe
  // closed): its errno is kept, but as a detail, so `code` stays a word.
  if (error instanceof Error && typeof (error as { code?: unknown }).code === 'string')
    return {
      code: 'io_error',
      message: error.message,
      details: { errno: (error as Error & { code: string }).code },
    };
  return {
    code: 'internal_error',
    message: error instanceof Error ? error.message : String(error),
  };
}

export class Output {
  constructor(
    private readonly io: CliIO,
    readonly command: string,
    readonly json: boolean,
  ) {}

  emitJson(value: unknown): void {
    this.io.stdout.write(`${JSON.stringify(redact(value, this.io.env, this.io.secrets))}\n`);
  }

  result(data: unknown, exitCode = 0): number {
    if (this.json)
      this.emitJson({
        schema_version: SCHEMA_VERSION,
        command: this.command,
        ok: exitCode === 0,
        data,
        exit_code: exitCode,
      });
    else
      this.io.stdout.write(
        `${JSON.stringify(redact(data, this.io.env, this.io.secrets), null, 2)}\n`,
      );
    return exitCode;
  }

  error(error: unknown, exitCode = 1, stream = false): number {
    const info = errorInfo(error);
    if (this.json) {
      if (stream) this.frame('error', { error: info, exit_code: exitCode });
      else
        this.emitJson({
          schema_version: SCHEMA_VERSION,
          command: this.command,
          ok: false,
          error: info,
          exit_code: exitCode,
        });
    } else {
      this.diagnostic(`mandala: ${info.message}`);
      if (info.usage) this.diagnostic(`\n${info.usage.trimEnd()}`);
    }
    return exitCode;
  }

  frame(type: string, data: unknown): void {
    if (this.json)
      this.emitJson({
        schema_version: SCHEMA_VERSION,
        command: this.command,
        type,
        timestamp: this.io.now().toISOString(),
        data,
      });
    else {
      const text = typeof data === 'string' ? data : JSON.stringify(data);
      this.io.stdout.write(
        `${this.io.now().toISOString()} ${type}: ${redact(text, this.io.env, this.io.secrets)}\n`,
      );
    }
  }

  diagnostic(text: string): void {
    this.io.stderr.write(`${redact(text, this.io.env, this.io.secrets)}\n`);
  }
}
