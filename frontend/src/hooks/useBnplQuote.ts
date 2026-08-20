import { useMemo } from 'react';

// The total cost of credit for a financed purchase, computed in the browser.
//
// WHY THIS EXISTS AT ALL, given the desk has an on-chain `quote`: the desk is
// deployed nowhere, so there is nothing to call. A buyer looking at the surface
// today still deserves to see what instalments would cost against the posted
// terms, and the only honest way to show that is to compute it from numbers the
// surface names out loud and to label the result as what it is.
//
// This mirrors `NftfiBnpl.quote` in
// contracts/src/nftfi/NftfiBnpl.sol — same straight-line amortisation, same
// simple-interest formula, same integer division. Two implementations of one
// piece of money arithmetic is a liability, so `bnplQuote` is pinned against
// the contract's own numbers in useBnplQuote.test.ts. When the desk is
// deployed, this becomes the pre-flight estimate and the CONTRACT's `quote`
// becomes what a buyer signs against.
//
// It is an estimate of a FUTURE cost either way. Interest accrues against
// elapsed time, not against the schedule, so a buyer who pays late pays more
// than this and one who pays early pays less. No surface may round that away.

const BPS = 10_000n;
const YEAR_SECONDS = 365n * 24n * 60n * 60n;

export interface BnplTerms {
  /** Share of the price paid up front, in bps. */
  depositBps: number;
  /** The pool's APR on the financed leg, in bps. */
  aprBps: number;
  /** The pool's origination fee, in bps of the financed leg. */
  originationFeeBps: number;
  /** How many payments follow the deposit. */
  instalments: number;
  /** Seconds between payments. */
  instalmentIntervalSeconds: number;
}

export interface BnplQuote {
  depositWei: bigint;
  financedWei: bigint;
  originationWei: bigint;
  /** Interest across the whole schedule, if every payment lands on its due date. */
  interestWei: bigint;
  /** Everything the buyer pays: deposit + origination + principal + interest. */
  totalWei: bigint;
  /** What one instalment costs, principal plus that leg's interest. */
  instalmentsWei: bigint[];
  /**
   * Cost of credit over the sticker price, in bps of the price. This is the
   * number a buyer compares against another lender; it is NOT an APR and must
   * never be labelled as one.
   */
  costOfCreditBps: number;
}

/**
 * Pure, so it can be tested against the contract's arithmetic without a chain.
 *
 * Returns null for terms that cannot produce a schedule (no instalments, zero
 * price), because a quote of zero and a quote that does not exist are different
 * things and only one of them is safe to render.
 */
export function bnplQuote(priceWei: bigint, terms: BnplTerms): BnplQuote | null {
  if (priceWei <= 0n) return null;
  if (terms.instalments <= 0) return null;
  if (terms.instalmentIntervalSeconds <= 0) return null;
  if (terms.depositBps < 0 || terms.depositBps >= 10_000) return null;
  if (terms.aprBps < 0 || terms.originationFeeBps < 0) return null;

  const n = BigInt(terms.instalments);
  const interval = BigInt(terms.instalmentIntervalSeconds);
  const apr = BigInt(terms.aprBps);

  const depositWei = (priceWei * BigInt(terms.depositBps)) / BPS;
  const financedWei = priceWei - depositWei;
  const originationWei = (financedWei * BigInt(terms.originationFeeBps)) / BPS;

  const slice = financedWei / n;
  const instalmentsWei: bigint[] = [];
  let interestWei = 0n;
  for (let k = 1n; k <= n; k++) {
    const principalLeg = k === n ? financedWei - slice * (n - 1n) : slice;
    const legInterest = (principalLeg * apr * (k * interval)) / (YEAR_SECONDS * BPS);
    interestWei += legInterest;
    instalmentsWei.push(principalLeg + legInterest);
  }

  const totalWei = depositWei + originationWei + financedWei + interestWei;
  const costOfCreditBps = Number(((originationWei + interestWei) * BPS) / priceWei);

  return { depositWei, financedWei, originationWei, interestWei, totalWei, instalmentsWei, costOfCreditBps };
}

/**
 * Hook wrapper. `null` in, `null` out — a surface with no price to quote must
 * render an absence, never a zeroed schedule.
 */
export function useBnplQuote(priceWei: bigint | null, terms: BnplTerms): BnplQuote | null {
  const key = priceWei === null ? null : priceWei.toString();
  const { depositBps, aprBps, originationFeeBps, instalments, instalmentIntervalSeconds } = terms;
  return useMemo(
    () =>
      key === null
        ? null
        : bnplQuote(BigInt(key), {
            depositBps,
            aprBps,
            originationFeeBps,
            instalments,
            instalmentIntervalSeconds,
          }),
    [key, depositBps, aprBps, originationFeeBps, instalments, instalmentIntervalSeconds],
  );
}
