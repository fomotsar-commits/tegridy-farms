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
 * ── THREE OUTCOMES, NOT TWO ─────────────────────────────────────────────────
 *
 * This is the whole safety argument for gating on this script, and the previous
 * shape got it wrong. Every read sat in `catch (e) { fail(e) }` and every fail
 * hit one `process.exit(1)`, so a GeckoTerminal HTTP 429 and a canonical read
 * returning the WRONG SYMBOL came out the same colour and the same exit code.
 * The script exited 1 on repeat runs purely because a third party rate-limited
 * an off-chain lookup, while every on-chain identity read passed. That is the
 * one collapse this file cannot afford: it is the thing that says whether the
 * addresses /yield sends money to are the right addresses. If it cries wolf on
 * someone else's rate limit, either it never gets wired into CI, or it gets
 * wired in and its red is learned as noise — and then a genuinely wrong address
 * arrives wearing the same colour as a 429.
 *
 * verify-addresses.mjs already separates these two ideas structurally, and this
 * file now follows it rather than inventing a second scheme:
 *
 *   the source ANSWERED and the answer disagrees  ->  CHECKED AND WRONG. Fatal.
 *   the source did not answer                     ->  COULD NOT CHECK. Named,
 *                                                     counted, and NOT fatal.
 *
 * "The source answered" is determined POSITIVELY and narrowly — see
 * `classifyReadError`. Anything not positively an answer is COULD NOT CHECK,
 * the same default verify-addresses.mjs takes, and it is safe here because
 * every symptom a wrong address can produce IS positively detected: it returns
 * a different value, or it has no code, or the call reverts / returns no data.
 *
 * ── EXIT CODES ──────────────────────────────────────────────────────────────
 *
 *   0  VERIFIED         every check ran, every check agreed.
 *   1  WRONG            at least one check ran and DISAGREED. Always fatal —
 *                       this is the same meaning exit 1 carries in
 *                       verify-addresses.mjs, so "1" means the same thing in
 *                       both address guards.
 *   2  INCOMPLETE       nothing that ran disagreed, but at least one check did
 *                       not run. NOT fatal: a shared CI rate-limit bucket must
 *                       never be able to produce the same red as a wrong
 *                       address. Also never printed as a pass.
 *   3  NOTHING VERIFIED not one identity was established, in either direction.
 *                       FATAL even though no disagreement was found, because a
 *                       verifier that verified nothing has told you nothing, and
 *                       shipping on it is indistinguishable from not running it.
 *                       Exit 2's "some of it held" argument does not exist here.
 *
 * A CI gate therefore accepts 0 and 2 and rejects 1 and 3. It is NOT a plain
 * `run: node scripts/verify-yield-protocols.mjs`; see the wiring note at the
 * bottom of this file.
 *
 * ── WHAT IS NOT HERE ────────────────────────────────────────────────────────
 *
 * The GeckoTerminal market-depth leg is GONE. It fetched the deepest
 * WETH-quoted pool for rETH / weETH / ezETH and printed a
 * `yield-market-pool-<sym>` evidence line — and nothing consumed that line.
 * There is no such id in scripts/addresses.json and no reference to it in src/.
 * The /yield surface does not read pool depth at all; it says so on the page
 * ("this build does not measure that pool either", src/lib/yield/reads.ts), and
 * those rows render `noMarketLeg`. So the one leg that rate-limits was
 * discovering liquidity context, not identity, for a surface that deliberately
 * refuses to show liquidity context. It was not load-bearing and it is deleted
 * rather than flagged, which also removes the only off-chain host this verifier
 * ever contacted. Liquidity context is a reporting job; it does not belong in
 * the script that decides whether an address is the right address.
 *
 * Read-only, no key, no writes, no dependency beyond viem (already a dep).
 *   node scripts/verify-yield-protocols.mjs             # default keyless roster
 *   ETH_RPC=https://… node scripts/verify-yield-protocols.mjs
 *   node scripts/verify-yield-protocols.mjs --self-test # offline; proves the
 *                                                       # separation still holds
 *
 * Its per-address output line is what goes into the registry entry's `evidence`
 * field, verbatim. A line is only printed for a check that actually RAN.
 */

import {
  createPublicClient, custom, http, getAddress, keccak256, encodePacked,
  encodeAbiParameters, HttpRequestError,
} from 'viem';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mainnet } from 'viem/chains';

const RPC = process.env.ETH_RPC || 'https://ethereum-rpc.publicnode.com';
const client = createPublicClient({ chain: mainnet, transport: http(RPC) });

/** Identity established and agreed. One line per address, registry `evidence`. */
const lines = [];
/** The source answered and the answer DISAGREES. Fatal. */
const wrong = [];
/** The source did not answer. Named, counted, not fatal, never a pass. */
const unreachable = [];

const isWrong = (m) => wrong.push(m);
const cannotCheck = (label, reason) => unreachable.push(`${label} — ${reason}`);

