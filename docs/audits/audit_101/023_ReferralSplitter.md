# Audit 023 — ReferralSplitter.sol (AUDIT-ONLY)

Agent 023 / 101-agent forensic audit
Target: `contracts/src/ReferralSplitter.sol`
Cross-checked: `contracts/test/ReferralSplitter.t.sol`, `contracts/test/Audit195_Referral.t.sol`

## Threat surface scanned
referrer self-referral, sybil rings, claim race, fee-on-transfer reward token underpay,
owner referrer-cap bypass, signature replay on attribution, frontend tampering via referral
param trust, accounting drift between referrer and referee, payout DoS via blocklisted
recipient, gas grief on enumeration.

---

## HIGH — none

No HIGH-severity exploitable issues found. The contract is well-hardened: stake-gating
on EARN side (`MIN_REFERRAL_STAKE_POWER`), pull-pattern for treasury, callerCredit, and
ETH transfers, WETHFallbackLib for revert-on-receive recipients, try/catch around
external staking calls, nonReentrant + CEI throughout, timelocked admin parameter
changes, and a permanent setup-lock (`completeSetup`) that disables the instant caller
grant.

The "permanent referrer linking" + on-chain-only `referrerOf[msg.sender]` write means
no off-chain signature attribution exists, so signature replay and frontend referral
parameter spoofing are structurally not in scope (everything is `msg.sender`-gated).
Fee-on-transfer reward tokens are not in scope — the contract is ETH/WETH only.
Owner referrer-cap is not implemented (no per-referrer earnings cap exists by design)
so "cap bypass" is N/A.

---

## MEDIUM

### M-01 — `updateReferrer` cooldown bypass on FIRST update (mainnet timestamps)
**Location:** `setReferrer` (lines 171-185), `updateReferrer` (lines 189-211).

`setReferrer` permanently writes `referrerOf[msg.sender]` but **never initializes
`lastReferrerChange[msg.sender]`**. `updateReferrer` checks:

```
if (block.timestamp < lastReferrerChange[msg.sender] + REFERRER_COOLDOWN) revert CooldownNotElapsed();
```

On mainnet `block.timestamp ≈ 1.7e9` while the default `lastReferrerChange[msg.sender] = 0`,
so `1.7e9 < 0 + 30 days (≈ 2.59e6)` is **FALSE** — the cooldown does not engage on the
first `updateReferrer` call. A user can call `setReferrer(bob)` then immediately call
`updateReferrer(carol)` in the next block.

The 30-day cooldown is only honoured on the SECOND and subsequent updates because
`updateReferrer` does set `lastReferrerChange[msg.sender] = block.timestamp` at line 201.

**Why this matters:**
The cooldown's stated purpose is to make referrer-rotation costly so that users cannot
easily flip their referrer to game cross-protocol referral campaigns. Bypassing it on
the first update halves the effective control. Combined with the existing 25-deep
sybil-ring tolerance for `_checkCircularReferral`, an attacker can rotate from a
non-staked referrer (no fees credited) to a staked attacker-controlled referrer the
moment juicy fees are about to be recorded — defeating the design.

**Tests deceive themselves:** Foundry's default `block.timestamp` is `1`, so warping
`+15 days` produces `1 + 15 days < 30 days = TRUE`, and the existing tests
(`test_revert_updateReferrer_cooldownNotElapsed`) pass even though the production
guard is dead. This is exactly the kind of bug a forge-in-isolation suite hides.

**Fix:** initialize `lastReferrerChange[msg.sender] = block.timestamp` inside
`setReferrer`, OR check `lastReferrerChange[msg.sender] != 0` separately and treat
unset as "set during setReferrer," OR replace the check with
`block.timestamp - lastReferrerChange[msg.sender] < COOLDOWN` (still fails because of
underflow guard semantics on uint), OR record `referrerSetAt[msg.sender] = block.timestamp`
in `setReferrer` and use `max(referrerSetAt, lastReferrerChange)` as the cooldown anchor.

The cleanest patch:

```solidity
function setReferrer(address _referrer) external {
    ...
    referrerOf[msg.sender] = _referrer;
    lastReferrerChange[msg.sender] = block.timestamp;   // ← NEW
    totalReferred[_referrer] += 1;
    ...
}
```

### M-02 — Sybil ring deeper than `CIRCULAR_DEPTH=25` is documented-but-unbounded
**Location:** `_checkCircularReferral` (lines 224-231).

`Audit195_Referral.t.sol::test_circularReferral_beyondDepth_notDetected` explicitly
acknowledges that a 27-deep cycle bypasses detection. The trade-off (gas-bounded walk
vs. attacker coordination cost) is reasonable, but two items are missing:

1. The accepted residual risk is not surfaced to integrators / frontends — there is no
   `getReferralChainDepth(address)` view that would let a UI flag suspicious deep
   referral structures.
2. Since `MIN_REFERRAL_STAKE_POWER = 1000e18` (1000 TOWELI-equivalent voting power) is
   the only economic gate, an attacker who controls 1000+ TOWELI of voting power and
   26+ EOAs *can* construct a self-cycle by chaining N intermediate sybils, then
   self-refer back to the staked address. The economic damage per fee is bounded
   (10% of own swap fees), but the UI may misreport the network as legitimate.

**Recommendation (LOW-cost):** add a view `function maxResolvableDepth() external pure returns (uint256) { return CIRCULAR_DEPTH; }` and have the frontend warn when a chain exceeds it, OR raise depth to 50 on the next major version (gas budget is still well within 100k).

### M-03 — `recordFee` accounting drift on forfeiture
**Location:** `forfeitUnclaimedRewards` (lines 475-500).

`forfeitUnclaimedRewards` decrements `totalPendingETH` correctly but does **not**
decrement `totalEarned[referrer]` or `totalReferralsPaid`. After forfeiture:

* `totalEarned[bob]` still shows the forfeited amount as "earned by bob"
* `totalReferralsPaid` still shows the forfeited amount as "paid out to referrers"

Both are advertised by `getReferralInfo` (line 539-543) and presumably consumed by
the frontend leaderboard. The drift is one-way (always overstates) and per-referrer
identifiable, so it is not a fund-safety issue but it WILL produce a UX bug:
"Bob earned 5 ETH lifetime" while bob received 0 (forfeited).

`pendingETH[_referrer]` is correctly zeroed (line 493), so claims will not double-pay.
The drift is purely cosmetic, but stakeholders comparing on-chain telemetry to UI
numbers will notice the discrepancy.

**Fix:** decrement `totalEarned[_referrer] -= amount;` and `totalReferralsPaid -= amount;`
in `forfeitUnclaimedRewards`. (Or rename `totalEarned` to `lifetimeCredited` for clarity.)

### M-04 — `markBelowStake` is callable by anyone, but does NOT auto-reset the "above stake" timer
**Location:** `markBelowStake` (lines 450-468).

The function permits permission-less marking, which is good (cheap keepers can drive
forfeiture). However, the reset path (`if (power >= MIN_REFERRAL_STAKE_POWER) lastBelowStakeTime[_referrer] = 0`)
ONLY fires when someone actually CALLS `markBelowStake(_referrer)` while bob is
above threshold. If bob restakes silently, no one calls markBelowStake, and 7+ days
later the owner calls `forfeitUnclaimedRewards(bob)`:

* `forfeitUnclaimedRewards` (line 481-485) re-checks `votingPowerOf(_referrer)` — it
  reverts if bob is above threshold, so funds are safe.

Defense-in-depth saves the day, but the design surface is fragile: a future refactor
that drops the second stake check inside `forfeitUnclaimedRewards` would expose users.
**Recommend** adding a comment on `markBelowStake` that "the timer reset is a
courtesy; the authoritative stake check happens at forfeitUnclaimedRewards-time" so
the invariant is documented for future maintainers. This is informational borderline
LOW; classified MEDIUM only because two future contributors making conflicting
assumptions could erase the safety net.

### M-05 — Approved-caller withdrawal of `callerCredit` keeps fee remainder OFF-protocol
**Location:** `recordFee` lines 252-258, `withdrawCallerCredit` lines 294-302.

When a non-zero referral fee is computed, the **non-referral remainder** is credited
to `callerCredit[msg.sender]` and pulled by the caller via `withdrawCallerCredit`.
By design the caller is `SwapFeeRouter` (or similar) that should forward the remainder
to whatever next-hop treasury / LP rewards stream. But:

1. The contract does NOT enforce that the caller redirects the remainder. A
   compromised approved caller can drain 90% of every recorded fee to itself.
2. `withdrawCallerCredit` has no per-block / per-caller rate limit and no event-based
   off-chain alarm (only `CallerCreditPaidWETH` is emitted, which is informational).

If a downstream caller is compromised (private key leak, governance takeover of the
caller contract), the caller can sweep up to 90% of every fee that has been recorded
since the last withdraw — across an arbitrarily long window, without any timelock.

**Mitigation in place:** owner-only approval list; `revokeApprovedCaller` is instant;
operational controls outside this contract gate the risk.

