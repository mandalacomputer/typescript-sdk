/**
 * The HTTP transport: auth, URLs, and which exception a status maps to.
 *
 * One transport per client. The key lives in a private field and is never put
 * on an error, a log line, or a returned object — an API key is every computer
 * on the account, forever.
 *
 * There is one transport here where the Python SDK has two, because there is
 * one kind of IO in this language. Everything the two Python transports shared
 * — key resolution, URL building, the status table — is the whole file here.
 */

import {
  type APIError,
  ConnectionError,
  ConnectionInterruptedError,
  errorForStatus,
  MandalaError,
  ValidationError,
} from './errors.js';
import { isRecord } from './paths.js';

export const DEFAULT_BASE_URL = 'https://app.mandala.computer/api/v1';

/** Largest delay Node timers can represent without wrapping to one millisecond. */
export const MAX_TIMER_MS = 2_147_483_647;

/**
 * Anthropic's own key, forwarded for the one route that runs a model.
 *
 * The platform never stores it: {@link Computers.agent} runs on the caller's
 * key and bills it, and the header exists so that can be true.
 */
export const MODEL_KEY_HEADER = 'X-Model-Key';

/** The header the platform sets when a fan-out listing came back short. */
const INCOMPLETE_HEADER = 'X-GC-Incomplete';

/** Largest single event retained while waiting for its blank-line delimiter. */
const MAX_SSE_EVENT_CHARS = 1 << 20;

/**
 * How big a request body is, when that can be known without consuming it.
 *
 * One definition because two decisions turn on it and they are the same
 * question: whether a caller's `contentLength` can be checked against what is
 * actually being sent, and whether undici needs `duplex: 'half'` to accept the
 * body at all. Split, they drift — and they drift in opposite directions, each
 * silent. A body wrongly called measurable has its length compared against
 * `undefined` and is refused; a body wrongly called unmeasurable has a caller's
 * number framed against bytes nobody counted.
 *
 * Measured off what the value has rather than what it is an instance of:
 * `byteLength` covers a `Uint8Array`, a `DataView` and a bare `ArrayBuffer`,
 * `size` covers a `Blob` or `File`, and all of those are bodies undici sends
 * with a length it works out itself. An `instanceof` in either position asks
 * where the constructor came from instead — which is how a cross-realm or
 * polyfilled value gets the wrong answer.
 *
 * Everything left has no size until it is read: a native `ReadableStream`, a
 * polyfilled or cross-realm one, the Node `Readable` an untyped caller can pass
 * because undici accepts one. That is exactly the body whose declared length
 * must be taken on trust, and exactly the body undici will not send without
 * half-duplex.
 */
export function bodyByteLength(body: unknown): number | undefined {
  const sized = body as { byteLength?: unknown; size?: unknown } | null | undefined;
  const measured = sized?.byteLength ?? sized?.size;
  return typeof measured === 'number' ? measured : undefined;
}

export type Query = Record<string, string | number | boolean | undefined>;

export type RequestOptions = {
  query?: Query;
  body?: unknown;
  /** Raw bytes (or a stream of them) as the request body, for the file upload. Exclusive with `body`. */
  raw?: Uint8Array | ReadableStream<Uint8Array>;
  /** Extra headers for this call only. */
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /**
   * Exempt this request from the client's per-request deadline.
   *
   * For streaming routes and explicitly unbounded file transfers. A stream is
   * meant to stay open — an agent run is minutes of clicking — and a copy's
   * duration depends on its size and link, not a fixed SDK default.
   *
   * A flag rather than "pass a signal and skip the timeout", which is what this
   * was at first and did not work: the composition below folds the timeout in
   * whenever there is one, so handing it a dummy signal changed nothing and the
   * stream was still killed at 60 seconds.
   */
  noTimeout?: boolean;
  /**
   * Raise this request's deadline to at least this many milliseconds.
   *
   * For the calls whose legitimate duration the caller knows better than the
   * client-wide default — an exec that granted the guest a long timeout, a
   * large file transfer. It only ever extends: the client's own setting still
   * applies when larger, and a client that disabled the deadline stays exempt.
   */
  minTimeoutMs?: number;
};

/**
 * One `Content-Range` window, as the response stated it.
 *
 * `total` is the whole file's length and not the window's — which is what makes
 * a paging loop possible at all: it is how a caller reads off how much is left
 * after being handed less than they asked for. Absent only where the response
 * answered `*`, which this platform does not do on a 206 but which the grammar
 * allows and a proxy in front of it could.
 */
export type ContentRange = {
  /** First byte of the window, inclusive. */
  start: number;
  /** Last byte of the window, inclusive. */
  end: number;
  /** The whole representation's length, when the response named one. */
  total?: number;
};

/** A non-JSON response body, with what the platform said it was. */
export type Bytes = {
  bytes: Uint8Array;
  contentType: string;
  /** From Content-Disposition, when the platform named the file. */
  filename?: string;
  /**
   * The response's status.
   *
   * Carried because a `206` and a `200` are the same bytes and opposite
   * answers: one is the window that was asked for, the other is the whole file
   * with the range ignored. Without the status a caller cannot tell which they
   * got, and a `Range` becomes write-only — you could ask for a window and not
   * learn what came back.
   */
  status: number;
  /** Which bytes these are, and how many the file has. Present on a `206`. */
  contentRange?: ContentRange;
  /**
   * `Accept-Ranges`, lowercased. `none` is a file whose length the guest could
   * not report — a `/proc` entry — which cannot be windowed at all.
   */
  acceptRanges?: string;
};

