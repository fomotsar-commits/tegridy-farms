/**
 * The DOM id of one tab button in a RouteTabs strip.
 *
 * WHY IT IS NOT IN RouteTabs.tsx. A host's tabpanel has to name its selected tab
 * back via `aria-labelledby`, so this formula is the one part of the strip's
 * contract the host cannot get from props — but RouteTabs.tsx is a component
 * module, and a plain function exported from one costs that file its fast
 * refresh (react-refresh/only-export-components). So it sits here, and both
 * sides import it.
 *
 * WHY IT IS SHARED AT ALL. Every copy of this expression is a chance for a panel
 * to point at an id that does not exist. An `aria-labelledby` dangling that way
 * is silent in the browser, invisible to a class-name assertion, and degrades
 * exactly the users who cannot see that it happened.
 */
export function tabDomId(idPrefix: string, to: string): string {
  return `${idPrefix}-tab-${to.replace(/\W+/g, '-')}`;
}
