// Island answer twenty-four, build 4: Bayla at the door. One line in her voice at the top of
// every venue screen, under the nav, always in the same place; the state read, the one next
// move with its number, and the button beside it. Walked at 390 on the production build:
// the home, the room, the swap, the pools page and the launch page, the same height, one
// line, the button lit. A stranger with no wallet reads the no-wallet line everywhere.
import { test, expect } from '@playwright/test';
import { gotoRoute } from './fixtures/routes';

test.use({ serviceWorkers: 'block' });

const ROUTES = ['/', '/bayla', '/solana', '/pools', '/launch'];
const NO_WALLET = 'Your held time already has a number. Paste any wallet.';

test('the line is under the nav on the home, the room, the swap, the pools page and the launch page, same height, one line, the button lit', async ({ page }) => {
  test.skip(test.info().project.name !== 'chromium', 'a phone-width sweep on the chromium project');
  test.slow();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    try {
      localStorage.setItem('tegridy-onboarding-seen', '1');
      localStorage.setItem('tegridy_telemetry_consent', 'denied');
    } catch {
      /* private mode */
    }
  });
  // Quiet: the island's reads are sealed, so the line is read from nothing but the state.
  await page.route('**/api/aggregator?resource=fire**', (r) => r.fulfill({ status: 502, json: { error: 'sealed' } }));

  const tops: Record<string, number> = {};
  for (const path of ROUTES) {
    await gotoRoute(page, path);
    const line = page.getByTestId('bayla-line');
    await expect(line, `${path}: no line under the nav`).toBeVisible({ timeout: 30_000 });
    const text = page.getByTestId('bayla-line-text');
    await expect(text, `${path}: not the stranger's line`).toHaveText(NO_WALLET);
    const button = page.getByTestId('bayla-line-button');
    await expect(button).toBeVisible();
    await expect(button).toHaveText('Read heat');
    const box = await line.boundingBox();
    const bbox = await button.boundingBox();
    expect(box, `${path}: the line has no box`).not.toBeNull();
    expect(bbox!.height, `${path}: the button is under 40px`).toBeGreaterThanOrEqual(40);
    // One line of text: the sentence fits beside the button without wrapping past two rows.
    const lines = await text.evaluate((el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)));
    expect(lines, `${path}: the line wraps to ${lines} rows`).toBeLessThanOrEqual(2);
    tops[path] = Math.round(box!.y);
  }
  // The same place on every screen: under the 56px header, on arrival (in flow, never pinned).
  const distinct = new Set(Object.values(tops));
  expect(distinct.size, `the line sits at different heights: ${JSON.stringify(tops)}`).toBe(1);
  expect([...distinct][0]).toBe(56);
});

test('the farm keeps its own voice: no line on /toweli', async ({ page }) => {
  test.skip(test.info().project.name !== 'chromium', 'one check');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    try {
      localStorage.setItem('tegridy-onboarding-seen', '1');
    } catch {
      /* private mode */
    }
  });
  await gotoRoute(page, '/toweli');
  await expect(page.getByTestId('bayla-line')).toHaveCount(0);
});
