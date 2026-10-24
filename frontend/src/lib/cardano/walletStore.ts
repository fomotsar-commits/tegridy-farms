// The Cardano wallet connection: one per page, shared by the Cardano page and the top bar.
// Small on purpose (no Cardano library): the top bar reads it on every page.
//
// RULES, from the Solana rail (lib/solanaSurface.ts):
// - Never prompt without a press. On load the page restores only a wallet that this site
//   already connected in this browser AND that says so itself (CIP-30 isEnabled), so enable()
//   then returns without a prompt.
// - Mainnet only. A wallet on a test network is refused, never quoted against.
// - The address is kept as the wallet's whole address, bytes and bech32, never a fragment.

import { useSyncExternalStore } from 'react';
import { parseAddressHex, MAINNET_NETWORK_ID, type ParsedAddress } from './address';
import { CIP30_WALLETS, injectedWallet, sortWalletError, type Cip30Api } from './cip30';

export type CardanoWalletState =
  | { status: 'idle' }
  | { status: 'connecting'; walletId: string }
  | { status: 'connected'; walletId: string; name: string; api: Cip30Api; address: ParsedAddress }
  | { status: 'error'; walletId: string; message: string };

/** Which wallet extension this browser last connected: its public id, never anything from inside it. */
const REMEMBERED_WALLET = 'tegridy.cip30.wallet';

let state: CardanoWalletState = { status: 'idle' };
const listeners = new Set<() => void>();
let wantsList = false;
const listListeners = new Set<() => void>();

function set(next: CardanoWalletState) {
  state = next;
  for (const l of listeners) l();
}

function remember(walletId: string | null) {
  try {
    if (walletId) localStorage.setItem(REMEMBERED_WALLET, walletId);
    else localStorage.removeItem(REMEMBERED_WALLET);
  } catch {
    /* storage blocked: the visitor presses Connect next time */
  }
}

function remembered(): string | null {
  try {
    return localStorage.getItem(REMEMBERED_WALLET);
  } catch {
    return null;
  }
}

export function getCardanoWallet(): CardanoWalletState {
  return state;
}

export function subscribeCardanoWallet(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useCardanoWallet(): CardanoWalletState {
  return useSyncExternalStore(subscribeCardanoWallet, getCardanoWallet, getCardanoWallet);
}

/** The wallet's change address, checked: mainnet, Shelley, a key (not script) payment part. */
async function readAddress(api: Cip30Api): Promise<ParsedAddress | string> {
  const network = await api.getNetworkId();
  if (network !== MAINNET_NETWORK_ID) return 'This wallet is on a test network. Switch it to Cardano mainnet.';
  const address = parseAddressHex(await api.getChangeAddress());
  if (!address || address.network !== MAINNET_NETWORK_ID) return 'This wallet’s address is not one this page can pay.';
  if (address.payment.kind !== 'key') return 'This is a script wallet. This page can only place orders from a key wallet.';
  return address;
}

async function finishConnect(walletId: string, api: Cip30Api) {
  const name = CIP30_WALLETS.find((w) => w.walletId === walletId)?.name ?? walletId;
  const address = await readAddress(api);
  if (typeof address === 'string') {
    set({ status: 'error', walletId, message: address });
    remember(null);
    return;
  }
  set({ status: 'connected', walletId, name, api, address });
  remember(walletId);
}

/** On a press only: asks the wallet to connect. */
export async function connectCardanoWallet(walletId: string): Promise<void> {
  const wallet = injectedWallet(walletId);
  if (!wallet) {
    set({ status: 'error', walletId, message: 'That wallet is not installed in this browser.' });
    return;
  }
  set({ status: 'connecting', walletId });
  try {
    await finishConnect(walletId, await wallet.enable());
  } catch (err) {
    set({
      status: 'error',
      walletId,
      message: sortWalletError(err, 'enable') === 'declined' ? 'The wallet was not connected: the request was declined.' : 'The wallet did not connect. Try again, or open the wallet first.',
    });
  }
}

/** On page load: reconnects the wallet this browser last connected, only if it says it is still connected. */
export async function restoreCardanoWallet(): Promise<void> {
  if (state.status !== 'idle') return;
  const walletId = remembered();
  if (!walletId) return;
  const wallet = injectedWallet(walletId);
  if (!wallet) return;
  try {
    if (!(await wallet.isEnabled())) return;
    if (state.status !== 'idle') return;
    await finishConnect(walletId, await wallet.enable());
  } catch {
    // A silent restore that fails stays silent: the visitor presses Connect.
  }
}

/** Forgets the wallet here. CIP-30 has no disconnect; the wallet's own site list is the visitor's. */
export function disconnectCardanoWallet(): void {
  remember(null);
  set({ status: 'idle' });
}

/** The top bar asks the page's wallet list to open; the page's modal listens. */
export function requestCardanoWalletList(): void {
  wantsList = true;
  for (const l of listListeners) l();
}

export function takeCardanoWalletListRequest(): boolean {
  const w = wantsList;
  wantsList = false;
  return w;
}

export function subscribeCardanoWalletList(l: () => void): () => void {
  listListeners.add(l);
  return () => listListeners.delete(l);
}

/** Tests only. */
export function resetCardanoWalletForTests(): void {
  state = { status: 'idle' };
  wantsList = false;
  listeners.clear();
  listListeners.clear();
}
