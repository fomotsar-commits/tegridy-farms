import type { PublicKey } from '@solana/web3.js';
import type { SolanaRpc } from '../../launcher/solana/curve/rpc';
import { clipDetail } from '../../launcher/solana/curve/read';
import { getMultipleAccounts } from '../lp/accounts';
import { CLOCK_SYSVAR, chainTimeOf, tokenVault } from '../lp/poolFinder';
import { readPair, type QuoteCoin } from '../lp/quotes';
import { RANGE_PROGRAM_ID, type BitmapExtensionView, type TickArrayView } from '../clmm/program';
import { rangePoolsVisible } from '../clmm/programId';
import { MAX_SWAP_BANDS, quoteSwap } from '../clmm/quote';
import { readBandsNear, readExtension, readFeeTiers, readPairPools, type RangePool } from '../clmm/read';
import type { RouteCandidate } from '../route';
import { EXACT_EXTENSIONS } from '../lp/tokenSafety';
import { tokenProblemOf, type OwnPoolsState } from './venuePools';

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
      /** `blocked`: why the builder would refuse this pool's swap (a mint it cannot build for, a frozen vault), or null. */
      pools: { range: RangePool; ext: BitmapExtensionView | null; bands: Map<number, TickArrayView>; blocked: string | null }[];
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
    // The clock, and each pool's two mints and two vaults, in one read: a pool the builder
    // refuses is no candidate, so its quote never stands beside Jupiter's.
    const [clock, ...held] = await getMultipleAccounts(rpc, [
      CLOCK_SYSVAR,
      ...found.value.flatMap((r) => [r.pool.tokenMint0, r.pool.tokenMint1, r.pool.tokenVault0, r.pool.tokenVault1]),
    ]);
    const pools: Extract<RangeRouteRead, { kind: 'ok' }>['pools'] = [];
    let unread = 0;
    await Promise.all(
      found.value.map(async (range, i) => {
        const [m0, m1, v0, v1] = held.slice(i * 4, i * 4 + 4).map((a) => a ?? null);
        // The range builders move exact amounts only: no transfer fee (EXACT_EXTENSIONS).
        const problem = tokenProblemOf(m0 ?? null, EXACT_EXTENSIONS) ?? tokenProblemOf(m1 ?? null, EXACT_EXTENSIONS);
        const vaults = problem === null ? [tokenVault(v0 ?? null, m0!.owner), tokenVault(v1 ?? null, m1!.owner)] : [];
        if (problem === null && vaults.some((v) => v === null)) {
          unread++;
          return;
        }
        // A dynamic fee runs above the tier's rate, which the review and the form say: no candidate.
        const blocked =
          problem ?? (range.pool.dynamicFeeInfo !== null ? 'its fee changes with the market' : vaults.some((v) => v!.frozen) ? 'a vault of the pool is frozen' : null);
        try {
          const ext = await readExtension(rpc, programId, range.pool);
          const bands = await readBandsNear(rpc, programId, range.pool, ext, MAX_SWAP_BANDS);
          pools.push({ range, ext, bands, blocked });
        } catch {
          unread++;
        }
      }),
    );
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

/**
 * How much less the trade gets than the pool's price before it would give, as a fraction,
 * the pool fee included: the own-pool quote's measure (cpswap/read.ts), which the page labels so.
 */
function impactOf(sqrtBefore: bigint, zeroForOne: boolean, amountIn: bigint, out: bigint): number {
  const s = Number(sqrtBefore) / 2 ** 64;
  const spotOut = zeroForOne ? Number(amountIn) * s * s : Number(amountIn) / (s * s);
  return spotOut > 0 && Number.isFinite(spotOut) ? Math.max(0, (spotOut - Number(out)) / spotOut) : 0;
}

/**
 * Quote `amountIn` of `inputMint` in every range pool read, as the program walks its bands.
 * A pool the builder refuses (`blocked`), that would need more bands than one swap carries,
 * cannot fill the trade, or is not open gives no candidate: `unquotable`, never "no pool".
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
  for (const { range, ext, bands, blocked } of read.pools) {
    if (amountIn <= 0n || blocked !== null) continue;
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
    const priceImpact = impactOf(p.sqrtPriceX64, zeroForOne, amountIn, q.amountOut);
    candidates.push({
      venue: 'own-pool',
      outAmount: q.amountOut,
      label: 'venue range pool',
      poolAddress: p.address,
      priceImpact,
      range,
      quote: { outAmount: q.amountOut, priceImpact, bands: q.bands },
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
