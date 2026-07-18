# TegridyRestaking EIP-170 Split — Design (Phase 7, deferred, fund-touching)

Status: **DESIGN ONLY — not code.** `forge build` hangs locally (see `[[reference_local_forge_build_hang]]`); the exact runtime-bytecode size can only be confirmed with `forge build --sizes` in CI. Everything below is estimated from source structure. TegridyRestaking has **never been deployed** (deferred to Phase 7 per `contracts/script/DeployMVP.s.sol:202-213`), so this is a fresh-deploy split with **no storage-migration constraint** — but a **mandatory external re-audit** gates any deploy because the moved surface is fund-touching.

Ground-truth files read for this design:
- `contracts/src/TegridyRestaking.sol` (2629 lines — the over-limit host)
- `contracts/src/lib/RestakingAdminLib.sol` (part-1 delegatecall lib already extracting cold admin *bodies*)
- `contracts/src/RestakingMonitorView.sol` (read-only sister already extracting display views)
- Proven sister pattern: `contracts/src/TegridyStakingAdmin.sol`, `contracts/src/SwapFeeRouterAdmin.sol`
- Parent↔admin wiring of record: `contracts/src/TegridyStaking.sol:2018-2132` (`setStakingAdmin` / `proposeAdminReplacement` / `executeAdminReplacement` / `cancelAdminReplacement` / `onlyAdmin` / `applyXxx`)
- Base: `contracts/src/base/OwnableNoRenounce.sol`, `contracts/src/base/TimelockAdmin.sol`, `contracts/src/base/PauseGuardian.sol`
- Deploy pattern: `contracts/script/DeployMVP.s.sol:155-297`

---

## 1. Why / size

### 1.1 Confirmed size trajectory
- `git show 58add7a` — "EIP-170 split part 1 — behavior-preserving DRY (**31,399 → 28,680 B**)". That commit only DRY-collapsed duplicated inline bodies into internal helpers (`_syncActivePrincipal`, `_forwardUnforwardedBase`, `_recoverPriorPending`, `_claimBonusWithDefer`, `_settlePreAccrueBonus`, `_returnNftSettleResidual` — `TegridyRestaking.sol:210-350`).
- Subsequent parts (visible in-source as comments): **2c** moved display views to `RestakingMonitorView.sol`; **2d** moved attribution/sweep/rescue execute *bodies* to `RestakingAdminLib.sol`; **2e** swapped OZ `SafeERC20`/`SafeCast` for Solady drop-ins (`TegridyRestaking.sol:5-15`).
- After all of that the host is still **> 24,576 B** (that is why this task exists). The residual gap is on the order of **~2–4 KB** — CI `--sizes` is the only authoritative figure.

### 1.2 What still makes the host large (from source structure)
The host is heavy in three buckets. The split targets the **third**.

1. **Fund/accounting core (MUST stay on host)** — the reward-math engine and all its stale-path variants:
   - `restake` (`:828`), `unrestake` (`:1179`), `claimAll` (`:1017`), `refreshPosition` (`:931`), `recoverStuckPrincipal` (`:1770`), `emergencyWithdrawNFT` (`:1914`), `emergencyForceReturn` (`:2069`), `claimResidualForTokenId` (`:1480`), `claimPendingUnsettled` (`:1337`), `claimPendingBonusPayout` (`:1422`), `waiveResidualClaim` (`:1568`), `decayExpiredRestaker` (`:2351`), `_revalidateBoostCore`+2 entrypoints (`:2244-2321`), `_boostedAmountAt` (`:728`), `_accrueBonus`/`_accrueBonusChecked` (`:2488-2542`) and the six extracted helpers (`:210-350`). Each carries the R014-RETRY 4-step settle inline — this is the irreducible bulk and is **out of scope** to move.

2. **Base-contract machinery**: `OwnableNoRenounce` + `ReentrancyGuard` + `Pausable` + `TimelockAdmin` + `PauseGuardian` + `IERC721Receiver` (`:99`). Of these, **`TimelockAdmin` is fully removable from the host** if every `bytes32`-keyed timelock flow leaves (see §2). That deletes the inlined `_propose`/`_execute`/`_cancel`/`_forceCancel` + hooks + the `_executeAfter` getters (`base/TimelockAdmin.sol:166-270`) from the host runtime.

