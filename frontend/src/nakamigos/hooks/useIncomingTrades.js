import { useState, useEffect, useRef, useCallback } from "react";
import { fetchTrades } from "../lib/trades";

const POLL_MS = 60_000; // nav badge — light cadence, cosmetic data (mirrors useDmUnread)

/**
 * Pure count of genuinely-pending INCOMING trade offers (someone proposed a
 * swap TO this wallet). Exported for unit tests — no wallet, no network.
 *
 * The orderbook's `status: "active"` filter can still hand back rows whose
 * `expires_at` is in the past (the panel renders those as "expired"), so the
 * badge filters them out to avoid nagging about offers the user can no longer
 * act on. Rows without an `expires_at` are counted (no expiry to fail).
 *
 * @param {Array<{status?:string, expires_at?:string}>} rows
 * @param {number} nowMs
 * @returns {number}
 */
export function countPendingIncoming(rows, nowMs = Date.now()) {
  if (!Array.isArray(rows)) return 0;
  return rows.reduce((n, t) => {
    if (!t || t.status !== "active") return n;
    if (t.expires_at && new Date(t.expires_at).getTime() <= nowMs) return n;
    return n + 1;
  }, 0);
}

/**
 * Global nav badge: the number of active, unexpired trade offers sent to the
 * connected wallet. Polls once a minute while the tab is visible (T8 gate) and
 * reuses the existing public `fetchTrades` read — no new always-on loop, no
 * auth required (the orderbook scopes the read by the `wallet` query param, so
 * a signed-out user simply sees their own incoming offers or, if the read
 * fails, no badge). Silently stays at 0 with no wallet — the badge should
 * never nag about a feature the user can't reach yet (mirrors useDmUnread).
 *
 * @param {string|undefined} wallet
 * @returns {{ count: number, refresh: () => Promise<void> }}
 */
export default function useIncomingTrades(wallet) {
  const [count, setCount] = useState(0);

  const refresh = useCallback(async () => {
    if (!wallet) { setCount(0); return; }
    // fetchTrades never throws — it returns { trades: [], error } on failure,
    // so a dropped /api/orderbook poll degrades to no badge rather than erroring.
    const { trades } = await fetchTrades({ wallet, role: "incoming", status: "active" });
    setCount(countPendingIncoming(trades));
  }, [wallet]);

  useEffect(() => {
    refresh();
    const t = setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  return { count, refresh };
}
