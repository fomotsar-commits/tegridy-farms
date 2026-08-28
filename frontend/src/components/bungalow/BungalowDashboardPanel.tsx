// Polyfill MUST load before any @solana/* import — same rule as SolanaProviders.
import '../../lib/solanaPolyfill';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { PublicKey } from '@solana/web3.js';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { SolanaProviders } from '../solana/SolanaProviders';
import type { Bungalow, BungalowIdentity } from '../../lib/bungalows';
import { bungalowTradeRoute } from '../../lib/bungalows';
import { isSolanaConfigured } from '../../lib/solana';
import { fromBaseUnits, getUsdPrices } from '../../lib/jupiter';
import { usePageTitle } from '../../hooks/usePageTitle';
import { ArtImg } from '../ArtImg';
import { HeatCard } from './HeatCard';

/**
 * The bungalow dashboard (Bayla) — "your standing on the island".
 *
 * The classic dashboard is EVM/TOWELI head to toe (wagmi reads, staking
 * position, ETH revenue), none of which describes a Solana bungalow token.
 * This panel is the token-first replacement: connect a Solana wallet, see
 * your BAYLA balance (and its USD read when the price API answers), check
 * your heat, and jump to the live surfaces.
 *
 * Honesty rules: the balance is a direct RPC read; the USD figure renders
 * ONLY when the price endpoint actually answered (no cached/invented
 * prices); heat failures read as an outage, never as cold. No yield, no
 * projections — the lighthouse pool doesn't exist yet and this page doesn't
 * pretend otherwise.
 */
export function BungalowDashboardPanel({ bungalow }: { bungalow: Bungalow & { identity: BungalowIdentity } }) {
  usePageTitle(`Dashboard — ${bungalow.symbol}`, `Your ${bungalow.symbol} standing on Jungle Bay Island.`);
  return (
    <SolanaProviders>
      <Inner bungalow={bungalow} />
    </SolanaProviders>
  );
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

  const mint = bungalow.address!;
  const decimals = 6; // BAYLA per its pump.fun coin record; registry tokens are SPL 6 unless stated
  const walletKey = publicKey?.toBase58() ?? '';

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

  const balanceLoading = walletKey !== '' && read.key !== walletKey;
  const raw = walletKey !== '' && read.key === walletKey ? read.raw : null;

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

  const human = raw === null ? null : fromBaseUnits(raw.toString(), decimals);
  const humanNum = human === null ? null : Number(human);
  const usdValue = humanNum !== null && usdPrice !== null ? humanNum * usdPrice : null;
  const trade = bungalowTradeRoute(bungalow, isSolanaConfigured());

  return (
    <div className="relative min-h-screen">
      <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
        <ArtImg pageId="bungalow-dashboard" idx={0} alt="" loading="lazy" className="w-full h-full object-cover" />
        <div className="absolute inset-0" style={{ background: 'rgba(6,12,26,0.6)' }} />
      </div>
      <div className="relative z-10 max-w-[1200px] mx-auto px-4 md:px-6 pt-8 pb-16">
        <div className="mb-8">
          <p className="text-white/70 text-[11px] uppercase tracking-[0.2em] mb-2">
            Jungle Bay Island · your standing
          </p>
          <h1 className="heading-luxury text-3xl md:text-5xl text-white tracking-tight mb-3">
            {bungalow.symbol} Dashboard.
          </h1>
          <p className="text-white/85 text-[15px] max-w-lg leading-relaxed">
            What you hold and how long you&rsquo;ve held it — the island counts both.
          </p>
        </div>

        {/* Wallet / balance card */}
        <div className="relative overflow-hidden rounded-2xl glass-card-animated" style={{ border: '1px solid var(--color-purple-75)' }}>
          <div className="absolute inset-0">
            <ArtImg pageId="bungalow-dashboard" idx={1} alt="" loading="lazy" className="w-full h-full object-cover" />
          </div>
          <div className="absolute inset-0" style={{ background: 'rgba(4,9,18,0.8)' }} />
          <div className="relative z-10 p-6">
            {!publicKey ? (
              <>
                <p className="text-[10px] uppercase tracking-wider mb-2" style={{ color: 'var(--color-kyle)' }}>Solana wallet</p>
                <h2 className="heading-luxury text-xl text-white mb-3">Connect to see your {bungalow.symbol}</h2>
                <p className="text-white/85 text-[13px] leading-relaxed mb-4 max-w-md">
                  A read-only look at your balance and heat. Connecting signs nothing and
                  moves nothing — there is no pool to deposit into yet, so nothing here
                  will ever ask.
                </p>
                <button type="button" onClick={() => setVisible(true)} className="btn-primary px-6 py-2.5 text-[14px]">
                  Connect Solana Wallet
                </button>
              </>
            ) : (
              <>
                <div className="flex items-center justify-between gap-3 flex-wrap mb-4">
                  <p className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--color-kyle)' }}>
                    {publicKey.toBase58().slice(0, 4)}…{publicKey.toBase58().slice(-4)}
                  </p>
                  <button type="button" onClick={() => { void disconnect(); }} className="text-white/50 hover:text-white text-[11px] underline underline-offset-2">
                    Disconnect
                  </button>
                </div>
                <p className="text-[10px] uppercase tracking-wider mb-1 text-white/60">{bungalow.symbol} balance</p>
                <p className="stat-value text-3xl text-white mb-1">
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

        {/* Heat — prefilled with the connected wallet. */}
        <HeatCard defaultAddress={publicKey?.toBase58()} />

        {/* Live surfaces */}
        <div className="mt-6 flex flex-wrap items-center gap-3">
          {trade && ('to' in trade ? (
            <Link to={trade.to} className="btn-primary px-6 py-2.5 text-[13px] inline-block text-center">Trade {bungalow.symbol}</Link>
          ) : (
            <a href={trade.href} target="_blank" rel="noopener noreferrer"
              aria-label={`Trade ${bungalow.symbol} (opens in new tab)`}
              className="btn-primary px-6 py-2.5 text-[13px] inline-block text-center">Trade {bungalow.symbol} ↗</a>
          ))}
          <Link to="/farm" className="btn-secondary px-6 py-2.5 text-[13px]">The lighthouse pool</Link>
          {bungalow.address && (
            <Link to={`/scan?token=${bungalow.address}`} className="btn-secondary px-6 py-2.5 text-[13px]">Scan {bungalow.symbol}</Link>
          )}
        </div>
      </div>
    </div>
  );
}
