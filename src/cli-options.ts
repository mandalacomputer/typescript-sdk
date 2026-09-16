/** Shared command inventory for parsing, help, manifest, and shell completions. */
export type Flag = {
  name: string;
  alias?: string;
  type: 'boolean' | 'string' | 'number';
  description: string;
  required?: boolean;
  repeatable?: boolean;
  choices?: readonly string[];
  conflicts?: readonly string[];
};

export type Command = {
  path: string;
  description: string;
  /** Positional names; a trailing `?` marks an optional one (shown as `[name]`). */
  args: readonly string[];
  argumentChoices?: Readonly<Record<string, readonly string[]>>;
  flags: readonly Flag[];
  jsonMode?: 'unsupported' | 'ndjson';
  /**
   * Everything after the positionals is handed on verbatim (`mandala ssh`),
   * unless one of these flags was given before them.
   */
  passthrough?: { unless: readonly string[] };
};

const flag = (name: string, description: string, opts: Partial<Flag> = {}): Flag => ({
  name,
  description,
  type: 'string',
  ...opts,
});
const bool = (name: string, description: string, opts: Partial<Flag> = {}): Flag =>
  flag(name, description, { type: 'boolean', ...opts });
const num = (name: string, description: string, opts: Partial<Flag> = {}): Flag =>
  flag(name, description, { type: 'number', ...opts });
const name = flag('name', 'Name for the new resource');
const partial = bool(
  'allow-partial',
  'Allow incomplete listings; output retains incomplete status',
);
const waits = [
  num('timeout-ms', 'Wait deadline in milliseconds'),
  num('poll-ms', 'Poll interval in milliseconds'),
];
const noWait = bool('no-wait', 'Return after acceptance without waiting for completion');
const version = flag('version', 'Template version; omit on retire to retire every version');
const event = flag('event', 'Event type; repeat for several', {
  repeatable: true,
  conflicts: ['all-events'],
});
const computers = flag('computer', 'Computer ID filter; repeat for several', {
  repeatable: true,
  conflicts: ['all-computers'],
});
const command = (
  path: string,
  description: string,
  args: string[] = [],
  flags: Flag[] = [],
  jsonMode?: Command['jsonMode'],
): Command => ({ path, description, args, flags, jsonMode });

export const GLOBAL_FLAGS: readonly Flag[] = [
  flag('profile', 'Local credential profile (after explicit/environment API keys)'),
  bool('json', 'Emit version 1 JSON; streaming commands emit NDJSON'),
  bool('help', 'Show help without credentials or network', { alias: 'h' }),
];

