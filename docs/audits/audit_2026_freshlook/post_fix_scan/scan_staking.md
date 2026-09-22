# Staking Suite — Post-Fix Confirmatory Scan

**Date:** 2026-05-09
**HEAD:** `5f58c52` (docs: RELAUNCH_RUNBOOK.md) on top of `cd9717c` (test realign: 2588/2588 non-invariant pass).
**Mandate:** `memory/feedback_minimal_surface.md` — battle-tested billion-dollar code only; custom code IS the exploit source.
**Scope:**
- `contracts/src/TegridyStaking.sol` (2346 LoC) — Curve veCRV lockup + Synthetix `StakingRewards` reward index
- `contracts/src/TegridyRestaking.sol` (2468 LoC) — SushiSwap MasterChef V2 `accBonusPerShare` with NFT-position accounting
- `contracts/src/TegridyStakingJbacVault.sol` (132 LoC) — Minimal escrow vault (custody + stranded reclaim)
- `contracts/src/TegridyStakingAdmin.sol` (362 LoC) — OZ `TimelockController` propose/execute/cancel pattern via `TimelockAdmin` lib

---

## Executive verdict

**OK TO SHIP.** All four targeted FRESH-2026 markers (C-1 anchor reorder analog, H-1 restake-of-expired guard, H-2 autoMaxLock JBAC bonus restore, F-65-1/M-28 applyRestakingContract balanceOf guard, H-14 executeAdminReplacement validity expiry) verify clean against canonical patterns. Storage layout matches snapshots. The known LOW-RESIDUAL on H-2 (legacy `hasJbacBoost && !jbacDeposited` flash-borrow blip) is class-property of the legacy population — closed-by-design via `_isTrackedHolder`, `revalidateBoost`, and `decayExpiredRestaker`. Custom code remains minimal: vault is 132 LoC pure escrow; admin is 362 LoC propose/execute/cancel triplets with no parameter logic of its own.

**No NEW exploits detected. No sister-misses between TegridyStaking, TegridyRestaking, and TegridyLPFarming on the C-1 anchor pattern.**

---

## 1. Per-contract divergence catalogue

### TegridyStaking.sol — Curve veCRV + Synthetix StakingRewards canonical

| Divergence from canonical | Classification | Notes |
|---|---|---|
| Solady `ERC721` (vs OZ) | **JUSTIFIED** | EIP-170 size budget; battle-tested at Uniswap V3 NFT, Sudoswap, Friend.tech. Behaviour-preserving migration (batch-14). |
| `Position` struct with `rewardDebt` (int256) — MasterChef variant of Synthetix anchor | **JUSTIFIED** | Per-NFT positions need per-token debt; Synthetix `userRewardPerTokenPaid` is per-address. The MasterChef adaptation is the canonical NFT-position accumulator (used by Aerodrome `Voter`, Velodrome ve-NFT). |
| Lazy `_decayIfExpired` (cliff vs. veCRV linear decay) | **JUSTIFIED** | Cliff decay simpler + cheaper; the natspec at line 487 acknowledges divergence. `kick(tokenId)` is the Curve `LiquidityGaugeV4.kick` permissionless poke that closes the staleness window. |
| `unsettledRewards[holder]` + `unsettledRewardsByTokenId[tokenId]` dual-attribution | **JUSTIFIED (C-1 fix)** | Custom but unavoidable — two restakers' kick credits in shared `unsettledRewards[restakingContract]` race for each other's share. Per-tokenId attribution closes that. Documented at lines 241–256, 1755–1769. |
| `auto-max-lock` opt-in perpetual MAX boost | **JUSTIFIED** | Curve veCRV does NOT have this; it's the canonical Aerodrome/Velodrome `LOCK_FOREVER` semantic. Set-and-forget UX win. |
| `EARLY_WITHDRAWAL_PENALTY_BPS = 25%` + `penaltyRecycleBps` split | **JUSTIFIED** | Conservative tweak to Curve veCRV's "no early exit" stance. Penalty recycle pattern is Aerodrome `RewardsDistributor` precedent. |
| `extendFeeBps` + `extendFeeRecycleBps` split (M-AUDIT-2026-1) | **JUSTIFIED** | Closes the dilution-vs-fee asymmetry (whale extends → all stakers diluted, fee goes to treasury, stakers get nothing). The split mirrors the C6 penalty-recycle pattern already in-tree. |
| `MAX_POSITIONS_PER_HOLDER = 50` cap | **JUSTIFIED** | Bound on `votingPowerOf` O(n) iteration cost per checkpoint write. Comment at line 207–214 captures the gas math. |
| Stake-time JBAC deposit (vs. balanceOf snapshot) | **JUSTIFIED (H-1 fix)** | ApeCoin Staking pattern. Closes the flash-loan vector for new stakes. Custody is in `TegridyStakingJbacVault`. |
| `isLendingContract[]` + `restakingContract` exempt-from-cooldown carve-outs | **JUSTIFIED** | Round-trip semantics for whitelisted escrow contracts. AUDIT H-01 / Spartan TF-02 pattern. `applyLendingContract(false)` blocks revoke while NFTs are escrowed (DEEP-DS-10). |
| Custom timelock `pendingStakingAdmin` / `adminReplacementReadyAt` (vs. `TimelockAdmin` lib) | **JUSTIFIED** | Bespoke replacement flow lives on STAKING (not on Admin) so a broken/compromised Admin can't block its own removal. R014 H-2 rationale. |