3. **Timelocked admin surface (the move target)** — every function, pending-state var, auto-getter, event and key in this list is owner-only param governance, none of it on any user hot path:

   | Flow | Host functions today | Keys / pending state today |
   |---|---|---|
   | Bonus rate (48h) | `proposeBonusRate` `:1658`, `executeBonusRateChange` `:1676`, `cancelBonusRateProposal` `:1698`, `setBonusRewardPerSecond` (revert stub) `:1643`, `bonusRateChangeTime` `:600` | `BONUS_RATE_CHANGE` `:107`, `pendingBonusRate` `:414`, `lastBonusRateActionAt` `:442`, `BONUS_RATE_TIMELOCK` `:406`, `BONUS_RATE_ACTION_COOLDOWN` `:443`, `MAX_BONUS_REWARD_RATE_MULTIPLIER` `:413`, `maxBonusRewardRate()` `:605` |
   | Attribution (24h) | `proposeAttributeStuckRewards` `:1870`, `executeAttributeStuckRewards` `:1887`, `cancelAttributeStuckRewards` `:1901`, `attributionExecuteAfter` `:601` | `ATTRIBUTION_CHANGE` `:108`, `pendingAttribution` `:422`, `ATTRIBUTE_TIMELOCK` `:417` |
   | Sweep-stuck (24h) | `proposeSweepStuckRewards` `:1728`, `executeSweepStuckRewards` `:1737`, `cancelSweepStuckRewards` `:1751`, `sweepStuckRewards` (revert stub) `:1761` | `SWEEP_STUCK_CHANGE` `:1720`, `SWEEP_STUCK_TIMELOCK` `:1721`, `pendingSweepStuckToken` `:1722` |
   | Rescue-NFT (48h) | `proposeRescueNFT` `:2023`, `executeRescueNFT` `:2045`, `cancelRescueNFT` `:2056` | `RESCUE_NFT_CHANGE` `:110`, `pendingRescueNFT` `:395`, `RESCUE_NFT_TIMELOCK` `:390` |
   | Residual-clear (7d, inline mapping — NOT a TimelockAdmin key) | `proposeClearResidualClaimant` `:1586`, `executeClearResidualClaimant` `:1593`, `cancelClearResidualClaimant` `:1599` | `pendingResidualClears` `:383`, `CLEAR_RESIDUAL_TIMELOCK` `:375`, `CLEAR_RESIDUAL_VALIDITY` `:379` |
   | Handoff flush | `acceptOwnership` override `:2585-2628` (44 lines) | flushes the 4 `bytes32` keys above |

   Moving all of the above off the host (and with it the `RestakingAdminLib` import/link at `:25`, `:383`, `:395`, `:422`, `:1590`, `:1743`, `:1889`, `:2047`) plus dropping `TimelockAdmin` inheritance is the reliable path under 24,576 B. Order-of-magnitude reclaim: ~12 external selectors + their bodies, ~7 auto-getters, 5 `bytes32`/pending slots, the 44-line `acceptOwnership` flush, and the entire `TimelockAdmin` base — comfortably in the multi-KB range, i.e. more than the residual gap. **CI `--sizes` confirms; do not treat the estimate as sufficient.**

### 1.3 What we add back to the host (small)
Mirroring `TegridyStaking`: a one-shot `setRestakingAdmin` + inline `proposeAdminReplacement`/`executeAdminReplacement`/`cancelAdminReplacement` (48h + 7-day validity, **inline — not TimelockAdmin-based**, exactly like `TegridyStaking.sol:2028-2132`), an `onlyAdmin` modifier, and ~5 narrow `applyXxx` setters. These are small; net change is a large reduction.

---

## 2. The split

### 2.1 New contract: `contracts/src/TegridyRestakingAdmin.sol`
Mirror `TegridyStakingAdmin` / `SwapFeeRouterAdmin` **exactly**:

```
contract TegridyRestakingAdmin is OwnableNoRenounce, TimelockAdmin {
    ITegridyRestakingApply public immutable restaking;   // set in constructor, ZeroAddress-guarded
}
```

It holds **all** propose/execute/cancel triplets, all pending state, all timelock keys/delays, the anti-churn cooldown, the residual-clear 7-day mapping, and the `acceptOwnership` flush. It owns **no funds and no pausable state** (no `PauseGuardian`, no `ReentrancyGuard` needed — it never receives a reentrant callback; see §4.1). Governance events (`*Proposed` / `*Executed` / `*Cancelled`) are **re-declared and emitted from the sister** (topic-identical, but now emitted at the *sister* address — see §3.4).

#### Timelock keys / delays on the sister (verbatim values)
`BONUS_RATE_CHANGE` 48h, `ATTRIBUTION_CHANGE` 24h, `SWEEP_STUCK_CHANGE` 24h, `RESCUE_NFT_CHANGE` 48h. Residual-clear stays its own inline 7-day/7-day mapping (`PendingResidualClear` struct + `pendingResidualClears`), not a `bytes32` key — carried over from `RestakingAdminLib.sol:37-40, 53-54`.

#### Sister functions (1:1 with today's host functions)
- **Bonus rate**: `proposeBonusRate(uint256)` — `RateTooHigh` cap check via `restaking.maxBonusRewardRate()`; the `lastBonusRateActionAt` + `BONUS_RATE_ACTION_COOLDOWN` anti-churn gate (verbatim from `:1664-1670`); `_propose(BONUS_RATE_CHANGE, 48h)`; `emit BonusRateProposed`. `executeBonusRateChange()` — `_execute`; `restaking.applyBonusRate(pendingBonusRate)`; `emit BonusRateExecuted`; clear. `cancelBonusRateProposal()` — `_cancel`; set `lastBonusRateActionAt = block.timestamp` (DR2-05, `:1698-1708`); `emit BonusRateCancelled`. Sister owns `pendingBonusRate`, `lastBonusRateActionAt`, `BONUS_RATE_ACTION_COOLDOWN`. `bonusRateChangeTime()` view → `_executeAfter[BONUS_RATE_CHANGE]`.
- **Attribution**: `proposeAttributeStuckRewards(address,uint256)` — pre-check `restaking.restakers(_restaker).tokenId != 0` (else `NotRestaked`) + `_amount != 0`; store `pendingAttribution`; `_propose(ATTRIBUTION_CHANGE,24h)`; emit. `executeAttributeStuckRewards()` — `_execute`; `restaking.applyAttributeStuckRewards(pendingAttribution.restaker, pendingAttribution.amount)` (host does the F-2 cap math + credit); clear; emit. `cancelAttributeStuckRewards()`. `attributionExecuteAfter()` view.
- **Sweep-stuck**: `proposeSweepStuckRewards(address)` — reject `== restaking.bonusRewardToken()` / `== restaking.rewardToken()` / `== 0`; `_propose(SWEEP_STUCK_CHANGE,24h)`; emit. `executeSweepStuckRewards()` — `_execute`; `restaking.applySweepStuckRewards(token)`; emit. `cancelSweepStuckRewards()`.
- **Rescue-NFT**: `proposeRescueNFT(uint256,address)` — pre-check `restaking.tokenIdToRestaker(id)==0`, `restaking.strandedRestakeRecipient(id)==0`, `restaking.residualClaimant(id)==0`, `_to != 0`; store `pendingRescueNFT`; `_propose(RESCUE_NFT_CHANGE,48h)`; emit. `executeRescueNFT()` — `_execute`; `restaking.applyRescueNFT(id,to)`; emit. `cancelRescueNFT()`.
- **Residual-clear**: `proposeClearResidualClaimant(uint256,address)` — pre-check `restaking.residualClaimant(id) != 0` (else `BadParam`) + `newClaimant != 0` (H-RESTAKE-CLEAR-ABANDONS-RESIDUE, `RestakingAdminLib.sol:96-99`) + no pending (`M-03`); store 7-day proposal on the sister. `executeClearResidualClaimant(uint256)` — timelock+validity checks (verbatim `RestakingAdminLib.sol:117-131`); `restaking.applyResidualClaimant(id, newClaimant)`; clear; emit. `cancelClearResidualClaimant(uint256)`.
- **Handoff**: `acceptOwnership() public override` — `super.acceptOwnership()` then `_cancel` + clear pending for each of the 4 keys **and** reset `lastBonusRateActionAt = 0` (the F-2 review reset at `:2592-2598`). Mirror `TegridyStakingAdmin.sol:274-299` / `SwapFeeRouterAdmin.sol:465-529`. Per-tokenId residual-clear proposals are not enumerable — new owner triages via `cancelClearResidualClaimant(id)`, exactly as the host comment at `:2582-2584` already states.

