# Agent 02 — TegridyStaking Boost / Penalty / Lock / JBAC / veTOWELI Math Audit

Target: `contracts/src/TegridyStaking.sol` (~2224 lines)
Lens: integer over/underflow + casts, precision loss in boost, off-by-one time math, JBAC bonus arithmetic, edge cases (0/MAX/balance=0), stale boost on retroactive deposits, partial early-exit penalty rounding, zero-deposit voting, lock-extension/merge math, time-decay boundaries, veTOWELI checkpoint monotonicity.

---

## TL;DR — Math Surface Verdict

The boost arithmetic itself (`calculateBoost`, `_applyNewBoost`, `_chargeExtendFee`, `_splitPenalty`, `_splitExtendFee`, `_settleUnsettled`) is conservatively written with explicit BPS constants, deliberate ceiling rounds where biases would otherwise hurt stakers (M-24 ceil-up), `_safeInt256` cast, and an explicit `BoostOverflow` runtime guard at `_applyNewBoost:2013`. Headroom on `boostBps` (uint16) is solid (max 45000 vs 65535 ceiling).

The vulnerabilities I found are NOT in raw integer math — they're in **state-coupling** between paths that mutate `boostedAmount`, `lockEnd`, `lockDuration`, `hasJbacBoost`, and `rewardDebt` independently:

1. **F-02-K-01 (HIGH):** `getReward`'s autoMaxLock branch silently restores **stale JBAC bonus** on legacy `hasJbacBoost && !jbacDeposited` positions when the lock has just decayed — the `revalidateBoost` `LockExpired` guard is one-way and the autoMaxLock path bypasses it.
2. **F-02-K-02 (MEDIUM):** `_settleRewardsOnTransfer` silently drops the `pending - cappedPending` reward-pool shortfall on every NFT transfer — asymmetric with `_getReward` and `kick()` which both route the shortfall through `_settleUnsettled` for later reclaim.
3. **F-02-K-03 (LOW):** `extendLock` rejects every duration `<= p.lockDuration` even when `block.timestamp + _newLockDuration > p.lockEnd` — i.e. legitimate extensions that increase real remaining-lock time are blocked when the user originally chose a long duration.
4. **F-02-K-04 (LOW):** `increaseAmount` re-stakes additional principal at the **original** `boostBps` rather than the boost the *remaining* lock time would justify — fee-free retro-boost on top-ups for long-lock holders.
5. **F-02-K-05 (INFORMATIONAL):** `revalidateBoost` checks `jbacNFT.balanceOf(jbacHolder) > 0` for legacy positions — does **NOT** verify it's the *same* JBAC tokenId originally claimed. Trivial JBAC swap keeps the boost.
6. **F-02-K-06 (INFORMATIONAL):** `lockEnd` cliff vs. `lockDuration` retroactive math — `getReward(autoMaxLock=true)` rewrites `lockDuration = MAX_LOCK_DURATION` so a *future* `revalidateBoost` downgrade computes against MAX, not the user's original duration. Locked-in by design but undocumented.

Detailed write-ups below. Severity reflects realistic exploit cost / impact, not whether legitimate users could hit the path accidentally.

---

## F-02-K-01 [HIGH] — Stale JBAC bonus restored via `getReward` autoMaxLock decay-restore branch

### Location
- `getReward` at `TegridyStaking.sol:1031-1040` (autoMaxLock decay-restore branch)
- `revalidateBoost` LockExpired guard at `TegridyStaking.sol:1232-1233`

### Class
State-coupling / boost integrity / math-of-edge-cases

### Description
`revalidateBoost` is the canonical path for downgrading boost when a legacy `hasJbacBoost=true && jbacDeposited=false` user has lost (transferred away / sold) their JBAC NFT. As of DS2-07 (`TegridyStaking.sol:1232-1233`), `revalidateBoost` reverts on expired positions:

```solidity
if (p.lockEnd > 0 && block.timestamp >= p.lockEnd) revert LockExpired();
```

The natspec at lines 1218-1225 explicitly admits the *symmetry hole* this creates ("Holders whose JBAC was lost AND whose lock has expired must withdraw + re-stake fresh"). The fix's actual semantic is: *prevent restore-via-revalidate on a freshly-decayed position*.

But `getReward` has an unrelated branch that fires on the **same condition** (decay just zeroed `boostedAmount`) and restores boost using the cached `hasJbacBoost` flag without consulting on-chain JBAC ownership:

