// The cancel: held against Minswap's own published records and real owner cancels on mainnet,
// built with the real library, then every way it could pay someone else, spend more than the
// order, or cost the trader more is tried against the check. Each tamper is its own test, so a
// check that stops catching one fails by name.
//
// The budget (CANCEL_EX_UNITS) was measured 2026-10-24 by building these cancels and having
// mainnet's own node run Minswap's order script on them (Ogmios evaluateTransaction via Koios,
// the order supplied as an additional UTxO): 153,779 memory / 44,191,460 steps for a base
// address (the same figure as Minswap's own cancel in the fixtures), 132,087 / 37,745,306
// enterprise, 156,183 / 44,832,224 with a script stake part. The most read on chain: 173,511 / 49,897,778.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { PrivateKey, TransactionBody, TransactionInput, TransactionOutput, TransactionWitnessSet } from '@emurgo/cardano-serialization-lib-browser';
import type { Csl } from './csl';
import { readScriptParams, type ProtocolParams, type ScriptParams } from './chain';
import { bytesToHex, composeAddress, hexToBytes, type ParsedAddress } from './address';
import { ADA, MINSWAP_V2, cancelRedeemer, encodeSwapOrderDatum, lpAsset, orderAddressFor, orderValue, type CardanoAsset, type ChainUtxo, type PoolState } from './minswapV2';
import { TTL_SLOTS, type WalletUtxo } from './swapTx';
import { CANCEL_EX_UNITS, CancelBuildError, assembleCancelSigned, buildCancelTx, checkCancelTx, collateralFor, v2CostModels, type CancelPlan } from './cancelTx';
import { ASCEND, fixture, testCsl } from './testkit.fixture';

const OWNER_CANCELS = fixture<{ tx_hash: string; cbor: string }[]>('koios-tx-cbor-owner-cancels.json');
const REFERENCES = fixture<{ orderTxId: string; orderRef: string }>('minswap-v2-references-order.json');

const TIP = 201_330_000;
const ADA_1 = 1_000_000n;

let csl: Csl;
let params: ProtocolParams;
let script: ScriptParams;
let key: PrivateKey;
let trader: ParsedAddress;
let stranger: ParsedAddress;
let wallet: WalletUtxo[];

const POOL: PoolState = {
  ref: { txHash: '11'.repeat(32), index: 0 },
  assetA: ADA,
  assetB: ASCEND,
  lp: lpAsset(ADA, ASCEND),
  reserveA: 1n,
  reserveB: 1n,
  totalLiquidity: 1n,
  feeANumerator: 100n,
  feeBNumerator: 100n,
  feeSharingNumerator: 1666n,
  allowDynamicFee: false,
};

function addrOf(a: ParsedAddress) {
  return csl.Address.from_bytes(hexToBytes(a.hex));
}

function lovelace(n: bigint) {
  return csl.Value.new(csl.BigNum.from_str(n.toString()));
}

function coin(i: number, to: ParsedAddress, ada: bigint, tokens = 0n): WalletUtxo {
  const value = lovelace(ada);
  if (tokens > 0n) {
    const ma = csl.MultiAsset.new();
    ma.set_asset(csl.ScriptHash.from_hex(ASCEND.policyId), csl.AssetName.new(hexToBytes(ASCEND.assetName)), csl.BigNum.from_str(tokens.toString()));
    value.set_multiasset(ma);
  }
  const input = csl.TransactionInput.new(csl.TransactionHash.from_hex(i.toString(16).padStart(64, 'c')), i);
  return { txHash: input.transaction_id().to_hex(), index: i, hex: csl.TransactionUnspentOutput.new(input, csl.TransactionOutput.new(addrOf(to), value)).to_hex() };
}

