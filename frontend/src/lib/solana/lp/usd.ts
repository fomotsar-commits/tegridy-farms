/**
 * Dollar figures for the LP pages: a convenience for the eye, never a number a
 * transaction carries. Every figure is "about": SOL is valued at Jupiter's SOL price as
 * last read, and a token at the pool's OWN price, which is the only price a pool share
 * can be taken out at. A price that could not be read gives no figure at all (null),
 * never "$0": a visitor reads $0 as a value.
 */

const LAMPORTS_PER_SOL = 1e9;

/** "about $1,234" / "about $12.34" / "under $0.01"; null for anything that is not a read number. */
export function usdText(usd: number | null): string | null {
  if (usd === null || !Number.isFinite(usd) || usd < 0) return null;
  if (usd > 0 && usd < 0.01) return 'under $0.01';
  const digits = usd >= 1000 ? 0 : 2;
  return `about $${usd.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/** The dollar value of some SOL; null without a read price. */
export function usdOfSol(lamports: bigint, usdPerSol: number | null): number | null {
  if (usdPerSol === null || !Number.isFinite(usdPerSol) || usdPerSol <= 0) return null;
  return (Number(lamports) / LAMPORTS_PER_SOL) * usdPerSol;
}

/**
 * SOL plus tokens, the tokens valued at `solPerToken` (the pool's own price). Null when the
 * token's decimals, the pool's price or the SOL price is not known.
 */
export function usdOfPair(sol: bigint, tokens: bigint, decimals: number | null, solPerToken: number | null, usdPerSol: number | null): number | null {
  const solValue = usdOfSol(sol, usdPerSol);
  if (solValue === null || decimals === null || solPerToken === null || !Number.isFinite(solPerToken) || solPerToken < 0) return null;
  const tokenSol = (Number(tokens) / 10 ** decimals) * solPerToken;
  return solValue + tokenSol * (usdPerSol as number);
}

/**
 * A pool's liquidity: twice its SOL side. A constant-product pool holds equal value on
 * each side at its own price, so this is what it holds at that price, not at any other.
 */
export function usdOfPool(solReserve: bigint, usdPerSol: number | null): number | null {
  const side = usdOfSol(solReserve, usdPerSol);
  return side === null ? null : side * 2;
}