```solidity
// TegridyStaking.sol:1031-1040
if (p.autoMaxLock) {
    p.lockEnd = uint64(block.timestamp + MAX_LOCK_DURATION);
    p.lockDuration = uint32(MAX_LOCK_DURATION);
    if (p.boostedAmount == 0 && p.amount > 0) {
        uint256 newBoost = MAX_BOOST_BPS;
        if (p.hasJbacBoost) newBoost += JBAC_BONUS_BPS;  // <-- stale bit
        _applyNewBoost(p, newBoost);
        _writeCheckpoint(msg.sender);
    }
}
```

`p.hasJbacBoost` was set at stake time (line 760 / 812) and is only ever toggled to `false` inside `revalidateBoost`'s downgrade branch (line 1264). For a **legacy** position (`stake()` pre-H-1-fix or any position with `hasJbacBoost=true && jbacDeposited=false`), the flag stays `true` even if the JBAC is long gone. Combined with the DS2-07 LockExpired guard above, the only way to clear it is `revalidateBoost` *before* expiry — which a careless user with autoMaxLock=true never bothers to call because they think autoMaxLock keeps everything healthy.

### Exploit
1. Alice stakes 10,000 TOWELI via the *legacy* `stake()` path while holding a JBAC NFT (any pre-H-1 grandfathered stake), `hasJbacBoost=true`, `jbacDeposited=false`, `autoMaxLock=true`. Boost = MAX + JBAC = 4.5x.
2. Alice sells/transfers her JBAC NFT.
3. Lock expires (e.g., Alice was on a 1-year lock and never touched it). `_decayIfExpired` runs on next interaction.
4. Alice (or anyone in a flash-bot wrapper) calls `getReward(tokenId)`.
5. `_getReward` settles pre-expiry rewards then `_decayIfExpired` zeroes `boostedAmount`.
6. autoMaxLock branch fires: `lockDuration = 4y`, `boostedAmount = amount * (40000 + 5000) / 10000 = 4.5 * amount`. **JBAC bonus restored without any verification.**
7. Alice now earns 4.5x on a position whose JBAC has been gone for months.

Step 6 is the failure: `revalidateBoost`'s LockExpired guard cannot strip this because the position is no longer "expired" — autoMaxLock just rewrote `lockEnd` to `now + 4y`. To downgrade, someone must call `revalidateBoost` *while the lock is active*, but no automated keeper exists and the path is owner-only / restakingContract-only / position-owner-only (line 1228-1229). Position owner Alice has no incentive to downgrade her own boost.

Worse: the path is reusable. Each cycle of "lock expires → getReward fires → boost restored to 4.5x" cleanly bumps Alice's reward share at the expense of all honest stakers, indefinitely.

### Attacker profile
- Owner of a legacy `hasJbacBoost=true && jbacDeposited=false` position with `autoMaxLock=true` who has since disposed of their JBAC.
- No flash loan needed.
- No collusion with miner needed (timestamp insensitive — works at any `block.timestamp >= p.lockEnd`).

### Impact
- **Boost integrity broken** for legacy positions: 0.5x extra share of every emission cycle, forever, on a position with no actual JBAC backing.
- Dilutes honest stakers' rewards via inflated `totalBoostedStake` denominator.
- Contradicts AUDIT M-22 (flash-loan JBAC mitigation) and AUDIT H-1 (deposit-based JBAC) intent — the deposit-based positions (`jbacDeposited=true`) are immune because the JBAC sits in the vault, but the legacy population is still vulnerable.
- Severity rises with the size of the legacy population. If even one whale-size legacy position with `autoMaxLock` is in this state, the bleed is significant.

