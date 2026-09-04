import { getDefaultConfig, getDefaultWallets } from '@rainbow-me/rainbowkit';
import { createConfig } from 'wagmi';
import { injected, coinbaseWallet } from 'wagmi/connectors';
import { phantomWallet, trustWallet } from './rainbowkitWallets';
import { WAGMI_CHAINS, WAGMI_TRANSPORTS } from './chains/viemChains';

const projectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID as string | undefined;

// MULTICHAIN (2026-08-20): chains and transports are DERIVED from the chain
// registry via chains/viemChains.ts — Ethereum, Base, Robinhood Chain. The RPC
// roster rules (real-read verification, ACAO:*, CSP allowlisting, viem `rank`
// health-ranking — R075) live there with the rosters themselves.
//
// THE FLIP THIS CAUSED, so nobody re-discovers it: with >1 chain configured,
// `useChainId()` follows the wallet instead of pinning to 1. Every mainnet-only
// surface keeps its explicit `chainId: CHAIN_ID` pins (reads keep coming from
// mainnet regardless of wallet chain — deliberate, F198) and its own
// switch-to-mainnet write guards. The GLOBAL wrong-network banner now means
// "chain we do not serve at all" (see AppLayout), not "not mainnet".
const transports = WAGMI_TRANSPORTS;

