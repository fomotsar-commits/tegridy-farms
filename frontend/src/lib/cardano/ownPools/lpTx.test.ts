// Add and remove liquidity against the batcher's test world: the world's pool reads as ours,
// the orders this page writes are byte for byte the ones the batcher's own tests fill, and the
// read-back refuses an order sent to Minswap's order script.
import { beforeAll, describe, expect, it } from 'vitest';
import type { TransactionOutput } from '@emurgo/cardano-serialization-lib-browser';
import type { Csl } from '../csl';
import { composeAddress, hexToBytes, parseAddressBech32, type ParsedAddress } from '../address';
import { ADA, MINSWAP_V2, readPool, type ChainUtxo, type PoolState } from '../minswapV2';
import { orderAddressFor } from '../minswapV2';
import type { WalletUtxo } from '../orderTx';
import { testCsl } from '../testkit.fixture';
import { readOwnPoolsDeployment, type OwnPools } from './deployment';
import { pickOwnPool, poolBatchingHashOf } from './chainReads';
import { buildLpOrderTx, checkLpOrderTx, lpOrderDatum, lpOrderValue, ORDER_DEPOSIT, type LpOrderPlan } from './lpTx';
import { PARAMS, TEST_RECORD, WORLD, trader, walletUtxo } from './testWorld.fixture';

const TIP = 201_255_884;
let csl: Csl;
let dep: OwnPools;
let pool: PoolState;
let poolRow: ChainUtxo;
let wallet: WalletUtxo[];
let t1: ParsedAddress;

/** A UTxO as the chain reader hands it, from its CBOR. */
function chainUtxo(txHash: string, index: number, outputHex: string): ChainUtxo {
  const o = csl.TransactionOutput.from_hex(outputHex);
  const assets: ChainUtxo['assets'] = [];
  const ma = o.amount().multiasset();
  const ps = ma?.keys();
  for (let i = 0; i < (ps?.len() ?? 0); i++) {
    const a = ma!.get(ps!.get(i))!;
    const names = a.keys();
    for (let j = 0; j < names.len(); j++) assets.push({ policyId: ps!.get(i).to_hex(), assetName: Buffer.from(names.get(j).name()).toString('hex'), quantity: BigInt(a.get(names.get(j))!.to_str()) });
  }
  return { txHash, index, addressHex: Buffer.from(o.address().to_bytes()).toString('hex'), lovelace: BigInt(o.amount().coin().to_str()), assets, inlineDatumHex: o.plutus_data()?.to_hex() ?? null };
}

beforeAll(async () => {
  csl = await testCsl();
  const r = readOwnPoolsDeployment(TEST_RECORD);
  if (r.kind !== 'deployed') throw new Error('test record refused');
  dep = r.pools;
  poolRow = chainUtxo(WORLD.pool.txHash, WORLD.pool.index, WORLD.pool.outputHex);
  const read = pickOwnPool(csl, dep, [poolRow], [ADA, WORLD.token]);
  if (read.status !== 'ok' || !read.data) throw new Error('the world pool did not read');
  pool = read.data;
  t1 = trader('1');
  wallet = [walletUtxo(csl, 1, t1, 600_000_000n, [[WORLD.token.policyId, WORLD.token.assetName, 900_000_000n]]), walletUtxo(csl, 2, t1, 40_000_000n)];
});

function deposit(over: Partial<Extract<LpOrderPlan, { kind: 'deposit' }>> = {}): LpOrderPlan {
  return { kind: 'deposit', trader: t1, pool, amountA: 10_000_000n, amountB: 500_000_000n, minimumLp: 2_000_000n, tipSlot: TIP, ...over };
}

describe('the test world’s pool', () => {
  it('reads as the venue’s: our script, our NFT, our LP policy, our batching credential, the datum’s reserves', () => {
    expect(pool.reserveA).toBe(BigInt(WORLD.pool.reserveA));
    expect(pool.reserveB).toBe(BigInt(WORLD.pool.reserveB));
    expect(pool.totalLiquidity).toBe(BigInt(WORLD.pool.totalLiquidity));
    expect(pool.feeSharingNumerator).toBe(1333n);
    expect(pool.lp).toEqual({ policyId: WORLD.scripts.authen.hash, assetName: WORLD.lpName });
  });

  it('is never read as Minswap’s, and a pool naming another batcher is not ours', () => {
    expect(readPool(csl, poolRow, [ADA, WORLD.token]).kind).toBe('not-a-pool');
    const otherBatcher = { ...dep, poolBatchingScriptHash: '99'.repeat(28) };
    expect(pickOwnPool(csl, otherBatcher, [poolRow], [ADA, WORLD.token])).toEqual({ status: 'unread', reason: 'a pool names another batcher' });
    expect(poolBatchingHashOf(csl, WORLD.pool.datumHex)).toBe(WORLD.scripts.poolBatching.hash);
  });
});

