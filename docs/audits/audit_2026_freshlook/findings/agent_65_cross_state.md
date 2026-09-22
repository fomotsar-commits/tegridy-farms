# Agent 65 — Cross-Contract State Inconsistency / Race Conditions

**Lens:** Two-contract state agreement at boundaries, race windows, NFT-ownership desyncs, Trace208 vs live read divergence, pause-asymmetry, multi-step setter wiring windows, deployment-order wiring races, veTOWELI rotation between sources.

**Working dir:** `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\contracts\src`
**Mode:** Read-only

---

## F-65-1 — Restaking-Contract Rotation Strands NFTs, Rewards & Per-tokenId Buckets in Old Restaking Contract (HIGH)

**Files / Lines**
- `TegridyStaking.sol:1967-1970` — `applyRestakingContract(_restaking)` (NO `balanceOf(oldR) > 0` guard)
- `TegridyStaking.sol:1682-1686` — `_isTrackedHolder(holder)` reads `restakingContract` LIVE
- `TegridyStaking.sol:1310-1320` — `_beforeTokenTransfer` cooldown / rate-limit gating uses LIVE `restakingContract`
- `TegridyStaking.sol:1347-1352` — `AlreadyHasPosition` guard exempts only `isLendingContract[from]`, NOT old restaking contract
- `TegridyStaking.sol:1357-1359` — `escrowHop` predicate uses LIVE `restakingContract` (autoMaxLock retention)
- `TegridyStakingAdmin.sol:179-194` — `proposeRestakingContract` / `executeRestakingContract` (48h timelock)

**State pair / inconsistency**
- `TegridyStaking.restakingContract = oldR` while `oldR` still holds N staking NFTs
- `unsettledRewards[oldR] > 0` (non-zero balance)
- `unsettledRewardsByTokenId[tokenId]` populated for tokenIds escrowed in `oldR`
- `oldR.restakers[user].tokenId` non-zero on the OLD restaking contract

After admin executes `applyRestakingContract(newR)` via the timelocked path:
- `restakingContract = newR` (live read)
- `oldR` still holds the N NFTs, has the N restaker entries, and is the holder of `unsettledRewards[oldR]` plus the per-tokenId-attributed bucket entries
- `_isTrackedHolder(oldR)` → returns FALSE (because `holder == restakingContract` checks against `newR` now)
- `_isTrackedHolder(newR)` → returns TRUE, but `unsettledRewards[newR] == 0` (no migration of state)

**Race / divergence window** Permanent — there is no migration path. `applyLendingContract` has a `balanceOf(_lending) > 0` revert for revoke (false) (line 1985) precisely to defend this exact class of stranding for lending escrows. The sister `applyRestakingContract` is missing the symmetric guard.

**Exploit / impact**
1. **Per-tokenId bucket drains permanently bricked.** `claimUnsettledForTokenId` at `TegridyStaking.sol:1641` reverts `Unauthorized` for `oldR` once `_isTrackedHolder(oldR)` flips false. Every restaker whose NFT is held by `oldR` loses ALL accrued kick-credit slices (the C-1 per-tokenId attribution drain path is the ONLY route — the holder bucket is barred from `claimUnsettledFor` at line 1591).
2. **`unsettledRewards[oldR]` orphaned.** `claimUnsettledFor(_user)` at line 1591 reverts when `_user` is a tracked holder, but `oldR` is no longer tracked. The owner-stale path at line 1600 requires `lastActivityAt[oldR] + USER_INACTIVITY_GATE >= block.timestamp` — `_touch(oldR)` was called every transfer leg while `oldR` was active, so the 90d clock will eventually reach the threshold and the owner can sweep `unsettledRewards[oldR]`. But until 90d elapse, the bucket is fully orphaned. Even after 90d, ownership flows to the OWNER not the original restakers — silent value migration to the protocol.
3. **NFT return-to-user round-trip blocked.** When a user calls `oldR.unrestake()` (oldR is still functional as a contract, just not the canonical pointer), oldR triggers `safeTransferFrom(oldR, user, tokenId)`. In `TegridyStaking._beforeTokenTransfer`:
   - `lendingExempt = false` (oldR not in lending allowlist)
   - `restakingHop = false` (`oldR != restakingContract == newR`)
   - Cooldown and rate-limit guards apply at full strength.
   And in `_afterTokenTransfer` at line 1347:
   - `to.code.length == 0` (user is EOA) AND `userTokenId[user] != 0` (user re-staked a new position during the rotation window) AND `!isLendingContract[oldR]` → `revert AlreadyHasPosition`.
   The user is **permanently locked out of their NFT** until they withdraw/burn their newer position.
