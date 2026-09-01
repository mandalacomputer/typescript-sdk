/** What the account has used, and the two caveats that come with it. */

import { describe, expect, it } from 'vitest';
import { Client } from '../src/index.js';
import { anyRoute, BASE, json, type Responder, recorder, USAGE } from './harness.js';

// OPL-3765. The platform grew `GET /usage` because the dashboard could read
// these figures and an API key could not — which is backwards for who needs
// them: a script that launches computers in a loop is the caller that can run
// up a bill without noticing.
//
// What is pinned here is the binding rather than the arithmetic. The platform
// owns the summing, and its own tests own whether the numbers are right. These
// own the three things a client can get wrong about them:
//
//   - the window, because a timestamp with no zone is a silently shifted answer
//     rather than an error, and the SDK is the layer that can refuse it before
//     the round trip
//   - the caveats, because a total that is quietly short reads exactly like a
//     total that is right, and only the flags say otherwise
//   - the withheld breakdown, because "no computers ran" and "this key may not
//     see which did" arrive as the same empty array unless something separates
//     them

const client = (respond: Responder) => {
  const rec = recorder(respond);
  return { rec, client: new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch }) };
};

/** The complete answer, with any field of it overridden. */
const answering = (over: Record<string, unknown> = {}): Responder => {
  return (call) => (call.path === '/usage' ? json({ ...USAGE, ...over }) : anyRoute(call));
};

describe('reading usage', () => {
  it('asks for the billing period by naming no window at all', async () => {
    const { rec, client: c } = client(answering());
    await c.usage.read();
    expect(rec.last().path).toBe('/usage');
    // Not `?from=&to=`, and not an empty pair either: the platform's default IS
    // the billing period, so the honest way to ask for it is to say nothing.
    expect(rec.last().query).toEqual({});
  });

  it('decodes the totals and the breakdown into this SDK’s spelling', async () => {
    const { client: c } = client(answering());
    const report = await c.usage.read();
    expect(report.usage.vcpuHours).toBe(25);
    expect(report.usage.diskGbMonths).toBe(0.66);
    expect(report.usage.computers).toEqual([
      { id: 'vm-1', name: 'scratch', runHours: 12.5, vcpuHours: 25, ramGbHours: 50, gone: false },
    ]);
    expect(report.reportedThrough).toBe('2026-08-20');
    // The period is the ACCOUNT's, and the window is what was measured. They
    // agree on this payload and stop agreeing the moment a window is named,
    // which is the case below.
    expect(report.period.source).toBe('subscription');
  });

  it('refuses a report whose totals object was never sent (OPL-4215)', async () => {
    // Every `num()` answers 0 for an absent totals object, and both caveat
    // flags read false, so a body carrying no figures at all came back as a
    // real and empty billing window.
    //
    // Refused rather than caveated. `degraded` is documented as the shortfall
    // that CLEARS — "retry when the host is back" — and `unmetered` as the one
    // that does not; a body with no totals is neither, and a caller following
    // either doc would wait for something that is not coming.
    const { client: c } = client(answering({ usage: undefined }));
    await expect(c.usage.read()).rejects.toThrow(/expected a usage report to carry its totals/);
  });

  it('refuses a totals object that is not a record either', async () => {
    const { client: c } = client(answering({ usage: [] }));
    await expect(c.usage.read()).rejects.toThrow(/carry its totals/);
  });

  it('takes a real empty window as the answer it is', async () => {
    // The distinction the refusal above is for: a totals object that WAS sent
    // and holds zeros is an account that ran nothing, and neither refusing it
    // nor caveating it would be true.
    const { client: c } = client(answering({ usage: { computers: [] } }));
    const report = await c.usage.read();
    expect(report.usage.runHours).toBe(0);
    expect(report.degraded).toBe(false);
    expect(report.breakdown).toBe(true);
  });

  it('keeps the whole payload, so a field added later is still readable', async () => {
    const { client: c } = client(answering({ future_field: 7 }));
    expect((await c.usage.read()).raw.future_field).toBe(7);
  });
});

