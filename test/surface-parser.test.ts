import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { balanced, stripComments, topLevelField, topLevelKeys } from '../scripts/surface-text.mjs';

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
  const scanTable = (table: string) => {
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
      const run = spawnSync(process.execPath, ['scripts/check-surface.mjs'], {
        cwd: resolve(__dirname, '..'),
        env: { ...process.env, MANDALA_PLATFORM_REPO: dir },
        encoding: 'utf8',
      });
      const said = `${run.stdout}${run.stderr}`;
      return [...said.matchAll(/^ {2}\+ ([A-Z]+ \S+)$/gm)].map((m) => m[1]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('reads a route whose entry writes pattern before method', () => {
    // The lazy `/method:[\s\S]*?pattern:/` skipped this entry looking for a
    // `method:`, found the next one's, and paired it with the pattern after
    // that: `GET beta`, a route in neither table and so reported by neither.
    expect(
      scanTable(`
        { role: 'viewer', pattern: 'alpha', method: 'GET' },
        { method: 'POST', pattern: 'beta' },
      `),
    ).toEqual(['GET alpha', 'POST beta']);
  });

  it('does not let a nested literal lend its pattern to the entry above', () => {
    expect(
      scanTable(`
        { method: 'GET', handler: { fallback: { pattern: 'not-a-route' } }, pattern: 'gamma' },
      `),
    ).toEqual(['GET gamma']);
  });

  it('ignores an entry that carries only half of the pair', () => {
    expect(scanTable(`{ pattern: 'orphan' }, { method: 'PUT', pattern: 'delta' },`)).toEqual([
      'PUT delta',
    ]);
  });
});
