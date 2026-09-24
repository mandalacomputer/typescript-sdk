import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { CliError } from './cli-options.js';
import type { SshRuntime } from './cli-ssh.js';
import { resolveCredentials } from './credentials.js';
import type { DeviceLoginDependencies } from './device-login.js';
import { Client } from './index.js';

export type CliIO = {
  stdin: NodeJS.ReadableStream &
    AsyncIterable<string | Uint8Array> & {
      isTTY?: boolean;
      destroy?: (error?: Error) => unknown;
      setRawMode?: (mode: boolean) => unknown;
    };
  stdout: Pick<NodeJS.WritableStream, 'write'> & { isTTY?: boolean };
  stderr: Pick<NodeJS.WritableStream, 'write'> & { isTTY?: boolean };
  env: NodeJS.ProcessEnv;
  createClient: (profile?: string) => Client;
  secrets?: Set<string>;
  login?: Partial<Pick<DeviceLoginDependencies, 'fetch' | 'now' | 'sleep'>> & {
    openBrowser?: (url: string) => Promise<boolean>;
  };
  now: () => Date;
  /** The machine the SSH commands run on; the real one unless replaced. */
  ssh?: SshRuntime;
};

export function runtime(overrides: Partial<CliIO> = {}): CliIO {
  const env = overrides.env ?? process.env;
  const secrets = overrides.secrets ?? new Set<string>();
  return {
    secrets,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env,
    createClient: (profile) => {
      const auth = resolveCredentials({ profile }, env);
      secrets.add(auth.apiKey);
      return new Client({ apiKey: auth.apiKey, baseUrl: auth.baseUrl });
    },
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

/**
 * A secret value, from stdin or a hidden prompt — never from argv, where it
 * would sit in shell history and in every process listing on the machine.
 *
 * Piped: the whole of stdin, less ONE trailing newline (`\n` or `\r\n`), so
 * `echo "$TOKEN" | mandala secrets set NAME` stores the token rather than the
 * token and a newline; a value that must end in a newline can be piped with
 * two. A terminal: a prompt on stderr, read with echo off, ended by Enter.
 */
export async function readSecretValue(
  io: CliIO,
  name: string,
  signal: AbortSignal,
): Promise<string> {
  if (!io.stdin.isTTY) {
    const text = await readInput(io, signal);
    return text.endsWith('\r\n')
      ? text.slice(0, -2)
      : text.endsWith('\n')
        ? text.slice(0, -1)
        : text;
  }
  const { stdin } = io;
  if (typeof stdin.setRawMode !== 'function')
    throw new CliError(
      'invalid_arguments',
      'cannot read a value without echoing it here; pipe it on stdin instead',
    );
  io.stderr.write(`Value for ${name} (input hidden): `);
  const setRawMode = stdin.setRawMode.bind(stdin);
  setRawMode(true);
  let value = '';
  try {
    return await new Promise<string>((resolve, reject) => {
      const done = (fn: () => void) => {
        stdin.removeListener('data', onData);
        signal.removeEventListener('abort', onAbort);
        fn();
      };
      const onAbort = () => done(() => reject(signal.reason));
      const onData = (chunk: string | Uint8Array) => {
        const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
        for (const ch of text) {
          if (ch === '\r' || ch === '\n' || ch === '\u0004') return done(() => resolve(value));
          if (ch === '\u0003')
            return done(() => reject(new CliError('cancelled', 'Cancelled', undefined, 130)));
          if (ch === '\u007f' || ch === '\b') value = [...value].slice(0, -1).join('');
          else value += ch;
        }
      };
      signal.throwIfAborted();
      signal.addEventListener('abort', onAbort, { once: true });
      stdin.on('data', onData);
      stdin.resume();
    });
  } finally {
    // Restoring the terminal MUST happen, or the shell is left with no echo.
    setRawMode(false);
    stdin.pause();
    io.stderr.write('\n');
  }
}
