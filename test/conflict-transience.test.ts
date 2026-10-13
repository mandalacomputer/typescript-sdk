/**
 * A 409 without a transient `reason` is final to `isTransient` (OPL-5973).
 *
 * The platform documents an absent `reason` as no classification, and says a
 * client that treats 409 as uniformly transient loops forever on the refusals
 * that are decisions. The bodies below are the platform's own, word for word
 * where it matters: a code and a sentence, and no `reason`.
 */

import { describe, expect, it } from 'vitest';
import { Client, ConflictError, isTransient } from '../src/index.js';
import { anyRoute, BASE, json, type Responder, recorder } from './harness.js';

const client = (respond: Responder) => {
  const rec = recorder(respond);
  return new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch });
};

/** Every call to a path containing `fragment` and `method` answers 409 with `body`. */
const refusing =
  (method: string, fragment: string, body: unknown): Responder =>
  (call) =>
    call.method === method && call.path.includes(fragment)
      ? json(body, { status: 409 })
      : anyRoute(call);

const caught = async (p: Promise<unknown>): Promise<unknown> => p.then(() => undefined, (e) => e);

describe('the permanent 409s an embedder used to be told to retry', () => {
  it.each([
    [
      'a public URL label that is taken',
      { error: 'The label "cool-thing" is taken; choose another.', code: 'LABEL_TAKEN' },
    ],
    [
      'a computer at its plan’s public URL limit',
      {
        error: 'This computer already has 2 of the 2 public URLs its plan allows; delete one first.',
        code: 'PUBLIC_URL_LIMIT',
      },
    ],
  ])('createPublicUrl: %s', async (_, body) => {
    const c = client(refusing('POST', '/public-urls', body));
    const err = await caught((await c.computers.get('vm-1')).createPublicUrl({ port: 3000 }));
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).code).toBe(body.code);
    expect((err as ConflictError).reason).toBeUndefined();
    expect(isTransient(err)).toBe(false);
    // The by-id spelling answers the same.
    const byId = await caught(c.publicUrls.create('vm-1', { port: 3000 }));
    expect(isTransient(byId)).toBe(false);
  });

  it('webhooks.create past the subscription cap', async () => {
    const c = client(
      refusing('POST', '/webhooks', {
        error:
          'This account already has 10 of the 10 webhook subscriptions its plan allows; delete one first.',
      }),
    );
    const err = await caught(c.webhooks.create({ url: 'https://example.com/hook' }));
    expect(err).toBeInstanceOf(ConflictError);
    expect(isTransient(err)).toBe(false);
  });

  it('webhooks.test on a disabled subscription', async () => {
    const c = client(
      refusing('POST', '/test', {
        error:
          'This webhook is disabled. Enable it with PATCH {"enabled": true} before sending a test.',
      }),
    );
    const err = await caught(c.webhooks.test('whk-0123456789abcdef'));
    expect(err).toBeInstanceOf(ConflictError);
    expect(isTransient(err)).toBe(false);
  });

  it.each([
    'That key is already registered. A key can belong to one person only.',
    'You already have 8 SSH keys, which is the limit. Remove one first.',
  ])('sshKeys.add: %s', async (error) => {
    const c = client(refusing('POST', '/ssh-keys', { error }));
    const err = await caught(
      c.sshKeys.add({ publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample laptop' }),
    );
    expect(err).toBeInstanceOf(ConflictError);
    expect(isTransient(err)).toBe(false);
  });

  it('an unrecognised reason is no answer either', () => {
    expect(isTransient(new ConflictError('x', 409, { error: 'x', reason: 'pending_new_word' }))).toBe(
      false,
    );
  });
});

describe('the 409s that clear by themselves', () => {
  it.each(['contention', 'starting'])('reason %s', (reason) => {
    expect(isTransient(new ConflictError('x', 409, { error: 'x', reason }))).toBe(true);
  });

  it.each(['idempotency_in_progress', 'WORKSPACE_MOVING'])(
    'code %s, with or without the word',
    (code) => {
      expect(isTransient(new ConflictError('x', 409, { error: 'x', code }))).toBe(true);
      expect(
        isTransient(new ConflictError('x', 409, { error: 'x', code, reason: 'contention' })),
      ).toBe(true);
    },
  );

  it('the word wins over the code: an unsettled move that needs a person is final', async () => {
    const c = client(
      refusing('POST', '/public-urls', {
        error:
          'This computer’s workspace change is not settled. Check the workspace change in the dashboard before changing its public URLs.',
        code: 'WORKSPACE_MOVING',
        reason: 'unsupported',
      }),
    );
    const err = await caught((await c.computers.get('vm-1')).createPublicUrl({ port: 3000 }));
    expect(isTransient(err)).toBe(false);
  });

  it('a settling move is worth sending again', async () => {
    const c = client(
      refusing('POST', '/public-urls', {
        error:
          'This computer is being moved to another workspace. Try again in a moment, once the move has finished.',
        code: 'WORKSPACE_MOVING',
        reason: 'contention',
      }),
    );
    const err = await caught((await c.computers.get('vm-1')).createPublicUrl({ port: 3000 }));
    expect(isTransient(err)).toBe(true);
  });
});
