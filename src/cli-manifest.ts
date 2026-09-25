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
      terminal: '--json returns unsupported_mode before connecting',
      ssh: "--json returns unsupported_mode before connecting; with --setup it returns one finite result. Arguments after the computer are passed to ssh unchanged; the process exit is ssh's own (127 when no ssh client is found)",
      scp: 'One finite result with source, destination, and transfer byte accounting',
      screenshot: 'Writes exact image bytes to --output; JSON data contains path and bytes',
      exec: 'JSON data contains base64 stdout/stderr, decoded text, exit_code and completion flags; process exit follows the remote status (124 on timeout, 1 if unknown)',
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
      requires_credentials: !['manifest', 'completion', 'version', 'logout'].includes(c.path),
    })),
  };
}
