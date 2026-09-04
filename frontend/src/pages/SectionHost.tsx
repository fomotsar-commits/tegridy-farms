import { Suspense, type ComponentType } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { PageSkeleton } from '../components/PageSkeleton';
import { RouteTabs } from '../components/layout/RouteTabs';
import type { NavSection } from '../lib/navConfig';

/**
 * SectionHost — turns one "More" menu section into one page with tabs.
 *
 * The dropdown used to list every destination in every section: twenty-one
 * links under six headings, of which Trust & Safety alone was seven. Four of
 * those sections (Launch / Earn / Stats / Trust & Safety) now collapse to a
 * single menu entry each, and their former entries become the tab strip on the
 * page that entry opens — the pattern LearnPage / InfoPage / ActivityPage
 * already used for Tokenomics-Lore-Security-FAQ and friends.
 *
 * THE SECTION IS THE SOURCE OF TRUTH. Tabs are not re-listed here: they are the
 * section's own `items` from navConfig.ts, in menu order, carrying their own
 * labels and their own SOON/LIVE pills. A destination cannot be in the menu and
 * missing from its host's tab bar, and a gating predicate cannot be honoured in
 * one place and forgotten in the other, because there is only one list.
 *
 * ROUTES, NOT STATE. Every tab is a real URL that also renders standalone
 * (R007 Pattern A — `tab` is derived from `location.pathname` on every render,
 * no effect, no cascading set), so every deep link, footer link and shared URL
 * that predates the condensation still lands exactly where it did, now with the
 * strip above it.
 */
export interface SectionHostProps {
  /** The nav section whose items become the tabs. */
  section: NavSection;
  /** Prefix for tab/panel element ids, e.g. "trust". */
  idPrefix: string;
  /** Accessible name for the tablist. */
  ariaLabel: string;
  /** Panel component per `item.to`. Every item in the section needs one. */
  panels: Record<string, ComponentType>;
  /**
   * Routes whose page already pulls itself up under the header (`-mt-14` +
   * its own large `pt-`), so the host must NOT add the standard clearance.
   * Everything else is wrapped in `pt-14` to clear the fixed strip.
   */
  fullBleed?: readonly string[];
}

/**
 * Does `pathname` belong to `to`?
 *
 * Deliberately NOT `pathname.startsWith(to)`: `/launch-simulator` starts with
 * `/launch`, so a prefix test would light the wrong tab on the Launch host and
 * — because the first match wins — render the wrong page. A segment-boundary
 * test is the only one that separates them.
 */
function matchesRoute(pathname: string, to: string): boolean {
  return pathname === to || pathname.startsWith(`${to}/`);
}

export function SectionHost({ section, idPrefix, ariaLabel, panels, fullBleed = [] }: SectionHostProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const items = section.items;

  // R007 Pattern A — derive the active tab straight from the URL. The first
  // item is the host's landing tab, which is also what `section.hub` points at.
  const active = items.find((i) => matchesRoute(location.pathname, i.to))?.to ?? items[0]?.to ?? '';

  const handleTab = (to: string) => {
    if (to === active) return;
    navigate(to, { replace: false });
  };

  const Panel = panels[active];

  return (
    <>
      <RouteTabs
        idPrefix={idPrefix}
        ariaLabel={ariaLabel}
        items={items}
        active={active}
        onSelect={handleTab}
      />

      <div
        role="tabpanel"
        id={`${idPrefix}-panel`}
        aria-labelledby={`${idPrefix}-tab-${active.replace(/\W+/g, '-')}`}
      >
        <Suspense fallback={<PageSkeleton />}>
          {Panel &&
            (fullBleed.includes(active) ? (
              <Panel />
            ) : (
              <div className="pt-14">
                <Panel />
              </div>
            ))}
        </Suspense>
      </div>
    </>
  );
}
