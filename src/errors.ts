/**
 * What the platform's status codes mean, as types.
 *
 * The distinctions here are the ones a caller has to act on and cannot infer
 * from prose. A 400 never clears and retrying it burns a request. A 409 is the
 * one that is not uniform: most of them are a passing moment and worth
 * retrying, and one is a decision about the size that was asked for — see
 * {@link ConflictError} and {@link MoveRequiredError}.
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

/**
 * The request never left. Nothing was dispatched, so anything may be replayed.
 *
 * NARROWER than it used to be, and the narrowing is the point. This class once
 * wrapped every rejection the transport produced, which meant it also carried
 * the failures that happen AFTER the request reached the platform — a socket
 * reset while the response body was being read, a per-request deadline that
 * fired with the request already on the wire. Those wear the opposite outcome:
 * the platform may well have acted, and the answer is what was lost. They now
 * get {@link ConnectionInterruptedError}, which is a subclass, so
 * `catch (e) { if (e instanceof ConnectionError) }` still sees both.
 *
 * What is left here is what the name always claimed: DNS that did not resolve,
 * a socket that was refused, a connect that timed out, a TLS handshake that
 * failed. Not one byte of the request was written, so {@link isTransient} can
 * say yes to it even for a caller replaying a `create`.
 *
 * The transport raises this one only for a cause it can positively identify as
 * connect-phase; see `neverDispatched` in `src/transport.ts`. Everything it
 * cannot identify is the subclass, because the cost of the two wrong answers is
 * not symmetric — see there.
 */
export class ConnectionError extends MandalaError {
  override name = 'ConnectionError';
}

/**
 * The request was dispatched and the answer was lost. Outcome unknown.
 *
 * A socket that resets while the response body is being read, an HTTP parser
 * error on the way back, a per-request deadline that fired after the request
 * went out, a connection failure this SDK cannot place in either phase. The
 * shared property is the one that matters: the platform may have received the
 * request and acted on it, and nothing in the error says whether it did.
 *
 * So this is FATAL to {@link isTransient} and transparent to
 * `isTransientForPoll`, and the split is the same one OPL-3724 made for 502 and
 * 504. Its reasoning applies here unchanged, and this case had escaped it only
 * because it wears a class whose name says the request never left.
 * `computers.create()` reaches the platform, the platform builds the computer,
 * the socket dies mid-response: an embedder asking {@link isTransient} used to
 * be told yes, replayed the create, and paid for two computers.
 *
 * The per-request TIMEOUT is the case worth naming separately, because it was
 * not obviously this bug and is. `timeout_ms` firing produced a
 * `ConnectionError` reading "timed out after 30000ms", and a timeout is the
 * shape where the request has most likely gone out and the platform is most
 * likely still working on it. It said "safe to replay blind" about the one
 * failure where that is least true.
 *
 * A SUBCLASS rather than a sibling, which is what keeps this from breaking
 * anyone. `instanceof ConnectionError` still matches, so existing catch blocks
 * and `isTransientForPoll`'s floor need no change; only the one predicate that
 * promises blind replay had to learn the difference. It is the same shape
 * {@link MoveRequiredError} has under {@link ConflictError}, for the same
 * reason: a case that is genuinely a kind of its parent and genuinely answers
 * one question the other way.
 *
 * The poll predicate still rides it out, and that is not an oversight. The wait
 * helpers replay reads — a `GET computers/:id`, an `exec 'exit 0'` probe — and a
 * read whose outcome was lost can simply be read again. Only a caller who might
 * be replaying a WRITE needs the distinction, which is exactly the caller
 * {@link isTransient} is exported for.
 */
export class ConnectionInterruptedError extends ConnectionError {
  override name = 'ConnectionInterruptedError';
}

