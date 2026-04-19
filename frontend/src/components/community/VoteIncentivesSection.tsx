import { useEffect, useMemo, useState } from 'react';
import { useAccount, useReadContract, useReadContracts, useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { formatEther, formatUnits, parseEther, parseUnits, type Address } from 'viem';
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
const DEFAULT_VOTE_DEADLINE_SEC = 7 * 24 * 60 * 60; // 7 days — matches contract constant

type SortKey = 'bribe' | 'votes' | 'yours' | 'claimable';
type EpochBribe = { token: Address; amount: bigint };

interface PairBribeSummary {
  pair: Address;
  bribes: EpochBribe[];
  ethAmount: bigint;
  tokenCount: number;
}

interface PairClaimable {
  pair: Address;
  /** Aggregated tokens across every epoch in the scan window that had a non-zero claim. */
  tokens: Address[];
  amounts: bigint[];
  total: bigint;
  /** Sorted ascending epochs in the scan window where this pair had a non-zero claim. */
  epochs: number[];
}

/** How far back to scan for unclaimed bribes per pair. Contract caps batch
 *  claims at MAX_CLAIM_EPOCHS = 500; 5 is more than enough for the typical
 *  user who claims every few epochs and keeps the reads bounded. */
const CLAIM_LOOKBACK_EPOCHS = 5;

// ─── How It Works explainer ─────────────────────────────────────────
function HowItWorks() {
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
            A bribe market for gauge voting. Projects rent voting power with ETH or whitelisted
            tokens; veTOWELI voters earn those bribes by directing emissions.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          {[
            { n: 1, title: 'Deposit', body: 'Project posts a bribe on a gauge — ETH or a whitelisted ERC20. 3% fee, rest sits in the epoch pool.' },
            { n: 2, title: 'Snapshot', body: 'advanceEpoch() locks voting power; a 7-day voting window opens.' },
            { n: 3, title: 'Vote', body: 'veTOWELI holders allocate power toward their chosen gauges inside the window.' },
            { n: 4, title: 'Claim', body: 'After the window closes, voters claim their pro-rata share of every bribe token on each voted gauge.' },
          ].map((s) => (
            <div key={s.n} className="rounded-xl p-4" style={{ background: 'rgba(13,21,48,0.7)', border: '1px solid rgba(255,255,255,0.1)' }}>
              <div className="flex items-center gap-2 mb-1.5">
                <span className="w-6 h-6 rounded-full bg-purple-500/40 border border-purple-500/60 text-[11px] font-bold text-white flex items-center justify-center">{s.n}</span>
                <p className="text-white text-[13px] font-semibold">{s.title}</p>
              </div>
              <p className="text-white/75 text-[12px] leading-relaxed">{s.body}</p>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="rounded-xl p-4" style={{ background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.25)' }}>
            <p className="text-[10px] uppercase tracking-wider text-emerald-400 mb-1 font-semibold">For projects earning votes</p>
            <p className="text-white text-[13px] font-medium mb-1">Rent voting power, mint no new supply.</p>
            <p className="text-white/70 text-[11.5px] leading-relaxed">
              Pay voters a fraction of what emitting your own token would cost. TOWELI emissions flow to your pool; your treasury keeps its token.
            </p>
          </div>
          <div className="rounded-xl p-4" style={{ background: 'rgba(139,92,246,0.08)', border: '1px solid rgba(139,92,246,0.25)' }}>
            <p className="text-[10px] uppercase tracking-wider text-purple-300 mb-1 font-semibold">For voters</p>
            <p className="text-white text-[13px] font-medium mb-1">Get paid to direct emissions.</p>
            <p className="text-white/70 text-[11.5px] leading-relaxed">
              Every gauge vote you cast captures its pro-rata slice of ETH and partner tokens. Claim at the end of the epoch.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Overview stats strip ──────────────────────────────────────────
function OverviewStrip({ epoch, epochCount, feeBps }: { epoch: number; epochCount: number; feeBps: number }) {
  const items = [
    { label: 'Current Epoch', value: epoch > 0 ? `#${epoch}` : '--' },
    { label: 'Total Epochs', value: epochCount > 0 ? epochCount.toString() : '--' },
    { label: 'Bribe Fee', value: feeBps > 0 ? `${(feeBps / 100).toFixed(2)}%` : '--' },
  ];
  return (
    <div className="grid grid-cols-3 gap-3">
      {items.map(({ label, value }, i) => (
        <div key={label} className="rounded-xl relative overflow-hidden" style={{ border: `1px solid ${CARD_BORDER}` }}>
          <div className="absolute inset-0">
            <img src={STAT_ARTS[i % STAT_ARTS.length]!.src} alt="" loading="lazy" className="w-full h-full object-cover" />
          </div>
          <div className="absolute inset-0" style={{ background: 'rgba(6,12,26,0.72)' }} />
          <div className="relative z-10 p-4">
            <p className="text-[10px] text-white/70 uppercase tracking-wider mb-1" style={{ textShadow: '0 1px 4px rgba(0,0,0,0.85)' }}>{label}</p>
            <p className="text-lg font-semibold text-white" style={{ textShadow: '0 1px 4px rgba(0,0,0,0.9)' }}>{value}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Voting power banner ───────────────────────────────────────────
function VotingPowerBanner({
  userPower,
  userUsed,
  deadline,
  now,
  voteEpoch,
  isConnected,
}: {
  userPower: bigint;
  userUsed: bigint;
  deadline: number; // unix seconds; 0 if unknown
  now: number;
  voteEpoch: number;
  isConnected: boolean;
}) {
  const remaining = userPower > userUsed ? userPower - userUsed : 0n;
  const usedPct = userPower > 0n ? Number((userUsed * 10000n) / userPower) / 100 : 0;
  const secondsLeft = Math.max(0, deadline - now);
  const deadlineOpen = deadline > 0 && secondsLeft > 0;
  const d = Math.floor(secondsLeft / 86400);
  const h = Math.floor((secondsLeft % 86400) / 3600);
  const min = Math.floor((secondsLeft % 3600) / 60);
  const countdown = d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${min}m` : `${min}m`;

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
            <InfoTooltip text="Voting power snapshot at the moment advanceEpoch() was called. Allocate any amount to a gauge to earn its bribes; vote updates are additive." />
          </div>
          {!isConnected ? (
            <p className="text-white/75 text-[13px]">Connect a wallet to see your voting power.</p>
          ) : userPower === 0n ? (
            <p className="text-yellow-300 text-[13px]">Stake TOWELI before the next snapshot to earn voting power.</p>
          ) : (
            <>
              <div className="flex items-baseline gap-2 flex-wrap">
                <p className="stat-value text-white text-[22px] font-mono">{formatTokenAmount(formatEther(remaining), 2)}</p>
                <p className="text-white/55 text-[12px]">remaining of {formatTokenAmount(formatEther(userPower), 2)} total</p>
              </div>
              <div className="mt-2 h-1.5 rounded-full bg-white/10 overflow-hidden">
                <div
                  className="h-full rounded-full"
                  style={{ width: `${Math.min(100, usedPct)}%`, background: 'linear-gradient(90deg, rgb(139 92 246), rgb(124 58 237))' }}
                />
              </div>
              <p className="text-white/55 text-[11px] mt-1">{usedPct.toFixed(1)}% allocated</p>
            </>
          )}
        </div>
        <div className="text-right flex-shrink-0">
          <p className="text-[10px] uppercase tracking-wider text-white/55">Vote Deadline</p>
          <p className={`text-[15px] font-semibold ${deadlineOpen ? 'text-emerald-300' : 'text-red-300'}`}>
            {deadline === 0 ? '—' : deadlineOpen ? countdown : 'Closed'}
          </p>
        </div>
      </div>
    </div>
  );
}

// ─── Your Claimables ───────────────────────────────────────────────
function ClaimablesPanel({
  claimables,
  gauges,
  onClaim,
  isBusy,
}: {
  claimables: PairClaimable[];
  gauges: GaugeInfo[];
  onClaim: (pair: Address) => void;
  isBusy: boolean;
}) {
  if (claimables.length === 0) return null;
  const gaugeByAddr = new Map(gauges.map((g) => [g.pair.toLowerCase(), g]));
  const anyMulti = claimables.some((c) => c.epochs.length > 1);
  return (
    <div className="rounded-xl p-4" style={{ background: 'rgba(139,92,246,0.08)', border: '1px solid rgba(139,92,246,0.25)' }}>
      <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
        <div>
          <p className="text-[10px] uppercase tracking-wider text-purple-300 font-semibold">Your Claimables</p>
          <p className="text-white text-[13px]">
            {anyMulti
              ? `Unclaimed across up to ${CLAIM_LOOKBACK_EPOCHS} past epochs — batched per gauge`
              : 'Claim per gauge below'}
          </p>
        </div>
        <span className="text-[11px] text-white/55">{claimables.length} gauge{claimables.length === 1 ? '' : 's'}</span>
      </div>
      <div className="space-y-2">
        {claimables.map((c) => {
          const g = gaugeByAddr.get(c.pair.toLowerCase());
          const first = c.epochs[0]!;
          const last = c.epochs[c.epochs.length - 1]!;
          const epochRange = first === last ? `Epoch #${first}` : `Epochs #${first}–#${last}`;
          const buttonLabel = first === last ? 'Claim' : `Claim ${c.epochs.length} epochs`;
          return (
            <div key={c.pair} className="rounded-lg p-3 flex items-center justify-between gap-3 flex-wrap" style={{ background: 'rgba(13,21,48,0.7)', border: '1px solid rgba(255,255,255,0.08)' }}>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-white text-[13px] font-medium">{g?.label ?? shortenAddress(c.pair)}</p>
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-purple-500/20 text-purple-200 border border-purple-500/35 font-mono">{epochRange}</span>
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
              <button
                onClick={() => onClaim(c.pair)}
                disabled={isBusy}
                className="flex-shrink-0 px-4 py-2 rounded-lg text-[12px] font-semibold bg-purple-500/20 text-purple-200 border border-purple-500/40 hover:bg-purple-500/30 transition-colors disabled:opacity-40"
              >
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
function LeaderboardControls({
  search,
  setSearch,
  sort,
  setSort,
  hideEmpty,
  setHideEmpty,
  total,
  shown,
}: {
  search: string;
  setSearch: (v: string) => void;
  sort: SortKey;
  setSort: (v: SortKey) => void;
  hideEmpty: boolean;
  setHideEmpty: (v: boolean) => void;
  total: number;
  shown: number;
}) {
  return (
    <div className="flex items-center gap-3 flex-wrap px-5 py-3 border-b border-white/10">
      <input
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search gauge…"
        className="flex-1 min-w-[140px] bg-black/50 border border-white/15 rounded-lg px-3 py-2 text-white text-[12px] focus:border-purple-500 outline-none transition-colors"
      />
      <select
        value={sort}
        onChange={(e) => setSort(e.target.value as SortKey)}
        className="bg-black/50 border border-white/15 rounded-lg px-3 py-2 text-white text-[12px] focus:border-purple-500 outline-none transition-colors"
      >
        <option value="bribe" className="bg-[#0a0f1a]">Sort: Bribe TVL</option>
        <option value="votes" className="bg-[#0a0f1a]">Sort: Total Votes</option>
        <option value="yours" className="bg-[#0a0f1a]">Sort: Your Allocation</option>
        <option value="claimable" className="bg-[#0a0f1a]">Sort: Your Claimable</option>
      </select>
      <label className="flex items-center gap-1.5 text-white/70 text-[11.5px] cursor-pointer select-none">
        <input
          type="checkbox"
          checked={hideEmpty}
          onChange={(e) => setHideEmpty(e.target.checked)}
          className="w-3.5 h-3.5 accent-purple-500"
        />
        Hide empty
      </label>
      <span className="text-[11px] text-white/45 ml-auto">{shown} / {total}</span>
    </div>
  );
}

// ─── Gauge row ─────────────────────────────────────────────────────
function GaugeRow({
  gauge,
  summary,
  totalVotes,
  userVotes,
  userClaimable,
  whitelistMap,
  selected,
  canVote,
  voteInput,
  setVoteInput,
  onSelect,
  onSubmitVote,
  isBusy,
}: {
  gauge: GaugeInfo;
  summary: PairBribeSummary;
  totalVotes: bigint;
  userVotes: bigint;
  userClaimable: bigint;
  whitelistMap: Map<string, WhitelistedToken>;
  selected: boolean;
  canVote: boolean;
  voteInput: string;
  setVoteInput: (v: string) => void;
  onSelect: () => void;
  onSubmitVote: () => void;
  isBusy: boolean;
}) {
  const tokenBadges = summary.bribes.filter((b) => b.token.toLowerCase() !== ZERO_ADDRESS);
  const hasBribes = summary.ethAmount > 0n || tokenBadges.length > 0;

  return (
    <div className={`px-5 py-3 transition-colors ${selected ? 'bg-purple-500/12' : 'hover:bg-white/3'}`}>
      <button onClick={onSelect} type="button" className="w-full text-left">
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

      {/* Inline vote form (only when this row is selected and voting is open) */}
      {selected && canVote && hasBribes && (
        <div className="mt-3 flex items-center gap-2 flex-wrap">
          <input
            type="number"
            step="0.01"
            value={voteInput}
            onChange={(e) => setVoteInput(e.target.value)}
            placeholder="Voting power to add"
            className="flex-1 min-w-[160px] bg-black/60 border border-white/15 rounded-lg px-3 py-2 text-white text-[12px] font-mono focus:border-purple-500 outline-none transition-colors"
          />
          <button
            onClick={onSubmitVote}
            disabled={!voteInput || Number(voteInput) <= 0 || isBusy}
            className="px-4 py-2 rounded-lg text-[12px] font-semibold bg-purple-500/20 text-purple-200 border border-purple-500/40 hover:bg-purple-500/30 transition-colors disabled:opacity-40"
          >
            Cast Vote
          </button>
          {userClaimable > 0n && (
            <span className="text-[10px] text-emerald-300 ml-2">You&apos;d claim ~{formatTokenAmount(formatEther(userClaimable), 4)} now</span>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Deposit card ──────────────────────────────────────────────────
function DepositCard({
  gauges,
  selectedPair,
  setSelectedPair,
  whitelistedTokens,
  feeBps,
  onDepositETH,
  onDepositToken,
  onApprove,
  isBusy,
  isPending,
  isConfirming,
}: {
  gauges: GaugeInfo[];
  selectedPair: Address | null;
  setSelectedPair: (p: Address) => void;
  whitelistedTokens: WhitelistedToken[];
  feeBps: number;
  onDepositETH: (pair: Address, valueWei: bigint) => void;
  onDepositToken: (pair: Address, token: Address, amountWei: bigint) => void;
  onApprove: (token: Address, amountWei: bigint) => void;
  isBusy: boolean;
  isPending: boolean;
  isConfirming: boolean;
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

  const amountWei = useMemo(() => {
    if (!amount || Number(amount) <= 0) return 0n;
    try {
      if (mode === 'eth') return parseEther(amount);
      return parseUnits(amount, selectedToken?.decimals ?? 18);
    } catch {
      return 0n;
    }
  }, [amount, mode, selectedToken]);

  const feePreview = useMemo(() => {
    if (amountWei === 0n || feeBps === 0) return 0n;
    return (amountWei * BigInt(feeBps)) / 10000n;
  }, [amountWei, feeBps]);

  const needsApproval = mode === 'token' && selectedToken && amountWei > 0n && selectedToken.allowance < amountWei;
  const insufficientBalance = mode === 'token' && selectedToken && amountWei > selectedToken.balance;
  const canSubmit = !!selectedPair && amountWei > 0n && !isBusy && !insufficientBalance;

  const handleSubmit = () => {
    if (!selectedPair || amountWei === 0n) return;
    if (mode === 'eth') {
      onDepositETH(selectedPair, amountWei);
    } else if (selectedToken) {
      if (needsApproval) onApprove(selectedToken.address, amountWei);
      else onDepositToken(selectedPair, selectedToken.address, amountWei);
    }
  };

  const handleMax = () => {
    if (mode === 'token' && selectedToken) {
      setAmount(formatUnits(selectedToken.balance, selectedToken.decimals));
    }
  };

  return (
    <div className="rounded-2xl overflow-hidden relative" style={{ border: `1px solid ${CARD_BORDER}` }}>
      <div className="absolute inset-0">
        <ArtImg pageId="vote-incentives" idx={3} alt="" loading="lazy" className="w-full h-full object-cover" />
      </div>
      <div className="absolute inset-0" style={{ background: 'rgba(6,12,26,0.88)' }} />
      <div className="relative z-10">
        <div className="px-5 py-4 border-b border-white/10 flex items-center gap-2 flex-wrap">
          <h3 className="text-sm font-semibold text-white" style={{ textShadow: '0 1px 4px rgba(0,0,0,0.9)' }}>Deposit Bribe</h3>
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-purple-500/25 text-purple-200 border border-purple-500/40">
            {GOVERNANCE_COPY.bribesSectionTag}
          </span>
          <InfoTooltip text="Deposit ETH or a whitelisted ERC20 on a gauge. Voters earn a pro-rata share of your deposit after the 3% protocol fee." />
        </div>

        <div className="p-5 space-y-4">
          <div>
            <label className="text-[11px] text-white/65 uppercase tracking-wider block mb-1.5">Gauge</label>
            <select
              value={selectedPair ?? ''}
              onChange={(e) => setSelectedPair(e.target.value as Address)}
              className="w-full bg-black/50 border border-white/15 rounded-lg px-3 py-2.5 text-white text-[13px] font-mono focus:border-purple-500 outline-none transition-colors"
            >
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
              <button
                key={m}
                onClick={() => { setMode(m); setAmount(''); }}
                className="flex-1 py-2 rounded-lg text-[12px] font-semibold text-white transition-all"
                style={mode === m ? { background: 'var(--color-stan)', boxShadow: '0 4px 12px var(--color-stan-40)' } : undefined}
              >
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
                <select
                  value={tokenAddr ?? ''}
                  onChange={(e) => setTokenAddr(e.target.value as Address)}
                  className="w-full bg-black/50 border border-white/15 rounded-lg px-3 py-2.5 text-white text-[13px] font-mono focus:border-purple-500 outline-none transition-colors"
                >
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
              <label className="text-[11px] text-white/65 uppercase tracking-wider">Amount ({mode === 'eth' ? 'ETH' : selectedToken?.symbol ?? 'TOKEN'})</label>
              {mode === 'token' && selectedToken && (
                <button onClick={handleMax} type="button" className="text-[10.5px] text-purple-300 hover:text-purple-200 transition-colors">
                  Max: {formatTokenAmount(formatUnits(selectedToken.balance, selectedToken.decimals), 4)}
                </button>
              )}
            </div>
            <input
              type="number"
              step="0.001"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.1"
              className="w-full bg-black/50 border border-white/15 rounded-lg px-3 py-2.5 text-white text-[14px] font-mono focus:border-purple-500 outline-none transition-colors"
            />
            {amountWei > 0n && feeBps > 0 && (
              <p className="text-[10.5px] text-white/55 mt-1.5">
                Fee: {mode === 'eth'
                  ? `${formatTokenAmount(formatEther(feePreview), 6)} ETH`
                  : `${formatTokenAmount(formatUnits(feePreview, selectedToken?.decimals ?? 18), 6)} ${selectedToken?.symbol ?? ''}`}
                {' '}({(feeBps / 100).toFixed(2)}%) · Net reward pool: {mode === 'eth'
                  ? formatTokenAmount(formatEther(amountWei - feePreview), 6)
                  : formatTokenAmount(formatUnits(amountWei - feePreview, selectedToken?.decimals ?? 18), 6)}
              </p>
            )}
            {insufficientBalance && <p className="text-[11px] text-red-400 mt-1.5">Insufficient balance.</p>}
          </div>

          <button
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="w-full py-2.5 rounded-xl text-[13px] font-semibold transition-all disabled:opacity-40"
            style={{ background: 'linear-gradient(135deg, rgb(16 185 129), rgb(5 150 105))', color: 'white' }}
          >
            {!selectedPair
              ? 'Select a gauge'
              : amountWei === 0n
              ? 'Enter an amount'
              : isPending
              ? 'Confirm in Wallet…'
              : isConfirming
              ? 'Confirming…'
              : needsApproval
              ? `Approve ${selectedToken?.symbol ?? 'token'}`
              : `Deposit ${amount || '0'} ${mode === 'eth' ? 'ETH' : selectedToken?.symbol ?? ''}`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main section ───────────────────────────────────────────────────
export function VoteIncentivesSection() {
  const { address, isConnected } = useAccount();
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

  // Clear the vote input when user selects a different gauge.
  useEffect(() => { setVoteInput(''); }, [selectedPair]);

  const currentEpoch = bribes.currentEpoch;
  const prevEpoch = Math.max(0, currentEpoch - 1);
  const depositEpoch = currentEpoch;
  const hasEpochs = bribes.epochCount > 0;

  // ── Vote deadline: prefer on-chain constant, fall back to 7 days ───
  const { data: voteDeadlineData } = useReadContract({
    address: viAddr,
    abi: VOTE_INCENTIVES_ABI,
    functionName: 'VOTE_DEADLINE',
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

  // ── User voting power at epoch snapshot time ──────────────────
  const { data: userPowerData } = useReadContract({
    address: TEGRIDY_STAKING_ADDRESS,
    abi: TEGRIDY_STAKING_ABI,
    functionName: 'votingPowerAtTimestamp',
    args: address && bribes.latestEpoch ? [address, BigInt(bribes.latestEpoch.timestamp)] : undefined,
    query: { enabled: !!address && !!bribes.latestEpoch, refetchInterval: 60_000 },
  });
  const userPower = (userPowerData as bigint | undefined) ?? 0n;

  // ── User total votes used this epoch ──────────────────────────
  const { data: userUsedData } = useReadContract({
    address: viAddr,
    abi: VOTE_INCENTIVES_ABI,
    functionName: 'userTotalVotes',
    args: address ? [address, BigInt(prevEpoch)] : undefined,
    query: { enabled: !!address && hasEpochs, refetchInterval: 30_000 },
  });
  const userUsed = (userUsedData as bigint | undefined) ?? 0n;

  // ── Per-pair: totalGaugeVotes and (if connected) user's gaugeVotes ──
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

  // ── Active bribes for the upcoming epoch ───────────────────────
  const tokenListReads = useMemo(
    () =>
      gauges.map((g) => ({
        address: viAddr,
        abi: VOTE_INCENTIVES_ABI,
        functionName: 'getEpochBribeTokens' as const,
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
      address: viAddr,
      abi: VOTE_INCENTIVES_ABI,
      functionName: 'epochBribes' as const,
      args: [BigInt(depositEpoch), pair, token] as const,
    })),
    query: { enabled: amountReads.length > 0, refetchInterval: 60_000 },
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
    return gauges.map((g) => {
      const list = byPair.get(g.pair.toLowerCase()) ?? [];
      const ethEntry = list.find((b) => b.token.toLowerCase() === ZERO_ADDRESS);
      const tokenEntries = list.filter((b) => b.token.toLowerCase() !== ZERO_ADDRESS);
      return {
        pair: g.pair,
        bribes: list,
        ethAmount: ethEntry?.amount ?? 0n,
        tokenCount: tokenEntries.length,
      };
    });
  }, [amountReads, amountData, gauges]);

  // ── User claimables (scans up to CLAIM_LOOKBACK_EPOCHS past epochs per
  //    gauge so we can surface a batch-claim path when the user has unclaimed
  //    bribes across multiple epochs on the same pair).
  const epochsToCheck = useMemo(() => {
    const arr: number[] = [];
    for (let i = 0; i < CLAIM_LOOKBACK_EPOCHS; i++) {
      const e = prevEpoch - i;
      if (e >= 0) arr.push(e);
    }
    return arr; // newest → oldest
  }, [prevEpoch]);

  const claimableReads = useMemo(
    () =>
      address && currentEpoch > 0
        ? gauges.flatMap((g) =>
            epochsToCheck.map((e) => ({
              address: viAddr,
              abi: VOTE_INCENTIVES_ABI,
              functionName: 'claimable' as const,
              args: [address, BigInt(e), g.pair] as const,
            })),
          )
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
          const key = tokens[ti]!.toLowerCase();
          tokenTotals.set(key, (tokenTotals.get(key) ?? 0n) + amt);
          epochTotal += amt;
        }
        if (epochTotal > 0n) {
          epochs.push(epochsToCheck[ei]!);
          total += epochTotal;
        }
      }
      if (total === 0n) return;
      // Preserve canonical token addresses (keep the first-seen casing).
      const tokenList: Address[] = [];
      const amountList: bigint[] = [];
      tokenTotals.forEach((amt, key) => {
        tokenList.push(key as Address);
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

  // ── Whitelist lookup ──────────────────────────────────────────
  const whitelistMap = useMemo(() => {
    const m = new Map<string, WhitelistedToken>();
    bribes.whitelistedTokens.forEach((t) => m.set(t.address.toLowerCase(), t));
    return m;
  }, [bribes.whitelistedTokens]);

  // ── Pending ETH refund ────────────────────────────────────────
  const { data: pendingETHData } = useReadContracts({
    contracts: address
      ? [{ address: viAddr, abi: VOTE_INCENTIVES_ABI, functionName: 'pendingETHWithdrawals' as const, args: [address] as const }]
      : [],
    query: { enabled: !!address && bribes.isDeployed, refetchInterval: 30_000 },
  });
  const pendingETH = pendingETHData?.[0]?.status === 'success' ? (pendingETHData[0]!.result as bigint) : 0n;

  const handleWithdrawPending = () => {
    writeLocal({ address: viAddr, abi: VOTE_INCENTIVES_ABI, functionName: 'withdrawPendingETH' });
  };

  const isBusy = bribes.isPending || bribes.isConfirming || isLocalSigning || isLocalConfirming;

  const handleClaim = (pair: Address) => {
    if (currentEpoch < 1) return;
    const row = claimables.find((c) => c.pair.toLowerCase() === pair.toLowerCase());
    if (!row || row.epochs.length === 0) {
      bribes.claimBribes(prevEpoch, pair);
      return;
    }
    const first = row.epochs[0]!;
    const last = row.epochs[row.epochs.length - 1]!;
    if (first === last) {
      bribes.claimBribes(first, pair);
    } else {
      bribes.claimBribesBatch(first, last, pair);
    }
  };

  const handleVote = () => {
    if (!selectedPair || !voteInput || Number(voteInput) <= 0) return;
    try {
      const power = parseEther(voteInput);
      const remaining = userPower > userUsed ? userPower - userUsed : 0n;
      if (power > remaining) {
        // Surface a friendlier message before the contract reverts.
        alert(`Not enough voting power. Remaining: ${formatTokenAmount(formatEther(remaining), 4)}`);
        return;
      }
      bribes.vote(prevEpoch, selectedPair, power);
      setVoteInput('');
    } catch {
      // parseEther throws for invalid input
    }
  };

  // ── Leaderboard filter / sort ────────────────────────────────
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortKey>('bribe');
  const [hideEmpty, setHideEmpty] = useState(false);

  const rankedRows = useMemo(() => {
    const combined = gauges.map((g) => {
      const summary = pairSummaries.find((p) => p.pair === g.pair) ?? {
        pair: g.pair, bribes: [], ethAmount: 0n, tokenCount: 0,
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
        case 'bribe':
        default:
          if (a.summary.ethAmount !== b.summary.ethAmount)
            return b.summary.ethAmount > a.summary.ethAmount ? 1 : -1;
          return b.summary.tokenCount - a.summary.tokenCount;
      }
    });

    return sorted;
  }, [gauges, pairSummaries, perPairVotes, claimableByPair, search, sort, hideEmpty]);

  // ── Not deployed guard ────────────────────────────────────────
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

  return (
    <div className="space-y-4">
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

      {pendingETH > 0n && (
        <div className="rounded-xl p-4 flex items-center justify-between flex-wrap gap-2"
          style={{ background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.25)' }}>
          <div>
            <p className="text-[10px] uppercase tracking-wider text-emerald-400/80 mb-0.5">Pending ETH (refund)</p>
            <p className="text-emerald-400 text-[16px] font-semibold font-mono">{formatTokenAmount(formatEther(pendingETH), 6)} ETH</p>
          </div>
          <button
            onClick={handleWithdrawPending}
            disabled={isBusy}
            className="px-4 py-2 rounded-lg text-[12px] font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/25 hover:bg-emerald-500/25 transition-colors disabled:opacity-40"
          >
            Withdraw
          </button>
        </div>
      )}

      <ClaimablesPanel claimables={claimables} gauges={gauges} onClaim={handleClaim} isBusy={isBusy} />

      <div className="rounded-2xl overflow-hidden relative" style={{ border: `1px solid ${CARD_BORDER}` }}>
        <div className="absolute inset-0">
          <ArtImg pageId="vote-incentives" idx={1} alt="" loading="lazy" className="w-full h-full object-cover" />
        </div>
        <div className="absolute inset-0" style={{ background: 'rgba(6,12,26,0.88)' }} />
        <div className="relative z-10">
          <div className="px-5 py-4 border-b border-white/10 flex items-center gap-2 flex-wrap">
            <h3 className="text-sm font-semibold text-white" style={{ textShadow: '0 1px 4px rgba(0,0,0,0.9)' }}>
              Gauges {votingOpen ? '— Voting Open' : hasEpochs ? '— Voting Closed' : ''}
            </h3>
            <InfoTooltip text="Each row is a whitelisted gauge. Tap to pre-select in the deposit form below. When voting is open, cast power inline to earn that row's bribes." />
          </div>

          {gauges.length === 0 ? (
            <div className="p-8 text-center">
              <p className="text-white/70 text-[13px] mb-1">No gauges deployed yet.</p>
              <p className="text-white/45 text-[11.5px]">Once the team whitelists pairs, they'll show up here.</p>
            </div>
          ) : (
            <>
              <LeaderboardControls
                search={search}
                setSearch={setSearch}
                sort={sort}
                setSort={setSort}
                hideEmpty={hideEmpty}
                setHideEmpty={setHideEmpty}
                total={gauges.length}
                shown={rankedRows.length}
              />
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
                      canVote={votingOpen && isConnected && userPower > 0n}
                      voteInput={voteInput}
                      setVoteInput={setVoteInput}
                      onSelect={() => setSelectedPair(row.gauge.pair)}
                      onSubmitVote={handleVote}
                      isBusy={isBusy}
                    />
                  ))}
                </div>
              )}
            </>
          )}
          {gaugesLoading && gauges.length === 0 && (
            <div className="p-6 text-center"><p className="text-white/50 text-[12px]">Loading gauges…</p></div>
          )}
        </div>
      </div>

      <DepositCard
        gauges={gauges}
        selectedPair={selectedPair}
        setSelectedPair={setSelectedPair}
        whitelistedTokens={bribes.whitelistedTokens}
        feeBps={bribes.bribeFeeBps}
        onDepositETH={(pair, value) => bribes.depositBribeETH(pair, value)}
        onDepositToken={(pair, token, amount) => bribes.depositBribe(pair, token, amount)}
        onApprove={(token, amount) => bribes.approveToken(token, amount)}
        isBusy={isBusy}
        isPending={bribes.isPending || isLocalSigning}
        isConfirming={bribes.isConfirming || isLocalConfirming}
      />

      <div className="rounded-xl p-4 flex items-center justify-between gap-3 flex-wrap"
        style={{ background: 'rgba(13,21,48,0.7)', border: `1px solid ${CARD_BORDER}` }}>
        <div className="min-w-0">
          <p className="text-white text-[13px] font-medium flex items-center gap-2">
            Advance Epoch
            <InfoTooltip text="Snapshots the current epoch so bribes & votes lock in. Permissionless — anyone can call after the 1h cooldown." />
          </p>
          <p className="text-white/55 text-[11px]">
            {bribes.cooldownRemaining > 0
              ? `Cooldown: ${Math.floor(bribes.cooldownRemaining / 60)}m ${bribes.cooldownRemaining % 60}s`
              : 'Ready to advance'}
          </p>
        </div>
        <button
          onClick={() => bribes.advanceEpoch()}
          disabled={isBusy || bribes.cooldownRemaining > 0}
          className="px-4 py-2 rounded-lg text-[12px] font-semibold text-white/80 border border-white/15 hover:border-white/30 hover:text-white transition-colors disabled:opacity-40"
        >
          Advance
        </button>
      </div>

      <div className="text-center pt-1">
        <a
          href={`https://etherscan.io/address/${VOTE_INCENTIVES_ADDRESS}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-white/35 text-[11px] hover:text-white/65 transition-colors font-mono"
        >
          VoteIncentives: {shortenAddress(VOTE_INCENTIVES_ADDRESS)} &#8599;
        </a>
      </div>
    </div>
  );
}
