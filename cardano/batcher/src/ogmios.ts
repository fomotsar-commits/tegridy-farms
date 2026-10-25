// Ogmios v6: the node's own answers, as JSON-RPC 2.0 over HTTP (queries, evaluation, submission).
// Chain-sync needs the WebSocket (src/follow.ts). Hosted Ogmios (Demeter) speaks this protocol,
// and so does Koios's public proxy (https://api.koios.rest/api/v1/ogmios) for evaluation and
// some queries. Every message goes through src/json.ts: amounts stay exact.
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import type { ProtocolParams } from './build.ts';
import { rational } from './fee.ts';
import { refKey } from './chain.ts';
import { parseExact, stringifyExact } from './json.ts';
import type { Evaluator } from './prepare.ts';
import type { ScriptBudget, SimulationResult } from './simulate.ts';

export interface Endpoint {
  url: string;
  /** Sent with every request, e.g. { 'dmtr-api-key': ... } for Demeter. Never logged. */
  headers?: Readonly<Record<string, string>>;
  timeoutMs?: number;
}

/** The node answered, and the answer is an error: `code` and `data` are Ogmios's. */
export class OgmiosError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(code: number, message: string, data: unknown) {
    super(`Ogmios ${code}: ${message}`);
    this.code = code;
    this.data = data;
  }
}

/** The request never got an answer we can read (network, timeout, HTTP error page). */
export class SourceUnavailable extends Error {}

/**
 * The node read the transaction and refused it: the reason is in the message. `benign`: an
 * input was gone or the window had passed (an order cancelled meanwhile, a source a block
 * behind): normal, and never counted toward stopping. `withdrawal`: the batching account's
 * balance changed (read it again).
 */
export class SubmitRefused extends Error {
  readonly benign: boolean;
  readonly withdrawal: boolean;
  constructor(message: string, benign: boolean, withdrawal: boolean) {
    super(message);
    this.benign = benign;
    this.withdrawal = withdrawal;
  }
}

/** Ogmios's submit codes: 3117 unknown (spent) inputs, 3118 outside the validity window, 3141 incomplete withdrawals. */
export function refusalFromOgmios(e: OgmiosError): SubmitRefused | SourceUnavailable {
  // Only the ledger's own codes are a refusal; a JSON-RPC error (-32xxx) or an unexpected mempool
  // error (3997) says nothing about the transaction, which may have reached the node.
  if (e.code < 3005 || e.code > 3168 || e.code === 3997) return new SourceUnavailable(`submission may or may not have reached the node: ${e.message}`);
  return new SubmitRefused(`${e.message} ${stringifyExact(e.data)}`.slice(0, 4000), e.code === 3117 || e.code === 3118, e.code === 3141);
}

type Json = Record<string, unknown>;
const isObject = (x: unknown): x is Json => typeof x === 'object' && x !== null && !Array.isArray(x);

export async function rpc(ep: Endpoint, method: string, params?: unknown): Promise<unknown> {
  let text: string;
  let status: number;
  try {
    const res = await fetch(ep.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...ep.headers },
      body: stringifyExact(params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params }),
      signal: AbortSignal.timeout(ep.timeoutMs ?? 30_000),
    });
    status = res.status;
    text = await res.text();
  } catch (e) {
    throw new SourceUnavailable(`${method}: ${e instanceof Error ? e.message : String(e)}`);
  }
  let body: unknown;
  try {
    body = parseExact(text);
  } catch {
    throw new SourceUnavailable(`${method}: HTTP ${status}, not JSON: ${text.slice(0, 200)}`);
  }
  if (!isObject(body)) throw new SourceUnavailable(`${method}: HTTP ${status}, not a JSON-RPC answer`);
  if (isObject(body.error)) throw new OgmiosError(Number(body.error.code), String(body.error.message), body.error.data);
  if (!('result' in body)) throw new SourceUnavailable(`${method}: HTTP ${status}, no result`);
  return body.result;
}

