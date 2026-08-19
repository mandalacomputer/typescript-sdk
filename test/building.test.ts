/**
 * The bodies and paths, tested without any IO.
 *
 * Everything here is a refusal that happens before a request is made. The
 * platform refuses each of them too — these exist so a caller learns from a
 * stack trace at the call site rather than from a 400 a round trip later.
 */

import { describe, expect, it } from 'vitest';
import * as P from '../src/paths.js';

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

  it('rejects a direction the platform has no verb for', () => {
    expect(() => P.scrollBody({ direction: 'sideways' as never, amount: 1 })).toThrow(/one of/);
  });
});

describe('execBody', () => {
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
});

describe('openUrlCommand', () => {
  it('names a browser rather than asking for one', () => {
    // xdg-open and friends are all on the base image and all exit 0 while
    // launching nothing, because the image's default-browser association points
    // at a desktop entry it does not ship.
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
});
