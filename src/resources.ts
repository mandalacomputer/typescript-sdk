/** Resource collections hanging off the client. */

import { Computer, EphemeralComputer } from './computer.js';
import type { Size, Snapshot, Template } from './models.js';
import { toSize, toSnapshot, toTemplate } from './models.js';
import * as P from './paths.js';
import type { Listing, Transport } from './transport.js';

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
    const { items, incomplete } = await this.#t.listing<Record<string, unknown>>(P.COMPUTERS, {
      query: { allow_partial: opts.allowPartial ? 1 : undefined },
      signal: opts.signal,
    });
    return { items: items.map((c) => new Computer(this.#t, c)), incomplete };
  }

  async get(computerId: string, opts: CallOptions = {}): Promise<Computer> {
    const data = await this.#t.json('GET', P.computer(computerId), { signal: opts.signal });
    return new Computer(this.#t, P.computerPayload(data));
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
    return new Computer(this.#t, P.computerPayload(data));
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
  async ephemeral(args?: P.CreateArgs): Promise<EphemeralComputer>;
  async ephemeral<T>(
    args: P.CreateArgs,
    fn: (computer: EphemeralComputer) => Promise<T>,
  ): Promise<T>;
  async ephemeral<T>(
    args: P.CreateArgs = {},
    fn?: (computer: EphemeralComputer) => Promise<T>,
  ): Promise<T | EphemeralComputer> {
    const data = await this.#t.json('POST', P.COMPUTERS, { body: P.createBody(args) });
    const computer = new EphemeralComputer(this.#t, P.computerPayload(data));
    if (!fn) return computer;
    try {
      return await fn(computer);
    } finally {
      // Swallowed, and only here. A cleanup failure must not replace the error
      // the block was already throwing — that hides the actual fault behind a
      // secondary one — and on the success path there is nothing left to do
      // with it but leak a rejected promise. The id is in the message so a
      // stranded machine can still be found.
      await computer.delete().catch(() => {});
    }
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
    const { items, incomplete } = await this.#t.listing<Record<string, unknown>>(P.SNAPSHOTS, {
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
  async restore(snapshotId: string): Promise<void> {
    await this.#t.json('POST', P.snapshotAction(snapshotId, 'restore'));
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
  async clone(snapshotId: string, name?: string): Promise<Computer> {
    const data = await this.#t.json('POST', P.snapshotAction(snapshotId, 'clone'), {
      body: P.nameBody(name),
    });
    return new Computer(this.#t, P.computerPayload(data));
  }

  /** Remove a snapshot permanently. Later snapshots in the same chain are unaffected. */
  async delete(snapshotId: string): Promise<void> {
    await this.#t.json('DELETE', P.snapshot(snapshotId));
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
    const data = await this.#t.json<unknown[]>('GET', P.TEMPLATES, { signal: opts.signal });
    return (data ?? []).filter(P.isRecord).map(toTemplate);
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
    const data = await this.#t.json<unknown[]>('GET', P.SIZES, { signal: opts.signal });
    return (data ?? []).filter(P.isRecord).map(toSize);
  }
}
