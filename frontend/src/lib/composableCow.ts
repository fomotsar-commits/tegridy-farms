// ComposableCoW TWAP primitives (transparent, MEV-protected time-weighted orders).
//
// A TWAP splits one large trade into N equal parts that each become tradeable in
// their own time slot. On CoW this is a "conditional order": the wallet registers
// ONE order description with the ComposableCoW contract, and CoW's watchtower then
// posts each part to the orderbook as its slot opens. Every part settles through
// the solver auction (MEV-protected), and unfilled parts cost nothing.
//
// Battle-tested source: CoW DAO's composable-cow contracts
// (https://github.com/cowprotocol/composable-cow) — the TWAP handler's `Data`
// struct and `ComposableCoW.create(params, dispatch)` entrypoint, copied field-
// for-field. Addresses below are the canonical deterministic deployments (same
// across every supported chain).
//
// IMPORTANT SCOPE / HONESTY NOTE — this is a smart-contract-order mechanism. It
// requires an ERC-1271 wallet (a Safe) that has ComposableCoW wired in as its
// order-verifying fallback handler. A plain EOA CANNOT register a conditional
// order (an EOA can't implement isValidSignature), so the hook that consumes
// this module self-gates to "unsupported" for EOAs and points them at the
// single-signature CoW limit-order path instead. This module is PURE: it only
// derives the schedule and ABI-encodes the order + calldata.

import { encodeAbiParameters, encodeFunctionData, type Address, type Hex } from 'viem';
import { COW_APP_DATA_HASH } from './cowProtocol';

// ─── Canonical deterministic deployments (identical on every chain) ──────────
export const COMPOSABLE_COW_ADDRESS = '0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74' as Address;
export const TWAP_HANDLER_ADDRESS = '0x6cF1e9cA41f7611dEf408122793c358a3d11E5a5' as Address;

// ─── Guard rails on user input ───────────────────────────────────────────────
export const TWAP_MIN_PARTS = 2;
export const TWAP_MAX_PARTS = 100;
export const TWAP_MIN_INTERVAL_SECONDS = 60; // ComposableCoW requires t > 0; 1 min floor
export const TWAP_MAX_INTERVAL_SECONDS = 365 * 24 * 60 * 60; // 1 year ceiling

// ─── The TWAP handler `Data` struct (order of fields is consensus-critical) ──
export interface TwapData {
  sellToken: Address;
  buyToken: Address;
  receiver: Address;
  partSellAmount: bigint; // sellToken base units sold PER PART
  minPartLimit: bigint; // minimum buyToken base units accepted PER PART
  t0: bigint; // unix seconds the first part becomes tradeable
  n: bigint; // number of parts
  t: bigint; // seconds between the start of each part
  span: bigint; // 0 = part valid for the whole interval; else seconds of validity
  appData: Hex;
}

const TWAP_DATA_ABI = [
  {
    type: 'tuple',
    components: [
      { name: 'sellToken', type: 'address' },
      { name: 'buyToken', type: 'address' },
      { name: 'receiver', type: 'address' },
      { name: 'partSellAmount', type: 'uint256' },
      { name: 'minPartLimit', type: 'uint256' },
      { name: 't0', type: 'uint256' },
      { name: 'n', type: 'uint256' },
      { name: 't', type: 'uint256' },
      { name: 'span', type: 'uint256' },
      { name: 'appData', type: 'bytes32' },
    ],
  },
] as const;

/** ABI-encode the TWAP `Data` struct into the handler's `staticInput` bytes. */
export function encodeTwapStaticInput(data: TwapData): Hex {
  return encodeAbiParameters(TWAP_DATA_ABI, [data]);
}

// ─── ConditionalOrderParams { handler, salt, staticInput } ───────────────────
export interface ConditionalOrderParams {
  handler: Address;
  salt: Hex; // bytes32 — makes otherwise-identical orders unique
  staticInput: Hex;
}

const CONDITIONAL_ORDER_PARAMS_ABI = [
  {
    type: 'tuple',
    components: [
      { name: 'handler', type: 'address' },
      { name: 'salt', type: 'bytes32' },
      { name: 'staticInput', type: 'bytes' },
    ],
  },
] as const;

export function encodeConditionalOrderParams(params: ConditionalOrderParams): Hex {
  return encodeAbiParameters(CONDITIONAL_ORDER_PARAMS_ABI, [params]);
}

// Minimal ComposableCoW ABI — just the `create` entrypoint we submit.
export const COMPOSABLE_COW_CREATE_ABI = [
  {
    type: 'function',
    name: 'create',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'handler', type: 'address' },
          { name: 'salt', type: 'bytes32' },
          { name: 'staticInput', type: 'bytes' },
        ],
      },
      { name: 'dispatch', type: 'bool' },
    ],
    outputs: [],
  },
] as const;

/**
 * Build the `ComposableCoW.create(params, dispatch)` calldata that registers a
 * TWAP conditional order. `dispatch: true` emits the ConditionalOrderCreated
 * event the watchtower listens for. This is submitted BY the smart-contract
 * wallet (Safe) — see useCowTwap for the wallet-type gate.
 */
