import { test, expect, type Page } from '@playwright/test';
import { BAYLA_LADDER_RECORDING } from './fixtures/baylaLadderPool';
import {
  CONNECT_ONLY_WALLET_ADDRESS,
  CONNECT_ONLY_WALLET_NAME,
  installConnectOnlySolanaWallet,
} from './fixtures/solanaConnectOnlyWallet';

// ON A SOLANA PAGE THE TOP BAR'S CONNECT CONNECTS SOLANA (owner, 2026-10-02:
// "trust wallet still seems to be having issues connecting to solana", with
// Trust's approval sheet listing Ethereum, Robinhood Chain and Base). The top
// bar was RainbowKit on every page, and its WalletConnect proposal is eip155
// only: no Ethereum connect can put Solana in a wallet's sheet. Now the top bar
// borrows the page's own Solana connection (src/lib/solanaSurface.ts).
//
// MUTATION CHECK: in TopNav.tsx make `solanaPage` false. The first, second and
// fourth tests must fail (RainbowKit opens); the third must still pass.

test.use({ serviceWorkers: 'block' });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('tegridy-onboarding-seen', '1');
      localStorage.setItem('tegridy_telemetry_consent', 'denied');
    } catch { /* private mode */ }
  });
});

const SOLANA_POOL = '/earn/bayla';
const SHORT = `${CONNECT_ONLY_WALLET_ADDRESS.slice(0, 4)}…${CONNECT_ONLY_WALLET_ADDRESS.slice(-4)}`;

const topBarSolanaConnect = (page: Page) =>
  page.getByRole('banner').getByRole('button', { name: 'Connect a Solana wallet' });
const solanaList = (page: Page) => page.getByRole('dialog', { name: /on Solana to continue/ });
/** RainbowKit's connect dialog (the Ethereum list). */
const ethereumList = (page: Page) => page.locator('[aria-labelledby="rk_connect_title"]');

/** /api/solrpc answers from the recorded BAYLA ladder; a call it does not hold is aborted. */
async function answerLadderFromRecording(page: Page) {
  const answers: Record<string, unknown> = BAYLA_LADDER_RECORDING.answers;
  await page.route('**/api/solrpc', (route) => {
    let body: unknown = null;
    try { body = route.request().postDataJSON(); } catch { /* not JSON: unanswered */ }
    const calls = (Array.isArray(body) ? body : [body]) as { id?: unknown; method?: unknown; params?: unknown[] }[];
    const keys = calls.map((c) => `${String(c?.method)}:${String(c?.params?.[0])}`);
    if (!keys.every((k) => k in answers)) return route.abort();
    const replies = calls.map((c, i) => ({ jsonrpc: '2.0', id: c.id, result: answers[keys[i]!] }));
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(Array.isArray(body) ? replies : replies[0]),
    });
  });
}

test('on a Solana pool, the top bar Connect opens the Solana wallet list, not the Ethereum one', async ({ page }) => {
  await page.goto(SOLANA_POOL);
  await expect(topBarSolanaConnect(page)).toBeVisible({ timeout: 30_000 });
  await topBarSolanaConnect(page).click();
  await expect(solanaList(page)).toBeVisible({ timeout: 30_000 });
  await expect(solanaList(page).getByText('Trust Wallet')).toBeVisible();
  await expect(ethereumList(page)).toHaveCount(0);
});

test('a tap before the page\'s Solana code has loaded waits for it, and never opens the Ethereum list', async ({ page }) => {
  // Hold the Solana chunk until the tap has landed, so the tap is early by construction.
  let release: () => void = () => {};
  const tapped = new Promise<void>((resolve) => { release = resolve; });
  let held = 0;
  await page.route(/\/assets\/vendor-solana[^/]*\.js(\?.*)?$/, async (route) => {
    held += 1;
    await tapped;
    await route.continue();
  });
  await page.goto(SOLANA_POOL);
  const connect = topBarSolanaConnect(page);
  await expect(connect).toBeVisible({ timeout: 30_000 });
  await connect.click();
  await expect(connect).toHaveAttribute('aria-busy', 'true');
  await expect(solanaList(page)).toHaveCount(0);
  await expect(ethereumList(page)).toHaveCount(0);
  release();
  await expect(solanaList(page)).toBeVisible({ timeout: 30_000 });
  await expect(ethereumList(page)).toHaveCount(0);
  expect(held, 'the Solana chunk was held, so the tap really was early').toBeGreaterThan(0);
});

test('on an Ethereum page, the top bar Connect is still the Ethereum list', async ({ page }) => {
  await page.goto('/swap');
  const connect = page.getByRole('banner').getByRole('button', { name: 'Connect wallet' });
  await expect(connect).toBeVisible({ timeout: 30_000 });
  await connect.click();
  await expect(ethereumList(page)).toBeVisible({ timeout: 30_000 });
  await expect(solanaList(page)).toHaveCount(0);
  await expect(topBarSolanaConnect(page)).toHaveCount(0);
});

