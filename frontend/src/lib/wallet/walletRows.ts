// The dashboard's wallet rows: what a connected wallet holds, and its positions on this site
// (owner, 2026-10-22: "things that matter like positions on the website and what the wallet
// holds"). Pure: no chain code here, so the home can import it without loading Solana.
//
// THE RULE EVERY LEG KEEPS (the repo's most repeated bug class): a figure is shown only when a
// read returned it. A leg that could not be read says so, by name, with Try again; it is never a
// zero, and never an empty list that reads as "you hold nothing".
import { formatUnits } from 'viem';
import { BUNGALOWS, RETIRED_STAKE_POOLS, type Bungalow } from '../bungalows';

export type WalletChain = 'solana' | 'ethereum' | 'base';

export const WALLET_CHAIN_LABEL: Record<WalletChain, string> = { solana: 'Solana', ethereum: 'Ethereum', base: 'Base' };

/** One coin the wallet holds, with a read amount above zero. */
export interface HoldingRow {
  key: string;
  symbol: string;
  chain: WalletChain;
  /** Formatted amount in whole coins. */
  amount: string;
  /** USD value, only when a price was read for this coin. */
  usd: number | null;
  /** The island room this coin belongs to; null for SOL and ETH. */
  roomId: string | null;
  /** Where the row opens; null for a row that opens nothing. */
  to: string | null;
}

/** One position the wallet has on this site: a lock, a stake or a pool share. */
export interface PositionRow {
  key: string;
  roomId: string | null;
  chain: WalletChain;
  /** "BAYLA lock", "BAYLA / SOL pool", … */
  title: string;
  /** The read facts, each short: "10,000 BAYLA", "unlocks 20 Nov 2026", "earned 12.3 BAYLA". */
  facts: string[];
  to: string;
}

/** A group of reads that land together: loading, read (possibly empty), or not read. */
export type Leg<T> =
  | { status: 'loading' }
  | { status: 'ok'; rows: T[] }
  | { status: 'unread'; detail: string };

/** A leg as the board lists it: what it is, for the "could not be read" line, and its retry. */
export interface NamedLeg<T> {
  key: string;
  /** "your Solana coins", "your BAYLA locks", … */
  what: string;
  leg: Leg<T>;
  retry: () => void;
  /**
   * Set while the rows are this part's last read in this browser (boardMemory.ts), not yet the
   * new one: when they were read, epoch ms.
   */
  readAt?: number;
}

/** Live rooms whose coin is on this chain and has an address. */
export function islandCoinsOn(chain: WalletChain, bungalows: readonly Bungalow[] = BUNGALOWS): Bungalow[] {
  return bungalows.filter((b) => b.live && b.chain === chain && Boolean(b.address));
}

/** A Streamflow pool the wallet may hold stakes in. */
export interface StakeTarget {
  room: Bungalow;
  pool: string;
  /** A retired pool that still holds positions (RETIRED_STAKE_POOLS). */
  retired: boolean;
}

/** Every Streamflow pool a Solana room has, and the retired ones that still hold positions. */
export function solanaStakePools(bungalows: readonly Bungalow[] = BUNGALOWS): StakeTarget[] {
  const live = bungalows.filter((b) => b.live && b.chain === 'solana' && b.stakePool).map((b) => ({ room: b, pool: b.stakePool!, retired: false }));
  const retired = RETIRED_STAKE_POOLS.flatMap((r) => {
    const room = bungalows.find((b) => b.id === r.bungalow);
    return room ? [{ room, pool: r.pool, retired: true }] : [];
  });
  return [...live, ...retired];
}

/** The Ethereum and Base rooms whose pool is a lock ladder (LighthouseLadder). */
export function evmLadderRooms(bungalows: readonly Bungalow[] = BUNGALOWS): (Bungalow & { stakePool: string; address: string })[] {
  return bungalows.filter(
    (b): b is Bungalow & { stakePool: string; address: string } =>
      b.live && (b.chain === 'ethereum' || b.chain === 'base') && b.poolKind === 'ladder' && Boolean(b.stakePool) && Boolean(b.address),
  );
}

/** A raw amount in whole coins, short: 52,000 · 1.23 · 0.0042. */
export function fmtAmount(raw: bigint, decimals: number): string {
  const n = Number(formatUnits(raw, decimals));
  if (!Number.isFinite(n)) return formatUnits(raw, decimals);
  if (n === 0) return '0';
  if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (n >= 1) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return n.toLocaleString('en-US', { maximumSignificantDigits: 3 });
}

export function fmtUsd(v: number): string {
  if (v >= 1000) return `$${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  if (v >= 0.01) return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return '<$0.01';
}

/** "unlocks 20 Nov 2026", or "unlocked" once the date has passed. */
export function unlockWords(unlockSecs: number, nowSecs: number): string {
  if (unlockSecs <= nowSecs) return 'unlocked';
  const d = new Date(unlockSecs * 1000);
  return `unlocks ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

/** USD for a raw amount at a read price; null when no price was read. */
export function usdOf(raw: bigint, decimals: number, price: number | null | undefined): number | null {
  if (price === null || price === undefined || !Number.isFinite(price) || price <= 0) return null;
  return Number(formatUnits(raw, decimals)) * price;
}

/**
 * The holdings' total, and only when it is whole: every holdings leg read, and every coin held
 * priced. A total that silently leaves a coin out understates the wallet, so a partial total is
 * reported as such and never printed as the figure.
 */
export function holdingsTotal(legs: readonly Leg<HoldingRow>[]): { kind: 'total'; usd: number } | { kind: 'partial' } | { kind: 'none' } {
  if (legs.some((l) => l.status !== 'ok')) return { kind: 'partial' };
  const rows = legs.flatMap((l) => (l.status === 'ok' ? l.rows : []));
  if (rows.length === 0) return { kind: 'none' };
  if (rows.some((r) => r.usd === null)) return { kind: 'partial' };
  return { kind: 'total', usd: rows.reduce((s, r) => s + (r.usd ?? 0), 0) };
}

/** One coin's share of the holdings' worth. */
export interface HoldingShare {
  key: string;
  symbol: string;
  roomId: string | null;
  chain: WalletChain;
  /** Percent of the whole, 0–100. */
  pct: number;
}

/**
 * Each priced coin's share of the holdings' worth, largest first. For a whole total only
 * (holdingsTotal 'total'): over a partial read the shares would be of a figure that leaves a
 * coin out, so the board draws none then.
 */
export function holdingShares(rows: readonly HoldingRow[]): HoldingShare[] {
  const total = rows.reduce((s, r) => s + (r.usd ?? 0), 0);
  if (!(total > 0)) return [];
  return rows
    .filter((r) => (r.usd ?? 0) > 0)
    .map((r) => ({ key: r.key, symbol: r.symbol, roomId: r.roomId, chain: r.chain, pct: ((r.usd ?? 0) / total) * 100 }))
    .sort((a, b) => b.pct - a.pct);
}

/** A share in words: "<1%", else whole percent. */
export function pctText(pct: number): string {
  return pct < 1 ? '<1%' : `${Math.round(pct)}%`;
}

/** A position's share of the ladder, read from its own facts ("4.00×"); null when it has none. */
export function boostOf(facts: readonly string[]): number | null {
  for (const f of facts) {
    const m = /^(\d+(?:\.\d+)?)×$/.exec(f);
    if (m) return Number(m[1]);
  }
  return null;
}

/** A failure's message, short enough for one line. */
export function clipReason(e: unknown): string {
  const s = e instanceof Error ? e.message : String(e);
  return s.length > 140 ? `${s.slice(0, 137)}…` : s;
}
