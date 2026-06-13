# Remediation Plan — g08_shared_lib (Shared lib/ + hooks/ + contexts/)

Surface: `frontend/src/lib/*`, `frontend/src/hooks/*`, `frontend/src/contexts/*`.
Branch: `mvp-launch` @ HEAD. All findings below were opened against the cited file:line and confirmed (or refuted) in code.

Severity headline: **one critical** (F463 — ERC20-input swaps cannot execute because the approval spender doesn't match the execution venue) and **two highs** (F464 keeper venue mismatch, F465 swap-toast re-fire). The remaining items are correctness, honesty, polish, and best-in-class gaps.

---

## Batch: swap-router-spender-map  (F463)

**Summary:** The single most important fix on this surface. The allowance hook and the execution hook disagree about which contract pulls the user's tokens, so every ERC20-input swap on the `tegridy` and `uniswap` routes fails gas-estimation / reverts. One shared spender→executor map closes it.

### F463 — Approval spender does not match execution venue
- **verdict:** fix-now
- **severity:** critical
- **rootCause:** standalone (route-wiring drift; sibling of the T3 family but the bug is logic, not a stale constant)
- **confirmed at HEAD:** Yes. `useSwapAllowance.ts:113` `const spender = selectedRoute === 'tegridy' ? TEGRIDY_ROUTER_ADDRESS : SWAP_FEE_ROUTER_ADDRESS;` and the allowance reads at lines 58/65 check exactly those two spenders (`uniAllowance` = SFR, `tegridyAllowance` = TegridyRouter). But `useSwap.ts` executes `tegridy` through `SWAP_FEE_ROUTER_ADDRESS` (lines 419/425/431) and `uniswap` through `UNISWAP_V2_ROUTER` (lines 469/475/481). So: route=`tegridy` approves TegridyRouter but SFR pulls (revert); route=`uniswap` approves SFR but UniV2Router pulls (revert). Only the aggregator→tegridy-fallback path (approve SFR, execute SFR) lines up. The deep-pool routing commits (43c3ddb, 003445e) post-date the last `useSwapAllowance.ts` touch — genuine regression.
- **approach:** Make the spender map 1:1 with the executor in `executeSwap`. Define a single `routeSpender(selectedRoute, selectedOnChainRoute)` helper (colocate in `useSwapQuote.ts` next to `RouteSource`, or a tiny `lib/swapRouting.ts`) returning `tegridy → SWAP_FEE_ROUTER_ADDRESS`, `uniswap → UNISWAP_V2_ROUTER`, `aggregator → selectedOnChainRoute.source === 'tegridy' ? SWAP_FEE_ROUTER_ADDRESS : UNISWAP_V2_ROUTER`. The allowance read in `useSwapAllowance` must read allowance for *that* spender (it already reads both SFR and UniV2Router-relevant addresses — but note it reads TegridyRouter, not UniV2Router, so add a UniV2Router allowance leg and drop the TegridyRouter leg, OR read all three). `approve()` and `activeAllowance` then select off the same helper. Do NOT change the on-chain execution targets — those are correct post-deep-pool-routing; only the *approval* side is wrong.
- **files:** `src/hooks/useSwapAllowance.ts:52-78` (allowance read legs), `:78` (activeAllowance), `:113` (spender); `src/hooks/useSwap.ts:205` (pass `quote.selectedOnChainRoute` into the allowance hook); new `routeSpender` helper in `src/hooks/useSwapQuote.ts` or `src/lib/swapRouting.ts`.
- **effort:** M
- **risk:** med — touches the money path; the wrong fix could approve the wrong contract. Mitigate with the unit test below and a manual mainnet-fork dry-run.
- **test:** Add `useSwapAllowance.test.ts` (or extend an existing swap test) asserting, for each `selectedRoute` ∈ {tegridy, uniswap, aggregator×{tegridy,uniswap}}, that the spender the hook approves === the `address` `useSwap.executeSwap` writes to. Manual repro: connect on mainnet, sell TOWELI (ERC20-input, route currently `uniswap` with empty native pool), approve, confirm the swap no longer hits a gas-estimation error.
- **deps:** []
- **batchHint:** swap-router-spender-map

---

## Batch: keeper-venue-parity  (F464)

**Summary:** DCA and the browser limit-order keeper quote on UniswapV2Router but execute on SwapFeeRouter (wired to the thin/empty native TegridyRouter pool). Same class of mismatch as F463, isolated to the two keepers. The deep-pool routing fix that landed in `useSwap` (43c3ddb) was never propagated.

### F464 — DCA + browser limit orders quote Uniswap, execute via SFR/TegridyRouter
- **verdict:** fix-now
- **severity:** high
- **rootCause:** standalone (route-wiring drift; the keepers were left behind when useSwap was fixed)
- **confirmed at HEAD:** Yes. `useDCA.ts` quotes `getAmountsOut` on `UNISWAP_V2_ROUTER` (`:435`) and executes on `SWAP_FEE_ROUTER_ADDRESS` (`:499/:511/:523`). `useLimitOrders.ts` quotes on `UNISWAP_V2_ROUTER` (`:321` execute-time re-quote, `:483` poll) and executes on `SWAP_FEE_ROUTER_ADDRESS` (`:404/:416/:427`). With the native pool unseeded the SFR execution reverts; after seeding, a Uniswap-priced floor frequently exceeds native-pool deliverability.
- **approach:** Pick ONE venue per keeper and quote+execute+allowance-check all against it. Lowest-risk and matches today's reality: route both keepers to the **real Uniswap V2 router** for both the quote (already there) and the execution — change the three `writeContract` targets from `SWAP_FEE_ROUTER_ADDRESS`/`SWAP_FEE_ROUTER_ABI` to `UNISWAP_V2_ROUTER`/`UNISWAP_V2_ROUTER_ABI` and drop the trailing `MAX_FEE_BPS` arg (UniV2 signatures have no fee param). Also update the allowance pre-check (`useDCA.ts:467`, `useLimitOrders.ts:373`) to read allowance for `UNISWAP_V2_ROUTER` instead of `SWAP_FEE_ROUTER_ADDRESS`. (Alternative: route through SFR and quote SFR's own router path — defer; it loses fee capture either way until the native pool is seeded and is the riskier change.) This is additive to the existing fee-capture story: keeper volume is small and `useSwap` already captures fees on native `tegridy` volume.
- **files:** `src/hooks/useDCA.ts:434-439` (quote — keep), `:467` (allowance spender), `:497-530` (execute targets/abi/args); `src/hooks/useLimitOrders.ts:320-330` & `:481-492` (quotes — keep), `:373` (allowance spender), `:400-435` (execute targets/abi/args).
- **effort:** M
- **risk:** med — changes the on-chain target for automated keepers; a wrong ABI/arg shape reverts every fill. Both lending-style flows are user-funded per-tick so blast radius is per-swap, not pooled.
- **test:** Extend `useDCA.test.ts` / `useLimitOrders.test.ts` (if present) or add assertions that the `writeContract` mock is called with `address === UNISWAP_V2_ROUTER` and an arg tuple matching the UniV2 signature (no `maxFeeBps`). Manual: create a 1-tick DCA into TOWELI on a fork and confirm the swap lands.
- **deps:** [] (independent of F463 but shares the spender-parity principle; can land in the same PR)
- **batchHint:** keeper-venue-parity

---

## Batch: swap-toast-dedup  (F465)

**Summary:** The swap success effect re-runs every ~1s while `isSuccess` is latched (the quote hook's 1s staleness ticker forces a re-render and the effect's dep array contains an unstable `allowance` object + `quote.selectedRoute`), firing duplicate "Swap confirmed" toasts, a phantom swap toast after a plain approve, and inflated `trackSwap` analytics.

