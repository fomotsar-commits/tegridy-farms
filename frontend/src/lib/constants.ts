// TOWELI Token
export const TOWELI_ADDRESS = '0x420698CFdEDdEa6bc78D59bC17798113ad278F9D' as const;

// Core Contracts — DEPLOYED ON MAINNET (audit-fixed v2)
export const TEGRIDY_STAKING_ADDRESS = '0x044A925839ac3CEC0bccC93d00230f39FFbeEe44' as const;
export const TEGRIDY_RESTAKING_ADDRESS = '0xC5305754cD9707a5138dC458765d522b2E26d4b9' as const;

// Native DEX
export const TEGRIDY_FACTORY_ADDRESS = '0x8B786163aA3beb97822d480a0c306DfD6dEbdCB6' as const;
export const TEGRIDY_ROUTER_ADDRESS = '0xE9A4fb4bB72254F420a2585ab8abac3A816C215e' as const;

// Revenue & Fees
export const REVENUE_DISTRIBUTOR_ADDRESS = '0x454446936E237FC71f730445a768fA0EF651539C' as const;
export const SWAP_FEE_ROUTER_ADDRESS = '0x71EaeCa0f75Ca3d4C757b27825920E3d0Fa839bd' as const;
export const POL_ACCUMULATOR_ADDRESS = '0x0000000000000000000000000000000000000000' as const; // Not yet deployed

// Community
export const COMMUNITY_GRANTS_ADDRESS = '0x491407b9a11602CFD0A6b299235E601dc3fb1421' as const;
export const MEME_BOUNTY_BOARD_ADDRESS = '0x50D98027757Aa9B78ef67D329bA8E1da34D77BC5' as const;
export const REFERRAL_SPLITTER_ADDRESS = '0x5A2c3382B3aDf54E44E6e94C859e24D7A3c07411' as const;
export const PREMIUM_ACCESS_ADDRESS = '0x84AA3Bf462ca7C07Ba20E4A1fA2ff8Fb78f08aF7' as const;
export const VOTE_INCENTIVES_ADDRESS = '0xcAD42933a2a9e654CF3f8634Bf0C5E72F0b7B3BA' as const;

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
