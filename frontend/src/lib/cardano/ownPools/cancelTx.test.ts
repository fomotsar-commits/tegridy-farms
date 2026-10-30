// An owner's cancel of an add or remove order at the venue's own order script (the batcher's
// test world): built with the real library, then every way it could pay someone else, reach
// Minswap, spend more than the order or cost the owner more is tried against the check, one test
// each, so a check that stops catching one fails by name.
//
// Run through our compiled order script with Aiken 1.0.24 `tx simulate` (2026-10-30), these
// cancels pass: the world's deposit order 157,654 memory / 56,371,974 steps, its withdraw order
// 159,156 / 57,006,463. The same cancel naming another key as its signer fails in the script.
import { beforeAll, describe, expect, it } from 'vitest';
import type { PrivateKey, TransactionBody, TransactionInput, TransactionOutput, TransactionWitnessSet } from '@emurgo/cardano-serialization-lib-browser';
import type { Csl } from '../csl';
import { bytesToHex, composeAddress, hexToBytes, type ParsedAddress } from '../address';
import { cancelRedeemer, encodeDepositStep, encodeOrderDatum, encodeWithdrawStep, orderAddressFor, type ChainUtxo } from '../minswapV2';
import { TTL_SLOTS, type WalletUtxo } from '../orderTx';
import { testCsl } from '../testkit.fixture';
import { readOwnPoolsDeployment, type OwnPools } from './deployment';
import { costModels } from './openPoolTx';
import { assembleSignedLpCancel, buildLpCancelTx, cancelPledge, checkLpCancelTx, LP_CANCEL_EX_UNITS, LpCancelBuildError, type LpCancelPlan } from './cancelTx';
import { PARAMS, PLUTUS, TEST_RECORD, WORLD, trader, walletUtxo } from './testWorld.fixture';

const TIP = 201_255_884;
const ADA_1 = 1_000_000n;
/** Minswap V2 deployed/mainnet/references.json orderTxId: Minswap's copy of its order script. */
const MINSWAP_ORDER_REF = { txHash: 'cf4ecddde0d81f9ce8fcc881a85eb1f8ccdaf6807f03fea4cd02da896a621776', index: 0 };

let csl: Csl;
let dep: OwnPools;
let key: PrivateKey;
let owner: ParsedAddress;
let stranger: ParsedAddress;
let wallet: WalletUtxo[];

const lpOf = () => ({ policyId: dep.authenPolicy, assetName: WORLD.lpName });

/** An add order of `who`'s as this site writes it (lpTx.ts), as the chain would hand it back. */
function depositOrder(who: ParsedAddress, datumOwner: ParsedAddress = who, txHash = 'ab'.repeat(32)): ChainUtxo {
  const datum = encodeOrderDatum(csl, { trader: datumOwner, lp: lpOf(), step: encodeDepositStep(csl, 10n * ADA_1, 500_000_000n, 2_000_000n), maxBatcherFee: dep.batcherFee });
  return {
    txHash,
    index: 0,
    addressHex: orderAddressFor(who, dep).hex,
    lovelace: 10n * ADA_1 + dep.batcherFee + 2n * ADA_1,
    assets: [{ policyId: WORLD.token.policyId, assetName: WORLD.token.assetName, quantity: 500_000_000n }],
    inlineDatumHex: datum,
  };
}

function withdrawOrder(who: ParsedAddress): ChainUtxo {
  const datum = encodeOrderDatum(csl, { trader: who, lp: lpOf(), step: encodeWithdrawStep(csl, 1_000_000n, 4_000_000n, 200_000_000n), maxBatcherFee: dep.batcherFee });
  return {
    txHash: 'ac'.repeat(32),
    index: 0,
    addressHex: orderAddressFor(who, dep).hex,
    lovelace: dep.batcherFee + 2n * ADA_1,
    assets: [{ ...lpOf(), quantity: 1_000_000n }],
    inlineDatumHex: datum,
  };
}

function plan(over: Partial<LpCancelPlan> = {}): LpCancelPlan {
  return { trader: owner, order: depositOrder(owner), tipSlot: TIP, ...over };
}

const build = (p: LpCancelPlan, w: WalletUtxo[] = wallet) => buildLpCancelTx(csl, dep, PARAMS, PLUTUS, w, p);
const check = (txHex: string, p: LpCancelPlan, w: WalletUtxo[] = wallet) => checkLpCancelTx(csl, dep, txHex, p, w, PARAMS, PLUTUS);

