// The node's own evaluator as the judge. Recorded answers from mainnet's node (through Koios's
// Ogmios proxy, scripts/fetch-ogmios-fixtures.ts) prove the client reads them right; with
// OGMIOS_URL set (e.g. https://api.koios.rest/api/v1/ogmios) the same node judges our batches
// live, including the ones Aiken 1.0.24 cannot (40 swaps; a pool carrying an unused script).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { parseExact, stringifyExact } from '../src/json.ts';
import { InputsGone, NotJudged, OgmiosError, SourceUnavailable, SubmitRefused, budgetsFromOgmios, ogmiosEvaluator, protocolParamsFromOgmios, refusalFromOgmios, toOgmiosUtxo } from '../src/ogmios.ts';
import { prepareBatch } from '../src/prepare.ts';
import type { Utxo } from '../src/plan.ts';
import { DEX, NETWORK, PP, order, scriptRefOf, step, world } from './world.ts';
import { plusFirstToken, withOutput } from './tamper.ts';

const ev = JSON.parse(readFileSync(new URL('./fixtures/ogmios-evaluations.json', import.meta.url), 'utf8')) as Record<'accepted' | 'overBudget' | 'scriptFailure', { answer: string }>;
const fx = JSON.parse(readFileSync(new URL('./fixtures/minswap-batches.json', import.meta.url), 'utf8')) as { batches: { tx: string; cbor: string }[]; spent: Record<string, string> };
const EP = { url: 'https://ogmios.invalid' };
const ADA = 1_000_000n;

/** The budgets a real transaction declares, keyed as prepare.ts keys them. */
function declared(txHex: string): Map<string, { mem: bigint; steps: bigint }> {
  const rs = CSL.Transaction.from_hex(txHex).witness_set().redeemers()!;
  const tags = ['spend', 'mint', 'cert', 'reward'];
  return new Map(Array.from({ length: rs.len() }, (_, i) => [`${tags[rs.get(i).tag().kind()]}:${rs.get(i).index().to_str()}`, { mem: BigInt(rs.get(i).ex_units().mem().to_str()), steps: BigInt(rs.get(i).ex_units().steps().to_str()) }]));
}

const answering = (t: { mock: { method: (o: object, m: string, f: unknown) => unknown; restoreAll: () => void } }, body: string | (() => never), status = 200) =>
  t.mock.method(globalThis, 'fetch', async () => (typeof body === 'function' ? body() : new Response(body, { status })));

test('mainnet’s node accepted a real Minswap batch, measuring exactly the budgets Minswap declared', async (t) => {
  answering(t, ev.accepted.answer);
  const r = await ogmiosEvaluator(EP)(fx.batches[0]!.cbor, fx.spent);
  assert.ok(r.ok);
  const want = declared(fx.batches[0]!.cbor);
  assert.equal(r.budgets.length, want.size);
  for (const b of r.budgets) assert.deepEqual({ mem: b.mem, steps: b.steps }, want.get(`${b.tag.toLowerCase()}:${b.index}`), `${b.tag} ${b.index}`);
});

test('a script out of budget is a verdict marked too big; a script that fails is a verdict, not too big', async (t) => {
  answering(t, ev.overBudget.answer);
  const over = await ogmiosEvaluator(EP)('', {});
  assert.equal(over.ok, false);
  assert.equal(!over.ok && over.overBudget, true);
  t.mock.restoreAll();
  answering(t, ev.scriptFailure.answer);
  const failed = await ogmiosEvaluator(EP)('', {});
  assert.equal(failed.ok, false);
  assert.equal(!failed.ok && failed.overBudget, false);
});

const rpcError = (code: number, message: string, data: unknown = {}) => stringifyExact({ jsonrpc: '2.0', method: 'evaluateTransaction', error: { code, message, data } });
const evaluated = async (t: Parameters<typeof answering>[0], body: string, status = 400) => {
  t.mock.restoreAll();
  answering(t, body, status);
  return Promise.resolve(ogmiosEvaluator(EP)('', {}));
};

test('anything but a script verdict is thrown, so no order is ever blamed for the node or the network', async (t) => {
  // An input gone, said at the top level: InputsGone.
  await assert.rejects(() => evaluated(t, rpcError(3117, 'Unknown transaction input')), InputsGone);
  await assert.rejects(() => evaluated(t, rpcError(3004, 'Cannot create evaluation context', { reason: 'Unknown transaction input (missing from UTxO set): aa#0' })), InputsGone);
  // The node or the connection: thrown as they are (the round tries another source).
  for (const code of [-32000, -32603, 3003]) await assert.rejects(() => evaluated(t, rpcError(code, 'node trouble')), (e: unknown) => e instanceof OgmiosError && e.code === code);
  await assert.rejects(() => evaluated(t, '<html>502 Bad Gateway</html>', 502), SourceUnavailable);
  t.mock.restoreAll();
  answering(t, () => {
    throw new TypeError('fetch failed');
  });
  await assert.rejects(() => Promise.resolve(ogmiosEvaluator(EP)('', {})), SourceUnavailable);
  // About the batch, but not a verdict: NotJudged (set aside, alerted; never an outage, never a verdict).
  await assert.rejects(() => evaluated(t, rpcError(-32602, 'Invalid transaction; It looks like the given transaction wasn’t well-formed.')), NotJudged);
  await assert.rejects(() => evaluated(t, rpcError(3000, 'IncompatibleEra')), NotJudged);
  await assert.rejects(() => evaluated(t, rpcError(3004, 'Cannot create evaluation context', { reason: 'Uncomputable slot arithmetic' })), NotJudged);
});

