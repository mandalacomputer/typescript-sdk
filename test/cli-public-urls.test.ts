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
  COMPUTER,
  errorJson,
  json,
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

/** A computer id in the platform's shape, which the CLI never resolves. */
const ID = 'vm-0123456789ab';
const URLS = `computers/${ID}/public-urls`;
const URL_ID = 'pu-0123456789abcdef';

/** The listing, answered with `computers` and the header a partial one carries. */
const listing =
  (computers: unknown[], incomplete = false): Responder =>
  (call) =>
    call.method === 'GET' && call.path === '/computers'
      ? json(computers, incomplete ? { headers: { 'X-GC-Incomplete': '1' } } : {})
      : anyRoute(call);

/** The URL list answered with these rows. */
const urlRows =
  (rows: unknown[]): Responder =>
  (call) =>
    call.method === 'GET' && call.path.endsWith('/public-urls')
      ? json({ ...PUBLIC_URL_LIST, public_urls: rows })
      : anyRoute(call);

describe('the computer: an id is that id, a name is looked up', () => {
  it('sends an id-shaped reference straight to the public URL routes, with no listing', async () => {
    const h = harness();
    const result = await h.run(['computers', 'urls', 'list', ID]);
    expect(result.code).toBe(0);
    expect(h.rec.routes()).toEqual([['GET', URLS]]);
    expect(result.frame.data).toEqual(PUBLIC_URL_LIST);
  });

  it('finds a name in one complete listing', async () => {
    const h = harness();
    const result = await h.run(['computers', 'urls', 'list', COMPUTER.name]);
    expect(result.code).toBe(0);
    expect(h.rec.routes()).toEqual([
      ['GET', 'computers'],
      ['GET', `computers/${COMPUTER.id}/public-urls`],
    ]);
  });

  // Codex, round 6 on #256: computer B named after A's id was picked by the
  // name fallback during a scoped workspace move, and B's port served.
  it('acts on the id even when another computer is named after it', async () => {
    const impostor = { ...COMPUTER, id: 'vm-bbbbbbbbbbbb', name: ID };
    const h = harness(listing([impostor], true));
    const result = await h.run(['computers', 'urls', 'create', ID, '--port', '3000']);
    expect(result.code).toBe(0);
    expect(h.rec.routes()).toEqual([['POST', URLS]]);
    expect(h.rec.calls.some((c) => c.path.includes('vm-bbbbbbbbbbbb'))).toBe(false);
  });

  // Codex, round 6 on #256: a scoped partial listing left out a computer still
  // live during a host outage, and rm --id failed before the DELETE.
  it('removes a URL by ids through a host outage, never listing computers', async () => {
    const outage: Responder = (call) =>
      call.method === 'GET' &&
      call.path.startsWith('/computers') &&
      !call.path.includes('public-urls')
        ? errorJson(503, 'a host did not answer')
        : anyRoute(call);
    const h = harness(outage);
    const result = await h.run(['computers', 'urls', 'rm', ID, URL_ID, '--id']);
    expect(result.code).toBe(0);
    expect(h.rec.routes()).toEqual([['DELETE', `${URLS}/${URL_ID}`]]);
  });

  it('passes on the platform’s own refusal for an id', async () => {
    const moving: Responder = (call) =>
      call.path.endsWith('/public-urls')
        ? json(
            { error: 'a workspace move is unsettled', code: 'WORKSPACE_MOVING' },
            { status: 409 },
          )
        : anyRoute(call);
    const h = harness(moving);
    const result = await h.run(['computers', 'urls', 'create', ID, '--port', '3000']);
    expect(result.code).not.toBe(0);
    expect(result.frame.error.code).toBe('conflict');
    expect(result.frame.error.message).toMatch(/workspace move is unsettled/);
    expect(h.rec.routes()).toEqual([['POST', URLS]]);
  });

  it('refuses a name from an incomplete listing, asking for the id', async () => {
    const h = harness(listing([COMPUTER], true));
    const result = await h.run(['computers', 'urls', 'list', COMPUTER.name]);
    expect(result.code).not.toBe(0);
    expect(result.frame.error.code).toBe('incomplete_listing');
    expect(result.frame.error.message).toMatch(/computer id/);
    expect(h.rec.calls.some((c) => c.path.includes('public-urls'))).toBe(false);
  });

  it('refuses a name two computers share, naming both ids', async () => {
    const h = harness(listing([COMPUTER, { ...COMPUTER, id: 'vm-cccccccccccc' }]));
    const result = await h.run(['computers', 'urls', 'list', COMPUTER.name]);
    expect(result.code).not.toBe(0);
    expect(result.frame.error.code).toBe('ambiguous_computer');
    expect(result.frame.error.message).toContain('vm-cccccccccccc');
    expect(h.rec.calls.some((c) => c.path.includes('public-urls'))).toBe(false);
  });

  it('matches anything not shaped like an id by name only', async () => {
    // `vm-1` is the fixture computer's id, but not in the platform's shape.
    const h = harness();
    const result = await h.run(['computers', 'urls', 'list', COMPUTER.id]);
    expect(result.code).not.toBe(0);
    expect(result.frame.error.code).toBe('not_found');
    expect(h.rec.calls.some((c) => c.path.includes('public-urls'))).toBe(false);
  });
});

