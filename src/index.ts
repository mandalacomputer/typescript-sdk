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

import {
  Account,
  Builds,
  Computers,
  Moves,
  Sizes,
  Snapshots,
  SshKeys,
  Templates,
  Usage,
  Webhooks,
} from './resources.js';
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
  readonly account: Account;
  readonly builds: Builds;
  readonly computers: Computers;
  readonly moves: Moves;
  readonly snapshots: Snapshots;
  readonly sshKeys: SshKeys;
  readonly templates: Templates;
  readonly sizes: Sizes;
  readonly usage: Usage;
  readonly webhooks: Webhooks;
  readonly #t: Transport;

  /**
   * @param opts.apiKey defaults to `MANDALA_API_KEY`.
   * @param opts.baseUrl defaults to `MANDALA_BASE_URL`, then the public API.
   */
  constructor(opts: ClientOptions = {}) {
    this.#t = new Transport(opts);
    this.account = new Account(this.#t);
    this.builds = new Builds(this.#t);
    this.computers = new Computers(this.#t);
    this.moves = new Moves(this.#t);
    this.snapshots = new Snapshots(this.#t);
    this.sshKeys = new SshKeys(this.#t);
    this.templates = new Templates(this.#t);
    this.sizes = new Sizes(this.#t);
    this.usage = new Usage(this.#t);
    this.webhooks = new Webhooks(this.#t);
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
export type {
  DeleteOptions,
  FileChunk,
  ScrollOptions,
  WaitForOptions,
  WaitOptions,
} from './computer.js';
export {
  Computer,
  DEFAULT_RESOLUTION,
  EphemeralComputer,
  GUEST_PROBE,
  SCREEN_HEIGHT,
  SCREEN_WIDTH,
} from './computer.js';
export type { ErrorMetadata } from './errors.js';
export {
  APIError,
  AuthenticationError,
  ConflictError,
  ConnectionError,
  ConnectionInterruptedError,
  FileExistsError,
  GatewayTimeoutError,
  isTransient,
  MandalaError,
  MethodNotAllowedError,
  MoveRequiredError,
  NotFoundError,
  OriginResponseError,
  OriginTLSError,
  OriginUnreachableError,
  PermissionDeniedError,
  PlanLimitError,
  RangeNotSatisfiableError,
  RateLimitError,
  TimeoutError,
  TooLargeError,
  UnavailableError,
  ValidationError,
} from './errors.js';
export type {
  ComputerEvent,
  ComputerEventType,
  EventRefusal,
  EventSocket,
  EventSocketFactory,
  EventSource,
  EventStreamOptions,
  EventUrlSource,
  Hello,
  WatchedTree,
  WatchLost,
} from './events.js';
export {
  answersWait,
  ComputerEvents,
  EVENT_STREAM_DEFAULTS,
  GUEST_EVENT_TYPES,
  globalEventSocket,
  isSettled,
  MAX_WATCH_PATH_BYTES,
  MAX_WATCHES,
  STREAM_FRAME_TYPES,
  unarmedTrees,
} from './events.js';
export type { ExecutionMetadata, ExecutionOutput, ExecutionOutputOptions } from './executions.js';
export type {
  AccountCapabilities,
  AccountCompleteness,
  AccountLimits,
  AccountPerComputer,
  AccountPlan,
  AccountQuota,
  AccountRemaining,
  AccountUsage,
  BackgroundExec,
  BuildProgress,
  BuildStep,
  ComputerUsage,
  ExecResult,
  GuestWindow,
  Holdings,
  Move,
  Point,
  PublishedTemplate,
  Retention,
  RetiredTemplates,
  Schedule,
  SecretBinding,
  SecretBindings,
  Size,
  Snapshot,
  SshAccess,
  SshKey,
  Template,
  TemplateBuild,
  TemplateCheck,
  UsagePeriod,
  UsageReport,
  UsageTotals,
  VncConnect,
  Webhook,
  WebhookCreated,
  WebhookDelivery,
  WindowResult,
} from './models.js';
export type {
  ComputerState,
  CreateArgs,
  ExecArgs,
  MoveArgs,
  ScrollDirection,
  SecretBindingArgs,
  SshKeyAddArgs,
  UpdateArgs,
  WebhookCreateArgs,
  WebhookUpdateArgs,
  WindowAction,
} from './paths.js';
export {
  COMPUTER_STATES,
  SCROLL_DIRECTIONS,
  SECRET_BINDINGS_MAX,
  SECRET_FILES_MAX,
  WEBHOOK_COMPUTERS_MAX,
  WEBHOOK_DESCRIPTION_MAX,
  WINDOW_ACTIONS,
} from './paths.js';
export type {
  CallOptions,
  ComputerListOptions,
  ListOptions,
  SnapshotCloneOptions,
  UsageOptions,
} from './resources.js';
export {
  Account,
  Builds,
  Computers,
  Moves,
  Sizes,
  Snapshots,
  SshKeys,
  Templates,
  Usage,
  Webhooks,
} from './resources.js';
export type { Bytes, ContentRange, Listing, SSEEvent, TransportOptions } from './transport.js';
export { DEFAULT_BASE_URL, MODEL_KEY_HEADER } from './transport.js';
export type { VerifyOptions, WebhookBody, WebhookHeaders } from './webhooks.js';
export {
  replayRetentionS,
  verify,
  WEBHOOK_SECRET_PREFIX,
  WEBHOOK_TOLERANCE_S,
} from './webhooks.js';

export const VERSION = '0.5.0';

export type {
  Artifact,
  ArtifactAssociation,
  DownloadArtifactOptions,
  PublishArtifactOptions,
} from './artifacts.js';

export type {
  BackgroundResult,
  ResultObservation,
  ResultOutput,
  ResultOutputOptions,
  ResultPrefix,
  ResultStream,
  RetainedResult,
  RetainOutputOptions,
  SynchronousResult,
  SynchronousResultPrefix,
} from './results.js';
/** Re-exported so a caller can build a URL against the same default. */
export { DEFAULT_BASE_URL as BASE_URL };
