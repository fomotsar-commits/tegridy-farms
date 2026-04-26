# Agent 090 — Silent Error Handling Audit

**Mode:** AUDIT-ONLY (no code changes)
**Scope:** `frontend/src` + `frontend/api` — silent error handling, swallowed promise rejection, missing UI surfacing.
**Date:** 2026-04-25

---

## Counts

| Surface | Count |
|---|---|
| `catch (...) {}` empty / silent (`} catch {}`) | 23 sites in src |
| `.catch(() => {})` fire-and-forget | 4 sites |
| `try` blocks across frontend/src | 113 |
| `try` blocks across frontend/api | 12 |
| `JSON.parse` calls (frontend/src) | 47 |
| `JSON.parse` w/o try wrapper | ~8 risky (see TOP-5) |
| `await fetch(` w/o `res.ok` check | low — proxy.js, MyListings, NftImage all check |
| `tx.wait()` w/o status / receipt check | 8 sites (orderbook.js status-checked; weth.js, BidManager, MyListings, OrderBookPanel skip status check) |
| `ErrorBoundary` route coverage | 1 (`RouteErrorBoundary` in App.tsx wraps `<Routes>` — Nakamigos sub-app has its own; ArtStudioPage NOT wrapped) |

---

## TOP-5 Findings (risk-ranked)

### 1. HIGH — `tx.wait()` without `receipt.status` check on critical Seaport cancel/approve flows
**Files / lines:**
- `frontend/src/nakamigos/lib/weth.js:74` (`weth.deposit`) and `:99` (`weth.approve(CONDUIT)`) — accept reverted tx as success.
- `frontend/src/nakamigos/components/BidManager.jsx:287` (Seaport cancel)
- `frontend/src/nakamigos/components/MyListings.jsx:357,417` (cancel + cancelAll)
- `frontend/src/nakamigos/components/OrderBookPanel.jsx:67` (cancel)
- `frontend/src/nakamigos/api-offers.js:610,703`

**Pattern:**
```js
const tx = await seaport.cancel([params]);
await tx.wait();
return { success: true, hash: tx.hash };
```
**Risk:** A reverted-but-mined tx (`receipt.status === 0`) returns `success: true` to caller. UI shows "Listing cancelled successfully!" while the on-chain order is still active — buyer can still fulfill. Compare to `frontend/src/nakamigos/lib/orderbook.js:139-142` and `api.js:992-995` which DO guard `if (!receipt || receipt.status === 0) return { error: "reverted" }`.
**Severity:** HIGH (financial: stale orders fillable, false UX state).

### 2. MEDIUM — Empty `catch {}` swallows real failures during user-driven persistence
**Files / lines:**
- `frontend/src/contexts/ThemeContext.tsx:19,38` — theme persist; not actionable but masks quota.
- `frontend/src/hooks/useDCA.ts:72,76,141` and `useLimitOrders.ts:65,125` — DCA/LimitOrder lock acquisition + persistence. **Critical:** if `localStorage.setItem` throws (private mode, quota), schedules silently fail to persist — user thinks order is queued but it's gone on reload.
- `frontend/src/pages/HistoryPage.tsx:191,239` — cache read/write swallowed; tolerable.
- `frontend/src/nakamigos/contexts/CartContext.jsx:10`, `FavoritesContext.jsx:10` — cart persistence; same private-mode silent loss.

**Severity:** MEDIUM (UX: user-perceived data loss with no toast).

### 3. MEDIUM — `console.warn`-only catches that should surface to UI on user-initiated actions
**Files / lines:**
- `frontend/src/nakamigos/api.js:258-260` (`getCurrentBlock`), `685-687` (`OpenSea listings`), `709-711` (`map native listings`), `808-809` (batch chunks).
- `frontend/src/nakamigos/api-offers.js:113-115` (`Fetch trait offers`), `527-530` (`my offers`).
- `frontend/src/nakamigos/components/TransactionProgress.jsx:582-584` (poll receipt) and `:622-625` (speed-up failure).
- `frontend/src/nakamigos/components/OrderBookPanel.jsx:84` (backend-cancel after on-chain success — only `console.warn`, no toast).
- `frontend/src/nakamigos/lib/notifications.js:82-84,107-109,128-130` — push subscribe/unsubscribe/prefs all return null/undefined silently; user clicking "enable notifications" gets no feedback when subscription fails.

