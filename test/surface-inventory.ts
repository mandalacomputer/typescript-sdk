/**
 * The SDK's own public request-making surface, read off its source.
 *
 * The rest of `surface.test.ts` compares this SDK to the platform: every call
 * lands on an allowlisted route, every documented parameter is sent or pinned.
 * This module answers the question those cannot, which points the other way —
 * is every method the SDK offers actually driven by the exercise at all?
 *
 * The completeness check next door counts ROUTES (OPL-3911):
 *
 * ```ts
 * const unreached = [...ALLOWED].filter((r) => !called.has(r));
 * expect(unreached).toEqual([...UNIMPLEMENTED]);
 * ```
 *
 * which proves every route was reached by SOMETHING. That is a different claim
 * from "every method was called" the moment two methods share a route, and on
 * this surface most of them do: `exec`, `open` and `waitForGuest` are all
 * `POST computers/:id/exec`; `agent`, `agentOnce` and `agentStream` are all
 * `POST computers/:id/agent`; every mouse and keyboard call is
 * `POST computers/:id/input`. Add a second method to one of those routes,
 * forget to add it to the exercise, and nothing goes red — the route was
 * already reached by its neighbour. Thirteen methods had gone that way by the
 * time this was written, and every other test in `surface.test.ts` stayed green
 * through all thirteen.
 *
 * **Derived, not maintained.** A hand-written list of public methods is a second
 * place to forget the method, one step further back — the same failure with an
 * extra hop. So the inventory is read out of the source: a public method is
 * request-making when its body reaches `this.#t.<verb>`, directly or through
 * the helpers it calls. That is the whole of how this SDK talks to the wire —
 * {@link Transport} is reached one way, through one private field, from every
 * resource and both computer classes — so the rule has no holes to fall
 * through, and a method added tomorrow is in the inventory the moment it is
 * written rather than when somebody remembers it.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import * as sdk from '../src/index.js';

/**
 * The private field every resource and both computer classes hold their
 * transport on.
 *
 * One name, checked literally: a class that reached the wire some other way
 * would be invisible here, so the narrow rule is deliberate — it is the
 * convention this SDK actually follows, and a second spelling should fail this
 * check rather than be quietly accommodated by a looser one.
 */
const TRANSPORT = '#t';

/**
 * Every method on {@link Transport} that puts a request on the wire.
 *
 * `json` is the plain one; the rest are the shaping wrappers around the same
 * `#fetchRaw` — an array, a listing with its short-answer header, raw bytes or
 * a byte range, and a stream of frames.
 */
const VERBS: ReadonlySet<string> = new Set(['json', 'jsonArray', 'listing', 'bytes', 'sse']);

/**
 * Public transport members that deliberately do not put a request on the wire.
 *
 * Together with {@link VERBS} this makes the classification exhaustive: adding
 * a second request wrapper — or any other transport spelling — must be
 * classified here rather than silently disappearing from the inventory.
 */
const NON_REQUEST_TRANSPORT: ReadonlySet<string> = new Set(['baseUrl']);

/** A class as this module addresses one: by name, and by its prototype. */
export type Ctor = { readonly name: string; readonly prototype: object };

/** Public request-making methods, by the class that declares them. */
export type Inventory = ReadonlyMap<Ctor, ReadonlySet<string>>;

/**
 * What one method body touches: the transport, and methods reached through
 * `this` or `super`.
 *
 * All are collected in one pass because the latter two make the first
 * complete. `Computer.click` never names the transport — it calls `this.#input`,
 * which does — and a rule that only looked for the direct touch would call the
 * entire input surface non-requesting.
 */
type Reaches = {
  /** The class whose member owns this body. */
  owner: string;
  transport: boolean;
  /** Members reached through `this`. */
  siblings: Set<string>;
  /** Members reached through `super`. */
  inherited: Set<string>;
};

type ClassInfo = {
  /** Every member with a body, by its declared name. */
  bodies: Map<string, Reaches>;
  /** The name in `extends`, when it is a plain identifier. */
  base?: string;
  /** Getters and setters, which the prototype recorder cannot wrap as methods. */
  accessors: Set<string>;
  /** Function-valued fields installed on instances rather than the prototype. */
  instanceFields: Set<string>;
  /** Declared names that are addressable public API, in declaration order. */
  publicNames: string[];
};

