// TOWELI Token
export const TOWELI_ADDRESS = '0x420698CFdEDdEa6bc78D59bC17798113ad278F9D' as const;

// Core Contracts — RELAUNCH DEPLOYED ON MAINNET 2026-06-06 (DeployMVP, fresh wallet)
// Block of the DeployMVP broadcast (first deploy tx landed at block 25,263,328 —
// verified from contracts/broadcast/DeployMVP.s.sol/1/run-latest.json). Used as
// the `fromBlock` for relaunch-contract eth_getLogs scans so the span stays well
// under the public-RPC range cap (was 18,000,000n — a ~7M-block ask that public
// RPCs reject, silently zeroing swap count + loyalty score). Rounded down a hair
// for safety; no relaunch event can predate the contract's own deploy.
export const RELAUNCH_DEPLOY_BLOCK = 25263000n;
export const TEGRIDY_STAKING_ADDRESS = '0xcaDc93E96De58EA554c71ca609974625615E046D' as const;
// Retired pre-relaunch TegridyStaking deployments that STILL HOLD user positions.
// WITHDRAW-ONLY: never route stake/approve traffic here. Verified on-chain
// 2026-07-22: 0x044A… holds a 1,000 TOWELI position (tokenId 2, owner 0xC530…d4b9,
// +25 TOWELI funded rewards) and 0x6266… holds 100 TOWELI (tokenId 1, owner
// 0xd0d8…b18e); both unpaused, locks expired, withdraw(tokenId) simulates OK.
// Surfaced by <LegacyStakingExit /> on the Farm page for affected wallets only.
export const LEGACY_STAKING_ADDRESSES = [
  '0x044A925839ac3CEC0bccC93d00230f39FFbeEe44',
  '0x626644523d34B84818df602c991B4a06789C4819',
] as const;
// Restaking: the EIP-170 split LANDED 2026-08-19 (admin sister, host 22,114 B —
// 2,462 B under the limit). Deploy is now gated on the external re-audit and a
// real Safe for MULTISIG (docs/OPERATOR_NEXT.md §C4/§C5), not on size or a
// build. Zeroed until deployed; UI gates on isDeployed().
export const TEGRIDY_RESTAKING_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

// EIP-170 admin sister contracts — RELAUNCH 2026-06-06 (deployed + wired by DeployMVP).
export const TEGRIDY_STAKING_ADMIN_ADDRESS = '0x4B134C08aAF86B6e2A8E097D1039C4e7638806f3' as const;
export const SWAP_FEE_ROUTER_ADMIN_ADDRESS = '0xa517A1cEfd961c0DDE8155a0Fa870aEE5bb0D060' as const;
// Read-only staking view sister (EIP-170 split) — RELAUNCH 2026-06-06.
export const STAKING_MONITOR_VIEW_ADDRESS = '0xbE1E75124C7F07d5B681839C42d8e751f0d0fcfC' as const;

// Native DEX — RELAUNCH 2026-06-06 (DeployMVP); LP = our factory's TOWELI/WETH pair
export const TEGRIDY_FACTORY_ADDRESS = '0xa24C7287eC56A7DEFDc70033803451240e267a52' as const;
export const TEGRIDY_ROUTER_ADDRESS = '0xE9F83A07b071748E795d2489651d5310fA098Db8' as const;
// TegridyCurveLauncher — the own zero-toll launch curve (contracts/src/curve).
// LIVE on mainnet 2026-08-24 (deploy tx 0x5f5dd7c1…, owner = Treasury Safe,
// 4 ETH graduation / 40-25-35 split / 3.69% reserve). The chains registry maps
// it through `orNull`, so this non-zero address reads as `deployed` and the
// /eth-curve surface + nav go live.
export const CURVE_LAUNCHER_ADDRESS = '0xF4Dfa741aD63B3D95dC3Fc10D311caE507CE34dE' as const;
export const TEGRIDY_LP_ADDRESS = '0x55875887B43C2E23aE424AF0FC8606Fdb058a481' as const;
// Pair first-mint timestamp (unix seconds) — used for fee-APR / avg-daily-volume
// pool-age math. Interim = the 2026-06-08 LP relaunch date; OPERATOR: replace
// with the pair's actual first-mint block timestamp once known.
export const TEGRIDY_LP_CREATED_AT = Math.floor(new Date('2026-06-08T00:00:00Z').getTime() / 1000);

