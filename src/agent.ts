/**
 * The platform's own agent loop, as types.
 *
 * `POST computers/:id/agent` is not a call to a hypervisor — it is many of them,
 * interleaved with calls to a model API, running for minutes. So it answers
 * with a stream of steps rather than a result, and this file is the shape of
 * that stream.
 *
 * It runs on **your** Anthropic or OpenAI key, which the platform never stores: pass it
 * as `modelKey` and it travels on the one request as `X-Model-Key`. Leave
 * `modelKey` out and the run is FUNDED instead: it spends the account's
 * Mandala AI credits, Anthropic only, capped by `maxCostUsd`. A step is
 * one ACTION on the desktop rather than one exchange with the model — several
 * can come out of a single reply, a paused turn costs tokens and no step, and a
 * `bash` call takes no screenshot — so `maxSteps` bounds the loop and bounds
 * what that key is billed only loosely.
 */

import {
  type APIError,
  type ConflictError,
  MandalaError,
  type NotFoundError,
  topUpLink,
} from './errors.js';
import { flag, num, objectRows, str } from './models.js';
import { isRecord } from './paths.js';

/** What the caller learns about one step. */
export type AgentStep = {
  n: number;
  /** The tool the model reached for, e.g. `"computer"` or `"bash"`. */
  tool: string;
  /** The action within it, e.g. `"left_click"` — absent for bash. */
  action?: string;
  /** What the platform did with it, one line. */
  detail?: string;
  /** Set when the action was refused. The loop continues; the model adapts. */
  error?: string;
  /**
   * A funded run's cumulative charge so far, in USD, markup included. Absent
   * on a run on your own key. Several actions from one model reply repeat the
   * same total: it is a running total, so do not add these up.
   */
  costUsd?: number;
  /**
   * The account's available AI credits after this step's model call, in USD.
   * Can be negative after an overrun. Absent on a run on your own key, and
   * when the platform could not read the balance after charging.
   */
  creditsRemainingUsd?: number;
};

/**
 * What a run cost on your key.
 *
 * `inputTokens` includes the cache-read and cache-write halves, which are most
 * of a long run: the rolling breakpoint means step ten's prompt is almost
 * entirely cache reads. They are broken out as well, because they are priced
 * differently and reconciling against an Anthropic bill needs to see them.
 */
export type AgentUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

/**
 * Why a run ended.
 *
 * Only `end_turn` means the model finished. A caller that treats every ending
 * as success will report a task that ran out of steps as one that completed —
 * which is why {@link AgentResult.finished} exists rather than leaving everyone
 * to compare this string themselves.
 *
 * The others the platform documents:
 *
 * - `max_steps` — the run reached `maxSteps`.
 * - `time_limit` — the run reached its fixed 60-minute wall-clock limit.
 * - `rate_limited` — the account's API rate budget ran out mid-run.
 * - `refusal` — the model declined.
 * - `pause_turn` — the model kept pausing its turn.
 * - `credits_exhausted` — a funded run's AI credits became unavailable.
 * - `max_cost` — a funded run's next model call would pass `maxCostUsd`.
 * - `incomplete` — OpenAI left its response unfinished.
 * - `safety_check` — OpenAI wants an action approved before it goes on.
 *
 * Or another stop reason the model itself gave, such as `max_tokens`, which is
 * why the type stays open. None of them is a failure, and none is raised as
 * one: the steps already taken are real, and what they did to the desktop
 * stands. They say the run did not finish, which is a different thing from the
 * run having gone wrong.
 */
export type AgentStop =
  | 'end_turn'
  | 'max_steps'
  | 'time_limit'
  | 'rate_limited'
  | 'refusal'
  | 'pause_turn'
  | 'credits_exhausted'
  | 'max_cost'
  | 'incomplete'
  | 'safety_check'
  | (string & {});

