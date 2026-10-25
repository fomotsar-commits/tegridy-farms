// The stand-in chain the watcher and the process are tested on: the test world served as a
// ChainView, with failures injected (a source down, a call failing, a refusal at submission), and
// the node's evaluator stood in for by one that measures a small fixed budget, or refuses.
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { SourceUnavailable, type Tip } from '../src/ogmios.ts';
import type { Utxo } from '../src/plan.ts';
import type { Evaluator } from '../src/prepare.ts';
import type { Deployment, Policy } from '../src/select.ts';
import type { SimulationResult } from '../src/simulate.ts';
import type { ChainUtxo, ChainView } from '../src/view.ts';
import type { Signer } from '../src/watcher.ts';
import { BATCHER_KEY, BATCHER_SKEY, DEX, NETWORK, PP, S, order, step } from './world.ts';

export const ADA = 1_000_000n;
export const TIP = 160_000_000n;
export const DEP: Deployment = { network: NETWORK, dex: DEX, orderScriptHash: S.order.hash, poolBatchingScriptHash: S.poolBatching.hash, scriptRefs: { pool: `${'a2'.repeat(32)}#0`, order: `${'a2'.repeat(32)}#1`, poolBatching: `${'a2'.repeat(32)}#2` } };
export const POLICY: Policy = { batcherFee: 2n * ADA, maxOrdersPerBatch: 25, slotsBefore: 60n, slotsAfter: 240n };
export const SIGNER: Signer = {
  keyHash: BATCHER_KEY,
  sign: (tx) => {
    const f = CSL.FixedTransaction.from_hex(tx);
    f.sign_and_add_vkey_signature(BATCHER_SKEY);
    return f.to_hex();
  },
};

export const inputsOf = (tx: string) => {
  const b = CSL.FixedTransaction.from_hex(tx).body().inputs();
  return Array.from({ length: b.len() }, (_, i) => `${b.get(i).transaction_id().to_hex()}#${b.get(i).index()}`);
};

/** Every redeemer measured at a small fixed budget; `refuse` decides from the spent inputs (a verdict, or something to throw). */
export function evaluator(refuse: (inputs: string[]) => SimulationResult | Error | null = () => null): Evaluator {
  return (tx) => {
    const verdict = refuse(inputsOf(tx));
    if (verdict instanceof Error) throw verdict;
    if (verdict) return verdict;
    const rs = CSL.FixedTransaction.from_hex(tx).witness_set().redeemers()!;
    return { ok: true, budgets: Array.from({ length: rs.len() }, (_, i) => ({ tag: ['Spend', 'Mint', 'Cert', 'Reward'][rs.get(i).tag().kind()]!, index: Number(rs.get(i).index().to_str()), mem: 10_000n, steps: 1_000_000n })) };
  };
}

export class FakeView implements ChainView {
  readonly name: string;
  slot = TIP;
  chain: ChainUtxo[];
  reward = 0n;
  down = false;
  failing: string | null = null;
  rewardDown = false;
  submitted: string[] = [];
  submitError: (() => Error) | null = null;
  calls = new Map<string, number>();
  evaluate: Evaluator;
  datums = new Map<string, string>();
  constructor(name: string, utxos: Utxo[], evaluate: Evaluator = evaluator()) {
    this.name = name;
    this.chain = utxos.map((u, i) => ({ ...u, createdSlot: BigInt(i), createdTxIndex: 0 }));
    this.evaluate = evaluate;
  }
  #call(m: string) {
    this.calls.set(m, (this.calls.get(m) ?? 0) + 1);
    if (this.down || this.failing === m) throw new SourceUnavailable(`${this.name} ${m}: down`);
  }
  async tip(): Promise<Tip> {
    this.#call('tip');
    return { slot: this.slot, id: 'ab'.repeat(32) };
  }
  async protocolParams() {
    this.#call('protocolParams');
    return PP;
  }
  #cred(u: Utxo) {
    const c = CSL.TransactionOutput.from_hex(u.outputHex).address().payment_cred()!;
    return c.to_scripthash()?.to_hex() ?? c.to_keyhash()!.to_hex();
  }
  async utxosAtCredential(cred: string) {
    this.#call('utxosAtCredential');
    return this.chain.filter((u) => this.#cred(u) === cred);
  }
  async utxosWithAsset(policy: string, name: string, cred: string) {
    this.#call('utxosWithAsset');
    return this.chain.filter((u) => this.#cred(u) === cred && (CSL.TransactionOutput.from_hex(u.outputHex).amount().multiasset()?.get_asset(CSL.ScriptHash.from_hex(policy), CSL.AssetName.new(Buffer.from(name, 'hex'))).to_str() ?? '0') !== '0');
  }
  async utxos(refs: string[]) {
    this.#call('utxos');
    return this.chain.filter((u) => refs.includes(u.ref));
  }
  async datum(hash: string): Promise<string | null> {
    this.#call('datum');
    return this.datums.get(hash) ?? null;
  }
  async rewardBalance() {
    this.#call('rewardBalance');
    if (this.rewardDown) throw new SourceUnavailable('Koios: down');
    return this.reward;
  }
  async submit(tx: string) {
    this.#call('submit');
    if (this.submitError) throw this.submitError();
    this.submitted.push(tx);
    return CSL.FixedTransaction.from_hex(tx).transaction_hash().to_hex();
  }
}

export const swapOn = (ref: string, trader: number, lpName?: string) => order(ref, trader, 30n * ADA, [], step.swapIn(true, 25n * ADA, 1n), lpName ? { lpName } : {});