**Recommendation:** at minimum, emit indexed `(uint256 amount, uint256 newPendingTotal)`
on `withdrawCallerCredit` so off-chain monitors can alert on anomalous burst
withdrawals. Not strictly a vulnerability of THIS contract (the caller is
out-of-scope), but the trust assumption deserves a SECURITY.md callout.

---

## LOW

### L-01 — `recordFee` uses string `require("ZERO_USER")` while the rest uses custom errors
**Location:** line 241.

Inconsistency only — gas is marginally higher and tests must match the string exactly.
Replace with `if (_user == address(0)) revert ZeroAddress();`.

### L-02 — `proposeReferralFee` zero-check uses `require("FEE_CANNOT_BE_ZERO")`
**Location:** line 397.

Same inconsistency. Add a custom error e.g. `error ZeroFee();` and revert with it.

### L-03 — `referrerRegisteredAt` is permanent — once set, "MIN_REFERRAL_AGE" never resets
**Location:** `setReferrer` line 180, `updateReferrer` line 207, `claimReferralRewards` line 313.

If bob has been a referrer for >7 days at any point in history, ALL future fee
credits to bob are claimable in the same block they are credited (the 7-day
`MIN_REFERRAL_AGE` is not per-fee, it is per-referrer-lifetime). This is consistent
with the comment in claimReferralRewards (Curve/Convex pattern) and is by design,
but it means the "delay attackers from quick-in-quick-out" intent only applies to
brand-new sybil referrers.

A staked attacker who registers their first referrer at protocol launch waits 7 days
once and then has zero claim delay forever. Documenting this is sufficient.

### L-04 — `setReferrer` does not record a `referrerSetAt[msg.sender]` timestamp
**Location:** `setReferrer` lines 171-185.

