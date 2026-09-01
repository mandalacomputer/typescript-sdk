/**
 * The platform's own agent loop, as types.
 *
 * `POST computers/:id/agent` is not a call to a hypervisor — it is many of them,
 * interleaved with calls to a model API, running for minutes. So it answers
 * with a stream of steps rather than a result, and this file is the shape of
 * that stream.
 *
 * It runs on **your** Anthropic key, which the platform never stores: pass it
 * as `modelKey` and it travels on the one request as `X-Model-Key`. Every step
 * is a model call plus a screenshot billed to that key, which is why
 * `maxSteps` is a spending cap as much as a loop bound.
 */

import { MandalaError } from './errors.js';
import { num, str } from './models.js';
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
 * `max_steps`, `rate_limited` and `refusal` are not failures and are
 * deliberately not raised as one: the steps already taken are real, and what
 * they did to the desktop stands. They say the run did not finish, which is a
 * different thing from the run having gone wrong.
 */
export type AgentStop = 'end_turn' | 'max_steps' | 'rate_limited' | 'refusal' | (string & {});

export type AgentResult = {
  /** How many steps it took. */
  steps: number;
  stop: AgentStop;
  /** True only for `end_turn`. The one check most callers actually want. */
  finished: boolean;
  /** The model's closing text — its answer, or why it could not get there. */
  text: string;
  usage: AgentUsage;
  raw: Record<string, unknown>;
};

/** Events the streaming form emits, in the order they happen. */
export type AgentEvent =
  | { type: 'step'; step: AgentStep }
  | { type: 'text'; text: string }
  | { type: 'done'; result: AgentResult }
  | { type: 'error'; error: string; status: number };

export type AgentArgs = {
  /** The task, in plain language. */
  prompt: string;
  /**
   * Your Anthropic API key. The platform does not store one and will not run
   * without it.
   */
  modelKey: string;
  /** Standing instructions carried into the run. */
  system?: string;
  /**
   * Step cap. Each step is a model call plus a screenshot on your key, so this
   * bounds spending as much as it bounds the loop. Defaults to the platform's.
   */
  maxSteps?: number;
  /** Override the model the platform would pick. */
  model?: string;
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
  return {
    n: num(s.n, fallbackN),
    tool: str(s.tool),
    // Absent stays absent: `undefined` here is "the platform did not send one",
    // which is a different answer from the empty string a value it sent but
    // this client could not read decodes to.
    action: s.action == null ? undefined : str(s.action),
    detail: s.detail == null ? undefined : str(s.detail),
    error: s.error == null ? undefined : str(s.error),
  };
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
  return {
    steps: num(r.steps),
    stop,
    finished: stop === 'end_turn',
    text: str(r.text),
    usage: toAgentUsage(r.usage),
    raw: { ...r },
  };
}

/**
 * One SSE frame, as an {@link AgentEvent}.
 *
 * Returns `undefined` for a frame this SDK does not model rather than throwing.
 * The platform is free to add event types, and a client that fell over on the
 * first unrecognised one would turn a forward-compatible addition into an
 * outage.
 */
export function toAgentEvent(
  event: string,
  data: unknown,
  stepCount: number,
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
      return {
        type: 'error',
        error: said || 'the run failed',
        status: num(e?.status),
      };
    }
    default:
      return undefined;
  }
}
