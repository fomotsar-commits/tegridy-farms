# Deep Audit — TegridyDropV2 / TegridyLaunchpadV2 / TegridyTokenURIReader (2026-05-01)

**Scope:**
- `contracts/src/TegridyDropV2.sol` (726 lines)
- `contracts/src/TegridyLaunchpadV2.sol` (294 lines)
- `contracts/src/TegridyTokenURIReader.sol` (195 lines)

**Excluded (already reported, not re-listed):**
- MICROSCOPE C1 (allowlist leaf no amount) — verified shipped at L402-404, L409-412.
- MICROSCOPE H18 (cancelSale after sold-out) — verified shipped at L661.
- MICROSCOPE H19 (setMintPrice 0 toggle) — verified shipped at L548-550.
- MICROSCOPE H20 (rescueAfterCancellation) — verified shipped at L684-697 (but see DEEP-DROP-04 for residual).
- MICROSCOPE H22 (TokenURIReader JSON escape + stable lock-status enum) — verified shipped at L94-99, L109-121.
- MICROSCOPE M-D1 (root-rotation + setMintPhase smuggle) — verified shipped at L480 (`MerkleRotationPending`).
- MICROSCOPE M-D3 (acceptOwnership clearing pending merkle proposal) — verified shipped at L715-720.
- MICROSCOPE M-D4 (Launchpad `cancelProtocolFeeRecipient` event) — verified shipped at L58, L289.
- 011 H-01 (Drop merkle root rotation race) — closed by R023 propose/execute (L513-541).
- 011 L-03 (`reveal("")` brick) — out of scope; LOW UX item.
- 014 MEDIUM-1 (Reader gas profile if ever wired on-chain) — INFO-level off-chain consumer concern.

---

## [DEEP-DROP-01] `configureDutchAuction` callable mid-DUTCH_AUCTION → owner can rug in-flight bidders by hiking `dutchStartPrice`
**Severity:** High
**File:** `contracts/src/TegridyDropV2.sol:587-604`
**Category:** mint

**Bug:** `configureDutchAuction` is `onlyOwner` with NO phase guard, NO timelock, and NO monotonicity check on the new `startPrice / endPrice`. While `mintPhase == DUTCH_AUCTION` is active and the auction is mid-decay, the owner can call `configureDutchAuction(higherStartPrice, …, newStartTime, …)` — instantly resetting the entire decay curve. A user who quoted `currentPrice() = 0.05 ether` at block N and submitted a mint with `msg.value = 0.05 ether` finds their tx pending in mempool while the owner front-runs with a curve where `currentPrice()` is now `0.5 ether`. The user's tx reverts on `InsufficientPayment`. Even worse, if the user passed `msg.value` exactly equal to the new (higher) cost as a sandwich, they'd overpay the difference (the contract refunds overpayment, so this branch is OK, but the original sandwich-style price hike is the issue).

**Attack / Impact:** Owner runs a 24h dutch auction starting at 1 ETH, decaying to 0.01 ETH. As the price reaches 0.05 ETH and a flurry of mint txs hit the mempool, owner front-runs with `configureDutchAuction(1 ether, 0.5 ether, block.timestamp, 24 hours)`. The decay clock resets; new floor is 0.5 ETH. Every pending 0.05-ETH mint reverts with `InsufficientPayment`. Bidders lose gas; owner extracts 10x the floor on the next batch.

**Evidence:**
```solidity
// L587-604
function configureDutchAuction(
    uint256 startPrice,
    uint256 endPrice,
    uint256 startTime,
    uint256 duration
) external onlyOwner {
    if (startPrice <= endPrice) revert InvalidDutchAuctionConfig();
    if (duration == 0) revert InvalidDutchAuctionConfig();
    if (startTime == 0) revert InvalidDutchAuctionConfig();
    if (startPrice - endPrice < duration) revert InvalidDutchAuctionConfig();

    // No phase guard. No timelock. No monotonicity check.
    dutchStartPrice = startPrice;
    dutchEndPrice = endPrice;
    dutchStartTime = startTime;
    dutchDuration = duration;
    ...
}
```

**Recommendation:** Mirror the `setMaxPerWallet` discipline introduced for C1: gate `configureDutchAuction` to `mintPhase == CLOSED`. Once a dutch auction is active (or once any minting phase is live with dutch params staged), the curve must be immutable. Pattern: Zora `ERC721Drop.setSaleConfiguration` is gated to non-active sale states. If post-init config is required mid-CLOSED, lift to a `propose / execute` timelock keyed on the `DUTCH_CONFIG` op.

---

## [DEEP-DROP-02] `setMintPrice` raises price arbitrarily mid-PUBLIC → mempool griefing + secondary-market arbitrage
**Severity:** Medium
**File:** `contracts/src/TegridyDropV2.sol:547-554`
**Category:** mint