export const COMMANDS: readonly Command[] = [
  command(
    'login',
    'Sign in through browser approval and save a local credential',
    [],
    [
      flag('workspace', 'Request exactly one workspace (default: whole account)'),
      flag('base-url', 'Explicit login API base (default: MANDALA_BASE_URL or public API)'),
    ],
  ),
  command('account', 'Read instantaneous account-wide quota and advisory headroom'),
  command(
    'usage',
    'Read historical metered usage (default: current billing period)',
    [],
    [
      flag('from', 'Window start: RFC 3339 timestamp with a time zone'),
      flag(
        'to',
        'Window end: RFC 3339 timestamp with a time zone; future ends are capped by the API',
      ),
    ],
  ),
  command(
    'computers list',
    'List computers with completeness status',
    [],
    [
      partial,
      flag('state', 'Computer lifecycle state', {
        choices: ['live', 'unreachable', 'deleting', 'deleted', 'lost'],
      }),
    ],
  ),
  command(
    'computers create',
    'Create a computer',
    [],
    [
      name,
      flag('size', 'Named size', {
        conflicts: ['template', 'cpu', 'ram-mb', 'disk-gb', 'template-transfer'],
      }),
      flag('template', 'Template reference'),
      flag('template-transfer', 'Preparation token for the original template'),
      num('cpu', 'vCPU count'),
      num('ram-mb', 'RAM in MiB'),
      num('disk-gb', 'Disk in GiB'),
      flag('resolution', 'WIDTHxHEIGHT or WIDTHxHEIGHTxDEPTH'),
      bool('no-start', 'Create without starting'),
    ],
  ),
  command('computers get', 'Get a computer by name or ID', ['computer']),
  command(
    'computers start',
    'Start or resume a computer',
    ['computer'],
    [bool('resume-only', 'Require an existing suspended state')],
  ),
  command('computers stop', 'Stop a computer', ['computer'], [bool('force', 'Force power off')]),
  command('computers suspend', 'Suspend a computer', ['computer']),
  command('computers restart', 'Restart a computer', ['computer']),
  command(
    'computers delete',
    'Delete a computer',
    ['computer'],
    [
      bool('delete-snapshots', 'Also delete snapshots; requires --expect'),
      flag('expect', 'Snapshot holdings fingerprint'),
    ],
  ),
  command('computers clone', 'Clone a computer', ['computer'], [name]),
  command(
    'computers screenshot',
    'Save exact screenshot bytes to a file',
    ['computer'],
    [
      flag('output', 'Destination file', { alias: 'o', required: true }),
      num('width', 'Image width'),
      bool('fresh', 'Request a fresh screenshot'),
    ],
  ),
  command(
    'computers exec',
    'Execute -c text or piped stdin; return the remote exit status',
    ['computer'],
    [
      flag('command', 'Command text; otherwise read stdin', { alias: 'c' }),
      num('timeout', 'Foreground execution timeout in seconds', { conflicts: ['background'] }),
      bool('background', 'Start a background command and return its handle'),
      flag('cwd', 'Working directory'),
      flag('env', 'NAME=VALUE; repeat for several', { repeatable: true }),
      bool('desktop', 'Run on the desktop'),
    ],
  ),
  command(
    'computers wait',
    'Wait for a computer',
    ['computer'],
    [
      flag('until', 'Readiness condition (default running)', {
        choices: ['built', 'running', 'guest'],
      }),
      ...waits,
    ],
  ),
  command('templates list', 'List templates with completeness status'),
  command('templates get', 'Read a published template', ['namespace', 'name'], [version]),
  command('templates validate', 'Validate a template document from a file or - for stdin', [
    'file',
  ]),
  command('templates publish', 'Publish a template document from a file or - for stdin', ['file']),
  command(
    'templates build',
    'Start a template build from a file or - for stdin',
    ['file'],
    [bool('no-reuse', 'Build even if an image can be reused')],
  ),
  command(
    'templates watch',
    'Stream build progress until a terminal result',
    ['build'],
    [],
    'ndjson',
  ),
  command('templates retire', 'Retire a template', ['namespace', 'name'], [version]),
  command(
    'snapshots list',
    'List snapshots with completeness status',
    [],
    [
      partial,
      flag('computer', 'Filter by computer ID'),
      bool('include-unfinished', 'Include unfinished deletions'),
    ],
  ),
  command(
    'snapshots create',
    'Capture a computer snapshot',
    ['computer'],
    [name, bool('memory', 'Include memory'), noWait, ...waits],
  ),
  command('snapshots restore', 'Restore a snapshot', ['snapshot']),
  command('snapshots clone', 'Clone a snapshot into a computer', ['snapshot'], [name]),
  command('snapshots delete', 'Delete a snapshot', ['snapshot'], [noWait, ...waits]),
  command('snapshots holdings', 'Read snapshot count, bytes and fingerprint', ['computer']),
  command('snapshots schedule get', 'Read the daily snapshot schedule', ['computer']),
  command(
    'snapshots schedule set',
    'Set or disable the daily snapshot schedule',
    ['computer'],
    [
      bool('disabled', 'Keep the window but disable capture'),
      num('hour', 'Hour in the selected timezone'),
      num('minute', 'Minute'),
      flag('tz', 'IANA timezone'),
    ],
  ),
  command('snapshots schedule clear', 'Remove the daily snapshot schedule', ['computer']),
  command('snapshots retention', 'Read snapshot retention settings'),
  command('webhooks list', 'List webhook subscriptions'),
  command(
    'webhooks create',
    'Create a subscription; prints the new secret once',
    ['url'],
    [
      flag('description', 'Subscription description'),
      event,
      computers,
      bool('disabled', 'Create disabled'),
    ],
  ),
  command('webhooks get', 'Read a subscription', ['id']),
  command(
    'webhooks update',
    'Update a subscription',
    ['id'],
    [
      flag('url', 'New HTTPS endpoint'),
      flag('description', 'Subscription description'),
      event,
      computers,
      bool('all-events', 'Clear the event filter'),
      bool('all-computers', 'Clear the computer filter'),
      bool('enable', 'Enable delivery', { conflicts: ['disable'] }),
      bool('disable', 'Disable delivery'),
    ],
  ),
  command('webhooks delete', 'Delete a subscription and its delivery records', ['id']),
  command('webhooks rotate', 'Rotate the secret; prints the new secret once', ['id']),
  command('webhooks test', 'Queue a test delivery; inspect deliveries for its outcome', ['id']),
  command('webhooks deliveries', 'List delivery attempts', ['id']),
  command(
    'agent run',
    'Run an agent with MANDALA_MODEL_KEY',
    ['prompt'],
    [
      flag('computer', 'Target computer name or ID', { required: true }),
      num('max-steps', 'Maximum desktop actions'),
      flag('model', 'Model override'),
      flag('system', 'Standing instructions'),
    ],
    'ndjson',
  ),
  {
    ...command(
      'ssh',
      'OpenSSH session through the Mandala gateway; arguments after the computer go to ssh',
      ['computer'],
      [
        bool('setup', 'Register your public key if needed, turn SSH on, print the connect command'),
        flag(
          'key',
          'Public key for --setup (default: ~/.ssh/id_ed25519.pub, id_ecdsa.pub, id_rsa.pub)',
        ),
      ],
      'unsupported',
    ),
    passthrough: { unless: ['setup'] },
  },
  command('ssh-key list', 'List your registered SSH public keys'),
  command(
    'ssh-key add',
    'Register an SSH public key (default: ~/.ssh/id_ed25519.pub, id_ecdsa.pub, id_rsa.pub)',
    ['path?'],
    [flag('name', 'Label for the key (default: the key comment)')],
  ),
  command('ssh-key rm', 'Remove a registered SSH public key', ['id']),
  {
    ...command('ssh-access', 'Show SSH status for a computer, or turn it on or off', [
      'computer',
      'state?',
    ]),
    argumentChoices: { state: ['on', 'off'] },
  },
  command(
    'ssh-config',
    'Print a ~/.ssh/config block for ssh, scp, sftp and VS Code Remote-SSH',
    ['computer'],
    [bool('write', 'Add or replace the block in ~/.ssh/config')],
  ),
  command(
    'terminal',
    'Interactive shell; --json fails before connecting',
    ['computer'],
    [flag('session', 'Terminal session name (default main)', { alias: 's' })],
    'unsupported',
  ),
  command('scp', 'Copy one file; exactly one side is computer:/path', ['src', 'dst']),
  command('manifest', 'Print the machine-readable command contract'),
  {
    ...command('completion', 'Print a shell completion script; does not install it', ['shell']),
    argumentChoices: { shell: ['bash', 'zsh', 'fish'] },
  },
];