/** An order of `owner`'s as this rail writes it, as the chain would hand it back. */
function orderOf(owner: ParsedAddress, assetIn: CardanoAsset, swapAmount: bigint, txHash = 'ab'.repeat(32), datumOwner: ParsedAddress = owner): ChainUtxo {
  const lock = orderValue({ assetIn, swapAmount });
  return {
    txHash,
    index: 0,
    addressHex: orderAddressFor(owner).hex,
    lovelace: lock.lovelace,
    assets: lock.token ? [{ policyId: lock.token.asset.policyId, assetName: lock.token.asset.assetName, quantity: lock.token.quantity }] : [],
    inlineDatumHex: encodeSwapOrderDatum(csl, { trader: datumOwner, pool: POOL, assetIn, swapAmount, minimumReceive: 1n }),
  };
}

function plan(overrides: Partial<CancelPlan> = {}): CancelPlan {
  return { trader, order: orderOf(trader, ADA, 400n * ADA_1), tipSlot: TIP, ...overrides };
}

beforeAll(async () => {
  csl = await testCsl();
  // Mainnet's parameters as Koios read them on 2026-10-24, through the page's own reader.
  const p = fixture<unknown>('koios-cli-protocol-params.json');
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(p), { status: 200, headers: { 'content-type': 'application/json' } })));
  const read = await readScriptParams();
  vi.unstubAllGlobals();
  if (read.status !== 'ok') throw new Error(read.reason);
  params = read.data.params;
  script = read.data.script;
  key = csl.PrivateKey.generate_ed25519();
  trader = composeAddress({ kind: 'key', hash: key.to_public().hash().to_hex() }, { kind: 'key', hash: '73d3e74cbd4539a7ec925ef8ad057d945e3668021cf4f3e877d24d4d' });
  stranger = composeAddress({ kind: 'key', hash: 'ee'.repeat(28) }, { kind: 'key', hash: 'ef'.repeat(28) });
  wallet = [coin(1, trader, 5n * ADA_1), coin(2, trader, 40n * ADA_1, 900n)];
});

function bodyOf(txHex: string): TransactionBody {
  return csl.TransactionBody.from_bytes(csl.FixedTransaction.from_hex(txHex).raw_body());
}

describe('Minswap’s own records', () => {
  it('reads the order script from Minswap’s published reference, at the size the fee is priced by', () => {
    // references.json `orderRef` is the reference UTxO itself, CBOR: its script is the order script.
    const u = csl.TransactionUnspentOutput.from_hex(REFERENCES.orderRef);
    expect(`${u.input().transaction_id().to_hex()}#${u.input().index()}`).toBe(REFERENCES.orderTxId);
    expect(REFERENCES.orderTxId).toBe(`${MINSWAP_V2.orderScriptRef.txHash}#${MINSWAP_V2.orderScriptRef.index}`);
    const s = u.output().script_ref()?.plutus_script();
    expect(s?.hash().to_hex()).toBe(MINSWAP_V2.orderScriptHash);
    expect(s?.bytes().length).toBe(MINSWAP_V2.orderScriptSize);
  });

  it('spends with the redeemer real owner cancels on mainnet carry, Minswap’s own among them', () => {
    expect(cancelRedeemer(csl).to_hex()).toBe('d87a80');
    for (const { cbor } of OWNER_CANCELS) {
      const tx = csl.FixedTransaction.from_hex(cbor);
      const body = csl.TransactionBody.from_bytes(tx.raw_body());
      const r = tx.witness_set().redeemers()!;
      expect(r.len()).toBe(1);
      expect(r.get(0).tag().kind()).toBe(csl.RedeemerTagKind.Spend);
      expect(r.get(0).data().to_hex()).toBe(cancelRedeemer(csl).to_hex());
      expect(BigInt(r.get(0).ex_units().mem().to_str())).toBeLessThan(CANCEL_EX_UNITS.mem);
      expect(BigInt(r.get(0).ex_units().steps().to_str())).toBeLessThan(CANCEL_EX_UNITS.steps);
      const ref = body.reference_inputs()!.get(0);
      expect(`${ref.transaction_id().to_hex()}#${ref.index()}`).toBe(REFERENCES.orderTxId);
      // The same shape this rail builds: the one order in, one output back, one signer.
      expect([body.inputs().len(), body.outputs().len(), body.required_signers()!.len()]).toEqual([1, 1, 1]);
    }
  });

  it('computes the script data hash real cancels carry, under mainnet’s cost model as read', () => {
    for (const { cbor } of OWNER_CANCELS) {
      const tx = csl.FixedTransaction.from_hex(cbor);
      const body = csl.TransactionBody.from_bytes(tx.raw_body());
      expect(csl.hash_script_data(tx.witness_set().redeemers()!, v2CostModels(csl, script)).to_hex()).toBe(body.script_data_hash()!.to_hex());
    }
  });
});

