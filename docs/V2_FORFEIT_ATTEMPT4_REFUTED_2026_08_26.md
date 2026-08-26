# v2 distributor forfeit — attempt 4, REFUTED

**Branch `fix/v2-owner-timelocked-forfeit-v4`, commit `36f35ed8`. DO NOT MERGE.**

Attempt 4 was reviewed by six independent adversarial lenses, and each claimed defect was then
re-derived from scratch by a separate adjudicator that had to reproduce it or kill it. **Thirteen
claims adjudicated: 9 confirmed, 4 killed.** Attempt 4 joins attempts 1, 2 and 3.

`StreamingRevenueDistributor` **is deployed nowhere** — no entry in `frontend/scripts/addresses.json`,
no constant in `lib/constants.ts`. Nothing below is live money. All of it is pre-deploy.

The value of this document is that the next attempt starts from the refutation instead of
rediscovering it. Read it before writing attempt 5.

---

## What attempt 4 tried

Trunk lets **anyone** confiscate a staker's crystallised accrual: `sync`/`syncMany` carry no access
control and reach a forfeit that zeroes `rewards[account]`, and forfeited wei re-streams to the
remaining stakers — so a large staker is paid pro rata for confiscating everyone else. `3acd395b`
made that path fail *closed* on an unreadable read, which gated the **evidence** but never the
**caller**.

Attempt 4 made `sync` mirror-only and moved the forfeit behind `proposeForfeit` (onlyOwner) → 48h →
`executeForfeit`, keeping trunk's fail-closed ladder as a `view` called `_isForfeitable`.

The access-control half works and is not what was refuted. The eligibility half is.

---

## Confirmed — REGRESSIONS attempt 4 introduced

### R1. `_isForfeitable` judges liveness from stale state, so an active staker is forfeitable

**The defect.** `_isForfeitable` reads the account's current lock and *throws the value away* —
`(bool lockReadable, ) = _lockEndOf(account);` binds only the bool. Eligibility is then decided
against `effectiveBalanceOf[account]` (the **mirror**) and `lastObservedLockEnd[account]` (a **stale
anchor**). Neither is refreshed by the forfeit path, because making the check a `view` dropped the
`_updateReward` + `_observeLockEnd` writes that the old inline code performed immediately before
deciding.

**Consequence, with no attacker and no owner malice.** A staker whose lock expired, who was synced
once, who waited out the grace period and then **re-locked for ten years**, is forfeitable. Her
live voting power is non-zero and her lock is far-future at the instant of execute — through the
very escrow reads the ladder performs — and both the propose-time check and the 48h re-check wave
her through. She is only saved if somebody happens to call the permissionless `sync` on her, and
nothing in the UI or the contract tells a user that `sync` is what protects their money.

**This falsifies attempt 4's own central claims**, written into the source and the commit message:
"active stakers are unreachable by construction", and `executeForfeit`'s promise that 48h is long
enough "for a lock to be extended". The extended-lock half is simply false. `getReward` self-syncs
and would pay the same account in the same block — the two gates contradict each other.

*Confirmed by three adjudicators independently, each with its own mocks.*

### R2. Rewards that arrive **during** the 48h window are swept, with zero grace

A restaker never refreshes `lastObservedLockEnd` — custody zeroes `userTokenId`, so `_observeLockEnd`
records nothing. An account with a stale anchor that restakes mid-window, earns fresh ETH, and exits
becomes forfeitable the instant it exits. The new money gets **no part** of the documented 7-day
`CLAIM_GRACE_PERIOD`, and `getReward` refuses it in the same block.

Measured in the adjudicator's own fixture: owed at propose ≈ 5.0 ETH, owed at execute ≈ 6.37 ETH —
**~1.37 ETH arrived inside the window and was taken**. The money confiscated is therefore not the
abandoned money named at propose time, and `pendingForfeit()` names accounts but no amounts, so the
difference is invisible to a monitor watching the window.

### R3. Pause protects the cure paths but not the forfeit

`sync`, `syncMany`, `getReward` and `notifyRewardAmount` are all `whenNotPaused`. `proposeForfeit`,
`executeForfeit` and `cancelForfeit` carry `onlyOwner` and nothing else. So while the contract is
paused, a victim cannot sync herself, cannot claim, and cannot cure — and the forfeit still runs.
The adjudicator confirmed the mechanism and noted the root cause is mislocated by the obvious fix:
adding `whenNotPaused` to the forfeit alone does not close the loss.

---

## Confirmed — PRE-EXISTING on trunk, and **worse there**

These are not attempt 4's fault. They are true of `mvp-launch` today and must be fixed regardless of
which forfeit design wins.

### P1. A stranger can drive a victim's grace anchor **backwards**

`_observeLockEnd` **assigns** rather than takes a max:
`if (readable && lockEnd != 0) lastObservedLockEnd[account] = lockEnd;` — no `>` guard — and it is
reachable from the permissionless `sync`. The lockEnd it reads belongs to whatever `userTokenId[account]`
currently points at, and in `TegridyStaking` a stranger can repoint that by transferring a position
**in**: `StakingRewardLib.afterTokenTransfer` writes `userTokenId[to] = id` unconditionally, and its
`AlreadyHasPosition` guard fires only when `userTokenId[to] != 0` — which is exactly 0 for a victim
who has just withdrawn.