export class CliError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
    /** The process exit status, when it is not 1. */
    public readonly exitCode?: number,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

export type Parsed = {
  command?: Command;
  path: string;
  args: string[];
  flags: Record<string, string | number | boolean | string[]>;
  help: boolean;
  json: boolean;
  /** Arguments handed on verbatim, for a command with {@link Command.passthrough}. */
  rest: string[];
};

export function usage(c: Command): string {
  return `mandala ${c.path}${c.args.map((a) => (a.endsWith('?') ? ` [${a.slice(0, -1)}]` : ` <${a}>`)).join('')}${c.passthrough ? ' [ssh-args...]' : ''}`;
}

export function parseArgs(argv: string[]): Parsed {
  const parsed: Parsed = { path: '', args: [], flags: {}, help: false, json: false, rest: [] };
  let positional = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const through = parsed.command?.passthrough;
    if (
      through &&
      parsed.args.length === parsed.command!.args.length &&
      !through.unless.some((name) => parsed.flags[name] !== undefined)
    ) {
      parsed.rest = argv.slice(i);
      break;
    }
    if (!positional && arg === '--') {
      positional = true;
      continue;
    }
    if (!positional && arg.startsWith('-') && arg !== '-') {
      const [spelling, ...tail] = arg.split('=');
      const flags = [...GLOBAL_FLAGS, ...(parsed.command?.flags ?? [])];
      const spec = flags.find((f) => spelling === `--${f.name}` || spelling === `-${f.alias}`);
      if (!spec) throw new CliError('invalid_arguments', `unknown option ${spelling}`);
      if (parsed.flags[spec.name] !== undefined && !spec.repeatable)
        throw new CliError('invalid_arguments', `--${spec.name} may only be supplied once`);
      let value: string | number | boolean = true;
      if (spec.type === 'boolean') {
        if (tail.length) throw new CliError('invalid_arguments', `--${spec.name} takes no value`);
      } else {
        const raw = tail.length ? tail.join('=') : argv[++i];
        if (
          raw === undefined ||
          (raw.startsWith('--') && !tail.length) ||
          (!raw.trim() && spec.name !== 'description')
        ) {
          throw new CliError(
            'invalid_arguments',
            `--${spec.name} needs ${spec.name === 'session' ? 'a name' : 'a value'}`,
          );
        }
        value = spec.type === 'number' ? Number(raw) : raw;
        if (
          spec.type === 'number' &&
          (!/^-?(?:\d+\.?\d*|\.\d+)$/.test(raw) || !Number.isFinite(value))
        )
          throw new CliError('invalid_arguments', `--${spec.name} needs a finite number`);
        if (spec.choices && !spec.choices.includes(raw))
          throw new CliError(
            'invalid_arguments',
            `--${spec.name} must be one of: ${spec.choices.join(', ')}`,
          );
      }
      if (spec.repeatable) parsed.flags[spec.name] ??= [];
      if (spec.repeatable) (parsed.flags[spec.name] as string[]).push(value as string);
      else parsed.flags[spec.name] = value;
      if (spec.name === 'json') parsed.json = true;
      if (spec.name === 'help') parsed.help = true;
      continue;
    }
    if (!parsed.command && arg === 'help' && !parsed.path) {
      parsed.help = true;
      continue;
    }
    if (!parsed.command) {
      parsed.path = [parsed.path, arg].filter(Boolean).join(' ');
      parsed.command = COMMANDS.find((c) => c.path === parsed.path);
      if (!parsed.command && !COMMANDS.some((c) => c.path.startsWith(`${parsed.path} `)))
        throw new CliError('invalid_arguments', `unknown command ${parsed.path}`);
    } else parsed.args.push(arg);
  }
  if (parsed.help || !argv.length) return parsed;
  const c = parsed.command;
  if (!c)
    throw new CliError(
      'invalid_arguments',
      `choose a command${parsed.path ? ` under ${parsed.path}` : ''}; use --help`,
    );
  const required = c.args.filter((a) => !a.endsWith('?')).length;
  if (
    parsed.args.length < required ||
    parsed.args.length > c.args.length ||
    parsed.args.some((a) => !a.trim())
  )
    throw new CliError(
      'invalid_arguments',
      c.path === 'terminal' && parsed.args.length > 1
        ? 'mandala terminal takes one computer and runs no command'
        : usage(c),
    );
  c.args.forEach((name, i) => {
    const bare = name.replace(/\?$/, '');
    const choices = c.argumentChoices?.[bare];
    if (choices && i < parsed.args.length && !choices.includes(parsed.args[i]!))
      throw new CliError('invalid_arguments', `${bare} must be one of: ${choices.join(', ')}`);
  });
  for (const f of c.flags) {
    if (f.required && parsed.flags[f.name] === undefined)
      throw new CliError('invalid_arguments', `${usage(c)} requires --${f.name}`);
    if (parsed.flags[f.name] !== undefined)
      for (const conflict of f.conflicts ?? []) {
        if (parsed.flags[conflict] !== undefined)
          throw new CliError('invalid_arguments', `--${f.name} conflicts with --${conflict}`);
      }
  }
  return parsed;
}

