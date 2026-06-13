# Remediation Plan — g04_trade (Swap + Liquidity + aggregator client)

Surface: `TradePage.tsx`, `useSwap.ts`, `useSwapAllowance.ts`, `useSwapQuote.ts`, `useDCA.ts`,
`useLimitOrders.ts`, `useCowLimitOrder.ts`, `useAddLiquidity.ts`, `useMevProtection.ts`,
`lib/aggregator.ts`, `lib/formatting.ts`, the DCA/Limit/Liquidity tab components, the token-select
modal, and `components/chart/PriceChart.tsx`. Verified at HEAD of `mvp-launch`.

All findings were opened and confirmed against the cited source before planning. Several "live" findings
are **stale-prod** (already fixed at HEAD → redeploy-only). The biggest theme is the **aggregator
wei/units leak** (F226/F227/F189/F235) and the **venue/spender mismatch family** (F186/F188), each of
which is one shared fix that closes multiple findings.

---

## Batch: `agg-units-formatting` — convert aggregator wei → token units everywhere (F226, F227, F189, F235, F196)

**Summary.** The single highest-impact defect on this surface: `AggregatorQuote.amountOut` is in **wei**
(documented at `aggregator.ts:48`), but three consumers treat it as a human token amount —
`routeSavingsPct` (`TradePage.tsx:102`), the route-detail rows (`TradePage.tsx:431`), and the savings
display. The fix is one shared normalization: format every aggregator `amountOut` with
`formatUnits(BigInt(q.amountOut), toToken.decimals)` at the point it enters the comparison/display, then
reuse that normalized list for the savings math and the count. Land all five together.

### F226 — Route Savings renders raw scientific notation (`+4.6e+21%`)
- **verdict:** fix-now · **rootCause:** T6 · **severity:** high · **effort:** S · **risk:** low
- **approach:** In `routeSavingsPct` (`TradePage.tsx:98-108`) the aggregator branch maps
  `parseFloat(q.amountOut)` (wei) alongside `tegridyOutputFormatted`/`uniOutputFormatted` (token units),
  mixing 3.5e25 with ~770318. Normalize: build the agg outputs via
  `parseFloat(formatUnits(BigInt(q.amountOut), swap.toToken.decimals))`. Surface the toToken decimals from
  `useSwap` (it already exposes `toToken`). Add a sane cap so the displayed % can't render exponential
  (e.g. clamp to 999 and label ">999%").
- **files:** `src/pages/TradePage.tsx:98-108`
- **test:** unit test on the extracted `routeSavingsPct` helper feeding wei agg quotes + formatted on-chain
  outputs; assert result is a small finite % and never `toExponential`. Manual: type 1 ETH, confirm the
  Route Savings row reads a plausible single/double-digit %.
- **deps:** []

### F227 — Route-detail venue rows display raw wei (`kyberswap 3.5e+25`)
- **verdict:** fix-now · **rootCause:** T6 · **severity:** high · **effort:** S · **risk:** low
- **approach:** `TradePage.tsx:431` calls `formatTokenAmount(q.amountOut)` on the wei string. Wrap with
  `formatUnits(BigInt(q.amountOut), swap.toToken.decimals)` first, then `formatTokenAmount(...)`. Same
  normalized value feeds the "Best" highlight comparison. Reuse a small inline
  `aggOut = (q) => formatUnits(BigInt(q.amountOut), toDecimals)` so the row and the savings math share it.
- **files:** `src/pages/TradePage.tsx:427-432`
- **test:** manual — expand "Compare all N routes"; aggregator rows show ~35.4M (matching Uniswap V2), not
  `3.5e+25`. Add a render test with a mocked `allAggQuotes` asserting no `e+` in the row text.
- **deps:** []

### F189 — Headline "You Receive" / "Best rate via X" / "Route Savings" advertise an unexecutable aggregator price
- **verdict:** product-decision · **rootCause:** T4 · **severity:** high · **effort:** M · **risk:** med
- **approach:** Confirmed: `useSwapQuote.ts:319` sets `outputAmount = aggBetter ? aggComparison.userReceives
  : selectedOnChainRoute.output`, and `calculateAggregatorSpread.userReceives` is the full aggregator output
  (`aggregator.ts:451-465`), while `executeSwap` (`useSwap.ts:379-408`) actually fills on the on-chain
  fallback (SFR/Uniswap) and `Min. Received` is anchored to the on-chain venue (`useSwapQuote.ts:401-406`).
  So the headline number is unreachable until real aggregator execution exists. **This needs an owner
  choice** because it changes the displayed "best price" semantics: Option A (honest, additive) — set the
  headline `outputAmount` to the executing on-chain venue's output, demote aggregator quotes to an
  informational "market comparison" row, and relabel `routeLabel` from "Best rate via CowSwap" to e.g.
  "Executes on Uniswap V2 (best executable route)"; keep the comparison panel (additive, no art removed).
  Option B — wire real execution (see F223) and keep the headline. Recommend A now, B later. Do **not**
  silently keep advertising the spread.
- **files:** `src/hooks/useSwapQuote.ts:312-323,422-429`, `src/pages/TradePage.tsx:265-267,382`
- **test:** with a connected session + a winning aggregator quote, assert `You Receive` equals the executing
  venue's output and `Min. Received <= You Receive`. Manual: confirm label no longer promises a venue the app
  can't route to.
- **deps:** [F223]

### F235 — "Savings vs worst venue" is computed against the protocol's own near-empty pool
- **verdict:** fix-now · **rootCause:** standalone · **severity:** medium · **effort:** S · **risk:** low
- **approach:** After the F226 units fix, the Tegridy DEX row (770k for 1 ETH vs ~35.4M elsewhere — empty
  native pool) still drags `worst` to a degenerate floor, inflating savings. In `routeSavingsPct`, exclude
  venues whose normalized output is more than X% below the **median** of the normalized set (or compare
  `best` vs **second-best** instead of `best` vs `worst`). Additionally badge the Tegridy DEX row "low
  liquidity" in `TradePage.tsx:415-419` when `tegridyOutputFormatted` is far below the others. Additive only.
- **files:** `src/pages/TradePage.tsx:98-108,415-419`
- **test:** unit: feed one degenerate-low venue + several clustered venues; assert it's excluded from the
  savings denominator and the % is credible. Manual: confirm Tegridy row carries a "low liquidity" badge
  pre-seed.
- **deps:** [F226]

### F196 — "Compare all N+2 routes" count is wrong when a venue has no quote
- **verdict:** fix-now · **rootCause:** standalone · **severity:** low · **effort:** S · **risk:** low
- **approach:** `TradePage.tsx:411` hardcodes `+2`, but the Tegridy and Uniswap rows render conditionally
  (lines 415/421). Compute from renderable rows:
  `allAggQuotes.length + (swap.hasTegridyPair && swap.tegridyOutputFormatted ? 1 : 0) + (swap.uniOutputFormatted ? 1 : 0)`.
- **files:** `src/pages/TradePage.tsx:411`
- **test:** with the empty Tegridy pool (`tegridyOutputFormatted` null), assert the button text count equals
  the number of rendered rows.
- **deps:** []

---

## Batch: `execution-spender-parity` — approve-spender must match the executing router (F186, F188)

**Summary.** Both findings are the same class: the approval/quote venue diverged from the execution venue
after the 2026-06-09 deep-pool reroute. Introduce ONE shared helper
`executionSpenderFor(route, onChainFallbackSource)` (new export in `lib/swapVenue.ts` or co-located in
`useSwapQuote.ts`) that maps `'tegridy' → SWAP_FEE_ROUTER_ADDRESS`, `'uniswap' → UNISWAP_V2_ROUTER`, and
`'aggregator' → spender of its on-chain fallback`, and have every approve/quote/execute path import it so
they can never drift again.

### F186 — Approval spender inverted vs the executing router → every ERC20 sell reverts
- **verdict:** fix-now · **rootCause:** standalone · **severity:** critical · **effort:** M · **risk:** high
- **approach:** Confirmed: `useSwapAllowance.ts:113` picks spender as `'tegridy' → TEGRIDY_ROUTER_ADDRESS`
  else `SWAP_FEE_ROUTER_ADDRESS`, and `needsApproval` (line 78) checks the same mapping — but
  `useSwap.ts:executeSwap` does the opposite (`'tegridy'` → SFR at 415-434; `'uniswap'` → UNISWAP_V2_ROUTER
  at 466-484; `'aggregator'` → SFR if fallback `tegridy` else UNISWAP_V2_ROUTER at 384-407). Fix: (1) add a
  shared `executionSpenderFor()` helper; (2) in `useSwapAllowance` read **three** allowances
  (SFR, TegridyRouter, **UNISWAP_V2_ROUTER**) in the `useReadContracts` batch; (3) select `activeAllowance`
  and the `approve()` spender via `executionSpenderFor(selectedRoute, selectedOnChainRoute.source)` — the
  exact function `executeSwap` uses to pick the target. Pass `selectedOnChainRoute.source` into the hook
  (already on the quote). Because SFR is wired to TegridyRouter, the SFR-execution path needs allowance to
  **SFR** (it pulls from caller, `SwapFeeRouter.sol:747`) — so `'tegridy'` correctly maps to SFR, not
  TegridyRouter. **High blast radius** (touches the gating of every ERC20 sell): land behind the parity test
  below.
