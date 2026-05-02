# Deep Audit v2 — TegridyDropV2 / TegridyLaunchpadV2 / TegridyTokenURIReader (2026-05-01)

**Scope (post-fix `fc5e09d`):**
- `contracts/src/TegridyDropV2.sol` (855 lines)
- `contracts/src/TegridyLaunchpadV2.sol` (398 lines)
- `contracts/src/TegridyTokenURIReader.sol` (206 lines)

**Pass-1 fix verification (per regression hot-spots):**
- DEEP-DROP-01 — `configureDutchAuction` gated to `MintPhase.CLOSED` (L695). Deploy flow `initialize(initialPhase=CLOSED) → configureDutchAuction(...) → setMintPhase(DUTCH_AUCTION)` STILL WORKS (initialize handles dutch wiring as a single-tx all-or-nothing block; the post-init `configureDutchAuction` setter is the CLOSED-only path for re-wiring or alt-flow factories that want to defer dutch config). **Confirmed not broken** — see test `test_DEEP_DROP_01_configureDutchAuction_allowedWhenClosed`.
- DEEP-DROP-02 — `setMintPrice` gated to CLOSED for ALL values (L628). Zero-toggle still works in CLOSED via `if (price == 0 && totalSupply > 0) revert ZeroPricePostMint;` post-check (L629). **Confirmed not broken** — but DEEP-DROP-V2-01 below documents a phase-flip bypass.
- DEEP-DROP-04 — `unclaimedRefundPool` accumulator: `+= totalCost` on mint (L468), `-= owed` on refund (L790), rescue claims `balance - unclaimedRefundPool` (L817-818). Math is correct in isolation. **But see DEEP-DROP-V2-02 below — the entire accumulator is dead-state once DEEP-DROP-05 lands.**
- DEEP-DROP-05 — `cancelSale` requires `totalSupply == 0` (L775). `rescueAfterCancellation` IS still reachable, but ONLY in the pre-mint cancel scenario. **Path makes no sense post-DEEP-DROP-05** — see DEEP-DROP-V2-02.
- DEEP-DROP-07 — `mint()` calls `_dutchAuctionPrice()` directly at L426-428 (NOT through `currentPrice()`); the internal call carries `SequencerCheck.checkSequencerUp` at L525. **Confirmed: mint has its own sequencer gate.** Sentinel only affects view path.
- DEEP-LP-01 — `acceptOwnership` (L385-397) checks `_executeAfter[KEY] != 0` before each `_cancel` call. **No-op case handled cleanly** — empty branches just skip the `_cancel` + event emit. Confirmed safe.
- DEEP-LP-04 — `executeProtocolFee(uint16)` requires `pendingProtocolFeeBps != protocolFeeBps` at PROPOSE time (L305 — `revert FeeUnchanged()`), so a no-op `0`-when-current-is-`0` proposal cannot be created. **Confirmed: `executeProtocolFee(0)` with no pending proposal reverts with `NoPendingProposal` from `_execute`.**
- DEEP-URI-02 — `tokenURI` reverts via `try ownerOf … catch { revert("NONEXISTENT") }` (L50-54). EIP-721 spec text is "MUST throw if `_tokenId` is not a valid NFT" — return-empty-string is a common but **non-spec** pattern (e.g., some Manifold tokens). The new behaviour is **strictly EIP-721 compliant**; the only consumers that break are off-chain indexers that rely on the (non-spec) empty-string fallback. Not a regression.
- C1 leaf — `keccak256(bytes.concat(keccak256(abi.encode(address(this), msg.sender, allowedAmount))))` at L440-442. Address(this) (the drop), msg.sender (the claimer), allowedAmount (the per-claimer cap) are all bound. **Confirmed correct.**

---

## [DEEP-DROP-V2-01] DEEP-DROP-02 fix bypassed via `setMintPhase(CLOSED) → setMintPrice(N) → setMintPhase(PUBLIC)` round-trip
**Severity:** High
**File:** `contracts/src/TegridyDropV2.sol:535-561, 627-632`
**Category:** mint

