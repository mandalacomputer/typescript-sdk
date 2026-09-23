import { writeFile } from 'node:fs/promises';
import process from 'node:process';
import { completion } from './cli-completion.js';
import { loginCommand } from './cli-login.js';
import { manifest } from './cli-manifest.js';
import { CliError, help, type Parsed, parseArgs } from './cli-options.js';
import { errorInfo, Output, redact } from './cli-output.js';
import { type CliIO, documentInput, readInput } from './cli-runtime.js';
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
import { CredentialSaveError } from './credentials.js';
import { MandalaError, NotFoundError, ValidationError } from './errors.js';
import type { AccountQuota, BuildProgress, Client, Listing, UsageReport } from './index.js';
import * as P from './paths.js';
import { checkWait } from './wait.js';

export type LegacyCommands = {
  terminal: (computer: string, session: string, io: CliIO) => Promise<number>;
  scp: (
    source: string,
    destination: string,
    io: CliIO,
    signal: AbortSignal,
  ) => Promise<{
    source: string;
    destination: string;
    bytes: number;
    confirmed: boolean;
    accounting?: string;
  }>;
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

/** Format the SDK's public projection explicitly; never expose desktop credentials. */
const computerData = (computer: Computer) => computer.toJSON();
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
  ].join('\n');
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

function usageText(u: UsageReport): string {
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
  ].join('\n');
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

export async function runCli(argv: string[], io: CliIO, legacy: LegacyCommands): Promise<number> {
  // Used only if parsing fails before it can return its explicit output mode.
  let output = new Output(io, '', argv.includes('--json'));
  let parsed: Parsed | undefined;
  const controller = new AbortController();
  let watching = false;
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
    const usageWindow = { from: s('from'), to: s('to'), signal };
    if (path === 'usage') checkUsageWindow(usageWindow.from, usageWindow.to);
    // Preparation and pure SDK validation happen before name resolution or any request.
    const create = {
      name: s('name'),
      size: s('size'),
      template: s('template'),
      templateTransfer: s('template-transfer'),
      cpu: n('cpu'),
      ramMb: n('ram-mb'),
      diskGb: n('disk-gb'),
      resolution: s('resolution'),
      start: !b('no-start'),
    };
    if (path === 'computers create') P.createBody(create);
    const deletion = { deleteSnapshots: b('delete-snapshots'), expect: s('expect'), signal };
    if (path === 'computers delete') {
      P.deleteQuery(deletion);
      if (s('expect') && !b('delete-snapshots'))
        throw new CliError('invalid_arguments', '--expect requires --delete-snapshots');
    }
    if (path === 'computers screenshot') P.screenshotQuery(n('width'), b('fresh'));
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
    if (path === 'scp') {
      const result = await legacy.scp(target, args[1]!, io, signal);
      if (json) return output.result(result);
      output.diagnostic(
        `${result.source} -> ${result.destination} (${result.accounting ?? `${result.bytes} bytes`})`,
      );
      return 0;
    }
    const client = io.createClient();
    const computer = () => resolveComputer(client, target, signal);
    switch (path) {
      case 'account': {
        const quota = await client.account.read(call);
        const { raw: _raw, ...data } = quota;
        if (json) return output.result(data);
        io.stdout.write(`${redact(accountText(quota), io.env, io.secrets)}\n`);
        return 0;
      }
      case 'usage': {
        const report = await client.usage.read(usageWindow);
        checkUsageReport(report.raw);
        const { raw: _raw, ...data } = report;
        if (json)
          return output.result({ ...data, reportedThrough: report.reportedThrough ?? null });
        io.stdout.write(`${redact(usageText(report), io.env, io.secrets)}\n`);
        return 0;
      }
      case 'computers list': {
        const listing = await client.computers.listWithStatus({
          allowPartial: b('allow-partial'),
          state: s('state') as P.ComputerState | undefined,
          signal,
        });
        return output.result({
          items: listing.items.map(computerData),
          incomplete: listing.incomplete,
        });
      }
      case 'computers create':
        return output.result(computerData(await client.computers.create(create, call)));
      case 'computers get':
        return output.result(computerData(await (await computer()).refresh(call)));
      case 'computers start':
        return output.result(
          computerData(await (await computer()).start({ resumeOnly: b('resume-only'), signal })),
        );
      case 'computers stop':
        return output.result(
          computerData(await (await computer()).stop({ force: b('force'), signal })),
        );
      case 'computers suspend':
        return output.result(computerData(await (await computer()).suspend(call)));
      case 'computers restart':
        return output.result(computerData(await (await computer()).restart(call)));
      case 'computers clone':
        return output.result(computerData(await (await computer()).clone(s('name'), call)));
      case 'computers delete': {
        const c = await computer();
        const snapshotsDeleted = await c.delete(deletion);
        return output.result({
          id: c.id,
          deleted: true,
          snapshotsDeleted: snapshotsDeleted ?? null,
        });
      }
      case 'computers screenshot': {
        const bytes = await (await computer()).screenshot(n('width'), {
          fresh: b('fresh'),
          signal,
        });
        await writeFile(s('output')!, bytes, { signal });
        return output.result({ path: s('output'), bytes: bytes.length });
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
          : await c.exec(commandText!, { ...opts, timeoutS: n('timeout') });
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
            {
              ...fields,
              stdoutBase64: Buffer.from(stdout).toString('base64'),
              stderrBase64: Buffer.from(stderr).toString('base64'),
            },
            code,
          );
        io.stdout.write(stdout);
        io.stderr.write(stderr);
        if (result.outTruncated || result.errTruncated)
          output.diagnostic('mandala: command output is incomplete (truncated)');
        if ('timedOut' in result && result.timedOut)
          output.diagnostic('mandala: command timed out');
        if (result.exitCode === -1) output.diagnostic('mandala: remote exit status is unknown');
        return code;
      }
      case 'computers wait': {
        const c = await computer();
        const result =
          s('until') === 'built'
            ? await c.waitUntilBuilt(wait)
            : s('until') === 'guest'
              ? await c.waitForGuest(wait)
              : await c.waitUntilRunning(wait);
        return output.result(computerData(result));
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
      case 'templates watch': {
        watching = true;
        let last: BuildProgress | undefined;
        for await (const progress of client.builds.events(target, call)) {
          last = progress;
          output.frame('progress', progress);
        }
        if (!last?.done)
          throw new CliError('incomplete_stream', 'Build stream ended without a final result');
        const code = last.status === 'succeeded' ? 0 : 1;
        output.frame('done', { ...last, exitCode: code });
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
      case 'snapshots restore':
        await client.snapshots.restore(target, call);
        return output.result({ id: target, restored: true });
      case 'snapshots clone':
        // `memory_dropped` rides in the record itself, so it is in the output
        // without being asked for (platform OPL-4964).
        return output.result(
          computerData(
            await client.snapshots.clone(target, s('name'), {
              ...call,
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
            output.frame('done', { ...summary, exitCode: code });
            return code;
          }
          output.frame(event.type, event.type === 'step' ? event.step : event.text);
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
    return output.error(error, exitCode, watching);
  } finally {
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
  }
}
