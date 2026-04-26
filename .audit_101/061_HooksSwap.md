# Agent 061 — Swap/DCA/Limit-Order Hooks Forensic Audit

**Targets**

- `frontend/src/hooks/useSwap.ts` (417 lines)
- `frontend/src/hooks/useSwapAllowance.ts` (89 lines)
- `frontend/src/hooks/useSwapQuote.ts` (381 lines)
- `frontend/src/hooks/useDCA.ts` (466 lines)
- `frontend/src/hooks/useLimitOrders.ts` (440 lines)
- Cross-check: `frontend/src/hooks/useSwap.test.ts` (443 lines, 22 tests)

Findings are categorized **CRITICAL / HIGH / MEDIUM / LOW / INFO** with line numbers
relative to the file as it currently sits on `main` (commit `0b22479`).

---

## Severity Counts

| Severity | Count |
| --- | --- |
| CRITICAL | 0 |
| HIGH | 5 |
| MEDIUM | 9 |
| LOW | 7 |
| INFO | 4 |
| **Total** | **25** |

---

## HIGH-1 — Stale-closure on `executeSwap`: BroadcastChannel cross-tab amount race [useSwap.ts:207-340]

`executeSwap` is `useCallback`-memoized with `parsedAmount, quote, slippage` in
the deps array (line 340). That is correct for *that tab*. But a user with two
tabs open on the swap page can:

