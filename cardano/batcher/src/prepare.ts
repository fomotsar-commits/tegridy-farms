// One batch, from orders to an unsigned transaction that has passed every check:
//   plan (engine) -> build with placeholder budgets -> run every script -> rebuild with the exact
//   budgets -> run every script again (all must pass) -> read back as the contract would.
// Only a batch that comes out of this is ever offered to the key.
import { currentTimeApproximation } from './engine.ts';
import { slotToPosixMs } from './chain.ts';
import { buildBatchTx, type BatchTxRequest, type ExUnits, type ProtocolParams } from './build.ts';
import { planBatch, type Utxo } from './plan.ts';
import type { PlutusData } from './plutus.ts';
import type { SimulationResult } from './simulate.ts';
import { verifySinglePoolBatch, type BatchReport, type DexConstants } from './verify.ts';

/** Runs every script in a transaction: `aiken tx simulate` in tests, the node's evaluator in production. */
export type Evaluator = (txHex: string, spent: Readonly<Record<string, string>>) => SimulationResult;

export class SimulationFailed extends Error {
  constructor(stage: string, detail: string) {
    super(`the batch failed simulation (${stage}): ${detail}`);
  }
}

/** The orders' scripts need more than one transaction may use: take fewer orders. */
export class BatchTooBig extends Error {
  constructor(mem: bigint, steps: bigint, max: { memory: number; steps: number }) {
    super(`the batch needs ${mem} memory and ${steps} steps; one transaction may use ${max.memory} and ${max.steps}`);
  }
}

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

export function prepareBatch(input: PrepareInput, pp: ProtocolParams, evaluate: Evaluator): PreparedBatch {
  const now = currentTimeApproximation(slotToPosixMs(input.validFromSlot, input.dex.time), slotToPosixMs(input.validToSlot, input.dex.time));
  const plan = planBatch(input.dex, input.pool, input.orders, input.fees, now, input.volFee, input.datumsByHash);
  const request: BatchTxRequest = { ...input, plan, budgets: new Map() };

  const first = buildBatchTx(request, pp);
  const sim1 = evaluate(first.txHex, input.spent);
  if (!sim1.ok) throw new SimulationFailed('with placeholder budgets', sim1.error);
  const budgets = new Map<string, ExUnits>(sim1.budgets.map((b) => [`${b.tag.toLowerCase()}:${b.index}`, { mem: b.mem, steps: b.steps }]));
  // The chain rejects a transaction whose scripts together exceed this: such a batch is split, never sent.
  const mem = sim1.budgets.reduce((s, b) => s + b.mem, 0n);
  const steps = sim1.budgets.reduce((s, b) => s + b.steps, 0n);
  if (mem > BigInt(pp.maxTxExecutionUnits.memory) || steps > BigInt(pp.maxTxExecutionUnits.steps)) {
    throw new BatchTooBig(mem, steps, pp.maxTxExecutionUnits);
  }

  const exact = buildBatchTx({ ...request, budgets }, pp);
  const sim2 = evaluate(exact.txHex, input.spent);
  if (!sim2.ok) throw new SimulationFailed('with exact budgets', sim2.error);
  for (const b of sim2.budgets) {
    const declared = budgets.get(`${b.tag.toLowerCase()}:${b.index}`);
    if (!declared || b.mem > declared.mem || b.steps > declared.steps) throw new SimulationFailed('with exact budgets', `${b.tag} ${b.index} needs more than it declares`);
  }
  const report = verifySinglePoolBatch(exact.txHex, input.spent, input.dex);
  return { txHex: exact.txHex, fee: exact.fee, totalCollateral: exact.totalCollateral, budgets, report };
}

export type { Utxo };
