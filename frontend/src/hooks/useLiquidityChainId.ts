import { useAccount, useChainId } from 'wagmi';
import { useSearchParams } from 'react-router-dom';
import { liquidityVenueOn } from '../lib/chains/liquidityVenue';

/**
 * The chain the add / remove form shows. A connected wallet's chain, always: every write is
 * signed there, so nothing in the URL can point a write at another chain. With no wallet,
 * `?c=<chainId>` (the network drop-down's pick) chooses which venue is read, where one is
 * deployed; anything else falls back to wagmi's default chain, as before.
 */
export function useLiquidityChainId(): number {
  const { isConnected } = useAccount();
  const walletChainId = useChainId();
  const [params] = useSearchParams();
  if (isConnected) return walletChainId;
  const asked = Number(params.get('c'));
  return Number.isInteger(asked) && liquidityVenueOn(asked) !== null ? asked : walletChainId;
}
