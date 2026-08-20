#!/usr/bin/env node

/**
 * The `mandala` command — a computer's shell and files from your own terminal.
 *
 * Two subcommands, both addressing a computer by name or id:
 *
 * `mandala ssh <computer>`
 *   An interactive shell in the guest, over the platform's terminal websocket —
 *   a PTY the platform keeps alive server-side. Disconnecting detaches the
 *   session rather than ending it; running the same command reattaches and
 *   replays recent output. `--session` names one of several.
 *
 * `mandala scp <src> <dst>`
 *   Copy one file in or out, scp-style: the side spelled `<computer>:/path` is
 *   the guest. Rides the files API, so it needs no shell in the guest at all.
 *
 * Authentication is the SDK's: `MANDALA_API_KEY` (and optionally
 * `MANDALA_BASE_URL`) in the environment.
 *
 * Node-only, and deliberately not exported from the package index: it reaches
 * for `node:tty` and the process's own file descriptors, and importing it would
 * break the library in a browser or a worker for the sake of a command nothing
 * there can run.
 */

import { realpathSync } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import type { Computer } from './computer.js';
import { MandalaError, ValidationError } from './errors.js';
import { Client } from './index.js';

/**
 * The whole guest-side scrollback is smaller than this; anything bigger in one
 * frame is not the terminal protocol.
 */
const MAX_FRAME = 1 << 22;

/**
 * How long after the exit announcement a session waits for the socket to close.
 *
 * Long enough for the output frames queued behind the exit to arrive on any
 * plausible link; short enough that a server which lingers indefinitely after
 * announcing the exit cannot hold the local terminal open with it.
 */
const EXIT_DRAIN_MS = 3_000;

const USAGE = `mandala — your own terminal, against a Mandala computer.

  mandala ssh <computer> [--session NAME]   an interactive shell in the guest
  mandala scp <src> <dst>                   copy one file in or out

<computer> is a name or an id. One side of scp is spelled <computer>:/abs/path.

  MANDALA_API_KEY    required
  MANDALA_BASE_URL   optional, for a self-hosted platform
`;

class Died extends Error {}

function die(message: string): never {
  throw new Died(message);
}

/** The computer `target` names — an exact id, or a unique name. */
async function resolve(client: Client, target: string): Promise<Computer> {
  let computers: Computer[];
  try {
    computers = await client.computers.list();
  } catch (err) {
    // A listing fans out across every host on the account, so one unreachable
    // hypervisor answers 503 for the whole thing — and takes down a command
    // that named an id the computer's own route would have answered. Tried
    // second rather than first: a get() on a name is a 404, and paying for one
    // on the spelling people actually use is the wrong way round.
    const byId = await client.computers.get(target).catch(() => undefined);
    if (byId) return byId;
    throw err;
  }
  const byId = computers.find((c) => c.id === target);
  if (byId) return byId;
  const named = computers.filter((c) => c.name === target);
  if (named.length === 1) return named[0]!;
  if (named.length) {
    die(
      `${target} names ${named.length} computers — use an id: ${named.map((c) => c.id).join(', ')}`,
    );
  }
  if (!computers.length) die(`no computer named ${target}; the account has no computers`);
  const have = computers.map((c) => `  ${c.id}  ${c.name}  ${c.status}`).join('\n');
  die(`no computer named ${target}. You have:\n${have}`);
}

// --- ssh -------------------------------------------------------------------

async function cmdSsh(target: string, session: string): Promise<number> {
  const c = await (await resolve(new Client(), target)).refresh();
  const vnc = c.vnc;
  if (!vnc?.terminalUrl) {
    if (c.os === 'windows') {
      die(`${c.name} is a Windows computer; terminals are Linux-only for now`);
    }
    if (c.status !== 'running' && c.status !== 'suspended') {
      die(`${c.name} is ${c.status || 'not running'} — start it, then retry`);
    }
    die(`${c.name} has no terminal endpoint (platform too old?)`);
  }
  let url = vnc.terminalUrl;
  if (session !== 'main') {
    url += `${url.includes('?') ? '&' : '?'}session=${encodeURIComponent(session)}`;
  }
  return interact(url);
}

