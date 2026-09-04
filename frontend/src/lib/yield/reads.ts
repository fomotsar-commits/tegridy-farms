// WHAT TO ASK THE CHAIN, AND WHAT THE ANSWERS MEAN.
//
// Pure: this module builds two arrays of `{address, abi, functionName, args}`
// and turns their results into rows. It never touches a client, so the whole
// read/refuse contract is testable with a hand-written results array and no
// network — which is the only way to pin the branch that matters, the one where
// a leg fails.
//
// TWO PHASES, because one of the calls has a dependent argument. Compound's
// supply rate is `getSupplyRate(getUtilization())`, and the utilisation is a
// contract answer — it cannot be in the same batch as the call that consumes it.
// Chainlink round history is dependent too: which prior rounds exist depends on
// the latest round id. Everything else is in phase A.
//
// LEGS 0 AND 1 OF EVERY PHASE ARE THE CLOCK. Multicall3.getBlockNumber() and
// getCurrentBlockTimestamp() ride inside the same aggregate3 as the reads, so
// the block a figure is stamped with is the block the figure came from. The
// alternative — a separate eth_blockNumber, or Date.now() — dates the reading by
// something that is not the reading, and on a fallback RPC roster those two can
// be minutes apart. `batchSize: 0` on the multicall is what keeps them in one
// aggregate3 rather than letting viem split the array across several requests;
// it is load-bearing, not a tuning knob.
//
// A FAILED CLOCK FAILS THE WHOLE ROW. Not because the other legs did not answer,
// but because an undated figure is not a figure: "3.44%" with no block and no
// time is a claim about the present that nothing supports.

import { encodePacked, keccak256 } from 'viem';
import { ERC20_ABI } from '../contracts';
import {
  aaveRayRateToApyPct,
  chainlinkRatio,
  classifyFeedLeg,
  compoundPerSecondToAprPct,
  compoundPerSecondToApyPct,
  previousRoundIds,
  ssrToApyPct,
  trailingNavGrowthApyPct,
  vsNav,
  type FeedRound,
} from './onchain';
import type { MetricRead, VenueMetrics } from './metrics';
import {
  AAVE_V3_POOL_ABI,
  AGGREGATOR_V3_ABI,
  CBETH_ABI,
  COMET_ABI,
  LIDO_WITHDRAWAL_QUEUE_ABI,
  MULTICALL3_ADDRESS,
  MULTICALL3_CLOCK_ABI,
  RETH_ABI,
  ROCKET_DEPOSIT_POOL_ABI,
  ROCKET_KEY_STRINGS,
  ROCKET_SETTINGS_DEPOSIT_ABI,
  ROCKET_STORAGE_ABI,
  SUSDS_ABI,
  WEETH_ABI,
  YIELD_ADDRESSES,
  YIELD_FEEDS,
} from './protocols';
import { yieldVenues } from './venues';

/** viem's multicall result shape, narrowed to what this module consumes. */
export type CallResult =
  | { status: 'success'; result: unknown }
  | { status: 'failure'; error?: unknown };

export interface ContractCall {
  address: `0x${string}`;
  abi: readonly unknown[];
  functionName: string;
  args?: readonly unknown[];
}

const CLOCK_CALLS: ContractCall[] = [
  { address: MULTICALL3_ADDRESS, abi: MULTICALL3_CLOCK_ABI, functionName: 'getBlockNumber' },
  { address: MULTICALL3_ADDRESS, abi: MULTICALL3_CLOCK_ABI, functionName: 'getCurrentBlockTimestamp' },
];

/**
 * Phase A leg order, named rather than counted.
 *
 * Written as a const object because every consumer indexes into the results
 * array by position, and a numeric literal in two places is one edit away from
 * reading Aave's rate as Compound's utilisation with nothing to catch it.
 */