export type AgentResult = {
  /** How many steps it took. */
  steps: number;
  stop: AgentStop;
  /** True only for `end_turn`. The one check most callers actually want. */
  finished: boolean;
  /** The model's closing text — its answer, or why it could not get there. */
  text: string;
  usage: AgentUsage;
  /**
   * What a funded run charged the account's AI credits, in USD, markup
   * included. Absent on a run on your own key, whose model bill is your
   * provider's. Can exceed `maxCostUsd` by the last model call: the cap stops
   * the next call, not one already made.
   */
  costUsd?: number;
  /**
   * Every step the run took, as the platform reported them.
   *
   * Carried only by `agentOnce()`'s non-streaming answer (`steps_taken`), and
   * absent when that answer had none. The streaming `done` frame does not carry
   * it: `agent()` and `agentStream()` callers see each step as its own
   * `step` event instead.
   */
  stepsTaken?: AgentStep[];
  /**
   * The thread this run's exchange was kept in (OPL-6083): pass it as
   * {@link AgentArgs.threadId} to continue the conversation. Absent when the
   * run kept nothing — sent with `store: false`, or ended before it acted with
   * no answer — and on a background run's `result`, where the run carries it
   * as {@link AgentRun.threadId}.
   */
  threadId?: string;
  raw: Record<string, unknown>;
};

/**
 * One earlier turn of a conversation the caller keeps itself, for
 * {@link AgentArgs.messages}: what was asked, or what was answered, as text.
 */
export type AgentHistoryMessage = {
  role: 'user' | 'assistant';
  content: string;
};

/** Events the streaming form emits, in the order they happen. */
export type AgentEvent =
  | { type: 'step'; step: AgentStep }
  | { type: 'text'; text: string }
  | { type: 'done'; result: AgentResult }
  | {
      type: 'error';
      error: string;
      status: number;
      /**
       * What the run had already spent on your key when it stopped.
       *
       * A run can be refused part-way through — the credential can be revoked,
       * the member demoted or the account suspended between two of its steps, or
       * the model API can refuse the key — and the steps already taken are real,
       * billed, and still on the desktop. Zeros here mean the platform sent no accounting,
       * not that nothing was spent.
       */
      usage: AgentUsage;
      /**
       * The steps that completed before the stop, as the platform reported them.
       *
       * Empty when it sent none. This is the difference between "the run did
       * nothing" and "the run did four things and then was refused", and a
       * caller deciding whether to retry needs it.
       */
      steps: AgentStep[];
      /** What a funded run had charged when it failed, in USD. Absent on your own key. */
      costUsd?: number;
      /**
       * Where to add AI credits, when the failure was the account running short
       * of them: a `402` before the first model call. An absolute URL,
       * resolved against the client's base URL when the platform sent a path.
       */
      topUpUrl?: string;
      /**
       * The thread the failed run was kept in (OPL-6083): when it acted on the
       * desktop before it failed, or continued the thread you named. Absent
       * when it kept nothing.
       */
      threadId?: string;
      /** The error frame as it arrived, for anything above that this SDK does not model. */
      raw: Record<string, unknown>;
    };

