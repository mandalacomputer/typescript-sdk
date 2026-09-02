/**
 * The bodies and paths, tested without any IO.
 *
 * Everything here is a refusal that happens before a request is made. The
 * platform refuses each of them too — these exist so a caller learns from a
 * stack trace at the call site rather than from a 400 a round trip later.
 */

import { describe, expect, it } from 'vitest';
import * as P from '../src/paths.js';

describe('clipboardBody', () => {
  it('sends the text as the one field the platform decodes', () => {
    expect(P.clipboardBody('hello')).toEqual({ text: 'hello' });
  });

  it('refuses empty text rather than sending a 400 to find out', () => {
    // The platform refuses it too, and the refusal is worth making here for the
    // reason at the top of this file plus one of its own: clearing the
    // clipboard is not what that endpoint does, and a caller who meant to clear
    // it should be told so rather than shown a status code.
    expect(() => P.clipboardBody('')).toThrow(/must not be empty/);
  });

  it('refuses a NUL, which would otherwise land and be reported as a failure', () => {
    // The platform confirms a write by reading the selection back through a
    // command substitution, and a shell truncates one at the first NUL. So the
    // write succeeds, the read-back disagrees, and the answer is a 409 inviting
    // a retry at something that has already worked — forever.
    expect(() => P.clipboardBody('a\0b')).toThrow(/NUL/);
  });

  it('refuses unpaired surrogates rather than silently replacing them', () => {
    expect(() => P.clipboardBody('\ud800')).toThrow(/unpaired surrogate/);
    expect(() => P.clipboardBody('\udfff')).toThrow(/unpaired surrogate/);
    expect(() => P.clipboardBody('before\ud800after')).toThrow(/unpaired surrogate/);
    expect(() => P.clipboardBody('before\udfffafter')).toThrow(/unpaired surrogate/);

    // A valid pair is one Unicode scalar value and must still be accepted.
    expect(P.clipboardBody('\ud83d\ude00')).toEqual({ text: '\u{1f600}' });
  });

  it('counts the cap in bytes, not characters', () => {
    // An emoji is four UTF-8 bytes, so a string a quarter the cap in LENGTH is
    // exactly at it — and a `text.length` check would have let four times the
    // legal payload through to an execve that answers E2BIG.
    expect(() => P.clipboardBody('x'.repeat(P.MAX_CLIPBOARD_BYTES))).not.toThrow();
    expect(() => P.clipboardBody('x'.repeat(P.MAX_CLIPBOARD_BYTES + 1))).toThrow(/at most/);
    expect(() => P.clipboardBody('\u{1F600}'.repeat(P.MAX_CLIPBOARD_BYTES / 4))).not.toThrow();
    expect(() => P.clipboardBody('\u{1F600}'.repeat(P.MAX_CLIPBOARD_BYTES / 4 + 1))).toThrow(
      /at most/,
    );
  });

  it('says what it was given when it was not a string', () => {
    // Every JS caller can hand this anything, and without the check the next
    // line throws a bare "Cannot read properties of undefined" — the one
    // refusal on this surface that would not say what was wrong.
    expect(() => P.clipboardBody(undefined as unknown as string)).toThrow(/must be a string/);
    expect(() => P.clipboardBody(null as unknown as string)).toThrow(/not null/);
  });
});

describe('createBody', () => {
  it('omits what was not set, so template defaults survive', () => {
    expect(P.createBody({ template: 'base' })).toEqual({ template: 'base', start: true });
  });

  it('maps camelCase to the wire names', () => {
    expect(P.createBody({ cpu: 2, ramMb: 4096, diskGb: 40, start: false })).toEqual({
      cpu: 2,
      ram_mb: 4096,
      disk_gb: 40,
      start: false,
    });
  });

  it('refuses a size combined with what a size already names', () => {
    expect(() => P.createBody({ size: 'large', cpu: 2 })).toThrow(/size alone/);
    expect(() => P.createBody({ size: 'large', template: 'base' })).toThrow(/size alone/);
    expect(() => P.createBody({ size: 'large' })).not.toThrow();
  });

  it('refuses an all-whitespace name', () => {
    expect(() => P.createBody({ name: '  ' })).toThrow(/must not be empty/);
  });
});

describe('updateBody', () => {
  it('keeps a null idle window, which means "follow the host"', () => {
    expect(P.updateBody({ idleSuspendMin: null })).toEqual({ idle_suspend_min: null });
    expect(P.updateBody({ idleSuspendMin: 30 })).toEqual({ idle_suspend_min: 30 });
  });

  it('refuses an empty patch and an empty name', () => {
    expect(() => P.updateBody({})).toThrow(/nothing to update/);
    expect(() => P.updateBody({ name: '  ' })).toThrow(/must not be empty/);
  });
});

