# Agent 008 — TegridyNFTPool.sol Forensic Audit

**Target:** `contracts/src/TegridyNFTPool.sol` (688 lines)
**Tests cross-checked:** `TegridyNFTPool.t.sol`, `TegridyNFTPool_Reentrancy.t.sol`, `TegridyNFTPool_Sandwich.t.sol`
**Date:** 2026-04-25
**Mandate:** Hunt deposit→swap dilution, sandwich, donation, ID collision, redeem race, royalty bypass, ERC721 receiver hook reentrancy, randomness, lazy-mint forgery, missing pause, owner-set fee front-run.

---

## SUMMARY COUNTS

| Severity | Count |
|---|---|
| HIGH | 3 |
| MEDIUM | 6 |
| LOW | 5 |
| INFO | 4 |
| Test gaps | 7 |

---

## HIGH

### H-1 — Rarity sniping via buyer-chosen tokenIds at uniform bonding-curve price
**Location:** `swapETHForNFTs` (L184–224)
**Issue:** The bonding-curve price is computed solely from `numItems` (`numItems * spotPrice + delta*N*(N-1)/2`). Buyer freely chooses *which* `tokenIds` to extract from the pool. There is no concept of per-token rarity premium. An attacker monitors mempool and floor-sweep contracts, then targets only the rarest IDs at the same flat price as floor IDs. LP receives floor-priced ETH while losing rare items.
**Impact:** LP economic loss (silent value extraction, not detected by slippage on either side). This is the same flaw Sudoswap V1 had until v2 introduced per-token bidding/asks and was the headline attack in early NFT AMM history.
**Mitigation candidates:**
- Allow LP to set a per-tokenId floor premium (mapping override); or
- Force `tokenIds` to be a contiguous slice from `_heldIds[]` (random assignment), preventing cherry-pick; or
- Document loudly that pools should hold homogeneous-rarity collections only.
**Test gap:** No test simulates an attacker filtering for high-rarity IDs.

### H-2 — `swapNFTsForETH`: spotPrice updates BEFORE NFT transfers, allowing a malicious ERC721 to mismatch
**Location:** L247–253
**Issue:** State change ordering:
```
spotPrice -= delta * numItems;          // L248
for (...) safeTransferFrom(seller, ...) // L252
```
A malicious ERC721 collection (or a hook in a callbacked variant) whose `safeTransferFrom` reverts on the *last* item leaves all earlier items already transferred, but since the loop reverts mid-flight via Solidity revert semantics, all state rolls back. **However**, if this contract is ever paired with an ERC721 that has hooks executed after some state updates, the `spotPrice` change is committed before NFTs land and `_addHeldId` runs in `onERC721Received`. The `nonReentrant` guard prevents re-entry into THIS pool, but a malicious ERC721 could re-enter `factory.claimPoolFees(this)` (no nonReentrant on factory side?) or another pool sharing the same collection. The factory-level claim path needs verification — out of scope for this file but flagged.
**Recommend:** Move `spotPrice -=` to AFTER all NFT transfers complete. Symmetric for `swapETHForNFTs` already does NFTs after spot update — also worth re-ordering for CEI hygiene.
**Test gap:** No malicious-ERC721 test for swapNFTsForETH; existing `MaliciousNFTReceiver` only tests buy path.

### H-3 — `syncNFTs` is exploitable for "donation attack" replacement
**Location:** L436–451
**Issue:** Owner can call `syncNFTs([id])` after a *different* user accidentally `transferFrom`s their NFT to the pool (mistakenly). The original user has no recovery path — owner now owns the NFT inside the pool's accounting and can `withdrawNFTs` to themselves. While the transfer was the user's mistake, there's no rescue/refund path. In a Sudoswap-style protocol the convention is mistakenly-transferred assets are recoverable via signed admin tx with proof of original sender. Here it's a quiet rugpull-by-mistake.
**Impact:** Permanent loss of any NFT mistakenly transferred (not via `safeTransferFrom`) to the pool address.
**Mitigation:** Emit a `StrandedNFTRecovered(originalSender, tokenId)` event with the ERC721 transfer-event-decoded sender, and gate `syncNFTs` to require the original sender to call (read past Transfer events on-chain is hard — alternative: factory-controlled rescue with timelock).
**Test gap:** `test_NEWL4_syncNFTsRecoversUnsafeTransfer` confirms the BEHAVIOR but does not flag the trust assumption.

---

## MEDIUM

