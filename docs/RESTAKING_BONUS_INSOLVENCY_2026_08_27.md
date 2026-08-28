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

## The fix — LANDED: minimal cumulative-liability cap (operator-chosen over the rebase)

Two fixes close this. The operator chose the **minimal cumulative-liability cap** to minimize
regression risk on the 17 heavily-audited restaking suites; the Synthetix rebase is recorded below as
the documented alternative.

### Landed fix — a `totalBonusEmitted` cumulative counter

`_accrueBonus` now caps against the **full outstanding liability**, not just crystallized IOUs:

- New monotonic state `totalBonusEmitted` is incremented by the ACTUAL liability minted each accrual
  (`accDelta * totalRestaked / ACC_PRECISION`, net of per-share flooring).
- The clamp changes from `available = bal − totalUnforwardedBonus` to
  `available = bal − (totalBonusEmitted − totalBonusDistributed)`. That `outstanding` term already
  **includes** the IOUs (`totalUnforwardedBonus` is a subset), so it is no longer subtracted
  separately. Because every one of the six bonus-outflow sites increments `totalBonusDistributed` by
  the exact amount transferred, `outstanding` is precisely the unpaid liability — robust to restaker
  entry/exit and never drifting above what positions can claim.

Direction is provably conservative: `distributed ≤ emitted` always (payouts are shares of what was
minted), so the worst case of any miss is *under*-minting (a liveness dust-stranding), never
*over*-minting. Solvency (`cumulative emission ≤ cumulative funded`) holds by construction.

**Verification:** `test/RestakingBonusInsolvency.t.sol::test_BonusAccrual_StaysSolvent_capBindsAcrossWindows`
proves the pool is minted at most once (W2–W4 mint zero), `totalBonusEmitted ≤ funded`, and the whole
pool is still distributed (non-vacuous, obligation ≈ funding). Both halves of the fix are
mutation-verified (revert the clamp → red; neuter the counter → red). **279 tests across all 24
restaking + consumer suites pass — zero regression.**

### Documented alternative (not taken) — Synthetix funded-period rebase

`notifyBonusReward(amount, duration)` → `rewardRate = (amount+leftover)/duration`, `periodFinish`,
`lastTimeRewardApplicable = min(now, periodFinish)`; drop the live-`balanceOf` clamp. Also makes
cumulative emission ≡ funded by construction and additionally removes the "no natural end / relies on
continuous refunding" fragility, but rewrites the accrual core and would churn the 17 suites — higher
regression risk. Reconsider if the fixed-rate-until-empty semantics themselves become undesirable.

Either fix preserves the claim-side hardening (all on other code paths, audited clean this pass):
`_safeBonusTransferExt` deferral, the `_accrueBonusChecked` monotonicity tripwire, exit-path
permissiveness.

---

## Test-first status

- ✅ Audit + reproduction: adversarial 5-lens audit, one CONFIRMED HIGH, empirically reproduced.
- ✅ Solvency regression test committed (`RestakingBonusInsolvency.t.sol`) — asserts the invariant now
  holds, mutation-verified load-bearing.
- ✅ Minimal cumulative-liability cap implemented in `_accrueBonus` (+ `totalBonusEmitted` counter).
- ✅ Full restaking + consumer suites green (279 tests, 0 regressions).
- Pre-deploy only (`TEGRIDY_RESTAKING_ADDRESS == address(0)`); not pushed. The existing 17 restaking
  suites encode the hardening that was preserved and remain green.
