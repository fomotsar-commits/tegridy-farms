import { useState, useEffect, useMemo, useCallback } from 'react';
import { useAccount, useReadContract, useReadContracts, useWriteContract, useWaitForTransactionReceipt, useChainId } from 'wagmi';
import { formatEther, keccak256, encodeAbiParameters, toHex, type Address, type Hex } from 'viem';
import { m } from 'framer-motion';
import { toast } from 'sonner';
import { GAUGE_CONTROLLER_ADDRESS, TEGRIDY_STAKING_ADDRESS, isDeployed } from '../lib/constants';
import { GAUGE_CONTROLLER_ABI, TEGRIDY_STAKING_ABI } from '../lib/contracts';
import { formatTokenAmount, shortenAddress } from '../lib/formatting';
import { InfoTooltip } from './ui/InfoTooltip';
import { surfaceTxError } from '../lib/txErrors';
import { pageArt } from '../lib/artConfig';

const GAUGE_STAT_ARTS = [pageArt('gauge-voting', 0), pageArt('gauge-voting', 1), pageArt('gauge-voting', 2)];

// ─── Commit-Reveal Local Storage ────────────────────────────────────
// We persist {salt, gauges, weights, commitmentHash} per (chainId, voter, tokenId, epoch)
// so the user can close the tab between commit and reveal and still reveal.
type CommitmentRecord = {
  salt: Hex;
  gauges: Address[];
  weights: string[];       // stored as strings because JSON can't hold bigint
  commitmentHash: Hex;
  commitTx?: Hex;
  committedAt: number;     // unix seconds
};

const COMMITMENT_KEY = (chainId: number, voter: Address, tokenId: bigint, epoch: number) =>
  `tegridy:gaugeCommit:${chainId}:${voter.toLowerCase()}:${tokenId.toString()}:${epoch}`;

function loadCommitment(key: string): CommitmentRecord | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as CommitmentRecord) : null;
  } catch {
    return null;
  }
}

function saveCommitment(key: string, record: CommitmentRecord) {
  try { localStorage.setItem(key, JSON.stringify(record)); }
  catch (err) { console.warn('[GaugeVoting] commitment persist failed', err); }
}

function clearCommitment(key: string) {
  try { localStorage.removeItem(key); } catch { /* noop */ }
}

/// Client-side mirror of GaugeController.computeCommitment() — must match
/// the Solidity `keccak256(abi.encode(voter, tokenId, gauges, weights, salt, epoch))`.
function buildCommitmentHash(
  voter: Address, tokenId: bigint, gauges: Address[], weights: bigint[], salt: Hex, epoch: bigint,
): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'address' },
        { type: 'uint256' },
        { type: 'address[]' },
        { type: 'uint256[]' },
        { type: 'bytes32' },
        { type: 'uint256' },
      ],
      [voter, tokenId, gauges, weights, salt, epoch],
    ),
  );
}

