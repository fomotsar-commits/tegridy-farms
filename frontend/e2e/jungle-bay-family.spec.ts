import { test, expect, type Page, type Route, type Locator } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expectNoSidewaysScroll } from './fixtures/pageWidth';

// THE SIX JUNGLE BAY FAMILY COLLECTIONS, OPENED IN A REAL BROWSER.
//
// The marketplace lists the six collections memetics.wtf/heat calls the
// island's "family collections". Gold Cards trades here like the three before
// it; four of the other five are browsed here and link out to OpenSea. Junglets
// is not on OpenSea, and every market link is OpenSea (owner ruling,
// 2026-10-02), so its page has no market button and says its stats and items
// are unavailable. This spec opens each one's page, and a trade tab of a
// view-only one by deep link, on the production build.
//
// `vite preview` serves no /api function, so the collections' own answers are
// stubbed at the route level from e2e/fixtures/jungle-bay-family/: OpenSea's
// stats and item list reshaped from each collection's saved OpenSea page. Each
// fixture file names its source in `_provenance`. An /api call nothing here
// stubs falls to the SPA fallback (HTML), which the app must report as unread,
// not as zero.
//
// Across the device matrix this also holds green's phone and iPad concern: no
// page here scrolls sideways, whatever the length of the collection's name.

const FIXTURES = fileURLToPath(new URL('./fixtures/jungle-bay-family/', import.meta.url));
const fixture = (name: string): unknown =>
  (JSON.parse(readFileSync(`${FIXTURES}${name}`, 'utf8')) as { response: unknown }).response;

interface ViewOnly {
  slug: string;
  name: string;
  /** Where its market button goes; null when OpenSea does not list it. */
  marketUrl: string | null;
  /** The gallery's own line: its count, or why nothing is shown. */
  gallery: RegExp;
}

const VIEW_ONLY: ViewOnly[] = [
  {
    slug: 'junglebaymemes',
    name: 'the memes by jungle bay x mfers artists',
    marketUrl: 'https://opensea.io/collection/the-memes-by-junglebay-x-mfers-artists',
    gallery: /Showing 22 items read from OpenSea/,
  },
  {
    slug: 'memeticseeds',
    name: 'Seeds from the Memetic Garden',
    marketUrl: 'https://opensea.io/collection/seeds-from-the-memetic-garden',
    gallery: /Showing 50 items read from OpenSea/,
  },
  {
    slug: 'junglets',
    name: 'Junglets',
    marketUrl: null,
    gallery: /Items unavailable: this venue reads no market for Junglets, so none are shown here\./,
  },
  {
    slug: 'bojungles',
    name: 'Bojungles',
    marketUrl: 'https://opensea.io/collection/bojungless',
    gallery: /Showing 50 items read from OpenSea/,
  },
  {
    slug: 'raretowelie',
    name: 'RARE TOWELIE CARDS',
    marketUrl: 'https://opensea.io/collection/rare-towelie-cards',
    gallery: /Showing 50 items read from OpenSea/,
  },
];

const OPENSEA: Record<string, string> = {
  'collections/the-memes-by-junglebay-x-mfers-artists/stats': 'opensea-stats.the-memes-by-junglebay-x-mfers-artists.json',
  'collection/the-memes-by-junglebay-x-mfers-artists/nfts': 'opensea-nfts.the-memes-by-junglebay-x-mfers-artists.json',
  'collections/seeds-from-the-memetic-garden/stats': 'opensea-stats.seeds-from-the-memetic-garden.json',
  'collection/seeds-from-the-memetic-garden/nfts': 'opensea-nfts.seeds-from-the-memetic-garden.json',
  'collections/bojungless/stats': 'opensea-stats.bojungless.json',
  'collection/bojungless/nfts': 'opensea-nfts.bojungless.json',
  'collections/rare-towelie-cards/stats': 'opensea-stats.rare-towelie-cards.json',
  'collection/rare-towelie-cards/nfts': 'opensea-nfts.rare-towelie-cards.json',
  'collections/junglebaygoldcards/stats': 'opensea-stats.junglebaygoldcards.json',
};

const GOLD = '0x6aa03f42c5366e2664c887eb2e90844ca00b92f3';

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

