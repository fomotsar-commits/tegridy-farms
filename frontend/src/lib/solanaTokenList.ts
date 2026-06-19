// SPL token model + resolver for the Solana swap surface (Surface A).
//
// Users can swap ANY pair: tokens are resolved on demand from the Jupiter token
// API (search by symbol/name OR paste a mint), so this file is no longer an
// allowlist — the curated consts below are just a "featured" shortlist shown as
// the picker's empty state. Risk signals (verified / Token-2022 / freeze) come
// back with each token so the UI can warn without blocking (the founder wants
// any pair). All calls go through our same-origin hardened proxy.
import { JUPITER_TOKENS_BASE } from './solana';

// Canonical legacy SPL Token program id — anything else implies Token-2022.
export const LEGACY_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

export interface SolToken {
  /** Base58 SPL mint address. */
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  logoURI?: string;
  /** Jupiter "verified" tag — false/undefined → show an "Unverified" warning. */
  verified?: boolean;
  /** Owning token program; !== LEGACY_TOKEN_PROGRAM → Token-2022 extensions. */
  tokenProgram?: string;
  organicScoreLabel?: 'high' | 'medium' | 'low';
  audit?: {
    mintAuthorityDisabled?: boolean;
    freezeAuthorityDisabled?: boolean;
    topHoldersPercentage?: number;
  };
  // Trending-card extras (present on top-tokens / search responses).
  usdPrice?: number;
  priceChange24h?: number;
  mcap?: number;
}

// Native SOL (wrapped-SOL mint). Jupiter handles wrap/unwrap automatically.
export const SOL: SolToken = {
  mint: 'So11111111111111111111111111111111111111112',
  symbol: 'SOL',
  name: 'Solana',
  decimals: 9,
  verified: true,
};

export const USDC: SolToken = {
  mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  symbol: 'USDC',
  name: 'USD Coin',
  decimals: 6,
  verified: true,
};

export const USDT: SolToken = {
  mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  symbol: 'USDT',
  name: 'Tether USD',
  decimals: 6,
  verified: true,
};

// Featured shortlist for the PAY side (picker empty state). Users can still
// search/paste any token; the platform fee only attaches when a leg is SOL/USDC.
export const PAY_WITH_TOKENS: SolToken[] = [SOL, USDC];

