import { pageArt, type ArtPiece } from '../../lib/artConfig';

/* ── Native LP Pool Types & Config ──────────────────────────────────── */

export interface LPPool {
  id: string;
  name: string;
  tokenA: { symbol: string; logo: string };
  tokenB: { symbol: string; logo: string };
  fee: string;
  tvl: string;
  apr: string;
  volume24h: string;
  status: 'live' | 'new' | 'hot' | 'soon';
  art: ArtPiece;
  artPos: string;
}

/** Token logo URLs (self-hosted) */
export const TOKEN_LOGOS: Record<string, string> = {
  TOWELI: pageArt('token-icon', 0).src,
  ETH: '/tokens/eth.png',
  WETH: '/tokens/weth.png',
  USDT: '/tokens/usdt.png',
  USDC: '/tokens/usdc.png',
  WBTC: '/tokens/wbtc.png',
  DOT: '/tokens/dot.png',
  MANA: '/tokens/mana.png',
};

/**
 * CREDIBILITY FIX (2026-06-09): the four speculative "PROPOSED – NOT
 * GUARANTEED" cards (USDT/USDC, ETH/WBTC, DOT/ETH, MANA/ETH) rendered with
 * em-dash TVL/APR next to the one live pool and read as vaporware — the
 * single worst trust signal on the Farm page for a DeFi-native visitor.
 * The render path (FarmPage → UpcomingPoolCard) is data-driven and stays;
 * add an entry here ONLY when a pair is actually scheduled (gauge vote
 * passed / seed committed), and it appears again automatically.
 */
export const UPCOMING_POOLS: Omit<LPPool, 'tvl' | 'apr' | 'volume24h'>[] = [];
