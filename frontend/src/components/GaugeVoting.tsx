import { useState, useEffect, useMemo } from 'react';
import { useAccount, useReadContract, useReadContracts, useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { formatEther, type Address } from 'viem';
import { motion } from 'framer-motion';
import { toast } from 'sonner';
import { GAUGE_CONTROLLER_ADDRESS, TEGRIDY_STAKING_ADDRESS, isDeployed } from '../lib/constants';
import { GAUGE_CONTROLLER_ABI, TEGRIDY_STAKING_ABI } from '../lib/contracts';
import { formatTokenAmount, shortenAddress } from '../lib/formatting';
import { InfoTooltip } from './ui/InfoTooltip';

const CARD_BG = 'rgba(13, 21, 48, 0.6)';
const CARD_BORDER = 'var(--color-purple-12)';
const BPS = 10000;

function useCountdown(targetTimestamp: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const diff = Math.max(0, Math.floor((targetTimestamp * 1000 - now) / 1000));
  const d = Math.floor(diff / 86400);
  const h = Math.floor((diff % 86400) / 3600);
  const m = Math.floor((diff % 3600) / 60);
  const s = diff % 60;
  return `${d}d ${h}h ${m}m ${s}s`;
}

export function GaugeVoting() {
  const { address, isConnected } = useAccount();
  const [weights, setWeights] = useState<Record<string, number>>({});
  const { writeContract, data: txHash, isPending: isSigning } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash: txHash });

  // ─── Not Deployed Guard ──────────────────────────────────────
  if (!isDeployed(GAUGE_CONTROLLER_ADDRESS)) {
    return (
      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}
        className="rounded-2xl p-6 text-center" style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}` }}>
        <p className="text-white/50 text-sm">Gauge controller not deployed yet</p>
      </motion.div>
    );
  }

  // ─── Contract Reads ──────────────────────────────────────────
  const gcAddr = GAUGE_CONTROLLER_ADDRESS as Address;
  const { data: epochData } = useReadContract({ address: gcAddr, abi: GAUGE_CONTROLLER_ABI, functionName: 'currentEpoch' });
  const { data: budgetData } = useReadContract({ address: gcAddr, abi: GAUGE_CONTROLLER_ABI, functionName: 'emissionBudget' });
  const { data: gaugesData } = useReadContract({ address: gcAddr, abi: GAUGE_CONTROLLER_ABI, functionName: 'getGauges' });
  const { data: epochDuration } = useReadContract({ address: gcAddr, abi: GAUGE_CONTROLLER_ABI, functionName: 'EPOCH_DURATION' });
  const { data: genesisEpoch } = useReadContract({ address: gcAddr, abi: GAUGE_CONTROLLER_ABI, functionName: 'genesisEpoch' });

  const currentEpoch = epochData !== undefined ? Number(epochData) : undefined;
  const budget = budgetData !== undefined ? BigInt(budgetData) : undefined;
  const gauges: Address[] = (gaugesData as Address[]) ?? [];
  const duration = epochDuration !== undefined ? Number(epochDuration) : 604800;
  const genesis = genesisEpoch !== undefined ? Number(genesisEpoch) : 0;

  const nextEpochTimestamp = genesis && currentEpoch !== undefined ? genesis + (currentEpoch + 1) * duration : 0;
  const countdown = useCountdown(nextEpochTimestamp);

  // ─── Per-gauge weight/emission reads ─────────────────────────
  const gaugeContracts = useMemo(() => gauges.flatMap((g) => [
    { address: gcAddr, abi: GAUGE_CONTROLLER_ABI, functionName: 'getRelativeWeight' as const, args: [g] },
    { address: gcAddr, abi: GAUGE_CONTROLLER_ABI, functionName: 'getGaugeWeight' as const, args: [g] },
    { address: gcAddr, abi: GAUGE_CONTROLLER_ABI, functionName: 'getGaugeEmission' as const, args: [g] },
  ]), [gauges, gcAddr]);

  const { data: gaugeResults } = useReadContracts({ contracts: gaugeContracts });

  // ─── User staking position ──────────────────────────────────
  const { data: tokenIdData } = useReadContract({
    address: TEGRIDY_STAKING_ADDRESS as Address, abi: TEGRIDY_STAKING_ABI, functionName: 'userTokenId', args: address ? [address] : undefined,
    query: { enabled: !!address },
  });
  const tokenId = tokenIdData !== undefined ? BigInt(tokenIdData as bigint) : undefined;

  const { data: positionData } = useReadContract({
    address: TEGRIDY_STAKING_ADDRESS as Address, abi: TEGRIDY_STAKING_ABI, functionName: 'positions', args: tokenId !== undefined ? [tokenId] : undefined,
    query: { enabled: tokenId !== undefined && tokenId > 0n },
  });

  const { data: lastVotedData } = useReadContract({
    address: gcAddr, abi: GAUGE_CONTROLLER_ABI, functionName: 'lastVotedEpoch', args: tokenId !== undefined ? [tokenId] : undefined,
    query: { enabled: tokenId !== undefined && tokenId > 0n },
  });

  const position = positionData as readonly [bigint, bigint, bigint, bigint, number, number, boolean, boolean, bigint] | undefined;
  const votingPower = position ? (position[0] * BigInt(position[4])) / BigInt(BPS) : 0n;
  const hasVotedThisEpoch = lastVotedData !== undefined && currentEpoch !== undefined && Number(lastVotedData) === currentEpoch;

  // ─── Weight Allocation ──────────────────────────────────────
  const totalWeight = useMemo(() => Object.values(weights).reduce((a, b) => a + b, 0), [weights]);
  const remaining = BPS - totalWeight;

  const setGaugeWeight = (gauge: string, value: number) => {
    setWeights((prev) => {
      const next = { ...prev, [gauge]: value };
      const sum = Object.values(next).reduce((a, b) => a + b, 0);
      if (sum > BPS) next[gauge] = value - (sum - BPS);
      return next;
    });
  };

  // ─── Vote Handler ───────────────────────────────────────────
  const handleVote = () => {
    if (!tokenId || totalWeight !== BPS) return;
    const voteGauges = Object.keys(weights).filter((g) => (weights[g] ?? 0) > 0) as Address[];
    const voteWeights = voteGauges.map((g) => BigInt(weights[g] ?? 0));
    writeContract({
      address: gcAddr, abi: GAUGE_CONTROLLER_ABI, functionName: 'vote',
      args: [tokenId, voteGauges, voteWeights],
    });
  };

  useEffect(() => { if (isSuccess) toast.success('Vote cast successfully!'); }, [isSuccess]);

  // ─── Not Connected ──────────────────────────────────────────
  if (!isConnected) {
    return (
      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}
        className="rounded-2xl p-6 text-center" style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}` }}>
        <p className="text-white/50 text-sm">Connect wallet to vote on gauge emissions</p>
      </motion.div>
    );
  }

  return (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}
      className="space-y-4">
      {/* ── Header Stats ──────────────────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {[
          { label: 'Current Epoch', value: currentEpoch !== undefined ? `#${currentEpoch}` : '--', sub: `Next in ${countdown}` },
          { label: 'Emission Budget', value: budget !== undefined ? `${formatTokenAmount(formatEther(budget), 0)} TOWELI` : '--', sub: 'per epoch (7 days)' },
          { label: 'Active Gauges', value: `${gauges.length}`, sub: 'whitelisted pools' },
        ].map(({ label, value, sub }) => (
          <div key={label} className="rounded-xl p-4" style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}` }}>
            <p className="text-[11px] text-white/40 uppercase tracking-wider mb-1">{label}</p>
            <p className="text-lg font-semibold text-white">{value}</p>
            <p className="text-[11px] text-white/30 mt-0.5">{sub}</p>
          </div>
        ))}
      </div>

      {/* ── Gauge List ─────────────────────────────────────────── */}
      <div className="rounded-2xl overflow-hidden" style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}` }}>
        <div className="px-5 py-4 border-b border-white/5 flex items-center gap-2">
          <h3 className="text-sm font-semibold text-white">Gauge Weights</h3>
          <InfoTooltip text="Each gauge receives a share of TOWELI emissions proportional to its vote weight. Weights reset each epoch." />
        </div>
        {gauges.length === 0 ? (
          <p className="px-5 py-8 text-center text-white/30 text-sm">No gauges registered yet</p>
        ) : (
          <div className="divide-y divide-white/[0.04]">
            {gauges.map((gauge, i) => {
              const relWeight = gaugeResults?.[i * 3]?.result as bigint | undefined;
              const absWeight = gaugeResults?.[i * 3 + 1]?.result as bigint | undefined;
              const emission = gaugeResults?.[i * 3 + 2]?.result as bigint | undefined;
              const pct = relWeight !== undefined ? Number(relWeight) / 100 : 0;

              return (
                <motion.div key={gauge} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: i * 0.05 }}
                  className="px-5 py-3.5 flex flex-col sm:flex-row sm:items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-[13px] font-mono text-purple-300">{shortenAddress(gauge, 6)}</p>
                    <div className="mt-1.5 h-1.5 rounded-full bg-white/5 overflow-hidden">
                      <motion.div initial={{ width: 0 }} animate={{ width: `${Math.min(pct, 100)}%` }}
                        transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
                        className="h-full rounded-full bg-gradient-to-r from-purple-500 to-violet-400" />
                    </div>
                  </div>
                  <div className="flex items-center gap-5 text-right">
                    <div>
                      <p className="text-[10px] text-white/30 uppercase">Weight</p>
                      <p className="text-sm font-medium text-white">{absWeight !== undefined ? formatTokenAmount(formatEther(absWeight), 0) : '--'}</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-white/30 uppercase">Share</p>
                      <p className="text-sm font-medium text-purple-300">{pct.toFixed(1)}%</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-white/30 uppercase">Emission</p>
                      <p className="text-sm font-medium text-emerald-400">{emission !== undefined ? formatTokenAmount(formatEther(emission), 0) : '--'}</p>
                    </div>
                  </div>
                </motion.div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Vote Form ──────────────────────────────────────────── */}
      <div className="rounded-2xl overflow-hidden" style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}` }}>
        <div className="px-5 py-4 border-b border-white/5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-white">Cast Your Vote</h3>
              <InfoTooltip text="Allocate your voting power across gauges. Weights must sum to 100%. One vote per epoch per staking position." />
            </div>
            {votingPower > 0n && (
              <span className="text-[11px] text-white/40">
                Voting Power: <span className="text-purple-300 font-medium">{formatTokenAmount(formatEther(votingPower), 2)}</span>
              </span>
            )}
          </div>
        </div>
        <div className="p-5 space-y-4">
          {!tokenId || tokenId === 0n ? (
            <p className="text-center text-white/40 text-sm py-4">Stake TOWELI first to gain voting power</p>
          ) : hasVotedThisEpoch ? (
            <div className="text-center py-4">
              <div className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
                <svg className="w-4 h-4 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
                <span className="text-sm text-emerald-300">You have already voted this epoch</span>
              </div>
            </div>
          ) : gauges.length === 0 ? (
            <p className="text-center text-white/40 text-sm py-4">No gauges available to vote on</p>
          ) : (
            <>
              <div className="space-y-3">
                {gauges.map((gauge) => {
                  const w = weights[gauge] ?? 0;
                  return (
                    <div key={gauge} className="flex items-center gap-3">
                      <span className="text-[12px] font-mono text-white/60 w-28 truncate">{shortenAddress(gauge, 5)}</span>
                      <input type="range" min={0} max={BPS} step={100} value={w}
                        onChange={(e) => setGaugeWeight(gauge, Number(e.target.value))}
                        className="flex-1 h-1.5 rounded-full appearance-none cursor-pointer accent-purple-500"
                        style={{ background: `linear-gradient(to right, rgb(139 92 246) ${(w / BPS) * 100}%, rgba(255,255,255,0.08) ${(w / BPS) * 100}%)` }} />
                      <span className="text-sm font-medium text-white/80 w-16 text-right">{(w / 100).toFixed(0)}%</span>
                    </div>
                  );
                })}
              </div>
              <div className="flex items-center justify-between pt-2 border-t border-white/5">
                <span className={`text-[12px] font-medium ${remaining === 0 ? 'text-emerald-400' : remaining < 0 ? 'text-red-400' : 'text-white/40'}`}>
                  {remaining === 0 ? 'Fully allocated' : `${(remaining / 100).toFixed(0)}% remaining`}
                </span>
                <button onClick={handleVote} disabled={totalWeight !== BPS || isSigning || isConfirming}
                  className="px-5 py-2.5 rounded-xl text-sm font-semibold transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed"
                  style={{
                    background: totalWeight === BPS ? 'linear-gradient(135deg, rgb(16 185 129), rgb(5 150 105))' : 'rgba(255,255,255,0.06)',
                    color: totalWeight === BPS ? 'white' : 'rgba(255,255,255,0.3)',
                    boxShadow: totalWeight === BPS ? '0 4px 15px rgba(16, 185, 129, 0.3)' : 'none',
                  }}>
                  {isSigning ? 'Signing...' : isConfirming ? 'Confirming...' : 'Cast Vote'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </motion.div>
  );
}
