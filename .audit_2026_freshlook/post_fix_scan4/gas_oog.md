# Gas-Edge / OOG Attack-Surface Audit — post_fix_scan4

**Date**: 2026-05-09
**Scope**: HEAD of `main` after Wave A/B/C fixes (M-36 stipend bump, H-9 sequencer feed, H-11 prewarm, GAS-01 SafeERC721Call lib, et al.)
**Read-only audit — DO NOT EDIT**

---

## Lens Set (per task)

1. External calls inside loops — partial-state risk on iteration N OOG
2. Receiver-controlled gas (post-M-36 30k stipend)
3. Returndata bombs — every `try/catch` against attacker-controlled callees
4. Unbounded view in state-changing path (post-H-11 cold-SSTORE prewarm coverage)
5. Loop bound = `userInput.length`
6. Gas-sensitive lib boundaries (`getSequencerOutageBuffer`, `_cumulativePausedInWindow`)
7. Cross-contract OOG via callbacks
8. Storage-write + external-call ordering — sibling H-11 patterns
9. `gasleft()` / `block.gaslimit` direct comparisons

---

## Severity Legend

- **STATE-INTEGRITY** — OOG leaves state corrupted (worse than hard revert)
- **DOS** — OOG blocks legitimate flow, no integrity loss (revert rolls back)
- **WASTE** — gas-inefficient, no integrity issue

---

# Findings

## STATE-INTEGRITY findings

> **None confirmed at HEAD.**
>
> The post-M-36 / post-H-11 fix pattern (zero accumulator → fan-out with `pendingDistribution[receiver]` fallback on `.call` failure → final treasury via `safeTransferETHOrWrap`) is structurally atomic. Every state mutator that allocates ETH does so AFTER zeroing the source slot in the same tx, so any OOG inside a fan-out leg either (a) succeeds and credits, (b) fails and routes to a pending-pull slot, or (c) reverts the entire tx and rolls everything back. There is no path observed where an OOG can cause partial credit to N-1 legs while leaving the Nth leg silently un-paid AND the source un-zeroed.
>
> The risk class becomes real only if a future change separates the "zero accumulator" SSTORE from the fan-out body, or introduces a try/catch inside the fan-out that swallows an OOG via return-modes. Both are absent at HEAD.

---

## DOS findings

### DOS-01 [HIGH] — `try/catch` against attacker-controlled ERC721 in TegridyNFTLending.acceptOffer

**File**: `contracts/src/TegridyNFTLending.sol:686`

```solidity
try IERC721(collateralContract).ownerOf(_tokenId) returns (address currentOwner) {
    if (currentOwner != msg.sender) revert NotNFTOwner();
} catch {
    revert CollateralBurnedSinceOffer();
}
```

`collateralContract` is whitelisted, but the whitelist accepts user-class collections (the whole protocol surface is "lend against any whitelisted ERC721"). Solidity's `try/catch` ALWAYS performs `returndatacopy(0, 0, returndatasize())` before the catch fires — this is exactly the GAS-01 vector that motivated `lib/SafeERC721Call.sol`. A whitelisted-but-malicious collection (e.g., upgradeable proxy whose impl was rotated post-whitelist) returning ~16MB from `ownerOf` would OOG-grief every borrower attempting to accept any offer against that collection.

The sibling helpers `_safeOutboundTransfer` (line 1030) and the lender-side default path correctly use `SafeERC721Call.safeOwnerOfBounded`, which caps returndata at 32 bytes. **`acceptOffer` does not.** Inconsistency = gas-bomb survives on the borrower-ingress path even though the lender-egress paths are hardened.

**Blast radius**: borrower cannot accept offers against the affected collection; existing loans against it are unaffected (already past `acceptOffer`).
**Mitigation**: replace the bare `try IERC721(collateralContract).ownerOf(...)` with `SafeERC721Call.safeOwnerOfBounded(collateralContract, _tokenId)` (already imported, line 15).

### DOS-02 [MEDIUM] — `try IERC2981.royaltyInfo` returndata bomb in TegridyNFTPool

**File**: `contracts/src/TegridyNFTPool.sol:980`

```solidity
try IERC2981(address(nftCollection)).royaltyInfo(firstTokenId, totalSale)
    returns (address receiver, uint256 amount)
```

`TegridyNFTPoolFactory.createPool` is **permissionless** for any ERC721 (line 194, only checks `nftCollection.code.length > 0`). An attacker can deploy a pool against their own ERC2981-implementing collection that returns 100MB+ from `royaltyInfo`. Every subsequent buyer/seller on that pool (including honest ones) has their swap OOG-bricked via the implicit returndatacopy on the catch path.

Compared to DOS-01, this is lower severity because the attacker only DoS's their OWN pool — the broader protocol is unaffected. But honest LPs who might have deposited NFTs into the pool (perhaps before the malicious upgrade) are stuck.