const big = (x: unknown, what: string): bigint => {
  if (typeof x === 'bigint') return x;
  throw new SourceUnavailable(`Ogmios: ${what} is not an integer`);
};
const lovelace = (x: unknown, what: string): bigint => {
  if (!isObject(x) || !isObject(x.ada)) throw new SourceUnavailable(`Ogmios: ${what} is not an amount`);
  return big(x.ada.lovelace, what);
};
const bytes = (x: unknown, what: string): bigint => {
  if (!isObject(x)) throw new SourceUnavailable(`Ogmios: ${what} is not a size`);
  return big(x.bytes, what);
};
const ints = (x: unknown, what: string): number[] => {
  if (!Array.isArray(x)) throw new SourceUnavailable(`Ogmios: ${what} is not a list`);
  return x.map((v) => {
    const n = big(v, what);
    if (n > BigInt(Number.MAX_SAFE_INTEGER) || n < BigInt(Number.MIN_SAFE_INTEGER)) throw new SourceUnavailable(`Ogmios: ${what} holds ${n}, past what this batcher writes exactly`);
    return Number(n);
  });
};
/** A rate as published ("n/d" or a number), checked now: never a surprise inside a batch. */
const rate = (x: unknown, what: string): string => {
  const s = typeof x === 'bigint' ? x.toString() : typeof x === 'number' || typeof x === 'string' ? String(x) : '';
  try {
    rational(s);
  } catch {
    throw new SourceUnavailable(`Ogmios: ${what} is not a rate (${s || typeof x})`);
  }
  return s;
};

/**
 * queryLedgerState/protocolParameters as this batcher's parameters. Prices stay exact ("n/d").
 * Conway's reference-script tiers are fixed in the ledger (25,600 bytes, x1.2): src/fee.ts
 * assumes them, so a node reporting anything else is refused rather than mis-priced.
 */
export function protocolParamsFromOgmios(r: unknown): ProtocolParams {
  if (!isObject(r)) throw new SourceUnavailable('Ogmios: protocol parameters are not an object');
  const prices = r.scriptExecutionPrices;
  const maxUnits = r.maxExecutionUnitsPerTransaction;
  const models = r.plutusCostModels;
  const refs = r.minFeeReferenceScripts;
  if (!isObject(prices) || !isObject(maxUnits) || !isObject(models) || !isObject(refs)) throw new SourceUnavailable('Ogmios: protocol parameters are missing fields');
  if (big(refs.range, 'minFeeReferenceScripts.range') !== 25_600n || String(refs.multiplier) !== '1.2') {
    throw new SourceUnavailable(`Ogmios: reference-script tiers are ${refs.range} bytes x${refs.multiplier}; src/fee.ts prices 25,600 x1.2`);
  }
  const base = refs.base;
  const v3 = models['plutus:v3'];
  return {
    txFeePerByte: Number(big(r.minFeeCoefficient, 'minFeeCoefficient')),
    txFeeFixed: Number(lovelace(r.minFeeConstant, 'minFeeConstant')),
    utxoCostPerByte: Number(big(r.minUtxoDepositCoefficient, 'minUtxoDepositCoefficient')),
    maxTxSize: Number(bytes(r.maxTransactionSize, 'maxTransactionSize')),
    maxValueSize: Number(bytes(r.maxValueSize, 'maxValueSize')),
    collateralPercentage: Number(big(r.collateralPercentage, 'collateralPercentage')),
    executionUnitPrices: { priceMemory: rate(prices.memory, 'the memory price'), priceSteps: rate(prices.cpu, 'the step price') },
    minFeeRefScriptCostPerByte: rate(base, 'the reference-script price'),
    stakeAddressDeposit: Number(lovelace(r.stakeCredentialDeposit, 'stakeCredentialDeposit')),
    stakePoolDeposit: Number(lovelace(r.stakePoolDeposit, 'stakePoolDeposit')),
    costModelPlutusV2: ints(models['plutus:v2'], 'plutus:v2 cost model'),
    ...(v3 === undefined ? {} : { costModelPlutusV3: ints(v3, 'plutus:v3 cost model') }),
    maxTxExecutionUnits: { memory: Number(big(maxUnits.memory, 'max memory')), steps: Number(big(maxUnits.cpu, 'max cpu')) },
  };
}

