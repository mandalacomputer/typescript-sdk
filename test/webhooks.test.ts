/** Account webhooks: verifying a delivery, and the subscriptions it comes from. */

import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  Client,
  ConflictError,
  MandalaError,
  PlanLimitError,
  ValidationError,
  verify,
  WEBHOOK_COMPUTERS_MAX,
  WEBHOOK_DESCRIPTION_MAX,
  WEBHOOK_TOLERANCE_S,
  type WebhookHeaders,
} from '../src/index.js';
import {
  anyRoute,
  BASE,
  errorJson,
  json,
  type Responder,
  recorder,
  WEBHOOK,
  WEBHOOK_CREATED,
  WEBHOOK_DELIVERY,
} from './harness.js';

// OPL-3923 on the platform, OPL-4301 here. The second transport for events:
// the socket is for a caller attached to a computer and waiting, a webhook is
// for one that wants to be woken. Two halves, and the first is the one a
// customer writes code against and the platform can never change afterwards —
// the signing scheme. So what is pinned here first is the platform's own §3.2
// vector, byte for byte, with its three negatives: the timestamp is signed,
// the raw bytes are signed, and the window is judged before the MAC.
//
// The vector was computed by two implementations on the platform side and
// cross-checked, on this side, against the published `standardwebhooks`
// package: it signs the same inputs to the same 44 characters. That is the
// property the scheme was chosen for — a stranger's library agreeing — and it
// is why the vector can be held here as a constant rather than derived.

// --- the §3.2 vector ---------------------------------------------------------

const SECRET = 'whsec_bWFuZGFsYS13ZWJob29rLXRlc3QtdmVjdG9yLWtleSE=';
const PREVIOUS_SECRET = 'whsec_bWFuZGFsYS13ZWJob29rLXByZXZpb3VzLXNlY3JldDE=';
const ID = 'whd-9f3c1a7e5b2d4c80';
const TIMESTAMP = '1788264000';
const AT = 1788264000;
// 179 bytes, exactly, no trailing newline.
const BODY =
  '{"seq":41,"cursor":"mfc9z1k2x5ab.7:42","at":"2026-09-01T12:00:00.123456Z","type":"process.exited","computer":"vm-3f9a1c2b7d4e","source":"daemon","data":{"pid":4242,"exit_code":0}}';
const SIGNATURE = 'v1,PP7CJPCiIF9oXT07KaqThULfAcUn2NHnqw4RGHtpMpQ=';
const PREVIOUS_SIGNATURE = 'v1,v4aDLFaUcddhjKlS/A8H3yoTT/1JXDQahq4PtBhhq04=';

/** The three negatives, each of which must FAIL against the primary secret. */
const ONE_SECOND_LATER = 'v1,nkwCc4sFVT7w35kerNFmS9pxAIFHpB20av8iDbuTP3Y=';
const TRAILING_SPACE = 'v1,8cpgEE8mQ0ngAOh7RdvX/dw74GipMz0nPdoXzLnoWx0=';

const headers = (over: Record<string, string> = {}) => ({
  'webhook-id': ID,
  'webhook-timestamp': TIMESTAMP,
  'webhook-signature': SIGNATURE,
  ...over,
});

