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

/**
 * A string from a payload, with a fallback for an absent one.
 *
 * `String()` THROWS rather than coercing on a value with no primitive
 * conversion — `{"toString": "x"}` off the wire is an object whose `toString`
 * is not callable, and `Object.create(null)` has none at all. Both are
 * `TypeError` out of the middle of a decode, which is a crash where this file's
 * whole contract is that a payload nobody checked is preserved rather than
 * rejected: one such field on one row of a listing took down the listing
 * (OPL-3850, found while testing the coercion fixes). The fallback answers
 * instead, and `raw` still carries the value that could not be read.
 */
export const str = (v: unknown, fallback = ''): string => {
  if (v == null) return fallback;
  try {
    return String(v);
  } catch {
    return fallback;
  }
};
/**
 * A number from a payload, with a fallback for anything that is not one.
 *
 * Exported for {@link Computer}'s own getters, which read the same platform
 * fields off the same records: a bare `Number()` there answers NaN where this
 * answers the fallback, and the two disagreeing about one payload is worse than
 * either rule on its own.
 *
 * A NUMBER OR THE TEXT OF ONE, and the same guard {@link count} carries for the
 * same reason: `Number()` is a coercion and not a parser, so `Number([7])` is 7
 * and `Number([])` and `Number('  ')` are both 0. Every one of those is a value
 * this client invented rather than read, and the fallback is what it is for.
 */
