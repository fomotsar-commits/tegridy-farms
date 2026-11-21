/**
 * The house bidder's OpenSea client (BUILD-SPEC 2.4 / 3.4.1). Plain REST against api.opensea.io with
 * the bot's own key in the `x-api-key` header, never in a URL, never logged.
 *
 * Three rules shape it:
 *  1. It shares OpenSea's rate limits with the marketplace, so it spends from its own small budget:
 *     a token bucket per kind (reads per minute, writes per hour), at least `minSpacingMs` between any
 *     two calls, half speed while OpenSea's `x-ratelimit-remaining` is under half of
 *     `x-ratelimit-limit`, and a full stop until `Retry-After` has passed after a 429.
 *  2. It never calls `offers/collection/*` (that route's bucket is 4 and the site's own pages need it)
 *     and never calls our proxy: the base URL is fixed to OpenSea and every path is checked.
 *  3. Every answer is validated. A shape it does not expect throws OpenSeaError { kind: 'schema' }
 *     rather than being guessed at, because a guessed listing price or fee line is how a bidder overpays.
 *
 * Errors: every method throws OpenSeaError { status, kind: 'rate'|'schema'|'http'|'network',
 * retryAfterMs? }. `status` is 0 when no HTTP answer was involved (a network failure, or the house's
 * own budget saying wait). The one exception is cancelOffer, which returns { ok: false, reason } when
 * OpenSea refuses a cancel (so the caller falls back to an on-chain cancel) and throws only when
 * OpenSea could not answer at all.
 *
 * Units: amounts are bigint wei; `time`/`startTime`/`endTime`/`createdAt` are unix seconds;
 * `retryAfterMs` and `lastSignatureValidUntil` are milliseconds (see util.mjs).
 */
import { BLUR_POOL, NATIVE, SEAPORT_16, SEAPORT_16_CHECKSUMMED, WETH } from './constants.mjs';
import { isAddress, isDecimalString, isHash32, makeLog, realSleep } from './util.mjs';

const BASE = 'https://api.opensea.io';
const CHAIN = 'ethereum';
/** OpenSea's slug rule (OpenAPI modify_collection): 1 to 50 lowercase letters, digits and hyphens. */
const SLUG_RE = /^[a-z0-9-]{1,50}$/;
const SIGNATURE_RE = /^0x[0-9a-fA-F]{130}$/;
/** A pagination loop that runs this long is an API bug, not a market: stop and say so. */
const MAX_PAGES = 40;
/** The payment tokens whose amounts are ETH-denominated wei (18 decimals, 1:1 with ETH). */
const ETH_LIKE = new Set([NATIVE, WETH, BLUR_POOL]);

export class OpenSeaError extends Error {
  constructor(message, { status = 0, kind, retryAfterMs, path } = {}) {
    super(message);
    this.name = 'OpenSeaError';
    this.status = status;
    this.kind = kind;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
    if (path) this.path = path;
  }
}

const schemaError = (path, what) =>
  new OpenSeaError(`OpenSea answered ${path} with an unexpected shape: ${what}`, { status: 200, kind: 'schema', path });

const isInt = (v) => Number.isInteger(v);
const lower = (s) => s.toLowerCase();

/** A whole number from OpenSea's numeric strings (or numbers), for times and counts. */
function wholeNumber(v, path, what) {
  if (isInt(v) && v >= 0) return v;
  if (isDecimalString(v) && Number.isSafeInteger(Number(v))) return Number(v);
  throw schemaError(path, `${what} is not a whole number`);
}

function checkSlug(slug) {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) throw new TypeError('a collection slug must be 1 to 50 lowercase letters, digits or hyphens');
  return slug;
}

function checkAddress(a, what) {
  if (!isAddress(a)) throw new TypeError(`${what} must be a 0x + 40 hex address`);
  return lower(a);
}

/** One Seaport item as OpenSea writes it (amounts as decimal strings), validated. */
function wireItem(raw, path, what, { withRecipient }) {
  if (!raw || typeof raw !== 'object') throw schemaError(path, `${what} is not an object`);
  const { itemType, token, identifierOrCriteria, startAmount, endAmount, recipient } = raw;
  if (!isInt(itemType) || itemType < 0 || itemType > 5) throw schemaError(path, `${what}.itemType`);
  if (!isAddress(token)) throw schemaError(path, `${what}.token`);
  for (const [k, v] of Object.entries({ identifierOrCriteria, startAmount, endAmount })) {
    if (!isDecimalString(v)) throw schemaError(path, `${what}.${k} is not a decimal string`);
  }
  const item = { itemType, token: lower(token), identifierOrCriteria, startAmount, endAmount };
  if (withRecipient) {
    if (!isAddress(recipient)) throw schemaError(path, `${what}.recipient`);
    item.recipient = lower(recipient);
  }
  return item;
}