/**
 * Pump the local terminal into the websocket and back, until the shell ends.
 *
 * Binary frames are the terminal's bytes in both directions; text frames are
 * control — resize out, exit in. The local TTY goes raw so every keystroke
 * (including Ctrl-C) belongs to the remote shell.
 *
 * Uses the global `WebSocket`, which is why this package requires Node 22 and
 * has no dependencies. A websocket library would be the SDK's only runtime
 * dependency, carried by every user of the library for the sake of one command.
 */
async function interact(url: string): Promise<number> {
  if (typeof WebSocket === 'undefined') {
    die('this Node has no global WebSocket — mandala ssh needs Node 22 or newer');
  }
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';

  const stdin = process.stdin;
  const stdout = process.stdout;
  let raw = false;
  let exitCode: number | undefined;

  const sendSize = () => {
    if (ws.readyState !== WebSocket.OPEN || !stdout.isTTY) return;
    try {
      ws.send(JSON.stringify({ type: 'resize', cols: stdout.columns, rows: stdout.rows }));
    } catch {
      // Racing a close is fine; the close is the news, not this.
    }
  };

  /**
   * The guest's bytes, written one at a time and only as fast as they land.
   *
   * `write()` answers false when the terminal's buffer is full, and dropping
   * that answer is how `cat` on a large file inside the guest turns into a
   * process holding the whole file in the stream's queue: the socket cannot be
   * paused, so nothing else pushes back. Chained through a promise rather than
   * awaited at the call site because the frames arrive in an event listener,
   * and the chain is what keeps them in order.
   */
  let queued: Promise<void> = Promise.resolve();
  const write = (chunk: Uint8Array) => {
    queued = queued.then(
      () =>
        new Promise<void>((done) => {
          if (stdout.write(chunk)) done();
          else stdout.once('drain', done);
        }),
    );
  };

  const onStdin = (chunk: Buffer) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
  };

  /**
   * Piped input ran out — tell the remote shell so, rather than nothing.
   *
   * `mandala ssh vm < script` otherwise hangs forever after the last line: the
   * PTY is still waiting for input nobody will ever type, and the only thing
   * that ends this session is the socket closing. Ctrl-D is what a terminal
   * sends at that point, and it is what makes the guest's shell exit and report
   * a code back through the exit frame.
   */
  const onStdinEnd = () => {
    if (ws.readyState === WebSocket.OPEN) ws.send(new Uint8Array([0x04]));
  };

  const cleanup = () => {
    stdin.off('data', onStdin);
    stdin.off('end', onStdinEnd);
    stdout.off('resize', sendSize);
    // Restoring the terminal is the one thing that MUST happen. Skipping it
    // leaves the user's shell in raw mode with no echo, which reads as a hung
    // machine rather than as a crashed command.
    if (raw && stdin.isTTY) stdin.setRawMode(false);
    stdin.pause();
  };

  try {
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener(
        'error',
        () =>
          reject(
            new Died(
              'could not reach the terminal. If this computer has been running since ' +
                'before its host learned the feature, stop it and start it again ' +
                '(a restart is not enough), then retry.',
            ),
          ),
        { once: true },
      );
    });

    if (stdin.isTTY) {
      stdin.setRawMode(true);
      raw = true;
    }
    stdin.resume();
    stdin.on('data', onStdin);
    stdin.on('end', onStdinEnd);
    stdout.on('resize', sendSize);
    sendSize();

    await new Promise<void>((resolve) => {
      ws.addEventListener('message', (ev) => {
        if (typeof ev.data === 'string') {
          try {
            const control = JSON.parse(ev.data);
            if (control?.type === 'exit') {
              // A code the frame did not carry as an integer must not read as
              // exit 0 — that is the difference between success and a shrug.
              // An integer or the string spelling of one both count: nothing
              // in-repo pins which the terminal server sends, and reading its
              // "0" as exit 1 would break `mandala ssh vm cmd && next`. What
              // stays refused is everything Number() shrugs into 0 — null,
              // '', booleans — and anything not an integer at all.
              const code =
                typeof control.code === 'number'
                  ? control.code
                  : typeof control.code === 'string' && /^-?\d+$/.test(control.code)
                    ? Number(control.code)
                    : Number.NaN;
              exitCode = Number.isInteger(code) ? code : 1;
              // The shell has ended, but the output's tail may still be in
              // flight behind this frame — resolving now would drop it. Close
              // instead and let `close` resolve once the queue has drained;
              // the timer is what keeps a server that lingers indefinitely
              // after announcing the exit from holding the terminal with it.
              try {
                ws.close();
              } catch {
                // Already closing; `close` still fires.
              }
              setTimeout(resolve, EXIT_DRAIN_MS).unref();
            }
          } catch {
            // Not control we understand. The stream is the news, not this frame.
          }
          return;
        }
        const bytes = new Uint8Array(ev.data as ArrayBuffer);
        if (bytes.byteLength > MAX_FRAME) {
          // Still dropped — a frame this size is not the terminal protocol and
          // writing it would be worse. But said out loud: spliced silently out
          // of the middle of a byte stream it reads as a working shell
          // producing corrupted output, which is the one shape of failure this
          // repo refuses everywhere else.
          process.stderr.write(
            `mandala: dropped a ${bytes.byteLength}-byte frame — not the terminal protocol\n`,
          );
          return;
        }
        write(bytes);
      });
      ws.addEventListener('close', () => resolve(), { once: true });
      ws.addEventListener('error', () => resolve(), { once: true });
    });
  } finally {
    // The tail of the output goes out before the terminal is handed back, or
    // the last screenful of a session lands after the shell prompt returns.
    await queued;
    cleanup();
    try {
      ws.close();
    } catch {
      // Already closed; that is the ordinary way out of the loop above.
    }
  }

  if (exitCode === undefined) {
    // The link dropped without the shell ending: the session is still alive
    // server-side, and saying so is what makes that a feature.
    process.stderr.write('mandala: detached — run the same command to reattach\n');
    return 0;
  }
  return exitCode;
}

