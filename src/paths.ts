/**
 * Every path this SDK can reach, and every body it can send.
 *
 * Built in one place, for the reason mandala-computer-python builds them in one
 * place: the surface test pins what this SDK calls against the platform's
 * `V1_ROUTES` allowlist, and a URL assembled at a call site is a URL that test
 * cannot see. Anything absent from the allowlist is a 404 in a user's hands
 * rather than a failure here.
 *
 * The validation in this file is all of the same kind: mistakes that are
 * knowable without a round trip. The platform refuses every one of them too —
 * its refusals exist for callers who are not this SDK — but being told by the
 * server what could have been said locally is a round trip that never had to
 * happen.
 */

import { ValidationError } from './errors.js';
import type { Query } from './transport.js';

// --- paths ----------------------------------------------------------------

export const TEMPLATES = 'templates';
/** The JSON Schema for a `mandala/v1` document (platform OPL-3568). */
export const TEMPLATE_SCHEMA = 'templates/schema';
/** Check a document without publishing it. Side-effect free, and claims no ref. */
export const TEMPLATE_VALIDATE = 'templates/validate';
/**
 * Every build this account has started (platform OPL-3791).
 *
 * A collection, like {@link MOVES} and for the same reason: a build is a job
 * rather than a property of a computer, and it outlives the request that
 * started it.
 */
export const BUILDS = 'builds';
export const SIZES = 'sizes';
export const COMPUTERS = 'computers';
export const SNAPSHOTS = 'snapshots';
/**
 * Every move on the account, live and recently finished.
 *
 * A collection, and not `computers/:id/move` — which is the platform's own
 * decision and worth knowing when binding to it: a per-computer read could not
 * tell a computer with no move from an id that does not exist, so there is no
 * such route. {@link Computer.waitForMove} filters this by `computer_id`.
 */
export const MOVES = 'moves';
/** What the account has used, over a window. Account-scoped, like {@link MOVES}. */
export const USAGE = 'usage';
/**
 * How long automatic snapshots are kept — the plan's retention window.
 *
 * Account-scoped like {@link USAGE} and {@link MOVES}, and answered by the
 * control plane rather than by a hypervisor, so it cannot come back short the
 * way a fleet listing can. Read-only: the plan owns retention, and there is no
 * write on any surface.
 */
export const RETENTION = 'retention';
/**
 * The account's webhook subscriptions (platform OPL-4300).
 *
 * Account-scoped like {@link MOVES} and {@link USAGE}, and for the reason the
 * design gives: a subscription receives events from MANY computers, some of
 * which do not exist yet, so there is no computer for it to hang off. Answered
 * by the control plane from its own tables, never by a hypervisor.
 */
export const WEBHOOKS = 'webhooks';

/**
 * One id, in a path, refused when it is empty.
 *
 * The one empty string this file has to catch, because it is the one that does
 * not merely fail: `encodeURIComponent('')` is `''`, so an empty id does not
 * produce a path that 404s, it produces `computers/` — the *collection* route.
 * A get then decodes a list of computers as one computer and finds nothing in
 * it, and every other verb is aimed at a route that was never asked to answer
 * it. Nothing in either case says the id was missing.
 */
function pathId(id: string, what: string): string {
  // A PRIMITIVE string, checked before anything else. Every guard below compares
  // or encodes, and both let a boxed String through: `new String('..') === '..'`
  // is false, so the dot check misses, and `encodeURIComponent` then emits `..`
  // — the exact traversal this function exists to stop. These types are erased
  // at runtime and this package is called from JavaScript, so the annotation is
  // not the check (adversarial review, OPL-3835).
  if (typeof id !== 'string') {
    throw new ValidationError(`${what} must be a string (got ${typeof id})`);
  }
  if (!id) throw new ValidationError(`${what} must not be empty`);
  // URL parsers normalise both raw and percent-encoded dot segments before a
  // request is sent. Letting either through can therefore turn, for example,
  // `computers/..` into the API root instead of a computer route.
  if (id === '.' || id === '..') {
    throw new ValidationError(`${what} must not be ${JSON.stringify(id)}`);
  }
  // A lone surrogate is not UTF-8 and has no percent-encoding, so
  // `encodeURIComponent` throws a bare URIError reading `URI malformed` —
  // which names neither the argument nor the call it came from, and is not the
  // error type every other refusal on this surface is caught as. Named here so
  // it arrives as the same ValidationError a `..` does. A well-formed pair is
  // a single code point under the `u` flag and does not match.
  if (/\p{Surrogate}/u.test(id)) {
    throw new ValidationError(`${what} must be valid UTF-8 (got ${JSON.stringify(id)})`);
  }
  return encodeURIComponent(id);
}

/**
 * One number, refused when it is not finite.
 *
 * A NaN passes every range check written as a comparison — `NaN <= 0` and
 * `NaN > 30` are both false — and then `JSON.stringify` writes it as `null`,
 * which the platform reads as the field's zero value. The call succeeds, at the
 * wrong coordinate or for the wrong duration, and nothing says so: the failure
 * {@link wholePoint} exists to prevent, arriving through a different door.
 */
function finite(v: number, what: string): number {
  if (!Number.isFinite(v)) {
    throw new ValidationError(`${what} must be a finite number (got ${v})`);
  }
  return v;
}

/** {@link finite}, for the coordinates and sizes a caller may legitimately omit. */
function finiteIf(v: number | undefined, what: string): void {
  if (v !== undefined) finite(v, what);
}

/**
 * A shape field, refused when it is not a positive integer.
 *
 * {@link finiteIf} only stops a NaN becoming JSON `null`. A negative or a
 * fraction is equally knowable without a round trip, and the same class of
 * mistake this file exists to name: `cpu: -1` is not a computer the platform
 * can build, and learning that from a 400 is a trip that never had to happen.
 */
function positiveIntIf(v: number | undefined, what: string): void {
  if (v === undefined) return;
  finite(v, what);
  if (!Number.isInteger(v) || v <= 0) {
    throw new ValidationError(`${what} must be a positive integer (got ${v})`);
  }
}

export const computer = (id: string): string => `computers/${pathId(id, 'computer id')}`;

/**
 * The sub-routes one computer answers on.
 *
 * A union rather than a `string`, and the same for the three action helpers
 * below. An id is interpolated through {@link pathId}; an action is
 * interpolated raw, because the set is closed and every one of them is a
 * literal written in this package. Naming that set is what makes it so — the
 * enumeration used to live in this comment, where nothing checked it, and it
 * had already fallen two behind the call sites.
 */
type ComputerAction =
  | 'start'
  | 'stop'
  | 'suspend'
  | 'restart'
  | 'clone'
  | 'move'
  | 'screenshot'
  | 'input'
  | 'clipboard'
  | 'exec'
  | 'windows'
  | 'files'
  | 'snapshots'
  | 'schedule'
  | 'agent';

export const computerAction = (id: string, action: ComputerAction): string =>
  `${computer(id)}/${action}`;

/**
 * A background command's guest pid (OPL-3584).
 *
 * Checked for the reason {@link pathId} checks an id: interpolated raw, a NaN
 * or a float builds `computers/vm-1/exec/NaN`, which is a 404 about a route
 * rather than a sentence about the pid that was wrong.
 */
export const execHandle = (id: string, pid: number): string => {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new ValidationError(`pid must be a positive integer (got ${pid})`);
  }
  return `${computer(id)}/exec/${pid}`;
};

/** One window on the desktop (OPL-3583). The id is `0x2600003`-shaped. */
export const windowPath = (id: string, windowId: string): string =>
  `${computer(id)}/windows/${pathId(windowId, 'window id')}`;

/**
 * One published template, by the two halves of its ref.
 *
 * Two segments and not one, because that is the shape of the route: the
 * platform reduces `templates/<a>/<b>` to `templates/:namespace/:name`, so a
 * ref handed over whole — `acc-1/devbox@1.0.0` — would be percent-encoded into
 * a single segment and reach a route that does not exist. The version is a
 * QUERY parameter on this path, not part of it; see {@link templateVersion}.
 */
export const templateRef = (namespace: string, name: string): string =>
  `${TEMPLATES}/${pathId(namespace, 'namespace')}/${pathId(name, 'template name')}`;

/**
 * The `version` query parameter, refused when it is not a version.
 *
 * The platform answers 400 for one that is empty or malformed rather than
 * defaulting, and that refusal exists because of a real defect: `?version=` —
 * which is what most clients serialise for an unset optional string — read as
 * "no version was named" and retired an entire template. This SDK cannot send
 * that: `undefined` omits the parameter, and anything else has to be a version.
 *
 * Checked here rather than left to the platform because the two answers are not
 * interchangeable on a retire. Omitting the parameter means EVERY version; a
 * caller who meant one version and passed an empty string would, without the
 * platform's refusal, have retired the lot.
 */
