# Agent 058 — Forensic Audit: History / Activity / Transaction Receipt

**Scope (AUDIT-ONLY):**
- `frontend/src/pages/HistoryPage.tsx`
- `frontend/src/pages/ActivityPage.tsx`
- `frontend/src/components/TransactionReceipt.tsx`
- `frontend/src/hooks/useTransactionReceipt.ts`

**Date:** 2026-04-25
**Targets verified:** 4/4 files exist and audited end-to-end.
**Auxiliary files inspected:** `frontend/api/etherscan.js` (proxy), `frontend/src/lib/explorer.ts`, `frontend/src/lib/formatting.ts`.

---

## Counts

| Severity      | Count |
| ------------- | ----- |
| CRITICAL      | 0     |
| HIGH          | 1     |
| MEDIUM        | 5     |
| LOW           | 6     |
| INFO          | 4     |
| **Total**     | **16**|

---

## HIGH

### H1 — Etherscan response is not validated against a strict schema (no zod / typed contract); only field-presence checked
- **File / lines:** `HistoryPage.tsx:31-55, 211-260` (`isValidTxRecord`, `truncateTxFields`, `fetch().then(parse)`)
- **Detail:** The proxy returns whatever the upstream Etherscan API gives back. If Etherscan (or a man-in-the-middle along the proxy → upstream path, or a misconfigured/poisoned cache layer in front of it) returns crafted JSON, the only checks are:
  1. `data.status === '1' && Array.isArray(data.result)`
  2. `isValidTxRecord(tx)` — string-typeof checks for `hash`, `timeStamp`, `to`, `functionName`, `isError`, `value`. **No regex validation**: `hash` is not required to match `/^0x[a-f0-9]{64}$/`; `to` is not required to match `/^0x[a-f0-9]{40}$/`; `timeStamp` is not required to be a numeric string; `value` is not validated as decimal-string.
  3. `truncateTxFields` only `slice()`s — does not reject malformed shape.
- **Risk:** A poisoned `tx.hash` containing arbitrary characters is interpolated into `getTxUrl(chainId, tx.hash)` to build the `href` of an `<a target="_blank">`. While `noopener noreferrer` is set, the URL itself is not constrained; e.g. a `tx.hash` of `../../malicious?x=` could produce a path-traversed explorer URL that lands on an attacker-controlled page on the same explorer host, or a non-tx page. Etherscan is still a sandbox here (cross-origin), but this is a clear schema-validation gap. The `functionName` field is also slice()-truncated then split on `(` — no charset constraint, so emoji / RTL / control chars flow into the table.
- **Fix:** Add a zod (or hand-rolled) validator in `isValidTxRecord` that enforces:
  - `hash` matches `/^0x[a-fA-F0-9]{64}$/`
  - `to` matches `/^0x[a-fA-F0-9]{40}$/`
  - `timeStamp`, `value`, `gasUsed`, `gasPrice` match `/^\d+$/`
  - `functionName` matches a conservative ASCII charset
  - `isError` is `'0'` or `'1'`
  Reject the entire row if any check fails.
- **Confidence:** HIGH.

---

## MEDIUM

### M1 — Tx hash rendered without checksum or strict validation in HistoryPage
- **File / lines:** `HistoryPage.tsx:447-457, 472-478`
- **Detail:** `getTxUrl(chainId, tx.hash)` uses the raw, unvalidated `tx.hash` string straight from the indexer. No regex check before using it as a URL path segment. `shortenAddress(tx.hash, 8)` accepts any string. (See H1 — same root cause but specifically for the hash interpolation into href.)
- **Fix:** Validate `/^0x[a-fA-F0-9]{64}$/` before linking; refuse to render the row otherwise. Note that `TransactionReceipt.tsx:26-31` already implements `sanitizeTxHash` correctly — adopt the same helper here.
- **Confidence:** HIGH.

### M2 — `value` (wei) rendered raw in CSV export, no decimal formatting
- **File / lines:** `HistoryPage.tsx:316` — `tx.value || '0'` written verbatim into "Value (Wei)" CSV column.
- **Detail:** While the column header says `(Wei)` so this is technically not a bug, downstream tooling (Excel, Google Sheets) will display `1000000000000000000` as `1E+18` and silently lose precision. The on-screen UI doesn't render `value` at all — only gas — but the CSV does without explicit decimal-aware formatting.
- **Fix:** Either (a) export both `Value (Wei)` and `Value (ETH)` columns using `formatUnits(value, 18)`, or (b) wrap the wei string in `="..."` to force text mode in spreadsheets.
- **Confidence:** MEDIUM.