// ─── THE APPKIT BOOT COST, and why it is not removable here ─────────────────
// Investigated 2026-09-03 after a field review reported "two wallet stacks
// running in the same page" and prescribed deleting the AppKit provider.
//
// There is no AppKit provider in src/ to delete. Reown AppKit arrives as a
// transitive dependency of @walletconnect/ethereum-provider — which is a
// deliberate DIRECT dependency here, guarding the WALLET-03 optional-peer
// throwing-stub trap. It must stay.
//
// The chain that actually loads it, each link verified in the installed
// packages rather than inferred:
//   1. RainbowKit's connectorsForWallets mints a SECOND, HIDDEN WalletConnect
//      connector whenever a wallet with id 'walletConnect' is in the list
//      (rainbowkit/dist/index.js:7041-7050). It carries showQrModal:true and
//      exists only to power the "open the official WalletConnect modal" escape
//      hatch; index.js:2069-2079 filters it OUT of the rendered wallet list.
//   2. wagmi's createConfig calls `connector.setup?.()` on every connector at
//      CONFIG-CREATION time (@wagmi/core/createConfig.js:70).
//   3. walletConnect's setup() calls `this.getProvider()`
//      (@wagmi/connectors/walletConnect.js), which dynamically imports
//      @walletconnect/ethereum-provider and runs EthereumProvider.init.
//   4. That package imports `createAppKit` from @reown/appkit/core if — and
//      only if — showQrModal is true. The hidden connector's is.
//
// So AppKit initialises at MODULE SCOPE, when this file builds the config,
// before React renders anything. Observable on a cold profile with no
// extension and zero interaction: a request to
// api.web3modal.org/appkit/v1/project-limits, and four @appkit/* keys written
// to localStorage.
//
// WHAT DOES NOT FIX IT — checked, measured, and reverted rather than shipped:
//   · `reconnectOnMount={false}` on WagmiProvider, plus a hand-rolled
//     reconnect() that filters the hidden connector out. AppKit still booted
//     with reconnect disabled entirely, because step 2 happens at createConfig,
//     not at reconnect. Do not re-attempt this.
//   · Clearing the @appkit/* keys. They are a symptom.
//
// WHAT WOULD FIX IT, and why it is not done here: dropping walletConnectWallet
// from the list below removes step 1 and the whole chain with it. That is a
// product decision, not a cleanup — it costs the generic "any wallet via QR"
// path, and worse, existing users holding a session on the plain walletConnect
// connector would come back disconnected. Renaming the wallet id to dodge
// RainbowKit's check has the same disconnect consequence, since the id keys the
// stored session.
//
// The two connectors do NOT contend, contrary to the review's diagnosis:
// RainbowKit gives them distinct customStoragePrefix values ("clientOne" /
// "clientTwo") for exactly that reason, and sets telemetryEnabled:false. The
// cost here is weight, not correctness — so it is documented, not papered over.
function buildConfig() {
  if (projectId) {
    return getDefaultConfig({
      appName: 'memetics.finance',
      projectId,
      chains: WAGMI_CHAINS as never,
      transports,
      // getDefaultConfig's own default list (getDefaultWallets(): safe /
      // rainbow / baseAccount / metaMask / walletConnect — taken from the
      // library so it can never drift), plus the two wallets its default
      // omits: Phantom and Trust. Neither shipped an entry, so a browser
      // without the extension never saw the option at all (an installed
      // extension only surfaced via EIP-6963 discovery, and the MOBILE modal
      // renders RainbowKit entries only — both were invisible there in every
      // state). When an extension IS installed the modal merges our entry
      // with the EIP-6963 announcement by rdns rather than listing it twice.
      //
      // Both are VENDORED (see lib/rainbowkitWallets.ts): the package's
      // /wallets barrel is unbuildable against wagmi 3.7.6
      // (portoWallet/geminiWallet chunks import named exports wagmi doesn't
      // ship — rolldown MISSING_EXPORT at build time, green everywhere else).
      // Phantom is injected-only; Trust falls back to WalletConnect (QR on
      // desktop, trust:// deep link on mobile), whose optional peer
      // @walletconnect/ethereum-provider is already installed and guarded by
      // walletConnectorDeps.test.ts — so neither can hit the WALLET-03
      // throwing-stub trap.
      wallets: (() => {
        const { wallets } = getDefaultWallets();
        const popular = wallets[0]!;
        // ORDER IS LOAD-BEARING ON MOBILE. RainbowKit's MobileOptions renders
        // the wallets in a horizontally-scrolling strip that shows about four
        // before you have to swipe, so anything appended to the end is
        // effectively invisible on a phone (that is exactly how Trust ended up
        // unreachable on an iPhone: 5th of 5). Lead with the wallets this
        // venue's users actually reach for, and let the long tail scroll.
        //
        // The SET still comes from getDefaultWallets() so it cannot drift; only
        // the display order is ours. walletConnectorOrder.test.ts pins the
        // upstream default list by id, so a RainbowKit change that reorders or
        // renames these fails loudly instead of silently reshuffling the strip.
        const [safe, rainbow, base, metaMask, walletConnect] = popular.wallets;
        return [
          {
            ...popular,
            // Both vendored wallets go in BARE, exactly like the defaults:
            // connectorsForWallets calls each factory with the projectId AND
            // the app metadata it computes (walletConnectParameters). Wrapping
            // Trust to pass our own projectId would drop that metadata and
            // leave its users approving a nameless WalletConnect session.
            wallets: [safe, metaMask, phantomWallet, trustWallet, walletConnect, rainbow, base].filter(
              (w): w is NonNullable<typeof w> => Boolean(w),
            ),
          },
        ];
      })(),
    });
  }

  if (import.meta.env.DEV) {
    console.warn(
      'VITE_WALLETCONNECT_PROJECT_ID is not set. WalletConnect is disabled; only injected wallets (MetaMask, etc.) are available.',
    );
  }

  // FE-E2E-01: when no WC projectId is set (CI, preview builds, fresh clones)
  // we still need the app to mount. RainbowKit's wallet wrappers (metaMaskWallet,
  // coinbaseWallet) all reach into @walletconnect/sign-client at construction and
  // throw "No projectId found", crashing the React root. Drop down to bare wagmi
  // connectors — `injected` covers MetaMask + Rabby + Frame + any EIP-1193
  // provider, and `coinbaseWallet` uses its own SDK without WalletConnect.
  return createConfig({
    connectors: [
      injected({ shimDisconnect: true }),
      coinbaseWallet({ appName: 'memetics.finance' }),
    ],
    chains: WAGMI_CHAINS as never,
    transports,
  });
}

export const config = buildConfig();