export function templateVersion(version: string | undefined): Query {
  if (version === undefined) return {};
  // A PRIMITIVE string, and the validated value is what goes on. Validating a
  // value and then returning the ORIGINAL is a hole wherever coercion happens
  // twice: `RegExp.test` coerces, and so does the transport's
  // `searchParams.set(k, String(v))`. An object whose `toString()` answers
  // `1.2.3` and then `''` therefore passes this check and sends `?version=` —
  // which on a retire is the whole-name, irreversible branch this function
  // exists to make unreachable (adversarial review, OPL-3835).
  if (typeof version !== 'string') {
    throw new ValidationError(
      `version must be a string (got ${typeof version}). Omit it entirely to name the whole template.`,
    );
  }
  if (!/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.test(version)) {
    throw new ValidationError(
      `version must be MAJOR.MINOR.PATCH with no leading zeros (got ${JSON.stringify(version)}). ` +
        `Omit it entirely to name the whole template.`,
    );
  }
  // The checked primitive, not the argument. `${version}` is what makes that
  // true even if the argument was a boxed String that passed `typeof` — it
  // cannot, but the value that leaves here should not depend on that.
  return { version: `${version}` };
}

/**
 * The document a publish, a validate or a build sends.
 *
 * Raw bytes, not a JSON envelope: the platform reads JSON or YAML off the body
 * itself, so a wrapper would be a document the validator never sees. Refused
 * when empty for the reason {@link pathId} refuses an empty id — the platform
 * answers 400 for it, and that is a round trip that never had to happen.
 */
export function templateDocument(document: string): string {
  if (typeof document !== 'string' || !document.trim()) {
    throw new ValidationError('document must be a non-empty template document, as JSON or YAML');
  }
  return document;
}

/**
 * A real `string`, refused rather than coerced.
 *
 * The companion to {@link flag}, for the same class of reason. Every builder
 * below reads a string and then trims, concatenates or encodes it: a non-string
 * reaching one of those is a `TypeError` thrown from inside this SDK that names
 * neither the argument nor the call, or — worse — a `String()` coercion that
 * sends `"[object Object]"` to the platform as if somebody had typed it.
 */
function requireString(v: unknown, what: string): string {
  if (typeof v !== 'string') {
    throw new ValidationError(`${what} must be a string, not ${v === null ? 'null' : typeof v}`);
  }
  return v;
}

/**
 * One optional boolean option, refused when it is not a boolean.
 *
 * Truthiness is the wrong test for every flag on this surface, and the reason
 * is that the annotation is erased: this package is called from JavaScript and
 * through `any`, so `"false"`, `0`, `1` and `new Boolean(false)` all arrive.
 * Three of those four are TRUTHY. `new Boolean(false)` is an object; the string
 * `"false"` is non-empty; `1` is 1. So `opts.flag ? on : off` reads three
 * different ways of writing "no" as "yes", and does it silently.
 *
 * Named `what` after the CALLER'S spelling — `allowPartial`, not
 * `allow_partial` — because the message is read by whoever typed it.
 *
 * Undefined stays undefined: every one of these is genuinely optional, and
 * "omitted" is a third state that the parameters below map to their own
 * defaults (adversarial review and the sweep it prompted, OPL-3835).
 */
export function flag(v: boolean | undefined, what: string): boolean | undefined {
  if (v === undefined) return undefined;
  // A PRIMITIVE boolean. `typeof new Boolean(false)` is `'object'`.
  if (typeof v !== 'boolean') {
    throw new ValidationError(`${what} must be a boolean (got ${typeof v})`);
  }
  return v;
}

/**
 * The `no_reuse` query parameter, refused when it is not a boolean.
 *
 * lib/apidoc gives this parameter `enum: ['true']` and server/buildjob.go
 * compares it to `"true"`, so `true` is the only value that means anything and
 * `false` is omitted rather than sent.
 *
 * Getting it wrong is expensive rather than merely wrong: `no_reuse=true` skips
 * the image an identical document already built, so it spends minutes copying a
 * multi-gigabyte base image again and takes another build out of the account's
 * daily allowance — to reach the same image reuse would have handed back for
 * free. Measured on the live platform at 14.2s against 0.3s. That is the
 * opposite of what a caller passing `"false"` was asking for (adversarial
 * review, OPL-3835).
 */
export function noReuse(v: boolean | undefined): Query {
  return flag(v, 'noReuse') ? { no_reuse: 'true' } : {};
}

export const build = (id: string): string => `${BUILDS}/${pathId(id, 'build id')}`;
export const webhook = (id: string): string => `${WEBHOOKS}/${pathId(id, 'webhook id')}`;
export const webhookAction = (id: string, action: 'rotate' | 'test' | 'deliveries'): string =>
  `${webhook(id)}/${action}`;

export const buildAction = (id: string, action: 'progress' | 'events'): string =>
  `${build(id)}/${action}`;

export const snapshot = (id: string): string => `snapshots/${pathId(id, 'snapshot id')}`;

export const snapshotAction = (id: string, action: 'restore' | 'clone'): string =>
  `${snapshot(id)}/${action}`;

export const CHAT_COMPLETIONS = 'chat/completions';

// --- responses ------------------------------------------------------------

/**
 * Flatten a response that is one computer, in either shape it can arrive in.
 *
 * A create whose guest was made and then would not boot answers 201 with
 * `{ computer: {...}, start_error: "..." }` rather than an error alone —
 * deliberately, so the caller learns the id of the machine it is now paying for
 * instead of having to list to find it.
 *
 * Read as an ordinary computer, that envelope is a computer with no id: every
 * field reads off the wrapper, finds nothing, and the id the platform went out
 * of its way to return is the one thing dropped. So it is unwrapped here, and
 * the failure travels on the record beside the fields it belongs to.
 *
 * Every response that is one computer goes through this, not just the create.
 * The envelope is the platform's shape for "here is your machine, and here is
 * what went wrong with it", and a second route answering that way should not
 * need a second discovery of this function.
 */