**Bug:** Outside the `price == 0` branch (which is gated to pre-mint CLOSED), `setMintPrice(N)` accepts any non-zero `N` in any phase including ACTIVE PUBLIC / ALLOWLIST. The setter has no upper bound, no monotonicity rule, no timelock, no phase gate. While `mintPhase == PUBLIC` and a buyer has `mint{value: 0.05 ether}(5, …)` pending in the mempool, the owner can front-run with `setMintPrice(0.05 ether)` (raising from `0.01`) — the buyer's tx now requires `0.25 ether` total but only carries `0.05`, reverting on `InsufficientPayment`. This is identical in shape to DEEP-DROP-01 but applies to the simple PUBLIC phase that most clones will use.

**Attack / Impact:** (1) Pure griefing: owner observes mint txs and front-runs with price hikes, wasting buyer gas in batches. (2) Dynamic-pricing arbitrage: owner watches secondary-market velocity, raises the primary mint price every block to track the floor; primary buyers either overpay or revert, and owner captures the spread. (3) MEV-aligned: a private mempool builder can collude with the owner to atomically `setMintPrice(high) → batch-mint → setMintPrice(low)`, sandwiching legit buyers between two same-block setter calls.

**Evidence:**
```solidity
// L547-554
function setMintPrice(uint256 price) external onlyOwner {
    if (price == 0) {
        if (totalSupply > 0) revert ZeroPricePostMint();
        require(mintPhase == MintPhase.CLOSED, "ZERO_PRICE_ONLY_WHEN_CLOSED");
    }
    // Non-zero path: any value, any phase. No timelock. No max.
    mintPrice = price;
    emit MintPriceChanged(price);
}
```

**Recommendation:** Either (a) gate ALL `setMintPrice` calls (not just the zero branch) to `mintPhase == CLOSED`, or (b) add a `propose/execute` timelock with a published delay so buyers see incoming changes before they land. Pattern: Manifold ERC721LazyPayableClaim freezes price when `claim.startDate < block.timestamp`. The current zero-vs-nonzero asymmetry is a half-installed mitigation — H19 closed the toggle-to-free path, but the toggle-to-arbitrary-high path is wide open.

---

## [DEEP-DROP-03] `setMintPhase(ALLOWLIST)` accepts active phase with `merkleRoot == bytes32(0)` → silent ALLOWLIST brick
**Severity:** Low
**File:** `contracts/src/TegridyDropV2.sol:465-486`
**Category:** mint

**Bug:** `initialize()` correctly enforces `revert InvalidProof()` if `initialPhase == ALLOWLIST && merkleRoot == bytes32(0)` (L326). But `setMintPhase` has no analogous check. A drop initialized with `merkleRoot == bytes32(0)` and `initialPhase == CLOSED` can later be flipped to `ALLOWLIST` via `setMintPhase` — the contract enters ALLOWLIST with a zero root. Every subsequent allowlist mint computes `leaf = keccak256(...)` (uniformly random) and checks `MerkleProof.verify(proof, bytes32(0), leaf)` — which only passes if `processProof(proof, leaf) == 0`. With non-empty trees this is computationally infeasible; with empty proof and `leaf != 0`, always fails. So the drop silently bricks all mints. No revert at the setter; no event signal; just a permanent dead-allowlist state.

**Attack / Impact:** Bricked drop. Not exploitable for theft — but a creator who fat-fingers `setMintPhase(ALLOWLIST)` before remembering to `proposeMerkleRoot` ships a broken sale that quietly fails for every claimer. Combined with the 24h `MERKLE_ROOT_DELAY`, the drop is dead for at least one day before any minting can resume. Indexers and mint pages report "active mint" but every transaction reverts with `InvalidProof`.

**Evidence:**
```solidity
// L465-486 — setMintPhase has NO root-presence check
function setMintPhase(MintPhase phase) external onlyOwner {
    if (mintPhase == MintPhase.CANCELLED) revert SaleCancelled();
    if (phase == MintPhase.CANCELLED) revert SaleNotCancelled();
    if (withdrawn && phase != MintPhase.CLOSED) revert WithdrawFailed();
    if (_executeAfter[MERKLE_ROOT_CHANGE] != 0) revert MerkleRotationPending();
    if (phase == MintPhase.DUTCH_AUCTION && dutchDuration == 0) {
        revert DutchAuctionNotActive();
    }
    // MISSING: if (phase == MintPhase.ALLOWLIST && merkleRoot == bytes32(0)) revert InvalidProof();
    mintPhase = phase;
    emit MintPhaseChanged(phase);
}
```

**Recommendation:** Add the symmetric check that already exists at `initialize()`:
```solidity
if (phase == MintPhase.ALLOWLIST && merkleRoot == bytes32(0)) revert InvalidProof();
```

---

