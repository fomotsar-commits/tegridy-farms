# TegridyStaking base-reward over-mint — reproduced (LIVE, = audit remediation #2)

**Contract:** `contracts/src/TegridyStaking.sol` + `contracts/src/lib/StakingRewardLib.sol`.
**Live at** `0xcaDc93E96De58EA554c71ca609974625615E046D` (holds real staked TOWELI + funded rewards).
**PoC:** `contracts/test/StakingRewardOverMint.t.sol::test_baseRewardOverMintsBeyondFunding_KNOWN_DEFECT` (passes — characterizes current behavior).

This is **not a new finding.** It is a concrete reproduction of what the provenance audit already flagged as
remediation **#2** — *"`TegridyStaking` — Synthetix named, Synthetix's solvency invariant absent"* — and of the
same class as the (pre-deploy) restaking bonus insolvency fixed on `audit/restaking-bonus-insolvency`. The value
here is a **running PoC with numbers** plus the observation that the existing red-team solvency test never
exercises the regime where it bites.

## Mechanism

`StakingRewardLib.accumulateRewards` (:387-403):

```solidity
uint256 reward = elapsed * cfg.rewardRate;                 // fixed rate, no periodFinish
uint256 available = cfg.rewardToken.balanceOf(address(this));
uint256 reserved  = cfg.totalStaked + rs.totalUnsettledRewards;
if (available > reserved) { uint256 pool = available - reserved; if (reward > pool) reward = pool; }
else reward = 0;
rs.rewardPerTokenStored += (reward * ACC_PRECISION) / totalBoosted;   // accrual moves NO tokens
```

The cap subtracts `totalStaked` (principal) and `totalUnsettledRewards` (crystallized **shortfalls**) — but **not
already-accrued-but-unclaimed liability.** Accrual moves no tokens, so with no intervening claim the balance and
both reserved terms are unchanged, and the *same* `rewardPool` is re-minted into `rewardPerTokenStored` on every
successive accrual. There is **no `periodFinish`** and `totalRewardsFunded` is a write-only counter (never gates
accrual). Nothing bounds cumulative emission to cumulative funding.

## Reproduced (PoC numbers)

Two equal stakers, reward pool funded with **1000 TOWELI**, `rewardRate = 1e18` (≈ the live 0.82e18/s), two accrual
windows with no intervening staker claim (triggered by a dust "poker" account):

| after window | `earned(alice)` | `earned(bob)` |
|---|---|---|
| 1 | 499.75 | 499.75 |
| 2 | **999.25** | **999.25** |

- **Owed to alice+bob = 1998.5 TOWELI vs 1000 funded (`totalRewardsFunded`)** — the accounting owes ~2× what was
  ever funded.
- First claimer (alice) takes **999** (fair share of the funded pool is 500); the stayer (bob) gets **0** plus a
  **999.5 unbacked `unsettledRewards` IOU**.
- The shortfall→`unsettled` booking is capped only at `maxUnsettledRewards` (a flow-control guard), **not at
  balance** (`StakingRewardLib.sol:506-556`, whose own comment concedes *"earned-but-unbacked debt ... the operator
  commits to backfilling"*). So the contract ends holding **less** than `totalStaked + totalUnsettledRewards` — the
  cash invariant the red-team suite asserts (`RedTeam_Staking.t.sol:452-465`) is **violated in this depletion path.**

## Why the existing test misses it

`RedTeam_Staking.t.sol` funds 5,000,000 TOWELI, so the reward pool never depletes, the cap never binds, and no
over-mint or shortfall ever occurs — the cash invariant holds trivially. The invariant is real only in the
**funded** regime; the depletion regime (where emission outruns the remaining pool) is never exercised.

## Impact & timing (measured, not alarmist)

- **No principal theft.** Claims are always capped to the unreserved pool, so no one is *paid* more than the
  contract holds. The harm is (a) **distribution** — near depletion the first claimer extracts more than their
  funded share and later stakers are stranded with unbacked IOUs; and (b) **operator cost** — honoring those IOUs
  (as the design's "operator backfills" intent expects) means paying **~2× what was funded/intended.**
- **It bites in the depletion regime, which the pool is approaching.** The staking reserve is projected to run dry
  ~**2026-10-11** (per `TODO_OPERATOR.md`) with no top-up/rate-cut decided. As the remaining pool shrinks below
  `rewardRate × (gap between accruals)`, the cap begins to bind and the over-mint compounds per no-claim window.
  Low staker activity near depletion makes long accrual gaps likely.

## Fix — audit remediation #2 (LIVE, migration)

Rebase the reward accrual on the Synthetix funded-period model this repo already owns (`TegridyLPFarming.sol:277-292,
566-600`): `rewardRate = (reward + leftover) / duration`, `periodFinish`, gate accrual on `lastTimeRewardApplicable()`.
Then cumulative emission ≡ cumulative funded **by construction** — the over-mint and the shortfall cascade cannot
occur. Cost: rewrite of the accrual core + migration of live positions across the staking instances (this is why it
is a Live/migration item, not a quick fix). Does **not** delete the escrow ledger (that is gated on `_isTrackedHolder`,
not on funding).

**Interim, no redeploy:** keep the reward pool funded ahead of emission (`rewardRate × elapsed ≤ unreserved pool` at
all times) — i.e. top up before the reserve depletes, or cut `rewardRate`. That keeps the cap from binding and the
over-mint from occurring, buying time for the #2 migration. This is the operator decision `TODO_OPERATOR.md` already
flags as due before ~2026-10-11.

## Status

- ✅ Reproduced (`StakingRewardOverMint.t.sol`), not pushed. Extends the pre-deploy restaking finding to the live
  staking core.
- ☐ Operator: top-up / rate-cut before the reserve depletes (interim), then schedule the #2 Synthetix rebase.
