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
// error this is looking for.
//
// ⚠️ `workers: 1`, and it MUST stay there. At 3 workers this sweep generated its
// OWN failure: 64 routes each firing ~5 keyless GeckoTerminal reads tripped the
// upstream rate limit, api/_lib/pool-market.js maps any non-404 upstream status
// to 502 (:153), and /soy and /brainlet then failed on a 502 that no user would
// ever see — 12/12 hand probes of those same URLs returned 200. A post-deploy
// check that manufactures the fault it reports is worse than no check, because
// the noise teaches you to ignore it. Slower and honest beats fast and lying.
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e-prod',
  timeout: 120_000,
  workers: 1,
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