/**
 * A collection read the platform may have had to answer short.
 *
 * `incomplete` present means the list is short. The number is one of two
 * quantities and does not say which: the platform's own shortfall, counted out
 * of what the placement cache could account for and legitimately `0` because a
 * computer created during an outage was never cached against the host now
 * holding it; or, when the platform called the answer whole, how many rows this
 * client could not decode and dropped. Both leave the same array — one shorter
 * than the estate — which is what a caller acts on, so they share the channel.
 * Presence is the signal and the number is detail — hence `null` versus a
 * number, rather than a count that means nothing at zero.
 */
export type Listing<T> = {
  items: T[];
  /**
   * `null` when the answer was complete. A number — possibly 0 — when it was
   * not, being either the platform's shortfall or this client's dropped rows,
   * with no way to tell the two apart. Branch on presence, not on the number.
   */
  incomplete: number | null;
};

/**
 * The array check {@link Transport.jsonArray} and {@link Transport.listing} share.
 *
 * The array-ness is checked rather than cast. A caller that casts and then
 * calls `.map` on an object gets `data.map is not a function` — an anonymous
 * TypeError naming neither the request nor the platform, which is the failure
 * #decode exists to prevent one layer up. A missing body is an empty list,
 * since a list route with nothing to say and a list route that said nothing are
 * the same answer.
 */
function expectArray(data: unknown, method: string, path: string): unknown[] {
  if (data == null) return [];
  if (!Array.isArray(data)) {
    throw new MandalaError(
      `expected a JSON array from ${method} ${path}, got: ${JSON.stringify(data).slice(0, 200)}`,
    );
  }
  return data;
}

/** One server-sent event off a streaming route. */
export type SSEEvent = { event: string; data: unknown };

export type TransportOptions = {
  /** Defaults to `MANDALA_API_KEY`. */
  apiKey?: string;
  /** Defaults to `MANDALA_BASE_URL`, then the public API. */
  baseUrl?: string;
  /**
   * Per-request timeout in milliseconds. `0` disables it.
   *
   * Applied by composing an {@link AbortSignal}, so a caller's own `signal`
   * still cancels — whichever fires first wins.
   */
  timeoutMs?: number;
  /** Swap in a fetch implementation. Defaults to the global one. */
  fetch?: typeof globalThis.fetch;
};

/**
 * A response, carried with the deadline the request was made under.
 *
 * Kept together because consuming the body is the second half of the request
 * and runs under the same signal — see {@link Transport.#readBody}, which needs
 * the number to say what a mid-read abort actually was.
 */
type Sent = { resp: Response; timeoutMs: number };

/**
 * A message out of a parsed error body, from whichever hop wrote it.
 *
 * `error` is this platform's shape. `detail` and `title` are RFC 9457, which is
 * what Cloudflare answers a request carrying `Accept: application/json` — every
 * request from this client — for the 5xx statuses it generates itself: 500, 502,
 * 504 and the whole 520-526 range. Unrecognised, that body reached `err.message`
 * as 500 characters of raw JSON with the one readable sentence buried in it.
 *
 * Reading it is not the same as deferring to it — see `namedTheFailure`, which
 * still counts only `error`. On a status this SDK has wording for, its own
 * sentence says what a caller can do about it and Cloudflare's does not; this
 * matters for the statuses left over, where the alternative is the raw body.
 */
const messageFromBody = (body: unknown): string | undefined => {
  if (!body || typeof body !== 'object') return undefined;
  const said = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined);
  const b = body as { error?: unknown; detail?: unknown; title?: unknown };
  return said(b.error) ?? said(b.detail) ?? said(b.title);
};

/** The incomplete-header count, or 0 for anything that is not a number. */
const incompleteCount = (header: string): number => {
  const n = Number(header);
  return Number.isFinite(n) ? n : 0;
};

/**
 * How short an answer is, in {@link Listing.incomplete}'s spelling: `null` for
 * not short at all, and the count otherwise.
 *
 * Zero is the one number this cannot report, and deliberately — the platform
 * sends `0` for a shortfall it cannot size, so a `0` derived from counting
 * would claim a fan-out failure that never happened.
 */
const shortfall = (missing: number): number | null => (missing > 0 ? missing : null);

/**
 * A `Content-Range` on a response that carried bytes: `bytes 0-1048575/2147483648`.
 *
 * Refused rather than half-read when the positions do not describe a window —
 * this number is what a paging loop asks the next request from, so a start it
 * cannot trust is worse than no start at all. The total is treated more gently:
 * it is dropped when it contradicts the window, because losing "how much is
 * left" still leaves the caller with bytes they know the position of.
 */
