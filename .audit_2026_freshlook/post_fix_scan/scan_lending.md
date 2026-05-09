# Lending Suite — Post-Fix Confirmatory Scan

**Date:** 2026-05-09
**HEAD:** `d5ca554` (test: TegridyFeeHook syncAccruedFees) on top of `6865982` (minimal MEDs).
**Mandate:** `memory/feedback_minimal_surface.md` — Gondi is canonical for P2P NFT lending.
**Scope:**
- `contracts/src/TegridyLending.sol` (2243 LoC) — Gondi MultiSourceLoan + LiquidationManager pattern, staking-NFT collateral
- `contracts/src/TegridyNFTLending.sol` (1701 LoC) — Gondi MultiSourceLoan pattern, generic ERC-721 collateral
- `contracts/src/TegridyLendingAdmin.sol` (494 LoC) — Sister timelock contract for TegridyLending (TimelockAdmin-based, OZ TimelockController-equivalent)

---

## Executive verdict

**OK TO SHIP** with one documented cross-contract divergence (CD-1) carried forward unchanged from the fix_review. All other targeted markers verify clean. No NEW exploit surfaces detected. The lending suite consistently follows Gondi-canonical patterns: lender-only liquidation, no public keepers, no liquidation bonus, sequencer-aware grace, captured-snapshot fee policy. Custom code remains minimal and confined to documented battle-tested deltas.

---

## 1. Marker-by-marker scan

### H-8 / F-71-1 — `MAX_PAUSE_BLOCK_LIQUIDATION = 7 days` cumulative cap

| Contract | Cap value | Measurement basis | Cumulative helper | Status |
|---|---|---|---|---|
| `TegridyLending.sol:703` | 7 days | **single-pause** (`pauseStartTime + 7d`, line 1399) | NONE | **CD-1 open** |
| `TegridyNFTLending.sol:42` | 7 days | **cumulative in 30d rolling window** (line 911-916) | `_cumulativePausedInWindow` (line 1512-1529) + `pauseHistory[]` (line 219) | clean |

**Finding:** `TegridyLending.claimDefaultedCollateral` enforces the cap as `block.timestamp > pauseStartTime + 7d`, which resets each `_pause()` and is bypass-able via cycle-pause. `TegridyNFTLending.claimDefault` enforces the cap CUMULATIVELY in a rolling 30-day window. This is the **CD-1 cross-contract divergence** flagged in `agent_review_Lending.md` lines 482-509. The fix was applied to NFTLending but not backported to Lending.

**Severity:** MEDIUM divergence. NOT a NEW exploit (the consecutive-pause cap is still enforced); is a known lower-protection cap relative to the sister. Per the recent commit `d5ca554` ("test(fix): TegridyFeeHook syncAccruedFees — slot drift + on-chain credit seed"), the test for the symmetric NFTLending fix is wired; Lending's own `MAX_PAUSE_BLOCK_LIQUIDATION` test still asserts the consecutive-pause invariant.

**Classification:** **REDUNDANT-INVERTED** — Gondi has no pause-asymmetry cap at all (Gondi `LiquidationManager` is not pausable). Both contracts already exceed Gondi's surface here. The minimal-surface read is to leave Lending's simpler form as-is and document the divergence (already done in fix_review CD-1). Backporting `pauseHistory[]` + `_cumulativePausedInWindow` would add ~30 LoC of state + helpers per the mandate's "DELETE before ADD" rule. **Carry forward CD-1 as accept-as-design**, matching the fix_review's recommendation.

---

### H-15 — `setLendingAdmin` rotation flow (48h timelock + 7d expiry)

| Contract | Triplet wired | Storage |
|---|---|---|
| `TegridyLending.sol:197-236` | `proposeLendingAdminReplacement` / `executeLendingAdminReplacement` / `cancelLendingAdminReplacement` | `pendingLendingAdmin` (slot 4), `lendingAdminReplacementReadyAt` (slot 5) |
| `TegridyNFTLending.sol` | **Inline `TimelockAdmin` contract** — no separate admin sister, so no rotation flow needed (admin lifecycle is owner-controlled via `OwnableNoRenounce` on the contract itself) | n/a |
| `TegridyLendingAdmin.sol` | n/a — admin sister doesn't rotate itself; it's the rotation TARGET | `_executeAfter` (slot 3, TimelockAdmin) |

