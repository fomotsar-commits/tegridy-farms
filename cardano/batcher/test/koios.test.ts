// The backup source, on real answers: Koios's JSON about Minswap V2's mainnet deployment, each
// UTxO rebuilt and checked against the transaction that made it (scripts/fetch-source-fixtures.ts),
// and every way a Koios answer can say "could not tell" refused rather than read as "nothing".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { valueFromCsl } from '../src/chain.ts';
import { parseExact, stringifyExact } from '../src/json.ts';
import { Koios, utxoFromKoios } from '../src/koios.ts';
import { SourceUnavailable, SubmitRefused } from '../src/ogmios.ts';
import { equals } from '../src/value.ts';

const fx = JSON.parse(readFileSync(new URL('./fixtures/koios-responses.json', import.meta.url), 'utf8')) as { responses: Record<string, string>; creatingTxs: Record<string, string> };
const answer = (prefix: string) => {
  const key = Object.keys(fx.responses).find((k) => k.startsWith(prefix));
  assert.ok(key, `no recorded answer for ${prefix}`);
  return fx.responses[key]!;
};
const utxoLists = ['POST /credential_utxos', 'POST /asset_utxos', 'POST /utxo_info'].map((p) => parseExact(answer(p)) as Record<string, unknown>[]);
const allItems = utxoLists.flat();
const withInline = allItems.find((u) => (u.inline_datum as { bytes?: unknown } | null)?.bytes)!;
const withScript = allItems.find((u) => u.reference_script)!;
const KOIOS = 'https://koios.invalid/api/v1';

/** The output as the chain holds it: from the raw transaction that made it. */
function onChain(ref: string): CSL.TransactionOutput {
  const [hash, ix] = ref.split('#') as [string, string];
  const tx = fx.creatingTxs[hash];
  assert.ok(tx, `no creating transaction for ${ref}`);
  return CSL.Transaction.from_hex(tx).body().outputs().get(Number(ix));
}

test('every UTxO Koios returns is rebuilt into exactly the output its transaction made', () => {
  let n = 0;
  let bigLp = false;
  for (const item of allItems) {
    const u = utxoFromKoios(item);
    const mine = CSL.TransactionOutput.from_hex(u.outputHex);
    const real = onChain(u.ref);
    assert.equal(mine.address().to_hex(), real.address().to_hex(), u.ref);
    assert.ok(equals(valueFromCsl(mine.amount()), valueFromCsl(real.amount())), `${u.ref}: value`);
    assert.equal(mine.plutus_data()?.to_hex(), real.plutus_data()?.to_hex(), `${u.ref}: inline datum bytes`);
    assert.equal(mine.data_hash()?.to_hex(), real.data_hash()?.to_hex(), `${u.ref}: datum hash`);
    assert.equal(mine.script_ref()?.to_hex(), real.script_ref()?.to_hex(), `${u.ref}: reference script`);
    if ([...valueFromCsl(real.amount()).values()].some((q) => q > 2n ** 53n)) bigLp = true;
    n++;
  }
  assert.ok(n >= 7, `${n} UTxOs`);
  assert.ok(bigLp, 'no recorded UTxO holds an amount past 2^53: the exactness check proves nothing');
});

test('the block time becomes the slot it was made in (mainnet: one slot a second)', () => {
  const item = utxoLists[0]![0]!;
  const u = utxoFromKoios(item);
  assert.equal(u.createdSlot, 4_492_800n + (BigInt(String(item.block_time)) - 1_596_059_091n));
  assert.equal(u.createdTxIndex, null);
});

