// SPL token model + resolver for the Solana swap surface (Surface A).
//
// Users can swap ANY pair: tokens are resolved on demand from the Jupiter token
// API (search by symbol/name OR paste a mint), so this file is no longer an
// allowlist — the curated consts below are just a "featured" shortlist shown as
// the picker's empty state. Risk signals (verified / Token-2022 / freeze) come
// back with each token so the UI can warn without blocking (the founder wants
// any pair). All calls go through our same-origin hardened proxy.
import { JUPITER_TOKENS_BASE } from './solana';
import { liveIpfsUrl } from './ipfsGateways';

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
  // Token-detail extras (rug signals + links the v2 payload already carries).
  holderCount?: number;
  /** ISO timestamp of the token's first indexed pool — its trading "birthday". */
  firstPoolCreatedAt?: string;
  website?: string;
  twitter?: string;
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

// This venue's own BAYLA (the same mint as lib/bungalows.ts BAYLA_MINT; a test pins the
// two together). Decimals 6, read from the pump.fun coin record. `verified` stays unset:
// that flag is Jupiter's tag, and Jupiter has not given it. The venue knows the coin by
// its mint instead (`isVenueCoin`), which is what the picker's mark and the page's
// acknowledgement go by.
export const BAYLA: SolToken = {
  mint: '7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump',
  symbol: 'BAYLA',
  name: 'Jungle Bay Island',
  decimals: 6,
  // The picture in the token's own on-chain record. iconSrc() moves it to a live gateway.
  logoURI: 'https://ipfs.io/ipfs/bafkreiav3na7d325rg5ia4vbq5gs2wxbpvmgyzctwuvq2354yb73iv72uq',
};

// Featured shortlist for the PAY side (picker empty state). Users can still
// search/paste any token; the platform fee only attaches when a leg is SOL/USDC.
export const PAY_WITH_TOKENS: SolToken[] = [SOL, USDC, BAYLA];

