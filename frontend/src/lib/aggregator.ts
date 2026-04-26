// Meta-aggregator: queries multiple DEX aggregators in parallel, picks best quote
// Pattern: DefiLlama-style "aggregator of aggregators"
// All APIs are free with no API key required.

// AUDIT R045 H1: aggregator was hard-coded to chainId 1 (Ethereum mainnet). On
// any other chain the wallet would still display "best route" results from
// mainnet token addresses, biasing UI to fictional liquidity. Renamed the
// constant to make the meaning explicit (the chain this codebase has wired
// contracts for) and now require an explicit `chainId` argument from callers.
// The meta-aggregator short-circuits with an empty result when chainId is
// unsupported, so no aggregator HTTP calls go out for an L2 wallet.
export const SUPPORTED_CHAIN_ID = 1;

// AUDIT R045 M1: every aggregator that takes a slippage param had a different
// hard-coded value (SwapAPI 5%, Odos 0.5%, Li.Fi omitted, Kyber/OO/PS quote-time
// implicit). That biased "best quote" rankings since looser slippage tolerates
// more inferior fills at execution time. Now uniform default 0.5% clamped to
// [0.05, 50]% and propagated to every aggregator that accepts it at quote time.
export const DEFAULT_MAX_SLIPPAGE_PCT = 0.5;
const MIN_SLIPPAGE_PCT = 0.05;
const MAX_SLIPPAGE_PCT = 50;
function clampSlippage(pct: number | undefined): number {
  const v = typeof pct === 'number' && Number.isFinite(pct) ? pct : DEFAULT_MAX_SLIPPAGE_PCT;
  return Math.max(MIN_SLIPPAGE_PCT, Math.min(MAX_SLIPPAGE_PCT, v));
}

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
  /** AUDIT R045 H1: chain the quote was fetched against; defense-in-depth filter. */
  chainId: number;
  /**
   * AUDIT R045 M1: the slippage tolerance the quote was fetched with.
   *  - number: forwarded to the aggregator at quote time
   *  - null:   aggregator does not accept slippage at quote time (CowSwap,
   *            Kyber routes, OpenOcean /quote, ParaSwap /prices). Slippage is
   *            consumed at signing/build time instead, and the quoted
   *            `amountOut` is unaffected, so ranking stays apples-to-apples.
   */
  maxSlippagePct: number | null;
}

interface QuoteCallOpts {
  chainId: number;
  slippagePct: number;
  fromDecimals?: number;
  signal?: AbortSignal;
}

// ─── SwapAPI.dev ────────────────────────────────────────────────
// Free, no API key needed. SwapAPI accepts slippage as a fraction.

async function getSwapApiQuote(
  tokenIn: string, tokenOut: string, amount: string, sender: string, opts: QuoteCallOpts,
): Promise<AggregatorQuote | null> {
  try {
    const sellToken = normalizeTokenAddress(tokenIn, 'native');
    const buyToken = normalizeTokenAddress(tokenOut, 'native');
    // AUDIT R045 M1: was hard-coded `0.05` (5%, an order of magnitude looser
    // than the others). Forward the canonical clamped value as a fraction.
    const params = new URLSearchParams({
      tokenIn: sellToken, tokenOut: buyToken,
      amount, sender, maxSlippage: String(opts.slippagePct / 100),
    });
    const res = await fetch(`https://api.swapapi.dev/v1/swap/${opts.chainId}?${params}`, { signal: opts.signal });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || typeof data.amountOut !== 'string' || !/^\d+$/.test(data.amountOut) || data.amountOut === '0' ||
        typeof data.priceImpact !== 'number' || !Number.isFinite(data.priceImpact)) {
      return null;
    }
    return {
      source: 'swapapi',
      amountOut: data.amountOut,
      priceImpact: data.priceImpact,
      estimatedGas: data.tx?.gas,
      chainId: opts.chainId,
      maxSlippagePct: opts.slippagePct,
    };
  } catch { return null; }
}

// ─── Odos ───────────────────────────────────────────────────────
// Odos accepts slippage as a percent.

async function getOdosQuote(
  tokenIn: string, tokenOut: string, amount: string, sender: string, opts: QuoteCallOpts,
): Promise<AggregatorQuote | null> {
  try {
    const inAddr = normalizeTokenAddress(tokenIn, 'zero');
    const outAddr = normalizeTokenAddress(tokenOut, 'zero');
    const body = {
      chainId: opts.chainId,
      inputTokens: [{ tokenAddress: inAddr, amount }],
      outputTokens: [{ tokenAddress: outAddr, proportion: 1 }],
      userAddr: sender,
      // AUDIT R045 M1: percent (e.g. 0.5 = 0.5%).
      slippageLimitPercent: opts.slippagePct,
      disableRFQs: true,
      compact: true,
    };
    const res = await fetch('/api/odos/sor/quote/v2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: opts.signal,
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
      chainId: opts.chainId,
      maxSlippagePct: opts.slippagePct,
    };
  } catch { return null; }
}

