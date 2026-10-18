/**
 * `mandala agent` threads and background runs (OPL-5474): `agent run --thread`,
 * `--no-store` and `--background`, `agent runs`, `agent threads`, and the
 * line-by-line sessions `agent chat` and `agent resume`.
 */

import { PassThrough, Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import { completion } from '../src/cli-completion.js';
import { manifest } from '../src/cli-manifest.js';
import { help, parseArgs } from '../src/cli-options.js';
import type { CliIO } from '../src/cli-runtime.js';
import { Client } from '../src/index.js';
import {
  AGENT_RUN,
  AGENT_RUN_STARTED,
  AGENT_THREAD,
  AGENT_THREAD_SUMMARY,
  anyRoute,
  BASE,
  type Call,
  COMPUTER,
  json,
  type Responder,
  recorder,
} from './harness.js';

const THREAD = AGENT_THREAD_SUMMARY.id;
const RUN = AGENT_RUN.id;
const stamp = '2026-10-18T12:00:00.000Z';

const sse = (...frames: [string, unknown][]) =>
  new Response(frames.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });

/** A run that finished, kept in `thread`. */
const done = (thread?: string, stop = 'end_turn') =>
  sse(
    ['step', { n: 1, tool: 'computer', action: 'left_click', detail: 'clicked' }],
    ['done', { steps: 1, stop, text: 'ok', ...(thread ? { thread_id: thread } : {}) }],
  );

const isAgentPost = (call: Call) => call.method === 'POST' && call.path.endsWith('/agent');

type Stdin = CliIO['stdin'];

/** Stdin as `lines`, ended, and a terminal or not. */
const piped = (text: string, tty = false): Stdin =>
  Object.assign(Readable.from(text ? [Buffer.from(text)] : []), { isTTY: tty }) as Stdin;

/**
 * A terminal: stdin, whose raw mode is set as readline and the session set
 * it, and stderr, where readline draws its prompt. Keys are typed as bytes.
 */
function terminal() {
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
    setRawMode: vi.fn((mode: boolean) => {
      stdin.isRaw = mode;
      return stdin;
    }),
  });
  const stderr = Object.assign(new PassThrough(), { isTTY: true, columns: 200 });
  let drawn = '';
  stderr.on('data', (chunk) => {
    drawn += chunk;
  });
  return {
    stdin,
    stderr,
    io: { stdin: stdin as unknown as Stdin, stderr: stderr as unknown as CliIO['stderr'] },
    drawn: () => drawn,
    type: (keys: string) => stdin.write(keys),
  };
}

