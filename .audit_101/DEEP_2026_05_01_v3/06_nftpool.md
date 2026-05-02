# Deep Audit v3 — TegridyNFTPool & TegridyNFTPoolFactory (2026-05-02)

**Scope:**
- `contracts/src/TegridyNFTPool.sol` (post-pass-2, 797 lines)
- `contracts/src/TegridyNFTPoolFactory.sol` (post-pass-2, 639 lines)

**Pre-conditions verified (pass-2 fixes shipped at `5d39ac7`):**
- V2-NFTPOOL-01 — `_swapCaller` field added (L66) and set/cleared at swap entry/exit (L215-216, 249-250, 272-273, 299-300); deposit gate uses `_swapInFlight && from == _swapCaller` (L661) — verified shipped.
- V2-NFTPOOL-02 — emergency-pause cooldown asymmetric: `paused &&` short-circuit (L629) — verified shipped.
- V2-NFTPOOL-03 — legacy `withdrawProtocolFees()` computes `remainingCap` with window-roll guard (L574-583) — verified shipped.
- V2-NFTPOOL-04 — `_minLiquidityBuffer()` introduced (L757-765) using `min(getMaxSellable(), 100) * spotPrice` — verified shipped.
- V2-NFTPOOL-05 — `acceptOwnership` decorated with `whenNotPaused` (L451) and gated on `factory.emergencyPaused()` (L457) — verified shipped.
- V2-NFTPOOL-06 — `claimLPFees` sends to `msg.sender` (L515-516) — verified shipped.
- V2-NFTPOOL-07 — `acceptOwnership` clears `pendingSpotPrice/Delta/Fee` triplets (L482-499) — verified shipped.

---

## [DEEP-NFTPOOL-V3-01] V2-NFTPOOL-01 fix is INCOMPLETE — buyer-callback inventory pollution still works
**Severity:** Medium
**File:** `contracts/src/TegridyNFTPool.sol:213-216, 643-667`
**Category:** other

**Bug:** The pass-2 patch introduced `_swapCaller = msg.sender` in BOTH `swapETHForNFTs` (L216) and `swapNFTsForETH` (L273), then narrowed the receiver-hook gate to `_swapInFlight && from == _swapCaller` (L661). The original V2 finding's recommendation explicitly warned against this: it told the team to "pass an explicit `_depositingForSwap` flag set ONLY in `swapNFTsForETH` (the direction that needs it), not in `swapETHForNFTs`." The committed code took the broader approach and as a result reproduces the exact griefing path V2-NFTPOOL-01 was supposed to close.

In `swapETHForNFTs`, `msg.sender` IS the buyer. After `_swapCaller = buyer` is committed, the loop at L224-229 transfers each purchased NFT to `buyer` via `nftCollection.safeTransferFrom(address(this), msg.sender, tokenId)`. The buyer's `onERC721Received` fires while `_swapInFlight == true` and `_swapCaller == buyer`. Inside that hook the buyer can call `nftCollection.safeTransferFrom(buyer, pool, junkTokenId)` for any tokenId they own; that triggers the pool's `onERC721Received` with `from == buyer == _swapCaller`, the gate at L661 passes, `_addHeldId(junkTokenId)` runs, and the junk NFT is registered in `_heldIds` against the owner's wishes. The pool's own `nonReentrant` modifier protects re-entry into other pool functions but does NOT cover the receiver hook (it has no nonReentrant), and the inbound deposit is mediated by the NFT collection contract — a separate address — so the reentrancy guard doesn't engage.