- **files:** `src/hooks/useSwapAllowance.ts:52-78,113`, `src/hooks/useSwap.ts:205` (pass
  `selectedOnChainRoute.source`), new `src/lib/swapVenue.ts`
- **test:** new unit test asserting, for each `(selectedRoute, fallbackSource)` combo,
  `executionSpenderFor(...)` === the `address:` the `executeSwap` switch writes to (table-driven against the
  literal addresses). Manual on a fork: ERC20 sell on `uniswap` route → Approve targets UNISWAP_V2_ROUTER →
  Swap succeeds (no transferFrom revert).
- **deps:** []

### F188 — DCA + alert keepers quote on Uniswap but execute on SFR (empty native pool) → every trigger reverts
- **verdict:** fix-now · **rootCause:** standalone · **severity:** high · **effort:** M · **risk:** med
- **approach:** Confirmed: `useDCA.ts:434-441` quotes `UNISWAP_V2_ROUTER.getAmountsOut` then executes
  `SWAP_FEE_ROUTER_ADDRESS.swapExactETHForTokens` (496-530); identical in `useLimitOrders.ts` (quote
  319-330/481-494, execute 400-435). SFR routes on the empty native TegridyRouter pool. Mirror the main
  swap-tab venue logic: quote and execute on the **same** venue. Simplest battle-tested fix — route both
  keeper executions to `UNISWAP_V2_ROUTER` (matching their existing quote source), accepting no protocol-fee
  capture until the native pool is deep (same tradeoff the main swap path already accepts for the `uniswap`
  route). Keep the allowance pre-checks pointed at whatever spender executes (today they read SFR allowance
  at `useDCA.ts:467` / `useLimitOrders.ts:373` — switch to UNISWAP_V2_ROUTER allowance to match). Reuse the
  `executionSpenderFor` helper from F186 so the keepers and the swap tab share one source of truth.
- **files:** `src/hooks/useDCA.ts:435,467,496-530`, `src/hooks/useLimitOrders.ts:320,373,400-435`
- **test:** fork test: create a DCA schedule ETH→TOWELI, force a due tick, assert the `writeContract` target
  is `UNISWAP_V2_ROUTER` and the tx does not revert at estimation. Same for a triggered alert.
- **deps:** [F186]

---

## Batch: `receipt-latch` — stop the per-second success-effect storm (F187)

### F187 — Post-receipt success effect re-fires every second (duplicate toasts, false swap toast after approve, reset never fires)
- **verdict:** fix-now · **rootCause:** T5 · **severity:** high · **effort:** S · **risk:** med
- **approach:** Confirmed root cause chain: the success effect deps include `allowance`
  (`useSwap.ts:286`); `useSwapAllowance` returns a fresh object literal every render (no `useMemo`, lines
  195-204); and the 1s ticker in `useSwapQuote.ts:261-265` re-renders the page every second while
  `isSuccess && hash` stay truthy, so the effect's cleanup cancels the pending 4s `reset()` timer
  (line 284) before it fires, then re-toasts + re-`trackSwap` (268-278); after an approve receipt it doesn't
  schedule reset (260-266), so the next tick falls into the swap branch with `lastActionRef===null` and
  fires a phantom "WAGMI! Swap confirmed". Fix (defense in depth, three small changes): (1) add a
  `handledHashRef` and bail at the top of the effect if `hash === handledHashRef.current`, setting it before
  toasting; (2) `useMemo` the `useSwapAllowance` return object so its identity is stable; (3) give toasts
  stable ids (`toast.success(..., { id: hash })`). (1) alone closes the loop; (2)+(3) are belt-and-braces.
- **files:** `src/hooks/useSwap.ts:246-286`, `src/hooks/useSwapAllowance.ts:195-204`
- **test:** unit/RTL with fake timers: simulate `isSuccess=true` + stable `hash`, advance 5×1s ticks, assert
  `toast.success` and `trackSwap` are each called once and `reset()` fires after 4s. Repro for the phantom:
  set `lastActionRef='approve'`, land receipt, tick 1s, assert no swap toast.
- **deps:** []

---

## Batch: `quote-refresh-debounce` — quote freshness + aggregator refresh (F191, F193, F206)

### F191 — refreshQuote() doesn't actually re-fetch the aggregator and resets the staleness clock vacuously
- **verdict:** fix-now · **rootCause:** standalone · **severity:** medium · **effort:** S · **risk:** med
- **approach:** Confirmed: `refreshQuote` (`useSwapQuote.ts:437-446`) bumps `quoteRequestIdRef` (a ref, not
  reactive) and `setAggQuoteResult(null)`, but the aggregator effect's deps (line 251) don't include either,
  so it never re-runs; and `setQuoteFetchedAt(0)` makes `isQuoteStale` false immediately (lines 432-435 gate
  on `quoteFetchedAt > 0`), so a second Swap click passes the freshness gate before any refetch settles. Fix:
  add a `refreshNonce` **state** and include it in the aggregator effect deps; in `refreshQuote` bump the
  nonce instead of mutating the ref. Treat "fresh" as `quoteFetchedAt > 0` AND a quote actually landed —
  don't zero `quoteFetchedAt` on refresh (leave the old stamp until new data lands, so the stale gate stays
  honest until the refetch settles).
- **files:** `src/hooks/useSwapQuote.ts:219-251,432-446`
- **test:** RTL: call `refreshQuote()`, assert `getAggregatorPrice` is invoked again (spy) and `isQuoteStale`
  does not flip to false until the new quote resolves.
- **deps:** []

### F193 — On-chain quote reads fire per keystroke (no debounce) and never auto-refresh → first Swap after 30s idle always bounces
- **verdict:** fix-now · **rootCause:** T8 · **severity:** medium · **effort:** M · **risk:** med
- **approach:** Confirmed: `getAmountsOut` reads (`useSwapQuote.ts:88-95,115-122`) re-query on every
  `parsedAmount` change with no debounce (only the aggregator leg debounces, 800ms at line 229), and they
  carry no `refetchInterval` (only the reserves reads at 166/182/198 refresh every 30s), so after >30s the
  `QUOTE_MAX_AGE_MS` gate forces the "Quote is stale — refreshing now" bounce on the first click. Fix: (1)
  debounce `parsedAmount` (~300-400ms) before it reaches the read hooks — introduce a `useDebouncedValue`
  derived from `inputAmount`/`parsedAmount` in `useSwap` and pass the debounced bigint into `useSwapQuote`;
  (2) add `refetchInterval: 12_000` to the two `getAmountsOut` reads so a visible quote is always executable.
  Both reduce the prod rate-limiter risk (T8). Optionally add a small refresh control (ties to F246).
- **files:** `src/hooks/useSwap.ts:188-199`, `src/hooks/useSwapQuote.ts:88-95,115-122`
- **test:** RTL with fake timers: type three characters within 300ms, assert only one read query key is
  created. Wait 12s, assert the read refetches. Manual: idle 35s on a live quote, click Swap — no stale
  bounce.
- **deps:** []

### F206 — Return memoization defeated by unmemoized `path`/`routeDescription` arrays
- **verdict:** fix-now · **rootCause:** standalone · **severity:** low · **effort:** S · **risk:** low
- **approach:** Confirmed: `useSwapQuote.ts:75` builds a fresh `path` array every render; `path` is in the
  return `useMemo` deps (496) and priceImpact deps (391), so the R042 HIGH-2 memo wrapper (463-465) flips
  identity every render (worse under the 1s ticker). Wrap `path` in `useMemo` keyed on
  `[fromToken?.address, toToken?.address]`; `routeDescription` then stabilizes via its existing memo. Cheap
  win that makes the existing wrapper effective and compounds the F187 fix.
- **files:** `src/hooks/useSwapQuote.ts:75`
- **test:** RTL: render twice with identical tokens, assert the returned object identity is stable across an
  unrelated state change (e.g. the 1s tick).
- **deps:** []

---

