import { lazy, Suspense } from 'react';
import { useLocation } from 'react-router-dom';
import { PageSkeleton } from '../components/PageSkeleton';
import { SWAP_SECTION } from '../lib/navConfig';

// /swap?tab=liquidity never reaches TradePage: App.tsx's SwapRoute redirects it first.
const TradePage = lazy(() => import('./TradePage'));
const SolanaSwapPage = lazy(() => import('./SolanaSwapPage'));
const CardanoSwapPage = lazy(() => import('./CardanoSwapPage'));

const PANELS: Record<string, typeof TradePage> = { '/swap': TradePage, '/solana': SolanaSwapPage, '/cardano': CardanoSwapPage };

/**
 * The Swap section: Ethereum, Solana, and Cardano once opened. ONE switcher between them, the ChainSwitch in
 * each page's flow (owner, 2026-10-13): this host draws no tab strip, which repeated it
 * and, fixed to the top, covered the form and the review once the page scrolled. The
 * page is picked as SectionHost picks it, so a chain switched off falls to /swap.
 */
export default function TradeHostPage() {
  const { pathname } = useLocation();
  const items = SWAP_SECTION.items;
  const active = items.find((i) => pathname === i.to || pathname.startsWith(`${i.to}/`))?.to ?? items[0]?.to ?? '/swap';
  const Panel = PANELS[active] ?? TradePage;
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Panel />
    </Suspense>
  );
}
