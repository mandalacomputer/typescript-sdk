/**
 * The `mandala` command.
 *
 * The pure parts are tested directly; the ssh loop is not, because it wants a
 * real PTY and a real websocket and a test that faked both would be testing the
 * fakes. What is here is where the mistakes actually live: which side of an scp
 * is the guest, and what the argument parser does with what it was handed.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  download,
  finishInteraction,
  flushOutput,
  guestBasename,
  guestDestination,
  queueTerminalWrite,
  remoteSide,
  STDIN_HIGH_WATER,
  stdinBackpressure,
  terminalFd,
  terminalFrameByteLength,
  terminalSessionUrl,
  terminalSize,
  unexpectedErrorText,
  uploadSize,
  waitForWebSocketOpen,
  writeFully,
} from '../src/cli.js';
import type { FileChunk } from '../src/index.js';
import { BASE, COMPUTER, FakeSocket, json, recorder } from './harness.js';

describe('terminal lifecycle', () => {
  it('rejects a websocket that closes before its handshake opens', async () => {
    const socket = new EventTarget() as WebSocket;
    const opening = waitForWebSocketOpen(socket, 100);
    socket.dispatchEvent(new Event('close'));
    await expect(opening).rejects.toThrow(/could not reach the terminal/);
  });

  it('times out a websocket handshake that never answers', async () => {
    vi.useFakeTimers();
    try {
      const socket = new EventTarget() as WebSocket;
      const opening = expect(waitForWebSocketOpen(socket, 10)).rejects.toThrow(
        /timed out after 10ms/,
      );
      await vi.advanceTimersByTimeAsync(10);
      await opening;
    } finally {
      vi.useRealTimers();
    }
  });

  it('restores the terminal and closes the socket when an output write rejects', async () => {
    const calls: string[] = [];
    await expect(
      finishInteraction(
        () => Promise.reject(new Error('stdout failed')),
        () => calls.push('cleanup'),
        () => calls.push('close'),
      ),
    ).rejects.toThrow(/stdout failed/);
    expect(calls).toEqual(['cleanup', 'close']);
  });

  it('restores the terminal when stdout never drains', async () => {
    vi.useFakeTimers();
    try {
      const calls: string[] = [];
      const finishing = finishInteraction(
        () => new Promise<void>(() => {}),
        () => calls.push('cleanup'),
        () => calls.push('close'),
        10,
      );
      await vi.advanceTimersByTimeAsync(10);
      await finishing;
      expect(calls).toEqual(['cleanup', 'close']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a queued write rejection for cleanup without leaving it unobserved', async () => {
    const queued = queueTerminalWrite(Promise.resolve(), () => {
      throw new Error('EPIPE');
    });
    await expect(queued).rejects.toThrow(/EPIPE/);
  });

  it('waits for both stdout and stderr before exiting', () => {
    const callbacks: (() => void)[] = [];
    const stream = {
      write(_chunk: string, callback: () => void) {
        callbacks.push(callback);
        return false;
      },
    } as unknown as NodeJS.WritableStream;
    let exits = 0;
    flushOutput(stream, stream, () => {
      exits += 1;
    });
    expect(callbacks).toHaveLength(2);
    callbacks[0]!();
    expect(exits).toBe(0);
    callbacks[1]!();
    expect(exits).toBe(1);
  });

  it('still finishes flushing when a broken stream throws from write', () => {
    const broken = {
      write() {
        throw new Error('EPIPE');
      },
    } as unknown as NodeJS.WritableStream;
    let exits = 0;
    flushOutput(broken, broken, () => {
      exits += 1;
    });
    expect(exits).toBe(1);
  });

  it('gives up flushing when a write callback never fires', async () => {
    vi.useFakeTimers();
    try {
      const hung = {
        write() {
          return false;
        },
        once() {},
      } as unknown as NodeJS.WritableStream;
      let exits = 0;
      flushOutput(
        hung,
        hung,
        () => {
          exits += 1;
        },
        10,
      );
      expect(exits).toBe(0);
      await vi.advanceTimersByTimeAsync(10);
      expect(exits).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('pauses stdin once the websocket buffer is over the water mark', () => {
    expect(stdinBackpressure(STDIN_HIGH_WATER)).toBe('resume');
    expect(stdinBackpressure(STDIN_HIGH_WATER + 1)).toBe('pause');
  });

  it('keeps the stack for an unexpected top-level failure', () => {
    const err = new Error('unexpected');
    expect(unexpectedErrorText(err)).toBe(err.stack);
    expect(unexpectedErrorText('unexpected')).toBe('unexpected');
  });
  it('waits for a write queued after the drain began, not just the chain it was handed', async () => {
    // The value of `queued` was snapshotted at the call, and the socket is not
    // closed until close() runs AFTER the await — so a frame landing in between
    // chained onto a NEW promise nobody was holding, and its bytes were written
    // once cleanup() had already taken the terminal out of raw mode.
    const order: string[] = [];
    const pending: (() => void)[] = [];
    let queued: Promise<void> = Promise.resolve();
    const write = (label: string) => {
      queued = queueTerminalWrite(queued, (done) => {
        pending.push(() => {
          order.push(label);
          done();
        });
      });
    };

    write('first');
    const finishing = finishInteraction(
      () => queued,
      () => order.push('cleanup'),
      () => order.push('close'),
      1_000,
    );
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    // The late frame, queued behind a write that has not drained yet.
    write('late');
    pending.shift()!();
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending.shift()!();
    await finishing;
    expect(order).toEqual(['first', 'late', 'cleanup', 'close']);
  });
});

describe('terminal frames', () => {
  it('measures text and binary frames by their wire bytes', () => {
    expect(terminalFrameByteLength('abc')).toBe(3);
    expect(terminalFrameByteLength('🚀')).toBe(4);
    expect(terminalFrameByteLength(new ArrayBuffer(7))).toBe(7);
  });
});

describe('terminal geometry', () => {
  const ttys = (fds: number[]) => (fd: number) => fds.includes(fd);

  it('measures the terminal on stdin, not on a piped stdout', () => {
    // `mandala ssh dev | tee session.log` — stdin is the window, stdout a pipe.
    expect(terminalFd(ttys([0, 2]))).toBe(0);
  });

  it('falls back past a redirected stdin to the window the output is drawn in', () => {
    expect(terminalFd(ttys([1, 2]))).toBe(1);
    expect(terminalFd(ttys([2]))).toBe(2);
  });

  it('finds no terminal when none of the three is one', () => {
    expect(terminalFd(ttys([]))).toBeUndefined();
  });

  it('keeps looking past a descriptor isatty refuses to answer for', () => {
    const refuses = (fd: number) => {
      if (fd < 2) throw new Error('bad file descriptor');
      return true;
    };
    expect(terminalFd(refuses)).toBe(2);
  });

  it('reads the geometry off the descriptor it was given', () => {
    const sizes: Record<number, { columns: number; rows: number }> = {
      0: { columns: 203, rows: 51 },
      1: { columns: 80, rows: 24 },
    };
    expect(terminalSize(0, (fd) => sizes[fd])).toEqual({ cols: 203, rows: 51 });
  });

  it('falls back to the broker default when there is no terminal to measure', () => {
    expect(terminalSize(undefined, () => ({ columns: 203, rows: 51 }))).toEqual({
      cols: 80,
      rows: 24,
    });
  });

  it('falls back per half, so a partial answer is still half an answer', () => {
    expect(terminalSize(0, () => undefined)).toEqual({ cols: 80, rows: 24 });
    expect(terminalSize(0, () => ({ columns: 203 }))).toEqual({ cols: 203, rows: 24 });
    // Nothing the guest could use as a width: zero, a fraction, a missing ioctl
    // reported as NaN. The default is a size; these are not.
    expect(terminalSize(0, () => ({ columns: 0, rows: 51 }))).toEqual({ cols: 80, rows: 51 });
    expect(terminalSize(0, () => ({ columns: 100.5, rows: Number.NaN }))).toEqual({
      cols: 80,
      rows: 24,
    });
  });
});

describe('terminalSessionUrl', () => {
  const base = 'wss://host/api/v1/computers/c1/terminal';

  it('names nothing when the session is the default and there is no terminal', () => {
    expect(terminalSessionUrl(base, 'main')).toBe(base);
  });

  it('carries the initial geometry, which the broker cannot learn any later way', () => {
    expect(terminalSessionUrl(base, 'main', { cols: 203, rows: 51 })).toBe(
      `${base}?cols=203&rows=51`,
    );
  });

  it('joins onto an endpoint that already carries a query', () => {
    expect(terminalSessionUrl(`${base}?token=abc`, 'build', { cols: 203, rows: 51 })).toBe(
      `${base}?token=abc&session=build&cols=203&rows=51`,
    );
  });

  it('escapes a session name that would otherwise be two parameters', () => {
    expect(terminalSessionUrl(base, 'a&b=c')).toBe(`${base}?session=a%26b%3Dc`);
  });
});

describe('remoteSide', () => {
  it('reads <computer>:/path as the guest side', () => {
    expect(remoteSide('demo:/home/user/out.txt')).toEqual({
      target: 'demo',
      path: '/home/user/out.txt',
    });
  });

  it('leaves a local path with a colon in it alone', () => {
    // scp's own rule: a colon marks the remote side unless a `/` comes before
    // it, so ./odd:name stays a local file.
    expect(remoteSide('./odd:name')).toBeUndefined();
    expect(remoteSide('/abs/odd:name')).toBeUndefined();
    expect(remoteSide('plain.txt')).toBeUndefined();
  });

  it('does not read a leading colon as a computer with no name', () => {
    expect(remoteSide(':/path')).toBeUndefined();
  });

  it('keeps a colon inside the guest path', () => {
    expect(remoteSide('demo:/var/log/a:b')).toEqual({ target: 'demo', path: '/var/log/a:b' });
  });

  it('reads a computer with no path, so the caller can be told to give one', () => {
    expect(remoteSide('demo:')).toEqual({ target: 'demo', path: '' });
  });

  it('reads a Windows drive letter as the local side, not a computer named C', () => {
    // Without this, an absolute local path could not be spelled on either side
    // of a copy from a Windows host: C:\out.txt has no '/' before its colon.
    expect(remoteSide('C:\\out.txt')).toBeUndefined();
    expect(remoteSide('c:/temp/out.txt')).toBeUndefined();
  });

  it('reads a backslash before the colon as the path separator it is', () => {
    // The Windows spelling of ./odd:name must stay a local file too.
    expect(remoteSide('.\\odd:name')).toBeUndefined();
    expect(remoteSide('C:\\dir\\odd:name')).toBeUndefined();
  });

  it('still reads a Windows guest path on a named computer as remote', () => {
    // The exemption is for the local side only; vm-1:C:\out.txt names a file
    // on a Windows guest and must keep working.
    expect(remoteSide('vm-1:C:\\out.txt')).toEqual({ target: 'vm-1', path: 'C:\\out.txt' });
  });
});

describe('guestDestination', () => {
  it('takes a guest basename using either path separator', () => {
    expect(guestBasename('/home/dev/notes.txt')).toBe('notes.txt');
    expect(guestBasename('C:\\Users\\dev\\notes.txt')).toBe('notes.txt');
  });

  it('does not treat a trailing separator as an empty name', () => {
    expect(guestBasename('/tmp/')).toBe('tmp');
    expect(guestBasename('C:\\Users\\dev\\')).toBe('dev');
  });

  it('refuses a dot segment, which is not a name (OPL-4215)', () => {
    // The caller builds a LOCAL destination out of this — `join(destDir, name)`
    // when the destination is a directory, the way scp does — and
    // `join('./out', '..')` is the parent. `mandala scp vm:/tmp/.. ./out/`
    // therefore wrote outside the directory that was named. `pathId` already
    // refuses both spellings for URL segments, for the same reason.
    expect(guestBasename('/tmp/..')).toBe('');
    expect(guestBasename('/tmp/.')).toBe('');
    expect(guestBasename('..')).toBe('');
    expect(guestBasename('C:\\Users\\dev\\..')).toBe('');
    // A name that merely CONTAINS dots is a name.
    expect(guestBasename('/tmp/..notes')).toBe('..notes');
    expect(guestBasename('/tmp/a.b')).toBe('a.b');
  });

  it('appends the source basename to a directory, on either separator', () => {
    // A Windows guest is spelled with backslashes, and read as a filename that
    // destination is a path the platform cannot write.
    expect(guestDestination('/tmp/', 'local/notes.txt')).toBe('/tmp/notes.txt');
    expect(guestDestination('C:\\Users\\dev\\', 'local/notes.txt')).toBe(
      'C:\\Users\\dev\\notes.txt',
    );
  });

  it('leaves a destination that names a file alone', () => {
    expect(guestDestination('/tmp/other.txt', 'notes.txt')).toBe('/tmp/other.txt');
    expect(guestDestination('C:\\Users\\dev\\other.txt', 'notes.txt')).toBe(
      'C:\\Users\\dev\\other.txt',
    );
  });
});

describe('uploadSize', () => {
  it('refuses a short write reported as success', () => {
    expect(() => uploadSize(10, 9)).toThrow(/incomplete/);
    expect(uploadSize(10, 10)).toBe('10 bytes');
    expect(uploadSize(10)).toBe('10 bytes sent');
  });
});

describe('argument handling', () => {
  const run = async (argv: string[]) => {
    const { main } = await import('../src/cli.js');
    const written: string[] = [];
    const realOut = process.stdout.write.bind(process.stdout);
    const realErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((s: string) => {
      written.push(String(s));
      return true;
    }) as never;
    process.stderr.write = ((s: string) => {
      written.push(String(s));
      return true;
    }) as never;
    try {
      return { code: await main(argv), out: written.join('') };
    } finally {
      process.stdout.write = realOut;
      process.stderr.write = realErr;
    }
  };

  it('prints usage and fails when given nothing', async () => {
    const { code, out } = await run([]);
    expect(code).toBe(2);
    expect(out).toContain('mandala ssh');
    expect(out).toContain('mandala scp');
  });

  it('prints usage and succeeds when asked for help', async () => {
    expect((await run(['--help'])).code).toBe(0);
    expect((await run(['ssh', '--help'])).code).toBe(0);
    expect((await run(['ssh', '-h'])).code).toBe(0);
    expect((await run(['scp', '--help'])).code).toBe(0);
    expect((await run(['scp', '-h'])).code).toBe(0);
  });

  it('names an unknown command rather than guessing', async () => {
    const { code, out } = await run(['sync', 'a', 'b']);
    expect(code).toBe(1);
    expect(out).toContain('unknown command sync');
  });

  it('refuses an scp with no guest side, and one with two', async () => {
    for (const args of [
      ['scp', 'a.txt', 'b.txt'],
      ['scp', 'demo:/a', 'other:/b'],
    ]) {
      const { code, out } = await run(args);
      expect(code).toBe(1);
      expect(out).toContain('exactly one side must be a computer');
    }
  });

  it('refuses an scp missing an operand', async () => {
    const { code, out } = await run(['scp', 'demo:/a']);
    expect(code).toBe(1);
    expect(out).toContain('mandala scp <src> <dst>');
  });

  it('refuses extra scp operands instead of dropping them', async () => {
    const { code, out } = await run(['scp', 'a.txt', 'demo:/a', 'ignored.txt']);
    expect(code).toBe(1);
    expect(out).toContain('mandala scp <src> <dst>');
  });

  it('refuses an ssh with no computer', async () => {
    const { code, out } = await run(['ssh']);
    expect(code).toBe(1);
    expect(out).toContain('mandala ssh <computer>');
  });

  it('refuses --session with nothing after it', async () => {
    const { code, out } = await run(['ssh', 'demo', '--session']);
    expect(code).toBe(1);
    expect(out).toContain('--session needs a name');
  });

  it('refuses an empty equals-form session name', async () => {
    const { code, out } = await run(['ssh', 'demo', '--session=']);
    expect(code).toBe(1);
    expect(out).toContain('--session needs a name');
  });

  it('keeps the stack of an internal fault, which every DOMException carries a code for', async () => {
    // The catch tested `'code' in err`, written for a Node SystemError. Every
    // DOMException carries a NUMERIC legacy `code` on its prototype, so it took
    // that branch too and printed as a bare one-liner under a comment saying a
    // non-SDK fault deserves its stack. This is the concrete instance: a
    // malformed terminal URL makes `new WebSocket(url)` throw code 12, and the
    // user saw `mandala: hash` with nothing to locate it.
    const computer = { ...COMPUTER, vnc: { ...COMPUTER.vnc, terminal_url: 'ws://host/t#frag' } };
    const savedKey = process.env.MANDALA_API_KEY;
    const savedBase = process.env.MANDALA_BASE_URL;
    const savedFetch = globalThis.fetch;
    process.env.MANDALA_API_KEY = 'com_test';
    process.env.MANDALA_BASE_URL = BASE;
    globalThis.fetch = recorder((call) =>
      json(call.path === '/computers' ? [computer] : computer),
    ).fetch;
    try {
      const thrown = await run(['ssh', 'demo']).catch((e) => e);
      expect(thrown).toBeInstanceOf(DOMException);
      expect(typeof (thrown as DOMException).code).toBe('number');
    } finally {
      globalThis.fetch = savedFetch;
      if (savedKey === undefined) delete process.env.MANDALA_API_KEY;
      else process.env.MANDALA_API_KEY = savedKey;
      if (savedBase === undefined) delete process.env.MANDALA_BASE_URL;
      else process.env.MANDALA_BASE_URL = savedBase;
    }
  });

  it('refuses an ssh carrying a command rather than silently dropping it', async () => {
    // `mandala ssh vm ls -la` is the ubiquitous ssh idiom and this command does
    // not have it. Ignoring the tail opened an interactive shell instead, which
    // looks like it worked.
    const { code, out } = await run(['ssh', 'demo', 'ls']);
    expect(code).toBe(1);
    expect(out).toContain('runs no command');
  });
});

/**
 * The ssh loop, driven end to end against a fake socket and a fake platform.
 *
 * Worth the setup for one thing the pure parts cannot show: what `mandala ssh`
 * RETURNS, which is the number a shell reads as success or failure.
 */