describe('verify: the §3.2 vector', () => {
  it('accepts the vector', async () => {
    expect(BODY.length).toBe(179);
    expect(await verify(SECRET, headers(), BODY, { now: AT })).toBe(true);
  });

  it('accepts the vector as bytes', async () => {
    // What `express.raw` or `req.arrayBuffer()` hands over. The string form
    // above is the same bytes after a UTF-8 decode, and both must verify,
    // because which one a framework offers is not the receiver's choice.
    const bytes = new TextEncoder().encode(BODY);
    expect(await verify(SECRET, headers(), bytes, { now: AT })).toBe(true);
  });

  it('accepts the vector as an ArrayBuffer, or any view onto one', async () => {
    // `await request.arrayBuffer()` is the Fetch API's own spelling of "the raw
    // body", and the doc comment names it. Reviewed on the first cut: it was
    // refused as a parsed object, with a message naming the wrong mistake.
    const bytes = new TextEncoder().encode(BODY);
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    expect(await verify(SECRET, headers(), buffer, { now: AT })).toBe(true);
    expect(await verify(SECRET, headers(), new DataView(buffer), { now: AT })).toBe(true);
    // A view that does not start at the buffer's beginning: the window is the
    // body, not the buffer behind it.
    const padded = new Uint8Array(bytes.length + 8);
    padded.set(bytes, 4);
    expect(
      await verify(SECRET, headers(), new Uint8Array(padded.buffer, 4, bytes.length), { now: AT }),
    ).toBe(true);
  });

  it('accepts a buffer from another realm, and a SharedArrayBuffer', async () => {
    // `instanceof ArrayBuffer` is realm-bound and `ArrayBuffer.isView` is false
    // for a bare buffer, so both of these arrived at the fallthrough still
    // being the wire bytes and were refused as a "parsed object" — told to go
    // and read the raw body they were already holding. The brand crosses a
    // realm where the constructor does not.
    const bytes = new TextEncoder().encode(BODY);
    const foreign = runInNewContext('new ArrayBuffer(n)', { n: bytes.length }) as ArrayBuffer;
    expect(foreign instanceof ArrayBuffer).toBe(false);
    new Uint8Array(foreign).set(bytes);
    expect(await verify(SECRET, headers(), foreign, { now: AT })).toBe(true);
    const shared = new SharedArrayBuffer(bytes.length);
    new Uint8Array(shared).set(bytes);
    expect(await verify(SECRET, headers(), shared as unknown as ArrayBuffer, { now: AT })).toBe(
      true,
    );
  });

  it('refuses the timestamp one second later: the timestamp is signed', async () => {
    // The platform's own negative: the same id and body at 1788264001 signs to
    // a different MAC. Presenting the ORIGINAL signature with the moved
    // timestamp must fail, and presenting the moved signature with the
    // original timestamp must fail too — either half alone is a forgery.
    expect(
      await verify(SECRET, headers({ 'webhook-timestamp': '1788264001' }), BODY, { now: AT }),
    ).toBe(false);
    expect(
      await verify(SECRET, headers({ 'webhook-signature': ONE_SECOND_LATER }), BODY, { now: AT }),
    ).toBe(false);
    // And the moved pair together IS a valid delivery — one second later.
    expect(
      await verify(
        SECRET,
        headers({ 'webhook-timestamp': '1788264001', 'webhook-signature': ONE_SECOND_LATER }),
        BODY,
        { now: AT },
      ),
    ).toBe(true);
  });

  it('refuses a body with one trailing space: the raw bytes are signed', async () => {
    // The negative the whole design turns on. A framework that parses and
    // re-serialises the body changes bytes exactly like this — whitespace,
    // key order, `<` becoming `<` — and every one of those is a different
    // message under the MAC.
    expect(await verify(SECRET, headers(), `${BODY} `, { now: AT })).toBe(false);
    expect(
      await verify(SECRET, headers({ 'webhook-signature': TRAILING_SPACE }), `${BODY} `, {
        now: AT,
      }),
    ).toBe(true);
    expect(
      await verify(SECRET, headers({ 'webhook-signature': TRAILING_SPACE }), BODY, { now: AT }),
    ).toBe(false);
  });

  it('refuses the vector outside the window, before the MAC is checked', async () => {
    // The third negative. The signature is the genuine one; only the receiver's
    // clock has moved. 300 s either side is inclusive — the specification's
    // recommendation, and what every library a receiver might use enforces.
    expect(await verify(SECRET, headers(), BODY, { now: AT + WEBHOOK_TOLERANCE_S })).toBe(true);
    expect(await verify(SECRET, headers(), BODY, { now: AT - WEBHOOK_TOLERANCE_S })).toBe(true);
    expect(await verify(SECRET, headers(), BODY, { now: AT + WEBHOOK_TOLERANCE_S + 1 })).toBe(
      false,
    );
    expect(await verify(SECRET, headers(), BODY, { now: AT - WEBHOOK_TOLERANCE_S - 1 })).toBe(
      false,
    );
    // Without `now`, the clock is the real one, and the vector is a fixed point
    // in September 2026 — outside the window from any date this test runs on.
    expect(await verify(SECRET, headers(), BODY)).toBe(false);
  });

  it('refuses the vector under another secret', async () => {
    expect(await verify(PREVIOUS_SECRET, headers(), BODY, { now: AT })).toBe(false);
  });
});

