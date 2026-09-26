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
const secretScope = flag('workspace', 'Workspace ID (default: the account-wide secrets)');
const command = (
  path: string,
  description: string,
  args: string[] = [],
  flags: Flag[] = [],
  jsonMode?: Command['jsonMode'],
): Command => ({ path, description, args, flags, jsonMode });

export const GLOBAL_FLAGS: readonly Flag[] = [
  flag('profile', 'Local credential profile (after explicit/environment API keys)'),
  bool('json', 'Emit version 2 JSON (snake_case); streaming commands emit NDJSON'),
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
  command(
    'logout',
    'Forget a saved profile on this machine (default: the default profile); its key stays valid until revoked',
  ),
  command(
    'whoami',
    'Show who the credential is: person, account, role, workspace and key; needs no permission',
  ),
  command('version', 'Print the CLI version (also: mandala --version)'),
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
      flag(
        'secret',
        'Bind a stored secret as an environment variable: SECRET[=VAR], SECRET a name or id (VAR defaults to its name); repeat for several',
        { repeatable: true },
      ),
      flag(
        'secret-file',
        'Bind a stored secret as a file in /run/mandala-secrets/user/files: SECRET[=FILE] (FILE defaults to its name); repeat for several',
        { repeatable: true },
      ),
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
  command('computers rename', 'Give a computer a new name; nothing else changes', [
    'computer',
    'name',
  ]),
  command(
    'computers resize',
    'Change vCPU, RAM or disk; the computer must be stopped, and disks grow only',
    ['computer'],
    [num('cpu', 'vCPU count'), num('ram-mb', 'RAM in MiB'), num('disk-gb', 'Disk in GiB')],
  ),
  command(
    'computers view',
    "Open the computer's dashboard page in a browser, and print its URL",
    ['computer'],
    [bool('no-open', 'Print the URL without opening a browser')],
  ),
  command(
    'computers screenshot',
    'Save exact screenshot bytes to a file',
    ['computer'],
    [
      flag('output', 'Destination file', { alias: 'o', required: true }),
      num('width', 'Image width', { conflicts: ['scale'] }),
      bool('fresh', 'Request a fresh screenshot'),
      flag('region', 'Crop to X,Y,WIDTH,HEIGHT in screen pixels, before any scaling'),
      num('scale', 'Shrink by this factor, greater than 0 and at most 1', {
        conflicts: ['width'],
      }),
      flag('format', 'Image encoding (default png; jpeg with --width)', {
        choices: ['png', 'jpeg', 'jpg'],
      }),
      num('quality', 'JPEG quality, 1 to 100'),
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
      flag('until', 'Readiness condition (default running; secrets: bound secrets delivered)', {
        choices: ['built', 'running', 'guest', 'secrets'],
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
  command(
    'snapshots clone',
    'Clone a snapshot into a computer',
    ['snapshot'],
    [
      name,
      bool('disk-only', "Build a memory snapshot's clone from its disk alone, booting fresh", {
        conflicts: ['inherit-secrets'],
      }),
      bool(
        'inherit-secrets',
        'Resume a memory snapshot of a computer that held secrets; the copy holds the same credentials',
        { conflicts: ['disk-only'] },
      ),
    ],
  ),
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
    'secrets list',
    'List stored secrets by name, id and revision (never values)',
    [],
    [secretScope],
  ),
  command(
    'secrets set',
    'Create or replace a secret; the value is read from stdin or a hidden prompt, never argv',
    ['name'],
    [secretScope],
  ),
  command('secrets rm', 'Delete a secret by name or id', ['name'], [secretScope]),
  command(
    'api-keys list',
    "List your API keys this key can reach (never the keys themselves); needs the key's Manage keys permission",
  ),
  command(
    'api-keys create',
    'Mint an API key and print it once; needs Manage keys, and the new key never has it',
    [],
    [
      flag('name', 'Label for the key (up to 60 characters)'),
      flag(
        'workspace',
        "Confine the key to this workspace ID (default: the calling key's own scope)",
      ),
    ],
  ),
  command('api-keys revoke', 'Revoke an API key by id; it is refused from its next request', [
    'id',
  ]),
  command(
    'files list',
    'List one guest directory: names, types and file sizes (bounded, not paged)',
    ['computer', 'path'],
  ),
  command(
    'files upload',
    'Copy one local file to an absolute guest path; a path ending in / keeps the file name',
    ['computer', 'file', 'path'],
    [bool('no-overwrite', 'Create the guest file, refusing if something is there')],
  ),
  command(
    'files download',
    'Copy one guest file to a local path (default: the current directory)',
    ['computer', 'path', 'dest?'],
  ),
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
  command(
    'scp',
    'Copy one file; exactly one side is computer:/path',
    ['src', 'dst'],
    [bool('no-overwrite', 'Upload only: create the guest file, refusing if something is there')],
  ),
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
    /**
     * The command's full usage, for a mistake in how it was typed: printed
     * under the message, so the fix is on the screen rather than behind --help.
     */
    public readonly usage?: string,
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

/**
 * The message for an option nobody declared, naming it only when it is shaped
 * like an option name (`-x`, `--name`).
 *
 * Anything else that starts with a dash is as likely to be a value — a key or
 * a token that happens to begin with one — as a mistyped flag, and it is read
 * before any command could mark it secret, so it is described and not echoed.
 */
function unknownOption(spelling: string): string {
  if (/^(?:-[A-Za-z0-9]|--[A-Za-z][A-Za-z0-9-]{0,39})$/.test(spelling))
    return `unknown option ${spelling}`;
  return 'unknown option: an argument starts with "-" but is not an option name; put -- before a value that starts with one';
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
    // `--version` is the conventional spelling, and only before a command: after
    // one it is `templates get`'s own `--version`, a template version.
    if (!parsed.command && !parsed.path && arg === '--version') {
      parsed.path = 'version';
      parsed.command = COMMANDS.find((c) => c.path === 'version');
      continue;
    }
    if (!positional && arg.startsWith('-') && arg !== '-') {
      const [spelling, ...tail] = arg.split('=');
      const flags = [...GLOBAL_FLAGS, ...(parsed.command?.flags ?? [])];
      const spec = flags.find((f) => spelling === `--${f.name}` || spelling === `-${f.alias}`);
      if (!spec) throw usageError(parsed.command, unknownOption(spelling!));
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
  const named = (a: string) => (a.endsWith('?') ? `[${a.slice(0, -1)}]` : `<${a}>`);
  if (c.path === 'terminal' && parsed.args.length > 1)
    throw usageError(c, 'mandala terminal takes one computer and runs no command');
  if (parsed.args.length > c.args.length) {
    // Counted, never quoted. An operand past the last one a command takes is
    // most often a value typed where a prompt or stdin was meant to read it —
    // `mandala secrets set NAME "$TOKEN"` — and this fails before any command
    // has registered a value for redaction, so echoing it would print the
    // credential into whatever log captures stderr or the JSON error.
    const extra = parsed.args.length - c.args.length;
    throw usageError(
      c,
      `${extra} argument${extra > 1 ? 's' : ''} too many: mandala ${c.path} ` +
        (c.args.length
          ? `takes ${c.args.map(named).join(' ')} and nothing more (quote a value that has spaces in it)`
          : 'takes no arguments'),
    );
  }
  if (parsed.args.length < required)
    throw usageError(
      c,
      `missing ${c.args.slice(parsed.args.length, required).map(named).join(' ')}`,
    );
  const blank = parsed.args.findIndex((a) => !a.trim());
  if (blank >= 0) throw usageError(c, `${named(c.args[blank]!)} is blank`);
  c.args.forEach((name, i) => {
    const bare = name.replace(/\?$/, '');
    const choices = c.argumentChoices?.[bare];
    if (choices && i < parsed.args.length && !choices.includes(parsed.args[i]!))
      throw usageError(c, `${bare} must be one of: ${choices.join(', ')}`);
  });
  for (const f of c.flags) {
    if (f.required && parsed.flags[f.name] === undefined)
      throw usageError(c, `${usage(c)} requires --${f.name}`);
    if (parsed.flags[f.name] !== undefined)
      for (const conflict of f.conflicts ?? []) {
        if (parsed.flags[conflict] !== undefined)
          throw usageError(c, `--${f.name} conflicts with --${conflict}`);
      }
  }
  return parsed;
}

/**
 * A mistake in how a command was typed, carrying that command's full usage —
 * the usage line, what it does and every flag — rather than the one line that
 * used to be the whole message. Without a command there is nothing to show.
 */
function usageError(c: Command | undefined, message: string): CliError {
  return new CliError('invalid_arguments', message, undefined, undefined, c && help(c.path));
}

export function help(path = ''): string {
  const matches = COMMANDS.filter((c) => !path || c.path === path || c.path.startsWith(`${path} `));
  const exact = matches.length === 1 ? matches[0] : undefined;
  return `mandala — cloud computers from your terminal\n\n${matches.map((c) => `  ${usage(c)}\n    ${c.description}`).join('\n')}\n\n${[...GLOBAL_FLAGS, ...(exact?.flags ?? [])].map((f) => `  --${f.name}${f.alias ? `, -${f.alias}` : ''}${f.type === 'boolean' ? '' : ` <${f.type}>`}${f.required ? ' (required)' : ''}  ${f.description}`).join('\n')}\n\nMANDALA_API_KEY authenticates requests; MANDALA_BASE_URL optionally selects a server.\nMANDALA_MODEL_KEY is required for agent run. No credentials are needed for help, version, manifest, completion or logout.\n${path.startsWith('ssh') ? `\nmandala ssh: our options go before <computer> (with --setup, --key and --json may follow it);\neverything after it goes to ssh unchanged. It never falls back to mandala terminal.\nMANDALA_SSH_GATEWAY=host[:port] (default ssh.mandala.computer:2222) and\nMANDALA_SSH_GATEWAY_KNOWN_HOSTS (a known_hosts line, or file, pinning that gateway's key)\npoint the SSH commands at another gateway.\n` : ''}`;
}