### PoC sketch
```solidity
// Setup: Alice has legacy position {amount: 10_000e18, hasJbacBoost: true,
//        jbacDeposited: false, autoMaxLock: true, lockDuration: 365 days}.
// Step 1: Alice transfers her JBAC away (e.g., sells on OpenSea).
jbac.transferFrom(alice, bob, aliceJbacId);

// Step 2: Wait until lockEnd has passed.
vm.warp(p.lockEnd + 1);

// Step 3: Call getReward — autoMaxLock branch fires.
vm.prank(alice);
staking.getReward(aliceTokenId);

// Step 4: Confirm boost restored to 4.5x despite missing JBAC.
(, uint256 boostBps,,, ,) = staking.getPosition(aliceTokenId);
assertEq(boostBps, 45000);  // MAX_BOOST_BPS + JBAC_BONUS_BPS
assertEq(jbac.balanceOf(alice), 0);  // No JBAC

// Step 5: Confirm revalidateBoost CANNOT downgrade — lockEnd is now in the future.
vm.expectRevert();  // No-op if condition (hasJbacBoost && !currentlyHoldsJbac)
                    // is ever evaluated, but autoMaxLock has already rewritten lockEnd
                    // so the LockExpired guard at line 1233 only blocks during the
                    // moment of decay — once getReward runs, the lock is fresh again.
//    The downgrade path runs but currentlyHoldsJbac may be false (Alice has 0 JBACs).
//    So actually the downgrade still happens IF a keeper is fast enough to call it
//    BETWEEN getReward's autoMaxLock branch and the next time Alice calls getReward.
//    In practice no such keeper exists, and Alice's getReward call is atomic — there
//    is no observable window for an external caller to insert revalidateBoost.
```

### References
- `TegridyStaking.sol:1031-1040` — autoMaxLock decay-restore (the bug)
- `TegridyStaking.sol:1218-1225` — DS2-07 natspec acknowledging the symmetry hole
- `TegridyStaking.sol:1232-1233` — DS2-07 LockExpired guard (one-way only)
- `TegridyStaking.sol:1260-1273` — revalidateBoost downgrade branch
- AUDIT M-22 (flash-loan JBAC, file's NatSpec) — intended mitigation
- AUDIT H-1 — deposit-based JBAC (deposit-based path is unaffected)

### Suggested fix (sketch, not for implementation per audit-only scope)
In the autoMaxLock decay-restore branch, gate the JBAC bonus on a fresh check:
```solidity
bool jbacStillValid = p.jbacDeposited
    || (p.hasJbacBoost && jbacNFT.balanceOf(msg.sender) > 0);
uint256 newBoost = MAX_BOOST_BPS;
if (jbacStillValid) newBoost += JBAC_BONUS_BPS;
else p.hasJbacBoost = false;  // also clear the flag so future cycles agree
```
Note: `balanceOf` is flash-loan-able, but for *legacy* positions the symmetry vs. existing `revalidateBoost`'s same `balanceOf` check is acceptable. Deposit-based positions skip the balanceOf check entirely.

---

## F-02-K-02 [MEDIUM] — `_settleRewardsOnTransfer` silently drops reward-pool shortfall (asymmetric with `_getReward` and `kick()`)

### Location
- `TegridyStaking.sol:1481-1538` (the entire `_settleRewardsOnTransfer` function)
- Compare with `_getReward` shortfall routing at `TegridyStaking.sol:1458-1465`
- Compare with `kick()` shortfall routing at `TegridyStaking.sol:1138-1151`

### Class
Reward-accounting precision / asymmetric fail-safe / silent loss of value

### Description
On any NFT-to-EOA transfer, `_settleRewardsOnTransfer` is called via the `_beforeTokenTransfer` hook. It computes `pending = accumulated - p.rewardDebt`, caps to the reward pool (`cappedPending = min(pending, rewardPool)`), and routes **only `cappedPending`** through `_settleUnsettled(from, cappedPending)`:

```solidity
// TegridyStaking.sol:1500
uint256 actualSettled = _settleUnsettled(from, cappedPending);
// AUDIT FIX C-02: Emit forfeiture event when cap blocks settlement
uint256 forfeited = cappedPending - actualSettled;
if (forfeited > 0) {
    emit RewardsForfeited(from, forfeited);
}
```

Then at line 1537:
```solidity
p.rewardDebt = accumulated;
```

The `pending - cappedPending` slice (the rewardPool shortfall) is **never routed through `_settleUnsettled`**. It is also **erased** by `p.rewardDebt = accumulated` because the rewardDebt anchor is advanced to the FULL accumulated value, not just the credited portion.

Compare with `_getReward` at lines 1458-1465:
```solidity
uint256 shortfall = pending - cappedPending;
if (shortfall > 0) {
    uint256 actualSettled = _settleUnsettled(recipient, shortfall);
    // ...
}
```
`_getReward` correctly routes the rewardPool shortfall through unsettled — so when the pool is later refunded, `from` can `claimUnsettled()` to recover.

`kick()` at lines 1138-1151 does the same shortfall routing. So `_settleRewardsOnTransfer` is the **odd one out** of three reward paths.

The DS3-01 / DS3-05 fix added a `TransferRewardPoolShortfall` event for off-chain observability, but its accompanying NatSpec at lines 1491-1496 explicitly states "every NFT transfer with under-funded pool silently strands the post-pool slice." That's the documented behaviour. **Documenting the loss is not the same as fixing it.**

### Exploit
This is *not* a malicious exploit — it's a **silent value loss** on a legitimate user action:

1. Alice has a position with `pending = 10,000 TOWELI` accrued.
2. Reward pool is temporarily low (`rewardPool = 4,000 TOWELI`, e.g., between funding cycles).
3. Alice transfers her staking NFT to Bob (sale, gift, lending escrow round-trip outside whitelist).
4. `_settleRewardsOnTransfer` fires with `pending=10000, cappedPending=4000`.
5. `_settleUnsettled(alice, 4000)` credits Alice's bucket with up to 4,000 (subject to global cap).
6. The `6,000` shortfall is **silently destroyed**: `p.rewardDebt = accumulated` (full 10,000 worth), so Bob's future `getReward` will compute `diff = 0` (the rewardPerTokenStored hasn't moved between line 1482 and line 1537 since `_accumulateRewards` already ran).
7. Alice loses the 6,000 TOWELI she earned. The protocol's `_creditRewardPool` / `notifyRewardAmount` re-credits the missing tokens to *all stakers* via the next `_accumulateRewards` cycle — positive-sum for the protocol, zero-sum for Alice.

