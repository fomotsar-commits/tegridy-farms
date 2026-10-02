// @vitest-environment node
//
// "A dev server" is the command that compiled the code, never NODE_ENV. Vite inlines
// import.meta.env.DEV from NODE_ENV even in `vite build`, so a build host with
// NODE_ENV=development used to ship a door whose dials still worked. Proven on a real
// `vite build` of the two gates, with that environment and the define vite.config.ts
// gives a build.
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build, type ConfigEnv, type UserConfig } from 'vite';
import viteConfig from '../../vite.config';
import { compiledByDevServer } from './devServer';

const FRONTEND = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const configFor = (command: ConfigEnv['command']) =>
  (viteConfig as (env: ConfigEnv) => UserConfig)({ command, mode: 'production', isSsrBuild: false, isPreview: false });

describe('a dev server is decided by the command, not by NODE_ENV', () => {
  it('vite.config.ts defines it true for `vite` and false for `vite build`; vitest counts as a dev server', () => {
    expect(configFor('serve').define?.__VITE_DEV_SERVER__).toBe('true');
    expect(configFor('build').define?.__VITE_DEV_SERVER__).toBe('false');
    expect(compiledByDevServer()).toBe(true);
  });

  it('a `vite build` with NODE_ENV=development and every dial set keeps the door at 80 and writes off', async () => {
    const dials: Record<string, string> = {
      NODE_ENV: 'development',
      VITE_HEAT_GATE: 'off',
      VITE_HEAT_LAUNCH_FLOOR: '60',
      VITE_SOLANA_CURVE_WRITES: '1',
    };
    const saved = Object.fromEntries(Object.keys(dials).map((k) => [k, process.env[k]]));
    const out = mkdtempSync(join(tmpdir(), 'dev-server-build-'));
    try {
      Object.assign(process.env, dials);
      await build({
        root: FRONTEND,
        configFile: false,
        logLevel: 'silent',
        publicDir: false,
        cacheDir: join(out, 'cache'),
        define: configFor('build').define,
        build: {
          outDir: join(out, 'dist'),
          emptyOutDir: true,
          minify: false,
          lib: {
            entry: {
              heat: join(FRONTEND, 'src/lib/heat/heatGateConfig.ts'),
              flag: join(FRONTEND, 'src/lib/launcher/solana/curveWriteFlag.ts'),
            },
            formats: ['es'],
          },
        },
      });
      const heat = await import(pathToFileURL(join(out, 'dist', 'heat.js')).href);
      const flag = await import(pathToFileURL(join(out, 'dist', 'flag.js')).href);
      expect(heat.heatEnvOverridesAllowed()).toBe(false);
      expect(heat.isHeatGateEnabled()).toBe(true);
      expect(heat.heatLaunchFloor()).toBe(80);
      expect(flag.curveWriteEnvOverridesAllowed()).toBe(false);
      expect(flag.isCurveWriteEnabled()).toBe(false);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(out, { recursive: true, force: true });
    }
  }, 60_000);
});
