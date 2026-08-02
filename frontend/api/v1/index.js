// ═══ DEVELOPER API v1 — NFT Data & Intelligence ═══
// Fills the Reservoir/SimpleHash gap. Battle-tested REST patterns
// from Alchemy, Nansen, and Reservoir's open API design.
//
// Endpoints:
//   GET /api/v1?route=collections&slug=nakamigos     → collection stats
//   GET /api/v1?route=listings&slug=nakamigos         → active listings
//   GET /api/v1?route=floor&contract=0x...            → floor price oracle
//   GET /api/v1?route=holders&contract=0x...          → top holders
//   GET /api/v1?route=activity&contract=0x...         → recent sales
//   GET /api/v1?route=token&contract=0x...&tokenId=1  → token metadata

import { checkRateLimit } from "../_lib/ratelimit.js";
import { readBoundedText, MAX_RESPONSE_BYTES } from "../_lib/bodycap.js";
import { logSafe } from "../_lib/logSafe.js";
import { fetchAlchemyWithFailover } from "../_lib/alchemy-failover.js";

// AUDIT R048: header auth — Alchemy NFT base URL drops the /${KEY} segment
// when a real key is configured; the bearer header is injected per-fetch.
// RESIL-1: fetches route through fetchAlchemyWithFailover so a lapsed primary
// key retries once with ALCHEMY_API_KEY_FALLBACK; builders are keyed per
// attempt (same convention as api/alchemy.js).
const ALCHEMY_KEY = process.env.ALCHEMY_API_KEY || "demo";
const ALCHEMY_NFT_ROOT = "https://eth-mainnet.g.alchemy.com/nft/v3";

function alchemyNftBaseFor(key) {
  return key ? ALCHEMY_NFT_ROOT : `${ALCHEMY_NFT_ROOT}/${ALCHEMY_KEY}`;
}
function alchemyAuthHeadersFor(key, extra = {}) {
  const headers = { Accept: "application/json", ...extra };
  if (key) headers["Authorization"] = `Bearer ${key}`;
  return headers;
}

const ALLOWED_CONTRACTS = new Set([
  "0xd774557b647330c91bf44cfeab205095f7e6c367", // Nakamigos
  "0xa1de9f93c56c290c48849b1393b09eb616d55dbb", // GNSS Art
  "0xd37264c71e9af940e49795f0d3a8336afaafdda9", // Jungle Bay
]);

const SLUG_TO_CONTRACT = {
  nakamigos: "0xd774557b647330c91bf44cfeab205095f7e6c367",
  gnssart: "0xa1de9f93c56c290c48849b1393b09eb616d55dbb",
  junglebay: "0xd37264c71e9af940e49795f0d3a8336afaafdda9",
};

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "https://nakamigos.gallery";

// ── Shared validation helpers ──
const ETH_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const NUMERIC_ID_RE = /^\d{1,10}$/;

function isValidAddress(addr) { return typeof addr === "string" && ETH_ADDRESS_RE.test(addr); }
function isValidTokenId(id) { return typeof id === "string" && NUMERIC_ID_RE.test(id); }

function setCors(req, res) {
  const origin = req.headers.origin || "";
  const prodOrigins = [
    "https://nakamigos.gallery",
    "https://www.nakamigos.gallery",
    "https://memetic.fun",
    "https://www.memetic.fun",
    "https://memetics.finance",
    "https://www.memetics.finance",
    "https://tegridyfarms.vercel.app",
  ];
  // AUDIT API-SEC: fail-closed — only admit localhost when NODE_ENV === "development".
  const devOrigins = process.env.NODE_ENV === "development"
    ? ["http://localhost:8742", "http://localhost:3000", "http://localhost:5173"]
    : [];
  const ALLOWED_ORIGINS = new Set([...prodOrigins, ...devOrigins]);
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGINS.has(origin) ? origin : ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-API-Key");
  res.setHeader("Vary", "Origin");
}

