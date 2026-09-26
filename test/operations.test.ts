/**
 * `client.operations` (platform OPL-5055): the read, the page, the wait, and
 * the `operationId` every lifecycle answer now carries.
 */

import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import type { CliIO } from '../src/cli-runtime.js';
import {
  Client,
  isTransient,
  MandalaError,
  NotFoundError,
  OperationFailedError,
  TimeoutError,
  ValidationError,
} from '../src/index.js';
import {
  anyRoute,
  BASE,
  COMPUTER,
  json,
  MOVE_STARTED,
  OPERATION,
  type Responder,
  recorder,
} from './harness.js';

function sdk(respond: Responder = anyRoute) {
  const rec = recorder(respond);
  return { rec, client: new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch }) };
}

const OP_ID = OPERATION.id;
const RUNNING = { ...OPERATION, state: 'running', finished_at: null };
const FAILED = {
  ...OPERATION,
  kind: 'create',
  state: 'failed',
  error: { code: 'start_failed', message: 'The computer was created and would not start.' },
};

/** Answers each read with the next body in turn, and the last one forever. */
const sequence = (...bodies: unknown[]): Responder => {
  let i = 0;
  return () => json(bodies[Math.min(i++, bodies.length - 1)]);
};

describe('client.operations.get', () => {
  it('reads GET operations/:id and decodes every field', async () => {
    const { rec, client } = sdk();
    const op = await client.operations.get(OP_ID);
    expect(rec.routes()).toEqual([['GET', `operations/${OP_ID}`]]);
    expect(rec.last().query).toEqual({});
    expect(op).toEqual({
      id: OP_ID,
      kind: 'clone',
      computerId: 'vm-2',
      state: 'succeeded',
      error: null,
      createdAt: OPERATION.created_at,
      updatedAt: OPERATION.updated_at,
      finishedAt: OPERATION.finished_at,
      raw: OPERATION,
    });
  });

  it('keeps a kind and a state it does not know, as the platform says it may add them', async () => {
    const { client } = sdk(() => json({ ...OPERATION, kind: 'delete', state: 'queued' }));
    const op = await client.operations.get(OP_ID);
    expect(op.kind).toBe('delete');
    expect(op.state).toBe('queued');
  });

  it('decodes a failed one with its error, and a restore with no computer', async () => {
    const { client } = sdk(() => json({ ...FAILED, kind: 'restore', computer_id: null }));
    const op = await client.operations.get(OP_ID);
    expect(op.error).toEqual(FAILED.error);
    expect(op.computerId).toBeNull();
  });

  it('refuses an answer a wait could not decide on', async () => {
    for (const bad of [
      { ...OPERATION, id: '' },
      { ...OPERATION, state: 7 },
      { ...OPERATION, kind: undefined },
      { ...OPERATION, error: 'start_failed' },
      { ...OPERATION, error: { code: 'start_failed' } },
      ['not', 'an', 'operation'],
    ]) {
      const { client } = sdk(() => json(bad));
      await expect(client.operations.get(OP_ID)).rejects.toThrow(MandalaError);
    }
  });

  it('refuses an empty id before sending anything', async () => {
    const { rec, client } = sdk();
    await expect(client.operations.get('')).rejects.toThrow(ValidationError);
    expect(rec.calls).toEqual([]);
  });
});