Alternative: a malicious **lending contract operator** can game this by deliberately emptying the reward pool (e.g., via a synchronized batch of `getReward` calls just before the lender repays the loan and the NFT transfers back to the borrower). The borrower's pre-loan reward slice is then silently destroyed during the round-trip.

### Attacker profile
- Anyone capable of frontrunning an NFT transfer with a wave of reward claims that drains the pool.
- More realistically: opportunistic — happens accidentally to any user transferring during a funding gap.

### Impact
- Silent reward loss on every NFT transfer that crosses a reward-pool funding gap.
- The DS3-04 NatSpec on `kick()` (line 1171-1182) explicitly admits: "Implementing the true 'claimable later' semantic would require a per-position forfeit-debt mapping plus reconciliation, which is out of scope" — but the fix `kick()` got (revert via `KickWouldForfeit`) is NOT applied here. NFT transfers cannot revert on this path because the `_beforeTokenTransfer` hook is mandatory.
- Asymmetry creates an information leak: a sophisticated user knows to call `getReward` *before* transferring (preserves shortfall via unsettled), while a naive user just transfers (loses shortfall).

### PoC sketch
```solidity
// Setup: Alice has staked 100k TOWELI for 4 years.
// Time passes; reward emissions accrue 10k TOWELI worth of pending rewards for Alice.
// Reward pool balance is intentionally low (e.g., right before notifyRewardAmount).
// available - reserved = 4k.
uint256 pendingBefore = staking.earned(aliceTokenId);
assertEq(pendingBefore, 10_000e18);

// Path A — call getReward first (correct path):
vm.prank(alice);
staking.getReward(aliceTokenId);
// Alice receives 4k directly + 6k credited to unsettledRewards[alice].

// Path B — transfer NFT directly (lossy path):
vm.prank(alice);
staking.transferFrom(alice, bob, aliceTokenId);
// _settleRewardsOnTransfer fires:
//   pending = 10k, cappedPending = 4k.
//   _settleUnsettled(alice, 4k) -> alice gets up to 4k unsettled credit.
//   p.rewardDebt = full accumulated.
//   The 6k shortfall is GONE.
assertEq(unsettledRewards[alice], <=4_000e18);  // not 10k.
```

### References
- `TegridyStaking.sol:1500` — `_settleUnsettled(from, cappedPending)` only
- `TegridyStaking.sol:1537` — `p.rewardDebt = accumulated;` advances anchor by full pending
- `TegridyStaking.sol:1458-1465` — `_getReward` shortfall routing (the correct pattern)
- `TegridyStaking.sol:1138-1151` — `kick()` shortfall routing (the correct pattern)
- AUDIT FIX DS2-02 (file natspec) — added shortfall routing to kick(); failed to backport to `_settleRewardsOnTransfer`
- AUDIT FIX DS3-01 / DS3-05 — added the SHORTFALL EVENT but not the routing fix

---

