# Deep Audit v2 — TegridyNFTPool & TegridyNFTPoolFactory (2026-05-01)

**Scope:**
- `contracts/src/TegridyNFTPool.sol` (post-fix, 707 lines)
- `contracts/src/TegridyNFTPoolFactory.sol` (post-fix, 614 lines)

**Pre-conditions verified (pass-1 fixes correctly shipped at `aba7e6c`):**
- DEEP-NFTPOOL-01 — `lastWithdrawBlock` stamp at L320 (removeLiquidity), L477 (withdrawETH), L490 (withdrawNFTs); swap-side guard at L199 / L252 — verified shipped.
- DEEP-NFTPOOL-02 — `pendingXExecuteAfter != 0 → revert ExistingProposalPending` on `proposeSpotPrice` (L330), `proposeDelta` (L357), `proposeFeeChange` (L385) — verified shipped.
- DEEP-NFTPOOL-03 — `OWNER_TIMELOCK = 48 hours` enforced in `acceptOwnership` (L433-435) — verified shipped.
- DEEP-NFTPOOL-04 — explicit `cancelOwnerChange` (L423-429) and `proposeOwnerChange(0)` rejected (L416) — verified shipped.
- DEEP-NFTPOOL-05 — `accumulatedLPFees` accumulator (L51), `claimLPFees` (L452-458), `priorOwnerOwed` snapshot in `acceptOwnership` (L438-444), `claimPriorOwnerLPFees` (L460-466) — verified shipped.
- DEEP-NFTPOOL-06 — `_swapInFlight` flag set/cleared at swap entry/exit (L208, L240, L261, L286) and consulted at L593 — verified shipped.
- DEEP-NFTPOOL-07 — 10% liquidity buffer enforced in `withdrawETH` (L473-474) and `removeLiquidity` (L313-315) — verified shipped.
- DEEP-NFTPOOL-08 — `receive()` restricted to `msg.sender == factory` (L603-605) — verified shipped.
- DEEP-NFTPOOL-09 — salt now mixes `block.chainid + address(this) + msg.sender + counter + collection + poolType` (L199-208) — verified shipped.
- DEEP-NFTPOOL-10 — `withdrawProtocolFees(uint256)` overload + `MAX_DAILY_WITHDRAWAL` rate-limit (L573-594) — verified shipped.
- DEEP-NFTPOOL-11 — `PoolFeesClaimed` / `PoolFeesClaimFailed` events emitted in factory claim paths (L524, L552, L554) — verified shipped.
- DEEP-NFTPOOL-12 — pools query `factory.emergencyPaused()` at swap entry (L201, L254); factory `setEmergencyPaused` with 6h cooldown (L603-610) — verified shipped.

---

## [DEEP-NFTPOOL-V2-01] `_swapInFlight` deposit gate accepts deposits from ANY external caller during the swap window
**Severity:** Medium
**File:** `contracts/src/TegridyNFTPool.sol:581-600`
**Category:** other

**Bug:** The new `_swapInFlight` gate at L593 was added to fix DEEP-NFTPOOL-06 (legacy ERC721 collections that pass an unexpected operator field). However, the implementation is over-permissive: while `_swapInFlight == true`, **any external address** can call `nftCollection.safeTransferFrom(theirAddress, pool, anyTokenId)` and the pool will accept the deposit AND register the tokenId in `_heldIds`. The intended scope was "the seller's NFT inflow during their own swap"; the actual scope is "any caller, any token, any direction". Because pool transfers OUT during a buy swap (`swapETHForNFTs`) trigger the buyer's `onERC721Received` callback while `_swapInFlight = true`, the buyer can re-enter and donate or pollute the pool's inventory before the swap completes. Direct re-entry of `swap*` is still blocked by `nonReentrant`, but the `safeTransferFrom` deposit path is reached via the NFT collection itself (different entry point).

