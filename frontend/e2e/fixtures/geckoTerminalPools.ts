import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Page } from '@playwright/test';

// DETERMINISM FOR THE TERMINAL'S MARKET FEED.
//
// /terminal reads GeckoTerminal BROWSER-DIRECT, on purpose (see
// src/hooks/useMarketFeed.ts). That is right for production and impossible for
// an audit: the keyless API refuses roughly the fifth rapid read from one
// address, so an unstubbed sweep would audit a rate-limit banner on some runs
// and a full table on others — and would report the difference as an a11y
// regression.
//
// THE BODIES ARE REAL CAPTURES, not hand-written objects. They are the same
// trimmed fixtures src/lib/geckoTerminal/fixtures/ holds, taken live on
// 2026-09-02. A hand-written fixture only ever proves the page agrees with
// whoever wrote the fixture; these carry the things nobody would invent — a
// Uniswap v4 entry whose pool identifier is a 32-byte pool id rather than an
// address, and a live pool quoting a NEGATIVE `reserve_in_usd`.

const FIXTURE_DIR = resolve(process.cwd(), 'src/lib/geckoTerminal/fixtures');

function body(name: string): string {
  return readFileSync(resolve(FIXTURE_DIR, name), 'utf8');
}

/** Which capture answers which upstream path. */
const ROUTES: ReadonlyArray<{ match: RegExp; file: string }> = [
  { match: /\/networks\/eth\/new_pools/, file: 'eth_new_pools.json' },
  // The eth capture stands in for eth/trending: identical item shape, and this
  // fixture exists to make the PAGE deterministic, not to re-test the parser
  // (src/lib/geckoTerminal/pools.test.ts owns that, per network).
  { match: /\/networks\/eth\/trending_pools/, file: 'eth_new_pools.json' },
  { match: /\/networks\/base\/(new|trending)_pools/, file: 'base_trending_pools.json' },
  { match: /\/networks\/solana\/(new|trending)_pools/, file: 'solana_trending_pools.json' },
  { match: /\/networks\/eth\/pools\/multi\//, file: 'eth_pools_multi.json' },
];

const GECKO_GLOB = 'https://api.geckoterminal.com/**';

/**
 * Answer every GeckoTerminal request from a captured body.
 *
 * A path with no capture is answered `{"data": []}` rather than left to reach
 * the network: an unmatched route that fell through would make the audit
 * non-deterministic in exactly the way this module exists to prevent, and the
 * page renders an upstream zero as its own clearly-worded state.
 */
export async function stubGeckoTerminal(page: Page): Promise<void> {
  await page.route(GECKO_GLOB, async (route) => {
    const url = route.request().url();
    const hit = ROUTES.find((r) => r.match.test(url));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: hit ? body(hit.file) : '{"data":[]}',
    });
  });
}

/**
 * Make every GeckoTerminal read answer 429, with the REAL refusal body.
 *
 * The body has no `data` key at all, which is why the reader checks the status
 * code before it parses — a schema-first reader would call this "malformed",
 * and a careless one would call it zero pools.
 */
export async function stubGeckoTerminalRateLimited(page: Page): Promise<void> {
  await page.route(GECKO_GLOB, async (route) => {
    await route.fulfill({
      status: 429,
      contentType: 'application/json',
      body: body('rate_limited_429.json'),
    });
  });
}

/**
 * Make every GeckoTerminal read answer 200 with no pools.
 *
 * The upstream's own answer for a window — a real, if narrow, fact, and the
 * state that must NOT look like the refusal above.
 */
export async function stubGeckoTerminalEmpty(page: Page): Promise<void> {
  await page.route(GECKO_GLOB, async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"data":[]}' });
  });
}
