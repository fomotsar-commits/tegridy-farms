import { useChainId } from 'wagmi';
import { useSearchParams } from 'react-router-dom';
import { liquidityVenueOn } from '../lib/chains/liquidityVenue';

/**
 * The chain the add / remove page shows: `?c=<chainId>` (the network drop-down's pick) where
 * it names a deployed venue, else the wallet's chain (wagmi's default with no wallet). The pick
 * wins over a connected wallet, as on the curve (useCurveChainId): a wallet that does not
 * switch left the menu and the pool list on its own network, so a pick of Base showed
 * Ethereum's pools. The wallet cannot be pointed at another chain by this: every write the
 * form sends names this chain (useAddLiquidity), so wagmi refuses it until the wallet is
 * there, and the page shows a switch banner meanwhile.
 */
export function useLiquidityChainId(): number {
  const walletChainId = useChainId();
  const [params] = useSearchParams();
  const asked = Number(params.get('c'));
  return Number.isInteger(asked) && liquidityVenueOn(asked) !== null ? asked : walletChainId;
}
