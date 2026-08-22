// useTriggerOrders — arm state for a trigger order, and registration when (and
// only when) something will actually execute it.
//
// The hook's whole job is to refuse. `submit` re-derives the arm state at call time
// instead of trusting the render that enabled the button, because the one bug this
// surface cannot ship is a stop-loss that was placed while unarmed: the user stops
// watching the position, and nothing takes over. Registration is reachable through
// exactly one branch — a Safe, a stop-loss, a configured handler, feeds on both
// sides — and every other combination returns null with the reason already written.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAccount, useChainId, usePublicClient, useWriteContract } from 'wagmi';
import { maxUint256, type Address, type Hex } from 'viem';
import { toast } from 'sonner';
import { ERC20_ABI } from '../lib/contracts';
import { CHAIN_ID } from '../lib/constants';
import { COW_VAULT_RELAYER_ADDRESS } from '../lib/cowProtocol';
import { COMPOSABLE_COW_ADDRESS, COMPOSABLE_COW_CREATE_ABI, randomSalt } from '../lib/composableCow';
import {
  buildCreateStopLossCalldata,
  encodeStopLossStaticInput,
  type StopLossData,
} from '../lib/triggers/stopLossHandler';
import {
  triggerArmState,
  type TriggerArmState,
  type TriggerWalletKind,
} from '../lib/triggers/armState';
import { triggerFeeDisclosure } from '../lib/triggers/triggerFee';
import { stopLossDataFromLeg, type TriggerKind, type TriggerPlan } from '../lib/triggers/triggerPlan';

export interface TriggerSubmitContext {
  sellToken: Address;
  buyToken: Address;
  receiver: Address;
}

export interface TriggerSubmitResult {
  txHash: Hex;
  salt: Hex;
}

export interface UseTriggerOrdersArgs {
  kind: TriggerKind;
  sellToken?: string | null;
  buyToken?: string | null;
}

export function useTriggerOrders({ kind, sellToken, buyToken }: UseTriggerOrdersArgs) {
  const { address } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient({ chainId: CHAIN_ID });
  const { writeContractAsync } = useWriteContract();

  const [walletKind, setWalletKind] = useState<TriggerWalletKind>('unknown');
  const [isChecking, setIsChecking] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Classify the connected account: contract (Safe / smart wallet) vs EOA. An RPC
  // failure leaves this 'unknown', which blocks — a wallet we could not classify is
  // not a wallet we may assume can host a conditional order.
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

  const armInput = useMemo(
    () => ({
      kind,
      walletKind,
      onExpectedChain: chainId === CHAIN_ID,
      sellToken: sellToken ?? null,
      buyToken: buyToken ?? null,
    }),
    [kind, walletKind, chainId, sellToken, buyToken],
  );

  const arm: TriggerArmState = useMemo(() => triggerArmState(armInput), [armInput]);
  const fee = useMemo(() => triggerFeeDisclosure(arm.path), [arm.path]);

  /** The exact calldata a leg would register, for the transparency drawer. Null
   *  whenever the order is not armed — there is no calldata for an order that
   *  would never be sent, and rendering one implies otherwise. */
  const previewCalldata = useCallback(
    (data: StopLossData): { to: Address; data: Hex; salt: Hex } | null => {
      const live = triggerArmState(armInput);
      if (!live.armed || !live.handler) return null;
      const salt = randomSalt();
      return {
        to: COMPOSABLE_COW_ADDRESS,
        data: buildCreateStopLossCalldata({ handler: live.handler, data, salt }),
        salt,
      };
    },
    [armInput],
  );

  /**
   * Build one leg's handler struct. Returns null when the feeds the struct needs
   * are not configured, so a caller cannot assemble a struct with placeholder
   * oracle addresses.
   */
  const buildLegData = useCallback(
    (plan: TriggerPlan, legIndex: number, ctx: TriggerSubmitContext): StopLossData | null => {
      const live = triggerArmState(armInput);
      const leg = plan.legs[legIndex];
      if (!leg || !live.sellFeed || !live.buyFeed) return null;
      return stopLossDataFromLeg(leg, plan, {
        sellToken: ctx.sellToken,
        buyToken: ctx.buyToken,
        receiver: ctx.receiver,
        sellTokenPriceOracle: live.sellFeed.feed,
        buyTokenPriceOracle: live.buyFeed.feed,
      });
    },
    [armInput],
  );

  const submit = useCallback(
    async (plan: TriggerPlan, ctx: TriggerSubmitContext): Promise<TriggerSubmitResult | null> => {
      // Re-derive rather than trust `arm` from the render that enabled the button.
      const live = triggerArmState(armInput);
      if (!live.armed || !live.handler || !live.sellFeed || !live.buyFeed) {
        toast.error(live.blockers[0]?.message ?? 'This order cannot be armed.');
        return null;
      }
      if (!plan.valid || plan.legs.length !== 1) {
        toast.error(plan.error ?? 'This order shape cannot be registered on CoW.');
        return null;
      }
      if (!address || !publicClient) {
        toast.error('Connect your wallet');
        return null;
      }
      const data = buildLegData(plan, 0, ctx);
      if (!data) {
        toast.error('Price feeds for this pair are not configured.');
        return null;
      }

      setIsSubmitting(true);
      try {
        const allowance = (await publicClient.readContract({
          address: ctx.sellToken,
          abi: ERC20_ABI,
          functionName: 'allowance',
          args: [address, COW_VAULT_RELAYER_ADDRESS],
        })) as bigint;
        if (allowance < data.sellAmount) {
          toast.info('Approve CoW to spend the sell token (one-time)');
          const approveHash = await writeContractAsync({
            chainId: CHAIN_ID,
            address: ctx.sellToken,
            abi: ERC20_ABI,
            functionName: 'approve',
            args: [COW_VAULT_RELAYER_ADDRESS, maxUint256],
          });
          await publicClient.waitForTransactionReceipt({ hash: approveHash });
        }

        const salt = randomSalt();
        const staticInput = encodeStopLossStaticInput(data);
        const txHash = await writeContractAsync({
          chainId: CHAIN_ID,
          address: COMPOSABLE_COW_ADDRESS,
          abi: COMPOSABLE_COW_CREATE_ABI,
          functionName: 'create',
          args: [{ handler: live.handler, salt, staticInput }, true],
        });
        await publicClient.waitForTransactionReceipt({ hash: txHash });
        toast.success('Stop-loss registered. CoW’s watchtower posts it if your stop is reached.');
        return { txHash, salt };
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Failed to register the order';
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
    [address, armInput, buildLegData, publicClient, writeContractAsync],
  );

  return { walletKind, isChecking, arm, fee, previewCalldata, buildLegData, submit, isSubmitting };
}