## [DEEP-DROP-04] `rescueAfterCancellation` sweeps full balance → late refunders permanently bricked
**Severity:** Medium
**File:** `contracts/src/TegridyDropV2.sol:684-697`
**Category:** mint

**Bug:** The H20 fix lets the creator sweep `address(this).balance` 1 year after `cancelSale()`. But `paidPerWallet[user]` mappings are NOT cleared during the rescue. A minter who attempts `refund()` after the rescue reads their non-zero `paidPerWallet`, zeros it, then calls `WETHFallbackLib.safeTransferETHOrWrap(weth, msg.sender, owed)` — which fails because `address(this).balance == 0`: the raw ETH `.call{value: amount}` returns `false` (insufficient balance), then `IWETH(weth).deposit{value: amount}()` reverts with insufficient-funds. The whole refund tx reverts and `paidPerWallet[user]` is rolled back, but the user can never extract their owed amount. The 1-year window is intended to cover lost-key minters, but the contract cannot distinguish "lost key" from "late but legitimate" — it sweeps EVERYTHING. Anyone who refunds at year+1+ε is permanently locked out.

**Attack / Impact:** A minter who submits `refund()` at `cancelledAt + 365 days + 5 minutes` may find their tx mined AFTER the creator's `rescueAfterCancellation()` mined at `cancelledAt + 365 days + 4 minutes`. The minter's refund reverts; their owed ETH is now in the creator's wallet. No grace period, no per-user accounting check — just first-come-first-served on a 1-year boundary.

**Evidence:**
```solidity
// L684-697
function rescueAfterCancellation() external nonReentrant onlyOwner {
    if (mintPhase != MintPhase.CANCELLED) revert SaleNotCancelled();
    if (cancelledAt == 0 || block.timestamp < cancelledAt + POST_CANCEL_RESCUE_DELAY) {
        revert RescueWindowActive();
    }
    uint256 amount = address(this).balance;       // ← sweeps entire balance
    if (amount == 0) revert NothingToRescue();
    WETHFallbackLib.safeTransferETHOrWrap(weth, creator, amount);
    emit PostCancellationRescued(creator, amount);
}

// L668-675 — refund reads paidPerWallet but transfer fails when contract balance is 0
function refund() external nonReentrant {
    if (mintPhase != MintPhase.CANCELLED) revert SaleNotCancelled();
    uint256 owed = paidPerWallet[msg.sender];
    if (owed == 0) revert NothingToRefund();
    paidPerWallet[msg.sender] = 0;
    WETHFallbackLib.safeTransferETHOrWrap(weth, msg.sender, owed);  // ← reverts post-rescue
    ...
}
```