describe('client.operations.list', () => {
  it('sends every parameter in its wire spelling and decodes the page', async () => {
    const { rec, client } = sdk(() =>
      json({ operations: [OPERATION, RUNNING], next_cursor: 'op_00000000000000000000000a' }),
    );
    const page = await client.operations.list({
      computerId: 'vm-1',
      limit: 2,
      cursor: 'op_00000000000000000000000b',
    });
    expect(rec.routes()).toEqual([['GET', 'operations']]);
    expect(rec.last().query).toEqual({
      computer_id: 'vm-1',
      limit: '2',
      cursor: 'op_00000000000000000000000b',
    });
    expect(page.operations.map((o) => o.state)).toEqual(['succeeded', 'running']);
    expect(page.operations[1]?.finishedAt).toBeNull();
    expect(page.nextCursor).toBe('op_00000000000000000000000a');
  });

  it('sends nothing it was not given, and reads a last page as a null cursor', async () => {
    const { rec, client } = sdk();
    const page = await client.operations.list();
    expect(rec.last().query).toEqual({});
    expect(page.nextCursor).toBeNull();
  });

  it('refuses arguments the platform would 400, before sending', async () => {
    const { rec, client } = sdk();
    for (const args of [
      { limit: 0 },
      { limit: 101 },
      { limit: 1.5 },
      { computerId: '' },
      { computerId: ' vm-1' },
      { cursor: '' },
    ]) {
      await expect(client.operations.list(args)).rejects.toThrow(ValidationError);
    }
    expect(rec.calls).toEqual([]);
  });

  it('refuses a page whose cursor could not be walked', async () => {
    for (const next_cursor of [7, '', { id: 'x' }]) {
      const { client } = sdk(() => json({ operations: [], next_cursor }));
      await expect(client.operations.list()).rejects.toThrow(/next_cursor/);
    }
    const { client } = sdk(() => json([OPERATION]));
    await expect(client.operations.list()).rejects.toThrow(/list of operations/);
  });
});

