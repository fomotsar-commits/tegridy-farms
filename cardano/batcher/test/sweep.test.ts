// The sweep to the two-key treasury: the treasury must be a script needing at least two distinct
// keys, and the address paid to it; the sweep spends only the batcher's plain ADA, pays exactly
// `keep` back and the rest, less the ledger's own fee, to the treasury; and before the key signs,
// anything else in the transaction (an output, a token, a mint, a withdrawal, a donation...) is
// refused by name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { ledgerMinFee } from '../src/fee.ts';
import { MAX_SWEEP_INPUTS, buildSweep, checkTreasury, verifySweep, type Treasury } from '../src/sweep.ts';
import { BATCHER_ADDRESS, BATCHER_KEY, PP, utxo, value } from './world.ts';

const ADA = 1_000_000n;
const kh = (b: string) => CSL.Ed25519KeyHash.from_hex(b.repeat(28));
const pubkey = (b: string) => CSL.NativeScript.new_script_pubkey(CSL.ScriptPubkey.new(kh(b)));
const scripts = (...s: CSL.NativeScript[]) => {
  const l = CSL.NativeScripts.new();
  for (const x of s) l.add(x);
  return l;
};
const allOf = (...keys: string[]) => CSL.NativeScript.new_script_all(CSL.ScriptAll.new(scripts(...keys.map(pubkey))));
const nOf = (n: number, ...keys: string[]) => CSL.NativeScript.new_script_n_of_k(CSL.ScriptNOfK.new(n, scripts(...keys.map(pubkey))));
const addressOf = (s: CSL.NativeScript, network = 1) => CSL.EnterpriseAddress.new(network, CSL.Credential.from_scripthash(s.hash())).to_address().to_bech32(undefined);
const treasuryOf = (s: CSL.NativeScript): Treasury => ({ address: addressOf(s), script: s.to_hex() });

const TREASURY = treasuryOf(allOf('c1', 'c2'));

