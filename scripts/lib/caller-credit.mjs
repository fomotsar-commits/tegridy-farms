/**
 * The stranded-fee classifier: is there ETH parked in ReferralSplitter.callerCredit,
 * and would the permissionless pull actually work right now?
 *
 * WHY THIS IS THE MAIN REVENUE PATH, NOT AN EDGE CASE
 * ---------------------------------------------------
 * `ReferralSplitter.recordFee` (contracts/src/ReferralSplitter.sol:390) splits every
 * ETH swap fee two ways:
 *
 *   referrerShare = msg.value * referralFeeBps / BPS   -> referrer, or treasury if unqualified
 *   remainder     = msg.value - referrerShare          -> callerCredit[msg.sender]
 *
 * `msg.sender` there is the SwapFeeRouter. So with `referralFeeBps` at its live value of
 * 2000, **80% of every ETH swap fee the protocol has ever charged is parked in a mapping
 * on the splitter**, and the only thing that brings it back is somebody calling
 * `SwapFeeRouter.recoverCallerCredit()`. That is not a rounding-dust path — it is where
 * the money goes by default.
 *
 * Read on mainnet 2026-08-12 (block 25739699):
 *   SwapFeeRouter.totalETHFees()              3000000000000 wei   (the rail HAS earned)
 *   SwapFeeRouter.accumulatedETHFees()        0                   (none of it came back)
 *   ReferralSplitter.callerCredit(router)     2400000000000 wei   (exactly 80%)
 *   ReferralSplitter.accumulatedTreasuryETH()  600000000000 wei   (the other 20%)
 *   RevenueDistributor.totalDistributed()     0                   (stakers: nothing, ever)
 *
 * Nothing in this repository called `recoverCallerCredit()` before this file existed —
 * verified by search across contracts/, scripts/, frontend/, frontend/api/ and
 * .github/: the only hits were Foundry tests and audit prose.
 *
 * WHY THE CLASSIFIER IS SEPARATE FROM THE SCRIPT THAT USES IT
 * -----------------------------------------------------------
 * Two callers need the same answer and must never disagree about it: the hourly watcher
 * (.github/workflows/revenue-watch.yml) which only REPORTS, and pull-caller-credit.mjs
 * which an operator runs to ACT. If the watcher's idea of "stranded" drifted from the
 * tool's, the alert would point at a pull that cannot happen, or worse, stay quiet about
 * one that can. Pure functions here, all I/O in the caller, so both go through one
 * definition and the whole thing is testable without a network.
 *
 * THREE RULES THIS MODULE ENFORCES
 * --------------------------------
 *   1. A read we could not perform is UNKNOWN, never zero. Coercing a failed read to
 *      "nothing stranded" is how a watch goes green while blind.
 *   2. Non-zero credit is STRANDED even when the pull is currently blocked. Visibility
 *      and actionability are different questions; a blocked strand is still a strand.
 *   3. Never assert that recovering the credit opens a distribution epoch unless the
 *      arithmetic says so. RevenueDistributor.MIN_DISTRIBUTE_AMOUNT is 1e18 and the
 *      credit is seven orders of magnitude below it.
 */

import { createHash } from 'node:crypto';

/** Mainnet, chain 1. Cross-checked against frontend/scripts/addresses.json. */
export const ADDRESSES = {
  swapFeeRouter: '0x6d5791A660e79175F74C6D639584C98422d5956E',
  referralSplitter: '0x6B3442dAcB62d40BA39fCe9b3CDa350FEa6f7e4c',
  revenueDistributor: '0xF993316E2fC079de4358c489A935E01e03E23E17',
};

/**
 * Derived with `cast sig "<signature>"`, not recalled — the same discipline
 * scripts/verify-ownership.mjs adopted after a guessed selector silently dropped a
 * contract out of its report. A wrong selector here cannot fake a value: an absent
 * one returns `0x` or reverts, which this module reports as unknown.
 */
export const SELECTORS = {
  callerCredit: '0x27cbcbc2', // callerCredit(address)
  recoverCallerCredit: '0xf7e7ec5e', // recoverCallerCredit()
  setupComplete: '0xb6635be6', // setupComplete()
  paused: '0x5c975abb', // paused()
  lastCallerCreditAt: '0xfd2a0a64', // lastCallerCreditAt()
  recoverCooldown: '0x213b8aa9', // RECOVER_CALLER_CREDIT_COOLDOWN()
  accumulatedETHFees: '0x8696cb10', // accumulatedETHFees()
  referralSplitter: '0x06c29f11', // referralSplitter()
};

