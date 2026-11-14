import { useState, useEffect } from 'react';
import { m } from 'framer-motion';
import { useLocation, useSearchParams } from 'react-router-dom';
import { usePageTitle } from '../hooks/usePageTitle';
import { trackPageView } from '../lib/analytics';
import { useSwapChainId } from '../hooks/useSwapChainId';
import { CHAIN_ID } from '../lib/constants';
import { DCATab } from '../components/swap/DCATab';
import { LimitOrderTab } from '../components/swap/LimitOrderTab';
import { EvmSwapPanel } from '../components/swap/EvmSwapPanel';
import { TwapOrderPanel } from '../components/swap/TwapOrderPanel';
import { TriggerOrderTab } from '../components/swap/TriggerOrderTab';
import { ChainSwitch } from '../components/swap/ChainSwitch';
import { ChainSwapAvailability } from '../components/swap/ChainSwapAvailability';
import { WrongChainBanner } from '../components/ui/WrongChainGuard';
import { ArtImg } from '../components/ArtImg';
import { useTabListKeys } from '../hooks/useTabListKeys';

type Tab = 'swap' | 'dca' | 'limit' | 'twap' | 'trigger';

// AUDIT FIX H-2 (2026-04-20 / battle-tested Option C): honest-UX labels. DCA is not
// on-chain — it persists in browser localStorage and runs only while the tab is open,
// so it reads "Recurring Swap" on the page rather than implying automated execution.
// AUDIT 2026-05-30 (mobile re-pass): shortened "Recurring Swap"→"DCA" — the longer
// label overflowed its tab button width at 390 px and collided with its neighbour.
// The titleByTab descriptions below keep the full name for clarity on the page.
//
// 2026-09-03: the 'limit' tab was labelled "Alerts" by that same pass, when it WAS a
// browser-only price watcher. It was rebuilt as a real on-chain CoW order (its own
// heading says "Limit Order"), while /alerts in the nav is a different product
// entirely — so "Alerts" here offered a signature for a live order, and anyone
// hunting the alert-rule store landed on a swap tab. One name per thing.
const TAB_LABELS: Record<Tab, string> = {
  swap: 'Swap',
  dca: 'DCA',
  limit: 'Limit',
  twap: 'TWAP',
  trigger: 'Trigger',
};

const VALID_TABS: Tab[] = ['swap', 'dca', 'limit', 'twap', 'trigger'];

// `?tab=limit` is canonical again, matching the tab's label and its heading.
// `?tab=alerts` — canonical while the tab was called "Alerts" — stays a silent
// synonym so links shared in that window keep resolving.
function tabFromQuery(v: string | null): Tab | null {
  if (!v) return null;
  if (v === 'alerts') return 'limit';
  return (VALID_TABS as string[]).includes(v) ? (v as Tab) : null;
}

// Resolve the active tab. ?tab= is the canonical knob.
//
// The /liquidity synonym is gone with the tab: that path routes to
// PoolsHostPage (App.tsx) and never reaches this component, so the branch was
// dead code claiming to handle a case it could not see.
function resolveInitialTab(searchParams: URLSearchParams): Tab {
  const q = tabFromQuery(searchParams.get('tab'));
  if (q) return q;
  return 'swap';
}

// ⌫ MOVED_TABS lived here, and an effect below redirected `?tab=liquidity` to
//   /liquidity from inside this page. That link is answered in App.tsx (SwapRoute)
//   now, before this chunk loads — see the note there for why this was the wrong place.

