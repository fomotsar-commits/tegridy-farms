// The watcher's loop on a stand-in chain (the test world, served as a ChainView, with failures
// injected): it sends what it should, holds what is in flight, waits for a fee UTxO, halves what is
// too big, sets aside only the order that fails alone and goes on with the rest, never blames an
// order for a source failing, stops for its own wallet or settings, above the float cap or after
// refusals in a row, and never for something a stranger can arrange.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { slotToPosixMs } from '../src/chain.ts';
import { InputsGone, NotJudged, SourceUnavailable, SubmitRefused, type Tip } from '../src/ogmios.ts';
import type { Utxo } from '../src/plan.ts';
import type { Evaluator } from '../src/prepare.ts';
import type { Deployment, Policy } from '../src/select.ts';
import type { SimulationResult } from '../src/simulate.ts';
import type { ChainUtxo, ChainView } from '../src/view.ts';
import { lpAssetName } from '../src/verify.ts';
import { Watcher, type Signer, type WatcherConfig, type WatcherEvent } from '../src/watcher.ts';
import { BATCHER_ADDRESS, BATCHER_KEY, BATCHER_SKEY, DEX, NETWORK, PP, S, makePool, order, step, traderAddress, utxo, value, world } from './world.ts';

const ADA = 1_000_000n;
const TIP = 160_000_000n;
const DEP: Deployment = { network: NETWORK, dex: DEX, orderScriptHash: S.order.hash, poolBatchingScriptHash: S.poolBatching.hash, scriptRefs: { pool: `${'a2'.repeat(32)}#0`, order: `${'a2'.repeat(32)}#1`, poolBatching: `${'a2'.repeat(32)}#2` } };
const POLICY: Policy = { batcherFee: 2n * ADA, maxOrdersPerBatch: 25, slotsBefore: 60n, slotsAfter: 240n };
const SIGNER: Signer = {
  keyHash: BATCHER_KEY,
  sign: (tx) => {
    const f = CSL.FixedTransaction.from_hex(tx);
    f.sign_and_add_vkey_signature(BATCHER_SKEY);
    return f.to_hex();
  },
};
const TOK2 = { policyId: '71'.repeat(28), assetName: '544f4b32' };
const LP2 = lpAssetName({ policyId: '', assetName: '' }, TOK2);

const inputsOf = (tx: string) => {
  const b = CSL.FixedTransaction.from_hex(tx).body().inputs();
  return Array.from({ length: b.len() }, (_, i) => `${b.get(i).transaction_id().to_hex()}#${b.get(i).index()}`);
};
const ordersIn = (tx: string, orders: { utxo: Utxo }[]) => orders.filter((o) => inputsOf(tx).includes(o.utxo.ref)).map((o) => o.utxo.ref);

/** Every redeemer measured at a small fixed budget; `refuse` decides from the spent inputs (a verdict, or something to throw). */
function evaluator(refuse: (inputs: string[]) => SimulationResult | Error | null = () => null): Evaluator {
  return (tx) => {
    const verdict = refuse(inputsOf(tx));
    if (verdict instanceof Error) throw verdict;
    if (verdict) return verdict;
    const rs = CSL.FixedTransaction.from_hex(tx).witness_set().redeemers()!;
    return { ok: true, budgets: Array.from({ length: rs.len() }, (_, i) => ({ tag: ['Spend', 'Mint', 'Cert', 'Reward'][rs.get(i).tag().kind()]!, index: Number(rs.get(i).index().to_str()), mem: 10_000n, steps: 1_000_000n })) };
  };
}

