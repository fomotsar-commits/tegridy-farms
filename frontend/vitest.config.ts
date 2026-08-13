import { defineConfig, configDefaults } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test/setup.ts',
    // ─────────────────────────────────────────────────────────────────
    // COLLECTION IS PROJECT-WIDE, AND IT HAS ONE HARD EDGE. READ BOTH.
    //
    // This used to be `['src/**/*.test.*', 'api/**/*.test.*']`, which meant a
    // test file written anywhere else in frontend/ — frontend/test/,
    // frontend/scripts/, alongside a config — was collected by nothing and
    // ran nowhere, silently, forever. No error, no warning: vitest just
    // reports on the files it found. Widened to the whole project so the
    // location of a test file stops being a load-bearing secret.
    //
    // ⚠ THE EDGE: `root` is frontend/, so NOTHING OUTSIDE frontend/ CAN BE
    // COLLECTED — not repo-root scripts/, not contracts/, not solana/. A
    // `scripts/foo.test.mjs` at the repo root runs in no pipeline. Those
    // scripts are proven instead by `--self-test` entry points invoked
    // directly from .github/workflows/ci.yml; if you write a real unit test
    // for one, it needs a runner, not a hope.
    //
    // src/test/vitestCollection.test.ts enforces both halves: every
    // `*.test.*` file tracked by git is either collected here or explicitly
    // accounted for as belonging to another runner. A new test file in a new
    // directory fails that guard rather than disappearing.
    //
    // .test.{js,jsx} is included for the nakamigos marketplace, which is
    // plain JS.
    include: ['**/*.test.{js,jsx,mjs,ts,tsx}'],
    exclude: [
      ...configDefaults.exclude, // node_modules, dist, .git, *.config.*, …
      // Playwright owns e2e/ — its specs are `.spec.ts`, but the directory is
      // excluded explicitly so a `.test.ts` helper landing there cannot be
      // dragged into jsdom.
      'e2e/**',
      'playwright-report/**',
      'test-results/**',
      // Build/deploy scratch that is not source.
      '.vercel/**',
      'public/**',
      'supabase/**',
      'plan/**',
      'plan_input/**',
    ],
  },
  resolve: {
    alias: {
      '@': '/src',
    },
  },
});