export default function TradePage() {
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState<Tab>(() => resolveInitialTab(searchParams));
  // Title follows the active tab so /liquidity reads "Liquidity" not "Trade".
  const titleByTab: Record<Tab, { title: string; desc: string }> = {
    // VOICE 2026-09-09: this read "Trade ETH ↔ TOWELI via Uniswap V2". It is the
    // og:description and the search-result line for /swap, on a page with no
    // arrival-voice gate at all, so the venue was introducing its swap surface
    // as one resident's pair — and understating it: the tab quotes the native
    // pair AND the routed aggregators, across more than one chain.
    swap:      { title: 'Swap',      desc: 'Swap tokens on the native DEX or across the routed aggregators, with custom slippage controls.' },
    // AUDIT FIX H-2: honest descriptions — these are browser-tab-only tools, not on-chain.
    dca:       { title: 'Recurring Swap', desc: 'Schedule reminders to buy TOWELI at regular intervals. Your wallet signs each swap \u2014 keep this tab open.' },
    // UPDATED 2026-07-19: CoW is now the PRIMARY path in this tab — a real
    // on-chain limit order that settles when the price is met and survives
    // closing the tab. "Price Alert / keep this tab open" described the
    // browser-only watcher, which is now the demoted secondary option.
    limit:     { title: 'Limit Order', desc: 'Set a price target. Places a real on-chain order via CoW Protocol that fills when the market reaches it — no need to keep this tab open.' },
    twap:      { title: 'TWAP', desc: 'Split a buy into equal slices over time via CoW Protocol — one signature, MEV-resistant. Requires a Safe smart-account wallet.' },
    // The description states the refusal, because the refusal is what this tab mostly
    // does today: only a stop-loss, from a Safe, on a pair with configured price feeds
    // has an executor that exists (CoW's watchtower). Every other kind — and every EOA
    // — needs the venue keeper, which is not built, so nothing is placed and the panel
    // says so. Do not soften this into "set automated exits".
    trigger:   { title: 'Trigger Order', desc: 'Build a stop-loss, take-profit, trailing stop or OCO exit — and read whether anything would actually watch it. An order is not armed unless a named executor exists for that exact order.' },
  };
  usePageTitle(titleByTab[tab].title, titleByTab[tab].desc);
  // The one short line under the heading. `desc` above stays the search-result and
  // og:description sentence; the tab's own panel carries its caveats.
  const lineByTab: Record<Tab, string> = {
    swap: 'Swap on the native DEX or across routed aggregators.',
    dca: 'Buy TOWELI on a schedule while this tab is open.',
    limit: 'An on-chain CoW order that fills at your price.',
    twap: 'Split a buy into slices over time. Needs a Safe wallet.',
    trigger: 'Build a stop-loss, take-profit, trailing stop or OCO exit.',
  };

  useEffect(() => { trackPageView('trade'); }, []);

  // Keep state in sync when the URL changes (Back/Forward, external links).
  // ?tab= is the only knob now that the path synonym is gone.
  useEffect(() => {
    const next = resolveInitialTab(searchParams);
    if (next !== tab) setTab(next);
  }, [location.pathname, searchParams, tab]);

  const handleTabChange = (next: Tab) => {
    setTab(next);
    const params = new URLSearchParams(searchParams);
    // Default tab (swap) uses the bare URL; others set ?tab= so the URL
    // is shareable. When the path is /liquidity (legacy deep-link), still
    // write ?tab= so the canonical query knob stays authoritative and
    // Back/Forward + sharing continues to work intuitively.
    // On /swap the bare URL means "swap", so drop the param for a clean link.
    // But on the /liquidity deep-link the PATH resolves to 'liquidity', so
    // deleting ?tab here made the sync effect bounce Swap straight back to
    // Liquidity (Swap was unreachable from /liquidity). Since ?tab wins over the
    // path in resolveInitialTab, writing ?tab=swap makes the switch stick.
    if (next === 'swap' && !location.pathname.startsWith('/liquidity')) params.delete('tab');
    else params.set('tab', next);
    setSearchParams(params, { replace: true });
  };

  // T10 (F205): WAI-ARIA tabs roving-focus + arrow-key navigation. Shared hook
  // adds the missing keyboard behaviour without restructuring the existing
  // tablist markup.
  const tabKeys = useTabListKeys(VALID_TABS, tab, handleTabChange);

  // The chain the Swap tab trades on: the wallet's, or `?c=` with no wallet.
  const swapChainId = useSwapChainId();

  return (
    <div className="-mt-14 relative min-h-screen">
      <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
        <ArtImg pageId="trade" idx={0} fallbackPosition="center 15%" alt="" loading="lazy" className="w-full h-full object-cover" />
      </div>

      <div className="relative z-10 max-w-[600px] mx-auto px-4 md:px-6 pt-20 pb-28 md:pb-12">
        <m.div className="mb-5" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
          <h1 className="heading-luxury text-2xl md:text-3xl text-white tracking-tight mb-1" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>{titleByTab[tab].title}</h1>
          <p className="text-white text-[13px]" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>{lineByTab[tab]}</p>
        </m.div>

        {/* Which chain — this surface is the Ethereum one, and the venue also
            trades on Solana. Without this the only route between the two was
            the "More" menu, which is why a Solana bungalow's "Trade" landed on
            an ETH swap that could not touch its token. */}
        <ChainSwitch />

        {/* Why this form is empty, when the network picked (else the wallet's) is
            one we serve but cannot swap on. Renders nothing on Ethereum and nothing on an
            unconfigured chain — the app-wide wrong-network banner owns that one.
            Placed ABOVE the tab strip on purpose: every tab under it (Liquidity,
            DCA, Limit, TWAP, Trigger) is pinned to mainnet by the same gate, so
            the explanation belongs to the surface, not to the swap tab. */}
        <ChainSwapAvailability chainId={swapChainId} swapTab={tab === 'swap'} />

        {/* The page follows the network picked; a wallet left on another one is told here.
            Swap signs on the page's network, and the other tabs on Ethereum only, so off
            Ethereum those tabs are ChainSwapAvailability's to explain, not this banner's. */}
        {(tab === 'swap' || swapChainId === CHAIN_ID) && (
          <WrongChainBanner
            requiredChainId={swapChainId}
            message="Your wallet is on another network. Switch it to trade here."
            className="mb-4"
          />
        )}

        {/* Tab Toggle */}
        <div
          role="tablist"
          aria-label="Trade view — swap, DCA, limit order, TWAP, or trigger order"
          onKeyDown={tabKeys.onKeyDown}
          className="flex gap-1.5 mb-6 p-1 rounded-2xl overflow-x-auto"
          // F521: bumped the bar background 0.4 -> 0.85 (matches the NFT-finance
          // section toggle) so the inactive Liquidity/DCA/Alerts labels stop
          // washing out white-on-light-art.
          style={{ background: 'rgba(13,21,48,0.85)', border: '1px solid rgba(255,255,255,0.20)' }}
        >
          {/* Rendered from VALID_TABS, not from a second literal. The list used to be
              spelled out again here, which meant the buttons and `useTabListKeys`
              (driven by VALID_TABS) could disagree — a tab present in one and absent
              from the other is either an unreachable panel or arrow-key navigation
              that lands on nothing. */}
          {VALID_TABS.map((t) => (
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
        {tab === 'swap' && <EvmSwapPanel chainId={swapChainId} page />}

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

        {/* TWAP Tab — CoW time-weighted order (self-contained). Self-gates to Safe
            smart-account wallets; shows an EOA the exact ComposableCoW calldata instead. */}
        {tab === 'twap' && (
          <m.div role="tabpanel" id="trade-panel-twap" aria-labelledby="trade-tab-twap" tabIndex={0} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="relative glass-card rounded-2xl overflow-hidden outline-none" style={{ border: '1px solid var(--color-purple-12)' }}>
            <div className="absolute inset-0 pointer-events-none" aria-hidden="true">
              <ArtImg pageId="trade" idx={2} alt="" className="w-full h-full object-cover opacity-100" loading="lazy" />
            </div>
            <div className="relative">
              <TwapOrderPanel />
            </div>
          </m.div>
        )}

        {/* Trigger Tab — stop-loss / take-profit / trailing stop / OCO. Self-contained
            and self-gating like the TWAP panel above, but the gate is harder: only a
            stop-loss, from a Safe, on a pair with configured feeds has a real executor
            (CoW's watchtower). Everything else needs the venue keeper, which is not
            built, so `triggerArmState` reports "Not armed" with the reason and the
            submit button reads "Not armed yet". Mounting it does not arm anything. */}
        {tab === 'trigger' && (
          <m.div role="tabpanel" id="trade-panel-trigger" aria-labelledby="trade-tab-trigger" tabIndex={0} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="relative glass-card rounded-2xl overflow-hidden outline-none" style={{ border: '1px solid var(--color-purple-12)' }}>
            <div className="absolute inset-0 pointer-events-none" aria-hidden="true">
              <ArtImg pageId="trade" idx={3} alt="" className="w-full h-full object-cover opacity-100" loading="lazy" />
            </div>
            <div className="relative">
              <TriggerOrderTab />
            </div>
          </m.div>
        )}
      </div>
    </div>
  );
}