export function computerPayload(data: unknown): Record<string, unknown> {
  if (!isRecord(data)) return {};
  const inner = data.computer;
  if (!isRecord(inner)) return { ...data };
  // start_error kept alongside the fields rather than in a parallel return, so
  // it survives into `raw` and cannot be dropped by a caller that only wanted
  // the computer. A refresh replaces the record and clears it, which is right:
  // it describes one start attempt, not the machine. Only carried over when the
  // envelope actually had one — `raw` claims to be the response verbatim, and a
  // `start_error: undefined` key the platform never sent would not be.
  if ('start_error' in data) return { ...inner, start_error: data.start_error };
  return { ...inner };
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// --- bodies ---------------------------------------------------------------

type Json = Record<string, unknown>;

/**
 * Drop the keys a caller did not set, rather than sending them as null.
 *
 * Omission is meaningful on create: the platform applies the template's
 * defaults only where a key is absent, so an explicit null would override a
 * good default with nothing.
 */
export function omitUndefined(body: Json): Json {
  return Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
}

export type CreateArgs = {
  name?: string;
  /**
   * A named size from `client.sizes.list()` — a template and a CPU/RAM/disk
   * shape together. Cannot be combined with the four it stands in for.
   */
  size?: string;
  template?: string;
  cpu?: number;
  ramMb?: number;
  diskGb?: number;
  /** `WIDTHxHEIGHT` or `WIDTHxHEIGHTxDEPTH`. Create-time only. */
  resolution?: string;
  /** Boot it immediately. True by default. */
  start?: boolean;
};

/**
 * Build a create payload, omitting anything unset.
 *
 * A `size` names a template and a shape together, so combining it with any of
 * the four it stands in for is refused here.
 */
export function createBody(args: CreateArgs): Json {
  const { size, template, cpu, ramMb, diskGb, name, resolution } = args;
  // Defaulted after validation, not by destructuring: `start = true` fills in
  // only for `undefined`, so a `"false"` kept its own shape and went onto the
  // wire as a string where the platform expects a boolean.
  const start = flag(args.start, 'start') ?? true;
  if (size !== undefined && [template, cpu, ramMb, diskGb].some((v) => v !== undefined)) {
    throw new ValidationError(
      'size already names a template and a shape; send size alone, ' +
        'or template/cpu/ramMb/diskGb without it',
    );
  }
  // A NaN here goes out as JSON `null`, which the platform reads as the field's
  // zero value: a computer built with no CPU, or — worse, on update — an idle
  // window of "follow the host" that nobody asked for. The same failure
  // {@link finite} catches on a coordinate, arriving through the create.
  positiveIntIf(cpu, 'cpu');
  positiveIntIf(ramMb, 'ramMb');
  positiveIntIf(diskGb, 'diskGb');
  if (name !== undefined && !requireString(name, 'name').trim()) {
    throw new ValidationError('name must not be empty');
  }
  // The other three strings on this body, checked for the reason `name` is.
  // They are not trimmed, so a non-string does not throw here — it passes
  // through `omitUndefined` into `JSON.stringify` and reaches the platform as
  // a JSON object where a size was meant. A 400 naming a field the caller did
  // not knowingly send is a worse answer than a refusal naming the argument
  // they did (OPL-4215).
  if (size !== undefined) requireString(size, 'size');
  if (template !== undefined) requireString(template, 'template');
  if (resolution !== undefined) requireString(resolution, 'resolution');
  return {
    ...omitUndefined({
      name,
      size,
      template,
      cpu,
      ram_mb: ramMb,
      disk_gb: diskGb,
      resolution,
    }),
    start,
  };
}

export type UpdateArgs = {
  name?: string;
  /** Needs the computer stopped. */
  cpu?: number;
  /** Needs the computer stopped. */
  ramMb?: number;
  /** Needs the computer stopped. Disks grow only. */
  diskGb?: number;
  /**
   * Minutes untouched before the host suspends this computer.
   *
   * `null` follows the host's own window. Meaningful, so it survives the
   * undefined filter — which is why this is `number | null` and absent means
   * "leave it alone", rather than null doing both jobs.
   */
  idleSuspendMin?: number | null;
};

/**
 * What a move is asked for: the same sizing group a resize takes, minus the two
 * fields a move cannot deliver.
 *
 * `ramMb` is REQUIRED here and optional on {@link UpdateArgs}, and that is the
 * one difference worth explaining. A move exists to escape a RAM ceiling: the
 * platform fills an omitted `ram_mb` from the computer's current size and then
 * refuses the move for not needing one, so a call without it can only ever be
 * refused. Requiring it turns a guaranteed 409 into a type error.
 *
 * There is no `name` and no `idleSuspendMin`. The platform reads only these
 * three off a move body and silently ignores the rest, so accepting either here
 * would be a rename that copies a multi-gigabyte disk between hosts and then
 * does not happen.
 */
export type MoveArgs = {
  /** The size that did not fit. Must be MORE than the computer has now. */
  ramMb: number;
  /** Applied with the move. Omit to leave the count alone. */
  cpu?: number;
  /** Applied with the move, on the far side. Disks grow only. */
  diskGb?: number;
};

/** The body for `POST computers/:id/move`, validated like a resize. */
export function moveBody(args: MoveArgs): Json {
  positiveIntIf(args.cpu, 'cpu');
  positiveIntIf(args.ramMb, 'ramMb');
  positiveIntIf(args.diskGb, 'diskGb');
  // Not optional, so an omission is caught here rather than as a refusal from
  // the platform three tiers away. positiveIntIf passes on undefined by design —
  // it is the check for a field that MAY be absent — so absence needs its own
  // line, and this is the one body on this surface with a required number in it.
  if (args.ramMb === undefined) {
    throw new ValidationError(
      'ramMb is required: a move exists to reach a size this host cannot run',
    );
  }
  return omitUndefined({ cpu: args.cpu, ram_mb: args.ramMb, disk_gb: args.diskGb });
}

/**
 * Build a PATCH payload.
 *
 * The platform refuses a rename combined with a resize on purpose — a resize
 * needs the computer stopped and a rename does not, so one request cannot
 * honour both without applying half of it. That refusal is left to the server:
 * unlike the create/size clash it depends on the computer's current state,
 * which this function does not have.
 *
 * An empty patch is refused here. It can only mean a caller built the arguments
 * from something that turned out to be empty, and the platform's answer to it
 * is a 400 that reads as though the request was malformed.
 */
export function updateBody(args: UpdateArgs): Json {
  positiveIntIf(args.cpu, 'cpu');
  positiveIntIf(args.ramMb, 'ramMb');
  positiveIntIf(args.diskGb, 'diskGb');
  // Null is the documented "follow the host's own window". A NaN is serialized
  // as the same null and would mean it by accident, on the one field here where
  // the wrong value is silently a legitimate request. A fraction or a negative
  // is the same class of mistake as a bad cpu: knowable here, and not a window.
  if (args.idleSuspendMin != null) {
    const idle = finite(args.idleSuspendMin, 'idleSuspendMin');
    if (!Number.isInteger(idle) || idle < 0) {
      throw new ValidationError(`idleSuspendMin must be a non-negative integer (got ${idle})`);
    }
  }
  const body = omitUndefined({
    name: args.name,
    cpu: args.cpu,
    ram_mb: args.ramMb,
    disk_gb: args.diskGb,
    // Read off the object rather than destructured with a default, because
    // `null` is a value here and `undefined` is the absence.
    idle_suspend_min: args.idleSuspendMin,
  });
  if (args.name !== undefined && !requireString(args.name, 'name').trim()) {
    // On create an omitted name means "you pick one"; in an update an empty one
    // can only mean a caller cleared the field.
    throw new ValidationError('name must not be empty');
  }
  if (!Object.keys(body).length) {
    throw new ValidationError(
      'nothing to update: give at least one of name, cpu, ramMb, diskGb, idleSuspendMin',
    );
  }
  return body;
}

/**
 * The optional name on a clone or a capture.
 *
 * Omitted means "you pick one", which is a real request. An all-whitespace name
 * is not: it can only come from a caller building the name out of something
 * that turned out to be empty — {@link updateBody} and {@link snapshotBody}
 * both refuse one, and a route reached through here should not be the way to
 * get a computer called `"  "`.
 */
export const nameBody = (name?: string): Json => {
  if (name === undefined) return {};
  // Through {@link requireString}, the way {@link snapshotBody} reads the same
  // optional name. Trimming an unchecked value is a `TypeError` from inside
  // this SDK naming neither the argument nor the call, and a JavaScript
  // `clone({ signal })` is how one arrives (OPL-4215).
  if (!requireString(name, 'name').trim()) throw new ValidationError('name must not be empty');
  return { name };
};

export type ExecArgs = {
  command: string;
  /** Seconds to wait for it to exit. Ignored when `background` is set. */
  timeoutS?: number;
  /** Run in the logged-in desktop session — with DISPLAY, HOME, XAUTHORITY. */
  desktop?: boolean;
  /** Return a handle immediately instead of waiting. */
  background?: boolean;
  /** Absolute path to run in. */
  cwd?: string;
  /**
   * Environment variables for the command.
   *
   * On Linux, added on top of the guest's profile rather than replacing it. The
   * guest agent does replace the environment of the process it spawns, but a
   * Linux exec runs through `/bin/bash -lc`, which sources the profile and puts
   * `PATH` and the rest back before the command sees it.
   *
   * On Windows it *replaces*. The shell there is `cmd.exe /c`, which sources no
   * profile, so the command runs with these variables and nothing else — no
   * `PATH`, no `SystemRoot`, which is most of what `cmd.exe` needs to invoke
   * anything. Pass the variables that command depends on, or set them inside
   * `command` itself.
   */
  env?: Readonly<Record<string, string>>;
};

/**
 * The platform's bounds on an exec environment, mirrored from execbg.go.
 *
 * Mirrored rather than left to the server for this file's usual reason: they
 * are refusals knowable without a round trip. Neither is a limit anybody
 * legitimately meets, so a request that meets one is a caller passing something
 * other than what they think — `process.env` in full, most likely — and the
 * sooner it says so the better.
 */
export const MAX_ENV_ENTRIES = 64;
export const MAX_ENV_ENTRY_BYTES = 4096;

/** Bytes, not characters: the platform's limit is on the encoded entry. */
const utf8Length = (s: string): number => new TextEncoder().encode(s).length;

/**
 * What arrived instead of an env, for the message that refuses it.
 *
 * `typeof` on its own answers `'object'` for a Map, a Date and a class instance
 * alike, and "must be an object, not object" is a refusal that reads as a bug
 * in the SDK rather than as an answer. The constructor's name is the word the
 * caller will recognise as the thing they passed.
 *
 * `null` is named before the `typeof` line rather than left to it, because it
 * is the one value that would reach the constructor lookup and dereference
 * nothing: `Array.isArray(null)` is false and `typeof null` is `'object'`, so
 * the refusal would leave as a TypeError from inside the SDK instead of as the
 * ValidationError every other shape gets. {@link execBody} does read `null` and
 * `undefined` alike as "no env" and never calls {@link envObject} with either —
 * but that makes this function's safety a property of a different function, and
 * a helper that only holds because of where it happens to be called from is one
 * caller away from not holding. Exported for the same reason: that branch is
 * unreachable through {@link execBody}, so the only test that can hold this
 * function to its own contract is one that calls it. Module-internal — nothing
 * here is re-exported from `index.ts`, which is the published surface.
 */
export function envShape(env: unknown): string {
  if (env === null) return 'null';
  if (Array.isArray(env)) return 'an array';
  if (typeof env !== 'object') return typeof env;
  const name = (env as { constructor?: { name?: string } }).constructor?.name;
  if (!name) return 'an object with an unrecognised prototype';
  return `${/^[AEIOU]/.test(name) ? 'an' : 'a'} ${name}`;
}

/**
 * Check an exec environment, and hand back a copy.
 *
 * The two character refusals are the ones that would otherwise not fail. The
 * guest agent takes the environment as a `KEY=value` list, so a `=` inside a
 * name makes the entry split at the wrong place and mean something other than
 * what it says; a NUL ends a C string, so anything after one in either half is
 * dropped by the agent rather than refused. Both produce a command that runs
 * with an environment nobody asked for and reports success.
 *
 * A copy because the body is built once and sent later: a caller that mutates
 * the object it passed would otherwise change what goes on the wire after the
 * checks below have already passed over it.
 */
function envObject(env: Readonly<Record<string, string>>): Json {
  // The shape is checked before the entries because a string passes every
  // entry check that follows: `Object.keys('FOO=bar')` is `'0'..'6'`, each
  // value is a one-character string, and the `=` lands in a value where the
  // name check cannot see it — so `env: 'FOO=bar'` reaches the guest as seven
  // variables named after array indices, which is the one failure this
  // function's whole purpose is to make impossible.
  //
  // A PLAIN object, not merely something `typeof` calls one. `Object.keys`
  // answers `[]` for a Map, a Date and a class instance alike, and a check that
  // only asked for an object would let all three past into an empty `{ ...env }`
  // — so `env: new Map([['FOO', 'bar']])`, which is an ordinary mistake to make
  // about a key/value bag, would run the command in the guest with none of the
  // variables it asked for and report success. That is the same silent drop as
  // the string above, arrived at from the other side.
  //
  // A null prototype is accepted beside `Object.prototype` because
  // `Object.create(null)` is a deliberate way of building exactly this bag. A
  // literal from another realm is refused with the rest: that is this rule's
  // one cost, and holding an env built inside a `vm` context is a far stranger
  // thing to be doing than holding a Map.
  const proto: unknown = isRecord(env) ? Object.getPrototypeOf(env) : undefined;
  if (!isRecord(env) || (proto !== null && proto !== Object.prototype)) {
    throw new ValidationError(`env must be an object of NAME to value, not ${envShape(env)}`);
  }
  const names = Object.keys(env);
  if (names.length > MAX_ENV_ENTRIES) {
    throw new ValidationError(
      `env has ${names.length} entries; the platform accepts at most ${MAX_ENV_ENTRIES}`,
    );
  }
  for (const name of names) {
    if (!name) throw new ValidationError('env has an entry with an empty name');
    if (name.includes('=') || name.includes('\0')) {
      throw new ValidationError(`env name ${JSON.stringify(name)} must not contain '=' or a NUL`);
    }
    // Checked rather than cast, because the cast is a lie on the one input the
    // comment above anticipates: `{ TOKEN: process.env.TOKEN }` with the
    // variable unset hands this an `undefined`, and every JS caller can hand it
    // anything at all. Without this the next line throws a bare "Cannot read
    // properties of undefined", which names neither the parameter nor the key —
    // the only refusal on this surface that would not say what was wrong.
    const value: unknown = env[name];
    if (typeof value !== 'string') {
      throw new ValidationError(
        `env value for ${JSON.stringify(name)} must be a string, not ${value === null ? 'null' : typeof value}`,
      );
    }
    if (value.includes('\0')) {
      throw new ValidationError(`env value for ${JSON.stringify(name)} must not contain a NUL`);
    }
    const bytes = utf8Length(name) + utf8Length(value) + 1;
    if (bytes > MAX_ENV_ENTRY_BYTES) {
      throw new ValidationError(
        `env entry ${JSON.stringify(name)} is ${bytes} bytes; the platform accepts ` +
          `at most ${MAX_ENV_ENTRY_BYTES}`,
      );
    }
  }
  return { ...env };
}

/**
 * Build an exec payload.
 *
 * `session` is omitted rather than sent empty when `desktop` is false: the
 * platform's default is the system context, and `"desktop"` is the only other
 * value it accepts.
 */
export function execBody(args: ExecArgs): Json {
  if (typeof args.command !== 'string' || !args.command.trim()) {
    throw new ValidationError('command must not be empty');
  }
  const body: Json = { command: args.command };
  // Checked here rather than left to the transport's own finiteness guard: that
  // one is on the request deadline, and a client whose deadline is disabled
  // never reaches it — so on exactly that client a NaN timeout would sail
  // through as a `null` the guest reads as no timeout at all.
  if (args.timeoutS !== undefined) {
    // Negative refused as well as non-finite, the way every other duration on
    // this surface is: a -1 is a caller's "no timeout" idiom from some other
    // API, and the guest agent reads it as a deadline already past.
    if (finite(args.timeoutS, 'timeoutS') <= 0) {
      throw new ValidationError(`timeoutS must be positive (got ${args.timeoutS})`);
    }
    body.timeout_s = args.timeoutS;
  }
  // `background` decides whether this call ANSWERS with the command's output or
  // with a pid, and `desktop` decides which session it runs in. Both change what
  // the caller gets back, so neither is read by truthiness.
  if (flag(args.desktop, 'desktop')) body.session = 'desktop';
  if (flag(args.background, 'background')) body.background = true;
  if (args.cwd !== undefined) body.cwd = absoluteGuestPath(args.cwd, 'cwd');
  // An empty object is omitted rather than sent: the platform reads no `env`
  // and an empty one the same way, and sending it puts a key on the wire that
  // says a caller asked for something they did not. Emptiness is judged AFTER
  // envObject rather than by a key count here, because `Object.keys` answers
  // an empty list for a number as readily as for `{}` — so a gate written this
  // way round drops `env: 5` on the floor instead of naming it.
  if (args.env !== undefined && args.env !== null) {
    const env = envObject(args.env);
    if (Object.keys(env).length) body.env = env;
  }
  return body;
}

/**
 * The shell command that puts a URL on the guest's screen.
 *
 * The browser is named rather than asked for: Firefox, not `xdg-open` or one of
 * the other portable wrappers. Naming it keeps the choice in one place — this
 * function is the only thing that decides which browser the guest opens, so a
 * change of image, or of which browser we want, is a change here rather than in
 * every caller.
 *
 * Detached, because a browser does not exit on its own: in the foreground the
 * call would block until the timeout killed it and come back as a failure,
 * having opened the window anyway.
 */
export function openUrlCommand(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) throw new ValidationError('url must not be empty');
  // Quoting stops the URL reaching the shell as anything but one argument. It
  // cannot stop the browser reading a leading dash as a flag, and no URL starts
  // with one, so that is refused outright rather than quoted.
  if (trimmed.startsWith('-')) throw new ValidationError(`url must not start with '-': ${trimmed}`);
  return `nohup firefox ${shellQuote(trimmed)} >/dev/null 2>&1 &`;
}

