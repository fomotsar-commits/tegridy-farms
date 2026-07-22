/**
 * marketIntegrity.js — NFT market-integrity measurement (Tradermigos).
 *
 * Points the shared token-distribution detection core at NFT-collection
 * manipulation instead of ERC-20 supply:
 *   1. Wash trading / self-dealing   — over recent SALES.
 *   2. Floor concentration           — over active LISTINGS.
 *   3. Wallet-cluster ownership      — over the OWNER set, with the wash-graph
 *                                      clusters overlaid as coordinated holders.
 *
 * HONEST-FRAMING CONTRACT (mirrors the detection core):
 *  - This is a DESCRIPTIVE MEASUREMENT with a disclosed method and a timestamp,
 *    never a fraud verdict or accusation. Every section self-gates to
 *    `measured: false` when the underlying data is absent — it NEVER fabricates
 *    a count, a volume, or a wallet.
 *  - The concentration math is NOT reimplemented here: ownership + floor both
 *    call into `@/lib/detection` (analyzeDistribution / computeHHI /
 *    effectiveHolders / topNShare). Only NFT-specific graph logic (the wash
 *    trade graph) lives in this file, because the core has no trade-graph notion.
 *  - Self-dealing detection reuses the existing `isSelfSale` primitive
 *    (lib/washTrade.js) rather than duplicating address comparison.
 *
 * PURITY: the analyze- and compute- functions are pure — they take already-
 * fetched arrays and return JSON-safe objects, no network, no clock (except an
 * optional `observedAt`). `fetchCollectionOwners` is the ONE network adapter and
 * is kept separate; it never returns fabricated/fallback data.
 */

import {
  analyzeDistribution,
  computeHHI,
  effectiveHolders,
  topNShare,
} from "../../lib/detection";
import { isSelfSale } from "./washTrade";
import { alchemyGet } from "./proxy";

export const INTEGRITY_METHOD_VERSION = "nft-integrity/1.0.0";

/** A 0x-prefixed 40-hex EVM address (lowercased), else null. */
function normAddr(value) {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(v) ? v : null;
}

