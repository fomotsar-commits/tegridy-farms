import { useEffect } from 'react';

/**
 * Focus manager for the upstream wallet-adapter modal, which ships three a11y
 * gaps its vendored CSS can't fix (the JS is NOT vendored, so this wraps
 * instead of forking):
 *   1. no initial focus — the modal opens while focus stays on the trigger, so
 *      the next Tab walks the obscured page under the overlay;
 *   2. no focus restore on close — Escape drops focus to <body>;
 *   3. aria-labelledby="wallet-adapter-modal-title" targets an id that never
 *      exists (upstream only sets it as a class), so screen readers announce a
 *      nameless dialog.
 * Upstream's own handleTabKey already wraps first/last WHILE focus is inside
 * the modal; the hole is focus that never entered it. Renders nothing.
 */
export function SolanaWalletModalA11y() {
  useEffect(() => {
    let modal: HTMLElement | null = null;
    let prevFocus: HTMLElement | null = null;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !modal) return;
      const active = document.activeElement;
      // Inside the modal, upstream's own wrap handling is correct — stand down.
      if (active instanceof HTMLElement && modal.contains(active)) return;
      const buttons = modal.querySelectorAll<HTMLElement>('button');
      if (buttons.length === 0) return;
      (e.shiftKey ? buttons[buttons.length - 1] : buttons[0])!.focus();
      e.preventDefault();
    };

    const sync = () => {
      const found = document.querySelector<HTMLElement>('.wallet-adapter-modal');
      if (found && !modal) {
        modal = found;
        prevFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        const title = modal.querySelector<HTMLElement>('.wallet-adapter-modal-title');
        if (title && !title.id) title.id = 'wallet-adapter-modal-title';
        modal.querySelector<HTMLElement>('.wallet-adapter-modal-button-close')?.focus();
      } else if (!found && modal) {
        modal = null;
        prevFocus?.focus();
        prevFocus = null;
      }
    };

    const obs = new MutationObserver(sync);
    obs.observe(document.body, { childList: true, subtree: true });
    sync();
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      obs.disconnect();
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, []);
  return null;
}
