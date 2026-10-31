import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAccount, useChainId, useSwitchChain } from 'wagmi';
import { toast } from 'sonner';
import type { NavItem } from '../lib/navConfig';
import { BUNGALOWS } from '../lib/bungalows';
import {
  VENUE_CHAINS,
  chainDestination,
  chainHref,
  parseVenueChain,
  sectionHasChain,
  tabChains,
  tabServes,
  venueChain,
  venueChainOfEvm,
  type VenueChain,
} from '../lib/sectionChains';
import type { ChainPickerOption } from '../components/layout/ChainPicker';
import { useActiveBungalowId } from './useActiveBungalowId';
import { useLiquidityChainId } from './useLiquidityChainId';
import { useSwapChainId } from './useSwapChainId';
import { useCurveChainId } from './useCurveChainId';

export interface SectionChainCopy {
  /** Under each network the section serves, e.g. Swap's "Our pools + Jupiter". */
  notes?: Partial<Record<VenueChain, string>>;
  /** Under each network it does not, e.g. "No swap here". */
  missing: string;
}

/**
 * One section's network: which one the visitor is on, the four rows of its drop-down, and
 * where a pick goes. The network is read from the page, never stored: the route for a
 * one-network tab, the page's own chain for the add / remove form and the curve, and `?chain=`
 * (else the room's network) for a tab that names none.
 *
 * A pick goes to that network's tab, and when an EVM wallet is connected on another chain it
 * asks the wallet to switch, as Uniswap's does. With no wallet nothing is switched: the URL
 * carries the network, so a disconnected visitor's other pages stay on mainnet.
 */
export function useSectionChain(items: readonly NavItem[], activeTo: string, copy: SectionChainCopy) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { isConnected } = useAccount();
  const walletChainId = useChainId();
  const { switchChain } = useSwitchChain();
  const liquidityChainId = useLiquidityChainId();
  const swapChainId = useSwapChainId();
  const curveChainId = useCurveChainId();
  const roomId = useActiveBungalowId();

  const chains = tabChains(activeTo);
  let active: VenueChain;
  if (chains === 'any') {
    const asked = parseVenueChain(params.get('chain'));
    const roomChain = BUNGALOWS.find((b) => b.id === roomId)?.chain;
    const room = roomChain === 'tbd' ? null : (roomChain ?? null);
    const served = (c: VenueChain | null): c is VenueChain => c !== null && sectionHasChain(items, activeTo, c);
    active = served(asked) ? asked : served(room) ? room : 'ethereum';
  } else if (chains.length === 1) {
    active = chains[0] ?? 'ethereum';
  } else {
    const evm = activeTo === '/liquidity' ? liquidityChainId
      : activeTo === '/eth-curve' ? curveChainId
      : activeTo === '/swap' ? swapChainId
      : null;
    const read = venueChainOfEvm(evm);
    active = read && chains.includes(read) ? read : (chains[0] ?? 'ethereum');
  }

  const options: ChainPickerOption[] = VENUE_CHAINS.map((c) => {
    const enabled = sectionHasChain(items, activeTo, c.id);
    return { chain: c.id, enabled, note: enabled ? copy.notes?.[c.id] : copy.missing };
  });

  const pick = (chain: VenueChain) => {
    const to = chainDestination(items, activeTo, chain);
    if (!to) return;
    navigate(chainHref(to, chain));
    const evm = venueChain(chain).evmChainId;
    if (evm !== null && tabChains(to) !== 'any' && isConnected && walletChainId !== evm) {
      // Swap and Pools stay on the pick, but cannot sign there until the wallet switches.
      // Say so when it refuses.
      const name = venueChain(chain).name;
      switchChain({ chainId: evm }, {
        onError: () => toast.error(`Your wallet did not switch to ${name}. Switch it in your wallet to use ${name} here.`),
      });
    }
  };

  /** The strip: this network's tabs, plus the visitor's own tab whatever it is. */
  const visibleItems = items.filter((i) => i.to === activeTo || tabServes(i.to, active));

  /** A strip tab's address, carrying the network it was opened from. */
  const tabHref = (to: string) => chainHref(to, active);

  return { active, options, pick, visibleItems, tabHref };
}
