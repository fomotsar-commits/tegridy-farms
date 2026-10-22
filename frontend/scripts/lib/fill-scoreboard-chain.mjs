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

// The ExactIn route instructions the site's builds use. Each ends in quoted_out_amount u64,
// slippage_bps u16, platform_fee_bps u8, after a route plan of any length: read from the end.
export const EXACT_IN_ROUTES = Object.freeze({
  e517cb977ae3ad2a: "route",
  "96564774a75d0e68": "route_with_token_ledger",
  c1209b3341d69c81: "shared_accounts_route",
  e6798f50779f6aaa: "shared_accounts_route_with_token_ledger",
});

const EVENT_TAG = "e445a52e51cb9a1d"; // Anchor's self-CPI event instruction
const SWAP_EVENT = "40c6cde8260871e2";
const FEE_EVENT = "494f4e7fb8d50ddc";

const keysOf = (tx) => tx.transaction.message.accountKeys.map((k) => (typeof k === "string" ? k : k.pubkey));
const innerOf = (tx) => (tx.meta.innerInstructions ?? []).flatMap((g) => g.instructions);
const allIxs = (tx) => [...tx.transaction.message.instructions, ...innerOf(tx)];

/** Jupiter's own events in a transaction: the fee (where it went) and each hop's net per mint. */
export function jupiterEvents(instructions) {
  let fee = null;
  const net = {};
  let hops = 0;
  for (const ix of instructions) {
    if (ix.programId !== JUPITER_PROGRAM || typeof ix.data !== "string") continue;
    const d = unbase58(ix.data);
    if (d.length < 16 || d.subarray(0, 8).toString("hex") !== EVENT_TAG) continue;
    const kind = d.subarray(8, 16).toString("hex");
    if (kind === FEE_EVENT && d.length >= 88) {
      fee = { account: base58(d.subarray(16, 48)), mint: base58(d.subarray(48, 80)), amount: d.readBigUInt64LE(80) };
    } else if (kind === SWAP_EVENT && d.length >= 128) {
      const inMint = base58(d.subarray(48, 80));
      const outMint = base58(d.subarray(88, 120));
      net[inMint] = (net[inMint] ?? 0n) - d.readBigUInt64LE(80);
      net[outMint] = (net[outMint] ?? 0n) + d.readBigUInt64LE(120);
      hops++;
    }
  }
  return { fee, net, hops };
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
  if (!kind || d.length < 8 + 4 + 11) return { why: `not an ExactIn route (${d.subarray(0, 8).toString("hex")})` };
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
  if (!ev.fee || ev.fee.account !== feeAccount) return null;
  const trader = keys[0];
  const unread = (why) => ({ unread: why, trader });
  if (ev.hops === 0) return unread("a fee with no SwapEvent");
  const legs = legsOf(ev.net);
  if (!legs) return unread("the route's events name more than one mint in or out");
  const q = quoteOf(tx);
  if (q.why) return unread(q.why);
  if (q.quotedOut === 0n) return unread("a quote of zero");
  const { inMint, outMint } = legs;
  const feeOn = (m) => (ev.fee.mint === m ? ev.fee.amount : 0n);
  // SOL arrives wrapped and is unwrapped 1:1; its lamports also pay rent and the network
  // fee, so the route's own figure is the honest one. A token is read where it landed.
  const delivered = outMint === SOL_MINT ? ev.net[SOL_MINT] - feeOn(SOL_MINT) : ownerDelta(tx, trader, outMint);
  if (delivered === null) return unread("the trader's account for the output is not in the transaction");
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
