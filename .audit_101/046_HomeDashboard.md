# Audit 046 — HomePage.tsx + DashboardPage.tsx

Forensic review (audit-only, no fixes).

Files:
- `frontend/src/pages/HomePage.tsx` (437 lines)
- `frontend/src/pages/DashboardPage.tsx` (689 lines)

## Findings summary

- HIGH: 1
- MEDIUM: 5
- LOW: 6
- INFO: 3

---

## HIGH

### H1 — `useEffect` with stale-closure / re-trigger risk on Towelie nudge
**File:** `frontend/src/pages/DashboardPage.tsx:122-126`
```ts
useEffect(() => {
  if (!isConnected || isWrongNetwork) return;
  if (!pos.hasPosition || pendingTotal < 0.01) return;
  say(`You've got ${pendingTotal.toFixed(2)} TOWELI waiting. Claim it.`, { key: 'unclaimed-yield' });
}, [isConnected, isWrongNetwork, pos.hasPosition, pendingTotal, say]);
```
- `pendingTotal` is a `Number(pos.pendingFormatted)` derived value that recomputes every render and very likely changes on every block/poll tick from `useUserPosition`. Each tiny floating-point delta in `pendingTotal` re-fires the effect and re-calls `say(...)`. Comment says "dedup by `key`" but dedup is delegated to `useTowelie` — if that dedup is keyed only by `key` it’s fine, but the effect itself becomes a hot loop that runs N times per second under price churn. If dedup is *time*-windowed there is risk of repeated nudges.
- `say` is a callback from a hook; if it’s not stable (no `useCallback`), it changes identity each render → unbounded re-render / re-fire loop.
- Mitigation: stable `say`, narrow deps, or gate with a ref (`firedRef.current`).

---

## MEDIUM

### M1 — Unsanitized URL search param accepted as state without guard against history pollution
**File:** `frontend/src/pages/DashboardPage.tsx:57-71`
- `dashTabFromQuery` correctly whitelists against `VALID_DASH_TABS`, which mitigates the worst case (rendering arbitrary user input). Good.
- However, `setSearchParams(params, { replace: true })` is fine, but the `useEffect` at L61-64 reads from `searchParams` and writes to `tab` whenever `searchParams` changes — combined with `tab` in deps, this can race the user’s own click handler and cause a double-render flicker. Not a security bug; a re-render correctness issue. Consider dropping `tab` from deps or splitting the read/write effects.

### M2 — Stale-closure risk in `farmActions.isSuccess` toast effect
**File:** `frontend/src/pages/DashboardPage.tsx:113-117`
```ts
useEffect(() => {
  if (farmActions.isSuccess) {
    toast.success('Rewards claimed successfully!');
  }
}, [farmActions.isSuccess]);
```
- If `farmActions.isSuccess` stays `true` across renders (some wagmi/wagmi-like hooks hold success until reset), this effect won't re-fire on a *second* claim because the value didn’t change `true → true`. But the bigger risk is firing the toast on initial mount if the hook auto-rehydrates `isSuccess: true` from cache — duplicate toast on every page visit after a recent claim. Same pattern at L531-535 in `ETHRevenueClaim`.

### M3 — `useReadContract` arg uses `address!` non-null assertion guarded only by `query.enabled`
**File:** `frontend/src/pages/DashboardPage.tsx:85-91`
```ts
args: [address!],
query: { enabled: !!address },
```
- `address!` will resolve to `undefined` at first render before wagmi connects. If wagmi v2 ever evaluates `args` before `enabled`, this triggers an internal error. Defensible because of `enabled`, but using `args: address ? [address] : undefined` is the safer pattern. Same pattern at L521-522 with `address as ${"`"}0x${"`"}` cast that suppresses the type system.

### M4 — Prop-drilling loses `chainId` context to revenue/referral widgets
**File:** `frontend/src/pages/DashboardPage.tsx:489-506` (Rewards tab → `ETHRevenueClaim`, `ReferralWidget`)
- `ETHRevenueClaim({ address, isWrongNetwork })` doesn’t receive `chainId`. The `useReadContract` inside L517-523 will be implicitly bound to the active wagmi chain. If the user switches chain mid-session, the read can target a wrong chain’s `REVENUE_DISTRIBUTOR_ADDRESS` (the constant is mainnet-only — see `lib/constants`), producing zero/error reads silently. `isWrongNetwork` gates the *button* but not the *read*. User on wrong chain sees stale 0 ETH instead of an explicit error.
- Same chainId loss to `ReferralWidget` (L493-505): no chainId prop, no explicit chain pin in its hooks (revenueStats hook may or may not pin — out of scope to verify).

### M5 — External link missing protective rel even though `noopener noreferrer` is present elsewhere — audit identifies it as **PASS** but flag Ecosystem `<a>` tags need `referrerPolicy` posture for OpenSea/Uniswap
**File:** `frontend/src/pages/HomePage.tsx:324, 346, 358`
- All three external `<a target="_blank">` correctly set `rel="noopener noreferrer"`. PASS.
- *However*, the GitHub URL in HomePage.tsx:321 (`https://github.com/fomotsar-commits/tegridy-farms`) leaks the **GitHub username** of the deployer in the public bundle. That’s already public via commits, so not a secret leak — but `fomotsar-commits` is the same handle visible in user’s git config, which is a fingerprinting concern if the user wants pseudonymity. INFO-grade unless user has stated they want anonymity (per memory: never leak secrets, but username is public on chain commits already). Flagging for awareness.

