/** The template store and the builds that compile documents into images. */

import { describe, expect, it } from 'vitest';
import { Client, MandalaError, NotFoundError, TimeoutError } from '../src/index.js';

import {
  anyRoute,
  BASE,
  BUILD_PROGRESS,
  errorJson,
  json,
  PUBLISHED_TEMPLATE,
  RETIRED_TEMPLATES,
  type Responder,
  recorder,
} from './harness.js';

/**
 * What a caller sees for a mistake this SDK refused before sending.
 *
 * `TypeError`, and deliberately not the `ValidationError` subclass that is
 * actually thrown: that one is not exported from the entry point, because to a
 * caller these are exactly TypeErrors and are documented as such. Asserting the
 * subclass here would pin a contract the package does not offer.
 */
const REFUSED_LOCALLY = TypeError;

/** The bytes a call actually put on the wire, as text. */
const sent = (raw: Uint8Array | undefined): string | undefined =>
  raw === undefined ? undefined : new TextDecoder().decode(raw);

// OPL-3835. The clients were three platform tickets behind here: the store
// (OPL-3789), the retire (OPL-3830) and the builds (OPL-3791/3794) were all
// reachable from an API key and from none of these SDKs.
//
// What is pinned below is the seam rather than the platform. The platform's own
// tests own whether a publish stores anything; these own whether a caller can
// tell a retired ref from a name that never existed, whether an unset version
// can widen a retire from one version to all of them, and whether a wait
// reports a failed build as an outcome rather than as an exception.

const client = (respond: Responder = anyRoute) => {
  const rec = recorder(respond);
  return { rec, client: new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch }) };
};

describe('publishing a document', () => {
  it('sends the document as bytes, not wrapped in JSON', async () => {
    const { rec, client: c } = client();
    await c.templates.publish('apiVersion: mandala/v1\nkind: Template');
    const call = rec.calls.find((x) => x.method === 'POST' && x.path === '/templates');
    // The platform reads JSON or YAML off the body itself. An envelope would be
    // a document its validator never sees — and would parse as JSON, so the
    // failure would be a complaint about the WRAPPER's fields.
    expect(sent(call?.raw)).toBe('apiVersion: mandala/v1\nkind: Template');
  });

  it('refuses an empty document without a round trip', async () => {
    const { rec, client: c } = client();
    await expect(c.templates.publish('   ')).rejects.toBeInstanceOf(REFUSED_LOCALLY);
    expect(rec.calls).toHaveLength(0);
  });

  it('reads the document back as an object, and keeps the digest', async () => {
    const { client: c } = client();
    const t = await c.templates.publish('apiVersion: mandala/v1');
    expect(t.ref).toBe('acc-1/devbox@1.0.0');
    expect(t.docDigest).toBe('sha256:aaaa');
    expect(t.document).toMatchObject({ apiVersion: 'mandala/v1' });
    expect(t.versions).toEqual(['1.0.0']);
    expect(t.template.ramMb).toBe(4096);
  });

  /**
   * A shipped template has no `published_at` — nobody published it, it is
   * compiled into the daemon — and an empty string would read as a timestamp
   * that is known and blank rather than one that does not apply.
   */
  it('leaves published_at absent rather than empty when the platform omits it', async () => {
    const { client: c } = client((call) =>
      call.path.startsWith('/templates/')
        ? json({ ...PUBLISHED_TEMPLATE, published_at: undefined })
        : anyRoute(call),
    );
    const t = await c.templates.get('system', 'base');
    expect(t.publishedAt).toBeUndefined();
    expect('publishedAt' in t).toBe(false);
  });
});

describe('checking a document', () => {
  /**
   * An invalid document is the ANSWER to the question this method asks, and the
   * platform says so with a 200. Throwing would make the one method whose job
   * is to report problems the one method you cannot use to see them.
   */
  it('does not throw for an invalid document, and carries every problem', async () => {
    const { client: c } = client((call) =>
      call.path === '/templates/validate'
        ? json({ valid: false, problems: ['spec.os is required', 'metadata.version is required'] })
        : anyRoute(call),
    );
    const check = await c.templates.validate('apiVersion: mandala/v1');
    expect(check.valid).toBe(false);
    expect(check.problems).toHaveLength(2);
    expect(check.ref).toBeUndefined();
  });

  it('carries both digests when the document is valid', async () => {
    const { client: c } = client();
    const check = await c.templates.validate('apiVersion: mandala/v1');
    expect(check.valid).toBe(true);
    expect(check.docDigest).toBe('sha256:aaaa');
    expect(check.buildDigest).toBe('sha256:bbbb');
  });
});

