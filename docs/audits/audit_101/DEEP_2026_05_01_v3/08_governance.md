# Deep Governance Audit — Pass 3 (Post-V2 Re-Audit) — 2026-05-02

**Targets:** VoteIncentives, GaugeController, MemeBountyBoard, CommunityGrants
**Method:** Re-audit of the post-V2 code (commit `9410a44`) for next-tier regressions and gaps from the 12 fixes shipped against pass-2 findings.
**Baseline:** `.audit_101/DEEP_2026_05_01_v2/08_governance.md` (1 High, 4 Medium, 6 Low, 1 Info).

---

## Pass-2 Verification Summary

| Pass-2 ID | Status | Notes |
|---|---|---|
| V2-GOV-01 (committedPower lockup on pair-disable) | **Closed (with new gap — see V3-GOV-01)** | `forfeitCommitOnDisabledPair` decrements `committedPower`, refunds bond, and marks `c.revealed=true` (no double-claim via revealVote). But salt-leakage via failed `revealVote` calldata enables third-party grief (V3-GOV-04) and a forfeit-then-re-enable race traps voter power until next epoch (V3-GOV-05). |
| V2-GOV-02 (commitVote bond-burn on disabled pair) | **Closed** | Same forfeit path covers the pre-disable case. Hash-binding (`computeCommitHash`) prevents griefer from forfeiting the wrong commit. |
| V2-GOV-03 (past-epoch topWeight scan) | **Closed (with regression — see V3-GOV-02)** | Per-epoch `topGaugeByEpoch` cache supersedes the gauge-list scan, so historical reads stay correct. But `executeRemoveGaugeNextEpoch` orphans the gauge in `gaugeList` if a new `proposeRemoveGauge` overwrites `pendingGaugeRemove` before finalize runs — the orphan is non-removable and re-`proposeAddGauge` of the same address creates duplicates in `gaugeList`. |
| V2-GOV-04 (option-b leak) | **Closed in name; introduced new HIGH amplification — see V3-GOV-03** | True renormalization (option-a) preserves `sum(relativeWeight) == BPS` exactly when `othersTotal > 0`. But the redistribution formula `(gw * (BPS - cap)) / othersTotal` over-amplifies tiny non-top voters when `othersTotal` is small. Worst case: a 1-wei voter who is the ONLY non-top voter receives the full 50% surplus. Also leaves a **hard 50% leak** when only one gauge has weight (V3-GOV-06). |
| V2-GOV-05 (O(n) topWeight scan) | **Closed** | `topWeightByEpoch` cache + `_updateEpochTop` restore O(1) per-call cost. Cache is monotonic-only (gauge weights never decrement), so no stale-cache race. |
| V2-GOV-06 (isRevealWindowOpen view) | **Closed** | `isRevealWindowOpenFor(tokenId)` view mirrors the trailing-grace look-back logic in `revealVote` exactly. |
| V2-GOV-07 (voter veto on gauge removal) | **Closed (with regression — see V3-GOV-02)** | New `executeRemoveGaugeNextEpoch` + `executeRemoveGaugeFinalize` path immediately disarms `isGauge` so future votes revert. But the same path opens the orphaning regression above. |
| V2-GOV-08 (sock-puppet leader lock) | **Closed (with residual — see V3-GOV-07)** | `hasEstablishedLeader` gate (≥`MIN_COMPLETION_VOTES`) prevents a 1000-TOWELI sock-puppet from locking in a tiny leader. Residual: an attacker with ≥3000 TOWELI can still vote-mob a chosen submission across the threshold AT THE START OF FREEZE to lock it in. |
| V2-GOV-09 (1-day-deadline cancel hole) | **Closed** | `effectiveCancelDelay = bountyDuration - 1h` for short bounties leaves a 1h cancel window even on minimum-deadline bounties. |
| V2-GOV-10 (commit/reveal cap asymmetry) | **Closed** | Reveal-time cap now reads `committedPower[user][epoch]` (the commit-time clamp) instead of re-sampling `min(historical, current)`, so divestment between commit and reveal no longer kills the reveal. |
| V2-GOV-11 (holdsToken catch fallback) | **Closed (with degradation — see V3-GOV-08)** | Catch branch now reverts `HoldsTokenCheckFailed` instead of falling through to the broken single-pointer check. But this fails-closed against ALL voters until the staking contract is restored — a cheap reverting upgrade can DoS every Active proposal vote for the duration. |
| V2-GOV-12 (failed-transfer rolling-window bookkeeping) | **Closed (documented)** | NatSpec now explicitly says the rolling window tracks SUCCESSFULLY DISBURSED ETH. Retry semantics align with the primary path. |

---

## Severity counts (this pass)

| Severity | Count |
|---|---|
| Critical | 0 |
| High | 2 |
| Medium | 3 |
| Low | 3 |
| Info | 1 |

