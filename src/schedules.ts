import { MandalaError, ValidationError } from './errors.js';
import { flag, num, str } from './models.js';
import * as P from './paths.js';
import type { Transport } from './transport.js';

/**
 * Agent schedules: a cron expression that starts a background agent run on
 * one computer at each time it names, in a time zone.
 *
 * Each fire is an ordinary background run, read back with
 * `client.agentRuns.get(fire.runId)`. Every scheduled run spends the
 * account's Mandala AI credits: nothing is there to send a model key when one
 * fires, so a schedule takes no `modelKey` and no `system` prompt. A schedule
 * acts as the API key that created it, or last changed it.
 */

/** Why a schedule is paused. Open: a value this client does not know is kept as sent. */
export type AgentSchedulePausedReason =
  | 'paused'
  | 'credential'
  | 'authority'
  | 'thread_deleted'
  | 'failing'
  | 'never_fires'
  | (string & {});

/** How one fire went. Open, as {@link AgentSchedulePausedReason} is. */
export type AgentScheduleFireOutcome =
  | 'pending'
  | 'started'
  | 'skipped'
  | 'missed'
  | 'failed'
  | 'interrupted'
  | (string & {});

/** One fire of a schedule. */
export type AgentScheduleFire = {
  /** The time this fire was for. */
  scheduledFor: string;
  /** When it was sent, or recorded as missed. */
  firedAt: string;
  outcome: AgentScheduleFireOutcome;
  /** The run it started, for `started`. */
  runId: string | null;
  /** Why no run started, in a sentence. */
  error: string | null;
};

/** A schedule as the platform answers it. */
export type AgentSchedule = {
  /** `sch_` and twenty-four hex characters. */
  id: string;
  computerId: string;
  /** The thread each fire continues, or `null` for a new thread each time. */
  threadId: string | null;
  name: string | null;
  /** Five fields: minute, hour, day of month, month, day of week. */
  cron: string;
  /** The IANA time zone `cron` is read in. */
  timezone: string;
  prompt: string;
  model: string;
  maxSteps: number;
  maxCostUsd: number;
  paused: boolean;
  pausedReason: AgentSchedulePausedReason | null;
  /** When it next fires; `null` while paused. */
  nextFireAt: string | null;
  lastFireAt: string | null;
  /** The run its last started fire began. */
  lastRunId: string | null;
  createdAt: string;
  updatedAt: string;
  /** Its latest fires, newest first. Empty in a list. */
  recentFires: AgentScheduleFire[];
  /** The answer as sent. */
  raw: Record<string, unknown>;
};

/** One page of `client.agentSchedules.list()`, newest first. */
export type AgentSchedulePage = {
  schedules: AgentSchedule[];
  hasMore: boolean;
  /** Pass back as `before` for the next page; `null` on the last. */
  nextBefore: string | null;
  raw: Record<string, unknown>;
};

/** What a schedule is made with. `cron` and `prompt` are required. */
export type AgentScheduleArgs = {
  /** When to run: five fields, minute hour day-of-month month day-of-week. At most one fire every five minutes. */
  cron: string;
  /** An IANA time zone name, such as `Europe/London`. The platform's default is UTC. */
  timezone?: string;
  /** What each run is asked to do. */
  prompt: string;
  /** The model each run uses: `claude-sonnet-5-5` or `claude-opus-5-5`. */
  model?: string;
  /** Only `anthropic`: a schedule runs on Mandala AI credits, which are Anthropic models. */
  provider?: 'anthropic';
  /** The step cap of each run, 1 to 500. */
  maxSteps?: number;
  /** The most each run may spend, in USD, 0.25 to 20. */
  maxCostUsd?: number;
  /** A thread of this computer's for every fire to continue. */
  threadId?: string | null;
  /** A label of your choosing. */
  name?: string | null;
  /** Make it paused. */
  paused?: boolean;
};

/** What a change may send: any of the fields a schedule is made with. */
export type AgentScheduleUpdate = Partial<AgentScheduleArgs>;

type CallOptions = { signal?: AbortSignal };

const nullableStr = (v: unknown, what: string): string | null => {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') throw new MandalaError(`expected ${what} to be a string or null`);
  return v;
};

function toFire(d: unknown, what: string): AgentScheduleFire {
  if (!P.isRecord(d)) throw new MandalaError(`expected ${what} to be an object`);
  if (typeof d.outcome !== 'string' || !d.outcome)
    throw new MandalaError(`expected ${what} to carry its outcome`);
  return {
    scheduledFor: str(d.scheduled_for),
    firedAt: str(d.fired_at),
    outcome: d.outcome,
    runId: nullableStr(d.run_id, `${what}'s run_id`),
    error: nullableStr(d.error, `${what}'s error`),
  };
}