// Revenue & Fees — RELAUNCH 2026-06-06 (DeployMVP)
export const REVENUE_DISTRIBUTOR_ADDRESS = '0xF993316E2fC079de4358c489A935E01e03E23E17' as const;
export const SWAP_FEE_ROUTER_ADDRESS = '0x6d5791A660e79175F74C6D639584C98422d5956E' as const;
export const POL_ACCUMULATOR_ADDRESS = '0x2A5f65f4C74b1e49e77aE9A57e20fBDb0cED11D2' as const;

// LP Farming — RELAUNCH 2026-06-08 (DeployTegridyLPFarming): boosted Synthetix
// LP staking; owner pending the 0xA360 Safe. (Live — the earlier Wave 0
// 0xa7EF711… and the 2026-05-31 ZEROED interim are both superseded.)
export const LP_FARMING_ADDRESS = '0x1171268AE5B69791c47Fd589b7825932c957e149' as const;

// Gauge Controller — DEPLOYED 2026-07-16 gated batch at
// 0x6c79522D47Cf6d1051Cb474E81d9b6f3996c1054 (Etherscan-verified; gaugeCount()==0).
// Kept ZERO here ON PURPOSE: emission/spend-side features stay unsurfaced until a
// revenue line funds them and gauges exist (see CONTRACTS.md + EVERYTHING_LEFT Tier 3.4-3.6).
// An earlier revision of this comment said "no src contract, not in DeployMVP" — that
// was true on 2026-05-31 and stale after the gated batch shipped. Zero = not surfaced,
// NOT not-deployed. Wave-0 prev (DO NOT wire — pairToGauge reverts): 0xb93264aB0AF377F7C0485E64406bE9a9b1df0Fdb
export const GAUGE_CONTROLLER_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

// Community — both DEPLOYED 2026-07-16 gated batch (Etherscan-verified), kept ZERO
// on purpose: they SPEND (grants/bounties), so they wait for a revenue line + the
// Safe re-home. Zero = not surfaced, NOT not-deployed (CONTRACTS.md is canonical).
// CommunityGrants live at 0xeBC3aaf48297b8ccFa8272D9E68c1545eb9CD471. Prev: 0x8f1Ba1eC97a932EE1332BA0f366BC6aDf60B3032
export const COMMUNITY_GRANTS_ADDRESS = '0x0000000000000000000000000000000000000000' as const;
// MemeBountyBoard live at 0x6D2C6EC29D97fe8b6D1471091DEEE36baf69d890 (bountyCount()==0). Prev: 0x3457C2210be35bA7AF6F382a76247Ecd782BF0C9
export const MEME_BOUNTY_BOARD_ADDRESS = '0x0000000000000000000000000000000000000000' as const;
export const REFERRAL_SPLITTER_ADDRESS = '0x6B3442dAcB62d40BA39fCe9b3CDa350FEa6f7e4c' as const; // RELAUNCH 2026-06-06 (DeployMVP)
// RELAUNCH 2026-07-16 gated batch (DeployPremiumAccess; Etherscan-verified; fee 10,000 TOWELI/mo). Prev V1: 0xaA16dF3dC66c7A6aD7db153711329955519422Ad
export const PREMIUM_ACCESS_ADDRESS = '0x9DC2675B2017687dD9768C63D15f0aD5194Fa3f5' as const;
// VoteIncentives — DEPLOYED 2026-07-16 gated batch at
// 0x6e1dCB7EBD16E09edb574F414aDc664B2A5E21AF (+Admin 0xf87Ec231BA7FA3975619309bc16C698B2ea3B300).
// Kept ZERO on purpose until after the Safe re-home AND setGaugeController: the setter
// is ONE-SHOT in the deployed bytecode (no rotation path) and its only correct argument
// is the gated-batch GaugeController 0x6c79522D…1054 — a hot-key typo bricks the bribe
// market forever. Un-gate order: re-home → setGaugeController (Safe quorum) → gauges →
// then surface (EVERYTHING_LEFT Tier 3.5/3.6). Prev: 0x417F44aee21Cc709262e71A7fdF6028cc17eCf1A
export const VOTE_INCENTIVES_ADDRESS = '0x0000000000000000000000000000000000000000' as const;
// Tegridy Pro Pass — an ETH-priced access-pass NFT (deploy a TegridyDropV2 clone
// via LaunchpadV2; the proceeds are real ETH to the treasury and it gates the Pro
// perks). The frontend ownership gate + membership funnel auto-activate the
// moment this is set to the deployed collection address. Owning >=1 = Pro.
export const TEGRIDY_PRO_PASS_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

