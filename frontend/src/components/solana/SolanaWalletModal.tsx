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
  useSyncExternalStore,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Cuer } from 'cuer';
import { WalletReadyState } from '@solana/wallet-adapter-base';
import { useWallet, type Wallet } from '@solana/wallet-adapter-react';
import { WalletModalContext, useWalletModal } from '@solana/wallet-adapter-react-ui';
import { orderWallets, rowStatus, scansForWallet, waitedOnWalletLabel, walletLabel } from '../../lib/solanaWalletOrder';
import { WalletConnectWalletAdapter, type WalletConnectPairing } from '../../lib/solanaWalletConnect';
import { shortSolanaAddress } from '../../lib/solanaSurface';
import { useWalletResync } from './useWalletResync';

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
 *  6. WalletConnect (lib/solanaWalletConnect.ts, 2026-09-25) draws its QR code
 *     HERE, in place of the list, rather than in a second dialog that would
 *     fight this one's focus trap and scroll-lock restore. Its row keeps the
 *     dialog open. Back, Close, Escape, the backdrop and unmount all abandon
 *     the attempt, in any phase — "Starting WalletConnect…" included. A
 *     failure shows its reason above the list, and an attempt that ends
 *     connected closes the dialog. A click on the row while its own saved
 *     session is still being restored is kept, not dropped: the dialog closes
 *     if the restore connects, and goes on to the QR if it finds nothing.
 *     Swapping between the list and the QR moves focus to the new view's
 *     title, because the button that had it — the row, or Back — is gone.
 *  7. Trust's and Jupiter's rows, where that wallet is not in this browser
 *     but the WalletConnect row exists (a computer or an iPad), show that
 *     same QR, named for the wallet, with its extension as the second choice
 *     — not the extension's install page. Both phone apps scan it
 *     (solanaWalletOrder.ts SCANNABLE_WALLETS). The connection is the
 *     WalletConnect row's: the same adapter, saved under the same name.
 */

const FADE_MS = 150;

/** The wallet a QR was opened for (change 7): its row label and its install page. */
interface ScanFor {
  readonly label: string;
  readonly installUrl: string;
}

const IDLE_PAIRING: WalletConnectPairing = { phase: 'idle' };
const noSubscription = () => () => {};
const idlePairing = () => IDLE_PAIRING;

/**
 * The WalletConnect row's QR state. The QR is drawn HERE, in this dialog, so
 * it inherits the dialog's focus trap, Escape, backdrop and scroll lock — a
 * second dialog would fight this one's scroll-lock restore.
 */
function useWalletConnectPairing(adapter: WalletConnectWalletAdapter | null): WalletConnectPairing {
  return useSyncExternalStore(
    adapter ? adapter.subscribePairing : noSubscription,
    adapter ? adapter.getPairing : idlePairing,
  );
}

