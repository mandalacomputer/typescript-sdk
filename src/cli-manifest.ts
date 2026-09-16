import { COMMANDS, GLOBAL_FLAGS } from './cli-options.js';
import { SCHEMA_VERSION } from './cli-output.js';

export function manifest() {
  return {
    schemaVersion: SCHEMA_VERSION,
    name: 'mandala',
    authentication: {
      apiKey: 'MANDALA_API_KEY',
      baseUrl: 'MANDALA_BASE_URL',
      modelKey: 'MANDALA_MODEL_KEY',
    },
    output: {
      finite: {
        success: ['schemaVersion', 'command', 'ok', 'data', 'exitCode'],
        error: ['schemaVersion', 'command', 'ok', 'error', 'exitCode'],
      },
      stream: {
        format: 'ndjson',
        fields: ['schemaVersion', 'command', 'type', 'timestamp', 'data'],
        terminalTypes: ['done', 'error'],
      },
      ssh: '--json returns unsupported_mode before connecting',
      scp: 'One finite result with source, destination, and transfer byte accounting',
      screenshot: 'Writes exact image bytes to --output; JSON data contains path and bytes',
      exec: 'JSON data contains base64 stdout/stderr, decoded text, exitCode and completion flags; process exit follows the remote status (124 on timeout, 1 if unknown)',
    },
    commands: COMMANDS.map((c) => ({
      path: c.path.split(' '),
      description: c.description,
      arguments: c.args.map((name) => ({
        name,
        required: true,
        type: 'string',
        ...(c.argumentChoices?.[name] ? { choices: c.argumentChoices[name] } : {}),
      })),
      flags: [...GLOBAL_FLAGS, ...c.flags],
      jsonMode: c.jsonMode ?? 'finite',
      requiresCredentials: !['manifest', 'completion'].includes(c.path),
    })),
  };
}