export function parseContentRange(header: string | null): ContentRange | undefined {
  if (!header) return undefined;
  const m = /^\s*bytes\s+(\d+)\s*-\s*(\d+)\s*\/\s*(\d+|\*)\s*$/i.exec(header);
  if (!m) return undefined;
  const start = Number(m[1]);
  const end = Number(m[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return undefined;
  const total = m[3] === '*' ? Number.NaN : Number(m[3]);
  // `end` is inclusive, so a file of `total` bytes has no byte at `total`.
  return Number.isSafeInteger(total) && total > end ? { start, end, total } : { start, end };
}

/**
 * The file's length off an unsatisfied range's `Content-Range`, whose window is
 * a bare `*` and whose total is the number wanted.
 *
 * The whole point of a 416 — the caller asked a question about a file whose
 * size they did not know, and this is the one answer that lets them ask again
 * correctly instead of guessing. Read here rather than left for a caller to
 * regex out of a header they never see.
 */
export function unsatisfiedTotal(header: string | null): number | undefined {
  if (!header) return undefined;
  const m = /^\s*bytes\s*\*\s*\/\s*(\d+)\s*$/i.exec(header);
  if (!m) return undefined;
  const total = Number(m[1]);
  return Number.isSafeInteger(total) ? total : undefined;
}

/** A Retry-After header, in milliseconds from now. */
const retryAfterMs = (header: string | null): number | undefined => {
  if (!header) return undefined;
  const seconds = Number(header);
  const delay =
    Number.isFinite(seconds) && seconds >= 0
      ? seconds * 1_000
      : (() => {
          const at = Date.parse(header);
          if (!Number.isFinite(at)) return undefined;
          return Math.max(at - Date.now(), 0);
        })();
  // Node timers wrap a delay above MAX_TIMER_MS to 1ms. An unbounded
  // Retry-After would then become an immediate retry of a 429, which is the
  // opposite of what the header asked for.
  if (delay === undefined) return undefined;
  return Math.min(delay, MAX_TIMER_MS);
};

const env = (name: string): string | undefined =>
  // Guarded so the library imports cleanly in a browser or a worker, where
  // `process` does not exist and reading it is a ReferenceError rather than
  // undefined. Those runtimes have no environment to read a key from anyway,
  // so the answer there is "pass one".
  typeof process !== 'undefined' ? process.env?.[name] : undefined;

export class Transport {
  readonly baseUrl: string;
  readonly #headers: Record<string, string>;
  readonly #timeoutMs: number;
  readonly #fetch: typeof globalThis.fetch;

  constructor(opts: TransportOptions = {}) {
    const key = (opts.apiKey ?? env('MANDALA_API_KEY'))?.trim();
    if (!key) {
      throw new MandalaError(
        'No API key. Pass apiKey, or set MANDALA_API_KEY ' + '(create one at Settings → API keys).',
      );
    }
    // Empty environment variables are common in layered configuration and are
    // absence, not a URL. Let them continue down the documented fallback chain
    // instead of storing '' and throwing an anonymous Invalid URL on first use.
    const baseUrl = opts.baseUrl?.trim() || env('MANDALA_BASE_URL')?.trim() || DEFAULT_BASE_URL;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    try {
      // Named here rather than left for `new URL` on the first request: that
      // throw is a raw TypeError ("Invalid URL") that says nothing about
      // baseUrl, and the empty-string case above is the one we already recover.
      void new URL(this.baseUrl);
    } catch {
      throw new ValidationError(`baseUrl must be an absolute URL (got ${JSON.stringify(baseUrl)})`);
    }
    this.#headers = { Authorization: `Bearer ${key}`, Accept: 'application/json' };
    // Checked here for the reason #deadlineMs checks minTimeoutMs below — one
    // hazard with two doors into it, and only one of them was guarded. A NaN
    // (`timeoutMs: Number(unsetEnvVar)` is the usual spelling) reads as "no
    // timeout" there and silently removes the one guard against a request
    // hanging forever; a negative reaches the same place through Math.max; an
    // Infinity surfaces later as a baffling "could not reach <baseUrl>" out of
    // AbortSignal.timeout. 0 is the documented way to disable the deadline and
    // stays legal.
    const timeoutMs = opts.timeoutMs ?? 60_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_TIMER_MS) {
      throw new ValidationError(
        `timeoutMs must be a non-negative finite number no greater than ${MAX_TIMER_MS} (got ${timeoutMs})`,
      );
    }
    this.#timeoutMs = timeoutMs;
    // Bound to globalThis rather than passed bare: an unbound `fetch` throws
    // "Illegal invocation" in some runtimes.
    this.#fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  #url(path: string, query?: Query): string {
    const url = new URL(`${this.baseUrl}/${path.replace(/^\/+/, '')}`);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    return url.toString();
  }

  /** This request's deadline in milliseconds, or 0 for none. */
  #deadlineMs(opts: RequestOptions): number {
    if (opts.noTimeout || !this.#timeoutMs) return 0;
    const min = opts.minTimeoutMs ?? 0;
    // Refused rather than absorbed: a NaN — timeoutS: Number(unsetEnvVar) is
    // the usual spelling — poisons Math.max, reads as "no timeout" below, and
    // silently removes the one guard against a request hanging forever; an
    // Infinity surfaces later as a baffling "could not reach <baseUrl>" out
    // of AbortSignal.timeout. Both are caller mistakes, named as such here.
    if (!Number.isFinite(min) || min < 0 || min > MAX_TIMER_MS) {
      throw new ValidationError(
        `the timeout for this request must be between 0 and ${MAX_TIMER_MS}ms (got ${min})`,
      );
    }
    return Math.max(this.#timeoutMs, min);
  }

  /**
   * The caller's signal and this request's timeout, as one.
   *
   * `AbortSignal.any` rather than replacing the caller's: a request that both
   * has a deadline and belongs to a cancellable operation must honour both, and
   * whichever fires first is the one that matters.
   */
  #signal(caller: AbortSignal | undefined, timeoutMs: number): AbortSignal | undefined {
    if (!timeoutMs) return caller;
    const timeout = AbortSignal.timeout(timeoutMs);
    return caller ? AbortSignal.any([caller, timeout]) : timeout;
  }

  async #fetchRaw(method: string, path: string, opts: RequestOptions = {}): Promise<Sent> {
    const timeoutMs = this.#deadlineMs(opts);
    const headers: Record<string, string> = { ...this.#headers, ...opts.headers };
    let body: string | Uint8Array | ReadableStream<Uint8Array> | undefined;
    if (opts.raw !== undefined) {
      // The file upload's body IS the file. Content-Type is deliberately
      // octet-stream rather than guessed from the path: the platform writes the
      // bytes it is given and never looks, and a guess here would be a claim
      // about a file we did not read.
      headers['Content-Type'] = 'application/octet-stream';
      body = opts.raw;
    } else if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }

    let resp: Response;
    try {
      // Node's fetch (undici) refuses a ReadableStream body unless the request
      // is marked half-duplex: the stream is sent, then the response is read.
      // Without it every streamed upload — including `mandala scp file vm:/path`
      // — dies with "duplex option is required when sending a body" before a
      // byte leaves the machine. The test recorder consumes the stream itself
      // and never hits this check, so nothing below it is covered by a test and
      // it has to be right by construction.
      //
      // Set for every body whose size cannot be read off it, not for every body
      // that is a `ReadableStream` of this realm: those are different sets, and
      // the difference is the bodies this SDK deliberately accepts from another
      // realm. Asked as an instance test, a polyfilled or cross-realm stream —
      // or the Node `Readable` undici takes from an untyped caller — goes out
      // without the flag, and undici then either refuses it outright or, for a
      // shape it recognises as neither stream nor bytes, stringifies it to
      // `[object Object]` and frames THAT against the caller's Content-Length.
      // A measurable body must not have the flag: undici works its length out
      // itself, and a custom fetch that forwarded a duplex it never needed
      // would be a change in the request that is not the request.
      const init: RequestInit & { duplex?: 'half' } = {
        method,
        headers,
        // Cast because @types/node does not put Uint8Array in BodyInit even
        // though undici accepts it.
        body: body as RequestInit['body'],
        signal: this.#signal(opts.signal, timeoutMs),
        // Fetch follows redirects by default. A 301/302 on POST is converted
        // to GET with the body dropped, and Authorization is stripped on a
        // cross-origin hop — including `http://` → `https://`. The SDK then
        // sees only the final response, so a baseUrl missing its trailing path
        // — the case the poll predicate already treats as fatal — is followed
        // instead of reported. Manual so the 3xx reaches `!resp.ok`.
        // `redirect: 'error'` throws a TypeError and would hide the 301 as a
        // connection failure.
        redirect: 'manual',
      };
      if (opts.raw !== undefined && bodyByteLength(opts.raw) === undefined) init.duplex = 'half';
      resp = await this.#fetch(this.#url(path, opts.query), init);
    } catch (cause) {
      // A caller's own signal firing is a cancellation whatever its reason is
      // named. Judged first, so a custom reason — `ac.abort(new Error(...))` —
      // is not rewritten below into a claim that the platform was unreachable.
      if (opts.signal?.aborted) throw cause;
      // A timeout is reported as what it is. Left as the raw TimeoutError from
      // AbortSignal.timeout it says only "the operation was aborted", which is
      // indistinguishable from a caller cancelling on purpose.
      // The INTERRUPTED class, because a deadline that fires says nothing about
      // whether the request went out — and a timeout is the shape where it most
      // likely did and the platform is most likely still working on it. This
      // used to be a plain ConnectionError, so `isTransient` told an embedder a
      // timed-out create was safe to replay (OPL-3855).
      if (cause instanceof Error && cause.name === 'TimeoutError') {
        throw new ConnectionInterruptedError(
          `${method} ${path} timed out after ${timeoutMs}ms. It may have been received, so ` +
            'treat anything it would have changed as unknown rather than undone.',
          { cause },
        );
      }
      if (cause instanceof Error && cause.name === 'AbortError') throw cause;
      // Rewritten, because the raw message names a DNS or TLS failure and the
      // thing a caller can act on is "the platform is not reachable".
      //
      // Two classes, because a rejected fetch is two different outcomes wearing
      // one shape. A refused socket means nothing was dispatched and a create
      // may be replayed; a socket that died with the request already on the wire
      // means the platform may have acted and the answer was lost.
      const detail = cause instanceof Error ? cause.message : String(cause);
      if (neverDispatched(cause)) {
        throw new ConnectionError(`could not reach ${this.baseUrl}: ${detail}`, { cause });
      }
      throw new ConnectionInterruptedError(
        `${method} ${path} to ${this.baseUrl} failed after the request was sent: ${detail}. ` +
          'It may have been received, so treat anything it would have changed as unknown ' +
          'rather than undone.',
        { cause },
      );
    }
    if (!resp.ok) throw await this.#error(resp, method, path, timeoutMs, opts.signal);
    return { resp, timeoutMs };
  }

  /**
   * Read a response body, reporting a deadline that fired mid-read as one.
   *
   * The composed signal governs the body as well as the headers, so a download
   * whose bytes stop arriving is aborted here rather than at the fetch — long
   * after #fetchRaw's own translation has gone out of scope. Left raw, the
   * TimeoutError says only "the operation was aborted", which is exactly what a
   * caller cancelling on purpose says, and the two are worth telling apart on
   * the transfer routes most likely to hit a deadline in the first place.
   */
  async #readBody<T>(
    read: () => Promise<T>,
    method: string,
    path: string,
    sent: Sent,
    caller?: AbortSignal,
    /**
     * Whether a dead socket becomes a {@link ConnectionInterruptedError} here.
     *
     * True everywhere but `#error`, where the body being read is the body of a
     * response that ALREADY CARRIES A STATUS. A reset partway through that one
     * loses nothing worth reporting — the platform answered, and the answer is
     * the status — so wrapping it would throw away a `ConflictError` the caller
     * can act on and hand back a connection failure instead, which is both less
     * information and a different retry answer.
     *
     * The timeout below is not covered by this, deliberately. A deadline firing
     * is the caller's own budget running out rather than the platform's answer
     * being incomplete, and reporting that as an ordinary HTTP failure is what
     * the branch was added to stop.
     */
    wrapTransportFailure = true,
  ): Promise<T> {
    try {
      return await read();
    } catch (cause) {
      // A caller's own signal firing is a cancellation whatever its reason is
      // named, and is never rewritten — #fetchRaw's rule, for its reason.
      if (caller?.aborted) throw cause;
      // Always the post-dispatch class from here down. Getting into this method
      // means the response headers arrived, so the platform received the request
      // and acted on it; what was lost is the answer (OPL-3855).
      if (cause instanceof Error && cause.name === 'TimeoutError') {
        throw new ConnectionInterruptedError(
          `${method} ${path} timed out after ${sent.timeoutMs}ms while reading the response. ` +
            'The request was received, so treat anything it would have changed as unknown ' +
            'rather than undone.',
          { cause },
        );
      }
      // The case that used to fall straight through. A socket that dies
      // mid-body surfaces from fetch as `TypeError: terminated` — a name no
      // list of abort names will ever have — carrying a SocketError as its
      // cause, so it left this method as a bare TypeError: neither transient
      // nor pollable, and a wait loop died on a blip it existed to outlast.
      if (wrapTransportFailure && isTransportFailure(cause)) {
        throw new ConnectionInterruptedError(
          `could not finish reading ${method} ${path}: ${
            cause instanceof Error ? cause.message : String(cause)
          }. The request was received, so treat anything it would have changed as unknown ` +
            'rather than undone.',
          { cause },
        );
      }
      throw cause;
    }
  }

  /**
   * The platform's own message, when it sent one.
   *
   * Worth the trouble: these are written to be acted on — "send a new name or a
   * new size, not both", "this computer was built from a golden image that
   * predates window actions" — and replacing them with a status line throws
   * away the only part of the response anybody can do anything with.
   */
  async #error(
    resp: Response,
    method: string,
    path: string,
    timeoutMs: number,
    caller?: AbortSignal,
  ): Promise<APIError> {
    let body: unknown;
    let message = `HTTP ${resp.status}`;
    // Read through #readBody, not `.catch(() => '')`. The composed signal
    // governs this body like any other, so a caller cancelling here, or a
    // deadline firing here, used to be swallowed and answered with the status
    // instead — a caller that abandoned a request on purpose was told
    // `ConflictError`, which this SDK documents as the one worth retrying.
    // #fetchRaw's rule, applied to the one body that was outside it.
    const text = await this.#readBody(
      () => resp.text(),
      method,
      path,
      { resp, timeoutMs },
      caller,
      // A body that would not come says nothing the status does not. See the
      // parameter's own note: wrapping a reset here would replace a status the
      // platform actually sent with a connection failure (OPL-3855).
      false,
    ).catch((cause) => {
      // Anything else is a body that would not come, which says nothing the
      // status does not. Answer with the status, as before.
      if (caller?.aborted || cause instanceof ConnectionError) throw cause;
      return '';
    });
    if (text) {
      try {
        body = JSON.parse(text);
        message = messageFromBody(body) ?? text.slice(0, 500);
      } catch {
        message = text.slice(0, 500);
        // Kept whole, not just read. errorForStatus replaces the message on
        // every edge status with wording of its own, and this is the only copy
        // of what the edge actually said — a Cloudflare Ray ID lives in that
        // HTML and nowhere else, and it is the first thing support asks for.
        // Untruncated because the Ray ID sits in the page's footer, well past
        // the 500 characters the message is cut to. Shown to nobody; available
        // to whoever needs it.
        body = text;
      }
    }
    return errorForStatus(resp.status, message, body, {
      retryAfterMs: retryAfterMs(resp.headers.get('retry-after')),
      // Only ever set on a 416, which is the one status that answers with a
      // Content-Range naming the file rather than a window of it.
      rangeTotal: unsatisfiedTotal(resp.headers.get('content-range')),
    });
  }

  /**
   * A JSON body, or nothing, or a named failure.
   *
   * A captive portal or a misconfigured proxy answers 200 with an HTML page,
   * and the difference between `expected JSON from GET /computers, got:
   * <!DOCTYPE html…` and a bare `SyntaxError: Unexpected token '<'` is whether
   * the reader learns which request went wrong.
   */
  async #decode<T>(
    sent: Sent,
    method: string,
    path: string,
    caller?: AbortSignal,
  ): Promise<T | undefined> {
    if (sent.resp.status === 204) return undefined;
    const text = await this.#readBody(() => sent.resp.text(), method, path, sent, caller);
    if (!text) return undefined;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new MandalaError(`expected JSON from ${method} ${path}, got: ${text.slice(0, 200)}`);
    }
  }

  async json<T = unknown>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const sent = await this.#fetchRaw(method, path, opts);
    return (await this.#decode<T>(sent, method, path, opts.signal)) as T;
  }

  /** {@link json}, for the routes whose answer is a list. See {@link expectArray}. */
  async jsonArray(method: string, path: string, opts: RequestOptions = {}): Promise<unknown[]> {
    return expectArray(await this.json<unknown>(method, path, opts), method, path);
  }

  /**
   * A fan-out read, with whether the platform could answer it in full.
   *
   * `X-GC-Incomplete` is only a warning if something reads it, and every route
   * that can set it is one whose short answer is indistinguishable from an
   * empty account. Three of them — computers, snapshots and, since OPL-3840,
   * builds — and on the build listing the header is the whole of the evidence,
   * because nothing in its rows marks what is gone. It is the whole of the
   * evidence on the other two as well for a workspace-scoped key, which the
   * platform deliberately hands no stub rows.
   */
  async listing(
    path: string,
    opts: RequestOptions = {},
  ): Promise<Listing<Record<string, unknown>>> {
    const sent = await this.#fetchRaw('GET', path, opts);
    const short = sent.resp.headers.get(INCOMPLETE_HEADER);
    const data = await this.#decode<unknown>(sent, 'GET', path, opts.signal);
    // The same check and the same element filter {@link jsonArray}'s callers
    // get, because these are the list routes a user actually calls. Cast to
    // `T[]`, an object answer reached `items.map` as an anonymous TypeError,
    // and a single null element reached toSnapshot as `d.id` of null — both of
    // them naming neither the request nor the platform.
    const rows = expectArray(data, 'GET', path);
    const items = rows.filter(isRecord);
    return {
      items,
      // A header that is not a number came from something other than the
      // platform, and Number() turns it into a NaN that poisons the first sum a
      // caller does with it. Presence is the signal — see {@link Listing} — so
      // the warning survives as a count of 0 rather than as arithmetic nobody
      // can trace back to a header.
      //
      // And a row the filter above threw away leaves the answer exactly as
      // short as a row the platform could not fan out to, in the one shape the
      // caller acts on: an array diffed against their own idea of the estate,
      // with a delete on the difference. `X-GC-Incomplete` is a "this list is
      // short" channel rather than a "a host was unreachable" one — it replaced
      // a header that named hosts precisely so the count could stand for the
      // shortfall by itself — so a client-side drop belongs in it rather than
      // in a second signal nobody would read. Only when the platform has not
      // already flagged the answer: presence is what a caller tests, and adding
      // to a count the platform documents as best effort would make it no
      // truer.
      incomplete: short !== null ? incompleteCount(short) : shortfall(rows.length - items.length),
    };
  }

  /** For the routes whose body is not JSON: the screenshot and the file download. */
  async bytes(method: string, path: string, opts: RequestOptions = {}): Promise<Bytes> {
    const sent = await this.#fetchRaw(method, path, opts);
    const buffer = await this.#readBody(
      () => sent.resp.arrayBuffer(),
      method,
      path,
      sent,
      opts.signal,
    );
    const acceptRanges = sent.resp.headers.get('accept-ranges');
    return {
      bytes: new Uint8Array(buffer),
      contentType: sent.resp.headers.get('content-type') ?? 'application/octet-stream',
      filename: filenameFrom(sent.resp.headers.get('content-disposition')),
      status: sent.resp.status,
      contentRange: parseContentRange(sent.resp.headers.get('content-range')),
      acceptRanges: acceptRanges?.trim().toLowerCase() || undefined,
    };
  }

  /**
   * A route that answers with a stream of events rather than a result.
   *
   * Yielded rather than collected so a caller can report progress while the run
   * is going. An agent run is minutes of clicking; something that says nothing
   * until it is over cannot be told from a hang.
   *
   * The per-request deadline is deliberately not applied — a stream is meant to
   * stay open, and a 60-second deadline would cut every run short at the same
   * place. A caller's own `signal` is the only thing that stops one early.
   */
  async *sse(method: string, path: string, opts: RequestOptions = {}): AsyncGenerator<SSEEvent> {
    const { resp } = await this.#fetchRaw(method, path, {
      ...opts,
      headers: { ...opts.headers, Accept: 'text/event-stream' },
      noTimeout: true,
    });
    if (!resp.body) throw new MandalaError(`${method} ${path} answered with no body`);
    // The captive-portal case #decode names, on the one route that had no such
    // check. An HTML page contains no `data:` lines, so it parses to a stream of
    // no events and surfaces as "the agent stream ended without a result" — a
    // sentence about the platform, describing a proxy that answered instead of
    // it.
    const contentType = resp.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().includes('text/event-stream')) {
      const text = await resp.text().catch(() => '');
      throw new MandalaError(
        `expected an event stream from ${method} ${path}, got ` +
          `${contentType || 'no content type'}: ${text.slice(0, 200)}`,
      );
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    // A CRLF can arrive split across two network chunks. Whether the '\r' at a
    // chunk's end is a lone terminator or the front half of a CRLF, it
    // contributes exactly one '\n' — so it is normalised and framed NOW, which
    // keeps an event whose stream is CR-framed from arriving one chunk late.
    // What must not happen is the next chunk's leading '\n' then counting as a
    // second terminator: that would fabricate a frame boundary, splitting one
    // event in two and losing its type. So that one byte is swallowed instead.
    let swallowLf = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        // Normalised to LF before framing. The spec allows CRLF and lone CR as
        // line terminators, and a proxy that reframes the stream is entitled to
        // use them; splitting on "\n\n" alone would then never find a boundary,
        // collapse the whole run into one unparseable event, and lose the
        // result of a run that had in fact succeeded.
        let text = decoder.decode(value, { stream: true });
        // A partial multibyte character decodes to '' and must not clear the
        // pending swallow — the '\n' it protects against is still to come.
        if (!text) continue;
        if (swallowLf) {
          if (text.startsWith('\n')) text = text.slice(1);
          swallowLf = false;
        }
        if (text.endsWith('\r')) swallowLf = true;
        const add = text.replace(/\r\n?/g, '\n');
        // Refused BEFORE the concatenation, not after it — the cap exists to
        // stop this client holding an unbounded event, and checking it once the
        // string is built is the one moment it has already been held.
        //
        // Only when no boundary can come of the join, because the check below
        // must still be able to drain. `buffer` carries no `\n\n` at this point
        // — the loop under this one runs until `indexOf` fails — so when `add`
        // brings none either, and none straddles the seam, the combined length
        // is already final and nothing here is going to shorten it. A chunk
        // that DOES carry a boundary falls through and is framed as before,
        // however large it is.
        const boundary = add.includes('\n\n') || (buffer.endsWith('\n') && add.startsWith('\n'));
        if (!boundary && buffer.length + add.length > MAX_SSE_EVENT_CHARS) {
          throw new MandalaError(
            `event stream from ${method} ${path} exceeded ${MAX_SSE_EVENT_CHARS} characters without a boundary`,
          );
        }
        buffer += add;
        for (;;) {
          const sep = buffer.indexOf('\n\n');
          if (sep === -1) break;
          if (sep > MAX_SSE_EVENT_CHARS) {
            throw new MandalaError(
              `event stream from ${method} ${path} exceeded ${MAX_SSE_EVENT_CHARS} characters without a boundary`,
            );
          }
          const parsed = parseEvent(buffer.slice(0, sep));
          buffer = buffer.slice(sep + 2);
          if (parsed) yield parsed;
        }
        if (buffer.length > MAX_SSE_EVENT_CHARS) {
          throw new MandalaError(
            `event stream from ${method} ${path} exceeded ${MAX_SSE_EVENT_CHARS} characters without a boundary`,
          );
        }
      }
      // Flushed, not dropped. A stream that ends mid-character leaves the front
      // half of it inside the decoder, and every `{ stream: true }` decode above
      // holds those bytes back waiting for the rest. Without this the tail event
      // silently loses them and looks complete; with it they decode to U+FFFD,
      // which is a visible mark that something was cut off.
      buffer += decoder.decode();
      if (buffer.length > MAX_SSE_EVENT_CHARS) {
        throw new MandalaError(
          `event stream from ${method} ${path} exceeded ${MAX_SSE_EVENT_CHARS} characters without a boundary`,
        );
      }
      const tail = parseEvent(buffer);
      if (tail) yield tail;
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
}

