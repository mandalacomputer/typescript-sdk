/** The template store and the builds that compile documents into images. */

import { describe, expect, it } from 'vitest';
import { Client, MandalaError, NotFoundError, type Template, TimeoutError } from '../src/index.js';
import { isDeadlineAbort } from '../src/wait.js';

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
  TEMPLATE_BUILD,
  TEMPLATE_CHECK,
  TEMPLATE_CHECK_LAYERED,
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

  it('reads the canonical form and the catalogue row a valid answer carries', async () => {
    // Both are sent on every valid document and neither was decoded until
    // OPL-4195. `canonical` is what lets a caller check `docDigest` themselves
    // instead of trusting the platform to have hashed honestly.
    const { client: c } = client();
    const check = await c.templates.validate('apiVersion: mandala/v1');
    expect(check.canonical).toBe('{"apiVersion":"mandala/v1","kind":"Template"}');
    expect(check.template?.name).toBe('devbox');
    expect(check.template?.ref).toBe('acc-1/devbox@1.0.0');
    expect(check.template?.label).toBe('My desktop');
    expect(check.template?.os).toBe('linux');
    expect(check.template?.cpu).toBe(2);
    expect(check.template?.ramMb).toBe(4096);
    expect(check.template?.diskGb).toBe(30);
  });

  /**
   * The row is a {@link Template}, not a record shaped like one.
   *
   * It was `Record<string, unknown>` until OPL-4256, and the model said why:
   * the route had no projector, so it answered the daemon's own row carrying
   * `family`, and decoding that through `toTemplate` would have put the
   * projection's field names on a record that did not have them. OPL-4190 gave
   * the route `publicTemplate` and the two shapes became one, so the reason
   * went — but a raw record fails QUIETLY, which is what makes it worth a test:
   * `check.template.family` went from a string to `undefined` on the day the
   * control plane rolled, with nothing thrown and nothing for TypeScript to
   * warn about.
   */
  it('decodes the row through the same reading a listing gets', async () => {
    // THE SAME ROW ON BOTH WIRES, so the two decodings have to agree field for
    // field rather than merely look alike. Comparing the fixtures instead would
    // only prove the two happen to carry the same keys, and an optional field
    // present on one and absent on the other would break it for no reason.
    const { client: c } = client((call) =>
      call.method === 'GET' && call.path === '/templates'
        ? json([TEMPLATE_CHECK.template])
        : anyRoute(call),
    );
    const [check, rows] = await Promise.all([
      c.templates.validate('apiVersion: mandala/v1'),
      c.templates.list(),
    ]);
    // camelCase sizes, not the wire's `ram_mb`. A record would have carried the
    // wire spelling through on one side and not the other.
    expect(check.template).toEqual(rows[0]);
  });

  /**
   * What the model does not name is still on the row's `raw`.
   *
   * `family` is the case that matters: the projection drops it, so it only
   * arrives from a control plane deployed before OPL-4190 — and decoding the
   * row cost that caller nothing, because nothing that arrived is thrown away.
   * This is the promise the doc comment makes when it tells a reader to look
   * there instead.
   */
  it('keeps what the model does not name on the row it decoded', async () => {
    const { client: c } = client((call) =>
      call.path === '/templates/validate'
        ? json({
            ...TEMPLATE_CHECK,
            template: { ...TEMPLATE_CHECK.template, family: 'debian-13' },
          })
        : anyRoute(call),
    );
    const check = await c.templates.validate('apiVersion: mandala/v1');
    // `in` and not `check.template.family`, which no longer COMPILES — the
    // decoded row is a `Template` and `Template` does not name the field. That
    // refusal is the improvement: the raw record let the same expression type-
    // check and answer `undefined`.
    expect('family' in (check.template ?? {})).toBe(false);
    expect(check.template?.raw.family).toBe('debian-13');
  });

  it('reads why a layered document has no build digest, rather than only that it has none', async () => {
    // The daemon is an if/else on `spec.from` (server/templateschema.go): no
    // parent gets `build_digest`, a parent gets `build_digest_needs` instead.
    // So a client watching only for the digest sees a field missing and is told
    // nothing about why — and the platform sent the reason, naming what cannot
    // be computed and the command that computes it.
    const { client: c } = client((call) =>
      call.path === '/templates/validate' ? json(TEMPLATE_CHECK_LAYERED) : anyRoute(call),
    );
    const check = await c.templates.validate('apiVersion: mandala/v1');
    expect(check.valid).toBe(true);
    expect(check.buildDigest).toBeUndefined();
    expect(check.buildDigestNeeds).toContain("acme/base's image");
    expect(check.buildDigestNeeds).toContain('gorillad -build-template');
  });

  it('leaves a non-record `template` off rather than decoding one from nothing', async () => {
    // `toTemplate` on an array reads every field off it as missing and answers
    // a row of empty names and zero sizes — a template present, typed, and
    // describing nothing. Absent is the honest answer, and `raw` still has
    // whatever arrived.
    const { client: c } = client((call) =>
      call.path === '/templates/validate'
        ? json({ ...TEMPLATE_CHECK, template: ['acc-1/devbox@1.0.0'] })
        : anyRoute(call),
    );
    const check = await c.templates.validate('apiVersion: mandala/v1');
    expect(check.template).toBeUndefined();
    expect(check.raw.template).toEqual(['acc-1/devbox@1.0.0']);
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
    await c.builds.start('apiVersion: mandala/v1', { noReuse: false });
    expect(rec.calls[2]?.query).not.toHaveProperty('no_reuse');
  });

  /**
   * The tests above pass `true` and omit it, which is every value TypeScript
   * admits — and neither of them touches the case that costs money. This
   * package is called from JavaScript and through `any`, where `"false"`, `0`
   * and `new Boolean(false)` all arrive, and truthiness read the first and the
   * third of those as "build it again": minutes of copying a base image and one
   * more build off the account's daily allowance, to reach the image reuse
   * would have handed back for free (adversarial review, OPL-3835).
   *
   * Asserted as no call at all, and not merely as an absent parameter: a
   * refusal that still sent the request would have started the wrong build.
   */
  it('refuses a noReuse that is not a boolean rather than reading it as true', async () => {
    for (const bad of ['false', 'true', 0, 1, null, new Boolean(false)]) {
      const { rec, client: c } = client();
      await expect(
        // The annotation is what this call exists to get past: it is erased at
        // runtime, so it is not the check.
        c.builds.start('apiVersion: mandala/v1', { noReuse: bad as unknown as boolean }),
      ).rejects.toBeInstanceOf(REFUSED_LOCALLY);
      expect(rec.calls).toHaveLength(0);
    }
  });
});

