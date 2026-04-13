import { useEffect, useRef, useCallback, useReducer } from "react";

// Polling interval for OpenSea events (15 seconds — matches proxy cache TTL)
const POLL_INTERVAL_MS = 15_000;

// 60-second TTL deduplication window
const DEDUP_TTL_MS = 60_000;

const EMPTY = { listings: [], sales: [], bids: [], cancellations: [], connected: false };

const CATEGORY_MAP = {
  listing: "listings",
  sale: "sales",
  bid: "bids",
  cancellation: "cancellations",
};

// Map OpenSea REST API event_type strings to our internal types
const REST_EVENT_TYPE_MAP = {
  listing: "listing",
  sale: "sale",
  offer: "bid",
  cancel: "cancellation",
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

// ---- helpers ----------------------------------------------------------------

function shortenAddr(addr) {
  if (!addr || addr.length < 10) return addr || null;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function weiToEth(wei) {
  if (!wei) return null;
  try {
    const n = Number(wei) / 1e18;
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * Normalize a single event from the OpenSea REST events API into our
 * NormalizedEvent shape. The REST API returns a different structure than
 * the Stream SDK, so we handle both field layouts.
 */
function normalizeRestEvent(event) {
  const eventType = event.event_type;
  const type = REST_EVENT_TYPE_MAP[eventType];
  if (!type) return null;

  // Token ID: REST API nests under nft.identifier or nft.token_id
  const tokenId =
    event.nft?.identifier ??
    event.nft?.token_id ??
    event.item?.nft_id?.split("/").pop() ??
    null;
  if (tokenId == null) return null;

  // Addresses
  const maker = event.seller ?? event.maker ?? event.from_account?.address ?? null;
  const taker = event.buyer ?? event.taker ?? event.winner_account?.address ?? event.to_account?.address ?? null;

  // Price: REST API uses payment.quantity (wei string) or base_price
  let ethPrice = null;
  if (event.payment?.quantity) {
    const decimals = event.payment.decimals ?? 18;
    ethPrice = Number(event.payment.quantity) / Math.pow(10, decimals);
    if (!Number.isFinite(ethPrice)) ethPrice = null;
  } else if (event.base_price != null) {
    ethPrice = weiToEth(event.base_price);
  } else if (event.sale_price != null) {
    ethPrice = weiToEth(event.sale_price);
  } else if (event.bid_amount != null) {
    ethPrice = weiToEth(event.bid_amount);
  }

  const eventHash =
    event.order_hash ??
    event.transaction?.hash ??
    `os-rest-${eventType}-${tokenId}-${event.event_timestamp || Date.now()}`;

  return {
    type,
    token: { id: tokenId, name: `#${tokenId}` },
    price: ethPrice,
    from: shortenAddr(maker),
    to: shortenAddr(taker),
    fromFull: maker,
    toFull: taker,
    time: event.event_timestamp
      ? new Date(event.event_timestamp).getTime()
      : event.closing_date
        ? new Date(event.closing_date).getTime()
        : Date.now(),
    marketplace: "opensea",
    hash: eventHash,
    _live: true,
    _source: "opensea",
  };
}

/**
 * useOpenSeaStream — polls OpenSea events for a collection via the
 * server-side /api/opensea proxy. API key stays server-side.
 *
 * Returns { listings, sales, bids, cancellations, isConnected }
 *
 * Events are deduplicated via a Map with 60s TTL so duplicate events
 * from overlapping poll windows are suppressed.
 */
export default function useOpenSeaStream(collectionSlug) {
  const [events, dispatch] = useReducer(eventsReducer, EMPTY);

  const mountedRef = useRef(true);
  const dedupRef = useRef(new Map());
  const intervalRef = useRef(null);
  // Track the latest event timestamp so we only fetch newer events
  const cursorRef = useRef(null);

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

  const poll = useCallback(async (signal) => {
    if (!collectionSlug) return;

    try {
      // Build the request to the existing OpenSea proxy
      const url = new URL("/api/opensea", window.location.origin);
      url.searchParams.set("path", `events/collection/${collectionSlug}`);
      // Only fetch events from after our cursor to minimize duplicates
      if (cursorRef.current) {
        url.searchParams.set("after", cursorRef.current);
      }
      url.searchParams.set("limit", "50");

      const res = await fetch(url.toString(), {
        headers: { Accept: "application/json" },
        signal,
      });

      if (!res.ok) {
        throw new Error(`OpenSea events poll failed: ${res.status}`);
      }

      const data = await res.json();
      if (!mountedRef.current) return;

      const eventList = data.asset_events || data.results || [];

      // Update cursor to the newest event timestamp for next poll
      if (eventList.length > 0) {
        const newestTimestamp =
          eventList[0]?.event_timestamp || eventList[0]?.created_date;
        if (newestTimestamp) {
          cursorRef.current = Math.floor(
            new Date(newestTimestamp).getTime() / 1000
          );
        }
      }

      for (const rawEvent of eventList) {
        const normalized = normalizeRestEvent(rawEvent);
        if (!normalized) continue;

        const dedupKey = `${normalized.hash}-${normalized.token.id}`;
        if (isDuplicate(dedupKey)) continue;

        const category = CATEGORY_MAP[normalized.type];
        if (category) {
          dispatch({ type: "push", category, event: normalized });
        }
      }

      if (mountedRef.current) {
        dispatch({ type: "set_connected", value: true });
      }
    } catch (err) {
      if (err.name === "AbortError") return;
      console.warn("useOpenSeaStream: poll error:", err);
      if (mountedRef.current) {
        dispatch({ type: "set_connected", value: false });
      }
    }
  }, [collectionSlug, isDuplicate]);

  useEffect(() => {
    mountedRef.current = true;
    dispatch({ type: "reset" });
    dispatch({ type: "set_connected", value: false });
    dedupRef.current.clear();
    cursorRef.current = null;

    if (!collectionSlug) return;

    const controller = new AbortController();

    // Initial poll
    poll(controller.signal);

    // Set up recurring poll
    intervalRef.current = setInterval(() => {
      if (mountedRef.current && !document.hidden) {
        poll(controller.signal);
      }
    }, POLL_INTERVAL_MS);

    return () => {
      mountedRef.current = false;
      controller.abort();
      clearInterval(intervalRef.current);
    };
  }, [collectionSlug, poll]);

  // Resume polling immediately when tab becomes visible
  useEffect(() => {
    function handleVisibility() {
      if (!document.hidden && mountedRef.current && collectionSlug) {
        poll(new AbortController().signal);
      }
    }

    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [collectionSlug, poll]);

  return {
    listings: events.listings,
    sales: events.sales,
    bids: events.bids,
    cancellations: events.cancellations,
    isConnected: events.connected,
  };
}
