import { describe, expect, it } from 'vitest';
import { CliError } from '../src/cli-options.js';
import { errorInfo, Output, redact, terminalSafe } from '../src/cli-output.js';
import { runtime } from '../src/cli-runtime.js';
import { AuthenticationError, ValidationError } from '../src/errors.js';

function writer(json = true) {
  let stdout = '';
  let stderr = '';
  const io = runtime({
    env: { MANDALA_API_KEY: 'com_secret_123', MANDALA_MODEL_KEY: 'model_secret_456' },
    stdout: {
      write: ((s: unknown) => {
        stdout += s;
        return true;
      }) as NodeJS.WritableStream['write'],
    },
    stderr: {
      write: ((s: unknown) => {
        stderr += s;
        return true;
      }) as NodeJS.WritableStream['write'],
    },
    now: () => new Date('2026-02-03T04:05:06Z'),
  });
  return { io, output: new Output(io, 'computers get', json), read: () => ({ stdout, stderr }) };
}

describe('versioned output contract', () => {
  it('emits exactly one newline-terminated JSON value for a finite result', () => {
    const w = writer();
    expect(w.output.result({ id: 'vm-7' })).toBe(0);
    expect(w.read()).toEqual({
      stdout:
        '{"schema_version":2,"command":"computers get","ok":true,"data":{"id":"vm-7"},"exit_code":0}\n',
      stderr: '',
    });
  });

  it('keeps unsuccessful remote results as data with nonzero status', () => {
    const w = writer();
    expect(w.output.result({ exit_code: 19 }, 19)).toBe(19);
    expect(JSON.parse(w.read().stdout)).toEqual({
      schema_version: 2,
      command: 'computers get',
      ok: false,
      data: { exit_code: 19 },
      exit_code: 19,
    });
  });

  it('emits stable typed errors without stack or response-body credential leaks', () => {
    const w = writer();
    w.output.error(
      new AuthenticationError('bad com_secret_123 / model_secret_456', 401, {
        api_key: 'com_secret_123',
      }),
    );
    const result = JSON.parse(w.read().stdout);
    expect(result).toEqual({
      schema_version: 2,
      command: 'computers get',
      ok: false,
      error: { code: 'unauthenticated', message: 'bad [REDACTED] / [REDACTED]', status: 401 },
      exit_code: 1,
    });
    expect(w.read().stderr).toBe('');
  });

  it('writes timestamped NDJSON frames and a structured terminal error', () => {
    const w = writer();
    w.output.frame('step', { n: 3 });
    w.output.error(new CliError('agent_error', 'stopped', { steps: 3 }), 1, true);
    expect(
      w
        .read()
        .stdout.trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
    ).toEqual([
      {
        schema_version: 2,
        command: 'computers get',
        type: 'step',
        timestamp: '2026-02-03T04:05:06.000Z',
        data: { n: 3 },
      },
      {
        schema_version: 2,
        command: 'computers get',
        type: 'error',
        timestamp: '2026-02-03T04:05:06.000Z',
        data: {
          error: { code: 'agent_error', message: 'stopped', details: { steps: 3 } },
          exit_code: 1,
        },
      },
    ]);
  });

  it('redacts nested values and diagnostics without mutating data', () => {
    const w = writer();
    const data = { inner: ['model_secret_456', { text: 'com_secret_123' }] };
    w.output.result(data);
    w.output.diagnostic('key model_secret_456');
    expect(w.read().stdout).not.toContain('secret_');
    expect(w.read().stderr).toBe('key [REDACTED]\n');
    expect(data.inner[0]).toBe('model_secret_456');
    expect(redact('safe', {})).toBe('safe');
    expect(redact('com_trimmed', { MANDALA_API_KEY: ' com_trimmed ' })).toBe('[REDACTED]');
  });

  it('classifies validation, cancellation, filesystem errors and unexpected faults', () => {
    expect(errorInfo(new ValidationError('bad'))).toEqual({
      code: 'invalid_arguments',
      message: 'bad',
    });
    expect(errorInfo(new DOMException('aborted', 'AbortError'))).toEqual({
      code: 'cancelled',
      message: 'Cancelled',
    });
    expect(errorInfo(Object.assign(new Error('missing'), { code: 'ENOENT' }))).toEqual({
      code: 'io_error',
      details: { errno: 'ENOENT' },
      message: 'missing',
    });
    expect(errorInfo(new TypeError('bug'))).toEqual({ code: 'internal_error', message: 'bug' });
  });

  it('sends human errors only to stderr without color escapes', () => {
    const w = writer(false);
    w.output.error(new CliError('invalid_arguments', 'bad flag'));
    expect(w.read()).toEqual({ stdout: '', stderr: 'mandala: bad flag\n' });
  });
});

