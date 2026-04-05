// TOWELI Token
export const TOWELI_ADDRESS = '0x420698CFdEDdEa6bc78D59bC17798113ad278F9D' as const;

// Core Contracts — DEPLOYED ON MAINNET (audit-fixed v2)
export const TEGRIDY_STAKING_ADDRESS = '0x626644523d34B84818df602c991B4a06789C4819' as const;
export const TEGRIDY_RESTAKING_ADDRESS = '0xfE2E5B534cfc3b35773aA26A73beF16B028B0268' as const;

// Native DEX
export const TEGRIDY_FACTORY_ADDRESS = '0x8B786163aA3beb97822d480a0c306DfD6dEbdCB6' as const;
export const TEGRIDY_ROUTER_ADDRESS = '0xCBCF6AcC4697cA3a7D7658Cd2051606a09c9863F' as const;
export const TEGRIDY_LP_ADDRESS = '0xeD01d5f52EBE97360133bdeF77305ee24d5f26f6' as const;

// Revenue & Fees
export const REVENUE_DISTRIBUTOR_ADDRESS = '0xf00964D5F5fB0a4d4AFEa0999843DA31BbE9A7aF' as const;
export const SWAP_FEE_ROUTER_ADDRESS = '0xd8f13c7F3e0C4139D1905914a99F2E9F77A4aD37' as const;
export const POL_ACCUMULATOR_ADDRESS = '0x17215f0dfA5E97c33c025E0560eeddffaD87B7Ca' as const;

// LP Farming
export const LP_FARMING_ADDRESS = '0xa5AB522C99F86dEd9F429766872101c75517D77c' as const;

// Community
export const COMMUNITY_GRANTS_ADDRESS = '0xEb00Fb134699634215ebF5Ea3a4D6FF3872a5B34' as const;
export const MEME_BOUNTY_BOARD_ADDRESS = '0xAd9b32272376774d18F386A7676Bd06D7E33c647' as const;
export const REFERRAL_SPLITTER_ADDRESS = '0x2ADe96633Ee51400E60De00f098280f07b92b060' as const;
export const PREMIUM_ACCESS_ADDRESS = '0x514553EAcfCb91E05Db0a5e9B09d69d7e9CBaf20' as const;
export const VOTE_INCENTIVES_ADDRESS = '0xc39f788939499c28229739d3DD66F1866da41138' as const;

// Uniswap V2 (external routing fallback)
export const UNISWAP_V2_ROUTER = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D' as const;
export const WETH_ADDRESS = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as const;
export const UNISWAP_V2_FACTORY = '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f' as const;

// Uniswap V2 TOWELI/WETH LP Token
export const TOWELI_WETH_LP_ADDRESS = '0x6682Ac593513cc0A6c25D0F3588e8fA4FF81104D' as const;

// Chainlink ETH/USD Price Feed
export const ETH_USD_FEED = '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419' as const;

// Treasury
export const TREASURY_ADDRESS = '0xE9B7aB8e367bE5AC0e0c865136f1907bd73df53e' as const;

// Jungle Bay NFTs
export const JBAC_NFT_ADDRESS = '0xd37264c71e9af940e49795F0d3a8336afAaFDdA9' as const;
export const JBAY_GOLD_ADDRESS = '0x6Aa03F42c5366E2664c887eb2e90844CA00B92F3' as const;

// Chain
export const CHAIN_ID = 1;

// Token info
export const TOWELI_DECIMALS = 18;
export const TOWELI_TOTAL_SUPPLY = 1_000_000_000; // 1B TOWELI

// Staking constants (mirrors TegridyStaking.sol)
export const MIN_LOCK_DURATION = 7 * 24 * 60 * 60; // 7 days in seconds
export const MAX_LOCK_DURATION = 4 * 365 * 24 * 60 * 60; // 4 years in seconds
export const MIN_BOOST_BPS = 4000; // 0.4x
export const MAX_BOOST_BPS = 40000; // 4.0x
export const JBAC_BONUS_BPS = 5000; // +0.5x
export const EARLY_WITHDRAWAL_PENALTY_BPS = 2500; // 25%

// Helper: check if an address is deployed (not zero address)
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
export function isDeployed(address: string): boolean {
  return address !== ZERO_ADDRESS;
}

// Farming Seasons
export const CURRENT_SEASON = {
  number: 2,
  name: 'Season 2',
  startDate: '2026-01-01',
  endDate: '2026-06-01',
  totalRewards: 26_000_000,
};

// External links
export const ETHERSCAN_TOKEN = `https://etherscan.io/token/${TOWELI_ADDRESS}`;
export const UNISWAP_BUY_URL = `https://app.uniswap.org/swap?outputCurrency=${TOWELI_ADDRESS}&chain=ethereum`;
export const UNISWAP_ADD_LIQUIDITY_URL = `https://app.uniswap.org/add/v2/ETH/${TOWELI_ADDRESS}`;
export const GECKOTERMINAL_URL = `https://www.geckoterminal.com/eth/pools/${TOWELI_WETH_LP_ADDRESS}`;
export const GECKOTERMINAL_EMBED = `https://www.geckoterminal.com/eth/pools/${TOWELI_WETH_LP_ADDRESS}?embed=1&info=0&swaps=0&light_chart=0`;
