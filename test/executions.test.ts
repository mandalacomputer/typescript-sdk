import { describe, expect, it } from 'vitest';
import {
  Client,
  type ExecutionMetadata,
  type ExecutionOutputOptions,
  MandalaError,
  ValidationError,
} from '../src/index.js';
import { anyRoute, BASE, EXEC_STARTED, json, recorder } from './harness.js';

const ID = 'exec_0123456789abcdef0123456789abcdef';
const metadata = {
  execution_id: ID,
  computer_id: 'vm-1',
  pid: 42,
  status: 'running',
  started_at: '2026-09-15T12:00:00Z',
  output_source: 'volatile_guest_files',
};
const output = {
  execution_id: ID,
  stdout_b64: 'AP/i',
  stderr_b64: '',
  stdout_offset: 3,
  stderr_offset: 0,
  stdout_more: false,
  stderr_more: false,
  diagnostic_b64: 'ZGlhZw==',
  diagnostic_truncated: false,
};

const setup = async (body: unknown, status = 200) => {
  const rec = recorder((call) =>
    call.path.includes('/executions/') ? json(body, { status }) : anyRoute(call),
  );
  const c = await new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch }).computers.get(
    'vm-1',
  );
  return { c, rec };
};
const zero = { stdoutOffset: 0, stderrOffset: 0 };
const OTHER = 'exec_ffffffffffffffffffffffffffffffff';

describe('stable execution foundation', () => {
  it('preserves the stable identity on an accepted background command', async () => {
    const rec = recorder((call) =>
      call.path.endsWith('/exec') ? json({ ...EXEC_STARTED, execution_id: ID }) : anyRoute(call),
    );
    const c = await new Client({
      apiKey: 'com_test',
      baseUrl: BASE,
      fetch: rec.fetch,
    }).computers.get('vm-1');
    const accepted = await c.execBackground('printf hello');
    expect(accepted.executionId).toBe(ID);
    expect(rec.routes()).toEqual([
      ['GET', 'computers/vm-1'],
      ['POST', 'computers/vm-1/exec'],
    ]);
  });

  it('reads metadata exactly once without running or resuming a command', async () => {
    const rec = recorder((call) =>
      call.path.includes('/executions/') ? json(metadata) : anyRoute(call),
    );
    const c = await new Client({
      apiKey: 'com_test',
      baseUrl: BASE,
      fetch: rec.fetch,
    }).computers.get('vm-1');
    expect(await c.execution(ID)).toMatchObject({
      executionId: ID,
      computerId: 'vm-1',
      status: 'running',
    });
    expect(rec.routes()).toEqual([
      ['GET', 'computers/vm-1'],
      ['GET', `computers/vm-1/executions/${ID}`],
    ]);
  });

  it('lets two readers start at zero beside a consuming legacy poll', async () => {
    let consumed = false;
    const rec = recorder((call) => {
      if (call.path.endsWith('/output')) return json(output);
      if (call.path.endsWith('/exec/42')) {
        const answer = {
          ...EXEC_STARTED,
          stdout_b64: consumed ? '' : output.stdout_b64,
          stderr_b64: consumed ? '' : output.diagnostic_b64,
        };
        consumed = true;
        return json(answer);
      }
      return anyRoute(call);
    });
    const c = await new Client({
      apiKey: 'com_test',
      baseUrl: BASE,
      fetch: rec.fetch,
    }).computers.get('vm-1');
    const first = await c.executionOutput(ID, { stdoutOffset: 0, stderrOffset: 0 });
    const legacy = await c.execPoll(42);
    const second = await c.executionOutput(ID, { stdoutOffset: 0, stderrOffset: 0 });
    expect(first.stdout).toEqual(new Uint8Array([0, 255, 226]));
    expect(second).toEqual(first);
    expect(legacy.stdout).toEqual(first.stdout);
    expect(legacy.stderr).toEqual(first.diagnostic);
    expect(first).toMatchObject({
      stdoutOffset: 3,
      stderrOffset: 0,
      stdoutMore: false,
      stderrMore: false,
    });
    expect(first.diagnostic).toEqual(new TextEncoder().encode('diag'));
    expect(
      rec.calls.filter((call) => call.path.endsWith('/output')).map((call) => call.query),
    ).toEqual([
      { stdout_offset: '0', stderr_offset: '0' },
      { stdout_offset: '0', stderr_offset: '0' },
    ]);
    expect(rec.routes()).toEqual([
      ['GET', 'computers/vm-1'],
      ['GET', `computers/vm-1/executions/${ID}/output`],
      ['GET', 'computers/vm-1/exec/42'],
      ['GET', `computers/vm-1/executions/${ID}/output`],
    ]);
    const drained = await c.execPoll(42);
    expect(drained.stdout).toHaveLength(0);
    expect(drained.stderr).toHaveLength(0);
  });
});

