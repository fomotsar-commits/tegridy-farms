import { lazy } from 'react';
import { SectionHost } from './SectionHost';
import { POOLS_SECTION } from '../lib/navConfig';

// Add / remove liquidity against the venue's own Uniswap-V2-fork factory and
// router (TEGRIDY_FACTORY / TEGRIDY_ROUTER, both deployed on mainnet). This was
// `LiquidityTab` — the SECOND OF SIX inner tabs on TradePage — and it is the
// only working token-LP form in the app. It is a page now.
const LiquidityPage = lazy(() => import('./LiquidityPage'));
// The venue's own constant-product AMM on Solana: a live chain probe of what
// state that program is actually in. Deliberately ungated — while the program
// is undeployed the page reports that rather than rendering an empty market.
const PoolsPage = lazy(() => import('./PoolsPage'));
// One-token entry: swap → add liquidity → stake, as one resumable run. Lives
// under components/ because the page and its panel are one feature — see its
// own header note.
const ZapPage = lazy(() => import('../components/zap/ZapPage'));

/**
 * PoolsHostPage — liquidity as its own section, 2026-09-05.
 *
 * THE BUG THIS FIXES IS AN IA BUG, and it is worth stating plainly because the
 * code it replaces was not broken. Providing liquidity was reachable at
 * `/swap?tab=liquidity`: the second of six tabs on the trading page, behind a
 * top-bar word ("Trade") that did not mention it. `/liquidity` existed as a path
 * alias that fell through to the same host. So the only way to find the venue's
 * LP surface was to open the swap page and read its tab bar — and the venue's
 * own pool card compounded it, offering "View all pools →" and landing the
 * visitor on that single-pair form rather than on any list of pools.
 *
 * The operator's brief: "the platform is not friendly for LPing today. This
 * needs to change to attract new wallets that hold a lot of assets… it deserves
 * its own section, not just a tab."
 *
 * WHAT THE THREE TABS ARE, AND WHY THEY ARE SIBLINGS. They are three ways into
 * the same job at three levels of involvement, which is exactly what a tab strip
 * is for:
 *   · Add / Remove — both sides, manual, full control. The venue's own pairs.
 *   · Venue AMM    — the second venue, on Solana, and its live status.
 *   · Zap          — one token in, position out, for someone who does not want
 *                    to think about ratios.
 *
 * /zap is in the nav for the first time here. It was routed, built, and linked
 * from NOWHERE — no nav entry, no footer row, no page pointed at it — which is
 * the same class of defect as burying the LP form in a tab, one step worse.
 */
export default function PoolsHostPage() {
  return (
    <SectionHost
      section={POOLS_SECTION}
      idPrefix="pools"
      ariaLabel="Liquidity sections"
      panels={{
        '/liquidity': LiquidityPage,
        '/pools': PoolsPage,
        '/zap': ZapPage,
      }}
    />
  );
}