beforeAll(async () => {
  csl = await testCsl();
  const r = readOwnPoolsDeployment(TEST_RECORD);
  if (r.kind !== 'deployed') throw new Error(`test record refused: ${JSON.stringify(r)}`);
  dep = r.pools;
  key = csl.PrivateKey.from_normal_bytes(new Uint8Array(32).fill(0x41));
  owner = composeAddress({ kind: 'key', hash: key.to_public().hash().to_hex() }, { kind: 'key', hash: '73'.repeat(28) });
  stranger = composeAddress({ kind: 'key', hash: 'ee'.repeat(28) }, { kind: 'key', hash: 'ef'.repeat(28) });
  wallet = [walletUtxo(csl, 1, owner, 3n * ADA_1), walletUtxo(csl, 2, owner, 40n * ADA_1, [[WORLD.token.policyId, WORLD.token.assetName, 9n]]), walletUtxo(csl, 3, owner, 6n * ADA_1)];
});

function bodyOf(txHex: string): TransactionBody {
  return csl.TransactionBody.from_bytes(csl.FixedTransaction.from_hex(txHex).raw_body());
}

describe('buildLpCancelTx + checkLpCancelTx: the untampered build', () => {
  it('cancels the test world’s own add and remove orders (the datums the batcher fills, byte for byte)', () => {
    const cases = [
      { who: '1' as const, datum: WORLD.orders.deposit.datumHex, lovelace: 14n * ADA_1, assets: [{ policyId: WORLD.token.policyId, assetName: WORLD.token.assetName, quantity: 500_000_000n }] },
      { who: '2' as const, datum: WORLD.orders.withdraw.datumHex, lovelace: 4n * ADA_1, assets: [{ ...lpOf(), quantity: 1_000_000n }] },
    ];
    for (const c of cases) {
      const t = trader(c.who);
      const order: ChainUtxo = { txHash: 'ab'.repeat(32), index: 0, addressHex: orderAddressFor(t, dep).hex, lovelace: c.lovelace, assets: c.assets, inlineDatumHex: c.datum };
      const w = [walletUtxo(csl, 1, t, 9n * ADA_1)];
      const p = { trader: t, order, tipSlot: TIP };
      const r = check(build(p, w).txHex, p, w);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.cancel.backTokens).toEqual(c.assets);
    }
  });

  it('gives back everything an add order holds, less the network fee, from the order itself', () => {
    const p = plan();
    const built = build(p);
    const r = check(built.txHex, p);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.cancel.txHash).toBe(built.txHash);
    expect(r.cancel.backLovelace).toBe(p.order.lovelace - r.cancel.networkFee);
    expect(r.cancel.backTokens).toEqual(p.order.assets);
    expect(r.cancel.networkFee).toBeGreaterThan(200_000n);
    expect(r.cancel.networkFee).toBeLessThan(300_000n);
    expect(r.cancel.collateralPledged).toBe(cancelPledge(PLUTUS));
    const body = bodyOf(built.txHex);
    // No coin of the wallet is spent: the smallest plain-ADA coin of at least 5 ADA is only pledged.
    expect(body.inputs().len()).toBe(1);
    expect(body.inputs().get(0).transaction_id().to_hex()).toBe(p.order.txHash);
    expect(body.collateral()!.get(0).index()).toBe(3);
    // OUR order script, from the record's reference UTxO.
    expect(`${body.reference_inputs()!.get(0).transaction_id().to_hex()}#${body.reference_inputs()!.get(0).index()}`).toBe(TEST_RECORD.orderRef.ref);
    expect(bytesToHex(body.outputs().get(0).address().to_bytes())).toBe(owner.hex);
    expect(body.required_signers()!.get(0).to_hex()).toBe(owner.payment.hash);
    expect(Number(body.ttl_bignum()!.to_str())).toBe(TIP + TTL_SLOTS);
    const rs = csl.FixedTransaction.from_hex(built.txHex).witness_set().redeemers()!;
    expect(rs.get(0).data().to_hex()).toBe('d87a80'); // CancelOrderByOwner, types.ak OrderRedeemer constructor 1
  });

  it('gives back a remove order’s LP tokens', () => {
    const p = plan({ order: withdrawOrder(owner) });
    const r = check(build(p).txHex, p);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.cancel.backTokens).toEqual([{ ...lpOf(), quantity: 1_000_000n }]);
  });

  it('cancels for an address with no stake part', () => {
    const t = composeAddress(owner.payment, null);
    const w = [walletUtxo(csl, 4, t, 5n * ADA_1)];
    const p = plan({ trader: t, order: depositOrder(t) });
    expect(check(build(p, w).txHex, p, w).ok).toBe(true);
  });

  it('pins a budget above what our order script used, so the node never refuses it as too small', () => {
    expect(LP_CANCEL_EX_UNITS.mem).toBeGreaterThan(159_156n);
    expect(LP_CANCEL_EX_UNITS.steps).toBeGreaterThan(57_006_463n);
  });

  it('refuses to build without a plain-ADA coin of 5 ADA at the owner’s address to pledge', () => {
    const elsewhere = composeAddress({ kind: 'key', hash: 'dd'.repeat(28) }, owner.stake);
    const w = [walletUtxo(csl, 5, owner, 4n * ADA_1), walletUtxo(csl, 6, owner, 50n * ADA_1, [[WORLD.token.policyId, WORLD.token.assetName, 1n]]), walletUtxo(csl, 7, elsewhere, 50n * ADA_1)];
    expect(() => build(plan(), w)).toThrow(LpCancelBuildError);
  });
});

