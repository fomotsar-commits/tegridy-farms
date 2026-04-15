import { getDefaultConfig } from '@rainbow-me/rainbowkit';
import { connectorsForWallets } from '@rainbow-me/rainbowkit';
import { injectedWallet, metaMaskWallet, coinbaseWallet } from '@rainbow-me/rainbowkit/wallets';
import { createConfig, http, fallback } from 'wagmi';
import { mainnet } from 'wagmi/chains';

const projectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID as string | undefined;

// Reliable public RPCs with fallback — avoids rate-limiting on default RPC
const transports = {
  [mainnet.id]: fallback([
    http('https://ethereum-rpc.publicnode.com'),
    http('https://eth.llamarpc.com'),
    http('https://rpc.ankr.com/eth'),
    http(), // wagmi default public fallback
  ]),
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