### M-1 — Owner sandwich via timelocked spotPrice change is mitigated, BUT pendingSpotPriceExecuteAfter check on `proposeSpotPrice` is missing — owner can re-propose to RESET the timer
**Location:** L309–314
**Issue:** `proposeSpotPrice` unconditionally overwrites `pendingSpotPrice` and resets `pendingSpotPriceExecuteAfter = block.timestamp + 24h`. There is no event or external visibility that an attacker has noticed the impending change and the owner just kicked the can. While timelock is preserved, observability for swappers/LPs is poor.
**Severity:** MEDIUM — pollutes governance signal but doesn't bypass timelock.
**Mitigation:** Require `pendingSpotPriceExecuteAfter == 0` in `proposeSpotPrice`, OR emit a separate `SpotPriceProposalReplaced` event so indexers can reset alarm timers. Same applies to `proposeDelta` and `proposeFeeChange`.
**Test gap:** No test for back-to-back propose calls.

### M-2 — Sandwich on swapNFTsForETH: payout uses pre-update spotPrice, but spotPrice update applies to all N items — protocol-fee asymmetry
**Location:** `_getSellPrice` L631 + L248
**Issue:** Sell price `basePayout = N*spot - delta*N*(N+1)/2` correctly computes integral. **But protocol fee is taken from `basePayout` BEFORE the LP fee (`basePayout * protocolFeeBps / BPS`) and then LP fee is taken from same `basePayout`** — both fees taxed on gross, not net. Same pattern in `_getBuyPrice`. This is double-stacked from the swapper's perspective:
```
inputAmount = baseCost + (baseCost * lpFeeBps / 10000) + (baseCost * protocolFeeBps / 10000)
// Effective fee: lpFeeBps + protocolFeeBps  (capped at 90% + 10% = 100% — see L-1 below)
```
Acceptable IF documented. Maximum-fee scenario is feeBps=9000 + protocolFeeBps=1000 = 10000bps = 100% fee — buyer pays 2x baseCost.
**Severity:** MEDIUM — economic, not security. But unbounded combined fee is footgun.
**Test gap:** No test exercises `feeBps + protocolFeeBps` near the cumulative ceiling; no test asserts user understands the fee stacking.

### M-3 — `_getSellPrice` view function reverts on insolvent pool — quote function should not revert
**Location:** L647–650
**Issue:** `_getSellPrice` does `require(availableETH >= outputAmount + protocolFee, "POOL_INSUFFICIENT_ETH")` which means `getSellQuote()` reverts whenever the pool can't afford the trade. Frontend integrations expect quote functions to return either a valid quote OR a sentinel value, not revert. Standard AMM convention (Uniswap, Sudoswap V2) is: separate `getQuote` from `getQuoteWithSolvency`.
**Mitigation:** Move the solvency check into `swapNFTsForETH` only, not the shared `_getSellPrice`. Better still: return a struct `{outputAmount, protocolFee, solvent}`.
**Test gap:** No test for `getSellQuote` against an insolvent pool — would surface as confusing UX bug.

### M-4 — `getSellQuote` math underflow potential when `accumulatedProtocolFees > balance`
**Location:** L647–649
**Issue:** `availableETH = address(this).balance > accumulatedProtocolFees ? balance - accumulatedProtocolFees : 0` — this guards underflow but is a CODE SMELL: indicates `accumulatedProtocolFees` could in theory exceed balance. The *only* way this happens is a bug in fee accounting (or external `selfdestruct(beneficiary=pool)` *removed in EIP-6049*; or `forceFeed` legacy). Defense in depth is fine, but the conditional masks the symptom.
**Severity:** MEDIUM — invariant violation should revert, not silently zero out availability.
**Mitigation:** `assert(address(this).balance >= accumulatedProtocolFees)` to surface invariant breakage.

### M-5 — Owner can grief swappers via `pause()` (no factory override)
**Location:** L455–457
**Issue:** Pool owner has unilateral `pause()` capability with no time bound, no factory override, and no escape hatch for users with in-flight orders. A malicious owner can pause indefinitely — protocol fees still accumulate from past swaps but cannot be claimed by factory because... actually `claimProtocolFees` is NOT `whenNotPaused` so factory CAN claim. Good.
**But:** Buyers/sellers with pending mempool txs see them revert on pause. The 24h timelock for parameter changes is undermined by instant-pause: owner pauses, victim tx reverts, owner unpauses, owner front-runs victim with no slippage. Owner cannot change PRICE during pause but can sandwich by withdrawing inventory between victim's two attempts.
**Severity:** MEDIUM — DoS + griefing vector
**Mitigation:** Pause should also be timelocked OR factory should have unpause power.
**Test gap:** `test_pause_blocksSwaps` covers basic pause but not the griefing scenario.

### M-6 — `swapETHForNFTs` accepts duplicate tokenIds in calldata, charges for N but transfers fewer
**Location:** L204–209
**Issue:** Solidity loop with duplicate IDs: first iteration calls `_removeHeldId(tokenId)`, second iteration on same `tokenId` finds `_idToIndex[tokenId] == 0` and reverts with `NFTNotHeld`. **Reverts cleanly — not exploitable.** But the user gets a confusing error. Recommend explicit dedup check `revert DuplicateTokenId(tokenId)` for UX.
**Severity:** MEDIUM (UX, not security)

