import { useEffect, useRef } from 'react';
import { useAccount, useReadContract, useWriteContract, useWaitForTransactionReceipt, useChainId } from 'wagmi';
import { formatEther } from 'viem';
import { toast } from 'sonner';
import { TEGRIDY_STAKING_ABI, ERC20_ABI, REVENUE_DISTRIBUTOR_ABI } from '../lib/contracts';
import { TEGRIDY_STAKING_ADDRESS, TOWELI_ADDRESS, REVENUE_DISTRIBUTOR_ADDRESS, CHAIN_ID } from '../lib/constants';
import { trackStake } from '../lib/analytics';
import { getTxUrl } from '../lib/explorer';
import { safeParseEtherPositive } from '../lib/safeParseEther';
import { surfaceTxError } from '../lib/txErrors';

export function useFarmActions() {
  const chainId = useChainId();
  const { address } = useAccount();
  const onRightChain = chainId === CHAIN_ID;

  const { data: pendingEthRaw } = useReadContract({
    address: REVENUE_DISTRIBUTOR_ADDRESS,
    abi: REVENUE_DISTRIBUTOR_ABI,
    functionName: 'pendingETH',
    args: address ? [address] : undefined,
    chainId: CHAIN_ID,
    query: { enabled: !!address && onRightChain, refetchInterval: 15_000 },
  });
  // OUTAGE-AS-ZERO. `?? 0n` handed pendingEthGuard the one value that means
  // "nothing unclaimed to forfeit" every time the read failed or had not landed
  // yet - so an RPC hiccup silently disarmed the only thing standing between a
  // withdraw and the user's ETH revenue. Unknown stays unknown: `null` is "we
  // did not read it", and a successful 0n is still a real zero that withdraws
  // normally. wagmi leaves `data` undefined for a pending, failed or disabled
  // read and a bigint for a landed one - that is the whole distinction.
  const pendingEth: bigint | null = typeof pendingEthRaw === 'bigint' ? pendingEthRaw : null;
  const { writeContract, data: hash, isPending, reset, error: writeError } = useWriteContract();
  const pendingStakeRef = useRef<{ amount: string; lockDuration: string } | null>(null);
  // 2026-07-26: track whether the in-flight tx is the ERC20 approval, so the
  // success toast can say "approved — now stake" instead of a generic
  // "confirmed" that reads like the stake already happened. Reset to 'action'
  // in every terminal path (success / tx-error / write-error / account switch)
  // so a stale 'approve' can never mislabel a later stake or claim.
  const lastActionRef = useRef<'approve' | 'action'>('action');
  // R034 H1: snapshot of the wallet that submitted the current tx so the
  // receipt effect doesn't fire trackStake for a different wallet that
  // reconnected mid-flight.
  const txAddressRef = useRef<`0x${string}` | undefined>(undefined);

  // R034 H1: account-switch reset block — wipe all in-flight refs so a new
  // wallet doesn't inherit the previous wallet's pending state.
  useEffect(() => {
    pendingStakeRef.current = null;
    txAddressRef.current = undefined;
    lastActionRef.current = 'action';
  }, [address]);

  const {
    data: receipt,
    isLoading: isConfirming,
    isSuccess: isReceiptFetched,
    isError: isReceiptError,
  } = useWaitForTransactionReceipt({
    chainId: CHAIN_ID,
    hash,
  });
  // AUDIT (receipt-status): wagmi's `isSuccess` only means "the receipt was
  // FETCHED" — a transaction that reverted on-chain also produces a receipt,
  // so `isSuccess` latched true and the UI showed confetti + "Transaction
  // confirmed" for a stake/withdraw/claim that moved nothing. Only
  // `receipt.status === 'success'` is an actual on-chain success.
  // `receipt` is always defined once wagmi reports isSuccess at runtime; the
  // null-check is defensive only, so a wagmi shape drift can never turn a
  // genuinely successful tx into a false "reverted" alarm.
  const isReverted = isReceiptFetched && !!receipt && receipt.status !== 'success';
  const isSuccess = isReceiptFetched && !isReverted;
  const isTxError = isReceiptError || isReverted;

  useEffect(() => {
    if (isSuccess && hash) {
      // R034 H1: drop trackStake / toast for a wallet swap that landed
      // between submit and confirm.
      if (txAddressRef.current && txAddressRef.current !== address) {
        pendingStakeRef.current = null;
        txAddressRef.current = undefined;
        return;
      }
      if (lastActionRef.current === 'approve') {
        // An approval only grants the farm permission to move your TOWELI — the
        // stake still needs a second transaction. Say so, so this doesn't read
        // like the stake is done.
        toast.success('TOWELI approved — now confirm your stake', {
          id: hash,
          description: 'That was just the approval. Tap “Stake & Lock” and confirm the second transaction to actually stake.',
          action: {
            label: 'Explorer',
            onClick: () => window.open(getTxUrl(chainId, hash), '_blank'),
          },
        });
      } else {
        toast.success('Transaction confirmed', {
          id: hash,
          action: {
            label: 'Explorer',
            onClick: () => window.open(getTxUrl(chainId, hash), '_blank'),
          },
        });
      }
      if (pendingStakeRef.current) {
        trackStake(pendingStakeRef.current.amount, Number(pendingStakeRef.current.lockDuration));
        pendingStakeRef.current = null;
      }
      txAddressRef.current = undefined;
      lastActionRef.current = 'action';
    }
  }, [isSuccess, hash, address, chainId]);

  useEffect(() => {
    if (isTxError && hash) {
      toast.error(isReverted ? 'Transaction reverted on-chain' : 'Transaction failed', {
        id: `err-${hash}`,
        description: isReverted
          ? 'The network rejected it — nothing was staked, withdrawn or claimed (gas was still spent). Open it on the explorer for the revert reason, then adjust your amount or lock and try again.'
          : undefined,
        action: {
          label: 'Explorer',
          onClick: () => window.open(getTxUrl(chainId, hash), '_blank'),
        },
      });
      // A reverted tx moved nothing, so drop the in-flight snapshots — otherwise
      // a later *successful* tx would fire trackStake for this dead stake.
      pendingStakeRef.current = null;
      txAddressRef.current = undefined;
      lastActionRef.current = 'action';
    }
  }, [isTxError, isReverted, hash, chainId]);

  useEffect(() => {
    // F474: classify wallet cancellations as a soft "Cancelled" info toast
    // instead of a scary raw error string.
    if (writeError) {
      surfaceTxError(writeError, toast, { component: 'useFarmActions' });
      lastActionRef.current = 'action';
    }
  }, [writeError]);

  const approve = (amount: string) => {
    if (chainId !== CHAIN_ID) { toast.error('Please switch to Ethereum Mainnet'); return; }
    // R034 H4: safeParseEtherPositive — silent fail instead of ErrorBoundary nuke.
    const approveAmount = safeParseEtherPositive(amount);
    if (approveAmount === null) return;
    txAddressRef.current = address;
    lastActionRef.current = 'approve';
    writeContract({
      chainId: CHAIN_ID,
      address: TOWELI_ADDRESS,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [TEGRIDY_STAKING_ADDRESS, approveAmount],
    });
  };

  const stake = (amount: string, lockDurationSeconds: bigint) => {
    if (chainId !== CHAIN_ID) { toast.error('Please switch to Ethereum Mainnet'); return; }
    const wei = safeParseEtherPositive(amount);
    // F484: match approve()'s soft-fail — a thrown error on an onClick path
    // nukes the ErrorBoundary instead of just telling the user to fix the input.
    if (wei === null) { toast.error('Invalid amount'); return; }
    pendingStakeRef.current = { amount, lockDuration: lockDurationSeconds.toString() };
    txAddressRef.current = address;
    writeContract({
      chainId: CHAIN_ID,
      address: TEGRIDY_STAKING_ADDRESS,
      abi: TEGRIDY_STAKING_ABI,
      functionName: 'stake',
      args: [wei, lockDurationSeconds],
    });
  };

  /**
   * Refuse an exit unless the unclaimed-ETH balance is actually KNOWN.
   *
   * Fails CLOSED on `null`, and does so BEFORE `force`: `force` is the user
   * overriding a figure they have been shown, and during an outage there is no
   * figure - nobody can consent to forfeiting an amount nobody can read. Only a
   * successful on-chain `0n` opens the gate silently. Blocking costs the user a
   * reload; the direction that must not move is the other one.
   */
  const pendingEthGuard = (force: boolean): boolean => {
    if (pendingEth === null) {
      toast.error(
        `Your unclaimed ETH revenue could not be read - the network did not answer. ` +
        `This is not a statement that you have none: withdrawing now could forfeit ETH ` +
        `you cannot see. Reload and try again, or claim your ETH revenue first.`,
        { duration: 8000 }
      );
      return false;
    }
    if (force) return true;
    if (pendingEth > 0n) {
      toast.error(
        `You have ${Number(formatEther(pendingEth)).toFixed(6)} ETH unclaimed. ` +
        `Claim ETH revenue first — withdrawing now forfeits it.`,
        { duration: 8000 }
      );
      return false;
    }
    return true;
  };

  const withdraw = (tokenId: bigint, force: boolean = false) => {
    if (chainId !== CHAIN_ID) { toast.error('Please switch to Ethereum Mainnet'); return; }
    if (!pendingEthGuard(force)) return;
    txAddressRef.current = address;
    writeContract({
      chainId: CHAIN_ID,
      address: TEGRIDY_STAKING_ADDRESS,
      abi: TEGRIDY_STAKING_ABI,
      functionName: 'withdraw',
      args: [tokenId],
    });
  };

  const earlyWithdraw = (tokenId: bigint, force: boolean = false) => {
    if (chainId !== CHAIN_ID) { toast.error('Please switch to Ethereum Mainnet'); return; }
    if (!pendingEthGuard(force)) return;
    txAddressRef.current = address;
    writeContract({
      chainId: CHAIN_ID,
      address: TEGRIDY_STAKING_ADDRESS,
      abi: TEGRIDY_STAKING_ABI,
      functionName: 'earlyWithdraw',
      args: [tokenId],
    });
  };

  const claim = (tokenId: bigint) => {
    if (chainId !== CHAIN_ID) { toast.error('Please switch to Ethereum Mainnet'); return; }
    txAddressRef.current = address;
    writeContract({
      chainId: CHAIN_ID,
      address: TEGRIDY_STAKING_ADDRESS,
      abi: TEGRIDY_STAKING_ABI,
      functionName: 'getReward',
      args: [tokenId],
    });
  };

  const toggleAutoMaxLock = (tokenId: bigint) => {
    if (chainId !== CHAIN_ID) { toast.error('Please switch to Ethereum Mainnet'); return; }
    txAddressRef.current = address;
    writeContract({
      chainId: CHAIN_ID,
      address: TEGRIDY_STAKING_ADDRESS,
      abi: TEGRIDY_STAKING_ABI,
      functionName: 'toggleAutoMaxLock',
      args: [tokenId],
    });
  };

  const extendLock = (tokenId: bigint, newDuration: bigint) => {
    if (chainId !== CHAIN_ID) { toast.error('Please switch to Ethereum Mainnet'); return; }
    txAddressRef.current = address;
    writeContract({
      chainId: CHAIN_ID,
      address: TEGRIDY_STAKING_ADDRESS,
      abi: TEGRIDY_STAKING_ABI,
      functionName: 'extendLock',
      args: [tokenId, newDuration],
    });
  };

  const emergencyExit = (tokenId: bigint, force: boolean = false) => {
    if (chainId !== CHAIN_ID) { toast.error('Please switch to Ethereum Mainnet'); return; }
    if (!pendingEthGuard(force)) return;
    txAddressRef.current = address;
    writeContract({
      chainId: CHAIN_ID,
      address: TEGRIDY_STAKING_ADDRESS,
      abi: TEGRIDY_STAKING_ABI,
      functionName: 'emergencyExitPosition',
      args: [tokenId],
    });
  };

  const claimUnsettled = () => {
    if (chainId !== CHAIN_ID) { toast.error('Please switch to Ethereum Mainnet'); return; }
    txAddressRef.current = address;
    writeContract({
      chainId: CHAIN_ID,
      address: TEGRIDY_STAKING_ADDRESS,
      abi: TEGRIDY_STAKING_ABI,
      functionName: 'claimUnsettled',
    });
  };

  const revalidateBoost = (tokenId: bigint) => {
    if (chainId !== CHAIN_ID) { toast.error('Please switch to Ethereum Mainnet'); return; }
    txAddressRef.current = address;
    writeContract({
      chainId: CHAIN_ID,
      address: TEGRIDY_STAKING_ADDRESS,
      abi: TEGRIDY_STAKING_ABI,
      functionName: 'revalidateBoost',
      args: [tokenId],
    });
  };

  return {
    approve,
    stake,
    withdraw,
    earlyWithdraw,
    claim,
    toggleAutoMaxLock,
    extendLock,
    emergencyExit,
    claimUnsettled,
    revalidateBoost,
    /** Unclaimed ETH revenue in wei, or `null` when the read did not land.
        `null` is NOT zero - it is the state pendingEthGuard refuses to exit on.
        Never render it as a figure; a successful 0n is the only real zero. */
    pendingEth,
    isPending,
    isConfirming,
    isSuccess,
    isTxError,
    writeError,
    hash,
    /** The fetched receipt (logs included) — §2.5: claim receipts must report
        what was PAID (RewardPaid event), not the submit-time snapshot. */
    receipt,
    reset,
  };
}