/** Answer the family collections' reads from their captured responses. */
async function stubFamilyReads(page: Page): Promise<string[]> {
  const asked: string[] = [];
  await page.route((url) => url.pathname === '/api/opensea', async (route) => {
    const path = new URL(route.request().url()).searchParams.get('path') ?? '';
    asked.push(`opensea ${path}`);
    const file = OPENSEA[path];
    return file ? json(route, fixture(file)) : json(route, { error: 'upstream-rejected', status: 404 }, 404);
  });
  await page.route((url) => url.pathname === '/api/aggregator', async (route) => {
    asked.push(`aggregator ${new URL(route.request().url()).searchParams.get('resource') ?? ''}`);
    return route.fallback();
  });
  await page.route((url) => url.pathname === '/api/alchemy', async (route) => {
    const url = new URL(route.request().url());
    asked.push(`alchemy ${url.searchParams.get('endpoint')} ${url.searchParams.get('contractAddress') ?? ''}`);
    // Gold Cards' gallery: the token list read for this change. Nothing else
    // Alchemy would answer was read, so it answers as unavailable.
    if (url.searchParams.get('endpoint') === 'getNFTsForContract'
      && (url.searchParams.get('contractAddress') ?? '').toLowerCase() === GOLD) {
      return json(route, fixture('alchemy-nfts.junglebaygoldcards.json'));
    }
    return json(route, { error: 'Upstream service error' }, 502);
  });
  return asked;
}

async function openCollection(page: Page, path: string): Promise<string[]> {
  await page.addInitScript(() => {
    try {
      // The splash plays once per session; these specs are about what follows it.
      sessionStorage.setItem('tm-splash-seen', '1');
      localStorage.setItem('tradermigos_onboarded', '1');
      localStorage.setItem('tegridy-onboarding-seen', '1');
      localStorage.setItem('tegridy_telemetry_consent', 'denied');
      localStorage.setItem('tegridy-bungalow', 'venue');
    } catch { /* private mode */ }
  });
  const asked = await stubFamilyReads(page);
  await page.goto(path);
  return asked;
}

const marketButton = (page: Page, market: string) =>
  page.getByRole('link', { name: new RegExp(`^Trade on ${market}`) }).first();

// Where a view-only page may link out to: OpenSea and the chain explorers.
const LINK_OUT_HOSTS = ['opensea.io', 'etherscan.io', 'basescan.org', 'explorer.solana.com'];
const linkOutHosts = (page: Page) =>
  page.evaluate(() => [...document.querySelectorAll('a[href]')]
    .map((a) => new URL(a.getAttribute('href') ?? '', location.href))
    .filter((u) => u.origin !== location.origin)
    .map((u) => u.hostname));

test.describe('the Jungle Bay family on the marketplace', () => {
  for (const c of VIEW_ONLY) {
    test(`/nakamigos/${c.slug} opens read-only, ${c.marketUrl ? 'with a button to OpenSea' : 'with no market button'}`, async ({ page }) => {
      const asked = await openCollection(page, `/nakamigos/${c.slug}`);

      await expect(page.getByRole('heading', { level: 1, name: new RegExp(c.name, 'i') })).toBeVisible({ timeout: 20_000 });
      if (c.marketUrl) {
        const button = marketButton(page, 'OpenSea');
        await expect(button).toBeVisible();
        await expect(button).toHaveAttribute('href', c.marketUrl);
        await expect(button).toHaveAttribute('target', '_blank');
        // Dark label on light blue: the page's dark text shadow would smear it.
        await expect(button).toHaveCSS('text-shadow', 'none');
      }

      await expect(page.getByText(c.gallery)).toBeVisible({ timeout: 20_000 });
      // Every link out goes to OpenSea or the chain's explorer, and a collection
      // OpenSea does not list has no market button and asks nothing.
      for (const host of await linkOutHosts(page)) expect(LINK_OUT_HOSTS, `a link goes to ${host}`).toContain(host);
      if (!c.marketUrl) {
        await expect(page.getByRole('link', { name: /^Trade on/ })).toHaveCount(0);
        expect(asked, 'a collection with no market read asks nothing').toEqual([]);
      }
      await expect(page.getByRole('button', { name: 'Shopping cart' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: /Make an offer|Buy this NFT/i })).toHaveCount(0);

      // The Ethereum trading readers never ran for a collection that does not trade here.
      expect(asked.filter((a) => a.startsWith('alchemy'))).toEqual([]);
      await expectNoSidewaysScroll(page);
    });
  }

  test('/nakamigos/junglebaygoldcards opens the trading view', async ({ page }) => {
    await openCollection(page, '/nakamigos/junglebaygoldcards');
    await expect(page.getByText('JUNGLE BAY GOLD CARDS', { exact: true }).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('button', { name: 'Shopping cart' })).toHaveCount(1);
    await expect(page.getByRole('link', { name: /^Trade on OpenSea/ })).toHaveCount(0);
    await expectNoSidewaysScroll(page);
  });

  test('a deep link into a trade tab of a view-only collection says it is not offered, and why', async ({ page }) => {
    await openCollection(page, '/nakamigos/bojungles/trades');
    await expect(page.getByText(/is not offered for Bojungles here\./)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/Bojungles is an ERC-721 collection on Base, and this venue trades Ethereum ERC-721 collections\./)).toBeVisible();
    await expect(marketButton(page, 'OpenSea')).toHaveAttribute('href', 'https://opensea.io/collection/bojungless');
    await expect(page.getByRole('button', { name: /Offer a trade|Accept/i })).toHaveCount(0);
    await expectNoSidewaysScroll(page);
  });

  test('the landing lists all nine, and no card runs past its neighbour', async ({ page }) => {
    await openCollection(page, '/nakamigos');
    await expect(page.getByText(/^9 Collections$/)).toBeVisible({ timeout: 20_000 });
    for (const c of VIEW_ONLY) {
      await expect(page.getByRole('heading', { level: 3, name: c.name, exact: true })).toBeVisible();
    }
    await expectNoSidewaysScroll(page);
  });
});

