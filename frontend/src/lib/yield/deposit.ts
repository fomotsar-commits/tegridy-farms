// THE ONLY MODULE ON THIS SURFACE THAT CAN MOVE SOMEBODY'S MONEY.
//
// Pure, and that is the point: every reason a deposit must NOT proceed is a
// value this function returns, not a branch inside a component. A component can
// forget a guard; a closed union cannot, because the exhaustive switch that
// renders it stops compiling when a state is added and unhandled. Each state is
// pinned by its own test.
//
// FOUR RULES THAT MAY NOT BE RELAXED, each of which has cost somebody money
// somewhere:
//
//   1. THE SPENDER IS THE DESTINATION. An approval whose spender is not the
//      contract that will pull the tokens is either useless or a gift to a third
//      party. The one exception is ether.fi's wrap, where the puller is weETH
//      and not the LiquidityPool the ETH went to — so that case is written out
//      explicitly rather than reached by a general rule.
//   2. APPROVALS ARE EXACT. Never `maxUint256`, which leaves a standing
//      allowance a later exploit of that protocol can drain, and never a
//      zero-first reset, which USDC and USDS do not need and which costs an
//      extra signature people abandon halfway through.
//   3. EVERY ADDRESS COMES FROM protocols.ts. Never a prop, never a query
//      string, never localStorage, never an RPC answer. Rocket Pool's live
//      resolution is read and used ONLY to disable the button when it disagrees
//      with the pinned address — a public node can stop a deposit, never
//      redirect one.
//   4. NOTHING IS ASSUMED WHEN A GATE COULD NOT BE READ. An unreadable gate is
//      `venue-paused`, not `ready`. Fail closed, always.

import { maxUint256, parseUnits, zeroAddress } from 'viem';
import { ERC20_ABI } from '../contracts';
import { safeParseEtherPositive } from '../safeParseEther';
import {
  AAVE_V3_POOL_ABI,
  COMET_ABI,
  ETHERFI_LIQUIDITY_POOL_ABI,
  LIDO_ABI,
  RENZO_RESTAKE_MANAGER_ABI,
  ROCKET_DEPOSIT_POOL_ABI,
  SUSDS_ABI,
  WEETH_ABI,
  YIELD_ADDRESSES,
} from './protocols';
import { yieldVenueAvailability, type RouteAsset, type YieldVenue } from './venues';

/**
 * The venue takes nothing here, and the sentence says WHY rather than just
 * asserting it: there is no venue leg in the transaction for a fee to ride on.
 * A fee this surface could not charge if it wanted to is a stronger claim than
 * a fee it has chosen not to charge.
 */
export const YIELD_NO_FEE_NOTE =
  'The venue adds no fee here. A deposit goes from your wallet straight to the protocol’s own contract — there ' +
  'is no venue leg for a fee to ride on.';

export const YIELD_THIRD_PARTY_NOTE =
  'The destination protocol takes its own cut of the yield, and Ethereum takes gas. Neither is set here and neither ' +
  'is refundable by anyone on this page.';

/**
 * Lido's `submit` takes a referral address. The zero address is passed and that
 * is a decision, not a default: no referral programme is live, the venue takes
 * nothing on this route, and a non-zero value would be an undisclosed
 * relationship in a transaction the depositor signs.
 */
export const LIDO_NO_REFERRAL = zeroAddress;

export interface DepositStep {
  /** Rendered verbatim in the step list. Says what this signature does. */
  label: string;
  address: `0x${string}`;
  abi: readonly unknown[];
  functionName: string;
  args: readonly unknown[];
  /** Native value in wei, for a payable step. Absent on an ERC-20 step. */
  value?: bigint;
}

export interface RocketGates {
  /** RocketStorage's live answer. Compared to the pinned address, never used as one. */
  resolvedPool: string | null;
  resolvedSettings: string | null;
  depositEnabled: boolean | null;
  minimumDeposit: bigint | null;
  maxPoolSize: bigint | null;
  poolBalance: bigint | null;
}

export interface EtherfiBalances {
  /** eETH held before the deposit, at a named block. */
  before: bigint | null;
  /** eETH held after the deposit receipt, at a named block. */
  after: bigint | null;
}

export interface DepositPlanInput {
  venue: YieldVenue;
  amountText: string;
  chainId: number | null;
  account: `0x${string}` | null;
  /** Native balance in wei. Null when it could not be read. */
  nativeBalance: bigint | null;
  /** ERC-20 balance in the asset's own decimals. Null when unread. */
  assetBalance: bigint | null;
  /** Allowance the destination already holds. Null when unread. */
  allowance: bigint | null;
  rocket?: RocketGates;
  etherfi?: EtherfiBalances;
}

