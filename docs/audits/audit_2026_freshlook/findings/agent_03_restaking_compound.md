# Agent 03 — TegridyRestaking Compound / Share Accounting / Deposit-Withdraw

Target: `contracts/src/TegridyRestaking.sol` (~2131 lines)
Lens: deposit-then-claim sandwich, share-debt anchor anchoring, inflated cached boost siphoning, residual-claim flow, NFT-stranded recovery paths.

Note on framing: TegridyRestaking is **not** an ERC4626/share vault — each user holds at most one tsTOWELI NFT, with bonus accounting via Masterchef-style `accBonusPerShare * boostedAmount` over `totalRestaked`. The first-depositor share-inflation primitive does not directly apply, but inflated-cache and stale-pool-denominator attacks substitute for it.

---

## F-03-K1 — Restake of expired-lock position siphons bonus emission via inflated cached boost

**Severity:** HIGH

**Location:** `restake()` L596–L659 + `claimAll()` re-sync block L872–L917

**Class:** Stale-cache over-credit / boost-amount manipulation / accounting drift between staking and restaking.

**Description:**
`restake(_tokenId)` reads the current `boostedAmount` from `staking.positions(_tokenId)` (L628) and unconditionally trusts the value. There is **no check that `lockEnd > block.timestamp`**, and TegridyStaking applies lock decay only lazily — it lives inside `_decayIfExpired`, which is invoked by `_getReward` and `kick`, **not** by the NFT transfer hook (`_settleRewardsOnTransfer` does not decay).

Therefore, when a position whose lock expired at T_exp has not yet been kicked / claimed / withdrawn, `staking.positions(tokenId).boostedAmount` is **still the pre-decay value** ("inflated") at any T > T_exp. A user calling `restake(tokenId)` at T_exp + ε copies that inflated boost into:

- `info.boostedAmount = inflated`  (L644)
- `info.bonusDebt = inflated × accBonusPerShare(T) / 1e18`  (L636, L645)
- `totalRestaked += inflated`  (L651)

The user is now earning bonus emission as if their lock were active.