### 2.2 Host changes (`TegridyRestaking.sol`)
- **Drop** `TimelockAdmin` from the inheritance list (`:99`) and the `RestakingAdminLib` import + all `RestakingAdminLib.*` call sites. **Keep** `OwnableNoRenounce, ReentrancyGuard, Pausable, IERC721Receiver, PauseGuardian`.
- **Delete** every function/pending-var/key/event/getter in the §1.2 table (they now live on the sister).
- **Add pointer + rotation (verbatim mirror of `TegridyStaking.sol:2028-2132`)**:
  - `address public restakingAdmin;`
  - `setRestakingAdmin(address _admin) external onlyOwner` — one-shot: `if (restakingAdmin != address(0)) revert AdminAlreadySet();` then reject EOA/7702: `uint256 codeLen = _admin.code.length; if (codeLen == 0 || codeLen == 23) revert NotAContract();` set + emit `RestakingAdminReplaced(address(0), _admin)`.
  - `pendingRestakingAdmin` + `adminReplacementReadyAt` + `ADMIN_REPLACEMENT_TIMELOCK = 48 hours`; `proposeAdminReplacement` / `executeAdminReplacement` (48h + 7-day validity window, `:2109-2110`) / `cancelAdminReplacement` — **inline**, byte-for-byte from `TegridyStaking.sol:2078-2127`. (Inline because the host no longer inherits `TimelockAdmin`.)
  - `modifier onlyAdmin() { if (msg.sender != restakingAdmin) revert Unauthorized(); _; }`
  - `acceptOwnership() public override` — flush a pending admin-replacement on handoff, mirroring `TegridyStaking.sol:2400-2405` (small; replaces the deleted 44-line key-flush at `:2585-2628`).
- **Add narrow `onlyAdmin applyXxx` setters** (these carry the fund-mutation bodies that were in `RestakingAdminLib` / inline; the sister only orchestrates timelocks):
  - `applyBonusRate(uint256 rate) external onlyAdmin` — `if (rate > maxBonusRewardRate()) revert RateTooHigh();` (execute-time recheck) → `_accrueBonusChecked();` (**preserves the execute-time `updateBonus` accrual** at the old rate before switching) → `bonusRewardPerSecond = rate; emit BonusRateExecuted(rate);` Keep `maxBonusRewardRate()` + `bonusRewardTokenUnit` immutable on host (`:403`, `:605`).
  - `applyAttributeStuckRewards(address restaker, uint256 amount) external onlyAdmin` — the F-2 cap body from `RestakingAdminLib.sol:159-198` inlined: recheck `restakers[restaker].tokenId != 0`, `reserved = totalUnforwardedBase + totalActivePrincipal + totalPendingUnsettled`, `unattributed = bal > reserved ? bal-reserved : 0`, `if (amount > unattributed) revert BadParam();` credit `unforwardedBaseRewards[restaker] += amount; totalUnforwardedBase += amount; emit StuckBaseRewardsAttributed(restaker, amount);`
  - `applySweepStuckRewards(address token) external onlyAdmin nonReentrant` — body from `RestakingAdminLib.sol:209-226`: recheck `token != bonusRewardToken/rewardToken`, transfer full balance to `address(staking)`, `emit SweepStuckExecuted`.
  - `applyRescueNFT(uint256 tokenId, address to) external onlyAdmin nonReentrant` — body from `RestakingAdminLib.sol:238-264`: recheck `tokenIdToRestaker/strandedRestakeRecipient/_residualClaimant[tokenId] == 0` (all three), then `stakingNFT.safeTransferFrom(address(this), to, tokenId); emit RescueNFTExecuted`. (CEI already satisfied — nothing to clear on host; pending lives on sister.)
  - `applyResidualClaimant(uint256 tokenId, address newClaimant) external onlyAdmin` — `if (newClaimant == address(0)) delete _residualClaimant[tokenId]; else _residualClaimant[tokenId] = newClaimant; emit ResidualClearExecuted(tokenId, old, newClaimant);` (the `_residualClaimant` write from `RestakingAdminLib.sol:122-130`).
  - **Public getters the sister reads** must remain public on host: `restakers` (already `:146`), `tokenIdToRestaker` (`:147`), `strandedRestakeRecipient` (`:182`), `residualClaimant(uint256)` view (`:691`), `bonusRewardToken`/`rewardToken` (immutables), `maxBonusRewardRate()`.