// ── The classifier. Pure, no network, so --self-test proves it on every run ───
//
// Names observed empirically against viem 2.55.19, not from memory. The chain
// for an execution revert is:
//
//   ContractFunctionExecutionError -> ContractFunctionRevertedError
//     -> CallExecutionError -> ExecutionRevertedError -> UnknownRpcError -> Error
//
// and the chain for a raw transport failure is:
//
//   ContractFunctionExecutionError -> CallExecutionError -> UnknownRpcError -> Error
//
// UnknownRpcError appears in BOTH. So the walk must look for an ANSWERED marker
// first and only fall through to unreachable — never the other way round, or
// every revert would be filed as a rate limit and a wrong address would go
// quiet. Precedence is the whole of this function.
const ANSWERED_ERROR_NAMES = new Set([
  'ContractFunctionRevertedError', // the contract answered: it refused the call
  'ContractFunctionZeroDataError', // the node answered '0x' — no such function here
  'AbiDecodingZeroDataError', // the same fact, one level down
  'ExecutionRevertedError', // eth_call itself reverted
]);

/**
 * Did the chain ANSWER, or did the source simply not respond?
 *
 * `{ answered: true }` means a definitive negative result about the ADDRESS —
 * it is checked and wrong. `{ answered: false }` means the check did not run.
 * Unknown error shapes fall to `false` deliberately: a new transport error
 * class filed as "wrong" is noise on a correct registry, which is how a gate
 * gets switched off, and every real wrong-address symptom is positively caught.
 */
export function classifyReadError(err) {
  let node = err;
  let deepest = null;
  for (let depth = 0; node && depth < 8; depth += 1) {
    if (ANSWERED_ERROR_NAMES.has(node.name)) {
      return { answered: true, reason: node.shortMessage || node.message || node.name };
    }
    if (node.name === 'HttpRequestError' && node.status) deepest = `HTTP ${node.status}`;
    else if (node.name === 'TimeoutError') deepest = 'the request timed out';
    else if (node.code && typeof node.code === 'string') deepest = `${node.code}`;
    else if (!deepest && (node.shortMessage || node.message)) deepest = node.shortMessage || node.message;
    node = node.cause;
  }
  return { answered: false, reason: `the source did not answer (${deepest || 'request failed'})` };
}

/**
 * eth_getCode came back. Absence here is a POSITIVE result — the node answered
 * and there is no code — which is the same distinction verify-addresses.mjs
 * draws between a null element in a successful response and a transport error.
 */
export function classifyCode(code) {
  if (code === undefined || code === null || code === '0x' || /^0x0*$/.test(code)) return { present: false };
  return { present: true, bytes: (code.length - 2) / 2 };
}

/**
 * Every reported line names the ADDRESS, not just the id.
 *
 * An id is a label we chose; the address is the thing money goes to, and it is
 * what a reader has to be able to look up. Done HERE, once, over the finished
 * message rather than at each of the twenty-odd call sites, so a check added
 * later cannot forget it — the same reasoning as putting the two-class split in
 * `attempt()` instead of in every catch.
 */
export function withPinnedAddress(message, pinned) {
  const id = String(message).match(/^([A-Za-z0-9-]+)/)?.[1];
  const addr = id && pinned[id];
  if (!addr || message.includes(addr)) return message;
  return `${message}  [pinned: ${getAddress(addr)}]`;
}

export const EXIT = { VERIFIED: 0, WRONG: 1, INCOMPLETE: 2, NOTHING_VERIFIED: 3 };

/**
 * The decision table, pure so it can be asserted without a network.
 *
 * Order is load-bearing. A disagreement outranks everything: a run that both
 * found a wrong address and lost an RPC is a WRONG run, not an incomplete one.
 */
export function verdict({ verified, wrong: wrongCount, unreachable: unreachableCount }) {
  if (wrongCount > 0) {
    return {
      code: EXIT.WRONG,
      label: 'WRONG',
      line: `✗ WRONG (exit ${EXIT.WRONG}) — ${wrongCount} check(s) RAN AND DISAGREED. An address here is where a visitor's money goes. Do not ship.`,
    };
  }
  if (verified === 0) {
    return {
      code: EXIT.NOTHING_VERIFIED,
      label: 'NOTHING VERIFIED',
      line: `✗ NOTHING VERIFIED (exit ${EXIT.NOTHING_VERIFIED}) — not one identity was established, in either direction. Nothing disagreed because nothing was asked. This run is worth exactly as much as not running it.`,
    };
  }
  if (unreachableCount > 0) {
    return {
      code: EXIT.INCOMPLETE,
      label: 'INCOMPLETE',
      line: `~ INCOMPLETE (exit ${EXIT.INCOMPLETE}) — ${verified} verified, ${unreachableCount} COULD NOT BE CHECKED (listed above). Nothing that ran disagreed. This is not a pass, and it is not a failure of any address.`,
    };
  }
  return {
    code: EXIT.VERIFIED,
    label: 'VERIFIED',
    line: `✓ VERIFIED (exit ${EXIT.VERIFIED}) — all ${verified} check(s) ran and agreed.`,
  };
}

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

/**
 * Run one read and file the outcome in the right bucket.
 *
 * Returns `{ ok: true, value }`, or `{ ok: false, kind }` where kind is already
 * recorded. Callers only branch on `ok` — the two-class split happens here, once,
 * so a new check cannot accidentally collapse them by writing its own catch.
 */
async function attempt(label, fn, wrongAs) {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    const c = classifyReadError(e);
    if (c.answered) { isWrong(wrongAs ? `${wrongAs} (${c.reason})` : `${label}: ${c.reason}`); return { ok: false, kind: 'wrong' }; }
    cannotCheck(label, c.reason);
    return { ok: false, kind: 'unreachable' };
  }
}

