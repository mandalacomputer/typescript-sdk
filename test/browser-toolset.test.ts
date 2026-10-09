import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { ToolError, ToolsetConfigError } from '@anthropic-ai/sdk/helpers/beta/toolsets';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MandalaBrowserToolset } from '../src/anthropic.js';
import { BrowserConnection, Client, type Computer } from '../src/index.js';
import { BASE, json, recorder } from './harness.js';

const id = 'a'.repeat(32),
  token = `bcdp_${'b'.repeat(64)}`;
const payload = {
  id,
  url: `wss://api.test/api/v1/computers/vm-1/browser-connections/${id}/cdp`,
  token,
  expires_at: '2026-10-09T01:00:00Z',
};
const use = (name: string, input: Record<string, unknown> = {}) => ({
  type: 'tool_use' as const,
  id: 'toolu_browser',
  name,
  toolset_name: 'browser',
  input,
});
type Result = Awaited<ReturnType<MandalaBrowserToolset['toolResult']>>;
const content = (result: Result) => result.content as unknown as Array<Record<string, unknown>>;
const text = (result: Result) =>
  content(result)
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
const tabs = (result: Result) =>
  content(result).find((b) => b.type === 'browser_state')!.tabs as Array<{
    tab_id: string;
    active: boolean;
  }>;
const success = (result: Result) => {
  expect(result.is_error, text(result)).not.toBe(true);
  return result;
};
const ref = (result: Result, description: string) => ({
  type: 'ref',
  ref: /\[(e\d+)\]/.exec(
    text(result)
      .split('\n')
      .find((line) => line.includes(description))!,
  )![1],
});

it('creates and revokes a capability without leaking its token in logging', async () => {
  const rec = recorder((call) =>
    json(
      call.path.endsWith('/browser-connections')
        ? payload
        : call.method === 'DELETE'
          ? { ok: true }
          : { id: 'vm-1', status: 'running' },
    ),
  );
  const client = new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch });
  const c = await client.computers.get('vm-1');
  const grant = await c.createBrowserConnection();
  expect(grant.token).toBe(token);
  expect(JSON.stringify(grant)).not.toContain(token);
  expect(rec.last().body).toEqual({});
  await c.revokeBrowserConnection(grant.id);
  expect(rec.last().path).toBe(`/computers/vm-1/browser-connections/${id}`);
  expect(rec.last().method).toBe('DELETE');
  await expect(c.revokeBrowserConnection('../escape')).rejects.toThrow('connectionId');
});

it.each([
  ['url', 'wss://evil.test/cdp'],
  ['url', `${payload.url}?token=secret`],
  ['token', 'not-a-token'],
  ['id', '../escape'],
  ['expires_at', '2026-10-09T01:00:00'],
  ['expires_at', {}],
])('rejects invalid %s without echoing credentials', (field, value) => {
  expect(() =>
    BrowserConnection.fromApi(
      { ...payload, [String(field)]: value },
      BASE,
      'computers/vm-1/browser-connections',
    ),
  ).toThrow('invalid browser connection response');
});

it('disables uploads and gates JavaScript without opening a connection', async () => {
  const computer = {
    createBrowserConnection: vi.fn(),
    revokeBrowserConnection: vi.fn(),
  } as unknown as Computer;
  const browser = new MandalaBrowserToolset(computer);
  try {
    expect(browser.toJSON().configs?.file_upload?.enabled).toBe(false);
    const result = await browser.toolResult(use('javascript_exec', { text: '1+1' }));
    expect(result.is_error).toBe(true);
    expect(computer.createBrowserConnection).not.toHaveBeenCalled();
    expect(
      () =>
        new MandalaBrowserToolset(computer, { configs: { javascript_exec: { enabled: true } } }),
    ).toThrow(ToolsetConfigError);
  } finally {
    await browser.close();
  }
});