- **Host keeps unchanged**: `pause`/`unpause`/`setPauseGuardian`/`guardianPause` (`:1995-2005`), `emergencyForceReturn` (owner+whenPaused fund path stays on host, `:2069`), all user fund functions, `_accrueBonus`, the six DRY helpers, `_boostedAmountAt`, checkpoints.

### 2.3 Interface (mirror `ISwapFeeRouterApply` / `ITegridyStakingApply`)
`interface ITegridyRestakingApply` in the sister file, exposing: `applyBonusRate`, `applyAttributeStuckRewards`, `applySweepStuckRewards`, `applyRescueNFT`, `applyResidualClaimant`, plus the views `maxBonusRewardRate() → uint256`, `bonusRewardToken()/rewardToken() → address`, `tokenIdToRestaker(uint256)/strandedRestakeRecipient(uint256)/residualClaimant(uint256) → address`, and `restakers(address)` (tuple — read `.tokenId`).

### 2.4 Parent↔admin wiring semantics (identical to StakingAdmin)
- **One-shot install**: deploy sister with `_restaking = host`; deploy order requires the host first (sister ctor stores `host`). Then `host.setRestakingAdmin(sister)` — one-shot, EOA+7702 rejected (`codeLen == 0 || codeLen == 23`).
- **Rotation**: `host.proposeAdminReplacement(newSister)` (48h, reject EOA/7702) → wait → `host.executeAdminReplacement()` (7-day validity) or `host.cancelAdminReplacement()`.
- **Ownership**: multisig owns **both** host and sister (see §5 deploy). `onlyAdmin` on host = "only the wired sister"; `onlyOwner` on sister = "only the multisig". Net authority at the multisig level is unchanged vs today.

---

## 3. Behavior-equivalence checklist

Every moved function must be caller-observably identical **except** for the documented event-address relocation (§3.4). Enumerated per flow:

### 3.1 Bonus rate
- `proposeBonusRate`: same `RateTooHigh` boundary (`rate <= maxBonusRewardRate() == 10 * bonusRewardTokenUnit`), same `ExistingProposalPending` (via `_propose`), same `BonusRateActionCooldown` ordering (input check → `_propose` existing-pending → cooldown, `:1660-1668`), same `BonusRateProposed(rate, executeAfter)` payload. **Divergence (safe, must be tested):** propose no longer runs `updateBonus`. Accrual is path-independent and the rate only changes at execute, so no user's entitlement changes; `applyBonusRate` runs `_accrueBonusChecked()` before switching, preserving the execute-time accrual exactly.
- `executeBonusRateChange`: after timelock, `bonusRewardPerSecond` updated, `BonusRateExecuted(rate)` emitted, `pendingBonusRate` cleared. Same effect; the accrual-then-set now happens inside `host.applyBonusRate`.
- `cancelBonusRateProposal`: `BonusRateCancelled(rate)`, `lastBonusRateActionAt = now`, no cooldown gate on cancel (DR2-05).
- Handoff: a pending `BONUS_RATE_CHANGE` is cancelled and `lastBonusRateActionAt` reset to 0 (F-2, `:2592-2598`).