describe('verify: the rotation vector', () => {
  const rotated = headers({ 'webhook-signature': `${SIGNATURE} ${PREVIOUS_SIGNATURE}` });

  it('accepts a two-signature header under either secret', async () => {
    // Inside the 24 hours after a rotate, every delivery carries both. A
    // receiver still on the old secret and one already on the new must both
    // pass, or the rotation is an outage.
    expect(await verify(SECRET, rotated, BODY, { now: AT })).toBe(true);
    expect(await verify(PREVIOUS_SECRET, rotated, BODY, { now: AT })).toBe(true);
  });

  it('the previous signature alone verifies under the previous secret only', async () => {
    const previous = headers({ 'webhook-signature': PREVIOUS_SIGNATURE });
    expect(await verify(PREVIOUS_SECRET, previous, BODY, { now: AT })).toBe(true);
    expect(await verify(SECRET, previous, BODY, { now: AT })).toBe(false);
  });

  it('checks a bounded number of v1 entries, and no more', async () => {
    // Each entry costs an HMAC over the WHOLE body, and nothing in front of the
    // MAC is authenticated — so a header packed with well-formed base64 buys an
    // unauthenticated caller a multiple of that work, and a few hundred fit
    // inside an ordinary header size limit. A rotation puts two on a delivery;
    // the cap is eight, which is where this pins it.
    //
    // Well-formed, 32-byte and wrong: junk that decoded to the wrong LENGTH
    // would be skipped before it cost anything, and would prove nothing.
    const filler = `v1,${'A'.repeat(43)}=`;
    const behind = (n: number) =>
      headers({ 'webhook-signature': [...Array<string>(n).fill(filler), SIGNATURE].join(' ') });
    expect(await verify(SECRET, behind(7), BODY, { now: AT })).toBe(true);
    expect(await verify(SECRET, behind(8), BODY, { now: AT })).toBe(false);
    // Entries too short to be a MAC are not candidates and do not fill the
    // budget: skipping them is free, so counting them would refuse a genuine
    // delivery behind a header a proxy had padded with junk.
    const padded = headers({
      'webhook-signature': [...Array<string>(50).fill('v1,AAAA'), SIGNATURE].join(' '),
    });
    expect(await verify(SECRET, padded, BODY, { now: AT })).toBe(true);
  });

  it('ignores an entry whose version it does not know', async () => {
    // The format has a slot for a second scheme, and a receiver that refused a
    // header for carrying one would break the day the platform added it.
    const mixed = headers({ 'webhook-signature': `v1a,not-a-v1-entry ${SIGNATURE}` });
    expect(await verify(SECRET, mixed, BODY, { now: AT })).toBe(true);
    const onlyUnknown = headers({ 'webhook-signature': 'v1a,AAAA' });
    expect(await verify(SECRET, onlyUnknown, BODY, { now: AT })).toBe(false);
  });
});

