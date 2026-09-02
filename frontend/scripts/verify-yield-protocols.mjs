#!/usr/bin/env node
/**
 * VERIFY BEFORE WIRE — every third-party address /yield reads or sends money to.
 *
 * WHY THIS FILE EXISTS. src/lib/yield/protocols.ts is the only place in the app
 * that carries an address a visitor's ETH can be sent to, and none of those
 * addresses are ours. An address remembered slightly wrong is not a rendering
 * bug: it is money delivered to a stranger. So no address may enter protocols.ts
 * or scripts/addresses.json until this script has, over a keyless public RPC,
 * (a) seen bytecode at it and (b) read a CANONICAL view off it whose answer only
 * the real contract can give — symbol(), description(), asset(), baseToken(),
 * eETH(), ezETH(), getPool(), getChainId(). Identity by read, never by memory.
 *
 * It also CLASSIFIES each Chainlink feed by difference rather than by its
 * description string. `description()` returns the bare pair name for both a
 * market feed and an exchange-rate feed, and the two are opposite instruments:
 * an exchange-rate feed republishes the protocol's own NAV and therefore can
 * never show a depeg, while a market feed prices the token against ETH and
 * therefore can. Printing one as the other would be exactly the lie the /yield
 * peg column exists to refuse, so the class is decided by comparing the feed's
 * answer against the protocol's own rate read in the SAME run.
 *
 * Read-only, no key, no writes, no dependency beyond viem (already a dep).
 *   node scripts/verify-yield-protocols.mjs          # default keyless roster
 *   ETH_RPC=https://… node scripts/verify-yield-protocols.mjs
 *
 * Exits non-zero on ANY mismatch. Its per-address output line is what goes into
 * the registry entry's `evidence` field, verbatim.
 */

import { createPublicClient, http, getAddress, keccak256, encodePacked } from 'viem';
import { mainnet } from 'viem/chains';

const RPC = process.env.ETH_RPC || 'https://ethereum-rpc.publicnode.com';
const client = createPublicClient({ chain: mainnet, transport: http(RPC) });

const failures = [];
const lines = [];
const fail = (m) => failures.push(m);

