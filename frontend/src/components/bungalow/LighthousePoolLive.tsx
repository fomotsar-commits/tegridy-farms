// Polyfill MUST load before any @solana/* import — same rule as SolanaProviders.
import '../../lib/solanaPolyfill';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import type { SignerWalletAdapter } from '@solana/wallet-adapter-base';
import { SolanaProviders } from '../solana/SolanaProviders';
import type { Bungalow } from '../../lib/bungalows';
import {
  readPool,
  readEntries,
  readWalletBalance,
  stake,
  unstakeAndClaim,
  claimRewards,
  lockPresets,
  defaultLockDays,
  labelForDays,
  stakeWeight,
  isFlatWeight,
  configuredAnnualRate,
  rateIsPercent,
  vaultRunwaySecs,
  unlockTs,
  type PoolView,
  type RewardPoolView,
  type StakeEntryView,
} from '../../lib/bungalowStaking';

/**
 * The lighthouse pool, LIVE — rendered by BungalowFarmPanel when the
 * bungalow has a configured Streamflow stake-pool address.
 *
 * SHAPE: this is the Solana twin of the venue's own TOWELI StakingCard —
 * amount field with a real balance + MAX, lock duration as a radiogroup of
 * preset buttons (not a bare number spinner), the rate each lock earns
 * printed ON the button, a projected-earnings strip, and a positions list
 * that knows when a lock actually opens.
 *
 * FUNDING-LAST honesty contract, unchanged and load-bearing:
 *  - the reward vault balance is the headline number, straight off-chain;
 *  - the rate is shown TWICE and the two are never conflated: "paying now"
 *    (0% while the vault is empty — a real, labeled zero) and "configured"
 *    (what the program is set to pay, labeled as configuration);
 *  - every projection is stamped with the same caveat and reads 0 while the
 *    vault is dry;
 *  - a failed read is an OUTAGE state, never rendered as zero;
 *  - when the pool grants no duration bonus (BAYLA's does not: minWeight ==
 *    maxWeight == 1.00x) the panel SAYS SO, instead of implying that a
 *    longer lock buys a better rate.
 *
 * All writes are the SDK's own grouped flows (stake+entries, unstake+claim)
 * through the connected wallet; every action reports its tx signature or
 * its honest failure inline.
 */
export function LighthousePoolLive({ bungalow }: { bungalow: Bungalow & { stakePool: string } }) {
  return (
    <SolanaProviders>
      <Inner bungalow={bungalow} />
    </SolanaProviders>
  );
}

const DAY = 86_400;

function fmt(raw: bigint | null, decimals: number, maxFrac = 2): string {
  if (raw === null) return '–';
  const neg = raw < 0n;
  const s = (neg ? -raw : raw).toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, -decimals) || '0';
  const frac = decimals > 0 ? s.slice(-decimals).replace(/0+$/, '') : '';
  const wholeNum = Number(whole);
  const wholeFmt = Number.isSafeInteger(wholeNum) ? wholeNum.toLocaleString() : whole;
  const out = frac ? `${wholeFmt}.${frac.slice(0, maxFrac)}` : wholeFmt;
  return neg ? `-${out}` : out;
}

function toRaw(human: string, decimals: number): bigint | null {
  const t = human.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const [w, f = ''] = t.split('.');
  const frac = (f + '0'.repeat(decimals)).slice(0, decimals);
  try { return BigInt(w + frac); } catch { return null; }
}

/** Raw base units → a plain number, for projections only (never for a write). */
function toNum(raw: bigint, decimals: number): number {
  return Number(raw) / 10 ** decimals;
}

function pct(rate: number): string {
  const p = rate * 100;
  if (p === 0) return '0%';
  if (p < 0.01) return '<0.01%';
  return `${p.toLocaleString(undefined, { maximumFractionDigits: p < 10 ? 2 : 1 })}%`;
}

function humanDuration(secs: number): string {
  if (secs <= 0) return 'now';
  const d = Math.floor(secs / DAY);
  if (d >= 1) return `${d}d`;
  const h = Math.floor(secs / 3600);
  if (h >= 1) return `${h}h`;
  return `${Math.max(1, Math.floor(secs / 60))}m`;
}

