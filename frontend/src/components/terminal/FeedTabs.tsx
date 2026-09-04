import { GECKO_NETWORKS, type GeckoNetwork } from '../../lib/geckoTerminal/pools';
import { NETWORK_LABEL } from '../../lib/terminal/feedBanner';
import { terminalSourceReadiness } from '../../lib/terminal/feedSources';
import type { TerminalView } from '../../lib/terminal/terminalParams';
import { useTabListKeys } from '../../hooks/useTabListKeys';

// The two axes of this page: which chain, and which list.
//
// THE VENUE-PAIRS TAB IS GATED BY THE SAME FUNCTION THAT WRITES ITS ABSENCE.
// `terminalSourceReadiness().indexer` decides both whether the tab exists and,
// when it does not, the sentence that appears in its place. One read, so the
// page cannot show a tab that leads to a permanent "unavailable" banner, and
// cannot hide one that would have worked.
//
// Keyboard behaviour comes from the shared `useTabListKeys` rather than from a
// hand-rolled onKeyDown here — arrow keys move selection and focus, Home/End
// jump to the ends, and only the selected tab is in the Tab sequence. Every tab
// bar in this app that rolled its own got a different subset of that right.

/** The label carries the attribution: this venue does not compute "trending". */
const VIEW_LABEL: Record<TerminalView, string> = {
  new: 'New pools',
  trending: 'Trending on GeckoTerminal',
  island: 'The island',
  watchlist: 'Watchlist',
  indexer: 'Venue pairs (indexer)',
};

const MARKET_VIEWS: readonly TerminalView[] = ['new', 'trending', 'island', 'watchlist'];

export interface FeedTabsProps {
  network: GeckoNetwork;
  onNetworkChange: (n: GeckoNetwork) => void;
  view: TerminalView;
  onViewChange: (v: TerminalView) => void;
}

const TAB_BASE =
  'inline-flex min-h-11 min-w-11 items-center rounded-lg border px-3 py-2 text-xs font-medium transition-colors';

function tabClass(active: boolean): string {
  return active
    ? `${TAB_BASE} border-emerald-400/50 bg-emerald-400/10 text-white`
    : `${TAB_BASE} border-white/20 bg-white/[0.02] text-white/75 hover:bg-white/[0.06]`;
}

export function FeedTabs({ network, onNetworkChange, view, onViewChange }: FeedTabsProps) {
  const readiness = terminalSourceReadiness();
  const views: TerminalView[] = readiness.indexer.readable
    ? [...MARKET_VIEWS, 'indexer']
    : [...MARKET_VIEWS];

  const networkKeys = useTabListKeys(GECKO_NETWORKS, network, onNetworkChange);
  const viewKeys = useTabListKeys(views, view, onViewChange);

  return (
    <div className="space-y-3">
      <div
        role="tablist"
        aria-label="Network"
        onKeyDown={networkKeys.onKeyDown}
        className="flex flex-wrap gap-2"
      >
        {GECKO_NETWORKS.map((n) => (
          <button
            key={n}
            type="button"
            role="tab"
            aria-selected={n === network}
            tabIndex={networkKeys.tabIndex(n)}
            ref={networkKeys.ref(n)}
            onClick={() => onNetworkChange(n)}
            className={tabClass(n === network)}
          >
            {NETWORK_LABEL[n]}
          </button>
        ))}
      </div>

      <div
        role="tablist"
        aria-label="Feed"
        onKeyDown={viewKeys.onKeyDown}
        className="flex flex-wrap gap-2"
      >
        {views.map((v) => (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={v === view}
            tabIndex={viewKeys.tabIndex(v)}
            ref={viewKeys.ref(v)}
            onClick={() => onViewChange(v)}
            className={tabClass(v === view)}
          >
            {VIEW_LABEL[v]}
          </button>
        ))}
      </div>

      {readiness.indexer.detail ? (
        <p className="max-w-3xl text-[11px] leading-relaxed text-white/60">
          {readiness.indexer.detail}
        </p>
      ) : null}
    </div>
  );
}
