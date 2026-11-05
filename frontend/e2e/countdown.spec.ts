// THE COUNTDOWN AT 390 (island answer twenty-five, screen 2; twenty-four, build 5). Done means:
// the cold wallet's /launch and heat card at 390 show the number (or the fallback words), the
// line, the green button and the roster line; the green button sits above the bottom bar at 660
// tall; the drawing's measures hold: 28 px under the header, the button 52 px and full width,
// the roster 12 px under it. Every island read is stubbed: the heat answer, and the board's
// count of warming flames through the torches read. Bayla's intel read is refused, so her line
// carries no fire figure; her button's quiet state is the sheet builder's, not asserted here.

import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/wallet';

/** Mirrors the fixture's DEFAULT_ACCOUNT, the wallet the mock connects. */
const WALLET = '0x71be63f3384f5fb98995898a86b02fb2426c5788';
const nowSec = () => Math.floor(Date.now() / 1000);

function heat(degrees: number, tier: string, extra: Record<string, unknown> = {}) {
  const cold = degrees === 0;
  return {
    address: WALLET,
    degrees,
    tier,
    is_cold: cold,
    held_since_unix: cold ? null : nowSec() - 90 * 86_400,
    as_of_unix: cold ? null : nowSec() - 3_600,
    token_count: cold ? 0 : 1,
    breakdown: cold
      ? []
      : [{ token_address: '0x420698CFdEDdEa6bc78D59bC17798113ad278F9D', chain: 'ethereum', name: 'Towelie', symbol: 'TOWELI', heat_degrees: degrees, first_seen_at_unix: nowSec() - 90 * 86_400, last_transfer_at_unix: nowSec() - 9 * 86_400 }],
    ...extra,
  };
}

/** The island's answers: this heat reading, 28 flames warming, and no fire figure. */
async function island(page: Page, reading: Record<string, unknown>): Promise<void> {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('tegridy-onboarding-seen', '1');
      localStorage.setItem('tegridy_telemetry_consent', 'denied');
      // The venue's own skin, not the wallet fixture's TOWELI room.
      localStorage.setItem('tegridy-bungalow', 'venue');
    } catch { /* private mode */ }
  });
  await page.route('**/api/aggregator**', async (route) => {
    const resource = new URL(route.request().url()).searchParams.get('resource');
    if (resource === 'heat') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(reading) });
    if (resource === 'torches') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ places: null, last_torch: null, fire: null, season: null, flames: 161, warming: 28, as_of_unix: null }),
      });
    }
    if (resource === 'fire') return route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"sealed"}' });
    return route.fallback();
  });
}

const box = async (page: Page, selector: string) => (await page.locator(selector).first().boundingBox())!;

/** The page's measures at this size: the header's bottom, the countdown's parts, the bottom bar's top. */
async function measures(page: Page) {
  return page.evaluate(() => {
    const rect = (el: Element | null) => el?.getBoundingClientRect() ?? null;
    const countdown = document.querySelector('[data-testid="countdown"]');
    const bar = Array.from(document.querySelectorAll('nav')).find((n) => getComputedStyle(n).position === 'fixed' && n.getBoundingClientRect().top > window.innerHeight / 2);
    // The column inside its side padding: what "full width" means for the button.
    const column = countdown?.querySelector('[data-column]') ?? null;
    const box = rect(column);
    const style = column ? getComputedStyle(column) : null;
    const content = box && style
      ? { left: box.left + parseFloat(style.paddingLeft), width: box.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) }
      : null;
    return {
      header: document.querySelector('header')?.getBoundingClientRect().bottom ?? null,
      eyebrow: rect(countdown?.querySelector('[data-eyebrow]') ?? null),
      button: rect(countdown?.querySelector('a.btn-primary') ?? null),
      roster: rect(countdown?.querySelector('[data-roster]') ?? null),
      content,
      barTop: bar ? bar.getBoundingClientRect().top : null,
      tabs: rect(document.querySelector('[data-route-tabs]')),
      text: countdown?.textContent ?? '',
    };
  });
}

