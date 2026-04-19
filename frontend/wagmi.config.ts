import { defineConfig } from '@wagmi/cli';
import { react } from '@wagmi/cli/plugins';

// Import ABIs from the existing contracts file
import {
  TEGRIDY_STAKING_ABI,
  TEGRIDY_RESTAKING_ABI,
  ERC20_ABI,
  SWAP_FEE_ROUTER_ABI,
  PREMIUM_ACCESS_ABI,
  REVENUE_DISTRIBUTOR_ABI,
  COMMUNITY_GRANTS_ABI,
  MEME_BOUNTY_BOARD_ABI,
  VOTE_INCENTIVES_ABI,
  LP_FARMING_ABI,
  TEGRIDY_LENDING_ABI,
  TEGRIDY_LAUNCHPAD_ABI,
  TEGRIDY_LAUNCHPAD_V2_ABI,
  TEGRIDY_DROP_V2_ABI,
  TEGRIDY_NFT_POOL_FACTORY_ABI,
  TEGRIDY_NFT_LENDING_ABI,
  GAUGE_CONTROLLER_ABI,
  REFERRAL_SPLITTER_ABI,
  TEGRIDY_ROUTER_ABI,
  TEGRIDY_FACTORY_ABI,
} from './src/lib/contracts';

import {
  TEGRIDY_STAKING_ADDRESS,
  SWAP_FEE_ROUTER_ADDRESS,
  PREMIUM_ACCESS_ADDRESS,
  REVENUE_DISTRIBUTOR_ADDRESS,
  COMMUNITY_GRANTS_ADDRESS,
  MEME_BOUNTY_BOARD_ADDRESS,
  VOTE_INCENTIVES_ADDRESS,
  LP_FARMING_ADDRESS,
  TEGRIDY_LENDING_ADDRESS,
  TEGRIDY_LAUNCHPAD_ADDRESS,
  TEGRIDY_LAUNCHPAD_V2_ADDRESS,
  TEGRIDY_NFT_POOL_FACTORY_ADDRESS,
  TEGRIDY_NFT_LENDING_ADDRESS,
  GAUGE_CONTROLLER_ADDRESS,
  REFERRAL_SPLITTER_ADDRESS,
  TEGRIDY_ROUTER_ADDRESS,
  TEGRIDY_FACTORY_ADDRESS,
  TEGRIDY_RESTAKING_ADDRESS,
  TOWELI_ADDRESS,
} from './src/lib/constants';

export default defineConfig({
  out: 'src/generated.ts',
  contracts: [
    { name: 'TegridyStaking', abi: TEGRIDY_STAKING_ABI, address: TEGRIDY_STAKING_ADDRESS },
    { name: 'TegridyRestaking', abi: TEGRIDY_RESTAKING_ABI, address: TEGRIDY_RESTAKING_ADDRESS },
    { name: 'Toweli', abi: ERC20_ABI, address: TOWELI_ADDRESS },
    { name: 'SwapFeeRouter', abi: SWAP_FEE_ROUTER_ABI, address: SWAP_FEE_ROUTER_ADDRESS },
    { name: 'PremiumAccess', abi: PREMIUM_ACCESS_ABI, address: PREMIUM_ACCESS_ADDRESS },
    { name: 'RevenueDistributor', abi: REVENUE_DISTRIBUTOR_ABI, address: REVENUE_DISTRIBUTOR_ADDRESS },
    { name: 'CommunityGrants', abi: COMMUNITY_GRANTS_ABI, address: COMMUNITY_GRANTS_ADDRESS },
    { name: 'MemeBountyBoard', abi: MEME_BOUNTY_BOARD_ABI, address: MEME_BOUNTY_BOARD_ADDRESS },
    { name: 'VoteIncentives', abi: VOTE_INCENTIVES_ABI, address: VOTE_INCENTIVES_ADDRESS },
    { name: 'LPFarming', abi: LP_FARMING_ABI, address: LP_FARMING_ADDRESS },
    { name: 'TegridyLending', abi: TEGRIDY_LENDING_ABI, address: TEGRIDY_LENDING_ADDRESS },
    { name: 'TegridyLaunchpad', abi: TEGRIDY_LAUNCHPAD_ABI, address: TEGRIDY_LAUNCHPAD_ADDRESS },
    { name: 'TegridyLaunchpadV2', abi: TEGRIDY_LAUNCHPAD_V2_ABI, address: TEGRIDY_LAUNCHPAD_V2_ADDRESS },
    // V2 Drop is a per-clone contract — no single address, each deployed collection
    // has its own. Wagmi generates typed read/write hooks from the ABI alone.
    { name: 'TegridyDropV2', abi: TEGRIDY_DROP_V2_ABI },
    { name: 'TegridyNFTPoolFactory', abi: TEGRIDY_NFT_POOL_FACTORY_ABI, address: TEGRIDY_NFT_POOL_FACTORY_ADDRESS },
    { name: 'TegridyNFTLending', abi: TEGRIDY_NFT_LENDING_ABI, address: TEGRIDY_NFT_LENDING_ADDRESS },
    { name: 'GaugeController', abi: GAUGE_CONTROLLER_ABI, address: GAUGE_CONTROLLER_ADDRESS },
    { name: 'ReferralSplitter', abi: REFERRAL_SPLITTER_ABI, address: REFERRAL_SPLITTER_ADDRESS },
    { name: 'TegridyRouter', abi: TEGRIDY_ROUTER_ABI, address: TEGRIDY_ROUTER_ADDRESS },
    { name: 'TegridyFactory', abi: TEGRIDY_FACTORY_ABI, address: TEGRIDY_FACTORY_ADDRESS },
  ],
  plugins: [react()],
});