/**
 * Every error under one, including the ones a fetch hides two levels down.
 *
 * A rejected fetch is a `TypeError: fetch failed` whose `cause` is what
 * actually went wrong, and on a dual-stack host that cause is an
 * `AggregateError` holding one attempt per address. Neither the top error nor
 * its immediate cause carries the code the classifiers below read, so both
 * links have to be followed. Bounded, because a cause chain is reachable from
 * a caller-supplied `fetch` and nothing here needs to survive a cycle.
 */
function* causes(err: unknown, depth = 0): Generator<Record<string, unknown>> {
  if (!err || typeof err !== 'object' || depth > 5) return;
  const e = err as Record<string, unknown>;
  yield e;
  yield* causes(e.cause, depth + 1);
  if (Array.isArray(e.errors)) {
    for (const inner of e.errors) yield* causes(inner, depth + 1);
  }
}

/**
 * TLS failures that can only happen before the handshake finishes.
 *
 * NAMED IN FULL, with no prefix test, and that is the correction worth
 * recording. This started as `ERR_SSL_` and `ERR_TLS_` prefixes, and NEITHER
 * prefix means "handshake". Node spells every OpenSSL reason `ERR_SSL_`,
 * including the fatal alerts a peer can send on any record — a TLS-terminating
 * proxy that dies mid-response answers `ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR`,
 * and a corrupted record answers `ERR_SSL_SSLV3_ALERT_BAD_RECORD_MAC`. Both
 * arrive with the request long since on the wire. `ERR_TLS_` is narrower and
 * still not safe: `ERR_TLS_RENEGOTIATION_DISABLED` is by definition
 * mid-connection. A prefix that admits those puts a possibly-dispatched failure
 * into the class that says nothing was sent, which is the one mistake this
 * whole function exists to avoid.
 *
 * So: an explicit set, holding certificate verification results (OpenSSL's,
 * which carry no prefix), the protocol mismatches that can only be diagnosed
 * from the first record, and the two Node codes that are genuinely handshake
 * events. Add to it when a new one turns up. A missing entry costs an embedder
 * one blind retry it could have made; a wrong entry costs a second billable
 * computer, so the set stays short on purpose.
 */