async function hasCode(id, address) {
  const r = await attempt(`${id} getCode(${address})`, () => client.getCode({ address: getAddress(address) }));
  if (!r.ok) return false; // already filed, in whichever bucket it belongs
  if (!classifyCode(r.value).present) { isWrong(`${id}: NO CODE at ${address} — the node answered, and there is nothing deployed there`); return false; }
  return true;
}

/** One verified address, printed in the exact shape the registry `evidence` wants. */
function ok(id, address, detail) {
  const checksummed = getAddress(address);
  lines.push(`${id} ${checksummed} — ${detail}`);
  return checksummed;
}

async function main() {
  // The preamble is the whole run's dependency. If the RPC will not say what
  // chain and block it is on, nothing below can be attempted, and attempting it
  // anyway would just produce one unreachable line per address at one timeout
  // each. Bail with the count of what did NOT get looked at.
  const pre = await attempt(`RPC preamble at ${RPC}`, async () => ({
    block: await client.getBlockNumber(),
    chainId: await client.getChainId(),
  }));
  if (!pre.ok) {
    console.log(`# verify-yield-protocols — the RPC did not answer; 0 of ${Object.keys(CAND).length} pinned addresses were looked at\n`);
    return;
  }
  const { block, chainId } = pre.value;
  if (chainId !== 1) isWrong(`RPC ${RPC} is chain ${chainId}, not Ethereum mainnet`);
  console.log(`# verify-yield-protocols — chain ${chainId} block ${block} via ${RPC}\n`);

  // ── Multicall3 (the clock legs ride in the same aggregate3 as every read) ──
  if (await hasCode('multicall3', CAND.multicall3)) {
    const r = await attempt('multicall3 identity', async () => ({
      cid: await read(CAND.multicall3, 'getChainId', 'getChainId'),
      ts: await read(CAND.multicall3, 'getCurrentBlockTimestamp', 'getCurrentBlockTimestamp'),
    }));
    if (r.ok) {
      const { cid, ts } = r.value;
      if (cid !== 1n) isWrong(`multicall3: getChainId()=${cid}, expected 1`);
      else if (ts <= 0n) isWrong('multicall3: getCurrentBlockTimestamp() is not positive');
      else ok('multicall3', CAND.multicall3, `getChainId()=${cid}, getCurrentBlockTimestamp()=${ts} at block ${block}`);
    }
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
    const r = await attempt(`${id} symbol()/decimals()`, async () => ({
      s: await read(CAND[id], 'symbol', 'symbol'),
      d: await read(CAND[id], 'decimals', 'decimals'),
    }));
    if (!r.ok) continue;
    const { s, d } = r.value;
    if (s !== sym) { isWrong(`${id}: symbol()='${s}', expected '${sym}'`); continue; }
    if (d !== dec) { isWrong(`${id}: decimals()=${d}, expected ${dec}`); continue; }
    ok(id, CAND[id], `symbol()='${s}', decimals()=${d} at block ${block}`);
  }

  // ── protocol NAV rates (also the classifier's reference leg) ───────────────
  //
  // TRI-STATE on purpose. "Renzo publishes no cheap on-chain rate view" and
  // "the RPC did not answer this minute" are different facts about a feed's
  // cross-check, and the old shape rendered both as a null reference and then
  // printed the same reassuring 'NO on-chain protocol rate to cross-check
  // against' line. One of those is a permanent, documented absence; the other
  // is a check that silently did not run.
  const nav = {};
  const navRead = async (key, label, fn) => {
    const r = await attempt(label, fn);
    nav[key] = r.ok
      ? { state: 'read', value: Number(r.value) / 1e18, note: 'the protocol rate read in the same run' }
      : { state: 'unreadable', note: 'the protocol rate could not be read this run' };
  };
  await navRead('steth', 'lido-steth getPooledEthByShares()', () => read(CAND['lido-steth'], 'getPooledEthByShares', 'getPooledEthByShares', [10n ** 18n]));
  await navRead('reth', 'rocket-reth getExchangeRate()', () => read(CAND['rocket-reth'], 'getExchangeRate', 'getExchangeRate'));
  await navRead('cbeth', 'coinbase-cbeth exchangeRate()', () => read(CAND['coinbase-cbeth'], 'exchangeRate', 'exchangeRate'));
  await navRead('weeth', 'etherfi-weeth getRate()', () => read(CAND['etherfi-weeth'], 'getRate', 'getRate'));
  console.log(`# protocol NAV rates: ${JSON.stringify(Object.fromEntries(Object.entries(nav).map(([k, v]) => [k, v.state === 'read' ? v.value : v.state.toUpperCase()])))}`);

  // ── Lido oracle + queue (semantics, not just identity) ─────────────────────
  if (await hasCode('lido-legacy-oracle', CAND['lido-legacy-oracle'])) {
    const r = await attempt('lido-legacy-oracle getLastCompletedReportDelta()', async () => ({
      delta: await read(CAND['lido-legacy-oracle'], 'getLastCompletedReportDelta', 'getLastCompletedReportDelta'),
      supply: await read(CAND['lido-steth'], 'totalSupply', 'totalSupply'),
    }));
    if (r.ok) {
      const [post, pre2, elapsed] = r.value.delta;
      const supply = r.value.supply;
      const within1pct = post > 0n && supply > 0n && Math.abs(Number(post) / Number(supply) - 1) < 0.01;
      if (elapsed < 80000n || elapsed > 100000n) isWrong(`lido-legacy-oracle: timeElapsed=${elapsed}, expected a ~1-day report in [80000,100000]`);
      else if (!within1pct) isWrong(`lido-legacy-oracle: postTotalPooledEther=${post} is not within 1% of stETH.totalSupply()=${supply}`);
      else ok('lido-legacy-oracle', CAND['lido-legacy-oracle'], `getLastCompletedReportDelta()=(post ${post}, pre ${pre2}, timeElapsed ${elapsed}s); stETH.totalSupply()=${supply} at block ${block}`);
    }
  }
  const feeR = await attempt('lido-steth getFee()', () => read(CAND['lido-steth'], 'getFee', 'getFee'));
  if (feeR.ok) {
    if (feeR.value <= 0 || feeR.value > 2000) isWrong(`lido-steth getFee()=${feeR.value}, expected (0,2000] bps`);
    else console.log(`# lido getFee() = ${feeR.value} bps`);
  }
  if (await hasCode('lido-withdrawal-queue', CAND['lido-withdrawal-queue'])) {
    const r = await attempt('lido-withdrawal-queue symbol()/unfinalizedStETH()', async () => ({
      s: await read(CAND['lido-withdrawal-queue'], 'symbol', 'symbol'),
      backlog: await read(CAND['lido-withdrawal-queue'], 'unfinalizedStETH', 'unfinalizedStETH'),
    }));
    if (r.ok) {
      const { s, backlog } = r.value;
      if (s !== 'unstETH') isWrong(`lido-withdrawal-queue: symbol()='${s}', expected 'unstETH'`);
      else ok('lido-withdrawal-queue', CAND['lido-withdrawal-queue'], `symbol()='${s}', unfinalizedStETH()=${backlog} wei at block ${block}`);
    }
  }

  // ── Rocket Pool: resolve through storage, then PIN what it resolved to ─────
  const rocketKey = (name) => keccak256(encodePacked(['string', 'string'], ['contract.address', name]));
  if (await hasCode('rocket-storage', CAND['rocket-storage'])) {
    const r = await attempt('rocket-storage getAddress() resolutions', async () => ({
      pool: await read(CAND['rocket-storage'], 'storageGetAddress', 'getAddress', [rocketKey('rocketDepositPool')]),
      settings: await read(CAND['rocket-storage'], 'storageGetAddress', 'getAddress', [rocketKey('rocketDAOProtocolSettingsDeposit')]),
      reth: await read(CAND['rocket-storage'], 'storageGetAddress', 'getAddress', [rocketKey('rocketTokenRETH')]),
    }));
    if (r.ok) {
      const { pool, settings, reth } = r.value;
      if (!eq(reth, CAND['rocket-reth'])) isWrong(`rocket-storage: resolved rocketTokenRETH=${reth}, expected ${CAND['rocket-reth']}`);
      else ok('rocket-storage', CAND['rocket-storage'], `getAddress(keccak256("contract.address"+"rocketDepositPool"))=${getAddress(pool)}, +"rocketDAOProtocolSettingsDeposit"=${getAddress(settings)}, +"rocketTokenRETH"=${getAddress(reth)} at block ${block}`);
      if (await hasCode('rocket-deposit-pool', pool)) {
        const p = await attempt('rocket-deposit-pool getBalance()/getExcessBalance()', async () => ({
          bal: await read(pool, 'getBalance', 'getBalance'),
          excess: await read(pool, 'getExcessBalance', 'getExcessBalance'),
        }));
        if (p.ok) ok('rocket-deposit-pool', pool, `resolved through RocketStorage.getAddress("contract.addressrocketDepositPool"); getBalance()=${p.value.bal} wei, getExcessBalance()=${p.value.excess} wei at block ${block}`);
      }
      if (await hasCode('rocket-settings-deposit', settings)) {
        const s = await attempt('rocket-settings-deposit deposit gates', async () => ({
          enabled: await read(settings, 'getDepositEnabled', 'getDepositEnabled'),
          min: await read(settings, 'getMinimumDeposit', 'getMinimumDeposit'),
          max: await read(settings, 'getMaximumDepositPoolSize', 'getMaximumDepositPoolSize'),
          fee: await read(settings, 'getDepositFee', 'getDepositFee'),
        }));
        if (s.ok) ok('rocket-settings-deposit', settings, `resolved through RocketStorage; getDepositEnabled()=${s.value.enabled}, getMinimumDeposit()=${s.value.min} wei, getMaximumDepositPoolSize()=${s.value.max} wei, getDepositFee()=${s.value.fee} (1e18 scale) at block ${block}`);
      }
    }
  }

  // ── ether.fi / Renzo entry points name their own receipt token ─────────────
  if (await hasCode('etherfi-liquidity-pool', CAND['etherfi-liquidity-pool'])) {
    const r = await attempt('etherfi-liquidity-pool eETH()', async () => ({
      e: await read(CAND['etherfi-liquidity-pool'], 'eETH', 'eETH'),
      pooled: await read(CAND['etherfi-liquidity-pool'], 'getTotalPooledEther', 'getTotalPooledEther'),
    }));
    if (r.ok) {
      const { e, pooled } = r.value;
      if (!eq(e, CAND['etherfi-eeth'])) isWrong(`etherfi-liquidity-pool: eETH()=${e}, expected ${CAND['etherfi-eeth']}`);
      else ok('etherfi-liquidity-pool', CAND['etherfi-liquidity-pool'], `eETH()=${getAddress(e)}, getTotalPooledEther()=${pooled} wei at block ${block}`);
    }
  }
  if (await hasCode('renzo-restake-manager', CAND['renzo-restake-manager'])) {
    const r = await attempt('renzo-restake-manager ezETH()', () => read(CAND['renzo-restake-manager'], 'ezETH', 'ezETH'));
    if (r.ok) {
      if (!eq(r.value, CAND['renzo-ezeth'])) isWrong(`renzo-restake-manager: ezETH()=${r.value}, expected ${CAND['renzo-ezeth']}`);
      else ok('renzo-restake-manager', CAND['renzo-restake-manager'], `ezETH()=${getAddress(r.value)} at block ${block}`);
    }
  }

  // ── Aave: the Pool is whatever the addresses provider says it is ───────────
  if (await hasCode('aave-v3-pool', CAND['aave-v3-pool'])) {
    const r = await attempt('aave-v3-provider getPool()', () => read(CAND['aave-v3-provider'], 'aavePoolGetPool', 'getPool'));
    if (r.ok) {
      if (!eq(r.value, CAND['aave-v3-pool'])) isWrong(`aave-v3-pool: PoolAddressesProvider.getPool()=${r.value}, expected ${CAND['aave-v3-pool']}`);
      else {
        const d = await attempt('aave-v3-pool getReserveData(USDC)', () => read(CAND['aave-v3-pool'], 'aaveReserveData', 'getReserveData', [getAddress(CAND.usdc)]));
        if (d.ok) {
          const rd = d.value;
          if (!eq(rd.aTokenAddress, CAND['aave-v3-ausdc'])) isWrong(`aave-v3-pool: getReserveData(USDC).aTokenAddress=${rd.aTokenAddress}, expected ${CAND['aave-v3-ausdc']}`);
          else ok('aave-v3-pool', CAND['aave-v3-pool'], `PoolAddressesProvider(${getAddress(CAND['aave-v3-provider'])}).getPool() resolves here; getReserveData(USDC).currentLiquidityRate=${rd.currentLiquidityRate} ray/yr, aToken=${getAddress(rd.aTokenAddress)} at block ${block}`);
        }
      }
    }
    const u = await attempt('aave-v3-ausdc UNDERLYING_ASSET_ADDRESS()', () => read(CAND['aave-v3-ausdc'], 'underlying', 'UNDERLYING_ASSET_ADDRESS'));
    if (u.ok && !eq(u.value, CAND.usdc)) isWrong(`aave-v3-ausdc: UNDERLYING_ASSET_ADDRESS()=${u.value}, expected USDC`);
    const h = await attempt('aave-v3-ausdc exit-liquidity balance', () => read(CAND.usdc, 'balanceOf', 'balanceOf', [getAddress(CAND['aave-v3-ausdc'])]));
    if (h.ok) console.log(`# aave aToken holds ${h.value} USDC units (exit-liquidity leg)`);
  }

  // ── Compound v3 ────────────────────────────────────────────────────────────
  if (await hasCode('compound-v3-cusdc', CAND['compound-v3-cusdc'])) {
    const r = await attempt('compound-v3-cusdc baseToken()/rate', async () => {
      const bt = await read(CAND['compound-v3-cusdc'], 'baseToken', 'baseToken');
      const util = await read(CAND['compound-v3-cusdc'], 'getUtilization', 'getUtilization');
      const rate = await read(CAND['compound-v3-cusdc'], 'getSupplyRate', 'getSupplyRate', [util]);
      return { bt, util, rate };
    });
    if (r.ok) {
      const { bt, util, rate } = r.value;
      if (!eq(bt, CAND.usdc)) isWrong(`compound-v3-cusdc: baseToken()=${bt}, expected USDC`);
      else ok('compound-v3-cusdc', CAND['compound-v3-cusdc'], `baseToken()=${getAddress(bt)}, getUtilization()=${util}, getSupplyRate(util)=${rate} per second (×31,536,000/1e18 = ${((Number(rate) / 1e18) * 31536000 * 100).toFixed(2)}% APR) at block ${block}`);
    }
  }

  // ── Sky sUSDS: ERC-4626 over USDS, savings rate from ssr() ─────────────────
  if (await hasCode('sky-susds', CAND['sky-susds'])) {
    const r = await attempt('sky-susds asset()/convertToAssets()', async () => ({
      a: await read(CAND['sky-susds'], 'asset', 'asset'),
      cta: await read(CAND['sky-susds'], 'convertToAssets', 'convertToAssets', [10n ** 18n]),
    }));
    if (r.ok) {
      const { a, cta } = r.value;
      // ssr() gets its own attempt: a REVERT here means the savings-rate leg has
      // no source, which is a real finding. A 429 here means we did not ask.
      // The old shape reported both as "ssr() reverted", which invents a
      // diagnosis out of a rate limit.
      const s = await attempt('sky-susds ssr()', () => read(CAND['sky-susds'], 'ssr', 'ssr'));
      const ssrNote = s.ok ? `${s.value}` : s.kind === 'wrong' ? 'REVERTED' : 'NOT READ THIS RUN';
      if (!eq(a, CAND['sky-usds'])) isWrong(`sky-susds: asset()=${a}, expected USDS`);
      else ok('sky-susds', CAND['sky-susds'], `asset()=${getAddress(a)}, convertToAssets(1e18)=${cta}, ssr()=${ssrNote} at block ${block}`);
    }
  }

  // ── Chainlink feeds: identity by description, CLASS by difference ──────────
  //
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
  // `known` is a definition, not a chain read, and says so. `none` is a
  // permanent documented absence. `unreadable` is a check that did not run and
  // must never print like either of the other two.
  const DOLLAR = { state: 'known', value: 1, note: 'the $1.00 dollar peg (a definition, not a chain read)' };
  const EZETH_NONE = { state: 'none', note: 'Renzo exposes no cheap on-chain rate view, so there is nothing to refute with' };
  const navFor = {
    'steth-eth-feed': nav.steth, 'reth-eth-feed': nav.reth, 'cbeth-eth-feed': nav.cbeth,
    'weeth-eth-feed': nav.weeth, 'ezeth-eth-feed': EZETH_NONE,
    'usdc-usd-feed': DOLLAR, 'usds-usd-feed': DOLLAR,
  };
  const feeds = [
    ['steth-eth-feed', 'STETH / ETH', 'market'], ['reth-eth-feed', 'RETH / ETH', 'market'],
    ['cbeth-eth-feed', 'CBETH / ETH', 'market'],
    ['weeth-eth-feed', 'weETH / ETH', 'exchange-rate'], ['ezeth-eth-feed', 'ezETH / ETH', 'exchange-rate'],
    ['usdc-usd-feed', 'USDC / USD', 'market'], ['usds-usd-feed', 'USDS / USD', 'market'],
  ];
  for (const [id, wantDesc, pinnedClass] of feeds) {
    if (!(await hasCode(id, CAND[id]))) continue;
    const r = await attempt(`${id} description()/latestRoundData()`, async () => ({
      desc: await read(CAND[id], 'description', 'description'),
      dec: await read(CAND[id], 'decimals', 'decimals'),
      round: await read(CAND[id], 'latestRoundData', 'latestRoundData'),
    }));
    if (!r.ok) continue;
    const { desc, dec } = r.value;
    const [roundId, answer, , updatedAt, answeredInRound] = r.value.round;
    if (desc !== wantDesc) { isWrong(`${id}: description()='${desc}', expected '${wantDesc}'`); continue; }
    if (answer <= 0n) { isWrong(`${id}: latestRoundData().answer=${answer}, not positive`); continue; }
    if (answeredInRound < roundId) { isWrong(`${id}: answeredInRound=${answeredInRound} < roundId=${roundId}`); continue; }
    // A REVERT here is a real finding (no round history for the trailing-rate
    // leg). A rate limit here is not, and must not be reported as one.
    await attempt(
      `${id} getRoundData(roundId-1)`,
      () => read(CAND[id], 'getRoundData', 'getRoundData', [roundId - 1n]),
      `${id}: getRoundData(roundId-1) was refused — no round history for the trailing-rate leg`,
    );

    const reference = navFor[id];
    let driftNote;
    if ((reference.state === 'read' || reference.state === 'known') && reference.value > 0) {
      const drift = Math.abs(Number(answer) / 10 ** Number(dec) - reference.value) / reference.value;
      console.log(`#   ${id}: pinned '${pinnedClass}', answer=${Number(answer) / 10 ** Number(dec)}, reference=${reference.value}, |drift|=${(drift * 1e4).toFixed(2)} bps`);
      if (pinnedClass === 'exchange-rate' && drift > NAV_DRIFT_FAIL) {
        isWrong(`${id}: pinned as an exchange-rate feed but it is ${(drift * 100).toFixed(2)}% from the protocol's own rate — it is no longer republishing it`);
        continue;
      }
      driftNote = `${(drift * 1e4).toFixed(2)} bps from ${reference.note}`;
    } else if (reference.state === 'none') {
      console.log(`#   ${id}: pinned '${pinnedClass}', ${reference.note}`);
      driftNote = `no on-chain protocol rate exists to cross-check it (${reference.note})`;
    } else {
      // The identity of this feed WAS established. Its drift cross-check was
      // not. Those are separate facts and the evidence line says so, so an
      // `evidence` string can never claim a comparison that did not happen.
      cannotCheck(`${id} drift cross-check`, reference.note);
      console.log(`#   ${id}: pinned '${pinnedClass}', DRIFT CROSS-CHECK DID NOT RUN — ${reference.note}`);
      driftNote = 'DRIFT CROSS-CHECK DID NOT RUN in this run — the protocol rate it compares against could not be read';
    }
    ok(id, CAND[id], `description()='${desc}', decimals()=${dec}, latestRoundData()=(round ${roundId}, answer ${answer}, updatedAt ${updatedAt}); class '${pinnedClass}' per Chainlink docs, ${driftNote}, at block ${block}`);
  }
}

