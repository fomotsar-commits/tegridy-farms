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

  test('a settled door enters its PLACEHOLDER SKIN — its own voice, classic walls', async ({ page }) => {
    // Owner call 2026-08-30: every settled resident is live with an honest
    // registry identity and NO art pool — the venue speaks the token while
    // pageArt's classic fallback holds the walls until the community's drop.
    await seedOverlays(page);
    await page.addInitScript(() => {
      try {
        localStorage.setItem('tegridy-bungalow', 'toweli');
        localStorage.setItem('tegridy-onboarding-drb-seen', '1');
      } catch { /* ignore */ }
    });
    await page.goto('/drb');
    // Door persists + reloads in place, same mechanic as /bayla.
    await expect(page.locator('h1').first()).toContainText('DRB', { timeout: 20_000 });
    await expect(page.locator('h1:has-text("Farm TOWELI.")')).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('tegridy-bungalow'))).toBe('drb');
    // Classic art holds the walls — nothing borrows another resident's pool.
    const srcs = await page.$$eval('img[data-art-surface]', (imgs) =>
      imgs.map((i) => i.getAttribute('src') ?? ''));
    for (const src of srcs) expect(src, 'placeholder skin wears CLASSIC art only').not.toContain('/art/bayla/');
    // The live market rides the in-skin home now (registry market entry).
    await expect(page.locator('section[aria-label="DRB market"]')).toHaveCount(1, { timeout: 20_000 });
    expect(await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )).toBeLessThanOrEqual(0);
  });

  test("no other resident's voice behind a settled door", async ({ page }) => {
    // Caught live 2026-08-30 (pre-flip, as a landing bug): a BAYLA-skinned
    // visitor following a /pepe link met HER welcome modal on PEPE's page.
    // Post-flip the door ENTERS PEPE's own skin — so the pin becomes: the
    // voice behind the door is PEPE's (byline "the island"), and Bayla's
    // welcome, her muse persona, and Towelie never appear.
    await seedOverlays(page);
    await page.addInitScript(() => {
      try {
        if (!sessionStorage.getItem('__door_test_seeded')) {
          sessionStorage.setItem('__door_test_seeded', '1');
          localStorage.setItem('tegridy-bungalow', 'bayla');
          localStorage.removeItem('tegridy-onboarding-bayla-seen');
          localStorage.setItem('tegridy-onboarding-pepe-seen', '1');
        }
      } catch { /* ignore */ }
    });
    await page.goto('/pepe');
    await expect(page.locator('h1').first()).toContainText('PEPE', { timeout: 20_000 });
    await expect(page.locator('text=Welcome to the Bayla bungalow')).toHaveCount(0);
    await expect(page.locator('text=— the muse')).toHaveCount(0); // her persona stays home
    await expect(page.locator('text=Ask me')).toHaveCount(0); // Towelie assistant too
    // PEPE's own quiet line is welcome here.
    await expect(page.locator('text=— the island')).toHaveCount(1);
  });

  test('the quiet slot renders the unmarked landing without switching', async ({ page }) => {
    await seedOverlays(page);
    await page.goto('/nb1');
    await expect(page.locator('h1').first()).toContainText('Unmarked', { timeout: 20_000 });
    expect(await page.evaluate(() => localStorage.getItem('tegridy-bungalow'))).toBeNull();
  });

  test('a crafted ?bungalow= param on a door URL cannot reload-loop the tab', async ({ page }) => {
    await seedOverlays(page);
    // Pre-fix: the param re-persisted 'toweli' on every read while the door
    // persisted 'bayla' and reloaded — ping-pong forever. The door now strips
    // the param before deciding, so ONE switch happens and then it settles.
    await page.goto('/bayla?bungalow=toweli');
    await expect(page.locator('h1').first()).toContainText('BAYLA', { timeout: 20_000 });
    expect(await page.evaluate(() => localStorage.getItem('tegridy-bungalow'))).toBe('bayla');
    expect(new URL(page.url()).searchParams.has('bungalow')).toBe(false);
  });
});
