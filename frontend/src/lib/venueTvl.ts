// The home page's total value locked, as /api/aggregator?resource=venue-tvl serves it
// (api/_lib/venueTvl.js). Anything the page cannot trust reads as unread, never as zero, and
// an answer that says "current" while missing a chain is read as partial.

export const VENUE_TVL_URL = '/api/aggregator?resource=venue-tvl';

/** Every chain the answer must name, in the order the page lists them. */
export const TVL_CHAINS = Object.freeze({ solana: 'Solana', ethereum: 'Ethereum', base: 'Base', robinhood: 'Robinhood' });
export type TvlChainName = keyof typeof TVL_CHAINS;

export type TvlChain =
  | { chain: TvlChainName; read: true; usd: number; pools: number; unvalued: number }
  | { chain: TvlChainName; read: false };

export type VenueTvl =
  | { state: 'unread' }
  | { state: 'current' | 'partial'; usd: number; chains: TvlChain[]; readAt: Date };

const UNREAD: VenueTvl = { state: 'unread' };
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const isUsd = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

export function parseVenueTvl(body: unknown): VenueTvl {
  const b = body as Record<string, unknown> | null;
  if (!b || (b.state !== 'current' && b.state !== 'partial')) return UNREAD;
  const readAt = Date.parse(String(b.readAt));
  if (!isUsd(b.usd) || !Number.isFinite(readAt) || !Array.isArray(b.chains)) return UNREAD;
  const names = Object.keys(TVL_CHAINS) as TvlChainName[];
  if (b.chains.length !== names.length) return UNREAD;
  const chains: TvlChain[] = [];
  for (const [i, chain] of names.entries()) {
    const raw = (b.chains as (Record<string, unknown> | null)[])[i];
    if (raw?.chain !== chain) return UNREAD;
    if (raw.read === false) chains.push({ chain, read: false });
    else if (raw.read === true && isUsd(raw.usd) && isCount(raw.pools) && isCount(raw.unvalued)) {
      chains.push({ chain, read: true, usd: raw.usd, pools: raw.pools, unvalued: raw.unvalued });
    } else return UNREAD;
  }
  const whole = chains.every((c) => c.read && c.unvalued === 0);
  return { state: b.state === 'current' && whole ? 'current' : 'partial', usd: b.usd, chains, readAt: new Date(readAt) };
}

export async function fetchVenueTvl(fetchImpl: typeof fetch = fetch): Promise<VenueTvl> {
  try {
    const r = await fetchImpl(VENUE_TVL_URL, { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) return UNREAD;
    return parseVenueTvl(await r.json());
  } catch {
    return UNREAD;
  }
}
