/**
 * A wait reads a 409's word before it polls again (OPL-6079).
 *
 * Every 409 used to be polled through, whatever its `reason`, so a refusal this
 * SDK itself calls permanent ran a wait to its deadline and came back as a
 * timeout naming none of it. The rule is now the same in all three clients: a
 * permanent word or an always-final code ends the wait with that error, a
 * transient word or code polls again, and a reasonless 409 polls again only on
 * a route that documents one as a state that passes.
 */

import { describe, expect, it } from 'vitest';
import { errorForStatus } from '../src/errors.js';
import { type APIError, Client, ConflictError, TimeoutError } from '../src/index.js';
import { isTransientForPoll } from '../src/wait.js';
import { anyRoute, BASE, COMPUTER, EXEC_OK, json, type Responder, recorder } from './harness.js';

const client = (respond: Responder) => {
  const rec = recorder(respond);
  return { rec, c: new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch }) };
};

const conflict = (body: Record<string, unknown>) =>
  errorForStatus(409, String(body.error ?? 'HTTP 409'), body);

describe('isTransientForPoll on a 409', () => {
  it.each([
    'unavailable',
    'unsupported',
    'revoked',
    'exists',
    'running',
    'name_taken',
    'stale_revision',
    'stale_capture',
  ])('ends the wait on the permanent word %s', (reason) => {
    const err = conflict({ error: 'no', reason });
    expect(isTransientForPoll(err)).toBe(false);
    expect(isTransientForPoll(err, { settling409: true })).toBe(false);
  });

  it.each(['contention', 'starting'])('polls again on the transient word %s', (reason) => {
    expect(isTransientForPoll(conflict({ error: 'not yet', reason }))).toBe(true);
  });

  it.each(['template_image_preparing', 'idempotency_outcome_unknown'])(
    'ends the wait on the always-final code %s, even with a transient word',
    (code) => {
      const err = conflict({ error: 'no', code, reason: 'contention' });
      expect(isTransientForPoll(err)).toBe(false);
      expect(isTransientForPoll(err, { settling409: true })).toBe(false);
    },
  );

  it.each(['idempotency_in_progress', 'WORKSPACE_MOVING'])(
    'polls again on the reasonless code %s',
    (code) => {
      expect(isTransientForPoll(conflict({ error: 'settling', code }))).toBe(true);
    },
  );

  it('lets the word win over a code that would otherwise clear', () => {
    // A workspace move that needs a person: isTransient calls it final, and a
    // wait used to poll it for a quarter of an hour.
    const err = conflict({
      error: 'needs a person',
      code: 'WORKSPACE_MOVING',
      reason: 'unsupported',
    });
    expect(isTransientForPoll(err)).toBe(false);
  });

  it('polls a reasonless or unknown-word 409 only where the route says it settles', () => {
    for (const body of [{ error: 'no word' }, { error: 'new word', reason: 'someday' }]) {
      const err = conflict(body);
      expect(isTransientForPoll(err)).toBe(false);
      expect(isTransientForPoll(err, { settling409: true })).toBe(true);
    }
  });

  it('leaves the other statuses as they were', () => {
    expect(isTransientForPoll(errorForStatus(429, 'slow'))).toBe(true);
    expect(isTransientForPoll(errorForStatus(408, 'slow'))).toBe(true);
    expect(isTransientForPoll(errorForStatus(503, 'away'))).toBe(true);
    expect(isTransientForPoll(errorForStatus(400, 'bad', { reason: 'contention' }))).toBe(false);
  });
});

