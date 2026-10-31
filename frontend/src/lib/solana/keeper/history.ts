/**
 * What the keeper's wallet did, read from the chain: every transaction that touched it, as
 * what the keeper gained or spent in it. The dashboard's figures (scripts/price-keeper.mjs
 * `dashboard`). Read from the chain, not from the earnings log: the chain also has the trips
 * made before the log existed, the money put in, and anything a stranger sent.
 *
 * The keeper's SOL is its wallet plus every token account it owns, counted in lamports: wrapped
 * SOL and the rent held in its coin accounts are its money, so wrapping or opening its own
 * account moves nothing. Rent it pays into an account it does not own (a program's account in
 * its name, such as Pump.fun's trader account) is counted apart, as a deposit.
 */
import { JUPITER_PROGRAM } from './plan';

const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const JUPITER = JUPITER_PROGRAM.toBase58();

interface RpcTokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string; decimals: number };
}

/** A `getTransaction` result, `json` encoding, as much of it as is read here. */
export interface RpcTx {
  slot: number;
  blockTime?: number | null;
  transaction: { signatures: string[]; message: { accountKeys: string[]; instructions: { programIdIndex: number }[] } };
  meta: {
    err: unknown;
    fee: number;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?: RpcTokenBalance[] | null;
    postTokenBalances?: RpcTokenBalance[] | null;
    innerInstructions?: { instructions: { programIdIndex: number }[] }[] | null;
    loadedAddresses?: { writable: string[]; readonly: string[] } | null;
  } | null;
}

/**
 * trade: a round trip through our pools · sale: a sale of leftover tokens through Jupiter ·
 * setup: anything else the keeper sent itself (wrapping SOL) · in: money someone else sent ·
 * out: money the keeper sent away (`withdraw`).
 */
export type ActivityKind = 'trade' | 'sale' | 'setup' | 'in' | 'out';

export interface TokenChange {
  mint: string;
  change: bigint;
  decimals: number;
}

export interface Activity {
  signature: string;
  slot: number;
  /** Unix seconds; null when the chain gave no time. */
  at: number | null;
  kind: ActivityKind;
  /** False when the chain refused it: only its fee was spent. */
  ok: boolean;
  /** The network fee, when the keeper paid it; else 0. */
  fee: bigint;
  /** The change in the keeper's SOL (wallet + its token accounts, in lamports), fees included. */
  sol: bigint;
  /** Rent the keeper paid into new accounts it does not own. */
  deposits: bigint;
  /** The change in each token the keeper holds, wrapped SOL left out (it is in `sol`). */
  tokens: TokenChange[];
  /** Our venue's pools it touched. */
  pools: string[];
  /** Who paid for it, when not the keeper. */
  from: string | null;
}

/**
 * One transaction, as the keeper's gain or spend. Null when the chain gave no result for it
 * (`meta` or its signature missing), or the keeper is in neither its accounts nor its token balances: no read
 * of it is a read of nothing done.
 */
export function readActivity(tx: RpcTx, owner: string, venueProgram: string, venuePools: ReadonlySet<string>): Activity | null {
  const meta = tx.meta;
  const signature = tx.transaction.signatures[0];
  if (!meta || !signature) return null;
  const keys = [...tx.transaction.message.accountKeys, ...(meta.loadedAddresses?.writable ?? []), ...(meta.loadedAddresses?.readonly ?? [])];
  const pre = meta.preTokenBalances ?? [];
  const post = meta.postTokenBalances ?? [];
  const mine = new Set([...pre, ...post].filter((b) => b.owner === owner).map((b) => b.accountIndex));
  const wallet = keys.indexOf(owner);
  if (wallet < 0 && !mine.size) return null;
  if (wallet >= 0) mine.add(wallet);
  const lamports = (side: number[]) => [...mine].reduce((sum, i) => sum + BigInt(side[i] ?? 0), 0n);
  const sol = lamports(meta.postBalances) - lamports(meta.preBalances);

  const byMint = new Map<string, TokenChange>();
  const add = (b: RpcTokenBalance, sign: bigint) => {
    if (b.owner !== owner || b.mint === WSOL_MINT) return;
    const t = byMint.get(b.mint) ?? { mint: b.mint, change: 0n, decimals: b.uiTokenAmount.decimals };
    t.change += sign * BigInt(b.uiTokenAmount.amount);
    byMint.set(b.mint, t);
  };
  for (const b of pre) add(b, -1n);
  for (const b of post) add(b, 1n);
  const tokens = [...byMint.values()].filter((t) => t.change !== 0n);

  const programs = new Set(tx.transaction.message.instructions.map((i) => keys[i.programIdIndex]));
  for (const inner of meta.innerInstructions ?? []) for (const i of inner.instructions) programs.add(keys[i.programIdIndex]);
  const paid = keys[0] === owner;
  // Accounts this transaction opened (no lamports before) that are not the keeper's: what the
  // keeper put in them is a deposit. Only on its own transactions: it is the only one paying.
  let deposits = 0n;
  if (paid) {
    keys.forEach((_, i) => {
      if (!mine.has(i) && (meta.preBalances[i] ?? 0) === 0 && (meta.postBalances[i] ?? 0) > 0) deposits += BigInt(meta.postBalances[i] ?? 0);
    });
  }
  const fee = paid ? BigInt(meta.fee) : 0n;
  const ok = meta.err === null || meta.err === undefined;
  const kind: ActivityKind = !paid
    ? 'in'
    : programs.has(venueProgram)
      ? 'trade'
      : programs.has(JUPITER)
        ? 'sale'
        : sol + fee + deposits < 0n || tokens.some((t) => t.change < 0n)
          ? 'out'
          : 'setup';
  return {
    signature,
    slot: tx.slot,
    at: tx.blockTime ?? null,
    kind,
    ok,
    fee,
    sol,
    deposits,
    tokens,
    pools: [...new Set(keys.filter((k) => venuePools.has(k)))],
    from: paid ? null : (keys[0] ?? null),
  };
}