export type AgentArgs = {
  /** Inferred from model when omitted; OpenAI defaults to gpt-6.1-sol. */
  provider?: 'anthropic' | 'openai';
  /** The task, in plain language. */
  prompt: string;
  /**
   * Your Anthropic or OpenAI API key, sent as `X-Model-Key`. The platform does
   * not store it, and your provider bills you directly.
   *
   * **Leave it out and the run spends the account's Mandala AI credits.** A
   * funded run is Anthropic only, uses the platform's system prompt (so
   * `system` is refused), and allows `claude-sonnet-5-5` (its default) or
   * `claude-opus-5-5`. It needs a plan, a supported billing country, and
   * at least $0.25 of credits for its first model call; short of that it is
   * refused before it starts with `InsufficientCreditsError`. Running
   * out part-way ends the run with `stop: 'credits_exhausted'`.
   *
   * Only `undefined` means "use credits". An empty or blank string is refused
   * before the call, so a key read from an environment variable that is set but
   * empty is caught rather than quietly billed to credits.
   */
  modelKey?: string;
  /**
   * A funded run's budget in USD, from 0.25 to 20; the platform's default is
   * 2. Checked before each model call, so the run ends with
   * `stop: 'max_cost'` rather than start a call the cap cannot cover — and the
   * last call can take the total past it. Ignored on a run on your own key.
   */
  maxCostUsd?: number;
  /** Standing instructions carried into the run. Needs your own `modelKey`. */
  system?: string;
  /**
   * Step cap — how many ACTIONS the loop may take on the desktop.
   *
   * Not a count of model calls, and not a proxy for what your key is billed:
   * one reply may ask for several actions and spends a step on each, a paused
   * turn is resubmitted for tokens and no step, and a `bash` call or a cursor
   * read takes no screenshot. Bounds the work; budget the bill on your own key.
   *
   * Omitted sends nothing and takes the platform's default of 20. The cap is
   * 100 for foreground runs and 500 for background runs, refused locally.
   * All runs have a fixed 60-minute wall-clock limit (stop `time_limit`).
   */
  maxSteps?: number;
  /** Override the model the platform would pick. */
  model?: string;
  /**
   * A thread to continue (OPL-6083): the `threadId` of an earlier run on this
   * computer. The model is given that thread's earlier turns as the
   * conversation so far — the newest 64,000 characters of them — is told they
   * are done, and acts only on this `prompt`; this run's exchange is added to
   * the thread.
   *
   * A thread of another computer, or one already holding 100 turns, is a
   * {@link ConflictError}; one this key cannot see is a
   * {@link NotFoundError}. Cannot be sent with `store: false`, or with a
   * non-empty `messages` — both refused before the call.
   */
  threadId?: string;
  /**
   * Whether to keep this run's exchange in a thread (OPL-6083). The platform's
   * default is to keep it: a run that acted on the desktop, or finished with an
   * answer, is kept in the thread named by `threadId` or a new one, and the id
   * comes back as {@link AgentResult.threadId}. `false` keeps nothing.
   */
  store?: boolean;
  /**
   * The conversation so far, oldest first and without this `prompt`, for a
   * caller that keeps its own history rather than a thread on the platform
   * (OPL-6083). Given to the model as earlier turns it is told are done; a new
   * thread, unless `store: false`, starts with them. Each turn is a role and
   * its text, and only those two fields are sent.
   */
  messages?: readonly AgentHistoryMessage[];
  /**
   * Cancels the run.
   *
   * Worth passing on anything long. Without it an abandoned run keeps spending:
   * the model request nobody is waiting for still completes on your key, and the
   * desktop action it asks for is still performed.
   */
  signal?: AbortSignal;
};

// The decoders below read through `num` and `str` from models.ts rather than
// through `Number()` and `String()`, which is what this file used to do and
// what the rest of the SDK stopped doing in OPL-3850. This file kept its own
// one-line `num` and so kept both defects, on the one route that decodes a
// LIVE stream:
//
// - `Number()` is a coercion and not a parser, so `Number([7])` is 7 and a
//   token count nobody was billed for was reported against an Anthropic key.
// - `String()` throws when `toString` is not callable, and it is reached from
//   inside the caller's `for await` — so one unreadable detail line ended a
//   running agent instead of being skipped.
//
// `stop` is not routed through `str` either: it CLASSIFIES, and the comment on
// it says why that is a stricter rule than being readable.
//
// The money fields are stricter again. A charge is a NUMBER the platform sent
// or it is absent: never a coerced string, never `num`'s zero for "unreadable",
// because a funded run reported as costing $0 is a worse answer than one
// reported as not saying. Absent rather than thrown, for the reason above: a
// frame is decoded inside the caller's `for await`, and a throw there would end
// a running agent over a figure it could have done without.

/** A USD amount the platform sent: a finite number, nonnegative unless `signed`. */
const usd = (v: unknown, signed = false): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && (signed || v >= 0) ? v : undefined;

/**
 * A `thread_id` the platform sent, or absent. Only a value that could be sent
 * back as `threadId`: a non-empty string with no space around it, which is
 * what {@link agentBody} accepts, so a run's own continuation id is never one
 * the next call refuses. Anything else is absent rather than thrown, for the
 * reason the money fields are: it is read inside the caller's `for await`, and
 * a run that cannot name its thread has still run. `raw` keeps what was sent.
 */
