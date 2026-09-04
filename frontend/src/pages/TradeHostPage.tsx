import { lazy, useMemo } from 'react';
import { SectionHost } from './SectionHost';
import { TRADE_SECTION, type NavItem } from '../lib/navConfig';

// The Ethereum swap surface. Also answers /liquidity, which it treats as a
// synonym for its own `?tab=liquidity` — see resolveInitialTab in TradePage.
const TradePage = lazy(() => import('./TradePage'));
// The Jupiter surface. Same venue, second chain.
const SolanaSwapPage = lazy(() => import('./SolanaSwapPage'));
// Liquidity provision on our OWN AMM — a different thing from TradePage's
// "Liquidity" tab, which is Uniswap V2 LP. Deliberately ungated: while the
// program is undeployed the page reports that fact rather than an empty market.
const PoolsPage = lazy(() => import('./PoolsPage'));

/**
 * TradeHostPage — Trade's destinations as one strip, and ZERO dropdown rows.
 *
 * "Trade" is in PRIMARY_NAV at every width. Underneath it the "More" menu also
 * carried a Trade heading with Solana Swap and Liquidity Pools beneath it, so
 * the top bar was repeated in the menu it sits above. The section is now marked
 * `inPrimaryNav` (navConfig.ts): the menu renders nothing for it, and these
 * become tabs on the page the top bar already opens.
 *
 * THE PRIMARY ENTRY IS COMPOSED HERE, NOT STORED IN THE SECTION. PRIMARY_NAV
 * already owns the swap path and ALL_NAV asserts no path appears twice, so
 * putting it in `TRADE_SECTION.items` would red navConfig.test.ts's
 * no-duplicate-paths check. The strip is therefore [primary, ...items], built
 * at render, and `items` stays exactly the two secondary destinations.
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
  const section = useMemo(
    () => ({
      ...TRADE_SECTION,
      items: [
        { to: '/swap', label: 'Trade', tabLabel: 'Ethereum' } as NavItem,
        ...TRADE_SECTION.items,
      ],
    }),
    [],
  );

  return (
    <SectionHost
      section={section}
      idPrefix="trade"
      ariaLabel="Trade destinations"
      panels={{
        '/swap': TradePage,
        '/solana': SolanaSwapPage,
        '/pools': PoolsPage,
      }}
    />
  );
}