describe('numbers that would go out as null', () => {
  // JSON.stringify writes a NaN as `null`, and the platform reads that as the
  // field's zero value — or, on the idle window, as "follow the host". The
  // request succeeds, configured as nobody asked, and nothing says so.
  it('refuses a non-finite shape on create', () => {
    expect(() => P.createBody({ cpu: Number.NaN })).toThrow(/cpu must be a finite number/);
    expect(() => P.createBody({ ramMb: Number.POSITIVE_INFINITY })).toThrow(/ramMb/);
    expect(() => P.createBody({ diskGb: Number.NaN })).toThrow(/diskGb/);
  });

  it('refuses a non-finite shape or idle window on update', () => {
    expect(() => P.updateBody({ cpu: Number.NaN })).toThrow(/cpu must be a finite number/);
    expect(() => P.updateBody({ idleSuspendMin: Number.NaN })).toThrow(/idleSuspendMin/);
    // Null stays a real value on that field: it is how a caller says "follow
    // the host's own window", and is the reason a NaN is worth catching.
    expect(() => P.updateBody({ idleSuspendMin: null })).not.toThrow();
  });

  it('refuses a negative or fractional shape rather than sending it', () => {
    expect(() => P.createBody({ cpu: -1 })).toThrow(/positive integer/);
    expect(() => P.createBody({ ramMb: 1.5 })).toThrow(/positive integer/);
    expect(() => P.updateBody({ diskGb: 0 })).toThrow(/positive integer/);
    expect(() => P.updateBody({ idleSuspendMin: -1 })).toThrow(/non-negative integer/);
    expect(() => P.updateBody({ idleSuspendMin: 1.5 })).toThrow(/non-negative integer/);
  });

  it('refuses a non-positive exec timeout', () => {
    expect(() => P.execBody({ command: 'ls', timeoutS: -1 })).toThrow(/positive/);
    expect(() => P.execBody({ command: 'ls', timeoutS: Number.NaN })).toThrow(/finite/);
    expect(() => P.execBody({ command: 'ls', timeoutS: 0 })).toThrow(/positive/);
  });

  it('refuses a pid that is not one, rather than pathing to it', () => {
    // `computers/vm-1/exec/NaN` is a 404 about a route, not a sentence about
    // the pid that was wrong.
    expect(() => P.execHandle('vm-1', Number.NaN)).toThrow(/pid must be a positive integer/);
    expect(() => P.execHandle('vm-1', 0)).toThrow(/pid/);
    expect(() => P.execHandle('vm-1', 12.5)).toThrow(/pid/);
    expect(P.execHandle('vm-1', 42)).toBe('computers/vm-1/exec/42');
  });

  it('refuses an all-whitespace name on the routes that take an optional one', () => {
    // updateBody and snapshotBody both refuse one; a clone should not be the
    // way to get a computer called "  ".
    expect(() => P.nameBody('  ')).toThrow(/must not be empty/);
    expect(P.nameBody()).toEqual({});
    expect(P.nameBody('fork')).toEqual({ name: 'fork' });
  });
});

