import { useLayoutEffect, useRef } from 'react';
import { useTabListKeys } from '../../hooks/useTabListKeys';
import type { NavItem } from '../../lib/navConfig';
import { tabDomId } from './routeTabId';
import { revealScrollLeft } from './tabStripScroll';

/**
 * The sticky pill tab strip shared by every route-navigating tabbed host.
 *
 * WHY IT EXISTS. LearnPage, InfoPage and ActivityPage each carry their own
 * hand-copied version of this markup — same fixed shell, same frosted pill row,
 * same `useTabListKeys` wiring, three chances to drift. The 2026-09-04 dropdown
 * condensation added four more hosts (Launch / Earn / Stats / Trust & Safety),
 * and writing the strip a fourth, fifth, sixth and seventh time was not an
 * option, so it lives here once.
 *
 * ✅ THE THREE ORIGINALS NOW RENDER THIS. They were left on their own copies for
 * one change-set — which meant the app shipped the 44px touch floor below on the
 * four new strips and a flat 40px on the three it was extracted from — and were
 * migrated immediately after. There is one strip in the app now, and
 * e2e/tab-target-size.spec.ts measures all of /community, /nft-finance, /trust,
 * /launch, /lore, /contracts and /leaderboard against the floor, so a future
 * regression fails on every host at once instead of on whichever one a reader
 * happened to check.
 *
 * The per-host quirks all survived the move, because none of them live in the
 * strip: a host still owns its own path→tab derivation and its own panel. The
 * sharp one is ActivityPage, which filters the Gold Card tab out of `items`
 * entirely while PREMIUM_ACCESS is dark and passes `active="/leaderboard"` when
 * the URL says `/premium` — this component simply renders the list and the
 * active route it is handed, and has no opinion about either.
 *
 * IT KEEPS THE PILLS. A section that collapses into tabs must not lose the
 * amber SOON / green LIVE signal its dropdown entries carried — that pill is the
 * answer to "can I do the thing this label names", and navConfig.ts spends
 * several hundred lines explaining why each one reads the way it does. So a tab
 * renders exactly the same two pills the "More" menu renders, from the same
 * `NavItem`. Losing them here would silently un-disclose four gated surfaces.
 *
 * The strip is keyed by ROUTE (`item.to`), not by an invented tab id. That is
 * what let the three originals move onto it at all: they had each grown a tab-id
 * union plus a hand-written TAB_LABELS and TAB_PATHS pair to map it back to a
 * URL, three maps to keep in step, and keying by the route deletes all three. A
 * SectionHost-driven host goes further and hands over its nav section directly,
 * so its tabs and its menu rows cannot disagree.
 */
export interface RouteTabsProps {
  /** Prefix for the tab element ids. The host's panel must be `${idPrefix}-panel`. */
  idPrefix: string;
  /** Accessible name for the tablist, e.g. "Trust & Safety sections". */
  ariaLabel: string;
  /** The section's entries, in menu order. */
  items: readonly NavItem[];
  /** `to` of the entry currently rendered in the panel. */
  active: string;
  onSelect: (to: string) => void;
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

export function RouteTabs({ idPrefix, ariaLabel, items, active, onSelect }: RouteTabsProps) {
  const keys = items.map((i) => i.to);
  const tabKeys = useTabListKeys(keys, active, onSelect);
  const listRef = useRef<HTMLDivElement>(null);
  const keyList = keys.join(' ');

  /* A strip that scrolls shows the selected tab whole: on landing, on a new
     selection, and when the strip or a tab resizes (web fonts, rotation). It
     moves only the strip's own scrollLeft, before paint, never the page. */
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const reveal = () => {
      const tab = list.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
      if (!tab) return;
      const box = tab.getBoundingClientRect();
      const start = box.left - list.getBoundingClientRect().left - list.clientLeft + list.scrollLeft;
      const next = revealScrollLeft({ start, end: start + box.width }, list);
      if (Math.abs(next - list.scrollLeft) > 0.5) list.scrollLeft = next;
    };
    reveal();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(reveal);
    ro.observe(list);
    for (const tab of list.children) ro.observe(tab);
    return () => ro.disconnect();
  }, [active, keyList]);

  return (
    <div
      className="fixed left-0 right-0 z-30 px-4 md:px-6 pointer-events-none"
      /* The header is 3.5rem PLUS the top safe-area inset (TopNav.tsx). Without the
         inset here the strip sat under the header wherever the inset is not zero:
         an Android 15 in-app browser drawn edge to edge (seen on a Galaxy S25). */
      style={{ top: 'calc(56px + env(safe-area-inset-top, 0px) + var(--room-band-h, 0px))' }}
    >
      <div className="max-w-[900px] mx-auto pt-3 pointer-events-auto">
        <div
          ref={listRef}
          role="tablist"
          aria-label={ariaLabel}
          onKeyDown={tabKeys.onKeyDown}
          /* overflow-x-auto is load-bearing, not defensive: the Trust & Safety
             strip is seven tabs wide and must scroll on a 390px phone rather
             than clip its last two. */
          className="flex gap-1 md:gap-1.5 p-1 rounded-2xl overflow-x-auto no-scrollbar"
          style={{
            // F509: 0.92 (not 0.72) so headings and footer links underneath stop
            // ghosting through the translucent bar. Matches BottomNav's ~0.95.
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
              /* WIDTH: each tab starts at 64px (the floor) and takes an equal
                 share of spare room, wider only where its label needs it. It
                 never shrinks below label plus padding (min-w-max, shrink 0), so
                 no label paints over the next tab; a strip too wide scrolls
                 sideways instead. Padding only sets that minimum, and md:px-1
                 keeps the 13.5px labels inside an iPad strip's equal share. */
              /* 44px ON TOUCH (A11Y-R07's floor), 40px on desktop. The three
                 hosts this markup was extracted from all shipped a flat 40px —
                 about 4px under the repo's own touch floor for the primary way
                 to move between a page's sections, which is the exact defect
                 e2e/tab-target-size.spec.ts was written for on /community and
                 /nft-finance. Desktop keeps the tighter 40px: the floor is a
                 finger, not a cursor.

                 ⚠️ THE BREAKPOINT IS 800, NOT `md` (768), CORRECTED 2026-09-05.
                 "Desktop" in this app means >=800px — that is where BottomNav
                 hides and the TopNav row appears, and the seven coupled sites
                 that define it are listed in TopNav.tsx. Keying the touch floor
                 to `md` opened a 32px window, 768-799, where the app still
                 renders its TOUCH chrome (BottomNav) while these tabs shrank to
                 40px. Measured live across nine hosts at 799px before the fix.
                 e2e/tab-target-size.spec.ts only ever swept 390px, which is why
                 nothing caught it. */
              className="relative flex-[1_0_64px] min-w-max px-2 md:px-1 py-2 min-h-[44px] min-[800px]:min-h-[40px] rounded-xl text-[11.5px] md:text-[13.5px] font-medium text-white transition-all whitespace-nowrap inline-flex items-center justify-center gap-1.5"
              style={
                active === item.to
                  ? { background: 'var(--color-stan)', boxShadow: '0 4px 12px var(--color-stan-40)' }
                  : undefined
              }
            >
              <TabLabel item={item} />
              {item.soon && (
                <span className="rounded-full bg-amber-500/20 text-amber-200 border border-amber-500/30 text-[8.5px] font-semibold leading-none px-1 py-0.5 uppercase tracking-wide">
                  Soon
                </span>
              )}
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
