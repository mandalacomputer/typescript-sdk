import { writeFile } from 'node:fs/promises';
import process from 'node:process';
import {
  ARTIFACT_DEFAULT_BYTES,
  ARTIFACT_MAX_BYTES,
  type Artifact,
  artifactBody,
} from './artifacts.js';
import { completion } from './cli-completion.js';
import {
  apiKeysCreate,
  apiKeysList,
  apiKeysRevoke,
  logoutCommand,
  whoamiCommand,
} from './cli-keys.js';
import { loginCommand } from './cli-login.js';
import { manifest } from './cli-manifest.js';
import { CliError, help, type Parsed, parseArgs } from './cli-options.js';
import { errorInfo, Output, redact, snakeKeys, terminalSafe } from './cli-output.js';
import { type CliIO, documentInput, openBrowser, readInput } from './cli-runtime.js';
import {
  bindingSpecs,
  computerSecretsGet,
  computerSecretsSet,
  equalsDeprecation,
  scrubTypedTargets,
  secretBindings,
  secretsGet,
  secretsList,
  secretsRemove,
  secretsSet,
  withoutTypedTargets,
} from './cli-secrets.js';
import {
  defaultSshRuntime,
  sshAccessCommand,
  sshConfigCommand,
  sshConnect,
  sshKeyAdd,
  sshKeyList,
  sshKeyRemove,
  sshSetup,
} from './cli-ssh.js';
import type { Computer } from './computer.js';
import {
  type CredentialProfile,
  CredentialSaveError,
  credentialError,
  readCredentials,
  resolveSuppliedCredential,
  selectedProfile,
} from './credentials.js';
import {
  DEFAULTS_PATH,
  DefaultsError,
  readDefaults,
  removeWorkspaceDefault,
  saveWorkspaceDefault,
  workspaceDefault,
} from './defaults.js';
import { MandalaError, MoveRequiredError, NotFoundError, ValidationError } from './errors.js';
import {
  type AccountQuota,
  type BackgroundExec,
  type BuildProgress,
  type Client,
  type GuestDirectory,
  type Listing,
  type Move,
  type UsageReport,
  VERSION,
  type Workspace,
} from './index.js';
import * as P from './paths.js';
import { checkWait } from './wait.js';

/** What one file copy reports: `scp`, `files upload` and `files download` alike. */
export type CopyResult = {
  source: string;
  destination: string;
  bytes: number;
  confirmed: boolean;
  accounting?: string;
};

export type LegacyCommands = {
  terminal: (computer: string, session: string, io: CliIO) => Promise<number>;
  scp: (
    source: string,
    destination: string,
    io: CliIO,
    signal: AbortSignal,
    opts?: { overwrite?: boolean },
  ) => Promise<CopyResult>;
  /** One local file to a guest path: scp's upload half, with the computer named apart. */
  upload: (
    computer: string,
    local: string,
    guestPath: string,
    io: CliIO,
    signal: AbortSignal,
    opts?: { overwrite?: boolean; noWake?: boolean },
  ) => Promise<CopyResult>;
  /** One guest file to a local path: scp's download half, with the computer named apart. */
  download: (
    computer: string,
    guestPath: string,
    local: string,
    io: CliIO,
    signal: AbortSignal,
    opts?: { noWake?: boolean },
  ) => Promise<CopyResult>;
};

export async function resolveComputer(
  client: Client,
  target: string,
  signal?: AbortSignal,
  /** Filled with the listing the lookup read, when it read one. */
  seen: { listing?: Listing<Computer> } = {},
): Promise<Computer> {
  P.computer(target);
  let listing: Listing<Computer> | undefined;
  let listingError: unknown;
  try {
    listing = await client.computers.listWithStatus({ signal });
    seen.listing = listing;
  } catch (error) {
    signal?.throwIfAborted();
    listingError = error;
  }
  const listedId = listing?.items.find((c) => c.id === target);
  if (listedId) return listedId;

  // Default listings omit some lifecycle states. Establish that no direct ID
  // exists before accepting a name that could identify a different computer.
  let idLookupError: NotFoundError;
  try {
    const byId = await client.computers.get(target, { signal });
    if (byId.id !== target) {
      throw new CliError('unexpected_computer', 'The computer ID lookup returned a different ID');
    }
    return byId;
  } catch (error) {
    signal?.throwIfAborted();
    if (!(error instanceof NotFoundError)) throw error;
    idLookupError = error;
  }
  if (!listing) throw listingError;
  if (listing.incomplete !== null)
    throw new CliError(
      'incomplete_listing',
      'Cannot resolve a name from an incomplete computer listing; use an ID',
    );
  const named = listing.items.filter((c) => c.name === target);
  if (named.length === 1) return named[0]!;
  if (named.length)
    throw new CliError(
      'ambiguous_computer',
      `${target} names ${named.length} computers — use an id: ${named.map((c) => c.id).join(', ')}`,
    );
  throw idLookupError;
}

/**
 * `operations list --computer`: a computer by name or id, as every other
 * computer argument is. A value that is neither a live computer's id nor its
 * name is sent as typed, because an operation outlives its computer: the id of
 * one since deleted (a create that would not boot, a clone that failed) is
 * still how its operations are found. Said on stderr when that happens, so the
 * empty page a mistyped name gets is not read as "no operations".
 */
async function operationsComputer(
  client: Client,
  target: string,
  output: Output,
  signal: AbortSignal,
  /** What is listed, for the note: `operations`, or `moves`. */
  listed = 'operations',
): Promise<string> {
  try {
    return (await resolveComputer(client, target, signal)).id;
  } catch (error) {
    signal.throwIfAborted();
    if (!(error instanceof NotFoundError)) throw error;
    output.diagnostic(
      `mandala: no computer is named ${target} or has that id now; listing the ${listed} recorded under the id ${target}`,
    );
    return target;
  }
}

/**
 * `computers exec-poll` and `exec-kill`'s pid operand: a positive whole
 * number, checked before any request.
 */
