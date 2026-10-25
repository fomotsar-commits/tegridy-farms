// The watcher's loop on a stand-in chain (the test world, served as a ChainView, with failures
// injected): it sends what it should, holds what is in flight, halves what is too big, sets aside
// only what the node refuses on its own, never blames an order for a source failing, and stops
// above the float cap or after refusals in a row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { InputsGone, SourceUnavailable, SubmitRefused, type Tip } from '../src/ogmios.ts';
import type { Evaluator } from '../src/prepare.ts';
import type { Deployment, Policy } from '../src/select.ts';
import type { SimulationResult } from '../src/simulate.ts';
import type { ChainUtxo, ChainView } from '../src/view.ts';
import { Watcher, type Signer, type WatcherConfig, type WatcherEvent } from '../src/watcher.ts';
import { BATCHER_ADDRESS, BATCHER_KEY, BATCHER_SKEY, DEX, NETWORK, PP, S, order, step, utxo, value, world } from './world.ts';
import type { Utxo } from '../src/plan.ts';

const ADA = 1_000_000n;
const TIP = 160_000_000n;
const DEP: Deployment = { network: NETWORK, dex: DEX, orderScriptHash: S.order.hash, poolBatchingScriptHash: S.poolBatching.hash, scriptRefs: { pool: `${'a2'.repeat(32)}#0`, order: `${'a2'.repeat(32)}#1`, poolBatching: `${'a2'.repeat(32)}#2` } };
const POLICY: Policy = { batcherFee: 2n * ADA, maxOrdersPerBatch: 25, slotsBefore: 60n, slotsAfter: 240n };
const CONFIG: WatcherConfig = { deployment: DEP, policy: POLICY, batcher: { keyHash: BATCHER_KEY, address: BATCHER_ADDRESS.to_bech32(undefined) }, floatCap: 100n * ADA, quarantineSlots: 3_600n, maxRefusalsInARow: 3 };
const SIGNER: Signer = {
  keyHash: BATCHER_KEY,
  sign: (tx) => {
    const f = CSL.FixedTransaction.from_hex(tx);
    f.sign_and_add_vkey_signature(BATCHER_SKEY);
    return f.to_hex();
  },
};

const inputsOf = (tx: string) => {
  const b = CSL.FixedTransaction.from_hex(tx).body().inputs();
  return Array.from({ length: b.len() }, (_, i) => `${b.get(i).transaction_id().to_hex()}#${b.get(i).index()}`);
};
const ordersIn = (tx: string, orders: { utxo: Utxo }[]) => orders.filter((o) => inputsOf(tx).includes(o.utxo.ref)).map((o) => o.utxo.ref);