**Attack / Impact:** Inventory pollution and accounting drift. A buyer-contract receiving NFTs during `swapETHForNFTs` can in its `onERC721Received` hook deposit valueless / unrelated tokenIds back into the pool. Each deposited tokenId is auto-registered in `_heldIds`. The owner cannot easily distinguish legitimate inventory from griefer-deposited junk. Although this does not directly steal funds (the bonding curve does not depend on `_heldIds.length` for pricing), it (a) inflates the held-IDs array, increasing gas for any future `getHeldTokenIds()` view consumers and pagination logic, (b) lets a griefer "stuff" target tokenIds the owner doesn't want into the pool's inventory (e.g., dust NFTs the owner now has to manually withdraw and pay gas to dispose of), (c) opens a denial-of-service surface against view-function consumers — a malicious actor can repeatedly stuff via mass swaps until the inventory is unwieldy.

**Evidence:**
```solidity
// L593 — over-permissive gate
require(
    operator == owner ||
        operator == address(this) ||
        operator == factory ||
        _swapInFlight,
    "UNAUTHORIZED_DEPOSIT"
);
// ↑ When _swapInFlight is true, ANY operator is accepted.
//   During swapETHForNFTs L220 transfers, the BUYER receives the NFT and
//   their onERC721Received fires while _swapInFlight is still true.
//   Buyer can call back into the NFT collection and deposit arbitrary
//   tokenIds INTO the pool — accepted unconditionally.
```

**Recommendation:** Tighten the gate. Track the active swap's caller in a transient variable (`address internal _swapCaller`) set at swap entry; in `onERC721Received` accept `_swapInFlight && from == _swapCaller`. This restricts the open-deposit window to the intended seller's inflow. Alternative: only allow `_swapInFlight` deposits when the from-address matches `tx.origin` (weaker, but blocks the buyer-callback re-entry vector since buyer != tx.origin in most contract-contract cases). Cleanest fix: pass an explicit `_depositingForSwap` flag set ONLY in `swapNFTsForETH` (the direction that needs it), not in `swapETHForNFTs`.

---

## [DEEP-NFTPOOL-V2-02] Emergency-pause cooldown blocks corrective UNPAUSE — minimum 6h pause duration is forced
**Severity:** Medium
**File:** `contracts/src/TegridyNFTPoolFactory.sol:603-610`
**Category:** dos

**Bug:** The DEEP-NFTPOOL-12 fix correctly added a 6-hour cooldown between `setEmergencyPaused` calls to prevent grief-spam (rapid pause/unpause flips). However, the cooldown applies symmetrically to BOTH directions of the toggle. Once the factory owner calls `setEmergencyPaused(true)` — even mistakenly or in response to a false alarm — they CANNOT unpause for the next 6 hours. The cooldown is enforced before the state transition and does not distinguish pause-direction. This converts the emergency-pause from a safety lever into a 6-hour minimum-shutdown commitment: no rollback path exists for a hasty / mistaken activation. For a global cascade that disables every pool's swaps protocol-wide, mandatory 6h locks have severe operational costs.

**Attack / Impact:** Operational lockup. Scenario: factory owner observes anomalous activity, hits the panic button (`setEmergencyPaused(true)`), discovers within minutes that the alarm was a false positive (e.g., a misread on-chain log). The owner cannot restore service — every pool's swap remains frozen for 6 hours. LP withdrawals still work (pool-level pause is independent), but the cascade effectively freezes a healthy protocol for a quarter of a day per false alarm. Worse, an adversary who briefly captures the owner key (e.g., session hijack) can pause and immediately rotate the key — the new legitimate owner inherits a 6h-locked protocol.

**Evidence:**
```solidity
// L603-610 — cooldown applies to BOTH pause and unpause directions
function setEmergencyPaused(bool paused) external onlyOwner {
    if (lastEmergencyAt != 0 && block.timestamp < lastEmergencyAt + EMERGENCY_PAUSE_COOLDOWN) {
        revert EmergencyCooldown();
    }
    emergencyPaused = paused;
    lastEmergencyAt = block.timestamp;
    emit EmergencyPauseSet(paused, msg.sender);
}
```