**Mitigation**: extend `SafeERC721Call` with `safeRoyaltyInfoBounded(coll, tokenId, salePrice)` (returns capped 64 bytes — address + uint256), or wrap the call in a low-level assembly `staticcall` with bounded outsize like the existing `safeOwnerOfBounded`.

### DOS-03 [LOW] — `try nftCollection.ownerOf` returndata bomb in TegridyNFTPool.syncNFTs

**File**: `contracts/src/TegridyNFTPool.sol:700`

Same shape as DOS-02 but inside `syncNFTs` which is `external` (callable by anyone — confirmed by reading `function syncNFTs(uint256[] calldata tokenIds) external onlyOwner`). It IS owner-only. A malicious collection still bricks the owner's sync flow, but blast radius is the owner-only sync path.

**Mitigation**: Migrate to `SafeERC721Call.safeOwnerOfBounded` for parity with the sibling sites in TegridyNFTLending / TegridyLending.

### DOS-04 [LOW] — `try this._safeTransferExternal` returndata bomb on whitelisted ERC20 in VoteIncentives.claimBribesBatch

**File**: `contracts/src/VoteIncentives.sol:927-988` (and `:810-887` for the single-epoch sibling)

The inner loop calls `try this._safeTransferExternal(token, msg.sender, share) catch { /* pending */ }`. `token` is owner-whitelisted, but a non-standard ERC20 with hostile `transfer` returndata would OOG the inner returndatacopy and brick the entire batch. Mitigated by:
(a) owner-whitelist (vetted tokens),
(b) MAX_BATCH_ITERATIONS cap (line 964) bounds outer-loop iterations,
(c) per-token `claimed` flags are set BEFORE the transfer, so OOG-induced revert just rolls back to a known-good state and the user can retry single-epoch claims that skip the bad token.

But the bad token cannot be skipped *within* the batch — the whole batch reverts. Bounded-impact DoS only.

**Mitigation**: out of scope for now; the owner-whitelist is the primary defense.

---

## DOS — Cold-SSTORE / receive() budget

### DOS-05 [INFO, ACCEPTED-BY-DESIGN] — POLAccumulator.receive() not H-11 prewarmed

**File**: `contracts/src/POLAccumulator.sol:308-318`

```solidity
receive() external payable {
    totalETHReceived += msg.value;
    emit ETHReceived(msg.sender, msg.value);
}
```

Unlike `RevenueDistributor` (constructor pre-warms `_totalETHReceivedRaw = 1` to convert the first SSTORE from zero→non-zero (22.1k) into non-zero→non-zero (~5k)), `POLAccumulator.totalETHReceived` is NOT prewarmed.

**Why this is acceptable at HEAD**:
The single ETH ingress path is `SwapFeeRouter.distributeFeesToStakers` line 1354: `polAccumulator.call{value: polAmount, gas: 50_000}("")`. With a 50k stipend (NOT 30k like `safeTransferETHOrWrap`), the worst-case first-call cost is:
- cold-SLOAD: 2,100
- zero→non-zero SSTORE: 22,100
- LOG2 (ETHReceived): ~1,750
- function dispatch + arg copy: ~3-4k
- **total ~30k, leaving ~20k margin under the 50k stipend.**

This works only as long as no future caller switches to `safeTransferETHOrWrap` (which uses a 30k stipend and would silently route the first POL distribution to the WETH-fallback path). If POLAccumulator is ever made a destination of `safeTransferETHOrWrap`, prewarm becomes mandatory.

**Recommendation**: Add a defensive `totalETHReceived = 1` to POLAccumulator's constructor with a public `getTotalETHReceived()` getter that subtracts the offset (mirror RevenueDistributor's H-11 pattern) — costs ~22k in deploy gas and removes a forward-compat hazard.

### DOS-06 [INFO] — SwapFeeRouter.receive() not H-11 prewarmed

**File**: `contracts/src/SwapFeeRouter.sol:2064-2069`

Same pattern as POLAccumulator. Acceptable at HEAD because the only callers (Uniswap V2 router refunds, internal wrap/unwrap legs, the `recordReferralFee` `pendingDistribution` fallback path) all forward enough gas. But same forward-compat caveat as DOS-05.

---

## DOS — Loops with growing storage

### DOS-07 [LOW] — `proposeSweepUnsolicitedNFT` walks `loans.length` twice

**File**: `contracts/src/TegridyNFTLending.sol:1607-1626`

`proposeSweepUnsolicitedNFT` and `executeSweepUnsolicitedNFT` walk every loan in `loans[]` twice (active-collateral check + stuck-collateral check). `loans.length` is monotonically increasing across protocol lifetime — no per-call hard cap.