export async function protocolParams(ep: Endpoint): Promise<ProtocolParams> {
  return protocolParamsFromOgmios(await rpc(ep, 'queryLedgerState/protocolParameters'));
}

export interface Tip {
  slot: bigint;
  id: string;
}

export async function tip(ep: Endpoint): Promise<Tip> {
  const r = await rpc(ep, 'queryNetwork/tip');
  if (!isObject(r) || typeof r.id !== 'string') throw new SourceUnavailable('Ogmios: no tip (the node may still be at the origin)');
  return { slot: big(r.slot, 'tip slot'), id: r.id };
}

const PURPOSE_TAG: Record<string, string> = { spend: 'Spend', mint: 'Mint', publish: 'Cert', withdraw: 'Reward', vote: 'Vote', propose: 'Propose' };

/** An evaluateTransaction result as the budgets prepare.ts keys by "<tag>:<index>". */
export function budgetsFromOgmios(r: unknown): ScriptBudget[] {
  if (!Array.isArray(r)) throw new SourceUnavailable('Ogmios: evaluation result is not a list');
  return r.map((x, i) => {
    if (!isObject(x) || !isObject(x.validator) || !isObject(x.budget)) throw new SourceUnavailable(`Ogmios: evaluation result ${i} is malformed`);
    const tag = PURPOSE_TAG[String(x.validator.purpose)];
    if (!tag) throw new SourceUnavailable(`Ogmios: a script of purpose ${String(x.validator.purpose)}`);
    return { tag, index: Number(big(x.validator.index, 'validator index')), mem: big(x.budget.memory, 'memory'), steps: big(x.budget.cpu, 'cpu') };
  });
}

/** Ogmios's code for "some scripts could not be run, or failed", one error per script. */
export const SCRIPT_FAILURES = 3010;
/** Inside a 3010: the script ran and failed (3012), or a script input is unsuitable (3013). */
const VERDICTS = new Set([3012, 3013]);
/** Codes about the node or the connection, not the transaction: try again. */
const NODE_STATE = new Set([-32000, -32001, -32603, 3003]);

/** The node cannot judge the batch: an input is gone or unknown to it (spent since it was read, or it lags). */
export class InputsGone extends SourceUnavailable {}

/**
 * The node read the batch and would not judge it, for a reason about this batch rather than the
 * node (it does not decode, a script or datum or cost model is missing, an era it cannot use...).
 * Never a verdict on an order, never an outage: the batch is set aside, with an alert.
 */
export class NotJudged extends Error {}

/** "an input is gone": 3117 (unknown output references), or 3004 naming an unknown input. 3110 alone is not. */
const isGone = (code: number, text: string) => code === 3117 || (code === 3004 && /Unknown transaction input/i.test(text));

/**
 * The node's own evaluator, as prepare.ts's judge: the chain's live cost model and limits.
 * Only a script that ran and failed is a verdict ({ ok: false }). An input the node cannot see
 * (spent since the read, or a node a block behind) throws InputsGone; trouble with the node or the
 * connection throws SourceUnavailable or OgmiosError; anything else about the batch throws NotJudged.
 * `withInputs` passes every input's output along (additionalUtxo), for inputs not on chain (tests).
 */