**Recommendation:** Track `unclaimedRefundPool` as a running counter: `+= totalCost` on mint, `-= owed` on refund, `+= 0` on rescue (rescue claims `address(this).balance - unclaimedRefundPool` only). This way, any minter who refunds — even years later — has their owed amount waiting. The rescue takes ONLY the truly residual delta (donations, dust from rounding, stale ERC20 sweeps that aren't tracked). Pattern: Sound Protocol `withdrawETH` after sale tracks per-user owed amounts; Manifold `claimAdmin` requires non-overlapping accounting between user-owed and admin-sweep buckets.

---

## [DEEP-DROP-05] `cancelSale` mid-mint enables refund-arbitrage rug of secondary buyers
**Severity:** Medium
**File:** `contracts/src/TegridyDropV2.sol:658-666`
**Category:** mint

**Bug:** H18 closed the cancel-after-sellout vector but the SAME attack remains viable mid-sale. Once minting starts, NFTs can be transferred or sold on secondary marketplaces. After such a transfer, the original minter still has `paidPerWallet[bob] > 0` (refund right) but no longer holds the token (Carol does). If owner calls `cancelSale()` while `0 < totalSupply < maxSupply`, Bob can `refund()` his original mint cost, while Carol — who holds the actual token — has `paidPerWallet[carol] == 0` (she bought on secondary, not directly from the drop) and gets nothing. Bob's net: original mint-cost refund + secondary-sale proceeds. Carol's net: token in hand, but the drop is dead and the owner cannot deliver any roadmap. This is the canonical "drop rug" — owner cancels mid-drop after collecting secondary royalties.

**Attack / Impact:** Owner launches PUBLIC mint, sells 30% of supply over 2 days. Floor establishes on secondary at 1.5x mint price. Owner triggers `cancelSale()`. Original primary minters refund their 1x cost, having already secondary-flipped at 1.5x — they walk away with 1.5x profit. Secondary buyers hold post-cancel tokens with no roadmap, no team accountability, and no refund right. Owner additionally pockets ERC-2981 royalties on the secondary-market trades that occurred between mint and cancel. Pure rug primitive.

**Evidence:**
```solidity
// L658-666
function cancelSale() external onlyOwner {
    if (mintPhase == MintPhase.CANCELLED) revert SaleCancelled();
    if (withdrawn) revert WithdrawFailed();
    if (maxSupply > 0 && totalSupply >= maxSupply) revert SaleNotCancellable();  // H18 — only blocks at 100%
    mintPhase = MintPhase.CANCELLED;
    cancelledAt = block.timestamp;
    ...
}
```

**Recommendation:** Either (a) require a 7-day public-warning timelock on cancel (announce intent → wait → execute), giving secondary buyers time to react; (b) gate cancel to a much earlier supply threshold (e.g., `totalSupply == 0` only — once any mint has occurred, cancel is impossible), forcing the refund route only via on-chain governance; or (c) add a `propose/execute` cancel pattern symmetric to the merkle-root rotation, with the same 24h delay. Pattern: Zora `ERC721Drop.cancelDrop` requires explicit `onlyOwner + 0 mints + grace period`. Manifold disables cancellation entirely once any token is minted.

---

## [DEEP-DROP-06] `setBaseURI` mutability after partial-pre-reveal mint enables dynamic-trait sniping
**Severity:** Low
**File:** `contracts/src/TegridyDropV2.sol:567-570`
**Category:** mint

**Bug:** Pre-reveal, `tokenURI(id)` returns `_baseTokenURI` for ALL token IDs (placeholder). After `reveal()`, returns `_revealURI || ""`. The owner can call `setBaseURI` AFTER any mint but BEFORE `reveal()` — meaning marketplaces and indexers that cached metadata at mint-time see one placeholder, then a different one. This is documented in the microscope but the SECOND-ORDER bug is: the placeholder mutation happens while the buy/sell-on-placeholder-art market is most active (pre-reveal listings). An owner can `setBaseURI(rareLookingPlaceholder) → wait for floor to spike → setBaseURI(commonLooking) → withdraw secondary royalty proceeds`. Marketplaces have no on-chain immutability guarantee for pre-reveal art.

**Attack / Impact:** Soft-rug primitive. A creator ships a pre-reveal placeholder with hand-drawn high-value art, drives FOMO, watches secondary floor spike, then `setBaseURI` swaps to a generic JPEG. Floor crashes. Creator collects royalty on the high-floor period. Modest impact (placeholders are explicitly mutable by spec) but the contract has no way to commit pre-reveal art immutably even when the creator wants to.

**Evidence:**
```solidity
// L567-570 — no phase gate, no flag, callable anytime
function setBaseURI(string calldata uri) external onlyOwner {
    _baseTokenURI = uri;
    emit BaseURIChanged(uri);
}
```

**Recommendation:** Add an optional `freezeBaseURI()` one-shot setter that, once called, blocks all subsequent `setBaseURI` calls. Also gate `setBaseURI` to `revealed == false` (prevents post-reveal mutations of a vestigial placeholder). Pattern: Sound Protocol `freezeMetadata`; Manifold `freezeBase`. The `revealed` flag isn't enough — pre-reveal mutability is the attack surface.

---

## [DEEP-DROP-07] `currentPrice()` reverts during sequencer outage even outside DUTCH_AUCTION phase via DUTCH branch — but other reads silently succeed (indexer-coherence drift)
**Severity:** Low
**File:** `contracts/src/TegridyDropV2.sol:440-462`
**Category:** other

**Bug:** Confirms M-D2's residual: during an L2 sequencer outage, calling `currentPrice()` while `mintPhase == DUTCH_AUCTION` reverts with `SequencerDown` / `SequencerGracePeriodNotOver`. But `currentPrice()` while `mintPhase` is anything else (CLOSED / ALLOWLIST / PUBLIC) returns `mintPrice` directly, no sequencer check. Indexers that snapshot a drop's price call `currentPrice()`. If the drop is in DUTCH phase during the outage → indexer breaks. If the drop is in PUBLIC phase → indexer succeeds. Two drops on the same factory can return DIFFERENT availability signals to off-chain consumers during the same outage — even though both will block mints (mints check `currentPrice()`). The L2 grace gating is not surfaced uniformly to view consumers.

**Attack / Impact:** Indexer-state drift. Aggregators showing "this DUTCH drop is broken" while "this PUBLIC drop is fine" mislead users into expecting the PUBLIC mints to actually go through — but `mint()` succeeds because no sequencer gate exists on non-DUTCH paths. Conversely, a DUTCH drop that's been live for 3 days is marked "broken" because the price view reverts during a 30-minute outage on day 4. Marketplace pages flicker; users abandon mints; honest creators lose mint volume during outages.

**Evidence:**
```solidity
// L440-462
function currentPrice() public view returns (uint256) {
    if (mintPhase == MintPhase.DUTCH_AUCTION) {
        return _dutchAuctionPrice();  // ← only this path reverts during outage
    }
    return mintPrice;                  // ← no sequencer check; always returns
}

function _dutchAuctionPrice() internal view returns (uint256) {
    SequencerCheck.checkSequencerUp(sequencerFeed, SEQUENCER_GRACE_PERIOD);  // reverts
    ...
}
```

**Recommendation:** Either (a) make `currentPrice()` non-reverting for ALL phases (return a sentinel like `type(uint256).max` during outage and document the semantic; the actual mint-time enforcement still happens inside `mint()`), or (b) move the sequencer gate INTO `mint()` so the view is always indexer-safe and the gating only reverts when funds would actually move. Pattern: Aave V3 `PriceOracleSentinel.isLiquidationAllowed` is a separate non-reverting view consumers can call without burning indexer pipelines.

---

## [DEEP-LP-01] LaunchpadV2 missing `acceptOwnership` cleanup — pending fee/recipient proposals survive ownership handover (M-D3 sibling miss)
**Severity:** Medium
**File:** `contracts/src/TegridyLaunchpadV2.sol:16, 249-290` (no `acceptOwnership` override)
**Category:** gov

**Bug:** TegridyDropV2 was fixed for M-D3 — `acceptOwnership` cancels any in-flight `MERKLE_ROOT_CHANGE` proposal so an outgoing owner cannot booby-trap the incoming owner with a pending hostile root rotation. The same architectural pattern applies to TegridyLaunchpadV2 (which has TWO timelocked propose/execute triplets: `FEE_CHANGE` and `FEE_RECIPIENT_CHANGE`), but the launchpad inherits `OwnableNoRenounce → Ownable2Step.acceptOwnership` directly without overriding. An outgoing owner can propose `pendingProtocolFeeRecipient = attackerWallet`, propose `pendingProtocolFeeBps = 1000` (10%), then `transferOwnership(legitimateBuyer)`. The legitimate buyer accepts ownership without realizing two hostile proposals are queued in storage. After 48 hours, the hostile proposals can execute (now under the new owner's `onlyOwner` privilege) — silently rerouting protocol fees on EVERY future drop deployed off this factory.

**Attack / Impact:** Sale of factory ownership becomes a phishing vector. Outgoing owner queues `pendingProtocolFeeRecipient = phisher.eth`, hands off ownership "clean," collects payment from buyer. New owner discovers 48h later that all collection fees route to the phisher — and only realizes in time to call `cancelProtocolFeeRecipient` if they audit storage on day 1. Higher-value form of M-D3.

**Evidence:**
```solidity
// L16 — inherits Ownable2Step but does not override acceptOwnership
contract TegridyLaunchpadV2 is OwnableNoRenounce, Pausable, TimelockAdmin {
    bytes32 public constant FEE_CHANGE = keccak256("LAUNCHPAD_FEE_CHANGE");
    bytes32 public constant FEE_RECIPIENT_CHANGE = keccak256("LAUNCHPAD_FEE_RECIPIENT_CHANGE");
    ...
}

// Compare TegridyDropV2:705-721 — does override and clears pending merkle root
function acceptOwnership() external {
    if (msg.sender != pendingOwner) revert NotOwner();
    owner = msg.sender;
    pendingOwner = address(0);
    if (_executeAfter[MERKLE_ROOT_CHANGE] != 0) {
        _cancel(MERKLE_ROOT_CHANGE);
        ...
    }
}
```

**Recommendation:** Override `acceptOwnership()` in TegridyLaunchpadV2 to call `_cancel(FEE_CHANGE)` and `_cancel(FEE_RECIPIENT_CHANGE)` (when pending), zero the `pending*` storage, and emit the typed cancellation events. Mirror the DropV2 pattern. Add a Foundry regression test: `test_acceptOwnership_clearsPendingFeeProposals`.

---

## [DEEP-LP-02] LaunchpadV2 `pause` doesn't block `executeProtocolFee` / `executeProtocolFeeRecipient` — emergency lever incomplete
**Severity:** Medium
**File:** `contracts/src/TegridyLaunchpadV2.sol:257-263, 278-284, 292-293`
**Category:** gov

**Bug:** `pause()` sets the OZ Pausable flag, which only the `whenNotPaused` modifier respects. `createCollection` has it (L162). But `executeProtocolFee` (L257), `executeProtocolFeeRecipient` (L278), and the `propose*` siblings do NOT. If a compromised-owner-key incident is detected mid-timelock-window — owner has already proposed a hostile fee 47 hours ago — calling `pause()` does NOT prevent the execute from landing 1 hour later. A guardian's emergency response (pause to halt new deploys, debug, then unpause) is undermined: they pause, but the bad fee still executes during pause. Compare to TegridyFactory.sol's `executeGuardianChange` pattern that does block on pause.

**Attack / Impact:** Compromised-owner-key incidents become irrecoverable within 48h. Whitehat / multisig guardian sees `ProtocolFeeProposed(9999, …)` mid-window, pauses the contract, but cannot stop the execute from landing. Counter-action requires an `onlyOwner` cancel — but owner is the compromised party. Pause is meant to be a cooldown, but it's a no-op for the most dangerous setter sequence.

**Evidence:**
```solidity
// L257-263 — no whenNotPaused
function executeProtocolFee() external onlyOwner {
    _execute(FEE_CHANGE);
    uint16 oldFee = protocolFeeBps;
    protocolFeeBps = pendingProtocolFeeBps;
    pendingProtocolFeeBps = 0;
    emit ProtocolFeeChanged(oldFee, protocolFeeBps);
}

// L278-284 — also no whenNotPaused
function executeProtocolFeeRecipient() external onlyOwner {
    _execute(FEE_RECIPIENT_CHANGE);
    ...
}
```

**Recommendation:** Add `whenNotPaused` to both `executeProtocolFee` and `executeProtocolFeeRecipient`. Optionally also gate the `propose*` siblings behind the same modifier so that pause becomes a true emergency hold on the entire admin surface. Independently, add a guardian-pattern public `cancelAllPendingProposals` function gated to `paused() == true` so that the legitimate counter-action — cancel-and-unpause — doesn't require the (potentially captured) `onlyOwner`.

---

## [DEEP-LP-03] LaunchpadV2 `getAllCollections()` returns unbounded array → indexer DoS at scale (012 L4 unfixed)
**Severity:** Low
**File:** `contracts/src/TegridyLaunchpadV2.sol:244-246`
**Category:** other

**Bug:** Verifies 012 L4 was never closed: `getAllCollections()` returns the entire `address[]` storage array. At 10k+ collections this exceeds typical RPC `max-response-size` ceilings (8MB on Alchemy/Infura), breaking subgraphs and aggregator UIs that depend on the view. Added impact under microscope context: the salt at L184 already uses `allCollections.length`, so a bot motivated to grief the factory could spam thousands of `createCollection` calls (each costing ~700k gas, ~$30 in mainnet conditions) to push the array past the response limit, permanently breaking external integrations that rely on the unbounded view.

**Attack / Impact:** Operational DoS rather than security DoS. A small attacker budget can permanently break every off-chain consumer that depends on the unbounded view, while still allowing the contract to function. Aggregators, mint pages, and analytics dashboards lose visibility into the factory's deployed clones; users have to depend on `CollectionCreated` event indexing only.

**Evidence:**
```solidity
// L244-246
function getAllCollections() external view returns (address[] memory) {
    return allCollections;  // unbounded
}
```

**Recommendation:** Add a paginated `getCollectionsPaginated(uint256 offset, uint256 limit)` view (cap `limit` at 1000 per call, revert or clamp on `offset >= allCollections.length`). Keep the unbounded view but document its scaling limit in NatSpec. Pattern: most production factories (Uniswap V2 `allPairs`, Sudoswap LSSVMPairFactory) ship pagination from day 1.

---

## [DEEP-LP-04] LaunchpadV2 fee execute path is value-unbound — same-block re-propose race after cancel allows fee-version skew
**Severity:** Low
**File:** `contracts/src/TegridyLaunchpadV2.sol:249-269`
**Category:** gov

**Bug:** `executeProtocolFee()` calls `_execute(FEE_CHANGE)` and then sets `protocolFeeBps = pendingProtocolFeeBps`. Unlike DropV2's `executeMerkleRoot(bytes32 expectedRoot)` which takes the expected value as a calldata argument (the value-binding pattern), the launchpad reads `pendingProtocolFeeBps` directly from storage. This is fine in normal flows but fails in the following race: owner proposes fee = 200 bps; 47 hours pass; owner has second thoughts and calls `cancelProtocolFee`; in the SAME tx (multicall), owner re-proposes with `proposeProtocolFee(800)`; `_propose` succeeds (stored = 800, executeAfter = now+48h). But if the owner accidentally calls `executeProtocolFee()` BEFORE the 48h elapses — or worse, if a multisig signer races a different signer's executeProtocolFee with the wrong assumption — the executor sees `pendingProtocolFeeBps == 800` (NOT the value from the original 200 proposal). Without value-binding, the multisig signer cannot prove what they're executing matches what they reviewed.

**Attack / Impact:** Multisig misexecution risk. A signer reviews and approves "execute the 200-bps fee proposal" (because that's what they saw in the proposal event). Between approval and execution, another signer cancels and re-proposes 800. The execution lands with 800, not 200. Signers had no on-chain way to bind their approval to the value they actually approved. Same shape as the lesson DropV2 already learned — `executeMerkleRoot(bytes32 expectedRoot)` exists specifically to bind execution to the expected value.

**Evidence:**
```solidity
// L257-263 — no expectedFee parameter; reads storage directly
function executeProtocolFee() external onlyOwner {
    _execute(FEE_CHANGE);
    uint16 oldFee = protocolFeeBps;
    protocolFeeBps = pendingProtocolFeeBps;  // ← whatever's in storage right now
    ...
}

// Compare TegridyDropV2:525-533 — value-bound execute
function executeMerkleRoot(bytes32 expectedRoot) external onlyOwner {
    require(pendingMerkleRoot == expectedRoot, "ROOT_MISMATCH");
    ...
}
```

**Recommendation:** Refactor to `executeProtocolFee(uint16 expectedFeeBps)` and `executeProtocolFeeRecipient(address expectedRecipient)`, asserting `pendingProtocolFeeBps == expectedFeeBps` / `pendingProtocolFeeRecipient == expectedRecipient` before applying. Mirror the DropV2 pattern. Multisig signers can now bind their approval to the on-chain value.

---

## [DEEP-URI-01] `_jsonEscape` defined but never invoked → forward-looking guard inactive against future string-field additions
**Severity:** Info
**File:** `contracts/src/TegridyTokenURIReader.sol:101-121`
**Category:** other

**Bug:** The H22 fix introduced `_jsonEscape(string)` as a defensive helper for any future string field added to `_buildJSON`. Today, `_buildJSON` only inserts numerics (`tokenId.toString()`, `_formatAmount`, `_boostDisplay`, `_lockStatus` returning constant enum values) and constant string literals — there is no untrusted string input, so the guard is correctly inactive. **But the helper is a footgun in its current form**: a future contributor adding (e.g.) a `string memory ownerHandle` parameter has no compile-time signal that `_jsonEscape` MUST be called; the contract compiles fine without it, and the JSON injection vector reopens silently. Static analysis tooling (Slither) and downstream auditors have no way to flag the omission.

**Attack / Impact:** None today. Future-proofing concern only. If someone adds an attacker-controlled string field without remembering to wrap it in `_jsonEscape`, the metadata can be injected with `","attributes":[<attacker_payload>]` and confuse marketplaces, indexers, or off-chain JSON parsers. The risk is real but conditional on a future PR.

**Evidence:**
```solidity
// L101-121 — defined, but no call site
function _jsonEscape(string memory s) internal pure returns (string memory) {
    bytes memory b = bytes(s);
    bytes memory out = new bytes(b.length * 2);
    ...
}

// L176-194 — _buildJSON inserts only typed numerics; _jsonEscape never called
function _buildJSON(...) internal view returns (string memory) {
    return string.concat(
        '{"name":"tsTOWELI #', tokenId.toString(),
        '","description":"Tegridy Farms staking position. ', _formatAmount(amount), ...
    );
}
```

**Recommendation:** Either (a) remove `_jsonEscape` until a string field is actually added (less code, less surface — and the helper can be re-added in the same PR that introduces the string field), or (b) add a struct-typed builder function `_appendStringAttr(bytes memory buf, string memory key, string memory value)` that ALWAYS routes through `_jsonEscape`, and route every non-numeric attribute through it. Option (b) makes the escape impossible to bypass by future contributors. Pattern: Sound Protocol's `_appendStringAttr` always escapes; Sound's reviewers no longer have to hunt for string-injection sites.

---

## [DEEP-URI-02] `tokenURI` does not call `staking.ownerOf(tokenId)` — EIP-721 violation persists; reader interface still ignores it
**Severity:** Low
**File:** `contracts/src/TegridyTokenURIReader.sol:41-62`
**Category:** erc721

**Bug:** Re-confirms 014 MEDIUM-2: the reader does NOT call `staking.ownerOf(tokenId)` before rendering metadata. `staking.positions(unmintedId)` returns the mapping default (zero struct), and the reader synthesizes a fully-formed JSON for ANY tokenId. EIP-721 requires `tokenURI(_tokenId)` to throw for non-existent NFTs ("MUST throw if `_tokenId` is not a valid NFT"). The reader's interface at L26 declares `function ownerOf(uint256 tokenId) external view returns (address);` — the dependency is acknowledged but never used.

The microscope's H22 fix added defensive bounds checks (`amount <= 1e9 ether`, `boostBps <= 50000`) but did NOT add the existence check. So phishing-via-fake-tokenId remains viable: a scammer crafts a fake marketplace listing for tsTOWELI #999999 (unminted), the reader renders a normal-looking JSON, the buyer believes the position exists.

**Attack / Impact:** Phishing surface. Since the reader is consumed off-chain (frontend, indexers calling directly), and the staking contract's own `tokenURI` doesn't yet route through the reader (per 014 cross-reference), the practical impact is contained to whatever consumer chooses to call `reader.tokenURI(...)`. But once any UI integrates the reader, every unminted ID is a potential phishing target.

**Evidence:**
```solidity
// L41-62
function tokenURI(uint256 tokenId) external view returns (string memory) {
    (
        uint256 amount, , ,
        uint64 lockEnd, uint16 boostBps, uint32 lockDuration,
        bool autoMaxLock, bool hasJbacBoost, , ,
    ) = staking.positions(tokenId);  // ← returns zero-struct for unminted IDs

    // No staking.ownerOf(tokenId) check here
    require(amount <= 1e9 ether, "AMOUNT_OOB");
    require(boostBps <= 50000, "BOOST_OOB");
    ...
}
```

**Recommendation:** Add `try staking.ownerOf(tokenId) returns (address holder) { require(holder != address(0), "NONEXISTENT"); } catch { revert("NONEXISTENT"); }` at the top of `tokenURI`. The `try/catch` shape is needed because OZ ERC721's `ownerOf` reverts on non-existent tokens — wrapping in `try` lets the reader emit a typed revert. Aligns with EIP-721 spec; closes the phishing surface.

---

## [DEEP-URI-03] `_lockStatus` block.timestamp dependency causes single-flip mutation that some indexer caches treat as content-hash drift
**Severity:** Info
**File:** `contracts/src/TegridyTokenURIReader.sol:94-99`
**Category:** other

**Bug:** Confirms H22's residual: `_lockStatus` returns "Active" or "Expired" depending on `block.timestamp >= lockEnd`. The transition is one-shot per position lifetime (deterministic flip at the lockEnd timestamp), but it DOES mutate the JSON output across that single boundary. Indexers and IPFS pinners that hash the encoded data URI to determine "has this metadata changed" will see a hash mutation at exactly one block, then never again. This is bounded — the previous "5d / 12h / 4h / 0h" countdown was unbounded thrash — but content-addressed storage layers (IPFS, Arweave gateways with caching) will treat it as ONE refresh event.

**Attack / Impact:** Minimal. Indexers re-fetch once per position around the lockEnd boundary, then settle. Compared to the pre-H22 unbounded thrash this is a 99.9% improvement. Filed as Info because it's the residual of an otherwise effective fix; documented for future-PR contributors who might be tempted to add additional time-dependent fields ("days remaining," "epoch number," etc.).

**Evidence:**
```solidity
// L94-99
function _lockStatus(uint64 lockEnd, bool autoMaxLock) internal view returns (string memory) {
    if (autoMaxLock) return "Auto-Max";
    if (lockEnd == 0) return "Flexible";
    if (block.timestamp >= lockEnd) return "Expired";  // ← single-flip
    return "Active";
}
```

**Recommendation:** Document in NatSpec that `tokenURI` mutates exactly once per position (at lockEnd) and consumers should plan for it. Optional: emit an off-chain-monitorable event on the staking contract when a position transitions to expired, so indexers can subscribe rather than poll. Lower priority; bounded mutation is broadly acceptable.

---

## Summary

13 NEW findings:
- **High:** 1 (DEEP-DROP-01 — `configureDutchAuction` mid-DUTCH rug)
- **Medium:** 5 (DEEP-DROP-02, DEEP-DROP-04, DEEP-DROP-05, DEEP-LP-01, DEEP-LP-02)
- **Low:** 5 (DEEP-DROP-03, DEEP-DROP-06, DEEP-DROP-07, DEEP-LP-03, DEEP-LP-04, DEEP-URI-02)
- **Info:** 2 (DEEP-URI-01, DEEP-URI-03)

**Highest-leverage fixes:**
1. **DEEP-DROP-01 + DEEP-DROP-02** — phase-gate (or timelock) `configureDutchAuction` AND `setMintPrice`. Single fix family closes the entire instant-setter surface that the microscope flagged for `setMaxPerWallet` and `setMintPrice(0)` but missed for the `setMintPrice(N>0)` and dutch-curve paths. Apply the M-D1 / R023 pattern uniformly: every economically-sensitive setter goes behind a 24h timelock OR a `phase == CLOSED` gate.
2. **DEEP-DROP-04** — switch the rescue accounting to a tracked `unclaimedRefundPool` so the residual sweep can never strand a legitimate late refunder. One storage slot + two adjustments at mint/refund/rescue.
3. **DEEP-LP-01 + DEEP-LP-02** — port the DropV2 `acceptOwnership` cleanup pattern to the launchpad, AND add `whenNotPaused` to all execute paths. Together these turn the launchpad's emergency lever into a real one and close the ownership-handoff phishing window.
4. **DEEP-DROP-05** — the partial-mint cancel rug isn't easily fixable without a design change; recommend a 7-day cancel-intent-then-cancel-execute pattern OR forbid cancel after any mint and rely on the rescue path. Either way, document the current behavior prominently in factory NatSpec so creators know the rug primitive exists by default.
