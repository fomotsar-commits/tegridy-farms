# Deep Audit v3 — TegridyDropV2 / TegridyLaunchpadV2 / TegridyTokenURIReader (2026-05-02)

**Scope (post-fix `d2409eb`):**
- `contracts/src/TegridyDropV2.sol` (1077 lines)
- `contracts/src/TegridyLaunchpadV2.sol` (423 lines)
- `contracts/src/TegridyTokenURIReader.sol` (215 lines)

**Pass-2 fix verification (per regression hot-spots):**
- **V2-DROP-01** — `setMintPrice` is now a deprecated shim reverting `UseProposeMintPrice` (L729-731). New `proposeMintPrice` (L737-743), `executeMintPrice(uint256 expectedPrice)` (L750-760), `cancelMintPrice` (L763-768). Value-bind on `expectedPrice == pendingMintPrice` correctly enforced. **Confirmed shipped** — but see DEEP-DROP-V3-02 below for `expectedExecuteAfter` asymmetry.
- **V2-DROP-03** — `configureDutchAuction` is a deprecated shim reverting `UseProposeDutchAuction` (L831-833). New `proposeDutchAuction` (L839-859), `executeDutchAuction` with full 4-field value-bind (L864-884), `cancelDutchAuction` (L887-892). Value-bind correctly enforced. **Confirmed shipped** — but see DEEP-DROP-V3-01 (curve-already-ended sibling miss) and DEEP-DROP-V3-02 (`expectedExecuteAfter` asymmetry).
- **V2-DROP-02** — `unclaimedRefundPool` mint-time increment removed (no SSTORE in `mint()` L540-555). Slot retained as `public` storage for ABI compat. `refund()` retains the `-= owed` line at L986 which is a no-op subtract-zero on new clones. `rescueAfterCancellation()` still works for raw-ETH-donation residuals (L1009-1026). **Confirmed shipped** — but see DEEP-DROP-V3-06 (latent underflow if a future contributor partially restores the increment).
- **V2-DROP-04** — `initialize()` rejects `initialPhase == DUTCH_AUCTION` with already-elapsed curve (L430-434, `DutchAuctionAlreadyEnded`). **Confirmed shipped at init-time** — but see DEEP-DROP-V3-01 (the same check is NOT applied at `executeDutchAuction` or at `setMintPhase(DUTCH_AUCTION)`, reopening the footgun via two alternate routes).
- **V2-DROP-05** — `currentPrice()` now uses `SequencerCheck.tryCheckSequencerUp(sequencerFeed, SEQUENCER_GRACE_PERIOD)` directly (L582-590) and dispatches the no-sequencer-check math via `_dutchAuctionPriceWithoutSequencerCheck()` (L619-626). The `dutchAuctionPriceExternal()` wrapper (L598-600) still routes through the reverting `_dutchAuctionPrice()` for backward-compat consumers. **Confirmed shipped** — saves ~2,400 gas per indexer poll, eliminates the self-call surface, and aligns with the canonical SequencerCheck pattern.
- **V2-DROP-06** — `freezeBaseURI()` requires `bytes(_baseTokenURI).length > 0` (L805, `BaseURIEmpty`). **Confirmed shipped** — fat-finger empty-freeze foot-gun is closed.
- **V2-LP-01** — `executeProtocolFee(uint16 expectedFeeBps, uint256 expectedExecuteAfter)` (L337-350) and `executeProtocolFeeRecipient(address expectedRecipient, uint256 expectedExecuteAfter)` (L371-384) both bind to (value, ETA). Multisig signers can prove they're executing the proposal they reviewed. **Confirmed shipped**.
- **V2-URI-01** — NatSpec note added (L50-57) confirming `TegridyStaking._nextTokenId = 1` (verified in TegridyStaking.sol:99). Token ID 0 is correctly never minted; the reader's typed `NONEXISTENT` revert for ID 0 is spec-correct. **Confirmed.**

---

