// Polyfill MUST load before any @solana/* import (jupiter.ts / providers pull
// in web3.js) — keep this the very first import in this lazy chunk's entry.
import '../lib/solanaPolyfill';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { m } from 'framer-motion';
import { toast } from 'sonner';
import { PublicKey, VersionedTransaction, type Connection } from '@solana/web3.js';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { usePageTitle } from '../hooks/usePageTitle';
import { trackPageView } from '../lib/analytics';
import { ArtImg } from '../components/ArtImg';
import { FeatureNotDeployed } from '../components/ui/FeatureNotDeployed';
import { SolanaProviders } from '../components/solana/SolanaProviders';
import { isSolanaConfigured, SOLANA_PLATFORM_FEE_BPS, SOL_MINT, USDC_MINT } from '../lib/solana';
import {
  PAY_WITH_TOKENS,
  BUY_TOKENS,
  SOL,
  USDC,
  LEGACY_TOKEN_PROGRAM,
  LST_TOKENS,
  findSolToken,
  searchTokens,
  looksLikeMint,
  fetchTrending,
  iconSrc,
  type SolToken,
  type TrendingCategory,
  type TrendingInterval,
} from '../lib/solanaTokenList';
import {
  getQuote,
  buildSwapTransaction,
  pickFeeMint,
  getUsdPrices,
  routeLabels,
  getShield,
  simulateSwap,
  createTriggerOrder,
  getTriggerOrders,
  cancelTriggerOrder,
  orderKeyOf,
  toBaseUnits,
  fromBaseUnits,
  type JupiterQuote,
  type ShieldWarning,
  type TriggerOrder,
} from '../lib/jupiter';

const SLIPPAGE_PRESETS = [50, 100, 300]; // bps

function prettyAmount(s: string): string {
  if (!s.includes('.')) return s;
  const [w, f] = s.split('.');
  return `${w ?? '0'}.${(f ?? '').slice(0, 6)}`;
}

function shortSig(sig: string): string {
  return `${sig.slice(0, 6)}…${sig.slice(-6)}`;
}

// Confirm by polling signature status — deliberately avoids a WS subscription
// so the RPC only needs an https CSP entry, not wss.
async function pollConfirm(connection: Connection, signature: string, timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { value } = await connection.getSignatureStatuses([signature]);
    const st = value[0];
    if (st) {
      if (st.err) throw new Error('Transaction failed on-chain');
      if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') return;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error('Could not confirm in time — check your wallet / Solscan before retrying');
}

interface TokenPickerProps {
  title: string;
  featured: SolToken[];
  onSelect: (t: SolToken) => void;
  onClose: () => void;
}

function riskBadges(t: SolToken): { label: string; tone: 'amber' | 'red' }[] {
  const out: { label: string; tone: 'amber' | 'red' }[] = [];
  if (t.verified === false) out.push({ label: 'Unverified', tone: 'amber' });
  if (t.tokenProgram && t.tokenProgram !== LEGACY_TOKEN_PROGRAM) out.push({ label: 'Token-2022', tone: 'amber' });
  if (t.audit?.freezeAuthorityDisabled === false) out.push({ label: 'Can freeze', tone: 'red' });
  return out;
}

// Whether a mint's Shield warnings should FORCE the "swap anyway" ack. Jupiter
// only emits info/warning severities (no critical tier), so we gate on warning+
// — but a curated stablecoin/LST's expected freeze authority (USDC/USDT/LST) is
// benign and shouldn't nag, while honeypot / transfer-hook / transfer-fee
// warnings still gate.
function dangerousShield(warnings: ShieldWarning[], mint: string): boolean {
  return warnings.some((w) => {
    if (!/warn|crit|danger|high|severe/i.test(w.severity)) return false;
    if (w.type === 'HAS_FREEZE_AUTHORITY' && findSolToken(mint)) return false;
    return true;
  });
}

// Token icon via the CSP-safe weserv proxy, falling back to an initials avatar
// on missing/broken images (we never load arbitrary token-image hosts directly).
function TokenAvatar({ token, size = 28 }: { token: SolToken; size?: number }) {
  const [errored, setErrored] = useState(false);
  const src = errored ? '' : iconSrc(token.logoURI);
  const px = `${size}px`;
  if (src) {
    return (
      <img
        src={src}
        alt=""
        loading="lazy"
        onError={() => setErrored(true)}
        className="rounded-full flex-shrink-0 object-cover"
        style={{ width: px, height: px, background: 'var(--color-purple-25)' }}
      />
    );
  }
  return (
    <div
      className="rounded-full flex items-center justify-center text-[10px] font-bold text-white flex-shrink-0"
      style={{ width: px, height: px, background: 'var(--color-purple-25)' }}
    >
      {token.symbol.slice(0, 3)}
    </div>
  );
}

function TokenRow({ t, onSelect }: { t: SolToken; onSelect: (t: SolToken) => void }) {
  const badges = riskBadges(t);
  return (
    <button
      type="button"
      onClick={() => onSelect(t)}
      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-white/5 transition-colors text-left"
    >
      <TokenAvatar token={t} size={28} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-white text-[13px] font-medium truncate">{t.symbol}</span>
          {t.verified === true && <span className="text-success text-[10px]" title="Verified on Jupiter" aria-label="Verified">✓</span>}
        </div>
        <div className="text-white/50 text-[11px] truncate">{t.name}</div>
        {badges.length > 0 && (
          <div className="flex gap-1 flex-wrap mt-0.5">
            {badges.map((b) => (
              <span
                key={b.label}
                className={`px-1.5 py-0.5 rounded text-[9px] font-semibold ${b.tone === 'red' ? 'bg-red-500/20 text-red-300' : 'bg-amber-500/20 text-amber-300'}`}
              >
                {b.label}
              </span>
            ))}
          </div>
        )}
      </div>
    </button>
  );
}

function TokenPicker({ title, featured, onSelect, onClose }: TokenPickerProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SolToken[] | null>(null); // null = show featured
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Escape to close + focus management: focus the search box on open, trap Tab
  // within the dialog, and restore focus to the trigger on close (mirrors the
  // TopNav drawer's a11y pattern).
  useEffect(() => {
    const prevFocus = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return; }
      if (e.key !== 'Tab' || !panelRef.current) return;
      const focusables = panelRef.current.querySelectorAll<HTMLElement>(
        'input, button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (active === first || !panelRef.current.contains(active)) { last.focus(); e.preventDefault(); }
      } else {
        if (active === last || !panelRef.current.contains(active)) { first.focus(); e.preventDefault(); }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      prevFocus?.focus();
    };
  }, [onClose]);

  // Debounced token search — matches symbol, name, OR a pasted mint address.
  // All setState runs inside the deferred timeout/promise callbacks (never the
  // synchronous effect body) so it can't trigger cascading renders.
  useEffect(() => {
    const q = query.trim();
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      if (!q) { setResults(null); setError(null); setLoading(false); return; }
      setLoading(true); setError(null);
      searchTokens(q, ctrl.signal)
        .then((r) => {
          if (ctrl.signal.aborted) return;
          setResults(r); setLoading(false);
          setError(r.length === 0 ? (looksLikeMint(q) ? 'Mint not found / not listed on Jupiter.' : 'No tokens found.') : null);
        })
        .catch((err: unknown) => {
          if (ctrl.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
          setResults([]); setLoading(false); setError('Search unavailable — try again.');
        });
    }, q ? 350 : 0);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [query]);

  const list = results ?? featured;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div
        ref={panelRef}
        tabIndex={-1}
        className="relative z-10 w-full max-w-sm rounded-2xl p-4 outline-none"
        style={{ background: 'var(--color-bg-elevated)', border: '1px solid rgba(255,255,255,0.14)' }}
      >
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-white text-[14px] font-semibold">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close token list" className="text-white/60 hover:text-white p-1 text-[14px]">✕</button>
        </div>
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search name / symbol, or paste a mint"
          aria-label="Search tokens"
          spellCheck={false}
          autoComplete="off"
          className="w-full mb-3 px-3 py-2 rounded-lg bg-black/50 text-white text-[13px] outline-none"
          style={{ border: '1px solid rgba(255,255,255,0.14)' }}
        />
        {!results && <p className="text-white/40 text-[10px] uppercase tracking-wide mb-1 px-1">Popular</p>}
        <div className="space-y-1 max-h-[300px] overflow-y-auto">
          {loading && <div className="px-3 py-2.5 text-white/50 text-[12px]">Searching…</div>}
          {!loading && list.map((t) => <TokenRow key={t.mint} t={t} onSelect={onSelect} />)}
          {!loading && error && <p className="px-3 py-2 text-amber-300 text-[12px]">{error}</p>}
        </div>
      </div>
    </div>
  );
}

