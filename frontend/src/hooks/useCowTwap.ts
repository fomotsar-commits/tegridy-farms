// useCowTwap — register a transparent, MEV-protected TWAP via CoW's ComposableCoW.
//
// A TWAP splits one trade into N equal parts, each tradeable in its own time
// slot and each settled through CoW's solver auction (MEV-protected). The wallet
// registers ONE conditional order with ComposableCoW; CoW's watchtower then posts
// each part to the orderbook as its slot opens. Unfilled parts cost nothing.
//
// HONEST SCOPE GATE — ComposableCoW is a SMART-CONTRACT-order mechanism. It needs
// an ERC-1271 wallet (a Safe) with ComposableCoW wired in as its order-verifying
// fallback handler (which the CoW Swap app configures automatically). A plain EOA
// cannot register a conditional order — it can't implement isValidSignature — so
// this hook detects the wallet type via getCode and self-gates to `unsupported`
// for EOAs, surfacing the reason and pointing at the single-signature CoW limit
// order instead. It NEVER submits a transaction that would create an unfillable
// order for a wallet that can't back it.

import { useCallback, useEffect, useState } from 'react';
import {
  useAccount,
  useChainId,
  usePublicClient,
  useWriteContract,
} from 'wagmi';
import { maxUint256, type Address, type Hex } from 'viem';
import { toast } from 'sonner';
import { ERC20_ABI } from '../lib/contracts';
import { CHAIN_ID } from '../lib/constants';
import { COW_VAULT_RELAYER_ADDRESS } from '../lib/cowProtocol';
import {
  COMPOSABLE_COW_ADDRESS,
  COMPOSABLE_COW_CREATE_ABI,
  TWAP_HANDLER_ADDRESS,
  encodeTwapStaticInput,
  buildCreateTwapCalldata,
  randomSalt,
  type TwapData,
} from '../lib/composableCow';

export type TwapWalletKind = 'unknown' | 'eoa' | 'contract';

export interface TwapSubmitResult {
  txHash: Hex;
  salt: Hex;
}

/**
 * Detects whether the connected wallet can host a ComposableCoW conditional
 * order and, if so, registers a TWAP. `isSupported` is false for EOAs with a
 * `reason` the UI shows verbatim.
 */
export function useCowTwap() {
  const { address } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient({ chainId: CHAIN_ID });
  const { writeContractAsync } = useWriteContract();

  const [walletKind, setWalletKind] = useState<TwapWalletKind>('unknown');
  const [isChecking, setIsChecking] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Classify the connected account: contract (Safe / smart wallet) vs EOA.
  useEffect(() => {
    let cancelled = false;
    if (!address || !publicClient || chainId !== CHAIN_ID) {
      setWalletKind('unknown');
      return;
    }
    setIsChecking(true);
    (async () => {
      try {
        const code = await publicClient.getCode({ address });
        if (cancelled) return;
        // No bytecode → EOA. Any bytecode → smart-contract wallet.
        setWalletKind(code && code !== '0x' ? 'contract' : 'eoa');
      } catch {
        if (!cancelled) setWalletKind('unknown');
      } finally {
        if (!cancelled) setIsChecking(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [address, publicClient, chainId]);

  const isSupported = walletKind === 'contract';
  const reason =
    walletKind === 'eoa'
      ? 'On-chain TWAP needs a smart-contract wallet (e.g. a Safe) with CoW’s ComposableCoW enabled. Your wallet is a regular EOA, which can’t register a conditional order. Use the single CoW limit order instead — or connect a Safe.'
      : walletKind === 'unknown'
        ? 'Checking wallet type…'
        : null;

  /** Build the exact ComposableCoW.create calldata for a TWAP (for transparency display). */
  const previewCalldata = useCallback((data: TwapData): { to: Address; data: Hex; salt: Hex } => {
    const salt = randomSalt();
    return { to: COMPOSABLE_COW_ADDRESS, data: buildCreateTwapCalldata({ data, salt }), salt };
  }, []);

  /**
   * Register the TWAP: approve the vault relayer for the whole run, then submit
   * ComposableCoW.create. Only runs for a smart-contract wallet.
   */
  const submitTwap = useCallback(
    async (data: TwapData): Promise<TwapSubmitResult | null> => {
      if (!address) {
        toast.error('Connect your wallet');
        return null;
      }
      if (chainId !== CHAIN_ID) {
        toast.error('Switch to Ethereum Mainnet');
        return null;
      }
      if (!publicClient) {
        toast.error('No RPC connection');
        return null;
      }
      if (walletKind !== 'contract') {
        toast.error('This wallet can’t register an on-chain TWAP');
        return null;
      }
      const totalSell = data.partSellAmount * data.n;
      if (totalSell <= 0n) {
        toast.error('Invalid TWAP amount');
        return null;
      }

      setIsSubmitting(true);
      try {
        // 1. Ensure the vault relayer can pull the sell token across all parts.
        const allowance = (await publicClient.readContract({
          address: data.sellToken,
          abi: ERC20_ABI,
          functionName: 'allowance',
          args: [address, COW_VAULT_RELAYER_ADDRESS],
        })) as bigint;
        if (allowance < totalSell) {
          toast.info('Approve CoW to spend the sell token (one-time)');
          const approveHash = await writeContractAsync({
            chainId: CHAIN_ID,
            address: data.sellToken,
            abi: ERC20_ABI,
            functionName: 'approve',
            args: [COW_VAULT_RELAYER_ADDRESS, maxUint256],
          });
          // AUDIT (receipt-status, 2026-08-24): waitForTransactionReceipt
          // RESOLVES for reverted txs. A reverted approve means every TWAP part
          // fails to settle — refuse to register on top of it.
          const approveReceipt = await publicClient.waitForTransactionReceipt({ hash: approveHash });
          if (approveReceipt.status !== 'success') {
            throw new Error('Token approval reverted on-chain — the TWAP was not registered.');
          }
        }

        // 2. Register the conditional order with dispatch=true so the watchtower
        //    picks it up and starts posting each part on schedule.
        const salt = randomSalt();
        const staticInput = encodeTwapStaticInput(data);
        const txHash = await writeContractAsync({
          chainId: CHAIN_ID,
          address: COMPOSABLE_COW_ADDRESS,
          abi: COMPOSABLE_COW_CREATE_ABI,
          functionName: 'create',
          args: [{ handler: TWAP_HANDLER_ADDRESS, salt, staticInput }, true],
        });
        const createReceipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
        if (createReceipt.status !== 'success') {
          throw new Error('Registration reverted on-chain — the TWAP is NOT active.');
        }
        toast.success('TWAP registered on CoW — parts settle on schedule, MEV-protected.');
        return { txHash, salt };
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Failed to register TWAP';
        if (/reject|denied|user denied|user rejected/i.test(msg)) {
          toast.error('Transaction rejected');
        } else {
          toast.error(msg.slice(0, 140));
        }
        return null;
      } finally {
        setIsSubmitting(false);
      }
    },
    [address, chainId, publicClient, walletKind, writeContractAsync],
  );

  return { walletKind, isSupported, isChecking, reason, previewCalldata, submitTwap, isSubmitting };
}
