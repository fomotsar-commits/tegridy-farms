# Agent 025 — SwapFeeRouter.sol Forensic Audit

Target: `contracts/src/SwapFeeRouter.sol` (1255 lines)
Tests cross-checked: `SwapFeeRouter.t.sol`, `AuditFixes_SwapFeeRouter.t.sol`, `Audit195_SwapFeeRouter.t.sol`

---

## HIGH

### H-1 — Input-token FoT haircut leaves leaked input dust unaccounted (legacy `swapExactTokensForTokens`)

`swapExactTokensForTokens` (lines 450-492) takes the protocol fee from `actualReceived` (the post-FoT-transferFrom amount), books `fee` against `accumulatedTokenFees[path[0]]`, then approves `amountAfterFee` and calls `router.swapExactTokensForTokens(amountAfterFee, ...)`. With a fee-on-transfer input token, when this contract calls `router.swapExactTokensForTokens(...)` the router will `transferFrom(this, router, amountAfterFee)` and another FoT haircut burns 1% on this leg. The router internally expects `amountAfterFee` worth of liquidity but receives less. In a real Uniswap pair this reverts on the K-invariant; in the mock it silently succeeds and `accumulatedTokenFees[path[0]]` is now BIGGER than the contract's actual on-hand balance for that token (`fee` was booked against pre-FoT amount). `withdrawTokenFees(token)` then transfers `fee` from the contract — which may revert with insufficient balance, OR if the contract has accumulated balance from other swaps, it may drain the OTHER token holders' fee allotment. Audit comment at L745-749 acknowledges this ("legacy variant mis-books fee on input token for FoT") but only documents — does not fix. While users *should* call the FoT variant for FoT tokens, frontends or partner integrations that don't may permanently mis-book the accounting balance.

**Fix:** Add an explicit FoT-input revert path on the legacy variant by comparing `actualReceived` to expected `amountIn`, OR bound `accumulatedTokenFees[path[0]]` to the on-hand contract balance at withdraw time.

### H-2 — `convertTokenFeesToETHFoT` zeroes accounting before sizing the actual swap, can produce a state-balance phantom

Lines 1147-1155: `accumulatedTokenFees[token] = 0` happens BEFORE `swapAmount = amount > actualOnHand ? actualOnHand : amount`. If `actualOnHand < amount` (FoT haircut depleted on-hand below the booked accumulated total), we zero out the full `amount` from accounting but only swap `actualOnHand`. The `(amount - actualOnHand)` excess is permanently lost from the accounting table — but if more FoT swaps happen later that DO produce phantom fee balance via the legacy bug above (H-1), the next `convertTokenFeesToETHFoT` call will believe `amount` matches on-hand and may now over-swap a different token's fee balance. Compounded with H-1, this is a slow drainage vector via FoT-token interaction.

**Fix:** Decrement only `swapAmount` from `accumulatedTokenFees[token]`, not the full `amount`.

### H-3 — `withdrawTokenFees` does not enforce on-hand reservation against pending FoT haircuts

`withdrawTokenFees` (lines 1062-1071) sets `accumulatedTokenFees[token] = 0` then `safeTransfer(treasury, amount)`. For FoT tokens where this contract's on-hand balance is less than `amount` (due to upstream FoT haircuts during accumulation), the `safeTransfer` call will revert and `accumulatedTokenFees[token]` is permanently zeroed (state mutation already happened in this tx, but revert undoes it). However, an attacker who sandwich-converts in between deposits could engineer a state where `accumulatedTokenFees[token] > balanceOf(this)` and then `withdrawTokenFees` permanently bricks for that token. AUDIT NEW-A5 conversion cooldown prevents the rapid sandwich, but does not eliminate the phantom-state risk over longer windows.

**Fix:** `amount = min(accumulatedTokenFees[token], IERC20(token).balanceOf(address(this)))` and decrement only the transferred amount.

---

## MEDIUM

### M-1 — Per-pair fee override key collision with input-token address
`_getEffectiveFeeBps(path[0], user)` uses `path[0]` as the key for `hasPairFeeOverride`. Owner intends to set a per-pair fee but actually sets a per-token-input fee. A user routing through a token configured with a discount on a *different* pool gets the discount on every swap that starts with that token. Documented confusion between "pair" and "token" in event names (`PairFeeUpdated`) and storage names (`pairFeeBps`).

**Fix:** Either rename to `tokenFeeBps`/`hasTokenFeeOverride` for clarity, or change the key to `keccak256(path[0], path[path.length - 1])`.

