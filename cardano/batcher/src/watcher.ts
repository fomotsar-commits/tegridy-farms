// The batcher's loop, one round per new block (src/follow.ts) or timer tick:
//   pick a source that answers (the primary, else the backup) and read everything from it alone
//   -> choose the next batch (src/select.ts) -> prepare it, judged by the node's own evaluator
//   -> sign and submit -> remember its inputs until its validity window has closed.
// What each failure means:
//   - the source (down, behind, a tip far from the clock): try the next source; no order is blamed.
//   - an input gone since the read (InputsGone): the round ends; the next block tries again.
//   - the batch (too big, refused by the scripts, not judged, not buildable): halved, oldest
//     orders kept; an order failing alone is set aside, and the round goes on without it. A set-aside
//     the node or our read-back caused is an alert (our engine and the contract disagree), and five
//     in a row raise a louder one; it never stops the batcher (that would hand anyone who found such
//     an order a switch that stops every pool).
//   - the batcher's own wallet or settings (SetupError), or EMURGO's library broken: it stops.
//     The library broken on a stranger's bytes names them (LibraryTrapped, src/cbor.ts), and the
//     next process (src/main.ts keeps them on the volume) never reads a UTxO it broke on alone,
//     and tries each order of a batch it broke on alone before it may join a batch: one order
//     cannot break every restart, nor keep honest orders aside.
// Above the float cap it sweeps the excess to the two-key treasury (src/sweep.ts), once the
// settings name it; until then it stops there. With no order to batch, the wallet and the settings
// are still checked every 10 minutes, so a stop for a person comes back after any redeploy. A dry run
// prepares and judges, and never signs or sends. Every round that reached a source says so (the
// alarm counts it). A batch in flight that can never land (an order of it spent by another, its
// pool not) is released at once. With chain-sync, each batch sent is looked for in the blocks
// until its window closes (src/heartbeat.ts fails while three in a row never landed).
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { isBatcherAddress, isPlainBatcherUtxo, orderOutputProblem, type ProtocolParams } from './build.ts';
import { slotToPosixMs } from './chain.ts';
import { LibraryTrapped, blaming, isWasmTrap, shallowCbor } from './cbor.ts';
import { Unsupported } from './engine.ts';
import { ContractFailure } from './math.ts';
import { InputsGone, OgmiosError, SourceUnavailable, SubmitRefused, type Tip } from './ogmios.ts';
import { DecodeError, type PlutusData } from './plutus.ts';
import { BatchTooBig, SetupError, prepareBatch, type PreparedBatch } from './prepare.ts';
import { MIN_FLOAT, buildSweep, verifySweep, type PreparedSweep, type Treasury } from './sweep.ts';
import { GLOBAL_SETTING_TOKEN, NotABatcher, POOL_NFT, batcherIndex, chooseBatch, readGlobalSetting, readOrders, readPools, type Candidate, type Deployment, type Policy, type Skipped } from './select.ts';
import { compareAge, type ChainUtxo, type ChainView } from './view.ts';

export interface Signer {
  readonly keyHash: string;
  /** The transaction with the batcher's signature added. */
  sign(txHex: string): string;
}

export interface WatcherConfig {
  deployment: Deployment;
  policy: Policy;
  batcher: { keyHash: string; address: string };
  /**
   * Above this many lovelace in its wallet, the batcher sweeps the excess to the treasury, down to
   * `sweep.keep`, when the settings name the treasury; without one, it stops and alerts.
   */
  floatCap: bigint;
  /** The two-key treasury (src/sweep.ts checked it) and the float left after a sweep. */
  sweep?: { treasury: Treasury; keep: bigint };
  /** How long an order refused on its own is set aside, in slots. */
  quarantineSlots: bigint;
  /** This many refused submissions in a row stop the batcher. */
  maxRefusalsInARow: number;
  /** The wall clock, in POSIX ms (a source's tip is checked against it). */
  now?: () => number;
  /** Orders of a batch the library broke on, in an earlier process: each is prepared alone first. */
  suspects?: ReadonlySet<string>;
  /** Blocks are followed (blockSeen, rolledBack): each batch sent is looked for in them. */
  checkLanding?: boolean;
}

