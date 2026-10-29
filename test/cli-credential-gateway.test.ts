/** `mandala computers gateway`: a computer's credential gateway bindings from the command line. */

import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import type { CliIO } from '../src/cli-runtime.js';
import { Client } from '../src/index.js';
import {
  anyRoute,
  BASE,
  COMPUTER,
  GATEWAY_BINDING,
  json,
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

const ID = 'vm-0123456789ab';
const ROUTE = `computers/${ID}/credential-gateway`;
const BINDING = 'cgw-0123456789abcdef01234567';
const CREATE = [
  'computers',
  'gateway',
  'create',
  ID,
  '--secret-id',
  'csec-0123456789abcdef',
  '--origin',
  'https://api.github.com',
  '--path-prefix',
  '/repos/acme/app',
];

describe('mandala computers gateway', () => {
  it('lists by an id-shaped reference with no lookup', async () => {
    const h = harness();
    const result = await h.run(['computers', 'gateway', 'list', ID]);
    expect(result.code).toBe(0);
    expect(h.rec.routes()).toEqual([['GET', ROUTE]]);
    expect(result.frame.data).toEqual({ bindings: [GATEWAY_BINDING] });
  });

  it('finds a computer by name in one listing', async () => {
    const h = harness();
    const result = await h.run(['computers', 'gateway', 'list', COMPUTER.name]);
    expect(result.code).toBe(0);
    expect(h.rec.routes()).toEqual([
      ['GET', 'computers'],
      ['GET', `computers/${COMPUTER.id}/credential-gateway`],
    ]);
  });

  it('creates with repeated and comma-separated methods, in any case', async () => {
    const h = harness();
    const result = await h.run([...CREATE, '--method', 'get', '--method', 'post,PATCH']);
    expect(result.code).toBe(0);
    expect(h.rec.routes()).toEqual([['POST', ROUTE]]);
    expect(h.rec.last().body).toEqual({
      secret_id: 'csec-0123456789abcdef',
      origin: 'https://api.github.com',
      path_prefix: '/repos/acme/app',
      methods: ['GET', 'POST', 'PATCH'],
    });
    expect(result.frame.data).toEqual(GATEWAY_BINDING);
  });

  it.each([
    [['--method', 'CONNECT'], 'invalid_arguments'],
    [['--method', 'GET', '--origin2'], 'invalid_arguments'],
  ])('refuses %j before any request', async (extra, code) => {
    const h = harness();
    const result = await h.run([...CREATE, ...extra]);
    expect(result.code).not.toBe(0);
    expect(result.frame.error.code).toBe(code);
    expect(h.rec.calls).toHaveLength(0);
  });

  it('refuses a bad origin before resolving the computer', async () => {
    const h = harness();
    const args = [...CREATE, '--method', 'GET'];
    args[args.indexOf('https://api.github.com')] = 'http://api.github.com';
    const result = await h.run(args);
    expect(result.code).not.toBe(0);
    expect(result.frame.error.message).toMatch(/https origin/);
    expect(h.rec.calls).toHaveLength(0);
  });

  it('requires every flag of a create', async () => {
    const h = harness();
    const result = await h.run(CREATE);
    expect(result.code).not.toBe(0);
    expect(result.frame.error.message).toMatch(/--method/);
    expect(h.rec.calls).toHaveLength(0);
  });

  it('revokes by binding id', async () => {
    const h = harness();
    const result = await h.run(['computers', 'gateway', 'rm', ID, BINDING]);
    expect(result.code).toBe(0);
    expect(h.rec.routes()).toEqual([['DELETE', `${ROUTE}/${BINDING}`]]);
    expect(result.frame.data).toEqual({ id: BINDING, deleted: true });
  });

  it('passes on a missing binding as not found', async () => {
    const missing: Responder = (call) =>
      call.path.includes('/credential-gateway/')
        ? json({ error: 'binding not found' }, { status: 404 })
        : anyRoute(call);
    const h = harness(missing);
    const result = await h.run(['computers', 'gateway', 'rm', ID, BINDING]);
    expect(result.code).not.toBe(0);
    expect(result.frame.error.code).toBe('not_found');
  });
});
