# Audit 007 — TegridyNFTLending.sol

**Agent**: 007/101
**Target**: `contracts/src/TegridyNFTLending.sol` (783 lines)
**Cross-check**: `contracts/test/TegridyNFTLending.t.sol`
**Mode**: AUDIT-ONLY
**Date**: 2026-04-25

## Surface mapped
P2P NFT-collateralized lender. Lender deposits ETH → escrows specific tokenId at offer creation; borrower accepts by transferring NFT in; principal sent out; pro-rata APR; protocol fee on interest; 1h grace period after deadline; default claimable by lender; whitelist on collections (timelocked); origination fee + min APR (timelocked).

No oracle. No signed offers (on-chain only). ERC-721 only (no 1155). Uses `transferFrom` (not `safeTransferFrom`) so no `onERC721Received` hooks invoked.

---

## HIGH

### H-1 — Stale tokenId / ownership-changed offer can be accepted by current holder, but original lender's tokenId target may be flipped via mid-flight ownership transfer
`createOffer` calls `IERC721.ownerOf(_tokenId)` (existence check only — comment line 274-277 explicitly states it does NOT require lender to own it). `acceptOffer` later checks `IERC721(collateralContract).ownerOf(_tokenId) == msg.sender` (line 355). This is correct — only current owner can accept. **However**, the lender selects the NFT via on-chain off-the-shelf metadata at offer time; an attacker can wash-trade the specific tokenId between two wallets to artificially inflate apparent floor / sales history feeding the lender's manual valuation. There is no on-chain oracle, so this is **out-of-scope for code-level mitigation**, but the protocol DOES advertise "lender evaluates risk themselves (Gondi pattern)" (line 22). Risk is documented and accepted by design.

**Severity downgraded to LOW (informational).** No code-level fix possible without an oracle.

### H-2 — `transferFrom` instead of `safeTransferFrom` (intentional, but receivers without IERC721Receiver could leave NFT permanently stuck)
Lines 378, 449, 496 all use `IERC721(...).transferFrom(...)` rather than `safeTransferFrom`. Effects:
- Borrower → contract on `acceptOffer`: contract is recipient, no callback, no `onERC721Received` required. **Safe** — bypassing `safeTransferFrom` is *necessary* to skip the receiver hook (which would also bypass reentrancy guard since it calls back during transfer).
- Contract → borrower on `repayLoan`: borrower is whatever originally accepted (could be a contract). If borrower is a contract that doesn't accept ERC-721 via standard `transferFrom`, the transfer still succeeds (ERC-721 `transferFrom` does not call `onERC721Received`). NFT is delivered.
- Contract → lender on `claimDefault`: lender is offer creator (could be contract). Same as above — succeeds even for non-IERC721Receiver contracts.

**Verdict**: Correct & intentional. `transferFrom` is the right choice here because it (a) avoids the receiver-callback reentrancy vector, and (b) cannot trap the NFT — receiver does not need to implement `onERC721Received`. **Documented "battle-tested" pattern.**

### H-3 — `executeRemoveCollection` revert string vs custom error inconsistency (LOW pattern, INFO severity)
Line 639: `revert("ACTIVE_LOANS_PRESENT");` uses string revert in a contract that otherwise uses custom errors throughout. Test `test_NEWL3_removeCollectionBlockedByActiveLoan` at line 826 expects `bytes("ACTIVE_LOANS_PRESENT")`. Cosmetic — gas inefficient and inconsistent with codebase style.

**Severity: LOW.**

---

## MEDIUM

### M-1 — `acceptOffer` does NOT verify `whitelistedCollections` was true at *offer creation* — only at *acceptance*
Line 352: `if (!whitelistedCollections[collateralContract]) revert CollectionNotWhitelisted();`. Correct guard, but combined with the 24h whitelist add timelock (`WHITELIST_TIMELOCK = 24 hours`, line 59) and existence-only check at offer creation, this means:
1. Lender can create an offer for a collection that is **not yet whitelisted** at the time of offer creation? **NO** — line 272 in `createOffer` already enforces `whitelistedCollections[_collateralContract]`. So this concern is **mitigated**.

**Verdict**: Not a finding. False alarm.

