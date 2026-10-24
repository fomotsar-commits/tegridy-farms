import { useChainId } from 'wagmi';
import { useSearchParams } from 'react-router-dom';
import { CHAIN_ID } from '../lib/constants';
import { curveLauncherOn } from '../lib/launcher/curve';

/**
 * The chain the Memetics curve page shows: `?c=<chainId>` when it names a deployed launcher,
 * else the wallet's chain when it has one, else mainnet (a disconnected wallet resolves to
 * mainnet too). One rule for the page and for the network drop-down above it, so the two
 * cannot disagree. `?c=` is visitor input: a chain we do not serve, or garbage (NaN, or 0 from
 * ''), falls back to the seed.
 */
export function useCurveChainId(): number {
  const walletChainId = useChainId();
  const [searchParams] = useSearchParams();
  const seededChainId = curveLauncherOn(walletChainId).status === 'deployed' ? walletChainId : CHAIN_ID;
  const requestedChainId = Number(searchParams.get('c'));
  const pickedChainId =
    Number.isInteger(requestedChainId) && curveLauncherOn(requestedChainId).status === 'deployed'
      ? requestedChainId
      : null;
  return pickedChainId ?? seededChainId;
}
