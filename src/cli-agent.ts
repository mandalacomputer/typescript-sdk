/**
 * `mandala agent`'s conversations and background runs (OPL-5474).
 *
 * A run is kept in a thread on its computer unless it was sent with
 * `--no-store`. `agent run --thread` continues one, `agent threads` reads and
 * deletes them, and `agent chat` and `agent resume` continue one line by line,
 * each line a run streamed as `agent run` streams it. `agent run --background`
 * starts a run that goes on after the command exits, and `agent runs` reads,
 * waits on and stops it.
 *
 * Every request here is the SDK's own: `client.agentThreads`,
 * `client.agentRuns` and `Computer.agentStream`.
 */

import { createInterface } from 'node:readline';
import { agentRunEnded } from './agent.js';
import { CliError, help } from './cli-options.js';
import {
  errorInfo,
  listTable,
  type Output,
  redact,
  snakeKeys,
  terminalSafe,
} from './cli-output.js';
import type { CliIO } from './cli-runtime.js';
import type { Computer } from './computer.js';
import type {
  AgentArgs,
  AgentRun,
  AgentRunArgs,
  AgentThreadSummary,
  AgentThreadTurn,
  Client,
} from './index.js';
import type * as P from './paths.js';

/**
 * What the SDK decoded, as the CLI prints it: without the `raw` copy of what
 * was sent that each decoded object keeps (a run's `result` keeps its own),
 * and in the API's snake_case, as `agent run`'s frames are.
 */
function withoutRaw(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutRaw);
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const { raw: _raw, ...fields } = value as Record<string, unknown>;
    return Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, withoutRaw(v)]));
  }
  return value;
}
const shown = (value: unknown) => snakeKeys(withoutRaw(value)) as Record<string, unknown>;

/** The shortest start of a key {@link redactCut} masks at the end of a text: a shorter one is no secret. */
const CUT_KEY_MIN = 4;

/**
 * `text` redacted, as every output is, and then the end of it masked too
 * where a key begins there and the text stops. The platform keeps only the
 * start of some texts (a thread's title is the first 80 characters of a
 * prompt, a run's prompt and a turn's text the first 32,000), so a key typed
 * across that cut is kept in part, and a part no longer matches the key it
 * came from: the title alone could print all of a key but its last character.
 */
function redactCut(io: CliIO, text: string): string {
  const whole = redact(text, io.env, io.secrets) as string;
  const keys = [...(io.secrets ?? []), io.env.MANDALA_API_KEY, io.env.MANDALA_MODEL_KEY].flatMap(
    (key) => (key ? [key, key.trim()] : []),
  );
  for (const key of keys)
    for (let n = Math.min(key.length - 1, whole.length); n >= CUT_KEY_MIN; n--)
      if (whole.endsWith(key.slice(0, n))) return `${whole.slice(0, -n)}[REDACTED]`;
  return whole;
}

/** A thread, its title and turns masked where the platform cut them (see {@link redactCut}). */
function threadSafe<T extends AgentThreadSummary & { messages?: AgentThreadTurn[] }>(
  io: CliIO,
  thread: T,
): T {
  return {
    ...thread,
    title: redactCut(io, thread.title),
    ...(thread.messages
      ? { messages: thread.messages.map((turn) => ({ ...turn, text: redactCut(io, turn.text) })) }
      : {}),
  };
}

/** A run, its prompt masked where the platform cut it (see {@link redactCut}). */
const runSafe = (io: CliIO, run: AgentRun): AgentRun => ({
  ...run,
  prompt: redactCut(io, run.prompt),
});

/** How one streamed run ended, for `agent run` and for each run of a session. */
export type StreamedRun = {
  /** 0 only for a run that finished (`stop: end_turn`); 1 for any other ending. */
  code: number;
  /** The thread the run was kept in, when it named one. */
  threadId?: string;
};

/**
 * One run, streamed: each `step` and `text` frame as it happens, then `done`
 * with the result, or an `error` frame for a run the platform stopped, which
 * keeps the steps it had taken and what it had spent. Throws what the request
 * itself throws, a refusal answered before the stream included.
 */