function report() {
  if (lines.length) {
    console.log('\n# ── evidence lines (paste into scripts/addresses.json) ──');
    for (const l of lines) console.log(l);
  }

  console.log('\n# ── outcome ────────────────────────────────────────────────');
  console.log(`  ${lines.length} verified   ·   ${wrong.length} CHECKED AND WRONG   ·   ${unreachable.length} COULD NOT CHECK`);

  // Printed whenever there is one, ABOVE the verdict, so "did not run" can never
  // be read off the bottom line as "ran and was fine".
  if (unreachable.length) {
    console.log('\n  COULD NOT CHECK — these did not run. This is not a pass and not a failure of any address:');
    for (const u of unreachable) console.log(`    ? ${withPinnedAddress(u, CAND)}`);
  }
  if (wrong.length) {
    console.error('\n  CHECKED AND WRONG — the source answered and the answer disagrees:');
    for (const w of wrong) console.error(`    x ${withPinnedAddress(w, CAND)}`);
  }

  const v = verdict({ verified: lines.length, wrong: wrong.length, unreachable: unreachable.length });
  console.log(`\n${v.line}`);
  process.exit(v.code);
}

/**
 * Prove the two classes cannot collapse back into one.
 *
 * A passing gate is not evidence that a gate works — it is equally consistent
 * with a gate that cannot tell the two apart, which is exactly the state this
 * file was in. So the separation gets its own offline proof, in both directions,
 * on the real viem error shapes rather than on remembered ones: the probe
 * transport is `custom({ request })`, which is a genuine viem client whose
 * request function never touches the network, so what comes back is what a
 * rate-limited public RPC really produces.
 */
