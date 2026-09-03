// Polyfill MUST load before any @solana/* import — keep this first.
import '../../lib/solanaPolyfill';
import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { WalletReadyState } from '@solana/wallet-adapter-base';
import { useSolanaConnect } from './useSolanaConnect';

/**
 * The connect CTA for the swap and limit tabs. Click behavior comes from
 * useSolanaConnect (connect() when a wallet is already selected — that call
 * carries the install-page and iOS deep-link flows; the picker modal
 * otherwise). The hint below the button names the one state that would
 * otherwise read as "I clicked Phantom and nothing happened": a selected
 * wallet whose extension is not installed in this browser.
 */
export function SolanaConnectButton() {
  const { wallet, connecting, connected } = useWallet();
  const { setVisible } = useWalletModal();
  const openConnect = useSolanaConnect();
  const notInstalled =
    !connected && !connecting && wallet?.readyState === WalletReadyState.NotDetected;

  return (
    <>
      <button
        type="button"
        onClick={openConnect}
        disabled={connecting}
        className="btn-primary w-full py-2.5 text-[14px] disabled:opacity-60"
      >
        {connecting ? 'Connecting…' : 'Connect Solana Wallet'}
      </button>
      {notInstalled && (
        <p className="mt-2 text-center text-[11px] text-amber-300">
          {wallet.adapter.name} isn&apos;t installed in this browser.{' '}
          <a
            href={wallet.adapter.url}
            target="_blank"
            rel="noopener noreferrer"
            className="underline font-semibold"
          >
            Get {wallet.adapter.name}
          </a>{' '}
          or{' '}
          <button type="button" onClick={() => setVisible(true)} className="underline font-semibold">
            pick another wallet
          </button>
          .
        </p>
      )}
    </>
  );
}
