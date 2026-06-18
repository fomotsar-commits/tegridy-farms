// Polyfill MUST load before any @solana/* import — keep this first.
import '../../lib/solanaPolyfill';
import { useMemo, type ReactNode } from 'react';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import '@solana/wallet-adapter-react-ui/styles.css';
import { SOLANA_RPC_URL } from '../../lib/solana';

/**
 * Solana wallet context — mounted ONLY around the lazy Solana swap page, so the
 * @solana/* deps + their CSS load with that chunk and never touch the main
 * bundle or the EVM surface. Modern wallets (Phantom/Solflare/Backpack) register
 * via the Wallet Standard, so the `wallets` array can stay empty.
 */
export function SolanaProviders({ children }: { children: ReactNode }) {
  const endpoint = useMemo(() => SOLANA_RPC_URL, []);
  return (
    <ConnectionProvider endpoint={endpoint} config={{ commitment: 'confirmed' }}>
      <WalletProvider wallets={[]} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
