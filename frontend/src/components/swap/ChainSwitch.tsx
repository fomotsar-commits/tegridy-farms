import { useLocation } from 'react-router-dom';
import { ChainPicker } from '../layout/ChainPicker';
import { SWAP_SECTION } from '../../lib/navConfig';
import { useSectionChain } from '../../hooks/useSectionChain';

/**
 * Swap's network drop-down, at the top of each swap page (the section draws no tab strip:
 * TradeHostPage.tsx). Ethereum, Base and Robinhood Chain are `/swap` (`?c=` picks the chain;
 * our pools or Uniswap V2, whichever pays more), Solana is `/solana` (our own pools or Jupiter).
 * The network is the page's: `/swap` lights its own chain and `/solana` Solana.
 * The name stays ChainSwitch so every page and test that mounts it keeps working.
 *
 * `at`: a card that is a swap page's form away from its page (the home's swap card is
 * `/solana`'s), so the drop-down lights that page's network and a pick leaves for the
 * network's own swap page. Drawn bare, for the card's header row.
 */
const NOTES = { ethereum: 'Uniswap / CoW', base: 'Our pools + Uniswap', robinhood: 'Our pools + Uniswap', solana: 'Our pools + Jupiter' } as const;

export function ChainSwitch({ at }: { at?: string } = {}) {
  const { pathname } = useLocation();
  const items = SWAP_SECTION.items;
  const active = at ?? items.find((i) => pathname === i.to || pathname.startsWith(`${i.to}/`))?.to ?? items[0]?.to ?? '/swap';
  const network = useSectionChain(items, active, { notes: NOTES, missing: 'No swap here' });
  const picker = <ChainPicker label="Swap network" active={network.active} options={network.options} onPick={network.pick} />;
  if (at) return picker;
  return <div className="relative z-30 mb-4">{picker}</div>;
}