---

## [V3-GOV-01] `forfeitCommitOnDisabledPair` post-`sweepForfeitedBond` divergence — bond griefed twice
**Severity:** Low
**File:** `contracts/src/VoteIncentives.sol:1458-1515, 1523-1543`
**Category:** gov
**Pass-2 ref:** V2-GOV-01 (regression follow-up)

**Bug:**
`sweepForfeitedBond` sets `c.bond = 0` but does NOT set `c.revealed = true` (line 1532-1542). After a sweep, the commit is still in the "un-revealed but bondless" state. A subsequent call to `forfeitCommitOnDisabledPair` for the same `(user, epoch, commitIndex)` then succeeds because:
- `c.revealed` check at L1473 still passes (false).
- `c.bond` read at L1490 is 0 (already swept to treasury).
- `power` decrement on `committedPower` runs at L1495.
- The `if (bond > 0)` transfer block at L1506 is skipped (bond is 0).

The forfeit "succeeds" but does nothing useful — `committedPower` is decremented post-revealDeadline (when commits can no longer be re-placed because `commitDeadline` has long passed), so the decrement is a no-op semantically. The voter has lost both the bond (to treasury, via sweep) AND wasted gas on the forfeit call. Net: cosmetic redundancy that consumes gas with no recoverable benefit, AND the `CommitForfeitedOnDisabledPair` event emits with `bond=0` which is misleading ("Forfeited on disabled pair" implies a refund, but none happened).

**Attack / Impact:**
A naive voter who sees the disabled-pair refund path advertised in NatSpec calls `forfeitCommitOnDisabledPair` after `sweepForfeitedBond` has already run and pays gas for a no-op. Off-chain analytics that key off the `CommitForfeitedOnDisabledPair` event count this as a refund event when it is in fact a double-zero. Audit comment at L1497-1501 marks the underflow guard as "cannot happen under current logic" — it currently does not happen, but the missing `c.revealed` set in sweep means the function entry is reachable post-sweep.

**Evidence:**
```solidity
// L1532-1542 (sweepForfeitedBond)
if (c.revealed) revert AlreadyRevealed();  // already refunded to user
uint96 bond = c.bond;
if (bond == 0) revert BondAlreadyClaimed();

c.bond = 0;
// ↑ c.revealed is NOT set, so forfeit can re-enter

// L1473, L1495 (forfeitCommitOnDisabledPair)
if (c.revealed) revert AlreadyRevealed();   // false → passes
// ...
if (committedPower[user][epoch] >= power) {
    committedPower[user][epoch] -= power;   // runs against now-stale state
}
```

**Recommendation:**
Either (a) set `c.revealed = true` inside `sweepForfeitedBond` so the slot is fully terminal, mirroring the forfeit path's terminal write, or (b) add `if (c.bond == 0) revert BondAlreadyClaimed();` to `forfeitCommitOnDisabledPair` after the existing checks so a double-call after sweep fails loudly. Option (a) is simpler and uniform with the rest of the slot-lifecycle.

---

## [V3-GOV-02] `executeRemoveGaugeNextEpoch` orphans the gauge in `gaugeList` if a new `proposeRemoveGauge` overwrites `pendingGaugeRemove`
**Severity:** Medium
**File:** `contracts/src/GaugeController.sol:759-823, 832-850`
**Category:** gov
**Pass-2 ref:** V2-GOV-07 (regression)

**Bug:**
`executeRemoveGaugeNextEpoch` flips `isGauge[gauge] = false` and INTENTIONALLY leaves `pendingGaugeRemove = gauge` so the deferred `executeRemoveGaugeFinalize` knows which gauge to prune from `gaugeList`. But it calls `_execute(GAUGE_REMOVE)` first, which clears `_executeAfter[GAUGE_REMOVE]`. The `proposeRemoveGauge` slot is now free.

If the owner proposes a different gauge for removal BEFORE calling `executeRemoveGaugeFinalize`, the new `proposeRemoveGauge(G3)` overwrites `pendingGaugeRemove = G3`. The previous orphan G2 is now permanently un-recoverable from `gaugeList`:
- `proposeRemoveGauge(G2)` reverts at `if (!isGauge[gauge]) revert GaugeDoesNotExist();` because G2 was disarmed.
- `executeRemoveGaugeFinalize` reads `pendingGaugeRemove = G3`, not G2, and reverts at `if (isGauge[gauge]) revert GaugeAlreadyExists();` because G3 is still active.

Compounding regression: `executeAddGauge` does NOT check whether `gauge` is already in `gaugeList`. So if owner later calls `proposeAddGauge(G2)` (legal because `isGauge[G2]==false` and `gaugeList.length < MAX_TOTAL_GAUGES`), `executeAddGauge` does `gaugeList.push(G2)` — now G2 appears TWICE in `gaugeList`. `getGauges()` returns duplicates; subsequent `executeRemoveGauge` only removes one instance via swap-and-pop.

