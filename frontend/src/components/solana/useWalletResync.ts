// Polyfill MUST load before any @solana/* import — keep this first.
import '../../lib/solanaPolyfill';
import { useEffect, useRef } from 'react';
import type { WalletName } from '@solana/wallet-adapter-base';
import { useWallet } from '@solana/wallet-adapter-react';

/**
 * Keeps the page in step with a wallet that is connected while the provider says it is
 * not. Mounted once per Solana section, by SolanaWalletModalProvider.
 *
 * WHY THE TWO CAN DISAGREE. The page tells someone whose wallet is not answering to pick
 * another (SolanaConnectButton). The first wallet's connect is still running inside
 * wallet-adapter-react, holding the handlers it captured when it began, and when that
 * wallet answers later those stale handlers act on the page as it was then:
 *  - it declines (the forgotten prompt is closed): the stale handler wipes the saved
 *    choice and drops the wallet the visitor moved to, which is still connected;
 *  - it approves: the adapter is connected and nobody is told.
 * Either way a later connect() on a connected adapter returns without announcing
 * anything, so the page read "not connected" over a connected wallet and Connect did
 * nothing until a reload. Found by the review of the 2026-10-03 fix; it was reachable
 * before it from every card whose Connect was never disabled.
 *
 * WHAT THIS DOES, AND NOTHING ELSE.
 *  1. The selected wallet is connected and the provider is neither connected nor
 *     connecting: the adapter says "connect" again. One render later, never from the
 *     first effect: WalletProvider attaches its listener for a newly selected adapter in
 *     its own effect, which runs after this one.
 *  2. No wallet is selected, the one that was is still connected, and the visitor did
 *     not disconnect it: it is selected again, and 1 does the rest.
 * A wallet the visitor disconnected, or whose own prompt they declined, is not connected,
 * so neither step touches it.
 */
export function useWalletResync(): void {
  const { wallet, wallets, connected, connecting, select } = useWallet();

  useEffect(() => {
    const adapter = wallet?.adapter;
    if (!adapter || connected || connecting || !adapter.connected) return;
    const timer = setTimeout(() => {
      if (adapter.connected && adapter.publicKey) adapter.emit('connect', adapter.publicKey);
    }, 0);
    return () => clearTimeout(timer);
  }, [wallet, connected, connecting]);

  const lastChosen = useRef<WalletName | null>(null);
  useEffect(() => {
    if (wallet) {
      lastChosen.current = wallet.adapter.name;
      return;
    }
    const name = lastChosen.current;
    lastChosen.current = null;
    if (name && wallets.some((w) => w.adapter.name === name && w.adapter.connected)) select(name);
  }, [wallet, wallets, select]);
}