4. **autoMaxLock silently reset.** `escrowHop` at line 1357-1359 uses live `restakingContract`, so `from == oldR` no longer flags as escrow → `positions[id].autoMaxLock = false` on the round-trip return. User loses their auto-extend preference.

**Concrete sequence**
```
T0  : user has tokenId=A staked, restakes into oldR.
T0+x: user stakes tokenId=B (userTokenId[user] = B; _positionsByOwner[user] = {B}).
T+5d: admin proposeRestakingContract(newR); waits 2d timelock; executeRestakingContract.
T+7d: restakingContract = newR. oldR still holds A.
T+7d: user calls oldR.unrestake() to retrieve A.
       - oldR triggers staking.toggleAutoMaxLock, getReward, claimUnsettledForTokenId(A, user)
         → claimUnsettledForTokenId reverts Unauthorized (oldR no longer tracked) → A's per-tokenId
           credits forfeited.
       - oldR triggers safeTransferFrom(oldR, user, A).
         → _afterTokenTransfer reverts AlreadyHasPosition (B blocks).
       Result: NFT A and its per-tokenId rewards are stranded in oldR forever.
```

**Severity** HIGH — admin-trigger only (not permissionless), but deterministic permanent fund loss across many users in the rotation window. The 48-hour timelock is observable, but user has no preventive action: they cannot un-restake from `oldR` AFTER rotation if they own a second position (and pre-rotation un-restakes would still pay the same rewards minus the orphaned per-tokenId slice).

**Suggested defense (read-only finding, no edit performed)**
Mirror the `applyLendingContract` guard:
```solidity
function applyRestakingContract(address _restaking) external onlyAdmin {
    if (_restaking == address(0)) revert ZeroAddress();
    if (balanceOf(restakingContract) > 0) revert PendingRestakingPositions(); // <-- new
    if (unsettledRewards[restakingContract] > 0) revert PendingRestakingRewards(); // <-- new
    restakingContract = _restaking;
}
```
Plus enforce admin-side migration ceremony: drain per-tokenId buckets, return NFTs, then rotate.

---

## F-65-2 — Governance Consumer One-Shot Restaking Setters Diverge From Mutable Staking-Side Pointer (MEDIUM)

**Files / Lines**
- `MemeBountyBoard.sol:354-359` — `setRestakingContract` is one-shot (`if (restakingContract != address(0)) revert RestakingAlreadySet`)
- `CommunityGrants.sol:1022-1027` — same one-shot pattern
- `GaugeController.sol:1048-1053` — same
- `ReferralSplitter.sol:503-508` — same
- `VoteIncentives.sol:1135-1140` — same
- `RevenueDistributor.sol:494-508` — has 48h-timelock-rotatable `restakingContract` (`proposeRestakingChange` / `executeRestakingChange`)
- `TegridyStaking.sol:1967-1970` (via `TegridyStakingAdmin.executeRestakingContract` 48h timelock) — staking-side restaking pointer IS rotatable

**State pair / inconsistency**
After admin rotates the staking-side `restakingContract` (and after fixing F-65-1), every governance consumer EXCEPT `RevenueDistributor` is permanently stuck pointing at the OLD restaking contract. They all read user voting power as:
```
VotePowerOracle.powerOf(user, address(stakingContract), restakingContract /* one-shot */)
```
where each consumer's `restakingContract` is locked to whichever address was wired at deploy.