## [DEEP-DROP-V3-01] V2-DROP-04 init-time guard NOT mirrored at `executeDutchAuction` and `setMintPhase(DUTCH_AUCTION)` — two alternate routes bypass the already-ended curve check
**Severity:** Medium
**File:** `contracts/src/TegridyDropV2.sol:629-666, 839-884`
**Category:** mint

**Bug:** The V2-DROP-04 fix at L430-434 correctly rejects `initialize()` with `initialPhase == DUTCH_AUCTION` and an already-elapsed curve (`dutchStartTime + dutchDuration <= block.timestamp`). But the same footgun reopens via TWO alternate code paths:

1. **`proposeDutchAuction → executeDutchAuction` route.** `proposeDutchAuction` validates `startPrice > endPrice`, `duration != 0`, `startTime != 0`, `startPrice - endPrice >= duration` — but NOT `startTime + duration > block.timestamp + DUTCH_CONFIG_DELAY`. Owner proposes a curve with `startTime` in the past (or even in the near future relative to propose-block-time). 24h passes (the timelock delay). `executeDutchAuction` does NO curve-temporal validation — it only checks the 4-field value-bind. Storage is updated with the (now-elapsed) curve. `setMintPhase(DUTCH_AUCTION)` only checks `dutchDuration != 0` (L656). Drop launches in DUTCH at the floor price.

2. **`setMintPhase(DUTCH_AUCTION)` deferred-flip route.** Even via the legacy `initialize()`-with-CLOSED-then-flip-later flow: owner deploys with `initialPhase=CLOSED, dutchStartTime=T+1h, dutchDuration=12h`. Owner waits MORE than 13 hours. By the time owner calls `setMintPhase(DUTCH_AUCTION)`, `block.timestamp > dutchStartTime + dutchDuration`. `setMintPhase` only checks `dutchDuration != 0` — passes. Drop launches at floor.

The pass-2 V2-DROP-04 fix is one third of the safety net. The other two thirds (execute-time and phase-flip-time) remain footguns.

**Attack / Impact:** Same footgun shape as V2-DROP-04 (no exploit, but silent floor-price launch). A creator who fat-fingers timestamps in their factory script — or simply forgets to flip phase promptly after a delayed `executeDutchAuction` — ships a drop where the dutch curve is already maximally decayed. Buyers who arrive at the auction's first block see no price advantage. The economic loss is borne by the creator (who chose the floor); the secondary trust hit is borne by the protocol's reputation for "drops launch as configured."

**Evidence:**
```solidity
// L656 — setMintPhase only checks duration, not curve-temporal validity
if (phase == MintPhase.DUTCH_AUCTION && dutchDuration == 0) {
    revert DutchAuctionNotActive();
}
// MISSING: if (phase == DUTCH_AUCTION &&
//              dutchStartTime + dutchDuration <= block.timestamp)
//              revert DutchAuctionAlreadyEnded();

// L864-884 — executeDutchAuction does NO curve-temporal validation
function executeDutchAuction(
    uint256 expectedStartPrice, uint256 expectedEndPrice,
    uint256 expectedStartTime,  uint256 expectedDuration
) external onlyOwner {
    PendingDutchConfig memory cached = pendingDutchConfig;
    if (cached.startPrice != expectedStartPrice ||
        cached.endPrice   != expectedEndPrice   ||
        cached.startTime  != expectedStartTime  ||
        cached.duration   != expectedDuration) {
        revert DutchConfigMismatch();
    }
    // MISSING: if (expectedStartTime + expectedDuration <= block.timestamp)
    //              revert DutchAuctionAlreadyEnded();
    _execute(DUTCH_CONFIG_CHANGE);
    dutchStartPrice = expectedStartPrice;
    dutchEndPrice   = expectedEndPrice;
    dutchStartTime  = expectedStartTime;
    dutchDuration   = expectedDuration;
    delete pendingDutchConfig;
    emit DutchAuctionConfigured(expectedStartPrice, expectedEndPrice, expectedStartTime, expectedDuration);
}
```

