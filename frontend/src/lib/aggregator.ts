// SwapAPI.dev — free DEX aggregator, no API key needed
// Docs: https://swapapi.dev

const SWAP_API_BASE = 'https://api.swapapi.dev/v1';
const CHAIN_ID = 1; // Ethereum mainnet

// Native ETH address convention used by SwapAPI
const NATIVE_ADDRESS = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

export interface AggregatorQuote {
  tokenIn: { address: string; symbol: string; decimals: number };
  tokenOut: { address: string; symbol: string; decimals: number };
  amountIn: string;
  amountOut: string;
  price: string;
  priceImpact: number;
  tx: {
    to: string;
    data: string;
    value: string;
    gas: string;
  };
}

// Get a swap quote with executable calldata
export async function getAggregatorQuote(
  tokenIn: string,
  tokenOut: string,
  amount: string, // in wei/smallest unit
  sender: string,
  maxSlippage: number = 0.05, // 5%
): Promise<AggregatorQuote | null> {
  try {
    // Use native address convention for ETH
    const sellToken = tokenIn.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' || tokenIn === 'ETH'
      ? NATIVE_ADDRESS : tokenIn;
    const buyToken = tokenOut.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' || tokenOut === 'ETH'
      ? NATIVE_ADDRESS : tokenOut;

    const params = new URLSearchParams({
      tokenIn: sellToken,
      tokenOut: buyToken,
      amount,
      sender,
      maxSlippage: String(maxSlippage),
    });

    const res = await fetch(`${SWAP_API_BASE}/swap/${CHAIN_ID}?${params}`);
    if (!res.ok) return null;

    const data = await res.json();

    // Validate critical fields to prevent injection from a compromised API
    if (
      !data ||
      typeof data.amountOut !== 'string' ||
      !/^\d+$/.test(data.amountOut) ||
      typeof data.priceImpact !== 'number' ||
      !Number.isFinite(data.priceImpact)
    ) {
      return null;
    }

    return data;
  } catch {
    return null;
  }
}

// Get just a price quote (lighter — no tx data needed)
export async function getAggregatorPrice(
  tokenIn: string,
  tokenOut: string,
  amount: string,
  sender: string,
): Promise<{ amountOut: string; priceImpact: number } | null> {
  const quote = await getAggregatorQuote(tokenIn, tokenOut, amount, sender);
  if (!quote) return null;
  return {
    amountOut: quote.amountOut,
    priceImpact: quote.priceImpact,
  };
}

// Aggregator is always available — no API key needed
export function isAggregatorEnabled(): boolean {
  return true;
}

// ─── Aggregator Revenue Capture ──────────────────────────────────────
// Pattern: 1inch/Paraswap positive slippage capture.
// When aggregator finds a better rate than direct Uniswap, capture a portion
// of the improvement as protocol revenue. User ALWAYS gets more than direct Uniswap.

// Minimum improvement required before capturing any spread (0.5% = 50 bps)
export const AGGREGATOR_IMPROVEMENT_THRESHOLD_BPS = 50;
// Portion of improvement captured by protocol (50% = 5000 of 10000)
export const AGGREGATOR_CAPTURE_BPS = 5000;
const BPS = 10000;

export interface AggregatorSpread {
  /** The improvement from aggregator vs direct (in output token units) */
  improvement: bigint;
  /** Amount captured as protocol revenue */
  protocolCapture: bigint;
  /** Amount the user actually receives (always > uniswapOutput) */
  userReceives: bigint;
  /** User's savings vs direct swap in basis points */
  userSavingsBps: number;
  /** Whether the aggregator route is worth using (above threshold) */
  shouldUseAggregator: boolean;
}

/**
 * Calculate the aggregator spread between direct Uniswap output and aggregator output.
 *
 * Hard invariant: userReceives > uniswapOutput — ALWAYS.
 * If violated, returns shouldUseAggregator = false.
 *
 * @param uniswapOutput - Output amount from direct Uniswap V2 swap
 * @param aggregatorOutput - Output amount from aggregator (SwapAPI)
 * @param captureBps - Protocol capture rate (default: AGGREGATOR_CAPTURE_BPS)
 */
export function calculateAggregatorSpread(
  uniswapOutput: bigint,
  aggregatorOutput: bigint,
  captureBps: number = AGGREGATOR_CAPTURE_BPS,
): AggregatorSpread {
  // No improvement or aggregator worse
  if (aggregatorOutput <= uniswapOutput || uniswapOutput === 0n) {
    return {
      improvement: 0n,
      protocolCapture: 0n,
      userReceives: uniswapOutput,
      userSavingsBps: 0,
      shouldUseAggregator: false,
    };
  }

  const improvement = aggregatorOutput - uniswapOutput;
  const improvementBps = Number((improvement * BigInt(BPS)) / uniswapOutput);

  // Below threshold — don't capture, pass full aggregator output to user
  if (improvementBps < AGGREGATOR_IMPROVEMENT_THRESHOLD_BPS) {
    return {
      improvement,
      protocolCapture: 0n,
      userReceives: aggregatorOutput,
      userSavingsBps: improvementBps,
      shouldUseAggregator: true, // Still use aggregator, just don't capture
    };
  }

  // Above threshold — capture a portion of the improvement
  const protocolCapture = (improvement * BigInt(captureBps)) / BigInt(BPS);
  const userReceives = aggregatorOutput - protocolCapture;

  // Hard invariant: user must ALWAYS get more than direct Uniswap
  if (userReceives <= uniswapOutput) {
    // Safety fallback — give user full aggregator output, no capture
    return {
      improvement,
      protocolCapture: 0n,
      userReceives: aggregatorOutput,
      userSavingsBps: improvementBps,
      shouldUseAggregator: true,
    };
  }

  const userSavingsBps = Number(((userReceives - uniswapOutput) * BigInt(BPS)) / uniswapOutput);

  return {
    improvement,
    protocolCapture,
    userReceives,
    userSavingsBps,
    shouldUseAggregator: true,
  };
}