export function help(path = ''): string {
  const matches = COMMANDS.filter((c) => !path || c.path === path || c.path.startsWith(`${path} `));
  const exact = matches.length === 1 ? matches[0] : undefined;
  return `mandala — cloud computers from your terminal\n\n${matches.map((c) => `  ${usage(c)}\n    ${c.description}`).join('\n')}\n\n${[...GLOBAL_FLAGS, ...(exact?.flags ?? [])].map((f) => `  --${f.name}${f.alias ? `, -${f.alias}` : ''}${f.type === 'boolean' ? '' : ` <${f.type}>`}${f.required ? ' (required)' : ''}  ${f.description}`).join('\n')}\n\nMANDALA_API_KEY authenticates requests; MANDALA_BASE_URL optionally selects a server.\nMANDALA_MODEL_KEY is required for agent run. No credentials are needed for help, manifest or completion.\n${path.startsWith('ssh') ? `\nmandala ssh: our options go before <computer> (with --setup, --key and --json may follow it);\neverything after it goes to ssh unchanged. It never falls back to mandala terminal.\nMANDALA_SSH_GATEWAY=host[:port] (default ssh.mandala.computer:2222) and\nMANDALA_SSH_GATEWAY_KNOWN_HOSTS (a known_hosts line, or file, pinning that gateway's key)\npoint the SSH commands at another gateway.\n` : ''}`;
}
