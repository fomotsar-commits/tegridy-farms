// The watcher's loop on a stand-in chain (the test world, served as a ChainView, with failures
// injected): it sends what it should, holds what is in flight, waits for a fee UTxO, halves what is
// too big, sets aside only the order that fails alone and goes on with the rest, never blames an
// order for a source failing, stops for its own wallet or settings, above the float cap or after
// refusals in a row, and never for something a stranger can arrange.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { slotToPosixMs } from '../src/chain.ts';
import { InputsGone, NotJudged, SourceUnavailable, SubmitRefused } from '../src/ogmios.ts';
import type { Utxo } from '../src/plan.ts';
import type { Evaluator } from '../src/prepare.ts';
import { lpAssetName } from '../src/verify.ts';
import { Heartbeat } from '../src/heartbeat.ts';
import { Watcher, type Signer, type WatcherConfig, type WatcherEvent } from '../src/watcher.ts';
import { BATCHER_ADDRESS, BATCHER_KEY, NETWORK, makePool, order, step, traderAddress, utxo, value, world } from './world.ts';
import { ADA, DEP, FakeView, POLICY, SIGNER, TIP, evaluator, inputsOf, swapOn } from './fake-view.ts';

const TOK2 = { policyId: '71'.repeat(28), assetName: '544f4b32' };
const LP2 = lpAssetName({ policyId: '', assetName: '' }, TOK2);
const ordersIn = (tx: string, orders: { utxo: Utxo }[]) => orders.filter((o) => inputsOf(tx).includes(o.utxo.ref)).map((o) => o.utxo.ref);

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
  assert.deepEqual(kinds(), ['wallet', 'inputs-gone']);
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

test('EMURGO’s library broken (its wasm trapped): a fatal stop, for the process to restart, naming the orders it broke on', async () => {
  class RuntimeError extends Error {}
  const { watcher, events, orders } = setup(2, { evaluate: evaluator(() => new RuntimeError('memory access out of bounds')) });
  await watcher.round();
  assert.equal(watcher.stopped?.fatal, true);
  const stop = events.find((e) => e.kind === 'stopped');
  assert.ok(stop && stop.kind === 'stopped' && stop.fatal);
  assert.deepEqual(stop.setAside, { refs: orders.map((o) => o.utxo.ref), untilSlot: TIP + 3_600n });
  assert.match(stop.reason, /set aside until slot 160003600/);
  // Broken anywhere else (no batch being prepared): fatal, and no order is named.
  const tip = setup(1);
  tip.primary.tip = async () => {
    throw new RuntimeError('unreachable');
  };
  await tip.watcher.round();
  const other = tip.events.find((e) => e.kind === 'stopped');
  assert.ok(other && other.kind === 'stopped' && other.fatal && other.setAside === undefined);
});