describe('input bodies', () => {
  it('omits the coordinate when there is none, rather than sending 0,0', () => {
    // "Where the pointer is" and "the corner of the screen" are different
    // requests, and the platform carries the distinction all the way down.
    expect(P.clickBody('left_click')).toEqual({ action: 'left_click' });
    expect(P.clickBody('left_click', 0, 0)).toEqual({ action: 'left_click', x: 0, y: 0 });
  });

  it('refuses half a coordinate rather than filling in a zero', () => {
    expect(() => P.clickBody('left_click', 5)).toThrow(/both x and y/);
    expect(() => P.buttonBody('left_mouse_down', undefined, 5)).toThrow(/both x and y/);
    expect(() => P.scrollBody({ direction: 'down', amount: 3, x: 5 })).toThrow(/both x and y/);
  });

  it('refuses half a drag origin', () => {
    expect(() => P.dragBody(9, 9, 1)).toThrow(/both fromX and fromY/);
    expect(P.dragBody(9, 9)).toEqual({ action: 'left_click_drag', coordinate: [9, 9] });
    expect(P.dragBody(9, 9, 1, 2)).toEqual({
      action: 'left_click_drag',
      coordinate: [9, 9],
      start_coordinate: [1, 2],
    });
  });

  it('scrolls with `coordinate`, not the flat pair', () => {
    // The platform reads a flat x:0,y:0 on a scroll as "no position", because
    // that is what the Python SDK sent for every defaulted scroll before the
    // keys became optional. `coordinate` has no such history, which is what
    // makes scroll(0, 0) mean the corner again.
    expect(P.scrollBody({ direction: 'up', amount: 3, x: 0, y: 0 })).toEqual({
      action: 'scroll',
      scroll_direction: 'up',
      amount: 3,
      coordinate: [0, 0],
    });
    expect(P.scrollBody({ direction: 'up', amount: 3 })).not.toHaveProperty('coordinate');
  });

  it('joins modifiers the way the platform reads them', () => {
    expect(P.clickBody('left_click', 1, 2, ['ctrl', 'shift']).text).toBe('ctrl+shift');
  });

  it('refuses an empty chord and a non-positive duration', () => {
    expect(() => P.keyBody([])).toThrow(/at least one key/);
    expect(() => P.holdKeyBody([], 1)).toThrow(/at least one key/);
    expect(() => P.holdKeyBody(['a'], 0)).toThrow(/positive/);
    expect(() => P.waitBody(0)).toThrow(/positive/);
  });

  it('refuses a wait past the platform cap rather than truncating it', () => {
    // A wait is a held HTTP request crossing a reverse proxy. 100 seconds would
    // not return, it would fail.
    expect(() => P.waitBody(31)).toThrow(/30 seconds/);
    expect(P.waitBody(30)).toEqual({ action: 'wait', duration: 30 });
  });

  it('refuses a held key past the same cap, for the same reason', () => {
    expect(() => P.holdKeyBody(['shift'], 31)).toThrow(/30 seconds/);
    expect(P.holdKeyBody(['shift'], 30)).toEqual({
      action: 'hold_key',
      keys: ['shift'],
      duration: 30,
    });
  });

  it('rejects a direction the platform has no verb for', () => {
    expect(() => P.scrollBody({ direction: 'sideways' as never, amount: 1 })).toThrow(/one of/);
  });
});

describe('execBody', () => {
  it('refuses a missing or empty command rather than sending none', () => {
    expect(() => P.execBody({ command: '' })).toThrow(/command must not be empty/);
    expect(() => P.execBody({ command: '   ' })).toThrow(/command must not be empty/);
    expect(() => P.execBody({ command: undefined as unknown as string })).toThrow(
      /command must not be empty/,
    );
  });

  it('omits session unless the desktop was asked for', () => {
    expect(P.execBody({ command: 'ls' })).toEqual({ command: 'ls' });
    expect(P.execBody({ command: 'ls', desktop: true }).session).toBe('desktop');
  });

  it('carries background and cwd only when set', () => {
    expect(P.execBody({ command: 'make', background: true, cwd: '/src' })).toEqual({
      command: 'make',
      background: true,
      cwd: '/src',
    });
  });

  it('refuses a relative cwd under the documented absolute-path contract', () => {
    expect(() => P.execBody({ command: 'make', cwd: 'src' })).toThrow(/cwd must be absolute/);
    expect(() => P.execBody({ command: 'make', cwd: '' })).toThrow(/cwd must be absolute/);
    expect(P.execBody({ command: 'make', cwd: 'C:\\src' }).cwd).toBe('C:\\src');
  });

  it('carries an environment, and omits an empty one', () => {
    expect(P.execBody({ command: 'make', env: { CI: '1' } }).env).toEqual({ CI: '1' });
    // No env and an empty env are the same request; sending the key would
    // claim the caller asked for something they did not.
    expect(P.execBody({ command: 'make', env: {} })).not.toHaveProperty('env');
  });

  it('copies the environment, so a later mutation cannot change the request', () => {
    const env: Record<string, string> = { TOKEN: 'a' };
    const body = P.execBody({ command: 'make', env });
    env.TOKEN = 'b';
    expect(body.env).toEqual({ TOKEN: 'a' });
  });

  it('refuses the entries that would not fail, they would mean something else', () => {
    // The guest agent takes KEY=value pairs, so a '=' in a name splits the
    // entry at the wrong place, and a NUL truncates whichever half holds it.
    // Both run the command with an environment nobody asked for, successfully.
    expect(() => P.execBody({ command: 'x', env: { 'A=B': 'c' } })).toThrow(/must not contain/);
    expect(() => P.execBody({ command: 'x', env: { 'A\0B': 'c' } })).toThrow(/must not contain/);
    expect(() => P.execBody({ command: 'x', env: { A: 'b\0c' } })).toThrow(/NUL/);
    expect(() => P.execBody({ command: 'x', env: { '': 'c' } })).toThrow(/empty name/);
  });

  it('names the key when a value is not a string', () => {
    // `{ TOKEN: process.env.TOKEN }` with the variable unset is the shape this
    // catches. Cast rather than checked, it reached .includes() and threw
    // "Cannot read properties of undefined", naming neither the parameter nor
    // the entry — the one refusal here that did not say what was wrong.
    const unset = { TOKEN: undefined } as unknown as Record<string, string>;
    expect(() => P.execBody({ command: 'x', env: unset })).toThrow(/"TOKEN" must be a string/);
    const numeric = { PORT: 8080 } as unknown as Record<string, string>;
    expect(() => P.execBody({ command: 'x', env: numeric })).toThrow(
      /must be a string, not number/,
    );
  });

  it('refuses more than the platform accepts, before the round trip', () => {
    const many = Object.fromEntries(
      Array.from({ length: P.MAX_ENV_ENTRIES + 1 }, (_, i) => [`K${i}`, 'v']),
    );
    expect(() => P.execBody({ command: 'x', env: many })).toThrow(/at most 64/);
    const long = { K: 'v'.repeat(P.MAX_ENV_ENTRY_BYTES) };
    expect(() => P.execBody({ command: 'x', env: long })).toThrow(/4096/);
  });

  it('measures an entry in bytes, as the platform does', () => {
    // A limit counted in characters passes a value the platform then refuses:
    // these are two bytes each, so 2048 of them are 4096 bytes and the entry is
    // over the line once the name and the '=' are added.
    const wide = { K: 'é'.repeat(2048) };
    expect(() => P.execBody({ command: 'x', env: wide })).toThrow(/4096/);
  });
});