/**
 * A member's name exactly as it is written.
 *
 * A private field keeps its `#`, and a computed name keeps its brackets —
 * `[Symbol.asyncDispose]` — because that is what tells the two kinds apart
 * later, and because a member this module could not name is one it must not
 * silently drop.
 */
function literalPropertyName(node: ts.Node): string | undefined {
  if (
    ts.isStringLiteral(node) ||
    ts.isNumericLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node)
  ) {
    return node.text;
  }
  return undefined;
}

const nameText = (name: ts.PropertyName, source: ts.SourceFile): string => {
  const literal = literalPropertyName(name);
  if (literal !== undefined) return literal;
  if (ts.isComputedPropertyName(name)) {
    const computed = literalPropertyName(name.expression);
    if (computed !== undefined) return computed;
    const expression = name.expression.getText(source);
    if (/^Symbol\.[A-Za-z]+$/.test(expression)) return `[${expression}]`;
    throw new Error(`unsupported computed member name ${name.getText(source)}`);
  }
  return name.getText(source);
};

/** Whether a declared type contains the SDK's transport type by its canonical name. */
function containsTransportType(type: ts.TypeNode | undefined, source: ts.SourceFile): boolean {
  if (!type) return false;
  let found = false;
  const visit = (node: ts.Node): void => {
    if (ts.isTypeReferenceNode(node)) {
      const name = node.typeName.getText(source);
      if (name === 'Transport' || name.endsWith('.Transport')) found = true;
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(type);
  return found;
}

/** Whether a member is reachable by a caller holding an instance. */
function isPublic(member: ts.ClassElement, name: string): boolean {
  if (name.startsWith('#')) return false;
  const flags = ts.getCombinedModifierFlags(member as ts.Declaration);
  if (flags & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected | ts.ModifierFlags.Static)) {
    return false;
  }
  return true;
}

/** The body of a member, when it has one that can make a request. */
function bodyOf(member: ts.ClassElement): ts.Node | undefined {
  if (ts.isMethodDeclaration(member) || ts.isGetAccessor(member) || ts.isSetAccessor(member)) {
    return member.body;
  }
  // Function fields still need reading: a private one can be the helper through
  // which an ordinary prototype method reaches the transport. Public
  // request-making ones are rejected below because the recorder cannot wrap an
  // instance field through the prototype.
  if (ts.isPropertyDeclaration(member) && member.initializer) {
    const init = member.initializer;
    if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return init.body;
  }
  return undefined;
}

/**
 * Read one file's classes.
 *
 * Throws on a transport member that is in neither table, which is the point of
 * having two: a request wrapper added to {@link Transport} and not classified
 * here would make every method that used it look like it never touched the
 * wire, and the inventory would quietly shrink rather than fail.
 */
function scanFile(fileName: string, source: string): Map<string, ClassInfo> {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const found = new Map<string, ClassInfo>();

  const walk = (node: ts.Node): void => {
    if (ts.isClassExpression(node)) {
      throw new Error(
        `unsupported class expression in ${fileName}; declare a named class declaration`,
      );
    }
    if (ts.isClassDeclaration(node)) {
      if (!node.name) {
        throw new Error(
          `unsupported anonymous class declaration in ${fileName}; give the class a name`,
        );
      }
      const info: ClassInfo = {
        accessors: new Set(),
        bodies: new Map(),
        instanceFields: new Set(),
        publicNames: [],
      };
      const extendsClause = node.heritageClauses?.find(
        (clause) => clause.token === ts.SyntaxKind.ExtendsKeyword,
      );
      if (extendsClause) {
        const heritage = extendsClause.types[0]?.expression;
        if (!heritage || !ts.isIdentifier(heritage)) {
          const base = heritage?.getText(file) ?? extendsClause.getText(file);
          throw new Error(`unsupported base class for ${node.name.text} in ${fileName}: ${base}`);
        }
        info.base = heritage.text;
      }

      for (const member of node.members) {
        if (ts.isConstructorDeclaration(member)) {
          for (const parameter of member.parameters) {
            const parameterProperty = parameter.modifiers?.some((modifier) =>
              [
                ts.SyntaxKind.PublicKeyword,
                ts.SyntaxKind.ProtectedKeyword,
                ts.SyntaxKind.PrivateKeyword,
                ts.SyntaxKind.ReadonlyKeyword,
              ].includes(modifier.kind),
            );
            if (parameterProperty && containsTransportType(parameter.type, file)) {
              throw new Error(
                `unrecognized Transport parameter property ${parameter.name.getText(file)} ` +
                  `in ${node.name.text}; store Transport on this.${TRANSPORT}`,
              );
            }
          }
          continue;
        }
        if (!member.name) continue;
        const name = nameText(member.name, file);
        if (
          ts.isPropertyDeclaration(member) &&
          name !== TRANSPORT &&
          containsTransportType(member.type, file)
        ) {
          throw new Error(
            `unrecognized Transport field ${node.name.text}.${name}; ` +
              `store Transport on this.${TRANSPORT}`,
          );
        }
        const body = bodyOf(member);
        if (!body) continue;
        // Overloads share a name with their implementation, and only the
        // implementation has a body, so this merge is for a class that genuinely
        // declares the same name twice rather than for the common case.
        const reaches = info.bodies.get(name) ?? {
          owner: node.name.text,
          transport: false,
          siblings: new Set(),
          inherited: new Set(),
        };
        readBody(body, file, `${node.name.text}.${name}`, reaches);
        info.bodies.set(name, reaches);
        if (ts.isGetAccessor(member) || ts.isSetAccessor(member)) info.accessors.add(name);
        if (ts.isPropertyDeclaration(member)) info.instanceFields.add(name);
        if (isPublic(member, name) && !info.publicNames.includes(name)) info.publicNames.push(name);
      }
      if (found.has(node.name.text)) {
        throw new Error(`duplicate class name ${node.name.text} in ${fileName}`);
      }
      found.set(node.name.text, info);
    }
    ts.forEachChild(node, walk);
  };
  walk(file);
  return found;
}

/** Fill in one member's {@link Reaches} from its body. */
function readBody(body: ts.Node, file: ts.SourceFile, where: string, into: Reaches): void {
  const isPrivateField = (node: ts.Node): node is ts.PropertyAccessExpression =>
    ts.isPropertyAccessExpression(node) && ts.isPrivateIdentifier(node.name);
  const isTransport = (node: ts.Node): node is ts.PropertyAccessExpression =>
    isPrivateField(node) &&
    node.expression.kind === ts.SyntaxKind.ThisKeyword &&
    node.name.text === TRANSPORT;

  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node)) {
      const inner = node.expression;
      if (
        isPrivateField(node) &&
        node.name.text === TRANSPORT &&
        node.expression.kind !== ts.SyntaxKind.ThisKeyword
      ) {
        throw new Error(
          `indirect transport receiver in ${where}: ${node.getText(file)}; ` +
            `access the transport as this.${TRANSPORT}`,
        );
      }
      if (
        isPrivateField(inner) &&
        inner.name.text !== TRANSPORT &&
        VERBS.has(node.name.getText(file))
      ) {
        throw new Error(
          `unrecognized transport receiver in ${where}: ${inner.getText(file)}; ` +
            `store Transport on this.${TRANSPORT}`,
        );
      }
      const onTransport = isTransport(inner);
      if (onTransport) {
        const member = node.name.getText(file);
        if (VERBS.has(member)) into.transport = true;
        else if (!NON_REQUEST_TRANSPORT.has(member)) {
          throw new Error(
            `unclassified transport member in ${where}: this.${TRANSPORT}.${member}. ` +
              'Add it to VERBS or NON_REQUEST_TRANSPORT in test/surface-inventory.ts.',
          );
        }
      }
      if (isTransport(node)) {
        const parent = node.parent;
        const directMember = ts.isPropertyAccessExpression(parent) && parent.expression === node;
        const transportHandoff =
          (ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
          parent.arguments?.includes(node) === true;
        if (transportHandoff) {
          // The callee's identity cannot be proven from syntax alone. Counting
          // every handoff is conservative and prevents a same-named helper from
          // hiding a request by masquerading as a known non-request consumer.
          into.transport = true;
        } else if (!directMember) {
          throw new Error(
            `indirect transport access in ${where}: this.${TRANSPORT} must be used directly ` +
              'by a classified member or as a call argument',
          );
        }
      }
      // Any mention of a sibling, not only a call of one. A helper handed off as
      // a callback reaches the wire exactly as much as one that is called on the
      // spot, and this side of the rule can only be too generous — a name that
      // is not a method of this class matches nothing.
      if (node.expression.kind === ts.SyntaxKind.ThisKeyword) {
        into.siblings.add(node.name.getText(file));
      } else if (node.expression.kind === ts.SyntaxKind.SuperKeyword) {
        // Kept separate from `this`: a subclass override changes the first
        // one's target, while `super` deliberately starts lookup at the base.
        into.inherited.add(node.name.getText(file));
      }
    }
    // `this[Symbol.asyncDispose]()`, and anything else keyed rather than named.
    if (
      ts.isElementAccessExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ThisKeyword ||
        node.expression.kind === ts.SyntaxKind.SuperKeyword)
    ) {
      const literal = literalPropertyName(node.argumentExpression);
      const expression = node.argumentExpression.getText(file);
      const member =
        literal ?? (/^Symbol\.[A-Za-z]+$/.test(expression) ? `[${expression}]` : undefined);
      if (member === undefined) {
        throw new Error(`unsupported computed member access in ${where}: [${expression}]`);
      }
      if (node.expression.kind === ts.SyntaxKind.ThisKeyword) into.siblings.add(member);
      else into.inherited.add(member);
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
}

