// The primary UTxO source. No keyless Kupo exists, so the real mainnet outputs recorded for the
// Koios tests (Minswap V2's orders, pools, reference scripts, global setting) are written the way
// Kupo v2.12.0's source writes a match (amounts as bare JSON numbers of any size), read back by
// the client, and checked against the transactions that made them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { valueFromCsl } from '../src/chain.ts';
import { LibraryTrapped } from '../src/cbor.ts';
import { parseExact, stringifyExact } from '../src/json.ts';
import { Kupo, checkKupoReady, utxoFromKupo } from '../src/kupo.ts';
import { SourceUnavailable } from '../src/ogmios.ts';
import { equals } from '../src/value.ts';

const fx = JSON.parse(readFileSync(new URL('./fixtures/koios-responses.json', import.meta.url), 'utf8')) as { creatingTxs: Record<string, string> };

/** Every output of the recorded transactions that is one of the recorded UTxOs' kind: all of them. */
const outputs = Object.entries(fx.creatingTxs).flatMap(([hash, tx]) => {
  const outs = CSL.Transaction.from_hex(tx).body().outputs();
  return Array.from({ length: outs.len() }, (_, i) => ({ hash, index: i, out: outs.get(i) }));
});

/** A match as Kupo writes it (Pattern.hs, Value.hs): the key order and forms of its source. */
function asKupo(hash: string, index: number, o: CSL.TransactionOutput, slot = 160_000_000n): Record<string, unknown> {
  const v = valueFromCsl(o.amount());
  const assets: Record<string, bigint> = {};
  for (const [unit, q] of v) if (unit !== '') assets[unit.endsWith('.') ? unit.slice(0, -1) : unit] = q;
  const datum = o.plutus_data();
  const sr = o.script_ref();
  const script = sr?.is_plutus_script()
    ? { script: Buffer.from(sr.plutus_script()!.bytes()).toString('hex'), language: `plutus:v${sr.plutus_script()!.language_version().kind() + 1}` }
    : sr
      ? { script: sr.native_script()!.to_hex(), language: 'native' }
      : null;
  return {
    transaction_index: 3n,
    transaction_id: hash,
    output_index: BigInt(index),
    address: o.address().to_bech32(undefined),
    value: { coins: v.get('') ?? 0n, assets },
    datum_hash: datum ? CSL.hash_plutus_data(datum).to_hex() : (o.data_hash()?.to_hex() ?? null),
    datum: datum ? datum.to_hex() : null,
    ...(datum || o.data_hash() ? { datum_type: datum ? 'inline' : 'hash' } : {}),
    script_hash: sr ? (sr.is_plutus_script() ? sr.plutus_script()!.hash().to_hex() : sr.native_script()!.hash().to_hex()) : null,
    script,
    created_at: { slot_no: slot, header_hash: 'ab'.repeat(32) },
    spent_at: null,
  };
}

test('every real output, written as Kupo writes it, is read back exactly (amounts past 2^53 included)', () => {
  let big = false;
  for (const { hash, index, out } of outputs) {
    const wire = stringifyExact([asKupo(hash, index, out)]);
    if (/:\s*\d{17,}/.test(wire)) big = true;
    const u = utxoFromKupo((parseExact(wire) as unknown[])[0]);
    const mine = CSL.TransactionOutput.from_hex(u.outputHex);
    assert.equal(u.ref, `${hash}#${index}`);
    assert.equal(mine.address().to_hex(), out.address().to_hex(), u.ref);
    assert.ok(equals(valueFromCsl(mine.amount()), valueFromCsl(out.amount())), `${u.ref}: value`);
    assert.equal(mine.plutus_data()?.to_hex(), out.plutus_data()?.to_hex(), `${u.ref}: inline datum`);
    assert.equal(mine.data_hash()?.to_hex(), out.data_hash()?.to_hex(), `${u.ref}: datum hash`);
    assert.equal(mine.script_ref()?.to_hex(), out.script_ref()?.to_hex(), `${u.ref}: reference script`);
    assert.equal(u.createdSlot, 160_000_000n);
    assert.equal(u.createdTxIndex, 3);
  }
  assert.ok(outputs.length >= 10);
  assert.ok(big, 'no amount past 2^53 was written: the exactness check proves nothing');
});