export const num = (v: unknown, fallback = 0): number => {
  if (typeof v !== 'number' && typeof v !== 'string') return fallback;
  if (typeof v === 'string' && v.trim() === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
/**
 * What a boolean field on the wire actually WAS, before anything decides what it
 * MEANS.
 *
 * Five states, because five is how many there are. The decoder this replaces
 * returned a `boolean` and fell through to `Boolean(v)`, so a value it could NOT
 * read came back true — and true is the wrong direction on the two fields here
 * that are a control rather than a caveat (OPL-3850). `valid` reported an
 * unreadable verdict as publishable, on the field whose whole job is to say
 * whether a document is fit to publish; `more` is a backoff switch, and the poll
 * loop printed in this package's own README polls again immediately while it is
 * set, so an unreadable one is an unbounded zero-delay poll against a metered
 * endpoint.
 *
 * No single fallback fixes that, because every fallback boolean is wrong
 * somewhere: the right answer needs context a one-field decoder cannot see. So
 * this classifies and decides nothing, and each call site below says what an
 * unreadable value means for ITS field.
 *
 * THE SAME FIVE THE PYTHON SDK CLASSIFIES INTO (`_Wire`), so a payload neither
 * client can read decodes the same way in both.
 */
export const WIRE = {
  /** The key was not there. An older host that never heard of the field. */
  ABSENT: 'absent',
  /**
   * `null`. NOT APPLICABLE in this API's own convention — `cpu`, `finished_at`
   * and `exit_code` all use it that way — rather than "cannot tell".
   */
  NULL: 'null',
  TRUE: 'true',
  FALSE: 'false',
  /** Present, and not anything this client can read. */
  MALFORMED: 'malformed',
} as const;
export type Wire = (typeof WIRE)[keyof typeof WIRE];

/**
 * Classify one boolean field. It decides nothing.
 *
 * `true`/`false` and `1`/`0` are recognised however they are spelled — as JSON
 * booleans, as numbers, or as strings. The defect this comes from was
 * TRUTHINESS, not recognition: `Boolean("false")` is true, which is wrong, but
 * `"false"` still plainly means false, and a backend that encodes its booleans
 * that way must not be told that every flag it sends is unreadable. Strings are
 * lowercased first because the platform this mirrors is the one whose own SDK is
 * Python, where `str(False)` is `'False'`, capital F.
 *
 * Takes the VALUE where the Python classifier takes the record and the key:
 * `JSON.parse` never produces `undefined`, so absent and null stay
 * distinguishable here without passing the record around. That stops holding for
 * a record built in JavaScript rather than decoded from a response, and nothing
 * in this file reads one.
 */
export const wire = (v: unknown): Wire => {
  if (typeof v === 'boolean') return v ? WIRE.TRUE : WIRE.FALSE;
  if (v === undefined) return WIRE.ABSENT;
  if (v === null) return WIRE.NULL;
  // 1 and 0 exactly, rather than `Number(v)` over everything else: a coercing
  // test reads `[]`, `''` and `false` as 0, which is how truthiness got in here
  // in the first place. `1.0` is `1` in JavaScript, which is the agreement the
  // Python classifier has to accept integral floats explicitly to reach.
  if (typeof v === 'number') return v === 1 ? WIRE.TRUE : v === 0 ? WIRE.FALSE : WIRE.MALFORMED;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true' || s === '1') return WIRE.TRUE;
    if (s === 'false' || s === '0') return WIRE.FALSE;
  }
  return WIRE.MALFORMED;
};

/**
 * True only where the wire SAID so.
 *
 * The reading for a field whose true is a claim about the world — `valid`,
 * `allowed`, `killed`, `gone`, `auto`. Absent, null and unreadable are all
 * "nobody said that", and asserting it on the platform's behalf is exactly the
 * failure the old decoder produced.
 */
export const said = (v: unknown): boolean => wire(v) === WIRE.TRUE;

/**
 * True where the wire said so, AND where it sent something unreadable.
 *
 * The reading for a caveat — `degraded`, `unmatched`, `timed_out`, the
 * truncation flags. Every one of them means "there is more to this than you can
 * see", so over-reporting costs a caller a little time and under-reporting hands
 * back a short answer as though it were whole. A field present and unreadable is
 * itself a reason to doubt the payload carrying it.
 *
 * ABSENT and NULL are NOT caveats. A host too old to send the field is not
 * reporting a problem, and reading it as one would put a caveat on every
 * response such a host ever gives.
 */
export const caveat = (v: unknown): boolean => {
  const w = wire(v);
  return w === WIRE.TRUE || w === WIRE.MALFORMED;
};

/**
 * A count the platform may simply not have sent.
 *
 * `undefined` for an absent one and for a `null`, which is the shape the
 * difference matters in: a route typed `number | undefined` that hands back the
 * raw field hands back `null` too, against a type that says it cannot, and the
 * `=== undefined` check the caller wrote to find out whether the platform
 * answered is false for it.
 *
 * A NUMBER OR THE TEXT OF ONE, and nothing else. `Number()` is a coercion
 * rather than a parser: `Number([])` is 0 and `Number([7])` is 7, so an array
 * walked straight through the finiteness test written to catch garbage and came
 * out the far side as a coordinate — `{known: true, x: [], y: [7]}` reported the
 * pointer at `(0, 7)` (Codex adversarial review, OPL-3850). Python raises on
 * `int([])` and answers nothing, which is the same answer this now gives.
 *
 * A string of nothing but SPACE is the same non-answer as the empty one, and
 * catching only `''` left the same zero one keystroke away: `Number('  ')` is 0,
 * so `{known: true, x: ' '}` still reported the corner of the screen (Codex
 * review, third pass, OPL-3850).
 */
export const count = (v: unknown): number | undefined => {
  if (v == null) return undefined;
  if (typeof v !== 'number' && typeof v !== 'string') return undefined;
  if (typeof v === 'string' && v.trim() === '') return undefined;
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
 *   machine, so it belongs on a server or in a page you trust. The CLIPBOARD
 *   crosses this socket on a Linux computer whose QEMU has the vdagent channel
 *   and whose image carries the agent, and not otherwise, so a client that has
 *   to work on any computer should not depend on it. The two halves are
 *   acquired SEPARATELY and a computer needs both. The channel comes from a
 *   COLD start — stop the computer and start it again, or restart one that is
 *   already stopped, which starts it; restarting a RUNNING computer does not do
 *   it, because that resets the guest rather than rebuilding the machine QEMU
 *   was given. The agent is `spice-vdagent` inside the guest, which comes from
 *   the IMAGE, and a computer keeps the image it was created from — there is no
 *   operation that moves an existing one onto a newer one, so a computer built
 *   before the agent shipped needs it installed in the guest, which you can do
 *   yourself since you have root there, or replacing with a newly created
 *   computer. Windows guests never have it, whatever the hardware says. Where
 *   both are present, standard RFB extended cut text works in both directions
 *   and nothing below is needed. Where either is absent, text a client pastes
 *   reaches QEMU and stops — silently, with no error to catch — and no field
 *   tells you which you have.
 *
 *   `exec` with `desktop: true` is the route to build on if you only want to
 *   write it once, because it needs nothing of the hardware — but it is not
 *   universal either: it drives the guest's own desktop session, so it needs a
 *   Linux guest with a display and `xclip`, and it is refused outright on
 *   Windows. A write needs `setsid` so the holder outlives the command — an X
 *   selection belongs to a live process — AND `>/dev/null 2>&1`, without which
 *   the resident xclip holds the pipe the guest agent is reading and the exec
 *   runs to its full timeout before answering. Send the text base64 rather than
 *   quoted, since an apostrophe would otherwise end the shell word, and poll
 *   rather than reading straight back: being granted a selection is
 *   asynchronous, so the next read can still be the old one.
 * - `viewToken` — watch only. The platform drops input on a socket opened with
 *   it, so a browser holding this one cannot type even from a patched client.
 *   The guest's CLIPBOARD does not come back over it either, and that is
 *   enforced rather than asked for: the daemon takes the clipboard capability
 *   out of the connection as it is negotiated. Worth knowing if you embed this
 *   — whatever the person using the desktop copies, including a password, is
 *   not visible to anyone holding this URL.
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
  /**
   * The pinned `namespace/name@version`, when the platform sent one.
   *
   * Absent only from a host too old to advertise refs. It matters more than it
   * looks: since OPL-3789 a template an account PUBLISHED is named by its ref
   * and by nothing else — the short `name` still resolves to the platform's own
   * catalogue — so a listing without this cannot tell a caller how to launch
   * their own template. `publicTemplate` in the platform's lib/projection
   * publishes it for exactly that reason, and this model was dropping it.
   */
  ref?: string;
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
    ...(d.ref == null ? {} : { ref: str(d.ref) }),
    label: str(d.label),
    os: str(d.os),
    cpu: num(d.cpu),
    ramMb: num(d.ram_mb),
    diskGb: num(d.disk_gb),
    raw: { ...d },
  };
}