describe('the exit code a session reports', () => {
  const sshWith = async (frame: unknown): Promise<number> => {
    const savedKey = process.env.MANDALA_API_KEY;
    const savedBase = process.env.MANDALA_BASE_URL;
    const savedFetch = globalThis.fetch;
    const savedWS = globalThis.WebSocket;
    process.env.MANDALA_API_KEY = 'com_test';
    process.env.MANDALA_BASE_URL = BASE;
    globalThis.fetch = recorder((call) =>
      json(call.path === '/computers' ? [COMPUTER] : COMPUTER),
    ).fetch;
    globalThis.WebSocket = class extends FakeSocket {
      binaryType = 'blob';
      constructor(url: string) {
        super(url);
        // On a microtask, not in the constructor: the loop registers its
        // listeners after `new WebSocket(...)` returns, and a socket that
        // opened synchronously would fire into nothing.
        queueMicrotask(() => {
          this.emitOpen();
          // A tick later than the open: the message listener is registered
          // only once waitForWebSocketOpen has resolved, so a frame sent in the
          // same turn would be delivered to nobody.
          setTimeout(() => this.sendRaw(JSON.stringify(frame)), 0);
        });
      }
    } as unknown as typeof WebSocket;
    try {
      const { main } = await import('../src/cli.js');
      return await main(['ssh', 'demo']);
    } finally {
      globalThis.WebSocket = savedWS;
      globalThis.fetch = savedFetch;
      if (savedKey === undefined) delete process.env.MANDALA_API_KEY;
      else process.env.MANDALA_API_KEY = savedKey;
      if (savedBase === undefined) delete process.env.MANDALA_BASE_URL;
      else process.env.MANDALA_BASE_URL = savedBase;
    }
  };

  it('passes an ordinary code through', async () => {
    expect(await sshWith({ type: 'exit', code: 0 })).toBe(0);
    expect(await sshWith({ type: 'exit', code: 3 })).toBe(3);
    expect(await sshWith({ type: 'exit', code: '7' })).toBe(7);
  });

  it('refuses a code process.exit cannot carry, rather than letting it wrap', async () => {
    // process.exit takes the low byte, so 256 arrived at the shell as 0 — a
    // guest failure reported as the success `mandala ssh vm cmd && next` acts
    // on. -1 wrapping to 255 is at least still a failure; this one inverts.
    expect(await sshWith({ type: 'exit', code: 256 })).toBe(1);
    expect(await sshWith({ type: 'exit', code: -1 })).toBe(1);
  });
});