test('the node’s protocol parameters are read exactly, and different reference-script tiers are refused', () => {
  const r = (parseExact(readFileSync(new URL('./fixtures/ogmios-protocol-parameters.json', import.meta.url), 'utf8')) as { result: Record<string, unknown> }).result;
  const pp = protocolParamsFromOgmios(r);
  assert.deepEqual(pp.executionUnitPrices, { priceMemory: '577/10000', priceSteps: '721/10000000' });
  assert.deepEqual(pp.costModelPlutusV2, PP.costModelPlutusV2);
  assert.throws(() => protocolParamsFromOgmios({ ...r, minFeeReferenceScripts: { base: 15n, range: 25_600n, multiplier: 1.3 } }), /x1.3/);
  assert.throws(() => protocolParamsFromOgmios({ ...r, minFeeReferenceScripts: { base: 15n, range: 20_000n, multiplier: 1.2 } }), /20000 bytes/);
  // A rate in a shape this batcher cannot price is a source failure now, never a surprise inside a batch.
  for (const bad of [null, { numerator: 577, denominator: 10_000 }, 'abc', '1/0']) {
    assert.throws(() => protocolParamsFromOgmios({ ...r, scriptExecutionPrices: { memory: bad, cpu: '721/10000000' } }), (e: unknown) => e instanceof SourceUnavailable && /memory price/.test((e as Error).message));
  }
  assert.throws(() => protocolParamsFromOgmios({ ...r, minFeeReferenceScripts: { base: null, range: 25_600n, multiplier: 1.2 } }), /reference-script price/);
  const models = r.plutusCostModels as Record<string, bigint[]>;
  assert.throws(() => protocolParamsFromOgmios({ ...r, plutusCostModels: { ...models, 'plutus:v2': [...models['plutus:v2']!.slice(1), 2n ** 60n] } }), /past what this batcher writes exactly/);
});

test('inputs passed along to the node keep every amount exact (a pool’s 9.2e18 LP tokens)', () => {
  const w = world();
  const wire = stringifyExact(toOgmiosUtxo(w.pool.ref, w.pool.outputHex));
  assert.match(wire, /"[0-9a-f]{64}":9223372014494096033\b/);
  assert.equal(budgetsFromOgmios(parseExact('[{"validator":{"purpose":"withdraw","index":0},"budget":{"memory":1,"cpu":2}}]'))[0]!.tag, 'Reward');
});

// ---- Live: mainnet's node judges our batches (set OGMIOS_URL) ----

const LIVE = process.env.OGMIOS_URL ?? '';
const live = LIVE ? false : 'set OGMIOS_URL (e.g. https://api.koios.rest/api/v1/ogmios) to judge with mainnet’s node';
const node = () => ogmiosEvaluator({ url: LIVE, timeoutMs: 120_000 }, { withInputs: true });
const SLOT = 160_000_000n;

async function batch(orders: { utxo: Utxo }[], mutate?: (w: ReturnType<typeof world>) => void) {
  const w = world();
  mutate?.(w);
  const spent: Record<string, string> = { ...w.spent, [w.pool.ref]: w.pool.outputHex };
  for (const o of orders) spent[o.utxo.ref] = o.utxo.outputHex;
  return prepareBatch(
    { network: NETWORK, dex: DEX, pool: w.pool, orders: orders.map((o) => o.utxo), fees: orders.map(() => 2n * ADA), globalSetting: w.globalSetting, scripts: w.scripts, batchingRewardBalance: 0n, batcher: w.batcher, batcherIndex: 0, volFee: null, validFromSlot: SLOT, validToSlot: SLOT + 180n, spent },
    PP,
    node(),
  );
}
const swaps = (n: number) => Array.from({ length: n }, (_, j) => order(`${(0x10 + j).toString(16).repeat(32)}#0`, 1 + (j % 8), 14n * ADA, [], step.swapIn(true, 10n * ADA, 1n)));

