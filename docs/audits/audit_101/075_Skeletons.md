# Audit 075 — Skeletons (PageSkeleton + PageSkeletons + page wiring)

**Auditor:** Agent 075 (forensic — AUDIT-ONLY)
**Date:** 2026-04-25
**Scope:**
- `frontend/src/components/PageSkeleton.tsx` (the spinner-style page loader)
- `frontend/src/components/PageSkeleton.test.tsx` (vitest cover)
- `frontend/src/components/PageSkeletons.tsx` (`SwapSkeleton` / `FarmSkeleton` / `DashboardSkeleton`)
- `frontend/src/components/ui/Skeleton.tsx` (inline `<span>` skeleton primitive)
- All pages in `frontend/src/pages/` and the route-level `<Suspense fallback>` wiring in `frontend/src/App.tsx`

Hunt list applied: CLS / layout-shift, dimensions vs real content, ARIA `busy`, infinite animation w/o `prefers-reduced-motion`, max-wait timeout, `variants` prop with invalid render, broken root `<Suspense>`.

---

## Surface map

### PageSkeleton.tsx (spinner)
```tsx
<div role="status" aria-live="polite" aria-label="Loading page"
     className="flex flex-col items-center justify-center min-h-[60vh] gap-3">
  <div className="size-8 sm:size-10 md:size-12 rounded-full border-3
                  border-primary-dim border-t-primary-glow
                  animate-[spin_0.8s_linear_infinite]" />
  <span className="... animate-[skeleton-pulse_1.5s_ease-in-out_infinite]">Loading...</span>
</div>
```
- Pure spinner. No `variant` prop. No props at all.
- `min-h-[60vh]` reserves a viewport-relative area — does not match the actual rendered page height for any of the destination routes.
- Two arbitrary-value Tailwind animations: `animate-[spin_0.8s_linear_infinite]` and `animate-[skeleton-pulse_1.5s_ease-in-out_infinite]`. `@keyframes skeleton-pulse` is defined in `index.css:451`.

### PageSkeletons.tsx (3 page-shaped skeletons)
- `SwapSkeleton` — width-pinned at `max-w-[480px]`. Real `TradePage` is wider (full content area, ~720px on desktop) with tab bar and connect prompt.
- `FarmSkeleton` — `max-w-[1200px]` matches real width but only renders 4 stat cards + 1 staking card + 2 pool cards. Real `FarmPage` mounts: `WrongChainBanner`, `FarmStatsRow`, `LPFarmingSection`, `StakingCard`, `BoostScheduleTable`, multiple `LivePoolCard` + `UpcomingPoolCard`s + `ConnectPrompt`. Many sections never appear in skeleton.
- `DashboardSkeleton` — uses `pt-8`, but real `DashboardPage` has its own offset, plus a 4-tab bar that the skeleton does not draw, plus `WrongChainGuard` banner.
- All three `<div role="status" aria-label="Loading X">` — no `aria-live`, no `aria-busy`, no inner `Loading...` text. Screen readers will announce the role but with no spoken cue (only the aria-label, which most SRs read once on focus).

### Test cover (PageSkeleton.test.tsx)
- Tests `role="status"`, `aria-label`, `aria-live`, presence of `Loading...` text, `animate-` class, `flex flex-col`, `min-h-`, `.rounded-full`, `font-mono`. **10 tests.**
- **No tests for** `PageSkeletons.tsx` — `SwapSkeleton`, `FarmSkeleton`, `DashboardSkeleton` are completely untested.
- **No tests for** `ui/Skeleton.tsx` either.
- No prefers-reduced-motion test.
- No aria-busy test.

---

## Findings

