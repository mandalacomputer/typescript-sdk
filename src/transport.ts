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

export type Query = Record<string, string | number | boolean | undefined>;

export type RequestOptions = {
  query?: Query;
  body?: unknown;
  /** Raw bytes as the request body, for the file upload. Exclusive with `body`. */
  raw?: Uint8Array;
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

/** A non-JSON response body, with what the platform said it was. */
export type Bytes = {
  bytes: Uint8Array;
  contentType: string;
  /** From Content-Disposition, when the platform named the file. */
  filename?: string;
};

/**
 * A collection read the platform may have had to answer short.
 *
 * `incomplete` is the count of what the placement cache could account for, and
 * it is legitimately `0`: a computer created during an outage was never cached
 * against the host now holding it. So presence is the signal and the number is
 * detail — hence `null` versus a number, rather than a count that means nothing
 * at zero.
 */
export type Listing<T> = {
  items: T[];
  /** `null` when the answer was complete. A number — possibly 0 — when it was not. */
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

/** The incomplete-header count, or 0 for anything that is not a number. */
const incompleteCount = (header: string): number => {
  const n = Number(header);
  return Number.isFinite(n) ? n : 0;
};

/** A Retry-After header, in milliseconds from now. */
const retryAfterMs = (header: string | null): number | undefined => {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const at = Date.parse(header);
  if (!Number.isFinite(at)) return undefined;
  return Math.max(at - Date.now(), 0);
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
    const key = opts.apiKey ?? env('MANDALA_API_KEY');
    if (!key) {
      throw new MandalaError(
        'No API key. Pass apiKey, or set MANDALA_API_KEY ' + '(create one at Settings → API keys).',
      );
    }
    this.baseUrl = (opts.baseUrl ?? env('MANDALA_BASE_URL') ?? DEFAULT_BASE_URL).replace(
      /\/+$/,
      '',
    );
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
    let body: string | Uint8Array | undefined;
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
      resp = await this.#fetch(this.#url(path, opts.query), {
        method,
        headers,
        // Cast because @types/node does not put Uint8Array in BodyInit even
        // though undici accepts it.
        body: body as RequestInit['body'],
        signal: this.#signal(opts.signal, timeoutMs),
      });
    } catch (cause) {
      // A caller's own signal firing is a cancellation whatever its reason is
      // named. Judged first, so a custom reason — `ac.abort(new Error(...))` —
      // is not rewritten below into a claim that the platform was unreachable.
      if (opts.signal?.aborted) throw cause;
      // A timeout is reported as what it is. Left as the raw TimeoutError from
      // AbortSignal.timeout it says only "the operation was aborted", which is
      // indistinguishable from a caller cancelling on purpose.
      if (cause instanceof Error && cause.name === 'TimeoutError') {
        throw new ConnectionError(`${method} ${path} timed out after ${timeoutMs}ms`);
      }
      if (cause instanceof Error && cause.name === 'AbortError') throw cause;
      // Rewritten, because the raw message names a DNS or TLS failure and the
      // thing a caller can act on is "the platform is not reachable".
      throw new ConnectionError(
        `could not reach ${this.baseUrl}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    if (!resp.ok) throw await this.#error(resp);
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
  ): Promise<T> {
    try {
      return await read();
    } catch (cause) {
      // A caller's own signal firing is a cancellation whatever its reason is
      // named, and is never rewritten — #fetchRaw's rule, for its reason.
      if (caller?.aborted) throw cause;
      if (cause instanceof Error && cause.name === 'TimeoutError') {
        throw new ConnectionError(`${method} ${path} timed out after ${sent.timeoutMs}ms`);
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
  async #error(resp: Response): Promise<APIError> {
    let body: unknown;
    let message = `HTTP ${resp.status}`;
    const text = await resp.text().catch(() => '');
    if (text) {
      try {
        body = JSON.parse(text);
        const err = (body as { error?: unknown })?.error;
        message = typeof err === 'string' && err ? err : text.slice(0, 500);
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
    return errorForStatus(
      resp.status,
      message,
      body,
      retryAfterMs(resp.headers.get('retry-after')),
    );
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
   * `X-GC-Incomplete` is only a warning if something reads it, and the two
   * routes that can set it are the two whose short answer is indistinguishable
   * from an empty account.
   */
  async listing(
    path: string,
    opts: RequestOptions = {},
  ): Promise<Listing<Record<string, unknown>>> {
    const sent = await this.#fetchRaw('GET', path, opts);
    const short = sent.resp.headers.get(INCOMPLETE_HEADER);
    const data = await this.#decode<unknown>(sent, 'GET', path, opts.signal);
    return {
      // The same check and the same element filter {@link jsonArray}'s callers
      // get, because these are the two list routes a user actually calls. Cast
      // to `T[]`, an object answer reached `items.map` as an anonymous
      // TypeError, and a single null element reached toSnapshot as `d.id` of
      // null — both of them naming neither the request nor the platform.
      items: expectArray(data, 'GET', path).filter(isRecord),
      // A header that is not a number came from something other than the
      // platform, and Number() turns it into a NaN that poisons the first sum a
      // caller does with it. Presence is the signal — see {@link Listing} — so
      // the warning survives as a count of 0 rather than as arithmetic nobody
      // can trace back to a header.
      incomplete: short === null ? null : incompleteCount(short),
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
    return {
      bytes: new Uint8Array(buffer),
      contentType: sent.resp.headers.get('content-type') ?? 'application/octet-stream',
      filename: filenameFrom(sent.resp.headers.get('content-disposition')),
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
        buffer += text.replace(/\r\n?/g, '\n');
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
