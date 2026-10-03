import { test, expect, type Page } from '@playwright/test';
import { BAYLA_LADDER_RECORDING } from './fixtures/baylaLadderPool';
import {
  CONNECT_ONLY_WALLET_ADDRESS,
  CONNECT_ONLY_WALLET_NAME,
  installConnectOnlySolanaWallet,
} from './fixtures/solanaConnectOnlyWallet';

// OFF THE SOLANA PAGES, THE TOP BAR'S CONNECT ASKS WHICH NETWORK (owner,
// 2026-10-03: the home page, the Earn list and the doors must connect Solana
// too). There the button could only open the Ethereum list, and a Trust wallet
// picked from it is offered Ethereum chains and nothing else. Now it opens a
// sheet, Solana first, and the Solana row loads the top bar's own Solana
// connection (src/components/layout/TopBarSolana.tsx), lazily.
//
// MUTATION CHECKS
//  - TopBarSolana.tsx: drop `!ownWanted ||` from its guard. The first test must
//    fail: the Solana code is then downloaded on a first visit to `/`.
//  - TopNav.tsx: wire the Connect button back to `openConnectModal`. The first
//    three tests must fail.

test.use({ serviceWorkers: 'block' });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('tegridy-onboarding-seen', '1');
      localStorage.setItem('tegridy_telemetry_consent', 'denied');
      // `/` reloads once to clear a stored room; the venue sentinel means there is none.
      if (!localStorage.getItem('tegridy-bungalow')) localStorage.setItem('tegridy-bungalow', 'venue');
    } catch { /* private mode */ }
  });
});

const SHORT = `${CONNECT_ONLY_WALLET_ADDRESS.slice(0, 4)}…${CONNECT_ONLY_WALLET_ADDRESS.slice(-4)}`;

const topBarConnect = (page: Page) => page.getByRole('banner').getByRole('button', { name: 'Connect wallet' });
const walletsChip = (page: Page) => page.getByRole('banner').getByRole('button', { name: 'Your wallets' });
const connectSheet = (page: Page) => page.getByRole('dialog', { name: 'Connect a wallet', exact: true });
const solanaRow = (page: Page) => page.getByRole('dialog').getByRole('button', { name: /^Solana/ });
const ethereumRow = (page: Page) => page.getByRole('dialog').getByRole('button', { name: /^Ethereum, Base, Robinhood Chain/ });
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

test('on the home page a first visit downloads no Solana code; Connect, then Solana, opens the Solana wallet list', async ({ page }, testInfo) => {
  const solanaCode: string[] = [];
  page.on('request', (request) => {
    if (/\/assets\/vendor-solana[^/]*\.js/.test(request.url())) solanaCode.push(request.url());
  });
  await page.goto('/');
  await expect(topBarConnect(page)).toBeVisible({ timeout: 30_000 });
  // Past the moment a saved wallet would be restored (TopBarSolana RESTORE_DELAY_MS): none is saved.
  await page.waitForTimeout(2_500);
  expect(solanaCode, 'a visitor who never touched Solana downloaded its code').toEqual([]);

  // ⚠️ AT A PHONE'S SPEED. The list once opened "a frame after" the sheet
  // closed, and on a slow device the frame came before the close: the list
  // took the sheet's scroll lock for the page's own and put it back when it
  // closed. Measured then: locked in 1 try of 10 at full speed, 10 of 10 at a
  // quarter (review, 2026-10-03). Chromium only: the throttle is a DevTools call.
  if (testInfo.project.name === 'chromium') {
    const devtools = await page.context().newCDPSession(page);
    await devtools.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  }

  await topBarConnect(page).click();
  await expect(connectSheet(page)).toBeVisible();
  await expect(connectSheet(page).getByRole('listitem')).toHaveText([
    /^Solana/,
    /^Ethereum, Base, Robinhood Chain/,
  ]);
  await expect(ethereumList(page)).toHaveCount(0);

  await solanaRow(page).click();
  await expect(solanaList(page)).toBeVisible({ timeout: 30_000 });
  await expect(solanaList(page).getByText('Trust Wallet')).toBeVisible();
  await expect(connectSheet(page)).toHaveCount(0);
  await expect(ethereumList(page)).toHaveCount(0);
  expect(solanaCode.length, 'the Solana code is loaded once Solana is picked').toBeGreaterThan(0);

  // While the list is open the page behind it is locked; once it closes the
  // page scrolls again, and focus is back on the button the visitor started from.
  expect(await page.evaluate(() => getComputedStyle(document.body).overflow)).toBe('hidden');
  await solanaList(page).getByRole('button', { name: 'Close' }).click();
  await expect(solanaList(page)).toHaveCount(0);
  expect(await page.evaluate(() => getComputedStyle(document.body).overflow)).not.toBe('hidden');
  await expect(topBarConnect(page)).toBeVisible();
  // Safari does not focus a button when it is tapped, so there focus was never
  // on Connect to be handed back.
  if (!testInfo.project.name.includes('safari')) await expect(topBarConnect(page)).toBeFocused();
});

