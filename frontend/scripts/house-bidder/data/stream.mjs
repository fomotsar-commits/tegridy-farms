/**
 * OpenSea Stream for the house bidder (BUILD-SPEC 2.4 / 3.4.2): the Phoenix channel protocol from
 * OpenSea's docs (state-of-art/raw/osdocs-stream-real-time-events.md), on Node's built-in WebSocket.
 *
 *  - One topic per collection, `collection:<slug>`, joined with `phx_join` after every (re)connect.
 *  - A heartbeat `[null, ref, "phoenix", "heartbeat", {}]` every 30 s. If the previous heartbeat has
 *    no reply by the time the next is due, the connection is treated as dead and replaced.
 *  - Reconnects back off from 1 s to 60 s with jitter, so a restart of OpenSea's side is not met by
 *    a synchronised stampede.
 *  - The stream is best effort with no replay (OpenSea's own words). So a `gap` event fires after
 *    every reconnect and after 30 s without a market message; the bot must not post a new bid until
 *    it has re-read listings over REST. Heartbeat replies prove the socket is alive (`lastAliveAt`),
 *    but they are not market messages and never reset the silence clock (`lastMessageAt`).
 *
 * Prices: OpenSea computes `base_price`/`sale_price` in floating point (a 0.0709 WETH bid arrives as
 * 70900000000000010; 46 of 2,112 item bids captured on 2026-11-16 were off like that). So `priceWei`
 * comes from the order's own `protocol_data` whenever the event carries it (`priceExact: true`), and
 * from `base_price` only as a labelled approximation otherwise. `priceWei` is per NFT: a collection
 * offer for 4 carries 4 units (and OpenSea's base_price is per unit too). The sales tape reads
 * REST sale events, whose amounts match the chain exactly, never these.
 *
 * Event shape: { type, slug, time, tokenId?, priceWei?, maker?, orderHash?, raw } plus, where known,
 * qty, priceExact, taker, from, to, txHash, contract, paymentToken, expiration. `time` is unix
 * seconds (OpenSea's event_timestamp); lastMessageAt()/lastAliveAt() are milliseconds from `now()`.
 *
 * The API key travels as the documented `token` query parameter, so the socket URL is never logged.
 */
import { isAddress, isDecimalString, isHash32, makeLog } from './util.mjs';

const ENDPOINT = 'wss://stream-api.opensea.io/socket/websocket';
const HEARTBEAT_MS = 30_000;
const SILENCE_MS = 30_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 60_000;
/** A connection that stayed up this long resets the backoff. */
const STABLE_MS = 30_000;
const OPEN = 1;

/** OpenSea's event names (stream-js src/types.ts) -> the bot's. Item-level bids are not passed on. */
const TYPE_OF = Object.freeze({
  item_listed: 'listed',
  item_sold: 'sold',
  item_cancelled: 'cancelled',
  item_transferred: 'transferred',
  item_metadata_updated: 'metadata',
  collection_offer: 'collection_offer',
  trait_offer: 'trait_offer',
  order_invalidate: 'invalidated',
  order_revalidate: 'revalidated',
});
export const STREAM_TYPES = Object.freeze(['listed', 'sold', 'cancelled', 'transferred', 'metadata', 'collection_offer', 'trait_offer', 'invalidated', 'revalidated', 'gap', 'open', 'close']);
/** Market events that keep the stream "talking" but that the bot never acts on (no tick-chasing). */
const QUIET_MARKET = new Set(['item_received_bid', 'item_received_offer']);

const lowerAddr = (v) => (isAddress(v) ? v.toLowerCase() : undefined);
const isoSec = (v) => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? Math.floor(t / 1000) : undefined;
};

