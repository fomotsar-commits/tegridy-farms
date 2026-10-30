// Opening a pool in the venue's own deployment (the batcher's test world): built with the real
// library, then each way the transaction could pay someone else, or reach Minswap, is tried
// against the check, one test each, so a check that stops catching one fails by name.
import { beforeAll, describe, expect, it } from 'vitest';
import type { TransactionBody, TransactionOutput, TransactionWitnessSet } from '@emurgo/cardano-serialization-lib-browser';
import type { Csl } from '../csl';
import { composeAddress, hexToBytes, type ParsedAddress } from '../address';
import { MINSWAP_V2, lpAssetName, ADA } from '../minswapV2';
import { TTL_SLOTS, type WalletUtxo } from '../orderTx';
import { testCsl } from '../testkit.fixture';
import { readOwnPoolsDeployment, type OwnPools } from './deployment';
import { FACTORY_NFT_NAME, type FactoryEntry } from './chainReads';
import { MIN_POOL_ADA } from './lpMath';
import { assembleSignedOpen, buildOpenPoolTx, checkOpenPoolTx, collateralTotal, factoryDatumHex, MAX_OPEN_NETWORK_FEE, OpenPoolBuildError, type OpenPoolPlan } from './openPoolTx';
import { PARAMS, PLUTUS, TEST_RECORD, TEST_TREASURY, WORLD, walletUtxo } from './testWorld.fixture';

const TIP = 201_255_884;
const ADA_1 = 1_000_000n;
/** A coin no pool holds yet, so the test world's factory list has its place. */
const NEW_TOKEN = { policyId: '42'.repeat(28), assetName: '4e4557' };

let csl: Csl;
let dep: OwnPools;
let opener: ParsedAddress;
let stranger: ParsedAddress;
let wallet: WalletUtxo[];
let factory: FactoryEntry;
let original = '';

function plan(over: Partial<OpenPoolPlan> = {}): OpenPoolPlan {
  return {
    opener,
    token: NEW_TOKEN,
    amountAda: 500n * ADA_1,
    amountToken: 1_000_000_000n,
    factory,
    setting: { txHash: 'a1'.repeat(32), index: 0 },
    openingFee: 73n * ADA_1,
    tipSlot: TIP,
    ...over,
  };
}

beforeAll(async () => {
  csl = await testCsl();
  const r = readOwnPoolsDeployment(TEST_RECORD);
  if (r.kind !== 'deployed') throw new Error(`test record refused: ${JSON.stringify(r)}`);
  dep = r.pools;
  const key = csl.PrivateKey.from_normal_bytes(new Uint8Array(32).fill(0x31));
  opener = composeAddress({ kind: 'key', hash: key.to_public().hash().to_hex() }, { kind: 'key', hash: '73'.repeat(28) });
  stranger = composeAddress({ kind: 'key', hash: 'ee'.repeat(28) }, { kind: 'key', hash: 'ef'.repeat(28) });
  wallet = [walletUtxo(csl, 1, opener, 700n * ADA_1), walletUtxo(csl, 2, opener, 3n * ADA_1, [[NEW_TOKEN.policyId, NEW_TOKEN.assetName, 2_000_000_000n]]), walletUtxo(csl, 3, opener, 8n * ADA_1)];
  // The factory's first entry, as DexInitialization writes it: the whole range of names.
  const factoryAddress = composeAddress({ kind: 'script', hash: dep.factoryScriptHash }, null);
  factory = {
    head: '00',
    tail: 'ff'.repeat(33),
    utxo: {
      txHash: 'fe'.repeat(32),
      index: 0,
      addressHex: factoryAddress.hex,
      lovelace: 2_000_000n,
      assets: [{ policyId: dep.authenPolicy, assetName: FACTORY_NFT_NAME, quantity: 1n }],
      inlineDatumHex: null,
    },
  };
  factory.utxo.inlineDatumHex = factoryDatumHex(csl, factory.head, factory.tail);
});

function bodyOf(txHex: string): TransactionBody {
  return csl.TransactionBody.from_bytes(csl.FixedTransaction.from_hex(txHex).raw_body());
}

