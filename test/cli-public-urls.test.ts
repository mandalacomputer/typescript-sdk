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

describe('computers urls', () => {
  it('lists a computer’s URLs, with whether they answer and the limit', async () => {
    const h = harness();
    const result = await h.run(['computers', 'urls', 'list', 'vm-1']);
    expect(result.code).toBe(0);
    // The live listing and the lost one, then the URLs.
    expect(h.rec.routes()).toEqual([
      ['GET', 'computers'],
      ['GET', 'computers'],
      ['GET', 'computers/vm-1/public-urls'],
    ]);
    expect(h.rec.calls[1]!.query.state).toBe('lost');
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
      ['GET', 'computers'],
      ['GET', 'computers/vm-1/public-urls'],
      ['PATCH', 'computers/vm-1/public-urls/pu-0123456789abcdef'],
    ]);
    expect(h.rec.last().body).toEqual({ port: 8000 });
  });

  it('finds the URL by its id in the list too', async () => {
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
      ['GET', 'computers'],
      ['GET', 'computers/vm-1/public-urls'],
      ['PATCH', 'computers/vm-1/public-urls/pu-0123456789abcdef'],
    ]);
    expect(h.rec.last().body).toEqual({ access: 'private' });
  });

  // Codex, round 1 on #256: a label may be shaped like an id.
  const twoUrls: Responder = (call) =>
    call.path.endsWith('/public-urls') && call.method === 'GET'
      ? json({
          ...PUBLIC_URL_LIST,
          public_urls: [
            PUBLIC_URL,
            {
              ...PUBLIC_URL,
              id: 'pu-fedcba9876543210',
              label: 'pu-0123456789abcdef',
              hostname: 'pu-0123456789abcdef.mandala.dev',
              url: 'https://pu-0123456789abcdef.mandala.dev',
            },
          ],
        })
      : anyRoute(call);

  it('refuses a reference that is one URL’s id and another’s label, changing nothing', async () => {
    const h = harness(twoUrls);
    const result = await h.run(['computers', 'urls', 'rm', 'vm-1', 'pu-0123456789abcdef']);
    expect(result.code).not.toBe(0);
    expect(result.frame.error.code).toBe('ambiguous_public_url');
    expect(result.frame.error.message).toContain('pu-0123456789abcdef.mandala.dev');
    expect(result.frame.error.message).toContain('cool-thing.mandala.dev');
    expect(h.rec.calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('and then takes the hostname of either', async () => {
    const h = harness(twoUrls);
    const result = await h.run([
      'computers',
      'urls',
      'rm',
      'vm-1',
      'pu-0123456789abcdef.mandala.dev',
    ]);
    expect(result.code).toBe(0);
    expect(h.rec.last().path).toBe('/computers/vm-1/public-urls/pu-fedcba9876543210');
  });

  it('finds an id-shaped label when no URL has that id', async () => {
    const onlyLabel: Responder = (call) =>
      call.path.endsWith('/public-urls') && call.method === 'GET'
        ? json({
            ...PUBLIC_URL_LIST,
            public_urls: [
              { ...PUBLIC_URL, id: 'pu-fedcba9876543210', label: 'pu-0123456789abcdef' },
            ],
          })
        : anyRoute(call);
    const h = harness(onlyLabel);
    const result = await h.run([
      'computers',
      'urls',
      'update',
      'vm-1',
      'pu-0123456789abcdef',
      '--port',
      '8000',
    ]);
    expect(result.code).toBe(0);
    expect(h.rec.last().path).toBe('/computers/vm-1/public-urls/pu-fedcba9876543210');
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

  // Codex, round 2 on #256: a delete the platform allows while the list is refused.
  it('removes one by --id without listing, while a workspace move refuses the list', async () => {
    const moving: Responder = (call) =>
      call.path.endsWith('/public-urls') && call.method === 'GET'
        ? json(
            { error: 'a workspace move is unsettled', code: 'WORKSPACE_MOVING' },
            { status: 409 },
          )
        : anyRoute(call);
    const listed = harness(moving);
    expect(
      (await listed.run(['computers', 'urls', 'rm', 'vm-1', 'pu-0123456789abcdef'])).code,
    ).not.toBe(0);
    expect(listed.rec.calls.some((c) => c.method === 'DELETE')).toBe(false);
    const h = harness(moving);
    const result = await h.run(['computers', 'urls', 'rm', 'vm-1', 'pu-0123456789abcdef', '--id']);
    expect(result.code).toBe(0);
    expect(h.rec.routes()).toEqual([
      ['GET', 'computers'],
      ['GET', 'computers'],
      ['DELETE', 'computers/vm-1/public-urls/pu-0123456789abcdef'],
    ]);
  });

  it('refuses --id with something that cannot be an id segment', async () => {
    const h = harness();
    const result = await h.run(['computers', 'urls', 'rm', 'vm-1', '..', '--id']);
    expect(result.code).not.toBe(0);
    expect(h.rec.calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  // Codex, round 2 on #256: a lost computer's URLs stay listable and deletable,
  // so its labels can be freed, but the default listing leaves it out.
  const LOST = { ...COMPUTER, id: 'vm-lost', name: 'gone', state: 'lost' };
  const withLost: Responder = (call) => {
    if (call.method === 'GET' && call.path === '/computers')
      return json(call.query.state === 'lost' ? [LOST] : [COMPUTER]);
    if (
      call.method === 'GET' &&
      ['/computers/vm-lost', '/computers/gone', '/computers/vm-nowhere'].includes(call.path)
    )
      return errorJson(404, 'no such computer ID');
    return anyRoute(call);
  };

  it.each([
    ['its id', 'vm-lost'],
    ['its name', 'gone'],
  ])('lists and removes a lost computer’s URLs, found by %s', async (_what, ref) => {
    const listing = harness(withLost);
    expect((await listing.run(['computers', 'urls', 'list', ref])).code).toBe(0);
    expect(listing.rec.routes().at(-1)).toEqual(['GET', 'computers/vm-lost/public-urls']);
    const h = harness(withLost);
    expect((await h.run(['computers', 'urls', 'rm', ref, 'cool-thing'])).code).toBe(0);
    expect(h.rec.last().method).toBe('DELETE');
    expect(h.rec.last().path).toBe('/computers/vm-lost/public-urls/pu-0123456789abcdef');
  });

  // Codex, round 3 on #256: an id is never outranked by a name.
  it('takes a lost computer’s exact id over a live computer of that name', async () => {
    const shadow: Responder = (call) => {
      if (call.method === 'GET' && call.path === '/computers')
        return json(
          call.query.state === 'lost' ? [LOST] : [{ ...COMPUTER, id: 'vm-live', name: 'vm-lost' }],
        );
      if (call.method === 'GET' && call.path === '/computers/vm-lost')
        return errorJson(404, 'no such computer ID');
      return anyRoute(call);
    };
    const h = harness(shadow);
    const result = await h.run(['computers', 'urls', 'rm', 'vm-lost', 'cool-thing']);
    expect(result.code).toBe(0);
    expect(h.rec.last().path).toBe('/computers/vm-lost/public-urls/pu-0123456789abcdef');
    expect(h.rec.calls.some((c) => c.path.startsWith('/computers/vm-live'))).toBe(false);
  });

  // Codex, round 4 on #256: the same shadowing on a create would have served
  // the live computer's port to the internet.
  it.each([
    ['create', ['--port', '3000']],
    ['update', ['cool-thing', '--port', '8000']],
  ])(
    'refuses to %s a URL on a lost computer, rather than on a live one of that name',
    async (verb, rest) => {
      const shadow: Responder = (call) => {
        if (call.method === 'GET' && call.path === '/computers')
          return json(
            call.query.state === 'lost'
              ? [LOST]
              : [{ ...COMPUTER, id: 'vm-live', name: 'vm-lost' }],
          );
        if (call.method === 'GET' && call.path === '/computers/vm-lost')
          return errorJson(404, 'no such computer ID');
        return anyRoute(call);
      };
      const h = harness(shadow);
      const result = await h.run(['computers', 'urls', verb, 'vm-lost', ...rest]);
      expect(result.code).not.toBe(0);
      expect(result.frame.error.code).toBe('computer_lost');
      expect(h.rec.calls.some((c) => c.method === 'POST' || c.method === 'PATCH')).toBe(false);
    },
  );

  // Codex, round 3 on #256: the lost listing is the control plane's, and
  // answers through a fleet outage that fails the live one.
  const outage =
    (direct: number): Responder =>
    (call) => {
      if (call.method === 'GET' && call.path === '/computers')
        return call.query.state === 'lost' ? json([LOST]) : errorJson(503, 'a host did not answer');
      if (call.method === 'GET' && /^\/computers\/[^/]+$/.test(call.path))
        return errorJson(direct, direct === 404 ? 'no such computer ID' : 'a host did not answer');
      return anyRoute(call);
    };

  it('removes a lost computer’s URL by ids through a fleet outage', async () => {
    const h = harness(outage(503));
    const result = await h.run([
      'computers',
      'urls',
      'rm',
      'vm-lost',
      'pu-0123456789abcdef',
      '--id',
    ]);
    expect(result.code).toBe(0);
    expect(h.rec.last().method).toBe('DELETE');
    expect(h.rec.last().path).toBe('/computers/vm-lost/public-urls/pu-0123456789abcdef');
  });

  // Codex, round 5 on #256: a host down but its computer not yet lost.
  const UNREACHABLE = { ...COMPUTER, id: 'vm-down', name: 'down', state: 'unreachable' };
  const hostDown: Responder = (call) => {
    if (call.method === 'GET' && call.path === '/computers') {
      if (call.query.state === 'lost') return json([]);
      return call.query.allow_partial === '1'
        ? json([UNREACHABLE], { headers: { 'X-GC-Incomplete': '1' } })
        : errorJson(503, 'a host did not answer');
    }
    if (call.method === 'GET' && /^\/computers\/[^/]+$/.test(call.path))
      return errorJson(503, 'a host did not answer');
    return anyRoute(call);
  };

  it('removes a URL by ids from a computer whose host is down, before it is lost', async () => {
    const h = harness(hostDown);
    const result = await h.run([
      'computers',
      'urls',
      'rm',
      'vm-down',
      'pu-0123456789abcdef',
      '--id',
    ]);
    expect(result.code).toBe(0);
    expect(h.rec.last().method).toBe('DELETE');
    expect(h.rec.last().path).toBe('/computers/vm-down/public-urls/pu-0123456789abcdef');
  });

  it('but not by its name, which a partial listing cannot vouch for', async () => {
    const h = harness(hostDown);
    const result = await h.run(['computers', 'urls', 'rm', 'down', 'pu-0123456789abcdef', '--id']);
    expect(result.code).not.toBe(0);
    expect(h.rec.calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it.each([404, 503])(
    'but never guesses a name from half a picture (direct read %i)',
    async (status) => {
      const h = harness(outage(status));
      const result = await h.run(['computers', 'urls', 'rm', 'gone', 'cool-thing']);
      expect(result.code).not.toBe(0);
      expect(h.rec.calls.some((c) => c.method === 'DELETE')).toBe(false);
    },
  );

  it('refuses a name shared by a live and a lost computer', async () => {
    const both: Responder = (call) => {
      if (call.method === 'GET' && call.path === '/computers')
        return json(call.query.state === 'lost' ? [LOST] : [{ ...COMPUTER, name: 'gone' }]);
      if (call.method === 'GET' && call.path === '/computers/gone')
        return errorJson(404, 'no such computer ID');
      return anyRoute(call);
    };
    const h = harness(both);
    const result = await h.run(['computers', 'urls', 'list', 'gone']);
    expect(result.code).not.toBe(0);
    expect(result.frame.error.code).toBe('ambiguous_computer');
  });

  it('still refuses a computer that is nowhere, lost or not', async () => {
    const h = harness(withLost);
    const result = await h.run(['computers', 'urls', 'list', 'vm-nowhere']);
    expect(result.code).not.toBe(0);
    expect(result.frame.error.code).toBe('not_found');
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