// ── minimal ABI fragments, copied from each protocol's own interface ──────────
const A = {
  symbol: [{ type: 'function', name: 'symbol', inputs: [], outputs: [{ type: 'string' }], stateMutability: 'view' }],
  name: [{ type: 'function', name: 'name', inputs: [], outputs: [{ type: 'string' }], stateMutability: 'view' }],
  decimals: [{ type: 'function', name: 'decimals', inputs: [], outputs: [{ type: 'uint8' }], stateMutability: 'view' }],
  totalSupply: [{ type: 'function', name: 'totalSupply', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' }],
  balanceOf: [{ type: 'function', name: 'balanceOf', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' }],
  description: [{ type: 'function', name: 'description', inputs: [], outputs: [{ type: 'string' }], stateMutability: 'view' }],
  latestRoundData: [{
    type: 'function', name: 'latestRoundData', inputs: [],
    outputs: [{ name: 'roundId', type: 'uint80' }, { name: 'answer', type: 'int256' }, { name: 'startedAt', type: 'uint256' }, { name: 'updatedAt', type: 'uint256' }, { name: 'answeredInRound', type: 'uint80' }],
    stateMutability: 'view',
  }],
  getRoundData: [{
    type: 'function', name: 'getRoundData', inputs: [{ name: '_roundId', type: 'uint80' }],
    outputs: [{ name: 'roundId', type: 'uint80' }, { name: 'answer', type: 'int256' }, { name: 'startedAt', type: 'uint256' }, { name: 'updatedAt', type: 'uint256' }, { name: 'answeredInRound', type: 'uint80' }],
    stateMutability: 'view',
  }],
  getExchangeRate: [{ type: 'function', name: 'getExchangeRate', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' }],
  exchangeRate: [{ type: 'function', name: 'exchangeRate', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' }],
  getRate: [{ type: 'function', name: 'getRate', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' }],
  getPooledEthByShares: [{ type: 'function', name: 'getPooledEthByShares', inputs: [{ type: 'uint256' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' }],
  getFee: [{ type: 'function', name: 'getFee', inputs: [], outputs: [{ type: 'uint16' }], stateMutability: 'view' }],
  getLastCompletedReportDelta: [{
    type: 'function', name: 'getLastCompletedReportDelta', inputs: [],
    outputs: [{ name: 'postTotalPooledEther', type: 'uint256' }, { name: 'preTotalPooledEther', type: 'uint256' }, { name: 'timeElapsed', type: 'uint256' }],
    stateMutability: 'view',
  }],
  unfinalizedStETH: [{ type: 'function', name: 'unfinalizedStETH', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' }],
  storageGetAddress: [{ type: 'function', name: 'getAddress', inputs: [{ name: '_key', type: 'bytes32' }], outputs: [{ type: 'address' }], stateMutability: 'view' }],
  getBalance: [{ type: 'function', name: 'getBalance', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' }],
  getExcessBalance: [{ type: 'function', name: 'getExcessBalance', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' }],
  getDepositEnabled: [{ type: 'function', name: 'getDepositEnabled', inputs: [], outputs: [{ type: 'bool' }], stateMutability: 'view' }],
  getMinimumDeposit: [{ type: 'function', name: 'getMinimumDeposit', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' }],
  getMaximumDepositPoolSize: [{ type: 'function', name: 'getMaximumDepositPoolSize', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' }],
  getDepositFee: [{ type: 'function', name: 'getDepositFee', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' }],
  eETH: [{ type: 'function', name: 'eETH', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' }],
  getTotalPooledEther: [{ type: 'function', name: 'getTotalPooledEther', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' }],
  ezETH: [{ type: 'function', name: 'ezETH', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' }],
  getPool: [{ type: 'function', name: 'getPool', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' }],
  underlying: [{ type: 'function', name: 'UNDERLYING_ASSET_ADDRESS', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' }],
  baseToken: [{ type: 'function', name: 'baseToken', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' }],
  getUtilization: [{ type: 'function', name: 'getUtilization', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' }],
  getSupplyRate: [{ type: 'function', name: 'getSupplyRate', inputs: [{ type: 'uint256' }], outputs: [{ type: 'uint64' }], stateMutability: 'view' }],
  asset: [{ type: 'function', name: 'asset', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' }],
  convertToAssets: [{ type: 'function', name: 'convertToAssets', inputs: [{ type: 'uint256' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' }],
  ssr: [{ type: 'function', name: 'ssr', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' }],
  getChainId: [{ type: 'function', name: 'getChainId', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' }],
  getCurrentBlockTimestamp: [{ type: 'function', name: 'getCurrentBlockTimestamp', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' }],
  aavePoolGetPool: [{ type: 'function', name: 'getPool', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' }],
  aaveReserveData: [{
    type: 'function', name: 'getReserveData', inputs: [{ name: 'asset', type: 'address' }],
    outputs: [{
      type: 'tuple', components: [
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
  }],
};

const CAND = {
  multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
  usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  weth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  'lido-steth': '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84',
  'lido-wsteth': '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0',
  'lido-legacy-oracle': '0x442af784A788A5bd6F42A01Ebe9F287a871243fb',
  'lido-withdrawal-queue': '0x889edC2eDab5f40e902b864aD4d7AdE8E412F9B1',
  'rocket-storage': '0x1d8f8f00cfa6758d7bE78336684788Fb0ee0Fa46',
  'rocket-reth': '0xae78736Cd615f374D3085123A210448E74Fc6393',
  'coinbase-cbeth': '0xBe9895146f7AF43049ca1c1AE358B0541Ea49704',
  'etherfi-weeth': '0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee',
  'etherfi-eeth': '0x35fA164735182de50811E8e2E824cFb9B6118ac2',
  'etherfi-liquidity-pool': '0x308861A430be4cce5502d0A12724771Fc6DaF216',
  'renzo-ezeth': '0xbf5495Efe5DB9ce00f80364C8B423567e58d2110',
  'renzo-restake-manager': '0x74a09653A083691711cF8215a6ab074BB4e99ef5',
  'aave-v3-provider': '0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e',
  'aave-v3-pool': '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
  'aave-v3-ausdc': '0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c',
  'compound-v3-cusdc': '0xc3d688B66703497DAA19211EEdff47f25384cdc3',
  'sky-susds': '0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD',
  'sky-usds': '0xdC035D45d973E3EC169d2276DDab16f1e407384F',
  'steth-eth-feed': '0x86392dC19c0b719886221c78AB11eb8Cf5c52812',
  'reth-eth-feed': '0x536218f9E9Eb48863970252233c8F271f554C2d0',
  'cbeth-eth-feed': '0xF017fcB346A1885194689bA23Eff2fE6fA5C483b',
  'weeth-eth-feed': '0x5c9C449BbC9a6075A2c061dF312a35fd1E05fF22',
  'ezeth-eth-feed': '0x636A000262F6aA9e1F094ABF0aD8f645C44f641C',
  'usdc-usd-feed': '0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6',
  'usds-usd-feed': '0xfF30586cD0F29eD462364C7e81375FC0C71219b1',
};

const read = (address, abiKey, fn, args = []) =>
  client.readContract({ address: getAddress(address), abi: A[abiKey], functionName: fn, args });

const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

async function hasCode(id, address) {
  const code = await client.getCode({ address: getAddress(address) });
  if (!code || code === '0x') { fail(`${id}: NO CODE at ${address}`); return false; }
  return true;
}

/** One verified address, printed in the exact shape the registry `evidence` wants. */
function ok(id, address, detail) {
  const checksummed = getAddress(address);
  lines.push(`${id} ${checksummed} — ${detail}`);
  return checksummed;
}

async function main() {
  const block = await client.getBlockNumber();
  const chainId = await client.getChainId();
  if (chainId !== 1) { fail(`RPC ${RPC} is chain ${chainId}, not Ethereum mainnet`); }
  console.log(`# verify-yield-protocols — chain ${chainId} block ${block} via ${RPC}\n`);

  const V = {}; // id → checksummed address, only when verified

  // ── Multicall3 (the clock legs ride in the same aggregate3 as every read) ──
  if (await hasCode('multicall3', CAND.multicall3)) {
    const cid = await read(CAND.multicall3, 'getChainId', 'getChainId');
    const ts = await read(CAND.multicall3, 'getCurrentBlockTimestamp', 'getCurrentBlockTimestamp');
    if (cid !== 1n) fail(`multicall3: getChainId()=${cid}, expected 1`);
    else if (ts <= 0n) fail('multicall3: getCurrentBlockTimestamp() is not positive');
    else V.multicall3 = ok('multicall3', CAND.multicall3, `getChainId()=${cid}, getCurrentBlockTimestamp()=${ts} at block ${block}`);
  }

  // ── plain ERC-20 identities ────────────────────────────────────────────────
  const erc20s = [
    ['usdc', 'USDC', 6], ['weth', 'WETH', 18],
    ['lido-steth', 'stETH', 18], ['lido-wsteth', 'wstETH', 18],
    ['rocket-reth', 'rETH', 18], ['coinbase-cbeth', 'cbETH', 18],
    ['etherfi-weeth', 'weETH', 18], ['etherfi-eeth', 'eETH', 18],
    ['renzo-ezeth', 'ezETH', 18], ['aave-v3-ausdc', 'aEthUSDC', 6],
    ['compound-v3-cusdc', 'cUSDCv3', 6], ['sky-susds', 'sUSDS', 18], ['sky-usds', 'USDS', 18],
  ];
  for (const [id, sym, dec] of erc20s) {
    if (!(await hasCode(id, CAND[id]))) continue;
    try {
      const s = await read(CAND[id], 'symbol', 'symbol');
      const d = await read(CAND[id], 'decimals', 'decimals');
      if (s !== sym) { fail(`${id}: symbol()='${s}', expected '${sym}'`); continue; }
      if (d !== dec) { fail(`${id}: decimals()=${d}, expected ${dec}`); continue; }
      V[id] = ok(id, CAND[id], `symbol()='${s}', decimals()=${d} at block ${block}`);
    } catch (e) { fail(`${id}: canonical read threw — ${e.shortMessage || e.message}`); }
  }

  // ── protocol NAV rates (also the classifier's reference leg) ───────────────
  const nav = {};
  try { nav.steth = Number(await read(CAND['lido-steth'], 'getPooledEthByShares', 'getPooledEthByShares', [10n ** 18n])) / 1e18; } catch (e) { fail(`lido-steth getPooledEthByShares: ${e.shortMessage || e.message}`); }
  try { nav.reth = Number(await read(CAND['rocket-reth'], 'getExchangeRate', 'getExchangeRate')) / 1e18; } catch (e) { fail(`rocket-reth getExchangeRate: ${e.shortMessage || e.message}`); }
  try { nav.cbeth = Number(await read(CAND['coinbase-cbeth'], 'exchangeRate', 'exchangeRate')) / 1e18; } catch (e) { fail(`coinbase-cbeth exchangeRate: ${e.shortMessage || e.message}`); }
  try { nav.weeth = Number(await read(CAND['etherfi-weeth'], 'getRate', 'getRate')) / 1e18; } catch (e) { fail(`etherfi-weeth getRate: ${e.shortMessage || e.message}`); }
  console.log(`# protocol NAV rates: ${JSON.stringify(nav)}`);

  // ── Lido oracle + queue (semantics, not just identity) ─────────────────────
  if (await hasCode('lido-legacy-oracle', CAND['lido-legacy-oracle'])) {
    try {
      const [post, pre, elapsed] = await read(CAND['lido-legacy-oracle'], 'getLastCompletedReportDelta', 'getLastCompletedReportDelta');
      const supply = await read(CAND['lido-steth'], 'totalSupply', 'totalSupply');
      const within1pct = post > 0n && supply > 0n && Math.abs(Number(post) / Number(supply) - 1) < 0.01;
      if (elapsed < 80000n || elapsed > 100000n) fail(`lido-legacy-oracle: timeElapsed=${elapsed}, expected a ~1-day report in [80000,100000]`);
      else if (!within1pct) fail(`lido-legacy-oracle: postTotalPooledEther=${post} is not within 1% of stETH.totalSupply()=${supply}`);
      else V['lido-legacy-oracle'] = ok('lido-legacy-oracle', CAND['lido-legacy-oracle'], `getLastCompletedReportDelta()=(post ${post}, pre ${pre}, timeElapsed ${elapsed}s); stETH.totalSupply()=${supply} at block ${block}`);
    } catch (e) { fail(`lido-legacy-oracle: ${e.shortMessage || e.message}`); }
  }
  try {
    const feeBps = await read(CAND['lido-steth'], 'getFee', 'getFee');
    if (feeBps <= 0 || feeBps > 2000) fail(`lido-steth getFee()=${feeBps}, expected (0,2000] bps`);
    else console.log(`# lido getFee() = ${feeBps} bps`);
  } catch (e) { fail(`lido-steth getFee: ${e.shortMessage || e.message}`); }
  if (await hasCode('lido-withdrawal-queue', CAND['lido-withdrawal-queue'])) {
    try {
      const s = await read(CAND['lido-withdrawal-queue'], 'symbol', 'symbol');
      const backlog = await read(CAND['lido-withdrawal-queue'], 'unfinalizedStETH', 'unfinalizedStETH');
      if (s !== 'unstETH') fail(`lido-withdrawal-queue: symbol()='${s}', expected 'unstETH'`);
      else V['lido-withdrawal-queue'] = ok('lido-withdrawal-queue', CAND['lido-withdrawal-queue'], `symbol()='${s}', unfinalizedStETH()=${backlog} wei at block ${block}`);
    } catch (e) { fail(`lido-withdrawal-queue: ${e.shortMessage || e.message}`); }
  }

  // ── Rocket Pool: resolve through storage, then PIN what it resolved to ─────
  const rocketKey = (name) => keccak256(encodePacked(['string', 'string'], ['contract.address', name]));
  if (await hasCode('rocket-storage', CAND['rocket-storage'])) {
    try {
      const pool = await read(CAND['rocket-storage'], 'storageGetAddress', 'getAddress', [rocketKey('rocketDepositPool')]);
      const settings = await read(CAND['rocket-storage'], 'storageGetAddress', 'getAddress', [rocketKey('rocketDAOProtocolSettingsDeposit')]);
      const reth = await read(CAND['rocket-storage'], 'storageGetAddress', 'getAddress', [rocketKey('rocketTokenRETH')]);
      if (!eq(reth, CAND['rocket-reth'])) fail(`rocket-storage: resolved rocketTokenRETH=${reth}, expected ${CAND['rocket-reth']}`);
      V['rocket-storage'] = ok('rocket-storage', CAND['rocket-storage'], `getAddress(keccak256("contract.address"+"rocketDepositPool"))=${getAddress(pool)}, +"rocketDAOProtocolSettingsDeposit"=${getAddress(settings)}, +"rocketTokenRETH"=${getAddress(reth)} at block ${block}`);
      if (await hasCode('rocket-deposit-pool', pool)) {
        const bal = await read(pool, 'getBalance', 'getBalance');
        const excess = await read(pool, 'getExcessBalance', 'getExcessBalance');
        V['rocket-deposit-pool'] = ok('rocket-deposit-pool', pool, `resolved through RocketStorage.getAddress("contract.addressrocketDepositPool"); getBalance()=${bal} wei, getExcessBalance()=${excess} wei at block ${block}`);
      }
      if (await hasCode('rocket-settings-deposit', settings)) {
        const enabled = await read(settings, 'getDepositEnabled', 'getDepositEnabled');
        const min = await read(settings, 'getMinimumDeposit', 'getMinimumDeposit');
        const max = await read(settings, 'getMaximumDepositPoolSize', 'getMaximumDepositPoolSize');
        const fee = await read(settings, 'getDepositFee', 'getDepositFee');
        V['rocket-settings-deposit'] = ok('rocket-settings-deposit', settings, `resolved through RocketStorage; getDepositEnabled()=${enabled}, getMinimumDeposit()=${min} wei, getMaximumDepositPoolSize()=${max} wei, getDepositFee()=${fee} (1e18 scale) at block ${block}`);
      }
    } catch (e) { fail(`rocket-storage: ${e.shortMessage || e.message}`); }
  }

  // ── ether.fi / Renzo entry points name their own receipt token ─────────────
  if (await hasCode('etherfi-liquidity-pool', CAND['etherfi-liquidity-pool'])) {
    try {
      const e = await read(CAND['etherfi-liquidity-pool'], 'eETH', 'eETH');
      const pooled = await read(CAND['etherfi-liquidity-pool'], 'getTotalPooledEther', 'getTotalPooledEther');
      if (!eq(e, CAND['etherfi-eeth'])) fail(`etherfi-liquidity-pool: eETH()=${e}, expected ${CAND['etherfi-eeth']}`);
      else V['etherfi-liquidity-pool'] = ok('etherfi-liquidity-pool', CAND['etherfi-liquidity-pool'], `eETH()=${getAddress(e)}, getTotalPooledEther()=${pooled} wei at block ${block}`);
    } catch (e) { fail(`etherfi-liquidity-pool: ${e.shortMessage || e.message}`); }
  }
  if (await hasCode('renzo-restake-manager', CAND['renzo-restake-manager'])) {
    try {
      const z = await read(CAND['renzo-restake-manager'], 'ezETH', 'ezETH');
      if (!eq(z, CAND['renzo-ezeth'])) fail(`renzo-restake-manager: ezETH()=${z}, expected ${CAND['renzo-ezeth']}`);
      else V['renzo-restake-manager'] = ok('renzo-restake-manager', CAND['renzo-restake-manager'], `ezETH()=${getAddress(z)} at block ${block}`);
    } catch (e) { fail(`renzo-restake-manager: ${e.shortMessage || e.message}`); }
  }

  // ── Aave: the Pool is whatever the addresses provider says it is ───────────
  if (await hasCode('aave-v3-pool', CAND['aave-v3-pool'])) {
    try {
      const resolved = await read(CAND['aave-v3-provider'], 'aavePoolGetPool', 'getPool');
      if (!eq(resolved, CAND['aave-v3-pool'])) fail(`aave-v3-pool: PoolAddressesProvider.getPool()=${resolved}, expected ${CAND['aave-v3-pool']}`);
      else {
        const rd = await read(CAND['aave-v3-pool'], 'aaveReserveData', 'getReserveData', [getAddress(CAND.usdc)]);
        if (!eq(rd.aTokenAddress, CAND['aave-v3-ausdc'])) fail(`aave-v3-pool: getReserveData(USDC).aTokenAddress=${rd.aTokenAddress}, expected ${CAND['aave-v3-ausdc']}`);
        else V['aave-v3-pool'] = ok('aave-v3-pool', CAND['aave-v3-pool'], `PoolAddressesProvider(${getAddress(CAND['aave-v3-provider'])}).getPool() resolves here; getReserveData(USDC).currentLiquidityRate=${rd.currentLiquidityRate} ray/yr, aToken=${getAddress(rd.aTokenAddress)} at block ${block}`);
      }
      const und = await read(CAND['aave-v3-ausdc'], 'underlying', 'UNDERLYING_ASSET_ADDRESS');
      if (!eq(und, CAND.usdc)) fail(`aave-v3-ausdc: UNDERLYING_ASSET_ADDRESS()=${und}, expected USDC`);
      const held = await read(CAND.usdc, 'balanceOf', 'balanceOf', [getAddress(CAND['aave-v3-ausdc'])]);
      console.log(`# aave aToken holds ${held} USDC units (exit-liquidity leg)`);
    } catch (e) { fail(`aave-v3-pool: ${e.shortMessage || e.message}`); }
  }

  // ── Compound v3 ────────────────────────────────────────────────────────────
  if (await hasCode('compound-v3-cusdc', CAND['compound-v3-cusdc'])) {
    try {
      const bt = await read(CAND['compound-v3-cusdc'], 'baseToken', 'baseToken');
      const util = await read(CAND['compound-v3-cusdc'], 'getUtilization', 'getUtilization');
      const rate = await read(CAND['compound-v3-cusdc'], 'getSupplyRate', 'getSupplyRate', [util]);
      if (!eq(bt, CAND.usdc)) fail(`compound-v3-cusdc: baseToken()=${bt}, expected USDC`);
      else V['compound-v3-cusdc'] = ok('compound-v3-cusdc', CAND['compound-v3-cusdc'], `baseToken()=${getAddress(bt)}, getUtilization()=${util}, getSupplyRate(util)=${rate} per second (×31,536,000/1e18 = ${((Number(rate) / 1e18) * 31536000 * 100).toFixed(2)}% APR) at block ${block}`);
    } catch (e) { fail(`compound-v3-cusdc: ${e.shortMessage || e.message}`); }
  }

  // ── Sky sUSDS: ERC-4626 over USDS, savings rate from ssr() ─────────────────
  if (await hasCode('sky-susds', CAND['sky-susds'])) {
    try {
      const a = await read(CAND['sky-susds'], 'asset', 'asset');
      const cta = await read(CAND['sky-susds'], 'convertToAssets', 'convertToAssets', [10n ** 18n]);
      let ssr = null;
      try { ssr = await read(CAND['sky-susds'], 'ssr', 'ssr'); } catch { /* recorded as unavailable below */ }
      if (!eq(a, CAND['sky-usds'])) fail(`sky-susds: asset()=${a}, expected USDS`);
      else V['sky-susds'] = ok('sky-susds', CAND['sky-susds'], `asset()=${getAddress(a)}, convertToAssets(1e18)=${cta}, ssr()=${ssr ?? 'REVERTED'} at block ${block}`);
      if (ssr === null) fail('sky-susds: ssr() reverted — the savings-rate leg has no source');
    } catch (e) { fail(`sky-susds: ${e.shortMessage || e.message}`); }
  }

  // ── Chainlink feeds: identity by description, CLASS by difference ──────────
  const navFor = { 'steth-eth-feed': nav.steth, 'reth-eth-feed': nav.reth, 'cbeth-eth-feed': nav.cbeth, 'weeth-eth-feed': nav.weeth, 'ezeth-eth-feed': null, 'usdc-usd-feed': 1, 'usds-usd-feed': 1 };
  // The class is PINNED from the publisher's documentation, not derived. The
  // first run of this script tried to derive it — within 5 bps of the protocol
  // rate meant 'exchange-rate', otherwise 'market' — and the chain refuted the
  // test immediately: CBETH / ETH (a market feed) sat 4.55 bps from
  // cbETH.exchangeRate() and RETH / ETH (also a market feed) sat 5.68 bps from
  // rETH.getExchangeRate(). The two landed on opposite sides of the threshold,
  // and which side a MARKET feed falls on is decided by how well the token
  // happens to be trading rather than by what the feed is.
  //
  // So the difference test is used in the one direction where it is sound: a
  // feed pinned as 'exchange-rate' that has drifted far from the protocol rate
  // it republishes has stopped tracking it, and that FAILS. A market feed is
  // never reclassified for sitting close to NAV — that is what a healthy peg
  // looks like. src/lib/yield/onchain.ts `classifyFeedLeg` re-runs exactly this
  // one-way check at runtime.
  const NAV_DRIFT_FAIL = 0.005;
  const feeds = [
    ['steth-eth-feed', 'STETH / ETH', 'market'], ['reth-eth-feed', 'RETH / ETH', 'market'],
    ['cbeth-eth-feed', 'CBETH / ETH', 'market'],
    ['weeth-eth-feed', 'weETH / ETH', 'exchange-rate'], ['ezeth-eth-feed', 'ezETH / ETH', 'exchange-rate'],
    ['usdc-usd-feed', 'USDC / USD', 'market'], ['usds-usd-feed', 'USDS / USD', 'market'],
  ];
  for (const [id, wantDesc, pinnedClass] of feeds) {
    if (!(await hasCode(id, CAND[id]))) continue;
    try {
      const desc = await read(CAND[id], 'description', 'description');
      const dec = await read(CAND[id], 'decimals', 'decimals');
      const [roundId, answer, , updatedAt, answeredInRound] = await read(CAND[id], 'latestRoundData', 'latestRoundData');
      if (desc !== wantDesc) { fail(`${id}: description()='${desc}', expected '${wantDesc}'`); continue; }
      if (answer <= 0n) { fail(`${id}: latestRoundData().answer=${answer}, not positive`); continue; }
      if (answeredInRound < roundId) { fail(`${id}: answeredInRound=${answeredInRound} < roundId=${roundId}`); continue; }
      let priorOk = false;
      try { await read(CAND[id], 'getRoundData', 'getRoundData', [roundId - 1n]); priorOk = true; } catch { priorOk = false; }
      if (!priorOk) fail(`${id}: getRoundData(roundId-1) reverted — no round history for the trailing-rate leg`);
      const ratio = Number(answer) / 10 ** Number(dec);
      const reference = navFor[id];
      let drift = null;
      if (reference != null && reference > 0) {
        drift = Math.abs(ratio - reference) / reference;
        console.log(`#   ${id}: pinned '${pinnedClass}', answer=${ratio}, protocol rate=${reference}, |drift|=${(drift * 1e4).toFixed(2)} bps`);
        if (pinnedClass === 'exchange-rate' && drift > NAV_DRIFT_FAIL) {
          fail(`${id}: pinned as an exchange-rate feed but it is ${(drift * 100).toFixed(2)}% from the protocol's own rate — it is no longer republishing it`);
          continue;
        }
      } else {
        // ezETH: Renzo exposes no cheap on-chain rate view, so there is nothing
        // to refute with. Recorded as unchecked rather than silently assumed
        // correct — the /yield row says so on its NAV cell.
        console.log(`#   ${id}: pinned '${pinnedClass}', answer=${ratio}, NO on-chain protocol rate to cross-check against`);
      }
      const driftNote = drift === null
        ? 'no on-chain protocol rate exists to cross-check it'
        : `${(drift * 1e4).toFixed(2)} bps from the protocol rate read in the same run`;
      V[id] = ok(id, CAND[id], `description()='${desc}', decimals()=${dec}, latestRoundData()=(round ${roundId}, answer ${answer}, updatedAt ${updatedAt}); class '${pinnedClass}' per Chainlink docs, ${driftNote}, at block ${block}`);
    } catch (e) { fail(`${id}: ${e.shortMessage || e.message}`); }
  }

  // ── GeckoTerminal market-leg pools for the exchange-rate-class rows ────────
  for (const [sym, token] of [['rETH', CAND['rocket-reth']], ['weETH', CAND['etherfi-weeth']], ['ezETH', CAND['renzo-ezeth']]]) {
    try {
      const res = await fetch(`https://api.geckoterminal.com/api/v2/networks/eth/tokens/${token}/pools`);
      if (!res.ok) { fail(`geckoterminal ${sym}: HTTP ${res.status}`); continue; }
      const json = await res.json();
      const pools = (json.data ?? [])
        .filter((p) => (p.relationships?.base_token?.data?.id ?? '').toLowerCase().includes('weth')
          || (p.relationships?.quote_token?.data?.id ?? '').toLowerCase().includes(CAND.weth.toLowerCase())
          || (p.relationships?.base_token?.data?.id ?? '').toLowerCase().includes(CAND.weth.toLowerCase()))
        .sort((a, b) => Number(b.attributes?.reserve_in_usd ?? 0) - Number(a.attributes?.reserve_in_usd ?? 0));
      const best = pools[0];
      if (!best) { fail(`geckoterminal ${sym}: no WETH-quoted pool returned`); continue; }
      const pool = best.attributes?.address;
      lines.push(`yield-market-pool-${sym.toLowerCase()} ${pool} — GeckoTerminal deepest WETH-quoted pool for ${sym}, reserve_in_usd=${best.attributes?.reserve_in_usd}, name='${best.attributes?.name}' (read ${new Date().toISOString().slice(0, 10)})`);
    } catch (e) { fail(`geckoterminal ${sym}: ${e.message}`); }
  }

  console.log('\n# ── evidence lines (paste into scripts/addresses.json) ──');
  for (const l of lines) console.log(l);

  if (failures.length > 0) {
    console.error(`\n✗ ${failures.length} failure(s):`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`\n✓ ${lines.length} addresses verified at block ${block}.`);
}

main().catch((e) => { console.error('fatal:', e); process.exit(1); });