const executable = process.env.MANDALA_TEST_CHROMIUM;
describe.skipIf(!executable)('real Chromium through Anthropic toolResult', () => {
  let chrome: ChildProcess | undefined, server: Server | undefined, profile: string | undefined;
  const browsers: MandalaBrowserToolset[] = [];
  afterEach(async () => {
    for (const browser of browsers.splice(0)) await browser.close();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
    if (chrome) {
      const exit = once(chrome, 'exit');
      chrome.kill();
      await exit;
      chrome = undefined;
    }
    if (profile) await rm(profile, { recursive: true, force: true });
  });
  async function fixture(options: ConstructorParameters<typeof MandalaBrowserToolset>[1] = {}) {
    profile = await mkdtemp(join(tmpdir(), 'mandala-browser-test-'));
    chrome = spawn(
      executable!,
      [
        '--headless',
        '--no-sandbox',
        '--no-first-run',
        '--remote-debugging-port=0',
        `--user-data-dir=${profile}`,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    const lines = createInterface({ input: chrome.stderr! });
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Chromium did not expose CDP')), 10000);
      lines.on('line', (line) => {
        if (line.includes('DevTools listening on ')) {
          clearTimeout(timer);
          resolve(line.trim().split(' ').at(-1)!);
        }
      });
      chrome!.once('error', reject);
    });
    const grant = Object.assign(
      BrowserConnection.fromApi(payload, BASE, 'computers/vm-1/browser-connections'),
      { url },
    );
    const revoke = vi.fn(async () => {});
    const computer = {
      createBrowserConnection: async () => grant,
      revokeBrowserConnection: revoke,
    } as unknown as Computer;
    const browser = new MandalaBrowserToolset(computer, options);
    browsers.push(browser);
    const hits: string[] = [];
    server = createServer((req, res) => {
      hits.push(req.url!);
      if (req.url === '/redirect') {
        res.writeHead(302, { Location: '/blocked' });
        res.end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/html',
        ...(req.url === '/download'
          ? { 'Content-Disposition': 'attachment; filename="private.txt"' }
          : {}),
      });
      res.end(
        `<title>Driver test</title><label>Name <input id="name"></label><label>Agree <input id="agree" type="checkbox"></label><button onclick="document.getElementById('result').textContent=document.getElementById('name').value">Apply</button><p id="result">pending</p><button onclick="alert('hello')">Dialog</button><a href="/download" download>Download</a>`,
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no address');
    return { browser, revoke, hits, base: `http://127.0.0.1:${address.port}` };
  }

  it('navigates, resolves DOM refs, enters forms, clicks, captures, manages tabs, and refuses redirect destinations', async () => {
    const seen: string[] = [];
    const { browser, revoke, hits, base } = await fixture({
      urlPolicy: (_ctx, url) => {
        seen.push(url);
        if (url.endsWith('/blocked')) throw new ToolError('not permitted');
      },
    });
    const nav = success(await browser.toolResult(use('navigate', { url: base })));
    const tab = tabs(nav)[0]!.tab_id;
    const page = success(await browser.toolResult(use('read_page', { filter: 'interactive' })));
    const name = ref(page, 'textbox Name');
    success(await browser.toolResult(use('form_input', { target: name, value: 'Mandala' })));
    success(await browser.toolResult(use('left_click', { target: ref(page, 'button Apply') })));
    expect(text(success(await browser.toolResult(use('get_page_text'))))).toContain('Mandala');
    const shot = success(await browser.toolResult(use('screenshot')));
    const image = content(shot).find((b) => b.type === 'image')!;
    const png = Buffer.from((image.source as { data: string }).data, 'base64');
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(png.readUInt32BE(16)).toBe(1280);
    expect(
      (
        await browser.toolResult(
          use('left_click', { target: { type: 'coordinate', x: 1280, y: 0 } }),
        )
      ).is_error,
    ).toBe(true);
    success(await browser.toolResult(use('new_tab')));
    expect(
      tabs(success(await browser.toolResult(use('switch_tab', { tab_id: tab })))),
    ).toHaveLength(2);
    const refused = await browser.toolResult(use('navigate', { url: `${base}/redirect` }));
    expect(refused.is_error).toBe(true);
    expect(hits).not.toContain('/blocked');
    expect(seen).toContain(`${base}/blocked`);
    expect((await browser.toolResult(use('left_click', { target: name }))).is_error).toBe(true);
    await browser.close();
    expect(revoke).toHaveBeenCalledExactlyOnceWith(id);
    expect(JSON.stringify(refused)).not.toContain(token);
  }, 30000);

  it('confirms enabled JavaScript, rejects invalid bounds, and aborts a pending action', async () => {
    const confirm = vi.fn((_ctx: { member: string }) => true);
    const { browser, base, revoke } = await fixture({
      configs: { javascript_exec: { enabled: true } },
      confirm,
    });
    success(await browser.toolResult(use('navigate', { url: base })));
    expect(
      text(success(await browser.toolResult(use('javascript_exec', { text: '6 * 7' })))),
    ).toContain('42');
    expect(confirm.mock.calls.some(([ctx]) => ctx.member === 'javascript_exec')).toBe(true);
    expect((await browser.toolResult(use('wait', { duration: 31 }))).is_error).toBe(true);
    const controller = new AbortController();
    const toolUse = use('wait', { duration: 30 });
    const call = browser.run(
      { signal: controller.signal, toolUse, toolUseBlock: toolUse },
      toolUse,
    );
    setTimeout(() => controller.abort(), 30);
    await expect(call).rejects.toThrow();
    expect(revoke).toHaveBeenCalledExactlyOnceWith(id);
    const ended = await browser.toolResult(use('screenshot'));
    expect(ended.is_error).toBe(true);
    expect(text(ended)).toContain('Browser connection ended');
  }, 30000);
});
