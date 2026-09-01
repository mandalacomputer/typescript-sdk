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

import { createReadStream, realpathSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import process from 'node:process';
import { Readable } from 'node:stream';
import { isatty, WriteStream } from 'node:tty';
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

/** A terminal websocket must either upgrade or fail within this window. */
const CONNECT_TIMEOUT_MS = 15_000;

/** File copies have no intrinsic duration; caller cancellation is the bound. */
const SCP_TRANSFER_TIMEOUT_MS = 0;

/**
 * The geometry the broker gives a PTY when the upgrade URL names none.
 *
 * Mirrored rather than left implicit so a terminal that cannot be measured is
 * told to the guest as the size it is going to get anyway, instead of as
 * nothing at all.
 */
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

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

/**
 * A guest path's final component, regardless of which OS the guest runs.
 *
 * A dot segment is not a name and is refused as one. The caller here uses this
 * to build a local destination — `join(destDir, name)` when the destination is
 * a directory, the way `scp` does — and `join('./out', '..')` is `.`, so
 * `mandala scp vm:/tmp/.. ./out/` wrote outside the directory that was named.
 * `pathId` already refuses both for URL segments, for the same reason and with
 * the same two spellings (OPL-4215).
 */
export function guestBasename(path: string): string {
  const parts = path.split(/[\\/]/).filter((part) => part.length > 0);
  const last = parts.at(-1) ?? '';
  return last === '.' || last === '..' ? '' : last;
}

/**
 * Pause local stdin when the websocket still has this many unsent bytes.
 *
 * Guest→stdout already waits on `write()` returning false. The other direction
 * has no such signal unless we watch `bufferedAmount` ourselves.
 */
export const STDIN_HIGH_WATER = 1 << 20;

/** Whether stdin should pause for the socket to catch up. */
export function stdinBackpressure(
  bufferedAmount: number,
  highWater = STDIN_HIGH_WATER,
): 'pause' | 'resume' {
  return bufferedAmount > highWater ? 'pause' : 'resume';
}

/** A terminal frame's wire size. Text is bounded in bytes, just like binary. */
export function terminalFrameByteLength(data: string | ArrayBuffer): number {
  return typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength;
}

/**
 * Extend the stdout chain while marking a possible rejection as handled now.
 * The original rejected promise is retained so finishInteraction can surface
 * it; the side catch only prevents an unhandledRejection before the socket ends.
 */
export function queueTerminalWrite(
  queued: Promise<void>,
  write: (done: () => void) => void,
): Promise<void> {
  const next = queued.then(() => new Promise<void>((done) => write(done)));
  void next.catch(() => {});
  return next;
}

/** Wait for both output streams before process.exit can discard either tail. */
export function flushOutput(
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
  done: () => void,
  timeoutMs = EXIT_DRAIN_MS,
): void {
  let pending = 2;
  const drained = () => {
    pending -= 1;
    if (pending === 0) done();
  };
  const flush = (stream: NodeJS.WritableStream) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      drained();
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
    stream.once?.('error', finish);
    try {
      stream.write('', finish);
    } catch {
      // There is nothing useful to do with an already-broken output stream,
      // but it must not keep the other stream (or process exit) waiting.
      finish();
    }
  };
  flush(stdout);
  flush(stderr);
}

/** Preserve diagnostics for a CLI bug that escaped the expected error path. */
export function unexpectedErrorText(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err);
}

/**
 * The descriptor to measure the local terminal on, or `undefined` if there is
 * no terminal on any of them.
 *
 * stdin first: it is the descriptor raw mode is set from, and its terminal is
 * the one SIGWINCH reports on. stdout is not the right answer on its own —
 * `mandala ssh dev | tee session.log` is still a session in whatever window the
 * user is sitting in, and sizing it from the pipe left the guest PTY at the
 * broker's 80x24 default for the whole session, with `vim`, `htop` and `less`
 * wrong all the way through (OPL-4264; OPL-4246 was the same defect in the
 * Python SDK). The other two are tried after it so a redirected stdin
 * (`mandala ssh dev < script`) still reports the window its output is drawn in.
 *
 * Descriptors rather than `process.stdin.isTTY`, because a descriptor is what
 * the measurement below has to name.
 */
export function terminalFd(isTerminal: (fd: number) => boolean = isatty): number | undefined {
  for (const fd of [0, 1, 2]) {
    try {
      if (isTerminal(fd)) return fd;
    } catch {
      // A descriptor isatty() will not answer for is not the terminal we want.
    }
  }
  return undefined;
}

/**
 * The process's own stream for a descriptor, when that stream is a terminal.
 *
 * Nothing to open for these: Node already holds a handle on their console, and
 * refreshes its geometry on SIGWINCH itself — from a listener installed when the
 * stream was built, so it has already run by the time ours does.
 */
