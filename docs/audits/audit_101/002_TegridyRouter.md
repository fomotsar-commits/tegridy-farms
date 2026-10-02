# Audit 002 — TegridyRouter.sol

Auditor: Agent 002 / 101
Target: contracts/src/TegridyRouter.sol (511 lines)
Cross-checked: contracts/test/TegridyRouter.t.sol, contracts/test/Audit195_Router.t.sol
Mode: AUDIT-ONLY (no source edits)

---

## Severity counts
- HIGH: 0
- MEDIUM: 3
- LOW: 6
- INFO: 5

---

## HIGH

(none)

---

## MEDIUM

### M-1. `to == address(this)` (router) is not blocked on any swap or removeLiquidity path
File: contracts/src/TegridyRouter.sol
Lines: 164, 181, 199, 232, 249, 269, 299, 316, 337, 137

Every public swap and `removeLiquidityETH` validates `to != address(0)` and `to != _pairFor(...last hop)`, but never `to != address(this)`. A user that mistakenly (or maliciously) supplies `to = router`:

- For `swapExactTokensForTokens` / `swapTokensForExactTokens`: `_swap(..., _to = router)` ends with `TegridyPair.swap(..., to = router)`. Pair only blocks `to == token0/token1` (TegridyPair.sol:200) — router is neither. **Output tokens are deposited to the router and become permanently stuck** (no general sweep). Any subsequent `*SupportingFeeOnTransferTokens` swap that uses `path[length-1] == sameToken` and recipient that ends up reading `balanceOf(to)` is unaffected (recipient is the user, not the router), but:
- For `swapExactTokensForETH` / `swapTokensForExactETH` / variants — these always force `_to = address(this)` internally, then `IWETH.withdraw(...)` and `WETHFallbackLib.safeTransferETHOrWrap(WETH, user_to, ...)`. If a user passes `to = router`, the fallback library re-wraps to WETH (router's `receive()` rejects non-WETH). Router accumulates WETH, which is **drainable through a future `swapExactTokensForETHSupportingFeeOnTransferTokens` call by another user** if and only if the next caller's `to` is the router — bounded but a dust trap.

Sketch: Frontend bug or aggregator misroute → router collects token X. No recovery function exists. Treasury cannot rescue.

Recommendation: Add `if (to == address(this)) revert InvalidRecipient();` to all 9 public swap entry-points and to `removeLiquidity`/`removeLiquidityETH`.

### M-2. `swapExactTokensForTokens` does not enforce `path[0] != path[path.length-1]`
File: contracts/src/TegridyRouter.sol
Lines: 161-177, 229-244

`_validatePathNoCycles` only catches when **the same pair address** appears twice in the path. For an indirect cycle (e.g. A→B→C→A through three distinct pairs), the cycle check passes. The user ends up with the same token they started with, minus 3×0.3% fees. While arguably a user-foot-shoot, an adversarial frontend or aggregator path-builder can use this to silently extract value — multi-pair cycles remain valid swaps if no two consecutive hops share a pair.

Sketch: Adversarial dApp builds a 3-hop path A→B→C→A. User sees expected output (A again), so slippage check (`amountOutMin`) passes if set loose. Router executes. User loses ~0.9% to fees, dApp/operator profits via referrer/MEV.

Recommendation: Add `require(path[0] != path[path.length - 1], "CIRCULAR_PATH")` to all token-to-token entry points (still allow it on routes that explicitly hit WETH at both ends, but those are blocked separately by the WETH endpoint guards).

### M-3. `_pairFor` performs **two** STATICCALLs to factory per hop — gas griefing surface for long-path swaps + governance race window
File: contracts/src/TegridyRouter.sol
Lines: 452-456, 168, 174, 186, 192, 204, 208, 236, 241, 254, 259, 274, 280, 303, 305, 321, 325, 342, 344, 362, 374, 395, 408

`_pairFor` calls `factory.getPair(...)` AND `factory.disabledPairs(pair)` — two staticcalls per invocation. For a 10-hop swap with `_validatePathNoCycles` (10 calls), `getAmountsOut` (10 calls), and `_swap` (10 calls), that's **60 staticcalls** to the factory. Worse, the lookup is performed redundantly multiple times for the same hop within a single transaction.

Two concrete impacts:
1. **Gas:** ~30k extra gas per redundant call. A 10-hop swap pays ~600k gas just for repeated lookups.
2. **Race:** Between `getAmountsOut` and `_swap`, a guardian could `disablePair` (instant, see TegridyFactory). The pre-computed amounts then refer to a now-disabled pair, but `_pairFor` will also revert correctly inside `_swap`. **Asymmetric:** the user's frontrun txn will revert mid-execution, possibly after `safeTransferFrom` already moved tokens to the first pair. (Actually: line 174 first `safeTransferFrom`s into `_pairFor(path[0], path[1])`, then `_swap` re-fetches — if the first pair gets disabled in between, _pairFor reverts, but user's tokens are already in the pair. A skim by anyone could then drain those tokens.)

