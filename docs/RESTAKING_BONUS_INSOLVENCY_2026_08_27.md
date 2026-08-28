# TegridyRestaking — bonus accrual over-mints, pool goes insolvent (CONFIRMED HIGH, pre-deploy)

**Contract:** `contracts/src/TegridyRestaking.sol` (2475 lines, post-EIP-170-split, host 22,114 B).
**Status:** PRE-DEPLOY. `TEGRIDY_RESTAKING_ADDRESS` is the zero address in
`frontend/src/lib/constants.ts`; every on-chain entry is under `retiredDeploys`. **No live funds.**
**Repro:** `contracts/test/RestakingBonusInsolvency.t.sol::test_BonusAccrual_CompoundingOverMint_KNOWN_DEFECT`
(passes today — it asserts the defect EXISTS; flip the two marked assertions to their solvency form
after the fix and it proves the fix).

This came out of an adversarial 5-lens audit (find → independent refute → synthesize). Four of the
five lenses — degraded-read/permissionless-write stream diversion, principal-trap on exit,
bonus-accounting double-spend, access/pause/timelock — returned **clean**: the permissionless
victim-targeting writers (`kick`, `decayExpiredRestaker`, `revalidateBoost*`, `refreshPosition`) and
the exit paths held up under the existing DEEP-DR-04 / DR2-02 / R014 / R017 hardening. One lens
produced a real defect, re-derived from scratch and empirically reproduced below.

---

## The defect

`_accrueBonus()` (TegridyRestaking.sol:2374):

```solidity
uint256 reward = elapsed * bonusRewardPerSecond;
uint256 available;
try bonusRewardToken.balanceOf(address(this)) returns (uint256 bal) {
    available = bal > totalUnforwardedBonus ? bal - totalUnforwardedBonus : 0;
} catch { available = 0; }
if (reward > available) { emit BonusShortfall(elapsed, reward - available); reward = available; }
if (reward > 0) accBonusPerShare += (reward * ACC_PRECISION) / totalRestaked;
lastBonusRewardTime = block.timestamp;
```

Two facts combine into insolvency:

1. **Accrual moves no tokens.** `accBonusPerShare` is bumped; the WETH balance only ever falls when
   someone *successfully claims*. So between accruals the balance the clamp trusts does not shrink.
2. **The clamp subtracts the wrong thing.** `available = balance − totalUnforwardedBonus`.
   `totalUnforwardedBonus` tracks only *crystallized failed* transfers (deferred IOUs). It does **not**
   subtract already-accrued-but-unclaimed liability. So the portion of the balance that is already
   promised to earlier accruals is offered up again as "available" on the next accrual.

Result: any accrual that fires while unclaimed liability sits in the balance re-distributes that same
backing. With no intervening claims the over-mint **compounds linearly — one full pool per window** —
and `accBonusPerShare` climbs without bound.

There is **no `periodFinish`**, and `totalBonusFunded` / `totalBonusDistributed` are **write-only**
(grep-verified: never read into any conditional that gates accrual). So nothing in the contract bounds
cumulative emission to cumulative funding. The cited `H-RESTAKE-BONUS-CAP-DEBT` guard (line 2387) is
genuinely incomplete — it is a single-window instantaneous cap, not a cumulative one.

### Why this is the *default* end-state, not a contrived one

The same accrual fires on essentially every user interaction (`restake`, `unrestake`, `claimAll`,
`refreshPosition`, `decayExpiredRestaker`, `revalidateBoost*`, admin rate ops). Once cumulative
intended emission (`rate × elapsed`) exceeds the funded balance — the natural fate of any fixed-rate,
finitely-funded pool that isn't perfectly, continuously refunded — **every** subsequent accrual
re-mints up to the full pool again. No attacker and no griefing required. "Can't be cheaply induced"
does not apply; it induces itself over time.

---

## Empirical reproduction (real numbers)

Two equal restakers, pool funded with **100,000** WETH, `bonusRewardPerSecond = 0.1e18`, four accrual
windows with **no claims and no new funding** between them:

| after window | `accBonusPerShare` | per-window increment |
|---|---|---|
| start | 0.0671 | — |
| W1 | 0.4557 | 0.3885 |
| W2 | 0.8442 | 0.3885 |
| W3 | 1.2327 | 0.3885 |
| W4 | 1.6213 | 0.3885 |

- **Gross accumulator liability after 4 windows: 417,280 WETH** vs **100,000 funded** (≈4×).
- On claim, every claimant's owed amount now exceeds the whole pool, so the all-or-nothing bonus
  transfer defers everything to unbacked `unforwardedBonusRewards` IOUs. **Total obligation (paid +
  IOUs) = 408,640 vs 100,000 funded.**

### Methodology note (this nearly understated the bug)

The first version of the repro used `vm.warp(block.timestamp + W)` per window and showed
`accBonusPerShare` **flat after W1**, which looked like the over-mint was bounded at one window
(~8,640). That was a **test artifact**: under this repo's `optimizer + via_ir`, solc CSEs
`block.timestamp` as transaction-constant, so repeated `vm.warp(block.timestamp + W)` calls all target
the same instant and never advance time for W2+. Driving warps off `vm.getBlockTimestamp()` with an
absolute accumulator restored real time advance and exposed the true, unbounded compounding. (Same
footgun recorded in `docs/V2_FORFEIT_ATTEMPT4_REFUTED_2026_08_26.md`.) **Use `vm.getBlockTimestamp()`
in any test that warps more than once.**

---

## The fix — Synthetix funded-period rebase is JUSTIFIED (targeted)

Move the bonus stream to the Synthetix `StakingRewards` funded-period model:

- `notifyBonusReward(amount, duration)` sets `rewardRate = (amount + leftover) / duration` and
  `periodFinish = now + duration`, pulling `amount` in (mirror the reward side's `notifyRewardAmount`).
- Accrual uses `lastTimeRewardApplicable = min(now, periodFinish)`, so emission **stops** at
  `periodFinish` and cumulative emission ≡ cumulative funded **by construction**. The `outstanding ≤
  balance` invariant that fails today becomes structurally true.
- **Drop** the live-`balanceOf` clamp (it can only ever see an instantaneous snapshot and cannot
  express a cumulative bound) — safe *because* `periodFinish` now bounds accrual.

**Preserve the claim-side hardening — none of it depends on the broken accrual clamp:**
- `_safeBonusTransferExt` self-call + `unforwardedBonusRewards` deferral (bricked-recipient safety),
- `_accrueBonusChecked` monotonicity tripwire (`AccrueNotMonotone`),
- exit-path permissiveness (`unrestake`/`recoverStuckPrincipal`/`emergencyWithdrawNFT` already return
  principal even when reads/transfers revert — separately confirmed clean by the exit lens).

This is a root-cause fix that removes the fragility, not a symptom patch, and it does **not** regress
the diversion / principal-trap / access hardening (those live on other code paths and were audited
clean). It is a pre-deploy change; it must land with the invariant test flipped to its solvency form
and re-run green before any deploy.

---

## Test-first status

- ✅ Failing/characterization test committed (`RestakingBonusInsolvency.t.sol`) — pins the compounding
  over-mint and the insolvency, with the exact post-fix assertions in comments.
- ☐ Implement the funded-period rebase (pre-deploy).
- ☐ Flip the two marked assertions to `assertLe(obligation, B0)` / mint-once; re-run green.
- ☐ Keep the existing restaking suites (17 files) green through the rebase — they encode the
  hardening that must be preserved.