**Race / divergence window** Permanent until consumer redeployment.

**Exploit / impact**
- Restakers' voting power on `oldR` is pulled by 5 governance consumers, but if a user has migrated their NFT to `newR` (e.g., emergency exit + re-restake on the new contract), the 5 consumers see ZERO power for them while `RevenueDistributor` sees the correct `newR` power.
- A restaker who never migrated still sees their power on the 5 one-shot consumers (because oldR still has their state) — but `RevenueDistributor` is rotated to `newR` and reads zero from there. **Restaker is silently disenfranchised across these 5 surfaces vs RevDist (or vice versa) depending on which contracts each user happened to deposit through.**
- Vote tallies, bounty submissions, grant proposals, and bribe deposits all skew toward whichever cohort matches the consumer's frozen pointer.

**Suggested defense** Make all 5 consumers' `setRestakingContract` use a 48h timelock matching `RevenueDistributor`'s pattern, OR auto-pull the staking-side pointer via `IStaking(staking).restakingContract()` at read time (single source of truth). The current one-shot pattern locks consumers behind the timelocked staking-side rotation.

**Severity** MEDIUM — depends on F-65-1 being fixed and admin actually using the rotation path. Permanent governance fork the moment rotation occurs.

---

## F-65-3 — Numerator/Denominator Timestamp Asymmetry in `VoteIncentives.advanceEpoch` (LOW)

**Files / Lines**
- `VoteIncentives.sol:528-569` — `advanceEpoch`
- `VoteIncentives.sol:531` — `totalPower = votingEscrow.totalBoostedStake();` (LIVE spot read)
- `VoteIncentives.sol:541-543` — `snapshotTime = block.timestamp - SNAPSHOT_LOOKBACK` (1 hour earlier)
- `VoteIncentives.sol:622-626` — `vote()` reads `userPower = VotePowerOracle.powerAt(user, ep.timestamp /* = snapshotTime */, ...)`

**State pair / inconsistency**
- Epoch denominator captured at NOW: `epochs[i].totalPower` = `totalBoostedStake()` at `block.timestamp`.
- Epoch timestamp recorded as `block.timestamp - 1h` for vote-power lookup.
- Per-user numerator (at vote time) reads `votingPowerAtTimestamp(user, NOW - 1h)` — i.e., 1 hour earlier than the denominator.

**Race window** Every epoch boundary — legitimate stakers staking in the last hour count toward `totalPower` but not toward any user's `votingPowerAtTimestamp(NOW - 1h)`.

**Exploit / impact** Inverse dilution: a whale who staked in the last hour BEFORE `advanceEpoch` is added to the denominator (`totalBoostedStake()`) but cannot be claimed against (their `votingPowerAtTimestamp(NOW - 1h)` reads pre-stake = 0). Their "ghost" weight reduces every honest voter's per-bribe share by `whale / totalPower`. Self-griefing rather than profit-attack — the whale pays gas to dilute the pool but gains nothing.

Compare with `RevenueDistributor._distribute` at `RevenueDistributor.sol:368-401` which correctly pulls `totalBoostedStakeAtTimestamp(snapshotTime)` so numerator and denominator share one timestamp.

**Suggested defense** Replace line 531 with:
```solidity
uint256 snapshotTime = ...;
uint256 totalPower;
try votingEscrow.totalBoostedStakeAtTimestamp(snapshotTime) returns (uint256 hist) {
    totalPower = hist;
} catch { totalPower = 0; }
if (totalPower == 0) totalPower = votingEscrow.totalBoostedStake();
```
Mirroring the RevDist pattern.

**Severity** LOW — self-griefing only (attacker funds the dilution); no net profit vector. Worth fixing for symmetry with RevDist.

---

## F-65-4 — TegridyLPFarming Boost Stale After Restake/Unrestake Without `refreshBoost` (LOW)

