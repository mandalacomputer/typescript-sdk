/** Public URLs: a port inside a computer served at `https://<label>.<base domain>` (platform OPL-3753). */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  Client,
  ConflictError,
  MandalaError,
  PlanLimitError,
  ValidationError,
} from '../src/index.js';
import {
  anyRoute,
  BASE,
  json,
  PUBLIC_URL,
  PUBLIC_URL_LIST,
  type Responder,
  recorder,
} from './harness.js';

const handle = async (respond: Responder = anyRoute) => {
  const rec = recorder(respond);
  const client = new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch });
  const computer = await client.computers.get('vm-1');
  rec.calls.length = 0;
  return { rec, computer };
};

/** Answer the public URL routes with `body`, everything else as usual. */
const urls =
  (body: unknown, status = 200): Responder =>
  (call) =>
    call.path.includes('/public-urls') ? json(body, { status }) : anyRoute(call);

describe('listing a computer’s public URLs', () => {
  it('reads the envelope: whether they answer, the domain, the limit, and the URLs', async () => {
    const { rec, computer } = await handle();
    const list = await computer.publicUrls();
    expect(rec.routes()).toEqual([['GET', 'computers/vm-1/public-urls']]);
    expect(list.enabled).toBe(true);
    expect(list.reason).toBeUndefined();
    expect(list.baseDomain).toBe('mandala.dev');
    expect(list.limit).toBe(2);
    expect(list.publicUrls).toHaveLength(1);
    expect(list.publicUrls[0]).toMatchObject({
      id: 'pu-0123456789abcdef',
      url: 'https://cool-thing.mandala.dev',
      hostname: 'cool-thing.mandala.dev',
      label: 'cool-thing',
      port: 3000,
      access: 'public',
      disabled: false,
      createdAt: '2026-10-12T00:00:00.000Z',
      updatedAt: '2026-10-12T00:00:00.000Z',
    });
    expect(list.raw).toEqual(PUBLIC_URL_LIST);
  });

  it('keeps the reason where they cannot answer', async () => {
    const { computer } = await handle(
      urls({ ...PUBLIC_URL_LIST, enabled: false, reason: 'Public URLs are not enabled here.' }),
    );
    const list = await computer.publicUrls();
    expect(list.enabled).toBe(false);
    expect(list.reason).toBe('Public URLs are not enabled here.');
  });

  // A row this client cannot read would be a port served to the internet that
  // the caller never sees, and so never deletes: the answer is refused instead.
  it.each([
    ['an access it cannot read', { ...PUBLIC_URL, access: 'team' }],
    ['no id', { ...PUBLIC_URL, id: '' }],
    ['no url', { ...PUBLIC_URL, url: undefined }],
    ['a port out of range', { ...PUBLIC_URL, port: 70000 }],
    ['a port that is not a whole number', { ...PUBLIC_URL, port: '3000' }],
    ['a disabled flag that is not a boolean', { ...PUBLIC_URL, disabled: 'false' }],
    ['a row that is not an object', 'pu-0123456789abcdef'],
  ])('refuses a listing with a row carrying %s', async (_what, row) => {
    const { computer } = await handle(urls({ ...PUBLIC_URL_LIST, public_urls: [row] }));
    await expect(computer.publicUrls()).rejects.toThrow(MandalaError);
  });

  it.each([
    ['no list', { ...PUBLIC_URL_LIST, public_urls: undefined }],
    ['an enabled it cannot read', { ...PUBLIC_URL_LIST, enabled: 'yes' }],
    ['no limit', { ...PUBLIC_URL_LIST, limit: undefined }],
    ['a list that is not an envelope', [PUBLIC_URL]],
  ])('refuses an answer with %s', async (_what, body) => {
    const { computer } = await handle(urls(body));
    await expect(computer.publicUrls()).rejects.toThrow(MandalaError);
  });
});

