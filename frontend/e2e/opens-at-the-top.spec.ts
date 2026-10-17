import { test, expect, type Page, type Route } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// A PAGE IS AT THE TOP BEFORE IT IS ON SCREEN.
// Each case watches for the moment a view's DOM lands, scrolls the window in
// that same moment when the page is tall enough, and requires that the window
// was at the top when the view landed, that nothing jumped to the top after
// it, and that the window stayed put. The collections' answers come from
// e2e/fixtures/jungle-bay-family, as in jungle-bay-family.spec.ts.

const FIXTURES = fileURLToPath(new URL('./fixtures/jungle-bay-family/', import.meta.url));
const fixture = (name: string): unknown =>
  (JSON.parse(readFileSync(`${FIXTURES}${name}`, 'utf8')) as { response: unknown }).response;

const OPENSEA: Record<string, string> = {
  'collections/rare-towelie-cards/stats': 'opensea-stats.rare-towelie-cards.json',
  'collection/rare-towelie-cards/nfts': 'opensea-nfts.rare-towelie-cards.json',
  'collections/junglebaygoldcards/stats': 'opensea-stats.junglebaygoldcards.json',
};
const GOLD = '0x6aa03f42c5366e2664c887eb2e90844ca00b92f3';
const NUDGE = 250;

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

/** Where to look for the view: an element that arrives, or one that leaves. */
interface Landing { appears?: string; leaves?: string }

interface Opened {
  landed: boolean;
  /** window.scrollY when the view landed, before the window was moved. */
  yAtLanding: number | null;
  /** How far the page could be scrolled in that moment. */
  room: number | null;
  /** It could be scrolled far enough, and was. */
  nudged: boolean;
  /** Where the window was at each jump to the top made after the view landed. */
  lateJumps: number[];
}

type Watched = Window & { __opened: Opened & { arm: (landing: Landing) => void } };

async function prepare(page: Page, landing?: Landing) {
  await page.addInitScript(({ landing, nudge }) => {
    try {
      // The splash plays once per session; these specs are about what follows it.
      sessionStorage.setItem('tm-splash-seen', '1');
      localStorage.setItem('tradermigos_onboarded', '1');
      localStorage.setItem('tegridy-onboarding-seen', '1');
      localStorage.setItem('tegridy_telemetry_consent', 'denied');
      localStorage.setItem('tegridy-bungalow', 'venue');
    } catch { /* private mode */ }

    let waitingFor: Landing | null = null;
    const opened: Watched['__opened'] = {
      landed: false,
      yAtLanding: null,
      room: null,
      nudged: false,
      lateJumps: [],
      arm(next) {
        opened.landed = false;
        opened.yAtLanding = null;
        opened.room = null;
        opened.nudged = false;
        opened.lateJumps = [];
        waitingFor = next;
      },
    };
    (window as unknown as Watched).__opened = opened;

    const realScrollTo = window.scrollTo.bind(window) as (...args: unknown[]) => void;
    window.scrollTo = ((...args: unknown[]) => {
      const first = args[0];
      const top = typeof first === 'object' && first !== null ? (first as ScrollToOptions).top : args[1];
      if (top === 0 && opened.landed) opened.lateJumps.push(Math.round(window.scrollY));
      return realScrollTo(...args);
    }) as typeof window.scrollTo;

    // Mutation records are delivered once the script that changed the DOM has
    // finished, so this runs after the commit that mounted the view and before
    // any later task.
    new MutationObserver(() => {
      if (!waitingFor) return;
      const here = waitingFor.appears
        ? document.querySelector(waitingFor.appears) !== null
        : document.querySelector(waitingFor.leaves ?? '') === null;
      if (!here) return;
      waitingFor = null;
      opened.landed = true;
      opened.yAtLanding = Math.round(window.scrollY);
      opened.room = document.documentElement.scrollHeight - document.documentElement.clientHeight;
      if (opened.room >= nudge) {
        realScrollTo(0, nudge);
        opened.nudged = window.scrollY > 0;
      }
    }).observe(document, { childList: true, subtree: true });

    if (landing) opened.arm(landing);
  }, { landing: landing ?? null, nudge: NUDGE });

  await page.route((url) => url.pathname === '/api/opensea', async (route) => {
    const file = OPENSEA[new URL(route.request().url()).searchParams.get('path') ?? ''];
    return file ? json(route, fixture(file)) : json(route, { error: 'upstream-rejected', status: 404 }, 404);
  });
  await page.route((url) => url.pathname === '/api/alchemy', async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('endpoint') === 'getNFTsForContract'
      && (url.searchParams.get('contractAddress') ?? '').toLowerCase() === GOLD) {
      return json(route, fixture('alchemy-nfts.junglebaygoldcards.json'));
    }
    return json(route, { error: 'Upstream service error' }, 502);
  });
}

const arm = (page: Page, landing: Landing) =>
  page.evaluate((l) => (window as unknown as Watched).__opened.arm(l), landing);

/** The page left behind was scrolled, so "at the top" is not where the window already was. */
async function expectScrolled(page: Page) {
  expect(await page.evaluate(() => Math.round(window.scrollY)), 'the page being left is scrolled').toBeGreaterThan(0);
}