// Featured shortlist for the BUY side (picker empty state). Not a restriction.
export const BUY_TOKENS: SolToken[] = [
  SOL,
  USDC,
  USDT,
  { mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', symbol: 'JUP', name: 'Jupiter', decimals: 6, verified: true },
  { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', symbol: 'BONK', name: 'Bonk', decimals: 5, verified: true },
];

export interface LstToken extends SolToken {
  /** Approximate, variable APY — a static label (operator-refreshed). */
  apy: number;
  provider: string;
}

// Liquid-staking tokens. "Stake SOL" = buy one of these via the NORMAL swap: the
// token's value accrues validator/MEV yield each epoch (no claim, no lockup), and
// the SOL→LST buy still earns our 1% fee on the wSOL leg — so the buy IS the
// product (no stake-pool SDK needed). Mints byte-verified via the Jupiter token
// API (all legacy SPL Token program, decimals 9, verified). APY is approximate.
export const LST_TOKENS: LstToken[] = [
  { mint: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', symbol: 'JitoSOL', name: 'Jito Staked SOL', decimals: 9, verified: true, apy: 7.5, provider: 'Jito' },
  { mint: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', symbol: 'mSOL', name: 'Marinade Staked SOL', decimals: 9, verified: true, apy: 7.2, provider: 'Marinade' },
  { mint: 'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1', symbol: 'bSOL', name: 'BlazeStake Staked SOL', decimals: 9, verified: true, apy: 7.0, provider: 'BlazeStake' },
  { mint: '5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm', symbol: 'INF', name: 'Infinity (Sanctum LST basket)', decimals: 9, verified: true, apy: 8.0, provider: 'Sanctum' },
];

export function findSolToken(mint: string): SolToken | undefined {
  return [...PAY_WITH_TOKENS, ...BUY_TOKENS, ...LST_TOKENS].find((t) => t.mint === mint);
}

// ─── Resolver (Jupiter token API v2 via our proxy) ───────────────────────────

interface JupTokenV2 {
  id?: string; // the mint address (V2 renamed `address` → `id`)
  symbol?: string;
  name?: string;
  decimals?: number;
  icon?: string; // V2 renamed `logoURI` → `icon`
  isVerified?: boolean;
  tokenProgram?: string;
  organicScoreLabel?: string;
  audit?: SolToken['audit'];
  usdPrice?: number;
  mcap?: number;
  stats24h?: { priceChange?: number };
}

function mapV2(t: JupTokenV2): SolToken | null {
  // decimals is load-bearing for amount math — never invent it.
  if (!t || typeof t.id !== 'string' || typeof t.decimals !== 'number') return null;
  const score = t.organicScoreLabel;
  return {
    mint: t.id,
    symbol: t.symbol || `${t.id.slice(0, 4)}…`,
    name: t.name || t.symbol || 'Unknown token',
    decimals: t.decimals,
    logoURI: t.icon,
    verified: t.isVerified === true,
    tokenProgram: t.tokenProgram,
    organicScoreLabel: score === 'high' || score === 'medium' || score === 'low' ? score : undefined,
    audit: t.audit,
    usdPrice: typeof t.usdPrice === 'number' ? t.usdPrice : undefined,
    priceChange24h: typeof t.stats24h?.priceChange === 'number' ? t.stats24h.priceChange : undefined,
    mcap: typeof t.mcap === 'number' ? t.mcap : undefined,
  };
}

// Session cache so paste-a-mint / re-selection doesn't re-hit the API.
const _cache = new Map<string, SolToken>();

/**
 * Search tokens by symbol, name, OR mint address (one endpoint covers both
 * "search" and "paste a mint"). Returns up to 25 mapped tokens.
 */
export async function searchTokens(query: string, signal?: AbortSignal): Promise<SolToken[]> {
  const q = query.trim();
  if (!q) return [];
  const res = await fetch(`${JUPITER_TOKENS_BASE}/tokens/v2/search?query=${encodeURIComponent(q)}`, {
    headers: { Accept: 'application/json' },
    signal,
  });
  if (!res.ok) throw new Error(`Token search failed (${res.status})`);
  const arr = (await res.json()) as unknown;
  if (!Array.isArray(arr)) return [];
  const out: SolToken[] = [];
  for (const t of arr.slice(0, 25)) {
    const mapped = mapV2(t as JupTokenV2);
    if (mapped) {
      _cache.set(mapped.mint, mapped);
      out.push(mapped);
    }
  }
  return out;
}

/** Resolve a single mint address to its token (with authoritative decimals). */
export async function resolveMint(mint: string, signal?: AbortSignal): Promise<SolToken | null> {
  const cached = _cache.get(mint);
  if (cached) return cached;
  const results = await searchTokens(mint, signal);
  return results.find((t) => t.mint === mint) ?? null;
}

/** base58, 32–44 chars — a plausible Solana mint address pasted into search. */
export function looksLikeMint(q: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(q.trim());
}

// ─── Trending rails + CSP-safe icons ─────────────────────────────────────────

export type TrendingCategory = 'toptrending' | 'toptraded' | 'toporganicscore';
export type TrendingInterval = '5m' | '1h' | '6h' | '24h';

/** Trending Solana tokens (drives one-click buys). Keyless, via our proxy. */
export async function fetchTrending(
  category: TrendingCategory = 'toptrending',
  interval: TrendingInterval = '24h',
  limit = 24,
  signal?: AbortSignal,
): Promise<SolToken[]> {
  const res = await fetch(`${JUPITER_TOKENS_BASE}/tokens/v2/${category}/${interval}?limit=${limit}`, {
    headers: { Accept: 'application/json' },
    signal,
  });
  if (!res.ok) throw new Error(`Trending fetch failed (${res.status})`);
  const arr = (await res.json()) as unknown;
  if (!Array.isArray(arr)) return [];
  const out: SolToken[] = [];
  for (const t of arr) {
    const mapped = mapV2(t as JupTokenV2);
    if (mapped) { _cache.set(mapped.mint, mapped); out.push(mapped); }
  }
  return out;
}

/**
 * CSP-safe token icon URL via the weserv image proxy — so we never load (or leak
 * the user's token interest to) arbitrary token-image hosts. Returns '' when no
 * icon; callers fall back to the initials avatar. Only `wsrv.nl` needs to be in
 * the img-src CSP.
 */
export function iconSrc(url?: string): string {
  if (!url) return '';
  return `https://wsrv.nl/?url=${encodeURIComponent(url)}&w=64&h=64&fit=cover&output=webp`;
}