**Attack / Impact:**
Operational governance error — owner's natural workflow (propose-remove G2, defer via NextEpoch, propose-remove G3 to handle a separate issue) silently leaves G2 in `gaugeList` forever. Eats into `MAX_TOTAL_GAUGES = 50` capacity. Each duplicate-add via the re-add path further inflates the list. Off-chain UIs display duplicate entries. The gauge's `gaugeWeightByEpoch` for past epochs continues to factor into `total` for relative-weight reads but its 0-weight in current/future epochs makes the contract behave as if it's removed — internally inconsistent.

**Evidence:**
```solidity
// GaugeController.sol:814-823 (executeRemoveGaugeNextEpoch)
function executeRemoveGaugeNextEpoch() external onlyOwner {
    _execute(GAUGE_REMOVE);  // ← clears _executeAfter[GAUGE_REMOVE]
    address gauge = pendingGaugeRemove;
    isGauge[gauge] = false;
    // pendingGaugeRemove is INTENTIONALLY left set so finalize knows which
    // gauge to prune from gaugeList. emit signals the change is staged.
    emit GaugeRemoved(gauge);
}

// GaugeController.sol:759-764 (proposeRemoveGauge)
function proposeRemoveGauge(address gauge) external onlyOwner {
    if (!isGauge[gauge]) revert GaugeDoesNotExist();
    pendingGaugeRemove = gauge;  // ← overwrites the orphan G2 with G3
    _propose(GAUGE_REMOVE, GAUGE_TIMELOCK);
    ...
}

// GaugeController.sol:745-752 (executeAddGauge — no in-list check)
function executeAddGauge() external onlyOwner {
    _execute(GAUGE_ADD);
    address gauge = pendingGaugeAdd;
    isGauge[gauge] = true;
    gaugeList.push(gauge);  // ← can push a duplicate when gauge is already
                            //    in the list (orphaned re-add).
    pendingGaugeAdd = address(0);
    emit GaugeAdded(gauge);
}
```

**Recommendation:**
Three layered fixes:
1. **Stage the orphan separately**: introduce a `pendingGaugeFinalize` storage slot (separate from `pendingGaugeRemove`). `executeRemoveGaugeNextEpoch` sets `pendingGaugeFinalize = pendingGaugeRemove; pendingGaugeRemove = address(0);`. `executeRemoveGaugeFinalize` reads from `pendingGaugeFinalize`. New `proposeRemoveGauge` then can't disturb the in-flight finalize.
2. **`proposeRemoveGauge` should refuse while a finalize is pending**: `if (pendingGaugeFinalize != address(0)) revert PreviousRemovalNotFinalized();`
3. **`executeAddGauge` should refuse if `gauge` already appears in `gaugeList`**: cheap O(n) scan in the add path, or maintain a `bool` `gaugeListContains[gauge]` to make it O(1).

The Curve `GaugeController` pattern is to never remove from the historical gauge set — use `kill_gauge` which sets a "dead" flag instead. If list-pruning is required, a per-removal storage slot avoids the overwrite.

---

## [V3-GOV-03] True-renormalization formula amplifies tiny non-top voters when `othersTotal` is small
**Severity:** High
**File:** `contracts/src/GaugeController.sol:666-704`
**Category:** gov
**Pass-2 ref:** V2-GOV-04 (re-introduced exploit)

**Bug:**
The V2 audit's recommendation for option-a (true renormalization) was implemented at L692-703:
```solidity
if (gauge == topGauge) return cap;             // Top capped exactly at 5000
uint256 othersTotal = total - topWeight;
if (othersTotal == 0) return 0;
return (gw * (BPS - cap)) / othersTotal;       // Distribute 5000 BPS surplus
```

This correctly enforces `sum(relativeWeight) == BPS` for the multi-gauge case. But the formula `(gw * (BPS - cap)) / othersTotal` is a per-non-top-gauge multiplier of `(BPS - cap) / othersTotal` ≈ `5000 / othersTotal`. As `othersTotal` shrinks toward 1, the multiplier grows unbounded. **A single 1-wei voter on a non-top gauge can harvest the entire 50% surplus** if no other non-top voters exist.

Worked example (realistic):
- Honest voters: 800k power on G1 (popular gauge).
- Attacker: 1 wei power on G99 (an obscure gauge; attacker is the only voter for it).
- All other voters: 199k power across G2-G10.

If the attacker times their G99 vote to land BEFORE the other 199k votes (front-run), at that instant `total = 800001`, `topWeight = 800k`, `othersTotal = 1`. `getRelativeWeight(G99) = (1 * 5000) / 1 = 5000 BPS = 50% of emissions`. The attacker captures 50% of the epoch's emissions for G99 with effectively zero stake.

