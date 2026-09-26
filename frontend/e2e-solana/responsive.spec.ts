// Phone (iPhone 14+ width), the 640-790px band where the top nav has no reachable Connect,
// iPad and desktop: every control a person must press to launch or trade is on top at its
// own centre, and the page never scrolls sideways. The pages here make no chain writes;
// the one launch they show is made from Node in beforeAll.
import { test, expect, type Locator, type Page } from '@playwright/test';
import type { PublicKey } from '@solana/web3.js';
import { createLaunchDirect, fundedKeypair } from './fixtures/chain';
import { installTestWallet } from './fixtures/testWallet';
import { installRpcGuard } from './fixtures/rpcGuard';
import { installUploadStub } from './fixtures/uploadStub';
import { ui, expectClickable, expectNoSidewaysScroll, connectWallet } from './fixtures/ui';

const SIZES = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'dead band', width: 700, height: 900 },
  { name: 'tablet', width: 820, height: 1180 },
  { name: 'desktop', width: 1280, height: 900 },
];

/** Every text field in `scope` computes to at least 16px, so focusing it never zooms iOS Safari. */
async function expectFieldsAtLeast16px(page: Page, scope: Locator): Promise<void> {
  const sizes = await scope.locator('input:not([type=file]):not([type=checkbox]), textarea, select').evaluateAll((els) =>
    els.map((e) => ({ label: e.getAttribute('aria-label') ?? e.tagName, px: parseFloat(getComputedStyle(e).fontSize) })),
  );
  expect(sizes.length).toBeGreaterThan(0);
  for (const s of sizes) expect(s.px, `${s.label} font-size at ${page.viewportSize()?.width}px`).toBeGreaterThanOrEqual(16);
}

/**
 * Every button in `scope` is at least 44px tall: the Buy/Sell toggles, the slippage
 * presets, Recent/Yours and 25%/50%/Max were about 30px (F12), below the site's own
 * 44px rule for .btn-* buttons.
 */
async function expectTouchTargets(page: Page, scope: Locator): Promise<void> {
  const buttons = await scope.locator('button:visible').evaluateAll((els) =>
    els.map((e) => ({ label: (e.textContent ?? '').trim().slice(0, 30), h: e.getBoundingClientRect().height })),
  );
  expect(buttons.length).toBeGreaterThan(0);
  for (const b of buttons) expect(b.h, `"${b.label}" is ${b.h}px tall at ${page.viewportSize()?.width}px`).toBeGreaterThanOrEqual(44);
}

let mint: PublicKey;
test.beforeAll(async () => {
  mint = await createLaunchDirect(await fundedKeypair(1));
});

for (const size of SIZES) {
  test(`${size.name} ${size.width}px: connect, launch form and trade controls are pressable`, async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: size.width, height: size.height } });
    const kp = await fundedKeypair(0.1);
    await installTestWallet(ctx, kp);
    const rpc = await installRpcGuard(ctx);
    await installUploadStub(ctx);
    const page = await ctx.newPage();

    await page.goto('/curve-launch');
    await expect(ui.createForm(page)).toBeVisible({ timeout: 30_000 });
    await expectNoSidewaysScroll(page);
    await expectClickable(ui.connectButton(ui.createForm(page)), 'Connect Solana Wallet (launch form)');
    await expectClickable(ui.form.reviewButton(page), 'Review launch');
    // UX3: iOS zooms the page when a field under 16px gets focus (iPhone and iPad).
    await expectFieldsAtLeast16px(page, ui.createForm(page));
    await expectTouchTargets(page, ui.list(page));
    await connectWallet(page, ui.createForm(page));

    await page.goto(`/curve-launch/${mint.toBase58()}`);
    await expect(ui.tradePanel(page)).toBeVisible({ timeout: 30_000 });
    await expectNoSidewaysScroll(page);
    for (const side of ['buy', 'sell'] as const) await expectClickable(ui.trade.side(page, side), `${side} toggle`);
    await expectClickable(ui.trade.reviewButton(page, 'buy'), 'Review buy');
    await expectFieldsAtLeast16px(page, ui.tradePanel(page));
    await expectTouchTargets(page, ui.tradePanel(page));
    // UX2: the venue, fee and loss facts sit above the trade form at every size.
    await expect(ui.beforeYouTrade(page)).toBeVisible();
    await expect(ui.beforeYouTrade(page)).toContainText('You can lose everything');
    // F7: the wallet connected on the launch form is still connected here, and the sell
    // side reads that wallet's own balance for the token (it holds none).
    await ui.trade.side(page, 'sell').click();
    await expect(ui.tradePanel(page).getByText(/^You hold 0$/)).toBeVisible({ timeout: 15_000 });
    await expectTouchTargets(page, ui.tradePanel(page));
    expect(rpc.violations).toEqual([]);
    await ctx.close();
  });
}

test('phone with no wallet installed: Connect still opens the wallet list', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await installRpcGuard(ctx);
  const page = await ctx.newPage();
  await page.goto(`/curve-launch/${mint.toBase58()}`);
  await expect(ui.tradePanel(page)).toBeVisible({ timeout: 30_000 });
  const connect = ui.connectButton(ui.tradePanel(page));
  await expectClickable(connect, 'Connect Solana Wallet');
  await connect.click();
  const modal = ui.walletModal(page);
  await expect(modal).toBeVisible();
  // Something to press that leads to a wallet (an app, an install page, or a QR code).
  await expect(modal.getByRole('button').or(modal.getByRole('link')).first()).toBeVisible();
  await ctx.close();
});
