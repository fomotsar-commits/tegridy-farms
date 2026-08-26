import { test, expect, type Page } from '@playwright/test';

// Jungle Bay bungalow doors — the memetics.finance/<bungalow> URL format.
//
// Deliberately fixture-free: the wallet fixture pins `tegridy-bungalow` to
// toweli (to keep every other spec picker-free), and these tests are ABOUT
// entering bungalows, so they seed only the overlay flags and leave the
// bungalow choice to the door under test. reducedMotion comes from
// playwright.config (the splash self-skips).
//
// The door mechanic is persist + reload-in-place, so each first visit
// triggers one full navigation; assertions use generous timeouts and the
// URL checks read the FINAL location.

async function seedOverlays(page: Page) {
  await page.addInitScript(() => {
    try {
      sessionStorage.setItem('tf_loaded', '1');
      localStorage.setItem('tegridy-onboarding-seen', '1');
      localStorage.setItem('tegridy-onboarding-bayla-seen', '1');
      localStorage.setItem('tegridy_telemetry_consent', 'denied');
    } catch { /* ignore */ }
  });
}

test.describe('bungalow doors', () => {
  test('/bayla enters her bungalow and keeps the address', async ({ page }) => {
    await seedOverlays(page);
    await page.goto('/bayla');
    // Door persists + reloads in place; the hero is the post-reload proof.
    await expect(page.locator('h1').first()).toContainText('BAYLA', { timeout: 20_000 });
    expect(new URL(page.url()).pathname).toBe('/bayla');
    expect(await page.evaluate(() => localStorage.getItem('tegridy-bungalow'))).toBe('bayla');
    // Backgrounds are hers; the TOWELI headline is gone.
    await expect(page.locator('img[data-art-surface]').first()).toBeVisible({ timeout: 20_000 });
    const srcs = await page.$$eval('img[data-art-surface]', (imgs) =>
      imgs.map((i) => ({ surface: i.getAttribute('data-art-surface') ?? '', src: i.getAttribute('src') ?? '' })));
    for (const s of srcs.filter((x) => !x.surface.startsWith('nav-logo'))) {
      expect(s.src, `${s.surface} should draw from her pool`).toContain('/art/bayla/');
    }
    await expect(page.locator('h1:has-text("Farm TOWELI.")')).toHaveCount(0);
  });

  test('/towelie aliases the toweli slug back to the default skin', async ({ page }) => {
    await seedOverlays(page);
    // Arrive as a Bayla resident, then walk through the alias door.
    // SEED ONCE ONLY: init scripts re-run on every document, and the door
    // works by persist + reload — an unconditional seed would rewrite
    // 'bayla' after the door's write and reload-loop forever. The
    // sessionStorage sentinel survives the reload, so only the first
    // document gets the seed.
    await page.addInitScript(() => {
      try {
        if (!sessionStorage.getItem('__door_test_seeded')) {
          sessionStorage.setItem('__door_test_seeded', '1');
          localStorage.setItem('tegridy-bungalow', 'bayla');
        }
      } catch { /* ignore */ }
    });
    await page.goto('/towelie');
    await expect(page.locator('h1:has-text("Farm TOWELI.")')).toHaveCount(1, { timeout: 20_000 });
    expect(new URL(page.url()).pathname).toBe('/towelie');
    expect(await page.evaluate(() => localStorage.getItem('tegridy-bungalow'))).toBe('toweli');
  });

  test('a door for a not-yet-live bungalow renders home without switching', async ({ page }) => {
    await seedOverlays(page);
    await page.addInitScript(() => {
      try { localStorage.setItem('tegridy-bungalow', 'toweli'); } catch { /* ignore */ }
    });
    await page.goto('/drb');
    await expect(page.locator('h1:has-text("Farm TOWELI.")')).toHaveCount(1, { timeout: 20_000 });
    expect(await page.evaluate(() => localStorage.getItem('tegridy-bungalow'))).toBe('toweli');
  });
});
