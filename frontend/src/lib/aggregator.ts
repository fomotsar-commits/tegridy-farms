// Meta-aggregator: queries multiple DEX aggregators in parallel, picks best quote
// Pattern: DefiLlama-style "aggregator of aggregators"
// All APIs are free with no API key required.

const CHAIN_ID = 1; // Ethereum mainnet
const NATIVE_ADDRESS = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';

// Normalize ETH address conventions across aggregators
function normalizeTokenAddress(addr: string, style: 'native' | 'weth' | 'zero'): string {
  const lower = addr.toLowerCase();
  const isNative = lower === NATIVE_ADDRESS.toLowerCase() || lower === 'eth' || lower === '0x0000000000000000000000000000000000000000';
  if (!isNative) return addr;
  switch (style) {
    case 'native': return NATIVE_ADDRESS;
    case 'weth': return WETH;
    case 'zero': return '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
  }
}

// ─── Aggregator Source Types ────────────────────────────────────

export type AggregatorSource = 'swapapi' | 'odos' | 'cowswap' | 'lifi' | 'kyberswap' | 'openocean' | 'paraswap';

export interface AggregatorQuote {
  source: AggregatorSource;
  amountOut: string; // in smallest unit (wei)
  priceImpact: number;
  estimatedGas?: string;
}

// ─── SwapAPI.dev ────────────────────────────────────────────────
// Free, no API key needed

async function getSwapApiQuote(
  tokenIn: string, tokenOut: string, amount: string, sender: string,
): Promise<AggregatorQuote | null> {
  try {
    const sellToken = normalizeTokenAddress(tokenIn, 'native');
    const buyToken = normalizeTokenAddress(tokenOut, 'native');
    const params = new URLSearchParams({
      tokenIn: sellToken, tokenOut: buyToken,
      amount, sender, maxSlippage: '0.05',
    });
    const res = await fetch(`https://api.swapapi.dev/v1/swap/${CHAIN_ID}?${params}`);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || typeof data.amountOut !== 'string' || !/^\d+$/.test(data.amountOut) ||
        typeof data.priceImpact !== 'number' || !Number.isFinite(data.priceImpact)) {
      return null;
    }
    return { source: 'swapapi', amountOut: data.amountOut, priceImpact: data.priceImpact, estimatedGas: data.tx?.gas };
  } catch { return null; }
}

// ─── Odos ───────────────────────────────────────────────────────
// Free public API, no API key needed
// Docs: https://docs.odos.xyz