/** GET /collections/{slug} -> the fields the bot prices and pins with. */
export function normalizeCollection(json, slug, path = `/api/v2/collections/${slug}`) {
  if (!json || typeof json !== 'object') throw schemaError(path, 'not an object');
  if (json.collection !== slug) throw schemaError(path, `it describes "${String(json.collection)}", not "${slug}"`);
  if (!Array.isArray(json.contracts)) throw schemaError(path, 'contracts is not an array');
  const eth = json.contracts.find((c) => c && c.chain === CHAIN && isAddress(c.address));
  if (!eth) throw schemaError(path, 'no Ethereum contract');
  if (!Array.isArray(json.fees)) throw schemaError(path, 'fees is not an array');
  const requiredFees = [];
  const optionalFees = [];
  for (const [i, f] of json.fees.entries()) {
    if (!f || typeof f.fee !== 'number' || !Number.isFinite(f.fee) || f.fee < 0 || f.fee > 100) throw schemaError(path, `fees[${i}].fee`);
    if (!isAddress(f.recipient)) throw schemaError(path, `fees[${i}].recipient`);
    if (typeof f.required !== 'boolean') throw schemaError(path, `fees[${i}].required`);
    // OpenSea gives a percentage (1 = 1%). A fee line must be exact, so anything that is not a whole
    // number of basis points is refused rather than rounded into the wrong amount.
    const bps = Math.round(f.fee * 100);
    if (Math.abs(f.fee * 100 - bps) > 1e-6) throw schemaError(path, `fees[${i}] is not a whole number of basis points`);
    (f.required ? requiredFees : optionalFees).push({ recipient: lower(f.recipient), bps });
  }
  for (const k of ['trait_offers_enabled', 'collection_offers_enabled', 'is_disabled']) {
    if (typeof json[k] !== 'boolean') throw schemaError(path, `${k} is not a boolean`);
  }
  return {
    slug,
    contract: lower(eth.address),
    requiredFees,
    optionalFees,
    traitOffersEnabled: json.trait_offers_enabled,
    collectionOffersEnabled: json.collection_offers_enabled,
    // Not in BUILD-SPEC 2.4's list; added so the risk engine can see OpenSea disabling a collection.
    isDisabled: json.is_disabled,
    safelistStatus: typeof json.safelist_status === 'string' ? json.safelist_status : null,
    totalSupply: isInt(json.total_supply) ? json.total_supply : null,
  };
}

/**
 * One entry of GET /listings/collection/{slug}/best. `priceWei` is what a buyer pays (OpenSea's
 * `price.current`), `taker` is set only for a private listing (an NFT consideration line names its
 * buyer), and `createdAt` is when OpenSea received the order: a maker can backdate `startTime`, but
 * not that, which is why the fair-value age rule reads the later of the two.
 */
export function normalizeListing(raw, path) {
  if (!raw || typeof raw !== 'object') throw schemaError(path, 'a listing is not an object');
  if (!isHash32(raw.order_hash)) throw schemaError(path, 'a listing has no order_hash');
  const p = raw.protocol_data?.parameters;
  if (!p || typeof p !== 'object') throw schemaError(path, 'a listing has no protocol_data.parameters');
  if (!isAddress(p.offerer)) throw schemaError(path, 'a listing offerer');
  if (!Array.isArray(p.offer) || !p.offer.length) throw schemaError(path, 'a listing offer');
  if (!Array.isArray(p.consideration) || !p.consideration.length) throw schemaError(path, 'a listing consideration');
  const offer = p.offer.map((o, i) => wireItem(o, path, `offer[${i}]`, { withRecipient: false }));
  const consideration = p.consideration.map((c, i) => wireItem(c, path, `consideration[${i}]`, { withRecipient: true }));
  const nft = offer.find((o) => o.itemType === 2 || o.itemType === 3);
  if (!nft) throw schemaError(path, 'a listing that offers no NFT');
  if (!isInt(p.orderType) || p.orderType < 0 || p.orderType > 3) throw schemaError(path, 'a listing orderType');
  if (!isAddress(p.zone)) throw schemaError(path, 'a listing zone');
  if (!isHash32(p.conduitKey)) throw schemaError(path, 'a listing conduitKey');
  const cur = raw.price?.current;
  if (!cur || typeof cur.currency !== 'string' || !isInt(cur.decimals) || !isDecimalString(cur.value)) throw schemaError(path, 'a listing price.current');
  const taker = consideration.find((c) => c.itemType >= 2)?.recipient ?? null;
  return {
    orderHash: lower(raw.order_hash),
    tokenId: nft.identifierOrCriteria,
    priceWei: BigInt(cur.value),
    maker: lower(p.offerer),
    startTime: wholeNumber(p.startTime, path, 'a listing startTime'),
    endTime: wholeNumber(p.endTime, path, 'a listing endTime'),
    protocol: isAddress(raw.protocol_address) ? lower(raw.protocol_address) : null,
    orderType: p.orderType,
    zone: lower(p.zone),
    taker,
    // Added to 2.4's shape: what fillability and the age rule need.
    contract: nft.token,
    conduitKey: lower(p.conduitKey),
    createdAt: raw.order_created_at == null ? null : wholeNumber(raw.order_created_at, path, 'a listing order_created_at'),
    currency: cur.currency,
    decimals: cur.decimals,
    status: typeof raw.status === 'string' ? raw.status : null,
  };
}

