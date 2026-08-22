// One confirmed transaction → the facts it supports, or an explicit refusal.
//
// WHY BALANCE DELTAS AND NOT A DECODED PROGRAM EVENT
// --------------------------------------------------
// Meteora's DBC program emits Anchor events, and decoding them would give the
// swap amounts directly. The IDL is not vendored in this repo and the on-chain
// program is under a licence that forbids forking it (docs/CURVE_FORK_
// EVALUATION.md), so any struct layout written here would be a layout somebody
// remembered. The repo has a standing rule about that: liveConfig.ts hand-rolls
// account offsets ONLY behind a discriminator computed from sha256, and pins
// every offset against a real account, precisely because "wrong and plausible
// is the failure mode worth engineering against".
//
// Pre/post token balances need no layout. They are what the cluster reports the
// accounts held before and after, and the difference is subtraction.
//
// WHY THE POOL'S SIDE AND NOT THE TRADER'S
// ----------------------------------------
// The quote mint on these pools is usually wrapped SOL, and a wrapped-SOL leg
// is routinely a temporary account: created, funded, spent and closed inside
// the same transaction. Such an account exists in NEITHER preTokenBalances nor
// postTokenBalances, so the trader's quote delta reads as exactly 0 — a
// perfectly formed zero that would turn every SOL buy into a free one. The
// pool's vaults, by contrast, exist before and after every trade, always.
//
// So the amounts come from the pool side and the trader side is used only as a
// consistency check when it is visible at all.

const ZERO = 0n;

function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function amountOf(entry) {
  const raw = entry?.uiTokenAmount?.amount;
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return null;
  return BigInt(raw);
}

/**
 * Per-token-account movement for the two mints we care about.
 *
 * Keyed by accountIndex rather than by owner: two accounts owned by the same
 * key must stay distinguishable, and an account that only appears on one side
 * (created, or closed, during the transaction) has an implicit zero on the
 * other.
 *
 * @returns {{ ok: true, moves: Array<{index:number, mint:string, owner:string, delta:bigint}> }
 *          | { ok: false, reason: string }}
 */
export function tokenMoves(meta, mints) {
  const pre = Array.isArray(meta?.preTokenBalances) ? meta.preTokenBalances : null;
  const post = Array.isArray(meta?.postTokenBalances) ? meta.postTokenBalances : null;
  if (pre === null || post === null) {
    // Older transactions predate token-balance metadata, and a base64-encoded
    // fetch omits the owner. Either way the amounts are not attributable, and
    // an unattributable amount is not a smaller amount — it is no answer.
    return { ok: false, reason: "transaction meta carries no pre/post token balances" };
  }

  const wanted = new Set(mints);
  /** @type {Map<number, {index:number, mint:string, owner:string|null, pre:bigint, post:bigint}>} */
  const byIndex = new Map();

  for (const [side, list] of [
    ["pre", pre],
    ["post", post],
  ]) {
    for (const entry of list) {
      if (!isObject(entry) || !Number.isInteger(entry.accountIndex)) {
        return { ok: false, reason: "a token-balance entry is missing its accountIndex" };
      }
      if (typeof entry.mint !== "string" || !wanted.has(entry.mint)) continue;
      const value = amountOf(entry);
      if (value === null) {
        return { ok: false, reason: `token-balance entry for ${entry.mint} has no readable amount` };
      }
      if (typeof entry.owner !== "string" || entry.owner.length === 0) {
        return { ok: false, reason: "a token-balance entry has no owner (jsonParsed encoding required)" };
      }
      const slot = byIndex.get(entry.accountIndex) ?? {
        index: entry.accountIndex,
        mint: entry.mint,
        owner: entry.owner,
        pre: ZERO,
        post: ZERO,
      };
      slot.mint = entry.mint;
      slot.owner = entry.owner;
      slot[side] = value;
      byIndex.set(entry.accountIndex, slot);
    }
  }

  const moves = [];
  for (const slot of byIndex.values()) {
    const delta = slot.post - slot.pre;
    if (delta !== ZERO) {
      moves.push({ index: slot.index, mint: slot.mint, owner: slot.owner, delta });
    }
  }
  return { ok: true, moves };
}

/** Fee payer / signer. Present under both jsonParsed and legacy shapes. */
export function feePayerOf(tx) {
  const keys = tx?.transaction?.message?.accountKeys;
  if (!Array.isArray(keys) || keys.length === 0) return null;
  const first = keys[0];
  if (typeof first === "string") return first;
  if (isObject(first) && typeof first.pubkey === "string") return first.pubkey;
  return null;
}

/**
 * @typedef {object} Classification
 * @property {'ok'|'failed'|'skipped'|'undecodable'} status
 * @property {null|{payer:string, direction:'buy'|'sell', baseAmount:bigint, quoteAmount:bigint}} trade
 * @property {Array<{receiver:string, mint:string, amount:bigint}>} claims
 * @property {string|null} reason
 */