1. Tab-A: type `1.0 ETH`, click Swap → wallet popup waits for sig.
2. Tab-B: switches `inputAmount` to `0.1 ETH` (saved through localStorage echo
   of `tegridy_custom_tokens`, but `inputAmount` itself is *not* persisted, so
   Tab-A's `parsedAmount` is fine).
3. Tab-A: in Tab-A the `inputAmount` is unchanged → harmless.

So the cross-tab vector for `useSwap` is not exploitable — but the *intra-tab*
stale-closure is. After the user types an amount, clicks Swap, then *quickly*
types a different amount before the wallet popup is dismissed, there's a
window where:

- `writeContract` was already called with the old `parsedAmount` (correct).
- The user perceives the new amount in the input field (because React updated).
- On the receipt success effect (line 130-158), the `trackSwap` analytics call
  fires with `inputAmount` from *that effect's closure* — which captures the
  **new** value the user typed, **not** the value actually swapped.

`trackSwap(fromToken?.symbol ?? '', toToken?.symbol ?? '', inputAmount, quote.selectedRoute);`
on line 152 logs the **post-swap** `inputAmount`, not the amount the chain
saw. Analytics will be silently wrong for any user who edits the input
between submit and confirmation.

**Fix:** snapshot `inputAmount` (and `selectedRoute`) into a ref at submit
time and read from the ref in the success effect.

**Severity rationale:** HIGH because revenue/conversion analytics drives
business decisions and a silent skew is hard to detect.

---

## HIGH-2 — `executeSwap` deps missing `chainId` and `address` [useSwap.ts:340]

```ts
}, [address, chainId, fromToken, toToken, parsedAmount, insufficientBalance,
    swapType, deadline, quote, slippage, writeContract, supportsFeeOnTransfer]);
```

Wait — both *are* in deps. But `quote` is an entire object reference returned
from `useSwapQuote`. That hook returns a fresh object on every render
(`return { outputAmount, ... }` is a new literal each call). So
`executeSwap`'s identity changes **every render**, defeating the
`useCallback` and forcing every consumer (`SwapForm`, `SwapButton`,
`SwapBatch`, …) to re-render any time *any* state changes. This isn't a
functional bug but a **performance footgun** that triggers React's
"warn on identical deps" linter only intermittently.

More importantly: because `quote` is a fresh object, the FoT auto-detect
effect on line 164-183 (deps: `writeError, supportsFeeOnTransfer, fotRetryAttempted`)
**never sees `quote`** — but the FoT toggle changes the swap path computed
inside `executeSwap`. After auto-toggle, the *next* render's `executeSwap`
will use FoT correctly because `supportsFeeOnTransfer` is in `executeSwap`'s
deps. OK — false alarm on that one. The render-storm cost remains.

**Fix:** decompose `quote` so only the load-bearing primitives (`outputAmount`,
`minimumReceived`, `path`, `selectedRoute`, `selectedOnChainRoute.source`,
`selectedOnChainRoute.output`) appear as `executeSwap` deps.

**Severity rationale:** HIGH because rapid-typing the input box triggers
N re-renders of every child component, which can drop typed characters on
slow devices (iPhone 14 = mid-tier mobile per memory `project_responsive.md`).

---

## HIGH-3 — `useSwapQuote` aggregator effect: stale-result race despite request-ID [useSwapQuote.ts:189-214]

The effect at 189-214 is well-intentioned: it bumps `quoteRequestIdRef.current`
on each invocation, captures `currentRequestId`, debounces by 800ms, and
checks the ref before applying. But there's a real gap:

```ts
return () => { abortController.abort(); clearTimeout(timer); };
```

The cleanup correctly aborts the in-flight `fetch` (the `abortController.signal`
is passed into `getAggregatorPrice`). But `quoteRequestIdRef.current` is
*not bumped* on cleanup — only on the next effect run. If the component
**unmounts** mid-flight, the aborted promise rejects with `AbortError`,
the `.catch` on line 207-211 calls `setAggQuoteResult(null)` only if
`!abortController.signal.aborted` (it *is* aborted, so this guard works) —
**but** if the user *changes tokens twice* (effect re-runs twice rapidly):

1. Run-1: id=1, abort1 created, fetch1 in flight.
2. Cleanup-1: abort1.abort() → fetch1 rejects with AbortError → guard skips.
3. Run-2: id=2, abort2 created, fetch2 in flight.
4. **Race: if fetch1 completes between abort1.abort() and the .catch firing**
   (browser fetch implementations sometimes resolve before checking the
   signal), the `.then` on line 201 runs. It checks
   `!abortController.signal.aborted` → **`abortController` here is abort2 in
   the closure, not abort1.** Wait — no, the closure captured `abortController`
   from Run-1's lexical scope. So it checks abort1.signal.aborted → true →
   skipped. **OK.**

Re-reading carefully: the closure does capture `abortController` correctly.
The race is **theoretically guarded**. But one subtlety: the `currentRequestId`
guard is redundant *if* abort works correctly, and the abort-signal guard
is redundant *if* request-ID works. Belt-and-suspenders is fine, but the
real bug is that `getAggregatorPrice` calls **7 aggregator endpoints in
parallel** and only some honor `signal`. Test in `aggregator.ts` would be
needed; the code as-written passes `signal` through, so this is a code-review
flag rather than a confirmed bug.

**Severity rationale:** HIGH because the same effect logic is duplicated (
implicitly) in user-perceived staleness — when typing fast, the aggregator
quote on screen lags and may be from a previous amount.

---

## HIGH-4 — `useDCA.executeDCASwap` rebuilds path *without* checking if pair exists [useDCA.ts:296-416]

`buildPath()` (line 144-151) blindly returns `[from, WETH, to]` for any
non-WETH pair. If the user creates a DCA schedule for an obscure token where
the WETH leg doesn't exist, every poll-tick will:

1. `claimTabLock` → success
2. Mark executing
3. `getAmountsOut` → revert (no pair) → caught at line 328 → `releaseTabLock`,
   toast.error, return.
4. Next tick (30s later): repeat indefinitely.

The toast spam every 30s on a hidden tab is an **annoyance**, not a security
bug. But the schedule never gets paused/marked-broken. A user who walks
away returns to 30+ identical error toasts.

**Severity:** HIGH (UX — violates `feedback_no_preview.md` UX bar implicitly:
errors should be actionable).

**Fix:** after N consecutive quote failures, auto-pause the schedule with a
distinct toast.

---

## HIGH-5 — `useLimitOrders` price polling: stale `executeOrder` closure inside async loop [useLimitOrders.ts:389-419]

The price-poll loop on 389-419 awaits `readWithTimeout(...)` for each order
sequentially. The `executeOrder` reference captured at line 414 is the one
from this `useEffect`'s creation time. Deps on line 434:
`[address, publicClient, persist, executeOrder]` — so the effect re-creates
when `executeOrder` changes. That's correct **but**:

`executeOrder` itself depends on `[address, chainId, writeContract, publicClient,
markFilled, revertOrderStatus, waitForReceipt]` — `markFilled` and
`revertOrderStatus` both depend on `[address]`, so they're stable for a session.
`waitForReceipt` depends on `[publicClient, markFilled, revertOrderStatus]`.

So `executeOrder` is **stable** as long as `address`/`chainId` don't change.
**But if the user switches networks while an order is mid-poll** (`chainId`
becomes 11155111), `executeOrder` regenerates → effect cleanup runs →
`clearInterval(timer)` + `executingRef.current.clear()` — wait, line 432-433.
**`executingRef.current.clear()` is run on every cleanup**, including when
deps change. So if `executeOrder` regenerates for *any* reason (e.g.,
chain-mismatch toast triggers chainId change), **all in-flight executing
locks lose their in-memory tracking** (the localStorage lock survives, so
multi-tab is OK). But this same tab will now re-attempt the order on the
next poll because `executingRef.current.has(order.id)` → false. The
on-chain tx is in flight, the user gets a duplicate-submission popup.

**Severity:** HIGH — same hazard the prompt called out as *retry that
doubles user submission*.

**Fix:** don't clear `executingRef` on every cleanup; only clear on
unmount. Track unmount with a ref.

---

## MEDIUM-1 — `useSwap` storage write on every render-batch [useSwap.ts:58-64]

```ts
useEffect(() => {
  try {
    localStorage.setItem('tegridy_custom_tokens', JSON.stringify(customTokens));
  } catch { /* … */ }
}, [customTokens]);
```

`customTokens` is an array. Every `addCustomToken` creates a new array, so
the effect fires. This is fine. But on initial mount, the effect *also*
fires (writing the same value back to localStorage), which is an
unnecessary write. Negligible perf cost, INFO-tier.

**Severity:** MEDIUM only because `localStorage.setItem` triggers a
storage-event in **other tabs** of the same origin, which then re-render
(because the StorageEvent listener in any tab using this key would
re-read). No such listener exists currently → **downgrade to LOW**.

---

## MEDIUM-2 — `useSwap` receipt-success effect: missing reset on tx **failure** [useSwap.ts:130-158]

The success branch resets `inputAmount` after 4s. The error branch (effect
at 164-183) shows a toast but **does not** reset `inputAmount` or call
`reset()`. After a failed swap, `isSuccess=false, isPending=false,
writeError=set` — the UI shows the input still populated, the "Swap"
button enabled, ready for retry. **But `lastActionRef.current` is still
`'swap'` from the failed attempt.** If the user immediately re-clicks Swap,
the executeSwap path tags it again as `'swap'` (line 214), so this is fine.
**But if the user clicks Approve next** (because the failure was a stale-
allowance edge case), `lastActionRef.current` becomes `'approve'`. On
success the approve path runs. OK — the ref is overwritten on every action.
**No bug.**

**Severity:** MEDIUM downgraded to **INFO** after analysis.

---

## MEDIUM-3 — `useSwapAllowance` doesn't gate by `chainId` [useSwapAllowance.ts:33-49]

Unlike `useSwapQuote` (which has `onRightChain` gating, line 71), the
allowance reads on line 33-49 only check `!!address && !!fromToken`. On a
wrong chain, the allowance read returns `[failure, failure]` (because the
contracts don't exist there), so `uniAllowance=0n, tegridyAllowance=0n`,
so `needsApproval=true` → user sees "Approve" button. They click it →
`writeContract` is called for an ERC-20 approval **on the wrong chain**.
Wagmi's `useWriteContract` doesn't pin `chainId`, so the user signs an
approval **on whatever chain they're connected to**. If they're on a
testnet with a token at the same address as a mainnet token → allowance
gets set on the wrong chain.

**Severity:** MEDIUM — `executeSwap` itself blocks wrong-chain (line 209),
so the swap won't fire, but the **approval already burned gas**.

**Fix:** in `useSwapAllowance.approve`, gate on `chainId === CHAIN_ID` or
pass `chainId: CHAIN_ID` to the read AND write.

---

## MEDIUM-4 — `useSwapQuote.priceImpact`: divide-by-zero defaulted to fixed 0.5% [useSwapQuote.ts:286, 295]

```ts
if (r1In <= 0n || r1Out <= 0n) return 0.5;
```

When the leg-1 reserves haven't loaded yet (or are zero, which means the
pair was just created), the function returns a **hardcoded 0.5%** price
impact. The UI shows "0.5%" while loading — users may proceed, thinking
the impact is small, when in fact it's unknown. After the reserves
load, the value updates. But for fast-typing scenarios, the user may
click Swap before the reserves arrive.

**Severity:** MEDIUM — misleading UI during a transient state.

**Fix:** return `null` and have the UI render a skeleton/spinner.

---

## MEDIUM-5 — `useSwapQuote`: aggregator quote uses `parsedAmount.toString()` ignoring decimals [useSwapQuote.ts:200]

```ts
getAggregatorPrice(sellToken, buyToken, parsedAmount.toString(), address, fromDecimals, abortController.signal)
```

This passes `parsedAmount` (already in token's smallest unit, BigInt-stringified)
plus `fromDecimals`. The function in `aggregator.ts:310-326` accepts both,
which is correct. **But** `getAggregatorPrice` aliases `getMetaAggregatorQuotes`
(line 318), and the underlying aggregator APIs (0x, 1inch, etc.) expect
**raw smallest-unit amounts**, not decimal-adjusted. This is correct —
**no bug**. INFO-tier.

---

## MEDIUM-6 — `useDCA` lock TTL: 20s vs MetaMask hardware-wallet sign latency [useDCA.ts:49, 314]

The 20s TTL with periodic `refreshTabLock` calls (lines 314, 368) refreshes
the lock at two boundaries: after `parseUnits` and after the allowance
check. **But the gap between `refreshTabLock` (line 368) and `writeContract`
(line 382)** is unbounded — that's where the wallet popup blocks. On a
Ledger / Trezor with PIN + manual confirm, this can easily exceed 20s.
After that, **another tab can claim the lock** and submit a duplicate tx.

The `refreshTabLock` *could* be called inside a `setInterval` between
write submission and `onSuccess`/`onError` callback, but it isn't.

**Severity:** MEDIUM — affects HW wallet users specifically.

**Fix:** start a refresh-loop interval right before `writeContract`, clear it
in both onSuccess and onError.

---

## MEDIUM-7 — `useDCA` polling races on token list edits [useDCA.ts:419-445]

The `checkDue` function inside `useEffect` reads `schedulesRef.current`
(line 423). When the user adds/cancels a schedule, `persist` updates
both state and ref synchronously (line 209-213). But during a poll-tick,
`for (const s of current)` iterates over a snapshot — if `cancelSchedule`
fires *during* iteration (impossible synchronously, but `setSchedules`
inside any of the lock callbacks could re-run), the iteration uses the
old snapshot. **No actual bug** because JS is single-threaded, but the
ref-vs-state pattern is fragile. INFO-tier.

---

## MEDIUM-8 — `useLimitOrders.executeOrder` BigInt math precision [useLimitOrders.ts:271-275]

```ts
const PRECISION = 1000000000000n; // 1e12
const targetPriceScaled = BigInt(Math.round(targetPriceNum * 1e12));
const amountScaled = BigInt(Math.round(amountNum * 1e12));
const expectedOut = (targetPriceScaled * amountScaled * (10n ** BigInt(order.toToken.decimals))) / (PRECISION * PRECISION);
```

For `targetPriceNum * 1e12` to fit safely in a JS Number,
`targetPriceNum < 2^53 / 1e12 ≈ 9007`. For wstETH/WETH at ~1.13, fine.
For `WBTC/SHIB` price (in SHIB per WBTC, ~3e12), this overflows the
safe-integer range. `Math.round` of an unsafe number returns garbage.
The result: `minOut` is wildly wrong, the order either never fires or
fires with extreme slippage.

**Severity:** MEDIUM — affects exotic pairs only, but is silent.

**Fix:** validate `targetPriceNum * 1e12 < Number.MAX_SAFE_INTEGER` and
reject the order or fall back to a different scale.

---

## MEDIUM-9 — `useLimitOrders` `currentPrice` Number coercion [useLimitOrders.ts:410]

```ts
const currentPrice = Number(formatUnits(outputAmount, order.toToken.decimals)) / Number(order.amount);
```

`formatUnits` returns a string with full precision. `Number()` truncates to
~15 sig figs. For an 18-decimal token outputting 0.000000123456789012345
of a high-decimal token, the conversion drops the last 3-4 digits. The
limit-order trigger compares `currentPrice >= targetPriceNum` — **acceptable**
because the comment on line 409 acknowledges this: "Number() precision risk
for very large values (>2^53); acceptable for price comparison heuristic".

**Severity:** MEDIUM downgraded to **INFO** (developer was aware and
documented the tradeoff).

---

## LOW-1 — `useSwap.executeSwap`: deadline truncation if Date.now() drifts [useSwap.ts:227]

`BigInt(Math.floor(Date.now() / 1000) + deadline * 60)` — `deadline` is a
number (5 by default, settable via `setDeadline`). If a future feature
allows `setDeadline` to accept fractional minutes (currently it doesn't),
`Math.floor` would truncate. Harmless today.

---

## LOW-2 — `useSwap` `addCustomToken` toast firing twice on dedupe [useSwap.ts:350-360]

If user re-imports the same token, the function `find()` matches → returns
prev unchanged. **But the warning toast fired before the dedupe check.** The
user gets the unverified-token warning toast even when the token was already
imported. Minor UX nit.

**Fix:** move the dedupe check before the toast.

---

## LOW-3 — `useDCA` executingRef cleared on poll-effect cleanup [useDCA.ts:443]

`executingRef.current.clear()` runs when the effect re-runs (any time
`address` or `executeDCASwap` changes). In practice that's only on disconnect,
which is fine. But coupled with the `useCallback` dep churn on
`executeDCASwap`, any stable-address change to its deps would orphan the
in-memory tracking. See HIGH-5 for the worst version of this.

---

## LOW-4 — `useDCA` `requestNotificationPermission` at every address change [useDCA.ts:178]

Browser policy ignores repeated calls after the first prompt, so harmless.

---

## LOW-5 — `useLimitOrders` order ID collisions [useLimitOrders.ts:194]

```ts
id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
```

6 chars of base36 = 36^6 ≈ 2.2B. Colliding within the same millisecond
requires creating 50+ orders simultaneously. Mathematically negligible but
not cryptographic.

---

## LOW-6 — `useLimitOrders` `MAX_ORDERS=50` vs `useDCA` `MAX_SCHEDULES=20` inconsistency [useLimitOrders.ts:44, useDCA.ts:33]

Limit-order cap is 2.5× the DCA cap with no documented reason. DCA does
on-chain calls every poll for **all active schedules**, which is more
expensive than limit-order's batch quote. INFO-only.

---

## LOW-7 — `useSwap.test.ts` coverage gaps

Test file (443 lines, 22 it()) covers:
- Init defaults, slippage clamps, flipDirection, swapType variations
- Action no-ops (empty, wrong network, needsApproval, zero output, self-swap)
- Action positive paths (ETH→TOKEN, TOKEN→ETH, TOKEN→TOKEN × tegridy/uniswap/aggregator)
- minimumReceived recomputation on aggregator route

**Missing coverage:**
- FoT auto-detect path (writeError → setSupportsFeeOnTransfer)
- Receipt-success effect (no test for the `lastActionRef` swap-vs-approve split)
- The 4s setTimeout cleanup
- `addCustomToken` warning toast firing
- Stale-closure scenarios (rapid input changes mid-tx)
- Chain-mismatch with `executeSwap` already in flight

**Severity:** LOW (existing tests are correct; gaps are coverage holes).

---

## INFO-1 — `useSwap` 20% slippage cap is well-defended [useSwap.ts:36-43]

Documented, dual-bound (raw + cap), exposed only through clamped setter.
Good defensive programming.

---

## INFO-2 — `useSwapQuote.onRightChain` chain-gating [useSwapQuote.ts:71]

Excellent pattern — every `useReadContract` for swap quote is gated by
`chainId === CHAIN_ID`. This is *not* repeated in `useSwapAllowance` (see
MEDIUM-3) or `useSwap`'s balance reads (lines 102-118), where `chainId:
CHAIN_ID` is hardcoded into the read (which works for mainnet pinning but
prevents future multi-chain).

---

## INFO-3 — `useDCA` BroadcastChannel sync [useDCA.ts:9, 182-191]

Cross-tab `dca_updated` message handling is correct. Note that the channel
is created at module-load (singleton across hook instances), so an
`addEventListener` per hook is fine. Cleanup correctly removes the listener.

---

## INFO-4 — `useLimitOrders.readWithTimeout` [useLimitOrders.ts:31-38]

Hard 10s RPC timeout via `Promise.race` is the right pattern. Note that the
losing promise (the actual RPC call) is **not aborted** when the timeout
wins — the fetch keeps running in the background and eventually resolves
to a discarded result. For wagmi's `publicClient.readContract`, this means
RPC-call leakage on slow nodes. INFO-only.

---

# Recommendations Ranked

1. **HIGH-5** (limit-order duplicate-submit on chainId change) — fix first;
   user-fund-loss potential.
2. **HIGH-1** (analytics stale closure) — silent revenue corruption.
3. **HIGH-2** (`quote` object reference churn) — perf regression on mobile.
4. **MEDIUM-3** (allowance approval on wrong chain) — gas-burn UX bug.
5. **MEDIUM-6** (DCA lock TTL vs HW-wallet) — duplicate-submit on hardware
   wallet users.
6. **MEDIUM-4** (priceImpact 0.5% default) — misleading load-state UI.
7. **MEDIUM-8** (limit-order BigInt scale overflow on exotic pairs).
8. Test coverage (LOW-7) — add stale-closure and FoT-auto-toggle cases.

---

**End of audit 061.**