test('"could not tell" is never read as "nothing there": a missing asset list, a hash that does not match its bytes, a deep datum', () => {
  assert.throws(() => utxoFromKoios({ ...withInline, asset_list: null }), /no asset list/);
  const { asset_list: _drop, ...noList } = withInline;
  void _drop;
  assert.throws(() => utxoFromKoios(noList), /no asset list/);
  assert.throws(() => utxoFromKoios({ ...withInline, datum_hash: '00'.repeat(32) }), /do not hash to its hash/);
  assert.throws(() => utxoFromKoios({ ...withScript, reference_script: { ...(withScript.reference_script as object), hash: '00'.repeat(28) } }), /do not hash to its hash/);
  // A datum nested 1,600 deep breaks EMURGO's library for the whole process: refused before it reads it.
  const deep = `${'81'.repeat(1_600)}00`;
  assert.throws(() => utxoFromKoios({ ...withInline, inline_datum: { bytes: deep }, datum_hash: null }), /nested too deep/);
  assert.throws(() => utxoFromKoios({ ...withScript, reference_script: { ...(withScript.reference_script as object), bytes: deep } }), /without readable bytes/);
  assert.equal(CSL.BigNum.from_str('1').to_str(), '1', "EMURGO's library still works");
  // An asset name the ledger cannot hold (33 bytes): this UTxO is unreadable, not the read.
  assert.throws(() => utxoFromKoios({ ...withInline, asset_list: [{ policy_id: '11'.repeat(28), asset_name: '22'.repeat(33), quantity: '1' }] }), (e: unknown) => e instanceof SourceUnavailable && /unreadable/.test(e.message));
});

test('lovelace as a number (Koios v1.5) reads the same as the string it is today', () => {
  const item = { ...utxoLists[2]![0]! };
  assert.equal(utxoFromKoios({ ...item, value: BigInt(String(item.value)) }).outputHex, utxoFromKoios(item).outputHex);
});

test('one unreadable UTxO is left out and named; the rest of the answer stands', async (t) => {
  const good = utxoLists[0]![0]!;
  const bad = { ...utxoLists[0]![1]!, asset_list: null };
  t.mock.method(globalThis, 'fetch', async () => new Response(stringifyExact([good, bad]), { status: 200, headers: { 'content-range': '0-1/2' } }));
  const refused: string[] = [];
  const k = new Koios({ url: KOIOS, onRefused: (ref, why) => refused.push(`${ref}: ${why}`) });
  const got = await k.utxosAtCredential('c3e28c36c3447315ba5a56f33da6a6ddc1770a876a8d9f0cb3a97c4c');
  assert.deepEqual(got.map((u) => u.ref), [`${String(good.tx_hash)}#${String(good.tx_index)}`]);
  assert.equal(refused.length, 1);
  assert.match(refused[0]!, /no asset list/);
});

test('paging goes on to the total Koios counts, even when it caps a page below 1,000; a failed page fails the read', async (t) => {
  const rows = (n: number, from: number) => stringifyExact(Array.from({ length: n }, (_, i) => ({ ...utxoLists[0]![0]!, tx_index: BigInt(from + i) })));
  const seen: string[] = [];
  let fail = false;
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    seen.push(url);
    assert.equal(new Headers(init.headers).get('prefer'), 'count=exact');
    if (fail) return new Response('upstream timeout', { status: 504 });
    const offset = Number(new URL(url).searchParams.get('offset'));
    // A server that caps pages at 500 and counts 1,203 rows.
    const n = Math.min(500, 1_203 - offset);
    return new Response(rows(n, offset), { status: 200, headers: { 'content-range': `${offset}-${offset + n - 1}/1203` } });
  });
  const k = new Koios({ url: KOIOS });
  const all = await k.utxosAtCredential('c3e28c36c3447315ba5a56f33da6a6ddc1770a876a8d9f0cb3a97c4c');
  assert.equal(all.length, 1_203);
  assert.deepEqual(seen.map((u) => new URL(u).searchParams.get('offset')), ['0', '500', '1000']);
  fail = true;
  await assert.rejects(() => k.utxosAtCredential('c3e28c36c3447315ba5a56f33da6a6ddc1770a876a8d9f0cb3a97c4c'), /HTTP 504/);
});

test('utxo_info answers spent outputs too: only unspent ones are kept', async (t) => {
  const [a, b] = [utxoLists[2]![0], utxoLists[2]![1]] as Record<string, unknown>[];
  t.mock.method(globalThis, 'fetch', async () => new Response(stringifyExact([{ ...a, is_spent: true }, { ...b, is_spent: false }]), { status: 200 }));
  const got = await new Koios({ url: KOIOS }).utxos(['x#0', 'y#0']);
  assert.deepEqual(got.map((u) => u.ref), [`${String(b!.tx_hash)}#${String(b!.tx_index)}`]);
});

