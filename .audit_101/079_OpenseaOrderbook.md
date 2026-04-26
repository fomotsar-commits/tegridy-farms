# Agent 079 — frontend/api/opensea.js & frontend/api/orderbook.js

**Scope:** AUDIT-ONLY forensic review of the two Vercel serverless proxies.
**Targets:**
- `frontend/api/opensea.js` (195 LOC) — proxies OpenSea v2 endpoints, hides API key.
- `frontend/api/orderbook.js` (524 LOC) — native Seaport-compatible orderbook backed by Supabase.

Hunt list applied: API-key leakage, response-schema validation, order spoofing, authoritative pricing, CORS, rate-limit, SSRF via slug, NFT metadata XSS, listing image trust, BigInt/Number price overflow, pagination cap, retry storm, error infra leakage.

---

## Counts

| Severity | Count |
| --- | --- |
| HIGH | 3 |
| MEDIUM | 6 |
| LOW | 4 |
| INFO | 4 |
| **Total** | **17** |

---

## HIGH-severity findings

### H1. OpenSea proxy returns full upstream response body to caller without schema validation (price/poison/XSS vector)
**File:** `frontend/api/opensea.js:171-190`
**Code:**
```js
const response = await fetch(url.toString(), fetchOpts);
const text = await response.text();
let data;
try { data = JSON.parse(text); } catch { ... return 502; }
if (!response.ok) { ... return 502; }
res.setHeader("Cache-Control", "s-maxage=15, stale-while-revalidate=30");
return res.status(200).json(data);
```
**Issue:** The proxy validates *path* and *contract* on the way in, but the response from OpenSea is forwarded verbatim. There is **no schema validation, no price-range sanity check, no field whitelisting.** Consequences:

1. **Poisoned listing prices crash UI:** if OpenSea (or anything between us and OpenSea via CDN cache poisoning / a hijacked-DNS scenario) returns a `current_price` like `"99e999"` or `"-1"` or a non-numeric string, downstream UI that does `BigInt(price)` or `parseFloat(price)*ethPrice` will throw or return `Infinity`/`NaN`. The 15s edge-cache (`s-maxage=15`) means a single poisoned hit is served to *every* user for 15 seconds.
2. **Pricing data shown as authoritative:** front-end consumers read `data.listings[*].price.current` and use it for "lowest listing" callouts. There is no second-source comparison and no allow-list of price magnitudes. A listing of e.g. `0xdead` token at 1e-18 ETH would float to the top of price-asc views.
3. **NFT metadata pass-through XSS / image-src trust:** `data.nft.image_url`, `name`, `description`, `external_url`, etc. flow through to the client unscathed. Any consumer doing `dangerouslySetInnerHTML`, `<img src={url}>` (where `url` may be `javascript:` or a data URI), or React Router `<a href={url}>` is exposed. The proxy explicitly *advertises* itself as the "validated" boundary, but does no content sanitization.
4. **Authoritative-pricing risk for liquidation:** if any contract or off-chain bot uses these prices as a liquidation feed (e.g. NFT collateralized loans), an attacker who gets a single bad price into the cache during the 15s window can trigger liquidations.

**Recommendation:** define a strict per-endpoint Zod/io-ts schema, drop unknown keys, range-check `current_price`/`startAmount`/`endAmount` (must fit into BigInt and be ≤ a configurable per-collection sanity ceiling, e.g. 10000 ETH), reject responses on schema failure with 502, never let raw `image_url`/`description`/`animation_url` strings through without `URL`-parse + scheme allow-list (`http`, `https`, `ipfs`, `ar`).

---

### H2. Orderbook `create` action forwards client-supplied `seaportSignature` and `parameters` to DB without verifying they form a valid on-chain Seaport order
**File:** `frontend/api/orderbook.js:298-374`
**Code:**
```js
const createMessage = `Create order for ${params.offerer.toLowerCase()} | ... | Price: ${authPriceWei} | StartTime: ${startSec} | EndTime: ${endSec}`;
recoveredCreator = (await recoverMessageAddress({ message: createMessage, signature: order.signature })).toLowerCase();
if (recoveredCreator !== params.offerer.toLowerCase()) return res.status(403)...
...
const { error } = await supabase.from("native_orders").insert({
  ...,
  signature: order.seaportSignature || order.signature, // <-- accepted without verification
  parameters: params,
  ...
});
```
**Issue:** the **`personal_sign` "Create order for X | ... | Price: P"** message is verified against `params.offerer`, but the **Seaport EIP-712 signature** that will actually be used on-chain (`order.seaportSignature`) is never recovered against the `parameters` it's supposed to authorize. An attacker can:

