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
import { MandalaError } from './errors.js';
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
  const computers = await client.computers.list();
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

  const onStdin = (chunk: Buffer) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
  };

  const cleanup = () => {
    stdin.off('data', onStdin);
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
              exitCode =
                typeof control.code === 'number' && Number.isInteger(control.code)
                  ? control.code
                  : 1;
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
        if (bytes.byteLength > MAX_FRAME) return;
        stdout.write(bytes);
      });
      ws.addEventListener('close', () => resolve(), { once: true });
      ws.addEventListener('error', () => resolve(), { once: true });
    });
  } finally {
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
 * so `./odd:name` stays a local file.
 */
export function remoteSide(arg: string): { target: string; path: string } | undefined {
  const i = arg.indexOf(':');
  if (i <= 0) return undefined;
  const head = arg.slice(0, i);
  if (head.includes('/')) return undefined;
  return { target: head, path: arg.slice(i + 1) };
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
  // A trailing slash means a directory in the guest, which the files API has no
  // concept of — so the basename is appended here rather than writing a file
  // whose name ends in "/" and having the platform refuse it.
  const path = remote.path.endsWith('/') ? remote.path + basename(srcArg) : remote.path;
  const data = await readFile(srcArg);
  const written = await (await resolve(client, remote.target)).writeFile(path, data);
  process.stderr.write(`${srcArg} -> ${remote.target}:${path} (${written} bytes)\n`);
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
      return await cmdSsh(target, session);
    }
    if (command === 'scp') {
      const [src, dst] = rest;
      if (!src || !dst) die('mandala scp <src> <dst>');
      return await cmdScp(src, dst);
    }
    die(`unknown command ${command}\n\n${USAGE}`);
  } catch (err) {
    if (err instanceof Died || err instanceof MandalaError || err instanceof TypeError) {
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
