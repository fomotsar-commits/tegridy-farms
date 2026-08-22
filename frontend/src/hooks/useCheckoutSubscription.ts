import { useMemo } from 'react';
import { useReadContracts } from 'wagmi';
import { ERC20_ABI } from '../lib/contracts';
import { chargeVerdict, type ChargeState, type Subscription } from '../lib/commerce/subscription';

// The on-chain half of a subscription: the allowance that caps it and the
// balance that has to fund it.
//
// The verdict itself is computed by lib/commerce/subscription.ts, which is pure
// and knows nothing about wagmi. This hook's only job is to hand it two numbers
// it could not have invented, and to be explicit when it does not have them.
//
// ─── AN UNREAD ALLOWANCE IS NOT A ZERO ALLOWANCE ────────────────────────────
//
// While the reads are in flight or failing, `onChain` is null and the state is
// `unread`. It is emphatically NOT passed to the verdict as `{ allowance: 0n,
// balance: 0n }`, which would render an RPC hiccup as "your allowance ran out"
// — a false, alarming and actionable-looking statement about somebody's wallet.
//
// ─── THE ALLOWANCE IS READ AGAINST THE MERCHANT, NOT A CONTRACT ─────────────
//
// There is no subscription contract on this deployment and none is planned. The
// pull shape grants the ERC-20 allowance to the MERCHANT'S OWN ADDRESS and the
// merchant calls `transferFrom`. So the spender read below is the merchant, and
// the trust that arrangement requires is stated by `pullTrustNotice` on the
// surface that offers it — see lib/commerce/subscription.ts.

export type SubscriptionReadStatus = 'idle' | 'unread' | 'read';

export interface UseCheckoutSubscriptionState {
  status: SubscriptionReadStatus;
  /** Null in every state but `read`. */
  onChain: { allowance: bigint; balance: bigint } | null;
  /**
   * Null in every state but `read`. A caller must render the reason below
   * rather than a verdict it did not get.
   */
  charge: ChargeState | null;
  /** Plain-language reason, set whenever `charge` is null. */
  detail: string | null;
  refetch: () => void;
}

export interface UseCheckoutSubscriptionOptions {
  /** Null parks the hook in `idle`. */
  subscription: Subscription | null;
  /** Unix seconds. Passed in so a surface and its tests share one clock. */
  now: number;
  enabled?: boolean;
}

export function useCheckoutSubscription(
  opts: UseCheckoutSubscriptionOptions,
): UseCheckoutSubscriptionState {
  const { subscription, now, enabled = true } = opts;
  const active = enabled && subscription !== null;

  const { data, refetch, isLoading, isError } = useReadContracts({
    contracts: subscription
      ? [
          {
            address: subscription.token,
            abi: ERC20_ABI,
            functionName: 'allowance',
            args: [subscription.payer, subscription.merchant],
            chainId: subscription.chainId,
          },
          {
            address: subscription.token,
            abi: ERC20_ABI,
            functionName: 'balanceOf',
            args: [subscription.payer],
            chainId: subscription.chainId,
          },
        ]
      : [],
    query: { enabled: active, refetchInterval: 60_000 },
  });

  return useMemo(() => {
    if (!active || !subscription) {
      return { status: 'idle', onChain: null, charge: null, detail: null, refetch: () => void refetch() };
    }

    const allowanceOk = data?.[0]?.status === 'success';
    const balanceOk = data?.[1]?.status === 'success';

    if (!allowanceOk || !balanceOk) {
      return {
        status: 'unread',
        onChain: null,
        charge: null,
        detail: isLoading
          ? 'Reading the allowance and balance this subscription depends on…'
          : isError
            ? 'The allowance and balance could not be read, so nothing is claimed about whether a charge would go through.'
            : 'The allowance and balance have not been read, so nothing is claimed about whether a charge would go through.',
        refetch: () => void refetch(),
      };
    }

    const onChain = {
      allowance: data![0]!.result as bigint,
      balance: data![1]!.result as bigint,
    };

    return {
      status: 'read',
      onChain,
      charge: chargeVerdict(subscription, now, onChain),
      detail: null,
      refetch: () => void refetch(),
    };
  }, [active, subscription, data, isLoading, isError, now, refetch]);
}