1. Sign the personal_sign auth message correctly (proves they control offerer wallet).
2. Submit `parameters` referencing **someone else's NFT** (e.g. another user's `tokenId` they haven't approved) along with a junk `seaportSignature`.
3. The server stores it. Browse views show "Listing exists for tokenId 1234 — 0.001 ETH" pointing to a wallet that doesn't even own 1234. This is **order spoofing / fake-listing griefing** — exactly the threat in the hunt list.

The personal_sign auth is sufficient to prove "this offerer wallet asked us to insert this row," but the row presented as a *valid Seaport listing* needs `recoverTypedDataAddress({ domain: SeaportDomain, types: SeaportOrderTypes, primaryType: "OrderComponents", message: params, signature: seaportSignature }) === params.offerer`. Without that, the server is a **trusted echo** of unverified Seaport data — Reservoir-pattern orderbooks always do the EIP-712 recovery server-side.

Additionally there is **no on-chain ownership check** — `params.offer[0].token + identifierOrCriteria` is never queried against ERC-721 `ownerOf`. So even with a valid seaportSignature an attacker who *previously* owned a token but has since transferred it could create stale listings for it.

**Recommendation:** call `recoverTypedDataAddress` against the Seaport domain separator + typehash, recovering from `seaportSignature` and matching `params.offerer`; then call Alchemy `eth_call` to `ownerOf(tokenId)` and confirm it equals `offerer` (or for ERC-1155, `balanceOf(offerer, id) > 0`). Reject otherwise with 403.

---

### H3. `price_eth` is computed via `Number(BigInt * 1e8 / divisor) / 1e8` — silent precision loss + `Number(BigInt)` overflow on 18-decimal large prices, then used as the SQL `ORDER BY` key
**File:** `frontend/api/orderbook.js:284-286`, sort path at `:166`
**Code:**
```js
const divisor = BigInt(10) ** BigInt(decimals);
const priceBig = BigInt(priceWei);
const priceEth = Number((priceBig * 100000000n) / divisor) / 100000000;
...
.order(safeSort, { ascending: safeSort === "price_eth" })
```
**Issue:**
1. `priceBig * 100000000n` for a `priceWei` of e.g. `2^256-1` (which an attacker can submit; there's no upper bound on `startAmount`) is a finite BigInt but `Number((huge BigInt) / divisor)` will round to `+Infinity` once it exceeds `Number.MAX_SAFE_INTEGER` (≈ 9e15). For an 18-decimal currency that's any price ≥ ~9e15 / 1e8 = 9e7 ETH — implausible for honest users, **trivial for an attacker** who wants to poison the price_eth column with `Infinity` / `NaN`.
2. The computed `priceEth` is stored to a Postgres `numeric` column (per the SQL comment at `:49`). If JS coerces it to `Infinity` then `JSON.stringify(Infinity)` is `null`, and Supabase will store `NULL`. The `ORDER BY price_eth ASC` query then returns nulls last by default, but the row still exists and can be fetched by `tokenId`/`maker` filters with bogus `price_eth: null`. UI showing "lowest price" can break.
3. There is **no upper bound** on `startAmount` (no `priceWei < 2^96` ceiling). Combined with no schema-validation downstream, this is the integer-overflow vector the hunt list calls out.

**Recommendation:** clamp `priceWei` to a sane max (e.g. `2^96 - 1` wei for ETH, ~7.9e10 ETH); reject if exceeded. Compute `priceEth` as a string (e.g. via `formatUnits`) and store it; do `ORDER BY` on a numeric column populated only after passing the clamp. Or store everything as text and sort lexicographically with zero-padding.

---

## MEDIUM-severity findings

### M1. Retry storm on upstream rate-limit — `opensea.js` does not honor `Retry-After`, no backoff, no circuit-breaker
**File:** `frontend/api/opensea.js:171-187`
**Issue:** when OpenSea returns 429, the proxy collapses to a generic 502 and logs the status. Front-end clients (`useOpenSeaListings`, etc.) typically auto-retry on 5xx. Because *every* user hitting the proxy during the 429 window will see a 502 and retry, and the proxy has no shared circuit-breaker, this amplifies upstream pressure and burns through the OpenSea quota faster than necessary. Worse: 502 hides the actual `Retry-After` header from the client, so smart clients can't back off. **Recommendation:** preserve upstream 429 + `Retry-After` (don't expose body), add per-instance circuit breaker (e.g. open-cell for 30s on three 429s), back off exponentially.