So Mallory stakes a dust position, lets it expire, transfers the dead veNFT to Alice (an ERC-721
transfer needs no consent), and calls `sync(alice)`. Alice's anchor is rewritten **backwards** to the
dust NFT's ancient lockEnd. That retroactively slams her `getReward` grace shut (`NoLockedTokens`)
**and** flips her from not-forfeitable to forfeitable.

The in-code defence — "any account with a second live position would have non-zero power and never be
recycled" — covers a second **live** position. It does not cover a second **expired** one, which
contributes zero voting power yet still hijacks the `userTokenId` pointer.

**On trunk this is a complete, stranger-executed theft**, because trunk's `sync` forfeits directly.
Attempt 4 reduces it to a stranger-*triggered* confiscation that still needs an owner and 48 hours —
milder, but the input the forfeit decides on remains stranger-writable.

### P2. A permissionless `sync` moves value **between** accounts without touching `rewards`

`_tryEffectivePower` collapses a reverting escrow or restaking read into `(false, 0)`; `_effectivePower`
discards `readable` and returns the zero; `_updateReward` writes it into `effectiveBalanceOf` and
subtracts it from `totalEffectiveSupply`. A co-staker calls `sync(victim)` while the read is failing
and does not sync himself: the victim's mirror goes to 0 and the whole stream re-prices onto him.
Accrual is non-retroactive, so re-syncing later does not give the window back.

One adjudicator measured a **22× amplification** — an attacker holding 1/51 of the power (fair share
0.137 ETH) took 3.078 ETH of a 7 ETH schedule via `syncMany` over 50 victims. The victim has no
defence: syncing herself reads the same failing source and also yields 0. It also ignores the staking
kill switch — with staking paused, `getReward` reverts `StakingPaused` and `notifyRewardAmount`
reverts, while a stranger's `sync` still rewrites the mirror the schedule pays out over.

Verified identical on trunk (the load-bearing functions are byte-identical; `sync` differs only in the
name of its internal callee), so this is not a regression. **It also falsifies attempt 4's claim that
"nothing reachable from `sync` can cost any account a wei."** It costs a victim real ETH while
touching neither `rewards` nor `totalForfeitedToPool`.

The honest form of that claim is narrower: *nothing reachable from `sync` can reduce `rewards[]` or
increase `totalForfeitedToPool`.* The wider claim is false and should not be repeated.

---

## Killed on adjudication — do not re-file these

- **"The 48h window is really up to 9 days."** Factually true (`TimelockAdmin.PROPOSAL_VALIDITY` is
  7 days on top of the 48h delay, last executable instant = propose + 9 days exactly) but rejected as
  a defect: the re-check at execute is what bounds the risk, not the calendar.
- **"Past-grace crystallisation by a stranger is a bug."** Reproduces, but describes the intended
  behaviour.
- **A restaking-entry claim** that conjured a restaker out of a dead lock — `TegridyRestaking.restake()`
  reverts `PositionExpired`, so the scenario cannot be reached.
- **A claim rejected because its causal half failed the counterfactual** and its observability half was
  factually wrong.

**A methodology note worth keeping.** One adjudicator found the *claimant's own numbers* were a harness
artefact: under this repo's `optimizer = true, via_ir = true`, solc treats `TIMESTAMP` as
transaction-constant and CSEs repeated `block.timestamp` reads, so `vm.warp` makes
`uint256 t0 = block.timestamp; vm.warp(t0 + 1 days); vm.warp(t0 + 4 days);` **cumulative**. Use
`vm.getBlockTimestamp()` in any test that warps more than once, or the scenario you measure is not the
scenario you wrote.

---

## What attempt 5 has to do

1. **Stop deciding eligibility from mirrors.** R1 is the whole lesson: a `view` that judges from
   `effectiveBalanceOf` and `lastObservedLockEnd` is judging a snapshot nobody refreshed. Either
   refresh inside the forfeit path (`_updateReward` + `_observeLockEnd` per account before deciding,
   which makes the check non-`view`), or decide from the **live** reads it already performs and
   discards.
2. **Fix the anchor before anything else (P1).** While `lastObservedLockEnd` can be driven backwards by
   a stranger, every design built on it inherits a stranger-writable input. A monotonic `max` guard is
   the obvious first move, but it must be checked against the legitimate case of a genuinely shorter
   new lock.
3. **Decide what an unreadable read means for the MIRROR, not just for the forfeit (P2).** `3acd395b`
   made the forfeit fail closed and left `_updateReward` writing unreadable zeros. That is the
   remaining hole and it is worth more than the forfeit design.
4. **Do not claim "cannot cost any account a wei"** until P2 is closed. Attempt 4 shipped that
   sentence in the source and it was false when written.

The access-control shape of attempt 4 — mirror-only `sync`, owner-timelocked forfeit, batch reject on
propose, per-account re-check with a visible skip count on execute — survived every lens and is worth
keeping. It is the eligibility input underneath it that is not sound yet.
