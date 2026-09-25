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
  { name: 'MetaMask', label: 'MetaMask' },
  { name: 'Coinbase Wallet', label: 'Coinbase Wallet' },
];

const LABELS = new Map(OFFERED_WALLETS.map((w) => [w.name, w.label]));
const PRIORITY = new Map(OFFERED_WALLETS.map((w, i) => [w.name, i]));

/** The row label for an adapter name: ours where we have one, else its own. */
export function walletLabel(name: string): string {
  return LABELS.get(name) ?? name;
}

/**
 * Detected first; then the offered order; then everything else as given.
 * Fixed on purpose: Standard wallets register in whatever order their
 * extensions happen to load, so registration order is not stable per visit.
 */
export function orderWallets(wallets: readonly Wallet[]): Wallet[] {
  return wallets
    .map((wallet, index) => ({ wallet, index }))
    .sort((a, b) => {
      const installedA = a.wallet.readyState === WalletReadyState.Installed ? 0 : 1;
      const installedB = b.wallet.readyState === WalletReadyState.Installed ? 0 : 1;
      if (installedA !== installedB) return installedA - installedB;
      const rankA = PRIORITY.get(a.wallet.adapter.name) ?? OFFERED_WALLETS.length + a.index;
      const rankB = PRIORITY.get(b.wallet.adapter.name) ?? OFFERED_WALLETS.length + b.index;
      return rankA - rankB;
    })
    .map(({ wallet }) => wallet);
}

/** What a click on this row will do, in the row's own words. */
export function rowStatus(readyState: WalletReadyState): string {
  if (readyState === WalletReadyState.Installed) return 'Detected';
  if (readyState === WalletReadyState.Loadable) return 'Open app';
  return 'Install';
}