Even after the 199k of honest votes land (changing `othersTotal` to ~199k), `getRelativeWeight(G99) = (1 * 5000) / 199001 ≈ 0 BPS` — but the cap fires INSTANTANEOUSLY for whoever READS `getRelativeWeight` at the right moment. If a downstream emission distributor `notifyRewardAmount`s based on the cap-fired snapshot, the attacker's gauge captures a 50% allocation that no one else can reverse.

**Attack / Impact:**
- Token-economic exploit: an attacker with infinitesimal stake can siphon up to 50% of `emissionBudget` to a gauge they control (a malicious LP pool, a self-owned farm contract).
- Multi-block timing: even if `othersTotal` grows large by epoch end, downstream consumers that cache mid-epoch reads (or a single read at any moment) get a wrong value. The relative-weight read is a view, callable by any keeper at any block — there's no temporal smoothing.
- The same attack vector exists in reverse: a HONEST tiny voter who happens to be the only non-top voter receives a windfall they didn't earn, distorting the emission market against larger voters.

**Evidence:**
```solidity
// GaugeController.sol:692-703
if (gauge == topGauge) return cap; // Top is capped exactly.

uint256 othersTotal = total - topWeight;
if (othersTotal == 0) return 0;
return (gw * (BPS - cap)) / othersTotal;
// ↑ When othersTotal == 1 and gw == 1, returns 5000 BPS regardless of how
//   tiny the absolute stake is. The 50% surplus is fully captured by a
//   single 1-wei voter.
```

Numeric verification:
| Top stake | Others total | Attacker gw | Attacker share |
|---|---|---|---|
| 800k | 1 | 1 | 50% |
| 800k | 2 | 1 | 25% |
| 800k | 100 | 1 | 0.5% |
| 800k | 200k | 1 | 0.0025% |

The exploit window scales inversely with `othersTotal`. A protocol with N gauges each receiving honest votes makes the attack impractical, but any deployment with a long-tail of unvoted-on gauges has at least one capture point per epoch.

**Recommendation:**
Combine the renormalization with a per-voter (or per-gauge) FLOOR on the absolute stake required to participate in the surplus pool. Two patterns of record:
- (a) **Velodrome-style**: only redistribute the over-cap to gauges with weight ≥ `MIN_QUORUM_WEIGHT` (e.g., 1% of total). Tiny gauges get their `gw * BPS / total` raw share without amplification; surplus only flows to "real" non-top gauges.
- (b) **Bounded-amplifier formula**: cap the per-gauge multiplier so `relativeWeight <= 2 * (gw * BPS / total)`. Tiny voters can at most double their raw share, regardless of `othersTotal`.
- (c) **Quorum on the surplus**: refuse renormalization entirely if `othersTotal < total / 10` (i.e. dominant gauge >90%). Just leak the surplus when no meaningful "other" voters exist.

Option (a) preserves the exact-BPS-sum property under organic voting and prevents the amplification under adversarial concentration. Option (c) leaks emissions in extreme dominance cases (acceptable trade since 99-1 splits are usually adversarial anyway).

Pattern check: Velodrome's `gauge_relative_weight_write` includes a `min_relative_weight_threshold` for receiving surplus distribution.

---

## [V3-GOV-04] Salt leakage via failed `revealVote` calldata enables third-party `forfeitCommitOnDisabledPair` grief
**Severity:** Medium
**File:** `contracts/src/VoteIncentives.sol:1458-1515`
**Category:** gov
**Pass-2 ref:** V2-GOV-01 (post-fix surface)

**Bug:**
`forfeitCommitOnDisabledPair` accepts `(user, epoch, commitIndex, pair, power, salt)` from any caller and validates them against `c.commitHash`. The hash check is the proof-of-knowledge, so the `user` parameter cannot be spoofed. But the `salt` is supposed to be SECRET — it's the only thing keeping the commit private until reveal.

If the user calls `revealVote(...)` and it reverts (because `_validatePair(pair)` revert with `PairDisabled`), the failed transaction's calldata still contains the salt and pair plaintext. This is publicly observable from:
- Mempool watchers (live txs).
- Block explorers (post-mining failed txs are stored as part of the block).
- RPC archives.

Once the salt is leaked, ANY observer can call `forfeitCommitOnDisabledPair(user, epoch, commitIndex, pair, power, salt)`. The commit is consumed (`c.revealed = true`), the bond is refunded TO THE USER (financially neutral for the user), but the user's option to wait for pair re-enable is destroyed. If the pair is re-enabled before `commitDeadline` passes again, the user could otherwise have called `revealVote` to apply their vote. After the third-party forfeit, the slot is dead.