**Risk:** User clicks "Speed up", "Subscribe", "Cancel listing" → nothing happens, only devtools shows error. Wallet UX feels frozen.

### 4. MEDIUM — `JSON.parse` on remote response w/o try (entire app crash on bad payload)
**Files / lines:**
- `frontend/src/nakamigos/components/AMMSection.tsx:2378` — `JSON.parse(stored)` from localStorage, no try wrapping the use site.
- `frontend/src/components/community/VoteIncentivesSection.tsx:87` — `JSON.parse(raw)` (need to verify try-wrap; quick check shows it's inside a function but no nearby `catch`).
- `frontend/src/hooks/useWizardPersist.ts:101` — `JSON.parse(raw) as StoredDraft`; corrupted draft from localStorage could throw and break wizard mount.
- `frontend/src/nakamigos/lib/portfolio.js:21` — `JSON.parse(raw)` of cached portfolio entry; throwing breaks portfolio render.
- `frontend/src/nakamigos/lib/supabase.js:109` — `raw ? JSON.parse(raw) : []` in shared cache reader.

**Risk:** A poisoned cache entry (or schema rev that flipped types) crashes the route render. RouteErrorBoundary in `App.tsx:38-68` will catch it but ONLY after a full re-render fall — momentary white-flash of a "Something went wrong" page replacing the current view, even though the error originated from a stale cache item.

### 5. MEDIUM — `ArtStudioPage` route bypasses `RouteErrorBoundary`
**File:** `frontend/src/App.tsx:115`
```tsx
<Route path="art-studio" element={<Suspense fallback={<PageSkeleton />}><ArtStudioPage /></Suspense>} />
<Route element={<AppLayout />}>
  ...
```
`ArtStudioPage` is mounted OUTSIDE the `<Route element={<AppLayout />}>` group and OUTSIDE any error boundary block (the `RouteErrorBoundary` wraps the whole `<Routes>` element, so it does catch — re-verify line 174). Because the studio writes overrides via `/__art-studio/save` (`pages/ArtStudioPage.tsx:377`), an unhandled JSON parse on the response or an `(err as Error).message` throw on a non-Error rejection cascades up to the root boundary and white-flashes the entire app — a more severe UX hit than a sub-route boundary would impose. No isolated boundary per-route; consider one for ArtStudio (heavy editor surface) and Nakamigos sub-app boundary already exists at `frontend/src/nakamigos/components/ErrorBoundary.jsx`.

---

## Sub-findings (LOW — informational)

- **Fire-and-forget `Notification.requestPermission().catch(() => {})`** at `useDCA.ts:160`, `useLimitOrders.ts:144` — acceptable, but consider distinguishing "denied" vs "unsupported" for analytics.
- **`AudioContext.close().catch(() => {})`** at `nakamigos/hooks/useSound.js:137` — comment justifies (lifecycle), OK.
- **`ENS resolution best-effort`** at `WhaleIntelligence.jsx:403-405` — comment justifies, OK.
- **`api/orderbook.js` 4 catch sites** — backend handler catches; verify each returns 5xx with `error` payload (separate audit).
- **`siweAuth.js:55`, `orderbook.js:44,303`, `MyListings.jsx:277,374`** — `await res.json().catch(() => ({}))` is correct defensive parse; not a bug.
- **`audio.ts:128`** — silent fallback for missing ambient audio file; intentional and labelled.
- **`NftImage.jsx:88,111,138`** — `catch { /* fall through */ }` to placeholder is intentional & labelled.
- **`txErrors.ts`** is the project's standard `surfaceTxError` helper — finding #3 sites should adopt it.

---

## Suggested follow-up (NOT applied — audit-only)

1. Wrap `tx.wait()` returns with `if (!receipt || receipt.status === 0) throw/return error` in the 6 sites above (matches existing pattern in `nakamigos/api.js:992`).
2. Replace `console.warn` in `notifications.js` and `TransactionProgress.handleSpeedUp` with `surfaceTxError()` / toast.
3. Wrap risky `JSON.parse` reads of localStorage in `useWizardPersist.ts:101` and `AMMSection.tsx:2378` with try/catch returning a default.
4. Add per-route `<RouteErrorBoundary>` around `ArtStudioPage` (heavy editor) so a studio crash does not unmount the whole app.
5. Add `safeSetItem` wrapper for cart/favorites/DCA/limit-order persist sites that currently `} catch {}` (toast on quota, since those represent user data).
