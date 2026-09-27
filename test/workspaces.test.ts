/**
 * `client.workspaces` (platform OPL-5057): the account's workspaces and the
 * people who reach one, read only.
 */

import { describe, expect, it } from 'vitest';
import {
  Client,
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
});
