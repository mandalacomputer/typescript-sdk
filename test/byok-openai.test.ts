import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHAT_COMPLETIONS } from '../src/paths.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const start = '<!-- byok-openai-example:start -->';
const end = '<!-- byok-openai-example:end -->';
const endpoint = 'https://app.mandala.computer/api/v1/chat/completions';
const environment = {
  MANDALA_API_KEY: 'com_mandala_fixture_only',
  MANDALA_COMPUTER_ID: 'vm-byok-fixture',
  ANTHROPIC_API_KEY: 'sk-ant-model-fixture-only',
  ANTHROPIC_MODEL: 'anthropic-model-fixture',
};

function extractExample(markdown: string): string {
  if (markdown.split(start).length !== 2 || markdown.split(end).length !== 2) {
    throw new Error('Expected exactly one BYOK example marker pair');
  }
  const first = markdown.indexOf(start) + start.length;
  const last = markdown.indexOf(end);
  if (last < first) throw new Error('BYOK example markers are reversed');
  const section = markdown.slice(first, last).trim();
  const match = /^```ts\r?\n([\s\S]*?)\r?\n```$/.exec(section);
  if (section.match(/^```/gm)?.length !== 2 || !match?.[1]?.trim()) {
    throw new Error('Expected one nonempty TypeScript example');
  }
  return match[1];
}

const example = extractExample(readme);

function checkTypes(source: string): string[] {
  // An in-memory .mts file resolves the installed package's real declarations
  // from this project and permits the README's top-level await.
  const filename = `${root}__byok_readme__.mts`;
  const config = ts.readConfigFile(`${root}tsconfig.json`, ts.sys.readFile);
  if (config.error) {
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  }
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const options = { ...parsed.options, noEmit: true };
  const host = ts.createCompilerHost(options);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (path, languageVersion, onError, shouldCreateNewSourceFile) =>
    path === filename
      ? ts.createSourceFile(path, source, languageVersion, true)
      : originalGetSourceFile(path, languageVersion, onError, shouldCreateNewSourceFile);
  const program = ts.createProgram([filename], options, host);
  expect(
    program
      .getSourceFiles()
      .some((file) => file.isDeclarationFile && file.fileName.includes('/node_modules/openai/')),
  ).toBe(true);
  return [...parsed.errors, ...ts.getPreEmitDiagnostics(program)].map((diagnostic) =>
    ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
  );
}

const require = createRequire(import.meta.url);
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
  ...args: string[]
) => (load: NodeJS.Require, exports: Record<string, unknown>) => Promise<void>;

async function executeExample(source = example): Promise<void> {
  // Execute the entire extracted sample, including its real OpenAI import.
  // CommonJS emission lets an async wrapper run it without temporary scripts
  // or child processes; the separate type gate checks the original ESM sample.
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
  });
  await new AsyncFunction('require', 'exports', compiled.outputText)(require, {});
}

type Call = { url: URL; method: string; headers: Headers; body: unknown; bodyText: string };
type Outcome = 'success' | 'application refusal' | 'provider refusal' | 'transport interruption';
const responses: Response[] = [];

function mockHTTP(outcome: Outcome = 'success') {
  for (const [name, value] of Object.entries(environment)) vi.stubEnv(name, value);
  vi.stubEnv('OPENAI_ORG_ID', undefined);
  vi.stubEnv('OPENAI_PROJECT_ID', undefined);
  const printed = vi.spyOn(console, 'log').mockImplementation(() => {});
  const calls: Call[] = [];
  vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = new Request(input, init);
    const bodyText = await request.text();
    calls.push({
      url: new URL(request.url),
      method: request.method,
      headers: request.headers,
      body: JSON.parse(bodyText),
      bodyText,
    });
    if (outcome === 'transport interruption') {
      throw new TypeError('Simulated connection interruption after sending the request');
    }
    const response =
      outcome === 'success'
        ? Response.json({
            id: 'chatcmpl-fixture',
            object: 'chat.completion',
            created: 1_700_000_000,
            model: 'computer-use-agent',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'Fixture page title.' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
            agent: { computer_id: environment.MANDALA_COMPUTER_ID, steps: [], stop: 'end_turn' },
          })
        : Response.json(
            {
              error:
                outcome === 'application refusal'
                  ? 'API rate budget exhausted.'
                  : { message: 'Model provider refused the run.', code: 429, steps: [] },
            },
            { status: 429, headers: { 'retry-after-ms': '0', 'x-request-id': 'req-byok-fixture' } },
          );
    responses.push(response);
    return response;
  });
  return { calls, printed };
}

function assertSingleRequest(calls: Call[]) {
  expect(calls).toHaveLength(1);
  const call = calls[0]!;
  expect(call.method).toBe('POST');
  expect(call.url.href).toBe(endpoint);
  expect(call.url.search).toBe('');
  expect(call.headers.get('Authorization')).toBe(`Bearer ${environment.MANDALA_API_KEY}`);
  expect(call.headers.get('X-Model-Key')).toBe(environment.ANTHROPIC_API_KEY);
  expect(call.headers.get('Content-Type')).toBe('application/json');
  expect(call.body).toEqual({
    model: environment.ANTHROPIC_MODEL,
    messages: [{ role: 'user', content: 'Read the page title in the browser and report it.' }],
    computer_id: environment.MANDALA_COMPUTER_ID,
    max_steps: 5,
    stream: false,
  });
  for (const key of [environment.MANDALA_API_KEY, environment.ANTHROPIC_API_KEY]) {
    expect(call.bodyText).not.toContain(key);
    expect(call.url.href).not.toContain(key);
  }
}

afterEach(async () => {
  try {
    for (const response of responses.splice(0)) {
      if (!response.bodyUsed) await response.body?.cancel();
    }
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
});

describe('README OpenAI BYOK example', () => {
  it('retains the internal constant and composes the independently published endpoint', () => {
    expect(CHAT_COMPLETIONS).toBe('chat/completions');
    expect(new URL(CHAT_COMPLETIONS, 'https://app.mandala.computer/api/v1/').href).toBe(endpoint);
  });

  it.each([
    ['missing markers', 'no example'],
    ['missing end marker', `${start}\n\`\`\`ts\nconst x = 1;\n\`\`\``],
    ['duplicate markers', `${start}${start}${end}`],
    ['reversed markers', `${end}${start}`],
    ['zero code examples', `${start}\nno code block\n${end}`],
    ['empty code example', `${start}\n\`\`\`ts\n\n\`\`\`\n${end}`],
    ['multiple code examples', `${start}\n\`\`\`ts\n1;\n\`\`\`\n\`\`\`ts\n2;\n\`\`\`\n${end}`],
  ])('rejects %s instead of passing without executing a sample', (_label, markdown) => {
    expect(() => extractExample(markdown)).toThrow();
  });

  it('compiles the exact README against the released OpenAI declarations', () => {
    expect(checkTypes(example)).toEqual([]);
  });

  it('detects a model type error through the real create overloads', () => {
    const invalid = example.replace("model: required('ANTHROPIC_MODEL')", 'model: 42');
    expect(invalid).not.toBe(example);
    expect(checkTypes(invalid).join('\n')).toMatch(/No overload matches this call/);
  });

  it('sends the exact README through the real OpenAI client with both distinct credentials', async () => {
    const { calls, printed } = mockHTTP();
    await executeExample();
    assertSingleRequest(calls);
    expect(printed).toHaveBeenCalledExactlyOnceWith('Fixture page title.');
    expect(responses.every((response) => response.bodyUsed)).toBe(true);
  });

  it.each([
    ['wrong public path', '/api/v1', '/api/v2'],
    [
      'nested computer id',
      "computer_id: required('MANDALA_COMPUTER_ID'),",
      "extra_body: { computer_id: required('MANDALA_COMPUTER_ID') },",
    ],
    ['nested step limit', 'max_steps: 5,', 'extra_body: { max_steps: 5 },'],
    [
      'swapped bearer credential',
      "apiKey: required('MANDALA_API_KEY')",
      "apiKey: required('ANTHROPIC_API_KEY')",
    ],
  ])('catches a %s mutation in the actual emitted HTTP request', async (_label, from, to) => {
    const { calls } = mockHTTP();
    const mutant = example.replace(from, to);
    expect(mutant).not.toBe(example);
    await executeExample(mutant);
    expect(() => assertSingleRequest(calls)).toThrow();
  });

  it.each(['application refusal', 'provider refusal', 'transport interruption'] as const)(
    'makes one attempt on %s with the documented retry setting',
    async (outcome) => {
      const { calls, printed } = mockHTTP(outcome);
      const failure = executeExample();
      if (outcome === 'transport interruption') {
        await expect(failure).rejects.toMatchObject({
          name: 'Error',
          message: 'Connection error.',
        });
      } else {
        await expect(failure).rejects.toMatchObject({ status: 429, requestID: 'req-byok-fixture' });
      }
      assertSingleRequest(calls);
      expect(printed).not.toHaveBeenCalled();
    },
  );

  it.each(['provider refusal', 'transport interruption'] as const)(
    'detects automatic POST replay on %s when maxRetries is removed',
    async (outcome) => {
      const { calls } = mockHTTP(outcome);
      const mutant = example.replace('  maxRetries: 0,\n', '');
      expect(mutant).not.toBe(example);
      await expect(executeExample(mutant)).rejects.toThrow();
      expect(calls).toHaveLength(3);
      expect(() => assertSingleRequest(calls)).toThrow();
    },
  );
});