test('orders an earlier process set aside stay aside until their slot, then are batched', async () => {
  const w = world();
  const o = swapOn(`${'d0'.repeat(32)}#0`, 1);
  const view = new FakeView('primary', [w.globalSetting, w.scripts.pool, w.scripts.order, w.scripts.poolBatching, w.pool, w.batcher.feeUtxos[0]!, w.batcher.collateral, o.utxo]);
  const config: WatcherConfig = { deployment: DEP, policy: POLICY, batcher: { keyHash: BATCHER_KEY, address: BATCHER_ADDRESS.to_bech32(undefined) }, floatCap: 100n * ADA, quarantineSlots: 3_600n, maxRefusalsInARow: 3, now: () => Number(slotToPosixMs(view.slot)), setAside: new Map([[o.utxo.ref, TIP + 100n]]) };
  const watcher = new Watcher([view], SIGNER, config, () => {});
  await watcher.round();
  assert.equal(view.submitted.length, 0);
  view.slot = TIP + 101n;
  await watcher.round();
  assert.equal(view.submitted.length, 1);
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

test('a round that finds only orders it cannot batch (a limit order waiting for its price, a pool that does not exist) still says it reached a source, and the alarm stays ok', async () => {
  const limit = order(`${'44'.repeat(32)}#0`, 1, 30n * ADA, [], step.swapIn(true, 25n * ADA, 10n ** 15n, false));
  const nowhere = swapOn(`${'45'.repeat(32)}#0`, 2, LP2);
  const { watcher, events, primary } = setup(0, { extra: [limit.utxo, nowhere.utxo], backup: false });
  let now = 0;
  const pings: { kind: string; body: string }[] = [];
  const hb = new Heartbeat({ alive: 'https://hc.invalid/alive', alerts: 'https://hc.invalid/alerts', everyMs: 300_000, quietMs: 600_000, alertGapMs: 3_600_000, dryRun: false, now: () => now, send: async (p) => (pings.push({ kind: p.url.endsWith('alerts') ? `alerts:${p.kind}` : `alive:${p.kind}`, body: p.body }), { ok: true }) }, () => {});
  for (let minute = 1; minute <= 20; minute++) {
    now = minute * 60_000;
    const before = events.length;
    await watcher.round();
    for (const e of events.slice(before)) hb.observe(e);
    if (minute % 5 === 0) hb.tick();
  }
  await hb.flush();
  assert.equal(primary.submitted.length, 0);
  const last = events.at(-1)!;
  assert.ok(last.kind === 'idle' && last.reason === 'no order can be batched now' && last.orders === 2, last.kind);
  assert.deepEqual(pings.filter((p) => p.kind.startsWith('alerts')).map((p) => p.kind), ['alerts:ok', 'alerts:ok', 'alerts:ok', 'alerts:ok']);
});

test('its wallet is reported when it changes, against its cap', async () => {
  const { watcher, events, primary } = setup(1, { backup: false });
  await watcher.round();
  await watcher.round();
  primary.slot = TIP + 241n;
  await watcher.round();
  const wallet = events.filter((e) => e.kind === 'wallet');
  assert.deepEqual(wallet, [{ kind: 'wallet', held: 30n * ADA, cap: 100n * ADA }]);
});

test('each batch sent is looked for in the blocks: landed, or three in a row never landing raise an alert; a rollback un-lands; lost chain-sync judges nothing', async () => {
  const { watcher, events, primary } = setup(1, { backup: false, config: { checkLanding: true } });
  const sent = () => events.filter((e) => e.kind === 'sent').map((e) => (e as { txId: string }).txId);
  // Before chain-sync has delivered a block, a batch sent cannot be looked for.
  await watcher.round();
  watcher.blockSeen(TIP + 500n, []);
  assert.ok(!events.some((e) => e.kind === 'unlanded' || e.kind === 'landed'));
  // Landed: seen in a block before its window closed.
  primary.slot = TIP + 600n;
  await watcher.round();
  watcher.blockSeen(TIP + 610n, [sent().at(-1)!]);
  watcher.blockSeen(TIP + 900n, []);
  assert.deepEqual(events.filter((e) => e.kind === 'landed').map((e) => (e as { slot: bigint }).slot), [TIP + 610n]);
  // Landed, then rolled back past it: never landed, as far as the chain says.
  primary.slot = TIP + 1_200n;
  await watcher.round();
  watcher.blockSeen(TIP + 1_210n, [sent().at(-1)!]);
  watcher.rolledBack(TIP + 1_205n);
  watcher.blockSeen(TIP + 1_500n, []);
  // Two more never landing: the third in a row is the alert.
  for (const at of [1_800n, 2_400n]) {
    primary.slot = TIP + at;
    await watcher.round();
    watcher.blockSeen(TIP + at + 300n, []);
  }
  assert.equal(events.filter((e) => e.kind === 'alert' && /never reached a block/.test(e.reason)).length, 1);
  // One that lands starts the count again: the next one never landing is the first in a row.
  primary.slot = TIP + 2_700n;
  await watcher.round();
  watcher.blockSeen(TIP + 2_710n, [sent().at(-1)!]);
  watcher.blockSeen(TIP + 3_000n, []);
  primary.slot = TIP + 3_000n;
  await watcher.round();
  watcher.blockSeen(TIP + 3_300n, []);
  const unlanded = events.filter((e) => e.kind === 'unlanded');
  assert.deepEqual(unlanded.map((e) => (e as { inARow: number }).inARow), [1, 2, 3, 1]);
  // Chain-sync lost with a batch awaiting: no verdict on it, and none on one sent before the next block.
  primary.slot = TIP + 3_600n;
  await watcher.round();
  watcher.syncLost();
  primary.slot = TIP + 4_200n;
  await watcher.round();
  watcher.blockSeen(TIP + 4_800n, []);
  assert.equal(events.filter((e) => e.kind === 'unlanded').length, 4);
  assert.equal(sent().length, 9);
});