/**
 * Public request-making methods in some source files, by the class declaring
 * them.
 *
 * A method is request-making when its body reaches the transport, or names
 * something on `this` or `super` that does — closed over transitively, so a
 * chain of private helpers is followed to the end, and through `extends`, so a
 * subclass method that reaches the wire only through an inherited one is still counted.
 * An inherited entry point is also counted on the first subclass whose virtual
 * dispatch turns its otherwise non-requesting body into a request-making one.
 *
 * Classes with none are left out entirely rather than mapped to an empty set: a
 * model or an exception is not a surface with nothing on it, it is not this kind
 * of thing at all.
 */
export function requestingMethods(
  files: Iterable<{ name: string; source: string }>,
): Map<string, Set<string>> {
  const classes = new Map<string, ClassInfo>();
  const declaredIn = new Map<string, string>();
  for (const { name, source } of files) {
    for (const [className, info] of scanFile(name, source)) {
      const previous = declaredIn.get(className);
      if (previous !== undefined) {
        throw new Error(`duplicate class name ${className} in ${previous} and ${name}`);
      }
      classes.set(className, info);
      declaredIn.set(className, name);
    }
  }

  /** The implementation selected by ordinary property lookup from `start`. */
  const resolve = (
    receiver: string,
    start: string | undefined,
    member: string,
  ): Reaches | undefined => {
    const seen = new Set<string>();
    for (let name = start; name && !seen.has(name); ) {
      seen.add(name);
      const current = classes.get(name);
      if (!current) {
        throw new Error(
          `unresolved base class ${name} while tracing ${receiver} in ${declaredIn.get(receiver)}`,
        );
      }
      const body = current.bodies.get(member);
      if (body) return body;
      name = current.base;
    }
    return undefined;
  };

  const cache = new Map<string, Set<Reaches>>();
  const requestsFor = (className: string): Set<Reaches> => {
    const cached = cache.get(className);
    if (cached) return cached;

    const bodies = new Set<Reaches>();
    const lineage = new Set<string>();
    for (let name: string | undefined = className; name && !lineage.has(name); ) {
      lineage.add(name);
      const current = classes.get(name);
      if (!current) break;
      for (const reaches of current.bodies.values()) bodies.add(reaches);
      name = current.base;
    }

    const requesting = new Set([...bodies].filter((reaches) => reaches.transport));
    // Widen until nothing new is reached. Bounded by the member count, since
    // each pass either adds a body or stops, and a cycle of mutually recursive
    // helpers settles rather than spinning.
    for (;;) {
      const grown = [...bodies].filter((reaches) => {
        if (requesting.has(reaches)) return false;
        const throughThis = [...reaches.siblings].some((member) => {
          // Private names are lexical; ordinary names dispatch on the receiver.
          const start = member.startsWith('#') ? reaches.owner : className;
          const target = resolve(className, start, member);
          return target !== undefined && requesting.has(target);
        });
        const base = classes.get(reaches.owner)?.base;
        const throughSuper = [...reaches.inherited].some((member) => {
          const target = resolve(className, base, member);
          return target !== undefined && requesting.has(target);
        });
        return throughThis || throughSuper;
      });
      if (grown.length === 0) break;
      for (const reaches of grown) requesting.add(reaches);
    }
    cache.set(className, requesting);
    return requesting;
  };

  const found = new Map<string, Set<string>>();
  for (const [className, info] of classes) {
    const requesting = requestsFor(className);
    const candidates = new Set<string>();
    const lineage = new Set<string>();
    for (
      let name: string | undefined = className;
      name && !lineage.has(name);
      name = classes.get(name)?.base
    ) {
      lineage.add(name);
      const current = classes.get(name);
      if (!current) break;
      for (const member of current.publicNames) candidates.add(member);
    }
    const selected = new Map<string, Reaches>();
    for (const member of candidates) {
      const body = resolve(className, className, member);
      if (!body || !requesting.has(body)) continue;
      if (body.owner === className) {
        selected.set(member, body);
        continue;
      }
      // Ordinary inherited behavior is covered at its declaration. Keep the
      // inherited entry point only when dispatch in this subclass is what made
      // the body request-making.
      const base = info.base;
      const baseBody = resolve(className, base, member);
      if (base && baseBody && !requestsFor(base).has(baseBody)) selected.set(member, body);
    }
    const own = new Set(selected.keys());
    const instanceField = [...own].find((member) => {
      const body = selected.get(member);
      return body !== undefined && classes.get(body.owner)?.instanceFields.has(member);
    });
    if (instanceField !== undefined) {
      throw new Error(
        `${className}.${instanceField} in ${declaredIn.get(className)} is a public ` +
          'request-making instance field; declare it as a prototype method so it can be recorded',
      );
    }
    const accessor = [...own].find((member) => {
      const body = selected.get(member);
      return body !== undefined && classes.get(body.owner)?.accessors.has(member);
    });
    if (accessor !== undefined) {
      throw new Error(
        `${className}.${accessor} in ${declaredIn.get(className)} is a public request-making ` +
          'accessor; declare it as a prototype method so it can be recorded',
      );
    }
    if (own.size > 0) found.set(className, own);
  }
  return found;
}

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** Read every TypeScript source below `root`, in a stable order. */
export function readTypeScriptFiles(root: string): { name: string; source: string }[] {
  const paths: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith('.ts')) paths.push(path);
    }
  };
  visit(root);
  return paths.sort().map((path) => ({
    name: relative(root, path).replaceAll('\\', '/'),
    source: readFileSync(path, 'utf8'),
  }));
}

