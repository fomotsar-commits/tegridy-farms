// Polyfill MUST load before any @solana/* import — keep this first.
import '../../lib/solanaPolyfill';
import { useCallback } from 'react';
import { WalletReadyState } from '@solana/wallet-adapter-base';
import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';

/**
 * Connect-intent click handler for Solana surfaces — mirrors upstream
 * useWalletMultiButton's "has wallet" branch rather than inventing a flow.
 *
 * Why not just setVisible(true): once a wallet is SELECTED (persisted in
 * localStorage under `walletName`), re-picking it in the modal is a silent
 * no-op — WalletProvider.changeWallet early-returns on the same name, so no
 * adapter change fires and the auto-connect effect never runs. Only a direct
 * connect() call reaches the adapter again. That call is also what makes the
 * Loadable state work: on a phone browser it deep-links the current URL into
 * the wallet's in-app browser. Errors are surfaced by the provider's error
 * handler, so they are deliberately swallowed here, exactly like upstream.
 * (Do NOT pass an onError to WalletProvider without re-implementing its
 * WalletNotReadyError branch, which opens adapter.url.)
 *
 * A selected wallet that is NOT installed here opens the list instead
 * (2026-09-24). Upstream calls connect() on it, which opens the install page
 * — and because the choice is saved in localStorage, every later Connect
 * click did the same and the list never came back. A visitor who once tapped
 * the wrong wallet could not pick another one from the BAYLA card, which has
 * no "pick another wallet" link. The list shows that wallet with its own
 * Install link.
 */
export function useSolanaConnect() {
  const { wallet, connected, connecting, connect } = useWallet();
  const { setVisible } = useWalletModal();
  return useCallback(() => {
    const reachable =
      wallet?.readyState === WalletReadyState.Installed || wallet?.readyState === WalletReadyState.Loadable;
    if (wallet && reachable && !connected && !connecting) {
      connect().catch(() => {
        /* surfaced by the provider's error handler */
      });
    } else {
      setVisible(true);
    }
  }, [wallet, connected, connecting, connect, setVisible]);
}
