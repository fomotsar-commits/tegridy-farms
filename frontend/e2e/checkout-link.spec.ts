import { test, expect } from '@playwright/test';
import { gotoRoute } from './fixtures/routes';

// The two fragment states a stranger can force on /checkout without a wallet, a
// server or a signature — so they are the two the sweep can actually reach.
//
// Everything else about the payment link (verified / forged / unverifiable, the
// settle-token check, the balance three-way, the receipt judge) needs a real
// signature and a real RPC, and lives in the unit suites: CheckoutWidget.test,
// CheckoutPage.test, usePaymentLink.test and lib/commerce/paymentLink.test.
//
// This spec exists because both cases below are ONE-LINE regressions with
// expensive consequences: an unreadable link rendered as "forged" accuses an
// honest merchant, and a two-invoice URL silently resolved to one of them lets a
// buyer read figures off document A while paying document B.

test.describe('the checkout fragment is read, bounded and never guessed at', () => {
  test('an unreadable fragment is neutral, not an accusation, and offers nothing to pay', async ({ page }) => {
    await gotoRoute(page, '/checkout#i=garbage');

    await expect(page.getByText('This is not a payment link this build can read')).toBeVisible();

    const body = (await page.locator('main#main-content').textContent()) ?? '';
    // The accusation that must not appear: nothing has been checked against any
    // merchant, so nothing here may read as a failed verification.
    expect(body).not.toMatch(/does not verify/i);
    expect(body).not.toMatch(/\bforged\b/i);
    // And the pre-change copy, which would mean the fragment was ignored entirely.
    expect(body).not.toContain('No invoice');
    await expect(page.getByRole('button', { name: /pay the exact amount/i })).toHaveCount(0);
  });

  test('a URL naming both a signed link and a short-link id is refused outright', async ({ page }) => {
    await gotoRoute(page, '/checkout?invoice=order-1#i=abc');

    await expect(page.getByText('This link names two invoices')).toBeVisible();
    await expect(page.getByRole('button', { name: /pay the exact amount/i })).toHaveCount(0);

    const body = (await page.locator('main#main-content').textContent()) ?? '';
    // Neither document's figures may be on screen: the whole refusal is that
    // this page will not pick one of them on the buyer's behalf.
    expect(body).not.toMatch(/Due:/);
  });
});