describe('buildCancelTx + checkCancelTx: the untampered build', () => {
  it('cancels an ADA → token order: everything back less the fee, from the order itself', () => {
    const p = plan();
    const built = buildCancelTx(csl, params, script, wallet, p);
    const r = checkCancelTx(csl, built.txHex, p, wallet, params, script);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.cancel.txHash).toBe(built.txHash);
    expect(r.cancel.backLovelace).toBe(404n * ADA_1 - r.cancel.networkFee);
    expect(r.cancel.backTokens).toEqual([]);
    expect(r.cancel.networkFee).toBeGreaterThan(200_000n);
    expect(r.cancel.networkFee).toBeLessThan(300_000n);
    expect(r.cancel.collateralAtRisk).toBe(collateralFor(r.cancel.networkFee, 150));
    const body = bodyOf(built.txHex);
    // No coin of the wallet is spent: only put up as collateral.
    expect(body.inputs().len()).toBe(1);
    expect(body.inputs().get(0).transaction_id().to_hex()).toBe(p.order.txHash);
    expect(body.collateral()!.get(0).transaction_id().to_hex()).toBe(wallet[0]!.txHash);
    expect(bytesToHex(body.outputs().get(0).address().to_bytes())).toBe(trader.hex);
    expect(body.required_signers()!.get(0).to_hex()).toBe(trader.payment.hash);
    expect(Number(body.ttl_bignum()!.to_str())).toBe(TIP + TTL_SLOTS);
  });

  it('cancels a token → ADA order: the coin and the ADA back', () => {
    const p = plan({ order: orderOf(trader, ASCEND, 100_000_000n) });
    const r = checkCancelTx(csl, buildCancelTx(csl, params, script, wallet, p).txHex, p, wallet, params, script);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.cancel.backTokens).toEqual([{ policyId: ASCEND.policyId, assetName: ASCEND.assetName, quantity: 100_000_000n }]);
    expect(r.cancel.backLovelace).toBe(4n * ADA_1 - r.cancel.networkFee);
  });

  it('cancels for an address with no stake part', () => {
    const t = composeAddress(trader.payment, null);
    const w = [coin(3, t, 5n * ADA_1)];
    const p = plan({ trader: t, order: orderOf(t, ADA, 10n * ADA_1) });
    expect(checkCancelTx(csl, buildCancelTx(csl, params, script, w, p).txHex, p, w, params, script).ok).toBe(true);
  });

  it('puts up a plain-ADA coin at the trader’s own key before any other, even a smaller one', () => {
    const other = composeAddress({ kind: 'key', hash: 'dd'.repeat(28) }, trader.stake);
    const w = [coin(4, other, 2n * ADA_1), coin(5, trader, 3n * ADA_1, 10n), coin(6, trader, 9n * ADA_1)];
    const body = bodyOf(buildCancelTx(csl, params, script, w, plan()).txHex);
    expect(body.collateral()!.len()).toBe(1);
    expect(body.collateral()!.get(0).index()).toBe(6);
  });

  it('refuses to build when no coin of the wallet can be collateral', () => {
    const script1 = composeAddress({ kind: 'script', hash: 'aa'.repeat(28) }, trader.stake);
    // A Byron coin CSL would take as collateral, but the check would refuse: never tried.
    const root = csl.Bip32PrivateKey.from_bip39_entropy(new Uint8Array(16).fill(3), new Uint8Array());
    const byron = csl.ByronAddress.icarus_from_key(root.to_public(), 764824073).to_address(); // mainnet's protocol magic
    const byronIn = csl.TransactionInput.new(csl.TransactionHash.from_hex('9'.repeat(64)), 9);
    const byronCoin = { txHash: '9'.repeat(64), index: 9, hex: csl.TransactionUnspentOutput.new(byronIn, csl.TransactionOutput.new(byron, lovelace(20n * ADA_1))).to_hex() };
    expect(() => buildCancelTx(csl, params, script, [coin(7, trader, 1_000_000n), coin(8, script1, 50n * ADA_1), byronCoin], plan())).toThrow(CancelBuildError);
  });
});

