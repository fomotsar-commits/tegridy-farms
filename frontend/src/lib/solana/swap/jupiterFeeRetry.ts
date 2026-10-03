// The Jupiter swap's build-and-simulate step, with ONE narrow retry.
//
// WHY THIS EXISTS (live bug, 2026-10-03). Buying BAYLA with SOL builds a swap
// with the 0.5% platform fee on the SOL side. On BAYLA's only route (Pump.fun
// AMM) Jupiter's own program then reverts with custom error 6014
// (IncorrectTokenProgramID), so the pre-sign simulation blocked every such buy.
// The same trade with no platform fee simulates fine.
//
// THE RULE (owner decision 2026-10-02, "retry now, BAYLA fee after"):
//   - the fee-bearing transaction is always built and simulated first;
//   - ONLY when that simulation fails with exactly Jupiter's 6014, raised by the
//     Jupiter program (lib/jupiter.ts isJupiterIncorrectTokenProgram), the SAME
//     trade is quoted once more with no platform fee and no fee account,
//     rebuilt, and put through the SAME simulation;
//   - only a retry whose simulation PASSES may reach the wallet. A retry that
//     fails, cannot be read, or comes back as a different or worse trade is
//     blocked. There is never a second retry.
// Nothing else opens the retry: not a URL, not a token name, not a route label,
// not "any simulation failure".
//
// No React and no wallet in here, so every branch is unit-testable. The later
// lib/solana/swap/jupiterSend.ts (SPEC_S3 step S1) is expected to call this for
// its build and simulate steps.
import {
  quoteHasPlatformFee,
  type JupiterQuote,
  type PriorityLevel,
  type SwapSimulation,
} from '../../jupiter';

/** Said before signing and in the result whenever the retry is the trade that goes out. */
export const NO_SITE_FEE_ROUTE_COPY = 'No site fee on this route: the fee cannot be taken on it yet.';

export interface FeeRetryDeps {
  getQuote(params: {
    inputMint: string;
    outputMint: string;
    amount: string;
    slippageBps: number;
    noPlatformFee?: boolean;
  }): Promise<JupiterQuote>;
  buildSwapTransaction(params: {
    quote: JupiterQuote;
    userPublicKey: string;
    priorityLevel?: PriorityLevel;
    noPlatformFee?: boolean;
  }): Promise<string>;
  simulateSwap(b64Tx: string): Promise<SwapSimulation>;
  /** Was the first build fee-bearing? (lib/jupiter.ts swapCarriesPlatformFee.) */
  swapCarriesPlatformFee(inputMint: string, outputMint: string): boolean;
}

export type PreparedJupiterSwap =
  /** Hand `swapTransaction` to the wallet. `quote` is the one it was built from: show ITS amounts. */
  | { status: 'ready'; quote: JupiterQuote; swapTransaction: string; siteFeeWaived: boolean }
  /** Nothing may be signed. `reason` is the simulation's own words when it has any. */
  | { status: 'blocked'; reason: string | null; retried: boolean }
  /** The no-fee re-quote pays less than the fee-bearing one beyond the slippage: not silently sent. */
  | { status: 'moved'; quote: JupiterQuote };

function parseAmount(raw: unknown): bigint | null {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null;
  return BigInt(raw);
}

export async function prepareJupiterSwap(
  deps: FeeRetryDeps,
  a: {
    /** The fresh, fee-bearing (where the pair supports it) quote the send path just took. */
    fresh: JupiterQuote;
    /** The quote the trader clicked on. */
    shown: JupiterQuote;
    inputMint: string;
    outputMint: string;
    /** Input amount in base units: the trade being asked for. */
    amount: string;
    slippageBps: number;
    user: string;
    priority?: PriorityLevel;
  },
): Promise<PreparedJupiterSwap> {
  const first = await deps.buildSwapTransaction({ quote: a.fresh, userPublicKey: a.user, priorityLevel: a.priority });

  let sim: SwapSimulation;
  try {
    sim = await deps.simulateSwap(first);
  } catch {
    // Unchanged from before the retry existed: an unreadable FIRST simulation
    // still goes to the wallet. (SPEC_S3 S1 turns this into fail-closed.)
    return { status: 'ready', quote: a.fresh, swapTransaction: first, siteFeeWaived: false };
  }
  if (sim.ok) return { status: 'ready', quote: a.fresh, swapTransaction: first, siteFeeWaived: false };

  // The one door. Both halves are facts about the transaction this code built
  // and the error the chain returned for it.
  const feeWasAttached = deps.swapCarriesPlatformFee(a.inputMint, a.outputMint);
  if (!sim.jupiterIncorrectTokenProgram || !feeWasAttached) {
    return { status: 'blocked', reason: sim.reason, retried: false };
  }

  // ONE retry. From here every doubt is a block: the trader has not agreed to
  // anything but the trade they clicked, minus a fee.
  const blocked: PreparedJupiterSwap = { status: 'blocked', reason: sim.reason, retried: true };
  let retried: JupiterQuote;
  try {
    retried = await deps.getQuote({
      inputMint: a.inputMint,
      outputMint: a.outputMint,
      amount: a.amount,
      slippageBps: a.slippageBps,
      noPlatformFee: true,
    });
  } catch {
    return blocked;
  }
  // The SAME trade, and really fee-free, by Jupiter's own fields.
  if (
    retried.inputMint !== a.inputMint ||
    retried.outputMint !== a.outputMint ||
    retried.inAmount !== a.amount ||
    retried.swapMode !== 'ExactIn' ||
    retried.slippageBps !== a.slippageBps ||
    quoteHasPlatformFee(retried)
  ) {
    return blocked;
  }
  // Dropping a 0.5% fee pays the trader slightly MORE. If the re-quote instead
  // pays less than the better of (what they clicked, the fee-bearing fresh
  // quote) by more than their own slippage, the market moved: show it, do not
  // send it. Unreadable amounts block.
  const retriedOut = parseAmount(retried.outAmount);
  const freshOut = parseAmount(a.fresh.outAmount);
  const shownOut = parseAmount(a.shown.outAmount);
  const retriedMin = parseAmount(retried.otherAmountThreshold);
  if (retriedOut === null || freshOut === null || shownOut === null || retriedMin === null) return blocked;
  if (!Number.isInteger(a.slippageBps) || a.slippageBps < 0 || a.slippageBps > 10_000) return blocked;
  const reference = freshOut > shownOut ? freshOut : shownOut;
  const floor = reference - (reference * BigInt(a.slippageBps)) / 10_000n;
  if (retriedOut < floor) return { status: 'moved', quote: retried };

  let second: string;
  try {
    second = await deps.buildSwapTransaction({
      quote: retried,
      userPublicKey: a.user,
      priorityLevel: a.priority,
      noPlatformFee: true,
    });
  } catch {
    return blocked;
  }
  let sim2: SwapSimulation;
  try {
    sim2 = await deps.simulateSwap(second);
  } catch {
    // The retry is never sent unsimulated.
    return { status: 'blocked', reason: 'The no-fee rebuild could not be simulated.', retried: true };
  }
  if (!sim2.ok) return { status: 'blocked', reason: sim2.reason ?? sim.reason, retried: true };
  return { status: 'ready', quote: retried, swapTransaction: second, siteFeeWaived: true };
}
