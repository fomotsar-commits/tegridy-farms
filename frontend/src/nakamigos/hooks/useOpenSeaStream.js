import { useEffect, useRef, useCallback, useReducer } from "react";
import { OpenSeaStreamClient, Network } from "@opensea/stream-js";
import { normalizeOpenSeaEvent } from "../lib/eventFeed";

const OS_API_KEY = import.meta.env.VITE_OPENSEA_API_KEY;

// 60-second TTL deduplication window
const DEDUP_TTL_MS = 60_000;

const EMPTY = { listings: [], sales: [], bids: [], cancellations: [], connected: false };

const CATEGORY_MAP = {
  listing: "listings",
  sale: "sales",
  bid: "bids",
  cancellation: "cancellations",
};

function eventsReducer(state, action) {
  switch (action.type) {
    case "reset":
      return EMPTY;
    case "push": {
      const { category, event } = action;
      const prev = state[category];
      return { ...state, [category]: [event, ...prev].slice(0, 100) };
    }
    case "set_connected":
      return state.connected === action.value ? state : { ...state, connected: action.value };
    default:
      return state;
  }
}

/**
 * useOpenSeaStream — subscribes to real-time OpenSea marketplace events
 * for the given collection slug.
 *
 * Returns { listings, sales, bids, cancellations, isConnected }
 *
 * Events are deduplicated via a Map with 60s TTL so rapid re-broadcasts
 * from the OpenSea Stream API are suppressed.
 */
export default function useOpenSeaStream(collectionSlug) {
  const [events, dispatch] = useReducer(eventsReducer, EMPTY);

  const clientRef = useRef(null);
  const unsubsRef = useRef([]);
  const mountedRef = useRef(true);
  const dedupRef = useRef(new Map());

  // Periodic cleanup of expired dedup entries
  useEffect(() => {
    const iv = setInterval(() => {
      const now = Date.now();
      const map = dedupRef.current;
      for (const [key, ts] of map) {
        if (now - ts > DEDUP_TTL_MS) map.delete(key);
      }
    }, DEDUP_TTL_MS);
    return () => clearInterval(iv);
  }, []);

  const isDuplicate = useCallback((eventKey) => {
    const map = dedupRef.current;
    if (map.has(eventKey)) return true;
    map.set(eventKey, Date.now());
    return false;
  }, []);

  const pushEvent = useCallback((eventType, rawEvent) => {
    if (!mountedRef.current) return;

    const payload = rawEvent?.payload;
    if (!payload) return;

    const normalized = normalizeOpenSeaEvent(eventType, payload);
    if (!normalized) return;

    const dedupKey = `${normalized.hash}-${normalized.token.id}`;
    if (isDuplicate(dedupKey)) return;

    const category = CATEGORY_MAP[normalized.type];
    if (category) {
      dispatch({ type: "push", category, event: normalized });
    }
  }, [isDuplicate]);

  useEffect(() => {
    mountedRef.current = true;
    dispatch({ type: "reset" });
    dispatch({ type: "set_connected", value: false });
    dedupRef.current.clear();

    if (!OS_API_KEY || !collectionSlug) {
      return;
    }

    // Track whether we've received at least one event (= connected)
    let connected = false;

    // Create the client
    const client = new OpenSeaStreamClient({
      network: Network.MAINNET,
      token: OS_API_KEY,
      onError: (err) => {
        console.warn("useOpenSeaStream: error", err);
        if (mountedRef.current) dispatch({ type: "set_connected", value: false });
        connected = false;
      },
      onEvent: () => {
        // Mark connected on first event received
        if (!connected && mountedRef.current) {
          connected = true;
          dispatch({ type: "set_connected", value: true });
        }
        return true; // allow event to propagate to subscribers
      },
    });

    clientRef.current = client;
    client.connect();

    // Subscribe to the four event types
    const unsubs = [];

    unsubs.push(
      client.onItemListed(collectionSlug, (event) =>
        pushEvent("item_listed", event)
      )
    );

    unsubs.push(
      client.onItemSold(collectionSlug, (event) =>
        pushEvent("item_sold", event)
      )
    );

    unsubs.push(
      client.onItemReceivedBid(collectionSlug, (event) =>
        pushEvent("item_received_bid", event)
      )
    );

    unsubs.push(
      client.onItemCancelled(collectionSlug, (event) =>
        pushEvent("item_cancelled", event)
      )
    );

    unsubsRef.current = unsubs;

    return () => {
      mountedRef.current = false;

      // Unsubscribe all handlers
      for (const unsub of unsubsRef.current) {
        try { unsub(); } catch { /* ignore */ }
      }
      unsubsRef.current = [];

      // Disconnect client
      try {
        client.disconnect();
      } catch { /* ignore */ }
      clientRef.current = null;
    };
  }, [collectionSlug, pushEvent]);

  // Pause/resume on visibility change to save API quota
  useEffect(() => {
    function handleVisibility() {
      if (!clientRef.current) return;

      if (document.hidden) {
        try { clientRef.current.disconnect(); } catch { /* ignore */ }
        if (mountedRef.current) dispatch({ type: "set_connected", value: false });
      } else {
        try { clientRef.current.connect(); } catch { /* ignore */ }
        if (mountedRef.current) dispatch({ type: "set_connected", value: true });
      }
    }

    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, []);

  return {
    listings: events.listings,
    sales: events.sales,
    bids: events.bids,
    cancellations: events.cancellations,
    isConnected: events.connected,
  };
}
