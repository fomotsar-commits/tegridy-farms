// What this site writes for the venue's own pools, held byte for byte against what has run on
// mainnet: real Minswap V2 Deposit and Withdraw orders that Minswap's batcher filled, and real
// pool creations Minswap's factory accepted (__fixtures__/minswap-v2-mainnet-lp.json). Each is
// re-encoded with OUR encoders from the terms its own bytes carry, Minswap's deployment standing
// in for ours, so nothing here is checked only against code we wrote ourselves.
import { beforeAll, describe, expect, it } from 'vitest';
import type { PlutusData } from '@emurgo/cardano-serialization-lib-browser';
import type { Csl } from '../csl';
import { bytesToHex, type ParsedAddress } from '../address';
import { encodeDepositStep, encodeOrderDatum, encodeWithdrawStep } from '../minswapV2';
import { fixture, testCsl } from '../testkit.fixture';
import { createPoolRedeemerHex, factoryDatumHex, factoryRedeemerHex, poolDatumHex } from './openPoolTx';

const REAL = fixture<{ orders: { ref: string; outputHex: string }[]; creations: { tx_hash: string; cbor: string }[] }>('minswap-v2-mainnet-lp.json');
let csl: Csl;

beforeAll(async () => {
  csl = await testCsl();
});

const F = (d: PlutusData) => {
  const c = d.as_constr_plutus_data()!;
  return { alt: Number(c.alternative().to_str()), f: Array.from({ length: c.data().len() }, (_, i) => c.data().get(i)) };
};
const int = (d: PlutusData) => BigInt(d.as_integer()!.to_str());
const bytes = (d: PlutusData) => bytesToHex(d.as_bytes()!);
const credential = (d: PlutusData) => {
  const c = F(d);
  return { kind: c.alt === 0 ? ('key' as const) : ('script' as const), hash: bytes(c.f[0]!) };
};

/** Our step with only its killable flag set to the real order's (this site always writes true). */
function killableAs(step: PlutusData, killable: boolean): PlutusData {
  if (killable) return step;
  const c = step.as_constr_plutus_data()!;
  const l = csl.PlutusList.new();
  for (let i = 0; i < c.data().len(); i++) l.add(i === c.data().len() - 1 ? csl.PlutusData.new_constr_plutus_data(csl.ConstrPlutusData.new(csl.BigNum.from_str('0'), csl.PlutusList.new())) : c.data().get(i));
  return csl.PlutusData.new_constr_plutus_data(csl.ConstrPlutusData.new(c.alternative(), l));
}

describe('real Minswap V2 Deposit and Withdraw orders, filled on mainnet', () => {
  it('has the five', () => {
    expect(REAL.orders).toHaveLength(5);
  });

  it('each is byte for byte what our encoders write for its terms', () => {
    for (const { ref, outputHex } of REAL.orders) {
      const datum = csl.TransactionOutput.from_hex(outputHex).plutus_data()!;
      const top = F(datum);
      const step = F(top.f[6]!);
      const amount = F(step.f[0]!);
      const killable = F(step.f[step.alt === 4 ? 2 : 3]!).alt === 1;
      const receiver = F(top.f[3]!);
      const stakeOpt = F(receiver.f[1]!);
      const trader = { payment: credential(receiver.f[0]!), stake: stakeOpt.alt === 0 ? credential(F(stakeOpt.f[0]!).f[0]!) : null } as ParsedAddress;
      const lp = F(top.f[5]!);
      const ours =
        step.alt === 4 ? encodeDepositStep(csl, int(amount.f[0]!), int(amount.f[1]!), int(step.f[1]!)) : encodeWithdrawStep(csl, int(amount.f[0]!), int(step.f[1]!), int(step.f[2]!));
      const hex = encodeOrderDatum(csl, { trader, lp: { policyId: bytes(lp.f[0]!), assetName: bytes(lp.f[1]!) }, step: killableAs(ours, killable), maxBatcherFee: int(top.f[7]!) });
      expect(hex, ref).toBe(datum.to_hex());
    }
  });
});

describe('real Minswap V2 pool creations, accepted on mainnet', () => {
  it('has one at 0.3%, the fee every pool this site opens carries', () => {
    const fees = REAL.creations.map((c) => {
      const body = csl.TransactionBody.from_bytes(csl.FixedTransaction.from_hex(c.cbor).raw_body());
      return int(F(body.outputs().get(0).plutus_data()!).f[6]!);
    });
    expect(fees).toContain(30n);
  });

  it('each one’s pool datum, factory entries and script instructions are byte for byte ours', () => {
    for (const c of REAL.creations) {
      const tx = csl.FixedTransaction.from_hex(c.cbor);
      const body = csl.TransactionBody.from_bytes(tx.raw_body());
      const out = (i: number) => body.outputs().get(i).plutus_data()!;
      const pool = F(out(0));
      const coin = F(pool.f[2]!);
      const plan = { token: { policyId: bytes(coin.f[0]!), assetName: bytes(coin.f[1]!) }, amountAda: int(pool.f[4]!), amountToken: int(pool.f[5]!) };
      const batching = bytes(F(F(pool.f[0]!).f[0]!).f[0]!);
      expect(poolDatumHex(csl, { poolBatchingScriptHash: batching }, plan, int(pool.f[3]!), int(pool.f[6]!)), c.tx_hash).toBe(out(0).to_hex());
      const e1 = F(out(1));
      const e2 = F(out(2));
      const lp = bytes(e1.f[1]!);
      expect(factoryDatumHex(csl, bytes(e1.f[0]!), lp)).toBe(out(1).to_hex());
      expect(factoryDatumHex(csl, lp, bytes(e2.f[1]!))).toBe(out(2).to_hex());
      const rs = tx.witness_set().redeemers()!;
      const red = Array.from({ length: rs.len() }, (_, i) => rs.get(i));
      expect(red.find((r) => r.tag().kind() === csl.RedeemerTagKind.Spend)!.data().to_hex()).toBe(factoryRedeemerHex(csl, plan));
      expect(red.find((r) => r.tag().kind() === csl.RedeemerTagKind.Mint)!.data().to_hex()).toBe(createPoolRedeemerHex(csl));
    }
  });

  it('puts the pool first and the two factory entries next, each at the least ADA it may hold, as ours does', () => {
    for (const c of REAL.creations) {
      const body = csl.TransactionBody.from_bytes(csl.FixedTransaction.from_hex(c.cbor).raw_body());
      for (const i of [1, 2]) {
        const o = body.outputs().get(i);
        const least = BigInt(csl.min_ada_for_output(o, csl.DataCost.new_coins_per_byte(csl.BigNum.from_str('4310'))).to_str());
        expect(BigInt(o.amount().coin().to_str()), `${c.tx_hash} output ${i}`).toBe(least);
      }
      expect(body.required_signers()).toBeUndefined();
      expect(body.reference_inputs()?.len()).toBe(2);
    }
  });
});
