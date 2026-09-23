/** A computer's secret bindings: bound at create, read, and replaced (OPL-4974). */

import { describe, expect, it } from 'vitest';
import { Client, MandalaError, type SecretBindingArgs, ValidationError } from '../src/index.js';
import { BASE, COMPUTER, json, type Responder, recorder, SECRET_BINDINGS } from './harness.js';

const A = 'csec-0123456789abcdef';
const B = 'csec-0123456789abcde0';

const client = (respond: Responder) => {
  const rec = recorder(respond);
  return { rec, client: new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch }) };
};

const everything: Responder = (call) =>
  call.path.endsWith('/secrets') ? json(SECRET_BINDINGS) : json({ ...COMPUTER, id: 'vm-1' });

describe('binding secrets at create', () => {
  it('sends each binding in the wire spelling, as a variable or as a file', async () => {
    const { rec, client: c } = client(everything);
    await c.computers.create({
      template: 'base',
      secrets: [
        { secretId: A, env: 'API_TOKEN' },
        { secretId: B, file: 'kubeconfig' },
      ],
    });
    const create = rec.calls.find((x) => x.method === 'POST' && x.path === '/computers');
    expect((create?.body as Record<string, unknown>).secrets).toEqual([
      { secret_id: A, env: 'API_TOKEN' },
      { secret_id: B, file: 'kubeconfig' },
    ]);
  });

  it('sends no secrets key at all when none are bound', async () => {
    const { rec, client: c } = client(everything);
    await c.computers.create({ template: 'base' });
    const create = rec.calls.find((x) => x.method === 'POST' && x.path === '/computers');
    expect(create?.body).not.toHaveProperty('secrets');
  });

  it('refuses before sending what the platform would refuse', async () => {
    const { rec, client: c } = client(everything);
    const nine = Array.from({ length: 9 }, (_, i) => ({
      secretId: `csec-${String(i).repeat(16)}`,
      file: `f${i}`,
    }));
    const bad: [string, SecretBindingArgs[]][] = [
      ['both', [{ secretId: A, env: 'X', file: 'x' }]],
      ['neither', [{ secretId: A }]],
      ['a bad variable', [{ secretId: A, env: '1X' }]],
      ['a bad file name', [{ secretId: A, file: 'Ca.pem' }]],
      [
        'one secret twice',
        [
          { secretId: A, env: 'X' },
          { secretId: A, env: 'Y' },
        ],
      ],
      [
        'one variable twice',
        [
          { secretId: A, env: 'X' },
          { secretId: B, env: 'X' },
        ],
      ],
      [
        'one file twice',
        [
          { secretId: A, file: 'x' },
          { secretId: B, file: 'x' },
        ],
      ],
      ['nine files', nine],
    ];
    for (const [name, secrets] of bad) {
      await expect(c.computers.create({ template: 'base', secrets }), name).rejects.toThrow(
        ValidationError,
      );
    }
    // A variable and a file may share a spelling: two namespaces.
    await c.computers.create({
      template: 'base',
      secrets: [
        { secretId: A, env: 'ca' },
        { secretId: B, file: 'ca' },
      ],
    });
    expect(rec.calls.filter((x) => x.method === 'POST' && x.path === '/computers')).toHaveLength(1);
  });
});

describe('a computer’s bindings', () => {
  it('reads them typed, a file binding and all, with the version', async () => {
    const { client: c } = client(everything);
    const got = await (await c.computers.get('vm-1')).secrets();
    expect(got.version).toBe(3);
    expect(got.secrets).toEqual([
      { secretId: A, revisionId: 'csr-0123456789abcdef01234567', env: 'API_TOKEN' },
      { secretId: B, revisionId: 'csr-0123456789abcdef01234568', file: 'kubeconfig' },
    ]);
  });

  it('replaces them whole, with the version and a kept revision', async () => {
    const { rec, client: c } = client(everything);
    const vm = await c.computers.get('vm-1');
    await vm.setSecrets(
      [
        { secretId: A, env: 'API_TOKEN', revisionId: 'csr-0123456789abcdef01234567' },
        { secretId: B, file: 'kubeconfig' },
      ],
      { version: 3 },
    );
    const put = rec.calls.find((x) => x.method === 'PUT');
    expect(put?.path).toBe('/computers/vm-1/secrets');
    expect(put?.body).toEqual({
      secrets: [
        { secret_id: A, env: 'API_TOKEN', revision_id: 'csr-0123456789abcdef01234567' },
        { secret_id: B, file: 'kubeconfig' },
      ],
      version: 3,
    });
    await vm.setSecrets([]);
    expect(rec.calls.filter((x) => x.method === 'PUT').at(-1)?.body).toEqual({ secrets: [] });
    await expect(vm.setSecrets([], { version: -1 })).rejects.toThrow(ValidationError);
  });

  it('refuses an answer that is not a binding list', async () => {
    const { client: c } = client((call) =>
      call.path.endsWith('/secrets') ? json({ error: 'nope' }) : json({ ...COMPUTER, id: 'vm-1' }),
    );
    await expect((await c.computers.get('vm-1')).secrets()).rejects.toThrow(MandalaError);
  });
});