/** Per-unit price and quantity from an order's own parameters, exact; null when they don't add up. */
function priceFromParameters(p) {
  if (!p || !Array.isArray(p.offer) || !Array.isArray(p.consideration)) return null;
  const nftOffered = p.offer.find((o) => o?.itemType >= 2);
  try {
    if (nftOffered) {
      // A listing: the buyer pays every ETH/ERC-20 consideration line.
      const qty = BigInt(nftOffered.startAmount);
      const total = p.consideration.filter((c) => c?.itemType === 0 || c?.itemType === 1).reduce((s, c) => s + BigInt(c.startAmount), 0n);
      if (qty <= 0n || total % qty !== 0n) return null;
      return { priceWei: total / qty, qty: Number(qty) };
    }
    // An offer: the bidder pays its ERC-20 offer lines for the NFTs it asks for.
    const nftWanted = p.consideration.find((c) => c?.itemType >= 2);
    if (!nftWanted) return null;
    const qty = BigInt(nftWanted.startAmount);
    const total = p.offer.filter((o) => o?.itemType === 1).reduce((s, o) => s + BigInt(o.startAmount), 0n);
    if (qty <= 0n || total % qty !== 0n) return null;
    return { priceWei: total / qty, qty: Number(qty) };
  } catch {
    return null;
  }
}

/**
 * One Phoenix frame -> a normalised market event, or null for anything that is not one (join and
 * heartbeat replies, malformed frames, item-level bids). Exported for the parser test.
 */
export function normalizeStreamFrame(frame) {
  if (!Array.isArray(frame) || frame.length !== 5) return null;
  const [, , topic, event, message] = frame;
  const type = TYPE_OF[event];
  if (!type || !message || typeof message !== 'object') return null;
  const p = message.payload;
  if (!p || typeof p !== 'object') return null;
  const slug = typeof p.collection?.slug === 'string' ? p.collection.slug : typeof topic === 'string' && topic.startsWith('collection:') ? topic.slice(11) : undefined;
  if (!slug) return null;
  const ev = { type, slug, time: isoSec(p.event_timestamp) ?? isoSec(message.sent_at), raw: message };
  const nftId = typeof p.item?.nft_id === 'string' ? p.item.nft_id.split('/') : null;
  if (nftId && nftId.length === 3 && isDecimalString(nftId[2])) {
    ev.tokenId = nftId[2];
    if (isAddress(nftId[1])) ev.contract = nftId[1].toLowerCase();
  } else if (isAddress(p.asset_contract_criteria?.address)) {
    ev.contract = p.asset_contract_criteria.address.toLowerCase();
  }
  const exact = priceFromParameters(p.protocol_data?.parameters);
  const shown = p.sale_price ?? p.base_price;
  if (exact) {
    ev.priceWei = exact.priceWei;
    ev.qty = exact.qty;
    ev.priceExact = true;
  } else if (isDecimalString(shown)) {
    ev.priceWei = BigInt(shown);
    ev.priceExact = false;
  }
  if (ev.qty === undefined && Number.isSafeInteger(p.quantity) && p.quantity > 0) ev.qty = p.quantity;
  const maker = lowerAddr(p.maker?.address);
  if (maker) ev.maker = maker;
  const taker = lowerAddr(p.taker?.address);
  if (taker) ev.taker = taker;
  if (isHash32(p.order_hash)) ev.orderHash = p.order_hash.toLowerCase();
  const from = lowerAddr(p.from_account?.address);
  if (from) ev.from = from;
  const to = lowerAddr(p.to_account?.address);
  if (to) ev.to = to;
  if (isHash32(p.transaction?.hash)) ev.txHash = p.transaction.hash.toLowerCase();
  const token = lowerAddr(p.payment_token?.address);
  if (token) ev.paymentToken = token;
  const expiration = isoSec(p.expiration_date);
  if (expiration !== undefined) ev.expiration = expiration;
  return ev;
}

const defaultTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h),
};

/**
 * @param {object} o
 * @param {string} o.apiKey
 * @param {string[]} o.slugs OpenSea collection slugs, one topic each
 * @param {typeof WebSocket} [o.WebSocketImpl] Node 24's global WebSocket by default
 * @param {() => number} [o.now] a millisecond clock
 * @param {*} [o.log]
 * @param {object} [o.timers] { setTimeout, clearTimeout, setInterval, clearInterval } (tests inject fakes)
 * @param {() => number} [o.random] jitter source in [0, 1)
 */
