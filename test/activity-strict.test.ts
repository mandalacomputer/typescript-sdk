/**
 * OPL-5979: activity history decodes as strictly as the Python SDK reads it.
 * A `health` that is absent or `null` says nothing; one present but unreadable
 * fails the call, as does a truncation flag, a results `more` or a row's
 * `has_results` that is not a boolean. Each accepts and refuses the same values
 * the Python SDK does: a JSON boolean, `1`/`0`, or their text.
 */

import { describe, expect, it } from 'vitest';
import { Client, MandalaError } from '../src/index.js';
import { toActivity, toActivityPage, toActivityResults } from '../src/models.js';
import {
  ACTIVITY,
  ACTIVITY_PAGE,
  ACTIVITY_RESULTS,
  BASE,
  COMPUTER,
  json,
  recorder,
} from './harness.js';

const PATH = 'computers/vm-1/activities';
const page = (extra: Record<string, unknown>) =>
  toActivityPage({ ...ACTIVITY_PAGE, ...extra }, 'GET', PATH);
const health = (extra: Record<string, unknown>) =>
  page({ health: { ...ACTIVITY_PAGE.health, ...extra } }).health;
const results = (extra: Record<string, unknown>) =>
  toActivityResults({ ...ACTIVITY_RESULTS, ...extra }, 'GET', `${PATH}/act/results`);

/**
 * Each value with its JSON as a title: `it.each` spreads a row that is an
 * array, so a bare `[]` or `[true]` would be titled as no value or as `true`.
 */
const cases = (values: unknown[]): [string, unknown][] =>
  values.map((v) => [v === undefined ? 'nothing' : JSON.stringify(v), v]);

/** Present and not a boolean any reading recognises. */
const MALFORMED = cases(['yes', '', 2, -1, 0.5, [], {}, [true]]);

describe('activity health', () => {
  it('reads a whole health object', () => {
    expect(page({}).health).toEqual({
      recordingStartedAt: '2026-09-01T00:00:00.000Z',
      earliestRetainedAt: '2026-09-16T12:00:00.000Z',
      countTruncated: false,
      ageTruncated: false,
      capture: 'available',
      completeness: 'best-effort',
      gapAt: null,
      recoveredAt: null,
    });
  });

  it('reads an absent or null health as not said, never as an untruncated history', () => {
    const { health: _health, ...without } = ACTIVITY_PAGE;
    const absent = toActivityPage(without, 'GET', PATH);
    expect(absent.health).toBeUndefined();
    expect('health' in absent).toBe(false);
    expect(page({ health: null }).health).toBeUndefined();
  });

  it.each(cases(['degraded', '', 0, 1, true, false, []]))('refuses a health of %s', (_, value) => {
    expect(() => page({ health: value })).toThrow(MandalaError);
    expect(() => page({ health: value })).toThrow(/health .* to be an object/);
  });

  it.each(['count_truncated', 'age_truncated'])('refuses a missing or null %s', (key) => {
    const { [key as 'count_truncated']: _gone, ...rest } = ACTIVITY_PAGE.health;
    expect(() => page({ health: rest })).toThrow(MandalaError);
    expect(() => health({ [key]: null })).toThrow(new RegExp(`${key} as a boolean`));
  });

  it.each(
    ['count_truncated', 'age_truncated'].flatMap((key) =>
      MALFORMED.map(([title, v]) => [key, title, v]),
    ),
  )('refuses %s sent as %s', (key, _, value) => {
    expect(() => health({ [key as string]: value })).toThrow(MandalaError);
  });

  it.each([
    [true, true],
    [false, false],
    [1, true],
    [0, false],
    ['true', true],
    [' False ', false],
    ['1', true],
    ['0', false],
  ])('reads a truncation flag sent as %j as %s', (value, read) => {
    expect(health({ count_truncated: value })?.countTruncated).toBe(read);
    expect(health({ age_truncated: value })?.ageTruncated).toBe(read);
  });

  it('fails the call, not just the decoder', async () => {
    const rec = recorder((call) =>
      call.path.endsWith('/activities')
        ? json({ ...ACTIVITY_PAGE, health: { ...ACTIVITY_PAGE.health, count_truncated: 'yes' } })
        : json(COMPUTER),
    );
    const c = new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch });
    const vm = await c.computers.get('vm-1');
    await expect(vm.activities()).rejects.toThrow(MandalaError);
  });
});

describe('activity results', () => {
  it.each([
    [false, false],
    [true, true],
    ['true', true],
    [0, false],
  ])('reads more sent as %j as %s', (value, read) => {
    expect(results({ more: value }).more).toBe(read);
  });

  it.each([...cases([undefined, null]), ...MALFORMED])('refuses more sent as %s', (_, value) => {
    expect(() => results({ more: value })).toThrow(MandalaError);
  });
});

describe('an activity row', () => {
  it.each([
    [true, true],
    [false, false],
    ['true', true],
    [0, false],
  ])('reads has_results sent as %j as %s', (value, read) => {
    expect(toActivity({ ...ACTIVITY, has_results: value }).hasResults).toBe(read);
  });

  it('reads an absent or null has_results as not said', () => {
    const { has_results: _gone, ...without } = ACTIVITY;
    expect(toActivity(without).hasResults).toBeUndefined();
    expect(toActivity({ ...ACTIVITY, has_results: null }).hasResults).toBeUndefined();
  });

  it.each(MALFORMED)('refuses has_results sent as %s, on a row of a page too', (_, value) => {
    expect(() => toActivity({ ...ACTIVITY, has_results: value })).toThrow(MandalaError);
    expect(() => page({ items: [{ ...ACTIVITY, has_results: value }] })).toThrow(
      /has_results on activity 0/,
    );
  });
});
