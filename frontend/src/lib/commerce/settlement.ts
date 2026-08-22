// Turning an invoice plus a meta-router quote into a plan the buyer can read
// BEFORE they sign, or into a refusal.
//
// ─── THE ONE PROPERTY THIS FILE EXISTS TO HOLD ──────────────────────────────
//
//   A checkout that quotes one number and settles another is fraud with good
//   intentions.
//
// So the merchant's leg is fixed and exact — `invoice.settleAmount` of
// `invoice.settleToken`, transferred directly to `invoice.merchant` — and the
// route's uncertainty lands entirely on the BUYER's side, as a maximum they may
// spend of their own asset. If the route cannot GUARANTEE the merchant's exact
// amount at the buyer's own slippage tolerance, `plan.refusals` is non-empty and
// no signature is offered. There is no "probably enough" state.
//
// ─── WHY IT IS TWO LEGS AND NOT ONE ─────────────────────────────────────────
//
// Not a design preference — a property of the rail we actually have. The
// aggregator proxy's per-provider `allowedQuery` lists (api/aggregator.js) carry
// no recipient parameter, so no quote this venue can fetch can be told to
// deliver its output to a third party. Claiming atomic merchant delivery would
// therefore be describing a call we cannot make. The honest composition is:
//
//   leg 1  swap      buyer's payToken → settleToken, output landing in the
//                    BUYER's own wallet
//   leg 2  transfer  exactly `settleAmount` of settleToken → merchant
//
// Both legs are signed by the buyer. Nothing in this venue ever holds, escrows
// or forwards the funds, and no server anywhere on this path holds a key.
//
// A second constraint decides WHERE each leg is signed, and the widget states it
// rather than blurring it. The meta-aggregator in lib/aggregator.ts is
// QUOTE-ONLY on this deployment — useSwap.ts executes an "aggregator" selection
// through the venue's own on-chain route, not through the aggregator's calldata
// — so the checkout cannot execute leg 1 at the quoted price and does not
// pretend to. Leg 2 is signed in the checkout, exactly, and leg 1 is a sized,
// priced instruction the buyer carries to the trade surface. The refusal below
// still governs both: if no route can cover the merchant's exact amount, the
// checkout says so instead of sending someone off to find out.
//
// The consequence to state on the surface rather than hide: the two legs are not
// atomic. Leg 1 can land and leg 2 can be abandoned, in which case the buyer
// holds settleToken and the merchant is unpaid. That is a strictly better
// failure than the reverse, and it is why leg 2 moves the EXACT invoice amount
// rather than "whatever leg 1 produced" — the surplus is the buyer's and is
// never quietly swept to the merchant.
//
// ─── WHY THE SAME-ASSET PATH IS SEPARATE ────────────────────────────────────
//
// When the buyer already holds the settlement asset there is no route, no
// slippage and nothing to guarantee. Running that case through the swap branch
// would invent a quote for a trade nobody makes and attach its uncertainty to a
// payment that has none.

import type { AggregatorQuote } from '../aggregator';
import { invoiceLifecycle, ZERO_ADDRESS, type Invoice } from './invoice';

/**
 * How old a quote may be when the plan is built.
 *
 * The buyer still has to read the disclosure and approve in their wallet after
 * this, so the real exposure is longer than this number. That is precisely why
 * it is short: the figure on screen must have been produced by a request that is
 * still recognisably about the current market, and a caller that lets it go
 * stale gets a refusal instead of a fresher-looking number it did not fetch.
 */
export const MAX_QUOTE_AGE_SECONDS = 45;

/** Basis-point denominator. */
const BPS = 10_000n;

export interface SettlementInputs {
  invoice: Invoice;
  /** The buyer. Legs are built for this signer and nobody else. */
  buyer: `0x${string}` | null;
  /** The asset the buyer chose to pay in. */
  payToken: `0x${string}`;
  paySymbol: string;
  payDecimals: number;
  /**
   * The exact input amount the quote below was fetched for.
   *
   * Not derived here from the invoice. Every aggregator this venue proxies is
   * exact-IN, so a plan is always built against a quote that was really
   * requested at this size — see `sizePayAmount`, whose output is a REQUEST
   * size and never a disclosure.
   */
  payAmount: bigint;
  /**
   * Null when no route answered. A plan with a null quote refuses; it does not
   * fall back to an on-chain guess, because a guess would be a second price
   * nobody fetched appearing in the same sentence as the one they did.
   */
  quote: AggregatorQuote | null;
  /** Unix seconds the quote was received. */
  quotedAt: number;
  /** The tolerance that will be enforced when the swap is signed, in percent. */
  slippagePct: number;
  /** Unix seconds, now. */
  now: number;
  /** The chain the wallet is actually on. */
  connectedChainId: number | null;
}