describe('verify: the headers, however a framework holds them', () => {
  it('reads a Headers instance', async () => {
    expect(await verify(SECRET, new Headers(headers()), BODY, { now: AT })).toBe(true);
  });

  it('reads a Headers that is not the global one', async () => {
    // `instanceof Headers` names ONE implementation, and a receiver holds
    // whichever its framework built: node-fetch's, Hono's, an undici a bundler
    // pinned its own copy of, or the global one from another realm. All of them
    // keep their entries behind a private map, so the plain-object walk sees no
    // keys at all — and the answer was false on an AUTHENTIC delivery, which
    // reads to an operator as the platform signing wrong. A `get` method is the
    // shape's whole contract, so it is what gets taken.
    const bag = new Map(Object.entries(headers()));
    class ForeignHeaders {
      get(name: string): string | null {
        return bag.get(name.toLowerCase()) ?? null;
      }
    }
    const foreign = new ForeignHeaders() as unknown as WebhookHeaders;
    expect(foreign instanceof Headers).toBe(false);
    expect(Object.entries(foreign)).toEqual([]);
    expect(await verify(SECRET, foreign, BODY, { now: AT })).toBe(true);
    // And it is still the source of truth for a delivery that should fail: the
    // fallback reads it, it does not merely stop returning undefined.
    bag.set('webhook-signature', PREVIOUS_SIGNATURE);
    expect(await verify(SECRET, foreign, BODY, { now: AT })).toBe(false);
  });

  it('answers false, not a throw, when a Headers-like get returns something odd', async () => {
    // The duck-type takes any `get`, so what it hands back is checked rather
    // than trusted: a `null` for a missing header is the Fetch spelling, and an
    // implementation answering an array or an object must not reach the regex
    // and the base64 decoder as if it were a header value.
    const odd = { get: (name: string) => (name === 'webhook-id' ? [ID] : null) };
    expect(await verify(SECRET, odd as unknown as WebhookHeaders, BODY, { now: AT })).toBe(false);
  });

  it('matches header names case-insensitively', async () => {
    // HTTP header names are; the spec lower-cases them; a framework may not.
    const shouty = {
      'Webhook-Id': ID,
      'WEBHOOK-TIMESTAMP': TIMESTAMP,
      'Webhook-Signature': SIGNATURE,
    };
    expect(await verify(SECRET, shouty, BODY, { now: AT })).toBe(true);
  });

  it('reads the first of a Node header array', async () => {
    // IncomingHttpHeaders holds `string | string[] | undefined`.
    const node = { ...headers(), 'webhook-signature': [SIGNATURE, 'v1,junk'] };
    expect(await verify(SECRET, node, BODY, { now: AT })).toBe(true);
  });

  it('answers false, not a throw, for a delivery missing a header', async () => {
    // A bad delivery is the ordinary case a receiver is built to refuse, and
    // it must not take the receiver down.
    for (const name of ['webhook-id', 'webhook-timestamp', 'webhook-signature']) {
      const h: Record<string, string | undefined> = headers();
      delete h[name];
      expect(await verify(SECRET, h, BODY, { now: AT }), name).toBe(false);
    }
  });

  it('answers false for a timestamp that is not decimal seconds', async () => {
    // `Number('')` is 0 and `Number('1788264000.5')` is fine, so a lenient
    // parse would let a fraction through and read an empty value as 1970 —
    // failing the window by accident rather than by rule.
    for (const ts of ['', '1788264000.0', '1788264000e0', ' 1788264000', 'now', '0x6a9d5c40']) {
      const h = headers({ 'webhook-timestamp': ts });
      expect(await verify(SECRET, h, BODY, { now: AT }), JSON.stringify(ts)).toBe(false);
    }
  });

  it('answers false for a signature that is not base64, without decoding it', async () => {
    for (const sig of [
      'v1,',
      'v1,PP7CJPCiIF9oXT07KaqThULfAcUn2NHnqw4RGHtpMpQ',
      'v1,not base64!',
      'v1',
      '',
    ]) {
      const h = headers({ 'webhook-signature': sig });
      expect(await verify(SECRET, h, BODY, { now: AT }), JSON.stringify(sig)).toBe(false);
    }
  });
});

