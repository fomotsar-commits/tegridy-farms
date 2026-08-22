import { test, expect } from '@playwright/test';
// Safe to import: constants.ts is a dependency-free constants module (zero imports),
// so pulling it into the Playwright graph costs nothing and drags in no browser code.
import { SITE_URL } from '../src/lib/constants';
import { gotoRoute } from './fixtures/routes';

/**
 * Trust-signal page coverage.
 *
 * Pages a VC/auditor/journalist hits first when evaluating the protocol.
 * These tests verify the page loads, the canonical trust signals are
 * present, and the big "is this real" elements render. They don't
 * exercise transactional flows (covered by wallet-connect.spec.ts).
 *
 * ⚠ EVERY ROUTE HERE IS ENTERED THROUGH `gotoRoute`, NOT `page.goto`, and the
 * difference is the whole reason five of these tests were reported red.
 *
 * The symptom was `locator('h1') element(s) not found` after 5s on /security,
 * /contracts, /risks, /changelog and /faq. The obvious readings — wrong
 * selector, broken page — are both wrong, and were checked: the pages render,
 * /security's h1 is "Security & Transparency", and the same five pass at
 * --workers=1 in about two seconds each. They fail at the local default worker
 * count (9 on the machine this was measured on) and ONLY on the WebKit
 * projects, because every page is a `lazy()` chunk behind Suspense and the
 * default 5s expect budget is not enough to fetch and evaluate one while eight
 * siblings compete for the same preview server. CI runs `workers: 1`, which is
 * why CI never saw it.
 *
 * Raising a timeout would have been the wrong fix — the assertion would still
 * have been racing the chunk. `gotoRoute` waits for the Suspense fallback to
 * be gone before anything is asserted, so what follows depends on the app and
 * not on the host's core count.
 */

test.describe('Trust pages', () => {
  test('security page renders core trust signals', async ({ page }) => {
    await gotoRoute(page, '/security');
    await expect(page.locator('h1')).toBeVisible();
    // Must link out to audit artifacts in the repo.
    const body = page.locator('body');
    await expect(body).toContainText(/audit/i);
  });

  test('contracts page lists deployed addresses with Etherscan links', async ({ page }) => {
    await gotoRoute(page, '/contracts');
    await expect(page.locator('h1')).toBeVisible();
    // Should expose at least one Etherscan link to a deployed contract.
    const etherscanLinks = page.locator('a[href*="etherscan.io/address/"]');
    await expect(etherscanLinks.first()).toBeVisible();
    // TOWELI token address is the headline reference.
    await expect(page.getByText(/0x420698/i).first()).toBeVisible();
  });

  test('treasury page loads with on-chain stats region', async ({ page }) => {
    await gotoRoute(page, '/treasury');
    await expect(page.locator('h1')).toBeVisible();
  });

  test('tokenomics page shows supply', async ({ page }) => {
    await gotoRoute(page, '/tokenomics');
    await expect(page.locator('h1')).toBeVisible();
    // Fixed supply is the core honesty signal.
    await expect(page.locator('body')).toContainText(/1,?000,?000,?000|1B/);
  });

  test('changelog page loads', async ({ page }) => {
    await gotoRoute(page, '/changelog');
    await expect(page.locator('h1')).toBeVisible();
  });

  test('risks page loads with disclosure content', async ({ page }) => {
    await gotoRoute(page, '/risks');
    await expect(page.locator('h1')).toBeVisible();
    await expect(page.locator('body')).toContainText(/risk/i);
  });

  test('history page loads (may be paginated)', async ({ page }) => {
    await gotoRoute(page, '/history');
    // HistoryPage uses an h2 inside the timeline shell; document title
    // (set via usePageTitle) is the authoritative "did this route mount".
    await expect(page).toHaveTitle(/History/i);
  });
});

test.describe('SEO & social metadata', () => {
  test('home page canonical matches the declared SITE_URL', async ({ page }) => {
    await page.goto('/');
    // Canonical URL is set via usePageTitle on mount.
    //
    // This asserted `/tegridyfarms\.(xyz|vercel\.app)/` until 2026-07-30, with a comment
    // saying it accepted both "so this test survives the cutover without churn". It did
    // not survive it — hardcoding two domain literals is what made the memetic.fun
    // cutover fail CI. Pin the INVARIANT instead: the rendered canonical must equal the
    // single source of truth it is generated from. That still catches real drift (a stray
    // literal reappearing in usePageTitle, which is exactly how this drifted before) while
    // surviving any future domain change with no edit here.
    const canonical = await page.locator('link[rel="canonical"]').getAttribute('href');
    expect(canonical).toBeTruthy();
    expect(canonical?.replace(/\/$/, '')).toBe(SITE_URL.replace(/\/$/, ''));

    const ogImage = await page.locator('meta[property="og:image"]').getAttribute('content');
    expect(ogImage).toBeTruthy();
    expect(ogImage).toMatch(/^https?:\/\//);
    // The share image must live on the same origin we just declared canonical —
    // an og:image on a stale host is how a rebrand ships broken unfurls.
    expect(ogImage?.startsWith(SITE_URL)).toBe(true);
  });

  test('page title reflects route', async ({ page }) => {
    await gotoRoute(page, '/faq');
    await expect(page).toHaveTitle(/FAQ/i);
    await gotoRoute(page, '/security');
    await expect(page).toHaveTitle(/Security/i);
  });

  test('sitemap.xml is served and lists primary routes', async ({ page }) => {
    const res = await page.request.get('/sitemap.xml');
    expect(res.status()).toBe(200);
    const body = await res.text();
    expect(body).toContain('<urlset');
    expect(body).toContain('/farm');
    expect(body).toContain('/swap');
    // NOT '/lending' — that route is a redirect to /nft-finance (App.tsx:236),
    // and a sitemap should list the destination, not the redirect.
    expect(body).toContain('/nft-finance');
    // lastmod was added in the Wave 2 SEO pass.
    expect(body).toContain('<lastmod>');
  });

  test('manifest.json parses with required PWA fields', async ({ page }) => {
    const res = await page.request.get('/manifest.json');
    expect(res.status()).toBe(200);
    const json = await res.json();
    expect(json.name).toBeTruthy();
    expect(json.start_url).toBeTruthy();
    expect(json.icons).toBeInstanceOf(Array);
    expect(json.icons.length).toBeGreaterThanOrEqual(2);
    // Both 192 and 512 icons present (audit fix replacing broken skeleton.jpg refs).
    const sizes = json.icons.map((i: { sizes: string }) => i.sizes);
    expect(sizes).toContain('192x192');
    expect(sizes).toContain('512x512');
  });

  test('robots.txt is served', async ({ page }) => {
    const res = await page.request.get('/robots.txt');
    expect(res.status()).toBe(200);
  });

  test('og.svg hero banner is served', async ({ page }) => {
    const res = await page.request.get('/og.svg');
    expect(res.status()).toBe(200);
    const ctype = res.headers()['content-type'] ?? '';
    // Vercel may return as image/svg+xml or application/xml depending on config.
    expect(ctype).toMatch(/svg|xml/);
  });
});
