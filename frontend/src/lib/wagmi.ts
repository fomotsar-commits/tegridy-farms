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
        // Both go in BARE, exactly like the defaults: connectorsForWallets
        // calls each factory with the projectId AND the app metadata it
        // computes (walletConnectParameters). Wrapping Trust to pass our own
        // projectId would drop that metadata and leave its users approving a
        // nameless WalletConnect session.
        return [
          { ...popular, wallets: [...popular.wallets, phantomWallet, trustWallet] },
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
