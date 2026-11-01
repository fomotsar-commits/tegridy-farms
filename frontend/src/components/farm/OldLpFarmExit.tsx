import { useEffect } from 'react';
import { toast } from 'sonner';
import { useAccount, useReadContracts, useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { formatEther } from 'viem';
import { CHAIN_ID, OLD_LP_FARMING_ADDRESS } from '../../lib/constants';
import { LP_FARMING_ABI } from '../../lib/contracts';
import { useReceiptOutcome } from '../../hooks/useReceiptOutcome';
import { noteReplacement } from '../../lib/txErrors';
import { ArtImg } from '../ArtImg';
import { CardArt } from '../ui/CardArt';

/**
 * The way out of the 2026-06-08 LP farm (OLD_LP_FARMING_ADDRESS) after STAKING RELEASE 1
 * pointed the site at a new farm. Its rewards ended 2026-06-15, so all that is left there
 * is the LP itself (and any reward it booked before then). `exit()` returns both in one
 * transaction and works while the farm is paused. Renders nothing for a wallet with no LP
 * there; an unanswered read says so instead of hiding the LP. (Only stake() is
 * whenNotPaused in TegridyLPFarming.sol.)
 */
export function OldLpFarmExit() {
  const { address, isConnected } = useAccount();
  const reads = useReadContracts({
    contracts: [
      { address: OLD_LP_FARMING_ADDRESS, abi: LP_FARMING_ABI, functionName: 'rawBalanceOf', args: address ? [address] : undefined, chainId: CHAIN_ID },
      { address: OLD_LP_FARMING_ADDRESS, abi: LP_FARMING_ABI, functionName: 'earned', args: address ? [address] : undefined, chainId: CHAIN_ID },
    ],
    query: { enabled: isConnected && !!address },
  });

  const { writeContract, data: txHash, isPending, reset } = useWriteContract();
  const receiptQuery = useWaitForTransactionReceipt({ hash: txHash, chainId: CHAIN_ID, onReplaced: noteReplacement });
  const { isSuccess, isReverted, isReceiptUnreadable, isReplaced } = useReceiptOutcome(receiptQuery, {
    hash: txHash,
    chainId: CHAIN_ID,
    repeatCost: 'withdrawing again reverts, because the LP has already left.',
  });

  useEffect(() => {
    if (!isSuccess) return;
    toast.success('LP withdrawn from the old farm');
    void reads.refetch();
    reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSuccess]);

  useEffect(() => {
    if (!isReverted) return;
    toast.error('Withdrawal reverted on-chain. No LP moved; it is still in the old farm.');
    reset();
  }, [isReverted, reset]);

  // We could not tell how it ended: the balance, not the receipt, says whether the LP left.
  useEffect(() => {
    if (!isReceiptUnreadable && !isReplaced) return;
    void reads.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReceiptUnreadable, isReplaced]);

  if (!isConnected || !address || reads.isLoading) return null;
  const lpLeg = reads.data?.[0];
  const rewardLeg = reads.data?.[1];
  // OUTAGE-AS-ZERO: 0n is also "no LP here", so a failed read is said, not hidden.
  if (lpLeg?.status !== 'success') {
    return (
      <div
        className="relative isolate mb-6 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-[13px] text-amber-100"
        data-testid="old-lp-farm-unread"
      >
        <CardArt pageId="legacy-exit" idx={1} />
        We could not check the old LP farm. Any LP in it is still there and still yours. Reload to try again.
      </div>
    );
  }
  const lp = lpLeg.result as bigint;
  if (lp === 0n) return null;
  const reward = rewardLeg?.status === 'success' ? (rewardLeg.result as bigint) : null;
  const busy = isPending || receiptQuery.isLoading;
  const lpLabel = `${Number(formatEther(lp)).toLocaleString(undefined, { maximumFractionDigits: 4 })} LP`;

  return (
    <div
      className="relative overflow-hidden mb-6 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 md:p-5"
      data-testid="old-lp-farm-exit"
    >
      <div className="absolute inset-0 -z-10" aria-hidden="true">
        <ArtImg pageId="legacy-exit" idx={0} alt="" loading="lazy" className="w-full h-full object-cover" />
        <div className="absolute inset-0" style={{ background: 'linear-gradient(135deg, rgba(245,158,11,0.16), rgba(6,12,26,0.88))' }} />
      </div>
      <div className="text-amber-300 text-[13px] font-semibold uppercase tracking-wider mb-1">
        LP in the old farm
      </div>
      <p className="text-white/80 text-[13px] mb-3">
        Its rewards ended on 2026-06-15, so this LP earns nothing there. Withdrawing it has no fee.
      </p>
      <div className="flex flex-col md:flex-row md:items-center gap-2 md:gap-4 justify-between rounded-lg bg-black/30 px-3 py-2.5">
        <div className="text-white text-[14px] font-medium">
          {lpLabel}
          {reward !== null && reward > 0n && (
            <span className="text-white/70 text-[12px] font-normal">
              {' '}+ {Number(formatEther(reward)).toFixed(4)} TOWELI booked before the end
            </span>
          )}
        </div>
        <button
          onClick={() => writeContract({ address: OLD_LP_FARMING_ADDRESS, abi: LP_FARMING_ABI, functionName: 'exit', chainId: CHAIN_ID })}
          disabled={busy}
          className="btn-primary px-5 py-2.5 min-h-[44px] text-[13px] whitespace-nowrap disabled:opacity-70"
        >
          {busy ? 'Confirming...' : `Withdraw ${lpLabel}`}
        </button>
      </div>
    </div>
  );
}
