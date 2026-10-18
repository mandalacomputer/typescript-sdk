/**
 * The CHANGELOG's compare links follow its headings (OPL-6079).
 *
 * Twice a release left `[Unreleased]` comparing from the version before last
 * and gave the new version no link at all, so this holds the two together.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const text = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
const BASE = 'https://github.com/mandalacomputer/typescript-sdk/compare/';

const headings = [...text.matchAll(/^## \[([^\]]+)\]/gm)].map((m) => m[1] as string);
const links = new Map(
  [...text.matchAll(/^\[([^\]]+)\]: (\S+)$/gm)].map((m) => [m[1] as string, m[2] as string]),
);

describe('CHANGELOG compare links', () => {
  it('opens with [Unreleased]', () => {
    expect(headings[0]).toBe('Unreleased');
  });

  it('compares [Unreleased] from the newest release', () => {
    expect(links.get('Unreleased')).toBe(`${BASE}v${headings[1]}...HEAD`);
  });

  it('gives every release a link from the one before it', () => {
    const released = headings.slice(1);
    released.slice(0, -1).forEach((version, i) => {
      expect(links.get(version), version).toBe(`${BASE}v${released[i + 1]}...v${version}`);
    });
  });
});