// --- scp -------------------------------------------------------------------

/**
 * `<computer>:<path>` split apart, or `undefined` for a local path.
 *
 * scp's own rule: a colon marks the remote side unless a `/` comes before it,
 * so `./odd:name` stays a local file. Two Windows amendments, also scp's own:
 * a `\` before the colon reads as the path separator it is there, and a
 * single-letter head is a drive, not a computer — without that, an absolute
 * local path could not be spelled on either side of a copy from a Windows
 * host. (A computer actually named with one letter is unreachable from here;
 * every Windows local file would be, otherwise.)
 */
export function remoteSide(arg: string): { target: string; path: string } | undefined {
  const i = arg.indexOf(':');
  if (i <= 0) return undefined;
  const head = arg.slice(0, i);
  if (head.includes('/') || head.includes('\\')) return undefined;
  if (/^[A-Za-z]$/.test(head)) return undefined;
  return { target: head, path: arg.slice(i + 1) };
}

/**
 * Where a copy lands in the guest, given the destination that was typed.
 *
 * A trailing separator means a directory, which the files API has no concept
 * of — so the source's basename is appended here rather than writing a file
 * whose name ends in a separator and having the platform refuse it. Both
 * separators, because the guest may be Windows: `C:\\Users\\dev\\` is the
 * spelling somebody on that machine would type, and read as a filename it makes
 * `mandala scp notes.txt vm:C:\\Users\\dev\\` fail on a path the platform
 * cannot write.
 */
export function guestDestination(remotePath: string, source: string): string {
  const directory = remotePath.endsWith('/') || remotePath.endsWith('\\');
  return directory ? remotePath + basename(source) : remotePath;
}

