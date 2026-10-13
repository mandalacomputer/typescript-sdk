/** `mandala computers urls`: a computer's public URLs from the command line (platform OPL-3753). */

import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { completion } from '../src/cli-completion.js';
import { manifest } from '../src/cli-manifest.js';
import { help } from '../src/cli-options.js';
import type { CliIO } from '../src/cli-runtime.js';
import { Client } from '../src/index.js';
import {
  anyRoute,
  BASE,
  PUBLIC_URL,
  PUBLIC_URL_LIST,
  type Responder,
  recorder,
} from './harness.js';

function harness(respond: Responder = anyRoute) {
  const rec = recorder(respond);
  const stdout: Uint8Array[] = [];
  const stderr: Uint8Array[] = [];
  const io: Partial<CliIO> = {
    stdin: Object.assign(Readable.from([]), { isTTY: true }),
    stdout: {
      write: ((s: string | Uint8Array) => {
        stdout.push(Buffer.from(s));
        return true;
      }) as NodeJS.WritableStream['write'],
    },
    stderr: {
      write: ((s: string | Uint8Array) => {
        stderr.push(Buffer.from(s));
        return true;
      }) as NodeJS.WritableStream['write'],
    },
    env: { MANDALA_API_KEY: 'com_cli_test' },
    createClient: () => new Client({ apiKey: 'com_cli_test', baseUrl: BASE, fetch: rec.fetch }),
  };
  return {
    rec,
    async run(args: string[]) {
      const code = await main([...args, '--json'], io);
      const out = Buffer.concat(stdout).toString();
      return { code, frame: out.trim() ? JSON.parse(out) : undefined };
    },
  };
}

describe('computers urls', () => {
  it('lists a computer’s URLs, with whether they answer and the limit', async () => {
    const h = harness();
    const result = await h.run(['computers', 'urls', 'list', 'vm-1']);
    expect(result.code).toBe(0);
    expect(h.rec.routes()).toEqual([
      ['GET', 'computers'],
      ['GET', 'computers/vm-1/public-urls'],
    ]);
    expect(result.frame.data).toEqual(PUBLIC_URL_LIST);
  });

  it('makes one with every flag, sending exactly those fields', async () => {
    const h = harness();
    const result = await h.run([
      'computers',
      'urls',
      'create',
      'vm-1',
      '--port',
      '3000',
      '--label',
      'cool-thing',
      '--access',
      'private',
    ]);
    expect(result.code).toBe(0);
    expect(h.rec.last().method).toBe('POST');
    expect(h.rec.last().path).toBe('/computers/vm-1/public-urls');
    expect(h.rec.last().body).toEqual({ port: 3000, label: 'cool-thing', access: 'private' });
    expect(result.frame.data).toEqual(PUBLIC_URL);
  });

  it.each([
    [['--port', '22'], /belongs to the computer/],
    [['--port', '70000'], /1 to 65535/],
    [['--port', '3000', '--label', 'a_b'], /letters, digits and hyphens/],
  ])('refuses %j before contacting anything', async (flags, says) => {
    const h = harness();
    const result = await h.run(['computers', 'urls', 'create', 'vm-1', ...flags]);
    expect(result.code).not.toBe(0);
    expect(result.frame.error.message).toMatch(says);
    expect(h.rec.calls).toHaveLength(0);
  });

  it('refuses a create without --port, and an --access outside its choices', async () => {
    for (const flags of [[], ['--port', '3000', '--access', 'team']]) {
      const h = harness();
      expect((await h.run(['computers', 'urls', 'create', 'vm-1', ...flags])).code).not.toBe(0);
      expect(h.rec.calls).toHaveLength(0);
    }
  });

  it.each([
    ['its label', 'cool-thing'],
    ['its hostname', 'cool-thing.mandala.dev'],
    ['its address', 'https://cool-thing.mandala.dev/'],
    ['its address, in capitals', 'HTTPS://Cool-Thing.mandala.dev'],
  ])('finds the URL to change by %s', async (_what, ref) => {
    const h = harness();
    const result = await h.run(['computers', 'urls', 'update', 'vm-1', ref, '--port', '8000']);
    expect(result.code).toBe(0);
    expect(h.rec.routes()).toEqual([
      ['GET', 'computers'],
      ['GET', 'computers/vm-1/public-urls'],
      ['PATCH', 'computers/vm-1/public-urls/pu-0123456789abcdef'],
    ]);
    expect(h.rec.last().body).toEqual({ port: 8000 });
  });

  it('uses an id as given, without listing', async () => {
    const h = harness();
    const result = await h.run([
      'computers',
      'urls',
      'update',
      'vm-1',
      'pu-0123456789abcdef',
      '--access',
      'private',
    ]);
    expect(result.code).toBe(0);
    expect(h.rec.routes()).toEqual([
      ['GET', 'computers'],
      ['PATCH', 'computers/vm-1/public-urls/pu-0123456789abcdef'],
    ]);
    expect(h.rec.last().body).toEqual({ access: 'private' });
  });

  it('refuses an update that changes nothing, before contacting anything', async () => {
    const h = harness();
    const result = await h.run(['computers', 'urls', 'update', 'vm-1', 'cool-thing']);
    expect(result.code).not.toBe(0);
    expect(result.frame.error.message).toMatch(/nothing to update/);
    expect(h.rec.calls).toHaveLength(0);
  });

  it('removes one, and says so', async () => {
    const h = harness();
    const result = await h.run(['computers', 'urls', 'rm', 'vm-1', 'cool-thing']);
    expect(result.code).toBe(0);
    expect(h.rec.last().method).toBe('DELETE');
    expect(h.rec.last().path).toBe('/computers/vm-1/public-urls/pu-0123456789abcdef');
    expect(result.frame.data).toEqual({ id: 'pu-0123456789abcdef', deleted: true });
  });

  it('names a URL it cannot find, and deletes nothing', async () => {
    const h = harness();
    const result = await h.run(['computers', 'urls', 'rm', 'vm-1', 'not-one-of-ours']);
    expect(result.code).not.toBe(0);
    expect(result.frame.error.code).toBe('not_found');
    expect(h.rec.calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('is in help, the manifest and completion', () => {
    const paths = manifest().commands.map((c) => c.path.join(' '));
    for (const path of [
      'computers urls list',
      'computers urls create',
      'computers urls update',
      'computers urls rm',
    ]) {
      expect(paths).toContain(path);
      expect(help('')).toContain(`mandala ${path}`);
    }
    const create = manifest().commands.find((c) => c.path.join(' ') === 'computers urls create')!;
    expect(create.flags.find((f) => f.name === 'port')).toMatchObject({
      type: 'number',
      required: true,
    });
    expect(create.flags.find((f) => f.name === 'access')).toMatchObject({
      choices: ['public', 'private'],
    });
    expect(completion('bash')).toMatch(/'computers urls'\) candidates='list create update rm/);
  });
});
