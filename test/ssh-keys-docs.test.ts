import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../src/resources.ts', import.meta.url), 'utf8');

/** The docblock directly above `SshKeys.add`. */
function addDoc(): string {
  const at = source.indexOf('  async add(args: P.SshKeyAddArgs');
  expect(at).toBeGreaterThan(0);
  const open = source.lastIndexOf('/**', at);
  return source.slice(open, at).replace(/\s*\*\s*/g, ' ');
}

describe('SshKeys.add documentation', () => {
  // A key is bound to the credential that added it, so a fingerprint in the
  // person-wide listing does not mean this account's computers accept it.
  it('does not promise that a listed fingerprint makes add idempotent', () => {
    expect(addDoc()).not.toMatch(/to make it idempotent/);
  });

  it('says a listed key may be bound to another account and how to use it here', () => {
    const doc = addDoc();
    expect(doc).toMatch(/not that this account accepts it/);
    expect(doc).toMatch(/bound to another account/);
    expect(doc).toMatch(/\{@link remove\} it and add it again/);
  });
});
