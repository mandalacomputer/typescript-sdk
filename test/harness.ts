/**
 * A fetch stand-in that records what the SDK asked for.
 *
 * Injected through `new Client({ fetch })` rather than by patching the global,
 * so tests cannot leak into each other and a suite run in parallel stays
 * honest.
 */

import type { Client } from '../src/index.js';

export const BASE = 'https://api.test/api/v1';

export type Call = {
  method: string;
  /** Path below the base URL, without the query. */
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
  /** The raw request body, for the routes that send bytes. */
  raw?: Uint8Array;
};

export type Responder = (call: Call) => Response | Promise<Response>;

export type Recorder = {
  fetch: typeof globalThis.fetch;
  calls: Call[];
  /** Method + path pairs, for asserting on the shape of a sequence. */
  routes: () => [string, string][];
  last: () => Call;
};

export function recorder(respond: Responder): Recorder {
  const calls: Call[] = [];
  const fetchImpl = async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(String(input));
    const rawBody = init?.body;
    let body: unknown;
    let raw: Uint8Array | undefined;
    if (typeof rawBody === 'string') {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = rawBody;
      }
    } else if (rawBody instanceof Uint8Array) {
      raw = rawBody;
    } else if (typeof ReadableStream !== 'undefined' && rawBody instanceof ReadableStream) {
      raw = new Uint8Array(await new Response(rawBody).arrayBuffer());
    }
    const call: Call = {
      method: init?.method ?? 'GET',
      path: url.pathname.replace('/api/v1', '') || '/',
      query: Object.fromEntries(url.searchParams),
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body,
      raw,
    };
    calls.push(call);
    // The signal is honoured, because a mock that ignores it cannot model the
    // two things most worth testing about one: a timeout, and a caller
    // cancelling mid-flight. Raced rather than checked up front, so a responder
    // that takes its time is interruptible.
    const signal = init?.signal;
    if (signal?.aborted) throw signal.reason;
    const answer = respond(call);
    if (!signal) return answer;
    return Promise.race([
      answer,
      new Promise<Response>((_, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      ),
    ]);
  };
  return {
    fetch: fetchImpl as typeof globalThis.fetch,
    calls,
    routes: () => calls.map((c) => [c.method, c.path.replace(/^\//, '')] as [string, string]),
    last: () => calls[calls.length - 1]!,
  };
}

export const json = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });

export const bytes = (data: string, contentType = 'image/png'): Response =>
  new Response(new TextEncoder().encode(data), {
    status: 200,
    headers: { 'content-type': contentType },
  });

/**
 * The download route, with the platform's own range rules.
 *
 * Modelled rather than stubbed because the rules are the thing under test: a
 * window past the ceiling is trimmed rather than refused, which end gets
 * trimmed follows the end the caller anchored, an empty file refuses every
 * range, and a file whose length the guest cannot report ignores them. A
 * responder that simply handed back slices would agree with a paging loop that
 * had all four of those wrong.
 *
 * Mirrors `resolve` and `openGuestRead` in the platform's `server/guestfile.go`.
 */