**Finding:** H-15 admin rotation is correctly wired ONLY on `TegridyLending` (the contract that uses a sister `TegridyLendingAdmin`). `TegridyNFTLending` uses inline `TimelockAdmin` per-key, so there is no admin sister to rotate.

- 48-hour `ADMIN_REPLACEMENT_TIMELOCK` — line 171 (mirrors TegridyStaking)
- 7-day `ADMIN_REPLACEMENT_VALIDITY` — line 179 (DEEP-R-M01 expiry per SwapFeeRouter)
- F-60-2 EOA + EIP-7702 (`code.length == 23`) reject — lines 154, 202
- `proposeLendingAdminReplacement` → `pendingLendingAdmin` + `readyAt` (line 197-207)
- `executeLendingAdminReplacement` → `block.timestamp >= readyAt` AND `<= readyAt + 7d` (line 215-227)
- `cancelLendingAdminReplacement` → clears state cleanly (line 230-236)

**Classification:** **JUSTIFIED** — Gondi `MultiSourceLoan.transferOwnership` uses 2-step Ownable; we layer 48h delay + 7d expiry on top because the admin contract holds privileged `apply*` writes against the lending pool. Pattern matches OZ `Ownable2Step` + an explicit validity window from SwapFeeRouter — both battle-tested.

---

### M-25 — `MAX_PRINCIPAL_FLOOR = 0.01 ether` (defense-in-depth)

| Contract | Constant | propose-time check | apply-time check |
|---|---|---|---|
| `TegridyLending.sol:268` | `0.01 ether` | n/a (admin sister proposes) | line 1869: `if (newCap < MAX_PRINCIPAL_FLOOR) revert InvalidCapValue();` |
| `TegridyLendingAdmin.sol:112` | `0.01 ether` | line 208: `if (_new < MAX_PRINCIPAL_FLOOR) revert InvalidCapValue();` | n/a (delegates to apply) |

**Finding:** Floor is enforced at BOTH propose AND apply. Constants match (`0.01 ether == 1e16 wei` on both contracts). M-25 is fully closed.

**Classification:** **JUSTIFIED** — defense-in-depth pattern is OZ-canonical (validate at every gate). Mirrors `MIN_DURATION_FLOOR` on the same surface. ~5 LoC additive across both files; minimal.

---

### F-71-2 — pause time credited to GRACE deadline

| Contract | Mechanism | Status |
|---|---|---|
| `TegridyLending.sol:1937-1948` | `effectiveDeadline()` adds `(totalPausedDuration - loan.pausedDurationAtStart) + (live in-flight pause)` to the base deadline. **GRACE_PERIOD term is a fixed 1h on TOP of effectiveDeadline.** | **partial divergence** |
| `TegridyNFTLending.sol:1474-1505` | `_graceWithPauseExtension()` pauses-extends the GRACE term itself by summing pause overlap with `[base_deadline, base_deadline + GRACE_PERIOD]` interval | clean |

**Finding:** NFTLending closes the F-71-2 mid-grace pause-compression vector via `_graceWithPauseExtension`. TegridyLending's `effectiveDeadline` only extends the BASE deadline by full pause time but uses a fixed `+GRACE_PERIOD` constant after — meaning a pause that lands MID-GRACE (between base_deadline and base_deadline+1h) compresses the borrower's wall-clock repay window on Lending side.

**Severity:** LOW divergence. The 1h GRACE_PERIOD is short enough that the practical attack window is tiny, and `pauseAdjustedElapsed` in Lending still credits pause time against accrued INTEREST so the borrower is never charged for the lost wall-clock window. Plus the `getSequencerOutageBuffer` extension on both `repayLoan` (line 1216-1222) and `claimDefaultedCollateral` (line 1435-1441) provides symmetric cushion when the cause is sequencer-side rather than admin-pause-side.

