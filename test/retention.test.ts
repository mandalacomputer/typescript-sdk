/** How long automatic snapshots are kept, and why this is a read and nothing else. */

import { describe, expect, it } from 'vitest';
import { Client } from '../src/index.js';
import { anyRoute, BASE, json, type Responder, recorder } from './harness.js';

// OPL-3767 on the platform, OPL-3783 here. `PUT /computers/{id}/schedule` says,
// correctly, that the plan's retention decides how long automatic snapshots are
// kept — and for a long time no route said what it was. A caller setting a daily
// schedule either hardcoded a number per plan tier or inferred one by watching
// `auto` snapshots vanish.
//
// The arithmetic is the platform's and its own tests own it. What is pinned here
// is the binding: that this reaches the account-scoped route rather than
// anything computer-shaped, that the three numbers arrive as numbers, and that
// an all-zero window is passed through as itself rather than being helpfully
// reinterpreted — because zero means "this tier is off" and the SDK is not the
// layer that gets to decide what that implies.

const client = (respond: Responder) => {
  const rec = recorder(respond);
  return { rec, client: new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch }) };
};

const answering =
  (body: Record<string, unknown>): Responder =>
  (call) =>
    call.path === '/retention' ? json(body) : anyRoute(call);

describe('reading retention', () => {
  it('asks the account-scoped route, with nothing on it', async () => {
    const { rec, client: c } = client(answering({ daily: 7, weekly: 4, monthly: 12 }));
    const r = await c.snapshots.retention();
    // No id, no query. The window belongs to the account, so a per-computer
    // path would be asking a question this API does not have an answer for.
    expect(rec.last().path).toBe('/retention');
    expect(rec.last().method).toBe('GET');
    expect({ daily: r.daily, weekly: r.weekly, monthly: r.monthly }).toEqual({
      daily: 7,
      weekly: 4,
      monthly: 12,
    });
  });

  it('passes an all-zero window through as itself', async () => {
    // What an account with no active subscription reads. Zero means the tier is
    // off, and the SDK deliberately does not translate that into a claim about
    // what happens to existing snapshots: on the platform the same three zeroes
    // mean "your plan grants no retained history" as an entitlement and "never
    // reap" as a daemon policy, and picking one here would be inventing an
    // answer the wire did not carry.
    const { client: c } = client(answering({ daily: 0, weekly: 0, monthly: 0 }));
    const r = await c.snapshots.retention();
    expect({ daily: r.daily, weekly: r.weekly, monthly: r.monthly }).toEqual({
      daily: 0,
      weekly: 0,
      monthly: 0,
    });
  });

  it('keeps a field it does not model, and does not invent one it lacks', async () => {
    // `raw` is the convention every model here follows: a platform that grows a
    // field should not need an SDK release before a caller can see it. And a
    // response missing a tier reads as 0 rather than as undefined, which is what
    // the platform means by an absent tier anyway.
    const { client: c } = client(answering({ daily: 7, yearly: 3 }));
    const r = await c.snapshots.retention();
    expect(r.weekly).toBe(0);
    expect(r.monthly).toBe(0);
    expect(r.raw.yearly).toBe(3);
  });

  it('refuses a body that is not a window', async () => {
    // A bare array or a string would otherwise become a window of three zeroes —
    // which is a real answer on this route, and the one case where a parse
    // failure is indistinguishable from a plan that grants nothing.
    const { client: c } = client((call) =>
      call.path === '/retention' ? json([]) : anyRoute(call),
    );
    await expect(c.snapshots.retention()).rejects.toThrow(/expected a retention window/);
  });
});