**Attack / Impact:** Same blast radius as the original V2-NFTPOOL-01. A contract-buyer (or any seller's hook in the swap-NFTs-for-ETH direction) can stuff arbitrary tokenIds into `_heldIds` during their own swap. Owner inherits dust NFTs they have to manually withdraw and pay gas to dispose of; `getHeldTokenIds()` view consumers (routers, frontends) get inflated arrays that increase pagination cost and can DoS naive list-everything callers. Combined with the per-swap 100-item cap, a single buyer can stuff up to 100 junk IDs per transaction. The bonding curve does not key off `_heldIds.length` so price impact is none — but the operational and indexing cost is real. This is the SAME finding as V2-NFTPOOL-01 — re-flagging because the patch did not actually close it.

**Evidence:**
```solidity
// L213-216 — _swapCaller is set to msg.sender in BOTH directions, including
//            the buy direction where msg.sender is the buyer (recipient of
//            transfers OUT of the pool).
_swapInFlight = true;
// AUDIT FIX: V2-NFTPOOL-01
_swapCaller = msg.sender;

// L661 — gate authorizes ANY deposit where from == _swapCaller. During
//        swapETHForNFTs the buyer IS _swapCaller, so deposits originating
//        from the buyer's `onERC721Received` callback (via the NFT
//        collection bridge, which sees from=buyer) authorize successfully.
bool authorizedSwapInflow = _swapInFlight && from == _swapCaller;
require(authorizedOperator || authorizedSwapInflow, "UNAUTHORIZED_DEPOSIT");
```

**Recommendation:** Per the original V2-NFTPOOL-01 recommendation that the patch did not implement: drop `_swapCaller` from `swapETHForNFTs` entirely. The buy direction has no legitimate inflow — every NFT moves from pool to buyer, never the reverse. Either:
- (a) Set `_swapInFlight = true` only in `swapNFTsForETH` (the direction that actually needs to accept inbound NFTs), OR
- (b) Add a stricter side-check: `_swapInFlight && _swapDirection == SELL && from == _swapCaller`, where `_swapDirection` is a transient enum set per swap.
Single-line fix is option (a): remove L213-216 from `swapETHForNFTs` and restore the original gate that only authorized owner/factory/self for that direction.

---

## [DEEP-NFTPOOL-V3-02] `setEmergencyPaused` updates `lastEmergencyAt` on UNPAUSE — corrective unpause locks the pause-button for 6h
**Severity:** Medium
**File:** `contracts/src/TegridyNFTPoolFactory.sol:621-635`
**Category:** dos

**Bug:** The V2-NFTPOOL-02 patch added the `paused &&` short-circuit at L629 so the cooldown only applies when ENTERING the paused state. That restored the corrective-unpause path. **But the patch left `lastEmergencyAt = block.timestamp` at L633 unconditional**, including on unpause. The cooldown check at L629 reads `lastEmergencyAt + EMERGENCY_PAUSE_COOLDOWN`, so unpausing now stamps the cooldown timer that future PAUSE attempts must clear. Net effect: any unpause locks the owner OUT of pausing for the next 6 hours, even if a fresh, unrelated incident demands an emergency response.

Concrete sequence:
- T = 0: owner observes anomaly, calls `setEmergencyPaused(true)`. `lastEmergencyAt = 0` initially → cooldown branch bypassed. `emergencyPaused = true`. `lastEmergencyAt = 0` (timestamp 0).
- T = 30 min: false-alarm confirmed, owner calls `setEmergencyPaused(false)`. `paused == false` short-circuit → cooldown bypassed. `emergencyPaused = false`. `lastEmergencyAt = 1800` (now).
- T = 35 min: a SECOND, real incident appears. Owner calls `setEmergencyPaused(true)`. Cooldown check: `paused == true && lastEmergencyAt(1800) != 0 && now(2100) < 1800 + 21600` ⇒ revert `EmergencyCooldown`. **Owner cannot pause for the next 5h55m.**

The whole point of allowing instant corrective unpause was to recover from a hasty pause without sacrificing the safety lever. The unconditional `lastEmergencyAt` update silently disarms that lever.

**Attack / Impact:** Operational DoS of the pause-button. Worst case: an attacker who briefly captures the owner key (session hijack, signed-message replay) calls `setEmergencyPaused(false)` with no observable effect (pool was already unpaused), but that single call now locks the legitimate owner out of pausing for 6 hours. Combined with a follow-up exploit windowed inside that 6h, the protocol has zero emergency response. The attacker doesn't even need to flip the pause — just touch the function — because `lastEmergencyAt` updates regardless of whether the state changed.

**Evidence:**
```solidity
// L621-635
function setEmergencyPaused(bool paused) external onlyOwner {
    // V2-NFTPOOL-02 fix: cooldown only on the pause→ direction.
    if (paused && lastEmergencyAt != 0 && block.timestamp < lastEmergencyAt + EMERGENCY_PAUSE_COOLDOWN) {
        revert EmergencyCooldown();
    }
    emergencyPaused = paused;
    lastEmergencyAt = block.timestamp;  // ← updated UNCONDITIONALLY, including on unpause
    emit EmergencyPauseSet(paused, msg.sender);
}
```

**Recommendation:** Update `lastEmergencyAt` only on the pause→ transition. Either:
```solidity
function setEmergencyPaused(bool paused) external onlyOwner {
    if (paused && lastEmergencyAt != 0 && block.timestamp < lastEmergencyAt + EMERGENCY_PAUSE_COOLDOWN) {
        revert EmergencyCooldown();
    }
    emergencyPaused = paused;
    if (paused) {
        lastEmergencyAt = block.timestamp;  // ← stamp ONLY when entering paused state
    }
    emit EmergencyPauseSet(paused, msg.sender);
}
```
Or skip the timer update when the state doesn't change (`if (emergencyPaused != paused)` guard around the body). Either restores the intent: throttle pause-spam, allow free unpause without arming the throttle on the next pause.

---

## [DEEP-NFTPOOL-V3-03] `_minLiquidityBuffer` cap-to-`lpAvailable` BLOCKS all withdrawals when pool is underwater — owner ETH bricked
**Severity:** Medium
**File:** `contracts/src/TegridyNFTPool.sol:325-336, 527-541, 757-765`
**Category:** other

**Bug:** `_minLiquidityBuffer()` (V2-NFTPOOL-04 fix) returns `min(floorAmt, lpAvailable)` where `floorAmt = min(getMaxSellable(), 100) * spotPrice`. The natspec at L753-755 says the cap to `lpAvailable` is intentional so an "already-depleted pool can still let the owner withdraw remaining dust without an impossible-to-satisfy floor." This is BACKWARDS — the cap actually makes withdrawal IMPOSSIBLE in the depleted-pool case.

Trace: pool with `lpAvailable = 1 ETH` and `floorAmt = 5 ETH` (curve says worst-case sell = 5 ETH). `_minLiquidityBuffer = min(5, 1) = 1 ETH`. In `withdrawETH(amount)`, the check at L536 reads:
```
if (amount + minBuffer > lpAvailable) revert MinLiquidityBuffer();
// → if (amount + 1 ETH > 1 ETH) revert
// → if (amount > 0) revert  ← always reverts unless amount = 0
```
Same in `removeLiquidity` (L335). So when `floorAmt > lpAvailable`, the owner CANNOT withdraw any positive amount of ETH — the pool's own ETH is locked indefinitely. The intended "withdraw remaining dust" path is unreachable.

This is the OPPOSITE of capital-preservation: instead of a flexible floor that scales down for dust pools, the cap converts the buffer into a total-lockout for any pool whose `lpAvailable < floorAmt`. The condition holds whenever the cumulative bonding-curve worst-case exceeds the LP balance — a common state for SELL-leaning TRADE pools that have been bought down or for any pool where `accumulatedLPFees + accumulatedProtocolFees > balance - floorAmt`.

**Attack / Impact:** Owner ETH lock-out. Once a pool reaches the `lpAvailable < floorAmt` regime, the owner has zero withdrawal path. Their only escapes are:
- (a) Wait for sells / buys that move spotPrice down enough to shrink `floorAmt` below `lpAvailable`. But sells DECREASE `lpAvailable` (payouts go out), and buys INCREASE `spotPrice` (raising `floorAmt`). Both directions tend to make the lock worse, not better.
- (b) Propose a spot-price reduction via `proposeSpotPrice` (24h timelock) → execute → `floorAmt` drops. This works but exposes the owner to a 24h delay + price-reduction cost (the curve's economic state is permanently shifted).
- (c) Add MORE ETH liquidity (no `addETH` function exists — `addLiquidity` is `payable` so they CAN deposit, but the deposit increases `lpAvailable` AND the buffer doesn't grow proportionally, so this might unlock).

None of these are graceful. For an emergency drain (e.g., owner discovered a bug and wants to recover capital), the lock-out is severe.

**Evidence:**
```solidity
// L757-765
function _minLiquidityBuffer() internal view returns (uint256) {
    if (poolType == PoolType.SELL) return 0;
    uint256 maxItems = getMaxSellable();
    if (maxItems == 0) return 0;
    if (maxItems > 100) maxItems = 100;
    uint256 floorAmt = maxItems * spotPrice;
    uint256 lpAvailable = _lpAvailableETH();
    return floorAmt > lpAvailable ? lpAvailable : floorAmt;
    // ↑ When floorAmt > lpAvailable, returns the FULL lpAvailable as buffer.
    //   In withdrawETH/removeLiquidity, `amount + lpAvailable > lpAvailable`
    //   reduces to `amount > 0` — every nonzero withdrawal reverts.
}

// L527-541 (withdrawETH) — same shape applies
uint256 lpAvailable = _lpAvailableETH();
uint256 minBuffer = _minLiquidityBuffer();
if (amount + minBuffer > lpAvailable) revert MinLiquidityBuffer();
```

**Recommendation:** Two safer designs:
- (a) Cap the buffer at a fraction of `lpAvailable` so withdrawal of the unreserved portion is always possible:
  ```solidity
  uint256 maxBuffer = lpAvailable / 2;  // never reserve more than 50% of LP ETH
  return floorAmt > maxBuffer ? maxBuffer : floorAmt;
  ```
  This guarantees the owner can always withdraw at least 50% of `lpAvailable` regardless of curve state, while still leaving a meaningful sell-payout reserve.
- (b) Skip the cap and let the floor exceed `lpAvailable` — the existing `if (amount + floor > lpAvailable) revert` correctly blocks ALL withdrawals when the floor cannot be satisfied. This matches the natspec intent ("solvency-derived floor") but loses the dust-recovery path. Combine with an explicit `emergencyWithdraw` guarded by a 24h-noticed timelock.
- (c) For belt-and-suspenders: add an `unsafeWithdraw(uint256)` path that skips the buffer check, requires a 7-day notice + on-chain announcement, and is only callable when `paused()`. Reserved for capital-recovery scenarios.

---

## [DEEP-NFTPOOL-V3-04] `acceptOwnership whenNotPaused` bricks key-loss recovery — pause + owner-key-loss = permanent ownership lock
**Severity:** Medium
**File:** `contracts/src/TegridyNFTPool.sol:451-502, 568-574`
**Category:** other

**Bug:** The V2-NFTPOOL-05 patch added `whenNotPaused` (L451) and the factory `emergencyPaused()` cascade (L457) to `acceptOwnership`. The intent was to give defenders a way to halt an in-flight ownership transition during incident response. **But `pause()` and `unpause()` (L568-574) are both `onlyOwner`** — only the CURRENT owner can unpause. If the current owner pauses the pool and then loses their key (lost seed, compromised hardware wallet, dead operator), the pool is now in a permanently-paused state from which the legitimate `pendingOwner` (e.g., a recovery multisig with a 48h-timelocked claim) cannot rescue it via `acceptOwnership` — the `whenNotPaused` modifier reverts every recovery attempt indefinitely.

The threat model justifying the addition has weak coverage: the V2 doc framed the scenario as "an attacker who got a 48h owner-change proposal in before detection could still capture the pool while the protocol is otherwise paused." But for the attacker to have proposed, they must have already controlled the OWNER key — which means they can also UNPAUSE before accepting. The `whenNotPaused` adds zero protection against an attacker-as-current-owner. Meanwhile defenders who legitimately hold the owner key have a more direct tool: `cancelOwnerChange` (L443) is `onlyOwner` and doesn't require unpausing the pool.

So the `whenNotPaused` gate adds friction in the bad-key-loss scenario (real risk) and adds zero security in the attacker-already-owns scenario (the defended threat). Net: pure regression for ownership recoverability.

**Attack / Impact:** Permanent pool lock-out under benign operator error. Concrete sequence:
- T = 0: owner detects suspicious activity, calls `pause()`. Pool is paused; swaps frozen.
- T = 1 day: investigation concludes the activity was legitimate. Owner intends to unpause but their hot wallet was wiped (cloud-sync mishap, social engineering, hardware failure). Owner cannot unpause.
- T = -2 days (proposed earlier): owner had set `pendingOwner = recovery_multisig` with the 48h timelock as a recovery mechanism. `pendingOwnerExecuteAfter` elapsed at T = 0.
- Post-T=1d: recovery multisig calls `acceptOwnership()`. Reverts on `whenNotPaused`.
- Recovery multisig CANNOT pause/unpause (not yet owner). They CANNOT bypass the modifier. The pool is **permanently bricked for ownership recovery**, even though a clear, pre-arranged 48h-timelocked recovery flow was set up exactly for this contingency.

There is no escape hatch. `factory.emergencyPaused()` is also a barrier (L457) and the factory owner can clear that, but the pool's `paused()` is intrinsic to the pool itself.

**Evidence:**
```solidity
// L451-457
function acceptOwnership() external whenNotPaused {
    // V2-NFTPOOL-05 fix
    if (ITegridyNFTPoolFactoryView(factory).emergencyPaused()) revert EmergencyPaused();
    if (msg.sender != pendingOwner || msg.sender == address(0)) revert NotPendingOwner();
    if (pendingOwnerExecuteAfter == 0 || block.timestamp < pendingOwnerExecuteAfter) {
        revert TimelockNotElapsed();
    }
    // ...
}

// L568-574 — only the current owner can unpause
function pause() external onlyOwner { _pause(); }
function unpause() external onlyOwner { _unpause(); }
```

**Recommendation:** Remove `whenNotPaused` from `acceptOwnership`. The defense V2 wanted is already provided by `cancelOwnerChange` (defender-as-owner cancels) and the 48h timelock itself (defender has 48h to detect + react). Adding pause as an additional barrier turns the pause modifier into a denial-of-recovery vector. Alternative: if the pause-gate must stay, allow the `pendingOwner` to unpause once the timelock has elapsed:
```solidity
function unpause() external {
    if (msg.sender == owner) {
        _unpause();
        return;
    }
    // Recovery path: allow pendingOwner to unpause once their timelock has elapsed.
    if (msg.sender == pendingOwner && pendingOwnerExecuteAfter != 0 && block.timestamp >= pendingOwnerExecuteAfter) {
        _unpause();
        return;
    }
    revert NotOwner();
}
```
This preserves the incident-response use of pause but restores the pre-arranged recovery path.

---

## [DEEP-NFTPOOL-V3-05] `proposeSpotPrice` lost its MAX upper bound — overflow in `_minLiquidityBuffer` bricks every withdraw path
**Severity:** Low
**File:** `contracts/src/TegridyNFTPool.sol:347-354, 757-765, 691, 723`
**Category:** other

**Bug:** Pass-1 audit (DEEP_2026_05_01/06_nftpool.md, "Excluded" section) recorded MICROSCOPE M-L4 as "verified shipped at L382" — adding a `MAX_SPOT_PRICE` upper bound to `proposeSpotPrice`. **A grep of the current source confirms `MAX_SPOT_PRICE` is NOT defined anywhere in either contract.** `proposeSpotPrice` (L347-354) accepts ANY non-zero `newPrice` up to `type(uint256).max`. The pass-1 verification was based on a different version (the prior R014/Microscope branch); the current source either had the constant removed in a later refactor or never had it.

This becomes a real footgun via the NEW `_minLiquidityBuffer()` (V2-NFTPOOL-04 fix). With no upper bound:
- Owner proposes `spotPrice = 2^200` (insanely large). 24h elapses. Owner executes.
- Now `_minLiquidityBuffer()` computes `maxItems * spotPrice` where `maxItems` can be up to 100. `100 * 2^200` overflows `uint256` and **reverts** under Solidity ^0.8.26's checked arithmetic.
- `withdrawETH` and `removeLiquidity` both call `_minLiquidityBuffer()` (L335, L535). Both REVERT on the overflow.
- Same overflow bricks `_getBuyPriceFull` (L691: `numItems * spotPrice + ...` overflows for any `numItems >= 1`) and `_getSellPriceFull` (L723: `numItems * spotPrice - ...` similarly).

End state: the entire pool is bricked. Owner cannot withdraw ETH, cannot withdraw NFTs (well, NFT-only withdrawal at L543 doesn't call `_minLiquidityBuffer` — that path survives), cannot trade. The 48h `proposeOwnerChange` path can still transfer ownership but the new owner inherits the bricked pool.

**Attack / Impact:** Self-inflicted brick is the dominant scenario (no attack vector since only the owner can propose). However, an attacker who briefly compromises the owner key has a 24h-delayed "scorched earth" option: propose extreme spotPrice, wait 24h, execute. The pool is then unrecoverable. Combined with the V3-04 ownership-lock issue (above), an attacker can permanently brick the pool with two legitimate-looking timelocked actions.

Lower severity because (a) the threat requires owner-key compromise, and (b) reading the current state, no attacker has motive to brick a pool they could otherwise drain via `withdrawETH`. But the missing bound is a documentation/verification failure that pass-1 marked as closed.

**Evidence:**
```solidity
// L347-354 — no upper bound on newPrice
function proposeSpotPrice(uint256 newPrice) external onlyOwner {
    if (newPrice == 0) revert InvalidPrice();
    // AUDIT FIX: DEEP-NFTPOOL-02
    if (pendingSpotPriceExecuteAfter != 0) revert ExistingProposalPending();
    pendingSpotPrice = newPrice;
    pendingSpotPriceExecuteAfter = block.timestamp + PARAMETER_TIMELOCK;
    emit SpotPriceChangeProposed(spotPrice, newPrice, pendingSpotPriceExecuteAfter);
}

// L757-765 — _minLiquidityBuffer multiplies, can overflow at extreme spotPrice
uint256 floorAmt = maxItems * spotPrice;  // ← overflow risk
```

**Recommendation:** Restore the MICROSCOPE M-L4 cap. Define `uint256 public constant MAX_SPOT_PRICE = 1e30;` (or whatever the original constant was — the pass-1 doc can be archived for the original value) and add `if (newPrice > MAX_SPOT_PRICE) revert SpotPriceTooHigh();` at L348. Single-line restoration. Add a regression test that the cap is enforced.

---

## [DEEP-NFTPOOL-V3-06] `acceptOwnership` snapshot uses `priorOwnerOwed[oldOwner] +=` — re-acceptance loops can credit the same address twice
**Severity:** Low
**File:** `contracts/src/TegridyNFTPool.sol:451-502`
**Category:** other

**Bug:** `acceptOwnership` snapshots `accumulatedLPFees` into `priorOwnerOwed[oldOwner]` using `+=` (L467). This correctly accumulates across multiple owner cycles, but creates a subtle accounting drift in this scenario:
- Cycle 1: A → B. accumulatedLPFees = 10 ETH at acceptance. `priorOwnerOwed[A] += 10`. A's credit = 10 ETH. A claims via `claimPriorOwnerLPFees`. A's credit = 0.
- Cycle 2: B → A (A becomes owner again). accumulatedLPFees = 5 ETH at acceptance. `priorOwnerOwed[B] += 5`. B's credit = 5. (A's credit is unaffected.)
- Cycle 3: A → B. accumulatedLPFees = 7 ETH at acceptance. `priorOwnerOwed[A] += 7`. A's credit = 7 (was 0 after Cycle 1 claim, now 7). OK — accumulator is correct.

But: there's a subtle case where `oldOwner == pendingOwner`. The owner can `proposeOwnerChange(self)` and then 48h later `acceptOwnership(self)`. This is essentially a no-op transfer (owner stays the same), but it triggers the snapshot:
- Before: owner = A, accumulatedLPFees = 100 ETH.
- Propose owner change to A. Wait 48h. Execute.
- L462 oldOwner = A. L467: `priorOwnerOwed[A] += 100`. accumulatedLPFees = 0.
- L472: `owner = pendingOwner = A`. No-op for owner.
- Now A's claimable is 100 in `priorOwnerOwed[A]`, 0 in `accumulatedLPFees`. A must call `claimPriorOwnerLPFees` instead of `claimLPFees`.

Functionally equivalent (A gets the 100 ETH) but the UX confusion is real: A might call `claimLPFees` first (returns silently because amount=0 at L506), then wonder where their fees went. The "claim from the right pot" decision is exposed to the user without any helper function or clear error message.

Also, `proposeOwnerChange(self)` is allowed (L436 only blocks `address(0)`) and bypasses the `ExistingProposalPending` check after the prior pending is cleared. So an owner CAN cycle themselves through this for purposes that are not entirely clear. Probably benign but worth documenting.

**Attack / Impact:** UX bug. Owner who self-cycles (whether intentionally or by mistake) loses immediate access to their `accumulatedLPFees` and must call a different function. No fund loss but an opportunity for confusion or for a careless multisig to think the snapshot is broken.

**Evidence:**
```solidity
// L462-467
address oldOwner = owner;
uint256 snapshot = accumulatedLPFees;
if (snapshot > 0) {
    priorOwnerOwed[oldOwner] += snapshot;
    accumulatedLPFees = 0;
    emit PriorOwnerLPFeesSnapshotted(oldOwner, snapshot);
}
// ↑ When pendingOwner == oldOwner (self-transfer), the snapshot moves
//   accumulator into priorOwed for the SAME address, forcing them to use
//   the prior-owner claim path even though no change of ownership occurred.
```

**Recommendation:** Either:
- (a) Reject self-transfer in `proposeOwnerChange`: `if (newOwner == owner) revert ZeroAddress();` (or a new `SelfTransferDisallowed` error). Self-transfer has no purpose and surfaces the snapshot footgun.
- (b) Skip the snapshot when `oldOwner == pendingOwner`:
  ```solidity
  if (snapshot > 0 && oldOwner != pendingOwner) {
      priorOwnerOwed[oldOwner] += snapshot;
      accumulatedLPFees = 0;
      emit PriorOwnerLPFeesSnapshotted(oldOwner, snapshot);
  }
  ```
- (c) Add a unified `claimAllLPFees()` helper that drains both `accumulatedLPFees` (if owner) and `priorOwnerOwed[msg.sender]` in one call.

---

## Summary — counts and prioritization

- **Medium:** 4 (V3-01 buyer-callback inventory pollution still works; V3-02 unpause locks pause for 6h; V3-03 buffer cap bricks owner withdrawals; V3-04 acceptOwnership whenNotPaused bricks key-loss recovery)
- **Low:** 2 (V3-05 missing MAX_SPOT_PRICE; V3-06 self-transfer snapshot UX)

**Top regression-pass-3 deploy-blockers:**
1. **V3-01** — `_swapInFlight = true` was extended to the buy direction even though the original V2 fix recommendation explicitly told the team to limit it to the sell direction. The committed patch reproduces the exact griefing path V2-NFTPOOL-01 was supposed to close.
2. **V3-03** — `_minLiquidityBuffer` cap-to-`lpAvailable` is the OPPOSITE of the intended dust-rescue: it converts every `floorAmt > lpAvailable` regime into a total ETH lock-out for the owner.
3. **V3-04** — `whenNotPaused` on `acceptOwnership` adds no defensive value (defender can `cancelOwnerChange`) but creates a permanent ownership-lock scenario when the current owner pauses then loses their key.
4. **V3-02** — `lastEmergencyAt` updates on EVERY call, so a single corrective unpause locks the pause-button for 6 hours.

**Cross-cutting observation:** All four medium findings are "fix-introduced regressions" — the pass-2 patches CLOSED the pass-1 surfaces but introduced new edge cases, often by being either too narrow (V3-01: gate intent narrower than implementation) or too broad (V3-02, V3-03, V3-04: protection extended into operational scenarios it shouldn't apply to). The pattern is the inverse of the pass-1 "guard added at one site but not the mirror" issue: now we have "guard added at one direction but applied symmetrically."

**Additional verification deltas vs pass-2:**
- Pass-1's MICROSCOPE M-L4 (MAX_SPOT_PRICE) was claimed shipped but is absent from current source (V3-05). Pass-2 verification did not re-check.
- `acceptOwnership` clears spotPrice/delta/feeBps pendings (V2-NFTPOOL-07 ✓) but does NOT reset `priorOwnerOwed[oldOwner]` if `oldOwner == pendingOwner` — see V3-06.
- `_swapInFlight` correctly false-cleared on revert via Solidity rollback semantics — verified.
- `priorOwnerOwed` `+=` correctly handles the multi-cycle case — verified, no stale-snapshot bug.
- Factory `emergencyPaused()` external call is the sole cross-contract dependency in `swap*`/`acceptOwnership` paths — pool is bricked if factory is destroyed (acceptable architectural risk).

**No critical or high regressions discovered. Pass-3 confirms the pass-2 economic fixes (LP-fee snapshot, owner timelock, salt mix) remain structurally sound; the new findings are all fix-induced edge-case regressions in defensive guards.**
