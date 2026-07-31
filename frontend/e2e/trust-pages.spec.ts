import { test, expect } from '@playwright/test';
// Safe to import: constants.ts is a dependency-free constants module (zero imports),
// so pulling it into the Playwright graph costs nothing and drags in no browser code.
import { SITE_URL } from '../src/lib/constants';

/**
 * Trust-signal page coverage.
 *
 * Pages a VC/auditor/journalist hits first when evaluating the protocol.
 * These tests verify the page loads, the canonical trust signals are
 * present, and the big "is this real" elements render. They don't
 * exercise transactional flows (covered by wallet-connect.spec.ts).
 */

test.describe('Trust pages', () => {
  test('security page renders core trust signals', async ({ page }) => {
    await page.goto('/security');
    await expect(page.locator('h1')).toBeVisible();
    // Must link out to audit artifacts in the repo.
    const body = page.locator('body');
    await expect(body).toContainText(/audit/i);
  });

  test('contracts page lists deployed addresses with Etherscan links', async ({ page }) => {
    await page.goto('/contracts');
    await expect(page.locator('h1')).toBeVisible();
    // Should expose at least one Etherscan link to a deployed contract.
    const etherscanLinks = page.locator('a[href*="etherscan.io/address/"]');
    await expect(etherscanLinks.first()).toBeVisible();
    // TOWELI token address is the headline reference.
    await expect(page.getByText(/0x420698/i).first()).toBeVisible();
  });

  test('treasury page loads with on-chain stats region', async ({ page }) => {
    await page.goto('/treasury');
    await expect(page.locator('h1')).toBeVisible();
  });

  test('tokenomics page shows supply', async ({ page }) => {
    await page.goto('/tokenomics');
    await expect(page.locator('h1')).toBeVisible();
    // Fixed supply is the core honesty signal.
    await expect(page.locator('body')).toContainText(/1,?000,?000,?000|1B/);
  });

  test('changelog page loads', async ({ page }) => {
    await page.goto('/changelog');
    await expect(page.locator('h1')).toBeVisible();
  });

  test('risks page loads with disclosure content', async ({ page }) => {
    await page.goto('/risks');
    await expect(page.locator('h1')).toBeVisible();
    await expect(page.locator('body')).toContainText(/risk/i);
  });

  test('history page loads (may be paginated)', async ({ page }) => {
    await page.goto('/history');
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
    await page.goto('/faq');
    await expect(page).toHaveTitle(/FAQ/i);
    await page.goto('/security');
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