/** POSIX single-quoting: the only characters that survive are the ones inside. */
export function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/**
 * The most a guest path may be, in BYTES of UTF-8 rather than characters.
 *
 * The platform's own bound: `server/guestfile.go` refuses a path longer than
 * `guestPathMax` before it ever reaches the guest agent, and Go counts the
 * bytes of the string rather than its runes. Mirrored here for the reason every
 * other cap in this file is — it is a refusal knowable without a round trip —
 * and deliberately NOT the tighter 256 the event stream applies to a watch,
 * which is that route's own limit and would turn away paths the file routes
 * accept.
 */
const MAX_GUEST_PATH_BYTES = 4096;

/**
 * The three things a path must not be, whatever it is a path FOR.
 *
 * Shared by the file and exec routes here and by the event stream's watch
 * nominations, which is the same class of value going to the same guest through
 * two doors — one implementation, so the two doors cannot drift. The caps
 * differ and are the caller's to pass; the rules do not.
 *
 * A length in BYTES, because that is what the platform counts.
 *
 * Control characters are refused rather than escaped, which is the platform's
 * own reading: a path may hold them on Linux, but such a path is echoed into an
 * opening frame, an audit log, and whatever a person is shown, so a newline in
 * one is a caller choosing what somebody else's terminal renders. Nobody types
 * one by accident. By code point rather than by a character class, which the
 * linter refuses for the sound reason that a control character written into a
 * regex is usually a typo. This is the case it is not.
 *
 * A lone surrogate is not UTF-8, and it is the one bad path that would NOT be
 * refused by the platform: `encodeURIComponent` turns it into `%EF%BF%BD`, so
 * the host is handed a VALID path that is not the one the caller named — a
 * different file read, written or watched, with nothing anywhere saying so.
 */