// THE ITEM PANELS, WHERE A THUMB HAS TO REACH THE CLOSE BUTTON.
//
// On a phone the picture side of an item panel is capped in height. A picture
// taller than the cap used to paint over the panel's own heading and close
// button, so a tap on the X landed on the picture. Each case asks the browser
// which element sits at the centre of the close button and of the title.
// Pictures are answered with a fixed square PNG, so the layout does not depend
// on a CDN.

const SQUARE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

async function stubPictures(page: Page) {
  await page.route((url) => url.hostname !== 'localhost', async (route) => {
    if (route.request().resourceType() !== 'image') return route.fallback();
    return route.fulfill({ status: 200, contentType: 'image/png', body: SQUARE_PNG });
  });
}

/** What a tap at the element's own centre lands on. */
async function atCentre(el: Locator) {
  return el.evaluate((node) => {
    const r = node.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      onTop: !!hit && (hit === node || node.contains(hit)),
      hit: hit ? `${hit.tagName.toLowerCase()}.${String(hit.className)}` : null,
      width: Math.round(r.width),
    };
  });
}

async function expectReachable(el: Locator, what: string) {
  await expect(async () => {
    const r = await atCentre(el);
    expect(r.onTop, `${what}: a tap at its centre lands on ${r.hit}`).toBe(true);
  }).toPass({ timeout: 5_000 });
}

interface PanelCase {
  label: string;
  path: string;
  /** Opens the panel once the page is up; a deep link needs nothing. */
  open?: (page: Page) => Promise<void>;
}

const PANELS: PanelCase[] = [
  { label: 'Bojungles #5', path: '/nakamigos/bojungles/nft/5' },
  { label: 'RARE TOWELIE CARDS #1', path: '/nakamigos/raretowelie/nft/1' },
  // A token held by the burn address: no picture, the "Image unavailable" tile.
  { label: 'Seeds #88', path: '/nakamigos/memeticseeds/nft/88' },
  {
    label: 'the first Bojungles card',
    path: '/nakamigos/bojungles',
    open: async (page) => { await page.locator('.ext-card').first().click({ timeout: 20_000 }); },
  },
];

for (const width of [390, 430]) {
  test.describe(`item panels on a ${width} px phone`, () => {
    test.use({ viewport: { width, height: 844 } });

    for (const c of PANELS) {
      test(`${c.label}: the close button and the title are not under the picture`, async ({ page }) => {
        await stubPictures(page);
        await openCollection(page, c.path);
        if (c.open) await c.open(page);
        const panel = page.locator('.ext-panel');
        await expect(panel).toBeVisible({ timeout: 20_000 });
        await expect(panel.locator('.modal-image-side img, .modal-image-side .ext-image-missing')).toBeVisible();
        await expectReachable(panel.getByRole('button', { name: 'Close' }), 'the close button');
        await expectReachable(panel.locator('.ext-panel-title'), 'the title');
        await expectNoSidewaysScroll(page);
      });
    }

    test('a Gold Card in the trading modal: the close button and the title are not under the picture', async ({ page }) => {
      await stubPictures(page);
      await openCollection(page, '/nakamigos/junglebaygoldcards/nft/1');
      const dialog = page.getByRole('dialog', { name: /NFT Detail/ });
      await expect(dialog).toBeVisible({ timeout: 20_000 });
      await expectReachable(dialog.getByRole('button', { name: 'Close modal' }), 'the close button');
      await expectReachable(dialog.locator('.modal-details h2').first(), 'the title');
      await expectNoSidewaysScroll(page);
    });
  });
}