function Inner({ bungalow }: { bungalow: Bungalow & { stakePool: string } }) {
  const { publicKey, wallet } = useWallet();
  const { setVisible } = useWalletModal();

  const [poolRead, setPoolRead] = useState<{ ok: true; pool: PoolView } | { ok: false; reason: string } | null>(null);
  // Entries + balance keyed by wallet: a disconnect/switch is handled by
  // DERIVING the visible values from the key match (never a synchronous
  // setState in an effect — react-hooks/set-state-in-effect).
  const [entriesRead, setEntriesRead] = useState<{ key: string; list: StakeEntryView[] }>({ key: '', list: [] });
  const [balanceRead, setBalanceRead] = useState<{ key: string; raw: bigint | null }>({ key: '', raw: null });
  const [amount, setAmount] = useState('');
  const [days, setDays] = useState<number | null>(null);
  const [customDays, setCustomDays] = useState('');
  const [action, setAction] = useState<{ busy?: string; note?: string; tx?: string } | null>(null);
  // One tick a minute keeps every "unlocks in 12d" countdown honest without a
  // render loop — same cadence the TOWELI staking card uses.
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 60_000);
    return () => clearInterval(t);
  }, []);

  const walletKey = publicKey?.toBase58() ?? '';
  const poolMint = poolRead?.ok ? poolRead.pool.mint : '';

  const refresh = useCallback(() => {
    let cancelled = false;
    readPool(bungalow.stakePool).then((r) => { if (!cancelled) setPoolRead(r); });
    if (walletKey) {
      readEntries(bungalow.stakePool, walletKey).then((r) => {
        if (!cancelled && r.ok) setEntriesRead({ key: walletKey, list: r.entries });
      });
    }
    return () => { cancelled = true; };
  }, [bungalow.stakePool, walletKey]);

  useEffect(() => refresh(), [refresh]);

  // Wallet balance needs the pool's mint, so it rides its own effect that runs
  // once both are known.
  useEffect(() => {
    if (!walletKey || !poolMint) return;
    let cancelled = false;
    readWalletBalance(poolMint, walletKey).then((r) => {
      if (!cancelled) setBalanceRead({ key: walletKey, raw: r.ok ? r.raw : null });
    });
    return () => { cancelled = true; };
  }, [walletKey, poolMint, action?.tx]);

  const entries = walletKey && entriesRead.key === walletKey ? entriesRead.list : [];
  const walletRaw = walletKey && balanceRead.key === walletKey ? balanceRead.raw : null;

  const pool = poolRead?.ok ? poolRead.pool : null;
  const decimals = pool?.decimals ?? 6;
  const funded: bigint | null = pool
    ? pool.rewardPools.reduce<bigint | null>((acc, rp) => (acc === null || rp.fundedRaw === null ? null : acc + rp.fundedRaw), 0n)
    : null;
  const minDays = pool ? Math.max(1, Math.ceil(pool.minDurationSecs / DAY)) : 1;
  const maxDays = pool ? Math.max(minDays, Math.floor(pool.maxDurationSecs / DAY)) : minDays;
  const presets = useMemo(() => (pool ? lockPresets(pool) : []), [pool]);
  // SAFE DEFAULT (2026-08-29): the SHORTEST lock the pool allows, never a
  // pre-selected 30 days — see defaultLockDays() for why this is a safety
  // invariant rather than a preference.
  const defaultDays = defaultLockDays(presets, minDays);
  const chosenDays = Math.min(maxDays, Math.max(minDays, days ?? defaultDays));
  const chosenSecs = chosenDays * DAY;
  const amountRaw = toRaw(amount, decimals);
  const invoker = wallet?.adapter as SignerWalletAdapter | undefined;
  const openEntries = entries.filter((e) => e.closedTs === 0);

  // The reward pool the headline rate speaks for. Multi-reward pools are legal;
  // the venue has never run one, so the strip names the first and the per-entry
  // list still itemises every pool it finds.
  const primaryRp: RewardPoolView | null = pool?.rewardPools[0] ?? null;
  const ratePercent = pool && primaryRp ? rateIsPercent(pool, primaryRp) : false;
  const configuredRate = pool && primaryRp ? configuredAnnualRate(pool, primaryRp, chosenSecs) : 0;
  // "Paying now" is the honest half: a configured rate the vault cannot back
  // pays nothing, and this venue says the zero out loud rather than printing
  // the configuration and hoping nobody checks the vault.
  const payingNow = funded !== null && funded > 0n ? configuredRate : 0;
  const flatWeight = pool ? isFlatWeight(pool) : true;
  const runwaySecs = pool && primaryRp ? vaultRunwaySecs(pool, primaryRp) : null;

  const stakedTotal = openEntries.reduce((a, e) => a + e.amountRaw, 0n);
  const pendingTotal = openEntries.reduce<bigint | null>((acc, e) => {
    if (acc === null) return null;
    const vals = Object.values(e.pendingRaw);
    if (vals.length === 0) return acc;
    if (vals.some((v) => v === null)) return null;
    return acc + vals.reduce<bigint>((s, v) => s + (v as bigint), 0n);
  }, 0n);

  const overBalance = amountRaw !== null && walletRaw !== null && amountRaw > walletRaw;

  const run = async (label: string, fn: () => Promise<{ ok: true; txId: string } | { ok: false; reason: string }>) => {
    setAction({ busy: label });
    const res = await fn();
    if (res.ok) {
      setAction({ note: `${label} confirmed.`, tx: res.txId });
      setAmount('');
      refresh();
    } else {
      setAction({ note: res.reason });
    }
  };

  const setLockDays = (d: number) => {
    setDays(d);
    setCustomDays('');
  };

  return (
    <div className="relative overflow-hidden rounded-2xl glass-card-animated" style={{ border: '1px solid var(--color-purple-75)' }}>
      <div className="absolute inset-0" style={{ background: 'rgba(4,9,18,0.85)' }} />
      <div className="relative z-10 p-6">
        <p className="text-[10px] uppercase tracking-wider mb-3" style={{ color: 'var(--color-kyle)' }}>The lighthouse pool · LIVE</p>

        {poolRead === null && <p className="text-white/70 text-[13px]">Reading the pool…</p>}

        {poolRead && !poolRead.ok && (
          <p className="text-[13px]" style={{ color: '#f0b26b' }}>{poolRead.reason}</p>
        )}

        {pool && (
          <>
            {/* ── The four numbers that decide whether to stake ───────────── */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
              <Stat label="Reward vault" value={fmt(funded, decimals)} unit={bungalow.symbol} />
              <Stat label="Total staked" value={fmt(pool.totalStakeRaw, decimals)} unit={bungalow.symbol} />
              <Stat
                label="Paying now"
                value={ratePercent ? pct(payingNow) : payingNow.toLocaleString(undefined, { maximumFractionDigits: 4 })}
                unit={ratePercent ? 'APR' : `per ${bungalow.symbol}/yr`}
                tone={payingNow > 0 ? 'good' : 'muted'}
              />
              <Stat
                label="Configured"
                value={ratePercent ? pct(configuredRate) : configuredRate.toLocaleString(undefined, { maximumFractionDigits: 4 })}
                unit={ratePercent ? 'APR' : `per ${bungalow.symbol}/yr`}
              />
            </div>

            {funded === 0n && (
              <p className="text-[12px] mb-4 rounded-lg px-3 py-2" style={{ background: 'rgba(227,179,65,0.1)', border: '1px solid rgba(227,179,65,0.4)', color: '#e3b341' }}>
                <strong>Paying now is 0% because the reward vault is empty.</strong>{' '}
                {ratePercent ? `The pool is configured to pay ${pct(configuredRate)} a year` : 'The pool has a configured rate'},
                but a rate only pays out of a funded vault. Deposits are open and your
                principal is yours to take back at unlock — that is a fact about the pool,
                not a promise about yield.
              </p>
            )}
            {funded === null && (
              <p className="text-[12px] mb-4" style={{ color: '#f0b26b' }}>
                The reward vault could not be read — outage, not a zero.
              </p>
            )}
            {funded !== null && funded > 0n && runwaySecs !== null && (
              <p className="text-[12px] mb-4" style={{ color: '#e3b341' }}>
                At today&rsquo;s stake and today&rsquo;s rate this vault funds about{' '}
                <strong>{humanDuration(runwaySecs)}</strong> of rewards. Anything past that assumes a top-up.
              </p>
            )}

            {/* ── Stake ──────────────────────────────────────────────────── */}
            <div className="rounded-xl p-4 mb-4" style={{ background: 'rgba(0,0,0,0.5)', border: '1px solid var(--color-purple-25)' }}>
              <p className="text-[10px] uppercase tracking-wider mb-3" style={{ color: 'var(--color-kyle)' }}>Stake {bungalow.symbol}</p>
              {/* Amount + balance/MAX, the venue's own staking-card idiom. Only a
                  connected wallet has a balance to spend, so this half waits —
                  but the lock table below does NOT, because what each lock earns
                  is a fact about the pool, not about the visitor. */}
              {publicKey && (
                  <div className="mb-4">
                    <div className="flex items-center justify-between mb-1.5">
                      <label htmlFor="lh-amount" className="text-white text-[11px] uppercase tracking-wider label-pill">Amount</label>
                      <button
                        type="button"
                        disabled={walletRaw === null || walletRaw === 0n}
                        onClick={() => walletRaw !== null && setAmount(fmt(walletRaw, decimals, decimals).replace(/,/g, ''))}
                        className="text-white/60 text-[11px] hover:text-white transition-colors cursor-pointer disabled:cursor-default disabled:hover:text-white/60"
                      >
                        Balance: {walletRaw === null ? '–' : fmt(walletRaw, decimals)}{walletRaw !== null && walletRaw > 0n ? ' · MAX' : ''}
                      </button>
                    </div>
                    <input
                      id="lh-amount"
                      type="text"
                      inputMode="decimal"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      placeholder="0.0"
                      spellCheck={false}
                      aria-label={`Amount of ${bungalow.symbol} to stake`}
                      className="w-full rounded-lg p-3.5 min-h-[44px] font-mono text-xl text-white placeholder:text-white/40 outline-none focus-visible:ring-2 focus-visible:ring-[#4CAF50]"
                      style={{ background: 'var(--color-purple-75)', border: '1px solid var(--color-purple-75)' }}
                    />
                    {overBalance && (
                      <p className="text-[11px] mt-1.5" style={{ color: '#f0b26b' }}>
                        That is more {bungalow.symbol} than this wallet holds.
                      </p>
                    )}
                  </div>
              )}

                  {/* Lock duration — buttons, each carrying the rate it earns. */}
                  <div className="mb-4">
                    <label id="lh-lock-label" className="text-white text-[11px] uppercase tracking-wider label-pill mb-2 block">Lock duration</label>
                    <div role="radiogroup" aria-labelledby="lh-lock-label" className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                      {presets.map((opt) => {
                        const selected = chosenDays === opt.days && customDays === '';
                        const optRate = primaryRp ? configuredAnnualRate(pool, primaryRp, opt.seconds) : 0;
                        return (
                          <button
                            key={opt.days}
                            type="button"
                            role="radio"
                            aria-checked={selected}
                            onClick={() => setLockDays(opt.days)}
                            className="rounded-lg px-2.5 py-2 min-h-[44px] text-center cursor-pointer transition-all"
                            style={{
                              background: selected ? 'var(--color-purple-75)' : 'rgba(0,0,0,0.55)',
                              border: selected ? '1px solid var(--color-purple-30)' : '1px solid rgba(255,255,255,0.25)',
                              color: selected ? '#000000' : 'rgba(255,255,255,1)',
                            }}
                          >
                            <span className="block text-[12px] leading-tight">
                              {selected && <span aria-hidden="true" className="mr-1">&#10003;</span>}
                              {opt.label}
                            </span>
                            <span className="block text-[11px] leading-tight opacity-80 font-mono">
                              {ratePercent ? pct(optRate) : optRate.toLocaleString(undefined, { maximumFractionDigits: 3 })}
                            </span>
                          </button>
                        );
                      })}
                    </div>

                    {/* Any duration in the window is legal — the presets are a
                        convenience, not the whole range. */}
                    <div className="flex items-center gap-2 mt-2">
                      <label htmlFor="lh-days" className="text-white/55 text-[11px]">or exactly</label>
                      <input
                        id="lh-days"
                        type="number"
                        min={minDays}
                        max={maxDays}
                        value={customDays}
                        placeholder={String(chosenDays)}
                        onChange={(e) => {
                          const v = e.target.value;
                          setCustomDays(v);
                          const n = Number(v);
                          if (Number.isFinite(n) && v !== '') setDays(Math.max(minDays, Math.min(maxDays, Math.floor(n))));
                        }}
                        className="w-20 rounded-lg px-2.5 py-1.5 text-[13px] font-mono text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[#4CAF50]"
                        style={{ background: 'rgba(0,0,0,0.6)', border: '1px solid var(--color-purple-25)' }}
                      />
                      <span className="text-white/55 text-[11px]">days ({minDays}–{maxDays})</span>
                    </div>

                    {funded === 0n && (
                      <p className="text-[11px] mt-2" style={{ color: '#e3b341' }}>
                        Every rate on those buttons is the pool&rsquo;s <strong>configured</strong> rate.
                        With the vault at zero, all six of them pay 0 today.
                      </p>
                    )}

                    <p className="text-white/45 text-[11px] mt-2 leading-relaxed">
                      {flatWeight ? (
                        <>
                          This pool weights every lock the same (1.00&times;), so a longer lock does
                          <strong className="text-white/70"> not</strong> raise the rate — it only sets
                          when you can take your {bungalow.symbol} back.
                        </>
                      ) : (
                        <>
                          Longer locks carry more weight: {stakeWeight(pool, chosenSecs).toFixed(2)}&times; at{' '}
                          {labelForDays(chosenDays).toLowerCase()}, up to{' '}
                          {stakeWeight(pool, pool.maxDurationSecs).toFixed(2)}&times; at{' '}
                          {labelForDays(maxDays).toLowerCase()}.
                        </>
                      )}
                    </p>
                  </div>

                  {/* Projections — the TOWELI card's strip, with the vault caveat
                      welded on. Renders even at zero, because "0" IS the answer
                      today and hiding it would be the softer lie. */}
                  {amountRaw !== null && amountRaw > 0n && primaryRp && (
                    <div className="rounded-lg p-4 mb-4" style={{ background: 'rgba(16,185,129,0.06)', border: '1px solid rgba(16,185,129,0.15)' }}>
                      <p className="text-emerald-400 text-[11px] font-semibold mb-2 uppercase tracking-wider">
                        {funded === 0n ? 'What it would earn once funded' : 'Projected rewards'}
                      </p>
                      <div className="grid grid-cols-3 gap-3">
                        {[
                          { label: '30 Days', days: 30 },
                          { label: '90 Days', days: 90 },
                          { label: '1 Year', days: 365 },
                        ].map(({ label, days: d }) => {
                          const held = Math.min(d, chosenDays);
                          const projected = toNum(amountRaw, decimals) * configuredRate * (d / 365);
                          return (
                            <div key={label} className="text-center">
                              <p className="text-white/40 text-[9px] uppercase mb-0.5">{label}</p>
                              <p className="stat-value text-white text-[13px]">
                                {funded === 0n ? '0' : projected < 0.01 ? '<0.01' : projected.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                              </p>
                              <p className="text-white/30 text-[9px]">
                                {bungalow.symbol}{held < d ? ` · ${held}d locked` : ''}
                              </p>
                            </div>
                          );
                        })}
                      </div>
                      <p className="text-white/35 text-[9px] mt-2 text-center leading-relaxed">
                        {funded === 0n ? (
                          <>
                            Zero, because the vault is empty. At the configured{' '}
                            {ratePercent ? pct(configuredRate) : `${configuredRate.toFixed(3)} per ${bungalow.symbol}`} a
                            year it would be{' '}
                            {(toNum(amountRaw, decimals) * configuredRate).toLocaleString(undefined, { maximumFractionDigits: 2 })}{' '}
                            {bungalow.symbol} over a year — once someone funds it.
                          </>
                        ) : (
                          <>
                            At the configured {ratePercent ? pct(configuredRate) : 'rate'}. Rewards stop the moment
                            the vault empties; nothing here assumes a top-up.
                          </>
                        )}
                      </p>
                    </div>
                  )}

                  {!publicKey ? (
                    <>
                      <p className="text-white/80 text-[13px] mb-3 max-w-md leading-relaxed">
                        Connect a Solana wallet to stake. Locks run{' '}
                        {labelForDays(minDays).toLowerCase()} to {labelForDays(maxDays).toLowerCase()};
                        your principal comes back to you when the lock opens.
                      </p>
                      <button type="button" onClick={() => setVisible(true)} className="btn-primary px-6 py-2.5 text-[13px]">
                        Connect Solana Wallet
                      </button>
                    </>
                  ) : (
                  <>
                  <button
                    type="button"
                    disabled={!amountRaw || amountRaw === 0n || overBalance || !invoker || !!action?.busy}
                    onClick={() => invoker && amountRaw && void run('Stake', () => stake({
                      invoker, pool, amountRaw, durationSecs: chosenSecs, entries,
                    }))}
                    className="btn-primary w-full py-3 text-[14px] disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {action?.busy === 'Stake' ? 'Confirm in wallet…'
                      : !amountRaw || amountRaw === 0n ? 'Enter an amount'
                      : overBalance ? `Not enough ${bungalow.symbol}`
                      : `Stake & lock for ${labelForDays(chosenDays)}`}
                  </button>
                  <p className="text-white/45 text-[11px] text-center mt-2">
                    Unlocks {new Date((nowSec + chosenSecs) * 1000).toLocaleDateString()} · no early exit and no
                    penalty path — the program simply refuses an unstake until then
                    {pool.unstakePeriodSecs > 0 ? `, then a ${humanDuration(pool.unstakePeriodSecs)} cool-down applies` : ''}.
                  </p>
                  </>
                  )}
            </div>

            {/* ── Your position ──────────────────────────────────────────── */}
            {publicKey && openEntries.length > 0 && (
              <div className="rounded-xl p-4" style={{ background: 'rgba(0,0,0,0.5)', border: '1px solid var(--color-purple-25)' }}>
                <div className="flex flex-wrap items-baseline justify-between gap-3 mb-3">
                  <p className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--color-kyle)' }}>Your stakes</p>
                  <p className="text-white/70 text-[12px]">
                    <span className="stat-value text-white text-[14px]">{fmt(stakedTotal, decimals)}</span> {bungalow.symbol} staked
                    {' · '}
                    <span className="stat-value text-white text-[14px]">{fmt(pendingTotal, decimals)}</span> accrued
                  </p>
                </div>
                <ul className="space-y-2">
                  {openEntries.map((e) => {
                    const opensAt = unlockTs(e);
                    const locked = nowSec < opensAt;
                    const entryPending = pool.rewardPools.reduce<bigint | null>((acc, rp) => {
                      if (acc === null) return null;
                      const v = e.pendingRaw[rp.nonce];
                      return v === undefined ? acc : v === null ? null : acc + v;
                    }, 0n);
                    return (
                      <li key={e.address || e.nonce} className="rounded-lg p-3" style={{ background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(255,255,255,0.08)' }}>
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-white/90 mb-2">
                          <span className="stat-value text-white text-[15px]">{fmt(e.amountRaw, decimals)} {bungalow.symbol}</span>
                          <span className="text-white/50">{labelForDays(Math.round(e.durationSecs / DAY))} lock</span>
                          {!flatWeight && (
                            <span className="text-white/50">{stakeWeight(pool, e.durationSecs).toFixed(2)}&times; weight</span>
                          )}
                          <span className={locked ? 'text-white/50' : 'text-emerald-400'}>
                            {locked
                              ? `unlocks in ${humanDuration(opensAt - nowSec)} (${new Date(opensAt * 1000).toLocaleDateString()})`
                              : 'unlocked'}
                          </span>
                          <span className="text-white/70">
                            accrued <span className="font-mono">{fmt(entryPending, decimals)}</span> {bungalow.symbol}
                          </span>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          {pool.rewardPools.map((rp) => (
                            <button
                              key={rp.address || rp.nonce}
                              type="button"
                              disabled={!invoker || !!action?.busy}
                              onClick={() => invoker && void run('Claim', () => claimRewards({ invoker, pool, rewardPool: rp, entryNonce: e.nonce }))}
                              className="btn-secondary px-3 py-1.5 text-[12px] disabled:opacity-50"
                            >
                              Claim rewards
                            </button>
                          ))}
                          <button
                            type="button"
                            disabled={!invoker || !!action?.busy || locked}
                            title={locked ? 'The program refuses an unstake before the lock opens' : undefined}
                            onClick={() => invoker && void run('Unstake', () => unstakeAndClaim({ invoker, pool, entryNonce: e.nonce }))}
                            className="btn-secondary px-3 py-1.5 text-[12px] disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            {locked ? `Locked · ${humanDuration(opensAt - nowSec)}` : 'Unstake & claim'}
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
                {funded === 0n && (
                  <p className="text-white/45 text-[11px] mt-3">
                    Accrual keeps counting while the vault is empty, but a claim can only pay
                    out what the vault actually holds.
                  </p>
                )}
              </div>
            )}

            {action?.busy && <p className="text-white/70 text-[12px] mt-3">{action.busy} — waiting for the wallet…</p>}
            {action?.note && (
              <p className="text-[12px] mt-3 text-white/85">
                {action.note}{' '}
                {action.tx && (
                  <a href={`https://solscan.io/tx/${action.tx}`} target="_blank" rel="noopener noreferrer"
                    aria-label="View transaction on Solscan (opens in new tab)"
                    className="underline underline-offset-2 text-white/70 hover:text-white">
                    view tx ↗
                  </a>
                )}
              </p>
            )}

            <p className="text-white/45 text-[11px] mt-4 leading-relaxed">
              Pool{' '}
              <a href={`https://solscan.io/account/${pool.address}`} target="_blank" rel="noopener noreferrer"
                aria-label="View stake pool on Solscan (opens in new tab)"
                className="underline underline-offset-2 hover:text-white/80 font-mono">
                {pool.address.slice(0, 4)}…{pool.address.slice(-4)} ↗
              </a>{' '}
              · a Streamflow staking pool — audited program, non-custodial, verifiable on-chain.
              {primaryRp && (
                <>
                  {' '}Reward vault{' '}
                  <a href={`https://solscan.io/account/${primaryRp.vault}`} target="_blank" rel="noopener noreferrer"
                    aria-label="View reward vault on Solscan (opens in new tab)"
                    className="underline underline-offset-2 hover:text-white/80 font-mono">
                    {primaryRp.vault.slice(0, 4)}…{primaryRp.vault.slice(-4)} ↗
                  </a>
                  {primaryRp.permissionless ? ' — funding is permissionless: anyone can top it up, and the balance above is the proof.' : ' — only the pool authority can fund it.'}
                </>
              )}
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, unit, tone }: { label: string; value: string; unit?: string; tone?: 'good' | 'muted' }) {
  const color = tone === 'good' ? '#4ade80' : tone === 'muted' ? 'rgba(255,255,255,0.85)' : '#ffffff';
  return (
    <div className="rounded-lg px-3 py-2" style={{ background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(255,255,255,0.08)' }}>
      <p className="text-[10px] uppercase tracking-wider text-white/60">{label}</p>
      <p className="stat-value text-xl leading-tight" style={{ color }}>{value}</p>
      {unit && <p className="text-[10px] text-white/50">{unit}</p>}
    </div>
  );
}