/** Every redeemer measured at a small fixed budget; `refuse` decides a verdict from the spent inputs. */
function evaluator(refuse: (inputs: string[]) => SimulationResult | 'gone' | null = () => null): Evaluator {
  return (tx) => {
    const verdict = refuse(inputsOf(tx));
    if (verdict === 'gone') throw new InputsGone('the node cannot see every input');
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
  submitted: string[] = [];
  submitError: (() => Error) | null = null;
  calls = new Map<string, number>();
  evaluate: Evaluator;
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
  async datum(_hash: string): Promise<string | null> {
    this.#call('datum');
    return null;
  }
  async rewardBalance() {
    this.#call('rewardBalance');
    return this.reward;
  }
  async submit(tx: string) {
    this.#call('submit');
    if (this.submitError) throw this.submitError();
    this.submitted.push(tx);
    return CSL.FixedTransaction.from_hex(tx).transaction_hash().to_hex();
  }
}

function setup(n: number, opts: { evaluate?: Evaluator; backup?: boolean; wallet?: Utxo[]; signer?: Signer | null } = {}) {
  const w = world();
  const orders = Array.from({ length: n }, (_, j) => order(`${(0xd0 + j).toString(16).repeat(32)}#0`, 1 + (j % 8), 30n * ADA, [], step.swapIn(true, 25n * ADA, 1n)));
  const base = [w.globalSetting, w.scripts.pool, w.scripts.order, w.scripts.poolBatching, w.pool, ...(opts.wallet ?? [w.batcher.feeUtxos[0]!, w.batcher.collateral]), ...orders.map((o) => o.utxo)];
  const primary = new FakeView('primary', base, opts.evaluate);
  const backup = new FakeView('backup', base, opts.evaluate);
  const events: WatcherEvent[] = [];
  const watcher = new Watcher(opts.backup === false ? [primary] : [primary, backup], opts.signer === undefined ? SIGNER : opts.signer, CONFIG, (e) => events.push(e));
  const kinds = () => events.map((e) => e.kind);
  return { w, orders, primary, backup, events, watcher, kinds };
}

test('an order waiting: one batch, signed by the batcher, sent; its inputs held until its window closes, then free again', async () => {
  const { orders, primary, watcher, events } = setup(1);
  await watcher.round();
  assert.equal(primary.submitted.length, 1);
  const tx = primary.submitted[0]!;
  assert.deepEqual(ordersIn(tx, orders), [orders[0]!.utxo.ref]);
  assert.equal(CSL.FixedTransaction.from_hex(tx).witness_set().vkeys()?.len(), 1);
  assert.ok(events.some((e) => e.kind === 'sent'));
  // The batch has not landed (the stand-in chain does not change): its inputs stay held.
  await watcher.round();
  assert.equal(primary.submitted.length, 1);
  assert.equal(events.at(-1)!.kind, 'idle');
  // Past its window it can never land: the order is free again and batched anew.
  primary.slot = TIP + 241n;
  await watcher.round();
  assert.equal(primary.submitted.length, 2);
});

test('the primary down, or failing mid-round: the round is read and sent from the backup alone', async () => {
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
});

test('a node that cannot see an input yet blames no order: nothing is set aside', async () => {
  const { watcher, primary, backup } = setup(2, { evaluate: evaluator(() => 'gone') });
  await watcher.round();
  assert.equal(watcher.setAside.size, 0);
  assert.equal(primary.submitted.length + backup.submitted.length, 0);
});

test('too big: halved, oldest orders kept, and sent', async () => {
  const over = (inputs: string[]) => (inputs.length > 4 ? { ok: false as const, error: 'overspending the budget', overBudget: true } : null);
  const { orders, primary, watcher } = setup(5, { evaluate: evaluator(over) });
  await watcher.round();
  assert.equal(primary.submitted.length, 1);
  // pool + fee UTxO + 3 orders = 5 inputs: too big; 2 orders = 4: sent. The oldest two.
  assert.deepEqual(ordersIn(primary.submitted[0]!, orders), [orders[0]!.utxo.ref, orders[1]!.utxo.ref]);
});

test('an order the node’s scripts refuse is found by halving and set aside alone (alerted); the rest are sent', async () => {
  let poison = '';
  const refuse = (inputs: string[]) => (inputs.includes(poison) ? { ok: false as const, error: 'Some scripts failed: 3012', overBudget: false } : null);
  const { orders, primary, watcher, events } = setup(3, { evaluate: evaluator(refuse) });
  poison = orders[0]!.utxo.ref;
  await watcher.round();
  assert.ok(watcher.setAside.has(poison));
  const aside = events.find((e) => e.kind === 'set-aside');
  assert.ok(aside && aside.kind === 'set-aside' && aside.alert);
  assert.equal(primary.submitted.length, 0);
  await watcher.round();
  assert.deepEqual(ordersIn(primary.submitted[0]!, orders), [orders[1]!.utxo.ref, orders[2]!.utxo.ref]);
});

test('refusals: a benign one (an input gone) never counts; three real ones in a row stop the batcher', async () => {
  const { primary, watcher, events } = setup(1, { backup: false });
  primary.submitError = () => new SubmitRefused('3117 unknown inputs', true, false);
  for (let i = 0; i < 4; i++) await watcher.round();
  assert.equal(watcher.stopped, null);
  assert.equal(watcher.inflight.size, 0);
  primary.submitError = () => new SubmitRefused('3122 fee too small', false, false);
  for (let i = 0; i < 3; i++) await watcher.round();
  assert.match(watcher.stopped ?? '', /refused 3 batches in a row/);
  assert.equal(events.at(-1)!.kind, 'stopped');
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
  assert.match(watcher.stopped ?? '', /above its cap/);
  assert.equal(primary.calls.get('submit') ?? 0, 0);
});

test('a wallet of one UTxO cannot pledge collateral and pay: it stops and says what it needs', async () => {
  const w = world();
  const { watcher } = setup(1, { wallet: [w.batcher.feeUtxos[0]!] });
  await watcher.round();
  assert.match(watcher.stopped ?? '', /two plain ADA UTxOs/);
});

test('a dry run prepares and judges the batch, and signs and sends nothing', async () => {
  const { primary, watcher, events } = setup(2, { signer: null });
  await watcher.round();
  assert.equal(primary.calls.get('submit') ?? 0, 0);
  const p = events.find((e) => e.kind === 'prepared');
  assert.ok(p && p.kind === 'prepared' && p.dryRun && p.orders.length === 2);
});

test('the batching account is read once an hour, and again after a refusal that names it', async () => {
  const { primary, watcher } = setup(1, { backup: false });
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
  primary.slot = TIP + 600n + 3_600n;
  await watcher.round();
  assert.equal(primary.calls.get('rewardBalance'), 3);
});

test('rounds never overlap: a trigger during a round runs one more right after', async () => {
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
});

test('a signing key that is not the batcher key is refused at the start', () => {
  assert.throws(() => new Watcher([], { keyHash: '00'.repeat(28), sign: (t) => t }, CONFIG, () => {}), /not the batcher key/);
});

test('hash-only orders: at most 20 datum lookups a round, each datum kept once found (a hash names one datum forever)', async () => {
  const w = world();
  const hashOnly = Array.from({ length: 30 }, (_, j) => order(`${(0x40 + j).toString(16).repeat(32)}#0`, 1 + (j % 8), 30n * ADA, [], step.swapIn(true, 25n * ADA - BigInt(j), 1n), { byHash: true }));
  const byHash = new Map(hashOnly.map((o) => [CSL.hash_plutus_data(o.datum).to_hex(), o.datum.to_hex()]));
  const view = new FakeView('primary', [w.globalSetting, w.scripts.pool, w.scripts.order, w.scripts.poolBatching, w.pool, w.batcher.feeUtxos[0]!, w.batcher.collateral, ...hashOnly.map((o) => o.utxo)]);
  const asked: string[] = [];
  view.datum = async (hash: string) => (asked.push(hash), byHash.get(hash) ?? null);
  const watcher = new Watcher([view], SIGNER, CONFIG, () => {});
  await watcher.round();
  assert.equal(asked.length, 20);
  await watcher.round();
  assert.equal(asked.length, 30, 'the second round asks only for the ten not yet known');
  await watcher.round();
  assert.equal(asked.length, 30, 'nothing is asked twice');
  // A source answering a datum that is not the one the hash names is not believed.
  const liar = new FakeView('primary', [w.globalSetting, w.scripts.pool, w.scripts.order, w.scripts.poolBatching, w.pool, w.batcher.feeUtxos[0]!, w.batcher.collateral, hashOnly[0]!.utxo]);
  liar.datum = async () => hashOnly[1]!.datum.to_hex();
  const w2 = new Watcher([liar], SIGNER, CONFIG, () => {});
  await w2.round();
  assert.equal(liar.submitted.length, 0);
});
