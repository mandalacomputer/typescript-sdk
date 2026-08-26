/**
 * The pieces every poll loop in this SDK is built from.
 *
 * Their own module because there are now three of them and they were written
 * for one. {@link Computer.waitUntilBuilt} and {@link Computer.waitForMove}
 * both live on the computer handle, so the helpers lived there too; a build is
 * a job on the account rather than a property of a computer, so
 * {@link Builds.wait} is on a resource collection and could not reach them.
 *
 * The alternative was a second copy, and the reason not to write one is what
 * these functions actually encode. Every one of them is a failure somebody hit:
 * a wait whose numbers were NaN never returned, a poll made under the client's
 * deadline ran on past the moment the wait gave up, and a sleep that kept its
 * abort listener leaked one per poll across a fifteen-minute wait. A second
 * copy is a second chance to omit one of those.
 */

import {
  AuthenticationError,
  NotFoundError,
  PermissionDeniedError,
  PlanLimitError,
  RateLimitError,
  ValidationError,
} from './errors.js';
import { MAX_TIMER_MS } from './transport.js';

/** What every wait in this SDK accepts. */
export type WaitOptions = {
  /** Milliseconds before giving up. */
  timeoutMs?: number;
  /** Milliseconds between polls. */
  pollMs?: number;
  signal?: AbortSignal;
};

/**
 * A failure that polling again cannot fix.
 *
 * A wait swallows the transient ones — a hypervisor briefly away is exactly
 * what a poll loop is for — and must not swallow these, or a wait against a
 * deleted id, an expired key or a plan that does not permit the operation
 * spends its whole timeout discovering it.
 */
export const isPermanent = (err: unknown): boolean =>
  err instanceof AuthenticationError ||
  err instanceof PermissionDeniedError ||
  err instanceof NotFoundError ||
  err instanceof PlanLimitError;

/**
 * A signal that fires when the caller's does, or when `ms` have passed.
 *
 * What makes a wait's own deadline binding on the request in flight. The
 * transport's per-request deadline is the client's, which can be far longer
 * than what is left of the wait, and a poll made under it runs on past the
 * moment the wait was told to give up.
 */
export const deadlineSignal = (ms: number, caller?: AbortSignal): AbortSignal => {
  const timeout = AbortSignal.timeout(Math.ceil(Math.max(ms, 0)));
  return caller ? AbortSignal.any([caller, timeout]) : timeout;
};

/**
 * A wait's own numbers, refused when they are not finite.
 *
 * `Date.now() >= NaN` is false, so a non-finite timeout is a deadline that
 * never arrives; `setTimeout(fn, NaN)` fires at once, so a non-finite poll
 * interval turns the wait into an unthrottled request loop against the
 * platform. Neither says anything — the wait simply never returns, which is the
 * one failure shape worse than a wrong answer.
 *
 * Refused here for the reason and in the wording {@link Transport} refuses its
 * own deadline: `timeoutMs: Number(unsetEnvVar)` is the usual spelling of the
 * mistake, and the only place it can be named is before the loop starts.
 */
export const checkWait = (timeoutMs: number, pollMs: number): void => {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_TIMER_MS) {
    throw new ValidationError(
      `timeoutMs must be a non-negative finite number no greater than ${MAX_TIMER_MS} (got ${timeoutMs})`,
    );
  }
  // 0 is the unthrottled loop `setTimeout(fn, NaN)` also is: fire at once and
  // immediately ask again. A wait that never sleeps is a request storm, and
  // the comment above used to name only NaN.
  if (!Number.isFinite(pollMs) || pollMs <= 0 || pollMs > MAX_TIMER_MS) {
    throw new ValidationError(
      `pollMs must be a positive finite number no greater than ${MAX_TIMER_MS} (got ${pollMs})`,
    );
  }
};

/** The ordinary polling delay, raised when the platform explicitly asks us to wait longer. */
export const retryDelay = (pollMs: number, err: unknown): number =>
  err instanceof RateLimitError && err.retryAfterMs !== undefined
    ? Math.max(pollMs, err.retryAfterMs)
    : pollMs;

/** A poll sleep that cannot carry its loop beyond the loop's own deadline. */
export const sleepUntilNextPoll = (
  delayMs: number,
  deadline: number,
  signal?: AbortSignal,
): Promise<void> => sleep(Math.min(delayMs, Math.max(deadline - Date.now(), 0)), signal);

export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason);
    };
    // The listener comes off on the ordinary path too, not only on abort. Left
    // in place, a fifteen-minute wait adds one listener per poll to the
    // caller's single signal — memory held for the signal's lifetime, and a
    // MaxListenersExceededWarning about the leak Node correctly suspects.
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