### M3 — Block-explorer URL falls back to mainnet Etherscan for unknown chains
- **File / lines:** `frontend/src/lib/explorer.ts:25-31`
- **Detail:** `getExplorerBase()` returns `https://etherscan.io` (mainnet) for any `chainId` not in the `EXPLORERS` map, and also when `chainId` is `undefined`. If a user is connected to e.g. Linea (59144), Scroll, Mantle, ZkSync, or any L2 not in the map, every receipt and history row builds a **mainnet** Etherscan URL with a hash that does not exist on mainnet. Receipt comment claims this is intentional ("links still resolve somewhere rather than 404") — but they will 404 on Etherscan since the hash isn't mainnet.
- **Fix:** Either (a) display "explorer not configured" instead of linking, or (b) add the missing major chains. The `Mainnet` badge in `TransactionReceipt.tsx:296-298` is **also hardcoded** regardless of the connected chain — see L1.
- **Confidence:** HIGH.

### M4 — In-memory + localStorage cache stored unvalidated, then reused without re-validating timestamps / address binding
- **File / lines:** `HistoryPage.tsx:179-192`
- **Detail:** Cache `tegridy_tx_history_${addr}` is read from localStorage and the contained `parsed.data` is only filtered through `isValidTxRecord` — but the address is implicit in the key, and the cache is not signed/HMAC'd. A malicious page on the same origin (e.g. an XSS via art-studio middleware comments injecting into rendered nicknames) could write arbitrary tx history into localStorage, and the next visit would render attacker-chosen rows including attacker-chosen `to` addresses categorized into "Stake" / "Claim" types. Risk surface is small because mutations require an existing XSS, but this is a defense-in-depth gap.
- **Fix:** Either (a) skip cache and always fetch (slower), or (b) namespace cache with a content-hash and verify `addr` in payload matches key.
- **Confidence:** MEDIUM.

### M5 — Pre-finality / pending receipt state not represented; receipts shown as authoritative
- **File / lines:** `TransactionReceipt.tsx:170-200, 305-313`
- **Detail:** `TransactionReceiptOverlay` accepts `receipt.data.txHash` and renders the receipt as a confirmed event, with no notion of `pending → confirmed → finalized`. Callers across the codebase (`useTransactionReceipt.ts:65-67` `showReceipt(data)`) can pop a receipt the moment a tx is submitted — there is no `useWaitForTransactionReceipt` gating before rendering the success card. Users may share-to-X a "Just staked!" receipt for a tx that subsequently reverts. The `Mainnet` badge at line 296-298 implies authority. No "Pending" / "Confirmed N blocks" indicator anywhere in the component.
- **Fix:** Accept a `status: 'pending' | 'confirmed' | 'failed'` prop, gate Share/Copy on `confirmed`, and show a spinner for `pending`. Tie to wagmi's `useWaitForTransactionReceipt`.
- **Confidence:** HIGH.

---

## LOW

### L1 — Hardcoded "Mainnet" badge regardless of connected chain
- **File / lines:** `TransactionReceipt.tsx:296-298`
- **Detail:** `<div className="badge badge-primary text-[10px] px-2 py-0.5">Mainnet</div>` — string literal. Renders "Mainnet" on Sepolia, Holesky, Base, etc. Misleading and could trick a user into believing a testnet-tx is real.
- **Fix:** Derive label from `chainId` via a small `chainName(chainId)` helper.
- **Confidence:** HIGH.

### L2 — No `<caption>`, `<th scope>`, or aria-rowcount; mobile collapses to single colSpan=6 cell with no header announcement
- **File / lines:** `HistoryPage.tsx:414-495`
- **Detail:** Table headers use `<th>` without `scope="col"`. Mobile rows use `<td colSpan={6}>` with no `<th>` at all — screen readers cannot navigate. No `<caption>` describing the table. Pagination buttons have `aria-label` (good) but the table itself has no `aria-label` / `role="region"`. Day-header rows are styled `<tr><td colSpan={6}>` instead of `<tr role="rowgroup">` or proper `<tbody>` boundaries — assistive tech will read them as data rows.
- **Fix:** Add `<caption className="sr-only">Transaction history</caption>`, `scope="col"` on every `<th>`, and split day-groups into separate `<tbody>` elements so the day label can live in a `<th scope="rowgroup">`.
- **Confidence:** HIGH.

### L3 — `nowMs` `useMemo` dependency on `pagedCategorized` is a footgun
- **File / lines:** `HistoryPage.tsx:292`
- **Detail:** `const nowMs = useMemo(() => Date.now(), [pagedCategorized]);` — captures `Date.now()` and re-runs whenever the page changes, which is fine, but means `dayLabel(... nowMs)` rolls labels at *page-flip time* rather than at midnight. If the user keeps the tab open across midnight, "Today" becomes wrong. Minor UX bug, not security.
- **Fix:** Use a setInterval or recompute on focus.
- **Confidence:** MEDIUM.

### L4 — Categorization based on lowercased contract addresses but no checksum normalization
- **File / lines:** `HistoryPage.tsx:96-164`
- **Detail:** `categorizeTx` lowercases both `to` and the constants list. Etherscan returns addresses lowercased so this works in practice, but if any constant in `lib/constants.ts` is mistakenly stored in mixed case, the categorization silently breaks. Defensive normalization at constant-import time would be safer.
- **Fix:** `import { getAddress } from 'viem'` and `getAddress(STAKING).toLowerCase()` in a single `KNOWN_CONTRACTS` map.
- **Confidence:** MEDIUM.