/**
 * One sale from GET /events/collection/{slug}. Most sales OpenSea reports did not go through Seaport
 * (it aggregates other venues), so `orderHash` and `protocol` are often null. `priceWei` is per unit.
 */
export function normalizeSale(raw, path) {
  if (!raw || typeof raw !== 'object') throw schemaError(path, 'a sale is not an object');
  if (raw.event_type !== 'sale') throw schemaError(path, `an event of type "${String(raw.event_type)}" in a sales query`);
  if (!isInt(raw.event_timestamp) || raw.event_timestamp <= 0) throw schemaError(path, 'a sale event_timestamp');
  if (!isHash32(raw.transaction)) throw schemaError(path, 'a sale transaction');
  const nft = raw.nft;
  if (!nft || !isDecimalString(nft.identifier) || !isAddress(nft.contract)) throw schemaError(path, 'a sale nft');
  const pay = raw.payment;
  if (!pay || !isDecimalString(pay.quantity) || !isAddress(pay.token_address) || !isInt(pay.decimals)) throw schemaError(path, 'a sale payment');
  if (!isAddress(raw.seller) || !isAddress(raw.buyer)) throw schemaError(path, 'a sale seller or buyer');
  const qty = raw.quantity == null ? 1 : raw.quantity;
  if (!isInt(qty) || qty < 1) throw schemaError(path, 'a sale quantity');
  const total = BigInt(pay.quantity);
  if (total % BigInt(qty) !== 0n) throw schemaError(path, 'a sale whose total does not split evenly per unit');
  const orderHash = isHash32(raw.order_hash) ? lower(raw.order_hash) : null;
  if (raw.order_hash && !orderHash) throw schemaError(path, 'a sale order_hash');
  return {
    txHash: lower(raw.transaction),
    time: raw.event_timestamp,
    tokenId: nft.identifier,
    priceWei: total / BigInt(qty),
    paymentToken: lower(pay.token_address),
    seller: lower(raw.seller),
    buyer: lower(raw.buyer),
    orderHash,
    // Added to 2.4's shape.
    contract: lower(nft.contract),
    qty,
    paymentSymbol: typeof pay.symbol === 'string' ? pay.symbol : null,
    paymentDecimals: pay.decimals,
    protocol: isAddress(raw.protocol_address) ? lower(raw.protocol_address) : null,
  };
}

/** One entry of GET /account/{address}/offers. `priceWei` is per unit; `totalWei` the whole offer. */
export function normalizeAccountOffer(raw, path) {
  if (!raw || typeof raw !== 'object') throw schemaError(path, 'an offer is not an object');
  if (!isHash32(raw.order_hash)) throw schemaError(path, 'an offer order_hash');
  const p = raw.protocol_data?.parameters;
  if (!p || !Array.isArray(p.consideration) || !Array.isArray(p.offer)) throw schemaError(path, 'an offer protocol_data.parameters');
  const consideration = p.consideration.map((c, i) => wireItem(c, path, `consideration[${i}]`, { withRecipient: true }));
  const nftLine = consideration.find((c) => c.itemType >= 2);
  if (!nftLine) throw schemaError(path, 'an offer that asks for no NFT');
  const qty = Number(nftLine.startAmount);
  if (!Number.isSafeInteger(qty) || qty < 1) throw schemaError(path, 'an offer quantity');
  const total = raw.price?.value;
  if (!isDecimalString(total)) throw schemaError(path, 'an offer price.value');
  const perItem = raw.price_per_item?.value;
  let priceWei;
  if (perItem != null) {
    if (!isDecimalString(perItem)) throw schemaError(path, 'an offer price_per_item.value');
    priceWei = BigInt(perItem);
  } else {
    if (BigInt(total) % BigInt(qty) !== 0n) throw schemaError(path, 'an offer total that does not split per unit');
    priceWei = BigInt(total) / BigInt(qty);
  }
  const remaining = raw.remaining_quantity;
  if (!isInt(remaining) || remaining < 0) throw schemaError(path, 'an offer remaining_quantity');
  const slug = raw.criteria?.collection?.slug;
  return {
    orderHash: lower(raw.order_hash),
    slug: typeof slug === 'string' ? slug : null,
    priceWei,
    qty,
    remainingQty: remaining,
    endTime: wholeNumber(p.endTime, path, 'an offer endTime'),
    raw,
    // Added to 2.4's shape.
    totalWei: BigInt(total),
    status: typeof raw.status === 'string' ? raw.status : null,
    protocol: isAddress(raw.protocol_address) ? lower(raw.protocol_address) : null,
  };
}