**Bug:** The DEEP-DROP-02 fix gates `setMintPrice` to `mintPhase == CLOSED`. But `setMintPhase` is ITSELF callable in any direction (CLOSED ↔ ALLOWLIST/PUBLIC) by the owner — there is no direction-or-monotonicity gate, and `withdrawn=false` is the only blocker for non-CLOSED targets. So the owner can:
1. Open `mintPhase = PUBLIC` with `mintPrice = 0.05 ether` — buyers queue mint txs.
2. Owner front-runs with `setMintPhase(MintPhase.CLOSED)` (legal, no rules block flipping back to CLOSED mid-PUBLIC).
3. Owner calls `setMintPrice(0.5 ether)` (legal — phase is now CLOSED, price != 0).
4. Owner calls `setMintPhase(MintPhase.PUBLIC)` (legal — `withdrawn = false`, merkleRoot check only fires for ALLOWLIST).
5. The pending mint txs in the mempool — many of which queued at step 1 with `msg.value = 0.05 ether` — now revert on `InsufficientPayment` (price required is 10× higher).

The original DEEP-DROP-02 attack shape (front-run buyers with a mid-PUBLIC price hike) is closed for the **direct** call but reopens via this 3-call sequence, which a private-mempool MEV builder can land atomically as a bundle.

**Attack / Impact:** Identical economic impact to DEEP-DROP-02. Owner observes mempool, atomically wraps `setMintPhase(CLOSED) → setMintPrice(higher) → setMintPhase(PUBLIC)` in a flashbots bundle (or sandwich-pattern via private mempool). Pending buyers either (a) revert and waste gas, or (b) retry-quote at the new higher price. This converts a "phase-gate is the new fix" into a "phase-gate is a 1-block speedbump" — meaningless against an MEV-aware operator.

**Evidence:**
```solidity
// L535-561 — setMintPhase has NO monotonicity / direction gate
function setMintPhase(MintPhase phase) external onlyOwner {
    if (mintPhase == MintPhase.CANCELLED) revert SaleCancelled();
    if (phase == MintPhase.CANCELLED) revert SaleNotCancelled();
    if (withdrawn && phase != MintPhase.CLOSED) revert WithdrawFailed();
    if (_executeAfter[MERKLE_ROOT_CHANGE] != 0) revert MerkleRotationPending();
    if (phase == MintPhase.DUTCH_AUCTION && dutchDuration == 0) revert DutchAuctionNotActive();
    if (phase == MintPhase.ALLOWLIST && merkleRoot == bytes32(0)) revert InvalidProof();
    mintPhase = phase;            // ← can flip mint-active → CLOSED → setMintPrice → mint-active
    emit MintPhaseChanged(phase);
}

// L627-632 — gate is "phase == CLOSED right now" with no history check
function setMintPrice(uint256 price) external onlyOwner {
    if (mintPhase != MintPhase.CLOSED) revert PriceChangePhaseLocked();
    if (price == 0 && totalSupply > 0) revert ZeroPricePostMint();
    mintPrice = price;
    emit MintPriceChanged(price);
}
```

**Recommendation:** Apply the same M-D1 / R023 propose/execute timelock pattern that already protects merkle-root rotation — `proposeMintPrice(uint256) → 24h → executeMintPrice(uint256 expectedPrice)`. With a published delay, buyers can observe queued price changes BEFORE they land and decide to drop their pending mints. Alternative (weaker): make `setMintPhase` non-rewinding once `totalSupply > 0` — i.e., post-mint, the only legal `setMintPhase` target is CLOSED, and once CLOSED post-mint it cannot flip back to active. This preserves the "owner can end a live sale" path while killing the round-trip bypass. Same pattern of record: Manifold ERC721LazyPayableClaim freezes `claim.cost` once `claim.startDate < block.timestamp`, regardless of admin attempts to pause or restart the sale.

---

## [DEEP-DROP-V2-02] `cancelSale → totalSupply == 0` gate makes the entire refund / rescue / `unclaimedRefundPool` plumbing unreachable
**Severity:** Medium
**File:** `contracts/src/TegridyDropV2.sol:218, 466-468, 782-825`
**Category:** other