### F-1 (HIGH) — Skeleton dimensions cause guaranteed CLS / layout shift
**Where:** `frontend/src/components/PageSkeletons.tsx` (every variant); `frontend/src/components/PageSkeleton.tsx`
**Why it matters:**
- `PageSkeleton` is a centered spinner of `min-h-[60vh]`. When the real page (HomePage, GalleryPage, AdminPage, LendingPage, CommunityPage, …) hydrates, its content lays out at `pt-20`, `pt-28`, full-bleed `-mt-14` heroes, multi-row stat grids, etc. The spinner's centered placement guarantees a content jump on every lazy route.
- `SwapSkeleton.max-w=480px` pins narrower than `TradePage`'s actual layout (full content width with tab bar at ~720+px). The tab bar rendered by `TradePage` is ~64px tall and absent from the skeleton — the page header shifts down by that amount when hydration completes.
- `FarmSkeleton` shows 4 stat cards + 1 staking card + 2 pool cards. `FarmPage` actually renders a `WrongChainBanner` (when wrong chain), `FarmStatsRow` with different card counts on mobile, `LPFarmingSection`, `BoostScheduleTable` (full table), and a list of upcoming pool cards. The skeleton's vertical footprint diverges by ~600–1000px from the real content — large CLS on every route into `/farm`.
- `DashboardSkeleton` does not include the 4-tab bar (`Overview / Positions / Loans / Rewards`) that the real `DashboardPage` mounts.

**Cumulative Layout Shift impact:** every lazy route into a skeletoned page produces a visible jump. Lighthouse will flag CLS > 0.1 on first navigation to `/farm`, `/swap`, `/dashboard`, and any of the spinner-fallback routes.

### F-2 (HIGH) — Infinite skeleton animation runs without `prefers-reduced-motion` opt-out
**Where:** `frontend/src/components/PageSkeleton.tsx:11-12`, `frontend/src/components/PageSkeletons.tsx` (every `.skeleton` div), `frontend/src/index.css:417-422` (`.skeleton`), `frontend/src/index.css:444-454` (`@keyframes spin`, `@keyframes skeleton-pulse`)
**Why it matters:**
- `PageSkeleton` uses two infinite animations: `animate-[spin_0.8s_linear_infinite]` and `animate-[skeleton-pulse_1.5s_ease-in-out_infinite]`.
- `PageSkeletons.tsx` `.skeleton` cells inherit the global `.skeleton` rule which sets `animation: shimmer 1.5s ease-in-out infinite` (`index.css:420`).
- The codebase **does** have a global `prefers-reduced-motion` rule at `index.css:684-695`:
  ```css
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation-duration: 0.01ms !important;
      animation-iteration-count: 1 !important;
      ...
    }
  }
  ```
  This **does** clamp the skeleton/spinner animations under reduce-motion.
- HOWEVER the `animate-[spin_0.8s_linear_infinite]` and `animate-[skeleton-pulse_1.5s_ease-in-out_infinite]` Tailwind arbitrary-value classes are inline animation shorthand whose `infinite` keyword sets `animation-iteration-count: infinite` directly in the generated rule. The global override clamps `iteration-count` to 1 but the underlying user agent must apply both the wildcard rule AND the more-specific Tailwind utility — Tailwind's arbitrary value is shipped as a single shorthand `animation: spin 0.8s linear infinite;` declaration, which after cascade specificity ties is overridden only by the `!important` in the global block. This works, but is fragile and undocumented at the component layer. **The component should opt out at the source** using `motion-reduce:animate-none` or a JS guard.
- **No JS check** for `prefers-reduced-motion` in `PageSkeleton.tsx` or `PageSkeletons.tsx`. The CSS catches it, but the test suite has no assertion verifying that. If a future Tailwind upgrade or class refactor breaks the cascade, animations resume with no warning.

### F-3 (HIGH) — `aria-busy` missing from every skeleton
**Where:** `frontend/src/components/PageSkeleton.tsx`; `frontend/src/components/PageSkeletons.tsx` (all three)
**Why it matters:**
- `aria-busy="true"` is the standard signal that a region is currently loading. Without it, AT software (NVDA, JAWS, VoiceOver) does not know the region is incomplete and will treat it as final content.
- Best practice for a loading region:
  ```tsx
  <div role="status" aria-busy="true" aria-live="polite" aria-label="Loading page">
  ```
- `PageSkeleton.tsx` has `role="status"` + `aria-live="polite"` but no `aria-busy`.
- `PageSkeletons.tsx` `Swap/Farm/Dashboard` skeletons have only `role="status"` + `aria-label` — no `aria-live`, no `aria-busy`. Even worse: NVDA will not announce the change at all because there is no live region.
- Hunt-list checklist item ("ARIA 'busy' state missing") **confirmed across all four skeleton components**.