describe('making one', () => {
  it('sends exactly the flags given', async () => {
    const h = harness();
    const result = await h.run([
      'computers',
      'urls',
      'create',
      ID,
      '--port',
      '3000',
      '--label',
      'cool-thing',
      '--access',
      'private',
    ]);
    expect(result.code).toBe(0);
    expect(h.rec.last().method).toBe('POST');
    expect(h.rec.last().path).toBe(`/${URLS}`);
    expect(h.rec.last().body).toEqual({ port: 3000, label: 'cool-thing', access: 'private' });
    expect(result.frame.data).toEqual(PUBLIC_URL);
  });

  it.each([
    [['--port', '22'], /belongs to the computer/],
    [['--port', '70000'], /1 to 65535/],
    [['--port', '3000', '--label', 'a_b'], /letters, digits and hyphens/],
  ])('refuses %j before contacting anything', async (flags, says) => {
    const h = harness();
    const result = await h.run(['computers', 'urls', 'create', ID, ...flags]);
    expect(result.code).not.toBe(0);
    expect(result.frame.error.message).toMatch(says);
    expect(h.rec.calls).toHaveLength(0);
  });

  it('refuses a create without --port, and an --access outside its choices', async () => {
    for (const flags of [[], ['--port', '3000', '--access', 'team']]) {
      const h = harness();
      expect((await h.run(['computers', 'urls', 'create', ID, ...flags])).code).not.toBe(0);
      expect(h.rec.calls).toHaveLength(0);
    }
  });
});