/** Read one schedule off the wire, refusing one that does not say which it is or whether it is paused. */
export function toAgentSchedule(d: unknown, what = 'an agent schedule'): AgentSchedule {
  if (!P.isRecord(d)) throw new MandalaError(`expected ${what} to be an object`);
  if (typeof d.id !== 'string' || !d.id || d.id !== d.id.trim()) {
    throw new MandalaError(`expected ${what} to carry its id`);
  }
  const fires = d.recent_fires === undefined ? [] : d.recent_fires;
  if (!Array.isArray(fires)) throw new MandalaError(`expected ${what}'s recent_fires to be a list`);
  return {
    id: d.id,
    computerId: str(d.computer_id),
    threadId: nullableStr(d.thread_id, `${what}'s thread_id`),
    name: nullableStr(d.name, `${what}'s name`),
    cron: str(d.cron),
    timezone: str(d.timezone),
    prompt: str(d.prompt),
    model: str(d.model),
    maxSteps: num(d.max_steps),
    maxCostUsd: num(d.max_cost_usd),
    paused: flag(d.paused, `${what}'s paused`, true),
    pausedReason: nullableStr(d.paused_reason, `${what}'s paused_reason`),
    nextFireAt: nullableStr(d.next_fire_at, `${what}'s next_fire_at`),
    lastFireAt: nullableStr(d.last_fire_at, `${what}'s last_fire_at`),
    lastRunId: nullableStr(d.last_run_id, `${what}'s last_run_id`),
    createdAt: str(d.created_at),
    updatedAt: str(d.updated_at),
    recentFires: fires.map((f, i) => toFire(f, `fire ${i} of ${what}`)),
    raw: { ...d },
  };
}

function toPage(d: unknown, where: string): AgentSchedulePage {
  if (!P.isRecord(d) || !Array.isArray(d.schedules)) {
    throw new MandalaError(`expected a list of agent schedules from ${where}`);
  }
  const schedules = d.schedules.map((row, i) =>
    toAgentSchedule(row, `agent schedule ${i} from ${where}`),
  );
  const more = flag(d.has_more, `has_more from ${where}`, true);
  const last = schedules[schedules.length - 1];
  if (more && !last) {
    throw new MandalaError(`expected the page from ${where} that says more follow to have a row`);
  }
  return { schedules, hasMore: more, nextBefore: more && last ? last.id : null, raw: { ...d } };
}

/**
 * The wire body for a create or a change, checked for type locally; the
 * platform holds the values to its own rules (a cron expression's fields, a
 * known zone, the step and cost ranges) and answers a 400 for any it refuses.
 */
function scheduleBody(
  args: AgentScheduleUpdate,
  required: boolean,
  what: string,
): Record<string, unknown> {
  if (!P.isRecord(args))
    throw new ValidationError(`${what}: options must be an object (got ${typeof args})`);
  const known = new Set([
    'cron',
    'timezone',
    'prompt',
    'model',
    'provider',
    'maxSteps',
    'maxCostUsd',
    'threadId',
    'name',
    'paused',
  ]);
  for (const key of Object.keys(args)) {
    if (key === 'modelKey' || key === 'system') {
      throw new ValidationError(
        `${what}: a schedule runs on Mandala AI credits and cannot keep ${key === 'modelKey' ? 'a model key' : 'a system prompt'}`,
      );
    }
    if (!known.has(key)) throw new ValidationError(`${what}: unknown option ${key}`);
  }
  const body: Record<string, unknown> = {};
  const text = (key: 'cron' | 'timezone' | 'prompt' | 'model', wire: string) => {
    const v = args[key];
    if (v === undefined) {
      if (required && (key === 'cron' || key === 'prompt'))
        throw new ValidationError(`${what}: ${key} is required`);
      return;
    }
    if (typeof v !== 'string' || !v.trim())
      throw new ValidationError(`${what}: ${key} must be a non-empty string`);
    body[wire] = v;
  };
  text('cron', 'cron');
  text('timezone', 'timezone');
  text('prompt', 'prompt');
  text('model', 'model');
  if (args.provider !== undefined) {
    if (args.provider !== 'anthropic')
      throw new ValidationError(`${what}: provider must be anthropic`);
    body.provider = args.provider;
  }
  if (args.maxSteps !== undefined) {
    if (!Number.isInteger(args.maxSteps) || args.maxSteps < 1) {
      throw new ValidationError(`${what}: maxSteps must be a whole number of at least 1`);
    }
    body.max_steps = args.maxSteps;
  }
  if (args.maxCostUsd !== undefined) {
    if (typeof args.maxCostUsd !== 'number' || !Number.isFinite(args.maxCostUsd)) {
      throw new ValidationError(`${what}: maxCostUsd must be a number`);
    }
    body.max_cost_usd = args.maxCostUsd;
  }
  for (const [key, wire] of [
    ['threadId', 'thread_id'],
    ['name', 'name'],
  ] as const) {
    const v = args[key];
    if (v === undefined) continue;
    if (v !== null && typeof v !== 'string')
      throw new ValidationError(`${what}: ${key} must be a string or null`);
    body[wire] = v;
  }
  if (args.paused !== undefined) {
    if (typeof args.paused !== 'boolean')
      throw new ValidationError(`${what}: paused must be true or false`);
    body.paused = args.paused;
  }
  return body;
}

