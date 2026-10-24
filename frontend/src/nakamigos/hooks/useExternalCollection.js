import { useCallback, useEffect, useRef, useState } from "react";
import { fetchExternalItems, fetchExternalStats, readsMarket } from "../lib/externalMarket";

// Stats and items for a view-only collection, as two small state machines:
//   stats: loading | ready | unavailable
//   items: loading | ready | empty | partial | unavailable
// "empty" is reachable only from a successful read that returned nothing, and
// "partial" means some pages read and a later one failed, so the count is a
// lower bound. `dropped` counts rows the market returned that failed
// validation. A retry never asks sooner than the market's own Retry-After.
// A collection with no market read (Junglets) is "unavailable", reason
// "no-market-read", from the first render, and nothing is asked.

const MAX_PAGES = 10;
const NO_READ_STATS = Object.freeze({ status: "unavailable", reason: "no-market-read" });
const NO_READ_ITEMS = Object.freeze({ status: "unavailable", reason: "no-market-read", list: [], dropped: 0, source: null, retryAt: null });

function retryAtFrom(result) {
  const secs = Number(result?.retryAfter);
  return Number.isFinite(secs) && secs > 0 ? Date.now() + secs * 1000 : null;
}

export default function useExternalCollection(collection) {
  const [stats, setStats] = useState({ status: "loading" });
  const [items, setItems] = useState({ status: "loading", list: [] });
  const [attempt, setAttempt] = useState(0);
  const retryAtRef = useRef(null);
  const reads = readsMarket(collection);

  useEffect(() => {
    if (!reads) return undefined;
    let cancelled = false;
    setStats({ status: "loading" });
    fetchExternalStats(collection).then((result) => {
      if (cancelled) return;
      setStats(result?.unavailable
        ? { status: "unavailable", reason: result.reason }
        : { status: "ready", data: result });
    });
    return () => { cancelled = true; };
  }, [collection, reads]);

  useEffect(() => {
    if (!reads) return undefined;
    let cancelled = false;
    setItems({ status: "loading", list: [] });
    (async () => {
      const list = [];
      let dropped = 0;
      let cursor = null;
      let source = null;
      for (let page = 0; page < MAX_PAGES; page++) {
        const result = await fetchExternalItems(collection, cursor);
        if (cancelled) return;
        if (result?.unavailable) {
          retryAtRef.current = retryAtFrom(result);
          setItems({
            status: list.length > 0 ? "partial" : "unavailable",
            list,
            dropped,
            source,
            reason: result.reason,
            retryAt: retryAtRef.current,
          });
          return;
        }
        source = result.source;
        list.push(...result.items);
        dropped += result.dropped || 0;
        cursor = result.next;
        if (!cursor) break;
      }
      retryAtRef.current = null;
      if (cursor) {
        // More pages than this view reads: say so rather than call it whole.
        setItems({ status: "partial", list, dropped, source, reason: "page-limit", retryAt: null });
        return;
      }
      setItems({ status: list.length > 0 ? "ready" : "empty", list, dropped, source });
    })();
    return () => { cancelled = true; };
  }, [collection, attempt, reads]);

  const retry = useCallback(() => {
    if (retryAtRef.current && Date.now() < retryAtRef.current) return;
    setAttempt((n) => n + 1);
  }, []);

  if (!reads) return { stats: NO_READ_STATS, items: NO_READ_ITEMS, retry };
  return { stats, items, retry };
}