Today (typical operation), `loans.length` < 1000, so 2N storage reads ≈ ~4M gas. By year 5 at 10k loans/yr, this becomes ~40M gas — past the mainnet block gas limit. Owner-only + 24h timelock ⇒ low impact today, but a **time bomb**: at sufficient scale the sweep flow becomes unusable.

**Mitigation**: paginated sweep proposal, OR a `(collection, tokenId) → loanId` reverse-index. The contract already has `loans[i].collateralContract` and `loans[i].tokenId`, so building the index would cost one extra mapping write per `acceptOffer`/`createLoan`.

### DOS-08 [LOW] — `_cumulativePausedInWindow` walks `pauseHistory.length`

**File**: `contracts/src/TegridyNFTLending.sol:1512-1529`, `contracts/src/TegridyLending.sol:1980-1997`

Each call walks the entire `pauseHistory[]`. Append-only, only on owner unpause. Worst-case bound depends on owner pause cadence. For a captured-key owner trying to grief, the F-71-9 cumulative cap (rolling 30-day window) bounds total grief value, but the per-call iteration cost grows unboundedly.

**Mitigation**: rolling cleanup — drop entries with `endedAt < (block.timestamp - CUMULATIVE_PAUSE_WINDOW)` during `_unpause`. Bounded by a hard cap (e.g., MAX_PAUSE_HISTORY = 256) for safety.

---

## DOS — Library boundaries

### DOS-09 [INFO] — `getSequencerOutageBuffer` is constant-cost

`SequencerCheck.getSequencerOutageBuffer` performs a single `latestRoundData()` external call + 6 unchecked branches. ~5k gas total. No iteration. **Safe at any block.gaslimit.**

### DOS-10 [INFO] — `Math.mulDiv` chain

Used in TegridyTWAP, TegridyPair, SwapFeeRouter for fixed-point math. OZ `Math.mulDiv` is constant-time per call. Multiple chained calls add linearly. No iteration risk.

---

## WASTE findings

### WASTE-01 — TegridyRouter.getAmountsOut/In has no internal cycle pre-check

**File**: `contracts/src/TegridyRouter.sol:415-437`

Both functions iterate `path.length` (capped at 10) without the upfront `_validatePathNoCycles` check that `_swap` has. View-only, gas paid by indexers. No state risk.

### WASTE-02 — VoteIncentives sweep-and-pop scan in `applyWhitelistChange`

**File**: `contracts/src/VoteIncentives.sol:1113`

Linear scan of `whitelistedTokenList` to find the index for swap-and-pop. O(N) per removal; bounded by token list size (~dozens in practice). Owner-only. WASTE only.

---

## Summary by Lens

| Lens | Findings |
|---|---|
| 1. External calls in loops | 0 STATE-INTEGRITY (atomic via revert); see DOS-04 for try/catch returndata bomb |
| 2. Receiver-controlled gas | Wave A M-36 (30k stipend) confirmed correct; DOS-05/06 forward-compat caveat |
| 3. Returndata bombs | DOS-01 (HIGH), DOS-02 (MED), DOS-03/04 (LOW) — `SafeERC721Call` lib usage gap |
| 4. View in state-mutator | RevenueDistributor H-11 prewarm correctly applied; POLAccumulator/SFR have margin via 50k caller-side stipend |
| 5. User-supplied loop bound | NFTPool 100-item cap, Router 10-hop cap, VoteIncentives MAX_BATCH_ITERATIONS — all bounded |
| 6. Lib boundaries | All constant-cost (DOS-09/10) |
| 7. Cross-contract OOG | NFT receiver hooks (`onERC721Received`) gated by `_swapInFlight` + auth checks |
| 8. Cold-SSTORE pattern | RevenueDistributor prewarm correct; POLAccumulator/SFR forward-compat hazard (DOS-05/06) |
| 9. `gasleft()` / `block.gaslimit` | **0 occurrences** — no chain-dependent gas heuristics anywhere |

---

## Top Recommendations (in order of impact)

1. **DOS-01** — Replace bare `try IERC721(collateralContract).ownerOf(...)` in `TegridyNFTLending.acceptOffer:686` with `SafeERC721Call.safeOwnerOfBounded`. One-line minimal-surface fix.
2. **DOS-02** — Extend `SafeERC721Call` with `safeRoyaltyInfoBounded` and apply at `TegridyNFTPool._settleRoyalty:980`. Closes the permissionless-pool DoS.
3. **DOS-05/06** — Add 1-wei prewarm to POLAccumulator + SwapFeeRouter constructors. Forward-compat hardening, ~22k deploy gas each.
4. **DOS-07** — Add `(collection, tokenId) → loanId` reverse-index in TegridyNFTLending. Pre-empts the sweep timebomb at 10k+ loans.

No state-integrity findings; the post-M-36/H-11 codebase is structurally sound on the OOG axis. Remaining DoS findings are confined attack surfaces with workable migration paths.
