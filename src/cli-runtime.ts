import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { TextDecoder } from 'node:util';
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
  /** How `computers view` opens a page; {@link openBrowser} unless replaced. */
  openBrowser?: (url: string) => Promise<boolean>;
};

/**
 * Open a URL in the default browser: one argument, no shell. Resolves false
 * rather than throwing when it cannot, so the caller's printed URL stays the
 * way through.
 */
export function openBrowser(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
    let finished = false;
    const done = (ok: boolean) => {
      if (!finished) {
        finished = true;
        clearTimeout(timer);
        resolve(ok);
      }
    };
    const child = spawn(command, [url], { stdio: 'ignore', shell: false });
    const timer = setTimeout(() => {
      child.kill();
      done(false);
    }, 2000);
    child.once('error', () => done(false));
    child.once('exit', (code) => done(code === 0));
  });
}

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
  return Buffer.from(await readInputBytes(io, signal)).toString('utf8');
}

/** Everything piped on stdin, as the bytes that arrived. */
async function readInputBytes(io: CliIO, signal: AbortSignal): Promise<Uint8Array> {
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
    return Buffer.concat(chunks);
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
    // Fatal, not replacing: a malformed byte stored as U+FFFD is a credential
    // silently changed into one that does not work, reported as a success.
    const text = decodeSecret(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }),
      await readInputBytes(io, signal),
    );
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
  // ONE decoder across every chunk, streaming: a terminal may deliver a
  // multibyte character split between two reads, and decoding each read on its
  // own turns both halves into U+FFFD.
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  try {
    return await new Promise<string>((resolve, reject) => {
      const done = (fn: () => void) => {
        stdin.removeListener('data', onData);
        signal.removeEventListener('abort', onAbort);
        fn();
      };
      const onAbort = () => done(() => reject(signal.reason));
      const onData = (chunk: string | Uint8Array) => {
        let text: string;
        try {
          text = typeof chunk === 'string' ? chunk : decodeSecret(decoder, chunk, true);
        } catch (error) {
          return done(() => reject(error));
        }
        for (const ch of text) {
          if (ch === '\r' || ch === '\n' || ch === '\u0004') {
            // A character left half-received at Enter is malformed input too.
            return done(() => {
              try {
                decodeSecret(decoder, new Uint8Array());
                resolve(value);
              } catch (error) {
                reject(error);
              }
            });
          }
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

/** Decode, refusing malformed UTF-8 with a message that never quotes the bytes. */
function decodeSecret(decoder: TextDecoder, bytes: Uint8Array, stream = false): string {
  try {
    return decoder.decode(bytes, { stream });
  } catch {
    throw new CliError('invalid_input', 'the value is not valid UTF-8; nothing was sent');
  }
}