describe('execution identity and observations', () => {
  it.each(['running', 'lost', 'exited'] as const)(
    'preserves %s without inventing exit evidence',
    async (status) => {
      const ended = '2026-09-15T12:00:01.123456789Z';
      const { c } = await setup({
        ...metadata,
        status,
        ...(status === 'exited' ? { ended_at: ended, exit_code: -9 } : {}),
      });
      const observed: ExecutionMetadata = await c.execution(ID);
      expect(observed.status).toBe(status);
      if (observed.status === 'exited') {
        expect(observed.exitCode).toBe(-9);
        expect(observed.endedAt).toBe(ended);
      } else {
        expect(observed.exitCode).toBeUndefined();
        expect(observed.endedAt).toBeUndefined();
      }
      expect(observed.outputSource).toBe('volatile_guest_files');
    },
  );

  it.each([
    {},
    { execution_id: OTHER },
    { execution_id: null },
    { computer_id: 'vm-other' },
    { pid: 0 },
    { pid: 0.5 },
    { pid: '42' },
    { pid: 9007199254740992 },
    { status: 'complete' },
    { status: null },
    { output_source: 'retained' },
    { started_at: null },
    { started_at: '2026-02-30T12:00:00Z' },
    { started_at: '2026-09-15T24:00:00Z' },
    { started_at: 'yesterday' },
    { status: 'running', exit_code: 0 },
    { status: 'lost', ended_at: null },
    { status: 'exited' },
    { status: 'exited', ended_at: '2026-09-15T12:00:01Z', exit_code: '0' },
    { status: 'exited', ended_at: '2026-09-15T12:00:01Z', exit_code: 0.5 },
  ])('rejects missing, mismatched or contradictory metadata %j', async (patch) => {
    const { c, rec } = await setup(Object.keys(patch).length ? { ...metadata, ...patch } : {});
    await expect(c.execution(ID)).rejects.toBeInstanceOf(MandalaError);
    expect(rec.calls).toHaveLength(2);
  });

  it('does not retarget an old execution after PID reuse', async () => {
    const rec = recorder((call) => {
      if (call.path.endsWith(`/executions/${ID}`))
        return json({ error: 'unavailable', code: 'execution_unavailable' }, { status: 404 });
      if (call.path.endsWith(`/executions/${OTHER}`))
        return json({ ...metadata, execution_id: OTHER });
      if (call.path.endsWith('/exec/42'))
        return json({ ...EXEC_STARTED, pid: 42, execution_id: OTHER });
      return anyRoute(call);
    });
    const c = await new Client({
      apiKey: 'com_test',
      baseUrl: BASE,
      fetch: rec.fetch,
    }).computers.get('vm-1');
    await expect(c.execution(ID)).rejects.toMatchObject({ status: 404 });
    expect((await c.execPoll(42)).executionId).toBe(OTHER);
    expect((await c.execution(OTHER)).executionId).toBe(OTHER);
    expect(rec.routes()).toEqual([
      ['GET', 'computers/vm-1'],
      ['GET', `computers/vm-1/executions/${ID}`],
      ['GET', 'computers/vm-1/exec/42'],
      ['GET', `computers/vm-1/executions/${OTHER}`],
    ]);
  });

  it.each([
    undefined,
    null,
    '',
    '42',
    `exec_${'A'.repeat(32)}`,
    `${ID}\n`,
    '..',
    `${ID}/output`,
    new String(ID),
  ])('rejects invalid request IDs before any execution request: %s', async (id) => {
    const { c, rec } = await setup(metadata);
    await expect(c.execution(id as string)).rejects.toBeInstanceOf(ValidationError);
    await expect(c.executionOutput(id as string, zero)).rejects.toBeInstanceOf(ValidationError);
    expect(rec.calls).toHaveLength(1);
  });

  it.each(['start', 'poll', 'kill'] as const)(
    'preserves older omission and validates IDs on legacy %s',
    async (method) => {
      for (const id of [undefined, ID, OTHER, null, '', `${ID}\n`, 'exec_bad']) {
        const rec = recorder((call) =>
          call.path.includes('/exec')
            ? json({ ...EXEC_STARTED, ...(id === undefined ? {} : { execution_id: id }) })
            : anyRoute(call),
        );
        const c = await new Client({
          apiKey: 'com_test',
          baseUrl: BASE,
          fetch: rec.fetch,
        }).computers.get('vm-1');
        const call =
          method === 'start'
            ? c.execBackground('true')
            : method === 'poll'
              ? c.execPoll(42)
              : c.execKill(42);
        if (id === undefined || id === ID || id === OTHER)
          expect((await call).executionId).toBe(id);
        else await expect(call).rejects.toBeInstanceOf(MandalaError);
        expect(rec.calls).toHaveLength(2);
      }
    },
  );
});

