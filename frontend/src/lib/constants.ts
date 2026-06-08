// TOWELI Token
export const TOWELI_ADDRESS = '0x420698CFdEDdEa6bc78D59bC17798113ad278F9D' as const;

// Core Contracts — RELAUNCH DEPLOYED ON MAINNET 2026-06-06 (DeployMVP, fresh wallet)
export const TEGRIDY_STAKING_ADDRESS = '0xcaDc93E96De58EA554c71ca609974625615E046D' as const;
// Restaking DEFERRED to Phase 7 (EIP-170 split). Zeroed until deployed; UI gates on isDeployed().
export const TEGRIDY_RESTAKING_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

// EIP-170 admin sister contracts — RELAUNCH 2026-06-06 (deployed + wired by DeployMVP).
export const TEGRIDY_STAKING_ADMIN_ADDRESS = '0x4B134C08aAF86B6e2A8E097D1039C4e7638806f3' as const;
export const SWAP_FEE_ROUTER_ADMIN_ADDRESS = '0xa517A1cEfd961c0DDE8155a0Fa870aEE5bb0D060' as const;
// Read-only staking view sister (EIP-170 split) — RELAUNCH 2026-06-06.
export const STAKING_MONITOR_VIEW_ADDRESS = '0xbE1E75124C7F07d5B681839C42d8e751f0d0fcfC' as const;

// Native DEX — RELAUNCH 2026-06-06 (DeployMVP); LP = our factory's TOWELI/WETH pair
export const TEGRIDY_FACTORY_ADDRESS = '0xa24C7287eC56A7DEFDc70033803451240e267a52' as const;
export const TEGRIDY_ROUTER_ADDRESS = '0xE9F83A07b071748E795d2489651d5310fA098Db8' as const;
export const TEGRIDY_LP_ADDRESS = '0x55875887B43C2E23aE424AF0FC8606Fdb058a481' as const;

// Revenue & Fees — RELAUNCH 2026-06-06 (DeployMVP)
export const REVENUE_DISTRIBUTOR_ADDRESS = '0xF993316E2fC079de4358c489A935E01e03E23E17' as const;
export const SWAP_FEE_ROUTER_ADDRESS = '0x6d5791A660e79175F74C6D639584C98422d5956E' as const;
export const POL_ACCUMULATOR_ADDRESS = '0x2A5f65f4C74b1e49e77aE9A57e20fBDb0cED11D2' as const;

// LP Farming — Wave 0 2026-04-18: C-01 fix (MAX_BOOST_BPS_CEILING=45000) redeploy
// ZEROED 2026-05-31 (relaunch supersedes Wave 0; no src contract, not in DeployMVP).
// Restore the real address after the relaunch redeploy. Prev: 0xa7EF711Be3662B9557634502032F98944eC69ec1
export const LP_FARMING_ADDRESS = '0x1171268AE5B69791c47Fd589b7825932c957e149' as const; // RELAUNCH 2026-06-08 (DeployTegridyLPFarming): boosted Synthetix LP staking; owner pending the 0xA360 Safe

// Gauge Controller — Wave 0 2026-04-18: H-2 commit-reveal redeploy
// ZEROED 2026-05-31 (relaunch supersedes Wave 0; no src contract, not in DeployMVP).
// Restore after redeploy. Prev: 0xb93264aB0AF377F7C0485E64406bE9a9b1df0Fdb
export const GAUGE_CONTROLLER_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

