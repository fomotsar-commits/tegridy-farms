import { useState, useEffect, useRef, useCallback } from "react";
import { fetchUnreadCount } from "../lib/dm";

const POLL_MS = 60_000; // header badge — light cadence, cosmetic data

/**
 * Global unread-DM badge: polls the total unread count once a minute while
 * the tab is visible and fires `onNew` when the count rises (so the app can
 * toast). Silently stays at 0 pre-SIWE / pre-migration — the badge should
 * never nag about a feature the user can't reach yet.
 */
export default function useDmUnread(wallet, { onNew } = {}) {
  const [unread, setUnread] = useState(0);
  const prevRef = useRef(0);
  const firstLoadRef = useRef(true);
  const onNewRef = useRef(onNew);
  onNewRef.current = onNew;

  const refresh = useCallback(async () => {
    if (!wallet) { setUnread(0); prevRef.current = 0; firstLoadRef.current = true; return; }
    const count = await fetchUnreadCount(wallet); // never throws
    setUnread(count);
    // Only announce INCREASES after the initial load — existing unread on
    // page load shows in the badge without a toast.
    if (!firstLoadRef.current && count > prevRef.current) onNewRef.current?.(count);
    firstLoadRef.current = false;
    prevRef.current = count;
  }, [wallet]);

  useEffect(() => {
    refresh();
    const t = setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  return { unread, refresh };
}
