import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { manifest } from '../src/cli-manifest.js';

// The README's "Discover commands and flags" table lists every CLI command,
// one row per group plus a row for the top-level commands. Nothing generated
// it, so it fell behind the CLI; this keeps the two equal.

const TOP_LEVEL = 'Top-level commands';
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

/** Group (first path word, or {@link TOP_LEVEL}) to the rest of each path, in order. */
type Groups = Record<string, string[]>;

function readmeTable(text: string): Groups {
  const heading = text.indexOf('\n### Discover commands and flags\n');
  expect(heading, 'the README has a "Discover commands and flags" section').toBeGreaterThan(-1);
  const lines = text.slice(heading).split('\n');
  const header = lines.indexOf('| Command group | Available commands |');
  expect(header, 'the section has the command table').toBeGreaterThan(-1);
  const groups: Groups = {};
  for (const line of lines.slice(header + 2)) {
    if (!line.startsWith('|')) break;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    expect(cells, line).toHaveLength(2);
    const [name, commands] = cells as [string, string];
    const group = name === TOP_LEVEL ? name : /^`([^`]+)`$/.exec(name)?.[1];
    expect(group, `group cell of ${line}`).toBeDefined();
    const items = commands.split(',').map((item) => /^`([^`]+)`$/.exec(item.trim())?.[1]);
    expect(items, `every command in ${line} is one code span`).not.toContain(undefined);
    expect(groups, `${group} has one row`).not.toHaveProperty([group as string]);
    groups[group as string] = items as string[];
  }
  return groups;
}

function manifestGroups(): Groups {
  const groups: Groups = {};
  for (const { path } of manifest().commands) {
    const [group, rest] =
      path.length === 1 ? [TOP_LEVEL, path[0]] : [path[0], path.slice(1).join(' ')];
    groups[group as string] ??= [];
    groups[group as string]?.push(rest as string);
  }
  return groups;
}

describe('README command table', () => {
  it('lists exactly the commands the CLI manifest has, in manifest order', () => {
    const table = readmeTable(readme);
    const cli = manifestGroups();
    expect(Object.keys(table).sort()).toEqual(Object.keys(cli).sort());
    expect(table).toEqual(cli);
  });

  it('notices a command missing from the table', () => {
    const dropped = readme.replace('`move`, `idle-suspend`, ', '`move`, ');
    expect(dropped).not.toBe(readme);
    expect(readmeTable(dropped)).not.toEqual(manifestGroups());
  });
});
