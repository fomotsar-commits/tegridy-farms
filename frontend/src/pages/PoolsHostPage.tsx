import { lazy } from 'react';
import { SectionHost } from './SectionHost';
import { POOLS_SECTION } from '../lib/navConfig';

// Add / remove liquidity on the venue's own Uniswap-V2-fork pairs (TEGRIDY_ROUTER).
const LiquidityPage = lazy(() => import('./LiquidityPage'));
// The venue's Solana AMM: its LP section (find a pool, add, remove, open one) and live status.
const PoolsPage = lazy(() => import('./PoolsPage'));
// The Range tab: liquidity between two prices, in the venue's own range program.
const RangePoolsPage = lazy(() => import('./RangePoolsPage'));
// One token in, LP position out, as one resumable run.
const ZapPage = lazy(() => import('../components/zap/ZapPage'));

/**
 * Pools, the section for providing liquidity: one tab per way in, from POOLS_SECTION
 * (navConfig.ts). Every tab is its own URL and App.tsx routes each one here. The network
 * drop-down picks Ethereum, Base, Robinhood Chain or Solana and the strip shows that
 * network's tabs (lib/sectionChains.ts).
 */
export default function PoolsHostPage() {
  return (
    <SectionHost
      section={POOLS_SECTION}
      idPrefix="pools"
      ariaLabel="Liquidity sections"
      chains={{ label: 'Pools network', missing: 'No pools here' }}
      panels={{
        '/liquidity': LiquidityPage,
        '/pools': PoolsPage,
        '/range-pools': RangePoolsPage,
        '/zap': ZapPage,
      }}
    />
  );
}