### M2. Per-IP rate limits won't stop a coordinated booklet spam — orderbook spam-grief vector
**File:** `frontend/api/orderbook.js:121-124`, `:336-344`
**Issue:** 40 req/min per-IP + 20 orders/hour per-maker is fine for a single attacker on a single wallet. But the orderbook trusts personal_sign as authentication; an attacker generates 1000 hot-wallets and spreads requests across IPs (cheap on residential proxies). 1000 wallets * 20 orders/hour = 20k spam listings/hour, all of which pass the H2 spoofing path. Combined with H2, this is a **fake-listing flood**. **Recommendation:** add wallet-age check (refuse first-time wallets without ≥ 0.001 ETH on-chain history), require ownership-proof RPC call, and cap *active* listings per-maker (not just hourly creates).

### M3. `params.endTime` only checked `> startTime + already-expired` — no upper bound
**File:** `frontend/api/orderbook.js:222-230`
**Issue:** `endSec` can be `Number.MAX_SAFE_INTEGER`. `new Date(endSec * 1000).toISOString()` will throw `RangeError: Invalid time value` for years > 275760, returning a 500 to the client and leaking the `Internal error` line via `console.error`. More importantly, listings that "never expire" pollute the `idx_orders_price` index forever — with `WHERE status = 'active'` only flushing on cancel/fill, an attacker can permanently squat the lowest-price slot. **Recommendation:** clamp `endSec - startSec ≤ 90 days` (or any sane policy).

### M4. No pagination cap on Supabase `select("*")` returns full row including `signature` + `parameters`
**File:** `frontend/api/orderbook.js:155-189`
**Issue:** the GET query returns the **full** order row including `signature` (the personal_sign), `parameters` (the full Seaport tuple), `protocol_address`, etc. Combined with `safeLimit ≤ 200`, an attacker scraping `?action=query&contract=...&sort=created_at&limit=200&maker=<victim>` can enumerate every signature a maker has ever signed. The personal_sign string is `Create order for X | ... | Price: P | StartTime: T1 | EndTime: T2` — predictable enough that the signature is mostly only useful as an auth token here, but exposing other users' signatures is unnecessary. Worse, `parameters.salt` / `zone` may leak future fingerprints. **Recommendation:** project only public columns (`order_hash, contract_address, token_id, maker, price_wei, price_eth, currency, end_time, status, parameters` reduced to what UI needs — drop `signature`, `seaportSignature`, internal fields).

### M5. `cancel` and `fill` are not bound to a fresh `nonce`/timestamp — replay window
**File:** `frontend/api/orderbook.js:388`, `:434`
**Issue:** `cancelMessage = "Cancel order ${orderHash}"` and `fillMessage = "Fill order ${orderHash} tx ${txHash}"` are **time-independent**. If a maker ever signs a cancel (e.g. they cancel, then re-list with a new salt — the orderHash changes for the new one but the *old* hash is reusable forever for cancel). For `fill`, the txHash binds it, but a captured signature can be replayed by any IP since the tx-on-chain check passes regardless of who replays. Combined with the H2 `seaportSignature` being unverified, a captured signature pair from one user could be paired with another user's params. **Recommendation:** include `nonce` (random server-issued challenge) or current `chainHead/timestamp` in the auth message; rotate per call.

### M6. `eth_getTransactionReceipt` fetched without timeout / size cap → Slowloris on Alchemy outage
**File:** `frontend/api/orderbook.js:446-450`
**Issue:** no `AbortController`, no `signal: AbortSignal.timeout(...)`. If Alchemy is slow (multi-second TTFB), every concurrent fill request occupies a serverless lambda for the full duration. With Vercel's 10s Hobby / 60s Pro defaults, this trivially exhausts concurrency and bills heavily. **Recommendation:** `signal: AbortSignal.timeout(5000)`, and reject responses larger than a threshold via `Content-Length` check.

---

## LOW-severity findings

### L1. `OPENSEA_API_KEY` empty-string fallback leaks usage profile to OpenSea
**File:** `frontend/api/opensea.js:4-7`
**Issue:** if env var is unset, the warning logs once but every subsequent request omits `x-api-key`. Unauthenticated OpenSea requests are still *accepted* under their public ratelimit, but the project's traffic mixes with anonymous traffic and OpenSea sees no consistent key — operators may be unaware that key-rotation isn't actually in effect. **Recommendation:** fail-closed in production (`if (process.env.NODE_ENV === "production" && !OPENSEA_KEY) return 503`).

### L2. `ALLOWED_PATH_PREFIXES` allows `events/<anything>`, `offers/<anything>` — looser than intended
**File:** `frontend/api/opensea.js:46`
**Issue:** the `path.startsWith(prefix)` check means `events/foo`, `events/../admin` (the decoded check at `:40` blocks `..` literal, but `events/admin/anything` passes). The downstream `for (const slug of ALLOWED_SLUGS)` provides exact matches but the *prefix* fallback at `:46` already returned `true` for `events/anyslug-not-in-list`. Reading the code carefully, after the prefix check we *don't* return true unconditionally — we fall into the slug loop. But the slug loop only allows specific subpaths; if none match, function returns `false`. So this is actually OK — but the structure is brittle: future maintainers adding a new prefix pattern likely won't realize the slug-loop must exhaustively cover it. **Recommendation:** invert: build an exact-match `Set` of all allowed paths, drop the prefix check entirely.

