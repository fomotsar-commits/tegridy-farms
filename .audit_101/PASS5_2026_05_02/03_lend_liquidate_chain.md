# Pass-5 Cross-Contract Chain Analysis: Lend → Borrow → Liquidate

**Status:** No PoC-backed findings. The lending chain is structurally clean.

This file documents the cross-contract analysis of the lending suite: TegridyLending, TegridyNFTLending, TegridyNFTPool (which the lending side could mistake for collateral pricing), TegridyPair (the underlying AMM), TegridyRouter.

---

## 1. Pricing surface

### TegridyNFTLending (NFT-collateral loans)
- **No oracle.** Collateral value is implicit in the lender's `offer.principal` — pure P2P.
- `claimDefault` simply transfers the NFT to the lender with no valuation check.
- Cannot be price-attacked because no price is read.

### TegridyLending (token-collateral loans)
- The agent map noted "TegridyLending may not exist". This is incorrect; the file is at `contracts/src/TegridyLending.sol` (1725 LOC).
- TegridyLending was the source of the V3-LD3-H1/H2/H3 sibling-misses (lacking `getSequencerOutageBuffer`, MIN_INTEREST_PRINCIPAL_BPS floor, treasuryAtCreate snapshot). These are noted in the v3 master report as still-pending.
- **However**, pass-5 verified that `_positionETHValue` no longer reads raw spot reserves directly — the v3 fix wired it through TegridyTWAP. Verified no remaining sandwich vector.

### POLAccumulator
- Uses TegridyTWAP-derived minOut floor for its swap leg (post-pass-2 fix).
- `accumulate` is `onlyOwner` (line 346) — no permissionless invocation, no MEV.

---

## 2. Cross-contract reentrancy on liquidation

`TegridyNFTLending.claimDefault` ([line 567](../../contracts/src/TegridyNFTLending.sol#L567)) is `nonReentrant` — entry-protected — and the actual NFT transfer (`safeTransferFrom`) at line 609 happens AFTER state changes.

Sequence:
1. Borrower defaults on loan
2. Lender calls `claimDefault(loanId)`
3. State changes: loan marked closed, internal accounting updated
4. NFT.safeTransferFrom(this, lender, tokenId) — final external call

If the NFT is malicious (calls back into the protocol on `onERC721Received`):
- `claimDefault` itself is `nonReentrant` so the malicious NFT cannot re-enter `claimDefault`
- It CAN call other protocol functions: `TegridyNFTPool.swapETHForNFTs`, `TegridyRouter` swaps, etc.
- But all state in `TegridyNFTLending` is already settled

**Cross-contract reentrancy concern:** could the malicious NFT call `TegridyNFTPool.swapNFTsForETH` to dump liquidity? Yes — but `swapNFTsForETH` is its own permissionless function; it doesn't read any TegridyNFTLending state and the lending contract's own state is already finalized. No fund extraction vector.

**`_swapInFlight` in TegridyNFTPool:** the `acceptOwnership` cooldown gate uses `_swapInFlight` ([line 669-693](../../contracts/src/TegridyNFTPool.sol#L669)). This guards transfer-in deposits during swaps — NOT liquidation reentrancy on TegridyNFTLending.

---

## 3. Did pass-5 find any remaining LD-related findings?

The v3 master report listed three Lending Highs as still-pending (LD3-H1/H2/H3 — sibling-misses of LD2-H1/H2/H3 ported only to TegridyNFTLending, never to TegridyLending). Pass-5 confirmed these are still in the code:

- LD3-H1: `TegridyLending.repayLoan / claimDefaultedCollateral` lack `getSequencerOutageBuffer` extension
- LD3-H2: `TegridyLending` lacks `MIN_INTEREST_PRINCIPAL_BPS` flat-floor (0% APR flash-loan loophole)
- LD3-H3: `TegridyLending` lacks `treasuryAtCreate` snapshot (treasury rotation can redirect lender's fee mid-flight)

These are **prior findings** from pass-4. Not new pass-5 findings; they remain in the open-issue queue.

Pass-5 did not surface any *new* lending findings beyond the v3 set.

---

## 4. NFT collateral floor manipulation

The pass-1 master report (item #11 in the TOP-25 table) flagged TegridyNFTPool's bonding-curve "rarity sniping" issue (Sudoswap V1 flaw). This was supposedly addressed in v3.

Pass-5 verified the fix area:
- `TegridyNFTPool.swapETHForNFTs` accepts `tokenIds` from the buyer (still allows rarity selection)
- The `_swapCaller` gate at v3-NFTPOOL-01 ensures only authorized callers, not arbitrary buyers
- No price-impact-via-rarity exploit found in cross-contract chains

---

## 5. Did pass-5 find new lending-pool sandwich vectors?

The pass-1 #11 flagged TegridyNFTPool ↔ TegridyPair sandwich potential. Pass-5 re-examined:

- TegridyNFTPool uses LINEAR bonding curve (`spot += delta × N`)
- TegridyPair uses CONSTANT-PRODUCT (x*y=k)
- They share NO state — there's no oracle linking the two
- An attacker could move TegridyPair's TOWELI/ETH price, then trade NFTs in TegridyNFTPool — but TegridyNFTPool prices in ETH, not in TOWELI, so the cross-coupling is null

No new finding.

---

## 6. Conclusion

The lending → liquidate chain has known unfixed prior-pass findings (LD3-H1/H2/H3) but no new pass-5 cross-contract findings. The architectural decision to use P2P pricing (no oracle) for TegridyNFTLending eliminates the entire price-manipulation attack class — at the cost of requiring lenders to do their own collateral valuation off-chain.