// V3 Features — Deployed 2026-04-14
export const TEGRIDY_LENDING_ADDRESS = '0x0000000000000000000000000000000000000000' as const; // ZEROED 2026-05-31 (relaunch; no src contract, not in DeployMVP). Prev: 0xd471e5675EaDbD8C192A5dA2fF44372D5713367f
// V1 TegridyLaunchpad (0x5d5976...FF3C2) deleted from source 2026-04-19; existing
// V1 clones remain browseable on Etherscan. Use TEGRIDY_LAUNCHPAD_V2_ADDRESS.
export const TEGRIDY_NFT_POOL_FACTORY_ADDRESS = '0xbB8E49Ba4e3A85E2B8B70e00208770F429B56F5B' as const; // RELAUNCH 2026-07-16 gated batch (fee 50bps → treasury; pool template 0x98553C2a…ff481A). Prev V1: 0x1C0e1771943fbB299f4E19daD0fAA4Fa4e6c04f0
// RELAUNCH 2026-06-06 (DeployMVP)
export const TEGRIDY_TOKEN_URI_READER_ADDRESS = '0x5cfEe751eAf274F68b05267012b85a867dfCd326' as const;
// RELAUNCH 2026-07-16 gated batch (DeployNFTLending; Admin sister 0x69378783…580a9C; fee 500bps)
export const TEGRIDY_NFT_LENDING_ADDRESS = '0x89BeB6cc0255B7465c01aA38a6f937efd345f14F' as const; // Prev V1: 0x05409880aDFEa888F2c93568B8D88c7b4aAdB139
// RELAUNCH 2026-06-06 (DeployMVP) — needs 4x update() bootstrap after LP seed (audit H-18)
export const TEGRIDY_TWAP_ADDRESS = '0xdFdd6D72539A425dC917F49FB834901105cA98c9' as const;
// Wave 0 2026-04-18: Uniswap V4 fee hook (B7). Address ends in 0x0044 for
// AFTER_SWAP_FLAG|AFTER_SWAP_RETURNS_DELTA permissions. NOTE: deployed via
// Arachnid CREATE2 proxy — owner is the proxy (0x4e59b44...), not our EOA.
// Admin functions (pause, setFee, setDistributor) are stranded until we patch
// the constructor to accept _owner as arg and redeploy.
export const TEGRIDY_FEE_HOOK_ADDRESS = '0xB6cfeaCf243E218B0ef32B26E1dA1e13a2670044' as const;

