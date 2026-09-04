import { useCallback, useEffect, useRef, useState } from 'react';
import {
  useAccount,
  useBalance,
  useChainId,
  usePublicClient,
  useReadContracts,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi';
import { toast } from 'sonner';
import { ERC20_ABI } from '../lib/contracts';
import { getTxUrl } from '../lib/explorer';
import { surfaceTxError } from '../lib/txErrors';
import {
  depositPlan,
  YIELD_CHAIN_ID,
  YIELD_RECEIPT_TOKENS,
  type DepositPlan,
  type DepositStep,
} from '../lib/yield/deposit';
import type { RocketGateReads } from '../lib/yield/reads';
import type { YieldVenue } from '../lib/yield/venues';

// The wallet half of a deposit. Everything it DECIDES lives in lib/yield/deposit.ts.
//
// This hook reads three balances, hands them to the pure planner, and submits
// whichever step the planner put first. It contains no rule about what may be
// approved, what a spender may be, or when a deposit is allowed — those are the
// rules that lose money when they drift, so they live where a test can reach
// them without a render.
//
// TWO RULES LIFTED FROM useFarmActions, both of which cost this repo a real bug:
//
//   `receipt.status !== 'success'` is the ONLY definition of failure. wagmi's
//   `isSuccess` means the receipt was FETCHED, and a reverted transaction
//   produces a receipt too — the farm page showed "confirmed" for stakes that
//   moved nothing until this was fixed (useFarmActions.ts:64).
//
//   Every in-flight ref is wiped on an account switch (useFarmActions.ts:41-45),
//   so a wallet that reconnects between submit and confirm cannot inherit the
//   previous wallet's pending step and report its result as its own.
//
// WHAT IT REPORTS AFTER A DEPOSIT is deliberately not a "received" figure. The
// receipt token's balance is read at the block before and the block of the
// receipt, and BOTH are printed. A single "you received X" would be wrong for
// every rebasing receipt on this page — stETH and eETH accrue between those two
// blocks — and stating one number would turn an accrual into a claim about what
// the deposit produced.

export type StepPhase = 'idle' | 'submitting' | 'confirming' | 'done' | 'failed';

export interface ReceiptBalanceReport {
  before: bigint;
  beforeBlock: number;
  after: bigint;
  afterBlock: number;
  decimals: number;
  symbol: string;
}

export interface YieldDepositState {
  plan: DepositPlan;
  /** Index into `plan.steps` of the step the button will submit next. */
  stepIndex: number;
  phase: StepPhase;
  hash: `0x${string}` | undefined;
  explorerUrl: string | null;
  /** Two named blocks, never a single "received" number. Null until a deposit lands. */
  receiptBalances: ReceiptBalanceReport | null;
  /** Chain-read balances the plan was built from. Null while unread. */
  nativeBalance: bigint | null;
  assetBalance: bigint | null;
  allowance: bigint | null;
  submit: () => void;
  reset: () => void;
}

export interface UseYieldDepositArgs {
  venue: YieldVenue;
  amountText: string;
  /** Rocket Pool's live gates from the page read. Never a source of addresses. */
  rocket: RocketGateReads | null;
}

export function useYieldDeposit({ venue, amountText, rocket }: UseYieldDepositArgs): YieldDepositState {
  const { address } = useAccount();
  const chainId = useChainId();
  const onRightChain = chainId === YIELD_CHAIN_ID;

  const route = venue.route;
  const erc20 = route.kind === 'erc20-supply' ? route.asset : null;

  const { data: native } = useBalance({
    address,
    chainId: YIELD_CHAIN_ID,
    query: { enabled: !!address && onRightChain },
  });

  // The receipt token is what the deposit MINTS, which is not always the
  // destination contract: Aave's aEthUSDC is a different address from the Pool,
  // and ether.fi's weETH is a different address from the LiquidityPool. The
  // catalogue's `symbol` names the receipt, so the balance report reads the token
  // the depositor actually ends up holding rather than the one they sent to.
  const { data: erc20Reads, refetch: refetchErc20 } = useReadContracts({
    contracts:
      erc20 === null
        ? []
        : [
            { address: erc20.address, abi: ERC20_ABI, functionName: 'balanceOf', args: [address ?? '0x'], chainId: YIELD_CHAIN_ID },
            { address: erc20.address, abi: ERC20_ABI, functionName: 'allowance', args: [address ?? '0x', venue.depositTarget], chainId: YIELD_CHAIN_ID },
          ],
    query: { enabled: erc20 !== null && !!address && onRightChain },
  });

  const assetBalance = erc20 === null ? null : asBigint(erc20Reads?.[0]);
  const allowance = erc20 === null ? null : asBigint(erc20Reads?.[1]);
  const nativeBalance = native === undefined ? null : native.value;

  const plan = depositPlan({
    venue,
    amountText,
    chainId: address ? chainId : null,
    account: address ?? null,
    nativeBalance,
    assetBalance,
    allowance,
    ...(venue.id === 'rocketpool-reth' && rocket !== null
      ? {
          rocket: {
            resolvedPool: rocket.resolvedPool,
            resolvedSettings: rocket.resolvedSettings,
            depositEnabled: rocket.depositEnabled,
            minimumDeposit: rocket.minimumDeposit,
            maxPoolSize: rocket.maxPoolSize,
            poolBalance: rocket.poolBalance,
          },
        }
      : {}),
  });

  const [stepIndex, setStepIndex] = useState(0);
  const [phase, setPhase] = useState<StepPhase>('idle');
  const [receiptBalances, setReceiptBalances] = useState<ReceiptBalanceReport | null>(null);
  const client = usePublicClient({ chainId: YIELD_CHAIN_ID });
  const { writeContract, data: hash, reset: resetWrite } = useWriteContract();

  // The account that SUBMITTED the in-flight transaction. Deliberately NOT
  // cleared when the wallet changes: clearing it would make the receipt effect's
  // ownership check pass for the new wallet, which is the exact confusion the
  // check exists to prevent (useFarmActions.ts:41-45 clears its refs for the
  // same reason but reads them in the opposite order).
  const txAccountRef = useRef<`0x${string}` | undefined>(undefined);
  /** How many steps the plan had when it was submitted. Read in the receipt
   *  effect so the effect need not depend on `plan`, whose identity changes on
   *  every render — depending on it made the effect re-run its own setState for
   *  ever, at about 1,500 chain reads per test. */
  const stepCountRef = useRef(1);
  /** One terminal handling per transaction hash, whatever re-renders happen. */
  const settledHashRef = useRef<`0x${string}` | undefined>(undefined);

  // The wallet that is connected is an EXTERNAL system, and this effect
  // synchronises to a change in it. The state writes are queued rather than run
  // in the effect body so a connect/disconnect cannot cascade a render inside
  // the commit that observed it (the repo's set-state-in-effect rule; the same
  // shape as useIntegratorFees, which does its writes inside the async body).
  const [lastAccount, setLastAccount] = useState(address);
  if (lastAccount !== address) {
    setLastAccount(address);
    setStepIndex(0);
    setPhase('idle');
    setReceiptBalances(null);
    resetWrite();
  }

  const { data: receipt, isSuccess: receiptFetched, isError: receiptError } = useWaitForTransactionReceipt({
    chainId: YIELD_CHAIN_ID,
    hash,
  });

  useEffect(() => {
    if (!receiptFetched || !receipt || !hash) return;
    if (settledHashRef.current === hash) return;
    settledHashRef.current = hash;
    if (txAccountRef.current && txAccountRef.current !== address) {
      // A different wallet is connected than the one that submitted. Say nothing
      // about a transaction this account did not send.
      setPhase('idle');
      return;
    }
    // wagmi's isSuccess only means the receipt arrived. A reverted transaction
    // has a receipt too.
    if (receipt.status !== 'success') {
      setPhase('failed');
      toast.error('That transaction reverted on-chain', {
        id: hash,
        description: 'Nothing moved. The protocol rejected it — check the explorer for the revert reason.',
        action: { label: 'Explorer', onClick: () => window.open(getTxUrl(YIELD_CHAIN_ID, hash), '_blank') },
      });
      return;
    }
    setPhase('done');
    void refetchErc20();
    // The receipt token's balance at TWO named blocks: the block before this
    // transaction and the block it landed in. Both are read, and both are
    // printed — the difference is NOT reported as "received", because every
    // rebasing receipt on this page (stETH, eETH) also accrues between them and
    // a single figure would fold an accrual into the deposit's result.
    const receiptToken = YIELD_RECEIPT_TOKENS[venue.id];
    if (client !== undefined && receiptToken !== undefined && address !== undefined) {
      const at = receipt.blockNumber;
      void Promise.all([
        client.readContract({ address: receiptToken.address, abi: ERC20_ABI, functionName: 'balanceOf', args: [address], blockNumber: at - 1n }),
        client.readContract({ address: receiptToken.address, abi: ERC20_ABI, functionName: 'balanceOf', args: [address], blockNumber: at }),
      ])
        .then(([before, after]) => {
          setReceiptBalances({
            before,
            beforeBlock: Number(at - 1n),
            after,
            afterBlock: Number(at),
            decimals: receiptToken.decimals,
            symbol: receiptToken.symbol,
          });
        })
        // A public node that will not serve the block before this one leaves the
        // report absent rather than printing one leg as if it were both.
        .catch(() => setReceiptBalances(null));
    }
    const isLast = stepIndex >= stepCountRef.current - 1;
    toast.success(isLast ? 'Deposit confirmed on-chain' : 'Approved — one more signature to go', {
      id: hash,
      description: isLast
        ? 'Your wallet now holds the receipt token. The balance line below reads it at two blocks.'
        : 'That was the approval only. Confirm the second transaction to actually deposit.',
      action: { label: 'Explorer', onClick: () => window.open(getTxUrl(YIELD_CHAIN_ID, hash), '_blank') },
    });
    if (!isLast) {
      setStepIndex((i) => i + 1);
      resetWrite();
      setPhase('idle');
    }

  }, [receiptFetched, receipt, hash, address, refetchErc20, resetWrite, stepIndex, client, venue.id]);

  const [lastReceiptError, setLastReceiptError] = useState(receiptError);
  if (lastReceiptError !== receiptError) {
    setLastReceiptError(receiptError);
    if (receiptError) setPhase('failed');
  }

  const submit = useCallback(() => {
    if (plan.state !== 'ready' && plan.state !== 'needs-approval') return;
    const step: DepositStep | undefined = plan.steps[stepIndex];
    if (step === undefined) return;
    txAccountRef.current = address;
    stepCountRef.current = plan.steps.length;
    setPhase('submitting');
    try {
      writeContract(
        {
          address: step.address,
          abi: step.abi as never,
          functionName: step.functionName,
          args: step.args as never,
          chainId: YIELD_CHAIN_ID,
          ...(step.value === undefined ? {} : { value: step.value }),
        },
        {
          onSuccess: () => setPhase('confirming'),
          onError: (err) => {
            setPhase('failed');
            surfaceTxError(err, toast, { component: 'YieldDeposit' });
          },
        },
      );
    } catch (err) {
      setPhase('failed');
      surfaceTxError(err, toast, { component: 'YieldDeposit' });
    }
  }, [plan, stepIndex, writeContract, address]);

  const reset = useCallback(() => {
    setStepIndex(0);
    setPhase('idle');
    setReceiptBalances(null);
    settledHashRef.current = undefined;
    resetWrite();
  }, [resetWrite]);

  return {
    plan,
    stepIndex,
    phase,
    hash,
    explorerUrl: hash ? getTxUrl(YIELD_CHAIN_ID, hash) : null,
    receiptBalances,
    nativeBalance,
    assetBalance,
    allowance,
    submit,
    reset,
  };
}

function asBigint(entry: { status: 'success' | 'failure'; result?: unknown } | undefined): bigint | null {
  if (entry === undefined || entry.status !== 'success') return null;
  return typeof entry.result === 'bigint' ? entry.result : null;
}