export type WatcherEvent =
  | { kind: 'source-down'; source: string; error: string }
  | { kind: 'inputs-gone'; source: string; error: string }
  | { kind: 'idle'; source: string; slot: bigint; orders: number; reason?: string }
  | { kind: 'skipped'; items: Skipped[] }
  | { kind: 'set-aside'; ref: string; reason: string; alert: boolean }
  | { kind: 'prepared'; source: string; pool: string; orders: string[]; fee: bigint; dryRun: boolean }
  | { kind: 'sent'; txId: string; pool: string; orders: string[]; fee: bigint }
  | { kind: 'refused'; pool: string; error: string; inARow: number; benign: boolean }
  | { kind: 'wallet'; held: bigint; plain: bigint; cap: bigint }
  | { kind: 'sweep-prepared'; amount: bigint; fee: bigint; refs: string[]; dryRun: boolean }
  | { kind: 'swept'; txId: string; amount: bigint; fee: bigint; to: string }
  | { kind: 'sweep-refused'; txId: string; error: string; benign: boolean }
  | { kind: 'landed'; txId: string; slot: bigint }
  | { kind: 'unlanded'; txId: string; validToSlot: bigint; inARow: number }
  | { kind: 'outrun'; txId: string; spent: string }
  | { kind: 'suspect-cleared'; ref: string }
  | { kind: 'alert'; reason: string }
  | { kind: 'stopped'; reason: string; fatal: boolean; trapped?: string[] }
  | { kind: 'error'; error: string };

interface InFlight {
  refs: string[];
  pool: string;
  orders: string[];
  validToSlot: bigint;
  /** A sweep: what it pays the treasury. */
  sweep?: bigint;
  /** The collateral it pledged: spent only if a script fails, so never spent by anything else meanwhile. */
  collateral?: string;
}

const ADA = 1_000_000n;
/** The smallest UTxO pledged as collateral: it covers the fee of any batch one transaction can hold. */
const MIN_COLLATERAL = 5n * ADA;
/** The batching account's balance is read again at least hourly, and after a refusal that names it. */
const REWARD_TTL_SLOTS = 3_600n;
/** Datum lookups a round, for hash-only orders (anyone can make them). */
const MAX_DATUM_LOOKUPS = 20;
/** A datum no source has: asked again after this many slots. */
const DATUM_MISS_SLOTS = 3_600n;
/** Batches prepared (each judged twice) in one round, at most. */
const MAX_PREPARES_PER_ROUND = 12;
/** Alerted set-asides in a row (no batch sent between them) that raise the louder alert. */
const MAX_ALERTS_IN_A_ROW = 5;
/** Benign refusals in a row that raise an alert (every batch refused as spent or expired). */
const BENIGN_ALERT = 10;
/** The smallest fee UTxO a batch spends: the first build, on placeholder budgets, must still make change. */
const MIN_FEE_UTXO = MIN_FLOAT;
/** With no order to batch, the wallet and the settings are checked at least this often (10 minutes). */
const SETUP_CHECK_SLOTS = 600n;
/**
 * A source's tip may be this far from the wall clock either way. Behind: its batches would expire
 * before they land. Ahead: in-flight inputs would be released early (the ledger still refuses any
 * double spend). Either way more likely means a source or this machine's clock is wrong.
 */
const TIP_BEHIND_MS = 300_000;
const TIP_AHEAD_MS = 300_000;