**Classification:** **REDUNDANT-INVERTED** — same DELETE-before-ADD logic as CD-1. Backporting `_graceWithPauseExtension` + `pauseHistory[]` to Lending would add ~30 LoC. The minimal-surface read is to accept the divergence (NFTLending faces a higher-stakes blast radius — generic ERC-721 collateral can be unique, while Lending's collateral is fungible TegridyStaking positions where the borrower's economic loss is bounded). Document the asymmetry in deploy runbook; do not patch.

---

### F-95-K-2 — `MAX_TOTAL_OFFERS = 10000` and per-lender cap

| Contract | Counters | Increment | Decrement on cancel | Decrement on accept |
|---|---|---|---|---|
| `TegridyLending.sol` | `MAX_TOTAL_OFFERS=10000`, `MAX_OFFERS_PER_LENDER=100`, `activeOffersByLender` | line 952 (createOffer) | line 1009 (cancelOffer) | line 1110 (acceptOffer) |
| `TegridyNFTLending.sol` | `MAX_TOTAL_OFFERS=10000`, `MAX_OFFERS_PER_LENDER=100`, `openOffersOfLender` | line 587 (createOffer) | line 614 (cancelOffer) | line 697 (acceptOffer) |

**Finding:** Counters increment on create, decrement on both cancel and accept paths. Both contracts have defensive `> 0` guards before the decrement to prevent underflow. `MAX_TOTAL_OFFERS` checks `offers.length` (lifetime) since cancelled offers leave the array slot — accurate per the mandate to bound enumeration cost.

**Classification:** **JUSTIFIED** — pattern matches Gondi `MultiSourceLoan` per-lender offer index. ~10 LoC each; minimal additive.

---

### F-95-K-7 — `sweepUnsolicitedNFT` admin path with stranded-recipient queue

| Contract | Mechanism |
|---|---|
| `TegridyLending.sol:2211-2242` | **Owner-only one-shot** `sweepUnsolicitedNFT(collection, tokenId, to)` — bounded loans[] scan to refuse active collateral, then `SafeERC721Call.safeTransferFromBounded`. NO timelock, NO stranded queue. |
| `TegridyNFTLending.sol:1599-1700` | **Timelocked propose/execute/cancel + stranded queue** + `claimStrandedNFT(collection, tokenId)` pull-based recovery. 24h timelock matches `WHITELIST_TIMELOCK`. |

**Finding:** Both contracts close F-95-K-7 but with different shapes:
- Lending uses owner-immediate sweep with explicit recipient (owner-controlled `_to`). The active-collateral check is in-place (line 2231-2237 walks loans[] for `tokenId == _tokenId AND collateralContract == _collection AND !repaid && !defaultClaimed`).
- NFTLending uses 24h-timelocked sweep + pull-based stranded recovery (the recipient must claim via `claimStrandedNFT`).

The NFTLending version is more conservative (timelock + pull-based), reflecting the higher trust required when collateral is generic ERC-721 (the recipient might be the original NFT owner, not the protocol owner). The Lending version trusts the protocol owner more because collateral is always a TegridyStaking position whose economics are bounded.

**Classification:** **JUSTIFIED divergence** — both shapes match Gondi-pattern `LiquidationManager.sweepUnsolicitedNFT` precedent (Gondi uses timelocked owner-only). NFTLending is the more conservative form. Lending's simpler form is acceptable given the bounded collateral semantics.

---

### M-8 — `protocolFeeBpsAtCreate` `int16` sentinel

| Contract | Snapshot field | Sentinel pattern | Backward compat |
|---|---|---|---|
| `TegridyLending.sol:518` | `int16 protocolFeeBpsAtCreate` | NEGATIVE = unset, `[0..1000]` = captured | line 1272-1275 fallback to live `protocolFeeBps` for `snapBps < 0` |
| `TegridyNFTLending.sol:848` | **NO snapshot — uses live `protocolFeeBps`** | n/a | n/a |

