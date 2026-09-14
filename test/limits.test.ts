/**
 * The second link in the limits chain.
 *
 * `scripts/check-surface.mjs` compares `LIMITS` in the mirror against the
 * platform's published `surface-manifest.json`. That proves the mirror is in
 * step with the platform and says nothing at all about whether the SDK is —
 * `LIMITS` is a table in a test file, and the numbers that actually turn a call
 * away live in `src/paths.ts` and `src/webhooks.ts`.
 *
 * So this asserts the other half: every entry in `LIMITS` is the constant the
 * SDK refuses against. Change one and not the other and this fails here, which
 * is the only reason writing the mirror out by hand is safe.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_CLIPBOARD_BYTES,
  MAX_ENV_ENTRIES,
  MAX_ENV_ENTRY_BYTES,
  WEBHOOK_COMPUTERS_MAX,
  WEBHOOK_DESCRIPTION_MAX,
} from '../src/paths.js';
import { WEBHOOK_TOLERANCE_S } from '../src/webhooks.js';
import { LIMITS } from './allowlist.js';

/** Manifest key → the constant this SDK actually refuses against. */
const BOUND: ReadonlyArray<readonly [string, number]> = [
  ['clipboard.writeMaxBytes', MAX_CLIPBOARD_BYTES],
  ['exec.maxEnvEntries', MAX_ENV_ENTRIES],
  ['exec.maxEnvEntryBytes', MAX_ENV_ENTRY_BYTES],
  ['webhook.descriptionMaxChars', WEBHOOK_DESCRIPTION_MAX],
  ['webhook.computersMax', WEBHOOK_COMPUTERS_MAX],
  ['webhook.replayWindowSeconds', WEBHOOK_TOLERANCE_S],
];

describe('the mirrored limits', () => {
  it.each(BOUND)('%s is the constant the SDK enforces', (key, value) => {
    expect(LIMITS.get(key)).toBe(value);
  });

  it('names every constant the mirror holds, and no others', () => {
    // Both directions. A key added to LIMITS and not to BOUND would be compared
    // against the platform and against nothing in the SDK — a number that looks
    // checked and is not, which is the failure this whole file exists to refuse.
    expect([...LIMITS.keys()].sort()).toEqual(BOUND.map(([key]) => key).sort());
  });
});