describe('a validation verdict has to be given', () => {
  /**
   * `valid` is the whole answer, so a decoder answering `false` for an absent
   * one reads as "the platform examined your document and rejected it" — a
   * sentence nobody said. Drift that looks like a rejection is worse than
   * drift that says so (adversarial review, second pass, OPL-3835).
   */
  it('refuses a check whose payload carries no verdict', async () => {
    const { client: c } = client((call) =>
      call.path === '/templates/validate' ? json({ problems: [] }) : anyRoute(call),
    );
    await expect(c.templates.validate('apiVersion: mandala/v1')).rejects.toThrow(
      /whether the document is valid/,
    );
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

  /**
   * The test above sends a string, which `isRecord` catches. A `done` whose
   * payload IS a record but says nothing gets past that check and all the way
   * through the decoders, because the decoders on this surface coerce rather
   * than refuse: `toBuildProgress({})` answers `done: false` and an empty
   * status, and the generator returned on it. A caller looping over these reads
   * the last value yielded as the outcome, so that reported a build which never
   * finished as one that had (adversarial review, OPL-3835).
   */
  it('throws when the final event is a record that does not say the build finished', async () => {
    for (const payload of [{ id: 'bld-1', done: false, status: 'running' }, { id: 'bld-1' }]) {
      const { client: c } = client((call) =>
        call.path.endsWith('/events')
          ? new Response(`event: done\ndata: ${JSON.stringify(payload)}\n\n`, {
              status: 200,
              headers: { 'content-type': 'text/event-stream' },
            })
          : anyRoute(call),
      );
      const seen: unknown[] = [];
      const read = async () => {
        for await (const p of c.builds.events('bld-1')) seen.push(p);
      };
      await expect(read()).rejects.toThrow(/does not say the build finished/);
      // Thrown BEFORE the yield: half an answer must not reach the caller at
      // all, or the throw is something they can ignore and still read.
      expect(seen).toHaveLength(0);
    }
  });

  /**
   * The tier below the one above. `{}` used to reach the terminal check and be
   * refused there for saying nothing about the outcome; it is now refused one
   * step earlier, for not being a build at all. Both are correct and the
   * earlier one is better — an id is what every later call needs, and
   * `computerRecord` has always refused a computer without one. The coercing
   * decoders were the only place on this surface that did not.
   */
  it('refuses a build record that carries no id', async () => {
    const { client: c } = client((call) =>
      call.path.endsWith('/events')
        ? new Response(`event: done\ndata: {}\n\n`, {
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
    await expect(read()).rejects.toThrow(/to carry an id/);
  });

  /**
   * `done` alone was too weak a test, and the first version of this check used
   * it. server/buildjob.go declares three statuses and no more — running,
   * succeeded, failed — so a record saying `done: true, status: "running"`
   * contradicts itself. Taking `done` at its word turned that into a finished
   * build whose own status said otherwise, in the two places a caller learns
   * the outcome (adversarial review, second pass, OPL-3835).
   */
  it('refuses a done that contradicts its own status, in events and in wait', async () => {
    const contradictory = { ...BUILD_PROGRESS, done: true, status: 'running' };
    const { client: c } = client((call) =>
      call.path.endsWith('/events')
        ? new Response(`event: done\ndata: ${JSON.stringify(contradictory)}\n\n`, {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          })
        : call.path.endsWith('/progress')
          ? json(contradictory)
          : anyRoute(call),
    );
    const read = async () => {
      for await (const _ of c.builds.events('bld-1')) {
        // drain
      }
    };
    // One message for one defect now, and the same sentence the Python SDK
    // raises: the two clients disagreed about this payload and no longer do
    // (OPL-3835).
    await expect(read()).rejects.toThrow(/contradicts itself/);
    await expect(c.builds.wait('bld-1', { timeoutMs: 5_000 })).rejects.toThrow(
      /contradicts itself/,
    );
  });

  /**
   * The half this SDK was missing, and the Python one had.
   *
   * A host too old to send `done` said NOTHING, and the status has to answer
   * for it. Reading that as `false` polled a finished build until the wait
   * expired — which is what the Python review caught and this one did not
   * (OPL-3835).
   */
  it('ends a wait on a terminal status when done is absent, null or unreadable', async () => {
    for (const done of [undefined, null, 'maybe', {}]) {
      const payload: Record<string, unknown> = { ...BUILD_PROGRESS, status: 'succeeded' };
      if (done === undefined) delete payload.done;
      else payload.done = done;
      const { client: c } = client((call) =>
        call.path.endsWith('/progress') ? json(payload) : anyRoute(call),
      );
      const got = await c.builds.wait('bld-1', { timeoutMs: 5_000, pollMs: 1 });
      expect(got.status, JSON.stringify(done)).toBe('succeeded');
      expect(got.done, JSON.stringify(done)).toBe(true);
    }
  });

  /** And a running build with no `done` is still not finished. */
  it('does not end a wait on a running status when done is absent', async () => {
    const payload: Record<string, unknown> = { ...BUILD_PROGRESS, status: 'running' };
    delete payload.done;
    const { client: c } = client((call) =>
      call.path.endsWith('/progress') ? json(payload) : anyRoute(call),
    );
    await expect(c.builds.wait('bld-1', { timeoutMs: 60, pollMs: 1 })).rejects.toThrow(
      /still running|could not be/,
    );
  });

  /**
   * A coerced value cannot classify.
   *
   * `String(['succeeded'])` is `'succeeded'` — a JavaScript array of one joins
   * to its element — so a status of `["succeeded"]` read as terminal here and
   * produced a settled build with no contradiction. Python gives the right
   * answer for the same payload only because `str(["succeeded"])` happens to be
   * `"['succeeded']"`, an accident of formatting rather than a rule. Both
   * clients require a string now (adversarial review, OPL-3835).
   */
  it('never treats a status that is not a string as terminal', async () => {
    const { toBuildProgress, buildContradiction } = await import('../src/models.js');
    for (const status of [['succeeded'], ['failed'], 123, { v: 'succeeded' }, null, true]) {
      const withFlag = toBuildProgress({ id: 'bld-1', status, done: true });
      expect(withFlag.done, JSON.stringify(status)).toBe(false);
      expect(buildContradiction(withFlag) !== null, JSON.stringify(status)).toBe(true);

      const bare = toBuildProgress({ id: 'bld-1', status });
      expect(bare.done, JSON.stringify(status)).toBe(false);
      expect(buildContradiction(bare), JSON.stringify(status)).toBe(null);
    }
    // And the ordinary case is untouched.
    expect(toBuildProgress({ id: 'b', status: 'succeeded' }).done).toBe(true);
    expect(toBuildProgress({ id: 'b', status: 'running' }).done).toBe(false);
  });

  /**
   * A contradictory `progress` frame must throw before it is yielded.
   *
   * Checked only on the final frame, it was handed to the caller as news and
   * the stream then reported "ended without a final event" — the wrong error
   * for the wrong reason. The Python half checks every event (OPL-3835).
   */
  it('throws on a contradictory progress frame rather than yielding it', async () => {
    const bad = { ...BUILD_PROGRESS, done: true, status: 'running' };
    const { client: c } = client((call) =>
      call.path.endsWith('/events')
        ? new Response(
            `event: progress\ndata: ${JSON.stringify(bad)}\n\n` +
              `event: done\ndata: ${JSON.stringify({ ...BUILD_PROGRESS, done: true, status: 'succeeded' })}\n\n`,
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          )
        : anyRoute(call),
    );
    const seen: unknown[] = [];
    await expect(
      (async () => {
        for await (const p of c.builds.events('bld-1')) seen.push(p);
      })(),
    ).rejects.toThrow(/contradicts itself/);
    expect(seen, 'the contradictory record must not reach the caller').toEqual([]);
  });

  /** The table both SDKs now implement, asserted directly on the decoder. */
  it('agrees with the Python SDK on when a build has stopped', async () => {
    const { toBuildProgress, buildContradiction } = await import('../src/models.js');
    const cases: Array<[Record<string, unknown>, boolean, boolean]> = [
      [{ status: 'succeeded', done: true }, true, false],
      [{ status: 'failed', done: true }, true, false],
      [{ status: 'running', done: false }, false, false],
      [{ status: 'succeeded' }, true, false],
      [{ status: 'succeeded', done: null }, true, false],
      [{ status: 'succeeded', done: 'maybe' }, true, false],
      [{ status: 'running' }, false, false],
      [{ status: 'running', done: null }, false, false],
      [{ status: 'running', done: 'maybe' }, false, false],
      [{ status: 'running', done: true }, false, true],
      [{ status: '', done: true }, false, true],
      [{ status: 'queued', done: true }, false, true],
    ];
    for (const [raw, done, contradicts] of cases) {
      const p = toBuildProgress({ id: 'bld-1', ...raw });
      expect(p.done, JSON.stringify(raw)).toBe(done);
      expect(buildContradiction(p) !== null, JSON.stringify(raw)).toBe(contradicts);
    }
  });

  /** The other half of the check above: a real `done` still ends the stream. */
  it('returns normally on a done that does say the build finished', async () => {
    const { client: c } = client();
    const seen = [];
    for await (const p of c.builds.events('bld-1')) seen.push(p);
    expect(seen.map((p) => p.done)).toEqual([false, true]);
    expect(seen.at(-1)?.status).toBe('succeeded');
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
   * The DEFAULT is still the refusal, and that is the point.
   *
   * lib/hvproxy sets X-GC-Incomplete on a short build listing and `forward` in
   * lib/surface turns it into a 503 for every v1 route generically, so a caller
   * who asked no question about partial answers gets an error rather than a
   * list that has quietly lost a hypervisor's worth of builds.
   */
  const shortListing = () =>
    client((call) =>
      call.path === '/builds'
        ? errorJson(
            503,
            'Right now a hypervisor cannot be reached, so this list would be incomplete. ' +
              'Retry, or pass allow_partial=1 to accept a partial answer.',
            { 'x-gc-incomplete': '0' },
          )
        : anyRoute(call),
    );

  it('arrives as a refusal, not as a short list', async () => {
    const { client: c } = shortListing();
    await expect(c.builds.list()).rejects.toThrow(/would be incomplete/);
  });

  /**
   * OPL-3840. The remedy the refusal names is now one this client can take.
   *
   * The platform read `allow_partial` on this route from the day it started
   * fanning out — `allowsPartial` reads the query string of whatever request it
   * is handed — but did not document it, so the mirror in test/allowlist could
   * not carry it and this method could not send it. A build listing was
   * therefore strictly less available than a computer listing: one host away
   * and there was no way through at all.
   *
   * What is asserted is that the parameter reaches the request. The fixture
   * refuses whatever the query says, because the honouring is the platform's
   * half and is tested there; a mirror listing a parameter nobody sends is this
   * ticket's gap in the other direction.
   */
  it('sends the escape hatch when the caller opts in', async () => {
    const { rec, client: c } = shortListing();
    await expect(c.builds.list({ allowPartial: true })).rejects.toThrow(/would be incomplete/);
    expect(rec.calls.at(-1)?.query.allow_partial).toBe('1');
  });

  /**
   * A short build listing has NO row marking what is gone.
   *
   * The platform keeps no record of which hypervisor ran which build, so there
   * is nothing to append. The status is therefore the only evidence a caller
   * who opted in has, and its count is `0` for the same reason. Computers and
   * snapshots do append an `{ id, unreachable: true }` row per thing they could
   * not reach — for an account-wide key; a workspace-scoped one gets none
   * either. Presence is the signal; see Listing.
   */
  it('says it was short through the status, since no row can say so', async () => {
    const { client: c } = client((call) =>
      call.path === '/builds'
        ? // `content-type` restated because the init spread REPLACES the
          // harness's headers rather than merging with them, and a listing
          // without it decodes as no body at all.
          json([TEMPLATE_BUILD], {
            headers: { 'content-type': 'application/json', 'x-gc-incomplete': '0' },
          })
        : anyRoute(call),
    );
    const listing = await c.builds.listWithStatus({ allowPartial: true });
    expect(listing.items).toHaveLength(1);
    expect(listing.incomplete).toBe(0);
  });

  it('is an ordinary list when the fleet answered in full', async () => {
    const { client: c } = client();
    expect(await c.builds.list()).toHaveLength(1);
    expect((await c.builds.listWithStatus()).incomplete).toBeNull();
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
    const rows = await c.templates.list();
    // Indexed access is `Template | undefined` under this repo's
    // noUncheckedIndexedAccess, and vitest does not typecheck — which is how
    // this shipped red past a green test run (/code-review, OPL-3835).
    expect(rows).toHaveLength(1);
    const row = rows[0] as Template;
    expect(row.ref).toBeUndefined();
    expect('ref' in row).toBe(false);
  });
});

/**
 * OPL-4259. The same miss as `ref`, one field along.
 *
 * `publicTemplate` publishes `desktop` and argues for it where it argues
 * `family` is internal: it changes what a caller gets from routes they already
 * use. `os` is `linux` for a Wayland guest and an X11 one alike, so this is the
 * only field that separates them, and a caller who cannot see it cannot tell
 * whether a window id is a compositor address or an X window id.
 */
describe('a template row says which display protocol it speaks', () => {
  it('carries the field a Wayland template is told apart by', async () => {
    const { client: c } = client((call) =>
      call.method === 'GET' && call.path === '/templates'
        ? json([TEMPLATE_CHECK.template])
        : anyRoute(call),
    );
    const rows = await c.templates.list();
    expect(rows).toHaveLength(1);
    const row = rows[0] as Template;
    expect(row.desktop).toBe('wayland');
    // Not distinguishable by `os`, which is the reason the field exists.
    expect(row.os).toBe('linux');
  });

  /**
   * ABSENT, and not `'x11'`.
   *
   * The three-way reading is the whole care in this field. A host deployed
   * before OPL-4223 does not send it, and the platform's projector passes that
   * silence through rather than naming a value, because naming one would assert
   * a property of an image nobody claimed. A decoder defaulting to `'x11'`
   * would put that assertion back on this side of the wire; `str()`'s own
   * fallback would answer `''`, a display protocol no host speaks. Both are
   * this client inventing what the platform declines to say — the fault
   * `cursorPosition` and the window geometry decoder each refuse by name.
   */
  it('says nothing rather than x11 when the platform said nothing', async () => {
    const { client: c } = client((call) =>
      call.method === 'GET' && call.path === '/templates'
        ? json([{ name: 'base', label: 'Base', os: 'linux', cpu: 2, ram_mb: 2048, disk_gb: 20 }])
        : anyRoute(call),
    );
    const rows = await c.templates.list();
    expect(rows).toHaveLength(1);
    const row = rows[0] as Template;
    expect(row.desktop).toBeUndefined();
    expect('desktop' in row).toBe(false);
  });

  /**
   * An explicit `x11` is passed through as itself.
   *
   * The absent case above is a host that has not been told about the field; a
   * host that HAS says `x11` out loud, and flattening the two would lose the
   * only evidence a caller has that the platform actually answered the
   * question.
   */
  it('keeps an x11 the platform did say', async () => {
    const { client: c } = client((call) =>
      call.method === 'GET' && call.path === '/templates'
        ? json([{ ...TEMPLATE_CHECK.template, desktop: 'x11' }])
        : anyRoute(call),
    );
    const rows = await c.templates.list();
    expect((rows[0] as Template).desktop).toBe('x11');
  });

  /** Every route that answers a catalogue row goes through the one decoder. */
  it('reaches a caller through publish, get and validate alike', async () => {
    const wayland = { ...PUBLISHED_TEMPLATE.template, desktop: 'wayland' };
    const { client: c } = client((call) =>
      call.path === '/templates/validate'
        ? json(TEMPLATE_CHECK)
        : call.path.startsWith('/templates/') || call.path === '/templates'
          ? json({ ...PUBLISHED_TEMPLATE, template: wayland })
          : anyRoute(call),
    );
    const [published, fetched, check] = await Promise.all([
      c.templates.publish('apiVersion: mandala/v1'),
      c.templates.get('acc-1', 'devbox'),
      c.templates.validate('apiVersion: mandala/v1'),
    ]);
    expect(published.template.desktop).toBe('wayland');
    expect(fetched.template.desktop).toBe('wayland');
    expect(check.template?.desktop).toBe('wayland');
  });
});

describe('what the second review pass found', () => {
  /**
   * The wait's own timer firing inside a poll is not a failed poll.
   *
   * Every poll here succeeds; the last one is simply slower than what is left of
   * the budget. The abort that produces is the wait ending, and counting it as a
   * failure reported a build that had answered every time as one that could not
   * be reached — pointing the reader at a fleet outage that did not happen.
   */
  it('does not blame the platform when its own deadline cuts off the last poll', async () => {
    const { client: c } = client(async (call) => {
      if (!call.path.endsWith('/progress')) return anyRoute(call);
      await new Promise((r) => setTimeout(r, 15));
      return json({ ...BUILD_PROGRESS, done: false, status: 'running', phase: 'copying' });
    });
    const err = await c.builds.wait('bld-1', { timeoutMs: 40, pollMs: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    expect((err as Error).message).toContain('was still running');
    expect((err as Error).message).not.toContain('could not be reached');
  });

  /**
   * A permanent failure is judged by what it IS, not by when it arrived.
   *
   * The clause this was copied from reads `Date.now() < deadline && !isTransient`,
   * so a 401 arriving once the deadline had passed was swallowed and replaced by
   * a timeout. Handling the abort by name instead means only a real abort is
   * swallowed — and this pins that, because the timing case itself cannot be
   * staged: our own signal cancels a slow request, so a late answer never
   * arrives to be judged.
   */
  it('treats only a real abort as the deadline, never a platform answer', () => {
    expect(isDeadlineAbort(new DOMException('timed out', 'TimeoutError'))).toBe(true);
    // NOT AbortError, though this asserted that it was until the second review
    // pass argued that a name is a proxy for ownership. It is — and the fix was
    // to drop the name that never meant us, rather than to rebuild how a wait
    // tracks its signals.
    //
    // Measured on node 22+: a deadline is AbortSignal.timeout's reason, which is
    // a DOMException named `TimeoutError`; AbortSignal.any carries that reason
    // through; and fetch rejects with the reason itself. A CALLER's abort is
    // named `AbortError` and leaves their own signal reading `aborted`, which
    // the loops check first. So nothing that arrives here is a deadline called
    // `AbortError`, and accepting the name only swallowed other people's aborts.
    expect(isDeadlineAbort(new DOMException('aborted', 'AbortError'))).toBe(false);
    // Everything the platform can answer with stays judgeable.
    expect(isDeadlineAbort(new MandalaError('body did not parse'))).toBe(false);
    expect(isDeadlineAbort(new NotFoundError('no such build', 404, {}))).toBe(false);
  });

  /**
   * The behaviour that narrowing buys: an abort this wait did not cause reaches
   * the caller instead of being polled over until the wait expires. Told "the
   * build could not be observed within 30000ms", a reader goes looking for a
   * fleet outage; the actual sentence is the one the abort carried.
   */
  it('hands back an abort that is not its own instead of timing out over it', async () => {
    const { client: c } = client((call) =>
      call.path.endsWith('/progress')
        ? Promise.reject(new DOMException('the body stream was released', 'AbortError'))
        : anyRoute(call),
    );
    const err = await c.builds.wait('bld-1', { timeoutMs: 5_000, pollMs: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(DOMException);
    expect((err as Error).message).toContain('body stream');
    expect(err).not.toBeInstanceOf(TimeoutError);
  });

  /** A stream whose frames were all skipped had still sent something. */
  it('does not say a stream sent nothing when it sent unusable frames', async () => {
    const { client: c } = client((call) =>
      call.path.endsWith('/events')
        ? new Response('event: progress\ndata: "starting"\n\nevent: keepalive\ndata: {}\n\n', {
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
    const err = await read().catch((e) => e);
    expect((err as Error).message).toContain('ended without a final event');
    expect((err as Error).message).not.toContain('sent nothing at all');
  });
});