/** GET /chain/ethereum/contract/{contract}/nfts/{id}: OpenSea's flags and the single owner. */
export function normalizeItem(json, path) {
  const nft = json?.nft;
  if (!nft || typeof nft !== 'object') throw schemaError(path, 'no nft object');
  if (typeof nft.is_disabled !== 'boolean') throw schemaError(path, 'nft.is_disabled is not a boolean');
  if (nft.is_suspicious != null && typeof nft.is_suspicious !== 'boolean') throw schemaError(path, 'nft.is_suspicious is not a boolean');
  if (nft.owners != null && !Array.isArray(nft.owners)) throw schemaError(path, 'nft.owners is not an array');
  const owners = nft.owners ?? [];
  return {
    isDisabled: nft.is_disabled,
    isSuspicious: nft.is_suspicious ?? null,
    // An ERC-721 has one owner; anything else is reported as unknown rather than picked from.
    owner: owners.length === 1 && isAddress(owners[0]?.address) ? lower(owners[0].address) : null,
  };
}

/**
 * POST /offers/build -> { zone, zoneHash, consideration } in OpenSea's wire format (amounts stay
 * decimal strings, addresses lowercased), ready to hand to the signer as it is. This checks SHAPE
 * only; whether the zone and the NFT line are the pinned ones is the executor's and the signer's job.
 */
export function normalizeBuild(json, path = '/api/v2/offers/build') {
  const pp = json?.partialParameters;
  if (!pp || typeof pp !== 'object') throw schemaError(path, 'no partialParameters');
  if (!isAddress(pp.zone)) throw schemaError(path, 'partialParameters.zone');
  if (!isHash32(pp.zoneHash)) throw schemaError(path, 'partialParameters.zoneHash');
  if (!Array.isArray(pp.consideration) || !pp.consideration.length) throw schemaError(path, 'partialParameters.consideration');
  return {
    zone: lower(pp.zone),
    zoneHash: lower(pp.zoneHash),
    consideration: pp.consideration.map((c, i) => wireItem(c, path, `consideration[${i}]`, { withRecipient: true })),
  };
}

const NUMERIC_FIELDS = ['startTime', 'endTime', 'salt', 'counter'];

/** A wire string for a Seaport number: bigint and safe integers become decimal strings. */
function wireNumber(v, what) {
  if (typeof v === 'bigint') {
    if (v < 0n) throw new TypeError(`${what} is negative`);
    return v.toString();
  }
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return String(v);
  if (isDecimalString(v)) return v;
  // A salt may arrive as 0x hex (OpenSea's own salts are written that way).
  if (what === 'salt' && typeof v === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(v)) return v;
  throw new TypeError(`${what} must be a whole number`);
}

function wireOrderItem(it, what, withRecipient) {
  if (!it || !isInt(it.itemType) || it.itemType < 0 || it.itemType > 5) throw new TypeError(`${what}.itemType`);
  const out = {
    itemType: it.itemType,
    token: checkAddress(it.token, `${what}.token`),
    identifierOrCriteria: wireNumber(it.identifierOrCriteria, `${what}.identifierOrCriteria`),
    startAmount: wireNumber(it.startAmount, `${what}.startAmount`),
    endAmount: wireNumber(it.endAmount, `${what}.endAmount`),
  };
  if (withRecipient) out.recipient = checkAddress(it.recipient, `${what}.recipient`);
  return out;
}

/**
 * The signer's OrderParameters as OpenSea's POST body wants them. OpenSea requires `counter` inside
 * `parameters`; the signer returns it beside them (BUILD-SPEC 2.3), so it may be passed either way.
 */
export function toWireParameters(parameters, counter) {
  const p = parameters;
  if (!p || typeof p !== 'object') throw new TypeError('parameters must be an object');
  if (!Array.isArray(p.offer) || !p.offer.length) throw new TypeError('parameters.offer must be a non-empty array');
  if (!Array.isArray(p.consideration) || !p.consideration.length) throw new TypeError('parameters.consideration must be a non-empty array');
  if (!isInt(p.orderType) || p.orderType < 0 || p.orderType > 3) throw new TypeError('parameters.orderType');
  if (!isHash32(p.zoneHash)) throw new TypeError('parameters.zoneHash');
  if (!isHash32(p.conduitKey)) throw new TypeError('parameters.conduitKey');
  const total = p.totalOriginalConsiderationItems;
  if (!isInt(total) || total !== p.consideration.length) throw new TypeError('parameters.totalOriginalConsiderationItems must equal the number of consideration items');
  const merged = { ...p, counter: p.counter ?? counter };
  if (merged.counter == null) throw new TypeError('the order counter is missing (OpenSea needs it in parameters)');
  const wire = {
    offerer: checkAddress(p.offerer, 'parameters.offerer'),
    zone: checkAddress(p.zone, 'parameters.zone'),
    offer: p.offer.map((o, i) => wireOrderItem(o, `offer[${i}]`, false)),
    consideration: p.consideration.map((c, i) => wireOrderItem(c, `consideration[${i}]`, true)),
    orderType: p.orderType,
    zoneHash: lower(p.zoneHash),
    conduitKey: lower(p.conduitKey),
    totalOriginalConsiderationItems: total,
  };
  for (const k of NUMERIC_FIELDS) wire[k] = wireNumber(merged[k], k);
  return wire;
}

