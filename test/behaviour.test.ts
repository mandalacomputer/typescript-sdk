/** What the handles do, as distinct from where they send it. */

import { describe, expect, it } from 'vitest';
import { Client, MandalaError, TimeoutError } from '../src/index.js';
import {
  anyRoute,
  BASE,
  COMPUTER,
  EXEC_OK,
  errorJson,
  json,
  type Responder,
  recorder,
  SNAPSHOT,
} from './harness.js';

const client = (respond: Responder) => {
  const rec = recorder(respond);
  return {
    rec,
    client: new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch }),
  };
};

describe('the computer record', () => {
  it('reads the screen the computer actually renders at', async () => {
    // Assuming 1280x800 makes every click land proportionally short on a
    // computer that asked for something else.
    const { client: c } = client(() => json({ ...COMPUTER, resolution: '1920x1080x24' }));
    const computer = await c.computers.get('vm-1');
    expect(computer.resolution).toBe('1920x1080x24');
    expect(computer.screen).toEqual({ width: 1920, height: 1080 });
  });

  it('falls back to the default for a platform too old to report one', async () => {
    const { client: c } = client(() => json({ ...COMPUTER, resolution: undefined }));
    expect((await c.computers.get('vm-1')).screen).toEqual({ width: 1280, height: 800 });
  });

  it('falls back rather than returning NaN for a resolution it cannot parse', async () => {
    const { client: c } = client(() => json({ ...COMPUTER, resolution: 'wide' }));
    expect((await c.computers.get('vm-1')).screen).toEqual({ width: 1280, height: 800 });
  });

  it('keeps the id of a machine that was built and would not boot', async () => {
    // The machine exists and is billable, so it comes back rather than being
    // thrown away with an exception.
    const { client: c } = client(() =>
      json({ computer: { ...COMPUTER, status: 'stopped' }, start_error: 'no host had room' }),
    );
    const computer = await c.computers.create({ template: 'base' });
    expect(computer.id).toBe('vm-1');
    expect(computer.startError).toBe('no host had room');
    expect(computer.status).toBe('stopped');
  });

  it('offers no vnc surface rather than a URL built over a missing credential', async () => {
    // Such a URL is indistinguishable from a working one and answers 401 forever.
    const half = { ...COMPUTER.vnc, view_token: '' };
    const { client: c } = client(() => json({ ...COMPUTER, vnc: half }));
    expect((await c.computers.get('vm-1')).vnc).toBeUndefined();
  });

  it('reads both desktop credentials when the platform sent a full set', async () => {
    const { client: c } = client(anyRoute);
    const vnc = (await c.computers.get('vm-1')).vnc!;
    expect(vnc.token).toBe('t');
    expect(vnc.viewToken).toBe('v');
    expect(vnc.terminalUrl).toContain('/terminal');
  });

  it('keeps fields this SDK predates, in raw', async () => {
    const { client: c } = client(() => json({ ...COMPUTER, invented_next_week: 7 }));
    expect((await c.computers.get('vm-1')).raw.invented_next_week).toBe(7);
  });

  it('keeps the desktop credentials out of JSON.stringify', async () => {
    // Serializing a handle is what a casual log line does, and a credential in
    // a log line is exactly what the platform strips them from listings to
    // prevent. They are read deliberately, off vnc or raw.
    const { client: c } = client(anyRoute);
    const computer = await c.computers.get('vm-1');
    expect(computer.vnc?.token).toBe('t');
    expect(JSON.stringify(computer)).not.toContain('vnc');
    expect(computer.raw.vnc).toBeDefined();
  });

  it('hands out raw as a copy deep enough that nothing writes back through it', async () => {
    const { client: c } = client(anyRoute);
    const computer = await c.computers.get('vm-1');
    (computer.raw.vnc as Record<string, unknown>).token = 'overwritten';
    expect(computer.vnc?.token).toBe('t');
  });
});

