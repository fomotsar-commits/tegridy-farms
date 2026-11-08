// The co-signing page's checks (cosign/review.ts): what a transaction does, who must sign it, and
// each wallet's signatures refused unless needed and over this very body.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { addWitnesses, assemble, checkMagic, checkWalletNetwork, checkWitnessSet, missing, outputOf, review, walletKeys, type Resolver, type WitnessFile } from '../cosign/review.ts';

const key = () => CSL.PrivateKey.generate_ed25519();
const K = { deployer: key(), a: key(), b: key(), stranger: key(), collateral: key(), reader: key() };
const hash = (k: CSL.PrivateKey) => k.to_public().hash().to_hex();
const at = (net: number, k: CSL.PrivateKey) => CSL.EnterpriseAddress.new(net, CSL.Credential.from_keyhash(k.to_public().hash())).to_address();
const big = (n: bigint | number) => CSL.BigNum.from_str(n.toString());
const ref = (id: string, ix: number) => CSL.TransactionInput.new(CSL.TransactionHash.from_hex(id), ix);
const IN = 'aa'.repeat(32);
const COLL = 'cc'.repeat(32);
const READ = 'dd'.repeat(32);

interface Opts {
  net?: number;
  fee?: bigint;
  signers?: CSL.PrivateKey[];
  body?: (b: CSL.TransactionBody) => void;
  witnesses?: (w: CSL.TransactionWitnessSet) => void;
}
/** A preprod payment: the deployer's 10 ADA to itself, owners A and B as required signers. */
function payment(o: Opts = {}): { hex: string; resolve: Resolver; id: string } {
  const net = o.net ?? 0;
  const ins = CSL.TransactionInputs.new();
  ins.add(ref(IN, 0));
  const outs = CSL.TransactionOutputs.new();
  outs.add(CSL.TransactionOutput.new(at(net, K.deployer), CSL.Value.new(big(9_800_000n))));
  const body = CSL.TransactionBody.new_tx_body(ins, outs, big(o.fee ?? 200_000n));
  const rs = CSL.Ed25519KeyHashes.new();
  for (const k of o.signers ?? [K.a, K.b]) rs.add(k.to_public().hash());
  body.set_required_signers(rs);
  body.set_validity_start_interval_bignum(big(100_000_000n));
  body.set_ttl(big(100_007_200n));
  o.body?.(body);
  const ws = CSL.TransactionWitnessSet.new();
  o.witnesses?.(ws);
  const hex = CSL.Transaction.new(body, ws).to_hex();
  const held = new Map([
    [`${IN}#0`, CSL.TransactionOutput.new(at(net, K.deployer), CSL.Value.new(big(10_000_000n))).to_hex()],
    [`${COLL}#0`, CSL.TransactionOutput.new(at(net, K.collateral), CSL.Value.new(big(5_000_000n))).to_hex()],
    [`${READ}#0`, CSL.TransactionOutput.new(at(net, K.reader), CSL.Value.new(big(2_000_000n))).to_hex()],
  ]);
  return { hex, id: CSL.FixedTransaction.from_hex(hex).transaction_hash().to_hex(), resolve: (r) => (held.has(r) ? { outputHex: held.get(r)!, from: 'the chain' } : undefined) };
}
/** What a CIP-30 wallet holding `k` sends back for `txHex`: a witness set with its one signature. */
function walletSigns(txHex: string, ...ks: CSL.PrivateKey[]): string {
  const h = CSL.FixedTransaction.from_hex(txHex).transaction_hash();
  const vs = CSL.Vkeywitnesses.new();
  for (const k of ks) vs.add(CSL.make_vkey_witness(h, k));
  const ws = CSL.TransactionWitnessSet.new();
  ws.set_vkeys(vs);
  return ws.to_hex();
}
const needsOf = (hex: string, r: Resolver, net: 0 | 1 = 0) => review(hex, net, r).needs.map((n) => n.key);