describe('client.operations.wait', () => {
  it('polls through pending and running, and resolves on succeeded', async () => {
    const { rec, client } = sdk(
      sequence({ ...RUNNING, state: 'pending' }, RUNNING, RUNNING, OPERATION),
    );
    const op = await client.operations.wait(OP_ID, { timeoutMs: 5_000, pollMs: 1 });
    expect(op.state).toBe('succeeded');
    expect(rec.calls).toHaveLength(4);
    expect(new Set(rec.routes().map((r) => r[1]))).toEqual(new Set([`operations/${OP_ID}`]));
  });

  it('takes the operation itself as well as its id', async () => {
    const { rec, client } = sdk();
    const op = await client.operations.get(OP_ID);
    await client.operations.wait(op, { pollMs: 1 });
    expect(rec.calls).toHaveLength(2);
  });

  it('throws OperationFailedError carrying the code and the sentence on failed', async () => {
    const { rec, client } = sdk(sequence(RUNNING, FAILED));
    const err = await client.operations
      .wait(OP_ID, { timeoutMs: 5_000, pollMs: 1 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OperationFailedError);
    expect(err).toBeInstanceOf(MandalaError);
    const failed = err as OperationFailedError;
    expect(failed.code).toBe('start_failed');
    expect(failed.detail).toBe('The computer was created and would not start.');
    expect(failed.operation.id).toBe(OP_ID);
    expect(failed.message).toContain('start_failed');
    expect(failed.message).toContain('would not start');
    // A failed step is the platform's verdict, not a moment to retry through.
    expect(isTransient(failed)).toBe(false);
    expect(rec.calls).toHaveLength(2);
  });

  it('throws on a failed one with no error, rather than reporting it as succeeded', async () => {
    const { client } = sdk(() => json({ ...FAILED, error: null }));
    const err = (await client.operations
      .wait(OP_ID, { pollMs: 1 })
      .catch((e: unknown) => e)) as OperationFailedError;
    expect(err).toBeInstanceOf(OperationFailedError);
    expect(err.code).toBe('');
  });

  it('refuses a finished operation in a state it does not know, rather than polling it to the deadline', async () => {
    const { rec, client } = sdk(() => json({ ...OPERATION, state: 'cancelled' }));
    await expect(client.operations.wait(OP_ID, { timeoutMs: 5_000, pollMs: 1 })).rejects.toThrow(
      /finished in state "cancelled"/,
    );
    expect(rec.calls).toHaveLength(1);
  });

  it('polls through a live state it does not know', async () => {
    const { client } = sdk(sequence({ ...RUNNING, state: 'queued' }, OPERATION));
    await expect(client.operations.wait(OP_ID, { pollMs: 1 })).resolves.toMatchObject({
      state: 'succeeded',
    });
  });

  it('rides out a transient failure of a poll', async () => {
    let i = 0;
    const { client } = sdk(() =>
      i++ === 0 ? json({ error: 'down for a moment' }, { status: 503 }) : json(OPERATION),
    );
    await expect(client.operations.wait(OP_ID, { pollMs: 1 })).resolves.toMatchObject({
      state: 'succeeded',
    });
  });

  it('stops at once on an id it cannot see', async () => {
    const { rec, client } = sdk(() => json({ error: 'operation not found' }, { status: 404 }));
    await expect(client.operations.wait(OP_ID, { pollMs: 1 })).rejects.toThrow(NotFoundError);
    expect(rec.calls).toHaveLength(1);
  });

  it('times out on one that stays live, saying the operation did not stop', async () => {
    const { client } = sdk(() => json(RUNNING));
    await expect(client.operations.wait(OP_ID, { timeoutMs: 30, pollMs: 5 })).rejects.toThrow(
      TimeoutError,
    );
    await expect(client.operations.wait(OP_ID, { timeoutMs: 30, pollMs: 5 })).rejects.toThrow(
      /still running.*only this wait has/,
    );
  });

  it('refuses a missing id with a sentence about an answer that carried none', async () => {
    const { rec, client } = sdk();
    const vm = await client.computers.get('vm-1');
    await expect(client.operations.wait(vm.operationId as string)).rejects.toThrow(
      /carried no operationId/,
    );
    await expect(client.operations.wait(OP_ID, { pollMs: 0 })).rejects.toThrow(ValidationError);
    expect(rec.calls).toHaveLength(1);
  });
});

describe('operationId on lifecycle answers', () => {
  const WITH_OP = { ...COMPUTER, operation_id: 'op_000000000000000000000001' };

  it('is on a created and a cloned computer, and survives the refresh after it', async () => {
    const { client } = sdk((call) =>
      call.method === 'POST' ? json(WITH_OP, { status: 201 }) : json(COMPUTER),
    );
    const vm = await client.computers.create({ name: 'demo' });
    expect(vm.operationId).toBe('op_000000000000000000000001');
    await vm.refresh();
    expect(vm.operationId).toBe('op_000000000000000000000001');
    const copy = await vm.clone('copy');
    expect(copy.operationId).toBe('op_000000000000000000000001');
  });

  it('is on a create that would not boot, where it sits on the envelope', async () => {
    const { client } = sdk(() =>
      json(
        {
          computer: { ...COMPUTER, status: 'stopped' },
          start_error: 'no',
          operation_id: 'op_000000000000000000000002',
        },
        { status: 201 },
      ),
    );
    const vm = await client.computers.create();
    expect(vm.startError).toBe('no');
    expect(vm.operationId).toBe('op_000000000000000000000002');
  });

  it('is taken from a start, stop, suspend or restart acknowledgement before the refresh', async () => {
    for (const action of ['start', 'stop', 'suspend', 'restart'] as const) {
      const { rec, client } = sdk((call) =>
        call.method === 'POST'
          ? json({ ok: true, operation_id: `op_${action.padEnd(24, '0')}` })
          : json(COMPUTER),
      );
      const vm = await client.computers.get('vm-1');
      expect(vm.operationId).toBeUndefined();
      await vm[action]();
      expect(vm.operationId).toBe(`op_${action.padEnd(24, '0')}`);
      // The acknowledgement was followed by a read, which carries none.
      expect(rec.routes().at(-1)).toEqual(['GET', 'computers/vm-1']);
    }
  });

  it('is replaced by each lifecycle call, and cleared by one that answered none', async () => {
    let answer: unknown = { ok: true, operation_id: 'op_aaaaaaaaaaaaaaaaaaaaaaaa' };
    const { client } = sdk((call) => (call.method === 'GET' ? json(COMPUTER) : json(answer)));
    const vm = await client.computers.get('vm-1');
    await vm.stop();
    expect(vm.operationId).toBe('op_aaaaaaaaaaaaaaaaaaaaaaaa');
    answer = { ...COMPUTER, ram_mb: 8192, operation_id: 'op_bbbbbbbbbbbbbbbbbbbbbbbb' };
    await vm.update({ ramMb: 8192 });
    expect(vm.operationId).toBe('op_bbbbbbbbbbbbbbbbbbbbbbbb');
    // A rename starts no operation, and an older platform sends none.
    answer = { ...COMPUTER, name: 'renamed' };
    await vm.update({ name: 'renamed' });
    expect(vm.operationId).toBeUndefined();
  });

  it('reads anything that is not a non-empty string as absent, since the call already happened', async () => {
    for (const operation_id of [null, '', 7, { id: 'op' }]) {
      const { client } = sdk(() => json({ ...COMPUTER, operation_id }, { status: 201 }));
      const vm = await client.computers.create();
      expect(vm.operationId).toBeUndefined();
    }
  });

  it('is on a snapshot restore, which now answers what it acknowledged', async () => {
    const { client } = sdk(() => json({ ok: true, operation_id: 'op_cccccccccccccccccccccccc' }));
    const ack = await client.snapshots.restore('snap-1');
    expect(ack).toEqual({
      operationId: 'op_cccccccccccccccccccccccc',
      raw: { ok: true, operation_id: 'op_cccccccccccccccccccccccc' },
    });
    const { client: older } = sdk(() => json({ ok: true }));
    expect(await older.snapshots.restore('snap-1')).toEqual({ raw: { ok: true } });
  });

  it('is on the move a relocate accepted, and never on a listed one', async () => {
    const { client } = sdk((call) =>
      call.method === 'POST'
        ? json({ ...MOVE_STARTED, operation_id: 'op_dddddddddddddddddddddddd' }, { status: 202 })
        : call.path === '/moves'
          ? json({ moves: [MOVE_STARTED] })
          : json(COMPUTER),
    );
    const vm = await client.computers.get('vm-1');
    const move = await vm.relocate({ ramMb: 26000 });
    expect(move.operationId).toBe('op_dddddddddddddddddddddddd');
    const [listed] = await client.moves.list();
    expect(listed).not.toHaveProperty('operationId');
  });
});

function cli(respond: Responder = anyRoute) {
  const rec = recorder(respond);
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
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
      stdout.length = 0;
      stderr.length = 0;
      const code = await main(args, io);
      const out = Buffer.concat(stdout).toString();
      return { code, out, json: out.trim() ? JSON.parse(out) : undefined };
    },
  };
}

