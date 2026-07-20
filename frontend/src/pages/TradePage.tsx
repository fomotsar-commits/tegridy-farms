import { useState, useEffect, useMemo } from 'react';
import { m } from 'framer-motion';
import { useLocation, useSearchParams } from 'react-router-dom';
import { useAccount, useChainId } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { getTxUrl } from '../lib/explorer';
import { usePageTitle } from '../hooks/usePageTitle';
import { trackPageView } from '../lib/analytics';
import { useSwap } from '../hooks/useSwap';
import { useTOWELIPriceOptional } from '../contexts/PriceContext';
import { formatTokenAmountGrouped, formatBalance } from '../lib/formatting';
import { computeRouteSavings, aggOutUnits } from '../lib/routeSavings';
import { DCATab } from '../components/swap/DCATab';
import { LimitOrderTab } from '../components/swap/LimitOrderTab';
import { LiquidityTab } from '../components/swap/LiquidityTab';
import { MevProtectionPanel } from '../components/swap/MevProtectionPanel';
import { TokenSelectModal } from '../components/swap/TokenSelectModal';
import { ArtImg } from '../components/ArtImg';
import { useTowelie } from '../hooks/useTowelie';
import { useTabListKeys } from '../hooks/useTabListKeys';

type Tab = 'swap' | 'liquidity' | 'dca' | 'limit';

/**
 * Truncate to 6dp, never round up. The 50%/MAX quick-fills previously used
 * `Number(x.toFixed(6))`, which rounds HALF-UP — so for any balance whose 7th
 * decimal rounds up (common with 18-decimal tokens) MAX produced an amount
 * ABOVE the wallet balance, which fails the balance check and disables the
 * Swap button. Flooring can only ever under-fill, which is safe.
 */
const floor6 = (n: number): number => Math.floor(n * 1e6) / 1e6;

// AUDIT FIX H-2 (2026-04-20 / battle-tested Option C): honest-UX labels. The DCA and
// Limit Order features are not on-chain — they persist in browser localStorage and
// run only while the tab is open. Renaming to "Recurring Swap" / "Price Alert" makes
// the actual behaviour legible without falsely implying automated execution.
// AUDIT 2026-05-30 (mobile re-pass): shortened "Recurring Swap"→"DCA" and
// "Price Alert"→"Alerts" — the longer labels overflowed their tab button widths
// at 390 px and visually collided ("Recurring Swa**P**rice Alert"). The
// titleByTab descriptions below keep the full names for clarity on the page.
const TAB_LABELS: Record<Tab, string> = {
  swap: 'Swap',
  liquidity: 'Liquidity',
  dca: 'DCA',
  limit: 'Alerts',
};

const VALID_TABS: Tab[] = ['swap', 'liquidity', 'dca', 'limit'];

// F242: the Alerts feature is named three ways (tab label "Alerts", heading
// "Price Alert", internal tab 'limit'). `?tab=alerts` is the canonical,
// honesty-pass-aligned param; `?tab=limit` is kept as a legacy synonym so old
// shared links keep working.
function tabFromQuery(v: string | null): Tab | null {
  if (!v) return null;
  if (v === 'alerts') return 'limit';
  return (VALID_TABS as string[]).includes(v) ? (v as Tab) : null;
}

// Resolve the active tab. ?tab= is the canonical knob; the legacy
// /liquidity path is treated as a synonym for ?tab=liquidity, overridden
// by an explicit ?tab= when both are present.
function resolveInitialTab(pathname: string, searchParams: URLSearchParams): Tab {
  const q = tabFromQuery(searchParams.get('tab'));
  if (q) return q;
  if (pathname.startsWith('/liquidity')) return 'liquidity';
  return 'swap';
}

