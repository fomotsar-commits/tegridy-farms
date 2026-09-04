import { useCallback, useEffect, useRef, useState } from 'react';
import { usePublicClient } from 'wagmi';
import {
  isTokenTxRow,
  readExplorerPage,
  type ExplorerAction,
  type ExplorerFailureReason,
  type TokenTxRow,
  type TxRecord,
} from '../lib/txHistory';
import { buildLedger, type LedgerTruncation, type WalletLedger } from '../lib/tax/ledger';

// Reading one wallet's Ethereum-mainnet history through the explorer proxy this
// deployment already ships.
//
// ─── THE HEAD IS READ FIRST, AND A FAILED HEAD STOPS EVERYTHING ─────────────
//
// Twelve requests spread over a few seconds are twelve requests against a
// MOVING chain. Without a pinned upper bound, a block mined between page 1 and
// page 2 shifts every row down by one and a transaction slides through the seam
// — silently, and in the direction that produces a report missing a sale. So
// the latest block is read first over the app's own RPC and its number becomes
// `endblock` on every subsequent call. If that read fails there is no window to
// pin, and the ledger read is NOT attempted: a read with no consistent frame is
// worse than no read, because it looks like one.
//
// That block's TIMESTAMP is also the report's as-of. Not `Date.now()` — the
// question a coverage statement answers is "how far had the chain got when this
// was read", and only the chain can answer it.
//
// ─── FAIL CLOSED, ALWAYS ────────────────────────────────────────────────────
//
// A 429, a 5xx or an unreadable body on ANY page fails the WHOLE read. The
// alternative — keeping the pages that succeeded — produces a ledger that is
// short by an unknown amount with no way to say by how much, which is precisely
// the "quietly drops six weeks" failure the whole /tax surface exists to
// refuse. The read is either a window this venue can describe, or it is nothing.
//
// ─── NO CACHE ───────────────────────────────────────────────────────────────
//
// The ledger lives in hook state for the session and is never persisted.
// Thousands of rows would blow the storage budget, but the real reason is that
// a cached ledger renders under a FRESH head: the page would claim to have read
// history up to a block whose rows it never saw.

/** Pages per list. 4 x 500 = 2,000 rows; beyond that the read declares a cut. */
export const MAX_LEDGER_PAGES = 4;

/**
 * Seconds between reads of the same wallet.
 *
 * api/etherscan.js throttles to 30 req/min per IP and that budget is shared
 * with /history, /deployer and the verification badges. One full read is up to
 * 12 calls, so an un-cooled re-read button is a way for one impatient visitor
 * to lock every explorer-backed surface on the site out for a minute.
 */
export const RELOAD_COOLDOWN_SECONDS = 60;

const ACTIONS: readonly ExplorerAction[] = ['txlist', 'txlistinternal', 'tokentx'];

export interface LedgerHead {
  block: bigint;
  /** Unix seconds, from the block itself. */
  timestamp: number;
}

export type LedgerRead =
  | { status: 'idle' }
  | { status: 'loading'; action: ExplorerAction; page: number }
  | {
      status: 'ready';
      ledger: WalletLedger;
      head: LedgerHead;
      pagesRead: Record<ExplorerAction, number>;
      rowCounts: Record<ExplorerAction, number>;
    }
  | { status: 'failed'; reason: 'head-unavailable' | ExplorerFailureReason; detail: string };

export interface UseWalletLedgerOptions {
  address: `0x${string}` | null;
  enabled?: boolean;
}

export interface UseWalletLedgerState {
  read: LedgerRead;
  reload: () => void;
  /** Epoch ms the next read is allowed at, or null when one is allowed now. */
  nextReloadAt: number | null;
  /** Whole seconds left on that cooldown. 0 when a read is allowed. */
  cooldownSeconds: number;
}

const HEAD_FAILED_DETAIL =
  'The chain head could not be read over this app’s RPC, so no history window could be pinned and ' +
  'nothing was read. Nothing was concluded — try again.';