describe('the URL: found in that computer’s list, or given by --id', () => {
  it.each([
    ['its label', 'cool-thing'],
    ['its hostname', 'cool-thing.mandala.dev'],
    ['its address', 'https://cool-thing.mandala.dev/'],
    ['its address, in capitals', 'HTTPS://Cool-Thing.mandala.dev'],
    ['its id', URL_ID],
  ])('finds the URL to change by %s', async (_what, ref) => {
    const h = harness();
    const result = await h.run(['computers', 'urls', 'update', ID, ref, '--port', '8000']);
    expect(result.code).toBe(0);
    expect(h.rec.routes()).toEqual([
      ['GET', URLS],
      ['PATCH', `${URLS}/${URL_ID}`],
    ]);
    expect(h.rec.last().body).toEqual({ port: 8000 });
  });

  // Codex, round 1 on #256: a label may be shaped like a URL id.
  const twoUrls = urlRows([
    PUBLIC_URL,
    {
      ...PUBLIC_URL,
      id: 'pu-fedcba9876543210',
      label: URL_ID,
      hostname: `${URL_ID}.mandala.dev`,
      url: `https://${URL_ID}.mandala.dev`,
    },
  ]);

  it('refuses a reference that is one URL’s id and another’s label, changing nothing', async () => {
    const h = harness(twoUrls);
    const result = await h.run(['computers', 'urls', 'rm', ID, URL_ID]);
    expect(result.code).not.toBe(0);
    expect(result.frame.error.code).toBe('ambiguous_public_url');
    expect(result.frame.error.message).toContain(`${URL_ID}.mandala.dev`);
    expect(result.frame.error.message).toContain('cool-thing.mandala.dev');
    expect(h.rec.calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('and then takes the hostname of either', async () => {
    const h = harness(twoUrls);
    const result = await h.run(['computers', 'urls', 'rm', ID, `${URL_ID}.mandala.dev`]);
    expect(result.code).toBe(0);
    expect(h.rec.last().path).toBe(`/${URLS}/pu-fedcba9876543210`);
  });

  it('finds an id-shaped label when no URL has that id', async () => {
    const h = harness(urlRows([{ ...PUBLIC_URL, id: 'pu-fedcba9876543210', label: URL_ID }]));
    const result = await h.run(['computers', 'urls', 'update', ID, URL_ID, '--port', '8000']);
    expect(result.code).toBe(0);
    expect(h.rec.last().path).toBe(`/${URLS}/pu-fedcba9876543210`);
  });

  it('with --id, sends the URL id without the lookup, which a workspace move refuses', async () => {
    const moving: Responder = (call) =>
      call.method === 'GET' && call.path.endsWith('/public-urls')
        ? json(
            { error: 'a workspace move is unsettled', code: 'WORKSPACE_MOVING' },
            { status: 409 },
          )
        : anyRoute(call);
    const looked = harness(moving);
    expect((await looked.run(['computers', 'urls', 'rm', ID, URL_ID])).code).not.toBe(0);
    expect(looked.rec.calls.some((c) => c.method === 'DELETE')).toBe(false);
    const h = harness(moving);
    expect((await h.run(['computers', 'urls', 'rm', ID, URL_ID, '--id'])).code).toBe(0);
    expect(h.rec.routes()).toEqual([['DELETE', `${URLS}/${URL_ID}`]]);
    const u = harness();
    expect(
      (await u.run(['computers', 'urls', 'update', ID, URL_ID, '--id', '--access', 'private']))
        .code,
    ).toBe(0);
    expect(u.rec.routes()).toEqual([['PATCH', `${URLS}/${URL_ID}`]]);
  });

  it('refuses --id with something that cannot be an id segment', async () => {
    const h = harness();
    const result = await h.run(['computers', 'urls', 'rm', ID, '..', '--id']);
    expect(result.code).not.toBe(0);
    expect(h.rec.calls).toHaveLength(0);
  });

  it('refuses an update that changes nothing, before contacting anything', async () => {
    const h = harness();
    const result = await h.run(['computers', 'urls', 'update', ID, 'cool-thing']);
    expect(result.code).not.toBe(0);
    expect(result.frame.error.message).toMatch(/nothing to update/);
    expect(h.rec.calls).toHaveLength(0);
  });

  it('removes one, and says so', async () => {
    const h = harness();
    const result = await h.run(['computers', 'urls', 'rm', ID, 'cool-thing']);
    expect(result.code).toBe(0);
    expect(h.rec.last().method).toBe('DELETE');
    expect(h.rec.last().path).toBe(`/${URLS}/${URL_ID}`);
    expect(result.frame.data).toEqual({ id: URL_ID, deleted: true });
  });

  it('names a URL it cannot find, and deletes nothing', async () => {
    const h = harness();
    const result = await h.run(['computers', 'urls', 'rm', ID, 'not-one-of-ours']);
    expect(result.code).not.toBe(0);
    expect(result.frame.error.code).toBe('not_found');
    expect(h.rec.calls.some((c) => c.method === 'DELETE')).toBe(false);
  });
});

describe('the commands', () => {
  it('are in help, the manifest and completion', () => {
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
    for (const verb of ['update', 'rm']) {
      const c = manifest().commands.find((m) => m.path.join(' ') === `computers urls ${verb}`)!;
      expect(c.flags.find((f) => f.name === 'id')).toMatchObject({ type: 'boolean' });
    }
    expect(completion('bash')).toMatch(/'computers urls'\) candidates='list create update rm/);
  });
});