export default function TradePage() {
  const { isConnected } = useAccount();
  const chainId = useChainId();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState<Tab>(() => resolveInitialTab(location.pathname, searchParams));
  // Title follows the active tab so /liquidity reads "Liquidity" not "Trade".
  const titleByTab: Record<Tab, { title: string; desc: string }> = {
    swap:      { title: 'Swap',      desc: 'Trade ETH ↔ TOWELI via Uniswap V2 with custom slippage controls.' },
    liquidity: { title: 'Liquidity', desc: 'Add or remove liquidity on Tegridy Farms native pools.' },
    // AUDIT FIX H-2: honest descriptions — these are browser-tab-only tools, not on-chain.
    dca:       { title: 'Recurring Swap', desc: 'Schedule reminders to buy TOWELI at regular intervals. Your wallet signs each swap \u2014 keep this tab open.' },
    // UPDATED 2026-07-19: CoW is now the PRIMARY path in this tab — a real
    // on-chain limit order that settles when the price is met and survives
    // closing the tab. "Price Alert / keep this tab open" described the
    // browser-only watcher, which is now the demoted secondary option.
    limit:     { title: 'Limit Order', desc: 'Set a price target. Places a real on-chain order via CoW Protocol that fills when the market reaches it — no need to keep this tab open.' },
  };
  usePageTitle(titleByTab[tab].title, titleByTab[tab].desc);
  const [showTokenSelect, setShowTokenSelect] = useState<'from' | 'to' | null>(null);
  const [showRouteDetails, setShowRouteDetails] = useState(false);
  // F190: the custom-slippage field keeps its OWN string state while focused so
  // a fractional value (0.3, 3.5) can be typed without each keystroke being
  // round-tripped through swap.slippage.toFixed(2) (which collapsed "0.3" back
  // to "0.00"). Committed/clamped on change-when-valid; re-synced from
  // swap.slippage only while the field is NOT focused. Mirrors DCATab's pattern.
  const [slippageFieldFocused, setSlippageFieldFocused] = useState(false);
  const [slippageFieldStr, setSlippageFieldStr] = useState('');

  useEffect(() => { trackPageView('trade'); }, []);

  // Keep state in sync when the URL changes (Back/Forward, external links).
  // ?tab= wins; path is only consulted when ?tab= is absent.
  useEffect(() => {
    const next = resolveInitialTab(location.pathname, searchParams);
    if (next !== tab) setTab(next);
  }, [location.pathname, searchParams, tab]);

  const handleTabChange = (next: Tab) => {
    setTab(next);
    const params = new URLSearchParams(searchParams);
    // Default tab (swap) uses the bare URL; others set ?tab= so the URL
    // is shareable. When the path is /liquidity (legacy deep-link), still
    // write ?tab= so the canonical query knob stays authoritative and
    // Back/Forward + sharing continues to work intuitively.
    if (next === 'swap') params.delete('tab');
    // F242: write the canonical `?tab=alerts` for the Alerts (internal 'limit') tab.
    else params.set('tab', next === 'limit' ? 'alerts' : next);
    setSearchParams(params, { replace: true });
  };

  // T10 (F205): WAI-ARIA tabs roving-focus + arrow-key navigation. Shared hook
  // adds the missing keyboard behaviour without restructuring the existing
  // tablist markup.
  const tabKeys = useTabListKeys(VALID_TABS, tab, handleTabChange);

  const swap = useSwap();

  // Best-effort USD estimate under the pay/receive amounts. ETH/WETH via ethUsd, TOWELI via
  // priceInUsd; returns null (line hidden, never "$0.00") for unpriced tokens or missing data.
  const priceCtx = useTOWELIPriceOptional();
  const usdFor = (token: { isNative?: boolean; symbol?: string } | null | undefined, amountStr: string | undefined) => {
    const amt = Number(amountStr);
    if (!priceCtx || !token || !Number.isFinite(amt) || amt <= 0) return null;
    const unit = token.isNative ? priceCtx.ethUsd : (token.symbol === 'TOWELI' ? priceCtx.priceInUsd : null);
    if (!unit || !Number.isFinite(unit) || unit <= 0) return null;
    return amt * unit;
  };
  const payUsd = usdFor(swap.fromToken, swap.inputAmount);
  const receiveUsd = usdFor(swap.toToken, swap.outputFormatted);

  // F226/F227/F235/F196: aggregator `amountOut` is WEI while the on-chain
  // outputs are human token amounts — normalize before comparing/displaying.
  // The pure math lives in `computeRouteSavings` (unit-tested): it also excludes
  // degenerate-low (near-empty native pool) venues from the savings denominator
  // and clamps the result so it can never render scientific notation.
  const toDecimals = swap.toToken?.decimals ?? 18;
  const tegridyOutputNum = swap.hasTegridyPair && swap.tegridyOutputFormatted
    ? parseFloat(swap.tegridyOutputFormatted)
    : null;

  const { savingsPct: routeSavingsPct, tegridyIsLowLiquidity } = useMemo(
    () =>
      computeRouteSavings({
        tegridyOutput: tegridyOutputNum,
        uniOutput: swap.uniOutputFormatted ? parseFloat(swap.uniOutputFormatted) : null,
        aggQuotes: swap.allAggQuotes ?? [],
        toDecimals,
      }),
    [tegridyOutputNum, swap.uniOutputFormatted, swap.allAggQuotes, toDecimals],
  );

  // F196: the "Compare all N routes" count must reflect the rows that actually
  // render (the Tegridy + Uniswap rows are conditional), not a hardcoded +2.
  const routeRowCount = useMemo(
    () =>
      (swap.allAggQuotes?.length ?? 0) +
      (swap.hasTegridyPair && swap.tegridyOutputFormatted ? 1 : 0) +
      (swap.uniOutputFormatted ? 1 : 0),
    [swap.allAggQuotes, swap.hasTegridyPair, swap.tegridyOutputFormatted, swap.uniOutputFormatted],
  );

  // Towelie nudge: warn before user fires a swap with high price impact.
  // Urgent so it jumps the queue. Dedup `key` so we don't spam every tick;
  // when impact drops back under 5% the dedup naturally clears once consumed.
  const { say } = useTowelie();
  useEffect(() => {
    if (tab !== 'swap') return;
    if (swap.priceImpact > 5) {
      say(`Price impact is ${swap.priceImpact.toFixed(1)}%. You sure?`, { priority: 'urgent', key: 'high-price-impact' });
    }
  }, [tab, swap.priceImpact, say]);

  const handleTokenSelect = (token: typeof swap.fromToken) => {
    if (!token) return;
    if (showTokenSelect === 'from') swap.setFromToken(token);
    else if (showTokenSelect === 'to') swap.setToToken(token);
    setShowTokenSelect(null);
  };

  return (
    <div className="-mt-14 relative min-h-screen">
      <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
        <ArtImg pageId="trade" idx={0} fallbackPosition="center 15%" alt="" loading="lazy" className="w-full h-full object-cover" />
      </div>

      <div className="relative z-10 max-w-[600px] mx-auto px-4 md:px-6 pt-20 pb-28 md:pb-12">
        <m.div className="mb-5" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
          <h1 className="heading-luxury text-2xl md:text-3xl text-white tracking-tight mb-1" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>{titleByTab[tab].title}</h1>
          <p className="text-white text-[13px]" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>{titleByTab[tab].desc}</p>
        </m.div>

        {/* Tab Toggle */}
        <div
          role="tablist"
          aria-label="Trade view — swap, liquidity, DCA, or limit order"
          onKeyDown={tabKeys.onKeyDown}
          className="flex gap-1.5 mb-6 p-1 rounded-2xl overflow-x-auto"
          // F521: bumped the bar background 0.4 -> 0.85 (matches the NFT-finance
          // section toggle) so the inactive Liquidity/DCA/Alerts labels stop
          // washing out white-on-light-art.
          style={{ background: 'rgba(13,21,48,0.85)', border: '1px solid rgba(255,255,255,0.20)' }}
        >
          {(['swap', 'liquidity', 'dca', 'limit'] as Tab[]).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              id={`trade-tab-${t}`}
              aria-selected={tab === t}
              aria-controls={`trade-panel-${t}`}
              tabIndex={tabKeys.tabIndex(t)}
              ref={tabKeys.ref(t)}
              onClick={() => handleTabChange(t)}
              className="flex-1 px-3 md:px-4 py-2.5 min-h-[44px] rounded-xl text-[13px] md:text-sm font-medium transition-all whitespace-nowrap text-white"
              style={tab === t ? {
                background: 'var(--color-stan)',
                boxShadow: '0 4px 12px var(--color-stan-40)',
              } : { textShadow: '0 1px 4px rgba(0,0,0,0.85)' }}
            >
              {TAB_LABELS[t]}
            </button>
          ))}
        </div>

        {/* Swap Tab */}
        {tab === 'swap' && (
          <m.div role="tabpanel" id="trade-panel-swap" aria-labelledby="trade-tab-swap" tabIndex={0} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="relative glass-card rounded-2xl overflow-hidden outline-none" style={{ border: '1px solid var(--color-purple-12)' }}>
            <div className="absolute inset-0 pointer-events-none" aria-hidden="true">
              <ArtImg pageId="trade" idx={1} fallbackPosition="center 15%" alt="" className="w-full h-full object-cover opacity-100" loading="lazy" />
            </div>
            <div className="relative p-5 flex flex-col min-h-[640px]">
            {/* T7: the swap form (incl. live quotes) renders for everyone — every
                quote read is public RPC, no wallet needed. Only the action button
                gates on connect, so a visitor can price a swap before connecting. */}
            <>
                {/* AUDIT FIX FE-HIGH-6: permanent unverified-token banner.
                    Custom tokens (anything not in DEFAULT_TOKENS) get a
                    sticky reminder above the swap form so the user is
                    re-warned every session, not just at import time. */}
                {(swap.isFromTokenCustom || swap.isToTokenCustom) && (
                  <div className="mb-3 px-3 py-2 rounded-lg flex items-start gap-2"
                    style={{ background: 'rgba(255,178,55,0.10)', border: '1px solid rgba(255,178,55,0.35)' }}
                    role="alert">
                    <span className="text-warning text-[14px] leading-none mt-0.5" aria-hidden="true">&#9888;</span>
                    <div className="text-warning text-[11px] leading-snug">
                      <strong className="font-semibold">Unverified token</strong>
                      {' — '}
                      {[
                        swap.isFromTokenCustom ? swap.fromToken?.symbol : null,
                        swap.isToTokenCustom ? swap.toToken?.symbol : null,
                      ].filter(Boolean).join(' / ')}
                      {' '}
                      is not on the default token list. Approvals are restricted to exact-amount; double-check the contract on Etherscan before swapping.
                    </div>
                  </div>
                )}

                {/* From Token */}
                <div className="mb-5">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-white text-[11px]" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>You Pay</span>
                    <span className="flex items-center gap-1.5 text-[10px] font-mono">
                      <span className="text-white" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>Balance: {formatBalance(swap.fromBalance)}</span>
                      {Number(swap.fromBalance) > 0 && (
                        <>
                          <button
                            type="button"
                            /* floor6, not toFixed: toFixed rounds HALF-UP, which for
                               many balances produces an amount ABOVE the wallet
                               balance and disables the Swap button. */
                            onClick={() => { const b = Number(swap.fromBalance) || 0; if (b > 0) swap.setInputAmount(String(floor6(b * 0.5))); }}
                            className="px-1.5 py-0.5 rounded bg-white/10 hover:bg-white/20 text-white/90 transition-colors"
                          >50%</button>
                          <button
                            type="button"
                            /* Reserve a little native ETH for gas so a MAX swap never leaves the user unable to pay for it. */
                            onClick={() => { const b = Number(swap.fromBalance) || 0; const amt = swap.fromToken?.isNative ? Math.max(0, b - 0.002) : b; if (amt > 0) swap.setInputAmount(String(floor6(amt))); }}
                            className="px-1.5 py-0.5 rounded bg-white/10 hover:bg-white/20 text-white/90 transition-colors"
                          >MAX</button>
                        </>
                      )}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 rounded-xl p-3" style={{ background: 'rgba(0,0,0,0.75)', border: '1px solid rgba(255,255,255,0.22)' }}>
                    <button
                      type="button"
                      onClick={() => setShowTokenSelect('from')}
                      aria-label={`Change token to pay with (currently ${swap.fromToken?.symbol ?? 'none selected'})`}
                      aria-haspopup="dialog"
                      className="flex items-center gap-2 px-3 py-1.5 rounded-lg min-h-[36px] hover:bg-white/5 transition-colors"
                    >
                      {swap.fromToken?.logoURI && <img src={swap.fromToken.logoURI} alt="" className="w-5 h-5 rounded-full" />}
                      <span className="text-white font-medium text-[14px]">{swap.fromToken?.symbol ?? 'Select'}</span>
                      <span className="text-white/80" aria-hidden="true">▾</span>
                    </button>
                    <input
                      type="number" inputMode="decimal" placeholder="0.0"
                      aria-label={`Amount of ${swap.fromToken?.symbol ?? 'selected token'} to pay`}
                      value={swap.inputAmount} onChange={(e) => swap.setInputAmount(e.target.value)}
                      className="flex-1 bg-transparent text-right text-white text-[20px] font-mono outline-none min-w-0"
                    />
                  </div>
                  {payUsd != null && (
                    <div className="text-right text-white/55 text-[10px] font-mono mt-1" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>≈ ${payUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}</div>
                  )}
                </div>

                {/* Flip Button — solid Stan blue + thick white ring so it pops
                    against any art the Swap card is layered over. */}
                <div className="flex justify-center -my-2 relative z-10">
                  <button onClick={swap.flipDirection}
                    aria-label="Swap From/To tokens"
                    className="w-11 h-11 rounded-full flex items-center justify-center transition-all"
                    style={{
                      background: 'var(--color-stan)',
                      border: '2px solid rgba(255,255,255,0.95)',
                      boxShadow: '0 4px 16px rgba(0,0,0,0.70), 0 0 0 4px rgba(6,12,26,0.85)',
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.transform = 'rotate(180deg) scale(1.05)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.transform = 'rotate(0deg) scale(1)'; }}
                  >
                    <span className="text-white text-[18px] font-bold leading-none">&#8645;</span>
                  </button>
                </div>

                {/* To Token */}
                <div className="mb-5">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-white text-[11px]" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>You Receive</span>
                    <span className="text-white text-[10px] font-mono" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>Balance: {formatBalance(swap.toBalance)}</span>
                  </div>
                  <div className="flex items-center gap-3 rounded-xl p-3" style={{ background: 'rgba(0,0,0,0.75)', border: '1px solid rgba(255,255,255,0.22)' }}>
                    <button
                      type="button"
                      onClick={() => setShowTokenSelect('to')}
                      aria-label={`Change token to receive (currently ${swap.toToken?.symbol ?? 'none selected'})`}
                      aria-haspopup="dialog"
                      className="flex items-center gap-2 px-3 py-1.5 rounded-lg min-h-[36px] hover:bg-white/5 transition-colors"
                    >
                      {swap.toToken?.logoURI && <img src={swap.toToken.logoURI} alt="" className="w-5 h-5 rounded-full" />}
                      <span className="text-white font-medium text-[14px]">{swap.toToken?.symbol ?? 'Select'}</span>
                      <span className="text-white/80" aria-hidden="true">▾</span>
                    </button>
                    <div
                      className="flex-1 text-right text-white text-[20px] font-mono font-medium"
                      // F205: announce quote updates to assistive tech as they settle.
                      aria-live="polite"
                      aria-atomic="true"
                      aria-label={`You receive ${swap.outputFormatted || '0'} ${swap.toToken?.symbol ?? ''}`}
                    >
                      {swap.isQuoteLoading ? (
                        // F207: skeleton shimmer instead of a bare "..." while the quote loads.
                        <span className="inline-block w-24 h-5 rounded align-middle animate-pulse" style={{ background: 'rgba(255,255,255,0.18)' }} aria-label="Loading quote" />
                      ) : swap.outputFormatted ? formatTokenAmountGrouped(swap.outputFormatted) : '0.0'}
                    </div>
                  </div>
                  {receiveUsd != null && (
                    <div className="text-right text-white/55 text-[10px] font-mono mt-1" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>≈ ${receiveUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}</div>
                  )}
                </div>

                {/* Slippage tolerance — always visible so users can see + adjust
                    before a quote loads. Fills the empty mid-card space.
                    swap.slippage is a percent (0-20), not bps.
                    AUDIT TRADE-UX: added a Custom input so users who need 0.3%
                    or 3.5% aren't forced to pick one of 4 presets. The input
                    is highlighted whenever the current value doesn't match a
                    preset, so "custom" isn't a separate mode — it's just a
                    free-form override. Clamped to 0-20% to match useSwap. */}
                <div className="mt-1 mb-1 px-3 py-2.5 rounded-lg" style={{ background: 'rgba(0,0,0,0.60)', border: '1px solid rgba(255,255,255,0.12)' }}>
                  <div className="flex items-center justify-between mb-1.5">
                    <label htmlFor="slippage-custom" className="text-white text-[11px] cursor-pointer" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>Slippage tolerance</label>
                    <span className="text-white/80 text-[10px] font-mono">{swap.slippage.toFixed(2)}%</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {[0.1, 0.5, 1.0, 2.0].map(pct => {
                      const active = Math.abs(swap.slippage - pct) < 0.001;
                      return (
                        <button key={pct} onClick={() => swap.setSlippage(pct)} aria-pressed={active}
                          className="flex-1 py-1.5 min-h-[34px] rounded-lg text-[11px] font-medium transition-all text-white"
                          style={{
                            background: active ? 'var(--color-stan)' : 'rgba(0,0,0,0.45)',
                            border: active ? '1px solid var(--color-stan)' : '1px solid rgba(255,255,255,0.12)',
                          }}>
                          {pct.toFixed(1)}%
                        </button>
                      );
                    })}
                    {(() => {
                      const isPreset = [0.1, 0.5, 1.0, 2.0].some(p => Math.abs(swap.slippage - p) < 0.001);
                      return (
                        <div className="flex items-center gap-1 py-1.5 px-2 min-h-[34px] rounded-lg"
                          style={{
                            background: isPreset ? 'rgba(0,0,0,0.45)' : 'var(--color-stan)',
                            border: isPreset ? '1px solid rgba(255,255,255,0.12)' : '1px solid var(--color-stan)',
                          }}
                        >
                          <input
                            id="slippage-custom"
                            type="number"
                            inputMode="decimal"
                            step="0.1"
                            min={0}
                            max={20}
                            // F190: while focused, render the user's raw keystrokes so
                            // partial fractions (0., 0.3) survive; while blurred, mirror
                            // swap.slippage (blank when a preset is active).
                            value={slippageFieldFocused ? slippageFieldStr : (isPreset ? '' : swap.slippage.toFixed(2))}
                            placeholder="Custom"
                            aria-label="Custom slippage tolerance percent"
                            onFocus={() => {
                              setSlippageFieldFocused(true);
                              setSlippageFieldStr(isPreset ? '' : swap.slippage.toFixed(2));
                            }}
                            onChange={(e) => {
                              const raw = e.target.value;
                              setSlippageFieldStr(raw);
                              if (raw === '') return;
                              const n = parseFloat(raw);
                              if (Number.isFinite(n)) {
                                // Clamp to useSwap's own 0-20% envelope. The string
                                // state still holds the raw text so the decimal can
                                // be completed.
                                swap.setSlippage(Math.max(0, Math.min(20, n)));
                              }
                            }}
                            onBlur={() => {
                              setSlippageFieldFocused(false);
                              const n = parseFloat(slippageFieldStr);
                              if (Number.isFinite(n)) {
                                swap.setSlippage(Math.max(0, Math.min(20, n)));
                              }
                            }}
                            className="w-14 bg-transparent text-center text-[11px] text-white font-mono outline-none"
                          />
                          <span className="text-[11px] text-white/80">%</span>
                        </div>
                      );
                    })()}
                  </div>
                  {swap.slippage >= 5 && (
                    <p className="mt-1.5 text-[10px] text-amber-300" style={{ textShadow: '0 1px 3px rgba(0,0,0,0.8)' }}>
                      High slippage tolerance — you may receive significantly less than quoted.
                    </p>
                  )}
                </div>

                {/* AUDIT M-6: Fee-on-Transfer opt-in toggle. Off by default; auto-enabled on
                    InsufficientOutput reverts via the useSwap error handler. Users can also
                    flip it manually for known FoT/reflection/deflationary tokens. */}
                <div className="mt-1 mb-1 px-3 py-2.5 rounded-lg" style={{ background: 'rgba(0,0,0,0.60)', border: '1px solid rgba(255,255,255,0.12)' }}>
                  <label className="flex items-center justify-between cursor-pointer">
                    <span className="text-white text-[11px]" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>
                      Fee-on-transfer support
                    </span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={swap.supportsFeeOnTransfer}
                      onClick={() => swap.setSupportsFeeOnTransfer(!swap.supportsFeeOnTransfer)}
                      className="relative inline-flex items-center h-5 rounded-full w-10 transition-colors"
                      style={{
                        background: swap.supportsFeeOnTransfer ? 'var(--color-stan)' : 'rgba(255,255,255,0.2)',
                      }}
                    >
                      <span
                        className="inline-block w-3.5 h-3.5 rounded-full bg-white transition-transform"
                        style={{
                          transform: swap.supportsFeeOnTransfer ? 'translateX(22px)' : 'translateX(4px)',
                        }}
                      />
                    </button>
                  </label>
                  <p className="mt-1 text-[10px] text-white/70" style={{ textShadow: '0 1px 3px rgba(0,0,0,0.8)' }}>
                    Enable for tokens with an internal transfer fee (reflection / deflationary). Auto-enabled on retry after insufficient-output reverts.
                  </p>
                </div>

                {/* MEV protection — one-time, user-confirmed opt-in to MEV Blocker's
                    protected RPC. Additive; does not touch the audited swap path. */}
                <MevProtectionPanel />

                {/* Route Info — dark panel with Stan blue edge for trading-trust signal.
                    Always renders; shows placeholder text when no amount entered so the
                    card never feels empty mid-swap. */}
                {swap.routeLabel && swap.inputAmount ? (
                  <div className="mt-1 px-3 py-2.5 rounded-lg text-[11px]" style={{ background: 'rgba(0,0,0,0.60)', border: '1px solid var(--color-stan-40)' }}>
                    <div className="flex justify-between">
                      <span className="text-white">Route</span>
                      <span className="font-medium" style={{ color: 'var(--color-stan)' }}>{swap.routeLabel}</span>
                    </div>
                    {routeSavingsPct >= 0.05 && (
                      <div className="flex justify-between mt-1">
                        <span className="text-white">Route Savings</span>
                        <span className="font-mono text-emerald-300">+{routeSavingsPct >= 999 ? '>999' : routeSavingsPct.toFixed(2)}% vs worst venue</span>
                      </div>
                    )}
                    {swap.priceImpact > 0 && (
                      <div className="flex justify-between mt-1">
                        <span className="text-white">Price Impact</span>
                        <span className={`font-mono ${swap.priceImpact > 3 ? 'text-red-300 font-semibold' : 'text-white'}`}>{swap.priceImpact.toFixed(2)}%</span>
                      </div>
                    )}
                    {swap.minimumReceived && (
                      <div className="flex justify-between mt-1">
                        <span className="text-white">Min. Received</span>
                        <span className="text-white font-mono">{formatTokenAmountGrouped(swap.minimumReceived)} {swap.toToken?.symbol}</span>
                      </div>
                    )}
                    {swap.priceImpact > 5 && (
                      <div className="mt-2 px-2 py-1.5 rounded text-[10px] text-red-200 font-semibold" style={{ background: 'rgba(239,68,68,0.25)', border: '1px solid rgba(239,68,68,0.45)' }}>
                        High price impact! Consider reducing your trade size.
                      </div>
                    )}
                    {swap.allAggQuotes && swap.allAggQuotes.length > 0 && (
                      <div className="mt-2">
                        <button onClick={() => setShowRouteDetails(!showRouteDetails)}
                          className="text-[10px] text-white/90 hover:text-white underline underline-offset-2 transition-colors">
                          {showRouteDetails ? 'Hide route details' : `Compare all ${routeRowCount} routes`}
                        </button>
                        {showRouteDetails && (
                          <div className="mt-2 space-y-1">
                            {swap.hasTegridyPair && swap.tegridyOutputFormatted && (
                              <div className="flex justify-between text-[10px] px-2 py-1 rounded" style={{ background: swap.selectedRoute === 'tegridy' ? 'rgba(16,185,129,0.20)' : 'rgba(255,255,255,0.04)' }}>
                                <span className="text-white/85">
                                  Tegridy DEX {swap.selectedRoute === 'tegridy' && <span className="text-emerald-300 ml-1">Best</span>}
                                  {tegridyIsLowLiquidity && <span className="text-amber-300 ml-1" title="The native pool is thin pre-seed — its quote isn't representative yet.">low liquidity</span>}
                                </span>
                                <span className="text-white font-mono">{formatTokenAmountGrouped(swap.tegridyOutputFormatted)}</span>
                              </div>
                            )}
                            {swap.uniOutputFormatted && (
                              <div className="flex justify-between text-[10px] px-2 py-1 rounded" style={{ background: swap.selectedRoute === 'uniswap' ? 'rgba(16,185,129,0.20)' : 'rgba(255,255,255,0.04)' }}>
                                <span className="text-white/85">Uniswap V2 {swap.selectedRoute === 'uniswap' && <span className="text-emerald-300 ml-1">Best</span>}</span>
                                <span className="text-white font-mono">{formatTokenAmountGrouped(swap.uniOutputFormatted)}</span>
                              </div>
                            )}
                            {/* F227: aggregator amountOut is WEI — normalize to token units before formatting. */}
                            {swap.allAggQuotes.map((q: { source: string; amountOut: string }) => (
                              <div key={q.source} className="flex justify-between text-[10px] px-2 py-1 rounded"
                                style={{ background: swap.selectedRoute === 'aggregator' && swap.bestAggregatorName === q.source ? 'rgba(16,185,129,0.20)' : 'rgba(255,255,255,0.04)' }}>
                                <span className="text-white/85">{q.source} {swap.selectedRoute === 'aggregator' && swap.bestAggregatorName === q.source && <span className="text-emerald-300 ml-1">Best</span>}</span>
                                <span className="text-white font-mono">{formatTokenAmountGrouped(aggOutUnits(q.amountOut, toDecimals))}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="mt-1 px-3 py-2.5 rounded-lg text-[11px]" style={{ background: 'rgba(0,0,0,0.50)', border: '1px solid rgba(255,255,255,0.10)' }}>
                    <div className="flex justify-between text-white/70">
                      <span>Route</span>
                      <span>Enter an amount</span>
                    </div>
                    <div className="flex justify-between text-white/70 mt-1">
                      <span>Price Impact</span>
                      <span>&mdash;</span>
                    </div>
                    <div className="flex justify-between text-white/70 mt-1">
                      <span>Min. Received</span>
                      <span>&mdash;</span>
                    </div>
                  </div>
                )}

                {/* Spacer — pushes the action button to the bottom of the tall card. */}
                <div className="flex-1 min-h-[8px]" />

                {/* Action Button — sits directly on the art, matching the Liquidity tab's pattern.
                    T7: gated on connect — a disconnected visitor sees the live quote above
                    and a Connect CTA here instead of the Approve/Swap actions. */}
                {!isConnected ? (
                  <div className="w-full flex flex-col items-center gap-2">
                    <ConnectButton />
                    <span className="text-white/70 text-[11px]" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>Connect your wallet to swap</span>
                  </div>
                ) : swap.needsApproval ? (
                  <button onClick={swap.approve} disabled={swap.isPending}
                    className="w-full btn-primary py-3 min-h-[48px] text-[15px] font-semibold rounded-xl"
                  >
                    {swap.isPending ? 'Approving...' : `Approve ${swap.fromToken?.symbol}`}
                  </button>
                ) : (
                  <button onClick={swap.executeSwap}
                    disabled={swap.isPending || swap.isConfirming || swap.insufficientBalance || !swap.inputAmount || swap.outputAmount === 0n}
                    className="w-full btn-primary py-3 min-h-[48px] text-[15px] font-semibold rounded-xl disabled:opacity-40"
                  >
                    {swap.isPending ? 'Confirm in wallet...' : swap.isConfirming ? 'Confirming...' : swap.insufficientBalance ? 'Insufficient balance' : 'Swap'}
                  </button>
                )}

                {swap.isSuccess && swap.txHash && (
                  <div className="mt-3 text-center text-emerald-400 text-[12px]">
                    Swap confirmed! <a href={getTxUrl(chainId, swap.txHash)} target="_blank" rel="noopener noreferrer" className="underline">View on Explorer</a>
                  </div>
                )}
            </>
            </div>
          </m.div>
        )}

        {/* Liquidity Tab */}
        {tab === 'liquidity' && (
          <m.div role="tabpanel" id="trade-panel-liquidity" aria-labelledby="trade-tab-liquidity" tabIndex={0} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="glass-card rounded-2xl overflow-hidden outline-none" style={{ border: '1px solid var(--color-purple-12)' }}>
            <LiquidityTab />
          </m.div>
        )}

        {/* DCA Tab */}
        {tab === 'dca' && (
          <m.div role="tabpanel" id="trade-panel-dca" aria-labelledby="trade-tab-dca" tabIndex={0} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="relative glass-card rounded-2xl overflow-hidden outline-none" style={{ border: '1px solid var(--color-purple-12)' }}>
            <div className="absolute inset-0 pointer-events-none" aria-hidden="true">
              <ArtImg pageId="trade" idx={2} alt="" className="w-full h-full object-cover opacity-100" loading="lazy" />
            </div>
            <div className="relative">
              <DCATab />
            </div>
          </m.div>
        )}

        {/* Limit Order Tab */}
        {tab === 'limit' && (
          <m.div role="tabpanel" id="trade-panel-limit" aria-labelledby="trade-tab-limit" tabIndex={0} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="relative glass-card rounded-2xl overflow-hidden outline-none" style={{ border: '1px solid var(--color-purple-12)' }}>
            <div className="absolute inset-0 pointer-events-none" aria-hidden="true">
              <ArtImg pageId="trade" idx={3} alt="" className="w-full h-full object-cover opacity-100" loading="lazy" />
            </div>
            <div className="relative">
              <LimitOrderTab />
            </div>
          </m.div>
        )}
      </div>

      {/* Token Select Modal */}
      {showTokenSelect && (
        <TokenSelectModal
          open={true}
          onSelect={handleTokenSelect}
          onClose={() => setShowTokenSelect(null)}
          disabledAddress={showTokenSelect === 'from' ? swap.toToken?.address : swap.fromToken?.address}
          customTokens={swap.customTokens}
          onAddCustomToken={swap.addCustomToken}
        />
      )}
    </div>
  );
}