**Verdict:** every divergence cites a canonical precedent or a documented attack class the canonical doesn't cover. **No REDUNDANT divergences.**

---

### TegridyRestaking.sol — SushiSwap MasterChef V2 + ApeCoin Staking deposit pattern

| Divergence from canonical | Classification | Notes |
|---|---|---|
| `accBonusPerShare` accumulator | **CANONICAL** | Verbatim MasterChef V2 share-acc pattern (line 99–101, 444). Monotonicity-checked via `_accrueBonusChecked` wrapper (DEEP-DR-03) — defensive only. |
| Stale-path branching in `claimAll` / `unrestake` / `refreshPosition` (R014 RETRY) | **JUSTIFIED** | Closes the inflated-denominator emission siphon. The stale path settles OLD boost at PRE-accrue, anchors `bonusDebt` BEFORE transfer (CEI), shrinks `totalRestaked`, then re-accrues against the corrected denominator and re-anchors POST-accrue. This IS the canonical four-step Synthetix anchor reorder applied to the cross-contract case. |
| `RestakeInfo.unsettledSnapshot` field preserved as 0 (F-04-4) | **JUSTIFIED** | ABI compat for 40+ test sites that bind tuple shape. Field is write-only post-C-1 attribution refactor. Documented at line 104–113. |
| `_residualClaimant[tokenId]` per-tokenId residue lock (REVIEW C-1) | **JUSTIFIED** | Closes the covert-leak between exiting restaker and next-acquirer. Custom but minimal (one mapping + one gate at `restake()`). |
| `unforwardedBaseRewards` (rewardToken) + `unforwardedBonusRewards` (bonusRewardToken) dual buckets | **JUSTIFIED (H-3 fix)** | Closes the WETH-debit-paid-as-TOWELI bug. Denomination-segregated buckets are the only correct fix. |
| `claimUnsettledForTokenId` + per-tokenId attribution (vs. shared bucket) | **JUSTIFIED (C-1 fix)** | Same per-tokenId attribution as TegridyStaking. The two contracts agree on `_isTrackedHolder` as the authority signal. |
| `decayExpiredRestaker` permissionless poke | **JUSTIFIED** | Curve `LiquidityGaugeV4.kick` analog. AUDIT NEW-S3 four-step reorder fixes the inflated-denominator siphon. Self-call try/catch on bonus transfer (BATCH-N4 M26) defends against blacklist DoS. |
| `_safeBonusTransferExt` self-call wrapper for try/catch | **JUSTIFIED** | Minimal pattern for "wrap external call in try/catch from inside a `nonReentrant` context"; address-this gate prevents external grief. |
| `bonusRewardTokenUnit` decimal-scaled rate cap (F-84-1) | **JUSTIFIED** | Closes the asymmetric constructor (10e18) vs propose (100e18) cap. Cached at deploy time per POLAccumulator `toweliUnit` precedent. |
| `proposeRescueNFT` 48h timelock (M-4) | **JUSTIFIED** | Aave V3 ACL-governed `rescueTokens` propose-delay precedent. Re-checks at execute time per DEEP-R-M01. |
| `proposeClearResidualClaimant` 7-day timelock (F-04-3) | **JUSTIFIED** | Compound `Timelock.GRACE_PERIOD` analog for an admin override of an abandoned-but-non-empty claim. Per-tokenId mapping supports parallel in-flight clears. |