const TLS_CODES = new Set([
  // Certificate verification, from OpenSSL. All of these end the handshake.
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_REVOKED',
  'CERT_SIGNATURE_FAILURE',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'HOSTNAME_MISMATCH',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  // Node's own TLS layer, for the two events that are the handshake itself.
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_TLS_HANDSHAKE_TIMEOUT',
  // Protocol mismatches, diagnosable only from the first record on the wire.
  // `ERR_SSL_WRONG_VERSION_NUMBER` is what https onto a plaintext port gives.
  'ERR_SSL_NO_CIPHERS_AVAILABLE',
  'ERR_SSL_NO_PROTOCOLS_AVAILABLE',
  'ERR_SSL_NO_SHARED_CIPHER',
  'ERR_SSL_PACKET_LENGTH_TOO_LONG',
  'ERR_SSL_UNKNOWN_PROTOCOL',
  'ERR_SSL_UNSUPPORTED_PROTOCOL',
  'ERR_SSL_VERSION_TOO_LOW',
  'ERR_SSL_WRONG_VERSION_NUMBER',
]);

/** Errnos a live connection dies with, once the request is already on it. */
const SOCKET_ERRNOS = new Set(['ECONNRESET', 'ECONNABORTED', 'EPIPE', 'ENOTCONN', 'ETIMEDOUT']);

