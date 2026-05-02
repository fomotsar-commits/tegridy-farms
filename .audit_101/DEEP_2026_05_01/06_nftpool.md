# Deep Audit — TegridyNFTPool & TegridyNFTPoolFactory (2026-05-01)

**Scope:**
- `contracts/src/TegridyNFTPool.sol` (792 lines)
- `contracts/src/TegridyNFTPoolFactory.sol` (517 lines)

**Excluded (already reported, not re-listed here):**
- MICROSCOPE H9 (same-block guard on `withdrawETH/withdrawNFTs` — verified shipped at L510, L521)
- MICROSCOPE M-L4 (`proposeSpotPrice` upper bound — verified shipped at L382)
- MICROSCOPE M-L5 (Ownable2Step transfer setter — verified shipped at L415-428)
- MICROSCOPE M-L6 (`createPool` `nonReentrant` — verified shipped at L148)
- MICROSCOPE M-L7 (raw `*` precision — acknowledged unfixed; not re-reported)
- MICROSCOPE M-L8 (`lockEnd == deadline` — lending finding)
- 008/009 H-1 / H-2 / H-3 / M-1..6 (already filed and triaged)

---

## [DEEP-NFTPOOL-01] Sandwich-on-Quote: spotPrice mutates BEFORE NFT solvency check on buy
**Severity:** High
**File:** `contracts/src/TegridyNFTPool.sol:236-264`
**Category:** mev

**Bug:** In `swapETHForNFTs`, the buyer's price is locked in via `_getBuyPrice(numItems)` (which reads `spotPrice` at call time), then `spotPrice += delta * numItems` is committed **before** any NFT is verified to be in `_heldIds`. If the buyer passes any tokenId that was withdrawn by a sandwich-front-runner (or sniped by an earlier same-block transaction sliding in via mempool reordering), the loop reverts at `revert NFTNotHeld(tokenId)`, but only AFTER the curve has been re-priced. That isn't exploitable because of the revert rollback — however, the reversed-roles attack IS exploitable: a malicious owner observing a buy in the mempool can call `withdrawNFTs([rareId])` in the same block. Although `block.number <= lastSwapBlock` guards same-block withdrawals AFTER swaps land, it does NOT guard a withdrawal that lands EARLIER in the same block (when `lastSwapBlock` is from an older block). The owner withdraws the rare ID before the pending buy is mined; the buy reverts; the owner profits by selling out-of-pool. This is the inverted-sandwich form — the same-block guard is one-directional.

**Attack / Impact:** Owner observes pending `swapETHForNFTs([rareId, …], maxCost=1.0e)` in the mempool. Owner submits `withdrawNFTs([rareId])` with higher gas. Both land in the same block. The withdrawal lands first; the buyer's swap then reverts on `NFTNotHeld(rareId)`; buyer pays only gas. Meanwhile owner has a fresh rare NFT they just extracted from the pool at zero cost (no pricing). Repeat this whenever an LP-owner sees a pending buy that targets specific IDs they would prefer to sell off-pool at a higher price.

**Evidence:**
```solidity
// L520-528
function withdrawNFTs(uint256[] calldata tokenIds) external onlyOwner nonReentrant {
    if (block.number <= lastSwapBlock) revert WaitOneBlock();
    // ^ This only blocks AFTER a swap in the SAME block. If no swap has
    //   landed yet in this block, lastSwapBlock < block.number and the
    //   withdrawal proceeds — front-running the pending buy.
```

**Recommendation:** Add a forward-direction guard: track `lastWithdrawBlock` and reject swap calls when `block.number == lastWithdrawBlock` to prevent owner-extracts-then-buyer-quote-mismatch. Or more cleanly, gate `withdrawNFTs/withdrawETH/removeLiquidity` to require a **commit-then-execute** pattern: the owner declares intent to withdraw N blocks earlier, swappers see the impending withdrawal in advance and can choose not to submit. Pattern: Sudoswap V2 LSSVMPair lock during swap window.

---

