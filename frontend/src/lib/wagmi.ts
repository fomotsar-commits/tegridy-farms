import { getDefaultConfig } from '@rainbow-me/rainbowkit';
import { mainnet } from 'wagmi/chains';

export const config = getDefaultConfig({
  appName: 'Tegridy Farms',
  projectId: import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || 'b1e6d6e4f5a4b3c2d1e0f9a8b7c6d5e4',
  chains: [mainnet],
});
