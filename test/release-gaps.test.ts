/**
 * Audit gaps closed before the next release (OPL-5903): every stop reason the
 * platform documents decodes as a run that did not finish, and the limits the
 * platform publishes are mirrored rather than written out by hand.
 */

import { describe, expect, it } from 'vitest';
import { toAgentResult } from '../src/agent.js';
import { Client, ValidationError, WEBHOOK_URL_MAX } from '../src/index.js';
import { LIMITS } from '../src/limits.js';
import { execBody, MAX_EXEC_TIMEOUT_S } from '../src/paths.js';
import { anyRoute, BASE, recorder } from './harness.js';

describe('agent stop reasons', () => {
  it.each([
    'max_steps',
    'rate_limited',
    'refusal',
    'pause_turn',
    'credits_exhausted',
    'max_cost',
    'incomplete',
    'safety_check',
    'max_tokens',
  ])('decodes %s as a run that did not finish', (stop) => {
    const result = toAgentResult({ steps: 1, stop, text: '' });
    expect(result.stop).toBe(stop);
    expect(result.finished).toBe(false);
  });

  it('decodes end_turn as the one that did', () => {
    expect(toAgentResult({ steps: 1, stop: 'end_turn', text: '' }).finished).toBe(true);
  });
});

describe('mirrored limits', () => {
  it('derives the foreground exec ceiling from the mirrored limit', () => {
    expect(MAX_EXEC_TIMEOUT_S).toBe(LIMITS['exec.maxTimeoutSeconds']);
    expect(() => execBody({ command: 'true', timeoutS: MAX_EXEC_TIMEOUT_S })).not.toThrow();
    expect(() => execBody({ command: 'true', timeoutS: MAX_EXEC_TIMEOUT_S + 1 })).toThrow(
      `no greater than ${MAX_EXEC_TIMEOUT_S}`,
    );
    // A background command is not bound by it.
    expect(() =>
      execBody({ command: 'true', timeoutS: MAX_EXEC_TIMEOUT_S + 1, background: true }),
    ).not.toThrow();
  });

  it('refuses a webhook URL past the mirrored ceiling before anything is sent', async () => {
    expect(WEBHOOK_URL_MAX).toBe(LIMITS['webhook.urlMaxChars']);
    const rec = recorder(anyRoute);
    const client = new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch });
    const base = 'https://hooks.example.com/';
    const at = (n: number) => base + 'a'.repeat(n - base.length);
    await expect(client.webhooks.create({ url: at(WEBHOOK_URL_MAX + 1) })).rejects.toThrow(
      ValidationError,
    );
    await expect(client.webhooks.update('whk-1', { url: at(WEBHOOK_URL_MAX + 1) })).rejects.toThrow(
      `at most ${WEBHOOK_URL_MAX}`,
    );
    expect(rec.calls).toHaveLength(0);
    await client.webhooks.create({ url: at(WEBHOOK_URL_MAX) });
    expect(rec.calls).toHaveLength(1);
  });
});
