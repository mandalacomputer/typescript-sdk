import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  balanced,
  entries,
  stripComments,
  topLevelField,
  topLevelKeys,
} from '../scripts/surface-text.mjs';

describe('the surface source scanner', () => {
  it('ignores brackets in quoted strings and comments', () => {
    const source = `[{
      description: 'a ] inside prose',
      other: "another ] inside prose",
      template: \`another ]\`,
      // ] in a comment
      nested: [1, 2],
      /* and one more ] */
    }] after`;
    expect(balanced(source, 0, '[', ']')).toContain('nested: [1, 2]');
  });

  it('does not invent top-level keys from descriptions', () => {
    expect(
      topLevelKeys(`name: 'real', description: "fake: value", nested: { inner: true }`),
    ).toEqual(['name', 'description', 'nested']);
  });

  it('strips real comments without truncating comment markers inside strings', () => {
    const source = `
      const docs = { url: 'https://example.com/a//b' }; // remove this
      const template = \`https://example.com/${'path'}\`;
      /* remove this too */ const kept = "// still text";
    `;
    const clean = stripComments(source);
    expect(clean).toHaveLength(source.length);
    expect(clean).toContain("'https://example.com/a//b'");
    expect(clean).toContain('`https://example.com/path`');
    expect(clean).toContain('"// still text"');
    expect(clean).not.toContain('remove this');
  });

  it('does not treat the escaped delimiter at the end of a regex as a comment', () => {
    const source = String.raw`
      const route = /https:\/\//; // remove this
      const divided = total / count; // and this
    `;
    const clean = stripComments(source);
    expect(clean).toHaveLength(source.length);
    expect(clean).toContain(String.raw`/https:\/\//`);
    expect(clean).toContain('total / count');
    expect(clean).not.toContain('remove this');
    expect(clean).not.toContain('and this');
  });

  it('ignores brackets inside regex literals while balancing source', () => {
    const source = String.raw`[{ route: /[}\]]+/, nested: [1, 2] }] after`;
    expect(balanced(source, 0, '[', ']')).toContain('nested: [1, 2]');
  });

  it('reads a field at its own depth, not one a nested literal got in first', () => {
    const entry = `method: 'GET', handler: { fallback: { pattern: 'nested' } }, pattern: 'real'`;
    expect(topLevelField(entry, 'pattern')).toBe('real');
    expect(topLevelField(entry, 'method')).toBe('GET');
  });

  it('does not read a field out of the tail of a longer key', () => {
    expect(topLevelField(`submethod: 'wrong', method: 'GET'`, 'method')).toBe('GET');
  });

  it('returns undefined for a field the literal does not have at all', () => {
    expect(topLevelField(`pattern: 'orphan'`, 'method')).toBeUndefined();
    expect(topLevelField(`nested: { method: 'GET' }`, 'method')).toBeUndefined();
  });

  it('does not read a field out of prose that quotes one', () => {
    expect(
      topLevelField(`description: 'takes a method: \\'GET\\' here', method: 'PUT'`, 'method'),
    ).toBe('PUT');
  });

  it('reads a value in any of the three quote styles', () => {
    expect(topLevelField(`pattern: "computers/:id"`, 'pattern')).toBe('computers/:id');
    expect(topLevelField('pattern: `computers/:id`', 'pattern')).toBe('computers/:id');
    expect(topLevelField(`pattern: 'computers/:id'`, 'pattern')).toBe('computers/:id');
  });

  it('reads a value whose quote is escaped inside it', () => {
    // The value alternation this replaced ended at the first `"`, backslash or
    // not, so the value came back as `a\` — a route in neither table, reported
    // as one the platform serves and the mirror forgot.
    expect(topLevelField(`pattern: "a\\"b"`, 'pattern')).toBe('a"b');
    expect(topLevelField(`pattern: 'a\\'b', method: 'GET'`, 'pattern')).toBe("a'b");
    expect(topLevelField('pattern: `a\\`b`', 'pattern')).toBe('a`b');
    expect(topLevelField(`pattern: 'a\\\\b'`, 'pattern')).toBe('a\\b');
  });

  it('declines a template literal with a hole rather than reading it raw', () => {
    // Half of a route is not a route, and the entry is dropped as half-written.
    // Handing back the source text of the interpolation would be a pattern the
    // platform never serves, compared against a mirror as if it did.
    expect(topLevelField(`pattern: \`computers/\${id}\``, 'pattern')).toBeUndefined();
  });

  it('reads an escaped interpolation as the characters it spells', () => {
    // The other half of the same escape blindness: `\${` interpolates nothing,
    // so declining it drops a whole route as half-written and the mirror is
    // told the platform stopped serving it.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the spelling is the subject
    expect(topLevelField('pattern: `a\\${b}`', 'pattern')).toBe('a${b}');
  });

  it('takes a key with a regex metacharacter in it literally', () => {
    // `name` goes into a RegExp, so unescaped it was a pattern and not a key:
    // `.` matched any character, so `a.b` read the value out of `axb`, and the
    // `$` of `$ref` anchored the end of the input so it matched nothing at all.
    expect(topLevelField(`axb: 'wrong'`, 'a.b')).toBeUndefined();
    expect(topLevelField(`$ref: 'here'`, '$ref')).toBe('here');
  });

  it('splits entries without counting braces inside literals', () => {
    expect(entries(`{ a: 'one } two' }, { b: /[{]/ }, { c: \`three { four\` }`)).toEqual([
      ` a: 'one } two' `,
      ' b: /[{]/ ',
      ' c: `three { four` ',
    ]);
  });

  it('refuses a list body whose braces do not balance', () => {
    expect(() => entries('{ a: 1 } }')).toThrow(/unbalanced/);
    expect(() => entries('{ a: 1')).toThrow(/unbalanced/);
  });
});

