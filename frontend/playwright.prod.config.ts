// Production console sweep — NOT part of CI.
//
// `playwright.config.ts` has `testDir: './e2e'`, so nothing here is picked up by
// the CI e2e job. This config exists so the sweep can be aimed at a DEPLOYED
// origin, which is the whole point: it catches the class of bug that is invisible
// to a build (see e2e-prod/console-sweep.spec.ts for the one that motivated it).
//
//   npx playwright test --config=playwright.prod.config.ts
//   PROD_URL=https://memetics.finance npx playwright test --config=playwright.prod.config.ts
//
// `retries: 0` on purpose — a retry would mask exactly the intermittent console
// error this is looking for. Workers are low because it hits a real origin with a
// real rate limit, not a local preview.
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e-prod',
  timeout: 120_000,
  workers: 3,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: process.env.PROD_URL || 'https://memetic.fun',
    ...devices['Desktop Chrome'],
    // The intro overlay is a z-9999 canvas that eats interaction; reduced motion
    // skips it (reference_app_intro_overlay_blocks_probes).
    reducedMotion: 'reduce',
  },
});