### 3.2 Attribution
- `proposeAttributeStuckRewards`: `NotRestaked` if `restakers[_restaker].tokenId == 0`, `ZeroAmount` if `_amount == 0`, `AttributionProposed(restaker, amount, executeAfter)`.
- `executeAttributeStuckRewards`: F-2 cap (`reserved = totalUnforwardedBase + totalActivePrincipal + totalPendingUnsettled`), `BadParam` if `amount > unattributed`, credit `unforwardedBaseRewards[restaker] += amount`, `totalUnforwardedBase += amount`, `StuckBaseRewardsAttributed(restaker, amount)`. The `restakers[...].tokenId != 0` recheck must fire **after** the 24h wait exactly as today (host `applyAttributeStuckRewards` rechecks). Invariant: the value credited and both scalar increments byte-identical to `RestakingAdminLib.sol:180-197`.
- `cancelAttributeStuckRewards`: `AttributionCancelled(restaker, amount)`, `pendingAttribution` deleted.

### 3.3 Sweep-stuck / Rescue-NFT / Residual-clear
- Sweep: `CannotSweepBonusToken`/`CannotSweepRewardToken`/`ZeroAddress` at propose, re-checked at execute; full balance to `address(staking)`; `SweepStuckProposed`/`SweepStuckExecuted(token, amount)`/`SweepStuckCancelled`. `sweepStuckRewards` deprecated-revert stub can simply be dropped (no on-chain consumer; note in migration).
- Rescue: `BadParam` on any of the three live-claim guards at both propose and execute; `_to != 0`; NFT out via `safeTransferFrom`; `RescueNFTProposed`/`RescueNFTExecuted`/`RescueNFTCancelled`. CEI: pending cleared on the sister before host transfer.
- Residual-clear: `BadParam` (no existing claimant), `ZeroAddress` (non-zero-successor mandate), `ExistingProposalPending`, `NoPendingResidualClear`, `ResidualClearTimelockNotElapsed`, `ResidualClearExpired`; `ResidualClearProposed`/`ResidualClearExecuted(id, old, new)`/`ResidualClearCancelled`. 7-day timelock + 7-day validity preserved.

### 3.4 Event relocation (the one intended behavior change)
All `*Proposed`/`*Executed`/`*Cancelled` governance events now emit from the **sister address**, not the host. Topic hashes are identical (same signatures). **Consequence:** any `vm.expectEmit` bound to the restaking instance for these events, and any indexer filtering these by the host address, must repoint to the sister. **Fund events stay on the host and are unchanged**: `Restaked`, `Unrestaked`, `BonusClaimed`, `BaseClaimed`, `BonusFunded`, `EmergencyWithdraw`, `UnsettledRecovered`, `ResidualReserved`/`ResidualClaimed`/`ResidualPullDeferredCrossHolder`/`ResidualClaimWaived`, `RestakeNFTStranded`/`Reclaimed`, `BonusShortfall`, `PositionRefreshed`, `BoostRevalidated`, `BonusTransferDeferred`, `EmergencyForceReturn`.

### 3.5 Tests that must still pass (unchanged pass/fail, after event repointing)
`contracts/test/`: `TegridyRestaking.t.sol`, `Audit195_Restaking.t.sol`, `AuditR014_Restaking.t.sol`, `Deep_Restaking_2026_05_01.t.sol`, `FinalAudit_Restaking.t.sol`, `PASS5_RestakingPrincipal.t.sol`, `C1_L1_GetRewardShortfallAttribution.t.sol`, `MVPLaunch_RewardTriangleInvariants.t.sol`, `FRESH2026_F1_RevDistExRestakerRecovery.t.sol`, `FRESH2026_F3_StakingJbacRestakerLookup.t.sol`, `RevenueDistributor.t.sol`, `RedTeam_Staking.t.sol`.
- Tests that call `restaking.proposeBonusRate/…` etc. must be updated to call the **sister** and (for `expectEmit`) target the sister address. The behavior assertions themselves must not change.
- `bonusRateChangeTime()` / `attributionExecuteAfter()` legacy views move to the sister — repoint any reader.
- Add **new equivalence tests**: (a) propose-drops-`updateBonus` yields identical `accBonusPerShare`/entitlements vs. an interaction-accrued baseline; (b) `onlyAdmin` rejects a direct host `applyXxx` from a non-sister caller; (c) full rotate cycle `setRestakingAdmin` → `proposeAdminReplacement` → `executeAdminReplacement`; (d) sister `acceptOwnership` flushes all 4 keys + resets cooldown.