test('where the Solana wallets cannot be loaded, the sheet says so instead of loading for ever', async ({ page }) => {
  // The provider's stylesheet fails, as it does offline or in a tab left open
  // across a deploy. The bundler's import() wrapper rejects for it, and that
  // rejection once went unheard: "Loading Solana wallets…" never ended.
  let aborted = 0;
  await page.route(/\/assets\/SolanaProviders-[^/]*\.css(\?.*)?$/, (route) => {
    aborted += 1;
    return route.abort();
  });
  await page.goto('/');
  await expect(topBarConnect(page)).toBeVisible({ timeout: 30_000 });
  await topBarConnect(page).click();
  await solanaRow(page).click();
  // Well inside the row's own fifteen-second limit: it is the failed load that
  // is heard here, not the limit running out.
  await expect(solanaRow(page)).toContainText('Couldn’t load Solana wallets. Tap to reload the page.', { timeout: 8_000 });
  await expect(solanaList(page)).toHaveCount(0);
  expect(aborted, "the provider's stylesheet was asked for, and refused").toBeGreaterThan(0);
});

test('Connect, then Ethereum, is still the Ethereum wallet list', async ({ page }) => {
  await page.goto('/swap');
  await expect(topBarConnect(page)).toBeVisible({ timeout: 30_000 });
  await topBarConnect(page).click();
  await ethereumRow(page).click();
  await expect(ethereumList(page)).toBeVisible({ timeout: 30_000 });
  await expect(connectSheet(page)).toHaveCount(0);
  await expect(solanaList(page)).toHaveCount(0);
});

test('a room door asks which network too', async ({ page }) => {
  await page.goto('/bayla');
  await expect(topBarConnect(page)).toBeVisible({ timeout: 30_000 });
  await topBarConnect(page).click();
  await expect(connectSheet(page)).toBeVisible();
  await solanaRow(page).click();
  await expect(solanaList(page)).toBeVisible({ timeout: 30_000 });
});

test('a Solana wallet connected from the Earn list follows the visitor into a Solana pool, back out, and across a reload', async ({ page, context }) => {
  test.slow();
  await installConnectOnlySolanaWallet(context);
  await answerLadderFromRecording(page);
  await page.goto('/earn');
  await expect(page.getByRole('heading', { level: 1, name: 'Earn' })).toBeVisible({ timeout: 30_000 });

  // Connect Solana where the page has no Solana section at all.
  await topBarConnect(page).click();
  await solanaRow(page).click();
  await solanaList(page).getByRole('button', { name: new RegExp(CONNECT_ONLY_WALLET_NAME) }).click();
  await expect(walletsChip(page)).toHaveText(SHORT, { timeout: 30_000 });
  await expect(topBarConnect(page)).toHaveCount(0);

  // Into a Solana pool, inside the app (no reload): the pool's own connection
  // takes over, already connected, and the top bar keeps the address.
  await page.getByRole('link', { name: 'Open BAYLA' }).click();
  await expect(page).toHaveURL(/\/earn\/bayla$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Stake BAYLA.' })).toBeVisible({ timeout: 30_000 });
  const poolChip = page.getByRole('banner').getByRole('button', { name: `Solana wallet ${SHORT}, switch or disconnect` });
  await expect(poolChip).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('main').getByRole('button', { name: 'Connect a Solana wallet' })).toHaveCount(0);

  // Back to the list: the top bar's own connection returns with the same wallet.
  await page.getByRole('link', { name: /Back to Earn/ }).first().click();
  await expect(page).toHaveURL(/\/earn$/);
  await expect(walletsChip(page)).toHaveText(SHORT, { timeout: 30_000 });

  // The sheet now lists both networks, and the Solana row leads to switch or disconnect.
  await walletsChip(page).click();
  const sheet = page.getByRole('dialog', { name: 'Your wallets', exact: true });
  await expect(sheet.getByRole('listitem')).toHaveText([
    new RegExp(`^SolanaSwitch wallet or disconnect${SHORT.slice(0, 4)}`),
    /^Ethereum, Base, Robinhood ChainMetaMask, Trust, Rainbow and more/,
  ]);
  await sheet.getByRole('button', { name: 'Close dialog' }).click();

  // A later visit: the saved wallet is restored on a page with no Solana section.
  await page.reload();
  await expect(walletsChip(page)).toHaveText(SHORT, { timeout: 30_000 });
});
