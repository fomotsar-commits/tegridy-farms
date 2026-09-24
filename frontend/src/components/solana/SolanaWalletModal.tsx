// Polyfill MUST load before any @solana/* import — same rule as SolanaProviders.
import '../../lib/solanaPolyfill';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { WalletReadyState } from '@solana/wallet-adapter-base';
import { useWallet, type Wallet } from '@solana/wallet-adapter-react';
import { WalletModalContext, useWalletModal } from '@solana/wallet-adapter-react-ui';
import { orderWallets, rowStatus, walletLabel } from '../../lib/solanaWalletOrder';

/**
 * The Solana connect modal — upstream's WalletModal (wallet-adapter-react-ui
 * 0.9.39, lib/esm/WalletModal.js) with its markup and class names kept, so the
 * vendored styles/wallet-adapter-ui.css still dresses it, and ONE behaviour
 * removed: the collapse.
 *
 * ── WHY IT IS OURS NOW ──
 *
 * Upstream lists the wallets it finds Installed and folds every other one —
 * NotDetected AND Loadable — behind a "More options" toggle, tabIndex -1 while
 * folded. With nothing installed that is invisible (every row is flat). With
 * ONE wallet installed, it hides the rest. On the BAYLA staking card that
 * meant a visitor with Phantom's extension saw one row, Phantom, and no Trust:
 * the owner's "doesn't have trust wallet" (2026-09-24). Every wallet added
 * since would have been folded away the same way. A CSS fix cannot undo it
 * (the folded rows stay out of the tab order and Collapse writes an inline
 * height), and 0.9.40 is byte-identical, so the modal is replaced — through
 * the exported WalletModalContext, whose whole contract is
 * `{ visible, setVisible }`. useSolanaConnect and SolanaConnectButton read
 * that context and need no change.
 *
 * ── WHAT IT KEEPS FROM UPSTREAM, DELIBERATELY ──
 *
 *  - The list comes from useWallet().wallets. Dedupe against Wallet Standard
 *    registrations, the Mobile Wallet Adapter and the Unsupported filter all
 *    stay inside WalletProvider. This file constructs no adapter.
 *  - A row click is `select(name)` then close. The connect happens in
 *    WalletProvider's effect, which calls connect() for a user selection and
 *    only for Installed or Loadable wallets. Calling connect() straight after
 *    select() would act on the PREVIOUS wallet — state has not updated yet.
 *  - No onError is added anywhere: WalletProvider's default handler is what
 *    turns WalletNotReadyError into the install page.
 *
 * ── WHAT IT CHANGES ──
 *
 *  1. Nothing folds. Detected wallets come first, then the wallets this venue
 *     offers in a fixed order, then anything else in WalletProvider's order
 *     (lib/solanaWalletOrder.ts).
 *  2. Every row says what a click will do: Detected, Open app, or Install.
 *  3. A not-installed wallet opens its install page in the same click and is
 *     NOT selected. Upstream selected it, which did nothing visible, and the
 *     choice was saved: every later Connect click then went to that wallet's
 *     install page instead of this list.
 *  4. Clicking the wallet that is already selected connects it. Upstream's
 *     select() of the same name is a silent no-op (WalletProvider.changeWallet).
 *  5. The dialog does its own focus handling — focus in on open, back to the
 *     trigger on close, Tab kept inside, a title the dialog is really labelled
 *     by. That replaces SolanaWalletModalA11y, which patched upstream's modal
 *     from outside and is deleted with it.
 */

const FADE_MS = 150;

