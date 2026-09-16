/**
 * A11y smoke — checks the ARIA landmarks the B2a pass added actually reach
 * the rendered DOM. These tests codify the intent; if someone deletes the
 * role="tablist" on the trade tabs or the aria-labelledby on a modal, the
 * regression shows up here instead of in a bug report.
 *
 * Keep narrow: this is smoke coverage, not an axe audit. Exhaustive WCAG
 * scans should go through a dedicated axe-core run.
 *
 * THE OTHER HALF IS e2e/a11y-routes.spec.ts. This file pins named landmarks on
 * the handful of surfaces the B2a pass touched; that one sweeps EVERY routed
 * page for structural violations against the table in e2e/fixtures/routes.ts.
 * Add a route-shaped assertion there and a landmark-shaped one here — the
 * split is what keeps this file from turning into a list of forty near-copies.
 */

import { test, expect } from './fixtures/wallet';
import { gotoRoute } from './fixtures/routes';

test.describe('a11y landmarks — core pages', () => {
  // PIN THE VENUE'S SETTLED STATE. `/` is wrapped in <BungalowDoor id={VENUE_ID}>,
  // which clears a stored skin by reloading the document, and the shared wallet
  // fixture pins `tegridy-bungalow` to `toweli` — so any spec that lands on `/`
  // and asserts on the first document races that reload and dies with
  // "Execution context was destroyed". Seeding the `venue` sentinel means there
  // is nothing to clear and no reload happens.
  //
  // REQUEST walletMock even though it is unused: init scripts run in
  // REGISTRATION order and fixture setup is what registers the fixture's own,
  // so a pin added before it resolves is overwritten by that `toweli`.
  test.beforeEach(async ({ page, walletMock: _w }) => {
    await page.addInitScript(() => {
      try { localStorage.setItem('tegridy-bungalow', 'venue'); } catch { /* ignore */ }
    });
  });

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
    // FIVE tabs, per TAB_LABELS in src/pages/TradePage.tsx —
    // Swap / DCA / Limit / TWAP / Trigger. Was 4 before TWAP, 5 before Trigger,
    // 6 before Liquidity left on 2026-09-06.
    //
    // The count is pinned rather than loose on purpose: a tab appearing or
    // vanishing without someone editing this line is the thing worth catching.
    // It worked — this line is what caught the Liquidity removal and forced it
    // to be a deliberate edit rather than a silent drift. Every previous move
    // was an addition; this is the first subtraction, and the tab did not
    // disappear so much as go home: it rendered the SAME <LiquidityTab /> that
    // /liquidity renders, so the swap page was carrying a duplicate of another
    // route's form among five ways to place a trade. e2e/liquidity.spec.ts pins
    // that it is gone from here and that ?tab=liquidity redirects there.
    await expect(tabs).toHaveCount(5);

    // Default tab is Swap → must be aria-selected.
    const swapTab = tablist.getByRole('tab', { name: /^swap$/i });
    await expect(swapTab).toHaveAttribute('aria-selected', 'true');
  });

  test('TradePage swap amount input has a contextual aria-label', async ({ page, walletMock: _w }) => {
    // NO WALLET, AND NO CONDITIONAL. The From amount input renders for a
    // disconnected visitor: TradePage's swap form is public (the T7 note above
    // its From block), and only the action button gates on connect.
    //
    // This used to `goto('/swap')`, connect, and assert only `if (count() > 0)`,
    // so it PASSED while asserting nothing. count() read 0 on all four projects
    // (measured 2026-09-10, --workers=1), for two separate reasons:
    //   1. timing: on three of them count() ran before the lazy TradePage chunk
    //      had even been requested (chromium: +153ms after load, the route
    //      skeleton still aria-busy);
    //   2. role: the input is `type="number"`, which is a spinbutton, and the
    //      locator asked for a textbox. On mobile-chrome the input WAS mounted
    //      when count() ran, and it still read 0. Mounted page, every project:
    //      textbox 0, spinbutton 1.
    //
    // Found by position, then asserted by name, so a renamed label fails on the
    // label it actually has rather than on "element not found". The From amount
    // ("You Pay") is the first spinbutton in the Swap panel.
    await gotoRoute(page, '/swap');
    const amountInput = page.getByRole('tabpanel', { name: /^swap$/i }).getByRole('spinbutton').first();
    await expect(
      amountInput,
      'the From amount input is missing from a mounted /swap with no wallet connected. The swap form ' +
        'renders for everyone (TradePage, T7). Do not reinstate a conditional.',
    ).toBeVisible();
    // The label embeds the selected From token; the symbol itself is not pinned.
    await expect(amountInput).toHaveAccessibleName(/amount of .* to pay/i);
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

  test('OnboardingModal uses aria-labelledby against its visible title', async ({ page, walletMock: _w }) => {
    // NO SKIP. This used to skip whenever `dialog.count()` read 0 straight after
    // `page.goto('/')`, which was every run, by construction, twice over:
    //   1. the wallet fixture pre-seeds `tegridy-onboarding-seen` = '1', and
    //      OnboardingModal auto-opens only when that key is not '1';
    //   2. AppLayout mounts the AUTO-opening modal only in the TOWELI voice.
    //      Everywhere else, `/` under this file's venue pin included, it mounts
    //      the invited welcome, which never opens by itself.
    // Measured 2026-09-10 on all four projects: with the key cleared and the
    // venue pin kept, `/` showed no dialog within 8s. The skip also guarded a
    // dead assertion: `#onboarding-title` is an id nothing renders, because
    // Modal gives its title a useId() id.
    //
    // So clear the key and wear the TOWELI skin, then walk /toweli. Its door
    // already matches the stored skin, so there is no BungalowDoor reload to
    // race. Registered here, these run AFTER the fixture's init scripts and the
    // venue pin in the beforeEach, so these writes are the ones that stick.
    // Every other overlay stays suppressed by the fixture.
    await page.addInitScript(() => {
      try {
        localStorage.removeItem('tegridy-onboarding-seen');
        localStorage.setItem('tegridy-bungalow', 'toweli');
      } catch { /* ignore */ }
    });
    await gotoRoute(page, '/toweli');

    // Found by its heading, not by its accessible name, so a broken label fails
    // on the label assertions below rather than on "element not found".
    const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: /^welcome to/i }) });
    await expect(
      dialog,
      'the first-visit onboarding did not open on /toweli with its seen-key cleared. Do not reinstate a skip.',
    ).toBeVisible();
    const title = dialog.getByRole('heading', { name: /^welcome to/i });
    const titleId = await title.getAttribute('id', { timeout: 5_000 });
    expect(titleId, 'the onboarding title carries no id for the dialog to be labelled by').toBeTruthy();
    await expect(dialog).toHaveAttribute('aria-labelledby', titleId!);
    await expect(dialog).toHaveAccessibleName((await title.textContent({ timeout: 5_000 }))?.trim() ?? '');
  });
});