## [DEEP-NFTPOOL-02] proposeFeeChange / proposeDelta missing MAX_SPOT_PRICE-style replace-protection
**Severity:** Medium
**File:** `contracts/src/TegridyNFTPool.sol:375-406, 432-459, 468-494`
**Category:** other

**Bug:** Three timelocked propose functions (`proposeSpotPrice`, `proposeDelta`, `proposeFeeChange`) all unconditionally overwrite their pending state and reset `*ExecuteAfter = block.timestamp + PARAMETER_TIMELOCK`. There is NO check for `pendingXExecuteAfter == 0` before re-proposing. This silently extends the "hidden change" window indefinitely — the owner can propose, wait 23h59m, re-propose the same change to reset to 24h, and integrators who set up alerts on the original `*ChangeProposed` event get no signal that the timelock just slipped another 24 hours. This contradicts the explicit pattern in `TimelockAdmin._propose` (line 66): `if (_executeAfter[key] != 0) revert ExistingProposalPending(key);` — the factory enforces this discipline, but the pool inlines a parallel timelock that doesn't.

**Attack / Impact:** Indefinite governance-attack window (no DoS, but undermines the timelock signal). 008 audit doc M-1 flagged the spotPrice variant; this finding adds that the same flaw exists for delta and fee. A signaling-failure: indexers cannot reliably alert LPs/swappers because the `proposed` event repeats stale information.

**Evidence:**
```solidity
// L375 (proposeSpotPrice) — no check for pending != 0
function proposeSpotPrice(uint256 newPrice) external onlyOwner {
    if (newPrice == 0) revert InvalidPrice();
    if (newPrice > MAX_SPOT_PRICE) revert SpotPriceTooHigh();
    pendingSpotPrice = newPrice;
    pendingSpotPriceExecuteAfter = block.timestamp + PARAMETER_TIMELOCK; // resets timer
    emit SpotPriceChangeProposed(spotPrice, newPrice, pendingSpotPriceExecuteAfter);
}

// L434 (proposeDelta) — same omission
function proposeDelta(uint256 newDelta) external onlyOwner {
    if (newDelta > MAX_DELTA) revert DeltaTooHigh();
    pendingDelta = newDelta;
    pendingDeltaExecuteAfter = block.timestamp + PARAMETER_TIMELOCK;
    emit DeltaChangeProposed(delta, newDelta, pendingDeltaExecuteAfter);
}

// L468 (proposeFeeChange) — same omission
function proposeFeeChange(uint256 newFee) external onlyOwner {
    if (poolType != PoolType.TRADE) revert PoolTypeMismatch();
    if (newFee > MAX_FEE_BPS) revert InvalidFee();
    pendingFeeBps = newFee;
    pendingFeeBpsExecuteAfter = block.timestamp + PARAMETER_TIMELOCK;
    emit FeeChangeProposed(feeBps, newFee, pendingFeeBpsExecuteAfter);
}
```

**Recommendation:** Mirror `TimelockAdmin._propose`'s replace-protection. Each propose function should require `pendingXExecuteAfter == 0` and revert with `ExistingProposalPending`, OR emit a separate `ProposalReplaced` event so off-chain consumers can detect timer resets. Reference: `contracts/src/base/TimelockAdmin.sol:66`. Single-line fix per function.

---

## [DEEP-NFTPOOL-03] proposeOwnerChange has no timelock — instant first-class-key transfer
**Severity:** Medium
**File:** `contracts/src/TegridyNFTPool.sol:415-428`
**Category:** other

**Bug:** Ownable2Step was correctly added per MICROSCOPE M-L5, but `proposeOwnerChange` allows the current owner to nominate `pendingOwner` instantly. The new owner can call `acceptOwnership()` in the next block. No timelock, no event-then-delay window. Every other parameter change on this pool (spotPrice, delta, feeBps) has a 24-hour PARAMETER_TIMELOCK; the owner field — which controls all those setters AND `withdrawETH`/`withdrawNFTs`/`pause`/`syncNFTs` — has zero. A compromised owner key can transfer ownership to the attacker in two transactions executed in adjacent blocks, bypassing the entire timelock surface. The factory protects its own owner change via `OwnableNoRenounce` + 48h `TimelockAdmin`-style flows for fee/recipient — but the per-pool owner change is unguarded.