export type SettlementLeg =
  | {
      kind: 'swap';
      /** Informational — the route the guarantee below was computed from. */
      source: AggregatorQuote['source'];
      tokenIn: `0x${string}`;
      tokenOut: `0x${string}`;
      amountIn: bigint;
      /** What the route quoted, before tolerance. Never the guarantee. */
      quotedOut: bigint;
      /** Quoted output less the buyer's tolerance. THIS is the guarantee. */
      minOut: bigint;
    }
  | {
      kind: 'transfer';
      token: `0x${string}`;
      to: `0x${string}`;
      /** Always `invoice.settleAmount`. Never the swap's realised output. */
      amount: bigint;
    };

/**
 * Every figure the buyer must see before a signature is offered.
 *
 * Deliberately a flat record of decided numbers rather than the inputs they came
 * from: a surface that re-derives a disclosure figure from a quote is a surface
 * that can derive a different one than the plan refused or allowed on.
 */
export interface SettlementDisclosure {
  /** Exact — what the merchant receives, and the only number they are owed. */
  settleAmount: bigint;
  settleToken: `0x${string}`;
  settleSymbol: string;
  settleDecimals: number;
  merchant: `0x${string}`;
  /** The most that can leave the buyer's wallet for this payment. */
  payAmountMax: bigint;
  payToken: `0x${string}`;
  paySymbol: string;
  payDecimals: number;
  /**
   * Guaranteed settleToken out of leg 1, at the stated tolerance. Equal to
   * `payAmountMax` in the same-asset case, where there is no route at all.
   */
  guaranteedOut: bigint;
  /**
   * `guaranteedOut - settleAmount`. Never negative in an offerable plan, and it
   * belongs to the BUYER — leg 2 moves the invoice amount, not this.
   */
  buyerSurplus: bigint;
  /** Null in the same-asset case: nothing was routed, so nothing has tolerance. */
  slippagePct: number | null;
  /** Null in the same-asset case. */
  quoteAgeSeconds: number | null;
  /** Seconds until the invoice lapses. Negative is impossible in an offerable plan. */
  expiresInSeconds: number;
}

export interface SettlementPlan {
  invoice: Invoice;
  disclosure: SettlementDisclosure;
  /** Ordered. Empty whenever `refusals` is non-empty. */
  legs: SettlementLeg[];
  /**
   * Plain-language reasons no signature may be offered. A caller that renders
   * `legs` without checking this has built the fraud in the header.
   */
  refusals: string[];
  /** True only when the buyer already holds the settlement asset. */
  sameAsset: boolean;
}

export function canSign(plan: SettlementPlan): boolean {
  return plan.refusals.length === 0 && plan.legs.length > 0;
}

/**
 * Quoted output less the buyer's tolerance — the number the plan is allowed to
 * call a guarantee.
 *
 * Rounds DOWN by integer division, which is the only direction that can be
 * called a minimum. Tolerance is converted to basis points with `Math.round`
 * before it touches bigint arithmetic, so a tolerance of 0.005% (below one basis
 * point) becomes 0 bps and guarantees the full quote — a caller wanting a
 * sub-bps tolerance is asking for a precision this venue's routes do not have.
 */
export function applySlippageFloor(quotedOut: bigint, slippagePct: number): bigint {
  if (quotedOut <= 0n) return 0n;
  const bps = BigInt(Math.max(0, Math.min(10_000, Math.round(slippagePct * 100))));
  return (quotedOut * (BPS - bps)) / BPS;
}

/**
 * How much payToken to REQUEST a real quote for. Never a disclosure figure.
 *
 * The aggregators this venue proxies are exact-in, so sizing an exact-out
 * payment takes two round trips: a probe at any workable size establishes an
 * implied rate, this scales that rate to the target and adds headroom, and then
 * a SECOND, real quote is fetched at the returned size and is the only thing
 * `buildSettlementPlan` is ever shown. If the second quote's guarantee still
 * falls short, the plan refuses — it does not iterate silently toward a number
 * that clears the check.
 *
 * Returns null when the probe cannot imply a rate at all (zero output, zero
 * input), because a rate of zero would size a payment of zero.
 */