### M-2 — `repayLoan` callable when paused; `acceptOffer` only blocked by `whenNotPaused` — but `cancelOffer` is also pause-bypassable
Line 312: `cancelOffer` lacks `whenNotPaused`. Line 405: `repayLoan` intentionally lacks it (comment line 403 explicitly says "Callable even when paused — prevents forced defaults during pause."). `claimDefault` (line 472) DOES have `whenNotPaused`. **Asymmetry**: paused state allows `repayLoan` (safety) but blocks `claimDefault` — this is consistent with not letting lenders auto-seize during emergencies. `cancelOffer` callable while paused returns lender's escrowed ETH — also safety-positive.

**Verdict**: Intentional. Documented. **Not a finding.**

### M-3 — Grace-period timing edge: `deadline + GRACE_PERIOD` overflow trivially impossible (uint256), but borrower can repay during grace period at full deadline-time interest accrual
Lines 426 and 486 use `loan.deadline + GRACE_PERIOD` (1 hour). During the grace window, `block.timestamp > deadline`, so `calculateInterest` returns interest computed up to `block.timestamp`, not `deadline`. Borrower pays interest for the *post-deadline grace period* even though loan is contractually overdue. Effectively borrower pays a small "late fee" during grace — fine and intentional. **Not a finding.**

### M-4 — Active-loan counter underflow guard with silent no-op masks bugs
Lines 440-442 (`repayLoan`) and 491-493 (`claimDefault`):
```solidity
if (activeLoansOfCollection[collateralContract] > 0) {
    activeLoansOfCollection[collateralContract] -= 1;
}
```
The `> 0` guard is defensive — but if the counter is ever incorrectly at 0 when it should be >0 (e.g., due to a future code change), the decrement silently no-ops, masking the bug. Better: assert/revert. However given Solidity 0.8 already underflow-reverts and this is unreachable today (every `+= 1` in `acceptOffer` is paired 1:1 with `-= 1` in either `repayLoan` or `claimDefault`, both terminal states), the guard is harmless.

**Severity: LOW (defensive but masks future bugs).**

### M-5 — `originationFee` deducted from lender's principal but offer events log reduced principal (cosmetic / UI display issue for lender expectation)
Line 282: `effectivePrincipal = _principal - originationFee` is what gets stored and emitted (line 302). Lender sent `_principal` but offer ledger shows `effectivePrincipal`. Borrower receives `effectivePrincipal`. **Behaviorally correct** — the fee is real and goes to treasury (line 284). The offer's `principal` field reflects what the borrower will receive and what the loan is for. UI reading the event sees the "effective" amount. No security issue; could surprise lenders if not signposted. NatSpec does cover it (line 279-280).

**Verdict: Documented. Not a finding.**

### M-6 — Min APR not enforced on existing offers, only on new `createOffer`; lender can create 0% APR offer before governance raises `minAprBps`
Line 268: `if (_aprBps < minAprBps) revert AprTooLow();` only fires at offer creation. **Pre-existing offers** with `aprBps < minAprBps` remain valid and acceptable. This is **expected** — governance changes shouldn't retroactively invalidate user-funded offers. Borrowers can still accept old 0% APR offers. **Documented behavior, by design.**

**Verdict: Not a finding.**

### M-7 — Loan offer `tokenId` is fixed at offer creation, so collateral-swap attack (borrower swaps in worse NFT) is prevented (test_acceptOffer_revert_borrowerCannotPickDifferentTokenId verifies this) ✓ MITIGATED

---

## LOW

### L-1 — `LoanTooRecent` check (line 423) prevents same-block repay, but borrower could MEV-frontrun-accept then immediately try to repay in the *next* block with 1s elapsed = paying ~negligible interest (effectively free flash loan)
With pro-rata interest at 1 second elapsed, interest ≈ 0 (rounded up to 1 wei via ceilDiv on line 546 — minimum 1 wei interest). For 1 ETH at 1000 BPS APR, 1 second ≈ 31 wei interest. **Effectively free 1-block loan.** This isn't necessarily exploitable (borrower transferred NFT in, contract sent ETH out, NFT returned on repay — net zero) but provides a free 1-block ETH loan / collateral-test mechanism. Combined with `MIN_DURATION = 1 days` (line 43), this is curious — the contract enforces a 1-day MINIMUM duration but allows borrower to exit after 1 block paying ~1 wei interest. **Lender effectively cannot lock collateral for 1 day** — borrower controls when to exit.

