import { TOWELI_WETH_LP_ADDRESS } from '../constants';

/**
 * Which pool a price chart draws, and the GeckoTerminal URLs for it.
 *
 * Split out of components/chart/PriceChart.tsx (2026-08-28) so that file only
 * exports components again — exporting these alongside it broke Fast Refresh.
 *
 * The chart was hardcoded to TOWELI/WETH on Ethereum before this, which is why
 * the Bayla bungalow had no chart at all: her pool is BAYLA/SOL on PumpSwap and
 * GeckoTerminal covers Solana perfectly well. The only thing missing was the
 * parameter.
 */
export type ChartMarket = {
  /** GeckoTerminal network slug — 'eth', 'solana', 'base', … */
  network: string;
  /** Pool (pair) address on that network. */
  pool: string;
  /** Human label, used for the iframe title. */
  label: string;
};

/** The venue's own pool. Every pre-existing call site resolves to this. */
export const TOWELI_MARKET: ChartMarket = {
  network: 'eth',
  pool: TOWELI_WETH_LP_ADDRESS,
  label: 'TOWELI',
};

export type Timeframe = '1h' | '4h' | '1d' | '1w';

export const TF_CONFIG: Record<Timeframe, { apiTf: string; aggregate: string; label: string; limit: number }> = {
  '1h': { apiTf: 'hour', aggregate: '1', label: '1H', limit: 168 },
  '4h': { apiTf: 'hour', aggregate: '4', label: '4H', limit: 90 },
  '1d': { apiTf: 'day', aggregate: '1', label: '1D', limit: 90 },
  '1w': { apiTf: 'day', aggregate: '7', label: '1W', limit: 52 },
};

export const chartPoolUrl = (m: ChartMarket) =>
  `https://www.geckoterminal.com/${m.network}/pools/${m.pool}`;

export const chartEmbedUrl = (m: ChartMarket) =>
  `${chartPoolUrl(m)}?embed=1&info=0&swaps=0&grayscale=0&light_chart=0`;

/**
 * Cache key for the in-memory OHLCV cache. It MUST include the pool: the key
 * used to be the timeframe alone, which is a cross-pool cache the moment a
 * second market exists — the bungalow chart would have been served TOWELI's
 * candles under its own ticker, with no error anywhere.
 */
export function ohlcvCacheKey(market: ChartMarket, tf: Timeframe): string {
  return `${market.network}:${market.pool}:${tf}`;
}

/** The GeckoTerminal OHLCV endpoint for a market + timeframe. */
export function ohlcvUrl(market: ChartMarket, tf: Timeframe): string {
  const cfg = TF_CONFIG[tf];
  return `https://api.geckoterminal.com/api/v2/networks/${market.network}/pools/${market.pool}/ohlcv/${cfg.apiTf}?aggregate=${cfg.aggregate}&limit=${cfg.limit}&currency=usd`;
}
