import os from 'node:os';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// ─────────────────────────────────────────────────────────────────────────
// /curve-launch LAUNCH AND TRADE, end to end, on a LOCAL validator.
//
//   node scripts/solana-localnet/genesis-accounts.mjs
//   MSYS_NO_PATHCONV=1 wsl.exe -d Ubuntu -- bash -l /mnt/c/.../frontend/scripts/solana-localnet/start-validator.sh   (leave running)
//   npm run e2e:solana
//
// Kept apart from playwright.config.ts on purpose: it needs a running validator with
// the exact mainnet binaries (start-validator.sh), so it cannot ride the default suite,
// and its testDir (./e2e-solana) is outside that suite's ./e2e.
//
// The app is a PRODUCTION build in the one named mode that honours env overrides
// (`--mode solana-e2e`, see src/lib/launcher/solana/curveWriteFlag.ts). Those
// overrides point it at the registered program ids on a localnet cluster; a real
// production build ignores every one of them. `vite preview` forwards /api/solrpc to
// SOLANA_RPC_URL (vite.config.ts), i.e. the WSL validator via localhost forwarding,
// and e2e-solana/fixtures/rpcGuard.ts holds every call to production's allowlist.
//
// One worker, one browser: every spec moves money on one shared chain, in order.
// ─────────────────────────────────────────────────────────────────────────
const PORT = 4180;
// Build output and reports live OUTSIDE frontend/: `npm run lint` is `eslint .` with only
// dist/ ignored, so a minified build or an HTML report left in the tree would fail lint.
const OUT = path.join(os.tmpdir(), 'tegridy-solana-e2e');
const DIST = path.join(OUT, 'dist');
const LOCALNET = process.env.E2E_SOLANA_RPC ?? 'http://127.0.0.1:8899';

const buildEnv = {
  VITE_SOLANA_CURVE_WRITES: '1',
  VITE_SOLANA_CURVE_PROGRAM: '64WBTeNcrSHfmBpiqymyifW6FUNNLvJcuiqF9rXmz4q2',
  VITE_SOLANA_CPSWAP_PROGRAM: 'EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT',
  VITE_SOLANA_CLUSTER: 'localnet',
  SOLANA_RPC_URL: LOCALNET,
};

export default defineConfig({
  testDir: './e2e-solana',
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list'], ['html', { outputFolder: path.join(OUT, 'report'), open: 'never' }]],
  outputDir: path.join(OUT, 'test-results'),
  globalSetup: './e2e-solana/global-setup.ts',
  // The full flow signs ~12 transactions and waits for each; specs set their own
  // longer budgets with test.setTimeout. This is the floor for the short ones.
  timeout: 120_000,
  expect: { timeout: 20_000 },
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // A registered service worker answers fetches before page.route sees them,
    // which would silently bypass the RPC guard and the upload stub
    // (see the long note in playwright.config.ts).
    serviceWorkers: 'block',
    contextOptions: { reducedMotion: 'reduce' },
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    // The LP read specs also run as a phone (Chromium with a mobile viewport, touch and
    // user agent). WebKit is not run on this machine: Windows Smart App Control blocks it.
    // Anchored to the FILE NAME: Playwright matches against the absolute path, and an
    // unanchored /lp-.*/ also matched a checkout folder such as "solana-lp-s2", which ran
    // every spec as a phone.
    { name: 'mobile-chrome', testMatch: /(^|[\\/])lp-[^\\/]*\.spec\.ts$/, use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: `npx vite build --mode solana-e2e --outDir "${DIST}" --emptyOutDir && npx vite preview --mode solana-e2e --outDir "${DIST}" --port ${PORT} --strictPort`,
    port: PORT,
    // Never reuse: a server left over from another build would test other code.
    reuseExistingServer: false,
    timeout: 900_000,
    env: buildEnv,
  },
});
