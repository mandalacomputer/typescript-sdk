/**
 * What the platform's status codes mean, as types.
 *
 * The distinctions here are the ones a caller has to act on and cannot infer
 * from prose. A 409 clears on its own and is worth retrying; a 400 never does.
 * A 402 is a plan limit, which no amount of waiting fixes and which the account
 * holder — not the code — has to resolve.
 *
 * Mirrors `_exceptions.py` in mandala-computer-python and `errors.ts` in
 * mandala-computer-mcp, deliberately: three clients disagreeing about what a
 * 402 is means the same failure reads differently depending which one you
 * reached for.
 */

/**
 * A caller mistake, refused before the request went out.
 *
 * A `TypeError` subclass rather than a new hierarchy, because that is what
 * every one of these already was and what callers already catch: passing a NaN
 * coordinate or an empty id is a type mistake in the ordinary JS sense, and the
 * platform is not the right place to learn about it.
 *
 * The subclass exists so the CLI can tell an SDK refusal — which is a sentence
 * to print for the user — from a `TypeError` out of a bug in the CLI itself,
 * which is a stack trace for whoever has to fix it. Not exported from the
 * package's entry point: to a caller these are still exactly `TypeError`s, as
 * documented.
 */
export class ValidationError extends TypeError {
  override name = 'ValidationError';
}

/** Base class for every error this SDK raises. */
export class MandalaError extends Error {
  override name = 'MandalaError';
}

/** The platform could not be reached. Safe to retry without changing the request. */
export class ConnectionError extends MandalaError {
  override name = 'ConnectionError';
}

/** The API returned an unsuccessful response. */
export class APIError extends MandalaError {
  override name = 'APIError';
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
  }
}

/** 401 — the API key is missing, malformed, or revoked. */
export class AuthenticationError extends APIError {
  override name = 'AuthenticationError';
}

/**
 * 402 — the account's plan does not cover this request.
 *
 * Raised for computer-count caps, per-computer size ceilings, account-wide RAM
 * and storage pools, OS entitlements, and the API rate budget. Not a retry:
 * `message` carries the platform's explanation of which limit was hit, and a
 * person has to act on it.
 */
export class PlanLimitError extends APIError {
  override name = 'PlanLimitError';
}

/** 403 — authenticated, but the key's role on the account is too low. */
export class PermissionDeniedError extends APIError {
  override name = 'PermissionDeniedError';
}

/**
 * 404 — no such computer, snapshot, or route.
 *
 * Tenant scoping is enforced server-side, so another account's resource is
 * reported as missing rather than forbidden — existence is not leaked.
 */
export class NotFoundError extends APIError {
  override name = 'NotFoundError';
}

/**
 * 409 — the request was fine; the moment was not.
 *
 * Every one of these clears itself without anybody doing anything, so the
 * answer is to wait and try again rather than to change the request. It means
 * something is in flight that this operation cannot run alongside:
 *
 * - the computer's disk is still being copied from a snapshot or another
 *   computer (see {@link Computer.waitUntilBuilt})
 * - a snapshot of it is being taken, or one is already being taken
 * - it is already being deleted
 * - a purge was confirmed against a set of snapshots that has since changed
 * - the guest agent has not answered yet, in the first seconds of a start — so
 *   retrying is the remedy, and giving up here abandons a machine that was
 *   about to answer
 * - another operation is holding that computer's guest agent
 * - a restart was asked of a computer with a suspended session, or a suspend of
 *   one that is not running
 *
 * A guest agent that stays silent past its boot window stops being a conflict
 * and becomes a 502 {@link APIError}, so a retry loop on this terminates rather
 * than being told "still booting" forever.
 */
export class ConflictError extends APIError {
  override name = 'ConflictError';
}

/**
 * 429 — the request is valid, but the caller has exhausted a temporary rate budget.
 *
 * `retryAfterMs` is present when the platform supplied a valid `Retry-After`
 * header. Wait helpers honour it rather than immediately adding more load.
 */
export class RateLimitError extends APIError {
  override name = 'RateLimitError';
  constructor(
    message: string,
    status: number,
    body?: unknown,
    readonly retryAfterMs?: number,
  ) {
    super(message, status, body);
  }
}

/**
 * 503 — a hypervisor could not be reached, so an inventory would be short.
 *
 * The platform fails closed about this by design: `GET /computers` and
 * `GET /snapshots` are fan-outs across the fleet, and a short list reads
 * exactly like the missing rows were deleted. Pass `allowPartial` to opt into
 * a short answer that says it is short — see {@link Listing}.
 */
export class UnavailableError extends APIError {
  override name = 'UnavailableError';
}

/**
 * 504, 524 — a proxy in front of the platform gave up before the platform answered.
 *
 * Not a refusal, and not the platform's answer at all. The request arrived, is
 * very likely still running, and nothing was cancelled; what ended was one hop's
 * willingness to hold a connection open with no response crossing it.
 *
 * Deliberately absent from {@link isTransient}, which is a change from nothing:
 * neither status was transient before this class existed either. Retrying the
 * same call unchanged reproduces it exactly, at the same place, because the hop
 * that gave up never saw how long the caller asked to wait.
 *
 * Against `app.mandala.computer` that hop is Cloudflare and the ceiling is about
 * two minutes. Measured 2026-08-20: `sleep 130` died at 125.2s with
 * `timeoutS: 300` and at 125.3s with `timeoutS: 3600`, while `sleep 110`
 * returned normally at 110.6s. A foreground {@link Computer.exec} slower than
 * that always ends here; {@link Computer.execBackground} is the shape that does
 * not, because it answers as soon as the command has started.
 *
 * The abandoned command keeps running, which is why the next call on the same
 * computer often raises {@link ConflictError} — the guest agent is still busy
 * with it. That is this failure continuing, not a second one.
 */
