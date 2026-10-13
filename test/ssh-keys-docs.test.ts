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
    expect(doc).toMatch(/\{@link SshKey\.reach\}/);
    // This client cannot remove a key bound elsewhere (platform OPL-5617), so
    // the advice is the dashboard or a separate key, never `remove` and re-add.
    expect(doc).not.toMatch(/\{@link remove\} it and add it again/);
    expect(doc).toMatch(/add it again from the dashboard/);
    expect(doc).toMatch(/separate key/);
  });
});

/** The docblock directly above a declaration, or '' when something else is between. */
function classDoc(declaration: string): string {
  const at = source.indexOf(declaration);
  expect(at).toBeGreaterThan(0);
  const close = source.lastIndexOf('*/', at);
  if (source.slice(close + 2, at).trim() !== '') return '';
  return source.slice(source.lastIndexOf('/**', close), close);
}

// OPL-5973: the PublicUrls class was inserted between the SshKeys docblock and
// its class, so SshKeys shipped with no documentation and PublicUrls with two
// blocks above it.
describe('class documentation', () => {
  it('keeps each class under its own docblock', () => {
    expect(classDoc('export class SshKeys {')).toMatch(/The caller's SSH public keys/);
    const publicUrls = classDoc('export class PublicUrls {');
    expect(publicUrls).toMatch(/A computer's public URLs, by the computer's id/);
    expect(publicUrls).not.toMatch(/SSH/);
  });
});
