import { useAccount, useChainId } from 'wagmi';
import { useSearchParams } from 'react-router-dom';
import { swapVenueOn } from '../lib/chains/swapVenue';

/**
 * The chain the swap form quotes and signs on. The same rule as useLiquidityChainId:
 * a connected wallet's chain, always, because every write is signed there and nothing
 * in the URL may point a write at another chain. With no wallet, `?c=<chainId>` (the
 * network drop-down's pick) chooses which chain's pools are quoted, where the swap
 * runs; anything else falls back to wagmi's default chain.
 */
export function useSwapChainId(): number {
  const { isConnected } = useAccount();
  const walletChainId = useChainId();
  const [params] = useSearchParams();
  if (isConnected) return walletChainId;
  const asked = Number(params.get('c'));
  return Number.isInteger(asked) && swapVenueOn(asked) !== null ? asked : walletChainId;
}
