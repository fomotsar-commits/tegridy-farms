// The tick. Everything above this file is pure or injectable, so this is where
// the policy about failure lives, and the policy is one sentence:
//
//   an error either advances the cursor AND leaves a row saying what was lost,
//   or it advances nothing at all.
//
// There is no third option, and in particular there is no "skip it and carry
// on". Skipping a signature without moving the cursor makes the same signature
// fail on every tick forever; skipping it and moving the cursor deletes it from
// history with nothing recording that it was ever there. Which of the two
// halves applies depends only on whether the failure is transient:
//
//   transient (the cluster did not answer) → advance nothing, retry next tick.
//   terminal  (the cluster will never answer, or answered something we cannot
//              attribute) → advance past it, and write the gap row.

import { SolanaRpcError } from "./rpc.js";
import { collectNewSignatures, describeTruncation } from "./pagination.js";
import { classifyTransaction } from "./classify.js";

/** Transient: the tick gives up and tries again, having changed nothing. */
function isTransient(e) {
  return e instanceof SolanaRpcError && e.kind === "unreachable";
}

/** Terminal for one datum: the cluster answered, and the answer is "gone". */
function isPruned(e) {
  return e instanceof SolanaRpcError && e.kind === "pruned";
}

/**
 * @param {object} deps
 * @param {object} deps.rpc     from createSolanaRpc
 * @param {object} deps.store   from createStore
 * @param {object} deps.watch   one entry of the parsed watch set
 * @param {number} deps.pageLimit
 * @param {number} deps.maxPages
 * @returns {Promise<{pool:string, fetched:number, trades:number, claims:number, gaps:number, stoppedEarly:boolean}>}
 */
export async function ingestWatch({ rpc, store, watch, pageLimit, maxPages }) {
  const summary = { pool: watch.pool, fetched: 0, trades: 0, claims: 0, gaps: 0, stoppedEarly: false };

  const cursor = await store.getCursor(watch.pool);
  const until = cursor?.lastSignature ?? watch.startSignature ?? null;

  let walk;
  try {
    walk = await collectNewSignatures({
      fetchPage: (args) => rpc.getSignaturesForAddress(watch.pool, args),
      until,
      pageLimit,
      maxPages,
    });
  } catch (e) {
    if (isPruned(e)) {
      // The resume point is older than the RPC retains. Everything between it
      // and whatever the node still holds is unrecoverable from this endpoint,
      // and saying so is the only correct move — a silent restart from head
      // would produce a clean-looking table with a hole in the middle.
      await store.recordGap({
        pool: watch.pool,
        kind: "pruned-history",
        fromSlot: cursor?.lastSlot ?? null,
        toSlot: null,
        detail: `the RPC no longer retains the range after the resume signature: ${e.message}`,
      });
      summary.gaps++;
      summary.stoppedEarly = true;
      return summary;
    }
    throw e;
  }

  const oldest = walk.signatures[0] ?? null;
  const truncation = describeTruncation({
    reachedUntil: walk.reachedUntil,
    hadCursor: until !== null,
    cursorSlot: cursor?.lastSlot ?? null,
    oldestFetchedSlot: oldest?.slot ?? null,
    pagesUsed: walk.pagesUsed,
  });
  if (truncation) {
    await store.recordGap({ pool: watch.pool, ...truncation });
    summary.gaps++;
  }

  for (const sig of walk.signatures) {
    summary.fetched++;

    // The signature listing already carries the failure. Fetching the body of
    // a reverted transaction to learn it moved nothing is an RPC call spent to
    // confirm what we were told.
    if (sig.err !== null && sig.err !== undefined) {
      await store.commitSignature({
        pool: watch.pool,
        signature: sig.signature,
        slot: sig.slot,
        blockTime: sig.blockTime,
        trade: null,
        claims: [],
      });
      continue;
    }

    let tx;
    try {
      tx = await rpc.getTransaction(sig.signature);
    } catch (e) {
      if (isTransient(e)) {
        summary.stoppedEarly = true;
        return summary;
      }
      if (isPruned(e)) {
        tx = null;
      } else {
        throw e;
      }
    }

    if (tx === null) {
      await store.recordGap({
        pool: watch.pool,
        kind: "tx-unavailable",
        signature: sig.signature,
        fromSlot: sig.slot,
        toSlot: sig.slot,
        detail: "the cluster returned no transaction for a signature it had listed",
      });
      summary.gaps++;
      await store.commitSignature({
        pool: watch.pool,
        signature: sig.signature,
        slot: sig.slot,
        blockTime: sig.blockTime,
        trade: null,
        claims: [],
      });
      continue;
    }

    const verdict = classifyTransaction(watch, tx);

    if (verdict.status === "undecodable") {
      await store.recordGap({
        pool: watch.pool,
        kind: "undecodable",
        signature: sig.signature,
        fromSlot: sig.slot,
        toSlot: sig.slot,
        detail: verdict.reason ?? "transaction could not be attributed to this pool",
      });
      summary.gaps++;
    }

    // `slot` and `blockTime` come from the transaction itself when it has them
    // — the listing's copy is the same value, but the fetched body is the one
    // that was actually parsed.
    const slot = Number.isInteger(tx.slot) ? tx.slot : sig.slot;
    const blockTime = Number.isInteger(tx.blockTime) ? tx.blockTime : sig.blockTime;

    const trade = verdict.status === "ok" ? verdict.trade : null;
    const claims = verdict.status === "ok" ? verdict.claims : [];

    await store.commitSignature({
      pool: watch.pool,
      signature: sig.signature,
      slot,
      blockTime,
      trade,
      claims,
    });

    if (trade) summary.trades++;
    summary.claims += claims.length;
  }

  return summary;
}

/**
 * One pass over every watched pool.
 *
 * A failing pool does not stop the others, and it does not silently vanish
 * either: its error is carried into the tick row so `last_error` names it.
 */
export async function runTick({ rpc, store, watches, pageLimit, maxPages, logger = console }) {
  let headSlot = null;
  const errors = [];

  try {
    headSlot = await rpc.getSlot();
  } catch (e) {
    errors.push(`getSlot: ${e.message}`);
  }

  const summaries = [];
  for (const watch of watches) {
    try {
      summaries.push(await ingestWatch({ rpc, store, watch, pageLimit, maxPages }));
    } catch (e) {
      errors.push(`${watch.pool}: ${e.message}`);
      logger.error?.(`[solana-indexer] ${watch.pool} tick failed: ${e.message}`);
    }
  }

  await store.recordTick({ headSlot, error: errors.length > 0 ? errors.join("; ") : null });
  return { headSlot, summaries, errors };
}
