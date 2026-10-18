import { COMMANDS, GLOBAL_FLAGS } from './cli-options.js';
import { SCHEMA_VERSION } from './cli-output.js';

export function manifest() {
  return {
    schema_version: SCHEMA_VERSION,
    name: 'mandala',
    authentication: {
      api_key: 'MANDALA_API_KEY',
      base_url: 'MANDALA_BASE_URL',
      model_key: 'MANDALA_MODEL_KEY',
    },
    output: {
      finite: {
        success: ['schema_version', 'command', 'ok', 'data', 'exit_code'],
        error: ['schema_version', 'command', 'ok', 'error', 'exit_code'],
      },
      stream: {
        format: 'ndjson',
        fields: ['schema_version', 'command', 'type', 'timestamp', 'data'],
        terminal_types: ['done', 'error'],
      },
      terminal: '--json returns unsupported_mode, exit 2, before connecting',
      ssh: "--json returns unsupported_mode, exit 2, before connecting; with --setup it returns one finite result. Arguments after the computer are passed to ssh unchanged; the process exit is ssh's own (127 when no ssh client is found)",
      scp: 'One finite result with source, destination, and transfer byte accounting',
      screenshot: 'Writes exact image bytes to --output; JSON data contains path and bytes',
      exec: 'JSON data contains base64 stdout/stderr, decoded text, exit_code and completion flags; process exit follows the remote status (124 on timeout, 1 if unknown)',
      exec_poll:
        'computers exec-poll: JSON data contains pid, running, exit_code, base64 and decoded stdout/stderr read since the last poll; process exit is 0 while the command runs, then its exit status (1 if unknown). computers exec-kill exits 0 once the command is killed',
      move: 'computers move --workspace: JSON data is the updated computer; --workspace conflicts with host sizing, wait and idempotency flags. With --ram-mb, JSON data is the move (state, live, the target cpu/ram_mb/disk_gb, started_at); with --wait the process exits 0 only when its state is done',
      agent_run:
        'agent run exits 0 only when the run finished (done frame with stop end_turn); any other stop, an error frame or a stream ending early exits 1. With --background it emits one finite result instead of frames, whose data is the run as started (status running), and exits 0 once the run has started',
      agent_runs:
        'agent runs get: JSON data is the run; exit 0. With --wait it is the run once it has ended, and the process exits 0 only when it finished (status completed with result.stop end_turn), 1 for any other ending (completed at another stop, failed, cancelled, interrupted); the wait timing out is error timeout, exit 1, and the run goes on. agent runs cancel exits 0, also for a run that had already ended, whose data is then unchanged',
      agent_session:
        'agent chat and agent resume: one run per line of stdin, until the end of input or a line reading /exit. Each run writes the frames agent run writes, ending in its own done or error frame; a run stopped by Ctrl-C ends in an error frame with code cancelled and exit_code 130, and the session goes on. The process exits 0 when every run finished, 1 when any did not, and 130 when SIGTERM, or Ctrl-C outside a run with no terminal prompt, ended the session. agent resume with no thread while stdin is not a terminal is a usage error, exit 2',
    },
    commands: COMMANDS.map((c) => ({
      path: c.path.split(' '),
      description: c.description,
      arguments: c.args.map((spelled) => {
        const name = spelled.replace(/\?$/, '');
        return {
          name,
          required: name === spelled,
          type: 'string',
          ...(c.argumentChoices?.[name] ? { choices: c.argumentChoices[name] } : {}),
        };
      }),
      ...(c.passthrough ? { passthrough: { unless: c.passthrough.unless } } : {}),
      flags: [...GLOBAL_FLAGS, ...c.flags],
      json_mode: c.jsonMode ?? 'finite',
      // `login` is how credentials are obtained, so it cannot need them first.
      requires_credentials: !['manifest', 'completion', 'version', 'login', 'logout'].includes(
        c.path,
      ),
    })),
  };
}