export function buildCreateTwapCalldata(params: {
  data: TwapData;
  salt: Hex;
  dispatch?: boolean;
}): Hex {
  const staticInput = encodeTwapStaticInput(params.data);
  const orderParams: ConditionalOrderParams = {
    handler: TWAP_HANDLER_ADDRESS,
    salt: params.salt,
    staticInput,
  };
  return encodeFunctionData({
    abi: COMPOSABLE_COW_CREATE_ABI,
    functionName: 'create',
    args: [orderParams, params.dispatch ?? true],
  });
}

/** Random bytes32 salt (browser crypto). Kept separate so builders stay pure. */
export function randomSalt(): Hex {
  const bytes = new Uint8Array(32);
  (globalThis.crypto ?? crypto).getRandomValues(bytes);
  let hex = '0x';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex as Hex;
}

// ─── Schedule derivation (pure, integer-exact) ───────────────────────────────

export interface TwapPlanInput {
  totalSellAmount: bigint; // total sellToken base units to spread across the TWAP
  parts: number; // N
  intervalSeconds: number; // t — seconds between part starts
  spanSeconds?: number; // 0 (default) = each part valid the whole interval
  /** Price floor as buyToken base units per ONE WHOLE sellToken. */
  priceNumerator: bigint;
  /** 10 ** sellTokenDecimals — the scale that `priceNumerator` is quoted against. */
  priceScale: bigint;
  startTime?: number; // unix seconds for t0; defaults to "now"
  now?: number; // injectable clock (ms) for tests
}

export interface TwapPlan {
  valid: boolean;
  error: string | null;
  partSellAmount: bigint;
  minPartLimit: bigint;
  /** partSellAmount × n — what actually gets sold (may be < total by `dust`). */
  actualTotalSell: bigint;
  /** total − actualTotalSell — remainder left unsold from integer division. */
  dust: bigint;
  /** minPartLimit × n — the guaranteed minimum total buy across all parts. */
  minTotalBuy: bigint;
  t0: bigint;
  n: bigint;
  t: bigint;
  span: bigint;
}

const EMPTY_PLAN = (error: string): TwapPlan => ({
  valid: false,
  error,
  partSellAmount: 0n,
  minPartLimit: 0n,
  actualTotalSell: 0n,
  dust: 0n,
  minTotalBuy: 0n,
  t0: 0n,
  n: 0n,
  t: 0n,
  span: 0n,
});

/**
 * Derive an exact TWAP schedule from user inputs. All amounts are integer base
 * units — no float math touches a signed on-chain value. Returns a `valid:false`
 * plan with a human `error` for any out-of-range input so the UI can disable
 * placement and show the reason (never silently clamp into a bad order).
 */
export function planTwap(input: TwapPlanInput): TwapPlan {
  const { totalSellAmount, parts, intervalSeconds, priceNumerator, priceScale } = input;
  const span = input.spanSeconds ?? 0;

  if (!Number.isInteger(parts) || parts < TWAP_MIN_PARTS || parts > TWAP_MAX_PARTS) {
    return EMPTY_PLAN(`Parts must be a whole number between ${TWAP_MIN_PARTS} and ${TWAP_MAX_PARTS}.`);
  }
  if (
    !Number.isFinite(intervalSeconds) ||
    intervalSeconds < TWAP_MIN_INTERVAL_SECONDS ||
    intervalSeconds > TWAP_MAX_INTERVAL_SECONDS
  ) {
    return EMPTY_PLAN('Interval between parts is out of range.');
  }
  if (!Number.isFinite(span) || span < 0 || span > intervalSeconds) {
    return EMPTY_PLAN('Fill window (span) must be between 0 and the interval.');
  }
  if (totalSellAmount <= 0n) return EMPTY_PLAN('Enter a total amount to sell.');
  if (priceNumerator <= 0n || priceScale <= 0n) return EMPTY_PLAN('Enter a valid limit price.');

  const n = BigInt(parts);
  const partSellAmount = totalSellAmount / n;
  if (partSellAmount <= 0n) {
    return EMPTY_PLAN('Total is too small to split into this many parts.');
  }
  const actualTotalSell = partSellAmount * n;
  const dust = totalSellAmount - actualTotalSell;
  const minPartLimit = (partSellAmount * priceNumerator) / priceScale;
  if (minPartLimit <= 0n) {
    return EMPTY_PLAN('Limit price is too low for this part size.');
  }
  const nowSec = Math.floor((input.now ?? Date.now()) / 1000);
  const t0 = BigInt(input.startTime ?? nowSec);

  return {
    valid: true,
    error: null,
    partSellAmount,
    minPartLimit,
    actualTotalSell,
    dust,
    minTotalBuy: minPartLimit * n,
    t0,
    n,
    t: BigInt(Math.floor(intervalSeconds)),
    span: BigInt(Math.floor(span)),
  };
}

/** Assemble the on-chain `TwapData` from a validated plan + token context. */
export function twapDataFromPlan(
  plan: TwapPlan,
  ctx: { sellToken: Address; buyToken: Address; receiver: Address; appData?: Hex },
): TwapData {
  return {
    sellToken: ctx.sellToken,
    buyToken: ctx.buyToken,
    receiver: ctx.receiver,
    partSellAmount: plan.partSellAmount,
    minPartLimit: plan.minPartLimit,
    t0: plan.t0,
    n: plan.n,
    t: plan.t,
    span: plan.span,
    appData: ctx.appData ?? COW_APP_DATA_HASH,
  };
}
