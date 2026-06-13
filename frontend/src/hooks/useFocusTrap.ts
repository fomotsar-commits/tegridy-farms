import { useEffect, useRef, type RefObject } from 'react';

/**
 * T10 (a11y) — shared focus-trap / focus-restore hook for custom dialogs.
 *
 * The base `ui/Modal` component already implements the full WAI-ARIA dialog
 * focus contract (trap the Tab cycle, focus the first control on open, restore
 * focus to the opener on close — R039). But several screens render their own
 * inline overlay div with `role="dialog"`/`aria-modal` *without* that contract
 * (e.g. the launchpad `TraitEditor`), so keyboard and screen-reader users can
 * Tab straight out of the dialog into the page behind it, and land at <body>
 * after it closes (WCAG 2.4.3 / 2.1.2).
 *
 * Rather than restructure those screens onto `Modal` (risking a visible layout
 * regression), this extracts the exact same proven logic into a hook the inline
 * dialogs can opt into by attaching the returned ref to their dialog container.
 *
 * Usage:
 *   const dialogRef = useFocusTrap<HTMLDivElement>(open);
 *   <div ref={dialogRef} role="dialog" aria-modal="true" tabIndex={-1}>…</div>
 *
 * It does NOT handle Escape — callers keep their own Escape/close logic so this
 * stays a focused, single-responsibility primitive.
 */

// Discover focusable descendants for the Tab/Shift+Tab cycle. Mirrors the
// selector used by ui/Modal (R039): anchors, native controls, and any element
// with explicit tabindex>=0. Disabled controls, tabindex="-1", and visually
// removed nodes (display:none → no offsetParent) are skipped so the trap never
// lands on an unusable target.
function getFocusableDescendants(root: HTMLElement): HTMLElement[] {
  const selector = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
  ].join(', ');
  return Array.from(root.querySelectorAll<HTMLElement>(selector)).filter(
    (el) => !el.hasAttribute('disabled') && el.offsetParent !== null,
  );
}

export function useFocusTrap<T extends HTMLElement = HTMLElement>(
  active: boolean,
): RefObject<T | null> {
  const containerRef = useRef<T>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  // Trap the Tab / Shift+Tab cycle within the container.
  useEffect(() => {
    if (!active) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !containerRef.current) return;
      const focusables = getFocusableDescendants(containerRef.current);
      if (focusables.length === 0) {
        // Nothing focusable inside — keep focus on the container itself.
        e.preventDefault();
        containerRef.current.focus();
        return;
      }
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const activeEl = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (activeEl === first || !containerRef.current.contains(activeEl)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (activeEl === last || !containerRef.current.contains(activeEl)) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [active]);

  // Capture the opener on open; move focus into the dialog; restore on close.
  useEffect(() => {
    if (!active) return;
    previouslyFocusedRef.current = (document.activeElement as HTMLElement | null) ?? null;
    requestAnimationFrame(() => {
      if (!containerRef.current) return;
      const focusables = getFocusableDescendants(containerRef.current);
      if (focusables.length > 0) focusables[0]!.focus();
      else containerRef.current.focus();
    });
    return () => {
      const prev = previouslyFocusedRef.current;
      if (prev && typeof prev.focus === 'function') prev.focus();
    };
  }, [active]);

  return containerRef;
}

// Exported for unit testing the focusable-discovery contract.
export { getFocusableDescendants };
