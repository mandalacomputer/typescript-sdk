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

/** Base class for every error this SDK raises. */
export class MandalaError extends Error {
  override name = 'MandalaError';
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
};

/** Build the error for a status, with the platform's own message when it sent one. */
export function errorForStatus(status: number, message: string, body?: unknown): APIError {
  const Cls = BY_STATUS[status] ?? APIError;
  return new Cls(message, status, body);
}

/**
 * Whether an error is worth trying again without changing the request.
 *
 * What the wait helpers retry on. Everything else is surfaced, because a caller
 * that can read "the guest agent is not answering yet" is better placed to
 * decide than a fixed policy is.
 */
export function isTransient(err: unknown): boolean {
  return err instanceof ConflictError || err instanceof UnavailableError;
}
