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

/**
 * The request body as it arrived, in whatever container the runtime hands it
 * over: the text (`request.text()`), a `Buffer` or `Uint8Array`
 * (`express.raw`), an `ArrayBuffer` (`request.arrayBuffer()`), or any other
 * view onto one. Every one of these is the wire bytes; a parsed object is the
 * one thing that is not.
 */
export type WebhookBody = string | ArrayBuffer | ArrayBufferView;

const SIGNATURE_VERSION = 'v1';

/**
 * How many `v1` entries in one `webhook-signature` are worth checking.
 *
 * Each entry costs an HMAC over the WHOLE body, so a header packed with
 * well-formed base64 buys an unauthenticated caller a multiple of that work —
 * a few hundred of them fit inside an ordinary header size limit, and nothing
 * in front of the MAC is authenticated. A rotation puts two entries on a
 * delivery and never more; eight leaves room for a scheme this SDK has not
 * seen yet and still bounds the work a stranger can ask for.
 */
const SIGNATURE_CANDIDATES_MAX = 8;

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
  rawBody: WebhookBody,
  opts: VerifyOptions = {},
): Promise<boolean> {
  // Everything the RECEIVER supplied is judged first, and all of it, before a
  // single field of the delivery is read. A window of NaN is the same class of
  // mistake as a secret without its prefix, and it has to say so on every call:
  // judged after the headers, it would throw for a good delivery and answer
  // false for a bad one, so a receiver whose clock argument was wrong would
  // learn it only once real traffic arrived — and never from its own tests,
  // which are the ones that send an empty header bag.
  const key = secretBytes(secret);
  const body = bodyBytes(rawBody);
  const now = opts.now ?? Date.now() / 1000;
  const tolerance = opts.toleranceS ?? WEBHOOK_TOLERANCE_S;
  if (!Number.isFinite(now) || !Number.isFinite(tolerance) || tolerance < 0) {
    throw new ValidationError('now and toleranceS must be finite numbers, in seconds');
  }

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
  if (Math.abs(now - Number(timestamp)) > tolerance) return false;

  const signed = concat(encodeText(`${id}.${timestamp}.`), body);
  const cryptoKey = await subtle().importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'verify',
  ]);

  // Every entry is tried, and the first that verifies accepts. Entries whose
  // version this receiver does not know are ignored rather than refused, which
  // is what lets the platform add a second scheme beside this one without a
  // release of this SDK — the format has the slot for it.
  let checked = 0;
  for (const entry of signature.split(' ')) {
    const comma = entry.indexOf(',');
    if (comma === -1 || entry.slice(0, comma) !== SIGNATURE_VERSION) continue;
    const mac = base64(entry.slice(comma + 1));
    // A MAC of the wrong length cannot verify; `subtle.verify` would say so
    // itself, but a 32-byte check is not a comparison and cannot leak anything.
    // It is also what keeps the count below counting only the entries that
    // would cost an HMAC — junk is skipped for nothing.
    if (mac?.length !== 32) continue;
    if (++checked > SIGNATURE_CANDIDATES_MAX) break;
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

function bodyBytes(rawBody: WebhookBody): Uint8Array {
  if (typeof rawBody === 'string') return encodeText(rawBody);
  if (rawBody instanceof Uint8Array) return rawBody;
  if (rawBody instanceof ArrayBuffer) return new Uint8Array(rawBody);
  // Any other view — a DataView, a Buffer from a runtime whose Buffer is not a
  // Uint8Array subclass — is still the bytes; only its window onto them
  // differs.
  if (ArrayBuffer.isView(rawBody)) {
    return new Uint8Array(rawBody.buffer, rawBody.byteOffset, rawBody.byteLength);
  }
  // `instanceof` above is realm-bound, and `ArrayBuffer.isView` is false for a
  // bare buffer — so a buffer from another realm, and every SharedArrayBuffer,
  // arrives here still being the wire bytes. The brand crosses realms where the
  // constructor does not, and reading it before the fallthrough is what keeps
  // those from being called a parsed object and told to go read the raw body
  // they are already holding.
  const brand = Object.prototype.toString.call(rawBody);
  if (brand === '[object ArrayBuffer]' || brand === '[object SharedArrayBuffer]') {
    return new Uint8Array(rawBody as ArrayBufferLike);
  }
  // The parsed object is the mistake this whole file is about, and the one a
  // framework makes on the caller's behalf. Refusing it names the fix; letting
  // `String(rawBody)` produce `[object Object]` would fail every delivery with
  // no clue why. Named separately from a body of some other wrong type, so the
  // message says which mistake was made.
  const what: unknown = rawBody;
  if (isRecord(what) || Array.isArray(what)) {
    throw new ValidationError(
      'rawBody is a parsed object, not the request body: read the raw body (express.raw, request.text(), request.arrayBuffer()) and pass it untouched',
    );
  }
  throw new ValidationError(
    `rawBody must be the request body as a string, ArrayBuffer or byte view (got ${what === null ? 'null' : typeof what})`,
  );
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

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
  // `instanceof` is realm-bound and names one implementation, and a receiver
  // holds whichever its framework built: node-fetch's, Hono's, an undici a
  // bundler pinned a copy of, or the global one from another realm. All of
  // them keep their entries behind a private map, so `Object.entries` below
  // sees nothing and every lookup answers undefined — which is not "no such
  // header" but a false from verify() on an AUTHENTIC delivery, the one
  // failure in this file that reads to an operator as the platform signing
  // wrong. A `get` method is what the shape promises; taking it is the whole
  // contract, and a plain header bag has no such key to be mistaken for one.
  const get: unknown = (headers as { get?: unknown }).get;
  if (typeof get === 'function') {
    const v: unknown = (get as (n: string) => unknown).call(headers, name);
    return typeof v === 'string' ? v : undefined;
  }
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
