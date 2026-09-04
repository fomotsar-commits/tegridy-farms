// Polyfill MUST load before any @solana/* import — keep this first.
import '../../lib/solanaPolyfill';
import { useCallback } from 'react';
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
 * degraded states work: NotDetected (desktop, no extension) throws
 * WalletNotReadyError, which the provider's DEFAULT error handler turns into
 * window.open(adapter.url) — the install page; Loadable (iOS Safari) deep-links
 * the current URL into Phantom's in-app browser. Errors are surfaced by the
 * provider's error handler, so they are deliberately swallowed here, exactly
 * like upstream. (Do NOT pass an onError to WalletProvider without
 * re-implementing the WalletNotReadyError branch — it carries this flow.)
 */
export function useSolanaConnect() {
  const { wallet, connected, connecting, connect } = useWallet();
  const { setVisible } = useWalletModal();
  return useCallback(() => {
    if (wallet && !connected && !connecting) {
      connect().catch(() => {
        /* surfaced by the provider's error handler */
      });
    } else {
      setVisible(true);
    }
  }, [wallet, connected, connecting, connect, setVisible]);
}