async function selfTest() {
  const rows = [];
  const t = (name, isOk) => rows.push({ name, ok: isOk });
  const ADDR = getAddress(CAND.multicall3);
  const probe = async (request) => {
    try {
      const c = createPublicClient({ chain: mainnet, transport: custom({ request }) });
      await c.readContract({ address: ADDR, abi: A.symbol, functionName: 'symbol' });
      return null; // the read SUCCEEDED
    } catch (e) { return classifyReadError(e); }
  };

  // ── 1. The collapse itself, both directions, through real viem wrapping ────
  const c429 = await probe(async () => { throw new HttpRequestError({ status: 429, url: 'https://rpc.invalid', details: 'Too Many Requests' }); });
  t('an HTTP 429 from the RPC is NOT an answer (it is COULD NOT CHECK)', c429?.answered === false);
  t('…and the 429 is named in the reason, not swallowed', /429/.test(c429?.reason ?? ''));

  const cZero = await probe(async ({ method }) => (method === 'eth_call' ? '0x' : '0x1'));
  t('a node answering 0x IS an answer — the address has no such function (CHECKED AND WRONG)', cZero?.answered === true);

  // PRECEDENCE. A real revert's cause chain carries BOTH ContractFunctionRevertedError
  // and UnknownRpcError. A walk that matched the transport marker first would file
  // every revert as a rate limit and a wrong address would go quiet.
  const cRevert = await probe(async ({ method }) => {
    if (method !== 'eth_call') return '0x1';
    const e = new Error('execution reverted'); e.code = 3; throw e;
  });
  t('a revert IS an answer even though UnknownRpcError is in the same cause chain', cRevert?.answered === true);

  const cNet = await probe(async () => { throw new Error('fetch failed'); });
  t('a bare transport failure is NOT an answer', cNet?.answered === false);

  // CONTROL: without this, every case above is equally consistent with
  // "classifyReadError is reached no matter what", i.e. nothing ever succeeds.
  const okBody = encodeAbiParameters([{ type: 'string' }], ['MOCK']);
  t('CONTROL — a successful read throws nothing at all', (await probe(async ({ method }) => (method === 'eth_call' ? okBody : '0x1'))) === null);

  // An unrecognised error class defaults to COULD NOT CHECK, not to WRONG. The
  // safe default is the quiet one HERE because every wrong-address symptom is
  // positively detected above; filing unknown transports as WRONG is how a gate
  // becomes noise and then gets switched off.
  t('an unrecognised error class defaults to COULD NOT CHECK', classifyReadError({ name: 'SomeFutureViemError', message: 'x' }).answered === false);

  // ── 2. eth_getCode absence is POSITIVE, the same way verify-addresses.mjs
  //       treats a null element in a successful response.
  t('getCode 0x is a definitive absence', classifyCode('0x').present === false);
  t('getCode undefined is a definitive absence', classifyCode(undefined).present === false);
  t('CONTROL — real bytecode is present', classifyCode('0x60806040').present === true);

  // ── 2b. A report line must name the ADDRESS, not just the id we chose. ────
  const PIN = { 'sky-susds': CAND['sky-susds'] };
  t(
    'a wrong-address line is stamped with the pinned address',
    withPinnedAddress("sky-susds: symbol()='WETH', expected 'sUSDS'", PIN).includes(getAddress(CAND['sky-susds'])),
  );
  t(
    'CONTROL — a line that already names the address is not stamped twice',
    withPinnedAddress(`sky-susds: NO CODE at ${CAND['sky-susds']}`, PIN).split('0xa3931d').length === 2,
  );
  t('CONTROL — an unrecognised id passes through untouched', withPinnedAddress('rocket-deposit-pool getBalance(): x', PIN) === 'rocket-deposit-pool getBalance(): x');

  // ── 3. The decision table. Each row is a rule the exit code has to keep. ───
  t('all checks ran and agreed -> 0 VERIFIED', verdict({ verified: 27, wrong: 0, unreachable: 0 }).code === EXIT.VERIFIED);
  t('one wrong address -> 1 WRONG (fatal)', verdict({ verified: 26, wrong: 1, unreachable: 0 }).code === EXIT.WRONG);
  t('a wrong address OUTRANKS an unreachable source -> still 1', verdict({ verified: 20, wrong: 1, unreachable: 6 }).code === EXIT.WRONG);
  t('unreachable sources alone -> 2 INCOMPLETE, never 1', verdict({ verified: 20, wrong: 0, unreachable: 7 }).code === EXIT.INCOMPLETE);
  t('nothing verified at all -> 3, not 0', verdict({ verified: 0, wrong: 0, unreachable: 1 }).code === EXIT.NOTHING_VERIFIED);
  t('a totally silent run -> 3, not 0', verdict({ verified: 0, wrong: 0, unreachable: 0 }).code === EXIT.NOTHING_VERIFIED);
  // The four codes must stay four codes. A refactor that maps two states onto
  // one number puts the collapse straight back.
  t('the four outcomes have four DISTINCT exit codes', new Set([
    verdict({ verified: 1, wrong: 0, unreachable: 0 }).code,
    verdict({ verified: 1, wrong: 1, unreachable: 0 }).code,
    verdict({ verified: 1, wrong: 0, unreachable: 1 }).code,
    verdict({ verified: 0, wrong: 0, unreachable: 1 }).code,
  ]).size === 4);

  // ── 4. Only exit 0 may read like success. ─────────────────────────────────
  t('only the VERIFIED verdict prints a ✓', [
    verdict({ verified: 1, wrong: 1, unreachable: 0 }),
    verdict({ verified: 1, wrong: 0, unreachable: 1 }),
    verdict({ verified: 0, wrong: 0, unreachable: 3 }),
  ].every((v) => !v.line.includes('✓')) && verdict({ verified: 1, wrong: 0, unreachable: 0 }).line.includes('✓'));
  t('the INCOMPLETE line says the unchecked ones did not run', /COULD NOT BE CHECKED/.test(verdict({ verified: 1, wrong: 0, unreachable: 2 }).line));
  t('the NOTHING VERIFIED line refuses to read as a clean run', /nothing was asked/.test(verdict({ verified: 0, wrong: 0, unreachable: 1 }).line));

  // ── 5. No off-chain market data in an identity verifier. ──────────────────
  //
  // The market-depth leg was the one source that rate-limited, and it was
  // discovering liquidity context nothing consumes. Re-adding it would put a
  // third party's spare capacity back in the path of "is this the right
  // address", which is the whole bug.
  //
  // Both needles are ASSEMBLED FROM PIECES so this check cannot match its own
  // source, and both are lowercase host/call syntax that only real code would
  // contain — the prose above deliberately never spells either one out. If you
  // are here because one of these went red: the fix is to take the call back
  // out, not to re-split the needle.
  const own = readFileSync(fileURLToPath(import.meta.url), 'utf-8');
  const MARKET_API_HOST = `gecko${'terminal'}${'.com'}`;
  const BARE_HTTP_CALL = new RegExp(`${'fet'}${'ch'}\\s*\\(`);
  t('this verifier contacts no off-chain market-data API', !own.includes(MARKET_API_HOST));
  t('every network call goes through the classified viem client, never a bare HTTP call', !BARE_HTTP_CALL.test(own));

  for (const r of rows) console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.name}`);
  const bad = rows.filter((r) => !r.ok);
  if (bad.length) {
    console.error(`\n${bad.length} self-test FAILURE(S) — the two classes can collapse again:`);
    for (const b of bad) console.error(`  x ${b.name}`);
    return false;
  }
  console.log(`\n${rows.length} self-test checks passed`);
  return true;
}

// ── Dispatch ────────────────────────────────────────────────────────────────
//
// NOT WIRED INTO CI, deliberately — that is the repo owner's call. What wiring
// it takes is one step that accepts 0 and 2 and rejects 1 and 3, e.g.
//
//   - name: /yield protocol addresses
//     working-directory: frontend
//     run: |
//       node scripts/verify-yield-protocols.mjs; code=$?
//       case $code in
//         0|2) exit 0 ;;                 # verified, or incomplete but nothing wrong
//         *)   exit $code ;;             # 1 = a wrong address, 3 = verified nothing
//       esac
//   - name: /yield address-verifier self-test
//     working-directory: frontend
//     run: node scripts/verify-yield-protocols.mjs --self-test
//
// A plain `run: node scripts/verify-yield-protocols.mjs` is the WRONG wiring:
// it re-collapses exit 2 into the same red as exit 1 at the workflow level,
// which is the bug this file was rewritten to remove.
if (process.argv.slice(2).includes('--self-test')) {
  process.exit((await selfTest()) ? 0 : 1);
}

try {
  await main();
} catch (e) {
  // The verifier itself broke. That is a "could not check" at maximum severity,
  // never a verdict about an address — so it is filed as one and the same
  // decision table decides, which means a crash after zero verifications exits
  // 3 rather than pretending to be a clean skip.
  console.error('\nthe verifier itself threw:', e?.stack || e);
  cannotCheck('the verifier itself', `it threw before finishing (${e?.shortMessage || e?.message || e})`);
}
report();