type Out = TransactionOutput;
type In = TransactionInput;

/** The cancel rebuilt from a changed body or witness set (CSL hands back COPIES of a body's lists). */
function rebuild(
  txHex: string,
  edit: { outputs?: (outs: Out[]) => Out[]; inputs?: (ins: In[]) => In[]; fee?: bigint; ttl?: bigint; also?: (b: TransactionBody) => void; witness?: (ws: TransactionWitnessSet) => void },
): string {
  const tx = csl.FixedTransaction.from_hex(txHex);
  const old = csl.TransactionBody.from_bytes(tx.raw_body());
  const ins: In[] = Array.from({ length: old.inputs().len() }, (_, i) => old.inputs().get(i));
  const outs: Out[] = Array.from({ length: old.outputs().len() }, (_, i) => old.outputs().get(i));
  const newIns = csl.TransactionInputs.new();
  for (const i of edit.inputs ? edit.inputs(ins) : ins) newIns.add(i);
  const newOuts = csl.TransactionOutputs.new();
  for (const o of edit.outputs ? edit.outputs(outs) : outs) newOuts.add(o);
  const body = csl.TransactionBody.new_tx_body(newIns, newOuts, edit.fee === undefined ? old.fee() : csl.BigNum.from_str(edit.fee.toString()));
  body.set_ttl(edit.ttl === undefined ? old.ttl_bignum()! : csl.BigNum.from_str(edit.ttl.toString()));
  body.set_reference_inputs(old.reference_inputs()!);
  body.set_collateral(old.collateral()!);
  body.set_collateral_return(old.collateral_return()!);
  body.set_total_collateral(old.total_collateral()!);
  body.set_required_signers(old.required_signers()!);
  body.set_script_data_hash(old.script_data_hash()!);
  edit.also?.(body);
  let ws = tx.raw_witness_set();
  if (edit.witness) {
    const w = csl.TransactionWitnessSet.from_bytes(ws);
    edit.witness(w);
    ws = w.to_bytes();
  }
  return csl.FixedTransaction.new(body.to_bytes(), ws, true).to_hex();
}

function withCoin(o: Out, delta: bigint): Out {
  const v = o.amount();
  v.set_coin(csl.BigNum.from_str((BigInt(v.coin().to_str()) + delta).toString()));
  return csl.TransactionOutput.new(o.address(), v);
}

const addrOf = (a: ParsedAddress) => csl.Address.from_bytes(hexToBytes(a.hex));
const lovelace = (n: bigint) => csl.Value.new(csl.BigNum.from_str(n.toString()));

function redeemerOf(data: string, mem: bigint, steps: bigint) {
  const rs = csl.Redeemers.new();
  rs.add(csl.Redeemer.new(csl.RedeemerTag.new_spend(), csl.BigNum.from_str('0'), csl.PlutusData.from_hex(data), csl.ExUnits.new(csl.BigNum.from_str(mem.toString()), csl.BigNum.from_str(steps.toString()))));
  return rs;
}

function inputs(...refs: { txHash: string; index: number }[]) {
  const l = csl.TransactionInputs.new();
  for (const r of refs) l.add(csl.TransactionInput.new(csl.TransactionHash.from_hex(r.txHash), r.index));
  return l;
}

