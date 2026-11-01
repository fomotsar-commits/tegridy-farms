// Island answer twenty-four, build 1b: one price loop for everyone. A /pools tab left for a
// minute asks /api/jupiter for nothing: every listed token's outside price comes from the
// shared list (api/outside-prices.js), which this test answers itself. Against the trunk of
// 2026-11-01 the same tab made two Jupiter quotes per pool through /api/jupiter in its first
// minute (the island counted 12), so this count was red first.
//
// The pool index is answered with the venue's eighteen pools as the live index listed them on
// 2026-11-01; the pools themselves are read from mainnet through the preview's /api/solrpc
// proxy, as the other pools specs read it. The list answers "no route" for every token, so no
// price is compared and the Arbitrage card has no gap to re-quote: what is counted is the
// price check alone.
import { test, expect } from '@playwright/test';
import { gotoRoute } from './fixtures/routes';

test.use({ serviceWorkers: 'block' });

const PROGRAM = 'EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT';
const POOLS = [
  'ErvzV1NMZmcfAqZtGH4AQhYAjn77nJEworKK1mYPz5w4', '3YRW6wJscukRaWutB6QgPwtK1EQM9KA7CXcXTtmN3GJK', '9mHGFULXNFjcdkZ9fLy24A3pp4iYVk6y889NNcUvSgRV',
  'CvAVyjZk1A4hLuNDvEseCYHAn98mU1f4mKpveGvAM2UC', '3yDDaZtABgj7z4BNtPKpfnK4yrx5bvEphDXYGGTnTmfA', '5M4SZy9Ytu1LGWWjBUwiDZ98bGdpQL4fD3PHETEXPAN8',
  'H8TVzALWtq9CJDfnkKtgnfjNcRXUShvxYArwmBfj7Kkd', 'raEFEHUYRBYVSJ5jiu5KLm2BQeVCNS5g8W7YoAJVYBd', 'rD73MYkgDq7RKDxaJMFmiBu1feCAg2hQKHnVucZ5cZH',
  'Hb6naTh2QFrRioeAhNToFEPgKaN1iiyDzGacYi1c7gm1', '3sw9bPyEk29AMkwr2fHeQiyKiptNkUgfvtY8u5QrJdWh', 'HaRnur2ETP44bFtjUU4haQcFVYrCDTSaJfjKY3E3bDDD',
  'HBGZFvYZnKMsrjn42C9ZbQCKYd5a1NAt4MaXnrKNuMES', '6EESMGsgzDc2N3PaVsue5FizVDvi2ZRuY8j3iPLkrkxs', '8T2ErLrntFdGMZaVHXNqX6z96Ay1qh5xGMm67mVeGrgB',
  'H3ruuiAi2Z4kq51YaRjKFUDDh3wHwNLQF64QeDnA88Gp', 'J35mQ6UF9PpB6bQMes2TRVUMbJVPwMYjcfapbkdm8mYm', 'G23uSnADCtgMdRfBdRhYj3JRVL9Ky9GEVdyy7jK9ughx',
];
/** Every mint in those pools that is not SOL, as the pools held them on 2026-11-01. */
const MINTS = [
  '7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump', 'J9zjM2nn4DBYpFy3qrReaUzY66g4EFMwLa61YSGCpump', '4nV5gNwwP68zUDat26ySChREqVaQaLudfJBkSgEzpump',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', '5ad4puH6yDBoeCcrQfwV5s9bxvPnAeWDoYDj3uLyBS8k', '8zsZESzrGoYVi1dVH4QNWXJ2EfW4v287aEGNiDvQpump',
  'ZBCNpuD7YMXzTHB2fhGkGi78MNsHGLRXUhRewNRm9RU', 'moon3CP11XLvrAxUPBnPtueDEJvmjqAyZwPuq7wBC1y', 'DBEjiLMt9USaM3SdC9YtNcKGnXLdFhzokwnykH4Wpump',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', 'HqyTxEqk7qmLu2Gnx46eEZwQhzCf2yVqRompLaKYpump', '4XKGjKaKowFvL5sYwh2AKx72vj9iwC8MNvpL44E9pump',
  '6Rwcmkz9yiYVM5EzyMcr4JsQPGEAWhcUvLvfBperYnUt', '2Wkip2U5x93mjaAvoq8zaedweP73GgRtbaQhNcwXpump', 'Ep5tnKTSkLDeQ12ctS3RhQNcbcApkcyJcGPgHh4dpump',
];

test('a /pools tab left for a minute asks /api/jupiter for nothing: every listed price comes from the shared list', async ({ page }) => {
  test.skip(test.info().project.name !== 'chromium', 'one count, on the desktop project');
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
  await page.route('**/api/pools**', (r) =>
    r.fulfill({ json: { all: true, program: PROGRAM, pools: POOLS, truncated: false, readAt: Date.now() } }),
  );
  await page.route('**/api/outside-prices**', (r) =>
    r.fulfill({
      json: {
        state: 'ok',
        read_at: Date.now(),
        fresh_for_ms: 600_000,
        probe_lamports: '50000000',
        prices: Object.fromEntries(MINTS.map((m) => [m, { state: 'no-route', read_at: Date.now() }])),
      },
    }),
  );
  const jupiter: string[] = [];
  const list: string[] = [];
  page.on('request', (req) => {
    const url = req.url();
    if (url.includes('/api/jupiter/')) jupiter.push(url);
    if (url.includes('/api/outside-prices')) list.push(url);
  });

  await gotoRoute(page, '/pools');
  // The pools read from mainnet: at least one card on screen before the minute starts.
  await expect(page.getByTestId('lp-pool').first(), 'no pool card read from the chain').toBeVisible({ timeout: 90_000 });
  await page.waitForTimeout(60_000);

  expect(list.length, 'the page never read the shared list').toBeGreaterThan(0);
  expect(jupiter, `the page asked /api/jupiter ${jupiter.length} times in a minute`).toEqual([]);
});