const threadOf = (v: unknown): string | undefined =>
  typeof v === 'string' && v && v === v.trim() ? v : undefined;

export function toAgentUsage(d: unknown): AgentUsage {
  const u = isRecord(d) ? d : {};
  return {
    inputTokens: num(u.input_tokens),
    outputTokens: num(u.output_tokens),
    cacheReadTokens: num(u.cache_read_tokens),
    cacheWriteTokens: num(u.cache_write_tokens),
  };
}

export function toAgentStep(d: unknown, fallbackN: number): AgentStep {
  const s = isRecord(d) ? d : {};
  const step: AgentStep = {
    n: num(s.n, fallbackN),
    tool: str(s.tool),
    // Absent stays absent: `undefined` here is "the platform did not send one",
    // which is a different answer from the empty string a value it sent but
    // this client could not read decodes to.
    action: s.action == null ? undefined : str(s.action),
    detail: s.detail == null ? undefined : str(s.detail),
    error: s.error == null ? undefined : str(s.error),
  };
  const cost = usd(s.cost_usd);
  if (cost !== undefined) step.costUsd = cost;
  // Signed: an overrun can leave the account below zero, and that is a real
  // balance rather than a malformed one.
  const remaining = usd(s.credits_remaining_usd, true);
  if (remaining !== undefined) step.creditsRemainingUsd = remaining;
  return step;
}

export function toAgentResult(d: unknown): AgentResult {
  const r = isRecord(d) ? d : {};
  // A STRING or nothing, rather than anything coerced into one, for the reason
  // `buildContradiction` reads `raw.status` rather than the coerced `status`:
  // this field classifies, and a coerced value cannot be trusted to classify.
  // `String(['end_turn'])` is `'end_turn'`, so an array read as the one stop
  // reason that means the model finished — and `finished` is the single check
  // the docs tell callers to make instead of comparing this string themselves.
  // Anything unreadable is the same "nobody said" as an absent one.
  const stop = typeof r.stop === 'string' ? r.stop : 'unknown';
  const result: AgentResult = {
    steps: num(r.steps),
    stop,
    finished: stop === 'end_turn',
    text: str(r.text),
    usage: toAgentUsage(r.usage),
    raw: { ...r },
  };
  const cost = usd(r.cost_usd);
  if (cost !== undefined) result.costUsd = cost;
  const thread = threadOf(r.thread_id);
  if (thread !== undefined) result.threadId = thread;
  // Present only when the answer carried a list: the non-streaming form sends
  // it and the streaming `done` frame does not, so absent is "not sent", never
  // "no steps".
  if (Array.isArray(r.steps_taken)) {
    result.stepsTaken = r.steps_taken.map((s, i) => toAgentStep(s, i + 1));
  }
  return result;
}

/**
 * One SSE frame, as an {@link AgentEvent}.
 *
 * Returns `undefined` for a frame this SDK does not model rather than throwing.
 * The platform is free to add event types, and a client that fell over on the
 * first unrecognised one would turn a forward-compatible addition into an
 * outage.
 *
 * `baseUrl` is the client's, and resolves an `error` frame's `top_up_url`.
 */
