import type { ReactNode } from 'react';
import { useTabListKeys } from '../../hooks/useTabListKeys';
import type { NavItem } from '../../lib/navConfig';
import { tabDomId } from './routeTabId';
import { useRevealSelectedTab } from './tabStripScroll';

/**
 * The tab strip every tabbed host shares, keyed by route, in the page's flow (pinned, it covered
 * fields once a page scrolled). An entry off today (`soon`) is not listed and nothing says Soon
 * (docs/FACE_LAWS.md, law 23); on its own page, reached by URL, its tab is listed and lit.
 * A host owns its path-to-tab rule and its panel; this renders the list and the active route.
 */
export interface RouteTabsProps {
  /** Prefix for the tab element ids. The host's panel must be `${idPrefix}-panel`. */
  idPrefix: string;
  /** Accessible name for the tablist, e.g. "Trust & Safety sections". */
  ariaLabel: string;
  /** The section's entries, in menu order. An off entry is listed only while it is `active`. */
  items: readonly NavItem[];
  /** `to` of the entry currently rendered in the panel. */
  active: string;
  onSelect: (to: string) => void;
  /** Drawn before the strip, outside its scroll box so a drop-down under it is not clipped. */
  leading?: ReactNode;
}

/**
 * A tab's label. With a `compactTabLabel`, phones and iPads see that instead,
 * aria-hidden, while the full label stays the accessible name (sr-only there;
 * the tab is `relative` so the sr-only box stays inside it).
 */
function TabLabel({ item }: { item: NavItem }) {
  const label = item.tabLabel ?? item.label;
  if (!item.compactTabLabel) return <span>{label}</span>;
  return (
    <>
      <span className="handheld:sr-only">{label}</span>
      <span aria-hidden="true" className="hidden handheld:inline">
        {item.compactTabLabel}
      </span>
    </>
  );
}

export function RouteTabs({ idPrefix, ariaLabel, items: all, active, onSelect, leading }: RouteTabsProps) {
  const items = all.filter((i) => !i.soon || i.to === active);
  const keys = items.map((i) => i.to);
  const tabKeys = useTabListKeys(keys, active, onSelect);
  const listRef = useRevealSelectedTab(active, keys.join(' '));

  return (
    /* The anchor takes no room, so the panel starts where it did; z-30 keeps the strip
       above the panel's padding it lies over. flow-root: a panel's -mt-14 would else
       collapse through the empty anchor and lift the strip 56px, under the top bar. */
    <div data-route-tabs className="relative z-30 h-0 flow-root">
      <div className="absolute inset-x-4 md:inset-x-6 top-0 max-w-[900px] mx-auto pt-3 flex gap-1.5 md:gap-2">
        {leading}
        <div
          ref={listRef}
          role="tablist"
          aria-label={ariaLabel}
          onKeyDown={tabKeys.onKeyDown}
          /* overflow-x-auto is load-bearing: the Check strip is seven tabs wide and must scroll
             on a 390px phone rather than clip its last two. */
          className="flex-1 min-w-0 flex gap-1 md:gap-1.5 p-1 rounded-2xl overflow-x-auto no-scrollbar"
          style={{
            // 0.92, so headings and links underneath do not ghost through. Matches BottomNav's ~0.95.
            background: 'rgba(13,21,48,0.92)',
            border: '1px solid rgba(255,255,255,0.22)',
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            boxShadow: '0 6px 24px rgba(0,0,0,0.45)',
          }}
        >
          {items.map((item) => (
            <button
              key={item.to}
              role="tab"
              id={tabDomId(idPrefix, item.to)}
              aria-selected={active === item.to}
              aria-controls={`${idPrefix}-panel`}
              tabIndex={tabKeys.tabIndex(item.to)}
              ref={tabKeys.ref(item.to)}
              onClick={() => onSelect(item.to)}
              /* Each tab starts at 64px and takes an equal share of spare room; it never shrinks
                 below its label (min-w-max, shrink 0), so a strip too wide scrolls instead. 44px
                 tall below 800px, where the app's touch chrome (BottomNav) shows, 40px above it;
                 "desktop" here means 800px, as in TopNav.tsx. e2e/tab-target-size.spec.ts measures. */
              className="relative flex-[1_0_64px] min-w-max px-2 md:px-1 py-2 min-h-[44px] min-[800px]:min-h-[40px] rounded-xl text-[11.5px] md:text-[13.5px] font-medium text-white transition-all whitespace-nowrap inline-flex items-center justify-center gap-1.5"
              style={
                active === item.to
                  ? { background: 'var(--color-stan)', boxShadow: '0 4px 12px var(--color-stan-40)' }
                  : undefined
              }
            >
              <TabLabel item={item} />
              {item.live && (
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/20 text-emerald-200 border border-emerald-500/30 text-[8.5px] font-semibold leading-none px-1 py-0.5 uppercase tracking-wide">
                  <span className="w-1 h-1 rounded-full bg-emerald-400 animate-pulse" aria-hidden="true" />
                  Live
                </span>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