**Attack / Impact:**
Vote-suppression grief: a competitor watches the mempool for failed `revealVote` txs and immediately fires `forfeitCommitOnDisabledPair` for each. Bond goes to the user (no theft), but the user's vote weight is permanently removed from this epoch even if the pair recovers. Multiplied across many voters who attempted to reveal during a brief disable window, this can shift gauge dominance entirely.

Worse: an attacker with insider knowledge of an upcoming re-enable could deliberately spam-forfeit committed votes for the SOON-to-be-re-enabled pair, ensuring those voters can't reveal once the pair is back.

**Evidence:**
```solidity
// VoteIncentives.sol:1458-1465 (forfeitCommitOnDisabledPair signature)
function forfeitCommitOnDisabledPair(
    address user,        // ← any caller can specify any user
    uint256 epoch,
    uint256 commitIndex,
    address pair,        // ← needs to match the hash
    uint256 power,       // ← needs to match the hash
    bytes32 salt         // ← needs to match the hash; leaked from failed revealVote
) external nonReentrant whenNotPaused {
    ...
}

// Salt-leakage source: revealVote at L1357-1390 takes the same (pair, power, salt)
// arguments. A failed call leaves them in the failed-tx calldata.
```

**Recommendation:**
Restrict `forfeitCommitOnDisabledPair` to `msg.sender == user` (require self-call), OR keep permissionless but add a 1-hour cool-down so the original committer has the first opportunity to forfeit on their own terms. The cool-down preserves the keeper-pattern (anyone can clean up after a delay) while blocking front-run grief. Pattern: ENS `setName` cooldown for permissionless mutations.

Alternative defensive: allow third-party callers but require BOTH the salt AND a signature from `user` over `(epoch, commitIndex)` proving the user explicitly authorized the unwind. EIP-712 with a 1h validity window keeps the keeper pattern functional without exposing every salt-leaked voter.

---

## [V3-GOV-05] Forfeit-then-re-enable race traps voter power for the rest of the epoch
**Severity:** Medium
**File:** `contracts/src/VoteIncentives.sol:1308-1348, 1458-1515`
**Category:** gov
**Pass-2 ref:** V2-GOV-01 (timing edge case)

**Bug:**
A voter who calls `forfeitCommitOnDisabledPair` correctly during a pair-disable window terminates their commit (`c.revealed = true`, bond refunded, `committedPower` decremented). If the pair is RE-ENABLED later (via the timelocked `proposePairDisabled(false)` → 48h → `executePairDisabled` flow at TegridyFactory L391-409), the voter would normally want to re-commit and reveal for the now-live pair.

But `commitDeadline(epoch) = epoch.timestamp + (VOTE_DEADLINE * COMMIT_RATIO_BPS) / BPS` is fixed at 40% of the 7-day vote window (~2.8 days from epoch start). If the voter forfeited AFTER this deadline (which is the common case — disable usually happens mid-week, voters notice and act in the reveal window), they cannot re-commit. The decremented `committedPower` is freed but useless.

Even MORE pathological: if the voter forfeited DURING the commit window (early), and the pair is re-enabled BEFORE `commitDeadline`, the voter CAN re-commit. But there's no on-chain signal that re-enable happened — voters poll `factory.disabledPairs(pair)` off-chain at their own cadence, and many will not check until they intend to vote.

**Attack / Impact:**
Vote-loss for diligent voters who use the forfeit escape hatch the moment they see a disable. A coordinated guardian + governance attack (disable, forfeit-trigger via salt-leak grief from V3-GOV-04, re-enable via 48h timelock) systematically denies vote weight to specific gauges over a multi-epoch horizon.

Even uncoordinated: a guardian who panics and disables a pair on a false alarm, then re-enables 24h later, has caused permanent vote loss for every voter who forfeited.

**Evidence:**
```solidity
// commitDeadline is fixed at epoch creation; no extension on re-enable.
function commitDeadline(uint256 epoch) public view returns (uint256) {
    if (epoch >= epochs.length) revert InvalidEpoch();
    return epochs[epoch].timestamp + (VOTE_DEADLINE * COMMIT_RATIO_BPS) / BPS;
}

// commitVote refuses if past deadline:
// L1316: if (block.timestamp > commitDeadline(epoch)) revert CommitDeadlinePassed();
```

**Recommendation:**
Two options:
- (a) **Track per-pair re-enable events**: when `factory.disabledPairs(pair)` flips from true→false within an epoch, GRANT each voter who forfeited THIS pair this epoch a one-time "re-commit" slot with extended commit window for ONLY that pair. Storage: `mapping(epoch => mapping(pair => uint256 reenabledAt))`.
- (b) **Don't auto-mark `revealed=true` in forfeit; instead refund bond and keep slot alive**: rename to `recallBondOnDisabledPair`. If the pair re-enables before `commitDeadline + GRACE`, voter can call `recommitAfterRefund(epoch, commitIndex, newPair, newPower, newSalt)` to refresh. This is more complex but fully recovers the voter's option.

