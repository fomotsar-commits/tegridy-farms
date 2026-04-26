# Agent 021 — POLAccumulator.sol Forensic Audit

**Target**: `contracts/src/POLAccumulator.sol` (522 lines, solc ^0.8.26)
**Inheritance**: OwnableNoRenounce, ReentrancyGuard, Pausable, TimelockAdmin
**Cross-checked tests**: POLAccumulator.t.sol, Audit195_POL.t.sol, FinalAudit_POLPremium.t.sol, RedTeam_POLPremium.t.sol

---

## HIGH

### H-1 Sandwich on `accumulate()` — slippage floor is computed from spot, not oracle/TWAP
**Location**: lines 257–295 (the `accumulate` body)
**Vector**: sandwich on autoLP add (and the swap leg).

The contract computes `slippageMin*` and `backstopMin*` from the **outputs of the same pool transaction** (`toweliAmount` returned by `swapExactETHForTokens`, and `remainingETH`). If an attacker pre-buys TOWELI in the same block to inflate spot price, `swapExactETHForTokens` returns *fewer* TOWELI but the resulting `toweliAmount` still becomes the basis for the LP-add minimums. Because `minToken = max(caller, slippageMinToken, backstopMinToken)` and slippage/backstop are derived from that already-degraded amount, the slippage *floor* automatically degrades with the attack — there is no independent oracle reference.

The comment at lines 224–228 explicitly delegates this to off-chain (caller "MUST use Flashbots Protect" and "set minimums based on TWAP / Chainlink"). However, on-chain there is **no oracle dependency** at all (one of the stated hunt items): `_minTokens`, `_minLPTokens`, `_minLPETH` are caller-provided and may be `1` (tests do this constantly, e.g. `_accumulate(1,1,1,…)`). The only enforced lower bound on `_minTokens` is non-zero (`if (_minTokens == 0) revert SlippageTooHigh()`), which is a security-theatre check.

**Impact**: A malicious or compromised owner key, or even a clueless owner not running Flashbots, can be sandwiched out of meaningful TOWELI per ETH on every accumulate. Cumulative loss scales with `maxAccumulateAmount` (default 10 ETH/hour, capped at 100 ETH).

**Recommendation**: Wire a real on-chain TWAP/oracle floor into `accumulate()` (Uniswap V3 oracle on the TOWELI pair, or Chainlink) and use `max(callerMin, oracleMin, backstopMin)`. Or require `_minTokens` to be ≥ a quoted off-chain Chainlink-signed price.

---

### H-2 `accumulate()` re-uses pool-spot ratio as basis for LP-add minimums (effective 0 % protection for LP step)
**Location**: lines 275–286
The `slippageMinToken` and `slippageMinETH` are computed as `mulDiv(amount, 10000 - maxSlippageBps, 10000)`. With `maxSlippageBps=500` (default 5 %), the LP add tolerates a 5 % deviation **of the just-swapped output**. But because `toweliAmount` is the post-attack figure, an attacker who shifts the pool by 30 % during the swap leg has already "won" — the LP-add will happily proceed using the attacked ratio. The `addLiquidityETH` minimums were intended as a sandwich defence between the swap and add, but they are not anchored to anything attacker-independent.

**Impact**: Same as H-1; this is the LP-add half of the same root cause (no independent reference). The two legs of `accumulate` share state, and the tight 2-minute `MAX_DEADLINE` only narrows the MEV window, not closes it.

**Recommendation**: Pass `_minLPTokens` / `_minLPETH` as **hard requirements derived off-chain from Chainlink TWAP**, and compute the floor independently of `toweliAmount` (e.g., `_minLPTokens >= chainlinkPriceFloor * remainingETH`). Reject LP-add if pool reserves at entry deviate from oracle by > X bps (read reserves directly from `lpToken` (V2 pair) `getReserves()`).

---

## MEDIUM

### M-1 Threshold bypass via direct ETH transfer + multiple `accumulate` calls (cap is per-call, not per-window)
**Location**: lines 70–71, 81, 246–248
`maxAccumulateAmount = 10 ether` (cap), `ACCUMULATE_COOLDOWN = 1 hours`. The 1-hour cooldown is a single mitigation: the per-call cap is only meaningful in conjunction with that cooldown. The hard upper bound `MAX_ACCUMULATE_CAP = 100 ether` and the cooldown together permit 100 ETH/hour, 2400 ETH/day of sandwich-eligible flow at maximum settings — a meaningful drain surface for a compromised owner key combined with a malicious pool.

`FinalAudit_POLPremium.t.sol::test_finding1_accumulateCapBypassMultipleCalls` documents the cooldown fix but does NOT test that successive cooldown-spaced calls each undergo independent slippage scrutiny — they don't, because slippage is per-call.

**Recommendation**: Add a rolling-window throughput cap (e.g., max 30 ETH per 24 h) on top of the per-call cap, or make `ACCUMULATE_COOLDOWN` configurable and start with 4–6 h.

