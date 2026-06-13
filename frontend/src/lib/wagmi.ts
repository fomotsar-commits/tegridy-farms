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
    // drpc + merkle are healthy keyless backups — both CORS-clean (ACAO: *) and
    // now allowlisted in vercel.json `connect-src`. Replaced ankr (keyless now
    // requires an API key) and cloudflare-eth (gateway sunset) — both verified
    // dead 2026-06-13, returning JSON-RPC errors despite HTTP 200.
    http('https://eth.drpc.org'),
    http('https://eth.merkle.io'),
    // F511/F517: eth.llamarpc.com is intentionally NOT included — its origin
    // returns no `Access-Control-Allow-Origin` header, so browser fall-through
    // fails CORS preflight (net::ERR_FAILED) and spams the console. (Also 521
    // origin-down in prod on 2026-06-13.)
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
