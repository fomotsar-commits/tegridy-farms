// The fill scoreboard's chain reader: for each Jupiter swap that paid the site's fee, what
// Jupiter quoted (it writes the figure into the transaction) against what reached the trader.
// No imports outside node and venue-volume-chain.mjs: the job runs with no npm install.

import {
  JUPITER_FEE_ACCOUNTS,
  JUPITER_PROGRAM,
  SOLANA_BOTS,
  SOL_MINT,
  VENUE_PROGRAM,
  base58,
  unbase58,
  walk,
} from "./venue-volume-chain.mjs";

// The ExactIn route instructions the site's builds use. V1 ends in quoted_out_amount u64,
// slippage_bps u16, platform_fee_bps u8 after a route plan of any length: read from the end.
export const EXACT_IN_ROUTES = Object.freeze({
  e517cb977ae3ad2a: "route",
  "96564774a75d0e68": "route_with_token_ledger",
  c1209b3341d69c81: "shared_accounts_route",
  e6798f50779f6aaa: "shared_accounts_route_with_token_ledger",
  bb64facc31c4af14: "route_v2",
  d19853937cfed8e9: "shared_accounts_route_v2",
});
// V2 opens with in_amount u64, quoted_out_amount u64, slippage_bps u16, platform_fee_bps u16,
// positive_slippage_bps u16, then the route plan: the quote's offset, after shared's u8 id.
const V2_QUOTE_AT = { route_v2: 16, shared_accounts_route_v2: 17 };

const EVENT_TAG = "e445a52e51cb9a1d"; // Anchor's self-CPI event instruction
const SWAP_EVENT = "40c6cde8260871e2";
const FEE_EVENT = "494f4e7fb8d50ddc";
// V2's one event: a u32 hop count, then per hop in mint, in amount (after a fee taken from
// it), out mint, out amount (before a fee taken from it) and AMM, 112 bytes. No FeeEvent.
const SWAPS_EVENT = "982f4eebc0606e6a";
const SWAPS_HOP = 112;

const keysOf = (tx) => tx.transaction.message.accountKeys.map((k) => (typeof k === "string" ? k : k.pubkey));
const innerOf = (tx) => (tx.meta.innerInstructions ?? []).flatMap((g) => g.instructions);
const allIxs = (tx) => [...tx.transaction.message.instructions, ...innerOf(tx)];

/**
 * Jupiter's own events in a transaction: each hop's net per mint, and the fee where a FeeEvent
 * says it (V1 only). `cut`: the hop count of a SwapsEvent too short to hold it, else null.
 */
export function jupiterEvents(instructions) {
  let fee = null;
  const net = {};
  let hops = 0;
  let cut = null;
  const hop = (inMint, inAmount, outMint, outAmount) => {
    net[inMint] = (net[inMint] ?? 0n) - inAmount;
    net[outMint] = (net[outMint] ?? 0n) + outAmount;
    hops++;
  };
  for (const ix of instructions) {
    if (ix.programId !== JUPITER_PROGRAM || typeof ix.data !== "string") continue;
    const d = unbase58(ix.data);
    if (d.length < 16 || d.subarray(0, 8).toString("hex") !== EVENT_TAG) continue;
    const kind = d.subarray(8, 16).toString("hex");
    if (kind === FEE_EVENT && d.length >= 88) {
      fee = { account: base58(d.subarray(16, 48)), mint: base58(d.subarray(48, 80)), amount: d.readBigUInt64LE(80) };
    } else if (kind === SWAP_EVENT && d.length >= 128) {
      hop(base58(d.subarray(48, 80)), d.readBigUInt64LE(80), base58(d.subarray(88, 120)), d.readBigUInt64LE(120));
    } else if (kind === SWAPS_EVENT && d.length >= 20) {
      const count = d.readUInt32LE(16);
      if (d.length < 20 + count * SWAPS_HOP) {
        cut = count;
        continue;
      }
      for (let h = 0; h < count; h++) {
        const o = 20 + h * SWAPS_HOP;
        hop(base58(d.subarray(o, o + 32)), d.readBigUInt64LE(o + 32), base58(d.subarray(o + 40, o + 72)), d.readBigUInt64LE(o + 72));
      }
    }
  }
  return { fee, net, hops, cut };
}