### L5 — Sanitize function in TransactionReceipt is HTML-escaping but values are rendered into React text nodes (already safe)
- **File / lines:** `TransactionReceipt.tsx:14-23, 95, 106, etc.`
- **Detail:** `sanitize()` escapes `&<>"'` then injects via `{...}` into JSX text children. React already escapes those characters in text nodes. The `&amp;` in `sanitize` will appear as the literal text `&amp;` to the user (double-escape) — e.g. a token symbol `A&B` will render as `A&amp;B`. This is a UX bug, not a vuln, but suggests the author misunderstood the React escaping model.
- **Fix:** Remove `sanitize()` — React's default escaping is sufficient for text content. Keep validation (`sanitizeTxHash`) which is proper input validation, not output encoding.
- **Confidence:** HIGH.

### L6 — `formatTokenAmount(amount, 4)` for staking amounts loses 14 decimals of precision silently
- **File / lines:** `TransactionReceipt.tsx:106, 115, 138, 156` and `lib/formatting.ts:23-30`
- **Detail:** `formatTokenAmount` calls `parseFloat()` on the raw value and then `toFixed(decimals)`. For an `amount` that is already a wei BigInt represented as string (e.g. `"1000000000000000000"`), `parseFloat` gives `1e18` and `toFixed(4)` returns `"1000000000000000000.0000"` — useless. There's no `formatUnits` step. The contract code passes display-formatted amounts at call sites (the call sites in `swap`/`stake` UIs format before calling `showReceipt`), so this is mostly latent. But if any future caller passes raw wei it will display as enormous numbers, possibly breaching financial UX guarantees.
- **Fix:** Either rename to `formatDisplayNumber` (so it's clear input is already-formatted), or accept a `decimals` arg and call `formatUnits` first.
- **Confidence:** MEDIUM.

---

## INFO

### I1 — Pagination is correctly bounded (offset=500 cap on fetch + 25/page client-side)
- **File / lines:** `HistoryPage.tsx:175, 211, 235`
- **Detail:** **Good.** Fetch is capped at `offset=500` server-side, sliced to 500 client-side, and paged 25 at a time. No infinite-scroll listener — uses click-Prev/Next buttons (no listener-leak risk). `AbortController` is correctly wired in `useEffect` and `handleRetry`.
- **Status:** Resolved / not-a-finding.

### I2 — Backend rate limiting is present
- **File / lines:** `frontend/api/etherscan.js:49-55`
- **Detail:** **Good.** The proxy has `checkRateLimit(req, res, { limit: 30, windowSec: 60 })`. Audit-line comment `AUDIT API-M1` shows this was intentional. Etherscan API key is server-side only (line 7).
- **Status:** Resolved.

### I3 — Tx hash validation already correct in TransactionReceipt
- **File / lines:** `TransactionReceipt.tsx:26-31`
- **Detail:** `sanitizeTxHash` correctly enforces `/^0x[a-fA-F0-9]{64}$/`. Same validation should be lifted into HistoryPage (see M1).
- **Status:** Reusable helper exists; just needs to be applied in the other file.

### I4 — `target="_blank"` consistently paired with `rel="noopener noreferrer"`
- **File / lines:** `HistoryPage.tsx:399, 447, 454, 472`; `TransactionReceipt.tsx:347`
- **Detail:** **Good.** No `target="_blank"` without `noopener noreferrer` was found across the audited surface.
- **Status:** Resolved.

---

## Top-3 Priorities

1. **H1** — Add zod (or strict regex) schema validation to `isValidTxRecord` in `HistoryPage.tsx`. Reject rows with malformed `hash`/`to`/`value`/`functionName` rather than `slice()`-truncating them.
2. **M5 + L1** — Track receipt status (`pending|confirmed|failed`) before showing the success card in `TransactionReceipt.tsx`, and replace the hardcoded "Mainnet" badge with a chain-derived label (also fixes M3 misleading explorer fallback when paired with chain-name display).
3. **L2** — Table accessibility pass on `HistoryPage.tsx`: `<caption>`, `scope="col"` on every `<th>`, split day-groups into per-`<tbody>` blocks with `<th scope="rowgroup">`, and ensure mobile rows expose at least one labeled `<th>` per row.

---

## Files referenced
- `frontend/src/pages/HistoryPage.tsx` (538 lines audited)
- `frontend/src/pages/ActivityPage.tsx` (98 lines audited — host shell only, no findings)
- `frontend/src/components/TransactionReceipt.tsx` (433 lines audited)
- `frontend/src/hooks/useTransactionReceipt.ts` (79 lines audited — pure context, no findings)
- `frontend/api/etherscan.js` (110 lines audited — for rate-limit / key-handling cross-check)
- `frontend/src/lib/explorer.ts` (48 lines audited — for explorer fallback finding)
- `frontend/src/lib/formatting.ts` (69 lines audited — for `formatTokenAmount` precision finding)
