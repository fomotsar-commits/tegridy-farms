/**
 * The dashboard's big frame on an iPad and a phone (owner, 2026-10-24: "the mobile and ipad
 * versions to have the dashboard too ... aesthetic according to the space given"). What a unit
 * test cannot see, because jsdom lays nothing out:
 *
 *   - upright on an iPad, the pinned frame stops at the end of the board. It once rode on over
 *     the pool list below its row, hiding the rows' arrows, and a tap on one hit the picture;
 *   - on a phone held sideways it is not pinned at all, since it would fill the screen;
 *   - with no wallet it sits under the connect buttons and is not pinned over them.
 */
import { test, expect } from './fixtures/wallet';
import { gotoRoute } from './fixtures/routes';
import type { Page } from '@playwright/test';

// The test sets the size, so two projects cover it: the desktop engine, and the iPad's own with touch.
const ENGINES = ['chromium', 'ipad-safari'];
const FRAME = '#dashboard [data-testid="dashboard-figure"]';

async function openConnected(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height });
  await gotoRoute(page, '/dashboard');
  // Connected: the board reads the wallet, so the frame follows rows rather than standing still.
  await expect(page.locator('#dashboard').getByText('What your wallet holds', { exact: false })).toBeVisible();
}

const position = (page: Page) => page.locator(FRAME).evaluate((el) => getComputedStyle(el).position);

test.describe('the dashboard frame', () => {
  // `walletMock` is asked for here so its init script (which stores the TOWELI room) is registered
  // first and the venue's, below, runs after it: the island's dashboard is the venue's.
  test.beforeEach(async ({ page, walletMock: _w }) => {
    test.skip(!ENGINES.includes(test.info().project.name), 'one pass per engine: the test sets the size, not the project');
    await page.addInitScript(() => {
      try { localStorage.setItem('tegridy-bungalow', 'venue'); } catch { /* ignore */ }
    });
  });

  test('upright on an iPad, the pinned frame stops at the end of the board, never over the pool list', async ({ page, walletMock }) => {
    await walletMock.connect();
    await openConnected(page, 820, 1180);
    expect(await position(page)).toBe('sticky');
    await page.locator('#dashboard summary').filter({ hasText: /pools on the island/i }).click();
    const list = page.getByRole('list', { name: 'Pools on the island' });
    await expect(list).toBeVisible();

    // Beside the board, not above it: the iPad layout, not the phone's.
    const beside = await page.evaluate((sel) => {
      const fig = document.querySelector(sel)!.getBoundingClientRect();
      const board = document.querySelector('#dashboard [aria-label="Holdings"]')!.getBoundingClientRect();
      return fig.left >= board.right;
    }, FRAME);
    expect(beside).toBe(true);

    for (const at of [0.2, 0.5, 0.8]) {
      await list.evaluate((el, f) => {
        const r = el.getBoundingClientRect();
        window.scrollBy(0, r.top + r.height * f - window.innerHeight / 2);
      }, at);
      await page.waitForTimeout(150);
      const covered = await page.evaluate((sel) => {
        const fig = document.querySelector(sel)!.getBoundingClientRect();
        return Array.from(document.querySelectorAll('#dashboard details[open] ol a'))
          .map((a) => ({ label: a.getAttribute('aria-label'), r: a.getBoundingClientRect() }))
          .filter(({ r }) => r.bottom > 0 && r.top < window.innerHeight)
          .filter(({ r }) => r.bottom > fig.top && r.top < fig.bottom && r.right > fig.left && r.left < fig.right)
          .map(({ label }) => label);
      }, FRAME);
      expect(covered, `pool rows under the frame with the list ${at * 100}% scrolled`).toEqual([]);
    }
  });

  test('on a phone held sideways the frame is not pinned; held upright it is', async ({ page, walletMock }) => {
    await walletMock.connect();
    await openConnected(page, 740, 360);
    expect(await position(page)).toBe('static');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => position(page)).toBe('sticky');
  });

  test('with no wallet, the frame sits under the connect buttons and is not pinned over them', async ({ page, walletMock: _w }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoRoute(page, '/dashboard');
    const connect = page.locator('#dashboard').getByRole('button', { name: /Connect Solana wallet/ });
    await expect(connect).toBeVisible();
    expect(await position(page)).toBe('static');
    const after = await connect.evaluate((btn, sel) => {
      const fig = document.querySelector(sel)!;
      return Boolean(btn.compareDocumentPosition(fig) & Node.DOCUMENT_POSITION_FOLLOWING);
    }, FRAME);
    expect(after).toBe(true);
  });
});