function pidOperand(value: string): number {
  if (!/^[1-9][0-9]{0,9}$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new CliError(
      'invalid_arguments',
      '<pid> must be the positive whole number computers exec --background printed',
    );
  return Number(value);
}

/**
 * `computers idle-suspend`'s minutes operand: a whole number of minutes, `off`
 * (0, never suspend) or `default` (null, the host's own window).
 */
function idleMinutes(value: string): number | null {
  if (value === 'off') return 0;
  if (value === 'default') return null;
  if (!/^[0-9]{1,6}$/.test(value))
    throw new CliError(
      'invalid_arguments',
      '<minutes> must be a whole number of minutes (at most 10080), off, or default',
    );
  return Number(value);
}

/** How many polls `computers exec-poll` reads back to back while more output waits. */
const EXEC_POLL_DRAIN = 16;

/**
 * The process exit status for a background command's state, as `computers
 * exec` maps a foreground one: 0 while it runs, its exit code once it has one
 * in 0-255, and 1 for one the platform could not say or that is out of range.
 */
function backgroundExitStatus(state: BackgroundExec): number {
  if (state.running) return 0;
  const code = state.exitCode;
  return code !== undefined && Number.isInteger(code) && code >= 0 && code <= 255 ? code : 1;
}

/** A move as the CLI prints it: the SDK's fields in the API's snake_case, without `raw`. */
const moveData = (move: Move) => {
  const { raw: _raw, ...fields } = move;
  return snakeKeys(fields) as Record<string, unknown>;
};

/** A workspace id: `wsp-` and twelve lowercase hex characters. */
const WORKSPACE_ID = /^wsp-[0-9a-f]{12}$/;

/**
 * `workspaces get`, `members`, `rename` and `rm`: a workspace by name or id, as a
 * computer argument is. The listing is the whole of what this key can reach,
 * so it decides: an id in it is taken as it is (an id wins over a name), a name
 * that fits exactly one workspace becomes that workspace's id, and a name that
 * fits more than one is refused with their ids. Anything else is sent as typed,
 * and the platform's 404 says there is no such workspace.
 *
 * A listing that fails does not stop an id from being read, as it does not for
 * a computer: the target is sent as typed. Only when that read answers not
 * found is the listing's failure what is reported, because without a listing a
 * name cannot be resolved and the 404 would wrongly say no such workspace.
 *
 * `rename` and `rm` pass `idShapedIsId`: a target shaped like a workspace id
 * (`wsp-` and twelve lowercase hex) is sent as that id and never resolved as a
 * name. Otherwise a retried `rm <id> --yes`, whose workspace the first attempt
 * already deleted, would land on another workspace NAMED that id string and
 * revoke its keys; sent as the id, the retry is the platform's 404.
 */
async function readWorkspace<T>(
  client: Client,
  target: string,
  signal: AbortSignal,
  read: (workspaceId: string) => Promise<T>,
  idShapedIsId = false,
): Promise<T> {
  P.workspace(target);
  if (idShapedIsId && WORKSPACE_ID.test(target)) return read(target);
  let listing: Workspace[];
  try {
    listing = await client.workspaces.list({ signal });
  } catch (listingError) {
    signal.throwIfAborted();
    try {
      return await read(target);
    } catch (error) {
      signal.throwIfAborted();
      throw error instanceof NotFoundError ? listingError : error;
    }
  }
  if (listing.some((w) => w.id === target)) return read(target);
  const named = listing.filter((w) => w.name === target);
  if (named.length > 1)
    throw new CliError(
      'ambiguous_workspace',
      `${target} names ${named.length} workspaces — use an id: ${named.map((w) => w.id).join(', ')}`,
    );
  return read(named.length === 1 ? named[0]!.id : target);
}

/** The saved profile a command's key comes from, as `createClient` resolves it. */
type SavedProfile = { name: string; entry: CredentialProfile };

/**
 * The saved profile in use: `--profile`, `MANDALA_PROFILE`, else the default.
 * Undefined when MANDALA_API_KEY supplies the key, as it does before any
 * profile; a missing store or profile fails as the client's resolution does.
 */
function savedProfile(profile: string | undefined, io: CliIO): SavedProfile | undefined {
  if (resolveSuppliedCredential({}, io.env)) return undefined;
  const selected = selectedProfile({ profile }, io.env);
  const file = readCredentials();
  if (!file) credentialError('missing_credentials');
  const name = selected ?? file.default_profile;
  if (!Object.hasOwn(file.profiles, name)) credentialError('missing_selected_profile');
  return { name, entry: file.profiles[name]! };
}

/**
 * defaults.json for a command that only reads it: one that cannot be used is
 * reported in a line and read as holding nothing, never failing the command.
 */
function readDefaultsOrNote(note: (line: string) => void) {
  try {
    return readDefaults();
  } catch (error) {
    if (!(error instanceof DefaultsError)) throw error;
    note(`ignoring ${DEFAULTS_PATH}: ${error.reason}`);
    return undefined;
  }
}

/**
 * defaults.json for a command that writes: one that cannot be used fails the
 * command before any request. Read as holding nothing, it would send a create,
 * a replace or a delete account-wide when the profile's default says a
 * workspace, and with --json not even a note would say so.
 */
function readDefaultsOrRefuse() {
  try {
    return readDefaults();
  } catch (error) {
    if (!(error instanceof DefaultsError)) throw error;
    throw new CliError(
      'defaults_unreadable',
      `${DEFAULTS_PATH} cannot be read (${error.reason}), so this command was not sent: without the profile's default workspace it would act account-wide. Pass --workspace, or fix or delete the file.`,
    );
  }
}

/**
 * `secrets`, `api-keys create`, `computers create` and `computers list`
 * without `--workspace`: the saved profile's default from `workspaces use`,
 * when the key is account-wide and the default was saved for the account the
 * profile is logged in to now. Otherwise undefined, and the command goes on as
 * it always has. A command that writes (`mutating`) is refused, not widened,
 * when defaults.json cannot be read; `secrets list` and `computers list` read
 * past it.
 */
function defaultWorkspace(
  profile: string | undefined,
  io: CliIO,
  output: Output,
  mutating = false,
): string | undefined {
  const saved = savedProfile(profile, io);
  if (!saved || saved.entry.scope.type !== 'account') return undefined;
  const note = (line: string) => {
    if (!output.json) output.diagnostic(line);
  };
  const file = mutating ? readDefaultsOrRefuse() : readDefaultsOrNote(note);
  const { entry } = workspaceDefault(file, saved.name, saved.entry.account.id);
  if (!entry) return undefined;
  note(
    `(workspace ${entry.workspace.name} from \`workspaces use\`; \`workspaces use --clear\` for account-wide)`,
  );
  return entry.workspace.id;
}

const workspaceText = (w: { id: string; name: string }) => `workspace ${w.name} (${w.id})`;

/**
 * `mandala workspaces use <workspace>` and `workspaces use --clear`: save, or
 * remove, the saved profile's default workspace in ~/.mandala/defaults.json.
 * It never mints a key or touches credentials.json. A profile whose key is
 * confined to a workspace has that one and no other, so another is refused
 * and its own is not saved.
 */
async function workspacesUse(
  profile: string | undefined,
  target: string | undefined,
  clear: boolean,
  io: CliIO,
  output: Output,
  signal: AbortSignal,
): Promise<number> {
  if (clear && target !== undefined)
    throw new CliError('invalid_arguments', 'give a workspace or --clear, not both');
  if (!clear && target === undefined)
    throw new CliError(
      'invalid_arguments',
      'say which workspace, by name or ID, or --clear to go back to account-wide',
    );
  const saved = savedProfile(profile, io);
  if (!saved)
    throw new CliError(
      'no_saved_profile',
      'workspaces use saves a default in a saved profile; MANDALA_API_KEY is set, so there is no profile to save it in.',
    );
  const line = (text: string) => io.stdout.write(`${terminalSafe(text)}\n`);
  if (clear) {
    const removed = await removeWorkspaceDefault(saved.name, { signal });
    if (output.json) return output.result({ profile: saved.name, workspace: null, removed });
    line(
      removed
        ? `Profile ${saved.name} no longer has a default workspace; secrets, api-keys create, computers create and computers list use the key's own scope.`
        : `Profile ${saved.name} has no default workspace; nothing to clear.`,
    );
    return 0;
  }
  const { scope } = saved.entry;
  if (scope.type === 'workspace') {
    const own = { id: scope.workspace_id, name: scope.workspace_name };
    if (target !== own.id && target !== own.name)
      throw new CliError(
        'workspace_confined',
        `This profile's key is confined to ${workspaceText(own)}; it cannot use another workspace. Log in again without --workspace for an account-wide key.`,
      );
    if (output.json) return output.result({ profile: saved.name, workspace: own, source: 'key' });
    line(
      `Profile ${saved.name}'s key is already confined to ${workspaceText(own)}; nothing was saved.`,
    );
    return 0;
  }
  const client = io.createClient();
  const found = await readWorkspace(client, target!, signal, (id) =>
    client.workspaces.get(id, { signal }),
  );
  const workspace = { id: found.id, name: found.name };
  await saveWorkspaceDefault(
    saved.name,
    { account_id: saved.entry.account.id, workspace },
    { signal },
  );
  if (output.json) return output.result({ profile: saved.name, workspace, source: 'profile' });
  line(
    `Profile ${saved.name} now uses ${workspaceText(workspace)} by default for secrets, api-keys create, computers create and computers list.`,
  );
  return 0;
}

/**
 * `mandala workspaces current`: the workspace `secrets` and `api-keys create`
 * use, and why: the key's own (a key confined to one), the saved profile's
 * default, or none (account-wide). Read from this machine alone; no request.
 */
function workspacesCurrent(profile: string | undefined, io: CliIO, output: Output): number {
  const line = (text: string) => io.stdout.write(`${terminalSafe(text)}\n`);
  const note = (text: string) => output.diagnostic(text);
  const saved = savedProfile(profile, io);
  if (!saved) {
    if (output.json) return output.result({ profile: null, workspace: null, source: 'none' });
    line(
      "none: MANDALA_API_KEY is set, so no saved default applies; commands use that key's own scope (mandala whoami shows it).",
    );
    return 0;
  }
  const { scope } = saved.entry;
  if (scope.type === 'workspace') {
    const own = { id: scope.workspace_id, name: scope.workspace_name };
    if (output.json) return output.result({ profile: saved.name, workspace: own, source: 'key' });
    line(`${workspaceText(own)}: profile ${saved.name}'s key is confined to it.`);
    return 0;
  }
  const { entry, ignored } = workspaceDefault(
    readDefaultsOrNote(note),
    saved.name,
    saved.entry.account.id,
  );
  if (ignored)
    note(
      `The default ${workspaceText(ignored.workspace)} saved for profile ${saved.name} is ignored: it was saved for account ${ignored.account_id}, and the profile is now logged in to ${saved.entry.account.id}. Run workspaces use again, or workspaces use --clear.`,
    );
  if (output.json)
    return output.result({
      profile: saved.name,
      workspace: entry ? entry.workspace : null,
      source: entry ? 'profile' : 'none',
    });
  line(
    entry
      ? `${workspaceText(entry.workspace)}: profile ${saved.name}'s default from workspaces use (workspaces use --clear for account-wide).`
      : `none: account-wide (profile ${saved.name} has no default workspace; set one with workspaces use).`,
  );
  return 0;
}

/** Format the SDK's public projection explicitly; never expose desktop credentials. */
const computerData = (computer: Computer) => computer.toJSON();

/**
 * A bypass list as typed: each value comma-separated and repeatable, so
 * `--bypass a.com,b.com` and `--bypass a.com --bypass b.com` say the same
 * thing. `undefined` when none was given, so the setting is sent without one.
 * An empty entry is refused, as the SDK refuses one: `--bypass ''` would
 * otherwise send an empty list and look like it had said something. Nothing
 * else is checked here: which entries are valid is the platform's rule, and its
 * refusal names the entry.
 */
function bypassList(values: string[] | undefined, flagName: string): string[] | undefined {
  if (values === undefined) return undefined;
  const entries = values.flatMap((v) => v.split(',')).map((v) => v.trim());
  if (entries.some((v) => !v)) {
    throw new CliError(
      'invalid_arguments',
      `--${flagName} has an empty entry; name each host, comma-separated`,
    );
  }
  return entries;
}

/**
 * Whether two proxy URLs name the same server: the scheme, host and port,
 * compared without case, as the platform stores a server. A proxy's
 * credentials are sent to its server on every request, so they are carried
 * over only to the server they were set for; `false` when either will not
 * parse, which refuses the carry rather than guessing.
 */
function sameProxyServer(a: string, b: string): boolean {
  const parts = (value: string) => {
    try {
      const u = new URL(value);
      return `${u.protocol.toLowerCase()}//${u.hostname.toLowerCase()}:${u.port}`;
    } catch {
      return undefined;
    }
  };
  const left = parts(a);
  return left !== undefined && left === parts(b);
}

/**
 * A proxy URL as a refusal may quote it: scheme, host and port only. A server
 * typed with `user:password@` in it is refused by the platform without being
 * repeated, and an error here must not repeat it either, since stderr and the
 * --json error are what CI logs keep. One that will not parse is not quoted,
 * and neither is one with an `@` anywhere in it: a password holding an
 * unencoded `/`, `?` or `#` ends the authority early, so the URL parser reads
 * `user:pass` as the host and port (`http://alice:12#34@proxy:3128` has host
 * `alice:12`), and scheme-plus-host would then quote the credentials. Only
 * a proxy scheme with a host is quoted: a server typed without one parses
 * with whatever precedes the first `:` as its scheme and an empty host, so
 * `svc-ci:hunter2@10.0.0.9:3128` would otherwise be quoted as `svc-ci://`.
 */
const PROXY_SCHEMES = new Set(['http:', 'https:', 'socks5:']);
function proxyServerText(value: string): string {
  if (value.includes('@')) return 'the URL given';
  try {
    const u = new URL(value);
    if (u.username || u.password) return 'the URL given';
    if (!PROXY_SCHEMES.has(u.protocol) || !u.host) return 'the URL given';
    return terminalSafe(`${u.protocol}//${u.host}`);
  } catch {
    return 'the URL given';
  }
}

const raw = (value: { raw: Record<string, unknown> }) => value.raw;
const publicWebhook = (value: { raw: Record<string, unknown> }, secret?: string) => {
  const { secret: _secret, ...data } = value.raw;
  return secret === undefined ? data : { ...data, secret };
};

function accountText(q: AccountQuota): string {
  const amount = (value: number | null) => (value === null ? 'unknown' : String(value));
  const pool = (label: string, used: number | null, limit: number, remaining: number | null) =>
    `${label}: used ${amount(used)}; limit ${limit}; remaining ${amount(remaining)}`;
  return [
    'Account quota (instantaneous, account-wide)',
    `Observed: ${q.observedAt}`,
    `Plan: ${q.plan.label} (${q.plan.id})`,
    'Advisory: headroom is not a reservation or host-capacity guarantee and can change immediately.',
    `Computer inventory: ${q.complete.computers ? 'complete' : 'unknown; consumption and remaining headroom are unknown'}`,
    `Snapshot inventory: ${q.complete.snapshots ? 'complete' : 'unknown; consumption and remaining headroom are unknown'}`,
    pool('Kept computers', q.usage.keptComputers, q.limits.maxComputers, q.remaining.keptComputers),
    pool('Configured vCPU', q.usage.configuredVcpu, q.limits.vcpuPool, q.remaining.configuredVcpu),
    pool(
      'Configured disk (GiB)',
      q.usage.configuredDiskGb,
      q.limits.diskPoolGb,
      q.remaining.configuredDiskGb,
    ),
    `Running/reserved computers: ${amount(q.usage.runningOrReservedComputers)}`,
    `Running/reserved vCPU: ${amount(q.usage.runningOrReservedVcpu)}`,
    pool(
      'Running/reserved RAM (MiB)',
      q.usage.runningOrReservedRamMb,
      q.limits.ramPoolMb,
      q.remaining.runningOrReservedRamMb,
    ),
    pool(
      'Indexed snapshot storage (bytes)',
      q.usage.snapshotStorageBytes,
      q.limits.snapshotStorageBytes,
      q.remaining.snapshotStorageBytes,
    ),
    'Snapshot storage excludes in-flight capture reservations; its headroom does not predict capture admission.',
    `Per-computer maxima: ${q.perComputer.maxVcpu} vCPU; ${q.perComputer.maxRamMb} MiB RAM; ${q.perComputer.maxDiskGb} GiB disk`,
    `Windows capability: ${q.capabilities.windows ? 'yes' : 'no'}`,
  ]
    .map((line) => terminalSafe(line))
    .join('\n');
}

/**
 * The dashboard page for one computer, beside the API the client talks to: the
 * base URL less its `/api/v1`, or its origin when it does not end in one.
 */
export function dashboardUrl(baseUrl: string, id: string): string {
  const url = new URL(baseUrl);
  const prefix = url.pathname.replace(/\/+$/, '');
  url.pathname = `${prefix.endsWith('/api/v1') ? prefix.slice(0, -'/api/v1'.length) : ''}/computers/${encodeURIComponent(id)}`;
  url.search = '';
  url.hash = '';
  return url.href;
}

/**
 * `files list` for a person: one line per entry, directories marked with a `/`.
 * A name is the guest's, and whoever made the file chose it: its control and
 * bidi characters are shown escaped (see {@link terminalSafe}), not obeyed.
 */
function directoryText(dir: GuestDirectory): string {
  return dir.entries
    .map(
      (e) =>
        `${terminalSafe(e.type).padEnd(11)} ${e.sizeBytes === undefined ? '-'.padStart(12) : String(e.sizeBytes).padStart(12)}  ${terminalSafe(e.name)}${e.type === 'directory' ? '/' : ''}\n`,
    )
    .join('');
}

function checkUsageReport(d: Record<string, unknown>): void {
  // The SDK decoder accepts older sparse reports. The CLI must not present
  // its defaults as measured totals, complete metadata or a withheld breakdown.
  function refuse(field: string, expected: string): never {
    throw new MandalaError(`Invalid usage report: ${field} must be ${expected}`);
  }
  const object = (value: unknown, field: string): Record<string, unknown> =>
    P.isRecord(value) ? value : refuse(field, 'an object');
  const text = (value: unknown, field: string, allowEmpty = false): void => {
    if (typeof value !== 'string' || (!allowEmpty && !value.trim()))
      refuse(field, allowEmpty ? 'a string' : 'a nonempty string');
  };
  const number = (value: unknown, field: string): void => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
      refuse(field, 'a finite nonnegative number');
  };
  const utcDay = (value: unknown): value is string =>
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value;
  const timestamp = (value: unknown, field: string): void => {
    if (
      typeof value !== 'string' ||
      !Number.isFinite(Date.parse(value)) ||
      !utcDay(value.slice(0, 10)) ||
      Number(value.slice(11, 13)) > 23
    )
      refuse(field, 'an RFC 3339 timestamp with a time zone');
    try {
      P.usageQuery(value);
    } catch {
      refuse(field, 'an RFC 3339 timestamp with a time zone');
    }
  };
  const totals = object(d.usage, 'usage');
  const hours = ['run_hours', 'vcpu_hours', 'ram_gb_hours'];
  for (const key of [
    ...hours,
    'disk_gb_hours',
    'disk_gb_months',
    'snapshot_gb_hours',
    'snapshot_gb_months',
  ]) {
    number(totals[key], `usage.${key}`);
  }
  const period = object(d.period, 'period');
  timestamp(period.start, 'period.start');
  timestamp(period.end, 'period.end');
  text(period.source, 'period.source');
  timestamp(d.from, 'from');
  timestamp(d.to, 'to');
  for (const key of ['degraded', 'unmetered']) {
    if (typeof d[key] !== 'boolean') refuse(key, 'a boolean');
  }
  const through = d.reported_through;
  if (through !== null && !utcDay(through)) {
    refuse('reported_through', 'null or a UTC day (YYYY-MM-DD)');
  }
  if (Object.hasOwn(totals, 'computers')) {
    const computers = totals.computers;
    if (!Array.isArray(computers)) refuse('usage.computers', 'an array when present');
    for (const [index, value] of computers.entries()) {
      const field = `usage.computers[${index}]`;
      const row = object(value, field);
      text(row.id, `${field}.id`);
      if (Object.hasOwn(row, 'name')) text(row.name, `${field}.name`, true);
      for (const key of hours) number(row[key], `${field}.${key}`);
      if (Object.hasOwn(row, 'gone') && typeof row.gone !== 'boolean')
        refuse(`${field}.gone`, 'a boolean when present');
    }
  }
}