describe('scp upload', () => {
  const uploadWith = async (
    local: string,
    respond: Parameters<typeof recorder>[0],
  ): Promise<ReturnType<typeof recorder>> => {
    const rec = recorder(respond);
    const savedKey = process.env.MANDALA_API_KEY;
    const savedBase = process.env.MANDALA_BASE_URL;
    const savedFetch = globalThis.fetch;
    process.env.MANDALA_API_KEY = 'com_test';
    process.env.MANDALA_BASE_URL = BASE;
    globalThis.fetch = rec.fetch;
    const realErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as never;
    try {
      const { main } = await import('../src/cli.js');
      expect(await main(['scp', local, 'demo:/tmp/out.bin'])).toBe(0);
      return rec;
    } finally {
      process.stderr.write = realErr;
      globalThis.fetch = savedFetch;
      if (savedKey === undefined) delete process.env.MANDALA_API_KEY;
      else process.env.MANDALA_API_KEY = savedKey;
      if (savedBase === undefined) delete process.env.MANDALA_BASE_URL;
      else process.env.MANDALA_BASE_URL = savedBase;
    }
  };

  it('declares the length of the file it opened, not one measured before the resolve', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mandala-scp-'));
    try {
      const local = join(dir, 'build.log');
      await writeFile(local, 'x'.repeat(10));
      // The file grows while the computer is being resolved — a log still being
      // written, a build output not finished. Measured before that round trip
      // and streamed after it, the declared count described a file that had
      // already moved on, and undici refuses a body that disagrees with its own
      // Content-Length with a bare `fetch failed`. The platform is no more
      // forgiving: it treats the declared number as a promise.
      const rec = await uploadWith(local, async (call) => {
        if (call.path === '/computers') {
          await writeFile(local, 'x'.repeat(25));
          return json([COMPUTER]);
        }
        return json({ bytes: 25 });
      });
      const put = rec.calls.find((c) => c.method === 'PUT')!;
      expect(put.raw).toHaveLength(25);
      expect(put.headers['Content-Length']).toBe('25');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('scp download', () => {
  /** A computer whose file arrives in as many windows as the platform sends. */
  const paging = (windows: Uint8Array[]) => {
    let offset = 0;
    return {
      async *readFileChunks(): AsyncGenerator<FileChunk> {
        for (const bytes of windows) {
          yield { bytes, offset, total: 99, partial: true, seekable: true };
          offset += bytes.length;
        }
      },
    };
  };

  const inTempDir = async (body: (dir: string) => Promise<void>): Promise<void> => {
    const dir = await mkdtemp(join(tmpdir(), 'mandala-scp-'));
    try {
      await body(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  it('writes every window end to end, so a paged file lands whole', async () => {
    // The copy a single read could not make: over the ceiling, so it arrives in
    // windows, and nothing but the window in hand is ever held.
    await inTempDir(async (dir) => {
      const local = join(dir, 'big.bin');
      const windows = [Uint8Array.from([1, 2, 3]), Uint8Array.from([4, 5]), Uint8Array.from([6])];
      const written = await download(paging(windows), '/tmp/big.bin', local);
      expect(written).toBe(6);
      expect(new Uint8Array(await readFile(local))).toEqual(Uint8Array.from([1, 2, 3, 4, 5, 6]));
    });
  });

  it('leaves what arrived on disk when the transfer stops part-way', async () => {
    // scp's and curl's own behaviour: the bytes that landed are the file's own
    // first bytes, and the message says what stopped. Deleting them would throw
    // away the only evidence of how far it got.
    await inTempDir(async (dir) => {
      const local = join(dir, 'part.bin');
      const computer = {
        async *readFileChunks(): AsyncGenerator<FileChunk> {
          yield {
            bytes: Uint8Array.from([1, 2, 3]),
            offset: 0,
            total: 99,
            partial: true,
            seekable: true,
          };
          throw new Error('the guest stopped answering');
        },
      };
      await expect(download(computer, '/tmp/part.bin', local)).rejects.toThrow(/stopped answering/);
      expect(new Uint8Array(await readFile(local))).toEqual(Uint8Array.from([1, 2, 3]));
    });
  });

  it('preserves an existing destination when the remote read fails before its first chunk', async () => {
    await inTempDir(async (dir) => {
      const local = join(dir, 'existing.bin');
      const original = Uint8Array.from([9, 8, 7]);
      await writeFile(local, original);
      const computer = {
        async *readFileChunks(): AsyncGenerator<FileChunk> {
          yield* [];
          throw new Error('the guest file does not exist');
        },
      };

      await expect(download(computer, '/tmp/missing.bin', local)).rejects.toThrow(/does not exist/);
      expect(new Uint8Array(await readFile(local))).toEqual(original);
    });
  });

  it('retries an unwritten suffix when a local write is short', async () => {
    const persisted: number[] = [];
    const calls: Array<{ offset: number; length: number }> = [];
    const out = {
      async write(buffer: Uint8Array, offset = 0, length = buffer.length - offset) {
        calls.push({ offset, length });
        const bytesWritten = Math.min(2, length);
        persisted.push(...buffer.subarray(offset, offset + bytesWritten));
        return { bytesWritten };
      },
    };

    await writeFully(out, Uint8Array.from([1, 2, 3, 4, 5]));

    expect(persisted).toEqual([1, 2, 3, 4, 5]);
    expect(calls).toEqual([
      { offset: 0, length: 5 },
      { offset: 2, length: 3 },
      { offset: 4, length: 1 },
    ]);
  });

  it('writes an empty file for a file with nothing in it', async () => {
    // An empty file pages to no windows at all, and the copy still has to
    // produce something: `scp vm:/empty .` that leaves no file is a copy that
    // silently did not happen.
    await inTempDir(async (dir) => {
      const local = join(dir, 'empty.bin');
      await writeFile(local, 'not empty');
      expect(await download(paging([]), '/tmp/empty.bin', local)).toBe(0);
      expect(await readFile(local)).toHaveLength(0);
    });
  });
});