describe('snapshotBody', () => {
  it('always sends memory, because false is a request and not an absence', () => {
    expect(P.snapshotBody(false)).toEqual({ memory: false });
    expect(P.snapshotBody(true)).toEqual({ memory: true });
  });

  it('omits an unset name, which is what asks the platform to generate one', () => {
    expect(P.snapshotBody(false, 'before-upgrade')).toEqual({
      memory: false,
      name: 'before-upgrade',
    });
    expect(() => P.snapshotBody(false, '  ')).toThrow(/must not be empty/);
  });
});

describe('openUrlCommand', () => {
  it('names a browser rather than asking for one', () => {
    // Firefox by name, so the choice of browser lives in this one function
    // rather than in whatever the guest's default handler resolves to.
    expect(P.openUrlCommand('https://example.com')).toBe(
      "nohup firefox 'https://example.com' >/dev/null 2>&1 &",
    );
  });

  it('quotes a URL so it reaches the browser as one argument', () => {
    const cmd = P.openUrlCommand("https://x.test/?a=1&b='2'");
    expect(cmd).toContain(`'https://x.test/?a=1&b='\\''2'\\'''`);
  });

  it('refuses what a browser would read as a flag', () => {
    expect(() => P.openUrlCommand('')).toThrow(/must not be empty/);
    expect(() => P.openUrlCommand('   ')).toThrow(/must not be empty/);
    expect(() => P.openUrlCommand('--version')).toThrow(/must not start with/);
  });
});

describe('filesQuery', () => {
  it('refuses a relative path, which has no working directory to be relative to', () => {
    expect(() => P.filesQuery('notes.txt')).toThrow(/must be absolute/);
    expect(P.filesQuery('/home/user/notes.txt')).toEqual({ path: '/home/user/notes.txt' });
  });

  it('accepts a Windows drive-letter path as the absolute path it is', () => {
    // Absolute has two spellings because there are two guest OSes. Requiring a
    // leading '/' made every file on a Windows guest unrepresentable.
    expect(P.filesQuery('C:\\Users\\dev\\out.txt')).toEqual({ path: 'C:\\Users\\dev\\out.txt' });
    expect(P.filesQuery('c:/temp/a.txt')).toEqual({ path: 'c:/temp/a.txt' });
    // C:relative.txt is cmd.exe's "relative to C:'s current directory" — which
    // is exactly the working directory a transfer does not have.
    expect(() => P.filesQuery('C:notes.txt')).toThrow(/must be absolute/);
  });

  it('accepts the other absolute Windows spellings: a UNC share and the \\\\?\\ form', () => {
    // A network-share file on a domain-joined guest is absolute with no drive
    // letter in sight; refusing it re-opened the unrepresentable-file class
    // the drive-letter fix closed.
    expect(P.filesQuery('\\\\fileserver\\share\\out.txt')).toEqual({
      path: '\\\\fileserver\\share\\out.txt',
    });
    expect(P.filesQuery('\\\\?\\C:\\very\\long\\path.txt')).toEqual({
      path: '\\\\?\\C:\\very\\long\\path.txt',
    });
    // A single backslash is still Windows drive-relative, not absolute.
    expect(() => P.filesQuery('\\notes.txt')).toThrow(/must be absolute/);
  });
});

