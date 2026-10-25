// The batcher's loop, one round per new block (src/follow.ts) or timer tick:
//   pick a source that answers (the primary, else the backup) and read everything from it alone
//   -> choose the next batch (src/select.ts) -> prepare it, judged by the node's own evaluator
//   -> sign and submit -> remember its inputs until its validity window has closed.
// A batch too big is halved; a batch the node's scripts refuse is halved too, oldest orders kept,
// and an order refused on its own is set aside (that means our engine and the contract disagree:
// alerted). A source failing is never held against an order. Above the float cap it stops.
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { isPlainBatcherUtxo, type ProtocolParams } from './build.ts';
import { Unsupported } from './engine.ts';
import { ContractFailure } from './math.ts';
import { OgmiosError, SourceUnavailable, SubmitRefused, type Tip } from './ogmios.ts';
import { DecodeError, type PlutusData } from './plutus.ts';
import { BatchTooBig, SimulationFailed, prepareBatch, type PreparedBatch } from './prepare.ts';
import { GLOBAL_SETTING_TOKEN, POOL_NFT, batcherIndex, chooseBatch, readGlobalSetting, readOrders, readPools, type Candidate, type Deployment, type Policy, type Skipped } from './select.ts';
import type { ChainUtxo, ChainView } from './view.ts';

export interface Signer {
  readonly keyHash: string;
  /** The transaction with the batcher's signature added. */
  sign(txHex: string): string;
}

export interface WatcherConfig {
  deployment: Deployment;
  policy: Policy;
  batcher: { keyHash: string; address: string };
  /** Above this many lovelace in its wallet, the batcher stops and alerts (the owner's cap). */
  floatCap: bigint;
  /** How long an order refused on its own is set aside, in slots. */
  quarantineSlots: bigint;
  /** This many refused submissions in a row stop the batcher. */
  maxRefusalsInARow: number;
}

export type WatcherEvent =
  | { kind: 'source-down'; source: string; error: string }
  | { kind: 'idle'; source: string; slot: bigint; orders: number }
  | { kind: 'skipped'; items: Skipped[] }
  | { kind: 'set-aside'; ref: string; reason: string; alert: boolean }
  | { kind: 'prepared'; source: string; pool: string; orders: string[]; fee: bigint; dryRun: boolean }
  | { kind: 'sent'; txId: string; pool: string; orders: string[]; fee: bigint }
  | { kind: 'refused'; pool: string; error: string; inARow: number }
  | { kind: 'stopped'; reason: string }
  | { kind: 'error'; error: string };

interface InFlight {
  refs: string[];
  validToSlot: bigint;
}

const ADA = 1_000_000n;
/** The batching account's balance is read again at least hourly, and after a refusal that names it. */
const REWARD_TTL_SLOTS = 3_600n;
const MAX_DATUM_LOOKUPS = 20;

export class Watcher {
  readonly #views: readonly ChainView[];
  readonly #signer: Signer | null;
  readonly #c: WatcherConfig;
  readonly #log: (e: WatcherEvent) => void;
  readonly inflight = new Map<string, InFlight>();
  readonly setAside = new Map<string, bigint>();
  #refusals = 0;
  readonly #datums = new Map<string, PlutusData>();
  /** The batching account's balance, and the slot it was read at (it changes only if someone pays in). */
  #reward: { balance: bigint; slot: bigint } | null = null;
  #stopped: string | null = null;
  #running: Promise<void> | null = null;
  #again = false;

  /** `signer` null: a dry run, every batch prepared and judged, nothing signed or sent. */
  constructor(views: readonly ChainView[], signer: Signer | null, c: WatcherConfig, log: (e: WatcherEvent) => void) {
    if (signer && signer.keyHash !== c.batcher.keyHash) throw new Error('the signing key is not the batcher key');
    this.#views = views;
    this.#signer = signer;
    this.#c = c;
    this.#log = log;
  }

  get stopped(): string | null {
    return this.#stopped;
  }