export async function streamAgentRun(
  c: Computer,
  agent: AgentArgs,
  output: Output,
): Promise<StreamedRun> {
  for await (const event of c.agentStream(agent)) {
    if (event.type === 'error') {
      // The funded run the account's credits could not start, reported on the
      // stream: the same refusal InsufficientCreditsError is when it is the
      // response, under the same code, with where to top up.
      const short = event.status === 402 && event.topUpUrl !== undefined;
      output.error(
        new CliError(
          short ? 'insufficient_credits' : 'agent_error',
          short ? `${event.error} (add credits at ${event.topUpUrl})` : event.error,
          {
            status: event.status,
            steps: event.steps,
            usage: event.usage,
            ...(event.costUsd === undefined ? {} : { costUsd: event.costUsd }),
            ...(event.topUpUrl === undefined ? {} : { topUpUrl: event.topUpUrl }),
            // A failed run that acted first, or continued a thread, is kept.
            ...(event.threadId === undefined ? {} : { threadId: event.threadId }),
          },
        ),
        1,
        true,
      );
      return { code: 1, ...(event.threadId === undefined ? {} : { threadId: event.threadId }) };
    }
    if (event.type === 'done') {
      const code = event.result.finished ? 0 : 1;
      const { raw: _raw, ...summary } = event.result;
      output.frame('done', snakeKeys({ ...summary, exitCode: code }));
      return {
        code,
        ...(event.result.threadId === undefined ? {} : { threadId: event.result.threadId }),
      };
    }
    output.frame(event.type, event.type === 'step' ? snakeKeys(event.step) : event.text);
  }
  throw new CliError('incomplete_stream', 'Agent stream ended without a result');
}

/**
 * `agent run --background`: start the run and say so. Its id alone on stdout
 * for a person, so `RUN=$(mandala agent run ... --background)` holds it; the
 * run as started with `--json`.
 */
export async function agentRunBackground(
  client: Client,
  computerId: string,
  agent: AgentArgs,
  io: CliIO,
  output: Output,
  signal: AbortSignal,
): Promise<number> {
  // A background run is always kept, and is stopped by agent runs cancel
  // rather than by abandoning a request: the parser has refused --no-store.
  const { signal: _signal, store: _store, ...args } = agent;
  const run = runSafe(
    io,
    await client.agentRuns.start(computerId, args satisfies AgentRunArgs, { signal }),
  );
  if (output.json) return output.result(shown(run));
  io.stdout.write(`${terminalSafe(run.id)}\n`);
  output.diagnostic(
    `mandala: run ${run.id} goes on in the background; follow it with: mandala agent runs get ${run.id} --wait; stop it with: mandala agent runs cancel ${run.id}`,
    { keepNewlines: false },
  );
  return 0;
}

/**
 * The first line of `text`, cut to `max` characters, for a table cell.
 * Redacted WHOLE first: a key the cut went through would no longer match
 * itself, and most of it would be printed.
 */
