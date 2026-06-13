import { getDefaultConfig } from '@rainbow-me/rainbowkit';
import { createConfig, http, fallback } from 'wagmi';
import { injected, coinbaseWallet } from 'wagmi/connectors';
import { mainnet } from 'wagmi/chains';

const projectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID as string | undefined;

// Reliable public RPCs with fallback — avoids rate-limiting on default RPC.
// R075: `rank: true` enables viem's healthy-RPC ranking — slow / lying nodes
// get demoted to lower priority on the next request, matching the upstream
// pattern used by Curve / Velodrome / Aerodrome UIs.
const transports = {
  [mainnet.id]: fallback([
    http('https://ethereum-rpc.publicnode.com'),
    http('https://rpc.ankr.com/eth'),
    http('https://cloudflare-eth.com'),
    // F511/F517: removed the `eth.llamarpc.com` last-resort transport — its
    // origin returns no `Access-Control-Allow-Origin` header, so every
    // fall-through fails CORS preflight (net::ERR_FAILED) and spams the
    // console, masking real failures. The three endpoints above are all
    // allowlisted in vercel.json `connect-src` and CORS-clean.
    // NOTE: the bare `http()` default was already removed earlier — it
    // resolves to eth.merkle.io, which is NOT in the CSP allowlist.
  ], { rank: true }),
};

function buildConfig() {
  if (projectId) {
    return getDefaultConfig({
      appName: 'Tegridy Farms',
      projectId,
      chains: [mainnet],
      transports,
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
      coinbaseWallet({ appName: 'Tegridy Farms' }),
    ],
    chains: [mainnet],
    transports,
  });
}

export const config = buildConfig();
