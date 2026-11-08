// CoW Protocol market-swap primitives (MEV-protected "fill-or-kill" swaps).
//
// This is the SWAP counterpart to lib/cowProtocol.ts (which does single limit
// orders). A CoW market swap is a normal GPv2 sell order priced off a live CoW
// quote: the user signs one EIP-712 order, CoW's solver auction settles it at or
// above the quoted price, and because it never touches the public mempool a
// searcher can't sandwich it. Unfilled orders cost nothing (no gas to place).
//
// Battle-tested source: CoW Protocol orderbook API (https://docs.cow.fi) — the
// POST /quote → sign(order) → POST /orders flow. We REUSE the EIP-712 order
// schema, domain, submission encoder and the hardened proxy URL from
// lib/cowProtocol.ts rather than re-deriving any of it. ERC-20 sell tokens only
// (native-ETH sells need CoW's EthFlow contract — intentionally out of scope,
// same as the limit-order path; the UI tells the user to wrap ETH first).
//
// This module is PURE: it builds request bodies, parses quotes, and constructs
// the signed order (with the user's slippage as the price floor). The signing +
// approval + submission lifecycle lives in hooks/useCowSwap.ts.

import type { Address } from 'viem';
import {
  COW_PARTNER_FEE_BPS,
  COW_SWAP_APP_DATA_HASH,
  cowOrderbookUrl,
  type CowOrder,
} from './cowProtocol';

// A market swap is short-lived by nature — a "fill-or-kill" at ~current price.
// 20 minutes gives the solver auction several blocks to land the fill while
// keeping the signed price from going stale. Well under the uint32 validTo cap.
export const COW_SWAP_DEFAULT_TTL_SECONDS = 20 * 60;

/**
 * Orderbook URL via the PROVEN, explicitly-rewritten proxy alias.
 *
 * Thin re-export of cowProtocol.ts's `cowOrderbookUrl` — ONE source of truth for
 * the proxy base. This used to be a second copy of the literal, which is exactly
 * how the limit-order path drifted onto the unrouted `/api/aggregator/cow/...`
 * form while the swap path stayed correct. See cowOrderbookUrl for why the
 * `/api/cow/...` alias is the only base that actually routes.
 */
export const cowApiUrl = cowOrderbookUrl;

// Clamp mirrors useSwap's own 0–20% envelope so the CoW floor can never be laxer
// than the on-chain swap path the user could otherwise take.
export const COW_SWAP_MAX_SLIPPAGE_PCT = 20;

/** Convert a slippage percent (0–20) to integer basis points, clamped. */
export function slippagePctToBps(pct: number): bigint {
  if (!Number.isFinite(pct) || pct <= 0) return 0n;
  const clamped = Math.min(pct, COW_SWAP_MAX_SLIPPAGE_PCT);
  // Round to the nearest bp; percents like 0.3 → 30 bps.
  return BigInt(Math.round(clamped * 100));
}

/**
 * Apply a slippage haircut to a quoted buy amount to get the signed floor.
 * The order guarantees the user AT LEAST this many buy-token base units; solvers
 * keep any positive surplus. Returns the input unchanged for 0 bps.
 */
export function applyBuySlippage(buyAmount: bigint, slippageBps: bigint): bigint {
  if (buyAmount <= 0n) return 0n;
  if (slippageBps <= 0n) return buyAmount;
  return buyAmount - (buyAmount * slippageBps) / 10000n;
}

// ─── Quote request/response ─────────────────────────────────────────────────

export interface CowSwapQuoteRequest {
  sellToken: string;
  buyToken: string;
  from: string;
  receiver: string;
  sellAmountBeforeFee: string; // base units of sellToken
  kind: 'sell';
  signingScheme: 'eip712';
  onchainOrder: false;
  priceQuality: 'fast' | 'optimal';
}

/**
 * Build the POST /quote body for a SELL market swap. Mirrors the shape the
 * price-comparison aggregator already sends (lib/aggregator.ts getCowSwapQuote)
 * so the proxy's allowlist stays satisfied. `sellToken`/`buyToken` must be
 * ERC-20 addresses (WETH, never native ETH).
 */
