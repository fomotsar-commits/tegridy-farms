// Polyfill MUST load before any @solana/* import — keep this first.
import '../../lib/solanaPolyfill';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { WalletReadyState } from '@solana/wallet-adapter-base';
import { ConnectionProvider, WalletProvider, useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
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
import { opensInWalletApp } from '../../lib/solanaWalletOrder';
import { SolanaWalletModalProvider } from './SolanaWalletModal';
import { useSolanaConnect } from './useSolanaConnect';
import {
  SOLANA_CONNECT_WAIT_NOTICE_MS,
  setSolanaSurface,
  solanaHandoffPending,
  solanaWasConnectedHere,
  takeSolanaHandoff,
  takeSolanaOpenRequest,
  useSolanaSurface,
} from '../../lib/solanaSurface';

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
 * flight the click only opens the list (useSolanaConnect). If the visitor has
 * this page's list on screen before that, the list is the answer and the tap
 * is used up: it does not open the list again after they have closed it.
 */
export function SolanaSurfaceBridge({ own = false }: { own?: boolean }) {
  const { publicKey, connecting, connected, wallets, wallet, select } = useWallet();
  const open = useSolanaConnect();
  const address = publicKey ? publicKey.toBase58() : null;
  const [owner] = useState(() => ({}));
  const { surface, openPending } = useSolanaSurface();
  // "NOT CONNECTING" IS NOT SAID BEFORE IT IS KNOWN. WalletProvider starts the
  // restore of a saved wallet in its own effect, after this component's first
  // one: a first report of `connecting: false` would be a guess, and the
  // wallet sheet acted on it (it closed and opened the list while a restore
  // was about to start). So this reports "connecting" until a render has seen
  // its own report in the store, which is a render after that effect.
  const [settled, setSettled] = useState(false);
  if (!settled && surface?.open === open) setSettled(true);
  const busy = connecting || !settled;
  useEffect(() => {
    setSolanaSurface(owner, { open, address, connecting: busy }, own);
  }, [owner, open, address, busy, own]);
  useEffect(() => {
    if (surface?.open !== open || !openPending || connecting) return;
    // A restore that connected answers the tap; otherwise it is the card's click.
    // Never over another dialog the visitor opened while waiting: overlays are
    // not stacked here, and one Escape closed both in the wrong order, which
    // left the page's scroll locked until a reload. The tap is still used up.
    if (takeSolanaOpenRequest() && !address && !document.querySelector('[aria-modal="true"]')) open();
  }, [surface, openPending, connecting, address, open]);
  // A restore that does not end stops holding the tap (see the header).
  const { visible, setVisible } = useWalletModal();
  useEffect(() => {
    if (surface?.open !== open || !openPending || !connecting) return;
    if (visible) {
      takeSolanaOpenRequest();
      return;
    }
    const timer = window.setTimeout(() => {
      if (takeSolanaOpenRequest() && !document.querySelector('[aria-modal="true"]')) open();
    }, SOLANA_CONNECT_WAIT_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [surface, openPending, connecting, open, visible]);
  // This page was opened by an "Open app" press in another browser (see
  // lib/solanaSurface.ts): it carries on from that press. Inside a wallet's
  // own browser one wallet is detected, and it is asked to connect, which is
  // what the visitor pressed for. Anything else is their choice to make: the
  // list opens. With no wallet detected nothing happens, and the hand-off
  // lapses: a detection that comes late (Trust on some Android builds) changes
  // `wallets` and runs this again. `settled` and `connecting`: as for the
  // early tap above.
  //
  // ONLY A WALLET'S OWN BROWSER ASKS BY ITSELF. Anyone can write the marker
  // into a link. In an ordinary phone browser that carries one wallet of its
  // own (Brave's, a Safari extension) such a link made that wallet prompt with
  // no press, or reconnect in silence after a Disconnect (review, 2026-10-03).
  // An ordinary phone browser is told by its "Open app" rows: a wallet's own
  // browser has none (the adapters offer that hop only where they can leave).
  // There the list is opened and nothing is asked: asking is a press.
  useEffect(() => {
    if (!settled || connecting || !solanaHandoffPending()) return;
    if (connected) {
      takeSolanaHandoff();
      return;
    }
    const detected = wallets.filter((w) => w.readyState === WalletReadyState.Installed);
    if (detected.length === 0 || !takeSolanaHandoff()) return;
    const ordinaryBrowser = wallets.some((w) => opensInWalletApp(w.readyState, w.adapter.name));
    const only = detected.length === 1 && !ordinaryBrowser ? detected[0]!.adapter.name : null;
    if (only) {
      // Saved already (an earlier visit inside this wallet's app): open() connects it.
      if (wallet?.adapter.name === only) open();
      else select(only);
    } else if (!document.querySelector('[aria-modal="true"]')) setVisible(true);
  }, [settled, connecting, connected, wallets, wallet, select, open, setVisible]);
  useEffect(() => () => setSolanaSurface(owner, null), [owner]);
  return null;
}

/**
 * Mounted for a hand-off, the top bar's own connection restores a saved wallet
 * only where one really connected in this browser and was not disconnected
 * since: the rule TopBarSolana uses to decide whether to mount it at all on a
 * later visit. A hand-off is started by a marker in the address, which anyone
 * can write into a link, and WalletProvider's plain `autoConnect` restores
 * whatever name is saved. In an ordinary phone browser such a link reconnected
 * a wallet the visitor had never connected here, and made a wallet whose
 * restore is a full connect (Trust's injected provider) prompt with no press
 * (skeptic, 2026-10-03). Mounted by the visitor's own press on the Solana row,
 * it restores as before. A page's own connection keeps the plain rule: it is
 * mounted by the page, never by a link.
 */
const restoreOwn = async () => !solanaHandoffPending() || solanaWasConnectedHere();

/**
 * `own` marks the top bar's own connection (TopBarSolanaProviders below), the
 * one mounted where the page has no Solana section. Every page site leaves it
 * unset.
 */
export function SolanaProviders({ children, own = false }: { children: ReactNode; own?: boolean }) {
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
      <WalletProvider wallets={wallets} autoConnect={own ? restoreOwn : true}>
        <SolanaWalletModalProvider>
          <SolanaSurfaceBridge own={own} />
          {children}
        </SolanaWalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}

/**
 * The top bar's own Solana connection, for pages with no Solana section (the
 * home page, the Earn list, the doors, the Ethereum pages). It is this same
 * provider with nothing inside but the wallet list. components/layout/
 * TopBarSolana.tsx loads it lazily, only once Solana is asked for or a Solana
 * wallet is saved, and unmounts it wherever a page brings its own: one live
 * connection per page (lib/solanaSurface.ts).
 */
export function TopBarSolanaProviders() {
  return <SolanaProviders own>{null}</SolanaProviders>;
}
