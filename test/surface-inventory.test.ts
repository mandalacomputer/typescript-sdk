/**
 * The derivation behind `surface.test.ts`'s completeness check.
 *
 * A derivation nobody tests is the same unfalsifiable guarantee one layer down:
 * the check next door says every public request-making method is named in the
 * exercise, and a scan that quietly decided a method does not make requests
 * would make that sentence true by shrinking what it is about.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Client, Computer, Computers, EphemeralComputer } from '../src/index.js';
import { anyRoute, BASE, recorder } from './harness.js';
import {
  type Ctor,
  inventory,
  keyOf,
  names,
  readTypeScriptFiles,
  recordNamedCalls,
  requestingMethods,
} from './surface-inventory.js';

/** One made-up module, scanned the way `src` is. */
const scan = (...sources: string[]): Map<string, Set<string>> =>
  requestingMethods(sources.map((source, n) => ({ name: `fake-${n}.ts`, source })));

const sorted = (found: Map<string, Set<string>>, cls: string): string[] =>
  [...(found.get(cls) ?? [])].sort();

describe('the request-making rule', () => {
  it('counts a method that reaches the transport itself', () => {
    expect(sorted(scan(`class A { async go() { await this.#t.json('GET', 'x'); } }`), 'A')).toEqual(
      ['go'],
    );
  });

  it('follows a chain of private helpers to the end', () => {
    const found = scan(`class A {
      async click() { return this.#input('click'); }
      #input(kind) { return this.#send(kind); }
      #send(kind) { return this.#t.json('POST', 'input', { body: { kind } }); }
    }`);
    // The public method only, and only because the chain below it arrives.
    expect(sorted(found, 'A')).toEqual(['click']);
  });

  it('follows a private function field used by a prototype method', () => {
    const found = scan(`class A {
      async go() { return this.#request(); }
      #request = () => this.#t.json('GET', 'x');
    }`);
    expect(sorted(found, 'A')).toEqual(['go']);
  });

  it('refuses a public request-making instance field that cannot be recorded', () => {
    expect(() => scan(`class A { go = async () => this.#t.json('GET', 'x'); }`)).toThrow(
      /A\.go in fake-0\.ts is a public request-making instance field; declare it as a prototype method/,
    );
  });

  it('settles on mutually recursive helpers rather than spinning', () => {
    const found = scan(`class A {
      async go() { return this.#ping(); }
      #ping() { return this.#pong(); }
      #pong() { return this.#ping(); }
    }`);
    expect(found.has('A')).toBe(false);
  });

  it('leaves out a class that never reaches the wire', () => {
    // Not an empty set: a model or an exception is not a surface with nothing
    // on it, it is not this kind of thing at all.
    expect(scan(`class A { get id() { return this.data.id; } }`).has('A')).toBe(false);
  });

  it('leaves out private and static members', () => {
    const found = scan(`class A {
      async go() { return this.#t.json('GET', 'x'); }
      async #hidden() { return this.#t.json('GET', 'y'); }
      static async from(t) { return t.json('GET', 'z'); }
    }`);
    expect(sorted(found, 'A')).toEqual(['go']);
  });

  it('does not mistake a verb-shaped property of something else for the transport', () => {
    // `json` is a transport verb and `this.response.json()` is not the
    // transport. Keyed off the private field, so the near-miss reads as what it
    // is rather than as a request.
    expect(scan(`class A { async go() { return this.response.json(); } }`).has('A')).toBe(false);
  });

  it('refuses a transport member that is in neither table', () => {
    expect(() => scan(`class A { async go() { return this.#t.stream('GET', 'x'); } }`)).toThrow(
      /unclassified transport member in A\.go: this\.#t\.stream/,
    );
  });

  it('refuses request verbs on an unrecognized private transport field', () => {
    expect(() =>
      scan(`class A {
        #transport: Transport;
        async go() { return this.#transport.json('GET', 'x'); }
      }`),
    ).toThrow(/unrecognized Transport field A\.#transport; store Transport on this\.#t/);
    expect(() => scan(`class A { async go() { return this.#other.json('GET', 'x'); } }`)).toThrow(
      /unrecognized transport receiver in A\.go: this\.#other/,
    );
  });

  it('refuses the transport field through an aliased receiver', () => {
    expect(() =>
      scan(`class A {
        async go() { const self = this; return self.#t.json('GET', 'x'); }
      }`),
    ).toThrow(/indirect transport receiver in A\.go: self\.#t/);
  });

  it('refuses Transport parameter properties under another name', () => {
    expect(() => scan(`class A { constructor(readonly transport: Transport) {} }`)).toThrow(
      /unrecognized Transport parameter property transport in A/,
    );
  });

  it('refuses aliased or destructured transport access', () => {
    for (const statement of [`const t = this.#t`, `const { json } = this.#t`]) {
      expect(() => scan(`class A { async go() { ${statement}; } }`)).toThrow(
        /indirect transport access in A\.go: this\.#t must be used directly/,
      );
    }
  });

  it('counts every transport handoff conservatively', () => {
    expect(sorted(scan(`class A { make(data) { return consume(this.#t, data); } }`), 'A')).toEqual([
      'make',
    ]);
  });

  it('does not count a transport member that makes no request', () => {
    expect(scan(`class A { get where() { return this.#t.baseUrl; } }`).has('A')).toBe(false);
  });

  it('reads a method through its implementation rather than its overloads', () => {
    const found = scan(`class A {
      async go(id: string): Promise<void>;
      async go(id: string, extra: number): Promise<void>;
      async go(id: string, extra?: number) { await this.#t.json('GET', id); }
    }`);
    expect(sorted(found, 'A')).toEqual(['go']);
  });

  it('refuses same-named classes in independently scoped modules', () => {
    expect(() =>
      scan(
        `class A { async go() { await this.#t.json('GET', 'x'); } }`,
        `class A { get id() { return this.data.id; } }`,
      ),
    ).toThrow(/duplicate class name A in fake-0\.ts and fake-1\.ts/);
  });

  it('refuses class forms whose exported identity cannot be derived', () => {
    expect(() =>
      scan(`export const Jobs = class {
        async list() { return this.#t.json('GET', 'jobs'); }
      }`),
    ).toThrow(/unsupported class expression in fake-0\.ts/);
    expect(() => scan(`export default class {}`)).toThrow(
      /unsupported anonymous class declaration in fake-0\.ts/,
    );
  });

  it('refuses base classes that are not plain identifiers', () => {
    for (const base of ['resources.Computer', 'computerBase()']) {
      expect(() => scan(`class A extends ${base} { async go() { return super.go(); } }`)).toThrow(
        `unsupported base class for A in fake-0.ts: ${base}`,
      );
    }
  });

  it('refuses an identifier base when a method depends on resolving it', () => {
    expect(() => scan(`class A extends External { async go() { return super.go(); } }`)).toThrow(
      /unresolved base class External while tracing A in fake-0\.ts/,
    );
  });

  it('follows an inherited method reached through this or super', () => {
    // EphemeralComputer's disposer reaches the wire only through Computer's
    // `delete`. A scan that looked at one class body at a time would call the
    // one method whose failure strands a billable machine non-requesting.
    const found = scan(
      `class Base { async delete() { await this.#t.json('DELETE', 'x'); } }`,
      `class ViaThis extends Base { async dispose() { await this.delete(); } }`,
      `class ViaSuper extends Base {
        async delete() {}
        async dispose() { await super.delete(); }
      }`,
    );
    expect(sorted(found, 'Base')).toEqual(['delete']);
    // Its own declarations only: an inherited method is one function, and
    // exercising it once under the class that declares it is the coverage.
    expect(sorted(found, 'ViaThis')).toEqual(['dispose']);
    // The override itself does not request. `super.delete()` must resolve the
    // inherited body, not be mistaken for the non-requesting `this.delete`.
    expect(sorted(found, 'ViaSuper')).toEqual(['dispose']);
  });

  it('counts a helper named rather than called', () => {
    // A helper handed off as a callback reaches the wire exactly as much as one
    // called on the spot.
    const found = scan(`class A {
      async all(ids) { return Promise.all(ids.map(this.#one)); }
      #one(id) { return this.#t.json('GET', id); }
    }`);
    expect(sorted(found, 'A')).toEqual(['all']);
  });

  it('normalizes literal element access and rejects dynamic keys', () => {
    const found = scan(`class A {
      async go() { return this['send'](); }
      async send() { return this.#t.json('GET', 'x'); }
    }`);
    expect(sorted(found, 'A')).toEqual(['go', 'send']);
    expect(() => scan(`class A { go(key) { return this[key](); } }`)).toThrow(
      /unsupported computed member access in A\.go: \[key\]/,
    );
  });

  it('refuses a public request-making accessor that cannot be recorded', () => {
    expect(() => scan(`class A { get status() { return this.#t.json('GET', 'x'); } }`)).toThrow(
      /A\.status in fake-0\.ts is a public request-making accessor; declare it as a prototype method/,
    );
  });
});

describe('source discovery', () => {
  it('reads TypeScript files in nested directories', () => {
    const root = mkdtempSync(join(tmpdir(), 'surface-inventory-'));
    try {
      mkdirSync(join(root, 'resources', 'nested'), { recursive: true });
      writeFileSync(join(root, 'top.ts'), `class Top {}`);
      writeFileSync(join(root, 'resources', 'nested', 'deep.ts'), `class Deep {}`);
      writeFileSync(join(root, 'resources', 'ignored.js'), `class Ignored {}`);

      expect(readTypeScriptFiles(root).map(({ name }) => name)).toEqual([
        'resources/nested/deep.ts',
        'top.ts',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the inventory of this SDK', () => {
  const surface = inventory();

  it('finds the methods the route check cannot see', () => {
    // Named individually rather than left to a count: every one of these shares
    // a route with a method that WAS exercised, which is how they went missing.
    for (const method of [
      'Computer.agent',
      'Computer.agentStream',
      'Computer.open',
      'Computer.readTextFile',
      'Computer.waitForGuest',
      'Computer.waitForMove',
      'Computer.waitUntilBuilt',
      'Computer.waitUntilRunning',
      'Computers.ephemeral',
      'Computers.listWithStatus',
      'Snapshots.listWithStatus',
      'Builds.listWithStatus',
      'Builds.wait',
      'EphemeralComputer.[Symbol.asyncDispose]',
    ]) {
      expect(names(surface)).toContain(method);
    }
  });

  it('holds nothing that is not on the wire', () => {
    // The client itself makes no request — it hands its transport to the
    // resources and holds a `baseUrl` — so it is not a surface with nothing on
    // it either.
    expect([...surface].map(([cls]) => cls.name)).not.toContain('Client');
    expect(names(surface)).not.toContain('Computer.resolution');
  });

  it('addresses every method it names', () => {
    for (const [cls, methods] of surface) {
      for (const declared of methods) {
        const value = (cls.prototype as Record<string | symbol, unknown>)[keyOf(declared)];
        expect(typeof value, `${cls.name}.${declared}`).toBe('function');
      }
    }
  });
});

describe('keyOf', () => {
  it('passes an ordinary name through', () => {
    expect(keyOf('screenshot')).toBe('screenshot');
  });

  it('resolves a well-known symbol', () => {
    expect(keyOf('[Symbol.asyncDispose]')).toBe(Symbol.asyncDispose);
  });

  it('refuses a computed name it cannot address', () => {
    // Rather than dropping it: a method the recorder cannot reach is a method
    // the completeness check would silently stop making a claim about.
    expect(() => keyOf('[Symbol.notARealWellKnownSymbol]')).toThrow(/not a well-known symbol/);
  });
});

describe('recording direct calls', () => {
  const client = (): Client =>
    new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: recorder(anyRoute).fetch });

  const justComputer: ReadonlyMap<Ctor, ReadonlySet<string>> = new Map([
    [Computer as unknown as Ctor, new Set(['exec', 'open', 'agent', 'agentStream'])],
  ]);

  it('counts a call the exercise makes itself', async () => {
    const c = await client().computers.get('vm-1');
    async function exercise(): Promise<void> {
      await c.exec('true');
    }
    expect([...(await recordNamedCalls(justComputer, [exercise], exercise))]).toEqual([
      'Computer.exec',
    ]);
  });

  it('does not count a call one SDK method makes to another', async () => {
    // `open` is sugar over `exec` and `agent` drives `agentStream`. Counting
    // those would let a method be covered by whichever neighbour happens to
    // delegate to it — the same borrowed coverage as sharing a route, one level
    // down.
    const c = await client().computers.get('vm-1');
    async function exercise(): Promise<void> {
      await c.open('https://example.com');
      await c.agent({ prompt: 'go', modelKey: 'sk-test' });
    }
    const named = await recordNamedCalls(justComputer, [exercise], exercise);
    expect([...named].sort()).toEqual(['Computer.agent', 'Computer.open']);
  });

  it('does not count a call from a function that is not an exercise', async () => {
    const c = await client().computers.get('vm-1');
    async function elsewhere(): Promise<void> {
      await c.exec('true');
    }
    async function exercise(): Promise<void> {
      await elsewhere();
    }
    expect([...(await recordNamedCalls(justComputer, [exercise], exercise))]).toEqual([]);
  });

  it('puts every method back, including when the exercise throws', async () => {
    const before = Computer.prototype.exec;
    async function exercise(): Promise<void> {
      throw new Error('the exercise failed');
    }
    await expect(recordNamedCalls(justComputer, [exercise], exercise)).rejects.toThrow(
      'the exercise failed',
    );
    expect(Computer.prototype.exec).toBe(before);
  });

  it('refuses callers a stack frame could not tell apart', async () => {
    // An anonymous exercise would match every anonymous frame in the process.
    await expect(
      recordNamedCalls(
        justComputer,
        [Object.defineProperty(async () => {}, 'name', { value: '' })],
        async () => {},
      ),
    ).rejects.toThrow(/distinct, non-empty name/);
  });

  it('refuses a method the class does not declare itself', async () => {
    // `delete` is Computer's, not EphemeralComputer's. Rebinding an inherited
    // method onto a subclass would leave the class permanently different from
    // how it was found, so it fails here instead.
    const inherited: ReadonlyMap<Ctor, ReadonlySet<string>> = new Map([
      [EphemeralComputer as unknown as Ctor, new Set(['delete'])],
    ]);
    await expect(
      recordNamedCalls(inherited, [async function exercise() {}], async () => {}),
    ).rejects.toThrow(/EphemeralComputer\.delete is not an own method/);
    expect(Object.getOwnPropertyDescriptor(EphemeralComputer.prototype, 'delete')).toBeUndefined();
  });

  it('leaves the prototype indistinguishable from how it found it', async () => {
    const before = Object.getOwnPropertyDescriptor(Computers.prototype, 'list');
    async function exercise(): Promise<void> {}
    await recordNamedCalls(
      new Map([[Computers as unknown as Ctor, new Set(['list'])]]),
      [exercise],
      exercise,
    );
    expect(Object.getOwnPropertyDescriptor(Computers.prototype, 'list')).toEqual(before);
  });
});