describe('making one', () => {
  it('sends exactly what was given, and reads the URL back', async () => {
    const { rec, computer } = await handle();
    const site = await computer.createPublicUrl({
      port: 3000,
      label: 'Cool-Thing',
      access: 'private',
    });
    expect(rec.last().method).toBe('POST');
    expect(rec.last().path).toBe('/computers/vm-1/public-urls');
    expect(rec.last().body).toEqual({ port: 3000, label: 'Cool-Thing', access: 'private' });
    expect(site.url).toBe('https://cool-thing.mandala.dev');
  });

  it('sends only the port when that is all that was given', async () => {
    const { rec, computer } = await handle();
    await computer.createPublicUrl({ port: 8080 });
    expect(rec.last().body).toEqual({ port: 8080 });
  });

  it.each([
    [{ port: 0 }, '1 to 65535'],
    [{ port: 65536 }, '1 to 65535'],
    [{ port: 3000.5 }, '1 to 65535'],
    [{ port: '3000' }, '1 to 65535'],
    [{ port: 22 }, 'belongs to the computer'],
    [{}, 'port is required'],
    [{ port: 3000, label: 'ab' }, '3 to 40'],
    [{ port: 3000, label: 'x'.repeat(41) }, '3 to 40'],
    [{ port: 3000, label: '-abc' }, 'start and end'],
    [{ port: 3000, label: 'a_b' }, 'letters, digits and hyphens'],
    [{ port: 3000, label: 3 }, 'label'],
    [{ port: 3000, access: 'team' }, '"public" or "private"'],
  ])('refuses %j before anything is sent', async (args, says) => {
    const { rec, computer } = await handle();
    await expect(computer.createPublicUrl(args as never)).rejects.toThrow(ValidationError);
    await expect(computer.createPublicUrl(args as never)).rejects.toThrow(says);
    expect(rec.calls).toHaveLength(0);
  });

  it('passes the platform’s refusals on with their code', async () => {
    const taken: Responder = (call) =>
      call.path.endsWith('/public-urls')
        ? json({ error: 'that label is taken', code: 'LABEL_TAKEN' }, { status: 409 })
        : anyRoute(call);
    const { computer } = await handle(taken);
    const error = await computer
      .createPublicUrl({ port: 3000, label: 'cool-thing' })
      .catch((e) => e);
    expect(error).toBeInstanceOf(ConflictError);
    expect(error.code).toBe('LABEL_TAKEN');

    const plan: Responder = (call) =>
      call.path.endsWith('/public-urls')
        ? json({ error: 'no public URLs on this plan', code: 'PLAN_REQUIRED' }, { status: 402 })
        : anyRoute(call);
    const { computer: other } = await handle(plan);
    await expect(other.createPublicUrl({ port: 3000 })).rejects.toThrow(PlanLimitError);
  });
});

describe('changing and removing one', () => {
  it('patches the port, the access, or both, by the URL’s id', async () => {
    const { rec, computer } = await handle();
    await computer.updatePublicUrl('pu-0123456789abcdef', { port: 8000 });
    expect(rec.last().method).toBe('PATCH');
    expect(rec.last().path).toBe('/computers/vm-1/public-urls/pu-0123456789abcdef');
    expect(rec.last().body).toEqual({ port: 8000 });
    await computer.updatePublicUrl('pu-0123456789abcdef', { access: 'private', port: 9000 });
    expect(rec.last().body).toEqual({ port: 9000, access: 'private' });
  });

  it('refuses a patch that names nothing, or a bad port or access, before anything is sent', async () => {
    const { rec, computer } = await handle();
    await expect(computer.updatePublicUrl('pu-0123456789abcdef', {})).rejects.toThrow(
      'nothing to update',
    );
    await expect(computer.updatePublicUrl('pu-0123456789abcdef', { port: 22 })).rejects.toThrow(
      ValidationError,
    );
    await expect(
      computer.updatePublicUrl('pu-0123456789abcdef', { access: 'everyone' as never }),
    ).rejects.toThrow(ValidationError);
    expect(rec.calls).toHaveLength(0);
  });

  it('deletes by id, and refuses an id that would not name one URL', async () => {
    const { rec, computer } = await handle();
    await computer.deletePublicUrl('pu-0123456789abcdef');
    expect(rec.routes()).toEqual([['DELETE', 'computers/vm-1/public-urls/pu-0123456789abcdef']]);
    for (const bad of ['', '..', '.']) {
      await expect(computer.deletePublicUrl(bad)).rejects.toThrow(ValidationError);
      await expect(computer.updatePublicUrl(bad, { port: 8000 })).rejects.toThrow(ValidationError);
    }
    expect(rec.calls).toHaveLength(1);
  });
});