describe('screenshotQuery', () => {
  it('distinguishes no width from a zero one', () => {
    // Truthiness silently converted screenshot(0) — the natural result of a
    // miscomputed thumbnail scale — into the full-resolution call.
    expect(P.screenshotQuery()).toBeUndefined();
    expect(P.screenshotQuery(320)).toEqual({ w: 320 });
    expect(() => P.screenshotQuery(0)).toThrow(/positive/);
    expect(() => P.screenshotQuery(-5)).toThrow(/positive/);
  });

  it('asks for an uncached frame only when told to', () => {
    // The bare call builds the URL it built before `fresh` existed — an empty
    // object here would put a '?' on every screenshot the SDK has ever taken.
    expect(P.screenshotQuery(undefined, false)).toBeUndefined();
    expect(P.screenshotQuery(undefined, true)).toEqual({ fresh: 1 });
    expect(P.screenshotQuery(320, false)).toEqual({ w: 320 });
  });

  it('refuses fresh alongside a width, which the platform would ignore', () => {
    // The platform's handler branches on `w` and returns the thumbnail before
    // it reads `fresh` — and builds that thumbnail off the cached frame. So
    // this combination promised an uncached frame and delivered a doubly-cached
    // one, silently, on the call the docs tell a drive loop to make.
    expect(() => P.screenshotQuery(320, true)).toThrow(/cannot be combined with a width/);
  });

  it('checks the width even alongside fresh', () => {
    expect(() => P.screenshotQuery(0, true)).toThrow(/positive/);
  });
});

describe('stopQuery', () => {
  it('sends nothing for the graceful stop, which is the default', () => {
    expect(P.stopQuery()).toEqual({});
    expect(P.stopQuery(false)).toEqual({});
  });

  it("spells force the one way the daemon reads: 'true'", () => {
    // Compared as a string against "true" in api.go. Anything else — 1, yes,
    // TRUE — is a graceful stop reporting success, which is the failure the
    // caller reached for force to escape.
    expect(P.stopQuery(true)).toEqual({ force: 'true' });
  });
});

describe('deleteQuery', () => {
  it('sends nothing when the snapshots are being kept', () => {
    expect(P.deleteQuery({})).toEqual({});
    expect(P.deleteQuery({ deleteSnapshots: false })).toEqual({});
  });

  it('refuses a purge with no fingerprint to bind it to', () => {
    expect(() => P.deleteQuery({ deleteSnapshots: true })).toThrow(/holdings\(\)/);
  });

  it('binds the purge to the set that was read', () => {
    expect(P.deleteQuery({ deleteSnapshots: true, expect: 'abc' })).toEqual({
      snapshots: 'delete',
      expect: 'abc',
    });
  });
});

describe('scheduleBody', () => {
  it('bounds the clock', () => {
    expect(() => P.scheduleBody({ enabled: true, hour: 24 })).toThrow(/0-23/);
    // `tz` was the one field in this builder taken as given, between two that
    // are range-checked. TypeScript refuses these; this file is what a
    // JavaScript caller gets instead of `"[object Object]"` on the wire.
    for (const tz of [{}, 42, ['UTC'], null, true]) {
      expect(() => P.scheduleBody({ enabled: true, tz: tz as unknown as string })).toThrow(
        /tz must be a string/,
      );
    }
    expect(P.scheduleBody({ enabled: true, tz: 'Europe/London' }).tz).toBe('Europe/London');
    expect(() => P.scheduleBody({ enabled: true, hour: 4, minute: 60 })).toThrow(/0-59/);
    expect(P.scheduleBody({ enabled: true, hour: 4 })).toEqual({
      enabled: true,
      hour: 4,
      minute: 0,
      tz: 'UTC',
    });
  });
});

describe('windowBody', () => {
  it('rejects an action the platform has no verb for', () => {
    expect(() => P.windowBody({ action: 'wiggle' as never })).toThrow(/one of/);
  });
});

describe('agentBody', () => {
  it('refuses an empty prompt', () => {
    expect(() => P.agentBody({ prompt: '  ', stream: true })).toThrow(/must not be empty/);
  });
});

describe('computerPayload', () => {
  it('unwraps a create that built a machine which would not boot', () => {
    // Read as an ordinary computer the envelope is a computer with no id: the id
    // the platform went out of its way to return is the one thing dropped.
    const out = P.computerPayload({
      computer: { id: 'vm-1', status: 'stopped' },
      start_error: 'no host had room',
    });
    expect(out.id).toBe('vm-1');
    expect(out.start_error).toBe('no host had room');
  });

  it('leaves a plain computer alone', () => {
    expect(P.computerPayload({ id: 'vm-1' })).toEqual({ id: 'vm-1' });
  });

  it('does not invent a start_error key the platform never sent', () => {
    // raw claims to be the response verbatim; a `start_error: undefined` key
    // showing up in Object.keys() would not be.
    expect(P.computerPayload({ computer: { id: 'vm-1' } })).toEqual({ id: 'vm-1' });
  });

  it('answers with an empty record for a body that is not one', () => {
    expect(P.computerPayload(null)).toEqual({});
    expect(P.computerPayload([1, 2])).toEqual({});
  });
});