/** The transaction with a changed body (CSL hands back copies of lists, so a new body is built). */
function rebuild(txHex: string, edit: (b: TransactionBody, outs: TransactionOutput[]) => TransactionOutput[] | void, ws?: (w: TransactionWitnessSet) => void): string {
  const tx = csl.FixedTransaction.from_hex(txHex);
  const old = csl.TransactionBody.from_bytes(tx.raw_body());
  const outs: TransactionOutput[] = Array.from({ length: old.outputs().len() }, (_, i) => old.outputs().get(i));
  const fresh = csl.TransactionBody.from_bytes(tx.raw_body());
  const changed = edit(fresh, outs);
  if (changed) {
    const list = csl.TransactionOutputs.new();
    for (const o of changed) list.add(o);
    const b = csl.TransactionBody.new_tx_body(fresh.inputs(), list, fresh.fee());
    b.set_ttl(fresh.ttl_bignum()!);
    const c = fresh.collateral();
    if (c) b.set_collateral(c);
    const cr = fresh.collateral_return();
    if (cr) b.set_collateral_return(cr);
    const tc = fresh.total_collateral();
    if (tc) b.set_total_collateral(tc);
    const m = fresh.mint();
    if (m) b.set_mint(m);
    const r = fresh.reference_inputs();
    if (r) b.set_reference_inputs(r);
    const h = fresh.script_data_hash();
    if (h) b.set_script_data_hash(h);
    const w = csl.TransactionWitnessSet.from_bytes(tx.raw_witness_set());
    ws?.(w);
    return csl.FixedTransaction.new(b.to_bytes(), w.to_bytes(), true).to_hex();
  }
  const w = csl.TransactionWitnessSet.from_bytes(tx.raw_witness_set());
  ws?.(w);
  return csl.FixedTransaction.new(fresh.to_bytes(), w.to_bytes(), true).to_hex();
}

function repay(o: TransactionOutput, to: ParsedAddress, lovelace?: bigint): TransactionOutput {
  const v = o.amount();
  if (lovelace !== undefined) v.set_coin(csl.BigNum.from_str(lovelace.toString()));
  const n = csl.TransactionOutput.new(csl.Address.from_bytes(hexToBytes(to.hex)), v);
  const d = o.plutus_data();
  if (d) n.set_plutus_data(d);
  return n;
}

function expectRefused(txHex: string, problem: RegExp, p = plan()) {
  expect(txHex).not.toBe(original);
  const r = checkOpenPoolTx(csl, dep, txHex, p, wallet, PARAMS, PLUTUS);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.problems.join(' | ')).toMatch(problem);
}