export type DepositPlan =
  | { state: 'unroutable'; reason: string }
  | { state: 'no-wallet' }
  | { state: 'wrong-chain'; want: 1 }
  | { state: 'invalid-amount'; reason: string }
  | { state: 'needs-asset'; asset: RouteAsset }
  | { state: 'insufficient'; have: bigint; need: bigint; unit: string; decimals: number }
  | { state: 'venue-paused'; reason: string }
  | { state: 'venue-full'; roomWei: bigint }
  | { state: 'below-minimum'; minimum: bigint }
  | { state: 'needs-approval'; asset: RouteAsset; spender: `0x${string}`; amount: bigint; steps: DepositStep[] }
  | { state: 'ready'; steps: DepositStep[] };

/** Ethereum mainnet. Every venue here is mainnet-only and says so on the panel. */
export const YIELD_CHAIN_ID = 1;

/**
 * Parse a user-typed ERC-20 amount at the asset's own decimals.
 *
 * `parseUnits` accepts more shapes than this surface should — exponent notation,
 * a lone sign, extra fraction digits it silently truncates — so the regex gates
 * it first. A truncated amount is a different amount, and the depositor signed
 * the one they typed.
 */
const DECIMAL_RE = /^\d+(\.\d+)?$/;

function parseAssetAmount(text: string, decimals: number): bigint | null {
  const trimmed = text.trim();
  if (!DECIMAL_RE.test(trimmed)) return null;
  const fraction = trimmed.split('.')[1] ?? '';
  if (fraction.length > decimals) return null;
  try {
    const units = parseUnits(trimmed, decimals);
    return units > 0n ? units : null;
  } catch {
    return null;
  }
}

const INVALID_AMOUNT =
  'Enter a positive amount using digits and at most one decimal point, within the token’s own decimal places.';

function approveStep(token: `0x${string}`, symbol: string, spender: `0x${string}`, amount: bigint): DepositStep {
  return {
    label: `Approve exactly this much ${symbol} for ${spender}`,
    address: token,
    abi: ERC20_ABI,
    functionName: 'approve',
    args: [spender, amount],
  };
}

/**
 * What would actually happen if the visitor pressed the button, or why nothing
 * would.
 *
 * The order of the guards is load-bearing and runs cheapest-and-most-absolute
 * first: a cbETH row is unroutable no matter what wallet, chain or amount is
 * supplied, so asking about the wallet first would produce a connect prompt for
 * a button that can never fire.
 */
