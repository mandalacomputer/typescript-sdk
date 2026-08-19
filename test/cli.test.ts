/**
 * The `mandala` command.
 *
 * The pure parts are tested directly; the ssh loop is not, because it wants a
 * real PTY and a real websocket and a test that faked both would be testing the
 * fakes. What is here is where the mistakes actually live: which side of an scp
 * is the guest, and what the argument parser does with what it was handed.
 */

import { describe, expect, it } from 'vitest';
import { remoteSide } from '../src/cli.js';

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
});