/** A finite, positive price in ETH, else null (never invented). */
function normPrice(value) {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Normalize a sale row to { seller, buyer, tokenId, price, time, hash } or null.
 * Accepts both app sale shapes: the activity-feed shape ({ fromFull, toFull,
 * token:{id}, price, time, hash }) and the price-history shape ({ from, to }).
 * Returns null when we cannot compare BOTH parties (never guesses).
 */
export function normalizeSale(sale) {
  if (!sale || typeof sale !== "object") return null;
  const seller = normAddr(sale.fromFull) || normAddr(sale.from);
  const buyer = normAddr(sale.toFull) || normAddr(sale.to);
  if (!seller || !buyer) return null;
  const tokenId =
    sale.token && sale.token.id != null
      ? String(sale.token.id)
      : sale.tokenId != null
        ? String(sale.tokenId)
        : null;
  return {
    seller,
    buyer,
    tokenId,
    price: normPrice(sale.price),
    time: Number.isFinite(sale.time) ? sale.time : null,
    hash: typeof sale.hash === "string" ? sale.hash : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Wash-trade graph (union-find over reciprocal + round-trip edges)
// ─────────────────────────────────────────────────────────────────────────────

class UnionFind {
  constructor() {
    this.parent = new Map();
  }
  find(x) {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root);
    // path compression
    let cur = x;
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur);
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

/**
 * Build coordinated-trade clusters from a list of sales.
 *
 * An edge is drawn between two distinct wallets when EITHER:
 *   - they traded in BOTH directions (A→B and B→A appear), or
 *   - a single token round-tripped between them (the same token went A→B and
 *     later B→A, or returned to a prior owner passing through them).
 * These are the classic self-dealing fingerprints; a one-off A→B sale is NOT an
 * edge (that is ordinary demand). Clusters of size 1 are dropped.
 *
 * @param {object[]} sales  normalized sale objects (from `normalizeSale`)
 * @returns {{ clusterOf: Map<string,string>, clusters: Array }}
 */
export function buildTradeClusters(sales) {
  const uf = new UnionFind();
  const pairSeen = new Map(); // "a|b" (a<b) -> Set of directions seen
  const edgeWallets = new Set();

  for (const s of sales) {
    if (!s || s.seller === s.buyer) continue; // self-sales handled separately
    const a = s.seller;
    const b = s.buyer;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    const dir = `${a}>${b}`;
    const set = pairSeen.get(key) || new Set();
    set.add(dir);
    pairSeen.set(key, set);
  }

  // A reciprocal pair is any pair with >1 distinct direction OR the same
  // directed sale seen twice (a repeated directed trade between two wallets is
  // itself a strong self-dealing tell).
  const directedCount = new Map();
  for (const s of sales) {
    if (!s || s.seller === s.buyer) continue;
    const dk = `${s.seller}>${s.buyer}`;
    directedCount.set(dk, (directedCount.get(dk) || 0) + 1);
  }

  for (const [key, dirs] of pairSeen.entries()) {
    const [a, b] = key.split("|");
    const bidirectional = dirs.size >= 2;
    const repeatedOneWay =
      (directedCount.get(`${a}>${b}`) || 0) >= 2 ||
      (directedCount.get(`${b}>${a}`) || 0) >= 2;
    if (bidirectional || repeatedOneWay) {
      uf.union(a, b);
      edgeWallets.add(a);
      edgeWallets.add(b);
    }
  }

  // Group edge-connected wallets into components; keep only size >= 2.
  const byRoot = new Map();
  for (const w of edgeWallets) {
    const r = uf.find(w);
    const list = byRoot.get(r) || [];
    list.push(w);
    byRoot.set(r, list);
  }

  const clusterOf = new Map();
  const clusters = [];
  let idx = 0;
  for (const [, wallets] of byRoot.entries()) {
    if (wallets.length < 2) continue;
    const id = `wash-${idx++}`;
    for (const w of wallets) clusterOf.set(w, id);
    clusters.push({ id, wallets: wallets.slice().sort(), saleCount: 0, volumeEth: 0 });
  }

  // Attribute sales whose BOTH sides fall in the same cluster.
  const clusterById = new Map(clusters.map((c) => [c.id, c]));
  for (const s of sales) {
    if (!s || s.seller === s.buyer) continue;
    const cs = clusterOf.get(s.seller);
    const cb = clusterOf.get(s.buyer);
    if (cs && cs === cb) {
      const c = clusterById.get(cs);
      c.saleCount += 1;
      if (s.price != null) c.volumeEth += s.price;
    }
  }

  clusters.sort((a, b) => b.wallets.length - a.wallets.length);
  return { clusterOf, clusters };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Wash trading / self-dealing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Descriptive wash-trade measurement over recent sales. Self-gates when there
 * are no comparable sales. Never accuses — it reports counts and shares.
 *
 * @param {object[]} salesInput  raw sale rows (activity-feed or price-history shape)
 * @returns {object}
 */
export function analyzeWashTrading(salesInput, { observedAt } = {}) {
  const rawList = Array.isArray(salesInput) ? salesInput : [];
  const sales = rawList.map(normalizeSale).filter(Boolean);
  const usable = sales.length;

  if (usable === 0) {
    return {
      measured: false,
      reason:
        rawList.length > 0
          ? "Sales are present but none carry both a full buyer and seller address, so self-dealing cannot be compared."
          : "No sales in the observed window.",
      totalSales: rawList.length,
      comparableSales: 0,
    };
  }

  // Self-sales (buyer === seller) — reuse the audited primitive.
  let selfSaleCount = 0;
  let selfSaleVolume = 0;
  const suspectIdx = new Set();
  let totalVolume = 0;
  let pricedSales = 0;

  sales.forEach((s, i) => {
    if (s.price != null) {
      totalVolume += s.price;
      pricedSales += 1;
    }
    if (isSelfSale({ fromFull: s.seller, toFull: s.buyer })) {
      selfSaleCount += 1;
      if (s.price != null) selfSaleVolume += s.price;
      suspectIdx.add(i);
    }
  });

  const { clusterOf, clusters } = buildTradeClusters(sales);

  // Cluster-internal sales (both sides in the same coordinated cluster).
  let clusterSaleCount = 0;
  let clusterVolume = 0;
  sales.forEach((s, i) => {
    if (s.seller === s.buyer) return;
    const cs = clusterOf.get(s.seller);
    const cb = clusterOf.get(s.buyer);
    if (cs && cs === cb) {
      clusterSaleCount += 1;
      if (s.price != null) clusterVolume += s.price;
      suspectIdx.add(i);
    }
  });

  // Round-trip tokens: a token whose ownership returned to a prior owner within
  // the window. Ordered by time when available, else by array order.
  const byToken = new Map();
  const ordered = sales
    .map((s, i) => ({ s, i }))
    .sort((a, b) => (a.s.time ?? a.i) - (b.s.time ?? b.i));
  let roundTripTokens = 0;
  let rapidRetradeTokens = 0;
  const tokenTradeCount = new Map();
  for (const { s } of ordered) {
    if (!s.tokenId) continue;
    tokenTradeCount.set(s.tokenId, (tokenTradeCount.get(s.tokenId) || 0) + 1);
    const owners = byToken.get(s.tokenId) || [];
    if (owners.includes(s.buyer)) {
      // buyer previously owned/handled this token -> a round trip
      const prev = byToken.get(`${s.tokenId}::flag`);
      if (!prev) {
        roundTripTokens += 1;
        byToken.set(`${s.tokenId}::flag`, true);
      }
    }
    owners.push(s.seller);
    byToken.set(s.tokenId, owners);
  }
  for (const [, count] of tokenTradeCount.entries()) {
    if (count >= 3) rapidRetradeTokens += 1;
  }

  // Suspect volume = union of self-sale + cluster-internal (already de-duped via suspectIdx).
  let suspectVolume = 0;
  suspectIdx.forEach((i) => {
    if (sales[i].price != null) suspectVolume += sales[i].price;
  });

  const round = (x) => Math.round(x * 1e6) / 1e6;

  return {
    measured: true,
    observedAt: observedAt ?? Math.floor(Date.now() / 1000),
    totalSales: rawList.length,
    comparableSales: usable,
    pricedSales,
    totalVolumeEth: round(totalVolume),
    selfSales: {
      count: selfSaleCount,
      shareOfSales: usable > 0 ? selfSaleCount / usable : 0,
      volumeEth: round(selfSaleVolume),
    },
    coordinatedClusters: {
      count: clusters.length,
      largestSize: clusters.length ? clusters[0].wallets.length : 0,
      internalSales: clusterSaleCount,
      internalVolumeEth: round(clusterVolume),
      clusters: clusters.map((c) => ({
        wallets: c.wallets,
        size: c.wallets.length,
        saleCount: c.saleCount,
        volumeEth: round(c.volumeEth),
      })),
    },
    roundTripTokens,
    rapidRetradeTokens,
    suspect: {
      sales: suspectIdx.size,
      shareOfSales: usable > 0 ? suspectIdx.size / usable : 0,
      volumeEth: round(suspectVolume),
      shareOfVolume: totalVolume > 0 ? suspectVolume / totalVolume : 0,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Floor concentration (reuses the detection core over sellers)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Descriptive floor-concentration measurement: among the `depth` cheapest active
 * listings, how few wallets supply them? A floor propped by one or two wallets
 * (a "wall") is thin. Concentration math is delegated to the detection core by
 * feeding sellers as holders whose "balance" is their count of floor listings.
 *
 * @param {object[]} listingsInput  listing rows: { price:number, maker:address }
 * @param {{depth?:number, observedAt?:number}} opts
 */
export function analyzeFloorConcentration(listingsInput, { depth = 100, observedAt } = {}) {
  const list = (Array.isArray(listingsInput) ? listingsInput : [])
    .map((l) => ({ price: normPrice(l && l.price), maker: normAddr(l && l.maker) }))
    .filter((l) => l.price != null);

  if (list.length === 0) {
    return { measured: false, reason: "No active listings to measure." };
  }

  const sorted = list.slice().sort((a, b) => a.price - b.price);
  const floor = sorted.slice(0, Math.max(1, depth));
  const floorPrice = floor[0].price;

  // Listings whose maker address is missing can't be attributed to a seller —
  // reported as a coverage gap, not silently counted as a distinct seller.
  const attributed = floor.filter((l) => l.maker);
  const unattributed = floor.length - attributed.length;

  const bySeller = new Map();
  for (const l of attributed) bySeller.set(l.maker, (bySeller.get(l.maker) || 0) + 1);
  const distinctSellers = bySeller.size;

  // Price walls: a single price level stacked by few sellers.
  const byPrice = new Map();
  for (const l of attributed) {
    const k = l.price.toFixed(6);
    const rec = byPrice.get(k) || { price: l.price, count: 0, sellers: new Set() };
    rec.count += 1;
    rec.sellers.add(l.maker);
    byPrice.set(k, rec);
  }
  let largestWall = null;
  for (const rec of byPrice.values()) {
    if (rec.count >= 3 && (!largestWall || rec.count > largestWall.count)) {
      largestWall = { price: rec.price, count: rec.count, sellers: rec.sellers.size };
    }
  }

  // Concentration NUMBERS come from the shared core's metric primitives (HHI /
  // effective-count / top-N over seller shares). We do NOT reuse the core's
  // 3-band verdict here: its ramps are calibrated for token HOLDER counts
  // (hundreds), whereas a floor is supplied by a handful of sellers, so a
  // token-scaled band would read "concentrated" for a perfectly healthy floor.
  // The floor band below keys on the single interpretable fact — what share of
  // the cheapest listings the top wallet(s) supply — and is labelled heuristic.
  const shares = [...bySeller.values()]
    .map((c) => c / attributed.length)
    .sort((a, b) => b - a);
  const hhi = computeHHI(shares);
  const topSellerShare = shares[0] ?? 0;
  const top3SellerShare = topNShare(shares, 3);

  let band = "well-distributed";
  if (topSellerShare >= 0.5 || top3SellerShare >= 0.75) band = "concentrated";
  else if (topSellerShare >= 0.25 || top3SellerShare >= 0.5) band = "mixed";
  const bandReason =
    distinctSellers === 0
      ? "No attributable sellers on the floor."
      : `Top wallet supplies ${(topSellerShare * 100).toFixed(0)}% and the top 3 supply ${(top3SellerShare * 100).toFixed(0)}% of the ${attributed.length} cheapest listings.`;

  return {
    measured: true,
    observedAt: observedAt ?? Math.floor(Date.now() / 1000),
    floorPriceEth: floorPrice,
    depth: floor.length,
    attributedListings: attributed.length,
    unattributedListings: unattributed,
    distinctSellers,
    effectiveSellers: effectiveHolders(hhi),
    hhi,
    topSellerShare,
    top3SellerShare,
    band,
    bandReason,
    largestWall,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Wallet-cluster ownership (delegates to the detection core)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ownership-concentration measurement over the collection's owner set, with the
 * wash-graph clusters overlaid so the core's `clusteredSupplyShareOfTotal`
 * reflects coordinated (self-dealing) wallets. Delegates ALL concentration math
 * to `analyzeDistribution`.
 *
 * @param {{owners:{address:string,count:number}[], totalSupply?:number,
 *          clusterOf?:Map<string,string>, observedAt?:number}} params
 */
export function analyzeOwnershipConcentration({ owners, totalSupply, clusterOf, observedAt } = {}) {
  const list = Array.isArray(owners) ? owners : [];
  const holders = list
    .map((o) => {
      const address = normAddr(o && o.address);
      const count = Number(o && o.count);
      if (!address || !Number.isFinite(count) || count <= 0) return null;
      return {
        address,
        balance: BigInt(Math.trunc(count)),
        clusterId: clusterOf ? clusterOf.get(address) ?? null : null,
      };
    })
    .filter(Boolean);

  if (holders.length === 0) {
    return { measured: false, reason: "No owner data to measure." };
  }

  const supply =
    Number.isFinite(totalSupply) && totalSupply > 0 ? BigInt(Math.trunc(totalSupply)) : undefined;

  const analysis = analyzeDistribution({
    holders,
    chain: "ethereum",
    totalSupply: supply,
    observedAt,
    // NFT ownership carries no mint/freeze/LP hard facts — leave them unknown so
    // those gate findings never fire (unknown is not a red flag). The single-
    // holder-majority and cluster gates still apply and ARE meaningful for NFTs.
  });

  return { measured: true, analysis };
}

// ─────────────────────────────────────────────────────────────────────────────
// Top-level orchestration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run all three measurements over already-fetched data and return a combined,
 * JSON-safe descriptive object. Each section self-gates independently, so a
 * missing feed degrades one panel rather than blanking the surface.
 */
export function computeMarketIntegrity({
  sales = [],
  listings = [],
  owners = [],
  totalSupply,
  floorDepth = 100,
  observedAt,
} = {}) {
  const ts = observedAt ?? Math.floor(Date.now() / 1000);
  const wash = analyzeWashTrading(sales, { observedAt: ts });
  const clusterOf = wash.measured ? buildTradeClusters(sales.map(normalizeSale).filter(Boolean)).clusterOf : new Map();
  const floor = analyzeFloorConcentration(listings, { depth: floorDepth, observedAt: ts });
  const ownership = analyzeOwnershipConcentration({ owners, totalSupply, clusterOf, observedAt: ts });

  // Data-confidence roll-up (separate from any per-section verdict).
  const gaps = [];
  if (!wash.measured) gaps.push("wash-trade signal unavailable");
  else if (wash.comparableSales < 20)
    gaps.push(`only ${wash.comparableSales} comparable sales in window`);
  if (!floor.measured) gaps.push("floor listings unavailable");
  if (!ownership.measured) gaps.push("owner set unavailable");
  else if (ownership.analysis.confidence.level !== "high")
    gaps.push(`ownership data-confidence is ${ownership.analysis.confidence.level}`);

  return {
    method: {
      version: INTEGRITY_METHOD_VERSION,
      description:
        "NFT market-integrity measurement: recent self-dealing / wash-trade signals over sales, floor concentration over active listings, and owner-set concentration (with coordinated-wallet overlay) via the shared distribution core. Descriptive, point-in-time, not a verdict on intent.",
    },
    observedAt: ts,
    wash,
    floor,
    ownership,
    dataConfidence: {
      level: gaps.length === 0 ? "high" : gaps.length <= 1 ? "medium" : "low",
      gaps,
    },
    correctionPath:
      "Labels, cluster assignments and self-dealing flags are heuristic and point-in-time, derived from a limited recent window (no full historical index is deployed). If a wallet is infrastructure (marketplace escrow, bridge, treasury) or a flag is wrong, submit a correction so the measurement can be revised.",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Network adapter (the ONLY impure export) — full owner set, paginated.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch the full owner→count list for a contract via the existing Alchemy proxy
 * (`getOwnersForContract` with token balances), following `pageKey` pagination.
 *
 * Returns REAL data only — on failure it throws. It never substitutes the
 * fabricated FALLBACK_WHALES that the display-oriented `fetchTopHolders` uses,
 * because an integrity measurement on invented owners would be a lie.
 *
 * @returns {Promise<{owners:{address:string,count:number}[], totalOwners:number, truncated:boolean}>}
 */
export async function fetchCollectionOwners({ contract, signal, maxPages = 8 } = {}) {
  if (!contract) throw new Error("fetchCollectionOwners: contract is required");
  const owners = [];
  let pageKey;
  let pages = 0;
  let truncated = false;

  do {
    const params = { contractAddress: contract, withTokenBalances: "true" };
    if (pageKey) params.pageKey = pageKey;
    const data = await alchemyGet("getOwnersForContract", params, { signal });
    for (const o of data.owners || []) {
      const address = o.ownerAddress;
      const count = Array.isArray(o.tokenBalances) ? o.tokenBalances.length : 0;
      if (address && count > 0) owners.push({ address, count });
    }
    pageKey = data.pageKey || null;
    pages += 1;
    if (pageKey && pages >= maxPages) {
      truncated = true;
      break;
    }
  } while (pageKey);

  owners.sort((a, b) => b.count - a.count);
  return { owners, totalOwners: owners.length, truncated };
}