// Featured shortlist for the BUY side (picker empty state). Not a restriction.
export const BUY_TOKENS: SolToken[] = [
  BAYLA,
  SOL,
  USDC,
  USDT,
  { mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', symbol: 'JUP', name: 'Jupiter', decimals: 6, verified: true },
  { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', symbol: 'BONK', name: 'Bonk', decimals: 5, verified: true },
];

/** The coins this venue's own pools pair a token with: SOL, USDC and the venue's BAYLA. */
export const VENUE_COINS: readonly SolToken[] = [SOL, USDC, BAYLA];
const VENUE_COIN_MINTS: ReadonlySet<string> = new Set(VENUE_COINS.map((t) => t.mint));

/** Is this one of the venue's own coins? By mint address only: a name or a symbol can be copied. */
export function isVenueCoin(mint: string): boolean {
  return VENUE_COIN_MINTS.has(mint);
}

/**
 * Does trading this token ask the trader to acknowledge a risk first? Every token
 * Jupiter has not verified does, except the venue's own coins, which it knows by mint.
 */
export function needsRiskAck(t: SolToken): boolean {
  return isUnverified(t) && !isVenueCoin(t.mint);
}

// Liquid-staking tokens. "Stake SOL" = buy one of these through the normal swap: the
// token is staked SOL that trades, with no claim and no lockup, and the buy carries the
// venue's fee like any other SOL buy. Mints byte-verified via the Jupiter token API
// (legacy SPL Token program, decimals 9, verified). No rate is held here: nothing on
// the page reads one, so the card names the token and prints no number.
export const LST_TOKENS: SolToken[] = [
  { mint: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', symbol: 'JitoSOL', name: 'Jito Staked SOL', decimals: 9, verified: true },
  { mint: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', symbol: 'mSOL', name: 'Marinade Staked SOL', decimals: 9, verified: true },
  { mint: 'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1', symbol: 'bSOL', name: 'BlazeStake Staked SOL', decimals: 9, verified: true },
  { mint: '5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm', symbol: 'INF', name: 'Infinity (Sanctum basket of staked SOL)', decimals: 9, verified: true },
];

export function findSolToken(mint: string): SolToken | undefined {
  return [...PAY_WITH_TOKENS, ...BUY_TOKENS, ...LST_TOKENS].find((t) => t.mint === mint);
}

/**
 * The single verified/unverified decision for every warning surface. Anything
 * but an explicit `true` is unverified — the field's own doc says
 * "false/undefined → show an 'Unverified' warning", and the curated BAYLA
 * entry deliberately leaves it unset. A strict `=== false` check silently
 * exempted every unset flag from both the badge and the risk-ack gate.
 */
export function isUnverified(t: SolToken): boolean {
  return t.verified !== true;
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
  holderCount?: number;
  firstPool?: { createdAt?: string };
  website?: string;
  twitter?: string;
}

/** Only ever hand the UI an http(s) URL — payload link fields are untrusted. */
function safeHttpUrl(u: unknown): string | undefined {
  return typeof u === 'string' && /^https?:\/\//i.test(u) ? u : undefined;
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
    holderCount: typeof t.holderCount === 'number' ? t.holderCount : undefined,
    firstPoolCreatedAt: typeof t.firstPool?.createdAt === 'string' ? t.firstPool.createdAt : undefined,
    website: safeHttpUrl(t.website),
    twitter: safeHttpUrl(t.twitter),
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

/**
 * Search results with the venue's own coins where a trader can find them. A venue coin
 * the search returned moves to the front. One it did not return is added when the text
 * typed is its mint or the start of its symbol: copies of a name can fill the first 25
 * results and leave the real coin out.
 */
export function withVenueCoinsFirst(results: readonly SolToken[], query: string): SolToken[] {
  const q = query.trim();
  const lower = q.toLowerCase();
  const wanted = VENUE_COINS.filter(
    (v) => results.some((r) => r.mint === v.mint) || q === v.mint || (lower.length >= 2 && v.symbol.toLowerCase().startsWith(lower)),
  );
  // The row the search returned carries the picture and the live fields: keep it.
  const front = wanted.map((v) => results.find((r) => r.mint === v.mint) ?? v);
  return [...front, ...results.filter((r) => !isVenueCoin(r.mint))];
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
 *
 * IPFS icons are moved onto a live gateway first: BAYLA's own on-chain metadata
 * and its Jupiter icon are https://ipfs.io/... URLs, and since that gateway was
 * retired (2026-09-21) wsrv.nl answers 404 for them. Via ipfs.filebase.io it
 * answers 200. (Not via Pinata: it rate-limits wsrv.nl's shared IP.)
 */
export function iconSrc(url?: string): string {
  if (!url) return '';
  return `https://wsrv.nl/?url=${encodeURIComponent(liveIpfsUrl(url))}&w=64&h=64&fit=cover&output=webp`;
}

// ─── Recents + favorites (localStorage, per-browser convenience) ─────────────
//
// Stored as FULL SolToken JSON, not bare mints, so a remembered token resolves
// instantly with authoritative decimals even offline (decimals are immutable
// per mint, so storing them is safe). Token metadata only — never balances,
// never the wallet address. Every read/write is try/catch-wrapped: private
// windows and cleared site data must degrade to "no recents", never a crash.
// Risk honesty: entries re-run through the same badge/ack logic as any other
// token at render time, so a remembered unverified token stays visibly
// unverified.

const RECENTS_KEY = 'sol.recents';
const FAVS_KEY = 'sol.favs';
const MAX_RECENTS = 8;

function readStoredTokens(key: string): SolToken[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (t): t is SolToken =>
        !!t &&
        typeof (t as SolToken).mint === 'string' &&
        typeof (t as SolToken).symbol === 'string' &&
        typeof (t as SolToken).decimals === 'number',
    );
  } catch {
    return [];
  }
}

function writeStoredTokens(key: string, tokens: SolToken[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(tokens));
  } catch {
    /* storage unavailable — recents are a convenience, not state */
  }
}

/** Record a picked token (front of the recents list, deduped, capped). */
export function rememberToken(t: SolToken): void {
  const rest = readStoredTokens(RECENTS_KEY).filter((x) => x.mint !== t.mint);
  writeStoredTokens(RECENTS_KEY, [t, ...rest].slice(0, MAX_RECENTS));
}

// A venue coin stored before it had a picture is the old curated row: show today's.
// A row the search gave carries its own picture and live fields, and is kept.
const asKnownNow = (t: SolToken): SolToken => (t.logoURI ? t : (VENUE_COINS.find((v) => v.mint === t.mint) ?? t));

export function getRecentTokens(): SolToken[] {
  return readStoredTokens(RECENTS_KEY).map(asKnownNow);
}

export function getFavoriteTokens(): SolToken[] {
  return readStoredTokens(FAVS_KEY).map(asKnownNow);
}

export function isFavoriteToken(mint: string): boolean {
  return readStoredTokens(FAVS_KEY).some((t) => t.mint === mint);
}

// A risk acknowledgement, kept per token on this device, so a returning trader is not
// asked again for a token they already said yes to. Mints only, newest first.
const ACKS_KEY = 'sol.acks';
const MAX_ACKS = 64;

function readAcks(): string[] {
  try {
    const arr = JSON.parse(localStorage.getItem(ACKS_KEY) ?? '[]') as unknown;
    return Array.isArray(arr) ? arr.filter((m): m is string => typeof m === 'string') : [];
  } catch {
    return [];
  }
}

function writeAcks(mints: string[]): void {
  try {
    localStorage.setItem(ACKS_KEY, JSON.stringify(mints.slice(0, MAX_ACKS)));
  } catch {
    /* storage unavailable: the trader is simply asked again */
  }
}

export function isRiskAcked(mint: string): boolean {
  return readAcks().includes(mint);
}

export function rememberRiskAck(mints: readonly string[]): void {
  const rest = readAcks().filter((m) => !mints.includes(m));
  writeAcks([...mints, ...rest]);
}

export function forgetRiskAck(mints: readonly string[]): void {
  writeAcks(readAcks().filter((m) => !mints.includes(m)));
}

/** Toggle a favorite; returns the NEW favorite state. */
export function toggleFavoriteToken(t: SolToken): boolean {
  const favs = readStoredTokens(FAVS_KEY);
  if (favs.some((x) => x.mint === t.mint)) {
    writeStoredTokens(FAVS_KEY, favs.filter((x) => x.mint !== t.mint));
    return false;
  }
  writeStoredTokens(FAVS_KEY, [t, ...favs].slice(0, 24));
  return true;
}