Sketch: User submits 5-hop swap. Mempool observer sees it. Guardian disables `pair_2` between user's tx and inclusion. User's tokens land in `pair_1` (transferFrom succeeded). `_pairFor(path[1], path[2])` reverts inside `_swap`. Tokens are stuck in `pair_1`. Anyone can call `pair_1.skim(self)` to seize them.

Recommendation: Cache pair addresses **once** at the start of each public swap, before any safeTransferFrom. Reuse cached addresses through `_swap`/`_validatePathNoCycles`/`getAmountsOut`. Also: don't transfer tokens to pair_1 until **after** all pairs in the path are validated (currently fixed only for cycle check).

---

## LOW

### L-1. `swapExactETHForTokens` does not refund excess ETH (by-design but undocumented)
File: contracts/src/TegridyRouter.sol
Lines: 179-194

Unlike `swapETHForExactTokens` (line 284 — refunds), `swapExactETHForTokens` consumes the full `msg.value`. If a user accidentally over-funds, the excess is swapped to the output token, not refunded. Audit195_Router.t.sol Finding 2 acknowledges this; it's by-design but likely surprises naive callers. Test `test_Finding2_swapExactETHForTokens_AllMsgValueConsumed` documents this. Worth a NatSpec note on the function.

### L-2. `MAX_DEADLINE = 2 hours` may still be aggressive for L2 reorgs / cross-chain paths
File: contracts/src/TegridyRouter.sol
Line: 40, 47-50

Comment cites "raised from 30 minutes to 2 hours". On an Optimism / Base chain reorg, deadlines >2h are blocked. Some flashbots-style aggregators batch up to 24h. Not a bug, but a UX/integration limit.

### L-3. Even-step exact-output swap math accumulates `+1` rounding bias against user
File: contracts/src/TegridyRouter.sol
Lines: 475-482

`_getAmountIn` adds `+1` to round up. For an N-hop exact-output swap, this compounds N times — user pays up to N wei extra. For high-decimal tokens (e.g. WBTC with 8 decimals), this is sub-dust. For low-decimal tokens or N=10, this is up to 10 wei. Negligible economically but worth a note.

### L-4. `removeLiquidity` (non-ETH variant) does not validate `to != address(0)`
File: contracts/src/TegridyRouter.sol
Lines: 115-130

Unlike `removeLiquidityETH` (line 138 — `require(to != address(0), "ZERO_TO")`), the plain `removeLiquidity` only blocks `to != pair`. Sending `to = address(0)` results in `TegridyPair.burn(address(0))` — the pair's `safeTransfer(0x0, ...)` will then revert in OZ's SafeERC20 (good), but the revert message is opaque. Cosmetic, but inconsistent.

### L-5. `WETHFallbackLib`'s 10000-gas stipend rejects most contract recipients on the happy path
File: contracts/src/lib/WETHFallbackLib.sol:46
Used at: TegridyRouter.sol:111, 156, 212, 263, 288, 350

A 10000-gas budget barely covers an empty `receive()`; any contract with a non-trivial `receive()` (e.g., emitting an event with one indexed param ≈ 1500 gas + storage cost) falls through to WETH wrap. Net effect: contract recipients always get WETH, never ETH. This is not exploitable but reduces UX for legitimate contract callers (treasuries, relayer contracts).

### L-6. `getAmountsOut` / `getAmountsIn` view functions silently revert on `path.length > 10` AFTER allocating arrays
File: contracts/src/TegridyRouter.sol
Lines: 356-378

Bounds check happens at line 358/370 *after* `if (path.length < 2)` — fine — but `new uint256[](path.length)` is still allocated before the loop reverts on the first nonexistent pair. Minor gas waste; not a vuln.

