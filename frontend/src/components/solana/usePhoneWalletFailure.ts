// Polyfill MUST load before any @solana/* import — keep this first.
import '../../lib/solanaPolyfill';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { WalletConnectionError, type WalletError } from '@solana/wallet-adapter-base';
import { useWallet } from '@solana/wallet-adapter-react';
import { PHONE_WALLET_ROW } from '../../lib/solanaWalletOrder';

export interface PhoneWalletFailure {
  /** The row's last attempt failed, and the list has not been closed since. */
  readonly failed: boolean;
  /** The visitor tapped the row: how the attempt ends is now theirs to see. */
  readonly asked: () => void;
  /** The list closed, so the notice was seen. */
  readonly seen: () => void;
}

/**
 * Reports a failed connect of the phone-wallet row (solanaWalletOrder.ts
 * PHONE_WALLET_ROW). Its adapter's connect() starts the attempt and returns
 * without waiting (@solana-mobile/wallet-adapter-mobile 2.2.9), so the list has
 * closed by the time it fails: WalletProvider only logs the 'error', and the
 * promise rejects with nobody holding it. Mounted by SolanaWalletModalProvider.
 */
export function usePhoneWalletFailure(openList: () => void): PhoneWalletFailure {
  const { wallets, connected } = useWallet();
  const adapter = useMemo(() => wallets.find((w) => w.adapter.name === PHONE_WALLET_ROW)?.adapter ?? null, [wallets]);
  const [failed, setFailed] = useState(false);
  // Any wallet connecting answers it. Reset during render, as SolanaConnectButton does.
  if (connected && failed) setFailed(false);
  const wasAsked = useRef(false);

  useEffect(() => {
    if (!adapter) return;
    // Failures the page has shown. The promise rejects with the same object the event carried.
    const shown = new WeakSet<object>();
    const handleError = (error: WalletError) => {
      // A failed connect the visitor tapped for, nothing else: a restore on
      // page load, or a declined signature, must not open the wallet list.
      if (!wasAsked.current || !(error instanceof WalletConnectionError)) return;
      wasAsked.current = false;
      shown.add(error);
      setFailed(true);
      // Never over another dialog: overlays are not stacked here (SolanaSurfaceBridge).
      if (!document.querySelector('[aria-modal="true"]')) openList();
    };
    const handleConnect = () => {
      wasAsked.current = false;
    };
    const handleRejection = (event: PromiseRejectionEvent) => {
      if (shown.has(event.reason as object)) event.preventDefault();
    };
    adapter.on('error', handleError);
    adapter.on('connect', handleConnect);
    window.addEventListener('unhandledrejection', handleRejection);
    return () => {
      adapter.off('error', handleError);
      adapter.off('connect', handleConnect);
      window.removeEventListener('unhandledrejection', handleRejection);
    };
  }, [adapter, openList]);

  const asked = useCallback(() => {
    wasAsked.current = true;
  }, []);
  const seen = useCallback(() => setFailed(false), []);
  return useMemo(() => ({ failed, asked, seen }), [failed, asked, seen]);
}