/**
 * `usage` for a person, one line each, raw: the caller redacts each line and
 * then escapes it. A computer name is another party's and may repeat a secret
 * with a line feed in it, which no longer matches once it is escaped.
 */
function usageLines(u: UsageReport): string[] {
  return [
    'Historical metered usage (account-wide)',
    `Completeness: degraded=${u.degraded}; unmetered=${u.unmetered}`,
    ...(u.degraded
      ? ['Incomplete: some usage could not be read; totals may be too small. Retry later.']
      : []),
    ...(u.unmetered
      ? ['Incomplete: some usage was not metered; retrying alone will not recover it.']
      : []),
    `Measured window: ${u.from} to ${u.to}`,
    `Billing period: ${u.period.start} to ${u.period.end} (${u.period.source})`,
    `Settled for billing through: ${u.reportedThrough ?? 'none of this window'}`,
    `Run hours: ${u.usage.runHours}`,
    `vCPU-hours: ${u.usage.vcpuHours}`,
    `RAM GB-hours: ${u.usage.ramGbHours}`,
    `Disk GB-hours: ${u.usage.diskGbHours}; GB-months: ${u.usage.diskGbMonths}`,
    `Snapshot GB-hours: ${u.usage.snapshotGbHours}; GB-months: ${u.usage.snapshotGbMonths}`,
    ...(!u.breakdown
      ? ['Computer breakdown: withheld for this credential; account totals still apply']
      : [
          `Computer breakdown: ${u.usage.computers.length ? 'available' : 'empty'}`,
          ...u.usage.computers.map(
            (c) =>
              `  ${c.name || c.id} (${c.id})${c.gone ? ' [deleted]' : ''}: ${c.runHours} run hours; ${c.vcpuHours} vCPU-hours; ${c.ramGbHours} RAM GB-hours`,
          ),
        ]),
  ];
}

function checkUsageWindow(from?: string, to?: string): void {
  P.usageQuery(from, to);
  for (const [name, value] of [
    ['from', from],
    ['to', to],
  ] as const) {
    if (value !== undefined && !Number.isFinite(Date.parse(value)))
      throw new CliError(
        'invalid_arguments',
        `--${name} must be a valid RFC 3339 timestamp with a time zone`,
      );
  }
  if (from !== undefined && to !== undefined && Date.parse(from) >= Date.parse(to))
    throw new CliError('invalid_arguments', '--from must be before --to');
  // Default bounds, retention and future-end clamping depend on the API's clock and billing period.
}

/** How many computers `billing` lists by name; the rest are counted. */
const BILLING_TOP = 5;

/**
 * `billing` for a person, one line each, raw, as {@link usageLines}: the plan
 * from the account read, then the current billing period's totals and the
 * computers that ran longest in it. The caller redacts and escapes each line.
 */
