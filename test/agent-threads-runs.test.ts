/**
 * Agent threads and background runs (OPL-6083): `threadId`, `store` and
 * `messages` on the agent methods, the `threadId` a run and its failure come
 * back with, `client.agentThreads`, and `client.agentRuns` with its wait.
 */

import { describe, expect, it } from 'vitest';
import {
  AGENT_PAGE_MAX,
  type AgentArgs,
  APIError,
  Client,
  type Computer,
  ConflictError,
  InsufficientCreditsError,
  MandalaError,
  ModelProviderError,
  NotFoundError,
  TimeoutError,
  ValidationError,
} from '../src/index.js';
import {
  AGENT_RESULT,
  AGENT_RUN,
  AGENT_RUN_STARTED,
  AGENT_THREAD,
  AGENT_THREAD_SUMMARY,
  anyRoute,
  BASE,
  json,
  type Responder,
  recorder,
} from './harness.js';

function sdk(respond: Responder = anyRoute) {
  const rec = recorder(respond);
  return { rec, client: new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch }) };
}

const THREAD = AGENT_THREAD_SUMMARY.id;
const RUN = AGENT_RUN.id;

const sse = (...frames: [string, unknown][]) =>
  new Response(frames.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });

/** Answers each read with the next body in turn, and the last one forever. */
const sequence = (...answers: (() => Response)[]): Responder => {
  let i = 0;
  return () => answers[Math.min(i++, answers.length - 1)]!();
};

/** The agent route answered by `respond`, and everything else as usual. */
const onAgent =
  (respond: Responder): Responder =>
  (call) =>
    call.path.endsWith('/agent') ? respond(call) : anyRoute(call);

const computer = async (respond: Responder = anyRoute) => {
  const { rec, client } = sdk(respond);
  const c = await client.computers.get('vm-1');
  rec.calls.length = 0;
  return { rec, client, c };
};

/** Every way into the agent route, each consumed to its end. */
const RUNNERS: Record<string, (c: Computer, args: AgentArgs) => Promise<unknown>> = {
  agent: (c, args) => c.agent(args),
  agentOnce: (c, args) => c.agentOnce(args),
  agentStream: async (c, args) => {
    for await (const _ of c.agentStream(args));
  },
};