export function sizePayAmount(
  probe: { amountIn: bigint; amountOut: bigint },
  targetOut: bigint,
  headroomBps = 150,
): bigint | null {
  if (probe.amountIn <= 0n || probe.amountOut <= 0n || targetOut <= 0n) return null;
  // ceil-div so the implied cost is never rounded down into a shortfall.
  const base = (targetOut * probe.amountIn + probe.amountOut - 1n) / probe.amountOut;
  const bps = BigInt(Math.max(0, Math.min(5_000, Math.round(headroomBps))));
  return base + (base * bps) / BPS;
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Build the plan, or the refusal.
 *
 * ALWAYS returns a plan object with a filled disclosure, even when it refuses.
 * A refusal that returns null forces the caller to invent the sentence that
 * explains it, and the numbers that made the refusal correct are exactly the
 * ones the buyer should be shown.
 */
export function buildSettlementPlan(input: SettlementInputs): SettlementPlan {
  const { invoice, buyer, payToken, payAmount, quote, quotedAt, slippagePct, now } = input;

  const sameAsset = sameAddress(payToken, invoice.settleToken);
  const refusals: string[] = [];

  const lifecycle = invoiceLifecycle(invoice, now);
  if (lifecycle === 'malformed') {
    refusals.push('This invoice is not well-formed, so no payment can be built from it.');
  } else if (lifecycle === 'expired') {
    refusals.push(
      'This invoice has expired. The merchant committed to a token price for a fixed window and that ' +
        'window has closed — ask them for a fresh one rather than paying against a lapsed price.',
    );
  }

  if (buyer === null) {
    refusals.push('No wallet is connected, so there is no signer to build a payment for.');
  } else if (sameAddress(buyer, invoice.merchant)) {
    refusals.push('The connected wallet is the merchant on this invoice, so this would be a payment to itself.');
  }

  if (input.connectedChainId !== null && input.connectedChainId !== invoice.chainId) {
    refusals.push(
      `This invoice is payable on chain ${invoice.chainId} and the wallet is on chain ${input.connectedChainId}. ` +
        'Nothing was quoted for the connected chain.',
    );
  }

  // ─── The route, and what it is allowed to be called ───────────────────────
  let quotedOut = 0n;
  let guaranteedOut = 0n;
  let quoteAgeSeconds: number | null = null;

  if (sameAsset) {
    // No route. The buyer holds the asset, so the "guarantee" is the balance
    // arithmetic the wallet does at signing time, and the surplus is whatever
    // they chose to leave in.
    quotedOut = payAmount;
    guaranteedOut = payAmount;
    if (payAmount < invoice.settleAmount) {
      refusals.push(
        'The amount offered is less than the invoice. The merchant is owed an exact amount and this ' +
          'would underpay them.',
      );
    }
  } else if (quote === null) {
    refusals.push(
      'No route answered for this pair, so there is no price to show you and nothing to sign. This is a ' +
        'statement about the routers, not about your balance.',
    );
  } else {
    quoteAgeSeconds = Math.max(0, now - quotedAt);
    if (quote.chainId !== invoice.chainId) {
      refusals.push('The route that answered is for a different chain than the invoice names.');
    }
    if (quoteAgeSeconds > MAX_QUOTE_AGE_SECONDS) {
      refusals.push(
        `The quote is ${quoteAgeSeconds}s old, past this checkout's ${MAX_QUOTE_AGE_SECONDS}s limit. ` +
          'Refresh it — the figures on screen must come from a request that is still about the current market.',
      );
    }
    try {
      quotedOut = BigInt(quote.amountOut);
    } catch {
      quotedOut = 0n;
      refusals.push('The route returned an output amount that is not an integer, so nothing here can be trusted.');
    }
    guaranteedOut = applySlippageFloor(quotedOut, slippagePct);

    // THE CHECK. Everything above is hygiene; this is the property.
    if (guaranteedOut < invoice.settleAmount) {
      refusals.push(
        'At your slippage tolerance this route cannot guarantee the exact amount the merchant is owed, ' +
          'so no signature is offered. Raise the amount you are paying, lower your tolerance, or pay in ' +
          'the settlement asset directly.',
      );
    }
  }

  if (payAmount <= 0n) {
    refusals.push('The amount to pay is zero, so there is nothing to route and nothing to settle.');
  }

  const disclosure: SettlementDisclosure = {
    settleAmount: invoice.settleAmount,
    settleToken: invoice.settleToken,
    settleSymbol: invoice.settleSymbol,
    settleDecimals: invoice.settleDecimals,
    merchant: invoice.merchant,
    payAmountMax: payAmount,
    payToken,
    paySymbol: input.paySymbol,
    payDecimals: input.payDecimals,
    guaranteedOut,
    // Clamped at zero: a negative surplus is a shortfall, it has already produced
    // a refusal above, and rendering it as "you will receive -3 USDC back" would
    // describe a payment that is not being offered.
    buyerSurplus: guaranteedOut > invoice.settleAmount ? guaranteedOut - invoice.settleAmount : 0n,
    slippagePct: sameAsset ? null : slippagePct,
    quoteAgeSeconds,
    expiresInSeconds: invoice.expiresAt - now,
  };

  if (refusals.length > 0) {
    return { invoice, disclosure, legs: [], refusals, sameAsset };
  }

  const legs: SettlementLeg[] = [];
  if (!sameAsset && quote) {
    legs.push({
      kind: 'swap',
      source: quote.source,
      tokenIn: payToken,
      tokenOut: invoice.settleToken,
      amountIn: payAmount,
      quotedOut,
      minOut: guaranteedOut,
    });
  }
  legs.push({
    kind: 'transfer',
    token: invoice.settleToken,
    to: invoice.merchant,
    amount: invoice.settleAmount,
  });

  return { invoice, disclosure, legs, refusals, sameAsset };
}

// ─── The settlement record ───────────────────────────────────────────────────

/**
 * How much this venue actually knows about a claimed payment.
 *
 * The distinction is the whole value of the record. A merchant reading
 * "settled" must be able to tell an on-chain fact from a browser's assertion,
 * because releasing goods against the second one is how a checkout gets robbed.
 */
export type SettlementVerification =
  /** A client said it broadcast this hash. Nothing has checked the chain. */
  | 'client-reported'
  /** A receipt was read and the transfer leg was found. */
  | 'chain-confirmed'
  /** A receipt was read and the transfer leg was NOT found, or reverted. */
  | 'chain-refuted';

export interface SettlementRecord {
  invoiceId: string;
  /** The wallet that claims to have paid. */
  payer: `0x${string}`;
  /** The transfer leg's hash — the leg that moved the merchant's money. */
  txHash: `0x${string}`;
  chainId: number;
  /** Exactly what the invoice asked for; the record never restates a different figure. */
  settleAmount: bigint;
  settleToken: `0x${string}`;
  verification: SettlementVerification;
  /** Unix seconds the record was written. */
  recordedAt: number;
}

const TX_HASH_RE = /^0x[a-fA-F0-9]{64}$/;

/**
 * Human sentence for a record's standing, written for the merchant.
 *
 * Exported rather than inlined in a component because it is the sentence that
 * decides whether goods are released, and a second copy of it in a JSX branch is
 * a second policy.
 */
export function settlementStandingText(verification: SettlementVerification): string {
  switch (verification) {
    case 'chain-confirmed':
      return 'A receipt was read and the transfer to you was found in it.';
    case 'chain-refuted':
      return 'A receipt was read and it does NOT contain the transfer to you. Do not release anything against this.';
    case 'client-reported':
      return (
        'A browser reported this transaction hash. Nothing has read the chain, so this is a claim, not a ' +
        'confirmation — check the hash yourself before releasing anything.'
      );
  }
}

export function buildSettlementRecord(args: {
  invoice: Invoice;
  payer: `0x${string}`;
  txHash: string;
  verification: SettlementVerification;
  recordedAt: number;
}): SettlementRecord | null {
  if (!TX_HASH_RE.test(args.txHash)) return null;
  return {
    invoiceId: args.invoice.id,
    payer: args.payer,
    txHash: args.txHash as `0x${string}`,
    chainId: args.invoice.chainId,
    settleAmount: args.invoice.settleAmount,
    settleToken: args.invoice.settleToken,
    verification: args.verification,
    recordedAt: args.recordedAt,
  };
}

/** Guard for the merchant address a caller pulled out of a URL or a form. */
export function isPlausibleMerchant(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address) && address.toLowerCase() !== ZERO_ADDRESS;
}