describe('buildOpenPoolTx + checkOpenPoolTx: the untampered build', () => {
  it('opens ADA/NEW at our pool address, pays 73 ADA to the treasury, and the check passes', () => {
    const built = buildOpenPoolTx(csl, dep, PARAMS, PLUTUS, wallet, plan());
    original = built.txHex;
    const r = checkOpenPoolTx(csl, dep, built.txHex, plan(), wallet, PARAMS, PLUTUS);
    expect(r.ok ? [] : r.problems).toEqual([]);
    if (!r.ok) return;
    const outs = bodyOf(built.txHex).outputs();
    // The pool at OUR pool address (never Minswap's), the fee at the treasury.
    expect(Buffer.from(outs.get(0).address().to_bytes()).toString('hex')).toBe(WORLD.pool.addressHex);
    expect(Buffer.from(outs.get(0).address().to_bytes()).toString('hex').slice(2, 58)).not.toBe(MINSWAP_V2.poolScriptHash);
    expect(Buffer.from(outs.get(3).address().to_bytes()).toString('hex')).toBe(TEST_TREASURY.hex);
    expect(BigInt(outs.get(3).amount().coin().to_str())).toBe(73n * ADA_1);
    expect(r.open.openingFee).toBe(73n * ADA_1);
    // sqrt(500,000,000 lovelace × 1,000,000,000) = 707,106,781.19, rounded up, less the 10 burned.
    expect(r.open.openerLp).toBe(707_106_772n);
    expect(r.open.paidToken).toBe(1_000_000_000n);
    // Both coins, the pool's 4.5 ADA, the fee, the new factory entry's ADA and the network fee: nothing else.
    expect(r.open.paidLovelace).toBe(500n * ADA_1 + MIN_POOL_ADA + 73n * ADA_1 + r.open.factoryLovelace + r.open.networkFee);
    expect(r.open.networkFee).toBeLessThanOrEqual(MAX_OPEN_NETWORK_FEE);
    expect(r.open.collateralPledged).toBe(collateralTotal(PLUTUS));
    // The script instructions point at the factory entry's place among the sorted inputs.
    const ws = csl.FixedTransaction.from_hex(built.txHex).witness_set();
    expect(ws.redeemers()?.len()).toBe(2);
  });

  it('refuses a factory entry whose gap does not hold the pair', () => {
    const lp = lpAssetName(ADA, NEW_TOKEN);
    const wrong = { ...factory, head: lp.slice(0, 2) === 'ff' ? '00' : `${lp.slice(0, 2)}ff`, tail: 'ff'.repeat(33) };
    expect(() => buildOpenPoolTx(csl, dep, PARAMS, PLUTUS, wallet, plan({ factory: wrong.head < lp ? { ...wrong, tail: lp } : wrong }))).toThrow(OpenPoolBuildError);
  });

  it('refuses without a plain-ADA coin of 5 ADA to pledge', () => {
    const noPledge = [walletUtxo(csl, 1, opener, 700n * ADA_1, [[NEW_TOKEN.policyId, NEW_TOKEN.assetName, 2_000_000_000n]])];
    expect(() => buildOpenPoolTx(csl, dep, PARAMS, PLUTUS, noPledge, plan())).toThrow(/5 ADA/);
  });
});

describe('checkOpenPoolTx refuses', () => {
  it('the opening fee paid to a stranger', () => {
    const bad = rebuild(original, (_b, outs) => outs.map((o, i) => (i === 3 ? repay(o, stranger) : o)));
    expectRefused(bad, /opening fee is not paid to the venue’s treasury/);
  });

  it('the opening fee cut short, the rest to your change', () => {
    const bad = rebuild(original, (_b, outs) => outs.map((o, i) => (i === 3 ? repay(o, TEST_TREASURY, 72n * ADA_1) : i === outs.length - 1 ? repay(o, opener, BigInt(o.amount().coin().to_str()) + ADA_1) : o)));
    expectRefused(bad, /opening fee is not the planned amount/);
  });

  it('the pool sent to Minswap’s pool script', () => {
    const minswapPool = composeAddress({ kind: 'script', hash: MINSWAP_V2.poolScriptHash }, { kind: 'key', hash: '52563c5410bff6a0d43ccebb7c37e1f69f5eb260552521adff33b9c2' });
    const bad = rebuild(original, (_b, outs) => outs.map((o, i) => (i === 0 ? repay(o, minswapPool) : o)));
    expectRefused(bad, /the pool is not paid to its planned address/);
  });

  it('the LP tokens sent to a stranger', () => {
    const bad = rebuild(original, (_b, outs) => outs.map((o, i) => (i === 4 ? repay(o, stranger) : o)));
    expectRefused(bad, /your LP tokens is not paid/);
  });

  it('change sent to a stranger', () => {
    const bad = rebuild(original, (_b, outs) => outs.map((o, i) => (i === outs.length - 1 ? repay(o, stranger) : o)));
    expectRefused(bad, /not yours/);
  });

  it('a reference input that is not ours', () => {
    const bad = rebuild(original, (b) => {
      const r = csl.TransactionInputs.new();
      const old = b.reference_inputs()!;
      for (let i = 0; i < old.len(); i++) r.add(old.get(i));
      r.add(csl.TransactionInput.new(csl.TransactionHash.from_hex('cf4ecddde0d81f9ce8fcc881a85eb1f8ccdaf6807f03fea4cd02da896a621776'), 0));
      b.set_reference_inputs(r);
    });
    expectRefused(bad, /reads other contracts/);
  });

  it('a pledge that does not come back to you', () => {
    const bad = rebuild(original, (b) => {
      b.set_collateral_return(repay(b.collateral_return()!, stranger));
    });
    expectRefused(bad, /pledge does not come back/);
  });

  it('script instructions with another budget', () => {
    const bad = rebuild(original, () => undefined, (w) => {
      const rs = w.redeemers()!;
      const next = csl.Redeemers.new();
      for (let i = 0; i < rs.len(); i++) {
        const r = rs.get(i);
        next.add(csl.Redeemer.new(r.tag(), r.index(), r.data(), csl.ExUnits.new(csl.BigNum.from_str('14000000'), r.ex_units().steps())));
      }
      w.set_redeemers(next);
    });
    expectRefused(bad, /script instructions are not the planned ones/);
  });

  it('a different expiry', () => {
    const bad = rebuild(original, (b) => {
      b.set_ttl(csl.BigNum.from_str(String(TIP + TTL_SLOTS + 1)));
    });
    expectRefused(bad, /expiry/);
  });

  it('a plan whose fee is not the one the transaction pays', () => {
    const r = checkOpenPoolTx(csl, dep, original, plan({ openingFee: 74n * ADA_1 }), wallet, PARAMS, PLUTUS);
    expect(r.ok).toBe(false);
  });
});

