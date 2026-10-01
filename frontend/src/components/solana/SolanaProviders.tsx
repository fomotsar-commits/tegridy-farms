// Polyfill MUST load before any @solana/* import — keep this first.
import '../../lib/solanaPolyfill';
import { useMemo, type ReactNode } from 'react';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import {
  BackpackWalletAdapter,
  CoinbaseWalletAdapter,
  IPadAwarePhantomWalletAdapter,
  MetaMaskWalletAdapter,
  SolflareWalletAdapter,
  TrustWalletAdapter,
} from '../../lib/solanaWallets';
import { WalletConnectWalletAdapter } from '../../lib/solanaWalletConnect';
// VENDORED, not the package css: the upstream file opens with a Google-Fonts
// @import that the CSP blocks, and Vite 8 turned that block into a fatal
// CSS-preload failure — every Solana-stack page crashed in prod (2026-08-26).
// See the header in the vendored file before touching this.
import '../../styles/wallet-adapter-ui.css';
import { solanaRpcEndpoint } from '../../lib/solana';
import { SolanaWalletModalProvider } from './SolanaWalletModal';

/**
 * Solana wallet context — mounted ONLY around the lazy Solana swap page, so the
 * @solana/* deps + their CSS load with that chunk and never touch the main
 * bundle or the EVM surface.
 *
 * Installed extensions (Phantom/Solflare/Backpack) register themselves via the
 * Wallet Standard, and that registration replaces an adapter of the same name
 * wherever it exists. The adapters below cover where it does not. The explicit
 * Phantom adapter
 * covers the two states the Standard cannot: no extension installed (the modal
 * lists Phantom with an install link instead of showing nothing) and iOS
 * Safari (readyState=Loadable → connect() deep-links the current URL into
 * Phantom's in-app browser via phantom.app/ul/browse). When the extension IS
 * present, useStandardWalletAdapters drops this adapter by name ("Phantom"),
 * so the modal never shows a duplicate entry. It is upstream's adapter behind a
 * one-getter subclass that also recognises an iPad (lib/solanaWallets.ts).
 *
 * Trust is here for exactly the same reasons, plus one of its own: it is the
 * wallet a Solana staker on this island most often arrives with, and until
 * 2026-09-14 the modal offered them nothing but a Phantom install link. It is
 * VENDORED rather than taken from @solana/wallet-adapter-trust, whose declared
 * transaction-version support is stale and wrong — the full evidence, and the
 * reversal of the 2026-09-02 decision, is in lib/solanaWallets.ts. It dedupes
 * against Trust's own Wallet Standard registration by the name "Trust".
 *
 * MetaMask and Coinbase Wallet (2026-09-24) are the rest of the EVM connect
 * modal's list that can hold a Solana token; Rainbow, Rabby and Safe cannot,
 * and Base's passkey account has no Solana address. Both are vendored for the
 * reasons in lib/solanaWallets.ts, and both dedupe against their own Wallet
 * Standard registrations by exact name.
 *
 * Solflare and Backpack (2026-09-26) are "Open app" rows only: on a phone they
 * open this page inside the wallet's own app, where its Wallet Standard wallet
 * takes the row; elsewhere they point at the install page. Solflare is not on
 * the EVM list, but it is the Solana wallet stakers use most after Phantom and
 * it cannot connect over WalletConnect. See lib/solanaWallets.ts.
 *
 * The modal is ours, not upstream's: upstream folds every wallet that is not
 * installed behind "More options" as soon as one is, which is how a Phantom
 * user came to see no Trust at all. See SolanaWalletModal.tsx.
 *
 * WalletConnect (2026-09-25) is the last row, on computers and iPads only: a
 * QR code in that modal, scanned by a wallet app on a phone. It is our own
 * small adapter on the SignClient the EVM connector already loads, under its
 * own storage prefix — never AppKit, never UniversalProvider, whose cleanup
 * erases the EVM side's saved session (lib/solanaWalletConnect.ts). It reads
 * the same project id variable as wagmi.ts; unset, as in CI and previews, it
 * reports Unsupported and WalletProvider drops it, so there is no row — and
 * the build carries none of WalletConnect's code, because the adapter's
 * import() of it is compiled out (check-dist-graph.mjs D fails a no-id build
 * that carries any).
 */
export function SolanaProviders({ children }: { children: ReactNode }) {
  const endpoint = useMemo(() => solanaRpcEndpoint(), []);
  const wallets = useMemo(
    () => [
      new IPadAwarePhantomWalletAdapter(),
      new TrustWalletAdapter(),
      new MetaMaskWalletAdapter(),
      new CoinbaseWalletAdapter(),
      new SolflareWalletAdapter(),
      new BackpackWalletAdapter(),
      // Same variable as wagmi.ts. Unset (CI, previews) the adapter reports
      // Unsupported, so WalletProvider drops it: no row, and no WalletConnect
      // code in the build at all.
      new WalletConnectWalletAdapter({
        projectId: (import.meta.env.VITE_WALLETCONNECT_PROJECT_ID as string | undefined) ?? '',
      }),
    ],
    [],
  );
  return (
    <ConnectionProvider endpoint={endpoint} config={{ commitment: 'confirmed' }}>
      <WalletProvider wallets={wallets} autoConnect>
        <SolanaWalletModalProvider>{children}</SolanaWalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