### M-2 `lpToken` is **not validated** to match `(toweli, weth)` pair
**Location**: line 56 (`address public immutable lpToken`), line 145 (constructor)
The constructor only checks `_lpToken != address(0)`. There is no check that `_lpToken` is the actual UniswapV2 pair for `(toweli, weth)`. If the wrong LP address is supplied at deploy:
- `sweepTokens(token != lpToken)` protection still allows TOWELI dust sweeping, but the LP that's actually minted by `addLiquidityETH` is a *different* token from `lpToken`. The "real" LP will be sweepable via `sweepTokens` (since it's not equal to `lpToken`), defeating the "permanent LP" invariant entirely.
- `executeHarvestLP` will `forceApprove(lpToken, …)` and call `removeLiquidityETH` on a token the contract doesn't actually own, reverting harmlessly — but this is silent misconfiguration.

**Recommendation**: In the constructor, require `IUniswapV2Factory(router.factory()).getPair(toweli, weth) == _lpToken`. Or fetch and store it directly.

### M-3 `executeHarvestLP` runs the "ETH not received" sanity check **after** state changes that depend on the hostile router
**Location**: lines 459–479
`router.removeLiquidityETH(...)` is called first, then `address(this).balance - ethBefore >= ethOut` is checked. A malicious or buggy router could lie about `ethOut` while keeping the ETH; the check catches this. **However**, the bookkeeping (`totalLPCreated -= lpAmount`) executes *regardless* of whether the LP was actually consumed by the router. If `removeLiquidityETH` doesn't actually pull the LP (or pulls less), the contract still decrements `totalLPCreated` by the proposed amount. This skews accounting but is not directly exploitable since the router is trusted (immutable).

Also: pendingHarvestLpAmount is zeroed BEFORE the router call (line 455) but AFTER the `_execute` consumed the timelock entry. If the router call reverts, the timelock entry is consumed but the harvest isn't done; owner must repropose with another 30-day delay.

**Recommendation**: Snapshot `IERC20(lpToken).balanceOf(this)` before/after to compute actual LP consumed, and only decrement `totalLPCreated` by the actual delta.

### M-4 `harvestLP` cap is per-proposal, not per-window — can drain 10 % every 30 days indefinitely
**Location**: lines 427–445
`MAX_HARVEST_BPS = 1000` (10 %) of `totalLPCreated`, but `proposeHarvestLP` reads `totalLPCreated` at proposal time. After execute, `totalLPCreated` is reduced by `lpAmount`, then the next proposal can take 10 % of the (smaller) remainder. With `POL_HARVEST_DELAY = 30 days`, a compromised owner can drain ~63 % over 12 months, ~88 % over 24 months. The "permanent LP" claim is therefore policy-bounded, not contract-bounded.

The matching tests do NOT exercise this drain pattern.

**Recommendation**: Add a global lifetime cap (e.g., `totalHarvested ≤ X% of cumulative totalLPCreated`), or make `MAX_HARVEST_BPS` apply to the original (immutable) LP minted, not the running balance.

### M-5 `sweepETH` sequential drain (acknowledged by Finding 3 but flagged INFORMATIONAL)
**Location**: lines 383–402
Same pattern: per-proposal amount with no cumulative cap. With 48 h timelock, all ETH can be drained in N × 48 h. The `treasury` is set in constructor and has its own 48 h timelock to change, but if the multisig holding both `treasury` and `owner` is compromised this is a complete drain in 96 h.

`FinalAudit_POLPremium::test_finding3_sweepETHSequentialDrain` documents this but rates it INFO. Given the ETH-only use case (fees flow in repeatedly), I'd elevate it to MEDIUM.

**Recommendation**: Add a cumulative `sweptETHTotal` and require it ≤ X % of `address(this).balance + sweptETHTotal`.

---

## LOW

### L-1 Receive function emits `ETHReceived` but does not track or rate-limit incoming ETH
**Location**: lines 154–156
ETH from arbitrary senders inflates `address(this).balance`, which becomes the basis for `accumulate`'s 50/50 split. A griefer cannot steal funds, but can dilute the protocol's POL accumulation cadence by spamming dust between cooldowns.

### L-2 `sweepTokens` allows the owner to sweep TOWELI, including pre-`accumulate` dust intentionally seeded
**Location**: lines 500–507
TOWELI is `safeTransfer`d to `treasury` (post-L-08 fix), but a compromised owner *and* compromised treasury can lift TOWELI that arrived via fees. Treasury has 48 h timelock, so two-key compromise.

### L-3 `MIN_BACKSTOP_BPS = 5000` (50 %) is still loose
**Location**: line 68
A 50 % backstop is a wide moat. Combined with caller-provided `_minLPTokens` of 1 (tests do this), an attacker who shifts the pool by 49 % can still pass. Battle-tested defaults for V2 are 95–99 %.

### L-4 `cancelMaxSlippageChange` etc. emit cancelled value AFTER `_cancel` zeroes pendingX
**Location**: lines 177–182, 207–213
Order of operations: `cancelled = pendingMaxSlippage; _cancel(...); pendingMaxSlippage = 0; emit ...(cancelled);` — fine here. But `cancelHarvestLP` (lines 488–492) runs `_cancel` BEFORE setting `pendingHarvestLpAmount = 0` and emitting; not exploitable but inconsistent with sibling cancellers.