---

## 4. Risks / footguns

### 4.1 Reentrancy across the parent↔admin boundary
- Call direction is **one-way**: sister → `host.applyXxx`. The host `applyXxx` never calls back into the sister, so there is no cross-contract reentrant loop.
- The only external calls from `applyXxx` are `applySweepStuckRewards` (ERC-20 to `address(staking)`, trusted) and `applyRescueNFT` (`safeTransferFrom` → `to.onERC721Received`, potentially hostile). This is the **same** reentrancy surface the current host `executeRescueNFT` already has; it is mitigated by CEI (proposal state cleared on the sister before the host transfer; host has no pending state to clear). Add `nonReentrant` to both fund-touching `applyXxx` (host already inherits `ReentrancyGuard`) as defense-in-depth — cheap, and closes any onERC721Received → host user-path reentry.
- `applyBonusRate`/`applyAttributeStuckRewards`/`applyResidualClaimant` do no external transfers (attribution only credits a mapping; balanceOf is a view) so they need no guard, but a guard is harmless.

### 4.2 Storage-layout continuity
- **No migration** — fresh Phase-7 deploy. Removing admin pending-state from the host changes the host layout, which is fine. **Confirm** the `restakers` public getter tuple shape (`RestakeInfo`, `:134-144`) is untouched — `RestakingMonitorView.sol:5` and 40+ test sites bind it by shape; do not reorder/remove `RestakeInfo` fields (including the write-only `unsettledSnapshot`, `:140`). The fund/accounting storage (`totalRestaked`, `accBonusPerShare`, `lastBonusRewardTime`, `_boostCheckpoints`, `unforwardedBase/Bonus`, `totalActivePrincipal`, `_residualClaimant`, `tokenIdToRestaker`, `strandedRestakeRecipient`) all stay on host.

### 4.3 Functions that read BOTH fund state AND admin params (hardest to split)
These are the split's real risk and why the fund-mutation body stays on the **host** `applyXxx` (not the sister):
- **Attribution execute** reads `restakers`, `totalUnforwardedBase`, `totalActivePrincipal`, `totalPendingUnsettled` and writes `unforwardedBaseRewards`/`totalUnforwardedBase` — all host fund state. Keeping the cap math + write on the host preserves the F-2 reservation invariant atomically; the sister only gates the 24h timelock. Do **not** let the sister compute the cap off stale getters — the authoritative recompute must be on the host at execute time.
- **Rescue execute** reads `tokenIdToRestaker`/`strandedRestakeRecipient`/`_residualClaimant` and moves the NFT — host-only. Sister pre-checks are advisory; host re-checks are authoritative (window can go stale in 48h).
- **Residual-clear execute** writes `_residualClaimant` (consumed by `restake`/`claimResidualForTokenId`) — host-only write via `applyResidualClaimant`; sister holds only the 7-day proposal.
- **Bonus-rate execute** must run accrual against live `totalRestaked`/`bonusRewardToken.balanceOf` — host-only (`applyBonusRate` calls `_accrueBonusChecked`). The sister cannot accrue.

### 4.4 pauseGuardian / owner roles
- `PauseGuardian` stays on the host only. The sister has no pause surface. `guardianPause`/`setPauseGuardian`/`pause`/`unpause` unchanged. The 30-day pause SLA invariant (`base/PauseGuardian.sol:78-93`) is unaffected.
- The multisig owns both contracts. A compromised sister owner can only queue timelocked param proposals (all recoverable via the sister's `cancel*` / handoff flush and the host's 48h `proposeAdminReplacement` to rotate the sister out). A compromised host owner retains the same direct powers as today (pause, emergencyForceReturn, admin rotation). No new trust is introduced; the blast radius of each key is unchanged.