## Batch: `slippage-input-ux` — fix the custom slippage field + persist settings (F190, F194, F199)

### F190 — Custom slippage input unusable for fractional values (re-formats with toFixed(2) every keystroke)
- **verdict:** fix-now · **rootCause:** standalone · **severity:** medium · **effort:** S · **risk:** low
- **approach:** Confirmed: `TradePage.tsx:314` binds `value={isPreset ? '' : swap.slippage.toFixed(2)}` and
  onChange (317-325) parses+clamps each keystroke, so typing `0.3` round-trips to `0.00`. Use the same
  pattern DCATab already uses for its custom input (`DCATab.tsx:153-171`): keep a local string state for the
  field, commit the parsed/clamped number on a valid parse or on blur, and only sync the string from
  `swap.slippage` when the field is **not** focused. Keep the preset highlighting logic.
- **files:** `src/pages/TradePage.tsx:298-331`
- **test:** RTL: focus the custom field, type `0`,`.`,`3`; assert the field shows `0.3` (not `0.00`) and
  `swap.slippage===0.3` after blur. Manual on iPhone width.
- **deps:** []

### F194 — Slippage + deadline not persisted; deadline has state but no UI
- **verdict:** product-decision · **rootCause:** standalone · **severity:** medium · **effort:** M · **risk:** low
- **approach:** Confirmed: `useSwap.ts:80-86` are plain state; `setDeadline` is returned (line 532) but no
  component calls it (dead). Two parts: (a) persist `slippageRaw` (and the FoT toggle) per-wallet in
  localStorage, mirroring the recent-tokens pattern (`TokenSelectModal.tsx:33-49`) — read on init, write on
  change. (b) The deadline needs an **owner choice**: either render a deadline control in the settings
  cluster (ties to F248 — same control) or remove the dead `deadline`/`setDeadline` state. Recommend
  rendering it (Uniswap exposes it) so the existing 5-min default becomes user-tunable. Additive.
- **files:** `src/hooks/useSwap.ts:80-86,531-532`, `src/pages/TradePage.tsx` (settings cluster ~279-369)
- **test:** persist: set slippage 0.3%, reload, assert it rehydrates. deadline: render the control, set 20m,
  assert it flows into `deadlineTs` in `executeSwap`.
- **deps:** []

### F199 — User's slippage not forwarded to aggregator quote requests
- **verdict:** fix-now · **rootCause:** standalone · **severity:** low · **effort:** S · **risk:** low
- **approach:** Confirmed: `useSwapQuote.ts:233` passes `undefined` for the slippage arg so every aggregator
  quote uses `DEFAULT_MAX_SLIPPAGE_PCT` (0.5%, `aggregator.ts:19`) even though the hook receives `slippage`.
  Pass `slippage` through (the downstream `clampSlippage` already bounds it). If uniform 0.5% ranking is the
  deliberate intent (it keeps cross-venue ranking apples-to-apples — see the R045 M1 comment), then instead
  document that and drop the unused param; recommend forwarding since venues that consume slippage at quote
  time (SwapAPI/Odos/LiFi) should reflect the user's tolerance.
- **files:** `src/hooks/useSwapQuote.ts:233`
- **test:** spy on `getAggregatorPrice`, set slippage 2%, assert the call receives `2` not `undefined`.
- **deps:** []

---

## Batch: `agg-native-address` — Odos native-token convention (F192)

### F192 — Odos native-ETH legs use the 0xEeee sentinel where Odos expects the zero address
- **verdict:** fix-now · **rootCause:** standalone · **severity:** medium · **effort:** S · **risk:** low
- **approach:** Confirmed: `aggregator.ts:38` `case 'zero': return '0xEeee...EEeE'` is byte-identical to the
  `'native'` case (line 36), contradicting the style name; `getOdosQuote` (116-117) is the only `'zero'`
  caller. Change the `'zero'` branch to return
  `'0x0000000000000000000000000000000000000000'`. Add a unit test pinning each aggregator's native-address
  convention. (Live confirmation was 429-rate-limited per the finding — verify with one live Odos ETH→TOWELI
  quote after the change.)
- **files:** `src/lib/aggregator.ts:38`
- **test:** unit: `normalizeTokenAddress('ETH','zero')` === zero address. Integration: one live Odos quote for
  ETH→TOWELI returns a non-null `outAmounts[0]`.
- **deps:** []

---

## Batch: `price-impact-venue` — compute impact from the executing route (F197)

### F197 — Price impact can show positive % when the aggregator quote beats the pool mid-price
- **verdict:** fix-now · **rootCause:** standalone · **severity:** low · **effort:** S · **risk:** low
- **approach:** Confirmed: the single-hop branch (`useSwapQuote.ts:381-387`) computes
  `execPriceScaled` from `outputAmount` (the headline, possibly-aggregator output, line 319) against Uniswap
  reserves — venue-inconsistent, and a favorable aggregator price yields a positive "impact". Compute impact
  from the **executing on-chain route's own** output (`activeAmountsOut[last]`) instead of `outputAmount`, and
  clamp favorable diffs to 0 (or show green like Uniswap). Pairs naturally with F189 (once the headline is the
  executing venue, the inconsistency largely disappears anyway).
- **files:** `src/hooks/useSwapQuote.ts:334-391`
- **test:** unit: feed an aggregator output above mid-price; assert reported impact is 0 (not positive), and
  that impact derives from `activeAmountsOut`.
- **deps:** []

---

## Batch: `chain-gating` — pin reads to CHAIN_ID + refuse wrong-chain imports (F198, F201)

### F198 — addCustomToken skips on-chain verification on the wrong chain but still stores into the mainnet-scoped list
- **verdict:** fix-now · **rootCause:** T9 · **severity:** low · **effort:** S · **risk:** low
- **approach:** Confirmed: `useSwap.ts:506-515` only verifies when `chainId === CHAIN_ID`, then falls through
  to `setCustomTokens` (516) persisting into the mainnet-scoped key; and the modal's import reads
  (`TokenSelectModal.tsx:169-181`) have no `chainId` pin so symbol/decimals can come from another chain. Fix:
  refuse import when `chainId !== CHAIN_ID` (`toast.error('Switch to mainnet to import tokens')` and return
  before `setCustomTokens`), and pin the modal's two `useReadContract` import reads with `chainId: CHAIN_ID`.
- **files:** `src/hooks/useSwap.ts:506-519`, `src/components/swap/TokenSelectModal.tsx:169-181`
- **test:** simulate wrong chain, attempt import, assert no localStorage write + error toast. Assert the
  modal reads carry `chainId: CHAIN_ID`.
- **deps:** []

### F201 — useAddLiquidity reads not chain-gated → wrong-network users see "No pool exists… plant one" + zero balances
- **verdict:** fix-now · **rootCause:** T9 · **severity:** low · **effort:** S · **risk:** low
- **approach:** Confirmed: `useAddLiquidity.ts:42-48` (getPair) and 54-71 (the 9-read batch) have no
  `chainId` pin / `onRightChain` gate, unlike `useSwapQuote` which gates every read. Add `chainId: CHAIN_ID`
  to the `getPair` read and the `useReadContracts` batch (or gate `enabled` on `chainId === CHAIN_ID`), and
  show a "switch network" banner in LiquidityTab like the swap card's gate (additive). Writes are already
  guarded by `_ensureChain` (169-172); this fixes the misleading read-side state.
- **files:** `src/hooks/useAddLiquidity.ts:42-48,54-71`, `src/components/swap/LiquidityTab.tsx:501-504`
- **test:** simulate L2 chainId, assert `pairExists` stays gated/false-safe and a "switch network" banner
  renders instead of "No pool exists… plant one".
- **deps:** []

---

## Batch: `custom-token-store-unify` — one chain-scoped, verified store (F202)

### F202 — Two separate custom-token stores (swap vs liquidity); the liquidity store skips on-chain verification
- **verdict:** fix-now · **rootCause:** standalone · **severity:** low · **effort:** M · **risk:** med
- **approach:** Confirmed: `useSwap.ts:94` uses `tegridy_custom_tokens_v2_${CHAIN_ID}` with FE-HIGH-6
  on-chain re-verification; `LiquidityTab.tsx:23` uses `tegridy_liquidity_custom_tokens` (no chain scope,
  shape-only validation 41-53, no on-chain symbol/decimals check). Unify on the swap store: have
  `LiquidityTab` consume `useSwap`'s `customTokens` + `addCustomToken` (or hoist the swap store into a tiny
  shared `useCustomTokens` hook) so the anti-spoof + chain-scope guarantees hold on both surfaces and tokens
  imported in one appear in the other. **Med risk** — both surfaces read/write; verify the FE-HIGH-6
  rehydrate sweep still runs once. Don't remove the liquidity migration path: on first load, fold any legacy
  `tegridy_liquidity_custom_tokens` entries into the unified store (then they get verified).
