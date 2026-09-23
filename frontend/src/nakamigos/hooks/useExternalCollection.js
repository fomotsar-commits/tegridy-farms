import { useCallback, useEffect, useRef, useState } from "react";
import { fetchExternalItems, fetchExternalStats } from "../lib/externalMarket";

// Stats and items for a view-only collection, as two small state machines:
//   stats: loading | ready | unavailable
//   items: loading | ready | empty | partial | unavailable
// "empty" is reachable only from a successful read that returned nothing, and
// "partial" means some pages read and a later one failed, so the count is a
// lower bound. A retry never asks sooner than the market's own Retry-After.

const MAX_PAGES = 10;

function retryAtFrom(result) {
  const secs = Number(result?.retryAfter);
  return Number.isFinite(secs) && secs > 0 ? Date.now() + secs * 1000 : null;
}

export default function useExternalCollection(collection) {
  const [stats, setStats] = useState({ status: "loading" });
  const [items, setItems] = useState({ status: "loading", list: [] });
  const [attempt, setAttempt] = useState(0);
  const retryAtRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    setStats({ status: "loading" });
    fetchExternalStats(collection).then((result) => {
      if (cancelled) return;
      setStats(result?.unavailable
        ? { status: "unavailable", reason: result.reason }
        : { status: "ready", data: result });
    });
    return () => { cancelled = true; };
  }, [collection]);

  useEffect(() => {
    let cancelled = false;
    setItems({ status: "loading", list: [] });
    (async () => {
      const list = [];
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
            source,
            reason: result.reason,
            retryAt: retryAtRef.current,
          });
          return;
        }
        source = result.source;
        list.push(...result.items);
        cursor = result.next;
        if (!cursor) break;
      }
      retryAtRef.current = null;
      if (cursor) {
        // More pages than this view reads: say so rather than call it whole.
        setItems({ status: "partial", list, source, reason: "page-limit", retryAt: null });
        return;
      }
      setItems({ status: list.length > 0 ? "ready" : "empty", list, source });
    })();
    return () => { cancelled = true; };
  }, [collection, attempt]);

  const retry = useCallback(() => {
    if (retryAtRef.current && Date.now() < retryAtRef.current) return;
    setAttempt((n) => n + 1);
  }, []);

  return { stats, items, retry };
}