it('redacts invocation-local file/device/issued secrets in fields, errors and object member names', () => {
  const w = writer();
  for (const secret of ['file-key-canary', 'device-secret-canary', 'issued-key-canary'])
    w.io.secrets!.add(secret);
  w.output.result({ 'file-key-canary': ['device-secret-canary', { value: 'issued-key-canary' }] });
  w.output.error(new CliError('failure', 'device-secret-canary', { key: 'issued-key-canary' }));
  w.output.diagnostic('file-key-canary device-secret-canary issued-key-canary');
  const text = w.read().stdout + w.read().stderr;
  for (const secret of w.io.secrets!) expect(text).not.toContain(secret);
  expect(text).toContain('[REDACTED]');
});

describe('terminalSafe', () => {
  it.each([
    ['ESC', '\u001b', '\\u001b'],
    ['BEL', '\u0007', '\\u0007'],
    ['CR', '\r', '\\u000d'],
    ['NUL', '\u0000', '\\u0000'],
    ['LF', '\n', '\\u000a'],
    ['DEL', '\u007f', '\\u007f'],
    ['C1 OSC', '\u009d', '\\u009d'],
    ['C1 ST', '\u009c', '\\u009c'],
    ['C1 CSI', '\u009b', '\\u009b'],
    ['RLO', '\u202e', '\\u202e'],
    ['LRI', '\u2066', '\\u2066'],
    ['PDI', '\u2069', '\\u2069'],
    ['RLM', '\u200f', '\\u200f'],
    ['ALM', '\u061c', '\\u061c'],
  ])('escapes %s', (_, raw, shown) => {
    expect(terminalSafe(`a${raw}b`)).toBe(`a${shown}b`);
  });

  it('leaves printable text alone, in any script', () => {
    for (const text of [
      'café',
      '中文名',
      'rocket 🚀 ok',
      'tab-free ascii ~!@#$%^&*()',
      '\u00a0nbsp',
    ])
      expect(terminalSafe(text)).toBe(text);
  });

  it('keeps newlines only when asked', () => {
    expect(terminalSafe('a\nb\u001b', { keepNewlines: true })).toBe('a\nb\\u001b');
    expect(terminalSafe('a\r\nb', { keepNewlines: true })).toBe('a\\u000d\nb');
  });

  it('escapes the OSC 52 clipboard write whole', () => {
    expect(terminalSafe('\u001b]52;c;aGk=\u0007\u001b[2K\rFake')).toBe(
      '\\u001b]52;c;aGk=\\u0007\\u001b[2K\\u000dFake',
    );
  });

  it('diagnostics, frames and human JSON escape; --json output is the real string', () => {
    const name = 'x\u009d0;t\u009c\u202e\u001b[2K';
    const human = writer(false);
    human.output.diagnostic(`named ${name}`);
    human.output.frame('text', name);
    human.output.result({ name });
    const { stdout, stderr } = human.read();
    for (const c of ['\u009d', '\u009c', '\u202e', '\u001b']) {
      expect(stdout).not.toContain(c);
      expect(stderr).not.toContain(c);
    }
    expect(stderr).toBe('named x\\u009d0;t\\u009c\\u202e\\u001b[2K\n');
    expect(stdout).toContain('text: x\\u009d0;t\\u009c\\u202e\\u001b[2K\n');
    // Still a JSON document, and it still says the same thing.
    expect(JSON.parse(stdout.slice(stdout.indexOf('{')))).toEqual({ name });
    const machine = writer(true);
    machine.output.result({ name });
    expect(machine.read().stdout).toBe(
      `${JSON.stringify({ schema_version: 2, command: 'computers get', ok: true, data: { name }, exit_code: 0 })}\n`,
    );
  });

  it('a human error from the platform is escaped too', () => {
    const w = writer(false);
    w.output.error(new CliError('failure', 'refused: \u001b]52;c;aGk=\u0007'));
    expect(w.read().stderr).toBe('mandala: refused: \\u001b]52;c;aGk=\\u0007\n');
  });
});