describe('the waits end on a permanent 409 instead of timing out', () => {
  const unsupported = {
    error: 'this workspace move needs a person',
    code: 'WORKSPACE_MOVING',
    reason: 'unsupported',
  };

  it('waitUntilRunning', async () => {
    let gets = 0;
    const { c } = client((call) => {
      if (call.method === 'GET' && call.path === '/computers/vm-1') {
        gets += 1;
        if (gets === 1) return json({ ...COMPUTER, status: 'starting' });
        return json(unsupported, { status: 409 });
      }
      return anyRoute(call);
    });
    const computer = await c.computers.get('vm-1');
    const err = await computer.waitUntilRunning({ timeoutMs: 2_000, pollMs: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as APIError).reason).toBe('unsupported');
    expect(gets).toBe(2);
  });

  it('builds.wait', async () => {
    let polls = 0;
    const { c } = client((call) => {
      if (call.path.endsWith('/progress')) {
        polls += 1;
        return json({ error: 'gone for good', reason: 'unsupported' }, { status: 409 });
      }
      return anyRoute(call);
    });
    const err = await c.builds.wait('bld-1', { timeoutMs: 2_000, pollMs: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect(err).not.toBeInstanceOf(TimeoutError);
    expect(polls).toBe(1);
  });

  it('waitForGuest ends on a reasonless 409, and rides out `starting`', async () => {
    let probes = 0;
    const { c } = client((call) => {
      if (call.path.endsWith('/exec')) {
        probes += 1;
        return probes === 1
          ? json({ error: 'booting', reason: 'starting' }, { status: 409 })
          : json({ error: 'sixteen background commands already' }, { status: 409 });
      }
      return anyRoute(call);
    });
    const computer = await c.computers.get('vm-1');
    const err = await computer.waitForGuest({ timeoutMs: 2_000, pollMs: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as Error).message).toContain('sixteen background commands');
    expect(probes).toBe(2);
  });

  it('waitForDesktop rides out the reasonless no-desktop 409 and ends on `unsupported`', async () => {
    let probes = 0;
    const { c } = client((call) => {
      if (call.path.endsWith('/exec')) {
        probes += 1;
        if (probes === 1) return json({ error: 'no active desktop session' }, { status: 409 });
        if (probes === 2) return json(EXEC_OK);
      }
      return anyRoute(call);
    });
    const computer = await c.computers.get('vm-1');
    await expect(computer.waitForDesktop({ timeoutMs: 2_000, pollMs: 1 })).resolves.toBe(computer);
    expect(probes).toBe(2);

    const { c: c2 } = client((call) =>
      call.path.endsWith('/exec')
        ? json({ error: 'a Windows guest', reason: 'unsupported' }, { status: 409 })
        : anyRoute(call),
    );
    const other = await c2.computers.get('vm-1');
    const err = await other.waitForDesktop({ timeoutMs: 2_000, pollMs: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as APIError).reason).toBe('unsupported');
  });
});

describe('waitForGuest and an admitted cold start', () => {
  it('ends on `unavailable` once the computer holds nothing', async () => {
    let probes = 0;
    const { c } = client((call) => {
      if (call.path.endsWith('/exec')) {
        probes += 1;
        return json({ error: 'not running', reason: 'unavailable' }, { status: 409 });
      }
      if (call.method === 'GET' && call.path === '/computers/vm-1') {
        // Admitted on the first read, then nothing held.
        return json({ ...COMPUTER, status: 'stopped', running_ram_mb: probes === 0 ? 4096 : 0 });
      }
      return anyRoute(call);
    });
    const computer = await c.computers.get('vm-1');
    const err = await computer.waitForGuest({ timeoutMs: 2_000, pollMs: 1 }).catch((e) => e);
    expect(err).not.toBeInstanceOf(TimeoutError);
    expect((err as Error).message).toMatch(/is stopped and its guest cannot answer/);
    expect(probes).toBe(1);
  });

  it('probes again when the boot finished while the refresh was in flight', async () => {
    let probes = 0;
    let gets = 0;
    const { c } = client((call) => {
      if (call.path.endsWith('/exec')) {
        probes += 1;
        return probes === 1
          ? json({ error: 'not running', reason: 'unavailable' }, { status: 409 })
          : json(EXEC_OK);
      }
      if (call.method === 'GET' && call.path === '/computers/vm-1') {
        gets += 1;
        return gets === 1
          ? json({ ...COMPUTER, status: 'stopped', running_ram_mb: 4096 })
          : json(COMPUTER);
      }
      return anyRoute(call);
    });
    const computer = await c.computers.get('vm-1');
    await expect(computer.waitForGuest({ timeoutMs: 2_000, pollMs: 1 })).resolves.toBe(computer);
    expect(probes).toBe(2);
  });
});

describe('waitForGuest with a stale running handle', () => {
  it('refreshes before judging `unavailable`, and waits out an admitted restart', async () => {
    let probes = 0;
    let gets = 0;
    const { c } = client((call) => {
      if (call.path.endsWith('/exec')) {
        probes += 1;
        return probes === 1
          ? json({ error: 'not running', reason: 'unavailable' }, { status: 409 })
          : json(EXEC_OK);
      }
      if (call.method === 'GET' && call.path === '/computers/vm-1') {
        gets += 1;
        // The first read is the handle; another client then stopped and
        // started it, which the refresh shows as an admitted cold start.
        return gets === 1
          ? json(COMPUTER)
          : json({ ...COMPUTER, status: 'stopped', running_ram_mb: 4096 });
      }
      return anyRoute(call);
    });
    const computer = await c.computers.get('vm-1');
    await expect(computer.waitForGuest({ timeoutMs: 2_000, pollMs: 1 })).resolves.toBe(computer);
    expect(probes).toBe(2);
  });
});