test('live: every real Minswap batch, re-judged by mainnet’s node, needs exactly what it declared', { skip: live }, async () => {
  for (const b of fx.batches) {
    const r = await node()(b.cbor, fx.spent);
    assert.ok(r.ok, `${b.tx}: ${r.ok ? '' : r.error}`);
    const want = declared(b.cbor);
    for (const x of r.budgets) assert.deepEqual({ mem: x.mem, steps: x.steps }, want.get(`${x.tag.toLowerCase()}:${x.index}`), `${b.tx} ${x.tag} ${x.index}`);
  }
});

test('live: our one-swap batch, built, judged by mainnet’s node, read back', { skip: live }, async () => {
  const b = await batch(swaps(1));
  assert.equal(b.report.orders[0]!.filled, true);
  assert.equal(b.budgets.get('reward:0')!.mem, 1_324_811n); // Aiken's memory figure, to the unit
});

test('live: 40 swaps, which Aiken refuses, fit one transaction by the chain’s own limits', { skip: live }, async () => {
  const b = await batch(swaps(40));
  assert.equal(b.report.orders.length, 40);
  const mem = [...b.budgets.values()].reduce((s, x) => s + x.mem, 0n);
  assert.ok(mem > 14_000_000n && mem <= 16_500_000n, `${mem}`);
});

test('live: a pool carrying a script nothing in the batch runs (Aiken crashes on it) is batched', { skip: live }, async () => {
  const b = await batch(swaps(1), (w) => {
    const o = CSL.TransactionOutput.from_hex(w.pool.outputHex);
    o.set_script_ref(scriptRefOf('authen'));
    w.pool = { ref: w.pool.ref, outputHex: o.to_hex() };
  });
  assert.equal(b.report.orders[0]!.filled, true);
});

test('live: mainnet’s node rejects our batch with one output a unit short', { skip: live }, async () => {
  const b = await batch(swaps(1));
  const w = world();
  const o = swaps(1)[0]!;
  const bad = withOutput(b.txHex, 0, (out) => ({ value: plusFirstToken(out.amount(), -1n) }));
  const r = await node()(bad, { ...w.spent, [o.utxo.ref]: o.utxo.outputHex });
  assert.equal(r.ok, false);
  assert.match(r.ok ? '' : r.error, /withdraw/);
});

const within3010 = (...items: { code: number; message: string; data?: unknown }[]) =>
  rpcError(3010, 'Some scripts of the transactions terminated with error(s).', items.map((error, i) => ({ validator: { index: BigInt(i), purpose: 'spend' }, error: { data: {}, ...error } })));

test('inside a 3010, each code on its own: "gone" (3117, 3004 naming an unknown input) is InputsGone; a verdict needs every script to have run', async (t) => {
  // As mainnet's node answered a batch whose inputs were already spent (research-ogmios, live).
  await assert.rejects(() => evaluated(t, within3010({ code: 3117, message: 'Unknown output references' })), InputsGone);
  await assert.rejects(() => evaluated(t, within3010({ code: 3004, message: 'Cannot create evaluation context', data: { reason: 'Unknown transaction input (missing from UTxO set): 518515c2#1' } })), InputsGone);
  await assert.rejects(() => evaluated(t, within3010({ code: 3110, message: 'Extraneous redeemers' }, { code: 3004, message: 'Unknown transaction input (missing from UTxO set)' })), InputsGone);
  // 3110 alone (our builder adding a redeemer) and the other non-verdicts: NotJudged.
  for (const code of [3110, 3011, 3111, 3115, 3161]) await assert.rejects(() => evaluated(t, within3010({ code, message: 'not run' })), NotJudged, `code ${code}`);
  // A script that ran and failed (3012), or an unsuitable input (3013): a verdict.
  for (const code of [3012, 3013]) {
    const r = await evaluated(t, within3010({ code, message: 'Some of the scripts failed', data: { validationError: 'An error has occurred', traces: [] } }));
    assert.equal(r.ok, false, `code ${code}`);
  }
  // A verdict mixed with a code that is not one: not a verdict.
  await assert.rejects(() => evaluated(t, within3010({ code: 3012, message: 'failed' }, { code: 3115, message: 'Missing cost models' })), NotJudged);
});

test('submission refusals: only the ledger’s own codes; inputs gone and window passed are benign; a withdrawal says so; the rest count', () => {
  const read = (c: number) => {
    const r = refusalFromOgmios(new OgmiosError(c, 'refused', {}));
    return r instanceof SubmitRefused ? [c, r.benign, r.withdrawal] : [c, 'may have reached the node'];
  };
  assert.deepEqual([3117, 3118, 3122, 3141, 3136].map(read), [[3117, true, false], [3118, true, false], [3122, false, false], [3141, false, true], [3136, false, false]]);
  // A JSON-RPC error, or the mempool's own failure, says nothing about the transaction: it may have been sent.
  for (const c of [-32000, -32603, -32600, -32001, 3997, 3004]) assert.ok(refusalFromOgmios(new OgmiosError(c, 'x', {})) instanceof SourceUnavailable, `code ${c}`);
});
