import { useState, useEffect, useCallback } from 'react';
import { useAccount, useChainId } from 'wagmi';
import { getWalletCapabilities, isAtomicBatchSupported, sendCalls, callsId, type Eip1193Like } from '../lib/eip5792';
import { buildLaunchBuyCalls, type LaunchBuyParams } from '../lib/launcher/launchBuy';
import { isLauncherEnabled } from '../lib/launcher/config';
import { CHAIN_ID } from '../lib/constants';

const CHAIN_HEX = '0x1';

/**
 * One-click launch-buy via EIP-5792 (the legit "bundler" — one signature, one
 * address, fully disclosed; see docs/LAUNCHER_LIQUIDITY_AND_UX_RESEARCH.md Part B).
 * Mirrors `useOneClickStake`: `canBatch` is only true when the launcher rail is live
 * AND the connected wallet advertises atomic-batch support on mainnet, so the UI
 * offers the one-click affordance exclusively when it will work — otherwise the
 * caller keeps the proven sequential approve→buy flow.
 *
 * The `swapCall` inside `params` is produced by the Doppler SDK swap-encoding path
 * (V4 Quoter for min-out + UniversalRouter command build); this hook never hand-rolls
 * V4 calldata. Purely additive; never replaces the existing flow. `canBatch` gates
 * the affordance.
 */
export function useOneClickLaunchBuy() {
  const { address, connector } = useAccount();
  const chainId = useChainId();
  const [canBatch, setCanBatch] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!isLauncherEnabled() || !address || !connector || chainId !== CHAIN_ID) {
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
    return () => {
      cancelled = true;
    };
  }, [address, connector, chainId]);

  /** Submit the approve+buy (or native buy) batch. Throws on gate/rejection/unsupported
   *  so the caller can toast + leave the user on the normal flow. */
  const buyOneClick = useCallback(
    async (params: LaunchBuyParams): Promise<string> => {
      if (!isLauncherEnabled()) throw new Error('The launch rail is not enabled yet.');
      if (!address || !connector) throw new Error('Wallet not connected');
      if (chainId !== CHAIN_ID) throw new Error('Wrong network');
      const provider = (await connector.getProvider()) as Eip1193Like;
      const calls = buildLaunchBuyCalls(params);
      // atomicRequired: the approve + swap MUST land all-or-nothing. Without it, a
      // wallet that supports non-atomic batching could execute the approve without
      // the swap (or vice-versa), leaving a dangling allowance / partial state.
      // `canBatch` already gates the affordance on atomic support, so this only
      // tightens the guarantee — it never routes to an unsupported wallet.
      const res = await sendCalls(provider, {
        from: address,
        chainId: CHAIN_HEX,
        calls,
        atomicRequired: true,
      });
      return callsId(res);
    },
    [address, connector, chainId],
  );

  return { canBatch, buyOneClick };
}
