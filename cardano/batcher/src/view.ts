// What the watcher needs from the chain, whichever source answers: the primary (Ogmios for the
// node's answers, Kupo for UTxOs) or the backup (Koios). A round reads its UTxOs, the tip and the
// node's answers from one source only, so a batch is never built from two views of the chain.
// The one exception is the batching account's balance, which only Koios can read (Ogmios leaves
// out an account delegated nowhere): the watcher keeps the last value read, and a stale one can
// only get a batch refused (3141), never move money.
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import type { ProtocolParams } from './build.ts';
import type { Koios } from './koios.ts';
import type { Kupo, KupoAnswer } from './kupo.ts';
import { ogmiosEvaluator, protocolParams, SourceUnavailable, submit, tip, type Endpoint, type Tip } from './ogmios.ts';
import type { Utxo } from './plan.ts';
import type { Evaluator } from './prepare.ts';

/** An unspent output, and when it was made: the batcher fills orders oldest first. */
export interface ChainUtxo extends Utxo {
  /** The slot of the block that made it. */
  createdSlot: bigint;
  /** Its transaction's place in that block, where the source says (Kupo does, Koios does not). */
  createdTxIndex: number | null;
  /** For an output holding only a datum hash: the datum, when the source sent it along (checked against the hash). */
  witnessDatum?: string;
}

export interface ChainView {
  readonly name: string;
  tip(): Promise<Tip>;
  protocolParams(): Promise<ProtocolParams>;
  /** Unspent outputs whose payment credential (key or script hash) is `cred`. */
  utxosAtCredential(cred: string): Promise<ChainUtxo[]>;
  /** Unspent outputs holding `policy.name`, at payment credential `cred`. */
  utxosWithAsset(policy: string, name: string, cred: string): Promise<ChainUtxo[]>;
  /** The outputs at these references that are still unspent. */
  utxos(refs: string[]): Promise<ChainUtxo[]>;
  /** A datum by its hash, as its original bytes, or null if the source has not seen it. */
  datum(hash: string): Promise<string | null>;
  /** What the pool-batching script's reward account holds; throws if it is not registered. */
  rewardBalance(scriptHash: string): Promise<bigint>;
  /** The node's own evaluator. */
  evaluate: Evaluator;
  /** The transaction id; a refusal is thrown with the node's reason. */
  submit(txHex: string): Promise<string>;
}

/** Oldest first: by block, then place in the block where known, then reference. */
export function compareAge(a: ChainUtxo, b: ChainUtxo): number {
  if (a.createdSlot !== b.createdSlot) return a.createdSlot < b.createdSlot ? -1 : 1;
  const ai = a.createdTxIndex ?? Number.MAX_SAFE_INTEGER;
  const bi = b.createdTxIndex ?? Number.MAX_SAFE_INTEGER;
  if (ai !== bi) return ai - bi;
  return a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0;
}

/** The reward address of a script credential, as Koios names accounts. */
export const scriptRewardAddress = (network: number, scriptHash: string) =>
  CSL.RewardAddress.new(network, CSL.Credential.from_scripthash(CSL.ScriptHash.from_hex(scriptHash))).to_address().to_bech32(undefined);

/** The backup: Koios alone, with the node's evaluator through Koios's Ogmios proxy. */
export function koiosView(k: Koios, network: number): ChainView {
  return {
    name: 'koios',
    tip: () => k.tip(),
    protocolParams: () => k.protocolParams(),
    utxosAtCredential: (cred) => k.utxosAtCredential(cred),
    utxosWithAsset: (policy, name, cred) => k.utxosWithAsset(policy, name, cred),
    utxos: (refs) => k.utxos(refs),
    datum: (hash) => k.datum(hash),
    rewardBalance: (scriptHash) => k.rewardBalance(scriptRewardAddress(network, scriptHash)),
    evaluate: k.evaluator(),
    submit: (txHex) => k.submit(txHex),
  };
}

/**
 * The primary: Ogmios for the node's answers, Kupo for UTxOs. Each Kupo answer carries the point
 * Kupo had indexed to; a round's answers count only if they all come from one point, within
 * `maxLagSlots` of the node's tip. Anything spent since that point is caught by the node's
 * evaluator (InputsGone): the round is retried, and no order is blamed.
 */
export function ogmiosKupoView(o: Endpoint, k: Kupo, rewardBalance: (scriptHash: string) => Promise<bigint>, maxLagSlots = 60n): ChainView {
  let nodeTip: Tip | null = null;
  let point: bigint | null = null;
  const fresh = async <T>(read: Promise<KupoAnswer<T>>): Promise<T> => {
    const a = await read;
    if (a.checkpoint === null) throw new SourceUnavailable('Kupo did not say how far it had indexed');
    if (nodeTip && a.checkpoint + maxLagSlots < nodeTip.slot) throw new SourceUnavailable(`Kupo has indexed to slot ${a.checkpoint}, the node is at ${nodeTip.slot}`);
    if (point === null) point = a.checkpoint;
    else if (a.checkpoint !== point) throw new SourceUnavailable(`Kupo moved from slot ${point} to ${a.checkpoint} during the round`);
    return a.value;
  };
  return {
    name: 'ogmios+kupo',
    tip: async () => {
      point = null;
      return (nodeTip = await tip(o));
    },
    protocolParams: () => protocolParams(o),
    utxosAtCredential: (cred) => fresh(k.unspent(`${cred}/*`)),
    utxosWithAsset: (policy, name, cred) => fresh(k.unspent(`${policy}.${name}`)).then((us) => us.filter((u) => paymentScript(u) === cred || paymentKey(u) === cred)),
    utxos: (refs) =>
      Promise.all(
        refs.map((r) => {
          const [tx, ix] = r.split('#');
          return fresh(k.unspent(`${ix}@${tx}`));
        }),
      ).then((x) => x.flat()),
    // A datum is named by its hash: any point serves.
    datum: (hash) => k.datum(hash),
    rewardBalance,
    evaluate: ogmiosEvaluator(o),
    submit: (txHex) => submit(o, txHex),
  };
}

const paymentScript = (u: Utxo) => CSL.TransactionOutput.from_hex(u.outputHex).address().payment_cred()?.to_scripthash()?.to_hex();
const paymentKey = (u: Utxo) => CSL.TransactionOutput.from_hex(u.outputHex).address().payment_cred()?.to_keyhash()?.to_hex();
