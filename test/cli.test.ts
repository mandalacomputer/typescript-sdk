/**
 * The `mandala` command.
 *
 * The pure parts are tested directly; the ssh loop is not, because it wants a
 * real PTY and a real websocket and a test that faked both would be testing the
 * fakes. What is here is where the mistakes actually live: which side of an scp
 * is the guest, and what the argument parser does with what it was handed.
 */

import { describe, expect, it } from 'vitest';
import { guestDestination, remoteSide, uploadSize } from '../src/cli.js';

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

  it('refuses an ssh carrying a command rather than silently dropping it', async () => {
    // `mandala ssh vm ls -la` is the ubiquitous ssh idiom and this command does
    // not have it. Ignoring the tail opened an interactive shell instead, which
    // looks like it worked.
    const { code, out } = await run(['ssh', 'demo', 'ls']);
    expect(code).toBe(1);
    expect(out).toContain('runs no command');
  });
});
