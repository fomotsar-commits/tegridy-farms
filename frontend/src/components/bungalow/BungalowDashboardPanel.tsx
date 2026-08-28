// Polyfill MUST load before any @solana/* import — same rule as SolanaProviders.
import '../../lib/solanaPolyfill';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { PublicKey } from '@solana/web3.js';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { SolanaProviders } from '../solana/SolanaProviders';
import type { Bungalow, BungalowIdentity } from '../../lib/bungalows';
import { bungalowTradeRoute, bungalowExplorerUrl } from '../../lib/bungalows';
import { isSolanaSwapLive } from '../../lib/solana';
import { fromBaseUnits, getUsdPrices } from '../../lib/jupiter';
import {
  readPool,
  readEntries,
  unlockTs,
  configuredAnnualRate,
  rateIsPercent,
  type PoolView,
  type StakeEntryView,
} from '../../lib/bungalowStaking';
import { usePageTitle } from '../../hooks/usePageTitle';
import { CopyButton } from '../ui/CopyButton';
import { shortenAddress } from '../../lib/formatting';
import { ArtImg } from '../ArtImg';
import { HeatCard } from './HeatCard';
import { BungalowMarket } from './BungalowMarket';
import { BungalowHolders } from './BungalowHolders';

/**
 * The bungalow dashboard (Bayla) — "your standing on the island".
 *
 * The classic dashboard is EVM/TOWELI head to toe (wagmi reads, staking
 * position, ETH revenue), none of which describes a Solana bungalow token.
 * This panel is the token-first replacement: what you hold, what you have
 * staked, what it has accrued, what the market says, who else holds her, and
 * how long you have held.
 *
 * WHAT CHANGED 2026-08-28: this page was written while the lighthouse pool
 * did not exist, and it still SAID so — "there is no pool to deposit into
 * yet, so nothing here will ever ask" — months after the pool went live on
 * mainnet. That is the same stale-claim class the farm hero was fixed for on
 * 2026-08-27. The copy now branches on the same registry fact (`stakePool`)
 * that the farm panel does, and the position card below reads the pool
 * directly, so a dashboard can never again describe a pool that isn't there
 * (or deny one that is).
 *
 * Honesty rules, unchanged: balances are direct RPC reads; the USD figure
 * renders ONLY when the price endpoint actually answered (no cached or
 * invented prices); an unreadable number is "—", never 0; heat failures read
 * as an outage, never as cold. Nothing here projects a yield — the pool page
 * owns that conversation, and it prints the empty vault beside every rate.
 */
export function BungalowDashboardPanel({ bungalow }: { bungalow: Bungalow & { identity: BungalowIdentity } }) {
  usePageTitle(`Dashboard — ${bungalow.symbol}`, `Your ${bungalow.symbol} standing on Jungle Bay Island.`);
  return (
    <SolanaProviders>
      <Inner bungalow={bungalow} />
    </SolanaProviders>
  );
}

const CARD = { background: 'rgba(4,9,18,0.72)', border: '1px solid var(--color-purple-25)' } as const;

function fmtRaw(raw: bigint | null, decimals: number): string {
  if (raw === null) return '–';
  const s = raw.toString().padStart(decimals + 1, '0');
  const whole = Number(s.slice(0, -decimals) || '0');
  const frac = s.slice(-decimals).replace(/0+$/, '');
  const w = Number.isSafeInteger(whole) ? whole.toLocaleString() : s.slice(0, -decimals);
  return frac ? `${w}.${frac.slice(0, 2)}` : w;
}