/**
 * What this transaction paid `feeAccount`: V1's FeeEvent, or, when Jupiter is in it with no
 * FeeEvent (V2 emits none), the account's own token balance rise. Null: nothing paid to it.
 */
export function feePaid(tx, ev, feeAccount) {
  if (ev.fee) return ev.fee.account === feeAccount ? ev.fee : null;
  const keys = keysOf(tx);
  const i = keys.indexOf(feeAccount);
  if (i < 0 || !keys.includes(JUPITER_PROGRAM)) return null;
  const at = (list) => (list ?? []).find((b) => b.accountIndex === i);
  const post = at(tx.meta.postTokenBalances);
  if (!post) return null;
  const amount = BigInt(post.uiTokenAmount.amount) - BigInt(at(tx.meta.preTokenBalances)?.uiTokenAmount.amount ?? 0);
  return amount > 0n ? { account: feeAccount, mint: post.mint, amount } : null;
}

/** The one mint the route spent and the one it delivered; null when the events name more. */
export function legsOf(net) {
  const spent = Object.keys(net).filter((m) => net[m] < 0n);
  const got = Object.keys(net).filter((m) => net[m] > 0n);
  return spent.length === 1 && got.length === 1 ? { inMint: spent[0], outMint: got[0] } : null;
}

/** The quote Jupiter's route instruction carries, or why it could not be read. */
function quoteOf(tx) {
  const routes = tx.transaction.message.instructions.filter((ix) => ix.programId === JUPITER_PROGRAM);
  if (routes.length !== 1 || typeof routes[0].data !== "string") return { why: `${routes.length} Jupiter instructions at the top level` };
  const d = unbase58(routes[0].data);
  const kind = EXACT_IN_ROUTES[d.subarray(0, 8).toString("hex")];
  const at = V2_QUOTE_AT[kind];
  if (!kind || d.length < (at === undefined ? 8 + 4 + 11 : at + 8 + 6 + 4)) return { why: `not an ExactIn route (${d.subarray(0, 8).toString("hex")})` };
  if (at !== undefined) return { quotedOut: d.readBigUInt64LE(at), slippageBps: d.readUInt16LE(at + 8), platformFeeBps: d.readUInt16LE(at + 10) };
  const n = d.length;
  return { quotedOut: d.readBigUInt64LE(n - 11), slippageBps: d.readUInt16LE(n - 3), platformFeeBps: d[n - 1] };
}

/** The trader's token balance change for `mint`, or null when the transaction lists no account of theirs for it. */
function ownerDelta(tx, owner, mint) {
  const sum = (list) => {
    let found = false;
    let total = 0n;
    for (const b of list ?? []) {
      if (b.owner !== owner || b.mint !== mint) continue;
      found = true;
      total += BigInt(b.uiTokenAmount.amount);
    }
    return { found, total };
  };
  const post = sum(tx.meta.postTokenBalances);
  if (!post.found) return null;
  return post.total - sum(tx.meta.preTokenBalances).total;
}

/**
 * Lamports the trader put into accounts this transaction opened and left open, other than
 * their own account for the token they bought (which any venue opens on a first buy).
 */
export function depositLamports(tx, trader, outMint) {
  const keys = keysOf(tx);
  const keep = new Set(
    (tx.meta.postTokenBalances ?? []).filter((b) => b.owner === trader && b.mint === outMint).map((b) => keys[b.accountIndex]),
  );
  let total = 0n;
  for (const ix of allIxs(tx)) {
    const info = ix.parsed?.info;
    if (ix.program !== "system" || ix.parsed?.type !== "createAccount" || info?.source !== trader) continue;
    const i = keys.indexOf(info.newAccount);
    if (i < 0 || keep.has(info.newAccount) || !(tx.meta.postBalances[i] > 0)) continue;
    total += BigInt(info.lamports);
  }
  return total;
}