test('a match whose datum or script does not hash to what Kupo says is refused, never trusted', () => {
  const withDatum = outputs.find((x) => x.out.plutus_data())!;
  const m = asKupo(withDatum.hash, withDatum.index, withDatum.out);
  assert.throws(() => utxoFromKupo({ ...m, datum_hash: '00'.repeat(32) }), /do not hash/);
  const withScript = outputs.find((x) => x.out.script_ref())!;
  const s = asKupo(withScript.hash, withScript.index, withScript.out);
  assert.throws(() => utxoFromKupo({ ...s, script_hash: '00'.repeat(28) }), /do not hash/);
  assert.throws(() => utxoFromKupo({ ...s, script: null }), /did not resolve/);
  assert.throws(() => utxoFromKupo({ ...m, spent_at: { slot_no: 1n, header_hash: 'ab'.repeat(32) } }), /spent/);
});

test('the client asks with bare flags and exact quantities, and a broken body is a failure, not an empty list', async (t) => {
  const asked: { url: string; accept: string | null }[] = [];
  let body = '[]';
  let checkpoint = '201339477';
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    asked.push({ url, accept: new Headers(init.headers).get('accept') });
    return new Response(body, { status: 200, headers: { 'x-most-recent-checkpoint': checkpoint } });
  });
  const k = new Kupo({ url: 'https://kupo.invalid', headers: { 'dmtr-api-key': 'test' } });
  assert.deepEqual(await k.unspent('c3e28c36c3447315ba5a56f33da6a6ddc1770a876a8d9f0cb3a97c4c/*'), { value: [], checkpoint: 201_339_477n });
  assert.equal(asked[0]!.url, 'https://kupo.invalid/matches/c3e28c36c3447315ba5a56f33da6a6ddc1770a876a8d9f0cb3a97c4c/*?unspent&resolve_hashes');
  assert.equal(asked[0]!.accept, 'application/json;asset-quantity=string');
  body = '[{"transaction_index":0,"transaction_id":"';
  await assert.rejects(() => k.unspent('*'), /unreadable answer/);
  checkpoint = 'nonsense';
  body = '[]';
  assert.equal((await k.unspent('*')).checkpoint, null);
});

test('a deep datum or script is refused before EMURGO’s library reads it, and one bad match leaves the rest of the answer', async (t) => {
  const withDatum = outputs.find((x) => x.out.plutus_data())!;
  const withScript = outputs.find((x) => x.out.script_ref()?.is_plutus_script())!;
  const deep = `${'81'.repeat(1_600)}00`;
  const good = asKupo(withDatum.hash, withDatum.index, withDatum.out);
  const deepDatum = { ...good, output_index: 99n, datum: deep };
  const deepScript = { ...asKupo(withScript.hash, withScript.index, withScript.out), output_index: 98n, script: { script: deep, language: 'plutus:v2' } };
  const future = { ...asKupo(withScript.hash, withScript.index, withScript.out), output_index: 97n, script: { script: '4d01000033222220051200120011', language: 'plutus:v4' } };
  assert.throws(() => utxoFromKupo(deepDatum), /nested too deep/);
  assert.throws(() => utxoFromKupo(deepScript), /nested too deep/);
  assert.equal(CSL.BigNum.from_str('1').to_str(), '1', "EMURGO's library still works");
  t.mock.method(globalThis, 'fetch', async () => new Response(stringifyExact([good, deepDatum, deepScript, future]), { status: 200, headers: { 'x-most-recent-checkpoint': '1' } }));
  const refused: string[] = [];
  const k = new Kupo({ url: 'https://kupo.invalid', onRefused: (ref, why) => refused.push(`${ref.split('#')[1]} ${why}`) });
  const got = await k.unspent('*');
  assert.deepEqual(got.value.map((u) => u.ref), [`${withDatum.hash}#${withDatum.index}`]);
  assert.equal(refused.length, 3);
  assert.match(refused.join(' | '), /99 .*nested too deep.*98 .*nested too deep.*97 .*plutus:v4/);
});

test('a datum by its hash: the bytes Kupo kept, "not seen", or a failure', async (t) => {
  let body = '{"datum":"d87980"}';
  let status = 200;
  t.mock.method(globalThis, 'fetch', async () => new Response(body, { status, headers: { 'x-most-recent-checkpoint': '1' } }));
  const k = new Kupo({ url: 'https://kupo.invalid' });
  assert.equal(await k.datum('aa'.repeat(32)), 'd87980');
  body = 'null';
  assert.equal(await k.datum('aa'.repeat(32)), null);
  body = '{"hint":"bad hash"}';
  status = 400;
  await assert.rejects(() => k.datum('aa'), SourceUnavailable);
  status = 200;
  body = '{"something":"else"}';
  await assert.rejects(() => k.datum('aa'.repeat(32)), SourceUnavailable);
});