/**
 * A template document this account published, from `POST` or `GET /templates/{ns}/{name}`.
 *
 * {@link Template} is what a LISTING answers — a name, a size, enough to launch
 * it. This is what a template IS, and the two are different shapes on purpose:
 * the listing has to stay small enough to render a picker from, and the document
 * carries build steps that can run to pages.
 */
export type PublishedTemplate = {
  /** `namespace/name@version`. What you pass as `template` to create a computer. */
  ref: string;
  /**
   * `sha256:…` of the document. Two publishes of the same digest are the same
   * template, which is what makes republishing an unchanged document a no-op
   * rather than a conflict.
   */
  docDigest: string;
  /**
   * The document itself, in its canonical form — the bytes {@link docDigest} is
   * over. Key order and whitespace may differ from what was sent; nothing else
   * does.
   */
  document: Record<string, unknown>;
  /** The catalogue row this document describes. */
  template: Template;
  /** Every version of this name, newest first. Read one with `version`. */
  versions: string[];
  /** Absent on a template the platform publishes — nobody published it. */
  publishedAt?: string;
  raw: Record<string, unknown>;
};

export function toPublishedTemplate(d: Record<string, unknown>): PublishedTemplate {
  const doc = d.document;
  const tpl = d.template;
  return {
    ref: str(d.ref),
    docDigest: str(d.doc_digest),
    document: isRecord(doc) ? { ...doc } : {},
    template: toTemplate(isRecord(tpl) ? tpl : {}),
    versions: Array.isArray(d.versions) ? d.versions.map((v) => str(v)) : [],
    // Absent stays absent rather than becoming '': a shipped template was not
    // published by anybody, and an empty timestamp reads as one that is known
    // and blank rather than one that does not apply.
    ...(d.published_at == null ? {} : { publishedAt: str(d.published_at) }),
    raw: { ...d },
  };
}

/**
 * What `POST /templates/validate` said about a document.
 *
 * Both outcomes are a 200 — an invalid document is an answer to the question,
 * not a failed request — so this never throws for {@link valid} being false.
 * That is the point of validating: {@link problems} lists EVERY problem at once,
 * where publishing reports the first thing that stops it.
 */
export type TemplateCheck = {
  valid: boolean;
  /** Every problem with the document, not just the first. Empty when valid. */
  problems: string[];
  /** The ref the document claims. Present only when it parsed far enough to have one. */
  ref?: string;
  /** `sha256:…` of the whole document. Changes with any edit at all, a label included. */
  docDigest?: string;
  /**
   * `sha256:…` of only what decides the IMAGE.
   *
   * A new label or a version bump leaves it alone, so comparing it against a
   * previous run is how you tell whether an edit means a rebuild. Absent for a
   * document naming a parent in `spec.from`, which cannot be computed without
   * the parent's.
   */
  buildDigest?: string;
  raw: Record<string, unknown>;
};

export function toTemplateCheck(d: Record<string, unknown>): TemplateCheck {
  // The verdict is the whole answer, so it has to have been GIVEN. A decoder
  // turns an absent field into `false`, which here reads as "the platform
  // examined your document and rejected it" — a sentence nobody said. A
  // response that carries no verdict is drift, and drift that looks like a
  // rejection is worse than drift that says so (adversarial review, second
  // pass, OPL-3835).
  if (d.valid == null) {
    throw new MandalaError('expected a validation verdict to say whether the document is valid');
  }
  return {
    // TRUE ONLY. An unreadable verdict is not a verdict, and this is the field
    // whose whole job is to say whether a document is fit to publish — the one
    // direction a decoder must never guess in (OPL-3850).
    valid: said(d.valid),
    problems: Array.isArray(d.problems) ? d.problems.map((p) => str(p)) : [],
    ...(d.ref == null ? {} : { ref: str(d.ref) }),
    ...(d.doc_digest == null ? {} : { docDigest: str(d.doc_digest) }),
    ...(d.build_digest == null ? {} : { buildDigest: str(d.build_digest) }),
    raw: { ...d },
  };
}

