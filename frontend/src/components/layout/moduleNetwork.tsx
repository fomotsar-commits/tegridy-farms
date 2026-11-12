import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useAccount, useChainId, useSwitchChain } from 'wagmi';
import { toast } from 'sonner';
import { ChainPicker, type ChainPickerOption } from './ChainPicker';
import { POOLS_SECTION, SWAP_SECTION } from '../../lib/navConfig';
import { VENUE_CHAINS, sectionHasChain, venueChain, type VenueChain } from '../../lib/sectionChains';

/**
 * A module's own network (owner, 2026-11-11: "when i try to switch chains on swap it takes me to
 * a different page rather than just switching chains on the existing module"). A swap or pools
 * form that sits away from its page (the sheet, a home card) holds its network here: a pick in
 * its drop-down changes the form where it stands and never leaves the page. With no provider a
 * drop-down is a page's, and a pick goes to that network's page as before (useSectionChain).
 */
export type ModuleSection = 'swap' | 'pools';

export interface ModuleNetwork {
  active: VenueChain;
  pick: (chain: VenueChain) => void;
}

const ModuleNetworkContext = createContext<ModuleNetwork | null>(null);

export const useModuleNetwork = (): ModuleNetwork | null => useContext(ModuleNetworkContext);

export function ModuleNetworkProvider({ active, pick, children }: ModuleNetwork & { children: ReactNode }) {
  const value = useMemo(() => ({ active, pick }), [active, pick]);
  return <ModuleNetworkContext.Provider value={value}>{children}</ModuleNetworkContext.Provider>;
}

const SECTIONS = {
  swap: {
    label: 'Swap network',
    items: SWAP_SECTION.items,
    at: '/solana',
    missing: 'No swap here',
    notes: { ethereum: 'Uniswap / CoW', base: 'Our pools + Uniswap', robinhood: 'Our pools + Uniswap', solana: 'Our pools + Jupiter', cardano: 'Minswap pools' } as Partial<Record<VenueChain, string>>,
  },
  pools: { label: 'Pools network', items: POOLS_SECTION.items, at: '/pools', missing: 'No pools here', notes: {} as Partial<Record<VenueChain, string>> },
} as const;

/** Does the venue have this section's form on `chain`? Read from the same registry the pages read. */
export function moduleServes(section: ModuleSection, chain: VenueChain): boolean {
  const s = SECTIONS[section];
  return sectionHasChain(s.items, s.at, chain);
}

/** The network a module opens on: the one asked for when the section has a form there, else Solana, else the first it has. */
export function moduleNetworkOr(section: ModuleSection, asked: VenueChain | null | undefined): VenueChain {
  if (asked && moduleServes(section, asked)) return asked;
  return VENUE_CHAINS.find((c) => moduleServes(section, c.id))?.id ?? 'solana';
}

/**
 * The drop-down of a module that holds its own network. A pick changes the module in place; where
 * an EVM wallet is connected on another chain it is asked to switch, as the pages' drop-down asks.
 */
export function ModuleNetworkPicker({ section, align }: { section: ModuleSection; align?: 'start' | 'end' }) {
  const mod = useModuleNetwork();
  const { isConnected } = useAccount();
  const walletChainId = useChainId();
  const { switchChain } = useSwitchChain();
  if (!mod) return null;
  const s = SECTIONS[section];
  const options: ChainPickerOption[] = VENUE_CHAINS.map((c) => {
    const enabled = moduleServes(section, c.id);
    return { chain: c.id, enabled, note: enabled ? s.notes[c.id] : s.missing };
  });
  const onPick = (chain: VenueChain) => {
    if (!moduleServes(section, chain)) return;
    mod.pick(chain);
    const info = venueChain(chain);
    if (info.evmChainId !== null && isConnected && walletChainId !== info.evmChainId) {
      switchChain(
        { chainId: info.evmChainId },
        { onError: () => toast.error(`Your wallet did not switch to ${info.name}. Switch it in your wallet to use ${info.name} here.`) },
      );
    }
  };
  return <ChainPicker label={s.label} active={mod.active} options={options} onPick={onPick} align={align} />;
}
