import { test, expect, type Page } from '@playwright/test';
import { BUNGALOWS } from '../src/lib/bungalows';

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
    // WAVE SEVEN, element E: "— the island" was the FLOATING MUSE BUBBLE's
    // byline (museVoice), and that bubble is gone from every room — it opened
    // over the page unasked, which is the class this element removes. The
    // room's own quiet line is not lost with it: museLine still renders in the
    // hero pill, credited to museBy rather than the bubble's persona.
    await expect(page.locator('text=— the island')).toHaveCount(0);
    // PEPE's own voice is still here, and the welcome that used to open itself
    // now waits behind this.
    await expect(page.getByRole('button', { name: 'About this bungalow' })).toBeVisible();
  });

  // WAVE SEVEN, element D — THE SWEEP IS THE THIRTEEN DOORS, NOT A SAMPLE.
  //
  // The "Protocol Overview" grid rendered in EVERY bungalow, so BAYLA's room and
  // PEPE's room both told their visitors to "Stake TOWELI to earn now" — another
  // resident's token, in someone else's house. Wave five cleaned the venue
  // arrival of it and missed the rooms entirely.
  //
  // This used to prove one room and two strings while the status block claimed
  // thirteen doors. A claim about thirteen doors is measured on thirteen doors:
  // the island measured them, and so does the file. The list is read from
  // BUNGALOWS rather than typed here, so a fourteenth door cannot be added
  // without this sweep noticing it.
  //
  // Asserted on the WHOLE RENDERED TEXT after a scroll to the bottom, not on the
  // gate expression: a source check passes on any gate that merely mentions the
  // right identifiers, and half these sections are `whileInView` and do not
  // exist in the DOM until they are scrolled to.
  async function readWholePage(page: Page): Promise<string> {
    // Three passes down. One scrollTo lands before the sections it reveals have
    // mounted, and each newly mounted section makes the page taller.
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(700);
    }
    return page.evaluate(() => document.body.innerText);
  }

  const DOORS = BUNGALOWS.map((b) => b.id);

  test('there are thirteen doors, and this file knows all of them', () => {
    // The sweep below is generated from this list. If a door is added and this
    // number is not deliberately changed with it, the new room is swept anyway —
    // this exists so the COUNT in the status block cannot drift from the code.
    expect(DOORS).toHaveLength(13);
    expect(DOORS).toContain('toweli');
  });

  for (const id of DOORS.filter((d) => d !== 'toweli')) {
    test(`/${id} speaks only its own token — no TOWELI anywhere on the page`, async ({ page }) => {
      test.slow();
      await seedOverlays(page);
      await page.addInitScript((door) => {
        try {
          // Seeded so the door's own persist-and-reload does not double the load.
          // 'nb1' is deliberately not seeded: it is the QUIET slot, `live: false`,
          // and setActiveBungalow's resolver refuses it — seeding it would assert
          // a switch the app is right to refuse.
          if (door !== 'nb1') localStorage.setItem('tegridy-bungalow', door);
          localStorage.setItem(`tegridy-onboarding-${door}-seen`, '1');
        } catch { /* private mode */ }
      }, id);

      await page.goto(`/${id}`);
      await expect(page.locator('h1').first()).toBeVisible({ timeout: 20_000 });

      const text = await readWholePage(page);
      expect(text.length, `/${id} rendered almost nothing, so this proves nothing`).toBeGreaterThan(400);
      expect(text, `/${id} is furnished with TOWELI`).not.toContain('TOWELI');
      expect(text, `/${id} still renders the shared Protocol Overview grid`).not.toContain('Protocol Overview');

      // WAVE SEVEN, element C, measured from the room's side. The island found
      // these three still rendering below the market card on /bayla and /pepe:
      // a resident's visitor reading "Launch on Ethereum" and "Check a
      // deployer" underneath someone else's token, then the venue's gallery.
      // They are gated to /toweli now, and the other half of that gate --
      // /toweli still rendering all three -- is asserted in arrival-voice.spec.
      for (const section of ['Launch & Verify', 'Ecosystem', 'The Collection']) {
        expect(text, `/${id} still renders the venue's "${section}"`).not.toContain(section);
      }
    });
  }

  test("/toweli keeps its own furniture, because there it is true", async ({ page }) => {
    test.slow();
    // The other half of the ruling, and the one that makes the twelve above mean
    // something: element D removes a grid from rooms it does not belong to. If it
    // had simply been deleted, all twelve would be green and the venue would be
    // poorer for it.
    await seedOverlays(page);
    await page.addInitScript(() => {
      try {
        localStorage.setItem('tegridy-bungalow', 'toweli');
        localStorage.setItem('tegridy-onboarding-toweli-seen', '1');
      } catch { /* private mode */ }
    });
    await page.goto('/toweli');
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 20_000 });

    const text = await readWholePage(page);
    expect(text).toContain('Protocol Overview');
    expect(text).toContain('TOWELI');
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