test('the batching account: its real balance, a balance it cannot read is a failure, an unregistered account is refused', async (t) => {
  const real = JSON.parse(answer('POST /account_info')) as Record<string, unknown>[];
  let next = stringifyExact([{ ...real[0], rewards_available: '1234567' }]);
  t.mock.method(globalThis, 'fetch', async () => new Response(next, { status: 200 }));
  const k = new Koios({ url: KOIOS });
  assert.equal(await k.rewardBalance('stake17y02a946720zw6pw50upt2arvxsvvpvaghjtl054h0f0gjsfyjz59'), 1_234_567n);
  next = stringifyExact([{ ...real[0], rewards_available: null }]);
  await assert.rejects(() => k.rewardBalance('stake17y02a946720zw6pw50upt2arvxsvvpvaghjtl054h0f0gjsfyjz59'), (e: unknown) => e instanceof SourceUnavailable && /rewards_available/.test(e.message));
  next = JSON.stringify([{ stake_address: 'stake1x', status: 'not registered', rewards_available: '0' }]);
  await assert.rejects(() => k.rewardBalance('stake1x'), /not a registered reward account/);
});

test('a datum: its bytes, "not seen", or a failure; never "not seen" for an answer Koios did not give', async (t) => {
  let body = '[{"datum_hash":"aa","bytes":"d87980"}]';
  t.mock.method(globalThis, 'fetch', async () => new Response(body, { status: 200 }));
  const k = new Koios({ url: KOIOS });
  assert.equal(await k.datum('aa'), 'd87980');
  body = '[]';
  assert.equal(await k.datum('aa'), null);
  body = '{"error":"not a list"}';
  await assert.rejects(() => k.datum('aa'), SourceUnavailable);
});

test('protocol parameters come from Koios’s Ogmios: the node’s own, prices exact', async (t) => {
  const recorded = readFileSync(new URL('./fixtures/ogmios-protocol-parameters.json', import.meta.url), 'utf8');
  let asked = '';
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    asked = `${url} ${String(init.body)}`;
    return new Response(recorded, { status: 200 });
  });
  const pp = await new Koios({ url: KOIOS }).protocolParams();
  assert.match(asked, /\/ogmios .*queryLedgerState\/protocolParameters/);
  assert.deepEqual(pp.executionUnitPrices, { priceMemory: '577/10000', priceSteps: '721/10000000' });
});

test('Koios refusals are read as the ledger words them; an accepted id comes back quoted or not', async (t) => {
  let status = 400;
  let body = '{"tag":"TxSubmitFail","contents":{"tag":"TxCmdTxSubmitValidationError","contents":{"error":["ConwayUtxowFailure (UtxoFailure (BadInputsUTxO (fromList [TxIn ...])))"]}}}';
  t.mock.method(globalThis, 'fetch', async () => new Response(body, { status }));
  const k = new Koios({ url: KOIOS });
  await assert.rejects(() => k.submit('84a0a0f5f6'), (e: unknown) => e instanceof SubmitRefused && e.benign && !e.withdrawal);
  body = '{"tag":"TxSubmitFail","contents":{"error":["ConwayUtxoFailure (OutsideValidityIntervalUTxO (ValidityInterval ...) (SlotNo 1))"]}}';
  await assert.rejects(() => k.submit('84a0a0f5f6'), (e: unknown) => e instanceof SubmitRefused && e.benign);
  body = '{"tag":"TxSubmitFail","contents":{"error":["ConwayWdrlNotDelegatedToDRep","WithdrawalsNotInRewardsCERTS"]}}';
  await assert.rejects(() => k.submit('84a0a0f5f6'), (e: unknown) => e instanceof SubmitRefused && !e.benign && e.withdrawal);
  body = '{"tag":"TxSubmitFail","contents":{"error":["FeeTooSmallUTxO"]}}';
  await assert.rejects(() => k.submit('84a0a0f5f6'), (e: unknown) => e instanceof SubmitRefused && !e.benign && !e.withdrawal);
  status = 202;
  const id = 'ab'.repeat(32);
  for (body of [JSON.stringify(id), id]) assert.equal(await k.submit('84a0a0f5f6'), id);
  status = 502;
  body = '<html>Bad gateway</html>';
  await assert.rejects(() => k.submit('84a0a0f5f6'), SourceUnavailable);
});
