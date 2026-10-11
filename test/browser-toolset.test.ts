import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { ToolError, ToolsetConfigError } from '@anthropic-ai/sdk/helpers/beta/toolsets';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserFilePolicy, MandalaBrowserToolset } from '../src/anthropic.js';
import { BrowserCDP, BrowserDriverError } from '../src/browser-cdp.js';
import { BrowserFiles } from '../src/browser-file-session.js';
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
  const client = new Client({
    apiKey: 'com_test',
    baseUrl: BASE,
    fetch: rec.fetch,
  });
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
  const filePolicy = { resolvePaths: vi.fn() };
  const browser = new MandalaBrowserToolset(computer, {
    filePolicy,
  } as unknown as ConstructorParameters<typeof MandalaBrowserToolset>[1]);
  try {
    expect(browser.toJSON().configs?.file_upload?.enabled).toBe(false);
    expect(
      (
        await browser.toolResult(
          use('file_upload', {
            target: { type: 'ref', ref: 'e1' },
            paths: ['/private/local-file'],
          }),
        )
      ).is_error,
    ).toBe(true);
    expect(filePolicy.resolvePaths).not.toHaveBeenCalled();
    const result = await browser.toolResult(use('javascript_exec', { text: '1+1' }));
    expect(result.is_error).toBe(true);
    expect(computer.createBrowserConnection).not.toHaveBeenCalled();
    expect(
      () =>
        new MandalaBrowserToolset(computer, {
          configs: {
            javascript_exec: { enabled: true },
            read_console: { enabled: true },
            read_network: { enabled: true },
          },
        }),
    ).toThrow(ToolsetConfigError);
  } finally {
    await browser.close();
  }
});

const executable = process.env.MANDALA_TEST_CHROMIUM;
// 127.0.0.1 and localhost are different sites, so each frame below is cross-site
// from its parent and runs as its own target.
const workerAttempts = (port: number, where: string) =>
  `const results=[];for(const [kind,make] of [['url',()=>new Worker('/escape-worker.js?${where}-url')],['blob',()=>new Worker(URL.createObjectURL(new Blob(["fetch('http://127.0.0.1:${port}/worker-escape?${where}-blob')"],{type:'text/javascript'})))],['data',()=>new Worker("data:text/javascript,fetch('http://127.0.0.1:${port}/worker-escape?${where}-data')")],['again',()=>{try{delete window.Worker}catch{}try{window.Worker=function(){}}catch{}return new Worker('/escape-worker.js?${where}-again')}]]){let r;try{make();r='created'}catch(e){r=e.name}results.push(kind+':'+r)}`;
const downloadFrame = (port: number) =>
  `<iframe src="http://localhost:${port}/dl-outer" style="position:absolute;left:0;top:0;border:0;width:600px;height:400px"></iframe>`;
// Opens a popup and then tries to use it from its own realm: a request, workers
// (one from an about:blank frame inside it), a navigation and a dialog. Inside
// an inline handler URL is document.URL, so window.URL.
const popupScript = (how: string) =>
  `const w=window.open('${how === 'blank' ? '' : `/popup-target?${how}`}');const blob=()=>window.URL.createObjectURL(new Blob(["fetch('/popup-worker?blob')"]));const made=[];try{w.fetch('/popup-fetch?from-opener').catch(()=>{})}catch{}try{new w.Worker(blob());made.push('worker')}catch{}try{new w.Worker('/popup-worker.js');made.push('script-worker')}catch{}try{const f=w.document.createElement('iframe');w.document.body.appendChild(f);new f.contentWindow.Worker(blob());made.push('frame-worker')}catch{}${how === 'blank' ? "try{w.alert('from the popup')}catch{}" : ''}try{w.location='/popup-target?moved'}catch{}document.getElementById('opened').textContent='opened:'+!!w+' made:'+made.join(',')`;
