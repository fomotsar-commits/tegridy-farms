import { useCallback, useEffect, useRef, useState } from 'react';
import { erc20Abi } from 'viem';
import { useAccount, useChainId, usePublicClient, useSendTransaction, useSwitchChain } from 'wagmi';
import { HYPEREVM_CHAIN_ID, type HyperEvmToken, type HyperEvmVenue } from '../../lib/chains/hyperEvm';
import { readPools, type HyperEvmReader, type V3Pool } from '../../lib/hyperevm/pools';
import { isUserRejection, extractErrorMessage, waitForReceiptOutcome } from '../../lib/txErrors';

/** The chain-999 client the HyperEVM screens read through (null only while HyperEVM is hidden). */
export function useHyperEvmClient() {
  return usePublicClient({ chainId: HYPEREVM_CHAIN_ID });
}

export function asReader(client: unknown): HyperEvmReader {
  return client as HyperEvmReader;
}

export type PoolsState = { status: 'loading' } | { status: 'ready'; pools: V3Pool[] } | { status: 'unread' };

/** Our pools, read on mount and every 30 s, and again when `reload` is called. */
export function usePools(venue: HyperEvmVenue) {
  const client = useHyperEvmClient();
  const [state, setState] = useState<PoolsState>({ status: 'loading' });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!client) return;
    let live = true;
    void readPools(asReader(client), venue).then((r) => {
      if (!live) return;
      // A failed re-read keeps the last good list on screen rather than blanking it.
      setState((prev) => (r.ok ? { status: 'ready', pools: r.pools } : prev.status === 'ready' ? prev : { status: 'unread' }));
    });
    const t = setTimeout(() => setTick((n) => n + 1), 30_000);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [client, venue, tick]);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { state, reload };
}

/** A wallet's balance of one listed coin on HyperEVM; null while unread. */
export function useBalance(token: HyperEvmToken | null, owner: `0x${string}` | undefined, refresh: number) {
  const client = useHyperEvmClient();
  const [balance, setBalance] = useState<bigint | null>(null);
  useEffect(() => {
    if (!client || !token || !owner) {
      setBalance(null);
      return;
    }
    let live = true;
    const read = token.isNative
      ? client.getBalance({ address: owner })
      : client.readContract({ address: token.address, abi: erc20Abi, functionName: 'balanceOf', args: [owner] });
    read.then((b) => live && setBalance(b), () => live && setBalance(null));
    return () => {
      live = false;
    };
  }, [client, token, owner, refresh]);
  return balance;
}

export type SendState =
  | { kind: 'idle' }
  | { kind: 'wallet'; step: string }
  | { kind: 'mining'; step: string; hash: `0x${string}` }
  | { kind: 'done'; hash: `0x${string}` }
  | { kind: 'failed'; message: string; hash?: `0x${string}` };

/**
 * Sends HyperEVM transactions one at a time and waits for each receipt (txErrors.ts's wait, the
 * one every direct caller uses). A step that does not land stops the run: nothing after it is sent.
 */
export function useHyperEvmSend() {
  const client = useHyperEvmClient();
  const { address, isConnected } = useAccount();
  const walletChainId = useChainId();
  const { switchChainAsync } = useSwitchChain();
  const { sendTransactionAsync } = useSendTransaction();
  const [state, setState] = useState<SendState>({ kind: 'idle' });
  const busy = useRef(false);

  const onChain = isConnected && walletChainId === HYPEREVM_CHAIN_ID;
  const switchToHyperEvm = useCallback(async () => {
    try {
      await switchChainAsync({ chainId: HYPEREVM_CHAIN_ID });
    } catch (e) {
      setState({ kind: 'failed', message: isUserRejection(e) ? 'Your wallet did not switch to HyperEVM.' : `Your wallet could not switch to HyperEVM: ${extractErrorMessage(e)}` });
    }
  }, [switchChainAsync]);

  /** Each step builds its transaction when its turn comes, so a later step can read what an earlier one did. */
  const run = useCallback(
    async (steps: { label: string; tx: () => Promise<{ to: `0x${string}`; data: `0x${string}`; value: bigint } | null> }[]): Promise<boolean> => {
      if (busy.current || !client || !address) return false;
      busy.current = true;
      try {
        let last: `0x${string}` | undefined;
        for (const step of steps) {
          setState({ kind: 'wallet', step: step.label });
          const tx = await step.tx();
          if (!tx) continue;
          const hash = await sendTransactionAsync({ chainId: HYPEREVM_CHAIN_ID, to: tx.to, data: tx.data, value: tx.value });
          last = hash;
          setState({ kind: 'mining', step: step.label, hash });
          const outcome = await waitForReceiptOutcome(client, hash);
          if (outcome.kind !== 'success') {
            const why = outcome.kind === 'reverted' ? 'was refused on chain' : outcome.kind === 'replaced' ? 'was replaced in your wallet' : 'could not be confirmed yet';
            setState({ kind: 'failed', message: `${step.label} ${why}. Nothing after it was sent.`, hash });
            return false;
          }
        }
        if (last) setState({ kind: 'done', hash: last });
        else setState({ kind: 'idle' });
        return true;
      } catch (e) {
        setState({ kind: 'failed', message: isUserRejection(e) ? 'You declined in your wallet. Nothing was sent.' : extractErrorMessage(e, 'The wallet did not send it.') });
        return false;
      } finally {
        busy.current = false;
      }
    },
    [client, address, sendTransactionAsync],
  );

  const reset = useCallback(() => setState({ kind: 'idle' }), []);
  return { state, run, reset, onChain, switchToHyperEvm, address, isConnected };
}