describe('the window', () => {
  it('sends a Date as UTC, which is the shape that cannot be wrong', async () => {
    const { rec, client: c } = client(answering());
    await c.usage.read({
      from: new Date(Date.UTC(2026, 6, 1)),
      to: new Date(Date.UTC(2026, 7, 1)),
    });
    expect(rec.last().query).toEqual({
      from: '2026-07-01T00:00:00.000Z',
      to: '2026-08-01T00:00:00.000Z',
    });
  });

  it('takes a string that already carries a zone', async () => {
    const { rec, client: c } = client(answering());
    await c.usage.read({ from: '2026-07-01T00:00:00+01:00' });
    // Verbatim: the offset is part of the instant, and normalising it here
    // would be this SDK deciding what the caller meant.
    expect(rec.last().query).toEqual({ from: '2026-07-01T00:00:00+01:00' });
  });

  it('refuses a timestamp with no zone, before the round trip', async () => {
    // The failure this check exists for does not look like a failure: the
    // platform would refuse it, but a client that parsed it locally would send
    // an instant shifted by the machine's own offset. Refused here so the
    // reason arrives with the argument rather than as a 400 about a route.
    const { rec, client: c } = client(answering());
    // A TypeError, which is what every refusal this SDK makes before a request
    // is — see ValidationError, which is deliberately not exported.
    await expect(c.usage.read({ from: '2026-08-01T00:00:00' })).rejects.toThrow(/time zone/);
    await expect(c.usage.read({ from: '2026-08-01T00:00:00' })).rejects.toThrow(TypeError);
    await expect(c.usage.read({ to: '2026-08-01' })).rejects.toThrow(/^to must be/);
    expect(rec.calls).toEqual([]);
  });

  it('refuses an Invalid Date rather than sending the string "Invalid Date"', async () => {
    const { client: c } = client(answering());
    await expect(c.usage.read({ from: new Date('nonsense') })).rejects.toThrow(/Invalid Date/);
  });

  it('reports the window that was measured, which is not always the one asked for', async () => {
    // A `to` in the future is answered as now. The response carries the instant
    // used, so a caller comparing two reads is comparing windows rather than
    // requests.
    const { client: c } = client(answering({ to: '2026-08-22T12:00:00.000Z' }));
    const report = await c.usage.read({ to: '2026-12-01T00:00:00Z' });
    expect(report.to).toBe('2026-08-22T12:00:00.000Z');
  });
});

describe('the shortfalls', () => {
  it('reads false on a complete answer', async () => {
    const { client: c } = client(answering());
    const report = await c.usage.read();
    expect([report.degraded, report.unmetered]).toEqual([false, false]);
  });

  it('carries an unreachable hypervisor through as a caveat, not an error', async () => {
    // 200 with a flag, deliberately, and the SDK must not turn it into a throw:
    // the numbers that ARE known are still worth having, and the caller is the
    // one who knows whether a short total matters for what they are doing.
    const { client: c } = client(answering({ degraded: true }));
    const report = await c.usage.read();
    expect(report.degraded).toBe(true);
    expect(report.usage.vcpuHours).toBe(25);
  });

  it('keeps the shortfall that never clears apart from the one that does', async () => {
    const { client: c } = client(answering({ unmetered: true }));
    const report = await c.usage.read();
    expect([report.degraded, report.unmetered]).toEqual([false, true]);
  });

  it('says nothing has settled for billing when the platform says nothing has', async () => {
    const { client: c } = client(answering({ reported_through: null }));
    // undefined and not null: a caller testing `=== undefined` for "the
    // platform did not answer" is the check this type invites.
    expect((await c.usage.read()).reportedThrough).toBeUndefined();
  });
});

describe('a workspace-scoped key', () => {
  const withheld = { ...USAGE.usage } as Record<string, unknown>;
  delete withheld.computers;

  it('gets the totals with the breakdown withheld, and can tell that apart from empty', async () => {
    const { client: c } = client(answering({ usage: withheld }));
    const report = await c.usage.read();
    expect(report.usage.vcpuHours).toBe(25);
    // Empty rather than absent, so reading it needs no null check...
    expect(report.usage.computers).toEqual([]);
    // ...and the flag is what separates "may not see" from "nothing ran".
    expect(report.breakdown).toBe(false);
  });

  it('reads an account that ran nothing as a real, empty breakdown', async () => {
    const { client: c } = client(answering({ usage: { ...USAGE.usage, computers: [] } }));
    const report = await c.usage.read();
    expect(report.usage.computers).toEqual([]);
    expect(report.breakdown).toBe(true);
  });
});