// Launchpad V2 — click-deploy flow with single-tx createCollection + contractURI.
// RELAUNCH 2026-07-16 gated batch (DeployLaunchpadV2; DropV2 template 0xA35ec3e2…873e872;
// fee 500bps → treasury 0x7D26…Bd7d baked into every clone).
export const TEGRIDY_LAUNCHPAD_V2_ADDRESS = '0xa6149B4d05138A4073902A0Ca0345c2d0E470dF7' as const;

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

/**
 * `LockerClaimer` — the address the Doppler fee locker can actually PAY.
 *
 * The locker is pull-based and self-addressed: `releaseFees(tokenId)` pays `msg.sender`
 * only, so a beneficiary that cannot originate a call to it accrues credit no transaction
 * can ever collect. `RevenueDistributor` has no arbitrary-call surface, so naming it
 * directly stranded the whole protocol fee line — which is why this line pointed at the
 * Treasury Safe in the interim.
 *
 * This contract closes that gap: permissionless `claim(tokenId)` pulls from the locker and
 * forwards the ETH leg to `RevenueDistributor` (real veTOWELI staker yield) while
 * `sweepToken` sends any ERC20 leg to the Treasury, since RevenueDistributor is ETH-only.
 *
 * DEPLOYED + VERIFIED 2026-08-01, tx 0x44773647910223e089b2bdc3142b9fb9d2fa6fd70b55e63b042d3a0e189943ca.
 * Read back on-chain before wiring: runtime 1,181 bytes (byte-identical to the local
 * artifact); locker() = 0xe24f…1ec6, revenueDistributor() = 0xf993…3e17, treasury() =
 * 0x7d26…bd7d; and owner()/transferOwnership/setLocker/upgradeTo are all ABSENT — there is
 * no admin surface and the three destinations are immutable.
 */
export const LOCKER_CLAIMER_ADDRESS = '0xD2Ac3dC13c6fd09855F0e4a077826983Aa66E6C7' as const;

// ─── Airdrop / vesting / lock rails (#65, #28) ───────────────────────
// UNDEPLOYED. These four are zero because no deploy ceremony has run for them —
// this is the "not deployed" state, not the deployed-but-unsurfaced state that
// GaugeController / VoteIncentives / grants / bounties are in above. Every surface
// that touches them gates on isDeployed() and renders the SOON placeholder, so
// filling an address in here is the whole activation step.
//
// The client-side merkle builder on /airdrop deliberately keeps working while these
// are zero: computing a root from a CSV needs no chain, and a creator preparing a
// campaign before the ceremony is a legitimate use. Only the funding + claim
// transactions are gated.
export const AIRDROP_FACTORY_ADDRESS = '0x0000000000000000000000000000000000000000' as const;
export const VESTING_FACTORY_ADDRESS = '0x0000000000000000000000000000000000000000' as const;
export const TEGRIDY_LOCK_VAULT_ADDRESS = '0x0000000000000000000000000000000000000000' as const;
// Read-only joiner over the two rails above. Its own availability flags are what the
// lock viewer renders as NO DATA — a rail it cannot reach is never drawn as a zero.
export const LAUNCH_LOCK_VIEW_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

// ─── Staking-position secondary market (#60) ─────────────────────────
// UNDEPLOYED. `contracts/src/markets/TegridyPositionMarket.sol` is written and
// tested but no ceremony has run, so this stays zero and every surface under
// components/positionMarket gates on isDeployed(). The market needs no wiring on
// TegridyStaking to work — and specifically must NEVER be registered there via
// applyLendingContract: that carve-out would exempt it from the transfer cooldown,
// the transfer rate limit, and the AlreadyHasPosition receiver guard it is built to
// respect. See the deploy notice in script/DeployPositionMarket.s.sol.
export const POSITION_MARKET_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

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