- **files:** `src/components/swap/LiquidityTab.tsx:23-89,223-230`, new `src/hooks/useCustomTokens.ts` (or
  thread `useSwap` outputs)
- **test:** import a token in Swap, switch to Liquidity, assert it appears in the picker; assert the
  liquidity import now refuses an on-chain-mismatched token.
- **deps:** []

---

## Batch: `cow-approval` — exact-amount CoW approval (F203)

### F203 — CoW path auto-approves unlimited (maxUint256) without the warning the swap surface mandates
- **verdict:** fix-now · **rootCause:** standalone · **severity:** low · **effort:** S · **risk:** low
- **approach:** Confirmed: `useCowLimitOrder.ts:147-153` approves `[COW_VAULT_RELAYER_ADDRESS, maxUint256]`
  preceded only by an info toast, while the swap surface treats unlimited approval as opt-in with an explicit
  warning and blocks it for custom tokens (`useSwapAllowance.ts:185-193`). Approve the **exact** `sellAmount`
  by default; if keeping a "approve once for all future CoW orders" path, gate it behind an opt-in toggle and
  reuse the existing unlimited-approval warning copy. Vault-relayer unlimited is CoW's standard pattern, so
  this is a consistency/UX fix, not a security bug — keep it small.
- **files:** `src/hooks/useCowLimitOrder.ts:145-155`
- **test:** place a CoW order from a fresh token; assert the approve amount equals `sellAmount` by default.
- **deps:** []

---

## Batch: `mev-persist` — persist the MEV "added" bit (F204)

### F204 — MEV protection status not persisted — shows "Add to wallet" every session
- **verdict:** fix-now · **rootCause:** standalone · **severity:** low · **effort:** S · **risk:** low
- **approach:** Confirmed: `useMevProtection.ts:34` is plain `useState`; nothing persists `'added'`. Persist
  an `added` flag per wallet address in localStorage (init state from it); render "Added ✓ — select the MEV
  Blocker network in your wallet" as the steady state with a small "re-add" link. Detecting the live RPC is
  impossible, but the local "user completed setup" bit is persistable.
- **files:** `src/hooks/useMevProtection.ts:32-71`, `src/components/swap/MevProtectionPanel.tsx`
- **test:** call `enable()` → success → reload → assert status hydrates to `'added'`.
- **deps:** []

---

## Batch: `swap-a11y` — tabs + live regions (F205)

### F205 — Tab bar mixes role=tab/aria-selected with aria-pressed; no arrow-key nav; quote updates have no aria-live
- **verdict:** fix-now · **rootCause:** T10 · **severity:** low · **effort:** M · **risk:** low
- **approach:** Confirmed: `TradePage.tsx:151-154` each tab has both `aria-selected` and `aria-pressed` under
  `role="tab"` (aria-pressed is invalid on tabs) with no roving tabindex / arrow-key handler, and the "You
  Receive" value (265-267) + route panel have no `aria-live`. Drop `aria-pressed` on the tabs; add
  ArrowLeft/ArrowRight roving focus over the tablist (WAI-ARIA tabs pattern) with `tabIndex` management; add
  `aria-live="polite"` to the receive amount and the route summary container. The token modal is already
  fully wired, so reuse its conventions.
- **files:** `src/pages/TradePage.tsx:141-164,250-267,378-454`
- **test:** axe/RTL: no aria-pressed on `role=tab`; ArrowRight moves focus across tabs; assert `aria-live`
  present on the receive value.
- **deps:** []

---

## Batch: `formatting-polish` — grouping, skeleton, floor-aware balances (F207)

### F207 — Big TOWELI numbers lack thousands separators; quote loading is a bare "..."; tiny balances show 0.0000
- **verdict:** fix-now · **rootCause:** T6/T11 · **severity:** polish · **effort:** M · **risk:** low
- **approach:** Confirmed: `formatTokenAmount` (`formatting.ts:23-30`) returns `toFixed(4)` so 75M renders
  `75000000.0000`; `TradePage.tsx:266` shows the literal `'...'` while loading; balances use
  `Number(x).toFixed(4)` (206/251) so 0.00004 → `0.0000`. Three small fixes sharing the formatter: (1) add
  `toLocaleString('en-US')` grouping in `formatTokenAmount` for values ≥1 (or compact `75.0M` with a
  full-precision `title` tooltip — keep the existing low-value scientific branch); (2) replace the `'...'`
  receive placeholder with a small skeleton shimmer; (3) add floor-aware balance formatting that shows
  `<0.0001` instead of `0.0000`. Note `formatNumber` (line 19) already does grouping — reuse its style.
- **files:** `src/lib/formatting.ts:23-30`, `src/pages/TradePage.tsx:206,251,266`
- **test:** unit: `formatTokenAmount(75000000)` contains a comma/compact form; `formatTokenAmount` for a
  tiny value shows `<0.0001`-style. Visual: receive field shows a shimmer while `isQuoteLoading`.
- **deps:** []

---

## Batch: `pricechart-proxy` — honest proxy comment + CSS hover (F208)

### F208 — PriceChart comment claims a same-origin proxy but fetches GeckoTerminal cross-origin; flip button hover is JS-only
- **verdict:** fix-now · **rootCause:** standalone · **severity:** polish · **effort:** S · **risk:** low
- **approach:** Confirmed: `PriceChart.tsx:46-47` — the "use same-origin proxy" comment sits directly above a
  direct `https://api.geckoterminal.com/...` fetch. Two options: route OHLCV through a `geckoterminal` entry
  in the existing `api/aggregator/[provider]/[...path].js` catchall (no extra Vercel function slot — it joins
  the existing rewrites in `vercel.json`) and add the rewrite, OR just fix the misleading comment. Recommend
  the proxy route (it actually solves the Safari/Edge ITP fallback the comment cites). Separately, the flip
  button rotation in `TradePage.tsx:240-241` is `onMouseEnter`/`onMouseLeave` inline style — move it to a CSS
  `:hover`/`:focus-visible` rule so keyboard focus gets the same affordance (T10-adjacent).
- **files:** `src/components/chart/PriceChart.tsx:46-49`, `frontend/vercel.json` (rewrite, if proxying),
  `frontend/api/aggregator/[provider]/[...path].js` (allow `geckoterminal`), `src/pages/TradePage.tsx:240-241`
- **test:** on an ITP browser, the chart loads without falling back to the iframe; keyboard-focus the flip
  button shows the rotate affordance.
- **deps:** []

---

## Batch: `limit-market-context` — live price reference in the alert/CoW flow (F209, F222)

**Summary.** Same fix serves both findings: surface the live rate (one `getAmountsOut` for 1 ETH — the
limit-order poller already fetches it) above the target-price input with a "use market" chip and ±% quick
buttons; reuse the helper for the CoW builder. F222 is the "missing feature" framing of F209's evidence.

