import { test, expect, type Page } from '@playwright/test';
import { BUNGALOWS } from '../src/lib/bungalows';
import { gotoRoute } from './fixtures/routes';

// Bungalow doors (memetics.finance/<bungalow>). No wallet fixture: it pins the skin to
// toweli, and these tests are about the door choosing it. A door switches the skin in
// place on its first render. gotoRoute, not goto: a door's busy fallback already shows
// its heading, so "the page has arrived" is no busy node left in main.

async function seedOverlays(page: Page) {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('tegridy-onboarding-seen', '1');
      localStorage.setItem('tegridy-onboarding-bayla-seen', '1');
      localStorage.setItem('tegridy_telemetry_consent', 'denied');
    } catch { /* ignore */ }
  });
}

test.describe('bungalow doors', () => {
  test('/bayla enters her bungalow and keeps the address', async ({ page }) => {
    await seedOverlays(page);
    await gotoRoute(page, '/bayla');
    // The door switches the skin in place; her hero is the proof.
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
    // SEED ONCE ONLY: init scripts run on every document of the tab, so an
    // unconditional seed would overwrite the door's write on any later load.
    // The sessionStorage sentinel keeps the seed to the first document.
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
    await gotoRoute(page, '/drb');
    // The door switches the skin in place, same mechanic as /bayla.
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
    // A BAYLA-skinned visitor following a /pepe link enters PEPE's own skin: Bayla's
    // welcome, her muse persona and Towelie never appear behind his door.
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
    await gotoRoute(page, '/pepe');
    await expect(page.locator('h1').first()).toContainText('PEPE', { timeout: 20_000 });
    await expect(page.locator('text=Welcome to the Bayla bungalow')).toHaveCount(0);
    await expect(page.locator('text=— the muse')).toHaveCount(0); // her persona stays home
    await expect(page.locator('text=Ask me')).toHaveCount(0); // Towelie assistant too
    // The floating muse bubble (byline "the island") is gone from every room; museLine
    // still renders in the hero pill, credited to museBy.
    await expect(page.locator('text=— the island')).toHaveCount(0);
    // PEPE's own voice is still here, and the welcome that used to open itself
    // now waits behind this.
    await expect(page.getByRole('button', { name: 'About this bungalow' })).toBeVisible();
  });

  // WAVE SEVEN, element D: no room is furnished with another resident's token. The
  // sweep is every door in BUNGALOWS, not a sample, and reads the whole rendered text
  // after a scroll to the bottom: half these sections are `whileInView` and do not
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
          // Seeded so the door has nothing to switch.
          // 'nb1' is deliberately not seeded: it is the QUIET slot, `live: false`,
          // and setActiveBungalow's resolver refuses it — seeding it would assert
          // a switch the app is right to refuse.
          if (door !== 'nb1') localStorage.setItem('tegridy-bungalow', door);
          localStorage.setItem(`tegridy-onboarding-${door}-seen`, '1');
        } catch { /* private mode */ }
      }, id);

      await gotoRoute(page, `/${id}`);
      await expect(page.locator('h1').first()).toBeVisible({ timeout: 20_000 });

      const text = await readWholePage(page);
      expect(text.length, `/${id} rendered almost nothing, so this proves nothing`).toBeGreaterThan(400);
      expect(text, `/${id} is furnished with TOWELI`).not.toContain('TOWELI');
      expect(text, `/${id} still renders the shared Protocol Overview grid`).not.toContain('Protocol Overview');

      // WAVE SEVEN, element C: these three venue sections are gated to /toweli
      // (arrival-voice.spec asserts that half).
      for (const section of ['Launch & Verify', 'Ecosystem', 'The Collection']) {
        expect(text, `/${id} still renders the venue's "${section}"`).not.toContain(section);
      }
      // ANSWER EIGHT, ruling 7: the trust strip was ungated inside HomePage,
      // so TOWELI's four protocol claims stood in every other resident's
      // room. They live on the Check overview now.
      for (const label of ['Contracts Verified', 'Timelocked Admin', 'Responsible Disclosure', 'Open Source']) {
        expect(text, `/${id} still renders the trust strip's "${label}"`).not.toContain(label);
      }
    });
  }

  test("/toweli keeps its own furniture, because there it is true", async ({ page }) => {
    test.slow();
    // The other half of element D: the grid left the rooms it does not belong to,
    // and stays in this one.
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
    // ...and the trust strip is gone from the thirteenth door too.
    for (const label of ['Contracts Verified', 'Timelocked Admin', 'Responsible Disclosure', 'Open Source']) {
      expect(text, `/toweli still renders the trust strip's "${label}"`).not.toContain(label);
    }
  });

  test('the quiet slot renders the unmarked landing without switching', async ({ page }) => {
    await seedOverlays(page);
    await page.goto('/nb1');
    await expect(page.locator('h1').first()).toContainText('Unmarked', { timeout: 20_000 });
    expect(await page.evaluate(() => localStorage.getItem('tegridy-bungalow'))).toBeNull();
  });

  test('a crafted ?bungalow= param on a door URL cannot reload-loop the tab', async ({ page }) => {
    await seedOverlays(page);
    // The query outranks storage, so the door strips the param before it
    // decides: one switch happens and the tab settles on the door.
    await gotoRoute(page, '/bayla?bungalow=toweli');
    await expect(page.locator('h1').first()).toContainText('BAYLA', { timeout: 20_000 });
    expect(await page.evaluate(() => localStorage.getItem('tegridy-bungalow'))).toBe('bayla');
    expect(new URL(page.url()).searchParams.has('bungalow')).toBe(false);
  });
});
