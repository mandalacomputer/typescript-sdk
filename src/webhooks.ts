/**
 * Verifying a webhook delivery — the one piece of this SDK that runs on the
 * RECEIVING end of the platform rather than the calling end.
 *
 * The platform signs every delivery with Standard Webhooks v1
 * (standardwebhooks.com, specification 1.0), verbatim — chosen because it is a
 * published scheme with verifier libraries in more languages than we ship, so
 * a receiver can check this file against something other than our own
 * reference. Any of those libraries verifies a Mandala delivery; this is the
 * same check without the dependency, holding the platform's own test vector.
 *
 * The scheme, in full:
 *
 * - Three headers: `webhook-id`, `webhook-timestamp`, `webhook-signature`.
 * - The signed content is `<id>.<timestamp>.<raw body>` — the body's exact
 *   bytes on the wire, and never a re-serialised object.
 * - HMAC-SHA256, keyed by the secret's bytes after `whsec_`, base64-decoded.
 * - `webhook-signature` is `v1,<base64 MAC>`; several entries may be present,
 *   space-separated, and ANY `v1` entry verifying accepts the delivery. That is
 *   how a rotation stays verifiable: for 24 hours after one, every delivery
 *   carries a signature under each secret, new first.
 * - A timestamp more than 300 seconds from the receiver's clock is refused
 *   before the MAC is checked.
 *
 * WebCrypto rather than `node:crypto`, and therefore async. The library half of
 * this package promises to run anywhere `fetch` does — workers, the edge — and a
 * webhook receiver is exactly the thing people put on an edge runtime. `subtle`
 * is on every one of them, and its `verify` compares the MAC in constant time,
 * which is the one property a hand-rolled comparison gets wrong.
 */

import { ValidationError } from './errors.js';

/** The prefix on every signing secret the platform mints. */
export const WEBHOOK_SECRET_PREFIX = 'whsec_';

/**
 * How far a delivery's `webhook-timestamp` may sit from the receiver's clock,
 * in seconds, either side.
 *
 * The specification's recommendation and the default every library a receiver
 * might reach for already enforces. Retries carry a fresh timestamp, so an
 * attempt at sixteen hours verifies as cleanly as the first; and a clock more
 * than five minutes wrong refuses every delivery, which is loud, immediate and
 * its own fault — better than a window wide enough to hide it.
 */
export const WEBHOOK_TOLERANCE_S = 300;

/**
 * The request headers, in any of the shapes a receiver is likely to be holding.
 *
 * A `Headers` instance (fetch, Workers, Deno, Bun, Next), a Node
 * `IncomingHttpHeaders` — whose values are `string | string[] | undefined` — or
 * a plain object. Names are matched case-insensitively whatever the shape,
 * because HTTP header names are, and a receiver must not depend on how its
 * framework happened to spell them.
 */
export type WebhookHeaders =
  | Headers
  | Readonly<Record<string, string | readonly string[] | undefined>>;

export type VerifyOptions = {
  /**
   * The receiver's clock, as Unix SECONDS. Defaults to now. For tests, and for
   * a receiver replaying a stored delivery against the time it arrived.
   */
  now?: number;
  /** Override {@link WEBHOOK_TOLERANCE_S}. Widening it weakens the replay bound; there is rarely a reason to. */
  toleranceS?: number;
};

const SIGNATURE_VERSION = 'v1';

/**
 * Whether a delivery is authentic: signed by `secret`, and recent.
 *
 * ```ts
 * app.post('/mandala', express.raw({ type: 'application/json' }), async (req, res) => {
 *   if (!(await verify(process.env.MANDALA_WEBHOOK_SECRET!, req.headers, req.body))) {
 *     return res.status(401).end();
 *   }
 *   res.status(200).end();               // acknowledge first, then do the work
 *   const event = JSON.parse(req.body.toString('utf8'));
 * });
 * ```
 *
 * `rawBody` is the request body EXACTLY as it arrived — the bytes, or the
 * string those bytes decode to. Not the parsed object, and not
 * `JSON.stringify` of it: the signature is over the wire bytes, and a
 * framework that parses JSON before your handler sees it has already lost them.
 * Read the raw body (`express.raw`, `request.text()`, `await req.arrayBuffer()`)
 * and hand it here untouched.
 *
 * Answers `false` for a delivery that is not authentic — a missing or
 * malformed header, a timestamp outside the window, a signature under another
 * secret. Throws only for a `secret` this receiver could never verify anything
 * with, because that is a configuration error and not a bad delivery: a
 * verifier that answered `false` forever because the secret was pasted without
 * its prefix is a webhook that silently never works.
 *
 * `secret` is the value `POST /webhooks` or `POST /webhooks/{id}/rotate`
 * answered once. Inside the 24 hours after a rotation either secret verifies
 * the delivery, so a receiver can switch from the old to the new at leisure.
 *
 * Remember every `webhook-id` you accept for at least the window: a retry of a
 * delivery you already acknowledged carries the same id and a fresh signature,
 * and verifies. Together the timestamp and the id close every replay, and the
 * memory is bounded by construction.
 */