export function toAgentEvent(
  event: string,
  data: unknown,
  stepCount: number,
  baseUrl?: string,
): AgentEvent | undefined {
  switch (event) {
    case 'step':
      return { type: 'step', step: toAgentStep(data, stepCount + 1) };
    case 'text':
      return { type: 'text', text: isRecord(data) ? str(data.text) : str(data) };
    case 'done':
      if (!isRecord(data) || data.stop == null) {
        throw new MandalaError('the agent stream ended with a done event that had no stop reason');
      }
      return { type: 'done', result: toAgentResult(data) };
    case 'error': {
      const e = isRecord(data) ? data : undefined;
      // Two ways to end up with nothing, and the sentinel has to cover both:
      // a value `String()` cannot render at all — which `str` answers with the
      // empty string rather than by throwing — and one that renders AS the
      // empty string. `Computer.agent` puts this straight into "the agent run
      // failed: ", so either would end a run with a reason naming nothing. The
      // swap to `str` fixed the throw and dropped this fallback on the way.
      const said = e ? (e.error == null ? '' : str(e.error)) : str(data);
      // The accounting travels with the refusal, and dropping it was the whole
      // of the defect this decodes for: a run stopped between two steps sends
      // what it spent and what it had already done, and a client that read only
      // the sentence turned "four steps happened, then this" into a failure that
      // looks like nothing happened — on the one surface where the difference is
      // money and a desktop somebody has to look at.
      //
      // Decoded through the same helpers as the `done` frame, so a count that
      // cannot be read is a zero rather than a throw inside the caller's loop,
      // and `steps` is an array or it is empty — never a scalar spread into one.
      const rawSteps = Array.isArray(e?.steps) ? e.steps : [];
      const failed: Extract<AgentEvent, { type: 'error' }> = {
        type: 'error',
        error: said || 'the run failed',
        status: num(e?.status),
        usage: toAgentUsage(e?.usage),
        steps: rawSteps.map((s, i) => toAgentStep(s, i + 1)),
        raw: e ? { ...e } : {},
      };
      const cost = usd(e?.cost_usd);
      if (cost !== undefined) failed.costUsd = cost;
      const topUp = topUpLink(e?.top_up_url, baseUrl);
      if (topUp !== undefined) failed.topUpUrl = topUp;
      const thread = threadOf(e?.thread_id);
      if (thread !== undefined) failed.threadId = thread;
      return failed;
    }
    default:
      return undefined;
  }
}

// --- threads ------------------------------------------------------------------

/**
 * One kept conversation, as `GET agent/threads` lists it (OPL-6083): its id,
 * the computer its runs drove, and how much it holds — without the turns.
 */
export type AgentThreadSummary = {
  /** `thr_` and twenty-four hex characters: what {@link AgentArgs.threadId} takes. */
  id: string;
  /** The computer its runs drove. A thread is continued only there. */
  computerId: string;
  /**
   * The first line of the prompt of the first run kept in it, at most 80
   * characters — not of any `messages` it was started with.
   */
  title: string;
  /** How many turns it holds: a prompt and an answer per run, plus any history it started with. */
  turns: number;
  createdAt: string;
  /** When a run last used it: kept an exchange in it, or began continuing it. */
  updatedAt: string;
  raw: Record<string, unknown>;
};

/**
 * How an assistant turn's run ended: any {@link AgentStop}, or `error` (it
 * failed), `aborted` (stopped part way), `running` (still going) or
 * `interrupted` (the platform restarted before it finished). `running`,
 * `aborted` and `interrupted` are runs that may have done more than they
 * reported.
 */
export type AgentThreadStop = AgentStop | 'error' | 'aborted' | 'running' | 'interrupted';

/** One turn of a thread: a prompt (`user`), or how a run answered it (`assistant`). */
export type AgentThreadTurn = {
  role: 'user' | 'assistant' | (string & {});
  /** The prompt, or the run's closing text. At most 32,000 characters are kept. */
  text: string;
  /** Assistant turns: how the run ended. */
  stop?: AgentThreadStop;
  /** Assistant turns of a failed run: why it failed. */
  error?: string;
  /** Assistant turns: how many actions the run took. */
  steps?: number;
  /** Assistant turns of a funded run: what it cost, in USD. */
  costUsd?: number;
  createdAt: string;
  raw: Record<string, unknown>;
};

/** One thread and every turn in it, oldest first: `client.agentThreads.get(id)`. */
export type AgentThread = AgentThreadSummary & {
  /** Every turn, oldest first. */
  messages: AgentThreadTurn[];
};

