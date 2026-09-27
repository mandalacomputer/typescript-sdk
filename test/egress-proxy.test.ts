import { describe, expect, it } from 'vitest';
import { Client, type EgressProxyArgs, MandalaError, ValidationError } from '../src/index.js';
import { BASE, COMPUTER, json, recorder } from './harness.js';

const CREDS = 'csec-0123456789abcdef';
const PROXY = { server: 'https://proxy.example.com:3128', credentials_secret_id: CREDS };

const client = (respond: Parameters<typeof recorder>[0] = () => json(COMPUTER)) => {
  const rec = recorder(respond);
  return { rec, client: new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch }) };
};

const read = async (fields: Record<string, unknown>) =>
  client(() => json({ ...COMPUTER, ...fields })).client.computers.get(COMPUTER.id);

describe('egressProxy on create', () => {
  it('sends the server and the credentials id, exactly', async () => {
    const { rec, client: c } = client(() => json(COMPUTER, { status: 201 }));
    await c.computers.create({
      template: 'base',
      start: false,
      egressProxy: { server: PROXY.server, credentialsSecretId: CREDS },
    });
    expect(rec.last()).toMatchObject({ method: 'POST', path: '/computers' });
    expect(rec.last()!.body).toEqual({ template: 'base', start: false, egress_proxy: PROXY });
    await c.computers.create({
      template: 'base',
      egressProxy: { server: 'socks5://p.example:1080' },
    });
    expect(rec.last()!.body).toEqual({
      template: 'base',
      start: true,
      egress_proxy: { server: 'socks5://p.example:1080' },
    });
  });

  it('refuses a key an egress proxy does not have, before any request', async () => {
    const { rec, client: c } = client();
    const bad: unknown[] = [
      { server: PROXY.server, bypass: ['<local>'] },
      { server: PROXY.server, credentials_secret_id: CREDS },
      { server: PROXY.server, credentialsSecretId: 'not-an-id' },
      { server: '' },
      { credentialsSecretId: CREDS },
      'https://proxy.example.com:3128',
    ];
    for (const egressProxy of bad) {
      await expect(
        c.computers.create({ template: 'base', egressProxy: egressProxy as EgressProxyArgs }),
        JSON.stringify(egressProxy),
      ).rejects.toThrow(ValidationError);
    }
    await expect(
      c.computers.create({
        template: 'base',
        egressProxy: { server: PROXY.server, bypass: ['a.com'] } as EgressProxyArgs,
      }),
    ).rejects.toThrow(/no bypass list/);
    expect(rec.calls).toHaveLength(0);
  });
});

describe('egressProxy on update', () => {
  it('sends it alone, and null to remove it', async () => {
    const { rec, client: c } = client();
    const computer = await c.computers.get(COMPUTER.id);
    await computer.update({ egressProxy: { server: PROXY.server, credentialsSecretId: CREDS } });
    expect(rec.last()).toMatchObject({ method: 'PATCH', path: `/computers/${COMPUTER.id}` });
    expect(rec.last()!.body).toEqual({ egress_proxy: PROXY });
    await computer.update({ egressProxy: null });
    expect(rec.last()!.body).toEqual({ egress_proxy: null });
  });

  it('refuses it beside any other field, before any request', async () => {
    const { rec, client: c } = client();
    const computer = await c.computers.get(COMPUTER.id);
    const before = rec.calls.length;
    for (const other of [
      { name: 'renamed' },
      { cpu: 2 },
      { ramMb: 4096 },
      { diskGb: 80 },
      { idleSuspendMin: 30 },
      { idleSuspendMin: null },
      { browserProxy: null },
    ]) {
      for (const egressProxy of [{ server: PROXY.server }, null]) {
        await expect(
          computer.update({ ...other, egressProxy }),
          JSON.stringify(other),
        ).rejects.toThrow(/egressProxy travels alone/);
      }
    }
    expect(rec.calls).toHaveLength(before);
  });

  it('keeps the credentials id through a read, a spread and an update', async () => {
    const { rec, client: c } = client(() => json({ ...COMPUTER, egress_proxy: PROXY }));
    const computer = await c.computers.get(COMPUTER.id);
    expect(computer.egressProxy).toEqual({ server: PROXY.server, credentialsSecretId: CREDS });
    await computer.update({ egressProxy: computer.egressProxy! });
    expect(rec.last()!.body).toEqual({ egress_proxy: PROXY });
  });
});

describe('egressProxy on the computer', () => {
  it('reads the setting with and without credentials, leaving out unknown fields', async () => {
    const withCreds = await read({ egress_proxy: { ...PROXY, later: 'field' } });
    expect(withCreds.egressProxy).toEqual({ server: PROXY.server, credentialsSecretId: CREDS });
    const bare = await read({ egress_proxy: { server: 'http://p.example:3128' } });
    expect(bare.egressProxy).toEqual({ server: 'http://p.example:3128' });
    const nullCreds = await read({
      egress_proxy: { server: 'http://p.example:3128', credentials_secret_id: null },
    });
    expect(nullCreds.egressProxy).toEqual({ server: 'http://p.example:3128' });
    expect((await read({})).egressProxy).toBeUndefined();
  });

  it('refuses a value it cannot read rather than dropping it', async () => {
    for (const value of [
      'https://proxy.example.com:3128',
      {},
      { server: '' },
      { server: 7 },
      { server: PROXY.server, credentials_secret_id: '' },
      { server: PROXY.server, credentials_secret_id: 7 },
    ]) {
      const c = await read({ egress_proxy: value });
      expect(() => c.egressProxy, JSON.stringify(value)).toThrow(MandalaError);
    }
  });

  it('reads egressProxyPending: true, absent or refused', async () => {
    expect(
      (await read({ egress_proxy: PROXY, egress_proxy_pending: true })).egressProxyPending,
    ).toBe(true);
    expect((await read({ egress_proxy: PROXY })).egressProxyPending).toBe(false);
    expect((await read({ egress_proxy_pending: false })).egressProxyPending).toBe(false);
    const odd = await read({ egress_proxy_pending: 'yes' });
    expect(() => odd.egressProxyPending).toThrow(/egress_proxy_pending to be a boolean/);
  });
});