/**
 * Can this rejection be shown to have happened BEFORE the request was written?
 *
 * The one question that decides whether {@link ConnectionError} or
 * {@link ConnectionInterruptedError} comes out of the transport, and therefore
 * whether `isTransient` tells an embedder a create is safe to replay.
 *
 * FAIL CLOSED, which is the whole design. The two wrong answers do not cost the
 * same: calling a connect failure a possible dispatch costs one retry a caller
 * could have made blind, and calling a lost response a connect failure costs a
 * second billable computer. So this is an ALLOW-LIST of causes that can only
 * arise from the connector, and everything else — anything unrecognised, and
 * anything at all out of a caller-supplied `fetch` — is possibly dispatched.
 *
 * The discriminator is the syscall, not the errno, and that distinction earns
 * its place. `ECONNRESET` alone is ambiguous: it is what a TLS handshake
 * against a non-TLS port produces (`syscall: 'read'`, connect phase) and also
 * what a peer resetting a live connection produces (post-dispatch). `connect`
 * and `getaddrinfo`, by contrast, happen once and only before the request
 * exists. undici's own post-dispatch failures are unmistakable in the other
 * direction — `SocketError`/`UND_ERR_SOCKET`, `HTTPParserError`, the timeout
 * classes — and none of them match anything here.
 *
 * The allow-list is matched in full rather than by prefix, for the reason
 * {@link TLS_CODES} sets out: the obvious prefixes admit failures that happen
 * after the handshake, and one of those in this branch is exactly the bug this
 * function was written to prevent.
 *
 * Measured against undici on Node 26, 2026-08-27: refused → `ECONNREFUSED` with
 * `syscall: 'connect'`; DNS → `ENOTFOUND` with `syscall: 'getaddrinfo'`;
 * dual-stack refusal → the same, inside an `AggregateError`; unroutable →
 * `UND_ERR_CONNECT_TIMEOUT`; TLS against a plaintext port →
 * `ERR_SSL_WRONG_VERSION_NUMBER`. Post-dispatch: a socket closed after the
 * request → `UND_ERR_SOCKET`, a garbage response → `HPE_INVALID_CONSTANT`, no
 * response → `UND_ERR_HEADERS_TIMEOUT`.
 */
