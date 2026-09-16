import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { CliError } from './cli-options.js';
import { Client } from './index.js';

export type CliIO = {
  stdin: NodeJS.ReadableStream &
    AsyncIterable<string | Uint8Array> & { isTTY?: boolean; destroy?: (error?: Error) => unknown };
  stdout: Pick<NodeJS.WritableStream, 'write'> & { isTTY?: boolean };
  stderr: Pick<NodeJS.WritableStream, 'write'> & { isTTY?: boolean };
  env: NodeJS.ProcessEnv;
  createClient: () => Client;
  now: () => Date;
};

export function runtime(overrides: Partial<CliIO> = {}): CliIO {
  const env = overrides.env ?? process.env;
  return {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env,
    createClient: () => new Client({ apiKey: env.MANDALA_API_KEY, baseUrl: env.MANDALA_BASE_URL }),
    now: () => new Date(),
    ...overrides,
  };
}

export async function readInput(io: CliIO, signal: AbortSignal): Promise<string> {
  if (io.stdin.isTTY)
    throw new CliError('invalid_arguments', 'pipe input on stdin or provide a file / -c command');
  const chunks: Uint8Array[] = [];
  const abort = () => io.stdin.destroy?.(signal.reason);
  signal.throwIfAborted();
  signal.addEventListener('abort', abort, { once: true });
  try {
    for await (const chunk of io.stdin) {
      signal.throwIfAborted();
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    signal.throwIfAborted();
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

export async function documentInput(file: string, io: CliIO, signal: AbortSignal): Promise<string> {
  return file === '-' ? readInput(io, signal) : readFile(file, { encoding: 'utf8', signal });
}