describe('mandala operations', () => {
  it('lists a page with its parameters, in the wire shape', async () => {
    const { rec, run } = cli(() =>
      json({ operations: [OPERATION], next_cursor: 'op_00000000000000000000000a' }),
    );
    const r = await run(['operations', 'list', '--computer', 'vm-2', '--limit', '1', '--json']);
    expect(r.code).toBe(0);
    expect(rec.last().query).toEqual({ computer_id: 'vm-2', limit: '1' });
    expect(r.json.data).toEqual({
      operations: [OPERATION],
      next_cursor: 'op_00000000000000000000000a',
    });
  });

  it('refuses a bad page size before any request', async () => {
    const { rec, run } = cli();
    const r = await run(['operations', 'list', '--limit', '500', '--json']);
    expect(r.code).not.toBe(0);
    expect(r.json.error.code).toBe('invalid_arguments');
    expect(rec.calls).toEqual([]);
  });

  it('gets one, and waits for one', async () => {
    const { rec, run } = cli(sequence(OPERATION, RUNNING, OPERATION));
    expect((await run(['operations', 'get', OP_ID, '--json'])).json.data).toEqual(OPERATION);
    const r = await run(['operations', 'wait', OP_ID, '--poll-ms', '1', '--json']);
    expect(r.code).toBe(0);
    expect(r.json.data.state).toBe('succeeded');
    expect(rec.calls).toHaveLength(3);
  });

  it('reports a failed operation as operation_failed, keeping the platform code as a detail', async () => {
    const { run } = cli(() => json(FAILED));
    const r = await run(['operations', 'wait', OP_ID, '--json']);
    expect(r.code).toBe(1);
    expect(r.json.error.code).toBe('operation_failed');
    expect(r.json.error.message).toContain('start_failed');
    expect(r.json.error.details.operation).toEqual(FAILED);
  });
});
