/** Resource collections hanging off the client. */

import { Computer, EphemeralComputer } from './computer.js';
import { isTransient, MandalaError, NotFoundError, TimeoutError } from './errors.js';
import type {
  BuildProgress,
  Move,
  PublishedTemplate,
  Retention,
  RetiredTemplates,
  Size,
  Snapshot,
  Template,
  TemplateBuild,
  TemplateCheck,
  UsageReport,
} from './models.js';
import {
  toBuildProgress,
  toMove,
  toPublishedTemplate,
  toRetention,
  toRetiredTemplates,
  toSize,
  toSnapshot,
  toTemplate,
  toTemplateBuild,
  toTemplateCheck,
  toUsageReport,
} from './models.js';
import * as P from './paths.js';
import type { Listing, SSEEvent, Transport } from './transport.js';
import {
  checkWait,
  deadlineSignal,
  retryDelay,
  sleepUntilNextPoll,
  type WaitOptions,
} from './wait.js';

/**
 * Options for the two reads that fan out across the fleet.
 *
 * `allowPartial` opts into a short answer when a hypervisor cannot be reached,
 * instead of the 503 the platform answers by default. The platform fails closed
 * here on purpose: a short list reads exactly like the missing rows were
 * deleted, and the failure that produces is a duplicate create or a report that
 * an account is empty when it is not.
 *
 * Opting in means taking on that check yourself — {@link Listing.incomplete} is
 * how, and it is `null` exactly when the answer was complete.
 */
export type ListOptions = { allowPartial?: boolean; signal?: AbortSignal };

/** What every method here accepts beyond its own arguments. */
export type CallOptions = { signal?: AbortSignal };

/**
 * The one computer a route promised, refused when the payload was not one.
 *
 * {@link Computer.refresh} already guards its own answer this way, and for the
 * same reason: an empty body flattens to a handle with no id, and everything
 * that handle can do throws about an empty id somewhere else entirely — a
 * TypeError out of a path builder, naming neither the request that came back
 * empty nor the route it came from.
 */
const computerRecord = (data: unknown, method: string, path: string): Record<string, unknown> => {
  const payload = P.computerPayload(data);
  if (!payload.id) throw new MandalaError(`expected a computer from ${method} ${path}`);
  return payload;
};

const oneComputer = (t: Transport, data: unknown, method: string, path: string): Computer =>
  new Computer(t, computerRecord(data, method, path));

export class Computers {
  #t: Transport;

  /** @internal */
  constructor(transport: Transport) {
    this.#t = transport;
  }

  /**
   * Every computer on this account.
   *
   * Desktop credentials are deliberately omitted from a listing — see
   * {@link Computer.vnc}. `(await c.refresh()).vnc` is how a listed computer
   * gets one.
   *
   * Throws `UnavailableError` if part of the fleet could not be reached, unless
   * `allowPartial` is set. Use {@link listWithStatus} to see how short it was.
   */
  async list(opts: ListOptions = {}): Promise<Computer[]> {
    return (await this.listWithStatus(opts)).items;
  }

