// Polyfill MUST load before any @solana/* import — keep this first.
import '../../lib/solanaPolyfill';
import { useMemo, type ReactNode } from 'react';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import { PhantomWalletAdapter } from '@solana/wallet-adapter-phantom';
// VENDORED, not the package css: the upstream file opens with a Google-Fonts
// @import that the CSP blocks, and Vite 8 turned that block into a fatal
// CSS-preload failure — every Solana-stack page crashed in prod (2026-08-26).
// See the header in the vendored file before touching this.
import '../../styles/wallet-adapter-ui.css';
import { solanaRpcEndpoint } from '../../lib/solana';
import { SolanaWalletModalA11y } from './SolanaWalletModalA11y';

/**
 * Solana wallet context — mounted ONLY around the lazy Solana swap page, so the
 * @solana/* deps + their CSS load with that chunk and never touch the main
 * bundle or the EVM surface.
 *
 * Installed extensions (Phantom/Solflare/Backpack) register themselves via the
 * Wallet Standard, so they need no adapter here. The explicit Phantom adapter
 * covers the two states the Standard cannot: no extension installed (the modal
 * lists Phantom with an install link instead of showing nothing) and iOS
 * Safari (readyState=Loadable → connect() deep-links the current URL into
 * Phantom's in-app browser via phantom.app/ul/browse). When the extension IS
 * present, useStandardWalletAdapters drops this adapter by name ("Phantom"),
 * so the modal never shows a duplicate entry.
 */
export function SolanaProviders({ children }: { children: ReactNode }) {
  const endpoint = useMemo(() => solanaRpcEndpoint(), []);
  const wallets = useMemo(() => [new PhantomWalletAdapter()], []);
  return (
    <ConnectionProvider endpoint={endpoint} config={{ commitment: 'confirmed' }}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <SolanaWalletModalA11y />
          {children}
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
