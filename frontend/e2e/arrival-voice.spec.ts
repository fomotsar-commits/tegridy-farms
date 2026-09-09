import { test, expect, type Page } from '@playwright/test';
import { FAQ_INTRO } from '../src/lib/copy';

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

// --- WAVE SEVEN, element C: the home, cut to the line ----------------------
//
// The venue arrival is hero, hall, three paths, board, footer. Everything else
// it used to carry is furniture that belongs to a room: /toweli renders it all,
// whole, and /launch /scan /gallery are their own doors. Nothing is deleted --
// which is why the second test here is not optional. A gate that cuts three
// sections and a deletion that removes them look identical from the front door,
// and only one of them is what the island ruled.

const CUT_FROM_THE_VENUE = ['Launch & Verify', 'Ecosystem', 'The Collection'];

// THE FAQ TEASER IS THE FIFTH GATE, AND IT NEEDS ITS OWN PAIR OF STRINGS.
//
// The other four are cut and restored under one name each, so a single list
// serves both sides. This one is not: the teaser spoke venue copy on the
// arrival and FAQ_INTRO's copy inside /toweli, and only the venue half is
// leaving. Putting "Questions about the venue" in the list above would assert
// /toweli contains a sentence it has never rendered, and the /toweli test would
// red for the wrong reason -- which would look exactly like a broken gate.
//
// The two differ by ONE WORD ("venue" vs "farm"), so a looser match would pass
// on either. Both are pinned exactly, and the /toweli side reads FAQ_INTRO
// itself so the assertion cannot drift from the copy it is about.
const FAQ_TEASER_ON_THE_VENUE = 'Questions about the venue';

/** The whole rendered page, after the whileInView sections have mounted. */
async function readWholePage(page: Page): Promise<string> {
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(700);
  }
  return page.evaluate(() => document.body.innerText);
}

test.describe('the home, cut to the line', () => {
  test('the venue arrival carries the line and nothing after it', async ({ page }) => {
    test.slow();
    await seedOverlays(page);
    await page.addInitScript(() => {
      try { localStorage.setItem('tegridy-bungalow', 'venue'); } catch { /* ignore */ }
    });
    await page.goto('/');
    await expect(page.locator('h1')).toContainText('MEMETICS.FINANCE', { timeout: 20_000 });

    const text = await readWholePage(page);
    expect(text.length, 'the venue arrival rendered almost nothing').toBeGreaterThan(400);

    // THE LINE ITSELF, first -- otherwise this is a test that a page is empty.
    expect(text, 'the hall is missing from the venue arrival').toContain('Jungle Bay');
    expect(text, 'the footer is missing').toContain('memetics.finance');

    for (const section of CUT_FROM_THE_VENUE) {
      expect(text, `"${section}" is still on the venue arrival`).not.toContain(section);
    }
    // THE LOAD-BEARING ONE IS FAQ_INTRO, NOT THE RETIRED VENUE LINE.
    //
    // The island's break-the-fix was "widen the gate and watch the venue
    // assertion go red". Widened, it stayed GREEN -- because the venue-voice
    // copy left with the gate, so "Questions about the venue" is now a string
    // that exists nowhere in the repo and an assertion about it cannot fail.
    // That is the vacuous-guard class this wave keeps catching, in a guard
    // written to prove a fix for it.
    //
    // So the teaser is identified by what it ACTUALLY renders. Widen the gate
    // now and this line reds.
    expect(text, 'the FAQ teaser is still on the venue arrival').not.toContain(FAQ_INTRO.headline);

    // Kept as well, and deliberately not as the only one: it pins that the
    // retired venue copy never comes back, which is a different claim from the
    // teaser being gated and is worth its own line even though it cannot fail
    // today.
    expect(text, 'the retired venue-voice FAQ copy is back').not.toContain(FAQ_TEASER_ON_THE_VENUE);

    // AND THE FAQ IS STILL REACHABLE, which is the difference between gating
    // the teaser and hiding the answers. The teaser was a second door to a page
    // the footer already opens; cutting it without this assertion would let a
    // later change take the footer link too and stay green.
    await expect(
      page.locator('a[href="/faq"]').first(),
      'the arrival cut the FAQ teaser AND lost its footer link to /faq',
    ).toBeAttached();
  });

  test('and /toweli still renders every one of them', async ({ page }) => {
    test.slow();
    // The half that makes the cut a GATE rather than a deletion.
    await seedOverlays(page);
    await page.goto('/toweli');
    await expect(page.locator('h1:has-text("Farm TOWELI.")')).toHaveCount(1, { timeout: 20_000 });

    const text = await readWholePage(page);
    for (const section of CUT_FROM_THE_VENUE) {
      expect(text, `"${section}" was DELETED, not gated`).toContain(section);
    }
    // The teaser under its own headline, which is where it went rather than
    // where it stopped existing.
    expect(text, 'the FAQ teaser was DELETED, not gated').toContain(FAQ_INTRO.headline);
  });
});