/** What a trade or sale made before its fee and deposits: the gap it took, in SOL. */
export const madeSol = (a: Activity): bigint => a.sol + a.fee + a.deposits;

export interface Results {
  /** Round trips the chain took, and the ones it refused (each cost its fee). */
  trades: number;
  refused: number;
  sales: number;
  /** What the trades and sales made, in SOL, before fees and deposits. */
  madeSol: bigint;
  /** Tokens the trades and sales left the keeper with (leftovers), or spent. */
  madeTokens: TokenChange[];
  /** Every network fee the keeper paid. */
  fees: bigint;
  /** Rent paid into accounts the keeper does not own. */
  deposits: bigint;
  /** Money sent in by others, and sent away by the keeper (negative). */
  putInSol: bigint;
  putInTokens: TokenChange[];
  takenOutSol: bigint;
  takenOutTokens: TokenChange[];
}

function sumTokens(of: readonly Activity[]): TokenChange[] {
  const by = new Map<string, TokenChange>();
  for (const a of of)
    for (const t of a.tokens) {
      const s = by.get(t.mint) ?? { mint: t.mint, change: 0n, decimals: t.decimals };
      s.change += t.change;
      by.set(t.mint, s);
    }
  return [...by.values()].filter((t) => t.change !== 0n);
}

export function results(activities: readonly Activity[]): Results {
  const trips = activities.filter((a) => a.kind === 'trade' || a.kind === 'sale');
  const ins = activities.filter((a) => a.kind === 'in');
  const outs = activities.filter((a) => a.kind === 'out');
  const sum = (of: readonly Activity[], f: (a: Activity) => bigint) => of.reduce((s, a) => s + f(a), 0n);
  return {
    trades: activities.filter((a) => a.kind === 'trade' && a.ok).length,
    refused: activities.filter((a) => a.kind === 'trade' && !a.ok).length,
    sales: activities.filter((a) => a.kind === 'sale' && a.ok).length,
    madeSol: sum(trips, madeSol),
    madeTokens: sumTokens(trips),
    fees: sum(activities, (a) => a.fee),
    deposits: sum(activities, (a) => a.deposits),
    putInSol: sum(ins, (a) => a.sol),
    putInTokens: sumTokens(ins),
    // A withdrawal's fee is a fee, not money taken out.
    takenOutSol: sum(outs, (a) => a.sol + a.fee),
    takenOutTokens: sumTokens(outs),
  };
}

/** Trades and sales by UTC day (YYYY-MM-DD), newest first. */
export function byDay(activities: readonly Activity[]): { day: string; results: Results }[] {
  const days = new Map<string, Activity[]>();
  for (const a of activities) {
    if (a.at === null || (a.kind !== 'trade' && a.kind !== 'sale')) continue;
    const day = new Date(a.at * 1000).toISOString().slice(0, 10);
    days.set(day, [...(days.get(day) ?? []), a]);
  }
  return [...days.entries()].sort(([x], [y]) => (x < y ? 1 : -1)).map(([day, of]) => ({ day, results: results(of) }));
}

/**
 * What the keeper should hold after every activity up to `slot`: its SOL (wallet + token
 * accounts, lamports) and each token. Set beside what it does hold, a difference means the
 * history is missing something, and the page says so instead of showing figures as whole.
 */
export function expectedHoldings(activities: readonly Activity[], slot: number): { sol: bigint; tokens: Map<string, bigint> } {
  const tokens = new Map<string, bigint>();
  let sol = 0n;
  for (const a of activities) {
    if (a.slot > slot) continue;
    sol += a.sol;
    for (const t of a.tokens) tokens.set(t.mint, (tokens.get(t.mint) ?? 0n) + t.change);
  }
  return { sol, tokens };
}