/**
 * What a retire took away, from `DELETE /templates/{ns}/{name}`.
 *
 * Not a {@link PublishedTemplate} with a flag on it: the document is gone, so
 * there is nothing of that shape left to answer with.
 *
 * WHAT A RETIRE COSTS is worth knowing before calling it. It breaks RESOLUTION
 * and nothing else — a computer is built from the image the ref resolved to and
 * holds no reference to the document, so anything already running, stopped or
 * suspended is untouched. What it does not give back is the NAME: a retired ref
 * is refused for ever, identical bytes included, and {@link refsClaimed} does
 * not go down.
 */
export type RetiredTemplates = {
  /** The refs that were retired, newest version first. Never empty — an empty retire is a 404. */
  retired: string[];
  /** One value: everything in {@link retired} went in the same write. */
  retiredAt: string;
  /** The versions of this name still published, newest first. Empty means the name is gone. */
  versions: string[];
  /** How many templates the account holds now — the number the per-account ceiling is against. */
  templates: number;
  /**
   * How many refs this account has ever claimed, live and retired together.
   *
   * It does NOT go down when you retire, and there is a much larger ceiling on
   * it than on {@link templates}. The two move differently, and somebody
   * watching only the first would conclude that retiring is free.
   */
  refsClaimed: number;
  raw: Record<string, unknown>;
};

export function toRetiredTemplates(d: Record<string, unknown>): RetiredTemplates {
  return {
    retired: Array.isArray(d.retired) ? d.retired.map((r) => str(r)) : [],
    retiredAt: str(d.retired_at),
    versions: Array.isArray(d.versions) ? d.versions.map((v) => str(v)) : [],
    templates: num(d.templates),
    refsClaimed: num(d.refs_claimed),
    raw: { ...d },
  };
}

/**
 * A template build (platform OPL-3791) — compiling a document into an image.
 *
 * Not to be confused with a computer's disk copy, which the platform also calls
 * a build. This one is minutes long: `POST /builds` answers immediately with a
 * job, and {@link Builds.wait} is what watches it.
 */
export type TemplateBuild = {
  /** `bld-a1b2c3d4e5f6`-shaped. */
  id: string;
  /** The document this was built from, as `namespace/name@version`. */
  ref: string;
  /** `running`, `succeeded` or `failed`. */
  status: string;
  /** Why it failed, when it did. For a failing `run:` step, the end of that step's own output. */
  error: string;
  startedAt: string;
  /** Absent while it is still running. */
  finishedAt?: string;
  raw: Record<string, unknown>;
};

/**
 * A build's own id, refused when the record does not carry one.
 *
 * The tier this surface was missing. `.filter(isRecord)` drops an element that
 * is not a record at all — deliberately, and http.test.ts pins it — but a
 * record whose required identity is absent is the OTHER case, and the SDK
 * already had an answer for it: `computerRecord` throws a named,
 * route-specific error rather than letting an empty id reach a path builder and
 * fail somewhere else entirely.
 *
 * The build decoders coerced instead, so `toTemplateBuild({})` answered a
 * well-formed build with an empty id, and `builds.list` turned schema drift
 * into a shorter inventory that looked complete (adversarial review,
 * OPL-3835). Every build record the live platform sends carries `id`; this only
 * fires on one that does not.
 */
const buildId = (d: Record<string, unknown>, what: string): string => {
  const id = str(d.id);
  if (!id) throw new MandalaError(`expected ${what} to carry an id`);
  return id;
};

export function toTemplateBuild(d: Record<string, unknown>): TemplateBuild {
  return {
    id: buildId(d, 'a build'),
    ref: str(d.ref),
    status: str(d.status),
    error: str(d.error),
    startedAt: str(d.started_at),
    ...(d.finished_at == null ? {} : { finishedAt: str(d.finished_at) }),
    raw: { ...d },
  };
}