function SolanaWalletModal() {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const { wallets, wallet: selected, select, connect, disconnect, connected, connecting, publicKey } = useWallet();
  const { setVisible } = useWalletModal();
  const [fadeIn, setFadeIn] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const ordered = useMemo(() => orderWallets(wallets), [wallets]);
  const walletConnect = useMemo(
    () =>
      wallets
        .map((w) => w.adapter)
        .find((a): a is WalletConnectWalletAdapter => a instanceof WalletConnectWalletAdapter) ?? null,
    [wallets],
  );
  const walletConnectWallet = useMemo(
    () => (walletConnect ? (wallets.find((w) => w.adapter === walletConnect) ?? null) : null),
    [wallets, walletConnect],
  );
  // The wallet whose row opened the QR (change 7), named on it; null for the
  // WalletConnect row itself.
  const [scanFor, setScanFor] = useState<ScanFor | null>(null);
  const pairing = useWalletConnectPairing(walletConnect);
  const pairingActive = pairing.phase === 'starting' || pairing.phase === 'scan';
  const connectedAs = connected && publicKey ? shortSolanaAddress(publicKey.toBase58()) : null;
  // The wallet a connect is still waiting on: a locked wallet, or an approval
  // window nobody saw, answers late or never, and until 2026-10-03 nothing
  // named it. WalletConnect's own wait is its QR, or its saved session's restore.
  const waitingNow = connecting && !connected && selected ? waitedOnWalletLabel(selected.adapter.name) : null;
  // What the list shows is held as it was once the dialog starts to close. A
  // pick starts a connect and the list then fades for FADE_MS, still mounted:
  // following `connecting` through that fade, it said "it may be locked" at
  // every ordinary connect, in a live region, about a wallet asked a moment ago.
  const [closing, setClosing] = useState(false);
  const [waitingFor, setWaitingFor] = useState(waitingNow);
  if (!closing && waitingFor !== waitingNow) setWaitingFor(waitingNow);
  // The WalletConnect row clicked while its own saved session was still being
  // restored: connect once the restore is over, if it did not connect.
  const connectAfterRestore = useRef(false);

  const hideModal = useCallback(() => {
    // Closing the dialog abandons a QR in progress (connect() rejects with
    // WalletWindowClosedError, which clears the saved choice) and clears a
    // failure notice that has now been seen.
    connectAfterRestore.current = false;
    walletConnect?.cancelPairing();
    walletConnect?.dismissPairing();
    setClosing(true);
    setFadeIn(false);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setVisible(false), FADE_MS);
  }, [setVisible, walletConnect]);

  // A WalletConnect attempt that ends CONNECTED closes the dialog. One that
  // fails leaves it open, showing the reason above the list.
  const sawPairing = useRef(false);
  useEffect(() => {
    if (pairingActive) sawPairing.current = true;
    else if (pairing.phase === 'failed') sawPairing.current = false;
  }, [pairingActive, pairing.phase]);
  useEffect(() => {
    if (connected && sawPairing.current) {
      sawPairing.current = false;
      hideModal();
    }
  }, [connected, hideModal]);
  useEffect(() => {
    if (!connectAfterRestore.current || connecting) return;
    connectAfterRestore.current = false;
    if (!connected) {
      connect().catch(() => {
        /* surfaced by the provider's error handler */
      });
    }
  }, [connecting, connected, connect]);

  // The swap between the list and the QR unmounts the button that had focus
  // (the row, or Back). Focus goes to the new view's title, which a screen
  // reader then reads. getElementById: a useId id is not a valid selector.
  const wasPairingActive = useRef(false);
  useEffect(() => {
    if (pairingActive === wasPairingActive.current) return;
    wasPairingActive.current = pairingActive;
    document.getElementById(titleId)?.focus();
  }, [pairingActive, titleId]);

  const handleDisconnect = useCallback(() => {
    disconnect().catch(() => {
      /* surfaced by the provider's error handler */
    });
    hideModal();
  }, [disconnect, hideModal]);

  const handleClose = useCallback(
    (event: MouseEvent) => {
      event.preventDefault();
      hideModal();
    },
    [hideModal],
  );

  const handleWalletClick = useCallback(
    (event: MouseEvent, clicked: Wallet) => {
      event.preventDefault();
      let wallet = clicked;
      if (clicked.readyState === WalletReadyState.NotDetected) {
        if (!walletConnectWallet || !scansForWallet(clicked.readyState, clicked.adapter.name, true)) {
          // Change 3: the install page, now, in this click — and no selection.
          window.open(clicked.adapter.url, '_blank', 'noopener,noreferrer');
          return;
        }
        // Change 7: Trust or Jupiter, not in this browser — the QR its phone app scans.
        wallet = walletConnectWallet;
      }
      setScanFor(
        wallet === clicked ? null : { label: walletLabel(clicked.adapter.name), installUrl: clicked.adapter.url },
      );
      // WalletConnect's QR is drawn in this dialog, so its row does not close it.
      const keepOpen = wallet.adapter === walletConnect;
      if (keepOpen) walletConnect.dismissPairing();
      if (selected?.adapter.name === wallet.adapter.name) {
        // Change 4: select() would be a no-op for the same name.
        if (!connected && !connecting) {
          connect().catch(() => {
            /* surfaced by the provider's error handler */
          });
        } else if (keepOpen && connecting) {
          // Its saved session is still being restored. Once that is over,
          // the restore's connect closes the dialog (sawPairing), and a
          // restore that found nothing goes on to the QR.
          sawPairing.current = true;
          connectAfterRestore.current = true;
        }
        // Connected already (the top bar's address opens this list): the row
        // of the wallet in use closes it, WalletConnect's included. That row
        // otherwise stays open for a QR, and here there is none to draw.
        if (!keepOpen || connected) hideModal();
        return;
      }
      select(wallet.adapter.name);
      if (!keepOpen) hideModal();
    },
    [selected, connected, connecting, connect, select, hideModal, walletConnect, walletConnectWallet],
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

  // However the dialog goes away, a QR nobody can see is not left pairing.
  useEffect(() => () => walletConnect?.cancelPairing(), [walletConnect]);

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
          {pairingActive && walletConnect ? (
            <WalletConnectQr
              pairing={pairing}
              titleId={titleId}
              scanFor={scanFor}
              onBack={() => walletConnect.cancelPairing()}
            />
          ) : ordered.length > 0 ? (
            <>
              {/* The top bar's address opens this list while connected: it then
                  says so, names the wallet in use, and offers the way out the
                  Solana pages lacked (only the dashboard panel had one). */}
              <h1 id={titleId} tabIndex={-1} className="wallet-adapter-modal-title">
                {connectedAs ? 'Switch Solana wallet' : 'Connect a wallet on Solana to continue'}
              </h1>
              {connectedAs && (
                <p className="wallet-adapter-modal-note">
                  Connected as {connectedAs}.{' '}
                  <button type="button" onClick={handleDisconnect} className="underline font-semibold text-white">
                    Disconnect
                  </button>
                </p>
              )}
              {waitingFor && (
                <p role="status" className="wallet-adapter-modal-note">
                  Waiting for {waitingFor} to answer. Open {waitingFor}: it may be locked, or waiting for you to
                  approve this site. Or pick another wallet below.
                </p>
              )}
              {pairing.phase === 'failed' && (
                <p role="alert" className="wallet-adapter-modal-note">
                  {pairing.reason}
                </p>
              )}
              <ul className="wallet-adapter-modal-list">
                {ordered.map((wallet) => (
                  <WalletRow
                    key={wallet.adapter.name}
                    wallet={wallet}
                    canScan={walletConnectWallet !== null}
                    current={connectedAs !== null && selected?.adapter.name === wallet.adapter.name}
                    onClick={handleWalletClick}
                  />
                ))}
              </ul>
              {/* On a Solana page the top bar's Connect opens this list
                  (lib/solanaSurface.ts). An Ethereum wallet connected on
                  another page is a separate connection and never shows here. */}
              <p className="wallet-adapter-modal-note">
                Only wallets that work on Solana are listed. This connects your Solana account. An Ethereum or
                Base connection is separate and stays as it is.
              </p>
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
  canScan,
  current,
  onClick,
}: {
  wallet: Wallet;
  canScan: boolean;
  /** The wallet connected right now. */
  current: boolean;
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
        <span>{current ? 'Connected' : rowStatus(wallet.readyState, wallet.adapter.name, canScan)}</span>
      </button>
    </li>
  );
}

/**
 * The QR, drawn with cuer — RainbowKit's own QR component (rainbowkit
 * dist/index.js:4350-4410: the same Cuer.Root / Cells / Finder parts and
 * radii), already in the eager vendor-wagmi chunk. Dark cells on white
 * whatever the theme, because phone cameras read that.
 */
function WalletConnectQr({
  pairing,
  titleId,
  scanFor,
  onBack,
}: {
  pairing: WalletConnectPairing;
  titleId: string;
  scanFor: ScanFor | null;
  onBack: () => void;
}) {
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  const uri = pairing.phase === 'scan' ? pairing.uri : null;
  const copyLink = useCallback(() => {
    if (!uri) return;
    // Say "copied" only when the browser said so.
    if (!navigator.clipboard) {
      setCopy('failed');
      return;
    }
    navigator.clipboard.writeText(uri).then(
      () => setCopy('copied'),
      () => setCopy('failed'),
    );
  }, [uri]);
  return (
    <>
      <h1 id={titleId} tabIndex={-1} className="wallet-adapter-modal-title">
        {!uri
          ? 'Starting WalletConnect…'
          : scanFor
            ? `Scan with ${scanFor.label} on your phone`
            : 'Scan with your phone’s wallet'}
      </h1>
      {uri && (
        <>
          <div style={{ background: '#fff', color: '#000', padding: 16, borderRadius: 12, margin: '0 auto', width: 'max-content' }}>
            <Cuer.Root errorCorrection="medium" size={240} value={uri} role="img" aria-label="WalletConnect QR code">
              <Cuer.Cells fill="currentColor" radius={1} />
              <Cuer.Finder fill="currentColor" radius={0.25} />
            </Cuer.Root>
          </div>
          <p className="wallet-adapter-modal-note">
            {scanFor
              ? `Open ${scanFor.label} on your phone and scan this code with its scanner. It connects your Solana account.`
              : 'Use a wallet app that supports Solana through WalletConnect, such as Trust Wallet or Jupiter. Phantom and Solflare can’t connect this way.'}
          </p>
          <button type="button" className="wallet-adapter-button" onClick={copyLink}>
            {copy === 'copied' ? 'Link copied' : copy === 'failed' ? 'Couldn’t copy — scan instead' : 'Copy link'}
          </button>
        </>
      )}
      {scanFor && (
        <button
          type="button"
          className="wallet-adapter-button"
          onClick={() => window.open(scanFor.installUrl, '_blank', 'noopener,noreferrer')}
        >
          {/* One text node: this button is a flex row, and split text lays out as separate items. */}
          {`Use the ${scanFor.label} extension instead`}
        </button>
      )}
      <button type="button" className="wallet-adapter-button" onClick={onBack}>
        Back to wallets
      </button>
    </>
  );
}

/**
 * Drop-in for upstream's WalletModalProvider: same context, same
 * `{ visible, setVisible }`, our modal.
 */
export function SolanaWalletModalProvider({ children }: { children: ReactNode }) {
  const [visible, setVisible] = useState(false);
  // Here because this provider is mounted once inside every Solana section's WalletProvider.
  useWalletResync();
  const value = useMemo(() => ({ visible, setVisible }), [visible]);
  return (
    <WalletModalContext.Provider value={value}>
      {children}
      {visible && <SolanaWalletModal />}
    </WalletModalContext.Provider>
  );
}
