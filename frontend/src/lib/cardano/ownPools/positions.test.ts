// "Your positions": the wallet's LP tokens under the venue's policy only, the pool found from
// the LP name through the pool's own datum, and fees counted only on LP this browser saw enter.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Csl } from '../csl';
import { ADA, MINSWAP_V2, type PoolState } from '../minswapV2';
import { testCsl } from '../testkit.fixture';
import { readOwnPoolsDeployment, type OwnPools } from './deployment';
import { growthIndex } from './lpMath';
import { datumPair, lpHoldings, poolOfLp, positionView } from './positions';
import { TEST_RECORD, WORLD, trader, walletUtxo } from './testWorld.fixture';

let csl: Csl;
let dep: OwnPools;

beforeAll(async () => {
  csl = await testCsl();
  const r = readOwnPoolsDeployment(TEST_RECORD);
  if (r.kind !== 'deployed') throw new Error('test record refused');
  dep = r.pools;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const POOL: PoolState = {
  ref: { txHash: WORLD.pool.txHash, index: 0 },
  assetA: ADA,
  assetB: WORLD.token,
  lp: { policyId: WORLD.scripts.authen.hash, assetName: WORLD.lpName },
  reserveA: BigInt(WORLD.pool.reserveA),
  reserveB: BigInt(WORLD.pool.reserveB),
  totalLiquidity: BigInt(WORLD.pool.totalLiquidity),
  feeANumerator: 30n,
  feeBNumerator: 30n,
  feeSharingNumerator: 1333n,
  allowDynamicFee: false,
};

describe('lpHoldings', () => {
  it('sums the venue’s LP tokens across coins, and skips its NFTs and Minswap’s LP tokens', () => {
    const t = trader('1');
    const holdings = lpHoldings(csl, dep, [
      walletUtxo(csl, 1, t, 5_000_000n, [[dep.authenPolicy, WORLD.lpName, 300n], [dep.authenPolicy, '4d5350', 1n]]),
      walletUtxo(csl, 2, t, 5_000_000n, [[dep.authenPolicy, WORLD.lpName, 200n], [MINSWAP_V2.authenPolicy, WORLD.lpName, 999n]]),
    ]);
    expect(holdings).toEqual([{ lp: { policyId: dep.authenPolicy, assetName: WORLD.lpName }, quantity: 500n }]);
  });
});

describe('poolOfLp', () => {
  it('finds the world’s pool from its LP name alone, through the pair its datum names', async () => {
    expect(datumPair(csl, WORLD.pool.datumHex)).toEqual([ADA, WORLD.token]);
    const out = csl.TransactionOutput.from_hex(WORLD.pool.outputHex);
    const ma = out.amount().multiasset()!;
    const assets = [];
    for (let i = 0; i < ma.keys().len(); i++) {
      const p = ma.keys().get(i);
      const a = ma.get(p)!;
      for (let j = 0; j < a.keys().len(); j++) assets.push({ policy_id: p.to_hex(), asset_name: Buffer.from(a.keys().get(j).name()).toString('hex'), quantity: a.get(a.keys().get(j))!.to_str() });
    }
    const row = { tx_hash: WORLD.pool.txHash, tx_index: 0, address: WORLD.pool.addressBech32, value: out.amount().coin().to_str(), asset_list: assets, inline_datum: { bytes: WORLD.pool.datumHex } };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([row]), { status: 200 })));
    const r = await poolOfLp(csl, dep, WORLD.lpName);
    expect(r.status === 'ok' && r.data?.reserveB).toBe(BigInt(WORLD.pool.reserveB));
    // Another LP name that the same row answers for is not this pool.
    const other = await poolOfLp(csl, dep, 'bb'.repeat(32));
    expect(other).toEqual({ status: 'ok', data: null });
    // A row carrying our pool NFT whose datum cannot be read is a pool unread, never "none".
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([{ ...row, inline_datum: { bytes: 'd87980' } }]), { status: 200 })));
    expect((await poolOfLp(csl, dep, WORLD.lpName)).status).toBe('unread');
  });
});

describe('positionView', () => {
  const holding = { lp: POOL.lp, quantity: 1_000_000_000n };
  const grown: PoolState = { ...POOL, reserveA: POOL.reserveA + 3_000_000_000n, reserveB: POOL.reserveB - 140_000_000_000n };

  it('with no entry noted, fees earned is unknown, never zero', () => {
    expect(positionView(holding, grown, [], 'aa').fees).toBeNull();
  });

  it('counts the growth since the noted entry, for this wallet only', () => {
    const entry = { traderHex: 'aa', lpName: POOL.lp.assetName, lp: '1000000000', index: growthIndex(POOL).toString(), txHash: '01'.repeat(32) };
    const v = positionView(holding, grown, [entry], 'aa');
    expect(v.fees!.a).toBeGreaterThan(0n);
    expect(v.fees!.coveredLp).toBe(1_000_000_000n);
    expect(positionView(holding, grown, [entry], 'bb').fees).toBeNull();
  });

  it('covers only what the wallet still holds when some has left', () => {
    const entry = { traderHex: 'aa', lpName: POOL.lp.assetName, lp: '4000000000', index: growthIndex(POOL).toString(), txHash: '01'.repeat(32) };
    const all = positionView({ ...holding, quantity: 4_000_000_000n }, grown, [entry], 'aa');
    const quarter = positionView(holding, grown, [entry], 'aa');
    expect(quarter.fees!.coveredLp).toBe(1_000_000_000n);
    expect(quarter.fees!.a).toBe(all.fees!.a / 4n);
  });
});