function promptCell(io: CliIO, text: string, max = 60): string {
  const line = (redact(text, io.env, io.secrets) as string).split('\n', 1)[0]!.trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** The next page of a listing, said on stderr so the table still pipes clean. */
function morePages(output: Output, next: string | null, what: string): void {
  if (next === null) return;
  output.diagnostic(`More ${what} are available. Next page: --before ${next}`, {
    keepNewlines: false,
  });
  output.diagnostic(
    'Repeat this command with --before and that id, keeping the same filters and page size.',
  );
}

/**
 * A run's status for a table: a run that completed without finishing says how
 * it stopped, `unknown` when it carried no result, as `agent runs get --wait`
 * says it.
 */
const runStatus = (run: AgentRun) =>
  run.status === 'completed' && !run.finished
    ? `completed (${run.result?.stop ?? 'unknown'})`
    : run.status;

export async function agentRunsList(
  client: Client,
  io: CliIO,
  output: Output,
  args: P.AgentRunListArgs,
  signal: AbortSignal,
): Promise<number> {
  const page = await client.agentRuns.list(args, { signal });
  const runs = page.runs.map((run) => runSafe(io, run));
  if (output.json)
    return output.result({
      runs: runs.map(shown),
      has_more: page.hasMore,
      next_before: page.nextBefore,
    });
  listTable(
    io,
    ['ID', 'STATUS', 'COMPUTER', 'THREAD', 'STEPS', 'CREATED', 'PROMPT'],
    runs.map((r) => [
      r.id,
      runStatus(r),
      r.computerId,
      r.threadId,
      r.steps,
      r.createdAt,
      promptCell(io, r.prompt),
    ]),
    'No agent runs on this page.',
  );
  morePages(output, page.nextBefore, 'runs');
  return 0;
}

/** Why a run that ended did not finish, in a line. */
function runEnding(run: AgentRun): string {
  const why = run.error
    ? `: ${run.error.error}${run.error.topUpUrl ? ` (add credits at ${run.error.topUpUrl})` : ''}`
    : '';
  switch (run.status) {
    case 'completed':
      return `mandala: run ${run.id} completed without finishing the task (stop: ${run.result?.stop ?? 'unknown'})`;
    case 'cancelled':
      return `mandala: run ${run.id} was cancelled; what it did before that stands`;
    case 'failed':
      return `mandala: run ${run.id} failed${why}`;
    case 'interrupted':
      return `mandala: run ${run.id} was interrupted${why}; it is not resumed, so look at the desktop before starting another`;
    default:
      return `mandala: run ${run.id} ended ${run.status}${why}`;
  }
}

/**
 * `agent runs get`: the run as it stands, exit 0. With `--wait`, the run once
 * it has ended, whatever the ending, and exit 0 only when it finished: a run
 * that completed at another stop, failed, was cancelled or was interrupted
 * exits 1, as `agent run` exits 1 for a run that did not finish. The wait's
 * own deadline is a `timeout`, and the run goes on past it.
 */
export async function agentRunsGet(
  client: Client,
  io: CliIO,
  output: Output,
  id: string,
  wait: { wait: boolean; timeoutMs?: number; pollMs?: number },
  signal: AbortSignal,
): Promise<number> {
  if (!wait.wait)
    return output.result(shown(runSafe(io, await client.agentRuns.get(id, { signal }))));
  const run = runSafe(
    io,
    await client.agentRuns.wait(id, { timeoutMs: wait.timeoutMs, pollMs: wait.pollMs, signal }),
  );
  const code = run.finished ? 0 : 1;
  if (code && !output.json) output.diagnostic(runEnding(run), { keepNewlines: false });
  return output.result(shown(run), code);
}

/** `agent runs cancel`: exit 0, also for a run that had already ended, which is answered as it is. */
export async function agentRunsCancel(
  client: Client,
  io: CliIO,
  output: Output,
  id: string,
  signal: AbortSignal,
): Promise<number> {
  const run = runSafe(io, await client.agentRuns.cancel(id, { signal }));
  if (!output.json && agentRunEnded(run) && run.status !== 'cancelled')
    output.diagnostic(
      `mandala: run ${run.id} had already ended (${run.status}); nothing was stopped`,
      {
        keepNewlines: false,
      },
    );
  return output.result(shown(run));
}

export async function agentThreadsList(
  client: Client,
  io: CliIO,
  output: Output,
  args: P.AgentThreadListArgs,
  signal: AbortSignal,
): Promise<number> {
  const page = await client.agentThreads.list(args, { signal });
  const threads = page.threads.map((thread) => threadSafe(io, thread));
  if (output.json)
    return output.result({
      threads: threads.map(shown),
      has_more: page.hasMore,
      next_before: page.nextBefore,
    });
  listTable(
    io,
    ['ID', 'COMPUTER', 'TURNS', 'LAST USED', 'TITLE'],
    threads.map((t) => [t.id, t.computerId, t.turns, t.updatedAt, t.title]),
    'No agent threads on this page.',
  );
  morePages(output, page.nextBefore, 'threads');
  return 0;
}

/** The assistant stops of a run that may have done more than it reported. */
const UNSETTLED: ReadonlySet<string> = new Set(['running', 'aborted', 'interrupted']);

/**
 * Turns for a person, one line each, oldest first: when, whose, and for an
 * answer how its run ended. The text is a prompt or a model's, redacted and
 * escaped; a line feed in it is kept and the line after it indented, so no
 * line of it can pass for another turn. `clip` cuts each text to that many
 * characters, after it is redacted: cut first, a key the cut went through
 * would no longer match itself.
 */
function turnLines(io: CliIO, turns: readonly AgentThreadTurn[], clip?: number): string {
  const hidden = (text: string) => redact(text, io.env, io.secrets) as string;
  const safe = (text: string) =>
    terminalSafe(hidden(text), { keepNewlines: true }).replace(/\n/g, '\n  ');
  return turns
    .map((turn) => {
      const how = [
        turn.stop,
        turn.steps === undefined ? undefined : `${turn.steps} step${turn.steps === 1 ? '' : 's'}`,
        turn.costUsd === undefined ? undefined : `$${turn.costUsd}`,
        turn.error === undefined ? undefined : `error: ${turn.error}`,
      ].filter((part) => part !== undefined);
      const whole = hidden(turn.text);
      const text = clip !== undefined && whole.length > clip ? `${whole.slice(0, clip)}…` : whole;
      return `${safe(turn.createdAt)} ${safe(turn.role)}${how.length ? ` (${safe(how.join(', '))})` : ''}: ${safe(text)}\n`;
    })
    .join('');
}

/** A thread's header line for a person: its id, its computer and its title. */
const threadLine = (io: CliIO, t: AgentThreadSummary) =>
  terminalSafe(
    redact(
      `${t.id} on ${t.computerId}: ${t.title} (${t.turns} turn${t.turns === 1 ? '' : 's'}; last used ${t.updatedAt})`,
      io.env,
      io.secrets,
    ) as string,
  );

/**
 * `agent threads get`: the turns as a transcript for a person, the decoded
 * thread with `--json`.
 */
export async function agentThreadsGet(
  client: Client,
  io: CliIO,
  output: Output,
  id: string,
  signal: AbortSignal,
): Promise<number> {
  const thread = threadSafe(io, await client.agentThreads.get(id, { signal }));
  if (output.json) return output.result(shown(thread));
  io.stdout.write(`${threadLine(io, thread)}\n\n${turnLines(io, thread.messages)}`);
  if (thread.messages.some((turn) => turn.stop !== undefined && UNSETTLED.has(turn.stop)))
    output.diagnostic(
      'mandala: a run marked running, aborted or interrupted may have done more than it reported; look at the desktop before continuing',
    );
  return 0;
}

export async function agentThreadsDelete(
  client: Client,
  output: Output,
  id: string,
  signal: AbortSignal,
): Promise<number> {
  await client.agentThreads.delete(id, { signal });
  return output.result({ id, deleted: true });
}

/** How many lines a session reads ahead of the prompt that asks for them. */
const QUEUED_LINES = 16;

/** Said when Ctrl-C lands on the prompt rather than on a run. */
const HOW_TO_LEAVE = '(Ctrl-D or /exit to leave)';

/**
 * Lines from stdin, one at a time, as they are asked for. Read as they
 * arrive, so a line piped (or typed) while a run goes waits for its turn
 * rather than being lost.
 *
 * At a terminal, stdin and stderr both, readline holds the line in the
 * terminal's raw mode: it echoes and edits it, keeps a history, and takes a
 * line of any length. The terminal's own line mode stops taking a line at its
 * limit (1024 bytes on macOS), so a task description pasted at a prompt read
 * that way never arrived, and nothing typed after it did either. In raw mode
 * Ctrl-C is a key, which readline reports as its `SIGINT`, handed to
 * `interrupt`; Ctrl-D on an empty line ends the input. {@link hold} gives the
 * terminal its line mode back for a run, in which Ctrl-C is the process's
 * SIGINT again, which is what stops the run. What is typed while a run goes
 * is the terminal's own type-ahead, held to its limit, as it is while a shell
 * runs any command.
 *
 * Anywhere else (piped input, or a terminal writing stderr to a file) lines
 * are read as they come and nothing is drawn but the prompt, and that only
 * when stdin is a terminal.
 */
function lineReader(io: CliIO, interrupt: () => void) {
  const { stdin } = io;
  const terminal =
    stdin.isTTY === true && io.stderr.isTTY === true && typeof stdin.setRawMode === 'function';
  const rl = createInterface({
    input: stdin,
    ...(terminal
      ? { output: io.stderr as unknown as NodeJS.WritableStream, terminal: true }
      : { terminal: false }),
    crlfDelay: Infinity,
  });
  const lines: string[] = [];
  let closed = false;
  // Held for a run at a terminal (see hold), or full of lines not asked for yet.
  let held = false;
  let wake: (() => void) | undefined;
  // Read only while there is room: a file or a producer that never stops
  // waits in its pipe rather than in memory while a run goes. readline may
  // still hand over the rest of a chunk already read, so this bounds the
  // queue by a chunk, not exactly.
  const flow = () => {
    if (closed) return;
    if (held || lines.length >= QUEUED_LINES) rl.pause();
    else rl.resume();
  };
  rl.on('line', (line) => {
    lines.push(line);
    if (lines.length >= QUEUED_LINES) flow();
    wake?.();
  });
  rl.on('close', () => {
    closed = true;
    wake?.();
  });
  if (terminal) rl.on('SIGINT', interrupt);
  return {
    /**
     * The next line, or `undefined` at the end of the input, asked for with
     * `prompt` when none is waiting already.
     */
    async next(signal: AbortSignal, prompt = ''): Promise<string | undefined> {
      if (!lines.length && !closed) {
        if (terminal) {
          rl.setPrompt(prompt);
          rl.prompt();
        } else if (prompt && stdin.isTTY) io.stderr.write(prompt);
      }
      for (;;) {
        signal.throwIfAborted();
        if (lines.length) {
          const line = lines.shift();
          flow();
          return line;
        }
        if (closed) return undefined;
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => {
            wake = undefined;
            reject(signal.reason);
          };
          wake = () => {
            wake = undefined;
            signal.removeEventListener('abort', onAbort);
            resolve();
          };
          signal.addEventListener('abort', onAbort, { once: true });
        });
      }
    },
    /** Ctrl-C at the prompt: drop what was typed, say how to leave, and ask again. */
    reprompt(prompt: string): void {
      if (!terminal) {
        // The terminal's line mode has dropped the line already.
        io.stderr.write(`\n${HOW_TO_LEAVE}\n${prompt}`);
        return;
      }
      rl.write(null, { ctrl: true, name: 'e' });
      rl.write(null, { ctrl: true, name: 'u' });
      io.stderr.write(`\n${HOW_TO_LEAVE}\n`);
      rl.prompt();
    },
    /** For a run: the terminal's own line mode, in which Ctrl-C is SIGINT. */
    hold(): void {
      if (!terminal) return;
      held = true;
      flow();
      stdin.setRawMode!(false);
    },
    /** After a run: readline's raw mode again, for the next prompt. */
    release(): void {
      if (!terminal || closed) return;
      stdin.setRawMode!(true);
      held = false;
      flow();
    },
    close: () => rl.close(),
  };
}