test.describe('the item panel on a tablet', () => {
  test.use({ viewport: { width: 1024, height: 768 } });

  test('a long item name does not squeeze the close button below its tap size', async ({ page }) => {
    await stubPictures(page);
    await openCollection(page, '/nakamigos/raretowelie/nft/1');
    const panel = page.locator('.ext-panel');
    await expect(panel.locator('.ext-panel-title')).toHaveText(/CHAMPS NEVER FORGET TO BRING A TOWEL/, { timeout: 20_000 });
    const close = panel.getByRole('button', { name: 'Close' });
    // The panel scales in from 0.92 (modalEnter), so the width is read once
    // the entrance has settled; a squeezed button never reaches 36.
    await expect(async () => {
      const { width } = await atCentre(close);
      expect(width, 'close button width').toBeGreaterThanOrEqual(36);
    }).toPass({ timeout: 5_000 });
    await expectReachable(close, 'the close button');
  });
});

// THE TRADING VIEW'S CORNER BUTTONS.
//
// Gold Cards opens the full trading view, and with it the fixed buttons in
// the bottom-left corner: Mute sounds and Keys, and Back to top once the page
// is scrolled. Above the phone layout all three are on screen together, and
// Back to top used to sit on top of the other two. Each case scrolls the
// gallery, then asks the browser what a tap at each button's centre lands on.

const overlaps = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

// The trading view jumps to the top once when it opens, in the effect that
// also sets the tab's title, and that effect runs after the header is already
// on screen: a scroll made before it is undone. The title says it has run.
// The first card says the page is its full height: with only the skeleton up,
// the 1440 by 900 case can scroll 603 px in Chromium, and Back to top needs
// more than 600.
async function expectOpenedAtTheTopAndFilled(page: Page) {
  await expect(page).toHaveTitle('Jungle Bay Gold Cards | Tradermigos', { timeout: 20_000 });
  await expect(page.locator('.nft-card').first()).toBeVisible({ timeout: 20_000 });
}

for (const viewport of [{ width: 820, height: 1180 }, { width: 1440, height: 900 }]) {
  test.describe(`the corner buttons at ${viewport.width} px`, () => {
    test.use({ viewport });

    test('Back to top sits clear of Mute sounds and Keys once the page is scrolled', async ({ page }) => {
      await openCollection(page, '/nakamigos/junglebaygoldcards');
      await expect(page.getByText('JUNGLE BAY GOLD CARDS', { exact: true }).first()).toBeVisible({ timeout: 20_000 });
      await expectOpenedAtTheTopAndFilled(page);
      await page.evaluate(() => window.scrollTo(0, 1600));
      const top = page.getByRole('button', { name: 'Back to top' });
      await expect(top).toHaveClass(/visible/, { timeout: 10_000 });
      const mute = page.getByRole('button', { name: /^(Mute|Unmute) sounds$/ });
      const keys = page.getByRole('button', { name: 'Keyboard shortcuts' });
      await expect(mute).toBeVisible();
      await expect(keys).toBeVisible();

      await expectReachable(top, 'Back to top');
      await expectReachable(mute, 'Mute sounds');
      await expectReachable(keys, 'Keys');
      const [t, m, k] = await Promise.all([top.boundingBox(), mute.boundingBox(), keys.boundingBox()]);
      expect(t && m && overlaps(t, m), `Back to top ${JSON.stringify(t)} overlaps Mute sounds ${JSON.stringify(m)}`).toBe(false);
      expect(t && k && overlaps(t, k), `Back to top ${JSON.stringify(t)} overlaps Keys ${JSON.stringify(k)}`).toBe(false);
    });
  });
}

// THE CART DRAWER ON A PHONE.
//
// On a phone the bottom nav is fixed over the foot of the screen, and the
// open cart drawer ran under it: the last button, Clear cart, was behind the
// nav. The cart is seeded with one Gold Card listing so the drawer shows its
// full footer.

test.describe('the cart on a 390 px phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('an open cart keeps its footer buttons above the bottom nav', async ({ page }) => {
    await page.addInitScript((item) => {
      try { localStorage.setItem('junglebaygoldcards_cart', JSON.stringify([item])); } catch { /* private mode */ }
    }, {
      id: '6',
      tokenId: '6',
      name: 'JungleBay Gold Card #6',
      image: null,
      price: 0.25,
      orderHash: `0x${'ab'.repeat(32)}`,
      protocolAddress: '0x0000000000000068f116a894984e2db1123eb395',
      contract: GOLD,
    });
    await openCollection(page, '/nakamigos/junglebaygoldcards');
    await page.getByRole('button', { name: 'Shopping cart' }).click({ timeout: 20_000 });
    const drawer = page.getByRole('dialog', { name: 'Shopping cart' });
    await expect(drawer).toBeVisible();
    const clear = drawer.getByRole('button', { name: /CLEAR CART/ });
    await expect(clear).toBeVisible();
    await expectReachable(drawer.getByRole('button', { name: /CONNECT WALLET/ }), 'Connect wallet');
    await expectReachable(clear, 'Clear cart');
  });
});
