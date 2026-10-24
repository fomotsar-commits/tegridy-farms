// CIP-30, the browser standard every Cardano wallet extension implements: the page asks
// window.cardano.<wallet>.enable(), the visitor approves in the wallet, and the page gets an
// API that reads addresses and UTxOs and signs. No library: it is a browser API, as
// window.ethereum is, and this file is all of the surface.
//
// TRUST. window.cardano is a shared, writable object: any extension can put anything under any
// name. A wallet's name and icon are shown as the wallet says them and mean nothing about
// safety. What this page trusts is only what it checks: the network id, and the transaction it
// built, read back out of its own bytes (swapTx.ts).

export interface Cip30Api {
  getNetworkId(): Promise<number>;
  getUtxos(amount?: string, paginate?: { page: number; limit: number }): Promise<string[] | null | undefined>;
  getChangeAddress(): Promise<string>;
  signTx(tx: string, partialSign?: boolean): Promise<string>;
  submitTx(tx: string): Promise<string>;
}

export interface Cip30Wallet {
  name?: unknown;
  icon?: unknown;
  enable(): Promise<Cip30Api>;
  isEnabled(): Promise<boolean>;
}

export interface CardanoWalletInfo {
  /** The window.cardano property the wallet injects under (a public extension id). */
  walletId: string;
  name: string;
  /** The wallet's own site, for "Install". */
  site: string;
}

/**
 * The wallets offered, in order (research 2026-10-24). Left out on purpose:
 * - Yoroi / SecondFi and Ctrl: SecondFi's web wallet generated keys a stranger could recover,
 *   drained from 2026-06-23, and both are shut down. Keys it made stay exposed in any wallet.
 * - Nami: folded into Lace. Flint: discontinued.
 */
export const CARDANO_WALLETS: readonly CardanoWalletInfo[] = [
  { walletId: 'eternl', name: 'Eternl', site: 'https://eternl.io' },
  { walletId: 'lace', name: 'Lace', site: 'https://www.lace.io' },
  { walletId: 'vespr', name: 'VESPR', site: 'https://vespr.xyz' },
  { walletId: 'begin', name: 'Begin', site: 'https://begin.is' },
  { walletId: 'typhoncip30', name: 'Typhon', site: 'https://typhonwallet.io' },
  { walletId: 'gerowallet', name: 'GeroWallet', site: 'https://gerowallet.io' },
  { walletId: 'nufi', name: 'NuFi', site: 'https://nu.fi' },
];

/** The wallet object injected under `walletId`, or null when none is there that can be enabled. */
export function injectedWallet(walletId: string, win: unknown = typeof window !== 'undefined' ? window : undefined): Cip30Wallet | null {
  const cardano = (win as { cardano?: Record<string, unknown> } | undefined)?.cardano;
  const w = cardano?.[walletId] as Partial<Cip30Wallet> | undefined;
  return w && typeof w.enable === 'function' && typeof w.isEnabled === 'function' ? (w as Cip30Wallet) : null;
}

/** The offered wallets, each marked by whether this browser has it. */
export function detectWallets(win?: unknown): { info: CardanoWalletInfo; installed: boolean }[] {
  return CARDANO_WALLETS.map((info) => ({ info, installed: injectedWallet(info.walletId, win) !== null }));
}

/**
 * A wallet's refusal, sorted. CIP-30 errors carry a numeric `code`: APIError -3 (Refused) and
 * TxSignError 2 (UserDeclined) are the visitor saying no; anything else is the wallet failing,
 * and is said as a failure, never as "you cancelled".
 */
export type WalletRefusal = 'declined' | 'failed';

export function sortWalletError(err: unknown, during: 'enable' | 'sign' | 'submit'): WalletRefusal {
  const code = typeof err === 'object' && err !== null && 'code' in err ? (err as { code: unknown }).code : undefined;
  if (during === 'enable' && code === -3) return 'declined';
  if (during === 'sign' && code === 2) return 'declined';
  return 'failed';
}
