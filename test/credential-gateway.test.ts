/** Credential gateway bindings: a secret sent upstream for a computer, never delivered to it. */

import { describe, expect, it } from 'vitest';
import {
  Client,
  ConflictError,
  MandalaError,
  NotFoundError,
  PermissionDeniedError,
  ValidationError,
} from '../src/index.js';
import { anyRoute, BASE, GATEWAY_BINDING, json, type Responder, recorder } from './harness.js';

const handle = async (respond: Responder = anyRoute) => {
  const rec = recorder(respond);
  const client = new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch });
  const computer = await client.computers.get('vm-1');
  rec.calls.length = 0;
  return { rec, client, computer };
};

/** Answer the gateway routes with `body`, everything else as usual. */
const gateway =
  (body: unknown, status = 200): Responder =>
  (call) =>
    call.path.includes('/credential-gateway') ? json(body, { status }) : anyRoute(call);

const ARGS = {
  secretId: 'csec-0123456789abcdef',
  origin: 'https://api.github.com',
  pathPrefix: '/repos/acme/app',
  methods: ['GET', 'POST'],
} as const;
const args = (over: Record<string, unknown> = {}) =>
  ({ ...ARGS, methods: [...ARGS.methods], ...over }) as never;

describe('listing a computer’s bindings', () => {
  it('reads every field, the address and placeholder included', async () => {
    const { rec, computer } = await handle();
    const list = await computer.credentialGatewayBindings();
    expect(rec.routes()).toEqual([['GET', 'computers/vm-1/credential-gateway']]);
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual({
      id: 'cgw-0123456789abcdef01234567',
      computerId: 'vm-1',
      secretId: 'csec-0123456789abcdef',
      origin: 'https://api.github.com',
      pathPrefix: '/repos/acme/app',
      methods: ['GET'],
      authHeader: 'authorization',
      createdAt: '2026-10-29T00:00:00.000Z',
      baseUrl: 'http://gateway.invalid/cgw-0123456789abcdef01234567',
      placeholder: 'mandala-placeholder',
      raw: GATEWAY_BINDING,
    });
  });

  // A platform from before the field sends nothing, which means a Bearer token.
  it.each([
    ['x-api-key', 'x-api-key'],
    [undefined, 'authorization'],
    [null, 'authorization'],
    ['', 'authorization'],
    ['x-other-key', 'x-other-key'],
  ])('reads auth_header %j as %j', async (sent, read) => {
    const { computer } = await handle(
      gateway({ bindings: [{ ...GATEWAY_BINDING, auth_header: sent }] }),
    );
    const [row] = await computer.credentialGatewayBindings();
    expect(row!.authHeader).toBe(read);
  });

  it('reads an empty list', async () => {
    const { computer } = await handle(gateway({ bindings: [] }));
    expect(await computer.credentialGatewayBindings()).toEqual([]);
  });

  // A binding this client cannot read is a credential in use that the caller
  // never sees, and so never revokes: the answer is refused instead.
  it.each([
    ['no id', { ...GATEWAY_BINDING, id: '' }],
    ['no origin', { ...GATEWAY_BINDING, origin: undefined }],
    ['no path prefix', { ...GATEWAY_BINDING, path_prefix: null }],
    ['no base_url', { ...GATEWAY_BINDING, base_url: undefined }],
    ['no placeholder', { ...GATEWAY_BINDING, placeholder: '' }],
    ['no secret id', { ...GATEWAY_BINDING, secret_id: 7 }],
    ['methods that are not a list', { ...GATEWAY_BINDING, methods: 'GET' }],
    ['no methods', { ...GATEWAY_BINDING, methods: [] }],
    ['a method it cannot read', { ...GATEWAY_BINDING, methods: ['GET', 'CONNECT'] }],
    ['a row that is not an object', 'cgw-0123456789abcdef01234567'],
  ])('refuses a listing with a row carrying %s', async (_what, row) => {
    const { computer } = await handle(gateway({ bindings: [row] }));
    await expect(computer.credentialGatewayBindings()).rejects.toThrow(MandalaError);
  });

  it.each([
    ['no list', {}],
    ['a bare list', [GATEWAY_BINDING]],
  ])('refuses an answer with %s', async (_what, body) => {
    const { computer } = await handle(gateway(body));
    await expect(computer.credentialGatewayBindings()).rejects.toThrow(MandalaError);
  });
});