### F209 — Target-price field gives no market context (placeholder 25000000 is ~3x off market)
- **verdict:** fix-now · **rootCause:** standalone · **severity:** polish · **effort:** M · **risk:** low
- **approach:** Confirmed: `LimitOrderTab.tsx:129-133` placeholder `25000000` with no current-price display;
  the keeper fires on `currentPrice >= targetPrice` (`useLimitOrders.ts:497`) so a stale-low target triggers
  instantly. Show a live "1 ETH ≈ X TOWELI" rate above the input (one `getAmountsOut` read, or reuse the
  poller's value via a small returned field from `useLimitOrders`), a "use market" chip that fills the
  target, and ±1/5/10% quick buttons. Update the placeholder to the live order of magnitude. Additive.
- **files:** `src/components/swap/LimitOrderTab.tsx:126-134`, `src/hooks/useLimitOrders.ts` (expose a current
  market rate)
- **test:** render with a mocked rate; assert the rate line shows and "use market" fills the target field.
- **deps:** []

### F222 — Current-market-price reference + "use market" helper + "% from market" indicator (missing)
- **verdict:** duplicate · **rootCause:** standalone · **severity:** low · **effort:** M · **risk:** low
- **approach:** Duplicate of F209 — same control. Add the "% from market" indicator next to the entered
  target as part of the same component change.
- **files:** `src/components/swap/LimitOrderTab.tsx:126-134`
- **test:** covered by F209; additionally assert the "% from market" badge updates as the target changes.
- **deps:** [F209]

---

## Batch: `input-clamp` — enforce the Max cap on typed values (F231)

### F231 — "Max: 100 ETH" not enforced — 200 ETH accepted and summarized
- **verdict:** fix-now · **rootCause:** standalone · **severity:** medium · **effort:** S · **risk:** low
- **approach:** Confirmed: `DCATab.handleAmountChange` (38-43) and `LimitOrderTab.handleAmountChange` (39-44)
  only block negatives; the HTML `max=100` constrains only spinner arrows, so `200` is accepted and the DCA
  summary computes "Total cost 6000 ETH". Clamp in `onChange` (or on blur, matching the swap tab's custom
  slippage which already does `Math.max/Math.min`) to `MAX_AMOUNT_ETH`, and show an inline error when the
  typed amount exceeds the cap or the wallet balance. `createSchedule`/`createOrder` already reject
  out-of-range as a backstop — this is the UI-side guard.
- **files:** `src/components/swap/DCATab.tsx:38-43`, `src/components/swap/LimitOrderTab.tsx:39-44`
- **test:** type `200` into the DCA amount; assert it clamps to 100 (or shows an inline error and the summary
  doesn't compute 6000).
- **deps:** []

---

## Batch: `dca-alert-controls` — labeled custom slippage + tap-friendly tooltip (F241)

### F241 — DCA/Alerts custom slippage is an unlabeled bare field; ranges differ per tab; native title tooltips
- **verdict:** fix-now · **rootCause:** T10 · **severity:** polish · **effort:** M · **risk:** low
- **approach:** Confirmed: `DCATab.tsx:153-171` is a borderless `0.5` input with the label/`%` suffix split
  off, and the help is a native `title` attr (132-133, 1-2s hover, unusable on touch — violates the
  responsive mandate); range is 0.1-3% vs the swap tab's 0-20%. Reuse the swap tab's labeled "Custom %"
  control treatment on DCA/Alerts (consistent affordance) and replace the `title`-attr tooltip with the
  app's tap-friendly tooltip component. Keep the DCA-specific [0.1-3%] clamp (it's an intentional tighter
  bound for unattended swaps).
- **files:** `src/components/swap/DCATab.tsx:128-172`, `src/components/swap/LimitOrderTab.tsx` (if a slippage
  control is added there)
- **test:** touch/iPad: tap the `?` shows the tooltip; the custom field has a visible label + `%` suffix.
- **deps:** []

---

## Batch: `tab-naming` — canonical ?tab=alerts (F242)

### F242 — Feature named three ways: "Alerts" tab, "Price Alert" heading, ?tab=limit URL
- **verdict:** fix-now · **rootCause:** standalone · **severity:** polish · **effort:** S · **risk:** low
- **approach:** Confirmed: `TradePage.tsx` tab label "Alerts" (line 33) → h1 "Price Alert" (65) → URL param
  `limit`. Accept `tab=alerts` as the canonical param while keeping `limit` as a legacy synonym: add
  `'alerts'` to `VALID_TABS`/`tabFromQuery`/`resolveInitialTab` mapping to the same view, and write
  `?tab=alerts` in `handleTabChange`. Keep `?tab=limit` resolving to the same tab for old links. Low-risk
  routing-only change.
- **files:** `src/pages/TradePage.tsx:19-51,80-90`
- **test:** navigate to `?tab=limit` and `?tab=alerts` — both open the Price Alert tab; switching to it writes
  `?tab=alerts`.
- **deps:** []

---

## Batch: `redeploy-prod` — ship HEAD (F224)

### F224 — Aggregator proxy function missing from prod deploy — all 7 quote sources silently dead
- **verdict:** redeploy-only · **rootCause:** T1 · **severity:** critical · **effort:** S · **risk:** low
- **approach:** Verified at HEAD: `api/aggregator/[provider]/[...path].js` exists and `vercel.json` carries
  the 7 rewrites (`/api/{odos,cow,lifi,kyber,openocean,paraswap,swapapi}/:path* → /api/aggregator/...`) — so
  prod is a **stale deploy** missing the catchall. **Operator action:** redeploy prod from HEAD (repo root,
  per the deploy procedure) and verify `/api/aggregator/paraswap/prices` returns JSON. As a code follow-up
  (small, additive), add a one-line telemetry/health signal when 0 aggregators respond
  (`aggregator.ts` meta-result) so this silent-regression class is visible next time — that piece is
  `fix-now`, but the finding itself is redeploy-only.
- **files:** (deploy) none; (optional telemetry) `src/lib/aggregator.ts:386-391`
- **test:** post-redeploy `curl https://tegridyfarms.vercel.app/api/aggregator/paraswap/prices?...` returns
  JSON (not index.html); a live ETH→TOWELI quote populates the comparison panel.
- **deps:** []

---

## Batch: `token-modal-visibility` — fix the invisible modal animation (F225)

### F225 — Token selector modal never becomes visible (animate target omits opacity)
- **verdict:** fix-now · **rootCause:** T2 · **severity:** critical · **effort:** M · **risk:** med
- **approach:** Confirmed code bug: `TokenSelectModal.tsx:261-264` inner `m.div` has
  `initial={{ scale: 0.95, opacity: 0 }}` but `animate={{ scale: 1 }}` — **opacity is omitted from the
  animate target**, so even when the entrance runs the card stays `opacity:0`. Add `opacity: 1` to the
  `animate` target (and keep `exit={{ scale: 0.95, opacity: 0 }}`). The live report also saw the outer
  container stuck at `opacity:0`, pointing at the LazyMotion `domAnimation` feature-load vs late-mounted
  `m`-component timing (T2) — verify the entrance actually settles under our `LazyMotion` setup; if the
  subtree's animations don't start, ensure the modal mounts inside a provider that has `domAnimation`
  features loaded, or fall back to a CSS settle (opacity transition) so a never-running tween can't latch the
  card invisible. **Med risk** — this gates all token selection; verify on desktop + iPhone width.
- **files:** `src/components/swap/TokenSelectModal.tsx:253-264`
- **test:** extend `e2e/trade-page.spec.ts` with a connected fixture: open the token modal and assert the
  dialog card is **visible** (computed `opacity` ≈ 1 / `toBeVisible`), not merely present in the DOM.
- **deps:** []

---

## Batch: `logged-out-reads` — show public read-only data before connect (F228, F220, F221)

**Summary.** The single biggest conversion/trust gap: the swap form, quotes, pool data, and prices are all
hidden behind the connect wall, but the on-chain reads need no wallet (only the aggregator leg uses an
address, and it already supports a placeholder sender). Render the form disconnected with quotes + reserves
from public RPC; gate only the **action** (Approve/Swap/Add). F220/F221 are the missing-feature framings.

### F228 — Everything gated behind wallet connect (no quotes, tokens, prices, pool data logged out)
- **verdict:** product-decision · **rootCause:** T7 · **severity:** high · **effort:** L · **risk:** med
- **approach:** Confirmed intentional at HEAD: `TradePage.tsx:173` `!isConnected ?` swaps the whole form for
  the connect CTA, LiquidityTab gates similarly (`LiquidityTab.tsx:297-301`), and `e2e/trade-page.spec.ts:31`
  asserts the gate. This is a deliberate product stance, so flipping it needs an **owner decision**. Proposed
  (additive, no art removed): render the full swap form disconnected — on-chain quotes run via the public RPC
  reads that already exist (`useSwapQuote` gates on chain, not on address), show balances as "—", default the
  aggregator sender to the zero/placeholder address (the aggregator code already tolerates zero-address
  senders for price-only endpoints), and swap the action button to a "Connect Wallet" CTA. Same for
  Liquidity: show reserves/pool composition from public RPC. Update the e2e gate test to assert the form +
  quote are visible disconnected and only the action requires connect.
- **files:** `src/pages/TradePage.tsx:167-481`, `src/components/swap/LiquidityTab.tsx:297-301`,
  `src/hooks/useSwapQuote.ts:219-251` (allow placeholder sender for the agg leg), `e2e/trade-page.spec.ts:24-32`
- **test:** disconnected `/swap`: type 1 ETH, assert a quote renders and the CTA reads "Connect Wallet";
  on-chain reads fire, no aggregator call leaks a real address.
- **deps:** [F189, F226]

### F220 — Quote-while-disconnected (missing)
- **verdict:** duplicate · **rootCause:** T7 · **severity:** low · **effort:** L · **risk:** med
- **approach:** Duplicate of F228 (the swap half). Delivered by the F228 change.
- **files:** `src/pages/TradePage.tsx:167-481`
- **test:** covered by F228.
- **deps:** [F228]

### F221 — Pool stats on the Liquidity tab: TVL, 24h volume/fees, fee APR, USD position value (missing)
- **verdict:** product-decision · **rootCause:** standalone · **severity:** low · **effort:** L · **risk:** low
- **approach:** Confirmed gap: LiquidityTab shows user share/LP/underlying but no pool-level
  reserves/TVL/volume/fee-APR (and no pool list). Reserves + TVL are computable on-chain today
  (`useAddLiquidity` already reads `reserveA/reserveB/lpTotalSupply`); 24h volume/fee-APR need the indexer/
  Dune feed (operator-gated). **Owner decision** on scope/data source: ship reserves + TVL + USD position
  value now (on-chain + the existing `useToweliPrice` feed), defer volume/APR to the indexer. Additive
  position-card section. Same as F245.
- **files:** `src/components/swap/LiquidityTab.tsx:346-364`, `src/hooks/useAddLiquidity.ts` (expose
  reserves/TVL), `src/hooks/useToweliPrice.ts`
- **test:** connected, assert a pool-stats card renders reserves + TVL + USD position value.
- **deps:** [F245]

---

## Batch: `usd-and-rate-rows` — fiat, exchange rate, gas in the quote panel (F210, F243, F214, F215, F246)

**Summary.** One panel addition covers several "missing" findings: a rate line ("1 ETH = X TOWELI" with
invert), USD values under each amount (the `useToweliPrice` hook + the Chainlink ETH/USD feed already exist —
they power the status pill), a gas-estimate row (`AggregatorQuote.estimatedGas` is already collected but
never shown), and a small freshness/refresh affordance (the staleness machinery already exists). Build as one
additive sub-panel under "You Receive".

### F243 — No exchange rate, no USD values, no gas estimate in the quote panel
- **verdict:** fix-now · **rootCause:** standalone · **severity:** medium · **effort:** M · **risk:** low
- **approach:** Confirmed: route panel shows only Route/Savings/Impact/Min. Received. Add (a) a rate line
  derived from the active quote (`outputAmount/parsedAmount`), (b) USD equivalents via the existing
  `useToweliPrice` + ETH/USD feed (same source as the status pill), (c) a fee row from the quote's
  `estimatedGas × gas price`, USD-converted. Additive rows in the existing route panel; no art touched.
- **files:** `src/pages/TradePage.tsx:378-454`, `src/hooks/useToweliPrice.ts`, `src/hooks/useSwapQuote.ts`
  (expose `estimatedGas` from the selected agg quote)
- **test:** with a live quote, assert the rate line, both USD figures, and a gas row render with finite
  values.
- **deps:** [F226]

### F210 — USD value estimates under both amount fields and on Min Received (missing)
- **verdict:** duplicate · **rootCause:** standalone · **severity:** low · **effort:** M · **risk:** low
- **approach:** The USD half of F243 — same `useToweliPrice`/ETH-USD plumbing; place fiat under You Pay / You
  Receive / Min. Received.
- **files:** `src/pages/TradePage.tsx:203-269,396-401`
- **test:** covered by F243.
- **deps:** [F243]

### F214 — Exchange-rate row with invert toggle + auto-refresh countdown (missing)
- **verdict:** duplicate · **rootCause:** standalone · **severity:** low · **effort:** M · **risk:** low
- **approach:** The rate-line half of F243 plus an invert toggle (1 ETH = X TOWELI ↔ 1M TOWELI = Y ETH) and
  the countdown from F246. One control.
- **files:** `src/pages/TradePage.tsx:378-454`
- **test:** toggle invert flips the rate display; covered otherwise by F243/F246.
- **deps:** [F243, F246]

### F215 — Gas estimate display (already fetched, never shown) (missing)
- **verdict:** duplicate · **rootCause:** standalone · **severity:** low · **effort:** S · **risk:** low
- **approach:** The gas half of F243 — surface `AggregatorQuote.estimatedGas` (already collected in
  `aggregator.ts`) × gas price in the new fee row.
- **files:** `src/pages/TradePage.tsx:378-454`, `src/hooks/useSwapQuote.ts`
- **test:** covered by F243.
- **deps:** [F243]

### F246 — No quote auto-refresh indicator despite 30s staleness machinery (missing)
- **verdict:** fix-now · **rootCause:** T11 · **severity:** low · **effort:** S · **risk:** low
- **approach:** Confirmed: `useSwapQuote` exposes `quoteFetchedAt` / `isQuoteStale` / `refreshQuote` but the
  UI surfaces none of it. Add a small "updated Xs ago" / circular countdown next to the rate line wired to
  `refreshQuote` (which F191 makes actually work). Additive.
- **files:** `src/pages/TradePage.tsx:378-454`
- **test:** render with a stamped quote; assert the "updated Xs ago" text increments and a refresh control
  calls `refreshQuote`.
- **deps:** [F191]

---

## Batch: `quick-amount-buttons` — Max / 25-50-75% (F211)

### F211 — Max / 25-50-75% balance buttons on swap + liquidity inputs (with ETH gas-reserve) (missing)
- **verdict:** fix-now · **rootCause:** standalone · **severity:** low · **effort:** M · **risk:** low
- **approach:** Confirmed missing on the swap "You Pay" input (the liquidity remove side already has 25/50/75/
  100 percent chips at `LiquidityTab.tsx:454-466` — reuse that pattern). Add Max/25/50/75% chips that set
  `inputAmount` from `fromBalance`, reserving a small gas buffer when the input token is native ETH (e.g.
  leave ~0.002 ETH). Mirror onto the liquidity Add inputs.
- **files:** `src/pages/TradePage.tsx:203-227`, `src/components/swap/LiquidityTab.tsx:304-344`
- **test:** click Max with a native-ETH from-token; assert the amount = balance minus the gas reserve;
  click 50% with an ERC20; assert exactly half.
- **deps:** []

---

## Batch: `wrap-unwrap` — ETH↔WETH mode (F195, F217)

### F195 — ETH→WETH wrap is a dead flow (0 quote, execution rejects as self-swap)
- **verdict:** fix-now · **rootCause:** standalone · **severity:** medium · **effort:** M · **risk:** low
- **approach:** Confirmed: `buildPath` (`useSwapQuote.ts:25-36`) maps ETH→WETH to `[WETH, WETH]` →
  `getAmountsOut` reverts → output stays `0.0`; `executeSwap`'s self-swap guard (`useSwap.ts:355-360`) would
  fire "Cannot swap a token for itself"; and the token modal only disables the literal other address so the
  pair is selectable. Add a wrap/unwrap branch: when the pair is ETH↔WETH, detect it before the normal path
  and issue a single `WETH.deposit{value}` / `WETH.withdraw(amount)` `writeContract` (no router, no slippage,
  no approval) — Uniswap's wrap mode. Show "Wrap"/"Unwrap" as the action label. Additive; at minimum, if the
  branch is descoped, show copy explaining wrap isn't supported instead of a silent dead form.
- **files:** `src/hooks/useSwap.ts:337-486`, `src/hooks/useSwapQuote.ts:25-36`, `src/pages/TradePage.tsx:466-473`
- **test:** select ETH→WETH, enter 1, assert the action reads "Wrap" and dispatches `deposit` with
  `value=1e18`; WETH→ETH dispatches `withdraw`.
- **deps:** []

### F217 — ETH↔WETH wrap/unwrap mode + one-tap "wrap ETH" in the CoW path (missing)
- **verdict:** duplicate · **rootCause:** standalone · **severity:** low · **effort:** M · **risk:** low
- **approach:** Duplicate of F195 for the wrap mode; additionally add a one-tap "Wrap ETH" helper in the CoW
  limit flow where `LimitOrderTab.tsx:176` tells users to "wrap your ETH first" with no in-app way to do it —
  reuse the F195 wrap action.
- **files:** `src/components/swap/LimitOrderTab.tsx:172-186`
- **test:** in the CoW path, a "Wrap ETH" button issues `WETH.deposit`.
- **deps:** [F195]

---

## Batch: `feeBps-onchain` — read SwapFeeRouter.feeBps (F200)

### F200 — SWAP_FEE_BPS hardcoded — fee display + route comparison silently wrong if owner retunes feeBps
- **verdict:** fix-now · **rootCause:** T3 · **severity:** low · **effort:** S · **risk:** low
- **approach:** Confirmed: `constants.ts:108` `SWAP_FEE_BPS = 50` with a comment to read on-chain if retuned;
  `useSwapQuote.ts:274-276` nets the native quote with it and discloses "(incl. 0.5% fee)" (426). Read
  `SwapFeeRouter.feeBps()` once via `useReadContract` (single cacheable view call, `chainId: CHAIN_ID`) and
  fall back to the constant on failure; feed the live value into `SWAP_FEE_BPS_BI` netting + the disclosure.
- **files:** `src/hooks/useSwapQuote.ts:17,274-276,422-429`, `src/lib/constants.ts:104-108` (keep as fallback)
- **test:** mock `feeBps()` returning 80; assert the net quote + the "(incl. 0.8% fee)" label both reflect it.
- **deps:** []

---

## Batch: `simulation-step` — pre-trade confirmation (F213)

### F213 — Pre-trade confirmation/simulation step (rate, route diagram, fee breakdown, gas, typed-confirm for extreme impact)
- **verdict:** product-decision · **rootCause:** standalone · **severity:** low · **effort:** L · **risk:** med
- **approach:** Confirmed missing; today there's an inline high-impact warning (`TradePage.tsx:402-406`) and a
  Towelie nudge (`TradePage.tsx:114-119`) but no confirmation modal. A full pre-trade simulation/confirm step
  is a meaningful new flow — **owner decision** on scope. Minimal version: a confirm modal showing rate +
  route + protocol-fee-vs-LP-fee breakdown + gas (all available once F243 lands) and a typed-confirm gate
  for impact > 15% (Uniswap's bar). Additive; reuse the F243 data.
- **files:** new `src/components/swap/SwapConfirmModal.tsx`, `src/pages/TradePage.tsx:466-473`
- **test:** trade with >15% impact requires a typed confirm before `executeSwap` fires.
- **deps:** [F243]

---

## Batch: `deep-links` — token-pair URLs (F216)

### F216 — Token-pair deep links (?inputCurrency/&outputCurrency) + last-used-pair persistence (missing)
- **verdict:** fix-now · **rootCause:** standalone · **severity:** low · **effort:** M · **risk:** low
- **approach:** Confirmed only `?tab=` is in the URL today. Read `?inputCurrency`/`?outputCurrency` (symbol or
  address) on mount to seed `fromToken`/`toToken` (resolve against `DEFAULT_TOKENS` + customTokens), and write
  them on change via the existing `setSearchParams`. Persist the last-used pair in localStorage as the
  fallback default. Reuse the `useSearchParams` plumbing already in `TradePage`.
- **files:** `src/pages/TradePage.tsx:56-90`, `src/hooks/useSwap.ts:73-78`
- **test:** load `/swap?inputCurrency=ETH&outputCurrency=USDC`; assert tokens seed accordingly and editing
  updates the URL.
- **deps:** []

---

## Batch: `eip5792-batch` — one-click approve+swap (F218)

### F218 — EIP-5792 one-click approve+swap batching wired into nothing on the trade surface (missing)
- **verdict:** fix-now · **rootCause:** standalone · **severity:** low · **effort:** M · **risk:** med
- **approach:** Confirmed `src/lib/eip5792.ts` exists (the 38ac420 foundation) but isn't used on the trade
  surface, so atomic-batch-capable wallets still get two prompts (Approve then Swap). Wire it into the
  approve→swap path: when the wallet supports `wallet_sendCalls`, batch the `approve` + swap calls; otherwise
  fall back to the current two-step (`useSwapAllowance` + `executeSwap`). **Med risk** — touches the audited
  write path and depends on the spender being correct, so land it **after** F186 fixes spender parity. Keep
  the fallback path untouched.
- **files:** `src/hooks/useSwap.ts:337-486`, `src/hooks/useSwapAllowance.ts`, `src/lib/eip5792.ts`
- **test:** with a batch-capable mock wallet, an ERC20 sell that needs approval issues one `sendCalls`; with a
  non-capable wallet, the two-step path is unchanged.
- **deps:** [F186]

---

## Batch: `tx-history-panel` — recent trades on the trade surface (F219, F247)

### F219 — Recent-trades / transaction-history panel on the trade surface (missing)
- **verdict:** fix-now · **rootCause:** standalone · **severity:** low · **effort:** M · **risk:** low
- **approach:** Confirmed `src/lib/txHistory.ts` exists; today the only record is the success toast +
  explorer link (`TradePage.tsx:475-479`). Add a small "Recent trades" panel fed by `txHistory.ts` (the
  user's own swaps from this session/localStorage), with explorer links. Additive section under the swap card
  (the ultrawide layout has empty space). Record swaps into `txHistory` on confirm in the success effect.
- **files:** `src/pages/TradePage.tsx`, `src/lib/txHistory.ts`, `src/hooks/useSwap.ts:267-283` (record on
  confirm)
- **test:** confirm a swap (mock); assert it appears in the recent-trades panel with an explorer link.
- **deps:** []

### F247 — No recent-trades or pool-activity module (missing)
- **verdict:** duplicate · **rootCause:** standalone · **severity:** low · **effort:** L · **risk:** low
- **approach:** Overlaps F219 (user's own recent trades). The venue-wide "last 5 swaps from logs" piece needs
  the indexer (operator-gated) — defer that half; deliver the user-history half via F219.
- **files:** `src/pages/TradePage.tsx`, `src/lib/txHistory.ts`
- **test:** covered by F219 for user history; venue-wide deferred to indexer.
- **deps:** [F219]

---

## Batch: `pool-stats` — liquidity pool data (F245)

### F245 — Liquidity page has zero pool data (no TVL/reserves/volume/APR; APR claim has no number)
- **verdict:** product-decision · **rootCause:** standalone · **severity:** medium · **effort:** L · **risk:** low
- **approach:** Confirmed: LiquidityTab promises "earn a cut of every swap" (`LiquidityTab.tsx:257`) with no
  quantification; `useAddLiquidity` reads reserves/lpTotalSupply but the UI shows only the user's share/LP.
  Reserves + TVL are computable now (on-chain reserves × `useToweliPrice`/ETH-USD); trailing fee-APR needs the
  indexer/Dune volume feed (operator-gated). **Owner decision** on data source/scope: ship reserves + TVL +
  USD position value immediately, gate volume/fee-APR behind the indexer with an honest "—" until it ships.
  Don't render an APR number the chain/indexer can't back (per the constants.ts:116-128 no-unfunded-numbers
  rule). Additive pool-stats card + a one-row pool list.
- **files:** `src/components/swap/LiquidityTab.tsx:346-364`, `src/hooks/useAddLiquidity.ts:319-359` (expose
  TVL), `src/hooks/useToweliPrice.ts`
- **test:** connected, assert reserves + TVL + USD position render; assert APR shows "—" (not a fabricated
  number) until the indexer feed exists.
- **deps:** []

---

## Batch: `aggregator-execution` — real sell-side execution (F223)

### F223 — Real aggregator/sell-side execution (quotes compared across 7 venues but only on-chain executes)
- **verdict:** product-decision · **rootCause:** standalone · **severity:** low · **effort:** L · **risk:** high
- **approach:** Confirmed: the app ranks 7 venues but only on-chain ones execute (F189 is the display
  symptom). Honestly capturing the displayed aggregator savings means wiring real execution — either build
  endpoints (Odos/Kyber `/build`, ParaSwap `/transactions`) or CoW order placement as a market path
  (`useCowLimitOrder` already exists and could be repurposed). **Owner decision + high risk** (new on-chain
  write path through third-party calldata, needs its own security pass per the minimal-attack-surface
  mandate). Until then, F189 keeps the UI honest. Recommend the CoW market-order path first (lowest new
  attack surface, code already exists).
- **files:** `src/hooks/useSwap.ts:337-486`, `src/hooks/useCowLimitOrder.ts`, `src/lib/aggregator.ts`
- **test:** (gated) an aggregator-best quote can be executed and the user receives ≈ the displayed amount;
  requires a dedicated security review before merge.
- **deps:** [F189]

---

## Live/prod findings owned by other surfaces or operators

### F229 — ~30s unskippable splash + "CLICK TO ENTER" before deep-linked /swap
- **verdict:** product-decision · **rootCause:** T10/standalone · **severity:** high · **effort:** M · **risk:** low
- **approach:** App-wide splash (`src/components/loader/AppLoader.tsx`), not specific to the trade surface —
  belongs to the global/splash surface plan, not g04. Recorded here because it was observed on `/swap`. Owner
  choice: keep the art (mandate: don't remove it) but add a visible "Skip" from second 1, honor a localStorage
  "seen" flag for repeat visitors (keep the existing replay button), and auto-enter deep links instead of
  gating behind CLICK TO ENTER.
- **files:** `src/components/loader/AppLoader.tsx`
- **test:** deep-link `/swap` in a fresh tab; assert a Skip control is present from t≈1s and a returning
  visitor (localStorage flag) bypasses the full sequence.
- **deps:** []

### F230 — Light mode: dark heading text over unchanged dark page art (near invisible)
- **verdict:** fix-now · **rootCause:** standalone · **severity:** medium · **effort:** S · **risk:** low
- **approach:** Confirmed by design: `TradePage.tsx:136-137` the h1/subtitle are `text-white` but the live
  report saw dark ink in light mode — the fixed page art (`#060c1a` + ArtImg) never changes with theme, so any
  light-mode text-color override fails contrast over it. Force the light-on-dark treatment (or the existing
  `textShadow` scrim) for text layered over page art regardless of theme. Likely a theme-token override
  bleeding into these headings — pin them to white + scrim.
- **files:** `src/pages/TradePage.tsx:135-138`, and the LiquidityTab/h1 equivalents
- **test:** toggle light mode on `/liquidity`; assert the h1 remains legible (white + shadow) over the art.
- **deps:** []

### F232 — eth.llamarpc.com down and still first in transport rotation (521/503 every load)
- **verdict:** fix-now · **rootCause:** standalone · **severity:** medium · **effort:** S · **risk:** low
- **approach:** Network/transport config (wagmi `transports` / RPC list), not a trade-surface file per se.
  Reorder transports so a healthy provider (publicnode/ankr) is primary, or add a cached per-session health
  check that demotes a provider after consecutive 5xx. Lives in the wagmi/viem client config
  (`src/lib/wagmi*` or the provider-failover module from commit 6b880bc). Owned by the infra/global surface
  but flagged here since it adds latency to every trade-page load.
- **files:** wagmi client transport config (provider-failover module)
- **test:** load `/swap`; assert the first RPC request goes to a healthy provider, not llamarpc.
- **deps:** []

### F233 — Towelie avatar occludes the "Protocol Active $0.00004132" status pill; pill unlabeled
- **verdict:** fix-now · **rootCause:** standalone · **severity:** medium · **effort:** S · **risk:** low
- **approach:** Global chrome (status pill + Towelie mascot), not a trade-surface file. Offset the pill left of
  the mascot's hover zone and label it "TOWELI $0.00004132" with a tooltip for source/refresh. Owned by the
  global layout surface; flagged here as observed on trade pages.
- **files:** status-pill + Towelie mascot components (global layout)
- **test:** zoom the bottom-right corner; assert the price text isn't clipped and reads "TOWELI $…".
- **deps:** []

### F234 — Background + card art pops in 5-10s late with no placeholder
- **verdict:** fix-now · **rootCause:** T12 · **severity:** medium · **effort:** M · **risk:** low
- **approach:** Confirmed: trade/liquidity pages use `ArtImg` with `loading="lazy"` over a flat `#060c1a`
  background (`TradePage.tsx:130-131,170,497,509`, `LiquidityTab.tsx:236-237`); no LQIP/blur-up/fade. Add a
  low-res blurred placeholder (LQIP) or fade-in transition to `ArtImg` itself (shared component → fixes all
  pages additively), and preload the trade art on route hover/prefetch. Owned by the shared `ArtImg`
  component; one change benefits every surface.
- **files:** `src/components/ArtImg.tsx`, optional route-prefetch in the router
- **test:** throttle network; assert a blur/fade placeholder shows before the art resolves (no flat-color
  flash).
- **deps:** []

### F236 — Towelie nag bubbles re-open every ~15-20s
- **verdict:** fix-now · **rootCause:** standalone · **severity:** low · **effort:** S · **risk:** low
- **approach:** Towelie behavior lives in `useTowelie`/the mascot component (not a trade-surface file). Cap
  proactive bubbles to 1 per page visit; keep the urgent high-price-impact nudge (`TradePage.tsx:114-119`) as
  the exception (it already uses `priority: 'urgent'` + a dedup `key`). Owned by the Towelie/global surface.
- **files:** `src/hooks/useTowelie.ts` (or the mascot's auto-popup scheduler)
- **test:** sit on `/swap` for 3 minutes; assert ≤1 proactive bubble (plus any urgent nudge).
- **deps:** []

### F237 — Towelie chat answer typewriters at ~5 chars/sec with no instant-complete
- **verdict:** fix-now · **rootCause:** standalone · **severity:** polish · **effort:** S · **risk:** low
- **approach:** Towelie chat component (global), not trade-surface. 3-4× the type speed, complete instantly on
  click, and let the bubble grow to show the full answer. Owned by the Towelie surface.
- **files:** Towelie chat component
- **test:** ask a question; assert the answer completes ≤4s and a click finishes it instantly.
- **deps:** []

### F238 — Own-origin HEAD /swap returned 503
- **verdict:** operator-action · **rootCause:** standalone · **severity:** low · **effort:** S · **risk:** low
- **approach:** No HEAD fetch exists in `src` (grep) — originates from a library/extension/unfurler probe. Not
  a code bug on this surface. Operator: `curl -I` the prod URLs; if Vercel's SPA rewrite 503s HEAD on page
  URLs, add a HEAD-friendly response (affects link previews/uptime checks). Verify, then decide.
- **files:** `frontend/vercel.json` (only if the curl confirms a rewrite-level HEAD 503)
- **test:** `curl -I https://tegridyfarms.vercel.app/swap` returns 200/empty-body, not 503.
- **deps:** []

### F239 — First keystroke into DCA amount field swallowed (one-off)
- **verdict:** false-positive · **rootCause:** standalone · **severity:** low · **effort:** S · **risk:** low
- **approach:** Self-described low-confidence flake ("retry worked"); no deterministic cause found in
  `DCATab.tsx` (the input is a controlled `value={amount}` with a plain onChange — nothing swallows the first
  key in code). Likely focus stolen by an auto-appearing Towelie bubble or the late art render (ties to
  F236/F234). Mark not-actionable as a standalone code bug; if it reproduces after F236/F234 land, revisit
  whether the bubble steals focus on mount.
- **files:** `src/components/swap/DCATab.tsx:87-91` (no change planned)
- **test:** after F236/F234, type into the DCA amount field on first focus across 10 loads; assert no dropped
  keystroke.
- **deps:** [F236]

### F240 — Flip-direction button clears the entered amount
- **verdict:** fix-now · **rootCause:** standalone · **severity:** low · **effort:** S · **risk:** low
- **approach:** Confirmed: `useSwap.flipDirection` (`useSwap.ts:488-494`) does `setInputAmount('')` on flip,
  vs Uniswap which transposes the amount. Carry the input across the flip — either keep the same input string,
  or set it to the previously-quoted output so the trade intent is preserved. Minimal change: drop the
  `setInputAmount('')` (keep `reset()` for the tx state).
- **files:** `src/hooks/useSwap.ts:488-494`
- **test:** enter 1 ETH, get a quote, flip; assert the amount carries over (and a fresh quote loads for the
  reversed pair).
- **deps:** []

### F244 — No price chart or market context on the swap page
- **verdict:** fix-now · **rootCause:** standalone · **severity:** medium · **effort:** M · **risk:** low
- **approach:** Confirmed: no chart on `/swap`; `PriceChart` exists (`components/chart/PriceChart.tsx`) and
  only renders on DashboardPage; CSP already allowlists `frame-src https://www.geckoterminal.com`. Add a
  collapsible `PriceChart` (or a lightweight sparkline from the existing `tegridy_price_history` localStorage
  via `usePriceHistory`) beside/below the swap card — the ultrawide layout has an empty left column. Additive;
  reuse the existing component (don't duplicate). Same component-reuse as F212.
- **files:** `src/pages/TradePage.tsx` (mount a collapsible chart column), `src/components/chart/PriceChart.tsx`
- **test:** on `/swap`, expand the chart; assert `PriceChart` renders for the TOWELI/WETH pair.
- **deps:** [F208]

### F212 — No price chart on the Trade page itself (missing)
- **verdict:** duplicate · **rootCause:** standalone · **severity:** low · **effort:** M · **risk:** low
- **approach:** Duplicate of F244 — same additive collapsible `PriceChart` on the trade surface.
- **files:** `src/pages/TradePage.tsx`, `src/components/chart/PriceChart.tsx`
- **test:** covered by F244.
- **deps:** [F244]

### F248 — No transaction deadline setting (missing)
- **verdict:** fix-now · **rootCause:** standalone · **severity:** low · **effort:** S · **risk:** low
- **approach:** Confirmed: settings cover slippage/FoT/MEV but no deadline control, while `useSwap` already
  holds `deadline`/`setDeadline` state (currently dead — see F194). Add a deadline control (default 20 min,
  clamped) to the settings cluster wired to the existing `setDeadline`. Same control F194 calls for — land
  them together.
- **files:** `src/pages/TradePage.tsx` (settings cluster ~279-369), `src/hooks/useSwap.ts:86,367,531-532`
- **test:** set deadline 20m; assert `deadlineTs` in `executeSwap` reflects it.
- **deps:** [F194]
