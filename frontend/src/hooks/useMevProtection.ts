import { useCallback, useState } from 'react';
import { useAccount } from 'wagmi';
import { toast } from 'sonner';
import {
  buildMevBlockerChainParams,
  isUserRejection,
  MEV_BLOCKER_FAST_RPC,
} from '../lib/mevProtection';

export type MevProtectionStatus = 'idle' | 'pending' | 'added' | 'manual';

interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

function hasRequest(p: unknown): p is Eip1193Provider {
  return typeof p === 'object' && p !== null && typeof (p as { request?: unknown }).request === 'function';
}

/**
 * Lets a connected user route their Ethereum-mainnet RPC through the MEV Blocker
 * protected endpoint (one-time, user-confirmed via EIP-3085). On wallets that
 * refuse a programmatic add for the default mainnet chain, we surface honest
 * manual instructions instead of failing silently.
 *
 * `status`:
 *   'idle'    — not attempted (or the user cancelled)
 *   'pending' — wallet prompt open
 *   'added'   — wallet accepted the protected RPC
 *   'manual'  — wallet refused the one-tap add; show manual setup details
 */
export function useMevProtection() {
  const { connector, isConnected } = useAccount();
  const [status, setStatus] = useState<MevProtectionStatus>('idle');

  const enable = useCallback(async () => {
    if (!isConnected || !connector) {
      toast.error('Connect a wallet first');
      return;
    }
    setStatus('pending');
    try {
      const provider = await connector.getProvider();
      if (!hasRequest(provider)) throw new Error('Wallet has no EIP-1193 provider');
      await provider.request({
        method: 'wallet_addEthereumChain',
        params: [buildMevBlockerChainParams()],
      });
      setStatus('added');
      toast.success('MEV protection added', {
        description:
          'Select the "Ethereum (MEV Blocker)" network in your wallet to route transactions through the protected RPC.',
        duration: 9000,
      });
    } catch (err) {
      if (isUserRejection(err)) {
        setStatus('idle');
        return;
      }
      // Some wallets refuse a programmatic add for the default mainnet chain.
      // Fall back to honest manual instructions rather than a dead-end error.
      setStatus('manual');
      toast.info('Add the protected RPC manually', {
        description: `Your wallet declined the one-tap add. In its network settings, add the RPC ${MEV_BLOCKER_FAST_RPC} for Ethereum (chain id 1).`,
        duration: 11000,
      });
    }
  }, [connector, isConnected]);

  return { status, enable };
}
