import { useTabListKeys } from '../../hooks/useTabListKeys';
import type { NavItem } from '../../lib/navConfig';

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
 * ⚠️ THE THREE ORIGINALS HAVE NOT BEEN MIGRATED ONTO IT. They still render their
 * own copies, so there are four versions of this strip in the app, not one, and
 * the touch-target fix below is on this one only. That is a deliberate stopping
 * point rather than an oversight: those three are shipped surfaces with their own
 * tests and their own per-tab quirks (ActivityPage self-heals /premium to Points
 * while PREMIUM_ACCESS is dark, and filters that tab out of the strip entirely),
 * and rewriting them was not what this change-set was for. They key their strips
 * by tab id against a hand-written TAB_PATHS map, where this one keys by route,
 * so the migration is mechanical but not free. Worth doing next.
 *
 * IT KEEPS THE PILLS. A section that collapses into tabs must not lose the
 * amber SOON / green LIVE signal its dropdown entries carried — that pill is the
 * answer to "can I do the thing this label names", and navConfig.ts spends
 * several hundred lines explaining why each one reads the way it does. So a tab
 * renders exactly the same two pills the "More" menu renders, from the same
 * `NavItem`. Losing them here would silently un-disclose four gated surfaces.
 *
 * The strip is keyed by ROUTE (`item.to`), not by an invented tab id, so the
 * host has one source of truth: the nav section.
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

export function RouteTabs({ idPrefix, ariaLabel, items, active, onSelect }: RouteTabsProps) {
  const keys = items.map((i) => i.to);
  const tabKeys = useTabListKeys(keys, active, onSelect);

  return (
    <div
      className="fixed left-0 right-0 z-30 px-4 md:px-6 pointer-events-none"
      style={{ top: 56 }}
    >
      <div className="max-w-[900px] mx-auto pt-3 pointer-events-auto">
        <div
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
              id={`${idPrefix}-tab-${item.to.replace(/\W+/g, '-')}`}
              aria-selected={active === item.to}
              aria-controls={`${idPrefix}-panel`}
              tabIndex={tabKeys.tabIndex(item.to)}
              ref={tabKeys.ref(item.to)}
              onClick={() => onSelect(item.to)}
              /* F402: min-w + the row's overflow-x-auto lets long strips scroll
                 on narrow phones instead of clipping, while flex-1 keeps the
                 equal-width look once there is room. */
              /* 44px ON A PHONE (A11Y-R07's floor), 40px from md up. The three
                 hosts this markup was extracted from all shipped a flat 40px —
                 about 4px under the repo's own touch floor for the primary way
                 to move between a page's sections, which is the exact defect
                 e2e/tab-target-size.spec.ts was written for on /community and
                 /nft-finance. Desktop keeps the tighter 40px: the floor is a
                 finger, not a cursor. */
              className="flex-1 min-w-[64px] px-2 md:px-3 py-2 min-h-[44px] md:min-h-[40px] rounded-xl text-[11.5px] md:text-[13.5px] font-medium text-white transition-all whitespace-nowrap inline-flex items-center justify-center gap-1.5"
              style={
                active === item.to
                  ? { background: 'var(--color-stan)', boxShadow: '0 4px 12px var(--color-stan-40)' }
                  : undefined
              }
            >
              <span>{item.tabLabel ?? item.label}</span>
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
