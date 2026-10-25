// Records mainnet's node answering evaluateTransaction (Ogmios, through Koios's public proxy,
// keyless) into test/fixtures/ogmios-evaluations.json: a real Minswap batch (accepted, with the
// budgets Minswap declared), our 50-swap batch (out of budget) and our one-swap batch with one
// output a unit short (a script failure). Inputs not on chain go along as additionalUtxo.
//   node scripts/fetch-ogmios-fixtures.ts
import { readFileSync, writeFileSync } from 'node:fs';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { buildBatchTx } from '../src/build.ts';
import { slotToPosixMs } from '../src/chain.ts';
import { currentTimeApproximation } from '../src/engine.ts';
import { stringifyExact } from '../src/json.ts';
import { toOgmiosUtxo } from '../src/ogmios.ts';
import { planBatch } from '../src/plan.ts';
import { DEX, NETWORK, PP, order, step, world } from '../test/world.ts';
import { plusFirstToken, withOutput } from '../test/tamper.ts';

const URL_ = 'https://api.koios.rest/api/v1/ogmios';
const ADA = 1_000_000n;
const SLOT = 160_000_000n;
const fx = JSON.parse(readFileSync(new URL('../test/fixtures/minswap-batches.json', import.meta.url), 'utf8')) as { batches: { tx: string; cbor: string }[]; spent: Record<string, string> };

function inputs(txHex: string): string[] {
  const b = CSL.Transaction.from_hex(txHex).body();
  const refs = new Set<string>();
  for (const l of [b.inputs(), b.reference_inputs(), b.collateral()]) for (let i = 0; l && i < l.len(); i++) refs.add(`${l.get(i).transaction_id().to_hex()}#${l.get(i).index()}`);
  return [...refs];
}
async function evaluate(txHex: string, spent: Record<string, string>): Promise<string> {
  const body = stringifyExact({ jsonrpc: '2.0', method: 'evaluateTransaction', params: { transaction: { cbor: txHex }, additionalUtxo: inputs(txHex).map((r) => toOgmiosUtxo(r, spent[r]!)) } });
  const res = await fetch(URL_, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  return res.text();
}
function draft(n: number) {
  const w = world();
  const orders = Array.from({ length: n }, (_, j) => order(`${(0x10 + j).toString(16).repeat(32)}#0`, 1 + (j % 8), 14n * ADA, [], step.swapIn(true, 10n * ADA, 1n)));
  const spent: Record<string, string> = { ...w.spent };
  for (const o of orders) spent[o.utxo.ref] = o.utxo.outputHex;
  const now = currentTimeApproximation(slotToPosixMs(SLOT), slotToPosixMs(SLOT + 180n));
  const utxos = orders.map((o) => o.utxo);
  const fees = orders.map(() => 2n * ADA);
  const plan = planBatch(DEX, w.pool, utxos, fees, now, null);
  const { txHex } = buildBatchTx({ network: NETWORK, plan, pool: w.pool, orders: utxos, fees, globalSetting: w.globalSetting, scripts: w.scripts, batchingRewardBalance: 0n, batcher: w.batcher, batcherIndex: 0, volFee: null, validFromSlot: SLOT, validToSlot: SLOT + 180n, budgets: new Map() }, PP);
  return { txHex, spent };
}

const real = fx.batches[0]!;
const fifty = draft(50);
const one = draft(1);
const short = withOutput(one.txHex, 0, (o) => ({ value: plusFirstToken(o.amount(), -1n) }));
const out = {
  source: `mainnet's node via Koios's Ogmios proxy, ${new Date().toISOString()}`,
  accepted: { tx: real.tx, answer: await evaluate(real.cbor, fx.spent) },
  overBudget: { orders: 50, answer: await evaluate(fifty.txHex, fifty.spent) },
  scriptFailure: { what: "our one-swap batch, the trader's output one token short", answer: await evaluate(short, one.spent) },
};
writeFileSync(new URL('../test/fixtures/ogmios-evaluations.json', import.meta.url), `${JSON.stringify(out, null, 1)}\n`);
for (const [k, v] of Object.entries(out)) if (typeof v === 'object') console.log(k, v.answer.slice(0, 160));
