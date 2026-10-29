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

  it.each([
    ['malformed computer_ids', { computerIds: ['vm-1'] }, { computer_ids: 'vm-1' }],
    ['a non-string expires_at', { expiresInHours: 1 }, { expires_at: 1893456000 }],
  ])('revokes a limited key whose answer has %s', async (_what, args, extra) => {
    const { rec, client } = sdk(minted(extra));
    const error = await client.apiKeys.create(args).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MandalaError);
    const message = (error as Error).message;
    expect(message).toContain(`the new key ${API_KEY_CREATED.id} could not be read`);
    expect(message).toContain('it was revoked');
    expect(message).not.toContain(API_KEY_CREATED.raw);
    expect(rec.last()).toMatchObject({
      method: 'DELETE',
      path: `/api-keys/${API_KEY_CREATED.id}`,
    });
  });

  it('throws the decode error as before on a mint that asked for no limits', async () => {
    const { rec, client } = sdk(minted({ computer_ids: 'vm-1' }));
    await expect(client.apiKeys.create({ name: 'ci' })).rejects.toThrow(/computer_ids/);
    expect(rec.routes()).toEqual([['POST', 'api-keys']]);
  });

  it('still revokes when the caller cancels after the mint was answered', async () => {
    const controller = new AbortController();
    const { rec, client } = sdk((call) => {
      if (call.method === 'POST') {
        controller.abort(new Error('caller gave up'));
        return json(API_KEY_CREATED, { status: 201 });
      }
      return anyRoute(call);
    });
    const error = await client.apiKeys
      .create({ expiresInHours: 1 }, { signal: controller.signal })
      .catch((e: unknown) => e);
    expect((error as Error).message).toContain('it was revoked');
    expect(rec.last()).toMatchObject({
      method: 'DELETE',
      path: `/api-keys/${API_KEY_CREATED.id}`,
    });
  });

  it('still revokes when the caller cancels during the revoke', async () => {
    const controller = new AbortController();
    const { rec, client } = sdk(async (call) => {
      if (call.method === 'POST') return json(API_KEY_CREATED, { status: 201 });
      controller.abort(new Error('caller gave up'));
      await new Promise((resolve) => setTimeout(resolve, 20));
      return json({ ok: true });
    });
    const error = await client.apiKeys
      .create({ computerIds: ['vm-1'] }, { signal: controller.signal })
      .catch((e: unknown) => e);
    expect((error as Error).message).toContain('it was revoked');
    expect(rec.routes()).toEqual([
      ['POST', 'api-keys'],
      ['DELETE', `api-keys/${API_KEY_CREATED.id}`],
    ]);
  });

  it.each([
    ['5s ahead of', -5_000],
    ['2 minutes behind', 120_000],
  ])('accepts an expiry in hours with the client clock %s the platform', async (_what, skew) => {
    const at = new Date(Date.now() + skew + 3_600_000).toISOString();
    const { rec, client } = sdk((call) =>
      call.method === 'POST'
        ? new Response(JSON.stringify({ ...API_KEY_CREATED, expires_at: at }), {
            status: 201,
            headers: {
              'content-type': 'application/json',
              date: new Date(Date.now() + skew).toUTCString(),
            },
          })
        : anyRoute(call),
    );
    const key = await client.apiKeys.create({ expiresInHours: 1 });
    expect(key.expiresAt).toBe(at);
    expect(rec.routes()).toEqual([['POST', 'api-keys']]);
    const late = new Date(Date.now() + skew + 3_600_000 + 5 * 60_000).toISOString();
    const wrong = sdk((call) =>
      call.method === 'POST'
        ? new Response(JSON.stringify({ ...API_KEY_CREATED, expires_at: late }), {
            status: 201,
            headers: {
              'content-type': 'application/json',
              date: new Date(Date.now() + skew).toUTCString(),
            },
          })
        : anyRoute(call),
    );
    await expect(wrong.client.apiKeys.create({ expiresInHours: 1 })).rejects.toThrow(
      /did not apply the requested expiry/,
    );
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
      `did not clear its end time: the platform's answer still has "${AT}"`,
    );
    await expect(d.update({ endsInHours: null })).rejects.toThrow(/did not clear/);
    expect(rec.calls.filter((call) => call.method !== 'GET' && call.method !== 'PATCH')).toEqual(
      [],
    );
  });

  const answering =
    (endsAt: unknown): Responder =>
    (call) =>
      call.path === '/computers' || call.method === 'PATCH'
        ? json({ ...COMPUTER, ends_at: endsAt })
        : anyRoute(call);

  it.each([
    ['an earlier end time, unchanged', '2029-06-01T00:00:00Z'],
    ['a malformed one', {}],
    ['an unreadable one', 'soon'],
    ['a number', 1893456000],
  ])('refuses a create and an update answered with %s', async (_what, endsAt) => {
    const { rec, client } = sdk(answering(endsAt));
    for (const args of [{ endsAt: AT }, { endsInHours: 2 }]) {
      await expect(client.computers.create(args)).rejects.toThrow(
        /create of computer .* did not apply the requested end time/,
      );
    }
    const c = await client.computers.get(COMPUTER.id);
    for (const args of [{ endsAt: AT }, { endsInHours: 2 }]) {
      await expect(c.update(args)).rejects.toThrow(
        /update of computer .* did not apply the requested end time/,
      );
    }
    expect(rec.calls.some((call) => call.method === 'DELETE' || call.path.endsWith('/stop'))).toBe(
      false,
    );
  });

  it('refuses a clear answered with a malformed end time', async () => {
    const { client } = sdk(answering({}));
    const c = await client.computers.get(COMPUTER.id);
    await expect(c.update({ endsAt: null })).rejects.toThrow(/did not clear its end time/);
  });

  it('accepts the time asked for, truncated to the second', async () => {
    const { client } = sdk(answering('2030-01-01T00:00:00Z'));
    const c = await client.computers.create({ endsAt: new Date('2030-01-01T00:00:00.900Z') });
    expect(c.endsAt).toBe('2030-01-01T00:00:00Z');
    const later = sdk(answering('2030-01-01T00:00:02Z'));
    await expect(later.client.computers.create({ endsAt: AT })).rejects.toThrow(/did not apply/);
  });

  // The platform's clock, as its answer's Date header gives it: `skewMs` from
  // this machine's, so a negative skew is a client clock running ahead.
  const dated = (body: unknown, skewMs: number, extra: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      headers: {
        'content-type': 'application/json',
        date: new Date(Date.now() + skewMs).toUTCString(),
        ...extra,
      },
    });
  const serverHours = (skewMs: number, hours: number, offsetMs = 0) =>
    new Date(Date.now() + skewMs + hours * 3_600_000 + offsetMs).toISOString();

  it.each([
    ['5s ahead of', -5_000],
    ['2 minutes behind', 120_000],
  ])('accepts hours the platform applied with the client clock %s it', async (_what, skew) => {
    const applied: Responder = (call) =>
      call.path === '/computers' || call.method === 'PATCH'
        ? dated({ ...COMPUTER, ends_at: serverHours(skew, 2) }, skew)
        : anyRoute(call);
    const { client } = sdk(applied);
    const c = await client.computers.create({ endsInHours: 2 });
    await c.update({ endsInHours: 2 });
  });

  it.each([
    ['five minutes late', 5 * 60_000],
    ['an hour early', -3_600_000],
  ])('refuses hours the platform answered %s by its own clock', async (_what, offset) => {
    const wrong: Responder = (call) =>
      call.path === '/computers' || call.method === 'PATCH'
        ? dated({ ...COMPUTER, ends_at: serverHours(120_000, 2, offset) }, 120_000)
        : anyRoute(call);
    const { client } = sdk(wrong);
    await expect(client.computers.create({ endsInHours: 2 })).rejects.toThrow(/did not apply/);
    const c = await client.computers.get(COMPUTER.id);
    await expect(c.update({ endsInHours: 2 })).rejects.toThrow(/did not apply/);
  });

  it('without a Date header, allows ten minutes of skew either side', async () => {
    const hours =
      (offsetMs: number): Responder =>
      (call) =>
        call.path === '/computers'
          ? json({ ...COMPUTER, ends_at: serverHours(0, 2, offsetMs) })
          : anyRoute(call);
    await sdk(hours(5 * 60_000)).client.computers.create({ endsInHours: 2 });
    await sdk(hours(-5 * 60_000)).client.computers.create({ endsInHours: 2 });
    for (const off of [15 * 60_000, -15 * 60_000]) {
      await expect(sdk(hours(off)).client.computers.create({ endsInHours: 2 })).rejects.toThrow(
        /did not apply/,
      );
    }
  });

  it('accepts a replayed update whose end time came from the first call', async () => {
    // The first call was minutes ago; its answer is replayed as it was.
    const first = serverHours(-5 * 60_000, 2);
    const { client } = sdk((call) =>
      call.method === 'PATCH'
        ? dated({ ...COMPUTER, ends_at: first }, 0, { 'idempotent-replayed': 'true' })
        : anyRoute(call),
    );
    const c = await client.computers.get(COMPUTER.id);
    await c.update({ endsInHours: 2 }, { idempotencyKey: 'k-2' });
    expect(c.endsAt).toBe(first);
    // Not replayed, the same answer is too early for this request.
    const fresh = sdk((call) =>
      call.method === 'PATCH' ? dated({ ...COMPUTER, ends_at: first }, 0) : anyRoute(call),
    );
    const d = await fresh.client.computers.get(COMPUTER.id);
    await expect(d.update({ endsInHours: 2 })).rejects.toThrow(/did not apply/);
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

describe('a launch whose end time comes during its start', () => {
  it('stops the computer again and throws', async () => {
    const soon = new Date(Date.now() + 3_600_000).toISOString();
    const rec = recorder((call) => {
      if (call.method === 'POST' && call.path === '/computers')
        return json({ id: 'launch-42', status: 'stopped', running_ram_mb: 0, ends_at: soon });
      if (call.path.endsWith('/stop'))
        return json({ id: 'launch-42', status: 'stopped', running_ram_mb: 0 });
      // Started just as the end time came: running, and none left.
      return json({ id: 'launch-42', status: 'running', running_ram_mb: 1024 });
    });
    const client = new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch });
    const error = await client.computers
      .launch({ template: 'base', endsInHours: 1, start: false }, { pollMs: 1 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MandalaError);
    expect((error as Error).message).toContain(
      'launch-42 was started, but its requested end time was gone by then; it was stopped again',
    );
    const routes = rec.routes();
    expect(routes).toContainEqual(['POST', 'computers/launch-42/start']);
    expect(routes.at(-1)).toEqual(['POST', 'computers/launch-42/stop']);
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
    // The replayed answer is the first call's: an end time two hours from a
    // request made an hour ago, still to come when it was answered.
    const first = new Date(Date.now() + 3_600_000).toISOString();
    const rec = recorder((call) =>
      call.method === 'POST' && call.path === '/computers'
        ? new Response(JSON.stringify(stopped({ ends_at: first })), {
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
