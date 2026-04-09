/**
 * eventFeed.js — Unified event normalizer
 *
 * Combines OpenSea Stream events and Alchemy WebSocket transfer events
 * into a single NormalizedEvent shape consumed by the activity feed.
 *
 * NormalizedEvent:
 * {
 *   type:        "listing" | "sale" | "bid" | "cancellation" | "transfer"
 *   token:       { id: string, name: string }
 *   price:       number | null          (ETH)
 *   from:        string | null          (shortened address)
 *   to:          string | null          (shortened address)
 *   fromFull:    string | null          (full address)
 *   toFull:      string | null          (full address)
 *   time:        number                 (unix ms)
 *   marketplace: string | null          (e.g. "opensea")
 *   hash:        string | null          (tx hash or event hash)
 *   _live:       boolean                (true = arrived via real-time stream)
 *   _source:     "opensea" | "alchemy"  (origin stream)
 * }
 */

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

function extractTokenId(payload) {
  // OpenSea payload stores token id in different locations depending on event
  return (
    payload?.item?.nft_id?.split("/").pop() ??
    payload?.item?.token_id ??
    payload?.token_id ??
    null
  );
}

function extractMaker(payload) {
  return payload?.maker?.address ?? payload?.from_account?.address ?? null;
}

function extractTaker(payload) {
  return payload?.taker?.address ?? payload?.to_account?.address ?? null;
}

// ---- OpenSea Stream event mapping -------------------------------------------

const OS_EVENT_TYPE_MAP = {
  "item_listed":       "listing",
  "item_sold":         "sale",
  "item_received_bid": "bid",
  "item_cancelled":    "cancellation",
};

/**
 * Normalize a raw OpenSea Stream event into a NormalizedEvent.
 * @param {string} eventType  One of the OS_EVENT_TYPE_MAP keys
 * @param {object} payload    Raw payload from @opensea/stream-js
 * @returns {object|null}     NormalizedEvent or null if unparseable
 */
export function normalizeOpenSeaEvent(eventType, payload) {
  const type = OS_EVENT_TYPE_MAP[eventType];
  if (!type) return null;

  const tokenId = extractTokenId(payload);
  if (tokenId == null) return null;

  const maker = extractMaker(payload);
  const taker = extractTaker(payload);

  // Price lives in different spots per event type
  const ethPrice =
    payload?.base_price != null
      ? weiToEth(payload.base_price)
      : payload?.sale_price != null
        ? weiToEth(payload.sale_price)
        : payload?.bid_amount != null
          ? weiToEth(payload.bid_amount)
          : null;

  const eventHash =
    payload?.order_hash ??
    payload?.transaction?.hash ??
    `os-${eventType}-${tokenId}-${Date.now()}`;

  return {
    type,
    token: { id: tokenId, name: `#${tokenId}` },
    price: ethPrice,
    from: shortenAddr(maker),
    to: shortenAddr(taker),
    fromFull: maker,
    toFull: taker,
    time: payload?.event_timestamp
      ? new Date(payload.event_timestamp).getTime()
      : Date.now(),
    marketplace: "opensea",
    hash: eventHash,
    _live: true,
    _source: "opensea",
  };
}

/**
 * Tag an existing Alchemy transfer event with _source metadata.
 * The hook already produces the right shape — we just stamp it.
 */
export function tagAlchemyEvent(event) {
  if (!event) return event;
  return { ...event, _source: "alchemy" };
}

/**
 * Merge two sorted-by-time-descending event arrays, deduplicating by
 * hash+tokenId composite key.
 *
 * @param {Array} a  First event list (e.g. OpenSea events)
 * @param {Array} b  Second event list (e.g. Alchemy events)
 * @param {number} cap  Max returned items
 * @returns {Array}  Merged, deduplicated, capped
 */
export function mergeEventStreams(a, b, cap = 200) {
  const seen = new Set();
  const merged = [];

  for (const event of [...a, ...b]) {
    const key = `${event.hash}-${event.token?.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(event);
  }

  // Sort newest-first
  merged.sort((x, y) => (y.time || 0) - (x.time || 0));

  return merged.slice(0, cap);
}