describe('verify: the configuration errors that are not deliveries', () => {
  it('refuses a secret without its prefix', async () => {
    // A misconfigured secret answering false forever is a webhook that never
    // works and never says why. This is the receiver's mistake, and it is
    // knowable before any delivery arrives.
    await expect(
      verify(SECRET.slice('whsec_'.length), headers(), BODY, { now: AT }),
    ).rejects.toThrow(ValidationError);
    await expect(verify('whsec_', headers(), BODY, { now: AT })).rejects.toThrow(/not base64/);
    await expect(verify('whsec_!!!!', headers(), BODY, { now: AT })).rejects.toThrow(/not base64/);
    await expect(
      verify(undefined as unknown as string, headers(), BODY, { now: AT }),
    ).rejects.toThrow(/secret must be a string/);
  });

  it('refuses a parsed body, naming the fix', async () => {
    // The mistake this whole scheme is about, made on the caller's behalf by
    // a JSON middleware. `String(object)` is `[object Object]`, which would
    // fail every delivery with no clue why.
    await expect(
      verify(SECRET, headers(), JSON.parse(BODY) as unknown as string, { now: AT }),
    ).rejects.toThrow(/parsed object/);
    // And a body of no usable kind at all says so, rather than calling it parsed.
    await expect(verify(SECRET, headers(), 42 as unknown as string, { now: AT })).rejects.toThrow(
      /got number/,
    );
  });

  it('refuses a window that is not a number', async () => {
    await expect(verify(SECRET, headers(), BODY, { now: Number.NaN })).rejects.toThrow(
      ValidationError,
    );
    await expect(verify(SECRET, headers(), BODY, { now: AT, toleranceS: -1 })).rejects.toThrow(
      ValidationError,
    );
  });

  it('refuses the window before it reads the delivery, so a test sees it too', async () => {
    // The receiver's own arguments are judged first, and all of them, before a
    // field of the delivery is read. Judged after the headers, a NaN window
    // threw for a good delivery and answered false for a bad one — so a
    // receiver whose clock argument was wrong would learn it only once real
    // traffic arrived, and never from its own tests, which are the ones that
    // send an empty header bag.
    for (const opts of [{ now: Number.NaN }, { toleranceS: Number.NaN }, { toleranceS: -1 }]) {
      await expect(verify(SECRET, {}, BODY, opts), JSON.stringify(opts)).rejects.toThrow(
        ValidationError,
      );
    }
  });
});

// --- the resource --------------------------------------------------------------

const client = (respond: Responder) => {
  const rec = recorder(respond);
  return { rec, client: new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch }) };
};