test('a payment needing two owners: the review reads it from its bytes, and names every key that must sign', () => {
  const t = payment();
  const r = review(t.hex, 0, t.resolve, { [hash(K.a)]: 'owner A' });
  assert.equal(r.txId, t.id);
  assert.deepEqual(r.needs.map((n) => n.key), [hash(K.deployer), hash(K.a), hash(K.b)]);
  assert.deepEqual(r.needs[0]!.why, [`input ${IN}#0`]);
  assert.equal(r.needs[1]!.label, 'owner A');
  assert.equal(r.inputs[0]!.address, at(0, K.deployer).to_bech32(undefined));
  assert.equal(r.inputs[0]!.lovelace, '10000000');
  assert.deepEqual(r.outputs.map((o) => [o.address, o.lovelace]), [[at(0, K.deployer).to_bech32(undefined), '9800000']]);
  assert.equal(r.fee, '200000');
  assert.equal(r.validity.from?.slot, '100000000');
  assert.equal(r.validity.until?.slot, '100007200');
});

test('every wallet signs its part; the signatures assemble onto the unsigned bytes, and each verifies', () => {
  const t = payment();
  const needs = needsOf(t.hex, t.resolve);
  let file: WitnessFile | null = null;
  assert.deepEqual(missing(review(t.hex, 0, t.resolve), null), needs);
  for (const k of [K.a]) file = addWitnesses(file, t.id, checkWitnessSet(t.hex, walletSigns(t.hex, k), needs));
  assert.deepEqual(missing(review(t.hex, 0, t.resolve), file), [hash(K.deployer), hash(K.b)]);
  for (const k of [K.deployer, K.b]) file = addWitnesses(file, t.id, checkWitnessSet(t.hex, walletSigns(t.hex, k), needs));
  assert.deepEqual(missing(review(t.hex, 0, t.resolve), file), []);
  const signed = CSL.FixedTransaction.from_hex(assemble(t.hex, file, needs));
  assert.equal(signed.transaction_hash().to_hex(), t.id);
  assert.deepEqual(Buffer.from(signed.raw_body()), Buffer.from(CSL.FixedTransaction.from_hex(t.hex).raw_body()));
  const vs = signed.witness_set().vkeys()!;
  assert.equal(vs.len(), 3);
  for (let i = 0; i < 3; i++) assert.ok(vs.get(i).vkey().public_key().verify(signed.transaction_hash().to_bytes(), vs.get(i).signature()));
});

test('refused: a signature from a key the transaction does not need', () => {
  const t = payment();
  assert.throws(() => checkWitnessSet(t.hex, walletSigns(t.hex, K.stranger), needsOf(t.hex, t.resolve)), /which this transaction does not need/);
  // One stranger's signature among needed ones: nothing from that wallet is kept.
  assert.throws(() => checkWitnessSet(t.hex, walletSigns(t.hex, K.a, K.stranger), needsOf(t.hex, t.resolve)), /does not need/);
});