/** One step of a build, in the order the document declares them. */
export type BuildStep = {
  /** Its position, 1-based. */
  n: number;
  /** `apt`, `run`, `file`, `mkdir`, `env`, or `finish` for the cleanup every build ends with. */
  kind: string;
  /** What the step does, from the document — the packages, the path, or the first real line of the script. */
  label: string;
  /** `pending`, `running`, `done`, `failed`, or `skipped` for one an earlier failure meant we never reached. */
  status: string;
  startedAt?: string;
  finishedAt?: string;
  raw: Record<string, unknown>;
};

export function toBuildStep(d: Record<string, unknown>): BuildStep {
  return {
    n: num(d.n),
    kind: str(d.kind),
    label: str(d.label),
    status: str(d.status),
    ...(d.started_at == null ? {} : { startedAt: str(d.started_at) }),
    ...(d.finished_at == null ? {} : { finishedAt: str(d.finished_at) }),
    raw: { ...d },
  };
}

/**
 * What a build is DOING, as against what became of it (platform OPL-3794).
 *
 * A build is minutes long — most of them spent copying a multi-gigabyte base
 * image and then running the document's steps — so this says which step of how
 * many is running, and which one failed. It stays readable after the build has
 * finished, so a program that was not attached at the time can still see where
 * it stopped.
 */
export type BuildProgress = {
  id: string;
  /** The job's own status, restated so one poll answers both questions. */
  status: string;
  /**
   * Whether to stop polling.
   *
   * Derived from {@link status} and not from {@link phase}: a phase is read out
   * of the build's log, which the document's own `run:` steps write into, and
   * only the job decides whether a build worked.
   */
  done: boolean;
  /**
   * Where the build is in itself: `planning`, `staging`, `copying`, `building`,
   * `publishing`, and then `published`, `reused` or `failed`.
   *
   * `unknown` means the build finished without keeping a step-by-step record —
   * every build from before the endpoint existed is one. It is not reported as
   * `published` because a build that REUSED an existing image succeeds too, and
   * that distinction lived in the record that is missing. {@link status} is
   * still the answer.
   */
  phase: string;
  /** Which step is running, 1-based, or the one that failed. `0` before the first. */
  step: number;
  /** How many steps there are. */
  of: number;
  /** Every step, in order, whatever its status — so the whole list renders from the first read. */
  steps: BuildStep[];
  /** One line about the phase, or why a failed build failed. */
  note: string;
  /** Why it failed, when it did. The same value `GET /builds/{id}` gives. */
  error: string;
  /**
   * When the build last MOVED, and not when this was last read — a build whose
   * steps have stopped advancing is one whose `updatedAt` stops advancing.
   */
  updatedAt: string;
  /**
   * True only where the fleet could not recognise its own build tool's output,
   * so the per-step position is unavailable. The build itself is unaffected and
   * {@link status} is still the answer.
   */
  unmatched: boolean;
  raw: Record<string, unknown>;
};

/** The statuses a build stops on. `server/buildjob.go` declares exactly three. */
const BUILD_TERMINAL = ['succeeded', 'failed'];

/**
 * Whether the wire sent a status a build STOPS on.
 *
 * Reads the raw value, and requires a string. `str()` coerces, and in
 * JavaScript coercion is not a classifier: `String(['succeeded'])` is
 * `'succeeded'`, because an array of one joins to its element. So a status of
 * `["succeeded"]` — which is not a status at all — read as terminal, and with a
 * `done` of true it produced a settled build and no contradiction (adversarial
 * review, OPL-3835). Python is safe from this by accident of formatting:
 * `str(["succeeded"])` is `"['succeeded']"` and matches nothing. Accident is
 * not agreement, so this is explicit on both sides.
 */
const terminalStatus = (v: unknown): boolean => typeof v === 'string' && BUILD_TERMINAL.includes(v);

/**
 * Whether this progress record says the build has STOPPED.
 *
 * THE SAME RULE THE PYTHON SDK USES, and getting there took both. The two
 * clients shipped this surface hours apart, each had its own adversarial review,
 * and each review found a real defect the other did not:
 *
 * - This one caught the contradiction. `{id, done: true, status: "running"}`
 *   claims to be finished while its status says otherwise, and taking `done` at
 *   its word turns an active build into a settled one. Python trusted the flag.
 * - Python caught the omission. A recognised `done` is authoritative, but an
 *   ABSENT or null one is a host that said nothing, and the status answers for
 *   it. This one read that as `false` and polled a finished build to its
 *   deadline.
 *
 * Neither had both halves, so the same payload ended a wait in one client and
 * not the other. A recognised TRUE is terminal only against a terminal status;
 * a recognised FALSE is not terminal; anything else falls back to the status.
 */
export const isBuildTerminal = (p: BuildProgress): boolean => p.done;