describe('independent byte cursors', () => {
  it('preserves split UTF-8, independent stderr and repeated diagnostics through current EOF', async () => {
    const chunks = [
      {
        ...output,
        stdout_b64: '4g==',
        stderr_b64: 'AA==',
        stdout_offset: 1,
        stderr_offset: 1,
        stdout_more: true,
        stderr_more: true,
      },
      { ...output, stdout_b64: 'gqw=', stdout_offset: 3, stderr_offset: 1 },
      { ...output, stdout_b64: '', stdout_offset: 3, stderr_offset: 1 },
      { ...output, stdout_b64: 'IQ==', stdout_offset: 4, stderr_offset: 1 },
    ];
    const rec = recorder((call) =>
      call.path.endsWith('/output') ? json(chunks.shift()) : anyRoute(call),
    );
    const c = await new Client({
      apiKey: 'com_test',
      baseUrl: BASE,
      fetch: rec.fetch,
    }).computers.get('vm-1');
    const first = await c.executionOutput(ID, { ...zero, limit: 1 });
    const second = await c.executionOutput(ID, {
      stdoutOffset: first.stdoutOffset,
      stderrOffset: first.stderrOffset,
      limit: 2,
    });
    const empty = await c.executionOutput(ID, {
      stdoutOffset: second.stdoutOffset,
      stderrOffset: second.stderrOffset,
    });
    const later = await c.executionOutput(ID, {
      stdoutOffset: empty.stdoutOffset,
      stderrOffset: empty.stderrOffset,
    });
    const decoder = new TextDecoder();
    expect(
      decoder.decode(first.stdout, { stream: true }) +
        decoder.decode(second.stdout, { stream: true }),
    ).toBe('€');
    expect(first.stderr).toEqual(new Uint8Array([0]));
    expect(empty.stdout).toHaveLength(0);
    expect(later.stdout).toEqual(new Uint8Array([33]));
    for (const chunk of [first, second, empty, later])
      expect(chunk.diagnostic).toEqual(new TextEncoder().encode('diag'));
    expect(rec.calls.slice(1).map((call) => call.query)).toEqual([
      { stdout_offset: '0', stderr_offset: '0', limit: '1' },
      { stdout_offset: '1', stderr_offset: '1', limit: '2' },
      { stdout_offset: '3', stderr_offset: '1' },
      { stdout_offset: '3', stderr_offset: '1' },
    ]);
  });

  it.each([
    undefined,
    null,
    {},
    { stdoutOffset: 0 },
    { stderrOffset: 0 },
    { ...zero, stdoutOffset: '0' },
    { ...zero, stderrOffset: -1 },
    { ...zero, stdoutOffset: 0.5 },
    { ...zero, stdoutOffset: Number.NaN },
    { ...zero, stderrOffset: Infinity },
    { ...zero, stdoutOffset: Number.MAX_SAFE_INTEGER },
    { ...zero, stderrOffset: Number.MAX_SAFE_INTEGER - 65535 },
    { ...zero, limit: 0 },
    { ...zero, limit: 1048577 },
    { ...zero, limit: 1.5 },
    { ...zero, limit: '1' },
    { ...zero, limit: null },
  ])('refuses invalid or absent offset/limit options %j before dispatch', async (opts) => {
    const { c, rec } = await setup(output);
    await expect(c.executionOutput(ID, opts as ExecutionOutputOptions)).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(rec.calls).toHaveLength(1);
  });

  it.each([1, 65536, 1048576])(
    'accepts the safe upper offset boundary with limit %i',
    async (limit) => {
      const offset = Number.MAX_SAFE_INTEGER - limit;
      const { c, rec } = await setup({
        ...output,
        stdout_b64: '',
        stdout_offset: offset,
        stderr_offset: offset,
      });
      const chunk = await c.executionOutput(ID, {
        stdoutOffset: offset,
        stderrOffset: offset,
        limit,
      });
      expect(chunk.stdoutOffset).toBe(offset);
      expect(chunk.stderrOffset).toBe(offset);
      expect(rec.last().query).toEqual({
        stdout_offset: String(offset),
        stderr_offset: String(offset),
        limit: String(limit),
      });
    },
  );

  it('decodes the maximum allowed binary stream and diagnostic without truncating either', async () => {
    const content = Buffer.alloc(1048576, 255);
    const diagnostic = Buffer.alloc(65536, 0);
    const { c } = await setup({
      ...output,
      stdout_b64: content.toString('base64'),
      stdout_offset: content.length,
      stdout_more: true,
      diagnostic_b64: diagnostic.toString('base64'),
      diagnostic_truncated: true,
    });
    const chunk = await c.executionOutput(ID, { ...zero, limit: 1048576 });
    expect(chunk.stdout).toBeInstanceOf(Uint8Array);
    expect(chunk.diagnostic).toBeInstanceOf(Uint8Array);
    expect(content.equals(chunk.stdout)).toBe(true);
    expect(diagnostic.equals(chunk.diagnostic)).toBe(true);
    expect(chunk.diagnosticTruncated).toBe(true);
  });

  it.each([
    { execution_id: OTHER },
    { stdout_b64: null },
    { stdout_b64: 'AA' },
    { stdout_b64: 'AA==\n' },
    { stdout_b64: 'AB==' },
    { stderr_b64: 'AAB=' },
    { diagnostic_b64: '**==' },
    { stdout_b64: '====' },
    { stdout_b64: '_w==' },
    { stdout_b64: 'AAAA=' },
    { stdout_offset: 0 },
    { stderr_offset: 1 },
    { stdout_offset: '3' },
    { stdout_offset: 9007199254740992 },
    { stdout_more: 'false' },
    { stderr_more: null },
    { stdout_more: true },
    { diagnostic_truncated: 0 },
    { diagnostic_b64: Buffer.alloc(65537).toString('base64') },
  ])('rejects invalid byte or cursor evidence %j', async (patch) => {
    const { c, rec } = await setup({ ...output, ...patch });
    await expect(c.executionOutput(ID, zero)).rejects.toBeInstanceOf(MandalaError);
    expect(rec.calls).toHaveLength(2);
  });

  it('rejects a stream exceeding the requested limit', async () => {
    const { c } = await setup(output);
    await expect(c.executionOutput(ID, { ...zero, limit: 2 })).rejects.toBeInstanceOf(MandalaError);
  });

  it('allows a decoded byte to advance exactly to the maximum safe position', async () => {
    const { c } = await setup({
      ...output,
      stdout_b64: 'AA==',
      stdout_offset: Number.MAX_SAFE_INTEGER,
    });
    const result = await c.executionOutput(ID, {
      stdoutOffset: Number.MAX_SAFE_INTEGER - 1,
      stderrOffset: 0,
      limit: 1,
    });
    expect(result.stdoutOffset).toBe(Number.MAX_SAFE_INTEGER);
    expect(result.stdout).toEqual(new Uint8Array([0]));
  });
});