describe('threadId, store and messages on the agent route', () => {
  it.each(Object.keys(RUNNERS))('%s sends all three in their wire spelling', async (name) => {
    const { rec, c } = await computer();
    await RUNNERS[name]!(c, { prompt: 'go', modelKey: 'sk', threadId: THREAD, store: true });
    expect(rec.last().body).toMatchObject({ prompt: 'go', thread_id: THREAD, store: true });
    await RUNNERS[name]!(c, {
      prompt: 'go',
      modelKey: 'sk',
      store: false,
      messages: [
        { role: 'user', content: 'open the settings' },
        { role: 'assistant', content: 'they are open' },
      ],
    });
    expect(rec.last().body).toMatchObject({
      store: false,
      messages: [
        { role: 'user', content: 'open the settings' },
        { role: 'assistant', content: 'they are open' },
      ],
    });
    expect(rec.last().body).not.toHaveProperty('thread_id');
  });

  it('sends none of them when none is given', async () => {
    const { rec, c } = await computer();
    await c.agent({ prompt: 'go', modelKey: 'sk' });
    await c.agentOnce({ prompt: 'go', modelKey: 'sk' });
    for (const call of rec.calls) {
      expect(Object.keys(call.body as object).sort()).toEqual(['prompt', 'stream']);
    }
  });

  it("reads fields that are getters on the caller's class, not only its own properties", async () => {
    // A spread copies own enumerable properties only, so an options object
    // whose fields live on its prototype lost `store: false` and `maxSteps`
    // on the way to the body: the platform kept the conversation and ran to
    // its default step cap.
    class Options {
      prompt = 'go';
      modelKey = 'sk';
      get store() {
        return false;
      }
      get maxSteps() {
        return 1;
      }
      get messages() {
        return [new Turn()];
      }
    }
    class Turn {
      get role() {
        return 'user' as const;
      }
      get content() {
        return 'earlier';
      }
    }
    const want = {
      prompt: 'go',
      store: false,
      max_steps: 1,
      messages: [{ role: 'user', content: 'earlier' }],
    };
    for (const name of Object.keys(RUNNERS)) {
      const { rec, c } = await computer();
      await RUNNERS[name]!(c, new Options() as AgentArgs);
      expect(rec.last().body, name).toMatchObject(want);
    }
    class Background {
      prompt = 'go';
      get threadId() {
        return THREAD;
      }
      get maxSteps() {
        return 1;
      }
    }
    const { rec, client } = sdk();
    await client.agentRuns.start('vm-1', new Background() as never);
    expect(rec.last().body).toEqual({ prompt: 'go', thread_id: THREAD, max_steps: 1 });
    const err = await client.agentRuns
      .start('vm-1', new Options() as never)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as Error).message).toMatch(/background run is always kept/);
  });

  it('sends only the role and content of each turn', async () => {
    const { rec, c } = await computer();
    const turn = { role: 'user', content: 'hi', id: 'msg-1', at: 1 } as never;
    await c.agentOnce({ prompt: 'go', messages: [turn] });
    expect((rec.last().body as { messages: unknown }).messages).toEqual([
      { role: 'user', content: 'hi' },
    ]);
  });

  it('lets an empty messages list go with a threadId, as the platform does', async () => {
    const { rec, c } = await computer();
    await c.agentOnce({ prompt: 'go', threadId: THREAD, messages: [] });
    expect(rec.last().body).toMatchObject({ thread_id: THREAD, messages: [] });
  });

  const refused: [string, Record<string, unknown>, RegExp][] = [
    ['store: false with a threadId', { threadId: THREAD, store: false }, /store: false/],
    [
      'messages with a threadId',
      { threadId: THREAD, messages: [{ role: 'user', content: 'x' }] },
      /messages or threadId, not both/,
    ],
    ['a threadId that is not a string', { threadId: 7 }, /threadId must be a string/],
    ['an empty threadId', { threadId: '' }, /threadId must be a thread id/],
    ['a padded threadId', { threadId: ` ${THREAD}` }, /threadId must be a thread id/],
    ['a store that is not a boolean', { store: 'false' }, /store must be a boolean/],
    ['messages that are not a list', { messages: 'hi' }, /messages must be a list/],
    ['a turn that is not an object', { messages: ['hi'] }, /messages\[0\] must be an object/],
    [
      'a role that is not user or assistant',
      { messages: [{ role: 'system', content: 'x' }] },
      /messages\[0\]\.role must be "user" or "assistant"/,
    ],
    [
      'a role of another type',
      { messages: [{ role: 1n, content: 'x' }] },
      /messages\[0\]\.role .*\(got bigint\)/,
    ],
    [
      'content that is not a string',
      { messages: [{ role: 'user', content: ['x'] }] },
      /messages\[0\]\.content must be a string/,
    ],
  ];

  it.each(Object.keys(RUNNERS))('%s refuses each bad combination before sending', async (name) => {
    for (const [, extra, message] of refused) {
      const { rec, c } = await computer();
      const args = { prompt: 'go', modelKey: 'sk', ...extra } as AgentArgs;
      const err = await RUNNERS[name]!(c, args).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as Error).message).toMatch(message);
      expect(rec.calls).toEqual([]);
    }
  });

  it('agentStream refuses where it is called, not where it is consumed', async () => {
    const { rec, c } = await computer();
    expect(() => c.agentStream({ prompt: 'go', threadId: THREAD, store: false })).toThrow(
      ValidationError,
    );
    expect(rec.calls).toEqual([]);
  });
});

