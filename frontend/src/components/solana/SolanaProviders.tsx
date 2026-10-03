// Polyfill MUST load before any @solana/* import — keep this first.
import '../../lib/solanaPolyfill';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ConnectionProvider, WalletProvider, useWallet } from '@solana/wallet-adapter-react';
import {
  BackpackWalletAdapter,
  CoinbaseWalletAdapter,
  IPadAwarePhantomWalletAdapter,
  JupiterWalletAdapter,
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
import { useSolanaConnect } from './useSolanaConnect';
import { SOLANA_CONNECT_WAIT_NOTICE_MS } from './SolanaConnectButton';
import { setSolanaSurface, takeSolanaOpenRequest, useSolanaSurface } from '../../lib/solanaSurface';

/**
 * Solana wallet context — mounted once per Solana section, always lazily, so
 * the @solana/* deps + their CSS load with that chunk and never touch the main
 * bundle or the EVM surface. On a Solana page it also drives the top bar's
 * Connect, through SolanaSurfaceBridge below.
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
 * Jupiter (2026-09-30) is an "Open app" row too, with jup.ag's own hand-off
 * into Jupiter Mobile on a phone. On a computer without its extension, its row
 * — and Trust's — shows the WalletConnect QR below, named for it, since both
 * phone apps scan it (solanaWalletOrder.ts SCANNABLE_WALLETS).
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
/**
 * Hands this page's Solana connection to the top bar (lib/solanaSurface.ts),
 * acts on a top-bar tap that came before this mounted, and takes it all back
 * on unmount, so a page with no Solana section never shows a stale address.
 * It sits inside the modal provider because useSolanaConnect needs it.
 *
 * THE EARLY TAP WAITS ONE RENDER. This child's effects run before
 * WalletProvider's own, which attach its 'connect' listener and start the
 * restore of the saved wallet. A connect() from this component's first effect
 * could land before that listener: a trusted Wallet Standard wallet (Trust's
 * own browser, after the first approval) emits 'connect' with no await, the
 * provider never hears it, and it reads disconnected over a connected adapter
 * until a reload. So the tap is used only once a render has SEEN this
 * provider's own report in the store, which is a render after that first
 * effect, and only after any restore in flight (`connecting`) has ended.
 *
 * A RESTORE THAT DOES NOT END STOPS HOLDING IT (2026-10-03). A locked wallet's
 * restore runs for ever, so the held tap was never used: the top bar dimmed,
 * did nothing, and ten seconds on said the list "did not load". Once the wait
 * has run as long as the card takes to name the wallet, the tap opens the
 * list, which names it too. Nothing is connected then: with a connect in
 * flight the click only opens the list (useSolanaConnect).
 */
export function SolanaSurfaceBridge() {
  const { publicKey, connecting } = useWallet();
  const open = useSolanaConnect();
  const address = publicKey ? publicKey.toBase58() : null;
  const [owner] = useState(() => ({}));
  const { surface, openPending } = useSolanaSurface();
  useEffect(() => {
    setSolanaSurface(owner, { open, address, connecting });
  }, [owner, open, address, connecting]);
  useEffect(() => {
    if (surface?.open !== open || !openPending || connecting) return;
    // A restore that connected answers the tap; otherwise it is the card's click.
    // Never over another dialog the visitor opened while waiting: overlays are
    // not stacked here, and one Escape closed both in the wrong order, which
    // left the page's scroll locked until a reload. The tap is still used up.
    if (takeSolanaOpenRequest() && !address && !document.querySelector('[aria-modal="true"]')) open();
  }, [surface, openPending, connecting, address, open]);
  useEffect(() => {
    if (surface?.open !== open || !openPending || !connecting) return;
    const timer = window.setTimeout(() => {
      if (takeSolanaOpenRequest() && !document.querySelector('[aria-modal="true"]')) open();
    }, SOLANA_CONNECT_WAIT_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [surface, openPending, connecting, open]);
  useEffect(() => () => setSolanaSurface(owner, null), [owner]);
  return null;
}

export function SolanaProviders({ children }: { children: ReactNode }) {
  const endpoint = useMemo(() => solanaRpcEndpoint(), []);
  const wallets = useMemo(
    () => [
      new IPadAwarePhantomWalletAdapter(),
      new TrustWalletAdapter(),
      new JupiterWalletAdapter(),
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
        <SolanaWalletModalProvider>
          <SolanaSurfaceBridge />
          {children}
        </SolanaWalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