function generateSalt(): Hex {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

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
  const chainId = useChainId();
  const [weights, setWeights] = useState<Record<string, number>>({});
  // mode: 'commit' = two-step commit-reveal (default; H-2 mitigation),
  //       'legacy' = one-step vote() kept only for emergencies.
  const [mode, setMode] = useState<'commit' | 'legacy'>('commit');
  const { writeContract, data: txHash, isPending: isSigning } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash: txHash });

  // ─── Not Deployed Guard ──────────────────────────────────────
  if (!isDeployed(GAUGE_CONTROLLER_ADDRESS)) {
    return (
      <m.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}
        className="rounded-2xl p-6 text-center relative overflow-hidden" style={{ border: `1px solid ${CARD_BORDER}` }}>
        <div className="absolute inset-0">
          <img src={pageArt('gauge-voting', 3).src} alt="" loading="lazy" className="w-full h-full object-cover" />
        </div>
        <p className="text-white/80 text-sm relative z-10" style={{ textShadow: '0 1px 4px rgba(0,0,0,0.85)' }}>Gauge controller not deployed yet</p>
      </m.div>
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

  // Reveal window state (commit-reveal gate)
  const { data: revealWindowData, refetch: refetchRevealWindow } = useReadContract({
    address: gcAddr, abi: GAUGE_CONTROLLER_ABI, functionName: 'isRevealWindowOpen',
  });

  // Commitment on-chain (present if user has committed for this epoch)
  const { data: onchainCommitment } = useReadContract({
    address: gcAddr, abi: GAUGE_CONTROLLER_ABI, functionName: 'commitmentOf',
    args: tokenId !== undefined && currentEpoch !== undefined ? [tokenId, BigInt(currentEpoch)] : undefined,
    query: { enabled: tokenId !== undefined && tokenId > 0n && currentEpoch !== undefined },
  });

  const position = positionData as readonly [bigint, bigint, bigint, bigint, number, number, boolean, boolean, bigint] | undefined;
  const votingPower = position ? (position[0] * BigInt(position[4])) / BigInt(BPS) : 0n;
  const hasVotedThisEpoch = lastVotedData !== undefined && currentEpoch !== undefined && Number(lastVotedData) === currentEpoch;

  const rw = revealWindowData as readonly [bigint, boolean, bigint, bigint] | undefined;
  const revealOpen = rw?.[1] ?? false;
  const revealOpensAt = rw ? Number(rw[2]) : 0;
  const hasOnchainCommitment = onchainCommitment && (onchainCommitment as Hex) !== '0x0000000000000000000000000000000000000000000000000000000000000000';

  // localStorage for the commitment reveal secret
  const commitmentKey = useMemo(() => {
    if (!address || tokenId === undefined || tokenId === 0n || currentEpoch === undefined) return null;
    return COMMITMENT_KEY(chainId, address as Address, tokenId, currentEpoch);
  }, [chainId, address, tokenId, currentEpoch]);

  const [localCommitment, setLocalCommitment] = useState<CommitmentRecord | null>(null);
  useEffect(() => {
    if (!commitmentKey) { setLocalCommitment(null); return; }
    setLocalCommitment(loadCommitment(commitmentKey));
  }, [commitmentKey, txHash, isSuccess]);

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

  // ─── Legacy Vote Handler (one-step) ─────────────────────────
  const handleLegacyVote = () => {
    if (!tokenId || totalWeight !== BPS) return;
    const voteGauges = Object.keys(weights).filter((g) => (weights[g] ?? 0) > 0) as Address[];
    const voteWeights = voteGauges.map((g) => BigInt(weights[g] ?? 0));
    try {
      writeContract({
        address: gcAddr, abi: GAUGE_CONTROLLER_ABI, functionName: 'vote',
        args: [tokenId, voteGauges, voteWeights],
      });
    } catch (err) {
      surfaceTxError(err, toast, { component: 'GaugeVoting.legacy' });
    }
  };

  // ─── Commit Handler (step 1 of commit-reveal) ───────────────
  const handleCommit = useCallback(() => {
    if (!tokenId || !address || currentEpoch === undefined || !commitmentKey || totalWeight !== BPS) return;
    const voteGauges = Object.keys(weights).filter((g) => (weights[g] ?? 0) > 0) as Address[];
    const voteWeights = voteGauges.map((g) => BigInt(weights[g] ?? 0));
    const salt = generateSalt();
    const commitmentHash = buildCommitmentHash(
      address as Address, tokenId, voteGauges, voteWeights, salt, BigInt(currentEpoch),
    );
    // Persist BEFORE broadcasting — if the user closes the tab after signing
    // but before the tx confirms, they still have the salt to reveal later.
    saveCommitment(commitmentKey, {
      salt, gauges: voteGauges, weights: voteWeights.map((w) => w.toString()),
      commitmentHash, committedAt: Math.floor(Date.now() / 1000),
    });
    setLocalCommitment(loadCommitment(commitmentKey));
    try {
      writeContract({
        address: gcAddr, abi: GAUGE_CONTROLLER_ABI, functionName: 'commitVote',
        args: [tokenId, commitmentHash],
      });
    } catch (err) {
      surfaceTxError(err, toast, { component: 'GaugeVoting.commit' });
    }
  }, [tokenId, address, currentEpoch, commitmentKey, totalWeight, weights, writeContract, gcAddr]);

  // ─── Reveal Handler (step 2 of commit-reveal) ───────────────
  const handleReveal = useCallback(() => {
    if (!tokenId || !localCommitment) return;
    const gaugesToReveal = localCommitment.gauges;
    const weightsToReveal = localCommitment.weights.map((w) => BigInt(w));
    try {
      writeContract({
        address: gcAddr, abi: GAUGE_CONTROLLER_ABI, functionName: 'revealVote',
        args: [tokenId, gaugesToReveal, weightsToReveal, localCommitment.salt],
      });
    } catch (err) {
      surfaceTxError(err, toast, { component: 'GaugeVoting.reveal' });
    }
  }, [tokenId, localCommitment, writeContract, gcAddr]);

  // On confirm: toast, clear localStorage if reveal just landed, refetch window state.
  useEffect(() => {
    if (!isSuccess) return;
    toast.success('Transaction confirmed');
    refetchRevealWindow();
    // If the user just revealed (hasVotedThisEpoch becomes true via chain read),
    // clean up the local commitment record since it's no longer useful.
    if (hasVotedThisEpoch && commitmentKey) {
      clearCommitment(commitmentKey);
      setLocalCommitment(null);
    }
  }, [isSuccess, hasVotedThisEpoch, commitmentKey, refetchRevealWindow]);

  // ─── Not Connected ──────────────────────────────────────────
  if (!isConnected) {
    return (
      <m.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}
        className="rounded-2xl p-6 text-center relative overflow-hidden" style={{ border: `1px solid ${CARD_BORDER}` }}>
        <div className="absolute inset-0">
          <img src={pageArt('gauge-voting', 4).src} alt="" loading="lazy" className="w-full h-full object-cover" />
        </div>
        <p className="text-white/80 text-sm relative z-10" style={{ textShadow: '0 1px 4px rgba(0,0,0,0.85)' }}>Connect wallet to vote on gauge emissions</p>
      </m.div>
    );
  }

  return (
    <m.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}
      className="space-y-4">
      {/* ── Header Stats ──────────────────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {[
          { label: 'Current Epoch', value: currentEpoch !== undefined ? `#${currentEpoch}` : '--', sub: `Next in ${countdown}` },
          { label: 'Emission Budget', value: budget !== undefined ? `${formatTokenAmount(formatEther(budget), 0)} TOWELI` : '--', sub: 'per epoch (7 days)' },
          { label: 'Active Gauges', value: `${gauges.length}`, sub: 'whitelisted pools' },
        ].map(({ label, value, sub }, i) => (
          <div key={label} className="rounded-xl relative overflow-hidden" style={{ border: `1px solid ${CARD_BORDER}` }}>
            <div className="absolute inset-0">
              <img src={GAUGE_STAT_ARTS[i % GAUGE_STAT_ARTS.length]!.src} alt="" loading="lazy" className="w-full h-full object-cover" />
                </div>
            <div className="relative z-10 p-4">
              <p className="text-[11px] text-white/60 uppercase tracking-wider mb-1" style={{ textShadow: '0 1px 4px rgba(0,0,0,0.85)' }}>{label}</p>
              <p className="text-lg font-semibold text-white" style={{ textShadow: '0 1px 4px rgba(0,0,0,0.9)' }}>{value}</p>
              <p className="text-[11px] text-white/60 mt-0.5" style={{ textShadow: '0 1px 4px rgba(0,0,0,0.85)' }}>{sub}</p>
            </div>
          </div>
        ))}
      </div>

      {/* ── Gauge List ─────────────────────────────────────────── */}
      <div className="rounded-2xl overflow-hidden relative" style={{ border: `1px solid ${CARD_BORDER}` }}>
        <div className="absolute inset-0">
          <img src={pageArt('gauge-voting', 5).src} alt="" loading="lazy" className="w-full h-full object-cover" />
        </div>
        <div className="relative z-10">
        <div className="px-5 py-4 border-b border-white/10 flex items-center gap-2">
          <h3 className="text-sm font-semibold text-white" style={{ textShadow: '0 1px 4px rgba(0,0,0,0.9)' }}>Gauge Weights</h3>
          <InfoTooltip text="Each gauge receives a share of TOWELI emissions proportional to its vote weight. Weights reset each epoch." />
        </div>
        {gauges.length === 0 ? (
          <p className="px-5 py-8 text-center text-white/60 text-sm" style={{ textShadow: '0 1px 4px rgba(0,0,0,0.85)' }}>No gauges registered yet</p>
        ) : (
          <div className="divide-y divide-white/[0.04]">
            {gauges.map((gauge, i) => {
              const relWeight = gaugeResults?.[i * 3]?.result as bigint | undefined;
              const absWeight = gaugeResults?.[i * 3 + 1]?.result as bigint | undefined;
              const emission = gaugeResults?.[i * 3 + 2]?.result as bigint | undefined;
              const pct = relWeight !== undefined ? Number(relWeight) / 100 : 0;

              return (
                <m.div key={gauge} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: i * 0.05 }}
                  className="px-5 py-3.5 flex flex-col sm:flex-row sm:items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-[13px] font-mono text-purple-300">{shortenAddress(gauge, 6)}</p>
                    <div className="mt-1.5 h-1.5 rounded-full bg-white/5 overflow-hidden">
                      <m.div initial={{ width: 0 }} animate={{ width: `${Math.min(pct, 100)}%` }}
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
                </m.div>
              );
            })}
          </div>
        )}
        </div>
      </div>

      {/* ── Commit-Reveal State Banner ─────────────────────────── */}
      {tokenId !== undefined && tokenId > 0n && hasOnchainCommitment && !hasVotedThisEpoch && (
        <div className="rounded-xl p-4" style={{ background: 'rgba(245, 228, 184, 0.08)', border: '1px solid rgba(245, 228, 184, 0.25)' }}>
          <div className="flex items-start gap-3">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#f5e4b8" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="mt-0.5 flex-shrink-0">
              <circle cx="12" cy="12" r="9" />
              <polyline points="12 7 12 12 15 14" />
            </svg>
            <div className="flex-1 text-[12px] text-white/80 leading-relaxed">
              <p className="font-semibold mb-1" style={{ color: '#f5e4b8' }}>Pending reveal — your commitment is stored on-chain.</p>
              {revealOpen ? (
                <p>The reveal window is open. Click <span className="font-mono">Reveal Vote</span> below to finalise your vote before the epoch ends.</p>
              ) : (
                <p>Reveal opens in <span className="font-mono">{useCountdown(revealOpensAt)}</span>. Keep this browser's <span className="font-mono">localStorage</span> intact, or export the salt before then.</p>
              )}
              {!localCommitment && (
                <p className="mt-2 text-red-300">⚠ On-chain commitment found but no local salt to reveal it. You may have committed from a different browser or cleared local data. Without the salt this vote cannot be revealed.</p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Vote Form ──────────────────────────────────────────── */}
      <div className="rounded-2xl overflow-hidden relative" style={{ border: `1px solid ${CARD_BORDER}` }}>
        <div className="absolute inset-0">
          <img src={pageArt('gauge-voting', 6).src} alt="" loading="lazy" className="w-full h-full object-cover" />
        </div>
        <div className="relative z-10">
        <div className="px-5 py-4 border-b border-white/10">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-white" style={{ textShadow: '0 1px 4px rgba(0,0,0,0.9)' }}>Cast Your Vote</h3>
              <InfoTooltip text="Allocate your voting power across gauges. Commit-reveal is enabled by default to prevent bribe arbitrage — your chosen gauges are hidden until the reveal window opens at the end of each epoch." />
            </div>
            <div className="flex items-center gap-3">
              {/* Mode toggle */}
              {!hasOnchainCommitment && !hasVotedThisEpoch && tokenId !== undefined && tokenId > 0n && (
                <div className="inline-flex rounded-lg p-0.5" style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.08)' }}>
                  <button
                    type="button"
                    onClick={() => setMode('commit')}
                    className={`px-2.5 py-1 rounded text-[11px] font-medium transition-colors ${mode === 'commit' ? 'bg-purple-500/30 text-white' : 'text-white/50 hover:text-white/80'}`}
                    aria-pressed={mode === 'commit'}
                  >
                    Commit-reveal
                  </button>
                  <button
                    type="button"
                    onClick={() => setMode('legacy')}
                    className={`px-2.5 py-1 rounded text-[11px] font-medium transition-colors ${mode === 'legacy' ? 'bg-red-500/30 text-white' : 'text-white/50 hover:text-white/80'}`}
                    aria-pressed={mode === 'legacy'}
                    title="Legacy one-step vote. Exposes your choice in the mempool; do not use unless absolutely necessary."
                  >
                    Legacy
                  </button>
                </div>
              )}
              {votingPower > 0n && (
                <span className="text-[11px] text-white/70">
                  VP: <span className="text-purple-300 font-medium">{formatTokenAmount(formatEther(votingPower), 2)}</span>
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="p-5 space-y-4">
          {!tokenId || tokenId === 0n ? (
            <p className="text-center text-white/70 text-sm py-4">Stake TOWELI first to gain voting power</p>
          ) : hasVotedThisEpoch ? (
            <div className="text-center py-4">
              <div className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
                <svg className="w-4 h-4 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
                <span className="text-sm text-emerald-300">Vote recorded for this epoch</span>
              </div>
            </div>
          ) : hasOnchainCommitment && localCommitment ? (
            // Reveal flow: skip the weight sliders, show the reveal summary.
            <div className="space-y-4">
              <div className="rounded-lg p-3" style={{ background: 'rgba(0,0,0,0.25)' }}>
                <p className="text-[11px] text-white/50 uppercase tracking-wider mb-2">Your committed ballot</p>
                <ul className="space-y-1 text-[12px] font-mono text-white/80">
                  {localCommitment.gauges.map((g, i) => (
                    <li key={g} className="flex justify-between">
                      <span>{shortenAddress(g, 5)}</span>
                      <span className="text-purple-300">{(Number(localCommitment.weights[i]) / 100).toFixed(0)}%</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-white/50">
                  {revealOpen ? 'Reveal window is open' : 'Reveal window closed — wait until end of epoch'}
                </span>
                <button
                  onClick={handleReveal}
                  disabled={!revealOpen || isSigning || isConfirming}
                  className="px-5 py-2.5 rounded-xl text-sm font-semibold transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed"
                  style={{
                    background: revealOpen ? 'linear-gradient(135deg, rgb(139 92 246), rgb(124 58 237))' : 'rgba(255,255,255,0.06)',
                    color: 'white',
                    boxShadow: revealOpen ? '0 4px 15px rgba(139, 92, 246, 0.35)' : 'none',
                  }}>
                  {isSigning ? 'Signing…' : isConfirming ? 'Revealing…' : 'Reveal Vote'}
                </button>
              </div>
            </div>
          ) : gauges.length === 0 ? (
            <p className="text-center text-white/70 text-sm py-4">No gauges available to vote on</p>
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
                <span className={`text-[12px] font-medium ${remaining === 0 ? 'text-emerald-400' : remaining < 0 ? 'text-red-400' : 'text-white/70'}`}>
                  {remaining === 0 ? 'Fully allocated' : `${(remaining / 100).toFixed(0)}% remaining`}
                </span>
                <button
                  onClick={mode === 'commit' ? handleCommit : handleLegacyVote}
                  disabled={totalWeight !== BPS || isSigning || isConfirming || (mode === 'commit' && revealOpen)}
                  title={mode === 'commit' && revealOpen ? 'Commit window is closed — reveal window is open. Wait for the next epoch to commit.' : undefined}
                  className="px-5 py-2.5 rounded-xl text-sm font-semibold transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed"
                  style={{
                    background: totalWeight === BPS ? (mode === 'commit' ? 'linear-gradient(135deg, rgb(139 92 246), rgb(124 58 237))' : 'linear-gradient(135deg, rgb(220 38 38), rgb(185 28 28))') : 'rgba(255,255,255,0.06)',
                    color: totalWeight === BPS ? 'white' : 'rgba(255,255,255,0.3)',
                    boxShadow: totalWeight === BPS ? (mode === 'commit' ? '0 4px 15px rgba(139, 92, 246, 0.3)' : '0 4px 15px rgba(220, 38, 38, 0.3)') : 'none',
                  }}>
                  {isSigning ? 'Check wallet…' : isConfirming ? 'Confirming…' : mode === 'commit' ? 'Commit Vote' : 'Cast Vote (Legacy)'}
                </button>
              </div>
            </>
          )}
        </div>
        </div>
      </div>
    </m.div>
  );
}