The contract tracks `referrerRegisteredAt` (per referrer) and
`lastReferrerChange[msg.sender]` (per referee, only on update), but no per-referee
"first-set" timestamp. This is the proximate cause of M-01 and a missed opportunity
for off-chain analytics ("how old is alice's referral relationship?").
Adding `mapping(address => uint256) public refereeSetAt` and writing it in
`setReferrer` (and reading it in `updateReferrer`'s cooldown) closes M-01 elegantly.

### L-05 — `forfeitUnclaimedRewards` does not emit referral-relationship break events
**Location:** lines 475-500.

The function emits `RewardsForfeited(referrer, amount)` but does not emit a
companion event when the staking-revert path is taken (line 481-485 catches and
treats as below-stake). Off-chain monitors cannot distinguish "actually below
stake" vs. "staking contract was reverting." Consider emitting a sub-event or
adding a `(bool stakingResponsive)` parameter to `RewardsForfeited`.

### L-06 — `_checkCircularReferral` does not include `_referrer == _user` early-out
**Location:** lines 224-231.

The walk starts with `current = _referrer; for (...) { current = referrerOf[current]; ... }`.
The first iteration *jumps* past `_referrer` immediately, so a self-cycle of length-1
(`_referrer == _user`) is caught by the existing `if (_referrer == msg.sender) revert SelfReferral()` check earlier. But if a future refactor allows third-party setting,
the walk would silently miss `_referrer == _user`. Trivial fix:

```solidity
function _checkCircularReferral(address _referrer, address _user) internal view {
    if (_referrer == _user) revert CircularReferral();   // ← NEW
    address current = _referrer;
    for (uint256 i = 0; i < CIRCULAR_DEPTH; i++) { ... }
}
```

This is robustness-only and not exploitable today.

### L-07 — `proposeApprovedCaller` does not check `setupComplete` before proposing
**Location:** lines 351-360.

During the initial setup window (before `completeSetup()`), the owner can use BOTH
the instant `setApprovedCaller` and the timelocked `proposeApprovedCaller`. The
timelocked path "wastes" a 24h delay needlessly during setup. Not a bug, but adding
`require(setupComplete, "USE_INSTANT_DURING_SETUP")` would prevent operator
confusion. Marginal.

---

## INFO

### I-01 — `accumulatedTreasuryETH` accumulates referrer-share even when user has no referrer
**Location:** `recordFee` lines 244-277.

When `referrerOf[_user] == address(0)` and `referralFeeBps > 0`, the 10%
"would-have-been-referrer-share" accumulates to the treasury. This is consistent
with the SECURITY FIX comment but means the protocol effectively takes a 10% tax on
ALL recorded fees regardless of referral status. UX implication only; intentional.

### I-02 — `sweepUnclaimable` is owner-only but has no timelock
**Location:** lines 518-530.

Sweeping non-reserved ETH to treasury is an owner-only function. The reserved
calculation is sound (totalPendingETH + accumulatedTreasuryETH + totalCallerCredit),
so funds in the pull-pattern paths are protected. Risk is bounded to "ETH that
arrived via raw transfer (selfdestruct, coinbase rewards, mistakes)." Acceptable.

### I-03 — Referrer must be a valid `OwnableNoRenounce` recipient via WETH fallback
**Location:** `claimReferralRewards` line 322, `withdrawCallerCredit` line 300.

`WETHFallbackLib.safeTransferETHOrWrap` handles revert-on-receive contracts by
wrapping to WETH. Requires the WETH contract address to be valid and the WETH
deposit to succeed. Mock tests cover this. Real-world WETH-9 cannot block deposits,
so the fallback is robust.

### I-04 — `OwnableNoRenounce` and `TimelockAdmin` inheritance ordering
**Location:** line 30.

`is OwnableNoRenounce, ReentrancyGuard, TimelockAdmin` — TimelockAdmin's `_executeAfter`
mapping is correctly accessed via internal storage. No Solidity linearization
issues. (Verified by file presence and existing test coverage of timelock paths in
`Audit195_Referral.t.sol`.)

### I-05 — `MIN_REFERRAL_STAKE_POWER` is hard-coded at `1000e18`
**Location:** line 41.

If TOWELI's voting-power decimals change, or if the project introduces a non-1:1
voting-power-to-token relationship, this constant becomes stale. Currently
acceptable because TOWELI uses 18 decimals; document the dependency.

---

## Test gaps

1. **`test_setReferrer_thenUpdateImmediately_onMainnetTimestamp`** — fork at a real
   block (`block.timestamp ≈ 1.7e9`) or `vm.warp(1.7e9); setReferrer(bob); updateReferrer(carol)`
   and assert that the FIRST update fails. CURRENTLY this would PASS with no revert,
   demonstrating M-01.

2. **`test_forfeit_doesNotZeroTotalEarned`** — assert M-03 drift, then either fix
   the contract or update tests to acknowledge intentional drift.

3. **`test_circularReferral_atDepth26_27_50`** — the existing `chainLen = 27` test
   asserts the 27-deep cycle is NOT detected. Add asserts for `chainLen ∈ {26, 50, 100}`
   to confirm `CIRCULAR_DEPTH=25` is the firm boundary and characterise gas costs.

4. **`test_sybilRing_economicBenefit_isBounded`** — fuzz `N` sybil EOAs each
   referring to one staked attacker, sum recorded fees, assert that the attacker's
   net gain ≤ N × per-sybil-fee × 10%, i.e. linear in legitimate volume.

5. **`test_recordFee_callerKeepsRemainder_isAcceptable`** — explicit assertion that
   the design allows a malicious approved caller to keep up to 90% of recorded fees
   (M-05). Documents the trust boundary as a property test.

6. **`test_markBelowStake_silentlyStaleTimer_doesNotEnableForfeit`** — bob restakes
   without anyone calling `markBelowStake`, owner calls `forfeitUnclaimedRewards`,
   assert revert because the in-function recheck at line 481 saves the user.

7. **`test_withdrawCallerCredit_emitsIndexedAmount`** — assert observability for
   off-chain monitoring (M-05 mitigation).

8. **`test_setReferrer_chainOfContracts`** — referrer is a contract that holds stake
   via a wrapper. Confirms WETH fallback path covers all referrer-as-contract cases.

9. **`test_recordFee_zeroFee_butPriorAccumulationDoesNotDrain`** — set referralFeeBps
   to its minimum (1), record many tiny fees, assert dust accumulation does not
   leak through any of the three reserved buckets.

10. **`test_invariant_balance_eq_reserved_plus_swept`** — after a long random
    sequence of recordFee/claim/withdrawCredit/sweepUnclaimable/forfeit calls,
    `balance(this) + sumOf(claimed + withdrawn + swept + forfeit_to_treasury) ==
    sumOf(recordFee.msg.value)`. A true invariant test (foundry `invariant_*`).

---

## Summary

* HIGH: 0
* MEDIUM: 5 (M-01 cooldown bypass, M-02 sybil-depth residual, M-03 forfeit drift,
  M-04 markBelowStake fragility, M-05 caller-remainder trust)
* LOW: 7
* INFO: 5
* Test gaps: 10

The contract is well-engineered with strong defense-in-depth. The single most
important fix is **M-01** — a real, exploitable cooldown bypass that the existing
test suite cannot catch because of Foundry's default tiny `block.timestamp`.