// ─── CowSwap / CoW Protocol ────────────────────────────────────
// Slippage is consumed at signing/build time, not at quote time. Tag null.

async function getCowSwapQuote(
  tokenIn: string, tokenOut: string, amount: string, sender: string, opts: QuoteCallOpts,
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
      signal: opts.signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    const buyAmount = data?.quote?.buyAmount;
    if (!buyAmount || !/^\d+$/.test(String(buyAmount))) return null;
    return {
      source: 'cowswap',
      amountOut: String(buyAmount),
      priceImpact: 0, // CowSwap doesn't report price impact in quotes
      chainId: opts.chainId,
      maxSlippagePct: null,
    };
  } catch { return null; }
}

// ─── Li.Fi ──────────────────────────────────────────────────────
// Li.Fi accepts slippage as a fraction. Was previously omitted.

async function getLiFiQuote(
  tokenIn: string, tokenOut: string, amount: string, sender: string, opts: QuoteCallOpts,
): Promise<AggregatorQuote | null> {
  try {
    const fromToken = normalizeTokenAddress(tokenIn, 'native');
    const toToken = normalizeTokenAddress(tokenOut, 'native');
    const params = new URLSearchParams({
      fromChain: String(opts.chainId),
      toChain: String(opts.chainId),
      fromToken, toToken,
      fromAmount: amount,
      fromAddress: sender,
      // AUDIT R045 M1: forward the slippage tolerance as a fraction so quotes
      // are ranked apples-to-apples vs the other aggregators.
      slippage: String(opts.slippagePct / 100),
    });
    const res = await fetch(`/api/lifi/v1/quote?${params}`, { signal: opts.signal });
    if (!res.ok) return null;
    const data = await res.json();
    const toAmount = data?.estimate?.toAmount;
    if (!toAmount || !/^\d+$/.test(String(toAmount))) return null;
    return {
      source: 'lifi',
      amountOut: String(toAmount),
      priceImpact: 0,
      estimatedGas: data?.estimate?.gasCosts?.[0]?.estimate,
      chainId: opts.chainId,
      maxSlippagePct: opts.slippagePct,
    };
  } catch { return null; }
}

// ─── KyberSwap ──────────────────────────────────────────────────
// KyberSwap /routes is a price-only endpoint; slippage is supplied at /build.

