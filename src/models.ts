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

import { isRecord } from './paths.js';

const str = (v: unknown, fallback = ''): string => (v == null ? fallback : String(v));
const num = (v: unknown, fallback = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
// Not Boolean() alone. A platform that ever stringifies one of these sends
// `"false"`, which is a non-empty string and therefore true — the one coercion
// in this file that inverts a field's meaning rather than blurring it, and
// `timed_out: "false"` reading as timed out is a worse answer than any missing
// number here can produce.
const bool = (v: unknown): boolean => {
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
 * Everything needed to put a computer's live desktop on a page.
 *
 * Two credentials rather than one, and the difference is enforced by the
 * platform rather than by the client asking politely:
 *
 * - `token` — full control: keyboard, pointer, clipboard. Root-equivalent on
 *   that one machine, so it belongs on a server or in a page you trust.
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
   * credential. `''` on a Windows guest, which has no terminal yet, and on a
   * platform from before the terminal existed.
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
  return {
    pid: num(d.pid),
    running: bool(d.running),
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
