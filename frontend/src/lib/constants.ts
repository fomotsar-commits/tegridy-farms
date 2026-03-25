// TOWELI Token
export const TOWELI_ADDRESS = '0x420698cfdeddea6bc78d59bc17798113ad278f9d' as const;

// Core Contracts — DEPLOYED ON MAINNET
export const TEGRIDY_STAKING_ADDRESS = '0x00fd53d6d65db8a6edf34372ea4054c4f9fa8079' as const;
export const TEGRIDY_RESTAKING_ADDRESS = '0xed73d8836d04eab05c36a5c2dae90d2a73f8ec76' as const;

// Native DEX
export const TEGRIDY_FACTORY_ADDRESS = '0x8b786163aa3beb97822d480a0c306dfd6debdcb6' as const;
export const TEGRIDY_ROUTER_ADDRESS = '0xe9a4fb4bb72254f420a2585ab8abac3a816c215e' as const;

// Revenue & Fees
export const REVENUE_DISTRIBUTOR_ADDRESS = '0x98Db150102583cd7e431fBe4d67788256b069989' as const;
export const SWAP_FEE_ROUTER_ADDRESS = '0xC63A4824191Ea415A41995dE6E9CbEDBc8C51436' as const;
export const POL_ACCUMULATOR_ADDRESS = '0x0000000000000000000000000000000000000000' as const; // TODO: Deploy

// Community
export const COMMUNITY_GRANTS_ADDRESS = '0xD418A6FeFEC2fe1e2FE65339019e3bb8d3DadFd6' as const;
export const MEME_BOUNTY_BOARD_ADDRESS = '0xaC39998BD12c12c815aabFB0d3A782dBf7084e04' as const;
export const REFERRAL_SPLITTER_ADDRESS = '0x5575c214571847A73c7c771b252187b35925Ea3c' as const;
export const PREMIUM_ACCESS_ADDRESS = '0x2A44CbeBF23ff4a36F9cAbdd716Fa0Bee481C60d' as const;

// Uniswap V2 (external routing fallback)
export const UNISWAP_V2_ROUTER = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D' as const;
export const WETH_ADDRESS = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as const;
export const UNISWAP_V2_FACTORY = '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f' as const;

// Uniswap V2 TOWELI/WETH LP Token
export const TOWELI_WETH_LP_ADDRESS = '0x6682ac593513cc0a6c25d0f3588e8fa4ff81104d' as const;

// Chainlink ETH/USD Price Feed
export const ETH_USD_FEED = '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419' as const;

// Treasury
export const TREASURY_ADDRESS = '0xe9b7ab8e367be5ac0e0c865136f1907bd73df53e' as const;

// Jungle Bay NFTs
export const JBAC_NFT_ADDRESS = '0xd37264c71e9af940e49795f0d3a8336afaafdda9' as const;
export const JBAY_GOLD_ADDRESS = '0x6aa03f42c5366e2664c887eb2e90844ca00b92f3' as const;

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
  number: 1,
  name: 'Genesis Season',
  startDate: '2025-03-01',
  endDate: '2025-06-01',
  totalRewards: 26_000_000,
};

// External links
export const ETHERSCAN_TOKEN = `https://etherscan.io/token/${TOWELI_ADDRESS}`;
export const UNISWAP_BUY_URL = `https://app.uniswap.org/swap?outputCurrency=${TOWELI_ADDRESS}&chain=ethereum`;
export const UNISWAP_ADD_LIQUIDITY_URL = `https://app.uniswap.org/add/v2/ETH/${TOWELI_ADDRESS}`;
export const GECKOTERMINAL_URL = `https://www.geckoterminal.com/eth/pools/${TOWELI_WETH_LP_ADDRESS}`;
export const GECKOTERMINAL_EMBED = `https://www.geckoterminal.com/eth/pools/${TOWELI_WETH_LP_ADDRESS}?embed=1&info=0&swaps=0&light_chart=0`;