describe('making one', () => {
  it('sends the wire spelling of exactly what was given, and reads the binding back', async () => {
    const { rec, computer } = await handle();
    const made = await computer.createCredentialGatewayBinding(args());
    expect(rec.last().method).toBe('POST');
    expect(rec.last().path).toBe('/computers/vm-1/credential-gateway');
    expect(rec.last().body).toEqual({
      secret_id: 'csec-0123456789abcdef',
      origin: 'https://api.github.com',
      path_prefix: '/repos/acme/app',
      methods: ['GET', 'POST'],
    });
    expect(made.id).toBe('cgw-0123456789abcdef01234567');
    expect(made.baseUrl).toBe(GATEWAY_BINDING.base_url);
  });

  it.each(['x-api-key', 'authorization'] as const)(
    'sends authHeader %j as auth_header',
    async (authHeader) => {
      const { rec, computer, client } = await handle();
      await computer.createCredentialGatewayBinding(args({ authHeader }));
      expect(rec.last().body).toMatchObject({ auth_header: authHeader });
      await client.credentialGateway.create('vm-1', args({ authHeader }));
      expect(rec.last().body).toMatchObject({ auth_header: authHeader });
    },
  );

  // Left out, an older platform that does not know the field still takes it.
  it.each([undefined, null])('sends no auth_header for %j', async (authHeader) => {
    const { rec, computer } = await handle();
    await computer.createCredentialGatewayBinding(args({ authHeader }));
    expect(rec.last().body).not.toHaveProperty('auth_header');
  });

  it('takes / as every path, and an origin with its trailing slash', async () => {
    const { rec, computer } = await handle();
    await computer.createCredentialGatewayBinding(
      args({ origin: 'https://api.example.com/', pathPrefix: '/', methods: ['DELETE'] }),
    );
    expect(rec.last().body).toMatchObject({ origin: 'https://api.example.com/', path_prefix: '/' });
  });

  it.each([
    [{ secretId: undefined }, 'secretId'],
    [{ secretId: 'my-secret' }, 'csec-'],
    [{ origin: 'http://api.github.com' }, 'https origin'],
    [{ origin: 'https://api.github.com/repos' }, 'https origin'],
    [{ origin: 'https://api.github.com:8443' }, 'https origin'],
    [{ origin: 'https://user@api.github.com' }, 'https origin'],
    [{ origin: 'https://api.github.com?x=1' }, 'https origin'],
    [{ origin: 'https://10.0.0.1' }, 'https origin'],
    [{ origin: 'https://[::1]' }, 'https origin'],
    [{ origin: 'https://localhost' }, 'https origin'],
    [{ origin: 'api.github.com' }, 'https URL'],
    [{ origin: `https://${'a'.repeat(260)}.com` }, '256'],
    [{ pathPrefix: 'repos' }, 'absolute path'],
    [{ pathPrefix: '//repos' }, 'absolute path'],
    [{ pathPrefix: '/repos//x' }, 'absolute path'],
    [{ pathPrefix: '/repos/../admin' }, 'absolute path'],
    [{ pathPrefix: '/repos/%2e%2e' }, 'absolute path'],
    [{ pathPrefix: '/repos%2Fx' }, 'absolute path'],
    [{ pathPrefix: '/repos?x=1' }, 'absolute path'],
    [{ pathPrefix: '/repos#x' }, 'absolute path'],
    [{ pathPrefix: '/a b' }, 'absolute path'],
    [{ pathPrefix: '/caf\u00e9' }, 'absolute path'],
    [{ pathPrefix: '/a\\b' }, 'absolute path'],
    [{ pathPrefix: '/%zz' }, 'absolute path'],
    [{ methods: [] }, 'one to six'],
    [{ methods: 'GET' }, 'one to six'],
    [{ methods: ['get'] }, 'may be GET'],
    [{ methods: ['CONNECT'] }, 'may be GET'],
    [{ methods: ['GET', 'GET'] }, 'must not repeat'],
    [{ authHeader: 'X-API-Key' }, 'authHeader must be'],
    [{ authHeader: 'bearer' }, 'authHeader must be'],
    [{ authHeader: 7 }, 'authHeader must be'],
  ])('refuses %j before anything is sent', async (over, says) => {
    const { rec, computer, client } = await handle();
    await expect(computer.createCredentialGatewayBinding(args(over))).rejects.toThrow(
      ValidationError,
    );
    await expect(client.credentialGateway.create('vm-1', args(over))).rejects.toThrow(says);
    expect(rec.calls).toHaveLength(0);
  });

  it('refuses arguments that are not an object', async () => {
    const { computer } = await handle();
    await expect(computer.createCredentialGatewayBinding(null as never)).rejects.toThrow(
      ValidationError,
    );
  });

  it('passes the platform’s refusals on as their errors', async () => {
    const full: Responder = (call) =>
      call.path.endsWith('/credential-gateway')
        ? json({ error: 'A computer can have at most 8 gateway bindings.' }, { status: 409 })
        : anyRoute(call);
    const { computer } = await handle(full);
    await expect(computer.createCredentialGatewayBinding(args())).rejects.toThrow(ConflictError);

    const off: Responder = (call) =>
      call.path.endsWith('/credential-gateway')
        ? json({ error: 'Credential gateway is unavailable for this account.' }, { status: 403 })
        : anyRoute(call);
    const { computer: other } = await handle(off);
    await expect(other.createCredentialGatewayBinding(args())).rejects.toThrow(
      PermissionDeniedError,
    );
  });

  it('refuses a created binding it cannot read', async () => {
    const { computer } = await handle(gateway({ ...GATEWAY_BINDING, base_url: '' }, 201));
    await expect(computer.createCredentialGatewayBinding(args())).rejects.toThrow(MandalaError);
  });
});

describe('revoking one', () => {
  it('deletes by id, on a handle and by the computer’s id', async () => {
    const { rec, computer, client } = await handle();
    await computer.deleteCredentialGatewayBinding('cgw-0123456789abcdef01234567');
    await client.credentialGateway.delete('vm-0123456789ab', 'cgw-0123456789abcdef01234567');
    expect(rec.routes()).toEqual([
      ['DELETE', 'computers/vm-1/credential-gateway/cgw-0123456789abcdef01234567'],
      ['DELETE', 'computers/vm-0123456789ab/credential-gateway/cgw-0123456789abcdef01234567'],
    ]);
  });

  it('refuses an id that would not name one binding, before anything is sent', async () => {
    const { rec, computer } = await handle();
    for (const bad of ['', '..', '.']) {
      await expect(computer.deleteCredentialGatewayBinding(bad)).rejects.toThrow(ValidationError);
    }
    expect(rec.calls).toHaveLength(0);
  });

  it('is a NotFoundError for a binding that is not there', async () => {
    const { computer } = await handle(gateway({ error: 'binding not found' }, 404));
    await expect(
      computer.deleteCredentialGatewayBinding('cgw-0123456789abcdef01234567'),
    ).rejects.toThrow(NotFoundError);
  });
});
