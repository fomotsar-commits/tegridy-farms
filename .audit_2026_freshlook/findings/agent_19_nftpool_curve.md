# Agent 19/100 — TegridyNFTPool Curve & Swap Mechanics

**Scope:** `contracts/src/TegridyNFTPool.sol` (1036 lines), `contracts/src/TegridyNFTPoolFactory.sol`
**Lens:** Bonding-curve correctness, NFT swap mechanics, deposit/withdraw, royalty enforcement, sandwich/MEV exposure
**Date:** 2026-05-07

---

## Summary

The pool implements a Sudoswap-style linear bonding curve with three pool types (BUY/SELL/TRADE), ERC-2981 royalty enforcement (capped at 25%), accumulator-based fee accounting, and a CLK-02-migrated 10-min timestamp cooldown on owner withdrawals. The curve math is mathematically consistent (buy/sell are symmetric for round trips), overflow-safe at the imposed `MAX_DELTA` / `MAX_SPOT_PRICE` ceilings, and the V3-NFTPOOL-01 fix correctly closes the buyer-callback re-entry deposit vector. However, three medium-severity concerns survive: per-token-royalty defeat via tokenIds[] ordering, mode-2 stranded-WETH cushion erosion that silently degrades subsequent SELL solvency, and a multi-rarity cherry-pick footgun that is structural to the Sudoswap design.

---

## Findings

### F-19-1 [MEDIUM] Per-token-royalty bypass via `tokenIds[0]` anchoring
**File:** `TegridyNFTPool.sol:312, 371, 969-1014`

`_settleRoyalty` queries `royaltyInfo(firstTokenId, totalSale)` using `tokenIds[0]` only. The contract acknowledges this in the comment ("Most ERC-2981 implementations use a single rate per collection — anchoring on the first tokenId is faithful").

**Exploit shape (per-token royalty collections):**
- Collection X uses ERC-2981 with PER-TOKEN rates (Manifold royalty registry, Foundation, Async Art curated drops).
- TokenId `A` has 10% royalty; TokenId `B` has 0% royalty (e.g., legacy mint or creator-self-owned).
- Buyer/seller arranges `tokenIds = [B, A, A, A, ..., A]`.
- Pool computes royalty as 0% × totalSale = 0. No royalty paid on the entire batch (including the high-royalty `A` tokens).

**Impact:** Total royalty bypass for batches against per-token-royalty collections. Collections that depend on royalty for revenue (creators, charity flows) lose enforcement. Sudoswap V2 has the same limitation by design but documents it; this contract documents but does not warn the operator at pool-creation time.

**Mitigation candidates:**
- Iterate `royaltyInfo` per tokenId (gas cost: +O(n) external calls).
- Take `max(royaltyInfo per token)` and apply uniformly.
- At minimum, surface a deploy-time event/registry flag listing which collections support per-token rates so frontends can warn.

---

### F-19-2 [MEDIUM] Mode-2 stranded WETH silently erodes LP cushion
**File:** `TegridyNFTPool.sol:992-1010`, `lib/WETHFallbackLib.sol:131-170`

In `_settleRoyalty`, when `safeTransferETHOrWrapNoRevert` returns `(success=false, mode=2)` AND the WETH `deposit{value: amount}()` leg has already succeeded but the subsequent `weth.transfer(to, amount)` fails, the pool's ETH balance has decreased by `royaltyAmount` (consumed by `deposit`) and the pool now holds `royaltyAmount` of WETH. `royaltyPaid` returns 0; the seller is paid `outputAmount - 0 = outputAmount` in full.

The pool's pre-swap solvency check at `_getSellPriceFull` (line 877) was:
```
availableETH >= outputAmount + protocolFee + lpFee
```
This does NOT reserve any room for the unrecoverable royaltyAmount that WILL leave the pool's ETH balance via `deposit`. Net post-swap effect:
- ETH balance: `-outputAmount - royaltyAmount`
- WETH balance: `+royaltyAmount`
- `_lpAvailableETH()` view (which only reads `address(this).balance`): underwater by `royaltyAmount` relative to the cushion the swap was supposed to leave.

**Impact:**
- Subsequent SELL swaps may revert with `POOL_INSUFFICIENT_ETH` because the LP cushion has been silently spent on a failed-delivery royalty wrap.
- `rescueStrandedRoyalty` (line 1029-1034) recovers WETH to the OWNER, not back into the pool's ETH balance — the owner has to manually re-wrap WETH→ETH and `addLiquidity{value:...}([])` to restore the cushion.
- For TRADE pools where owner == LP, this is a solvable operational pain point; for any future change where LP shares are transferable, this becomes an LP-fund migration to owner without consent.
- Receive() restriction (line 804-806) prevents a casual ETH redeposit, forcing the `addLiquidity{value:}` path which is owner-only.

