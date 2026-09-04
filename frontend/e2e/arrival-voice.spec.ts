import { test, expect, type Page } from '@playwright/test';

// ARRIVAL IDENTITY 2026-08-27 — the containment contract, walked end to end.
//
// lib/arrival.test.ts pins the RESOLVER (which voice a given URL + storage
// resolves to). This file pins what a visitor actually SEES, which is the
// claim the wave is really making and the one no unit test can prove: the
// front door speaks as MEMETICS.FINANCE, and the whole classic TOWELI
// experience is still there, whole, behind /toweli.
//
// UPDATED 2026-08-31 (owner call, commit 17fe6fcc): the classic identity was
// RETIRED, not relocated. The room behind /toweli keeps its hero, its art and
// Towelie as a character — but the brand word is gone from every rendered
// surface, that room included. The assertions below pin exactly that.
//
// Deliberately fixture-free, exactly like bungalow-doors.spec.ts: the wallet
// fixture pins `tegridy-bungalow` to toweli, which would silently put every
// assertion here in the Tegridy voice and make the venue half vacuous.
//
// Why this is worth an e2e at all: the voice resolves at MODULE SCOPE in six
// separate files (loader words, glitch flashes, nav + footer wordmarks, home
// hero, onboarding). A regression in any one of them is a branding leak on
// the front door that typechecks, unit-tests green, and only shows up in a
// browser.

async function seedOverlays(page: Page) {
  await page.addInitScript(() => {
    try {
      sessionStorage.setItem('tf_loaded', '1');
      localStorage.setItem('tegridy-onboarding-seen', '1');
      localStorage.setItem('tegridy_telemetry_consent', 'denied');
    } catch { /* ignore */ }
  });
}

test.describe('arrival voice', () => {
  test('the default arrival speaks as the venue, with no Tegridy on the front door', async ({ page }) => {
    await seedOverlays(page);
    // The sentinel the picker writes when a visitor dismisses it without
    // walking a door: "seen, chose nothing" — i.e. the venue's own voice.
    // Seeded so the picker does not sit over the hero being asserted.
    await page.addInitScript(() => {
      try { localStorage.setItem('tegridy-bungalow', 'venue'); } catch { /* ignore */ }
    });
    await page.goto('/');

    await expect(page).toHaveTitle(/MEMETICS/i, { timeout: 20_000 });
    await expect(page.locator('h1')).toContainText('MEMETICS.FINANCE');
    await expect(page.locator('h1')).toContainText('Held time counts here.');
    // The classic cluster is relocated, not deleted — it must not be here.
    await expect(page.locator('h1:has-text("Farm TOWELI.")')).toHaveCount(0);
    // Wordmarks follow the voice: nav and footer both speak the venue.
    await expect(page.locator('header, nav').getByText('MEMETICS').first()).toBeVisible();
    await expect(page.getByText('© 2026 memetics.finance')).toBeVisible();
    // Towelie does not float at the venue; he lives in his own bungalow.
    await expect(page.locator('text=Ask me')).toHaveCount(0);
  });

  test('/toweli still holds the whole classic TOWELI experience', async ({ page }) => {
    await seedOverlays(page);
    await page.goto('/toweli');

    // The door persists + reloads in place; the classic hero is the proof.
    await expect(page.locator('h1:has-text("Farm TOWELI.")')).toHaveCount(1, { timeout: 20_000 });
    expect(new URL(page.url()).pathname).toBe('/toweli');
    expect(await page.evaluate(() => localStorage.getItem('tegridy-bungalow'))).toBe('toweli');
    // The venue hero is the thing that got replaced here.
    await expect(page.locator('h1:has-text("Held time counts here.")')).toHaveCount(0);

    // OWNER CALL 2026-08-31 (commit 17fe6fcc): this assertion used to require
    // "© 2026 Tegridy Farms" here, because the wave doc RELOCATED the classic
    // identity behind /toweli. The owner retired the name instead — "the toweli
    // room first (wordmark, footer, ...)" — which reverses §0 of that doc. So
    // the room is now proved by what it actually keeps (the TOWELI hero, above)
    // and the brand word must be gone even in here. Towelie survives as a
    // CHARACTER; only the brand word went.
    await expect(page.getByText('© 2026 memetics.finance')).toBeVisible();
    await expect(page.getByText('Tegridy Farms')).toHaveCount(0);
  });
});