  /**
   * {@link list}, plus whether the platform could answer it in full.
   *
   * The only honest shape for `allowPartial`: the header saying an inventory is
   * short is the whole reason opting in is safe, and a method that dropped it
   * would turn "here is part of the fleet" into "here is the fleet".
   */
  async listWithStatus(opts: ListOptions = {}): Promise<Listing<Computer>> {
    const { items, incomplete } = await this.#t.listing(P.COMPUTERS, {
      query: { allow_partial: opts.allowPartial ? 1 : undefined },
      signal: opts.signal,
    });
    return {
      items: items.map((c) => oneComputer(this.#t, c, 'GET', P.COMPUTERS)),
      incomplete,
    };
  }

  async get(computerId: string, opts: CallOptions = {}): Promise<Computer> {
    const path = P.computer(computerId);
    const data = await this.#t.json('GET', path, { signal: opts.signal });
    return oneComputer(this.#t, data, 'GET', path);
  }

  /**
   * Provision a computer.
   *
   * Anything omitted falls back to the template's defaults. Sizing is capped by
   * the account's plan; exceeding a cap throws `PlanLimitError` naming the
   * limit.
   *
   * `size` is a named size from `client.sizes.list()` — a template and a
   * CPU/RAM/disk shape together, and the shapes the platform keeps pre-booted,
   * so naming one is the likeliest way to get a computer in about a second
   * rather than a cold boot. It cannot be combined with `template`, `cpu`,
   * `ramMb` or `diskGb`; sending both throws before any request is made.
   *
   * `resolution` is `"WIDTHxHEIGHT"` or `"WIDTHxHEIGHTxDEPTH"` and defaults to
   * `"1280x800x24"`. It is a create-time choice and **only** a create-time
   * choice: the screen is part of the machine QEMU builds, so changing it needs
   * a new one. Pick it deliberately if a model is going to drive this desktop —
   * computer-use accuracy is resolution-sensitive, and every coordinate the
   * model produces is in this space.
   *
   * Returns as soon as the API does — the machine is starting, not ready. Follow
   * with {@link Computer.waitForGuest}.
   *
   * A create that builds a computer which then will not boot is **not** an
   * error: it returns the computer, stopped, with {@link Computer.startError}
   * saying what went wrong. The machine exists and is billable either way, so it
   * comes back rather than being thrown away with the exception — check
   * `startError` if it matters, and `start()` may work on a second attempt.
   */
  async create(args: P.CreateArgs = {}, opts: CallOptions = {}): Promise<Computer> {
    const data = await this.#t.json('POST', P.COMPUTERS, {
      body: P.createBody(args),
      signal: opts.signal,
    });
    return oneComputer(this.#t, data, 'POST', P.COMPUTERS);
  }

  /**
   * Provision a computer that destroys itself when the block ends.
   *
   * {@link create} deliberately does not do this. Deleting a computer destroys
   * its disk, so tying that to a scope is only safe when the scope is
   * unambiguously the machine's whole lifetime — which is exactly what this
   * method declares and `create` does not.
   *
   * Two ways to say it. With a callback, which works everywhere:
   *
   * ```ts
   * await client.computers.ephemeral({ template: 'base' }, async (c) => {
   *   await c.waitForGuest();
   *   await c.open('https://example.com');
   * });
   * ```
   *
   * Or with `await using`, on a runtime with explicit resource management:
   *
   * ```ts
   * await using c = await client.computers.ephemeral({ template: 'base' });
   * await c.waitForGuest();
   * ```
   *
   * Cleanup runs even if the block throws. It does not run if the process is
   * killed — nothing in a language can promise that — so a long-lived fleet
   * wants the platform's idle suspend as the real backstop, not this.
   */
  async ephemeral(args?: P.CreateArgs, opts?: CallOptions): Promise<EphemeralComputer>;
  async ephemeral<T>(
    args: P.CreateArgs,
    fn: (computer: EphemeralComputer) => Promise<T>,
    opts?: CallOptions,
  ): Promise<T>;
  async ephemeral<T>(
    args: P.CreateArgs = {},
    fnOrOpts?: ((computer: EphemeralComputer) => Promise<T>) | CallOptions,
    rest: CallOptions = {},
  ): Promise<T | EphemeralComputer> {
    // The callback is optional and the options follow it, so the second
    // argument is whichever of the two the caller supplied.
    const fn = typeof fnOrOpts === 'function' ? fnOrOpts : undefined;
    const opts = typeof fnOrOpts === 'function' ? rest : (fnOrOpts ?? {});
    // Only the create carries the signal. Cancelling the cleanup delete would
    // leave a billable machine behind, which is the one thing this method
    // exists to prevent.
    const data = await this.#t.json('POST', P.COMPUTERS, {
      body: P.createBody(args),
      signal: opts.signal,
    });
    const computer = new EphemeralComputer(this.#t, computerRecord(data, 'POST', P.COMPUTERS));
    if (!fn) return computer;
    let result: T;
    try {
      result = await fn(computer);
    } catch (err) {
      // Swallowed, and only on this path. A cleanup failure must not replace
      // the error the block was already throwing — that hides the actual
      // fault behind a secondary one.
      await computer.delete().catch(() => {});
      throw err;
    }
    // On the success path there is no error to protect, and a swallowed
    // failure here is a billable machine leaking with nothing ever going to
    // mention it. Loud, and with the id, so a stranded machine can still be
    // found.
    try {
      await computer.delete();
    } catch (err) {
      // Except a 404, which is the goal state already reached: the block
      // deleted the machine itself — delete({ deleteSnapshots: true }) inside
      // the block is the documented way to purge snapshots — and a claim that
      // a provably-gone machine is still billable would be false, and would
      // replace the block's result with it.
      if (!(err instanceof NotFoundError)) {
        throw new MandalaError(
          `the block succeeded but ${computer.id} was not deleted and is still billable: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return result;
  }
}

export class Snapshots {
  #t: Transport;

  /** @internal */
  constructor(transport: Transport) {
    this.#t = transport;
  }

  /**
   * Snapshots on this account.
   *
   * `computerId` filters to one computer's. The filter **keeps unreachable
   * placeholders**, and that is not a nicety: a partial listing does not merely
   * omit rows, it appends one `{ id, unreachable: true }` stub per snapshot the
   * platform could not reach, with no `computerId` on it because there was no
   * host to say what it belongs to. Filtering on equality would delete precisely
   * the markers that say something is missing, and then report a confident count.
   *
   * `includeUnfinished` also returns deletions that began and did not finish.
   * They are not usable — nothing can be restored or cloned from one — but they
   * still hold objects and are still billed, so this is the flag for when the
   * question is about storage rather than about what can be restored.
   */
  async list(
    opts: ListOptions & { computerId?: string; includeUnfinished?: boolean } = {},
  ): Promise<Snapshot[]> {
    return (await this.listWithStatus(opts)).items;
  }

  /** {@link list}, plus whether the platform could answer it in full. */
  async listWithStatus(
    opts: ListOptions & { computerId?: string; includeUnfinished?: boolean } = {},
  ): Promise<Listing<Snapshot>> {
    const { items, incomplete } = await this.#t.listing(P.SNAPSHOTS, {
      query: {
        include: opts.includeUnfinished ? 'unfinished' : undefined,
        allow_partial: opts.allowPartial ? 1 : undefined,
      },
      signal: opts.signal,
    });
    const all = items.map(toSnapshot);
    const id = opts.computerId;
    return {
      items: id ? all.filter((s) => s.computerId === id || s.unreachable) : all,
      incomplete,
    };
  }

  /**
   * Roll a computer back to a snapshot, replacing its current disk.
   *
   * Refused on an orphaned snapshot — {@link clone} is what works there, because
   * a restore puts the disk back on a source that no longer exists.
   */
  async restore(snapshotId: string, opts: CallOptions = {}): Promise<void> {
    await this.#t.json('POST', P.snapshotAction(snapshotId, 'restore'), { signal: opts.signal });
  }

  /**
   * Create a new computer from a snapshot, leaving the original untouched.
   *
   * Cloning a memory snapshot forks it: the new machine resumes from the
   * captured RAM rather than booting, so it starts as a live twin of the
   * original — same hostname and network identity until it is re-identified.
   *
   * Returns as soon as the computer exists, which is before its disk does. A
   * snapshot has to be copied out — and one taken incrementally is collapsed out
   * of its whole chain — which runs for minutes, so the computer comes back
   * `"building"`. Until that lands there is nothing to boot and starting it
   * throws `ConflictError`; wait with {@link Computer.waitUntilBuilt}.
   */
  async clone(snapshotId: string, name?: string, opts: CallOptions = {}): Promise<Computer> {
    const path = P.snapshotAction(snapshotId, 'clone');
    const data = await this.#t.json('POST', path, {
      body: P.nameBody(name),
      signal: opts.signal,
    });
    return oneComputer(this.#t, data, 'POST', path);
  }

  /** Remove a snapshot permanently. Later snapshots in the same chain are unaffected. */
  async delete(snapshotId: string, opts: CallOptions = {}): Promise<void> {
    await this.#t.json('DELETE', P.snapshot(snapshotId), { signal: opts.signal });
  }

  /**
   * How long the automatic ones are kept — your plan's retention window.
   *
   * The other half of {@link Computer.setSchedule}, which decides when they are
   * TAKEN and deliberately has no field for how long they survive. Without this
   * a caller setting a daily schedule had to hardcode a number per plan tier or
   * infer one by watching `auto` snapshots disappear.
   *
   * On this collection rather than on a `Computer` because the window belongs to
   * the ACCOUNT — every computer you own is aged out on the same one, though
   * each keeps its own set, so two computers on `7/4/12` keep up to twenty-three
   * snapshots each rather than twenty-three between them.
   *
   * Read-only, and there is no write anywhere: the plan owns retention, so
   * setting it would be granting yourself history you have not paid for. It
   * changes when the subscription does. See {@link Retention} for what the three
   * numbers select.
   */
  async retention(opts: CallOptions = {}): Promise<Retention> {
    const data = await this.#t.json('GET', P.RETENTION, { signal: opts.signal });
    if (!P.isRecord(data))
      throw new MandalaError(`expected a retention window from GET ${P.RETENTION}`);
    return toRetention(data);
  }
}

export class Templates {
  #t: Transport;

  /** @internal */
  constructor(transport: Transport) {
    this.#t = transport;
  }

  /** The base images a computer can be created from. */
  async list(opts: CallOptions = {}): Promise<Template[]> {
    const data = await this.#t.jsonArray('GET', P.TEMPLATES, { signal: opts.signal });
    return data.filter(P.isRecord).map(toTemplate);
  }

  /**
   * The JSON Schema for a `mandala/v1` document.
   *
   * Returned rather than wrapped in a type, because it is a schema: what a
   * caller does with it is point an editor or a validator at it, and a shape of
   * our own over the top would be a second, worse description of the same
   * thing. Its `$id` is the URL it came from, so a `$ref` to it resolves.
   */
  async schema(opts: CallOptions = {}): Promise<Record<string, unknown>> {
    const data = await this.#t.json('GET', P.TEMPLATE_SCHEMA, { signal: opts.signal });
    if (!P.isRecord(data))
      throw new MandalaError(`expected a schema from GET ${P.TEMPLATE_SCHEMA}`);
    return data;
  }

  /**
   * Check a document without publishing it.
   *
   * Side-effect free and claims no ref, so it is safe on a draft and safe to
   * call repeatedly. Worth doing while iterating: a document that is wrong
   * comes back with EVERY problem at once, where {@link publish} reports the
   * first thing that stops it.
   *
   * Does not throw for an invalid document. That is not leniency — an invalid
   * document is the answer to the question this method asks, and the platform
   * says so with a 200. Read {@link TemplateCheck.valid}.
   *
   * The document goes as raw bytes, JSON or YAML, exactly as written. There is
   * no envelope to build and none to get wrong.
   */
  async validate(document: string, opts: CallOptions = {}): Promise<TemplateCheck> {
    const data = await this.#t.json('POST', P.TEMPLATE_VALIDATE, {
      raw: new TextEncoder().encode(P.templateDocument(document)),
      signal: opts.signal,
    });
    if (!P.isRecord(data)) {
      throw new MandalaError(`expected a check from POST ${P.TEMPLATE_VALIDATE}`);
    }
    return toTemplateCheck(data);
  }

  /**
   * Publish a document under a ref of your own, so a create can launch it by name.
   *
   * THE NAMESPACE IS YOUR ACCOUNT. `metadata.namespace` has to be your account
   * id — anything else is a 403, `system` included — and this SDK does not
   * rewrite it, because silently relocating somebody's document would publish a
   * ref that is not the one in the file they submitted.
   *
   * A REF IS IMMUTABLE. Publishing the identical document again succeeds and
   * changes nothing, so a pipeline that republishes on every commit is safe.
   * Publishing a DIFFERENT document under the same ref is a
   * {@link ConflictError}, and the fix is to bump `metadata.version`. What
   * counts as different is the digest, so a changed label is a change.
   *
   * A ref you have RETIRED stays spoken for and cannot be republished, identical
   * bytes included. See {@link retire}.
   */
  async publish(document: string, opts: CallOptions = {}): Promise<PublishedTemplate> {
    const data = await this.#t.json('POST', P.TEMPLATES, {
      raw: new TextEncoder().encode(P.templateDocument(document)),
      signal: opts.signal,
    });
    if (!P.isRecord(data)) throw new MandalaError(`expected a template from POST ${P.TEMPLATES}`);
    return toPublishedTemplate(data);
  }

  /**
   * Read one template back, as the document it was written as.
   *
   * Works for your own namespace and for `system`, so you can read what you are
   * layering onto. Another account's namespace is a {@link NotFoundError}, the
   * same answer a name that does not exist gets.
   *
   * Without `version` this is the newest published version of that name — which
   * is also what a create naming the unpinned `namespace/name` resolves to.
   * {@link PublishedTemplate.versions} lists the rest.
   *
   * A ref you retired is a {@link NotFoundError} whose message names the date it
   * went, rather than claiming the template never existed. Read the message
   * before concluding you mistyped something.
   */
  async get(
    namespace: string,
    name: string,
    opts: CallOptions & { version?: string } = {},
  ): Promise<PublishedTemplate> {
    const path = P.templateRef(namespace, name);
    const data = await this.#t.json('GET', path, {
      query: P.templateVersion(opts.version),
      signal: opts.signal,
    });
    if (!P.isRecord(data)) throw new MandalaError(`expected a template from GET ${path}`);
    return toPublishedTemplate(data);
  }

  /**
   * Retire a template you published, so it stops resolving and stops counting
   * against your ceiling.
   *
   * WITH `version` this retires that one version. WITHOUT it, this retires EVERY
   * version of the name — which is what "retire this template" means, and is
   * deliberately not {@link get}'s "the newest": a delete that quietly took the
   * latest one would let a loop walk backwards through a history it never asked
   * about. An empty string is refused here rather than sent, for the same
   * reason.
   *
   * COMPUTERS ARE NOT AFFECTED. A computer is built from the IMAGE the ref
   * resolved to and holds no reference to the document, so anything already
   * running, stopped or suspended is untouched. What a retire breaks is
   * resolution: a NEW create naming the ref is refused.
   *
   * THE REF IS STILL SPOKEN FOR, AND STILL COUNTS ONCE. Publishing it again
   * afterwards is a {@link ConflictError}, identical bytes included, and
   * {@link RetiredTemplates.refsClaimed} does not go down. Publish the next
   * version instead.
   */
  async retire(
    namespace: string,
    name: string,
    opts: CallOptions & { version?: string } = {},
  ): Promise<RetiredTemplates> {
    const path = P.templateRef(namespace, name);
    const data = await this.#t.json('DELETE', path, {
      query: P.templateVersion(opts.version),
      signal: opts.signal,
    });
    if (!P.isRecord(data)) throw new MandalaError(`expected a result from DELETE ${path}`);
    return toRetiredTemplates(data);
  }
}

/**
 * Compiling template documents into images.
 *
 * Its own collection rather than methods on {@link Templates}, because a build
 * is not a property of a published template: `POST /builds` takes a DOCUMENT,
 * not a ref, and the job it answers with outlives the request and is read back
 * by its own id. Publishing and building are separate acts with very different
 * costs, and the platform keeps them apart for that reason.
 */
export class Builds {
  #t: Transport;

  /** @internal */
  constructor(transport: Transport) {
    this.#t = transport;
  }

  /**
   * Compile a document into a golden image, and return immediately with a job.
   *
   * A build takes minutes — an agent image is roughly fifteen — so this never
   * blocks. {@link wait} is what watches one, {@link progress} is the poll and
   * {@link events} is the stream.
   *
   * THE NAMESPACE AND THE FAMILY BOTH HAVE TO BE YOURS, and either one is a
   * {@link PermissionDeniedError}. `spec.family` is what the built image is
   * CALLED on a hypervisor, in a directory shared with every computer on that
   * machine, so a build may only write into `golden-<your account id>` or that
   * and a `-` and a name of your choosing.
   *
   * A {@link ConflictError} means a hypervisor is busy — one build runs per host
   * at a time — rather than that anything is wrong with the document, and is
   * worth retrying.
   *
   * `noReuse` builds again even when an image already carries this document's
   * build digest. Identical documents normally share an image, which is what
   * makes a repeated build cheap.
   */
  async start(
    document: string,
    opts: CallOptions & { noReuse?: boolean } = {},
  ): Promise<TemplateBuild> {
    const data = await this.#t.json('POST', P.BUILDS, {
      raw: new TextEncoder().encode(P.templateDocument(document)),
      // Sent only when true. The platform reads the presence of `no_reuse`
      // rather than its value, so `no_reuse=false` would ask for the opposite of
      // what it says.
      query: opts.noReuse ? { no_reuse: 'true' } : {},
      signal: opts.signal,
    });
    if (!P.isRecord(data)) throw new MandalaError(`expected a build from POST ${P.BUILDS}`);
    return toTemplateBuild(data);
  }

  /**
   * Every build the fleet still holds a record of, newest first.
   *
   * A build lives on the hypervisor that ran it, so this is a fan-out — and it
   * does NOT fail closed the way the computer and snapshot listings do
   * (adversarial review, OPL-3835). There is no `allow_partial` to opt into and
   * no 503 to stop you: the platform answers a short list with a 200 and
   * `X-GC-Incomplete`, so the only thing that says a hypervisor was away is the
   * header. Read through the body alone, an outage looked like an account with
   * fewer builds.
   *
   * {@link listWithStatus} is where that shows. This returns the rows, like the
   * other two listings' `list`.
   */
  async list(opts: CallOptions = {}): Promise<TemplateBuild[]> {
    return (await this.listWithStatus(opts)).items;
  }

  /** {@link list}, plus whether the platform could answer it in full. */
  async listWithStatus(opts: CallOptions = {}): Promise<Listing<TemplateBuild>> {
    const { items, incomplete } = await this.#t.listing(P.BUILDS, { signal: opts.signal });
    return { items: items.map(toTemplateBuild), incomplete };
  }

  /** What became of one build. `error` says why a failed one failed. */
  async get(id: string, opts: CallOptions = {}): Promise<TemplateBuild> {
    const path = P.build(id);
    const data = await this.#t.json('GET', path, { signal: opts.signal });
    if (!P.isRecord(data)) throw new MandalaError(`expected a build from GET ${path}`);
    return toTemplateBuild(data);
  }

  /**
   * What a build is DOING, as against what became of it.
   *
   * The polling half; {@link events} is the same record as a stream. Use this
   * for anything that reconnects, restarts, or cannot hold a socket open. It
   * stays readable after the build has finished, so a program that was not
   * attached at the time can still see which step failed.
   */
  async progress(id: string, opts: CallOptions = {}): Promise<BuildProgress> {
    const path = P.buildAction(id, 'progress');
    const data = await this.#t.json('GET', path, { signal: opts.signal });
    if (!P.isRecord(data)) throw new MandalaError(`expected progress from GET ${path}`);
    return toBuildProgress(data);
  }

  /**
   * The same record as {@link progress}, as an event stream, for as long as the
   * build runs.
   *
   * Yields every `progress` and the final `done`. A `progress` is sent only when
   * something actually moved, so every one of them is news; the `done` is the
   * last event of a build that finished, INCLUDING one that failed — a failed
   * build is a `done` whose `status` says `failed`, not an `error` event.
   *
   * An `error` event means the STREAM could not go on and says nothing about the
   * build; it is thrown, because a caller who kept reading would be told nothing
   * more and a build they still care about needs {@link progress}. Attaching to
   * a build that has already finished is not an error — one `progress` and one
   * `done` arrive immediately.
   *
   * An account may hold eight of these open at once; the ninth is a
   * {@link RateLimitError}.
   */
  async *events(id: string, opts: CallOptions = {}): AsyncGenerator<BuildProgress> {
    const path = P.buildAction(id, 'events');
    let sawEvent = false;
    for await (const ev of this.#t.sse('GET', path, {
      signal: opts.signal,
    }) as AsyncGenerator<SSEEvent>) {
      if (ev.event === 'error') {
        // The stream's own failure, not the build's. Named as such, because a
        // caller told "the build failed" would go and read a document that is
        // fine.
        const detail = P.isRecord(ev.data) ? String(ev.data.error ?? '') : String(ev.data ?? '');
        throw new MandalaError(
          `the build event stream for ${id} ended: ${detail || 'no reason given'} ` +
            `(this says nothing about the build itself — read builds.progress(${JSON.stringify(id)}))`,
        );
      }
      if (ev.event !== 'progress' && ev.event !== 'done') continue;
      if (!P.isRecord(ev.data)) {
        // A `done` whose payload is not a record is the end of the stream with
        // the answer missing, and skipping it was worse than either half of that
        // (adversarial review, OPL-3835). The loop would keep waiting on a
        // connection the platform has finished with — `sse` deliberately has no
        // deadline — holding one of the account's eight slots until the socket
        // happens to close. A `progress` is different: it is news, not an
        // answer, so one that is malformed is skipped and the next one is read.
        if (ev.event === 'done') {
          throw new MandalaError(
            `the build event stream for ${id} ended with a malformed final event; ` +
              `read builds.progress(${JSON.stringify(id)}) for the outcome`,
          );
        }
        continue;
      }
      sawEvent = true;
      yield toBuildProgress(ev.data);
      if (ev.event === 'done') return;
    }
    // The stream ended without saying so. A generator that simply returns here
    // is indistinguishable from one that finished, so a caller looping over
    // these would report a build it stopped watching as a build that ended.
    throw new MandalaError(
      `the build event stream for ${id} ended without a final event` +
        (sawEvent ? '' : ', and sent nothing at all') +
        `; the build is probably still running — read builds.progress(${JSON.stringify(id)})`,
    );
  }

  /**
   * Wait for a build to stop running, and answer where it got to.
   *
   * Polls {@link progress} rather than holding the stream open, because a wait
   * is the case the stream is worst at: it reconnects badly, it is bounded to
   * eight per account, and a caller who only wants the outcome has no use for
   * the events in between.
   *
   * It does NOT throw for a build that failed. `succeeded` and `failed` are two
   * situations with two remedies — one has an image and the other has a step to
   * fix — and an exception flattens them into "something went wrong", which is
   * the mistake the move work established the rule about. Read `status`, and
   * `error`, and `steps` to see which step stopped it.
   *
   * Throws {@link TimeoutError} if the build is still going when the timeout
   * runs out. The build is not stopped by that; only the waiting is.
   *
   * The default timeout is generous because the work is: most of a build is
   * copying a multi-gigabyte base image before a single step of the document
   * runs, and an agent image is roughly fifteen minutes in total.
   */
  async wait(id: string, opts: WaitOptions = {}): Promise<BuildProgress> {
    const { timeoutMs = 1_800_000, pollMs = 5_000, signal } = opts;
    checkWait(timeoutMs, pollMs);
    const deadline = Date.now() + timeoutMs;
    let polled = false;
    let delayMs = pollMs;
    let last: BuildProgress | undefined;
    // Whether the MOST RECENT poll answered, as against whether any ever did.
    // Without it the timeout quotes a stale `last` and says the build "was still
    // running" — a claim about the present tense, made from an observation that
    // may be half an hour old and followed by nothing but failures.
    let observed = false;
    for (;;) {
      if (Date.now() >= deadline) {
        throw new TimeoutError(
          last && observed
            ? `build ${id} was still running after ${timeoutMs}ms (phase ${last.phase}, ` +
                `step ${last.step} of ${last.of}; the build has not stopped, only this wait has)`
            : last
              ? `build ${id} could not be reached for the last part of ${timeoutMs}ms; when it last ` +
                `answered it was in phase ${last.phase}, step ${last.step} of ${last.of}. The build ` +
                `has not stopped, only this wait has — read builds.progress for where it got to.`
              : `build ${id} could not be observed within ${timeoutMs}ms: every poll failed`,
        );
      }
      // The sleep comes before every poll but the first: a build that finished
      // while the caller was doing something else is one round trip from being
      // known to have finished.
      if (polled) await sleepUntilNextPoll(delayMs, deadline, signal);
      polled = true;
      delayMs = pollMs;
      if (Date.now() >= deadline) continue;
      try {
        const now = await this.progress(id, {
          signal: deadlineSignal(deadline - Date.now(), signal),
        });
        last = now;
        observed = true;
        // `done` and not a comparison against a list of statuses: the platform
        // derives it from the JOB rather than from the phase, and the phase is
        // read out of a log the document's own steps write into.
        if (now.done) return now;
      } catch (err) {
        observed = false;
        // waitForMove's policy, verbatim, and NOT the guest probe's (adversarial
        // review, OPL-3835). This SDK has two, for two different things: the
        // probe loop in waitForGuest retries everything but a handful of
        // permanent classes, because a booting guest agent legitimately answers
        // 409, 502 and 503 for its first seconds. This poll reads the CONTROL
        // PLANE, exactly as waitForMove does — so a 400, a malformed body or a
        // TLS failure is a defect, not a phase, and swallowing it burns the
        // whole half-hour default before saying anything.
        if (signal?.aborted) throw err;
        if (Date.now() < deadline && !isTransient(err)) throw err;
        delayMs = retryDelay(pollMs, err);
      }
    }
  }
}

/**
 * The moves on this account, live and recently finished.
 *
 * Its own collection because `GET /moves` is its own route, account-scoped
 * rather than hanging off a computer — which is the platform's decision and the
 * right one: a move is a fact about a computer that is currently on one host and
 * about to be on another, and during the window that matters that is exactly
 * what nobody can say.
 */
export class Moves {
  #t: Transport;

  /** @internal */
  constructor(transport: Transport) {
    this.#t = transport;
  }

  /**
   * Every move worth reading: the ones still running, and the ones that finished
   * within the last day and have not been dismissed.
   *
   * Two things to get from a listing rather than a per-computer read. A move you
   * started is found by its `computerId` — {@link Computer.waitForMove} does
   * exactly that. And a move you did NOT start is what the "another computer on
   * this account is being moved right now" refusal is about: one runs per
   * account at a time, and this is where you find out which and how far along.
   *
   * A finished move stays here for a day so that an outcome is still readable by
   * somebody who went away while it ran. Read `live`, not the row's absence.
   *
   * An API key issued against a workspace sees the moves of computers in that
   * workspace only.
   */
  async list(opts: CallOptions = {}): Promise<Move[]> {
    const data = await this.#t.json('GET', P.MOVES, { signal: opts.signal });
    const rows = P.isRecord(data) && Array.isArray(data.moves) ? data.moves : [];
    return rows.filter(P.isRecord).map(toMove);
  }
}

export class Sizes {
  #t: Transport;

  /** @internal */
  constructor(transport: Transport) {
    this.#t = transport;
  }

  /**
   * The named sizes a computer can be launched at.
   *
   * These are the shapes the platform keeps pre-booted, so a create naming one
   * is typically answered in about a second where a custom shape boots cold.
   */
  async list(opts: CallOptions = {}): Promise<Size[]> {
    const data = await this.#t.jsonArray('GET', P.SIZES, { signal: opts.signal });
    return data.filter(P.isRecord).map(toSize);
  }
}

/**
 * The window to read usage over.
 *
 * Both bounds accept a `Date`, which is the shape to prefer: `toISOString()` is
 * UTC by construction, so the timestamp cannot arrive without a zone. A string
 * is taken too and checked before it is sent — see `usageQuery` in paths.
 */
export type UsageOptions = { from?: Date | string; to?: Date | string; signal?: AbortSignal };

/**
 * What this account has used.
 *
 * Its own collection because `GET /usage` is its own route, account-scoped like
 * `GET /moves` rather than hanging off a computer — which it could not: the
 * figures include computers that have since been deleted, and those are exactly
 * the ones an unexplained line on an invoice belongs to.
 */
export class Usage {
  #t: Transport;

  /** @internal */
  constructor(transport: Transport) {
    this.#t = transport;
  }

  /**
   * Running hours weighted by cores and memory, the storage held, and the
   * per-computer breakdown behind the totals.
   *
   * The read to build a spend check around: a loop that launches computers is
   * the caller that can run up a bill without noticing, and this is the same
   * figure the dashboard shows the person who will ask about it.
   *
   * With no arguments the window is the account's current billing period, which
   * is what makes the numbers comparable with an invoice. Name `from`/`to` for a
   * window that has CLOSED — the billing period is always the current one, and
   * by the time an invoice arrives the period it covers is not.
   *
   * Check {@link UsageReport.degraded} and {@link UsageReport.unmetered} on the
   * way out. Each figure is a sum across the fleet, so a hypervisor that did not
   * answer leaves a total that is quietly short rather than an obviously missing
   * row, and those two flags are the only thing that says so.
   */
  async read(opts: UsageOptions = {}): Promise<UsageReport> {
    const data = await this.#t.json('GET', P.USAGE, {
      query: P.usageQuery(opts.from, opts.to),
      signal: opts.signal,
    });
    if (!P.isRecord(data)) throw new MandalaError(`expected a usage report from GET ${P.USAGE}`);
    return toUsageReport(data);
  }
}