export function buildCowSwapQuoteBody(params: {
  sellToken: Address;
  buyToken: Address;
  owner: Address;
  sellAmount: bigint;
  priceQuality?: 'fast' | 'optimal';
}): CowSwapQuoteRequest {
  return {
    sellToken: params.sellToken,
    buyToken: params.buyToken,
    from: params.owner,
    receiver: params.owner,
    sellAmountBeforeFee: params.sellAmount.toString(),
    kind: 'sell',
    signingScheme: 'eip712',
    onchainOrder: false,
    priceQuality: params.priceQuality ?? 'fast',
  };
}

/** The subset of the CoW /quote response we consume, with amounts as bigints. */
export interface ParsedCowSwapQuote {
  sellAmount: bigint; // amount sold AFTER network costs (CoW subtracted feeAmount from the input)
  buyAmount: bigint; // buy amount for that sellAmount, CoW's protocol fee already deducted (pre-slippage)
  feeAmount: bigint; // estimated network cost in sell-token units — a price input, never signed
  protocolFeeBps: number; // CoW's own fee, already baked into buyAmount
  validTo: number; // quote's own expiry (we set our own on the order)
  quoteId: number | null; // opaque id echoed back to the orderbook when placing
}

function isDigits(v: unknown): v is string {
  return typeof v === 'string' && /^\d+$/.test(v);
}

/**
 * Parse the raw CoW /quote JSON into bigints. Returns null on any missing/
 * malformed field so callers self-gate to "no quote" rather than signing against
 * garbage. NEVER fabricates a number — a bad quote yields null, not a zero fill.
 */
export function parseCowSwapQuote(raw: unknown): ParsedCowSwapQuote | null {
  if (!raw || typeof raw !== 'object') return null;
  const outer = raw as { quote?: unknown; id?: unknown };
  const q = outer.quote;
  if (!q || typeof q !== 'object') return null;
  const quote = q as Record<string, unknown>;
  if (!isDigits(quote.sellAmount) || !isDigits(quote.buyAmount)) return null;
  // feeAmount is CoW's network-cost estimate (non-zero on a live quote). It feeds
  // the amount math below; it is NOT a fee to sign — see buildCowSwapOrder.
  const feeRaw = quote.feeAmount;
  const feeAmount = isDigits(feeRaw) ? BigInt(feeRaw) : 0n;
  let sellAmount: bigint;
  let buyAmount: bigint;
  try {
    sellAmount = BigInt(quote.sellAmount as string);
    buyAmount = BigInt(quote.buyAmount as string);
  } catch {
    return null;
  }
  if (sellAmount <= 0n || buyAmount <= 0n) return null;
  const validTo =
    typeof quote.validTo === 'number' && Number.isFinite(quote.validTo)
      ? quote.validTo
      : Math.floor(Date.now() / 1000) + COW_SWAP_DEFAULT_TTL_SECONDS;
  const quoteId = typeof outer.id === 'number' && Number.isFinite(outer.id) ? outer.id : null;
  // A string on the wire ("2"); fractional values are legal. Absent → none.
  const protocolFeeRaw = (outer as { protocolFeeBps?: unknown }).protocolFeeBps;
  const protocolFeeBps = protocolFeeRaw === undefined ? 0 : Number(protocolFeeRaw);
  if (!Number.isFinite(protocolFeeBps) || protocolFeeBps < 0 || protocolFeeBps >= 10000) return null;
  return { sellAmount, buyAmount, feeAmount, protocolFeeBps, validTo, quoteId };
}

// ─── Amounts to sign ────────────────────────────────────────────────────────

export interface CowSwapAmounts {
  /** The user's whole input: CoW takes network costs out of it at settlement. */
  sellAmount: bigint;
  /** What the user receives at the quoted price, after every fee (before slippage). */
  buyAmountAfterFees: bigint;
  /** The signed floor: buyAmountAfterFees less the slippage tolerance. */
  buyAmountMin: bigint;
  /** The venue's partner fee, in buy-token units, at the quoted price. */
  partnerFeeAmount: bigint;
}

/**
 * SELL-order amounts from a CoW quote, ported line for line from CoW's SDK
 * (cow-sdk packages/order-book/src/quoteAmountsAndCosts: getQuoteAmountsAndCosts,
 * getProtocolFeeAmount, getQuoteAmountsAfterPartnerFee, SELL branch). The partner
 * fee is a share of the trade BEFORE all fees, so the SDK first restores the
 * network cost and CoW's protocol fee that the quote already took out.
 */