**Attack / Impact:** Key compromise → instant pool capture. With ownership flipped, attacker can call `withdrawETH(balance - accumulatedProtocolFees)` after the next swap to drain the pool, OR `pause()` the pool to lock LP value pending negotiation. The 24-hour timelocks on price/delta/fee/spotprice are entirely defeated because the attacker can transfer the whole owner role to a fresh address that the defenders' on-chain incident response has not yet flagged.

**Evidence:**
```solidity
// L415-428 — no timelock, no propose/execute split for owner transfer
function proposeOwnerChange(address newOwner) external onlyOwner {
    pendingOwner = newOwner;
    emit OwnerChangeProposed(owner, newOwner);
}

function acceptOwnership() external {
    if (msg.sender != pendingOwner || msg.sender == address(0)) revert NotPendingOwner();
    address oldOwner = owner;
    owner = pendingOwner;
    pendingOwner = address(0);
    emit OwnerChanged(oldOwner, owner);
}
```

**Recommendation:** Add a 48-hour timelock between `proposeOwnerChange` and `acceptOwnership` (canonical industry rate for ownership rotation: OZ TimelockController, Compound). Define `pendingOwnerExecuteAfter = block.timestamp + 48 hours`; require `block.timestamp >= pendingOwnerExecuteAfter` in `acceptOwnership`. Alternative: add a guardian veto window where the factory can cancel a malicious in-flight ownership rotation.

---

## [DEEP-NFTPOOL-04] proposeOwnerChange to address(0) bypasses NotPendingOwner — silent cancel only
**Severity:** Low
**File:** `contracts/src/TegridyNFTPool.sol:415-428`
**Category:** other

**Bug:** `proposeOwnerChange(address(0))` is accepted with no check, setting `pendingOwner = address(0)`. The natspec at L414 says "address(0) cancels a pending transfer," but this is undocumented behavior with footguns: (a) calling with zero on a pool that has no pending transfer emits a misleading `OwnerChangeProposed(owner, address(0))` event, (b) a single typo (e.g., owner intended `0x0001…` but submitted `0x0000…`) silently cancels. Compare to OZ Ownable2Step which uses an explicit `_transferOwnership(address(0))` for cancellation and emits a typed `OwnershipTransferStarted(address(0))`. The pool's silent-cancel-via-zero pattern is unconventional.

**Attack / Impact:** Operator confusion / signal pollution. Not directly exploitable, but makes incident-response logs ambiguous: monitoring tools cannot distinguish "owner intended a deliberate cancel" vs. "owner mis-typed a pending transfer." Multisig dashboards that aggregate `OwnerChangeProposed` events will fire alerts on cancellation events.

**Evidence:**
```solidity
// L415-418 — no validation, no separate cancel function
function proposeOwnerChange(address newOwner) external onlyOwner {
    pendingOwner = newOwner;  // Accepts address(0) silently
    emit OwnerChangeProposed(owner, newOwner);
}
```

**Recommendation:** Add an explicit `cancelOwnerChange()` that emits `OwnerChangeCancelled` and reject `proposeOwnerChange(address(0))` with `ZeroAddress`. Mirror the explicit cancel pattern used for spotPrice/delta/fee changes elsewhere in this contract.

---

## [DEEP-NFTPOOL-05] LP fees never claimable in TRADE pools after ownership transfer — silently captured by new owner
**Severity:** High
**File:** `contracts/src/TegridyNFTPool.sol:697-706, 737-746, 415-428, 502-528`
**Category:** other