export class GatewayTimeoutError extends APIError {
  override name = 'GatewayTimeoutError';
}

/** A wait helper gave up before the computer reached the expected state. */
export class TimeoutError extends MandalaError {
  override name = 'TimeoutError';
}

const BY_STATUS: Record<number, typeof APIError> = {
  401: AuthenticationError,
  402: PlanLimitError,
  403: PermissionDeniedError,
  404: NotFoundError,
  409: ConflictError,
  503: UnavailableError,
  504: GatewayTimeoutError,
  524: GatewayTimeoutError,
};

/**
 * What a caller is told when a proxy abandoned the request and named nothing.
 *
 * Used only where the response carried no structured message of its own — see
 * {@link namedTheFailure}. A 524 is generated at the edge, so that is the usual
 * case: it carries a proxy's HTML error page or — when the request asked for
 * JSON, as every request from this client does — nothing at all, which left
 * `err.message` as the bare string `HTTP 524`, naming no cause, no culprit and
 * no way out.
 *
 * Worded for any route, because any of them can meet the ceiling, and the exec
 * sentence is hedged rather than asserted. A read that met it started no command
 * and cannot make a guest agent busy; telling its caller that their work is
 * still running would be a confident falsehood about something that never began.
 */
const GATEWAY_TIMEOUT_MESSAGE =
  'a proxy in front of the platform gave up waiting for it to answer. Nothing was ' +
  'cancelled: the platform never saw this deadline, so any work the request had ' +
  'already started carries on. Most often that is a foreground exec(), which ends this ' +
  'way after about two minutes however large a timeoutS it was given — the ceiling ' +
  'belongs to the proxy, not to the platform or to this client, so raising timeoutS ' +
  'cannot buy time from it and execBackground() is the way to run something slower. ' +
  'After one of those, the next call on that computer may report the guest agent as ' +
  'busy with the command that outlived the request';

/**
 * Whether the response named this failure in the shape this surface uses.
 *
 * Only a JSON body with a non-empty `error` string counts. An HTML page and an
 * empty body are an intermediary's, and both are worth discarding for the
 * wording above; a structured message is not. "upstream unavailable before
 * dispatch" is a more specific true thing than anything written here, and
 * replacing it would be this client overwriting a hop that knew more than it
 * does with a guess.
 *
 * Which hop wrote it is not knowable from here and does not need to be. The test
 * is whether SOMETHING said something specific — a 504 can be raised by any
 * proxy in the chain, including one in front of a `baseUrl` this client has
 * never seen.
 */
function namedTheFailure(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const err = (body as { error?: unknown }).error;
  return typeof err === 'string' && err.length > 0;
}

/** Build the error for a status, with the platform's own message when it sent one. */
export function errorForStatus(
  status: number,
  message: string,
  body?: unknown,
  retryAfterMs?: number,
): APIError {
  if (status === 429) return new RateLimitError(message, status, body, retryAfterMs);
  const Cls = BY_STATUS[status] ?? APIError;
  // Substituted for an empty body, which says nothing, and for a proxy's HTML
  // page, which says 500 characters of nothing. NOT for a structured message:
  // that is the one case where the response knows more than this file does.
  if (Cls === GatewayTimeoutError && !namedTheFailure(body)) {
    return new GatewayTimeoutError(GATEWAY_TIMEOUT_MESSAGE, status, body);
  }
  return new Cls(message, status, body);
}

/**
 * The error a status deserves when it arrived ON a stream rather than as one.
 *
 * The agent loop reports its own failures as events inside a response that was a
 * 200 and stayed open, so the status in the event is the platform relaying what
 * happened downstream — not a description of this connection.
 *
 * Which is why a gateway status cannot mean here what it means there. The event
 * reached the caller, so no proxy abandoned anything, and
 * {@link GatewayTimeoutError} asserts exactly that it did. A downstream provider
 * timing out and an edge that stopped waiting are different events with opposite
 * implications for whether the work survived, and a caller branching on the
 * class would be answered wrongly. Every other status means the same thing in
 * both places and is mapped the same way.
 */
export function errorForEventStatus(status: number, message: string): APIError {
  const Cls = BY_STATUS[status] ?? APIError;
  if (Cls === GatewayTimeoutError) return new APIError(message, status);
  return new Cls(message, status);
}

/**
 * Whether an error is worth trying again without changing the request.
 *
 * What the wait helpers retry on. Everything else is surfaced, because a caller
 * that can read "the guest agent is not answering yet" is better placed to
 * decide than a fixed policy is.
 */
export function isTransient(err: unknown): boolean {
  return (
    err instanceof ConflictError ||
    err instanceof RateLimitError ||
    err instanceof UnavailableError ||
    err instanceof ConnectionError
  );
}