/**
 * The route reader, over a platform table it does not control.
 *
 * `routeTable` is not importable — check-surface.mjs reads the platform repo at
 * module scope and exits when it is not there — so the fixture is a platform
 * repo and the assertion is on what the script says it found. The script's own
 * `!routes.size` guard cannot stand in for this: a mispaired parse finds plenty.
 */
describe('the route table reader', () => {
  // Spawned, not spawnSync'd. Each scan is a whole node process, and the
  // synchronous call held this worker's event loop for the length of it —
  // long enough that the 20ms timeout assertion in behaviour.test.ts, running
  // in a sibling worker, missed its deadline and failed. Awaiting the child
  // gives the loop back while the process runs, and the timing test stops
  // depending on which files vitest happened to schedule alongside it.
  const scanTable = async (table: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'surface-fixture-'));
    mkdirSync(join(dir, 'web/lib'), { recursive: true });
    writeFileSync(
      join(dir, 'web/lib/surface.ts'),
      `export const V1_ROUTES: Route[] = [${table}];\n`,
    );
    writeFileSync(join(dir, 'web/lib/apidoc.ts'), 'export const DOCS: Record<string, Doc> = {};\n');
    try {
      // Exits 1: a two-route fixture matches none of the real mirror. The `+`
      // lines are the routes it read out of the fixture, which is the subject.
      const said = await new Promise<string>((done, fail) => {
        const child = spawn(process.execPath, ['scripts/check-surface.mjs'], {
          cwd: resolve(__dirname, '..'),
          env: { ...process.env, MANDALA_PLATFORM_REPO: dir },
        });
        let out = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
          out += chunk;
        });
        child.stderr.on('data', (chunk: string) => {
          out += chunk;
        });
        child.on('error', fail);
        child.on('close', () => done(out));
      });
      return [...said.matchAll(/^ {2}\+ ([A-Z]+ \S+)$/gm)].map((m) => m[1]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('reads a route whose entry writes pattern before method', async () => {
    // The lazy `/method:[\s\S]*?pattern:/` skipped this entry looking for a
    // `method:`, found the next one's, and paired it with the pattern after
    // that: `GET beta`, a route in neither table and so reported by neither.
    expect(
      await scanTable(`
        { role: 'viewer', pattern: 'alpha', method: 'GET' },
        { method: 'POST', pattern: 'beta' },
      `),
    ).toEqual(['GET alpha', 'POST beta']);
  });

  it('does not let a nested literal lend its pattern to the entry above', async () => {
    expect(
      await scanTable(`
        { method: 'GET', handler: { fallback: { pattern: 'not-a-route' } }, pattern: 'gamma' },
      `),
    ).toEqual(['GET gamma']);
  });

  it('ignores an entry that carries only half of the pair', async () => {
    expect(await scanTable(`{ pattern: 'orphan' }, { method: 'PUT', pattern: 'delta' },`)).toEqual([
      'PUT delta',
    ]);
  });

  it('keeps reading entries past a brace quoted inside one of them', async () => {
    // The raw brace count this replaced went to -1 on that `}` and never came
    // back to 0, so `from` was never re-armed: the two routes after it were
    // dropped, `routes.size` stayed non-zero so no guard fired, and check
    // reported them as routes the platform no longer serves.
    expect(
      await scanTable(`
        { method: 'GET', pattern: 'alpha' },
        { method: 'GET', pattern: 'beta', note: 'the } closer' },
        { method: 'DELETE', pattern: 'gamma' },
        { method: 'GET', pattern: 'delta' },
      `),
    ).toEqual(['DELETE gamma', 'GET alpha', 'GET beta', 'GET delta']);
  });

  it('reads a route the table spells with double quotes or a backtick', async () => {
    expect(
      await scanTable(`
        { method: "GET", pattern: "alpha" },
        { method: \`POST\`, pattern: \`beta\` },
      `),
    ).toEqual(['GET alpha', 'POST beta']);
  });
});
