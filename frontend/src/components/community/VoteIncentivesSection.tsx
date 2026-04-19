import { useEffect, useMemo, useState } from 'react';
import { useAccount, useReadContracts, useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { formatEther, formatUnits, parseEther, parseUnits, type Address } from 'viem';
import { toast } from 'sonner';
import { VOTE_INCENTIVES_ADDRESS } from '../../lib/constants';
import { VOTE_INCENTIVES_ABI } from '../../lib/contracts';
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

type EpochBribe = { token: Address; amount: bigint };

interface PairBribeSummary {
  pair: Address;
  bribes: EpochBribe[];
  ethAmount: bigint;
  tokenCount: number;
}

interface PairClaimable {
  pair: Address;
  tokens: Address[];
  amounts: bigint[];
  total: bigint; // sum in raw units (not price-adjusted; display only)
}

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

        {/* 3-step how it works */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {[
            { n: 1, title: 'Deposit', body: 'Project posts a bribe on a gauge — ETH or a whitelisted ERC20. 3% fee, rest sits in the epoch pool.' },
            { n: 2, title: 'Vote', body: 'veTOWELI holders allocate voting power toward that gauge before the snapshot.' },
            { n: 3, title: 'Claim', body: 'After the epoch advances, voters claim their pro-rata share of every bribe token on that gauge.' },
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

        {/* Dual value props */}
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

// ─── Your Claimables row ───────────────────────────────────────────
function ClaimablesPanel({
  claimables,
  gauges,
  prevEpoch,
  onClaim,
  isBusy,
}: {
  claimables: PairClaimable[];
  gauges: GaugeInfo[];
  prevEpoch: number;
  onClaim: (pair: Address) => void;
  isBusy: boolean;
}) {
  if (claimables.length === 0) return null;
  const gaugeByAddr = new Map(gauges.map((g) => [g.pair.toLowerCase(), g]));

  return (
    <div className="rounded-xl p-4" style={{ background: 'rgba(139,92,246,0.08)', border: '1px solid rgba(139,92,246,0.25)' }}>
      <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
        <div>
          <p className="text-[10px] uppercase tracking-wider text-purple-300 font-semibold">Your Claimables</p>
          <p className="text-white text-[13px]">Epoch #{prevEpoch} — claim per gauge below</p>
        </div>
        <span className="text-[11px] text-white/55">{claimables.length} gauge{claimables.length === 1 ? '' : 's'}</span>
      </div>
      <div className="space-y-2">
        {claimables.map((c) => {
          const g = gaugeByAddr.get(c.pair.toLowerCase());
          return (
            <div key={c.pair} className="rounded-lg p-3 flex items-center justify-between gap-3 flex-wrap" style={{ background: 'rgba(13,21,48,0.7)', border: '1px solid rgba(255,255,255,0.08)' }}>
              <div className="min-w-0 flex-1">
                <p className="text-white text-[13px] font-medium">{g?.label ?? shortenAddress(c.pair)}</p>
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
                Claim
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Gauge leaderboard ─────────────────────────────────────────────
function GaugeLeaderboard({
  rows,
  gauges,
  selectedPair,
  onSelect,
  whitelistMap,
}: {
  rows: PairBribeSummary[];
  gauges: GaugeInfo[];
  selectedPair: Address | null;
  onSelect: (pair: Address) => void;
  whitelistMap: Map<string, WhitelistedToken>;
}) {
  if (gauges.length === 0) {
    return (
      <div className="rounded-xl p-5 text-center" style={{ background: 'rgba(13,21,48,0.7)', border: `1px solid ${CARD_BORDER}` }}>
        <p className="text-white/70 text-[13px]">No gauges deployed yet.</p>
      </div>
    );
  }

  const gaugeByAddr = new Map(gauges.map((g) => [g.pair.toLowerCase(), g]));
  // Rank pairs: those with bribes come first (by ETH amount desc, then token count).
  const ranked = [...rows].sort((a, b) => {
    if (a.ethAmount !== b.ethAmount) return b.ethAmount > a.ethAmount ? 1 : -1;
    return b.tokenCount - a.tokenCount;
  });

  return (
    <div className="rounded-2xl overflow-hidden relative" style={{ border: `1px solid ${CARD_BORDER}` }}>
      <div className="absolute inset-0">
        <ArtImg pageId="vote-incentives" idx={1} alt="" loading="lazy" className="w-full h-full object-cover" />
      </div>
      <div className="absolute inset-0" style={{ background: 'rgba(6,12,26,0.85)' }} />
      <div className="relative z-10">
        <div className="px-5 py-4 border-b border-white/10 flex items-center gap-2">
          <h3 className="text-sm font-semibold text-white" style={{ textShadow: '0 1px 4px rgba(0,0,0,0.9)' }}>Active Bribes — This Epoch</h3>
          <InfoTooltip text="Every gauge with a deposited bribe for the current epoch. Tap a row to pre-select it in the deposit form below." />
        </div>
        <div className="divide-y divide-white/5">
          {ranked.map((r) => {
            const g = gaugeByAddr.get(r.pair.toLowerCase());
            const isSelected = selectedPair?.toLowerCase() === r.pair.toLowerCase();
            const tokenBadges = r.bribes.filter((b) => b.token.toLowerCase() !== ZERO_ADDRESS);
            return (
              <button
                key={r.pair}
                onClick={() => onSelect(r.pair)}
                className={`w-full text-left px-5 py-3 transition-colors ${isSelected ? 'bg-purple-500/12' : 'hover:bg-white/3'}`}
              >
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-white text-[14px] font-semibold">{g?.label ?? shortenAddress(r.pair)}</p>
                      {isSelected && (
                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-purple-500/25 text-purple-200 border border-purple-500/40">Selected</span>
                      )}
                    </div>
                    <p className="text-white/50 text-[11px] font-mono">{shortenAddress(r.pair)}</p>
                  </div>
                  <div className="flex items-center gap-4 flex-wrap text-right">
                    <div>
                      <p className="text-[10px] text-white/50 uppercase tracking-wider">ETH Bribe</p>
                      <p className="text-white text-[13px] stat-value font-mono">{r.ethAmount > 0n ? `${formatTokenAmount(formatEther(r.ethAmount), 4)} ETH` : '—'}</p>
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
                        {tokenBadges.length > 3 && (
                          <span className="text-[10.5px] text-white/50">+{tokenBadges.length - 3}</span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>
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

  // Default to first whitelisted token when switching to token mode
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

  const needsApproval =
    mode === 'token' && selectedToken && amountWei > 0n && selectedToken.allowance < amountWei;

  const insufficientBalance =
    mode === 'token' && selectedToken && amountWei > selectedToken.balance;

  const canSubmit =
    !!selectedPair && amountWei > 0n && !isBusy && !insufficientBalance;

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
          {/* Pair selector */}
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

          {/* Mode tabs */}
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

          {/* Token picker — only in token mode */}
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

          {/* Amount input */}
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
            {insufficientBalance && (
              <p className="text-[11px] text-red-400 mt-1.5">Insufficient balance.</p>
            )}
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
  const { address } = useAccount();
  const bribes = useBribes();
  const { gauges, isLoading: gaugesLoading } = useGaugeList();
  const viAddr = VOTE_INCENTIVES_ADDRESS as Address;

  // Local tx lifecycle for withdrawPendingETH so it doesn't fight bribes hook txs.
  const { writeContract: writeLocal, data: localTx, isPending: isLocalSigning } = useWriteContract();
  const { isLoading: isLocalConfirming } = useWaitForTransactionReceipt({ hash: localTx });

  // Selected gauge for the deposit form. Starts with the first gauge once loaded.
  const [selectedPair, setSelectedPair] = useState<Address | null>(null);
  useEffect(() => {
    if (!selectedPair && gauges.length > 0) setSelectedPair(gauges[0]!.pair);
  }, [gauges, selectedPair]);

  const currentEpoch = bribes.currentEpoch;
  const prevEpoch = Math.max(0, currentEpoch - 1);
  const depositEpoch = currentEpoch; // epochs.length — bribes deposit into the upcoming epoch snapshot

  // ── Active bribes for the upcoming epoch ───────────────────────
  // Pass 1: read token list per gauge.
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

  // Pass 2: read amount for each (pair, token) tuple.
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

  // ── User claimables for previous epoch across every gauge ──────
  const claimableReads = useMemo(
    () =>
      address && currentEpoch > 0
        ? gauges.map((g) => ({
            address: viAddr,
            abi: VOTE_INCENTIVES_ABI,
            functionName: 'claimable' as const,
            args: [address, BigInt(prevEpoch), g.pair] as const,
          }))
        : [],
    [address, gauges, currentEpoch, prevEpoch, viAddr],
  );
  const { data: claimableData } = useReadContracts({
    contracts: claimableReads,
    query: { enabled: claimableReads.length > 0, refetchInterval: 60_000 },
  });

  const claimables = useMemo<PairClaimable[]>(() => {
    if (!claimableData) return [];
    const rows: PairClaimable[] = [];
    gauges.forEach((g, i) => {
      const r = claimableData[i];
      if (r?.status !== 'success') return;
      const [tokens, amounts] = r.result as [Address[], bigint[]];
      const total = amounts.reduce((acc, a) => acc + (a ?? 0n), 0n);
      if (total > 0n) {
        rows.push({ pair: g.pair, tokens, amounts, total });
      }
    });
    return rows;
  }, [gauges, claimableData]);

  // ── Whitelist lookup ───────────────────────────────────────────
  const whitelistMap = useMemo(() => {
    const m = new Map<string, WhitelistedToken>();
    bribes.whitelistedTokens.forEach((t) => m.set(t.address.toLowerCase(), t));
    return m;
  }, [bribes.whitelistedTokens]);

  // ── Pending ETH withdrawal (pull pattern) ──────────────────────
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
    bribes.claimBribes(prevEpoch, pair);
  };

  // ── Not deployed guard ─────────────────────────────────────────
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

      {/* Pending ETH pull */}
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

      <ClaimablesPanel
        claimables={claimables}
        gauges={gauges}
        prevEpoch={prevEpoch}
        onClaim={handleClaim}
        isBusy={isBusy}
      />

      {gaugesLoading && gauges.length === 0 ? (
        <div className="rounded-xl p-5 text-center" style={{ background: 'rgba(13,21,48,0.7)', border: `1px solid ${CARD_BORDER}` }}>
          <p className="text-white/60 text-[13px]">Loading gauges…</p>
        </div>
      ) : (
        <GaugeLeaderboard
          rows={pairSummaries}
          gauges={gauges}
          selectedPair={selectedPair}
          onSelect={setSelectedPair}
          whitelistMap={whitelistMap}
        />
      )}

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

      {/* Advance epoch — permissionless keeper action */}
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

      {/* Contract link */}
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