async function alchemyFetch(endpoint, params = {}) {
  const res = await fetchAlchemyWithFailover((key) => {
    const url = new URL(`${alchemyNftBaseFor(key)}/${endpoint}`);
    Object.entries(params).forEach(([k, v]) => {
      if (v != null && v !== "") url.searchParams.set(k, String(v));
    });
    return { url: url.toString(), opts: { headers: alchemyAuthHeadersFor(key) } };
  });
  if (!res.ok) throw new Error(`Alchemy ${res.status}`);
  // AUDIT R049 H-3: bounded body read.
  const { text, truncated } = await readBoundedText(res, MAX_RESPONSE_BYTES);
  if (truncated) throw new Error("upstream-too-large");
  return JSON.parse(text);
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  // AUDIT R049 H-2: real per-IP rate limit (was cosmetic-header-only).
  // 20 req/min — each v1 call fans out to 1-3 upstream Alchemy + OpenSea
  // calls, so the budget burns fast. Headers are set by checkRateLimit.
  const allowed = await checkRateLimit(req, res, {
    limit: 20, windowSec: 60, identifier: "v1",
  });
  if (!allowed) return;

  const { route, slug, contract: rawContract, tokenId, limit } = req.query;

  // Validate contract address format if provided directly
  if (rawContract && !isValidAddress(rawContract)) {
    return res.status(400).json({ error: "Invalid contract address format" });
  }

  // Validate slug if provided
  if (slug && !SLUG_TO_CONTRACT[slug]) {
    return res.status(400).json({ error: "Unknown collection slug" });
  }

  // Validate tokenId format if provided
  if (tokenId && !isValidTokenId(tokenId)) {
    return res.status(400).json({ error: "Invalid tokenId — must be numeric (max 10 digits)" });
  }

  // Resolve contract from slug or direct param
  const contract = rawContract?.toLowerCase() || (slug && SLUG_TO_CONTRACT[slug]) || null;

  if (!route) return res.status(400).json({ error: "Missing route parameter" });
  // The token scanner reads ANY ERC-20, not just the NFT collection allowlist. The
  // address FORMAT is still validated above (line 105); this only skips the collection
  // membership check for that one read-only route.
  if (contract && route !== "erc20scan" && !ALLOWED_CONTRACTS.has(contract)) {
    return res.status(403).json({ error: "Contract not supported" });
  }

  try {
    switch (route) {
      // Public token scanner — ANY ERC-20 (not the NFT allowlist). Proxies a holder-data
      // source server-side and normalizes to the scanner's shape. OPERATOR: Ethplorer
      // getTopTokenHolders usually needs a PAID key (public "freekey" may 403); set
      // ETHPLORER_API_KEY, or swap the upstream for Moralis/Covalent/Etherscan-Pro/the
      // Ponder index. The client self-gates until this returns data — never fabricates.
      case "erc20scan": {
        if (!contract) return res.status(400).json({ error: "Missing contract" });
        const EP_KEY = process.env.ETHPLORER_API_KEY || "freekey";
        const EP_BASE = "https://api.ethplorer.io";
        const holderLimit = Math.min(Math.max(1, parseInt(limit, 10) || 100), 100);
        const [infoRes, topRes] = await Promise.all([
          fetch(`${EP_BASE}/getTokenInfo/${contract}?apiKey=${EP_KEY}`, { headers: { Accept: "application/json" } }),
          fetch(`${EP_BASE}/getTopTokenHolders/${contract}?apiKey=${EP_KEY}&limit=${holderLimit}`, { headers: { Accept: "application/json" } }),
        ]);
        const { text: infoText, truncated: it } = await readBoundedText(infoRes, MAX_RESPONSE_BYTES);
        const { text: topText, truncated: tt } = await readBoundedText(topRes, MAX_RESPONSE_BYTES);
        if (it || tt) throw new Error("upstream-too-large");
        let info = null, top = null;
        try { info = JSON.parse(infoText); } catch { info = null; }
        try { top = JSON.parse(topText); } catch { top = null; }

        // ── EVERY READ HAS THREE OUTCOMES AND ONLY TWO ARE ANSWERS ────────────
        //   (a) read it, the answer is no   (b) read it, the answer is yes
        //   (c) COULD NOT READ IT
        // (c) is not a finding. This route is the end of the pipe that can CACHE
        // one: a degraded 200 gets stamped s-maxage=120 and served to everyone who
        // scans that token for the next two minutes, and the client renders a body
        // with no holders as "No holder data for this token — double-check the
        // address is a token (not a wallet or an NFT)". So (c) takes the uncached
        // failure path below, and only (a)/(b) are allowed to become a 200.

        /**
         * A base-unit integer as a digit string, or null when it cannot be read
         * EXACTLY. A JSON number past 2^53 had its low digits fabricated by the
         * parse itself, so there is nothing left there to read even though
         * `BigInt(Math.trunc(v))` returns a confident-looking integer.
         */
        const baseUnits = (v) => {
          if (typeof v === "string") return /^[0-9]+$/.test(v) ? v : null;
          if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? String(v) : null;
          return null;
        };

        // getTokenInfo carries the denominator every published percentage divides
        // by. An unparsable body is a failed read of ALL of it, not five nulls. An
        // ABSENT totalSupply is the route's documented gap and stays null (the
        // client leaves it undefined and the core falls back to the enumerated sum,
        // disclosed as an upper bound); a PRESENT one we cannot read is neither, and
        // must not go out as a mangled string — the client's `toBig` turned "1e+21"
        // into 121n and published 100% concentration off it.
        //
        // BOTH legs are checked, not just the holder one. Ethplorer reports a
        // rate-limit or a bad key as an {error:{code}} envelope under HTTP 429/200,
        // and `typeof envelope === "object"` is TRUE — so a typeof-object test alone
        // reads a throttled getTokenInfo as "the explorer did not report a total".
        // The two calls race one key in parallel, so exactly one of them being
        // rejected is routine (reproduced live on `freekey`). The consequence is not
        // a missing label: with no total, the core substitutes the enumerated
        // top-100 sum as the denominator, so every published share is inflated by
        // 1/coverage — measured at 1.216x on UNI's live top-100 — under a stat tile
        // captioned "of total supply", and a large-enough holder crosses the 50%
        // single-holder-majority gate and floors the band at `concentrated`. Cached
        // for 120s, then the same token reads clean once the quota resets.
        const infoOk = !!info && typeof info === "object";
        const infoError = infoOk ? info.error : null;
        const infoUnreadable = !infoOk || !!infoError || !infoRes.ok;
        const rawTotal = infoOk ? info.totalSupply : null;
        const totalSupply = rawTotal == null ? null : baseUnits(rawTotal);

        // Ethplorer hands us the exact integer in `rawBalance`. This ignored it and
        // rebuilt every balance from `share` — a percentage rounded to TWO decimals
        // — so each published balance carried a fixed ±0.005pp error whose RELATIVE
        // size explodes on small holders: measured on TOWELI's own live scan, one
        // holder was published 6.01% light (44,733 TOWELI), and any holder under
        // 0.005% rounds to a zero balance and vanishes from the set entirely.
        //
        // A row whose balance cannot be read is a failed read, not a row to drop:
        // dropping a holder understates concentration, the flattering direction, and
        // dropping ALL of them lands the client on "No holder data for this token".
        // A row that is not an EVM address can be attributed to nobody and stays
        // dropped — the only row-level drop left.
        const rows = top && typeof top === "object" && Array.isArray(top.holders) ? top.holders : null;
        let holders = rows ? [] : null;
        for (const h of rows || []) {
          const address = String((h && h.address) || "").toLowerCase();
          if (!/^0x[0-9a-f]{40}$/.test(address)) continue;
          const balance = baseUnits(h && h.rawBalance != null ? h.rawBalance : h && h.balance);
          if (balance === null) { holders = null; break; }
          holders.push({ address, balance, isContract: false });
        }
        // Rows arrived but NONE of them were attributable. An empty `holders: []` is
        // only an answer when the upstream itself said "nobody"; deriving one by
        // discarding every row it did send is the same laundering in slow motion —
        // the client reads it as "No holder data for this token" and the CDN keeps
        // that for 120s. Non-empty in, empty out, is drift.
        if (rows && rows.length > 0 && holders !== null && holders.length === 0) holders = null;

        // A 200 carrying a CDN interstitial or a gateway HTML page is the ordinary
        // way an upstream fails WITHOUT a non-2xx, and an Ethplorer {error:{code}}
        // envelope is how it reports a bad key or a rate-limit. Both used to fall
        // through `catch { top = {} }` / `(top.holders || [])` into a cached 200
        // carrying `holders: []`. A `holders: []` that IS present still succeeds —
        // that is the read working and the answer being nobody.
        // Which of these holders are CONTRACTS? Ethplorer does not say, and the old
        // `!!h.isContract` therefore evaluated to `false` for every row — so the
        // detection core's exclusion pass (LP pairs, CEX wallets, bridges, lockers,
        // vaults) ran and matched nothing, and every pool was counted as a person.
        // Measured on TOWELI's own live scan: 15 of the top 100 have code, including
        // the LARGEST at 27.47% — the Uniswap V2 pair — and the staking contract at
        // 5.1%. That published "largest holder 27.47%" where the largest PERSON holds
        // 3.71%, and 6.0 effective holders against a real 23.1.
        //
        // Fail-closed on purpose: an unreadable code batch is an unreadable read, and
        // a distribution verdict whose exclusion pass silently did not run is the
        // defect this whole route has been fixing. The chain walks a configured
        // Alchemy key then three keyless public nodes, so every URL failing means
        // something is genuinely wrong rather than one node being slow.
        let codeReadFailed = false;
        if (holders !== null && holders.length > 0) {
          try {
            const { fetchContractFlags } = await import("../_lib/eth-code.js");
            const flags = await fetchContractFlags(holders.map((h) => h.address));
            for (const h of holders) h.isContract = flags.get(h.address) === true;
          } catch (err) {
            console.error("erc20scan eth_getCode failed:", logSafe(err));
            codeReadFailed = true;
          }
        }

        const epError = top && typeof top === "object" ? top.error : null;
        const unreadable =
          infoUnreadable || (rawTotal != null && totalSupply === null) || holders === null || codeReadFailed;
        if (!topRes.ok || epError || unreadable) {
          // Ethplorer code 1 = invalid API key. Map auth failures to 403, which
          // the client renders as the honest "scanner not enabled on this
          // deployment yet" state (needs a paid ETHPLORER_API_KEY). Everything
          // else is a transient upstream failure → 502. Neither is cached.
          const isAuth = topRes.status === 401 || topRes.status === 403 || (epError && Number(epError.code) === 1);
          res.setHeader("Cache-Control", "no-store");
          return res.status(isAuth ? 403 : 502).json({
            error: isAuth
              ? "Holder data source is not enabled on this deployment"
              : "Holder data source is temporarily unavailable — try again shortly",
          });
        }

        // `decimals` and `holdersCount` are the two fields an unreadable value may
        // stay null for: neither feeds a metric, and a null holdersCount makes the
        // scanner disclose `top-n` coverage — the conservative direction.
        const decimals = parseInt(info.decimals, 10);
        res.setHeader("Cache-Control", "s-maxage=120, stale-while-revalidate=300");
        return res.json({
          chain: "ethereum",
          contract,
          name: info.name || null,
          symbol: info.symbol || null,
          decimals: Number.isFinite(decimals) ? decimals : null,
          totalSupply,
          holdersCount: typeof info.holdersCount === "number" ? info.holdersCount : null,
          source: "ethplorer",
          holders,
        });
      }
      // ── Collection Stats ──
      case "collections": {
        if (!contract) return res.status(400).json({ error: "Missing slug or contract" });
        const [floor, meta, owners] = await Promise.all([
          alchemyFetch("getFloorPrice", { contractAddress: contract }),
          alchemyFetch("getContractMetadata", { contractAddress: contract }),
          alchemyFetch("getOwnersForContract", { contractAddress: contract, withTokenBalances: false }),
        ]);
        res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=120");
        return res.json({
          contract,
          slug: slug || null,
          floor: floor.openSea?.floorPrice ?? null,
          owners: owners.owners?.length ?? null,
          supply: parseInt(meta.contract?.totalSupply, 10) || null,
          name: meta.contract?.name || null,
          symbol: meta.contract?.symbol || null,
        });
      }

      // ── Floor Price Oracle ──
      case "floor": {
        if (!contract) return res.status(400).json({ error: "Missing contract" });
        const data = await alchemyFetch("getFloorPrice", { contractAddress: contract });
        res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
        return res.json({
          contract,
          floor: data.openSea?.floorPrice ?? null,
          marketplace: "opensea",
          timestamp: new Date().toISOString(),
        });
      }

      // ── Top Holders ──
      case "holders": {
        if (!contract) return res.status(400).json({ error: "Missing contract" });
        const data = await alchemyFetch("getOwnersForContract", {
          contractAddress: contract, withTokenBalances: true,
        });
        const holders = (data.owners || [])
          .map(o => ({ address: o.ownerAddress, count: o.tokenBalances?.length || 0 }))
          .sort((a, b) => b.count - a.count)
          .slice(0, Math.min(Math.max(1, parseInt(limit, 10) || 50), 200));
        res.setHeader("Cache-Control", "s-maxage=120, stale-while-revalidate=300");
        return res.json({ contract, holders });
      }

      // ── Recent Activity ──
      case "activity": {
        if (!contract) return res.status(400).json({ error: "Missing contract" });
        const data = await alchemyFetch("getNFTSales", {
          contractAddress: contract, order: "desc", limit: String(Math.min(Math.max(1, parseInt(limit, 10) || 20), 100)),
        });
        const sales = (data.nftSales || []).map(s => ({
          tokenId: s.tokenId,
          price: s.sellerFee?.amount ? Number(BigInt(s.sellerFee.amount) * 10000n / BigInt(1e18)) / 10000 : null,
          from: s.sellerAddress,
          to: s.buyerAddress,
          marketplace: s.marketplace,
          blockNumber: s.blockNumber,
          txHash: s.transactionHash,
        }));
        res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
        return res.json({ contract, sales });
      }

      // ── Token Metadata ──
      case "token": {
        if (!contract || !tokenId) return res.status(400).json({ error: "Missing contract or tokenId" });
        // Validate tokenId is a reasonable numeric string (prevents injection/abuse)
        if (!/^\d{1,10}$/.test(tokenId)) return res.status(400).json({ error: "Invalid tokenId" });
        const data = await alchemyFetch("getNFTMetadata", {
          contractAddress: contract, tokenId,
        });
        res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
        return res.json({
          contract,
          tokenId: data.tokenId,
          name: data.name || `#${data.tokenId}`,
          image: data.image?.cachedUrl || data.image?.originalUrl || null,
          attributes: (data.raw?.metadata?.attributes || []).map(a => ({
            key: a.trait_type, value: a.value,
          })),
          owner: data.owners?.[0] || null,
        });
      }

      // ── Active Listings (proxy to OpenSea) ──
      case "listings": {
        const s = slug || Object.keys(SLUG_TO_CONTRACT).find(k => SLUG_TO_CONTRACT[k] === contract);
        if (!s) return res.status(400).json({ error: "Missing slug" });
        // Validate slug against known slugs to prevent path traversal attacks
        if (!SLUG_TO_CONTRACT[s]) return res.status(400).json({ error: "Unknown collection slug" });
        const osKey = process.env.OPENSEA_API_KEY || "";
        const headers = { Accept: "application/json" };
        if (osKey) headers["x-api-key"] = osKey;
        const safeLimit = Math.min(Math.max(1, parseInt(limit, 10) || 20), 100);
        const osRes = await fetch(
          `https://api.opensea.io/api/v2/listings/collection/${s}/best?limit=${safeLimit}`,
          { headers },
        );
        if (!osRes.ok) throw new Error(`OpenSea ${osRes.status}`);
        // AUDIT R049 H-3: bounded body read.
        const { text, truncated } = await readBoundedText(osRes, MAX_RESPONSE_BYTES);
        if (truncated) throw new Error("upstream-too-large");
        let osData;
        try {
          osData = JSON.parse(text);
        } catch {
          throw new Error("OpenSea returned non-JSON response");
        }
        const listings = (osData.listings || []).map(l => {
          const offer = l.protocol_data?.parameters?.offer?.[0];
          const priceWei = l.price?.current?.value;
          return {
            tokenId: offer?.identifierOrCriteria || null,
            price: priceWei ? Number(BigInt(priceWei) * 10000n / BigInt(1e18)) / 10000 : null,
            maker: l.protocol_data?.parameters?.offerer || null,
            marketplace: "opensea",
            orderHash: l.order_hash || null,
          };
        }).filter(l => l.tokenId && l.price);
        res.setHeader("Cache-Control", "s-maxage=15, stale-while-revalidate=30");
        return res.json({ slug: s, listings });
      }

      default:
        return res.status(400).json({ error: "Unknown route" });
    }
  } catch (err) {
    console.error("API v1 error:", logSafe(err));
    return res.status(500).json({ error: "Internal error" });
  }
}
