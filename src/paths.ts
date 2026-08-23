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
  if (!id) throw new ValidationError(`${what} must not be empty`);
  // URL parsers normalise both raw and percent-encoded dot segments before a
  // request is sent. Letting either through can therefore turn, for example,
  // `computers/..` into the API root instead of a computer route.
  if (id === '.' || id === '..') {
    throw new ValidationError(`${what} must not be ${JSON.stringify(id)}`);
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
 * start | stop | suspend | restart | clone | screenshot | input | exec |
 * windows | files | snapshots | schedule | agent
 */
export const computerAction = (id: string, action: string): string => `${computer(id)}/${action}`;

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

export const snapshot = (id: string): string => `snapshots/${pathId(id, 'snapshot id')}`;

/** restore | clone */
export const snapshotAction = (id: string, action: string): string => `${snapshot(id)}/${action}`;

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
  const { start = true, size, template, cpu, ramMb, diskGb, name, resolution } = args;
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
  if (name !== undefined && !name.trim()) {
    throw new ValidationError('name must not be empty');
  }
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
  if (args.name !== undefined && !args.name.trim()) {
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
  if (!name.trim()) throw new ValidationError('name must not be empty');
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
  if (args.desktop) body.session = 'desktop';
  if (args.background) body.background = true;
  if (args.cwd !== undefined) body.cwd = absoluteGuestPath(args.cwd, 'cwd');
  // An empty object is omitted rather than sent: the platform reads no `env`
  // and an empty one the same way, and sending it puts a key on the wire that
  // says a caller asked for something they did not.
  if (args.env && Object.keys(args.env).length) body.env = envObject(args.env);
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

/** Validate any path that the platform interprets inside a Linux or Windows guest. */
function absoluteGuestPath(path: string, what: string): string {
  if (!path.startsWith('/') && !path.startsWith('\\\\') && !/^[A-Za-z]:[\\/]/.test(path)) {
    throw new ValidationError(`${what} must be absolute: ${JSON.stringify(path)}`);
  }
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

export const typeBody = (text: string): Json => ({ action: 'type', text });

export function keyBody(keys: readonly string[]): Json {
  if (!keys.length) throw new ValidationError('key() needs at least one key');
  return { action: 'key', keys: [...keys] };
}

export function holdKeyBody(keys: readonly string[], seconds: number): Json {
  if (!keys.length) throw new ValidationError('holdKey() needs at least one key');
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
  if (fresh) {
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
 */
export const stopQuery = (force?: boolean): Query => (force ? { force: 'true' } : {});

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
  finiteIf(args.x, 'x');
  finiteIf(args.y, 'y');
  finiteIf(args.width, 'width');
  finiteIf(args.height, 'height');
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
 */
export function snapshotBody(memory: boolean, name?: string): Json {
  if (name !== undefined && !name.trim()) throw new ValidationError('name must not be empty');
  return omitUndefined({ memory, name });
}

export function scheduleBody(args: {
  enabled: boolean;
  hour?: number;
  minute?: number;
  tz?: string;
}): Json {
  const { enabled, hour = 4, minute = 0, tz = 'UTC' } = args;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23)
    throw new ValidationError('hour must be 0-23');
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new ValidationError('minute must be 0-59');
  }
  return { enabled, hour, minute, tz };
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
  if (!opts.deleteSnapshots) return {};
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
  if (!args.prompt.trim()) throw new ValidationError('prompt must not be empty');
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