**Severity: LOW — operational impact only.** Lender knows this when offering. Could be converted to an ATTACK if borrower could front-run cancellation: lender creates offer, borrower accepts immediately, lender tries to cancel → revert because already accepted.

### L-2 — `cancelOffer` no `whenNotPaused`; allows lender to drain escrowed ETH during pause
Line 312-326. Probably intentional (returning lender's own ETH should not be blocked by pause). **Documented behavior.**

### L-3 — Whitelist removal proposal can sit indefinitely until active loans clear (DoS by adversarial last-borrower)
A malicious lender + borrower pair can keep a scam collection un-removable by perpetually rolling fresh offers/loans against it. Once the *current* active loan terminates, the counter drops to 0; if the same lender immediately creates another offer for the same collection, a new active loan can be opened (after acceptance). Owner must time the `executeRemoveCollection` between active loans. With `MAX_DURATION = 365 days` and offer-only (no acceptance) state being non-blocking, the attacker's window is bounded. **Adversarial inconvenience, not security loss.**

**Severity: LOW.**

### L-4 — `proposeRemoveCollection` does NOT block new `createOffer` calls for the same collection during the timelock window
Once `proposeRemoveCollection(X)` is called, `createOffer` for X still succeeds for the next 24h until execute fires. New offers can fund new loans. This extends the window L-3 talks about. Could be tightened by setting a `pendingRemoval[X] = true` flag and rejecting `createOffer` for collections with pending removal. **Operational, not exploit.**

**Severity: LOW.**

### L-5 — `getRepaymentAmount` is callable for already-repaid / already-defaulted loans and returns a stale "phantom" repayment number
Line 555-560. View function does not check `loan.repaid` or `loan.defaultClaimed`. UIs reading this for already-closed loans see a meaningless number. Minor UX bug. **Severity: INFO.**

### L-6 — `isDefaulted` (line 563) uses `block.timestamp > l.deadline` (no grace period) but `claimDefault` requires `block.timestamp > deadline + GRACE_PERIOD` (line 486)
This means `isDefaulted` returns `true` during the grace window when `claimDefault` would still revert with `LoanNotDefaulted`. UI inconsistency — frontends checking `isDefaulted` would think they can claim when they can't.

**Severity: LOW — UX/UI correctness.**

---

## INFO

### I-1 — `_ceilDiv(a, b)` (line 550) is **unsafe for `b == 0`** but only called with `BPS * SECONDS_PER_YEAR` which is constant non-zero. Safe by construction. ✓

### I-2 — All ETH transfers route through `WETHFallbackLib.safeTransferETHOrWrap` with 10000-gas stipend (per WETHFallbackLib line 46). Prevents reentrancy via receive(). ✓ Battle-tested.

### I-3 — No EIP-712 signed offers, no permit, no off-chain signatures → no signature-malleability, no permit-replay, no chainid-replay, no deadline-absent-on-offer attacks. **N/A by design.**

### I-4 — No royalty payment logic (loan repayment is plain ETH, not a sale) → royalty bypass concerns N/A.

### I-5 — No partial liquidation; loan is binary (full repay or full seizure). No partial-liquidation accounting bugs. ✓

### I-6 — No `onERC721Received` handler on the contract. Contract receives via direct `transferFrom` (no callback path). Safe.

### I-7 — No support for ERC-1155. Documented. Out of scope.

### I-8 — `Offer.principal` after origination fee is what borrower receives. NatSpec at line 256 says "The ETH principal (must match msg.value)" — slight mismatch with effective principal stored. Could be clearer in NatSpec, but not a security finding.

### I-9 — Initial whitelisted collections are hardcoded in constructor (line 238-244 — JBAC, Nakamigos, GNSS Art) without timelock. Acceptable (constructor only, deployer-set).

### I-10 — `MAX_PRINCIPAL = 1000 ether` (line 41) caps single-loan exposure. Total contract TVL not capped — many parallel offers can accumulate.

### I-11 — Re-entrancy: all state-mutating externals have `nonReentrant`. CEI followed (state set before external calls). ✓

### I-12 — Pausable surface: `createOffer` paused, `acceptOffer` paused, `claimDefault` paused. `repayLoan`, `cancelOffer` NOT paused. Asymmetry intentional (favor borrower exit during emergencies).

---

## Test Gaps (TegridyNFTLending.t.sol)

1. **No test for grace-period repayment** — borrower repays at `deadline + 30 minutes` should succeed; at `deadline + 61 minutes` should revert. Currently `test_repayLoan_revert_pastDeadline` warps to `+31 days` (well past grace). Coverage gap on the 1h grace boundary.
2. **No test for `claimDefault` during grace window** — should revert with `LoanNotDefaulted` between `deadline` and `deadline + GRACE_PERIOD`. Current `test_claimDefault_success` warps to `+31 days`.
3. **No test for `isDefaulted` vs `claimDefault` UI inconsistency** (L-6). `isDefaulted` returning `true` during grace window where `claimDefault` reverts.
4. **No test for `getRepaymentAmount` on already-repaid loan** (L-5).
5. **No test for origination fee deduction** — `originationFeeBps` paths (lines 281-286) untested. Lender's principal reduction not asserted in any test. The `OriginationFeeCollected` event emission untested.
6. **No test for min-APR enforcement** — `minAprBps` proposal/execute path untested. `AprTooLow` revert untested.
7. **No test for WETH fallback** — when borrower or lender is a contract that rejects ETH (`ETHRejecterNFTLending` is defined at line 36 but unused in any test). The whole `WETHFallbackLib.safeTransferETHOrWrap` fallback branch (lines 50-52 in the lib) is untested.
8. **No test for `cancelOffer` while paused** — should succeed (no `whenNotPaused`).
9. **No test for `LoanTooRecent` revert** (line 423) — same-block repay attempt.
10. **No test for `executeRemoveCollection` after grace window: counter is 0 but PROPOSAL_VALIDITY (7d) may have expired** — interaction with TimelockAdmin's expiry not exercised.
11. **No reentrancy attack test** — no MaliciousLender/MaliciousBorrower contract attempts re-entrancy via callbacks. Note `transferFrom` on ERC-721 has no callback, but a callback-capable ERC-721 (custom mock) could be tested.
12. **No test for `proposeRemoveCollection` followed by `createOffer` for same collection** (L-4 surface).
13. **No fuzz test** for `calculateInterest` invariants (e.g., monotonic in elapsed; ≤ principal × MAX_APR for any input).
14. **No test for `MAX_PRINCIPAL` boundary** (`1001 ether` reverts but `1000 ether` exact succeeds — only the revert is tested, line 145-152).
15. **No test for `MAX_DURATION` exact boundary** (365 days succeed, 366 revert — only revert tested, line 178-188).
16. **No test asserting `WETHFallbackLib`'s 10000-gas-stipend** is the binding limit (no contract that consumes 10001+ gas in receive triggers fallback).

---

## Summary

| Severity | Count |
|----------|-------|
| HIGH     | 0 (all candidates downgraded after review — design choices documented & sound) |
| MEDIUM   | 0 (all candidates resolved or by-design) |
| LOW      | 6 |
| INFO     | 12 |
| Test gap | 16 |

**Top-3 most actionable findings:**
1. **L-6** — `isDefaulted` view excludes grace period while `claimDefault` requires it. UI/UX inconsistency. Fix: align `isDefaulted` to `block.timestamp > l.deadline + GRACE_PERIOD`.
2. **L-1** — Same-block-after-1s repay yields effectively-free flash loan via NFT collateral. Consider a minimum interest floor (e.g., 1 day's worth) to make sub-day repayments uneconomical.
3. **Test-gap-7** (origination fee + min APR + WETH fallback + grace boundary) — the AUDIT C7/H5/H-02 fixes ship without tests covering their happy-path or revert-path. High blast radius if any of the 3 features regress silently.

**Top forensic concerns at audit-target level**: NONE rising above LOW. The contract is well-defended in scope (no oracle = no oracle attack; on-chain offers only = no signature replay; ERC-721 only with `transferFrom` = no receiver-hook reentrancy; WETHFallbackLib + nonReentrant + CEI throughout). The biggest real-world risk surface is **borrower wash-trading manual NFT valuation** which is acknowledged as the lender's-risk-by-design model (Gondi pattern, line 22).
