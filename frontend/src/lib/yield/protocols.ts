// THE ONLY FILE IN THIS SLICE THAT CARRIES A LIVE ADDRESS.
//
// Every address below belongs to somebody else, and one of them is where a
// visitor's ETH goes when they press a button on /yield. An address remembered
// slightly wrong is not a rendering bug — it is money handed to a stranger. So
// nothing here was written from memory: `scripts/verify-yield-protocols.mjs`
// read bytecode at each address AND a canonical view off it (symbol(),
// description(), asset(), baseToken(), eETH(), ezETH(), getPool(), getChainId())
// over a keyless public RPC, printed viem's `getAddress()` form, and its output
// line is the `evidence` field of the matching entry in scripts/addresses.json.
// Re-run it before changing any line here. Verified at mainnet block 25888268.
//
// Concentrating the literals here is what lets `surface.test.ts` assert that
// every OTHER file in lib/yield carries no non-zero address at all: no address
// can reach a deposit from a prop, a query string, a feed answer, localStorage
// or a live RPC answer, because there is nowhere else for one to come from.
//
// The ABIs are minimal fragments copied verbatim from each protocol's own
// interface — never a hand-rolled wrapper, never a convenience signature. The
// wallet signs what these say, so they say exactly what the protocol declares.

/** viem's canonical Multicall3, same deployment on every chain it exists on. */
export const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11' as const;

export const YIELD_ADDRESSES = {
  usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  stETH: '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84',
  lidoWithdrawalQueue: '0x889edC2eDab5f40e902b864aD4d7AdE8E412F9B1',
  lidoLegacyOracle: '0x442af784A788A5bd6F42A01Ebe9F287a871243fb',
  rocketStorage: '0x1d8f8f00cfa6758d7bE78336684788Fb0ee0Fa46',
  rocketDepositPool: '0xCE15294273CFb9D9b628F4D61636623decDF4fdC',
  rocketSettingsDeposit: '0x227BE8dD01DF8ad9BED0178e4F8cEC2996C5c365',
  rETH: '0xae78736Cd615f374D3085123A210448E74Fc6393',
  cbETH: '0xBe9895146f7AF43049ca1c1AE358B0541Ea49704',
  weETH: '0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee',
  eETH: '0x35fA164735182de50811E8e2E824cFb9B6118ac2',
  etherfiLiquidityPool: '0x308861A430be4cce5502d0A12724771Fc6DaF216',
  ezETH: '0xbf5495Efe5DB9ce00f80364C8B423567e58d2110',
  renzoRestakeManager: '0x74a09653A083691711cF8215a6ab074BB4e99ef5',
  aaveV3Pool: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
  aEthUSDC: '0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c',
  cUSDCv3: '0xc3d688B66703497DAA19211EEdff47f25384cdc3',
  sUSDS: '0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD',
  USDS: '0xdC035D45d973E3EC169d2276DDab16f1e407384F',
} as const satisfies Record<string, `0x${string}`>;

/**
 * Which INSTRUMENT a Chainlink feed is, decided by its publisher's own
 * documentation and recorded here — never inferred from `description()`, which
 * returns the bare pair name for both kinds.
 *
 *   market        — a price. It CAN show a discount, because a market can price
 *                   the token under what the protocol would redeem it for.
 *   exchange-rate — the protocol's own NAV, republished. It can NEVER show a
 *                   discount, because it is not a price at all. Presenting one
 *                   as a peg would be the exact lie this page exists to refuse,
 *                   so an exchange-rate feed is used only as a NAV leg and as
 *                   trailing-rate history, never as a market leg.
 *
 * WHY NOT DECIDE THIS BY DIFFERENCE. The spec asked for the class to be derived
 * at runtime by comparing the feed against the protocol's rate: within 5 bps →
 * exchange-rate, otherwise market. The verification run refuted that test on the
 * first pass. At block 25888268 CBETH/ETH — a market feed — sat 4.55 bps under
 * cbETH.exchangeRate() and RETH/ETH — also a market feed — sat 5.68 bps under
 * rETH.getExchangeRate(). The two classes were on opposite sides of the
 * threshold by one basis point, and which side a MARKET feed lands on is decided
 * by how well the token happens to be trading, not by what the feed is. The test
 * is only sound in ONE direction, so that is the only direction it is used in:
 * `classifyFeedLeg` refuses an exchange-rate-class feed that has drifted far
 * from the protocol rate (it has stopped tracking), and never reclassifies a
 * market feed for trading close to NAV.
 */
export type FeedMarketClass = 'market' | 'exchange-rate';

