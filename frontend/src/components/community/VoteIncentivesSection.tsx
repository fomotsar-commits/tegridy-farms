import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  useAccount, useReadContract, useReadContracts, useWriteContract,
  useWaitForTransactionReceipt, useChainId,
} from 'wagmi';
import {
  formatEther, formatUnits, parseEther, parseUnits, keccak256,
  encodeAbiParameters, toHex, type Address, type Hex,
} from 'viem';
import { VOTE_INCENTIVES_ADDRESS, TEGRIDY_STAKING_ADDRESS } from '../../lib/constants';
import { VOTE_INCENTIVES_ABI, TEGRIDY_STAKING_ABI } from '../../lib/contracts';
import { useBribes, type WhitelistedToken } from '../../hooks/useBribes';
import { useGaugeList, type GaugeInfo } from '../../hooks/useGaugeList';
import { shortenAddress, formatTokenAmount } from '../../lib/formatting';
import { InfoTooltip } from '../ui/InfoTooltip';
import { GOVERNANCE_COPY } from '../../lib/copy';
import { pageArt } from '../../lib/artConfig';
import { ArtImg } from '../ArtImg';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;
const CARD_BORDER = 'var(--color-purple-12)';
const STAT_ARTS = [pageArt('vote-incentives', 0), pageArt('vote-incentives', 1), pageArt('vote-incentives', 2)];
const DEFAULT_VOTE_DEADLINE_SEC = 7 * 24 * 60 * 60;
const DEPOSIT_CARD_ID = 'vi-deposit';
const LEADERBOARD_ID = 'vi-leaderboard';
const COMMIT_RATIO_BPS = 4000; // Mirrors on-chain constant (40% of VOTE_DEADLINE)
const CLAIM_LOOKBACK_EPOCHS = 5;
const HISTORY_LOOKBACK_EPOCHS = 10;
const RESCUE_WARN_THRESHOLD_SEC = 7 * 24 * 60 * 60; // 7 days before rescue window closes

type SortKey = 'bribe' | 'votes' | 'yours' | 'claimable';
type EpochBribe = { token: Address; amount: bigint };

interface PairBribeSummary {
  pair: Address;
  bribes: EpochBribe[];
  ethAmount: bigint;
  tokenCount: number;
  /** Sum of ETH bribes across the last HISTORY_LOOKBACK_EPOCHS scanned. */
  historicalEthAmount: bigint;
}

interface PairClaimable {
  pair: Address;
  tokens: Address[];
  amounts: bigint[];
  total: bigint;
  epochs: number[];
}

// ─── Helpers ────────────────────────────────────────────────────────
function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
}

