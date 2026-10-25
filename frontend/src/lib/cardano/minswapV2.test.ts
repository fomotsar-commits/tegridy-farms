// Holds the Minswap V2 formats against mainnet itself: real orders that Minswap's batcher
// accepted and filled, and the real pools they filled against (__fixtures__, 2026-10-24).
import { beforeAll, describe, expect, it } from 'vitest';
import type { Csl } from './csl';
import { parseAddressBytes, bytesToHex } from './address';
import { chainUtxoFromKoios } from './chain';
import {
  ADA,
  MINSWAP_V2,
  encodeSwapOrderDatum,
  lpAsset,
  lpAssetName,
  orderAddressFor,
  orderValue,
  readPool,
  type ChainUtxo,
  type PoolState,
} from './minswapV2';
import { ASCEND, ORDER_TXS, TOOLS, fixture, orderTxCbor, testCsl } from './testkit.fixture';

let csl: Csl;
beforeAll(async () => {
  csl = await testCsl();
});

function poolRows(): ChainUtxo[] {
  return fixture<unknown[]>('koios-asset-utxos-two-pools.json').map((r) => {
    const u = chainUtxoFromKoios(r);
    if (!u) throw new Error('fixture row did not parse');
    return u;
  });
}

const row = (prefix: string) => {
  const u = poolRows().find((x) => x.txHash.startsWith(prefix));
  if (!u) throw new Error(`no row ${prefix}`);
  return u;
};

/** A real order transaction, decoded: its order output and the trader's own change output. */
function realOrder(txHash: string, changeIndex: number) {
  const tx = csl.FixedTransaction.from_hex(orderTxCbor(txHash));
  const outs = csl.TransactionBody.from_bytes(tx.raw_body()).outputs();
  const order = outs.get(0);
  const trader = parseAddressBytes(outs.get(changeIndex).address().to_bytes());
  if (!trader) throw new Error('trader address did not parse');
  return { order, trader, datumHex: order.plutus_data()?.to_hex() ?? '' };
}

function stubPool(assetB: typeof ASCEND): PoolState {
  return {
    ref: { txHash: '00'.repeat(32), index: 0 },
    assetA: ADA,
    assetB,
    lp: lpAsset(ADA, assetB),
    reserveA: 1n,
    reserveB: 1n,
    totalLiquidity: 1n,
    feeANumerator: 30n,
    feeBNumerator: 30n,
    feeSharingNumerator: null,
    allowDynamicFee: false,
  };
}

describe('LP token name', () => {
  it('is the name the live pools hold, in either order', () => {
    expect(lpAssetName(ADA, ASCEND)).toBe('e66195788208dcd363edb600eaf2331019e3599baba645d81d61ef060c82d861');
    expect(lpAssetName(ASCEND, ADA)).toBe('e66195788208dcd363edb600eaf2331019e3599baba645d81d61ef060c82d861');
    expect(lpAssetName(ADA, TOOLS)).toBe('622b95198e378f982417c58bf00294d4958c294a0c3111e6272136523ab55833');
  });
});

describe('readPool', () => {
  it('reads the live ADA/ASCEND pool', () => {
    const r = readPool(csl, row('113c21f8'), [ADA, ASCEND]);
    expect(r.kind).toBe('pool');
    if (r.kind !== 'pool') return;
    expect(r.pool.reserveA).toBe(1019463084218n);
    expect(r.pool.reserveB).toBe(945869519487n);
    expect(r.pool.feeANumerator).toBe(100n);
    expect(r.pool.feeBNumerator).toBe(100n);
    expect(r.pool.feeSharingNumerator).toBe(1666n);
    expect(r.pool.allowDynamicFee).toBe(false);
  });

  it('reads the live ADA/TOOLS pool, with its own 2% fee', () => {
    const r = readPool(csl, row('47e34445'), [TOOLS, ADA]);
    expect(r.kind).toBe('pool');
    if (r.kind === 'pool') expect(r.pool.feeANumerator).toBe(200n);
  });

  it('refuses the real pool that holds the ASCEND LP token as its coin', () => {
    // 02db9d9b is a genuine Minswap pool, NFT and all, for ADA and the ADA/ASCEND LP token.
    // Looked up by that LP token it comes back too: only the datum says it is another pair.
    const r = readPool(csl, row('02db9d9b'), [ADA, ASCEND]);
    expect(r).toEqual({ kind: 'not-a-pool', reason: 'datum names another pair' });
  });

  it('refuses a pool read for a pair it is not', () => {
    expect(readPool(csl, row('113c21f8'), [ADA, TOOLS]).kind).toBe('not-a-pool');
  });

  it('refuses a UTxO that is not at the pool script', () => {
    const u = row('113c21f8');
    const other = { ...u, addressHex: u.addressHex.slice(0, 2) + MINSWAP_V2.orderScriptHash + u.addressHex.slice(58) };
    expect(readPool(csl, other, [ADA, ASCEND])).toEqual({ kind: 'not-a-pool', reason: 'not at the Minswap V2 pool script' });
  });

  it('refuses a UTxO without exactly one pool NFT', () => {
    const u = row('113c21f8');
    const none = { ...u, assets: u.assets.filter((a) => a.assetName !== MINSWAP_V2.poolNftName) };
    expect(readPool(csl, none, [ADA, ASCEND])).toEqual({ kind: 'not-a-pool', reason: 'no pool NFT' });
    const two = { ...u, assets: u.assets.map((a) => (a.assetName === MINSWAP_V2.poolNftName ? { ...a, quantity: 2n } : a)) };
    expect(readPool(csl, two, [ADA, ASCEND])).toEqual({ kind: 'not-a-pool', reason: 'no pool NFT' });
  });

  it('refuses a datum that claims more than the pool holds', () => {
    const u = row('113c21f8');
    expect(readPool(csl, { ...u, lovelace: 1019463084217n }, [ADA, ASCEND])).toEqual({
      kind: 'not-a-pool',
      reason: 'datum reserves exceed what the pool holds',
    });
  });

  it('refuses a UTxO with no datum', () => {
    expect(readPool(csl, { ...row('113c21f8'), inlineDatumHex: null }, [ADA, ASCEND]).kind).toBe('not-a-pool');
  });
});

