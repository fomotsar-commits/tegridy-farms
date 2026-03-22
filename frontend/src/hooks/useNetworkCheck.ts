import { useAccount } from 'wagmi';
import { CHAIN_ID } from '../lib/constants';

export function useNetworkCheck() {
  const { chain, isConnected } = useAccount();
  const isWrongNetwork = isConnected && chain?.id !== CHAIN_ID;
  return { isWrongNetwork };
}