## F-02-K-03 [LOW] — `extendLock` rejects all `_newLockDuration <= p.lockDuration` even when the new lockEnd would push lockEnd forward

### Location
`TegridyStaking.sol:888`

### Class
UX / lock-extension semantics / accounting confusion

### Description
The `extendLock` validation compares **durations**, not **end timestamps**:

```solidity
// TegridyStaking.sol:888
if (_newLockDuration <= p.lockDuration) revert LockNotExtended();
```

When a user originally chose `lockDuration = 4 years` and that lock has been running for, say, 2 years (so `lockEnd` is 2 years in the future), there is **no value of `_newLockDuration` <= 4 years that they can pass**. The only allowed values are `> 4 years`, but those then revert via `LockTooLong` (line 889).

So a user with a long-original-lock has a **dead band** during which extension is impossible:
- If you chose 4y at stake time, you can NEVER extend, even when "extension" would conceptually mean "push lockEnd forward by N days."
- If you chose 1y at stake time, you can extend but only with `_newLockDuration > 1y`, which rebases lockEnd from `stakeTimestamp + 1y` to `now + (1y + ε)`. Conceptually fine but the UX is unintuitive: the user thinks they're "adding 1 year" but the semantics are "set the duration to the new value."

### Exploit
Not exploitable per se — but exposes a class of locked-out users. A user who chose 4-year MAX and now wants to "refresh" their MAX lock (push lockEnd to `now + 4y`) cannot do so via `extendLock`. They MUST toggle `autoMaxLock` on (which charges the same fee but ALSO sets `lockEnd = now + MAX_LOCK_DURATION`). So the autoMaxLock toggle is the workaround. Confusing.

### Impact
- Users with long original locks effectively lose the `extendLock` path; must use `toggleAutoMaxLock` workaround.
- No value lost, but the protocol silently steers them into a different code path (autoMaxLock semantics — which auto-renews on every getReward).

### Attacker profile
N/A — pure UX issue.

### PoC sketch
N/A.

### References
- `TegridyStaking.sol:884-916` (extendLock)
- `TegridyStaking.sol:841-876` (toggleAutoMaxLock — the workaround)

### Suggested fix (sketch)
Compare against remaining lock time, not original duration:
```solidity
uint256 currentRemaining = p.lockEnd > block.timestamp ? p.lockEnd - block.timestamp : 0;
if (_newLockDuration <= currentRemaining) revert LockNotExtended();
```

---

## F-02-K-04 [LOW] — `increaseAmount` retro-applies original `boostBps` to new principal regardless of remaining lock time

### Location
`TegridyStaking.sol:921-953` (specifically line 938)

### Class
Boost-fairness / fee-bypass / dilution

### Description
`increaseAmount` adds `_additionalAmount` to a position's principal, then re-runs `_applyNewBoost` using the **existing** `p.boostBps`:

```solidity
// TegridyStaking.sol:937-938
p.amount += _additionalAmount;
_applyNewBoost(p, uint256(p.boostBps));
```

This is correct in the sense that the boost ratio stays identical, but it means the new principal earns at the **original boostBps** even if `block.timestamp + remaining_lock < lockDuration` — i.e. the new principal is locked for less time than the boost ratio it earns implies.

Concrete: User stakes 100k TOWELI for 4 years (boost = 4.0x). 3 years 11 months pass. Lock has 1 month remaining. User calls `increaseAmount(50k)`. The 50k earns at 4.0x for that 1 month — same as if they'd staked it fresh for 4 years. **No fee is charged on this implicit boost grant** (no `_chargeExtendFee` call in `increaseAmount`).

This is a **fee-bypass** for whales: instead of paying `extendFeeBps` to extend lock and re-stake, just dribble in `MIN_STAKE` increments of additional principal at the old boost. Each `increaseAmount` call costs only the gas + the dilution caused by the new stake, not the explicit `extendFeeBps * amount` fee.

### Exploit
1. Alice stakes 100k TOWELI for 4y at MAX boost. Pays no fee at stake time (correct).
2. 3y 11mo pass. Alice's lock has 1mo left.
3. Suppose `extendFeeBps` is set to 100 (1%). Bob, a fresh staker, would pay `1% * 100k = 1k` fee to stake at MAX boost for 4y.
4. Alice instead calls `increaseAmount(50k)` — **no fee**. Her 50k earns at 4.0x for 1 month.
5. After 1 month, Alice withdraws (no penalty since lock expired). She's earned 4.0x rewards on her 50k for free, without paying `extendFeeBps`.