/** OpenSea's error text, short, for a refusal the caller logs. */
function refusalText(json, text) {
  const pick = Array.isArray(json?.errors) ? json.errors.join('; ') : json?.detail ?? json?.message ?? json?.error ?? text;
  return String(pick ?? '').slice(0, 300) || 'no reason given';
}

/**
 * @param {object} o
 * @param {string} o.apiKey the bot's own OpenSea key (header only)
 * @param {typeof fetch} [o.fetchImpl]
 * @param {() => number} [o.now] a millisecond clock
 * @param {{ readsPerMinute: number, writesPerHour: number }} [o.budget]
 * @param {*} [o.log] see util.makeLog
 * @param {(ms: number) => Promise<void>} [o.sleep] injected with a fake clock in tests
 * @param {number} [o.maxWaitMs] a call waits this long for budget at most, then throws kind 'rate'
 * @param {number} [o.minSpacingMs] the shortest gap between any two calls
 * @param {number} [o.timeoutMs] per request
 */
export function createOpenSeaClient({
  apiKey,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  budget = { readsPerMinute: 6, writesPerHour: 20 },
  log,
  sleep = realSleep,
  maxWaitMs = 20_000,
  minSpacingMs = 1_500,
  timeoutMs = 15_000,
} = {}) {
  if (typeof apiKey !== 'string' || apiKey.length < 8) throw new TypeError('an OpenSea API key is required');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  const readsPerMinute = budget?.readsPerMinute;
  const writesPerHour = budget?.writesPerHour;
  if (!(readsPerMinute > 0) || !(writesPerHour > 0)) throw new TypeError('the budget needs readsPerMinute and writesPerHour above zero');
  const out = makeLog(log);
  const scrub = (s) => String(s).split(apiKey).join('<redacted>');

  const start = now();
  // Each bucket keeps milliseconds per token, so waits come out in whole milliseconds (a rate in
  // tokens per millisecond turned 30 minutes into 1,800,001 ms through float rounding).
  const buckets = {
    read: { capacity: readsPerMinute, msPerToken: 60_000 / readsPerMinute, level: readsPerMinute, at: start },
    write: { capacity: writesPerHour, msPerToken: 3_600_000 / writesPerHour, level: writesPerHour, at: start },
  };
  let slow = false;
  let blockedUntil = 0;
  let nextSlotAt = 0;
  let lastHeaders = null;

  const msPerToken = (b) => b.msPerToken * (slow ? 2 : 1);
  function refill(b) {
    const t = now();
    if (t > b.at) b.level = Math.min(b.capacity, b.level + (t - b.at) / msPerToken(b));
    b.at = Math.max(b.at, t);
  }
  function setSlow(v) {
    if (v === slow) return;
    // Settle the time already elapsed at the old rate before the rate changes.
    refill(buckets.read);
    refill(buckets.write);
    slow = v;
    out.info(v ? 'OpenSea rate headers under half: the house reads and writes at half speed' : 'OpenSea rate headers recovered: full speed');
  }

  /**
   * Take one token of `kind`, waiting for it when the wait is short and throwing kind 'rate' when it
   * is not. A token is reserved before the wait, so calls made at the same time queue behind each
   * other instead of all waking together. `force` lets a cancel spend past an empty bucket (a cancel
   * must not wait behind discretionary posts); it still waits out a Retry-After and the spacing.
   */
  async function acquire(kind, path, force) {
    const b = buckets[kind];
    const t = now();
    refill(b);
    const waitBlock = Math.max(0, blockedUntil - t);
    const waitBucket = b.level >= 1 || force ? 0 : Math.ceil((1 - b.level) * msPerToken(b) - 1e-6);
    const slot = Math.max(t + Math.max(waitBlock, waitBucket), nextSlotAt);
    const wait = slot - t;
    if (wait > maxWaitMs) {
      const byServer = waitBlock >= waitBucket && waitBlock > 0;
      throw new OpenSeaError(
        byServer ? `OpenSea asked for a pause; ${path} waits ${Math.ceil(wait / 1000)} s` : `the house's own OpenSea ${kind} budget is spent; ${path} waits ${Math.ceil(wait / 1000)} s`,
        { status: byServer ? 429 : 0, kind: 'rate', retryAfterMs: wait, path },
      );
    }
    b.level -= 1;
    nextSlotAt = slot + minSpacingMs;
    if (wait > 0) await sleep(wait);
  }

  function readHeader(res, name) {
    try {
      const v = res.headers?.get?.(name);
      return v == null ? null : String(v);
    } catch {
      return null;
    }
  }

  function noteHeaders(res) {
    const limit = readHeader(res, 'x-ratelimit-limit');
    const remaining = readHeader(res, 'x-ratelimit-remaining');
    const retryAfter = readHeader(res, 'retry-after');
    lastHeaders = { status: res.status, limit, remaining, retryAfter, at: now() };
    const l = Number(limit);
    const r = Number(remaining);
    if (limit != null && remaining != null && Number.isFinite(l) && Number.isFinite(r) && l > 0) setSlow(r < l / 2);
  }

  function retryAfterMs(v) {
    if (v == null) return null;
    const secs = Number(v);
    if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
    const at = Date.parse(v);
    return Number.isFinite(at) ? Math.max(0, at - now()) : null;
  }

  /** One HTTP call. Returns { status, json } for 2xx (and for 4xx when `refusals` is set). */
  async function call(method, path, { query, body, kind, force = false, refusals = false }) {
    if (typeof path !== 'string' || !path.startsWith('/api/v2/') || path.includes('..') || /[\s?#]/.test(path)) {
      throw new TypeError('not an OpenSea API path');
    }
    // BUILD-SPEC 3.4.1: never this route. Its bucket is 4 and the marketplace's pages need it.
    if (path.startsWith('/api/v2/offers/collection/')) throw new TypeError('the house bidder never calls offers/collection');
    await acquire(kind, path, force);
    const url = BASE + path + (query ? `?${query}` : '');
    const headers = { accept: 'application/json', 'x-api-key': apiKey };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const init = { method, headers };
    if (body !== undefined) init.body = JSON.stringify(body);
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') init.signal = AbortSignal.timeout(timeoutMs);
    let res;
    try {
      res = await fetchImpl(url, init);
    } catch (e) {
      throw new OpenSeaError(`OpenSea could not be reached for ${path}: ${scrub(e?.message ?? e)}`, { status: 0, kind: 'network', path });
    }
    noteHeaders(res);
    out.debug(`opensea ${method} ${path} -> ${res.status}`, { remaining: lastHeaders.remaining, limit: lastHeaders.limit });
    if (res.status === 429) {
      // No Retry-After: wait a minute. Clamped so a garbled header cannot freeze the bot for a day.
      const wait = Math.min(3_600_000, Math.max(1_000, retryAfterMs(lastHeaders.retryAfter) ?? 60_000));
      blockedUntil = Math.max(blockedUntil, now() + wait);
      out.warn(`OpenSea answered 429 for ${path}; pausing ${Math.ceil(wait / 1000)} s`);
      throw new OpenSeaError(`OpenSea rate-limited ${path}`, { status: 429, kind: 'rate', retryAfterMs: wait, path });
    }
    let text;
    try {
      text = await res.text();
    } catch (e) {
      throw new OpenSeaError(`OpenSea's answer for ${path} could not be read: ${scrub(e?.message ?? e)}`, { status: res.status, kind: 'network', path });
    }
    let json;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = undefined;
    }
    if (res.status < 200 || res.status > 299) {
      if (refusals && res.status >= 400 && res.status < 500) return { status: res.status, json, text };
      throw new OpenSeaError(`OpenSea answered ${res.status} for ${path}: ${scrub(refusalText(json, text)).slice(0, 200)}`, { status: res.status, kind: 'http', path });
    }
    if (json === undefined || json === null || typeof json !== 'object') throw schemaError(path, 'the body is not a JSON object');
    return { status: res.status, json };
  }

  /** Follow `next`-style cursors; `cursorParam` is the query name the route reads the cursor from. */
  async function pages(path, params, cursorParam, onPage) {
    let cursor = null;
    const seen = new Set();
    for (let page = 0; page < MAX_PAGES; page++) {
      const q = new URLSearchParams(params);
      if (cursor) q.set(cursorParam, cursor);
      const { json } = await call('GET', path, { query: q.toString(), kind: 'read' });
      const more = onPage(json);
      const next = typeof json.next === 'string' && json.next ? json.next : null;
      if (!more || !next) return;
      if (seen.has(next)) throw schemaError(path, 'a pagination cursor repeated');
      seen.add(next);
      cursor = next;
    }
    throw schemaError(path, `more than ${MAX_PAGES} pages`);
  }

  return {
    async collection(slug) {
      checkSlug(slug);
      const path = `/api/v2/collections/${slug}`;
      const { json } = await call('GET', path, { kind: 'read' });
      return normalizeCollection(json, slug, path);
    },

    /**
     * The cheapest live listings, cheapest first. Non-ACTIVE entries are dropped. Ask for enough:
     * on 2026-11-15 the cheapest 165 GNSS listings were all 11-15 minute bot relists, too young to
     * count for L, and the first listings 30 minutes old sat at places 166 to 183. The default of
     * 200 is one read (OpenSea's page maximum).
     */
    async bestListings(slug, { limit = 200 } = {}) {
      checkSlug(slug);
      const want = Math.max(1, Math.min(1_000, Math.floor(Number(limit) || 200)));
      const path = `/api/v2/listings/collection/${slug}/best`;
      const outList = [];
      const seen = new Set();
      await pages(path, { limit: String(Math.min(200, want)) }, 'next', (json) => {
        if (!Array.isArray(json.listings)) throw schemaError(path, 'listings is not an array');
        for (const raw of json.listings) {
          const l = normalizeListing(raw, path);
          if (l.status && l.status !== 'ACTIVE') continue;
          if (seen.has(l.orderHash)) continue;
          seen.add(l.orderHash);
          outList.push(l);
        }
        return outList.length < want;
      });
      return outList.sort((a, b) => (a.priceWei < b.priceWei ? -1 : a.priceWei > b.priceWei ? 1 : 0)).slice(0, want);
    },

    /**
     * Sales with afterSec <= time <= beforeSec (both inclusive, so the caller dedupes by
     * txHash + tokenId when it polls), oldest first. It follows `next` and stops once a page reaches
     * afterSec. Only sales paid in ETH, WETH or Blur's BETH are returned: an amount in any other token
     * is not wei, and a 6-decimal price read as wei would look like a near-free sale.
     */
    async saleEvents(slug, { afterSec, beforeSec, pageSize = 50 } = {}) {
      checkSlug(slug);
      if (!Number.isSafeInteger(afterSec) || afterSec < 0) throw new TypeError('afterSec must be whole unix seconds');
      const before = beforeSec == null ? Math.floor(now() / 1000) + 60 : beforeSec;
      if (!Number.isSafeInteger(before) || before < afterSec) throw new TypeError('beforeSec must be whole unix seconds, not before afterSec');
      const path = `/api/v2/events/collection/${slug}`;
      const outList = [];
      const seen = new Set();
      let skipped = 0;
      // OpenSea's after/before are exclusive; widen by a second so both ends are inclusive.
      const params = { event_type: 'sale', after: String(Math.max(0, afterSec - 1)), before: String(before + 1), limit: String(Math.max(1, Math.min(50, pageSize))) };
      await pages(path, params, 'next', (json) => {
        if (!Array.isArray(json.asset_events)) throw schemaError(path, 'asset_events is not an array');
        let reachedStart = false;
        for (const raw of json.asset_events) {
          const s = normalizeSale(raw, path);
          if (s.time < afterSec) {
            reachedStart = true;
            continue;
          }
          if (s.time > before) continue;
          if (!ETH_LIKE.has(s.paymentToken) || s.paymentDecimals !== 18) {
            skipped++;
            continue;
          }
          const key = `${s.txHash}:${s.contract}:${s.tokenId}:${s.orderHash ?? ''}`;
          if (seen.has(key)) continue;
          seen.add(key);
          outList.push(s);
        }
        return !reachedStart;
      });
      if (skipped) out.info(`saleEvents(${slug}): left out ${skipped} sale(s) paid in a token that is not ETH, WETH or BETH`);
      return outList.sort((a, b) => a.time - b.time || (a.txHash < b.txHash ? -1 : a.txHash > b.txHash ? 1 : 0));
    },

    /**
     * Active offers the wallet has made on Ethereum (advisory: the signer's ledger is the truth).
     * This route lists offers WITHOUT their order parameters (checked live 2026-11-16), so it has no
     * end time and no original quantity. Each entry is completed from GET orders/.../{order_hash};
     * the house has a handful of offers at most, so that costs a few reads. An order that has gone by
     * the time it is read (404) is left out: it is no longer live.
     */
    async accountOffers(address, { maxOffers = 50 } = {}) {
      const who = checkAddress(address, 'address');
      const path = `/api/v2/account/${who}/offers`;
      const listed = [];
      const seen = new Set();
      await pages(path, { chains: CHAIN, limit: '50' }, 'after', (json) => {
        if (!Array.isArray(json.offers)) throw schemaError(path, 'offers is not an array');
        for (const raw of json.offers) {
          if (!raw || !isHash32(raw.order_hash)) throw schemaError(path, 'an offer order_hash');
          const h = lower(raw.order_hash);
          if (seen.has(h)) continue;
          seen.add(h);
          listed.push(raw);
        }
        // The house keeps one order per collection. Far more than that is not something to reseed
        // from quietly: it is an anomaly for a person to look at, so the read fails loudly.
        if (listed.length > maxOffers) throw schemaError(path, `more than ${maxOffers} live offers for one wallet`);
        return true;
      });
      const outList = [];
      for (const raw of listed) {
        if (raw.protocol_data?.parameters) {
          outList.push(normalizeAccountOffer(raw, path));
          continue;
        }
        // Every offer OpenSea takes today is Seaport 1.6 (BUILD-SPEC section 1); an entry naming
        // another protocol is read on that one.
        const protocol = isAddress(raw.protocol_address) ? lower(raw.protocol_address) : SEAPORT_16;
        const orderPath = `/api/v2/orders/chain/${CHAIN}/protocol/${protocol}/${lower(raw.order_hash)}`;
        let full;
        try {
          ({ json: full } = await call('GET', orderPath, { kind: 'read' }));
        } catch (e) {
          if (e instanceof OpenSeaError && e.status === 404) {
            out.info(`accountOffers: ${lower(raw.order_hash)} is gone (404); left out`);
            continue;
          }
          throw e;
        }
        if (!full?.order || typeof full.order !== 'object') throw schemaError(orderPath, 'no order object');
        if (lower(String(full.order.order_hash ?? '')) !== lower(raw.order_hash)) throw schemaError(orderPath, 'it describes a different order');
        outList.push(normalizeAccountOffer({ ...raw, ...full.order }, orderPath));
      }
      return outList;
    },

    async item(contract, tokenId) {
      const c = checkAddress(contract, 'contract');
      const id = typeof tokenId === 'bigint' ? tokenId.toString() : String(tokenId);
      if (!isDecimalString(id)) throw new TypeError('tokenId must be a whole number');
      const path = `/api/v2/chain/${CHAIN}/contract/${c}/nfts/${id}`;
      const { json } = await call('GET', path, { kind: 'read' });
      return normalizeItem(json, path);
    },

    /** POST offers/build for a collection offer on Seaport 1.6 with OpenSea's protection zone. */
    async buildCollectionOffer({ offerer, slug, qty }) {
      const who = checkAddress(offerer, 'offerer');
      checkSlug(slug);
      if (!Number.isSafeInteger(qty) || qty < 1 || qty > 100) throw new TypeError('qty must be a whole number from 1 to 100');
      const path = '/api/v2/offers/build';
      const body = {
        offerer: who,
        quantity: qty,
        criteria: { collection: { slug } },
        // Both fields are required (BUILD-SPEC section 1: a build without protocol_address is a 400).
        protocol_address: SEAPORT_16_CHECKSUMMED,
        offer_protection_enabled: true,
      };
      const { json } = await call('POST', path, { body, kind: 'write' });
      return normalizeBuild(json, path);
    },

    /** POST offers (criteria offers v2). Returns the order hash OpenSea stored. */
    async postCriteriaOffer({ parameters, signature, slug, counter }) {
      checkSlug(slug);
      if (typeof signature !== 'string' || !SIGNATURE_RE.test(signature)) throw new TypeError('signature must be 0x + 130 hex (65 bytes)');
      const wire = toWireParameters(parameters, counter);
      const path = '/api/v2/offers';
      const body = {
        criteria: { collection: { slug } },
        protocol_address: SEAPORT_16_CHECKSUMMED,
        protocol_data: { parameters: wire, signature },
      };
      const { json } = await call('POST', path, { body, kind: 'write' });
      if (!isHash32(json.order_hash)) throw schemaError(path, 'no order_hash in the answer');
      return { orderHash: lower(json.order_hash) };
    },

    /**
     * Gasless cancel of a Seaport 1.6 SignedZone order. `lastSignatureValidUntil` is the millisecond
     * time the last fill signature OpenSea issued stops working; null when OpenSea says "0" (it issued
     * none, so the order can no longer be filled). Until that time the order can still be filled.
     * A refusal (any 4xx but 429) comes back as { ok: false, reason } for an on-chain fallback.
     */
    async cancelOffer({ orderHash, offererSignature }) {
      if (!isHash32(orderHash)) throw new TypeError('orderHash must be 0x + 64 hex');
      if (typeof offererSignature !== 'string' || !SIGNATURE_RE.test(offererSignature)) throw new TypeError('offererSignature must be 0x + 130 hex');
      const path = `/api/v2/orders/chain/${CHAIN}/protocol/${SEAPORT_16}/${lower(orderHash)}/cancel`;
      const res = await call('POST', path, { body: { offererSignature }, kind: 'write', force: true, refusals: true });
      if (res.status >= 400) {
        const reason = scrub(refusalText(res.json, res.text));
        out.warn(`OpenSea refused the gasless cancel of ${lower(orderHash)} (${res.status}): ${reason}`);
        return { ok: false, reason, status: res.status };
      }
      const v = res.json.last_signature_issued_valid_until;
      if (v === '0' || v === 0) return { ok: true, lastSignatureValidUntil: null };
      const at = typeof v === 'string' ? Date.parse(v) : NaN;
      if (!Number.isFinite(at)) throw schemaError(path, 'last_signature_issued_valid_until is not a time');
      return { ok: true, lastSignatureValidUntil: at };
    },

    rateState() {
      refill(buckets.read);
      refill(buckets.write);
      return {
        readsLeft: Math.max(0, Math.floor(buckets.read.level)),
        writesLeft: Math.max(0, Math.floor(buckets.write.level)),
        lastHeaders,
        // Added to 2.4's shape.
        slow,
        blockedUntil,
      };
    },
  };
}