export function checkPathText(path: string, what: string, maxBytes: number): void {
  if (utf8Length(path) > maxBytes) {
    throw new ValidationError(`${what} may be at most ${maxBytes} bytes: ${JSON.stringify(path)}`);
  }
  if ([...path].some((ch) => ch < ' ' || ch === '\u007f')) {
    throw new ValidationError(`${what} cannot contain control characters: ${JSON.stringify(path)}`);
  }
  if (/\p{Surrogate}/u.test(path)) {
    throw new ValidationError(`${what} must be valid UTF-8: ${JSON.stringify(path)}`);
  }
}

/** Validate any path that the platform interprets inside a Linux or Windows guest. */
function absoluteGuestPath(path: string, what: string): string {
  requireString(path, what);
  if (!path.startsWith('/') && !path.startsWith('\\\\') && !/^[A-Za-z]:[\\/]/.test(path)) {
    throw new ValidationError(`${what} must be absolute: ${JSON.stringify(path)}`);
  }
  // The same three refusals a watch nomination gets, because a path this SDK
  // sends to `files` or as an exec `cwd` is the same value going to the same
  // guest. The stream refused them and these routes did not, which made the
  // safest thing a caller could do with a path depend on which call they had
  // reached for.
  checkPathText(path, what, MAX_GUEST_PATH_BYTES);
  return path;
}

/**
 * The query naming which guest file, checked before the round trip.
 *
 * The path must be absolute: nothing about a transfer runs in a shell, so a
 * relative path has no working directory to be relative to. Absolute has three
 * spellings because there are two guest OSes — a `/`-rooted POSIX path, or on
 * a Windows guest a drive-letter path (`C:\...`, `C:/...`) or a `\\`-prefixed
 * one (a UNC share like `\\server\share\f.txt`, or the `\\?\` form). What
 * stays refused is the drive-relative `C:notes.txt` and anything rootless.
 */
export function filesQuery(path: string): Query {
  absoluteGuestPath(path, 'guest path');
  return { path };
}

/** One byte position or count, refused when it is not a whole number of bytes. */
function wholeBytes(v: number, what: string): number {
  if (!Number.isSafeInteger(v)) {
    throw new ValidationError(
      `${what} must be a whole number of bytes no larger than ${Number.MAX_SAFE_INTEGER} (got ${v})`,
    );
  }
  return v;
}

/**
 * A `Range` header for a window of a guest file, or nothing for the whole file.
 *
 * An `offset`/`length` pair rather than a header string, so the `bytes=`
 * spelling — and the fact that its `last-byte-pos` is inclusive, which is the
 * off-by-one everybody writes at least once — stays this file's problem.
 *
 * A **negative** offset is the tail: the last `-offset` bytes, and it takes no
 * length. That is not a shorthand for `total - N`, and the difference is the
 * one thing about ranges worth being careful with here. A window past what one
 * request moves is trimmed rather than refused, and which end gets trimmed
 * follows the end that was anchored — `bytes=N-` keeps its start, `bytes=-N`
 * keeps its **end**. So a tail longer than the ceiling comes back as the tail
 * of the file; the same request re-derived as an offset would come back as the
 * middle of it, with nothing to say so.
 */
export function rangeHeader(offset?: number, length?: number): string | undefined {
  if (offset === undefined && length === undefined) return undefined;
  if (offset !== undefined) wholeBytes(offset, 'offset');
  if (length !== undefined) wholeBytes(length, 'length');
  if (offset !== undefined && offset < 0) {
    if (length !== undefined) {
      throw new ValidationError(
        'a negative offset asks for the last bytes of the file and cannot also take a ' +
          `length (got offset ${offset}, length ${length})`,
      );
    }
    // `offset` carries its own minus, which is the whole of the suffix form.
    return `bytes=${offset}`;
  }
  const start = offset ?? 0;
  if (length === undefined) return `bytes=${start}-`;
  // A zero-length window names no byte, which is a 416 rather than an empty
  // answer — refused here so it is a stack trace at the call site instead.
  if (length < 1) {
    throw new ValidationError(`length must be at least one byte (got ${length})`);
  }
  // The sum rather than the last position, because the two differ by one and
  // only the sum overflows where it should: `MAX_SAFE_INTEGER + 2 - 1` is
  // evaluated left to right and lands back on a safe integer, so a window that
  // ran past the end of the number line would have been let through.
  wholeBytes(start + length, 'offset + length');
  return `bytes=${start}-${start + length - 1}`;
}

/** The `Range` header, or no headers at all — never a header set to nothing. */
export function rangeHeaders(offset?: number, length?: number): Record<string, string> | undefined {
  const range = rangeHeader(offset, length);
  return range === undefined ? undefined : { Range: range };
}

// --- the clipboard --------------------------------------------------------

/**
 * The most text `PUT /computers/{id}/clipboard` carries INTO a guest, in bytes.
 *
 * Mirrored rather than left to the server, like the env caps above and for the
 * same reason: it is a refusal knowable without a round trip. Unlike the routes
 * and parameters, it is NOT machine-checked — `scripts/check-surface.mjs` reads
 * the platform's `web/lib`, and this number lives in its `server/clipboard.go`
 * as `clipboardWriteMax`. The number is not arbitrary and is not ours — the
 * platform puts the text inside one argument of
 * one command, Linux caps a single argv string at 128 KiB, and two layers of
 * base64 stand between the text and that ceiling, so each byte costs about 1.8
 * of it. Past the cap `execve` fails with E2BIG, which is why the platform
 * refuses at 64 KiB rather than finding out.
 *
 * The READ cap is 128 KiB — a different bound, on a different channel — and it
 * is deliberately not mirrored: nothing here can meet it, since the text comes
 * from the guest.
 */
export const MAX_CLIPBOARD_BYTES = 64 * 1024;

/**
 * Build a clipboard payload.
 *
 * Refusals the platform also makes are mirrored here because a
 * round trip that can only fail is worth not making, and because the NUL one is
 * otherwise mystifying: the platform confirms a write by reading the
 * selection back through a command substitution, a shell truncates that at the
 * first NUL, and the write would therefore land and be reported as "the desktop
 * did not take the text" — a 409 inviting a retry at something that had already
 * worked, forever.
 */
export function clipboardBody(text: string): Json {
  if (typeof text !== 'string') {
    throw new ValidationError(
      `clipboard text must be a string, not ${text === null ? 'null' : typeof text}`,
    );
  }
  // Empty is refused rather than sent, which matches the platform: clearing the
  // clipboard is not what this endpoint does, and a caller who meant to clear it
  // should hear so rather than get a 400 back.
  if (!text) throw new ValidationError('clipboard text must not be empty');
  if (text.includes('\0')) {
    throw new ValidationError('clipboard text must not contain a NUL');
  }
  for (let i = 0; i < text.length; i++) {
    const codeUnit = text.charCodeAt(i);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++;
        continue;
      }
      throw new ValidationError('clipboard text must not contain an unpaired surrogate');
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new ValidationError('clipboard text must not contain an unpaired surrogate');
    }
  }
  const bytes = utf8Length(text);
  if (bytes > MAX_CLIPBOARD_BYTES) {
    throw new ValidationError(
      `clipboard text is ${bytes} bytes; the platform accepts at most ${MAX_CLIPBOARD_BYTES}`,
    );
  }
  return { text };
}

// --- input ----------------------------------------------------------------
//
// The verb set is Anthropic's computer tool, in full. The platform accepts both
// that vocabulary and this SDK's flatter one, so these bodies use whichever is
// unambiguous for each action — see the note on scroll, where the two genuinely
// differ in meaning. What matters is that every verb a computer-use model can
// emit has a method, because the alternative is every user of this SDK writing
// the same seven stubs.

export const MODIFIER_JOIN = '+';

export const pointerBody = (action: string, x: number, y: number): Json => ({
  action,
  x: finite(x, 'x'),
  y: finite(y, 'y'),
});

/**
 * Half a coordinate, refused rather than completed with a zero.
 *
 * A caller naming only `y` meant to name a point, and quietly filling `x` with
 * 0 sends the pointer to the edge of the screen while the call reports acting
 * where the pointer was. It succeeds, at the wrong place, and nothing says so.
 */
function wholePoint(x?: number, y?: number): void {
  if ((x === undefined) !== (y === undefined)) {
    throw new ValidationError('give both x and y, or neither — half a coordinate is not a point');
  }
  // For the same reason, one line down: a NaN coordinate is serialized as
  // `null` and read as 0, which is the same click at the corner of the screen
  // that half a point would have produced.
  finiteIf(x, 'x');
  finiteIf(y, 'y');
}