/** One page of `client.agentThreads.list()`, most recently used first. */
export type AgentThreadPage = {
  threads: AgentThreadSummary[];
  /** Whether another page follows. */
  hasMore: boolean;
  /**
   * What to pass as `before` for the next page — the last thread's id — or
   * `null` on the last page.
   */
  nextBefore: string | null;
  raw: Record<string, unknown>;
};

/**
 * The id a row is fetched, deleted or paged by, refused when it is not one:
 * sent back as `[object Object]` or as an empty path segment, it would ask
 * about something nobody named.
 */
const rowId = (d: Record<string, unknown>, what: string): string => {
  if (typeof d.id !== 'string' || !d.id || d.id !== d.id.trim()) {
    throw new MandalaError(`expected ${what} to carry its id`);
  }
  return d.id;
};

/**
 * Where the next page starts: the last row's id when `has_more` says another
 * page follows, `null` when it says none does. Refused when `has_more` is not
 * true or false, and when it says more follow a page with no row to page from:
 * either, read as the last page, would end a walk early and call the listing
 * complete.
 */
const nextBefore = (
  d: Record<string, unknown>,
  rows: readonly { id: string }[],
  where: string,
): { hasMore: boolean; nextBefore: string | null } => {
  const more = flag(d.has_more, `has_more from ${where}`, true);
  if (!more) return { hasMore: false, nextBefore: null };
  const last = rows[rows.length - 1];
  if (!last) {
    throw new MandalaError(`expected the page from ${where} that says more follow to have a row`);
  }
  return { hasMore: true, nextBefore: last.id };
};

export function toAgentThreadSummary(d: unknown, what = 'an agent thread'): AgentThreadSummary {
  if (!isRecord(d)) throw new MandalaError(`expected ${what} to be an object`);
  return {
    id: rowId(d, what),
    computerId: str(d.computer_id),
    title: str(d.title),
    turns: num(d.turns),
    createdAt: str(d.created_at),
    updatedAt: str(d.updated_at),
    raw: { ...d },
  };
}

export function toAgentThreadTurn(d: Record<string, unknown>): AgentThreadTurn {
  const turn: AgentThreadTurn = {
    role: str(d.role),
    text: str(d.text),
    createdAt: str(d.created_at),
    raw: { ...d },
  };
  if (typeof d.stop === 'string') turn.stop = d.stop;
  if (typeof d.error === 'string') turn.error = d.error;
  if (typeof d.steps === 'number' && Number.isFinite(d.steps)) turn.steps = d.steps;
  const cost = usd(d.cost_usd);
  if (cost !== undefined) turn.costUsd = cost;
  return turn;
}

/**
 * Strict on the turns as a whole: a thread read by id always carries the list,
 * so one without it is refused rather than read as a thread with nothing in
 * it — which would show a thread of two turns as empty, and complete.
 */
export function toAgentThread(d: unknown, what = 'an agent thread'): AgentThread {
  const summary = toAgentThreadSummary(d, what);
  const turns = (d as Record<string, unknown>).messages;
  if (!Array.isArray(turns)) throw new MandalaError(`expected ${what} to carry its messages`);
  const rows = objectRows(turns, `${what}'s messages`);
  return { ...summary, messages: rows.map(toAgentThreadTurn) };
}

export function toAgentThreadPage(d: unknown, method: string, path: string): AgentThreadPage {
  const where = `${method} ${path}`;
  if (!isRecord(d) || !Array.isArray(d.threads)) {
    throw new MandalaError(`expected a list of agent threads from ${where}`);
  }
  const threads = d.threads.map((row, i) =>
    toAgentThreadSummary(row, `agent thread ${i} from ${where}`),
  );
  return { threads, ...nextBefore(d, threads, where), raw: { ...d } };
}

// --- background runs -----------------------------------------------------------

/**
 * What a background run is started with: the {@link AgentArgs} of `agent()`,
 * less the `signal` — a background run is stopped with
 * `client.agentRuns.cancel()`, not by abandoning a request — and less
 * `store: false`, which the platform refuses (and this SDK before it).
 */
export type AgentRunArgs = Omit<AgentArgs, 'signal' | 'store'> & {
  /**
   * A background run is always kept, so it can be read back: `true` is the
   * platform's default and the only value it takes here. `false` is refused
   * before the call.
   */
  store?: true;
};

