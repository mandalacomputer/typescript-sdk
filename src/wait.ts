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
  APIError,
  ConnectionError,
  MoveRequiredError,
  OriginTLSError,
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
 * Whether a poll is worth making again.
 *
 * The other half of {@link isTransient}, and the point of having two: they read
 * as the same question and are not one. `isTransient` is exported, so its
 * caller is a host application wrapping an arbitrary call — possibly a
 * `create` — in `if (isTransient(err)) retry()`, and it can only name failures
 * that are safe to replay blind. This one is asked by the waits in this SDK,
 * which replay a `GET computers/:id`, a `GET moves`, a build read or an
 * `exec 'exit 0'` probe: idempotent, every one of them, and every one under a
 * deadline the caller set. That pair of properties is a fact about what those
 * calls DO rather than about the error, which is why this cannot be published
 * as the same `true`.
 *
 * DENY-LIST, where `isTransient` is an allow-list, and the inversion is
 * deliberate (OPL-3724). The polarity follows from who pays for a wrong answer.
 * Retrying something unretryable costs one poll interval and at worst the
 * deadline the caller chose. NOT retrying something that would have cleared
 * costs a wait that reports a machine as unreachable while it was coming up —
 * and under an allow-list every status the edge invents next lands in that
 * second category, silently, until somebody notices and adds a class.
 *
 * The line is REQUEST versus MOMENT. A failure describing the request answers
 * the same way forever and is fatal here; a failure describing the moment is
 * what a poll exists to outlast.
 *
 * Fatal, therefore:
 *
 * - anything that is not a failed REQUEST. That is the floor, and a deny-list
 *   needs one: only {@link APIError} and {@link ConnectionError} describe an
 *   exchange with the platform that did not work, and only those can be worth
 *   making again. A `TypeError` from a bug in this file is not the platform
 *   being slow, and riding one out spends the caller's deadline before
 *   reporting the wrong cause; {@link ValidationError} is a `TypeError` by
 *   design and lands here for free.
 *
 *   A bare {@link MandalaError} is caught by the same floor, and that is the
 *   half worth spelling out, because every poll loop here raises them: "this
 *   move is not listed", "this build says done beside a running status".
 *   Those are VERDICTS this SDK reached about a poll that succeeded, thrown
 *   from inside the same try that wraps the request. Polling through one is an
 *   infinite loop with a deadline on it, which is what the test suite said the
 *   first time this predicate did not draw the line here.
 * - {@link MoveRequiredError} — a decision about the size that was asked for.
 * - {@link OriginTLSError} (525, 526) — a certificate the edge and the platform
 *   cannot agree on fails identically on every retry, so waiting one out spends
 *   the whole deadline to report the wrong cause.
 * - 524 — reached only by holding a request open past the edge's ceiling, so an
 *   identical retry reproduces it at the same place. It shares
 *   {@link GatewayTimeoutError} with 504, which is worth another poll, and that
 *   is why this one status is matched by NUMBER: the type cannot separate them.
 * - anything below 500 that is not named. A 4xx is the request — a bad body, a
 *   revoked key, a plan limit, a deleted id, an offset past the end of a file —
 *   and repeating it unchanged cannot change the answer. Three describe the
 *   moment instead and are named: 409, 429, and 408, which RFC 9110 defines as a
 *   request the client may repeat unchanged and which the edge does emit.
 *
 *   A 3xx goes with the 4xx, which is why the test is `>= 500` rather than "not
 *   a 4xx". The transport does not follow redirects and treats every non-2xx as
 *   an error, so a baseUrl missing its trailing path answers 301 — polled to the
 *   deadline under a 4xx-only rule, ending in a timeout naming nothing about the
 *   redirect. mandala-computer-python found that one.
 *
 * 5xx has an upper bound as well as a lower one, and it is not decoration: the
 * HTTP parser under `fetch` accepts any three digits, so a broken or hostile
 * origin can answer 700 — which `>= 500` alone called a passing moment and
 * polled until the caller's deadline (Codex adversarial review, OPL-3724).
 *
 * {@link APIError.reason} is deliberately NOT consulted here, and that is the
 * one place this predicate and {@link isTransient} part company (platform
 * OPL-3898). `unavailable` means the computer is not running, which is a
 * permanent answer to whoever asked — and a poll under a deadline is the one
 * caller for whom it may not be, since a computer coming up passes through it.
 * The same generosity as every unmapped 5xx above and for the same reason: this
 * only ever replays a read, and the waits return a verdict of their own the
 * moment the status they are watching settles. mandala-computer-python's
 * `_is_transient_for_poll` and the MCP server's draw the line in the same place.
 *
 * Everything at 5xx polls through, which is the behaviour change: 502 and 520-523
 * mean the outcome is unknown, and a read whose outcome is unknown can simply
 * be read again. {@link Computer.waitForGuest} already knew this about 502 and
 * carried its own `|| err.status === 502` beside this predicate to say so; the
 * rest of the waits poll the control plane, where a 502 is edge noise and was
 * being reported to callers as a machine that never came up.
 */
export const isTransientForPoll = (err: unknown): boolean => {
  if (!(err instanceof APIError) && !(err instanceof ConnectionError)) return false;
  if (err instanceof MoveRequiredError) return false;
  if (err instanceof OriginTLSError) return false;
  if (err instanceof APIError) {
    if (err.status === 524) return false;
    if (err.status === 408 || err.status === 409 || err.status === 429) return true;
    return err.status >= 500 && err.status < 600;
  }
  return true;
};

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
 * Whether this failure is the wait's OWN deadline firing inside a poll.
 *
 * {@link deadlineSignal} composes `AbortSignal.timeout`, whose reason is a
 * `TimeoutError` DOMException, and the transport rethrows that reason verbatim.
 * So it arrives in a catch looking exactly like a failure of the platform, and
 * it is not one — it is this wait ending, with a request still in flight.
 *
 * Telling them apart matters twice. A loop that counts it as a failed poll
 * reports a build it was watching successfully as one it could not reach; and a
 * loop that runs it through a transience check treats the ordinary end of a wait
 * as a fatal error of unknown kind.
 *
 * The caller's own abort is NOT this: it is checked before this is reached, and
 * belongs to the caller rather than to the wait.
 *
 * `TimeoutError` ALONE, and the missing name is the point. `AbortError` was
 * accepted here too, defensively, and it turns out to be exactly the hole a
 * name-based test is accused of having (adversarial review, second pass):
 * nothing that reaches this is a deadline named `AbortError`, so the only
 * errors the extra name could match are other people's.
 *
 * Measured on node 22+, which is what this package supports. A deadline fires
 * as `AbortSignal.timeout`'s reason, which is spec'd as — and observed to be —
 * a DOMException named `TimeoutError`; `AbortSignal.any` carries that reason
 * through unchanged; and `fetch` rejects with the reason itself rather than a
 * generic abort. When the CALLER aborts, the reason is named `AbortError` and
 * their own signal reads `aborted`, so the check above this one has already
 * returned. The two cases never collide.
 *
 * What accepting `AbortError` cost: an abort from anywhere else — a body
 * stream, an injected `fetch` — was read as this wait's deadline, swallowed,
 * and polled over until the wait timed out. The caller was then told the wait
 * expired rather than what actually stopped it.
 */
export const isDeadlineAbort = (err: unknown): boolean =>
  err instanceof DOMException && err.name === 'TimeoutError';

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