/**
 * RevenueDistributor.MIN_DISTRIBUTE_AMOUNT, read on mainnet 2026-08-12. Pulling the
 * credit moves it into SwapFeeRouter.accumulatedETHFees; it does NOT by itself open a
 * distribution epoch, and this constant is what proves that.
 */
export const MIN_DISTRIBUTE_AMOUNT = 1000000000000000000n;

/** ABI-encode a single address argument onto a selector. */
export function encodeAddressArg(selector, address) {
  const bare = String(address).replace(/^0x/i, '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(bare)) throw new Error(`not an address: ${address}`);
  return `${selector}${bare.padStart(64, '0')}`;
}

/** A uint256 word, or null when the node gave us nothing usable. */
export function hexToBigInt(hex) {
  if (typeof hex !== 'string' || !/^0x[0-9a-fA-F]+$/.test(hex) || hex === '0x') return null;
  try {
    return BigInt(hex);
  } catch {
    return null;
  }
}

/** A trailing-zero-trimmed ETH rendering. Display only — never fed back into math. */
export function formatEth(wei) {
  if (wei === null || wei === undefined) return 'unknown';
  const neg = wei < 0n;
  const abs = neg ? -wei : wei;
  const whole = abs / 10n ** 18n;
  const frac = (abs % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''} ETH`;
}

function sameAddress(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

/**
 * One set of chain readings. Every field is nullable, and null means specifically
 * "we tried and could not read it" -- never "it was zero". `errors` carries why.
 *
 * Declared as a typedef rather than left to inference because this is an
 * un-annotated .mjs: without it every destructured local below is implicitly `any`,
 * `creditWei / gasEstimate` infers as `number`, and `breakEvenGasPriceWei` is
 * PUBLISHED to TypeScript consumers as a number while being a bigint at run time.
 * A float there would silently truncate a wei figure. frontend's
 * callerCreditWatch.test.ts had to assert the run-time type and re-wrap in BigInt()
 * to work around exactly that.
 *
 * @typedef {Object} CallerCreditReading
 * @property {bigint|null}  creditWei
 * @property {boolean|null} routerPaused
 * @property {boolean|null} splitterSetupComplete
 * @property {bigint|null}  splitterBalanceWei
 * @property {bigint|null}  lastCallerCreditAt
 * @property {bigint|null}  cooldownSeconds
 * @property {bigint|null}  nowSeconds
 * @property {string|null}  wiredSplitter
 * @property {bigint|null}  accumulatedETHFeesWei
 * @property {bigint|null}  gasEstimate
 * @property {bigint|null}  gasPriceWei
 * @property {string[]}     [errors]
 */

/**
 * Turn a set of chain readings into a verdict.
 *
 * @param {Partial<CallerCreditReading>|null|undefined} reading
 */
export function classifyCallerCredit(reading) {
  const {
    creditWei = null,
    routerPaused = null,
    splitterSetupComplete = null,
    splitterBalanceWei = null,
    lastCallerCreditAt = null,
    cooldownSeconds = null,
    nowSeconds = null,
    wiredSplitter = null,
    accumulatedETHFeesWei = null,
    gasEstimate = null,
    gasPriceWei = null,
    errors = [],
  } = reading || {};

  const unknown = [...errors];
  const blockers = [];

  // RULE 1. An unreadable credit is never "clear".
  let state;
  if (creditWei === null) {
    state = 'unknown';
    if (!unknown.length) unknown.push('ReferralSplitter.callerCredit(SwapFeeRouter) could not be read');
  } else if (creditWei > 0n) {
    // RULE 2. Stranded is about the money existing, not about the pull being available.
    state = 'stranded';
  } else {
    state = 'clear';
  }

  // Why `recoverCallerCredit()` would revert if sent this second. Each of these mirrors
  // a specific guard in SwapFeeRouter.recoverCallerCredit / ReferralSplitter.withdrawCallerCredit.
  if (routerPaused === true) blockers.push('SwapFeeRouter is paused (recoverCallerCredit is whenNotPaused)');
  if (splitterSetupComplete === false) blockers.push('ReferralSplitter.setupComplete is false (withdrawCallerCredit requires SETUP_NOT_COMPLETE to have cleared)');
  if (lastCallerCreditAt !== null && cooldownSeconds !== null && nowSeconds !== null && lastCallerCreditAt !== 0n && nowSeconds < lastCallerCreditAt + cooldownSeconds) {
    blockers.push(`global recover cooldown active for another ${lastCallerCreditAt + cooldownSeconds - nowSeconds}s`);
  }
  if (creditWei !== null && splitterBalanceWei !== null && splitterBalanceWei < creditWei) {
    blockers.push(`ReferralSplitter holds ${splitterBalanceWei} wei but owes ${creditWei} wei of credit`);
  }
  // recoverCallerCredit() pulls from whatever `referralSplitter` currently points at. If
  // the router has been re-pointed, the credit sitting on the OLD splitter is reachable
  // only through the owner-gated recoverCallerCreditFrom(oldSplitter) — a different,
  // non-permissionless call. Silently reporting "anyone can pull this" would be wrong.
  if (wiredSplitter !== null && !sameAddress(wiredSplitter, ADDRESSES.referralSplitter)) {
    blockers.push(`SwapFeeRouter.referralSplitter is ${wiredSplitter}, not the splitter holding this credit — needs the owner-only recoverCallerCreditFrom(${ADDRESSES.referralSplitter})`);
  }

  // RULE 1 APPLIES TO THE GUARDS TOO, not just to the credit.
  //
  // Each blocker above fires on a DEFINITE reading (`=== true`, `=== false`, a
  // comparison). A guard we could not read pushes nothing — so before this, an
  // unreadable `paused()` made `blockers` empty and `pullable` TRUE, and the report
  // told the reader "the pull is available to anyone" while blind to the one guard
  // that would revert it. That is exactly the coercion Rule 1 forbids, enforced for
  // the credit read and skipped for these.
  //
  // `unreadableGuards` is deliberately separate from `blockers`: a blocker is "we know
  // this would revert", an unreadable guard is "we do not know whether it would".
  // Collapsing them would report a fact we do not have.
  const unreadableGuards = [];
  if (routerPaused === null) unreadableGuards.push('SwapFeeRouter.paused()');
  if (splitterSetupComplete === null) unreadableGuards.push('ReferralSplitter.setupComplete()');
  if (lastCallerCreditAt === null || cooldownSeconds === null || nowSeconds === null) {
    unreadableGuards.push('recover cooldown (lastCallerCreditAt / cooldown / now)');
  }
  if (splitterBalanceWei === null) unreadableGuards.push('ReferralSplitter balance');
  if (wiredSplitter === null) unreadableGuards.push('SwapFeeRouter.referralSplitter()');

  // A reverting simulation is the STRONGEST evidence the pull is unavailable, and it
  // was being dropped entirely: `gasEstimate === null` only suppressed the economics
  // block, leaving the body still asserting anyone could pull.
  const simulationReverted = state === 'stranded' && gasEstimate === null;
  if (simulationReverted) {
    unreadableGuards.push('eth_estimateGas(recoverCallerCredit()) — the simulation did not return a gas figure, which is what a revert looks like here');
  }

  // Claim it is pullable only when every guard was actually READ and none of them bit.
  const pullable = state === 'stranded' && blockers.length === 0 && unreadableGuards.length === 0;

  // Economics. ~113k gas against a credit measured in millionths of an ETH means the
  // pull can easily cost more than it recovers, which is the whole argument against
  // automating it. Reported, never hidden.
  let economics = null;
  // `creditWei !== null` is redundant at RUN time -- RULE 1 above makes
  // `state === 'stranded'` imply it. It is here so the TYPE narrows: without it
  // `creditWei` stays `bigint|null` and the division below infers as `number`.
  if (
    state === 'stranded' && creditWei !== null &&
    gasEstimate !== null && gasPriceWei !== null && gasEstimate > 0n
  ) {
    const gasCostWei = gasEstimate * gasPriceWei;
    economics = {
      gasEstimate,
      gasPriceWei,
      gasCostWei,
      worthIt: creditWei > gasCostWei,
      // The gas price at which recovering exactly pays for itself.
      breakEvenGasPriceWei: creditWei / gasEstimate,
      // How many times the gas costs what it recovers. null when it is actually profitable.
      costMultiple: creditWei > 0n ? Number(gasCostWei) / Number(creditWei) : null,
    };
  }

  // THE ONE FACT AN OPERATOR ACTS ON.
  //
  // `state === 'stranded'` has been permanently true since the rail was wired, so as a
  // trigger it is worth nothing - it produces an hourly alert that means "still Tuesday".
  // And `pullable` only says the transaction would not revert, which is NOT the same as
  // it being worth sending: at present the pull burns ~47x what it recovers.
  //
  // This is the conjunction that actually warrants waking someone: the pull would
  // succeed AND it recovers more than it costs.
  //
  // NULL, NOT FALSE, on EITHER kind of ignorance. Rule 1 applies here as much as
  // anywhere - "we could not tell" must never render as "not worth it", because those
  // two produce opposite operator behaviour and only one of them is a fact.
  //
  // Two distinct ways of not knowing, and BOTH have to produce null:
  //   - `economics === null`        we could not price the pull
  //   - `unreadableGuards.length`   we could not tell whether the pull would even work
  //
  // The second is the subtle one, and getting it wrong inverts the sign on exactly the
  // trap the Rule 1 note above describes. `pullable` is
  // `... && unreadableGuards.length === 0`, so an unreadable `paused()` makes `pullable`
  // FALSE - correctly, because we cannot claim it is available. But feeding that
  // straight into a conjunction would publish a confident `worthPulling: false`,
  // i.e. "do not bother", built out of "we do not know". An outage would read as a
  // reason to stand down.
  const worthPulling = (economics === null || unreadableGuards.length > 0)
    ? null
    : (pullable && economics.worthIt);

  // RULE 3. The epoch claim is arithmetic, not a slogan.
  let opensEpoch = null;
  let shortfallWei = null;
  if (creditWei !== null && accumulatedETHFeesWei !== null) {
    const after = creditWei + accumulatedETHFeesWei;
    opensEpoch = after >= MIN_DISTRIBUTE_AMOUNT;
    shortfallWei = opensEpoch ? 0n : MIN_DISTRIBUTE_AMOUNT - after;
  }

  return {
    state,
    creditWei,
    unknown,
    blockers,
    unreadableGuards,
    simulationReverted,
    pullable,
    worthPulling,
    economics,
    distribution: {
      landsIn: 'SwapFeeRouter.accumulatedETHFees',
      minDistributeAmountWei: MIN_DISTRIBUTE_AMOUNT,
      opensEpoch,
      shortfallWei,
    },
  };
}

/** The `cast send` an operator (or anyone) runs to perform the pull. */
export function pullCommand(rpcUrl) {
  return `cast send ${ADDRESSES.swapFeeRouter} "recoverCallerCredit()" --rpc-url ${rpcUrl} --ledger`;
}

/** The zero-install equivalent, for someone who has a wallet but no Foundry. */
export function pullViaExplorerUrl() {
  return `https://etherscan.io/address/${ADDRESSES.swapFeeRouter}#writeContract`;
}

/**
 * The markdown the watcher posts and the tool prints. One renderer so an alert and a
 * console run cannot describe the same chain state differently.
 */
export function renderReport(classification) {
  const c = classification;
  const lines = [];

  if (c.state === 'unknown') {
    lines.push('- **ReferralSplitter.callerCredit(SwapFeeRouter)**: UNREADABLE — this run does not prove the credit is empty.');
    for (const u of c.unknown) lines.push(`  - ${u}`);
    return lines.join('\n');
  }

  if (c.state === 'clear') {
    lines.push('- **ReferralSplitter.callerCredit(SwapFeeRouter)**: `0` — nothing stranded.');
    return lines.join('\n');
  }

  lines.push(`- **ReferralSplitter.callerCredit(SwapFeeRouter)**: \`${c.creditWei}\` wei (${formatEth(c.creditWei)}) is STRANDED.`);
  lines.push('  This is the non-referral remainder of swap fees already collected. It sits in a mapping on the splitter and reaches the protocol only when somebody calls the permissionless `SwapFeeRouter.recoverCallerCredit()`.');

  if (c.blockers.length) {
    lines.push('  Pulling it would REVERT right now:');
    for (const b of c.blockers) lines.push(`    - ${b}`);
  }

  // Three-way, not two-way. "No blockers found" and "no blockers exist" are different
  // claims, and only the second licenses "available to anyone". Previously an
  // unreadable guard produced an empty `blockers` and this fell through to the
  // availability line — telling the reader a fact the run had not established.
  if (c.unreadableGuards.length) {
    lines.push('  Whether the pull would succeed is UNKNOWN this run — these guards could not be read:');
    for (const g of c.unreadableGuards) lines.push(`    - ${g}`);
    lines.push('    Treat this as "not established", not as "available".');
  } else if (!c.blockers.length) {
    lines.push('  The pull is available to anyone — `recoverCallerCredit()` takes no arguments and no permissions.');
  }

  if (c.economics) {
    const e = c.economics;
    lines.push(
      e.worthIt
        ? `  Economics: ~${e.gasEstimate} gas at ${e.gasPriceWei} wei/gas costs ${e.gasCostWei} wei — less than the ${c.creditWei} wei recovered.`
        : `  Economics: ~${e.gasEstimate} gas at ${e.gasPriceWei} wei/gas costs ${e.gasCostWei} wei, which is ${e.costMultiple.toFixed(2)}x the ${c.creditWei} wei it recovers. Pulling now DESTROYS value; it breaks even at or below ${e.breakEvenGasPriceWei} wei/gas.`
    );
  }

  // Derived from the arithmetic above, never asserted flat. Both branches exist so a
  // future edit cannot quietly turn this into an unconditional promise of a payout.
  if (c.distribution.opensEpoch === true) {
    lines.push(`  Recovered ETH lands in ${c.distribution.landsIn}, which would then be at or above RevenueDistributor.MIN_DISTRIBUTE_AMOUNT (${c.distribution.minDistributeAmountWei} wei) — a distribution to stakers becomes possible.`);
  } else if (c.distribution.opensEpoch === false) {
    lines.push(`  Recovered ETH lands in ${c.distribution.landsIn}. That does NOT open a distribution epoch: RevenueDistributor.MIN_DISTRIBUTE_AMOUNT is ${c.distribution.minDistributeAmountWei} wei and the balance would still be ${c.distribution.shortfallWei} wei short.`);
  } else {
    lines.push(`  Recovered ETH lands in ${c.distribution.landsIn}. Whether that reaches RevenueDistributor.MIN_DISTRIBUTE_AMOUNT is unknown this run — accumulatedETHFees could not be read.`);
  }

  return lines.join('\n');
}

/**
 * GITHUB_OUTPUT lines for the watcher.
 *
 * The delimiter is randomised per call because part of the body is RPC error text —
 * i.e. a string a hostile or MITM'd public endpoint chooses. A fixed `EOF` would let
 * that endpoint close the heredoc early and append arbitrary keys to GITHUB_OUTPUT,
 * in a job that holds `issues: write`. Any literal occurrence is redacted as well, so
 * the guarantee does not rest on the randomness alone.
 */
export function renderGithubOutput(classification, { delimiter } = {}) {
  const delim = delimiter || `EOF_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const body = renderReport(classification).split('\n')
    .map((line) => (line.trim() === delim ? '[redacted: heredoc delimiter in RPC output]' : line))
    .join('\n');

  const summary = classification.state === 'stranded'
    ? `${classification.creditWei} wei stranded in ReferralSplitter.callerCredit`
    : classification.state === 'unknown'
      ? 'callerCredit could not be read'
      : 'no stranded callerCredit';

  // A dedupe key over the FACTS, deliberately excluding anything that moves on its own.
  //
  // The workflow used to fingerprint the rendered report. That report embeds the live
  // gas price (see `economics` above), which changes essentially every block — so the
  // hash differed on every run and the dedupe could never once fire. The alert it was
  // added to suppress posted hourly anyway.
  //
  // What belongs here is the shape of the situation: has the strand appeared, changed
  // size, become pullable, or become unreadable. Gas price is reported IN the body and
  // must not gate whether the body is posted.
  const fingerprintFacts = [
    classification.state,
    String(classification.creditWei ?? 'null'),
    String(classification.pullable),
    // The flip this whole file exists to catch. Without it in the fingerprint, the run
    // where pulling FIRST becomes worth it dedupes against the thousands of runs where
    // it was not, and the issue is never updated at the only moment it matters.
    String(classification.worthPulling),
    // Sorted so two runs that discover the same blockers in a different order agree.
    [...classification.blockers].sort().join('|'),
    [...classification.unreadableGuards].sort().join('|'),
    String(classification.distribution.opensEpoch),
  ].join('\n');

  return [
    `stranded_state=${classification.state}`,
    `stranded_pullable=${classification.pullable}`,
    // `unknown`, never `false`, when the economics could not be computed - a consumer
    // branching on this must be able to tell "not worth it" from "we could not tell".
    `stranded_worth_pulling=${classification.worthPulling === null ? 'unknown' : String(classification.worthPulling)}`,
    `stranded_summary=${summary.replace(/[\r\n]+/g, ' ')}`,
    `stranded_fingerprint=${createHash('sha256').update(fingerprintFacts).digest('hex').slice(0, 16)}`,
    `stranded<<${delim}`,
    body,
    delim,
  ].join('\n');
}