export function useWalletLedger(opts: UseWalletLedgerOptions): UseWalletLedgerState {
  const { address, enabled = true } = opts;
  const client = usePublicClient({ chainId: 1 });
  const [read, setRead] = useState<LedgerRead>({ status: 'idle' });
  const [nonce, setNonce] = useState(0);
  const [nextReloadAt, setNextReloadAt] = useState<number | null>(null);
  const [cooldownSeconds, setCooldownSeconds] = useState(0);
  // Per-wallet, so connecting a different wallet is never blocked by the
  // previous one's cooldown — the quota concern is repeated reads of the SAME
  // history, not a visitor switching accounts.
  const cooledWallet = useRef<string | null>(null);

  useEffect(() => {
    // Checked here rather than through a derived boolean so TypeScript narrows
    // `client` for the read below; a derived flag would need a non-null
    // assertion, and an assertion is exactly the thing that is wrong when the
    // RPC is genuinely absent.
    if (!enabled || address === null || client === undefined) {
      setRead({ status: 'idle' });
      return;
    }
    const controller = new AbortController();
    let cancelled = false;

    void (async () => {
      setRead({ status: 'loading', action: 'txlist', page: 1 });
      let head: LedgerHead;
      try {
        const block = await client.getBlock({ blockTag: 'latest' });
        head = { block: block.number ?? 0n, timestamp: Number(block.timestamp) };
      } catch {
        if (!cancelled) setRead({ status: 'failed', reason: 'head-unavailable', detail: HEAD_FAILED_DETAIL });
        return;
      }
      if (cancelled) return;

      const txlist: TxRecord[] = [];
      const internal: TxRecord[] = [];
      const tokentx: TokenTxRow[] = [];
      const truncated: LedgerTruncation[] = [];
      const pagesRead: Record<ExplorerAction, number> = { txlist: 0, txlistinternal: 0, tokentx: 0 };
      const rowCounts: Record<ExplorerAction, number> = { txlist: 0, txlistinternal: 0, tokentx: 0 };
      let unreadRows = 0;

      for (const action of ACTIONS) {
        // Oldest row seen in THIS list, tracked per list because the lists
        // truncate independently and the cut is derived from the ones that did.
        let oldestRowAt: number | null = null;
        for (let page = 1; page <= MAX_LEDGER_PAGES; page++) {
          if (cancelled) return;
          setRead({ status: 'loading', action, page });
          const result = await readExplorerPage(action, address, page, controller.signal, head.block);
          if (cancelled) return;
          if (result.kind === 'failed') {
            setRead({ status: 'failed', reason: result.reason, detail: result.detail });
            return;
          }
          pagesRead[action] = page;
          if (result.kind === 'empty') break;

          // The boundary comes off the RAW page, not off the rows that
          // validated: a page whose rows all failed the schema still proves
          // history exists behind it, and deriving the cut from the survivors
          // would end the read claiming there was nothing older.
          if (result.oldestRawAt !== null && (oldestRowAt === null || result.oldestRawAt < oldestRowAt)) {
            oldestRowAt = result.oldestRawAt;
          }
          for (const row of result.rows) {
            if (isTokenTxRow(row)) tokentx.push(row);
            else if (action === 'txlistinternal') internal.push(row);
            else txlist.push(row);
          }
          rowCounts[action] += result.rows.length;
          unreadRows += result.dropped;

          if (!result.full) break;
          if (page === MAX_LEDGER_PAGES && oldestRowAt !== null) {
            truncated.push({ action, oldestRowAt });
          }
        }
      }

      if (cancelled) return;
      const ledger = buildLedger({ wallet: address, txlist, internal, tokentx, truncated, unreadRows });
      setRead({ status: 'ready', ledger, head, pagesRead, rowCounts });
      cooledWallet.current = address.toLowerCase();
      setNextReloadAt(Date.now() + RELOAD_COOLDOWN_SECONDS * 1000);
      setCooldownSeconds(RELOAD_COOLDOWN_SECONDS);
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
    // `client` is memoised by wagmi per chain, so this runs on a wallet change
    // or an explicit reload, not on every render.
  }, [enabled, address, client, nonce]);

  // A wallet change clears the previous wallet's cooldown: the button is about
  // this wallet's quota, and inheriting a stale countdown would read as the app
  // refusing to look at an account it has never looked at.
  useEffect(() => {
    if (address === null) return;
    if (cooledWallet.current !== null && cooledWallet.current !== address.toLowerCase()) {
      cooledWallet.current = null;
      setNextReloadAt(null);
      setCooldownSeconds(0);
    }
  }, [address]);

  useEffect(() => {
    if (nextReloadAt === null) return;
    const tick = () => {
      const left = Math.max(0, Math.ceil((nextReloadAt - Date.now()) / 1000));
      setCooldownSeconds(left);
      if (left === 0) setNextReloadAt(null);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [nextReloadAt]);

  const reload = useCallback(() => {
    if (nextReloadAt !== null && Date.now() < nextReloadAt) return;
    setNonce((n) => n + 1);
  }, [nextReloadAt]);

  return { read, reload, nextReloadAt, cooldownSeconds };
}
