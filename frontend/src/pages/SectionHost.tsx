import { Suspense, type ComponentType } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { PageSkeleton } from '../components/PageSkeleton';
import { RouteTabs } from '../components/layout/RouteTabs';
import { tabDomId } from '../components/layout/routeTabId';
import type { NavSection } from '../lib/navConfig';

/**
 * One nav section as one page with tabs: the section's own `items` (navConfig.ts) are the strip,
 * so a destination cannot be listed and missing from its host. Every tab is a real URL, derived
 * from the path on every render, so a deep link lands where it did with the strip above it. An
 * entry that is off today still renders by URL; RouteTabs leaves it out of the strip elsewhere.
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
}

/** Does `pathname` belong to `to`? A segment test: a prefix test lights /launch for /launch-simulator. */
function matchesRoute(pathname: string, to: string): boolean {
  return pathname === to || pathname.startsWith(`${to}/`);
}

export function SectionHost({ section, idPrefix, ariaLabel, panels }: SectionHostProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const items = section.items;

  // The active tab comes from the URL, off entries included; the first is the hub's landing tab.
  const active = items.find((i) => matchesRoute(location.pathname, i.to))?.to ?? items[0]?.to ?? '';

  // A no-op only ON the tab's own address. Under it (/earn/<id> lights the
  // /earn tab) a click goes back up to it: that tab is the way out of a pool.
  const handleTab = (to: string) => {
    if (location.pathname === to) return;
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
        aria-labelledby={tabDomId(idPrefix, active)}
      >
        <Suspense fallback={<PageSkeleton />}>
          {/* pt-14: the strip lies over this padding, then scrolls away with it. */}
          {Panel && (
            <div className="pt-14">
              <Panel />
            </div>
          )}
        </Suspense>
      </div>
    </>
  );
}
