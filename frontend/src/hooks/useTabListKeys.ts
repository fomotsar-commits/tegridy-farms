import { useCallback, type KeyboardEvent } from 'react';

/**
 * Pure index math for the WAI-ARIA tabs roving-focus pattern. Given the current
 * index, total count, and a key name, returns the next index to focus, or -1 if
 * the key is not a navigation key (caller should ignore). Wraps at both ends;
 * Home/End jump to first/last. Exported for unit testing.
 */
export function nextTabIndex(current: number, count: number, key: string): number {
  if (count <= 0) return -1;
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return (current + 1 + count) % count;
    case 'ArrowLeft':
    case 'ArrowUp':
      return (current - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return -1;
  }
}

/**
 * T10 (a11y) — shared WAI-ARIA tabs keyboard helper.
 *
 * The app's tab bars already render `role="tablist"` + `role="tab"` +
 * `aria-selected`, but none implement the roving-tabindex / arrow-key part of
 * the WAI-ARIA Tabs pattern. Rather than restructure each (visually distinct)
 * tab bar into a single `<Tabs>` component — which would risk a visible
 * regression on the framer-motion `layoutId` indicators each host wires by
 * hand — this hook adds *only* the missing keyboard behaviour, additively, at
 * each call site.
 *
 * Usage at a tablist:
 *   const keys = ['swap', 'liquidity', 'dca', 'limit'] as const;
 *   const tabKeys = useTabListKeys(keys, tab, setTab);
 *   ...
 *   <div role="tablist" onKeyDown={tabKeys.onKeyDown}>
 *     {keys.map(k => (
 *       <button role="tab" aria-selected={tab === k}
 *               tabIndex={tabKeys.tabIndex(k)}
 *               ref={tabKeys.ref(k)} ... />
 *     ))}
 *   </div>
 *
 * Arrow Left/Right (and Up/Down) move selection and DOM focus to the adjacent
 * tab, wrapping at the ends; Home/End jump to the first/last tab. The selected
 * tab is the only one in the Tab sequence (tabIndex 0); the rest are -1, so a
 * single Tab press enters the strip and arrows move within it — the canonical
 * pattern (https://www.w3.org/WAI/ARIA/apg/patterns/tabs/).
 */
export function useTabListKeys<T extends string | number>(
  keys: readonly T[],
  active: T,
  onActivate: (key: T) => void,
) {
  // Per-key element refs so arrow navigation can move real DOM focus.
  const refs = new Map<T, HTMLElement | null>();

  const ref = useCallback(
    (key: T) => (el: HTMLElement | null) => {
      refs.set(key, el);
    },
    // refs is recreated each render but the closure is only used synchronously
    // by React to register elements; no stale-closure hazard.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const focusKey = useCallback(
    (key: T) => {
      const el = refs.get(key);
      if (el && typeof el.focus === 'function') el.focus();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLElement>) => {
      const current = keys.indexOf(active);
      const next = nextTabIndex(current, keys.length, e.key);
      if (next < 0) return;
      e.preventDefault();
      const nextKey = keys[next];
      if (nextKey === undefined) return;
      onActivate(nextKey);
      // Defer focus to after the activation re-render so the (now tabIndex=0)
      // target is focusable.
      requestAnimationFrame(() => focusKey(nextKey));
    },
    [keys, active, onActivate, focusKey],
  );

  const tabIndex = useCallback(
    (key: T): 0 | -1 => (key === active ? 0 : -1),
    [active],
  );

  return { onKeyDown, tabIndex, ref };
}
