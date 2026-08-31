// Polyfill MUST load before any @solana/* import — same rule as SolanaProviders.
import '../../lib/solanaPolyfill';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import type { SignerWalletAdapter } from '@solana/wallet-adapter-base';
import { SolanaProviders } from '../solana/SolanaProviders';
import type { Bungalow } from '../../lib/bungalows';
import {
  vaultIsMateriallyEmpty,
  payingNowRate,
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
 *  - when a pool grants no duration bonus (minWeight == maxWeight — true of
 *    the RETIRED first BAYLA pool; the live 5x-ladder pool is NOT this case)
 *    the panel SAYS SO, instead of implying a boost curve that does not
 *    exist — and conversely shows the real ladder when one is configured.
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
  // list:null = not loaded or FAILED — an outage, never "no stakes": rendering
  // a failed read as an empty list makes locked funds look gone and lets a
  // new stake collide with an unseen open nonce.
  const [entriesRead, setEntriesRead] = useState<{ key: string; list: StakeEntryView[] | null; reason: string | null }>({ key: '', list: null, reason: null });
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
        if (cancelled) return;
        if (r.ok) setEntriesRead({ key: walletKey, list: r.entries, reason: null });
        else setEntriesRead({ key: walletKey, list: null, reason: r.reason });
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

  const entriesForWallet = walletKey && entriesRead.key === walletKey ? entriesRead : null;
  const entriesKnown = entriesForWallet?.list !== null && entriesForWallet !== null;
  const entries = entriesForWallet?.list ?? [];
  const walletRaw = walletKey && balanceRead.key === walletKey ? balanceRead.raw : null;

  const pool = poolRead?.ok ? poolRead.pool : null;
  const decimals = pool?.decimals ?? bungalow.decimals ?? 6;
  // Vault headline: ONLY reward pools paying the STAKE mint sum into the
  // "{symbol}" figure — a foreign-mint reward pool has different decimals,
  // and adding its raw units would fabricate the number. Zero same-mint
  // pools reads as null (outage), never as a real zero.
  const sameMintPools = pool ? pool.rewardPools.filter((rp) => rp.mint === pool.mint) : [];
  const funded: bigint | null = pool && sameMintPools.length > 0
    ? sameMintPools.reduce<bigint | null>((acc, rp) => (acc === null || rp.fundedRaw === null ? null : acc + rp.fundedRaw), 0n)
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
  const primaryRp: RewardPoolView | null = sameMintPools[0] ?? pool?.rewardPools[0] ?? null;
  // EXIT SAFETY (devnet-proven 2026-08-28, error 6012, same program ids as
  // mainnet): while accrued rewards exceed the vault, claim AND unstake&claim
  // REVERT — principal is locked until the vault is topped up past accrual
  // (the backlog itself survives). So new stakes PAUSE while the vault is
  // materially empty: an open deposit form here would invite a lock nothing
  // can open until someone funds the vault.
  const vaultDry = pool && primaryRp ? vaultIsMateriallyEmpty(pool, primaryRp) : false;
  const stakeBlocked = !entriesKnown || funded === null || vaultDry;
  const ratePercent = pool && primaryRp ? rateIsPercent(pool, primaryRp) : false;
  const configuredRate = pool && primaryRp ? configuredAnnualRate(pool, primaryRp, chosenSecs) : 0;
  // A weighted pool has no single "configured rate" — it has a RANGE, and the
  // headline must say so. Keying the top-line stat off the selected lock made
  // it read 21.9% by default on a pool that reaches 109.5%, which undersells
  // the ladder to anyone who never touches the picker. The per-lock number
  // still lives on the buttons, where the choice is actually made.
  const weighted = pool ? !isFlatWeight(pool) : false;
  const rateAtMin = pool && primaryRp ? configuredAnnualRate(pool, primaryRp, pool.minDurationSecs) : 0;
  const rateAtMax = pool && primaryRp ? configuredAnnualRate(pool, primaryRp, pool.maxDurationSecs) : 0;
  const maxBoost = pool ? stakeWeight(pool, pool.maxDurationSecs) : 1;
  // "Paying now" is the honest half: a configured rate the vault cannot back
  // pays nothing, and this venue says the zero out loud rather than printing
  // the configuration and hoping nobody checks the vault.
  // ONE predicate for "is this vault actually paying", used by the stat, the
  // banner, the stake gate and the projections alike. The old `funded > 0n`
  // disagreed with `vaultDry` in exactly the two states vaultIsMateriallyEmpty
  // exists for — dust (< 1 whole token) and under a day of runway — so a pool
  // holding dust printed the full configured APR in green DIRECTLY ABOVE a
  // banner reading "Paying now is 0%". (vaultDry is false when the vault is
  // unreadable, so this keeps an outage out of the zero branch.)
  const payingNow = payingNowRate(configuredRate, funded, vaultDry);
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
            <div className={`grid grid-cols-2 sm:grid-cols-3 ${weighted ? 'lg:grid-cols-5' : 'lg:grid-cols-4'} gap-3 mb-4`}>
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
                value={
                  !ratePercent
                    ? configuredRate.toLocaleString(undefined, { maximumFractionDigits: 4 })
                    : weighted
                      ? `${pct(rateAtMin)}–${pct(rateAtMax)}`
                      : pct(configuredRate)
                }
                unit={ratePercent ? 'APR' : `per ${bungalow.symbol}/yr`}
                caption={weighted ? `${labelForDays(minDays)} → ${labelForDays(maxDays)}` : undefined}
              />
              {weighted && (
                <Stat
                  label="Max boost"
                  value={`${maxBoost.toFixed(2)}×`}
                  unit={`at ${labelForDays(maxDays).toLowerCase()}`}
                  caption="longer lock, bigger share"
                />
              )}
            </div>

            {vaultDry && (
              <p className="text-[12px] mb-4 rounded-lg px-3 py-2" style={{ background: 'rgba(227,179,65,0.1)', border: '1px solid rgba(227,179,65,0.4)', color: '#e3b341' }}>
                {/* Lead with the fact that changes what the visitor can DO. The
                    reason used to arrive first and the consequence fourth, which
                    buried "staking is paused" inside a paragraph of rate talk. */}
                <strong>Staking is paused until the reward vault is funded.</strong>{' '}
                The vault is {funded === 0n ? 'empty' : 'effectively empty'}, so paying now is 0% —
                {ratePercent ? ` a configured ${pct(rateAtMax)} tops out at nothing` : ' a configured rate pays nothing'}{' '}
                until someone tops it up.
                <span className="block mt-1.5 opacity-90">
                  Deposits stay closed on purpose: while accrued rewards exceed the vault
                  the program <strong>reverts</strong> claims and unstakes, even after a lock
                  opens — so a deposit here could become principal nothing can release.
                  Accrual itself is never lost; it pays in full after a top-up.
                </span>
              </p>
            )}
            {funded === null && (
              <p className="text-[12px] mb-4" style={{ color: '#f0b26b' }}>
                The reward vault could not be read — outage, not a zero.
              </p>
            )}
            {funded !== null && !vaultDry && runwaySecs !== null && (
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
                            {/* Multiplier alongside the rate, so each button is a
                                row of the boost schedule rather than a bare
                                percentage — the ladder is legible without having
                                to click through every option to compare. Hidden
                                on a flat pool, where every row would read 1.00x. */}
                            <span className="block text-[11px] leading-tight opacity-80 font-mono">
                              {weighted && `${stakeWeight(pool, opt.seconds).toFixed(2)}× · `}
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

                    {vaultDry && (
                      <p className="text-[11px] mt-2" style={{ color: '#e3b341' }}>
                        Every rate on those buttons is the pool&rsquo;s <strong>configured</strong> rate.
                        {funded === 0n
                          ? ' With the vault at zero, all six of them pay 0 today.'
                          : ' The vault cannot back them today, so all six pay 0.'}
                      </p>
                    )}

                    {/* Only the FLAT case needs saying in prose. On a weighted
                        pool the ladder is already on every button (1.32× · 28.9%)
                        and in the Max boost stat, so a sentence repeating it was
                        just one more line to read. */}
                    {flatWeight && (
                      <p className="text-white/45 text-[11px] mt-2 leading-relaxed">
                        This pool weights every lock the same (1.00&times;), so a longer lock does
                        <strong className="text-white/70"> not</strong> raise the rate — it only sets
                        when you can take your {bungalow.symbol} back.
                      </p>
                    )}
                  </div>

                  {/* Projections — the TOWELI card's strip, with the vault caveat
                      welded on. Renders even at zero, because "0" IS the answer
                      today and hiding it would be the softer lie. */}
                  {amountRaw !== null && amountRaw > 0n && primaryRp && (
                    <div className="rounded-lg p-4 mb-4" style={{ background: 'rgba(16,185,129,0.06)', border: '1px solid rgba(16,185,129,0.15)' }}>
                      <p className="text-emerald-400 text-[11px] font-semibold mb-2 uppercase tracking-wider">
                        {vaultDry ? 'What it would earn once funded' : 'Projected rewards'}
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
                                {vaultDry ? '0' : projected < 0.01 ? '<0.01' : projected.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                              </p>
                              <p className="text-white/30 text-[9px]">
                                {bungalow.symbol}{held < d ? ` · ${held}d locked` : ''}
                              </p>
                            </div>
                          );
                        })}
                      </div>
                      <p className="text-white/35 text-[9px] mt-2 text-center leading-relaxed">
                        {vaultDry ? (
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
                      <p className="text-white/80 text-[13px] mb-2 max-w-md leading-relaxed">
                        Connect a Solana wallet to stake. Your principal comes back to you
                        when the lock opens.
                      </p>
                      {/* The no-early-exit fact belongs BEFORE the wallet, not after
                          it: this is the screen where someone decides whether to take
                          part at all. It used to appear only under the stake button,
                          which a disconnected visitor never reaches. */}
                      <p className="text-[12px] mb-3 max-w-md leading-relaxed" style={{ color: '#e3b341' }}>
                        There is no early exit. The program refuses an unstake until the
                        lock you choose opens — not for a fee, not by the venue, not by
                        anyone. Pick a lock you can wait out.
                      </p>
                      <button type="button" onClick={() => setVisible(true)} className="btn-primary px-6 py-2.5 text-[13px]">
                        Connect Solana Wallet
                      </button>
                    </>
                  ) : (
                  <>
                  <button
                    type="button"
                    disabled={!amountRaw || amountRaw === 0n || overBalance || !invoker || !!action?.busy || stakeBlocked}
                    onClick={() => invoker && amountRaw && void run('Stake', () => stake({
                      invoker, pool, amountRaw, durationSecs: chosenSecs, entries,
                    }))}
                    className="btn-primary w-full py-3 text-[14px] disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {action?.busy === 'Stake' ? 'Confirm in wallet…'
                      : vaultDry ? 'Staking paused — vault unfunded'
                      : !entriesKnown ? 'Waiting for your stakes to load…'
                      : funded === null ? 'Vault unreadable — staking paused'
                      : !amountRaw || amountRaw === 0n ? 'Enter an amount'
                      : overBalance ? `Not enough ${bungalow.symbol}`
                      : `Stake & lock for ${labelForDays(chosenDays)}`}
                  </button>
                  {!entriesKnown && entriesForWallet?.reason && (
                    <p className="text-[11px] mt-2" style={{ color: '#f0b26b' }}>
                      {entriesForWallet.reason} Staking waits until your existing stakes are
                      readable — a new stake could otherwise collide with one of them.
                    </p>
                  )}
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
                        {(() => {
                          // 6012-precise gating: the SDK's own calcRewards gives this
                          // entry's accrued amount; when it exceeds the vault, claim AND
                          // the grouped exit are guaranteed to revert (devnet-proven), so
                          // the buttons say so instead of letting the wallet eat it.
                          const exceedsVault =
                            entryPending !== null && funded !== null && entryPending > funded;
                          const nothingPending = entryPending === 0n;
                          return (
                        <div className="flex flex-wrap items-center gap-2">
                          {pool.rewardPools.map((rp) => (
                            <button
                              key={rp.address || rp.nonce}
                              type="button"
                              disabled={!invoker || !!action?.busy || nothingPending || exceedsVault}
                              title={exceedsVault ? 'The vault cannot cover this claim — it reverts until a top-up; nothing is lost.' : nothingPending ? 'Nothing accrued yet.' : undefined}
                              onClick={() => invoker && void run('Claim', () => claimRewards({ invoker, pool, rewardPool: rp, entryNonce: e.nonce }))}
                              className="btn-secondary px-3 py-1.5 text-[12px] disabled:opacity-50"
                            >
                              {exceedsVault ? 'Nothing claimable yet' : 'Claim rewards'}
                            </button>
                          ))}
                          <button
                            type="button"
                            disabled={!invoker || !!action?.busy || locked || exceedsVault}
                            title={locked
                              ? 'The program refuses an unstake before the lock opens'
                              : exceedsVault
                                ? 'The exit pays rewards in the same transaction — it reverts until the vault covers them (nothing is lost).'
                                : undefined}
                            onClick={() => invoker && void run('Unstake', () => unstakeAndClaim({ invoker, pool, entryNonce: e.nonce }))}
                            className="btn-secondary px-3 py-1.5 text-[12px] disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            {locked ? `Locked · ${humanDuration(opensAt - nowSec)}`
                              : exceedsVault ? 'Exit blocked — vault unfunded'
                              : 'Unstake & claim'}
                          </button>
                        </div>
                          );
                        })()}
                      </li>
                    );
                  })}
                </ul>
                {vaultDry && (
                  <p className="text-white/45 text-[11px] mt-3">
                    Accrual keeps counting while the vault is dry, and nothing is lost — but
                    claims and exits <strong>revert</strong> until the vault covers what has
                    accrued (proven against the live program). Both work again the moment it
                    is topped up, and the backlog pays in full.
                  </p>
                )}
              </div>
            )}

            {publicKey && !entriesKnown && entriesForWallet?.reason && (
              <p className="text-[12px] mt-1" style={{ color: '#f0b26b' }}>
                Your stakes could not be read right now — that is an outage, not an empty list.
              </p>
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

function Stat({ label, value, unit, tone, caption }: { label: string; value: string; unit?: string; tone?: 'good' | 'muted'; caption?: string }) {
  const color = tone === 'good' ? '#4ade80' : tone === 'muted' ? 'rgba(255,255,255,0.85)' : '#ffffff';
  return (
    <div className="rounded-lg px-3 py-2" style={{ background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(255,255,255,0.08)' }}>
      <p className="text-[10px] uppercase tracking-wider text-white/60">{label}</p>
      {/* A range like "21.9%–109.5%" is wider than a single figure — let it step
          down a size rather than overflow the card on a narrow column. */}
      <p className={`stat-value leading-tight ${value.length > 9 ? 'text-base' : 'text-xl'}`} style={{ color }}>{value}</p>
      {unit && <p className="text-[10px] text-white/50">{unit}</p>}
      {caption && <p className="text-[10px] text-white/40 leading-tight mt-0.5">{caption}</p>}
    </div>
  );
}
