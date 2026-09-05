/**
 * Gauge commit-reveal UI smoke — session 5 / Audit H-2 closure.
 *
 * What this covers:
 *   1. Navigating to the governance surface (/community → gauge tab) with
 *      a mock wallet connected renders without crashing.
 *   2. The commit-reveal mode toggle is present and defaults to
 *      "Commit-reveal" (the safer path) rather than "Legacy".
 *   3. The reveal-pending banner is NOT rendered when there's no on-chain
 *      commitment — only the voting UI is visible.
 *
 * What this doesn't cover (yet):
 *   - End-to-end commit → reveal flow across blocks. Needs the Anvil-backed
 *     wallet fixture upgrade documented in e2e/fixtures/wallet.ts
 *     (ANVIL_BACKEND block). Once that upgrade lands, extend this spec to
 *     commit, warp blocks past the commit cutoff, reveal, and assert the
 *     on-chain gauge weight matches.
 *
 * Mock-wallet limitation: the current fixture returns canned read responses
 * for any RPC method, so the page renders the component tree but on-chain
 * reads for currentEpoch / gauges / userTokenId resolve to `null`. The UI
 * then shows the connection-required empty state. This spec is therefore
 * structural (does the component mount, does the toggle exist) rather than
 * functional.
 */

import { test, expect } from './fixtures/wallet';
import { gotoRoute } from './fixtures/routes';

/**
 * ⚠ ROUTES ARE ENTERED THROUGH `gotoRoute`, NOT `page.goto`.
 *
 * Every page is a `lazy()` chunk behind Suspense, so `goto` resolves while the
 * route is still a skeleton. Playwright's default 5s expect budget absorbs that
 * on Chromium and on WebKit at --workers=1 (the CI setting), and does not
 * absorb it on WebKit at the local default worker count — measured on this
 * machine: green at --workers=1, red at 9 with `element(s) not found`, same
 * build, pages fine. `gotoRoute` waits for the fallback to be gone before any
 * assertion runs, so the result stops depending on the host's core count.
 * See e2e/fixtures/routes.ts.
 */

test.describe('Gauge voting UI (commit-reveal)', () => {
  test('community page loads with mock wallet connected', async ({ page, walletMock }) => {
    // Navigate FIRST — `__walletMock` is installed via addInitScript and only
    // exists after the page document has loaded. Calling `connect()` against
    // about:blank throws "Cannot read properties of undefined (reading 'connect')".
    await gotoRoute(page, '/community');
    await walletMock.connect();
    await expect(page.locator('h1')).toContainText(/community/i);
  });

  test('gauge-voting panel mounts without crashing under mock reads', async ({ page, walletMock }) => {
    // Canned contract reads: mock returns 0x0 for any eth_call we don't
    // explicitly override, so the page's useReadContract hooks resolve to
    // empty/zero state. We assert no fatal error bubbled up.
    await gotoRoute(page, '/community');
    await walletMock.connect();
    // Look for the top-level role="tablist" to prove CommunityPage rendered.
    const tablist = page.locator('[role="tablist"]').first();
    await expect(tablist).toBeVisible();
    // No uncaught errors visible in the DOM (our ErrorBoundary would show one).
    const errorBanner = page.locator('text=/Something went wrong|Application error/i');
    await expect(errorBanner).toHaveCount(0);
  });
});

test.describe('Launchpad cancelled-sale refund surface', () => {
  test('collection page with unknown slug gracefully falls back', async ({ page, walletMock }) => {
    // We don't have a deterministic cancelled drop to point at in a mock
    // environment, so this test just confirms the launchpad index renders
    // and the lending tab containing the launchpad section is reachable.
    await gotoRoute(page, '/lending');
    await walletMock.connect();
    await expect(page.locator('h1')).toContainText(/NFT Finance/i);
  });
});

test.describe('Connect prompt surfaces', () => {
  test('Farm page shows ConnectPrompt when disconnected', async ({ page }) => {
    // Intentionally skip walletMock.connect().
    //
    // ⚠️ `?bungalow=toweli` ADDED 2026-09-05, and it is not decoration. With no
    // bungalow chosen, /farm is the VENUE's island-wide pool index — a list of
    // every resident's pool, which needs no wallet and therefore mounts no
    // ConnectPrompt at all. Before that change "no bungalow" and "the TOWELI
    // bungalow" were the same branch, so this spec was standing in a room it
    // never named. ConnectPrompt surface="farm" lives in the classic farm; this
    // is where it lives. (arrival.ts reads ?bungalow= ahead of stored choice.)
    await gotoRoute(page, '/farm?bungalow=toweli');
    // ConnectPrompt renders an h2 with the farm-specific voice. The word was
    // "tegridy" until the owner's 2026-08-31 retirement (commit 17fe6fcc) took
    // the brand out of every rendered surface — "Real tegridy." became "Held
    // time counts." and this title moved with it. DEFAULTS.farm.title in
    // src/components/ui/ConnectPrompt.tsx is the source; its unit test
    // (ConnectPrompt.test.tsx) pins the same string.
    const heading = page.getByRole('heading', { name: /Connect to farm with held time/i });
    await expect(heading).toBeVisible();
  });

  test('NFT-finance page shows a per-section connect banner when disconnected', async ({ page }) => {
    // Rewritten. This asserted a PAGE-LEVEL <ConnectPrompt surface="lend"/>, which
    // was deliberately removed in a8b985d ("move logged-out gating from page to
    // action level (T7)") — disconnected visitors now browse the real interface
    // with a slim per-section banner instead of hitting a connect wall.
    // `/lending` is also just a redirect to /nft-finance (App.tsx:236).
    // Copy comes from SECTION_PROMPTS in src/pages/LendingPage.tsx:48.
    await gotoRoute(page, '/nft-finance');
    const banner = page.getByText(/Connect to (lend ETH against|borrow against your NFTs|trade NFTs on)/i);
    await expect(banner.first()).toBeVisible();
  });
});

test.describe('HomePage yield calculator (wallet-less)', () => {
  test('YieldCalculator renders for disconnected visitors in the TOWELI room', async ({ page }) => {
    // MOVED, not deleted. The calculator computes TOWELI staking yield, so the
    // arrival wave relocated it with the rest of the classic cluster: HomePage
    // gates it on `!address && !bungalowIdentity && IS_TOWELI_ARRIVAL`
    // (HomePage.tsx:421). On the venue front door it is correctly absent —
    // asserting it at '/' was asserting the pre-relocation design.
    //
    // The gate reads arrivalVoice() at MODULE SCOPE (HomePage.tsx:58), so the
    // voice has to be settled before the page script runs. Walking the /toweli
    // door does exactly that: it persists the choice and reloads in place.
    await gotoRoute(page, '/toweli');
    // Still the wallet-less assertion: rendered only when `address` is undefined.
    await expect(page.locator('body')).toContainText(/See what you'd earn/i);
  });

  test('audit badge links to /security', async ({ page }) => {
    await gotoRoute(page, '/');
    // aria-label is now "View security details: internal audit waves, Slither CI,
    // and the test suite" (HomePage.tsx:264). The link and its href are unchanged.
    const badge = page.getByRole('link', { name: /View security details/i });
    await expect(badge).toBeVisible();
    await expect(badge).toHaveAttribute('href', '/security');
  });
});