  /** Runs a round now, or right after the one running (never two at once). */
  trigger(): Promise<void> {
    if (this.#running) {
      this.#again = true;
      return this.#running;
    }
    this.#running = (async () => {
      try {
        do {
          this.#again = false;
          await this.round();
        } while (this.#again && !this.#stopped);
      } finally {
        this.#running = null;
      }
    })();
    return this.#running;
  }

  /** One round. Exposed for tests; use trigger() otherwise. */
  async round(): Promise<void> {
    if (this.#stopped) return;
    for (const view of this.#views) {
      let tip: Tip;
      try {
        tip = await view.tip();
      } catch (e) {
        this.#log({ kind: 'source-down', source: view.name, error: message(e) });
        continue;
      }
      try {
        await this.#roundOn(view, tip);
      } catch (e) {
        if (isTransient(e)) {
          this.#log({ kind: 'source-down', source: view.name, error: message(e) });
          continue;
        }
        this.#log({ kind: 'error', error: message(e) });
      }
      return;
    }
  }

  async #roundOn(view: ChainView, tip: Tip): Promise<void> {
    for (const [tx, f] of this.inflight) if (tip.slot > f.validToSlot) this.inflight.delete(tx);
    for (const [ref, until] of this.setAside) if (tip.slot > until) this.setAside.delete(ref);
    const { deployment: dep, policy, batcher } = this.#c;

    // Orders first: most rounds find none, and stop after two requests.
    const orderUtxos = await view.utxosAtCredential(dep.orderScriptHash);
    // Datums of hash-only orders: sent along by the source, known from an earlier round (a hash
    // names one datum forever), or looked up, at most MAX_DATUM_LOOKUPS a round (anyone can make orders).
    let lookups = 0;
    for (const u of orderUtxos) {
      const o = CSL.TransactionOutput.from_hex(u.outputHex);
      const hash = !o.has_plutus_data() ? o.data_hash()?.to_hex() : undefined;
      if (!hash || this.#datums.has(hash)) continue;
      if (u.witnessDatum) this.#datums.set(hash, CSL.PlutusData.from_hex(u.witnessDatum));
      else if (lookups < MAX_DATUM_LOOKUPS) {
        lookups++;
        const bytes = await view.datum(hash);
        if (bytes && CSL.hash_plutus_data(CSL.PlutusData.from_hex(bytes)).to_hex() === hash) this.#datums.set(hash, CSL.PlutusData.from_hex(bytes));
      }
    }
    const datums: ReadonlyMap<string, PlutusData> = this.#datums;
    const orders = readOrders(dep, policy, orderUtxos, datums);
    const exclude = new Set([...[...this.inflight.values()].flatMap((f) => f.refs), ...this.setAside.keys()]);
    if (!orders.orders.some((o) => !exclude.has(o.utxo.ref))) {
      if (orders.skipped.length) this.#log({ kind: 'skipped', items: orders.skipped });
      return this.#log({ kind: 'idle', source: view.name, slot: tip.slot, orders: orders.orders.length });
    }

    const cachedReward = this.#reward && tip.slot - this.#reward.slot < REWARD_TTL_SLOTS ? this.#reward.balance : null;
    const [pp, settings, scripts, poolUtxos, wallet, rewardBalance] = await Promise.all([
      view.protocolParams(),
      view.utxosWithAsset(dep.dex.authenPolicy, GLOBAL_SETTING_TOKEN, dep.dex.authenPolicy),
      view.utxos([dep.scriptRefs.pool, dep.scriptRefs.order, dep.scriptRefs.poolBatching]),
      view.utxosWithAsset(dep.dex.authenPolicy, POOL_NFT, dep.dex.poolScriptHash),
      view.utxosAtCredential(batcher.keyHash),
      cachedReward !== null ? Promise.resolve(cachedReward) : view.rewardBalance(dep.poolBatchingScriptHash),
    ]);
    if (cachedReward === null) this.#reward = { balance: rewardBalance, slot: tip.slot };

    const held = wallet.reduce((s, u) => s + coin(u), 0n);
    if (held > this.#c.floatCap) return this.#stop(`the batcher holds ${held} lovelace, above its cap of ${this.#c.floatCap}: sweep it to the treasury`);

    const global = readGlobalSetting(dep, settings);
    const index = batcherIndex(global.setting, batcher.keyHash);
    const script = (ref: string) => scripts.find((u) => u.ref === ref) ?? missing(`the reference script UTxO ${ref}`);
    const refs = { pool: script(dep.scriptRefs.pool), order: script(dep.scriptRefs.order), poolBatching: script(dep.scriptRefs.poolBatching) };

    const pools = readPools(dep, poolUtxos);
    const chosen = chooseBatch(dep, policy, pools.pools, orders.orders, exclude, tip.slot);
    const skipped = [...pools.skipped, ...orders.skipped, ...chosen.skipped];
    if (skipped.length) this.#log({ kind: 'skipped', items: skipped });
    if (!chosen.candidate) return this.#log({ kind: 'idle', source: view.name, slot: tip.slot, orders: orders.orders.length });

    const plain = wallet.filter((u) => isPlainBatcherUtxo(u, batcher.keyHash) && !exclude.has(u.ref)).sort(byCoin);
    const collateral = plain.find((u) => coin(u) >= 3n * ADA);
    const fee = [...plain].reverse().find((u) => u !== collateral);
    if (!collateral || !fee) return this.#stop('the batcher needs two plain ADA UTxOs at its key: about 5 ADA for collateral and its float');

    let candidate: Candidate = chosen.candidate;
    for (;;) {
      let prepared: PreparedBatch;
      try {
        prepared = await prepareBatch(
          {
            network: dep.network,
            dex: dep.dex,
            pool: candidate.pool.utxo,
            orders: candidate.orders.map((o) => o.utxo),
            fees: candidate.fees,
            globalSetting: global.utxo,
            scripts: refs,
            batchingRewardBalance: rewardBalance,
            batcher: { keyHash: batcher.keyHash, address: batcher.address, feeUtxos: [fee], collateral },
            batcherIndex: index,
            volFee: null,
            validFromSlot: candidate.validFromSlot,
            validToSlot: candidate.validToSlot,
            datumsByHash: new Map(candidate.orders.flatMap((o) => (o.witness ? [[o.witness.hash, o.witness.data] as const] : []))),
            spent: spentOf([candidate.pool.utxo, ...candidate.orders.map((o) => o.utxo), global.utxo, refs.pool, refs.order, refs.poolBatching, fee, collateral]),
          },
          pp,
          view.evaluate,
        );
      } catch (e) {
        if (isTransient(e)) throw e;
        if (!(e instanceof BatchTooBig || e instanceof SimulationFailed || e instanceof ContractFailure || e instanceof Unsupported || e instanceof DecodeError)) throw e;
        if (candidate.orders.length === 1) {
          const ref = candidate.orders[0]!.utxo.ref;
          this.setAside.set(ref, tip.slot + this.#c.quarantineSlots);
          this.#log({ kind: 'set-aside', ref, reason: message(e), alert: e instanceof SimulationFailed });
          return;
        }
        const half = Math.ceil(candidate.orders.length / 2);
        candidate = { ...candidate, orders: candidate.orders.slice(0, half), fees: candidate.fees.slice(0, half) };
        continue;
      }
      return this.#send(view, candidate, prepared, [fee.ref]);
    }
  }

  async #send(view: ChainView, c: Candidate, b: PreparedBatch, walletRefs: string[]): Promise<void> {
    const orders = c.orders.map((o) => o.utxo.ref);
    const refs = [c.pool.utxo.ref, ...orders, ...walletRefs];
    if (!this.#signer) {
      this.#log({ kind: 'prepared', source: view.name, pool: c.pool.lpName, orders, fee: b.fee, dryRun: true });
      this.inflight.set(`dry-run:${c.pool.utxo.ref}`, { refs, validToSlot: c.validToSlot });
      return;
    }
    this.#log({ kind: 'prepared', source: view.name, pool: c.pool.lpName, orders, fee: b.fee, dryRun: false });
    const signed = this.#signer.sign(b.txHex);
    const txId = CSL.FixedTransaction.from_hex(signed).transaction_hash().to_hex();
    // Held before sending: a submission that times out may still have reached the node.
    this.inflight.set(txId, { refs, validToSlot: c.validToSlot });
    try {
      await view.submit(signed);
    } catch (e) {
      if (!(e instanceof SubmitRefused)) {
        this.#log({ kind: 'error', error: `the batch ${txId} may or may not have been sent; its inputs are held until its window closes: ${message(e)}` });
        return;
      }
      this.inflight.delete(txId);
      if (e.withdrawal) this.#reward = null;
      if (!e.benign) this.#refusals++;
      this.#log({ kind: 'refused', pool: c.pool.lpName, error: message(e), inARow: this.#refusals });
      if (this.#refusals >= this.#c.maxRefusalsInARow) this.#stop(`the node refused ${this.#refusals} batches in a row; the last: ${message(e)}`);
      return;
    }
    this.#refusals = 0;
    this.#log({ kind: 'sent', txId, pool: c.pool.lpName, orders, fee: b.fee });
  }

  #stop(reason: string): void {
    this.#stopped = reason;
    this.#log({ kind: 'stopped', reason });
  }
}

/** Not a verdict on the batch: the source failed, or the node cannot judge it yet. */
function isTransient(e: unknown): boolean {
  return e instanceof SourceUnavailable || e instanceof OgmiosError;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const coin = (u: ChainUtxo) => BigInt(CSL.TransactionOutput.from_hex(u.outputHex).amount().coin().to_str());
const byCoin = (a: ChainUtxo, b: ChainUtxo) => (coin(a) < coin(b) ? -1 : coin(a) > coin(b) ? 1 : 0);
const missing = (what: string): never => {
  throw new SourceUnavailable(`${what} is not on chain (as this source sees it)`);
};
const spentOf = (us: { ref: string; outputHex: string }[]) => Object.fromEntries(us.map((u) => [u.ref, u.outputHex]));

export type { ProtocolParams };
