// Does Jupiter's trade for this quote really carry the site fee? Asked once, at Review,
// before one of our own pools is allowed to beat Jupiter's number.
//
// WHY. Our pool is ranked against Jupiter's amount AFTER the 0.5% site fee
// (lib/jupiter.ts jupiterNet), and the review says so. But on some routes Jupiter's own
// program refuses a swap that carries the fee (custom error 6014; today: buying BAYLA
// with SOL). On those routes the site sends the same trade with NO fee
// (./jupiterFeeRetry.ts), which pays the trader about 0.5% more than the fee-bearing
// quote says. Ranking our pool against the fee-bearing number there would pick our pool
// while Jupiter would in fact have paid more, and "after the same fee" would be untrue.
//
// A quote cannot tell: the fee-bearing quote prices fine, and the refusal only shows
// when the transaction is simulated. So this builds Jupiter's fee-bearing transaction
// for the quote and simulates it, exactly as the Jupiter send path's first step does,
// and answers one of three things. Nothing is signed and nothing is sent.
//
//   'charged'   the fee-bearing transaction simulates clean: Jupiter's trade carries the
//               fee, and the comparison is like for like.
//   'waived'    it fails with exactly Jupiter's own 6014 and the fee was attached: the
//               Jupiter trade that would go out is the no-fee one.
//   'unchecked' anything else: no fee is attached on this pair, the build or the
//               simulation could not be run, or it fails for another reason.
//
// Only 'charged' lets our pool compete (the builder, routeSwap.ts step 1). Unread is
// never treated as charged.
import type { BuildSwapParams, BuiltSwap, JupiterQuote, PriorityLevel, SwapSimulation } from '../../jupiter';

export type JupiterFeeProof = 'charged' | 'waived' | 'unchecked';

export interface JupiterFeeProbeDeps {
  /** lib/jupiter.ts buildSwapWithExpiry. */
  buildSwapTransaction(params: BuildSwapParams): Promise<BuiltSwap>;
  /** lib/jupiter.ts simulateSwap. A throw means "could not be simulated". */
  simulateSwap(b64Tx: string): Promise<SwapSimulation>;
  /** lib/jupiter.ts swapCarriesPlatformFee: would the build attach the fee on this pair? */
  swapCarriesPlatformFee(inputMint: string, outputMint: string): boolean;
}

export async function probeJupiterFee(
  deps: JupiterFeeProbeDeps,
  a: {
    /** The fresh, fee-bearing quote whose number our pool is about to be ranked against. */
    quote: JupiterQuote;
    inputMint: string;
    outputMint: string;
    user: string;
    priority?: PriorityLevel;
  },
): Promise<JupiterFeeProof> {
  if (!deps.swapCarriesPlatformFee(a.inputMint, a.outputMint)) return 'unchecked';
  let sim: SwapSimulation;
  try {
    const built = await deps.buildSwapTransaction({ quote: a.quote, userPublicKey: a.user, priorityLevel: a.priority });
    sim = await deps.simulateSwap(built.swapTransaction);
  } catch {
    return 'unchecked';
  }
  if (sim === null || typeof sim !== 'object') return 'unchecked';
  if (sim.ok === true) return 'charged';
  return sim.jupiterIncorrectTokenProgram === true ? 'waived' : 'unchecked';
}