function Inner({ bungalow }: { bungalow: Bungalow & { identity: BungalowIdentity } }) {
  const { connection } = useConnection();
  const { publicKey, disconnect } = useWallet();
  const { setVisible } = useWalletModal();

  // Balance read, keyed by wallet: `loading` is DERIVED (result key ≠ current
  // wallet key), so the effect never sets state synchronously
  // (react-hooks/set-state-in-effect) — only the async completion writes.
  const [read, setRead] = useState<{ key: string; raw: bigint | null }>({ key: '', raw: null });
  const [usdPrice, setUsdPrice] = useState<number | null>(null);
  const [poolRead, setPoolRead] = useState<PoolView | null>(null);
  const [stakeRead, setStakeRead] = useState<{ key: string; list: StakeEntryView[] } | null>(null);

  const mint = bungalow.address!;
  const decimals = poolRead?.decimals ?? 6; // BAYLA per its pump.fun coin record, until the pool read lands
  const walletKey = publicKey?.toBase58() ?? '';
  const stakePool = bungalow.stakePool;

  // Balance — same parsed-token-accounts read the swap page uses.
  useEffect(() => {
    if (!publicKey) return; // disconnected state is fully derived below
    const key = publicKey.toBase58();
    let cancelled = false;
    (async () => {
      try {
        const resp = await connection.getParsedTokenAccountsByOwner(publicKey, { mint: new PublicKey(mint) });
        const amount = resp.value.reduce((sum, a) => {
          const v = (a.account.data.parsed as { info?: { tokenAmount?: { amount?: string } } } | undefined)?.info?.tokenAmount?.amount;
          return sum + (v ? BigInt(v) : 0n);
        }, 0n);
        if (!cancelled) setRead({ key, raw: amount });
      } catch {
        if (!cancelled) setRead({ key, raw: null }); // read failed → render "–", never 0
      }
    })();
    return () => { cancelled = true; };
  }, [connection, publicKey, mint]);

  // USD read — optional, fail-closed: no answer, no number.
  useEffect(() => {
    let cancelled = false;
    getUsdPrices([mint])
      .then((prices) => {
        const p = prices?.[mint];
        if (!cancelled && typeof p === 'number' && p > 0) setUsdPrice(p);
      })
      .catch(() => { /* price surface stays absent */ });
    return () => { cancelled = true; };
  }, [mint]);

  // The lighthouse position. Self-skips entirely for a bungalow with no pool,
  // so the SDK chunk is never fetched for one.
  const loadStake = useCallback(() => {
    if (!stakePool) return () => {};
    let cancelled = false;
    readPool(stakePool).then((r) => { if (!cancelled && r.ok) setPoolRead(r.pool); });
    if (walletKey) {
      readEntries(stakePool, walletKey).then((r) => {
        if (!cancelled && r.ok) setStakeRead({ key: walletKey, list: r.entries });
      });
    }
    return () => { cancelled = true; };
  }, [stakePool, walletKey]);
  useEffect(() => loadStake(), [loadStake]);

  const balanceLoading = walletKey !== '' && read.key !== walletKey;
  const raw = walletKey !== '' && read.key === walletKey ? read.raw : null;

  const human = raw === null ? null : fromBaseUnits(raw.toString(), decimals);
  const humanNum = human === null ? null : Number(human);
  const usdValue = humanNum !== null && usdPrice !== null ? humanNum * usdPrice : null;
  const trade = bungalowTradeRoute(bungalow, isSolanaSwapLive());
  const explorer = bungalowExplorerUrl(bungalow);

  const openEntries = walletKey && stakeRead?.key === walletKey
    ? stakeRead.list.filter((e) => e.closedTs === 0)
    : [];
  const stakedRaw = openEntries.reduce((a, e) => a + e.amountRaw, 0n);
  const accruedRaw = openEntries.reduce<bigint | null>((acc, e) => {
    if (acc === null) return null;
    const vals = Object.values(e.pendingRaw);
    if (vals.length === 0) return acc;
    if (vals.some((v) => v === null)) return null;
    return acc + vals.reduce<bigint>((s, v) => s + (v as bigint), 0n);
  }, 0n);
  const nextUnlock = openEntries.length
    ? Math.min(...openEntries.map((e) => unlockTs(e)))
    : null;
  const stakeLoading = Boolean(stakePool) && walletKey !== '' && stakeRead?.key !== walletKey;
  // The vault decides whether a stake is currently EARNING anything, and the
  // dashboard says the same thing the pool page does rather than implying a
  // yield by silence.
  const vaultRaw = poolRead
    ? poolRead.rewardPools.reduce<bigint | null>((acc, rp) => (acc === null || rp.fundedRaw === null ? null : acc + rp.fundedRaw), 0n)
    : null;

  /**
   * The pool's two rate facts, stated here exactly as the pool page states
   * them — the CONFIGURED rate and what it is actually paying. Rendered
   * together or not at all: a configured rate without the vault beside it is
   * the half-truth STAKING_LOOK §2.2 exists to stop.
   */
  const poolFacts = (() => {
    const rp = poolRead?.rewardPools[0];
    if (!poolRead || !rp || vaultRaw === null) return null;
    const rate = configuredAnnualRate(poolRead, rp, poolRead.minDurationSecs);
    if (!rateIsPercent(poolRead, rp)) return null;
    return { vaultRaw, ratePct: rate * 100, decimals: rp.decimals };
  })();

  return (
    <div className="relative min-h-screen">
      <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
        <ArtImg pageId="bungalow-dashboard" idx={0} alt="" loading="lazy" className="w-full h-full object-cover" />
        <div className="absolute inset-0" style={{ background: 'rgba(6,12,26,0.6)' }} />
      </div>
      <div className="relative z-10 max-w-[1200px] mx-auto px-4 md:px-6 pt-8 pb-16">
        <div className="mb-6">
          <p className="text-white/70 text-[11px] uppercase tracking-[0.2em] mb-2">
            Jungle Bay Island · your standing
          </p>
          <h1 className="heading-luxury text-3xl md:text-5xl text-white tracking-tight mb-3">
            {bungalow.symbol} Dashboard.
          </h1>
          <p className="text-white/85 text-[15px] max-w-lg leading-relaxed">
            What you hold, what you have staked, and how long you&rsquo;ve held it — the
            island counts all three.
          </p>
        </div>

        {/* ── Your standing: three cards, one row ───────────────────────── */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Wallet / balance */}
          <div className="relative overflow-hidden rounded-2xl glass-card-animated" style={{ border: '1px solid var(--color-purple-75)' }}>
            <div className="absolute inset-0">
              <ArtImg pageId="bungalow-dashboard" idx={1} alt="" loading="lazy" className="w-full h-full object-cover" />
            </div>
            <div className="absolute inset-0" style={{ background: 'rgba(4,9,18,0.82)' }} />
            <div className="relative z-10 p-5 h-full flex flex-col">
              {!publicKey ? (
                <>
                  <p className="text-[10px] uppercase tracking-wider mb-2" style={{ color: 'var(--color-kyle)' }}>Solana wallet</p>
                  <h2 className="heading-luxury text-lg text-white mb-2">Connect to see your {bungalow.symbol}</h2>
                  <p className="text-white/80 text-[12px] leading-relaxed mb-4">
                    Your balance, your lighthouse position and your heat, read straight off
                    the chain. Connecting signs nothing and moves nothing — every deposit is
                    a separate signature you make on the {' '}
                    <Link to="/farm" className="underline underline-offset-2 hover:text-white">pool page</Link>.
                  </p>
                  <button type="button" onClick={() => setVisible(true)} className="btn-primary px-5 py-2.5 text-[13px] mt-auto self-start">
                    Connect Solana Wallet
                  </button>
                </>
              ) : (
                <>
                  <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
                    <p className="text-[10px] uppercase tracking-wider font-mono" style={{ color: 'var(--color-kyle)' }}>
                      {publicKey.toBase58().slice(0, 4)}…{publicKey.toBase58().slice(-4)}
                    </p>
                    <button type="button" onClick={() => { void disconnect(); }} className="text-white/50 hover:text-white text-[11px] underline underline-offset-2">
                      Disconnect
                    </button>
                  </div>
                  <p className="text-[10px] uppercase tracking-wider mb-1 text-white/60">In your wallet</p>
                  <p className="stat-value text-3xl text-white mb-1 leading-tight">
                    {balanceLoading ? '…' : human !== null ? Number(human).toLocaleString(undefined, { maximumFractionDigits: 2 }) : '–'}
                    <span className="text-[14px] text-white/60 ml-2">{bungalow.symbol}</span>
                  </p>
                  {usdValue !== null && (
                    <p className="text-white/70 text-[13px]">
                      ≈ ${usdValue.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                      <span className="text-white/40"> · live Jupiter read</span>
                    </p>
                  )}
                  {!balanceLoading && raw === null && (
                    <p className="text-[12px]" style={{ color: '#f0b26b' }}>Balance could not be read — that is an outage, not a zero.</p>
                  )}
                </>
              )}
            </div>
          </div>

          {/* Lighthouse position */}
          {stakePool && (
            <div className="rounded-2xl p-5" style={CARD}>
              <p className="text-[10px] uppercase tracking-wider mb-2" style={{ color: 'var(--color-kyle)' }}>At the lighthouse</p>
              {!publicKey ? (
                <>
                  <h2 className="heading-luxury text-lg text-white mb-2">The pool is live</h2>
                  <p className="text-white/80 text-[12px] leading-relaxed mb-3">
                    {bungalow.symbol} staking runs on an audited Streamflow pool, non-custodial
                    and readable by anyone. Connect above and your position appears here.
                  </p>
                  <PoolFacts facts={poolFacts} symbol={bungalow.symbol} />
                  <Link to="/farm" className="btn-secondary px-4 py-2 text-[12px] inline-block">See the pool</Link>
                </>
              ) : stakeLoading ? (
                <p className="text-white/70 text-[13px]">Reading your position…</p>
              ) : openEntries.length === 0 ? (
                <>
                  <h2 className="heading-luxury text-lg text-white mb-2">Nothing staked yet</h2>
                  <p className="text-white/80 text-[12px] leading-relaxed mb-3">
                    You hold {bungalow.symbol} but have no open stake. The pool page shows every
                    lock length, what each one is configured to pay, and what the reward vault
                    actually holds today.
                  </p>
                  <PoolFacts facts={poolFacts} symbol={bungalow.symbol} />
                  <Link to="/farm" className="btn-primary px-4 py-2 text-[12px] inline-block">Stake {bungalow.symbol}</Link>
                </>
              ) : (
                <>
                  <p className="text-[10px] uppercase tracking-wider mb-1 text-white/60">Staked</p>
                  <p className="stat-value text-3xl text-white mb-2 leading-tight">
                    {fmtRaw(stakedRaw, decimals)}
                    <span className="text-[14px] text-white/60 ml-2">{bungalow.symbol}</span>
                  </p>
                  <dl className="text-[12px] space-y-1 mb-3">
                    <div className="flex justify-between gap-3">
                      <dt className="text-white/60">Accrued rewards</dt>
                      <dd className="text-white font-mono">{fmtRaw(accruedRaw, decimals)} {bungalow.symbol}</dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-white/60">Open positions</dt>
                      <dd className="text-white font-mono">{openEntries.length}</dd>
                    </div>
                    {nextUnlock !== null && (
                      <div className="flex justify-between gap-3">
                        <dt className="text-white/60">Next unlock</dt>
                        <dd className="text-white font-mono">{new Date(nextUnlock * 1000).toLocaleDateString()}</dd>
                      </div>
                    )}
                  </dl>
                  {vaultRaw === 0n && (
                    <p className="text-[11px] mb-3" style={{ color: '#e3b341' }}>
                      The reward vault is empty, so nothing is being paid out today — your
                      principal is untouched and comes back at unlock.
                    </p>
                  )}
                  <Link to="/farm" className="btn-secondary px-4 py-2 text-[12px] inline-block">Manage position</Link>
                </>
              )}
            </div>
          )}

          {/* Where to go next + the contract, which this page never showed. */}
          <div className="rounded-2xl p-5" style={CARD}>
            <p className="text-[10px] uppercase tracking-wider mb-3" style={{ color: 'var(--color-kyle)' }}>Live surfaces</p>
            <div className="flex flex-wrap gap-2 mb-4">
              {trade && ('to' in trade ? (
                <Link to={trade.to} className="btn-primary px-4 py-2 text-[12px] inline-block text-center">Trade {bungalow.symbol}</Link>
              ) : (
                <a href={trade.href} target="_blank" rel="noopener noreferrer"
                  aria-label={`Trade ${bungalow.symbol} (opens in new tab)`}
                  className="btn-primary px-4 py-2 text-[12px] inline-block text-center">Trade {bungalow.symbol} ↗</a>
              ))}
              <Link to="/farm" className="btn-secondary px-4 py-2 text-[12px]">The lighthouse pool</Link>
              {bungalow.address && (
                <Link to={`/scan?token=${bungalow.address}`} className="btn-secondary px-4 py-2 text-[12px]">Scan {bungalow.symbol}</Link>
              )}
              {(bungalow.pools ?? []).map((p) => (
                <a key={p.url} href={p.url} target="_blank" rel="noopener noreferrer"
                  aria-label={`${p.label} (opens in new tab)`}
                  className="btn-secondary px-4 py-2 text-[12px]">
                  {p.label} ↗
                </a>
              ))}
            </div>
            {bungalow.address && (
              <div className="inline-flex items-center gap-3 flex-wrap rounded-lg p-2.5" style={{ background: 'rgba(0,0,0,0.6)', border: '1px solid var(--color-kyle-40)' }}>
                <span className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--color-kyle)' }}>Contract</span>
                <CopyButton text={bungalow.address} display={shortenAddress(bungalow.address, 6)} className="font-mono text-[12px]" style={{ color: 'var(--color-kyle)' }} />
                {explorer && (
                  <a href={explorer} target="_blank" rel="noopener noreferrer" aria-label="View token on block explorer (opens in new tab)" className="text-[11px] underline underline-offset-2 text-white/70 hover:text-white">
                    explorer ↗
                  </a>
                )}
              </div>
            )}
          </div>
        </div>

        {/* The market — chart + numbers for her own pool. The classic dashboard
            leads with a TOWELI chart; this is the same answer for this token,
            and it self-hides for a bungalow with no declared market pool. */}
        {bungalow.market && (
          <div className="mt-6">
            <BungalowMarket bungalow={bungalow} />
          </div>
        )}

        {bungalow.address && (
          <div className="mt-6">
            <BungalowHolders bungalow={bungalow} />
          </div>
        )}

        {/* Heat — prefilled with the connected wallet. */}
        <HeatCard defaultAddress={publicKey?.toBase58()} />
      </div>
    </div>
  );
}

/** The pool's rate, never without the vault that has to back it. */
function PoolFacts({ facts, symbol }: { facts: { vaultRaw: bigint; ratePct: number; decimals: number } | null; symbol: string }) {
  if (!facts) return null;
  const empty = facts.vaultRaw === 0n;
  return (
    <dl className="text-[12px] space-y-1 mb-3">
      <div className="flex justify-between gap-3">
        <dt className="text-white/60">Configured rate</dt>
        <dd className="text-white font-mono">
          {facts.ratePct.toLocaleString(undefined, { maximumFractionDigits: 1 })}% APR
        </dd>
      </div>
      <div className="flex justify-between gap-3">
        <dt className="text-white/60">Reward vault</dt>
        <dd className="font-mono" style={{ color: empty ? '#e3b341' : '#ffffff' }}>
          {fmtRaw(facts.vaultRaw, facts.decimals)} {symbol}
        </dd>
      </div>
      {empty && (
        <p className="text-[11px] pt-1" style={{ color: '#e3b341' }}>
          Empty vault, so it is paying 0 today — the rate is what the program is set to pay,
          not what it is paying.
        </p>
      )}
    </dl>
  );
}
