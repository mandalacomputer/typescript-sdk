/**
 * TypeScript SDK for Mandala Computer — cloud desktops for AI agents.
 *
 * ```ts
 * import { Client } from 'mandala-computer';
 *
 * const client = new Client();                  // MANDALA_API_KEY
 *
 * await client.computers.ephemeral({ template: 'base' }, async (c) => {
 *   await c.waitForGuest();
 *   await c.open('https://example.com');        // on the screen, not as root
 *   const png = await c.screenshot();
 *   await c.click(640, 400);
 *   await c.type('hello');
 * });                                           // destroyed here, even on throw
 * ```
 *
 * This binds only to the platform's curated `/api/v1` surface, never to the
 * hypervisor daemon's own routes — see the README for why that boundary exists.
 */

import { Computers, Sizes, Snapshots, Templates } from './resources.js';
import { DEFAULT_BASE_URL, Transport, type TransportOptions } from './transport.js';

export type ClientOptions = TransportOptions;

/**
 * Entry point to the Mandala Computer API.
 *
 * There is no `close()`. The transport holds no socket of its own — `fetch`
 * manages its own pool — so there is nothing to release, and a method that did
 * nothing but exist for symmetry with the Python client would be a thing to get
 * wrong rather than a thing to use.
 */
export class Client {
  readonly computers: Computers;
  readonly snapshots: Snapshots;
  readonly templates: Templates;
  readonly sizes: Sizes;
  readonly #t: Transport;

  /**
   * @param opts.apiKey defaults to `MANDALA_API_KEY`.
   * @param opts.baseUrl defaults to `MANDALA_BASE_URL`, then the public API.
   */
  constructor(opts: ClientOptions = {}) {
    this.#t = new Transport(opts);
    this.computers = new Computers(this.#t);
    this.snapshots = new Snapshots(this.#t);
    this.templates = new Templates(this.#t);
    this.sizes = new Sizes(this.#t);
  }

  get baseUrl(): string {
    return this.#t.baseUrl;
  }
}

export type {
  AgentArgs,
  AgentEvent,
  AgentResult,
  AgentStep,
  AgentStop,
  AgentUsage,
} from './agent.js';
export type { DeleteOptions, ScrollOptions, WaitOptions } from './computer.js';
export {
  Computer,
  DEFAULT_RESOLUTION,
  EphemeralComputer,
  GUEST_PROBE,
  SCREEN_HEIGHT,
  SCREEN_WIDTH,
} from './computer.js';
export {
  APIError,
  AuthenticationError,
  ConflictError,
  ConnectionError,
  GatewayTimeoutError,
  isTransient,
  MandalaError,
  NotFoundError,
  OriginResponseError,
  OriginTLSError,
  OriginUnreachableError,
  PermissionDeniedError,
  PlanLimitError,
  RateLimitError,
  TimeoutError,
  UnavailableError,
} from './errors.js';
export type {
  BackgroundExec,
  ExecResult,
  GuestWindow,
  Holdings,
  Point,
  Schedule,
  Size,
  Snapshot,
  Template,
  VncConnect,
} from './models.js';
export type { CreateArgs, ExecArgs, ScrollDirection, UpdateArgs, WindowAction } from './paths.js';
export { SCROLL_DIRECTIONS, WINDOW_ACTIONS } from './paths.js';
export type { CallOptions, ListOptions } from './resources.js';
export { Computers, Sizes, Snapshots, Templates } from './resources.js';
export type { Bytes, Listing, SSEEvent, TransportOptions } from './transport.js';
export { DEFAULT_BASE_URL, MODEL_KEY_HEADER } from './transport.js';

export const VERSION = '0.1.0';

/** Re-exported so a caller can build a URL against the same default. */
export { DEFAULT_BASE_URL as BASE_URL };