/**
 * A list of modifier names, refused when it is not a list.
 *
 * The guard on an options object reaching the `modifiers` slot. `click` takes
 * `(x, y, modifiers, opts)`, so a JavaScript caller writing the natural
 * `click(100, 200, { signal })` — every other input method on this surface
 * takes `CallOptions` last — bound the options object to `modifiers` instead.
 * Nothing then failed: `{ signal }.length` is `undefined`, so no `text` went on
 * the wire, the click was sent, and the only thing lost was the ability to
 * cancel it. A gesture that happens anyway is the shape of mistake nothing
 * reports (OPL-4215).
 *
 * Refused rather than peeled, for the reason `key()` gives about its own
 * trailing object: quietly accepting a second spelling is how two spellings
 * drift apart, and the message can name the one that works.
 */
function requireModifiers(v: unknown, what: string, spelling: string): void {
  if (!Array.isArray(v)) {
    throw new ValidationError(`${what} must be an array of key names — ${spelling}`);
  }
  for (const m of v) requireString(m, `${what} entry`);
}

/**
 * A click, optionally at a point and optionally with keys held down.
 *
 * No coordinate means "where the pointer already is", which is a real and
 * different request from clicking (0, 0) — the corner of the screen. So the
 * keys are omitted rather than sent as zeros; the platform carries that
 * distinction all the way down.
 */
export function clickBody(
  action: string,
  x?: number,
  y?: number,
  modifiers: readonly string[] = [],
): Json {
  // The spelling is the CALLER'S, not this builder's. Five click methods reach
  // here and `scroll` reaches it too, where the advice a click needs is not
  // merely unhelpful but impossible: `scroll` takes its modifiers as a named
  // option, so the positional slot the click message describes does not exist.
  requireModifiers(
    modifiers,
    `${action}() modifiers`,
    `to pass CallOptions give the modifiers first — ${action}(x, y, [], { signal })`,
  );
  wholePoint(x, y);
  const body: Json = { action };
  if (x !== undefined && y !== undefined) {
    body.x = x;
    body.y = y;
  }
  if (modifiers.length) body.text = modifiers.join(MODIFIER_JOIN);
  return body;
}

/**
 * A press, a move and a release — one gesture, not two clicks.
 *
 * The pointer passes through intermediate positions, which is what makes this a
 * drag: text selection, canvas tools and drag-and-drop all watch for the motion
 * between the ends.
 *
 * `start_coordinate` is omitted when the caller did not give one, which asks the
 * platform to drag from wherever the pointer is. It refuses that if nothing has
 * moved the pointer yet, rather than guessing at an origin.
 *
 * Half an origin is refused here rather than dropped: a drag naming only
 * `fromX` reads as a caller who meant to give a starting point, and silently
 * ignoring the half they gave produces a drag that succeeds while selecting a
 * different region — the worst shape a mistake can take, because nothing
 * reports it.
 */
export function dragBody(toX: number, toY: number, fromX?: number, fromY?: number): Json {
  if ((fromX === undefined) !== (fromY === undefined)) {
    throw new ValidationError('give both fromX and fromY, or neither');
  }
  finiteIf(fromX, 'fromX');
  finiteIf(fromY, 'fromY');
  const body: Json = {
    action: 'left_click_drag',
    coordinate: [finite(toX, 'toX'), finite(toY, 'toY')],
  };
  if (fromX !== undefined && fromY !== undefined) body.start_coordinate = [fromX, fromY];
  return body;
}

/** left_mouse_down / left_mouse_up, optionally moving first. */
export function buttonBody(action: string, x?: number, y?: number): Json {
  wholePoint(x, y);
  const body: Json = { action };
  if (x !== undefined && y !== undefined) {
    body.x = x;
    body.y = y;
  }
  return body;
}

export const SCROLL_DIRECTIONS = ['up', 'down', 'left', 'right'] as const;
export type ScrollDirection = (typeof SCROLL_DIRECTIONS)[number];

/**
 * A wheel scroll, optionally at a point and optionally with keys held.
 *
 * `coordinate` and not the flat pair, and that is not a style choice. The
 * platform reads a flat `x: 0, y: 0` on a scroll as "no position" — it has to,
 * because that is what the Python SDK sent for every defaulted scroll before
 * the coordinate keys became optional — so a caller who genuinely means the
 * top-left corner cannot say so that way. `coordinate` has no such history,
 * which makes `scroll(0, 0)` mean the corner again.
 */
export function scrollBody(args: {
  direction: ScrollDirection;
  amount: number;
  x?: number;
  y?: number;
  modifiers?: readonly string[];
}): Json {
  if (!SCROLL_DIRECTIONS.includes(args.direction)) {
    throw new ValidationError(`direction must be one of ${SCROLL_DIRECTIONS.join(', ')}`);
  }
  requireModifiers(
    args.modifiers ?? [],
    'scroll() modifiers',
    "they are already an option here — scroll(x, y, { modifiers: ['shift'], signal })",
  );
  wholePoint(args.x, args.y);
  const body: Json = {
    action: 'scroll',
    scroll_direction: args.direction,
    amount: finite(args.amount, 'amount'),
  };
  if (args.x !== undefined && args.y !== undefined) body.coordinate = [args.x, args.y];
  if (args.modifiers?.length) body.text = args.modifiers.join(MODIFIER_JOIN);
  return body;
}

export const typeBody = (text: string): Json => ({
  action: 'type',
  // Checked the way {@link clipboardBody} checks its own text, which is the
  // builder immediately beside this one: the two send a string to the same
  // guest and only one of them refused a non-string locally.
  text: requireString(text, 'type() text'),
});

/**
 * The chord itself, refused when it is not a list of key names.
 *
 * Two holes, both reached from JavaScript. A bare string is iterable, so
 * `holdKey('shift', 1)` spread into `['s','h','i','f','t']` — five keys held
 * down, none of them the one that was asked for, and no error anywhere. And an
 * empty entry copied straight through: `key(['ctrl', ''])` named a keystroke
 * that is not a key. Length was the only thing either builder checked
 * (OPL-4215).
 */
function requireKeys(keys: readonly string[], what: string): readonly string[] {
  if (!Array.isArray(keys)) {
    const bare = typeof (keys as unknown) === 'string';
    throw new ValidationError(
      `${what} takes an array of key names` +
        (bare ? ', not a bare string, which spreads into one key per character' : ''),
    );
  }
  if (!keys.length) throw new ValidationError(`${what} needs at least one key`);
  for (const k of keys) {
    if (!requireString(k, `${what} entry`).length) {
      throw new ValidationError(`${what} takes a key name in every position; one was empty`);
    }
  }
  return keys;
}

export function keyBody(keys: readonly string[]): Json {
  requireKeys(keys, 'key()');
  return { action: 'key', keys: [...keys] };
}

export function holdKeyBody(keys: readonly string[], seconds: number): Json {
  requireKeys(keys, 'holdKey()');
  finite(seconds, 'seconds');
  if (seconds <= 0) throw new ValidationError('seconds must be positive');
  // Same cap, and the same reason, as {@link waitBody}: a hold is a held HTTP
  // request crossing a reverse proxy. 100 seconds would not return, it would
  // fail — and the deadline computed from it would overflow Node's timer max
  // long before that and be refused as a timeout, which is the wrong name.
  if (seconds > 30) {
    throw new ValidationError(
      'the platform caps a held key at 30 seconds; call holdKey() again for longer',
    );
  }
  return { action: 'hold_key', keys: [...keys], duration: seconds };
}

/**
 * A pause inside the platform.
 *
 * Capped at 30 seconds by the platform, and asking for longer is refused rather
 * than truncated — a wait here is a held HTTP request crossing a reverse proxy,
 * and 100 seconds would not return, it would fail.
 */
export function waitBody(seconds: number): Json {
  // Before the range checks, which a NaN passes: both `<= 0` and `> 30` are
  // false for it, and the wait would go out as `duration: null` and be taken
  // for the platform's default.
  finite(seconds, 'seconds');
  if (seconds <= 0) throw new ValidationError('seconds must be positive');
  if (seconds > 30) {
    throw new ValidationError(
      'the platform caps a wait at 30 seconds; call wait() again for longer',
    );
  }
  return { action: 'wait', duration: seconds };
}

export const cursorBody = (): Json => ({ action: 'cursor_position' });

/**
 * `w` downscales, `fresh` skips the cache — and never both.
 *
 * A bare screenshot may be served from a cache up to 1.5 seconds old, which is
 * what makes N dashboard watchers cost one screendump — and what makes a drive
 * loop act on the screen as it was before its own last click. The model reads a
 * frame that predates the action, concludes the click missed, and clicks again;
 * that is how a dialog gets dismissed twice. So `fresh` is the flag to pass
 * whenever the image is feeding a decision rather than filling a thumbnail.
 *
 * `1` rather than `true` because the platform's screenshot handler accepts both
 * spellings and its own documentation names this one; every other flag on this
 * surface is a literal wire value too.
 */
