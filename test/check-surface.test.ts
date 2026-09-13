import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ALLOWED, PARAMETERS } from './allowlist.js';

/**
 * The surface check, end to end, over a platform checkout it does not control.
 *
 * The script reads the platform's manifest and imports this repo's own mirror,
 * so the fixture is a platform directory and the assertion is on what the
 * script says. The cases that matter most are the ones where it must NOT say
 * "matches": the recurring defect in the scanner this replaced was a false
 * all-clear, and a manifest diff can print one too if it silently reads nothing.
 */
describe('check:surface', () => {
  // Spawned, not spawnSync'd: a synchronous child holds this worker's event loop
  // for the length of the run, and a timing assertion in a sibling worker missed
  // its deadline because of it.
  const runCheck = async (platformRepo: string | undefined, cwd = resolve(__dirname, '..')) =>
    new Promise<{ said: string; code: number | null }>((done, fail) => {
      const env = { ...process.env };
      if (platformRepo === undefined) delete env.MANDALA_PLATFORM_REPO;
      else env.MANDALA_PLATFORM_REPO = platformRepo;
      const child = spawn(process.execPath, [resolve(__dirname, '../scripts/check-surface.mjs')], {
        cwd,
        env,
      });
      let said = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        said += chunk;
      });
      child.stderr.on('data', (chunk: string) => {
        said += chunk;
      });
      child.on('error', fail);
      child.on('close', (code) => done({ said, code }));
    });

  /** A manifest exactly in step with this repo's mirror: every drift case starts here. */
  const inStep = () => ({
    version: 1,
    routes: [...ALLOWED].sort(),
    parameters: Object.fromEntries([...PARAMETERS].filter(([, names]) => names.length)),
    limits: { 'agent.maxSteps': 100 },
  });

  const made: string[] = [];
  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  /** A directory shaped like a platform checkout, holding `manifest` — or nothing. */
  const fixture = (manifest: unknown | null, under = tmpdir()) => {
    mkdirSync(under, { recursive: true });
    const dir = mkdtempSync(join(under, 'surface-fixture-'));
    made.push(dir);
    if (manifest !== null) {
      writeFileSync(
        join(dir, 'surface-manifest.json'),
        typeof manifest === 'string' ? manifest : JSON.stringify(manifest),
      );
    }
    return dir;
  };

  it('says the mirror matches, with the counts, when it does', async () => {
    const { said, code } = await runCheck(fixture(inStep()));
    const counted = [...PARAMETERS.values()].reduce((n, names) => n + names.length, 0);
    expect(said).toContain(
      `the mirror matches the platform (${ALLOWED.size} routes, ${counted} parameters`,
    );
    expect(code).toBe(0);
  });

  it('names a route that moved in either direction', async () => {
    const manifest = inStep();
    manifest.routes = manifest.routes.filter((r) => r !== 'GET sizes').concat('POST widgets');
    const { said, code } = await runCheck(fixture(manifest));
    expect(said).toContain('+ POST widgets');
    expect(said).toContain('- GET sizes');
    expect(said).not.toContain('matches');
    expect(code).toBe(1);
  });

  it('names a parameter that moved in either direction', async () => {
    const manifest = inStep();
    manifest.parameters['GET sizes'] = ['query:fresh'];
    manifest.parameters['DELETE computers/:id'] = ['query:expect'];
    const { said, code } = await runCheck(fixture(manifest));
    expect(said).toContain('+ GET sizes  query:fresh');
    expect(said).toContain('- DELETE computers/:id  query:snapshots');
    expect(code).toBe(1);
  });

  it.each([
    ['not json {', 'cannot be read'],
    ['[]', 'not a JSON object'],
    [{ version: 2, routes: ['GET x'], parameters: {} }, 'version 2'],
    [{ version: 1, routes: [], parameters: {} }, 'lists no routes'],
    [{ version: 1, parameters: {} }, 'lists no routes'],
    [{ version: 1, routes: ['sizes'], parameters: {} }, "not 'METHOD pattern'"],
    [{ version: 1, routes: ['FETCH sizes'], parameters: {} }, "not 'METHOD pattern'"],
    [{ version: 1, routes: ['GET sizes'] }, 'no parameters table'],
    [
      { version: 1, routes: ['GET sizes'], parameters: { 'GET gone': [] } },
      'route it does not list',
    ],
    [{ version: 1, routes: ['GET sizes'], parameters: { 'GET sizes': ['fresh'] } }, 'cannot read'],
  ])(
    'refuses a manifest it cannot read rather than comparing nothing: %j',
    async (broken, says) => {
      // The false all-clear, made into a failure that names itself.
      const { said, code } = await runCheck(fixture(broken));
      expect(said).toContain(says);
      expect(said).not.toContain('matches');
      expect(code).toBe(1);
    },
  );

  it('says so when the routes agreed and no parameter was compared', async () => {
    // The count in the success line is also the only evidence the parameter half
    // ran. Both sides empty is not a match, it is a comparison that did not happen.
    const { said, code } = await runCheck(
      fixture({ version: 1, routes: ['GET templates'], parameters: {} }),
    );
    expect(said).toContain('compared zero parameters across 1 shared routes');
    expect(code).toBe(1);
  });

  it('skips, and says so, when no platform is checked out', async () => {
    const { said, code } = await runCheck(undefined, fixture(null));
    // Only when nothing next door answers either; a sibling checkout on this
    // machine is a real comparison, which is also fine.
    if (said.includes('skipping')) expect(code).toBe(0);
    else expect(said).toMatch(/matches|drifted/);
  });

  it('refuses a MANDALA_PLATFORM_REPO that does not hold the platform', async () => {
    // The variable is an assertion, and the machine that sets it is the one
    // machine where this gate is enforced — for three SDKs at once. Read as a
    // guess, a checkout that moved is indistinguishable from no platform at all.
    const { said, code } = await runCheck(fixture(null));
    expect(code).toBe(1);
    expect(said).toContain('does not hold surface-manifest.json');
    expect(said).not.toContain('skipping');
  });

  it('resolves a relative MANDALA_PLATFORM_REPO against this repo', async () => {
    const root = resolve(__dirname, '..');
    const manifest = inStep();
    manifest.routes.push('GET alpha');
    const dir = fixture(manifest, join(root, 'node_modules/.cache'));
    const { said } = await runCheck(relative(root, dir), tmpdir());
    expect(said).toContain('+ GET alpha');
  });
});
