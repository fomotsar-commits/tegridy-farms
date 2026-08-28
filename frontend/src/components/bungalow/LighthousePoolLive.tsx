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
  type PoolView,
  type StakeEntryView,
} from '../../lib/bungalowStaking';

/**
 * The lighthouse pool, LIVE — rendered by BungalowFarmPanel when the
 * bungalow has a configured Streamflow stake-pool address.
 *
 * FUNDING-LAST honesty contract:
 *  - the reward vault balance is the headline number, straight off-chain;
 *  - a 0 vault renders as a labeled real zero ("staking earns nothing until
 *    the vault is funded") — deposits stay open, nothing advertises yield;
 *  - a failed read is an OUTAGE state, never rendered as zero;
 *  - no APR is synthesized anywhere: the only rate shown is the pool's
 *    on-chain configured rate parts, labeled as configuration.
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

const DECIMALS = 6; // BAYLA per its pump.fun coin record

function fmt(raw: bigint | null, decimals = DECIMALS): string {
  if (raw === null) return '–';
  const s = raw.toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, -decimals);
  const frac = s.slice(-decimals).replace(/0+$/, '');
  const wholeFmt = Number(whole) > 1e15 ? whole : Number(whole).toLocaleString();
  return frac ? `${wholeFmt}.${frac.slice(0, 2)}` : wholeFmt;
}

function toRaw(human: string, decimals = DECIMALS): bigint | null {
  const t = human.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const [w, f = ''] = t.split('.');
  const frac = (f + '0'.repeat(decimals)).slice(0, decimals);
  try { return BigInt(w + frac); } catch { return null; }
}

const DAY = 86_400;

function Inner({ bungalow }: { bungalow: Bungalow & { stakePool: string } }) {
  const { publicKey, wallet } = useWallet();
  const { setVisible } = useWalletModal();

  const [poolRead, setPoolRead] = useState<{ ok: true; pool: PoolView } | { ok: false; reason: string } | null>(null);
  // Entries keyed by wallet: a disconnect/switch is handled by DERIVING the
  // visible list from the key match (never a synchronous setState in an
  // effect — react-hooks/set-state-in-effect).
  const [entriesRead, setEntriesRead] = useState<{ key: string; list: StakeEntryView[] }>({ key: '', list: [] });
  const [amount, setAmount] = useState('');
  const [days, setDays] = useState<number | null>(null);
  const [action, setAction] = useState<{ busy?: string; note?: string; tx?: string } | null>(null);

  const walletKey = publicKey?.toBase58() ?? '';
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

  const entries = walletKey && entriesRead.key === walletKey ? entriesRead.list : [];

  const pool = poolRead?.ok ? poolRead.pool : null;
  const funded: bigint | null = pool
    ? pool.rewardPools.reduce<bigint | null>((acc, rp) => (acc === null || rp.fundedRaw === null ? null : acc + rp.fundedRaw), 0n)
    : null;
  const minDays = pool ? Math.max(1, Math.ceil(pool.minDurationSecs / DAY)) : 1;
  const maxDays = pool ? Math.max(minDays, Math.floor(pool.maxDurationSecs / DAY)) : minDays;
  const chosenDays = days ?? minDays;
  const amountRaw = toRaw(amount);
  const invoker = wallet?.adapter as SignerWalletAdapter | undefined;
  const openEntries = entries.filter((e) => e.closedTs === 0);

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
            <div className="flex flex-wrap gap-x-8 gap-y-2 mb-4">
              <div>
                <p className="text-[10px] uppercase tracking-wider text-white/60">Reward vault</p>
                <p className="stat-value text-2xl text-white">{fmt(funded)} <span className="text-[13px] text-white/60">{bungalow.symbol}</span></p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wider text-white/60">Total staked</p>
                <p className="stat-value text-2xl text-white">{fmt(pool.totalStakeRaw)} <span className="text-[13px] text-white/60">{bungalow.symbol}</span></p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wider text-white/60">Lock window</p>
                <p className="stat-value text-2xl text-white">{minDays}–{maxDays} <span className="text-[13px] text-white/60">days</span></p>
              </div>
            </div>

            {funded === 0n && (
              <p className="text-[12px] mb-4 rounded-lg px-3 py-2" style={{ background: 'rgba(227,179,65,0.1)', border: '1px solid rgba(227,179,65,0.4)', color: '#e3b341' }}>
                The reward vault is empty: staking earns nothing until it is funded.
                Deposits are open — that is a fact about the pool, not a promise about yield.
              </p>
            )}
            {funded === null && (
              <p className="text-[12px] mb-4" style={{ color: '#f0b26b' }}>
                The reward vault could not be read — outage, not a zero.
              </p>
            )}

            <div className="rounded-xl p-4 mb-4" style={{ background: 'rgba(0,0,0,0.5)', border: '1px solid var(--color-purple-25)' }}>
              <p className="text-[10px] uppercase tracking-wider mb-2" style={{ color: 'var(--color-kyle)' }}>Stake {bungalow.symbol}</p>
              {!publicKey ? (
                <button type="button" onClick={() => setVisible(true)} className="btn-primary px-6 py-2.5 text-[13px]">
                  Connect Solana Wallet
                </button>
              ) : (
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
                      className="w-40 rounded-lg px-3 py-2 text-[14px] font-mono text-white placeholder:text-white/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#4CAF50]"
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
                    disabled={!amountRaw || amountRaw === 0n || !invoker || !!action?.busy}
                    onClick={() => invoker && amountRaw && void run('Stake', () => stake({
                      invoker, pool, amountRaw, durationSecs: chosenDays * DAY, entries,
                    }))}
                    className="btn-primary px-6 py-2.5 text-[13px] disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {action?.busy === 'Stake' ? 'Confirm in wallet…' : `Stake ${bungalow.symbol}`}
                  </button>
                </div>
              )}
            </div>

            {publicKey && openEntries.length > 0 && (
              <div className="rounded-xl p-4" style={{ background: 'rgba(0,0,0,0.5)', border: '1px solid var(--color-purple-25)' }}>
                <p className="text-[10px] uppercase tracking-wider mb-2" style={{ color: 'var(--color-kyle)' }}>Your stakes</p>
                <ul className="space-y-2">
                  {openEntries.map((e) => (
                    <li key={e.address || e.nonce} className="flex flex-wrap items-center gap-3 text-[13px] text-white/90">
                      <span className="font-mono">{fmt(e.amountRaw)} {bungalow.symbol}</span>
                      <span className="text-white/50">{Math.round(e.durationSecs / DAY)}d lock</span>
                      <span className="text-white/50">since {e.createdTs ? new Date(e.createdTs * 1000).toLocaleDateString() : '—'}</span>
                      {pool.rewardPools.map((rp) => (
                        <button
                          key={rp.address || rp.nonce}
                          type="button"
                          disabled={!invoker || !!action?.busy}
                          onClick={() => invoker && void run('Claim', () => claimRewards({ invoker, pool, rewardPool: rp, entryNonce: e.nonce }))}
                          className="btn-secondary px-3 py-1.5 text-[12px] disabled:opacity-50"
                        >
                          Claim
                        </button>
                      ))}
                      <button
                        type="button"
                        disabled={!invoker || !!action?.busy}
                        onClick={() => invoker && void run('Unstake', () => unstakeAndClaim({ invoker, pool, entryNonce: e.nonce }))}
                        className="btn-secondary px-3 py-1.5 text-[12px] disabled:opacity-50"
                      >
                        Unstake &amp; claim
                      </button>
                    </li>
                  ))}
                </ul>
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