function ownTerminal(fd: number): NodeJS.WriteStream | undefined {
  if (fd === 1 && process.stdout.isTTY) return process.stdout;
  if (fd === 2 && process.stderr.isTTY) return process.stderr;
  return undefined;
}

/**
 * Open a write handle on a descriptor purely to ask it for its window.
 *
 * `tty.ReadStream` — what `process.stdin` is when it is a terminal — has no
 * `columns`/`rows`; those live on `tty.WriteStream` alone, so measuring stdin
 * means building one on its descriptor. That is safe on the descriptor the
 * process is already reading: libuv reopens the tty by name for a stdio
 * descriptor rather than sharing the open file the reader holds, so this handle
 * gets its own, and closing it leaves stdin readable with raw mode intact.
 * Checked against a real pty rather than taken from the docs.
 *
 * Built and destroyed per measurement rather than kept alive: a live handle
 * would be one more thing to unref and tear down on every exit path, and a
 * resize is rare enough that reopening the tty for it costs nothing.
 */
function openedTerminal(fd: number): { columns?: number; rows?: number } | undefined {
  let out: WriteStream | undefined;
  try {
    out = new WriteStream(fd);
    return { columns: out.columns, rows: out.rows };
  } catch {
    return undefined;
  } finally {
    out?.destroy();
  }
}

/** The window a descriptor is showing, or `undefined` when nothing can say. */
function windowSize(fd: number): { columns?: number; rows?: number } | undefined {
  // The chosen descriptor first, then whichever output stream still speaks for
  // the same console. That tail is not redundant: a Windows console *input*
  // handle carries no write handle at all, and stdout is then the only thing
  // that can report the window — falling straight through to 80x24 there would
  // trade this fix for a regression on the platform that never had the bug.
  return ownTerminal(fd) ?? openedTerminal(fd) ?? ownTerminal(1) ?? ownTerminal(2);
}

/** A window dimension the guest can be told, or `undefined` for anything else. */
function dimension(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * The local terminal's geometry, measured on `fd`.
 *
 * Each half falls back on its own, because a handle that answers for one and
 * not the other is still worth half an answer. No `COLUMNS`/`LINES` override:
 * nothing in this command has ever consulted them — `process.stdout.columns` is
 * the ioctl and nothing else — and adding one here would be a new feature
 * riding along with a fix.
 */
export function terminalSize(
  fd: number | undefined,
  measure: (fd: number) => { columns?: number; rows?: number } | undefined = windowSize,
): { cols: number; rows: number } {
  const size = fd === undefined ? undefined : measure(fd);
  return {
    cols: dimension(size?.columns) ?? DEFAULT_COLS,
    rows: dimension(size?.rows) ?? DEFAULT_ROWS,
  };
}

/**
 * The upgrade URL for a terminal session: the endpoint, plus the two things the
 * broker can only learn before the PTY exists.
 *
 * `cols`/`rows` are the PTY's *initial* geometry. The broker defaults them to
 * 80x24 and honours a `resize` frame only afterwards, so a URL without them
 * draws the login prompt, the MOTD and any replayed scrollback 80 columns wide
 * however wide the window is (OPL-4264). A broker too old to read them falls
 * back to that same default, which is why they are sent rather than probed for.
 */
export function terminalSessionUrl(
  base: string,
  session: string,
  size?: { cols: number; rows: number },
): string {
  const params: string[] = [];
  if (session !== 'main') params.push(`session=${encodeURIComponent(session)}`);
  if (size) params.push(`cols=${size.cols}`, `rows=${size.rows}`);
  if (!params.length) return base;
  return `${base}${base.includes('?') ? '&' : '?'}${params.join('&')}`;
}

/**
 * Wait for the websocket handshake without letting a silent TCP peer hold the
 * command forever. A close before open is a failed handshake, even when the
 * implementation emits no separate error event for it.
 *
 * Exported only so the CLI's event-boundary behavior can be tested; this module
 * is not part of the package's library exports.
 */
export function waitForWebSocketOpen(ws: WebSocket, timeoutMs = CONNECT_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      ws.removeEventListener('open', onOpen);
      ws.removeEventListener('error', onError);
      ws.removeEventListener('close', onClose);
    };
    const finish = (fn: () => void) => {
      cleanup();
      fn();
    };
    const failure = () =>
      new Died(
        'could not reach the terminal. If this computer has been running since ' +
          'before its host learned the feature, stop it and start it again ' +
          '(a restart is not enough), then retry.',
      );
    const onOpen = () => finish(resolve);
    const onError = () => finish(() => reject(failure()));
    const onClose = () => finish(() => reject(failure()));
    const timer = setTimeout(
      () => finish(() => reject(new Died(`terminal connection timed out after ${timeoutMs}ms`))),
      timeoutMs,
    );
    ws.addEventListener('open', onOpen, { once: true });
    ws.addEventListener('error', onError, { once: true });
    ws.addEventListener('close', onClose, { once: true });
  });
}

