import { expect, it } from 'vitest';
import { type AgentArgs, Client } from '../src/index.js';
import { anyRoute, BASE, recorder } from './harness.js';

it.each(['agent', 'agentOnce', 'agentStream'] as const)(
  'forwards provider through %s and leaves defaults to the server',
  async (method) => {
    const rec = recorder(anyRoute);
    const client = new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch });
    const computer = await client.computers.get('vm-1');
    for (const provider of ['openai', 'anthropic', undefined] as const) {
      const args = { prompt: 'go', modelKey: 'fixture', model: 'custom-model', provider };
      if (method === 'agentStream') {
        for await (const _event of computer.agentStream(args)) {
          /* consume to completion */
        }
      } else await computer[method](args);
      expect(rec.last().body).toMatchObject({ model: 'custom-model' });
      if (provider === undefined) expect(rec.last().body).not.toHaveProperty('provider');
      else expect(rec.last().body).toHaveProperty('provider', provider);
      expect(rec.last().headers['X-Model-Key']).toBe('fixture');
    }
  },
);

it.each(['agent', 'agentOnce', 'agentStream'] as const)(
  'refuses an invalid provider before %s sends a request',
  async (method) => {
    const rec = recorder(anyRoute);
    const client = new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch });
    const computer = await client.computers.get('vm-1');
    const before = rec.calls.length;
    const args = { prompt: 'go', modelKey: 'fixture', provider: 'typo' } as unknown as AgentArgs;
    await expect(
      (async () => {
        if (method === 'agentStream') {
          for await (const _event of computer.agentStream(args)) {
            /* consume to completion */
          }
        } else await computer[method](args);
      })(),
    ).rejects.toThrow('provider');
    expect(rec.calls).toHaveLength(before);
  },
);