describe('naming a version', () => {
  it('omits the parameter entirely when no version is given', async () => {
    const { rec, client: c } = client();
    await c.templates.get('acc-1', 'devbox');
    expect(rec.calls[0]?.query).not.toHaveProperty('version');
  });

  /**
   * The defect this exists to be on the right side of.
   *
   * `?version=` — what most clients serialise for an unset optional string —
   * read as "no version was named" on the platform and retired an ENTIRE
   * template, irreversibly. The platform answers 400 for it now; this SDK
   * cannot send it at all, which is the stronger guarantee: omission and
   * emptiness mean different things on a retire, and only one of them is
   * recoverable.
   */
  it('refuses an empty version rather than sending it', async () => {
    const { rec, client: c } = client();
    await expect(c.templates.retire('acc-1', 'devbox', { version: '' })).rejects.toBeInstanceOf(
      REFUSED_LOCALLY,
    );
    expect(rec.calls).toHaveLength(0);
  });

  it('refuses a version that is not MAJOR.MINOR.PATCH', async () => {
    const { rec, client: c } = client();
    for (const bad of ['1.0', 'abc', '1.0.0.0', '01.0.0', 'v1.0.0']) {
      await expect(c.templates.get('acc-1', 'devbox', { version: bad })).rejects.toBeInstanceOf(
        REFUSED_LOCALLY,
      );
    }
    expect(rec.calls).toHaveLength(0);
  });

  it('sends a well-formed one', async () => {
    const { rec, client: c } = client();
    await c.templates.get('acc-1', 'devbox', { version: '1.10.0' });
    expect(rec.calls[0]?.query.version).toBe('1.10.0');
  });

  /**
   * Two segments, not one. The platform reduces `templates/<a>/<b>` to
   * `templates/:namespace/:name`, so a ref handed over whole would be
   * percent-encoded into a single segment and reach a route that does not
   * exist — a 404 about a name, describing a URL.
   */
  it('puts the ref in the path as two segments', async () => {
    const { rec, client: c } = client();
    await c.templates.get('acc-1', 'devbox', { version: '1.0.0' });
    expect(rec.calls[0]?.path).toBe('/templates/acc-1/devbox');
  });
});

describe('retiring one', () => {
  it('reports what went, what is left, and both counts', async () => {
    const { client: c } = client();
    const gone = await c.templates.retire('acc-1', 'devbox');
    expect(gone.retired).toEqual(['acc-1/devbox@1.0.0']);
    expect(gone.versions).toEqual([]);
    expect(gone.templates).toBe(0);
    // The two numbers move differently, and this is the one place a caller sees
    // it: retiring gave a template row back and gave no ref back.
    expect(gone.refsClaimed).toBe(1);
  });

  it('sends DELETE with no body', async () => {
    const { rec, client: c } = client();
    await c.templates.retire('acc-1', 'devbox');
    expect(rec.calls[0]?.method).toBe('DELETE');
    expect(rec.calls[0]?.raw).toBeUndefined();
    expect(rec.calls[0]?.body).toBeUndefined();
  });

  /**
   * A retired ref is not an unknown ref, and the platform's 404 says which. A
   * client that kept only the status would throw that away — and the date is
   * the whole answer to "when did my script stop working".
   */
  it('keeps the platform’s sentence about when a retired ref went', async () => {
    const { client: c } = client((call) =>
      call.path.startsWith('/templates/')
        ? errorJson(
            404,
            'acc-1/devbox@1.0.0 was retired on 2026-08-26T13:00:00.000Z. A ref names one ' +
              'document for ever, so this one cannot be published again or brought back.',
          )
        : anyRoute(call),
    );
    const err = await c.templates.get('acc-1', 'devbox', { version: '1.0.0' }).catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect((err as Error).message).toContain('retired on 2026-08-26');
  });
});