export function ogmiosEvaluator(ep: Endpoint, opts: { withInputs?: boolean } = {}): Evaluator {
  return async (txHex, spent): Promise<SimulationResult> => {
    const params: Json = { transaction: { cbor: txHex } };
    if (opts.withInputs) params.additionalUtxo = inputsOf(txHex).map((ref) => toOgmiosUtxo(ref, spent[ref] ?? missing(ref)));
    try {
      return { ok: true, budgets: budgetsFromOgmios(await rpc(ep, 'evaluateTransaction', params)) };
    } catch (e) {
      if (!(e instanceof OgmiosError)) throw e;
      const detail = stringifyExact(e.data);
      if (e.code !== SCRIPT_FAILURES) {
        if (isGone(e.code, `${e.message} ${detail}`)) throw new InputsGone(`the node cannot see every input: ${detail.slice(0, 1000)}`);
        if (NODE_STATE.has(e.code)) throw e;
        throw new NotJudged(`the node would not judge the batch: ${e.message} ${detail}`.slice(0, 4000));
      }
      const items = (Array.isArray(e.data) ? e.data : []).map((x: unknown) => (isObject(x) && isObject(x.error) ? { code: Number(x.error.code), text: stringifyExact(x.error) } : { code: NaN, text: '' }));
      if (items.some((i) => isGone(i.code, i.text))) throw new InputsGone(`the node cannot see every input: ${detail.slice(0, 1000)}`);
      if (!items.length || !items.every((i) => VERDICTS.has(i.code))) throw new NotJudged(`the node would not judge the batch: ${e.message} ${detail}`.slice(0, 4000));
      return { ok: false, error: `${e.message} ${detail}`.slice(0, 4000), overBudget: /overspending the budget/.test(detail) };
    }
  };
}

const missing = (ref: string): never => {
  throw new Error(`the output ${ref} is unknown`);
};

function inputsOf(txHex: string): string[] {
  const body = CSL.FixedTransaction.from_hex(txHex).body();
  const refs = new Set<string>();
  for (const l of [body.inputs(), body.reference_inputs(), body.collateral()]) for (let i = 0; l && i < l.len(); i++) refs.add(refKey(l.get(i)));
  return [...refs];
}

/** One output as Ogmios's UTxO JSON: exact amounts, the datum or its hash, the reference script. */
export function toOgmiosUtxo(ref: string, outputHex: string): Json {
  const [id, ix] = ref.split('#') as [string, string];
  const o = CSL.TransactionOutput.from_hex(outputHex);
  const v = o.amount();
  const value: Record<string, Record<string, bigint>> = { ada: { lovelace: BigInt(v.coin().to_str()) } };
  const ma = v.multiasset();
  for (let i = 0; ma && i < ma.keys().len(); i++) {
    const policy = ma.keys().get(i);
    const assets = ma.get(policy)!;
    const tokens: Record<string, bigint> = {};
    for (let j = 0; j < assets.keys().len(); j++) {
      const name = assets.keys().get(j);
      tokens[Buffer.from(name.name()).toString('hex')] = BigInt(assets.get(name)!.to_str());
    }
    value[policy.to_hex()] = tokens;
  }
  const u: Json = { transaction: { id }, index: BigInt(ix), address: o.address().to_bech32(undefined), value };
  if (o.has_data_hash()) u.datumHash = o.data_hash()!.to_hex();
  if (o.has_plutus_data()) u.datum = o.plutus_data()!.to_hex();
  const sr = o.script_ref();
  if (sr?.is_plutus_script()) {
    const s = sr.plutus_script()!;
    u.script = { language: `plutus:v${s.language_version().kind() + 1}`, cbor: Buffer.from(s.bytes()).toString('hex') };
  } else if (sr) u.script = { language: 'native', cbor: sr.native_script()!.to_hex() };
  return u;
}

/** submitTransaction: the transaction id; SubmitRefused with the ledger's reason. */
export async function submit(ep: Endpoint, txHex: string): Promise<string> {
  let r: unknown;
  try {
    r = await rpc(ep, 'submitTransaction', { transaction: { cbor: txHex } });
  } catch (e) {
    if (e instanceof OgmiosError) throw refusalFromOgmios(e);
    throw e;
  }
  if (!isObject(r) || !isObject(r.transaction) || typeof r.transaction.id !== 'string') throw new SourceUnavailable('Ogmios: submission answered without a transaction id');
  return r.transaction.id;
}