test('refused: a signature over another body (the wallet saw other bytes)', () => {
  const t = payment();
  const other = payment({ fee: 200_001n });
  assert.throws(() => checkWitnessSet(t.hex, walletSigns(other.hex, K.a), needsOf(t.hex, t.resolve)), /not over this transaction's body/);
});

test('refused: a transaction whose body changed between signatures', () => {
  const t = payment();
  const changed = payment({ fee: 250_000n });
  const file = addWitnesses(null, t.id, checkWitnessSet(t.hex, walletSigns(t.hex, K.a), needsOf(t.hex, t.resolve)));
  assert.throws(() => addWitnesses(file, changed.id, checkWitnessSet(changed.hex, walletSigns(changed.hex, K.b), needsOf(changed.hex, changed.resolve))), /changed between signatures/);
  // Signatures kept for the first body never go onto the second.
  const full = [K.deployer, K.a, K.b].reduce<WitnessFile | null>((f, k) => addWitnesses(f, t.id, checkWitnessSet(t.hex, walletSigns(t.hex, k), needsOf(t.hex, t.resolve))), null);
  assert.throws(() => assemble(changed.hex, full, needsOf(changed.hex, changed.resolve)), /changed between signatures/);
});

test('assemble refuses a missing signer, and checks every kept signature again', () => {
  const t = payment();
  const needs = needsOf(t.hex, t.resolve);
  const two = [K.deployer, K.a].reduce<WitnessFile | null>((f, k) => addWitnesses(f, t.id, checkWitnessSet(t.hex, walletSigns(t.hex, k), needs)), null);
  assert.throws(() => assemble(t.hex, two, needs), new RegExp(`still to sign: ${hash(K.b)}`));
  assert.throws(() => assemble(t.hex, null, needs), /no one has signed/);
  // A witnesses file edited by hand: owner B's entry holds a signature over another body.
  const other = payment({ fee: 1n });
  const vk = CSL.TransactionWitnessSet.from_hex(walletSigns(other.hex, K.b)).vkeys()!.get(0).to_hex();
  assert.throws(() => assemble(t.hex, { ...two!, witnesses: { ...two!.witnesses, [hash(K.b)]: vk } }, needs), /not over this transaction's body/);
  // Owner B's entry holding owner A's signature: B never signed.
  const asA = CSL.TransactionWitnessSet.from_hex(walletSigns(t.hex, K.a)).vkeys()!.get(0).to_hex();
  assert.throws(() => assemble(t.hex, { ...two!, witnesses: { ...two!.witnesses, [hash(K.b)]: asA } }, needs), /kept under .* is from/);
});

test('mainnet only when the run says mainnet: addresses, the body, the wallet and the chain', () => {
  const main = payment({ net: 1 });
  assert.throws(() => review(main.hex, 0, main.resolve), /is a mainnet address, and this run's inputs say preprod/);
  const pre = payment();
  assert.throws(() => review(pre.hex, 1, pre.resolve), /is a preprod address, and this run's inputs say mainnet/);
  review(main.hex, 1, main.resolve);
  // The body's own network field.
  const named = payment({ body: (b) => b.set_network_id(CSL.NetworkId.mainnet()) });
  assert.throws(() => review(named.hex, 0, named.resolve), /names another network than preprod/);
  review(payment({ body: (b) => b.set_network_id(CSL.NetworkId.testnet()) }).hex, 0, pre.resolve);
  // An input at a mainnet address in a preprod transaction.
  const mixed: Resolver = (r) => ({ outputHex: CSL.TransactionOutput.new(at(1, K.deployer), CSL.Value.new(big(10_000_000n))).to_hex(), from: r });
  assert.throws(() => review(pre.hex, 0, mixed), /input .* is a mainnet address/);
  checkWalletNetwork(0, 0);
  checkWalletNetwork(1, 1);
  assert.throws(() => checkWalletNetwork(1, 0), /the wallet is on mainnet, and this run's inputs say preprod/);
  assert.throws(() => checkWalletNetwork(0, 1), /the wallet is on preprod, and this run's inputs say mainnet/);
  checkMagic(1, 0, 'Koios');
  checkMagic('764824073', 1, 'Koios');
  assert.throws(() => checkMagic(764_824_073, 0, 'Ogmios'), /Ogmios is not on preprod \(network magic 764824073\)/);
  assert.throws(() => checkMagic(2, 0, 'Koios'), /not on preprod/);
  assert.throws(() => checkMagic(1, 1, 'Koios'), /not on mainnet/);
  assert.deepEqual(walletKeys([at(0, K.a).to_hex(), at(0, K.a).to_hex(), 'zz'], 0), [hash(K.a)]);
  assert.throws(() => walletKeys([at(1, K.a).to_hex()], 0), /is on mainnet, and this run's inputs say preprod/);
});

test('refused: an input no one can show, and what no deploy transaction holds', () => {
  const t = payment();
  assert.throws(() => review(t.hex, 0, () => undefined), /not on the chain unspent/);
  const byron = CSL.ByronAddress.icarus_from_key(CSL.Bip32PrivateKey.generate_ed25519_bip32().to_public(), 1).to_address();
  assert.throws(() => review(t.hex, 0, () => ({ outputHex: CSL.TransactionOutput.new(byron, CSL.Value.new(big(1n))).to_hex(), from: 'x' })), /Byron address/);
  const refuse = (o: Opts, re: RegExp) => assert.throws(() => review(payment(o).hex, 0, t.resolve), re);
  refuse({ body: (b) => b.set_donation(big(1n)) }, /donates/);
  refuse({ body: (b) => b.set_current_treasury_value(big(1n)) }, /treasury value/);
  const drep = CSL.Credential.from_keyhash(K.stranger.to_public().hash());
  const vote = CSL.VotingProcedures.new();
  vote.insert(CSL.Voter.new_drep_credential(drep), CSL.GovernanceActionId.new(CSL.TransactionHash.from_hex('00'.repeat(32)), 0), CSL.VotingProcedure.new(CSL.VoteKind.Yes));
  refuse({ body: (b) => b.set_voting_procedures(vote) }, /votes/);
  const proposal = CSL.VotingProposals.new();
  proposal.add(CSL.VotingProposal.new(CSL.GovernanceAction.new_info_action(CSL.InfoAction.new()), CSL.Anchor.new(CSL.URL.new('https://example.org'), CSL.AnchorDataHash.from_hex('00'.repeat(32))), CSL.RewardAddress.new(0, drep), big(1n)));
  refuse({ body: (b) => b.set_voting_proposals(proposal) }, /proposal/);
  refuse({ body: (b) => b.set_update(CSL.Update.new(CSL.ProposedProtocolParameterUpdates.new(), 1)) }, /protocol update/);
  refuse({ witnesses: (w) => { const n = CSL.NativeScripts.new(); n.add(CSL.NativeScript.new_script_pubkey(CSL.ScriptPubkey.new(K.a.to_public().hash()))); w.set_native_scripts(n); } }, /native script/);
  refuse({ witnesses: (w) => { const v = CSL.Vkeywitnesses.new(); v.add(CSL.make_vkey_witness(CSL.TransactionHash.from_hex('00'.repeat(32)), K.a)); w.set_vkeys(v); } }, /already carries signatures/);
  const certs = (c: CSL.Certificate) => (b: CSL.TransactionBody) => { const cs = CSL.Certificates.new(); cs.add(c); b.set_certs(cs); };
  const cred = CSL.Credential.from_keyhash(K.stranger.to_public().hash());
  refuse({ body: certs(CSL.Certificate.new_stake_delegation(CSL.StakeDelegation.new(cred, CSL.Ed25519KeyHash.from_hex('ab'.repeat(28))))) }, /StakeDelegation certificate/);
  refuse({ body: certs(CSL.Certificate.new_stake_registration(CSL.StakeRegistration.new_with_explicit_deposit(cred, big(2_000_000n)))) }, /only the legacy stake registration/);
  // The legacy registration needs no one's signature: the deploy's register step.
  const reg = payment({ body: certs(CSL.Certificate.new_stake_registration(CSL.StakeRegistration.new(CSL.Credential.from_scripthash(CSL.ScriptHash.from_hex('ef'.repeat(28)))))) });
  const r = review(reg.hex, 0, t.resolve);
  assert.deepEqual(r.certificates, [{ kind: 'stake registration (legacy)', credential: 'ef'.repeat(28), script: true }]);
  assert.deepEqual(r.needs.map((n) => n.key), [hash(K.deployer), hash(K.a), hash(K.b)]);
});

test('collateral and key withdrawals must be signed for; a reference input need not be', () => {
  const t = payment({
    body: (b) => {
      const c = CSL.TransactionInputs.new();
      c.add(ref(COLL, 0));
      b.set_collateral(c);
      const rd = CSL.TransactionInputs.new();
      rd.add(ref(READ, 0));
      b.set_reference_inputs(rd);
      const w = CSL.Withdrawals.new();
      w.insert(CSL.RewardAddress.new(0, CSL.Credential.from_keyhash(K.stranger.to_public().hash())), big(0n));
      b.set_withdrawals(w);
    },
  });
  const r = review(t.hex, 0, t.resolve);
  assert.deepEqual(new Set(r.needs.map((n) => n.key)), new Set([hash(K.deployer), hash(K.collateral), hash(K.stranger), hash(K.a), hash(K.b)]));
  assert.ok(!r.needs.some((n) => n.key === hash(K.reader)));
  assert.equal(r.referenceInputs[0]!.key, hash(K.reader));
});

test('a wallet that sends more than signatures, or none, is refused', () => {
  const t = payment();
  const needs = needsOf(t.hex, t.resolve);
  const ws = CSL.TransactionWitnessSet.from_hex(walletSigns(t.hex, K.a));
  const pd = CSL.PlutusList.new();
  pd.add(CSL.PlutusData.new_integer(CSL.BigInt.from_str('1')));
  ws.set_plutus_data(pd);
  assert.throws(() => checkWitnessSet(t.hex, ws.to_hex(), needs), /more than signatures/);
  assert.throws(() => checkWitnessSet(t.hex, CSL.TransactionWitnessSet.new().to_hex(), needs), /none of the keys/);
  assert.throws(() => checkWitnessSet(t.hex, 'not hex', needs), /did not send a witness set/);
});

// The real preprod lock transaction (12c5949c, PR #1148's rehearsal): written unsigned by deploy.ts,
// signed there by the throwaway deployer and both stand-in owner keys, as it landed on chain.
const LOCK = JSON.parse(readFileSync(new URL('./fixtures/cosign-preprod-lock.json', import.meta.url), 'utf8')) as { txId: string; unsigned: string; signed: string; inputs: Record<string, string> };

test('the real preprod lock: its three signers named, and their three signatures assemble to the bytes that landed', () => {
  const resolve: Resolver = (r) => (LOCK.inputs[r] ? { outputHex: LOCK.inputs[r]!, from: 'the chain' } : undefined);
  const r = review(LOCK.unsigned, 0, resolve, { '26fd40be34c7af493d283a2d9e5ca8d355f62767f7f20534667bdf6d': 'owner A', '437340089a1743def5ed7fde7a13042274bb1339bc0ecfe0ac47dff0': 'owner B' });
  assert.equal(r.txId, LOCK.txId);
  assert.deepEqual(r.needs.map((n) => n.label ?? n.key), ['248daaa85393a34a74070c777a613ad9b58669c992c820f9f351f3fc', 'owner A', 'owner B']);
  assert.deepEqual(r.mint.map((m) => m.text), ['role-timelock']);
  assert.equal(r.redeemers[0]!.tag, 'Mint');
  const on = CSL.FixedTransaction.from_hex(LOCK.signed).witness_set().vkeys()!;
  let file: WitnessFile | null = null;
  for (let i = 0; i < on.len(); i++) {
    const ws = CSL.TransactionWitnessSet.new();
    const vs = CSL.Vkeywitnesses.new();
    vs.add(on.get(i));
    ws.set_vkeys(vs);
    file = addWitnesses(file, r.txId, checkWitnessSet(LOCK.unsigned, ws.to_hex(), r.needs.map((n) => n.key)));
  }
  assert.equal(assemble(LOCK.unsigned, file, r.needs.map((n) => n.key)), LOCK.signed);
});

test("a chain of unsent transactions: the next one's input is read from the one before", () => {
  const t = payment();
  assert.equal(outputOf(t.hex, 0), CSL.TransactionOutput.new(at(0, K.deployer), CSL.Value.new(big(9_800_000n))).to_hex());
  assert.equal(outputOf(t.hex, 1), undefined);
});
