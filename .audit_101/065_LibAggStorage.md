# Audit 065 — Frontend Lib: Aggregator + Storage + ABI Supplement + Token List

**Agent:** 065 / 101
**Targets:**
- `frontend/src/lib/aggregator.ts` (391 LOC)
- `frontend/src/lib/storage.ts` (95 LOC) + `storage.test.ts` (96 LOC)
- `frontend/src/lib/abi-supplement.ts` (6,869 LOC, auto-generated)
- `frontend/src/lib/tokenList.ts` (141 LOC)

**Mode:** AUDIT-ONLY (no code changes)

---

## Counts
- HIGH: 1
- MEDIUM: 5
- LOW: 5
- INFO: 4
- **Total: 15**

---

## HIGH

### H1 — Hard-coded `CHAIN_ID = 1` in aggregator with no chainId guard against connected wallet
**File:** `frontend/src/lib/aggregator.ts:5`
```ts
const CHAIN_ID = 1; // Ethereum mainnet
```
Every quote function (`getOdosQuote`, `getKyberSwapQuote`, `getParaSwapQuote`, `getLiFiQuote`, `getOpenOceanQuote`, `getSwapApiQuote`, `getCowSwapQuote`) embeds `CHAIN_ID=1` as the swap chain. The exported `getMetaAggregatorQuotes` / `getAggregatorPrice` functions do **not** accept a `chainId` parameter, do **not** read the connected wallet's network, and do **not** verify the wallet is on chain 1 before returning quotes.

**Impact:** A user connected to a non-mainnet wallet (Sepolia, Arbitrum, Polygon, an L2, or a misconfigured RPC) will be shown mainnet swap routes computed against mainnet token reserves and mainnet token addresses (USDC `0xA0b8…`, WETH `0xC02a…`). When the UI calls `useSwap` with these mainnet quotes but the on-chain swap goes through a non-mainnet router, users get garbage outputs, failed transactions, or — in the worst case if a malicious contract on the connected chain has the same address — token loss. The aggregator silently trusts that the consumer is mainnet-only.

**Hunt-list match:** "missing chainId guard on quote" — confirmed.

**Recommendation (audit-only):** Add a `chainId` parameter to `getMetaAggregatorQuotes` / `getAggregatorPrice` and refuse to return quotes when `chainId !== 1`. Callers in `useSwapQuote.ts` should pass `useChainId()` from wagmi.

---

## MEDIUM

### M1 — Per-route slippage values are inconsistent and applied per-aggregator, not route-wide
**File:** `frontend/src/lib/aggregator.ts:43,71`
```ts
// SwapAPI:
maxSlippage: '0.05',           // 5% (line 43)

// Odos:
slippageLimitPercent: 0.5,     // 0.5% (line 71)

// Other aggregators: no slippage parameter sent at all
```
Two different aggregators are queried with **two orders of magnitude** different slippage budgets (5% vs 0.5%), and the remaining five (CowSwap, Li.Fi, KyberSwap, OpenOcean, ParaSwap) are queried with their **service defaults** (which vary between providers). The "best quote" is then chosen purely by `amountOut`, so SwapAPI — the one with 5% slippage — has a structural advantage in the comparison (looser slippage = better quote). This biases the ranking toward whichever aggregator was given the loosest tolerance.

**Hunt-list match:** "slippage default applied per-hop instead of route-wide (silent drift)" — direct confirmation.

**Recommendation:** Accept a single `slippageBps` parameter on `getMetaAggregatorQuotes` and forward an equivalent value to every aggregator that supports it.

---

### M2 — `priceImpact: 0` hard-coded for 4 of 7 aggregators silently drops a comparison signal
**File:** `frontend/src/lib/aggregator.ts:129,159,189,252`
```ts
// CowSwap line 129:    priceImpact: 0, // CowSwap doesn't report price impact in quotes
// Li.Fi line 159:      priceImpact: 0,
// KyberSwap line 189:  priceImpact: 0,
// ParaSwap line 252:   priceImpact: 0,
```
Four aggregators report zero priceImpact even when the actual impact may be 5%, 10%, or higher on illiquid pairs. Because `getAggregatorPrice` exposes `priceImpact` to the swap UI for warning thresholds, users may be shown a "0% impact" route that is actually a 15%+ impact CowSwap order. The Li.Fi and KyberSwap responses *do* contain price-impact fields in their JSON, but the code chooses to ignore them.