export const PLAN_A = {
  blockNumber: 0,
  blockTimestamp: 1,
  aaveReserve: 2,
  cometUtilisation: 3,
  susdsSsr: 4,
  susdsConvert: 5,
  rethRate: 6,
  cbethRate: 7,
  weethRate: 8,
  feedSteth: 9,
  feedReth: 10,
  feedCbeth: 11,
  feedWeeth: 12,
  feedEzeth: 13,
  feedUsdc: 14,
  feedUsds: 15,
  lidoBacklog: 16,
  rocketExcess: 17,
  aaveUsdcHeld: 18,
  cometUsdcHeld: 19,
  rocketResolvedPool: 20,
  rocketResolvedSettings: 21,
  rocketDepositEnabled: 22,
  rocketMinimum: 23,
  rocketMaxPool: 24,
  rocketPoolBalance: 25,
  rocketDepositFee: 26,
} as const;

/**
 * Rocket Pool storage keys, hashed from the strings that produced them so nobody
 * has to trust a pasted digest. Hashed with viem rather than by hand:
 * `abi.encodePacked("contract.address", name)` concatenates two dynamic strings
 * with no length prefix, which is easy to get subtly wrong and impossible to
 * notice from the answer — a wrong key resolves to the zero address, and the
 * equality gate would then read that as "Rocket Pool has moved" forever.
 */
export const ROCKET_STORAGE_KEYS = {
  depositPool: keccak256(encodePacked(['string', 'string'], ['contract.address', ROCKET_KEY_STRINGS.depositPool])),
  settingsDeposit: keccak256(encodePacked(['string', 'string'], ['contract.address', ROCKET_KEY_STRINGS.settingsDeposit])),
} as const;

export function readPlanA(rocketKeys: { depositPool: `0x${string}`; settingsDeposit: `0x${string}` } = ROCKET_STORAGE_KEYS): ContractCall[] {
  const F = YIELD_FEEDS;
  const feed = (address: `0x${string}`): ContractCall => ({ address, abi: AGGREGATOR_V3_ABI, functionName: 'latestRoundData' });
  return [
    ...CLOCK_CALLS,
    { address: YIELD_ADDRESSES.aaveV3Pool, abi: AAVE_V3_POOL_ABI, functionName: 'getReserveData', args: [YIELD_ADDRESSES.usdc] },
    { address: YIELD_ADDRESSES.cUSDCv3, abi: COMET_ABI, functionName: 'getUtilization' },
    { address: YIELD_ADDRESSES.sUSDS, abi: SUSDS_ABI, functionName: 'ssr' },
    { address: YIELD_ADDRESSES.sUSDS, abi: SUSDS_ABI, functionName: 'convertToAssets', args: [10n ** 18n] },
    { address: YIELD_ADDRESSES.rETH, abi: RETH_ABI, functionName: 'getExchangeRate' },
    { address: YIELD_ADDRESSES.cbETH, abi: CBETH_ABI, functionName: 'exchangeRate' },
    { address: YIELD_ADDRESSES.weETH, abi: WEETH_ABI, functionName: 'getRate' },
    feed(F.stethEth.address),
    feed(F.rethEth.address),
    feed(F.cbethEth.address),
    feed(F.weethEth.address),
    feed(F.ezethEth.address),
    feed(F.usdcUsd.address),
    feed(F.usdsUsd.address),
    { address: YIELD_ADDRESSES.lidoWithdrawalQueue, abi: LIDO_WITHDRAWAL_QUEUE_ABI, functionName: 'unfinalizedStETH' },
    { address: YIELD_ADDRESSES.rocketDepositPool, abi: ROCKET_DEPOSIT_POOL_ABI, functionName: 'getExcessBalance' },
    { address: YIELD_ADDRESSES.usdc, abi: ERC20_ABI, functionName: 'balanceOf', args: [YIELD_ADDRESSES.aEthUSDC] },
    { address: YIELD_ADDRESSES.usdc, abi: ERC20_ABI, functionName: 'balanceOf', args: [YIELD_ADDRESSES.cUSDCv3] },
    { address: YIELD_ADDRESSES.rocketStorage, abi: ROCKET_STORAGE_ABI, functionName: 'getAddress', args: [rocketKeys.depositPool] },
    { address: YIELD_ADDRESSES.rocketStorage, abi: ROCKET_STORAGE_ABI, functionName: 'getAddress', args: [rocketKeys.settingsDeposit] },
    { address: YIELD_ADDRESSES.rocketSettingsDeposit, abi: ROCKET_SETTINGS_DEPOSIT_ABI, functionName: 'getDepositEnabled' },
    { address: YIELD_ADDRESSES.rocketSettingsDeposit, abi: ROCKET_SETTINGS_DEPOSIT_ABI, functionName: 'getMinimumDeposit' },
    { address: YIELD_ADDRESSES.rocketSettingsDeposit, abi: ROCKET_SETTINGS_DEPOSIT_ABI, functionName: 'getMaximumDepositPoolSize' },
    { address: YIELD_ADDRESSES.rocketDepositPool, abi: ROCKET_DEPOSIT_POOL_ABI, functionName: 'getBalance' },
    { address: YIELD_ADDRESSES.rocketSettingsDeposit, abi: ROCKET_SETTINGS_DEPOSIT_ABI, functionName: 'getDepositFee' },
  ];
}