function signers(...hashes: string[]) {
  const k = csl.Ed25519KeyHashes.new();
  for (const h of hashes) k.add(csl.Ed25519KeyHash.from_hex(h));
  return k;
}

describe('checkLpCancelTx refuses every tamper', () => {
  let p: LpCancelPlan;
  let txHex: string;
  beforeAll(() => {
    p = plan();
    txHex = build(p).txHex;
    expect(check(txHex, p).ok).toBe(true);
    // The rebuild itself changes nothing a check reads: an untouched rebuild still passes.
    expect(check(rebuild(txHex, {}), p).ok).toBe(true);
  });

  function expectRefused(bad: string, problem: RegExp, against: LpCancelPlan = p) {
    if (against === p) expect(bad).not.toBe(txHex);
    const r = check(bad, against);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.join(' | ')).toMatch(problem);
  }

  it('a second output, to a stranger', () => {
    expectRefused(rebuild(txHex, { outputs: (o) => [withCoin(o[0]!, -ADA_1), csl.TransactionOutput.new(addrOf(stranger), lovelace(ADA_1))] }), /more than one output/);
  });

  it('everything paid to a stranger', () => {
    expectRefused(rebuild(txHex, { outputs: (o) => [csl.TransactionOutput.new(addrOf(stranger), o[0]!.amount())] }), /not yours/);
  });

  it('paid to your payment key with someone else’s stake part', () => {
    const lookalike = composeAddress(owner.payment, { kind: 'key', hash: 'ef'.repeat(28) });
    expectRefused(rebuild(txHex, { outputs: (o) => [csl.TransactionOutput.new(addrOf(lookalike), o[0]!.amount())] }), /not yours/);
  });

  it('nothing paid back', () => {
    expectRefused(rebuild(txHex, { outputs: () => [] }), /pays nothing back/);
  });

  it('less coming back, the difference paid as network fee', () => {
    const fee = BigInt(bodyOf(txHex).fee().to_str());
    expectRefused(rebuild(txHex, { fee: fee + 500_000n, outputs: (o) => [withCoin(o[0]!, -500_000n)] }), /more than this cancel needs/);
  });

  it('less coming back than the order holds', () => {
    expectRefused(rebuild(txHex, { outputs: (o) => [withCoin(o[0]!, -ADA_1)] }), /everything the order holds/);
  });

  it('the order’s coin kept back', () => {
    expectRefused(rebuild(txHex, { outputs: (o) => [csl.TransactionOutput.new(o[0]!.address(), csl.Value.new(o[0]!.amount().coin()))] }), /everything the order holds/);
  });

  it('what comes back sent with a datum', () => {
    const bad = rebuild(txHex, {
      outputs: (o) => {
        const x = csl.TransactionOutput.new(o[0]!.address(), o[0]!.amount());
        x.set_plutus_data(csl.PlutusData.from_hex('d87980'));
        return [x];
      },
    });
    expectRefused(bad, /carries a datum or a script/);
  });

  it('a coin of the wallet spent beside the order', () => {
    expectRefused(rebuild(txHex, { inputs: (i) => [...i, csl.TransactionInput.new(csl.TransactionHash.from_hex(wallet[1]!.txHash), wallet[1]!.index)] }), /other than this one order/);
  });

  it('another order spent in its place', () => {
    expectRefused(rebuild(txHex, { inputs: () => [csl.TransactionInput.new(csl.TransactionHash.from_hex('ba'.repeat(32)), 0)] }), /other than this one order/);
  });

  it('the order script read from Minswap’s copy', () => {
    expectRefused(rebuild(txHex, { also: (b) => b.set_reference_inputs(inputs(MINSWAP_ORDER_REF)) }), /venue’s own copy/);
  });

  it('a second reference input beside ours', () => {
    expectRefused(rebuild(txHex, { also: (b) => b.set_reference_inputs(inputs(dep.orderRef, { txHash: 'ef'.repeat(32), index: 0 })) }), /venue’s own copy/);
  });

  it('another key as the required signer', () => {
    expectRefused(rebuild(txHex, { also: (b) => b.set_required_signers(signers('ab'.repeat(28))) }), /signer other than your own/);
  });

  it('a second required signer', () => {
    expectRefused(rebuild(txHex, { also: (b) => b.set_required_signers(signers(owner.payment.hash, 'ab'.repeat(28))) }), /signer other than your own/);
  });

  it('the order spent with ApplyOrder instead of the owner’s cancel', () => {
    expectRefused(rebuild(txHex, { witness: (w) => w.set_redeemers(redeemerOf('d87980', LP_CANCEL_EX_UNITS.mem, LP_CANCEL_EX_UNITS.steps)) }), /owner’s cancel/);
  });

  it('the order spent with CancelExpiredOrderByAnyone', () => {
    expectRefused(rebuild(txHex, { witness: (w) => w.set_redeemers(redeemerOf('d87b80', LP_CANCEL_EX_UNITS.mem, LP_CANCEL_EX_UNITS.steps)) }), /owner’s cancel/);
  });

  it('a larger script budget', () => {
    expectRefused(rebuild(txHex, { witness: (w) => w.set_redeemers(redeemerOf('d87a80', LP_CANCEL_EX_UNITS.mem * 10n, LP_CANCEL_EX_UNITS.steps)) }), /owner’s cancel/);
  });

  it('a script data hash that is not this cancel’s', () => {
    expectRefused(rebuild(txHex, { also: (b) => b.set_script_data_hash(csl.ScriptDataHash.from_hex('00'.repeat(32))) }), /script data/);
  });

  it('a pledge from a coin that is not the wallet’s', () => {
    expectRefused(rebuild(txHex, { also: (b) => b.set_collateral(inputs({ txHash: 'ee'.repeat(32), index: 1 })) }), /not a plain ADA coin of this wallet/);
  });

  it('a pledge from a coin carrying a token', () => {
    expectRefused(rebuild(txHex, { also: (b) => b.set_collateral(inputs(wallet[1]!)) }), /not a plain ADA coin of this wallet/);
  });

  it('a pledge of two coins', () => {
    expectRefused(rebuild(txHex, { also: (b) => b.set_collateral(inputs(wallet[0]!, wallet[2]!)) }), /pledge is not one coin/);
  });

  it('the pledge returned to a stranger', () => {
    const old = bodyOf(txHex).collateral_return()!;
    expectRefused(rebuild(txHex, { also: (b) => b.set_collateral_return(csl.TransactionOutput.new(addrOf(stranger), old.amount())) }), /pledge does not come back to you/);
  });

  it('more of the pledge put at risk', () => {
    const old = bodyOf(txHex);
    const total = BigInt(old.total_collateral()!.to_str()) + ADA_1;
    const bad = rebuild(txHex, {
      also: (b) => {
        b.set_total_collateral(csl.BigNum.from_str(total.toString()));
        b.set_collateral_return(withCoin(old.collateral_return()!, -ADA_1));
      },
    });
    expectRefused(bad, /pledges more than the network asks/);
  });

  it('less pledged than the network asks', () => {
    const old = bodyOf(txHex);
    const bad = rebuild(txHex, {
      also: (b) => {
        b.set_total_collateral(csl.BigNum.from_str('100000'));
        b.set_collateral_return(withCoin(old.collateral_return()!, BigInt(old.total_collateral()!.to_str()) - 100_000n));
      },
    });
    expectRefused(bad, /pledges less than the network asks/);
  });

  it('a pledge that does not add up', () => {
    expectRefused(rebuild(txHex, { also: (b) => b.set_collateral_return(withCoin(bodyOf(txHex).collateral_return()!, -1n)) }), /pledge does not add up/);
  });

  it('a stake delegation certificate', () => {
    const certs = csl.Certificates.new();
    certs.add(csl.Certificate.new_stake_delegation(csl.StakeDelegation.new(csl.Credential.from_keyhash(csl.Ed25519KeyHash.from_hex(owner.stake!.hash)), csl.Ed25519KeyHash.from_hex('ab'.repeat(28)))));
    expectRefused(rebuild(txHex, { also: (b) => b.set_certs(certs) }), /certificate/);
  });

  it('a reward withdrawal', () => {
    const w = csl.Withdrawals.new();
    w.insert(csl.RewardAddress.new(1, csl.Credential.from_keyhash(csl.Ed25519KeyHash.from_hex(owner.stake!.hash))), csl.BigNum.from_str('5000000'));
    expectRefused(rebuild(txHex, { also: (b) => b.set_withdrawals(w) }), /withdraws rewards/);
  });

  it('a mint', () => {
    const m = csl.Mint.new();
    const assets = csl.MintAssets.new();
    assets.insert(csl.AssetName.new(hexToBytes('41')), csl.Int.new_i32(1));
    m.insert(csl.ScriptHash.from_hex('ab'.repeat(28)), assets);
    expectRefused(rebuild(txHex, { also: (b) => b.set_mint(m) }), /mints or burns/);
  });

  it('a vote', () => {
    const vp = csl.VotingProcedures.new();
    vp.insert(
      csl.Voter.new_drep_credential(csl.Credential.from_keyhash(csl.Ed25519KeyHash.from_hex(owner.payment.hash))),
      csl.GovernanceActionId.new(csl.TransactionHash.from_hex('ab'.repeat(32)), 0),
      csl.VotingProcedure.new(csl.VoteKind.Yes),
    );
    expectRefused(rebuild(txHex, { also: (b) => b.set_voting_procedures(vp) }), /votes or proposes/);
  });

  it('a donation to Cardano’s treasury', () => {
    expectRefused(rebuild(txHex, { also: (b) => b.set_donation(csl.BigNum.from_str('1000000')) }), /treasury/);
  });

  it('another network', () => {
    expectRefused(rebuild(txHex, { also: (b) => b.set_network_id(csl.NetworkId.testnet()) }), /another network/);
  });

  it('metadata', () => {
    const tx = csl.FixedTransaction.from_hex(txHex);
    const aux = csl.AuxiliaryData.new();
    const md = csl.GeneralTransactionMetadata.new();
    md.insert(csl.BigNum.from_str('674'), csl.TransactionMetadatum.new_text('hi'));
    aux.set_metadata(md);
    expectRefused(csl.FixedTransaction.new_with_auxiliary(tx.raw_body(), tx.raw_witness_set(), aux.to_bytes(), true).to_hex(), /metadata/);
  });

  it('a different expiry', () => {
    expectRefused(rebuild(txHex, { ttl: BigInt(TIP + TTL_SLOTS + 86_400) }), /expiry/);
  });

  it('a start time', () => {
    expectRefused(rebuild(txHex, { also: (b) => b.set_validity_start_interval_bignum(csl.BigNum.from_str(String(TIP))) }), /start time/);
  });

  it('a network fee above 1 ADA', () => {
    const fee = BigInt(bodyOf(txHex).fee().to_str());
    expectRefused(rebuild(txHex, { fee: fee + 2n * ADA_1, outputs: (o) => [withCoin(o[0]!, -2n * ADA_1)] }), /above 1 ADA/);
  });

  it('a network fee below what the network accepts', () => {
    const fee = BigInt(bodyOf(txHex).fee().to_str());
    expectRefused(rebuild(txHex, { fee: fee - 50_000n, outputs: (o) => [withCoin(o[0]!, 50_000n)] }), /below what the network accepts/);
  });

  it('a script carried inline', () => {
    const scripts = csl.PlutusScripts.new();
    scripts.add(csl.PlutusScript.from_bytes_v2(hexToBytes('4e4d01000033222220051200120011')));
    expectRefused(rebuild(txHex, { witness: (w) => w.set_plutus_scripts(scripts) }), /already signed or carrying scripts/);
  });

  it('a transaction that arrives pre-signed', () => {
    const tx = csl.FixedTransaction.from_hex(txHex);
    tx.add_vkey_witness(csl.make_vkey_witness(tx.transaction_hash(), key));
    expectRefused(tx.to_hex(), /already signed/);
  });

  it('an order at Minswap’s order script, not the venue’s', () => {
    expectRefused(txHex, /not an order of yours at the venue’s order script/, { ...p, order: { ...p.order, addressHex: orderAddressFor(owner).hex } });
  });

  it('an order of someone else’s', () => {
    expectRefused(txHex, /not an order of yours/, { ...p, order: { ...p.order, addressHex: orderAddressFor(stranger, dep).hex } });
  });

  it('an order whose datum names another key as its canceller', () => {
    expectRefused(txHex, /does not name your key/, { ...p, order: { ...p.order, inlineDatumHex: depositOrder(owner, stranger).inlineDatumHex } });
  });

  it('an order whose refund is paid to another stake part', () => {
    const lookalike = composeAddress(owner.payment, { kind: 'key', hash: 'ef'.repeat(28) });
    expectRefused(txHex, /refund is not to your own address/, { ...p, order: { ...p.order, inlineDatumHex: depositOrder(owner, lookalike).inlineDatumHex } });
  });

  it('an order whose refund is paid with a datum of its own', () => {
    // refund_receiver_datum: EODDatumHash (Constr 1 [hash]) in place of EODNoDatum.
    const c = csl.PlutusData.from_hex(p.order.inlineDatumHex!).as_constr_plutus_data()!;
    const fields = csl.PlutusList.new();
    const hash = csl.PlutusList.new();
    hash.add(csl.PlutusData.new_bytes(new Uint8Array(32).fill(1)));
    for (let i = 0; i < c.data().len(); i++) fields.add(i === 2 ? csl.PlutusData.new_constr_plutus_data(csl.ConstrPlutusData.new(csl.BigNum.from_str('1'), hash)) : c.data().get(i));
    const datum = csl.PlutusData.new_constr_plutus_data(csl.ConstrPlutusData.new(csl.BigNum.from_str('0'), fields)).to_hex();
    expectRefused(txHex, /refund is not to your own address/, { ...p, order: { ...p.order, inlineDatumHex: datum } });
  });

  it('an order whose terms cannot be read', () => {
    expectRefused(txHex, /terms could not be read/, { ...p, order: { ...p.order, inlineDatumHex: 'd87980' } });
  });
});