/**
 * Every public request-making method in this SDK, by its class.
 *
 * Every file in `src` is read, rather than a named few. A list of modules to
 * look in is the same maintenance hazard as a list of methods: the module
 * somebody adds is the one that is not on it.
 *
 * Classes are resolved through the package's own entry point, so a
 * request-making class that is not exported fails here rather than being
 * skipped — if it is reachable by a caller it is surface, and if it is not
 * reachable it should not be declaring public methods that call the platform.
 */
export function inventory(): Inventory {
  const files = readTypeScriptFiles(SRC);
  const exported = sdk as unknown as Record<string, unknown>;
  const found = new Map<Ctor, ReadonlySet<string>>();
  for (const [className, methods] of requestingMethods(files)) {
    const cls = exported[className];
    if (typeof cls !== 'function') {
      throw new Error(
        `${className} declares public request-making methods (${[...methods].sort().join(', ')}) ` +
          'but is not exported from src/index.ts, so nothing can exercise it.',
      );
    }
    found.set(cls as unknown as Ctor, methods);
  }
  return found;
}

/** The inventory as the labels {@link recordNamedCalls} records. */
export function names(surface: Inventory): Set<string> {
  const all = new Set<string>();
  for (const [cls, methods] of surface) for (const m of methods) all.add(`${cls.name}.${m}`);
  return all;
}