### L3. `params.token_ids` regex `/^\d{1,10}$/` rejects multi-id queries
**File:** `frontend/api/opensea.js:143`
**Issue:** OpenSea v2 supports `token_ids=1,2,3` (comma-separated). The single-id regex silently rejects the multi-id form. Not a security bug — a functional one — but worth flagging because the audit list mentions schema validation. **Recommendation:** allow `^(\d{1,10})(,\d{1,10}){0,49}$` if multi-id queries are intended; else document the single-id constraint.

### L4. Errors from Supabase `update`/`insert` are logged with `error.message` — Supabase error messages occasionally include constraint names / column names
**File:** `frontend/api/orderbook.js:186, 376, 403, 418, 505`
**Issue:** the **client** only sees `"Internal error"` (good), but the **logs** include the raw Supabase message which can include schema details (`"duplicate key value violates unique constraint native_orders_pkey"`, etc.). If logs are exposed via Vercel observability to a wider audience than expected, schema info leaks. **Recommendation:** log a sanitized fingerprint (`error.code`) + a UUID for correlation, full details only to a secure logger.

---

## INFO-severity findings

### I1. `ALLOWED_ORIGIN` env-var default is `https://nakamigos.gallery` — dual-domain ambiguity
**File:** `opensea.js:64`, `orderbook.js:81`
**Note:** the fallback origin doesn't match the project's apparent primary domain `tegridyfarms.xyz`. Not a bug — but if env is unset and a request comes from a non-allowed origin, the response advertises `nakamigos.gallery` as canonical. If both domains are owned by the project, fine; if `nakamigos.gallery` is ever transferred away, the CORS header will silently still point there.

### I2. `MAX_BODY_SIZE = 10 * 1024` — fine, but set after `JSON.stringify(req.body)`
**File:** both files, body-size guards
**Note:** by the time we reach the body-size guard, `req.body` has already been parsed by Vercel's body-parser (which has its own default limit, usually 1MB on serverless). The 10KB enforcement is a defense-in-depth check but not the primary bound.

### I3. `currencyAddr` defaults to `"0x000...0"` (ETH) when `considerationItem?.token` is missing
**File:** `orderbook.js:273, 276`
**Note:** for an empty `considerationItem`, the code falls back to ETH. Combined with the `TOKEN_DECIMALS[currencyAddr]` check, a missing token *does* get caught (decimals undefined for unknown currencies, but the zero-address is whitelisted). Edge case: a malformed offer with `consideration[0]` missing entirely passes ETH and proceeds. Recommend: require `token` present and a member of `TOKEN_DECIMALS`.

### I4. SHA-256 `orderHash` collides if `salt` is omitted
**File:** `orderbook.js:354`
**Note:** `salt: params.salt || randomUUID()` means *server-side* random salt fills in. Two different orders with identical offerer/offer/consideration/start/end but server-generated salts will differ (good); but if the client picks a fixed salt for two orders that are otherwise identical (e.g. a typo), the hash collides and the second insert fails on PK. The client can't tell why. Minor UX thing; document or auto-retry with appended nonce.

---

## Cross-cutting observations

1. **OpenSea proxy already has substantive defenses** (path whitelist, contract address whitelist, body-size cap, fail-closed CORS in production) — but **does no response validation**, leaving the consumer-side trust boundary undefended.
2. **Orderbook proxy verifies personal_sign auth** but **does not verify the actual Seaport EIP-712 signature** on the order it's storing — a fundamental design gap if the orderbook is meant to be a credible alternative to centralized aggregators.
3. **No on-chain ownership check** for offered NFT — easy to address with one Alchemy call.
4. **BigInt → Number conversion at `:286`** is the highest-impact arithmetic vulnerability; mitigation is straightforward (keep priceEth as a string).
5. **Per-IP rate-limits + per-maker rate-limits** are well-set but won't survive a coordinated wallet-spread attack.

---

## Top-3 (priority for remediation)
1. **H2** — Verify `seaportSignature` server-side (EIP-712) + on-chain ownership of offered NFT.
2. **H1** — Add per-endpoint response schema validation on OpenSea proxy; sanitize URL fields.
3. **H3** — Replace BigInt→Number conversion for `price_eth`, clamp `priceWei` to sane upper bound.
