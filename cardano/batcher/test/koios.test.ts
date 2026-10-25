// The backup source, on real answers: Koios's JSON about Minswap V2's mainnet deployment, each
// UTxO rebuilt and checked against the transaction that made it (scripts/fetch-source-fixtures.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { valueFromCsl } from '../src/chain.ts';
import { parseExact, stringifyExact } from '../src/json.ts';
import { Koios, protocolParamsFromKoios, utxoFromKoios } from '../src/koios.ts';
import { SourceUnavailable, SubmitRefused, protocolParamsFromOgmios } from '../src/ogmios.ts';
import { equals } from '../src/value.ts';
import { rational } from '../src/fee.ts';

const fx = JSON.parse(readFileSync(new URL('./fixtures/koios-responses.json', import.meta.url), 'utf8')) as { responses: Record<string, string>; creatingTxs: Record<string, string> };
const answer = (prefix: string) => {
  const key = Object.keys(fx.responses).find((k) => k.startsWith(prefix));
  assert.ok(key, `no recorded answer for ${prefix}`);
  return fx.responses[key]!;
};
const utxoLists = ['POST /credential_utxos', 'POST /asset_utxos', 'POST /utxo_info'].map((p) => parseExact(answer(p)) as Record<string, unknown>[]);

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
  for (const list of utxoLists) {
    for (const item of list) {
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

test('Koios’s protocol parameters are Ogmios’s, value for value', () => {
  const k = protocolParamsFromKoios(parseExact(answer('GET /cli_protocol_params')));
  const o = protocolParamsFromOgmios((parseExact(readFileSync(new URL('./fixtures/ogmios-protocol-parameters.json', import.meta.url), 'utf8')) as { result: unknown }).result);
  const same = (a: number | string, b: number | string) => {
    const x = rational(a);
    const y = rational(b);
    return x.n * y.d === y.n * x.d;
  };
  assert.ok(same(k.executionUnitPrices.priceMemory, o.executionUnitPrices.priceMemory));
  assert.ok(same(k.executionUnitPrices.priceSteps, o.executionUnitPrices.priceSteps));
  assert.ok(same(k.minFeeRefScriptCostPerByte, o.minFeeRefScriptCostPerByte));
  for (const key of ['txFeePerByte', 'txFeeFixed', 'utxoCostPerByte', 'maxTxSize', 'maxValueSize', 'collateralPercentage', 'stakeAddressDeposit', 'stakePoolDeposit', 'costModelPlutusV2', 'costModelPlutusV3', 'maxTxExecutionUnits'] as const) {
    assert.deepEqual(k[key], o[key], key);
  }
});

test('the Koios client reads the batching account’s balance, and refuses an unregistered one', async (t) => {
  const real = answer('POST /account_info');
  const unregistered = JSON.stringify([{ stake_address: 'stake1x', status: 'not registered', rewards_available: '0' }]);
  let next = real;
  t.mock.method(globalThis, 'fetch', async () => new Response(next, { status: 200 }));
  const k = new Koios({ url: 'https://koios.invalid/api/v1' });
  assert.equal(await k.rewardBalance('stake17y02a946720zw6pw50upt2arvxsvvpvaghjtl054h0f0gjsfyjz59'), 0n);
  next = unregistered;
  await assert.rejects(() => k.rewardBalance('stake1x'), /not a registered reward account/);
});

test('the Koios client pages through every row, and a failed request is a source failure, not an empty list', async (t) => {
  const rows = (n: number, from: number) => stringifyExact(Array.from({ length: n }, (_, i) => ({ ...(utxoLists[0]![0] as object), tx_index: from + i })));
  const seen: string[] = [];
  let fail = false;
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    seen.push(url);
    if (fail) return new Response('upstream timeout', { status: 504 });
    const offset = Number(new URL(url).searchParams.get('offset'));
    return new Response(offset === 0 ? rows(1000, 0) : rows(3, 1000), { status: 200 });
  });
  const k = new Koios({ url: 'https://koios.invalid/api/v1' });
  const all = await k.utxosAtCredential('c3e28c36c3447315ba5a56f33da6a6ddc1770a876a8d9f0cb3a97c4c');
  assert.equal(all.length, 1003);
  assert.deepEqual(seen.map((u) => new URL(u).searchParams.get('offset')), ['0', '1000']);
  fail = true;
  await assert.rejects(() => k.utxosAtCredential('c3e28c36c3447315ba5a56f33da6a6ddc1770a876a8d9f0cb3a97c4c'), /HTTP 504/);
});

test('Koios refusals are read as the ledger words them; an accepted id comes back quoted or not', async (t) => {
  let status = 400;
  let body = '{"tag":"TxSubmitFail","contents":{"tag":"TxCmdTxSubmitValidationError","contents":{"error":["ConwayUtxowFailure (UtxoFailure (BadInputsUTxO (fromList [TxIn ...])))"]}}}';
  t.mock.method(globalThis, 'fetch', async () => new Response(body, { status }));
  const k = new Koios({ url: 'https://koios.invalid/api/v1' });
  await assert.rejects(() => k.submit('84a0a0f5f6'), (e: unknown) => e instanceof SubmitRefused && e.benign && !e.withdrawal);
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

test('utxo_info answers spent outputs too: only unspent ones are kept; lovelace as a number (Koios v1.5) reads the same', () => {
  const item = { ...(utxoLists[2]![0] as Record<string, unknown>) };
  const asNumber = { ...item, value: BigInt(String(item.value)) };
  assert.equal(utxoFromKoios(asNumber).outputHex, utxoFromKoios(item).outputHex);
});

test('the Koios client keeps only unspent outputs from utxo_info', async (t) => {
  const [a, b] = [utxoLists[2]![0], utxoLists[2]![1]] as Record<string, unknown>[];
  t.mock.method(globalThis, 'fetch', async () => new Response(stringifyExact([{ ...a, is_spent: true }, { ...b, is_spent: false }]), { status: 200 }));
  const got = await new Koios({ url: 'https://koios.invalid/api/v1' }).utxos(['x#0', 'y#0']);
  assert.deepEqual(got.map((u) => u.ref), [`${String(b!.tx_hash)}#${String(b!.tx_index)}`]);
});
