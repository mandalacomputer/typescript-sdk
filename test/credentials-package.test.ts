import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const corpus = JSON.parse(
  fs.readFileSync(new URL('./fixtures/credentials-v1.json', import.meta.url), 'utf8'),
);

/** All entrypoints below resolve inside the unpacked tarball, outside this source tree. */
describe('published credential package', () => {
  it(`${corpus.browser_cases.map((c: { id: string }) => c.id).join(', ')}; Node and declarations`, () => {
    const temp = fs.mkdtempSync(join(os.tmpdir(), 'mandala-package-'));
    try {
      const source = join(temp, 'clean-source');
      fs.mkdirSync(source);
      for (const name of [
        'src',
        'package.json',
        'tsconfig.json',
        'tsconfig.build.json',
        'README.md',
        'LICENSE',
      ])
        fs.cpSync(join(root, name), join(source, name), { recursive: true });
      expect(fs.existsSync(join(source, 'dist'))).toBe(false);
      fs.symlinkSync(join(root, 'node_modules'), join(source, 'node_modules'), 'dir');
      const tsc = join(root, 'node_modules/typescript/bin/tsc');
      execFileSync(process.execPath, [tsc, '-p', 'tsconfig.build.json'], {
        cwd: source,
        stdio: 'pipe',
      });
      const npmPath = [
        join(dirname(process.execPath), 'npm'),
        ...(process.env.PATH ?? '').split(delimiter).map((dir) => join(dir, 'npm')),
      ].find((name) => fs.existsSync(name));
      if (!npmPath) throw new Error('Package proof requires the installed npm CLI');
      const npm = fs.realpathSync(npmPath);
      const env = {
        ...process.env,
        npm_config_cache: join(temp, 'cache'),
        HOME: join(temp, 'home'),
        MANDALA_API_KEY: '',
        MANDALA_PROFILE: '',
        MANDALA_BASE_URL: '',
      };
      fs.mkdirSync(env.HOME);
      const packed = JSON.parse(
        execFileSync(
          process.execPath,
          [npm, 'pack', '--json', '--ignore-scripts', '--pack-destination', temp],
          { cwd: source, env, encoding: 'utf8' },
        ),
      );
      const consumer = join(temp, 'consumer');
      const modules = join(consumer, 'node_modules');
      fs.mkdirSync(modules, { recursive: true });
      execFileSync('tar', ['-xzf', join(temp, packed[0].filename), '-C', modules]);
      const packageDir = join(modules, 'mandala-computer');
      fs.renameSync(join(modules, 'package'), packageDir);
      expect(fs.existsSync(join(packageDir, 'src'))).toBe(false);
      fs.writeFileSync(join(consumer, 'package.json'), '{"type":"module"}');
      const store = join(env.HOME, '.mandala');
      fs.mkdirSync(store, { mode: 0o700 });
      fs.writeFileSync(join(store, 'credentials.json'), JSON.stringify(corpus.base_document), {
        mode: 0o600,
      });
      const nodeScript = `import assert from 'node:assert/strict';
        import { Client } from 'mandala-computer';
        const seen=[];
        const c=new Client({profile:'Work',fetch:async(url,init)=>{seen.push([String(url),init.headers.Authorization]);return Response.json([])}});
        await c.computers.list();
        assert.deepEqual(seen,[[${JSON.stringify(`${corpus.base_document.profiles.Work.base_url}/computers`)},${JSON.stringify(`Bearer ${corpus.base_document.profiles.Work.api_key}`)}]]);
        console.log('packed Node PASS');`;
      fs.writeFileSync(join(consumer, 'node.mjs'), nodeScript);
      expect(
        execFileSync(process.execPath, ['node.mjs'], { cwd: consumer, env, encoding: 'utf8' }),
      ).toContain('packed Node PASS');
      // Node's explicit browser condition checks the ordering before its built-in node condition.
      fs.writeFileSync(
        join(consumer, 'condition.mjs'),
        `import assert from 'node:assert/strict'; import {Client} from 'mandala-computer'; assert.throws(()=>new Client({profile:'Work'}),/unavailable/); console.log('browser condition PASS');`,
      );
      expect(
        execFileSync(process.execPath, ['--conditions=browser', 'condition.mjs'], {
          cwd: consumer,
          env,
          encoding: 'utf8',
        }),
      ).toContain('browser condition PASS');
      // A VM module linker has exactly the requested conditions, with no built-in Node condition.
      // It walks and evaluates every static/dynamic dependency. Node imports are rejected at linking.
      const browserScript = `import assert from 'node:assert/strict';
        import fs from 'node:fs'; import path from 'node:path'; import vm from 'node:vm';
        const packageDir=path.resolve('node_modules/mandala-computer');
        const pkg=JSON.parse(fs.readFileSync(path.join(packageDir,'package.json'),'utf8'));
        const condition=process.argv[2];
        const pick=(value)=>{if(typeof value==='string')return value;for(const [key,target] of Object.entries(value)){if(key==='default'||key===condition)return pick(target);}throw Error('unresolved condition')};
        const context=vm.createContext({URL,URLSearchParams,Headers,Response,Request,TextDecoder,TextEncoder,AbortController,AbortSignal,DOMException,setTimeout,clearTimeout,performance});
        const cache=new Map();
        const load=(filename)=>{
          if(cache.has(filename))return cache.get(filename);
          assert(filename.startsWith(packageDir+path.sep),'outside packed package');
          const module=new vm.SourceTextModule(fs.readFileSync(filename,'utf8'),{context,identifier:filename});
          cache.set(filename,module);return module;
        };
        const link=(specifier,from)=>{
          if(specifier.startsWith('#'))return load(path.resolve(packageDir,pick(pkg.imports[specifier])));
          assert(specifier.startsWith('.'),'Node or external import in browser graph: '+specifier);
          return load(path.resolve(path.dirname(from.identifier),specifier));
        };
        const entry=load(path.resolve(packageDir,pick(pkg.exports['.'])));
        await entry.link(link);await entry.evaluate();
        assert.equal(vm.runInContext('typeof process+":"+typeof Buffer',context),'undefined:undefined');
        const seen=[]; const client=new entry.namespace.Client({apiKey:'public-browser-canary',fetch:async(url,init)=>{seen.push([String(url),init.headers.Authorization]);return Response.json([])}});
        await client.computers.list();assert.equal(seen.length,1);assert.equal(seen[0][1],'Bearer public-browser-canary');
        assert.throws(()=>new entry.namespace.Client({profile:'Work'}),/unavailable/);
        vm.runInContext('globalThis.process = {}',context);
        const shimClient=new entry.namespace.Client({apiKey:'public-browser-shim-canary',fetch:async(url,init)=>{seen.push([String(url),init.headers.Authorization]);return Response.json([])}});
        await shimClient.computers.list();assert.equal(seen[1][1],'Bearer public-browser-shim-canary');
        assert.throws(()=>new entry.namespace.Client({profile:'Work'}),/unavailable/);
        console.log(condition+' graph execution PASS');`;
      fs.writeFileSync(join(consumer, 'browser.mjs'), browserScript);
      for (const condition of ['browser', 'default'])
        expect(
          execFileSync(process.execPath, ['--experimental-vm-modules', 'browser.mjs', condition], {
            cwd: consumer,
            env,
            encoding: 'utf8',
            stdio: 'pipe',
          }),
        ).toContain('graph execution PASS');
      const typeConfig = {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'es2023',
          module: 'node16',
          moduleResolution: 'node16',
          lib: ['es2023', 'dom', 'esnext.disposable'],
          types: [],
        },
        files: ['consumer.ts'],
      };
      fs.writeFileSync(
        join(consumer, 'consumer.ts'),
        `import { Client, type ClientOptions } from 'mandala-computer'; const options: ClientOptions={profile:'Work',apiKey:'synthetic'}; const client:Client=new Client(options); void client;`,
      );
      fs.writeFileSync(join(consumer, 'tsconfig.json'), JSON.stringify(typeConfig));
      execFileSync(process.execPath, [tsc, '-p', 'tsconfig.json'], {
        cwd: consumer,
        stdio: 'pipe',
      });
      // Also ask a bundler-style declaration resolver for browser/default conditions.
      fs.writeFileSync(
        join(consumer, 'tsconfig.json'),
        JSON.stringify({
          ...typeConfig,
          compilerOptions: {
            ...typeConfig.compilerOptions,
            module: 'esnext',
            moduleResolution: 'bundler',
            customConditions: ['browser'],
          },
        }),
      );
      execFileSync(process.execPath, [tsc, '-p', 'tsconfig.json'], {
        cwd: consumer,
        stdio: 'pipe',
      });
      const manifest = JSON.parse(fs.readFileSync(join(packageDir, 'package.json'), 'utf8'));
      manifest.imports['#credentials'].browser = manifest.imports['#credentials'].node;
      manifest.imports['#credentials'].default = manifest.imports['#credentials'].node;
      fs.writeFileSync(join(packageDir, 'package.json'), JSON.stringify(manifest));
      for (const condition of ['browser', 'default']) {
        let error: unknown;
        try {
          execFileSync(process.execPath, ['--experimental-vm-modules', 'browser.mjs', condition], {
            cwd: consumer,
            env,
            stdio: 'pipe',
          });
        } catch (caught) {
          error = caught;
        }
        expect(error).toBeDefined();
        expect(String((error as { stderr: Buffer }).stderr)).toContain(
          'Node or external import in browser graph',
        );
      }
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }, 60_000);
});