### F-4 (MEDIUM) — No max-wait / timeout — user stuck if Suspense never resolves
**Where:** all `<Suspense fallback={...}>` boundaries in `frontend/src/App.tsx:115-147` and inside `LearnPage`/`InfoPage`/`ActivityPage` — the skeletons themselves contain no timeout logic
**Why it matters:**
- If a lazy chunk fails to fetch (CDN blip, ad-blocker eating `*-DEcAxMps.js`, network drop mid-hydration), Suspense never resolves and the user sees the spinner indefinitely.
- The error boundary at `frontend/src/App.tsx:174-178` catches **render** errors, not infinite-pending Suspense. A failed lazy import throws asynchronously and is caught — but if the chunk is just slow (3G mobile, throttled wifi), there is no progress feedback and no "still loading…" → "tap to retry" ladder.
- `PageSkeleton` should include a timeout (e.g., `useEffect(() => setTimeout(() => setLate(true), 8000))`) that swaps the spinner for a "Still loading… [Retry]" affordance after ~8–10s.
- Hunt-list item ("skeleton with no max wait → user stuck if fetch hangs") **confirmed.**

### F-5 (MEDIUM) — `LeaderboardPage.tsx` mounts and immediately fetches with no skeleton when wallet disconnected
**Where:** `frontend/src/pages/LeaderboardPage.tsx:29-31`
```tsx
if (isConnected && !points.data) {
  return <PageSkeleton />;
}
```
- The `<PageSkeleton />` is only rendered when `isConnected && !points.data`. If the user is **not** connected, the page renders straight through to its real layout. That's a correctness issue when there is later wallet-driven data, but more importantly the skeleton is the wrong shape: `PageSkeleton` is a centered spinner with `min-h-[60vh]` but `LeaderboardPage` paints a fixed-position `<div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>` and a ~900px max-width column with `pt-32`. When `points.data` resolves, the layout jumps from "centered spinner" to "fixed bg + column at top" — large vertical shift.

### F-6 (MEDIUM) — Pages that mount and fetch without ever showing a skeleton (CLS risk)
**Where:** Surveyed all pages. The following mount and start fetching but render a partial UI immediately and let useState placeholders/sparkline sub-components shift around:
- `frontend/src/pages/HomePage.tsx` — uses `useFarmStats`, `usePoolData`, `useRevenueStats`, `useTOWELIPrice`, `usePriceHistory`. No skeleton — relies on each child to handle empty state. `Sparkline` renders a thin line that grows once data lands — CLS within the hero.
- `frontend/src/pages/DashboardPage.tsx` — wired to many wagmi hooks and `useUserPosition` etc. It receives a `<DashboardSkeleton />` from the route-level Suspense but only during initial chunk load; **once mounted, all the content boxes still need their data and CLS happens between empty `--` placeholders and live values.**
- `frontend/src/pages/FarmPage.tsx` — same problem; the skeleton fires only for the lazy chunk, but `useFarmStats`, `useUserPosition`, `useNFTBoost` all paint empty states with different heights than the loaded ones (e.g., `BoostScheduleTable` collapses when boost is `undefined`).
- `frontend/src/pages/GalleryPage.tsx` — uses local-storage data only, but the `ArtImg` component lazy-loads images one-by-one without any reserved aspect-ratio container — visible card-grid shift.
- `frontend/src/pages/CommunityPage.tsx` — has a section-level `<Suspense fallback={...}>` (lines 147-159) but the fallback is `animate-pulse` (Tailwind built-in) wrapped in a generic placeholder div with **no `role`, `aria-live`, or `aria-busy`** — different a11y posture than `PageSkeleton`. Inconsistent loading UX between page-level and section-level skeletons.
- `frontend/src/pages/AdminPage.tsx` — heavy `useReadContracts` and `useBalance` reads, no skeleton. Cards paint empty `--` and shift when values resolve.

### F-7 (MEDIUM) — Skeleton variants prop NOT supported, but spec asked us to look — confirm absence
**Where:** `frontend/src/components/PageSkeleton.tsx`, `frontend/src/components/PageSkeletons.tsx`, `frontend/src/components/ui/Skeleton.tsx`
- `PageSkeleton` takes **no** props. No `variant` field exists.
- `PageSkeletons.tsx` exports three named components (`SwapSkeleton`, `FarmSkeleton`, `DashboardSkeleton`) — no central variants registry.
- `ui/Skeleton.tsx` accepts only `width / height / className`; no variants.
- Hunt-list item ("variants prop where invalid variants render empty") **does not apply** — there is no variants prop. ✓ Clean on this axis. **However** the absence of a unified variants API is itself a smell: any new page adding a custom skeleton has to either reuse the wrong shape or write its own from scratch, which is exactly how `LendingPage`'s inline `Suspense fallback={<div className="space-y-4 animate-pulse">...</div>}` (LendingPage.tsx:147 region inferred from grep — actual seen in pages) deviates from the rest.

