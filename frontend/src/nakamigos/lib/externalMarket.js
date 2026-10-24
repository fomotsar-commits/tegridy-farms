// Stats and items for a view-only collection, read from OpenSea by slug
// (/api/opensea, two read-only routes). OpenSea is the only market this venue
// reads or links to (owner ruling, 2026-10-02), so a collection it does not
// list (Junglets) makes no read at all and answers `{ unavailable, reason:
// "no-market-read" }`. Every row is validated; a page carries how many rows
// it dropped, and a page whose rows all fail is `{ unavailable, reason }`, as
// is every failed read: never an empty success. Numbers keep full precision,
// and a field the read did not produce is null, never 0.

const CACHE_MS = 60_000;
const OPENSEA_ITEMS_PAGE = 200;
const TOKEN_ID_RE = /^\d{1,10}$/;

// Successful reads are kept for a minute; identical reads in flight share one
// request. A failure is never cached, so the next read asks again.
const cache = new Map();
const inflight = new Map();

function unavailable(reason, extra = {}) {
  return { unavailable: true, reason, ...extra };
}

function parseRetryAfter(header) {
  const secs = Number(header);
  return Number.isFinite(secs) && secs > 0 ? secs : null;
}

async function getJson(url) {
  let res;
  try {
    res = await fetch(url, { headers: { Accept: "application/json" } });
  } catch {
    return { failure: unavailable("network") };
  }
  if (res.status === 429) {
    return { failure: unavailable("rate-limited", { retryAfter: parseRetryAfter(res.headers?.get?.("retry-after")) }) };
  }
  if (!res.ok) return { failure: unavailable(`http-${res.status}`) };
  try {
    return { data: JSON.parse(await res.text()) };
  } catch {
    // vite preview answers /api with the app's HTML.
    return { failure: unavailable("not-json") };
  }
}

function cachedRead(url, normalize) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_MS) return Promise.resolve(hit.value);
  if (inflight.has(url)) return inflight.get(url);
  const p = getJson(url)
    .then(({ data, failure }) => {
      if (failure) return failure;
      const value = normalize(data);
      if (!value.unavailable) cache.set(url, { at: Date.now(), value });
      return value;
    })
    .finally(() => inflight.delete(url));
  inflight.set(url, p);
  return p;
}

const finiteOrNull = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

// A floor is a price only above zero. 0 or null in a floor the read carried
// means none listed; a floor missing or not a number is unread, and neither.
function readFloor(source, key) {
  const v = source[key];
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return { value: v, noneListed: false };
  const carried = Object.prototype.hasOwnProperty.call(source, key);
  return { value: null, noneListed: carried && (v === 0 || v === null) };
}
const stringOrNull = (v) => (typeof v === "string" && v.length > 0 ? v : null);
const isPlainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);

function httpsOnHost(url, isAllowedHost) {
  if (typeof url !== "string") return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && isAllowedHost(u.hostname.toLowerCase()) ? url : null;
  } catch {
    return null;
  }
}

// OpenSea's own CDN, which the CSP admits as https://*.seadn.io.
const seadnImage = (url) => httpsOnHost(url, (h) => h.endsWith(".seadn.io"));

function openseaUrl(path, params = {}) {
  const q = new URLSearchParams({ path, ...params });
  return `/api/opensea?${q.toString()}`;
}

/** Whether this venue reads a market for the collection: OpenSea, for an EVM collection it lists. */
export function readsMarket(collection) {
  return (collection?.chain === "ethereum" || collection?.chain === "base") && typeof collection?.openseaSlug === "string";
}

const noMarketRead = () => Promise.resolve(unavailable("no-market-read"));

/**
 * The collection's market stats: `{ floor, floorSymbol, noneListed, volume,
 * owners, source }`, or `{ unavailable, reason, retryAfter? }`.
 * `floor` is a price above zero or null; `noneListed` says the read carried
 * no floor because nothing is listed, as opposed to not carrying one.
 */
export function fetchExternalStats(collection) {
  if (!readsMarket(collection)) return noMarketRead();
  return cachedRead(openseaUrl(`collections/${collection.openseaSlug}/stats`), (data) => {
    if (!isPlainObject(data) || !isPlainObject(data.total)) return unavailable("shape");
    const t = data.total;
    const floor = readFloor(t, "floor_price");
    return {
      floor: floor.value,
      floorSymbol: floor.value != null ? stringOrNull(t.floor_price_symbol) : null,
      noneListed: floor.noneListed,
      volume: finiteOrNull(t.volume),
      owners: finiteOrNull(t.num_owners),
      source: "OpenSea",
    };
  });
}

function normalizeOpenSeaItems(collection, data) {
  if (!isPlainObject(data) || !Array.isArray(data.nfts)) return unavailable("shape");
  const contract = String(collection.contract || "").toLowerCase();
  const items = [];
  for (const row of data.nfts) {
    if (!isPlainObject(row)) continue;
    if (String(row.contract || "").toLowerCase() !== contract) continue;
    const id = String(row.identifier ?? "");
    if (!TOKEN_ID_RE.test(id)) continue;
    items.push({ id, name: stringOrNull(row.name), image: seadnImage(row.display_image_url || row.image_url) });
  }
  if (data.nfts.length > 0 && items.length === 0) return unavailable("shape");
  return { items, next: stringOrNull(data.next), source: "OpenSea", dropped: data.nfts.length - items.length };
}

/**
 * One page of items, `{ id, name, image }` each: `{ items, next, source,
 * dropped }`, or `{ unavailable, reason }`. `dropped` counts the rows that
 * failed validation. Pass `next` back as `cursor`.
 */
export function fetchExternalItems(collection, cursor = null) {
  if (!readsMarket(collection)) return noMarketRead();
  const params = { limit: String(OPENSEA_ITEMS_PAGE) };
  if (cursor) params.next = String(cursor);
  return cachedRead(openseaUrl(`collection/${collection.openseaSlug}/nfts`, params), (data) => normalizeOpenSeaItems(collection, data));
}