export class Watcher {
  readonly #views: readonly ChainView[];
  readonly #signer: Signer | null;
  readonly #c: WatcherConfig;
  readonly #log: (e: WatcherEvent) => void;
  readonly inflight = new Map<string, InFlight>();
  readonly setAside = new Map<string, bigint>();
  #refusals = 0;
  #benign = 0;
  #alerts = 0;
  #unlanded = 0;
  /** Batches sent, until a block past their window has been seen: in which block each landed, if it did. */
  readonly #awaiting = new Map<string, { validToSlot: bigint; landedSlot: bigint | null }>();
  /** Chain-sync has delivered a block since it was last lost: a batch sent now can be looked for. */
  #syncUp = false;
  #held: bigint | null = null;
  #plainHeld: bigint | null = null;
  /** Above the cap, and the collateral and the float kept are more than the cap: said once, while it lasts. */
  #capAlerted = false;
  /** A dry run's sweep, prepared and never sent: prepared again only once its window has closed. */
  #drySweepUntil: bigint | null = null;
  /** A sweep refused as spent or expired: not tried again before its window closes; how many in a row. */
  #sweepPausedUntil: bigint | null = null;
  #benignSweeps = 0;
  /** The slot the wallet and the settings were last checked at. */
  #checkedAt: bigint | null = null;
  readonly #suspects: Set<string>;
  readonly #datums = new Map<string, PlutusData>();
  readonly #datumMisses = new Map<string, bigint>();
  readonly #logged = new Set<string>();
  /** The batching account's balance, and the slot it was read at (it changes only if someone pays in). */
  #reward: { balance: bigint; slot: bigint } | null = null;
  #stopped: { reason: string; fatal: boolean } | null = null;
  #closing = false;
  #running: Promise<void> | null = null;
  #again = false;

  /** `signer` null: a dry run, every batch prepared and judged, nothing signed or sent. */
  constructor(views: readonly ChainView[], signer: Signer | null, c: WatcherConfig, log: (e: WatcherEvent) => void) {
    if (signer && signer.keyHash !== c.batcher.keyHash) throw new Error('the signing key is not the batcher key');
    // The batcher's change and its collateral's return go to this address: it must be its own.
    if (!isBatcherAddress(c.batcher.address, c.batcher.keyHash, c.deployment.network)) throw new Error(`${c.batcher.address} is not the batcher key's own enterprise address`);
    this.#views = views;
    this.#signer = signer;
    this.#c = c;
    this.#log = log;
    this.#suspects = new Set(c.suspects ?? []);
  }

  /** Why the batcher stopped (it never starts again by itself), or null. `fatal`: the process must restart. */
  get stopped(): { reason: string; fatal: boolean } | null {
    return this.#stopped;
  }

  /** Runs a round now, or right after the one running (never two at once). */
  trigger(): Promise<void> {
    if (this.#closing || this.#stopped) return this.#running ?? Promise.resolve();
    if (this.#running) {
      this.#again = true;
      return this.#running;
    }
    this.#running = (async () => {
      try {
        do {
          this.#again = false;
          await this.round();
        } while (this.#again && !this.#stopped && !this.#closing);
      } finally {
        this.#running = null;
      }
    })();
    return this.#running;
  }

  /** No new round starts; resolves once the one running has finished. */
  async close(): Promise<void> {
    this.#closing = true;
    await this.#running;
  }

