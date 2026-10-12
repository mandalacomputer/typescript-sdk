/**
 * `client.workspaces` (platform OPL-5057): the account's workspaces and the
 * people who reach one, and their create, rename and delete (OPL-5473).
 */

import { describe, expect, it } from 'vitest';
import {
  Client,
  ConflictError,
  MandalaError,
  NotFoundError,
  PermissionDeniedError,
  ValidationError,
} from '../src/index.js';
import {
  anyRoute,
  BASE,
  json,
  type Responder,
  recorder,
  WORKSPACE,
  WORKSPACE_DELETED,
  WORKSPACE_MEMBER,
} from './harness.js';

function sdk(respond: Responder = anyRoute) {
  const rec = recorder(respond);
  return { rec, client: new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch }) };
}

describe('client.workspaces', () => {
  it('lists, reads one and lists its members, decoding each', async () => {
    const { rec, client } = sdk();
    expect(await client.workspaces.list()).toEqual([
      {
        id: WORKSPACE.id,
        name: 'customers',
        createdAt: WORKSPACE.created_at,
        raw: WORKSPACE,
      },
    ]);
    expect((await client.workspaces.get(WORKSPACE.id)).id).toBe(WORKSPACE.id);
    expect(await client.workspaces.members(WORKSPACE.id)).toEqual([
      {
        userId: WORKSPACE_MEMBER.user_id,
        email: 'dana@example.com',
        name: 'Dana',
        role: 'owner',
        acceptedAt: WORKSPACE_MEMBER.accepted_at,
        suspended: false,
        seatSuspended: false,
        raw: WORKSPACE_MEMBER,
      },
    ]);
    expect(rec.routes()).toEqual([
      ['GET', 'workspaces'],
      ['GET', `workspaces/${WORKSPACE.id}`],
      ['GET', `workspaces/${WORKSPACE.id}/members`],
    ]);
  });

  it('keeps a member with no display name as null', async () => {
    const { client } = sdk(() => json([{ ...WORKSPACE_MEMBER, name: null }]));
    const [member] = await client.workspaces.members(WORKSPACE.id);
    expect(member?.name).toBeNull();
  });

  it.each([
    { suspended: false, seat_suspended: false },
    { suspended: false, seat_suspended: true },
    { suspended: true, seat_suspended: false },
    { suspended: true, seat_suspended: true },
  ])('keeps sign-in and seat suspension independent (%j)', async (flags) => {
    const row = { ...WORKSPACE_MEMBER, ...flags, future_field: 'kept' };
    const { client } = sdk(() => json([row]));
    const [member] = await client.workspaces.members(WORKSPACE.id);
    expect(member?.suspended).toBe(flags.suspended);
    expect(member?.seatSuspended).toBe(flags.seat_suspended);
    expect(member?.raw).toEqual(row);
  });

  it.each([false, true])(
    'leaves an older server seat state unknown when suspended is %s',
    async (suspended) => {
      const { seat_suspended: _seat, ...older } = WORKSPACE_MEMBER;
      const row = { ...older, suspended };
      const { client } = sdk(() => json([row]));
      const [member] = await client.workspaces.members(WORKSPACE.id);
      expect(member?.suspended).toBe(suspended);
      expect(member?.seatSuspended).toBeUndefined();
      expect(member).not.toHaveProperty('seatSuspended');
      expect(member?.raw).toEqual(row);
      expect(member?.raw).not.toHaveProperty('seat_suspended');
    },
  );

  it.each([null, 0, 1, 'false', 'true', [], {}].map((seat_suspended) => ({ seat_suspended })))(
    'refuses a supplied seat_suspended that is not a boolean (%j)',
    async ({ seat_suspended }) => {
      const { client } = sdk(() => json([{ ...WORKSPACE_MEMBER, seat_suspended }]));
      await expect(client.workspaces.members(WORKSPACE.id)).rejects.toThrow(
        /seat_suspended.*boolean/,
      );
    },
  );

  it('refuses a workspace without an id, or a member who cannot say whether they are suspended', async () => {
    const noId = sdk(() => json([{ name: 'x' }]));
    await expect(noId.client.workspaces.list()).rejects.toBeInstanceOf(MandalaError);
    const unsure = sdk(() => json([{ ...WORKSPACE_MEMBER, suspended: 'no' }]));
    await expect(unsure.client.workspaces.members(WORKSPACE.id)).rejects.toThrow(
      /whether they are suspended/,
    );
  });

  it('refuses an empty id before any request', async () => {
    const { rec, client } = sdk();
    await expect(client.workspaces.get('')).rejects.toBeInstanceOf(ValidationError);
    await expect(client.workspaces.members('')).rejects.toBeInstanceOf(ValidationError);
    expect(rec.calls).toHaveLength(0);
  });

  it('reads an id out of reach as not found, and a scoped key listing members as denied', async () => {
    const hidden = sdk(() => json({ error: 'workspace not found' }, { status: 404 }));
    await expect(hidden.client.workspaces.get('wsp-ffffffffffff')).rejects.toBeInstanceOf(
      NotFoundError,
    );
    const scoped = sdk(() =>
      json({ error: 'A key confined to a workspace cannot list members.' }, { status: 403 }),
    );
    await expect(scoped.client.workspaces.members(WORKSPACE.id)).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
  });

  it('creates, renames and deletes, sending { name } and nothing else', async () => {
    const { rec, client } = sdk();
    const made = await client.workspaces.create({ name: 'customer-acme' });
    expect(made).toEqual({
      id: WORKSPACE.id,
      name: WORKSPACE.name,
      createdAt: WORKSPACE.created_at,
      raw: WORKSPACE,
    });
    const renamed = await client.workspaces.rename(WORKSPACE.id, 'customer-acme-prod');
    expect(renamed.id).toBe(WORKSPACE.id);
    const gone = await client.workspaces.delete(WORKSPACE.id);
    expect(gone).toEqual({ revokedKeys: 2, raw: WORKSPACE_DELETED });
    expect(rec.routes()).toEqual([
      ['POST', 'workspaces'],
      ['PATCH', `workspaces/${WORKSPACE.id}`],
      ['DELETE', `workspaces/${WORKSPACE.id}`],
    ]);
    expect(rec.calls.map((c) => c.body)).toEqual([
      { name: 'customer-acme' },
      { name: 'customer-acme-prod' },
      undefined,
    ]);
  });

  it('refuses a missing or empty name, and an empty id, before any request', async () => {
    const { rec, client } = sdk();
    await expect(client.workspaces.create({ name: '' })).rejects.toBeInstanceOf(ValidationError);
    await expect(client.workspaces.create({ name: '   ' })).rejects.toBeInstanceOf(ValidationError);
    await expect(
      client.workspaces.create({} as unknown as { name: string }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      client.workspaces.create(undefined as unknown as { name: string }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      client.workspaces.rename(WORKSPACE.id, 7 as unknown as string),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(client.workspaces.rename('', 'x')).rejects.toBeInstanceOf(ValidationError);
    await expect(client.workspaces.delete('')).rejects.toBeInstanceOf(ValidationError);
    expect(rec.calls).toHaveLength(0);
  });

  it('refuses a delete answer that does not say how many keys it revoked', async () => {
    for (const answer of [{ ok: true }, { ok: true, revoked_keys: -1 }, { revoked_keys: 0 }, {}]) {
      const { client } = sdk(() => json(answer));
      await expect(client.workspaces.delete(WORKSPACE.id)).rejects.toBeInstanceOf(MandalaError);
    }
  });

  it('preserves an active-secret deletion conflict without retrying or deleting secrets', async () => {
    const message =
      'This workspace still holds 1 secret. Delete it first: a workspace that holds secrets cannot be deleted.';
    const body = { error: message, reason: 'unsupported' };
    const rec = recorder(() => json(body, { status: 409 }));
    const client = new Client({
      apiKey: 'com_test',
      baseUrl: BASE,
      fetch: rec.fetch,
      retries: { idempotent: 2 },
    });

    const error = await client.workspaces.delete(WORKSPACE.id).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ConflictError);
    expect(error).toMatchObject({ status: 409, reason: 'unsupported', message, body });
    expect(rec.routes()).toEqual([['DELETE', `workspaces/${WORKSPACE.id}`]]);
    expect(rec.last().body).toBeUndefined();
  });

  it('maps a scoped key or a non-owner to PermissionDeniedError and a foreign id to NotFoundError', async () => {
    const denied = sdk(() =>
      json(
        {
          error:
            'Workspaces cannot be created, renamed or deleted with a workspace-scoped API key.',
        },
        { status: 403 },
      ),
    );
    await expect(denied.client.workspaces.create({ name: 'x' })).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
    await expect(denied.client.workspaces.delete(WORKSPACE.id)).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
    const hidden = sdk(() => json({ error: 'workspace not found' }, { status: 404 }));
    await expect(hidden.client.workspaces.rename('wsp-ffffffffffff', 'x')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

/**
 * Creating into a workspace and listing one (platform OPL-5543): an
 * account-wide key names the workspace with `workspaceId`, and the listing
 * takes a workspace id or `'unassigned'`.
 */
describe('computers in a workspace', () => {
  it('sends workspace_id on create, launch and the listing', async () => {
    const { rec, client } = sdk();
    await client.computers.create({ template: 'base', workspaceId: WORKSPACE.id });
    expect(rec.last().body).toMatchObject({ template: 'base', workspace_id: WORKSPACE.id });

    rec.calls.length = 0;
    await client.computers.launch({ template: 'base', workspaceId: WORKSPACE.id }).catch(() => {});
    const create = rec.calls.find((c) => c.method === 'POST' && c.path === '/computers');
    expect(create?.body).toMatchObject({ workspace_id: WORKSPACE.id });

    await client.computers.list({ workspaceId: WORKSPACE.id });
    expect(rec.last().query).toEqual({ workspace_id: WORKSPACE.id });
    await client.computers.listWithStatus({ workspaceId: 'unassigned', state: 'live' });
    expect(rec.last().query).toEqual({ workspace_id: 'unassigned', state: 'live' });
  });

  it('sends neither without one', async () => {
    const { rec, client } = sdk();
    await client.computers.create({ template: 'base' });
    expect(rec.last().body).not.toHaveProperty('workspace_id');
    await client.computers.list();
    expect(rec.last().query).toEqual({});
  });

  it.each(['', ' wsp-0123456789ab', 7])(
    'refuses a workspace id the platform would refuse (%j), sending nothing',
    async (bad) => {
      const { rec, client } = sdk();
      await expect(
        client.computers.create({ template: 'base', workspaceId: bad as string }),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(client.computers.list({ workspaceId: bad as string })).rejects.toBeInstanceOf(
        ValidationError,
      );
      expect(rec.calls).toEqual([]);
    },
  );
});