describe('the orders, byte for byte the batcher world’s', () => {
  it('deposit: the datum the batcher’s own tests fill', () => {
    expect(lpOrderDatum(csl, dep, deposit())).toBe(WORLD.orders.deposit.datumHex);
  });

  it('withdraw: the datum the batcher’s own tests fill', () => {
    const plan: LpOrderPlan = { kind: 'withdraw', trader: trader('2'), pool, lp: 1_000_000n, minimumA: 4_000_000n, minimumB: 200_000_000n, tipSlot: TIP };
    expect(lpOrderDatum(csl, dep, plan)).toBe(WORLD.orders.withdraw.datumHex);
  });

  it('sits at OUR order script, with the trader’s stake part', () => {
    expect(orderAddressFor(t1, dep).bech32).toBe(WORLD.orderAddress['1']);
    expect(orderAddressFor(t1, dep).payment.hash).not.toBe(MINSWAP_V2.orderScriptHash);
  });

  it('locks the coins, the batcher fee and the 2 ADA deposit', () => {
    expect(lpOrderValue(dep, deposit())).toEqual({ lovelace: 10_000_000n + 2_000_000n + ORDER_DEPOSIT, tokens: [{ asset: WORLD.token, quantity: 500_000_000n }] });
    const w: LpOrderPlan = { kind: 'withdraw', trader: t1, pool, lp: 7n, minimumA: 1n, minimumB: 1n, tipSlot: TIP };
    expect(lpOrderValue(dep, w)).toEqual({ lovelace: 4_000_000n, tokens: [{ asset: pool.lp, quantity: 7n }] });
  });

  it('refuses a pool that is not the venue’s', () => {
    const minswapPool = { ...pool, lp: { policyId: MINSWAP_V2.authenPolicy, assetName: WORLD.lpName } };
    expect(() => lpOrderDatum(csl, dep, deposit({ pool: minswapPool }))).toThrow(/not one of the venue’s/);
  });
});

describe('buildLpOrderTx + checkLpOrderTx', () => {
  let txHex = '';

  it('builds a deposit whose read-back passes, paying the coins in and nothing else', () => {
    const built = buildLpOrderTx(csl, dep, PARAMS, wallet, deposit());
    txHex = built.txHex;
    const r = checkLpOrderTx(csl, dep, built.txHex, deposit(), wallet, PARAMS);
    expect(r.ok ? [] : r.problems).toEqual([]);
    if (!r.ok) return;
    expect(r.order.orderLovelace).toBe(14_000_000n);
    expect(r.order.paidTokens).toEqual([{ policyId: WORLD.token.policyId, assetName: WORLD.token.assetName, quantity: 500_000_000n }]);
    expect(r.order.paidLovelace).toBe(14_000_000n + r.order.networkFee);
  });

  it('refuses the same order sent to Minswap’s order script', () => {
    const tx = csl.FixedTransaction.from_hex(txHex);
    const body = csl.TransactionBody.from_bytes(tx.raw_body());
    const outs = csl.TransactionOutputs.new();
    const minswapOrder = orderAddressFor(t1);
    for (let i = 0; i < body.outputs().len(); i++) {
      const o: TransactionOutput = body.outputs().get(i);
      if (i > 0) {
        outs.add(o);
        continue;
      }
      const moved = csl.TransactionOutput.new(csl.Address.from_bytes(hexToBytes(minswapOrder.hex)), o.amount());
      moved.set_plutus_data(o.plutus_data()!);
      outs.add(moved);
    }
    const b = csl.TransactionBody.new_tx_body(body.inputs(), outs, body.fee());
    b.set_ttl(body.ttl_bignum()!);
    const bad = csl.FixedTransaction.new(b.to_bytes(), tx.raw_witness_set(), true).to_hex();
    expect(bad).not.toBe(txHex);
    const r = checkLpOrderTx(csl, dep, bad, deposit(), wallet, PARAMS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.join(' | ')).toMatch(/not addressed to the venue’s own order script/);
  });

  it('refuses a plan whose minimum the transaction does not carry', () => {
    const r = checkLpOrderTx(csl, dep, txHex, deposit({ minimumLp: 1_999_999n }), wallet, PARAMS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.join(' | ')).toMatch(/terms/);
  });

  it('builds a withdrawal of LP tokens the wallet holds', () => {
    const lpWallet = [walletUtxo(csl, 3, t1, 30_000_000n, [[pool.lp.policyId, pool.lp.assetName, 5_000_000n]])];
    const plan: LpOrderPlan = { kind: 'withdraw', trader: t1, pool, lp: 5_000_000n, minimumA: 1n, minimumB: 1n, tipSlot: TIP };
    const built = buildLpOrderTx(csl, dep, PARAMS, lpWallet, plan);
    const r = checkLpOrderTx(csl, dep, built.txHex, plan, lpWallet, PARAMS);
    expect(r.ok ? [] : r.problems).toEqual([]);
    const staked = parseAddressBech32(WORLD.traders['1'].addressBech32)!;
    expect(staked.stake).not.toBeNull();
    // An enterprise wallet (no stake part) is still paid at its whole address.
    const ent = composeAddress(staked.payment, null);
    expect(orderAddressFor(ent, dep).stake).toBeNull();
  });
});

describe('a pool row that cannot be read', () => {
  it('is a pool unread, never "no pool": every row carries our pool NFT', () => {
    expect(pickOwnPool(csl, dep, [{ ...poolRow, inlineDatumHex: 'd87980' }], [ADA, WORLD.token]).status).toBe('unread');
  });

  it('another pair’s pool, holding this LP token as a coin, is passed over', () => {
    const other = { policyId: '71'.repeat(28), assetName: '4f5448' };
    expect(pickOwnPool(csl, dep, [poolRow], [ADA, other])).toEqual({ status: 'ok', data: null });
  });
});
