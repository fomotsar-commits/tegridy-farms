import { test, expect } from './fixtures/wallet';
import { SPLASH_MOUNT_TIMEOUT, gotoNakamigos } from './fixtures/routes';

// The Tradermigos splash leaves by itself (SplashScreen.jsx: LOADING_MS + EXIT_MS, 3.2 s);
// a tap only skips it. gotoNakamigos depends on that, and on never waiting for a tap to land.

test.describe('the Tradermigos splash', () => {
  test('leaves by itself, with no tap, and the landing follows', async ({ page, walletMock: _w }) => {
    await page.goto('/nakamigos');
    const splash = page.getByRole('button', { name: 'Enter Tradermigos' }).first();
    await expect(splash, 'a first visit plays the splash').toBeVisible({ timeout: SPLASH_MOUNT_TIMEOUT });
    await expect(splash, 'the splash waits for a tap again; gotoNakamigos needs a new plan').toBeHidden({ timeout: 15_000 });
    await expect(page.locator('main').first().getByRole('heading', { level: 1 })).toBeVisible({ timeout: SPLASH_MOUNT_TIMEOUT });
  });

  test('gotoNakamigos reaches the landing when no tap can land before the splash leaves', async ({ page, walletMock: _w }) => {
    // CI's WebKit workers draw so few frames on /nakamigos that a click's "stable" check outlasts
    // the splash, and the click then waits on a button that is gone. Keeping the splash moving
    // makes that certain on every engine: a click can never find it stable.
    test.setTimeout(45_000);
    await page.addInitScript(() => {
      document.addEventListener('DOMContentLoaded', () => {
        const style = document.createElement('style');
        style.textContent =
          '[role="button"][aria-label="Enter Tradermigos"] { animation: e2e-splash-drift 60s linear infinite !important; }' +
          '@keyframes e2e-splash-drift { from { translate: 0 0; } to { translate: 6000px 0; } }';
        document.head.append(style);
      });
    });
    await gotoNakamigos(page);
    await expect(page.locator('main').first().getByRole('heading', { level: 1 })).toBeVisible();
  });
});
