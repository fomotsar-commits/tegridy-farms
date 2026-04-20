// TOWELI Token
export const TOWELI_ADDRESS = '0x420698CFdEDdEa6bc78D59bC17798113ad278F9D' as const;

// Core Contracts — DEPLOYED ON MAINNET (audit-fixed v2, C-01 migration)
// 2026-04-17: swapped from 0x65D8... (paused) to 0x6266... per DEPLOY_CHEAT_SHEET §1 Gap A
export const TEGRIDY_STAKING_ADDRESS = '0x626644523d34B84818df602c991B4a06789C4819' as const;
export const TEGRIDY_RESTAKING_ADDRESS = '0xfba4D340759Ae4c36DfFC6C773D171bf7BDCaEe4' as const;

// Native DEX
export const TEGRIDY_FACTORY_ADDRESS = '0x8B786163aA3beb97822d480a0c306DfD6dEbdCB6' as const;
export const TEGRIDY_ROUTER_ADDRESS = '0xCBCF6AcC4697cA3a7D7658Cd2051606a09c9863F' as const;
export const TEGRIDY_LP_ADDRESS = '0xeD01d5f52EBE97360133bdeF77305ee24d5f26f6' as const;

// Revenue & Fees
export const REVENUE_DISTRIBUTOR_ADDRESS = '0x332aaE555b1164eA45c2291fD7eDfa97aAA264D8' as const;
export const SWAP_FEE_ROUTER_ADDRESS = '0xea13Cd47a37cC5B59675bfd52BFc8ff8691937A0' as const;
export const POL_ACCUMULATOR_ADDRESS = '0x17215f0dfA5E97c33c025E0560eeddffaD87B7Ca' as const;

// LP Farming — Wave 0 2026-04-18: C-01 fix (MAX_BOOST_BPS_CEILING=45000) redeploy
export const LP_FARMING_ADDRESS = '0xa7EF711Be3662B9557634502032F98944eC69ec1' as const;

// Gauge Controller — Wave 0 2026-04-18: H-2 commit-reveal redeploy
export const GAUGE_CONTROLLER_ADDRESS = '0xb93264aB0AF377F7C0485E64406bE9a9b1df0Fdb' as const;

// Community
export const COMMUNITY_GRANTS_ADDRESS = '0x8f1Ba1eC97a932EE1332BA0f366BC6aDf60B3032' as const;
export const MEME_BOUNTY_BOARD_ADDRESS = '0x3457C2210be35bA7AF6F382a76247Ecd782BF0C9' as const;
export const REFERRAL_SPLITTER_ADDRESS = '0xd3d46C0d25Ef1F4EAdb58b9218AA23Ed4c2f2c16' as const;
export const PREMIUM_ACCESS_ADDRESS = '0xaA16dF3dC66c7A6aD7db153711329955519422Ad' as const;
export const VOTE_INCENTIVES_ADDRESS = '0x417F44aee21Cc709262e71A7fdF6028cc17eCf1A' as const;

// V3 Features — Deployed 2026-04-14
export const TEGRIDY_LENDING_ADDRESS = '0xd471e5675EaDbD8C192A5dA2fF44372D5713367f' as const;
// V1 TegridyLaunchpad (0x5d5976...FF3C2) deleted from source 2026-04-19; existing
// V1 clones remain browseable on Etherscan. Use TEGRIDY_LAUNCHPAD_V2_ADDRESS.
export const TEGRIDY_NFT_POOL_FACTORY_ADDRESS = '0x1C0e1771943fbB299f4E19daD0fAA4Fa4e6c04f0' as const;
// Wave 0 2026-04-18: redeployed pointing at current staking (0x6266...)
export const TEGRIDY_TOKEN_URI_READER_ADDRESS = '0xfec9aea42ea966c9382eeb03f63a784579841eb2' as const;
// Wave 0 2026-04-18: C-02 grace period redeploy
export const TEGRIDY_NFT_LENDING_ADDRESS = '0x05409880aDFEa888F2c93568B8D88c7b4aAdB139' as const;
// Wave 0 2026-04-18: fresh TWAP oracle deploy
export const TEGRIDY_TWAP_ADDRESS = '0xddbe4cd58faf4b0b93e4e03a2493327ee3bb4995' as const;
// Wave 0 2026-04-18: Uniswap V4 fee hook (B7). Address ends in 0x0044 for
// AFTER_SWAP_FLAG|AFTER_SWAP_RETURNS_DELTA permissions. NOTE: deployed via
// Arachnid CREATE2 proxy — owner is the proxy (0x4e59b44...), not our EOA.
// Admin functions (pause, setFee, setDistributor) are stranded until we patch
// the constructor to accept _owner as arg and redeploy.
export const TEGRIDY_FEE_HOOK_ADDRESS = '0xB6cfeaCf243E218B0ef32B26E1dA1e13a2670044' as const;

// Launchpad V2 — click-deploy flow with single-tx createCollection + contractURI.
// Placeholder until DeployLaunchpadV2.s.sol broadcasts. Frontend can still list v1
// collections and fall through to the legacy form while this is zero.
export const TEGRIDY_LAUNCHPAD_V2_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

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
// TOWELI is a fixed-supply ERC20 — no mint/burn entrypoints. Safe to hardcode.
// If the token is ever replaced, regenerate this from `IERC20(TOWELI).totalSupply()`.
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