type LineReader = ReturnType<typeof lineReader>;

/** How many threads `agent resume`'s picker offers: the most recently used. */
const PICKER_THREADS = 20;

/**
 * `agent resume` with no thread: the most recently used threads, numbered on
 * stderr, and the one whose number (or id) is typed back. An empty answer, or
 * the end of the input, chooses none.
 */
async function pickThread(
  client: Client,
  io: CliIO,
  reader: LineReader,
  signal: AbortSignal,
): Promise<string> {
  const page = await client.agentThreads.list({ limit: PICKER_THREADS }, { signal });
  const threads = page.threads.map((thread) => threadSafe(io, thread));
  if (!threads.length)
    throw new CliError(
      'not_found',
      'There is no thread to resume; start one with: mandala agent chat --computer COMPUTER',
    );
  io.stderr.write('Threads, most recently used first:\n');
  listTable(
    io,
    ['#', 'THREAD', 'COMPUTER', 'TURNS', 'LAST USED', 'TITLE'],
    threads.map((t, i) => [i + 1, t.id, t.computerId, t.turns, t.updatedAt, t.title]),
    '',
    io.stderr,
  );
  if (page.hasMore)
    io.stderr.write(
      `(the ${threads.length} most recently used; type the id of an older one, or list them with: mandala agent threads list)\n`,
    );
  for (;;) {
    const answer = (
      await reader.next(
        signal,
        `Resume which? 1-${threads.length}, or a thread id (Enter for none): `,
      )
    )?.trim();
    if (!answer)
      throw new CliError('cancelled', 'No thread was chosen; nothing ran', undefined, 130);
    if (/^[0-9]+$/.test(answer)) {
      const chosen = threads[Number(answer) - 1];
      if (chosen && Number(answer) >= 1) return chosen.id;
    } else if (answer.startsWith('thr_')) return answer;
    io.stderr.write(`Type a number from 1 to ${threads.length}, or a thread id (thr_...).\n`);
  }
}