export function guestFile(
  contents: Uint8Array,
  opts: { max?: number; measurable?: boolean } = {},
): Responder {
  const max = opts.max ?? 64 << 20;
  const measurable = opts.measurable ?? true;
  const size = contents.length;
  const whole = (acceptRanges: string): Response =>
    new Response(contents, {
      status: 200,
      headers: {
        'content-type': 'application/octet-stream',
        'accept-ranges': acceptRanges,
      },
    });
  const unsatisfiable = (): Response =>
    new Response(
      JSON.stringify({ error: `that range is outside the file, which is ${size} bytes` }),
      {
        status: 416,
        headers: {
          'content-type': 'application/json',
          'accept-ranges': 'bytes',
          'content-range': `bytes */${size}`,
        },
      },
    );

  return (call) => {
    if (!call.path.endsWith('/files')) return anyRoute(call);
    if (call.method !== 'GET') return json({ bytes: 0 });
    const header = call.headers.Range;
    // A file the seek could not measure has no positions to name, so the range
    // is ignored and the whole thing goes with a 200 — the status is how a
    // caller tells. Same for an empty file, which is the same case: its length
    // was never established up front.
    if (!measurable) return whole('none');
    if (!header) {
      return size > max
        ? errorJson(413, `that file is ${size} bytes; this endpoint moves at most ${max}`, {
            'accept-ranges': 'bytes',
          })
        : whole('bytes');
    }
    if (size === 0) return unsatisfiable();
    const m = /^bytes=(\d*)-(\d*)$/.exec(header);
    if (!m) return errorJson(400, `Range: ${header} is not a byte range this endpoint can read`);
    let off: number;
    let n: number;
    if (m[1] === '') {
      // A suffix is anchored at its END, so an over-long one is trimmed at the
      // near end — a tail longer than one request moves is still the tail.
      const want = Number(m[2]);
      if (want === 0) return unsatisfiable();
      off = Math.max(0, size - want);
      if (size - off > max) off = size - max;
      n = size - off;
    } else {
      off = Number(m[1]);
      if (off >= size) return unsatisfiable();
      const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
      n = Math.min(end - off + 1, max);
    }
    return new Response(contents.slice(off, off + n), {
      status: 206,
      headers: {
        'content-type': 'application/octet-stream',
        'accept-ranges': 'bytes',
        'content-range': `bytes ${off}-${off + n - 1}/${size}`,
      },
    });
  };
}

export const errorJson = (
  status: number,
  error: string,
  headers: ResponseInit['headers'] = {},
): Response =>
  new Response(JSON.stringify({ error }), {
    status,
    headers: { 'content-type': 'application/json', ...Object.fromEntries(new Headers(headers)) },
  });

/**
 * What Cloudflare answers `Accept: application/json` with, in its own shape.
 *
 * RFC 9457, which it sends for the 5xx it generates itself — 500, 502, 504 and
 * 520-526. Note there is no `error` field: this is the body the platform's own
 * shape does not describe.
 */
export const cloudflareJson = (status: number): Response =>
  new Response(
    JSON.stringify({
      type: 'https://developers.cloudflare.com/support/troubleshooting/http-status-codes/',
      title: 'Bad gateway',
      status,
      detail: 'The origin server returned an invalid response.',
      error_code: status,
      error_name: 'bad_gateway',
      ray_id: '8f2a1c0d9e4b7a31',
      retryable: true,
      what_you_should_do: 'Wait a few minutes and try again.',
    }),
    { status, headers: { 'content-type': 'application/json' } },
  );

/**
 * One window, in the shape the platform sends.
 *
 * In full, and `visible` is the daemon's own name for the property as well as
 * the one it sends. There is no `minimized` on this wire and there never was
 * (server/windows.go, OPL-3583), so a fixture carrying one would let a decoder
 * that reads it pass.
 *
 * `pid` is here for the same reason it is on the wire: it is sent on real
 * windows, and a fixture that omitted it would let a decoder reading nothing
 * at all pass the field's own test.
 */
export const WINDOW = {
  id: '0x2a0002c',
  title: 'Example Domain — Mozilla Firefox',
  class: 'firefox-esr',
  type: 'normal',
  pid: 1090,
  x: 0,
  y: 51,
  width: 1280,
  height: 749,
  focused: true,
  visible: true,
};

export const COMPUTER = {
  id: 'vm-1',
  name: 'demo',
  status: 'running',
  os: 'linux',
  template: 'base',
  cpu: 2,
  ram_mb: 4096,
  disk_gb: 40,
  resolution: '1280x800x24',
  created_at: '2026-08-19T00:00:00Z',
  vnc: {
    url: 'wss://host/vnc?token=t',
    view_url: 'wss://host/vnc?token=v',
    token: 't',
    view_token: 'v',
    embed_url: 'https://host/embed#v',
    terminal_url: 'wss://host/terminal?token=t',
    events_url: 'wss://host/events?token=t',
  },
};

