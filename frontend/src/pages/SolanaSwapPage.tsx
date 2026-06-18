// Polyfill MUST load before any @solana/* import (jupiter.ts / providers pull
// in web3.js) — keep this the very first import in this lazy chunk's entry.
import '../lib/solanaPolyfill';
import { useEffect, useMemo, useRef, useState } from 'react';
import { m } from 'framer-motion';
import { toast } from 'sonner';
import { VersionedTransaction, type Connection } from '@solana/web3.js';
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
  searchTokens,
  looksLikeMint,
  type SolToken,
} from '../lib/solanaTokenList';
import {
  getQuote,
  buildSwapTransaction,
  pickFeeMint,
  toBaseUnits,
  fromBaseUnits,
  type JupiterQuote,
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

function TokenRow({ t, onSelect }: { t: SolToken; onSelect: (t: SolToken) => void }) {
  const badges = riskBadges(t);
  return (
    <button
      type="button"
      onClick={() => onSelect(t)}
      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-white/5 transition-colors text-left"
    >
      <div
        className="w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold text-white flex-shrink-0"
        style={{ background: 'var(--color-purple-25)' }}
      >
        {t.symbol.slice(0, 3)}
      </div>
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
  const [ack, setAck] = useState(false);

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

  const outputDisplay = quote ? prettyAmount(fromBaseUnits(quote.outAmount, buyToken.decimals)) : '0';
  const rawImpact = Number(quote?.priceImpactPct);
  const priceImpact = Number.isFinite(rawImpact) ? Math.abs(rawImpact * 100) : null;
  const feePct = (SOLANA_PLATFORM_FEE_BPS / 100).toFixed(2);
  // The fee can only be collected on a pair touching SOL or USDC (pre-created
  // fee ATAs). Drive the UI off the SAME decision the quote/swap use.
  const feeMintForPair = isSolanaConfigured() ? pickFeeMint(payToken.mint, buyToken.mint) : null;
  const feeMintSymbol = feeMintForPair === USDC_MINT ? 'USDC' : feeMintForPair === SOL_MINT ? 'SOL' : null;
  const needsAck = payToken.verified === false || buyToken.verified === false;

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

  const actionDisabled = !quote || quoteLoading || swapping || sameToken || (needsAck && !ack);

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

          {/* You pay */}
          <div className="mb-1">
            <div className="flex items-center justify-between mb-2">
              <span className="text-white text-[11px]" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>You Pay</span>
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
            {sameToken && <p className="text-amber-300">Pick two different tokens.</p>}
            {quoteError && !sameToken && <p className="text-amber-300">{quoteError}</p>}
            {amount.trim() !== '' && !baseAmount && !sameToken && <p className="text-amber-300">Enter a valid amount.</p>}
          </div>

          {/* Unverified-token warning — warn, don't block (any pair is allowed). */}
          {needsAck && (
            <label
              className="flex items-start gap-2 mb-3 px-3 py-2.5 rounded-lg cursor-pointer"
              style={{ background: 'rgba(150,40,40,0.20)', border: '1px solid rgba(255,90,90,0.35)' }}
            >
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5 flex-shrink-0" />
              <span className="text-[11px] text-red-200">
                One of these tokens isn't verified on Jupiter — it could be a scam or have transfer restrictions
                (freeze authority / transfer fees). I understand and want to swap anyway.
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
              {swapping ? 'Swapping…' : quoteLoading ? 'Fetching quote…' : !baseAmount ? 'Enter an amount' : !quote ? 'No route' : `Buy ${buyToken.symbol}`}
            </button>
          )}

          <p className="mt-3 text-center text-white/40 text-[10px]">
            Swaps route through Jupiter on Solana. A {feePct}% platform fee applies on pairs that include SOL or USDC.
          </p>
        </div>
      </m.div>

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
