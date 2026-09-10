import { describe, expect, it, vi } from 'vitest';
import { errorForStatus } from '../src/errors.js';
import {
  Client,
  ConflictError,
  isTransient,
  RateLimitError,
  ValidationError,
} from '../src/index.js';
import { type CreateArgs, createBody } from '../src/paths.js';
import { BASE, COMPUTER, json, recorder } from './harness.js';

const invalidArgs: CreateArgs[] = [
  ...[null, false, 42, {}, [], new String('token')].map((templateTransfer) => ({
    template: 'base',
    templateTransfer: templateTransfer as string,
  })),
  ...['', ' \t\n'].map((templateTransfer) => ({ template: 'base', templateTransfer })),
  ...[undefined, '', ' \t\n', null, 42, {}, new String('base')].map((template) => ({
    template: template as string,
    templateTransfer: 'token',
  })),
  { size: 'large', templateTransfer: 'token' },
  { size: 'large', template: 'base', templateTransfer: 'token' },
];

describe('template preparation create arguments', () => {
  it.each(invalidArgs)('rejects invalid arguments directly: %j', (args) => {
    expect(() => createBody(args)).toThrow(ValidationError);
  });

  it.each(invalidArgs)('rejects invalid arguments before dispatch: %j', async (args) => {
    const rec = recorder(() => json(COMPUTER));
    const client = new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch });
    await expect(client.computers.create(args)).rejects.toBeInstanceOf(ValidationError);
    expect(rec.calls).toHaveLength(0);
  });

  it('preserves an opaque token and the original create fields exactly', async () => {
    const args = {
      template: 'base',
      templateTransfer: ' opaque-token ',
      name: 'example',
      cpu: 2,
      ramMb: 4096,
      diskGb: 40,
      resolution: '1920x1080',
      start: false,
    };
    const body = {
      template: 'base',
      template_transfer: ' opaque-token ',
      name: 'example',
      cpu: 2,
      ram_mb: 4096,
      disk_gb: 40,
      resolution: '1920x1080',
      start: false,
    };
    expect(createBody(args)).toEqual(body);
    const rec = recorder(() => json(COMPUTER));
    const client = new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch });
    await client.computers.create(args);
    expect(rec.calls).toHaveLength(1);
    expect(rec.last().body).toEqual(body);
  });
});

describe('template preparation conflicts', () => {
  it.each([
    ['5', 5_000],
    ['Wed, 01 Jan 2031 00:00:08 GMT', 8_000],
    ['not-a-delay', undefined],
    [undefined, undefined],
  ] as const)('exposes Retry-After %s without replaying the create', async (header, delay) => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2031, 0, 1));
    try {
      const body = {
        error: 'Template image is preparing',
        code: 'template_image_preparing',
        template_transfer: 'opaque-token',
        preparation: { state: 'preparing', error: '' },
      };
      const rec = recorder(() =>
        json(body, { status: 409, headers: header ? { 'Retry-After': header } : {} }),
      );
      const client = new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch });
      const err = await client.computers.create({ template: 'base' }).catch((err) => err);
      expect(err).toBeInstanceOf(ConflictError);
      expect(err.retryAfterMs).toBe(delay);
      expect(err.body).toEqual(body);
      expect(isTransient(err)).toBe(false);
      expect(rec.calls).toHaveLength(1);
    } finally {
      now.mockRestore();
    }
  });

  it('preserves failed preparation details and delay for the caller', async () => {
    const body = {
      code: 'template_image_preparing',
      template_transfer: 'opaque-token',
      preparation: { state: 'failed', error: 'Image preparation failed' },
    };
    const rec = recorder(() => json(body, { status: 409, headers: { 'Retry-After': '5' } }));
    const client = new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch });
    const err = await client.computers.create({ template: 'base' }).catch((err) => err);
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.body).toEqual(body);
    expect(err.retryAfterMs).toBe(5_000);
    expect(isTransient(err)).toBe(false);
    expect(rec.calls).toHaveLength(1);
  });

  it('requires explicit preparation handling even with a transient reason', () => {
    expect(
      isTransient(
        new ConflictError('Preparing', 409, {
          code: 'template_image_preparing',
          reason: 'starting',
        }),
      ),
    ).toBe(false);
    for (const code of [undefined, null, {}, 'another_conflict']) {
      expect(isTransient(new ConflictError('Conflict', 409, { code }))).toBe(true);
    }
  });

  it('keeps the existing RateLimitError constructor delay', () => {
    expect(new RateLimitError('Slow down', 429, {}, 1_500).retryAfterMs).toBe(1_500);
  });

  it.each([400, 409, 416, 429, 500, 504, 520, 521, 525])(
    'retains Retry-After on status %s without changing its body',
    (status) => {
      const body = { detail: 'example' };
      const err = errorForStatus(status, 'Failure', body, { retryAfterMs: 2_000, rangeTotal: 42 });
      expect(err.body).toBe(body);
      expect(err.retryAfterMs).toBe(2_000);
    },
  );
});
