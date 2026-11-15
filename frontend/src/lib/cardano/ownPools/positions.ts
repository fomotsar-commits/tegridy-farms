// "Your positions": the venue-pool LP tokens a wallet holds, each pool read from the chain,
// with its share of the pool, what it would take out now, and the fees that grew it since a
// deposit this browser saw (lpWatch.ts). Read from the wallet's own coins (CIP-30 getUtxos),
// so no list of anyone's positions is kept anywhere.

import type { PlutusData } from '@emurgo/cardano-serialization-lib-browser';
import type { Csl } from '../csl';
import type { Read } from '../chain';
import { bytesToHex } from '../address';
import { isAda, isTokenId, lpAssetName, MINSWAP_V2, type CardanoAsset, type PoolState } from '../minswapV2';
import { tokenEntries, type WalletUtxo } from '../orderTx';
import type { OwnPools } from './deployment';
import { FACTORY_NFT_NAME, GLOBAL_SETTING_NFT_NAME, pickOwnPool, readOwnPoolCandidates } from './chainReads';
import { feesSince, positionNow } from './lpMath';
import type { LpEntry } from './lpWatch';

export interface LpHolding {
  lp: CardanoAsset;
  quantity: bigint;
}

/** Every token under the venue's authen policy the wallet holds that can be an LP token (not one of its three NFTs), summed. */
export function lpHoldings(csl: Csl, dep: OwnPools, utxos: WalletUtxo[]): LpHolding[] {
  const sums = new Map<string, bigint>();
  const nfts = new Set([MINSWAP_V2.poolNftName, FACTORY_NFT_NAME, GLOBAL_SETTING_NFT_NAME]);
  for (const u of utxos) {
    for (const t of tokenEntries(csl.TransactionUnspentOutput.from_hex(u.hex).output().amount())) {
      // An LP name is 32 bytes (lpAssetName); anything else under the policy is not an LP token.
      if (t.policyId !== dep.authenPolicy || nfts.has(t.assetName) || t.assetName.length !== 64) continue;
      sums.set(t.assetName, (sums.get(t.assetName) ?? 0n) + t.quantity);
    }
  }
  return [...sums].map(([assetName, quantity]) => ({ lp: { policyId: dep.authenPolicy, assetName }, quantity }));
}

function assetOf(d: PlutusData | undefined): CardanoAsset | null {
  const c = d?.as_constr_plutus_data();
  if (!c || c.alternative().to_str() !== '0' || c.data().len() !== 2) return null;
  const p = c.data().get(0).as_bytes();
  const n = c.data().get(1).as_bytes();
  if (!p || !n) return null;
  const a = { policyId: bytesToHex(p), assetName: bytesToHex(n) };
  return isAda(a) || isTokenId(a) ? a : null;
}

/** The pair a pool datum names (fields 1 and 2), or null. */
export function datumPair(csl: Csl, datumHex: string): [CardanoAsset, CardanoAsset] | null {
  try {
    const c = csl.PlutusData.from_hex(datumHex).as_constr_plutus_data();
    if (!c || c.data().len() !== 10) return null;
    const a = assetOf(c.data().get(1));
    const b = assetOf(c.data().get(2));
    return a && b ? [a, b] : null;
  } catch {
    return null;
  }
}

/**
 * The venue's pool behind an LP token. The LP name is a hash of the pair, so the pool's own
 * datum names it; the pool is then read as any other (pickOwnPool), and only a pair whose LP
 * name IS this one counts. null: the chain answered, and no venue pool issues this token.
 */
export async function poolOfLp(csl: Csl, dep: OwnPools, lpName: string, signal?: AbortSignal): Promise<Read<PoolState | null>> {
  const rows = await readOwnPoolCandidates(dep, lpName, signal);
  if (rows.status !== 'ok') return rows;
  const found: PoolState[] = [];
  for (const row of rows.data) {
    const pair = row.inlineDatumHex ? datumPair(csl, row.inlineDatumHex) : null;
    // Every row carries our pool NFT: one whose datum cannot be read is a pool unread.
    if (!pair) return { status: 'unread', reason: 'a pool’s datum could not be read' };
    // Another pair's pool, holding this LP token as one of its coins.
    if (lpAssetName(pair[0], pair[1]) !== lpName) continue;
    const r = pickOwnPool(csl, dep, [row], pair);
    if (r.status !== 'ok') return r;
    if (r.data) found.push(r.data);
  }
  if (found.length > 1) return { status: 'unread', reason: 'two pools claim this LP token' };
  return { status: 'ok', data: found[0] ?? null };
}

export interface PositionView {
  holding: LpHolding;
  pool: PoolState;
  sharePpm: bigint;
  /** What the position would take out now, at the pool's datum reserves. */
  a: bigint;
  b: bigint;
  /**
   * Fees that grew the LP this browser saw enter (lpWatch entries), on at most what the wallet
   * holds: null when no entry is noted here. `coveredLp` is how much of the holding that is.
   */
  fees: { a: bigint; b: bigint; coveredLp: bigint } | null;
}

export function positionView(holding: LpHolding, pool: PoolState, entries: LpEntry[], traderHex: string): PositionView {
  const now = positionNow(pool, holding.quantity);
  const mine = entries.filter((e) => e.traderHex === traderHex && e.lpName === holding.lp.assetName);
  let fees: PositionView['fees'] = null;
  if (mine.length > 0) {
    const noted = mine.reduce((s, e) => s + BigInt(e.lp), 0n);
    // Some LP may have left since (a withdrawal, a transfer): each entry is counted pro rata.
    const covered = noted < holding.quantity ? noted : holding.quantity;
    let a = 0n;
    let b = 0n;
    for (const e of mine) {
      const lp = (BigInt(e.lp) * covered) / (noted === 0n ? 1n : noted);
      const f = feesSince(pool, lp, BigInt(e.index));
      a += f.a;
      b += f.b;
    }
    fees = { a, b, coveredLp: covered };
  }
  return { holding, pool, sharePpm: now.sharePpm, a: now.a, b: now.b, fees };
}