/** What `agent chat` and `agent resume` run each line with. */
export type SessionArgs = {
  /** Every run's options but its prompt and its thread, which the session gives it. */
  agent: Omit<AgentArgs, 'prompt' | 'threadId' | 'store' | 'messages' | 'signal'>;
  /** `agent resume`: the thread named, or `undefined` to pick one. */
  thread?: string;
  /** `agent chat`: the computer a new conversation starts on. */
  computer?: Computer;
};

/**
 * `agent chat` and `agent resume`: one run per line of stdin, each streamed
 * as `agent run` streams it, on one thread, until the end of the input or a
 * line reading `/exit`. `agent chat` starts with no thread, and continues the
 * one its first run names; `agent resume` continues the thread it is given,
 * or one picked from the most recent when stdin is a terminal.
 *
 * Ctrl-C (SIGINT) stops the run in flight and the session goes on. At a
 * terminal's prompt it says how to leave instead, and anywhere else (the
 * picker, piped input still to come) it ends the session, as SIGTERM always
 * does. `end` is how: it aborts `signal`, and the session's end is then
 * reported as a cancellation, exit 130. The caller must have taken its own
 * SIGINT listener off before calling: this one replaces it.
 *
 * Exits 0 when every run finished, 1 when any did not; a run refused, failed
 * or stopped is reported as its error frame and the next line still runs.
 */