**Bug:** TRADE pools collect a per-swap LP fee (`baseCost * feeBps / BPS` on buys; `basePayout * feeBps / BPS` on sells). The fee is added to `inputAmount` (charged to buyer) or subtracted from `outputAmount` (deducted from seller payout) — but it is NOT separately accounted. The fee just stays in `address(this).balance`. The ONLY paths to extract that ETH are `withdrawETH()`, `removeLiquidity(_, ethAmount)`, and `withdrawProtocolFees()` (the protocol's slice). All of these are `onlyOwner`. When ownership transfers via `proposeOwnerChange` → `acceptOwnership`, the new owner inherits the entire pool balance, including all historical LP fees the previous LP earned. There is no escrow, no fee snapshot at transfer time, no "rotate the LP key but keep the proceeds" pattern. A pool sale through ownership transfer (or a key rotation post-incident) silently transfers all undistributed LP-fee revenue.

**Attack / Impact:** Old LP loses unclaimed fees on transfer. In a single-LP pool this is just a UX issue — the seller of a pool position should have been told to first call `removeLiquidity` to harvest fees. But with ownership being transferable instantly (DEEP-NFTPOOL-03) and LP-fee accrual being the entire economic incentive of a TRADE pool, a misbehaving counterparty in an OTC pool sale could withhold the previous owner's fees. Worse, since `lpFee` is mathematically commingled with the pool's working ETH balance, even an honest new owner can't reconstruct what portion was the previous LP's accrued reward without re-replaying every historical swap event off-chain.

**Evidence:**
```solidity
// L699-700 — LP fee is added to inputAmount, paid by buyer, lands in pool balance
if (poolType == PoolType.TRADE && feeBps > 0) {
    lpFee = baseCost * feeBps / BPS;
}
// ...
// L706
inputAmount = baseCost + lpFee + protocolFee;
// ↑ buyer sends inputAmount; protocolFee goes to accumulatedProtocolFees;
//   lpFee silently lands in balance — no accounting variable.
```

There is no `accumulatedLPFees` storage slot. Grep confirms zero references in source.

**Recommendation:** Track `accumulatedLPFees` as a separate state variable. On every buy/sell, `accumulatedLPFees += lpFee`. Provide a `claimLPFees()` function gated to a separate `lpFeeRecipient` address (settable at init, optionally rotatable via timelock). On `acceptOwnership`, snapshot `accumulatedLPFees` into a vested-to-prior-owner escrow. Pattern: Uniswap V3 PositionManager's `collect()` is gated to `ownerOf(positionId)` at the moment of collection, but the crucial difference is that V3 fees-owed are tracked per-position. Single-owner Sudoswap-style pools should at minimum snapshot the LP earnings at owner transfer.

---

## [DEEP-NFTPOOL-06] swapNFTsForETH: spotPrice committed BEFORE NFT transfer — LP fee math correct only if all transfers succeed
**Severity:** Medium
**File:** `contracts/src/TegridyNFTPool.sol:300-322`
**Category:** math

**Bug:** Sequence of operations in `swapNFTsForETH`:
```
L297: (outputAmount, protocolFee) = _getSellPrice(numItems);  // reads current spotPrice
L301: spotPrice -= delta * numItems;                          // commits new spotPrice
L304-306: for each tokenId: nftCollection.safeTransferFrom(seller, this, ...);
```
If the seller passes a tokenId they don't actually own (or that has approval issues), the `safeTransferFrom` reverts. Solidity rolls back ALL state including `spotPrice`. **Not exploitable on this path alone**, but combined with `onERC721Received` (L656-672) which gates `operator == owner || self || factory`, a seller calling `swapNFTsForETH` triggers `safeTransferFrom(seller, this, …)` where the operator is `address(this)` and the from is `seller`. The current allow-list at L666 is `operator == owner || operator == address(this) || operator == factory`, so this works. **However**, the `from` field is `seller`, not `address(this)` — and the receiver hook check at L666 only validates `operator`, not `from`. If a buggy ERC721 implementation sends the operator field as the from (some legacy Yul-based ERC721s do this), `operator == seller` and the check fails — bricking sells for that NFT collection. This is collection-specific risk; it's a real DoS surface for non-canonical ERC721s.

Additionally, the NEW-L4 syncNFTs path (L540-555) has a subtle timing bug: an attacker can `transferFrom` (non-safe) a malicious NFT to the pool at any time, then if `nftCollection.ownerOf(tokenId)` returns `address(this)` later, `syncNFTs` will accept it. But syncNFTs is `onlyOwner` so the attacker can't trigger it; this is benign. The real issue is that 008 H-3 (already filed) covers the equivalent griefing path.

**Attack / Impact:** Specific ERC721 collections with non-standard `safeTransferFrom` calldata (where the recipient sees `operator == from`) cannot be traded — sells revert with `UNAUTHORIZED_DEPOSIT`. This is a hidden compatibility constraint not documented anywhere. Some NFT collections will silently fail to integrate.

**Evidence:**
```solidity
// L666
require(operator == owner || operator == address(this) || operator == factory, "UNAUTHORIZED_DEPOSIT");
// ↑ For seller-initiated swapNFTsForETH, operator IS address(this) (correct).
//   But for collections where the ERC721 implementation calls
//   safeTransferFrom(from, to, id) and forwards from-as-operator, this fails.
```

**Recommendation:** Loosen the deposit gate to also accept the case where the from-address is the seller during an active swap. Use a transient flag (`bool internal _swapInFlight`) set at swap entry, cleared at swap exit, and accepted as a deposit gate. Pattern: Uniswap V3 callbacks use `address(this) == amount0Owed_payer` checks for similar.

---

## [DEEP-NFTPOOL-07] _getSellPrice DoS via address(this).balance check — donation-blocking-sells griefer
**Severity:** Medium
**File:** `contracts/src/TegridyNFTPool.sol:751-754`
**Category:** dos

**Bug:** `_getSellPrice` reads `address(this).balance` directly to verify pool solvency. Combined with `getSellQuote` (a `view` function at L590-592) being a thin wrapper, **any caller can grief the quote function** by donating ETH or by `selfdestruct`-ing into the pool (legacy chains pre-Cancun). The donation enriches the LP — but it also affects the formula's `availableETH`, which is `balance - accumulatedProtocolFees`. After a donation, the pool **reports a higher availableETH than the actual LP earnings** — but the bigger issue is that `_getSellPrice` REVERTS when `availableETH < outputAmount + protocolFee`. So if a seller's expected payout is greater than the actual ETH stored, the quote reverts entirely (code smell flagged in 008 M-3). The NEW finding is that combined with **DEEP-NFTPOOL-05** (LP fees commingled with balance), a malicious owner who pulls all withdrawable ETH via `withdrawETH` right before a victim's pending sell — leaving only the protocol-fee accumulator — DOS'es every subsequent sell by reverting at L754 with `POOL_INSUFFICIENT_ETH`. The 24h timelock on price/delta does nothing; this is an instant griefing vector via owner withdrawal.

**Attack / Impact:** Owner monitoring mempool sees pending `swapNFTsForETH(…, minOutput=X)`. Owner submits `withdrawETH(balance - accumulatedProtocolFees - 1 wei)` (legal — passes balance check at L511) with higher gas. Both transactions land in same block; withdrawal lands first (after `lastSwapBlock` check passes since no sell yet). Victim's sell now reverts on `POOL_INSUFFICIENT_ETH` — they pay gas and got nothing. Owner can then re-deposit the ETH at a lower price-time to absorb the now-cheaper NFT (since spotPrice is unchanged but seller has been forced off-market).

The same-block guard at L510 only blocks withdrawals AFTER swaps in the same block; it does NOT prevent withdrawal-then-sell DoS within a single block where the withdrawal lands first.

**Evidence:**
```solidity
// L509-514 (withdrawETH)
function withdrawETH(uint256 amount) external onlyOwner nonReentrant {
    if (block.number <= lastSwapBlock) revert WaitOneBlock();
    require(amount > 0 && address(this).balance - accumulatedProtocolFees >= amount, "INVALID_AMOUNT");
    _sendETH(msg.sender, amount);
    emit ETHWithdrawn(msg.sender, amount);
}

// L754 (in _getSellPrice)
require(availableETH >= outputAmount + protocolFee, "POOL_INSUFFICIENT_ETH");
```

**Recommendation:** Either (a) gate `withdrawETH/removeLiquidity` to leave a minimum-liquidity buffer of `expected_max_sell_payout` worth of ETH, or (b) move solvency checks to the swap function (not the quote), so quotes always succeed and only actual swaps revert on insolvency. Pattern: Uniswap V3 separates `quoteExactInput` (never reverts) from `swap` (does). Better: stop reading `address(this).balance` for solvency and instead track `lpEthBalance` explicitly on every withdraw / refund / fee accrual.

---

## [DEEP-NFTPOOL-08] receive() accepts ETH but does not stamp lastSwapBlock — donations bypass MEV guard
**Severity:** Low
**File:** `contracts/src/TegridyNFTPool.sol:675`
**Category:** mev

**Bug:** The pool's `receive() external payable {}` at L675 accepts ETH from any caller. The factory uses this to deposit initial liquidity at L193. After init, it remains open — a buyer could send ETH directly to the pool to "tip" the LP. This bypasses the bonding curve. The same-block guard at `withdrawETH/withdrawNFTs/removeLiquidity` is keyed on `lastSwapBlock`, which is only updated by `swapETHForNFTs` and `swapNFTsForETH` (L264, L319). A donation-via-receive doesn't update `lastSwapBlock`, so an MEV bot can: (a) front-run a sandwich by donating ETH to the pool (pool now has more ETH for sells), (b) own block, observe sells profit at the inflated payout, (c) `withdrawETH` immediately AFTER (in a non-swap-touched block), capturing the donation as "free LP yield" before legitimate LPs notice. Combined with DEEP-NFTPOOL-05, the donation is silently captured by whoever the current owner is.

**Attack / Impact:** A sophisticated MEV searcher can use the open `receive` for cross-pool MEV — sending ETH into a pool to manipulate the per-NFT sell price perception (since the protocol-fee accumulator and the LP balance are commingled). While the bonding curve itself is not affected, view-function consumers (any router doing `getSellQuote` then sending users) could be fooled by a transient balance bump. Lower severity because the bonding curve formula doesn't read `address(this).balance` for the price (only for solvency), but the donation→withdraw pattern is the textbook donation-attack-on-share-price equivalent without LP shares — captured by single-LP ownership.

**Evidence:**
```solidity
// L675 — accepts arbitrary ETH from anyone
receive() external payable {}
// ↑ No source-restriction, no event, no lastSwapBlock update.
```

**Recommendation:** Either (a) restrict `receive` to `msg.sender == factory` (only initial-liquidity deposits via factory call), or (b) emit a `Donation(from, amount)` event for observability, or (c) update `lastSwapBlock` to `block.number` whenever ETH lands — turns donations into MEV-equivalent state transitions. Option (a) is cleanest; option (c) gives strongest MEV resistance.

---

## [DEEP-NFTPOOL-09] Factory createPool: chainid not in salt despite MICROSCOPE M-L6 fix narrative
**Severity:** Medium
**File:** `contracts/src/TegridyNFTPoolFactory.sol:164-167`
**Category:** other

**Bug:** Audit 009 M-1 flagged that `salt` lacks `block.chainid` and `address(this)`. Verifying the current source: lines 164-167 read:
```solidity
bytes32 salt = keccak256(
    abi.encodePacked(msg.sender, _allPools.length, nftCollection, uint8(_poolType))
);
```
**chainid and address(this) are still missing.** The MICROSCOPE M-L6 narrative on line 132 says "M-L6: nonReentrant added" — yes, that was added. But M-1 from 009 (separate finding, salt collision) was NOT closed. On L2 deployments where the factory is at the same address (common for cross-chain CREATE2 deployments), an attacker on chain A can predict and front-run an honest deploy on chain B by calling createPool first with the same `(msg.sender, counter, collection, poolType)` tuple. This was identified in 009 audit M-1 but appears unfixed.

**Attack / Impact:** Cross-chain DoS for predictable pools. On a multi-chain deployment, any attacker who knows Alice's deploy address can front-run on the other chain by computing the same salt tuple. This was already documented but not fixed; flagging here as `unfixed-and-still-relevant` for the deep-audit-pass tracking.

**Evidence:**
```solidity
// TegridyNFTPoolFactory.sol L164-167
bytes32 salt = keccak256(
    abi.encodePacked(msg.sender, _allPools.length, nftCollection, uint8(_poolType))
);
// MISSING: block.chainid, address(this)
```

**Recommendation:** Per 009 M-1: add `block.chainid` and `address(this)` to the salt mix. Single-line fix:
```solidity
bytes32 salt = keccak256(
    abi.encodePacked(block.chainid, address(this), msg.sender, _allPools.length, nftCollection, uint8(_poolType))
);
```

---

## [DEEP-NFTPOOL-10] Factory withdrawProtocolFees: no per-call cap — full balance siphon if recipient compromised
**Severity:** Low
**File:** `contracts/src/TegridyNFTPoolFactory.sol:509-513`
**Category:** other

**Bug:** `withdrawProtocolFees` sends the **entire** factory ETH balance to `protocolFeeRecipient` in one call. This is gated by `onlyOwner` and `nonReentrant`, but combined with the 48-hour timelock on `protocolFeeRecipient` change (line 421) being the ONLY guard rotation, the worst-case is: (a) recipient key is compromised, (b) attacker holds the recipient role for 48 hours, (c) during that window, every accumulated protocol fee in the factory is drainable. Compare to DAO best-practice (Compound, MakerDAO): scheduled fee disbursements with a per-call cap, plus a separate "rescue" path for emergency withdrawal that is itself timelocked.

**Attack / Impact:** Single-shot recipient-key compromise drains all accumulated protocol fees from all pools. While the recipient is itself meant to be a multisig/treasury (operational mitigation), the lack of in-contract rate limit means a recipient compromise during the timelock window is catastrophic.

**Evidence:**
```solidity
// L509-513
function withdrawProtocolFees() external onlyOwner nonReentrant {
    uint256 balance = address(this).balance;
    require(balance > 0, "NO_FEES");
    WETHFallbackLib.safeTransferETHOrWrap(weth, protocolFeeRecipient, balance);
}
// ↑ No partial-withdraw, no per-call cap, no rate limit.
```

**Recommendation:** Add `withdrawProtocolFees(uint256 amount)` overload with a `MAX_DAILY_WITHDRAWAL` rate-limit (storage slot tracking last-day-withdrawn). Defense-in-depth against compromised recipient.

---

## [DEEP-NFTPOOL-11] Factory: claimPoolFees / claimPoolFeesBatch emit no factory-level event for monitoring
**Severity:** Low
**File:** `contracts/src/TegridyNFTPoolFactory.sol:476-503`
**Category:** other

**Bug:** Both `claimPoolFees(pool)` (single) and `claimPoolFeesBatch(pools[])` (batch) call into `pool.claimProtocolFees()` and forward ETH back to the factory, but emit NO factory-level event. The 009 audit doc L-7 already flagged this. In a multi-pool ecosystem, observability for "fee flows from pools into the factory" is critical for treasury accounting and abuse detection. Without factory-level events, monitoring requires subscribing to all `ProtocolFeePaid` events on every pool individually — fragile and breaks on RPC pagination limits.

**Attack / Impact:** Observability gap, not directly exploitable but operationally weakens fee-flow auditing for the protocol team. Not previously fixed.

**Evidence:**
```solidity
// L476-479
function claimPoolFees(address pool) external nonReentrant {
    if (!isPool[pool]) revert NotAPool(pool);
    TegridyNFTPool(payable(pool)).claimProtocolFees();
    // ↑ No event emitted from factory side.
}

// L497-503
function claimPoolFeesBatch(address[] calldata pools) external nonReentrant {
    for (uint256 i = 0; i < pools.length; i++) {
        address pool = pools[i];
        if (!isPool[pool]) revert NotAPool(pool);
        try TegridyNFTPool(payable(pool)).claimProtocolFees() {} catch {}
        // ↑ Failures silently swallowed AND no event for either success or failure.
    }
}
```

**Recommendation:** Add `event PoolFeesClaimed(address indexed pool, uint256 amount)` and emit on each successful claim. Read `address(this).balance` before/after the inner call to derive the per-pool delta. For the batch variant, also emit `event PoolFeesClaimFailed(address indexed pool, bytes reason)` on the catch path so silent failures become observable.

---

## [DEEP-NFTPOOL-12] Factory pause does not pause individual pools — pause-decoupling
**Severity:** Medium
**File:** `contracts/src/TegridyNFTPoolFactory.sol:453-460` × `contracts/src/TegridyNFTPool.sol:559-565`
**Category:** other

**Bug:** Both factory and pool implement `pause()`. They are **independent** — pausing the factory only blocks `createPool`. It does NOT cascade to existing pools. Each pool's pause is entirely controlled by the per-pool `owner` (a different actor than the factory owner, typically the pool's LP). In an emergency where a critical bug is discovered in the pool implementation, the factory-owner has NO mechanism to pause all in-flight pools. They have to socially coordinate with every pool LP to call `pause()` — a coordination problem that scales linearly with pool count. Compare to the Sudoswap V2 pattern, where the factory has emergency `forceFunctionDisable(selector)` over all pools.