/**
 * The opening frame of an event stream, as the platform writes it.
 *
 * `ready: true` and a `windows` array, because those are the two answers a
 * connection with no continuity carries and the two a stub that omitted them
 * would let a decoder pass without ever reading.
 */
export const EVENTS_HELLO = {
  type: 'hello',
  computer: 'vm-1',
  cursor: 'ep-1:0',
  ready: true,
  events: [
    'window.opened',
    'window.closed',
    'window.focused',
    'window.blurred',
    'clipboard.changed',
    'process.exited',
    'computer.ready',
    'computer.idle',
    'computer.started',
    'computer.stopped',
    'computer.suspended',
  ],
  windows: [],
};

/**
 * A websocket stand-in the test drives by hand.
 *
 * Structural, like {@link EventSocket} itself, so nothing here imports a
 * websocket implementation and a test can produce a socket that behaves in ways
 * a real one would not — a handshake that never completes, a close before the
 * opening frame, a frame that is not JSON.
 *
 * Nothing is ever sent TO an event stream, so there is no send half. What is
 * recorded instead is the URL, which is where the cursor rides.
 */
export class FakeSocket {
  closed = false;
  readonly #open: (() => void)[] = [];
  readonly #message: ((ev: { data: unknown }) => void)[] = [];
  readonly #error: (() => void)[] = [];
  readonly #close: (() => void)[] = [];

  constructor(readonly url: string) {}

  addEventListener(type: 'open', fn: () => void): void;
  addEventListener(type: 'message', fn: (ev: { data: unknown }) => void): void;
  addEventListener(type: 'error', fn: () => void): void;
  addEventListener(type: 'close', fn: () => void): void;
  addEventListener(type: string, fn: (ev: { data: unknown }) => void): void {
    if (type === 'message') this.#message.push(fn);
    else if (type === 'open') this.#open.push(fn as unknown as () => void);
    else if (type === 'error') this.#error.push(fn as unknown as () => void);
    else if (type === 'close') this.#close.push(fn as unknown as () => void);
  }

  close(): void {
    this.emitClose();
  }

