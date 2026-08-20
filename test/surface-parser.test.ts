import { describe, expect, it } from 'vitest';
import { balanced, stripComments, topLevelKeys } from '../scripts/surface-text.mjs';

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
});
