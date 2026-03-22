import { getDefaultConfig } from '@rainbow-me/rainbowkit';
import { mainnet } from 'wagmi/chains';

export const config = getDefaultConfig({
  appName: 'Tegridy Farms',
  projectId: import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || '9baedfffd6e8ec85ffa2739753fd9c8d',
  chains: [mainnet],
});