  /** One round. Exposed for tests; use trigger() otherwise. */
  async round(): Promise<void> {
    if (this.#stopped || this.#closing) return;
    for (const view of this.#views) {
      try {
        const tip = await view.tip();
        this.#checkTip(tip);
        await this.#roundOn(view, tip);
      } catch (e) {
        if (e instanceof LibraryTrapped) {
          const what = e.refs.length === 1 ? `${e.refs[0]}, which the next process never reads` : `the batch of ${e.refs.join(', ')}, each tried alone by the next process`;
          return this.#stop(`EMURGO's library failed on ${what} (${message(e)}); its memory is broken until the process restarts`, true, e.refs);
        }
        if (isWasmTrap(e)) return this.#stop(`EMURGO's library failed (${message(e)}); its memory is broken until the process restarts`, true);
        if (e instanceof InputsGone) return this.#log({ kind: 'inputs-gone', source: view.name, error: message(e) });
        if (e instanceof SourceUnavailable || e instanceof OgmiosError) {
          this.#log({ kind: 'source-down', source: view.name, error: message(e) });
          continue;
        }
        if (e instanceof SetupError) return this.#stop(message(e), false);
        this.#log({ kind: 'error', error: message(e) });
      }
      return;
    }
  }

  #checkTip(tip: Tip): void {
    const at = Number(slotToPosixMs(tip.slot, this.#c.deployment.dex.time));
    const now = (this.#c.now ?? Date.now)();
    if (at < now - TIP_BEHIND_MS || at > now + TIP_AHEAD_MS) throw new SourceUnavailable(`the tip (slot ${tip.slot}) is ${Math.round(Math.abs(now - at) / 1000)} s ${at < now ? 'behind' : 'ahead of'} this machine's clock (is the source, or the clock, wrong?)`);
  }

  async #roundOn(view: ChainView, tip: Tip): Promise<void> {
    for (const [tx, f] of this.inflight) if (tip.slot > f.validToSlot) this.inflight.delete(tx);
    for (const [ref, until] of this.setAside) if (tip.slot > until) this.setAside.delete(ref);
    const { deployment: dep, policy, batcher } = this.#c;

    // Orders first: most rounds find none, and stop there.
    const orderUtxos = [...(await view.utxosAtCredential(dep.orderScriptHash))].sort(compareAge);
    await this.#lookUpDatums(view, orderUtxos, tip.slot);
    const orders = readOrders(dep, policy, orderUtxos, this.#datums);
    const exclude = () => new Set([...[...this.inflight.values()].flatMap((f) => f.refs), ...this.setAside.keys()]);
    const waiting = () => orders.orders.some((o) => !exclude().has(o.utxo.ref));
    // An order of a batch in flight gone: the batch landed, or another spent the order first.
    const here = new Set(orderUtxos.map((u) => u.ref));
    const spentInFlight = [...this.inflight.values()].some((f) => f.orders.some((r) => !here.has(r)));
    if (!waiting() && !spentInFlight && this.#checkedAt !== null && tip.slot - this.#checkedAt < SETUP_CHECK_SLOTS) {
      this.#skipped(orders.skipped, orderUtxos);
      return this.#log({ kind: 'idle', source: view.name, slot: tip.slot, orders: orders.orders.length });
    }

    const [pp, settings, scripts, poolUtxos, wallet, rewardBalance] = await Promise.all([
      view.protocolParams(),
      view.utxosWithAsset(dep.dex.authenPolicy, GLOBAL_SETTING_TOKEN, dep.dex.authenPolicy),
      view.utxos([dep.scriptRefs.pool, dep.scriptRefs.order, dep.scriptRefs.poolBatching]),
      view.utxosWithAsset(dep.dex.authenPolicy, POOL_NFT, dep.dex.poolScriptHash),
      view.utxosAtCredential(batcher.keyHash),
      this.#rewardBalance(view, tip.slot),
    ]);

    // The wallet: a collateral UTxO (shared by batches in flight: it is only spent if a script
    // fails) and a fee UTxO no batch in flight is spending. Only plain ADA is ever spent.
    const held = wallet.reduce((s, u) => s + coin(u), 0n);
    const plain = wallet.filter((u) => isPlainBatcherUtxo(u, batcher.keyHash)).sort(byCoin);
    const plainHeld = plain.reduce((s, u) => s + coin(u), 0n);
    if (held !== this.#held || plainHeld !== this.#plainHeld) this.#log({ kind: 'wallet', held, plain: plainHeld, cap: this.#c.floatCap });
    this.#held = held;
    this.#plainHeld = plainHeld;
    // A collateral a batch in flight pledged is never spent meanwhile (by a batch, or a sweep), even
    // when a newer, smaller UTxO (anyone can send one) has become the collateral of the batches after.
    const pledged = new Set([...this.inflight.values()].flatMap((f) => (f.collateral ? [f.collateral] : [])));
    const collateral = plain.find((u) => coin(u) >= MIN_COLLATERAL);
    const others = plain.filter((u) => u !== collateral && !pledged.has(u.ref)).reverse();
    const sweep = this.#c.sweep;
    if (!sweep && held > this.#c.floatCap) return this.#stop(`the batcher holds ${held} lovelace, above its cap of ${this.#c.floatCap}: no treasury is named to sweep it to, so raise floatCap in BATCHER_SETTINGS and redeploy, or name the treasury (sweep) once it exists`, false);
    if (sweep) {
      // Counted on what it can spend: a gift of tokens is never its to sweep, and never stops it.
      // One sweep at a time: while one is in flight (or a dry run's is held, or one was just
      // refused as spent or expired), batching goes on, and the rest waits for the next.
      const going = [...this.inflight.values()].some((f) => f.sweep !== undefined);
      const paused = (this.#drySweepUntil !== null && tip.slot <= this.#drySweepUntil) || (this.#sweepPausedUntil !== null && tip.slot <= this.#sweepPausedUntil);
      // The cap cannot be met while the collateral and the float kept are more than it: said once, while it lasts.
      const stuck = (collateral ? coin(collateral) : 0n) + sweep.keep > this.#c.floatCap;
      if (stuck && plainHeld > this.#c.floatCap && !this.#capAlerted) this.#log({ kind: 'alert', reason: `the batcher holds ${plainHeld} lovelace in plain ADA, above its cap of ${this.#c.floatCap}, and no sweep can bring it under: its collateral UTxO (${collateral ? coin(collateral) : 0n}) and sweep.keep (${sweep.keep}) are more than the cap` });
      this.#capAlerted = stuck && plainHeld > this.#c.floatCap;
      if (!going && !paused && plainHeld > this.#c.floatCap) {
        const s = buildSweep({ batcher, treasury: sweep.treasury, utxos: others.filter((u) => !exclude().has(u.ref)), keep: sweep.keep, validToSlot: tip.slot + policy.slotsAfter }, pp);
        if (s) return this.#sendSweep(view, s, tip.slot + policy.slotsAfter);
      }
    }

    let global: ReturnType<typeof readGlobalSetting>;
    let index: number;
    try {
      global = readGlobalSetting(dep, settings);
      index = batcherIndex(global.setting, batcher.keyHash);
    } catch (e) {
      if (e instanceof DecodeError || e instanceof NotABatcher) throw new SetupError(message(e));
      throw e;
    }
    const script = (ref: string) => scripts.find((u) => u.ref === ref) ?? missing(`the reference script UTxO ${ref}`);
    const refs = { pool: script(dep.scriptRefs.pool), order: script(dep.scriptRefs.order), poolBatching: script(dep.scriptRefs.poolBatching) };
    const pools = readPools(dep, poolUtxos);

    if (!collateral || !others.some((u) => coin(u) >= MIN_FEE_UTXO)) return this.#stop(`the batcher needs two plain ADA UTxOs at its key: one of at least ${MIN_COLLATERAL} lovelace for collateral, and its float, of at least ${MIN_FEE_UTXO}`, false);
    this.#checkedAt = tip.slot;
    this.#releaseOutrun(here, new Set(poolUtxos.map((u) => u.ref)));
    if (!waiting()) {
      this.#skipped(orders.skipped, orderUtxos);
      return this.#log({ kind: 'idle', source: view.name, slot: tip.slot, orders: orders.orders.length });
    }

    const roundSkipped: Skipped[] = [...pools.skipped, ...orders.skipped];
    for (let prepares = 0; prepares < MAX_PREPARES_PER_ROUND; ) {
      const chosen = chooseBatch(dep, policy, pools.pools, orders.orders, exclude(), tip.slot, (o) => orderOutputProblem(o, dep.network, pp));
      roundSkipped.push(...chosen.skipped);
      if (!chosen.candidate) break;
      // Never a stranger's dust: the first build, on placeholder budgets, could not make change.
      const fee = others.find((u) => !exclude().has(u.ref) && coin(u) >= MIN_FEE_UTXO);
      if (!fee) return this.#log({ kind: 'idle', source: view.name, slot: tip.slot, orders: orders.orders.length, reason: 'every fee UTxO is in a batch still in flight' });
      let candidate: Candidate = chosen.candidate;
      // An order of a batch the library broke on, in an earlier process: alone, so the next break names it.
      const suspect = candidate.orders.findIndex((o) => this.#suspects.has(o.utxo.ref));
      if (suspect >= 0) candidate = { ...candidate, orders: [candidate.orders[suspect]!], fees: [candidate.fees[suspect]!] };
      for (;;) {
        prepares++;
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
          // The source, the wallet, the settings: not this batch's fault. A broken library: named.
          if (isWasmTrap(e)) throw new LibraryTrapped(candidate.orders.map((o) => o.utxo.ref), e);
          if (e instanceof SourceUnavailable || e instanceof OgmiosError || e instanceof SetupError) throw e;
          if (candidate.orders.length > 1 && prepares < MAX_PREPARES_PER_ROUND) {
            const half = Math.ceil(candidate.orders.length / 2);
            candidate = { ...candidate, orders: candidate.orders.slice(0, half), fees: candidate.fees.slice(0, half) };
            continue;
          }
          if (candidate.orders.length > 1) break;
          // One order, failing alone: set aside, and the round goes on with the rest. Refused by
          // our own engine or builder rules is expected; refused by the node, or by the read-back,
          // means our engine and the contract disagree.
          const ref = candidate.orders[0]!.utxo.ref;
          this.#cleared(candidate);
          const alert = !(e instanceof ContractFailure || e instanceof Unsupported || e instanceof BatchTooBig || e instanceof DecodeError);
          this.setAside.set(ref, tip.slot + this.#c.quarantineSlots);
          this.#log({ kind: 'set-aside', ref, reason: message(e), alert });
          if (alert && ++this.#alerts === MAX_ALERTS_IN_A_ROW) this.#log({ kind: 'alert', reason: `${this.#alerts} orders in a row were refused on their own by the node or the read-back: our engine and the contract disagree` });
          break;
        }
        this.#cleared(candidate);
        this.#skipped(roundSkipped, orderUtxos);
        return this.#send(view, candidate, prepared, [fee.ref], collateral.ref);
      }
    }
    this.#skipped(roundSkipped, orderUtxos);
    // Orders waiting, none batchable now (a limit order's price, a pool that does not exist): the
    // source answered all the same.
    this.#log({ kind: 'idle', source: view.name, slot: tip.slot, orders: orders.orders.length, reason: 'no order can be batched now' });
  }

  /** A block chain-sync delivered: our batches in it have landed, and windows it passes are judged. */
  blockSeen(slot: bigint, txIds: readonly string[]): void {
    this.#syncUp = true;
    for (const t of txIds) {
      const a = this.#awaiting.get(t);
      if (a) a.landedSlot = slot;
    }
    for (const [txId, a] of this.#awaiting) {
      if (slot <= a.validToSlot) continue;
      this.#awaiting.delete(txId);
      if (a.landedSlot !== null) {
        this.#unlanded = 0;
        this.#log({ kind: 'landed', txId, slot: a.landedSlot });
        continue;
      }
      this.#log({ kind: 'unlanded', txId, validToSlot: a.validToSlot, inARow: ++this.#unlanded });
    }
  }

  /** A batch in flight one of whose orders another spent, its pool not: it can never land. Released. */
  #releaseOutrun(orders: ReadonlySet<string>, pools: ReadonlySet<string>): void {
    for (const [txId, f] of this.inflight) {
      const spent = f.orders.find((r) => !orders.has(r));
      if (spent === undefined || !pools.has(f.pool)) continue;
      this.inflight.delete(txId);
      this.#awaiting.delete(txId);
      this.#log({ kind: 'outrun', txId, spent });
    }
  }

  /** The suspects in a batch that was prepared, or refused, without breaking the library: cleared. */
  #cleared(c: Candidate): void {
    for (const o of c.orders) if (this.#suspects.delete(o.utxo.ref)) this.#log({ kind: 'suspect-cleared', ref: o.utxo.ref });
  }

  /**
   * Chain-sync was lost: it starts again at the new tip, so the blocks meanwhile are never seen, and
   * a batch awaiting a block can no longer be judged (nor one sent before a block comes again).
   */
  syncLost(): void {
    this.#syncUp = false;
    this.#awaiting.clear();
  }

  /** The chain rolled back to `slot`: a batch landed after it has not landed (yet). */
  rolledBack(slot: bigint): void {
    for (const a of this.#awaiting.values()) if (a.landedSlot !== null && a.landedSlot > slot) a.landedSlot = null;
  }

  /** The batching account's balance: cached for an hour; if the read fails, the last one read. */
  async #rewardBalance(view: ChainView, slot: bigint): Promise<bigint> {
    if (this.#reward && slot - this.#reward.slot < REWARD_TTL_SLOTS) return this.#reward.balance;
    try {
      const balance = await view.rewardBalance(this.#c.deployment.poolBatchingScriptHash);
      this.#reward = { balance, slot };
      return balance;
    } catch (e) {
      // A stale balance can only get a batch refused (3141), which reads it again.
      if (this.#reward && e instanceof SourceUnavailable) return this.#reward.balance;
      throw e;
    }
  }

  /** Datums of hash-only orders, oldest orders first: sent along by the source, known, or looked up. */
  async #lookUpDatums(view: ChainView, orderUtxos: ChainUtxo[], slot: bigint): Promise<void> {
    const wanted = new Set<string>();
    let lookups = 0;
    for (const u of orderUtxos) {
      const hash = blaming([u.ref], () => {
        const o = CSL.TransactionOutput.from_hex(u.outputHex);
        return !o.has_plutus_data() ? o.data_hash()?.to_hex() : undefined;
      });
      if (!hash) continue;
      wanted.add(hash);
      if (this.#datums.has(hash)) continue;
      if (u.witnessDatum) {
        const w = u.witnessDatum;
        this.#datums.set(hash, blaming([u.ref], () => CSL.PlutusData.from_hex(w)));
        continue;
      }
      if ((this.#datumMisses.get(hash) ?? -1n) > slot || lookups >= MAX_DATUM_LOOKUPS) continue;
      lookups++;
      const bytes = await view.datum(hash);
      const data = bytes && shallowCbor(bytes) ? blaming([u.ref], () => CSL.PlutusData.from_hex(bytes)) : null;
      if (data && blaming([u.ref], () => CSL.hash_plutus_data(data).to_hex()) === hash) this.#datums.set(hash, data);
      else this.#datumMisses.set(hash, slot + DATUM_MISS_SLOTS);
    }
    // Only the datums of orders still waiting are kept.
    for (const h of this.#datums.keys()) if (!wanted.has(h)) this.#datums.delete(h);
    for (const h of this.#datumMisses.keys()) if (!wanted.has(h)) this.#datumMisses.delete(h);
  }

  /** Each skipped UTxO is logged once while it stays (anyone can make orders, by the thousand). */
  #skipped(items: Skipped[], current: ChainUtxo[]): void {
    const fresh = items.filter((s) => !this.#logged.has(s.ref));
    for (const s of fresh) this.#logged.add(s.ref);
    const here = new Set([...current.map((u) => u.ref), ...items.map((s) => s.ref)]);
    for (const r of this.#logged) if (!here.has(r)) this.#logged.delete(r);
    if (fresh.length) this.#log({ kind: 'skipped', items: fresh });
  }

  async #send(view: ChainView, c: Candidate, b: PreparedBatch, walletRefs: string[], collateral: string): Promise<void> {
    const orders = c.orders.map((o) => o.utxo.ref);
    const refs = [c.pool.utxo.ref, ...orders, ...walletRefs];
    const held: InFlight = { refs, pool: c.pool.utxo.ref, orders, validToSlot: c.validToSlot, collateral };
    if (!this.#signer) {
      this.#log({ kind: 'prepared', source: view.name, pool: c.pool.lpName, orders, fee: b.fee, dryRun: true });
      this.inflight.set(`dry-run:${c.pool.utxo.ref}`, held);
      return;
    }
    this.#log({ kind: 'prepared', source: view.name, pool: c.pool.lpName, orders, fee: b.fee, dryRun: false });
    const signed = this.#signer.sign(b.txHex);
    const txId = CSL.FixedTransaction.from_hex(signed).transaction_hash().to_hex();
    // Held before sending: a submission that times out may still have reached the node.
    this.inflight.set(txId, held);
    try {
      await view.submit(signed);
    } catch (e) {
      if (!(e instanceof SubmitRefused)) {
        this.#log({ kind: 'error', error: `the batch ${txId} may or may not have been sent; its inputs are held until its window closes: ${message(e)}` });
        return;
      }
      this.inflight.delete(txId);
      if (e.withdrawal) this.#reward = null;
      // An input gone, a window passed, the batching account changed: not a fault of the batch.
      if (e.benign || e.withdrawal) {
        if (++this.#benign === BENIGN_ALERT) this.#log({ kind: 'alert', reason: `${this.#benign} batches in a row were refused as spent, expired or withdrawing the wrong amount: is the source's tip current?` });
      } else this.#refusals++;
      this.#log({ kind: 'refused', pool: c.pool.lpName, error: message(e), inARow: this.#refusals, benign: e.benign || e.withdrawal });
      if (this.#refusals >= this.#c.maxRefusalsInARow) this.#stop(`the node refused ${this.#refusals} batches in a row; the last: ${message(e)}`, false);
      return;
    }
    this.#refusals = 0;
    this.#benign = 0;
    this.#alerts = 0;
    if (this.#c.checkLanding && this.#syncUp) this.#awaiting.set(txId, { validToSlot: c.validToSlot, landedSlot: null });
    this.#log({ kind: 'sent', txId, pool: c.pool.lpName, orders, fee: b.fee });
  }

  /** The sweep: held like a batch until its window closes, read back again once signed, then sent. */
  async #sendSweep(view: ChainView, s: PreparedSweep, validToSlot: bigint): Promise<void> {
    const held: InFlight = { refs: s.refs, pool: '', orders: [], validToSlot, sweep: s.amount };
    const sweep = this.#c.sweep!;
    // A dry run's sweep is never sent, so it holds no UTxO: batches are still prepared and judged.
    if (!this.#signer) {
      this.#log({ kind: 'sweep-prepared', amount: s.amount, fee: s.fee, refs: s.refs, dryRun: true });
      this.#drySweepUntil = validToSlot;
      return;
    }
    this.#log({ kind: 'sweep-prepared', amount: s.amount, fee: s.fee, refs: s.refs, dryRun: false });
    const signed = this.#signer.sign(s.txHex);
    // The signature adds a witness and nothing else: read back as signed, before it goes.
    verifySweep(signed, { refs: s.refs, inputs: s.inputs, keep: sweep.keep, batcherAddress: this.#c.batcher.address, treasuryAddress: sweep.treasury.address });
    const txId = CSL.FixedTransaction.from_hex(signed).transaction_hash().to_hex();
    this.inflight.set(txId, held);
    try {
      await view.submit(signed);
    } catch (e) {
      if (!(e instanceof SubmitRefused)) {
        this.#log({ kind: 'error', error: `the sweep ${txId} may or may not have been sent; its inputs are held until its window closes: ${message(e)}` });
        return;
      }
      this.inflight.delete(txId);
      this.#log({ kind: 'sweep-refused', txId, error: message(e), benign: e.benign });
      // Anything but an input gone or a window passed: a person is needed.
      if (!e.benign) return this.#stop(`the sweep to the treasury was refused: ${message(e)}`, false);
      // Spent or expired: not tried again before its window closes, and batching goes on meanwhile.
      this.#sweepPausedUntil = validToSlot;
      if (++this.#benignSweeps === BENIGN_ALERT) this.#log({ kind: 'alert', reason: `${this.#benignSweeps} sweeps in a row were refused as spent or expired: is the source's tip current?` });
      return;
    }
    this.#benignSweeps = 0;
    if (this.#c.checkLanding && this.#syncUp) this.#awaiting.set(txId, { validToSlot, landedSlot: null });
    this.#log({ kind: 'swept', txId, amount: s.amount, fee: s.fee, to: sweep.treasury.address });
  }

  #stop(reason: string, fatal: boolean, trapped?: string[]): void {
    this.#stopped = { reason, fatal };
    this.#log({ kind: 'stopped', reason, fatal, ...(trapped ? { trapped } : {}) });
  }
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const coin = (u: ChainUtxo) => BigInt(CSL.TransactionOutput.from_hex(u.outputHex).amount().coin().to_str());
const byCoin = (a: ChainUtxo, b: ChainUtxo) => (coin(a) < coin(b) ? -1 : coin(a) > coin(b) ? 1 : 0);
const missing = (what: string): never => {
  throw new SourceUnavailable(`${what} is not on chain (as this source sees it)`);
};
const spentOf = (us: { ref: string; outputHex: string }[]) => Object.fromEntries(us.map((u) => [u.ref, u.outputHex]));

export type { ProtocolParams };