export interface YieldFeed {
  address: `0x${string}`;
  /** Exactly what `description()` returns. Casing included — it is not uniform. */
  pair: string;
  marketClass: FeedMarketClass;
  /**
   * Publisher's heartbeat in seconds. Staleness is judged at TWICE this, so one
   * missed publication is not reported as a broken feed while two is.
   */
  heartbeatS: number;
}

export const YIELD_FEEDS = {
  stethEth: {
    address: '0x86392dC19c0b719886221c78AB11eb8Cf5c52812',
    pair: 'STETH / ETH',
    marketClass: 'market',
    heartbeatS: 86_400,
  },
  rethEth: {
    address: '0x536218f9E9Eb48863970252233c8F271f554C2d0',
    pair: 'RETH / ETH',
    marketClass: 'market',
    heartbeatS: 86_400,
  },
  cbethEth: {
    address: '0xF017fcB346A1885194689bA23Eff2fE6fA5C483b',
    pair: 'CBETH / ETH',
    marketClass: 'market',
    heartbeatS: 86_400,
  },
  weethEth: {
    address: '0x5c9C449BbC9a6075A2c061dF312a35fd1E05fF22',
    pair: 'weETH / ETH',
    marketClass: 'exchange-rate',
    heartbeatS: 86_400,
  },
  ezethEth: {
    address: '0x636A000262F6aA9e1F094ABF0aD8f645C44f641C',
    pair: 'ezETH / ETH',
    marketClass: 'exchange-rate',
    heartbeatS: 86_400,
  },
  usdcUsd: {
    address: '0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6',
    pair: 'USDC / USD',
    marketClass: 'market',
    heartbeatS: 86_400,
  },
  usdsUsd: {
    address: '0xfF30586cD0F29eD462364C7e81375FC0C71219b1',
    pair: 'USDS / USD',
    marketClass: 'market',
    heartbeatS: 86_400,
  },
} as const satisfies Record<string, YieldFeed>;

// ─── ABIs, copied verbatim from each protocol's own interface ────────────────

/**
 * The clock legs. Both ride INSIDE the same aggregate3 as every read, so the
 * block number and chain timestamp a figure is stamped with are the block that
 * figure came from — not a second round trip and not the browser's wall clock,
 * which is the user's own machine and can be wrong by hours.
 */
