import { lazy } from 'react';
import { SectionHost } from './SectionHost';
import { SWAP_SECTION } from '../lib/navConfig';

// The Ethereum swap surface. Also answers /liquidity, which it treats as a
// synonym for its own `?tab=liquidity` — see resolveInitialTab in TradePage.
const TradePage = lazy(() => import('./TradePage'));
// The Jupiter surface. Same venue, second chain.
const SolanaSwapPage = lazy(() => import('./SolanaSwapPage'));

/**
 * TradeHostPage — the Swap section: two chains, one strip.
 *
 * 🔻 IT LOST A TAB ON 2026-09-05, and that is the point of the change. The strip
 * used to read Ethereum / Solana Swap / Liquidity Pools, because /pools — the
 * venue's own Solana AMM — had nowhere else to live and would otherwise have
 * been orphaned. It has somewhere now: Pools is its own top-level section
 * (PoolsHostPage), so a liquidity surface is no longer filed under trading.
 *
 * THE SECTION IS THE STRIP, with nothing composed at render. This file used to
 * build `[{to:'/swap'}, ...TRADE_SECTION.items]` in a useMemo because
 * PRIMARY_NAV was a hand-written list that owned '/swap' and ALL_NAV asserted no
 * path appeared twice. PRIMARY_NAV is derived from the sections now, so '/swap'
 * simply lives in `items` where it belongs and this host renders the section as
 * it is.
 *
 * ORDER IS FIXED, NOT KEYED TO TRADE_ROUTE. TRADE_ROUTE decides which surface a
 * Solana bungalow LANDS on; it must not reshuffle the strip underneath someone,
 * because a tab that moves between visits is worse than one that is not first.
 * SectionHost derives the active tab from the URL, so landing is already right.
 *
 * ChainSwitch stays on both swap pages. It carries the `?out=` token context and
 * the bungalow's own symbol across the hop, which a route tab does not, so the
 * two are not duplicates of each other — the strip says where you can go, the
 * switch carries what you were doing there.
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