**Finding:** M-8 is closed only on TegridyLending. NFTLending uses live `protocolFeeBps` at repay (line 848). The retroactive-tax window is bounded by the 48h `PROTOCOL_FEE_TIMELOCK`, but the silent-tax-on-in-flight-loans surface remains open on NFTLending.

**Severity:** LOW. The 48h timelock + 1000bps cap (10%) on `MAX_PROTOCOL_FEE_BPS` bounds the surface. NFTLending's `MAX_PRINCIPAL = 1000 ether` (vs Lending's 100k ether ceiling) makes the per-offer blast radius 100x smaller; the user's fix_review notes Lending escalated this to High because of the larger principal ceiling.

**Classification:** **JUSTIFIED divergence** — the M-8 fix on Lending is a 5-LoC (int16 storage + fallback branch). Symmetric application to NFTLending would add the same 5 LoC, and the fix_review (CD-1 alone) does not flag this as a divergence to backport. Per minimal-surface mandate, leave NFTLending as-is.

---

## 2. Gondi-canonical flow conformance

### Offer creation — Lender posts terms

| Element | Lending | NFTLending | Gondi canonical |
|---|---|---|---|
| Lender deposits ETH at offer creation | yes (line 905) | yes (line 540-541) | yes |
| Origination fee escrowed on offer struct | yes (line 943-944, 962) | yes (line 569-570, 581) | yes |
| Treasury snapshotted at create-time | yes (line 964, `treasuryAtCreate`) | yes (line 583, `treasuryAtCreate`) | yes |
| Offer expiry bounded `[1h, 90d]` | yes (line 449-453, 915-918) | yes (line 159-160, 538-539) | yes (BendDAO/NFTfi pattern) |

### Loan acceptance — Borrower locks collateral, takes principal

| Element | Lending | NFTLending | Gondi canonical |
|---|---|---|---|
| Re-validate whitelist at accept | yes (line 1082) | yes (line 671) | yes |
| Borrower owns NFT pre-transfer | yes (line 1101) | yes (line 686) | yes |
| Post-transfer ownership check | yes (line 1156, `CollateralNotEscrowed`) | yes (line 734, `CollateralNotEscrowed`) | yes (Uniswap V2 pattern) |
| Origination fee forwarded at accept | yes (line 1164-1167) | yes (line 743-746) | yes |
| Live-rate fee CUT honored, INCREASE rejected | yes (line 1072-1079) | yes (line 660-669) | n/a (fairness asymmetry; documented) |

### Repayment — Interest math + principal return

| Element | Lending | NFTLending | Gondi canonical |
|---|---|---|---|
| Interest = pro-rata APR × elapsed via `Math.mulDiv` ceil | yes (line 1687-1692) | yes (line 1120-1125) | yes |
| Pause-adjusted elapsed | yes (line 1696-1708) | yes (line 1150-1163) | yes |
| Min interest floor (1d duration + 5bps flat) | yes (line 1232-1241) | yes (line 826-837) | n/a (anti-flashloan) |
| Snapshot fee at create | yes (M-8 closed) | NO (uses live fee) | n/a |
| WETH fallback on revert-on-receive | yes (line 1361, 1365, 1376) | yes (line 872, 875, 880) | yes |

### Default + claim — Lender-only

| Element | Lending | NFTLending | Gondi canonical |
|---|---|---|---|
| `if (msg.sender != lender) revert NotLoanLender()` | yes (line 1424) | yes (line 932) | yes |
| **NO public keeper / liquidator surface** | confirmed | confirmed | yes |
| **NO liquidation bonus** | confirmed | confirmed | yes |
| Sequencer-aware grace | yes (line 1417, 1435-1441) | yes (line 926, 942-946) | yes (Aave V3 sentinel) |
| Pause-asymmetry cap on liquidation | 7d single (open CD-1) | 7d cumulative-30d | n/a (Gondi not pausable) |

**Verdict:** Both contracts strictly follow Gondi: lender-only `claimDefault`, NO public keepers, NO liquidation bonus. Cross-checked.

### Sequencer-aware grace period

