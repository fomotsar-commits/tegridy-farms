import { Suspense, type ComponentType } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { PageSkeleton } from '../components/PageSkeleton';
import { RouteTabs } from '../components/layout/RouteTabs';
import { ChainPicker } from '../components/layout/ChainPicker';
import { tabDomId } from '../components/layout/routeTabId';
import type { NavItem, NavSection } from '../lib/navConfig';
import { useSectionChain, type SectionChainCopy } from '../hooks/useSectionChain';

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
  /**
   * The section runs on more than one network: a network drop-down leads the strip and the
   * strip lists that network's tabs (lib/sectionChains.ts). Off for single-network sections.
   */
  chains?: SectionChainCopy & { label: string };
  /** Where a tab's press goes, when not its own `to` (Lock's Staking tab follows the room). */
  tabTo?: (to: string) => string;
}

/** Does `pathname` belong to `to`? A segment test: a prefix test lights /launch for /launch-simulator. */
function matchesRoute(pathname: string, to: string): boolean {
  return pathname === to || pathname.startsWith(`${to}/`);
}

export function SectionHost({ section, idPrefix, ariaLabel, panels, chains, tabTo }: SectionHostProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const items = section.items;

  // The active tab comes from the URL, off entries included; the first is the hub's landing tab.
  const active = items.find((i) => matchesRoute(location.pathname, i.to))?.to ?? items[0]?.to ?? '';

  // A no-op only ON the tab's own address. Under it (/earn/<id> lights the
  // /earn tab) a click goes back up to it: that tab is the way out of a pool.
  const handleTab = (to: string) => {
    const target = tabTo ? tabTo(to) : to;
    if (location.pathname === target) return;
    navigate(target, { replace: false });
  };

  const Panel = panels[active];

  return (
    <>
      {chains ? (
        <ChainStrip
          idPrefix={idPrefix}
          ariaLabel={ariaLabel}
          items={items}
          active={active}
          pathname={location.pathname}
          chains={chains}
        />
      ) : (
        <RouteTabs
          idPrefix={idPrefix}
          ariaLabel={ariaLabel}
          items={items}
          active={active}
          onSelect={handleTab}
        />
      )}

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

/**
 * The strip of a section that runs on several networks: the drop-down first, then the chosen
 * network's tabs. Its own component so the wallet hooks run only on those hosts.
 */
function ChainStrip({
  idPrefix,
  ariaLabel,
  items,
  active,
  pathname,
  chains,
}: {
  idPrefix: string;
  ariaLabel: string;
  items: readonly NavItem[];
  active: string;
  pathname: string;
  chains: SectionChainCopy & { label: string };
}) {
  const navigate = useNavigate();
  const network = useSectionChain(items, active, chains);
  // As SectionHost's own handler, with the network riding along on the way.
  const handleTab = (to: string) => {
    if (pathname === to) return;
    navigate(network.tabHref(to), { replace: false });
  };
  return (
    <RouteTabs
      idPrefix={idPrefix}
      ariaLabel={ariaLabel}
      items={network.visibleItems}
      active={active}
      onSelect={handleTab}
      leading={
        <ChainPicker label={chains.label} active={network.active} options={network.options} onPick={network.pick} stretch />
      }
    />
  );
}
