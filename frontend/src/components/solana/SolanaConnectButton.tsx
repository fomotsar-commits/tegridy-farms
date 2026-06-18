import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';

function shorten(addr: string): string {
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

/**
 * Solana wallet connect/disconnect button, styled to match the app's btn-*
 * system. Opens the wallet-adapter modal (Phantom/Solflare/etc.) via
 * useWalletModal so we don't ship the default unstyled WalletMultiButton.
 */
export function SolanaConnectButton() {
  const { publicKey, disconnect, connecting } = useWallet();
  const { setVisible } = useWalletModal();

  if (publicKey) {
    return (
      <button
        type="button"
        onClick={() => void disconnect()}
        className="btn-secondary text-[12px] md:text-[13px] px-3 md:px-4 py-1.5 font-mono"
        title="Disconnect Solana wallet"
      >
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-success mr-2 align-middle" />
        {shorten(publicKey.toBase58())}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setVisible(true)}
      disabled={connecting}
      className="btn-primary text-[12px] md:text-[13px] px-3 md:px-4 py-1.5 disabled:opacity-60"
    >
      {connecting ? 'Connecting…' : 'Connect Solana'}
    </button>
  );
}