  emitOpen(): void {
    for (const fn of [...this.#open]) fn();
  }

  /** One text frame. An object is serialised; a string goes as it is. */
  send(frame: unknown): void {
    const data = typeof frame === 'string' ? frame : JSON.stringify(frame);
    this.sendRaw(data);
  }

  /** One frame verbatim, including the binary shapes this stream drops. */
  sendRaw(data: unknown): void {
    // A closed socket delivers nothing, which is the property a test of the
    // queue bound depends on: the stream closes the socket to stop the flow,
    // and a stub that went on delivering afterwards would prove nothing.
    if (this.closed) return;
    for (const fn of [...this.#message]) fn({ data });
  }

  emitError(): void {
    for (const fn of [...this.#error]) fn();
  }

  emitClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const fn of [...this.#close]) fn();
  }
}

/**
 * A socket factory that hands each connection to `drive`, numbered from zero.
 *
 * Driven on a microtask rather than during construction, because the stream
 * registers its listeners after the factory returns — a socket that opened
 * synchronously would fire into nothing, which is a property of this stub
 * rather than of anything a real websocket does.
 */
export function socketFactory(
  drive: (socket: FakeSocket, connection: number) => void,
): (url: string) => FakeSocket {
  let n = 0;
  return (url: string) => {
    const socket = new FakeSocket(url);
    const which = n++;
    queueMicrotask(() => drive(socket, which));
    return socket;
  };
}

/**
 * One snapshot as the platform sends it, in full.
 *
 * In full deliberately: the shape a snapshot comes back as is what a clone of
 * it will be, and a fixture carrying only the fields the SDK happened to decode
 * first is a fixture that cannot fail when a field stops being decoded.
 */
export const SNAPSHOT = {
  id: 'snap-1',
  computer_id: 'vm-1',
  computer_name: 'scratch',
  name: 'nightly',
  kind: 'disk',
  state: 'durable',
  size_bytes: 1_000_000,
  created_at: '2026-08-19T00:00:00Z',
  incremental: true,
  auto: true,
  os: 'linux',
  template: 'base',
  cpu: 2,
  ram_mb: 4096,
  disk_gb: 40,
  resolution: '1920x1080x24',
};

export const EXEC_OK = { exit_code: 0, stdout: '', stderr: '', timed_out: false };

/** What a background start answers with: a pid, and nothing having exited. */
export const EXEC_STARTED = { pid: 4242, running: true, stdout: '', stderr: '' };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * A responder that answers every route with something of the right shape.
 *
 * Shared by the surface tests, which care where a request went rather than what
 * came back. Collections list on GET and return a single object on POST —
 * getting that backwards is what made the first version of this fail.
 */
export const MOVE_STARTED = {
  computer_id: 'vm-1',
  state: 'moving',
  detail: '',
  live: true,
  cpu: 2,
  ram_mb: 26000,
  started_at: '2026-08-23T02:00:12.699Z',
};
export const MOVE_DONE = {
  ...MOVE_STARTED,
  state: 'done',
  live: false,
  finished_at: '2026-08-23T02:00:17.336Z',
};

/**
 * One usage report, in the platform's own spelling.
 *
 * With `computers` present and both shortfall flags false — the shape of a
 * complete answer, which is what the routes test needs. The withheld breakdown
 * and the two caveats are usage.test.ts's subject and are built there.
 */
export const USAGE = {
  period: {
    start: '2026-08-04T00:00:00.000Z',
    end: '2026-09-04T00:00:00.000Z',
    source: 'subscription',
  },
  from: '2026-08-04T00:00:00.000Z',
  to: '2026-08-22T12:00:00.000Z',
  usage: {
    run_hours: 12.5,
    vcpu_hours: 25,
    ram_gb_hours: 50,
    snapshot_gb_hours: 96,
    snapshot_gb_months: 0.13,
    disk_gb_hours: 480,
    disk_gb_months: 0.66,
    computers: [{ id: 'vm-1', name: 'scratch', run_hours: 12.5, vcpu_hours: 25, ram_gb_hours: 50 }],
  },
  degraded: false,
  unmetered: false,
  reported_through: '2026-08-20',
};

/**
 * One published template, in the platform's own spelling (platform OPL-3789).
 *
 * `document` as an OBJECT, not the canonical string the store keeps: the
 * platform parses it back on the way out so a caller reading a template gets
 * JSON it can address. A fixture holding the string would let a decoder that
 * forgot to expect an object pass.
 */
export const PUBLISHED_TEMPLATE = {
  ref: 'acc-1/devbox@1.0.0',
  doc_digest: 'sha256:aaaa',
  document: { apiVersion: 'mandala/v1', kind: 'Template' },
  template: {
    name: 'devbox',
    ref: 'acc-1/devbox@1.0.0',
    label: 'My desktop',
    os: 'linux',
    cpu: 2,
    ram_mb: 4096,
    disk_gb: 30,
  },
  versions: ['1.0.0'],
  published_at: '2026-08-26T12:00:00.000Z',
};

/** What a retire took away (platform OPL-3830). */
export const RETIRED_TEMPLATES = {
  retired: ['acc-1/devbox@1.0.0'],
  retired_at: '2026-08-26T13:00:00.000Z',
  versions: [],
  templates: 0,
  // Deliberately not 0 while `templates` is: a retired ref still counts, and a
  // fixture where the two agreed would let a decoder that read one field for
  // both pass.
  refs_claimed: 1,
};

/**
 * A valid document, as the validator reports one.
 *
 * All six keys a valid answer carries, and the SDK read four of them until
 * OPL-4195. `template` and `canonical` are sent on every valid document
 * (`server/templateschema.go`), so a fixture that omitted them was the same
 * trap the window fixture was: it asserted the reading that produced the gap.
 *
 * This document names no parent, so it gets `build_digest`. The `build_digest_needs`
 * half of the daemon's if/else is exercised by {@link TEMPLATE_CHECK_LAYERED}
 * rather than here, because the two are never both present.
 */
export const TEMPLATE_CHECK = {
  valid: true,
  ref: 'acc-1/devbox@1.0.0',
  doc_digest: 'sha256:aaaa',
  build_digest: 'sha256:bbbb',
  template: { namespace: 'acc-1', name: 'devbox', version: '1.0.0', family: 'debian-13' },
  canonical: '{"apiVersion":"mandala/v1","kind":"Template"}',
};

/**
 * The same answer for a document that names a parent in `spec.from`.
 *
 * `build_digest_needs` REPLACES `build_digest` here — the daemon is an if/else,
 * not two fields — and the text is the platform's own, which is the whole reason
 * the field is worth decoding: it names what could not be computed and where to
 * compute it.
 */
export const TEMPLATE_CHECK_LAYERED = {
  valid: true,
  ref: 'acc-1/layered@1.0.0',
  doc_digest: 'sha256:cccc',
  build_digest_needs:
    "the contents of acme/base's image, which only a host holding it can supply. " +
    "Run `gorillad -build-template <file> -dry-run` there to see this document's build digest",
  template: { namespace: 'acc-1', name: 'layered', version: '1.0.0', family: 'debian-13' },
  canonical: '{"apiVersion":"mandala/v1","kind":"Template"}',
};

/** One build job (platform OPL-3791). */
export const TEMPLATE_BUILD = {
  id: 'bld-1',
  ref: 'acc-1/devbox@1.0.0',
  status: 'running',
  started_at: '2026-08-26T12:00:00.000Z',
};

/** Where a build has got to (platform OPL-3794). */
export const BUILD_PROGRESS = {
  id: 'bld-1',
  status: 'succeeded',
  done: true,
  phase: 'published',
  step: 2,
  of: 2,
  steps: [
    { n: 1, kind: 'apt', label: 'ripgrep', status: 'done' },
    { n: 2, kind: 'finish', label: 'cleanup', status: 'done' },
  ],
  note: '',
  error: '',
  updated_at: '2026-08-26T12:15:00.000Z',
};

/** The build event stream, as `text/event-stream`. */
export const buildEvents = (): Response =>
  new Response(
    `event: progress\ndata: ${JSON.stringify({ ...BUILD_PROGRESS, done: false, status: 'running' })}\n\n` +
      `event: done\ndata: ${JSON.stringify(BUILD_PROGRESS)}\n\n`,
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );

/** What an agent run answers with, streamed or not. */
export const AGENT_RESULT = { steps: 1, stop: 'end_turn', text: 'done' };

/**
 * The agent run as a stream of frames, in the platform's own event spelling.
 *
 * A `done` frame carrying a result, because that is what ends a run: without
 * one `agent()` consumes the whole stream and throws "the agent stream ended
 * without a result", which is a fixture failure wearing the costume of a
 * platform one.
 */
export const agentEvents = (): Response =>
  new Response(
    `event: step\ndata: ${JSON.stringify({ n: 1, detail: 'clicked' })}\n\n` +
      `event: done\ndata: ${JSON.stringify(AGENT_RESULT)}\n\n`,
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );

export const anyRoute: Responder = (call) => {
  const { path, method } = call;
  const get = method === 'GET';
  if (path.endsWith('/screenshot')) return bytes('png');
  if (path.endsWith('/files')) return get ? bytes('file', 'text/plain') : json({ bytes: 5 });
  // A background exec answers with a handle, not a result. Told apart by the
  // request rather than answered with one shape for both, because a mock that
  // hands a background start an EXEC_OK is a mock claiming a platform that
  // never sends a pid — which is exactly the payload the decoder now refuses.
  if (path.endsWith('/exec')) {
    return json(isRecord(call.body) && call.body.background ? EXEC_STARTED : EXEC_OK);
  }
  if (/\/exec\/\d+$/.test(path)) return json({ pid: 42, running: false, exit_code: 0 });
  // Both verbs on one path, told apart by the method: the read answers text and
  // the write answers an ack, and a mock that gave both the same shape would let
  // a decoder that reads the wrong field pass.
  if (path.endsWith('/clipboard')) return json(get ? { text: 'on the clipboard' } : { ok: true });
  // Both window routes answer a NAMED OBJECT, verified against
  // app.mandala.computer rather than read off the reference: the listing is
  // `{"windows":[...]}` and answers `{"windows":[]}` for an empty desktop, and
  // an action is `{"ok":true,"gone":false,"window":{...}}` — with `window`
  // NULL and `gone` true after a close. Both were a bare array and a bare
  // window here, which is what the code expected, so the fixture asserted the
  // bug instead of catching it and neither method had ever worked (OPL-4176).
  if (path.endsWith('/windows')) return json({ windows: [WINDOW] });
  if (/\/windows\/[^/]+$/.test(path)) return json({ ok: true, gone: false, window: WINDOW });
  if (path.endsWith('/schedule')) return json({ enabled: true, hour: 4, minute: 0, tz: 'UTC' });
  // Told apart by the request, like the exec above: `stream: true` is a
  // different response MEDIUM, not a different payload, and a mock that
  // answered JSON to both would fail every streaming call on its content type
  // rather than exercising it.
  if (path.endsWith('/agent')) {
    return isRecord(call.body) && call.body.stream === true ? agentEvents() : json(AGENT_RESULT);
  }
  if (path === '/templates' || path === '/sizes') return json(get ? [] : PUBLISHED_TEMPLATE);
  if (path === '/templates/schema') return json({ $id: 'https://x/templates/schema' });
  if (path === '/templates/validate') return json(TEMPLATE_CHECK);
  // The store's ref route, which is three segments and is therefore NOT
  // '/templates'. DELETE and GET answer different shapes, which is the point:
  // a retire has no document left to hand back.
  if (/^\/templates\/[^/]+\/[^/]+$/.test(path)) {
    return json(method === 'DELETE' ? RETIRED_TEMPLATES : PUBLISHED_TEMPLATE);
  }
  if (path.endsWith('/builds/bld-1/events')) return buildEvents();
  if (path.endsWith('/progress')) return json(BUILD_PROGRESS);
  if (path === '/builds')
    return json(get ? [TEMPLATE_BUILD] : TEMPLATE_BUILD, get ? {} : { status: 202 });
  if (/^\/builds\/[^/]+$/.test(path)) return json(TEMPLATE_BUILD);
  if (path.endsWith('/snapshots')) {
    // GET computers/:id/snapshots is the holdings triple, not a listing.
    if (get && path !== '/snapshots') return json({ count: 0, size_bytes: 0, fingerprint: 'f' });
    return json(get ? [SNAPSHOT] : SNAPSHOT);
  }
  // The two halves of a move answer different moments of the same operation:
  // the POST is the 202 with `live` true, and the listing is where it ended up.
  // A stub that answered one shape for both would let a caller reading `live`
  // off the wrong response pass.
  if (path === '/usage') return json(USAGE);
  if (path === '/moves') return json({ moves: [MOVE_DONE] });
  if (path.endsWith('/move')) return json(MOVE_STARTED, { status: 202 });
  if (path === '/computers') return json(get ? [COMPUTER] : COMPUTER);
  // endsWith, because the recorder's paths keep the computer id: the real
  // route is /computers/:id/input, and an exact '/input' match never fired.
  if (path.endsWith('/input')) return json({});
  return json(COMPUTER);
};

export const testClient = (fetchImpl: typeof globalThis.fetch, Ctor: typeof Client): Client =>
  new Ctor({ apiKey: 'com_test', baseUrl: BASE, fetch: fetchImpl });