const pages = (port: number): Record<string, [string, string | Buffer]> => ({
  '/frame-host': [
    'text/html',
    `<title>Frame host</title><p>host page</p><iframe src="http://localhost:${port}/frame-child" style="position:absolute;left:0;top:100px;width:400px;height:300px;border:0"></iframe>`,
  ],
  '/frame-child': [
    'text/html',
    `<body style="margin:0"><button style="width:400px;height:100px" onclick="fetch('/frame-clicked')">child button</button><script>fetch('/frame-blocked').catch(()=>{});fetch('/frame-allowed')</script><iframe src="http://127.0.0.1:${port}/frame-nested"></iframe></body>`,
  ],
  '/frame-nested': ['text/html', `<p>nested</p><script>fetch('/nested-allowed')</script>`],
  // Cross-site frames added and removed faster than they can be set up.
  '/frame-churn': [
    'text/html',
    `<title>Churn</title><p id="state">churning</p><script>(async()=>{for(let n=0;n<40;n++){const f=document.createElement('iframe');f.src='http://localhost:${port}/churn-child';document.body.append(f);await new Promise(r=>setTimeout(r,(n%4)*5));f.remove()}const last=document.createElement('iframe');last.src='http://localhost:${port}/churn-last';document.body.append(last);document.getElementById('state').textContent='churned'})()</script>`,
  ],
  '/churn-child': ['text/html', `<p>child</p><script>fetch('/churn-fetch').catch(()=>{})</script>`],
  '/churn-last': ['text/html', `<p>last</p><script>fetch('/churn-final')</script>`],
  '/worker-host': [
    'text/html',
    `<title>Worker host</title><p>worker page</p><script>new Worker('/worker.js')</script>`,
  ],
  // Chromium fetches the script of a worker started by a worker without any
  // interception, so this page's URL policy would never see nested-worker.js.
  '/worker.js': ['text/javascript', `fetch('/worker-fetch');new Worker('/nested-worker.js')`],
  '/nested-worker.js': ['text/javascript', `fetch('/nested-worker-fetch')`],
  // A download from a same-process frame inside a cross-site frame.
  '/dl-host': ['text/html', downloadFrame(port)],
  '/dl-outer': [
    'text/html',
    `<body style="margin:0"><iframe src="/dl-inner" style="border:0;width:400px;height:200px"></iframe></body>`,
  ],
  '/dl-inner': [
    'text/html',
    `<body style="margin:0"><a href="/dl.txt" download="notes.txt" style="display:block;width:400px;height:200px">download</a></body>`,
  ],
  '/dl.txt': ['text/plain', 'downloaded bytes'],
  // Cross-site frames, each holding a same-process frame, added and removed;
  // then the download frame.
  '/dl-churn': [
    'text/html',
    `<body style="margin:0"><p id="state" style="position:absolute;top:500px">churning</p><script>(async()=>{for(let n=0;n<150;n++){const f=document.createElement('iframe');f.src='http://localhost:${port}/dl-outer?'+n;const loaded=new Promise(r=>{f.onload=r});document.body.append(f);await loaded;await new Promise(r=>setTimeout(r,5));f.remove()}document.body.insertAdjacentHTML('beforeend',${JSON.stringify(downloadFrame(port))});document.getElementById('state').textContent='churned'})()</script></body>`,
  ],
  // One cross-site frame sent back and forth between two other sites, which
  // keeps its target and session, each document holding a same-process frame;
  // then the download frame.
  '/nav-churn': [
    'text/html',
    `<body style="margin:0"><p id="state" style="position:absolute;top:500px">churning</p><iframe id="f" src="http://a.test:${port}/dl-outer" style="position:absolute;left:0;top:0;border:0;width:600px;height:400px"></iframe><script>(async()=>{const f=document.getElementById('f');await new Promise(r=>{f.onload=r});for(let n=0;n<40;n++){const loaded=new Promise(r=>{f.onload=r});f.src='http://'+(n%2?'a':'b')+'.test:${port}/dl-outer?'+n;await loaded}const loaded=new Promise(r=>{f.onload=r});f.src='http://a.test:${port}/dl-outer';await loaded;document.getElementById('state').textContent='churned'})()</script></body>`,
  ],
  // Every way this page has to start a dedicated worker, here, in a nested
  // same-site frame and in a cross-site frame; each worker would request
  // /worker-escape, which the URL policy refuses.
  '/escape-host': [
    'text/html',
    `<body><p id="state">trying</p><iframe src="/escape-frame?same"></iframe><iframe src="http://localhost:${port}/escape-frame?cross"></iframe><script>try{window.open('/escape-frame?popup')}catch{}${workerAttempts(port, 'host')};const blank=document.createElement('iframe');document.body.append(blank);let r;try{new blank.contentWindow.Worker('/escape-worker.js?blank');r='created'}catch(e){r=e.name}results.push('blank:'+r);document.getElementById('state').textContent=results.join(' ')</script></body>`,
  ],
  '/escape-frame': ['text/html', `<body><script>${workerAttempts(port, 'frame')}</script></body>`],
  '/escape-worker.js': [
    'text/javascript',
    `fetch('http://127.0.0.1:${port}/worker-escape?'+location.search.slice(1))`,
  ],
  // A page that opens a popup each way a page can: a target=_blank link, a
  // click handler and a script.
  '/popup-host': [
    'text/html',
    `<body style="margin:0"><a href="/popup-target?link" target="_blank" style="display:block;width:300px;height:100px">open link</a><button onclick="${popupScript('click').replaceAll('"', '&quot;')}" style="display:block;width:300px;height:100px">open window</button><button onclick="${popupScript('blank').replaceAll('"', '&quot;')}" style="display:block;width:300px;height:100px">open blank window</button><a href="/popup-target?opener-link" target="_blank" rel="opener" style="display:block;width:300px;height:100px">open link with opener</a><p>opener ready</p><p id="opened"></p><p id="network">no network change</p><script>addEventListener('offline',()=>{document.getElementById('network').textContent='went offline'})</script></body>`,
  ],
  '/popup-target': [
    'text/html',
    `<title>Popup</title><img src="/popup-image"><script>fetch('/popup-fetch')</script>`,
  ],
  '/heavy': [
    'text/html',
    `<title>Heavy</title><p>heavy page</p>${Array.from({ length: 400 }, (_, n) => `<img src="/img/${n}">`).join('')}`,
  ],
  '/img': ['image/gif', Buffer.from('R0lGODlhAQABAAAAACw=', 'base64')],
});
describe.skipIf(!executable)('real Chromium through Anthropic toolResult', () => {
  let chrome: ChildProcess | undefined, server: Server | undefined, profile: string | undefined;
  const browsers: MandalaBrowserToolset[] = [];
  const drivers: BrowserCDP[] = [];
  let profileDownloads: string | undefined;
  afterEach(async () => {
    for (const browser of browsers.splice(0)) await browser.close();
    for (const driver of drivers.splice(0)) await driver.close();
    if (profileDownloads)
      await rm(profileDownloads, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    profileDownloads = undefined;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
    if (chrome && chrome.exitCode === null && chrome.signalCode === null) {
      const exit = once(chrome, 'exit');
      chrome.kill();
      await exit;
      chrome = undefined;
    }
    // Chromium subprocesses may briefly finish profile writes after the parent exits.
    if (profile)
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  async function fixture(
    options:
      | ConstructorParameters<typeof MandalaBrowserToolset>[1]
      | ((c: Computer) => ConstructorParameters<typeof MandalaBrowserToolset>[1]) = {},
  ) {
    profile = await mkdtemp(join(tmpdir(), 'mandala-browser-test-'));
    chrome = spawn(
      executable!,
      [
        '--headless',
        '--no-sandbox',
        '--no-first-run',
        // As the platform runs it: a cross-site frame is its own process and target.
        '--site-per-process',
        // More sites on this one server: a.test and b.test.
        '--host-resolver-rules=MAP *.test 127.0.0.1',
        '--remote-debugging-port=0',
        `--user-data-dir=${profile}`,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    const lines = createInterface({ input: chrome.stderr! });
    const url = await new Promise<string>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        lines.close();
        chrome!.off('error', fail);
        chrome!.off('exit', fail);
      };
      const fail = () => {
        cleanup();
        reject(new Error('Chromium exited before exposing CDP'));
      };
      const timer = setTimeout(fail, 10000);
      lines.on('line', (line) => {
        if (line.includes('DevTools listening on ')) {
          cleanup();
          resolve(line.trim().split(' ').at(-1)!);
        }
      });
      chrome!.once('error', fail);
      chrome!.once('exit', fail);
    });
    const grant = Object.assign(
      BrowserConnection.fromApi(payload, BASE, 'computers/vm-1/browser-connections'),
      { url },
    );
    const revoke = vi.fn(async () => {});
    const computer = {
      id: 'vm-files',
      createBrowserConnection: async () => grant,
      revokeBrowserConnection: revoke,
    } as unknown as Computer;
    const browser = new MandalaBrowserToolset(
      computer,
      typeof options === 'function' ? options(computer) : options,
    );
    browsers.push(browser);
    const hits: string[] = [];
    server = createServer((req, res) => {
      hits.push(req.url!);
      if (req.url === '/redirect') {
        res.writeHead(302, { Location: '/blocked' });
        res.end();
        return;
      }
      const page = pages(req.socket.localPort!)[
        req
          .url!.replace(/^\/img\/\d+$/, '/img')
          .replace(/^\/dl-outer\?\d+$/, '/dl-outer')
          .replace(/^\/(escape-frame|escape-worker\.js|popup-target)\?.*$/, '/$1')
      ];
      if (page) {
        res.writeHead(200, { 'Content-Type': page[0] });
        res.end(page[1]);
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
    return {
      browser,
      url,
      revoke,
      hits,
      base: `http://127.0.0.1:${address.port}`,
    };
  }

  it.each(['', 'replace', 'url', 'refuse'])(
    'pins staged upload bytes and destination (%s)',
    async (mutation) => {
      const { chromium } = await import('playwright-core');
      let observer: Awaited<ReturnType<typeof chromium.connectOverCDP>>;
      const seen: any[] = [];
      const { browser, base, url } = await fixture((c) => ({
        remoteFilePolicy: new BrowserFilePolicy(c, { taskId: 'upload-test' }),
        configs: { file_upload: { enabled: true }, javascript_exec: { enabled: true } },
        confirm: async (ctx) => {
          if (ctx.member !== 'file_upload') return true;
          seen.push(ctx);
          const page = observer
            .contexts()
            .flatMap((c) => c.pages())
            .find((p) => p.url().startsWith(base))!;
          if (mutation === 'replace')
            await page.evaluate(
              "document.querySelector('input').replaceWith(document.createElement('input'))",
            );
          if (mutation === 'url')
            await page.evaluate("history.pushState({},'', '/new-destination')");
          return mutation !== 'refuse';
        },
      }));
      observer = await chromium.connectOverCDP(url);
      try {
        success(await browser.toolResult(use('navigate', { url: base })));
        success(
          await browser.toolResult(
            use('javascript_exec', {
              text: "document.body.innerHTML='<label>Upload <input id=upload type=file></label><p id=result></p>';document.querySelector('input').onchange=async e=>{document.querySelector('p').textContent=await e.target.files[0].text()}",
            }),
          ),
        );
        const page = success(await browser.toolResult(use('read_page', { filter: 'all' })));
        const target = ref(page, 'button Upload');
        const bytes = Buffer.from('approved bytes');
        const item = await browser.stageLocalFile(bytes, { filename: '../../exact.txt' });
        bytes.fill(65);
        expect(
          (await browser.toolResult(use('file_upload', { target, paths: ['/etc/passwd'] })))
            .is_error,
        ).toBe(true);
        expect(
          (
            await browser.toolResult(
              use('file_upload', { target, document_ids: ['file_not_staged'] }),
            )
          ).is_error,
        ).toBe(true);
        expect(seen).toHaveLength(0);
        const result = await browser.toolResult(
          use('file_upload', { target, document_ids: [item.id] }),
        );
        expect(seen).toHaveLength(1);
        expect(seen[0].tabURL).toBe(base + '/');
        expect(seen[0].input.document_ids).toEqual([item.id]);
        if (mutation) expect(result.is_error, text(result)).toBe(true);
        else {
          success(result);
          await new Promise((r) => setTimeout(r, 50));
          expect(text(success(await browser.toolResult(use('get_page_text'))))).toContain(
            'approved bytes',
          );
          expect(
            (await browser.toolResult(use('file_upload', { target, document_ids: [item.id] })))
              .is_error,
          ).toBe(true);
        }
      } finally {
        await observer.close();
      }
    },
  );

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
          use('left_click', {
            target: { type: 'coordinate', x: 1280, y: 0 },
          }),
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
    // A refused redirect can retain the old document. Successful navigation
    // deterministically invalidates references from that document.
    success(await browser.toolResult(use('navigate', { url: `${base}/after-redirect` })));
    expect((await browser.toolResult(use('left_click', { target: name }))).is_error).toBe(true);
    await browser.close();
    expect(revoke).toHaveBeenCalledExactlyOnceWith(id);
    expect(JSON.stringify(refused)).not.toContain(token);
  }, 30000);

  it('confirms enabled JavaScript, rejects invalid bounds, and aborts a pending action', async () => {
    const confirm = vi.fn((_ctx: { member: string }) => true);
    const { browser, base, revoke } = await fixture({
      configs: {
        javascript_exec: { enabled: true },
        read_console: { enabled: true },
        read_network: { enabled: true },
      },
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
  it('preserves input, tab lifecycle, policy refusal and consumed-log semantics', async () => {
    let rejectReload = false;
    let release!: () => void, entered!: () => void;
    let pending = new Promise<void>((r) => {
      entered = r;
    });
    let gate = new Promise<void>((r) => {
      release = r;
    });
    const { browser, base } = await fixture({
      configs: {
        javascript_exec: { enabled: true },
        read_console: { enabled: true },
        read_network: { enabled: true },
      },
      confirm: () => true,
      urlPolicy: async (_ctx, url) => {
        if (url.endsWith('/slow')) {
          entered();
          await gate;
        }
        if (rejectReload) throw new ToolError('Allowed origin only.');
      },
    });
    const call = async (name: string, data: Record<string, unknown> = {}) =>
      success(await browser.toolResult(use(name, data)));
    const js = async (expression: string) =>
      text(await call('javascript_exec', { text: expression }));
    const first = tabs(await call('navigate', { url: base }))[0]!.tab_id;
    await js(
      "document.body.innerHTML += '<label>Choice <select id=choice><option value=one>First</option><option value=two>Second</option></select></label>'; document.addEventListener('mousemove', e=>window.buttons=e.buttons); document.getElementById('name').focus()",
    );
    await call('key', { text: 'a' });
    expect(await js("document.getElementById('name').value")).toBe('a');
    await call('key', { text: 'b c Backspace' });
    expect(await js("document.getElementById('name').value")).toBe('ab');
    await js(
      "document.body.insertAdjacentHTML('beforeend','<textarea id=area></textarea><form id=form><input id=field><button>Submit</button></form>');document.getElementById('area').focus();window.keys=[];document.getElementById('area').addEventListener('keyup',e=>keys.push([e.key,e.shiftKey]));window.submitted=0;document.getElementById('form').onsubmit=e=>{e.preventDefault();submitted++}",
    );
    await call('key', { text: 'Shift+1 Shift+a Enter' });
    expect(await js('JSON.stringify(document.getElementById("area").value)')).toBe('"!A\\n"');
    expect(await js('JSON.stringify(keys.slice(0,2))')).toBe('[["!",true],["Shift",false]]');
    await js('document.getElementById("field").focus()');
    await call('key', { text: 'Enter' });
    expect(await js('window.submitted')).toBe('1');
    const point = { type: 'coordinate', x: 20, y: 20 };
    await call('left_mouse_down', { target: point });
    await call('mouse_move', { target: { ...point, x: 50 } });
    expect(await js('window.buttons')).toBe('1');
    await call('left_mouse_up', { target: point });
    const page = await call('read_page', { filter: 'interactive' });
    const choice = ref(page, 'combobox Choice');
    await call('form_input', { target: choice, value: 'Second' });
    expect(await js("document.getElementById('choice').value")).toBe('two');
    expect(
      (await browser.toolResult(use('form_input', { target: choice, value: 'missing' }))).is_error,
    ).toBe(true);
    expect(await js("document.getElementById('choice').value")).toBe('two');
    const name = ref(page, 'textbox Name');
    expect(
      (await browser.toolResult(use('form_input', { target: name, value: 'x'.repeat(16001) })))
        .is_error,
    ).toBe(true);
    expect(await js("document.getElementById('name').value")).toBe('ab');
    for (const [member, data] of [
      ['scroll', { target: point, scroll_direction: 'diagonal' }],
      ['zoom', {}],
      ['type', {}],
      ['left_click', {}],
    ] as const)
      expect((await browser.toolResult(use(member, data))).is_error).toBe(true);
    await call('get_page_text');
    await js("console.log('unique-console-message')");
    expect(text(await call('read_console'))).toContain('unique-console-message');
    expect(text(await call('read_console'))).not.toContain('unique-console-message');
    await js("fetch('/logged').then(r=>r.text())");
    expect(text(await call('read_network'))).toContain('/logged');
    expect(text(await call('read_network'))).not.toContain('/logged');
    await js(
      'window.fetchControl=new AbortController();void fetch("/slow",{signal:fetchControl.signal}).catch(()=>{})',
    );
    await pending;
    await js('fetchControl.abort()');
    release();
    await new Promise((r) => setTimeout(r, 100));
    await call('get_page_text');
    pending = new Promise<void>((r) => {
      entered = r;
    });
    gate = new Promise<void>((r) => {
      release = r;
    });
    rejectReload = true;
    const refused = await browser.toolResult(use('navigate', { url: 'reload' }));
    expect(refused.is_error).toBe(true);
    expect(text(refused)).toContain('Allowed origin only.');
    rejectReload = false;
    await call('form_input', { target: name, value: 'still valid' });
    const second = tabs(await call('new_tab')).find((t) => t.tab_id !== first)!.tab_id;
    await call('javascript_exec', {
      tab_id: first,
      text: "void fetch('/slow').catch(()=>{})",
    });
    await pending;
    await call('close_tab', { tab_id: first });
    release();
    await new Promise((r) => setTimeout(r, 100));
    await call('get_page_text', { tab_id: second });
  }, 30000);
  it('retries revocation after a failed close without creating another session', async () => {
    const { browser, base, revoke } = await fixture();
    success(await browser.toolResult(use('navigate', { url: base })));
    revoke.mockRejectedValueOnce(new Error('transient failure'));
    await expect(browser.close()).rejects.toThrow('could not be revoked');
    await browser.close();
    expect(revoke).toHaveBeenCalledTimes(2);
    await browser.close();
    expect(revoke).toHaveBeenCalledTimes(2);
  });
  it.each(['Runtime.evaluate', 'Target.createTarget'])(
    'fails promptly if transport dies around %s',
    async (failurePoint) => {
      const { browser, base } = await fixture();
      const original = BrowserCDP.prototype.send;
      const spy = vi.spyOn(BrowserCDP.prototype, 'send').mockImplementation(async function (
        this: BrowserCDP,
        method,
        params = {},
        session,
      ) {
        const reply =
          method === failurePoint && method === 'Target.createTarget'
            ? await original.call(this, method, params, session)
            : undefined;
        if (
          method === failurePoint &&
          (method === 'Target.createTarget' || params.expression === 'document.readyState')
        ) {
          const exited = once(chrome!, 'exit');
          chrome!.kill();
          await exited;
          await new Promise((r) => setTimeout(r, 20));
        }
        return reply ?? original.call(this, method, params, session);
      });
      try {
        const started = Date.now();
        const result = await browser.toolResult(use('navigate', { url: base }));
        expect(result.is_error).toBe(true);
        expect(Date.now() - started).toBeLessThan(2000);
        expect(content(result).some((b) => b.type === 'browser_state')).toBe(false);
      } finally {
        spy.mockRestore();
      }
    },
  );
  it('reports virtual accessibility rows without unusable element refs', async () => {
    const { browser, base } = await fixture();
    success(await browser.toolResult(use('navigate', { url: base })));
    const original = BrowserCDP.prototype.send;
    const spy = vi.spyOn(BrowserCDP.prototype, 'send').mockImplementation(async function (
      this: BrowserCDP,
      method,
      params,
      session,
    ) {
      const result = await original.call(this, method, params, session);
      if (method === 'Accessibility.getFullAXTree')
        result.nodes.push({
          role: { value: 'paragraph' },
          name: { value: 'Virtual accessibility row' },
        });
      return result;
    });
    try {
      const page = text(success(await browser.toolResult(use('read_page'))));
      expect(page.split('\n').find((line) => line.includes('Virtual accessibility row'))).toBe(
        'paragraph Virtual accessibility row',
      );
      expect(page).toMatch(/\[e\d+\] textbox Name/);
    } finally {
      spy.mockRestore();
    }
  });
  it('preserves other tabs when a new tab closes during initialization', async () => {
    const { browser, base } = await fixture();
    const first = tabs(success(await browser.toolResult(use('navigate', { url: base }))))[0]!
      .tab_id;
    let finished!: () => void;
    const initialization = new Promise<void>((resolve) => {
      finished = resolve;
    });
    const original = BrowserCDP.prototype.send;
    const spy = vi.spyOn(BrowserCDP.prototype, 'send').mockImplementation(async function (
      this: BrowserCDP,
      method,
      params,
      session,
    ) {
      if (method === 'Page.enable') {
        try {
          const { targetInfo } = await original.call(this, 'Target.getTargetInfo', {}, session);
          await original.call(this, 'Target.closeTarget', { targetId: targetInfo.targetId });
          await expect
            .poll(() => this.state().tabs.some((tab) => tab.tab_id === targetInfo.targetId))
            .toBe(false);
          throw new BrowserDriverError('Target closed');
        } finally {
          finished();
        }
      }
      return original.call(this, method, params, session);
    });
    try {
      const started = Date.now();
      const result = await browser.toolResult(use('new_tab'));
      await initialization;
      expect(result.is_error).toBe(true);
      expect(text(result)).toContain('closed during initialization');
      expect(Date.now() - started).toBeLessThan(2000);
      expect(tabs(success(await browser.toolResult(use('get_page_text'))))).toEqual([
        expect.objectContaining({ tab_id: first, active: true }),
      ]);
    } finally {
      spy.mockRestore();
    }
  });
  // What Chromium itself says the targets are, from a second client that only lists.
  async function targets(url: string): Promise<string[]> {
    const { default: WebSocket } = await import('ws');
    const ws = new WebSocket(url);
    await once(ws, 'open');
    try {
      ws.send(JSON.stringify({ id: 1, method: 'Target.getTargets' }));
      const [raw] = await once(ws, 'message');
      return (JSON.parse(String(raw)).result.targetInfos as { type: string; url: string }[]).map(
        (t) => `${t.type} ${t.url}`,
      );
    } finally {
      ws.close();
    }
  }
  it('runs cross-site frames under the URL policy instead of closing their tab', async () => {
    const seen: [string | undefined, string][] = [];
    const { browser, base, hits, url } = await fixture({
      urlPolicy: (ctx, target) => {
        seen.push([ctx.tabId, target]);
        if (target.endsWith('/frame-blocked')) throw new ToolError('not permitted');
      },
    });
    const port = new URL(base).port;
    const tab = tabs(
      success(await browser.toolResult(use('navigate', { url: `${base}/frame-host` }))),
    )[0]!.tab_id;
    // The nested frame loads only once the frame holding it was released.
    await expect.poll(() => hits, { timeout: 10000 }).toContain('/nested-allowed');
    expect(await targets(url)).toEqual(
      expect.arrayContaining([
        `iframe http://localhost:${port}/frame-child`,
        `iframe http://127.0.0.1:${port}/frame-nested`,
      ]),
    );
    const page = success(await browser.toolResult(use('get_page_text')));
    expect(text(page)).toContain('host page');
    expect(tabs(page)).toEqual([expect.objectContaining({ tab_id: tab })]);
    // The frame's own requests met the policy, under its tab's ID.
    expect(hits).toContain('/frame-allowed');
    expect(hits).not.toContain('/frame-blocked');
    expect(seen).toContainEqual([tab, `http://localhost:${port}/frame-blocked`]);
    expect(seen).toContainEqual([tab, `http://127.0.0.1:${port}/nested-allowed`]);
    // Coordinate input reaches into the frame.
    success(
      await browser.toolResult(
        use('left_click', { target: { type: 'coordinate', x: 200, y: 150 } }),
      ),
    );
    await expect.poll(() => hits).toContain('/frame-clicked');
    expect(tabs(success(await browser.toolResult(use('list_tabs'))))).toHaveLength(1);
  }, 30000);
  it('survives cross-site frames that come and go faster than they are set up', async () => {
    const { browser, base, hits } = await fixture({
      urlPolicy: () => new Promise((r) => setTimeout(r, 5)),
    });
    success(await browser.toolResult(use('navigate', { url: `${base}/frame-churn` })));
    await expect.poll(() => hits, { timeout: 15000 }).toContain('/churn-final');
    expect(browser.sessionStatus.state).toBe('active');
    expect(text(success(await browser.toolResult(use('get_page_text'))))).toContain('churned');
  }, 30000);
  it('a page cannot start a dedicated worker, nor through one a nested worker', async () => {
    const seen: string[] = [];
    const { browser, base, hits, url } = await fixture({
      urlPolicy: (_ctx, target) => {
        seen.push(target);
      },
    });
    success(await browser.toolResult(use('navigate', { url: `${base}/worker-host` })));
    await new Promise((r) => setTimeout(r, 1000));
    expect((await targets(url)).filter((target) => target.startsWith('worker'))).toEqual([]);
    expect(hits.filter((hit) => hit.includes('worker'))).toEqual(['/worker-host']);
    expect(seen.filter((target) => target.includes('worker.js'))).toEqual([]);
    expect(text(success(await browser.toolResult(use('get_page_text'))))).toContain('worker page');
    expect(browser.sessionStatus.state).toBe('active');
  }, 30000);
  it('opens and navigates another tab while the URL policy holds a page’s subresources', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { browser, base, hits } = await fixture({
      urlPolicy: async (_ctx, target) => {
        if (target.includes('/img/')) await gate;
      },
    });
    try {
      success(await browser.toolResult(use('navigate', { url: `${base}/heavy` })));
      const started = Date.now();
      success(await browser.toolResult(use('new_tab')));
      const page = success(await browser.toolResult(use('navigate', { url: `${base}/second` })));
      expect(text(page)).toContain('Driver test');
      expect(Date.now() - started).toBeLessThan(4000);
      expect(hits.filter((hit) => hit.startsWith('/img/'))).toHaveLength(0);
    } finally {
      release();
    }
    await expect
      .poll(() => hits.filter((hit) => hit.startsWith('/img/')).length, { timeout: 10000 })
      .toBe(400);
    expect(browser.sessionStatus.state).toBe('active');
  }, 30000);
  // The driver with a real file session (downloads left to the test) on the
  // fixture's Chromium, and a spy on how each download's frame was judged.
  async function fileDriver(url: string) {
    const grant = Object.assign(
      BrowserConnection.fromApi(payload, BASE, 'computers/vm-1/browser-connections'),
      { url },
    );
    const computer = { id: 'vm-frames' } as unknown as Computer;
    const backend = new BrowserCDP(
      async () => grant,
      async () => {},
      async () => {},
    );
    const files = new BrowserFiles(
      computer,
      new BrowserFilePolicy(computer, { taskId: 'frames' }),
      backend,
    );
    backend.files = files;
    drivers.push(backend);
    await backend.start();
    profileDownloads = await mkdtemp(join(tmpdir(), 'mandala-downloads-'));
    await backend.send('Browser.setDownloadBehavior', {
      behavior: 'allowAndName',
      browserContextId: files.context,
      downloadPath: profileDownloads,
      eventsEnabled: true,
    });
    const event = vi.spyOn(files, 'event');
    const began = () =>
      event.mock.calls.filter(([method]) => method === 'Browser.downloadWillBegin');
    return { backend, files, began };
  }
  it('tracks a download from a same-process frame inside a cross-site frame', async () => {
    const { url, base, hits } = await fixture();
    const { backend, files, began } = await fileDriver(url);
    await backend.perform('navigate', { url: `${base}/dl-host` });
    await expect.poll(() => hits, { timeout: 10000 }).toContain('/dl-inner');
    await new Promise((r) => setTimeout(r, 200));
    await backend.perform('left_click', { target: { type: 'coordinate', x: 50, y: 50 } });
    await expect.poll(() => began().length, { timeout: 10000 }).toBe(1);
    const [, params, tracked] = began()[0]!;
    expect(tracked).toBe(true);
    expect(files.frames.has((params as { frameId: string }).frameId)).toBe(true);
  }, 30000);
  it('cross-site frames that come and go leave frame tracking room', async () => {
    const { url, base, hits } = await fixture();
    const { backend, files, began } = await fileDriver(url);
    await backend.perform('navigate', { url: `${base}/dl-churn` });
    await expect
      .poll(() => backend.perform('get_page_text', {}), { timeout: 30000, interval: 200 })
      .toBe('churned');
    await expect.poll(() => hits, { timeout: 10000 }).toContain('/dl-inner');
    expect(hits.filter((hit) => hit.startsWith('/dl-outer')).length).toBeGreaterThanOrEqual(150);
    // The page, the download frame and the frame inside it, and little else:
    // Chromium reports no detach for a frame inside a removed cross-site frame.
    await expect.poll(() => files.frames.size, { timeout: 5000 }).toBeLessThan(10);
    await new Promise((r) => setTimeout(r, 200));
    await backend.perform('left_click', { target: { type: 'coordinate', x: 50, y: 50 } });
    await expect.poll(() => began().length, { timeout: 10000 }).toBe(1);
    expect(began()[0]![2]).toBe(true);
  }, 60000);
  it('a cross-site frame sent between sites leaves frame tracking room', async () => {
    const { url, base, hits } = await fixture();
    const { backend, files, began } = await fileDriver(url);
    await backend.perform('navigate', { url: `${base}/nav-churn` });
    await expect
      .poll(() => backend.perform('get_page_text', {}), { timeout: 30000, interval: 200 })
      .toBe('churned');
    expect(hits.filter((hit) => hit.startsWith('/dl-outer')).length).toBeGreaterThan(40);
    // The page, the frame and the frame inside its current document.
    await expect.poll(() => files.frames.size, { timeout: 5000 }).toBeLessThan(6);
    await new Promise((r) => setTimeout(r, 200));
    await backend.perform('left_click', { target: { type: 'coordinate', x: 50, y: 50 } });
    await expect.poll(() => began().length, { timeout: 10000 }).toBe(1);
    expect(began()[0]![2]).toBe(true);
  }, 60000);
  it.each(['navigates away', 'closes'])(
    'no dedicated worker gets a request past the URL policy when its page %s',
    async (exit) => {
      const seen: string[] = [];
      const { browser, base, hits } = await fixture({
        urlPolicy: (_ctx, target) => {
          seen.push(target);
          if (target.includes('/worker-escape')) throw new ToolError('not permitted');
        },
      });
      success(await browser.toolResult(use('navigate', { url: `${base}/escape-host` })));
      await expect.poll(() => hits.filter((hit) => hit.startsWith('/escape-frame')).length).toBe(2);
      await expect
        .poll(async () => text(success(await browser.toolResult(use('get_page_text')))))
        .toContain('blank:');
      const attempts = text(success(await browser.toolResult(use('get_page_text'))));
      await new Promise((r) => setTimeout(r, 500));
      if (exit === 'closes') {
        success(await browser.toolResult(use('new_tab')));
        const first = tabs(success(await browser.toolResult(use('list_tabs'))))[0]!.tab_id;
        success(await browser.toolResult(use('close_tab', { tab_id: first })));
      } else success(await browser.toolResult(use('navigate', { url: `${base}/after` })));
      await new Promise((r) => setTimeout(r, 1500));
      // Nothing a worker would have asked for reached the server, the URL
      // policy or anywhere else: no worker ever started.
      expect(hits.filter((hit) => hit.includes('worker'))).toEqual([]);
      expect(seen.filter((url) => url.includes('worker'))).toEqual([]);
      // Construction itself is refused, here and in the about:blank frame.
      expect(attempts).toContain(
        'url:SecurityError blob:SecurityError data:SecurityError again:SecurityError blank:SecurityError',
      );
      expect(browser.sessionStatus.state).toBe('active');
    },
    30000,
  );
  it.each(['link', 'opener link', 'click', 'blank click', 'script'])(
    'a popup opened by a %s is refused without wedging its opener',
    async (how) => {
      const seen: string[] = [];
      const { browser, base, hits, url } = await fixture({
        // Whatever a popup asks for, the policy would refuse: a request that
        // reaches the server got past it.
        urlPolicy: (_ctx, target) => {
          seen.push(target);
          if (/\/popup-(target|image|fetch|worker)/.test(target)) throw new ToolError('no popups');
        },
        configs: { javascript_exec: { enabled: true } },
        confirm: () => true,
      });
      success(await browser.toolResult(use('navigate', { url: `${base}/popup-host` })));
      if (how === 'script')
        success(await browser.toolResult(use('javascript_exec', { text: popupScript('script') })));
      else
        success(
          await browser.toolResult(
            use('left_click', {
              target: {
                type: 'coordinate',
                x: 50,
                y: { link: 50, click: 150, 'blank click': 250, 'opener link': 350 }[how]!,
              },
            }),
          ),
        );
      // The opener answers its next action at once.
      const started = Date.now();
      success(await browser.toolResult(use('javascript_exec', { text: 'navigator.onLine' })));
      expect(Date.now() - started).toBeLessThan(3000);
      // A Chromium with per-rule network emulation takes only the popup offline;
      // an older one takes its renderer offline while the popup is refused.
      const protocol = await (await fetch(`http://${new URL(url).host}/json/protocol`)).json();
      const perRule = JSON.stringify(protocol).includes('emulateNetworkConditionsByRule');
      await new Promise((r) => setTimeout(r, 1000));
      const page = text(success(await browser.toolResult(use('get_page_text'))));
      expect(page).toContain('opener ready');
      if (perRule) expect(page).toContain('no network change');
      // The popup was refused: it never loaded and none of its requests went out.
      expect(hits.filter((hit) => /^\/popup-(target|image|fetch|worker)/.test(hit))).toEqual([]);
      // A click opens one; a script without a gesture may be refused by Chromium itself.
      if (how.includes('click'))
        // It opened, and no worker could be made in it.
        expect(text(success(await browser.toolResult(use('get_page_text'))))).toMatch(
          /opened:true made:$/m,
        );
      expect(tabs(success(await browser.toolResult(use('list_tabs'))))).toHaveLength(1);
      expect(browser.sessionStatus.state).toBe('active');
    },
    60000,
  );
  it('loads a page that pauses hundreds of requests at once', async () => {
    const { browser, base, hits } = await fixture({ urlPolicy: async () => {} });
    success(await browser.toolResult(use('navigate', { url: `${base}/heavy` })));
    await expect
      .poll(() => hits.filter((hit) => hit.startsWith('/img/')).length, { timeout: 10000 })
      .toBe(400);
    expect(text(success(await browser.toolResult(use('get_page_text'))))).toContain('heavy page');
    expect(browser.sessionStatus.state).toBe('active');
  }, 30000);
});