/**
 * Where a background run has got to. `running` is live; `completed`,
 * `failed`, `cancelled` and `interrupted` are where it ended. Open, because
 * the platform may add one; a run whose `endedAt` is set has ended whatever
 * its status says.
 *
 * - `completed` — the loop ended on its own, and `result.stop` says how. Only
 *   `end_turn` is a finished task: see {@link AgentRun.finished}.
 * - `failed` — see `error`.
 * - `cancelled` — stopped by `client.agentRuns.cancel()`.
 * - `interrupted` — the platform restarted while it was going (`error.status`
 *   503), or it stopped without its ending being recorded (`error.status`
 *   500). It is not resumed: inspect the desktop before starting another.
 */
export type AgentRunStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | (string & {});

/** Why a background run failed or was interrupted. */
export type AgentRunError = {
  /** What went wrong, in a sentence. */
  error: string;
  /** The status the agent route would have answered it with. */
  status: number;
  /** The platform's one-word classification, where it sent one — see {@link APIError.reason}. */
  reason?: string;
  /**
   * Where to add AI credits, when the run failed for want of them: an
   * absolute link, resolved against the client's base URL.
   */
  topUpUrl?: string;
};

/**
 * A background agent run (OPL-6083): the same loop as `agent()`, started with
 * `client.agentRuns.start()` and read back by id while it goes and after it
 * ends.
 */
export type AgentRun = {
  /** `run_` and twenty-four hex characters. */
  id: string;
  computerId: string;
  /**
   * The thread the run is kept in, once it is: `null` until a new thread has
   * something in it (a run that has not acted yet, or failed before it did),
   * and when the thread was deleted. Continue it with
   * {@link AgentArgs.threadId} on the next run.
   */
  threadId: string | null;
  status: AgentRunStatus;
  /** The prompt, at most 32,000 characters of it. */
  prompt: string;
  /** The model the run was started with. */
  model: string;
  maxSteps: number;
  /** How many actions it has taken so far. */
  steps: number;
  /** A funded run's charge so far, in USD. Absent on a run on your own key. */
  costUsd?: number;
  /**
   * How it ended, once `completed`: the run's {@link AgentResult}, without a
   * `threadId` (the run carries its own).
   */
  result?: AgentResult;
  /** Why it ended, once `failed` or `interrupted`. */
  error?: AgentRunError;
  /**
   * Every action so far, in order. EMPTY IN A LISTING, whatever the run did:
   * read the run by id for them.
   */
  stepsTaken: AgentStep[];
  /**
   * True only for a run that `completed` with `result.stop === 'end_turn'` —
   * the one ending that means the task was finished.
   */
  finished: boolean;
  createdAt: string;
  /** When it last took a step or changed status. */
  updatedAt: string;
  /** When it ended; `null` while it is running. */
  endedAt: string | null;
  raw: Record<string, unknown>;
};

/** One page of `client.agentRuns.list()`, newest first. */
export type AgentRunPage = {
  /** The runs, each with an empty `stepsTaken`: read one by id for its steps. */
  runs: AgentRun[];
  /** Whether another page follows. */
  hasMore: boolean;
  /** What to pass as `before` for the next page — the last run's id — or `null` on the last page. */
  nextBefore: string | null;
  raw: Record<string, unknown>;
};

/** The statuses a background run ends in. */
const RUN_ENDED: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

/**
 * Whether a background run has ended: one of the four statuses it ends in, or
 * an `endedAt` the platform set — which covers a status added after this
 * client was written.
 */
export const agentRunEnded = (run: AgentRun): boolean =>
  RUN_ENDED.has(run.status) || run.endedAt !== null;

/**
 * A run's `thread_id`: `null`, or an id that could be sent back as `threadId`,
 * and refused as anything else — it is what the next run continues.
 */