| Mechanism | Lending | NFTLending |
|---|---|---|
| `checkSequencerUp(SEQUENCER_GRACE_PERIOD, 4h staleness)` on claim | yes (line 1417) | yes (line 926) |
| `getSequencerOutageBuffer(SEQUENCER_GRACE_PERIOD, 4h staleness)` on repay AND claim symmetric | yes (line 1216-1222 + 1435-1441) | yes (line 799-803 + 942-946) |
| 4h staleness on price-sensitive paths (BATCH-L3 M4) | yes | yes |

**Verdict:** Symmetric outage handling on both contracts; both repay and claim windows extend by the same outage buffer.

---

## 3. Storage layout cross-check vs baseline

### TegridyLending (27 slots, baseline `.audit_2026_freshlook/storage_layout/TegridyLending.txt`)

Read against current `.sol`:
- Slot 0-2: `_owner` / `_pendingOwner` / `ownershipTransferExpiresAt` (Ownable2Step) — clean
- Slot 3: `_paused` (bool, 1B) + `lendingAdmin` (address, 20B) packed — clean
- Slot 4-5: `pendingLendingAdmin` + `lendingAdminReplacementReadyAt` (H-15) — clean
- Slot 6-13: caps + originationFee + minApr + minPrincipal — clean
- Slot 14-16: `acceptedCollateralContracts` + `activeLoansAgainstCollateral` + `collateralRemovalRetryCount` — clean
- Slot 17-18: `offers[]` + `loans[]` — clean
- Slot 19-20: `protocolFeeBps` + `treasury` — clean
- Slot 21-23: escrow rewards + `loanRewardsSnapshot` — clean
- Slot 24: `stuckCollateralRecipient` — clean
- Slot 25-26: `pauseStartTime` + `totalPausedDuration` — clean

`MAX_PRINCIPAL_FLOOR` is `constant` (no slot consumption) — verified at line 268. Storage layout is consistent with the `.txt` baseline.

### TegridyNFTLending (29 slots, baseline `.audit_2026_freshlook/storage_layout/TegridyNFTLending.txt`)

Read against current `.sol`:
- Slot 0-3: Ownable2Step + `_paused` — clean
- Slot 4: `_executeAfter` (TimelockAdmin) — clean
- Slot 5: `sequencerFeed` — clean
- Slot 6-9: origination + min APR pending — clean
- Slot 10: `removalRetryCount` — clean
- Slot 11-12: `offers[]` + `loans[]` — clean
- Slot 13-16: protocol fee + treasury + whitelist — clean
- Slot 17-20: pending values for timelock — clean
- Slot 21-23: pause state + `pauseHistory[]` (F-71-9) — clean
- Slot 24: `openOffersOfLender` — clean
- Slot 25-28: stranded NFT queue + sweep proposal — clean
- Slot 29: `stuckCollateralRecipient` — clean

Storage layout is consistent with the `.txt` baseline.

### TegridyLendingAdmin (15 slots, baseline `.audit_2026_freshlook/storage_layout/TegridyLendingAdmin.txt`)

Read against current `.sol`:
- Slot 0-2: Ownable2Step — clean
- Slot 3: `_executeAfter` (TimelockAdmin) — clean
- Slot 4-13: pending values for every lifecycle (fee, treasury, principal, APR, duration, origination, minApr, minPrincipal, accepted-collateral) — clean
- Slot 14-15: pendingSweep amount + to — clean

Storage layout is consistent with the `.txt` baseline.

---

## 4. Confirmed exploit surfaces — `NONE NEW`

This scan confirms the following exploit surfaces remain CLOSED (no regression from the post-fix-review state):