export function depositPlan(input: DepositPlanInput): DepositPlan {
  const { venue, amountText, chainId, account, nativeBalance, assetBalance, allowance } = input;

  const availability = yieldVenueAvailability(venue.id);
  if (availability === null || availability.routable === false) {
    return { state: 'unroutable', reason: availability?.reason ?? `${venue.label} is not in this build's catalogue.` };
  }
  const route = venue.route;
  if (route.kind === 'none') return { state: 'unroutable', reason: route.reason };

  if (account === null) return { state: 'no-wallet' };
  if (chainId !== YIELD_CHAIN_ID) return { state: 'wrong-chain', want: YIELD_CHAIN_ID };

  // ── ETH-denominated routes ────────────────────────────────────────────────
  if (route.kind === 'native-payable' || route.kind === 'native-then-wrap') {
    const wei = safeParseEtherPositive(amountText);
    if (wei === null) return { state: 'invalid-amount', reason: INVALID_AMOUNT };
    // Strictly greater, not >=: a deposit that consumes the entire balance
    // leaves nothing for gas and reverts at the wallet, which reads to the
    // depositor as the venue being broken.
    if (nativeBalance === null || nativeBalance <= wei) {
      return { state: 'insufficient', have: nativeBalance ?? 0n, need: wei, unit: 'ETH', decimals: 18 };
    }

    if (venue.id === 'rocketpool-reth') {
      const gate = rocketGate(input, wei, venue.depositTarget);
      if (gate !== null) return gate;
      return {
        state: 'ready',
        steps: [{
          label: 'Deposit ETH into the Rocket Pool deposit pool',
          address: venue.depositTarget,
          abi: ROCKET_DEPOSIT_POOL_ABI,
          functionName: 'deposit',
          args: [],
          value: wei,
        }],
      };
    }

    if (route.kind === 'native-then-wrap') return etherfiPlan(input, wei, venue.depositTarget);

    if (route.functionName === 'submit') {
      return {
        state: 'ready',
        steps: [{
          label: 'Stake ETH with Lido and receive stETH',
          address: venue.depositTarget,
          abi: LIDO_ABI,
          functionName: 'submit',
          args: [LIDO_NO_REFERRAL],
          value: wei,
        }],
      };
    }
    return {
      state: 'ready',
      steps: [{
        label: 'Deposit ETH with Renzo and receive ezETH',
        address: venue.depositTarget,
        abi: RENZO_RESTAKE_MANAGER_ABI,
        functionName: 'depositETH',
        args: [],
        value: wei,
      }],
    };
  }

  // ── ERC-20 supply routes ──────────────────────────────────────────────────
  const asset = route.asset;
  const amount = parseAssetAmount(amountText, asset.decimals);
  if (amount === null) return { state: 'invalid-amount', reason: INVALID_AMOUNT };

  // Holding NONE of the asset is a different problem from holding too little,
  // and only one of them has an answer on this page. This surface performs no
  // swap, so the empty-balance branch sends the visitor somewhere that does.
  if (assetBalance === null || assetBalance === 0n) return { state: 'needs-asset', asset };
  if (assetBalance < amount) {
    return { state: 'insufficient', have: assetBalance, need: amount, unit: asset.symbol, decimals: asset.decimals };
  }

  const supplyStep: DepositStep =
    route.functionName === 'supply' && venue.id === 'aave-v3-usdc'
      ? {
          label: `Supply ${asset.symbol} to Aave v3`,
          address: venue.depositTarget,
          abi: AAVE_V3_POOL_ABI,
          functionName: 'supply',
          // referralCode 0: Aave's referral programme is not live and this venue
          // is not registered for it. A made-up code would be a claim to a
          // relationship that does not exist.
          args: [asset.address, amount, account, 0],
        }
      : route.functionName === 'supply'
        ? {
            label: `Supply ${asset.symbol} to Compound v3`,
            address: venue.depositTarget,
            abi: COMET_ABI,
            functionName: 'supply',
            args: [asset.address, amount],
          }
        : {
            label: `Deposit ${asset.symbol} into the sUSDS vault`,
            address: venue.depositTarget,
            abi: SUSDS_ABI,
            functionName: 'deposit',
            args: [amount, account],
          };

  if (allowance === null || allowance < amount) {
    return {
      state: 'needs-approval',
      asset,
      spender: venue.depositTarget,
      amount,
      steps: [approveStep(asset.address, asset.symbol, venue.depositTarget, amount), supplyStep],
    };
  }
  return { state: 'ready', steps: [supplyStep] };
}

/**
 * Rocket Pool's four live gates, every one of which fails CLOSED.
 *
 * The first is the important one. Rocket Pool upgrades its deposit pool by
 * design, so the pinned address is a snapshot. Rather than resolving the address
 * live — which would let whichever public node answered choose where the ETH
 * goes — the live resolution is compared to the pinned one and the button is
 * disabled on any disagreement. A hostile RPC gets exactly one power here: to
 * stop a deposit.
 */
function rocketGate(input: DepositPlanInput, wei: bigint, pinned: `0x${string}`): DepositPlan | null {
  const gates = input.rocket;
  const stale = (why: string): DepositPlan => ({ state: 'venue-paused', reason: why });
  if (gates === undefined) {
    return stale(
      'Rocket Pool’s live deposit settings could not be read, so this build cannot confirm the deposit would be ' +
        'accepted. The button stays disabled rather than sending ETH into an unchecked contract.',
    );
  }
  if (gates.resolvedPool === null || gates.resolvedSettings === null) {
    return stale(
      'Rocket Pool’s contract registry could not be read at this block, so this build cannot confirm the pinned ' +
        'deposit pool is still the live one. The button stays disabled.',
    );
  }
  if (gates.resolvedPool.toLowerCase() !== pinned.toLowerCase()) {
    return stale(
      'Rocket Pool has moved its deposit pool since this build was verified; the pinned address is stale and the ' +
        'deposit is disabled until the registry is re-verified.',
    );
  }
  if (gates.resolvedSettings.toLowerCase() !== YIELD_ADDRESSES.rocketSettingsDeposit.toLowerCase()) {
    return stale(
      'Rocket Pool has moved its deposit settings contract since this build was verified, so the minimum and pool-size ' +
        'gates read here may not be the live ones. The deposit is disabled until the registry is re-verified.',
    );
  }
  if (gates.depositEnabled !== true) {
    return stale(
      gates.depositEnabled === false
        ? 'Rocket Pool has deposits turned off right now — read from RocketDAOProtocolSettingsDeposit, not assumed.'
        : 'Whether Rocket Pool is accepting deposits could not be read, so this build does not assume it is.',
    );
  }
  if (gates.minimumDeposit === null || gates.maxPoolSize === null || gates.poolBalance === null) {
    return stale(
      'Rocket Pool’s minimum deposit and pool capacity could not be read at this block, so this build cannot tell ' +
        'whether this amount would be accepted.',
    );
  }
  if (wei < gates.minimumDeposit) return { state: 'below-minimum', minimum: gates.minimumDeposit };
  const room = gates.maxPoolSize > gates.poolBalance ? gates.maxPoolSize - gates.poolBalance : 0n;
  if (room < wei) return { state: 'venue-full', roomWei: room };
  return null;
}