function scrollTo(id: string) {
  if (typeof document === 'undefined') return;
  const el = document.getElementById(id);
  el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ─── Commit-reveal persistence (localStorage) ──────────────────────
// Store per-commit payloads so a user who reloads between commit and reveal
// doesn't lose the salt/pair/power that the contract needs to validate.
interface CommitRecord {
  salt: Hex;
  pair: Address;
  power: string; // store as string to keep JSON bigint-safe; parse on reveal
  commitHash: Hex;
  commitIndex: number;
  committedAt: number;
}
const COMMIT_KEY = (chainId: number, voter: Address, epoch: number) =>
  `tegridy:viCommit:${chainId}:${voter.toLowerCase()}:${epoch}`;

function loadCommits(key: string): CommitRecord[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveCommits(key: string, records: CommitRecord[]) {
  try { localStorage.setItem(key, JSON.stringify(records)); } catch { /* private mode */ }
}

function generateSalt(): Hex {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

/** Mirrors VoteIncentives.computeCommitHash — must match exactly. */
function buildCommitHash(
  chainId: number, contract: Address, user: Address,
  epoch: number, pair: Address, power: bigint, salt: Hex,
): Hex {
  return keccak256(encodeAbiParameters(
    [
      { type: 'uint256' }, { type: 'address' }, { type: 'address' },
      { type: 'uint256' }, { type: 'address' }, { type: 'uint256' }, { type: 'bytes32' },
    ],
    [BigInt(chainId), contract, user, BigInt(epoch), pair, power, salt],
  ));
}

// ─── Persona lead cards ────────────────────────────────────────────
function PersonaCards() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      <button
        onClick={() => scrollTo(DEPOSIT_CARD_ID)}
        className="group text-left rounded-2xl p-5 relative overflow-hidden transition-all hover:scale-[1.01]"
        style={{ background: 'rgba(16,185,129,0.10)', border: '1px solid rgba(16,185,129,0.35)' }}
      >
        <div className="flex items-start justify-between gap-3 mb-2">
          <span className="text-[10px] uppercase tracking-wider font-bold text-emerald-300">For projects</span>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-emerald-300 group-hover:translate-x-0.5 transition-transform"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
        </div>
        <p className="text-white text-[17px] font-semibold mb-1.5 leading-snug">Earn votes on your pair →</p>
        <p className="text-white/75 text-[12.5px] leading-relaxed">
          Post ETH or tokens as a bribe. Voters will allocate their power to your gauge to claim it.
          Your pool gets TOWELI emissions; you mint nothing.
        </p>
        <p className="text-[11px] text-emerald-300/90 mt-3 font-medium">Jump to Deposit →</p>
      </button>

      <button
        onClick={() => scrollTo(LEADERBOARD_ID)}
        className="group text-left rounded-2xl p-5 relative overflow-hidden transition-all hover:scale-[1.01]"
        style={{ background: 'rgba(139,92,246,0.10)', border: '1px solid rgba(139,92,246,0.35)' }}
      >
        <div className="flex items-start justify-between gap-3 mb-2">
          <span className="text-[10px] uppercase tracking-wider font-bold text-purple-300">For voters</span>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-purple-300 group-hover:translate-x-0.5 transition-transform"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
        </div>
        <p className="text-white text-[17px] font-semibold mb-1.5 leading-snug">Get paid for your votes →</p>
        <p className="text-white/75 text-[12.5px] leading-relaxed">
          Stake TOWELI for voting power, then allocate it to a pair. You earn its bribes pro-rata at epoch end.
        </p>
        <p className="text-[11px] text-purple-300/90 mt-3 font-medium">Jump to Gauges →</p>
      </button>
    </div>
  );
}

// ─── Pending fee-change banner ─────────────────────────────────────
function PendingFeeBanner({ current, pending, executeAt, now }: {
  current: number; pending: number; executeAt: number; now: number;
}) {
  if (executeAt === 0 || pending === 0 || pending === current) return null;
  const remaining = Math.max(0, executeAt - now);
  const direction = pending > current ? 'up' : 'down';
  return (
    <div className="rounded-xl p-4 flex items-center justify-between flex-wrap gap-2"
      style={{ background: 'rgba(234,179,8,0.08)', border: '1px solid rgba(234,179,8,0.3)' }}>
      <div>
        <p className="text-[10px] uppercase tracking-wider text-yellow-300 font-semibold">Pending Fee Change</p>
        <p className="text-white text-[13px]">
          Bribe fee moves <span className="font-mono">{(current / 100).toFixed(2)}%</span> → <span className={`font-mono font-semibold ${direction === 'up' ? 'text-red-300' : 'text-emerald-300'}`}>{(pending / 100).toFixed(2)}%</span>
        </p>
      </div>
      <span className="text-[12px] text-yellow-200 font-mono">
        {remaining > 0 ? `unlocks in ${formatCountdown(remaining)}` : 'ready for execution'}
      </span>
    </div>
  );
}

// ─── Commit-reveal mode banner ─────────────────────────────────────
function CommitRevealBanner({ enabled, epochUsesCR }: { enabled: boolean; epochUsesCR: boolean }) {
  if (!enabled && !epochUsesCR) return null;
  return (
    <div className="rounded-xl p-4"
      style={{ background: 'rgba(96,165,250,0.08)', border: '1px solid rgba(96,165,250,0.3)' }}>
      <p className="text-[10px] uppercase tracking-wider text-blue-300 font-semibold mb-0.5">Commit-Reveal Voting Active</p>
      <p className="text-white text-[12.5px] leading-relaxed">
        {epochUsesCR
          ? 'This epoch uses two-phase voting: commit your choice (with a 10 TOWELI bond) in the first ~2.8 days, then reveal in the remaining window to earn bribes. Bond refunds on reveal.'
          : 'The next snapshot will use two-phase voting. Plan to reveal within the window or your bond gets swept.'}
      </p>
    </div>
  );
}

// ─── Orphaned-bribe refund window countdown (for depositors) ────────
// AUDIT NEW-G2: the old `rescueOrphanedBribes(epoch,pair,token)` was an owner-only
// drain that sent everything to treasury. Replaced with permissionless
// `refundOrphanedBribe(epoch,pair,token)` — each depositor pulls back their own
// net contribution once the delay has elapsed since the LATEST deposit in the
// epoch. This banner now frames the window as a safety net rather than a
// looming drain.
function RescueBanner({ firstDepositAt, rescueDelaySec, now }: {
  firstDepositAt: number; rescueDelaySec: number; now: number;
}) {
  if (firstDepositAt === 0) return null;
  const rescueAt = firstDepositAt + rescueDelaySec;
  const remaining = rescueAt - now;
  if (remaining > RESCUE_WARN_THRESHOLD_SEC || remaining <= 0) return null;
  return (
    <div className="rounded-xl p-4 flex items-center justify-between flex-wrap gap-2"
      style={{ background: 'rgba(234,179,8,0.08)', border: '1px solid rgba(234,179,8,0.3)' }}>
      <div>
        <p className="text-[10px] uppercase tracking-wider text-amber-300 font-semibold">Orphaned-Bribe Refund Window</p>
        <p className="text-white text-[12.5px]">
          If this epoch isn't snapshotted within {formatCountdown(remaining)}, any depositor can pull their own
          bribes back via <span className="font-mono">refundOrphanedBribe(epoch, pair, token)</span>.
          Trigger <span className="font-mono">advanceEpoch</span> below to move into reveal/claim phase instead.
        </p>
      </div>
    </div>
  );
}

// ─── How-It-Works explainer (with tooltips) ────────────────────────
function HowItWorks() {
  const TIPS = {
    gauge: 'A "gauge" is a pool that receives TOWELI emissions based on how much voting power is allocated to it this epoch.',
    snapshot: 'advanceEpoch() captures every staker\'s voting power at a single moment so the vote result is immutable for the window.',
    ve: 'veTOWELI = TOWELI you locked in staking. Longer locks → more voting power and higher boost on rewards.',
    proRata: 'Your share of the bribes for a gauge equals your votes divided by all votes cast on that gauge.',
  } as const;

  return (
    <div className="rounded-2xl overflow-hidden relative" style={{ border: `1px solid ${CARD_BORDER}` }}>
      <div className="absolute inset-0">
        <ArtImg pageId="vote-incentives" idx={0} alt="" loading="lazy" className="w-full h-full object-cover" />
      </div>
      <div className="absolute inset-0" style={{ background: 'linear-gradient(180deg, rgba(6,12,26,0.78) 0%, rgba(6,12,26,0.92) 100%)' }} />
      <div className="relative z-10 p-5 md:p-6 space-y-5">
        <div>
          <h3 className="heading-luxury text-white text-[20px] md:text-[22px] tracking-tight mb-1" style={{ textShadow: '0 1px 4px rgba(0,0,0,0.9)' }}>
            {GOVERNANCE_COPY.bribesSectionTitle}
          </h3>
          <p className="text-white/80 text-[13px] leading-relaxed max-w-[640px]" style={{ textShadow: '0 1px 4px rgba(0,0,0,0.85)' }}>
            A bribe market for <span className="inline-flex items-center gap-1">gauge<InfoTooltip text={TIPS.gauge} /></span> voting. Projects rent voting power with ETH or whitelisted
            tokens; <span className="inline-flex items-center gap-1">veTOWELI<InfoTooltip text={TIPS.ve} /></span> voters earn those bribes by directing emissions.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          {[
            { n: 1, title: 'Deposit', body: 'Project posts a bribe on a gauge — ETH or a whitelisted ERC20. A 3% fee goes to treasury; the rest is reserved for voters.' },
            { n: 2, title: 'Snapshot', tip: TIPS.snapshot, body: 'advanceEpoch() locks every staker\'s voting power at that moment. A 7-day voting window opens.' },
            { n: 3, title: 'Vote', body: 'veTOWELI holders allocate power toward chosen gauges within the window. Votes cap at your snapshot power.' },
            { n: 4, title: 'Claim', tip: TIPS.proRata, body: 'When the window closes, voters claim their pro-rata slice of every bribe token on every gauge they voted for.' },
          ].map((s) => (
            <div key={s.n} className="rounded-xl p-4" style={{ background: 'rgba(13,21,48,0.7)', border: '1px solid rgba(255,255,255,0.1)' }}>
              <div className="flex items-center gap-2 mb-1.5">
                <span className="w-6 h-6 rounded-full bg-purple-500/40 border border-purple-500/60 text-[11px] font-bold text-white flex items-center justify-center">{s.n}</span>
                <p className="text-white text-[13px] font-semibold inline-flex items-center gap-1">
                  {s.title}
                  {s.tip && <InfoTooltip text={s.tip} />}
                </p>
              </div>
              <p className="text-white/75 text-[12px] leading-relaxed">{s.body}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Overview stats strip (responsive) ─────────────────────────────
function OverviewStrip({ epoch, epochCount, feeBps }: { epoch: number; epochCount: number; feeBps: number }) {
  const items = [
    { label: 'Current Epoch', value: epoch > 0 ? `#${epoch}` : '--' },
    { label: 'Total Epochs', value: epochCount > 0 ? epochCount.toString() : '--' },
    { label: 'Bribe Fee', value: feeBps > 0 ? `${(feeBps / 100).toFixed(2)}%` : '--', tip: 'Protocol fee taken from every deposit. Routed to treasury; the remainder is reserved for voters.' },
  ];
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
      {items.map(({ label, value, tip }, i) => (
        <div key={label} className="rounded-xl relative overflow-hidden" style={{ border: `1px solid ${CARD_BORDER}` }}>
          <div className="absolute inset-0">
            <img src={STAT_ARTS[i % STAT_ARTS.length]!.src} alt="" loading="lazy" className="w-full h-full object-cover" />
          </div>
          <div className="absolute inset-0" style={{ background: 'rgba(6,12,26,0.72)' }} />
          <div className="relative z-10 p-4">
            <p className="text-[10px] text-white/70 uppercase tracking-wider mb-1 inline-flex items-center gap-1" style={{ textShadow: '0 1px 4px rgba(0,0,0,0.85)' }}>
              {label}
              {tip && <InfoTooltip text={tip} />}
            </p>
            <p className="text-lg font-semibold text-white" style={{ textShadow: '0 1px 4px rgba(0,0,0,0.9)' }}>{value}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Voting power banner (with /farm CTA) ──────────────────────────
function VotingPowerBanner({ userPower, userUsed, deadline, now, voteEpoch, isConnected }: {
  userPower: bigint; userUsed: bigint; deadline: number; now: number; voteEpoch: number; isConnected: boolean;
}) {
  const remaining = userPower > userUsed ? userPower - userUsed : 0n;
  const usedPct = userPower > 0n ? Number((userUsed * 10000n) / userPower) / 100 : 0;
  const secondsLeft = Math.max(0, deadline - now);
  const deadlineOpen = deadline > 0 && secondsLeft > 0;

  return (
    <div className="rounded-2xl overflow-hidden relative" style={{ border: `1px solid ${CARD_BORDER}` }}>
      <div className="absolute inset-0">
        <ArtImg pageId="vote-incentives" idx={2} alt="" loading="lazy" className="w-full h-full object-cover" />
      </div>
      <div className="absolute inset-0" style={{ background: 'rgba(6,12,26,0.88)' }} />
      <div className="relative z-10 p-5 flex items-center justify-between flex-wrap gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1">
            <p className="text-[10px] uppercase tracking-wider text-purple-300 font-semibold">Your Voting Power · Epoch #{voteEpoch}</p>
            <InfoTooltip text="Snapshotted when the epoch was advanced. You can split this power across multiple gauges — the total is capped at this value." />
          </div>
          {!isConnected ? (
            <p className="text-white/75 text-[13px]">Connect a wallet to see your voting power.</p>
          ) : userPower === 0n ? (
            <div className="flex items-center gap-3 flex-wrap">
              <p className="text-yellow-300 text-[13px]">No voting power at this epoch's snapshot.</p>
              <Link
                to="/farm"
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-[11.5px] font-semibold bg-purple-500/25 text-purple-100 border border-purple-400/45 hover:bg-purple-500/35 transition-colors"
              >
                Stake TOWELI →
              </Link>
            </div>
          ) : (
            <>
              <div className="flex items-baseline gap-2 flex-wrap">
                <p className="stat-value text-white text-[22px] font-mono">{formatTokenAmount(formatEther(remaining), 2)}</p>
                <p className="text-white/55 text-[12px]">remaining of {formatTokenAmount(formatEther(userPower), 2)} total</p>
              </div>
              <div className="mt-2 h-1.5 rounded-full bg-white/10 overflow-hidden">
                <div className="h-full rounded-full" style={{ width: `${Math.min(100, usedPct)}%`, background: 'linear-gradient(90deg, rgb(139 92 246), rgb(124 58 237))' }} />
              </div>
              <p className="text-white/55 text-[11px] mt-1">{usedPct.toFixed(1)}% allocated</p>
            </>
          )}
        </div>
        <div className="text-right flex-shrink-0">
          <p className="text-[10px] uppercase tracking-wider text-white/55">Vote Deadline</p>
          <p className={`text-[15px] font-semibold ${deadlineOpen ? 'text-emerald-300' : 'text-red-300'}`}>
            {deadline === 0 ? '—' : deadlineOpen ? formatCountdown(secondsLeft) : 'Closed'}
          </p>
        </div>
      </div>
    </div>
  );
}

// ─── Pending withdrawals panel (ETH + ERC20) ───────────────────────
function PendingWithdrawalsPanel({ pendingETH, tokens, onWithdrawETH, onWithdrawToken, isBusy }: {
  pendingETH: bigint;
  tokens: WhitelistedToken[];
  onWithdrawETH: () => void;
  onWithdrawToken: (addr: Address) => void;
  isBusy: boolean;
}) {
  const tokenRefunds = tokens.filter(t => t.pendingWithdrawal > 0n);
  if (pendingETH === 0n && tokenRefunds.length === 0) return null;
  return (
    <div className="rounded-xl p-4 space-y-2"
      style={{ background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.25)' }}>
      <div className="flex items-center gap-2 mb-1">
        <p className="text-[10px] uppercase tracking-wider text-emerald-400 font-semibold">Pull-Pattern Refunds</p>
        <InfoTooltip text="If a claim ever fails to transfer (e.g. FoT / paused token), the amount is parked here. Click Withdraw to pull it to your wallet." />
      </div>
      {pendingETH > 0n && (
        <div className="rounded-lg p-3 flex items-center justify-between flex-wrap gap-2" style={{ background: 'rgba(13,21,48,0.7)' }}>
          <div>
            <p className="text-[10px] uppercase tracking-wider text-white/55">Pending ETH</p>
            <p className="text-emerald-400 text-[15px] font-mono font-semibold">{formatTokenAmount(formatEther(pendingETH), 6)} ETH</p>
          </div>
          <button onClick={onWithdrawETH} disabled={isBusy}
            className="px-4 py-2 rounded-lg text-[12px] font-semibold bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/25 transition-colors disabled:opacity-40">
            Withdraw
          </button>
        </div>
      )}
      {tokenRefunds.map((t) => (
        <div key={t.address} className="rounded-lg p-3 flex items-center justify-between flex-wrap gap-2" style={{ background: 'rgba(13,21,48,0.7)' }}>
          <div>
            <p className="text-[10px] uppercase tracking-wider text-white/55">Pending {t.symbol}</p>
            <p className="text-emerald-400 text-[15px] font-mono font-semibold">{formatTokenAmount(formatUnits(t.pendingWithdrawal, t.decimals), 6)} {t.symbol}</p>
          </div>
          <button onClick={() => onWithdrawToken(t.address)} disabled={isBusy}
            className="px-4 py-2 rounded-lg text-[12px] font-semibold bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/25 transition-colors disabled:opacity-40">
            Withdraw
          </button>
        </div>
      ))}
    </div>
  );
}

// ─── Your Claimables (now with empty state) ────────────────────────
function ClaimablesPanel({ claimables, gauges, onClaim, isBusy, isConnected, currentEpoch }: {
  claimables: PairClaimable[];
  gauges: GaugeInfo[];
  onClaim: (pair: Address) => void;
  isBusy: boolean;
  isConnected: boolean;
  currentEpoch: number;
}) {
  if (!isConnected || claimables.length === 0) {
    return (
      <div className="rounded-xl p-4"
        style={{ background: 'rgba(139,92,246,0.05)', border: '1px dashed rgba(139,92,246,0.25)' }}>
        <p className="text-[10px] uppercase tracking-wider text-purple-300 font-semibold mb-0.5">Your Claimables</p>
        <p className="text-white/65 text-[12.5px]">
          {!isConnected
            ? 'Connect a wallet to see what you can claim.'
            : currentEpoch < 1
              ? "You'll claim bribes here once the first epoch closes."
              : "Nothing to claim yet — vote on a gauge with active bribes, then come back after the epoch closes."}
        </p>
      </div>
    );
  }
  const gaugeByAddr = new Map(gauges.map((g) => [g.pair.toLowerCase(), g]));
  const anyMulti = claimables.some((c) => c.epochs.length > 1);
  return (
    <div className="rounded-xl p-4" style={{ background: 'rgba(139,92,246,0.08)', border: '1px solid rgba(139,92,246,0.25)' }}>
      <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
        <div>
          <p className="text-[10px] uppercase tracking-wider text-purple-300 font-semibold">Your Claimables</p>
          <p className="text-white text-[13px]">
            {anyMulti ? `Unclaimed across up to ${CLAIM_LOOKBACK_EPOCHS} past epochs — batched per gauge` : 'Claim per gauge below'}
          </p>
        </div>
        <span className="text-[11px] text-white/55">{claimables.length} gauge{claimables.length === 1 ? '' : 's'}</span>
      </div>
      <div className="space-y-2">
        {claimables.map((c) => {
          const g = gaugeByAddr.get(c.pair.toLowerCase());
          const first = c.epochs[0]!;
          const last = c.epochs[c.epochs.length - 1]!;
          // AUDIT BRIBES-UX: if the user voted on this pair in epochs 5, 7, 9,
          // the old UI displayed "Epochs #5–#9", implying claims in 6 and 8
          // too. Detect non-contiguous sequences and list them explicitly.
          const contiguous = c.epochs.every((e, i, arr) => i === 0 || e === arr[i - 1]! + 1);
          const epochRange = first === last
            ? `Epoch #${first}`
            : contiguous
              ? `Epochs #${first}–#${last}`
              : c.epochs.length <= 4
                ? `Epochs ${c.epochs.map(e => `#${e}`).join(', ')}`
                : `${c.epochs.length} epochs (${c.epochs.slice(0, 2).map(e => `#${e}`).join(', ')}, …, #${last})`;
          const buttonLabel = first === last ? 'Claim' : `Claim ${c.epochs.length} epochs`;
          return (
            <div key={c.pair} className="rounded-lg p-3 flex items-center justify-between gap-3 flex-wrap" style={{ background: 'rgba(13,21,48,0.7)', border: '1px solid rgba(255,255,255,0.08)' }}>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-white text-[13px] font-medium">{g?.label ?? shortenAddress(c.pair)}</p>
                  <span
                    className="text-[10px] px-1.5 py-0.5 rounded-full bg-purple-500/20 text-purple-200 border border-purple-500/35 font-mono"
                    title={c.epochs.length > 1 ? `Claimable in epochs: ${c.epochs.map(e => `#${e}`).join(', ')}` : undefined}
                  >
                    {epochRange}
                  </span>
                </div>
                <div className="flex flex-wrap gap-2 mt-1">
                  {c.tokens.map((tok, i) => (
                    <span key={`${tok}-${i}`} className="text-[11px] text-purple-200 font-mono">
                      {formatTokenAmount(formatEther(c.amounts[i] ?? 0n), 4)}{' '}
                      {tok.toLowerCase() === ZERO_ADDRESS ? 'ETH' : shortenAddress(tok)}
                    </span>
                  ))}
                </div>
              </div>
              <button onClick={() => onClaim(c.pair)} disabled={isBusy}
                className="flex-shrink-0 px-4 py-2 rounded-lg text-[12px] font-semibold bg-purple-500/20 text-purple-200 border border-purple-500/40 hover:bg-purple-500/30 transition-colors disabled:opacity-40">
                {buttonLabel}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Leaderboard controls ──────────────────────────────────────────
function LeaderboardControls({ search, setSearch, sort, setSort, hideEmpty, setHideEmpty, total, shown }: {
  search: string; setSearch: (v: string) => void; sort: SortKey; setSort: (v: SortKey) => void;
  hideEmpty: boolean; setHideEmpty: (v: boolean) => void; total: number; shown: number;
}) {
  return (
    <div className="flex items-center gap-3 flex-wrap px-5 py-3 border-b border-white/10">
      <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search gauge…"
        className="flex-1 min-w-[140px] bg-black/50 border border-white/15 rounded-lg px-3 py-2 text-white text-[12px] focus:border-purple-500 outline-none transition-colors" />
      <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}
        className="bg-black/50 border border-white/15 rounded-lg px-3 py-2 text-white text-[12px] focus:border-purple-500 outline-none transition-colors">
        <option value="bribe" className="bg-[#0a0f1a]">Sort: Bribe TVL</option>
        <option value="votes" className="bg-[#0a0f1a]">Sort: Total Votes</option>
        <option value="yours" className="bg-[#0a0f1a]">Sort: Your Allocation</option>
        <option value="claimable" className="bg-[#0a0f1a]">Sort: Your Claimable</option>
      </select>
      <label className="flex items-center gap-1.5 text-white/70 text-[11.5px] cursor-pointer select-none">
        <input type="checkbox" checked={hideEmpty} onChange={(e) => setHideEmpty(e.target.checked)} className="w-3.5 h-3.5 accent-purple-500" />
        Hide empty
      </label>
      <span className="text-[11px] text-white/45 ml-auto">{shown} / {total}</span>
    </div>
  );
}

// ─── Gauge row ─────────────────────────────────────────────────────
function GaugeRow({
  gauge, summary, totalVotes, userVotes, userClaimable, whitelistMap,
  selected, canVote, voteDisabled, voteInput, setVoteInput, remainingPower,
  onSelect, onSubmitVote, isBusy, isPending, isConfirming, deadlineSeconds,
}: {
  gauge: GaugeInfo; summary: PairBribeSummary;
  totalVotes: bigint; userVotes: bigint; userClaimable: bigint;
  whitelistMap: Map<string, WhitelistedToken>;
  selected: boolean; canVote: boolean; voteDisabled: boolean;
  voteInput: string; setVoteInput: (v: string) => void; remainingPower: bigint;
  onSelect: () => void; onSubmitVote: () => void;
  isBusy: boolean; isPending: boolean; isConfirming: boolean;
  deadlineSeconds: number;
}) {
  const tokenBadges = summary.bribes.filter((b) => b.token.toLowerCase() !== ZERO_ADDRESS);
  const hasBribes = summary.ethAmount > 0n || tokenBadges.length > 0;
  const hasHistory = summary.historicalEthAmount > summary.ethAmount;

  // Earning-rate preview: if user adds `power` to this gauge, their share of
  // the current ETH bribe pot = power / (totalVotes + power) * ethAmount.
  const voteWei = (() => {
    if (!voteInput) return 0n;
    try { return parseEther(voteInput); } catch { return 0n; }
  })();
  const tooMuch = voteWei > remainingPower;
  const projectedEarn = voteWei > 0n && summary.ethAmount > 0n
    ? (voteWei * summary.ethAmount) / (totalVotes + voteWei)
    : 0n;

  // AUDIT BRIBES-UX: surface the per-vote earning rate without requiring the
  // user to type a vote amount first. At 1000 TOWELI voted the share is
  // 1000 / (totalVotes + 1000) * ethAmount. This is "marginal earn" — what
  // a typical new voter would get — and tracks closely with the real rate as
  // long as totalVotes >> 1000.
  const PROJECTION_UNIT = parseEther('1000');
  const marginalEthPer1k = summary.ethAmount > 0n && totalVotes > 0n
    ? (PROJECTION_UNIT * summary.ethAmount) / (totalVotes + PROJECTION_UNIT)
    : 0n;

  return (
    <div className={`px-5 py-3 transition-colors ${selected ? 'bg-purple-500/12' : 'hover:bg-white/3'}`}>
      <button
        onClick={onSelect}
        type="button"
        className="w-full text-left"
        aria-expanded={selected}
        aria-label={`${gauge.label} gauge — tap to ${selected ? 'collapse' : 'select and expand vote input'}`}
      >
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="text-white text-[14px] font-semibold">{gauge.label}</p>
              {selected && <span className="text-[10px] px-2 py-0.5 rounded-full bg-purple-500/25 text-purple-200 border border-purple-500/40">Selected</span>}
              {userVotes > 0n && (
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
                  Your vote: {formatTokenAmount(formatEther(userVotes), 2)}
                </span>
              )}
              {marginalEthPer1k > 0n && (
                <span
                  className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-200 border border-amber-500/35 font-mono"
                  title="Projected ETH earn if you voted 1,000 TOWELI on this gauge right now. Scales ~linearly for small additions."
                >
                  ≈ {formatTokenAmount(formatEther(marginalEthPer1k), 5)} ETH / 1k voted
                </span>
              )}
              {deadlineSeconds > 0 && deadlineSeconds < 86400 && (
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-red-500/20 text-red-200 border border-red-500/40 font-mono">
                  {formatCountdown(deadlineSeconds)} left
                </span>
              )}
            </div>
            <p className="text-white/50 text-[11px] font-mono">{shortenAddress(gauge.pair)}</p>
          </div>
          <div className="flex items-center gap-4 flex-wrap text-right">
            <div>
              <p className="text-[10px] text-white/50 uppercase tracking-wider">Total Votes</p>
              <p className="text-white text-[13px] stat-value font-mono">{totalVotes > 0n ? formatTokenAmount(formatEther(totalVotes), 2) : '—'}</p>
            </div>
            <div>
              <p className="text-[10px] text-white/50 uppercase tracking-wider">ETH Bribe</p>
              <p className="text-white text-[13px] stat-value font-mono">{summary.ethAmount > 0n ? `${formatTokenAmount(formatEther(summary.ethAmount), 4)} ETH` : '—'}</p>
              {hasHistory && (
                <p className="text-[9.5px] text-white/40 font-mono">lifetime ~{formatTokenAmount(formatEther(summary.historicalEthAmount), 3)}</p>
              )}
            </div>
            <div>
              <p className="text-[10px] text-white/50 uppercase tracking-wider">Tokens</p>
              <div className="flex items-center gap-1 justify-end">
                {tokenBadges.length === 0 ? (
                  <p className="text-white/50 text-[12px]">—</p>
                ) : (
                  tokenBadges.slice(0, 3).map((b) => {
                    const meta = whitelistMap.get(b.token.toLowerCase());
                    const sym = meta?.symbol ?? shortenAddress(b.token);
                    const amt = meta ? formatUnits(b.amount, meta.decimals) : formatEther(b.amount);
                    return (
                      <span key={b.token} className="text-[10.5px] px-2 py-0.5 rounded-full bg-white/5 text-white/85 border border-white/10 whitespace-nowrap">
                        {formatTokenAmount(amt, 2)} {sym}
                      </span>
                    );
                  })
                )}
                {tokenBadges.length > 3 && <span className="text-[10.5px] text-white/50">+{tokenBadges.length - 3}</span>}
              </div>
            </div>
          </div>
        </div>
      </button>

      {selected && canVote && hasBribes && (
        <div className="mt-3 space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <input
              type="number" step="0.01" value={voteInput}
              onChange={(e) => setVoteInput(e.target.value)}
              placeholder="Voting power to add"
              className={`flex-1 min-w-[160px] bg-black/60 border rounded-lg px-3 py-2 text-white text-[12px] font-mono outline-none transition-colors ${tooMuch ? 'border-red-500/60' : 'border-white/15 focus:border-purple-500'}`}
            />
            <button
              onClick={onSubmitVote}
              disabled={voteDisabled || !voteInput || voteWei === 0n || tooMuch || isBusy}
              className="px-4 py-2 rounded-lg text-[12px] font-semibold bg-purple-500/20 text-purple-200 border border-purple-500/40 hover:bg-purple-500/30 transition-colors disabled:opacity-40"
            >
              {isPending ? 'Confirm in Wallet…' : isConfirming ? 'Casting…' : 'Cast Vote'}
            </button>
          </div>
          <div className="flex items-center justify-between gap-3 text-[10.5px] flex-wrap">
            <span className="text-white/55">
              Remaining power: <span className="font-mono text-white/80">{formatTokenAmount(formatEther(remainingPower), 4)}</span>
            </span>
            {tooMuch ? (
              <span className="text-red-300">Exceeds remaining — contract would revert.</span>
            ) : projectedEarn > 0n ? (
              <span className="text-emerald-300">
                ≈ {formatTokenAmount(formatEther(projectedEarn), 5)} ETH projected at current votes
              </span>
            ) : userClaimable > 0n ? (
              <span className="text-emerald-300/80">You&apos;d claim ~{formatTokenAmount(formatEther(userClaimable), 4)} from last epoch</span>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Deposit card (labeled for projects, with min-bribe hint) ──────
function DepositCard({
  gauges, selectedPair, setSelectedPair, whitelistedTokens, feeBps,
  globalMinBribe, onDepositETH, onDepositToken, onApprove,
  isBusy, isPending, isConfirming,
}: {
  gauges: GaugeInfo[]; selectedPair: Address | null; setSelectedPair: (p: Address) => void;
  whitelistedTokens: WhitelistedToken[]; feeBps: number; globalMinBribe: bigint;
  onDepositETH: (pair: Address, valueWei: bigint) => void;
  onDepositToken: (pair: Address, token: Address, amountWei: bigint) => void;
  onApprove: (token: Address, amountWei: bigint) => void;
  isBusy: boolean; isPending: boolean; isConfirming: boolean;
}) {
  const [mode, setMode] = useState<'eth' | 'token'>('eth');
  const [amount, setAmount] = useState('');
  const [tokenAddr, setTokenAddr] = useState<Address | null>(null);

  useEffect(() => {
    if (mode === 'token' && !tokenAddr && whitelistedTokens.length > 0) {
      setTokenAddr(whitelistedTokens[0]!.address);
    }
  }, [mode, tokenAddr, whitelistedTokens]);

  const selectedToken = useMemo(
    () => (tokenAddr ? whitelistedTokens.find((t) => t.address.toLowerCase() === tokenAddr.toLowerCase()) : undefined),
    [tokenAddr, whitelistedTokens],
  );

  const activeMinBribe = mode === 'eth' ? globalMinBribe : (selectedToken?.minBribe ?? globalMinBribe);
  const activeDecimals = mode === 'eth' ? 18 : (selectedToken?.decimals ?? 18);
  const activeSymbol = mode === 'eth' ? 'ETH' : (selectedToken?.symbol ?? 'TOKEN');

  const amountWei = useMemo(() => {
    if (!amount || Number(amount) <= 0) return 0n;
    try { return mode === 'eth' ? parseEther(amount) : parseUnits(amount, selectedToken?.decimals ?? 18); } catch { return 0n; }
  }, [amount, mode, selectedToken]);

  const feePreview = amountWei === 0n || feeBps === 0 ? 0n : (amountWei * BigInt(feeBps)) / 10000n;
  const needsApproval = mode === 'token' && selectedToken && amountWei > 0n && selectedToken.allowance < amountWei;
  const insufficientBalance = mode === 'token' && selectedToken && amountWei > selectedToken.balance;
  const belowMin = amountWei > 0n && amountWei < activeMinBribe;
  const canSubmit = !!selectedPair && amountWei > 0n && !isBusy && !insufficientBalance && !belowMin;

  const handleSubmit = () => {
    if (!selectedPair || amountWei === 0n) return;
    if (mode === 'eth') onDepositETH(selectedPair, amountWei);
    else if (selectedToken) {
      if (needsApproval) onApprove(selectedToken.address, amountWei);
      else onDepositToken(selectedPair, selectedToken.address, amountWei);
    }
  };

  const handleMax = () => {
    if (mode === 'token' && selectedToken) setAmount(formatUnits(selectedToken.balance, selectedToken.decimals));
  };

  return (
    <div id={DEPOSIT_CARD_ID} className="rounded-2xl overflow-hidden relative scroll-mt-20" style={{ border: `1px solid ${CARD_BORDER}` }}>
      <div className="absolute inset-0">
        <ArtImg pageId="vote-incentives" idx={3} alt="" loading="lazy" className="w-full h-full object-cover" />
      </div>
      <div className="absolute inset-0" style={{ background: 'rgba(6,12,26,0.88)' }} />
      <div className="relative z-10">
        <div className="px-5 py-4 border-b border-white/10 flex items-center gap-2 flex-wrap">
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-200 border border-emerald-500/40 font-semibold uppercase tracking-wider">For Projects</span>
          <h3 className="text-sm font-semibold text-white" style={{ textShadow: '0 1px 4px rgba(0,0,0,0.9)' }}>Deposit Bribe</h3>
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-purple-500/25 text-purple-200 border border-purple-500/40">
            {GOVERNANCE_COPY.bribesSectionTag}
          </span>
          <InfoTooltip text="Deposit ETH or a whitelisted ERC20 on a gauge. Voters earn a pro-rata share of your deposit after the protocol fee." />
        </div>

        <div className="p-5 space-y-4">
          <div>
            <label htmlFor="deposit-gauge" className="text-[11px] text-white/65 uppercase tracking-wider block mb-1.5">Gauge</label>
            <select id="deposit-gauge" value={selectedPair ?? ''} onChange={(e) => setSelectedPair(e.target.value as Address)}
              className="w-full bg-black/50 border border-white/15 rounded-lg px-3 py-2.5 text-white text-[13px] font-mono focus:border-purple-500 outline-none transition-colors">
              <option value="" disabled>Select a gauge…</option>
              {gauges.map((g) => (
                <option key={g.pair} value={g.pair} className="bg-[#0a0f1a] text-white">
                  {g.label} · {shortenAddress(g.pair)}
                </option>
              ))}
            </select>
          </div>

          <div className="flex gap-1 p-1 rounded-xl" style={{ background: 'rgba(13,21,48,0.7)', border: '1px solid rgba(255,255,255,0.08)' }}>
            {(['eth', 'token'] as const).map((m) => (
              <button key={m} onClick={() => { setMode(m); setAmount(''); }}
                className="flex-1 py-2 rounded-lg text-[12px] font-semibold text-white transition-all"
                style={mode === m ? { background: 'var(--color-stan)', boxShadow: '0 4px 12px var(--color-stan-40)' } : undefined}>
                {m === 'eth' ? 'ETH' : 'ERC20'}
              </button>
            ))}
          </div>

          {mode === 'token' && (
            whitelistedTokens.length === 0 ? (
              <div className="rounded-lg p-3 text-center" style={{ background: 'rgba(234,179,8,0.08)', border: '1px solid rgba(234,179,8,0.25)' }}>
                <p className="text-yellow-300 text-[12px]">No ERC20 tokens whitelisted yet. Use ETH for now.</p>
              </div>
            ) : (
              <div>
                <label className="text-[11px] text-white/65 uppercase tracking-wider block mb-1.5">Token</label>
                <select value={tokenAddr ?? ''} onChange={(e) => setTokenAddr(e.target.value as Address)}
                  className="w-full bg-black/50 border border-white/15 rounded-lg px-3 py-2.5 text-white text-[13px] font-mono focus:border-purple-500 outline-none transition-colors">
                  {whitelistedTokens.map((t) => (
                    <option key={t.address} value={t.address} className="bg-[#0a0f1a] text-white">
                      {t.symbol} · balance {formatTokenAmount(formatUnits(t.balance, t.decimals), 4)}
                    </option>
                  ))}
                </select>
              </div>
            )
          )}

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-[11px] text-white/65 uppercase tracking-wider">Amount ({activeSymbol})</label>
              {mode === 'token' && selectedToken && (
                <button onClick={handleMax} type="button" className="text-[10.5px] text-purple-300 hover:text-purple-200 transition-colors">
                  Max: {formatTokenAmount(formatUnits(selectedToken.balance, selectedToken.decimals), 4)}
                </button>
              )}
            </div>
            <input type="number" step="0.001" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.1"
              className={`w-full bg-black/50 border rounded-lg px-3 py-2.5 text-white text-[14px] font-mono outline-none transition-colors ${belowMin || insufficientBalance ? 'border-red-500/60' : 'border-white/15 focus:border-purple-500'}`} />
            <div className="flex items-center justify-between mt-1.5 gap-2 flex-wrap">
              <p className="text-[10.5px] text-white/55">
                Min: {formatTokenAmount(formatUnits(activeMinBribe, activeDecimals), 6)} {activeSymbol}
                {' '}· protects voters from dust spam
              </p>
              {amountWei > 0n && feeBps > 0 && (
                <p className="text-[10.5px] text-white/55">
                  Fee: {formatTokenAmount(formatUnits(feePreview, activeDecimals), 6)} {activeSymbol} ({(feeBps / 100).toFixed(2)}%) · Net pool: {formatTokenAmount(formatUnits(amountWei - feePreview, activeDecimals), 6)}
                </p>
              )}
            </div>
            {insufficientBalance && <p className="text-[11px] text-red-400 mt-1.5">Insufficient balance.</p>}
            {belowMin && <p className="text-[11px] text-red-400 mt-1.5">Below minimum — contract would revert.</p>}
          </div>

          <button onClick={handleSubmit} disabled={!canSubmit}
            className="w-full py-2.5 rounded-xl text-[13px] font-semibold transition-all disabled:opacity-40"
            style={{ background: 'linear-gradient(135deg, rgb(16 185 129), rgb(5 150 105))', color: 'white' }}>
            {!selectedPair
              ? 'Select a gauge'
              : amountWei === 0n
              ? 'Enter an amount'
              : belowMin
              ? 'Below min-bribe'
              : isPending
              ? 'Confirm in Wallet…'
              : isConfirming
              ? 'Confirming…'
              : needsApproval
              ? `Approve ${selectedToken?.symbol ?? 'token'}`
              : `Deposit ${amount || '0'} ${activeSymbol}`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Commit-reveal panel (wraps vote when epoch uses two-phase) ────
function CommitRevealPanel({
  gauges, voteEpoch, epochTimestamp, voteDeadlineSec, now,
  userPower, userUsed, commitBond, toweliAllowance, isBusy,
  isPending, isConfirming, onApproveBond, onCommit, onReveal,
}: {
  gauges: GaugeInfo[]; voteEpoch: number; epochTimestamp: number; voteDeadlineSec: number; now: number;
  userPower: bigint; userUsed: bigint; commitBond: bigint; toweliAllowance: bigint;
  isBusy: boolean; isPending: boolean; isConfirming: boolean;
  onApproveBond: (amount: bigint) => void;
  onCommit: (pair: Address, power: bigint, commitHash: Hex, record: Omit<CommitRecord, 'commitIndex' | 'committedAt'>) => void;
  onReveal: (commitIndex: number, pair: Address, power: bigint, salt: Hex) => void;
}) {
  const { address } = useAccount();
  const chainId = useChainId();
  const [pair, setPair] = useState<Address | ''>('');
  const [power, setPower] = useState('');
  const [commits, setCommits] = useState<CommitRecord[]>([]);

  const key = address ? COMMIT_KEY(chainId, address, voteEpoch) : '';
  const lastRecords = useRef<string>('');

  useEffect(() => {
    if (!key) { setCommits([]); return; }
    const list = loadCommits(key);
    const sig = JSON.stringify(list);
    if (sig !== lastRecords.current) {
      lastRecords.current = sig;
      setCommits(list);
    }
  }, [key, isBusy]);

  useEffect(() => {
    if (!pair && gauges.length > 0) setPair(gauges[0]!.pair);
  }, [pair, gauges]);

  const remaining = userPower > userUsed ? userPower - userUsed : 0n;
  const powerWei = (() => { try { return parseEther(power || '0'); } catch { return 0n; } })();
  const tooMuch = powerWei > remaining;

  const commitDeadlineSec = epochTimestamp + Math.floor((voteDeadlineSec * COMMIT_RATIO_BPS) / 10000);
  const revealDeadlineSec = epochTimestamp + voteDeadlineSec;
  const commitOpen = now > epochTimestamp && now <= commitDeadlineSec;
  const revealOpen = now > commitDeadlineSec && now <= revealDeadlineSec;

  const needsBondApproval = toweliAllowance < commitBond;

  const handleCommit = () => {
    if (!address || !pair || powerWei === 0n || tooMuch) return;
    const salt = generateSalt();
    const commitHash = buildCommitHash(chainId, VOTE_INCENTIVES_ADDRESS as Address, address, voteEpoch, pair as Address, powerWei, salt);
    onCommit(pair as Address, powerWei, commitHash, {
      salt, pair: pair as Address, power: powerWei.toString(), commitHash,
    });
  };

  return (
    <div className="rounded-2xl overflow-hidden relative" style={{ border: `1px solid ${CARD_BORDER}` }}>
      <div className="absolute inset-0">
        <ArtImg pageId="vote-incentives" idx={1} alt="" loading="lazy" className="w-full h-full object-cover" />
      </div>
      <div className="absolute inset-0" style={{ background: 'rgba(6,12,26,0.9)' }} />
      <div className="relative z-10 p-5 space-y-4">
        <div className="flex items-center gap-2 flex-wrap">
          <h3 className="text-sm font-semibold text-white">Commit-Reveal Voting · Epoch #{voteEpoch}</h3>
          <InfoTooltip text="Two-phase voting: commit a hashed choice (with 10 TOWELI bond) in Phase 1; reveal the choice in Phase 2 to apply the vote and refund the bond. Commits not revealed before the deadline lose their bond to treasury." />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="rounded-lg p-3" style={{ background: 'rgba(13,21,48,0.7)', border: '1px solid rgba(255,255,255,0.08)' }}>
            <p className="text-[10px] uppercase tracking-wider text-blue-300 font-semibold">Phase 1 · Commit</p>
            <p className="text-white text-[12px]">{commitOpen ? `Closes in ${formatCountdown(commitDeadlineSec - now)}` : now < epochTimestamp ? 'Not yet open' : 'Closed'}</p>
          </div>
          <div className="rounded-lg p-3" style={{ background: 'rgba(13,21,48,0.7)', border: '1px solid rgba(255,255,255,0.08)' }}>
            <p className="text-[10px] uppercase tracking-wider text-blue-300 font-semibold">Phase 2 · Reveal</p>
            <p className="text-white text-[12px]">{revealOpen ? `Closes in ${formatCountdown(revealDeadlineSec - now)}` : commitOpen ? 'Opens after commit phase' : 'Closed'}</p>
          </div>
        </div>

        {/* Commit form */}
        {commitOpen && (
          <div className="space-y-2 pt-2 border-t border-white/10">
            <p className="text-[11px] text-white/65 uppercase tracking-wider">New Commit</p>
            <select value={pair} onChange={(e) => setPair(e.target.value as Address)}
              className="w-full bg-black/50 border border-white/15 rounded-lg px-3 py-2 text-white text-[12px] font-mono focus:border-blue-400 outline-none">
              <option value="" disabled>Select a gauge…</option>
              {gauges.map((g) => (
                <option key={g.pair} value={g.pair} className="bg-[#0a0f1a] text-white">
                  {g.label} · {shortenAddress(g.pair)}
                </option>
              ))}
            </select>
            <div className="flex items-center gap-2 flex-wrap">
              <input type="number" step="0.01" value={power} onChange={(e) => setPower(e.target.value)} placeholder="Voting power"
                className={`flex-1 min-w-[140px] bg-black/60 border rounded-lg px-3 py-2 text-white text-[12px] font-mono outline-none ${tooMuch ? 'border-red-500/60' : 'border-white/15 focus:border-blue-400'}`} />
              {needsBondApproval ? (
                <button onClick={() => onApproveBond(commitBond)} disabled={isBusy}
                  className="px-4 py-2 rounded-lg text-[12px] font-semibold bg-yellow-500/20 text-yellow-200 border border-yellow-500/40 hover:bg-yellow-500/30 transition-colors disabled:opacity-40">
                  Approve {formatTokenAmount(formatEther(commitBond), 0)} TOWELI bond
                </button>
              ) : (
                <button onClick={handleCommit} disabled={isBusy || !pair || powerWei === 0n || tooMuch}
                  className="px-4 py-2 rounded-lg text-[12px] font-semibold bg-blue-500/20 text-blue-200 border border-blue-500/40 hover:bg-blue-500/30 transition-colors disabled:opacity-40">
                  {isPending ? 'Confirm in Wallet…' : isConfirming ? 'Committing…' : `Commit (${formatTokenAmount(formatEther(commitBond), 0)} TOWELI)`}
                </button>
              )}
            </div>
            <p className="text-[10.5px] text-white/55">
              Remaining power: <span className="font-mono">{formatTokenAmount(formatEther(remaining), 4)}</span>
              {tooMuch && <span className="text-red-300 ml-2">· exceeds remaining</span>}
            </p>
          </div>
        )}

        {/* Stored commits (reveal list) */}
        {commits.length > 0 && (
          <div className="pt-2 border-t border-white/10 space-y-2">
            <p className="text-[11px] text-white/65 uppercase tracking-wider">Your Commits ({commits.length})</p>
            {commits.map((c) => {
              const gauge = gauges.find((g) => g.pair.toLowerCase() === c.pair.toLowerCase());
              const label = gauge?.label ?? shortenAddress(c.pair);
              return (
                <div key={c.commitIndex} className="rounded-lg p-3 flex items-center justify-between gap-2 flex-wrap" style={{ background: 'rgba(13,21,48,0.7)', border: '1px solid rgba(255,255,255,0.08)' }}>
                  <div className="min-w-0">
                    <p className="text-white text-[12.5px] font-medium">{label}</p>
                    <p className="text-[10.5px] text-white/55 font-mono">Index {c.commitIndex} · {formatTokenAmount(formatEther(BigInt(c.power)), 4)} power</p>
                  </div>
                  <button onClick={() => onReveal(c.commitIndex, c.pair, BigInt(c.power), c.salt)}
                    disabled={isBusy || !revealOpen}
                    className="px-4 py-2 rounded-lg text-[12px] font-semibold bg-emerald-500/20 text-emerald-200 border border-emerald-500/40 hover:bg-emerald-500/30 transition-colors disabled:opacity-40">
                    {revealOpen ? (isPending ? 'Confirm…' : isConfirming ? 'Revealing…' : 'Reveal') : 'Reveal opens later'}
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {!commitOpen && !revealOpen && commits.length === 0 && (
          <p className="text-[11.5px] text-white/55 text-center pt-2">This epoch's voting is closed.</p>
        )}
      </div>
    </div>
  );
}

// ─── Main section ───────────────────────────────────────────────────
export function VoteIncentivesSection() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const bribes = useBribes();
  const { gauges, isLoading: gaugesLoading } = useGaugeList();
  const viAddr = VOTE_INCENTIVES_ADDRESS as Address;

  const { writeContract: writeLocal, data: localTx, isPending: isLocalSigning } = useWriteContract();
  const { isLoading: isLocalConfirming } = useWaitForTransactionReceipt({ hash: localTx });

  const [selectedPair, setSelectedPair] = useState<Address | null>(null);
  const [voteInput, setVoteInput] = useState('');

  useEffect(() => {
    if (!selectedPair && gauges.length > 0) setSelectedPair(gauges[0]!.pair);
  }, [gauges, selectedPair]);
  useEffect(() => { setVoteInput(''); }, [selectedPair]);

  const currentEpoch = bribes.currentEpoch;
  const prevEpoch = Math.max(0, currentEpoch - 1);
  const depositEpoch = currentEpoch;
  const hasEpochs = bribes.epochCount > 0;
  const epochUsesCR = bribes.latestEpoch?.usesCommitReveal ?? false;

  // ── Vote deadline (from contract constant) ──────────────────
  const { data: voteDeadlineData } = useReadContract({
    address: viAddr, abi: VOTE_INCENTIVES_ABI, functionName: 'VOTE_DEADLINE',
    query: { enabled: bribes.isDeployed, staleTime: Infinity },
  });
  const voteDeadlineSec = voteDeadlineData ? Number(voteDeadlineData as bigint) : DEFAULT_VOTE_DEADLINE_SEC;
  const deadlineUnix = bribes.latestEpoch ? bribes.latestEpoch.timestamp + voteDeadlineSec : 0;

  const [nowSec, setNowSec] = useState(Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);
  const votingOpen = hasEpochs && deadlineUnix > 0 && nowSec < deadlineUnix;

  // ── User snapshot power + used votes ────────────────────────
  const { data: userPowerData } = useReadContract({
    address: TEGRIDY_STAKING_ADDRESS, abi: TEGRIDY_STAKING_ABI,
    functionName: 'votingPowerAtTimestamp',
    args: address && bribes.latestEpoch ? [address, BigInt(bribes.latestEpoch.timestamp)] : undefined,
    query: { enabled: !!address && !!bribes.latestEpoch, refetchInterval: 60_000 },
  });
  const userPower = (userPowerData as bigint | undefined) ?? 0n;

  const { data: userUsedData } = useReadContract({
    address: viAddr, abi: VOTE_INCENTIVES_ABI, functionName: 'userTotalVotes',
    args: address ? [address, BigInt(prevEpoch)] : undefined,
    query: { enabled: !!address && hasEpochs, refetchInterval: 30_000 },
  });
  const userUsed = (userUsedData as bigint | undefined) ?? 0n;
  const remainingPower = userPower > userUsed ? userPower - userUsed : 0n;

  // ── Per-pair votes (total + user's) ─────────────────────────
  const voteReads = useMemo(
    () =>
      gauges.flatMap((g) => {
        const base: Array<any> = [
          { address: viAddr, abi: VOTE_INCENTIVES_ABI, functionName: 'totalGaugeVotes' as const, args: [BigInt(prevEpoch), g.pair] as const },
        ];
        if (address) {
          base.push({
            address: viAddr, abi: VOTE_INCENTIVES_ABI, functionName: 'gaugeVotes' as const,
            args: [address, BigInt(prevEpoch), g.pair] as const,
          });
        }
        return base;
      }),
    [gauges, prevEpoch, address, viAddr],
  );
  const { data: voteData } = useReadContracts({
    contracts: voteReads,
    query: { enabled: hasEpochs && gauges.length > 0, refetchInterval: 30_000 },
  });
  const perPairVotes = useMemo(() => {
    const stride = address ? 2 : 1;
    const m = new Map<string, { total: bigint; user: bigint }>();
    gauges.forEach((g, i) => {
      const totalR = voteData?.[i * stride];
      const userR = address ? voteData?.[i * stride + 1] : undefined;
      const total = totalR?.status === 'success' ? (totalR.result as bigint) : 0n;
      const user = userR?.status === 'success' ? (userR.result as bigint) : 0n;
      m.set(g.pair.toLowerCase(), { total, user });
    });
    return m;
  }, [gauges, voteData, address]);

  // ── Active bribe token list per gauge (current deposit epoch) ──
  const tokenListReads = useMemo(
    () => gauges.map((g) => ({
      address: viAddr, abi: VOTE_INCENTIVES_ABI, functionName: 'getEpochBribeTokens' as const,
      args: [BigInt(depositEpoch), g.pair] as const,
    })),
    [gauges, depositEpoch, viAddr],
  );
  const { data: tokenListData } = useReadContracts({
    contracts: tokenListReads,
    query: { enabled: bribes.isDeployed && gauges.length > 0, refetchInterval: 60_000 },
  });
  const tokensByPair = useMemo<Map<string, Address[]>>(() => {
    const m = new Map<string, Address[]>();
    if (!tokenListData) return m;
    gauges.forEach((g, i) => {
      const r = tokenListData[i];
      if (r?.status === 'success') m.set(g.pair.toLowerCase(), r.result as Address[]);
    });
    return m;
  }, [gauges, tokenListData]);

  const amountReads = useMemo(() => {
    const out: { pair: Address; token: Address }[] = [];
    gauges.forEach((g) => {
      const tokens = tokensByPair.get(g.pair.toLowerCase()) ?? [];
      tokens.forEach((t) => out.push({ pair: g.pair, token: t }));
    });
    return out;
  }, [gauges, tokensByPair]);
  const { data: amountData } = useReadContracts({
    contracts: amountReads.map(({ pair, token }) => ({
      address: viAddr, abi: VOTE_INCENTIVES_ABI, functionName: 'epochBribes' as const,
      args: [BigInt(depositEpoch), pair, token] as const,
    })),
    query: { enabled: amountReads.length > 0, refetchInterval: 60_000 },
  });

  // ── Historical ETH totals (lookback of HISTORY_LOOKBACK_EPOCHS) ──
  const historyEpochs = useMemo(() => {
    const arr: number[] = [];
    for (let i = 0; i < HISTORY_LOOKBACK_EPOCHS; i++) {
      const e = depositEpoch - i;
      if (e >= 0) arr.push(e);
    }
    return arr;
  }, [depositEpoch]);
  const historyReads = useMemo(
    () => gauges.flatMap((g) => historyEpochs.map((e) => ({
      address: viAddr, abi: VOTE_INCENTIVES_ABI, functionName: 'epochBribes' as const,
      args: [BigInt(e), g.pair, ZERO_ADDRESS] as const,
    }))),
    [gauges, historyEpochs, viAddr],
  );
  const { data: historyData } = useReadContracts({
    contracts: historyReads,
    query: { enabled: gauges.length > 0 && historyEpochs.length > 0, refetchInterval: 120_000 },
  });

  const pairSummaries = useMemo<PairBribeSummary[]>(() => {
    const byPair = new Map<string, EpochBribe[]>();
    gauges.forEach((g) => byPair.set(g.pair.toLowerCase(), []));
    amountReads.forEach((entry, i) => {
      const amt = amountData?.[i]?.status === 'success' ? (amountData[i]!.result as bigint) : 0n;
      if (amt > 0n) {
        const list = byPair.get(entry.pair.toLowerCase()) ?? [];
        list.push({ token: entry.token, amount: amt });
        byPair.set(entry.pair.toLowerCase(), list);
      }
    });
    const stride = historyEpochs.length;
    return gauges.map((g, gi) => {
      const list = byPair.get(g.pair.toLowerCase()) ?? [];
      const ethEntry = list.find((b) => b.token.toLowerCase() === ZERO_ADDRESS);
      const tokenEntries = list.filter((b) => b.token.toLowerCase() !== ZERO_ADDRESS);
      let historical = 0n;
      for (let i = 0; i < stride; i++) {
        const r = historyData?.[gi * stride + i];
        if (r?.status === 'success') historical += r.result as bigint;
      }
      return {
        pair: g.pair,
        bribes: list,
        ethAmount: ethEntry?.amount ?? 0n,
        tokenCount: tokenEntries.length,
        historicalEthAmount: historical,
      };
    });
  }, [amountReads, amountData, gauges, historyData, historyEpochs]);

  // ── Multi-epoch user claimables ─────────────────────────────
  const epochsToCheck = useMemo(() => {
    const arr: number[] = [];
    for (let i = 0; i < CLAIM_LOOKBACK_EPOCHS; i++) {
      const e = prevEpoch - i;
      if (e >= 0) arr.push(e);
    }
    return arr;
  }, [prevEpoch]);
  const claimableReads = useMemo(
    () => address && currentEpoch > 0
      ? gauges.flatMap((g) => epochsToCheck.map((e) => ({
          address: viAddr, abi: VOTE_INCENTIVES_ABI, functionName: 'claimable' as const,
          args: [address, BigInt(e), g.pair] as const,
        })))
      : [],
    [address, gauges, currentEpoch, epochsToCheck, viAddr],
  );
  const { data: claimableData } = useReadContracts({
    contracts: claimableReads,
    query: { enabled: claimableReads.length > 0, refetchInterval: 60_000 },
  });
  const claimables = useMemo<PairClaimable[]>(() => {
    if (!claimableData) return [];
    const stride = epochsToCheck.length;
    const rows: PairClaimable[] = [];
    gauges.forEach((g, gi) => {
      const tokenTotals = new Map<string, bigint>();
      const epochs: number[] = [];
      let total = 0n;
      for (let ei = 0; ei < stride; ei++) {
        const r = claimableData[gi * stride + ei];
        if (!r || r.status !== 'success') continue;
        const [tokens, amounts] = r.result as [Address[], bigint[]];
        let epochTotal = 0n;
        for (let ti = 0; ti < tokens.length; ti++) {
          const amt = amounts[ti] ?? 0n;
          if (amt === 0n) continue;
          const key2 = tokens[ti]!.toLowerCase();
          tokenTotals.set(key2, (tokenTotals.get(key2) ?? 0n) + amt);
          epochTotal += amt;
        }
        if (epochTotal > 0n) {
          epochs.push(epochsToCheck[ei]!);
          total += epochTotal;
        }
      }
      if (total === 0n) return;
      const tokenList: Address[] = [];
      const amountList: bigint[] = [];
      tokenTotals.forEach((amt, key2) => {
        tokenList.push(key2 as Address);
        amountList.push(amt);
      });
      rows.push({ pair: g.pair, tokens: tokenList, amounts: amountList, total, epochs: epochs.slice().sort((a, b) => a - b) });
    });
    return rows;
  }, [gauges, claimableData, epochsToCheck]);
  const claimableByPair = useMemo(() => {
    const m = new Map<string, bigint>();
    claimables.forEach((c) => m.set(c.pair.toLowerCase(), c.total));
    return m;
  }, [claimables]);

  // ── Whitelist lookup ────────────────────────────────────────
  const whitelistMap = useMemo(() => {
    const m = new Map<string, WhitelistedToken>();
    bribes.whitelistedTokens.forEach((t) => m.set(t.address.toLowerCase(), t));
    return m;
  }, [bribes.whitelistedTokens]);

  // ── Pending ETH withdrawal ─────────────────────────────────
  const { data: pendingETHData } = useReadContracts({
    contracts: address
      ? [{ address: viAddr, abi: VOTE_INCENTIVES_ABI, functionName: 'pendingETHWithdrawals' as const, args: [address] as const }]
      : [],
    query: { enabled: !!address && bribes.isDeployed, refetchInterval: 30_000 },
  });
  const pendingETH = pendingETHData?.[0]?.status === 'success' ? (pendingETHData[0]!.result as bigint) : 0n;

  // ── Rescue countdown (for the current deposit epoch) ────────
  const { data: firstDepositData } = useReadContract({
    address: viAddr, abi: VOTE_INCENTIVES_ABI, functionName: 'epochBribeFirstDeposit',
    args: [BigInt(depositEpoch)],
    query: { enabled: bribes.isDeployed && hasEpochs, refetchInterval: 120_000 },
  });
  const firstDepositAt = firstDepositData ? Number(firstDepositData as bigint) : 0;
  const { data: rescueDelayData } = useReadContract({
    address: viAddr, abi: VOTE_INCENTIVES_ABI, functionName: 'BRIBE_RESCUE_DELAY',
    query: { enabled: bribes.isDeployed, staleTime: Infinity },
  });
  const rescueDelaySec = rescueDelayData ? Number(rescueDelayData as bigint) : 30 * 24 * 60 * 60;

  // ── Handlers ───────────────────────────────────────────────
  const handleWithdrawPendingETH = () => {
    writeLocal({ address: viAddr, abi: VOTE_INCENTIVES_ABI, functionName: 'withdrawPendingETH' });
  };
  const handleWithdrawPendingToken = (tok: Address) => bribes.withdrawPendingToken(tok);
  const isBusy = bribes.isPending || bribes.isConfirming || isLocalSigning || isLocalConfirming;

  const handleClaim = (pair: Address) => {
    if (currentEpoch < 1) return;
    const row = claimables.find((c) => c.pair.toLowerCase() === pair.toLowerCase());
    if (!row || row.epochs.length === 0) { bribes.claimBribes(prevEpoch, pair); return; }
    const first = row.epochs[0]!;
    const last = row.epochs[row.epochs.length - 1]!;
    if (first === last) bribes.claimBribes(first, pair);
    else bribes.claimBribesBatch(first, last, pair);
  };

  const handleLegacyVote = () => {
    if (!selectedPair || !voteInput || Number(voteInput) <= 0) return;
    try {
      const p = parseEther(voteInput);
      if (p > remainingPower) return; // guarded in UI too
      bribes.vote(prevEpoch, selectedPair, p);
      setVoteInput('');
    } catch { /* invalid */ }
  };

  const handleCommitVote = (_pair: Address, _power: bigint, commitHash: Hex, record: Omit<CommitRecord, 'commitIndex' | 'committedAt'>) => {
    if (!address) return;
    // Capture hash + record; persist after we learn the commitIndex on success.
    bribes.commitVote(prevEpoch, commitHash);
    // We don't know the commitIndex yet — we'll reconcile by reading voterCommits.length on next refetch.
    // Stash a pending record keyed by commitHash so we can assign commitIndex when we see it.
    const key = COMMIT_KEY(chainId, address, prevEpoch);
    const existing = loadCommits(key);
    const tentativeIndex = existing.length; // contract pushes to same array so index ≈ current length
    const rec: CommitRecord = { ...record, commitIndex: tentativeIndex, committedAt: Math.floor(Date.now() / 1000) };
    saveCommits(key, [...existing, rec]);
  };
  const handleRevealVote = (commitIndex: number, pair: Address, power: bigint, salt: Hex) => {
    bribes.revealVote(prevEpoch, commitIndex, pair, power, salt);
  };

  // ── Leaderboard filter / sort ──────────────────────────────
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortKey>('bribe');
  const [hideEmpty, setHideEmpty] = useState(false);

  const rankedRows = useMemo(() => {
    const combined = gauges.map((g) => {
      const summary = pairSummaries.find((p) => p.pair === g.pair) ?? {
        pair: g.pair, bribes: [], ethAmount: 0n, tokenCount: 0, historicalEthAmount: 0n,
      };
      const votes = perPairVotes.get(g.pair.toLowerCase()) ?? { total: 0n, user: 0n };
      const claimable = claimableByPair.get(g.pair.toLowerCase()) ?? 0n;
      return { gauge: g, summary, votes, claimable };
    });
    const filtered = combined.filter((r) => {
      if (hideEmpty && r.summary.ethAmount === 0n && r.summary.tokenCount === 0) return false;
      if (!search) return true;
      const q = search.toLowerCase();
      return r.gauge.label.toLowerCase().includes(q) || r.gauge.pair.toLowerCase().includes(q);
    });
    const sorted = [...filtered].sort((a, b) => {
      switch (sort) {
        case 'votes': return b.votes.total > a.votes.total ? 1 : b.votes.total < a.votes.total ? -1 : 0;
        case 'yours': return b.votes.user > a.votes.user ? 1 : b.votes.user < a.votes.user ? -1 : 0;
        case 'claimable': return b.claimable > a.claimable ? 1 : b.claimable < a.claimable ? -1 : 0;
        case 'bribe': default:
          if (a.summary.ethAmount !== b.summary.ethAmount) return b.summary.ethAmount > a.summary.ethAmount ? 1 : -1;
          return b.summary.tokenCount - a.summary.tokenCount;
      }
    });
    return sorted;
  }, [gauges, pairSummaries, perPairVotes, claimableByPair, search, sort, hideEmpty]);

  // ── Not deployed guard ─────────────────────────────────────
  if (!bribes.isDeployed) {
    return (
      <div className="rounded-2xl p-5 text-center relative overflow-hidden" style={{ border: `1px solid ${CARD_BORDER}` }}>
        <div className="absolute inset-0">
          <ArtImg pageId="vote-incentives" idx={0} alt="" loading="lazy" className="w-full h-full object-cover" />
        </div>
        <div className="absolute inset-0" style={{ background: 'rgba(6,12,26,0.88)' }} />
        <p className="relative z-10 text-white/80 text-[13px]">VoteIncentives contract not deployed yet.</p>
      </div>
    );
  }

  const canLegacyVote = votingOpen && isConnected && userPower > 0n && !epochUsesCR;

  return (
    <div className="space-y-4">
      <PersonaCards />

      <PendingFeeBanner current={bribes.bribeFeeBps} pending={bribes.pendingFeeBps} executeAt={bribes.feeChangeTime} now={nowSec} />

      <CommitRevealBanner enabled={bribes.commitRevealEnabled} epochUsesCR={epochUsesCR} />

      <RescueBanner firstDepositAt={firstDepositAt} rescueDelaySec={rescueDelaySec} now={nowSec} />

      <HowItWorks />

      <OverviewStrip epoch={currentEpoch} epochCount={bribes.epochCount} feeBps={bribes.bribeFeeBps} />

      <VotingPowerBanner
        userPower={userPower}
        userUsed={userUsed}
        deadline={deadlineUnix}
        now={nowSec}
        voteEpoch={prevEpoch}
        isConnected={isConnected}
      />

      <PendingWithdrawalsPanel
        pendingETH={pendingETH}
        tokens={bribes.whitelistedTokens}
        onWithdrawETH={handleWithdrawPendingETH}
        onWithdrawToken={handleWithdrawPendingToken}
        isBusy={isBusy}
      />

      <ClaimablesPanel
        claimables={claimables}
        gauges={gauges}
        onClaim={handleClaim}
        isBusy={isBusy}
        isConnected={isConnected}
        currentEpoch={currentEpoch}
      />

      {/* Commit-reveal panel replaces inline voting when the active epoch is
          in two-phase mode. Otherwise the leaderboard row hosts the vote. */}
      {hasEpochs && epochUsesCR && votingOpen && (
        <CommitRevealPanel
          gauges={gauges}
          voteEpoch={prevEpoch}
          epochTimestamp={bribes.latestEpoch?.timestamp ?? 0}
          voteDeadlineSec={voteDeadlineSec}
          now={nowSec}
          userPower={userPower}
          userUsed={userUsed}
          commitBond={bribes.commitBond}
          toweliAllowance={bribes.toweliAllowance}
          isBusy={isBusy}
          isPending={bribes.isPending}
          isConfirming={bribes.isConfirming}
          onApproveBond={bribes.approveToweliForBond}
          onCommit={handleCommitVote}
          onReveal={handleRevealVote}
        />
      )}

      <div id={LEADERBOARD_ID} className="rounded-2xl overflow-hidden relative scroll-mt-20" style={{ border: `1px solid ${CARD_BORDER}` }}>
        <div className="absolute inset-0">
          <ArtImg pageId="vote-incentives" idx={1} alt="" loading="lazy" className="w-full h-full object-cover" />
        </div>
        <div className="absolute inset-0" style={{ background: 'rgba(6,12,26,0.88)' }} />
        <div className="relative z-10">
          <div className="px-5 py-4 border-b border-white/10 flex items-center gap-2 flex-wrap">
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-200 border border-purple-500/40 font-semibold uppercase tracking-wider">For Voters</span>
            <h3 className="text-sm font-semibold text-white" style={{ textShadow: '0 1px 4px rgba(0,0,0,0.9)' }}>
              Gauges {votingOpen ? '— Voting Open' : hasEpochs ? '— Voting Closed' : ''}
            </h3>
            <InfoTooltip text="Each row is a whitelisted gauge. Tap a row to select it; if voting is open and you have power, a vote input appears inline." />
          </div>

          {gaugesLoading && gauges.length === 0 ? (
            /* AUDIT BRIBES-UX: shape-matching skeleton so the leaderboard
               doesn't collapse to a thin "Loading gauges…" line before
               the first read returns. Three rows at the expected row
               height keep layout stable. */
            <div className="divide-y divide-white/5" role="status" aria-label="Loading gauges">
              {[0, 1, 2].map((i) => (
                <div key={i} className="px-5 py-3 flex items-center justify-between gap-3 flex-wrap">
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="h-4 w-36 rounded bg-white/10 animate-pulse" />
                    <div className="h-3 w-24 rounded bg-white/5 animate-pulse" />
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="h-8 w-20 rounded bg-white/10 animate-pulse" />
                    <div className="h-8 w-24 rounded bg-white/10 animate-pulse" />
                    <div className="h-8 w-16 rounded bg-white/10 animate-pulse" />
                  </div>
                </div>
              ))}
              <span className="sr-only">Loading gauges…</span>
            </div>
          ) : gauges.length === 0 ? (
            <div className="p-8 text-center">
              <p className="text-white/70 text-[13px] mb-1">No gauges deployed yet.</p>
              <p className="text-white/45 text-[11.5px]">Governance whitelists gauges. Follow updates in Community → Governance.</p>
            </div>
          ) : (
            <>
              <LeaderboardControls
                search={search} setSearch={setSearch}
                sort={sort} setSort={setSort}
                hideEmpty={hideEmpty} setHideEmpty={setHideEmpty}
                total={gauges.length} shown={rankedRows.length}
              />
              {canLegacyVote && (
                <p className="px-5 pt-3 text-[11.5px] text-white/55">Tap a row to select it, then enter voting power below to earn that gauge's bribes.</p>
              )}
              {rankedRows.length === 0 ? (
                <div className="p-8 text-center">
                  <p className="text-white/70 text-[13px]">No gauges match that filter.</p>
                </div>
              ) : (
                <div className="divide-y divide-white/5">
                  {rankedRows.map((row) => (
                    <GaugeRow
                      key={row.gauge.pair}
                      gauge={row.gauge}
                      summary={row.summary}
                      totalVotes={row.votes.total}
                      userVotes={row.votes.user}
                      userClaimable={row.claimable}
                      whitelistMap={whitelistMap}
                      selected={selectedPair?.toLowerCase() === row.gauge.pair.toLowerCase()}
                      canVote={canLegacyVote}
                      voteDisabled={!canLegacyVote}
                      voteInput={voteInput}
                      setVoteInput={setVoteInput}
                      remainingPower={remainingPower}
                      onSelect={() => setSelectedPair(row.gauge.pair)}
                      onSubmitVote={handleLegacyVote}
                      isBusy={isBusy}
                      isPending={bribes.isPending}
                      isConfirming={bribes.isConfirming}
                      deadlineSeconds={Math.max(0, deadlineUnix - nowSec)}
                    />
                  ))}
                </div>
              )}
            </>
          )}
          {/* Skeleton loader moved above into the primary branch so the old
              "Loading gauges…" tail no longer renders below the empty-state. */}
        </div>
      </div>

      <DepositCard
        gauges={gauges}
        selectedPair={selectedPair}
        setSelectedPair={setSelectedPair}
        whitelistedTokens={bribes.whitelistedTokens}
        feeBps={bribes.bribeFeeBps}
        globalMinBribe={bribes.minBribeGlobal}
        onDepositETH={(pair, value) => bribes.depositBribeETH(pair, value)}
        onDepositToken={(pair, token, amount) => bribes.depositBribe(pair, token, amount)}
        onApprove={(token, amount) => bribes.approveToken(token, amount)}
        isBusy={isBusy}
        isPending={bribes.isPending || isLocalSigning}
        isConfirming={bribes.isConfirming || isLocalConfirming}
      />

      {/* Advance epoch — demoted to small footer chip */}
      <div className="flex items-center justify-between gap-3 flex-wrap text-[11.5px] pt-1">
        <a href={`https://etherscan.io/address/${VOTE_INCENTIVES_ADDRESS}`} target="_blank" rel="noopener noreferrer"
          className="text-white/35 hover:text-white/65 transition-colors font-mono">
          VoteIncentives: {shortenAddress(VOTE_INCENTIVES_ADDRESS)} &#8599;
        </a>
        <div className="flex items-center gap-2">
          <span className="text-white/45">
            Advance epoch: {bribes.cooldownRemaining > 0
              ? `cooldown ${formatCountdown(bribes.cooldownRemaining)}`
              : 'ready'}
          </span>
          <button onClick={() => bribes.advanceEpoch()}
            disabled={isBusy || bribes.cooldownRemaining > 0}
            className="px-2.5 py-1 rounded-md text-[11px] font-semibold text-white/80 border border-white/15 hover:border-white/30 hover:text-white transition-colors disabled:opacity-40">
            Advance
          </button>
          <InfoTooltip text="Snapshots the current epoch so bribes & votes lock in. Permissionless — anyone can call after the 1h cooldown. Rarely needed by voters or projects." />
        </div>
      </div>
    </div>
  );
}