describe('assembleSignedOpen', () => {
  it('adds the wallet’s signature beside the checked script instructions, body unchanged', () => {
    const tx = csl.FixedTransaction.from_hex(original);
    const key = csl.PrivateKey.from_normal_bytes(new Uint8Array(32).fill(0x31));
    const vkeys = csl.Vkeywitnesses.new();
    vkeys.add(csl.make_vkey_witness(tx.transaction_hash(), key));
    const ws = csl.TransactionWitnessSet.new();
    ws.set_vkeys(vkeys);
    const r = assembleSignedOpen(csl, original, ws.to_hex(), tx.transaction_hash().to_hex());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const signed = csl.FixedTransaction.from_hex(r.signedHex);
    expect(signed.witness_set().vkeys()?.len()).toBe(1);
    expect(signed.witness_set().redeemers()?.to_hex()).toBe(tx.witness_set().redeemers()?.to_hex());
    expect(Buffer.from(signed.raw_body()).toString('hex')).toBe(Buffer.from(tx.raw_body()).toString('hex'));
  });

  it('refuses a wallet answer carrying script instructions of its own', () => {
    const ws = csl.TransactionWitnessSet.new();
    const tx = csl.FixedTransaction.from_hex(original);
    const vkeys = csl.Vkeywitnesses.new();
    vkeys.add(csl.make_vkey_witness(tx.transaction_hash(), csl.PrivateKey.generate_ed25519()));
    ws.set_vkeys(vkeys);
    ws.set_redeemers(tx.witness_set().redeemers()!);
    expect(assembleSignedOpen(csl, original, ws.to_hex(), tx.transaction_hash().to_hex()).ok).toBe(false);
  });
});

describe('a wallet whose plain ADA is one big coin', () => {
  it('pledges that coin and spends it too: the ledger allows both', () => {
    const one = [walletUtxo(csl, 7, opener, 700n * ADA_1), walletUtxo(csl, 8, opener, 3n * ADA_1, [[NEW_TOKEN.policyId, NEW_TOKEN.assetName, 2_000_000_000n]])];
    const built = buildOpenPoolTx(csl, dep, PARAMS, PLUTUS, one, plan());
    const r = checkOpenPoolTx(csl, dep, built.txHex, plan(), one, PARAMS, PLUTUS);
    expect(r.ok ? [] : r.problems).toEqual([]);
    expect(built.collateral.index).toBe(7);
  });
});

describe('the network fee of a pool opening', () => {
  it('is held to its size, its two scripts and their reference sizes, and says any leftover', () => {
    const r = checkOpenPoolTx(csl, dep, original, plan(), wallet, PARAMS, PLUTUS);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.open.networkFeeExcess).toBe(0n);
  });
});