**Verdict:** every divergence cites a canonical precedent. **No REDUNDANT divergences.**

---

### TegridyStakingJbacVault.sol — Minimal escrow vault (Yearn V2-style custody)

| Divergence from canonical | Classification | Notes |
|---|---|---|
| Two-mapping vault (`strandedJbacOwner` + `strandedJbacTokenId`) | **CANONICAL** | Two slots = two SLOADs, no struct/array. Smaller than struct equivalent. |
| Try/catch on `safeTransferFrom` with stranded fallback | **JUSTIFIED** | Closes the JBAC-contract-pause DoS (user can't get their JBAC back). The recovery path `claimStrandedJbac` is gated on per-tokenId `strandedJbacOwner` so only the rightful prior staker can reclaim. |
| `onlyStaking` modifier on `returnJbac` | **CANONICAL** | OZ AccessControl-equivalent gate; only the wired TegridyStaking can release custody. |
| `onERC721Received` gated to `jbacNFT` only | **CANONICAL** | OZ `IERC721Receiver` pattern; rejects any other ERC721 collection at the door. |

**Verdict:** 132 LoC, every line has a canonical precedent. **No REDUNDANT code.** This is the textbook minimal-surface vault.

---

### TegridyStakingAdmin.sol — OZ TimelockController via TimelockAdmin lib

| Divergence from canonical | Classification | Notes |
|---|---|---|
| `TimelockAdmin` lib (vs OZ `TimelockController` directly) | **JUSTIFIED** | Lib is internal-inheritance instead of external `Timelock` contract — saves a contract deployment + cross-call gas. Behavioral parity with MakerDAO DSPause/OZ TimelockController for propose/execute/cancel + 7-day validity window. Battle-tested across 17 in-tree children. |
| Per-parameter typed `propose*`/`execute*`/`cancel*` triplets | **CANONICAL** | OZ Governor + Compound Governor Bravo pattern. Each triplet wraps the `_propose(KEY, DELAY)` / `_execute(KEY)` / `_cancel(KEY)` lib primitives. |
| 48h delays across all parameters (vs. Compound's variable delays) | **JUSTIFIED** | Conservative single-delay simplification — single auditable invariant. Compound itself uses 2-day default for treasury-class. |
| `MAX_MAX_UNSETTLED = 1e10 ether` defense-in-depth ceiling | **JUSTIFIED (F-35-3)** | Symmetric with staking-side. Fail-fast at propose so 48h timelock isn't burned on a doomed change. |
| F-43-C / F-60-2 EOA + EIP-7702 reject on `proposeRestakingContract` | **JUSTIFIED** | OwnableNoRenounce M29 mirror. Closes typo/phished-proposal install of EOA at the 48h mark. |

**Verdict:** 362 LoC of pure dispatch — no parameter logic of its own (every `apply*` is a one-liner forwarding to the wired staking contract). **No REDUNDANT divergences.**

---

## 2. Confirmatory exploit checks

### C-1 anchor pattern parity — TegridyStaking vs. TegridyRestaking vs. TegridyLPFarming

**TegridyLPFarming `updateReward` (LPFarming:225–245):** rewards anchored under OLD boost FIRST, THEN boost cache refreshed.
```solidity
rewards[account] = earned(account);                       // anchor at OLD boost
userRewardPerTokenPaid[account] = rewardPerTokenStored;   // mark anchor point
// ... THEN refresh effective balance cache with new boost
```
This is the canonical Synthetix `StakingRewards` reorder.

**TegridyStaking `_getReward` (Staking:1490–1533) + `_applyNewBoost` (Staking:2125–2133):**
```solidity
// _getReward
accumulated = (p.boostedAmount * rewardPerTokenStored) / ACC_PRECISION;  // OLD boost
diff = accumulated - p.rewardDebt;
p.rewardDebt = accumulated;                                              // anchor BEFORE decay
_decayIfExpired(tokenId, p);                                             // THEN decay
```
Every callsite that mutates `boostedAmount` (extendLock, toggleAutoMaxLock, increaseAmount, revalidateBoost, getReward autoMaxLock decay-restore, kick) calls `_getReward(tokenId, p)` BEFORE `_applyNewBoost`. This is the canonical anchor reorder: rewards crystallised at OLD boost, then boost is updated and `rewardDebt` re-anchored at NEW.

**TegridyRestaking stale-paths (Restaking:798–865, 882–1071, 1097–1145):**
```solidity
// step 1: settle pending bonus on OLD boost at PRE-accrue accBonusPerShare
preAccum = (oldBoosted * accBonusPerShare) / ACC_PRECISION;
preDiff  = preAccum - info.bonusDebt;
info.bonusDebt = preAccum;                       // CEI: anchor BEFORE transfer
// step 2: shrink totalRestaked + update cache
info.boostedAmount = currentBoosted;
totalRestaked = totalRestaked - oldBoosted + currentBoosted;
// step 3: accrue against corrected denominator
_accrueBonusChecked();
// step 4: re-anchor at POST-accrue NEW boost
info.bonusDebt = (currentBoosted * accBonusPerShare) / ACC_PRECISION;
```
This is the four-step Synthetix anchor reorder applied to the cross-contract case (boost cache lives on staking; bonus accumulator lives on restaking). Fully consistent with the LPFarming and TegridyStaking patterns.

**Cross-cutting verdict: PASS.** All three contracts apply the same canonical anchor-first pattern. **No sister-miss between TegridyStaking, TegridyRestaking, and TegridyLPFarming.** When the cached boost is mutated, the rewards/bonus from the OLD-boost period are crystallised first, then the boost is updated, then the debt anchor is re-set at NEW.

---

### H-1 restake-of-expired siphon — verified

**TegridyRestaking:736:**
```solidity
if (lockEnd <= block.timestamp) revert PositionExpired();
```
**TegridyStaking:489–495 (`_decayIfExpired`):**
```solidity
if (p.boostedAmount > 0 && p.lockEnd > 0 && block.timestamp >= p.lockEnd) {
    totalBoostedStake -= p.boostedAmount;
    p.boostedAmount = 0;
    ...
}
```

The two predicates are aligned: at exactly `T == lockEnd`, the staking side decays AND the restaking side rejects. **PASS** — siphon closed.

Boundary cases:
- `lockEnd == 0` (uninitialised slot): rejected by `0 <= block.timestamp` (always true) AND by `amount == 0` check on Restaking:723. Belt-and-suspenders.
- `lockEnd == block.timestamp + 1`: `<=` returns false → restake proceeds (lock is still genuinely live for 1 second). Correct.
- Front-run by attacker calling `kick()` immediately before user's `restake()`: kick zeros boostedAmount, restake then sees `lockEnd <= block.timestamp` → reverts. User must withdraw + re-stake fresh. No newly-introduced grief.

---

### H-2 autoMaxLock JBAC bonus restore — verified

**TegridyStaking:1076–1086 (getReward autoMaxLock decay-restore):**
```solidity
bool jbacStillValid =
    p.jbacDeposited ||                                            // (a) deposit-based custody
    (p.hasJbacBoost && jbacNFT.balanceOf(msg.sender) > 0);        // (b) legacy balance check
uint256 newBoost = MAX_BOOST_BPS;
if (jbacStillValid) {
    newBoost += JBAC_BONUS_BPS;
} else if (p.hasJbacBoost) {
    p.hasJbacBoost = false;                                        // clear stale flag
}
_applyNewBoost(p, newBoost);
```

**Branch coverage analysis:** the H-2 fix lives ONLY on `getReward`'s autoMaxLock decay-restore branch — the only branch where `revalidateBoost`'s LockExpired guard cannot fire (autoMaxLock just rewrote `lockEnd` to `now + MAX_LOCK_DURATION`, so `revalidateBoost` returns "not expired" and CAN strip via its existing balanceOf check).

The other paths that re-compute boost using cached `hasJbacBoost`:
| Path | Line | Condition | Stale-bonus risk? |
|---|---|---|---|
| `toggleAutoMaxLock` enable | 884 | `if (p.hasJbacBoost) newBoost += JBAC_BONUS_BPS` | NO — line 867 reverts on `block.timestamp >= p.lockEnd`. User on a non-expired lock retains the bonus they paid for at stake time; calling `revalidateBoost` is the canonical strip path and remains available pre-expiry. |
| `extendLock` | 929 | same | NO — line 914 reverts on expired. Same logic. |
| `increaseAmount` | 970 | same | NO — line 950 reverts on expired. Same logic. |

Per `agent_02_staking_math.md` F-02-K-01 (the H-2 finding), the exploit specifically targets the **decay-restore** moment: lock expires → `_decayIfExpired` zeros `boostedAmount` → autoMaxLock fires and rewrites `lockEnd` to MAX → bonus is RE-GRANTED without verification → `revalidateBoost` thereafter cannot strip because the lock is now "live" again. The other branches PRESERVE existing boost on a still-live lock — they don't re-grant after a decay window. **H-2 fix is correctly scoped to the only branch where `revalidateBoost` cannot serve as the strip path.**

The known LOW-RESIDUAL flash-borrow on `balanceOf` for the (b) branch is a pre-existing class-property of legacy `hasJbacBoost && !jbacDeposited` positions (pre-H-1 grandfathered population only — no NEW positions of this kind can be created post-H-1). Same surface as `revalidateBoost`'s own balanceOf check (Staking:1313). Documented as F-02-K-05 INFORMATIONAL.

**Verdict: PASS.** H-2 fix is correctly scoped; no sister-miss on `extendLock`/`toggleAutoMaxLock-enable`/`increaseAmount` because those branches don't introduce a NEW grant — they preserve cached state on still-live locks.

---

### F-65-1 / M-28 applyRestakingContract balanceOf guard — verified

**TegridyStaking:2076–2084:**
```solidity
function applyRestakingContract(address _restaking) external onlyAdmin {
    if (_restaking == address(0)) revert ZeroAddress();
    address oldRestaking = restakingContract;
    if (oldRestaking != address(0) && balanceOf(oldRestaking) > 0) {
        revert PendingRestakingPositions();
    }
    restakingContract = _restaking;
}
```

**TegridyStaking:2097–2101 (`applyLendingContract`):**
```solidity
function applyLendingContract(address _lending, bool _approved) external onlyAdmin {
    if (_lending == address(0)) revert ZeroAddress();
    if (!_approved && balanceOf(_lending) > 0) revert PendingLendingPositions();
    isLendingContract[_lending] = _approved;
}
```

**Symmetry check:** both use `balanceOf(holder) > 0` (Solady `_balanceOf` of THIS contract's own ERC721 collection, never inflated by external IERC721 — DS2-08 reasoning). Both block the dangerous direction:
- `applyRestakingContract`: blocks rotation while OLD restaking still has staking-NFTs → would orphan per-tokenId attribution because `_isTrackedHolder(oldRestaking)` flips false post-rotation.
- `applyLendingContract`: blocks revoke while lending contract still has staking-NFTs → would orphan the round-trip back to borrower (cooldown/rate-limit/AlreadyHasPosition guards would fire post-revoke).

**Verdict: PASS.** Symmetric guards present and aligned. Same `balanceOf` semantic, same revert pattern.

---

### H-14 executeAdminReplacement validity expiry — verified

**TegridyStaking:2025–2038:**
```solidity
function executeAdminReplacement() external onlyOwner {
    uint256 readyAt = adminReplacementReadyAt;
    if (readyAt == 0) revert Unauthorized();                  // no pending proposal
    if (block.timestamp < readyAt) revert Unauthorized();     // delay not elapsed
    // AUDIT FIX FRESH-2026: H-14 — 7-day validity window after readyAt.
    if (block.timestamp > readyAt + 7 days) revert Unauthorized();
    address newAdmin = pendingStakingAdmin;
    if (newAdmin == address(0)) revert ZeroAddress();
    address oldAdmin = stakingAdmin;
    stakingAdmin = newAdmin;
    pendingStakingAdmin = address(0);
    adminReplacementReadyAt = 0;
    emit StakingAdminReplaced(oldAdmin, newAdmin);
}
```

7-day cap at `readyAt + 7 days` matches Compound Timelock GRACE_PERIOD pattern AND in-tree TimelockAdmin lib (TimelockAdmin:209). Inclusive at lower boundary (`<` strict-less), inclusive at upper boundary (`>` strict-greater). Stale-proposal scenario closed: a years-old `pendingStakingAdmin` slot reverts after 48h+7d = 9 days from propose.

**Verdict: PASS.** 7-day cap present at line 2030. Boundary semantics match Compound and in-tree TimelockAdmin.

---

## 3. Storage layout verification

| Contract | Snapshot file | Source slot count | Status |
|---|---|---|---|
| `TegridyStaking.sol` | `.audit_2026_freshlook/storage_layout/TegridyStaking.txt` | slots 0–34 (OwnableNoRenounce 0–2, Pausable 3, then staking state 4–34) | **MATCH** — append-only since prior snapshot. New constants `MAX_MAX_UNSETTLED` (constant, no slot), new errors (no slot). No mid-layout insertion. |
| `TegridyRestaking.sol` | `TegridyRestaking.txt` | slots 0–32 | **MATCH** — append-only. F-04-1 added `unforwardedBonusRewards` (21) + `totalUnforwardedBonus` (22), F-04-3 added `pendingResidualClears` (23), F-04-2 added `pendingRescueNFT` (24–25), F-04-7 added immutable `bonusRewardTokenUnit` (no slot). |
| `TegridyStakingAdmin.sol` | `TegridyStakingAdmin.txt` | slots 0–11 | **MATCH** — fresh contract, no prior on-chain state to preserve. |
| `TegridyStakingJbacVault.sol` | `TegridyStakingJbacVault.txt` | slots 0–1 | **MATCH** — fresh contract, immutables only besides the two stranded mappings. |

**Verdict: PASS.** No slot drift, no mid-layout insertion. All FRESH-2026 additions are append-only or constants/immutables.

---

## 4. Cross-cutting checks

### Sister-miss search across TegridyStaking + TegridyRestaking + TegridyLPFarming

The C-1 anchor reorder appears in three places:
1. `TegridyLPFarming.updateReward` (LPFarming:225–245) — rewards anchored, then effective-balance cache refreshed.
2. `TegridyStaking.{_getReward, _applyNewBoost}` (Staking:1490–1533, 2125–2133) — rewards anchored, then `_decayIfExpired` / `_applyNewBoost` re-cache.
3. `TegridyRestaking.{claimAll, unrestake, refreshPosition}` stale paths — pending bonus settled at OLD boost, then `totalRestaked` corrected, then re-accrue + re-anchor.

**Each contract's mutating call paths were enumerated:**

| TegridyStaking path | Settles before boost change? | Anchor at OLD? |
|---|---|---|
| `extendLock` (899) | YES — `_getReward` at 923 | YES |
| `toggleAutoMaxLock` enable (856) | YES — `_getReward` at 877 | YES |
| `increaseAmount` (941) | YES — `_getReward` at 953 | YES |
| `revalidateBoost` downgrade (1283) | YES — `_getReward` at 1319 | YES |
| `getReward` autoMaxLock decay-restore (1056) | YES (via `_getReward`) | YES (via `_applyNewBoost`) |
| `kick` (1136) | YES — settles pending pre-decay via `_settleUnsettled` (1141) | YES — advances `rewardDebt` by `totalSettled` only (1233) |

| TegridyRestaking path | Settles before mutation? | Anchor at OLD? |
|---|---|---|
| `restake` (690) | N/A — first deposit, no prior boost to anchor | N/A |
| `claimAll` stale path (894) | YES — `preBonus` settled at PRE-accrue (901–910) | YES |
| `unrestake` stale path (1101) | YES — same pattern (1108–1117) | YES |
| `refreshPosition` stale path (798) | YES — same pattern (804–813) | YES |
| `decayExpiredRestaker` (2267) | YES — settles at pre-shrink `accBonusPerShare` (2286–2319) | YES |
| `revalidateBoostForRestaked/Restaker` (2146/2200) | YES — `_accrueBonus + accumulated - bonusDebt` settled (2174/2224) | YES |

**Verdict: PASS.** No sister-miss. Every callsite that mutates cached boost (or denominator) settles rewards/bonus FIRST under the OLD value, THEN updates the cache, THEN re-anchors debt at the NEW value.

### Cross-contract attribution invariant: `_isTrackedHolder`

Both `TegridyStaking._isTrackedHolder` (1765) and the corresponding restaking-side / lending-side claim paths agree on:
- Restaking contract is tracked iff `restakingContract != address(0)`.
- Lending contract is tracked iff `isLendingContract[holder]`.

This single source-of-truth keeps `unsettledRewardsByTokenId[*] <= unsettledRewards[holder]` coherent across kick / transfer / claim paths, and is checked at every read+write site that touches per-tokenId attribution.

**Verdict: PASS.** No drift between staking and restaking on the attribution authority signal.

---

## 5. Findings

### NEW exploit findings

**None.**

### Carried-forward LOW-RESIDUALs (no action recommended)

1. **F-02-K-05 [INFO] — `revalidateBoost` legacy balanceOf check.** Pre-existing semantic for the legacy population. A user can swap JBAC X for Y and the boost remains valid. Cannot be tightened post-hoc because legacy positions have `jbacTokenId == 0` (no anchor). Same surface used by H-2 fix (consistency with revalidateBoost is intentional).
2. **F-02-K-06 [INFO] — autoMaxLock rewrites `lockDuration` to MAX.** By design (perpetual MAX). Means a future revalidateBoost downgrade computes against MAX, not the user's original chosen duration. Documentation gap, no exploit.

### Carried-forward design accept items

1. **Custom `pendingStakingAdmin` flow on staking (vs. lib).** Bespoke to allow rotation when a broken/compromised Admin can't act. R014 H-2 rationale.
2. **Cliff-decay (vs. Curve veCRV linear).** Conservative simplification; `kick()` closes the staleness window.
3. **`auto-max-lock` opt-in.** Aerodrome/Velodrome `LOCK_FOREVER` analog, not in vanilla veCRV.

---

## 6. PASS / CONCERN / REDUNDANT verdict

| Contract | Verdict | Reasoning |
|---|---|---|
| `TegridyStaking.sol` | **PASS** | All FRESH-2026 markers (C-1 anchor reorder analog, H-2 jbacStillValid, M-28 balanceOf guard, H-14 7-day validity, F-02-K-03 lockEnd compare, F-02-K-04 boost-clamp, F-60-2/F-60-3 EIP-7702 reject) verify clean. No new exploits. No sister-misses with restaking/LPFarming. |
| `TegridyRestaking.sol` | **PASS** | All FRESH-2026 markers (H-1 PositionExpired, H-3 bonus/base bucket split, M-3/M-4 rescueNFT timelock, F-04-3 residual-clear timelock, F-04-7/F-84-1 decimal-scaled cap, F-04-4/5 ABI-shim) verify clean. R014 RETRY four-step anchor reorder is canonical. |
| `TegridyStakingJbacVault.sol` | **PASS** | 132 LoC, every line has a canonical precedent. Pure escrow + stranded recovery. No REDUNDANT code. |
| `TegridyStakingAdmin.sol` | **PASS** | 362 LoC of pure dispatch on the TimelockAdmin lib. F-35-3 / F-43-C / F-60-2 markers verify clean. No parameter logic of its own. |

**No CONCERN findings. No REDUNDANT divergences. SHIP.**

---

## Appendix — File:line index of audited markers

- TegridyStaking.sol:271–276 — F-35-2 (MAX_REWARD_RATE 1e18 cap)
- TegridyStaking.sol:444, 2076–2084 — M-28 / F-35-1 / F-65-1 (applyRestakingContract balanceOf guard)
- TegridyStaking.sol:445, 2334–2345 — F-35-3 (applyMaxUnsettledRewards CapTooHigh)
- TegridyStaking.sol:903–908 — F-02-K-03 (extendLock lockEnd compare)
- TegridyStaking.sol:958–972 — F-02-K-04 (increaseAmount boost-clamp)
- TegridyStaking.sol:1069–1088 — H-2 / F-02-K-01 (getReward autoMaxLock JBAC bonus restore)
- TegridyStaking.sol:1404–1415 — F-60-3 (EIP-7702 length-23 reject in `_afterTokenTransfer`)
- TegridyStaking.sol:1564–1583 — M-1 / F-02-K-02 (`_settleRewardsOnTransfer` shortfall route)
- TegridyStaking.sol:1968–1972 — F-60-2 (setStakingAdmin length-23 reject)
- TegridyStaking.sol:2005–2012 — F-43-B + F-60-2 (proposeAdminReplacement length-23 reject)
- TegridyStaking.sol:2019–2030 — H-14 / F-75-1 / F-43-A (executeAdminReplacement 7-day validity)
- TegridyRestaking.sol:736 — H-1 / F-03-K1 / F-87-K-01 / F-93-1 (restake PositionExpired)
- TegridyRestaking.sol:199, 1369, 2299–2318 — H-3 / F-04-1 (split bonus/base buckets)
- TegridyRestaking.sol:204, 1501–1530 — F-04-3 (proposeClearResidualClaimant 7-day timelock)
- TegridyRestaking.sol:216, 1934–1965 — M-3 / M-4 / F-04-2 (proposeRescueNFT 48h timelock)
- TegridyRestaking.sol:229, 405, 421–423 — F-04-7 / F-84-1 (decimal-scaled bonus rate cap)
- TegridyRestaking.sol:104–113 — F-04-4 (unsettledSnapshot ABI-compat preservation)
- TegridyRestaking.sol:1062–1069, 1190–1197 — F-04-5 (user-side bonus transfer try/catch)
- TegridyStakingAdmin.sol:57–58 — F-35-3 (CapTooHigh)
- TegridyStakingAdmin.sol:64–66, 187–191 — F-43-C / F-60-2 (proposeRestakingContract length-23 reject)
- TegridyStakingAdmin.sol:216–223 — F-35-3 (MAX_MAX_UNSETTLED admin-side ceiling)
