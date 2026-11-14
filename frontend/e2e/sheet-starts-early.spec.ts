import { test, expect } from '@playwright/test';

// AN ADDRESS WITH THE SHEET UP STARTS THE FORM'S CODE WITH THE APP (island answer thirty-three, section 4).
// The form's chunk was asked for only once the connection's chunk had landed and drawn, one
// after the other. Here the connection's chunk is held for the whole test, and so is the
// page's own chunk, whose Solana section would otherwise bring the form in by its own road.

test.use({ serviceWorkers: 'block' });

const CONNECTION = '**/assets/SheetSolana-*.js';
const FORM = '**/assets/SheetBody-*.js';
const PAGE = '**/assets/HomePage-*.js';

for (const [name, address] of [
  ["a room's door with Add up", '/bayla?sheet=add'],
  ["a room's door with Buy up", '/bayla?sheet=buy'],
] as const) {
  test(`${name}: the form's chunk is asked for while the connection's is still held`, async ({ page }) => {
    await page.route('**/api/**', () => { /* held: nothing here needs the chain */ });
    await page.route(PAGE, () => { /* held */ });
    let held = 0;
    await page.route(CONNECTION, () => { held += 1; });
    const form = page.waitForRequest(FORM, { timeout: 20_000 });
    await page.goto(address, { waitUntil: 'commit' });
    await form;
    await expect(page.getByTestId('action-sheet')).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => held, { message: "the connection's chunk was asked for, and held" }).toBeGreaterThan(0);
  });
}

test('a room with no sheet in its address asks for neither chunk', async ({ page }) => {
  await page.route('**/api/**', () => { /* held */ });
  const asked: string[] = [];
  page.on('request', (request) => {
    if (/\/assets\/Sheet(Solana|Body)-[^/]*\.js/.test(request.url())) asked.push(request.url());
  });
  await page.goto('/bayla');
  await expect(page.locator('main#main-content h1').first()).toBeVisible({ timeout: 30_000 });
  // Past the first render and its lazy chunks: a sheet that was going to open has asked by now.
  await page.waitForTimeout(2_500);
  expect(asked, 'a visitor who never asked for the sheet downloaded its code').toEqual([]);
});