function neverDispatched(err: unknown): boolean {
  for (const cause of causes(err)) {
    const code = typeof cause.code === 'string' ? cause.code : '';
    const syscall = cause.syscall;
    if (syscall === 'connect' || syscall === 'getaddrinfo' || syscall === 'lookup') return true;
    if (code === 'UND_ERR_CONNECT_TIMEOUT') return true;
    if (TLS_CODES.has(code)) return true;
  }
  return false;
}

/**
 * A transport failure while reading a body, as opposed to a bug in this file.
 *
 * Only asked from `#readBody`, so the phase is not in question — the response
 * headers already arrived. What is in question is whether the throw came from
 * the connection or from us: this SDK raises {@link MandalaError} for a body
 * that arrived and made no sense, and wrapping one of those as a connection
 * failure would send a poll loop round again on a defect.
 */
function isTransportFailure(cause: unknown): boolean {
  for (const inner of causes(cause)) {
    const code = typeof inner.code === 'string' ? inner.code : '';
    if (code.startsWith('UND_ERR_')) return true;
    if (SOCKET_ERRNOS.has(code)) return true;
  }
  return false;
}

function parseEvent(chunk: string): SSEEvent | undefined {
  let event = 'message';
  const data: string[] = [];
  for (const line of chunk.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  if (!data.length) return undefined;
  const joined = data.join('\n');
  try {
    return { event, data: JSON.parse(joined) };
  } catch {
    return { event, data: joined };
  }
}

/** The filename the platform put on a download, if it put one there. */
export function filenameFrom(disposition: string | null): string | undefined {
  if (!disposition) return undefined;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  if (star?.[1]) {
    // A stray `%` in a guest filename is legal on disk and makes this throw.
    // Letting it out would turn a download whose bytes already arrived intact
    // into a failure, over the label on it.
    try {
      return decodeURIComponent(star[1]);
    } catch {
      return star[1];
    }
  }
  // The quoted form first, matched to its closing quote: a semicolon is legal
  // inside a quoted filename, and a character class that stopped at one would
  // hand back half the name. A well-formed empty name is no name — reported as
  // undefined rather than falling through to re-read its own quote marks.
  const quoted = /filename="([^"]*)"/i.exec(disposition);
  if (quoted) return quoted[1] || undefined;
  // Unquoted, or a quoted form left unterminated. The optional leading quote
  // is consumed and quotes are excluded from the name, so a malformed
  // 'filename="abc' comes back as the bare name rather than '"abc'.
  const plain = /filename="?([^";\s]+)/i.exec(disposition);
  return plain?.[1];
}