**Recommendation:** Add the curve-temporal check at BOTH alternate routes:

```solidity
// In setMintPhase, after the dutchDuration check:
if (phase == MintPhase.DUTCH_AUCTION &&
    dutchStartTime + dutchDuration <= block.timestamp) {
    revert DutchAuctionAlreadyEnded();
}

// In executeDutchAuction, after the value-bind:
if (expectedStartTime + expectedDuration <= block.timestamp) {
    revert DutchAuctionAlreadyEnded();
}
```

The init-time guard at L430-434 is fine; it's the post-init state-mutation paths that need the same protection. Pattern: Sudoswap `LSSVMPair` rejects expired auctions at every state-changing entry, not just construction.

---

## [DEEP-DROP-V3-02] `executeMintPrice` and `executeDutchAuction` lack `expectedExecuteAfter` — V2-LP-01 sibling miss in DropV2
**Severity:** Medium
**File:** `contracts/src/TegridyDropV2.sol:750-760, 864-884`
**Category:** gov

**Bug:** Pass-2 closed V2-LP-01 by adding `expectedExecuteAfter` to `executeProtocolFee` and `executeProtocolFeeRecipient` (TegridyLaunchpadV2 L337-378). But the new mint-price and dutch-curve timelocks in TegridyDropV2 (`executeMintPrice`, `executeDutchAuction`) only bind to the value, NOT to the proposal-creation timestamp.

Concretely: signer reviews `pendingMintPrice = 0.1 ether, _executeAfter[MINT_PRICE_CHANGE] = T1`. Signer signs `executeMintPrice(0.1 ether)`. Between sign and broadcast, another signer (or owner) calls `cancelMintPrice` (clears state, emits `MintPriceCancelled`), then `proposeMintPrice(0.1 ether)` (stores 0.1 again, `_executeAfter[MINT_PRICE_CHANGE] = T2 > T1`). When the original signer's tx lands at `now >= T2`, the execute SUCCEEDS, applying the 0.1 from the SECOND proposal even though the signer reviewed the FIRST.

The same race applies to `executeDutchAuction(start, end, time, duration)` — even with all 4 fields value-bound, if the cancelled-and-re-proposed curve happens to share all 4 values (or shares 4 values that an attacker-multisig-signer coordinated), the execute lands under the wrong proposal's audit trail.

Real impact is small for the value-matched case but breaks the on-chain audit trail: off-chain tooling that maps "this signer approved that proposal" can no longer cite the proposal-creation event with confidence. This is exactly the lesson the launchpad already learned in V2-LP-01.

**Attack / Impact:** Multisig audit-trail pollution. Identical shape to V2-LP-01: cooperating-signer or accidental cancel/re-propose race lets the SECOND proposal land under the FIRST proposal's authorization signature. The pattern of record (OZ Governor binds to `descriptionHash` of the proposal, not just constituent values) was applied in launchpad but missed in DropV2.

**Evidence:**
```solidity
// L750-760 — executeMintPrice binds to value but NOT to executeAfter
function executeMintPrice(uint256 expectedPrice) external onlyOwner {
    if (pendingMintPrice != expectedPrice) revert MintPriceMismatch();
    if (expectedPrice == 0 && totalSupply > 0) revert ZeroPricePostMint();
    _execute(MINT_PRICE_CHANGE);  // ← reads _executeAfter from storage; no eta binding
    mintPrice = expectedPrice;
    pendingMintPrice = 0;
    emit MintPriceChanged(expectedPrice);
}

// L864-884 — executeDutchAuction same shape
function executeDutchAuction(
    uint256 expectedStartPrice, uint256 expectedEndPrice,
    uint256 expectedStartTime,  uint256 expectedDuration
) external onlyOwner {
    PendingDutchConfig memory cached = pendingDutchConfig;
    if (cached.startPrice != expectedStartPrice || ...) revert DutchConfigMismatch();
    _execute(DUTCH_CONFIG_CHANGE);  // ← same gap
    ...
}

// Compare TegridyLaunchpadV2 L337-350 — value-bound AND ETA-bound
function executeProtocolFee(uint16 expectedFeeBps, uint256 expectedExecuteAfter)
    external onlyOwner whenNotPaused {
    if (pendingProtocolFeeBps != expectedFeeBps) revert FeeMismatch();
    if (_executeAfter[FEE_CHANGE] != expectedExecuteAfter) revert ExecuteAfterMismatch();
    ...
}
```

