import { useChainId } from 'wagmi';
import { useSearchParams } from 'react-router-dom';
import { swapVenueOn } from '../lib/chains/swapVenue';

/**
 * The chain the swap form quotes and signs on: `?c=<chainId>` (the network drop-down's
 * pick) wherever it names a chain the swap runs on, else the wallet's chain, as on Pools
 * (useLiquidityChainId) and the curve (useCurveChainId). A wallet left on another network
 * does not move the form: every write useSwap sends names this chain (`chainId`), so wagmi
 * refuses one until the wallet is there, useSwap refuses before asking, and the page shows
 * a switch banner meanwhile.
 */
export function useSwapChainId(): number {
  const walletChainId = useChainId();
  const [params] = useSearchParams();
  const asked = Number(params.get('c'));
  return Number.isInteger(asked) && swapVenueOn(asked) !== null ? asked : walletChainId;
}