async function getOdosQuote(
  tokenIn: string, tokenOut: string, amount: string, sender: string,
): Promise<AggregatorQuote | null> {
  try {
    const inAddr = normalizeTokenAddress(tokenIn, 'zero');
    const outAddr = normalizeTokenAddress(tokenOut, 'zero');
    const body = {
      chainId: CHAIN_ID,
      inputTokens: [{ tokenAddress: inAddr, amount }],
      outputTokens: [{ tokenAddress: outAddr, proportion: 1 }],
      userAddr: sender,
      slippageLimitPercent: 0.5,
      disableRFQs: true,
      compact: true,
    };
    const res = await fetch('/api/odos/sor/quote/v2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const outAmount = data?.outAmounts?.[0];
    if (!outAmount || !/^\d+$/.test(String(outAmount))) return null;
    const priceImpact = typeof data.priceImpact === 'number' ? data.priceImpact : 0;
    return {
      source: 'odos',
      amountOut: String(outAmount),
      priceImpact: Math.abs(priceImpact),
      estimatedGas: data.gasEstimate ? String(data.gasEstimate) : undefined,
    };
  } catch { return null; }
}

// ─── CowSwap / CoW Protocol ────────────────────────────────────
// Free public API, no API key needed (MEV-protected)
// Docs: https://api.cow.fi/docs

async function getCowSwapQuote(
  tokenIn: string, tokenOut: string, amount: string, sender: string,
): Promise<AggregatorQuote | null> {
  try {
    // CowSwap uses WETH address, not native ETH
    const sellToken = normalizeTokenAddress(tokenIn, 'weth');
    const buyToken = normalizeTokenAddress(tokenOut, 'weth');
    const body = {
      sellToken, buyToken,
      from: sender,
      receiver: sender,
      sellAmountBeforeFee: amount,
      kind: 'sell',
      signingScheme: 'eip712',
      onchainOrder: false,
      priceQuality: 'fast',
    };
    const res = await fetch('/api/cow/mainnet/api/v1/quote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const buyAmount = data?.quote?.buyAmount;
    if (!buyAmount || !/^\d+$/.test(String(buyAmount))) return null;
    return {
      source: 'cowswap',
      amountOut: String(buyAmount),
      priceImpact: 0, // CowSwap doesn't report price impact in quotes
    };
  } catch { return null; }
}

// ─── Li.Fi ──────────────────────────────────────────────────────
// Free without API key (200 quotes per 2 hours)
// Docs: https://docs.li.fi

async function getLiFiQuote(
  tokenIn: string, tokenOut: string, amount: string, sender: string,
): Promise<AggregatorQuote | null> {
  try {
    const fromToken = normalizeTokenAddress(tokenIn, 'native');
    const toToken = normalizeTokenAddress(tokenOut, 'native');
    const params = new URLSearchParams({
      fromChain: String(CHAIN_ID),
      toChain: String(CHAIN_ID),
      fromToken, toToken,
      fromAmount: amount,
      fromAddress: sender,
    });
    const res = await fetch(`/api/lifi/v1/quote?${params}`);
    if (!res.ok) return null;
    const data = await res.json();
    const toAmount = data?.estimate?.toAmount;
    if (!toAmount || !/^\d+$/.test(String(toAmount))) return null;
    return {
      source: 'lifi',
      amountOut: String(toAmount),
      priceImpact: 0,
      estimatedGas: data?.estimate?.gasCosts?.[0]?.estimate,
    };
  } catch { return null; }
}

// ─── KyberSwap ──────────────────────────────────────────────────
// Free, no API key needed (10 req/10s default)
// Docs: https://docs.kyberswap.com

async function getKyberSwapQuote(
  tokenIn: string, tokenOut: string, amount: string, _sender: string,
): Promise<AggregatorQuote | null> {
  try {
    const inAddr = normalizeTokenAddress(tokenIn, 'native');
    const outAddr = normalizeTokenAddress(tokenOut, 'native');
    const params = new URLSearchParams({
      tokenIn: inAddr, tokenOut: outAddr, amountIn: amount,
    });
    const res = await fetch(`/api/kyber/ethereum/api/v1/routes?${params}`, {
      headers: { 'X-Client-Id': 'tegridy-farms' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const amountOut = data?.data?.routeSummary?.amountOut;
    if (!amountOut || !/^\d+$/.test(String(amountOut))) return null;
    return {
      source: 'kyberswap',
      amountOut: String(amountOut),
      priceImpact: 0,
      estimatedGas: data?.data?.routeSummary?.gas ? String(data.data.routeSummary.gas) : undefined,
    };
  } catch { return null; }
}

// ─── OpenOcean ──────────────────────────────────────────────────
// Free, no API key needed
// Docs: https://docs.openocean.finance

async function getOpenOceanQuote(
  tokenIn: string, tokenOut: string, amount: string, _sender: string, fromDecimals: number = 18,
): Promise<AggregatorQuote | null> {
  try {
    const inAddr = normalizeTokenAddress(tokenIn, 'native');
    const outAddr = normalizeTokenAddress(tokenOut, 'native');
    // OpenOcean expects human-readable amount (e.g. "0.001"), not wei/smallest unit
    // Use BigInt division to avoid Number() precision loss on large amounts
    const bi = BigInt(amount);
    const divisor = BigInt(10 ** fromDecimals);
    const whole = bi / divisor;
    const frac = bi % divisor;
    const humanAmount = whole.toString() + '.' + frac.toString().padStart(fromDecimals, '0').slice(0, 6);
    const params = new URLSearchParams({
      inTokenAddress: inAddr, outTokenAddress: outAddr,
      amount: humanAmount, gasPrice: '5',
    });
    const res = await fetch(`/api/openocean/v4/eth/quote?${params}`);
    if (!res.ok) return null;
    const data = await res.json();
    const outAmount = data?.data?.outAmount;
    if (!outAmount || !/^\d+$/.test(String(outAmount))) return null;
    return {
      source: 'openocean',
      amountOut: String(outAmount),
      priceImpact: typeof data?.data?.price_impact === 'string' ? Math.abs(parseFloat(data.data.price_impact)) : 0,
      estimatedGas: data?.data?.estimatedGas ? String(data.data.estimatedGas) : undefined,
    };
  } catch { return null; }
}

// ─── ParaSwap ───────────────────────────────────────────────────
// Free, no API key needed
// Docs: https://developers.velora.xyz

async function getParaSwapQuote(
  tokenIn: string, tokenOut: string, amount: string, _sender: string,
): Promise<AggregatorQuote | null> {
  try {
    const srcToken = normalizeTokenAddress(tokenIn, 'native');
    const destToken = normalizeTokenAddress(tokenOut, 'native');
    const params = new URLSearchParams({
      srcToken, destToken, amount,
      side: 'SELL', network: String(CHAIN_ID),
    });
    const res = await fetch(`/api/paraswap/prices?${params}`);
    if (!res.ok) return null;
    const data = await res.json();
    const destAmount = data?.priceRoute?.destAmount;
    if (!destAmount || !/^\d+$/.test(String(destAmount))) return null;
    return {
      source: 'paraswap',
      amountOut: String(destAmount),
      priceImpact: 0,
      estimatedGas: data?.priceRoute?.gasCost ? String(data.priceRoute.gasCost) : undefined,
    };
  } catch { return null; }
}

// ─── Meta-Aggregator: query all sources in parallel ─────────────

export interface MetaAggregatorResult {
  /** The best quote across all aggregators (highest amountOut) */
  best: AggregatorQuote | null;
  /** All successful quotes, sorted by amountOut descending */
  allQuotes: AggregatorQuote[];
}

export async function getMetaAggregatorQuotes(
  tokenIn: string,
  tokenOut: string,
  amount: string,
  sender: string,
  fromDecimals: number = 18,
): Promise<MetaAggregatorResult> {
  const results = await Promise.allSettled([
    getSwapApiQuote(tokenIn, tokenOut, amount, sender),
    getOdosQuote(tokenIn, tokenOut, amount, sender),
    getCowSwapQuote(tokenIn, tokenOut, amount, sender),
    getLiFiQuote(tokenIn, tokenOut, amount, sender),
    getKyberSwapQuote(tokenIn, tokenOut, amount, sender),
    getOpenOceanQuote(tokenIn, tokenOut, amount, sender, fromDecimals),
    getParaSwapQuote(tokenIn, tokenOut, amount, sender),
  ]);

  const quotes: AggregatorQuote[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) {
      quotes.push(r.value);
    }
  }

  // Sort by amountOut descending (best first)
  quotes.sort((a, b) => {
    const aOut = BigInt(a.amountOut);
    const bOut = BigInt(b.amountOut);
    if (aOut > bOut) return -1;
    if (aOut < bOut) return 1;
    return 0;
  });

  return {
    best: quotes[0] ?? null,
    allQuotes: quotes,
  };
}

// ─── Backwards-compatible single-quote function ─────────────────
// Used by useSwap.ts for the aggregator price check

export async function getAggregatorPrice(
  tokenIn: string,
  tokenOut: string,
  amount: string,
  sender: string,
  fromDecimals: number = 18,
): Promise<{ amountOut: string; priceImpact: number; source: AggregatorSource; allQuotes: AggregatorQuote[] } | null> {
  const result = await getMetaAggregatorQuotes(tokenIn, tokenOut, amount, sender, fromDecimals);
  if (!result.best) return null;
  return {
    amountOut: result.best.amountOut,
    priceImpact: result.best.priceImpact,
    source: result.best.source,
    allQuotes: result.allQuotes,
  };
}

// Aggregator is always available — no API key needed
export function isAggregatorEnabled(): boolean {
  return true;
}

// ─── Aggregator Revenue Capture ──────────────────────────────────────
// Pattern: 1inch/Paraswap positive slippage capture.
// When aggregator finds a better rate than direct on-chain, capture a portion
// of the improvement as protocol revenue. User ALWAYS gets more than direct.

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
  /** Amount the user actually receives (always > onChainOutput) */
  userReceives: bigint;
  /** User's savings vs direct swap in basis points */
  userSavingsBps: number;
  /** Whether the aggregator route is worth using (above threshold) */
  shouldUseAggregator: boolean;
}

/**
 * Calculate the aggregator spread between direct on-chain output and aggregator output.
 *
 * Hard invariant: userReceives > onChainOutput — ALWAYS.
 * If violated, returns shouldUseAggregator = false.
 */
export function calculateAggregatorSpread(
  onChainOutput: bigint,
  aggregatorOutput: bigint,
  captureBps: number = AGGREGATOR_CAPTURE_BPS,
): AggregatorSpread {
  // No improvement or aggregator worse
  if (aggregatorOutput <= onChainOutput || onChainOutput === 0n) {
    return {
      improvement: 0n,
      protocolCapture: 0n,
      userReceives: onChainOutput,
      userSavingsBps: 0,
      shouldUseAggregator: false,
    };
  }

  const improvement = aggregatorOutput - onChainOutput;
  const improvementBps = Number((improvement * BigInt(BPS)) / onChainOutput);

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

  // Hard invariant: user must ALWAYS get more than direct on-chain
  if (userReceives <= onChainOutput) {
    // Safety fallback — give user full aggregator output, no capture
    return {
      improvement,
      protocolCapture: 0n,
      userReceives: aggregatorOutput,
      userSavingsBps: improvementBps,
      shouldUseAggregator: true,
    };
  }

  const userSavingsBps = Number(((userReceives - onChainOutput) * BigInt(BPS)) / onChainOutput);

  return {
    improvement,
    protocolCapture,
    userReceives,
    userSavingsBps,
    shouldUseAggregator: true,
  };
}

// ─── Display name mapping ───────────────────────────────────────

export const AGGREGATOR_NAMES: Record<AggregatorSource, string> = {
  swapapi: 'SwapAPI',
  odos: 'Odos',
  cowswap: 'CowSwap',
  lifi: 'Li.Fi',
  kyberswap: 'KyberSwap',
  openocean: 'OpenOcean',
  paraswap: 'ParaSwap',
};