/**
 * The property key a declared name addresses.
 *
 * Everything is its own name except a computed one, and the only computed names
 * on this surface are well-known symbols — `[Symbol.asyncDispose]`, which is how
 * an ephemeral computer deletes itself. Anything else throws rather than being
 * dropped: a method the recorder cannot address is a method the completeness
 * check would silently stop making a claim about.
 */
export function keyOf(declared: string): string | symbol {
  const wellKnown = /^\[Symbol\.([A-Za-z]+)\]$/.exec(declared);
  if (!wellKnown) return declared;
  const symbol = (Symbol as unknown as Record<string, unknown>)[wellKnown[1] as string];
  if (typeof symbol !== 'symbol') {
    throw new Error(`${declared} is not a well-known symbol this recorder can address`);
  }
  return symbol;
}

type CallSite = { getFunctionName(): string | null };

/**
 * The name of the function that called whoever is asking.
 *
 * Frame 0 is this helper and frame 1 is the wrapper below it, so frame 2 is the
 * caller of the wrapped method. `Error.prepareStackTrace` is put back the way it
 * was found, because vitest's own reporter reads stacks too.
 */
function callerName(): string {
  const previous = Error.prepareStackTrace;
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 3;
  Error.prepareStackTrace = (_err, sites) => sites;
  const sites = new Error().stack as unknown as CallSite[] | undefined;
  Error.prepareStackTrace = previous;
  Error.stackTraceLimit = limit;
  return sites?.[2]?.getFunctionName() ?? '';
}