const runThread = (v: unknown, what: string): string | null => {
  const id = textOrNull(v, `${what}'s thread_id`);
  if (id !== null && threadOf(id) === undefined) {
    throw new MandalaError(`expected ${what}'s thread_id to be a thread id or null`);
  }
  return id;
};

/**
 * A run's `ended_at`: `null` while it is running, or when it ended. Refused
 * when empty: a wait ends on any `endedAt` that is not `null`, and an empty
 * string is no time at all.
 */
const runEnded = (v: unknown, what: string): string | null => {
  const at = textOrNull(v, `${what}'s ended_at`);
  if (at !== null && !at.trim()) {
    throw new MandalaError(`expected ${what}'s ended_at to be a time or null`);
  }
  return at;
};

/** A text field the platform sends as a string or `null`, refused as anything else. */
const textOrNull = (v: unknown, what: string): string | null => {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') throw new MandalaError(`expected ${what} to be a string or null`);
  return v;
};

/**
 * Strict on what a wait or a caller decides on — the id it polls, the status
 * and `ended_at` it ends on, the thread it continues, the shape of `result`
 * and `error` — and permissive on the rest, as every decoder here is. A failed
 * run whose reason this client silently dropped would be reported as a failure
 * with nothing to say about why.
 *
 * `baseUrl` is the client's, and resolves an error's `top_up_url`.
 */
export function toAgentRun(d: unknown, what = 'an agent run', baseUrl?: string): AgentRun {
  if (!isRecord(d)) throw new MandalaError(`expected ${what} to be an object`);
  const id = rowId(d, what);
  if (typeof d.status !== 'string' || !d.status) {
    throw new MandalaError(`expected ${what} to carry its status`);
  }
  let result: AgentResult | undefined;
  if (d.result != null) {
    if (!isRecord(d.result) || typeof d.result.stop !== 'string') {
      throw new MandalaError(`expected ${what}'s result to be an agent result`);
    }
    result = toAgentResult(d.result);
  }
  let error: AgentRunError | undefined;
  if (d.error != null) {
    const e = d.error;
    if (!isRecord(e) || typeof e.error !== 'string') {
      throw new MandalaError(`expected ${what}'s error to carry what went wrong`);
    }
    // The status is what tells an interrupted run's restart (503) from one
    // whose ending was never recorded (500), so a missing one is refused rather
    // than read as a 0 no route answers.
    if (typeof e.status !== 'number' || !Number.isInteger(e.status)) {
      throw new MandalaError(`expected ${what}'s error to carry its status`);
    }
    error = { error: e.error, status: e.status };
    if (typeof e.reason === 'string') error.reason = e.reason;
    const topUp = topUpLink(e.top_up_url, baseUrl);
    if (topUp !== undefined) error.topUpUrl = topUp;
  }
  const run: AgentRun = {
    id,
    computerId: str(d.computer_id),
    threadId: runThread(d.thread_id, what),
    status: d.status,
    prompt: str(d.prompt),
    model: str(d.model),
    maxSteps: num(d.max_steps),
    steps: num(d.steps),
    stepsTaken: objectRows(d.steps_taken, `${what}'s steps_taken`).map((s, i) =>
      toAgentStep(s, i + 1),
    ),
    finished: d.status === 'completed' && result?.finished === true,
    createdAt: str(d.created_at),
    updatedAt: str(d.updated_at),
    endedAt: runEnded(d.ended_at, what),
    raw: { ...d },
  };
  const cost = usd(d.cost_usd);
  if (cost !== undefined) run.costUsd = cost;
  if (result !== undefined) run.result = result;
  if (error !== undefined) run.error = error;
  return run;
}

export function toAgentRunPage(
  d: unknown,
  method: string,
  path: string,
  baseUrl?: string,
): AgentRunPage {
  const where = `${method} ${path}`;
  if (!isRecord(d) || !Array.isArray(d.runs)) {
    throw new MandalaError(`expected a list of agent runs from ${where}`);
  }
  const runs = d.runs.map((row, i) => toAgentRun(row, `agent run ${i} from ${where}`, baseUrl));
  return { runs, ...nextBefore(d, runs, where), raw: { ...d } };
}