// Connected wallet's balance for a token (SOL via getBalance; SPL via parsed
// token accounts). Reads through the proxied connection. Returns null on no
// wallet / error (balance just doesn't render).
function useTokenBalance(token: SolToken): { raw: bigint | null; human: string | null; loading: boolean } {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const [raw, setRaw] = useState<bigint | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!publicKey) { setRaw(null); setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        let amount: bigint;
        if (token.mint === SOL_MINT) {
          amount = BigInt(await connection.getBalance(publicKey));
        } else {
          const resp = await connection.getParsedTokenAccountsByOwner(publicKey, { mint: new PublicKey(token.mint) });
          amount = resp.value.reduce((sum, a) => {
            const v = (a.account.data.parsed as { info?: { tokenAmount?: { amount?: string } } } | undefined)?.info?.tokenAmount?.amount;
            return sum + (v ? BigInt(v) : 0n);
          }, 0n);
        }
        if (!cancelled) setRaw(amount);
      } catch {
        if (!cancelled) setRaw(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [connection, publicKey, token.mint, token.decimals]);

  const human = raw === null ? null : fromBaseUnits(raw.toString(), token.decimals);
  return { raw, human, loading };
}

// Trending Solana tokens — drives one-click, fee-bearing buys (pay SOL → token).
function TrendingRail({ onPick }: { onPick: (t: SolToken) => void }) {
  const [category, setCategory] = useState<TrendingCategory>('toptrending');
  const [tokens, setTokens] = useState<SolToken[]>([]);
  const [loading, setLoading] = useState(true);
  const interval: TrendingInterval = '24h';

  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();
    // setState in the deferred callback (not the synchronous effect body).
    const t = setTimeout(() => {
      setLoading(true);
      fetchTrending(category, interval, 12, ctrl.signal)
        .then((ts) => { if (!cancelled) { setTokens(ts); setLoading(false); } })
        .catch((err: unknown) => {
          if (ctrl.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
          if (!cancelled) { setTokens([]); setLoading(false); }
        });
    }, 0);
    return () => { cancelled = true; ctrl.abort(); clearTimeout(t); };
  }, [category]);

  const CATS: { key: TrendingCategory; label: string }[] = [
    { key: 'toptrending', label: 'Trending' },
    { key: 'toptraded', label: 'Top Traded' },
    { key: 'toporganicscore', label: 'Top Organic' },
  ];

  if (!loading && tokens.length === 0) return null;

  return (
    <div className="mt-6">
      <div className="flex items-center justify-between mb-2 gap-2">
        <h2 className="text-white text-[13px] font-semibold flex-shrink-0">Trending on Solana</h2>
        <div className="flex gap-1">
          {CATS.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => setCategory(c.key)}
              aria-pressed={category === c.key}
              className="px-2 py-1 rounded-md text-[10px] font-medium text-white transition-colors"
              style={{
                background: category === c.key ? 'var(--color-stan)' : 'rgba(0,0,0,0.45)',
                border: category === c.key ? '1px solid var(--color-stan)' : '1px solid rgba(255,255,255,0.12)',
              }}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {loading
          ? Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-[56px] rounded-xl animate-pulse" style={{ background: 'rgba(255,255,255,0.06)' }} />
            ))
          : tokens.map((t) => {
              const chg = t.priceChange24h;
              return (
                <button
                  key={t.mint}
                  type="button"
                  onClick={() => onPick(t)}
                  className="flex items-center gap-2 p-2.5 rounded-xl hover:bg-white/5 transition-colors text-left"
                  style={{ background: 'rgba(0,0,0,0.45)', border: '1px solid rgba(255,255,255,0.10)' }}
                >
                  <TokenAvatar token={t} size={26} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1">
                      <span className="text-white text-[12px] font-medium truncate">{t.symbol}</span>
                      {t.verified === true && <span className="text-success text-[9px]" aria-label="Verified">✓</span>}
                    </div>
                    {typeof chg === 'number' && (
                      <span className={`text-[10px] font-mono ${chg >= 0 ? 'text-success' : 'text-red-300'}`}>
                        {chg >= 0 ? '+' : ''}{chg.toFixed(1)}%
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
      </div>
      <p className="text-white/30 text-[9px] mt-1.5">Trending data from Jupiter. Not an endorsement — verify before buying.</p>
    </div>
  );
}

// "Earn" — buy a liquid-staking token to earn SOL staking yield. The buy IS the
// product (value accrues each epoch, no lockup) and it's fee-bearing (SOL → LST).
function EarnRail({ onPick }: { onPick: (t: SolToken) => void }) {
  return (
    <div className="mt-6">
      <div className="flex items-baseline justify-between mb-2">
        <h2 className="text-white text-[13px] font-semibold">Earn SOL staking yield</h2>
        <span className="text-white/40 text-[10px]">liquid staking · no lockup</span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {LST_TOKENS.map((t) => (
          <button
            key={t.mint}
            type="button"
            onClick={() => onPick(t)}
            className="flex items-center gap-2 p-2.5 rounded-xl hover:bg-white/5 transition-colors text-left"
            style={{ background: 'rgba(0,0,0,0.45)', border: '1px solid rgba(255,255,255,0.10)' }}
          >
            <TokenAvatar token={t} size={26} />
            <div className="min-w-0 flex-1">
              <div className="text-white text-[12px] font-medium truncate">{t.symbol}</div>
              <div className="text-success text-[10px] font-mono">~{t.apy.toFixed(1)}% APY · {t.provider}</div>
            </div>
          </button>
        ))}
      </div>
      <p className="text-white/30 text-[9px] mt-1.5">
        Buy a liquid-staking token to earn ~validator APY automatically — its value grows each epoch, no lockup, sell
        back to SOL anytime. APY is variable. A {SOLANA_PLATFORM_FEE_BPS / 100}% fee applies on the SOL buy.
      </p>
    </div>
  );
}

// Limit orders — Jupiter Trigger: real ON-CHAIN orders, filled by keepers (no tab
// to keep open, unlike the EVM browser-only Alerts). Shares the pair with swap.
// v1 ships fee-off (integrator fees need a referral-account setup).
function LimitTab({ payToken, buyToken, shieldWarnings, needsAck, ack, setAck, onPickPay, onPickBuy }: {
  payToken: SolToken; buyToken: SolToken;
  shieldWarnings: ShieldWarning[]; needsAck: boolean; ack: boolean; setAck: (v: boolean) => void;
  onPickPay: () => void; onPickBuy: () => void;
}) {
  const { connection } = useConnection();
  const { publicKey, sendTransaction, connecting } = useWallet();
  const { setVisible } = useWalletModal();

  const [sellAmount, setSellAmount] = useState('');
  const [price, setPrice] = useState('');
  const [expiryDays, setExpiryDays] = useState(7);
  const [placing, setPlacing] = useState(false);
  const [orders, setOrders] = useState<TriggerOrder[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const payBalance = useTokenBalance(payToken);

  const sameToken = payToken.mint === buyToken.mint;
  const makingAmount = useMemo(() => toBaseUnits(sellAmount, payToken.decimals), [sellAmount, payToken.decimals]);
  // takingAmount = makingAmount × price in BigInt fixed-point (no float / no
  // exponential round-trip). price is the buyToken-per-1-payToken rate.
  const takingAmount = useMemo(() => {
    const priceBase = toBaseUnits(price, buyToken.decimals);
    if (!makingAmount || !priceBase) return null;
    const taking = (BigInt(makingAmount) * BigInt(priceBase)) / (10n ** BigInt(payToken.decimals));
    return taking === 0n ? null : taking.toString();
  }, [makingAmount, price, payToken.decimals, buyToken.decimals]);
  const insufficient = payBalance.raw !== null && makingAmount !== null && BigInt(makingAmount) > payBalance.raw;

  const loadOrders = useCallback(() => {
    if (!publicKey) { setOrders([]); return; }
    setOrdersLoading(true);
    getTriggerOrders(publicKey.toBase58())
      .then((o) => setOrders(o))
      .catch(() => setOrders([]))
      .finally(() => setOrdersLoading(false));
  }, [publicKey]);

  useEffect(() => { loadOrders(); }, [loadOrders]);

  async function signSend(b64: string): Promise<string> {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const tx = VersionedTransaction.deserialize(bytes);
    const sig = await sendTransaction(tx, connection);
    await pollConfirm(connection, sig);
    return sig;
  }

  async function handlePlace() {
    if (!publicKey || !makingAmount || !takingAmount || sameToken) return;
    setPlacing(true);
    try {
      const expiredAt = expiryDays > 0 ? Math.floor(Date.now() / 1000) + expiryDays * 86400 : undefined;
      const b64 = await createTriggerOrder({
        inputMint: payToken.mint,
        outputMint: buyToken.mint,
        maker: publicKey.toBase58(),
        makingAmount,
        takingAmount,
        expiredAt,
      });
      const sig = await signSend(b64);
      toast.success('Limit order placed', {
        description: shortSig(sig),
        action: { label: 'View', onClick: () => window.open(`https://solscan.io/tx/${sig}`, '_blank', 'noopener,noreferrer') },
      });
      setSellAmount(''); setPrice('');
      loadOrders();
    } catch (err) {
      toast.error('Could not place order', { description: (err as Error).message });
    } finally {
      setPlacing(false);
    }
  }

  async function handleCancel(o: TriggerOrder) {
    const key = orderKeyOf(o);
    if (!publicKey || !key) return;
    setCancelling(key);
    try {
      const sig = await signSend(await cancelTriggerOrder(publicKey.toBase58(), key));
      toast.success('Order cancelled', { description: shortSig(sig) });
      loadOrders();
    } catch (err) {
      toast.error('Could not cancel', { description: (err as Error).message });
    } finally {
      setCancelling(null);
    }
  }

  const canPlace = !!publicKey && !!makingAmount && !!takingAmount && !sameToken && !placing && !insufficient && !(needsAck && !ack);

  return (
    <>
      <div className="mb-1">
        <div className="flex items-center justify-between mb-2">
          <span className="text-white text-[11px]" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>You Sell</span>
        </div>
        <div className="flex items-center gap-3 rounded-xl p-3" style={{ background: 'rgba(0,0,0,0.55)', border: '1px solid rgba(255,255,255,0.18)' }}>
          <button type="button" onClick={onPickPay} aria-haspopup="dialog" className="flex items-center gap-2 px-3 py-1.5 rounded-lg min-h-[36px] hover:bg-white/5 transition-colors">
            <span className="text-white font-medium text-[14px]">{payToken.symbol}</span>
            <span className="text-white/80" aria-hidden="true">▾</span>
          </button>
          <input type="number" inputMode="decimal" placeholder="0.0" aria-label={`Amount of ${payToken.symbol} to sell`} value={sellAmount} onChange={(e) => setSellAmount(e.target.value)} className="flex-1 bg-transparent text-right text-white text-[20px] font-mono outline-none min-w-0" />
        </div>
      </div>

      <div className="mt-3 mb-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-white text-[11px]" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>When 1 {payToken.symbol} =</span>
        </div>
        <div className="flex items-center gap-3 rounded-xl p-3" style={{ background: 'rgba(0,0,0,0.55)', border: '1px solid rgba(255,255,255,0.18)' }}>
          <button type="button" onClick={onPickBuy} aria-haspopup="dialog" className="flex items-center gap-2 px-3 py-1.5 rounded-lg min-h-[36px] hover:bg-white/5 transition-colors">
            <span className="text-white font-medium text-[14px]">{buyToken.symbol}</span>
            <span className="text-white/80" aria-hidden="true">▾</span>
          </button>
          <input type="number" inputMode="decimal" placeholder="0.0" aria-label={`Target price in ${buyToken.symbol}`} value={price} onChange={(e) => setPrice(e.target.value)} className="flex-1 bg-transparent text-right text-white text-[20px] font-mono outline-none min-w-0" />
        </div>
      </div>

      <div className="mb-3 text-[11px] space-y-1">
        {takingAmount && (
          <div className="flex items-center justify-between text-white/70">
            <span>You receive (at limit)</span>
            <span className="font-mono">{prettyAmount(fromBaseUnits(takingAmount, buyToken.decimals))} {buyToken.symbol}</span>
          </div>
        )}
        <div className="flex items-center justify-between text-white/70">
          <span>Expires</span>
          <select value={expiryDays} onChange={(e) => setExpiryDays(Number(e.target.value))} className="bg-black/40 text-white font-mono text-[11px] outline-none rounded-md px-1.5 py-0.5" style={{ border: '1px solid rgba(255,255,255,0.12)' }}>
            <option value={1}>1 day</option>
            <option value={7}>7 days</option>
            <option value={30}>30 days</option>
            <option value={0}>Never</option>
          </select>
        </div>
        {sameToken && <p className="text-amber-300">Pick two different tokens.</p>}
        {insufficient && <p className="text-amber-300">Insufficient {payToken.symbol} balance.</p>}
        {makingAmount && Number(price) > 0 && !takingAmount && <p className="text-amber-300">Receive amount rounds to zero — increase the amount or price.</p>}
        {shieldWarnings.map((w, i) => (
          <p key={`lsh-${i}`} className={`flex items-start gap-1 ${/warn|crit|danger/i.test(w.severity) ? 'text-red-300' : 'text-white/50'}`}>
            <span aria-hidden="true">⚠</span><span>{w.message}</span>
          </p>
        ))}
      </div>

      {needsAck && (
        <label className="flex items-start gap-2 mb-3 px-3 py-2.5 rounded-lg cursor-pointer" style={{ background: 'rgba(150,40,40,0.20)', border: '1px solid rgba(255,90,90,0.35)' }}>
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5 flex-shrink-0" />
          <span className="text-[11px] text-red-200">
            This pair carries a risk warning (an unverified token, or flagged by Jupiter Shield above). I understand and want to place this order anyway.
          </span>
        </label>
      )}

      {!publicKey ? (
        <button type="button" onClick={() => setVisible(true)} disabled={connecting} className="btn-primary w-full py-2.5 text-[14px] disabled:opacity-60">
          {connecting ? 'Connecting…' : 'Connect Solana Wallet'}
        </button>
      ) : (
        <button type="button" onClick={() => void handlePlace()} disabled={!canPlace} className="btn-primary w-full py-2.5 text-[14px] disabled:opacity-50">
          {placing ? 'Placing…' : !makingAmount ? 'Enter an amount' : insufficient ? `Insufficient ${payToken.symbol}` : !price ? 'Enter a price' : !takingAmount ? 'Amount too small' : 'Place limit order'}
        </button>
      )}

      <p className="mt-3 text-center text-white/40 text-[10px]">
        Real on-chain order, filled automatically by Jupiter keepers — no tab to keep open. Funds are reserved until fill, cancel, or expiry.
      </p>

      {publicKey && (
        <div className="mt-4 pt-3" style={{ borderTop: '1px solid rgba(255,255,255,0.10)' }}>
          <div className="flex items-center justify-between mb-2">
            <span className="text-white text-[12px] font-semibold">Open orders</span>
            <button type="button" onClick={loadOrders} className="text-white/50 text-[10px] hover:text-white">Refresh</button>
          </div>
          {ordersLoading ? (
            <p className="text-white/50 text-[11px]">Loading…</p>
          ) : orders.length === 0 ? (
            <p className="text-white/40 text-[11px]">No open orders.</p>
          ) : (
            <div className="space-y-1.5">
              {orders.map((o, i) => {
                const key = orderKeyOf(o);
                const fromTok = findSolToken(String(o.inputMint ?? ''));
                const toTok = findSolToken(String(o.outputMint ?? ''));
                const sell = o.makingAmount ? prettyAmount(fromBaseUnits(String(o.makingAmount), fromTok?.decimals ?? 9)) : null;
                const buy = o.takingAmount ? prettyAmount(fromBaseUnits(String(o.takingAmount), toTok?.decimals ?? 9)) : null;
                const keyShort = key ? `${key.slice(0, 4)}…${key.slice(-4)}` : 'order';
                return (
                  <div key={key ?? i} className="flex items-center justify-between gap-2 px-2.5 py-2 rounded-lg" style={{ background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(255,255,255,0.10)' }}>
                    <div className="min-w-0">
                      <div className="text-white/80 text-[11px] truncate">
                        {sell && buy ? `Sell ${sell} ${fromTok?.symbol ?? '?'} → ${buy} ${toTok?.symbol ?? '?'}` : keyShort}
                      </div>
                      {sell && buy && <div className="text-white/40 text-[9px] font-mono truncate">{keyShort}</div>}
                    </div>
                    <button type="button" onClick={() => void handleCancel(o)} disabled={!key || cancelling === key} className="text-red-300 text-[11px] hover:text-red-200 disabled:opacity-50 flex-shrink-0">
                      {cancelling === key ? 'Cancelling…' : 'Cancel'}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </>
  );
}

function SolanaSwapInner() {
  const { connection } = useConnection();
  const { publicKey, sendTransaction, connecting } = useWallet();
  const { setVisible } = useWalletModal();

  const [payToken, setPayToken] = useState<SolToken>(SOL);
  const [buyToken, setBuyToken] = useState<SolToken>(USDC);
  const [amount, setAmount] = useState('');
  const [slippageBps, setSlippageBps] = useState(50);
  const [quote, setQuote] = useState<JupiterQuote | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [swapping, setSwapping] = useState(false);
  const [picker, setPicker] = useState<'pay' | 'buy' | null>(null);
  const [mode, setMode] = useState<'swap' | 'limit'>('swap');
  const [ack, setAck] = useState(false);
  const [prices, setPrices] = useState<Record<string, number>>({});
  const [shield, setShield] = useState<Record<string, ShieldWarning[]>>({});
  const payBalance = useTokenBalance(payToken);

  const baseAmount = useMemo(() => toBaseUnits(amount, payToken.decimals), [amount, payToken.decimals]);
  const sameToken = payToken.mint === buyToken.mint;
  const canQuote = baseAmount !== null && !sameToken;

  // Reset the unverified-token acknowledgement whenever the pair changes.
  useEffect(() => { setAck(false); }, [payToken.mint, buyToken.mint]);

  // Debounced quote fetch.
  useEffect(() => {
    if (!canQuote || !baseAmount) {
      setQuote(null);
      setQuoteError(null);
      setQuoteLoading(false);
      return;
    }
    const ctrl = new AbortController();
    setQuoteLoading(true);
    setQuoteError(null);
    const t = setTimeout(() => {
      getQuote({
        inputMint: payToken.mint,
        outputMint: buyToken.mint,
        amount: baseAmount,
        slippageBps,
        signal: ctrl.signal,
      })
        .then((q) => {
          if (ctrl.signal.aborted) return;
          setQuote(q); setQuoteError(null); setQuoteLoading(false);
        })
        .catch((err: unknown) => {
          if (ctrl.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
          setQuote(null);
          setQuoteError('No route for this pair / amount.');
          setQuoteLoading(false);
        });
    }, 400);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [baseAmount, canQuote, payToken.mint, buyToken.mint, slippageBps]);

  // USD prices for the pay + receive legs (one call, refreshed on pair change).
  useEffect(() => {
    let cancelled = false;
    getUsdPrices([payToken.mint, buyToken.mint])
      .then((p) => { if (!cancelled) setPrices(p); })
      .catch(() => { /* USD context is best-effort */ });
    return () => { cancelled = true; };
  }, [payToken.mint, buyToken.mint]);

  // Jupiter Shield risk warnings for the pair (once per pair). Fail OPEN.
  useEffect(() => {
    let cancelled = false;
    getShield([payToken.mint, buyToken.mint])
      .then((s) => { if (!cancelled) setShield(s); })
      .catch(() => { if (!cancelled) setShield({}); });
    return () => { cancelled = true; };
  }, [payToken.mint, buyToken.mint]);

  const outputDisplay = quote ? prettyAmount(fromBaseUnits(quote.outAmount, buyToken.decimals)) : '0';
  const rawImpact = Number(quote?.priceImpactPct);
  const priceImpact = Number.isFinite(rawImpact) ? Math.abs(rawImpact * 100) : null;
  const feePct = (SOLANA_PLATFORM_FEE_BPS / 100).toFixed(2);
  // The fee can only be collected on a pair touching SOL or USDC (pre-created
  // fee ATAs). Drive the UI off the SAME decision the quote/swap use.
  const feeMintForPair = isSolanaConfigured() ? pickFeeMint(payToken.mint, buyToken.mint) : null;
  const feeMintSymbol = feeMintForPair === USDC_MINT ? 'USDC' : feeMintForPair === SOL_MINT ? 'SOL' : null;
  const shieldWarnings = [...(shield[payToken.mint] ?? []), ...(shield[buyToken.mint] ?? [])];
  // Show ALL Shield warnings, but only FORCE the ack on a genuinely dangerous
  // warning (honeypot / transfer-hook / transfer-fee / non-curated freeze) or an
  // unverified token — see dangerousShield (curated USDC freeze authority is benign).
  const hasBlockingShield =
    dangerousShield(shield[payToken.mint] ?? [], payToken.mint) ||
    dangerousShield(shield[buyToken.mint] ?? [], buyToken.mint);
  const needsAck = payToken.verified === false || buyToken.verified === false || hasBlockingShield;
  const insufficient = payBalance.raw !== null && baseAmount !== null && BigInt(baseAmount) > payBalance.raw;

  const payUsd = (() => {
    const p = prices[payToken.mint];
    if (!p || !baseAmount) return null;
    const amt = Number(fromBaseUnits(baseAmount, payToken.decimals));
    return Number.isFinite(amt) ? amt * p : null;
  })();
  const receiveUsd = (() => {
    const p = prices[buyToken.mint];
    if (!p || !quote) return null;
    const amt = Number(fromBaseUnits(quote.outAmount, buyToken.decimals));
    return Number.isFinite(amt) ? amt * p : null;
  })();
  const fmtUsd = (n: number) => (n < 0.01 ? '<$0.01' : `~$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`);

  function handleMax() {
    if (payBalance.raw === null) return;
    let usable = payBalance.raw;
    if (payToken.mint === SOL_MINT) {
      // Leave ~0.01 SOL for tx fees + temporary wSOL-account rent.
      const reserve = 10_000_000n;
      usable = usable > reserve ? usable - reserve : 0n;
    }
    setAmount(usable > 0n ? fromBaseUnits(usable.toString(), payToken.decimals) : '');
  }

  async function handleSwap() {
    if (!publicKey || !quote || !baseAmount) return;
    setSwapping(true);
    try {
      // Re-quote right before building so the on-chain min-out + routing match
      // the live market (the displayed quote may be seconds-to-minutes stale).
      const fresh = await getQuote({
        inputMint: payToken.mint,
        outputMint: buyToken.mint,
        amount: baseAmount,
        slippageBps,
      });
      setQuote(fresh);
      const b64 = await buildSwapTransaction({ quote: fresh, userPublicKey: publicKey.toBase58() });
      // Pre-sign simulation — refuse to send a swap that would revert (honeypot /
      // freeze / slippage / insufficient). FAIL OPEN if simulation itself errors.
      try {
        const sim = await simulateSwap(b64);
        if (!sim.ok) {
          toast.error('Swap would fail — not sending', { description: sim.reason ?? 'Simulation reverted on-chain.' });
          return;
        }
      } catch { /* simulation unavailable — proceed to the wallet */ }
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const tx = VersionedTransaction.deserialize(bytes);
      const sig = await sendTransaction(tx, connection);
      toast.success('Swap submitted', { description: `${shortSig(sig)} — confirming…` });
      await pollConfirm(connection, sig);
      toast.success(`Bought ${buyToken.symbol}`, {
        description: shortSig(sig),
        action: { label: 'View', onClick: () => window.open(`https://solscan.io/tx/${sig}`, '_blank', 'noopener,noreferrer') },
      });
      setAmount('');
      setQuote(null);
    } catch (err) {
      toast.error('Swap failed', { description: (err as Error).message });
    } finally {
      setSwapping(false);
    }
  }

  const actionDisabled = !quote || quoteLoading || swapping || sameToken || (needsAck && !ack) || insufficient;

  return (
    <div className="max-w-md mx-auto px-4 py-8">
      <m.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="rounded-2xl p-5 relative overflow-hidden"
        style={{ border: '1px solid rgba(255,255,255,0.12)' }}
      >
        <div className="absolute inset-0">
          <ArtImg pageId="swap" idx={2} alt="" loading="lazy" className="w-full h-full object-cover" />
          <div className="absolute inset-0" style={{ background: 'rgba(6,12,26,0.87)' }} />
        </div>

        <div className="relative z-10">
          {/* Header */}
          <div className="flex items-center justify-between mb-4">
            <div>
              <h1 className="heading-luxury text-[18px] text-white">Solana Swap</h1>
              <p className="text-white/60 text-[11px]">Buy Solana tokens, routed via Jupiter.</p>
            </div>
            {publicKey ? (
              <span className="text-white/70 text-[11px] font-mono px-2 py-1 rounded-md" style={{ background: 'var(--color-purple-15)' }}>
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-success mr-1.5 align-middle" />
                {publicKey.toBase58().slice(0, 4)}…{publicKey.toBase58().slice(-4)}
              </span>
            ) : null}
          </div>

          {/* Mode tabs */}
          <div className="flex gap-1 mb-4">
            {(['swap', 'limit'] as const).map((mTab) => (
              <button
                key={mTab}
                type="button"
                onClick={() => setMode(mTab)}
                aria-pressed={mode === mTab}
                className="flex-1 py-1.5 rounded-lg text-[12px] font-medium text-white transition-colors"
                style={{
                  background: mode === mTab ? 'var(--color-stan)' : 'rgba(0,0,0,0.45)',
                  border: mode === mTab ? '1px solid var(--color-stan)' : '1px solid rgba(255,255,255,0.12)',
                }}
              >
                {mTab === 'swap' ? 'Instant swap' : 'Limit order'}
              </button>
            ))}
          </div>

          {mode === 'swap' ? (
            <>
          {/* You pay */}
          <div className="mb-1">
            <div className="flex items-center justify-between mb-2">
              <span className="text-white text-[11px]" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>You Pay</span>
              {publicKey && (
                <span className="text-white/60 text-[10px] font-mono">
                  Balance: {payBalance.loading ? '…' : payBalance.human ? prettyAmount(payBalance.human) : '0'}
                  {payBalance.raw !== null && payBalance.raw > 0n && (
                    <button type="button" onClick={handleMax} className="ml-1.5 font-semibold" style={{ color: 'var(--color-stan)' }}>MAX</button>
                  )}
                </span>
              )}
            </div>
            <div className="flex items-center gap-3 rounded-xl p-3" style={{ background: 'rgba(0,0,0,0.55)', border: '1px solid rgba(255,255,255,0.18)' }}>
              <button
                type="button"
                onClick={() => setPicker('pay')}
                aria-haspopup="dialog"
                className="flex items-center gap-2 px-3 py-1.5 rounded-lg min-h-[36px] hover:bg-white/5 transition-colors"
              >
                <span className="text-white font-medium text-[14px]">{payToken.symbol}</span>
                <span className="text-white/80" aria-hidden="true">▾</span>
              </button>
              <input
                type="number" inputMode="decimal" placeholder="0.0"
                aria-label={`Amount of ${payToken.symbol} to pay`}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="flex-1 bg-transparent text-right text-white text-[20px] font-mono outline-none min-w-0"
              />
            </div>
            {payUsd !== null && <div className="text-right text-white/40 text-[10px] mt-1 font-mono">{fmtUsd(payUsd)}</div>}
          </div>

          {/* Flip pay/receive */}
          <div className="flex justify-center -my-1 relative z-10">
            <button
              type="button"
              onClick={() => { setPayToken(buyToken); setBuyToken(payToken); setAmount(''); }}
              aria-label="Flip pay and receive tokens"
              className="w-10 h-10 rounded-full flex items-center justify-center transition-transform hover:scale-105"
              style={{ background: 'var(--color-stan)', border: '2px solid rgba(255,255,255,0.95)', boxShadow: '0 4px 16px rgba(0,0,0,0.70), 0 0 0 4px rgba(6,12,26,0.85)' }}
            >
              <span className="text-white text-[16px] font-bold leading-none">&#8645;</span>
            </button>
          </div>

          {/* You receive */}
          <div className="mt-3 mb-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-white text-[11px]" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>You Receive</span>
            </div>
            <div className="flex items-center gap-3 rounded-xl p-3" style={{ background: 'rgba(0,0,0,0.55)', border: '1px solid rgba(255,255,255,0.18)' }}>
              <button
                type="button"
                onClick={() => setPicker('buy')}
                aria-haspopup="dialog"
                className="flex items-center gap-2 px-3 py-1.5 rounded-lg min-h-[36px] hover:bg-white/5 transition-colors"
              >
                <span className="text-white font-medium text-[14px]">{buyToken.symbol}</span>
                <span className="text-white/80" aria-hidden="true">▾</span>
              </button>
              <div className="flex-1 text-right text-white text-[20px] font-mono font-medium" aria-live="polite" aria-atomic="true">
                {quoteLoading ? (
                  <span className="inline-block w-24 h-5 rounded align-middle animate-pulse" style={{ background: 'rgba(255,255,255,0.18)' }} aria-label="Loading quote" />
                ) : outputDisplay}
              </div>
            </div>
            {receiveUsd !== null && <div className="text-right text-white/40 text-[10px] mt-1 font-mono">{fmtUsd(receiveUsd)}</div>}
          </div>

          {/* Slippage */}
          <div className="mb-3 px-3 py-2.5 rounded-lg" style={{ background: 'rgba(0,0,0,0.60)', border: '1px solid rgba(255,255,255,0.12)' }}>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-white text-[11px]" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>Slippage tolerance</span>
            </div>
            <div className="flex items-center gap-1.5">
              {SLIPPAGE_PRESETS.map((bps) => {
                const active = slippageBps === bps;
                return (
                  <button
                    key={bps}
                    type="button"
                    onClick={() => setSlippageBps(bps)}
                    aria-pressed={active}
                    className="flex-1 py-1.5 min-h-[34px] rounded-lg text-[11px] font-medium transition-all text-white"
                    style={{
                      background: active ? 'var(--color-stan)' : 'rgba(0,0,0,0.45)',
                      border: active ? '1px solid var(--color-stan)' : '1px solid rgba(255,255,255,0.12)',
                    }}
                  >
                    {(bps / 100).toFixed(bps % 100 === 0 ? 0 : 1)}%
                  </button>
                );
              })}
            </div>
          </div>

          {/* Quote details */}
          <div className="mb-4 text-[11px] space-y-1">
            <div className="flex items-center justify-between text-white/70">
              <span>Platform fee</span>
              <span className="font-mono">{feeMintSymbol ? `${feePct}% · in ${feeMintSymbol}` : 'None on this pair'}</span>
            </div>
            {quote && priceImpact !== null && (
              <div className="flex items-center justify-between text-white/70">
                <span>Price impact</span>
                <span className="font-mono">{priceImpact < 0.01 ? '<0.01' : priceImpact.toFixed(2)}%</span>
              </div>
            )}
            {quote && (
              <div className="flex items-center justify-between text-white/70">
                <span>Minimum received</span>
                <span className="font-mono">{prettyAmount(fromBaseUnits(quote.otherAmountThreshold, buyToken.decimals))} {buyToken.symbol}</span>
              </div>
            )}
            {quote && routeLabels(quote).length > 0 && (
              <div className="flex items-center justify-between text-white/70">
                <span>Route</span>
                <span className="font-mono truncate ml-2" title={routeLabels(quote).join(' / ')}>via {routeLabels(quote).join(' / ')}</span>
              </div>
            )}
            {sameToken && <p className="text-amber-300">Pick two different tokens.</p>}
            {quoteError && !sameToken && <p className="text-amber-300">{quoteError}</p>}
            {amount.trim() !== '' && !baseAmount && !sameToken && <p className="text-amber-300">Enter a valid amount.</p>}
            {insufficient && <p className="text-amber-300">Insufficient {payToken.symbol} balance.</p>}
            {shieldWarnings.map((w, i) => (
              <p key={`sh-${i}`} className={`flex items-start gap-1 ${/warn|crit|danger/i.test(w.severity) ? 'text-red-300' : 'text-white/50'}`}>
                <span aria-hidden="true">⚠</span><span>{w.message}</span>
              </p>
            ))}
          </div>

          {/* Risk acknowledgement — warn, don't block (any pair is allowed). */}
          {needsAck && (
            <label
              className="flex items-start gap-2 mb-3 px-3 py-2.5 rounded-lg cursor-pointer"
              style={{ background: 'rgba(150,40,40,0.20)', border: '1px solid rgba(255,90,90,0.35)' }}
            >
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5 flex-shrink-0" />
              <span className="text-[11px] text-red-200">
                This pair carries a risk warning (an unverified token, or flagged by Jupiter Shield above).
                It could be a scam or have transfer restrictions. I understand and want to swap anyway.
              </span>
            </label>
          )}

          {/* Action */}
          {!publicKey ? (
            <button
              type="button"
              onClick={() => setVisible(true)}
              disabled={connecting}
              className="btn-primary w-full py-2.5 text-[14px] disabled:opacity-60"
            >
              {connecting ? 'Connecting…' : 'Connect Solana Wallet'}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void handleSwap()}
              disabled={actionDisabled}
              className="btn-primary w-full py-2.5 text-[14px] disabled:opacity-50"
            >
              {swapping ? 'Swapping…' : quoteLoading ? 'Fetching quote…' : !baseAmount ? 'Enter an amount' : insufficient ? `Insufficient ${payToken.symbol}` : !quote ? 'No route' : `Buy ${buyToken.symbol}`}
            </button>
          )}

          <p className="mt-3 text-center text-white/40 text-[10px]">
            Swaps route through Jupiter on Solana. A {feePct}% platform fee applies on pairs that include SOL or USDC.
          </p>
            </>
          ) : (
            <LimitTab payToken={payToken} buyToken={buyToken} shieldWarnings={shieldWarnings} needsAck={needsAck} ack={ack} setAck={setAck} onPickPay={() => setPicker('pay')} onPickBuy={() => setPicker('buy')} />
          )}
        </div>
      </m.div>

      {mode === 'swap' && (
        <>
          <EarnRail onPick={(t) => { setPayToken(SOL); setBuyToken(t); }} />
          <TrendingRail onPick={(t) => { setPayToken(SOL); setBuyToken(t); }} />
        </>
      )}

      {picker === 'pay' && (
        <TokenPicker
          title="Pay with"
          featured={PAY_WITH_TOKENS}
          onClose={() => setPicker(null)}
          onSelect={(t) => { setPayToken(t); setPicker(null); }}
        />
      )}
      {picker === 'buy' && (
        <TokenPicker
          title="Buy"
          featured={BUY_TOKENS}
          onClose={() => setPicker(null)}
          onSelect={(t) => { setBuyToken(t); setPicker(null); }}
        />
      )}
    </div>
  );
}

export default function SolanaSwapPage() {
  usePageTitle('Solana Swap', 'Buy Solana tokens on Tegridy Farms via Jupiter.');
  useEffect(() => { trackPageView('solana-swap'); }, []);

  if (!isSolanaConfigured()) {
    return (
      <div className="max-w-md mx-auto px-4 py-10">
        <FeatureNotDeployed
          pageId="swap"
          idx={2}
          title="Solana swap isn't live yet"
          subtitle="Buy Solana tokens on Tegridy with a transparent platform fee — coming soon."
        />
      </div>
    );
  }

  return (
    <SolanaProviders>
      <SolanaSwapInner />
    </SolanaProviders>
  );
}