**Files / Lines**
- `TegridyLPFarming.sol:287-294` — `_getEffectiveBalance` reads `tegridyStaking.aggregateActiveBoostBps(user)` LIVE
- `TegridyLPFarming.sol:297-307` — `refreshBoost` is permissionless but UNCALLED on restake/unrestake transitions
- `TegridyStaking.sol:598-615` — `aggregateActiveBoostBps` ignores positions held by `restakingContract` (LIVE read at line 599)

**State pair / inconsistency**
A user with LP staked in `TegridyLPFarming` AND a tegridy staking position locked into `TegridyRestaking`:
- `aggregateActiveBoostBps(user)` returns 0 (per-owner enumerable set is empty after restake)
- `effectiveBalanceOf[user]` in LPFarming was set when the user staked LP — using whatever the boost was at THAT moment.
- LPFarming has no on-restake hook to refresh.

**Race window** Continuous — every time a user restakes/unrestakes/extends, their LPFarming effective balance lags. Users who restake AFTER LP-staking keep their old boosted effective balance forever (until they manually `refreshBoost` or any `stake`/`withdraw`/etc on LPFarming triggers the recompute).

**Exploit / impact** User with tegridy stake → LP-stake at high boost → restake the tegridy NFT → keep the inflated `effectiveBalanceOf` until they next interact with LPFarming. Conversely, a user who LP-stakes WITHOUT a tegridy position (BASE_BOOST), then later stakes-and-locks the tegridy NFT, sees no LP-boost upgrade until they call `refreshBoost`. Net: user-controlled, bidirectional skew of LPFarming reward share, bounded above by per-user effective balance, but persistent until refresh.

**Suggested defense** Either (a) make LPFarming's reward calc recompute boost lazily inside `earned`, or (b) hook `TegridyRestaking.restake` / `unrestake` to call `lpFarming.refreshBoost(user)` if wired. (b) is invasive; (a) is the simpler one-line fix.

**Severity** LOW — boost gap is bounded by the user's own behavior; no permissionless attack surface; user can self-correct via permissionless `refreshBoost(user)`.

---

## F-65-5 — `_validatePair`/`pairToGauge` Stale on Pair Disable Strands In-Flight Bribes (INFORMATIONAL)

**Files / Lines**
- `VoteIncentives.sol:1425-1440` — `_validatePair` does live `factory.disabledPairs(pair)` check
- `VoteIncentives.sol:646-664` — `depositBribe` runs `_validatePair` + `_requireGaugedPair`
- `VoteIncentives.sol:768-806` — `claimBribes` runs `_validatePair`
- `TegridyFactory.sol:418` — pair disable execute path

**State pair / inconsistency**
1. `T0`: briber deposits bribe for `pair`. `pair.disabled == false`, `pairToGauge[pair] != 0`.
2. `T0+24h`: governance proposes pair disable.
3. `T0+72h`: governance executes pair disable. `factory.disabledPairs[pair] = true`.
4. `T0+72h+`: voter calls `claimBribes(epoch, pair)` → reverts `PairDisabled` at `_validatePair`.
5. Bribe is stranded in VoteIncentives.

**Race window** From pair disable execute until pair re-enable (which may never happen).

**Exploit / impact** This is closer to an admin/governance interaction issue. Bribers cannot recover — `claimBribes` is the only drain path for the per-(epoch, pair) bribe pool, and it reverts when pair is disabled. The orphan-rescue path (mentioned in code comments — `Phase 1.6` — for self-bribe lockout) may also be stranded behind the same `_validatePair` gate.

**Severity** INFORMATIONAL — admin coordination problem; an honest governance flow that disables a pair after bribes are deposited would orphan funds. Suggest documenting that pair-disable propose-time should require zero in-flight bribes for that pair, or providing an emergency-rescue path that bypasses `_validatePair` for stranded depositors.

---

## F-65-6 — `_writeBoostCheckpoint` in Restaking Lacks No-Op-on-Unchanged Deduplication (INFORMATIONAL)

**Files / Lines**
- `TegridyRestaking.sol:163-165` — `_writeBoostCheckpoint(user, newBoost)` unconditionally pushes a checkpoint
- `TegridyStaking.sol:1546-1552` — staking has the documented "skip push when power is unchanged" (`AUDIT NEW-S7`)

