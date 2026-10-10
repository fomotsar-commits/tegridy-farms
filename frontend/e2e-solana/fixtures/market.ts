// What the page should work out from the stubbed Jupiter (fixtures/lp.ts
// installJupiterStub), worked out HERE by hand: the market price it reads, the other side
// of an opening at that price, and what an opening away from it is estimated to cost.
//
// Not imported from src/lib/solana/lp/opening.ts, for two reasons. The specs say what the
// page SHOULD show, so the page's own sums must not agree with themselves here. And that
// file reaches src/lib/solana.ts, which reads import.meta.env when it loads and does not
// load in Node: one spec importing it stops the whole suite before any test runs.
import type { Coin } from './coins';

/** What the page probes Jupiter with: a buy of 0.05 SOL, then the sale back. */
const PROBE_LAMPORTS = 50_000_000;
/** The route fee the stub takes each way, which the page's price must cancel out. */
const STUB_FEE = 0.995;

/**
 * The SOL price the page reads for something the stub quotes at `solPerToken`: the stub's
 * two answers (the buy, then the sale back, each less 0.5%), and the middle of the two as
 * the page takes it (the square root of buy price times sell price).
 */
export function stubMid(solPerToken: number, decimals: number): number {
  const tokensOut = Math.floor((PROBE_LAMPORTS / 1e9 / solPerToken) * 10 ** decimals * STUB_FEE);
  const lamportsBack = Math.floor((tokensOut / 10 ** decimals) * solPerToken * 1e9 * STUB_FEE);
  const tokens = tokensOut / 10 ** decimals;
  const buy = PROBE_LAMPORTS / 1e9 / tokens;
  const sell = lamportsBack / 1e9 / tokens;
  return Math.sqrt(buy * sell);
}

/**
 * The token's market price in a pool's own coin, in whole coins per whole token. For SOL
 * it is the token's SOL price. For USDC or BAYLA it is the token's SOL price over the
 * coin's own SOL price, each read the same way.
 */
export function marketIn(coin: Coin, token: { solPerToken: number; decimals: number }, coinSolPrice: number): number {
  const tokenMid = stubMid(token.solPerToken, token.decimals);
  return coin.native ? tokenMid : tokenMid / stubMid(coinSolPrice, coin.decimals);
}

/**
 * The other side of an opening at `pricePerToken` (whole coins per whole token), to the
 * nearest unit: keep the side typed in, work out the other.
 */
export function matchAtMarket(a: { keep: 'coin' | 'token'; amount: bigint; pricePerToken: number; tokenDecimals: number; coin: Coin }): bigint {
  const tokenScale = 10 ** a.tokenDecimals;
  const coinScale = 10 ** a.coin.decimals;
  const other = a.keep === 'coin' ? (Number(a.amount) / coinScale / a.pricePerToken) * tokenScale : (Number(a.amount) / tokenScale) * a.pricePerToken * coinScale;
  return BigInt(Math.round(other));
}

/** Whole coins per whole token at these amounts: the price an opening sets, or a pool has. */
export function priceOf(coinAmount: bigint, tokenAmount: bigint, tokenDecimals: number, coin: Coin): number {
  return Number(coinAmount) / 10 ** coin.decimals / (Number(tokenAmount) / 10 ** tokenDecimals);
}

/** How far `price` is from `market`, in the page's own words: "10.0% above", "4.8% below". */
export function gapOf(price: number, market: number): string {
  const diff = price / market - 1;
  return `${(Math.abs(diff) * 100).toFixed(1)}% ${diff >= 0 ? 'above' : 'below'}`;
}

/**
 * What arbitrage would take from these amounts if the price moved to the market, in the
 * coin's base units: with x whole coins and y whole tokens at market price m,
 * (sqrt(x) - sqrt(y*m)) squared. The trade fee is ignored, so it is an upper bound.
 */
export function lossAtMarket(a: { coinAmount: bigint; tokenAmount: bigint; tokenDecimals: number; marketPricePerToken: number; coin: Coin }): number {
  const x = Number(a.coinAmount) / 10 ** a.coin.decimals;
  const y = Number(a.tokenAmount) / 10 ** a.tokenDecimals;
  const gap = Math.sqrt(x) - Math.sqrt(y * a.marketPricePerToken);
  return gap * gap * 10 ** a.coin.decimals;
}

/** `lossAtMarket` as the page prints it: a whole number of the coin's base units, rounded UP. */
export const lossAtMarketUp = (a: Parameters<typeof lossAtMarket>[0]): bigint => BigInt(Math.ceil(lossAtMarket(a)));
