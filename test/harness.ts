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

export const errorJson = (status: number, error: string): Response =>
  new Response(JSON.stringify({ error }), {
    status,
    headers: { 'content-type': 'application/json' },
  });

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
  },
};

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

/**
 * A responder that answers every route with something of the right shape.
 *
 * Shared by the surface tests, which care where a request went rather than what
 * came back. Collections list on GET and return a single object on POST —
 * getting that backwards is what made the first version of this fail.
 */
export const anyRoute: Responder = (call) => {
  const { path, method } = call;
  const get = method === 'GET';
  if (path.endsWith('/screenshot')) return bytes('png');
  if (path.endsWith('/files')) return get ? bytes('file', 'text/plain') : json({ bytes: 5 });
  if (path.endsWith('/exec')) return json(EXEC_OK);
  if (/\/exec\/\d+$/.test(path)) return json({ pid: 42, running: false, exit_code: 0 });
  if (path.endsWith('/windows')) return json([]);
  if (/\/windows\/[^/]+$/.test(path)) return json({ id: '0x1', title: 'w' });
  if (path.endsWith('/schedule')) return json({ enabled: true, hour: 4, minute: 0, tz: 'UTC' });
  if (path.endsWith('/agent')) return json({ steps: 1, stop: 'end_turn', text: 'done' });
  if (path === '/templates' || path === '/sizes') return json([]);
  if (path.endsWith('/snapshots')) {
    // GET computers/:id/snapshots is the holdings triple, not a listing.
    if (get && path !== '/snapshots') return json({ count: 0, size_bytes: 0, fingerprint: 'f' });
    return json(get ? [SNAPSHOT] : SNAPSHOT);
  }
  if (path === '/computers') return json(get ? [COMPUTER] : COMPUTER);
  // endsWith, because the recorder's paths keep the computer id: the real
  // route is /computers/:id/input, and an exact '/input' match never fired.
  if (path.endsWith('/input')) return json({});
  return json(COMPUTER);
};

export const testClient = (fetchImpl: typeof globalThis.fetch, Ctor: typeof Client): Client =>
  new Ctor({ apiKey: 'com_test', baseUrl: BASE, fetch: fetchImpl });