describe('the threadId a run comes back with', () => {
  it('is on the result of a streamed run', async () => {
    const { c } = await computer(
      onAgent(() => sse(['done', { ...AGENT_RESULT, usage: {}, thread_id: THREAD }])),
    );
    expect((await c.agent({ prompt: 'go' })).threadId).toBe(THREAD);
  });

  it('is on the result of agentOnce()', async () => {
    const { c } = await computer(onAgent(() => json({ ...AGENT_RESULT, thread_id: THREAD })));
    expect((await c.agentOnce({ prompt: 'go' })).threadId).toBe(THREAD);
  });

  it('is absent when the run kept nothing, and when what was sent is not an id', async () => {
    const { c } = await computer(onAgent(() => json(AGENT_RESULT)));
    const result = await c.agentOnce({ prompt: 'go', store: false });
    expect(result.threadId).toBeUndefined();
    expect(result).not.toHaveProperty('threadId');
    // Nor when it could not be sent back as a threadId: one with space around
    // it is refused by the next call, so it is not offered as the id to continue.
    for (const bad of ['', '  ', ` ${THREAD}`, `${THREAD}\n`, 7, ['thr_x'], null]) {
      const { c: d } = await computer(onAgent(() => json({ ...AGENT_RESULT, thread_id: bad })));
      expect((await d.agentOnce({ prompt: 'go' })).threadId).toBeUndefined();
    }
  });

  it('is on the streamed error event', async () => {
    const { c } = await computer(
      onAgent(() =>
        sse(['error', { error: 'model API: overloaded', status: 529, thread_id: THREAD }]),
      ),
    );
    const events = [];
    for await (const ev of c.agentStream({ prompt: 'go' })) events.push(ev);
    expect(events).toEqual([expect.objectContaining({ type: 'error', threadId: THREAD })]);
  });

  it('is on the error agent() throws for a failed run', async () => {
    const { c } = await computer(
      onAgent(() =>
        sse(
          ['step', { n: 1, tool: 'computer', action: 'left_click' }],
          ['error', { error: 'revoked', status: 403, reason: 'revoked', thread_id: THREAD }],
        ),
      ),
    );
    const err = await c.agent({ prompt: 'go' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(APIError);
    expect((err as APIError).threadId).toBe(THREAD);
  });

  it('is on the error agent() throws for a failure frame with no status', async () => {
    const { c } = await computer(
      onAgent(() => sse(['error', { error: 'gone', thread_id: THREAD }])),
    );
    const err = await c.agent({ prompt: 'go' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MandalaError);
    expect(err).not.toBeInstanceOf(APIError);
    expect((err as MandalaError).threadId).toBe(THREAD);
  });

  it('is on the error agentOnce() throws, and survives the agent route mapping', async () => {
    const failure = (status: number, extra: Record<string, unknown> = {}) =>
      onAgent(
        () =>
          new Response(
            JSON.stringify({
              error: 'model API: billing_error',
              usage: {},
              steps_taken: [{ n: 1, tool: 'computer' }],
              thread_id: THREAD,
              ...extra,
            }),
            { status, headers: { 'content-type': 'application/json' } },
          ),
      );
    // A 402 is rebuilt as the model provider's, and keeps the thread.
    const billed = await (await computer(failure(402))).c
      .agentOnce({ prompt: 'go', modelKey: 'sk' })
      .catch((e: unknown) => e);
    expect(billed).toBeInstanceOf(ModelProviderError);
    expect((billed as APIError).threadId).toBe(THREAD);
    // A 409 for a thread of another computer is the table's own class.
    const other = await (await computer(failure(409, { error: 'thread belongs to vm-2' }))).c
      .agentOnce({ prompt: 'go', threadId: THREAD })
      .catch((e: unknown) => e);
    expect(other).toBeInstanceOf(ConflictError);
    expect((other as APIError).threadId).toBe(THREAD);
  });

  it('is undefined on an error whose thread_id could not be sent back', async () => {
    for (const thread_id of [` ${THREAD}`, '', 7]) {
      const { c } = await computer(
        onAgent(() =>
          json({ error: 'failed', usage: {}, steps_taken: [], thread_id }, { status: 500 }),
        ),
      );
      const err = await c.agentOnce({ prompt: 'go' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(APIError);
      expect((err as APIError).threadId).toBeUndefined();
    }
    const { c } = await computer(
      onAgent(() => sse(['error', { error: 'failed', status: 500, thread_id: ` ${THREAD}` }])),
    );
    const events = [];
    for await (const ev of c.agentStream({ prompt: 'go' })) events.push(ev);
    expect(events[0]).not.toHaveProperty('threadId');
  });

  it('is undefined on an error that names no thread', async () => {
    const { c } = await computer(
      onAgent(() => json({ error: 'thread not found' }, { status: 404 })),
    );
    const err = await c.agentOnce({ prompt: 'go', threadId: THREAD }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect((err as APIError).threadId).toBeUndefined();
  });
});

describe('client.agentThreads', () => {
  it('lists a page with every parameter in its wire spelling', async () => {
    const { rec, client } = sdk(() =>
      json({
        threads: [AGENT_THREAD_SUMMARY, { ...AGENT_THREAD_SUMMARY, id: 'thr_b' }],
        has_more: true,
      }),
    );
    const page = await client.agentThreads.list({ computerId: 'vm-1', limit: 2, before: 'thr_a' });
    expect(rec.routes()).toEqual([['GET', 'agent/threads']]);
    expect(rec.last().query).toEqual({ computer_id: 'vm-1', limit: '2', before: 'thr_a' });
    expect(page.threads[0]).toEqual({
      id: THREAD,
      computerId: 'vm-1',
      title: AGENT_THREAD_SUMMARY.title,
      turns: 2,
      createdAt: AGENT_THREAD_SUMMARY.created_at,
      updatedAt: AGENT_THREAD_SUMMARY.updated_at,
      raw: AGENT_THREAD_SUMMARY,
    });
    expect(page.hasMore).toBe(true);
    // The id to page on is the last row's, so a walk does not have to know it.
    expect(page.nextBefore).toBe('thr_b');
  });

  it('sends no query when asked for nothing, and ends a walk on the last page', async () => {
    const { rec, client } = sdk();
    const page = await client.agentThreads.list();
    expect(rec.last().query).toEqual({});
    expect(page.hasMore).toBe(false);
    expect(page.nextBefore).toBeNull();
  });

  it('refuses a page it could not walk on from', async () => {
    for (const bad of [
      { threads: 'none', has_more: false },
      { threads: [AGENT_THREAD_SUMMARY] },
      { threads: [AGENT_THREAD_SUMMARY], has_more: 'maybe' },
      { threads: [{ ...AGENT_THREAD_SUMMARY, id: 7 }], has_more: false },
      { threads: ['thr_a'], has_more: false },
      // More to come, and no row to page on from: read as the last page, it
      // would end a walk early and call the listing complete.
      { threads: [], has_more: true },
    ]) {
      const { client } = sdk(() => json(bad));
      await expect(client.agentThreads.list()).rejects.toThrow(MandalaError);
    }
  });

  it('refuses arguments the platform would, before sending anything', async () => {
    const { rec, client } = sdk();
    for (const args of [
      { limit: 0 },
      { limit: AGENT_PAGE_MAX + 1 },
      { limit: 2.5 },
      { computerId: '' },
      { computerId: ' vm-1' },
      { before: '' },
      { before: 7 },
    ]) {
      await expect(client.agentThreads.list(args as never)).rejects.toThrow(ValidationError);
    }
    expect(rec.calls).toEqual([]);
  });

  it('reads one thread with its turns', async () => {
    const { rec, client } = sdk();
    const thread = await client.agentThreads.get(THREAD);
    expect(rec.routes()).toEqual([['GET', `agent/threads/${THREAD}`]]);
    expect(thread.id).toBe(THREAD);
    expect(thread.messages).toEqual([
      {
        role: 'user',
        text: AGENT_THREAD.messages[0]!.text,
        createdAt: AGENT_THREAD.messages[0]!.created_at,
        raw: AGENT_THREAD.messages[0],
      },
      {
        role: 'assistant',
        text: 'Dark mode is on.',
        stop: 'end_turn',
        steps: 3,
        createdAt: AGENT_THREAD.messages[1]!.created_at,
        raw: AGENT_THREAD.messages[1],
      },
    ]);
  });

  it('keeps a failed and a funded turn whole', async () => {
    const turn = {
      role: 'assistant',
      text: '',
      stop: 'error',
      error: 'model API: overloaded',
      steps: 2,
      cost_usd: 0.31,
      created_at: '2026-10-18T12:00:00.000Z',
    };
    const { client } = sdk(() => json({ ...AGENT_THREAD, messages: [turn] }));
    const [read] = (await client.agentThreads.get(THREAD)).messages;
    expect(read).toMatchObject({ stop: 'error', error: turn.error, steps: 2, costUsd: 0.31 });
  });

  it('refuses a thread whose turns are not a list of objects', async () => {
    // Absent and null too: a thread read by id always carries its turns, and one
    // without them read as empty would show a thread of two turns as complete.
    for (const messages of ['none', ['hi'], undefined, null]) {
      const { client } = sdk(() => json({ ...AGENT_THREAD, messages }));
      await expect(client.agentThreads.get(THREAD)).rejects.toThrow(MandalaError);
    }
  });

  it('deletes one, and refuses an empty id before sending anything', async () => {
    const { rec, client } = sdk();
    await expect(client.agentThreads.delete(THREAD)).resolves.toBeUndefined();
    expect(rec.routes()).toEqual([['DELETE', `agent/threads/${THREAD}`]]);
    await expect(client.agentThreads.get('')).rejects.toThrow(ValidationError);
    await expect(client.agentThreads.delete('..')).rejects.toThrow(ValidationError);
    expect(rec.calls).toHaveLength(1);
  });

  it('raises a thread this key cannot see as NotFoundError', async () => {
    const { client } = sdk(() => json({ error: 'thread not found' }, { status: 404 }));
    await expect(client.agentThreads.get(THREAD)).rejects.toThrow(NotFoundError);
  });
});

describe('client.agentRuns.start and computer.startAgentRun', () => {
  const STARTS = {
    'agentRuns.start': (client: Client, args: Record<string, unknown>) =>
      client.agentRuns.start('vm-1', args as never),
    startAgentRun: async (client: Client, args: Record<string, unknown>) =>
      (await client.computers.get('vm-1')).startAgentRun(args as never),
  };

  it.each(Object.keys(STARTS))('%s accepts the background step cap', async (name) => {
    for (const maxSteps of [1, 101, 500]) {
      const { rec, client } = sdk();
      await STARTS[name as keyof typeof STARTS](client, { prompt: 'go', maxSteps });
      expect(rec.last().body).toMatchObject({ max_steps: maxSteps });
    }
  });

  it.each(Object.keys(STARTS))(
    '%s posts the body without stream and decodes the 202',
    async (name) => {
      const { rec, client } = sdk();
      const run = await STARTS[name as keyof typeof STARTS](client, {
        prompt: 'go',
        modelKey: ' sk-own ',
        maxSteps: 5,
        threadId: THREAD,
        store: true,
      });
      const call = rec.last();
      expect([call.method, call.path]).toEqual(['POST', '/computers/vm-1/agent/runs']);
      expect(call.body).toEqual({ prompt: 'go', max_steps: 5, thread_id: THREAD, store: true });
      expect(call.headers['X-Model-Key']).toBe('sk-own');
      expect(run).toMatchObject({
        id: RUN,
        computerId: 'vm-1',
        threadId: null,
        status: 'running',
        steps: 0,
        stepsTaken: [],
        finished: false,
        endedAt: null,
      });
      expect(run.result).toBeUndefined();
    },
  );

  it.each(Object.keys(STARTS))(
    '%s runs on credits with no key, and sends no header',
    async (name) => {
      const { rec, client } = sdk();
      await STARTS[name as keyof typeof STARTS](client, { prompt: 'go', maxCostUsd: 1 });
      expect(rec.last().headers).not.toHaveProperty('X-Model-Key');
      expect(rec.last().body).toEqual({ prompt: 'go', max_cost_usd: 1 });
    },
  );

  it.each(Object.keys(STARTS))(
    '%s refuses what the platform would, before sending',
    async (name) => {
      for (const [args, message] of [
        [{ prompt: 'go', store: false }, /background run is always kept/],
        [{ prompt: 'go', modelKey: '' }, /modelKey/],
        [{ prompt: '' }, /prompt must not be empty/],
        [
          { prompt: 'go', threadId: THREAD, messages: [{ role: 'user', content: 'x' }] },
          /not both/,
        ],
        [{ prompt: 'go', maxSteps: 501 }, /at most 500/],
      ] as const) {
        const { rec, client } = sdk();
        const err = await STARTS[name as keyof typeof STARTS](client, args).catch(
          (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(ValidationError);
        expect((err as Error).message).toMatch(message);
        expect(rec.calls.filter((c) => c.method === 'POST')).toEqual([]);
      }
    },
  );

  it('never sends stream, even when a caller from JavaScript passes it', async () => {
    const { rec, client } = sdk();
    await client.agentRuns.start('vm-1', { prompt: 'go', stream: true } as never);
    expect(rec.last().body).toEqual({ prompt: 'go' });
  });

  it('refuses options that are not an object', async () => {
    const { rec, client } = sdk();
    await expect(client.agentRuns.start('vm-1', null as never)).rejects.toThrow(ValidationError);
    expect(rec.calls).toEqual([]);
  });

  it('maps the refusals made before the run holds the computer', async () => {
    const refuse = (status: number, body: unknown) =>
      sdk((call) => (call.path.endsWith('/agent/runs') ? json(body, { status }) : anyRoute(call)))
        .client;
    const credits = await refuse(402, { error: 'Insufficient AI credits', top_up_url: '/billing' })
      .agentRuns.start('vm-1', { prompt: 'go' })
      .catch((e: unknown) => e);
    expect(credits).toBeInstanceOf(InsufficientCreditsError);
    expect((credits as InsufficientCreditsError).topUpUrl).toBe('https://api.test/billing');
    const billed = await refuse(402, { error: 'billing_error' })
      .agentRuns.start('vm-1', { prompt: 'go', modelKey: 'sk' })
      .catch((e: unknown) => e);
    expect(billed).toBeInstanceOf(ModelProviderError);
    const busy = await refuse(409, { error: 'already driven', reason: 'contention' })
      .agentRuns.start('vm-1', { prompt: 'go' })
      .catch((e: unknown) => e);
    expect(busy).toBeInstanceOf(ConflictError);
    expect((busy as ConflictError).reason).toBe('contention');
    const gone = await refuse(404, { error: 'computer not found' })
      .agentRuns.start('vm-1', { prompt: 'go' })
      .catch((e: unknown) => e);
    expect(gone).toBeInstanceOf(NotFoundError);
  });

  it('refuses an answer that is not a run', async () => {
    const { client } = sdk((call) =>
      call.path.endsWith('/agent/runs') ? json({ ok: true }, { status: 202 }) : anyRoute(call),
    );
    await expect(client.agentRuns.start('vm-1', { prompt: 'go' })).rejects.toThrow(MandalaError);
  });
});

describe('client.agentRuns reads', () => {
  it('reads a run and decodes every field', async () => {
    const { rec, client } = sdk();
    const run = await client.agentRuns.get(RUN);
    expect(rec.routes()).toEqual([['GET', `agent/runs/${RUN}`]]);
    expect(run).toEqual({
      id: RUN,
      computerId: 'vm-1',
      threadId: THREAD,
      status: 'completed',
      prompt: AGENT_RUN.prompt,
      model: 'claude-sonnet-5-5',
      maxSteps: 20,
      steps: 1,
      result: expect.objectContaining({
        stop: 'end_turn',
        finished: true,
        text: 'Dark mode is on.',
      }),
      stepsTaken: [{ n: 1, tool: 'computer', action: 'left_click', detail: 'clicked (10, 20)' }],
      finished: true,
      createdAt: AGENT_RUN.created_at,
      updatedAt: AGENT_RUN.updated_at,
      endedAt: AGENT_RUN.ended_at,
      raw: AGENT_RUN,
    });
  });

  it.each(['max_steps', 'time_limit'])('is unfinished at %s', async (stop) => {
    const read = async (body: unknown) => sdk(() => json(body)).client.agentRuns.get(RUN);
    expect((await read(AGENT_RUN)).finished).toBe(true);
    const maxed = { ...AGENT_RUN, result: { ...AGENT_RUN.result, stop } };
    expect((await read(maxed)).finished).toBe(false);
    expect((await read({ ...AGENT_RUN, status: 'cancelled' })).finished).toBe(false);
  });

  it('decodes a failed run with its error, its cost and its link', async () => {
    const failed = {
      ...AGENT_RUN,
      status: 'failed',
      result: undefined,
      cost_usd: 0.4,
      error: {
        error: 'Insufficient AI credits',
        status: 402,
        reason: 'credits',
        top_up_url: '/billing',
      },
    };
    const run = await sdk(() => json(failed)).client.agentRuns.get(RUN);
    expect(run.error).toEqual({
      error: 'Insufficient AI credits',
      status: 402,
      reason: 'credits',
      topUpUrl: 'https://api.test/billing',
    });
    expect(run.costUsd).toBe(0.4);
    expect(run.finished).toBe(false);
  });

  it('refuses a run a wait or a caller could not decide on', async () => {
    for (const bad of [
      { ...AGENT_RUN, id: '' },
      { ...AGENT_RUN, status: 7 },
      { ...AGENT_RUN, thread_id: 7 },
      { ...AGENT_RUN, thread_id: '' },
      { ...AGENT_RUN, thread_id: ` ${THREAD}` },
      { ...AGENT_RUN, ended_at: 0 },
      // Read as a time, an empty one would end a wait on a run still going.
      { ...AGENT_RUN_STARTED, ended_at: '' },
      { ...AGENT_RUN_STARTED, ended_at: '  ' },
      { ...AGENT_RUN, error: 'failed' },
      { ...AGENT_RUN, error: { status: 500 } },
      // Without its status an interrupted run's restart (503) and its lost
      // ending (500) cannot be told apart.
      { ...AGENT_RUN, status: 'interrupted', error: { error: 'restarted' } },
      { ...AGENT_RUN, status: 'interrupted', error: { error: 'restarted', status: '503' } },
      { ...AGENT_RUN, result: 'end_turn' },
      { ...AGENT_RUN, steps_taken: 'none' },
      { ...AGENT_RUN, steps_taken: [7] },
      ['not', 'a', 'run'],
    ]) {
      const { client } = sdk(() => json(bad));
      await expect(client.agentRuns.get(RUN)).rejects.toThrow(MandalaError);
    }
  });

  it('lists a page with every parameter in its wire spelling', async () => {
    const { rec, client } = sdk(() =>
      json({ runs: [{ ...AGENT_RUN, steps_taken: [] }], has_more: true }),
    );
    const page = await client.agentRuns.list({
      computerId: 'vm-1',
      status: 'failed',
      limit: 1,
      before: 'run_a',
    });
    expect(rec.routes()).toEqual([['GET', 'agent/runs']]);
    expect(rec.last().query).toEqual({
      computer_id: 'vm-1',
      status: 'failed',
      limit: '1',
      before: 'run_a',
    });
    expect(page.runs.map((r) => r.id)).toEqual([RUN]);
    expect(page.runs[0]!.stepsTaken).toEqual([]);
    expect(page.hasMore).toBe(true);
    expect(page.nextBefore).toBe(RUN);
  });

  it('refuses a status filter outside the five, before sending', async () => {
    const { rec, client } = sdk();
    for (const status of ['done', 'RUNNING', 7, null]) {
      await expect(client.agentRuns.list({ status } as never)).rejects.toThrow(ValidationError);
    }
    expect(rec.calls).toEqual([]);
  });

  it('refuses a page it could not walk on from', async () => {
    for (const bad of [
      { runs: {}, has_more: false },
      { runs: [] },
      { runs: [7], has_more: false },
      { runs: [], has_more: true },
    ]) {
      const { client } = sdk(() => json(bad));
      await expect(client.agentRuns.list()).rejects.toThrow(MandalaError);
    }
  });

  it('cancels by POST and answers the run', async () => {
    const { rec, client } = sdk();
    const run = await client.agentRuns.cancel(RUN);
    expect(rec.routes()).toEqual([['POST', `agent/runs/${RUN}/cancel`]]);
    expect(rec.last().body).toBeUndefined();
    expect(run.status).toBe('cancelled');
  });
});

describe('client.agentRuns.wait', () => {
  const running = () => json(AGENT_RUN_STARTED);
  const ended =
    (extra: Record<string, unknown> = {}) =>
    () =>
      json({ ...AGENT_RUN, ...extra });

  it('polls until the run has ended, and answers it', async () => {
    const { rec, client } = sdk(sequence(running, running, ended()));
    const run = await client.agentRuns.wait(RUN, { pollMs: 1 });
    expect(run.status).toBe('completed');
    expect(run.finished).toBe(true);
    expect(rec.routes()).toEqual(Array(3).fill(['GET', `agent/runs/${RUN}`]));
  });

  it('takes the run itself as well as its id', async () => {
    const { client } = sdk(sequence(ended()));
    const started = { ...(await client.agentRuns.get(RUN)), id: RUN };
    await expect(client.agentRuns.wait(started, { pollMs: 1 })).resolves.toMatchObject({ id: RUN });
  });

  it.each(['failed', 'cancelled', 'interrupted'])(
    'answers a run that ended %s rather than throwing',
    async (status) => {
      const extra = { status, result: undefined, error: { error: 'stopped', status: 503 } };
      const { client } = sdk(sequence(running, ended(extra)));
      const run = await client.agentRuns.wait(RUN, { pollMs: 1 });
      expect(run.status).toBe(status);
      expect(run.finished).toBe(false);
      expect(run.stepsTaken).toHaveLength(1);
    },
  );

  it('answers a status it does not know once the run says it has ended', async () => {
    const { client } = sdk(sequence(running, ended({ status: 'expired' })));
    await expect(client.agentRuns.wait(RUN, { pollMs: 1 })).resolves.toMatchObject({
      status: 'expired',
    });
  });

  it('keeps polling a status it does not know while the run has not ended', async () => {
    const { rec, client } = sdk(
      sequence(() => json({ ...AGENT_RUN_STARTED, status: 'queued' }), ended()),
    );
    await expect(client.agentRuns.wait(RUN, { pollMs: 1 })).resolves.toMatchObject({
      status: 'completed',
    });
    expect(rec.calls).toHaveLength(2);
  });

  it('rides out a transient failure of a poll', async () => {
    const { client } = sdk(
      sequence(running, () => json({ error: 'busy' }, { status: 503 }), ended()),
    );
    await expect(client.agentRuns.wait(RUN, { pollMs: 1 })).resolves.toMatchObject({
      status: 'completed',
    });
  });

  it('throws a run this key cannot see at once', async () => {
    const { rec, client } = sdk(() => json({ error: 'run not found' }, { status: 404 }));
    await expect(client.agentRuns.wait(RUN, { pollMs: 1 })).rejects.toThrow(NotFoundError);
    expect(rec.calls).toHaveLength(1);
  });

  it('times out on a run still going, and says the run was not stopped', async () => {
    const { client } = sdk(running);
    const err = await client.agentRuns
      .wait(RUN, { pollMs: 5, timeoutMs: 40 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    expect((err as Error).message).toMatch(/was still running .*has not stopped.*cancel/);
  });

  it('stops when the caller aborts', async () => {
    const { client } = sdk(running);
    const ac = new AbortController();
    const waiting = client.agentRuns.wait(RUN, { pollMs: 5, signal: ac.signal });
    setTimeout(() => ac.abort(new Error('enough')), 20);
    await expect(waiting).rejects.toThrow('enough');
  });

  it('refuses numbers and ids it cannot wait on, before sending', async () => {
    const { rec, client } = sdk();
    await expect(client.agentRuns.wait(RUN, { pollMs: 0 })).rejects.toThrow(ValidationError);
    await expect(client.agentRuns.wait(RUN, { timeoutMs: Number.NaN })).rejects.toThrow(
      ValidationError,
    );
    await expect(client.agentRuns.wait('')).rejects.toThrow(ValidationError);
    await expect(client.agentRuns.wait({} as never)).rejects.toThrow(ValidationError);
    expect(rec.calls).toEqual([]);
  });
});