function harness(
  respond: Responder = anyRoute,
  opts: {
    stdin?: Stdin;
    stderr?: CliIO['stderr'];
    env?: NodeJS.ProcessEnv;
    fetch?: typeof globalThis.fetch;
  } = {},
) {
  // The listing names `demo`, which is not an id: its own route is 404.
  const rec = recorder((call) =>
    call.method === 'GET' && call.path === `/computers/${COMPUTER.name}`
      ? json({ error: 'no such computer ID' }, { status: 404 })
      : respond(call),
  );
  const stdout: Uint8Array[] = [];
  const stderr: Uint8Array[] = [];
  const io: Partial<CliIO> = {
    stdin: opts.stdin ?? piped(''),
    stdout: {
      write: ((s: string | Uint8Array) => {
        stdout.push(Buffer.from(s));
        return true;
      }) as NodeJS.WritableStream['write'],
    },
    stderr: opts.stderr ?? {
      write: ((s: string | Uint8Array) => {
        stderr.push(Buffer.from(s));
        return true;
      }) as NodeJS.WritableStream['write'],
    },
    env: { MANDALA_API_KEY: 'com_cli_test', MANDALA_MODEL_KEY: 'model_cli_test', ...opts.env },
    createClient: () =>
      new Client({ apiKey: 'com_cli_test', baseUrl: BASE, fetch: opts.fetch ?? rec.fetch }),
    now: () => new Date(stamp),
  };
  return {
    rec,
    io,
    agentBodies: () => rec.calls.filter(isAgentPost).map((c) => c.body as Record<string, unknown>),
    /** What has been written to stderr so far. */
    err: () => Buffer.concat(stderr).toString(),
    async run(args: string[], jsonMode = true) {
      const code = await main([...args, ...(jsonMode ? ['--json'] : [])], io);
      const out = Buffer.concat(stdout).toString();
      const err = Buffer.concat(stderr).toString();
      return {
        code,
        out,
        err,
        frames: jsonMode
          ? out
              .trim()
              .split('\n')
              .filter(Boolean)
              .map((line) => JSON.parse(line))
          : [],
      };
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('agent run --thread and --no-store', () => {
  it('continues a thread on the computer named', async () => {
    const h = harness();
    const result = await h.run([
      'agent',
      'run',
      'next',
      '--computer',
      COMPUTER.id,
      '--thread',
      THREAD,
    ]);
    expect(result.code).toBe(0);
    expect(h.rec.routes()).toEqual([
      ['GET', 'computers'],
      ['POST', `computers/${COMPUTER.id}/agent`],
    ]);
    expect(h.rec.last().body).toEqual({ prompt: 'next', stream: true, thread_id: THREAD });
  });

  it("without --computer, runs on the thread's own computer", async () => {
    const h = harness();
    const result = await h.run(['agent', 'run', 'next', '--thread', THREAD]);
    expect(result.code).toBe(0);
    expect(h.rec.routes()).toEqual([
      ['GET', `agent/threads/${THREAD}`],
      ['GET', `computers/${AGENT_THREAD.computer_id}`],
      ['POST', `computers/${AGENT_THREAD.computer_id}/agent`],
    ]);
    expect(h.rec.last().body).toMatchObject({ thread_id: THREAD });
  });

  it('sends store: false for --no-store', async () => {
    const h = harness();
    expect((await h.run(['agent', 'run', 'x', '--computer', COMPUTER.id, '--no-store'])).code).toBe(
      0,
    );
    expect(h.rec.last().body).toEqual({ prompt: 'x', stream: true, store: false });
  });

  it.each([
    [['agent', 'run', 'x', '--computer', 'vm', '--thread', THREAD, '--no-store']],
    [['agent', 'run', 'x', '--computer', 'vm', '--background', '--no-store']],
    [['agent', 'run', 'x']],
  ])('refuses %j as a usage error, before any request', async (argv) => {
    const h = harness();
    const result = await h.run(argv);
    expect(result.code).toBe(2);
    expect(result.frames).toHaveLength(1);
    expect(result.frames[0]).toMatchObject({ ok: false, error: { code: 'invalid_arguments' } });
    expect(h.rec.calls).toEqual([]);
  });

  it('says how to continue the thread a run started, for a person', async () => {
    const h = harness((call) => (isAgentPost(call) ? done(THREAD) : anyRoute(call)));
    const result = await h.run(['agent', 'run', 'x', '--computer', COMPUTER.id], false);
    expect(result.code).toBe(0);
    expect(result.out).toContain(`"thread_id":"${THREAD}"`);
    expect(result.err).toContain(`kept in thread ${THREAD}`);
    expect(result.err).toContain(`mandala agent resume ${THREAD}`);
  });

  it('says nothing more when the run continued the thread named', async () => {
    const h = harness((call) => (isAgentPost(call) ? done(THREAD) : anyRoute(call)));
    const result = await h.run(
      ['agent', 'run', 'x', '--computer', COMPUTER.id, '--thread', THREAD],
      false,
    );
    expect(result.err).toBe('');
  });

  it("puts a failed run's thread in its error frame", async () => {
    const h = harness((call) =>
      isAgentPost(call)
        ? sse([
            'error',
            { error: 'model API: overloaded', status: 529, steps: [], thread_id: THREAD },
          ])
        : anyRoute(call),
    );
    const result = await h.run(['agent', 'run', 'x', '--computer', COMPUTER.id]);
    expect(result.code).toBe(1);
    expect(result.frames.at(-1)).toMatchObject({
      type: 'error',
      data: { error: { code: 'agent_error', details: { status: 529, thread_id: THREAD } } },
    });
  });
});

describe('agent run --background', () => {
  it('starts a background run and answers it once, not as frames', async () => {
    const h = harness();
    const result = await h.run(['agent', 'run', 'tidy', '--computer', COMPUTER.id, '--background']);
    expect(result.code).toBe(0);
    expect(h.rec.routes()).toEqual([
      ['GET', 'computers'],
      ['POST', `computers/${COMPUTER.id}/agent/runs`],
    ]);
    expect(h.rec.last().body).toEqual({ prompt: 'tidy' });
    expect(h.rec.last().headers['X-Model-Key']).toBe('model_cli_test');
    expect(result.frames).toHaveLength(1);
    expect(result.frames[0]).toMatchObject({
      schema_version: 2,
      command: 'agent run',
      ok: true,
      exit_code: 0,
      data: { id: RUN, status: 'running', thread_id: null, computer_id: 'vm-1' },
    });
    expect(result.frames[0].data).not.toHaveProperty('raw');
  });

  it("prints only the run's id on stdout for a person", async () => {
    const h = harness();
    const result = await h.run(
      ['agent', 'run', 'tidy', '--computer', COMPUTER.id, '--background'],
      false,
    );
    expect(result.code).toBe(0);
    expect(result.out).toBe(`${RUN}\n`);
    expect(result.err).toContain(`mandala agent runs get ${RUN} --wait`);
    expect(result.err).toContain(`mandala agent runs cancel ${RUN}`);
  });

  it('continues a thread in the background on its own computer', async () => {
    const h = harness();
    expect((await h.run(['agent', 'run', 'more', '--thread', THREAD, '--background'])).code).toBe(
      0,
    );
    expect(h.rec.routes()).toEqual([
      ['GET', `agent/threads/${THREAD}`],
      ['POST', `computers/${AGENT_THREAD.computer_id}/agent/runs`],
    ]);
    expect(h.rec.last().body).toEqual({ prompt: 'more', thread_id: THREAD });
  });

  it('reports a refusal as one finite error, not an error frame', async () => {
    const h = harness((call) =>
      call.path.endsWith('/agent/runs')
        ? json({ error: 'computer is already being driven', reason: 'contention' }, { status: 409 })
        : anyRoute(call),
    );
    const result = await h.run(['agent', 'run', 'tidy', '--computer', COMPUTER.id, '--background']);
    expect(result.code).toBe(1);
    expect(result.frames).toEqual([
      expect.objectContaining({
        command: 'agent run',
        ok: false,
        error: expect.objectContaining({ code: 'conflict', status: 409, reason: 'contention' }),
      }),
    ]);
  });
});

describe('agent runs', () => {
  it('lists runs with every filter and paging, newest first', async () => {
    const h = harness(() => json({ runs: [{ ...AGENT_RUN, steps_taken: [] }], has_more: true }));
    const result = await h.run([
      'agent',
      'runs',
      'list',
      '--computer',
      'vm-0123456789ab',
      '--status',
      'completed',
      '--limit',
      '5',
      '--before',
      'run_ffffffffffffffffffffffff',
    ]);
    expect(result.code).toBe(0);
    // An id-shaped --computer is that id, never looked up.
    expect(h.rec.routes()).toEqual([['GET', 'agent/runs']]);
    expect(h.rec.last().query).toEqual({
      computer_id: 'vm-0123456789ab',
      status: 'completed',
      limit: '5',
      before: 'run_ffffffffffffffffffffffff',
    });
    expect(result.frames[0].data).toMatchObject({
      runs: [{ id: RUN, status: 'completed', finished: true, steps_taken: [] }],
      has_more: true,
      next_before: RUN,
    });
    expect(result.frames[0].data.runs[0]).not.toHaveProperty('raw');
    expect(result.frames[0].data.runs[0].result).not.toHaveProperty('raw');
  });

  it('resolves a computer name for the filter', async () => {
    const h = harness();
    expect((await h.run(['agent', 'runs', 'list', '--computer', COMPUTER.name])).code).toBe(0);
    expect(h.rec.last().query).toEqual({ computer_id: COMPUTER.id });
  });

  it('prints a table for a person, and how to read the next page', async () => {
    const h = harness(() =>
      json({
        runs: [
          { ...AGENT_RUN, steps_taken: [] },
          {
            ...AGENT_RUN,
            id: 'run_111111111111111111111111',
            result: { ...AGENT_RUN.result, stop: 'max_steps' },
            prompt: 'line one\nline two',
            steps_taken: [],
          },
        ],
        has_more: true,
      }),
    );
    const result = await h.run(['agent', 'runs', 'list'], false);
    expect(result.code).toBe(0);
    const lines = result.out.trim().split('\n');
    expect(lines[0]).toMatch(/^ID +STATUS +COMPUTER +THREAD +STEPS +CREATED +PROMPT$/);
    expect(lines[1]).toContain(`${RUN}  completed  `);
    expect(lines[2]).toContain('completed (max_steps)');
    expect(lines[2]).toMatch(/line one$/);
    expect(result.err).toContain('--before run_111111111111111111111111');
  });

  it.each([
    [2, ['agent', 'runs', 'list', '--status', 'done']],
    [1, ['agent', 'runs', 'list', '--limit', '101']],
    [2, ['agent', 'runs', 'list', '--before', ' ']],
    [1, ['agent', 'runs', 'list', '--limit', '0']],
    [2, ['agent', 'runs', 'get']],
    [1, ['agent', 'runs', 'get', RUN, '--timeout-ms', '10']],
    [1, ['agent', 'runs', 'get', RUN, '--wait', '--poll-ms', '0']],
    [2, ['agent', 'runs', 'cancel']],
  ])('exits %i for %j, making no requests', async (code, argv) => {
    const h = harness();
    expect((await h.run(argv)).code).toBe(code);
    expect(h.rec.calls).toEqual([]);
  });

  it('reads a run, exit 0 whatever its status', async () => {
    const h = harness(() =>
      json({
        ...AGENT_RUN,
        status: 'failed',
        result: undefined,
        error: { error: 'boom', status: 500 },
      }),
    );
    const result = await h.run(['agent', 'runs', 'get', RUN]);
    expect(result.code).toBe(0);
    expect(h.rec.routes()).toEqual([['GET', `agent/runs/${RUN}`]]);
    expect(result.frames[0]).toMatchObject({
      ok: true,
      data: { id: RUN, status: 'failed', error: { error: 'boom', status: 500 }, finished: false },
    });
  });

  it('waits for a run to end, exit 0 when it finished', async () => {
    let reads = 0;
    const h = harness(() => json(reads++ ? AGENT_RUN : AGENT_RUN_STARTED));
    const result = await h.run(['agent', 'runs', 'get', RUN, '--wait', '--poll-ms', '1']);
    expect(result.code).toBe(0);
    expect(h.rec.routes()).toEqual([
      ['GET', `agent/runs/${RUN}`],
      ['GET', `agent/runs/${RUN}`],
    ]);
    expect(result.frames[0]).toMatchObject({
      ok: true,
      exit_code: 0,
      data: { status: 'completed', finished: true, steps_taken: [{ n: 1 }] },
    });
  });

  it.each([
    [
      { status: 'completed', result: { ...AGENT_RUN.result, stop: 'max_steps' } },
      'completed without finishing the task (stop: max_steps)',
    ],
    [
      {
        status: 'failed',
        result: undefined,
        error: { error: 'model API: overloaded', status: 529 },
      },
      'failed: model API: overloaded',
    ],
    [{ status: 'cancelled', result: undefined }, 'was cancelled'],
    [
      { status: 'interrupted', result: undefined, error: { error: 'restarted', status: 503 } },
      'was interrupted: restarted',
    ],
  ])('exits 1 for a run that ended %j, and says why', async (ending, said) => {
    const h = harness(() => json({ ...AGENT_RUN, ...ending }));
    const machine = await h.run(['agent', 'runs', 'get', RUN, '--wait']);
    expect(machine.code).toBe(1);
    expect(machine.frames[0]).toMatchObject({
      ok: false,
      exit_code: 1,
      data: { status: ending.status },
    });
    const person = harness(() => json({ ...AGENT_RUN, ...ending }));
    const human = await person.run(['agent', 'runs', 'get', RUN, '--wait'], false);
    expect(human.code).toBe(1);
    expect(human.err).toContain(`run ${RUN} ${said}`);
  });

  it('stops waiting at the deadline with a timeout, and the run goes on', async () => {
    const h = harness(() => json(AGENT_RUN_STARTED));
    const result = await h.run([
      'agent',
      'runs',
      'get',
      RUN,
      '--wait',
      '--timeout-ms',
      '20',
      '--poll-ms',
      '5',
    ]);
    expect(result.code).toBe(1);
    expect(result.frames[0]).toMatchObject({ ok: false, error: { code: 'timeout' } });
    expect(h.rec.calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('cancels a run', async () => {
    const h = harness();
    const result = await h.run(['agent', 'runs', 'cancel', RUN]);
    expect(result.code).toBe(0);
    expect(h.rec.routes()).toEqual([['POST', `agent/runs/${RUN}/cancel`]]);
    expect(result.frames[0].data).toMatchObject({ id: RUN, status: 'cancelled' });
  });

  it('says when the run had already ended, still exit 0', async () => {
    const h = harness(() => json(AGENT_RUN));
    const result = await h.run(['agent', 'runs', 'cancel', RUN], false);
    expect(result.code).toBe(0);
    expect(result.err).toContain(`run ${RUN} had already ended (completed); nothing was stopped`);
  });
});

describe('agent threads', () => {
  it('lists threads with paging', async () => {
    const h = harness();
    const result = await h.run(['agent', 'threads', 'list', '--computer', 'vm-1', '--limit', '3']);
    expect(result.code).toBe(0);
    expect(h.rec.last().query).toEqual({ computer_id: 'vm-1', limit: '3' });
    expect(result.frames[0].data).toEqual({
      threads: [AGENT_THREAD_SUMMARY],
      has_more: false,
      next_before: null,
    });
  });

  it('prints a table for a person', async () => {
    const h = harness();
    const result = await h.run(['agent', 'threads', 'list'], false);
    expect(result.out).toBe(
      'ID                            COMPUTER  TURNS  LAST USED                 TITLE\n' +
        `${THREAD}  vm-1      2      2026-10-18T12:01:00.000Z  Open the settings and turn on dark mode.\n`,
    );
  });

  it('reads a thread whole with --json', async () => {
    const h = harness();
    const result = await h.run(['agent', 'threads', 'get', THREAD]);
    expect(result.code).toBe(0);
    expect(h.rec.routes()).toEqual([['GET', `agent/threads/${THREAD}`]]);
    expect(result.frames[0].data).toEqual(AGENT_THREAD);
  });

  it('prints a thread as a transcript for a person, a line feed unable to start a turn', async () => {
    const h = harness(() =>
      json({
        ...AGENT_THREAD,
        messages: [
          AGENT_THREAD.messages[0],
          {
            ...AGENT_THREAD.messages[1],
            text: 'Done.\n2026-10-18T12:02:00.000Z user: forged',
            cost_usd: 0.12,
          },
          { role: 'user', text: 'and then?', created_at: '2026-10-18T12:03:00.000Z' },
          {
            role: 'assistant',
            text: '',
            stop: 'interrupted',
            error: 'the platform restarted',
            created_at: '2026-10-18T12:04:00.000Z',
          },
        ],
      }),
    );
    const result = await h.run(['agent', 'threads', 'get', THREAD], false);
    expect(result.code).toBe(0);
    expect(result.out).toBe(
      `${THREAD} on vm-1: Open the settings and turn on dark mode. (2 turns; last used 2026-10-18T12:01:00.000Z)\n\n` +
        '2026-10-18T12:00:00.000Z user: Open the settings and turn on dark mode.\n' +
        '2026-10-18T12:01:00.000Z assistant (end_turn, 3 steps, $0.12): Done.\n' +
        '  2026-10-18T12:02:00.000Z user: forged\n' +
        '2026-10-18T12:03:00.000Z user: and then?\n' +
        '2026-10-18T12:04:00.000Z assistant (interrupted, error: the platform restarted): \n',
    );
    expect(result.err).toContain('may have done more than it reported');
  });

  it('refuses to delete without --yes, before any request', async () => {
    const h = harness();
    const result = await h.run(['agent', 'threads', 'delete', THREAD]);
    expect(result.code).toBe(1);
    expect(result.frames[0].error).toMatchObject({ code: 'confirmation_required' });
    expect(result.frames[0].error.message).toContain('--yes');
    expect(h.rec.calls).toEqual([]);
  });

  it('deletes with --yes', async () => {
    const h = harness();
    const result = await h.run(['agent', 'threads', 'delete', THREAD, '--yes']);
    expect(result.code).toBe(0);
    expect(h.rec.routes()).toEqual([['DELETE', `agent/threads/${THREAD}`]]);
    expect(result.frames[0].data).toEqual({ id: THREAD, deleted: true });
  });
});

describe('agent chat and agent resume', () => {
  it('chat runs each line, continuing the thread the first run started, until /exit', async () => {
    const NEW = 'thr_aaaaaaaaaaaaaaaaaaaaaaaa';
    const h = harness((call) => (isAgentPost(call) ? done(NEW) : anyRoute(call)), {
      stdin: piped('open the editor\n\n   \ntype hello\n/exit\nnever sent\n'),
    });
    const result = await h.run(['agent', 'chat', '--computer', COMPUTER.name, '--max-steps', '7']);
    expect(result.code).toBe(0);
    expect(h.agentBodies()).toEqual([
      { prompt: 'open the editor', stream: true, max_steps: 7 },
      { prompt: 'type hello', stream: true, max_steps: 7, thread_id: NEW },
    ]);
    expect(result.frames.map((f) => [f.command, f.type])).toEqual([
      ['agent chat', 'step'],
      ['agent chat', 'done'],
      ['agent chat', 'step'],
      ['agent chat', 'done'],
    ]);
    expect(result.frames[1].data).toMatchObject({ thread_id: NEW, exit_code: 0 });
  });

  it('chat starts afresh until a run names a thread', async () => {
    let runs = 0;
    const h = harness(
      (call) =>
        isAgentPost(call)
          ? runs++
            ? done('thr_bbbbbbbbbbbbbbbbbbbbbbbb')
            : done()
          : anyRoute(call),
      { stdin: piped('one\ntwo\nthree\n') },
    );
    expect((await h.run(['agent', 'chat', '--computer', COMPUTER.id])).code).toBe(0);
    expect(h.agentBodies().map((b) => b.thread_id)).toEqual([
      undefined,
      undefined,
      'thr_bbbbbbbbbbbbbbbbbbbbbbbb',
    ]);
  });

  it('says which thread a chat is, for a person', async () => {
    const NEW = 'thr_cccccccccccccccccccccccc';
    const h = harness((call) => (isAgentPost(call) ? done(NEW) : anyRoute(call)), {
      stdin: piped('one\n'),
    });
    const result = await h.run(['agent', 'chat', '--computer', COMPUTER.id], false);
    expect(result.code).toBe(0);
    expect(result.out).toContain(`${stamp} done:`);
    expect(result.err).toContain(`this conversation is thread ${NEW}`);
    expect(result.err).toContain(`mandala agent resume ${NEW}`);
    // Piped, not a terminal: no prompt and no greeting.
    expect(result.err).not.toContain('> ');
  });

  it('resume runs each line on the thread named, on its computer', async () => {
    const h = harness((call) => (isAgentPost(call) ? done(THREAD) : anyRoute(call)), {
      stdin: piped('first\r\nsecond'),
    });
    const result = await h.run(['agent', 'resume', THREAD, '--model', 'claude-opus-5-5']);
    expect(result.code).toBe(0);
    expect(h.rec.routes()).toEqual([
      ['GET', `agent/threads/${THREAD}`],
      ['GET', `computers/${AGENT_THREAD.computer_id}`],
      ['POST', `computers/${AGENT_THREAD.computer_id}/agent`],
      ['POST', `computers/${AGENT_THREAD.computer_id}/agent`],
    ]);
    expect(h.agentBodies()).toEqual([
      { prompt: 'first', stream: true, model: 'claude-opus-5-5', thread_id: THREAD },
      { prompt: 'second', stream: true, model: 'claude-opus-5-5', thread_id: THREAD },
    ]);
  });

  it('reports a run that failed and goes on to the next line, exiting 1', async () => {
    let runs = 0;
    const h = harness(
      (call) =>
        isAgentPost(call)
          ? runs++
            ? done(THREAD)
            : json({ error: 'thread is full', code: 'THREAD_FULL' }, { status: 409 })
          : anyRoute(call),
      { stdin: piped('one\ntwo\n') },
    );
    const result = await h.run(['agent', 'resume', THREAD]);
    expect(result.code).toBe(1);
    expect(h.agentBodies()).toHaveLength(2);
    expect(result.frames.map((f) => f.type)).toEqual(['error', 'step', 'done']);
    expect(result.frames[0].data).toMatchObject({
      error: { code: 'conflict', status: 409 },
      exit_code: 1,
    });
  });

  it('exits 1 when a run did not finish', async () => {
    const h = harness((call) => (isAgentPost(call) ? done(THREAD, 'max_steps') : anyRoute(call)), {
      stdin: piped('one\n'),
    });
    expect((await h.run(['agent', 'resume', THREAD])).code).toBe(1);
  });

  it('runs nothing on empty input, exit 0', async () => {
    const h = harness(anyRoute, { stdin: piped('') });
    expect((await h.run(['agent', 'resume', THREAD])).code).toBe(0);
    expect(h.agentBodies()).toEqual([]);
  });

  it('refuses resume with no thread when stdin is not a terminal, before any request', async () => {
    const h = harness(anyRoute, { stdin: piped('1\n') });
    const result = await h.run(['agent', 'resume']);
    expect(result.code).toBe(2);
    expect(result.frames[0]).toMatchObject({
      type: 'error',
      data: { error: { code: 'invalid_arguments' }, exit_code: 2 },
    });
    expect(h.rec.calls).toEqual([]);
  });

  it.each([
    [['agent', 'chat', '--computer', 'vm', '--max-steps', '101']],
    [['agent', 'resume', THREAD, '--max-cost-usd', '50']],
  ])('checks the run options of %j before reading a line', async (argv) => {
    const h = harness(anyRoute, { stdin: piped('one\n') });
    expect((await h.run(argv)).code).toBe(1);
    expect(h.rec.calls).toEqual([]);
  });

  it('refuses a session on a MANDALA_MODEL_KEY set but empty', async () => {
    const h = harness(anyRoute, { stdin: piped('one\n'), env: { MANDALA_MODEL_KEY: ' ' } });
    expect((await h.run(['agent', 'chat', '--computer', COMPUTER.id])).code).toBe(1);
    expect(h.rec.calls).toEqual([]);
  });

  it('picks a thread on a terminal, then greets and prompts', async () => {
    const OTHER = { ...AGENT_THREAD_SUMMARY, id: 'thr_dddddddddddddddddddddddd', title: 'second' };
    const h = harness(
      (call) =>
        call.path === '/agent/threads'
          ? json({ threads: [AGENT_THREAD_SUMMARY, OTHER], has_more: true })
          : call.path === `/agent/threads/${OTHER.id}`
            ? json({ ...AGENT_THREAD, id: OTHER.id, title: 'second' })
            : isAgentPost(call)
              ? done(OTHER.id)
              : anyRoute(call),
      { stdin: piped('7\nnope\n2\ngo on\n', true) },
    );
    const result = await h.run(['agent', 'resume'], false);
    expect(result.code).toBe(0);
    expect(h.rec.calls[0]!.query).toEqual({ limit: '20' });
    expect(h.agentBodies()).toEqual([{ prompt: 'go on', stream: true, thread_id: OTHER.id }]);
    expect(result.err).toContain('#  THREAD');
    expect(result.err).toContain(`2  ${OTHER.id}`);
    expect(result.err).toContain('type the id of an older one');
    expect(result.err.match(/Type a number from 1 to 2/g)).toHaveLength(2);
    expect(result.err).toContain(`Resuming ${OTHER.id} on vm-1: second`);
    expect(result.err).toContain('assistant (end_turn, 3 steps): Dark mode is on.');
    expect(result.err).toContain('Ctrl-D or /exit leaves');
  });

  it('takes a thread id typed at the picker', async () => {
    const h = harness((call) => (isAgentPost(call) ? done(THREAD) : anyRoute(call)), {
      stdin: piped(`${THREAD}\nhi\n`, true),
    });
    expect((await h.run(['agent', 'resume'])).code).toBe(0);
    expect(h.agentBodies()).toEqual([{ prompt: 'hi', stream: true, thread_id: THREAD }]);
  });

  it('runs nothing when no thread is chosen, exit 130', async () => {
    const h = harness(anyRoute, { stdin: piped('\n', true) });
    const result = await h.run(['agent', 'resume']);
    expect(result.code).toBe(130);
    expect(result.frames.at(-1).data.error).toMatchObject({ code: 'cancelled' });
    expect(h.rec.routes()).toEqual([['GET', 'agent/threads']]);
  });

  it('says there is nothing to resume when no thread exists', async () => {
    const h = harness(() => json({ threads: [], has_more: false }), { stdin: piped('', true) });
    const result = await h.run(['agent', 'resume']);
    expect(result.code).toBe(1);
    expect(result.frames.at(-1).data.error.message).toContain('mandala agent chat --computer');
  });

  it('stops only the run in flight on Ctrl-C, then runs the next line', async () => {
    let first: ReadableStreamDefaultController<Uint8Array> | undefined;
    let aborted = false;
    const h = harness(
      (call) =>
        isAgentPost(call) && !first
          ? new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  first = controller;
                  controller.enqueue(
                    new TextEncoder().encode('event: step\ndata: {"n":1,"tool":"bash"}\n\n'),
                  );
                },
              }),
              { headers: { 'content-type': 'text/event-stream' } },
            )
          : isAgentPost(call)
            ? done(THREAD)
            : anyRoute(call),
      { stdin: piped('slow\nquick\n') },
    );
    // A constructed Response's body does not end on abort as a real fetch's does.
    h.io.createClient = () =>
      new Client({
        apiKey: 'com_cli_test',
        baseUrl: BASE,
        fetch: async (input, init) => {
          const response = await h.rec.fetch(input, init);
          if (String(input).endsWith('/agent') && first && !aborted)
            init?.signal?.addEventListener(
              'abort',
              () => {
                aborted = true;
                first!.error(init.signal?.reason);
              },
              { once: true },
            );
          return response;
        },
      });
    const before = process.listenerCount('SIGINT');
    const pending = h.run(['agent', 'resume', THREAD]);
    await vi.waitFor(() => expect(h.agentBodies()).toHaveLength(1));
    await vi.waitFor(() => expect(first).toBeDefined());
    process.emit('SIGINT');
    const result = await pending;
    expect(aborted).toBe(true);
    expect(h.agentBodies().map((b) => b.prompt)).toEqual(['slow', 'quick']);
    expect(result.frames.map((f) => f.type)).toEqual(['step', 'error', 'step', 'done']);
    expect(result.frames[1].data).toMatchObject({ error: { code: 'cancelled' }, exit_code: 130 });
    // A run was stopped, so not every run finished.
    expect(result.code).toBe(1);
    expect(process.listenerCount('SIGINT')).toBe(before);
  });

  it('ends the session on Ctrl-C while waiting for piped input, exit 130', async () => {
    const stdin = Object.assign(new PassThrough(), { isTTY: false }) as unknown as Stdin;
    const h = harness(anyRoute, { stdin });
    const before = process.listenerCount('SIGINT');
    const pending = h.run(['agent', 'resume', THREAD]);
    await vi.waitFor(() => expect(h.rec.calls).toHaveLength(2));
    // The session is waiting on stdin once it has read the thread's computer.
    await new Promise((resolve) => setTimeout(resolve, 10));
    process.emit('SIGINT');
    const result = await pending;
    expect(result.code).toBe(130);
    expect(result.frames.at(-1).data.error).toMatchObject({ code: 'cancelled' });
    expect(h.agentBodies()).toEqual([]);
    expect(process.listenerCount('SIGINT')).toBe(before);
  });

  it('keeps the session at a terminal prompt on Ctrl-C, saying how to leave', async () => {
    const stdin = Object.assign(new PassThrough(), { isTTY: true }) as unknown as Stdin;
    const h = harness((call) => (isAgentPost(call) ? done(THREAD) : anyRoute(call)), { stdin });
    const pending = h.run(['agent', 'resume', THREAD], false);
    // At the prompt: the greeting is written, and then the prompt.
    await vi.waitFor(() => expect(h.err()).toMatch(/leaves\.\n> $/));
    process.emit('SIGINT');
    (stdin as unknown as PassThrough).end('after\n');
    const result = await pending;
    expect(result.code).toBe(0);
    expect(result.err).toContain('(Ctrl-D or /exit to leave)');
    expect(h.agentBodies().map((b) => b.prompt)).toEqual(['after']);
  });
});

describe('agent chat and agent resume at a terminal', () => {
  it('reads a line of any length in raw mode, and gives the terminal its line mode for a run', async () => {
    const t = terminal();
    let rawDuringRun: boolean | undefined;
    const h = harness((call) => {
      if (!isAgentPost(call)) return anyRoute(call);
      rawDuringRun = t.stdin.isRaw;
      return done(THREAD);
    }, t.io);
    const pending = h.run(['agent', 'resume', THREAD], false);
    await vi.waitFor(() => expect(t.drawn()).toContain('> '));
    // Past the 1024 bytes a terminal's own line mode takes on macOS.
    const long = `${'x'.repeat(3000)} and then save it`;
    t.type(`${long}\r`);
    await vi.waitFor(() => expect(h.agentBodies()).toHaveLength(1));
    t.type('\x04');
    const result = await pending;
    expect(result.code).toBe(0);
    expect(h.agentBodies()[0]).toMatchObject({ prompt: long, thread_id: THREAD });
    // Raw for the prompt, the terminal's line mode for the run (where Ctrl-C
    // is SIGINT), raw again, and the terminal left as it was found.
    expect(rawDuringRun).toBe(false);
    expect(t.stdin.setRawMode.mock.calls.map(([mode]) => mode)).toEqual([true, false, true, false]);
    expect(t.stdin.isRaw).toBe(false);
  });

  it('drops the line on a Ctrl-C key at the prompt, says how to leave, and goes on', async () => {
    const t = terminal();
    const h = harness((call) => (isAgentPost(call) ? done(THREAD) : anyRoute(call)), t.io);
    const before = process.listenerCount('SIGINT');
    const pending = h.run(['agent', 'resume', THREAD], false);
    await vi.waitFor(() => expect(t.drawn()).toContain('> '));
    t.type('half typed');
    t.type('\x03');
    await vi.waitFor(() => expect(t.drawn()).toContain('(Ctrl-D or /exit to leave)'));
    t.type('hi\r');
    await vi.waitFor(() => expect(h.agentBodies()).toHaveLength(1));
    t.type('/exit\r');
    const result = await pending;
    expect(result.code).toBe(0);
    expect(h.agentBodies().map((b) => b.prompt)).toEqual(['hi']);
    expect(process.listenerCount('SIGINT')).toBe(before);
  });

  it('ends the session on a Ctrl-C key at the picker, exit 130, the terminal restored', async () => {
    const t = terminal();
    const h = harness(anyRoute, t.io);
    const pending = h.run(['agent', 'resume']);
    await vi.waitFor(() => expect(t.drawn()).toContain('Resume which?'));
    t.type('\x03');
    const result = await pending;
    expect(result.code).toBe(130);
    expect(result.frames.at(-1).data.error).toMatchObject({ code: 'cancelled' });
    expect(h.rec.routes()).toEqual([['GET', 'agent/threads']]);
    expect(t.stdin.isRaw).toBe(false);
  });
});

describe('agent threads and runs redact before they cut', () => {
  const KEY = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';

  it('masks a key the PROMPT column cut goes through', async () => {
    const prompt = `${'p'.repeat(40)} ${KEY} and more`;
    const h = harness(
      () => json({ runs: [{ ...AGENT_RUN, prompt, steps_taken: [] }], has_more: false }),
      { env: { MANDALA_MODEL_KEY: KEY } },
    );
    const result = await h.run(['agent', 'runs', 'list'], false);
    expect(result.code).toBe(0);
    expect(result.out).toContain('[REDACTED]');
    expect(result.out).not.toContain(KEY.slice(0, 12));
  });

  it("masks a key the resume greeting's cut goes through", async () => {
    const text = `${'a'.repeat(480)} ${KEY}`;
    const t = terminal();
    const h = harness(
      (call) =>
        call.path === `/agent/threads/${THREAD}`
          ? json({ ...AGENT_THREAD, messages: [{ ...AGENT_THREAD.messages[1], text }] })
          : anyRoute(call),
      { ...t.io, env: { MANDALA_MODEL_KEY: KEY } },
    );
    const pending = h.run(['agent', 'resume', THREAD], false);
    await vi.waitFor(() => expect(t.drawn()).toContain('> '));
    t.type('\x04');
    expect((await pending).code).toBe(0);
    expect(t.drawn()).toContain('[REDACTED]');
    expect(t.drawn()).not.toContain(KEY.slice(0, 9));
  });
});

describe('the agent commands in the manifest, help and completion', () => {
  it('describes each, with the exit status of the new modes', () => {
    const tree = manifest();
    const at = (path: string) => tree.commands.find((c) => c.path.join(' ') === path)!;
    expect(at('agent chat').json_mode).toBe('ndjson');
    expect(at('agent resume').json_mode).toBe('ndjson');
    expect(at('agent resume').arguments).toEqual([
      { name: 'thread', required: false, type: 'string' },
    ]);
    expect(at('agent runs list').flags.find((f) => f.name === 'status')?.choices).toEqual([
      'running',
      'completed',
      'failed',
      'cancelled',
      'interrupted',
    ]);
    expect(at('agent run').flags.find((f) => f.name === 'computer')).toMatchObject({
      required: true,
      required_unless: ['thread'],
    });
    expect(at('agent threads delete').flags.find((f) => f.name === 'yes')).toMatchObject({
      required: true,
    });
    expect(tree.output.agent_run).toContain('--background');
    expect(tree.output.agent_runs).toContain('exits 0 only when it finished');
    expect(tree.output.agent_session).toContain('/exit');
    expect(help('agent')).toContain('mandala agent resume [thread]');
    expect(help('agent run')).toContain('--computer <string> (required unless --thread)');
    // --yes is the command's own refusal, not the parser's.
    expect(() => parseArgs(['agent', 'threads', 'delete', THREAD])).not.toThrow();
  });

  it('completes the new verbs and the run statuses', () => {
    for (const shell of ['bash', 'zsh'] as const) {
      expect(completion(shell)).toContain(
        "'agent runs list|--status') candidates='running completed failed cancelled interrupted' ;;",
      );
      expect(completion(shell)).toMatch(/'agent'\) candidates='run chat resume runs threads/);
      expect(completion(shell)).toMatch(
        /'agent run'\) candidates='[^']*--thread [^']*--background/,
      );
    }
    expect(completion('fish')).toContain(
      "-l status -r -a 'running completed failed cancelled interrupted'",
    );
  });
});