/** The API returned an unsuccessful response. */
export class APIError extends MandalaError {
  override name = 'APIError';
  /**
   * The platform's own word for what KIND of refusal this is, where it sent one
   * (platform OPL-3898): `contention`, `starting`, `unavailable` or
   * `unsupported`. `undefined` for most errors, and always will be — the
   * platform is explicit that an absent value means unclassified rather than
   * "none of the four", which is what makes it safe to classify more later.
   *
   * `message` is unchanged and is still the sentence for a person. This is the
   * part a program is allowed to depend on, and {@link isTransient} is the first
   * thing that does.
   *
   * On this class rather than on {@link ConflictError}, which is the one it was
   * filed for, because the platform keys it on the ERROR rather than on the
   * route: the same sentinel is reached from several endpoints, and
   * `unavailable` arrives as a 400 as well as a 409 — whoever loses the race to
   * the running check hears the same fact the caller a moment earlier heard.
   */
  readonly reason?: string;
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.reason = refusalReason(body);
  }
}

/**
 * The two answers {@link APIError.reason} can carry, as sets rather than types.
 *
 * Kept as data deliberately. The platform states that a fifth word may be added
 * and that a client must read one it does not recognise as "no answer given" —
 * an allow-list of classes would make the next word a breaking change, and the
 * same word arrives on more than one status, so a subclass of any one of them
 * could not carry it. Both memberships are tested rather than one being
 * inferred from the other, which is what makes an unknown word fall through to
 * the type answer instead of reading as permanent. Identical in all three
 * clients: `_REASON_CLEARS` and `_REASON_PERMANENT` in mandala-computer-python,
 * and the same pair in mandala-computer-mcp.
 */
const REASON_CLEARS: ReadonlySet<string> = new Set(['contention', 'starting']);
const REASON_PERMANENT: ReadonlySet<string> = new Set(['unavailable', 'unsupported']);

/**
 * The platform's one-word classification off a refusal body, or `undefined`.
 *
 * Shape-checked in the manner of {@link moveOffer} and for its reason: this
 * decides a retry policy, so a body whose `reason` is not a string has to read
 * as "no answer given" and fall back to what this SDK did before the key
 * existed. Any string is kept, unknown words included — the sets above are the
 * contract, and the raw word belongs to whoever is embedding this.
 */
