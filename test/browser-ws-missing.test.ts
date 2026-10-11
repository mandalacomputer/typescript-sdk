import { expect, it, vi } from 'vitest';
import { MandalaBrowserToolset } from '../src/anthropic.js';
import type { Computer } from '../src/index.js';

// As in a project that never installed the optional peer.
vi.mock('ws', () => {
  throw new Error("Cannot find package 'ws' imported from mandala-computer");
});

it('names the missing ws peer instead of a generic browser failure', async () => {
  const computer = {
    createBrowserConnection: vi.fn(),
    revokeBrowserConnection: vi.fn(),
  } as unknown as Computer;
  const browser = new MandalaBrowserToolset(computer);
  try {
    for (let n = 0; n < 2; n++) {
      const result = await browser.toolResult({
        type: 'tool_use',
        id: `toolu_${n}`,
        name: 'navigate',
        toolset_name: 'browser',
        input: { url: 'https://example.com' },
      });
      expect(result.is_error).toBe(true);
      expect(JSON.stringify(result.content)).toContain(
        "needs the optional 'ws' package (8.18 or newer). Install it with `npm install ws`",
      );
    }
    // Loaded before a grant is minted, so nothing was created to revoke.
    expect(computer.createBrowserConnection).not.toHaveBeenCalled();
    expect(browser.sessionStatus.terminalError).toContain("'ws'");
  } finally {
    await browser.close();
  }
});