**Attack / Impact:** In an exploit-discovery scenario, the factory owner cannot freeze active pools to prevent ongoing exploitation. Live pools continue running until each LP independently pauses. For a critical bug in the bonding-curve math or `_sendETH` path, exploitation between bug-discovery and full-LP-coordination is unbounded.

**Evidence:**
```solidity
// Factory pause at L453-460 — only stops createPool
function pause() external onlyOwner {
    _pause();
}
function unpause() external onlyOwner {
    _unpause();
}

// Pool pause at L559-565 — only stops swapEthForNFTs/swapNFTsForETH for THAT pool, called by THAT pool's owner
function pause() external onlyOwner {
    _pause();
}
```

**Recommendation:** Add a factory-level emergency override: `setEmergencyPaused(bool)` on the factory, gated by factory owner with 6-hour minimum delay (or guardian role). When set, pools query factory state at swap entry and revert. Add to swap functions:
```solidity
if (TegridyNFTPoolFactory(factory).emergencyPaused()) revert EmergencyPaused();
```
This converts the factory's pause from a one-trick `createPool` block into a real circuit breaker. Pattern: Aave V3 PoolConfigurator emergency admin.

---

## Summary — counts and prioritization

- **High:** 2 (DEEP-NFTPOOL-01 owner-front-run-via-withdrawNFTs; DEEP-NFTPOOL-05 LP-fee theft on transfer)
- **Medium:** 5 (DEEP-NFTPOOL-02, 03, 06, 07, 09, 12)
- **Low:** 4 (DEEP-NFTPOOL-04, 08, 10, 11)

**Top-3 deploy-blockers for the deep pass:**
1. **DEEP-NFTPOOL-05** — LP fee theft is the highest economic-impact finding; affects every TRADE pool with fee accruals at owner-rotation time.
2. **DEEP-NFTPOOL-03** — Owner-change has no timelock, defeating the entire 24h-timelock surface on price/fee/delta upon owner key compromise.
3. **DEEP-NFTPOOL-01** — Same-block-guard direction asymmetry (`withdrawNFTs` can land BEFORE a swap but the guard only checks the AFTER direction).

**Highest-leverage single fix:** Add a forward-direction same-block guard via `lastWithdrawBlock` state variable, combined with making owner-change timelocked (closes DEEP-NFTPOOL-01 and DEEP-NFTPOOL-03 in one PR).

**Cross-cutting observation:** The MICROSCOPE pass identified the "half-installed mitigation" pattern (M-30 / R014 sibling miss). DEEP-NFTPOOL-01, 02, 09 are continuing instances of that pattern: a guard added at one call site but not at its mirror.
