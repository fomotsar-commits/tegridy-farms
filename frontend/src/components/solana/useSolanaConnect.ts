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
 * connect() call reaches the adapter again. Errors are surfaced by the
 * provider's error handler, so they are deliberately swallowed here, exactly
 * like upstream. (Do NOT pass an onError to WalletProvider without
 * re-implementing its WalletNotReadyError branch, which opens adapter.url.)
 *
 * ONLY AN INSTALLED WALLET IS CONNECTED DIRECTLY (2026-09-24). Every other
 * saved wallet opens the list, where tapping it again does the same thing a
 * direct connect() would (SolanaWalletModal connects the selected row). The
 * reason is the saved choice: it lives in localStorage, and upstream clears
 * it only when connect() THROWS. Two states never throw, and each one turned
 * the Connect button into a trap with no way back to the list — the BAYLA
 * cards have no "pick another wallet" link:
 *  - NotDetected: connect() opened the wallet's install page, on every click;
 *  - Loadable (every offered wallet in a phone browser): connect() hands the
 *    page to the wallet's app and returns. Someone who tapped "MetaMask" with
 *    no MetaMask app was sent to MetaMask on every later click, and on every
 *    visit after, while the list they needed never opened again.
 * The cost is one extra tap for someone who really does have that app.
 */
export function useSolanaConnect() {
  const { wallet, connected, connecting, connect } = useWallet();
  const { setVisible } = useWalletModal();
  return useCallback(() => {
    if (wallet?.readyState === WalletReadyState.Installed && !connected && !connecting) {
      connect().catch(() => {
        /* surfaced by the provider's error handler */
      });
    } else {
      setVisible(true);
    }
  }, [wallet, connected, connecting, connect, setVisible]);
}