export async function agentSession(
  client: Client,
  io: CliIO,
  output: Output,
  session: SessionArgs,
  end: () => void,
  signal: AbortSignal,
): Promise<number> {
  const interactive = io.stdin.isTTY === true;
  const chatty = interactive && !output.json;
  let running: AbortController | undefined;
  let prompting = false;
  // Installed before anything is awaited, so no Ctrl-C finds the process
  // without a listener, which would kill it outright.
  const interrupt = () => {
    if (running) running.abort(new DOMException('Cancelled', 'AbortError'));
    else if (prompting && interactive) reader.reprompt('> ');
    else end();
  };
  process.on('SIGINT', interrupt);
  const reader = lineReader(io, interrupt);
  try {
    let threadId = session.thread;
    let c = session.computer;
    if (!c) {
      if (threadId === undefined) {
        if (!interactive)
          throw new CliError(
            'invalid_arguments',
            'agent resume needs a thread when stdin is not a terminal; mandala agent threads list shows them',
            undefined,
            2,
            help('agent resume'),
          );
        threadId = await pickThread(client, io, reader, signal);
      }
      // The thread says where its runs go: it is continued only on its computer.
      const thread = threadSafe(io, await client.agentThreads.get(threadId, { signal }));
      c = await client.computers.get(thread.computerId, { signal });
      if (chatty)
        io.stderr.write(
          `Resuming ${threadLine(io, thread)}\n${turnLines(io, thread.messages.slice(-2), 500)}`,
        );
    } else if (chatty)
      output.diagnostic(`A new conversation on ${c.id}${c.name ? ` (${c.name})` : ''}.`, {
        keepNewlines: false,
      });
    if (chatty)
      output.diagnostic(
        'Each line you type runs the agent. Ctrl-C stops a run; Ctrl-D or /exit leaves.',
      );
    let failed = false;
    for (;;) {
      prompting = true;
      let line: string | undefined;
      try {
        line = await reader.next(signal, interactive ? '> ' : '');
      } finally {
        prompting = false;
      }
      if (line === undefined) {
        // Ctrl-D: the shell's prompt starts on a line of its own.
        if (interactive) io.stderr.write('\n');
        break;
      }
      if (!line.trim()) continue;
      if (line.trim() === '/exit') break;
      const run = new AbortController();
      running = run;
      reader.hold();
      try {
        const outcome = await streamAgentRun(
          c,
          {
            ...session.agent,
            prompt: line,
            threadId,
            signal: AbortSignal.any([signal, run.signal]),
          },
          output,
        );
        if (outcome.code) failed = true;
        if (threadId === undefined && outcome.threadId !== undefined) {
          threadId = outcome.threadId;
          if (!output.json)
            output.diagnostic(
              `mandala: this conversation is thread ${threadId}; continue it later with: mandala agent resume ${threadId}`,
              { keepNewlines: false },
            );
        }
      } catch (error) {
        // SIGTERM, or the process ending the session: not one run's failure.
        if (signal.aborted) throw error;
        failed = true;
        if (run.signal.aborted) {
          // After the terminal's `^C`, on a line of its own.
          if (interactive) io.stderr.write('\n');
          output.error(
            new CliError(
              'cancelled',
              threadId === undefined
                ? `Run cancelled; what it already did stands. It was stopped before it named a thread, so the next line starts a new one (mandala agent threads list --computer ${c.id} shows any it was kept in)`
                : 'Run cancelled; what it already did stands',
            ),
            130,
            true,
          );
        } else {
          // A programming fault is not a run's failure to report and go past.
          if (errorInfo(error).code === 'internal_error') throw error;
          output.error(
            error,
            error instanceof CliError && error.exitCode !== undefined ? error.exitCode : 1,
            true,
          );
        }
      } finally {
        running = undefined;
        reader.release();
      }
    }
    return failed ? 1 : 0;
  } finally {
    process.off('SIGINT', interrupt);
    reader.close();
  }
}