**Recommendation:** Mirror the V2-LP-01 fix on both DropV2 execute paths:

```solidity
function executeMintPrice(uint256 expectedPrice, uint256 expectedExecuteAfter)
    external onlyOwner {
    if (pendingMintPrice != expectedPrice) revert MintPriceMismatch();
    if (_executeAfter[MINT_PRICE_CHANGE] != expectedExecuteAfter) revert ExecuteAfterMismatch();
    ...
}

function executeDutchAuction(
    uint256 expectedStartPrice, uint256 expectedEndPrice,
    uint256 expectedStartTime,  uint256 expectedDuration,
    uint256 expectedExecuteAfter
) external onlyOwner {
    ...
    if (_executeAfter[DUTCH_CONFIG_CHANGE] != expectedExecuteAfter) revert ExecuteAfterMismatch();
    ...
}
```

Add a typed `ExecuteAfterMismatch` error (or reuse the launchpad's) to keep the typed-revert surface consistent across the protocol's execute paths. Same shape, same audit-trail benefit, same line count.

---

## [DEEP-DROP-V3-03] DEEP-LP-02 sibling miss: `pause()` doesn't block `executeMerkleRoot` / `executeMintPrice` / `executeDutchAuction` — Drop's emergency lever incomplete
**Severity:** Medium
**File:** `contracts/src/TegridyDropV2.sol:705-713, 750-760, 864-884, 894-895`
**Category:** gov

**Bug:** TegridyLaunchpadV2 was correctly fixed in pass-1 DEEP-LP-02 to gate `executeProtocolFee` and `executeProtocolFeeRecipient` behind `whenNotPaused`. But TegridyDropV2 has THREE timelocked execute paths (`executeMerkleRoot`, `executeMintPrice`, `executeDutchAuction`) and NONE of them have `whenNotPaused`. The same emergency-response weakness the launchpad had pre-DEEP-LP-02 now exists in DropV2.

Scenario: a compromised owner key (or an off-chain compromise of the deployer multisig) is detected mid-timelock-window. The hostile owner has already proposed `proposeMintPrice(huge_value)` 23h ago — the execute will land in 1h. A guardian / monitor pauses the drop with `pause()`. `mint()` halts (good — `whenNotPaused`). But the hostile execute can still land 1h later, applying the huge mint price. After unpause, every legitimate buyer overpays or reverts.

Same scenario applies to `executeDutchAuction` (curve hijack) and `executeMerkleRoot` (root rotation to attacker-tree). The merkle-root case is partially mitigated by `_canRotateMerkleRoot()` returning `true` for paused (intentionally — pause is supposed to be an OK time to rotate), but for the price/dutch execute paths there is no defense.

**Attack / Impact:** Compromised-owner-key incidents within the 24h timelock window are irrecoverable on Drop. A guardian who pauses cannot prevent the queued hostile change from landing. The only counter-action is `cancelMintPrice` / `cancelDutchAuction` — but those are `onlyOwner`, so the (compromised) owner is the only party able to cancel. Pause should be the universal "freeze everything" lever; today it's a no-op for the most dangerous setter sequences.

**Evidence:**
```solidity
// L705-713 — executeMerkleRoot: no whenNotPaused
function executeMerkleRoot(bytes32 expectedRoot) external onlyOwner {
    require(pendingMerkleRoot == expectedRoot, "ROOT_MISMATCH");
    if (!_canRotateMerkleRoot()) revert RootRotationBlocked();  // ← passes if paused
    _execute(MERKLE_ROOT_CHANGE);
    ...
}

// L750-760 — executeMintPrice: no whenNotPaused
function executeMintPrice(uint256 expectedPrice) external onlyOwner {
    if (pendingMintPrice != expectedPrice) revert MintPriceMismatch();
    if (expectedPrice == 0 && totalSupply > 0) revert ZeroPricePostMint();
    _execute(MINT_PRICE_CHANGE);
    ...
}

// L864-884 — executeDutchAuction: no whenNotPaused
function executeDutchAuction(...) external onlyOwner {
    ...
    _execute(DUTCH_CONFIG_CHANGE);
    ...
}

// Compare TegridyLaunchpadV2 L337-350 — fixed in pass-1 DEEP-LP-02
function executeProtocolFee(uint16 expectedFeeBps, uint256 expectedExecuteAfter)
    external onlyOwner whenNotPaused { ... }
```

**Recommendation:** Add `whenNotPaused` to ALL three execute paths in DropV2:

```solidity
function executeMerkleRoot(bytes32 expectedRoot) external onlyOwner whenNotPaused { ... }
function executeMintPrice(uint256 expectedPrice) external onlyOwner whenNotPaused { ... }
function executeDutchAuction(...) external onlyOwner whenNotPaused { ... }
```

Note: this would conflict with the existing `_canRotateMerkleRoot()` helper which currently RETURNS TRUE for paused. The intent was to allow legitimate root-rotations during pause. To preserve that flow while still gating against compromised-owner abuse, either (a) split into two execute paths — emergency-rotate-during-pause vs. normal-rotate — with the emergency path requiring a separate guardian role, or (b) simpler: drop the `paused()` branch from `_canRotateMerkleRoot` and require any during-pause merkle rotation to first `unpause`. Option (b) is the smaller change and aligns with the launchpad pattern.

Independently, consider a guardian-pattern public `cancelAllPendingProposals` function gated to `paused() == true && msg.sender == guardian` so the legitimate counter-action — cancel-and-unpause — doesn't require the (potentially captured) `onlyOwner`.

---

## [DEEP-DROP-V3-04] `executeMerkleRoot(bytes32(0))` while paused with `mintPhase == ALLOWLIST` silently bricks the drop on unpause — DEEP-DROP-03 sibling miss at execute path
**Severity:** Low
**File:** `contracts/src/TegridyDropV2.sol:693-713, 894-895`
**Category:** mint

**Bug:** DEEP-DROP-03 closed `setMintPhase(ALLOWLIST)` with zero-root by adding the symmetric guard at L663:

```solidity
if (phase == MintPhase.ALLOWLIST && merkleRoot == bytes32(0)) revert InvalidProof();
```

But `executeMerkleRoot(expectedRoot)` accepts ANY `expectedRoot` — including `bytes32(0)` — as long as it matches `pendingMerkleRoot`. Combined with `_canRotateMerkleRoot()` returning `true` for paused, the following sequence bricks the drop:

1. Drop is in `ALLOWLIST` phase with a valid root.
2. Owner calls `pause()` (legitimate emergency).
3. While paused, owner calls `proposeMerkleRoot(bytes32(0))` (passes `_canRotateMerkleRoot()` because paused).
4. 24h delay elapses.
5. Owner calls `executeMerkleRoot(bytes32(0))` — value-bind matches, `_canRotateMerkleRoot()` returns true (still paused), execute succeeds. `merkleRoot = bytes32(0)`.
6. Owner calls `unpause()` — phase remains `ALLOWLIST`, root is now zero.
7. Every `mint()` call in ALLOWLIST phase computes `MerkleProof.verify(proof, bytes32(0), leaf)` — for any non-empty proof and non-zero leaf, `processProof` returns the leaf-hash, not zero. Verify fails. Drop silently bricks.

There is no symmetric guard at `executeMerkleRoot` to catch the equivalent of DEEP-DROP-03's "ALLOWLIST + zero-root = brick" invariant. Nor at `unpause()` (which has no checks at all).

**Attack / Impact:** Footgun, not exploit. The most likely operator-error mode: owner intends to pause, set a NEW merkle root with rotated leaves, then unpause. Owner pastes the WRONG value into `proposeMerkleRoot` — pastes `bytes32(0)` instead of the new root by accident. 24h passes. Owner executes (the value-bind passes — owner expects what they typed). Unpauses. Drop is bricked for at least one more 24h cycle until a corrective `proposeMerkleRoot(realRoot) → executeMerkleRoot` lands.

A more deliberate attack vector: outgoing-owner queues `proposeMerkleRoot(bytes32(0))` then `transferOwnership(newOwner)`. The M-D3 fix (acceptOwnership clears pending proposals) closes this — but note that the M-D3 fix relies on the new owner ACTUALLY calling acceptOwnership. If they don't (or are slow), the proposal sits live and the previous owner can still execute it.

**Evidence:**
```solidity
// L705-713 — executeMerkleRoot accepts bytes32(0), no symmetric guard
function executeMerkleRoot(bytes32 expectedRoot) external onlyOwner {
    require(pendingMerkleRoot == expectedRoot, "ROOT_MISMATCH");
    if (!_canRotateMerkleRoot()) revert RootRotationBlocked();
    _execute(MERKLE_ROOT_CHANGE);
    bytes32 oldRoot = merkleRoot;
    merkleRoot = expectedRoot;  // ← bytes32(0) is accepted
    pendingMerkleRoot = bytes32(0);
    emit MerkleRootRotated(oldRoot, expectedRoot);
}

// L683-687 — _canRotateMerkleRoot includes paused
function _canRotateMerkleRoot() internal view returns (bool) {
    return mintPhase == MintPhase.CLOSED
        || mintPhase == MintPhase.CANCELLED
        || paused();
}

// L894-895 — unpause has no validation
function unpause() external onlyOwner { _unpause(); }
```

**Recommendation:** Add the symmetric guard at `executeMerkleRoot` (and ideally also at `proposeMerkleRoot` so the fat-finger fails fast at propose-time, not 24h later at execute):

```solidity
function executeMerkleRoot(bytes32 expectedRoot) external onlyOwner {
    require(pendingMerkleRoot == expectedRoot, "ROOT_MISMATCH");
    if (!_canRotateMerkleRoot()) revert RootRotationBlocked();
    // NEW: refuse to rotate to bytes32(0) if the drop is in (or might re-enter)
    //      ALLOWLIST after unpause — the resulting state is silently bricked.
    if (expectedRoot == bytes32(0) && mintPhase == MintPhase.ALLOWLIST) {
        revert InvalidProof();
    }
    _execute(MERKLE_ROOT_CHANGE);
    ...
}
```

Alternative: gate `unpause()` to `mintPhase != MintPhase.ALLOWLIST || merkleRoot != bytes32(0)`. Either approach catches the brick before mints start failing. Pattern of record: Manifold ERC721LazyPayableClaim `setMerkleRoot` reverts on bytes32(0) when the claim's `merkleEnabled` flag is set.

---

## [DEEP-DROP-V3-05] `setMintPhase` reuses `MerkleRotationPending` error for THREE different proposal types — typed-revert ambiguity for off-chain consumers
**Severity:** Low
**File:** `contracts/src/TegridyDropV2.sol:644, 654, 655`
**Category:** other

**Bug:** The pass-2 fix correctly added cross-key blocks at `setMintPhase` so a phase flip cannot bypass any of the three propose/execute timelocks (merkle root, mint price, dutch curve). But all THREE checks revert with the same typed error:

```solidity
if (_executeAfter[MERKLE_ROOT_CHANGE] != 0) revert MerkleRotationPending();
if (_executeAfter[MINT_PRICE_CHANGE]   != 0) revert MerkleRotationPending();  // ← misleading
if (_executeAfter[DUTCH_CONFIG_CHANGE] != 0) revert MerkleRotationPending();  // ← misleading
```

Off-chain consumers (dapps, indexer alerting, multisig review tooling) that catch `MerkleRotationPending` will mis-attribute a price-change-blocked or dutch-config-blocked phase flip as a merkle-root issue. The remediation message shown to the user ("you have a pending merkle root rotation — cancel or wait for the timelock") is wrong when the actual blocker is a pending mint-price or dutch-curve change.

The pass-2 NatSpec at L651-653 explicitly acknowledges this: *"Reuses MerkleRotationPending error type to keep the typed-revert surface narrow (the semantic is identical)."* But the semantic is NOT identical from a debugging perspective — the user needs to know WHICH proposal to cancel.

**Attack / Impact:** No security impact. UX / debuggability degradation only. A user who sees `MerkleRotationPending` and runs `cancelMerkleRoot()` will get `NoPendingProposal` (because there's no pending merkle proposal) and be confused. The actual fix path is `cancelMintPrice()` or `cancelDutchAuction()`. Off-chain monitoring that pages-on-merkle-rotation-pending will fire spurious alerts when the actual pending change is a different timelock.

**Evidence:**
```solidity
// L644-655 — three different keys, one typed error
if (_executeAfter[MERKLE_ROOT_CHANGE] != 0) revert MerkleRotationPending();
if (_executeAfter[MINT_PRICE_CHANGE]   != 0) revert MerkleRotationPending();
if (_executeAfter[DUTCH_CONFIG_CHANGE] != 0) revert MerkleRotationPending();
```

**Recommendation:** Either (a) add typed errors per key:

```solidity
error MintPriceChangePending();
error DutchConfigChangePending();

if (_executeAfter[MERKLE_ROOT_CHANGE] != 0) revert MerkleRotationPending();
if (_executeAfter[MINT_PRICE_CHANGE]   != 0) revert MintPriceChangePending();
if (_executeAfter[DUTCH_CONFIG_CHANGE] != 0) revert DutchConfigChangePending();
```

Or (b) use a single generic `PendingProposalActive(bytes32 key)` error that includes the offending key:

```solidity
error PendingProposalActive(bytes32 key);

if (_executeAfter[MERKLE_ROOT_CHANGE] != 0) revert PendingProposalActive(MERKLE_ROOT_CHANGE);
if (_executeAfter[MINT_PRICE_CHANGE]   != 0) revert PendingProposalActive(MINT_PRICE_CHANGE);
if (_executeAfter[DUTCH_CONFIG_CHANGE] != 0) revert PendingProposalActive(DUTCH_CONFIG_CHANGE);
```

Option (b) keeps the error count narrow while giving consumers the info they need to debug. Pattern of record: OZ Governor's `GovernorUnexpectedProposalState(uint256 proposalId, ProposalState current, bytes32 expectedStates)` gives consumers full context on which proposal blocked the action.

---

## [DEEP-DROP-V3-06] `refund()` retains `unclaimedRefundPool -= owed` underflow vector if a future contributor partially restores the increment
**Severity:** Info
**File:** `contracts/src/TegridyDropV2.sol:976-989`
**Category:** other

**Bug:** The V2-DROP-02 fix removed the `unclaimedRefundPool += totalCost` mint-time write but PRESERVED the `unclaimedRefundPool -= owed` decrement at `refund()` L986. NatSpec acknowledges this (*"effectively a no-op"* L982-985). On any new clone the slot is permanently zero; `paidPerWallet[msg.sender]` is also permanently zero on any clone where `cancelSale()` ran (which requires `totalSupply == 0`). So the `owed == 0` early-return at L979 fires unconditionally and the underflow site is unreachable.

But the asymmetry IS a footgun for future contributors. If someone later partially reverts the V2-DROP-02 fix — e.g., adds `unclaimedRefundPool += partialAmount` somewhere but forgets to also decrement at the matching exit, OR adds the increment without first analyzing the cancel-policy-reversal NatSpec hint — the `-= owed` line at refund() will underflow whenever `paidPerWallet > unclaimedRefundPool`. With Solidity 0.8 checked math this is a typed `Panic(0x11)` revert that bricks ALL refunds rather than the typed `NothingToRefund` consumers expect.

The risk is conditional on a future PR but the current shape — live decrement against a guaranteed-zero counter — is precisely the "leftover plumbing waiting to mis-fire" pattern that V2-DROP-02 itself flagged as the worst of both worlds.

**Attack / Impact:** None today (unreachable). Footgun for any future PR that relaxes the cancel-policy or partially restores the accumulator. The risk is real but conditional.

**Evidence:**
```solidity
// L976-989
function refund() external nonReentrant {
    if (mintPhase != MintPhase.CANCELLED) revert SaleNotCancelled();
    uint256 owed = paidPerWallet[msg.sender];
    if (owed == 0) revert NothingToRefund();   // ← always fires today (no-mint-pre-cancel rule)
    paidPerWallet[msg.sender] = 0;
    unclaimedRefundPool -= owed;               // ← decrements zero counter; underflow if pool < owed
    WETHFallbackLib.safeTransferETHOrWrap(weth, msg.sender, owed);
    emit Refunded(msg.sender, owed);
}
```

**Recommendation:** Either (a) wrap the decrement in a guarded subtract that no-ops when the slot is already zero:

```solidity
uint256 pool = unclaimedRefundPool;
if (pool >= owed) {
    unclaimedRefundPool = pool - owed;
}
// else: pool was zero or under-tracked; let refund proceed without
//       the accounting decrement (matches the V2-DROP-02 dead-state).
```

Or (b) delete the line entirely along with the `unclaimedRefundPool` storage slot — the V2-DROP-02 NatSpec already documents the slot as deprecated. The cleanup is a single deletion + storage-layout migration note for any deployed clones (which would already have a zero slot since they post-date the V2-DROP-02 commit). Option (b) is the simpler long-term hygiene; option (a) is the smaller diff today.

---

## Summary

6 NEW findings:
- **High:** 0
- **Medium:** 3 (DEEP-DROP-V3-01, DEEP-DROP-V3-02, DEEP-DROP-V3-03)
- **Low:** 2 (DEEP-DROP-V3-04, DEEP-DROP-V3-05)
- **Info:** 1 (DEEP-DROP-V3-06)

**Highest-leverage fixes:**

1. **DEEP-DROP-V3-01** — port the V2-DROP-04 init-time guard to `setMintPhase(DUTCH_AUCTION)` AND `executeDutchAuction`. Two-line check at each site (`startTime + duration > block.timestamp`) closes the post-init-flip and post-timelock-execute footguns that re-open the silent-floor-launch bug the v2 fix only closed at construction.

2. **DEEP-DROP-V3-02** — port the V2-LP-01 `expectedExecuteAfter` value-bind to `executeMintPrice` and `executeDutchAuction`. Same pattern that LaunchpadV2 already adopted; restores the audit-trail invariant for multisig signers across the entire propose/execute surface.

3. **DEEP-DROP-V3-03** — port the DEEP-LP-02 `whenNotPaused` gate to all three DropV2 execute paths (and decide whether to keep the `paused()` branch in `_canRotateMerkleRoot` — recommend dropping it for symmetry with launchpad, requiring `unpause` before rotating). Pause becomes a real emergency lever instead of a no-op for the most dangerous setter sequences.

4. **DEEP-DROP-V3-04** — fat-finger guard against `executeMerkleRoot(bytes32(0))` while `mintPhase == ALLOWLIST` (the unpause-then-mint sequence silently bricks the drop). Mirrors the DEEP-DROP-03 invariant at the execute path.

5. **DEEP-DROP-V3-05 + V3-06** — code-hygiene fixes (typed-error fan-out for the cross-key proposal-pending blocks; either guard or delete the dead `unclaimedRefundPool -= owed` line). Neither is a current-vulnerability but both are footguns for future contributors.
