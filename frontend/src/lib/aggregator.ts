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