/**
 * Record which of the inventory's methods `callers` call BY NAME.
 *
 * Only calls made directly from one of `callers` count, which is the whole point
 * of the frame check. `Computer.agent` drives `agentStream`, `waitForGuest`
 * drives `exec`, and every `list()` delegates to its own class's
 * `listWithStatus` — so counting calls from anywhere would let a method be
 * "covered" by whichever neighbour happens to delegate to it, which is the same
 * borrowed coverage as sharing a route, one level down. What this proves is that
 * the exercise NAMES the method: its own signature, its own defaults, its own
 * return.
 *
 * Everything is put back on the way out, including when the exercise throws.
 */
export async function recordNamedCalls(
  surface: Inventory,
  callers: readonly { readonly name: string }[],
  run: () => Promise<void>,
): Promise<Set<string>> {
  const from = new Set(callers.map((c) => c.name));
  if (from.has('') || from.size !== callers.length) {
    throw new Error('every caller must have a distinct, non-empty name to be seen in a stack');
  }
  const recorded = new Set<string>();
  const restore: (() => void)[] = [];

  try {
    for (const [cls, methods] of surface) {
      for (const declared of [...methods].sort()) {
        const key = keyOf(declared);
        const ownDescriptor = Object.getOwnPropertyDescriptor(cls.prototype, key);
        let owner = cls.prototype;
        while (owner && !Object.hasOwn(owner, key)) owner = Object.getPrototypeOf(owner) as object;
        const descriptor = owner ? Object.getOwnPropertyDescriptor(owner, key) : undefined;
        if (!descriptor || typeof descriptor.value !== 'function') {
          throw new Error(`${cls.name}.${declared} is not a prototype method`);
        }
        const original = descriptor.value as (...a: unknown[]) => unknown;
        const label = `${cls.name}.${declared}`;
        const wrapper = function (this: unknown, ...args: unknown[]): unknown {
          if (from.has(callerName())) recorded.add(label);
          return original.apply(this, args);
        };
        Object.defineProperty(wrapper, 'name', { value: original.name });
        Object.defineProperty(cls.prototype, key, { ...descriptor, value: wrapper });
        restore.push(() => {
          if (ownDescriptor) Object.defineProperty(cls.prototype, key, ownDescriptor);
          else Reflect.deleteProperty(cls.prototype, key);
        });
      }
    }
    await run();
  } finally {
    for (const undo of restore.reverse()) undo();
  }
  return recorded;
}
