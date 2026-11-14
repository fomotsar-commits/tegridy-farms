// The primary view: each Kupo answer is judged on the point it carries; a round's answers must all
// come from one point, within 60 slots of the node's tip; asset queries keep only the outputs at
// the credential asked for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { stringifyExact } from '../src/json.ts';
import { Kupo } from '../src/kupo.ts';
import { SourceUnavailable } from '../src/ogmios.ts';
import { ogmiosKupoView } from '../src/view.ts';
import { BATCHER_ADDRESS, BATCHER_KEY, DEX, world } from './world.ts';

const TIP = 201_340_000n;

/** A match for one of the world's outputs, as Kupo writes it. */
function match(ref: string, outputHex: string) {
  const o = CSL.TransactionOutput.from_hex(outputHex);
  const ma = o.amount().multiasset();
  const assets: Record<string, bigint> = {};
  for (let i = 0; ma && i < ma.keys().len(); i++) {
    const p = ma.keys().get(i);
    const a = ma.get(p)!;
    for (let j = 0; j < a.keys().len(); j++) {
      const n = Buffer.from(a.keys().get(j).name()).toString('hex');
      assets[n ? `${p.to_hex()}.${n}` : p.to_hex()] = BigInt(a.get(a.keys().get(j))!.to_str());
    }
  }
  const d = o.plutus_data();
  const [tx, ix] = ref.split('#') as [string, string];
  return { transaction_index: 0n, transaction_id: tx, output_index: BigInt(ix), address: o.address().to_bech32(undefined), value: { coins: BigInt(o.amount().coin().to_str()), assets }, datum_hash: d ? CSL.hash_plutus_data(d).to_hex() : null, datum: d ? d.to_hex() : null, ...(d ? { datum_type: 'inline' } : {}), script_hash: null, script: null, created_at: { slot_no: 1n, header_hash: 'ab'.repeat(32) }, spent_at: null };
}

/** Ogmios at TIP; Kupo answering `body()` at the checkpoint `checkpoint(url)` gives. */
function serve(t: { mock: { method: (o: object, m: string, f: unknown) => unknown } }, checkpoint: (url: string) => bigint, body: () => unknown[]) {
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (url.startsWith('https://ogmios.invalid')) return new Response(stringifyExact({ jsonrpc: '2.0', method: 'queryNetwork/tip', result: { slot: TIP, id: 'cd'.repeat(32) } }), { status: 200 });
    return new Response(stringifyExact(body()), { status: 200, headers: { 'x-most-recent-checkpoint': String(checkpoint(url)) } });
  });
}
const view = () => ogmiosKupoView({ url: 'https://ogmios.invalid' }, new Kupo({ url: 'https://kupo.invalid' }), async () => 0n);
const lagging = (e: unknown) => e instanceof SourceUnavailable && /indexed to slot/.test((e as Error).message);

test('a Kupo behind the node’s tip fails the round on every kind of read: by credential, by reference, by asset', async (t) => {
  const w = world();
  let at = TIP;
  serve(t, () => at, () => [match(w.pool.ref, w.pool.outputHex)]);
  const v = view();
  await v.tip();
  assert.equal((await v.utxosAtCredential(DEX.poolScriptHash)).length, 1);
  at = TIP - 60n; // as far behind as allowed: a new round, so a new point
  await v.tip();
  assert.equal((await v.utxos([w.pool.ref])).length, 1);
  at = TIP - 61n;
  for (const read of [() => v.utxosAtCredential(DEX.poolScriptHash), () => v.utxos([w.pool.ref]), () => v.utxosWithAsset(DEX.authenPolicy, '4d5350', DEX.poolScriptHash)]) {
    await v.tip();
    await assert.rejects(read, lagging);
  }
});

test('a round’s answers must come from one point: Kupo moving mid-round fails it (answers judged each on its own header)', async (t) => {
  const w = world();
  // The reference read answers from an older point than the credential read, both within the lag.
  serve(t, (url) => (url.includes('@') ? TIP - 30n : TIP - 1n), () => [match(w.pool.ref, w.pool.outputHex)]);
  const v = view();
  await v.tip();
  await v.utxosAtCredential(DEX.poolScriptHash);
  await assert.rejects(() => v.utxos([w.pool.ref]), (e: unknown) => e instanceof SourceUnavailable && /moved from slot/.test((e as Error).message));
  // Two reads at once: a stale answer cannot pass on the other's header.
  await v.tip();
  const both = await Promise.allSettled([v.utxos([w.pool.ref]), v.utxosAtCredential(DEX.poolScriptHash)]);
  assert.ok(both.some((r) => r.status === 'rejected'));
  // An answer that does not say how far Kupo had indexed is not believed.
  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async (url: string) =>
    url.startsWith('https://ogmios.invalid') ? new Response(stringifyExact({ jsonrpc: '2.0', method: 'queryNetwork/tip', result: { slot: TIP, id: 'cd'.repeat(32) } }), { status: 200 }) : new Response('[]', { status: 200 }),
  );
  await v.tip();
  await assert.rejects(() => v.utxosAtCredential(DEX.poolScriptHash), /did not say how far/);
});

test('an asset query keeps only the outputs at the credential asked for', async (t) => {
  const w = world();
  // The pool NFT's policy also marks the batcher's UTxO here (a stranger can send tokens anywhere).
  const stray = { ...w.batcher.feeUtxos[0]!, outputHex: CSL.TransactionOutput.new(BATCHER_ADDRESS, CSL.TransactionOutput.from_hex(w.pool.outputHex).amount()).to_hex() };
  serve(t, () => TIP, () => [match(w.pool.ref, w.pool.outputHex), match(stray.ref, stray.outputHex)]);
  const v = view();
  await v.tip();
  assert.deepEqual((await v.utxosWithAsset(DEX.authenPolicy, '4d5350', DEX.poolScriptHash)).map((u) => u.ref), [w.pool.ref]);
  assert.deepEqual((await v.utxosWithAsset(DEX.authenPolicy, '4d5350', BATCHER_KEY)).map((u) => u.ref), [stray.ref]);
});