**Mitigation candidates:**
- In `_settleRoyalty`, on mode-2 failure, immediately attempt `IWETH(weth).withdraw(royaltyAmount)` to restore ETH balance, falling through to `RoyaltyOrphaned` only if both WETH-transfer and WETH-withdraw fail.
- Account for `royaltyAmount` as a pessimistic worst-case in the solvency check (e.g., `availableETH >= outputAmount + protocolFee + lpFee + (outputAmount >> 2)`).

---

### F-19-3 [LOW] Multi-rarity cherry-pick footgun (structural, by design)
**File:** `TegridyNFTPool.sol:257-324, 326-381`

Buyer specifies `uint256[] calldata tokenIds` and pays `inputAmount` based purely on `numItems` — there is no per-token pricing differentiation. Pool transfers EXACTLY the buyer-chosen tokenIds.

**Exploit shape:**
- Pool LP deposits a mix of NFTs from the same collection: 1× rare 1/1 (worth $100k externally), 99× floor commons ($1k each).
- Pool's spotPrice is set at floor ($1k).
- First buyer specifies `tokenIds = [<1/1 tokenId>]` and pays `1 × $1k` to acquire the 1/1.
- Pool LP loses ~$99k of value.

**Status:** This is the standard Sudoswap-style design choice — pool LPs are expected to deposit only fungible-rarity NFTs. However, the contract has zero on-chain warning, no per-token price differentiation hook, and no rarity-floor enforcement. New LPs migrating from order-book marketplaces (where each NFT can be priced independently) will likely fall into this trap.

**Mitigation candidates:**
- Operator-level docs warning explicitly.
- A view function `getCheapestPriceForRarestNFT()` callable from the frontend.
- Per-pool "rarity-band restricted" deposit allowlist (significant scope creep, not recommended for v1).

---

### F-19-4 [LOW] BUY/SELL same-block sandwich is fee-loss-only (no theft)
**Verified safe.** Buy of n items at spot S → spotPrice becomes S+nδ. Subsequent sell of the same n items at spotPrice S+nδ pays `n(S+nδ) − δn(n+1)/2 = nS + δn(n−1)/2 = baseCost`. Round-trip baseCost is identical for buy and sell. Attacker pays both protocolFee+lpFee+royalty legs and loses ~`2(feeBps + protocolFeeBps + royaltyBps)` in fees. No profit extractable from a self-sandwich.