function SolanaWalletModal() {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const { wallets, wallet: selected, select, connect, connected, connecting } = useWallet();
  const { setVisible } = useWalletModal();
  const [fadeIn, setFadeIn] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const ordered = useMemo(() => orderWallets(wallets), [wallets]);

  const hideModal = useCallback(() => {
    setFadeIn(false);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setVisible(false), FADE_MS);
  }, [setVisible]);

  const handleClose = useCallback(
    (event: MouseEvent) => {
      event.preventDefault();
      hideModal();
    },
    [hideModal],
  );

  const handleWalletClick = useCallback(
    (event: MouseEvent, wallet: Wallet) => {
      event.preventDefault();
      if (wallet.readyState === WalletReadyState.NotDetected) {
        // Change 3: the install page, now, in this click — and no selection.
        window.open(wallet.adapter.url, '_blank', 'noopener,noreferrer');
        return;
      }
      if (selected?.adapter.name === wallet.adapter.name) {
        // Change 4: select() would be a no-op for the same name.
        if (!connected && !connecting) {
          connect().catch(() => {
            /* surfaced by the provider's error handler */
          });
        }
        hideModal();
        return;
      }
      select(wallet.adapter.name);
      hideModal();
    },
    [selected, connected, connecting, connect, select, hideModal],
  );

  // Focus in, Escape, Tab kept inside, scroll lock, focus back out.
  useLayoutEffect(() => {
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const { overflow } = window.getComputedStyle(document.body);
    const fade = setTimeout(() => setFadeIn(true), 0);
    document.body.style.overflow = 'hidden';

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        hideModal();
        return;
      }
      if (event.key !== 'Tab') return;
      const node = ref.current;
      if (!node) return;
      const buttons = Array.from(node.querySelectorAll<HTMLElement>('button'));
      if (buttons.length === 0) return;
      const first = buttons[0]!;
      const last = buttons[buttons.length - 1]!;
      const active = document.activeElement;
      // Focus that has left the dialog (or never entered it) is brought back
      // in, not just wrapped — upstream only wrapped from inside.
      if (!(active instanceof HTMLElement) || !node.contains(active)) {
        (event.shiftKey ? last : first).focus();
        event.preventDefault();
      } else if (event.shiftKey && active === first) {
        last.focus();
        event.preventDefault();
      } else if (!event.shiftKey && active === last) {
        first.focus();
        event.preventDefault();
      }
    };
    window.addEventListener('keydown', handleKeyDown, false);

    return () => {
      clearTimeout(fade);
      document.body.style.overflow = overflow;
      window.removeEventListener('keydown', handleKeyDown, false);
      if (trigger && trigger.isConnected) trigger.focus();
    };
  }, [hideModal]);

  // The portal mounts in the same commit, so focus can move in right after.
  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(
    () => () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    },
    [],
  );

  return createPortal(
    <div
      aria-labelledby={titleId}
      aria-modal="true"
      className={`wallet-adapter-modal ${fadeIn ? 'wallet-adapter-modal-fade-in' : ''}`}
      ref={ref}
      role="dialog"
    >
      <div className="wallet-adapter-modal-container">
        <div className="wallet-adapter-modal-wrapper">
          <button
            ref={closeRef}
            type="button"
            onClick={handleClose}
            className="wallet-adapter-modal-button-close"
            aria-label="Close"
          >
            <svg width="14" height="14" aria-hidden="true">
              <path d="M14 12.461 8.3 6.772l5.234-5.233L12.006 0 6.772 5.234 1.54 0 0 1.539l5.234 5.233L0 12.006l1.539 1.528L6.772 8.3l5.69 5.7L14 12.461z" />
            </svg>
          </button>
          {ordered.length > 0 ? (
            <>
              <h1 id={titleId} className="wallet-adapter-modal-title">
                Connect a wallet on Solana to continue
              </h1>
              <ul className="wallet-adapter-modal-list">
                {ordered.map((wallet) => (
                  <WalletRow key={wallet.adapter.name} wallet={wallet} onClick={handleWalletClick} />
                ))}
              </ul>
              <p className="wallet-adapter-modal-note">Only wallets that work on Solana are listed.</p>
            </>
          ) : (
            <h1 id={titleId} className="wallet-adapter-modal-title">
              You&apos;ll need a wallet on Solana to continue
            </h1>
          )}
        </div>
      </div>
      <div className="wallet-adapter-modal-overlay" onMouseDown={handleClose} />
    </div>,
    document.body,
  );
}

function WalletRow({
  wallet,
  onClick,
}: {
  wallet: Wallet;
  onClick: (event: MouseEvent, wallet: Wallet) => void;
}) {
  const label = walletLabel(wallet.adapter.name);
  return (
    <li>
      <button type="button" className="wallet-adapter-button" onClick={(event) => onClick(event, wallet)}>
        <i className="wallet-adapter-button-start-icon">
          <img src={wallet.adapter.icon} alt="" />
        </i>
        {label}
        <span>{rowStatus(wallet.readyState)}</span>
      </button>
    </li>
  );
}

/**
 * Drop-in for upstream's WalletModalProvider: same context, same
 * `{ visible, setVisible }`, our modal.
 */
export function SolanaWalletModalProvider({ children }: { children: ReactNode }) {
  const [visible, setVisible] = useState(false);
  const value = useMemo(() => ({ visible, setVisible }), [visible]);
  return (
    <WalletModalContext.Provider value={value}>
      {children}
      {visible && <SolanaWalletModal />}
    </WalletModalContext.Provider>
  );
}