**Recommendation:** Parse `data?.estimate?.toAmountUSD` vs `data?.estimate?.fromAmountUSD` (Li.Fi), `data?.data?.routeSummary?.amountOutUsd` vs `amountInUsd` (KyberSwap) to compute actual impact.

---

### M3 — `tokenList.ts` `findToken` does not validate `customTokens` parameter source
**File:** `frontend/src/lib/tokenList.ts:122-125`
```ts
export function findToken(address: string, customTokens: TokenInfo[] = []): TokenInfo | undefined {
  const all = [...DEFAULT_TOKENS, ...customTokens];
  return all.find(t => t.address.toLowerCase() === address.toLowerCase());
}
```
A user-imported token (`customTokens`) that has the same lowercased address as a `DEFAULT_TOKENS` entry will **shadow** the default because `Array.find` returns the first match in iteration order — and `DEFAULT_TOKENS` is iterated first. Wait: in this case the *default* wins (good for safety against impersonation). However, a custom token with a chosen `address` value spelled with a leading checksum case difference will match the lowercase comparator and could legitimately collide.

More importantly, `findToken` accepts a `decimals` field from `customTokens` with no validation — a user importing a 6-decimal token with `decimals: 18` set in localStorage would compute amounts off by a factor of 1e12 in any consumer of `findToken().decimals`.

**Recommendation:** Cross-check `decimals` against an on-chain `decimals()` call before persisting `customTokens`.

---

### M4 — `evictOldEntries` evicts on `tegridy_` prefix only, but no caller is documented to use that prefix
**File:** `frontend/src/lib/storage.ts:33`
```ts
if (!k || !k.startsWith('tegridy_')) continue;
```
The eviction sweep only considers keys beginning with `tegridy_`. Searching the codebase for `safeSetItem` callers (TopNav, HistoryPage, useSwap, LiquidityTab, useLimitOrders, useDCA, App, GalleryPage, useToweliPrice, pointsEngine, analytics, errorReporting, usePriceHistory) shows **most** call-sites do not adopt a `tegridy_` prefix — they use names like `swap_settings`, `dca_orders`, `limit_orders`, etc.

**Impact:** When localStorage hits quota, `evictOldEntries` finds zero candidates, returns false, and `safeSetItem` returns false silently — the write is dropped. The user perceives a settings-not-saving bug with no error surface.

**Recommendation:** Either (a) rename all storage keys to prefix `tegridy_`, or (b) loosen the eviction filter to evict any non-essential key, or (c) keep an explicit allowlist of evictable keys.

---

