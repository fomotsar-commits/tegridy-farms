// T10 (F800) — shared focus-trap util for the Nakamigos overlays.
//
// The identical ~12-line Tab focus-trap was copy-pasted into Modal, ShareCard,
// WalletModal, and KeyboardHelp, and NONE of them filtered `:disabled`
// elements. So when (e.g.) the Buy button is disabled mid-purchase, the trap
// could land focus on a non-interactive control or no-op, letting Tab escape
// the dialog. This extracts the logic once and filters disabled/hidden nodes.

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/**
 * Is `el` rendered (not display:none / hidden / detached)? Uses a layout
 * probe when the platform provides one (real browsers), and falls back to an
 * attribute/style check under jsdom where layout metrics are always zero.
 * @param {HTMLElement} el
 */
function isVisible(el) {
  if (el.hasAttribute('hidden')) return false;
  if (el.style && el.style.display === 'none') return false;
  if (el.style && el.style.visibility === 'hidden') return false;
  // In real browsers, a rendered element has a layout box; use it to also
  // catch display:none inherited from an ancestor. jsdom returns 0/empty for
  // everything, so only trust this signal when the platform actually lays out.
  if (typeof el.getClientRects === 'function') {
    const laidOut = el.offsetWidth || el.offsetHeight || el.getClientRects().length;
    // If nothing in the document has layout (jsdom), don't use this signal.
    const platformHasLayout = document.body && document.body.offsetWidth > 0;
    if (platformHasLayout && !laidOut) return false;
  }
  return true;
}

/**
 * Return the visible, enabled, focusable descendants of `container`, in DOM
 * order. Disabled controls and hidden/detached elements are excluded so the
 * Tab cycle never lands on an unusable target.
 * @param {HTMLElement | null | undefined} container
 * @returns {HTMLElement[]}
 */
export function getFocusable(container) {
  if (!container) return [];
  return Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR)).filter(
    (el) =>
      !el.hasAttribute('disabled') &&
      el.getAttribute('aria-hidden') !== 'true' &&
      isVisible(el),
  );
}

/**
 * Handle a Tab / Shift+Tab keydown to keep focus cycling within `container`.
 * Call from a keydown handler; it only acts on the Tab key and is a no-op
 * otherwise, so callers keep their own Escape/other-key logic.
 * @param {HTMLElement | null | undefined} container
 * @param {KeyboardEvent} e
 * @returns {boolean} true if it handled (and preventDefaulted) the event
 */
export function trapFocus(container, e) {
  if (e.key !== 'Tab' || !container) return false;
  const focusable = getFocusable(container);
  if (focusable.length === 0) {
    // Nothing focusable — keep focus on the container itself.
    e.preventDefault();
    if (typeof container.focus === 'function') container.focus();
    return true;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;
  if (e.shiftKey) {
    if (active === first || !container.contains(active)) {
      e.preventDefault();
      last.focus();
      return true;
    }
  } else {
    if (active === last || !container.contains(active)) {
      e.preventDefault();
      first.focus();
      return true;
    }
  }
  return false;
}