describe('by the computer’s id, with no handle', () => {
  it('lists, makes, changes and removes, reading nothing about the computer', async () => {
    const rec = recorder(anyRoute);
    const client = new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch });
    const list = await client.publicUrls.list('vm-0123456789ab');
    expect(list.publicUrls[0]!.id).toBe('pu-0123456789abcdef');
    await client.publicUrls.create('vm-0123456789ab', { port: 3000, access: 'private' });
    expect(rec.last().body).toEqual({ port: 3000, access: 'private' });
    await client.publicUrls.update('vm-0123456789ab', 'pu-0123456789abcdef', { port: 8000 });
    expect(rec.last().body).toEqual({ port: 8000 });
    await client.publicUrls.delete('vm-0123456789ab', 'pu-0123456789abcdef');
    expect(rec.routes()).toEqual([
      ['GET', 'computers/vm-0123456789ab/public-urls'],
      ['POST', 'computers/vm-0123456789ab/public-urls'],
      ['PATCH', 'computers/vm-0123456789ab/public-urls/pu-0123456789abcdef'],
      ['DELETE', 'computers/vm-0123456789ab/public-urls/pu-0123456789abcdef'],
    ]);
  });

  it('validates as the handle’s methods do, and refuses an id that is not one path segment', async () => {
    const rec = recorder(anyRoute);
    const client = new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch });
    await expect(client.publicUrls.create('vm-0123456789ab', { port: 22 })).rejects.toThrow(
      ValidationError,
    );
    await expect(client.publicUrls.list('..')).rejects.toThrow(ValidationError);
    await expect(client.publicUrls.delete('vm-0123456789ab', '')).rejects.toThrow(ValidationError);
    expect(rec.calls).toHaveLength(0);
  });

  it('refuses an answer it cannot read', async () => {
    const rec = recorder(urls({ ...PUBLIC_URL_LIST, enabled: 'yes' }));
    const client = new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch });
    await expect(client.publicUrls.list('vm-0123456789ab')).rejects.toThrow(MandalaError);
  });
});

// OPL-5973: the README's example called exec({ command, background: true }),
// which throws, and the docs said a deleted label was free to make again with
// no word about a label the platform has blocked.
describe('the public URL documentation', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const section = readme.slice(
    readme.indexOf('\n### Public URLs\n'),
    readme.indexOf('\n### Readiness\n'),
  );

  it('starts the server in its example with a call that exists', async () => {
    expect(section.length).toBeGreaterThan(100);
    expect(section).not.toMatch(/\.exec\(\s*\{/);
    expect(section).toContain("await c.execBackground('python3 -m http.server 3000');");
    // And the call it shows sends what the example means.
    const rec = recorder(anyRoute);
    const client = new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch });
    const c = await client.computers.get('vm-1');
    await c.execBackground('python3 -m http.server 3000');
    expect(rec.last().body).toMatchObject({
      command: 'python3 -m http.server 3000',
      background: true,
    });
  });

  it('says a deleted label stays with the account unless blocked, under the platform’s domain', () => {
    const flat = section.replace(/\s+/g, ' ');
    expect(flat).toContain('`https://<label>.<base_domain>`');
    expect(flat).toContain('`baseDomain`');
    expect(flat).toContain(
      "A deleted URL's label stays with the account: no other account can ever take it, and the account may use it again unless the platform has blocked it.",
    );
  });
});
