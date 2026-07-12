import { useState, useEffect, useCallback } from 'react';
import { useAccount, useChainId } from 'wagmi';
import { getWalletCapabilities, isAtomicBatchSupported, sendCalls, type Eip1193Like } from '../lib/eip5792';
import { buildApproveStakeCalls } from '../lib/stakeBatch';
import { CHAIN_ID } from '../lib/constants';

const CHAIN_HEX = '0x1';

/**
 * One-click "approve + stake" via EIP-5792 (#8). `canBatch` is only true when the
 * connected wallet advertises atomic-batch support on mainnet, so the UI offers
 * the one-click path exclusively when it will work — otherwise the caller keeps
 * using the proven sequential approve→stake flow.
 *
 * NOTE: the atomic-execution path needs live-wallet QA (a smart-account / 7702
 * wallet must actually sign the batch). This hook is purely additive and never
 * replaces the existing flow; `canBatch` gates the affordance.
 */
export function useOneClickStake() {
  const { address, connector } = useAccount();
  const chainId = useChainId();
  const [canBatch, setCanBatch] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!address || !connector || chainId !== CHAIN_ID) {
      setCanBatch(false);
      return;
    }
    (async () => {
      try {
        const provider = (await connector.getProvider()) as Eip1193Like;
        const caps = await getWalletCapabilities(provider, address);
        if (!cancelled) setCanBatch(isAtomicBatchSupported(caps, CHAIN_HEX));
      } catch {
        // Wallet doesn't implement wallet_getCapabilities → no one-click; the
        // sequential flow remains the path.
        if (!cancelled) setCanBatch(false);
      }
    })();
    return () => { cancelled = true; };
  }, [address, connector, chainId]);

  /** Submit the approve+stake batch. Throws on rejection/unsupported so the
   *  caller can toast + leave the user on the normal flow. */
  const stakeOneClick = useCallback(
    async (amountWei: bigint, lockDurationSeconds: bigint): Promise<string> => {
      if (!address || !connector) throw new Error('Wallet not connected');
      if (chainId !== CHAIN_ID) throw new Error('Wrong network');
      const provider = (await connector.getProvider()) as Eip1193Like;
      const calls = buildApproveStakeCalls(amountWei, lockDurationSeconds);
      const id = await sendCalls(provider, { from: address, chainId: CHAIN_HEX, calls });
      return String(id);
    },
    [address, connector, chainId],
  );

  return { canBatch, stakeOneClick };
}
