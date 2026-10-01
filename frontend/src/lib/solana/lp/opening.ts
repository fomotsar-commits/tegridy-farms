import { PRICE_TOLERANCE, comparePrice, tokenReasons, type PriceCheck } from './poolHealth';
import type { OutsidePrice } from './outsidePrice';
import type { TokenSafety } from './tokenSafety';

/**
 * May a new pool open at this price? Pure: every input was read elsewhere.
 *
 * An opening sets the pool's first price. One far from the market is handed to the first
 * arbitrage trade out of the opener's deposit, and a pool that opens mispriced then
 * refuses every later depositor (they get the same deposit check, poolHealth.ts). So an
 * opening must start within the deposit check's own 3% of a fresh Jupiter price, and a
 * pool opened that way passes that check at once.
 *
 * REFUSED: the token is absent, blocked, or copies a well-known name (the same
 * `tokenReasons` deposits use); it is SOL under the newer token program; the price is
 * more than 3% from Jupiter's; Jupiter ANSWERED that it has no route for the token
 * (nobody here opens a pool for a token only its opener can price).
 * UNCHECKED, which never opens: the token, its decimals or Jupiter's price could not be
 * read.
 */

/** SOL under the Token-2022 program (spl-token `NATIVE_MINT_2022`, pinned by a test). */
export const TOKEN_2022_NATIVE_MINT = '9pan9bMn5HatX4EJdBwg9VgCa7Uz5HL8N1m5D3NdXejP';

const LAMPORTS_PER_SOL = 1e9;

/** SOL per whole token at these opening amounts, or null; the same formula as `poolSolPerToken`. */
export function openingSolPerToken(sol: bigint, token: bigint, decimals: number): number | null {
  if (sol <= 0n || token <= 0n) return null;
  const p = Number(sol) / LAMPORTS_PER_SOL / (Number(token) / 10 ** decimals);
  return Number.isFinite(p) && p > 0 ? p : null;
}

export interface OpeningCheck {
  verdict: 'allowed' | 'refused' | 'unchecked';
  price: PriceCheck | { state: 'empty' };
  reasons: string[];
}

export function assessOpening(a: {
  tokenMint: string;
  sol: bigint;
  token: bigint;
  tokenDecimals: number | null;
  outside: OutsidePrice | null;
  safety: TokenSafety | null;
}): OpeningCheck {
  const t = tokenReasons(a.safety, 'pools');
  const refused = [...t.refused];
  const unchecked = [...t.unchecked];
  if (a.tokenMint === TOKEN_2022_NATIVE_MINT) refused.push('This is SOL under the newer token program. Pools here pair a token with SOL.');

  let price: OpeningCheck['price'];
  if (a.tokenDecimals === null) {
    price = { state: 'unread', pool: null, detail: 'the token’s decimals were not read' };
    unchecked.push('We could not read the token’s decimals, so we cannot work out the opening price.');
  } else if (a.sol < 1n || a.token < 1n) {
    // Nothing typed yet on one side: no price to judge, and no reason to give.
    price = { state: 'empty' };
  } else {
    const opening = openingSolPerToken(a.sol, a.token, a.tokenDecimals);
    if (opening === null) {
      price = { state: 'unread', pool: null, detail: 'the opening price could not be worked out' };
      unchecked.push('We could not work out the opening price from these amounts.');
    } else if (a.outside?.kind === 'ok') {
      price = comparePrice(opening, a.outside.solPerToken, 'outside');
      if (price.state === 'disagrees') {
        refused.push(
          `Your opening price is ${gapText(price.diff)} the market price (Jupiter). Pools opened from this site must start within ${PRICE_TOLERANCE * 100}% of it.`,
        );
      }
    } else if (a.outside?.kind === 'no-route') {
      price = { state: 'unread', pool: opening, detail: a.outside.detail };
      refused.push('Jupiter has no market price for this token, so this site does not open a pool for it.');
    } else {
      const detail = a.outside?.detail ?? 'not asked';
      price = { state: 'unread', pool: opening, detail };
      unchecked.push(`We could not get a market price from Jupiter (${detail}).`);
    }
  }

  return {
    verdict: refused.length ? 'refused' : unchecked.length ? 'unchecked' : 'allowed',
    price,
    reasons: [...refused, ...unchecked],
  };
}

/** "2.6% above" / "4.0% below". */
function gapText(diff: number): string {
  return `${(Math.abs(diff) * 100).toFixed(1)}% ${diff > 0 ? 'above' : 'below'}`;
}

/**
 * The other side of an opening at the market price, rounded to the nearest unit: keep the
 * side typed in last, set the other. Null when the answer is below one unit, or when the
 * inputs cannot price anything.
 */
export function matchMarket(a: { keep: 'sol' | 'token'; amount: bigint; solPerToken: number; tokenDecimals: number }): bigint | null {
  if (a.amount < 1n || !(a.solPerToken > 0) || !Number.isFinite(a.solPerToken)) return null;
  const scale = 10 ** a.tokenDecimals;
  const other =
    a.keep === 'sol'
      ? (Number(a.amount) / LAMPORTS_PER_SOL / a.solPerToken) * scale
      : (Number(a.amount) / scale) * a.solPerToken * LAMPORTS_PER_SOL;
  if (!Number.isFinite(other)) return null;
  const rounded = BigInt(Math.round(other));
  return rounded < 1n ? null : rounded;
}

/**
 * The largest opening at the market price that fits both balances: all the SOL that can
 * go in when the tokens cover it, else all the tokens and the SOL that matches them.
 * Never above either balance. Null when either side would be empty.
 */
export function mostBothAtMarket(a: { spendableSol: bigint; tokenBalance: bigint; solPerToken: number; tokenDecimals: number }): { sol: bigint; token: bigint } | null {
  if (a.spendableSol < 1n || a.tokenBalance < 1n) return null;
  const tokenForAllSol = matchMarket({ keep: 'sol', amount: a.spendableSol, solPerToken: a.solPerToken, tokenDecimals: a.tokenDecimals });
  // All the SOL that can go in does not buy one token unit: nothing fits at this price.
  if (tokenForAllSol === null) return null;
  if (tokenForAllSol <= a.tokenBalance) return { sol: a.spendableSol, token: tokenForAllSol };
  const solForAllTokens = matchMarket({ keep: 'token', amount: a.tokenBalance, solPerToken: a.solPerToken, tokenDecimals: a.tokenDecimals });
  if (solForAllTokens === null) return null;
  // Rounding to the nearest unit may land one over the SOL that can go in.
  return { sol: solForAllTokens > a.spendableSol ? a.spendableSol : solForAllTokens, token: a.tokenBalance };
}

/**
 * What arbitrage would take from an opening at these amounts, in lamports, if the pool's
 * price were moved to the market: `x + y·m − 2·√(x·y·m)` in SOL, written as
 * `(√x − √(y·m))²` so it is never negative. The trade fee is ignored, so it is an upper
 * bound. Display only.
 */
export function arbitrageLoss(a: { sol: bigint; token: bigint; tokenDecimals: number; marketSolPerToken: number }): number {
  const x = Number(a.sol) / LAMPORTS_PER_SOL;
  const y = Number(a.token) / 10 ** a.tokenDecimals;
  const m = a.marketSolPerToken;
  if (!(x >= 0) || !(y >= 0) || !(m > 0) || !Number.isFinite(x * y * m)) return 0;
  const gap = Math.sqrt(x) - Math.sqrt(y * m);
  return gap * gap * LAMPORTS_PER_SOL;
}
