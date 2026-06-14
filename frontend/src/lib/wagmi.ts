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
    // Roster re-verified live 2026-06-14 via a REAL read (eth_blockNumber +
    // Origin), NOT the eth_chainId trap: publicnode, drpc, eth.merkle.io all
    // return the current block with `access-control-allow-origin: *`. Dropped
    // cloudflare-eth — earlier notes called it "live" off eth_chainId, but it
    // returns -32046 "Cannot fulfill request" / -32603 on every real read/
    // eth_call (the Cloudflare Web3 gateway is sunset for data methods), so it
    // was a dead 3rd fallback for contract reads. ankr excluded (keyless -32000
    // Unauthorized); eth.llamarpc.com excluded (HTTP 521 + no ACAO).
    // eth.merkle.io is allowlisted in the vercel.json CSP connect-src.
    http('https://ethereum-rpc.publicnode.com'),
    http('https://eth.drpc.org'),
    http('https://eth.merkle.io'),
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