/**
 * Drain terminal output, but always hand the TTY back and close the websocket.
 * The timeout covers a stdout stream that returned false and never emits
 * `drain`; the nested finally covers a write that throws or rejects.
 */
export async function finishInteraction(
  queued: Promise<void>,
  cleanup: () => void,
  close: () => void,
  timeoutMs = EXIT_DRAIN_MS,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      queued,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    try {
      cleanup();
    } finally {
      close();
    }
  }
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
  // Measured here rather than left to the first resize frame: the broker sizes
  // the PTY from the upgrade URL and everything it draws before that frame
  // lands — the login prompt, the MOTD, any replayed scrollback — is drawn at
  // whatever the URL said.
  const fd = terminalFd();
  const size = fd === undefined ? undefined : terminalSize(fd);
  return interact(terminalSessionUrl(vnc.terminalUrl, session, size));
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
  // The terminal this session is sized from, which is not necessarily the one
  // its output is written to: a piped stdout is still a session in a window.
  const ttyFd = terminalFd();
  let raw = false;
  let winch = false;
  let exitCode: number | undefined;
  let pump: ReturnType<typeof setInterval> | undefined;

  const sendSize = () => {
    if (ws.readyState !== WebSocket.OPEN || ttyFd === undefined) return;
    try {
      const { cols, rows } = terminalSize(ttyFd);
      ws.send(JSON.stringify({ type: 'resize', cols, rows }));
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
    queued = queueTerminalWrite(queued, (done) => {
      if (stdout.write(chunk)) done();
      else stdout.once('drain', done);
    });
  };

  const onStdin = (chunk: Buffer) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(chunk);
    if (stdinBackpressure(ws.bufferedAmount) === 'pause') {
      stdin.pause();
      pump ??= setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN || stdinBackpressure(ws.bufferedAmount) === 'resume') {
          if (pump) {
            clearInterval(pump);
            pump = undefined;
          }
          if (ws.readyState === WebSocket.OPEN) stdin.resume();
        }
      }, 16);
    }
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
    if (pump) {
      clearInterval(pump);
      pump = undefined;
    }
    stdin.off('data', onStdin);
    stdin.off('end', onStdinEnd);
    if (winch) {
      process.off('SIGWINCH', sendSize);
      winch = false;
    }
    // Restoring the terminal is the one thing that MUST happen. Skipping it
    // leaves the user's shell in raw mode with no echo, which reads as a hung
    // machine rather than as a crashed command.
    if (raw && stdin.isTTY) stdin.setRawMode(false);
    stdin.pause();
  };

  try {
    await waitForWebSocketOpen(ws);

    if (stdin.isTTY) {
      stdin.setRawMode(true);
      raw = true;
    }
    stdin.resume();
    stdin.on('data', onStdin);
    stdin.on('end', onStdinEnd);
    if (ttyFd !== undefined) {
      // Not `stdout.on('resize')`: Node emits that only on a tty WriteStream,
      // so a piped stdout never fired it and a session sized from stdin has
      // nothing there to listen to. SIGWINCH is what the terminal actually
      // sends, and it arrives whatever this process's stdout is.
      process.on('SIGWINCH', sendSize);
      winch = true;
      sendSize();
    }

    await new Promise<void>((resolve) => {
      ws.addEventListener('message', (ev) => {
        const byteLength = terminalFrameByteLength(ev.data as string | ArrayBuffer);
        if (byteLength > MAX_FRAME) {
          process.stderr.write(
            `mandala: dropped a ${byteLength}-byte frame — not the terminal protocol\n`,
          );
          return;
        }
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
        write(bytes);
      });
      ws.addEventListener('close', () => resolve(), { once: true });
      ws.addEventListener('error', () => resolve(), { once: true });
    });
  } finally {
    // The tail of the output goes out before the terminal is handed back, or
    // the last screenful of a session lands after the shell prompt returns.
    await finishInteraction(queued, cleanup, () => {
      try {
        ws.close();
      } catch {
        // Already closed; that is the ordinary way out of the loop above.
      }
    });
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

/** Format a successful upload count, refusing a short write reported as success. */
export function uploadSize(sent: number, written?: number): string {
  if (written !== undefined && written !== sent) {
    die(`upload was incomplete: sent ${sent} bytes but the guest reported ${written}`);
  }
  return written === undefined ? `${sent} bytes sent` : `${written} bytes`;
}

interface LocalWriter {
  write(
    buffer: Uint8Array,
    offset?: number,
    length?: number,
    position?: number | null,
  ): Promise<{ bytesWritten: number }>;
}

/** Persist a complete chunk even when the local filesystem accepts only part of a write. */
export async function writeFully(out: LocalWriter, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await out.write(bytes, offset, bytes.length - offset);
    if (bytesWritten <= 0) throw new Error('local file write made no progress');
    offset += bytesWritten;
  }
}

