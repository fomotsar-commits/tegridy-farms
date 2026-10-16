import { useLocation } from 'react-router-dom';
import { ChainPicker } from '../layout/ChainPicker';
import { SWAP_SECTION } from '../../lib/navConfig';
import { useSectionChain } from '../../hooks/useSectionChain';

/**
 * Swap's network drop-down, at the top of each swap page (the section draws no tab strip:
 * TradeHostPage.tsx). Ethereum is `/swap`, Solana is `/solana` (our own pools or Jupiter); Base
 * and Robinhood Chain are listed, greyed, because the swap stack trades on mainnet only
 * (registry `ammSwap`). The network is the page's: `/swap` lights Ethereum and `/solana` Solana.
 * The name stays ChainSwitch so every page and test that mounts it keeps working.
 */
const NOTES = { ethereum: 'Uniswap / CoW', solana: 'Our pools + Jupiter' } as const;

export function ChainSwitch() {
  const { pathname } = useLocation();
  const items = SWAP_SECTION.items;
  const active = items.find((i) => pathname === i.to || pathname.startsWith(`${i.to}/`))?.to ?? items[0]?.to ?? '/swap';
  const network = useSectionChain(items, active, { notes: NOTES, missing: 'No swap here' });
  return (
    <div className="relative z-30 mb-4">
      <ChainPicker label="Swap network" active={network.active} options={network.options} onPick={network.pick} />
    </div>
  );
}
