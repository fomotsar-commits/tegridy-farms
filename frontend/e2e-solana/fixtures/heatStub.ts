// Stands in for the island's heat read (/api/aggregator?resource=heat), which vite preview
// does not serve: an unrouted /api answers with the SPA page, the gate reads that as STALE,
// and the create form stays behind a shut door. So every context that should reach the form
// installs this; a spec collapsing onto STALE means the stub is missing.
//
// It answers in the island's own wire shape, reckoned an hour ago, so the reading is fresh.
// Warm (Resident) by default; `set` makes one wallet read other degrees.
import type { BrowserContext, Route } from '@playwright/test';
import { tierFor } from '../../src/lib/heat/heatOracle';

export interface HeatStub {
  /** Every address the page asked the island about, in order. */
  readonly asked: string[];
  /** Answer `address` with `degrees` from now on. */
  set(address: string, degrees: number): void;
}

export async function installHeatStub(context: BrowserContext, defaultDegrees = 95): Promise<HeatStub> {
  const asked: string[] = [];
  const byAddress = new Map<string, number>();
  const isHeat = (url: URL) => url.pathname === '/api/aggregator' && url.searchParams.get('resource') === 'heat';
  await context.route(isHeat, async (route: Route) => {
    const address = new URL(route.request().url()).searchParams.get('address') ?? '';
    asked.push(address);
    const degrees = byAddress.get(address) ?? defaultDegrees;
    const now = Math.floor(Date.now() / 1000);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        address,
        degrees,
        tier: tierFor(degrees),
        is_cold: false,
        held_since_unix: now - 200 * 86_400,
        as_of_unix: now - 3_600,
        token_count: 1,
        breakdown: [
          {
            token_address: '7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump',
            chain: 'solana',
            name: 'BAYLA',
            symbol: 'BAYLA',
            heat_degrees: degrees,
            first_seen_at_unix: now - 200 * 86_400,
            last_transfer_at_unix: null,
          },
        ],
        observedAt: now,
      }),
    });
  });
  return { asked, set: (a, d) => void byAddress.set(a, d) };
}