/** How many prior feed rounds to ask for. Eight × a 24h heartbeat ≈ 8 days. */
export const TRAILING_ROUNDS = 8;

export interface PlanB {
  calls: ContractCall[];
  /** Where phase B's supply-rate answer sits, or null when it was not asked. */
  cometRateIndex: number | null;
  /** Feed key → the slice of phase B holding its prior rounds. */
  roundWindows: { key: 'weethEth' | 'ezethEth'; start: number; ids: bigint[] }[];
}

function ok(r: CallResult | undefined): unknown | null {
  return r !== undefined && r.status === 'success' ? r.result : null;
}

function asBigint(r: CallResult | undefined): bigint | null {
  const v = ok(r);
  return typeof v === 'bigint' ? v : null;
}

function asRound(r: CallResult | undefined): FeedRound | null {
  const v = ok(r);
  if (!Array.isArray(v) || v.length < 5) return null;
  const [roundId, answer, , updatedAt, answeredInRound] = v as unknown[];
  if (typeof roundId !== 'bigint' || typeof answer !== 'bigint' || typeof updatedAt !== 'bigint' || typeof answeredInRound !== 'bigint') return null;
  return { roundId, answer, updatedAt, answeredInRound };
}

/**
 * Phase B, built only from what phase A actually answered.
 *
 * Returns null when nothing is askable — an outage that took out the utilisation
 * read AND both exchange-rate feeds leaves no dependent question, and issuing an
 * empty multicall would be a request whose only possible answer is "[]".
 */
export function readPlanB(resultsA: readonly CallResult[]): PlanB | null {
  const calls: ContractCall[] = [...CLOCK_CALLS];
  let cometRateIndex: number | null = null;
  const roundWindows: PlanB['roundWindows'] = [];

  const utilisation = asBigint(resultsA[PLAN_A.cometUtilisation]);
  if (utilisation !== null) {
    cometRateIndex = calls.length;
    calls.push({ address: YIELD_ADDRESSES.cUSDCv3, abi: COMET_ABI, functionName: 'getSupplyRate', args: [utilisation] });
  }

  for (const [key, idx] of [['weethEth', PLAN_A.feedWeeth], ['ezethEth', PLAN_A.feedEzeth]] as const) {
    const latest = asRound(resultsA[idx]);
    if (latest === null) continue;
    const ids = previousRoundIds(latest.roundId, TRAILING_ROUNDS);
    if (ids.length === 0) continue;
    roundWindows.push({ key, start: calls.length, ids });
    for (const id of ids) {
      calls.push({ address: YIELD_FEEDS[key].address, abi: AGGREGATOR_V3_ABI, functionName: 'getRoundData', args: [id] });
    }
  }

  if (calls.length === CLOCK_CALLS.length) return null;
  return { calls, cometRateIndex, roundWindows };
}

const na = (reason: string): MetricRead => ({ state: 'not-applicable', reason });

/**
 * A cell that will NEVER be readable in this build.
 *
 * Distinguished from a failed call because they mean different things to a
 * reader and to the status line. "3 of 40 figures could not be read" invites a
 * reload; a structural refusal — Lido publishes its APR off-chain, weETH's only
 * feed republishes ether.fi's own rate — will say the same thing on every
 * reload for ever. Counting these as failures would make the page permanently
 * report itself as degraded, which is its own kind of dishonesty: a reader who
 * is always told something went wrong stops believing it when something does.
 */
