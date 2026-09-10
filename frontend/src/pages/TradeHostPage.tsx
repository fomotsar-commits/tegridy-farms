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
 * ⚠️ CHAINSWITCH STAYS ON BOTH SWAP PAGES, AND IT *IS* A SECOND CHAIN SWITCHER.
 * This block used to justify it as "carries the `?out=` token context and the
 * bungalow's own symbol across the hop, which a route tab does not". Half of that
 * was wrong and the record is corrected here rather than quietly rewritten:
 *
 *   · The `?out=` CARRY IS NOT A CARRY. `?out=` is a Solana mint; ChainSwitch's
 *     Ethereum half is a bare `/swap` and nothing in the app produces
 *     `/swap?out=` (the producers are QuickBuyPanel, ScannerPage and
 *     bungalows.ts, all of which link to `/solana?out=`). So the only URL that
 *     ever holds the param is the one whose Solana tab is already active. Moving
 *     that "context" into the strip — the `resolveTarget` shape this was headed
 *     for — would change no URL the app can reach, which is a mechanism with no
 *     effect, and this repo has shipped enough of those.
 *   · THE SUB-LABEL IS REAL. "BAYLA · Jupiter" / "Uniswap / CoW" names the active
 *     bungalow's token and the venues behind each chain, and RouteTabs has no
 *     slot for a second line. Giving it one means re-measuring the 40/44px touch
 *     floor across all nine hosts (e2e/tab-target-size.spec.ts) — a real change,
 *     not a cleanup, and not this one.
 *
 * So the duplication on /swap and /solana is KNOWN and UNRESOLVED, not defended.
 * What was fixed alongside this note is the other half: /pools rendered the same
 * control claiming `aria-current="page"` on /solana while sitting on /pools.
 * ChainSwitch reads the URL itself now, so no page can mislabel itself again.
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