// Call once the page has settled: its own effects have run by then. mustScroll
// is for a view that is taller than the screen the moment it lands. The
// view-only page is not, on a wide screen, until its gallery answers.
async function expectOpenedAtTheTop(page: Page, { mustScroll }: { mustScroll: boolean }) {
  const { opened, y } = await page.evaluate(() => {
    const { landed, yAtLanding, room, nudged, lateJumps } = (window as unknown as Watched).__opened;
    return { opened: { landed, yAtLanding, room, nudged, lateJumps }, y: Math.round(window.scrollY) };
  });
  expect(opened.landed, 'the view was seen landing').toBe(true);
  expect(opened.yAtLanding, 'where the window was when the view landed').toBe(0);
  expect(opened.lateJumps, 'jumps to the top after the view landed, and where the window was').toEqual([]);
  if (mustScroll) expect(opened.nudged, `the page could be scrolled ${opened.room} px when the view landed, and ${NUDGE} are needed`).toBe(true);
  if (opened.nudged) expect(y, 'the window is still where it was put').toBeGreaterThan(0);
}

const tradingViewSettled = async (page: Page) => {
  await expect(page).toHaveTitle('Jungle Bay Gold Cards | Tradermigos', { timeout: 20_000 });
  await expect(page.locator('.nft-card').first()).toBeVisible({ timeout: 20_000 });
};

const viewOnlySettled = async (page: Page) => {
  await expect(page).toHaveTitle('RARE TOWELIE CARDS | Tradermigos', { timeout: 20_000 });
  await expect(page.getByText(/Showing 50 items read from OpenSea/)).toBeVisible({ timeout: 20_000 });
};

const landingSettled = async (page: Page) => {
  await expect(page).toHaveTitle('Tradermigos | NFT Collections', { timeout: 20_000 });
  await expect(page.getByText(/^9 Collections$/)).toBeVisible({ timeout: 20_000 });
};

test.describe('a page opened by its address', () => {
  test('the trading view of a collection', async ({ page }) => {
    await prepare(page, { appears: '.back-to-top' });
    await page.goto('/nakamigos/junglebaygoldcards');
    await tradingViewSettled(page);
    await expectOpenedAtTheTop(page, { mustScroll: true });
  });

  test('the view-only page of a collection', async ({ page }) => {
    await prepare(page, { appears: '.ext-view h1' });
    await page.goto('/nakamigos/raretowelie');
    await viewOnlySettled(page);
    await expectOpenedAtTheTop(page, { mustScroll: false });
  });

  test('the marketplace landing', async ({ page }) => {
    await prepare(page, { appears: '.nakamigos-app main' });
    await page.goto('/nakamigos');
    await landingSettled(page);
    await expectOpenedAtTheTop(page, { mustScroll: false });
  });
});

test.describe('a page reached from another page', () => {
  test('the landing, scrolled, to the trading view of a collection', async ({ page }) => {
    await prepare(page);
    await page.goto('/nakamigos');
    await landingSettled(page);
    const card = page.getByRole('button', { name: /Jungle Bay Gold Cards/ }).first();
    await card.scrollIntoViewIfNeeded();
    await expectScrolled(page);
    await arm(page, { appears: '.back-to-top' });
    await card.click();
    await tradingViewSettled(page);
    await expectOpenedAtTheTop(page, { mustScroll: true });
  });

  test('the landing, scrolled, to the view-only page of a collection', async ({ page }) => {
    await prepare(page);
    await page.goto('/nakamigos');
    await landingSettled(page);
    // The last card on the landing, below the first screen at every width.
    const card = page.getByRole('button', { name: /RARE TOWELIE CARDS/ }).first();
    await card.scrollIntoViewIfNeeded();
    await expectScrolled(page);
    await arm(page, { appears: '.ext-view h1' });
    await card.click();
    await viewOnlySettled(page);
    await expectOpenedAtTheTop(page, { mustScroll: false });
  });

  test('one page of the venue, scrolled, to another, and Back', async ({ page }) => {
    await prepare(page);
    await page.goto('/earn/bayla');
    const pool = page.getByRole('heading', { level: 1, name: 'Stake BAYLA.' });
    await expect(pool).toBeVisible({ timeout: 30_000 });
    await page.evaluate(() => window.scrollTo(0, 600));
    await expectScrolled(page);
    await pool.evaluate((h1) => h1.setAttribute('data-leaving', ''));
    await arm(page, { leaves: '[data-leaving]' });
    // Not the bar's Lock: inside a room it opens that room's own pool (owner, 2026-10-15),
    // which is this page. The pool's own way out to every pool is Back to Earn.
    await page.getByRole('link', { name: /Back to Earn/ }).first().click();
    await expect(page.getByRole('heading', { level: 1, name: 'Earn' })).toBeVisible({ timeout: 30_000 });
    // A page sets its title in an effect of the commit that mounted it, so the
    // title says that commit's effects have run.
    await expect(page).toHaveTitle('Earn | MEMETICS.FINANCE', { timeout: 30_000 });
    await expectOpenedAtTheTop(page, { mustScroll: false });

    // Back is the browser's to place: the venue makes no jump of its own.
    await page.goBack();
    await expect(pool).toBeVisible({ timeout: 30_000 });
    await expect(page).toHaveTitle('Farm: BAYLA | MEMETICS.FINANCE', { timeout: 30_000 });
    const jumpsOnBack = await page.evaluate(() => (window as unknown as Watched).__opened.lateJumps);
    expect(jumpsOnBack, 'jumps to the top made on Back').toEqual([]);
  });
});