**Bug:** DEEP-DROP-05 gates `cancelSale()` to `totalSupply == 0` (L775). The drop has **no burn / no supply decrement** — once any mint has occurred, `totalSupply > 0` is monotonic-permanent. Therefore `cancelSale()` is reachable ONLY before any mint has happened. In that branch:
- No `paidPerWallet[]` entries exist (mint never ran).
- `unclaimedRefundPool == 0` (mint never ran).
- `address(this).balance == 0` (no minter ever paid).

Consequently `refund()` is **structurally unreachable** — every minter's `paidPerWallet` is zero, so `if (owed == 0) revert NothingToRefund` fires unconditionally. `rescueAfterCancellation()` reaches the `if (balance <= unclaimedRefundPool) revert NothingToRescue` check at L817 with both sides at zero — only path through is if someone has DONATED raw ETH to the cancelled drop's address (which the H20 docs at L796-799 explicitly cite as the rescue's reason for existing, but is now the ONLY use case).

The `unclaimedRefundPool += totalCost` write at L468 fires on every mint — costing one SSTORE-warm-write (~2.9k gas) per mint — for an accumulator that is read EXCLUSIVELY by `refund()` (unreachable) and `rescueAfterCancellation()` (which only reads it in the reachable post-cancel-pre-mint scenario where it equals zero). The entire DEEP-DROP-04 mitigation is dead state.

**Attack / Impact:** No security loss, but two real costs:
1. **Gas waste:** Every mint pays ~2.9k extra gas to maintain a counter that is never meaningfully read. At a busy drop's lifecycle (10k mints), that's ~29M gas of pure waste.
2. **Auditability surface:** Future contributors looking at `paidPerWallet`, `refund()`, `unclaimedRefundPool`, `rescueAfterCancellation()` will reasonably assume these form a working refund mechanism — and may build new logic on top of it (e.g., a "creator-initiated voluntary refund" feature). The accumulator's unreachability is non-obvious and undocumented.
3. **H20 fix degradation:** The original H20 (post-cancel rescue) fix was a 1-year residual sweep designed for "lost-key minters" — but that scenario now requires a minter who paid AND a cancelled drop, which the DEEP-DROP-05 fix made impossible. The rescue now only exists for "raw ETH donations to a cancelled drop" — a vestigial use case.

**Evidence:**
```solidity
// L466-468 — unconditional pool increment on every mint
totalSupply += quantity;
mintedPerWallet[msg.sender] += quantity;
paidPerWallet[msg.sender] += totalCost;
unclaimedRefundPool += totalCost;       // ← forever-write; never meaningfully read

// L772-780 — cancel only pre-mint
function cancelSale() external onlyOwner {
    if (mintPhase == MintPhase.CANCELLED) revert SaleCancelled();
    if (withdrawn) revert WithdrawFailed();
    if (totalSupply > 0) revert CancelAfterFirstMint();    // ← post-mint cancel locked out
    mintPhase = MintPhase.CANCELLED;
    cancelledAt = block.timestamp;
    ...
}

// L782-793 — refund unreachable when cancelSale only fires pre-mint
function refund() external nonReentrant {
    if (mintPhase != MintPhase.CANCELLED) revert SaleNotCancelled();
    uint256 owed = paidPerWallet[msg.sender];
    if (owed == 0) revert NothingToRefund();   // ← always fires (no mint → no paidPerWallet)
    ...
}
```

**Recommendation:** Choose ONE of:

(a) **Reverse DEEP-DROP-05** to allow post-mint cancel, BUT add the 7-day cancel-intent timelock that pass-1's DEEP-DROP-05 recommendation already proposed. This restores `refund()` reachability and re-justifies the entire `unclaimedRefundPool` machinery. Pattern: Sound Protocol `setSaleEnd → wait → withdraw + refunds`.

(b) **Remove the dead code:** delete `paidPerWallet`, `refund()`, `rescueAfterCancellation()`, `unclaimedRefundPool`, and the H20 plumbing (cancelledAt, POST_CANCEL_RESCUE_DELAY, refund-related events). `cancelSale()` becomes a one-shot mark for off-chain monitors only — the drop is effectively dead but no on-chain user funds need clearing. Pattern: Manifold disables cancellation post-mint AND has no refund mechanism — the cancel is purely a state marker.

Either way, the current asymmetry (live refund machinery + cancel that can never trigger it) is the worst of both worlds.

---

## [DEEP-DROP-V2-03] `configureDutchAuction` reachable via `setMintPhase(CLOSED)` round-trip — DEEP-DROP-01 has the same flip-back bypass as DEEP-DROP-02
**Severity:** Medium
**File:** `contracts/src/TegridyDropV2.sol:535-561, 689-707`
**Category:** mint

**Bug:** Identical structural shape to DEEP-DROP-V2-01. The DEEP-DROP-01 fix gates `configureDutchAuction` to `mintPhase == CLOSED`. But owner can:
1. Open `mintPhase = DUTCH_AUCTION` with curve `(start=1 ether, end=0.01 ether, duration=24h)`.
2. Decay reaches `currentPrice() ≈ 0.05 ether`; bidder queues `mint{value: 0.05 ether}(...)`.
3. Owner front-runs: `setMintPhase(MintPhase.CLOSED)` (legal — no direction gate).
4. Owner calls `configureDutchAuction(2 ether, 1 ether, block.timestamp + 1, 12 hours)` (legal — phase is now CLOSED).
5. Owner calls `setMintPhase(MintPhase.DUTCH_AUCTION)` (legal — `dutchDuration > 0`).
6. Pending bidder's tx now resolves against the new curve where `currentPrice ≈ 2 ether`; reverts on `InsufficientPayment`.

The DEEP-DROP-01 fix is broken by exactly the same MEV-bundle pattern as DEEP-DROP-V2-01.

**Attack / Impact:** Mid-DUTCH curve reset rug primitive returns intact. Owner extracts 10×+ floor on next batch by atomically resetting decay before pending bidder txs land. Same MEV-builder collusion vector as DEEP-DROP-V2-01.

**Evidence:**
```solidity
// L689-707 — phase gate is "now-only" with no history check
function configureDutchAuction(uint256 startPrice, ...) external onlyOwner {
    if (mintPhase != MintPhase.CLOSED) revert DutchConfigPhaseLocked();
    // ... validation ...
    dutchStartPrice = startPrice;
    dutchEndPrice = endPrice;
    dutchStartTime = startTime;
    dutchDuration = duration;
    emit DutchAuctionConfigured(...);
}

// L535-561 — setMintPhase allows DUTCH_AUCTION → CLOSED → DUTCH_AUCTION roundtrip
```

**Recommendation:** Same shape as DEEP-DROP-V2-01: either timelock `configureDutchAuction` (24h propose/execute) so bidders observe curve changes, OR forbid `setMintPhase(DUTCH_AUCTION)` while a previous dutch auction has produced any mints (track `dutchTotalSupplyAtConfig` and refuse re-configure if `totalSupply > dutchTotalSupplyAtConfig`). The first option matches the merkle-root rotation pattern already in use; the second is more restrictive but avoids any new timelock surface.

---

## [DEEP-DROP-V2-04] `initialize` allows `initialPhase = DUTCH_AUCTION` without `dutchConfigured`-validation parity with `setMintPhase`
**Severity:** Low
**File:** `contracts/src/TegridyDropV2.sol:296-366, 535-561`
**Category:** mint

**Bug:** `setMintPhase(DUTCH_AUCTION)` requires `dutchDuration != 0` (L551-553). `initialize()` requires the same condition via L354-356 (`if (initialPhase == DUTCH_AUCTION && !dutchConfigured) revert DutchAuctionNotActive`), where `dutchConfigured` is true iff ANY of the four dutch fields is non-zero (L340-341). Then L342-352 validates the FULL set with the same rules as `configureDutchAuction`.

But the `dutchConfigured` flag is asymmetric: a factory passing `dutchStartTime = 1, dutchDuration = 0, dutchStartPrice = 0, dutchEndPrice = 0` triggers the "all-or-nothing" branch and reverts on `InvalidDutchAuctionConfig` (`dutchDuration == 0`). Good. But a factory passing `dutchStartPrice = 1, dutchEndPrice = 0` (no time fields) goes through the same branch and reverts on `dutchStartTime == 0`. Good.

The actual asymmetry: `initialize` accepts `initialPhase = DUTCH_AUCTION` with a fully-validated dutch config, AND `dutchStartTime` may be in the past (e.g., `block.timestamp - 1`). At L526-528, `_dutchAuctionPrice()` then returns `dutchEndPrice` if `block.timestamp - dutchStartTime >= dutchDuration` — i.e., the decay is already complete at deploy-time. The contract launches in DUTCH_AUCTION at the floor price. No revert; users mint at the absolute floor.

While the **economic impact is negligible** (creator chose the floor), the **UX impact** is significant: a factory script that mis-computes timestamps (e.g., uses a stale block.timestamp from a forked simulation) deploys a drop where the dutch curve is already maximally decayed, and the creator only realizes once mints come in at end-price. The init-time validation should require `dutchStartTime + dutchDuration > block.timestamp` for the DUTCH_AUCTION initial phase.

**Attack / Impact:** Footgun, not exploit. Factory deploy scripts that compute `dutchStartTime` from off-chain data are vulnerable to silent floor-price launches. A buyer who mints at the auction's first block sees no price advantage; the curve was already done.

**Evidence:**
```solidity
// L342-352 — dutch validation at init-time has no "is the curve already decayed at start?" check
if (dutchConfigured) {
    if (p.dutchStartPrice <= p.dutchEndPrice) revert InvalidDutchAuctionConfig();
    if (p.dutchDuration == 0) revert InvalidDutchAuctionConfig();
    if (p.dutchStartTime == 0) revert InvalidDutchAuctionConfig();
    if (p.dutchStartPrice - p.dutchEndPrice < p.dutchDuration) revert InvalidDutchAuctionConfig();
    // MISSING: if (p.initialPhase == DUTCH_AUCTION &&
    //              p.dutchStartTime + p.dutchDuration <= block.timestamp)
    //              revert DutchAuctionAlreadyEnded();
    dutchStartPrice = p.dutchStartPrice;
    ...
}

// L526-528 — already-ended curve silently returns floor
if (elapsed >= dutchDuration) return dutchEndPrice;
```

**Recommendation:** Add an init-time check: when `initialPhase == DUTCH_AUCTION`, require `dutchStartTime + dutchDuration > block.timestamp` (curve has at least one block of decay remaining). Mirror the same check in `setMintPhase(DUTCH_AUCTION)` so no path enters DUTCH with an already-ended curve. Pattern of record: Sudoswap `LSSVMPair.swapTokenForSpecificNFTs` rejects expired auctions at the entry point.

---

## [DEEP-DROP-V2-05] `currentPrice()` external `try/catch` self-call adds STATICCALL overhead and surface-area without need
**Severity:** Low
**File:** `contracts/src/TegridyDropV2.sol:496-515`
**Category:** other

**Bug:** The DEEP-DROP-07 fix wraps `_dutchAuctionPrice()` in a `try this.dutchAuctionPriceExternal() catch { return type(uint256).max }` to convert sequencer-outage reverts into a sentinel return for off-chain consumers. Implementation pattern is correct (Solidity does not allow try/catch over INTERNAL function calls, hence the external selector trampoline at L513-515), but it has two practical issues:

1. **Gas cost:** Every `currentPrice()` call during DUTCH_AUCTION pays ~2,400 gas for the STATICCALL, regardless of whether the sequencer is up or down. Indexer pipelines that poll this view (subgraphs reindexing every block, mint-page UIs refreshing on each new block) absorb this cost over the lifetime of every dutch auction.

2. **Re-entrancy surface:** STATICCALL into the same contract is benign on a `view`-marked external function (the EVM rejects state writes regardless), but it does add an exotic-pattern attack-surface line that future contributors might unknowingly weaken. The simpler implementation pattern is `tryCheckSequencerUp` (already present in `SequencerCheck.sol` at L157-188 as the non-reverting sister of `checkSequencerUp`) — used by other Tegriddy contracts (per the file's own comments at L191-201) for exactly this "convert revert to soft-fail" pattern.

**Attack / Impact:** None directly. Operational cost (gas-per-view) and code-surface concern. The pattern propagated here is non-canonical for the codebase; the protocol already has the correct primitive (`SequencerCheck.tryCheckSequencerUp`).

**Evidence:**
```solidity
// L496-515 — try/catch self-call trampoline pattern
function currentPrice() public view returns (uint256) {
    if (mintPhase == MintPhase.DUTCH_AUCTION) {
        try this.dutchAuctionPriceExternal() returns (uint256 p) {
            return p;
        } catch {
            return type(uint256).max;
        }
    }
    return mintPrice;
}

function dutchAuctionPriceExternal() external view returns (uint256) {
    return _dutchAuctionPrice();
}

// SequencerCheck.sol L157-188 — already provides the canonical non-reverting helper
function tryCheckSequencerUp(address feed, uint256 gracePeriod)
    internal view returns (bool ok, uint8 reason);
```

**Recommendation:** Refactor `currentPrice()` to use `SequencerCheck.tryCheckSequencerUp(sequencerFeed, SEQUENCER_GRACE_PERIOD)` directly:
```solidity
function currentPrice() public view returns (uint256) {
    if (mintPhase == MintPhase.DUTCH_AUCTION) {
        (bool ok, ) = SequencerCheck.tryCheckSequencerUp(sequencerFeed, SEQUENCER_GRACE_PERIOD);
        if (!ok) return type(uint256).max;
        return _dutchAuctionPriceWithoutSequencerCheck();
    }
    return mintPrice;
}
```
Saves ~2,400 gas per call, removes the self-call surface, and aligns with the pattern documented at `SequencerCheck.sol` L191-201 ("retire re-implementations elsewhere in favour of this single source of truth"). Requires factoring out the non-sequencer-checking dutch math into a separate internal helper (the existing `_dutchAuctionPrice` would call `checkSequencerUp` then defer to it — same shape as the bounty-board / lending pattern.)

---

## [DEEP-LP-V2-01] `executeProtocolFee(0) → cancel → propose(N) → execute(N)` race not closed by value-binding
**Severity:** Low
**File:** `contracts/src/TegridyLaunchpadV2.sol:303-336`
**Category:** gov

**Bug:** DEEP-LP-04 added the `expectedFeeBps` value-bound execute. But the value-binding only catches the case where `pendingProtocolFeeBps` was MUTATED between the multisig signer's review and execution (cancel → re-propose with different value). It does NOT catch the case where the signer's expected value matches a stale storage state because `cancelProtocolFee()` clears the storage AND the queue together, then `proposeProtocolFee(newValue)` is called with `newValue == oldValue`.

Concretely: signer reviews `pendingProtocolFeeBps = 200, executeAfter = T1`. Signer signs `executeProtocolFee(200)`. Between sign and broadcast, another signer (or owner) calls `cancelProtocolFee()` (clears state, emits `ProtocolFeeCancelled`), then `proposeProtocolFee(200)` (stores 200 again, executeAfter = T2 > T1). When the original signer's tx lands at time `now < T2 - some_epsilon`, the execute reverts with `ProposalNotReady` — good. But if `now >= T2`, the execute SUCCEEDS, applying the 200 from the SECOND proposal even though the signer reviewed the FIRST.

The `executeAfter` value is not part of the value-binding. The signer cannot prove they're executing the proposal they reviewed, only that they're executing SOME proposal with the expected value.

**Attack / Impact:** Multisig-collusion edge case. Two cooperating signers can re-propose with a delay shift. Real impact is small because the value matched, but it breaks the audit-trail: off-chain tooling that maps "this signer approved that proposal" can no longer cite the proposal-creation event with confidence. Higher-fidelity multisig flows (e.g. Safe with timelock) bind to a hash of (target, calldata, ETA); this is the same idea.

**Evidence:**
```solidity
// L323-330 — executeProtocolFee binds to value but not to executeAfter
function executeProtocolFee(uint16 expectedFeeBps) external onlyOwner whenNotPaused {
    if (pendingProtocolFeeBps != expectedFeeBps) revert FeeMismatch();
    _execute(FEE_CHANGE);   // ← reads _executeAfter[FEE_CHANGE] from storage; no eta binding
    ...
}

// L332-336 — cancel zeros the storage; subsequent re-propose creates a NEW eta
function cancelProtocolFee() external onlyOwner {
    _cancel(FEE_CHANGE);
    pendingProtocolFeeBps = 0;
    emit ProtocolFeeCancelled();
}
```

**Recommendation:** Add an optional `expectedExecuteAfter` parameter to bind execution to a specific proposal-creation: `executeProtocolFee(uint16 expectedFeeBps, uint256 expectedExecuteAfter)` and assert `_executeAfter[FEE_CHANGE] == expectedExecuteAfter` before applying. Mirror in `executeProtocolFeeRecipient`. Pattern of record: OZ Governor `execute(targets, values, calldatas, descriptionHash)` binds to the proposal's full identity hash, not just its constituent values.

---

## [DEEP-DROP-V2-06] `freezeBaseURI()` is irreversible AND callable while paused — guardian cannot un-brick a fat-fingered freeze
**Severity:** Low
**File:** `contracts/src/TegridyDropV2.sol:649-664`
**Category:** other

**Bug:** `freezeBaseURI()` is `onlyOwner` and one-way (no unfreeze). `pause()`+ `setBaseURI` would have been a controlled rollback path before the freeze. After `freezeBaseURI()` runs:
- `setBaseURI` reverts with `BaseURIFrozen` permanently.
- The placeholder URI is committed to whatever `_baseTokenURI` storage held at the freeze-block.

If the owner mis-calls `freezeBaseURI()` BEFORE setting the intended placeholder (or with a typo'd URI), the drop is permanently stuck on whatever (possibly empty / wrong) placeholder is in storage. There is no governance path back. Guardian-pause is meaningless because the freeze flag is monotonic — pause doesn't roll back the storage write.

**Attack / Impact:** Footgun, not exploit. Creator who calls `freezeBaseURI()` before `setBaseURI(realPlaceholder)` ships a permanently-broken pre-reveal experience (empty `_baseTokenURI` → `tokenURI(id)` returns empty string for all pre-reveal IDs). Reveal still works (`reveal()` is a separate code path — reveal also blocks `setBaseURI` via `if (revealed) revert AlreadyRevealed`, so the freeze is also redundant once revealed).

The fact that `freezeBaseURI` and `reveal` have OVERLAPPING semantics (both set the placeholder slot to immutable) is itself a code-surface concern — the protocol effectively has two ways to freeze the placeholder, and a future contributor adding logic to one may forget the other.

**Evidence:**
```solidity
// L649-654 — setBaseURI gated by EITHER frozen flag OR revealed flag
function setBaseURI(string calldata uri) external onlyOwner {
    if (baseURIFrozen) revert BaseURIFrozen();
    if (revealed) revert AlreadyRevealed();
    _baseTokenURI = uri;
    emit BaseURIChanged(uri);
}

// L661-664 — freezeBaseURI is one-way
function freezeBaseURI() external onlyOwner {
    baseURIFrozen = true;
    emit BaseURIFrozenEvent();
}
```

**Recommendation:** Either (a) require `bytes(_baseTokenURI).length > 0` before allowing `freezeBaseURI()` to fire — prevents accidental commit-to-empty; or (b) add a 24h timelock around `freezeBaseURI()` so a fat-finger has a recovery window via `cancelFreezeBaseURI()`. The empty-URI guard is the smaller fix and addresses the most likely operator-error mode.

---

## [DEEP-URI-V2-01] `tokenURI(0)` always reverts — but token ID 0 is a legitimate ERC-721 ID under OZ defaults
**Severity:** Info
**File:** `contracts/src/TegridyTokenURIReader.sol:41-54`
**Category:** erc721

**Bug:** The DEEP-URI-02 fix uses `try staking.ownerOf(0) catch { revert("NONEXISTENT") }`. OZ ERC-721's `ownerOf(0)` reverts with `ERC721NonexistentToken(0)` IFF token 0 was never minted. But `TegridyStaking._stake` (or wherever the position NFT mints) could legitimately mint token ID 0 as the first position — at which point `ownerOf(0)` returns a valid address, and `tokenURI(0)` would render correctly.

Verify: the staking contract's mint counter — does it start at 1 or 0? If token 0 is reserved (counter starts at 1, common Manifold pattern), the reader's behavior is correct. If not, this is a Low. Without changing the source files in scope, I cannot verify the staking contract's counter — flagging as Info-level "verify in cross-cluster review."

**Attack / Impact:** None if staking starts at ID 1. If staking starts at ID 0, the first staker's position NFT will return a confusing typed revert ("NONEXISTENT") for `tokenURI(0)` from the reader, even though the token exists.

**Evidence:**
```solidity
// L50-54 — assumes ownerOf(non-existent) reverts; doesn't differentiate
//          between "non-existent" and "exists but zero-init holder"
try staking.ownerOf(tokenId) returns (address holder) {
    require(holder != address(0), "NONEXISTENT");
} catch {
    revert("NONEXISTENT");
}
```

**Recommendation:** Cross-check `TegridyStaking._nextTokenId` initial value. If it starts at 0, either (a) modify staking to start at 1 (one-line change at the staking contract), or (b) modify the reader to also accept `holder != address(0)` from `ownerOf(0)` as proof of existence. Option (a) is the universal Manifold/Sudoswap pattern; recommend (a).

---

## Summary

8 NEW findings:
- **High:** 1 (DEEP-DROP-V2-01 — `setMintPhase(CLOSED) → setMintPrice → setMintPhase(PUBLIC)` round-trip bypasses DEEP-DROP-02 fix)
- **Medium:** 2 (DEEP-DROP-V2-02 — refund/rescue plumbing dead-state after DEEP-DROP-05; DEEP-DROP-V2-03 — same round-trip bypasses DEEP-DROP-01 dutch-curve fix)
- **Low:** 4 (DEEP-DROP-V2-04 — initialize allows already-ended dutch curve; DEEP-DROP-V2-05 — `currentPrice()` self-call gas waste; DEEP-LP-V2-01 — `executeAfter` not value-bound; DEEP-DROP-V2-06 — `freezeBaseURI()` foot-gun on empty URI)
- **Info:** 1 (DEEP-URI-V2-01 — verify staking token-ID counter starts at 1)

**Highest-leverage fixes:**

1. **DEEP-DROP-V2-01 + DEEP-DROP-V2-03** — the same round-trip bypass undoes BOTH the DEEP-DROP-01 (dutch) and DEEP-DROP-02 (mint price) fixes. Single root cause: phase-gating is "now-only" with no monotonicity. The pass-1 recommendations to use a 24h propose/execute timelock for these setters are the right answer; the current "phase == CLOSED" gate is bypassable in 3 calls. Recommend adopting `proposeMintPrice(uint256) → executeMintPrice(uint256)` and `proposeDutchAuction(...) → executeDutchAuction(...)` mirroring the merkle-root rotation pattern. Same for `setMintPhase` going from CLOSED back to active — gate that direction with the same delay so MEV bundles cannot atomically shuffle phase.

2. **DEEP-DROP-V2-02** — pick a lane. Either reverse DEEP-DROP-05 (allow post-mint cancel with timelock + warning) AND keep refund/rescue, OR delete refund/rescue entirely. The current state is internally inconsistent: live refund machinery + cancel that can never trigger it.

3. **DEEP-DROP-V2-05** — refactor `currentPrice()` to use `SequencerCheck.tryCheckSequencerUp` instead of self-call try/catch. Saves gas on every poll and aligns with the codebase's canonical pattern.

4. **DEEP-DROP-V2-04** — small init-time guard: `if (initialPhase == DUTCH_AUCTION && dutchStartTime + dutchDuration <= block.timestamp) revert DutchAuctionAlreadyEnded;` — closes the silent floor-price launch footgun.
