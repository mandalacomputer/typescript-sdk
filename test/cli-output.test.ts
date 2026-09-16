import { describe, expect, it } from 'vitest';
import { CliError } from '../src/cli-options.js';
import { errorInfo, Output, redact } from '../src/cli-output.js';
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
  return { output: new Output(io, 'computers get', json), read: () => ({ stdout, stderr }) };
}

describe('versioned output contract', () => {
  it('emits exactly one newline-terminated JSON value for a finite result', () => {
    const w = writer();
    expect(w.output.result({ id: 'vm-7' })).toBe(0);
    expect(w.read()).toEqual({
      stdout:
        '{"schemaVersion":1,"command":"computers get","ok":true,"data":{"id":"vm-7"},"exitCode":0}\n',
      stderr: '',
    });
  });

  it('keeps unsuccessful remote results as data with nonzero status', () => {
    const w = writer();
    expect(w.output.result({ exitCode: 19 }, 19)).toBe(19);
    expect(JSON.parse(w.read().stdout)).toEqual({
      schemaVersion: 1,
      command: 'computers get',
      ok: false,
      data: { exitCode: 19 },
      exitCode: 19,
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
      schemaVersion: 1,
      command: 'computers get',
      ok: false,
      error: { code: 'AuthenticationError', message: 'bad [REDACTED] / [REDACTED]', status: 401 },
      exitCode: 1,
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
        schemaVersion: 1,
        command: 'computers get',
        type: 'step',
        timestamp: '2026-02-03T04:05:06.000Z',
        data: { n: 3 },
      },
      {
        schemaVersion: 1,
        command: 'computers get',
        type: 'error',
        timestamp: '2026-02-03T04:05:06.000Z',
        data: {
          error: { code: 'agent_error', message: 'stopped', details: { steps: 3 } },
          exitCode: 1,
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
      code: 'ENOENT',
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
