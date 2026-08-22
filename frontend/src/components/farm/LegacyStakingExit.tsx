import { useEffect, useState } from 'react';
import { m } from 'framer-motion';
import { useAccount, useReadContracts, useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import type { Address } from 'viem';
import { formatEther } from 'viem';
import { LEGACY_STAKING_ADDRESSES } from '../../lib/constants';
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
  penaltyBps: bigint;
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
    })),
    query: { enabled: isConnected && !!address },
  });

  const ids: bigint[] = LEGACY_STAKING_ADDRESSES.map((_, i) => {
    const r = idReads.data?.[i];
    return r?.status === 'success' ? (r.result as bigint) : 0n;
  });

  const posReads = useReadContracts({
    contracts: LEGACY_STAKING_ADDRESSES.flatMap((c, i) => [
      { address: c as Address, abi: TEGRIDY_STAKING_ABI, functionName: 'getPosition' as const, args: [ids[i]] as const },
      { address: c as Address, abi: PENALTY_ABI, functionName: 'EARLY_WITHDRAWAL_PENALTY_BPS' as const },
    ]),
    query: { enabled: ids.some((id) => id > 0n) },
  });

  const { writeContract, data: txHash, isPending, reset } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash: txHash });

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
      penaltyBps: pen?.status === 'success' ? (pen.result as bigint) : 0n,
    });
  });

  if (!isConnected || positions.length === 0) return null;

  const exit = (p: LegacyPosition & { idx: number }) => {
    setActiveIdx(p.idx);
    writeContract({
      address: p.contractAddr,
      abi: TEGRIDY_STAKING_ABI,
      functionName: p.canWithdraw ? 'withdraw' : 'earlyWithdraw',
      args: [p.tokenId],
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
                    withdrawal pays a {(Number(p.penaltyBps) / 100).toFixed(0)}% penalty
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
                  disabled={isPending || isConfirming}
                  className="btn-primary px-5 py-2.5 min-h-[44px] text-[13px] whitespace-nowrap"
                >
                  {busy ? 'Confirming…' : `Confirm −${(Number(p.penaltyBps) / 100).toFixed(0)}% penalty`}
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