### M-2 — Slippage bypass on legacy `swapExactETHForTokens` via inner-router check only
Line 377-378: `amounts = router.swapExactETHForTokens{value: amountAfterFee}(amountOutMin, path, to, deadline);` then `if (amounts[amounts.length - 1] < amountOutMin) revert InsufficientOutput();`. The `amountOutMin` flows directly into the inner router AND is double-checked here. But `to` is the user's final recipient — Uniswap delivers tokens to user directly. If a malicious or non-conforming router returns false `amounts` (e.g., reports correct amount but actually sent less to `to`), the slippage check is meaningless. Mitigation: `router` is immutable + trusted Uniswap deployment, so this is informational under normal use — but no balance-diff is performed for this path unlike the FoT variants.

**Fix:** Apply the FoT-style balance-diff measurement (route output to `address(this)`, measure delta, then forward) for consistency. Defence-in-depth.

### M-3 — `distributeFeesToStakers` fee-split rounding can leak wei to treasury when staker share is not 100%
Lines 887-889: `stakerAmount = (amount * stakerShareBps) / BPS; polAmount = (amount * polShareBps) / BPS; treasuryAmount = amount - stakerAmount - polAmount;`. When `stakerShareBps + polShareBps` < BPS, treasury gets the remainder including all rounding dust from both the staker and POL slices. This is by design per the comment, but if governance moves to e.g. 50%/25%/25%, treasury is silently advantaged by the rounding. Drift is negligible per call but compounds across many distributions.

**Fix:** Round `stakerAmount` UP (`(amount * stakerShareBps + BPS - 1) / BPS`) so treasury bears the rounding loss not the gain. OR document explicitly.

### M-4 — Slippage check on `swapExactETHForTokens` post-fee accuracy gap
Line 366-368: `fee = (msg.value * effectiveFee) / BPS; if (fee == 0 && effectiveFee > 0) fee = 1; amountAfterFee = msg.value - fee;`. The minimum-1-wei fee bump means with `msg.value = 1` and `effectiveFee = 1`, fee = 1 wei and `amountAfterFee = 0`. The router is then called with `value: 0` which may revert in some Uniswap deployments OR succeed and return zero-output. The slippage check at 378 then compares `0 < amountOutMin` and reverts, but the fee accumulation at 371 already happened. `Audit195_SwapFeeRouter.t.sol` test at line 192-196 confirms this: `accumulatedETHFees() == 1` for a 1-wei swap, but the user got `0` output. State pollution: 1 wei is accumulated but no real swap happened.

**Fix:** Revert if `amountAfterFee == 0` to prevent wasted-state writes.

