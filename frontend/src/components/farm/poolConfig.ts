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

/** Token logo URLs (self-hosted). TOWELI's follows the room, so it is read on access. */
export const TOKEN_LOGOS: Record<string, string> = {
  get TOWELI() {
    return pageArt('token-icon', 0).src;
  },
  ETH: '/tokens/eth.png',
  WETH: '/tokens/weth.png',
  USDT: '/tokens/usdt.png',
  USDC: '/tokens/usdc.png',
  WBTC: '/tokens/wbtc.png',
  DOT: '/tokens/dot.png',
  MANA: '/tokens/mana.png',
};

/** Add a pair ONLY once it is scheduled (gauge vote passed or seed committed); FarmPage renders it. */
export const UPCOMING_POOLS: Omit<LPPool, 'tvl' | 'apr' | 'volume24h'>[] = [];