const refused = (reason: string): MetricRead => ({ state: 'unavailable', reason });

interface Assembled {
  rows: VenueMetrics[];
  block: number | null;
  asOf: number | null;
  /** Cells that failed while the clock succeeded. Drives the 'partial' status. */
  unreadCells: number;
  totalCells: number;
  /** Live Rocket Pool gate reads, handed to depositPlan. Never used to pick an address. */
  rocket: RocketGateReads | null;
}

export interface RocketGateReads {
  resolvedPool: string | null;
  resolvedSettings: string | null;
  depositEnabled: boolean | null;
  minimumDeposit: bigint | null;
  maxPoolSize: bigint | null;
  poolBalance: bigint | null;
  depositFee1e18: bigint | null;
  block: number;
}

/**
 * Every row, from two arrays of results.
 *
 * Each venue's five cells are decided independently, so an outage on one
 * protocol does not blank the table — that is the degraded-read half of the
 * contract. What is NOT tolerated is an undated number, which is why the clock
 * check is the first thing here and returns every cell unavailable.
 */
export function assembleReadings(
  resultsA: readonly CallResult[],
  resultsB: readonly CallResult[] | null,
  planB: PlanB | null,
): Assembled {
  const venues = yieldVenues();
  const blockRaw = asBigint(resultsA[PLAN_A.blockNumber]);
  const tsRaw = asBigint(resultsA[PLAN_A.blockTimestamp]);

  if (blockRaw === null || tsRaw === null) {
    const reason =
      'The block clock could not be read, so nothing on this row can be dated. Every figure here is shown as ' +
      'unread rather than as a number whose age is unknown.';
    const dead: MetricRead = { state: 'unavailable', reason };
    return {
      rows: venues.map((venue) => ({ venue, rate: dead, nav: dead, market: dead, vsNav: dead, exit: dead, block: null, asOf: null })),
      block: null,
      asOf: null,
      unreadCells: venues.length * 5,
      totalCells: venues.length * 5,
      rocket: null,
    };
  }

  const block = blockRaw;
  const ts = tsRaw;
  const F = YIELD_FEEDS;

  // Counts cells whose contract call was asked and did not answer — the number
  // the status line reports. Structural refusals are excluded; see `refused`.
  let readFailures = 0;
  const failedCall = (what: string, at: bigint): MetricRead => {
    readFailures += 1;
    return {
      state: 'unavailable',
      reason: `${what} did not answer at block ${at}, so this figure was not read. It is not a value of zero.`,
    };
  };
  /** A vs-NAV cell whose two legs did not both read. Counted only when a call failed. */
  const pegRefusal = (which: string, at: bigint, fromFailure: boolean): MetricRead => {
    if (fromFailure) readFailures += 1;
    return {
      state: 'unavailable',
      reason:
        `${which} could not be read at block ${at}, so no discount can be worked out. The peg is NOT assumed to be 1.00.`,
    };
  };

  // ── feed legs ─────────────────────────────────────────────────────────────
  const feedRead = (
    key: keyof typeof F,
    idx: number,
    unit: 'ETH' | 'USD',
  ): MetricRead => {
    const round = asRound(resultsA[idx]);
    if (round === null) return failedCall(`Chainlink ${F[key].pair} latestRoundData`, block);
    return chainlinkRatio(F[key].pair, round, 18, ts, block, F[key].heartbeatS, unit);
  };
  // USDC/USD and USDS/USD publish with 8 decimals, the ETH pairs with 18. Read
  // from the pinned feed rather than assumed: a decimals mismatch would move a
  // dollar peg by ten orders of magnitude and still render as a number.
  const usdFeedRead = (key: 'usdcUsd' | 'usdsUsd', idx: number): MetricRead => {
    const round = asRound(resultsA[idx]);
    if (round === null) return failedCall(`Chainlink ${F[key].pair} latestRoundData`, block);
    return chainlinkRatio(F[key].pair, round, 8, ts, block, F[key].heartbeatS, 'USD');
  };

  const stethFeed = feedRead('stethEth', PLAN_A.feedSteth, 'ETH');
  const rethFeed = feedRead('rethEth', PLAN_A.feedReth, 'ETH');
  const cbethFeed = feedRead('cbethEth', PLAN_A.feedCbeth, 'ETH');
  const weethFeed = feedRead('weethEth', PLAN_A.feedWeeth, 'ETH');
  const ezethFeed = feedRead('ezethEth', PLAN_A.feedEzeth, 'ETH');
  const usdcFeed = usdFeedRead('usdcUsd', PLAN_A.feedUsdc);
  const usdsFeed = usdFeedRead('usdsUsd', PLAN_A.feedUsds);

  // ── protocol NAV rates ────────────────────────────────────────────────────
  const scaled = (raw: bigint | null, what: string, unit: 'ETH' | 'USDS', denom: string): MetricRead =>
    raw === null
      ? failedCall(what, block)
      : {
          state: 'read',
          value: Number(raw) / 1e18,
          unit,
          source: `${what} at block ${block}`,
          asOf: Number(ts),
          block: Number(block),
          stale: false,
          ageSeconds: 0,
          maxAgeS: 3600,
          basis: denom,
        };

  const rethNav = scaled(asBigint(resultsA[PLAN_A.rethRate]), 'rETH.getExchangeRate()', 'ETH', 'ETH per rETH');
  const cbethNav = scaled(asBigint(resultsA[PLAN_A.cbethRate]), 'cbETH.exchangeRate()', 'ETH', 'ETH per cbETH');
  const weethNav = scaled(asBigint(resultsA[PLAN_A.weethRate]), 'weETH.getRate()', 'ETH', 'ETH per weETH');
  const susdsNav = scaled(asBigint(resultsA[PLAN_A.susdsConvert]), 'sUSDS.convertToAssets(1e18)', 'USDS', 'USDS per sUSDS');

  // The exchange-rate feeds are checked against the protocol's own rate read in
  // the SAME call. A feed that has drifted is refused rather than shown — and
  // for ezETH there is no cheap on-chain rate to check against, which is stated
  // on the row rather than papered over.
  const weethVerdict = classifyFeedLeg(
    F.weethEth.pair,
    F.weethEth.marketClass,
    weethFeed.state === 'read' ? weethFeed.value : 0,
    weethNav.state === 'read' ? weethNav.value : null,
  );
  const ezethNav: MetricRead =
    ezethFeed.state === 'read'
      ? {
          ...ezethFeed,
          basis: 'ETH per ezETH, as published to Chainlink by Renzo — not read from a Renzo contract',
          source: `${ezethFeed.source} (Renzo publishes no cheap on-chain rate view, so this build cross-checks it against nothing)`,
        }
      : ezethFeed;

  // ── rates ─────────────────────────────────────────────────────────────────
  const aaveReserve = ok(resultsA[PLAN_A.aaveReserve]) as { currentLiquidityRate?: bigint } | null;
  const aaveRate: MetricRead =
    aaveReserve && typeof aaveReserve.currentLiquidityRate === 'bigint'
      ? {
          state: 'read',
          value: aaveRayRateToApyPct(aaveReserve.currentLiquidityRate),
          unit: 'pct',
          source: `Aave v3 Pool.getReserveData(USDC).currentLiquidityRate at block ${block}`,
          asOf: Number(ts),
          block: Number(block),
          stale: false,
          ageSeconds: 0,
          maxAgeS: 3600,
          basis: 'supply APR compounded per second; paid by borrowers and moves with utilisation',
        }
      : failedCall('Aave v3 Pool.getReserveData(USDC)', block);

  const cometRateRaw =
    planB !== null && planB.cometRateIndex !== null && resultsB !== null
      ? asBigint(resultsB[planB.cometRateIndex])
      : null;
  const cometRate: MetricRead =
    cometRateRaw === null
      ? failedCall('Compound v3 Comet.getSupplyRate(getUtilization())', block)
      : {
          state: 'read',
          value: compoundPerSecondToApyPct(cometRateRaw),
          unit: 'pct',
          source: `Comet.getSupplyRate(getUtilization()) at block ${block} — ${compoundPerSecondToAprPct(cometRateRaw).toFixed(2)}% APR, compounded per second here`,
          asOf: Number(ts),
          block: Number(block),
          stale: false,
          ageSeconds: 0,
          maxAgeS: 3600,
          basis: 'supply APR compounded per second; paid by borrowers and moves with utilisation',
        };

  const ssrRaw = asBigint(resultsA[PLAN_A.susdsSsr]);
  const susdsRate: MetricRead =
    ssrRaw === null
      ? failedCall('sUSDS.ssr()', block)
      : {
          state: 'read',
          value: ssrToApyPct(ssrRaw),
          unit: 'pct',
          source: `sUSDS.ssr() at block ${block}`,
          asOf: Number(ts),
          block: Number(block),
          stale: false,
          ageSeconds: 0,
          maxAgeS: 3600,
          basis: 'the Sky Savings Rate, a governance parameter compounded per second — it can be voted down',
        };

  const trailing = (key: 'weethEth' | 'ezethEth', latest: MetricRead, latestIdx: number): MetricRead => {
    const latestRound = asRound(resultsA[latestIdx]);
    if (latestRound === null || latest.state !== 'read') {
      return failedCall(`Chainlink ${F[key].pair} latestRoundData`, block);
    }
    const window = planB?.roundWindows.find((w) => w.key === key);
    if (window === undefined || resultsB === null) {
      return refused(
        `A growth rate needs two ${F[key].pair} feed rounds at least 20 hours apart; no round history was read at ` +
          `block ${block}. That is a missing measurement, not a rate of zero.`,
      );
    }
    const prior: FeedRound[] = [];
    for (let i = 0; i < window.ids.length; i += 1) {
      const r = asRound(resultsB[window.start + i]);
      if (r !== null) prior.push(r);
    }
    return trailingNavGrowthApyPct(F[key].pair, latestRound, prior, ts, block);
  };

  // WHY LIDO HAS NO RATE CELL. The verification run read
  // LegacyOracle.getLastCompletedReportDelta() and found postTotalPooledEther
  // BELOW preTotalPooledEther — a 0.4% fall over one day. The delta is not a
  // rewards figure: the report also settles finalised withdrawals and new
  // deposits, so annualising it would have printed roughly −77% APY on a
  // protocol that was paying about 3%. The spec's ±10% sanity guard would have
  // waved that through. So the cell says what it could not read, and why.
  const lidoRate = refused(
    'This build reads no growth rate for stETH. The last Lido oracle report at block ' +
      `${block} settles withdrawals and new deposits alongside rewards, so the change it reports is not a rate; ` +
      'Lido publishes its APR off-chain and no Chainlink feed on this roster republishes it. This is not a rate of zero.',
  );
  const rethRate = refused(
    `The RETH / ETH feed is a MARKET price, not Rocket Pool's published rate, so annualising its round history at ` +
      `block ${block} would annualise price noise and call it yield. rETH's rate is visible instead as the protocol ` +
      'NAV beside this cell rising over time. This is not a rate of zero.',
  );
  const cbethRate = refused(
    'This build reads no growth rate for cbETH: Coinbase publishes it off-chain, and the CBETH / ETH feed is a ' +
      `market price rather than the exchange rate, so it cannot stand in. Read the protocol NAV cell at block ${block} ` +
      'instead. This is not a rate of zero.',
  );

  // ── exit legs ─────────────────────────────────────────────────────────────
  const lidoBacklog = asBigint(resultsA[PLAN_A.lidoBacklog]);
  const lidoExit: MetricRead =
    lidoBacklog === null
      ? failedCall('Lido WithdrawalQueue.unfinalizedStETH()', block)
      : {
          state: 'read',
          value: Number(lidoBacklog) / 1e18,
          unit: 'stETH',
          source: `Lido WithdrawalQueue.unfinalizedStETH() at block ${block}`,
          asOf: Number(ts),
          block: Number(block),
          stale: false,
          ageSeconds: 0,
          maxAgeS: 3600,
          meaning: 'queued-ahead',
        };

  const rocketExcess = asBigint(resultsA[PLAN_A.rocketExcess]);
  const rocketExit: MetricRead =
    rocketExcess === null
      ? failedCall('RocketDepositPool.getExcessBalance()', block)
      : {
          state: 'read',
          value: Number(rocketExcess) / 1e18,
          unit: 'ETH',
          source: `RocketDepositPool.getExcessBalance() at block ${block}`,
          asOf: Number(ts),
          block: Number(block),
          stale: false,
          ageSeconds: 0,
          maxAgeS: 3600,
          meaning: 'available-now',
        };

  const usdcExit = (raw: bigint | null, holder: string): MetricRead =>
    raw === null
      ? failedCall(`USDC.balanceOf(${holder})`, block)
      : {
          state: 'read',
          value: Number(raw) / 1e6,
          unit: 'USDC',
          source: `USDC.balanceOf(${holder}) at block ${block}`,
          asOf: Number(ts),
          block: Number(block),
          stale: false,
          ageSeconds: 0,
          maxAgeS: 3600,
          meaning: 'available-now',
        };

  // ── vs-NAV ────────────────────────────────────────────────────────────────
  const ratio = (market: MetricRead, nav: MetricRead, marketName: string, navName: string): MetricRead => {
    if (market.state !== 'read') return pegRefusal(`The market price for this position (${marketName})`, block, true);
    if (nav.state !== 'read') return pegRefusal(`The protocol rate for this position (${navName})`, block, true);
    return {
      state: 'read',
      value: vsNav(market.value, nav.value),
      unit: 'ratio',
      source: `${marketName} ÷ ${navName}, both at block ${block}`,
      asOf: Math.min(market.asOf, nav.asOf),
      block: Number(block),
      stale: market.stale || nav.stale,
      ageSeconds: Math.max(market.ageSeconds, nav.ageSeconds),
      maxAgeS: Math.min(market.maxAgeS, nav.maxAgeS),
    };
  };

  // Rows whose only Chainlink feed republishes the protocol's own rate have no
  // market leg at all. Saying "1.0000× NAV" from an exchange-rate feed would be
  // a number that can never move, dressed as a peg — the exact reading this page
  // exists to refuse. The market cell names the obstacle instead.
  const noMarketLeg = (symbol: string, pair: string) =>
    refused(
      `The only Chainlink feed for ${symbol} is ${pair}, which republishes the protocol's own rate rather than a ` +
        'market price — it can never show a discount, so it is not used as one. This build reads no market price ' +
        `for ${symbol}, and the peg is NOT assumed to be 1.00.`,
    );

  const byId: Record<string, Omit<VenueMetrics, 'venue' | 'block' | 'asOf'>> = {
    'lido-steth': {
      rate: lidoRate,
      nav: na(
        'stETH rebases: Lido redeems one stETH for one ETH of pooled stake through its withdrawal queue, so there ' +
          'is no share rate to read. The market price beside this cell IS the peg — read it directly.',
      ),
      market: stethFeed,
      vsNav: na(
        'With no share rate there is nothing to divide the market price by. The market-price cell is the whole ' +
          'reading here, in ETH per stETH.',
      ),
      exit: lidoExit,
    },
    'rocketpool-reth': {
      rate: rethRate,
      nav: rethNav,
      market: rethFeed,
      vsNav: ratio(rethFeed, rethNav, `Chainlink ${F.rethEth.pair}`, 'rETH.getExchangeRate()'),
      exit: rocketExit,
    },
    'coinbase-cbeth': {
      rate: cbethRate,
      nav: cbethNav,
      market: cbethFeed,
      vsNav: ratio(cbethFeed, cbethNav, `Chainlink ${F.cbethEth.pair}`, 'cbETH.exchangeRate()'),
      exit: na(
        'Redemption runs through Coinbase, off-chain and for its own custody customers, so there is no on-chain ' +
          'depth to measure. The wrapper trades on-chain; the redemption does not.',
      ),
    },
    'etherfi-weeth': {
      rate: trailing('weethEth', weethFeed, PLAN_A.feedWeeth),
      nav: weethVerdict.ok ? weethNav : failedCall(`the ${F.weethEth.pair} cross-check (${weethVerdict.ok ? '' : weethVerdict.reason})`, block),
      market: noMarketLeg('weETH', F.weethEth.pair),
      vsNav: pegRefusal('The market price for weETH', block, false),
      exit: na(
        "Withdrawal passes through ether.fi's own queue and then the beacon-chain queue; this build reads no depth " +
          'for either, so nothing is shown rather than a number that would look like available liquidity.',
      ),
    },
    'renzo-ezeth': {
      rate: trailing('ezethEth', ezethFeed, PLAN_A.feedEzeth),
      nav: ezethNav,
      market: noMarketLeg('ezETH', F.ezethEth.pair),
      vsNav: pegRefusal('The market price for ezETH', block, false),
      exit: na(
        "Withdrawal passes through Renzo's own queue; this build reads no depth for it. The fast exit is a secondary " +
          'pool, and this build does not measure that pool either.',
      ),
    },
    'aave-v3-usdc': {
      rate: aaveRate,
      nav: na(
        'One aEthUSDC is one USDC by construction — the balance itself grows, so there is no share rate to read.',
      ),
      market: usdcFeed,
      vsNav: na(
        'With no share rate there is nothing to divide by. The market-price cell is the USDC peg against the dollar, ' +
          'which is the reading that matters for this position.',
      ),
      exit: usdcExit(asBigint(resultsA[PLAN_A.aaveUsdcHeld]), 'aEthUSDC'),
    },
    'compound-v3-usdc': {
      rate: cometRate,
      nav: na('One cUSDCv3 is one USDC by construction — the balance grows, so there is no share rate to read.'),
      market: usdcFeed,
      vsNav: na(
        'With no share rate there is nothing to divide by. The market-price cell is the USDC peg against the dollar.',
      ),
      exit: usdcExit(asBigint(resultsA[PLAN_A.cometUsdcHeld]), 'Comet cUSDCv3'),
    },
    'sky-susds': {
      rate: susdsRate,
      nav: susdsNav,
      market: usdsFeed,
      vsNav: na(
        'sUSDS is redeemed at the vault\'s own share rate, and there is no order book for sUSDS to compare that ' +
          'against. The market-price cell is the USDS peg against the dollar instead.',
      ),
      exit: na(
        'Redeemed at the vault rate (convertToAssets), so there is no order book to measure. Depth is whatever the ' +
          'vault holds against its shares.',
      ),
    },
  };

  const rows: VenueMetrics[] = venues.map((venue) => {
    const cells = byId[venue.id];
    if (cells === undefined) {
      // A catalogue row with no read plan is a wiring bug, and it IS counted as
      // a failure: unlike the structural refusals above, somebody can fix it.
      const missing = failedCall(`the read plan for ${venue.label}`, block);
      return { venue, rate: missing, nav: missing, market: missing, vsNav: missing, exit: missing, block: Number(block), asOf: Number(ts) };
    }
    return { venue, ...cells, block: Number(block), asOf: Number(ts) };
  });

  const address = (r: CallResult | undefined): string | null => {
    const v = ok(r);
    return typeof v === 'string' ? v : null;
  };
  const bool = (r: CallResult | undefined): boolean | null => {
    const v = ok(r);
    return typeof v === 'boolean' ? v : null;
  };

  return {
    rows,
    block: Number(block),
    asOf: Number(ts),
    unreadCells: readFailures,
    totalCells: venues.length * 5,
    rocket: {
      resolvedPool: address(resultsA[PLAN_A.rocketResolvedPool]),
      resolvedSettings: address(resultsA[PLAN_A.rocketResolvedSettings]),
      depositEnabled: bool(resultsA[PLAN_A.rocketDepositEnabled]),
      minimumDeposit: asBigint(resultsA[PLAN_A.rocketMinimum]),
      maxPoolSize: asBigint(resultsA[PLAN_A.rocketMaxPool]),
      poolBalance: asBigint(resultsA[PLAN_A.rocketPoolBalance]),
      depositFee1e18: asBigint(resultsA[PLAN_A.rocketDepositFee]),
      block: Number(block),
    },
  };
}
