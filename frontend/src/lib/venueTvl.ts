// The home page's total value locked, as /api/aggregator?resource=venue-tvl serves it
// (api/_lib/venueTvl.js): what our pools hold plus what is staked in our staking pools.
// Anything the page cannot trust reads as unread, never as zero, and an answer that says
// "current" while missing a chain is read as partial.

export const VENUE_TVL_URL = '/api/aggregator?resource=venue-tvl';

/** Every chain the answer must name, in the order the page lists them. */
export const TVL_CHAINS = Object.freeze({ solana: 'Solana', ethereum: 'Ethereum', base: 'Base', robinhood: 'Robinhood' });
export type TvlChainName = keyof typeof TVL_CHAINS;
/** The chains with staking pools, in the order the answer lists them. */
export const STAKE_CHAINS = Object.freeze(['solana', 'ethereum', 'base'] as const);
export type StakeChainName = (typeof STAKE_CHAINS)[number];

export type TvlChain =
  | { chain: TvlChainName; read: true; usd: number; pools: number; unvalued: number }
  | { chain: TvlChainName; read: false };

export type TvlStaking =
  | { chain: StakeChainName; read: true; usd: number; vaults: number; unvalued: number }
  | { chain: StakeChainName; read: false };

export type VenueTvl =
  | { state: 'unread' }
  | { state: 'current' | 'partial'; usd: number; chains: TvlChain[]; staking: TvlStaking[]; readAt: Date };

const UNREAD: VenueTvl = { state: 'unread' };
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const isUsd = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** One part's rows, in `names` order, or null when any row is not what the server sends. */
function parseRows(raw: unknown, names: readonly string[], count: 'pools' | 'vaults'): object[] | null {
  if (!Array.isArray(raw) || raw.length !== names.length) return null;
  const rows: object[] = [];
  for (const [i, chain] of names.entries()) {
    const r = (raw as (Record<string, unknown> | null)[])[i];
    if (r?.chain !== chain) return null;
    if (r.read === false) rows.push({ chain, read: false });
    else if (r.read === true && isUsd(r.usd) && isCount(r[count]) && isCount(r.unvalued)) {
      rows.push({ chain, read: true, usd: r.usd, [count]: r[count], unvalued: r.unvalued });
    } else return null;
  }
  return rows;
}

export function parseVenueTvl(body: unknown): VenueTvl {
  const b = body as Record<string, unknown> | null;
  if (!b || (b.state !== 'current' && b.state !== 'partial')) return UNREAD;
  const readAt = Date.parse(String(b.readAt));
  if (!isUsd(b.usd) || !Number.isFinite(readAt)) return UNREAD;
  const chains = parseRows(b.chains, Object.keys(TVL_CHAINS), 'pools') as TvlChain[] | null;
  // An answer from before staking was counted (an edge copy, for a minute after a deploy) has
  // no staking rows: its total is our pools only, so it reads as partial.
  const staking =
    b.staking === undefined
      ? STAKE_CHAINS.map((chain): TvlStaking => ({ chain, read: false }))
      : (parseRows(b.staking, STAKE_CHAINS, 'vaults') as TvlStaking[] | null);
  if (!chains || !staking) return UNREAD;
  const whole = [...chains, ...staking].every((c) => c.read && c.unvalued === 0);
  return { state: b.state === 'current' && whole ? 'current' : 'partial', usd: b.usd, chains, staking, readAt: new Date(readAt) };
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
