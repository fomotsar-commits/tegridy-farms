import { useLocation } from 'react-router-dom';
import { ChainPicker } from '../layout/ChainPicker';
import { SWAP_SECTION } from '../../lib/navConfig';
import { useSectionChain } from '../../hooks/useSectionChain';
import { ModuleNetworkPicker, useModuleNetwork } from '../layout/moduleNetwork';

/**
 * Swap's network drop-down, at the top of each swap page (the section draws no tab strip:
 * TradeHostPage.tsx). Ethereum, Base and Robinhood Chain are `/swap` (`?c=` picks the chain;
 * our pools or Uniswap V2, whichever pays more), Solana is `/solana` (our own pools or Jupiter),
 * Cardano is `/cardano` (Minswap V2 pools) once opened.
 * The network is the page's: `/swap` lights its own chain and `/solana` Solana.
 * The name stays ChainSwitch so every page and test that mounts it keeps working.
 *
 * `at`: a card that is a swap page's form away from its page (the home's swap card is
 * `/solana`'s), so the drop-down lights that page's network and a pick leaves for the
 * network's own swap page. Drawn bare, for the card's header row (and the Buy sheet's Back row).
 * Inside a module that holds its own network (the sheet, a home card: layout/moduleNetwork.tsx) a pick changes
 * the form in place and leaves nothing.
 * `align`: 'end' opens the list from the button's right edge, for a drop-down at the screen's right.
 */
const NOTES = { ethereum: 'Uniswap / CoW', base: 'Our pools + Uniswap', robinhood: 'Our pools + Uniswap', solana: 'Our pools + Jupiter', cardano: 'Minswap pools' } as const;

export function ChainSwitch({ at, align }: { at?: string; align?: 'start' | 'end' } = {}) {
  const { pathname } = useLocation();
  const items = SWAP_SECTION.items;
  const active = at ?? items.find((i) => pathname === i.to || pathname.startsWith(`${i.to}/`))?.to ?? items[0]?.to ?? '/swap';
  const network = useSectionChain(items, active, { notes: NOTES, missing: 'No swap here' });
  const mod = useModuleNetwork();
  if (at && mod) return <ModuleNetworkPicker section="swap" align={align} />;
  const picker = <ChainPicker label="Swap network" active={network.active} options={network.options} onPick={network.pick} align={align} />;
  if (at) return picker;
  return <div className="relative z-30 mb-4">{picker}</div>;
}