describe('path encoding', () => {
  it('encodes ids, so a stray slash cannot become another path segment', () => {
    expect(P.computer('a/b')).toBe('computers/a%2Fb');
    expect(P.snapshot('a b')).toBe('snapshots/a%20b');
    expect(P.windowPath('vm-1', '0x1?x')).toBe('computers/vm-1/windows/0x1%3Fx');
  });

  it('refuses an empty id rather than aiming at the collection route', () => {
    // encodeURIComponent('') is '', so an empty id does not 404 — it produces
    // `computers/`, and a get then decodes the whole listing as one computer.
    expect(() => P.computer('')).toThrow(/computer id must not be empty/);
    expect(() => P.snapshot('')).toThrow(/snapshot id must not be empty/);
    expect(() => P.windowPath('vm-1', '')).toThrow(/window id must not be empty/);
  });

  it('refuses dot-segment ids before URL parsing can rewrite the route', () => {
    expect(() => P.computer('.')).toThrow(/computer id/);
    expect(() => P.computer('..')).toThrow(/computer id/);
    expect(() => P.snapshot('..')).toThrow(/snapshot id/);
    expect(() => P.windowPath('vm-1', '.')).toThrow(/window id/);
  });
});

describe('finite numbers', () => {
  // A NaN passes every range check written as a comparison, and JSON.stringify
  // then writes it as `null` — which the platform reads as the field's zero
  // value. The call succeeds, at the wrong place, and nothing says so.
  it('refuses a NaN duration, which both range checks let through', () => {
    expect(() => P.waitBody(Number.NaN)).toThrow(/finite number/);
    expect(() => P.holdKeyBody(['ctrl'], Number.NaN)).toThrow(/finite number/);
    expect(() => P.waitBody(Number.POSITIVE_INFINITY)).toThrow(/finite number/);
  });

  it('refuses a NaN coordinate, which would click the corner of the screen', () => {
    expect(() => P.pointerBody('move', Number.NaN, 5)).toThrow(/finite number/);
    expect(() => P.clickBody('left_click', 5, Number.NaN)).toThrow(/finite number/);
    expect(() => P.buttonBody('left_mouse_down', Number.NaN, 5)).toThrow(/finite number/);
    expect(() => P.dragBody(Number.NaN, 5)).toThrow(/finite number/);
    expect(() => P.dragBody(1, 2, 3, Number.NaN)).toThrow(/finite number/);
  });

  it('refuses a NaN amount, max_steps, timeout or window geometry', () => {
    expect(() => P.scrollBody({ direction: 'down', amount: Number.NaN })).toThrow(/finite number/);
    expect(() => P.agentBody({ prompt: 'go', stream: true, maxSteps: Number.NaN })).toThrow(
      /positive integer/,
    );
    expect(() => P.execBody({ command: 'ls', timeoutS: Number.NaN })).toThrow(/finite number/);
    expect(() => P.windowBody({ action: 'move', x: Number.NaN, y: 2 })).toThrow(/finite number/);
  });

  it('refuses an agent step count the platform cannot execute', () => {
    for (const maxSteps of [0, -1, 1.5]) {
      expect(() => P.agentBody({ prompt: 'go', stream: true, maxSteps })).toThrow(
        /positive integer/,
      );
    }
  });

  it('still takes the zeros and the ordinary values', () => {
    expect(P.pointerBody('move', 0, 0)).toEqual({ action: 'move', x: 0, y: 0 });
    expect(P.waitBody(0.5)).toEqual({ action: 'wait', duration: 0.5 });
    expect(P.scrollBody({ direction: 'down', amount: 0 }).amount).toBe(0);
  });
});