describe('assembleSignedLpCancel', () => {
  function witnessFor(txHash: string, k: PrivateKey = key) {
    const ws = csl.TransactionWitnessSet.new();
    const keys = csl.Vkeywitnesses.new();
    keys.add(csl.make_vkey_witness(csl.TransactionHash.from_hex(txHash), k));
    ws.set_vkeys(keys);
    return ws;
  }

  it('adds the owner’s signature to the checked bytes, keeping the redeemer’s bytes', () => {
    const built = build(plan());
    const r = assembleSignedLpCancel(csl, built.txHex, witnessFor(built.txHash).to_hex(), built.txHash, owner.payment.hash);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.txHash).toBe(built.txHash);
    const signed = csl.FixedTransaction.from_hex(r.signedHex);
    expect(signed.raw_body()).toEqual(csl.FixedTransaction.from_hex(built.txHex).raw_body());
    expect(signed.witness_set().vkeys()!.len()).toBe(1);
    // The script data hash commits to the redeemers' bytes as sent.
    const redeemerBytes = bytesToHex(csl.FixedTransaction.from_hex(built.txHex).witness_set().redeemers()!.to_bytes());
    expect(bytesToHex(signed.raw_witness_set())).toContain(redeemerBytes);
    expect(csl.hash_script_data(signed.witness_set().redeemers()!, costModels(csl, PLUTUS)).to_hex()).toBe(bodyOf(r.signedHex).script_data_hash()!.to_hex());
  });

  it('refuses a signature from another key alone', () => {
    const built = build(plan());
    const r = assembleSignedLpCancel(csl, built.txHex, witnessFor(built.txHash, csl.PrivateKey.generate_ed25519()).to_hex(), built.txHash, owner.payment.hash);
    expect(r).toEqual({ ok: false, reason: 'The wallet did not sign with the key that placed this order.' });
  });

  it('refuses an empty answer', () => {
    const built = build(plan());
    expect(assembleSignedLpCancel(csl, built.txHex, csl.TransactionWitnessSet.new().to_hex(), built.txHash, owner.payment.hash)).toEqual({ ok: false, reason: 'The wallet did not sign.' });
  });

  it('refuses a witness set carrying more than signatures', () => {
    const built = build(plan());
    const ws = witnessFor(built.txHash);
    ws.set_redeemers(redeemerOf('d87980', 1n, 1n));
    expect(assembleSignedLpCancel(csl, built.txHex, ws.to_hex(), built.txHash, owner.payment.hash)).toEqual({ ok: false, reason: 'The wallet added something besides its signature.' });
  });

  it('refuses when the body is not the one that was checked', () => {
    const built = build(plan());
    expect(assembleSignedLpCancel(csl, built.txHex, witnessFor(built.txHash).to_hex(), 'ab'.repeat(32), owner.payment.hash).ok).toBe(false);
  });
});

describe('the owner-cancel redeemer', () => {
  it('is types.ak OrderRedeemer’s second constructor, CancelOrderByOwner', () => {
    expect(cancelRedeemer(csl).to_hex()).toBe('d87a80');
  });
});