export function screenshotQuery(width?: number, fresh?: boolean): Query | undefined {
  const query: Query = {};
  if (width !== undefined) {
    // 0 is refused rather than read as "no width": truthiness would silently
    // convert screenshot(0) — the natural result of a miscomputed thumbnail
    // scale — into a request for the full-resolution PNG, a different and more
    // expensive call, with nothing saying so.
    if (!Number.isFinite(width) || width <= 0) {
      throw new ValidationError(`width must be a positive number: ${width}`);
    }
    query.w = width;
  }
  if (flag(fresh, 'fresh')) {
    // Refused rather than sent, because the platform takes it and ignores it.
    // Its handler branches on `w` first and returns the thumbnail before it
    // ever reads `fresh` — and that thumbnail is built off the *cached* frame
    // and then cached a second time itself. So `{ w: 320, fresh: 1 }` is a
    // request the wire carries happily and the platform cannot honour, which
    // makes `screenshot(320, { fresh: true })` — the natural spelling, given
    // the signature — the one call that promises an uncached frame in capitals
    // and returns a doubly-cached one. That is exactly the shape this file
    // exists to refuse, so it is refused here rather than documented away.
    if (width !== undefined) {
      throw new ValidationError(
        'fresh cannot be combined with a width: the platform serves every downscaled ' +
          'screenshot from its cache, so the flag would be silently ignored. Drop the ' +
          'width to get an uncached frame.',
      );
    }
    query.fresh = 1;
  }
  // Undefined rather than an empty object for the bare call, so the URL this
  // builds is byte-for-byte the one it built before `fresh` existed.
  return Object.keys(query).length ? query : undefined;
}

/**
 * The query that pulls the power instead of asking the guest to shut down.
 *
 * `'true'` and not the boolean, which is not a style choice: the daemon reads
 * this with `Query().Get("force") == "true"`, so anything else — `1`, `yes`,
 * `TRUE` — is a graceful stop that reports success while the guest is still
 * being asked politely, which is the failure a caller reaching for `force`
 * already tried once.
 *
 * And validated rather than read for truthiness, like every flag here, for the
 * other half of the same reason: `force` pulls the power rather than asking the
 * guest to come down, so a `"false"` taken as true is an ungraceful stop of a
 * machine whose caller explicitly asked for the graceful one.
 */
export const stopQuery = (force?: boolean): Query =>
  flag(force, 'force') ? { force: 'true' } : {};

// --- usage ----------------------------------------------------------------

/**
 * An RFC 3339 timestamp WITH a time zone, which is the only kind the platform
 * takes.
 *
 * A `Date` is the shape to prefer and the reason this accepts one at all:
 * `toISOString()` is UTC by construction, so the whole class of mistake below
 * cannot be made. A string is accepted for the caller who already has one —
 * out of a config file, or off a previous response — and is checked here
 * because the mistake is knowable without a round trip.
 *
 * The mistake being: `2026-08-01T00:00:00` has no zone. The platform refuses it
 * rather than guessing, because the zone it would have to assume is the
 * server's and not yours — and a window silently shifted by a few hours is the
 * worst possible failure on the one call whose output somebody reconciles
 * against an invoice. A local-looking string is refused here so that the reason
 * arrives with the argument that caused it rather than as a 400 from a route.
 */
const RFC3339 = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/;

function usageStamp(v: Date | string, what: string): string {
  if (v instanceof Date) {
    if (!Number.isFinite(v.getTime())) throw new ValidationError(`${what} is an Invalid Date`);
    return v.toISOString();
  }
  if (!RFC3339.test(v)) {
    throw new ValidationError(
      `${what} must be an RFC 3339 timestamp with a time zone, e.g. 2026-08-01T00:00:00Z ` +
        `(or pass a Date): ${JSON.stringify(v)}`,
    );
  }
  return v;
}

/**
 * The window to ask about, or nothing for the account's current billing period.
 *
 * Undefined rather than an empty object when neither bound is given, so the
 * default call builds a bare URL — and, more to the point, so that "I did not
 * name a window" and "I named an empty one" cannot look the same on the wire.
 */
export function usageQuery(from?: Date | string, to?: Date | string): Query | undefined {
  const query: Query = {};
  if (from !== undefined) query.from = usageStamp(from, 'from');
  if (to !== undefined) query.to = usageStamp(to, 'to');
  return Object.keys(query).length ? query : undefined;
}

// --- windows --------------------------------------------------------------

export const WINDOW_ACTIONS = [
  'focus',
  'raise',
  'minimize',
  'maximize',
  'unmaximize',
  'close',
  'move',
  'resize',
] as const;
export type WindowAction = (typeof WINDOW_ACTIONS)[number];

/**
 * Every key {@link windowBody} will put on the wire.
 *
 * Named as a list rather than picked field by field because the builder spreads
 * its argument, so an unnamed key is a key the platform is asked to read. The
 * refusal that uses this also catches the one way an unnamed key arrives in
 * practice — a `CallOptions` bound to the `geometry` parameter — and can name
 * the spelling that works.
 */
const WINDOW_BODY_KEYS: readonly string[] = ['action', 'x', 'y', 'width', 'height'];

export function windowBody(args: {
  action: WindowAction;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}): Json {
  if (!WINDOW_ACTIONS.includes(args.action)) {
    throw new ValidationError(`action must be one of ${WINDOW_ACTIONS.join(', ')}`);
  }
  // Every key named, because the return spreads `args` onto the body. A
  // JavaScript `windowAction(id, 'close', { signal })` binds the options object
  // to the `geometry` parameter, and an unnamed key went to the platform as
  // part of the request while the signal it carried was dropped — a close that
  // could not be cancelled and said nothing about it (OPL-4215).
  for (const [key, value] of Object.entries(args)) {
    // An `undefined` value is not a key on the wire — the return below drops it
    // — so refusing one would refuse a correct request. A JavaScript caller
    // spreading a partially-filled geometry object is the same population this
    // guard is for, and it must not be the one it turns away.
    if (value !== undefined && !WINDOW_BODY_KEYS.includes(key)) {
      throw new ValidationError(
        `windowAction() geometry takes only ${WINDOW_BODY_KEYS.slice(1).join(', ')} (got ` +
          `${JSON.stringify(key)}); to pass CallOptions give the geometry first — ` +
          'windowAction(id, action, {}, { signal })',
      );
    }
  }
  // x and y stay on finiteIf because a negative one is ordinary: a second
  // monitor left of the primary puts its windows at a negative origin, and
  // refusing that would refuse a correct move. A size cannot be negative, or
  // zero, or a fraction — a window 0 pixels wide is not a window — so those
  // two take the same check every other shape field on this surface takes.
  finiteIf(args.x, 'x');
  finiteIf(args.y, 'y');
  positiveIntIf(args.width, 'width');
  positiveIntIf(args.height, 'height');
  return omitUndefined({ ...args });
}

// --- snapshots ------------------------------------------------------------

/**
 * Build a capture payload.
 *
 * `memory` is always sent, because false is a real request — a disk-only
 * capture — and not the absence of one. `name` is omitted when unset, which is
 * what asks the platform to generate one; sent empty it would be a name, and
 * the platform would take the caller at their word.
 *
 * An all-whitespace name is refused for the reason {@link updateBody} refuses
 * one: it can only come from a caller building the name out of something that
 * turned out to be empty, and a snapshot called `"  "` is not what they meant.
 *
 * `memory` captures live RAM as well as disk, which is a slower snapshot and a
 * much larger one. Taken raw and validated here rather than `Boolean(...)`d at
 * the call site: that coercion was the flag's whole check, and it read
 * `"false"` as yes.
 */
export function snapshotBody(memory: boolean | undefined, name?: string): Json {
  if (name !== undefined && !requireString(name, 'name').trim())
    throw new ValidationError('name must not be empty');
  return omitUndefined({ memory: flag(memory, 'memory') ?? false, name });
}

export function scheduleBody(args: {
  enabled: boolean;
  hour?: number;
  minute?: number;
  tz?: string;
}): Json {
  const { enabled, hour = 4, minute = 0, tz = 'UTC' } = args;
  // Through {@link requireString} like every other string this file sends. It
  // was the one field in this builder taken as given — `hour` and `minute` are
  // range-checked either side of it — so a JavaScript caller's object or number
  // was JSON-encoded onto the schedule rather than refused here, which is what
  // this file is for.
  requireString(tz, 'tz');
  // Through {@link flag} like every other boolean this file sends. Without it a
  // JavaScript caller's `"false"` — or a `new Boolean(false)`, which is an
  // object and therefore truthy — went on the wire verbatim and switched the
  // schedule ON while reading as though it had been turned off.
  const on = flag(enabled, 'enabled');
  if (on === undefined) {
    throw new ValidationError('enabled must be a boolean (got undefined)');
  }
  if (!Number.isInteger(hour) || hour < 0 || hour > 23)
    throw new ValidationError('hour must be 0-23');
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new ValidationError('minute must be 0-59');
  }
  return { enabled: on, hour, minute, tz };
}