/**
 * One Jupiter swap that paid our fee into `feeAccount`, scored. Null when the transaction
 * is not one (failed, no fee to us, or a route through our own pools, which carries no
 * quote on chain). `{ unread }` when it paid us but cannot be scored: never left out silently.
 */
export function jupiterFill(tx, feeAccount) {
  if (tx.meta.err) return null;
  const keys = keysOf(tx);
  if (keys.includes(VENUE_PROGRAM)) return null;
  const ev = jupiterEvents(innerOf(tx));
  const fee = feePaid(tx, ev, feeAccount);
  if (!fee) return null;
  const trader = keys[0];
  const unread = (why) => ({ unread: why, trader });
  if (ev.cut !== null) return unread(`a SwapsEvent shorter than its ${ev.cut} hops`);
  if (ev.hops === 0) return unread("a fee with no swap event");
  const legs = legsOf(ev.net);
  if (!legs) return unread("the route's events name more than one mint in or out");
  const q = quoteOf(tx);
  if (q.why) return unread(q.why);
  if (q.quotedOut === 0n) return unread("a quote of zero");
  const { inMint, outMint } = legs;
  const feeOn = (m) => (fee.mint === m ? fee.amount : 0n);
  // SOL arrives wrapped and is unwrapped 1:1; its lamports also pay rent and the network
  // fee, so the route's own figure is the honest one. A token is read where it landed.
  const delivered = outMint === SOL_MINT ? ev.net[SOL_MINT] - feeOn(SOL_MINT) : ownerDelta(tx, trader, outMint);
  if (delivered === null) return unread("the trader's account for the output is not in the transaction");
  if (delivered < 0n) return unread("a delivered amount below zero");
  return {
    trader,
    inMint,
    outMint,
    inAmount: -ev.net[inMint] + feeOn(inMint),
    quotedOut: q.quotedOut,
    deliveredOut: delivered,
    slippageBps: q.slippageBps,
    platformFeeBps: q.platformFeeBps,
    depositLamports: depositLamports(tx, trader, outMint),
  };
}

/** Basis points of the quote the trader got above it (negative: below), to 0.01. */
export function fillBps(quotedOut, deliveredOut) {
  return Number(((deliveredOut - quotedOut) * 1_000_000n) / quotedOut) / 100;
}

/** The table's row for one read transaction. */
export function rowOf(hit, sig) {
  const base = {
    signature: sig.signature,
    block_time: new Date(sig.blockTime * 1000).toISOString(),
    bot: SOLANA_BOTS.has(hit.trader),
  };
  if (hit.unread) return { ...base, unread_reason: hit.unread.slice(0, 200) };
  return {
    ...base,
    in_mint: hit.inMint,
    out_mint: hit.outMint,
    in_amount: hit.inAmount.toString(),
    quoted_out: hit.quotedOut.toString(),
    delivered_out: hit.deliveredOut.toString(),
    slippage_bps: hit.slippageBps,
    platform_fee_bps: hit.platformFeeBps,
    fill_bps: fillBps(hit.quotedOut, hit.deliveredOut),
    deposit_lamports: hit.depositLamports.toString(),
    unread_reason: null,
  };
}

/** Each fee account's new transactions, scored: rows for the table and where to resume. */
export async function readFills(call, cursor = {}) {
  const countedTo = new Date().toISOString();
  const next = { ...cursor };
  const rows = [];
  for (const account of JUPITER_FEE_ACCOUNTS) {
    next[account] = await walk(call, account, cursor[account], (tx, s) => {
      const hit = jupiterFill(tx, account);
      if (hit) rows.push(rowOf(hit, { ...s, blockTime: s.blockTime ?? tx.blockTime }));
    });
  }
  return { rows, cursor: next, countedTo };
}