### 4.5 Other footguns
- Dropping `TimelockAdmin` from the host removes `hasPendingProposal`/`proposalExecuteAfter` from the host ABI — confirm no frontend/indexer reads them off the restaking address (they should read the sister). 
- `RestakingAdminLib` becomes unused by the host; either delete it or re-link to the sister. If re-linked, note its `executeClearResidualClaimant` writes `residualClaimant_` **directly** — it cannot be reused verbatim for the cross-contract case (the write must be `host.applyResidualClaimant`), so that body is re-expressed and **must be re-audited**, not assumed byte-identical.
- Keep `AlreadyRestaked`/`NotAContract`/`AdminAlreadySet`/`Unauthorized` typed errors available on the host for the new rotation surface (add `AdminAlreadySet`/`NotAContract` if not already present — `NotAContract` is new to this file; `Unauthorized` exists `:510`).

---

## 5. Execution checklist (do this where local compilation works — NOT here)

1. **Branch + baseline size**: on a machine where `forge build --sizes` runs, record the current `TegridyRestaking` runtime size (the number this whole exercise is chasing).
2. **Write the sister** `contracts/src/TegridyRestakingAdmin.sol` (`OwnableNoRenounce, TimelockAdmin`; `ITegridyRestakingApply`; the propose/execute/cancel triplets, pending state, keys/delays, cooldown, residual-clear mapping, `acceptOwnership` flush) — copy structure from `TegridyStakingAdmin.sol` and `SwapFeeRouterAdmin.sol`.
3. **Edit the host** `TegridyRestaking.sol`: drop `TimelockAdmin` + `RestakingAdminLib`; delete the §1.2 admin surface; add `restakingAdmin` + `setRestakingAdmin` + inline `proposeAdminReplacement`/`executeAdminReplacement`/`cancelAdminReplacement` + `onlyAdmin` + the 5 `applyXxx` (fund bodies inlined from the lib) + slim `acceptOwnership`. Keep pause/guardian/emergencyForceReturn/user-funds intact.
4. **Wire the pointer** in code review: confirm `applyXxx` are `onlyAdmin`, sister `onlyOwner`, and the `code.length == 0 || == 23` EOA/7702 rejection on both `setRestakingAdmin` and `proposeAdminReplacement`.
5. **Update the deploy script** (new Phase-7 script, mirroring `DeployMVP.s.sol:165-168, 297`): `host = new TegridyRestaking(staking, monitor, rewardToken, bonusRewardToken, rate)` → `admin = new TegridyRestakingAdmin(host)` → `host.setRestakingAdmin(admin)` → set pause guardian → `host.transferOwnership(multisig)` **and** `admin.transferOwnership(multisig)`. Then the cross-wiring the MVP script defers (`DeployMVP.s.sol:239, 349-350`): `stakingAdmin.proposeRestakingContract(host)` + `revDist.proposeRestakingChange(host)` (48h each) → execute.
6. **`forge build --sizes`** — CONFIRM `TegridyRestaking` ≤ 24,576 B and `TegridyRestakingAdmin` ≤ 24,576 B. If the host is still over, escalate the move (e.g. relocate more display/legacy views to `RestakingMonitorView`, or `pendingBase`-style getters) — do **not** ship over-limit.
7. **`forge fmt --check`** + **full test suite green** (the §3.5 list, with event/target repointing + the 4 new equivalence tests). CI `Contracts CI` is the authoritative gate (`[[reference_local_forge_build_hang]]`, `[[reference_slither_gate]]` — raw Slither is chronically red; ignore per memory).
8. **MANDATORY external re-audit before any deploy.** This surface is fund-touching (attribution credits, NFT rescue, residual-claimant writes, sweep-to-staking) and the split re-expresses previously-audited bodies across a new trust boundary. Per `[[project_2026_07_16_gated_batch_deployed.md]]` do not un-gate / deploy fund-touching features without a per-feature audit, and do not accept ownership into a flagged Safe — rebuild the Safe and re-home first.