type Out = TransactionOutput;
type In = TransactionInput;

/**
 * Rebuilds the cancel from a changed body or witness set. CSL hands back COPIES of a body's
 * lists, so every tamper builds a new body, carrying over every field a cancel uses.
 */
function rebuild(
  txHex: string,
  edit: { outputs?: (outs: Out[]) => Out[]; inputs?: (ins: In[]) => In[]; fee?: bigint; ttl?: bigint; also?: (b: TransactionBody) => void; witness?: (ws: TransactionWitnessSet) => void },
): string {
  const tx = csl.FixedTransaction.from_hex(txHex);
  const old = csl.TransactionBody.from_bytes(tx.raw_body());
  const ins: In[] = [];
  for (let i = 0; i < old.inputs().len(); i++) ins.push(old.inputs().get(i));
  const outs: Out[] = [];
  for (let i = 0; i < old.outputs().len(); i++) outs.push(old.outputs().get(i));
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

function redeemerOf(data: string, mem: bigint, steps: bigint) {
  const rs = csl.Redeemers.new();
  rs.add(csl.Redeemer.new(csl.RedeemerTag.new_spend(), csl.BigNum.from_str('0'), csl.PlutusData.from_hex(data), csl.ExUnits.new(csl.BigNum.from_str(mem.toString()), csl.BigNum.from_str(steps.toString()))));
  return rs;
}

describe('checkCancelTx refuses every tamper', () => {
  let p: CancelPlan;
  let txHex: string;
  beforeAll(() => {
    p = plan();
    txHex = buildCancelTx(csl, params, script, wallet, p).txHex;
    expect(checkCancelTx(csl, txHex, p, wallet, params, script).ok).toBe(true);
    // The rebuild itself changes nothing a check reads: an untouched rebuild still passes.
    expect(checkCancelTx(csl, rebuild(txHex, {}), p, wallet, params, script).ok).toBe(true);
  });

  function expectRefused(bad: string, problem: RegExp, against: CancelPlan = p) {
    if (against === p) expect(bad).not.toBe(txHex);
    const r = checkCancelTx(csl, bad, against, wallet, params, script);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.join(' | ')).toMatch(problem);
  }

  it('a second output, to a stranger', () => {
    const bad = rebuild(txHex, { outputs: (o) => [withCoin(o[0]!, -ADA_1), csl.TransactionOutput.new(addrOf(stranger), lovelace(ADA_1))] });
    expectRefused(bad, /more than one output/);
  });

  it('everything paid to a stranger', () => {
    expectRefused(rebuild(txHex, { outputs: (o) => [csl.TransactionOutput.new(addrOf(stranger), o[0]!.amount())] }), /not yours/);
  });

  it('paid to your payment key with someone else’s stake part', () => {
    const lookalike = composeAddress(trader.payment, { kind: 'key', hash: 'ef'.repeat(28) });
    expectRefused(rebuild(txHex, { outputs: (o) => [csl.TransactionOutput.new(addrOf(lookalike), o[0]!.amount())] }), /not yours/);
  });

  it('less coming back, the difference paid as network fee', () => {
    const fee = BigInt(bodyOf(txHex).fee().to_str());
    expectRefused(rebuild(txHex, { fee: fee + 500_000n, outputs: (o) => [withCoin(o[0]!, -500_000n)] }), /more than this cancel needs/);
  });

  it('less coming back than the order holds', () => {
    expectRefused(rebuild(txHex, { outputs: (o) => [withCoin(o[0]!, -ADA_1)] }), /everything the order holds/);
  });

  it('a coin the order holds kept back', () => {
    const tp = plan({ order: orderOf(trader, ASCEND, 100_000_000n) });
    const tx = buildCancelTx(csl, params, script, wallet, tp).txHex;
    const bad = rebuild(tx, { outputs: (o) => [csl.TransactionOutput.new(o[0]!.address(), csl.Value.new(o[0]!.amount().coin()))] });
    const r = checkCancelTx(csl, bad, tp, wallet, params, script);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.join(' | ')).toMatch(/everything the order holds/);
  });

  it('a coin of the wallet spent beside the order', () => {
    const extra = csl.TransactionInput.new(csl.TransactionHash.from_hex(wallet[1]!.txHash), wallet[1]!.index);
    expectRefused(rebuild(txHex, { inputs: (i) => [...i, extra] }), /other than this one order/);
  });

  it('another order spent in its place', () => {
    const other = csl.TransactionInput.new(csl.TransactionHash.from_hex('ba'.repeat(32)), 0);
    expectRefused(rebuild(txHex, { inputs: () => [other] }), /other than this one order/);
  });

  it('the order script read from another reference input', () => {
    const refs = csl.TransactionInputs.new();
    refs.add(csl.TransactionInput.new(csl.TransactionHash.from_hex('ef'.repeat(32)), 0));
    expectRefused(rebuild(txHex, { also: (b) => b.set_reference_inputs(refs) }), /published copy/);
  });

  it('another key as the required signer', () => {
    const k = csl.Ed25519KeyHashes.new();
    k.add(csl.Ed25519KeyHash.from_hex('ab'.repeat(28)));
    expectRefused(rebuild(txHex, { also: (b) => b.set_required_signers(k) }), /signer other than your own/);
  });

  it('a second required signer', () => {
    const k = csl.Ed25519KeyHashes.new();
    k.add(csl.Ed25519KeyHash.from_hex(trader.payment.hash));
    k.add(csl.Ed25519KeyHash.from_hex('ab'.repeat(28)));
    expectRefused(rebuild(txHex, { also: (b) => b.set_required_signers(k) }), /signer other than your own/);
  });

  it('the order spent with ApplyOrder instead of the owner cancel', () => {
    expectRefused(rebuild(txHex, { witness: (w) => w.set_redeemers(redeemerOf('d87980', CANCEL_EX_UNITS.mem, CANCEL_EX_UNITS.steps)) }), /owner cancel/);
  });

  it('a larger script budget', () => {
    expectRefused(rebuild(txHex, { witness: (w) => w.set_redeemers(redeemerOf('d87a80', CANCEL_EX_UNITS.mem * 10n, CANCEL_EX_UNITS.steps)) }), /owner cancel/);
  });

  it('a script data hash that is not this cancel’s', () => {
    expectRefused(rebuild(txHex, { also: (b) => b.set_script_data_hash(csl.ScriptDataHash.from_hex('00'.repeat(32))) }), /script data hash/);
  });

  it('collateral from a coin that is not the wallet’s', () => {
    const c = csl.TransactionInputs.new();
    c.add(csl.TransactionInput.new(csl.TransactionHash.from_hex('ee'.repeat(32)), 1));
    expectRefused(rebuild(txHex, { also: (b) => b.set_collateral(c) }), /collateral is not a coin of this wallet/);
  });

  it('more collateral coins than the network allows', () => {
    // A set: four distinct coins, or CSL folds them into one.
    const c = csl.TransactionInputs.new();
    for (let i = 0; i < 4; i++) c.add(csl.TransactionInput.new(csl.TransactionHash.from_hex(wallet[0]!.txHash), 10 + i));
    expectRefused(rebuild(txHex, { also: (b) => b.set_collateral(c) }), /collateral is not 1 to 3 coins/);
  });

  it('the collateral returned to a stranger', () => {
    const old = bodyOf(txHex).collateral_return()!;
    expectRefused(rebuild(txHex, { also: (b) => b.set_collateral_return(csl.TransactionOutput.new(addrOf(stranger), old.amount())) }), /come back to your own address/);
  });

  it('more of the collateral put at risk', () => {
    const old = bodyOf(txHex);
    const total = BigInt(old.total_collateral()!.to_str()) + ADA_1;
    expectRefused(
      rebuild(txHex, {
        also: (b) => {
          b.set_total_collateral(csl.BigNum.from_str(total.toString()));
          b.set_collateral_return(withCoin(old.collateral_return()!, -ADA_1));
        },
      }),
      /more collateral than the network asks/,
    );
  });

  it('collateral that does not add up', () => {
    expectRefused(rebuild(txHex, { also: (b) => b.set_collateral_return(withCoin(bodyOf(txHex).collateral_return()!, -1n)) }), /collateral does not add up/);
  });

  it('a stake delegation certificate', () => {
    const certs = csl.Certificates.new();
    certs.add(csl.Certificate.new_stake_delegation(csl.StakeDelegation.new(csl.Credential.from_keyhash(csl.Ed25519KeyHash.from_hex(trader.stake!.hash)), csl.Ed25519KeyHash.from_hex('ab'.repeat(28)))));
    expectRefused(rebuild(txHex, { also: (b) => b.set_certs(certs) }), /certificate/);
  });

  it('a reward withdrawal', () => {
    const w = csl.Withdrawals.new();
    w.insert(csl.RewardAddress.new(1, csl.Credential.from_keyhash(csl.Ed25519KeyHash.from_hex(trader.stake!.hash))), csl.BigNum.from_str('5000000'));
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
      csl.Voter.new_drep_credential(csl.Credential.from_keyhash(csl.Ed25519KeyHash.from_hex(trader.payment.hash))),
      csl.GovernanceActionId.new(csl.TransactionHash.from_hex('ab'.repeat(32)), 0),
      csl.VotingProcedure.new(csl.VoteKind.Yes),
    );
    expectRefused(rebuild(txHex, { also: (b) => b.set_voting_procedures(vp) }), /votes or proposes/);
  });

  it('a donation to the treasury', () => {
    expectRefused(rebuild(txHex, { also: (b) => b.set_donation(csl.BigNum.from_str('1000000')) }), /pays the treasury/);
  });

  it('another network', () => {
    expectRefused(rebuild(txHex, { also: (b) => b.set_network_id(csl.NetworkId.testnet()) }), /another network/);
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
    expectRefused(rebuild(txHex, { witness: (w) => w.set_plutus_scripts(scripts) }), /already signed or with scripts/);
  });

  it('a transaction that arrives pre-signed', () => {
    const tx = csl.FixedTransaction.from_hex(txHex);
    tx.add_vkey_witness(csl.make_vkey_witness(tx.transaction_hash(), key));
    expectRefused(tx.to_hex(), /already signed/);
  });

  it('a coin spent that is not an order of yours at Minswap’s order script', () => {
    const other = { ...p.order, addressHex: orderAddressFor(stranger).hex };
    expectRefused(txHex, /not an order of yours/, { ...p, order: other });
  });

  it('an order whose datum names another key as its canceller', () => {
    expectRefused(txHex, /does not name your key/, { ...p, order: { ...p.order, inlineDatumHex: orderOf(trader, ADA, 400n * ADA_1, p.order.txHash, stranger).inlineDatumHex } });
  });

  it('an order whose refund is paid to another stake part', () => {
    const lookalike = composeAddress(trader.payment, { kind: 'key', hash: 'ef'.repeat(28) });
    expectRefused(txHex, /refund is not to your own address/, { ...p, order: { ...p.order, inlineDatumHex: orderOf(trader, ADA, 400n * ADA_1, p.order.txHash, lookalike).inlineDatumHex } });
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

describe('assembleCancelSigned', () => {
  function witnessFor(txHash: string, k: PrivateKey = key) {
    const ws = csl.TransactionWitnessSet.new();
    const keys = csl.Vkeywitnesses.new();
    keys.add(csl.make_vkey_witness(csl.TransactionHash.from_hex(txHash), k));
    ws.set_vkeys(keys);
    return ws;
  }

  it('adds the wallet’s signature to the checked bytes, keeping the redeemer’s bytes', () => {
    const built = buildCancelTx(csl, params, script, wallet, plan());
    const r = assembleCancelSigned(csl, built.txHex, witnessFor(built.txHash).to_hex(), built.txHash, trader.payment.hash);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.txHash).toBe(built.txHash);
    const signed = csl.FixedTransaction.from_hex(r.signedHex);
    expect(signed.raw_body()).toEqual(csl.FixedTransaction.from_hex(built.txHex).raw_body());
    expect(signed.witness_set().vkeys()!.len()).toBe(1);
    // The script data hash commits to the redeemers' bytes as sent: CSL keeps them byte for byte.
    const redeemerBytes = bytesToHex(csl.FixedTransaction.from_hex(built.txHex).raw_witness_set()).slice(4); // after a1 05
    expect(bytesToHex(signed.raw_witness_set())).toContain(redeemerBytes);
    expect(csl.hash_script_data(signed.witness_set().redeemers()!, v2CostModels(csl, script)).to_hex()).toBe(bodyOf(r.signedHex).script_data_hash()!.to_hex());
  });

  it('keeps a redeemer in any encoding byte for byte when a signature is added (CSL 17; the hash holds only so)', () => {
    const ins = csl.TransactionInputs.new();
    ins.add(csl.TransactionInput.new(csl.TransactionHash.from_hex('ab'.repeat(32)), 0));
    const body = csl.TransactionBody.new_tx_body(ins, csl.TransactionOutputs.new(), csl.BigNum.from_str('200000'));
    for (const r of ['a182000082d87a80821a0003f7a01a047868c0', '81840000d87a80821a0003f7a01a047868c0', '9f840000d87a80821a0003f7a01a047868c0ff']) {
      const tx = csl.FixedTransaction.new(body.to_bytes(), hexToBytes(`a105${r}`), true);
      tx.add_vkey_witness(csl.make_vkey_witness(tx.transaction_hash(), key));
      expect(bytesToHex(tx.raw_witness_set())).toContain(r);
    }
  });

  it('refuses a signature from another key alone', () => {
    const built = buildCancelTx(csl, params, script, wallet, plan());
    const r = assembleCancelSigned(csl, built.txHex, witnessFor(built.txHash, csl.PrivateKey.generate_ed25519()).to_hex(), built.txHash, trader.payment.hash);
    expect(r).toEqual({ ok: false, reason: 'The wallet did not sign with the key that placed this order.' });
  });

  it('refuses an empty answer', () => {
    const built = buildCancelTx(csl, params, script, wallet, plan());
    expect(assembleCancelSigned(csl, built.txHex, csl.TransactionWitnessSet.new().to_hex(), built.txHash, trader.payment.hash)).toEqual({ ok: false, reason: 'The wallet did not sign.' });
  });

  it('refuses a witness set carrying more than signatures', () => {
    const built = buildCancelTx(csl, params, script, wallet, plan());
    const ws = witnessFor(built.txHash);
    ws.set_redeemers(redeemerOf('d87980', 1n, 1n));
    expect(assembleCancelSigned(csl, built.txHex, ws.to_hex(), built.txHash, trader.payment.hash)).toEqual({ ok: false, reason: 'The wallet added something besides its signature.' });
  });

  it('refuses when the body is not the one that was checked', () => {
    const built = buildCancelTx(csl, params, script, wallet, plan());
    expect(assembleCancelSigned(csl, built.txHex, witnessFor(built.txHash).to_hex(), 'ab'.repeat(32), trader.payment.hash).ok).toBe(false);
  });
});
