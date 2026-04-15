// TOWELI Token
export const TOWELI_ADDRESS = '0x420698CFdEDdEa6bc78D59bC17798113ad278F9D' as const;

// Core Contracts — DEPLOYED ON MAINNET (audit-fixed v2)
export const TEGRIDY_STAKING_ADDRESS = '0x65D8b87917c59a0B33009493fB236bCccF1Ea421' as const;
export const TEGRIDY_RESTAKING_ADDRESS = '0xfba4D340759Ae4c36DfFC6C773D171bf7BDCaEe4' as const;

// Native DEX
export const TEGRIDY_FACTORY_ADDRESS = '0x8B786163aA3beb97822d480a0c306DfD6dEbdCB6' as const;
export const TEGRIDY_ROUTER_ADDRESS = '0xCBCF6AcC4697cA3a7D7658Cd2051606a09c9863F' as const;
export const TEGRIDY_LP_ADDRESS = '0xeD01d5f52EBE97360133bdeF77305ee24d5f26f6' as const;

// Revenue & Fees
export const REVENUE_DISTRIBUTOR_ADDRESS = '0x332aaE555b1164eA45c2291fD7eDfa97aAA264D8' as const;
export const SWAP_FEE_ROUTER_ADDRESS = '0xea13Cd47a37cC5B59675bfd52BFc8ff8691937A0' as const;
export const POL_ACCUMULATOR_ADDRESS = '0x17215f0dfA5E97c33c025E0560eeddffaD87B7Ca' as const;

// LP Farming
export const LP_FARMING_ADDRESS = '0xa5AB522C99F86dEd9F429766872101c75517D77c' as const;

// Gauge Controller
export const GAUGE_CONTROLLER_ADDRESS = '0x0000000000000000000000000000000000000000' as const; // Deploy pending

// Community
export const COMMUNITY_GRANTS_ADDRESS = '0x8f1Ba1eC97a932EE1332BA0f366BC6aDf60B3032' as const;
export const MEME_BOUNTY_BOARD_ADDRESS = '0x3457C2210be35bA7AF6F382a76247Ecd782BF0C9' as const;
export const REFERRAL_SPLITTER_ADDRESS = '0xd3d46C0d25Ef1F4EAdb58b9218AA23Ed4c2f2c16' as const;
export const PREMIUM_ACCESS_ADDRESS = '0xaA16dF3dC66c7A6aD7db153711329955519422Ad' as const;
export const VOTE_INCENTIVES_ADDRESS = '0x417F44aee21Cc709262e71A7fdF6028cc17eCf1A' as const;

// V3 Features — Deployed 2026-04-14
export const TEGRIDY_LENDING_ADDRESS = '0xd471e5675EaDbD8C192A5dA2fF44372D5713367f' as const;
export const TEGRIDY_LAUNCHPAD_ADDRESS = '0x5d597647D5f57aEFba727C160C4C67eEcC0FF3C2' as const;
export const TEGRIDY_NFT_POOL_FACTORY_ADDRESS = '0x1C0e1771943fbB299f4E19daD0fAA4Fa4e6c04f0' as const;
export const TEGRIDY_TOKEN_URI_READER_ADDRESS = '0x0f165D012fA46E267Bd846BdAFf9Fd4607fdD702' as const;
export const TEGRIDY_NFT_LENDING_ADDRESS = '0x63baD13f89186E0769F636D4Cd736eB26E2968aD' as const;
export const TEGRIDY_TWAP_ADDRESS = '0x1394A256e127814B52244Bbd0CCB94f0007dBe25' as const;

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
