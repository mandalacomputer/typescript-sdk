import { describe, expect, it } from 'vitest';
import { Client, MandalaError } from '../src/index.js';
import {
  API_KEY_CREATED,
  anyRoute,
  BASE,
  COMPUTER,
  json,
  type Responder,
  recorder,
} from './harness.js';

// A platform that does not know a field ignores it and answers as though it
// had not been sent. Each limit asked for is held to the answer.

function sdk(respond: Responder) {
  const rec = recorder(respond);
  return { rec, client: new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch }) };
}

const AT = '2030-01-01T00:00:00Z';

describe('an API key mint the platform did not limit', () => {
  const minted =
    (extra: Record<string, unknown>, revoke: Responder = anyRoute): Responder =>
    (call) =>
      call.method === 'POST' && call.path === '/api-keys'
        ? json({ ...API_KEY_CREATED, ...extra }, { status: 201 })
        : revoke(call);

  it.each([
    ['omitted', { expiresAt: AT }, {}],
    ['null', { expiresAt: AT }, { expires_at: null }],
    ['later than asked', { expiresAt: AT }, { expires_at: '2030-01-01T00:00:01Z' }],
    ['unreadable', { expiresAt: AT }, { expires_at: 'soon' }],
    ['hours, omitted', { expiresInHours: 1 }, {}],
    ['hours, far later', { expiresInHours: 1 }, { expires_at: '2099-01-01T00:00:00Z' }],
  ])('revokes and refuses a key whose expiry is %s', async (_what, args, extra) => {
    const { rec, client } = sdk(minted(extra));
    const error = await client.apiKeys.create(args).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MandalaError);
    const message = (error as Error).message;
    expect(message).toContain('did not apply the requested expiry');
    expect(message).toContain('it was revoked');
    expect(message).not.toContain(API_KEY_CREATED.raw);
    expect(rec.routes()).toEqual([
      ['POST', 'api-keys'],
      ['DELETE', `api-keys/${API_KEY_CREATED.id}`],
    ]);
  });

  it.each([
    ['omitted', {}],
    ['null', { computer_ids: null }],
    ['empty', { computer_ids: [] }],
    ['wider than asked', { computer_ids: ['vm-1', 'vm-9'] }],
  ])('revokes and refuses a key whose computer limit is %s', async (_what, extra) => {
    const { rec, client } = sdk(minted(extra));
    const error = await client.apiKeys
      .create({ computerIds: ['vm-1', 'vm-2'] })
      .catch((e: unknown) => e);
    expect((error as Error).message).toContain('did not apply the requested computer limit');
    expect(rec.last()).toMatchObject({ method: 'DELETE' });
  });

  it('accepts an expiry no later than asked and a limit within the asked set', async () => {
    const { client } = sdk(
      minted({ expires_at: '2029-12-31T23:59:59Z', computer_ids: ['vm-2', 'vm-1'] }),
    );
    const key = await client.apiKeys.create({ expiresAt: AT, computerIds: ['vm-1', 'vm-2'] });
    expect(key.key).toBe(API_KEY_CREATED.raw);
  });

  it('says so, and still keeps the key back, when the revoke fails', async () => {
    const { client } = sdk(
      minted({}, () => json({ error: 'upstream down', request_id: 'r1' }, { status: 400 })),
    );
    const error = await client.apiKeys.create({ expiresInHours: 2 }).catch((e: unknown) => e);
    const message = (error as Error).message;
    expect(message).toContain('revoking it failed');
    expect(message).toContain(`revoke ${API_KEY_CREATED.id} yourself`);
    expect(message).not.toContain(API_KEY_CREATED.raw);
  });

  it('asks nothing of a mint that asked for no limits', async () => {
    const { rec, client } = sdk(minted({}));
    await client.apiKeys.create({ name: 'ci' });
    expect(rec.routes()).toEqual([['POST', 'api-keys']]);
  });
});