test.describe('the countdown at 390', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'measured on Chromium at the drawing’s size; WebKit is walked by hand at 390');

  test('/launch opens on it for a cold wallet, as drawn', async ({ page, walletMock }) => {
    await island(page, heat(0, 'Drifter'));
    await walletMock.connect();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/launch');
    const countdown = page.getByTestId('countdown');
    await expect(countdown).toBeVisible({ timeout: 30_000 });
    await expect(countdown.getByText('28 flames are warming toward the door right now.')).toBeVisible();

    const m = await measures(page);
    expect(m.text).toContain('about half a year');
    expect(m.text).toContain('Residents launch here. Nobody can buy last year.');
    expect(m.text).not.toMatch(/\bcannot\b|—/i);
    // The door is not open yet (answer twenty-six): its eyebrow says so, and nothing launches here.
    expect(m.text).toContain('THE LAUNCH DOOR · NOT OPEN YET');
    expect(m.text).not.toMatch(/Drifter|Launch a token|Launchpad|Memetics Curve|Token name/i);
    // 28 px under the header, and the whole first screen, as drawn; the door has no tab strip.
    expect(Math.abs(m.eyebrow!.top - m.header! - 28), `eyebrow ${m.eyebrow!.top}, header ${m.header}`).toBeLessThanOrEqual(1.5);
    expect(m.tabs, 'the launch door has no tab strip').toBeNull();
    // The green button: 52 tall, the column's whole width; the roster 12 px under it.
    expect(Math.abs(m.button!.height - 52)).toBeLessThanOrEqual(1);
    expect(Math.abs(m.button!.width - m.content!.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(m.button!.left - m.content!.left)).toBeLessThanOrEqual(1);
    expect(m.roster!.top - m.button!.bottom).toBeGreaterThanOrEqual(11);
    expect(m.roster!.top - m.button!.bottom).toBeLessThanOrEqual(16);
    await expect(countdown.getByRole('link', { name: 'Start the clock' })).toHaveAttribute('href', '/launch?sheet=buy');
  });

  test('the green button sits above the bottom bar on a phone 660 tall', async ({ page, walletMock }) => {
    await island(page, heat(0, 'Drifter'));
    await walletMock.connect();
    await page.setViewportSize({ width: 390, height: 660 });
    await page.goto('/launch');
    await expect(page.getByTestId('countdown')).toBeVisible({ timeout: 30_000 });
    const m = await measures(page);
    expect(m.barTop, 'the bottom bar is on screen at 390').not.toBeNull();
    expect(m.button!.bottom, `button bottom ${m.button!.bottom}, bar top ${m.barTop}`).toBeLessThanOrEqual(m.barTop!);
  });

  test('a wallet at the door and up sees the warm state, and no form (answer twenty-six)', async ({ page, walletMock }) => {
    await island(page, heat(95.5, 'Resident'));
    await walletMock.connect();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/launch');
    const countdown = page.getByTestId('countdown');
    await expect(countdown).toHaveAttribute('data-state', 'warm', { timeout: 30_000 });
    await expect(countdown.getByText("warm enough. The door opens on the island's word.")).toBeVisible();
    await expect(countdown.getByText('You are on the list the day it opens.')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Who may plant' })).toHaveCount(0);
    await expect(page.getByRole('tablist')).toHaveCount(0);
    expect(await page.locator('main').innerText()).not.toMatch(/Launch a token|Launchpad|Memetics Curve|\bLIVE\b|Token name/);
  });

  test('the heat card on the home shows it for a cold wallet read there', async ({ page }) => {
    await island(page, heat(0, 'Drifter'));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    const field = page.getByLabel(/Wallet address to read Heat for/).first();
    await field.fill(WALLET);
    await field.press('Enter');
    const countdown = page.getByTestId('countdown');
    await expect(countdown).toBeVisible({ timeout: 30_000 });
    await countdown.scrollIntoViewIfNeeded();
    await expect(countdown.getByText('about half a year')).toBeVisible();
    await expect(countdown.getByText('Residents launch here. Nobody can buy last year.')).toBeVisible();
    await expect(countdown.getByText('28 flames are warming toward the door right now.')).toBeVisible();
    const button = await box(page, '[data-testid="countdown"] a.btn-primary');
    expect(Math.abs(button.height - 52)).toBeLessThanOrEqual(1);
    expect(await countdown.innerText()).not.toMatch(/\bcannot\b|—/i);
  });
});