/**
 * @param {{ pool:string, baseMint:string, quoteMint:string, feeReceiver:string|null }} watch
 * @param {object} tx  a getTransaction result, jsonParsed encoding
 * @returns {Classification}
 */
export function classifyTransaction(watch, tx) {
  const result = { status: "skipped", trade: null, claims: [], reason: null };

  if (!isObject(tx) || !isObject(tx.meta)) {
    return { ...result, status: "undecodable", reason: "transaction has no meta" };
  }
  if (tx.meta.err !== null && tx.meta.err !== undefined) {
    // A reverted transaction moved nothing. It is not a gap — we read it, and
    // the answer was "this did not happen".
    return { ...result, status: "failed", reason: "transaction failed on chain" };
  }

  const payer = feePayerOf(tx);
  if (payer === null) {
    return { ...result, status: "undecodable", reason: "transaction has no fee payer key" };
  }

  const moved = tokenMoves(tx.meta, [watch.baseMint, watch.quoteMint]);
  if (!moved.ok) {
    return { ...result, status: "undecodable", reason: moved.reason };
  }
  if (moved.moves.length === 0) {
    // Touched the pool without moving either tracked mint: a pool creation, a
    // config read, a migration bookkeeping instruction. Nothing to record and
    // nothing missing.
    return { ...result, status: "skipped", reason: "no movement of the pool's mints" };
  }

  const receiver = watch.feeReceiver;
  const isCounterparty = (owner) => owner !== payer && (receiver === null || owner !== receiver);

  const claims = [];
  if (receiver !== null) {
    for (const mint of [watch.quoteMint, watch.baseMint]) {
      const gained = moved.moves
        .filter((m) => m.mint === mint && m.owner === receiver && m.delta > ZERO)
        .reduce((acc, m) => acc + m.delta, ZERO);
      if (gained > ZERO) claims.push({ receiver, mint, amount: gained });
    }
  }

  const poolSide = (mint) => moved.moves.filter((m) => m.mint === mint && isCounterparty(m.owner));

  const basePool = poolSide(watch.baseMint);
  const quotePool = poolSide(watch.quoteMint);

  // Nothing on the counterparty side for either mint: the only movement was
  // into the fee receiver. That is a claim, not a trade.
  if (basePool.length === 0 && quotePool.length === 0) {
    if (claims.length > 0) return { status: "ok", trade: null, claims, reason: null };
    return { ...result, status: "skipped", reason: "no counterparty movement of the pool's mints" };
  }

  // More than one counterparty account per mint means a routed or batched
  // transaction: several pools, or a pool plus a hop. Which delta belongs to
  // THIS pool is not decidable from balances alone, and picking the largest
  // would be a guess that writes a number.
  if (basePool.length > 1 || quotePool.length > 1) {
    return {
      ...result,
      status: "undecodable",
      reason: "more than one counterparty account moved a tracked mint (routed or batched transaction)",
    };
  }
  // A trade moves BOTH legs. One-sided counterparty movement is a claim (the
  // pool's quote reserve draining into the fee receiver) or something we have
  // no account of — and the difference is whether a configured fee receiver
  // gained the other half.
  if (basePool.length === 0 || quotePool.length === 0) {
    if (claims.length > 0) return { status: "ok", trade: null, claims, reason: null };
    return {
      ...result,
      status: "undecodable",
      reason: "only one side of the pair moved on the counterparty side",
    };
  }

  const baseDelta = basePool[0].delta;
  const quoteDelta = quotePool[0].delta;
  if (baseDelta > ZERO === quoteDelta > ZERO) {
    return {
      ...result,
      status: "undecodable",
      reason: "both sides of the pair moved in the same direction",
    };
  }

  // Pool gains quote and releases base ⇒ somebody bought the base token.
  const direction = quoteDelta > ZERO ? "buy" : "sell";

  // Cross-check against the trader's own side when it is visible. When the
  // wrapped-SOL leg was transient it is not, and its absence is expected —
  // but a payer whose base moved the SAME way as the pool's base is not a
  // counterparty to this trade, and this is not the transaction we think.
  const payerBase = moved.moves
    .filter((m) => m.mint === watch.baseMint && m.owner === payer)
    .reduce((acc, m) => acc + m.delta, ZERO);
  if (payerBase !== ZERO && payerBase > ZERO === baseDelta > ZERO) {
    return {
      ...result,
      status: "undecodable",
      reason: "fee payer and pool moved the base mint in the same direction",
    };
  }

  return {
    status: "ok",
    trade: {
      payer,
      direction,
      baseAmount: baseDelta < ZERO ? -baseDelta : baseDelta,
      quoteAmount: quoteDelta < ZERO ? -quoteDelta : quoteDelta,
    },
    claims,
    reason: null,
  };
}