---

## INFO

### I-1. `_swap` removed cycle check but relies on caller invoking `_validatePathNoCycles` first
File: contracts/src/TegridyRouter.sol:410, 429

Comment "NOTE: Cycle check removed — callers validate via _validatePathNoCycles before transfer". This is correct **only because** `_swap` is `internal` and every caller does call `_validatePathNoCycles`. If a future change makes `_swap` public or adds a new caller that forgets the validation, cyclic paths would silently work. Add a `private` qualifier or an internal sentinel to enforce.

### I-2. `_calculateLiquidity` uses `quote()` which can round to 0 for extreme reserve ratios
File: contracts/src/TegridyRouter.sol:498-499

Verified by Audit195_Router.t.sol Finding 3. Eventual `TegridyPair.mint` reverts with `INSUFFICIENT_LIQUIDITY_MINTED`, so user funds aren't lost — they revert. Acceptable.

### I-3. Comment H-07 about FoT incompatibility with exact-output is correct
File: contracts/src/TegridyRouter.sol:217-227

The comment is accurate: exact-output flows compute via nominal reserves, not actual fee-deducted balances. FoT users *must* use SupportingFeeOnTransferTokens variants. Documented.

### I-4. `_swapSupportingFeeOnTransferTokens` reads `IERC20(input).balanceOf(pair)` which is susceptible to direct-transfer manipulation between hops in a single tx, but only by the same caller / inside the same nonReentrant scope
File: contracts/src/TegridyRouter.sol:439

Since the router is `nonReentrant` and the pair is `nonReentrant`, no external party can inject tokens between hops within one tx. Donation attacks would have to land in a different tx, which doesn't help an attacker. Safe.

### I-5. `receive()` only accepts ETH from WETH — correct
File: contracts/src/TegridyRouter.sol:61-63

Prevents random ETH from being trapped. Standard pattern.

---

## Test gaps (cross-checked against TegridyRouter.t.sol + Audit195_Router.t.sol)

Branches **not** covered by either test file:

1. **No test for `to == address(router)` in any swap or removeLiquidity** — confirms M-1 is unguarded *and* untested.
2. **No test for indirect cyclic paths (A→B→C→A across 3 distinct pairs)** — confirms M-2.
3. **No test for `swapExactTokensForTokens` with `path[0] == WETH` and `path[length-1] == WETH`** (a WETH-loop) — would silently work today.
4. **No test for redundant factory.getPair / disabledPairs gas overhead at 10 hops.**
5. **No test for the safe-skim race after disablePair lands between transferFrom and _swap (M-3 sketch).**
6. **No test for `removeLiquidity` with `to == address(0)`** (opaque revert).
7. **No test verifying `swapTokensForExactTokens` and FoT are mutually exclusive (only the comment H-07 says so — no on-chain enforcement, no test demonstrating the K revert).**
8. **No test for max path length (10) under `swapExactTokensForTokensSupportingFeeOnTransferTokens`** — only Finding 1 covers length>10.
9. **No test for `WETHFallbackLib.safeTransferETHOrWrap` with a contract whose `receive()` consumes >10000 gas but <30000** — fallback path is reached but the gas-stipend boundary is untested.
10. **No test for skim-after-disable scenario** (Factory race window during multi-hop swap).
11. **No fuzz test for `_getAmountIn` rounding bias accumulation across 10 hops.**
12. **No invariant test asserting `address(router).balance == 0 && router.WETHbalance == 0` after every public function call** — would catch any future regression that traps ETH/WETH.
13. **No test for `addLiquidity` when pair has been disabled between the user's tx submission and execution** — pair guard exists in TegridyPair.mint (M-1 there), but the router-level branch is not exercised.

---

## Summary

Router is reasonably hardened relative to a vanilla UniswapV2 fork: cyclic paths blocked, deadline ceiling, FoT length enforcement (per Audit195 fix), WETH fallback for bricked contract recipients, safeTransferFrom throughout. Three medium issues remain: missing `to != router` guard (M-1, simple add), indirect cycle path (M-2, frontend defense), and gas/race in repeated factory lookups (M-3, refactor to cache pair addresses once per call). No HIGH-severity issues identified; the router relies heavily on TegridyPair's nonReentrant + CEI pattern for reentrancy safety, which appears solid.