describe('waiting', () => {
  it('does not spin on a suspended computer, which will not start on its own', async () => {
    // Left to spin it reports a machine that is one call from running as a
    // timeout — the least informative answer about the one case a caller can
    // fix in a line.
    const { client: c } = client(() => json({ ...COMPUTER, status: 'suspended' }));
    const computer = await c.computers.get('vm-1');
    await expect(computer.waitUntilRunning({ timeoutMs: 60_000 })).rejects.toThrow(
      /call start\(\) to resume it/,
    );
  });

  it('does not spin on a failed build, which nothing will fix', async () => {
    const { client: c } = client(() =>
      json({ ...COMPUTER, status: 'build-failed', build: { failed: 'the copy died' } }),
    );
    const computer = await c.computers.get('vm-1');
    await expect(computer.waitUntilRunning({ timeoutMs: 60_000 })).rejects.toThrow(/the copy died/);
  });

  it('returns at once for a computer that is not being built', async () => {
    const { client: c } = client(anyRoute);
    const computer = await c.computers.get('vm-1');
    await expect(computer.waitUntilBuilt({ timeoutMs: 1 })).resolves.toBe(computer);
  });

  it('says a build has not stopped, only the waiting has', async () => {
    const { client: c } = client(() => json({ ...COMPUTER, status: 'building' }));
    const computer = await c.computers.get('vm-1');
    const err = await computer.waitUntilBuilt({ timeoutMs: 5, pollMs: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    expect(err.message).toMatch(/it has not stopped; only this wait has/);
  });

  it('rides out a transient error from the host busy doing the copy being waited on', async () => {
    // A 503 during a minutes-long disk copy is the ordinary weather of a
    // build; one of them must not abort the whole wait.
    let polls = 0;
    const { client: c } = client((call) => {
      if (call.method === 'GET' && call.path === '/computers/vm-1') {
        polls += 1;
        if (polls === 1) return json({ ...COMPUTER, status: 'building' });
        if (polls === 2) return errorJson(503, 'host could not be reached');
        return json(COMPUTER);
      }
      return anyRoute(call);
    });
    const computer = await c.computers.get('vm-1');
    await expect(computer.waitUntilBuilt({ timeoutMs: 5_000, pollMs: 1 })).resolves.toBe(computer);
    expect(polls).toBe(3);
  });

  it('does not call a machine running on data it never observed', async () => {
    // A handle that last saw "running" must not return success while every
    // refresh inside the wait is failing with a 503 — that is a verdict on a
    // machine nobody has actually looked at.
    let gets = 0;
    const { client: c } = client((call) => {
      if (call.method === 'GET' && call.path === '/computers/vm-1') {
        gets += 1;
        return gets === 1 ? json(COMPUTER) : errorJson(503, 'host could not be reached');
      }
      return anyRoute(call);
    });
    const computer = await c.computers.get('vm-1'); // last saw "running"
    const err = await computer.waitUntilRunning({ timeoutMs: 10, pollMs: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    // Nor may the timeout message: 'was still "running"' would be the same
    // unobserved claim, one line lower.
    expect(err.message).toMatch(/could not be observed/);
    expect(err.message).not.toMatch(/was still/);
  });

  it('fails fast on a suspended machine even while every refresh is failing', async () => {
    // The handle's data may be fresh from the get() one line before the wait,
    // and suspended does not become "running" on its own — spinning out the
    // full 120s to repeat what was already known helps nobody.
    let gets = 0;
    const { client: c } = client((call) => {
      if (call.method === 'GET' && call.path === '/computers/vm-1') {
        gets += 1;
        return gets === 1
          ? json({ ...COMPUTER, status: 'suspended' })
          : errorJson(503, 'host could not be reached');
      }
      return anyRoute(call);
    });
    const computer = await c.computers.get('vm-1'); // fresh: suspended
    await expect(computer.waitUntilRunning({ timeoutMs: 60_000, pollMs: 1 })).rejects.toThrow(
      /call start\(\) to resume it/,
    );
  });

  it('rides out the 409 that means the guest agent is still coming up', async () => {
    // Giving up here abandons a machine that was about to answer.
    let attempts = 0;
    const { client: c } = client((call) => {
      if (call.path.endsWith('/exec')) {
        attempts += 1;
        return attempts < 3
          ? errorJson(409, 'the guest agent is not answering yet')
          : json(EXEC_OK);
      }
      return anyRoute(call);
    });
    const computer = await c.computers.get('vm-1');
    await expect(computer.waitForGuest({ timeoutMs: 5_000, pollMs: 1 })).resolves.toBe(computer);
    expect(attempts).toBe(3);
  });

  it('gives up at once on a failure no amount of waiting will clear', async () => {
    // A revoked key is not going to become valid three minutes from now, and
    // reporting it as a timeout names the wrong problem. The long timeout here
    // is the test: it must not be reached.
    const { rec, client: c } = client((call) =>
      call.path.endsWith('/exec') ? errorJson(401, 'that key has been revoked') : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    const started = Date.now();
    await expect(computer.waitForGuest({ timeoutMs: 60_000, pollMs: 1_000 })).rejects.toThrow(
      /that key has been revoked/,
    );
    expect(Date.now() - started).toBeLessThan(1_000);
    // One probe, not a loop's worth.
    expect(rec.routes().filter(([, p]) => p.endsWith('/exec'))).toHaveLength(1);
  });

  it('keeps polling through a 502 from a guest agent that is merely slow', async () => {
    let attempts = 0;
    const { client: c } = client((call) => {
      if (call.path.endsWith('/exec')) {
        attempts += 1;
        return attempts < 3 ? errorJson(502, 'the guest agent did not answer') : json(EXEC_OK);
      }
      return anyRoute(call);
    });
    const computer = await c.computers.get('vm-1');
    await expect(computer.waitForGuest({ timeoutMs: 5_000, pollMs: 1 })).resolves.toBe(computer);
    expect(attempts).toBe(3);
  });
});

describe('the pointer', () => {
  it('says nobody knows where the pointer is, rather than guessing the corner', async () => {
    // The coordinates are present and zero when `known` is false, which is
    // indistinguishable from the corner of the screen.
    const { client: c } = client((call) =>
      call.path.endsWith('/input') ? json({ known: false, x: 0, y: 0 }) : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    expect(await computer.cursorPosition()).toBeUndefined();
  });

  it('reports a known position', async () => {
    const { client: c } = client((call) =>
      call.path.endsWith('/input') ? json({ known: true, x: 12, y: 34 }) : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    expect(await computer.cursorPosition()).toEqual({ x: 12, y: 34 });
  });
});

describe('exec', () => {
  it('returns a non-zero exit rather than throwing it', async () => {
    const { client: c } = client((call) =>
      call.path.endsWith('/exec')
        ? json({ exit_code: 1, stdout: '', stderr: 'no such file', timed_out: false })
        : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    const res = await computer.exec('cat missing');
    expect(res.ok).toBe(false);
    expect(res.exitCode).toBe(1);
  });

  it('separates "it succeeded" from "the output is all of it"', async () => {
    // A command that succeeded and produced more than the guest agent would
    // carry is still a command that succeeded.
    const { client: c } = client((call) =>
      call.path.endsWith('/exec') ? json({ ...EXEC_OK, out_truncated: true }) : anyRoute(call),
    );
    const res = await (await c.computers.get('vm-1')).exec('cat huge');
    expect(res.ok).toBe(true);
    expect(res.truncated).toBe(true);
  });

  it('detaches the browser launch so open() returns in under a second', async () => {
    const { rec, client: c } = client(anyRoute);
    await (await c.computers.get('vm-1')).open('https://example.com');
    const body = rec.last().body as { command: string; session: string };
    expect(body.session).toBe('desktop');
    expect(body.command).toMatch(/^nohup firefox .* >\/dev\/null 2>&1 &$/);
  });

  it('does not report ok for an exec answer that named no exit code', async () => {
    // An empty or malformed response is not evidence the command succeeded,
    // and ok must not affirm what the platform never said.
    const { client: c } = client((call) =>
      call.path.endsWith('/exec') ? json({}) : anyRoute(call),
    );
    const res = await (await c.computers.get('vm-1')).exec('true');
    expect(res.ok).toBe(false);
  });

  it('does not read a null or empty exit code as success either', async () => {
    // An API that always emits every key spells "no exit code" as null, and
    // Number(null) is exactly the 0 that ok must not invent.
    for (const spelling of [null, '']) {
      const { client: c } = client((call) =>
        call.path.endsWith('/exec')
          ? json({ exit_code: spelling, stdout: '', stderr: '', timed_out: false })
          : anyRoute(call),
      );
      const res = await (await c.computers.get('vm-1')).exec('true');
      expect(res.exitCode).toBe(-1);
      expect(res.ok).toBe(false);
    }
  });

  it('refuses to open a URL on a Windows guest rather than sending a POSIX command', async () => {
    // cmd.exe answering "'nohup' is not recognized" through an ExecResult
    // reads as anything but what actually went wrong.
    const { client: c } = client(() => json({ ...COMPUTER, os: 'windows' }));
    const computer = await c.computers.get('vm-1');
    await expect(computer.open('https://example.com')).rejects.toThrow(/Linux-only/);
  });
});

describe('files', () => {
  it('writes a string as UTF-8 and reports what landed', async () => {
    const { rec, client: c } = client(anyRoute);
    const written = await (await c.computers.get('vm-1')).writeFile('/tmp/a.txt', 'hello');
    expect(rec.last().raw && new TextDecoder().decode(rec.last().raw)).toBe('hello');
    expect(rec.last().query.path).toBe('/tmp/a.txt');
    expect(written).toBe(5);
  });

  it('reads bytes back, and text on request', async () => {
    const { client: c } = client(anyRoute);
    const computer = await c.computers.get('vm-1');
    expect(await computer.readTextFile('/tmp/a.txt')).toBe('file');
  });
});

describe('snapshots', () => {
  it('keeps unreachable placeholders when filtering to one computer', async () => {
    // A partial listing APPENDS one stub per snapshot it could not reach, with
    // no computer_id on it. Filtering on equality deletes precisely the markers
    // that say something is missing, and then reports a confident count.
    const { client: c } = client(() =>
      json([SNAPSHOT, { id: 'snap-2', computer_id: 'vm-2' }, { id: 'snap-3', unreachable: true }]),
    );
    const rows = await c.snapshots.list({ computerId: 'vm-1' });
    expect(rows.map((s) => s.id)).toEqual(['snap-1', 'snap-3']);
    expect(rows[1]!.unreachable).toBe(true);
  });

  it('reads the fingerprint that binds a purge to a set', async () => {
    const { client: c } = client((call) =>
      call.method === 'GET' && call.path === '/computers/vm-1/snapshots'
        ? json({ count: 3, size_bytes: 9_000, fingerprint: 'abc123' })
        : anyRoute(call),
    );
    const held = await (await c.computers.get('vm-1')).holdings();
    expect(held).toMatchObject({ count: 3, sizeBytes: 9_000, fingerprint: 'abc123' });
  });

  it('refuses a purge that is not bound to a set anybody looked at', async () => {
    const { client: c } = client(anyRoute);
    const computer = await c.computers.get('vm-1');
    await expect(computer.delete({ deleteSnapshots: true })).rejects.toThrow(/holdings\(\)/);
  });

  it('sends the interlock when it has one', async () => {
    const { rec, client: c } = client(() => json({ snapshots_deleted: 3 }));
    const computer = await c.computers.get('vm-1');
    const purged = await computer.delete({ deleteSnapshots: true, expect: 'abc123' });
    expect(rec.last().query).toEqual({ snapshots: 'delete', expect: 'abc123' });
    expect(purged).toBe(3);
  });

  it('does not claim nothing was destroyed when the platform did not say', async () => {
    // `?? 0` here would be a false statement about an irreversible act.
    const { client: c } = client((call) => (call.method === 'DELETE' ? json({}) : anyRoute(call)));
    expect(await (await c.computers.get('vm-1')).delete()).toBeUndefined();
  });
});

describe('ephemeral', () => {
  it('deletes the computer when the block ends', async () => {
    const { rec, client: c } = client(anyRoute);
    await c.computers.ephemeral({ template: 'base' }, async (computer) => {
      expect(computer.id).toBe('vm-1');
    });
    expect(rec.routes()).toContainEqual(['DELETE', 'computers/vm-1']);
  });

  it('deletes it even when the block throws, and lets the block error out', async () => {
    const { rec, client: c } = client(anyRoute);
    await expect(
      c.computers.ephemeral({ template: 'base' }, async () => {
        throw new Error('the work failed');
      }),
    ).rejects.toThrow('the work failed');
    expect(rec.routes()).toContainEqual(['DELETE', 'computers/vm-1']);
  });

  it('does not let a cleanup failure replace the error the block was throwing', async () => {
    // Hiding the actual fault behind a secondary one is the worst outcome here.
    const { client: c } = client((call) =>
      call.method === 'DELETE' ? errorJson(409, 'a snapshot is in flight') : anyRoute(call),
    );
    await expect(
      c.computers.ephemeral({ template: 'base' }, async () => {
        throw new Error('the work failed');
      }),
    ).rejects.toThrow('the work failed');
  });

  it('reports a delete that failed after the block succeeded, naming the machine', async () => {
    // Swallowed, this is a billable machine leaking with nothing ever going to
    // mention it — the opposite of the failing-block case above, where the
    // block's own error is the one that must survive.
    const { client: c } = client((call) =>
      call.method === 'DELETE' ? errorJson(409, 'a snapshot is in flight') : anyRoute(call),
    );
    await expect(c.computers.ephemeral({ template: 'base' }, async () => 'done')).rejects.toThrow(
      /vm-1.*still billable/,
    );
  });

  it('does not call a machine the block already deleted itself "still billable"', async () => {
    // delete({ deleteSnapshots: true, expect }) inside the block is the
    // documented way to purge snapshots; the wrapper's own delete then answers
    // 404, which is the goal state already reached — and the block's result
    // must survive it, not be replaced by a false claim.
    const { client: c } = client((call) =>
      call.method === 'DELETE' ? errorJson(404, 'no such computer') : anyRoute(call),
    );
    await expect(
      c.computers.ephemeral({ template: 'base' }, async () => 'an hour of work'),
    ).resolves.toBe('an hour of work');
  });

  it('treats an already-gone machine as cleaned up at the end of `await using` too', async () => {
    const { client: c } = client((call) =>
      call.method === 'DELETE' ? errorJson(404, 'no such computer') : anyRoute(call),
    );
    const attempt = async () => {
      await using computer = await c.computers.ephemeral({ template: 'base' });
      return computer.id;
    };
    await expect(attempt()).resolves.toBe('vm-1');
  });

  it('says which machine an `await using` block failed to delete', async () => {
    const { client: c } = client((call) =>
      call.method === 'DELETE' ? errorJson(409, 'a snapshot is in flight') : anyRoute(call),
    );
    const attempt = async () => {
      await using computer = await c.computers.ephemeral({ template: 'base' });
      expect(computer.id).toBe('vm-1');
    };
    await expect(attempt()).rejects.toThrow(/vm-1.*still billable/);
  });

  it('destroys itself at the end of an `await using` block', async () => {
    const { rec, client: c } = client(anyRoute);
    {
      await using computer = await c.computers.ephemeral({ template: 'base' });
      expect(computer.id).toBe('vm-1');
    }
    expect(rec.routes()).toContainEqual(['DELETE', 'computers/vm-1']);
  });

  it('does not put a self-destruct on an ordinary handle', async () => {
    // `await using c = await client.computers.get(id)` must not delete somebody's
    // machine.
    const { client: c } = client(anyRoute);
    const computer = await c.computers.get('vm-1');
    expect((computer as never as Record<symbol, unknown>)[Symbol.asyncDispose]).toBeUndefined();
  });
});

describe('the agent loop', () => {
  it('does not throw away the result of a run that ended unfinished', async () => {
    // max_steps leaves real work on the desktop, and discarding the result would
    // discard the only account of what was done to the machine.
    const { client: c } = client((call) =>
      call.path.endsWith('/agent')
        ? json({ steps: 20, stop: 'max_steps', text: 'got partway' })
        : anyRoute(call),
    );
    const res = await (await c.computers.get('vm-1')).agentOnce({
      prompt: 'go',
      modelKey: 'sk',
    });
    expect(res.finished).toBe(false);
    expect(res.stop).toBe('max_steps');
    expect(res.text).toBe('got partway');
  });

  it('throws when the stream ends with no result at all', async () => {
    const { client: c } = client((call) =>
      call.path.endsWith('/agent')
        ? new Response('event: step\ndata: {"n":1}\n\n', {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          })
        : anyRoute(call),
    );
    await expect(
      (await c.computers.get('vm-1')).agent({ prompt: 'go', modelKey: 'sk' }),
    ).rejects.toThrow(MandalaError);
  });
});

describe('power', () => {
  it('reads the computer off the action response rather than re-fetching it', async () => {
    const { rec, client: c } = client(anyRoute);
    const computer = await c.computers.get('vm-1');
    rec.calls.length = 0;
    await computer.start();
    expect(rec.routes()).toEqual([['POST', 'computers/vm-1/start']]);
  });

  it('refreshes when the platform answered a power action with nothing', async () => {
    // A handle that reported the state the machine was in before the call would
    // be worse than a second round trip.
    const { rec, client: c } = client((call) =>
      call.path.endsWith('/start') ? new Response(null, { status: 204 }) : anyRoute(call),
    );
    const computer = await c.computers.get('vm-1');
    rec.calls.length = 0;
    await computer.start();
    expect(rec.routes()).toEqual([
      ['POST', 'computers/vm-1/start'],
      ['GET', 'computers/vm-1'],
    ]);
  });
});