class FakeView implements ChainView {
  readonly name: string;
  slot = TIP;
  chain: ChainUtxo[];
  reward = 0n;
  down = false;
  failing: string | null = null;
  rewardDown = false;
  submitted: string[] = [];
  submitError: (() => Error) | null = null;
  calls = new Map<string, number>();
  evaluate: Evaluator;
  datums = new Map<string, string>();
  constructor(name: string, utxos: Utxo[], evaluate: Evaluator = evaluator()) {
    this.name = name;
    this.chain = utxos.map((u, i) => ({ ...u, createdSlot: BigInt(i), createdTxIndex: 0 }));
    this.evaluate = evaluate;
  }
  #call(m: string) {
    this.calls.set(m, (this.calls.get(m) ?? 0) + 1);
    if (this.down || this.failing === m) throw new SourceUnavailable(`${this.name} ${m}: down`);
  }
  async tip(): Promise<Tip> {
    this.#call('tip');
    return { slot: this.slot, id: 'ab'.repeat(32) };
  }
  async protocolParams() {
    this.#call('protocolParams');
    return PP;
  }
  #cred(u: Utxo) {
    const c = CSL.TransactionOutput.from_hex(u.outputHex).address().payment_cred()!;
    return c.to_scripthash()?.to_hex() ?? c.to_keyhash()!.to_hex();
  }
  async utxosAtCredential(cred: string) {
    this.#call('utxosAtCredential');
    return this.chain.filter((u) => this.#cred(u) === cred);
  }
  async utxosWithAsset(policy: string, name: string, cred: string) {
    this.#call('utxosWithAsset');
    return this.chain.filter((u) => this.#cred(u) === cred && (CSL.TransactionOutput.from_hex(u.outputHex).amount().multiasset()?.get_asset(CSL.ScriptHash.from_hex(policy), CSL.AssetName.new(Buffer.from(name, 'hex'))).to_str() ?? '0') !== '0');
  }
  async utxos(refs: string[]) {
    this.#call('utxos');
    return this.chain.filter((u) => refs.includes(u.ref));
  }
  async datum(hash: string): Promise<string | null> {
    this.#call('datum');
    return this.datums.get(hash) ?? null;
  }
  async rewardBalance() {
    this.#call('rewardBalance');
    if (this.rewardDown) throw new SourceUnavailable('Koios: down');
    return this.reward;
  }
  async submit(tx: string) {
    this.#call('submit');
    if (this.submitError) throw this.submitError();
    this.submitted.push(tx);
    return CSL.FixedTransaction.from_hex(tx).transaction_hash().to_hex();
  }
}

const swapOn = (ref: string, trader: number, lpName?: string) => order(ref, trader, 30n * ADA, [], step.swapIn(true, 25n * ADA, 1n), lpName ? { lpName } : {});

function setup(n: number, opts: { evaluate?: Evaluator; backup?: boolean; wallet?: Utxo[]; signer?: Signer | null; extra?: Utxo[]; config?: Partial<WatcherConfig> } = {}) {
  const w = world();
  const orders = Array.from({ length: n }, (_, j) => swapOn(`${(0xd0 + j).toString(16).repeat(32)}#0`, 1 + (j % 8)));
  const base = [w.globalSetting, w.scripts.pool, w.scripts.order, w.scripts.poolBatching, w.pool, ...(opts.wallet ?? [w.batcher.feeUtxos[0]!, w.batcher.collateral]), ...orders.map((o) => o.utxo), ...(opts.extra ?? [])];
  const primary = new FakeView('primary', base, opts.evaluate);
  const backup = new FakeView('backup', base, opts.evaluate);
  const events: WatcherEvent[] = [];
  // The wall clock follows the stand-in chain's tip.
  const config: WatcherConfig = { deployment: DEP, policy: POLICY, batcher: { keyHash: BATCHER_KEY, address: BATCHER_ADDRESS.to_bech32(undefined) }, floatCap: 100n * ADA, quarantineSlots: 3_600n, maxRefusalsInARow: 3, now: () => Number(slotToPosixMs(primary.slot)), ...opts.config };
  const watcher = new Watcher(opts.backup === false ? [primary] : [primary, backup], opts.signer === undefined ? SIGNER : opts.signer, config, (e) => events.push(e));
  const kinds = () => events.map((e) => e.kind);
  return { w, orders, primary, backup, events, watcher, kinds, config };
}

test('an order waiting: one batch, signed by the batcher, sent; its inputs held until its window closes, then free again', async () => {
  const { orders, primary, watcher, events } = setup(1);
  await watcher.round();
  assert.equal(primary.submitted.length, 1);
  const tx = primary.submitted[0]!;
  assert.deepEqual(ordersIn(tx, orders), [orders[0]!.utxo.ref]);
  assert.equal(CSL.FixedTransaction.from_hex(tx).witness_set().vkeys()?.len(), 1);
  assert.ok(events.some((e) => e.kind === 'sent'));
  await watcher.round();
  assert.equal(primary.submitted.length, 1);
  assert.equal(events.at(-1)!.kind, 'idle');
  primary.slot = TIP + 241n;
  await watcher.round();
  assert.equal(primary.submitted.length, 2);
});

test('the primary down, failing mid-round, or with a tip far from the clock: the round is read and sent from the backup alone', async () => {
  const a = setup(1);
  a.primary.down = true;
  await a.watcher.round();
  assert.equal(a.backup.submitted.length, 1);
  assert.deepEqual(a.kinds().slice(0, 1), ['source-down']);
  const b = setup(1);
  b.primary.failing = 'utxosWithAsset';
  await b.watcher.round();
  assert.equal(b.primary.submitted.length, 0);
  assert.equal(b.backup.submitted.length, 1);
  // A primary whose tip is 10 minutes behind the clock.
  const c = setup(1);
  const tip = c.primary.tip.bind(c.primary);
  c.primary.tip = async () => ({ ...(await tip()), slot: TIP - 600n });
  await c.watcher.round();
  assert.match((c.events[0] as { error: string }).error, /600 s behind this machine's clock/);
  assert.equal(c.backup.submitted.length, 1);
});

test('a node that cannot see an input yet blames no order, and the round is not repeated on the backup', async () => {
  const { watcher, primary, backup, kinds } = setup(2, { evaluate: evaluator(() => new InputsGone('the node cannot see every input')) });
  await watcher.round();
  assert.equal(watcher.setAside.size, 0);
  assert.equal(primary.submitted.length + backup.submitted.length, 0);
  assert.equal(backup.calls.get('tip') ?? 0, 0);
  assert.deepEqual(kinds(), ['inputs-gone']);
});

test('too big: halved, oldest orders kept, and sent', async () => {
  const over = (inputs: string[]) => (inputs.length > 4 ? { ok: false as const, error: 'overspending the budget', overBudget: true } : null);
  const { orders, primary, watcher } = setup(5, { evaluate: evaluator(over) });
  await watcher.round();
  assert.equal(primary.submitted.length, 1);
  assert.deepEqual(ordersIn(primary.submitted[0]!, orders), [orders[0]!.utxo.ref, orders[1]!.utxo.ref]);
});

test('one order too big even alone is set aside quietly (no alert): nothing the node or the contract disagrees about', async () => {
  const { watcher, events } = setup(1, { evaluate: evaluator(() => ({ ok: false, error: 'overspending the budget', overBudget: true })) });
  await watcher.round();
  const aside = events.find((e) => e.kind === 'set-aside');
  assert.ok(aside && aside.kind === 'set-aside' && !aside.alert);
});

test('an order the node’s scripts refuse is found by halving and set aside (alerted), and the rest go in the same round', async () => {
  let poison = '';
  const refuse = (inputs: string[]) => (inputs.includes(poison) ? { ok: false as const, error: 'Some scripts failed: 3012', overBudget: false } : null);
  const { orders, primary, watcher, events } = setup(3, { evaluate: evaluator(refuse) });
  poison = orders[0]!.utxo.ref;
  await watcher.round();
  assert.ok(watcher.setAside.has(poison));
  const aside = events.find((e) => e.kind === 'set-aside');
  assert.ok(aside && aside.kind === 'set-aside' && aside.alert);
  assert.equal(primary.submitted.length, 1, 'the rest were sent in the same round');
  assert.deepEqual(ordersIn(primary.submitted[0]!, orders), [orders[1]!.utxo.ref, orders[2]!.utxo.ref]);
});

test('any other failure of one batch (an error class nobody foresaw, NotJudged) sets that order aside; it never blocks every pool', async () => {
  for (const make of [() => new Error('EMURGO refused the batch: something new'), () => new NotJudged('the node would not judge the batch')]) {
    let bad = '';
    const { orders, primary, watcher, events } = setup(2, { evaluate: evaluator((inputs) => (inputs.includes(bad) ? make() : null)) });
    bad = orders[0]!.utxo.ref;
    await watcher.round();
    assert.ok(watcher.setAside.has(bad), make().constructor.name);
    assert.ok(events.some((e) => e.kind === 'set-aside' && e.alert));
    assert.deepEqual(ordersIn(primary.submitted[0]!, orders), [orders[1]!.utxo.ref]);
  }
});

test('five alerted set-asides in a row raise a louder alert, and never stop the batcher (a stranger could arrange them)', async () => {
  const { watcher, events } = setup(6, { evaluate: evaluator(() => ({ ok: false, error: '3012', overBudget: false })) });
  for (let i = 0; i < 3 && !events.some((e) => e.kind === 'alert'); i++) await watcher.round();
  assert.ok(events.some((e) => e.kind === 'alert' && /engine and the contract disagree/.test(e.reason)));
  assert.equal(watcher.stopped, null);
});

test('with every fee UTxO in a batch still in flight, it waits; it does not stop', async () => {
  const pool2 = makePool(`${'a4'.repeat(32)}#0`, TOK2);
  const other = swapOn(`${'e0'.repeat(32)}#0`, 5, LP2);
  const { watcher, primary, events } = setup(1, { extra: [pool2, other.utxo] });
  await watcher.round(); // pool 1's batch goes, holding the only fee UTxO
  assert.equal(primary.submitted.length, 1);
  await watcher.round(); // pool 2 has an order, and no fee UTxO is free
  assert.equal(watcher.stopped, null);
  const idle = events.at(-1)!;
  assert.ok(idle.kind === 'idle' && /in flight/.test(idle.reason ?? ''));
  // Once pool 1's batch has landed, its change is a new fee UTxO: pool 2 goes.
  primary.chain = primary.chain.filter((u) => !inputsOf(primary.submitted[0]!).includes(u.ref));
  primary.chain.push({ ...utxo(`${'c0'.repeat(32)}#3`, BATCHER_ADDRESS, value(21n * ADA)), createdSlot: TIP, createdTxIndex: 0 });
  await watcher.round();
  assert.equal(primary.submitted.length, 2);
});

test('the batcher’s own wallet or settings wrong: it stops with the reason, and blames no order', async () => {
  const w = world();
  const one = setup(1, { wallet: [w.batcher.feeUtxos[0]!] });
  await one.watcher.round();
  assert.match(one.watcher.stopped?.reason ?? '', /two plain ADA UTxOs/);
  // Every UTxO under the 5 ADA a collateral must hold (with 20 ADA and 4 ADA, the 20 would be the collateral: fine).
  const small = setup(1, { wallet: [utxo(`${'b1'.repeat(32)}#0`, BATCHER_ADDRESS, value(4_500_000n)), utxo(`${'b1'.repeat(32)}#1`, BATCHER_ADDRESS, value(4n * ADA))] });
  await small.watcher.round();
  assert.match(small.watcher.stopped?.reason ?? '', /at least 5000000 lovelace for collateral/);
  // A reference-script UTxO that holds no script (the settings point at the wrong UTxO).
  const noScript = setup(1);
  noScript.primary.chain = noScript.primary.chain.map((u) => (u.ref === DEP.scriptRefs.order ? { ...u, outputHex: utxo(u.ref, BATCHER_ADDRESS, value(ADA)).outputHex } : u));
  noScript.backup.down = true;
  await noScript.watcher.round();
  assert.match(noScript.watcher.stopped?.reason ?? '', /carries no Plutus reference script/);
  assert.equal(noScript.watcher.setAside.size, 0);
});

test('a batcher the global setting does not name stops at once, with the reason', async () => {
  const { watcher } = setup(1, { config: { batcher: { keyHash: '00'.repeat(28), address: CSL.EnterpriseAddress.new(NETWORK, CSL.Credential.from_keyhash(CSL.Ed25519KeyHash.from_hex('00'.repeat(28)))).to_address().to_bech32(undefined) } }, signer: null });
  await watcher.round();
  assert.match(watcher.stopped?.reason ?? '', /not among the global setting's batchers/);
});

test('EMURGO’s library broken (its wasm trapped): a fatal stop, for the process to restart', async () => {
  class RuntimeError extends Error {}
  const { watcher, events } = setup(1, { evaluate: evaluator(() => new RuntimeError('memory access out of bounds')) });
  await watcher.round();
  assert.equal(watcher.stopped?.fatal, true);
  assert.ok(events.some((e) => e.kind === 'stopped' && e.fatal));
});

test('refusals: benign ones (an input gone, the account changed) never count; three real ones in a row stop it; a success resets the count', async () => {
  const { primary, watcher, events } = setup(1, { backup: false });
  primary.submitError = () => new SubmitRefused('3117 unknown inputs', true, false);
  for (let i = 0; i < 4; i++) await watcher.round();
  primary.submitError = () => new SubmitRefused('3141 incomplete withdrawals', false, true);
  await watcher.round();
  assert.equal(watcher.stopped, null);
  primary.submitError = () => new SubmitRefused('3122 fee too small', false, false);
  await watcher.round();
  await watcher.round();
  primary.submitError = null;
  await watcher.round(); // sent: the count starts again
  primary.submitError = () => new SubmitRefused('3122 fee too small', false, false);
  primary.slot = TIP + 241n;
  await watcher.round();
  await watcher.round();
  assert.equal(watcher.stopped, null, 'two refusals after a success are not three in a row');
  await watcher.round();
  assert.match((watcher.stopped as { reason: string } | null)?.reason ?? '', /refused 3 batches in a row/);
  assert.equal(events.at(-1)!.kind, 'stopped');
});

test('ten benign refusals in a row raise an alert (every batch refused as spent or expired: is the tip current?)', async () => {
  const { primary, watcher, events } = setup(1, { backup: false });
  primary.submitError = () => new SubmitRefused('3118 outside the validity interval', true, false);
  for (let i = 0; i < 10; i++) await watcher.round();
  assert.ok(events.some((e) => e.kind === 'alert' && /tip current/.test(e.reason)));
  assert.equal(watcher.stopped, null);
});

test('a submission that may have reached the node holds its inputs, and is not sent again through the backup', async () => {
  const { primary, backup, watcher } = setup(1);
  primary.submitError = () => new SourceUnavailable('timeout');
  await watcher.round();
  assert.equal(watcher.inflight.size, 1);
  assert.equal(primary.calls.get('submit'), 1);
  assert.equal(backup.calls.get('submit') ?? 0, 0);
  await watcher.round();
  assert.equal(primary.calls.get('submit'), 1);
});

test('above the float cap it stops before building anything', async () => {
  const w = world();
  const rich = utxo(`${'b2'.repeat(32)}#0`, BATCHER_ADDRESS, value(95n * ADA));
  const { primary, watcher } = setup(1, { wallet: [w.batcher.feeUtxos[0]!, w.batcher.collateral, rich] });
  await watcher.round();
  assert.match(watcher.stopped?.reason ?? '', /above its cap/);
  assert.equal(primary.calls.get('submit') ?? 0, 0);
});

test('a dry run prepares and judges the batch, and signs and sends nothing', async () => {
  const { primary, watcher, events } = setup(2, { signer: null });
  await watcher.round();
  assert.equal(primary.calls.get('submit') ?? 0, 0);
  const p = events.find((e) => e.kind === 'prepared');
  assert.ok(p && p.kind === 'prepared' && p.dryRun && p.orders.length === 2);
});

test('the batching account: read once an hour, again after a refusal naming it, and the last value stands in when the read fails', async () => {
  const { primary, watcher } = setup(1, { backup: false });
  primary.reward = 3n * ADA;
  await watcher.round();
  primary.slot = TIP + 300n;
  await watcher.round();
  assert.equal(primary.calls.get('rewardBalance'), 1);
  primary.submitError = () => new SubmitRefused('3141 incomplete withdrawals', false, true);
  primary.slot = TIP + 600n;
  await watcher.round();
  primary.submitError = null;
  await watcher.round();
  assert.equal(primary.calls.get('rewardBalance'), 2);
  // Koios down after the hour: the last balance read stands in, and the batch goes.
  primary.rewardDown = true;
  primary.slot = TIP + 600n + 3_600n;
  const sent = primary.submitted.length;
  await watcher.round();
  assert.equal(primary.submitted.length, sent + 1);
  const w = CSL.FixedTransaction.from_hex(primary.submitted.at(-1)!).body().withdrawals()!;
  assert.equal(w.get(w.keys().get(0))!.to_str(), String(3n * ADA));
});

test('rounds never overlap; a trigger during a round runs one more right after; close() lets none start', async () => {
  const { watcher, primary } = setup(0);
  let running = 0;
  let most = 0;
  const tip = primary.tip.bind(primary);
  primary.tip = async () => {
    running++;
    most = Math.max(most, running);
    await new Promise((r) => setTimeout(r, 20));
    running--;
    return tip();
  };
  await Promise.all([watcher.trigger(), watcher.trigger(), watcher.trigger()]);
  assert.equal(most, 1);
  assert.equal(primary.calls.get('tip'), 2);
  await watcher.close();
  await watcher.trigger();
  await watcher.round();
  assert.equal(primary.calls.get('tip'), 2);
});

test('a signing key that is not the batcher key, or an address that is not its own, is refused at the start', () => {
  const config: WatcherConfig = { deployment: DEP, policy: POLICY, batcher: { keyHash: BATCHER_KEY, address: BATCHER_ADDRESS.to_bech32(undefined) }, floatCap: 100n * ADA, quarantineSlots: 3_600n, maxRefusalsInARow: 3 };
  assert.throws(() => new Watcher([], { keyHash: '00'.repeat(28), sign: (t) => t }, config, () => {}), /not the batcher key/);
  assert.throws(() => new Watcher([], null, { ...config, batcher: { keyHash: BATCHER_KEY, address: traderAddress(7).to_bech32(undefined) } }, () => {}), /not the batcher key's own enterprise address/);
});

test('hash-only orders: at most 20 lookups a round, oldest first; found datums kept, misses not asked again for an hour', async () => {
  const w = world();
  // 25 decoys whose datums no source has, made before one real hash-only order.
  const decoys = Array.from({ length: 25 }, (_, j) => order(`${(0x40 + j).toString(16).repeat(32)}#0`, 1 + (j % 8), 30n * ADA, [], step.swapIn(true, 25n * ADA - BigInt(j), 1n), { byHash: true }));
  const real = order(`${'7f'.repeat(32)}#0`, 3, 30n * ADA, [], step.swapIn(true, 20n * ADA, 1n), { byHash: true });
  const view = new FakeView('primary', [w.globalSetting, w.scripts.pool, w.scripts.order, w.scripts.poolBatching, w.pool, w.batcher.feeUtxos[0]!, w.batcher.collateral, ...decoys.map((o) => o.utxo), real.utxo]);
  view.datums.set(CSL.hash_plutus_data(real.datum).to_hex(), real.datum.to_hex());
  const asked: string[] = [];
  const datum = view.datum.bind(view);
  view.datum = async (hash: string) => (asked.push(hash), datum(hash));
  const watcher = new Watcher([view], SIGNER, { deployment: DEP, policy: POLICY, batcher: { keyHash: BATCHER_KEY, address: BATCHER_ADDRESS.to_bech32(undefined) }, floatCap: 100n * ADA, quarantineSlots: 3_600n, maxRefusalsInARow: 3, now: () => Number(slotToPosixMs(view.slot)) }, () => {});
  await watcher.round();
  assert.equal(asked.length, 20, 'twenty lookups, the oldest decoys');
  const hashOf = (o: { datum: CSL.PlutusData }) => CSL.hash_plutus_data(o.datum).to_hex();
  assert.deepEqual(asked, decoys.slice(0, 20).map(hashOf), 'oldest orders first');
  await watcher.round();
  assert.equal(asked.length, 26, 'the other five decoys and the real order: misses are not asked again');
  assert.equal(view.submitted.length, 1, 'the real order, once its datum was found, was batched');
  await watcher.round();
  assert.equal(asked.length, 26, 'nothing is asked twice within the hour');
});

test('a source answering a datum that is not the one the hash names is not believed: nothing kept, nothing set aside', async () => {
  const w = world();
  const a = order(`${'41'.repeat(32)}#0`, 1, 30n * ADA, [], step.swapIn(true, 25n * ADA, 1n), { byHash: true });
  const b = order(`${'42'.repeat(32)}#0`, 2, 30n * ADA, [], step.swapIn(true, 24n * ADA, 1n), { byHash: true });
  const liar = new FakeView('primary', [w.globalSetting, w.scripts.pool, w.scripts.order, w.scripts.poolBatching, w.pool, w.batcher.feeUtxos[0]!, w.batcher.collateral, a.utxo]);
  liar.datum = async () => b.datum.to_hex();
  const watcher = new Watcher([liar], SIGNER, { deployment: DEP, policy: POLICY, batcher: { keyHash: BATCHER_KEY, address: BATCHER_ADDRESS.to_bech32(undefined) }, floatCap: 100n * ADA, quarantineSlots: 3_600n, maxRefusalsInARow: 3, now: () => Number(slotToPosixMs(liar.slot)) }, () => {});
  await watcher.round();
  assert.equal(liar.submitted.length, 0);
  assert.equal(watcher.setAside.size, 0, 'a lying source got a good order set aside');
  liar.datum = async () => a.datum.to_hex();
  liar.slot = TIP + 3_601n;
  await watcher.round();
  assert.equal(liar.submitted.length, 1, 'once the true datum came, the order went');
});

test('each skipped order is logged once while it stays, not every round', async () => {
  const cheap = order(`${'43'.repeat(32)}#0`, 1, 30n * ADA, [], step.zapOut());
  const { watcher, events } = setup(0, { extra: [cheap.utxo] });
  for (let i = 0; i < 3; i++) await watcher.round();
  assert.equal(events.filter((e) => e.kind === 'skipped').length, 1);
});
