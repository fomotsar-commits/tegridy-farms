import { getDefaultConfig } from '@rainbow-me/rainbowkit';
import {
  baseAccount,
  metaMaskWallet,
  phantomWallet,
  rainbowWallet,
  safeWallet,
  walletConnectWallet,
} from '@rainbow-me/rainbowkit/wallets';
import { createConfig } from 'wagmi';
import { injected, coinbaseWallet } from 'wagmi/connectors';
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
      // getDefaultConfig's default list, verbatim, plus Phantom appended. The
      // default ships NO Phantom entry, so browsers without the extension never
      // saw a Phantom option at all (an installed extension only surfaced via
      // EIP-6963 discovery, and the MOBILE modal renders RainbowKit entries
      // only — Phantom was invisible there in every state). phantomWallet is a
      // pure injected connector (namespace phantom.ethereum, rdns app.phantom)
      // with no optional peer dependency, so it cannot hit the WALLET-03
      // throwing-stub trap; when the extension is installed, the modal merges
      // this entry with the EIP-6963 announcement by rdns instead of listing
      // it twice. NOTE: the third default is baseAccount (id 'base', the Base
      // Account passkey wallet), NOT coinbaseWallet — swapping it would change
      // production's connector.
      wallets: [
        {
          groupName: 'Popular',
          wallets: [
            safeWallet,
            rainbowWallet,
            baseAccount,
            metaMaskWallet,
            walletConnectWallet,
            phantomWallet,
          ],
        },
      ],
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