test.describe('connected from the top bar', () => {
  test('the top bar shows the Solana address, the page card is connected too, the row fits at every width, and Disconnect undoes it', async ({ page, context }, testInfo) => {
    test.slow();
    await installConnectOnlySolanaWallet(context);
    await answerLadderFromRecording(page);
    await page.goto(SOLANA_POOL);
    await expect(topBarSolanaConnect(page)).toBeVisible({ timeout: 30_000 });
    // The page itself, not just the top bar: the hero is two lazy chunks behind
    // it, and a count() read before it has drawn says "no ladder" of any build.
    await expect(page.getByRole('heading', { level: 1, name: 'Stake BAYLA.' })).toBeVisible({ timeout: 30_000 });

    // The ladder card's own connect button (a build with the ladder, as CI's and production's are).
    const cardConnect = page.locator('main').getByRole('button', { name: 'Connect a Solana wallet' });
    const hasLadder = (await page.getByText(/The lock ladder is live for BAYLA/).count()) > 0;
    if (hasLadder) await expect(cardConnect).toBeVisible({ timeout: 30_000 });
    else expect(process.env.CI, 'the CI build sets the ladder, as production does, and this build has none').toBeFalsy();

    await topBarSolanaConnect(page).click();
    await solanaList(page).getByRole('button', { name: new RegExp(CONNECT_ONLY_WALLET_NAME) }).click();

    const chip = page.getByRole('banner').getByRole('button', { name: `Solana wallet ${SHORT}, switch or disconnect` });
    await expect(chip).toBeVisible({ timeout: 30_000 });
    await expect(chip).toHaveText(SHORT);
    await expect(topBarSolanaConnect(page)).toHaveCount(0);
    // ONE connection: the card the top bar borrowed it from is connected as well.
    await expect(cardConnect).toHaveCount(0);

    // THE CONNECTED CHIP AT EVERY HEADER WIDTH (header-reachability.spec.ts sweeps
    // the disconnected button on `/`; nothing swept a connected one). The chip is
    // drawn in the DEVICE's monospace font, so one machine's pass says nothing of
    // another's: Consolas here is 0.55em a character, Liberation Mono (CI) and
    // Android's 0.60em, the iPhone's SF Mono 0.618em. So it is swept twice: as
    // this machine draws it, and at 0.62em, wider than any of them.
    //
    // The 0.62em pass sets the address's WIDTH, not a font. Swapping the font and
    // adding letter-spacing was tried first, and it measured differently from one
    // CI run to the next on the same code (0.60em, then over 0.615em): which font
    // a name resolves to, and whether a quarter-pixel of spacing survives glyph
    // rounding, are the runner's business. A width is the same everywhere.
    if (testInfo.project.name === 'chromium') {
      const viewport = page.viewportSize()!;
      await page.evaluate(() => document.fonts.ready);
      const sweep = async (label: string) => {
        const failures: string[] = [];
        for (const width of [360, 375, 390, 399, 400, 414, 639, 640, 694, 767, 768, 799, 800, 810, 1023, 1024, 1440]) {
          await page.setViewportSize({ width, height: 900 });
          await expect(chip).toBeVisible();
          const box = await chip.boundingBox();
          if (!box || box.x < 0 || box.x + box.width > width) {
            failures.push(`${width}px: the Solana chip is off-canvas (${box ? `${Math.round(box.x)}..${Math.round(box.x + box.width)}` : 'no box'})`);
          }
          const row = await page.getByRole('banner').evaluate((el) => {
            const r = el.querySelector('div.flex.items-center.justify-between') ?? el.firstElementChild;
            return r ? { scroll: r.scrollWidth, client: r.clientWidth } : null;
          });
          if (row && row.scroll > row.client) {
            failures.push(`${width}px: header row overflows: scrollWidth ${row.scroll} > clientWidth ${row.client}`);
          }
        }
        expect(failures, `connected header failures (${label}):\n  ${failures.join('\n  ')}`).toEqual([]);
      };
      await sweep("this machine's monospace font");
      // Nine characters at 0.62em each. `flex: none` so the chip cannot squeeze it.
      await page.addStyleTag({
        content: 'header button[aria-label^="Solana wallet"] span.truncate { display: block !important; flex: none !important; box-sizing: content-box !important; width: 5.58em !important; }',
      });
      const advance = await chip.evaluate((el) => {
        const text = el.querySelector('span.truncate')!;
        return text.getBoundingClientRect().width / (text.textContent!.length * parseFloat(getComputedStyle(text).fontSize));
      });
      expect(advance, 'the widest pass really is 0.62em a character').toBeCloseTo(0.62, 2);
      await sweep('the address as wide as 0.62em a character, wider than any device draws it');
      await page.setViewportSize(viewport);
    }

    // The address opens the list to switch or disconnect, and Disconnect undoes it all.
    await chip.click();
    const switchList = page.getByRole('dialog', { name: 'Switch Solana wallet' });
    await expect(switchList).toBeVisible({ timeout: 30_000 });
    await expect(switchList).toContainText(`Connected as ${SHORT}.`);
    await switchList.getByRole('button', { name: 'Disconnect' }).click();
    await expect(topBarSolanaConnect(page)).toBeVisible({ timeout: 30_000 });
    await expect(chip).toHaveCount(0);
    if (hasLadder) await expect(cardConnect).toBeVisible({ timeout: 30_000 });
  });
});