export const MULTICALL3_CLOCK_ABI = [
  { type: 'function', name: 'getBlockNumber', inputs: [], outputs: [{ name: 'blockNumber', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'getCurrentBlockTimestamp', inputs: [], outputs: [{ name: 'timestamp', type: 'uint256' }], stateMutability: 'view' },
] as const;

/**
 * AggregatorV3Interface. `getRoundData` is the piece lib/contracts.ts's
 * CHAINLINK_FEED_ABI does not carry, and it is what makes a trailing rate
 * readable at all: round history is plain contract state, so a keyless node with
 * no archive and no log index can still answer it.
 */
export const AGGREGATOR_V3_ABI = [
  { type: 'function', name: 'latestRoundData', inputs: [], outputs: [{ name: 'roundId', type: 'uint80' }, { name: 'answer', type: 'int256' }, { name: 'startedAt', type: 'uint256' }, { name: 'updatedAt', type: 'uint256' }, { name: 'answeredInRound', type: 'uint80' }], stateMutability: 'view' },
  { type: 'function', name: 'getRoundData', inputs: [{ name: '_roundId', type: 'uint80' }], outputs: [{ name: 'roundId', type: 'uint80' }, { name: 'answer', type: 'int256' }, { name: 'startedAt', type: 'uint256' }, { name: 'updatedAt', type: 'uint256' }, { name: 'answeredInRound', type: 'uint80' }], stateMutability: 'view' },
  { type: 'function', name: 'decimals', inputs: [], outputs: [{ name: '', type: 'uint8' }], stateMutability: 'view' },
  { type: 'function', name: 'description', inputs: [], outputs: [{ name: '', type: 'string' }], stateMutability: 'view' },
] as const;

export const LIDO_ABI = [
  { type: 'function', name: 'submit', inputs: [{ name: '_referral', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'payable' },
  { type: 'function', name: 'getPooledEthByShares', inputs: [{ name: '_sharesAmount', type: 'uint256' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'getFee', inputs: [], outputs: [{ name: '', type: 'uint16' }], stateMutability: 'view' },
] as const;

export const LIDO_WITHDRAWAL_QUEUE_ABI = [
  { type: 'function', name: 'unfinalizedStETH', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
] as const;

export const ROCKET_STORAGE_ABI = [
  { type: 'function', name: 'getAddress', inputs: [{ name: '_key', type: 'bytes32' }], outputs: [{ name: '', type: 'address' }], stateMutability: 'view' },
] as const;

export const ROCKET_DEPOSIT_POOL_ABI = [
  { type: 'function', name: 'deposit', inputs: [], outputs: [], stateMutability: 'payable' },
  { type: 'function', name: 'getBalance', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'getExcessBalance', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
] as const;

export const ROCKET_SETTINGS_DEPOSIT_ABI = [
  { type: 'function', name: 'getDepositEnabled', inputs: [], outputs: [{ name: '', type: 'bool' }], stateMutability: 'view' },
  { type: 'function', name: 'getMinimumDeposit', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'getMaximumDepositPoolSize', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'getDepositFee', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
] as const;

export const RETH_ABI = [
  { type: 'function', name: 'getExchangeRate', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
] as const;

export const CBETH_ABI = [
  { type: 'function', name: 'exchangeRate', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
] as const;

export const ETHERFI_LIQUIDITY_POOL_ABI = [
  { type: 'function', name: 'deposit', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'payable' },
] as const;

export const WEETH_ABI = [
  { type: 'function', name: 'wrap', inputs: [{ name: '_eETHAmount', type: 'uint256' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'nonpayable' },
  { type: 'function', name: 'getRate', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
] as const;

export const RENZO_RESTAKE_MANAGER_ABI = [
  { type: 'function', name: 'depositETH', inputs: [], outputs: [], stateMutability: 'payable' },
] as const;

/**
 * Aave v3 `ReserveDataLegacy`. Only `currentLiquidityRate` (ray per year) and
 * `aTokenAddress` are consumed, but the tuple is declared in full because a
 * partial struct decodes the wrong field silently — there is no error to catch.
 */
export const AAVE_V3_POOL_ABI = [
  { type: 'function', name: 'supply', inputs: [{ name: 'asset', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'onBehalfOf', type: 'address' }, { name: 'referralCode', type: 'uint16' }], outputs: [], stateMutability: 'nonpayable' },
  {
    type: 'function',
    name: 'getReserveData',
    inputs: [{ name: 'asset', type: 'address' }],
    outputs: [{
      type: 'tuple',
      components: [
        { name: 'configuration', type: 'tuple', components: [{ name: 'data', type: 'uint256' }] },
        { name: 'liquidityIndex', type: 'uint128' },
        { name: 'currentLiquidityRate', type: 'uint128' },
        { name: 'variableBorrowIndex', type: 'uint128' },
        { name: 'currentVariableBorrowRate', type: 'uint128' },
        { name: 'currentStableBorrowRate', type: 'uint128' },
        { name: 'lastUpdateTimestamp', type: 'uint40' },
        { name: 'id', type: 'uint16' },
        { name: 'aTokenAddress', type: 'address' },
        { name: 'stableDebtTokenAddress', type: 'address' },
        { name: 'variableDebtTokenAddress', type: 'address' },
        { name: 'interestRateStrategyAddress', type: 'address' },
        { name: 'accruedToTreasury', type: 'uint128' },
        { name: 'unbacked', type: 'uint128' },
        { name: 'isolationModeTotalDebt', type: 'uint128' },
      ],
    }],
    stateMutability: 'view',
  },
] as const;

export const COMET_ABI = [
  { type: 'function', name: 'supply', inputs: [{ name: 'asset', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'getUtilization', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'getSupplyRate', inputs: [{ name: 'utilization', type: 'uint256' }], outputs: [{ name: '', type: 'uint64' }], stateMutability: 'view' },
] as const;

export const SUSDS_ABI = [
  { type: 'function', name: 'deposit', inputs: [{ name: 'assets', type: 'uint256' }, { name: 'receiver', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'nonpayable' },
  { type: 'function', name: 'convertToAssets', inputs: [{ name: 'shares', type: 'uint256' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'ssr', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
] as const;

/**
 * Rocket Pool resolves its own contracts through a storage registry and upgrades
 * them by design, so a pinned deposit-pool address goes stale on the next
 * upgrade. The keys are built here rather than pasted as hashes so the string
 * that produced them is legible: `keccak256(abi.encodePacked("contract.address",
 * name))`, exactly as RocketBase does it.
 *
 * The resolution is read live and used ONLY to CHECK the pinned address, never
 * to choose one. A public RPC that answered with an address of its own choosing
 * can therefore disable the button; it can never redirect the ETH.
 */
export const ROCKET_KEY_STRINGS = {
  depositPool: 'rocketDepositPool',
  settingsDeposit: 'rocketDAOProtocolSettingsDeposit',
} as const;