describe('rangeHeader', () => {
  it('sends nothing at all for a whole-file read', () => {
    expect(P.rangeHeader()).toBeUndefined();
    expect(P.rangeHeaders()).toBeUndefined();
  });

  it('spells an offset and a length as an inclusive bytes= window', () => {
    // The off-by-one everybody writes once: last-byte-pos is inclusive, so a
    // 1024-byte window from 0 ends at 1023 and asking for 1024 reads one byte
    // too many.
    expect(P.rangeHeader(0, 1024)).toBe('bytes=0-1023');
    expect(P.rangeHeader(1024, 1024)).toBe('bytes=1024-2047');
    expect(P.rangeHeaders(100, 1)).toEqual({ Range: 'bytes=100-100' });
  });

  it('leaves an open-ended window open', () => {
    expect(P.rangeHeader(1048576)).toBe('bytes=1048576-');
    expect(P.rangeHeader(0)).toBe('bytes=0-');
  });

  it('reads a negative offset as the tail, in the spelling that stays one', () => {
    // `bytes=-N` and not `bytes=(total-N)-`: the suffix form is anchored at the
    // END, which is what keeps an over-long tail the tail of the file.
    expect(P.rangeHeader(-4096)).toBe('bytes=-4096');
  });

  it('takes a length with no offset as the first bytes of the file', () => {
    expect(P.rangeHeader(undefined, 512)).toBe('bytes=0-511');
  });

  it('refuses a tail with a length, which no byte range can express', () => {
    expect(() => P.rangeHeader(-100, 10)).toThrow(/cannot also take a length/);
  });

  it('refuses a window of no bytes, which is a 416 rather than an empty answer', () => {
    expect(() => P.rangeHeader(0, 0)).toThrow(/at least one byte/);
    expect(() => P.rangeHeader(10, -5)).toThrow(/at least one byte/);
  });

  it('refuses positions that are not whole numbers of bytes', () => {
    // A NaN reaches the header as the string "NaN", which the platform refuses
    // with a 400 a round trip later; a float reads as a byte position nothing
    // has.
    expect(() => P.rangeHeader(Number.NaN)).toThrow(/whole number of bytes/);
    expect(() => P.rangeHeader(1.5)).toThrow(/whole number of bytes/);
    expect(() => P.rangeHeader(0, Number.POSITIVE_INFINITY)).toThrow(/whole number of bytes/);
    expect(() => P.rangeHeader(Number.MAX_SAFE_INTEGER, 2)).toThrow(/whole number of bytes/);
  });
});

/**
 * The bodies a JavaScript caller can reach that TypeScript's overloads refuse.
 *
 * All of it one shape of mistake: this surface puts an optional positional
 * argument in front of `CallOptions`, and every other input method takes
 * `CallOptions` last, so `{ signal }` in the natural place binds to the
 * positional instead. Nothing threw, the gesture was sent, and the only thing
 * lost was the ability to cancel it — see OPL-4215.
 */