Option (a) is simpler. Option (b) is more correct but adds significant state. At minimum, document the trap in `forfeitCommitOnDisabledPair` NatSpec so voters understand they're trading a bond refund for permanent epoch vote loss.

---

## [V3-GOV-06] Renormalization leaks 50% of emissions when only one gauge has any votes
**Severity:** High
**File:** `contracts/src/GaugeController.sol:666-704`
**Category:** gov
**Pass-2 ref:** V2-GOV-04 (incomplete fix)

**Bug:**
The V2 fix promised "exact-distributes BPS" via true renormalization. This holds when `othersTotal > 0`. But when only ONE gauge has any votes in an epoch (`othersTotal == 0`), the function returns 0 for non-top gauges (line 699-701) and `cap = 5000` for the top gauge. **Sum = 5000 = 50% of `emissionBudget` is silently dropped** — exactly the original DEEP-GOV-03 leak the V2 fix was supposed to close.

This is the common case for early-life protocols, single-pool deployments, or epochs where governance has converged on one preferred gauge. It is also the worst case the H14 cap was designed to mitigate (the original "single gauge dominates" attack scenario), and it fails the budget-invariant promise that the V2 audit flagged for this very reason.

**Attack / Impact:**
- New protocol launches: typically have 1-3 gauges initially. If voters cluster on one (which they do, because emissions concentrate on the most popular pool), 50% of emissions never get distributed.
- Established protocol with periodic 1-gauge dominance: any week where one gauge captures 100% of votes, the protocol pays 100k TOWELI of `emissionBudget` but only 50k actually reaches a gauge. Over 52 weeks of rare 1-gauge weeks, mid-six-figures of TOWELI silently retained vs. published budget.

The H14 audit comment claims "over-emission against the budget cannot occur" — true, but UNDER-emission certainly can, and consumers of `getGaugeEmission(gauge)` cannot detect this without summing across all gauges.

**Evidence:**
```solidity
// GaugeController.sol:692-703
if (gauge == topGauge) return cap; // Top is capped at 5000 BPS
uint256 othersTotal = total - topWeight;
if (othersTotal == 0) {
    return 0;  // ← non-top gauges get 0; budget surplus is silently dropped
}
return (gw * (BPS - cap)) / othersTotal;
```

Numeric verification (single gauge, weight = 100):
- `total = 100`, `topWeight = 100`, `topGauge = G1`.
- `topRaw = 10000 > 5000` → renormalization branch.
- `getRelativeWeight(G1)` = 5000 BPS (capped).
- `othersTotal = 0` → all other gauges return 0.
- Sum = 5000 BPS. **50% of `emissionBudget` un-distributed.**

The pre-V2 option-b had the same 50% leak in this case. The V2 fix was supposed to close it but doesn't when `othersTotal == 0`. The audit comment that "exact-distributes BPS" is materially misleading.

**Recommendation:**
Two options:
- (a) **Special-case the single-gauge scenario**: when `othersTotal == 0`, return `BPS` for the top gauge (skip cap entirely). Rationale: the cap exists to prevent ONE gauge from monopolizing emissions when others exist; if no others exist, the cap is moot. This restores the budget invariant.
- (b) **Mint-back-the-leak path**: track `unallocatedEmissionsByEpoch[epoch]` = `(BPS - sum(allRelativeWeights)) * emissionBudget / BPS`. Owner can recover and redistribute via a timelocked `recoverUnallocatedEmissions` path. More complex but preserves the dilution intent.

Option (a) is simpler and matches the documented behavior. Option (b) is more conservative but adds storage + governance overhead.

The current behavior is effectively "the 50% cap silently penalizes single-gauge consensus" — un-documented, un-tested (the regression test at `Deep_Governance_2026_05_01.t.sol:265` only asserts `sum <= BPS`, not equality), and economically wasteful.

---

## [V3-GOV-07] V2-GOV-08 fix doesn't prevent in-freeze leader-lock by mid-tier attackers
**Severity:** Low
**File:** `contracts/src/MemeBountyBoard.sol:478-488`
**Category:** gov
**Pass-2 ref:** V2-GOV-08 (residual)

**Bug:**
The V2 fix added `hasEstablishedLeader` (`topSubmissionVotes >= MIN_COMPLETION_VOTES = 3000 TOWELI`) to the freeze check. Pre-freeze sock-puppets with only `MIN_VOTE_BALANCE = 1000 TOWELI` can no longer lock in tiny leaders. But an attacker with ≥3000 TOWELI of voting power can still execute the original DEEP-GOV-04 attack:

1. Pre-freeze: legitimate Submission #1 has 100 TOWELI of votes. Submission #2 (attacker's preferred) has 0.
2. Attacker waits until `inFreeze` becomes true (24h before deadline).
3. Within freeze: attacker votes 3001 TOWELI for Submission #2 → `newVotes(3001) > topVotes(100)`. `hasEstablishedLeader = topVotes(100) >= 3000` is FALSE. Promotion runs → topSub=2, topVotes=3001. `hasEstablishedLeader` is now TRUE.
4. Subsequent legitimate voters who prefer Submission #1 cannot displace #2 within freeze (the freeze gate locks #2 in).

The fix only prevents PRE-FREEZE sock-puppet locks. Mid-freeze coordination still works. Required attacker stake is 3000 TOWELI (and 3 unique voter addresses to satisfy `MIN_UNIQUE_VOTERS`).

**Attack / Impact:**
Bounty griefing: attacker with 3000+ TOWELI can force a chosen submission to win over a more-popular alternative if they time their vote within the freeze window. The "more-popular alternative" cannot displace the attacker's pick even with 100x more honest votes. Damage: bounty creator pays for an unwanted submission; intended winner is unpaid.

**Evidence:**
```solidity
// MemeBountyBoard.sol:478-488
bool inFreeze = block.timestamp + TOP_FREEZE_WINDOW >= bounties[_bountyId].deadline;
if (newVotes > topSubmissionVotes[_bountyId]) {
    bool hasEstablishedLeader = topSubmissionVotes[_bountyId] >= MIN_COMPLETION_VOTES;
    if (!inFreeze || !hasEstablishedLeader || _submissionId == topSubmissionId[_bountyId]) {
        topSubmissionVotes[_bountyId] = newVotes;
        topSubmissionId[_bountyId] = _submissionId;
    }
}
// ↑ Attacker's first in-freeze vote that crosses MIN_COMPLETION_VOTES
//   establishes the leader BEFORE the freeze gate kicks in.
```

**Recommendation:**
Move the freeze check to a different anchor: instead of "freeze applies once a leader is established", apply it as "freeze applies once any submission has been the leader for ≥`TOP_FREEZE_WINDOW`". Track `topSubmissionEstablishedAt[bountyId]` updated whenever a new submission becomes top. The freeze gate becomes:
```solidity
bool establishedLongEnough = topSubmissionEstablishedAt[_bountyId] != 0 &&
    block.timestamp >= topSubmissionEstablishedAt[_bountyId] + TOP_FREEZE_WINDOW;
if (!inFreeze || !establishedLongEnough || _submissionId == topSubmissionId[_bountyId]) {
    // promote
    topSubmissionEstablishedAt[_bountyId] = block.timestamp;  // reset on each promotion
}
```

This means a leader has to maintain its top position for at least 24h (uninterrupted by promotion) before the freeze locks it in. An in-freeze attacker who promotes a fresh leader cannot benefit from freeze protection because their leader is brand-new.

---

## [V3-GOV-08] V2-GOV-11 fail-closed can DoS every Active proposal vote during a staking-contract upgrade
**Severity:** Low
**File:** `contracts/src/CommunityGrants.sol:362-370`
**Category:** gov
**Pass-2 ref:** V2-GOV-11 (over-correction)

**Bug:**
The V2 fix removed the `try/catch` fallback from `holdsToken` and now reverts `HoldsTokenCheckFailed` if the call reverts. Correct closure of the M13 sybil bypass. But now ANY revert from `holdsToken` blocks ALL voters on every Active proposal until the staking contract is restored.

If the staking contract is paused, gas-griefed (via a contract-owner upgrade that adds an OOG path), or genuinely upgraded with breaking ABI, every `voteOnProposal` call across the entire CommunityGrants contract reverts. With `VOTING_PERIOD = 7 days` and a 48h staking-contract upgrade window, an upgrade timed around an Active proposal's voting period silently kills participation. The proposal lapses or fails quorum (`MIN_QUORUM_BPS = 10%`), which auto-rejects on `finalizeProposal` and refunds the deposit — proposer loses 7 days of effort.

Worse: a malicious staking-contract owner who wants to censor a specific governance proposal can intentionally upgrade or pause during that proposal's voting window.

**Attack / Impact:**
Grant censorship via cross-contract DoS. The staking-contract owner is timelocked and accountable, but the timelock window (typically 48h) is enough to paint a 7-day voting period into the censored zone. CommunityGrants has no fallback — votes simply fail.

**Evidence:**
```solidity
// CommunityGrants.sol:362-370
if (proposal.proposerTokenId != 0) {
    bool holds;
    try votingEscrow.holdsToken(msg.sender, proposal.proposerTokenId) returns (bool h) {
        holds = h;
    } catch {
        revert HoldsTokenCheckFailed();  // ← blocks ALL voters
    }
    require(!holds, "PROPOSER_POSITION_CANNOT_VOTE");
}
```