function billingLines(q: AccountQuota, u: UsageReport): string[] {
  const top = [...u.usage.computers].sort((a, b) => b.runHours - a.runHours);
  const shown = top.slice(0, BILLING_TOP);
  return [
    `Plan: ${q.plan.label} (${q.plan.id})`,
    `Plan limits: ${q.limits.maxComputers} computers; ${q.limits.vcpuPool} vCPU; ${q.limits.ramPoolMb} MiB RAM; ${q.limits.diskPoolGb} GiB disk`,
    `Billing period: ${u.period.start} to ${u.period.end} (${u.period.source})`,
    `Measured so far: ${u.from} to ${u.to}`,
    `Settled for billing through: ${u.reportedThrough ?? 'none of this period'}`,
    ...(u.degraded
      ? ['Incomplete: some usage could not be read; totals may be too small. Retry later.']
      : []),
    ...(u.unmetered
      ? ['Incomplete: some usage was not metered; retrying alone will not recover it.']
      : []),
    `Run hours: ${u.usage.runHours}; vCPU-hours: ${u.usage.vcpuHours}; RAM GB-hours: ${u.usage.ramGbHours}`,
    `Disk GB-months: ${u.usage.diskGbMonths}; snapshot GB-months: ${u.usage.snapshotGbMonths}`,
    ...(!u.breakdown
      ? ['Top computers: withheld for this credential; the totals above still apply']
      : !top.length
        ? ['Top computers: none ran this period']
        : [
            'Top computers by run hours:',
            ...shown.map(
              (c) =>
                `  ${c.name || c.id} (${c.id})${c.gone ? ' [deleted]' : ''}: ${c.runHours} run hours; ${c.vcpuHours} vCPU-hours`,
            ),
            ...(top.length > shown.length
              ? [`  and ${top.length - shown.length} more; mandala usage lists every one`]
              : []),
          ]),
    'Quota and headroom in full: mandala account',
  ];
}

/** An artifact id operand, checked before any request. */
function artifactId(value: string): string {
  if (!P.isArtifactId(value))
    throw new CliError(
      'invalid_arguments',
      '<artifact> must be an artifact id: art_ followed by 32 lowercase hex characters',
    );
  return value;
}

/** An artifact as the CLI prints it: the SDK's fields in the API's snake_case. */
const artifactData = (a: Artifact) => snakeKeys(a) as Record<string, unknown>;

/** A POSIX shell word that is exactly `text`. */
const shellWord = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;

/**
 * What `artifacts export` nominates when no `--size` and `--sha256` are given:
 * the guest file's size and SHA-256, read on the computer by one `exec`. The
 * platform publishes only bytes that match both, so a file that changes
 * between this read and the capture is refused (409), never kept half-way.
 */
async function guestFileDigest(
  c: Computer,
  path: string,
  signal: AbortSignal,
): Promise<{ size: number; sha256: string }> {
  const f = shellWord(path);
  const result = await c.exec(
    `[ -f ${f} ] || { echo 'not a regular file' >&2; exit 2; }; wc -c < ${f} && sha256sum < ${f}`,
    { timeoutS: 60, signal },
  );
  const read = /^\s*(\d+)\s*\n([0-9a-f]{64})\s+-\s*$/.exec(result.stdoutText);
  if (result.exitCode !== 0 || result.timedOut || !read) {
    const why = result.stderrText.trim().split('\n')[0];
    throw new CliError(
      'artifact_unavailable',
      `could not read the size and SHA-256 of ${terminalSafe(path)} on ${c.id}${why ? `: ${terminalSafe(why)}` : ''}; ` +
        'give them with --size and --sha256 to publish without this read',
    );
  }
  return { size: Number(read[1]), sha256: read[2]! };
}

/**
 * `--region X,Y,WIDTH,HEIGHT`, the wire's own spelling, read into the object
 * the SDK takes. Only the count and the digits are checked here; the values
 * are the SDK's to judge, so the CLI and a program say the same thing.
 */
function screenshotRegionFlag(v: string | undefined): P.ScreenshotRegion | undefined {
  if (v === undefined) return undefined;
  const parts = v.split(',').map((p) => p.trim());
  if (parts.length !== 4 || !parts.every((p) => /^\d+$/.test(p)))
    throw new CliError(
      'invalid_arguments',
      '--region must be X,Y,WIDTH,HEIGHT in screen pixels, four whole numbers',
    );
  const [x, y, width, height] = parts.map(Number) as [number, number, number, number];
  return { x, y, width, height };
}

