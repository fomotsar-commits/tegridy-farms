import { useEffect, useState } from 'react';
import { m } from 'framer-motion';
import { toast } from 'sonner';
import { useAccount, useReadContracts, useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import type { Address } from 'viem';
import { formatEther } from 'viem';
import { LEGACY_STAKING_ADDRESSES, CHAIN_ID } from '../../lib/constants';
import { TEGRIDY_STAKING_ABI } from '../../lib/contracts';
import { ArtImg } from '../ArtImg';

// The legacy deployments are the same TegridyStaking family as the live one, so
// TEGRIDY_STAKING_ABI covers userTokenId/getPosition/withdraw/earlyWithdraw
// (signatures verified against both legacy bytecodes + withdraw simulated OK,
// 2026-07-22). Only the penalty constant isn't in the shared ABI — local entry.
const PENALTY_ABI = [
  { type: 'function', name: 'EARLY_WITHDRAWAL_PENALTY_BPS', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
] as const;

interface LegacyPosition {
  contractAddr: Address;
  tokenId: bigint;
  amount: bigint;
  lockEnd: bigint;
  canWithdraw: boolean;
  penaltyBps: bigint | null;
}

/**
 * Exit-only surface for positions stranded in retired pre-relaunch staking
 * contracts. Renders NOTHING unless the connected wallet holds a position in
 * one of LEGACY_STAKING_ADDRESSES, so the Farm page is untouched for everyone
 * else. Deliberately offers no stake/approve path to the old contracts.
 */
export function LegacyStakingExit() {
  const { address, isConnected } = useAccount();
  const [confirmingIdx, setConfirmingIdx] = useState<number | null>(null);
  const [activeIdx, setActiveIdx] = useState<number | null>(null);

  const idReads = useReadContracts({
    contracts: LEGACY_STAKING_ADDRESSES.map((c) => ({
      address: c as Address,
      abi: TEGRIDY_STAKING_ABI,
      functionName: 'userTokenId' as const,
      args: address ? ([address] as const) : undefined,
      chainId: CHAIN_ID,
    })),
    query: { enabled: isConnected && !!address },
  });

  const ids: bigint[] = LEGACY_STAKING_ADDRESSES.map((_, i) => {
    const r = idReads.data?.[i];
    return r?.status === 'success' ? (r.result as bigint) : 0n;
  });

  const posReads = useReadContracts({
    contracts: LEGACY_STAKING_ADDRESSES.flatMap((c, i) => [
      { address: c as Address, abi: TEGRIDY_STAKING_ABI, functionName: 'getPosition' as const, args: [ids[i]] as const, chainId: CHAIN_ID },
      { address: c as Address, abi: PENALTY_ABI, functionName: 'EARLY_WITHDRAWAL_PENALTY_BPS' as const, chainId: CHAIN_ID },
    ]),
    query: { enabled: ids.some((id) => id > 0n) },
  });

  const { writeContract, data: txHash, isPending, reset } = useWriteContract();
  // Merge 2026-08-24: trunk's receipt-status derivation + the multichain
  // branch's chainId pin, both load-bearing.
  const { data: receipt, isLoading: isConfirming, isSuccess: isReceiptFetched } = useWaitForTransactionReceipt({ hash: txHash, chainId: CHAIN_ID });
  // AUDIT (receipt-status, 2026-08-24): wagmi's isSuccess only means the receipt
  // was FETCHED — it latches true for on-chain REVERTED txs too. Gate on
  // receipt.status so a reverted withdraw/earlyWithdraw doesn't silently clear
  // the confirm state as if the exit had gone through.
  const isReverted = isReceiptFetched && !!receipt && receipt.status !== 'success';
  const isSuccess = isReceiptFetched && !isReverted;

  useEffect(() => {
    if (isSuccess) {
      idReads.refetch();
      posReads.refetch();
      setActiveIdx(null);
      setConfirmingIdx(null);
      reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSuccess]);

  // Honest failure path for on-chain reverts: nothing moved; funds stay staked.
  useEffect(() => {
    if (!isReverted) return;
    toast.error('Withdrawal reverted on-chain — no TOWELI moved; your position is unchanged');
    reset();
  }, [isReverted, reset]);

  const positions: (LegacyPosition & { idx: number })[] = [];
  LEGACY_STAKING_ADDRESSES.forEach((c, i) => {
    const tokenId = ids[i] ?? 0n;
    if (tokenId === 0n) return;
    const pos = posReads.data?.[i * 2];
    const pen = posReads.data?.[i * 2 + 1];
    if (pos?.status !== 'success') return;
    const [amount, , lockEnd, , , canWithdraw] = pos.result as readonly [bigint, bigint, bigint, bigint, boolean, boolean];
    if (amount === 0n) return;
    positions.push({
      idx: i,
      contractAddr: c as Address,
      tokenId,
      amount,
      lockEnd,
      canWithdraw,
      // OUTAGE-AS-FREE. Defaulting a failed penalty read to 0n told the
      // staker their early exit was free while the contract took its real
      // cut. Unknown stays unknown, and the confirm button refuses to arm.
      penaltyBps: pen?.status === 'success' ? (pen.result as bigint) : null,
    });
  });

  // OUTAGE-AS-ZERO. A failed read collapses to tokenId 0n, which is also the
  // legitimate "no legacy position" value — so an RPC hiccup used to hide this
  // banner entirely and tell someone with a stranded stake that they had
  // nothing to withdraw. Track the failure separately and say so instead.
  const idsUnread = isConnected && !!address && !idReads.isLoading
    && (!idReads.data || idReads.data.some((r) => !r || r.status !== 'success'));
  const posUnread = !posReads.isLoading && LEGACY_STAKING_ADDRESSES.some(
    (_, i) => (ids[i] ?? 0n) > 0n && posReads.data?.[i * 2]?.status !== 'success',
  );
  const legacyUnread = idsUnread || posUnread;

  if (!isConnected) return null;
  if (positions.length === 0 && legacyUnread) {
    return (
      <div
        className="mb-8 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-[13px] text-amber-100"
        data-testid="legacy-staking-exit-unread"
      >
        We could not check the retired staking contracts just now — the network did
        not answer. If you have a position stranded in one, it is still there and
        still yours; this check failing does not move or forfeit anything. Reload
        to try again before concluding you have nothing to withdraw.
      </div>
    );
  }
  if (positions.length === 0) return null;

  const exit = (p: LegacyPosition & { idx: number }) => {
    setActiveIdx(p.idx);
    writeContract({
      address: p.contractAddr,
      abi: TEGRIDY_STAKING_ABI,
      functionName: p.canWithdraw ? 'withdraw' : 'earlyWithdraw',
      args: [p.tokenId],
      // The legacy staking contracts exist on mainnet only. Unpinned, a wallet
      // parked on Base/Robinhood would sign this against a codeless address —
      // a successful no-op whose receipt then reads as a confirmed withdrawal.
      chainId: CHAIN_ID,
    });
  };

  return (
    <m.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="relative overflow-hidden mb-8 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 md:p-5"
      data-testid="legacy-staking-exit"
    >
      {/* Art behind the notice. The amber wash stays on top so this still reads
          as a warning, not a decorative card. Pickable as `legacy-exit:0`. */}
      <div className="absolute inset-0 -z-10" aria-hidden="true">
        <ArtImg pageId="legacy-exit" idx={0} alt="" loading="lazy" className="w-full h-full object-cover" />
        <div className="absolute inset-0" style={{ background: 'linear-gradient(135deg, rgba(245,158,11,0.16), rgba(6,12,26,0.88))' }} />
      </div>
      <div className="text-amber-300 text-[13px] font-semibold uppercase tracking-wider mb-1">
        Legacy staking position found
      </div>
      <p className="text-white/70 text-[13px] mb-3">
        This wallet has TOWELI in a retired staking contract from before the relaunch. That
        contract is no longer part of the app — withdraw your funds below (they stay yours either
        way; this is just the exit).
      </p>
      <div className="flex flex-col gap-3">
        {positions.map((p) => {
          const busy = (isPending || isConfirming) && activeIdx === p.idx;
          const amountLabel = `${Number(formatEther(p.amount)).toLocaleString()} TOWELI`;
          return (
            <div
              key={p.contractAddr}
              className="flex flex-col md:flex-row md:items-center gap-2 md:gap-4 justify-between rounded-lg bg-black/30 px-3 py-2.5"
            >
              <div className="min-w-0">
                <div className="text-white text-[14px] font-medium">{amountLabel}</div>
                <a
                  href={`https://etherscan.io/address/${p.contractAddr}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-white/40 text-[11px] hover:text-white/70 transition-colors"
                >
                  {p.contractAddr.slice(0, 6)}…{p.contractAddr.slice(-4)} ↗
                </a>
                {!p.canWithdraw && (
                  <div className="text-amber-300/80 text-[11px] mt-0.5">
                    Locked until {new Date(Number(p.lockEnd) * 1000).toLocaleDateString()} — early
                    withdrawal pays {p.penaltyBps === null
                      ? 'a penalty whose rate could not be read just now'
                      : `a ${(Number(p.penaltyBps) / 100).toFixed(0)}% penalty`}
                  </div>
                )}
              </div>
              {p.canWithdraw ? (
                <button
                  onClick={() => exit(p)}
                  disabled={isPending || isConfirming}
                  className="btn-primary px-5 py-2.5 min-h-[44px] text-[13px] whitespace-nowrap"
                >
                  {busy ? 'Confirming…' : `Withdraw ${amountLabel}`}
                </button>
              ) : confirmingIdx === p.idx ? (
                <button
                  onClick={() => exit(p)}
                  disabled={isPending || isConfirming || p.penaltyBps === null}
                  className="btn-primary px-5 py-2.5 min-h-[44px] text-[13px] whitespace-nowrap disabled:opacity-50"
                  title={p.penaltyBps === null
                    ? 'The penalty rate could not be read from the contract. Reload before exiting early — do not sign a cost you cannot see.'
                    : undefined}
                >
                  {busy
                    ? 'Confirming…'
                    : p.penaltyBps === null
                      ? 'Penalty unknown — reload'
                      : `Confirm −${(Number(p.penaltyBps) / 100).toFixed(0)}% penalty`}
                </button>
              ) : (
                <button
                  onClick={() => setConfirmingIdx(p.idx)}
                  disabled={isPending || isConfirming}
                  className="btn-outline px-5 py-2.5 min-h-[44px] text-[13px] whitespace-nowrap"
                >
                  Early withdraw
                </button>
              )}
            </div>
          );
        })}
      </div>
    </m.div>
  );
}