The `lastWithdrawBlock == block.timestamp` guard correctly blocks the owner-front-run vector (owner withdraws → trader's swap clears stale price). No additional sandwich vector found.

---

### F-19-5 [LOW] `_minLiquidityBuffer` is conservative — owner can be over-blocked from dust withdrawals (mitigated)
**File:** `TegridyNFTPool.sol:900-915`

The buffer floor is `min(getMaxSellable(), 100) × spotPrice` — an OVERESTIMATE of the worst-case sell payout (`basePayout = n×spot − δ×n(n+1)/2 < n×spot`). The V3-NFTPOOL-03 fix (line 914) correctly returns 0 when `floorAmt > lpAvailable` so a depleted pool doesn't brick dust recovery, but in the overestimate-not-yet-underwater regime, the owner cannot withdraw until the cushion exceeds true worst-case payout by ~50%.

**Impact:** Conservative cushion is a feature (defends against unexpected curve movement). Not a security finding, just a UX observation.

---

### F-19-6 [DEAD-END] Buyer callback re-entry deposit (V3-NFTPOOL-01 verified)
The V3-NFTPOOL-01 fix at line 274-280 correctly does NOT set `_swapCaller` during BUY direction. During `safeTransferFrom(this, buyer, tokenId)`, buyer's `onERC721Received` cannot deposit arbitrary tokenIds via the pool's `onERC721Received` because:
- `_swapInFlight = true`, `_swapCaller = address(0)`.
- `authorizedSwapInflow = _swapInFlight && from == _swapCaller` requires `from == address(0)` which the collection cannot legitimately produce.
- `authorizedOperator` requires operator ∈ {owner, this, factory} — a buyer-controlled re-entry would have operator = buyer.

**Verdict:** Closed by V3 fix, no regression.

---

### F-19-7 [DEAD-END] Bonding-curve overflow at large supply
At `MAX_DELTA = 10 ETH`, `MAX_SPOT_PRICE = 1M ETH`, `numItems ≤ 100`:
- Buy: `n × spot + δn(n−1)/2 ≤ 100 × 10²⁴ + 10¹⁹ × 5050 ≈ 10²⁶`. Below uint256 max (~10⁷⁷). Safe.
- Sell: `δ × n` overflow check at line 852 protects basePayout from underflow given the `n ≥ 1` invariant (for `n=1`, `n+1 ≤ 2δ < 2spot` holds whenever `δn < spot`).

**Verdict:** Safe within imposed bounds.

---

### F-19-8 [DEAD-END] `getMaxSellable` div-by-zero / underflow
`if (delta == 0) return type(uint256).max;` short-circuits div-by-zero. `spotPrice` is always `> 0` (init guard, decremented only with `δn < spot` pre-check). `(spotPrice − 1) / delta` is safe. Verified.

---

### F-19-9 [DEAD-END] Direct NFT transfer to pool (non-`safeTransferFrom`) inflates inventory
A `transferFrom` (no -safe) from an arbitrary holder to the pool transfers ownership but does NOT call `onERC721Received`. Pool now owns the NFT but `_idToIndex[tokenId] == 0`. This NFT is "stuck": cannot be bought (line 290 reverts on missing index), cannot be removed via `removeLiquidity` (same check). Owner can sweep via `syncNFTs` (line 690) — onlyOwner, validates `ownerOf == address(this)` before adding. Attacker burned their NFT for zero gain.

**Verdict:** Not exploitable.

---

### F-19-10 [DEAD-END] `claimLPFees` / `claimPriorOwnerLPFees` race
V2-NFTPOOL-06 correctly sends `claimLPFees` proceeds to `msg.sender` (the address that passed the `onlyOwner` check this tx), not the live `owner` slot. Eliminates the same-block "freshly-accepted-ownership" race. Prior owner has the snapshot path (`claimPriorOwnerLPFees`) for any LP fees accrued before the transition. Verified.

---

### F-19-11 [DEAD-END] `acceptOwnership` without `whenNotPaused`
V3-NFTPOOL-04 correctly removes both `whenNotPaused` and the factory-emergencyPaused gate from `acceptOwnership` to preserve the key-loss recovery path. The defended threat (attacker-as-owner queuing malicious pendingOwner) is mitigated by `cancelOwnerChange` from the legitimate owner. The 48h `OWNER_TIMELOCK` provides the warning window. Verified.

---

### F-19-12 [DEAD-END] CLK-02 timestamp migration
Storage slot `lastSwapBlock`/`lastWithdrawBlock` retain their names for ABI continuity but now store `block.timestamp`. `WITHDRAW_NFT_COOLDOWN_BLOCKS = 10 minutes` (600 seconds). Cooldown is uniform across L1/L2/Arbitrum (no longer block-counting). Verified consistent across all withdrawal paths (`withdrawNFTs`, `withdrawETH`, `removeLiquidity`).

---

### F-19-13 [DEAD-END] Stuck fee math underflow
- Buy: `spotRevenue = inputAmount − protocolFee − lpFee = baseCost`. `inputAmount` constructed as sum, so non-negative. Royalty bounded by `baseCost / 4`.
- Sell: `outputAmount − royalty ≥ outputAmount × 3/4 > 0`. `outputAmount = basePayout − lpFee − protocolFee` non-negative by construction (`feeBps + protocolFeeBps ≤ 9000 + 1000 = 100% but basePayout > 0` ensures... wait — actually `feeBps + protocolFeeBps` can theoretically reach 100% but `outputAmount` would then be 0, not negative). Verified safe.

---

### F-19-14 [DEAD-END] `tokenIds.length = 0` / duplicate tokenIds / oversized batch
- Empty: line 269 / 338 reverts with `EmptySwap`.
- Oversized: line 270 / 339 reverts with `TooManyItems` at numItems > 100.
- Duplicate: first occurrence of dup ID succeeds (`_removeHeldId`), second fails (`_idToIndex == 0` → `NFTNotHeld`). Whole tx reverts. ✓

---

### F-19-15 [DEAD-END] Reserved/pinned NFT
No pinning mechanism in the pool. All `_heldIds` are equally available to swap at the curve price. By design (Sudoswap parity).

---

## Output Path
`C:/Users/jimbo/OneDrive/Desktop/tegriddy farms/.audit_2026_freshlook/findings/agent_19_nftpool_curve.md`
