import { useSyncExternalStore } from 'react';
import { safeGetItem, safeSetItem } from './storage';

/**
 * The Solana connection the top bar shows and opens.
 *
 * The owner tapped the top bar's Connect on a Solana pool, picked Trust, and
 * Trust offered Ethereum, Robinhood Chain and Base (2026-10-02). That button
 * was RainbowKit, and wagmi's WalletConnect connector proposes `eip155` only,
 * by construction (@walletconnect/ethereum-provider `namespace = "eip155"`):
 * no EVM connect can ever put Solana in a wallet's approval sheet. A note
 * saying so (2026-09-30) did not stop anyone. So the top bar connects Solana:
 * through the page's own connection on a Solana page, and through one of its
 * own on every other page (owner, 2026-10-03: the home page, the Earn list
 * and the doors too).
 *
 * RULES
 *  - TopNav is in the entry chunk. This file must never import `@solana/*`,
 *    lib/solanaPolyfill, lib/solanaWallet*.ts or components/solana/*:
 *    check-dist-graph.mjs B fails the build otherwise, and
 *    solanaSurface.test.ts reads the source to say so sooner.
 *  - ONE LIVE SOLANA CONNECTION PER PAGE. A second WalletProvider reads the
 *    saved wallet only when it mounts (SolanaPoolStack.tsx), so two on one
 *    page disagree. Where the page has a Solana section the top bar borrows
 *    it; the top bar's own (`own`) is mounted only where the page has none,
 *    and steps aside the moment a page's appears (TopBarSolana.tsx).
 *  - `surface: null` means "no Solana connection is mounted". That is unknown,
 *    never "disconnected".
 *  - One SolanaProviders per page; sibling cards share one, as SolanaPoolStack
 *    does. If two are ever mounted, the one mounted last answers.
 */

export interface SolanaSurface {
  /** That connection's own connect click (useSolanaConnect). */
  readonly open: () => void;
  /** base58, never a PublicKey: this file carries no Solana code. */
  readonly address: string | null;
  readonly connecting: boolean;
}

export interface SolanaSurfaceState {
  /** The page's connection if it has one, else the top bar's own, else null. */
  readonly surface: SolanaSurface | null;
  /** A top-bar tap waiting for the page's Solana section to load. */
  readonly openPending: boolean;
  /** A page's own Solana section is mounted. */
  readonly page: boolean;
  /**
   * The top bar's own connection is wanted where the page has none: the
   * visitor asked for Solana there, or a Solana wallet is connected or saved.
   * Never true on a first visit, so a visitor who never touches Solana never
   * downloads its code.
   */
  readonly ownWanted: boolean;
  /**
   * Its code did not load (offline, or a deploy rotated the chunk). Only a new
   * page can fetch it again, or a Solana page that loads the same code.
   */
  readonly ownFailed: boolean;
}

const EMPTY: SolanaSurfaceState = {
  surface: null,
  openPending: false,
  page: false,
  ownWanted: false,
  ownFailed: false,
};

const surfaces = new Map<object, { readonly surface: SolanaSurface; readonly own: boolean }>();
const listeners = new Set<() => void>();
let pending = false;
let ownWanted = false;
let ownFailed = false;
let state: SolanaSurfaceState = EMPTY;

function announce(): void {
  const all = [...surfaces.values()];
  const pages = all.filter((entry) => !entry.own);
  const surface = (pages[pages.length - 1] ?? all[all.length - 1])?.surface ?? null;
  state = { surface, openPending: pending, page: pages.length > 0, ownWanted, ownFailed };
  for (const listener of [...listeners]) listener();
}

/**
 * A SolanaProviders reports (or, with null, withdraws) its connection. `own`
 * marks the top bar's own. A connected wallet makes the top bar's own wanted
 * for the rest of the tab, so the address follows the visitor to pages with
 * no Solana section; that costs no download, the code is already loaded.
 */
export function setSolanaSurface(owner: object, surface: SolanaSurface | null, own = false): void {
  if (surface) {
    const wasConnected = Boolean(surfaces.get(owner)?.surface.address);
    surfaces.set(owner, { surface, own });
    // A mounted connection proves the Solana code loads.
    ownFailed = false;
    if (surface.address) {
      ownWanted = true;
      if (!wasConnected) safeSetItem(RESTORE_KEY, '1');
    } else if (wasConnected) {
      // That connection disconnected. A withdraw (null) is only a page change, and says nothing.
      safeSetItem(RESTORE_KEY, '0');
    }
  } else if (!surfaces.delete(owner)) return;
  announce();
}

