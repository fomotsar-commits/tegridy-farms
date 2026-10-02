import { lazy } from 'react';
import { SectionHost } from './SectionHost';
import { SWAP_SECTION } from '../lib/navConfig';

// /swap?tab=liquidity never reaches TradePage: App.tsx's SwapRoute redirects it first.
const TradePage = lazy(() => import('./TradePage'));
const SolanaSwapPage = lazy(() => import('./SolanaSwapPage'));

/**
 * The Swap section: Ethereum and Solana, one strip in a fixed order. tradeRoute()
 * picks where a room LANDS; the strip never reorders under it. ChainSwitch on both
 * swap pages repeats the chain choice because it names the room's token and venues.
 */
export default function TradeHostPage() {
  return (
    <SectionHost
      section={SWAP_SECTION}
      idPrefix="trade"
      ariaLabel="Swap destinations"
      panels={{
        '/swap': TradePage,
        '/solana': SolanaSwapPage,
      }}
    />
  );
}