---

## LOW

### L-1 — `feeBps + protocolFeeBps` can sum to 100%, draining all swap value
**Location:** Constants L55–56
**Issue:** `MAX_FEE_BPS = 9000` + `MAX_PROTOCOL_FEE_BPS = 1000` = 10000 = 100%. With both at max, `inputAmount = baseCost * 2`. No invariant check that the combined cap is reasonable.
**Mitigation:** `require(MAX_FEE_BPS + MAX_PROTOCOL_FEE_BPS <= 5000)` (50% absolute ceiling).

### L-2 — `MAX_DELTA = 10 ether` documented as TF-15 mitigation but inconsistent with comment
**Location:** L58–63
**Issue:** Comment says "tightened 100 ETH → 10 ETH" but `test_proposeDelta_rejectsAboveMax` test uses `101 ether` as the rejection value, suggesting a stale 100-ether bound somewhere. The actual constant IS 10 ether, but the test should use `10.001 ether` for tightness.
**Test fix:** Update test_proposeDelta_rejectsAboveMax to use `10 ether + 1`.

### L-3 — `receive()` accepts ETH from anyone, but only owner-context is exercised
**Location:** L571
**Issue:** Naked `receive()` accepts ETH from any sender. A hostile actor could donate ETH to inflate `address(this).balance` BUT since `withdrawETH` and `removeLiquidity` deduct `accumulatedProtocolFees` first, donations land in the LP pot and benefit the owner — not exploitable for donation-attack share-price inflation (no shares).
**Mitigation:** Acceptable but mention in NatSpec that donations enrich the LP.

### L-4 — `claimProtocolFees` returns silently if amount == 0 instead of reverting
**Location:** L466–472
**Issue:** Factory could repeatedly call `claimProtocolFees` with no fees to claim, wasting gas. Recommend `revert NoFeesToClaim()`.

### L-5 — `nftCollection` is not validated as ERC721 at init
**Location:** L149, L164
**Issue:** Init only checks `_nftCollection != address(0)`. A non-ERC721 contract could be passed; `safeTransferFrom` calls would fail later. Recommend `try-catch IERC165(_nftCollection).supportsInterface(0x80ac58cd)` validation.

---

## INFO

### I-1 — Donation attack on share price: NOT APPLICABLE
**Reason:** No fungible LP shares; single-owner pool. Donation enriches the owner.

### I-2 — Lazy-mint forgery: NOT APPLICABLE
**Reason:** Pool only handles already-minted ERC721; no lazy-mint surface.

### I-3 — `block.*` randomness misuse: CLEAN
**Search:** No `block.timestamp`, `block.difficulty`, `block.prevrandao`, `blockhash` used for randomness. `block.timestamp` only used for deadlines and timelocks (acceptable).

### I-4 — Royalty/fee bypass on instant swap: NOT APPLICABLE
**Reason:** Pool does not honor EIP-2981 royalties at all (Sudoswap-style design). Documented design choice; flag for project-level decision but not a vuln.

---

## TEST GAPS

1. **Rarity-sniping cherry-pick test** (H-1) — no test where attacker buys only the rarest IDs.
2. **swapNFTsForETH with malicious ERC721 receiver** (H-2 symmetry) — only buy path tested.
3. **syncNFTs trust-boundary test** — owner reclaiming a user's mistakenly-transferred NFT is not flagged as a behavior change.
4. **proposeSpotPrice replacement / timer reset test** (M-1) — no back-to-back propose coverage.
5. **Combined fee ceiling test** (L-1, M-2) — no test with `feeBps=9000, protocolFeeBps=1000` to verify 2x effective cost.
6. **Insolvent-pool getSellQuote revert** (M-3) — no test asserts whether quote reverts vs. returns 0.
7. **Pause griefing scenario** (M-5) — no test where owner pauses → withdraws inventory → unpauses → victim's resubmitted tx now sees worse price.

---

## CROSS-CHECK NOTES

- `TegridyNFTPool.t.sol` covers happy paths and parameter timelocks comprehensively (1120 lines). Misses adversarial economic scenarios.
- `TegridyNFTPool_Reentrancy.t.sol` confirms 10k gas stipend + nonReentrant double-defense for ETH callbacks and ERC721Received re-entry. Solid.
- `TegridyNFTPool_Sandwich.t.sol` confirms maxTotalCost / minOutput / deadline protections work. Does not exercise owner-side sandwich (pause/unpause griefing) or rarity-sniping.

---

## TOP-3 PRIORITIES

1. **H-1** — Rarity sniping: economically silent value drain, structural design issue.
2. **H-2** — CEI ordering in `swapNFTsForETH`: spotPrice mutates before transfers complete.
3. **H-3** — `syncNFTs` allows owner to claim mistakenly-transferred NFTs without rescue path.