describe('webhooks: the subscriptions', () => {
  it('creates one, sending exactly what was given, and hands back the secret', async () => {
    const { rec, client: c } = client(anyRoute);
    const hook = await c.webhooks.create({
      url: 'https://ci.example.com/mandala',
      events: ['process.exited', 'computer.ready'],
    });
    expect(rec.last().method).toBe('POST');
    expect(rec.last().path).toBe('/webhooks');
    // The optional fields are OMITTED, not sent as null or as an empty list:
    // the platform's defaults apply only where a key is absent, and an empty
    // `computers` sent by accident would be "every computer" said out loud.
    expect(rec.last().body).toEqual({
      url: 'https://ci.example.com/mandala',
      events: ['process.exited', 'computer.ready'],
    });
    expect(hook.id).toBe(WEBHOOK.id);
    expect(hook.secret).toBe(WEBHOOK_CREATED.secret);
    expect(hook.enabled).toBe(true);
    expect(hook.events).toEqual(['process.exited', 'computer.ready']);
    expect(hook.computers).toEqual([]);
  });

  it('refuses a create whose answer has no secret', async () => {
    // The one field only this answer carries. Without it the caller has a
    // subscription nothing can ever verify and would learn so from a 401 in
    // their own logs on the first delivery.
    const { client: c } = client((call) =>
      call.method === 'POST' && call.path === '/webhooks' ? json(WEBHOOK) : anyRoute(call),
    );
    await expect(c.webhooks.create({ url: 'https://ci.example.com/mandala' })).rejects.toThrow(
      /expected a secret from POST webhooks/,
    );
  });

  it('refuses the URLs the platform would refuse, before sending them', async () => {
    const { rec, client: c } = client(anyRoute);
    for (const url of ['http://ci.example.com/x', 'ci.example.com/x', '', 'ftp://x/y']) {
      await expect(c.webhooks.create({ url }), url).rejects.toThrow(ValidationError);
    }
    // Userinfo refused rather than stripped: the signature is the
    // authentication, and a URL carrying a credential is a caller expecting
    // one to be sent.
    await expect(c.webhooks.create({ url: 'https://user:pw@ci.example.com/x' })).rejects.toThrow(
      /username or password/,
    );
    await expect(c.webhooks.create(undefined as unknown as { url: string })).rejects.toThrow(
      ValidationError,
    );
    await expect(c.webhooks.create({} as { url: string })).rejects.toThrow(/url is required/);
    expect(rec.calls).toEqual([]);
  });

  it('refuses a filter that is not a list of ids', async () => {
    const { rec, client: c } = client(anyRoute);
    const url = 'https://ci.example.com/mandala';
    await expect(
      c.webhooks.create({ url, events: 'process.exited' as unknown as string[] }),
    ).rejects.toThrow(/events must be an array/);
    await expect(c.webhooks.create({ url, computers: ['vm-1', ''] })).rejects.toThrow(
      /computers\[1\] must be a non-empty string/,
    );
    await expect(
      c.webhooks.create({ url, enabled: 'false' as unknown as boolean }),
    ).rejects.toThrow(/enabled must be a boolean/);
    expect(rec.calls).toEqual([]);
  });

  it("refuses the two caps the platform documents, at the platform's own lengths", async () => {
    // `.length` on the string and on the list as given, before de-duplication,
    // which is how the platform measures both — so the edge is accepted here
    // exactly where it is accepted there.
    const { rec, client: c } = client(anyRoute);
    const url = 'https://ci.example.com/mandala';
    await c.webhooks.create({ url, description: 'x'.repeat(WEBHOOK_DESCRIPTION_MAX) });
    await expect(
      c.webhooks.create({ url, description: 'x'.repeat(WEBHOOK_DESCRIPTION_MAX + 1) }),
    ).rejects.toThrow(/description is at most 200 characters \(got 201\)/);
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `vm-${i}`);
    await c.webhooks.create({ url, computers: ids(WEBHOOK_COMPUTERS_MAX) });
    await expect(
      c.webhooks.update('whk-1', { computers: ids(WEBHOOK_COMPUTERS_MAX + 1) }),
    ).rejects.toThrow(/at most 64 computers \(got 65\)/);
    // Duplicates count as given: the platform checks the raw length first.
    await expect(
      c.webhooks.create({ url, computers: Array(WEBHOOK_COMPUTERS_MAX + 1).fill('vm-1') }),
    ).rejects.toThrow(/at most 64/);
    expect(rec.calls.length).toBe(2);
  });

  it('lists and reads without ever seeing a secret', async () => {
    const { rec, client: c } = client(anyRoute);
    const all = await c.webhooks.list();
    expect(rec.last().path).toBe('/webhooks');
    expect(all.map((w) => w.id)).toEqual([WEBHOOK.id]);
    expect('secret' in all[0]!).toBe(false);
    expect(all[0]!.raw.secret).toBeUndefined();

    const one = await c.webhooks.get('whk-1');
    expect(rec.last().path).toBe('/webhooks/whk-1');
    expect(one.url).toBe(WEBHOOK.url);
  });

  it('reads the health fields as absent until there is something to say', async () => {
    // `null` on the wire, and `''` or `0` would read as a timestamp that was
    // lost or a status of zero.
    const { client: c } = client(anyRoute);
    const w = await c.webhooks.get('whk-1');
    expect(w.disabledReason).toBeUndefined();
    expect(w.disabledAt).toBeUndefined();
    expect(w.lastSuccessAt).toBeUndefined();
    expect(w.lastFailureAt).toBeUndefined();
    expect(w.lastStatus).toBeUndefined();
    expect(w.workspaceId).toBeUndefined();
    expect('lastStatus' in w).toBe(false);
  });

  it('reads a failing subscription as what it is', async () => {
    const failing = {
      ...WEBHOOK,
      enabled: false,
      disabled_reason: 'failing',
      disabled_at: '2026-09-02T12:00:00.000Z',
      last_success_at: '2026-09-01T12:00:00.000Z',
      last_failure_at: '2026-09-02T11:59:00.000Z',
      last_status: 503,
      workspace_id: 'wsp-1',
    };
    const { client: c } = client((call) =>
      call.path === '/webhooks/whk-1' ? json(failing) : anyRoute(call),
    );
    const w = await c.webhooks.get('whk-1');
    expect(w.enabled).toBe(false);
    expect(w.disabledReason).toBe('failing');
    expect(w.lastStatus).toBe(503);
    expect(w.workspaceId).toBe('wsp-1');
    expect(w.lastSuccessAt).toBe('2026-09-01T12:00:00.000Z');
  });

  it('reads an unreadable enabled as false', async () => {
    // The safe direction: an `enabled` this client cannot read is not one it
    // should report as delivering.
    const { client: c } = client((call) =>
      call.path === '/webhooks/whk-1' ? json({ ...WEBHOOK, enabled: 'yes' }) : anyRoute(call),
    );
    expect((await c.webhooks.get('whk-1')).enabled).toBe(false);
  });

  it('keeps only the strings in an id list', async () => {
    // A `null` through `str()` would be `''`, which is not an id and would
    // read as one, on the list that decides which computers are heard from.
    const { client: c } = client((call) =>
      call.path === '/webhooks/whk-1'
        ? json({ ...WEBHOOK, computers: ['vm-1', null, 7, 'vm-2'], events: 'process.exited' })
        : anyRoute(call),
    );
    const w = await c.webhooks.get('whk-1');
    expect(w.computers).toEqual(['vm-1', 'vm-2']);
    expect(w.events).toEqual([]);
  });

  it('updates with only the fields named, and sends an empty list as itself', async () => {
    const { rec, client: c } = client(anyRoute);
    await c.webhooks.update('whk-1', { enabled: true });
    expect(rec.last().method).toBe('PATCH');
    expect(rec.last().path).toBe('/webhooks/whk-1');
    expect(rec.last().body).toEqual({ enabled: true });

    // `[]` CLEARS a filter and omitted leaves it alone, so the two must reach
    // the wire as two different things.
    await c.webhooks.update('whk-1', { events: [] });
    expect(rec.last().body).toEqual({ events: [] });
  });

  it('refuses an empty update before sending it', async () => {
    const { rec, client: c } = client(anyRoute);
    await expect(c.webhooks.update('whk-1', {})).rejects.toThrow(/nothing to update/);
    await expect(c.webhooks.update('whk-1', { url: undefined })).rejects.toThrow(
      /nothing to update/,
    );
    expect(rec.calls).toEqual([]);
  });

  it('deletes, and answers nothing', async () => {
    const { rec, client: c } = client(anyRoute);
    expect(await c.webhooks.delete('whk-1')).toBeUndefined();
    expect(rec.last().method).toBe('DELETE');
    expect(rec.last().path).toBe('/webhooks/whk-1');
  });

  it('refuses an empty id rather than reaching the collection', async () => {
    // `webhooks/` is the LIST route, and a get with an empty id would decode a
    // listing as one subscription. A delete with one would be aimed at a route
    // that was never asked to answer it.
    const { rec, client: c } = client(anyRoute);
    await expect(c.webhooks.get('')).rejects.toThrow(/webhook id must not be empty/);
    await expect(c.webhooks.delete('..')).rejects.toThrow(ValidationError);
    expect(rec.calls).toEqual([]);
  });

  it('rotates: a POST with no body, answered with the subscription and a new secret', async () => {
    const { rec, client: c } = client(anyRoute);
    const hook = await c.webhooks.rotate('whk-1');
    expect(rec.last().method).toBe('POST');
    expect(rec.last().path).toBe('/webhooks/whk-1/rotate');
    expect(rec.last().body).toBeUndefined();
    expect(hook.secret).toBe(WEBHOOK_CREATED.secret);
  });

  it('tests: a POST answered 202 with the delivery, accepted rather than finished', async () => {
    const { rec, client: c } = client(anyRoute);
    const d = await c.webhooks.test('whk-1');
    expect(rec.last().path).toBe('/webhooks/whk-1/test');
    expect(d.id).toBe(WEBHOOK_DELIVERY.id);
    expect(d.eventType).toBe('webhook.test');
    expect(d.state).toBe('pending');
    expect(d.attempts).toBe(0);
    expect(d.nextAt).toBe(WEBHOOK_DELIVERY.next_at);
    expect(d.attemptedAt).toBeUndefined();
    expect(d.lastStatus).toBeUndefined();
    expect(d.lastError).toBeUndefined();
    expect(d.deliveredAt).toBeUndefined();
  });

  it('lists deliveries, reading an exhausted one as what it is', async () => {
    const exhausted = {
      ...WEBHOOK_DELIVERY,
      event_type: 'process.exited',
      computer: 'vm-3f9a1c2b7d4e',
      cursor: 'mfc9z1k2x5ab.7:42',
      state: 'exhausted',
      attempts: 8,
      next_at: null,
      attempted_at: '2026-09-02T02:00:00.000Z',
      last_status: null,
      last_error: 'timeout',
    };
    const { rec, client: c } = client((call) =>
      call.path === '/webhooks/whk-1/deliveries'
        ? json([exhausted, WEBHOOK_DELIVERY])
        : anyRoute(call),
    );
    const list = await c.webhooks.deliveries('whk-1');
    expect(rec.last().method).toBe('GET');
    expect(list.map((d) => d.state)).toEqual(['exhausted', 'pending']);
    const [gone] = list;
    expect(gone!.attempts).toBe(8);
    expect(gone!.nextAt).toBeUndefined();
    expect(gone!.lastStatus).toBeUndefined();
    expect(gone!.lastError).toBe('timeout');
    expect(gone!.cursor).toBe('mfc9z1k2x5ab.7:42');
  });

  it('refuses an answer of the wrong shape, naming the route', async () => {
    const { client: c } = client((call) =>
      call.path.startsWith('/webhooks') ? json('nope') : anyRoute(call),
    );
    await expect(c.webhooks.get('whk-1')).rejects.toThrow(
      /expected a webhook from GET webhooks\/whk-1/,
    );
    await expect(c.webhooks.list()).rejects.toThrow(MandalaError);
    await expect(c.webhooks.test('whk-1')).rejects.toThrow(/expected a delivery from POST/);
  });

  it('maps the two refusals a subscription meets to the errors every other route uses', async () => {
    // The eleventh subscription is a 409 naming the cap; an account with no
    // plan is a 402. Neither is retryable, and both are the classes the rest of
    // this SDK already hands back for those statuses.
    const { client: c } = client((call) =>
      call.method === 'POST' && call.path === '/webhooks'
        ? errorJson(409, 'this account already holds 10 webhooks, which is the plan’s limit')
        : call.path.endsWith('/test')
          ? errorJson(409, 'this subscription is disabled; enable it first')
          : anyRoute(call),
    );
    await expect(c.webhooks.create({ url: 'https://ci.example.com/x' })).rejects.toThrow(
      ConflictError,
    );
    await expect(c.webhooks.test('whk-1')).rejects.toThrow(ConflictError);

    const { client: unpaid } = client((call) =>
      call.method === 'POST' && call.path === '/webhooks'
        ? errorJson(402, 'webhooks need a plan')
        : anyRoute(call),
    );
    await expect(unpaid.webhooks.create({ url: 'https://ci.example.com/x' })).rejects.toThrow(
      PlanLimitError,
    );
  });

  it('verifies a delivery signed with the secret a create answered', async () => {
    // The two halves meeting: the secret off the wire is the one `verify`
    // takes, with no transformation in between.
    const { client: c } = client(anyRoute);
    const hook = await c.webhooks.create({ url: 'https://ci.example.com/mandala' });
    expect(await verify(hook.secret, headers(), BODY, { now: AT })).toBe(true);
  });
});