---

## LOW

### L1 — Empty `alt=""` on decorative art is correct, but main hero art uses empty alt
**File:** `frontend/src/pages/HomePage.tsx:76, 206, 222, 267, 298, 349, 361, 372` and `DashboardPage.tsx:137, 161, 209, 285, 300, 317, 363, 383, 425, 454, 542, 590`
- Empty `alt=""` is the correct WCAG choice for decorative imagery — these are background art layers. PASS for decorative usage.
- However, `frontend/src/pages/HomePage.tsx:400-401` (Collection grid):
```tsx
<img src={piece.src} alt={piece.title} ... />
```
This is good — the alt text is the piece title. PASS.
- L267 (`pageArt` card images for Swap/Farm/Dashboard cards) uses `alt=""` but the parent `<Link>` has no `aria-label`. Screen reader announces just "link, Swap" from the heading text — acceptable but suboptimal. LOW.

### L2 — Hardcoded color hex values in inline style instead of CSS vars
**File:** `frontend/src/pages/DashboardPage.tsx:215, 225, 228, 234, 241`
- `color: '#22c55e'` hardcoded instead of `var(--color-kyle)` (used elsewhere in HomePage.tsx). Inconsistency only; not a bug. Theme-tokenization opportunity.

### L3 — `priceData.length > 1` and `priceHistory.length > 1` checks both used inconsistently
**File:** `frontend/src/pages/HomePage.tsx:184` vs `frontend/src/pages/DashboardPage.tsx:230`
- HomePage uses local `priceData` from `priceHistory.history` (L58-59). Dashboard uses `priceHistory` directly from destructuring at L82. Both are fine; just diverging style in two pages.

### L4 — `min-h-[88px]` and other arbitrary Tailwind values not in design tokens
**File:** `frontend/src/pages/HomePage.tsx:218`
- Mobile/iPad responsive: the Core Loop grid at L213 collapses to single column on mobile (`grid-cols-1 md:grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr]`). Arrow direction switches from `↓` (mobile) to `→` (desktop) at L239-240. Good responsive behavior. PASS.
- Hero CTA buttons at L100-116 use `flex flex-wrap gap-3` — wraps gracefully on iPhone 14 (390px) and iPad portrait. PASS.
- `max-w-[1200px]` at L79, L165 — fine for desktop, no horizontal scroll on iPad pro 11" (834px) due to inner `px-4 md:px-6`. PASS.

### L5 — Dashboard tab bar has `overflow-x-auto` for narrow screens but tab labels could overflow on tiny mobile
**File:** `frontend/src/pages/DashboardPage.tsx:252-275`
- 4 tabs × ~80px each ≈ 320px, fits iPhone 14 (390px) just barely. PASS but close to overflow if labels were translated to longer language.
- `min-h-[44px]` at L264 meets Apple HIG touch target. PASS.

### L6 — `useSearchParams` array destructure declares `setSearchParams` even though only `searchParams` is used in the read effect
**File:** `frontend/src/pages/DashboardPage.tsx:57`
- Cosmetic only.

---

## INFO

### I1 — No `dangerouslySetInnerHTML` anywhere in either file
- Confirmed via full read. PASS.

### I2 — No `window.__INITIAL__` style hydration leak
- Neither file references `window.__INITIAL__`, `window.__PRELOADED_STATE__`, or any global hydration shim. PASS.

### I3 — No fetch URLs hardcoded
- All hooks (`useFarmStats`, `usePoolData`, `useRevenueStats`, `usePriceHistory`, `useTOWELIPrice`, etc.) are abstracted; no `fetch('https://...')` in either page file. Whatever URL config they use lives in the hook implementations (out of scope for this audit). PASS at the page layer.

### I4 — `useAccount` references are current wagmi v2 API
- `const { address } = useAccount()` (HomePage:52)
- `const { isConnected, address } = useAccount()` (DashboardPage:55)
- Both consistent with wagmi v2. No stale `useAccount.data` or v1-style usage. PASS.

### I5 — Rate-limiting on `useFarmStats`, `usePoolData`, `useRevenueStats`, `usePriceHistory`
- Page files do not impose rate-limiting; they trust the hooks. The 7000ms `setInterval` at HomePage:67-71 is a *quote rotator*, not a network call — no DoS risk. PASS at page layer; rate-limiting concern would be in the hooks (out of scope here).

---

## Top 3 actionable items

1. **DashboardPage:122-126** — Towelie nudge effect re-fires on every `pendingTotal` numeric tick. Convert dedup to a `useRef` gate or memoize trigger condition; verify `useTowelie.say` is `useCallback`-stable.
2. **DashboardPage:489 / ETHRevenueClaim** — `chainId` not threaded through; on chain mismatch the `useReadContract` reads a meaningless 0 instead of explicit "wrong network" state in the widget. Pin chain or re-check `isWrongNetwork` inside the read’s `enabled`.
3. **DashboardPage:113-117 + 531-535** — `farmActions.isSuccess` / `isClaimSuccess` toast effects can fire on cached success state at mount → duplicate claim toasts. Gate with a `useRef` "fired" flag, or reset the wagmi mutation state on unmount.

— end audit 046 —