async function cmdScp(srcArg: string, dstArg: string): Promise<number> {
  const src = remoteSide(srcArg);
  const dst = remoteSide(dstArg);
  if ((src === undefined) === (dst === undefined)) {
    die('exactly one side must be a computer, spelled <computer>:/path');
  }

  const client = new Client();

  if (src) {
    if (!src.path) die(`say which file: ${src.target}:/absolute/path`);
    const data = await (await resolve(client, src.target)).readFile(src.path);
    let local = dstArg;
    // A directory destination takes the source's own basename, like scp.
    const info = await stat(local).catch(() => undefined);
    if (info?.isDirectory()) local = join(local, basename(src.path));
    await writeFile(local, data);
    process.stderr.write(`${src.target}:${src.path} -> ${local} (${data.length} bytes)\n`);
    return 0;
  }

  const remote = dst!;
  if (!remote.path) die(`say where in the guest: ${remote.target}:/absolute/path`);
  const path = guestDestination(remote.path, srcArg);
  const data = await readFile(srcArg);
  const written = await (await resolve(client, remote.target)).writeFile(path, data);
  // What the platform said, or what was sent — labelled as which, since a
  // platform that does not report a count is not evidence that everything
  // landed.
  const size = written === undefined ? `${data.length} bytes sent` : `${written} bytes`;
  process.stderr.write(`${srcArg} -> ${remote.target}:${path} (${size})\n`);
  return 0;
}

// --- entry -----------------------------------------------------------------

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (!command || command === '-h' || command === '--help' || command === 'help') {
      process.stdout.write(USAGE);
      return command ? 0 : 2;
    }
    if (command === 'ssh') {
      let session = 'main';
      const positional: string[] = [];
      for (let i = 0; i < rest.length; i++) {
        const arg = rest[i]!;
        if (arg === '-s' || arg === '--session')
          session = rest[++i] ?? die('--session needs a name');
        else if (arg.startsWith('--session=')) session = arg.slice('--session='.length);
        else positional.push(arg);
      }
      const target = positional[0] ?? die('mandala ssh <computer>');
      if (positional.length > 1) {
        // `mandala ssh vm ls -la` is the ubiquitous ssh idiom, and this command
        // does not have it. Ignoring the tail would open an interactive shell
        // instead and look like it worked.
        die(`mandala ssh takes one computer and runs no command (got ${positional.length} args)`);
      }
      return await cmdSsh(target, session);
    }
    if (command === 'scp') {
      const [src, dst] = rest;
      if (!src || !dst) die('mandala scp <src> <dst>');
      return await cmdScp(src, dst);
    }
    die(`unknown command ${command}\n\n${USAGE}`);
  } catch (err) {
    // ValidationError and not TypeError: an SDK refusal is a sentence written
    // to be read by whoever typed the command, and printing it without a stack
    // is right. Every *other* TypeError is a bug in this file — reading a
    // property off an undefined — and printing that one the same way disguises
    // a crash as bad input, with the stack that would locate it thrown away.
    if (err instanceof Died || err instanceof MandalaError || err instanceof ValidationError) {
      process.stderr.write(`mandala: ${err.message}\n`);
      return 1;
    }
    if (err instanceof Error && 'code' in err) {
      process.stderr.write(`mandala: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

// Guarded so importing this module — which the tests do, for remoteSide — does
// not start a session. Compared through realpath and pathToFileURL rather than
// a hand-built `file://${argv[1]}`: Node resolves the main module through
// symlinks and the npm .bin shim is one, so the naive comparison made the
// installed command silently do nothing — and it also broke on any install
// path with characters a URL escapes.
const invokedDirectly = ((): boolean => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    // argv[1] that does not resolve on disk (an embedded runner, a deleted
    // file) is at any rate not this module being run directly.
    return false;
  }
})();
if (invokedDirectly) {
  // process.exit() discards whatever is still buffered in a piped stdout — the
  // tail of a session's output, silently. Writes are FIFO, so exiting from the
  // flush callback of an empty write means everything queued before it reached
  // the OS first. (Exiting via process.exitCode instead would flush too, but
  // waits on every open handle — undici's keep-alive sockets among them.)
  const exit = (code: number): void => {
    process.stdout.write('', () => process.exit(code));
  };
  main().then(exit, (err) => {
    process.stderr.write(`mandala: ${err instanceof Error ? err.message : String(err)}\n`, () =>
      exit(1),
    );
  });
}