/**
 * Why this record cannot be believed, or `null` if it can.
 *
 * Only one shape qualifies: a `done` the wire actually said was true, against a
 * status a build does not stop on. Absent, null and unreadable are NOT
 * contradictions — they are a host that said nothing, and `isBuildTerminal`
 * answers them from the status.
 */
export function buildContradiction(p: BuildProgress): string | null {
  if (wire(p.raw.done) !== WIRE.TRUE) return null;
  // The RAW status, for the reason `terminalStatus` gives: `p.status` has been
  // through `str()` and a coerced value cannot be trusted to classify.
  if (terminalStatus(p.raw.status)) return null;
  return (
    `build ${p.id || '?'} reports done with status ${JSON.stringify(p.status)}, which is ` +
    `not one a build stops on (${BUILD_TERMINAL.join(' or ')}). The record contradicts ` +
    `itself, so neither half of it can be trusted — read builds.progress for the outcome`
  );
}

export function toBuildProgress(d: Record<string, unknown>): BuildProgress {
  return {
    id: buildId(d, 'build progress'),
    status: str(d.status),
    // A recognised FALSE is not terminal; everything else — a recognised TRUE,
    // an absent, null or unreadable one — is answered by the status. That makes
    // a `done` of true against a running status read FALSE, and
    // `buildContradiction` reports it (OPL-3835).
    done: wire(d.done) === WIRE.FALSE ? false : terminalStatus(d.status),
    phase: str(d.phase),
    step: num(d.step),
    of: num(d.of),
    steps: Array.isArray(d.steps) ? d.steps.filter(isRecord).map(toBuildStep) : [],
    note: str(d.note),
    error: str(d.error),
    updatedAt: str(d.updated_at),
    // A caveat: it says the per-step position is unavailable, never that the
    // build is in trouble. Over-reporting it costs a caller the step counter.
    unmatched: caveat(d.unmatched),
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
    // TRUE only. A permission nobody granted is not granted, and the caller
    // reads this to decide whether to offer the row at all.
    allowed: said(d.allowed),
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
        // TRUE only: a line is not about a deleted computer unless it says so.
        gone: said(c.gone),
      })),
    },
    // Caveats on every figure above, and the reason this type tells callers to
    // read them first. An unreadable one leaves the totals unexplained, which is
    // the state these two exist to make impossible.
    degraded: caveat(d.degraded),
    unmetered: caveat(d.unmetered),
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

/**
 * Whether a snapshot ROW stands in for one nobody could read.
 *
 * The documented placeholder is an id and this flag and nothing more:
 * `computer_id` is absent because there was no host to say what the snapshot
 * belonged to, and `state` is what every real snapshot carries and no
 * placeholder does. Key PRESENCE decides both, not truthiness — a row carrying
 * `"computer_id": null` is a full row that failed to fill the field in, and
 * reading it as a stub admits it into every computer's filtered list.
 *
 * THE SHAPE IS REQUIRED WHATEVER THE FLAG SAYS. `unreachable` means opposite
 * things on the two rows it can appear on, and this is the reason a filtered
 * listing tests the row rather than the decoded flag: on a stub the flag is the
 * marker saying the listing is short, and dropping it reports a confident count
 * over an incomplete answer; on a FULL row belonging to another computer,
 * believing it hands somebody else's snapshots to a caller who filtered for
 * their own — from a listing often read just before an irreversible delete.
 * Applying the shape test only to the values this client cannot read left
 * exactly that hole one branch over (Codex review, OPL-3850), which is the same
 * hole the Python SDK's own review of this surface found.
 *
 * A tolerant test rather than an exact whitelist, for the reason Python gives:
 * `Object.keys(d)` against `{id, unreachable}` stops recognising a stub the
 * moment the platform adds a `created_at` or a `kind` to it, and filtering those
 * out drops precisely the markers saying an answer is short.
 */
/**
 * Whether a ROW off the wire belongs to the computer named.
 *
 * The raw field against the id, rather than the decoded `computerId`, for the
 * reason {@link terminalStatus} gives about a status: `str()` is a coercion and
 * a coercion cannot decide identity. `String(['vm-1'])` is `'vm-1'`, because an
 * array of one joins to its element — so a row whose `computer_id` arrived as
 * `["vm-1"]` matched a filter for `vm-1` and was handed to a caller who asked
 * for their own snapshots, on a listing usually read just before an
 * irreversible delete (Codex adversarial review, OPL-3850). Python is safe from
 * this by accident of formatting: `str(["vm-1"])` is `"['vm-1']"` and matches
 * nothing. Accident is not agreement, so this is explicit.
 *
 * Shared with `waitForMove`, which had the identical hole and did not get the
 * identical fix the first time: it picks this computer's row out of an
 * account-wide listing, so a malformed `computer_id` there returns somebody
 * else's move as this one's outcome — or polls it as this one's live move
 * (Codex review, third pass, OPL-3850). One invariant, one function.
 */