export async function verify(
  secret: string,
  headers: WebhookHeaders,
  rawBody: string | Uint8Array,
  opts: VerifyOptions = {},
): Promise<boolean> {
  const key = secretBytes(secret);
  const body = bodyBytes(rawBody);

  const id = header(headers, 'webhook-id');
  const timestamp = header(headers, 'webhook-timestamp');
  const signature = header(headers, 'webhook-signature');
  if (!id || !timestamp || !signature) return false;

  // The replay window, judged before the MAC (§4 of the design). Decimal Unix
  // seconds, no fraction, as sent — anything else is not a timestamp the
  // platform wrote, and `Number('')` being 0 is one more way a missing value
  // would otherwise read as January 1970 and fail the window by accident
  // rather than by rule.
  if (!/^\d{1,16}$/.test(timestamp)) return false;
  const now = opts.now ?? Date.now() / 1000;
  const tolerance = opts.toleranceS ?? WEBHOOK_TOLERANCE_S;
  if (!Number.isFinite(now) || !Number.isFinite(tolerance) || tolerance < 0) {
    throw new ValidationError('now and toleranceS must be finite numbers, in seconds');
  }
  if (Math.abs(now - Number(timestamp)) > tolerance) return false;

  const signed = concat(encodeText(`${id}.${timestamp}.`), body);
  const cryptoKey = await subtle().importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'verify',
  ]);

  // Every entry is tried, and the first that verifies accepts. Entries whose
  // version this receiver does not know are ignored rather than refused, which
  // is what lets the platform add a second scheme beside this one without a
  // release of this SDK — the format has the slot for it.
  for (const entry of signature.split(' ')) {
    const comma = entry.indexOf(',');
    if (comma === -1 || entry.slice(0, comma) !== SIGNATURE_VERSION) continue;
    const mac = base64(entry.slice(comma + 1));
    // A MAC of the wrong length cannot verify; `subtle.verify` would say so
    // itself, but a 32-byte check is not a comparison and cannot leak anything.
    if (mac?.length !== 32) continue;
    if (await subtle().verify('HMAC', cryptoKey, mac, signed)) return true;
  }
  return false;
}

/**
 * The key bytes out of a secret, refused when the secret is not one.
 *
 * Typed as a string at the boundary rather than trusted: this is called from
 * JavaScript, and a `Buffer` or an `undefined` from a missing environment
 * variable arriving here would otherwise be a verifier that fails every
 * delivery and names nothing.
 */
function secretBytes(secret: string): Uint8Array {
  if (typeof secret !== 'string') {
    throw new ValidationError(`secret must be a string (got ${typeof secret})`);
  }
  if (!secret.startsWith(WEBHOOK_SECRET_PREFIX)) {
    throw new ValidationError(
      `secret must start with ${WEBHOOK_SECRET_PREFIX}: use the value POST /webhooks answered`,
    );
  }
  const key = base64(secret.slice(WEBHOOK_SECRET_PREFIX.length));
  if (!key || key.length === 0) {
    throw new ValidationError(`secret is not base64 after ${WEBHOOK_SECRET_PREFIX}`);
  }
  return key;
}

function bodyBytes(rawBody: string | Uint8Array): Uint8Array {
  if (typeof rawBody === 'string') return encodeText(rawBody);
  if (rawBody instanceof Uint8Array) return rawBody;
  // The parsed object is the mistake this whole file is about, and the one a
  // framework makes on the caller's behalf. Refusing it names the fix; letting
  // `String(rawBody)` produce `[object Object]` would fail every delivery with
  // no clue why.
  throw new ValidationError(
    'rawBody must be the request body as bytes or a string, not a parsed object — read the raw body',
  );
}

/**
 * One header, by name, whatever the container.
 *
 * A Node `IncomingHttpHeaders` may hold an array where a header was sent
 * twice. The platform sends each of these once; a duplicate is something in
 * front of the receiver adding one, and the first is taken, the way Node
 * itself joins them for the headers it does not special-case.
 */
function header(headers: WebhookHeaders, name: string): string | undefined {
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }
  if (typeof headers !== 'object' || headers === null) return undefined;
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== name) continue;
    const first = Array.isArray(v) ? v[0] : v;
    return typeof first === 'string' ? first : undefined;
  }
  return undefined;
}

/**
 * Standard base64 with padding, decoded, or `undefined` for text that is not.
 *
 * Checked before `atob`, which is lenient about whitespace and, on some
 * runtimes, about padding — and a signature is not a place for leniency. Strict
 * on the alphabet and the length, so an entry that is not base64 is skipped
 * rather than decoded into something and compared.
 */
function base64(text: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) return undefined;
  try {
    const bin = atob(text);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return undefined;
  }
}

const encodeText = (s: string): Uint8Array => new TextEncoder().encode(s);

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** WebCrypto, named so the one place it is missing says so rather than throwing `undefined.importKey`. */
function subtle(): typeof globalThis.crypto.subtle {
  const s = globalThis.crypto?.subtle;
  if (!s) {
    throw new ValidationError(
      'this runtime has no WebCrypto (globalThis.crypto.subtle), which verify() needs',
    );
  }
  return s;
}
