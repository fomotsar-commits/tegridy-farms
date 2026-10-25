// The primary view: Kupo's answers count only if Kupo had indexed up to the node's tip, and
// asset queries keep only the outputs at the credential asked for.
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

function serve(t: { mock: { method: (o: object, m: string, f: unknown) => unknown } }, checkpoint: () => bigint, body: () => unknown[]) {
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (url.startsWith('https://ogmios.invalid')) return new Response(stringifyExact({ jsonrpc: '2.0', method: 'queryNetwork/tip', result: { slot: TIP, id: 'cd'.repeat(32) } }), { status: 200 });
    return new Response(stringifyExact(body()), { status: 200, headers: { 'x-most-recent-checkpoint': String(checkpoint()) } });
  });
}

test('a Kupo behind the node’s tip is a source failure for the round, not an empty or stale answer', async (t) => {
  const w = world();
  let at = TIP;
  serve(t, () => at, () => [match(w.pool.ref, w.pool.outputHex)]);
  const v = ogmiosKupoView({ url: 'https://ogmios.invalid' }, new Kupo({ url: 'https://kupo.invalid' }), async () => 0n);
  await v.tip();
  assert.equal((await v.utxosAtCredential(DEX.poolScriptHash)).length, 1);
  at = TIP - 60n; // within the allowed lag
  assert.equal((await v.utxos([w.pool.ref])).length, 1);
  at = TIP - 61n;
  await assert.rejects(() => v.utxosAtCredential(DEX.poolScriptHash), (e: unknown) => e instanceof SourceUnavailable && /indexed to slot/.test((e as Error).message));
});

test('an asset query keeps only the outputs at the credential asked for', async (t) => {
  const w = world();
  // The pool NFT's policy also marks the batcher's UTxO here (a stranger can send tokens anywhere).
  const stray = { ...w.batcher.feeUtxos[0]!, outputHex: CSL.TransactionOutput.new(BATCHER_ADDRESS, CSL.TransactionOutput.from_hex(w.pool.outputHex).amount()).to_hex() };
  serve(t, () => TIP, () => [match(w.pool.ref, w.pool.outputHex), match(stray.ref, stray.outputHex)]);
  const v = ogmiosKupoView({ url: 'https://ogmios.invalid' }, new Kupo({ url: 'https://kupo.invalid' }), async () => 0n);
  await v.tip();
  assert.deepEqual((await v.utxosWithAsset(DEX.authenPolicy, '4d5350', DEX.poolScriptHash)).map((u) => u.ref), [w.pool.ref]);
  assert.deepEqual((await v.utxosWithAsset(DEX.authenPolicy, '4d5350', BATCHER_KEY)).map((u) => u.ref), [stray.ref]);
});