export async function runCli(argv: string[], io: CliIO, legacy: LegacyCommands): Promise<number> {
  // Used only if parsing fails before it can return its explicit output mode.
  // Past a bare `--` a word is an operand, however it is spelled.
  const options = argv.indexOf('--') < 0 ? argv : argv.slice(0, argv.indexOf('--'));
  let output = new Output(io, '', options.includes('--json'));
  let parsed: Parsed | undefined;
  const controller = new AbortController();
  let watching = false;
  // A line said after the error, for a refusal the CLI has a next step for.
  let moveHint: string | undefined;
  const cancel = () => controller.abort(new DOMException('Cancelled', 'AbortError'));
  const signal = controller.signal;
  try {
    parsed = parseArgs(argv);
    const { path, flags: f, args, json } = parsed;
    output = new Output(io, path, json);
    watching = parsed.command?.jsonMode === 'ndjson' && !parsed.help;
    if (parsed.help || !argv.length) {
      if (json) output.result({ help: help(path) });
      else io.stdout.write(help(path));
      return argv.length ? 0 : 2;
    }
    if (path === 'manifest') {
      if (json) return output.result(manifest());
      output.emitJson(manifest());
      return 0;
    }
    if (path === 'version') {
      if (json) return output.result({ name: 'mandala', version: VERSION });
      io.stdout.write(`mandala ${VERSION}\n`);
      return 0;
    }
    if (path === 'completion') {
      const script = completion(args[0]!);
      if (json) return output.result({ shell: args[0], script });
      io.stdout.write(script);
      return 0;
    }
    const createClient = io.createClient;
    io = {
      ...io,
      secrets: io.secrets ?? new Set<string>(),
      createClient: () => createClient(f.profile as string | undefined),
    };
    output = new Output(io, path, json);
    if (path === 'login') {
      process.on('SIGINT', cancel);
      process.on('SIGTERM', cancel);
      return await loginCommand(
        f.profile as string | undefined,
        f.workspace as string | undefined,
        f['base-url'] as string | undefined,
        io,
        output,
        signal,
      );
    }
    if (path === 'logout') {
      process.on('SIGINT', cancel);
      process.on('SIGTERM', cancel);
      // Which profile logout removes, read before it removes it: afterwards
      // the store may name another default, or be gone.
      let removing: string | undefined;
      try {
        removing =
          selectedProfile({ profile: f.profile as string | undefined }, io.env) ??
          readCredentials()?.default_profile;
      } catch {
        // logout reports the store's problem itself.
      }
      const code = await logoutCommand(f.profile as string | undefined, io, output, signal);
      // Best effort: the profile is gone whatever happens to its default.
      if (code === 0 && removing !== undefined) {
        try {
          await removeWorkspaceDefault(removing, { signal });
        } catch (error) {
          output.diagnostic(
            `mandala: the profile was removed, but its default workspace in ${DEFAULTS_PATH} was not: ${
              error instanceof DefaultsError ? error.reason : errorInfo(error).message
            }`,
          );
        }
      }
      return code;
    }
    if (path === 'terminal') {
      if (json)
        throw new CliError(
          'unsupported_mode',
          'Interactive terminal does not support --json; use computers exec for machine-readable output',
        );
      return await legacy.terminal(args[0]!, (f.session as string | undefined) ?? 'main', io);
    }
    const ssh = io.ssh ?? defaultSshRuntime;
    if (path === 'ssh' && !f.setup) {
      if (json)
        throw new CliError(
          'unsupported_mode',
          'ssh is interactive and has no --json output',
          undefined,
          2,
        );
      if (f.key !== undefined)
        throw new CliError(
          'invalid_arguments',
          '--key goes with --setup; to connect with a particular key, pass -i PATH after the computer',
          undefined,
          2,
        );
      // The lookups are cancellable; once ssh runs, Ctrl-C is ssh's.
      process.on('SIGINT', cancel);
      process.on('SIGTERM', cancel);
      return await sshConnect(io.createClient(), io, ssh, args[0]!, parsed.rest, {
        signal,
        beforeRun: () => {
          process.off('SIGINT', cancel);
          process.off('SIGTERM', cancel);
        },
      });
    }
    process.on('SIGINT', cancel);
    process.on('SIGTERM', cancel);
    const s = (name: string) => f[name] as string | undefined;
    const n = (name: string) => f[name] as number | undefined;
    const b = (name: string) => f[name] as boolean | undefined;
    const many = (name: string) => f[name] as string[] | undefined;
    const target = args[0]!;
    const wait = { timeoutMs: n('timeout-ms'), pollMs: n('poll-ms'), signal };
    if (wait.timeoutMs !== undefined || wait.pollMs !== undefined)
      checkWait(wait.timeoutMs ?? 60_000, wait.pollMs ?? 1_000);
    const call = { signal };
    // The key a keyed command sends instead of a new one, checked as the SDK
    // checks it and before any name is resolved. `operations list` has a flag
    // of the same name that is a filter, read below.
    const key = path === 'operations list' ? undefined : s('idempotency-key');
    if (key !== undefined && !P.isIdempotencyKey(key))
      throw new CliError(
        'invalid_arguments',
        '--idempotency-key must be 1 to 255 characters, each printable ASCII other than a space',
      );
    const keyed = key === undefined ? call : { ...call, idempotencyKey: key };
    const usageWindow = { from: s('from'), to: s('to'), signal };
    const operationPage = {
      computerId: s('computer'),
      idempotencyKey: s('idempotency-key'),
      limit: n('limit'),
      cursor: s('cursor'),
    };
    if (path === 'operations list') P.operationsQuery(operationPage);
    if (path === 'usage') checkUsageWindow(usageWindow.from, usageWindow.to);
    // Preparation and pure SDK validation happen before name resolution or any request.
    const bypassFlag =
      path === 'computers create'
        ? 'browser-proxy-bypass'
        : path === 'computers browser-proxy set'
          ? 'bypass'
          : undefined;
    const bypass = bypassFlag && bypassList(many(bypassFlag), bypassFlag);
    if (path === 'computers create' && bypass !== undefined && s('browser-proxy') === undefined)
      throw new CliError('invalid_arguments', '--browser-proxy-bypass requires --browser-proxy');
    if (
      path === 'computers create' &&
      s('browser-proxy-credentials') !== undefined &&
      s('browser-proxy') === undefined
    )
      throw new CliError(
        'invalid_arguments',
        '--browser-proxy-credentials requires --browser-proxy',
      );
    if (
      path === 'computers create' &&
      s('egress-proxy-credentials') !== undefined &&
      s('egress-proxy') === undefined
    )
      throw new CliError('invalid_arguments', '--egress-proxy-credentials requires --egress-proxy');
    if (
      (path === 'computers browser-proxy set' || path === 'computers egress-proxy set') &&
      s('credentials') !== undefined &&
      b('no-credentials')
    )
      throw new CliError('invalid_arguments', 'give --credentials or --no-credentials, not both');
    const create: P.CreateArgs = {
      name: s('name'),
      size: s('size'),
      template: s('template'),
      templateTransfer: s('template-transfer'),
      cpu: n('cpu'),
      ramMb: n('ram-mb'),
      diskGb: n('disk-gb'),
      resolution: s('resolution'),
      start: !b('no-start'),
      browserProxy:
        s('browser-proxy') === undefined
          ? // Sent as null: a template's default proxy applies only when the
            // field is left out, so null is how a create declines it.
            b('no-browser-proxy')
            ? null
            : undefined
          : {
              server: s('browser-proxy')!,
              bypass,
              credentialsSecretId: s('browser-proxy-credentials'),
            },
      egressProxy:
        s('egress-proxy') === undefined
          ? undefined
          : { server: s('egress-proxy')!, credentialsSecretId: s('egress-proxy-credentials') },
    };
    // Split and checked here; each is found by name or id only once the rest
    // of the create has passed, just before it is sent.
    const bindings = bindingSpecs(many('secret'), many('secret-file'), {
      valueCheck: !b('no-value-check'),
      as: parsed.paired.secret,
      paths: parsed.paired['secret-file'],
    });
    const deprecated = equalsDeprecation(bindings);
    if (deprecated) output.diagnostic(deprecated);
    if (path === 'computers create') P.createBody(create);
    // The setting is replaced whole, so a set that named no credentials would
    // remove the ones the proxy has. Unless told to change them, the current id
    // is read off the computer just before the change and carried over, but
    // only to the same server: a new server without either flag is refused.
    const proxy: P.UpdateArgs | undefined =
      path === 'computers browser-proxy set'
        ? { browserProxy: { server: args[1]!, bypass, credentialsSecretId: s('credentials') } }
        : path === 'computers browser-proxy clear'
          ? { browserProxy: null }
          : path === 'computers egress-proxy set'
            ? { egressProxy: { server: args[1]!, credentialsSecretId: s('credentials') } }
            : path === 'computers egress-proxy clear'
              ? { egressProxy: null }
              : undefined;
    if (proxy) P.updateBody(proxy);
    const keepProxyCredentials =
      (path === 'computers browser-proxy set' || path === 'computers egress-proxy set') &&
      s('credentials') === undefined &&
      !b('no-credentials');
    const resize = { cpu: n('cpu'), ramMb: n('ram-mb'), diskGb: n('disk-gb') };
    if (path === 'computers resize') {
      if (resize.cpu === undefined && resize.ramMb === undefined && resize.diskGb === undefined)
        throw new CliError('invalid_arguments', 'say what to change: --cpu, --ram-mb or --disk-gb');
      P.updateBody(resize);
    }
    if (path === 'computers rename') P.updateBody({ name: args[1]! });
    const idle =
      path === 'computers idle-suspend' ? { idleSuspendMin: idleMinutes(args[1]!) } : undefined;
    if (idle) P.updateBody(idle);
    const relocation = { ramMb: n('ram-mb')!, cpu: n('cpu'), diskGb: n('disk-gb') };
    if (path === 'computers move') {
      P.moveBody(relocation);
      if (!b('wait') && (wait.timeoutMs !== undefined || wait.pollMs !== undefined))
        throw new CliError('invalid_arguments', '--timeout-ms and --poll-ms go with --wait');
    }
    const pid =
      path === 'computers exec-poll' || path === 'computers exec-kill'
        ? pidOperand(args[1]!)
        : undefined;
    if (path === 'workspaces create') P.workspaceNameBody(target);
    if (path === 'workspaces rename') P.workspaceNameBody(args[1]!);
    // A delete revokes every key confined to the workspace, whoever holds them,
    // so it is not done on a bare command: refused before any request, as a
    // usage mistake is, and the message says what --yes agrees to.
    if (path === 'workspaces rm' && !b('yes'))
      throw new CliError(
        'confirmation_required',
        `deleting workspace ${target} revokes every API key confined to it; a workspace that still holds computers cannot be deleted. Pass --yes to delete it`,
      );
    if (path === 'files list') P.directoryQuery(args[1]!);
    if (path === 'computers secrets set' && !b('clear') && !bindings.length)
      throw new CliError(
        'invalid_arguments',
        'say what the computer is to be bound to: --secret or --secret-file, or --clear to remove every binding',
      );
    if (['artifacts get', 'artifacts download', 'artifacts rm'].includes(path))
      artifactId(args[1]!);
    // Deleted for good, so not on a bare command: refused before any request,
    // as workspaces rm is.
    if (path === 'artifacts rm' && !b('yes'))
      throw new CliError(
        'confirmation_required',
        `deleting artifact ${args[1]} cannot be undone; it is never readable again. Pass --yes to delete it`,
      );
    const nominated = { size: n('size'), sha256: s('sha256') };
    const keep = { maxBytes: n('max-bytes'), retentionSeconds: n('retention-seconds') };
    if (path === 'artifacts export') {
      if ((nominated.size === undefined) !== (nominated.sha256 === undefined))
        throw new CliError(
          'invalid_arguments',
          '--size and --sha256 go together; give both, or neither to read them on the computer',
        );
      // The path, the caps and any nomination, checked as the SDK will check
      // them, before anything is read on the computer.
      artifactBody(args[1]!, {
        expectedSize: nominated.size ?? 0,
        expectedSha256: nominated.sha256 ?? '0'.repeat(64),
        ...keep,
      });
    }
    const deletion = { deleteSnapshots: b('delete-snapshots'), expect: s('expect'), signal };
    if (path === 'computers delete') {
      P.deleteQuery(deletion);
      if (s('expect') && !b('delete-snapshots'))
        throw new CliError('invalid_arguments', '--expect requires --delete-snapshots');
    }
    const shot = {
      region: screenshotRegionFlag(s('region')),
      scale: n('scale'),
      format: s('format') as P.ScreenshotFormat | undefined,
      quality: n('quality'),
    };
    if (path === 'computers screenshot') P.screenshotQuery(n('width'), b('fresh'), shot);
    const capture = { memory: b('memory'), name: s('name'), wait: !b('no-wait'), ...wait };
    if (path === 'snapshots create') P.snapshotBody(capture.memory, capture.name);
    const schedule = { enabled: !b('disabled'), hour: n('hour'), minute: n('minute'), tz: s('tz') };
    if (path === 'snapshots schedule set') P.scheduleBody(schedule);
    let commandText: string | undefined;
    const execEnv: Record<string, string> = Object.create(null);
    if (path === 'computers exec') {
      for (const assignment of many('env') ?? []) {
        const index = assignment.indexOf('=');
        if (index <= 0) throw new CliError('invalid_arguments', '--env requires NAME=VALUE');
        const key = assignment.slice(0, index);
        if (Object.hasOwn(execEnv, key))
          throw new CliError('invalid_arguments', `duplicate --env ${key}`);
        execEnv[key] = assignment.slice(index + 1);
      }
      const input = io.stdin.isTTY ? '' : await readInput(io, signal);
      if (s('command') !== undefined && input.length)
        throw new CliError('invalid_arguments', 'choose -c command or stdin, not both');
      commandText = s('command') ?? input;
      if (!commandText.trim())
        throw new CliError('invalid_arguments', 'provide a nonempty -c command or piped stdin');
      P.execBody({
        command: commandText,
        timeoutS: n('timeout'),
        background: b('background'),
        cwd: s('cwd'),
        env: many('env') ? execEnv : undefined,
        desktop: b('desktop'),
      });
    }
    let document: string | undefined;
    if (['templates validate', 'templates publish', 'templates build'].includes(path)) {
      document = await documentInput(target, io, signal);
      P.templateDocument(document);
    }
    const agent = {
      prompt: target,
      modelKey: io.env.MANDALA_MODEL_KEY ?? '',
      maxSteps: n('max-steps'),
      model: s('model'),
      system: s('system'),
      signal,
    };
    if (path === 'agent run') {
      P.agentBody({ ...agent, stream: true });
      if (!agent.modelKey.trim())
        throw new CliError('missing_credentials', 'Set MANDALA_MODEL_KEY to run an agent');
    }
    const hook = {
      url: path === 'webhooks create' ? target : s('url'),
      description: s('description'),
      events: b('all-events') ? [] : many('event'),
      computers: b('all-computers') ? [] : many('computer'),
      enabled:
        path === 'webhooks create'
          ? !b('disabled')
          : b('enable')
            ? true
            : b('disable')
              ? false
              : undefined,
    };
    if (path === 'webhooks create') P.webhookCreateBody({ ...hook, url: target });
    if (path === 'webhooks update') P.webhookUpdateBody(hook);
    if (path === 'scp' || path === 'files upload' || path === 'files download') {
      const overwrite = { overwrite: !b('no-overwrite') };
      // Only when asked: absent is the default, which resumes a suspended
      // computer for the copy.
      const wake = b('no-wake') ? { noWake: true } : {};
      const result =
        path === 'scp'
          ? await legacy.scp(target, args[1]!, io, signal, overwrite)
          : path === 'files upload'
            ? await legacy.upload(target, args[1]!, args[2]!, io, signal, { ...overwrite, ...wake })
            : await legacy.download(target, args[1]!, args[2] ?? '.', io, signal, wake);
      if (json) return output.result(result);
      output.diagnostic(
        `${result.source} -> ${result.destination} (${result.accounting ?? `${result.bytes} bytes`})`,
      );
      return 0;
    }
    if (path === 'workspaces current')
      return workspacesCurrent(f.profile as string | undefined, io, output);
    if (path === 'workspaces use')
      return await workspacesUse(
        f.profile as string | undefined,
        args[0],
        b('clear') === true,
        io,
        output,
        signal,
      );
    const client = io.createClient();
    const computer = () => resolveComputer(client, target, signal);
    // An explicit --workspace always wins; without one, the profile's default.
    // A command that writes refuses an unreadable defaults.json rather than
    // going account-wide; `secrets list` and `computers list` read past it.
    // Called only on the paths that take one, since it may print a note.
    const scopeFlag = (mutating = true) =>
      s('workspace') ?? defaultWorkspace(f.profile as string | undefined, io, output, mutating);
    switch (path) {
      case 'account': {
        const quota = await client.account.read(call);
        const { raw: _raw, ...data } = quota;
        // The decoded fields only, spelled back in the API's snake_case.
        if (json) return output.result(snakeKeys(data));
        io.stdout.write(`${redact(accountText(quota), io.env, io.secrets)}\n`);
        return 0;
      }
      case 'whoami':
        return await whoamiCommand(client, io, output, signal);
      case 'api-keys list':
        return await apiKeysList(client, io, output, signal);
      case 'api-keys create':
        return await apiKeysCreate(
          client,
          io,
          output,
          { name: s('name'), workspace: scopeFlag() },
          signal,
        );
      case 'api-keys revoke':
        return await apiKeysRevoke(client, output, target, signal);
      case 'operations list': {
        const computerId =
          operationPage.computerId === undefined
            ? undefined
            : await operationsComputer(client, operationPage.computerId, output, signal);
        const page = await client.operations.list({ ...operationPage, computerId }, call);
        return output.result({
          operations: page.operations.map(raw),
          next_cursor: page.nextCursor,
        });
      }
      case 'operations get':
        return output.result(raw(await client.operations.get(target, call)));
      case 'moves list': {
        // The platform lists the account's moves, one row per computer at
        // most; the filter is applied here, to the id a name resolves to.
        const only =
          s('computer') === undefined
            ? undefined
            : await operationsComputer(client, s('computer')!, output, signal, 'moves');
        const moves = await client.moves.list(call);
        return output.result({
          moves: moves.filter((m) => only === undefined || m.computerId === only).map(moveData),
        });
      }
      case 'workspaces list':
        return output.result((await client.workspaces.list(call)).map(raw));
      case 'workspaces get':
        return output.result(
          raw(await readWorkspace(client, target, signal, (id) => client.workspaces.get(id, call))),
        );
      case 'workspaces members':
        return output.result(
          (
            await readWorkspace(client, target, signal, (id) => client.workspaces.members(id, call))
          ).map(raw),
        );
      case 'workspaces create':
        return output.result(raw(await client.workspaces.create({ name: target }, call)));
      case 'workspaces rename':
        return output.result(
          raw(
            await readWorkspace(
              client,
              target,
              signal,
              (id) => client.workspaces.rename(id, args[1]!, call),
              true,
            ),
          ),
        );
      case 'workspaces rm':
        // The answer carries `revoked_keys`: how many keys stopped working.
        return output.result(
          raw(
            await readWorkspace(
              client,
              target,
              signal,
              (id) => client.workspaces.delete(id, call),
              true,
            ),
          ),
        );
      case 'operations wait':
        return output.result(raw(await client.operations.wait(target, wait)));
      case 'usage': {
        const report = await client.usage.read(usageWindow);
        checkUsageReport(report.raw);
        const { raw: _raw, ...data } = report;
        if (json)
          return output.result(
            snakeKeys({ ...data, reportedThrough: report.reportedThrough ?? null }),
          );
        io.stdout.write(
          `${usageLines(report)
            .map((line) => terminalSafe(redact(line, io.env, io.secrets) as string))
            .join('\n')}\n`,
        );
        return 0;
      }
      case 'billing': {
        const [quota, report] = await Promise.all([
          client.account.read(call),
          client.usage.read(call),
        ]);
        checkUsageReport(report.raw);
        const { raw: _quotaRaw, ...account } = quota;
        const { raw: _usageRaw, ...usage } = report;
        if (json)
          return output.result({
            account: snakeKeys(account),
            usage: snakeKeys({ ...usage, reportedThrough: report.reportedThrough ?? null }),
          });
        io.stdout.write(
          `${billingLines(quota, report)
            .map((line) => terminalSafe(redact(line, io.env, io.secrets) as string))
            .join('\n')}\n`,
        );
        return 0;
      }
      case 'computers list': {
        const listing = await client.computers.listWithStatus({
          allowPartial: b('allow-partial'),
          state: s('state') as P.ComputerState | undefined,
          // An id, or `unassigned` for the computers in no workspace.
          workspaceId: scopeFlag(false),
          signal,
        });
        return output.result({
          items: listing.items.map(computerData),
          incomplete: listing.incomplete,
        });
      }
      case 'computers create': {
        // Before the secrets are looked up: an unreadable defaults.json refuses
        // the create here, with nothing sent.
        const workspaceId = scopeFlag();
        // Named in the scope the computer is created in: the workspace's own
        // secrets first, then the account-wide ones.
        const secrets = await secretBindings(
          client,
          bindings,
          signal,
          'nothing was created',
          workspaceId,
        );
        let created: Computer;
        try {
          created = await client.computers.create(
            { ...create, ...(secrets.length ? { secrets } : {}), workspaceId },
            keyed,
          );
        } catch (error) {
          throw scrubTypedTargets(error, bindings);
        }
        return output.result(withoutTypedTargets(computerData(created), bindings));
      }
      case 'computers get':
        return output.result(computerData(await (await computer()).refresh(call)));
      case 'computers start':
        return output.result(
          computerData(await (await computer()).start({ resumeOnly: b('resume-only'), ...keyed })),
        );
      case 'computers stop':
        return output.result(
          computerData(await (await computer()).stop({ force: b('force'), ...keyed })),
        );
      case 'computers suspend':
        return output.result(computerData(await (await computer()).suspend(keyed)));
      case 'computers restart':
        return output.result(computerData(await (await computer()).restart(keyed)));
      case 'computers clone':
        return output.result(computerData(await (await computer()).clone(s('name'), keyed)));
      case 'computers rename':
        return output.result(computerData(await (await computer()).rename(args[1]!, keyed)));
      case 'computers resize': {
        const c = await computer();
        try {
          return output.result(computerData(await c.update(resize, keyed)));
        } catch (error) {
          // The platform's refusal names the API route; this names the command.
          if (error instanceof MoveRequiredError && error.movePossible && !json)
            moveHint = `mandala: another host in this region can run that size: stop the computer and move it there with: mandala computers move ${c.id}${resize.ramMb === undefined ? ' --ram-mb MiB' : ` --ram-mb ${resize.ramMb}`}${resize.cpu === undefined ? '' : ` --cpu ${resize.cpu}`}${resize.diskGb === undefined ? '' : ` --disk-gb ${resize.diskGb}`} --wait`;
          throw error;
        }
      }
      case 'computers move': {
        const c = await computer();
        const accepted = await c.relocate(relocation, keyed);
        if (!b('wait')) return output.result(moveData(accepted));
        const outcome = await c.waitForMove(accepted, wait);
        // The three ways a move ends other than `done` are three situations,
        // and none of them is the size that was asked for (see Move.state).
        if (outcome.state !== 'done' && !json)
          output.diagnostic(
            outcome.state === 'moved'
              ? `mandala: ${c.id} moved to another host at its OLD size; the resize did not apply there: run computers resize again`
              : outcome.state === 'failed'
                ? `mandala: the move of ${c.id} failed; the computer is where it was, untouched${outcome.detail ? `: ${outcome.detail}` : ''}`
                : `mandala: the move of ${c.id} ended ${outcome.state}; read the computer to see where it is${outcome.detail ? `: ${outcome.detail}` : ''}`,
            { keepNewlines: false },
          );
        return output.result(moveData(outcome), outcome.state === 'done' ? 0 : 1);
      }
      case 'computers idle-suspend':
        return output.result(computerData(await (await computer()).update(idle!, keyed)));
      case 'computers browser-proxy set': {
        const c = await computer();
        let change = proxy!;
        if (keepProxyCredentials) {
          // Read fresh rather than off the listing the name was resolved from.
          const current = (await c.refresh(call)).browserProxy;
          const kept = current?.credentialsSecretId;
          if (kept) {
            // The credentials are sent to the proxy on every request, so they
            // follow only an unchanged server; a new one must be told which.
            if (!sameProxyServer(current!.server, args[1]!))
              throw new CliError(
                'invalid_arguments',
                `the proxy's credentials (${terminalSafe(kept)}) are for ${proxyServerText(current!.server)}, not ${proxyServerText(args[1]!)}; give --credentials SECRET_ID to use credentials with the new server, or --no-credentials to set it without any`,
              );
            change = { browserProxy: { ...change.browserProxy!, credentialsSecretId: kept } };
          }
        }
        return output.result(computerData(await c.update(change, keyed)));
      }
      case 'computers egress-proxy set': {
        const c = await computer();
        let change = proxy!;
        if (keepProxyCredentials) {
          // browser-proxy set's rule: read fresh, and carry the id over only
          // to an unchanged server, since the proxy is signed in to with it.
          const current = (await c.refresh(call)).egressProxy;
          const kept = current?.credentialsSecretId;
          if (kept) {
            if (!sameProxyServer(current!.server, args[1]!))
              throw new CliError(
                'invalid_arguments',
                `the egress proxy's credentials (${terminalSafe(kept)}) are for ${proxyServerText(current!.server)}, not ${proxyServerText(args[1]!)}; give --credentials SECRET_ID to use credentials with the new server, or --no-credentials to set it without any`,
              );
            change = { egressProxy: { ...change.egressProxy!, credentialsSecretId: kept } };
          }
        }
        return output.result(computerData(await c.update(change, keyed)));
      }
      case 'computers browser-proxy clear':
      case 'computers egress-proxy clear':
        return output.result(computerData(await (await computer()).update(proxy!, keyed)));
      case 'computers secrets get':
        return await computerSecretsGet(await computer(), output, signal);
      case 'computers secrets set':
        return await computerSecretsSet(client, await computer(), bindings, output, signal, {
          keepRevision: b('keep-revision') === true,
        });
      case 'computers view': {
        const c = await computer();
        const url = dashboardUrl(client.baseUrl, c.id);
        let opened = false;
        if (!b('no-open')) {
          try {
            opened = await (io.openBrowser ?? openBrowser)(url);
          } catch {
            /* The URL is printed either way. */
          }
        }
        if (json) return output.result({ id: c.id, name: c.name, url, opened });
        io.stdout.write(`${url}\n`);
        if (!b('no-open') && !opened)
          output.diagnostic('mandala: no browser could be opened; the URL is above.');
        return 0;
      }
      case 'computers delete': {
        const c = await computer();
        // Detailed, so a purge the platform answered 202 with `ok: false` —
        // copies still queued, or refused — is reported as not done rather
        // than as `deleted: true` and exit 0.
        const result = await c.delete({ ...deletion, ...keyed, detailed: true });
        if (!result.ok && !json)
          output.diagnostic(
            `mandala: the delete of ${c.id} did not complete${result.error ? `: ${result.error}` : ''}`,
            { keepNewlines: false },
          );
        return output.result(
          {
            id: c.id,
            ok: result.ok,
            deleted: result.computerDeleted ?? result.ok,
            computer_deleted: result.computerDeleted ?? null,
            snapshots_deleted: result.snapshotsDeleted ?? null,
            purge: result.purge === undefined ? null : snakeKeys(result.purge),
            error: result.error ?? null,
          },
          result.ok ? 0 : 1,
        );
      }
      case 'computers screenshot': {
        const shotInfo = await (await computer()).screenshotWithInfo(n('width'), {
          fresh: b('fresh'),
          ...shot,
          signal,
        });
        await writeFile(s('output')!, shotInfo.bytes, { signal });
        // A suspended computer answers with the frame it saved as it was
        // suspended, and the file alone cannot say so.
        if (shotInfo.suspended && !json)
          output.diagnostic(
            'mandala: this is the saved frame of a suspended computer, not a live capture; start it for a live one',
          );
        return output.result({
          path: s('output'),
          bytes: shotInfo.bytes.length,
          ...(shotInfo.suspended ? { suspended: true } : {}),
        });
      }
      case 'computers exec': {
        const c = await computer();
        const opts = {
          cwd: s('cwd'),
          env: many('env') ? execEnv : undefined,
          desktop: b('desktop'),
          signal,
        };
        const result = b('background')
          ? await c.execBackground(commandText!, opts)
          : await c.exec(commandText!, {
              ...opts,
              timeoutS: n('timeout'),
              ...(b('retain-output') ? { retainOutput: true } : {}),
            });
        const code =
          'timedOut' in result && result.timedOut
            ? 124
            : b('background')
              ? 0
              : result.exitCode !== undefined &&
                  Number.isInteger(result.exitCode) &&
                  result.exitCode >= 0 &&
                  result.exitCode <= 255
                ? result.exitCode
                : 1;
        const { stdout, stderr, raw: _raw, ...fields } = result;
        if (json || b('background'))
          return output.result(
            snakeKeys({
              ...fields,
              stdoutBase64: Buffer.from(stdout).toString('base64'),
              stderrBase64: Buffer.from(stderr).toString('base64'),
            }),
            code,
          );
        io.stdout.write(stdout);
        io.stderr.write(stderr);
        if (result.outTruncated || result.errTruncated)
          output.diagnostic('mandala: command output is incomplete (truncated)');
        if ('timedOut' in result && result.timedOut)
          output.diagnostic('mandala: command timed out');
        if (result.exitCode === -1) output.diagnostic('mandala: remote exit status is unknown');
        if ('resultId' in result && result.resultId !== undefined)
          output.diagnostic(`mandala: the output is retained as result ${result.resultId}`);
        return code;
      }
      case 'computers exec-poll':
      case 'computers exec-kill': {
        const c = await computer();
        const kill = path === 'computers exec-kill';
        // A poll is a cursor: each one hands over only what is new, and `more`
        // says another is waiting, so the output is read until it is not (to a
        // bound, past which a note says to poll again). A kill answers once,
        // with whatever had not been read.
        //
        // The platform does not hand a chunk over twice, so once one read has
        // answered, nothing it gave may be lost to a later read's failure: a
        // person's output is written as each chunk arrives, and a later read
        // that fails ends the drain with what was read and a note to poll again
        // (exit 1, or 130 when cancelled), rather than an error that drops it.
        // Only the first read's failure is thrown, since nothing was consumed.
        let state = kill ? await c.execKill(pid!, call) : await c.execPoll(pid!, call);
        const stdout = [state.stdout];
        const stderr = [state.stderr];
        const emit = (chunk: BackgroundExec) => {
          if (json) return;
          io.stdout.write(chunk.stdout);
          io.stderr.write(chunk.stderr);
        };
        emit(state);
        let drainError: unknown;
        for (let reads = 1; !kill && state.more && reads < EXEC_POLL_DRAIN; reads++) {
          try {
            state = await c.execPoll(pid!, call);
          } catch (error) {
            drainError = error;
            break;
          }
          stdout.push(state.stdout);
          stderr.push(state.stderr);
          emit(state);
        }
        const drained = drainError === undefined;
        const out = Buffer.concat(stdout);
        const err = Buffer.concat(stderr);
        // A kill that worked is the command's success; the status the killed
        // process ended with is in the output.
        const code = !drained
          ? controller.signal.aborted
            ? 130
            : 1
          : kill
            ? 0
            : backgroundExitStatus(state);
        const more = !drained || state.more;
        const {
          stdout: _out,
          stderr: _err,
          stdoutText: _outText,
          stderrText: _errText,
          raw: _raw,
          ...fields
        } = state;
        if (json)
          return output.result(
            snakeKeys({
              ...fields,
              more,
              stdoutBase64: out.toString('base64'),
              stderrBase64: err.toString('base64'),
              stdoutText: new TextDecoder().decode(out),
              stderrText: new TextDecoder().decode(err),
              // The output above was read and is not given out again; the read
              // after it failed, so the rest waits for another exec-poll.
              ...(drained ? {} : { drainError: errorInfo(drainError) }),
            }),
            code,
          );
        if (state.outTruncated || state.errTruncated)
          output.diagnostic('mandala: command output is incomplete (truncated)');
        if (!drained)
          output.diagnostic(
            `mandala: a later read failed (${errorInfo(drainError).message}); the output above was read and is not given out again; run computers exec-poll again for the rest`,
            { keepNewlines: false },
          );
        else if (more)
          output.diagnostic(`mandala: more output is waiting; run computers exec-poll again`);
        output.diagnostic(
          kill
            ? `mandala: pid ${state.pid} was killed${state.exitCode === undefined ? '' : `; it ended with status ${state.exitCode}`}`
            : state.running
              ? `mandala: pid ${state.pid} is still running; poll again for more`
              : state.exitCode === undefined || state.exitCode < 0
                ? `mandala: pid ${state.pid} has finished${state.killed ? ', killed' : ''}; its exit status is unknown`
                : `mandala: pid ${state.pid} has finished${state.killed ? ', killed' : ''}, with status ${state.exitCode}`,
        );
        return code;
      }
      case 'computers wait': {
        const c = await computer();
        const result =
          s('until') === 'built'
            ? await c.waitUntilBuilt(wait)
            : s('until') === 'guest'
              ? await c.waitForGuest(wait)
              : s('until') === 'desktop'
                ? await c.waitForDesktop(wait)
                : s('until') === 'secrets'
                  ? await c.waitForSecrets(wait)
                  : s('until') === 'browser-proxy'
                    ? await c.waitForBrowserProxy(wait)
                    : s('until') === 'egress-proxy'
                      ? await c.waitForEgressProxy(wait)
                      : await c.waitUntilRunning(wait);
        return output.result(computerData(result));
      }
      case 'sizes list': {
        const sizes = await client.sizes.list(call);
        return output.result({
          items: sizes.map((size) => ({
            id: size.id,
            label: size.label,
            template: size.template,
            cpu: size.cpu,
            ram_mb: size.ramMb,
            disk_gb: size.diskGb,
            allowed: size.allowed,
            cheapest_plan: size.cheapestPlan ?? null,
          })),
        });
      }
      case 'templates list': {
        const listing = await client.templates.listWithStatus(call);
        return output.result({ items: listing.items.map(raw), incomplete: listing.incomplete });
      }
      case 'templates get':
        return output.result(
          raw(await client.templates.get(target, args[1]!, { version: s('version'), signal })),
        );
      case 'templates retire':
        return output.result(
          raw(await client.templates.retire(target, args[1]!, { version: s('version'), signal })),
        );
      case 'templates validate': {
        const result = await client.templates.validate(document!, call);
        return output.result(raw(result), result.valid ? 0 : 1);
      }
      case 'templates publish':
        return output.result(raw(await client.templates.publish(document!, call)));
      case 'templates build':
        return output.result(
          raw(await client.builds.start(document!, { noReuse: b('no-reuse'), signal })),
        );
      case 'templates schema':
        return output.result(await client.templates.schema(call));
      case 'builds list': {
        const listing = await client.builds.listWithStatus({
          allowPartial: b('allow-partial'),
          signal,
        });
        return output.result({ items: listing.items.map(raw), incomplete: listing.incomplete });
      }
      case 'builds get':
        return output.result(raw(await client.builds.get(target, call)));
      case 'builds progress':
        return output.result(snakeKeys(await client.builds.progress(target, call)));
      case 'templates watch': {
        watching = true;
        let last: BuildProgress | undefined;
        for await (const progress of client.builds.events(target, call)) {
          last = progress;
          output.frame('progress', snakeKeys(progress));
        }
        if (!last?.done)
          throw new CliError('incomplete_stream', 'Build stream ended without a final result');
        const code = last.status === 'succeeded' ? 0 : 1;
        output.frame('done', snakeKeys({ ...last, exitCode: code }));
        return code;
      }
      case 'snapshots list': {
        const listing = await client.snapshots.listWithStatus({
          computerId: s('computer'),
          includeUnfinished: b('include-unfinished'),
          allowPartial: b('allow-partial'),
          signal,
        });
        return output.result({ items: listing.items.map(raw), incomplete: listing.incomplete });
      }
      case 'snapshots create':
        return output.result(raw(await (await computer()).snapshot(capture)));
      case 'snapshots restore': {
        // The ack names the operation to read for how the restore ended.
        const ack = await client.snapshots.restore(target, keyed);
        return output.result({
          id: target,
          restored: true,
          operation_id: ack.operationId ?? null,
        });
      }
      case 'snapshots clone':
        // `memory_dropped` rides in the record itself, so it is in the output
        // without being asked for (platform OPL-4964).
        return output.result(
          computerData(
            await client.snapshots.clone(target, s('name'), {
              ...keyed,
              ...(b('disk-only') ? { memory: false } : {}),
              ...(b('inherit-secrets') ? { inheritSecrets: true } : {}),
            }),
          ),
        );
      case 'snapshots delete':
        await client.snapshots.delete(target, { wait: !b('no-wait'), ...wait });
        return output.result({ id: target, accepted: true, waited: !b('no-wait') });
      case 'snapshots holdings':
        return output.result(raw(await (await computer()).holdings(call)));
      case 'snapshots schedule get':
        return output.result(raw(await (await computer()).schedule(call)));
      case 'snapshots schedule set':
        return output.result(raw(await (await computer()).setSchedule(schedule, call)));
      case 'snapshots schedule clear':
        return output.result(raw(await (await computer()).clearSchedule(call)));
      case 'snapshots retention':
        return output.result(raw(await client.snapshots.retention(call)));
      case 'webhooks list':
        return output.result((await client.webhooks.list(call)).map((item) => publicWebhook(item)));
      case 'webhooks get':
        return output.result(publicWebhook(await client.webhooks.get(target, call)));
      case 'webhooks create': {
        const created = await client.webhooks.create({ ...hook, url: target }, call);
        output.diagnostic('Store the new webhook secret now; it cannot be read again.');
        return output.result(publicWebhook(created, created.secret));
      }
      case 'webhooks update':
        return output.result(publicWebhook(await client.webhooks.update(target, hook, call)));
      case 'webhooks delete':
        await client.webhooks.delete(target, call);
        return output.result({ id: target, deleted: true });
      case 'webhooks rotate': {
        const rotated = await client.webhooks.rotate(target, call);
        output.diagnostic(
          'Store the new webhook secret now; the old secret is honoured for 24 hours.',
        );
        return output.result(publicWebhook(rotated, rotated.secret));
      }
      case 'webhooks test':
        return output.result(raw(await client.webhooks.test(target, call)));
      case 'webhooks deliveries':
        return output.result((await client.webhooks.deliveries(target, call)).map(raw));
      case 'secrets list':
        return await secretsList(client, io, output, scopeFlag(false), signal);
      case 'secrets set':
        return await secretsSet(client, io, output, target, scopeFlag(), signal, {
          valueCheck: !b('no-value-check'),
          keepNewline: b('keep-newline'),
        });
      case 'secrets get':
        return await secretsGet(client, io, output, target, scopeFlag(false), signal);
      case 'secrets rm':
        return await secretsRemove(client, io, output, target, scopeFlag(), signal);
      case 'files list': {
        const dir = await (await computer()).listDirectory(args[1]!, call);
        const { raw: _raw, ...data } = dir;
        if (json) return output.result(snakeKeys(data));
        io.stdout.write(redact(directoryText(dir), io.env, io.secrets) as string);
        if (dir.truncated)
          output.diagnostic(
            'mandala: this directory is larger than one listing: the entries above are an unordered part of it; list a narrower path',
          );
        if (dir.skipped)
          output.diagnostic(
            `mandala: ${dir.skipped} name${dir.skipped === 1 ? '' : 's'} left out of the listing (the computer does not send a name that is not UTF-8 or holds an ASCII control character)`,
          );
        if (dir.entries.some((e) => terminalSafe(e.name) !== e.name))
          output.diagnostic(
            'mandala: control and bidi characters in the names above are shown escaped, as \\uXXXX; --json has the exact names',
          );
        return 0;
      }
      case 'artifacts get':
        return output.result(artifactData(await (await computer()).artifact(args[1]!, call)));
      case 'artifacts export': {
        const c = await computer();
        let expected = nominated as { size: number; sha256: string };
        if (nominated.size === undefined) {
          // Read on the computer, which must be running for the capture anyway;
          // a stopped or suspended one is not woken by this read.
          if (c.status !== 'running')
            throw new CliError(
              'not_running',
              `${c.id} is ${terminalSafe(c.status)}; an artifact is captured from a running computer, so start it first`,
            );
          // The read is a POSIX shell command (bash, wc, sha256sum) with the
          // path quoted for that shell. On any other guest, Windows' cmd.exe
          // above all, the quoting means nothing and a path holding `&`, `|`
          // or `>` would run extra commands, so only a Linux computer is read;
          // an empty or unknown os is refused too.
          if (c.os !== 'linux')
            throw new CliError(
              'unsupported',
              `the size and SHA-256 can only be read on a Linux computer, and ${c.id} runs ${terminalSafe(c.os || 'an unknown os')}; ` +
                'give them with --size and --sha256 to publish without this read',
            );
          expected = await guestFileDigest(c, args[1]!, signal);
          const cap = keep.maxBytes ?? ARTIFACT_DEFAULT_BYTES;
          if (expected.size > cap)
            throw new CliError(
              'invalid_arguments',
              `${terminalSafe(args[1]!)} is ${expected.size} bytes, over the ${cap}-byte limit; ` +
                `raise it with --max-bytes (at most ${ARTIFACT_MAX_BYTES})`,
            );
        }
        return output.result(
          artifactData(
            await c.publishArtifact(args[1]!, {
              expectedSize: expected.size,
              expectedSha256: expected.sha256,
              ...keep,
              signal,
            }),
          ),
        );
      }
      case 'artifacts download': {
        const c = await computer();
        // Up to the largest artifact there is: the cap is the SDK's guard for a
        // program holding the bytes, and this command's whole job is to save them.
        const data = await c.downloadArtifact(args[1]!, { maxBytes: ARTIFACT_MAX_BYTES, signal });
        const dest = s('output') ?? `${args[1]}.bin`;
        // Written only once every byte has matched the SHA-256.
        await writeFile(dest, data, { signal });
        return output.result({ artifact_id: args[1], path: dest, bytes: data.length });
      }
      case 'artifacts rm':
        await (await computer()).deleteArtifact(args[1]!, call);
        return output.result({ artifact_id: args[1], deleted: true });
      case 'ssh':
        return await sshSetup(client, io, output, ssh, target, s('key'), signal);
      case 'ssh-key list':
        return await sshKeyList(client, io, output);
      case 'ssh-key add':
        return await sshKeyAdd(client, io, output, ssh, args[0], s('name'));
      case 'ssh-key rm':
        return await sshKeyRemove(client, io, output, target);
      case 'ssh-access':
        return await sshAccessCommand(await computer(), io, output, args[1]);
      case 'ssh-config': {
        // The listing the lookup read is also what tells a shared name apart.
        const seen: { listing?: Listing<Computer> } = {};
        const c = await resolveComputer(client, target, signal, seen);
        return await sshConfigCommand(c, seen.listing, io, output, ssh, b('write') ?? false);
      }
      case 'agent run': {
        const c = await resolveComputer(client, s('computer')!, signal);
        watching = true;
        for await (const event of c.agentStream(agent)) {
          if (event.type === 'error')
            return output.error(
              new CliError('agent_error', event.error, {
                status: event.status,
                steps: event.steps,
                usage: event.usage,
              }),
              1,
              true,
            );
          if (event.type === 'done') {
            const code = event.result.finished ? 0 : 1;
            const { raw: _raw, ...summary } = event.result;
            output.frame('done', snakeKeys({ ...summary, exitCode: code }));
            return code;
          }
          output.frame(event.type, event.type === 'step' ? snakeKeys(event.step) : event.text);
        }
        throw new CliError('incomplete_stream', 'Agent stream ended without a result');
      }
      default:
        throw new CliError('invalid_arguments', `unknown command ${path}`);
    }
  } catch (error) {
    if (error instanceof CredentialSaveError && error.committed) return output.error(error);
    if (controller.signal.aborted)
      return output.error(new CliError('cancelled', 'Cancelled'), 130, watching);
    // Preserve stacks for programming faults in the human CLI, including terminal DOMExceptions.
    if (
      !output.json &&
      !(
        error instanceof CliError ||
        error instanceof MandalaError ||
        error instanceof ValidationError
      ) &&
      errorInfo(error).code === 'internal_error'
    )
      throw error;
    const exitCode = error instanceof CliError && error.exitCode !== undefined ? error.exitCode : 1;
    const code = output.error(error, exitCode, watching);
    if (moveHint) output.diagnostic(moveHint, { keepNewlines: false });
    return code;
  } finally {
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
  }
}
