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

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

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
    n: s.n == null ? fallbackN : num(s.n),
    tool: s.tool == null ? '' : String(s.tool),
    action: s.action == null ? undefined : String(s.action),
    detail: s.detail == null ? undefined : String(s.detail),
    error: s.error == null ? undefined : String(s.error),
  };
}

export function toAgentResult(d: unknown): AgentResult {
  const r = isRecord(d) ? d : {};
  const stop = r.stop == null ? 'unknown' : String(r.stop);
  return {
    steps: num(r.steps),
    stop,
    finished: stop === 'end_turn',
    text: r.text == null ? '' : String(r.text),
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
      return { type: 'text', text: isRecord(data) ? String(data.text ?? '') : String(data) };
    case 'done':
      return { type: 'done', result: toAgentResult(data) };
    case 'error': {
      const e = isRecord(data) ? data : {};
      return {
        type: 'error',
        error: e.error == null ? 'the run failed' : String(e.error),
        status: num(e.status),
      };
    }
    default:
      return undefined;
  }
}