function refusalReason(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const reason = (body as { reason?: unknown }).reason;
  return typeof reason === 'string' ? reason : undefined;
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
 * Nearly every one of these clears itself without anybody doing anything, so
 * the answer is to wait and try again rather than to change the request. It
 * means something is in flight that this operation cannot run alongside:
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
 * and becomes a 502. That used to be load-bearing here — the note said a retry
 * loop on this "terminates rather than being told still booting forever", and
 * it was the strongest argument for treating 502 as fatal.
 *
 * It does not survive reading the loop it describes.
 * {@link Computer.waitForGuest} is the only wait that ever sees a guest 502,
 * and it retried one all along, because an agent that is merely slow answers
 * 502 for its first seconds too. The two claims were never about the same
 * request. What actually terminates a guest wait is its DEADLINE, which every
 * wait here has and which no status can extend (OPL-3724).
 *
 * NEARLY, and the exception is {@link MoveRequiredError}. Whether a 409 clears
 * is a property of the body rather than of the status: a refusal that clears
 * describes a passing state, and one that does not describes a decision about
 * the request. This class said "every one" and {@link isTransient} agreed with
 * it, which made a resize past what a host can run retry forever.
 *
 * The other exception could not be given a class, because it is the same
 * refusal on several routes: a guest call against a computer that is not
 * running. {@link APIError.reason} is how those are told apart now — the word
 * the platform added for the purpose, and the one its reference says to switch
 * on rather than the sentence, which is prose and is rewritten. Where no word
 * was sent this class means what it always did, and that fallback is the
 * contract rather than a gap.
 */
export class ConflictError extends APIError {
  override name = 'ConflictError';
}

/**
 * The 409 that is an OFFER: this resize needs the computer moved first.
 *
 * `PATCH computers/:id` growing `ramMb` past what the computer's current host
 * can run answers 409 with a `move` object on the body rather than only a
 * sentence. It is not a dead end — another host in the same region may be able
 * to run that size, and {@link Computer.relocate} is how a caller agrees to go
 * there.
 *
 * {@link movePossible} is the whole branch, and it is read off the body here so
 * that no caller has to: `move.required` is true either way, and it is the
 * second field that decides whether there is anything to do.
 *
 * - `true` — somewhere in the region can run it. {@link Computer.relocate} with the
 *   same sizing arguments moves the computer and applies the size on arrival.
 *   It copies the disk to different hardware, so it is a separate call rather
 *   than something a resize does to you quietly, and the computer has to be
 *   stopped.
 * - `false` — nothing in the region can run that size at all. There is nowhere
 *   to move to; ask for less.
 *
 * NOT transient either way. The host cannot run that size and will not grow, so
 * the same request answers the same way for as long as the computer is where it
 * is. That is why this has a class at all: it is a {@link ConflictError} by
 * status and the opposite of one by nature.
 */
export class MoveRequiredError extends ConflictError {
  override name = 'MoveRequiredError';
  constructor(
    message: string,
    status: number,
    body: unknown,
    /** Whether a host in this region could run the size that was asked for. */
    readonly movePossible: boolean,
  ) {
    super(message, status, body);
  }
}

/**
 * The `move` object the platform puts on that refusal, if this body has one.
 *
 * Shape-checked rather than trusted, because it decides both a retry policy and
 * what a caller is told to do next: a body whose `move` is a string, or an
 * object with no boolean `possible`, must read as "not that refusal" rather
 * than as a move that is impossible. Absent and malformed get the same answer,
 * and it is the conservative one — an ordinary {@link ConflictError}, which is
 * what this was before.
 */
function moveOffer(body: unknown): { possible: boolean } | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const move = (body as { move?: unknown }).move;
  if (!move || typeof move !== 'object') return undefined;
  const { required, possible } = move as { required?: unknown; possible?: unknown };
  if (required !== true || typeof possible !== 'boolean') return undefined;
  return { possible };
}

/**
 * 413 — more of that file than one request moves.
 *
 * The ceiling is on a single transfer, not on the file: the bytes cross the
 * guest agent in chunks and one request holds that channel for as long as it
 * takes. On a download it is therefore not a dead end — {@link
 * Computer.readFileChunks} pages a file of any size through it, and
 * {@link Computer.readFilePart} reads one window — which is why this is its own
 * class rather than a bare {@link APIError}: a caller who cannot tell a 413
 * from a 400 has no reason to look for the way past it.
 *
 * On an upload there is no such door. The body IS the file, so a write past the
 * ceiling has to be split by whoever is sending it.
 */
export class TooLargeError extends APIError {
  override name = 'TooLargeError';
}

/**
 * 416 — the range named no byte the file has.
 *
 * `total` is the file's real length, off the refusal's own `Content-Range`.
 * That number is the entire value of this status: the caller asked a question
 * about a file whose size they did not know, and it is the one answer that lets
 * them ask again correctly rather than guess. Reaching it used to mean parsing
 * a header off an error nobody had a class for.
 *
 * Absent only where the response did not carry a readable one — which this
 * platform always does, and something in front of it might not.
 */
