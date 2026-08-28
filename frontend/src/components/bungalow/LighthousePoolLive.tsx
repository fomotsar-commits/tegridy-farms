// Polyfill MUST load before any @solana/* import — same rule as SolanaProviders.
import '../../lib/solanaPolyfill';
import { useCallback, useEffect, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import type { SignerWalletAdapter } from '@solana/wallet-adapter-base';
import { SolanaProviders } from '../solana/SolanaProviders';
import type { Bungalow } from '../../lib/bungalows';
import {
  readPool,
  readEntries,
  stake,
  unstakeAndClaim,
  claimRewards,
  rewardRatePerTokenPerDay,
  runwayDays,
  vaultIsMateriallyEmpty,
  type PoolView,
  type StakeEntryView,
} from '../../lib/bungalowStaking';

/**
 * The lighthouse pool, LIVE — rendered by BungalowFarmPanel when the
 * bungalow has a configured Streamflow stake-pool address.
 *
 * FUNDING-LAST honesty contract:
 *  - the reward vault balance is the headline number, straight off-chain;
 *  - the pool's configured rate and the vault's RUNWAY at the current stake
 *    render next to it — the vault number alone hid the burn it must pay;
 *  - a failed read is an OUTAGE state, never rendered as zero — for the
 *    vault AND for the visitor's own stake entries;
 *  - no yield is promised anywhere: the rate is labeled as on-chain
 *    configuration, and runway/unlock math is display-only (no house math
 *    ever moves funds — every transfer is the SDK's).
 *
 * EXIT SAFETY (proven on devnet 2026-08-28, same program ids as mainnet):
 * while accrued rewards exceed the vault, claim AND unstake&claim revert
 * with Streamflow error 6012 — principal is LOCKED until the vault is
 * topped up past accrual. The backlog itself survives a dry window (a
 * post-funding claim paid it in full). Consequences here:
 *  - staking is DISABLED while the vault is materially empty (< 1 whole
 *    token, or < 1 day of burn) — an open deposit form would invite an
 *    indefinite principal lock the moment a reward period elapses;
 *  - a dry-vault revert is explained in those terms, not as generic failure.
 */
export function LighthousePoolLive({ bungalow }: { bungalow: Bungalow & { stakePool: string } }) {
  return (
    <SolanaProviders>
      <Inner bungalow={bungalow} />
    </SolanaProviders>
  );
}

function fmt(raw: bigint | null, decimals: number): string {
  if (raw === null) return '–';
  const s = raw.toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, -decimals);
  const frac = s.slice(-decimals).replace(/0+$/, '');
  const wholeFmt = Number(whole) > 1e15 ? whole : Number(whole).toLocaleString();
  return frac ? `${wholeFmt}.${frac.slice(0, 2)}` : wholeFmt;
}

function toRaw(human: string, decimals: number): bigint | null {
  const t = human.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const [w, f = ''] = t.split('.');
  const frac = (f + '0'.repeat(decimals)).slice(0, decimals);
  try { return BigInt(w + frac); } catch { return null; }
}

function fmtRunway(days: number | null): string {
  if (days === null) return '–';
  if (!Number.isFinite(days)) return 'no burn yet (nothing staked)';
  if (days >= 1000) return '1000+ days';
  return `${days.toLocaleString(undefined, { maximumFractionDigits: 1 })} days`;
}

const DAY = 86_400;
const FLAT_WEIGHT = '1000000000'; // 1e9-scaled 1x — lock length adds no boost

type EntriesRead = { key: string; list: StakeEntryView[] | null; reason: string | null };