/**
 * Copy one guest file to a local path, however large it is.
 *
 * Paged and written chunk by chunk rather than read whole: a single read is
 * capped at what one request moves — 64 MiB — so `mandala scp vm:/big.bin .`
 * used to fail outright on exactly the files worth copying with a command
 * rather than a browser. Nothing is held in memory but the chunk in hand, which
 * is the other half of it: a 2 GB build output is not a Buffer anybody wants.
 *
 * A failure part-way leaves what arrived on disk, as scp and curl do. The bytes
 * that landed are the file's own first bytes and the message says what stopped,
 * which is more use than deleting the evidence.
 *
 * @returns how many bytes were written.
 */
export async function download(
  computer: Pick<Computer, 'readFileChunks'>,
  remotePath: string,
  local: string,
): Promise<number> {
  let out: Awaited<ReturnType<typeof open>> | undefined;
  let written = 0;
  try {
    for await (const chunk of computer.readFileChunks(remotePath, {
      timeoutMs: SCP_TRANSFER_TIMEOUT_MS,
    })) {
      // Do not truncate an existing destination until the remote read has
      // actually produced data. A source-side failure before the first chunk
      // must leave the local file alone.
      out ??= await open(local, 'w');
      // Sequential, and it is the paging helper that makes that safe: it
      // refuses an answer that does not start where it asked, so the chunks are
      // end to end or there are no chunks at all.
      await writeFully(out, chunk.bytes);
      written += chunk.bytes.length;
    }

    // No chunks is a successfully confirmed empty source. Only now is it safe
    // to create or truncate the destination.
    out ??= await open(local, 'w');
  } finally {
    await out?.close();
  }
  return written;
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
    const computer = await resolve(client, src.target);
    let local = dstArg;
    // A directory destination takes the source's own basename, like scp.
    const info = await stat(local).catch(() => undefined);
    if (info?.isDirectory()) {
      const name = guestBasename(src.path);
      if (!name) die(`say which file: ${src.target}:${src.path}`);
      local = join(local, name);
    }
    const size = await download(computer, src.path, local);
    process.stderr.write(`${src.target}:${src.path} -> ${local} (${size} bytes)\n`);
    return 0;
  }

  const remote = dst!;
  if (!remote.path) die(`say where in the guest: ${remote.target}:/absolute/path`);
  const path = guestDestination(remote.path, srcArg);
  const info = await stat(srcArg).catch(() => undefined);
  if (!info?.isFile()) die(`${srcArg} is not a file`);
  // Streamed rather than `readFile`'d: a guest-bound copy of a large file is
  // the same 2 GB the download path already refuses to hold as one Buffer.
  const body = Readable.toWeb(createReadStream(srcArg)) as ReadableStream<Uint8Array>;
  const written = await (await resolve(client, remote.target)).writeFile(path, body, {
    timeoutMs: SCP_TRANSFER_TIMEOUT_MS,
    contentLength: info.size,
  });
  // What the platform said, or what was sent — labelled as which, since a
  // platform that does not report a count is not evidence that everything
  // landed.
  const size = uploadSize(info.size, written);
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
      if (rest.some((arg) => arg === '-h' || arg === '--help')) {
        process.stdout.write(USAGE);
        return 0;
      }
      let session = 'main';
      const positional: string[] = [];
      for (let i = 0; i < rest.length; i++) {
        const arg = rest[i]!;
        if (arg === '-s' || arg === '--session')
          session = rest[++i] ?? die('--session needs a name');
        else if (arg.startsWith('--session=')) session = arg.slice('--session='.length);
        else positional.push(arg);
      }
      if (!session.trim()) die('--session needs a name');
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
      if (rest.some((arg) => arg === '-h' || arg === '--help')) {
        process.stdout.write(USAGE);
        return 0;
      }
      const [src, dst] = rest;
      if (!src || !dst || rest.length !== 2) die('mandala scp <src> <dst>');
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
    flushOutput(process.stdout, process.stderr, () => process.exit(code));
  };
  main().then(exit, (err) => {
    process.stderr.write(`mandala: ${unexpectedErrorText(err)}\n`);
    exit(1);
  });
}