The dilution this causes is borne by all other stakers (extra 200k boostedAmount in the pool for 1 month), and Alice didn't compensate them via the extend fee.

### Attacker profile
Whale with a long existing lock approaching expiry. Coordinated with off-chain bots to time `increaseAmount` just before expiry.

### Impact
- Bypass of the `extendFeeBps` mechanism (designed to compensate dilution).
- Disproportionate boost-per-locked-time on top-ups.
- Severity capped by `MIN_STAKE` floor and gas cost — large attacks visible in the data.

### PoC sketch
```solidity
// Stake at MAX boost.
vm.prank(alice);
staking.stake(100_000e18, 4 * 365 days);  // boostBps = 40000.

// Wait 3y 11mo.
vm.warp(block.timestamp + 3 * 365 days + 30 days * 11);

// Increase principal — no fee paid.
vm.prank(alice);
staking.increaseAmount(aliceTokenId, 50_000e18);

// Position now: amount = 150k, boostBps = 40000 (unchanged), lockEnd unchanged.
// New 50k earns 4.0x for the remaining 1 month.

// Compare with extendLock: would have charged extendFeeBps fee. increaseAmount: no fee.
```

### References
- `TegridyStaking.sol:921-953` (increaseAmount)
- `TegridyStaking.sol:884-916` (extendLock — the fee-bearing path)
- `TegridyStaking.sol:2130-2146` (`_chargeExtendFee` — not called from increaseAmount)
- AUDIT C5 / M-AUDIT-2026-1 (extend fee design intent)

### Suggested fix (sketch)
Either (a) charge `extendFeeBps * _additionalAmount` in `increaseAmount`, or (b) recompute boost based on remaining lock time:
```solidity
uint256 remaining = p.lockEnd > block.timestamp ? p.lockEnd - block.timestamp : 0;
uint256 effectiveBoost = calculateBoost(remaining);
if (p.hasJbacBoost) effectiveBoost += JBAC_BONUS_BPS;
// New principal earns this lower boost; OR charge the fee that bridges the gap.
```

---

## F-02-K-05 [INFORMATIONAL] — `revalidateBoost` legacy-position check is by `balanceOf > 0`, not by tokenId match

### Location
`TegridyStaking.sol:1244-1273`

### Class
JBAC-bonus integrity / token-substitution

### Description
For legacy `hasJbacBoost && !jbacDeposited` positions, `revalidateBoost` checks:

```solidity
// TegridyStaking.sol:1256
bool currentlyHoldsJbac = jbacNFT.balanceOf(jbacHolder) > 0;
```

This is a **balance check, not a tokenId match.** A user who originally claimed JBAC boost via tokenId X can transfer X away, buy a different JBAC tokenId Y, and the boost stays valid. The protocol's intent (per the file's M-22 / H-1 audit notes) is that the JBAC backing the boost should be the *same* token throughout the lock — `stakeWithBoost`'s deposit-based pattern enforces this for new positions, but legacy positions are gated only by total-balance.

### Exploit
Limited. The "exploit" is JBAC swap arbitrage:
1. User stakes via legacy `stake()` while holding JBAC #1 (gets `hasJbacBoost=true`).
2. User wants to sell JBAC #1 (e.g., it's a higher-tier collectible). They first buy JBAC #2 (any cheap one).
3. Now `balanceOf(user) = 2`. They sell #1; `balanceOf = 1`. Boost intact.
4. Later, if they sell #2 too (`balanceOf = 0`), `revalidateBoost` would downgrade them — but only if a keeper calls it.

