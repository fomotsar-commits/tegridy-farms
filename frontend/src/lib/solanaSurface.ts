import { useSyncExternalStore } from 'react';

/**
 * The page's Solana connection, as the top bar sees it.
 *
 * The owner tapped the top bar's Connect on a Solana pool, picked Trust, and
 * Trust offered Ethereum, Robinhood Chain and Base (2026-10-02). That button
 * was RainbowKit, and wagmi's WalletConnect connector proposes `eip155` only,
 * by construction (@walletconnect/ethereum-provider `namespace = "eip155"`):
 * no EVM connect can ever put Solana in a wallet's approval sheet. A note
 * saying so (2026-09-30) did not stop anyone. So on a Solana page the top
 * bar's Connect now opens that page's own Solana list.
 *
 * RULES
 *  - TopNav is in the entry chunk. This file must never import `@solana/*`,
 *    lib/solanaPolyfill, lib/solanaWallet*.ts or components/solana/*:
 *    check-dist-graph.mjs B fails the build otherwise, and
 *    solanaSurface.test.ts reads the source to say so sooner.
 *  - The top bar never builds a Solana connection of its own. A second
 *    WalletProvider reads the saved wallet only when it mounts
 *    (SolanaPoolStack.tsx), so it would disagree with the cards. It borrows
 *    the page's: SolanaProviders' bridge reports here.
 *  - `surface: null` means "no Solana section on this page". That is unknown,
 *    never "disconnected".
 *  - One SolanaProviders per page; sibling cards share one, as SolanaPoolStack
 *    does. If two are ever mounted, the one mounted last answers.
 */

export interface SolanaSurface {
  /** The page's own connect click (useSolanaConnect). */
  readonly open: () => void;
  /** base58, never a PublicKey: this file carries no Solana code. */
  readonly address: string | null;
  readonly connecting: boolean;
}

export interface SolanaSurfaceState {
  readonly surface: SolanaSurface | null;
  /** A top-bar tap waiting for the page's Solana section to load. */
  readonly openPending: boolean;
}

const EMPTY: SolanaSurfaceState = { surface: null, openPending: false };

const surfaces = new Map<object, SolanaSurface>();
const listeners = new Set<() => void>();
let pending = false;
let state: SolanaSurfaceState = EMPTY;

function announce(): void {
  const all = [...surfaces.values()];
  const surface = all[all.length - 1] ?? null;
  state = surface === null && !pending ? EMPTY : { surface, openPending: pending };
  for (const listener of [...listeners]) listener();
}

/** A SolanaProviders reports (or, with null, withdraws) its connection. */
export function setSolanaSurface(owner: object, surface: SolanaSurface | null): void {
  if (surface) surfaces.set(owner, surface);
  else if (!surfaces.delete(owner)) return;
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

/** `Bq6j…XTXV`, the house's short Solana address (BungalowDashboardPanel). */
export function shortSolanaAddress(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}
