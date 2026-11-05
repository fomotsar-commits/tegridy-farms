// Island answer twenty-seven, cut 1: the Add door never closes on an outside price. On the
// night of 2026-11-04 the price loop never reached $BAYLA (the shared list said `unread`,
// `last: null`), and twenty-four's hold closed the Add form on the island's own coin: the
// room's sheet, the island's link and the $BAYLA card on /pools each ended on "This pool's Add
// form was not opened ... adding waits" under "Deposits: not checked". With /api/outside-prices
// answering as it did that night, each of the three now opens the form, the outside price is
// one row ("Outside price not read yet"), and the three phrases appear nowhere on the page.
//
// The pools are read from mainnet through the preview's /api/solrpc proxy, as the other pools
// specs read them, so this runs with ADD_DOOR_LIVE=1 (a keyed SOLANA_RPC_URL holds best). The
// hermetic proof of the same rule is the unit tests (poolHealth.test.ts, PoolCard.hold.test.tsx,
// outsidePrice.shared.test.ts). Red first against the trunk of 2026-11-05 (08e1b4f51).
import { test, expect, type Page } from '@playwright/test';
import { gotoRoute } from './fixtures/routes';

test.use({ serviceWorkers: 'block' });

const BAYLA = '7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump';
const BAYLA_POOL = 'ErvzV1NMZmcfAqZtGH4AQhYAjn77nJEworKK1mYPz5w4';
const NEVER = [/Add form was not opened/, /adding waits/, /Deposits: not checked/];
const LIVE = process.env.ADD_DOOR_LIVE === '1';

/** /api/outside-prices as it answered at 10:54 PM Pacific on 2026-11-04: $BAYLA never read. */
async function tonightsList(page: Page) {
  await page.route('**/api/outside-prices**', (r) =>
    r.fulfill({
      json: {
        state: 'ok',
        read_at: Date.now(),
        fresh_for_ms: 600_000,
        probe_lamports: '50000000',
        prices: { [BAYLA]: { state: 'unread', detail: 'the loop ran out of time before this token', last: null } },
        usd: null,
        usd_read_at: null,
        usd_asked: null,
      },
    }),
  );
}

async function neverSays(page: Page) {
  const text = await page.locator('body').innerText();
  for (const w of NEVER) expect(text, `the page says ${w}`).not.toMatch(w);
}

test.describe('the Add door never closes on an outside price', () => {
  test.skip(!LIVE, 'reads the $BAYLA pool from mainnet: run with ADD_DOOR_LIVE=1');
  test.beforeEach(async ({ page }, info) => {
    test.skip(info.project.name !== 'chromium', 'one walk, at 390, on the desktop project');
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
    await tonightsList(page);
  });

  for (const [name, path] of [
    ['the $BAYLA room’s sheet', '/bayla?sheet=add'],
    ['the island’s link', `/pools?mint=${BAYLA}&task=add`],
  ] as const) {
    test(`${name} opens the form, and the outside price is one row`, async ({ page }) => {
      await gotoRoute(page, path);
      const sheet = page.getByTestId('action-sheet');
      await expect(sheet.getByTestId('lp-one-coin-panel')).toBeVisible({ timeout: 60_000 });
      await expect(sheet).toContainText('not read yet');
      await neverSays(page);
    });
  }

  test('the $BAYLA card’s Add on /pools raises the sheet on that pool, and the list stays where it was', async ({ page }) => {
    await page.route('**/api/pools**', (r) => r.fulfill({ json: { all: true, program: 'EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT', pools: [BAYLA_POOL], truncated: false, readAt: Date.now() } }));
    await gotoRoute(page, '/pools');
    const list = page.getByTestId('lp-all-pools');
    // The first card under the finder is the list; the Arbitrage board sits under it.
    await expect(list).toBeVisible({ timeout: 60_000 });
    const below = await page.getByTestId('lp-arb').evaluate((board, l) => (l!.compareDocumentPosition(board) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0, await list.elementHandle());
    expect(below, 'the Arbitrage board is above All pools').toBe(true);
    const add = list.getByRole('button', { name: /^Add to / }).first();
    await add.scrollIntoViewIfNeeded();
    const at = await page.evaluate(() => window.scrollY);
    await add.click();
    const sheet = page.getByTestId('action-sheet');
    await expect(sheet.getByTestId('lp-one-coin-panel')).toBeVisible({ timeout: 60_000 });
    await neverSays(page);
    await page.goBack();
    await expect(sheet).toBeHidden();
    expect(Math.abs((await page.evaluate(() => window.scrollY)) - at), 'Back did not land on the same card').toBeLessThan(80);
  });
});
