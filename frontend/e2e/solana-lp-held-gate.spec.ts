// /solana-lp on the production build, with the LP gate's network read held open and
// never answered. Every other read lands, so the LP section is up. The gate must close
// as unread when the wait is over and say so, ask again by itself, and take the banner
// down when the network answers.
import type { Route } from '@playwright/test';
import { test, expect } from './fixtures/wallet';
import { gotoRoute } from './fixtures/routes';
import { playLiveVenue } from './fixtures/playedVenue';

test('/solana-lp with the gate read never answered: the page says so after its 20 seconds, asks again by itself, and takes the banner down when the network answers', async ({ page, walletMock: _w }) => {
  test.skip(test.info().project.name !== 'chromium', 'the same transport on every device');
  test.slow();
  await playLiveVenue(page, { gateOpen: true });
  // Registered last, so asked first: the gate's read is held, the rest fall through.
  const held: Route[] = [];
  let holding = true;
  await page.route('**/api/solrpc', (route) => {
    let body: { method?: unknown } | null = null;
    try { body = route.request().postDataJSON() as { method?: unknown } | null; } catch { /* not JSON: not the gate's */ }
    if (body?.method !== 'getGenesisHash' || !holding) return route.fallback();
    held.push(route); // not fulfilled and not aborted until the hold is lifted
  });

  await gotoRoute(page, '/solana-lp');
  await expect(page.getByTestId('lp-finder'), 'the LP section did not mount on the played venue').toBeVisible({ timeout: 20_000 });
  await expect.poll(() => held.length, 'the LP gate asked which network this is').toBe(1);
  const banner = page.getByTestId('lp-gate-banner');
  await expect(banner, 'nothing is said while the answer may still come').toHaveCount(0);

  // One clock on this read: the LP page's 20 seconds (readFetch.ts). The transport's own
  // 10 seconds are for a read with no clock, and its sentence must not be the one shown.
  await expect(banner).toContainText('We could not check the network just now', { timeout: 40_000 });
  await expect(banner).toContainText('Could not read which network this is: the chain did not answer in 20 seconds');
  await expect(banner).not.toContainText('no answer after');

  // Asked again 15 seconds after the failed read landed, with nothing pressed. The
  // banner stays while the page waits for that answer.
  await expect.poll(() => held.length, { message: 'the gate was asked again by itself', timeout: 30_000 }).toBe(2);
  await expect(banner).toContainText('We could not check the network just now');
  // A press asks again too.
  await banner.getByRole('button', { name: 'Read again' }).click();
  await expect.poll(() => held.length, 'Read again asked the network again').toBe(3);

  // The network answers: the gate opens and the banner comes down.
  holding = false;
  await Promise.all(held.map((route) => route.fallback().catch(() => undefined)));
  await expect(banner, 'the banner stayed up after the network answered').toHaveCount(0, { timeout: 15_000 });
});
