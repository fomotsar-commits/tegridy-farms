import { getDefaultConfig } from '@rainbow-me/rainbowkit';
import { connectorsForWallets } from '@rainbow-me/rainbowkit';
import { injectedWallet, metaMaskWallet, coinbaseWallet } from '@rainbow-me/rainbowkit/wallets';
import { createConfig, http, fallback } from 'wagmi';
import { webSocket } from 'viem';
import { mainnet } from 'wagmi/chains';

const projectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID as string | undefined;

// P0-3: WebSocket transport for `watch: true` subscriptions. viem's fallback
// transport auto-selects WS for `eth_subscribe`-class operations (block
// watchers, contract event watchers) and HTTP for one-shot reads, so this is
// purely additive — existing read flows stay on HTTP.
//
// `VITE_WS_RPC_URL` lets operators point at a private endpoint (Alchemy,
// Infura, Quicknode). Default is a public no-key endpoint that supports
// `eth_subscribe`; documented in `.env.example`.
const WS_RPC_URL =
  (import.meta.env.VITE_WS_RPC_URL as string | undefined) ||
  'wss://ethereum-rpc.publicnode.com';

// Reliable public RPCs with fallback — avoids rate-limiting on default RPC.
// R075: `rank: true` enables viem's healthy-RPC ranking — slow / lying nodes
// get demoted to lower priority on the next request, matching the upstream
// pattern used by Curve / Velodrome / Aerodrome UIs.
const transports = {
  [mainnet.id]: fallback([
    webSocket(WS_RPC_URL),
    http('https://ethereum-rpc.publicnode.com'),
    http('https://eth.llamarpc.com'),
    http('https://rpc.ankr.com/eth'),
    http(), // wagmi default public fallback
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

  const connectors = connectorsForWallets(
    [
      {
        groupName: 'Popular',
        wallets: [injectedWallet, metaMaskWallet, coinbaseWallet],
      },
    ],
    { appName: 'Tegridy Farms', projectId: '' },
  );

  return createConfig({
    connectors,
    chains: [mainnet],
    transports,
  });
}

export const config = buildConfig();