### L-5 No explicit `acceptOwnership` test for harvest path
The harvest path requires `onlyOwner`; if multisig accepts ownership during the 30-day proposal window, the original deployer cannot execute. (This is "Finding 9" of FinalAudit_POLPremium.) Worth surfacing in deploy runbook.

---

## INFO

### I-1 `accumulate()` does not check `lpReceived > 0` against `totalLPCreated` invariant
Line 296 has `require(lpReceived > 0, "ZERO_LP_MINTED")`. Good. But there's no check that `lpReceived` is reasonable vs ETH put in (e.g., bounded LP minting check), so a buggy router minting 1 wei of LP for 10 ETH would pass.

### I-2 `tokenUsed` from `addLiquidityETH` is not compared to `toweliAmount`
Line 288: `(uint256 tokenUsed, uint256 ethUsed, uint256 lpReceived) = …`. If `tokenUsed < toweliAmount`, the leftover TOWELI sits in the contract, requiring `sweepTokens` to clean. Forceapprove(0) on line 299 is correct for safety. Not a bug, but worth documenting.

### I-3 No reentrancy concern on `receive()` ETH
`receive()` only emits an event; no state change beyond balance. Combined with `nonReentrant` on `accumulate`/`executeSweepETH`/`sweepTokens`/`executeHarvestLP`, reentrancy surface is closed.

### I-4 Accumulator double-spend on triggered execute — NOT FOUND
Each `_execute(key)` consumes the timelock slot in TimelockAdmin (`delete _executeAfter[key]`). Confirmed not vulnerable to re-execution of the same proposal.

### I-5 Owner rug via sweep — bounded, not absent
- `sweepETH` always goes to `treasury` (line 399, hardcoded `recipient = treasury`).
- `sweepTokens` always goes to `treasury` (line 505).
- `sweepETH` legacy direct call reverts.
- Treasury changes are 48 h timelocked.
- LP token cannot be swept (CANNOT_SWEEP_LP).
The rug surface is bounded by the timelock chain (96 h for full setup of malicious treasury + sweep) and constrained to existing treasury — meaningful protection for normal multisig key rotation.

### I-6 Rounding is consistently floor (favors protocol on minimums)
`Math.mulDiv` defaults to floor. Slippage floors are floored (correct: `slippageMin <= expected`). Backstop floors are floored (correct). No rounding that favors caller / extractor identified.

### I-7 Threshold bypass via direct transfer — partially exploitable
Direct ETH transfer + `accumulate()` works as designed. A flash-loan attacker cannot acquire the `onlyOwner` role, so the threshold is functionally `onlyOwner` not "anyone with ETH". The threshold bypass risk is therefore confined to compromised-owner scenarios (already addressed).

---

## TEST GAPS

The 4 cross-checked test files do NOT cover:
1. **Oracle-anchored slippage**: zero tests use a mock pool that mutates reserves between swap and addLiquidity to validate the LP-add slippage actually catches a real sandwich. All mock routers return fixed `1000 TOWELI/ETH` rates and accept arbitrary mins.
2. **Constructor LP-pair validation**: no test deploys with a wrong `_lpToken` to demonstrate misconfiguration consequences.
3. **`executeHarvestLP` with hostile router**: no test where router lies about `ethOut` (should hit the `ETH_NOT_RECEIVED` revert, but accounting consequences are untested).
4. **Cumulative harvest drain**: no test of N × 30-day harvests showing the lifetime drain capacity.
5. **Cumulative `sweepETH` drain over multiple proposals beyond 3 rounds**: Finding 3 only goes 3 rounds.
6. **Backstop boundary at 50 %** combined with attacker-controlled pool ratio (only happy-path tested).
7. **`receive()` reentrancy**: no test of an ERC777-style or hostile sender attempting reentry during ETH receipt (defended by lack of state mutation, but untested).
8. **`pendingHarvestLpAmount` partial fill**: no test where router consumes < `lpAmount` of LP and the bookkeeping desyncs.
9. **`tokenUsed < toweliAmount` LP partial fill**: no leftover-TOWELI accounting test.
10. **Race between `transferOwnership` + `acceptOwnership` and pending timelocked proposals on the harvest/treasury paths.**

---

## SUMMARY

- HIGH: 2 (sandwich/oracle-absent on swap + LP-add)
- MEDIUM: 5 (cap-per-call vs window, lpToken unvalidated, harvest accounting on hostile router, harvest cumulative drain, sweepETH cumulative drain)
- LOW: 5
- INFO: 7
- Test gaps: 10

The contract is well-defended at the level of access control, reentrancy, and timelock surface. The structural weakness is **no on-chain reference price** for sandwich protection on `accumulate()`; security relies entirely on owner discipline (Flashbots Protect + correct off-chain min calcs). For a "self-reinforcing flywheel" claim, this is a sustained leak surface.