### M-5 — `recoverCallerCredit`/`recoverCallerCreditFrom` does not capture `accumulatedETHFees` ordering vs. concurrent swap fee accumulation
`recoverCallerCredit` (lines 1206-1215) reads `balBefore`, calls `referralSplitter.withdrawCallerCredit()` which sends ETH back to `address(this)`, reads `balAfter` and credits `accumulatedETHFees += recovered`. If a malicious splitter reenters via the ETH receive (the `nonReentrant` guard prevents re-entering this contract's nonReentrant functions, but the ETH landing in `receive()` is not blocked), there is no exploitable state since the modifier holds. INFO only.

---

## LOW

### L-1 — `MAX_DEADLINE = 2 hours` hard cap (line 99) prevents partial-fill aggregator integrations
Aggregators / cross-chain bridges often need 24h+ deadline. Documented at L94-99 as deliberate. If the protocol later integrates with OFT bridges, this constant may need to be re-tuned via a (non-existent) timelock.

### L-2 — `_validateNoDuplicates` is O(n²) — at maxPath=10 this is 45 comparisons; cheap, but a 100-path attempt would be quadratic. Already capped at 10.

### L-3 — `swapExactTokensForETH` slippage check at line 434 uses `userAmount < amountOutMin` (strict less). Should be `<=` for safety? No — strict is correct (user accepts exactly amountOutMin). INFO.

### L-4 — Conversion-cooldown grants a single converter the full 1h window per token. If the deployer wants to allow simultaneous conversions for different tokens, that works, but a single token cannot be converted twice in 1h even if a legitimate keeper had legitimate reason. Acceptable trade-off per AUDIT NEW-A5 commentary.

### L-5 — `feeBps == BPS` (100%) is unreachable via constructor (`MAX_FEE_BPS = 100`), so the `AdjustedMinOverflow` branch at line 414 is defensive only. INFO.

### L-6 — `withdrawPendingDistribution` is permissionless (line 1191). A griefer can repeatedly burn gas sweeping zero to clog. Mitigated by `if (amount == 0) revert ZeroAmount()` early-revert. INFO.

---

## INFO

### I-1 — `recoverCallerCredit` uses `require` (line 1207) while every other check uses custom errors. Style inconsistency.

### I-2 — Constants `FEE_CHANGE`, `TREASURY_CHANGE`, etc are computed via `keccak256(...)` but stored as `bytes32 public constant` — wasteful at runtime since these are all string-literal hashes. Forge optimizer handles it, but explicit `bytes32` literals would save on bytecode size.

### I-3 — `pendingDistribution` uses `address` keys but POL accumulator can change via timelock; if a recipient changes, the old recipient may still have a non-zero pending balance that no one calls `withdrawPendingDistribution` for. Documented permissionless drain mitigates, but no auto-reconciliation.

### I-4 — `convertTokenFeesToETH` and `convertTokenFeesToETHFoT` both share the cooldown via `_enforceConversionCooldown`. A user could call FoT first then non-FoT 1h later (2h gap) per token. Intended.

### I-5 — `IUniswapV2Router02.WETH()` is `pure` in interface but actual deploy returns `view`. Mismatch causes no runtime issue (Solidity treats `pure` as upper bound), but is technically wrong for the canonical UniswapV2Router02.

---

## Hunt Results vs Spec

| Hunt category | Result |
|---|---|
| Fee skim differential between routes | **HIGH H-1**: input-FoT path mis-books |
| Slippage tolerance abuse | M-2, M-4 (fee minimum + non-FoT skip of balance-diff) |
| ETH/WETH wrapping bug | Clean — `WETHFallbackLib.safeTransferETHOrWrap` sound; 10k gas stipend correct |
| Multi-hop reentrancy via callback | Clean — all swap entries `nonReentrant`; FoT delta-measurement after external call is safe under reentrancy guard |
| Deadline bypass | Clean — explicit `if (deadline < block.timestamp) revert("DEADLINE_EXPIRED")` at every entry (NEW-A4 fix) |
| Route-spoof to redirect output | Clean — `to == address(this)` rejected; recipient validated; FoT internal router call uses `address(this)` then forwards |
| Internal vs external swap accounting drift | **HIGH H-2, H-3**: FoT haircut depletes on-hand below booked balance |
| Fee-on-transfer underpay | M-2 (legacy variant under-collects when run on FoT tokens) |
| Recipient spoof | Clean — `to == address(0) \|\| to == address(this)` rejected |
| Integer rounding to drain dust | M-3: rounding favours treasury slice |
| Missing nonReentrant on swap entry | Clean — all 6 swap entries guarded |
| Reentrancy via fee-distributor callback | Clean — `distributeFeesToStakers` zeroes `accumulatedETHFees` before external `.call`, gas-bounded to 50k, fail-safe to `pendingDistribution` |

---

## Test Gaps

1. **Missing**: legacy `swapExactTokensForTokens` with FoT input where `actualReceived < amountIn` AND the inner router subsequently fails — accounting state should NOT be corrupted (see H-1).
2. **Missing**: `withdrawTokenFees` when `accumulatedTokenFees[token] > balanceOf(this)` after FoT haircut accumulation — should not zero accounting if transfer reverts.
3. **Missing**: `convertTokenFeesToETHFoT` with `actualOnHand < amount` — verify only `swapAmount` is debited, not full `amount` (see H-2).
4. **Missing**: `distributeFeesToStakers` rounding edge: stakerShareBps + polShareBps < BPS to confirm treasury rounding direction.
5. **Missing**: `swapExactETHForTokens` with `msg.value == 1` and `effectiveFee > 0` — confirm 1-wei state pollution is intentional or revert (M-4).
6. **Missing**: `pairFeeBps` is keyed by `path[0]` not pair — confirm test that "per-pair override" is actually "per-input-token override" via cross-pair routing test.
7. **Missing**: concurrent reentrancy attempt via FoT token's `transfer` hook from one swap function calling into another swap function — `nonReentrant` should prevent (test exists implicitly but not explicit).
8. **Missing**: Auditfixes/Audit195 do not test the `convertTokenFeesToETH` cooldown enforcement in both variants sharing state.
9. **Missing**: Slippage check after fee for FoT variants when `received - fee` underflows (received < fee) — current code does `userAmount = received - fee` which would revert in 0.8.x but no explicit test.
10. **Missing**: `pendingDistribution` accumulation check — verify multiple failed distributions to same recipient compound correctly.

---

## Recommended Priority

1. **H-1, H-2, H-3** (FoT input accounting) — battle-test against real FoT tokens (USDT-fork, SHIB-style burn, reflections).
2. **M-1** (rename pair → token) — non-blocking but documentation-confusing.
3. **M-3** (rounding direction) — consider 1 deploy cycle.
4. **M-4** (1-wei pollution) — easy fix, file separately.