/**
 * Whether a Solana wallet was really connected in this browser, and has not
 * been disconnected since: the only thing worth restoring on a later visit.
 * The wallet adapter's own `walletName` is saved as soon as a row is tapped,
 * so on a phone, where "Open app" hands the page to the wallet's app, it names
 * a wallet that can never connect in this browser: restoring on it would
 * download the Solana code on every page, for nothing.
 */
const RESTORE_KEY = 'tegridy-solana-restore';
export function solanaWasConnectedHere(): boolean {
  return safeGetItem(RESTORE_KEY) === '1';
}

/**
 * How long a Solana connect may run before the page stops waiting on it: the
 * card names the wallet, and a held top-bar tap or the wallet sheet opens the
 * list, which names it too. It is here, not beside the card, because the wallet
 * sheet is in the entry chunk and reads it.
 */
export const SOLANA_CONNECT_WAIT_NOTICE_MS = 4_000;

/**
 * ── A HAND-OFF INTO A WALLET'S OWN BROWSER CARRIES ON THERE ──
 *
 * In a phone browser a wallet's row says "Open app": the press reopens this
 * page inside that wallet's app, where its Solana provider exists. The page
 * that opened there looked exactly like the start: the top bar said Connect,
 * and Connect, Solana and the wallet had to be pressed a second time, with
 * nothing saying so (four testers walking it as a Trust user, 2026-10-03: "a
 * visitor who expects Open app to finish the job can fairly conclude it did
 * not work"). So the press leaves a marker in the address the wallet is asked
 * to open, and the page that finds it asks the one wallet it detects to
 * connect (SolanaProviders.tsx SolanaSurfaceBridge).
 *
 * THE MARKER IS A FLAG, NEVER A VALUE. Nothing is read out of it: no wallet
 * name, no address, no URL. Anyone can write it into a link, and all such a
 * link can do is what the visitor's own press on Connect does: make this
 * site ask the wallet in that browser to connect, which the wallet shows them
 * and they approve or refuse. It is honoured on a phone or tablet only, where
 * the hand-off exists; on a computer it is removed and nothing follows. And
 * the wallet is asked only inside a wallet's own browser: an ordinary phone
 * browser that happens to carry one wallet (Brave's, a Safari extension) gets
 * the wallet list, and asking is the visitor's own press (SolanaSurfaceBridge).
 *
 * It goes in the QUERY, because every wallet's link keeps that: MetaMask's
 * rebuilds the address from host, path and query and drops a fragment
 * (lib/solanaWallets.ts). It is taken out of the address bar as soon as it is
 * read, and kept for the tab in sessionStorage, because the home page reloads
 * once on a first visit. It is put into this page's address bar only for the
 * moment the wallet's adapter reads `window.location.href`: every adapter
 * builds its link from that, upstream Phantom's included, so one press here
 * covers them all.
 */
export const SOLANA_HANDOFF_PARAM = 'solana-connect';
const HANDOFF_KEY = 'tegridy-solana-handoff';
/**
 * Set in the tab that MADE a hand-off. The marker sits in that tab's own
 * address until it is taken out below, and a tab the phone threw away before
 * that loads the marked address again in the SAME browser, which is not the
 * wallet's. So does Back from the wallet's link page. The wallet's own browser
 * has its own storage and never sees this note.
 */
const HANDOFF_SENT_KEY = 'tegridy-solana-handoff-sent';
/** A hand-off nothing answered (no wallet in this browser after all) stops waiting. */
const HANDOFF_FRESH_MS = 120_000;
/** The adapter reads the address within a render of the press; the marker then leaves this page. */
const HANDOFF_MARK_MS = 3_000;

function isPhoneOrTablet(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('android') || ua.includes('iphone') || ua.includes('ipad')) return true;
  // iPadOS 13+ sends a Mac's user agent; a Mac reports no touch points.
  return ua.includes('macintosh') && (navigator.maxTouchPoints ?? 0) > 1;
}

function withoutHandoffMarker(href: string): string | null {
  const url = new URL(href);
  if (!url.searchParams.has(SOLANA_HANDOFF_PARAM)) return null;
  url.searchParams.delete(SOLANA_HANDOFF_PARAM);
  return `${url.pathname}${url.search}${url.hash}`;
}