// Community
// ZEROED 2026-05-31 (relaunch; no src contract, not in DeployMVP). Prev: 0x8f1Ba1eC97a932EE1332BA0f366BC6aDf60B3032
export const COMMUNITY_GRANTS_ADDRESS = '0x0000000000000000000000000000000000000000' as const;
// ZEROED 2026-05-31 (relaunch; no src contract, not in DeployMVP). Prev: 0x3457C2210be35bA7AF6F382a76247Ecd782BF0C9
export const MEME_BOUNTY_BOARD_ADDRESS = '0x0000000000000000000000000000000000000000' as const;
export const REFERRAL_SPLITTER_ADDRESS = '0x6B3442dAcB62d40BA39fCe9b3CDa350FEa6f7e4c' as const; // RELAUNCH 2026-06-06 (DeployMVP)
// ZEROED 2026-05-31 (relaunch; no src contract, not in DeployMVP). Prev: 0xaA16dF3dC66c7A6aD7db153711329955519422Ad
export const PREMIUM_ACCESS_ADDRESS = '0x0000000000000000000000000000000000000000' as const;
// ZEROED 2026-05-31 (relaunch; no src contract, not in DeployMVP). Prev: 0x417F44aee21Cc709262e71A7fdF6028cc17eCf1A
export const VOTE_INCENTIVES_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

// V3 Features — Deployed 2026-04-14
export const TEGRIDY_LENDING_ADDRESS = '0x0000000000000000000000000000000000000000' as const; // ZEROED 2026-05-31 (relaunch; no src contract, not in DeployMVP). Prev: 0xd471e5675EaDbD8C192A5dA2fF44372D5713367f
// V1 TegridyLaunchpad (0x5d5976...FF3C2) deleted from source 2026-04-19; existing
// V1 clones remain browseable on Etherscan. Use TEGRIDY_LAUNCHPAD_V2_ADDRESS.
export const TEGRIDY_NFT_POOL_FACTORY_ADDRESS = '0x0000000000000000000000000000000000000000' as const; // ZEROED 2026-05-31 (relaunch; no src contract, not in DeployMVP). Prev: 0x1C0e1771943fbB299f4E19daD0fAA4Fa4e6c04f0
// RELAUNCH 2026-06-06 (DeployMVP)
export const TEGRIDY_TOKEN_URI_READER_ADDRESS = '0x5cfEe751eAf274F68b05267012b85a867dfCd326' as const;
// Wave 0 2026-04-18: C-02 grace period redeploy
export const TEGRIDY_NFT_LENDING_ADDRESS = '0x0000000000000000000000000000000000000000' as const; // ZEROED 2026-05-31 (relaunch; no src contract, not in DeployMVP). Prev: 0x05409880aDFEa888F2c93568B8D88c7b4aAdB139
// RELAUNCH 2026-06-06 (DeployMVP) — needs 4x update() bootstrap after LP seed (audit H-18)
export const TEGRIDY_TWAP_ADDRESS = '0xdFdd6D72539A425dC917F49FB834901105cA98c9' as const;
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

// Treasury — RELAUNCH 2026-06-06: 2-of-2 Safe (protocol funds)
export const TREASURY_ADDRESS = '0x7D2620243EdAd69Ec81A53c4A063B07995A4Bd7d' as const;

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
// RELAUNCH 2026-06-07: fresh season so the Farm doesn't show a stale "0d left".
// totalRewards = the 6.4M TOWELI actually funded for this ~90-day window
// (rewardRate 0.8243/s ≈ 71.2k/day × 90d). Adjust number/name/dates as desired.
export const CURRENT_SEASON = {
  number: 3,
  name: 'Season 3',
  startDate: '2026-06-07',
  endDate: '2026-09-05',
  totalRewards: 6_400_000,
};

// External links
export const ETHERSCAN_TOKEN = `https://etherscan.io/token/${TOWELI_ADDRESS}`;
export const UNISWAP_BUY_URL = `https://app.uniswap.org/swap?outputCurrency=${TOWELI_ADDRESS}&chain=ethereum`;
export const UNISWAP_ADD_LIQUIDITY_URL = `https://app.uniswap.org/add/v2/ETH/${TOWELI_ADDRESS}`;
export const GECKOTERMINAL_URL = `https://www.geckoterminal.com/eth/pools/${TOWELI_WETH_LP_ADDRESS}`;
export const GECKOTERMINAL_EMBED = `https://www.geckoterminal.com/eth/pools/${TOWELI_WETH_LP_ADDRESS}?embed=1&info=0&swaps=0&light_chart=0`;
