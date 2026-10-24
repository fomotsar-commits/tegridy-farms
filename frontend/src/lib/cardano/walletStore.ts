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
import { CARDANO_WALLETS, injectedWallet, sortWalletError, type Cip30Api } from './cip30';

export type CardanoWalletState =
  | { status: 'idle' }
  | { status: 'connecting'; key: string }
  | { status: 'connected'; key: string; name: string; api: Cip30Api; address: ParsedAddress }
  | { status: 'error'; key: string; message: string };

const REMEMBER_KEY = 'tegridy.cardano.wallet';

let state: CardanoWalletState = { status: 'idle' };
const listeners = new Set<() => void>();
let wantsList = false;
const listListeners = new Set<() => void>();

function set(next: CardanoWalletState) {
  state = next;
  for (const l of listeners) l();
}

function remember(key: string | null) {
  try {
    if (key) localStorage.setItem(REMEMBER_KEY, key);
    else localStorage.removeItem(REMEMBER_KEY);
  } catch {
    /* storage blocked: the visitor presses Connect next time */
  }
}

function remembered(): string | null {
  try {
    return localStorage.getItem(REMEMBER_KEY);
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

async function finishConnect(key: string, api: Cip30Api) {
  const name = CARDANO_WALLETS.find((w) => w.key === key)?.name ?? key;
  const address = await readAddress(api);
  if (typeof address === 'string') {
    set({ status: 'error', key, message: address });
    remember(null);
    return;
  }
  set({ status: 'connected', key, name, api, address });
  remember(key);
}

/** On a press only: asks the wallet to connect. */
export async function connectCardanoWallet(key: string): Promise<void> {
  const wallet = injectedWallet(key);
  if (!wallet) {
    set({ status: 'error', key, message: 'That wallet is not installed in this browser.' });
    return;
  }
  set({ status: 'connecting', key });
  try {
    await finishConnect(key, await wallet.enable());
  } catch (err) {
    set({
      status: 'error',
      key,
      message: sortWalletError(err, 'enable') === 'declined' ? 'The wallet was not connected: the request was declined.' : 'The wallet did not connect. Try again, or open the wallet first.',
    });
  }
}

/** On page load: reconnects the wallet this browser last connected, only if it says it is still connected. */
export async function restoreCardanoWallet(): Promise<void> {
  if (state.status !== 'idle') return;
  const key = remembered();
  if (!key) return;
  const wallet = injectedWallet(key);
  if (!wallet) return;
  try {
    if (!(await wallet.isEnabled())) return;
    if (state.status !== 'idle') return;
    await finishConnect(key, await wallet.enable());
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
