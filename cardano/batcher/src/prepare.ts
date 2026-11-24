// One batch, from orders to an unsigned transaction that has passed every check:
//   plan (engine) -> build with placeholder budgets -> run every script -> rebuild with the exact
//   budgets -> run every script again (all must pass) -> read back as the contract would.
// Only a batch that comes out of this is ever offered to the key.
import { currentTimeApproximation } from './engine.ts';
import { slotToPosixMs } from './chain.ts';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { BatchTooBig, SetupError, buildBatchTx, type BatchTxRequest, type ExUnits, type ProtocolParams } from './build.ts';
import { planBatch, type Utxo } from './plan.ts';
import type { PlutusData } from './plutus.ts';
import type { SimulationResult } from './simulate.ts';
import { verifySinglePoolBatch, type BatchReport, type DexConstants } from './verify.ts';

/**
 * Runs every script in a transaction and measures each. In production, the node's own evaluator
 * (Ogmios), which uses the chain's current cost model and limits; `aiken tx simulate` (Aiken
 * 1.0.24's built-in cost model) in tests.
 */
export type Evaluator = (txHex: string, spent: Readonly<Record<string, string>>) => SimulationResult | Promise<SimulationResult>;

export class SimulationFailed extends Error {
  constructor(stage: string, detail: string) {
    super(`the batch failed simulation (${stage}): ${detail}`);
  }
}

export { BatchTooBig, SetupError };

export interface PrepareInput extends Omit<BatchTxRequest, 'plan' | 'budgets'> {
  dex: DexConstants;
  datumsByHash?: ReadonlyMap<string, PlutusData>;
  /** Every output the batch spends or reads, keyed "txhash#index". */
  spent: Readonly<Record<string, string>>;
}

export interface PreparedBatch {
  txHex: string;
  fee: bigint;
  totalCollateral: bigint;
  budgets: Map<string, ExUnits>;
  report: BatchReport;
}

export async function prepareBatch(input: PrepareInput, pp: ProtocolParams, evaluate: Evaluator): Promise<PreparedBatch> {
  const now = currentTimeApproximation(slotToPosixMs(input.validFromSlot, input.dex.time), slotToPosixMs(input.validToSlot, input.dex.time));
  const plan = planBatch(input.dex, input.pool, input.orders, input.fees, now, input.volFee, input.datumsByHash);
  const request: BatchTxRequest = { ...input, plan, budgets: new Map() };

  const first = buildBatchTx(request, pp);
  const sim1 = await evaluate(first.txHex, input.spent);
  if (!sim1.ok && sim1.overBudget) throw new BatchTooBig(`a script ran out of budget: ${sim1.error}`);
  if (!sim1.ok) throw new SimulationFailed('with placeholder budgets', sim1.error);
  const budgets = new Map<string, ExUnits>(sim1.budgets.map((b) => [`${b.tag.toLowerCase()}:${b.index}`, { mem: b.mem, steps: b.steps }]));
  // The chain rejects a transaction whose scripts together exceed this: such a batch is split, never sent.
  const mem = sim1.budgets.reduce((s, b) => s + b.mem, 0n);
  const steps = sim1.budgets.reduce((s, b) => s + b.steps, 0n);
  if (mem > BigInt(pp.maxTxExecutionUnits.memory) || steps > BigInt(pp.maxTxExecutionUnits.steps)) {
    throw new BatchTooBig(`the batch needs ${mem} memory and ${steps} steps; one transaction may use ${pp.maxTxExecutionUnits.memory} and ${pp.maxTxExecutionUnits.steps}`);
  }

  // Rebuilt with the exact budgets, the transaction changes (fee, collateral, script data hash),
  // so every script runs again on it. Neither evaluator holds a script to the budget the
  // transaction declares, so that is checked here, redeemer by redeemer.
  const exact = buildBatchTx({ ...request, budgets }, pp);
  const sim2 = await evaluate(exact.txHex, input.spent);
  if (!sim2.ok) throw new SimulationFailed('with exact budgets', sim2.error);
  for (const b of sim2.budgets) {
    const declared = budgets.get(`${b.tag.toLowerCase()}:${b.index}`);
    if (!declared || b.mem > declared.mem || b.steps > declared.steps) throw new SimulationFailed('with exact budgets', `${b.tag} ${b.index} needs more than it declares`);
  }
  const report = verifySinglePoolBatch(exact.txHex, input.spent, input.dex);
  paysOnlyWhomItShould(exact.txHex, input.orders.length, input.batcher.address);
  return { txHex: exact.txHex, fee: exact.fee, totalCollateral: exact.totalCollateral, budgets, report };
}

/**
 * The read-back checks the traders' outputs and the pool's; this checks the rest. A batch pays
 * the traders, then the pool, then exactly one change output to the batcher's own address, and
 * its collateral's return goes there too. Anything else is a fault of this batcher: it stops.
 */
export function paysOnlyWhomItShould(txHex: string, orders: number, batcherAddress: string): void {
  const body = CSL.Transaction.from_hex(txHex).body();
  const outs = body.outputs();
  if (outs.len() !== orders + 2) throw new SetupError(`the batch has ${outs.len()} outputs; ${orders} orders, the pool and the batcher's change make ${orders + 2}`);
  const change = outs.get(outs.len() - 1);
  if (change.address().to_bech32(undefined) !== batcherAddress) throw new SetupError("the batch pays its change to an address that is not the batcher's");
  if (change.amount().multiasset()?.len()) throw new SetupError('the batch pays tokens to the batcher');
  const back = body.collateral_return();
  if (back && back.address().to_bech32(undefined) !== batcherAddress) throw new SetupError("the batch returns its collateral to an address that is not the batcher's");
}

export type { Utxo };
