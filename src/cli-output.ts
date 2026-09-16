import { CliError } from './cli-options.js';
import type { CliIO } from './cli-runtime.js';
import { APIError, MandalaError, ValidationError } from './errors.js';

export const SCHEMA_VERSION = 1;

/** Mask credentials even when a remote error or payload repeats their values. */
export function redact(value: unknown, env: NodeJS.ProcessEnv): unknown {
  if (typeof value === 'string') {
    for (const secret of [env.MANDALA_API_KEY, env.MANDALA_MODEL_KEY].flatMap((key) =>
      key ? [key, key.trim()] : [],
    )) {
      if (secret) value = (value as string).split(secret).join('[REDACTED]');
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, env));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, env)]));
  return value;
}

export function errorInfo(error: unknown): {
  code: string;
  message: string;
  status?: number;
  details?: unknown;
} {
  if (error instanceof CliError)
    return {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  if (error instanceof ValidationError)
    return { code: 'invalid_arguments', message: error.message };
  if (error instanceof APIError)
    return { code: error.name, message: error.message, status: error.status };
  if (error instanceof Error && error.name === 'AbortError')
    return { code: 'cancelled', message: 'Cancelled' };
  if (error instanceof MandalaError) return { code: error.name, message: error.message };
  if (error instanceof Error && typeof (error as { code?: unknown }).code === 'string')
    return { code: (error as Error & { code: string }).code, message: error.message };
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
    this.io.stdout.write(`${JSON.stringify(redact(value, this.io.env))}\n`);
  }

  result(data: unknown, exitCode = 0): number {
    if (this.json)
      this.emitJson({
        schemaVersion: SCHEMA_VERSION,
        command: this.command,
        ok: exitCode === 0,
        data,
        exitCode,
      });
    else this.io.stdout.write(`${JSON.stringify(redact(data, this.io.env), null, 2)}\n`);
    return exitCode;
  }

  error(error: unknown, exitCode = 1, stream = false): number {
    const info = errorInfo(error);
    if (this.json) {
      if (stream) this.frame('error', { error: info, exitCode });
      else
        this.emitJson({
          schemaVersion: SCHEMA_VERSION,
          command: this.command,
          ok: false,
          error: info,
          exitCode,
        });
    } else this.diagnostic(`mandala: ${info.message}`);
    return exitCode;
  }

  frame(type: string, data: unknown): void {
    if (this.json)
      this.emitJson({
        schemaVersion: SCHEMA_VERSION,
        command: this.command,
        type,
        timestamp: this.io.now().toISOString(),
        data,
      });
    else {
      const text = typeof data === 'string' ? data : JSON.stringify(data);
      this.io.stdout.write(
        `${this.io.now().toISOString()} ${type}: ${redact(text, this.io.env)}\n`,
      );
    }
  }

  diagnostic(text: string): void {
    this.io.stderr.write(`${redact(text, this.io.env)}\n`);
  }
}
