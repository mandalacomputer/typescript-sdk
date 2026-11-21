import { describe, expect, it } from 'vitest';
import {
  Client,
  ComputerNotRunningError,
  ConflictError,
  CreateOnlyConflictError,
  FileExistsError,
  NotFoundError,
  RateLimitError,
  UploadInterruptedError,
  ValidationError,
} from '../src/index.js';
import { BASE, COMPUTER, json, type Responder, recorder } from './harness.js';

const path = '/tmp/é & file';
const uploadId = 'a'.repeat(32);
const receipt = (offset: number, size: number, complete = offset === size) => ({
  path,
  upload_id: uploadId,
  offset,
  size,
  complete,
});
async function setup(responder: Responder) {
  const rec = recorder((call) =>
    call.path === `/computers/${COMPUTER.id}` ? json(COMPUTER) : responder(call),
  );
  const client = new Client({
    apiKey: 'com_test',
    baseUrl: BASE,
    fetch: rec.fetch,
    retries: { idempotent: 0 },
  });
  const computer = await client.computers.get(COMPUTER.id);
  rec.calls.length = 0;
  return { computer, rec };
}
describe('resumable uploads', () => {
  it('sends binary chunks and exact metadata, with status and cleanup on the dedicated route', async () => {
    const { computer, rec } = await setup((call) =>
      json(call.method === 'DELETE' ? { ok: true } : receipt(3, 3)),
    );
    await computer.writeFileChunk(path, new Uint8Array([0, 255, 1]), {
      uploadId,
      offset: 0,
      size: 3,
      overwrite: false,
      noWake: true,
    });
    expect(rec.last().raw).toEqual(new Uint8Array([0, 255, 1]));
    expect(rec.last().query).toEqual({
      path,
      upload_id: uploadId,
      offset: '0',
      size: '3',
      overwrite: 'false',
      no_wake: '1',
    });
    expect(await computer.fileUpload(path, uploadId)).toEqual(receipt(3, 3));
    await computer.cancelFileUpload(path, uploadId);
    expect(rec.calls.every((c) => c.path.endsWith('/files/uploads'))).toBe(true);
  });
  it('resumes a partially accepted chunk and never loads more than 4 MiB', async () => {
    const size = 10 * 1024 * 1024;
    let offset = 123;
    const { computer } = await setup((call) => {
      if (call.method === 'PUT') {
        expect(Number(call.query.offset)).toBe(offset);
        offset += call.raw!.length;
      }
      return json(receipt(offset, size));
    });
    const reads: number[] = [];
    const result = await computer.uploadFile(
      path,
      {
        size,
        read: async (start, length) => {
          reads.push(start);
          expect(length).toBeLessThanOrEqual(4 * 1024 * 1024);
          return new Uint8Array(length);
        },
      },
      { uploadId },
    );
    expect(result.complete).toBe(true);
    expect(reads[0]).toBe(123);
    expect(reads).toHaveLength(3);
  });
  it('reconciles a lost final response without republishing', async () => {
    const { computer, rec } = await setup(() => json(receipt(3, 3)));
    expect(
      (
        await computer.uploadFile(
          path,
          {
            size: 3,
            read: async () => {
              throw new Error('must not read');
            },
          },
          { uploadId },
        )
      ).complete,
    ).toBe(true);
    expect(rec.calls.map((c) => c.method)).toEqual(['GET']);
  });
  it('retains the ID and does not claim success for an ambiguous response', async () => {
    const { computer } = await setup((call) =>
      call.method === 'GET' ? json(receipt(0, 3, false)) : json({ offset: 3 }),
    );
    await expect(
      computer.uploadFile(path, { size: 3, read: async () => new Uint8Array(3) }, { uploadId }),
    ).rejects.toMatchObject({ name: 'UploadInterruptedError', uploadId });
    expect(UploadInterruptedError).toBeDefined();
  });
  it('refuses a changed source and invalid ranges before writing', async () => {
    const { computer, rec } = await setup(() => json(receipt(1, 3, false)));
    await expect(
      computer.uploadFile(path, { size: 4, read: async () => new Uint8Array(4) }, { uploadId }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(rec.calls.map((c) => c.method)).toEqual(['GET']);
    await expect(
      computer.writeFileChunk(path, new Uint8Array(3), { uploadId, offset: 2, size: 3 }),
    ).rejects.toThrow('Invalid upload');
    expect(rec.calls).toHaveLength(1);
  });
});

describe('chunks refused while another is in flight', () => {
  const busy = (retryAfter = '0') =>
    json(
      { error: 'another chunk for this computer is still in flight' },
      { status: 429, headers: { 'content-type': 'application/json', 'Retry-After': retryAfter } },
    );

  it('resends the first chunk of a fresh upload from offset 0 without reading status', async () => {
    let refused = false;
    const { computer, rec } = await setup((call) => {
      if (call.method === 'PUT' && !refused) {
        refused = true;
        return busy();
      }
      return json({ ...receipt(3, 3), upload_id: call.query.upload_id });
    });
    const result = await computer.uploadFile(path, {
      size: 3,
      read: async () => new Uint8Array(3),
    });
    expect(result.complete).toBe(true);
    expect(rec.calls.map((c) => [c.method, c.query.offset])).toEqual([
      ['PUT', '0'],
      ['PUT', '0'],
    ]);
  });

  it('waits, reads status and resumes from the offset it reports', async () => {
    const size = 6 * 1024 * 1024;
    const chunk = 4 * 1024 * 1024;
    let staged = 0;
    let refusals = 0;
    const { computer, rec } = await setup((call) => {
      if (call.method === 'GET') return json(receipt(staged, size));
      if (Number(call.query.offset) === chunk && refusals < 2) {
        refusals++;
        return busy();
      }
      staged = Number(call.query.offset) + call.raw!.length;
      return json(receipt(staged, size));
    });
    const result = await computer.uploadFile(
      path,
      { size, read: async (_, length) => new Uint8Array(length) },
      { uploadId },
    );
    expect(result.complete).toBe(true);
    expect(rec.calls.map((c) => [c.method, c.query.offset])).toEqual([
      ['GET', undefined],
      ['PUT', '0'],
      ['PUT', String(chunk)],
      ['GET', undefined],
      ['PUT', String(chunk)],
      ['GET', undefined],
      ['PUT', String(chunk)],
    ]);
  });

  it('returns the receipt when status after the wait says the upload finished', async () => {
    let refused = false;
    const { computer, rec } = await setup((call) => {
      if (call.method === 'GET') return json(refused ? receipt(3, 3) : receipt(0, 3, false));
      refused = true;
      return busy();
    });
    const result = await computer.uploadFile(
      path,
      { size: 3, read: async () => new Uint8Array(3) },
      { uploadId },
    );
    expect(result).toEqual(receipt(3, 3));
    expect(rec.calls.map((c) => c.method)).toEqual(['GET', 'PUT', 'GET']);
  });

  it('honours Retry-After before resending', async () => {
    let refused = false;
    const { computer } = await setup((call) => {
      if (call.method === 'PUT' && !refused) {
        refused = true;
        return busy('1');
      }
      return json({ ...receipt(3, 3), upload_id: call.query.upload_id });
    });
    const started = performance.now();
    await computer.uploadFile(path, { size: 3, read: async () => new Uint8Array(3) });
    expect(performance.now() - started).toBeGreaterThanOrEqual(900);
  });

  it('gives up after a bounded run of refusals, keeping the upload ID', async () => {
    const { computer, rec } = await setup((call) =>
      call.method === 'GET' ? json(receipt(0, 3, false)) : busy(),
    );
    const error = await computer
      .uploadFile(path, { size: 3, read: async () => new Uint8Array(3) }, { uploadId })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitError);
    expect(error).toMatchObject({ uploadId });
    expect(rec.calls.filter((c) => c.method === 'PUT')).toHaveLength(13);
  });

  it('stops waiting when the caller cancels', async () => {
    const controller = new AbortController();
    const { computer, rec } = await setup((call) => {
      if (call.method === 'GET') return json(receipt(0, 3, false));
      setTimeout(() => controller.abort(new Error('stop the upload')), 10);
      return busy('5');
    });
    const started = performance.now();
    await expect(
      computer.uploadFile(
        path,
        { size: 3, read: async () => new Uint8Array(3) },
        { uploadId, signal: controller.signal },
      ),
    ).rejects.toMatchObject({ message: 'stop the upload', uploadId });
    expect(performance.now() - started).toBeLessThan(2000);
    expect(rec.calls.map((c) => c.method)).toEqual(['GET', 'PUT']);
  });

  it('does not wait out a 429 on a single writeFileChunk', async () => {
    const { computer, rec } = await setup(() => busy());
    await expect(
      computer.writeFileChunk(path, new Uint8Array(3), { uploadId, offset: 0, size: 3 }),
    ).rejects.toBeInstanceOf(RateLimitError);
    expect(rec.calls).toHaveLength(1);
  });
});

describe('upload error contracts', () => {
  for (const [reason, kind] of [
    ['exists', FileExistsError],
    [undefined, CreateOnlyConflictError],
    ['unavailable', ComputerNotRunningError],
  ] as const) {
    it(`preserves ${reason ?? 'reasonless create-only'} refusals with the upload ID`, async () => {
      const { computer } = await setup((call) =>
        call.method === 'GET'
          ? json(receipt(0, 3, false))
          : json({ error: 'refused', reason }, { status: 409 }),
      );
      let error: unknown;
      try {
        await computer.uploadFile(
          path,
          { size: 3, read: async () => new Uint8Array(3) },
          { uploadId, overwrite: false, noWake: true },
        );
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(kind);
      expect(error).toMatchObject({ uploadId });
    });
  }
  it('does not turn a missing receipt into a new upload', async () => {
    const { computer, rec } = await setup(() => json({ error: 'missing' }, { status: 404 }));
    await expect(
      computer.uploadFile(path, { size: 3, read: async () => new Uint8Array(3) }, { uploadId }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(rec.calls.map((c) => c.method)).toEqual(['GET']);
  });
  it('preserves the exact abort reason and its recovery ID', async () => {
    const controller = new AbortController();
    const reason = new DOMException('cancelled by user', 'AbortError');
    const { computer } = await setup(() => json(receipt(0, 3, false)));
    await expect(
      computer.uploadFile(
        path,
        {
          size: 3,
          read: async () => {
            controller.abort(reason);
            throw reason;
          },
        },
        { uploadId, signal: controller.signal },
      ),
    ).rejects.toBe(reason);
    expect(reason).toMatchObject({ uploadId });
  });
  it('maps only explicit no-wake refusals on status and cleanup', async () => {
    for (const reason of ['unavailable', undefined]) {
      const { computer } = await setup(() => json({ error: 'conflict', reason }, { status: 409 }));
      const kind = reason ? ComputerNotRunningError : ConflictError;
      await expect(computer.fileUpload(path, uploadId, { noWake: true })).rejects.toBeInstanceOf(
        kind,
      );
      await expect(
        computer.cancelFileUpload(path, uploadId, { noWake: true }),
      ).rejects.toBeInstanceOf(kind);
    }
  });
  it('publishes an empty file without reading source bytes', async () => {
    const { computer, rec } = await setup((call) =>
      json({ ...receipt(0, 0), upload_id: call.query.upload_id }),
    );
    expect(
      (
        await computer.uploadFile(path, {
          size: 0,
          read: async () => {
            throw new Error('unexpected read');
          },
        })
      ).complete,
    ).toBe(true);
    expect(rec.last().raw).toHaveLength(0);
  });
  it('rejects a genuinely short source as validation, not a retry suggestion', async () => {
    const { computer } = await setup(() => json(receipt(0, 3, false)));
    await expect(
      computer.uploadFile(path, { size: 3, read: async () => new Uint8Array(1) }, { uploadId }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

it('tags the abort reason even when the source throws a different error', async () => {
  const controller = new AbortController();
  const reason = new DOMException('cancelled', 'AbortError');
  const { computer } = await setup(() => json(receipt(0, 3, false)));
  await expect(
    computer.uploadFile(
      path,
      {
        size: 3,
        read: async () => {
          controller.abort(reason);
          throw new Error('different failure');
        },
      },
      { uploadId, signal: controller.signal },
    ),
  ).rejects.toBe(reason);
  expect(reason).toMatchObject({ uploadId });
});

it('retains every recovery ID when uploads share an abort reason', async () => {
  const controller = new AbortController();
  const reason = new DOMException('cancelled together', 'AbortError');
  const ids = [uploadId, 'b'.repeat(32)];
  const { computer, rec } = await setup((call) =>
    json({ ...receipt(0, 3, false), upload_id: call.query.upload_id }),
  );
  let readers = 0;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const outcomes = await Promise.allSettled(
    ids.map((id) =>
      computer.uploadFile(
        path,
        {
          size: 3,
          read: async () => {
            if (++readers === 2) {
              controller.abort(reason);
              release();
            }
            await ready;
            throw reason;
          },
        },
        { uploadId: id, signal: controller.signal },
      ),
    ),
  );
  expect(
    outcomes.every((outcome) => outcome.status === 'rejected' && outcome.reason === reason),
  ).toBe(true);
  expect(reason).toMatchObject({ uploadIds: expect.arrayContaining(ids) });
  expect(ids).toContain((reason as Error & { uploadId?: string }).uploadId);
  expect(rec.calls.every((call) => call.method === 'GET')).toBe(true);
});