/** An "Open app" row was pressed: the address the wallet is about to be handed carries the marker. */
export function markSolanaHandoff(): void {
  if (typeof window === 'undefined') return;
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.has(SOLANA_HANDOFF_PARAM)) return;
    url.searchParams.set(SOLANA_HANDOFF_PARAM, '1');
    window.sessionStorage.setItem(HANDOFF_SENT_KEY, '1');
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
    const unmark = () => {
      try {
        const clean = withoutHandoffMarker(window.location.href);
        if (clean !== null) window.history.replaceState(window.history.state, '', clean);
      } catch {
        /* the page has moved on */
      }
    };
    window.setTimeout(unmark, HANDOFF_MARK_MS);
    // A tab that leaves for the wallet's link page takes the marker out on its way.
    window.addEventListener('pagehide', unmark, { once: true });
  } catch {
    /* an address that cannot be rewritten: the hand-off still happens, without the carry-on */
  }
}

/** Reads the marker out of the address this page was opened at. Runs once, as this module loads. */
export function noteSolanaHandoffArrival(): void {
  if (typeof window === 'undefined') return;
  try {
    const clean = withoutHandoffMarker(window.location.href);
    if (clean === null) return;
    window.history.replaceState(window.history.state, '', clean);
    // This tab made that hand-off itself: it is the browser that was left, not the wallet's.
    if (window.sessionStorage.getItem(HANDOFF_SENT_KEY)) {
      window.sessionStorage.removeItem(HANDOFF_SENT_KEY);
      return;
    }
    if (isPhoneOrTablet()) window.sessionStorage.setItem(HANDOFF_KEY, String(Date.now()));
  } catch {
    /* blocked storage or no URL API: the visitor presses Connect, as before */
  }
}
noteSolanaHandoffArrival();

/** This tab was opened by a hand-off that nothing has answered yet. */
export function solanaHandoffPending(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const at = Number(window.sessionStorage.getItem(HANDOFF_KEY));
    return Number.isFinite(at) && at > 0 && Date.now() - at < HANDOFF_FRESH_MS;
  } catch {
    return false;
  }
}

/** True once per hand-off, and ends it. */
export function takeSolanaHandoff(): boolean {
  const pending = solanaHandoffPending();
  try {
    window.sessionStorage.removeItem(HANDOFF_KEY);
  } catch {
    /* blocked storage: nothing was kept */
  }
  return pending;
}

/** The visitor asked for Solana where the page has no Solana section. */
export function wantOwnSolana(): void {
  if (ownWanted) return;
  ownWanted = true;
  announce();
}

/** The top bar's own Solana code did not load. */
export function noteOwnSolanaFailed(): void {
  if (ownFailed) return;
  ownFailed = true;
  announce();
}

/**
 * The top bar's Solana Connect: the page's list now, or once the page's Solana section loads.
 *
 * A tap that reaches the page also answers a tap still waiting for it. The page
 * holds an early tap while its saved wallet is being restored, and the top bar
 * takes taps through that wait. Left waiting, the early one could be replayed
 * after the list it asked for had been opened and closed, and ten seconds on
 * it was reported as a list that "did not load" (TopNav), over the open list.
 */
export function requestSolanaOpen(): void {
  const { surface } = state;
  if (surface) {
    if (pending) {
      pending = false;
      announce();
    }
    surface.open();
    return;
  }
  if (pending) return;
  pending = true;
  announce();
}

/** True once per remembered tap, and clears it. */
export function takeSolanaOpenRequest(): boolean {
  if (!pending) return false;
  pending = false;
  announce();
  return true;
}

/** A remembered tap belongs to the page it was made on. */
export function cancelSolanaOpenRequest(): void {
  if (!pending) return;
  pending = false;
  announce();
}

export function subscribeSolanaSurface(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The same object until something changes (useSyncExternalStore needs that). */
export function getSolanaSurfaceState(): SolanaSurfaceState {
  return state;
}

export function useSolanaSurface(): SolanaSurfaceState {
  return useSyncExternalStore(subscribeSolanaSurface, getSolanaSurfaceState, () => EMPTY);
}

/** Tests only: back to a first visit. Mounted connections are the tests' own to withdraw. */
export function resetSolanaSurfaceForTests(): void {
  pending = false;
  ownWanted = false;
  ownFailed = false;
  announce();
}

/** `Bq6j…XTXV`, the house's short Solana address (BungalowDashboardPanel). */
export function shortSolanaAddress(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}