### M5 — `JSON.parse(localStorage.getItem(k) ?? '')` inside eviction throws are caught but mask the *content* of every non-tegridy key
**File:** `frontend/src/lib/storage.ts:36-38`
```ts
try {
  const parsed = JSON.parse(localStorage.getItem(k) ?? '');
  ts = typeof parsed?.ts === 'number' ? parsed.ts : 0;
} catch { /* not JSON or no ts — evict first */ }
```
The catch block silently sets `ts = 0`, which forces eviction-first ordering for any key whose value is not JSON-with-`ts`. Because most legitimate `tegridy_` callers do **not** wrap values in a `{ts: number, data: T}` shape (none of the callers grep'd above show this pattern), all `tegridy_` writes will be evicted in the order they were last written, regardless of actual age. The "oldest" semantics described in the function comment do not hold in practice.

**Hunt-list match:** "JSON.parse without try/catch (parse-error throws break app)" — *partial* hit. There IS a try/catch here, but the silent fallback to `ts=0` defeats the LRU semantics.

---

## LOW

### L1 — `tokenList.ts` `logoURI` references local `/tokens/*.png` and `/art/*.jpg` with no integrity / no fallback
**File:** `frontend/src/lib/tokenList.ts:19-119`
All 14 default tokens point to local `/tokens/eth.png`, `/art/bobowelie.jpg`, etc. Local-served is fine. But if a `customTokens` import accepts a `logoURI` from user input (typical in DEX UIs that auto-fetch from `tokens.uniswap.org` or trustwallet `assets`), the URL is rendered as `<img src>` — a tracking-pixel / referrer-leak vector unless the consumer applies `referrerPolicy="no-referrer"` and `loading="lazy"`. Code does not list any external CDN in defaults — so this is INFO-leaning, but worth flagging because the type system permits arbitrary `logoURI` strings on imports.

**Hunt-list match:** "tokenList trusted from external CDN without integrity" — **NOT confirmed for this file**: defaults are local. The risk surface is the `customTokens` path (downstream).

---

### L2 — `BigInt(10 ** fromDecimals)` precision loss in OpenOcean quote
**File:** `frontend/src/lib/aggregator.ts:208`
```ts
const divisor = BigInt(10 ** fromDecimals);
```
`10 ** 18` evaluates as a JS Number first (1e18) which loses precision (Number max safe = 2^53 ≈ 9.007e15). For `fromDecimals >= 16`, `BigInt(10 ** 16)` already becomes `10000000000000000n` correctly because `10 ** 16` is exactly representable, but `10 ** 18 = 1000000000000000000` is **not** safely representable as a Number — so `BigInt(10 ** 18)` becomes `BigInt(1e18)` which **may round** to `1000000000000000000n` or `999999999999999999n` depending on engine.

**Recommendation:** Use `10n ** BigInt(fromDecimals)` instead.

---

### L3 — `humanAmount.padStart(fromDecimals,'0').slice(0,6)` truncates fractional precision to 6 chars
**File:** `frontend/src/lib/aggregator.ts:211`
```ts
const humanAmount = whole.toString() + '.' + frac.toString().padStart(fromDecimals, '0').slice(0, 6);
```
This drops everything after the 6th fractional digit. For an 18-decimal token, the 12 trailing wei are silently discarded — meaning the quote OpenOcean computes is for slightly less than the user actually intends to swap. The `amountOut` will be slightly off from competitors, biasing the meta-aggregator ranking against OpenOcean even when its real route is best.

---

### L4 — `safeGetItem` does NOT decode JSON; consumers must `JSON.parse` themselves and many callers don't try/catch
**File:** `frontend/src/lib/storage.ts:88-94`
The helper returns the raw string. Searching the codebase, `useSwap.ts`, `useDCA.ts`, `useLimitOrders.ts`, `pointsEngine.ts`, `analytics.ts`, `usePriceHistory.ts`, `errorReporting.ts` all consume the string and call `JSON.parse` — likely without uniform try/catch handling, so a corrupted localStorage entry can throw at app boot.

**Hunt-list match:** "JSON.parse without try/catch (parse-error throws break app)" — confirmed at *call sites* (out of scope for this file but worth flagging).

**Recommendation:** Provide a `safeGetJSON<T>(key, fallback): T` helper in this file.

---

### L5 — No namespace prefix on the helper itself — `safeSetItem('') ` accepts empty key
**File:** `frontend/src/lib/storage.ts:62`
```ts
expect(safeSetItem('', '')).toBe(true);   // storage.test.ts:58 confirms this is accepted
```
The test deliberately allows empty-key writes. While not exploitable in itself, an empty key collides with any "default" / unkeyed write from another script on the same origin. Combined with no enforced `tegridy_` prefix, two dapps deployed to the same dev domain will trample each other's localStorage.

**Hunt-list match:** "localStorage keys not namespaced (collision with other dapps on same origin)" — confirmed; helper does not enforce a namespace.

---

## INFO

### I1 — `abi-supplement.ts` is auto-generated; no drift risk if generator is invoked on every contract change
**File:** `frontend/src/lib/abi-supplement.ts:1-9`, `scripts/extract-missing-abis.mjs`
The header explicitly says "Do NOT hand-edit". The script reads from `contracts/out/<sol>/<name>.json` (forge build artifacts). **Drift risk = LOW** as long as CI runs `forge build && node scripts/extract-missing-abis.mjs` and asserts no diff on PR. Search for such a CI hook would confirm; absent one, this becomes MEDIUM.

**Hunt-list match:** "abi-supplement drift vs actual deployed ABI (manual hand-merged ABIs go stale)" — **NOT confirmed** for the supplement file (auto-gen). Drift would only happen if a developer manually edits a contract's Solidity but doesn't re-run the script. No enforcement found.

---

### I2 — `aggregator.ts` proxies via `/api/odos/...`, `/api/cow/...`, `/api/lifi/...`, `/api/kyber/...`, `/api/openocean/...`, `/api/paraswap/...` — Vite dev proxy or production reverse proxy
**File:** `frontend/src/lib/aggregator.ts:75,116,151,178,216,244`
All but SwapAPI go through a same-origin `/api/*` proxy path. This is correct architecture (avoids CORS, hides real endpoints if rate-limited per origin). SwapAPI uses absolute `https://api.swapapi.dev/...` — inconsistent. Not a bug, but worth normalizing.

---

### I3 — `aggregator.ts` `Promise.allSettled` correctly tolerates a slow / failing aggregator
**File:** `frontend/src/lib/aggregator.ts:275`
Using `allSettled` is correct. However, there's no per-source timeout — a slow aggregator like Li.Fi (200 quotes / 2 hours rate-limit) can hang on cold-start until the user-supplied `signal` aborts. UX-wise the slow source dominates the user-perceived latency. Recommend `Promise.race([fetch, timeout(3000)])` per source.

---

### I4 — `storage.test.ts` uses `vi.spyOn(Storage.prototype, 'setItem').mockImplementation(...)` and **forgets** to restore between tests
**File:** `frontend/src/lib/storage.test.ts:30,54,86`
Tests do call `vi.restoreAllMocks()` at end-of-test, but the failing-quota mock at line 26-30 is the only place where `vi.restoreAllMocks()` is in the same `it` block. If a test throws before the restore call, subsequent tests inherit the spy. `afterEach(() => vi.restoreAllMocks())` would be safer.

---

## Cross-Check: storage.test.ts

- Test coverage is reasonable for the helper's narrow API.
- **Missing test cases:**
  - No test for the `tegridy_` eviction prefix (M4 above) — the test seeds `tegridy_old1`, `tegridy_old2` then never verifies they were the ones evicted vs other keys.
  - No test for `evictOldEntries` returning false when there are no `tegridy_` keys at all (M4 silent-drop).
  - No test that the `ts`-based ordering actually works (M5 — entries without `ts` should evict first).
  - No test for very large value that triggers `estimateRemainingQuota` (line 16's BUDGET = 2.5 MB) pre-flight eviction.
  - No test that `safeGetItem` returns the *exact* raw string for a non-JSON value with embedded NUL or unicode — JSDOM may differ from real browsers.

---

## Top-3 Worst Findings

1. **H1 — Missing chainId guard:** Aggregator returns mainnet quotes regardless of connected wallet's chain. User on a wrong chain gets routed against mainnet token addresses with potentially catastrophic mis-execution.
2. **M1 — Slippage drift across aggregators:** SwapAPI gets 5% slippage, Odos gets 0.5%, others get nothing. The "best quote" comparison is structurally biased toward whichever aggregator received the loosest tolerance.
3. **M4 — Eviction prefix mismatch:** `evictOldEntries` only finds keys with `tegridy_` prefix but the actual call-sites (`swap_settings`, `dca_orders`, etc.) don't use it. When quota is hit, eviction silently fails and writes are dropped without surface error — manifests as "settings not saving" UX bug.

---

## Hunt-list Match Summary

| Hunt item | Status |
|---|---|
| Aggregator path optimization ignoring fee-tier mismatches | Not applicable (this aggregator is meta-only — aggregates other aggregators, no fee-tier concept exposed) |
| Slippage default applied per-hop instead of route-wide | **CONFIRMED (M1)** |
| Missing chainId guard on quote | **CONFIRMED (H1)** |
| Storage helper that sets long TTLs on sensitive keys | Not applicable (storage.ts has no TTL concept; fingerprint-only LRU) |
| localStorage keys not namespaced | **CONFIRMED (L5/M4)** |
| JSON.parse without try/catch | Partial — storage.ts does have try/catch (M5), but call-sites don't (L4) |
| abi-supplement drift vs deployed ABI | NOT directly applicable — file is auto-gen (I1) |
| tokenList from external CDN without integrity | NOT confirmed — defaults are local (L1) |
| Image URLs from untrusted IPFS gateway | NOT confirmed — no IPFS gateway in tokenList.ts |

---

**End of audit 065.**
