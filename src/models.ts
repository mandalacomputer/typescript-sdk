/**
 * Response objects.
 *
 * Deliberately permissive: unknown fields are preserved in `raw` rather than
 * rejected, so a platform that starts returning more does not break older
 * clients. Every shape here is read through a `from*` function rather than cast
 * from JSON, because a cast is a claim about a payload nobody checked — and the
 * failure it produces is `undefined` in arithmetic three calls later, at a
 * place that has nothing to do with the response that was wrong.
 */

import { MandalaError } from './errors.js';
import { isRecord } from './paths.js';

const str = (v: unknown, fallback = ''): string => (v == null ? fallback : String(v));
/**
 * A number from a payload, with a fallback for anything that is not one.
 *
 * Exported for {@link Computer}'s own getters, which read the same platform
 * fields off the same records: a bare `Number()` there answers NaN where this
 * answers the fallback, and the two disagreeing about one payload is worse than
 * either rule on its own.
 */
export const num = (v: unknown, fallback = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
// Not Boolean() alone. A platform that ever stringifies one of these sends
// `"false"`, which is a non-empty string and therefore true — the one coercion
// in this file that inverts a field's meaning rather than blurring it, and
// `timed_out: "false"` reading as timed out is a worse answer than any missing
// number here can produce.
export const bool = (v: unknown): boolean => {
  // Lowercased before the compare, because the platform this mirrors is the one
  // whose own SDK is Python: `str(False)` is `'False'`, capital F, and that is
  // by some distance the stringified boolean most likely to actually arrive.
  if (typeof v === 'string') {
    const s = v.toLowerCase();
    return s !== '' && s !== 'false' && s !== '0';
  }
  return Boolean(v);
};

/**
 * A count the platform may simply not have sent.
 *
 * `undefined` for an absent one and for a `null`, which is the shape the
 * difference matters in: a route typed `number | undefined` that hands back the
 * raw field hands back `null` too, against a type that says it cannot, and the
 * `=== undefined` check the caller wrote to find out whether the platform
 * answered is false for it.
 */
export const count = (v: unknown): number | undefined => {
  if (v == null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/**
 * Everything needed to put a computer's live desktop on a page.
 *
 * Two credentials rather than one, and the difference is enforced by the
 * platform rather than by the client asking politely:
 *
 * - `token` — full control: keyboard and pointer. Root-equivalent on that one
 *   machine, so it belongs on a server or in a page you trust. NOT the
 *   clipboard, whatever a noVNC client offers on it: QEMU carries cut text only
 *   through a vdagent channel these guests are not started with, so a paste
 *   arrives and is dropped with no error. Move text with `exec` and
 *   `desktop: true` instead. A write needs `setsid` so the holder outlives the
 *   command — an X selection belongs to a live process — AND `>/dev/null 2>&1`,
 *   without which the resident xclip holds the pipe the guest agent is reading
 *   and the exec runs to its full timeout before answering. Send the text
 *   base64 rather than quoted, since an apostrophe would otherwise end the
 *   shell word, and poll rather than reading straight back: being granted a
 *   selection is asynchronous, so the next read can still be the old one.
 * - `viewToken` — watch only. The platform drops input on a socket opened with
 *   it, so a browser holding this one cannot type even from a patched client.
 *
 * Both are scoped to a single computer, and neither is the account API key —
 * which is every computer on the account, forever, and must never reach a
 * browser. Both end when the computer restarts.
 */
export type VncConnect = {
  /** Websocket URL carrying `token`. Full control. */
  url: string;
  /** Websocket URL carrying `viewToken`. Watch only. */
  viewUrl: string;
  /** The credential inside {@link url}, for building your own noVNC URL. */
  token: string;
  /** The credential inside {@link viewUrl}. */
  viewToken: string;
  /**
   * The platform's hosted viewer, watch-only, for an `<iframe>`. The credential
   * is in the URL fragment, which browsers never send to a server — so it stays
   * out of access logs and out of `Referer` on everything the page then loads.
   */
  embedUrl: string;
  /**
   * Websocket URL opening an interactive terminal — a PTY in the guest, carried
   * on the same controlling credential as {@link url}, so treat it as that
   * credential. `''` on a Windows guest, which has no terminal yet.
   *
   * Present and refused is the case to plan for, and it is about the COMPUTER
   * rather than the platform: the serial channel a terminal runs over is added
   * to a guest's hardware at COLD boot, so a computer last started before
   * terminals shipped has a URL here that answers 409 until it is stopped and
   * started. A restart will not do it — that resets the same QEMU, and the
   * command line only changes on a cold boot. The refusal says as much.
   */
  terminalUrl: string;
  raw: Record<string, unknown>;
};

/**
 * Build a {@link VncConnect}, or `undefined` when the platform did not supply a
 * full set.
 *
 * Absent rather than partial is the platform's own rule: a URL built over a
 * missing credential is a string indistinguishable from a working one that
 * answers 401 forever. Anything short of both credentials is treated as no
 * connect surface at all.
 */
export function toVncConnect(d: unknown): VncConnect | undefined {
  if (!isRecord(d)) return undefined;
  const token = str(d.token);
  const viewToken = str(d.view_token);
  if (!token || !viewToken) return undefined;
  return {
    url: str(d.url),
    viewUrl: str(d.view_url),
    token,
    viewToken,
    embedUrl: str(d.embed_url),
    terminalUrl: str(d.terminal_url),
    raw: { ...d },
  };
}

export type Template = {
  name: string;
  label: string;
  os: string;
  cpu: number;
  ramMb: number;
  diskGb: number;
  raw: Record<string, unknown>;
};

export function toTemplate(d: Record<string, unknown>): Template {
  return {
    name: str(d.name),
    label: str(d.label),
    os: str(d.os),
    cpu: num(d.cpu),
    ramMb: num(d.ram_mb),
    diskGb: num(d.disk_gb),
    raw: { ...d },
  };
}

/**
 * A named size: a template plus a CPU/RAM/disk shape, from `GET /sizes`.
 *
 * These are the shapes the platform keeps pre-booted, so a create that passes
 * `id` as `size` is typically answered from the warm pool in about a second
 * where a custom shape boots cold.
 *
 * `allowed` is about the plan's per-computer ceilings only — what the account
 * already holds is not counted, so a create at an allowed size can still be
 * refused against the plan's pools. `cheapestPlan` is the plan to name when it
 * is false, or `undefined` if no purchasable plan admits the row.
 */
export type Size = {
  id: string;
  label: string;
  template: string;
  cpu: number;
  ramMb: number;
  diskGb: number;
  allowed: boolean;
  cheapestPlan?: string;
  raw: Record<string, unknown>;
};

export function toSize(d: Record<string, unknown>): Size {
  const cheapest = d.cheapest_plan;
  return {
    id: str(d.id),
    label: str(d.label),
    template: str(d.template),
    cpu: num(d.cpu),
    ramMb: num(d.ram_mb),
    diskGb: num(d.disk_gb),
    allowed: bool(d.allowed),
    cheapestPlan: cheapest == null ? undefined : str(cheapest),
    raw: { ...d },
  };
}

/** The period an account is billed on. */
export type UsagePeriod = {
  start: string;
  end: string;
  /**
   * `"subscription"` when the boundary came from the plan's renewal date, which
   * is what an invoice is anchored to. `"calendar-month"` when there is no live
   * subscription to take it from, in which case the period is the current UTC
   * month. Worth reading before quoting a figure at anybody: the two answer
   * different questions about "this period".
   */
  source: string;
};

/** One computer's share of a window. */
export type ComputerUsage = {
  id: string;
  name: string;
  runHours: number;
  vcpuHours: number;
  ramGbHours: number;
  /**
   * This computer is no longer on the fleet. It ran during the window and was
   * deleted, which is why it is billed for and not in `client.computers.list()`
   * — the line is not stale, the machine is gone.
   */
  gone: boolean;
};

/**
 * What an account used, with the per-computer breakdown behind the totals.
 *
 * The two storage figures stay separate because the remedies are: a computer's
 * disk is provisioned at create and released at delete, and snapshots come and
 * go under the retention policy you set. One summed number would be a figure
 * nobody could act on.
 */
export type UsageTotals = {
  runHours: number;
  vcpuHours: number;
  ramGbHours: number;
  snapshotGbHours: number;
  snapshotGbMonths: number;
  diskGbHours: number;
  diskGbMonths: number;
  /**
   * The breakdown, which is what makes a total checkable.
   *
   * EMPTY on a workspace-scoped API key, and empty rather than absent so that
   * reading it never needs a null check. Usage is metered and billed per
   * ACCOUNT, so these lines cover the whole account and would name computers
   * outside such a key's scope; the platform withholds them and sends the
   * account-wide totals either way. {@link UsageReport.breakdown} is how to tell
   * "no computers ran" from "this key may not see which did".
   */
  computers: ComputerUsage[];
};

/**
 * What `client.usage.read()` answers.
 *
 * READ {@link UsageReport.degraded} AND {@link UsageReport.unmetered} BEFORE
 * USING THE NUMBERS. Every figure is a sum across the hypervisors this
 * account's computers are on, so a host that did not contribute does not leave
 * a hole anybody could notice — it leaves a total that is quietly too small.
 * The platform answers 200 with these two flags rather than refusing, because a
 * caveat in the same body cannot be missed the way a missing row can, and
 * because one of the two never clears by retrying.
 *
 * `raw` carries the whole payload, nested objects included, so a field the
 * platform adds later is readable without a release of this package. It is on
 * this type only and not on the three above, which would be three more copies
 * of the same bytes.
 */
export type UsageReport = {
  /**
   * The period this ACCOUNT is billed on — not necessarily the window that was
   * measured. {@link UsageReport.from} and {@link UsageReport.to} are that, and
   * they differ whenever a window was named.
   */
  period: UsagePeriod;
  from: string;
  /**
   * The end of the measured window, and worth reading rather than assuming: a
   * `to` in the future is answered as now, because the future holds no usage.
   */
  to: string;
  usage: UsageTotals;
  /**
   * A hypervisor could not be reached, so every figure may be too small. This
   * one clears on its own — retry when the host is back.
   */
  degraded: boolean;
  /**
   * The same shortfall from the other cause: a hypervisor is up and running a
   * daemon older than the meter, so it has no hours to report. Waiting does not
   * fix this one, which is why it is a separate flag rather than the same one.
   */
  unmetered: boolean;
  /**
   * Whether {@link UsageTotals.computers} is the real breakdown rather than a
   * withheld one — false on a workspace-scoped key. Derived from the payload's
   * shape (the platform omits the field rather than sending an empty array), so
   * an empty breakdown can be told from an invisible one.
   */
  breakdown: boolean;
  /**
   * The last UTC day (`YYYY-MM-DD`) whose usage has settled for billing — a
   * contiguous prefix, so a day still being held back stops the count where it
   * is. `undefined` when none of the window has settled yet.
   *
   * NOT a caveat on the totals, which are live from the ledger and true through
   * {@link UsageReport.to}. It answers the other question, and it is the one to
   * check before comparing these numbers against an invoice.
   */
  reportedThrough?: string;
  raw: Record<string, unknown>;
};

export function toUsageReport(d: Record<string, unknown>): UsageReport {
  const period = isRecord(d.period) ? d.period : {};
  const totals = isRecord(d.usage) ? d.usage : {};
  const rows = Array.isArray(totals.computers) ? totals.computers.filter(isRecord) : [];
  const through = d.reported_through;
  return {
    period: { start: str(period.start), end: str(period.end), source: str(period.source) },
    from: str(d.from),
    to: str(d.to),
    usage: {
      runHours: num(totals.run_hours),
      vcpuHours: num(totals.vcpu_hours),
      ramGbHours: num(totals.ram_gb_hours),
      snapshotGbHours: num(totals.snapshot_gb_hours),
      snapshotGbMonths: num(totals.snapshot_gb_months),
      diskGbHours: num(totals.disk_gb_hours),
      diskGbMonths: num(totals.disk_gb_months),
      computers: rows.map((c) => ({
        id: str(c.id),
        name: str(c.name),
        runHours: num(c.run_hours),
        vcpuHours: num(c.vcpu_hours),
        ramGbHours: num(c.ram_gb_hours),
        gone: bool(c.gone),
      })),
    },
    degraded: bool(d.degraded),
    unmetered: bool(d.unmetered),
    // Presence, not emptiness. The platform drops the key for a scoped
    // credential and sends `[]` for an account that ran nothing, and those are
    // different answers: one is "you may not see this", the other is "there was
    // nothing to see".
    breakdown: Array.isArray(totals.computers),
    reportedThrough: through == null ? undefined : str(through),
    raw: { ...d },
  };
}

export type Snapshot = {
  id: string;
  computerId: string;
  /**
   * The source computer's name — its current one where the computer still
   * exists, so a rename shows through without re-reading anything, and the name
   * at capture for an orphan, which is all there is left of it.
   *
   * `''` on a snapshot taken before the platform recorded this, and on an
   * {@link unreachable} placeholder.
   */
  computerName: string;
  name: string;
  /** `"disk"`, or `"memory"` for a live RAM+disk capture. */
  kind: string;
  /**
   * Where these bytes have got to, and what may be done with them.
   *
   * - `"capturing"` — still being taken, and NOT a snapshot yet. A listing puts
   *   these first, their ids begin `cap-`, and restore, clone and delete all
   *   answer 404 on one. Acting on the newest row of a fresh listing is exactly
   *   how this is met.
   * - `"pending"` — on its host and usable. This is the point to act from.
   * - `"durable"` — in backup storage too. See {@link durable}.
   * - `"deleting"` — a deletion that began and did not finish; only listed when
   *   asked for.
   */
  state: string;
  sizeBytes: number;
  createdAt: string;
  incremental: boolean;
  /** True if the scheduler took this rather than a person. */
  auto: boolean;
  /** True once replicated to backup storage. */
  durable: boolean;
  /** A live capture: forks and restores without booting. */
  memory: boolean;
  /**
   * True when its computer is gone.
   *
   * Such a snapshot can still be cloned into a new computer, but cannot be
   * restored — a restore puts the disk back on a source that no longer exists.
   */
  orphaned: boolean;
  /**
   * True for a placeholder the platform appended for a snapshot it could not
   * reach during a partial listing.
   *
   * It carries an id and nothing else — not even `computerId`, because there
   * was no host to say what it belongs to. Filtering a listing by computer must
   * keep these, or the filter deletes precisely the markers that say something
   * is missing and then reports a confident count.
   */
  unreachable: boolean;
  /**
   * The shape a clone of this snapshot comes up as.
   *
   * Carried on the snapshot rather than read off its computer, because the
   * computer may be gone and the snapshot is still cloneable — and because a
   * computer that was resized after the capture no longer describes it. Zero and
   * `''` on an {@link unreachable} placeholder, which carries an id and nothing
   * else.
   */
  os: string;
  template: string;
  cpu: number;
  ramMb: number;
  diskGb: number;
  /**
   * The screen the capture was taken at, `WIDTHxHEIGHTxDEPTH`, and the
   * coordinate space a clone of it will click in.
   */
  resolution: string;
  raw: Record<string, unknown>;
};

export function toSnapshot(d: Record<string, unknown>): Snapshot {
  return {
    id: str(d.id),
    computerId: str(d.computer_id),
    computerName: str(d.computer_name),
    name: str(d.name),
    kind: str(d.kind, 'disk'),
    state: str(d.state),
    sizeBytes: num(d.size_bytes),
    createdAt: str(d.created_at),
    incremental: bool(d.incremental),
    auto: bool(d.auto),
    durable: str(d.state) === 'durable',
    memory: str(d.kind, 'disk') === 'memory',
    orphaned: bool(d.orphaned),
    unreachable: bool(d.unreachable),
    os: str(d.os),
    template: str(d.template),
    cpu: num(d.cpu),
    ramMb: num(d.ram_mb),
    diskGb: num(d.disk_gb),
    resolution: str(d.resolution),
    raw: { ...d },
  };
}

/**
 * What a computer would leave behind, from `GET computers/:id/snapshots`.
 *
 * NOT a listing of the snapshots themselves — that is `client.snapshots.list()`,
 * and the two answer different shapes.
 *
 * `fingerprint` is why this route exists rather than being a total a caller
 * could compute: it names that exact set, and it is the interlock on an
 * irreversible operation. Pass it to `computer.delete({ deleteSnapshots: true,
 * expect })` and a capture that finished after you looked cannot be swept up in
 * a decision that was never about it.
 */
/**
 * A move in flight, or the outcome of one that has finished.
 *
 * A resize past what a computer's host can run is refused with an offer (see
 * {@link MoveRequiredError}); {@link Computer.relocate} takes it up, and the
 * platform answers 202 with one of these while the disk copy runs behind it.
 * `client.moves.list()` is where it is read afterwards.
 *
 * Two fields are deliberately absent because the platform does not send them:
 * which host the computer is leaving and which it is going to. Both are recorded
 * on its side for an operator; a tenant is told "another host in this region"
 * and never which machine.
 */
export type Move = {
  computerId: string;
  /**
   * Where it has got to. `staging`, `moving` and `resizing` are live; `done`,
   * `moved`, `failed` and `lost` are terminal — and the three failures are three
   * different things, which is the whole reason they are three words:
   *
   * - `done` — on the new host at the new size.
   * - `moved` — on the new host at its OLD size. The move landed and the resize
   *   did not, so the computer HAS changed hardware and an ordinary
   *   {@link Computer.update} finishes the job where it now is. Reading this as
   *   "the move failed" sends you looking for a machine that has moved.
   * - `failed` — nothing happened. The computer is where it was, untouched.
   * - `lost` — we stopped watching. It may well have completed; read the
   *   computer.
   */
  state: string;
  /** A sentence about the state, meant to be shown to a person. Empty while nothing has gone wrong. */
  detail: string;
  /** Still running. The flag to poll on, rather than comparing {@link state} to a list. */
  live: boolean;
  /** Present only where the move is applying a new value. */
  cpu?: number;
  ramMb?: number;
  diskGb?: number;
  startedAt: string;
  /** Absent while {@link live}. */
  finishedAt?: string;
  raw: Record<string, unknown>;
};

export function toMove(d: Record<string, unknown>): Move {
  return {
    computerId: str(d.computer_id),
    state: str(d.state),
    detail: str(d.detail),
    live: bool(d.live),
    // Absent stays absent rather than becoming 0, because the platform omits a
    // dimension the move is NOT changing — `ram_mb: 0` would read as a resize to
    // nothing, on the field this whole operation exists to grow.
    ...(d.cpu === undefined ? {} : { cpu: num(d.cpu) }),
    ...(d.ram_mb === undefined ? {} : { ramMb: num(d.ram_mb) }),
    ...(d.disk_gb === undefined ? {} : { diskGb: num(d.disk_gb) }),
    startedAt: str(d.started_at),
    ...(d.finished_at === undefined ? {} : { finishedAt: str(d.finished_at) }),
    raw: { ...d },
  };
}

export type Holdings = {
  count: number;
  sizeBytes: number;
  fingerprint: string;
  raw: Record<string, unknown>;
};

export function toHoldings(d: Record<string, unknown>): Holdings {
  return {
    count: num(d.count),
    sizeBytes: num(d.size_bytes),
    fingerprint: str(d.fingerprint),
    raw: { ...d },
  };
}

/** The outcome of a shell command run inside the guest. */
export type ExecResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /**
   * True when the guest agent stopped capturing stdout before the command
   * stopped producing it. See {@link truncated}.
   */
  outTruncated: boolean;
  /** The same for stderr. */
  errTruncated: boolean;
  /**
   * The command ran and exited zero.
   *
   * Deliberately says nothing about {@link truncated}: a command that succeeded
   * and produced more output than the guest agent would carry is still a
   * command that succeeded. Whether a short answer is acceptable depends on what
   * you were going to do with it.
   */
  ok: boolean;
  /**
   * True if either stream was cut short.
   *
   * The guest agent caps captured output at 16 MiB. Past that the command keeps
   * running and keeps producing, and what comes back is the first 16 MiB with
   * no other sign there was more — which is why this is worth checking before
   * parsing the output of anything that could be large. Redirect to a file
   * inside the guest and `readFile` it instead when it might be.
   */
  truncated: boolean;
  raw: Record<string, unknown>;
};

export function toExecResult(d: Record<string, unknown>): ExecResult {
  // -1 when the platform did not send one, not 0: a response with no exit code
  // is not evidence the command succeeded, and `ok` must not affirm what
  // nobody said. Same reasoning as delete()'s undefined snapshot count.
  // "Did not send one" includes null and the empty string, both of which
  // Number() coerces to exactly the 0 this must not invent.
  const exitCode = d.exit_code == null || d.exit_code === '' ? -1 : num(d.exit_code, -1);
  const timedOut = bool(d.timed_out);
  const outTruncated = bool(d.out_truncated);
  const errTruncated = bool(d.err_truncated);
  return {
    exitCode,
    stdout: str(d.stdout),
    stderr: str(d.stderr),
    timedOut,
    outTruncated,
    errTruncated,
    ok: exitCode === 0 && !timedOut,
    truncated: outTruncated || errTruncated,
    raw: { ...d },
  };
}

/**
 * A command still running inside the guest, from an `exec({ background: true })`.
 *
 * The output is a **cursor, not a buffer**: each {@link Computer.execPoll} gives
 * you only the bytes since the last one, so two readers on one pid split the
 * output between them rather than each seeing all of it.
 */
export type BackgroundExec = {
  pid: number;
  running: boolean;
  /** Set once it has exited. `undefined` while it is still running. */
  exitCode?: number;
  stdout: string;
  stderr: string;
  /** True when the platform has more output waiting — poll again straight away. */
  more: boolean;
  killed: boolean;
  outTruncated: boolean;
  errTruncated: boolean;
  raw: Record<string, unknown>;
};

export function toBackgroundExec(d: Record<string, unknown>): BackgroundExec {
  const pid = num(d.pid);
  // The pid is the handle: every poll and every kill is aimed at it, and 0 is
  // not a job on either guest OS. Defaulted to 0 the way every other number
  // here is, an empty or truncated payload decodes as a *finished job on pid
  // 0* — a command that ran and exited cleanly, which is the one wrong answer
  // on this route that reads as fine and that nothing downstream can catch.
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new MandalaError(
      `expected a background command's pid, got ${JSON.stringify(d.pid ?? null)}`,
    );
  }
  return {
    pid,
    // Absent is not false. `false` here is the claim that the command has
    // exited, which is the same finished-job answer the pid check above
    // refuses, so an absent field falls back to whether an exit code arrived —
    // which is what "running" means in the first place.
    running: d.running == null ? d.exit_code == null || d.exit_code === '' : bool(d.running),
    // The empty string counts as "did not send one", for toExecResult's reason
    // about the same field: Number('') is 0, and a command still running
    // reported as having exited successfully is the one wrong answer here that
    // reads as fine. A value that is not a number at all — `"killed"`,
    // `"signal:9"`, an object — is that same wrong answer by another route, so
    // it gets toExecResult's -1 rather than num()'s implicit 0.
    exitCode: d.exit_code == null || d.exit_code === '' ? undefined : num(d.exit_code, -1),
    stdout: str(d.stdout),
    stderr: str(d.stderr),
    more: bool(d.more),
    killed: bool(d.killed),
    outTruncated: bool(d.out_truncated),
    errTruncated: bool(d.err_truncated),
    raw: { ...d },
  };
}

/**
 * One window on the guest's desktop.
 *
 * A screenshot says what the desktop looks like; this says what any of it *is*,
 * which is how you tell a browser that failed to open from one that has not
 * painted yet. Match on {@link windowClass}, not {@link title}: the class is the
 * application, the title is whatever page it is showing.
 */
export type GuestWindow = {
  /** `0x2600003`-shaped. What {@link Computer.windowAction} takes. */
  id: string;
  title: string;
  /** The X11 window class — the application, not its current document. */
  windowClass: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  focused: boolean;
  minimized: boolean;
  raw: Record<string, unknown>;
};

export function toGuestWindow(d: Record<string, unknown>): GuestWindow {
  return {
    id: str(d.id),
    title: str(d.title),
    windowClass: str(d.class),
    type: str(d.type),
    x: num(d.x),
    y: num(d.y),
    width: num(d.width),
    height: num(d.height),
    focused: bool(d.focused),
    minimized: bool(d.minimized),
    raw: { ...d },
  };
}

/** The automatic daily snapshot schedule. */
export type Schedule = {
  enabled: boolean;
  hour: number;
  minute: number;
  tz: string;
  raw: Record<string, unknown>;
};

export function toSchedule(d: Record<string, unknown>): Schedule {
  return {
    enabled: bool(d.enabled),
    hour: num(d.hour),
    minute: num(d.minute),
    tz: str(d.tz, 'UTC'),
    raw: { ...d },
  };
}

/** Where the pointer is. */
export type Point = { x: number; y: number };