**Recommendation:**
Two options:
- (a) **Voter-side opt-out**: if `holdsToken` reverts, allow the voter to skip the proposer-self-vote check ONLY if they cryptographically prove they aren't the proposer (e.g., `msg.sender != proposal.proposer` is already checked at L347). Since the proposer themselves is also blocked at L347, the only attack vector for a sybil who routed an NFT is the proposer's controlled address. A voter who is provably DIFFERENT from the proposer can vote with their own current `votingPowerOf` without the holds check, accepting the residual M13 risk for the duration of the upgrade.
- (b) **Stale snapshot fallback**: cache the proposer's `holdsToken` result at proposal creation against ALL known stakers as of that block. Future votes check the snapshot. Doesn't catch new stakers but doesn't DoS during upgrades. Adds significant gas cost per proposal.

Option (a) is cheaper. Both are imperfect. The cleanest fix is to make `votingEscrow.holdsToken` itself robust against upgrade by adding a `try/catch` inside the staking contract that returns `false` instead of reverting. The CommunityGrants contract then never sees a revert.

Pattern: Snapshot off-chain governance handles staking-contract unavailability via "best-effort" voting power resolution; UIs warn users but don't block the vote.

---

## [V3-GOV-09] `executeRemoveGaugeNextEpoch` lets a hostile gauge keep receiving emissions for up to 7 days
**Severity:** Info
**File:** `contracts/src/GaugeController.sol:814-823`
**Category:** gov
**Pass-2 ref:** V2-GOV-07 (design tradeoff documented as info)

**Bug:**
The "next-epoch" path documented behavior is "current-epoch's emissions still distribute against the cast votes (no retroactive change) — only future votes are blocked". But this means a HOSTILE gauge (e.g., a discovered-malicious LP pool whose `notifyRewardAmount` siphons TOWELI to attacker) continues to receive its share of `emissionBudget` for the remainder of the current epoch. With 7-day epochs, that's up to 7 days of uninterrupted emissions to the hostile gauge.

The owner's only options are:
- Wait for epoch end (up to 7 days). Accept the leak.
- `pause()` the entire GaugeController. Blocks all voting and all emission distribution. Heavy hammer; disrupts honest users.
- (Hypothetical) — `proposeEmissionBudgetChange(0)` → 48h delay → execute. Blocks new emissions but the current epoch's accrued allocation may already be claimable by the hostile gauge.

This is documented as intentional, but the audit flag is the GAP between the documented behavior and a real exploit response need.

**Attack / Impact:**
Any gauge compromise has a multi-day exploit window before owners can fully shut it down. If the gauge is used in a borrow protocol or restaking integration, the attacker can keep extracting yield until epoch end.

**Recommendation:**
Add an emergency-only path that REVERTS the gauge's emission claim by zeroing `gaugeWeightByEpoch[currentEpoch][gauge]` AND adjusting `totalWeightByEpoch[currentEpoch]` by the same amount. Permissions: 24h timelocked + multisig + a separate emergency-removal key (not the standard owner). Pattern: Compound `_setMintPaused` for cToken-level emergency stop without freezing the entire protocol.

If full reversion is too aggressive, at minimum allow `emergencyZeroGaugeWeight(gauge)` that nullifies CURRENT-epoch weight only, leaving past epochs intact. Other gauges' relative weights then re-normalize to absorb the share.

---

## Summary

- **High:** 2 (V3-GOV-03 amplification of tiny non-top voters, V3-GOV-06 single-gauge 50% leak)
- **Medium:** 3 (V3-GOV-02 orphan + duplicate-add, V3-GOV-04 salt-leak grief, V3-GOV-05 forfeit-then-re-enable trap)
- **Low:** 3 (V3-GOV-01 sweep-then-forfeit no-op, V3-GOV-07 mid-freeze leader lock, V3-GOV-08 cross-contract DoS)
- **Info:** 1 (V3-GOV-09 hostile-gauge emission window)

**Top priorities:**
1. **V3-GOV-03** — true-renormalization gives tiny non-top voters disproportionate emission share; bound the per-gauge multiplier or apply a quorum threshold for surplus eligibility.
2. **V3-GOV-06** — single-gauge case still leaks 50% of emissions. Special-case `othersTotal == 0` to return `BPS` for the top gauge.
3. **V3-GOV-02** — `executeRemoveGaugeNextEpoch` orphans gauges in `gaugeList` if a new propose overwrites `pendingGaugeRemove`. Stage the orphan in a separate slot AND make `executeAddGauge` reject duplicates.
4. **V3-GOV-04** — salt-leakage from failed `revealVote` enables third-party `forfeitCommitOnDisabledPair` grief. Restrict to self-call OR add a 1h cool-down for keeper unwinds.
5. **V3-GOV-05** — voters who forfeit early lose all epoch participation if the pair is re-enabled. Track per-pair re-enable events + extend commit window.