test('health is asked for as JSON (Kupo answers Prometheus text to Node’s default */*)', async (t) => {
  let accept: string | null = null;
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    accept = new Headers(init.headers).get('accept');
    return new Response('{"connection_status":"connected","most_recent_checkpoint":201339470,"most_recent_node_tip":201339477,"seconds_since_last_block":3,"network_synchronization":1.00000,"configuration":{"indexes":"installed"},"version":"v2.11.0"}', { status: 200 });
  });
  const h = await new Kupo({ url: 'https://kupo.invalid' }).health();
  assert.equal(accept, 'application/json');
  assert.deepEqual(h, { connected: true, checkpoint: 201_339_470n, nodeTip: 201_339_477n, indexesInstalled: true, version: 'v2.11.0' });
});

test('a Kupo not indexing what the batcher asks about is refused before it can answer "nothing there"', async (t) => {
  let health = { connection_status: 'connected', most_recent_checkpoint: 1, most_recent_node_tip: 1, configuration: { indexes: 'installed' }, version: 'v2.12.0' } as Record<string, unknown>;
  let covered = true;
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (url.endsWith('/health')) return new Response(JSON.stringify(health), { status: 200 });
    return new Response(covered ? '["*"]' : '[]', { status: 200, headers: { 'x-most-recent-checkpoint': '1' } });
  });
  const k = new Kupo({ url: 'https://kupo.invalid' });
  await checkKupoReady(k, ['aa/*']);
  covered = false;
  await assert.rejects(() => checkKupoReady(k, ['aa/*']), /does not index aa\/\*/);
  covered = true;
  health = { ...health, configuration: { indexes: 'deferred' } };
  await assert.rejects(() => checkKupoReady(k, ['aa/*']), /indexes/);
  health = { ...health, connection_status: 'disconnected', configuration: { indexes: 'installed' } };
  await assert.rejects(() => checkKupoReady(k, ['aa/*']), /not connected/);
});

test('a hash-only output’s datum, sent along by Kupo, is kept only if it hashes to the output’s hash', () => {
  const withDatum = outputs.find((x) => x.out.plutus_data())!;
  const real = withDatum.out.plutus_data()!;
  const hash = CSL.hash_plutus_data(real).to_hex();
  const m = { ...asKupo(withDatum.hash, withDatum.index, withDatum.out), datum_type: 'hash', datum_hash: hash, datum: real.to_hex() };
  const u = utxoFromKupo(m);
  assert.equal(u.witnessDatum, real.to_hex());
  assert.equal(CSL.TransactionOutput.from_hex(u.outputHex).data_hash()?.to_hex(), hash);
  assert.equal(CSL.TransactionOutput.from_hex(u.outputHex).plutus_data(), undefined);
  assert.throws(() => utxoFromKupo({ ...m, datum: CSL.PlutusData.new_integer(CSL.BigInt.from_str('1')).to_hex() }), /do not hash/);
  assert.equal(utxoFromKupo({ ...m, datum: null }).witnessDatum, undefined);
});

test('a match whose bytes break EMURGO’s library is named (the process restarts); one named before is never decoded', async (t) => {
  class RuntimeError extends Error {}
  const withDatum = outputs.find((x) => x.out.plutus_data())!;
  const good = asKupo(withDatum.hash, withDatum.index, withDatum.out);
  const poison = { ...good, output_index: 77n, datum: 'd87a80', datum_hash: CSL.hash_plutus_data(CSL.PlutusData.from_hex('d87a80')).to_hex() };
  const fromHex = CSL.PlutusData.from_hex.bind(CSL.PlutusData);
  t.mock.method(CSL.PlutusData, 'from_hex', (hex: string) => {
    if (hex === 'd87a80') throw new RuntimeError('unreachable');
    return fromHex(hex);
  });
  t.mock.method(globalThis, 'fetch', async () => new Response(stringifyExact([good, poison]), { status: 200, headers: { 'x-most-recent-checkpoint': '1' } }));
  const ref = `${withDatum.hash}#77`;
  await assert.rejects(new Kupo({ url: 'https://kupo.invalid' }).unspent('*'), (e: unknown) => e instanceof LibraryTrapped && e.refs.length === 1 && e.refs[0] === ref);
  const got = await new Kupo({ url: 'https://kupo.invalid', skip: (r) => r === ref }).unspent('*');
  assert.deepEqual(got.value.map((u) => u.ref), [`${withDatum.hash}#${withDatum.index}`]);
});