describe('the order', () => {
  it('is addressed exactly as Minswap addresses it: its script, the trader’s stake part', () => {
    for (const [hash, change] of [
      [ORDER_TXS.adaIn, 1],
      [ORDER_TXS.tokenIn, 1],
      [ORDER_TXS.tokenInKillable, 2],
    ] as const) {
      const { order, trader } = realOrder(hash, change);
      expect(orderAddressFor(trader).hex).toBe(bytesToHex(order.address().to_bytes()));
    }
  });

  it('writes, byte for byte, the datum of a real killable order Minswap filled', () => {
    const { trader, datumHex } = realOrder(ORDER_TXS.tokenInKillable, 2);
    const ours = encodeSwapOrderDatum(csl, {
      trader,
      pool: stubPool(TOOLS),
      assetIn: TOOLS,
      swapAmount: 9117548040425n,
      minimumReceive: 103218165n,
    });
    expect(ours).toBe(datumHex);
  });

  it('matches Minswap’s own orders in everything but killable, which this rail always sets', () => {
    const cases = [
      { hash: ORDER_TXS.tokenIn, asset: ASCEND, assetIn: ASCEND, swap: 104749799n, min: 106403663n },
      { hash: ORDER_TXS.adaIn, asset: undefined, assetIn: ADA, swap: 750000000n, min: 4043564346n },
    ];
    for (const c of cases) {
      const { trader, datumHex } = realOrder(c.hash, 1);
      // The ADA-in order pays into a pool whose token this test does not need: take its LP from the datum.
      const pool = c.asset ? stubPool(c.asset) : { ...stubPool(ASCEND), lp: { policyId: MINSWAP_V2.authenPolicy, assetName: 'e74c52975908a612d5ce68327040d449aae99f8b463bb6de046a1b23c5713169' } };
      const ours = encodeSwapOrderDatum(csl, { trader, pool, assetIn: c.assetIn, swapAmount: c.swap, minimumReceive: c.min });
      // Minswap's site writes killable = False (d87980); this rail writes True (d87a80).
      const tail = 'ff1a001e8480d87a80ff';
      expect(datumHex.endsWith(`d87980${tail}`)).toBe(true);
      expect(ours).toBe(datumHex.slice(0, -(`d87980${tail}`.length)) + `d87a80${tail}`);
    }
  });

  it('locks what Minswap’s own orders lock: the swap, 2 ADA batcher fee, 2 ADA deposit', () => {
    const ada = realOrder(ORDER_TXS.adaIn, 1).order.amount();
    expect(orderValue({ assetIn: ADA, swapAmount: 750000000n })).toEqual({ lovelace: BigInt(ada.coin().to_str()), token: null });
    const tok = realOrder(ORDER_TXS.tokenIn, 1).order.amount();
    expect(orderValue({ assetIn: ASCEND, swapAmount: 104749799n }).lovelace).toBe(BigInt(tok.coin().to_str()));
  });

  it('refuses a script wallet, a zero amount and a coin not in the pool', () => {
    const { trader } = realOrder(ORDER_TXS.tokenIn, 1);
    const base = { trader, pool: stubPool(ASCEND), assetIn: ASCEND, swapAmount: 1n, minimumReceive: 1n };
    expect(() => encodeSwapOrderDatum(csl, { ...base, trader: { ...trader, payment: { kind: 'script', hash: trader.payment.hash } } })).toThrow();
    expect(() => encodeSwapOrderDatum(csl, { ...base, swapAmount: 0n })).toThrow();
    expect(() => encodeSwapOrderDatum(csl, { ...base, minimumReceive: 0n })).toThrow();
    expect(() => encodeSwapOrderDatum(csl, { ...base, assetIn: TOOLS })).toThrow();
  });
});
