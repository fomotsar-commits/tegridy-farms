import type { PublicKey } from '@solana/web3.js';
import type { SolanaRpc } from '../../launcher/solana/curve/rpc';
import { clipDetail } from '../../launcher/solana/curve/read';
import { getMultipleAccounts } from '../lp/accounts';
import { CLOCK_SYSVAR, chainTimeOf } from '../lp/poolFinder';
import { readPair, type QuoteCoin } from '../lp/quotes';
import { RANGE_PROGRAM_ID, type BitmapExtensionView, type TickArrayView } from '../clmm/program';
import { rangePoolsVisible } from '../clmm/programId';
import { MAX_SWAP_BANDS, quoteSwap } from '../clmm/quote';
import { readBandsNear, readExtension, readFeeTiers, readPairPools, type RangePool } from '../clmm/read';
import type { RouteCandidate } from '../route';
import type { OwnPoolsState } from './venuePools';

/**
 * Our range pools for a swap's pair, and what each pays, beside our other pools
 * (venuePools.ts). Nothing is read while range pools are hidden (`rangePoolsVisible`): the
 * answer is then `not-searched`, so the swap page is exactly as it was. A pool whose bands
 * did not read gives no quote and makes the answer `error`, never "no pool".
 */

export type RangeRouteRead =
  | { kind: 'not-searched' }
  | { kind: 'unread'; detail: string }
  | {
      kind: 'ok';
      tokenMint: string;
      quote: QuoteCoin;
      pools: { range: RangePool; ext: BitmapExtensionView | null; bands: Map<number, TickArrayView> }[];
      /** Pools found whose bands did not read. */
      unread: number;
      chainNow: bigint | null;
    };

export async function readRangeRoutePools(
  rpc: SolanaRpc,
  inputMint: string,
  outputMint: string,
  o: { programId?: PublicKey; visible?: boolean } = {},
): Promise<RangeRouteRead> {
  if (!(o.visible ?? rangePoolsVisible())) return { kind: 'not-searched' };
  const pair = readPair(inputMint, outputMint);
  if (!pair) return { kind: 'not-searched' };
  const programId = o.programId ?? RANGE_PROGRAM_ID;
  try {
    const tiers = await readFeeTiers(rpc, programId);
    if (tiers.kind === 'unread') return { kind: 'unread', detail: tiers.detail };
    const found = await readPairPools(rpc, programId, pair.tokenMint, pair.quote.mint, tiers.value);
    if (found.kind === 'unread') return { kind: 'unread', detail: found.detail };
    const pools: Extract<RangeRouteRead, { kind: 'ok' }>['pools'] = [];
    let unread = 0;
    await Promise.all(
      found.value.map(async (range) => {
        try {
          const ext = await readExtension(rpc, programId, range.pool);
          const bands = await readBandsNear(rpc, programId, range.pool, ext, MAX_SWAP_BANDS);
          pools.push({ range, ext, bands });
        } catch {
          unread++;
        }
      }),
    );
    const [clock] = await getMultipleAccounts(rpc, [CLOCK_SYSVAR]).catch(() => [null]);
    pools.sort((a, b) => (a.range.pool.address < b.range.pool.address ? -1 : 1));
    return { kind: 'ok', tokenMint: pair.tokenMint, quote: pair.quote, pools, unread, chainNow: chainTimeOf(clock ?? null) };
  } catch (e) {
    return { kind: 'unread', detail: clipDetail(e) };
  }
}

export interface RangePoolCandidate extends RouteCandidate {
  venue: 'own-pool';
  poolAddress: string;
  /** Marks a range pool among our pools: its swap is built by the range builder. */
  range: RangePool;
  quote: { outAmount: bigint; priceImpact: number; bands: number[] };
}

/** How far the pool's price moves, as a fraction of where it started. */
function priceMove(before: bigint, after: bigint): number {
  if (before === 0n) return 0;
  const r = Number((after * 1_000_000_000_000n) / before) / 1e12;
  return Math.abs(1 - r * r);
}

/**
 * Quote `amountIn` of `inputMint` in every range pool read, as the program walks its bands.
 * A pool that would need more bands than one swap carries, cannot fill the trade, or is not
 * open gives no candidate.
 */
export function quoteRangePools(
  read: RangeRouteRead,
  inputMint: string,
  amountIn: bigint,
  viewerNowSecs: number = Math.floor(Date.now() / 1000),
): { state: OwnPoolsState; candidates: RangePoolCandidate[] } {
  if (read.kind === 'not-searched') return { state: 'not-searched', candidates: [] };
  if (read.kind === 'unread') return { state: 'error', candidates: [] };
  const now = read.chainNow !== null ? Number(read.chainNow) : viewerNowSecs;
  const candidates: RangePoolCandidate[] = [];
  for (const { range, ext, bands } of read.pools) {
    if (amountIn <= 0n) continue;
    const p = range.pool;
    const zeroForOne = inputMint === p.tokenMint0;
    if (!zeroForOne && inputMint !== p.tokenMint1) continue;
    const q = quoteSwap({
      pool: p,
      config: range.config,
      band: (s) => bands.get(s),
      extension: ext,
      zeroForOne,
      isBaseInput: true,
      amount: amountIn,
      sqrtPriceLimitX64: 0n,
      blockTimestamp: now,
    });
    if (q.kind !== 'ok' || !q.filled || q.amountOut <= 0n || q.bands.length > MAX_SWAP_BANDS) continue;
    candidates.push({
      venue: 'own-pool',
      outAmount: q.amountOut,
      label: 'venue range pool',
      poolAddress: p.address,
      priceImpact: priceMove(p.sqrtPriceX64, q.sqrtPriceX64),
      range,
      quote: { outAmount: q.amountOut, priceImpact: priceMove(p.sqrtPriceX64, q.sqrtPriceX64), bands: q.bands },
    });
  }
  if (candidates.length) return { state: 'quoted', candidates };
  if (read.pools.length === 0) return { state: read.unread > 0 ? 'error' : 'absent', candidates };
  return { state: read.unread > 0 || read.chainNow === null ? 'error' : 'unquotable', candidates };
}

/** Two answers about our pools, as one: any quote wins; then a read that failed; then one that cannot trade. */
export function mergeOwnStates(a: OwnPoolsState | 'pending', b: OwnPoolsState | 'pending' | null): OwnPoolsState | 'pending' {
  if (b === null || b === 'not-searched') return a;
  if (a === 'not-searched') return b;
  if (a === 'quoted' || b === 'quoted') return 'quoted';
  if (a === 'pending' || b === 'pending') return 'pending';
  if (a === 'error' || b === 'error') return 'error';
  if (a === 'unquotable' || b === 'unquotable') return 'unquotable';
  return 'absent';
}