export const belongsToComputer = (d: Record<string, unknown>, id: string): boolean =>
  d.computer_id === id;

export const isUnreachableStub = (d: Record<string, unknown>): boolean => {
  if ('computer_id' in d) return false;
  const w = wire(d.unreachable);
  if (w === WIRE.FALSE || w === WIRE.ABSENT) return false;
  return !('state' in d);
};

/**
 * Whether a snapshot's `unreachable` FIELD should read true.
 *
 * Not the same question as {@link isUnreachableStub}, and deliberately so: a
 * flag the wire actually said was true is reported as given, whatever row it
 * came on, because the field's contract is that malformed input is preserved
 * rather than rejected. It is the FILTER that needs the row shape, because that
 * is where believing a full row costs a caller somebody else's snapshots.
 *
 * An unreadable or null flag is believed only on a row that could not be
 * anything but a placeholder — otherwise a caller told to check this before
 * believing anything else on the row stops believing valid data. Python's
 * reading, field for field.
 */
const snapshotUnreachable = (d: Record<string, unknown>): boolean => {
  const w = wire(d.unreachable);
  if (w === WIRE.TRUE) return true;
  return (w === WIRE.NULL || w === WIRE.MALFORMED) && isUnreachableStub(d);
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
    // TRUE only, all three. Each is a claim about how this snapshot came to be
    // or what is left of it, and none of them is safe to assert unasked:
    // `orphaned` in particular is what tells a caller a restore cannot work.
    incremental: said(d.incremental),
    auto: said(d.auto),
    // THE RAW state and kind, for the reason `terminalStatus` gives: `str()` is
    // a coercion and a coercion cannot classify. `String(['durable'])` is
    // `'durable'`, so a malformed row claimed its bytes were replicated to
    // backup storage — the field a caller reads before believing a snapshot
    // outlives the host holding it (Codex review, fourth pass, OPL-3850). The
    // coerced `state` and `kind` above are still what gets REPORTED; they are
    // not what gets decided on.
    durable: d.state === 'durable',
    memory: d.kind === 'memory',
    orphaned: said(d.orphaned),
    unreachable: snapshotUnreachable(d),
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

/** The move states a disk copy is still running in. */
const MOVE_LIVE = ['staging', 'moving', 'resizing'];

/**
 * Whether a move is still running, where the flag alone cannot say.
 *
 * Reads the RAW state and requires a string, for the reason
 * {@link terminalStatus} gives one route over: `String(['moving'])` is
 * `'moving'`, so a state that arrived as an array of one was classified as a
 * live move and `waitForMove` polled the garbage to its deadline (Codex
 * adversarial review, OPL-3850). The coerced `state` is fine to REPORT and not
 * to decide on — which is the distinction this file already draws for a build
 * status and did not draw here.
 */
const liveMove = (v: unknown, state: unknown): boolean => {
  const w = wire(v);
  if (w === WIRE.TRUE || w === WIRE.FALSE) return w === WIRE.TRUE;
  return typeof state === 'string' && MOVE_LIVE.includes(state);
};

export function toMove(d: Record<string, unknown>): Move {
  const state = str(d.state);
  return {
    computerId: str(d.computer_id),
    state,
    detail: str(d.detail),
    // `live` needs `state`, which is why this cannot be a decoder call on its
    // own. `waitForMove` returns the moment this is false, so reading an
    // unreadable or absent one as false ends the wait on a computer whose state
    // says `moving` and hands back a half-copied disk as a finished move;
    // reading it as true polls a FINISHED move to its deadline. Neither is
    // answerable without the other field, so only a value the wire actually gave
    // overrides the state — the Python SDK's reading, and its review found the
    // absent case the hard way.
    live: liveMove(d.live, d.state),
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
  // -1 when the platform did not send one this client can read, not 0: such a
  // response is not evidence the command succeeded, and `ok` must not affirm
  // what nobody said. Same reasoning as delete()'s undefined snapshot count.
  //
  // Through `count`, which is the only test that catches every way of not
  // sending one. Null and the empty string were checked by hand and the
  // coercible values were not, so `exit_code: []` decoded as a clean exit and
  // `ok` reported a command that never ran as successful (Codex review, third
  // pass, OPL-3850).
  const exitCode = count(d.exit_code) ?? -1;
  // Caveats, all three. `timed_out` reading false on a value nobody can read
  // makes `ok` affirm a command that never finished, and a truncation flag
  // reading false hands back the first 16 MiB of an answer with nothing saying
  // there was more — which is the whole reason these fields exist.
  const timedOut = caveat(d.timed_out);
  const outTruncated = caveat(d.out_truncated);
  const errTruncated = caveat(d.err_truncated);
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

/**
 * Whether a background command is still going.
 *
 * AFFIRMATIVE EVIDENCE TO STOP. `false` here is the claim that the command has
 * exited, and the README's loop breaks on it — so an absent, null or unreadable
 * flag must not make that claim on the platform's behalf.
 *
 * All three fall back to the EXIT CODE instead, which is what "running" means in
 * the first place. An unreadable flag was read as running outright at first, and
 * that is the one reading that can never end: `{running: "maybe", exit_code: 0}`
 * is a command that has plainly exited, reported as running forever, and the
 * loop in this package's README breaks on `running` and so never breaks (Codex
 * adversarial review, OPL-3850). With no exit code the fallback still answers
 * running, which is the property the first reading was reaching for — a poll is
 * not ended on a field nobody could read, abandoning a command with its output
 * still queued.
 */
const stillRunning = (d: Record<string, unknown>): boolean => {
  const w = wire(d.running);
  if (w === WIRE.TRUE) return true;
  if (w === WIRE.FALSE) return false;
  // A READABLE one. An exit code is the affirmative evidence standing in for the
  // flag here, and a value nobody can read is not evidence of anything — testing
  // only for absence let `{running: "maybe", exit_code: []}` end the poll and
  // report a clean exit, which is the fabricated success this whole branch is
  // about (Codex review, third pass, OPL-3850).
  return count(d.exit_code) === undefined;
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
    running: stillRunning(d),
    // Absent, null and the empty string are "did not send one" and read
    // `undefined`; a value present and unreadable — `"killed"`, `"signal:9"`, an
    // object, an array — gets toExecResult's -1, because something arrived and
    // it was not an exit code. Both through `count`, which is what tells the two
    // apart: `Number('')` and `Number([])` are both the 0 this must not invent.
    exitCode: d.exit_code == null || d.exit_code === '' ? undefined : (count(d.exit_code) ?? -1),
    stdout: str(d.stdout),
    stderr: str(d.stderr),
    // FALSE on anything unreadable, and this is the counter-example worth
    // keeping: `more` reads like a caveat and behaves like a SWITCH. The loop in
    // this package's README polls again with no sleep while it is set, so the
    // caveat reading — true when in doubt — turns a poll every second into a
    // poll as fast as the network allows, against a metered endpoint (OPL-3850).
    // Sleeping a second longer than necessary costs a caller nothing: `running`
    // ends that loop, not this, so no output is dropped by waiting.
    more: said(d.more),
    // A claim that something killed the command. Nobody said it.
    killed: said(d.killed),
    outTruncated: caveat(d.out_truncated),
    errTruncated: caveat(d.err_truncated),
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
    // TRUE only. Both are claims about one window against every other, and a
    // caller matching on them is picking which window to type into.
    focused: said(d.focused),
    minimized: said(d.minimized),
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
    // TRUE only: a schedule nobody said was on is off, and reporting one that
    // is not running is how a caller stops taking snapshots by hand.
    enabled: said(d.enabled),
    hour: num(d.hour),
    minute: num(d.minute),
    tz: str(d.tz, 'UTC'),
    raw: { ...d },
  };
}

/**
 * How long automatic snapshots are kept, as the plan grants it.
 *
 * A grandfather-father-son window rather than an age: what survives is the
 * newest automatic snapshot in each of the last `daily` days THAT HAVE ONE, the
 * last `weekly` such ISO weeks and the last `monthly` such calendar months.
 * Counting periods that contain a snapshot rather than periods on the calendar
 * is what stops a computer that was switched off for a month losing the history
 * it had — nothing ages out for the passage of time alone.
 *
 * Boundaries are cut in UTC, whatever `tz` the {@link Schedule} runs in. A
 * capture at 23:30 on a Sunday in `America/Chicago` is Monday in UTC and counts
 * toward the following ISO week.
 *
 * A zero turns that tier off. All three zero means the plan grants no retained
 * automatic history at all, which is what an account with no active
 * subscription reads.
 *
 * ONLY SNAPSHOTS WITH `auto` SET ARE TOUCHED. One taken by hand is yours until
 * you delete it, whatever this says.
 */
export type Retention = {
  daily: number;
  weekly: number;
  monthly: number;
  raw: Record<string, unknown>;
};

export function toRetention(d: Record<string, unknown>): Retention {
  return {
    daily: num(d.daily),
    weekly: num(d.weekly),
    monthly: num(d.monthly),
    raw: { ...d },
  };
}

/** Where the pointer is. */
export type Point = { x: number; y: number };
