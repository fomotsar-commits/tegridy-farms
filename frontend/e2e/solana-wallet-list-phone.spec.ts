import { test, expect, type Locator, type Page } from '@playwright/test';
import { installConnectOnlySolanaWallet } from './fixtures/solanaConnectOnlyWallet';

// THE SOLANA WALLET LIST ON A PHONE. Phone walks of production on 2026-10-03
// found three things: on Android Chrome the Phantom row opened Phantom's
// website; inside a wallet app's own browser that wallet was listed twice; and
// at 320x568 the list's closing note was off screen, under a 38px close button.
//
// MUTATION CHECK: with src/styles/wallet-adapter-ui.css as it was, both "fits
// on the screen" tests fail. With src/lib/solanaWallets.ts as it was, the
// Android rows and the Phantom tap fail; with src/lib/solanaWalletOrder.ts as
// it was, the Android rows and the in-wallet test fail.

test.use({ serviceWorkers: 'block' });

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36';
/** The wallets this venue offers by name, in order (src/lib/solanaWalletOrder.ts). */
const OFFERED = ['Phantom', 'Trust Wallet', 'Jupiter', 'MetaMask', 'Coinbase Wallet', 'Solflare', 'Backpack'];
const FLOOR = 44;
// A Solana pool page. Its wallet section is on the page from the first render;
// /solana-lp, where the walks were done, shows its own only after a chain read.
const ROUTE = '/earn/bayla';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('tegridy-onboarding-seen', '1');
      localStorage.setItem('tegridy_telemetry_consent', 'denied');
    } catch { /* private mode */ }
  });
});

async function openList(page: Page): Promise<Locator> {
  await page.goto(ROUTE);
  const connect = page.getByRole('banner').getByRole('button', { name: 'Connect a Solana wallet' });
  await expect(connect).toBeVisible({ timeout: 30_000 });
  await connect.click();
  const list = page.getByRole('dialog', { name: /on Solana to continue/ });
  await expect(list).toBeVisible({ timeout: 30_000 });
  return list;
}

const rows = (list: Locator) => list.getByRole('listitem').allTextContents();

/** The whole list is on the screen it opened on, and its close button is a real touch target. */
async function expectFitsOnScreen(page: Page, list: Locator, screen: { width: number; height: number }) {
  // The size the case names is the size the page got (a project may not give it).
  expect(await page.evaluate(() => [window.innerWidth, window.innerHeight])).toEqual([screen.width, screen.height]);

  const note = list.getByText(/Only wallets that work on Solana are listed/);
  await expect(note).toBeVisible();
  const scroller = await list.evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight }));
  expect(scroller.scroll, 'the list needs no scrolling to be read to its end').toBeLessThanOrEqual(scroller.client);
  const noteBox = (await note.boundingBox())!;
  expect(noteBox.y + noteBox.height, 'the closing note ends on the screen').toBeLessThanOrEqual(screen.height);

  const close = list.getByRole('button', { name: 'Close' });
  const closeBox = (await close.boundingBox())!;
  expect(closeBox.width, 'close button width').toBeGreaterThanOrEqual(FLOOR);
  expect(closeBox.height, 'close button height').toBeGreaterThanOrEqual(FLOOR);
  // Visible is not tappable: the point a thumb lands on must answer as the button.
  const hit = await close.evaluate((el) => {
    const b = el.getBoundingClientRect();
    return el.contains(document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2));
  });
  expect(hit, 'the middle of the close button is the close button').toBe(true);
  // The title now sits beside the button: no line of it may run under it.
  const titleUnderClose = await list.getByRole('heading', { level: 1 }).evaluate((title, box) => {
    const range = document.createRange();
    range.selectNodeContents(title);
    return [...range.getClientRects()].some(
      (r) => r.right > box.x && r.left < box.x + box.width && r.bottom > box.y && r.top < box.y + box.height,
    );
  }, closeBox);
  expect(titleUnderClose, 'no line of the title runs under the close button').toBe(false);
}

test.describe('an iPhone SE, 320x568', () => {
  const SCREEN = { width: 320, height: 568 };
  test.skip(({ browserName }) => browserName !== 'webkit', 'an iPhone is WebKit');
  test.use({ viewport: SCREEN, userAgent: IPHONE_UA });

  test('every offered wallet opens its app, and the list fits on the screen', async ({ page }) => {
    const list = await openList(page);
    expect(await rows(list)).toEqual(OFFERED.map((name) => `${name}Open app`));
    await expectFitsOnScreen(page, list, SCREEN);
  });
});

test.describe('Android Chrome, 360x640', () => {
  const SCREEN = { width: 360, height: 640 };
  test.skip(({ browserName }) => browserName !== 'chromium', 'Android Chrome is Chromium');
  test.use({ viewport: SCREEN, userAgent: ANDROID_UA });

  test('Phantom opens its app like the rest, the last row is named in plain words, and the list fits', async ({ page }) => {
    const list = await openList(page);
    expect(await rows(list)).toEqual([...OFFERED.map((name) => `${name}Open app`), 'Any wallet appOpen app']);
    await expectFitsOnScreen(page, list, SCREEN);
  });

  test('a tap on Phantom opens this page inside the Phantom app, not Phantom’s website', async ({ page }) => {
    await page.addInitScript(() => {
      const opened: string[] = [];
      (window as unknown as { __opened: string[] }).__opened = opened;
      window.open = (url) => {
        opened.push(String(url));
        return null;
      };
    });
    // Recorded and stopped: this suite never leaves for phantom.app.
    await page.route(/^https:\/\/phantom\.(app|com)\//, (route) => route.abort('aborted'));
    const list = await openList(page);
    const here = page.url();
    const hop = page.waitForRequest(/^https:\/\/phantom\.app\//, { timeout: 15_000 });
    await list.getByRole('button', { name: /^Phantom/ }).click();
    expect((await hop).url()).toBe(
      `https://phantom.app/ul/browse/${encodeURIComponent(here)}?ref=${encodeURIComponent(new URL(here).origin)}`,
    );
    expect(await page.evaluate(() => (window as unknown as { __opened: string[] }).__opened)).toEqual([]);
  });
});

test.describe('inside a wallet app’s own browser', () => {
  // Its user agent keeps the Safari token, so a hop out to an app reads as possible.
  test.use({ userAgent: `${IPHONE_UA} Trust/11.0` });

  test('the wallet it registers is listed once: no "Open app" row under the same name', async ({ page, context }) => {
    await installConnectOnlySolanaWallet(context, 'Trust Wallet');
    const list = await openList(page);
    expect(await rows(list)).toEqual([
      'Trust WalletDetected',
      ...OFFERED.filter((name) => name !== 'Trust Wallet').map((name) => `${name}Open app`),
    ]);
  });
});
