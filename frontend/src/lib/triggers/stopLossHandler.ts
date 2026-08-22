// CoW ComposableCoW StopLoss handler binding.
//
// Upstream: cowprotocol/composable-cow, src/types/StopLoss.sol. The `Data` struct
// below is field-for-field that type; the round-trip test pins the layout so a
// silent edit here becomes a failing test rather than an order the handler decodes
// into different numbers than the ones the user saw.
//
// WHAT THIS HANDLER CAN EXPRESS, EXACTLY: the order becomes tradeable only while
// `sellTokenPrice / buyTokenPrice <= strike`. That is one direction. A take-profit
// (fire when the ratio RISES) is not a strike this handler accepts, and neither is
// a trailing stop, whose strike has to be rewritten as the market moves — nothing
// rewrites a registered conditional order. Those kinds route to the keeper instead
// (see armState.ts); they are not smuggled in here.
//
// Not taken, deliberately: the ratio could be inverted by putting the buy token's
// feed in the sell slot, turning a stop into a take-profit. Whether that is sound
// depends on whether the deployed handler normalises with the ORACLES' decimals or
// the TOKENS' — this repo has not read the deployed bytecode, and a wrong sign on a
// strike is an order that fires the instant it is registered. Verify before adding.
//
// TWO OPERATOR DIALS, BOTH DEFAULT-OFF:
//   VITE_COW_STOP_LOSS_HANDLER — the handler deployment. Unlike ComposableCoW and
//     the TWAP handler (canonical, identical on every chain, pinned in
//     composableCow.ts), this repo has NOT verified a StopLoss deployment address.
//     An unverified address here would register orders against a contract that
//     never fires, which is the exact failure this surface exists to prevent, so
//     there is no constant to fall back to and none may be added.
//   VITE_TRIGGER_PRICE_FEEDS — the price feeds the handler reads. The handler needs
//     a Chainlink-shaped aggregator for BOTH sides of the pair. Most launched tokens
//     have none, and a stop-loss on a pair without feeds can never arm.

import { encodeAbiParameters, encodeFunctionData, type Address, type Hex } from 'viem';
import { COW_APP_DATA_HASH } from '../cowProtocol';
import {
  COMPOSABLE_COW_ADDRESS,
  COMPOSABLE_COW_CREATE_ABI,
  type ConditionalOrderParams,
} from '../composableCow';

export { COMPOSABLE_COW_ADDRESS };

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Reads as an address, or null. The zero address is not an address here. */
function parseAddress(raw: string | undefined): Address | null {
  const t = raw?.trim();
  if (!t || !ADDRESS_RE.test(t)) return null;
  if (t.toLowerCase() === ZERO_ADDRESS) return null;
  return t as Address;
}

/**
 * The StopLoss handler deployment, or null when the operator has not set one.
 * Read it; do not cache it — a captured null outlives the dial being set.
 */
export function stopLossHandlerAddress(): Address | null {
  return parseAddress(import.meta.env.VITE_COW_STOP_LOSS_HANDLER as string | undefined);
}

// ─── Price feed registry ─────────────────────────────────────────────────────

export interface PriceFeedRef {
  token: Address;
  feed: Address;
  /** The aggregator's own `decimals()`. Recorded so a plan can state the units it
   *  quoted the strike in rather than assuming the usual 8. */
  decimals: number;
}

/**
 * `VITE_TRIGGER_PRICE_FEEDS` → `token:feed:decimals` triples, comma separated.
 *
 * A malformed entry is DROPPED, not repaired. The failure mode of a repaired entry
 * is an order pointed at the wrong feed, which reads as armed and fires on somebody
 * else's price; the failure mode of a dropped entry is a pair that will not arm and
 * says so. Only one of those is recoverable by the user.
 */
export function triggerPriceFeeds(): Record<string, PriceFeedRef> {
  const raw = (import.meta.env.VITE_TRIGGER_PRICE_FEEDS as string | undefined)?.trim();
  if (!raw) return {};
  const out: Record<string, PriceFeedRef> = {};
  for (const entry of raw.split(',')) {
    const parts = entry.trim().split(':');
    if (parts.length !== 3) continue;
    const token = parseAddress(parts[0]);
    const feed = parseAddress(parts[1]);
    const decimals = Number(parts[2]);
    if (!token || !feed) continue;
    if (!Number.isInteger(decimals) || decimals < 1 || decimals > 36) continue;
    out[token.toLowerCase()] = { token, feed, decimals };
  }
  return out;
}

/** The feed for one token, or null when none is configured. */
export function feedFor(token: string): PriceFeedRef | null {
  return triggerPriceFeeds()[token.toLowerCase()] ?? null;
}

// ─── The StopLoss handler `Data` struct (field order is consensus-critical) ───

export interface StopLossData {
  sellToken: Address;
  buyToken: Address;
  sellAmount: bigint;
  buyAmount: bigint;
  appData: Hex;
  receiver: Address;
  isSellOrder: boolean;
  isPartiallyFillable: boolean;
  /** Orders are bucketed to a multiple of this so the same order UID recurs while
   *  the strike holds, instead of a new UID every block. */
  validityBucketSeconds: bigint;
  sellTokenPriceOracle: Address;
  buyTokenPriceOracle: Address;
  /** sellTokenPrice / buyTokenPrice, 18-decimal fixed point. Signed on-chain. */
  strike: bigint;
  /** The handler refuses to produce an order on price data older than this. */
  maxTimeSinceLastOracleUpdate: bigint;
}

const STOP_LOSS_DATA_ABI = [
  {
    type: 'tuple',
    components: [
      { name: 'sellToken', type: 'address' },
      { name: 'buyToken', type: 'address' },
      { name: 'sellAmount', type: 'uint256' },
      { name: 'buyAmount', type: 'uint256' },
      { name: 'appData', type: 'bytes32' },
      { name: 'receiver', type: 'address' },
      { name: 'isSellOrder', type: 'bool' },
      { name: 'isPartiallyFillable', type: 'bool' },
      { name: 'validityBucketSeconds', type: 'uint256' },
      { name: 'sellTokenPriceOracle', type: 'address' },
      { name: 'buyTokenPriceOracle', type: 'address' },
      { name: 'strike', type: 'int256' },
      { name: 'maxTimeSinceLastOracleUpdate', type: 'uint256' },
    ],
  },
] as const;

/** ABI-encode the StopLoss `Data` struct into the handler's `staticInput` bytes. */
export function encodeStopLossStaticInput(data: StopLossData): Hex {
  return encodeAbiParameters(STOP_LOSS_DATA_ABI, [data]);
}

/**
 * `ComposableCoW.create(params, dispatch)` calldata registering a stop-loss.
 *
 * Takes the handler address as an argument rather than reading the dial, so a
 * caller cannot reach a built transaction without having passed the arm check that
 * produced the address.
 */
export function buildCreateStopLossCalldata(params: {
  handler: Address;
  data: StopLossData;
  salt: Hex;
  dispatch?: boolean;
}): Hex {
  const orderParams: ConditionalOrderParams = {
    handler: params.handler,
    salt: params.salt,
    staticInput: encodeStopLossStaticInput(params.data),
  };
  return encodeFunctionData({
    abi: COMPOSABLE_COW_CREATE_ABI,
    functionName: 'create',
    args: [orderParams, params.dispatch ?? true],
  });
}

/** The default appData document hash — the same one every CoW surface here signs. */
export const TRIGGER_APP_DATA: Hex = COW_APP_DATA_HASH;