function Inner({ bungalow }: { bungalow: Bungalow & { stakePool: string } }) {
  const { publicKey, wallet } = useWallet();
  const { setVisible } = useWalletModal();
  // Decimals come from the registry (BAYLA: 6, verified against the mint);
  // this component is bungalow-generic and must never assume one token's.
  const decimals = bungalow.decimals ?? 6;

  const [poolRead, setPoolRead] = useState<{ ok: true; pool: PoolView } | { ok: false; reason: string } | null>(null);
  // Entries keyed by wallet: a disconnect/switch is handled by DERIVING the
  // visible list from the key match (never a synchronous setState in an
  // effect — react-hooks/set-state-in-effect). list:null = not loaded or
  // failed — an outage, NOT "no stakes": rendering a failed read as an empty
  // list made locked funds look gone and armed the Stake button with a
  // colliding nonce 0.
  const [entriesRead, setEntriesRead] = useState<EntriesRead>({ key: '', list: null, reason: null });
  const [amount, setAmount] = useState('');
  const [days, setDays] = useState<number | null>(null);
  const [action, setAction] = useState<{ busy?: string; note?: string; tx?: string } | null>(null);

  // Wall clock for unlock labels — lazy state so render stays pure; fixed
  // per mount, which is exact enough for day-granularity locks.
  const [nowSecs] = useState(() => Math.floor(Date.now() / 1000));

  const walletKey = publicKey?.toBase58() ?? '';
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

  const entriesForWallet = walletKey && entriesRead.key === walletKey ? entriesRead : null;
  const entries = entriesForWallet?.list ?? null;
  const entriesKnown = entries !== null;
  const openEntries = (entries ?? []).filter((e) => e.closedTs === 0);

  const pool = poolRead?.ok ? poolRead.pool : null;
  // Vault headline: ONLY reward pools paying the stake mint sum into the
  // "{symbol}" figure — a foreign-mint reward pool has different decimals
  // and adding its raw units would fabricate the number. Zero readable
  // pools is an outage (null), never a real zero.
  const sameMintPools = pool ? pool.rewardPools.filter((rp) => rp.mint === pool.mint) : [];
  const funded: bigint | null = pool && sameMintPools.length > 0
    ? sameMintPools.reduce<bigint | null>((acc, rp) => (acc === null || rp.fundedRaw === null ? null : acc + rp.fundedRaw), 0n)
    : null;
  const primaryReward = sameMintPools[0] ?? null;
  const ratePerDay = primaryReward ? rewardRatePerTokenPerDay(primaryReward) : null;
  const runway = pool && primaryReward ? runwayDays(funded, pool.totalStakeRaw, primaryReward) : null;
  const vaultDry = pool && primaryReward
    ? vaultIsMateriallyEmpty(funded, pool.totalStakeRaw, primaryReward, decimals)
    : false;
  const flatWeight = pool?.maxWeightRaw === FLAT_WEIGHT;

  const minDays = pool ? Math.max(1, Math.ceil(pool.minDurationSecs / DAY)) : 1;
  const maxDays = pool ? Math.max(minDays, Math.floor(pool.maxDurationSecs / DAY)) : minDays;
  const chosenDays = days ?? minDays;
  const amountRaw = toRaw(amount, decimals);
  const invoker = wallet?.adapter as SignerWalletAdapter | undefined;

  const stakeBlocked = !entriesKnown || vaultDry || funded === null;

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

  return (
    <div className="relative overflow-hidden rounded-2xl glass-card-animated" style={{ border: '1px solid var(--color-purple-75)' }}>
      <div className="absolute inset-0" style={{ background: 'rgba(4,9,18,0.85)' }} />
      <div className="relative z-10 p-6">
        <p className="text-[10px] uppercase tracking-wider mb-2" style={{ color: 'var(--color-kyle)' }}>The lighthouse pool · LIVE</p>

        {poolRead === null && <p className="text-white/70 text-[13px]">Reading the pool…</p>}

        {poolRead && !poolRead.ok && (
          <p className="text-[13px]" style={{ color: '#f0b26b' }}>{poolRead.reason}</p>
        )}

        {pool && (
          <>
            <div className="flex flex-wrap gap-x-8 gap-y-2 mb-2">
              <div>
                <p className="text-[10px] uppercase tracking-wider text-white/60">Reward vault</p>
                <p className="stat-value text-2xl text-white">{fmt(funded, decimals)} <span className="text-[13px] text-white/60">{bungalow.symbol}</span></p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wider text-white/60">Total staked</p>
                <p className="stat-value text-2xl text-white">{fmt(pool.totalStakeRaw, decimals)} <span className="text-[13px] text-white/60">{bungalow.symbol}</span></p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wider text-white/60">Lock window</p>
                <p className="stat-value text-2xl text-white">{minDays}–{maxDays} <span className="text-[13px] text-white/60">days</span></p>
              </div>
            </div>

            {/* The rate is on-chain configuration, not a promise — and runway
                is what makes it honest: a rate the vault can pay for 0 days
                is not a rate. */}
            <div className="text-white/70 text-[12px] mb-4 space-y-0.5">
              {ratePerDay !== null && (
                <p>
                  Configured rate: {ratePerDay.toLocaleString(undefined, { maximumSignificantDigits: 3 })}{' '}
                  {bungalow.symbol} per staked {bungalow.symbol} per day
                  {flatWeight ? ' — every lock length earns this same rate; longer adds no boost.' : ''}
                </p>
              )}
              <p>Vault runway at current stake: {fmtRunway(runway)}.</p>
            </div>

            {vaultDry && (
              <p className="text-[12px] mb-4 rounded-lg px-3 py-2" style={{ background: 'rgba(227,179,65,0.1)', border: '1px solid rgba(227,179,65,0.4)', color: '#e3b341' }}>
                The reward vault is {funded === 0n ? 'empty' : 'effectively empty'} — staking earns
                nothing until it is funded, and (proven against the live program) claims and exits
                revert while accrued rewards exceed the vault. New stakes are paused here so a
                deposit cannot become locked-in principal; accrued rewards are never lost — they
                pay out in full once the vault is topped up.
              </p>
            )}
            {funded === null && (
              <p className="text-[12px] mb-4" style={{ color: '#f0b26b' }}>
                The reward vault could not be read — outage, not a zero. Staking is paused until
                the vault is readable again.
              </p>
            )}

            <div className="rounded-xl p-4 mb-4" style={{ background: 'rgba(0,0,0,0.5)', border: '1px solid var(--color-purple-25)' }}>
              <p className="text-[10px] uppercase tracking-wider mb-2" style={{ color: 'var(--color-kyle)' }}>Stake {bungalow.symbol}</p>
              {!publicKey ? (
                <button type="button" onClick={() => setVisible(true)} className="btn-primary px-6 py-2.5 text-[13px]">
                  Connect Solana Wallet
                </button>
              ) : (
                <>
                  <div className="flex flex-wrap items-end gap-3">
                    <div>
                      <label htmlFor="lh-amount" className="block text-[11px] text-white/60 mb-1">Amount</label>
                      <input
                        id="lh-amount"
                        type="text"
                        inputMode="decimal"
                        value={amount}
                        onChange={(e) => setAmount(e.target.value)}
                        placeholder="0.0"
                        spellCheck={false}
                        className="w-40 rounded-lg px-3 py-2 text-[14px] font-mono text-white placeholder-white/35 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#4CAF50]"
                        style={{ background: 'rgba(0,0,0,0.6)', border: '1px solid var(--color-purple-25)' }}
                      />
                    </div>
                    <div>
                      <label htmlFor="lh-days" className="block text-[11px] text-white/60 mb-1">Lock (days)</label>
                      <input
                        id="lh-days"
                        type="number"
                        min={minDays}
                        max={maxDays}
                        value={chosenDays}
                        onChange={(e) => setDays(Math.max(minDays, Math.min(maxDays, Number(e.target.value) || minDays)))}
                        className="w-24 rounded-lg px-3 py-2 text-[14px] font-mono text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[#4CAF50]"
                        style={{ background: 'rgba(0,0,0,0.6)', border: '1px solid var(--color-purple-25)' }}
                      />
                    </div>
                    <button
                      type="button"
                      disabled={!amountRaw || amountRaw === 0n || !invoker || !!action?.busy || stakeBlocked}
                      onClick={() => invoker && amountRaw && void run('Stake', () => stake({
                        invoker, pool, amountRaw, durationSecs: chosenDays * DAY, entries: entries ?? [],
                      }))}
                      className="btn-primary px-6 py-2.5 text-[13px] disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {action?.busy === 'Stake' ? 'Confirm in wallet…' : `Stake ${bungalow.symbol}`}
                    </button>
                  </div>
                  {!entriesKnown && entriesForWallet?.reason && (
                    <p className="text-[12px] mt-2" style={{ color: '#f0b26b' }}>
                      {entriesForWallet.reason} Staking is paused until your existing stakes are
                      readable — otherwise a new stake could collide with one of them.
                    </p>
                  )}
                  {!entriesKnown && !entriesForWallet?.reason && (
                    <p className="text-white/50 text-[12px] mt-2">Reading your stakes…</p>
                  )}
                </>
              )}
            </div>

            {publicKey && entriesKnown && openEntries.length > 0 && (
              <div className="rounded-xl p-4" style={{ background: 'rgba(0,0,0,0.5)', border: '1px solid var(--color-purple-25)' }}>
                <p className="text-[10px] uppercase tracking-wider mb-2" style={{ color: 'var(--color-kyle)' }}>Your stakes</p>
                <ul className="space-y-2">
                  {openEntries.map((e) => {
                    const unlockTs = e.createdTs + e.durationSecs;
                    const locked = e.createdTs > 0 && nowSecs < unlockTs;
                    return (
                      <li key={e.address || e.nonce} className="flex flex-wrap items-center gap-3 text-[13px] text-white/90">
                        <span className="font-mono">{fmt(e.amountRaw, decimals)} {bungalow.symbol}</span>
                        <span className="text-white/50">{Math.round(e.durationSecs / DAY)}d lock</span>
                        <span className="text-white/50">
                          {locked
                            ? `unlocks ${new Date(unlockTs * 1000).toLocaleDateString()}`
                            : e.createdTs ? `since ${new Date(e.createdTs * 1000).toLocaleDateString()}` : '—'}
                        </span>
                        {pool.rewardPools.map((rp) => (
                          <button
                            key={rp.address || rp.nonce}
                            type="button"
                            disabled={!invoker || !!action?.busy || vaultDry}
                            title={vaultDry ? 'Nothing claimable while the vault is unfunded — accrual is kept, not lost.' : undefined}
                            onClick={() => invoker && void run('Claim', () => claimRewards({ invoker, pool, rewardPool: rp, entryNonce: e.nonce }))}
                            className="btn-secondary px-3 py-1.5 text-[12px] disabled:opacity-50"
                          >
                            {vaultDry ? 'Nothing claimable yet' : 'Claim'}
                          </button>
                        ))}
                        <button
                          type="button"
                          disabled={!invoker || !!action?.busy || locked}
                          title={locked ? `Locked until ${new Date(unlockTs * 1000).toLocaleString()}` : undefined}
                          onClick={() => invoker && void run('Unstake', () => unstakeAndClaim({ invoker, pool, entryNonce: e.nonce }))}
                          className="btn-secondary px-3 py-1.5 text-[12px] disabled:opacity-50"
                        >
                          Unstake &amp; claim
                        </button>
                      </li>
                    );
                  })}
                </ul>
                {vaultDry && (
                  <p className="text-white/55 text-[11px] mt-3">
                    While the vault cannot cover accrued rewards, unstaking reverts too (the exit
                    pays rewards in the same transaction). Nothing is lost — both work again the
                    moment the vault is topped up.
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

            <p className="text-white/45 text-[11px] mt-4">
              Pool{' '}
              <a href={`https://solscan.io/account/${pool.address}`} target="_blank" rel="noopener noreferrer"
                aria-label="View stake pool on Solscan (opens in new tab)"
                className="underline underline-offset-2 hover:text-white/80 font-mono">
                {pool.address.slice(0, 4)}…{pool.address.slice(-4)} ↗
              </a>{' '}
              · a Streamflow staking pool — audited program, non-custodial, verifiable on-chain.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