export function createStream({ apiKey, slugs, WebSocketImpl = globalThis.WebSocket, now = Date.now, log, timers = defaultTimers, random = Math.random } = {}) {
  if (typeof apiKey !== 'string' || apiKey.length < 8) throw new TypeError('an OpenSea API key is required');
  if (!Array.isArray(slugs) || !slugs.length || slugs.some((s) => typeof s !== 'string' || !/^[a-z0-9-]{1,50}$/.test(s))) {
    throw new TypeError('slugs must be a non-empty list of OpenSea collection slugs');
  }
  if (typeof WebSocketImpl !== 'function') throw new TypeError('no WebSocket implementation (Node 22+ has one built in)');
  const out = makeLog(log);
  const scrub = (s) => String(s).split(apiKey).join('<redacted>');
  const url = `${ENDPOINT}?token=${encodeURIComponent(apiKey)}&vsn=2.0.0`;
  const handlers = new Map(STREAM_TYPES.map((t) => [t, new Set()]));

  let ws = null;
  let started = false;
  let ref = 0;
  let openedAt = 0;
  let everOpened = false;
  let attempt = 0;
  let reconnects = 0;
  let pendingHeartbeat = null;
  let heartbeatTimer = null;
  let reconnectTimer = null;
  let silenceTimer = null;
  let lastMessageAt = 0;
  let lastAliveAt = 0;
  const joined = new Set();

  const nextRef = () => String(++ref);

  function emit(type, ev) {
    for (const h of handlers.get(type) ?? []) {
      try {
        h(ev);
      } catch (e) {
        // A handler that throws must not take the socket down or starve the other handlers.
        out.error(`stream handler for "${type}" threw: ${scrub(e?.message ?? e)}`);
      }
    }
  }
  const meta = (type, extra = {}) => ({ type, slug: null, time: Math.floor(now() / 1000), ...extra });

  function send(frame) {
    if (!ws || ws.readyState !== OPEN) return false;
    try {
      ws.send(JSON.stringify(frame));
      return true;
    } catch (e) {
      out.warn(`stream send failed: ${scrub(e?.message ?? e)}`);
      return false;
    }
  }

  function armSilence() {
    if (silenceTimer) timers.clearTimeout(silenceTimer);
    silenceTimer = timers.setTimeout(() => {
      silenceTimer = null;
      // Once per quiet spell: re-armed only by the next market message.
      emit('gap', meta('gap', { reason: 'silence', silentForMs: now() - (lastMessageAt || openedAt) }));
    }, SILENCE_MS);
  }

  function heartbeat() {
    if (pendingHeartbeat) {
      out.warn('stream heartbeat went unanswered for 30 s; reconnecting');
      replaceSocket('heartbeat timeout');
      return;
    }
    const r = nextRef();
    if (send([null, r, 'phoenix', 'heartbeat', {}])) pendingHeartbeat = r;
  }

  function clearConnectionTimers() {
    if (heartbeatTimer) timers.clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    pendingHeartbeat = null;
  }

  function onOpen() {
    openedAt = now();
    lastAliveAt = openedAt;
    joined.clear();
    const isReconnect = everOpened;
    everOpened = true;
    for (const slug of slugs) {
      const r = nextRef();
      send([r, r, `collection:${slug}`, 'phx_join', {}]);
    }
    clearConnectionTimers();
    heartbeatTimer = timers.setInterval(heartbeat, HEARTBEAT_MS);
    emit('open', meta('open', { reconnect: isReconnect }));
    if (isReconnect) emit('gap', meta('gap', { reason: 'reconnect' }));
    if (!silenceTimer) armSilence();
  }

  function onMessage(msg) {
    lastAliveAt = now();
    let frame;
    try {
      frame = JSON.parse(typeof msg?.data === 'string' ? msg.data : String(msg?.data));
    } catch {
      out.warn('stream frame was not JSON');
      return;
    }
    if (!Array.isArray(frame) || frame.length !== 5) return;
    const [, r, topic, event, payload] = frame;
    if (topic === 'phoenix') {
      if (event === 'phx_reply' && r === pendingHeartbeat) pendingHeartbeat = null;
      return;
    }
    if (event === 'phx_reply') {
      if (payload?.status === 'ok') joined.add(topic);
      else {
        out.warn(`OpenSea refused to join ${topic}; reconnecting`);
        replaceSocket('join refused');
      }
      return;
    }
    if (event === 'phx_error' || event === 'phx_close') {
      out.warn(`OpenSea closed the ${topic} channel (${event}); reconnecting`);
      replaceSocket(event);
      return;
    }
    // Everything else on a collection topic is a market message, acted on or not.
    lastMessageAt = now();
    armSilence();
    if (QUIET_MARKET.has(event)) return;
    const ev = normalizeStreamFrame(frame);
    if (ev) emit(ev.type, ev);
  }

  function scheduleReconnect() {
    if (!started || reconnectTimer) return;
    const span = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
    // Equal jitter: never less than half the span, so a server that drops us at once is not hammered.
    const delay = Math.floor(span / 2 + random() * (span / 2));
    attempt = Math.min(attempt + 1, 16);
    reconnectTimer = timers.setTimeout(() => {
      reconnectTimer = null;
      reconnects++;
      connect();
    }, delay);
  }

  function onClose(e) {
    clearConnectionTimers();
    joined.clear();
    if (openedAt && now() - openedAt >= STABLE_MS) attempt = 0;
    ws = null;
    emit('close', meta('close', { code: e?.code ?? null, reason: scrub(e?.reason ?? '') }));
    scheduleReconnect();
  }

  function replaceSocket(why) {
    const old = ws;
    if (!old) return;
    // Detach first: the old socket's late events must not touch the new one's state.
    old.onopen = old.onmessage = old.onerror = old.onclose = null;
    try {
      old.close(4000, why);
    } catch {
      // already closing
    }
    onClose({ code: 4000, reason: why });
  }

  function connect() {
    if (!started) return;
    let sock;
    try {
      sock = new WebSocketImpl(url);
    } catch (e) {
      out.warn(`stream could not open a socket: ${scrub(e?.message ?? e)}`);
      scheduleReconnect();
      return;
    }
    ws = sock;
    sock.onopen = () => {
      if (ws === sock) onOpen();
    };
    sock.onmessage = (m) => {
      if (ws === sock) onMessage(m);
    };
    sock.onerror = (e) => {
      if (ws === sock) out.warn(`stream socket error: ${scrub(e?.message ?? 'unknown')}`);
    };
    sock.onclose = (e) => {
      if (ws === sock) onClose(e);
    };
  }

  return {
    on(type, handler) {
      if (!handlers.has(type)) throw new TypeError(`unknown stream event type "${type}"`);
      if (typeof handler !== 'function') throw new TypeError('a stream handler must be a function');
      handlers.get(type).add(handler);
      return () => handlers.get(type).delete(handler);
    },
    start() {
      if (started) return;
      started = true;
      connect();
    },
    stop() {
      started = false;
      if (reconnectTimer) timers.clearTimeout(reconnectTimer);
      reconnectTimer = null;
      if (silenceTimer) timers.clearTimeout(silenceTimer);
      silenceTimer = null;
      clearConnectionTimers();
      const old = ws;
      ws = null;
      if (old) {
        old.onopen = old.onmessage = old.onerror = old.onclose = null;
        try {
          old.close(1000, 'stopped');
        } catch {
          // already closed
        }
        emit('close', meta('close', { code: 1000, reason: 'stopped' }));
      }
    },
    /** Milliseconds (from `now()`) of the last MARKET message; 0 before the first. */
    lastMessageAt: () => lastMessageAt,
    /** Added to 2.4: the last frame of any kind, heartbeat replies included. */
    lastAliveAt: () => lastAliveAt,
    /** Added to 2.4: for status.json. */
    state: () => ({ connected: Boolean(ws && ws.readyState === OPEN), joined: [...joined], reconnects, lastMessageAt, lastAliveAt }),
  };
}
