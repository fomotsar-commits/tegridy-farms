import { pageArt } from '../../lib/artConfig';

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
  art: string;
  artPos: string;
}

/** Token logo URLs (self-hosted) */
export const TOKEN_LOGOS: Record<string, string> = {
  TOWELI: '/art/bobowelie.jpg',
  ETH: '/tokens/eth.png',
  WETH: '/tokens/weth.png',
  USDT: '/tokens/usdt.png',
  USDC: '/tokens/usdc.png',
  WBTC: '/tokens/wbtc.png',
  DOT: '/tokens/dot.png',
  MANA: '/tokens/mana.png',
};

export const UPCOMING_POOLS: Omit<LPPool, 'tvl' | 'apr' | 'volume24h'>[] = [
  {
    id: 'usdt-usdc',
    name: 'USDT / USDC',
    tokenA: { symbol: 'USDT', logo: TOKEN_LOGOS.USDT! },
    tokenB: { symbol: 'USDC', logo: TOKEN_LOGOS.USDC! },
    fee: '0.05%',
    status: 'soon',
    art: pageArt('upcoming-pools', 0).src,
    artPos: 'center 40%',
  },
  {
    id: 'eth-wbtc',
    name: 'ETH / WBTC',
    tokenA: { symbol: 'ETH', logo: TOKEN_LOGOS.ETH! },
    tokenB: { symbol: 'WBTC', logo: TOKEN_LOGOS.WBTC! },
    fee: '0.3%',
    status: 'soon',
    art: pageArt('upcoming-pools', 1).src,
    artPos: 'center 20%',
  },
  {
    id: 'dot-eth',
    name: 'DOT / ETH',
    tokenA: { symbol: 'DOT', logo: TOKEN_LOGOS.DOT! },
    tokenB: { symbol: 'ETH', logo: TOKEN_LOGOS.ETH! },
    fee: '0.3%',
    status: 'soon',
    art: pageArt('upcoming-pools', 2).src,
    artPos: 'center 30%',
  },
  {
    id: 'mana-eth',
    name: 'MANA / ETH',
    tokenA: { symbol: 'MANA', logo: TOKEN_LOGOS.MANA! },
    tokenB: { symbol: 'ETH', logo: TOKEN_LOGOS.ETH! },
    fee: '0.3%',
    status: 'soon',
    art: pageArt('upcoming-pools', 3).src,
    artPos: 'center 20%',
  },
];
