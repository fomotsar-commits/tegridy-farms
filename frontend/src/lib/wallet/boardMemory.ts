// The dashboard's last read of each wallet, kept in this browser so the next visit draws at once
// (owner, 2026-10-24: "the dashboard takes a couple seconds to load ... can we make it instant").
// A fresh read takes seconds: each part is two to five calls to the chain one after another (the
// balances, then the coins' mints, then their prices; a pool share is found, placed, then valued),
// and one call through the site's Solana relay took 0.3 to 1 second (measured 2026-10-24).
//
// Only what a read returned is kept: a part that read, with the time it was read. The board draws
// it while that part is read again, says it is updating, and gives way to the new answer the
// moment it lands. A part the new read could not read says so (walletRows.ts's rule); the kept
// rows never stand in for a failed read.
//
// Public chain data under a public address; nothing here signs or spends. It is a cache: the
// storage sweeper may reclaim it (lib/storage.ts), and the board then reads as it did before.
import { safeGetItem, safeJsonParse, safeSetItem } from '../storage';
import type { HoldingRow, PositionRow } from './walletRows';

export const BOARD_MEMORY_KEY = 'tegridy-wallet-board-v1';
/** A read older than this is not drawn: after a week it is history, not what the wallet holds. */
export const BOARD_MEMORY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Wallets kept; the one read longest ago goes first. */
const WALLETS_KEPT = 4;

export interface KeptLeg {
  /** When it was read, epoch ms. */
  at: number;
  rows: unknown[];
}
type WalletMemory = { at: number; legs: Record<string, KeptLeg> };
// `ts` on top, so the storage sweeper reclaims this entry by its age (lib/storage.ts).
type Store = { ts: number; wallets: Record<string, WalletMemory> };

function load(): Store {
  const s = safeJsonParse<Partial<Store> | null>(safeGetItem(BOARD_MEMORY_KEY), null);
  return s && typeof s.wallets === 'object' && s.wallets !== null ? { ts: Number(s.ts) || 0, wallets: s.wallets } : { ts: 0, wallets: {} };
}

/** What was last read for this wallet, by part, within the week. */
export function recallWallet(owner: string, now = Date.now()): Record<string, KeptLeg> {
  const out: Record<string, KeptLeg> = {};
  for (const [key, kept] of Object.entries(load().wallets[owner]?.legs ?? {})) {
    if (kept && typeof kept.at === 'number' && kept.at <= now && now - kept.at <= BOARD_MEMORY_MAX_AGE_MS && Array.isArray(kept.rows)) {
      out[key] = kept;
    }
  }
  return out;
}

/** Keeps these parts' reads for this wallet, beside the parts already kept. */
export function rememberLegs(owner: string, legs: Record<string, unknown[]>, now = Date.now()): void {
  const { wallets } = load();
  const legsKept = { ...wallets[owner]?.legs };
  for (const [key, rows] of Object.entries(legs)) legsKept[key] = { at: now, rows };
  wallets[owner] = { at: now, legs: legsKept };
  const byAge = Object.keys(wallets).sort((a, b) => (wallets[b]!.at || 0) - (wallets[a]!.at || 0));
  for (const gone of byAge.slice(WALLETS_KEPT)) delete wallets[gone];
  safeSetItem(BOARD_MEMORY_KEY, JSON.stringify({ ts: now, wallets }));
}

// A kept row is drawn as the board draws a read one, so a row of another shape (an older build's,
// or an edited entry) is not drawn at all, and the part reads as it did before.
const str = (v: unknown) => typeof v === 'string';
const strOrNull = (v: unknown) => v === null || typeof v === 'string';
const chainOk = (v: unknown) => v === 'solana' || v === 'ethereum' || v === 'base';
// A worth is read or plainly not: a row kept before rows had one (undefined) is not drawn as $0.
const usdOk = (v: unknown) => v === null || (typeof v === 'number' && Number.isFinite(v));
// Rows open rooms on this site only.
const pathOk = (v: unknown) => typeof v === 'string' && v.startsWith('/') && !v.startsWith('//');

export function isHoldingRow(r: unknown): r is HoldingRow {
  const o = r as Partial<HoldingRow> | null;
  return !!o && str(o.key) && str(o.symbol) && chainOk(o.chain) && str(o.amount) && usdOk(o.usd)
    && strOrNull(o.roomId) && (o.to === null || pathOk(o.to));
}

export function isPositionRow(r: unknown): r is PositionRow {
  const o = r as Partial<PositionRow> | null;
  return !!o && str(o.key) && strOrNull(o.roomId) && chainOk(o.chain) && str(o.title)
    && Array.isArray(o.facts) && o.facts.every(str) && usdOk(o.usd) && pathOk(o.to);
}