/**
 * ether.fi in three signatures, and the wrap amount is a MEASUREMENT.
 *
 * `LiquidityPool.deposit()` returns a share count, not an eETH balance, and eETH
 * is a rebasing token — using the return value as the wrap amount would try to
 * wrap a number that is not the balance and revert, or worse, wrap the wrong
 * amount. So the wrap amount is the difference between two eETH `balanceOf`
 * reads at two named blocks, minus one wei: a rebasing balance can round down
 * by a wei between the read and the wrap, and losing a wei of dust beats a
 * reverted third signature the depositor has already paid gas to reach.
 *
 * If either balance read is missing the plan stops after step 1 rather than
 * guessing. Stopping is a real outcome here — the depositor holds eETH, which is
 * a genuine staked position — and the panel says so.
 */
function etherfiPlan(input: DepositPlanInput, wei: bigint, pool: `0x${string}`): DepositPlan {
  const depositStep: DepositStep = {
    label: 'Stake ETH with ether.fi and receive eETH',
    address: pool,
    abi: ETHERFI_LIQUIDITY_POOL_ABI,
    functionName: 'deposit',
    args: [],
    value: wei,
  };
  const balances = input.etherfi;
  if (balances === undefined || balances.before === null || balances.after === null) {
    return { state: 'ready', steps: [depositStep] };
  }
  const delta = balances.after - balances.before;
  if (delta <= 1n) return { state: 'ready', steps: [depositStep] };
  const wrapAmount = delta - 1n;
  return {
    state: 'ready',
    steps: [
      depositStep,
      // The ONLY approval on this surface whose spender is not the venue's
      // depositTarget: weETH pulls the eETH, the LiquidityPool does not.
      approveStep(YIELD_ADDRESSES.eETH, 'eETH', YIELD_ADDRESSES.weETH, wrapAmount),
      {
        label: 'Wrap eETH into weETH',
        address: YIELD_ADDRESSES.weETH,
        abi: WEETH_ABI,
        functionName: 'wrap',
        args: [wrapAmount],
      },
    ],
  };
}

/**
 * Every approval this module can emit, for the test that asserts none of them is
 * unlimited. Exported rather than re-derived in the test so a new route cannot
 * add an approval the guard does not walk.
 */
export const FORBIDDEN_APPROVAL_AMOUNTS: readonly bigint[] = [0n, maxUint256];

/**
 * What each route actually MINTS into the depositor's wallet.
 *
 * Not the same as the destination: Aave's aEthUSDC is a different contract from
 * the Pool the USDC went to, and ether.fi's step 1 mints eETH rather than the
 * weETH the row is named after. Reading the wrong one would report a balance
 * that did not move and call it the deposit's result.
 */
export const YIELD_RECEIPT_TOKENS: Record<string, { address: `0x${string}`; symbol: string; decimals: number }> = {
  'lido-steth': { address: YIELD_ADDRESSES.stETH, symbol: 'stETH', decimals: 18 },
  'rocketpool-reth': { address: YIELD_ADDRESSES.rETH, symbol: 'rETH', decimals: 18 },
  'etherfi-weeth': { address: YIELD_ADDRESSES.eETH, symbol: 'eETH', decimals: 18 },
  'renzo-ezeth': { address: YIELD_ADDRESSES.ezETH, symbol: 'ezETH', decimals: 18 },
  'aave-v3-usdc': { address: YIELD_ADDRESSES.aEthUSDC, symbol: 'aEthUSDC', decimals: 6 },
  'compound-v3-usdc': { address: YIELD_ADDRESSES.cUSDCv3, symbol: 'cUSDCv3', decimals: 6 },
  'sky-susds': { address: YIELD_ADDRESSES.sUSDS, symbol: 'sUSDS', decimals: 18 },
};
