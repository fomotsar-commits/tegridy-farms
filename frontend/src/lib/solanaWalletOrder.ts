import { WalletReadyState } from '@solana/wallet-adapter-base';
import type { Wallet } from '@solana/wallet-adapter-react';

/**
 * Order and labels for the Solana connect modal
 * (components/solana/SolanaWalletModal.tsx). Pure data and pure functions, so
 * they are testable without mounting the modal and the modal file exports only
 * components.
 */

/**
 * The wallets this venue offers on Solana, in display order, with the label
 * each row shows. `name` is the adapter's name and must stay EXACTLY what the
 * wallet registers under — it is the dedupe key (see solanaWallets.ts). The
 * label may differ: Trust registers as "Trust" and is shown as "Trust Wallet",
 * matching the EVM connect modal.
 *
 * Kept as a local constant rather than imported from the EVM side:
 * rainbowkitWallets.ts pulls in wagmi, and importing it here would weld the
 * lazy Solana chunk to the EVM one (vite.config.ts manualChunks).
 */
export const OFFERED_WALLETS: ReadonlyArray<{ readonly name: string; readonly label: string }> = [
  { name: 'Phantom', label: 'Phantom' },
  { name: 'Trust', label: 'Trust Wallet' },
  { name: 'Jupiter', label: 'Jupiter' },
  { name: 'MetaMask', label: 'MetaMask' },
  { name: 'Coinbase Wallet', label: 'Coinbase Wallet' },
  { name: 'Solflare', label: 'Solflare' },
  { name: 'Backpack', label: 'Backpack' },
];

/**
 * The WalletConnect row (lib/solanaWalletConnect.ts): ALWAYS the last row,
 * after every other wallet, offered or not. It is a QR code for a wallet on
 * ANOTHER device — the fallback, not a peer of the wallets in this browser.
 * It is deliberately not in OFFERED_WALLETS: the offered order puts a wallet
 * after the offered ones only while every wallet outside that list is
 * Installed, and a Loadable or NotDetected wallet outside it (Glow, say)
 * ranks after all of them. Its label is its name. It exists only when a
 * WalletConnect project id is set, and never on a phone.
 */
const WALLETCONNECT_ROW = 'WalletConnect';

/**
 * Wallets whose PHONE app connects to Solana over WalletConnect, each per a
 * primary source: Trust's developer docs list Solana among its WalletConnect
 * networks, and Jupiter's docs say Jupiter Mobile's scanner reads WalletConnect
 * codes (both are on WalletConnect's registry for solana mainnet). Where the
 * WalletConnect row exists (a computer or an iPad, with a project id) and
 * the wallet is not in this browser, its row shows that QR, named for it,
 * rather than the extension's install page: a visitor with the app on their
 * phone and no extension otherwise met a dead end, or a QR they had no
 * reason to think was theirs (owner, 2026-09-30).
 */
export const SCANNABLE_WALLETS: ReadonlySet<string> = new Set(['Trust', 'Jupiter']);

const LABELS = new Map(OFFERED_WALLETS.map((w) => [w.name, w.label]));
const PRIORITY = new Map(OFFERED_WALLETS.map((w, i) => [w.name, i]));

/** The row label for an adapter name: ours where we have one, else its own. */
export function walletLabel(name: string): string {
  return LABELS.get(name) ?? name;
}

/**
 * Detected first; then the offered order; then everything else as given;
 * WalletConnect last of all. Fixed on purpose: Standard wallets register in
 * whatever order their extensions happen to load, so registration order is not
 * stable per visit.
 */
export function orderWallets(wallets: readonly Wallet[]): Wallet[] {
  return wallets
    .map((wallet, index) => ({ wallet, index }))
    .sort((a, b) => {
      const lastA = a.wallet.adapter.name === WALLETCONNECT_ROW ? 1 : 0;
      const lastB = b.wallet.adapter.name === WALLETCONNECT_ROW ? 1 : 0;
      if (lastA !== lastB) return lastA - lastB;
      const installedA = a.wallet.readyState === WalletReadyState.Installed ? 0 : 1;
      const installedB = b.wallet.readyState === WalletReadyState.Installed ? 0 : 1;
      if (installedA !== installedB) return installedA - installedB;
      const rankA = PRIORITY.get(a.wallet.adapter.name) ?? OFFERED_WALLETS.length + a.index;
      const rankB = PRIORITY.get(b.wallet.adapter.name) ?? OFFERED_WALLETS.length + b.index;
      return rankA - rankB;
    })
    .map(({ wallet }) => wallet);
}

/**
 * Does a click on this row show the WalletConnect QR for it? `canScan`: the
 * WalletConnect row exists here.
 */
export function scansForWallet(readyState: WalletReadyState, name: string, canScan: boolean): boolean {
  return canScan && readyState === WalletReadyState.NotDetected && SCANNABLE_WALLETS.has(name);
}

/** What a click on this row will do, in the row's own words. */
export function rowStatus(readyState: WalletReadyState, name?: string, canScan = false): string {
  // Always Loadable, but a click shows a QR code — it opens no app.
  if (name === WALLETCONNECT_ROW) return 'Scan QR code';
  if (name !== undefined && scansForWallet(readyState, name, canScan)) return 'Scan QR code';
  if (readyState === WalletReadyState.Installed) return 'Detected';
  if (readyState === WalletReadyState.Loadable) return 'Open app';
  return 'Install';
}