describe('an options object in a positional slot', () => {
  it('refuses a CallOptions bound to click() modifiers, rather than clicking uncancellably', () => {
    // `{ signal }.length` is undefined, so no `text` went on the wire and the
    // click was sent exactly as if no modifiers had been asked for.
    expect(() => P.clickBody('left_click', 100, 200, { signal: undefined } as never)).toThrow(
      /must be an array of key names/,
    );
    expect(() => P.clickBody('left_click', 100, 200, ['shift'])).not.toThrow();
    expect(P.clickBody('left_click', 100, 200).text).toBeUndefined();
  });

  it('refuses a non-string inside the modifier list too', () => {
    expect(() => P.clickBody('left_click', 1, 2, [null as never])).toThrow(/must be a string/);
  });

  it('refuses a CallOptions bound to scroll() modifiers, with advice scroll can take', () => {
    // The click advice is not merely unhelpful here, it is impossible: `scroll`
    // takes its modifiers as a NAMED option, so the positional slot the click
    // message describes does not exist on it.
    const bad = () =>
      P.scrollBody({ direction: 'down', amount: 3, modifiers: { signal: undefined } as never });
    expect(bad).toThrow(/scroll\(\) modifiers must be an array of key names/);
    expect(bad).toThrow(/already an option here/);
    expect(bad).not.toThrow(/click\(x, y/);
  });

  it('names the click method the caller actually called', () => {
    // Five methods reach `clickBody`, and a message naming `click()` at a
    // `rightClick` call site sends the reader to the wrong line.
    expect(() => P.clickBody('right_click', 1, 2, {} as never)).toThrow(/right_click\(x, y/);
    expect(() => P.clickBody('double_click', 1, 2, {} as never)).toThrow(/double_click\(x, y/);
  });

  it('refuses a key windowAction() geometry does not have, rather than sending it', () => {
    // The builder spreads its argument onto the body, so an options object
    // bound to `geometry` reached the platform as part of the request.
    const { signal } = new AbortController();
    expect(() => P.windowBody({ action: 'close', signal } as never)).toThrow(
      /geometry takes only x, y, width, height/,
    );
    expect(P.windowBody({ action: 'close' })).toEqual({ action: 'close' });
    expect(P.windowBody({ action: 'move', x: 300, y: 200 })).toEqual({
      action: 'move',
      x: 300,
      y: 200,
    });
  });

  it('takes an undefined value, which was never going to reach the wire anyway', () => {
    // Presence is not a value. The builder drops undefined keys on the way out,
    // so refusing one turns away a request that was correct — and a caller
    // spreading a partly-filled object is the same population the guard is for.
    expect(P.windowBody({ action: 'close', signal: undefined } as never)).toEqual({
      action: 'close',
    });
    expect(P.windowBody({ action: 'move', x: 1, y: 2, width: undefined })).toEqual({
      action: 'move',
      x: 1,
      y: 2,
    });
  });
});

/**
 * The builders that trimmed a value they had not checked was a string.
 *
 * Each of these failed closed — a `TypeError` from inside this SDK naming
 * neither the argument nor the call, which is the thing `requireString` exists
 * to end. `snapshotBody` and `createBody`'s own `name` were already right;
 * these were the ones the sweep missed (OPL-4215).
 */
describe('strings refused rather than trimmed unchecked', () => {
  it('names the argument when clone() is given an options object as a name', () => {
    expect(() => P.nameBody({ signal: undefined } as never)).toThrow(/name must be a string/);
    expect(P.nameBody('copy')).toEqual({ name: 'copy' });
    expect(P.nameBody()).toEqual({});
    expect(() => P.nameBody('   ')).toThrow(/must not be empty/);
  });

  it('names the argument when an update carries a non-string name', () => {
    expect(() => P.updateBody({ name: 42 as never })).toThrow(/name must be a string/);
  });

  it('names the argument when an agent run carries a non-string prompt', () => {
    expect(() => P.agentBody({ prompt: 42 as never, stream: false })).toThrow(
      /prompt must be a string/,
    );
  });

  it('names the argument when an agent run carries a non-string system or model', () => {
    // Same hole createBody closed for size/template/resolution: a JS object or
    // number passed through omitUndefined into JSON.stringify and reached the
    // platform as a JSON value where a string was meant (OPL-4215 leftover).
    expect(() => P.agentBody({ prompt: 'go', stream: false, system: 1 as never })).toThrow(
      /system must be a string/,
    );
    expect(() =>
      P.agentBody({ prompt: 'go', stream: false, model: { id: 'claude' } as never }),
    ).toThrow(/model must be a string/);
    expect(
      P.agentBody({ prompt: 'go', stream: false, system: 'be brief', model: 'claude' }),
    ).toEqual({ prompt: 'go', system: 'be brief', model: 'claude', stream: false });
  });

  it('refuses a create whose size, template or resolution is not a string', () => {
    // Not trimmed, so none of these threw locally: they passed through
    // `omitUndefined` into `JSON.stringify` and reached the platform as a JSON
    // object where a name was meant.
    expect(() => P.createBody({ size: { cpu: 2 } as never })).toThrow(/size must be a string/);
    expect(() => P.createBody({ template: 7 as never })).toThrow(/template must be a string/);
    expect(() => P.createBody({ resolution: [] as never })).toThrow(/resolution must be a string/);
    // `size` and `template` are mutually exclusive, so the valid case is one
    // of each rather than both.
    expect(P.createBody({ size: 'small' }).size).toBe('small');
    expect(P.createBody({ template: 'base', resolution: '1920x1080x24' }).template).toBe('base');
  });
});

describe('the chord itself', () => {
  it('refuses a bare string, which spreads into one key per character', () => {
    // `holdKey('shift', 1)` from JavaScript: a string is iterable, so `[...keys]`
    // was `['s','h','i','f','t']` — five keys held down, none of them the one
    // that was asked for, and nothing anywhere said so.
    expect(() => P.holdKeyBody('shift' as never, 1)).toThrow(/not a bare string/);
    expect(() => P.keyBody('ctrl' as never)).toThrow(/array of key names/);
  });

  it('refuses an empty key name, which is not a key', () => {
    expect(() => P.keyBody(['ctrl', ''])).toThrow(/one was empty/);
    expect(() => P.holdKeyBody(['shift', ''], 1)).toThrow(/one was empty/);
  });

  it('refuses a non-string keystroke rather than serializing it', () => {
    expect(() => P.keyBody(['ctrl', 3 as never])).toThrow(/must be a string/);
  });

  it('still takes the chords that were always valid', () => {
    expect(P.keyBody(['ctrl', 'c'])).toEqual({ action: 'key', keys: ['ctrl', 'c'] });
    expect(P.holdKeyBody(['shift'], 2)).toEqual({
      action: 'hold_key',
      keys: ['shift'],
      duration: 2,
    });
  });
});