/**
 * The query that destroys a computer's snapshots along with it.
 *
 * `expect` is the fingerprint from `computer.holdings()`, and the purge is
 * refused unless it still names the same set — so a capture that finished after
 * the caller looked cannot be swept up in a decision that was never about it.
 * The platform makes it optional, for callers that could not read the holdings.
 * This SDK can read them, so here it is required, and the refusal names the
 * method that produces one.
 *
 * Deliberately NOT fetched on the caller's behalf, which is the tempting
 * shortcut and the wrong one: a fingerprint read a millisecond before the
 * delete binds the purge to whatever the set is now, not to what anybody agreed
 * to — which is precisely the race the interlock exists for.
 */
export function deleteQuery(opts: { deleteSnapshots?: boolean; expect?: string }): Query {
  // The worst instance of the coercion class on this surface, and the reason
  // the sweep that missed it was not thorough enough: `deleteSnapshots:
  // "false"` is falsy to nobody and truthy to `!`, so a caller who wrote the
  // word FALSE — and who has a fingerprint to hand, because they pass one
  // every time — destroyed every snapshot the computer had. There is no
  // undoing that (adversarial review, second pass, OPL-3835).
  if (!flag(opts.deleteSnapshots, 'deleteSnapshots')) return {};
  if (!opts.expect) {
    throw new ValidationError(
      'refusing to purge snapshots without a fingerprint: call holdings() on this computer, ' +
        'check the count and size are what you meant to destroy, and pass its fingerprint as ' +
        '`expect`. Nothing has been deleted.',
    );
  }
  return { snapshots: 'delete', expect: opts.expect };
}

// --- agent ----------------------------------------------------------------

export function agentBody(args: {
  prompt: string;
  maxSteps?: number;
  system?: string;
  model?: string;
  stream: boolean;
}): Json {
  if (!requireString(args.prompt, 'prompt').trim()) {
    throw new ValidationError('prompt must not be empty');
  }
  // The other two strings on this body, checked for the reason `prompt` is.
  // They are not trimmed, so a non-string does not throw here — it passes
  // through `omitUndefined` into `JSON.stringify` and reaches the platform as
  // a JSON object where a prompt was meant. A 400 naming a field the caller
  // did not knowingly send is a worse answer than a refusal naming the
  // argument they did (OPL-4215, leftover on this builder).
  if (args.system !== undefined) requireString(args.system, 'system');
  if (args.model !== undefined) requireString(args.model, 'model');
  if (args.maxSteps !== undefined && (!Number.isInteger(args.maxSteps) || args.maxSteps < 1)) {
    throw new ValidationError(`maxSteps must be a positive integer (got ${args.maxSteps})`);
  }
  return omitUndefined({
    prompt: args.prompt,
    max_steps: args.maxSteps,
    system: args.system,
    model: args.model,
    stream: args.stream,
  });
}

// --- webhooks -------------------------------------------------------------

/**
 * What a subscription is created with.
 *
 * The filters are the platform's, in the platform's spelling: `events` is a
 * list of event types and `computers` a list of computer ids, and EMPTY OR
 * OMITTED MEANS EVERY ONE. The vocabulary is the socket's less `file.changed`
 * — a subscription has no tree to nominate — and an unknown type is a 400
 * that lists the ones there are, so it is left to the platform rather than
 * pinned here, where the list would go stale the first time it grew.
 */
export type WebhookCreateArgs = {
  /**
   * Where deliveries are POSTed. `https://` only, with no username or password
   * in it, resolving to a public address — a private, loopback or link-local
   * answer is refused, and so is a literal one. Any port.
   */
  url: string;
  /** Free text for your listing, up to 200 characters. */
  description?: string;
  /** Event types to deliver. Omit for every type. */
  events?: readonly string[];
  /** Computer ids to deliver for, up to 64. Omit for every computer in scope. */
  computers?: readonly string[];
  /** Start it disabled with `false`, to enable later. The platform defaults to `true`. */
  enabled?: boolean;
};

/**
 * What a PATCH may change. Every field optional and an omitted one left alone,
 * so a `url` alone is a redirect and an `enabled` alone is a switch.
 */
export type WebhookUpdateArgs = Partial<WebhookCreateArgs>;

/**
 * A delivery URL, refused for what the platform would refuse it for and this
 * SDK can see without a round trip: not a URL, not `https:`, or carrying a
 * username or password.
 *
 * The address check — that the hostname resolves somewhere public — is the
 * platform's, because the platform is what resolves it: an answer this SDK
 * got from the caller's resolver says nothing about the one the sender uses.
 *
 * Userinfo is refused rather than stripped for the reason the design gives:
 * the signature is the authentication, and a URL that carries a credential is
 * a caller expecting one to be sent, which it never will be.
 */
function webhookUrl(url: unknown): string {
  const text = requireString(url, 'url');
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new ValidationError(`url must be an absolute https:// URL (got ${JSON.stringify(text)})`);
  }
  if (parsed.protocol !== 'https:') {
    throw new ValidationError(`url must be https://, not ${parsed.protocol}//`);
  }
  if (parsed.username || parsed.password) {
    throw new ValidationError(
      'url must not carry a username or password: deliveries are authenticated by their signature',
    );
  }
  return text;
}

/**
 * One of the two id lists, refused when it is not a list of non-empty strings.
 *
 * The PLATFORM's spelling of "every one" is an empty list, and the platform
 * treats an omitted key the same way, so `[]` is passed through as itself
 * rather than dropped: on a PATCH the two differ — omitted leaves the filter
 * alone and `[]` clears it — and a builder that turned one into the other
 * would make a filter impossible to clear.
 */
function idList(v: unknown, what: string): string[] {
  if (!Array.isArray(v)) {
    throw new ValidationError(
      `${what} must be an array of strings, not ${v === null ? 'null' : typeof v}`,
    );
  }
  return v.map((item, i) => {
    if (typeof item !== 'string' || !item.trim()) {
      throw new ValidationError(`${what}[${i}] must be a non-empty string`);
    }
    return item;
  });
}

/** The most characters a subscription's description may hold — the platform's DESCRIPTION_MAX. */
export const WEBHOOK_DESCRIPTION_MAX = 200;
/**
 * The most computer ids one subscription may name — the platform's
 * COMPUTERS_MAX. A bound, not a design number: past it, filter at the receiver.
 */
export const WEBHOOK_COMPUTERS_MAX = 64;

/**
 * The optional fields the create and the update share, validated once.
 *
 * The two caps are the platform's own, measured the way it measures them —
 * `.length` on the string and on the list as given, before it de-duplicates —
 * so a body refused here is one it would have refused, and one it would accept
 * is never refused here. Knowable without the round trip, and named for the
 * argument rather than as a 400 three tiers away.
 */
function webhookFields(args: WebhookUpdateArgs): Json {
  if (args.description !== undefined) {
    if (requireString(args.description, 'description').length > WEBHOOK_DESCRIPTION_MAX) {
      throw new ValidationError(
        `description is at most ${WEBHOOK_DESCRIPTION_MAX} characters (got ${args.description.length})`,
      );
    }
  }
  const computers = args.computers === undefined ? undefined : idList(args.computers, 'computers');
  if (computers !== undefined && computers.length > WEBHOOK_COMPUTERS_MAX) {
    throw new ValidationError(
      `computers names at most ${WEBHOOK_COMPUTERS_MAX} computers (got ${computers.length}); filter at the receiver instead`,
    );
  }
  return omitUndefined({
    url: args.url === undefined ? undefined : webhookUrl(args.url),
    description: args.description,
    events: args.events === undefined ? undefined : idList(args.events, 'events'),
    computers,
    enabled: flag(args.enabled, 'enabled'),
  });
}

/** The body for `POST webhooks`. `url` is the one field it cannot do without. */
export function webhookCreateBody(args: WebhookCreateArgs): Json {
  if (!isRecord(args)) {
    throw new ValidationError(
      `webhook arguments must be an object with a url (got ${typeof args})`,
    );
  }
  if (args.url === undefined) throw new ValidationError('url is required');
  return webhookFields(args);
}

/**
 * The body for `PATCH webhooks/:id`.
 *
 * An empty patch is refused here, the way {@link updateBody} refuses one: it
 * can only mean the caller built the arguments from something that turned out
 * to be empty, and the platform's answer is a 400 that reads as malformed.
 */
export function webhookUpdateBody(args: WebhookUpdateArgs): Json {
  if (!isRecord(args)) {
    throw new ValidationError(`webhook arguments must be an object (got ${typeof args})`);
  }
  const body = webhookFields(args);
  if (!Object.keys(body).length) {
    throw new ValidationError(
      'nothing to update: give at least one of url, description, events, computers, enabled',
    );
  }
  return body;
}
