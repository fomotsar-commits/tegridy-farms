import { useSyncExternalStore } from 'react';

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
  /** Its code did not load (offline, or a deploy rotated the chunk). Asking again clears it. */
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
    surfaces.set(owner, { surface, own });
    if (surface.address) ownWanted = true;
  } else if (!surfaces.delete(owner)) return;
  announce();
}

/** The visitor asked for Solana where the page has no Solana section, or tries again after a failed load. */
export function wantOwnSolana(): void {
  if (ownWanted && !ownFailed) return;
  ownWanted = true;
  ownFailed = false;
  announce();
}

/** The top bar's own Solana code did not load. */
export function noteOwnSolanaFailed(): void {
  if (ownFailed) return;
  ownFailed = true;
  announce();
}

/** The top bar's Solana Connect: the page's list now, or once the page's Solana section loads. */
export function requestSolanaOpen(): void {
  if (state.surface) {
    state.surface.open();
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
