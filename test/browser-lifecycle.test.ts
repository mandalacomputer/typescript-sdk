import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { BrowserCDP } from '../src/browser-cdp.js';
import type { BrowserConnection } from '../src/browser-connection.js';

vi.mock('ws', () => ({
  default: class extends EventEmitter {
    count = 0;
    ended = false;
    constructor() {
      super();
      queueMicrotask(() => this.emit('open'));
    }
    message(value: unknown) {
      this.emit('message', Buffer.from(JSON.stringify(value)));
    }
    send(raw: string, callback: () => void) {
      const { id, method } = JSON.parse(raw);
      queueMicrotask(() => {
        if (method === 'Target.createTarget') {
          const targetId = `tab-${++this.count}`;
          if (this.count === 2) {
            // CDP may announce destruction before delivering the create response.
            this.message({ method: 'Target.targetDestroyed', params: { targetId } });
            this.message({ id, result: { targetId } });
          } else {
            this.message({ id, result: { targetId } });
            this.message({
              method: 'Target.attachedToTarget',
              params: {
                sessionId: `session-${this.count}`,
                targetInfo: { targetId, type: 'page', browserContextId: 'context' },
              },
            });
          }
        } else {
          this.message({
            id,
            result:
              method === 'Target.createBrowserContext'
                ? { browserContextId: 'context' }
                : method === 'Runtime.evaluate'
                  ? { result: { value: 'Remaining page' } }
                  : {},
          });
        }
        callback();
      });
    }
    terminate() {
      if (!this.ended) {
        this.ended = true;
        this.emit('close');
      }
    }
  },
}));

it('handles target destruction before createTarget replies without losing other tabs', async () => {
  const backend = new BrowserCDP(
    async () => ({ id: 'grant', url: 'ws://unused', token: 'unused' }) as BrowserConnection,
    async () => {},
    async () => {},
  );
  try {
    await backend.start();
    await expect(backend.perform('new_tab', {})).rejects.toThrow('closed during initialization');
    expect(backend.state().tabs).toEqual([
      expect.objectContaining({ tab_id: 'tab-1', active: true }),
    ]);
    await expect(backend.perform('get_page_text', {})).resolves.toBe('Remaining page');
  } finally {
    await backend.close();
  }
}, 2000);
