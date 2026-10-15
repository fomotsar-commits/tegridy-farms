import { lazy } from 'react';
import { SectionHost } from './SectionHost';
import { POOLS_SECTION } from '../lib/navConfig';

// Add / remove liquidity on the venue's own Uniswap-V2-fork pairs (TEGRIDY_ROUTER).
const LiquidityPage = lazy(() => import('./LiquidityPage'));
// Solana liquidity: the venue AMM's LP section, behind its live read.
const SolanaLpPage = lazy(() => import('./SolanaLpPage'));
// The venue's Solana AMM: its live status, fee sheet and the same LP section.
const PoolsPage = lazy(() => import('./PoolsPage'));
// One token in, LP position out, as one resumable run.
const ZapPage = lazy(() => import('../components/zap/ZapPage'));

/**
 * Pools, the section for providing liquidity: one tab per way in, from POOLS_SECTION
 * (navConfig.ts). Every tab is its own URL and App.tsx routes each one here.
 */
export default function PoolsHostPage() {
  return (
    <SectionHost
      section={POOLS_SECTION}
      idPrefix="pools"
      ariaLabel="Liquidity sections"
      panels={{
        '/liquidity': LiquidityPage,
        '/solana-lp': SolanaLpPage,
        '/pools': PoolsPage,
        '/zap': ZapPage,
      }}
    />
  );
}