test('the treasury: a script of at least two distinct keys, "all of" or "at least n of", that the address is paid to', () => {
  assert.deepEqual(checkTreasury(TREASURY, 1), TREASURY);
  const twoOfThree = treasuryOf(nOf(2, 'c1', 'c2', 'c3'));
  assert.deepEqual(checkTreasury(twoOfThree, 1), twoOfThree);
  // Base address (a stake part of its own), as Lace gives a shared wallet's: the payment part decides.
  const base = CSL.BaseAddress.new(1, CSL.Credential.from_scripthash(allOf('c1', 'c2').hash()), CSL.Credential.from_scripthash(allOf('d1', 'd2').hash())).to_address().to_bech32(undefined);
  assert.equal(checkTreasury({ address: base, script: TREASURY.script }, 1).address, base);
  const refused: [{ address?: unknown; script?: unknown }, RegExp][] = [
    [treasuryOf(allOf('c1')), /needs 1 key to spend: it must need at least two/],
    [treasuryOf(nOf(1, 'c1', 'c2')), /needs 1 key to spend/],
    [treasuryOf(CSL.NativeScript.new_script_any(CSL.ScriptAny.new(scripts(pubkey('c1'), pubkey('c2'))))), /must be "all of" or "at least n of"/],
    [treasuryOf(allOf('c1', 'c1')), /names one key twice/],
    [treasuryOf(CSL.NativeScript.new_script_all(CSL.ScriptAll.new(scripts(pubkey('c1'), pubkey('c2'), CSL.NativeScript.new_timelock_start(CSL.TimelockStart.new_timelockstart(CSL.BigNum.from_str('1'))))))), /every part of the treasury script must be a key/],
    [treasuryOf(CSL.NativeScript.new_script_all(CSL.ScriptAll.new(scripts(allOf('c1', 'c2'), pubkey('c3'))))), /every part of the treasury script must be a key/],
    [{ address: BATCHER_ADDRESS.to_bech32(undefined), script: TREASURY.script }, /paid to one key, not a script/],
    [{ address: addressOf(allOf('c1', 'c2'), 0), script: TREASURY.script }, /not a mainnet address/],
    [{ address: addressOf(allOf('c1', 'c3')), script: TREASURY.script }, /not the script sweep.treasury is paid to/],
    [{ address: TREASURY.address, script: 'not hex' }, /not a script, as hex/],
    [{ address: TREASURY.address, script: `${'81'.repeat(80)}00` }, /not a script, as hex/],
    [{ address: TREASURY.address, script: '820000' }, /not a native script|not the script/],
    [{ address: 'addr1nope', script: TREASURY.script }, /not an address/],
    [{ address: TREASURY.address }, /must be the treasury's address and its payment script/],
  ];
  for (const [t, why] of refused) assert.throws(() => checkTreasury(t, 1), why, JSON.stringify(t));
});

const plain = (i: number, ada: bigint) => utxo(`${(0x40 + i).toString(16).padStart(2, '0').repeat(32)}#0`, BATCHER_ADDRESS, value(ada * ADA));
const BATCHER = { keyHash: BATCHER_KEY, address: BATCHER_ADDRESS.to_bech32(undefined) };
const outsOf = (txHex: string) => {
  const o = CSL.FixedTransaction.from_hex(txHex).body().outputs();
  return Array.from({ length: o.len() }, (_, i) => ({ to: o.get(i).address().to_bech32(undefined), coin: BigInt(o.get(i).amount().coin().to_str()) }));
};

test('a sweep: the plain ADA chosen in, keep back to the batcher, the rest less the ledger’s own fee to the treasury', () => {
  const us = [plain(1, 60n), plain(2, 50n)];
  const s = buildSweep({ batcher: BATCHER, treasury: TREASURY, utxos: us, keep: 30n * ADA, validToSlot: 1_000n }, PP)!;
  assert.deepEqual(new Set(s.refs), new Set(us.map((u) => u.ref)));
  assert.equal(s.inputs, 110n * ADA);
  assert.equal(s.amount + 30n * ADA + s.fee, 110n * ADA);
  assert.deepEqual(new Set(outsOf(s.txHex).map((o) => JSON.stringify([o.to, String(o.coin)]))), new Set([JSON.stringify([BATCHER.address, String(30n * ADA)]), JSON.stringify([TREASURY.address, String(s.amount)])]));
  const known = Object.fromEntries(us.map((u) => [u.ref, u.outputHex]));
  assert.ok(s.fee >= ledgerMinFee(s.txHex, known, PP), 'below the ledger’s own minimum fee');
  assert.ok(s.fee < 300_000n, `a fee of ${s.fee}`);
  assert.equal(CSL.FixedTransaction.from_hex(s.txHex).body().ttl_bignum()?.to_str(), '1000');
});

test('nothing to sweep under 5 ADA above keep; at most 50 UTxOs, the largest first; never a UTxO that is not plain ADA', () => {
  assert.equal(buildSweep({ batcher: BATCHER, treasury: TREASURY, utxos: [plain(1, 34n)], keep: 30n * ADA, validToSlot: 1n }, PP), null);
  const many = Array.from({ length: 60 }, (_, i) => plain(i, 2n + BigInt(i % 7)));
  const s = buildSweep({ batcher: BATCHER, treasury: TREASURY, utxos: many, keep: 30n * ADA, validToSlot: 1n }, PP)!;
  assert.equal(s.refs.length, MAX_SWEEP_INPUTS);
  const coinOf = (u: { outputHex: string }) => BigInt(CSL.TransactionOutput.from_hex(u.outputHex).amount().coin().to_str());
  const taken = many.filter((u) => s.refs.includes(u.ref)).map(coinOf);
  const left = many.filter((u) => !s.refs.includes(u.ref)).map(coinOf);
  assert.ok(left.every((l) => taken.every((t) => t >= l)), 'a UTxO left out is larger than one taken');
  const tokens = utxo(`${'4f'.repeat(32)}#0`, BATCHER_ADDRESS, value(50n * ADA, [['70'.repeat(28), '544f4b', 1n]]));
  assert.throws(() => buildSweep({ batcher: BATCHER, treasury: TREASURY, utxos: [plain(1, 60n), tokens], keep: 30n * ADA, validToSlot: 1n }, PP), /not plain ADA at the batcher's own key: never swept/);
});

// The read-back, against a hand-built sweep and every way to bend it.
const REFS = [`${'41'.repeat(32)}#0`, `${'42'.repeat(32)}#0`];
const IN = 110n * ADA;
const FEE = 200_000n;
const EXPECT = { refs: REFS, inputs: IN, keep: 30n * ADA, batcherAddress: BATCHER.address, treasuryAddress: TREASURY.address };
const input = (ref: string) => CSL.TransactionInput.new(CSL.TransactionHash.from_hex(ref.split('#')[0]!), Number(ref.split('#')[1]));
const out = (to: string, coin: bigint, tokens = false) => CSL.TransactionOutput.new(CSL.Address.from_bech32(to), tokens ? value(coin, [['70'.repeat(28), '544f4b', 1n]]) : CSL.Value.new(CSL.BigNum.from_str(coin.toString())));
function sweepTx(change: (b: CSL.TransactionBody, outs: CSL.TransactionOutputs, ins: CSL.TransactionInputs) => void = () => {}, opts: { fee?: bigint; refs?: string[]; witness?: (w: CSL.TransactionWitnessSet) => void } = {}): string {
  const ins = CSL.TransactionInputs.new();
  for (const r of opts.refs ?? REFS) ins.add(input(r));
  const fee = opts.fee ?? FEE;
  const outs = CSL.TransactionOutputs.new();
  outs.add(out(BATCHER.address, 30n * ADA));
  outs.add(out(TREASURY.address, IN - 30n * ADA - fee));
  const b = CSL.TransactionBody.new_tx_body(ins, outs, CSL.BigNum.from_str(fee.toString()));
  change(b, outs, ins);
  const w = CSL.TransactionWitnessSet.new();
  opts.witness?.(w);
  return CSL.Transaction.new(CSL.TransactionBody.from_bytes(b.to_bytes()), w, undefined).to_hex();
}

test('before the key signs: exactly the two outputs, in ADA alone, the chosen inputs, and nothing else', () => {
  verifySweep(sweepTx(), EXPECT);
  const other = CSL.EnterpriseAddress.new(1, CSL.Credential.from_keyhash(kh('99'))).to_address().to_bech32(undefined);
  const withOuts = (outs: CSL.TransactionOutput[]) => {
    const ins = CSL.TransactionInputs.new();
    for (const r of REFS) ins.add(input(r));
    const o = CSL.TransactionOutputs.new();
    for (const x of outs) o.add(x);
    return CSL.Transaction.new(CSL.TransactionBody.new_tx_body(ins, o, CSL.BigNum.from_str(FEE.toString())), CSL.TransactionWitnessSet.new(), undefined).to_hex();
  };
  const bent: [string, string, RegExp][] = [
    ['a third output', withOuts([out(BATCHER.address, 30n * ADA), out(TREASURY.address, IN - 31n * ADA - FEE), out(other, ADA)]), /3 outputs, not 2/],
    ['the treasury output elsewhere', withOuts([out(BATCHER.address, 30n * ADA), out(other, IN - 30n * ADA - FEE)]), /neither the treasury nor the batcher's own/],
    ['two outputs to the batcher', withOuts([out(BATCHER.address, 30n * ADA), out(BATCHER.address, IN - 30n * ADA - FEE)]), /neither the treasury nor the batcher's own/],
    ['more kept than it should', withOuts([out(BATCHER.address, 31n * ADA), out(TREASURY.address, IN - 31n * ADA - FEE)]), /the batcher's own address is paid 31000000 lovelace, not 30000000/],
    ['less to the treasury', withOuts([out(BATCHER.address, 30n * ADA), out(TREASURY.address, IN - 31n * ADA - FEE)]), /the treasury is paid/],
    ['tokens in an output', withOuts([out(BATCHER.address, 30n * ADA), out(TREASURY.address, IN - 30n * ADA - FEE, true)]), /carries tokens/],
    ['another input', sweepTx(undefined, { refs: [...REFS, `${'43'.repeat(32)}#0`] }), /spends other UTxOs than those chosen/],
    ['one input too few', sweepTx(undefined, { refs: [REFS[0]!] }), /spends other UTxOs than those chosen/],
    ['a fee of 3 ADA', sweepTx(undefined, { fee: 3n * ADA }), /fee of 3000000 lovelace is more than 2000000/],
    ['a mint', sweepTx((b) => b.set_mint(CSL.Mint.new_from_entry(CSL.ScriptHash.from_hex('70'.repeat(28)), (() => { const a = CSL.MintAssets.new(); a.insert(CSL.AssetName.new(Buffer.from('54', 'hex')), CSL.Int.new_i32(1)); return a; })()))), /carries a mint/],
    ['a withdrawal', sweepTx((b) => { const w = CSL.Withdrawals.new(); w.insert(CSL.RewardAddress.new(1, CSL.Credential.from_keyhash(kh(BATCHER_KEY.slice(0, 2)))), CSL.BigNum.from_str('1')); b.set_withdrawals(w); }), /carries withdrawals/],
    ['a certificate', sweepTx((b) => { const c = CSL.Certificates.new(); c.add(CSL.Certificate.new_stake_registration(CSL.StakeRegistration.new(CSL.Credential.from_keyhash(kh('99'))))); b.set_certs(c); }), /carries certificates/],
    ['collateral', sweepTx((b) => { const c = CSL.TransactionInputs.new(); c.add(input(REFS[0]!)); b.set_collateral(c); }), /carries collateral/],
    ['a reference input', sweepTx((b) => { const c = CSL.TransactionInputs.new(); c.add(input(`${'44'.repeat(32)}#0`)); b.set_reference_inputs(c); }), /carries reference inputs/],
    ['another signer', sweepTx((b) => { const k = CSL.Ed25519KeyHashes.new(); k.add(kh('99')); b.set_required_signers(k); }), /carries required signers/],
    ['a donation to Cardano’s treasury', sweepTx((b) => b.set_donation(CSL.BigNum.from_str('1000000'))), /carries a donation/],
    ['a treasury value', sweepTx((b) => b.set_current_treasury_value(CSL.BigNum.from_str('1'))), /carries a treasury value/],
    ['metadata', sweepTx((b) => b.set_auxiliary_data_hash(CSL.AuxiliaryDataHash.from_hex('ab'.repeat(32)))), /carries metadata/],
    ['a script in the witnesses', sweepTx(undefined, { witness: (w) => { const n = CSL.NativeScripts.new(); n.add(pubkey('c1')); w.set_native_scripts(n); } }), /carries scripts or data/],
  ];
  for (const [what, tx, why] of bent) assert.throws(() => verifySweep(tx, EXPECT), why, what);
});
