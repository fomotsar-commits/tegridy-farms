import { PublicKey } from '@solana/web3.js';

/**
 * Trades in the outside pools of the coins the robot trades, heard as they land. Each pool is one
 * `logsSubscribe` naming that pool (keeper/wake.ts): the chain sends the trade's log lines, never
 * account data. A landed trade drops that coin's remembered Jupiter price, so the next quick check
 * asks again and a move starts a pass at once. Which pools: a listing's deepest few per coin
 * (DexScreener), each kept only once the chain says one of the six exchanges owns it. The
 * exchanges' programs are handed in (scripts/lib/outside-dexes.mjs): three are Raydium's, and no
 * Raydium key may sit in src/ (src/test/siteNoRaydiumKeys.test.ts).
 */

/** One outside pool listened to: its exchange's program, and the robot's coin it prices. */
export interface StreamPool {
  pool: string;
  program: string;
  mint: string;
}

/** The deepest pools per coin listened to, and in all: the listing's tail is too thin to move a price. */
export const STREAM_POOLS_PER_COIN = 3;
export const STREAM_POOLS_MAX = 60;
/** How often the pools are looked up again: pools are made and emptied over days, not minutes. */
export const STREAM_REFRESH_MS = 30 * 60_000;

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isAddress = (s: unknown): s is string => {
  if (typeof s !== 'string' || s.length < 32 || s.length > 44) return false;
  try {
    return new PublicKey(s).toBase58() === s;
  } catch {
    return false;
  }
};

/**
 * A listing's pairs (DexScreener token-pairs/v1, one read per coin, untrusted; its tokens/v1 names
 * only each coin's top pool, walked 2026-11-05) as the pools of `coins` on Solana, deepest
 * first, at most STREAM_POOLS_PER_COIN a coin and STREAM_POOLS_MAX in all. Nothing here is trusted
 * past choosing what to ask the chain about (`streamPools`).
 */
export function listedPools(listing: unknown, coins: ReadonlySet<string>): { pool: string; mint: string }[] {
  if (!Array.isArray(listing)) return [];
  const rows: { pool: string; mint: string; usd: number }[] = [];
  for (const p of listing) {
    if (!isObject(p) || p.chainId !== 'solana' || !isAddress(p.pairAddress)) continue;
    const sides = [p.baseToken, p.quoteToken].map((t) => (isObject(t) ? t.address : null));
    const mint = sides.find((m): m is string => typeof m === 'string' && coins.has(m));
    if (!mint) continue;
    const usd = isObject(p.liquidity) && typeof p.liquidity.usd === 'number' && Number.isFinite(p.liquidity.usd) ? p.liquidity.usd : 0;
    rows.push({ pool: p.pairAddress, mint, usd });
  }
  rows.sort((a, b) => b.usd - a.usd);
  const seen = new Set<string>();
  const per = new Map<string, number>();
  const out: { pool: string; mint: string }[] = [];
  for (const r of rows) {
    if (seen.has(r.pool) || (per.get(r.mint) ?? 0) >= STREAM_POOLS_PER_COIN) continue;
    seen.add(r.pool);
    per.set(r.mint, (per.get(r.mint) ?? 0) + 1);
    out.push({ pool: r.pool, mint: r.mint });
    if (out.length >= STREAM_POOLS_MAX) break;
  }
  return out;
}

/**
 * The listed pools the chain says one of `programs` owns (`owners`: each pool's owner as read, or
 * null). A listing that names any other account is not listened to: a busy account that is no
 * pool would wake the robot for nothing.
 */
export function streamPools(listed: readonly { pool: string; mint: string }[], owners: ReadonlyMap<string, string | null>, programs: readonly string[]): StreamPool[] {
  const out: StreamPool[] = [];
  for (const l of listed) {
    const program = owners.get(l.pool);
    if (program && programs.includes(program)) out.push({ pool: l.pool, program, mint: l.mint });
  }
  return out;
}

/**
 * Whether a `logsNotification`'s value is a trade that landed in a pool of `program`'s: no error
 * (a failed trade moved nothing), and that exchange's program ran.
 */
export function tradeLanded(value: unknown, program: string): boolean {
  if (!isObject(value) || value.err !== null || !Array.isArray(value.logs)) return false;
  const ran = `Program ${program} invoke`;
  return value.logs.some((l) => typeof l === 'string' && l.startsWith(ran));
}
