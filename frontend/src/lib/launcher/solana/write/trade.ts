// Buy and sell on the bonding curve.
//
// Every account that decides where money goes is read off chain state, never
// guessed: `creator` from the decoded curve, `fee_recipient` from the decoded
// global. The program pins both (`address = curve.creator`, `address =
// global.fee_recipient`) so a wrong one reverts rather than paying a stranger, and
// the intent check refuses it before a wallet is asked.
//
// Slippage: 1% by default, 5% at most. A floor of 0 is never sent: a quote is stale
// on arrival, and "accept any price" is the whole sandwich.

import { createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token';
import type { PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '../curve/program';
import { associatedTokenAddress, buyIx, sellIx } from '../curve/ix';
import {
  BPS_DENOMINATOR,
  applySlippage,
  effectiveReserves,
  quoteBuyOnCurve,
  quoteSellOnCurve,
  type CurveTerms,
} from '../curve/math';
import { clipDetail, readCurve, type CurveAccount } from '../curve/read';
import { MAX_OWN_PRIORITY_LAMPORTS } from './budget';
import { describeQuoteError } from './errors';
import { bodySteps, buildAndSimulate, confirmedReads, notSent } from './prepare';
import type { FeeSplitView, OpenGate, Prepared, TxSummary, WriteRpc } from './types';

/** 1%. */
export const SLIPPAGE_DEFAULT_BPS = 100n;
/** Above this the page should warn. */
export const SLIPPAGE_WARN_BPS = 300n;
/** Hard ceiling. A request above it is refused, not clamped. */
export const SLIPPAGE_MAX_BPS = 500n;
/** The choices a page offers. */
export const SLIPPAGE_PRESETS_BPS = [50n, 100n, 300n] as const;

export function slippageProblem(bps: bigint): string | null {
  if (bps <= 0n) return 'Set a price limit above 0%.';
  if (bps > SLIPPAGE_MAX_BPS) return `The price limit can be at most ${Number(SLIPPAGE_MAX_BPS) / 100}%.`;
  return null;
}

/** The trade fee's scheduled split, the program's own rounding (creator rounds down). */
export function feeSplit(fee: bigint, creatorShareBps: bigint): FeeSplitView {
  const share = creatorShareBps > BPS_DENOMINATOR ? BPS_DENOMINATOR : creatorShareBps < 0n ? 0n : creatorShareBps;
  const creator = (fee * share) / BPS_DENOMINATOR;
  return { total: fee, creator, platform: fee - creator };
}

/**
 * How much worse than the spot price this trade fills, in bps. Pure pricing: the
 * fee is left out, so the number is the curve's own movement.
 *
 * buy:  `amountIn` = lamports that reach the curve, `amountOut` = tokens out.
 * sell: `amountIn` = tokens in, `amountOut` = gross lamports before the fee.
 *
 * `null` when the curve's reserves give no price to measure against: "could not
 * compute" must never read as a 0.00% impact.
 */
export function priceImpactBps(c: CurveTerms, side: 'buy' | 'sell', amountIn: bigint, amountOut: bigint): bigint | null {
  const eff = effectiveReserves(c);
  if (!eff.ok || eff.value.sol === 0n || eff.value.tokens === 0n) return null;
  if (amountIn <= 0n) return 0n;
  const ideal =
    side === 'buy'
      ? (amountIn * eff.value.tokens) / eff.value.sol
      : (amountIn * eff.value.sol) / eff.value.tokens;
  if (ideal <= 0n || amountOut >= ideal) return 0n;
  return ((ideal - amountOut) * BPS_DENOMINATOR) / ideal;
}

function ctxFor(gate: OpenGate, trader: PublicKey, mint: PublicKey, curve: CurveAccount) {
  return {
    signer: trader,
    cfg: gate.cfg,
    feeRecipient: gate.global.feeRecipient,
    ammConfig: gate.global.ammConfig,
    creator: curve.curve.creator,
    mint,
    maxPriorityLamports: MAX_OWN_PRIORITY_LAMPORTS,
  };
}

function curveMatches(curve: CurveAccount, mint: PublicKey): boolean {
  return curve.curve.mint.equals(mint);
}

/**
 * The curve as the chain has it NOW. The page's copy was read when the page loaded
 * and may be minutes old: quoting from it either blocks every trade (the price moved
 * against the user) or leaves the minimum far below the fair output (the price moved
 * in the user's favour), which a sandwich takes. So every prepare re-reads it.
 */
async function rereadCurve(rpc: WriteRpc, gate: OpenGate, page: CurveAccount, mint: PublicKey): Promise<CurveAccount | string> {
  let r;
  try {
    r = await readCurve(confirmedReads(rpc), mint, gate.cfg.programId);
  } catch (e) {
    return `Could not read the curve to price this: ${clipDetail(e)}`;
  }
  if (r.kind === 'unreadable') return `Could not read the curve to price this: ${r.detail}`;
  if (r.kind !== 'ok') return 'Could not read the curve to price this.';
  if (!r.value.address.equals(page.address) || !curveMatches(r.value, mint)) return 'The curve read does not belong to this token.';
  return r.value;
}

export async function prepareCurveBuy(
  rpc: WriteRpc,
  gate: OpenGate,
  a: { trader: PublicKey; mint: PublicKey; curve: CurveAccount; lamportsIn: bigint; slippageBps: bigint },
): Promise<Prepared> {
  if (gate.paused) return notSent('build', 'Buys are paused right now. Selling still works.');
  if (!curveMatches(a.curve, a.mint)) return notSent('build', 'The curve read does not belong to this token.');
  const bad = slippageProblem(a.slippageBps);
  if (bad) return notSent('build', bad);
  const curve = await rereadCurve(rpc, gate, a.curve, a.mint);
  if (typeof curve === 'string') return notSent('build', curve);
  if (curve.curve.complete) return notSent('build', 'This launch has graduated. Trade it in its pool instead.');

  const q = quoteBuyOnCurve(curve.curve, a.lamportsIn);
  if (!q.ok) return notSent('build', describeQuoteError(q.error));
  const minTokensOut = applySlippage(q.value.tokensOut, a.slippageBps);
  if (minTokensOut === null || minTokensOut <= 0n) return notSent('build', 'That amount is too small to protect with a price limit.');
  const quote = q.value;
  // A buy that fills the curve is signed for what the curve can take, not for the
  // amount typed. The program takes min(max_lamports_in, what is left to the
  // target) at the moment it runs, so a sell landing first would otherwise let it
  // take up to the typed amount while the screen said the smaller one.
  const maxLamportsIn = quote.capped ? quote.lamportsIn : a.lamportsIn;

  const ata = associatedTokenAddress(a.mint, a.trader);
  const body = [
    createAssociatedTokenAccountIdempotentInstruction(a.trader, ata, a.trader, a.mint, TOKEN_PROGRAM_ID),
    buyIx(
      { trader: a.trader, mint: a.mint, feeRecipient: gate.global.feeRecipient, creator: curve.curve.creator },
      maxLamportsIn,
      minTokensOut,
      { programId: gate.cfg.programId, cpSwapProgram: gate.cfg.cpSwapProgram },
    ),
  ];

  return buildAndSimulate(rpc, {
    kind: 'buy',
    body,
    extraSigners: [],
    intent: ctxFor(gate, a.trader, a.mint, curve),
    watch: { signer: a.trader, tokenAccounts: [{ account: ata, mint: a.mint }] },
    expect: (pre, rents) => ({
      // The program never takes more than max_lamports_in; the fee is inside it.
      maxSolOut: maxLamportsIn + (pre.tokens.get(ata.toBase58())?.exists ? 0n : rents.tokenAccount),
      tokens: [{ account: ata, mint: a.mint, minDelta: minTokensOut, maxDelta: 2n ** 64n }],
    }),
    newAccountRent: (pre, rents) => (pre.tokens.get(ata.toBase58())?.exists ? 0n : rents.tokenAccount),
    summarize: (steps): TxSummary | string => {
      const buy = bodySteps(steps).find((s) => s.kind === 'curve-buy');
      if (!buy || buy.kind !== 'curve-buy') return 'The buy is missing from the transaction.';
      if (buy.maxLamportsIn !== maxLamportsIn || buy.minTokensOut !== minTokensOut) {
        return 'The buy in the transaction does not match the quote.';
      }
      return {
        kind: 'buy',
        mint: a.mint,
        maxLamportsIn: buy.maxLamportsIn,
        requestedLamports: a.lamportsIn,
        minTokensOut: buy.minTokensOut,
        quote,
        fillsCurve: quote.capped,
        priceImpactBps: priceImpactBps(curve.curve, 'buy', quote.lamportsToCurve, quote.tokensOut),
        feeSplit: feeSplit(quote.feeLamports, curve.curve.creatorFeeShareBps),
      };
    },
  });
}

export async function prepareCurveSell(
  rpc: WriteRpc,
  gate: OpenGate,
  a: {
    trader: PublicKey;
    mint: PublicKey;
    curve: CurveAccount;
    /** The curve account's rent floor, read from the cluster. The sell check needs it. */
    curveRentFloor: bigint;
    tokensIn: bigint;
    slippageBps: bigint;
  },
): Promise<Prepared> {
  // No pause check: selling is never paused.
  if (!curveMatches(a.curve, a.mint)) return notSent('build', 'The curve read does not belong to this token.');
  const bad = slippageProblem(a.slippageBps);
  if (bad) return notSent('build', bad);
  const curve = await rereadCurve(rpc, gate, a.curve, a.mint);
  if (typeof curve === 'string') return notSent('build', curve);
  if (curve.curve.complete) return notSent('build', 'This launch has graduated. Trade it in its pool instead.');

  const q = quoteSellOnCurve(curve.curve, a.tokensIn, 0n, {
    curveAccountLamports: curve.lamports,
    rentExemptLamports: a.curveRentFloor,
  });
  if (!q.ok) return notSent('build', describeQuoteError(q.error));
  const minLamportsOut = applySlippage(q.value.lamportsOut, a.slippageBps);
  if (minLamportsOut === null || minLamportsOut <= 0n) return notSent('build', 'That amount is too small to protect with a price limit.');
  const quote = q.value;

  const ata = associatedTokenAddress(a.mint, a.trader);
  const body = [
    sellIx(
      { trader: a.trader, mint: a.mint, feeRecipient: gate.global.feeRecipient, creator: curve.curve.creator },
      a.tokensIn,
      minLamportsOut,
      { programId: gate.cfg.programId, cpSwapProgram: gate.cfg.cpSwapProgram },
    ),
  ];

  return buildAndSimulate(rpc, {
    kind: 'sell',
    body,
    extraSigners: [],
    intent: ctxFor(gate, a.trader, a.mint, curve),
    watch: { signer: a.trader, tokenAccounts: [{ account: ata, mint: a.mint }] },
    expect: () => ({
      maxSolOut: 0n,
      minSolIn: minLamportsOut,
      tokens: [{ account: ata, mint: a.mint, minDelta: -a.tokensIn, maxDelta: -a.tokensIn }],
    }),
    newAccountRent: () => 0n,
    summarize: (steps): TxSummary | string => {
      const sell = bodySteps(steps).find((s) => s.kind === 'curve-sell');
      if (!sell || sell.kind !== 'curve-sell') return 'The sell is missing from the transaction.';
      if (sell.tokensIn !== a.tokensIn || sell.minLamportsOut !== minLamportsOut) {
        return 'The sell in the transaction does not match the quote.';
      }
      return {
        kind: 'sell',
        mint: a.mint,
        tokensIn: sell.tokensIn,
        minLamportsOut: sell.minLamportsOut,
        quote,
        priceImpactBps: priceImpactBps(curve.curve, 'sell', a.tokensIn, quote.grossLamports),
        feeSplit: feeSplit(quote.feeLamports, curve.curve.creatorFeeShareBps),
      };
    },
  });
}