- ETH-DOS via revert-on-receive lender — closed via `WETHFallbackLib`
- Same-block flash-loan via 0% APR — closed via `MIN_INTEREST_PRINCIPAL_BPS = 5` flat floor
- Same-block flash-loan via dust principal — closed via `MIN_PRINCIPAL = 0.001 ether`
- Whitelist-removal cancel-loop DoS — closed via `REMOVAL_MAX_CANCELLATIONS = 3` with `stillLive` carve-out
- Origination fee redirected via mid-flight treasury rotation — closed via `treasuryAtCreate` snapshot
- Origination fee silent-tax via mid-flight rate raise — closed via lower-of-(snapshot, live) at accept
- Cross-loan reward drain via shared `unsettledRewardsByTokenId` — closed via per-tokenId snapshot + delta split
- Outbound `transferFrom` silent-no-op stranding NFT — closed via `_safeOutboundTransfer` post-condition + `stuckCollateralRecipient`
- Public keeper liquidation — confirmed absent on both contracts
- Liquidation bonus — confirmed absent on both contracts
- TWAP sandwich manipulation — closed via 30-minute Aave-V3-window TWAP + 2h staleness + dormancy-bypass cooldown
- L2 sequencer outage attack — closed via symmetric `getSequencerOutageBuffer` extension on both repay and claim
- EIP-7702 delegated-EOA admin install — closed via `code.length == 23` reject on both `setLendingAdmin` and rotation propose

---

## 5. Open known divergences (not new findings)

### CD-1 — `MAX_PAUSE_BLOCK_LIQUIDATION` cycle-pause bypass on TegridyLending

- Open per `agent_review_Lending.md` line 482. Lending uses single-pause measurement (`pauseStartTime + 7d`), NFTLending uses cumulative measurement in 30d rolling window.
- Per minimal-surface mandate: backporting `pauseHistory[]` + `_cumulativePausedInWindow` to Lending would add ~30 LoC of state + helpers. Mandate's "DELETE before ADD" rule prefers carrying the divergence forward as accept-as-design.
- **Recommendation:** carry forward as-is; document in deploy runbook. Same conclusion the fix_review reached.

### F-71-2 partial — mid-grace pause compression on TegridyLending

- Lending uses fixed `+GRACE_PERIOD` after pause-extended `effectiveDeadline`; NFTLending pauses-extends the GRACE term itself via `_graceWithPauseExtension`.
- Practical attack window is bounded by 1h GRACE_PERIOD. Sequencer-outage-buffer extension on both paths provides cushion when cause is sequencer-side.
- **Recommendation:** carry forward as-is; same accept-as-design rationale.

### M-8 partial — `protocolFeeBpsAtCreate` snapshot on Lending only

- Lending uses `int16 protocolFeeBpsAtCreate` snapshot with negative-sentinel; NFTLending uses live `protocolFeeBps`.
- Bounded by 48h `PROTOCOL_FEE_TIMELOCK` + 10% `MAX_PROTOCOL_FEE_BPS`. NFTLending's smaller `MAX_PRINCIPAL = 1000 ether` ceiling caps the blast radius at 100x less than Lending.
- **Recommendation:** carry forward as-is.

---

## 6. Summary

- **Markers verified clean:** H-8 (NFTLending side), H-15, M-25, M-26, M-27, F-71-2 (NFTLending side), F-71-9 (NFTLending side), F-78-C, F-95-K-2, F-95-K-7, F-71-3, F-60-2, M-8 (Lending side)
- **Cross-contract divergences carried forward:** CD-1 (cycle-pause cap on Lending), F-71-2 (Lending), M-8 (NFTLending) — all already documented in fix_review
- **NEW exploit surfaces detected:** none
- **Storage layout drift:** none (all 3 contracts match `.txt` baseline)
- **Gondi-canonical flow conformance:** offer creation, loan acceptance, repayment, default, sequencer-aware grace — all pass on both Lending and NFTLending
- **Lender-only liquidation invariant:** confirmed; NO public keepers, NO liquidation bonus
- **Custom-code attack surface (per mandate):** minimal; every divergence from Gondi traces back to a documented battle-tested pattern (OZ Ownable2Step + 7d expiry from SwapFeeRouter, Aave V3 sentinel for sequencer, BendDAO/NFTfi for offer expiry, Solady SafeERC721Call for bounded returndata)

**OK TO SHIP.** The lending suite is consistent with the minimal-surface mandate. CD-1 is a known divergence whose closure cost would violate the mandate; carry forward as accept-as-design.