export function cowSwapAmounts(
  quote: ParsedCowSwapQuote,
  slippageBps: bigint,
  partnerFeeBps: number = COW_PARTNER_FEE_BPS,
): CowSwapAmounts {
  const { sellAmount, buyAmount, feeAmount } = quote;
  const networkCostInBuy = (buyAmount * feeAmount) / sellAmount;
  // getProtocolFeeAmount: keep 5 decimal places of bps precision.
  const protocolFeeBpsBig = BigInt(Math.round(quote.protocolFeeBps * 100_000));
  const protocolFeeAmount =
    protocolFeeBpsBig > 0n ? (buyAmount * protocolFeeBpsBig) / (10_000n * 100_000n - protocolFeeBpsBig) : 0n;
  const buyBeforeAllFees = buyAmount + networkCostInBuy + protocolFeeAmount;
  const partnerFeeAmount = partnerFeeBps > 0 ? (buyBeforeAllFees * BigInt(partnerFeeBps)) / 10_000n : 0n;
  const buyAmountAfterFees = buyAmount - partnerFeeAmount;
  return {
    sellAmount: sellAmount + feeAmount,
    buyAmountAfterFees,
    buyAmountMin: applyBuySlippage(buyAmountAfterFees, slippageBps),
    partnerFeeAmount,
  };
}

// ─── Order construction ─────────────────────────────────────────────────────

export interface BuildCowSwapOrderParams {
  sellToken: Address;
  buyToken: Address;
  receiver: Address;
  quote: ParsedCowSwapQuote;
  /** The amount the user entered — the quote's `sellAmountBeforeFee`. */
  typedSellAmount: bigint;
  slippageBps: bigint;
  /** Unix seconds the order stays valid; defaults to now + 20 min. */
  validTo?: number;
  now?: number; // injectable clock for tests
}

export interface BuiltCowSwapOrder {
  order: CowOrder;
  buyAmountMin: bigint; // == order.buyAmount, surfaced for the UI
}

/**
 * Build the canonical GPv2 SELL order for a market swap from a parsed quote, the
 * way CoW's SDK signs one (`amountsToSign`): sell the user's WHOLE input, sign a
 * fee of 0, and floor the buy amount at the quote after every fee, less slippage.
 * CoW's orderbook has rejected any non-zero signed fee since 2024-03-04
 * (services #2454, `NonZeroFee`): network costs now come out of the limit price.
 * Uses the market-swap appData (COW_SWAP_APP_DATA_HASH) and a fresh validTo.
 */
export function buildCowSwapOrder(params: BuildCowSwapOrderParams): BuiltCowSwapOrder {
  const nowSec = Math.floor((params.now ?? Date.now()) / 1000);
  const validTo = params.validTo ?? nowSec + COW_SWAP_DEFAULT_TTL_SECONDS;
  // The signed sellAmount comes from CoW's answer. It is only the user's input if
  // CoW echoed it back, so a quote that sells anything else is never signed.
  if (!quoteSellsTypedAmount(params.quote, params.typedSellAmount)) {
    throw new Error('CoW quote sells a different amount than the one entered');
  }
  const { sellAmount, buyAmountMin } = cowSwapAmounts(params.quote, params.slippageBps);
  const order: CowOrder = {
    sellToken: params.sellToken,
    buyToken: params.buyToken,
    receiver: params.receiver,
    sellAmount,
    buyAmount: buyAmountMin,
    validTo,
    appData: COW_SWAP_APP_DATA_HASH,
    feeAmount: 0n,
    kind: 'sell',
    partiallyFillable: false,
    sellTokenBalance: 'erc20',
    buyTokenBalance: 'erc20',
  };
  return { order, buyAmountMin };
}

/**
 * The total sell-side approval/balance a market order needs: the amount sold
 * PLUS the network fee (both pulled by the vault relayer at settlement).
 */
export function requiredSellBalance(quote: ParsedCowSwapQuote): bigint {
  return quote.sellAmount + quote.feeAmount;
}

/**
 * A SELL quote for `sellAmountBeforeFee = typed` comes back as sellAmount + feeAmount
 * = typed (CoW takes the network cost out of the input). Anything else is a quote
 * for a different trade than the one on screen.
 */
export function quoteSellsTypedAmount(quote: ParsedCowSwapQuote, typed: bigint): boolean {
  return typed > 0n && quote.sellAmount + quote.feeAmount === typed;
}