export class RangeNotSatisfiableError extends APIError {
  override name = 'RangeNotSatisfiableError';
  constructor(
    message: string,
    status: number,
    body?: unknown,
    readonly total?: number,
  ) {
    super(message, status, body);
  }
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
 * The platform fails closed about this by design: `GET /computers`,
 * `GET /snapshots` and `GET /builds` are fan-outs across the fleet, and a short
 * list reads exactly like the missing rows were deleted. Pass `allowPartial` to
 * opt into a short answer that says it is short — see {@link Listing}.
 *
 * Three listings, not two, since OPL-3840. The builds one always answered this
 * way and until then documented no way out, which made a build listing strictly
 * less available than a computer listing.
 */
export class UnavailableError extends APIError {
  override name = 'UnavailableError';
}

/**
 * 504, 524 — a proxy in front of the platform gave up before the platform answered.
 *
 * Not a refusal, and not the platform's answer at all. Nothing was cancelled;
 * what ended was one hop's willingness to hold a connection open with no
 * response crossing it. Usually the platform has the request and is still
 * working on it — but only usually, because a 504 can also come from a hop that
 * never reached it, and the status alone does not say which hop wrote it.
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

/**
 * 521-523 — a proxy in front of the platform could not reach it.
 *
 * The rest of what an edge generates on its own, and the same defect as
 * {@link GatewayTimeoutError} a few statuses along: with no class and no written
 * message these fell through to the bare `HTTP 522`, which names no cause, no
 * culprit and no way out.
 *
 * A different event from a gateway timeout, which is why it is a different type
 * rather than more entries on that one. A 524 means the request arrived and is
 * still being worked on; these mean it almost certainly never arrived, so
 * nothing was started and there is no command outliving anything. Almost,
 * because a 522 can also be a connection that timed out after it was
 * established, and bytes already on the wire are not unsent because the answer
 * never came back — so a caller branching on the class to decide whether its
 * work survived gets opposite answers, and should still look before repeating
 * something that creates.
 *
 * mandala-computer-mcp reached this first and argued the divergence the other
 * way: that a developer-facing client did not need it, because its messages are
 * read by a person who can go and look up what a 523 is, while a model cannot.
 * The counter is what this SDK is for. It is an agent SDK — its errors are fed
 * to models routinely, by the frameworks it exists to be used from — so the
 * audience that cannot look up a 523 is on this side of the line too. And a
 * person seeing `HTTP 522` is not much better served: the 52x range is Cloudflare's
 * own numbering, and nothing about it is guessable from the number.
 */
export class OriginUnreachableError extends APIError {
  override name = 'OriginUnreachableError';
}

/**
 * 520 — the platform answered a proxy with something it could not read.
 *
 * Sits between the other two and must not be filed with either, because the
 * question a caller is really asking is whether their work happened, and this is
 * the one status whose honest answer is "unknown".
 *
 * A 524 means the request arrived and is still being worked on. 521-523 mean it
 * never arrived, so nothing was started. A 520 means it **did** arrive — the
 * platform received it and then returned an empty, unknown or oversized
 * response, so it may have been carried out in full, in part, or not at all, and
 * the answer was lost rather than never produced.
 *
 * Which makes a blind retry the thing to be careful about. Re-sending a read
 * costs nothing; re-sending a create can leave two computers where one was
 * meant, both billable, on the strength of a failure that said the first never
 * happened.
 *
 * It was filed with {@link OriginUnreachableError} at first, on the reading that
 * the whole 52x range is the edge failing to reach the platform. It is not, and
 * the message that came with it — "the request never arrived, so nothing was
 * started" — was exactly the confident falsehood this work exists to remove,
 * pointed the other way.
 */
export class OriginResponseError extends APIError {
  override name = 'OriginResponseError';
}

/**
 * 525, 526 — a proxy and the platform could not agree on TLS.
 *
 * Split from {@link OriginUnreachableError}, which it used to share, because the
 * two need opposite answers to "should I try again". An unreachable origin is a
 * passing outage; an expired or mismatched certificate fails identically on
 * every retry, and is a deployment somebody has to go and fix.
 *
 * Neither is in {@link isTransient}, so nothing about retrying changes here —
 * this SDK gives up on both. What changes is that a caller can now tell them
 * apart, which matters because only one of them is worth waiting on at all.
 */
export class OriginTLSError extends APIError {
  override name = 'OriginTLSError';
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
  413: TooLargeError,
  416: RangeNotSatisfiableError,
  503: UnavailableError,
  504: GatewayTimeoutError,
  // NOT OriginUnreachableError, which is the trap in this range: 520 means the
  // platform WAS reached and answered unreadably. See OriginResponseError.
  520: OriginResponseError,
  521: OriginUnreachableError,
  522: OriginUnreachableError,
  523: OriginUnreachableError,
  524: GatewayTimeoutError,
  // Their own class, not more entries on the one above: an unreachable origin is
  // a passing outage and these are a deployment somebody has to fix.
  525: OriginTLSError,
  526: OriginTLSError,
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
  'cancelled: the platform never saw this deadline, so anything the request had already ' +
  'set going carries on without it — usually it has the request and is still working, ' +
  'though a 504 can come from a hop that never reached it. Most often that is a ' +
  'foreground exec(), which ends this ' +
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
 * `error` and not RFC 9457's `detail`, though Cloudflare answers these statuses
 * with one and `messageFromBody` in transport.ts reads it. Deliberate, and the
 * distinction is what each hop can know. Cloudflare's `detail` describes the
 * edge accurately and stops there, because a proxy cannot know that the request
 * under it was a foreground exec with a two-minute ceiling over it and an
 * execBackground alternative. Counting it here would hand that sentence the
 * substitution and lose the only part a caller can act on — on 504 and 524,
 * which is to say on almost every real one of these.
 *
 * Which hop wrote it is not knowable from here and does not need to be. The test
 * is whether SOMETHING said something specific — a 504 can be raised by any
 * proxy in the chain, including one in front of a `baseUrl` this client has
 * never seen.
 */
/** What a caller is told when the platform's own answer arrived unreadable. */
const ORIGIN_RESPONSE_MESSAGE =
  'the platform received the request and the exchange then broke on the way back — an ' +
  'empty or unreadable response, a connection dropped before the headers, an origin that ' +
  'stopped part-way. Unlike an unreachable origin, the request did arrive, so it may have ' +
  'been carried out in full, in part, or not at all. Retrying a read costs nothing; before ' +
  'retrying anything that creates something — a computer, a snapshot — check whether the ' +
  'first attempt took effect, or you may end up with two of it';

/** What a caller is told when a proxy could not reach the platform at all. */
const ORIGIN_UNREACHABLE_MESSAGE =
  'a proxy in front of the platform could not reach it. Almost always that means the ' +
  'request was never sent, so nothing was started and there is no work on the other side ' +
  'of this to account for — unlike a gateway timeout. Almost, rather than never, because ' +
  'a connection can also time out after it was established, and bytes already on the wire ' +
  'are not unsent because the answer never came back: retry a read freely, and look before ' +
  'retrying something that creates. Usually this is the platform restarting or a short ' +
  'outage, which clears on its own; if it persists the platform is down, and waiting is ' +
  'the only thing that helps';

/** The same, for the two of those that waiting will not fix. */
const ORIGIN_TLS_MESSAGE =
  'a proxy in front of the platform could not complete a TLS handshake with it, so the ' +
  'request was never sent. This is a misconfigured deployment rather than a passing ' +
  'outage — an expired or mismatched certificate fails the same way on every retry, so ' +
  'report it rather than waiting it out';

function namedTheFailure(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const err = (body as { error?: unknown }).error;
  return typeof err === 'string' && err.length > 0;
}

/** Build the error for a status, with the platform's own message when it sent one. */
/**
 * Our wording for a failure, carrying the status it stands in for.
 *
 * The number matters on a message this file wrote in a way it does not on one
 * the platform wrote. Four classes cover eight statuses between them and three
 * of those share a sentence, so a log line holding only `err.message` could no
 * longer tell 521 from 523 — which it could when the message was `HTTP 522`.
 * Applied only where the wording is ours: a message the platform sent is its own
 * sentence, `err.status` already carries the number, and appending one would be
 * this client editing the platform's words.
 */
const said = (message: string, status: number) => `${message} (HTTP ${status})`;

/**
 * What the response's own headers added to a failure, for the two classes that
 * carry one.
 *
 * An options object rather than two more positional numbers: they are both
 * optional, both a bare `number`, and adjacent, so the one call site that
 * passes them would be free to swap them and nothing would say so.
 */
export type ErrorHeaders = {
  /** From `Retry-After`, in milliseconds from now. */
  retryAfterMs?: number;
  /** The file's real length, from a 416's `Content-Range`. */
  rangeTotal?: number;
};

export function errorForStatus(
  status: number,
  message: string,
  body?: unknown,
  headers: ErrorHeaders = {},
): APIError {
  if (status === 429) return new RateLimitError(message, status, body, headers.retryAfterMs);
  const Cls = BY_STATUS[status] ?? APIError;
  // The 409 that is an offer, told apart by its body. Never given a substitute
  // message: the platform's sentence here is the whole account of what will not
  // fit and what moving costs, written for whoever has to agree to it.
  if (Cls === ConflictError) {
    const offer = moveOffer(body);
    if (offer) return new MoveRequiredError(message, status, body, offer.possible);
  }
  if (Cls === RangeNotSatisfiableError) {
    return new RangeNotSatisfiableError(message, status, body, headers.rangeTotal);
  }
  // Substituted for an empty body, which says nothing, and for a proxy's HTML
  // page, which says 500 characters of nothing. NOT for a structured message:
  // that is the one case where the response knows more than this file does.
  if (Cls === GatewayTimeoutError && !namedTheFailure(body)) {
    return new GatewayTimeoutError(said(GATEWAY_TIMEOUT_MESSAGE, status), status, body);
  }
  // No `namedTheFailure` guard here, and the asymmetry is the point. Every one
  // of 520-526 means the request never reached the platform, so there is no
  // reading on which that body carries the platform's account of what happened —
  // nothing to defer to, and a guard would only look symmetrical.
  // Guarded, where the unreachable statuses below are not, and the difference is
  // which of them the platform could have spoken through. A 520 is its own
  // answer arriving mangled, so a body that parsed as this surface's JSON
  // plausibly IS its account. On 521-526 it provably cannot be.
  if (Cls === OriginResponseError && !namedTheFailure(body)) {
    return new OriginResponseError(said(ORIGIN_RESPONSE_MESSAGE, status), status, body);
  }
  if (Cls === OriginTLSError) {
    return new OriginTLSError(said(ORIGIN_TLS_MESSAGE, status), status, body);
  }
  if (Cls === OriginUnreachableError) {
    return new OriginUnreachableError(said(ORIGIN_UNREACHABLE_MESSAGE, status), status, body);
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
 * Which is why an edge status cannot mean here what it means there. The event
 * reached the caller, so no proxy abandoned anything and none of them failed to
 * reach the platform — and every class in that range asserts exactly that one of
 * those happened. A downstream provider timing out and an edge that stopped
 * waiting are different events with opposite implications for whether the work
 * survived, and a caller branching on the class would be answered wrongly. All
 * of them fall back to a plain {@link APIError}, which still carries the status.
 *
 * Every other status means the same thing in both places and is mapped the same
 * way, 429 included: the platform relays a model provider's rate limit as one of
 * these events, and it is as much a {@link RateLimitError} there as on a
 * response. Without the header there is no `retryAfterMs` to pass on.
 */
const DESCRIBES_THIS_CONNECTION: ReadonlySet<typeof APIError> = new Set([
  GatewayTimeoutError,
  OriginResponseError,
  OriginTLSError,
  OriginUnreachableError,
]);

export function errorForEventStatus(status: number, message: string): APIError {
  if (status === 429) return new RateLimitError(message, status);
  const Cls = BY_STATUS[status] ?? APIError;
  if (DESCRIBES_THIS_CONNECTION.has(Cls)) return new APIError(message, status);
  return new Cls(message, status);
}

/**
 * Whether an error is worth trying again without changing the request.
 *
 * The PUBLIC answer, exported from the package, and therefore a contract with
 * whoever embeds this SDK rather than a private note to this file. Its caller
 * is a host application wrapping an arbitrary call in
 * `if (isTransient(err)) retry()` — possibly a `create` — so it names only
 * failures that both clear on their own AND are safe to replay blind.
 *
 * NOT what the wait helpers ask, which is the OPL-3724 change: they ask
 * {@link isTransientForPoll}, because they replay idempotent reads under a
 * deadline and can afford to be generous where an embedder cannot. This
 * docstring used to say "what the wait helpers retry on" and that was the whole
 * defect — one predicate answering to two audiences, so every argument about
 * widening it had a right answer for one of them and a wrong answer for the
 * other.
 *
 * Unchanged in content, and now identical in all three clients: the MCP server
 * matched these classes plus a list of status numbers and has dropped the list;
 * the Python SDK had no public predicate at all and has grown this one.
 *
 * Note that a STATUS is not enough to answer this, which is why the first check
 * below is on a type. 409 is the case: most are a passing moment, and the move
 * offer is a decision no retry changes.
 *
 * One 409 could be given no class and could not be seen from here at all: a
 * clipboard read or write against a computer that is STOPPED does not clear on
 * its own — `start()` is the fix, not another attempt — and nothing in the body
 * told it apart from a conflict that is merely passing. The advice was to read
 * the message, which is prose the platform is free to reword and exactly the
 * matching OPL-3724 got three clients out of. The platform now says which kind
 * it is, so {@link APIError.reason} is consulted BEFORE the types below, and an
 * absent word — or one this version does not know — leaves the type answer
 * standing unchanged (platform OPL-3898).
 */
export function isTransient(err: unknown): boolean {
  // A move offer is a 409 and is NOT worth retrying: it is a decision about the
  // size that was asked for, and the same request answers the same way for as
  // long as the computer is on that host. First, because it is a subclass of the
  // very branch below that would say yes (OPL-3773).
  if (err instanceof MoveRequiredError) return false;
  // A lost RESPONSE is not a request that never left, and only one of the two
  // is safe to replay blind. Same shape as the line above and the same reason:
  // a subclass of a branch below that would otherwise say yes (OPL-3855). It
  // also carries the per-request timeout, which used to be a plain
  // ConnectionError and so used to be told it was safe to replay a create.
  if (err instanceof ConnectionInterruptedError) return false;
  // The platform's own word, ahead of the types below, because it is the more
  // specific answer and it is the one that tells the 409 that never clears from
  // the two that do (platform OPL-3898). Only an APIError carries a
  // shape-checked one: an arbitrary exception may happen to have a `reason`
  // property, and that is neither this protocol nor retry advice.
  if (err instanceof APIError && err.reason !== undefined) {
    if (REASON_CLEARS.has(err.reason)) return true;
    if (REASON_PERMANENT.has(err.reason)) return false;
  }
  // {@link OriginUnreachableError} is deliberately not here, and 502 and 504
  // are not either. All of them mean the outcome is unknown, which is exactly
  // what an embedder replaying a create cannot afford — one computer becomes
  // two behind a failure that read as nothing having happened.
  //
  // They ARE polled through, by {@link isTransientForPoll}. That is the answer
  // this comment used to defer: it said adding a retrying status here would be
  // retry policy smuggled into a change about what errors are called, and the
  // two deserved to be argued separately. Argued, in OPL-3724 — and the
  // conclusion was that neither client had to give anything up, because the
  // disagreement was never about a status. It was two questions wearing one
  // name.
  return (
    err instanceof ConflictError ||
    err instanceof RateLimitError ||
    err instanceof UnavailableError ||
    err instanceof ConnectionError
  );
}