describe('an end time the platform did not apply', () => {
  const noEndTime: Responder = (call) =>
    call.path === '/computers' || call.method === 'PATCH' ? json(COMPUTER) : anyRoute(call);

  it.each([{ endsAt: AT }, { endsInHours: 2 }])(
    'refuses a create answered without one (%j), and leaves the computer alone',
    async (args) => {
      const { rec, client } = sdk(noEndTime);
      const error = await client.computers.create(args).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(MandalaError);
      expect((error as Error).message).toContain(
        `the create of computer ${COMPUTER.id} did not apply the requested end time`,
      );
      expect(rec.routes()).toEqual([['POST', 'computers']]);
    },
  );

  it('refuses an update answered without one, and one that did not clear it', async () => {
    const { rec, client } = sdk(noEndTime);
    const c = await client.computers.get(COMPUTER.id);
    await expect(c.update({ endsInHours: 1 })).rejects.toThrow(
      `the update of computer ${COMPUTER.id} did not apply the requested end time`,
    );
    await expect(c.update({ endsAt: AT })).rejects.toThrow(/did not apply/);
    const kept = sdk((call) =>
      call.method === 'PATCH' ? json({ ...COMPUTER, ends_at: AT }) : anyRoute(call),
    );
    const d = await kept.client.computers.get(COMPUTER.id);
    await expect(d.update({ endsAt: null })).rejects.toThrow(
      `did not clear its end time: the platform's answer still has ${AT}`,
    );
    await expect(d.update({ endsInHours: null })).rejects.toThrow(/did not clear/);
    expect(rec.calls.filter((call) => call.method !== 'GET' && call.method !== 'PATCH')).toEqual(
      [],
    );
  });

  it('checks nothing on a create or update that did not ask', async () => {
    const { client } = sdk(noEndTime);
    const c = await client.computers.create({ template: 'base' });
    await c.update({ name: 'renamed' });
    expect(c.endsAt).toBeUndefined();
  });

  it('deletes an ephemeral computer whose end time was not applied, before the block', async () => {
    const { rec, client } = sdk((call) =>
      call.method === 'DELETE' ? json({ ok: true, snapshots_deleted: 0 }) : noEndTime(call),
    );
    let ran = false;
    await expect(
      client.computers.ephemeral({ endsInHours: 1 }, async () => {
        ran = true;
      }),
    ).rejects.toThrow(/did not apply the requested end time/);
    expect(ran).toBe(false);
    expect(rec.routes()).toEqual([
      ['POST', 'computers'],
      ['DELETE', `computers/${COMPUTER.id}`],
    ]);
  });
});

describe('a launch replayed after its end time has come', () => {
  const stopped = (extra: Record<string, unknown> = {}) => ({
    id: 'launch-42',
    status: 'stopped',
    running_ram_mb: 0,
    ...extra,
  });

  it.each([
    ['cleared it', {}],
    ['passed', { ends_at: '2001-01-01T00:00:00Z' }],
  ])('does not start a computer whose end time has %s', async (_what, now) => {
    // The replayed answer is the first call's: an end time still to come.
    const rec = recorder((call) =>
      call.method === 'POST' && call.path === '/computers'
        ? new Response(JSON.stringify(stopped({ ends_at: AT })), {
            headers: { 'content-type': 'application/json', 'idempotent-replayed': 'true' },
          })
        : json(stopped(now)),
    );
    const client = new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch });
    const error = await client.computers
      .launch({ template: 'base', endsInHours: 2 }, { idempotencyKey: 'k-1', pollMs: 1 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MandalaError);
    expect((error as Error).message).toMatch(/^launch of launch-42 failed: launch-42 is stopped/);
    expect((error as Error).message).toContain('not starting it');
    expect(rec.routes()).toEqual([
      ['POST', 'computers'],
      ['GET', 'computers/launch-42'],
    ]);
  });
});