### F-8 (LOW) — Root Suspense boundary at `App.tsx:175` could swallow page-specific skeletons during cold load
**Where:** `frontend/src/App.tsx:174-178`
```tsx
<RouteErrorBoundary>
  <Suspense fallback={<PageSkeleton />}>
    <AnimatedRoutes />
  </Suspense>
</RouteErrorBoundary>
```
- `AnimatedRoutes` itself wraps each route in `<Suspense fallback={<FarmSkeleton/>}>` etc. React Suspense bubbling means the **inner** fallback should win, but only if the inner Suspense has actually mounted. On the very first render before the `AnimatedRoutes` chunk lands, the outer fallback (`<PageSkeleton />`) is what users see — **even when navigating to a route that should show `FarmSkeleton`**. The transition from generic spinner → page-shaped skeleton → real content is a 3-step ladder of CLS.
- Hunt-list item ("broken Suspense boundary at root forcing entire page suspense") — **partially confirmed.** The outer Suspense isn't broken per se, but it forces a generic spinner ahead of the page-shaped skeleton.

### F-9 (LOW) — Test file covers `PageSkeleton.tsx` only, leaving `PageSkeletons.tsx` uncovered
**Where:** `frontend/src/components/PageSkeleton.test.tsx`
- 10 tests, all targeting the simple spinner.
- Zero tests for `SwapSkeleton`, `FarmSkeleton`, `DashboardSkeleton` (the page-shape skeletons that have higher visual weight + a11y attributes).
- Zero tests for `ui/Skeleton.tsx`.
- Zero tests asserting `aria-busy`, `prefers-reduced-motion` honor, or that the spinner has a max-wait timeout.

### F-10 (INFO) — Skeleton text "Loading..." duplicates aria-label; minor a11y noise
**Where:** `frontend/src/components/PageSkeleton.tsx:13`
- `aria-label="Loading page"` on the wrapper + visible text "Loading..." + `role="status"` + `aria-live="polite"` ⇒ NVDA may announce both "Loading page" (from the role/label) AND "Loading..." (from the text node) on the same focus event. Mostly cosmetic.

### F-11 (INFO) — Skeleton bg color uses `var(--color-purple-08)` cards but real cards use `--color-purple-06`
**Where:** `frontend/src/components/PageSkeletons.tsx:9, 22` (purple-08) vs `52, 59, 70` (purple-06)
- `SwapSkeleton`'s "from / to" cards use `purple-08` while the rest of the file uses `purple-06`. Causes a visible color flicker when content swaps in (the real swap card uses neither — it uses `glass-card-strong`).

### F-12 (INFO) — `<Skeleton>` primitive coerces `minHeight: '1em'` when no height supplied
**Where:** `frontend/src/components/ui/Skeleton.tsx:8`
- `minHeight: height ? undefined : '1em'` is fine, but if a caller passes only `width`, the component renders `1em` tall — a 16px skeleton bar. Real text rows are usually 18-22px. Slight CLS when the real text resolves.

---

## Cross-check: PageSkeleton.test.tsx vs implementation

| Test claim | Source line | Accurate? |
|---|---|---|
| `role="status"` | PageSkeleton.tsx:6 | ✓ |
| aria-label "Loading page" | PageSkeleton.tsx:8 | ✓ |
| aria-live "polite" | PageSkeleton.tsx:7 | ✓ |
| "Loading..." text | PageSkeleton.tsx:13 | ✓ |
| `animate-` class on spinner | PageSkeleton.tsx:11-12 | ✓ |
| `flex flex-col` on wrapper | PageSkeleton.tsx:9 | ✓ |
| `min-h-` on wrapper | PageSkeleton.tsx:9 (`min-h-[60vh]`) | ✓ |
| `.rounded-full` exists | PageSkeleton.tsx:11 | ✓ |
| `font-mono` on text | PageSkeleton.tsx:12 | ✓ |