**Exploit:**
1. Attacker holds a tsTOWELI position whose lock has expired. No external sweeper has called `kick(tokenId)` or `decayExpiredRestaker`.
2. Attacker calls `restake(tokenId)` — caches inflated boost in `restakers[attacker]` and bumps `totalRestaked`.
3. Time passes. `lastBonusRewardTime` advances on the next `updateBonus`-modified call by another user (or the attacker's own `claimAll`). `accBonusPerShare` increases by `Δt × rate × 1e18 / totalRestaked_inflated`.
4. Attacker calls `claimAll()`:
   - L783 reads `currentBoosted = staking.positions(...)` — still inflated (decay still not fired). `stale = false`.
   - L855 calls `_accrueBonusChecked()` against inflated `totalRestaked`.
   - L862 calls `staking.getReward(tokenId)`. Inside `_getReward`, after the reward calc, `_decayIfExpired` zeros `p.boostedAmount` on the staking side.
   - L882 re-reads `staking.positions(tokenId)`. `postClaimBoosted = 0`.
   - L885: `if (postClaimBoosted > 0 && postClaimBoosted != info.boostedAmount)` — **FALSE** (postClaimBoosted == 0), so the re-sync is **skipped**. `info.boostedAmount` remains inflated; `totalRestaked` is still inflated.
   - L937–L948: bonus diff = `info.boostedAmount × (accBonusPerShare - bonusDebt_anchor) / 1e18` = `inflated × Δacc / 1e18` — paid out to attacker.
5. Net effect: attacker collects `inflated_share / totalRestaked_inflated` × `Δt × rate` for the period between restake and claim — emission that would otherwise have flowed to honest restakers.

The attacker's "fair" share is **0** (their lock has no boost). Any amount paid is a direct theft from honest restakers' future bonus accrual.

**Attacker:** Any address holding a tsTOWELI whose lock has expired and not yet been kicked / had `getReward` called / had `decayExpiredRestaker` called. No special role needed.

**Impact:**
- Direct value transfer from honest restakers to attacker, proportional to (a) the inflated boost relative to `totalRestaked`, and (b) the time window between restake and the first decay-trigger.
- Exploit window persists until either the attacker themselves triggers `getReward` (via `claimAll`) — which still pays them — or any third party calls `decayExpiredRestaker(attacker)` / `kick(tokenId)` (the latter is staking-side and would close the inflated cache only in concert with a downstream restaking-side stale-path settlement).
- Worst case on a fresh launch with no decay sweeper: attacker can hold the inflated cache until the next call site (their own claimAll/unrestake/refresh) triggers the staking-side decay — and the bonus payout in *that very call* still uses the inflated cache.
- Attack surface is permissionless; victims are every other restaker (silent under-credit).

**PoC (sketch):**
```
// Pre: alice has tokenId=A with lockEnd = T0, no kick yet.
// Pre: totalRestaked_honest = H (other restakers).
// At T0 + 1 second:
vm.warp(T0 + 1);
restaking.restake(A);                            // info.boostedAmount = inflated_A (full pre-decay value)
                                                 // totalRestaked = H + inflated_A
vm.warp(T0 + 1 days);                            // honest restakers should get 1 day × rate; attacker should get 0
restaking.claimAll();                            // attacker receives inflated_A/(H + inflated_A) × 1 day × rate
```

**References / mitigation paths:**
- Reject expired locks at `restake`: `if (lockEnd <= block.timestamp) revert StaleLock();` after reading `staking.positions(_tokenId)`.
- Or: invoke `staking.kick(_tokenId)` at restake time when lock is expired, *before* reading `boostedAmount`, so the cached value is the post-decay (zero) value and the user is rejected by `if (boostedAmount == 0) revert ZeroAmount();` (need a paired check since L629 only checks `amount`).
- Or: in `claimAll`'s post-claim re-sync (L885), drop the `postClaimBoosted > 0` guard. When `postClaimBoosted == 0` and `info.boostedAmount > 0`, the cache must still be reset and `totalRestaked` debited. The current guard was added for the autoMaxLock branch (DR2-04), but the `> 0` shape was over-tightened — `postClaimBoosted != info.boostedAmount` is the load-bearing predicate; the `> 0` extra-check is the bug.

---

## F-03-K2 — `emergencyForceReturn` strands NFT permanently when transfer fails (no `claimStrandedRestakeNFT` recovery path)

**Severity:** MEDIUM

**Location:** `emergencyForceReturn()` L1687–L1807, in concert with `rescueNFT()` L1675–L1679 and `claimStrandedRestakeNFT()` L1652–L1658.

**Class:** State-cleanup ordering / recovery-path coverage gap.

**Description:**
`emergencyForceReturn` is the owner-only, `whenPaused` exit path used when the staking contract is broken or a restaker can't unrestake normally. It clears restaking-side state pre-transfer (L1771 `delete restakers[restaker]`) and then attempts `safeTransferFrom(this, restaker, tokenId)` inside try/catch (L1779).

If the transfer fails (recipient is a hostile contract or 7702-delegated EOA without `onERC721Received`), the catch branch only sets `nftReturned = false` (L1784) and falls through. **No `strandedRestakeRecipient[tokenId]` is recorded** (unlike the unrestake / emergencyWithdrawNFT paths at L1111 and L1584).

Result: the NFT sits in the restaking contract; the restaker has no on-chain recovery primitive:
- `claimStrandedRestakeNFT(tokenId)` (L1652) requires `strandedRestakeRecipient[tokenId] == msg.sender` — never set on this branch.
- `rescueNFT(_tokenId, _to)` (L1675) is gated by `tokenIdToRestaker[_tokenId] == address(0)` (the comment at L1782–L1784 *intends* `tokenIdToRestaker` to be preserved for later owner-routed recovery), AND further constrained to `_to == address(staking)` by L1677. So even owner-routed rescue is locked out (`tokenIdToRestaker != 0` reverts BadParam).

The natspec at L1782–L1784 calls out "rescueNFT can only send to the original restaker, preventing theft" — but this comment is **stale**: the current `rescueNFT` (post BATCH-J1 H18 hardening) only routes to `address(staking)`. The intended M-04 recovery path (route stranded NFT back to original restaker) does not exist in the deployed code.

**Exploit / Outcome:**
- Pre-condition: restaker is a hostile contract or 7702-delegated EOA without `onERC721Received`, AND owner has paused the contract and called `emergencyForceReturn(tokenId)`. The transfer in `try stakingNFT.safeTransferFrom(...)` reverts.
- The NFT is now permanently stuck in the restaking contract. Restaker has lost their NFT (and the underlying staked TOWELI principal that the staking contract holds against this tokenId, until staking-side recovery fires).
- Even after the restaker fixes their wallet (removes 7702 delegation, deploys an `IERC721Receiver`-compliant wrapper), there is no entrypoint to retry the transfer:
  - `claimStrandedRestakeNFT` reverts `NotRestakedToken` because `strandedRestakeRecipient[tokenId] == 0`.
  - `unrestake` / `emergencyWithdrawNFT` revert `NotRestaked` because `restakers[restaker].tokenId == 0` (deleted at L1771).
  - `rescueNFT` reverts because `tokenIdToRestaker[tokenId] != 0` (preserved at L1773–L1775 deliberately).

**Attacker:** Not an attack per se — this is a self-DoS by an unfortunate restaker whose wallet shape changes between deposit and the owner's emergency-force-return. The owner's good-faith emergency action makes the situation worse (irreversible stranding). The mistake is silent: only the `EmergencyForceReturn(restaker, tokenId, false)` event surface flags it.

**Impact:**
- Permanent loss of NFT custody and any unsettled rewards attributed to the position once the staking position is later wound down.
- No on-chain recovery path. Off-chain remedy would require a contract upgrade.

**PoC (sketch):**
```
// Pre: restaker is contract C without onERC721Received. C restaked tokenId=X.
// Owner paused, called emergencyForceReturn(X). Transfer fails.
// Now: restakers[C] cleared, tokenIdToRestaker[X] = C, strandedRestakeRecipient[X] = 0.
// C upgrades wallet to support onERC721Received.
restaking.claimStrandedRestakeNFT(X);   // reverts NotRestakedToken (strandedRestakeRecipient[X]==0)
restaking.unrestake();                  // reverts NotRestaked (restakers[C]==0)
// Owner:
restaking.rescueNFT(X, C);              // reverts BadParam (_to != address(staking))
restaking.rescueNFT(X, address(staking)); // reverts BadParam (tokenIdToRestaker[X] != 0)
// NFT permanently stuck.
```

**References / mitigation paths:**
- In the `catch` block at L1781–L1785, set `strandedRestakeRecipient[tokenId] = restaker; emit RestakeNFTStranded(tokenId, restaker);` — same shape as `unrestake` (L1110–L1113) and `emergencyWithdrawNFT` (L1583–L1586).
- Update the natspec at L1782–L1784 to reflect the current `rescueNFT` shape.
- Consider clearing `tokenIdToRestaker[tokenId]` once `strandedRestakeRecipient` is set, so the existing rescueNFT path opens (though even then, rescueNFT only routes to staking, which is itself a dead-end for NFTs — see Notes below).

---

## F-03-K3 — `rescueNFT` bypasses `strandedRestakeRecipient` claim (owner can rescue a stranded NFT into staking dead-end)

**Severity:** MEDIUM

**Location:** `rescueNFT()` L1675–L1679; `unrestake()` L1077–L1113; `emergencyWithdrawNFT()` L1559–L1586; `claimStrandedRestakeNFT()` L1652–L1658.

**Class:** Privilege escalation by trusted owner / missing claim-bypass guard.

**Description:**
After a `unrestake()` or `emergencyWithdrawNFT()` that hits the stranded path (NFT transfer to user reverts), the contract:
1. Clears `restakers[user]` and `tokenIdToRestaker[tokenId]` (L1077–L1078) **before** the transfer.
2. Sets `strandedRestakeRecipient[tokenId] = user` (L1111).

The user expects to recover via `claimStrandedRestakeNFT(tokenId)` after fixing their wallet (e.g., removing EIP-7702 delegation). However, between the unrestake and the user's claim, the owner can call `rescueNFT(tokenId, address(staking))` — the gate `if (tokenIdToRestaker[_tokenId] != address(0)) revert BadParam();` succeeds (it was cleared at L1077), and the NFT is shipped to the staking contract.

Inside the staking contract, the NFT now has `_positionsByOwner[stakingContract].add(tokenId)` and `userTokenId[stakingContract] = tokenId`, but no entrypoint exists for the staking contract to release the NFT (every staking-side withdrawal path requires `ownerOf(tokenId) == msg.sender`, and the contract has no private key). The position is also not sweepable — `staking.sweepToken` is ERC20-only.

**Outcome:** stranded user permanently loses their NFT custody, even though their on-chain recovery path (`claimStrandedRestakeNFT`) was set up correctly. The owner can do this whether maliciously or by mistake (e.g., scripted "post-pause cleanup" routines).

**Attacker / Trust assumption:** Requires owner key compromise OR owner mistake. Owner is trusted, but the protection model elsewhere (`H17` redirected sweeps to staking treasury, `H18` constrained `_to`) explicitly assumes captured-owner adversary. Under that adversary model, this is a real escalation: the owner cannot directly steal NFTs (they only route to staking), but can permanently destroy user positions by routing stranded NFTs into the staking dead-end.

**Impact:**
- Permanent custody loss for stranded users.
- Cannot be undone without an upgrade.

**PoC:**
```
// Pre: alice was a 7702-EOA without onERC721Received. alice unrestakes.
// Stranded mapping is now strandedRestakeRecipient[A] = alice, tokenIdToRestaker[A]==0.
// alice plans to claim after removing delegation. In the meantime:
// Captured-owner key calls:
restaking.rescueNFT(A, address(staking));
// NFT is now in staking contract — alice has lost it forever.
// (claimStrandedRestakeNFT(A) would revert: ownerOf(A)==staking, the safeTransferFrom call from
//  this==restaking would fail because restaking no longer holds A.)
```

**References / mitigation:**
- Add `if (strandedRestakeRecipient[_tokenId] != address(0)) revert BadParam();` to `rescueNFT`. Mirrors the `tokenIdToRestaker` block.

---

## F-03-K4 — `unsettledSnapshot` field is dead state (gas waste; previously load-bearing in pre-fix racy delta path)

**Severity:** LOW (gas / code health)

**Location:** `RestakeInfo` struct L101–L110 (field at L107); written at L647 in `restake`; never read.

**Class:** Dead state — write-only field consumes a 32-byte slot SSTORE on every `restake` (~22.1k gas) and adds an extra `staking.unsettledRewards(address(this))` external view call.

**Description:**
The `unsettledSnapshot` field was introduced for AUDIT H-06 to anchor a pre-deposit snapshot for the racy "before/after delta" attribution path used pre-C-1. After the per-tokenId attribution refactor (`claimUnsettledForTokenId`), the field is no longer read anywhere in the codebase:

```
$ grep -rn 'unsettledSnapshot\|info\.unsettled' contracts/src
contracts/src/TegridyRestaking.sol:107:        uint256 unsettledSnapshot;...
contracts/src/TegridyRestaking.sol:647:            unsettledSnapshot: unsettledAtDeposit
```

**Impact:**
- ~22.1k gas per `restake` (one extra SSTORE) plus the cost of the `staking.unsettledRewards(...)` external call (~2.6k gas). Pure waste on every restake operation.
- Storage layout bloat: the field consumes a dedicated slot; future struct extensions land further out and pay extra SLOAD cost on `restakers[]` reads everywhere.
- No security impact, but the natspec at L107–L110 references the obsolete delta-attribution flow as if it were live, misleading future maintainers.

**Mitigation:**
- Remove the field from `RestakeInfo`, drop the `staking.unsettledRewards(address(this))` call at L640, and delete the assignment at L647. Update the comment.
- Note: this is a storage-layout-breaking change for an upgradeable proxy, but TegridyRestaking is not upgradeable (`OwnableNoRenounce` + immutable state). Safe to ship in next deployment.

---

## F-03-K5 — `claimResidualForTokenId` is `whenNotPaused`; pause traps residual claimants indefinitely

**Severity:** LOW

**Location:** `claimResidualForTokenId()` L1256.

**Class:** Pause-coverage mismatch / availability concern under owner action.

**Description:**
Most exit and self-recovery paths intentionally drop `whenNotPaused` so users can always escape:
- `unrestake`, `emergencyWithdrawNFT`, `claimStrandedRestakeNFT`, `claimPendingUnsettled`, `recoverStuckPrincipal` — all unguarded by pause.

`claimResidualForTokenId` is the inverse: `external nonReentrant whenNotPaused`. A residual claimant whose pre-fix unrestake left a per-tokenId residue cannot recover it while the contract is paused. Combined with the residue gating `restake` (L610 — `TokenIdHasPendingResidual`), this pauses ALL secondary uses of the same tokenId.

**Impact:**
- Residual claimants lose access to legitimate rewards during indefinite pause windows.
- Owner has `emergencyForceReturn` for the active-restaker case but no equivalent for residual-claim recovery — captured owner could pause the contract specifically to deny residual claimants their funds.

**Mitigation:**
- Drop `whenNotPaused` from `claimResidualForTokenId`. The function only pulls from `staking.unsettledRewardsByTokenId[tokenId]` (a per-user-attributed bucket) — does not interact with `accBonusPerShare` or any state the pause is meant to freeze. Pattern of record: every other exit path is pause-independent.

---

## F-03-K6 — `decayExpiredRestaker` silently under-credits the period between `lastBonusRewardTime` and lock-expiry-trigger

**Severity:** LOW (acknowledged design trade-off; documenting for completeness)

**Location:** `decayExpiredRestaker()` L1942–L2042.

**Class:** Permissionless-call accounting boundary / disputed-period attribution.

**Description:**
The R017-RETRY ordering is:
1. Settle the expired restaker on **OLD boost** at the **PRE-accrue** `accBonusPerShare`.
2. Shrink `totalRestaked`.
3. Run `_accrueBonusChecked` against the corrected smaller denominator.
4. Re-anchor expired restaker's `bonusDebt` at POST-accrue.

This means the elapsed period between the last `updateBonus`-modified call (`lastBonusRewardTime`) and the `decayExpiredRestaker` call is allocated **entirely to the post-shrink set** (i.e., excludes the expired restaker), even for the sub-window where the expired restaker still had a valid lock.

When an attacker (or honest decay sweeper) calls `decayExpiredRestaker(victim)` quickly after the lock expires, they snap the entire `T_lastUpdate → T_call` window away from the victim, who legitimately earned during `T_lastUpdate → T_lockExpiry`.

This is **explicitly documented** in the natspec at L1925–L1941 as a one-sided trade-off: under-credit the expired restaker rather than allow them to over-credit by claiming against the inflated cache. The contract chooses the conservative branch — which closes the over-credit attack at the cost of a small under-credit on the disputed sub-period.

**Why it's not (re-classified) high:** The economic loss is bounded by `(T_lockExpiry - T_lastUpdate) × inflated_share / totalRestaked` for the disputed sub-window, often only a few minutes/hours (since `lastBonusRewardTime` advances on every `updateBonus`-modified call from any actor in the pool). The opposite (over-credit) bug would be unbounded and would also accrue against future periods — strictly worse. The current ordering is correct.

**Mitigation (only if perfect attribution is desired):**
- Sub-divide the elapsed period into `T_lastUpdate → T_lockExpiry` (credit at OLD boost via the existing settle step) and `T_lockExpiry → T_call` (accrue at NEW denominator). Requires reading `liveLockEnd` from `staking.positions` and computing two `_accrueBonus`-style increments. Significant complexity for a small economic delta.
- Acknowledged as out-of-scope. Document expectation in user-facing docs ("decay sweepers may snap a small disputed-period bonus from expired restakers").

---

## Notes / dead-ends

- **First-depositor share inflation (ERC4626-style):** Not applicable. Restaking is NFT-keyed, one position per address. No share-token, no `convertToShares` path. The closest analogue — `accBonusPerShare * boostedAmount / 1e18` — is updated atomically on every `restake`/`unrestake` and uses `totalRestaked` as the denominator (an internal counter that cannot be inflated by donating tokens). `bonusRewardToken` direct-donation does not change `totalRestaked` and is properly time-rate-limited via `bonusRewardPerSecond` rather than dumped into `accBonusPerShare` instantly. A frontrun-then-claim flash dump is therefore not viable.

- **Donation attack on bonus pool (rate-limited by bonusRewardPerSecond):** Verified safe. `_accrueBonus` clamps `reward = min(elapsed × rate, balance)` (L335–L348 + L2061–L2082), so a donation only feeds future per-second accrual, not an instant `accBonusPerShare` jump.

- **Reentrancy via NFT receive callback:** `restake` is `nonReentrant`. The NFT comes from the Tegridy staking contract (immutable, audited). `onERC721Received` (L2119) accepts only from `address(staking)`. State updates after the safeTransferFrom are protected by `nonReentrant`.

- **Sandwich on `fundBonus`:** `fundBonus` is permissionless and uses the `updateBonus` modifier, which accrues against the current pool *before* the new tokens arrive (`_accrueBonus` reads `balanceOf(this)` mid-call, but the funding `safeTransferFrom` happens *after* the modifier — so the post-funding balance only contributes to the next `_accrueBonus` window). No instantaneous bonus jump that a sandwicher could front-run/back-run.

- **Bonus rate timelock churn:** `proposeBonusRate` has a 24h `BONUS_RATE_ACTION_COOLDOWN` (DR-07 fix) preventing propose+cancel churn; `cancelBonusRateProposal` is unblocked (DR2-05 fix). Together with the 48h `BONUS_RATE_TIMELOCK`, captured-key impact bounded.

- **`updateBonus` on `restake`:** Modifier runs BEFORE the body, so accrual happens against the OLD `totalRestaked` (excluding new restaker) and the new restaker's `bonusDebt` is anchored at the post-accrual `accBonusPerShare`. Correct Masterchef ordering — new joiners do not retroactively claim emission earned before they joined.

- **Stale-cache attack on claimAll/unrestake/refresh (R014-RETRY territory):** Verified the stale-path properly settles at OLD boost / PRE-accrue, then shrinks `totalRestaked`, then accrues against the corrected denominator, then re-anchors. The pattern is reused across `claimAll`, `unrestake`, `refreshPosition`, and `decayExpiredRestaker`. This is the only viable attack class against the cached-boost system, and it appears closed for these four sites.

- **`claimResidualForTokenId` cross-holder:** Verified `currentOwner != address(this) && currentOwner != msg.sender` (L1281) returns early when the NFT is at a tracked third party (e.g., TegridyLending). The shared `unsettledRewardsByTokenId[tokenId]` mapping cannot leak loan-period rewards to the prior restaker.

- **TokenId reuse:** Confirmed `_nextTokenId` in TegridyStaking is monotonically increasing (`uint256 tokenId = _nextTokenId++` in `stake` / `stakeWithBoost`). Burned tokenIds are never reissued, so residual-claim mappings on past tokenIds cannot be hijacked by a fresh-mint collision.

- **`restake` re-entry via `_settleRewardsOnTransfer`:** Staking-side hook does not touch `p.boostedAmount` and only credits `unsettledRewards[from]`. From the attacker's perspective there is no callback re-entry into restaking — the attacker must own the NFT (so `from == attacker`, not a tracked holder), and `_isTrackedHolder(from) == false` short-circuits the `unsettledRewardsByTokenId` write path inside the staking transfer hook.

- **`rewardToken` donation manipulation:** `recoverStuckPrincipal` and `claimPendingUnsettled` correctly subtract `totalUnforwardedBase + totalActivePrincipal + totalPendingUnsettled` reservations before computing recoverable balance. Verified there is no path to over-count one user's donation as another user's principal.

- **`pendingBonus` view path:** Wraps `bonusRewardToken.balanceOf` in try/catch (DR2-06), uses `_boostedAmountAt` clamped by `min(cached, current)` (DEEP-DR-08), and respects pause-independence. View surface is consistent with the mutator surface for the in-bounds (lock-active) case. The expired-lock case still over-reads (matches the F-03-K1 mutator path), but the view itself is not directly exploitable — it is a UX/indexer-honest reading of the same buggy state.

- **`_safeBonusTransferExt` self-call surface:** Only callable via `address(this) == msg.sender` check (L2128). External attackers cannot invoke directly. nonReentrant on `decayExpiredRestaker` blocks re-entry through the try/catch.