describe('what a type annotation does not check', () => {
  /**
   * Found by adversarial review, and confirmed by running it.
   *
   * `templateVersion` validated by coercing through `RegExp.test` and then
   * returned the ORIGINAL value, which the transport coerces a SECOND time in
   * `searchParams.set(k, String(v))`. An object whose `toString()` answers
   * `1.2.3` and then `''` therefore passed the check and put `?version=` on the
   * wire — the empty-version branch, which on a retire means every version of
   * the name and cannot be undone.
   *
   * These types are erased at runtime and this package is called from
   * JavaScript, so the annotation is not the check.
   */
  it('refuses a version whose toString changes between coercions', async () => {
    const { rec, client: c } = client();
    let n = 0;
    const shifty = {
      toString() {
        return n++ === 0 ? '1.2.3' : '';
      },
    } as unknown as string;
    await expect(c.templates.retire('acc-1', 'devbox', { version: shifty })).rejects.toBeInstanceOf(
      REFUSED_LOCALLY,
    );
    expect(rec.calls).toHaveLength(0);
  });

  it('refuses a version that is not a string at all', async () => {
    const { rec, client: c } = client();
    for (const bad of [null, 1, {}, [], true] as unknown[]) {
      await expect(
        c.templates.get('acc-1', 'devbox', { version: bad as string }),
      ).rejects.toBeInstanceOf(REFUSED_LOCALLY);
    }
    expect(rec.calls).toHaveLength(0);
  });

  /**
   * The same hole in the path guard, which is older than this branch and which
   * templateRef now depends on: `new String('..') === '..'` is false, so the dot
   * check missed it, and `encodeURIComponent` then emitted `..` — a request
   * aimed at a route nobody named.
   */
  it('refuses a boxed String in a path segment', async () => {
    const { rec, client: c } = client();
    const boxed = new String('..') as unknown as string;
    await expect(c.templates.get(boxed, 'devbox')).rejects.toBeInstanceOf(REFUSED_LOCALLY);
    await expect(c.templates.retire('acc-1', boxed)).rejects.toBeInstanceOf(REFUSED_LOCALLY);
    expect(rec.calls).toHaveLength(0);
  });
});

describe('starting a build', () => {
  it('sends the document as bytes and takes the 202', async () => {
    const { rec, client: c } = client();
    const build = await c.builds.start('apiVersion: mandala/v1');
    expect(sent(rec.calls[0]?.raw)).toBe('apiVersion: mandala/v1');
    expect(build.id).toBe('bld-1');
    expect(build.status).toBe('running');
    expect(build.finishedAt).toBeUndefined();
  });

  /**
   * Omitted rather than sent as `false`, because lib/apidoc gives this parameter
   * `enum: ['true']` — so `true` is the only value the reference admits.
   *
   * This docstring used to claim the platform reads the key's presence, which is
   * false: server/buildjob.go compares it to `"true"`.
   */
  it('sends no_reuse only when it is asked for', async () => {
    const { rec, client: c } = client();
    await c.builds.start('apiVersion: mandala/v1');
    expect(rec.calls[0]?.query).not.toHaveProperty('no_reuse');
    await c.builds.start('apiVersion: mandala/v1', { noReuse: true });
    expect(rec.calls[1]?.query.no_reuse).toBe('true');
  });
});

