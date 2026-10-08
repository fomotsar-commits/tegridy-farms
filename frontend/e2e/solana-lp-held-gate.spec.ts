// /solana-lp on the production build, with the LP gate's network read held open and
// never answered. Every other read lands, so the LP section is up. The gate must close
// as unread when the wait is over, and say so with Read again ready.
import { test, expect } from './fixtures/wallet';
import { gotoRoute } from './fixtures/routes';
import { playLiveVenue } from './fixtures/playedVenue';

test('/solana-lp with the gate read never answered: the page says it could not check the network, and Read again asks again', async ({ page, walletMock: _w }) => {
  test.skip(test.info().project.name !== 'chromium', 'the same transport on every device');
  test.slow();
  await playLiveVenue(page, { gateOpen: true });
  // Registered last, so asked first: the gate's first read is held, the rest fall through.
  let held = 0;
  await page.route('**/api/solrpc', (route) => {
    let body: { method?: unknown } | null = null;
    try { body = route.request().postDataJSON() as { method?: unknown } | null; } catch { /* not JSON: not the gate's */ }
    if (body?.method !== 'getGenesisHash') return route.fallback();
    held += 1; // never fulfilled, never aborted
  });

  await gotoRoute(page, '/solana-lp');
  await expect(page.getByTestId('lp-finder'), 'the LP section did not mount on the played venue').toBeVisible({ timeout: 20_000 });
  await expect.poll(() => held, 'the LP gate asked which network this is').toBe(1);
  const banner = page.getByTestId('lp-gate-banner');
  await expect(banner, 'nothing is said while the answer may still come').toHaveCount(0);

  // Given up after 10 seconds. It used to be waited on for the whole visit, with no
  // forms and no reason on the page.
  await expect(banner).toContainText('We could not check the network just now', { timeout: 25_000 });
  await expect(banner).toContainText('getGenesisHash: no answer after 10 s');
  await banner.getByRole('button', { name: 'Read again' }).click();
  await expect.poll(() => held, 'Read again asked the network again').toBeGreaterThan(1);
});