**Recommendation:** Cooldown only on the pause→ direction (or only when `paused == emergencyPaused` to prevent same-direction spam). Allow `setEmergencyPaused(false)` (corrective unpause) at any time:
```solidity
function setEmergencyPaused(bool paused) external onlyOwner {
    // Cooldown only applies when entering paused state (pause-direction).
    if (paused && lastEmergencyAt != 0 && block.timestamp < lastEmergencyAt + EMERGENCY_PAUSE_COOLDOWN) {
        revert EmergencyCooldown();
    }
    emergencyPaused = paused;
    lastEmergencyAt = block.timestamp;
    emit EmergencyPauseSet(paused, msg.sender);
}
```
This preserves anti-spam (can't pause-then-immediately-pause-again to rate-limit log spam) while restoring the fast-revert path for mistaken activations. Pattern: Compound's PauseGuardian / Aave's emergency admin both allow instant unpause.

---

## [DEEP-NFTPOOL-V2-03] Legacy `withdrawProtocolFees()` (no-arg) reverts unexpectedly when daily cap is partially used
**Severity:** Low
**File:** `contracts/src/TegridyNFTPoolFactory.sol:563-568`
**Category:** other

**Bug:** The DEEP-NFTPOOL-10 fix preserved a no-arg `withdrawProtocolFees()` for backwards compatibility, routing through the rate-limit. The function caps the withdrawal at `min(balance, MAX_DAILY_WITHDRAWAL)`, then calls `_withdrawWithRateLimit(amt)`. But the rate-limiter checks `withdrawnToday + amt > MAX_DAILY_WITHDRAWAL` AGAINST the absolute cap, not the remaining cap. So if `withdrawnToday = 500e18` and `balance = 800e18`, the no-arg function passes `amt = 800e18` (because `balance < MAX_DAILY_WITHDRAWAL`), which overflows the daily cap → revert with `DailyCapExceeded`. The legacy interface's "do the right thing" intent silently fails whenever the day's cap has been partially consumed.

**Attack / Impact:** Operational confusion. A scheduled keeper / treasury bot calling the no-arg path on a recurring basis will suddenly fail with no warning once the cap fills mid-day. The expected fallback ("withdraw what's available") doesn't happen — the function reverts entirely and emits no event, so the keeper logs only a transaction failure with no actionable signal. The fix forces operators to calculate and pass the remaining-cap arithmetically off-chain even though that math is on-chain.

**Evidence:**
```solidity
// L563-568
function withdrawProtocolFees() external onlyOwner nonReentrant {
    uint256 balance = address(this).balance;
    require(balance > 0, "NO_FEES");
    uint256 amt = balance > MAX_DAILY_WITHDRAWAL ? MAX_DAILY_WITHDRAWAL : balance;
    _withdrawWithRateLimit(amt);
    // ↑ Does NOT subtract withdrawnToday — partially-used days revert.
}
```

**Recommendation:** Cap to `min(balance, MAX_DAILY_WITHDRAWAL - withdrawnToday)`, accounting for window roll:
```solidity
function withdrawProtocolFees() external onlyOwner nonReentrant {
    uint256 balance = address(this).balance;
    require(balance > 0, "NO_FEES");
    uint256 remainingCap;
    if (block.timestamp >= dayStart + 1 days) {
        remainingCap = MAX_DAILY_WITHDRAWAL;
    } else {
        remainingCap = MAX_DAILY_WITHDRAWAL - withdrawnToday;
    }
    uint256 amt = balance < remainingCap ? balance : remainingCap;
    if (amt == 0) revert DailyCapExceeded();
    _withdrawWithRateLimit(amt);
}
```

---

## [DEEP-NFTPOOL-V2-04] `_lpAvailableETH` / 10 buffer collapses to zero at low balances — buffer ineffective in dust regime
**Severity:** Low
**File:** `contracts/src/TegridyNFTPool.sol:313-315, 472-474`
**Category:** math

**Bug:** The DEEP-NFTPOOL-07 buffer math (`minBuffer = lpAvailable / 10`) computes 10% of available ETH. For `lpAvailable < 10 wei`, integer division yields `minBuffer = 0`, allowing the owner to drain the entire balance. While 9 wei is dust and irrelevant, the more subtle issue is that the buffer's effectiveness scales linearly with magnitude — a pool with `lpAvailable = 1 ether (1e18 wei)` has a 0.1 ether buffer, but the threshold for "any sell could underpay" is governed by the minimum sell payout the curve permits, which can be many orders of magnitude smaller than 10% of the total balance. Conversely, a pool with `lpAvailable = 100 wei` has 10 wei buffer — irrelevant since any sell payout would be >>100 wei.

The buffer is not derived from "expected_max_sell_payout" (the original DEEP-NFTPOOL-07 recommendation) but from a heuristic 10% slice of arbitrary current state. This means:
- (a) On a freshly funded pool with 10 ETH and a max-sell-payout of 0.5 ETH per item, the buffer of 1 ETH is much larger than necessary, reducing capital efficiency.
- (b) On a depleted pool with 0.1 ETH and a per-sell payout of 0.05 ETH, the buffer of 0.01 ETH is INSUFFICIENT to actually prevent the next sell from reverting on `POOL_INSUFFICIENT_ETH`.

**Attack / Impact:** Withdraw-then-sell DoS still possible at scale-mismatched pools (the bug DEEP-NFTPOOL-07 was meant to close). Owner can withdraw 90% of available ETH; the next pending sell may STILL revert on `POOL_INSUFFICIENT_ETH` if the per-sell payout exceeds the remaining 10%. Conversely, capital efficiency is lost on well-funded pools.

**Evidence:**
```solidity
// L313-315
uint256 lpAvailable = _lpAvailableETH();
uint256 minBuffer = lpAvailable / 10;
if (ethAmount + minBuffer > lpAvailable) revert MinLiquidityBuffer();
// ↑ Heuristic 10% — not derived from the bonding-curve max payout.
//   Disconnected from the actual solvency requirement that the buffer
//   was supposed to enforce.
```

**Recommendation:** Compute the buffer as the maximum sell payout the curve currently permits given `getMaxSellable()`:
```solidity
uint256 maxItems = getMaxSellable();
uint256 worstSellPayout = (maxItems > 100 ? 100 : maxItems) * spotPrice; // upper bound
uint256 minBuffer = worstSellPayout;  // exact, not heuristic
if (ethAmount + minBuffer > lpAvailable) revert MinLiquidityBuffer();
```
Or simpler: enforce `lpAvailable >= spotPrice * 100` (largest single-swap batch) as the post-withdraw floor. Either ties the buffer to actual solvency, not arbitrary percentage.

---

## [DEEP-NFTPOOL-V2-05] `acceptOwnership` does not block when the pool is paused — incident-response capture risk
**Severity:** Low
**File:** `contracts/src/TegridyNFTPool.sol:431-450`
**Category:** other

**Bug:** `acceptOwnership` lacks the `whenNotPaused` modifier. If the current owner pauses the pool (via `pause()` at L506) — e.g., as part of incident response after detecting a key compromise — the attacker who already submitted a valid `proposeOwnerChange(attackerAddr)` 48h earlier can STILL call `acceptOwnership` and capture the pool, bypassing the pause. The pause stops swaps but does not prevent ownership transfers. After the attacker takes ownership, they can `unpause()` and proceed to drain via the (rate-limited but still permissive) `withdrawETH/withdrawNFTs/claimLPFees` paths.

**Attack / Impact:** Incident-response evasion. A defender who notices a suspicious `OwnerChangeProposed` event 24h into the 48h timelock has no way to stop the transfer except (a) call `cancelOwnerChange` from the still-controlled-by-defender owner, OR (b) get the attacker to not call `acceptOwnership`. Path (a) requires the defender's key to still be uncompromised — but if the proposal was submitted by an attacker who had control, the defender's "current owner" status is itself in question. Pause does not provide an additional barrier to the ownership transfer itself.

This also interacts with `factory.emergencyPaused`: even if the factory owner sets `emergencyPaused = true`, `acceptOwnership` proceeds — the cascade only blocks swaps.

**Evidence:**
```solidity
// L431-435 — no whenNotPaused, no emergency-paused check
function acceptOwnership() external {
    if (msg.sender != pendingOwner || msg.sender == address(0)) revert NotPendingOwner();
    if (pendingOwnerExecuteAfter == 0 || block.timestamp < pendingOwnerExecuteAfter) {
        revert TimelockNotElapsed();
    }
    address oldOwner = owner;
    // ...
}
```

**Recommendation:** Add `whenNotPaused` AND check `factory.emergencyPaused()`:
```solidity
function acceptOwnership() external {
    if (paused()) revert("Pausable: paused");
    if (ITegridyNFTPoolFactoryView(factory).emergencyPaused()) revert EmergencyPaused();
    if (msg.sender != pendingOwner || msg.sender == address(0)) revert NotPendingOwner();
    if (pendingOwnerExecuteAfter == 0 || block.timestamp < pendingOwnerExecuteAfter) {
        revert TimelockNotElapsed();
    }
    // ...
}
```
Pause becomes a meaningful incident-response tool, not just a swap-stopper.

---

## [DEEP-NFTPOOL-V2-06] `claimLPFees` sends to `owner` (live read), not the caller — front-runnable on owner transition
**Severity:** Low
**File:** `contracts/src/TegridyNFTPool.sol:452-458`
**Category:** mev

**Bug:** `claimLPFees` is `onlyOwner` and sends to `owner` (read live):
```solidity
function claimLPFees() external onlyOwner nonReentrant {
    uint256 amount = accumulatedLPFees;
    if (amount == 0) return;
    accumulatedLPFees = 0;
    _sendETH(owner, amount);  // ← live read of `owner`
    emit LPFeesClaimed(owner, amount);
}
```
Because `acceptOwnership` swaps `owner` and snapshots `accumulatedLPFees` into `priorOwnerOwed[oldOwner]`, the snapshot is supposed to capture the prior owner's earnings. But there's a race: if the OLD owner submits `claimLPFees()` and the NEW owner submits `acceptOwnership()` in the same block, MEV ordering determines who gets the fees. Specifically:
- Sequence A (`claimLPFees` first): Old owner gets `accumulatedLPFees`. `acceptOwnership` snapshots 0 to `priorOwnerOwed[oldOwner]`. Net: old owner has the funds, no double-spend.
- Sequence B (`acceptOwnership` first): Snapshot moves `accumulatedLPFees` into `priorOwnerOwed[oldOwner]`. The old owner's `claimLPFees` then SUCCEEDS but goes to the NEW owner (because `owner` has been updated). Old owner loses access to their own fees in the same block.

The fact that `claimLPFees` reads `owner` instead of `msg.sender` (which is the only address that passed `onlyOwner`) means the function delivers to whoever is owner AT THE MOMENT OF EXECUTION, which can be the attacker after a same-block flip.

**Attack / Impact:** During a contested ownership transition, the new owner can MEV-front-run the old owner's `claimLPFees` by submitting `acceptOwnership` with higher gas in the same block. Old owner's claim then redirects funds to the new owner. Limited blast radius (only fees accumulated since the snapshot baseline), but it inverts the intent of the snapshot mechanism. The old owner has to either claim BEFORE the new owner can call `acceptOwnership` (and they don't know exactly when the 48h timelock elapses) OR rely on the snapshot — which the same-block race can defeat.

**Evidence:**
```solidity
// L456 — sends to live `owner` rather than `msg.sender`
_sendETH(owner, amount);
```

**Recommendation:** Send to `msg.sender` (the address that just passed the `onlyOwner` check):
```solidity
function claimLPFees() external onlyOwner nonReentrant {
    uint256 amount = accumulatedLPFees;
    if (amount == 0) return;
    accumulatedLPFees = 0;
    _sendETH(msg.sender, amount);  // ← was: _sendETH(owner, amount)
    emit LPFeesClaimed(msg.sender, amount);
}
```
This eliminates the same-block redirect and is consistent with `claimPriorOwnerLPFees` (L460-466) which already uses `msg.sender`.

---

## [DEEP-NFTPOOL-V2-07] Stale-pendingOwner persistence after `executeFeeChange` / parameter execution — `owner` rotation does not invalidate pending owner change
**Severity:** Low
**File:** `contracts/src/TegridyNFTPool.sol:415-450`
**Category:** other

**Bug:** When ownership transfers via `acceptOwnership`, NO other pending governance state is cleared. Specifically: a `pendingSpotPrice / pendingDelta / pendingFeeBps` proposed by the OLD owner is now executable by the NEW owner without re-proposing. Conversely, the new owner has NO way to immediately propose a competing change because the `ExistingProposalPending` guard rejects re-proposals while a stale one is in flight (DEEP-NFTPOOL-02 fix). The new owner must call `cancelXChange` first (assuming they know the prior pending state exists), wasting a transaction.

More serious: the OLD owner could "poison" the pool before transfer by proposing a malicious price change with `executeAfter` set 24h in the future. The new owner takes ownership 48h later (after the OLD owner proposed at acceptance), realizes too late that a `pendingFeeBps = 9000` (max) is queued, and cannot stop it from executing because `executeFeeChange` is `onlyOwner` — they need to cancel first.

**Attack / Impact:** Time-bomb governance state. A malicious or careless seller of a pool position can leave queued proposals that the buyer inherits. Buyer must audit ALL `pendingX` state at acceptance time and immediately cancel to reset, paying gas for each cancellation. Forgotten cancellations execute on schedule with the new owner blamed for the change. Not financially catastrophic (the timelock window itself surfaces the change), but a real "estate planning" footgun for pool sales.

**Evidence:**
```solidity
// L431-450 — acceptOwnership clears only ownership state
function acceptOwnership() external {
    // ...
    address oldOwner = owner;
    uint256 snapshot = accumulatedLPFees;
    if (snapshot > 0) {
        priorOwnerOwed[oldOwner] += snapshot;
        accumulatedLPFees = 0;
        // ...
    }
    owner = pendingOwner;
    pendingOwner = address(0);
    pendingOwnerExecuteAfter = 0;
    // ↑ Does NOT clear pendingSpotPrice/pendingDelta/pendingFeeBps
    //   left behind by the prior owner.
}
```

**Recommendation:** Clear all pending governance state on ownership transition:
```solidity
// In acceptOwnership, after the LP-fee snapshot:
pendingSpotPrice = 0;
pendingSpotPriceExecuteAfter = 0;
pendingDelta = 0;
pendingDeltaExecuteAfter = 0;
pendingFeeBps = 0;
pendingFeeBpsExecuteAfter = 0;
emit SpotPriceChangeCancelled(0); // optional: signal cleanup
emit DeltaChangeCancelled(0);
emit FeeChangeCancelled(0);
```
Or simpler: emit a single `OwnershipPendingProposalsCleared(oldOwner, newOwner)` event for indexers.

---

## Summary — counts and prioritization

- **Medium:** 2 (V2-01 swap-flight deposit too permissive; V2-02 emergency-pause cooldown blocks corrective unpause)
- **Low:** 5 (V2-03 no-arg withdraw revert; V2-04 buffer math heuristic; V2-05 acceptOwnership not pause-gated; V2-06 claimLPFees send-to-`owner` race; V2-07 pending governance not cleared on owner change)

**Top regression-pass-2 deploy-blockers:**
1. **V2-01** — `_swapInFlight` opens an unintended deposit window. The original DEEP-NFTPOOL-06 intent was narrower; the implementation is over-broad. Tighten to `_swapInFlight && from == _swapCaller`.
2. **V2-02** — Emergency-pause is not undoable for 6h. Asymmetric cooldown (pause-only) restores the corrective-unpause path while preserving anti-grief.
3. **V2-06** — `claimLPFees → owner` (live read) lets a same-block `acceptOwnership` redirect old-owner fees to the new owner. Trivial fix: send to `msg.sender`.

**Cross-cutting observation:** The pass-1 fixes correctly closed every flagged surface, but several were tactical patches that introduced new edge cases (V2-01, V2-02). The recurring pattern: a guard added without considering the FULL space of legitimate callers (V2-01 lets ANY caller deposit, V2-02 blocks ANY direction of pause-flip).

**No critical or high regressions discovered. Pass 2 confirms the pass-1 hardening is structurally sound; the remaining items are refinement-class.**