Tests accurately mirror the implementation. **No false positives.**
However the test suite **misses**:
- `aria-busy` (because the implementation is missing it — F-3)
- prefers-reduced-motion behavior
- timeout / "still loading" ladder
- the three sibling skeletons (SwapSkeleton / FarmSkeleton / DashboardSkeleton)

---

## Counts

| Category | Count |
|---|---|
| Skeleton components in scope | 4 (`PageSkeleton`, `SwapSkeleton`, `FarmSkeleton`, `DashboardSkeleton`) + 1 primitive (`Skeleton`) |
| Pages routed in App.tsx with a Suspense fallback | 31 routes |
| Distinct fallback values used | 4 (PageSkeleton ×26, FarmSkeleton ×1, SwapSkeleton ×2, DashboardSkeleton ×1) |
| Pages that import `PageSkeleton` directly | 4 (`LeaderboardPage`, `LearnPage`, `ActivityPage`, `InfoPage`) |
| Pages with no skeleton + fetch on mount | 6+ (HomePage, DashboardPage live region, FarmPage live region, GalleryPage, AdminPage, LendingPage section-level diverges) |
| Tests targeting `PageSkeleton.tsx` | 10 |
| Tests targeting `PageSkeletons.tsx` | **0** |
| Tests targeting `ui/Skeleton.tsx` | **0** |
| `aria-busy` occurrences in any skeleton file | **0** |
| `prefers-reduced-motion` JS check in skeleton files | **0** (CSS-level only) |
| Variant props with invalid-variant render-empty risk | 0 (no variants prop exists) |
| Suspense boundaries forcing whole-page suspense | 1 root + 31 route-level = layered spinner-then-shape ladder |

---

## Top-3 (severity-ranked)

1. **F-1 (HIGH) — Skeleton dimensions diverge dramatically from the rendered pages.** Every lazy route hydration produces a measurable CLS jump (centered spinner → page chrome; or skeleton card grid → real card grid with extra sections). Most painful on `/farm` (skeleton missing `BoostScheduleTable`, `LPFarmingSection`, `WrongChainBanner`, upcoming pools), `/dashboard` (missing 4-tab bar), and `/swap` (skeleton 480px wide vs full-width real content + tabs).

2. **F-2 (HIGH) — Infinite animations rely on a global `*` rule, not a component-level guard.** `animate-[spin_0.8s_linear_infinite]` & `animate-[skeleton-pulse_1.5s_ease-in-out_infinite]` (PageSkeleton.tsx:11-12) and the `.skeleton` class shimmer (`index.css:420`) all run forever; the global `@media (prefers-reduced-motion: reduce)` at `index.css:684` does clamp them via `!important`, but the components themselves have no `motion-reduce:` Tailwind variant or JS check. Fragile and untested.

3. **F-3 (HIGH) — `aria-busy` missing on every skeleton component.** All four skeletons (`PageSkeleton.tsx`, `SwapSkeleton`/`FarmSkeleton`/`DashboardSkeleton` in `PageSkeletons.tsx`) lack `aria-busy="true"`. The three `PageSkeletons.tsx` variants additionally lack `aria-live`. Screen readers cannot reliably tell that the region is provisional.

---

## Suggested remediation pointers (out of scope for AUDIT-ONLY but logged)

- Add `aria-busy="true"` and `aria-live="polite"` to every skeleton wrapper (3 lines).
- Add `motion-reduce:animate-none` to spinner & shimmer divs (Tailwind variant) **AND** retain the global CSS rule.
- Wire each route-level `<Suspense fallback>` to the page-shape skeleton; make the root-level Suspense fall through (`fallback={null}`) since the route boundary handles it.
- Tune `SwapSkeleton` / `FarmSkeleton` / `DashboardSkeleton` to actually mirror the live page layout (tab bar height, banner heights, real card counts at the breakpoints in use).
- Add a "still loading" timeout (8-10s) inside `PageSkeleton` to surface a retry affordance.
- Add tests for: aria-busy, prefers-reduced-motion (mock `matchMedia`), `SwapSkeleton`/`FarmSkeleton`/`DashboardSkeleton`, and `ui/Skeleton.tsx`.

---
END OF AUDIT 075