### F465 — Swap success effect re-fires every render for ~4s
- **verdict:** fix-now
- **severity:** high
- **rootCause:** T5 (writes-don't-settle-cleanly family; here the post-write effect double-fires)
- **confirmed at HEAD:** Yes. `useSwap.ts:246-286` effect deps include `allowance` (the `useSwapAllowance` return object is a fresh literal each render — `useSwapAllowance.ts:195-204` is not memoized) plus `inputAmount` and `quote.selectedRoute`. `useSwapQuote.ts:261-265` runs `setInterval(() => setNow(...), 1000)` while a quote is live, re-rendering the consumer each second. `lastActionRef.current` is nulled on the first run (`:263`/`:281`), so subsequent runs fall through to the swap branch and re-toast (`:268`, no `id`) + re-`trackSwap` (`:278`). The canonical guard already exists in `useLPFarming.ts:80-95` (`lastHandledHashRef`).
- **approach:** Adopt the `useLPFarming` pattern verbatim: add `const lastHandledHashRef = useRef<string | null>(null)` and bail at the top of the success effect when `lastHandledHashRef.current === hash`; set it before toasting. Give the swap toast `{ id: hash }` (sonner de-dupes by id — defence in depth). Also memoize the `useSwapAllowance` return object (`useSwapAllowance.ts:195-204` → wrap in `useMemo` keyed on its real deps) so the consumer effect dep is stable, and drop `inputAmount`/`quote.selectedRoute` from the effect deps in favour of the submit-time snapshots already captured in `submittedInputAmountRef`/`submittedRouteRef`.
- **files:** `src/hooks/useSwap.ts:207` (add ref), `:246-286` (guard + toast id + dep trim); `src/hooks/useSwapAllowance.ts:195-204` (memoize return).
- **effort:** S
- **risk:** low — additive guard; the memoization is mechanical. Re-test that the *approve* toast and *swap* toast still each fire exactly once.
- **test:** Add a test rendering `useSwap`, mock `useWaitForTransactionReceipt` to return `isSuccess` and advance fake timers 4s; assert `toast.success` and `trackSwap` are each called once for a swap and that a preceding approve does not emit a swap toast. Manual: do an approve then a swap and watch the toast stack.
- **deps:** []
- **batchHint:** swap-toast-dedup

---

## Batch: aggregator-odos-native  (F466)

### F466 — normalizeTokenAddress('zero') returns the 0xEeee sentinel, not the zero address
- **verdict:** fix-now
- **severity:** medium
- **rootCause:** standalone
- **confirmed at HEAD:** Yes. `aggregator.ts:38` `case 'zero': return '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';` — byte-identical to the `'native'` case at `:36`. `getOdosQuote` (`:116-117`) calls `normalizeTokenAddress(tokenIn, 'zero')` expecting `0x000…000` for native ETH; the wrong value makes Odos reject (→ `null`, swallowed by the catch), silently dropping Odos from every ETH-input quote.
- **approach:** Change the `'zero'` branch to return `'0x0000000000000000000000000000000000000000'`.
- **files:** `src/lib/aggregator.ts:38`.
- **effort:** S
- **risk:** low.
- **test:** Add `aggregator.test.ts` case asserting `normalizeTokenAddress('ETH','zero') === '0x0000…0000'` and (with fetch mocked) that `getOdosQuote` sends the zero address for native input.
- **deps:** []
- **batchHint:** aggregator-odos-native

---

## Batch: quote-refresh-aggregator  (F467, F481)

**Summary:** Two `useSwapQuote` identity/refetch bugs that both degrade quote quality. Group them — same file, same review.

### F467 — refreshQuote never re-fetches aggregator quotes
- **verdict:** fix-now
- **severity:** medium
- **rootCause:** standalone (effect-deps wiring)
- **confirmed at HEAD:** Yes. `useSwapQuote.ts:437-446` bumps `quoteRequestIdRef.current` (a **ref**, not in any dep array) and sets `setAggQuoteResult(null)`. The aggregator fetch effect deps (`:251`) are `[fromToken, toToken, parsedAmount, address, fromDecimals, chainId]` — none change on refresh, so the effect never re-runs; the aggregator leg is permanently lost until the user edits the input. When `useSwap.ts:343-347` blocks a stale swap and calls `refreshQuote`, only on-chain legs refetch.
- **approach:** Convert the request id to state: `const [aggRequestId, setAggRequestId] = useState(0)` and include it in the aggregator effect deps; `refreshQuote` calls `setAggRequestId(n => n + 1)` instead of mutating the ref. Keep the in-flight `quoteRequestIdRef` staleness guard for response-ordering. After the on-chain refetch promises resolve, stamp `quoteFetchedAt` (the existing `:254-258` effect won't fire if the refetched `uniAmountsOut` is structurally identical, leaving `quoteFetchedAt=0`) — set it in `refreshQuote` to `Date.now()` instead of `0`, or stamp from the `refetchUni()`/`refetchTegridy()` returned promises.
- **files:** `src/hooks/useSwapQuote.ts:85` (id→state), `:219-251` (effect deps), `:437-446` (refreshQuote).
- **effort:** S
- **risk:** low-med — re-introduces aggregator HTTP on refresh; verify it still respects the abort/abortController and the 800ms debounce.
- **test:** Render `useSwapQuote`, call `refreshQuote`, assert the aggregator fetch mock is invoked again and `quoteFetchedAt` advances.
- **deps:** []
- **batchHint:** quote-refresh-aggregator

### F481 — return-object memo defeated by a fresh `path` array every render
- **verdict:** fix-now
- **severity:** low
- **rootCause:** standalone (R042 HIGH-2 memo regression)
- **confirmed at HEAD:** Yes. `useSwapQuote.ts:75` `const path = … ? buildPath(...) : [];` is a new array each render and is in the final `useMemo` dep list (`:496`), so the wrapped return identity (and `routeDescription`, also `path`-deped) flips every render — defeating the stated R042 HIGH-2 purpose.
- **approach:** `const path = useMemo(() => (fromToken && toToken ? buildPath(fromToken, toToken) : EMPTY), [fromToken, toToken])` with a module-level `const EMPTY: \`0x${string}\`[] = []`.
- **files:** `src/hooks/useSwapQuote.ts:75`.
- **effort:** S
- **risk:** low.
- **test:** Existing identity test for the hook (if any) should now hold a stable reference across renders with unchanged tokens; otherwise add one.
- **deps:** []
- **batchHint:** quote-refresh-aggregator

---

## Batch: pool-stats-honesty  (F468, F485)

**Summary:** `usePoolTVL` derives fee-APR / volume off a hardcoded pool-launch date ~15 months too early AND, when no fees exist, fabricates an "(est.)" volume from an assumed turnover ratio — directly contradicting the constants.ts honesty mandate ("nothing should render a number the chain can't back"). Both live in one `useMemo`; fix together.

### F468 — POOL_LAUNCH_TIMESTAMP hardcoded to 2025-03-01
- **verdict:** fix-now
- **severity:** medium
- **rootCause:** T3 (pre-relaunch constant drifting from on-chain truth)
- **confirmed at HEAD:** Yes. `usePoolTVL.ts:10` `const POOL_LAUNCH_TIMESTAMP = new Date('2025-03-01').getTime() / 1000;` while `TEGRIDY_LP_ADDRESS` was deployed in the 2026-06-06 relaunch. `:77` computes `poolAgeSec` from that date (~466d vs ~7d), so `dailyFees`/`aprNum`/`vol24h` are ~60–100× too low once real fees exist, and the figure labelled "24h volume" is actually a lifetime daily average.
- **approach:** Set the constant to the actual pair-creation timestamp. Best: add a `TEGRIDY_LP_CREATED_AT` (unix seconds) next to the address block in `constants.ts` (operator supplies it from the pair's first-mint block — see operator note) and import it here; until then set it to the known relaunch date (`2026-06-08` for the LP, matching the `LP_FARMING` relaunch note). Relabel `vol24hFormatted` source as "avg daily volume" in the consumer copy (additive label change only).
- **files:** `src/hooks/usePoolTVL.ts:10` (timestamp), `:111-117` (volume label); `src/lib/constants.ts` (new `TEGRIDY_LP_CREATED_AT`). Consumer label sits in `ProtocolStats.tsx` / `RealYieldProof.tsx` — coordinate copy with the page owner.
- **effort:** S
- **risk:** low.
- **test:** Unit-test the memo with a mocked `totalETHFees`>0 and assert `aprNum`/`vol24h` scale to the corrected pool age; snapshot the "avg daily" label.
- **deps:** []
- **batchHint:** pool-stats-honesty

### F485 — Fabricated '(est.)' volume/APR from an assumed turnover ratio
- **verdict:** fix-now
- **severity:** low
- **rootCause:** T4 (overstated/fabricated figure rendered to users)
- **confirmed at HEAD:** Yes. `usePoolTVL.ts:93-103`: when `totalETHFees === 0`, `vol24h = tvl * dailyVolumeRatio` with ratios 0.01–0.04 bucketed by TVL, and APR derived from that fiction — labelled `~ … (est.)` but unbacked by chain. This is exactly the pattern `constants.ts:116-122` forbids for the season banner.
- **approach:** In the `else if (tvl > 0)` branch, stop synthesizing — set `vol24h = 0` and `aprNum = 0` so the existing `'–'` fall-through renders, and surface a microcopy line "volume appears after first trades" in the consuming stat card (additive copy, no section removal). Keep the real-fee branch (`:74-92`) untouched.
- **files:** `src/hooks/usePoolTVL.ts:93-103`; microcopy in the consuming stat component (ProtocolStats / RealYieldProof).
- **effort:** S
- **risk:** low — removes a number some marketing copy may reference; confirm no test asserts a non-zero est. value.
- **test:** Unit-test that with `totalETHFees === 0` the hook returns `apr === '–'` and `vol24hFormatted === '–'`.
- **deps:** []
- **batchHint:** pool-stats-honesty

---

## Batch: getlogs-deploy-block  (F469)

### F469 — eth_getLogs scans start at stale fromBlock 18000000
- **verdict:** fix-now
- **severity:** medium
- **rootCause:** T3 (pre-relaunch constant drift)
- **confirmed at HEAD:** Yes. `usePoints.ts:77` `fromBlock: 18000000n` for `SwapExecuted` on the relaunch SwapFeeRouter; `useTegridyScore.ts:327` same for `Staked` on the relaunch staking contract. Both catch handlers silently zero the result (`usePoints.ts:81-83`, `useTegridyScore.ts:338-343`), and the score hook's own comment (`:339`) admits public RPCs reject wide ranges. The configured public transports (`wagmi.ts:13-21`) cap getLogs spans well under the ~5M-block ask, so swap count + loyalty score read 0 for most users.
- **approach:** Add a `RELAUNCH_DEPLOY_BLOCK` constant in `constants.ts` (the block of the 2026-06-06 DeployMVP broadcast — operator supplies; see operator note) and use it as `fromBlock` in both hooks. Defensive secondary: if a single scan still 4xxs, chunk it (e.g. 50k-block windows) — but the deploy-block fix alone collapses the span from ~5M to a few-thousand blocks and should clear the public-RPC cap.
- **files:** `src/lib/constants.ts` (new `RELAUNCH_DEPLOY_BLOCK`); `src/hooks/usePoints.ts:77`; `src/hooks/useTegridyScore.ts:327`.
- **effort:** S (constant) / M (if chunking added)
- **risk:** low.
- **test:** Mock `getLogs` to assert it's called with the deploy-block `fromBlock`, not `18000000n`. Manual: connect a wallet with a known relaunch swap and confirm swap count > 0.
- **deps:** depends on operator supplying the deploy block (F469-operator note below) — code can ship with the known relaunch block hardcoded in the interim.
- **batchHint:** getlogs-deploy-block

---

## Batch: ipfs-gateway-order  (F470)

### F470 — IPFS gateway list leads with sunset cloudflare-ipfs.com; single-host resolvers have no fallback
- **verdict:** fix-now
- **severity:** medium
- **rootCause:** T3 / T12 (stale infra constant; broken-image symptom)
- **confirmed at HEAD:** Yes. `imageSafety.ts:57-61` `IPFS_GATEWAYS = ['https://cloudflare-ipfs.com/ipfs/', 'https://dweb.link/ipfs/', 'https://ipfs.io/ipfs/']`; `resolveSafeUrl` (`:80-83`) and `safeUrl` (`:163-165`) return `IPFS_GATEWAYS[0]` only. `fetchWithIpfsFallback` races the list, but `<img src>` consumers (`safeUrl` → CollectionDetailV2, useNFTDropV2 resolveAssetUrl) get a single dead host. Cloudflare deprecated its public IPFS gateway in 2024 (external infra fact — verify with one fetch; if it 410s, every ipfs-hosted image is broken).
- **approach:** Minimal: reorder `IPFS_GATEWAYS` so a live gateway leads — `['https://ipfs.io/ipfs/', 'https://dweb.link/ipfs/', 'https://cloudflare-ipfs.com/ipfs/']` (keep cloudflare last as a harmless tail; additive, removes nothing). Better follow-up (separate item, not required here): have the `<img onError>` in `ArtImg`/`NftImage` advance through `ipfsCandidates()` — that lives in component surfaces, flag for the image-component owner.
- **files:** `src/lib/imageSafety.ts:57-61`.
- **effort:** S
- **risk:** low.
- **test:** Unit-test `resolveSafeUrl('ipfs://CID')` returns an `ipfs.io` (or dweb) URL. Manual: load an ipfs-hosted collection image and confirm it renders.
- **deps:** []
- **batchHint:** ipfs-gateway-order

---

## Batch: loans-refetch-tick  (F471)

### F471 — useMyLoans 60s "refetch" is a no-op; NFT effect has no interval; overdue uses a frozen `now`
- **verdict:** fix-now
- **severity:** medium
- **rootCause:** T5 (writes/state never refetch)
- **confirmed at HEAD:** Yes. `useMyLoans.ts:117-121` `setInterval(() => setTokenLoading((p) => p), REFETCH_MS)` — setting state to its current value bails React's re-render, and even a re-render wouldn't re-run the fetch effect (deps `:123` unchanged). The NFT effect (`:125-163`) has no interval at all. `status: 'overdue'` is computed from a `now` captured once in `useMemo` (`:167`) whose deps (`:226`) exclude time. Both lending addresses are zeroed today (`constants.ts:47,54`), so this is inert now but ships with the lending un-gate.
- **approach:** Replace the no-op tick with a real one: `const [tick, setTick] = useState(0)` + `setInterval(() => setTick(t => t+1), REFETCH_MS)` and include `tick` in BOTH fetch-effect dep arrays (token and NFT). Recompute `now` per-render by including `tick` in the `outstanding` useMemo deps (or compute overdue inside the interval-driven recompute). Lowest-risk alt that matches the rest of the codebase: move both sweeps into tanstack-query `useQueries` with `refetchInterval: REFETCH_MS` — but the `tick` approach is the smaller diff for the recovery pass.
- **files:** `src/hooks/useMyLoans.ts:80-123` (token effect + tick), `:125-163` (NFT effect + interval + tick), `:165-226` (overdue recompute deps).
- **effort:** M
- **risk:** low (feature gated off in prod) — but it's the code that ships when lending un-gates, so correctness matters.
- **test:** With fake timers and a mock `readContract`, assert `getLoan` is re-read after `REFETCH_MS` and that an order crossing its deadline flips to `overdue` without a remount.
- **deps:** [] (blocked from prod by the lending deploy/audit gate, not by other findings)
- **batchHint:** loans-refetch-tick

---

## Batch: tracked-receipt-fix  (F472)

### F472 — useTrackedTransactionReceipt reads fields wagmi never returns at top level
- **verdict:** fix-now
- **severity:** medium
- **rootCause:** standalone (incorrect wagmi-v2 shape; dead code today)
- **confirmed at HEAD:** Yes. `useTransactionReceipt.ts:117-127` casts the `useWaitForTransactionReceipt` result and reads `receiptStatus`/`blockNumber`/`errorName` at the top level, but wagmi v2 exposes `data.status`, `data.blockNumber`, and `error.name`. So `result.receiptStatus === 'reverted'` (`:155`) can never trip — a genuinely reverted receipt falls through to `status: 'confirmed'` (`:164`). Only the test mock (`test-utils/wagmi-mocks.ts:185`) supplies the flat fields, so tests pass while runtime is wrong. Grep confirms **no app component** consumes the hook — only tests/mocks (`useTransactionReceipt.test.tsx`, `wagmi-mocks.ts`).
- **approach:** Read the real shape: pull `data` and `error` from the hook and map `data?.status` → reverted/success, `data?.blockNumber`, `error?.name`. Then either (a) actually wire the hook into the tx-toast paths that need reorg/revert awareness, or (b) if no consumer is planned, delete the hook + its test + the mock passthrough to keep the audit surface honest. Recommend (a)-lite: fix the shape now (cheap correctness), defer wiring. Flag the wiring as a separate product decision.
- **files:** `src/hooks/useTransactionReceipt.ts:117-171`; if deleting: also `test-utils/wagmi-mocks.ts:185` and `useTransactionReceipt.test.tsx`.
- **effort:** S
- **risk:** low (no live consumer).
- **test:** Update `useTransactionReceipt.test.tsx` to feed `{ data: { status: 'reverted', blockNumber }, isSuccess: true }` and assert `status === 'failed'`.
- **deps:** []
- **batchHint:** tracked-receipt-fix

---

## Batch: zod-schemas-decision  (F473)

### F473 — R080 zod schema files (aggregator/geckoTerminal/opensea)
- **verdict:** false-positive
- **severity:** medium
- **rootCause:** standalone
- **confirmed at HEAD:** Refuted as stated. The finding asserts three dead schema files under `lib/schemas/` that should be wired or deleted. Glob `src/**/schemas/**` and `src/lib/schemas/*` both return **no files** — the directory does not exist at HEAD. So there is nothing to wire or delete; the premise is stale (the files were never committed, or already removed). The underlying observation that the boundaries validate by hand (`aggregator.ts:94` regex check, `useToweliPrice.ts:121` untyped walk) is true, but that's a *missing-validation* improvement, not a dead-file cleanup — and it's out of scope for a "prune the schema files" item.
- **approach:** No action on the cited files (they don't exist). If the team still wants boundary validation, open a fresh, correctly-scoped item to add `parseOrNull`-style zod parsing at the aggregator/GeckoTerminal/OpenSea boundaries — but do not invent the three files this finding assumes.
- **files:** none (no such files at HEAD).
- **effort:** S (verification only)
- **risk:** low.
- **test:** n/a — `git ls-files src/lib/schemas` is empty.
- **deps:** []
- **batchHint:** zod-schemas-decision

---

## Batch: txerror-surfacing-sweep  (F474)

### F474 — Purpose-built txErrors helper unused in the money paths
- **verdict:** fix-now
- **severity:** medium
- **rootCause:** standalone (consistent error-UX gap across hooks)
- **confirmed at HEAD:** Yes. Grep: `surfaceTxError`/`isUserRejection` are imported only by `GaugeVoting.tsx`, the unrelated `mevProtection` copy, and the nakamigos side — **not** by the money-path hooks. Confirmed raw/generic toasts: `useFarmActions.ts:76` raw `writeError.message…slice(0,120)`; `useLPFarming.ts:111` raw `writeError.message?.slice(0,120)`; `useAddLiquidity.ts:159` raw message; `useRestaking.ts:142` raw message; `useRevenueStats.ts:100` and `useBribes.ts:345` generic `'Transaction failed'` (fires on user-rejection too); `useNFTDropV2.ts:232` `'Mint failed'` on rejection. `txErrors.ts` already classifies `UserRejectedRequestError` (with the nested-cause walk, `:56-72`) into a soft "Cancelled" info toast.
- **approach:** Mechanical sweep — replace each per-hook `writeError`→toast block with `surfaceTxError(writeError, toast, { component: '<HookName>' })`. Keep the existing `id`/`reset()` scheduling around it. For the two generic-`'Transaction failed'` hooks, this is a strict upgrade (rejections become "Cancelled"). Optionally fold `ERROR_COPY` (copy.ts) flavour into `surfaceTxError`'s default messages here so the dead `ERROR_COPY` export (see F487) gets a consumer in the same PR.
- **files:** `src/hooks/useFarmActions.ts:~76`; `src/hooks/useLPFarming.ts:~111`; `src/hooks/useAddLiquidity.ts:~159`; `src/hooks/useRestaking.ts:~142`; `src/hooks/useRevenueStats.ts:~100`; `src/hooks/useBribes.ts:~345`; `src/hooks/useNFTDropV2.ts:~231-235`.
- **effort:** M
- **risk:** low — same toast surface, better classification; verify each hook still imports `toast` and that `surfaceTxError`'s `ToastLike` matches sonner's `toast`.
- **test:** For one representative hook, feed a `code: 4001` writeError and assert an `info`/"Cancelled" toast (not `error`). Extend `txErrors.test.ts` coverage already exists for the classifier.
- **deps:** [] (F487 ERROR_COPY wiring can ride along)
- **batchHint:** txerror-surfacing-sweep

---

## Batch: analytics-import-safety  (F475)

### F475 — Module-level sessionStorage/crypto.randomUUID can crash at import; unbounded failed-flush queue
- **verdict:** fix-now
- **severity:** medium
- **rootCause:** standalone (defensive-boot + memory bound)
- **confirmed at HEAD:** Yes. `analytics.ts:30` `const sessionId = getSessionId();` runs at module scope; `getSessionId` (`:20-28`) calls `sessionStorage.getItem` (throws `SecurityError` in storage-blocked iframes/webviews) and `crypto.randomUUID()` (requires a secure context) with no try/catch — either kills the bundle at import. `:81` `queue = [...batch, ...queue]` re-queues forever on fetch failure with no cap.
- **approach:** Wrap `getSessionId` body in try/catch returning a `Math.random`-based fallback id when storage/crypto throw (and guard `crypto?.randomUUID` existence). Cap the re-queue: after concat, `queue = queue.slice(-200)` (drop oldest beyond 200 events). Mirror the same crypto-guard style already used in `useDCA.ts:18-20`.
- **files:** `src/lib/analytics.ts:20-30` (try/catch + fallback), `:79-82` (queue cap).
- **effort:** S
- **risk:** low.
- **test:** Unit-test `getSessionId` with `sessionStorage.getItem` mocked to throw → returns a non-empty string and doesn't throw. Test that 300 failed flushes leave `queue.length <= 200`.
- **deps:** []
- **batchHint:** analytics-import-safety

---

## Batch: stale-constants-comments  (F476, F479, F480)

**Summary:** Three low-severity staleness fixes in shared constants/copy — a contradictory comment, a legacy token, and dead-mechanic copy. Cheap, independent, batch together.

### F476 — Stale ZEROED comment above the live LP_FARMING_ADDRESS
- **verdict:** fix-now
- **severity:** low
- **rootCause:** T3 (stale constant annotation)
- **confirmed at HEAD:** Yes. `constants.ts:25-27` reads "ZEROED 2026-05-31 … Restore the real address after the relaunch redeploy." directly above `:28` which holds the live relaunch address `0x1171268A…` (deployed 2026-06-08, per the trailing comment on the same line). The two comments contradict; a reader skimming the gating table misreads the farm as gated.
- **approach:** Delete the stale `// ZEROED 2026-05-31 …` block (lines 25-27), keep only the RELAUNCH note on line 28.
- **files:** `src/lib/constants.ts:25-27`.
- **effort:** S
- **risk:** low.
- **test:** n/a (comment-only) — confirm no code parses these comments.
- **deps:** []
- **batchHint:** stale-constants-comments

### F479 — Default token list ships legacy MATIC
- **verdict:** product-decision
- **severity:** low
- **rootCause:** T3
- **confirmed at HEAD:** Yes. `tokenList.ts:106-111` ships `symbol:'MATIC', name:'Polygon', address:0x7D1AfA7B…` — the legacy token; Polygon migrated to POL (`0x455e53…`) in Sept 2024. Cosmetic but signals staleness in a curated list.
- **approach:** Additive — add a POL entry (`0x455e5306…`) to `DEFAULT_TOKENS`; keep MATIC if the legacy pair should stay tradable (owner call — hence product-decision). Per the additive mandate, do not remove MATIC without an owner decision.
- **files:** `src/lib/tokenList.ts:105-111` (add POL alongside).
- **effort:** S
- **risk:** low.
- **test:** Assert `findToken('0x455e5306…')` resolves POL.
- **deps:** []
- **batchHint:** stale-constants-comments

### F480 — Score tip references the removed daily-visit streak
- **verdict:** fix-now
- **severity:** low
- **rootCause:** T4 (copy promises a mechanic that no longer exists)
- **confirmed at HEAD:** Yes. `useTegridyScore.ts:155` tip "Tip: Visit daily and swap to build your streak", but `pointsEngine.ts:194-197` `recordDailyVisit` is a `@deprecated` no-op ("Daily visit streaks removed -- not verifiable on-chain"). The streak can never grow, so the tip is unactionable.
- **approach:** Reword the `activityScore` tip to swaps/staking only, e.g. "Tip: Swap and stake to build on-chain activity." (Activity score is driven by `onChainPoints`, which come from swap count + staking — keep it truthful.)
- **files:** `src/hooks/useTegridyScore.ts:155`.
- **effort:** S
- **risk:** low.
- **test:** n/a (copy) — optionally snapshot the tip string in an existing score test.
- **deps:** []
- **batchHint:** stale-constants-comments

---

## Batch: refund-toast-action  (F477)

### F477 — Refund transactions toast 'Mint confirmed!' / 'Mint failed'
- **verdict:** fix-now
- **severity:** low
- **rootCause:** T5 (single receipt effect can't tell which write it's reporting)
- **confirmed at HEAD:** Yes. `useNFTDropV2.ts:225-236` toasts `toast.success('Mint confirmed!')` / `toast.error('Mint failed')` for **any** hash, but the same hook also submits `refund()` (`:214`) via the same `writeContract` — a successful refund shows "Mint confirmed!".
- **approach:** Track `lastActionRef = useRef<'mint'|'refund'|null>(null)`, set it in `mint()` and `refund()` before `writeContract`, and branch the toast copy in the receipt effect (mirror `useSwap.ts` `lastActionRef`). Fold the F465-style `lastHandledHashRef` guard in too if not already present.
- **files:** `src/hooks/useNFTDropV2.ts:~195` (mint set), `:214` (refund set), `:225-236` (branch copy).
- **effort:** S
- **risk:** low.
- **test:** Render the hook, call `refund()`, simulate success, assert a refund-worded toast (not "Mint confirmed!").
- **deps:** []
- **batchHint:** refund-toast-action

---

## Batch: txhistory-skip-zeroed  (F478)

### F478 — categorizeTx matches zeroed-contract addresses → ETH burns labelled 'Restake'
- **verdict:** fix-now
- **severity:** low
- **rootCause:** T3 (zeroed addresses collide on compare)
- **confirmed at HEAD:** Yes. `txHistory.ts:97` `if (to === TEGRIDY_RESTAKING_ADDRESS.toLowerCase())` — and `TEGRIDY_RESTAKING_ADDRESS` is the zero address (`constants.ts:7`), as are COMMUNITY_GRANTS/MEME_BOUNTY/PREMIUM/VOTE_INCENTIVES below it. A tx `to` `0x000…0` (ETH burn / zero-send) hits the first zero-compare (Restaking at `:97`) and is mislabelled 'Restake'.
- **approach:** Guard each address branch with `isDeployed()` — `import { isDeployed } from './constants'` and wrap: `if (isDeployed(TEGRIDY_RESTAKING_ADDRESS) && to === TEGRIDY_RESTAKING_ADDRESS.toLowerCase())`. Cleanest: build the comparison table once as `[ [addr, fn→label] ]` filtered by `isDeployed`, but the per-branch guard is the minimal diff. A `to === '0x000…0'` send then correctly falls through to `'Other'`.
- **files:** `src/lib/txHistory.ts:88,97,104,109,115,122,129,135` (each contract branch; the zeroed ones especially).
- **effort:** S
- **risk:** low.
- **test:** `categorizeTx({ to: '0x0000…0000', functionName: '' })` returns `{ type: 'Other' }`, not 'Restake'.
- **deps:** []
- **batchHint:** txhistory-skip-zeroed

---

## Batch: errorreport-http-persist  (F482)

### F482 — flush() drops the batch on HTTP error responses
- **verdict:** fix-now
- **severity:** low
- **rootCause:** standalone
- **confirmed at HEAD:** Yes. `errorReporting.ts:137-147` `fetch(endpoint, {...}).catch(() => persistToLocalStorage(toSend))` — `fetch` only rejects on network error; a 4xx/5xx resolves with `res.ok === false`, which is never checked, so the batch is silently lost.
- **approach:** `.then(r => { if (!r.ok) persistToLocalStorage(toSend); }).catch(() => persistToLocalStorage(toSend))`.
- **files:** `src/lib/errorReporting.ts:138-144`.
- **effort:** S
- **risk:** low.
- **test:** Mock `fetch` to resolve `{ ok: false, status: 500 }` and assert `persistToLocalStorage` is called.
- **deps:** []
- **batchHint:** errorreport-http-persist

---

## Batch: keeper-poll-load  (F483)

### F483 — Limit-order poll fires up to 50 sequential getAmountsOut/15s; CoW poll lacks the hidden-tab gate
- **verdict:** fix-now
- **severity:** low
- **rootCause:** T8 (always-on pollers / prod rate-limiter risk)
- **confirmed at HEAD:** Yes. `useLimitOrders.ts:41` `PRICE_POLL_INTERVAL=15_000` with a per-active-order sequential `readContract` loop (`:473-503`, `MAX_ORDERS=50`) — the heaviest poller on public RPCs. `useCowLimitOrder.ts:259-264` polls every 30s with **no** `document.visibilityState === 'hidden'` skip, while `useDCA.ts:556` and `useLimitOrders.ts:511` both apply it.
- **approach:** Two minimal changes: (1) add the visibility gate to the CoW poll interval (`if (document.visibilityState === 'hidden') return;` at the top of the `setInterval` callback, mirroring `:511`). (2) Batch the per-order quotes into one `publicClient.multicall` per tick instead of the sequential loop (viem `multicall` with one `getAmountsOut` call per active order) — collapses 50 round-trips into 1. Keep the 15s interval and the `readWithTimeout` wrapper.
- **files:** `src/hooks/useCowLimitOrder.ts:259-264` (visibility gate); `src/hooks/useLimitOrders.ts:473-503` (multicall batch).
- **effort:** M (multicall) / S (just the visibility gate)
- **risk:** low-med — multicall changes the read shape; ensure partial failures still let other orders evaluate (use `allowFailure: true`).
- **test:** Assert the CoW poll callback early-returns when `document.visibilityState === 'hidden'`. Assert the limit poll issues one multicall (not N readContracts) for N active orders.
- **deps:** []
- **batchHint:** keeper-poll-load

---

## Batch: hook-minor-consistency  (F484, F488)

**Summary:** Small consistency/leak fixes across keeper + alert hooks. Group as one polish PR.

### F484 — Un-cleaned setTimeout(reset) timers; stake() throws while siblings return
- **verdict:** fix-now
- **severity:** low
- **rootCause:** standalone
- **confirmed at HEAD:** Yes. `useAddLiquidity.ts:146/153/160` schedule `setTimeout(() => reset(), 4000)` inside effects with no cleanup (leaky vs the `useSwap.ts:284-285` cleanup pattern; also present in useLPFarming). `useFarmActions.ts` `stake()` does `if (wei === null) throw new Error('Invalid amount')` (an exception on an onClick path) while `approve()` silently returns for the same null parse.
- **approach:** In `useAddLiquidity` effects, capture the timer and return `() => clearTimeout(t)` (copy the `useSwap.ts:284-285` shape). In `useFarmActions.stake()`, replace the `throw` with `toast.error('Invalid amount'); return;` to match `approve()`.
- **files:** `src/hooks/useAddLiquidity.ts:140-163`; `src/hooks/useFarmActions.ts` (stake() null branch, ~line 99).
- **effort:** S
- **risk:** low.
- **test:** Confirm no unhandled throw when staking an empty amount (the button handler should toast, not crash an ErrorBoundary).
- **deps:** []
- **batchHint:** hook-minor-consistency

### F488 — Price-alert copy/scope mismatch; notification fired inside a state updater; unused param
- **verdict:** fix-now
- **severity:** polish
- **rootCause:** standalone (with a T4 copy sliver: "per wallet" is untrue)
- **confirmed at HEAD:** Yes. `usePriceAlerts.ts:15` single device-global `STORAGE_KEY='tegridy-price-alerts'` (no address scoping) while `:107` toasts "Up to 20 price alerts **per wallet**"; `:69-88` call `sendNotification` inside the `setAlerts` updater (`:78-81`), which can run twice under dev StrictMode. `usePriceHistory.ts:25` takes `_currentPrice?: number` that's never used.
- **approach:** (1) Move `sendNotification` out of the updater: compute the crossed alerts from `prev` inside the updater, return new state, then fire notifications in a follow-up effect or after `setAlerts` resolves (collect crossed ids and notify outside the reducer). (2) Fix the copy — either scope `STORAGE_KEY` by address (matches the "per wallet" promise, mirrors `useDCA.getStorageKey`) OR change the toast to "Up to 20 price alerts" (drop "per wallet"). Address-scoping is the more correct fix and additive. (3) Drop the unused `_currentPrice` param from `usePriceHistory` (and its call sites).
- **files:** `src/hooks/usePriceAlerts.ts:15,69-88,107`; `src/hooks/usePriceHistory.ts:25` + call sites.
- **effort:** S
- **risk:** low — address-scoping changes the storage key; existing device-global alerts would not migrate (acceptable for a local UX cache; note it).
- **test:** With StrictMode, assert `sendNotification` fires once per crossing. Assert the alerts toast copy matches the actual scope.
- **deps:** []
- **batchHint:** hook-minor-consistency

---

## Batch: formatting-centralize  (F486)

### F486 — Negative-value formatting quirks; raw .toFixed() bypassing the central util
- **verdict:** fix-now
- **severity:** polish
- **rootCause:** T6 (raw-value rendering / inconsistent formatting)
- **confirmed at HEAD:** Yes. `formatting.ts:11` renders negatives as `$-12.34` (sign inside the `$`, vs the `-$12.34` convention); `formatNumber` (`:14-21`) falls through all the `>=` thresholds for negatives, so `-5000` → `-5000.00` with no thousands separators. Grep counts **306** `.toFixed(` occurrences across 76 files (the finding's "88 across 24" undercounts — the systemic scatter is worse than reported) despite `formatCurrency`/`formatNumber`/`formatTokenAmount`/`formatWei` existing.
- **approach:** Two parts. (1) Fix the util: in `formatCurrency`/`formatNumber`, handle sign once — `const sign = value < 0 ? '-' : ''; const v = Math.abs(value);` then format `v` and prefix `sign` outside the `$` (`-$12.34`); add the negative branch to `formatNumber` so `< -1000` gets `toLocaleString` separators. (2) Sweep: migrate raw `.toFixed()` money/number renders in components onto the utils — but scope this to the **shared-util fix + a representative first wave**; the full 76-file sweep is multi-day and spans every page surface (out of this surface's lane). Land the util fix here; flag the component sweep as a follow-up so it doesn't balloon this PR. NEVER alter chart/art numeric internals that aren't user-facing currency.
- **files:** `src/lib/formatting.ts:3-21` (sign handling). Component sweep tracked separately (76 files incl. nakamigos).
- **effort:** S (util) / L (full sweep — defer)
- **risk:** low (util) — add tests so the sign change doesn't surprise existing snapshots.
- **test:** Unit-test `formatCurrency(-12.34) === '-$12.34'` and `formatNumber(-5000) === '-5,000.00'`.
- **deps:** []
- **batchHint:** formatting-centralize

---

## Batch: dead-export-prune  (F487)

### F487 — Dead/under-wired exports: ERROR_COPY, randomToweliQuote, poolFlavorLabel, lockLabelForSeconds, useTrackedTransactionReceipt, EIP-5792 foundation
- **verdict:** product-decision
- **severity:** polish
- **rootCause:** standalone
- **confirmed at HEAD:** Partially. Corrections to the finding: `randomToweliQuote` is **NOT dead** — it's consumed by `TowelieAssistant.tsx:297`. `ERROR_COPY` (copy.ts:131), `poolFlavorLabel` (`:150`), `lockLabelForSeconds` (`:60`) are consumed only by `copy.test.ts` (effectively dead in app code). `useTrackedTransactionReceipt` is consumed only by tests/mocks (confirmed — see F472). `eip5792.ts` is consumed only by `eip5792.test.ts` — unwired despite being a Tier-1 roadmap item.
- **approach:** Owner decision per export: (a) wire — fold `ERROR_COPY` into the F474 `surfaceTxError` sweep (gives it a real consumer); wire EIP-5792 into the approve+swap path (this is the F500 roadmap item — separate effort); fix+wire `useTrackedTransactionReceipt` per F472. (b) prune — delete `poolFlavorLabel`/`lockLabelForSeconds` if no UI will use them. Do NOT delete `randomToweliQuote` (it's live). Because "wire vs delete" is a roadmap/voice call, this is a product-decision, not a mechanical fix.
- **files:** `src/lib/copy.ts:60,131,150`; `src/hooks/useTransactionReceipt.ts`; `src/lib/eip5792.ts`.
- **effort:** S (prune) / M (wire ERROR_COPY) / L (wire EIP-5792 — see F500)
- **risk:** low.
- **test:** If pruning, `tsc`/build stays green (no dangling imports). If wiring ERROR_COPY, covered by the F474 tests.
- **deps:** [F474 for the ERROR_COPY-wiring option; F500 for the EIP-5792-wiring option]
- **batchHint:** dead-export-prune

---

## Batch: ankr-rpc-verify  (F489)

### F489 — rpc.ankr.com/eth may now require an API key
- **verdict:** operator-action
- **severity:** low
- **rootCause:** T3 (infra constant drift) — but the fix is verify/swap, not code logic
- **confirmed at HEAD:** Partially — the code is as cited (`wagmi.ts:15` `http('https://rpc.ankr.com/eth')` is slot 2 of the mainnet fallback). Whether Ankr now 401s its keyless public endpoint is an **external infra fact the finding itself flags as unverified** ("confirm with one curl"). `rank: true` (`:20`) heals it mid-session but first-hit users pay the timeout. llamarpc (`:18`) is already demoted with a "dead public RPC" note, so the team tracks this class.
- **approach:** Operator/maintainer curls the three public RPCs (`ethereum-rpc.publicnode.com`, `rpc.ankr.com/eth`, `eth.llamarpc.com`) with an `eth_blockNumber` POST. If Ankr returns 401/403, swap it for a keyless alternative (`https://eth.drpc.org` or `https://1rpc.io/eth`) in the fallback list — a one-line code change once verified. Consider a tiny CI weekly probe so dead public RPCs surface proactively (matches `reference_vercel`-style ops discipline).
- **files:** `src/lib/wagmi.ts:15` (swap target once verified).
- **effort:** S
- **risk:** low — `fallback` + `rank` means even a dead slot degrades gracefully.
- **test:** `curl -s -X POST https://rpc.ankr.com/eth -d '{"jsonrpc":"2.0","method":"eth_blockNumber","id":1}'` — expect a `result`, not an auth error.
- **deps:** []
- **batchHint:** ankr-rpc-verify

---

## Batch: tokenomics-live-derive  (F490)

### F490 — POLAccumulator marked live:false on Tokenomics despite being deployed
- **verdict:** fix-now
- **severity:** low
- **rootCause:** T3 (hand-maintained flag drifted from on-chain truth)
- **confirmed at HEAD:** Yes. `TokenomicsPage.tsx:44` `{ label: 'POLAccumulator', address: POL_ACCUMULATOR_ADDRESS, live: false }` while `constants.ts:23` holds the live relaunch address `0x2A5f65f4…` (RELAUNCH 2026-06-06). NOTE: this file (`pages/TokenomicsPage.tsx`) is a **page surface**, outside g08's lib/hooks lane — the constants-audit caught it cross-surface. Listed here for completeness; the page-auditor (g0x pages group) owns the final fix and any rendering-impact check.
- **approach:** Derive `live` from `isDeployed(address)` instead of the hand-maintained boolean for every row in this table (`TokenomicsPage.tsx:40-44` and the rows above) — `live: isDeployed(POL_ACCUMULATOR_ADDRESS)`. Eliminates the whole class of flag-drift. Coordinate with the page owner so the change lands in the pages PR, not the lib PR.
- **files:** `src/pages/TokenomicsPage.tsx:35-45` (derive `live` from `isDeployed`).
- **effort:** S
- **risk:** low.
- **test:** Snapshot the table and assert POLAccumulator renders as live.
- **deps:** [] — but ownership sits with the pages-surface plan; cross-link there.
- **batchHint:** tokenomics-live-derive

---

## Batch: missing-best-in-class  (F491–F502)

**Summary:** Twelve `missingVsBestInClass` gaps. None are bugs; each is a feature the surface lacks vs Uniswap/1inch-grade DEX UIs. Verified that each is genuinely absent at HEAD. These are product-decisions (build/skip/prioritize) — none should be silently coded without owner sign-off, and several are explicitly gated by infra the owner controls (indexer, push, server-side keepers). Grouped so the owner can triage as a set.

### F491 — Swap deep links (?inputCurrency=&outputCurrency=&exactAmount=)
- **verdict:** product-decision
- **severity:** low
- **rootCause:** standalone
- **confirmed absent at HEAD:** Yes. `TradePage.tsx` reads only `?tab=` (`:46-95`); `useSwap` has no URL-param ingestion for token/amount prefill. The plumbing is close — `useSearchParams` is already imported — so prefilling `fromToken`/`toToken`/`inputAmount` from `inputCurrency`/`outputCurrency`/`exactAmount` is a contained add.
- **approach:** If approved: on mount, read the three params, resolve tokens via `findToken` (tokenList) and call `setFromToken`/`setToToken`/`setInputAmount`; write them back on change for shareable URLs. Reuse the custom-token verification path before honoring an arbitrary `outputCurrency` address (security parity with `addCustomToken`).
- **files:** `src/pages/TradePage.tsx` (param read/write), `src/hooks/useSwap.ts` (accept initial token/amount).
- **effort:** M
- **risk:** med — arbitrary `outputCurrency` addresses must run through the existing on-chain symbol/decimals verification (`verifyCustomTokenOnChain`) to avoid the phishing surface the swap UI already defends.
- **test:** Load `/swap?outputCurrency=<TOWELI>&exactAmount=1` and assert the form prefills.
- **deps:** []
- **batchHint:** missing-best-in-class

### F492 — USD values alongside token amounts in the quote pipeline
- **verdict:** product-decision
- **severity:** low
- **rootCause:** standalone
- **confirmed absent at HEAD:** Yes. `useSwapQuote` returns token-denominated outputs only; price context (`PriceContext`/`useTOWELIPrice`, ETH/USD feed) exists but isn't joined into per-leg quotes.
- **approach:** If approved: in the quote consumer (TradePage route panel), multiply formatted outputs by the relevant USD price already available from `useTOWELIPrice`/ETH-USD; keep it in the view layer (don't bloat the hook). Additive display only.
- **files:** TradePage quote/route panel components (view layer).
- **effort:** M
- **risk:** low.
- **test:** Assert a USD string renders next to the output amount when price > 0.
- **deps:** []
- **batchHint:** missing-best-in-class

### F493 — Transaction simulation/preview before signing
- **verdict:** product-decision
- **severity:** low
- **rootCause:** standalone
- **confirmed absent at HEAD:** Yes. Writes go straight to the wallet; no `eth_call`/Tenderly simulate. Aggregator quotes carry `estimatedGas` (aggregator.ts) that's never surfaced (ties to F501).
- **approach:** If approved: a pre-sign `publicClient.call`/`simulateContract` against the chosen route to surface expected balance deltas + revert reasons before the wallet prompt. Larger effort; sequence after the F463/F464 routing fixes so simulation targets the correct venue.
- **files:** `src/hooks/useSwap.ts` (pre-sign simulate), shared sim helper in `lib/`.
- **effort:** L
- **risk:** med.
- **test:** Mock `simulateContract` and assert a preview renders / a revert blocks the send.
- **deps:** [F463, F464]
- **batchHint:** missing-best-in-class

### F494 — Standard token-list ingestion (tokenlists.org)
- **verdict:** product-decision
- **severity:** low
- **rootCause:** standalone
- **confirmed absent at HEAD:** Yes. `tokenList.ts` is a 14-token hardcoded array (`DEFAULT_TOKENS`) plus manual address import; no remote tokenlist fetch, no logo fallback service.
- **approach:** If approved: fetch a pinned tokenlists.org JSON (e.g. Uniswap default) behind a cache + schema-validate (this is where real zod boundary validation would belong — cf. F473). Keep the hardcoded list as the offline fallback (additive).
- **files:** `src/lib/tokenList.ts` (+ a fetch/cache helper).
- **effort:** M
- **risk:** med — remote token data is an injection surface; validate + pin.
- **test:** Mock the list endpoint and assert tokens merge in with the local list as fallback.
- **deps:** []
- **batchHint:** missing-best-in-class

### F495 — Server-side / delegated execution for DCA & limit orders
- **verdict:** product-decision
- **severity:** low
- **rootCause:** standalone
- **confirmed absent at HEAD:** Yes. `useDCA` and `useLimitOrders` are browser-resident keepers that stop when the tab closes; CoW (`useCowLimitOrder`) covers limit *sells* only; DCA has no CoW/Composable-order fallback.
- **approach:** Owner/infra decision — delegated execution needs a server keeper or CoW Composable/Programmatic orders. Out of pure-frontend scope; gate on infra. After F464, at least the browser keepers will execute correctly.
- **files:** n/a (infra) — frontend would add a CoW-composable path in `useDCA`.
- **effort:** L
- **risk:** med.
- **test:** n/a until scoped.
- **deps:** [F464]
- **batchHint:** missing-best-in-class

### F496 — Indexer-backed history/analytics
- **verdict:** operator-action
- **severity:** low
- **rootCause:** standalone
- **confirmed absent at HEAD:** Yes. `useProtocolStats` self-describes volume as a "fees ÷ feeRate approximation"; no per-epoch revenue / per-user PnL / real 24h volume until the Ponder/Dune indexer work lands (a known pending operator task).
- **approach:** Operator stands up the indexer (Ponder/Dune) per the pending-tasks checklist; frontend then reads it. Pure-frontend can't fabricate real volume (cf. F485 honesty mandate).
- **files:** n/a (operator/infra); frontend stats hooks become consumers later.
- **effort:** L
- **risk:** low.
- **test:** n/a until the indexer exists.
- **deps:** []
- **batchHint:** missing-best-in-class

### F497 — Push notifications for price alerts / order fills when tab closed
- **verdict:** product-decision
- **severity:** low
- **rootCause:** standalone
- **confirmed absent at HEAD:** Yes. `usePriceAlerts`/`useDCA`/`useLimitOrders` use the `Notification` API, which only fires while the tab is open. The nakamigos side has VAPID plumbing; the Tegridy alerts don't use it.
- **approach:** If approved: reuse the nakamigos VAPID/service-worker plumbing for Tegridy alerts (web-push). Needs a push backend + subscription storage — gate on infra. Additive.
- **files:** `src/hooks/usePriceAlerts.ts` (subscribe), shared push helper (mirror nakamigos).
- **effort:** L
- **risk:** med.
- **test:** n/a until scoped.
- **deps:** []
- **batchHint:** missing-best-in-class

### F498 — ENS resolution + avatar display for addresses
- **verdict:** product-decision
- **severity:** low
- **rootCause:** standalone
- **confirmed absent at HEAD:** Yes. `shortenAddress` is used everywhere; no ENS reverse lookup in treasury/referral/loan surfaces.
- **approach:** If approved: a small `useEnsName`/`useEnsAvatar` (wagmi) wrapper hook used by address-rendering components; cache results. Additive, view-layer.
- **files:** new `src/hooks/useEnsLabel.ts`; address-rendering consumers.
- **effort:** M
- **risk:** low.
- **test:** Mock ENS reverse and assert the name renders, falling back to `shortenAddress`.
- **deps:** []
- **batchHint:** missing-best-in-class

### F499 — Multi-venue smart order routing beyond the single WETH-hop heuristic
- **verdict:** product-decision
- **severity:** low
- **rootCause:** standalone
- **confirmed absent at HEAD:** Yes. `buildPath` (`useSwapQuote.ts:25-36`) only does direct or X-WETH-Y; no split routes, no V3 quoting. (The meta-aggregator partially compensates by querying 7 external aggregators, but the native on-chain path is single-hop.)
- **approach:** Owner decision — split routing / V3 quoting is a large build and arguably redundant with the aggregator leg. Recommend relying on the aggregator layer (already present) rather than reimplementing routing. If pursued, copy from a battle-tested router SDK rather than custom path-finding (minimal-surface mandate).
- **files:** `src/hooks/useSwapQuote.ts` (path building) — only if approved.
- **effort:** L
- **risk:** high (custom routing math is an exploit surface).
- **test:** n/a until scoped.
- **deps:** []
- **batchHint:** missing-best-in-class

### F500 — EIP-5792 one-click approve+swap/stake
- **verdict:** product-decision
- **severity:** low
- **rootCause:** standalone
- **confirmed absent at HEAD:** Yes. `eip5792.ts` exists (foundation, dated 2026-06-01) but is consumed only by `eip5792.test.ts` — no money path batches calls. This is the explicit Tier-1 roadmap item from `project_2026_06_01_user_value_research`.
- **approach:** If approved: wire the EIP-5792 `sendCalls` batch into the approve→swap path in `useSwap` (and approve→stake in `useFarmActions`), feature-detecting wallet support and falling back to the current two-tx flow. This also retires the F487 "unwired EIP-5792" note.
- **files:** `src/hooks/useSwap.ts`, `src/hooks/useFarmActions.ts`, `src/lib/eip5792.ts` (consume).
- **effort:** L
- **risk:** med — must fall back cleanly on wallets without 5792.
- **test:** Mock a 5792-capable connector and assert a single batched call; mock a legacy connector and assert the two-tx fallback.
- **deps:** [F463] (wire batching onto the corrected approve+swap spender)
- **batchHint:** missing-best-in-class

### F501 — Gas cost estimate in the swap confirm row
- **verdict:** product-decision
- **severity:** low
- **rootCause:** standalone
- **confirmed absent at HEAD:** Yes. Aggregator quotes carry `estimatedGas` (`AggregatorQuote.estimatedGas`, aggregator.ts) that's never surfaced; Uniswap/1inch show "~$x.xx network cost".
- **approach:** If approved (smallest of the missing items): surface `estimatedGas × gasPrice × ETH-USD` in the confirm/route row using the gas estimate already on the quote + the existing ETH-USD price. View-layer, additive. Pairs naturally with F492.
- **files:** TradePage confirm/route row; optionally thread `estimatedGas` up through `useSwapQuote` return.
- **effort:** M
- **risk:** low.
- **test:** Assert a "~$x network cost" string renders when `estimatedGas` and gas price are available.
- **deps:** []
- **batchHint:** missing-best-in-class

### F502 — Per-wallet scoping for price alerts + CSV export of tx history
- **verdict:** product-decision
- **severity:** low
- **rootCause:** standalone
- **confirmed absent at HEAD:** Partially overlaps F488. Price alerts are device-global today (`usePriceAlerts.ts:15`) — the per-wallet scoping piece is already actioned in F488. The CSV-export affordance for tx history (beyond the validated `txHistory` table) genuinely does not exist.
- **approach:** Per-wallet alert scoping → handled by F488 (mark this half duplicate). CSV export → if approved, add a "Download CSV" button on the history table that serializes the already-validated `TxRecord[]` (no new data path; reuse `parseTxRecords` output). View-layer, additive.
- **files:** history page/table component (CSV button); `usePriceAlerts.ts` scoping is in F488.
- **effort:** M
- **risk:** low.
- **test:** Assert the CSV button produces a blob with the visible rows.
- **deps:** [F488] (the alert-scoping half is delivered there)
- **batchHint:** missing-best-in-class

---

## Operator notes (not code)
- **F469 / F468:** Supply the real `RELAUNCH_DEPLOY_BLOCK` (DeployMVP broadcast block, ~2026-06-06) and the `TEGRIDY_LP_CREATED_AT` (pair first-mint block/timestamp) so the getLogs scans and pool-age math use chain truth. Interim hardcodes (relaunch date / known block) unblock the code fixes.
- **F489:** Curl-verify the three public RPCs; swap Ankr if it now requires a key.
- **F490:** Lands in the pages-surface PR (cross-surface), not this lib PR.
- **F496 / F495 / F497:** Gated on operator infra (indexer, server keeper, push backend) — frontend becomes a consumer once those exist.