// F113: single source of truth for the staking lock tiers. Previously copy-pasted
// in FarmPage, StakingCard, and BoostScheduleTable — a tier edit in one desynced
// the form, the extend-lock picker, and the schedule table. Edit here only.
export interface LockOption { label: string; seconds: number }
export const LOCK_OPTIONS: LockOption[] = [
  { label: '7 Days', seconds: 7 * 86400 },
  { label: '30 Days', seconds: 30 * 86400 },
  { label: '90 Days', seconds: 90 * 86400 },
  { label: '6 Months', seconds: 180 * 86400 },
  { label: '1 Year', seconds: 365 * 86400 },
  { label: '2 Years', seconds: 730 * 86400 },
  { label: '4 Years', seconds: 1460 * 86400 },
];
export const MIN_BOOST_BPS = 4000; // 0.4x
export const MAX_BOOST_BPS = 40000; // 4.0x
export const JBAC_BONUS_BPS = 5000; // +0.5x
export const EARLY_WITHDRAWAL_PENALTY_BPS = 2500; // 25%

// Protocol swap fee (mirrors the deployed SwapFeeRouter feeBps). The native
// ('tegridy') route executes through SwapFeeRouter, which deducts this from the
// input as protocol revenue. MUST stay in sync with DeployMVP SWAP_FEE_BPS /
// SwapFeeRouter.feeBps() (read on-chain if the owner ever retunes it).
export const SWAP_FEE_BPS = 50; // 0.5%

// NOTE: Solana fee-capture config (Surface A) lives in src/lib/solana.ts, NOT
// here — this file is imported by wagmi.config.ts (compiled under the node
// tsconfig, no "vite/client"), so `import.meta.env` is untyped in this context.

// Helper: check if an address is deployed (not zero address)
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
export function isDeployed(address: string): boolean {
  return address !== ZERO_ADDRESS;
}

// Engagement season — a label + countdown for the points/leaderboard program
// (LeaderboardPage) and the Farm "Season" stat. This is NOT a claim about on-chain
// LP-farm funding: the LP farm's real reward rate, total funded, and period-end are
// read live from the contract in <LPFarmingSection/>, and single-asset staking
// emissions come from useFarmStats (also on-chain). Set these dates to the
// engagement window you're actually running. Do NOT add unfunded reward figures
// here — nothing should render a number the chain can't back.
export const CURRENT_SEASON = {
  number: 3,
  name: 'Season 3',
  startDate: '2026-06-07',
  endDate: '2026-09-05',
};

// Canonical production origin. Single source of truth for share links / fallback
// URLs so nothing ships a dead domain (e.g. tegridyfarms.io / tegridy.farm).
// Keep in lock-step with index.html <link rel=canonical>. usePageTitle now IMPORTS
// this rather than re-declaring it — it previously held a second literal, which is
// how the two drifted apart.
//
// 🔴 CORRECTED 2026-07-30 — this said `tegridyfarms.vercel.app` while memetic.fun was
// the live canonical domain. The site was therefore telling search engines and every
// social unfurl that its identity lived at the .vercel.app alias. The API allowlists
// had already been corrected to memetic.fun in #180; this half had not, so the two
// halves of the app disagreed about which domain is production. Both hosts still
// serve, and api/ deliberately keeps BOTH in its origin allowlist — this constant is
// about declared identity, not access.
export const SITE_URL = 'https://memetic.fun';

// External links
export const ETHERSCAN_TOKEN = `https://etherscan.io/token/${TOWELI_ADDRESS}`;
export const UNISWAP_BUY_URL = `https://app.uniswap.org/swap?outputCurrency=${TOWELI_ADDRESS}&chain=ethereum`;
export const UNISWAP_ADD_LIQUIDITY_URL = `https://app.uniswap.org/add/v2/ETH/${TOWELI_ADDRESS}`;
export const GECKOTERMINAL_URL = `https://www.geckoterminal.com/eth/pools/${TOWELI_WETH_LP_ADDRESS}`;
export const GECKOTERMINAL_EMBED = `https://www.geckoterminal.com/eth/pools/${TOWELI_WETH_LP_ADDRESS}?embed=1&info=0&swaps=0&light_chart=0`;