**State pair / inconsistency**
Restaking-side checkpoint history grows on every mutation, even no-op rewrites (e.g., `decayExpiredRestaker` setting `currentBoosted == oldBoosted` is guarded against, but other paths through `revalidateBoost*` or `refreshPosition` can write the same value twice).

**Race window** N/A — performance / cost issue, not exploit.

**Exploit / impact** Gas griefing only. `upperLookup` is binary search so still O(log n), but storage cost grows linearly. No funds at risk.

**Severity** INFORMATIONAL — backport the staking-side `last == newPower` short-circuit to keep restaking-side checkpoints lean.

---

## Notes / Dead-ends

- **JBAC vault wiring race** (`TegridyStaking.setJbacVault` one-shot, `TegridyStakingJbacVault` immutable refs). Bounded race during deployment only — once both are live, no mid-flight setter rotation. Not exploitable.
- **`ReferralSplitter.recordFee` route divergence** — `setReferrer` allows users to set referrers, `recordFee` checks `votingPowerOf(referrer)` from staking + restaking with try/catch fallback. After F-65-1's restaking rotation, `oldR.votingPowerOf(referrer)` still works (oldR is still functional) — the splitter's `restakingContract` (one-shot per F-65-2) keeps it pointed at oldR, so referral rewards continue accruing to oldR-restakers. This is internally consistent (one-shot pointer means consistency with own pointer) but inconsistent with the canonical (post-rotation) restaking. Already covered by F-65-2.
- **`SwapFeeRouter.distributeFeesToStakers`** — uses `pendingDistribution[revenueDistributor]` queue on transfer failure. After `applyDistributorChange` (admin path on the router), the OLD distributor's pending balance is still drainable via `withdrawDeferredDistribution(oldDist)` (if such a path exists). Confirmed: looking at the contract, `pendingDistribution` is keyed on the destination address so historical entries survive rotation. Not a finding.
- **`RevenueDistributor._isRestaked`** uses live `restakingContract`. After RevDist's own restaking rotation, OLD restakers are no longer detected as restaked → `_calculateClaim`'s grace-period gate would fail for them and they'd revert `NoLockedTokens`. But RevDist's `restakingContract` is rotatable (timelocked), so admin coordination owns this — covered by general one-shot vs rotatable mismatch in F-65-2.
- **`TegridyTWAP` reads of `factory.disabledPairs`** — defensive at update() and consult(). Disabling a pair pauses TWAP integration. No race exploit found.
- **`emergencyPaused` factory cascade for NFT pools** — `TegridyNFTPool` reads `factory.emergencyPaused()` LIVE on swap entry. No cross-contract state divergence — single source of truth.
- **`_isStakingPaused` in RevDist + VoteIncentives** — both consult staking pause via try/catch. Symmetric and defensive. No race.
- **Lending allowlist symmetry** — `TegridyLending.acceptedCollateralContracts` (lending-side) vs `TegridyStaking.isLendingContract` (staking-side). Both are timelocked admin paths. The staking-side has `balanceOf(lending) > 0` revert on revoke, lending-side has `activeLoansAgainstCollateral > 0` revert. The admin must coordinate ordering, but each side fails-safe. No exploitable race window for an attacker.

---

## Summary Table

| ID | Severity | Surface | Type |
|----|----------|---------|------|
| F-65-1 | HIGH | Staking ↔ Restaking address rotation | NFT + reward bucket stranding |
| F-65-2 | MEDIUM | 5 governance consumers vs RevDist | Setter mutability mismatch |
| F-65-3 | LOW | VoteIncentives epoch | Numerator/denominator timestamp asymmetry |
| F-65-4 | LOW | LPFarming boost cache | Stale until manual refresh |
| F-65-5 | INFO | VoteIncentives + factory pair disable | Bribe stranding |
| F-65-6 | INFO | Restaking checkpoint dedupe | Gas griefing |

---

**Output path:** `.audit_2026_freshlook/findings/agent_65_cross_state.md`