describe('execution transport boundaries', () => {
  it.each(['metadata', 'output'] as const)(
    'never retries %s after a connection failure or timeout',
    async (kind) => {
      for (const failure of ['connection', 'timeout']) {
        const rec = recorder((call) => {
          if (!call.path.includes('/executions/')) return anyRoute(call);
          if (failure === 'connection') throw new TypeError('fetch failed');
          return new Promise<Response>(() => {});
        });
        const c = await new Client({
          apiKey: 'com_test',
          baseUrl: BASE,
          fetch: rec.fetch,
          timeoutMs: 10,
        }).computers.get('vm-1');
        const pending = kind === 'metadata' ? c.execution(ID) : c.executionOutput(ID, zero);
        await expect(pending).rejects.toBeInstanceOf(MandalaError);
        expect(rec.calls).toHaveLength(2);
      }
    },
  );

  it.each([404, 409, 401, 403, 429, 503])(
    'preserves HTTP %i without retry, resume or PID fallback',
    async (status) => {
      const { c, rec } = await setup(
        { error: 'unavailable', code: 'execution_unavailable' },
        status,
      );
      await expect(c.execution(ID)).rejects.toMatchObject({ status });
      await expect(c.executionOutput(ID, zero)).rejects.toMatchObject({ status });
      expect(rec.routes()).toEqual([
        ['GET', 'computers/vm-1'],
        ['GET', `computers/vm-1/executions/${ID}`],
        ['GET', `computers/vm-1/executions/${ID}/output`],
      ]);
    },
  );

  it.each([undefined, null, [], 'wrong'])(
    'refuses missing/non-object successful payloads %s',
    async (body) => {
      const { c, rec } = await setup(body);
      await expect(c.execution(ID)).rejects.toBeInstanceOf(MandalaError);
      await expect(c.executionOutput(ID, zero)).rejects.toBeInstanceOf(MandalaError);
      expect(rec.calls).toHaveLength(3);
    },
  );

  it('keeps authentication, path prefixes and query; never follows a response URL', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const client = new Client({
      apiKey: 'com_fake',
      baseUrl: 'https://api.test/prefix/api/v1',
      fetch: async (input, init) => {
        const url = String(input);
        calls.push({ url, init });
        if (url.includes('/executions/'))
          return new Response(null, {
            status: 302,
            headers: { Location: 'https://other.invalid/output' },
          });
        return json({ id: 'vm-1' });
      },
    });
    const c = await client.computers.get('vm-1');
    await expect(
      c.executionOutput(ID, { stdoutOffset: 7, stderrOffset: 11, limit: 3 }),
    ).rejects.toMatchObject({ status: 302 });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toBe(
      `https://api.test/prefix/api/v1/computers/vm-1/executions/${ID}/output?stdout_offset=7&stderr_offset=11&limit=3`,
    );
    expect(new Headers(calls[1]?.init?.headers).get('Authorization')).toBe('Bearer com_fake');
    expect(calls[1]?.init?.redirect).toBe('manual');
  });

  it.each(['metadata', 'output'] as const)(
    'honors cancellation before and during %s without new calls',
    async (kind) => {
      let announce!: () => void;
      const entered = new Promise<void>((resolve) => {
        announce = resolve;
      });
      const rec = recorder((call) => {
        if (!call.path.includes('/executions/')) return anyRoute(call);
        announce();
        return new Promise<Response>(() => {});
      });
      const c = await new Client({
        apiKey: 'com_test',
        baseUrl: BASE,
        fetch: rec.fetch,
      }).computers.get('vm-1');
      const controller = new AbortController();
      const reason = { cancelled: true };
      const call = () =>
        kind === 'metadata'
          ? c.execution(ID, { signal: controller.signal })
          : c.executionOutput(ID, { ...zero, signal: controller.signal });
      const pending = call();
      await entered;
      controller.abort(reason);
      await expect(pending).rejects.toBe(reason);
      await expect(call()).rejects.toBe(reason);
      expect(rec.calls).toHaveLength(2);
    },
  );

  it.each(['metadata', 'output'] as const)(
    'preserves late cancellation even when %s JSON arrives',
    async (kind) => {
      const controller = new AbortController();
      const reason = new Error('cancelled');
      const rec = recorder((call) => {
        if (!call.path.includes('/executions/')) return anyRoute(call);
        return new Response(
          new ReadableStream({
            start(stream) {
              controller.abort(reason);
              stream.enqueue(
                new TextEncoder().encode(JSON.stringify(kind === 'metadata' ? metadata : output)),
              );
              stream.close();
            },
          }),
        );
      });
      const c = await new Client({
        apiKey: 'com_test',
        baseUrl: BASE,
        fetch: rec.fetch,
      }).computers.get('vm-1');
      const call =
        kind === 'metadata'
          ? c.execution(ID, { signal: controller.signal })
          : c.executionOutput(ID, { ...zero, signal: controller.signal });
      await expect(call).rejects.toBe(reason);
      expect(rec.calls).toHaveLength(2);
    },
  );
});