This is a small subsidy for users who treat JBAC as fungible. Not a security vulnerability — the protocol arguably intended the looser semantics for legacy positions (since they can't enforce tokenId continuity post-hoc).

### Impact
- Marginal economic leak for legacy `hasJbacBoost` positions.
- Sound for new (deposit-based) positions: JBAC is locked in the vault.

### Attacker profile
Holder of a legacy `hasJbacBoost=true` staking position who wants to flip JBACs without losing boost.

### PoC sketch
```solidity
// Setup: Alice has legacy position with hasJbacBoost = true, jbacDeposited = false.
// Alice owns JBAC #1.
// Alice wants to sell #1 but keep her staking boost.

// Step 1: Buy JBAC #2 first.
vm.prank(alice);
jbac.transferFrom(seller, alice, 2);  // alice now has 2 JBACs.

// Step 2: Sell JBAC #1.
vm.prank(alice);
jbac.transferFrom(alice, buyer, 1);  // alice now has 1 JBAC.

// Step 3: Anyone calls revalidateBoost(aliceTokenId).
staking.revalidateBoost(aliceTokenId);
// Inside: jbacNFT.balanceOf(alice) > 0 => true. Boost stays.
// Even though the JBAC backing the boost has changed.
```

### References
- `TegridyStaking.sol:1235-1273` (revalidateBoost with balanceOf check)
- AUDIT M-22 / AUDIT H-1 (file natspec at lines 1212-1242)

---

## F-02-K-06 [INFORMATIONAL] — autoMaxLock `getReward` rewrites `lockDuration` to MAX even on non-decayed positions, locking in retroactive MAX-boost downgrade target

### Location
`TegridyStaking.sol:1031-1040`

### Class
State coupling / lockDuration vs lockEnd semantic drift

### Description
The autoMaxLock branch of `getReward` unconditionally rewrites `lockDuration = MAX_LOCK_DURATION`, even when `boostedAmount > 0` (lock not yet expired):

```solidity
// TegridyStaking.sol:1032-1033
p.lockEnd = uint64(block.timestamp + MAX_LOCK_DURATION);
p.lockDuration = uint32(MAX_LOCK_DURATION);
```

This means any *future* `revalidateBoost` call (for a JBAC-loss downgrade) computes:
```solidity
uint256 newBoost = calculateBoost(p.lockDuration);  // = MAX_BOOST_BPS, always.
```

If the user's *original* lock duration was 1 year and they later toggled `autoMaxLock` on (which sets lockDuration = MAX), then later lost their JBAC, the downgrade strips JBAC bonus but **leaves the user at MAX_BOOST_BPS** because `p.lockDuration` was rewritten to MAX during the autoMaxLock toggle.

This is technically by design (autoMaxLock = perpetual MAX), but it means:
- A user can't "downgrade fast" by both losing JBAC and reverting to a shorter conceptual lock.
- The `lockDuration` field has *two distinct semantics* depending on autoMaxLock history:
  - autoMaxLock never used → `lockDuration` = original chosen at stake time.
  - autoMaxLock used → `lockDuration` = MAX_LOCK_DURATION irrespective of original.

### Impact
- No direct exploit; documentation gap.
- Combined with F-02-K-01: if autoMaxLock was toggled at any point and a JBAC is later lost, the user keeps MAX boost (no JBAC bonus); without autoMaxLock, downgrade gives them their original-duration boost.

### Attacker profile
N/A.

### References
- `TegridyStaking.sol:1031-1040` (getReward autoMaxLock branch)
- `TegridyStaking.sol:855-870` (toggleAutoMaxLock branch — same rewrite)
- `TegridyStaking.sol:1267` (`calculateBoost(p.lockDuration)` in revalidateBoost downgrade)

---

## Notes / Dead-ends

### Verified safe — boost arithmetic

- `calculateBoost`: linear interpolation `MIN_BOOST_BPS + (elapsed * boostRange) / range`. Floors to MIN at `_duration <= 7d`, ceilings to MAX at `_duration >= 4y`. Numerator `elapsed * boostRange` peaks at `~125e6 * 36000 ≈ 4.5e12` — far below uint256 ceiling. Rounding bias (down) costs the user up to (range-1)/range * 1 BPS per call ≈ 0.0001x. Negligible.
- `_applyNewBoost`: `(p.amount * newBoost) / BOOST_PRECISION` with explicit `BoostOverflow` revert at `newBoost > 65535`. uint16 cast is safe by construction (max 45000 < 65535).
- `_chargeExtendFee`: ceiling round on recycled slice (M-24); no rounding loss to stakers.
- `_splitPenalty`: same M-24 ceiling round.
- `_settleUnsettled`: hard-cap at `maxUnsettledRewards` (admin-tunable, floored at 10_000e18 by `applyMaxUnsettledRewards`); overage is implicit forfeit re-credited to all stakers via the next `_accumulateRewards` cycle. Documented and consistent.

### Verified safe — boost cast

- `boostBps` is `uint16`. Max possible value is `MAX_BOOST_BPS + JBAC_BONUS_BPS = 45000`. uint16 max is 65535. Headroom 20535 BPS = 2.05x. Plenty.
- The `BoostOverflow` revert at `_applyNewBoost:2013` is a defense-in-depth check; never fires in current paths.

### Verified safe — time math

- `block.timestamp + _lockDuration` cast to `uint64`: `uint64.max ≈ 1.8e19`. Year 2070 is `~3.16e9`. Year 583,344,213 is `~1.8e19`. No realistic overflow.
- `_decayIfExpired` uses `block.timestamp >= p.lockEnd` — exclusive on the active side, inclusive on the decay side. Consistent across `withdraw` (`< lockEnd` reverts), `earlyWithdraw` (`>= lockEnd` reverts), `extendLock` (`>= lockEnd` reverts), `votingPowerOf` (`>= lockEnd` skips).
- `lockEnd == 0` (uninitialized / cleared position) is correctly skipped by `p.lockEnd > 0 && ...` guards in `_decayIfExpired`, `extendLock`, `revalidateBoost`, `toggleAutoMaxLock`, `kick`.

### Verified safe — `_safeInt256` cast and rewardDebt

- `_safeInt256` reverts on `value > int256.max ≈ 5.79e76`. Max practical `(boostedAmount * rewardPerTokenStored) / ACC_PRECISION` over 1000 years with 1B-supply token at 100/s rate is `<3e30` — orders below the ceiling.
- `p.rewardDebt = accumulated` at line 1435 of `_getReward` and line 1537 of `_settleRewardsOnTransfer` are consistent; subsequent `_getReward` cannot double-pay because `boostedAmount` zero post-decay forces `accumulated = 0`, `diff = -p.rewardDebt < 0`, skip-path.

### Verified safe — voting power semantic

- `votingPowerOf` iterates `_positionsByOwner[user]` (EnumerableSet, capped at 50 per holder). Sums `(amount * boostBps) / BOOST_PRECISION` only for non-expired positions.
- `votingPowerAtTimestamp` uses OZ `Checkpoints.Trace208.upperLookup` — strict `<= ts` semantics, no monotonicity violations.
- `_writeCheckpoint` skips no-op pushes (NEW-S7) — keeps the trace lean and avoids same-timestamp-double-push (which would be a Checkpoints.upperLookup ambiguity, but OZ's library handles same-key updates by overwriting).
- `_writeTotalBoostedStakeCheckpoint` mirrors the per-user pattern.
- `restakingContract` returns 0 from `votingPowerOf` to prevent double-counting via the restaking aggregation. Sound.

### Verified safe — early-exit penalty

- `penalty = (amount * EARLY_WITHDRAWAL_PENALTY_BPS) / BPS = (amount * 2500) / 10000 = amount / 4`. Rounds DOWN, favoring user — penalty is slightly less than 25%.
- `userReceives = amount - penalty` cannot underflow (penalty <= amount/4 < amount).
- `_splitPenalty` ceiling-rounds the recycled slice, slight bias toward stakers (M-24).

### Verified safe — zero-deposit voting

- `stake` requires `_amount >= MIN_STAKE = 100e18`, so no zero-deposit positions exist.
- `votingPowerOf` skips positions with `amount == 0`.

### Verified safe — lock merge

- No `mergeLocks` function exists. Each position is independent. `MAX_POSITIONS_PER_HOLDER = 50` caps per-holder accumulation. No min-lock bypass via merge.

### Verified safe — checkpoint monotonicity

- OZ `Checkpoints.Trace208` uses uint48 keys (timestamps) and uint208 values. `SafeCast.toUint48(block.timestamp)` reverts on overflow (year 8920556+).
- Same-block multiple-checkpoint pushes (e.g., user does N actions in one tx): the OZ library handles same-key updates by overwriting the value, not appending duplicate keys. Verified by reading `Checkpoints.push` source.

### Lens vectors that don't exist in this contract

- **Negative interest / dynamic rate cuts**: rewardRate is admin-settable but bounded by `MAX_REWARD_RATE = 100e18` and goes through 48h timelock on `TegridyStakingAdmin`. No retroactive rate cuts.
- **Borrow / utilization curves**: not a lending pool.
- **Exchange rate model**: rewards are direct token transfers, no cToken-style exchange-rate accumulator.
- **Reentrancy via the boost path**: all reward-touching paths are `nonReentrant`; CCR-01 invariant ensures `_burn` precedes JBAC `safeTransferFrom` so any inbound `transferFrom` reentry reverts on the empty `_ownerOf` slot.