async function getKyberSwapQuote(
  tokenIn: string, tokenOut: string, amount: string, _sender: string, opts: QuoteCallOpts,
): Promise<AggregatorQuote | null> {
  try {
    const inAddr = normalizeTokenAddress(tokenIn, 'native');
    const outAddr = normalizeTokenAddress(tokenOut, 'native');
    const params = new URLSearchParams({
      tokenIn: inAddr, tokenOut: outAddr, amountIn: amount,
    });
    const res = await fetch(`/api/kyber/ethereum/api/v1/routes?${params}`, {
      headers: { 'X-Client-Id': 'tegridy-farms' },
      signal: opts.signal,
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
      chainId: opts.chainId,
      maxSlippagePct: null,
    };
  } catch { return null; }
}

// ─── OpenOcean ──────────────────────────────────────────────────
// /quote is price-only; tagged null. Slippage is consumed at /swap.

async function getOpenOceanQuote(
  tokenIn: string, tokenOut: string, amount: string, _sender: string, opts: QuoteCallOpts,
): Promise<AggregatorQuote | null> {
  try {
    const fromDecimals = opts.fromDecimals ?? 18;
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
    const res = await fetch(`/api/openocean/v4/eth/quote?${params}`, { signal: opts.signal });
    if (!res.ok) return null;
    const data = await res.json();
    const outAmount = data?.data?.outAmount;
    if (!outAmount || !/^\d+$/.test(String(outAmount))) return null;
    return {
      source: 'openocean',
      amountOut: String(outAmount),
      priceImpact: typeof data?.data?.price_impact === 'string' ? Math.abs(parseFloat(data.data.price_impact)) : 0,
      estimatedGas: data?.data?.estimatedGas ? String(data.data.estimatedGas) : undefined,
      chainId: opts.chainId,
      maxSlippagePct: null,
    };
  } catch { return null; }
}

// ─── ParaSwap ───────────────────────────────────────────────────
// /prices is price-only. Slippage is supplied at /transactions/build.

async function getParaSwapQuote(
  tokenIn: string, tokenOut: string, amount: string, _sender: string, opts: QuoteCallOpts,
): Promise<AggregatorQuote | null> {
  try {
    const srcToken = normalizeTokenAddress(tokenIn, 'native');
    const destToken = normalizeTokenAddress(tokenOut, 'native');
    const params = new URLSearchParams({
      srcToken, destToken, amount,
      side: 'SELL', network: String(opts.chainId),
    });
    const res = await fetch(`/api/paraswap/prices?${params}`, { signal: opts.signal });
    if (!res.ok) return null;
    const data = await res.json();
    const destAmount = data?.priceRoute?.destAmount;
    if (!destAmount || !/^\d+$/.test(String(destAmount))) return null;
    return {
      source: 'paraswap',
      amountOut: String(destAmount),
      priceImpact: 0,
      estimatedGas: data?.priceRoute?.gasCost ? String(data.priceRoute.gasCost) : undefined,
      chainId: opts.chainId,
      maxSlippagePct: null,
    };
  } catch { return null; }
}

// ─── Meta-Aggregator: query all sources in parallel ─────────────

export interface MetaAggregatorResult {
  /** The best quote across all aggregators (highest amountOut) */
  best: AggregatorQuote | null;
  /** All successful quotes, sorted by amountOut descending */
  allQuotes: AggregatorQuote[];
  /** AUDIT R045 H1: surfaced for callers that want to confirm chain gating. */
  chainId: number;
}

/**
 * AUDIT R045 H1/M1: chainId is now a required positional argument and the
 * meta-aggregator short-circuits with an empty result for unsupported chains
 * (no HTTP calls go out). Slippage is uniform across every sub-quote that
 * accepts it at quote time.
 */
export async function getMetaAggregatorQuotes(
  tokenIn: string,
  tokenOut: string,
  amount: string,
  sender: string,
  chainId: number,
  maxSlippagePct: number = DEFAULT_MAX_SLIPPAGE_PCT,
  fromDecimals: number = 18,
  signal?: AbortSignal,
): Promise<MetaAggregatorResult> {
  // AUDIT R045 H1: kill-switch — refuse to fetch for unsupported chains.
  if (chainId !== SUPPORTED_CHAIN_ID) {
    return { best: null, allQuotes: [], chainId };
  }

  const slippagePct = clampSlippage(maxSlippagePct);
  const opts: QuoteCallOpts = { chainId, slippagePct, fromDecimals, signal };

  const results = await Promise.allSettled([
    getSwapApiQuote(tokenIn, tokenOut, amount, sender, opts),
    getOdosQuote(tokenIn, tokenOut, amount, sender, opts),
    getCowSwapQuote(tokenIn, tokenOut, amount, sender, opts),
    getLiFiQuote(tokenIn, tokenOut, amount, sender, opts),
    getKyberSwapQuote(tokenIn, tokenOut, amount, sender, opts),
    getOpenOceanQuote(tokenIn, tokenOut, amount, sender, opts),
    getParaSwapQuote(tokenIn, tokenOut, amount, sender, opts),
  ]);

  const quotes: AggregatorQuote[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) {
      // AUDIT R045 H1: defense-in-depth — drop quotes whose chain tag doesn't
      // match the intended chain (should never trip in practice).
      if (r.value.chainId !== chainId) continue;
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
    chainId,
  };
}

// ─── Backwards-compatible single-quote function ─────────────────
// Used by useSwap.ts for the aggregator price check

export async function getAggregatorPrice(
  tokenIn: string,
  tokenOut: string,
  amount: string,
  sender: string,
  chainId: number,
  maxSlippagePct: number = DEFAULT_MAX_SLIPPAGE_PCT,
  fromDecimals: number = 18,
  signal?: AbortSignal,
): Promise<{ amountOut: string; priceImpact: number; source: AggregatorSource; allQuotes: AggregatorQuote[] } | null> {
  const result = await getMetaAggregatorQuotes(tokenIn, tokenOut, amount, sender, chainId, maxSlippagePct, fromDecimals, signal);
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

// ─── Aggregator Route Comparison ──────────────────────────────────────
// Compares aggregator output vs direct on-chain output to decide routing.
// The user always receives the full aggregator output — no protocol capture.
// (Spread capture was removed: it was computed client-side only and never
// enforced on-chain, so the UI was displaying fictional revenue numbers.)

const BPS = 10000;

export interface AggregatorSpread {
  /** The improvement from aggregator vs direct (in output token units) */
  improvement: bigint;
  /** Amount the user actually receives (full aggregator output) */
  userReceives: bigint;
  /** User's savings vs direct swap in basis points */
  userSavingsBps: number;
  /** Whether the aggregator route is worth using */
  shouldUseAggregator: boolean;
}

/**
 * Compare aggregator output vs direct on-chain output.
 * User always receives the full aggregator output when it's better.
 */
export function calculateAggregatorSpread(
  onChainOutput: bigint,
  aggregatorOutput: bigint,
): AggregatorSpread {
  if (aggregatorOutput <= onChainOutput || onChainOutput === 0n) {
    return {
      improvement: 0n,
      userReceives: onChainOutput,
      userSavingsBps: 0,
      shouldUseAggregator: false,
    };
  }

  const improvement = aggregatorOutput - onChainOutput;
  const userSavingsBps = Number((improvement * BigInt(BPS)) / onChainOutput);

  return {
    improvement,
    userReceives: aggregatorOutput,
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
