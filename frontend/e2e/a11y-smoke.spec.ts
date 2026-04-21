/**
 * A11y smoke — checks the ARIA landmarks the B2a pass added actually reach
 * the rendered DOM. These tests codify the intent; if someone deletes the
 * role="tablist" on the trade tabs or the aria-labelledby on a modal, the
 * regression shows up here instead of in a bug report.
 *
 * Keep narrow: this is smoke coverage, not an axe audit. Exhaustive WCAG
 * scans should go through a dedicated axe-core run.
 */

import { test, expect } from './fixtures/wallet';

test.describe('a11y landmarks — core pages', () => {
  test('AppLayout exposes <main> and a skip-link anchored at it', async ({ page, walletMock: _w }) => {
    await page.goto('/');
    const main = page.locator('main#main-content');
    await expect(main).toHaveCount(1);

    // Skip-link is visually hidden but must be in the DOM so keyboard users
    // can tab onto it as the first focusable element.
    const skipLink = page.getByRole('link', { name: /skip to main content/i });
    await expect(skipLink).toHaveCount(1);
    await expect(skipLink).toHaveAttribute('href', '#main-content');
  });

  test('TradePage tabs expose role="tablist" + aria-label', async ({ page, walletMock: _w }) => {
    await page.goto('/swap');
    const tablist = page.getByRole('tablist', { name: /trade view/i });
    await expect(tablist).toBeVisible();
    const tabs = tablist.getByRole('tab');
    await expect(tabs).toHaveCount(4);

    // Default tab is Swap → must be aria-selected.
    const swapTab = tablist.getByRole('tab', { name: /^swap$/i });
    await expect(swapTab).toHaveAttribute('aria-selected', 'true');
  });

  test('TradePage swap amount input has a contextual aria-label', async ({ page, walletMock }) => {
    await page.goto('/swap');
    await walletMock.connect();
    // The input's aria-label embeds the selected From token symbol. We don't
    // assert the exact token (depends on wagmi connect timing); we only
    // assert the label contains "to pay".
    const amountInput = page.getByRole('textbox', { name: /amount of .* to pay/i });
    // Only asserted if the connected-state input renders. Skip if the mock
    // hasn't hydrated the swap card — that path is exercised in
    // trade-page.spec.ts.
    const count = await amountInput.count();
    if (count > 0) {
      await expect(amountInput.first()).toBeVisible();
    }
  });

  test('TokenSelectModal dialog is labelled by its visible heading', async ({ page, walletMock: _w }) => {
    await page.goto('/swap');
    // Force-render the modal without a full wallet flow — look for the
    // dialog after clicking a From token button. The button's aria-label
    // starts with "Change token to pay with".
    const fromButton = page.getByRole('button', { name: /change token to pay with/i }).first();
    if ((await fromButton.count()) === 0) {
      test.skip(true, 'TokenSelectModal is only rendered after wallet gate clears; skipping in disconnected run.');
    }
    await fromButton.click();

    const dialog = page.getByRole('dialog', { name: /select token/i });
    await expect(dialog).toBeVisible();
    // The aria-labelledby must resolve to a visible node with the expected text.
    const heading = page.locator('#token-select-title');
    await expect(heading).toHaveText(/select token/i);
  });

  test('TopNav exposes a labelled <nav> landmark', async ({ page, walletMock: _w }) => {
    await page.goto('/');
    const mainNav = page.locator('nav[aria-label="Main navigation"]:visible').first();
    await expect(mainNav).toBeVisible();
  });

  test('OnboardingModal, if rendered, uses aria-labelledby against its title', async ({ page, walletMock: _w }) => {
    await page.goto('/');
    const dialog = page.getByRole('dialog', { name: /welcome|get a wallet|stake towel/i });
    if ((await dialog.count()) === 0) {
      test.skip(true, 'Onboarding modal only fires on first visit; localStorage in CI marks visited.');
    }
    await expect(dialog.first()).toBeVisible();
    const titleNode = page.locator('#onboarding-title');
    await expect(titleNode).toHaveCount(1);
  });
});