describe('watching a build', () => {
  it('reads the steps out of progress, in order', async () => {
    const { client: c } = client();
    const p = await c.builds.progress('bld-1');
    expect(p.done).toBe(true);
    expect(p.phase).toBe('published');
    expect(p.steps.map((s) => s.kind)).toEqual(['apt', 'finish']);
    expect(p.steps[0]?.status).toBe('done');
  });

  it('yields every progress and stops after done', async () => {
    const { client: c } = client();
    const seen = [];
    for await (const p of c.builds.events('bld-1')) seen.push(p.status);
    expect(seen).toEqual(['running', 'succeeded']);
  });

  /**
   * An `error` event is the STREAM failing, not the build. A caller told "the
   * build failed" would go and read a document that is fine, so this names what
   * actually happened and points at the poll that can still answer.
   */
  it('throws for a stream error, and says it is not the build', async () => {
    const { client: c } = client((call) =>
      call.path.endsWith('/events')
        ? new Response('event: error\ndata: {"error":"host went away"}\n\n', {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          })
        : anyRoute(call),
    );
    const read = async () => {
      for await (const _ of c.builds.events('bld-1')) break;
    };
    const err = await read().catch((e) => e);
    expect(err).toBeInstanceOf(MandalaError);
    expect((err as Error).message).toContain('host went away');
    expect((err as Error).message).toContain('says nothing about the build itself');
  });

  it('returns when the build is done', async () => {
    const { client: c } = client();
    const out = await c.builds.wait('bld-1', { pollMs: 1 });
    expect(out.status).toBe('succeeded');
  });

  /**
   * The rule the move work established: `succeeded` and `failed` are two
   * situations with two remedies — one has an image, the other has a step to
   * fix — and an exception flattens them into "something went wrong".
   */
  it('does not throw for a build that failed', async () => {
    const { client: c } = client((call) =>
      call.path.endsWith('/progress')
        ? json({
            ...BUILD_PROGRESS,
            status: 'failed',
            phase: 'failed',
            error: 'apt-get returned 100',
            steps: [{ n: 1, kind: 'apt', label: 'nosuchpkg', status: 'failed' }],
          })
        : anyRoute(call),
    );
    const out = await c.builds.wait('bld-1', { pollMs: 1 });
    expect(out.status).toBe('failed');
    expect(out.error).toBe('apt-get returned 100');
    expect(out.steps[0]?.status).toBe('failed');
  });

  it('times out without stopping the build, and says so', async () => {
    const { client: c } = client((call) =>
      call.path.endsWith('/progress')
        ? json({ ...BUILD_PROGRESS, done: false, status: 'running', phase: 'copying' })
        : anyRoute(call),
    );
    const err = await c.builds.wait('bld-1', { timeoutMs: 20, pollMs: 5 }).catch((e) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    expect((err as Error).message).toContain('the build has not stopped, only this wait has');
  });

  /**
   * A build that does not exist is not going to start existing, so a wait
   * against a bad id must not spend its whole timeout discovering that.
   */
  it('gives up at once on a failure polling cannot fix', async () => {
    const { rec, client: c } = client((call) =>
      call.path.endsWith('/progress') ? errorJson(404, 'no such build') : anyRoute(call),
    );
    await expect(c.builds.wait('bld-nope', { timeoutMs: 5_000, pollMs: 1 })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(rec.calls).toHaveLength(1);
  });

  it('keeps polling through a failure that might clear', async () => {
    let n = 0;
    const { client: c } = client((call) => {
      if (!call.path.endsWith('/progress')) return anyRoute(call);
      n += 1;
      return n === 1 ? errorJson(503, 'no hypervisor could answer') : json(BUILD_PROGRESS);
    });
    const out = await c.builds.wait('bld-1', { pollMs: 1 });
    expect(out.status).toBe('succeeded');
    expect(n).toBe(2);
  });

  /**
   * The control plane's policy, not the guest probe's (adversarial review).
   *
   * This SDK has two, for two different things. waitForGuest retries all but a
   * few permanent classes, because a booting guest agent legitimately answers
   * 409, 502 and 503 for its first seconds. This poll reads the control plane
   * like waitForMove does, so a 400 is a defect rather than a phase — and
   * swallowing it spent the whole half-hour default before saying anything.
   */
  it('gives up at once on a failure that is not transient', async () => {
    const { rec, client: c } = client((call) =>
      call.path.endsWith('/progress') ? errorJson(400, 'that is not a build id') : anyRoute(call),
    );
    await expect(c.builds.wait('bld-1', { timeoutMs: 5_000, pollMs: 1 })).rejects.toThrow(
      /not a build id/,
    );
    expect(rec.calls).toHaveLength(1);
  });

  it('gives the caller back their own cancellation, not a timeout', async () => {
    const ctl = new AbortController();
    const { client: c } = client((call) => {
      if (!call.path.endsWith('/progress')) return anyRoute(call);
      ctl.abort();
      return errorJson(503, 'no hypervisor could answer');
    });
    const err = await c.builds
      .wait('bld-1', { timeoutMs: 5_000, pollMs: 1, signal: ctl.signal })
      .catch((e) => e);
    expect(err).not.toBeInstanceOf(TimeoutError);
  });

  /**
   * The timeout must not quote a stale observation in the present tense.
   *
   * One poll answers, then every later one fails. Saying the build "was still
   * running" is a claim about now, made from a reading that is by then as old as
   * the wait itself.
   */
  it('does not claim a build is still running from a stale reading', async () => {
    let n = 0;
    const { client: c } = client((call) => {
      if (!call.path.endsWith('/progress')) return anyRoute(call);
      n += 1;
      return n === 1
        ? json({ ...BUILD_PROGRESS, done: false, status: 'running', phase: 'copying' })
        : errorJson(503, 'no hypervisor could answer');
    });
    const err = await c.builds.wait('bld-1', { timeoutMs: 40, pollMs: 5 }).catch((e) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    expect((err as Error).message).toContain('could not be reached');
    expect((err as Error).message).toContain('when it last answered');
    expect((err as Error).message).not.toContain('was still running');
  });

  /**
   * A stream that stops without a `done` must not read as one that finished.
   *
   * `sse` deliberately has no deadline, so a malformed final event left the
   * generator waiting on a connection the platform had finished with — holding
   * one of the account's eight slots. And a stream that simply ended returned
   * normally, so a caller looping over it reported a build it had stopped
   * watching as a build that ended.
   */
  it('throws when the stream ends without a final event', async () => {
    const { client: c } = client((call) =>
      call.path.endsWith('/events')
        ? new Response(`event: progress\ndata: ${JSON.stringify(BUILD_PROGRESS)}\n\n`, {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          })
        : anyRoute(call),
    );
    const read = async () => {
      for await (const _ of c.builds.events('bld-1')) {
        // drain
      }
    };
    await expect(read()).rejects.toThrow(/ended without a final event/);
  });

  it('throws when the final event is malformed rather than waiting on the socket', async () => {
    const { client: c } = client((call) =>
      call.path.endsWith('/events')
        ? new Response('event: done\ndata: "not a record"\n\n', {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          })
        : anyRoute(call),
    );
    const read = async () => {
      for await (const _ of c.builds.events('bld-1')) {
        // drain
      }
    };
    await expect(read()).rejects.toThrow(/malformed final event/);
  });

  it('refuses wait numbers that would make it never return', async () => {
    const { client: c } = client();
    await expect(c.builds.wait('bld-1', { timeoutMs: Number('nope') })).rejects.toBeInstanceOf(
      REFUSED_LOCALLY,
    );
    await expect(c.builds.wait('bld-1', { pollMs: 0 })).rejects.toBeInstanceOf(REFUSED_LOCALLY);
  });
});

describe('the retired fixture', () => {
  it('does not let one field stand in for both counts', () => {
    // Guarding the fixture rather than the code: `templates` and `refs_claimed`
    // being equal would let a decoder that read one for both pass every test
    // above.
    expect(RETIRED_TEMPLATES.templates).not.toBe(RETIRED_TEMPLATES.refs_claimed);
  });
});

describe('a short build listing', () => {
  /**
   * It never reaches a caller, and that is the point.
   *
   * lib/hvproxy does set X-GC-Incomplete on a short build listing, but `forward`
   * in lib/surface applies its strict-inventory check to every v1 route
   * generically — so the response becomes a 503 before any client sees it,
   * unless the request passed `allow_partial`, which this route does not
   * document. A previous version of this file believed the opposite and grew a
   * `listWithStatus` to read a header that cannot arrive.
   */
  it('arrives as a refusal, not as a short list', async () => {
    const { client: c } = client((call) =>
      call.path === '/builds'
        ? errorJson(
            503,
            'Right now a hypervisor cannot be reached, so this list would be incomplete. ' +
              'Retry, or pass allow_partial=1 to accept a partial answer.',
            { 'x-gc-incomplete': '0' },
          )
        : anyRoute(call),
    );
    await expect(c.builds.list()).rejects.toThrow(/would be incomplete/);
  });

  it('is an ordinary list when the fleet answered in full', async () => {
    const { client: c } = client();
    expect(await c.builds.list()).toHaveLength(1);
  });
});

describe('a template row carries its ref', () => {
  /**
   * Since OPL-3789 a template an account published is named by its ref and by
   * nothing else — the short `name` still resolves to the platform's own
   * catalogue. A listing that drops it cannot tell a caller how to launch their
   * own template, which is what `publicTemplate` publishes it for. Found by
   * /code-review on the Python SDK; the same model was dropping it here.
   */
  it('keeps the pinned ref off a published template', async () => {
    const { client: c } = client();
    const t = await c.templates.publish('apiVersion: mandala/v1');
    expect(t.template.ref).toBe('acc-1/devbox@1.0.0');
  });

  it('leaves it absent for a host too old to advertise one', async () => {
    const { client: c } = client((call) =>
      call.path === '/templates'
        ? json([{ name: 'base', label: 'Base', os: 'linux', cpu: 2, ram_mb: 2048, disk_gb: 20 }])
        : anyRoute(call),
    );
    const [row] = await c.templates.list();
    expect(row.ref).toBeUndefined();
    expect('ref' in row).toBe(false);
  });
});