/**
 * Agent schedules: background runs started on a timetable.
 *
 * ```ts
 * const schedule = await client.agentSchedules.create('vm-1', {
 *   cron: '0 9 * * MON-FRI',
 *   timezone: 'America/New_York',
 *   prompt: 'Check the overnight build and file a summary in ~/reports',
 * });
 * const now = await client.agentSchedules.get(schedule.id);
 * for (const fire of now.recentFires) console.log(fire.scheduledFor, fire.outcome, fire.runId);
 * ```
 *
 * Needs the `member` role or higher, and an API key that neither expires nor
 * is limited to specific computers: a schedule acts as its key on every fire.
 * A key confined to a workspace sees that workspace's schedules only.
 */
export class AgentSchedules {
  #t: Transport;

  /** @internal */
  constructor(transport: Transport) {
    this.#t = transport;
  }

  /** Make a schedule on a computer. */
  async create(
    computerId: string,
    args: AgentScheduleArgs,
    opts: CallOptions = {},
  ): Promise<AgentSchedule> {
    const body = scheduleBody(args, true, 'agentSchedules.create()');
    const path = P.computerAction(computerId, 'agent/schedules');
    return toAgentSchedule(
      await this.#t.json('POST', path, { body, signal: opts.signal }),
      `the agent schedule from POST ${path}`,
    );
  }

  /** One page of schedules, newest first, each with an empty `recentFires`. */
  async list(
    args: P.AgentScheduleListArgs = {},
    opts: CallOptions = {},
  ): Promise<AgentSchedulePage> {
    const data = await this.#t.json('GET', P.AGENT_SCHEDULES, {
      query: P.agentSchedulesQuery(args),
      signal: opts.signal,
    });
    return toPage(data, `GET ${P.AGENT_SCHEDULES}`);
  }

  /** One schedule, when it next fires, and its 20 latest fires. */
  async get(scheduleId: string, opts: CallOptions = {}): Promise<AgentSchedule> {
    const path = P.agentSchedule(scheduleId);
    return toAgentSchedule(
      await this.#t.json('GET', path, { signal: opts.signal }),
      `the agent schedule from GET ${path}`,
    );
  }

  /**
   * Change any of a schedule's fields; what is not sent stays. The schedule
   * acts as this client's key from then on, and its next fire is the first
   * time after now. A schedule paused for a reason of its own stays paused
   * until {@link resume}.
   */
  async update(
    scheduleId: string,
    changes: AgentScheduleUpdate,
    opts: CallOptions = {},
  ): Promise<AgentSchedule> {
    const path = P.agentSchedule(scheduleId);
    const body = scheduleBody(changes, false, 'agentSchedules.update()');
    return toAgentSchedule(
      await this.#t.json('PATCH', path, { body, signal: opts.signal }),
      `the agent schedule from PATCH ${path}`,
    );
  }

  /** Pause it: it does not fire until resumed. */
  async pause(scheduleId: string, opts: CallOptions = {}): Promise<AgentSchedule> {
    return this.update(scheduleId, { paused: true }, opts);
  }

  /** Resume it, whatever paused it. It acts as this client's key from then on. */
  async resume(scheduleId: string, opts: CallOptions = {}): Promise<AgentSchedule> {
    return this.update(scheduleId, { paused: false }, opts);
  }

  /** Delete it. Runs it already started are untouched. */
  async delete(scheduleId: string, opts: CallOptions = {}): Promise<void> {
    await this.#t.json('DELETE', P.agentSchedule(scheduleId), { signal: opts.signal });
  }
}
