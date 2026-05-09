# Sibling-Miss Hunt — Post-Fix Scan 2

**Reviewer:** Sibling-miss hunt agent (fresh-2026)
**Date:** 2026-05-09
**Scope:** Verify the original 100-agent audit's T-1 ("sibling miss" / asymmetric
defence-in-depth) examples are closed, and search for NEW T-1 instances on
current HEAD (`d5ca554`).
**Mandate:** `memory/feedback_minimal_surface.md` — minimal surface, sibling-port
existing primitives, NOT new machinery.

---

## SECTION 1 — Original T-1 Examples: PASS / FAIL

| ID    | Description                                                                   | Status      | Notes                                                                                  |
| ----- | ----------------------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------- |
| M-1   | `_settleRewardsOnTransfer` shortfall route to `_settleUnsettled`              | **PASS**    | `TegridyStaking.sol:1564-1583` — both slices route to `_settleUnsettled` mirroring `_getReward`/`kick`. Verdict in `agent_review_Staking.md` Site 8 confirms cap math + per-tokenId attribution. |
| H-2   | `getReward` autoMaxLock JBAC-revalidation guard                               | **PASS**    | `TegridyStaking.sol:1069-1088` — `jbacStillValid` check (deposit OR balanceOf) added; stale flag cleared on miss. Mirrors `revalidateBoost` legacy semantic. Low-residual flash-borrow caveat acknowledged. |
| H-8   | `MAX_PAUSE_BLOCK_LIQUIDATION` cap on TegridyNFTLending.claimDefault            | **PASS**    | `TegridyNFTLending.sol:907-916` uses cumulative window (`_cumulativePausedInWindow` line 1512-1529); F-71-9 closed cycle-pause vector. **BUT see CD-1 below — TegridyLending sister still uses single-pause measurement.** |
| H-13  | `lastBypassUsed` written on every TWAP bypass branch                          | **PASS**    | `TegridyTWAP.sol:518` (count==0), `:568` (count<=2 BATCH-M3 H7 grace), `:622` (dormancy), `:640` (sequencer-outage / bridging-gap). All bypass writes paired with `DeviationBypassed` event. |
| H-15  | Backport admin replacement to TegridyLending + VoteIncentives admin pointers  | **FAIL**    | TegridyLending closed at `:171-236` (propose/execute/cancel + 48h+7d windows); SwapFeeRouter closed at `:1095-1132`; TegridyStaking closed at `:1923-1935`. **VoteIncentives `setVoteIncentivesAdmin:145-151` is STILL one-shot — no propose/execute/cancel pair exists.** See finding S-1 below. |

---

## SECTION 2 — NEW Sibling-Miss Findings (introduced after original audit)

### S-1 [HIGH/HIGH-15 RESIDUE] — VoteIncentives admin replacement gap

**File:line (vulnerable):** `contracts/src/VoteIncentives.sol:145-151`
**File:line (sibling closed):** `contracts/src/TegridyLending.sol:197-236` and `contracts/src/SwapFeeRouter.sol:1095-1132`

**Asymmetric pattern:**
- TegridyLending has `proposeLendingAdminReplacement` (48h delay) → `executeLendingAdminReplacement` (7d validity) → `cancelLendingAdminReplacement`. Held inline so a broken admin contract cannot block its own removal.
- SwapFeeRouter has the matching `proposeAdminReplacement` / `executeAdminReplacement` / `cancelAdminReplacement` (1095-1132).
- TegridyStaking has the matching `proposeAdminReplacement` / `executeAdminReplacement` (1923-1935 with 7-day validity).
- **VoteIncentives has ONLY `setVoteIncentivesAdmin` (one-shot, line 145-151).** No propose/execute/cancel pair exists. A buggy or compromised `voteIncentivesAdmin` contract is NOT rotatable. This is exactly the H-15 gap that was supposed to be closed; the lending side was backported, vote-incentives was not.

**Minimal-surface fix shape:** sibling-port the SwapFeeRouter pattern verbatim (proposeAdminReplacement / executeAdminReplacement / cancelAdminReplacement + 48h timelock + 7d validity + EIP-7702 length-23 reject). The state slots + events already exist in SwapFeeRouter; copy the function bodies and rename. ~50 LoC delta. No new machinery.

---

### S-2 [MEDIUM] — `setRestakingContract` in 4 consumers lacks F-60-2 EOA / 7702 reject

**Files:line (vulnerable):**
- `contracts/src/VoteIncentives.sol:1135-1140`
- `contracts/src/ReferralSplitter.sol:503-508`
- `contracts/src/MemeBountyBoard.sol:354-359`
- `contracts/src/CommunityGrants.sol:1025-1030`

**File:line (sibling closed):** `contracts/src/GaugeController.sol:1097-1104`

**Asymmetric pattern:**
- GaugeController.proposeRestakingContract (line 1099-1100) checks `codeLen == 0 || codeLen == 23` (F-17-3 + F-60-2 — rejects EOAs and EIP-7702 delegated EOAs).
- TegridyStaking.proposeAdminReplacement / setStakingAdmin (line 1968-1969, 2007-2009) and TegridyStakingAdmin.proposeRestakingContract (line 187-191) carry the same F-60-2 rejection.
- **All 4 consumer contracts that read `restakingContract` for VotePowerOracle queries set the address with NO `code.length` check at all** — neither the basic `> 0` (rejects EOAs) NOR the `!= 23` (rejects 7702 delegated EOAs).

**Impact:** A captured owner could install an EOA / 7702-delegated EOA as the restaking pointer on any of the 4 consumers. The `votingEscrow.votingPower*` calls on a non-contract address would silently revert (try/catch in VotePowerOracle line 64+ swallows it as zero), permanently zeroing every restaker's voting power on that consumer. Pre-Pectra this was already an EOA footgun; post-Pectra (live 2025-05) the 7702-delegated-EOA case slips even the `code.length > 0` defense the other consumers don't have.

**Minimal-surface fix shape:** copy the 2-line check from `GaugeController.proposeRestakingContract:1099-1100` verbatim into each setter:
```
uint256 codeLen = _restaking.code.length;
if (codeLen == 0 || codeLen == 23) revert NotAContract();
```
8 LoC delta total (2 per file). No new machinery.

---

### S-3 [MEDIUM] — TegridyLending.repayLoan staleness is 24h while claimDefaultedCollateral is 4h

**File:line (vulnerable):** `contracts/src/TegridyLending.sol:1216-1219`
**File:line (sibling closed):**
- `contracts/src/TegridyLending.sol:1417` (claimDefaultedCollateral, 4h)
- `contracts/src/TegridyLending.sol:1437` (claimDefaultedCollateral outage buffer, 4h via SEQUENCER_GRACE_PERIOD only — no staleness override)
- `contracts/src/TegridyNFTLending.sol:799-803` (repayLoan, **4h**)
- `contracts/src/TegridyNFTLending.sol:942-946` (claimDefault outage buffer, 4h)

**Asymmetric pattern:**
- TegridyNFTLending.repayLoan calls `getSequencerOutageBuffer(feed, GRACE, 4 hours)` (F-71-3 fix) — symmetric with claimDefault's 4h.
- TegridyLending.claimDefaultedCollateral calls `checkSequencerUp(feed, GRACE, 4 hours)` (BATCH-L3 M4) — 4h.
- **TegridyLending.repayLoan calls `getSequencerOutageBuffer(feed, GRACE)` (2-arg overload)** which defaults to MAX_FEED_STALENESS = 24h. The sibling-port is on the same file's claim path (4h) and on the cross-file equivalent (NFTLending.repayLoan, 4h) — repayLoan was missed when the F-71-3 fix landed.

**Impact:** During a 4h-24h Chainlink keeper-lapse window, the lender's claim path uses fresh staleness (4h → fail-closed) while the borrower's repay path uses stale 24h (gives the borrower an unintended deadline extension via outage buffer when the feed is actually stale). Asymmetric handling of the same input class.

**Minimal-surface fix shape:** add a 4h argument to the existing call. 1-line change, no new machinery:
```diff
-        uint256 outageBuffer = SequencerCheck.getSequencerOutageBuffer(
-            sequencerFeed,
-            SEQUENCER_GRACE_PERIOD
-        );
+        uint256 outageBuffer = SequencerCheck.getSequencerOutageBuffer(
+            sequencerFeed,
+            SEQUENCER_GRACE_PERIOD,
+            4 hours
+        );
```

---

### S-4 [MEDIUM] — TegridyLending constructor lacks F-14-1 L2 sequencer-feed enforcement

**File:line (vulnerable):** `contracts/src/TegridyLending.sol:797-817`
**File:line (sibling closed):** `contracts/src/TegridyNFTLending.sol:462-465`

**Asymmetric pattern:**
- TegridyNFTLending constructor: `require(block.chainid == 1 || _sequencerFeed != address(0), "L2_SEQUENCER_FEED_REQUIRED");` (F-14-1 fix).
- TegridyLending constructor (line 805-817): no equivalent enforcement. Comment at line 816 says "R062: zero permitted (mainnet / non-L2 = gating disabled)" — silently allows L2 deployment with feed unset.
- The lib-side fail-closed guard (`SequencerCheck.checkSequencerUp` reverts `SequencerFeedNotConfigured` on `feed == 0 && chainid != 1`, lib lines 139-142) is the structural backstop that converts this into a runtime revert rather than silent inert protection. So the gap is at deploy time only — first-runtime-call would revert. But the **whole point of F-14-1 was to fail-loud at deploy time**, not runtime, mirroring the H-9 deploy-script require. NFTLending got both gates (constructor + script). TegridyLending got neither (no deploy script + no constructor check; though TegridyLending isn't currently in any deploy script, the structural gap remains).

**Impact:** Defense-in-depth missing. If a future deploy script is added for TegridyLending that copies the SwapFeeRouter pattern (`vm.envOr("SEQUENCER_FEED", address(0))`), the L2-with-no-feed scenario would now *silently* deploy and the runtime revert would trip on the first read instead of at construction.

**Minimal-surface fix shape:** copy the require from NFTLending verbatim. 1 LoC delta, no new machinery:
```diff
+        require(block.chainid == 1 || _sequencerFeed != address(0), "L2_SEQUENCER_FEED_REQUIRED");
         sequencerFeed = _sequencerFeed;
```

---

### S-5 [MEDIUM] — SwapFeeRouter.setSequencerFeed accepts EOA and 7702 EOAs

**File:line (vulnerable):** `contracts/src/SwapFeeRouter.sol:532-537`
**File:line (sibling closed):** `contracts/src/TegridyNFTLending.sol:513-528`

**Asymmetric pattern:**
- TegridyNFTLending.setSequencerFeed (line 513-528) checks `code.length > 0 && code.length != 23` (F-60-2 retrofit).
- SwapFeeRouter.setSequencerFeed (line 532-537) only checks `_feed != address(0)`. An EOA or 7702-delegated EOA passes silently — `IChainlinkAggregator(feed).latestRoundData()` would revert with no return data, propagating into SequencerCheck as a generic revert.

**Impact:** A captured owner who one-shots a malicious EOA-equivalent into `sequencerFeed` permanently disables the SwapFeeRouter's sequencer protection (every L2-relevant path reverts on first read). Combined with the lib's `feed == 0 && chainid != 1` revert, this turns the typed `SequencerFeedNotConfigured` selector into an opaque revert that off-chain monitors won't recognize as the F-60-2 class.

**Minimal-surface fix shape:** copy the F-60-2 check from NFTLending verbatim. ~3 LoC delta:
```diff
     function setSequencerFeed(address _feed) external onlyOwner {
         if (sequencerFeed != address(0)) revert ZeroAddress(); // already set, can't change
         if (_feed == address(0)) revert ZeroAddress();
+        uint256 codeLen = _feed.code.length;
+        if (codeLen == 0 || codeLen == 23) revert ZeroAddress();
         sequencerFeed = _feed;
```

---

### S-6 [MEDIUM/CD-1] — TegridyLending.claimDefaultedCollateral cycle-pause bypass

**File:line (vulnerable):** `contracts/src/TegridyLending.sol:1396-1402`
**File:line (sibling closed):** `contracts/src/TegridyNFTLending.sol:907-916` (cumulative window via `_cumulativePausedInWindow:1512-1529`)

**Asymmetric pattern:** previously documented as **CD-1** in `.audit_2026_freshlook/fix_review/agent_review_Lending.md` Section 3, **STILL OPEN on current HEAD**.

- TegridyNFTLending caps pause-blockable claim at 7d **CUMULATIVE** in a 30d rolling window — closes the cycle-pause weapon (pause-6d23h → unpause-1s → pause-fresh).
- TegridyLending caps at 7d measured from `pauseStartTime` only. `pauseStartTime` resets to fresh time on each `_pause` (line 1921). **Captured admin can cycle indefinitely**, indefinitely blocking lender claims.

**Impact:** Captured-owner indefinite-DoS on lender claims, exactly the same threat-model H-8 was meant to close on the NFTLending sister. The H-8 description in EXEC SUMMARY explicitly attributed F-71-9 to TegridyNFTLending only — but the structural argument applies equally to TegridyLending and the sibling-port is straightforward.

**Minimal-surface fix shape:** copy `_cumulativePausedInWindow` and `pauseHistory[]` from `TegridyNFTLending.sol:1512-1529` verbatim, plus the 7d-cumulative compare from `:907-916`. ~50 LoC delta. The push-on-_unpause hook (NFTLending line 1426-1430) needs to be added too. No new machinery — fully sibling-port.

---

### S-7 [LOW/INFO] — H-11 doc claim vs actual sister state

**File:line (doc claim):** `contracts/src/RevenueDistributor.sol:352-353` — "external observers see the same monotonic counter as the sister contracts (POLAccumulator, SwapFeeRouter)"
**File:line (sibling reality):**
- `contracts/src/POLAccumulator.sol:181, 308-318` — `totalETHReceived` not pre-warmed
- `contracts/src/SwapFeeRouter.sol:2058-2063` — `totalETHReceived` not pre-warmed

**Asymmetric pattern:** the H-11 fix in RevenueDistributor pre-warms `_totalETHReceivedRaw = 1` (constructor line 354) so the first ingress's SSTORE is non-zero→non-zero (~5k gas, fits in 10k stipend). The doc claim says POL/SFR have the same. They don't.

**Impact assessment:** **NOT exploitable in current call graph**. POL/SFR are not the target of `WETHFallbackLib.safeTransferETHOrWrap` calls anywhere in the codebase (verified via grep). They receive ETH from `SwapFeeRouter._distribute` (50k stipend, line 1334/1348) and from upstream raw `.call`s with sufficient gas. The 10k-stipend cold-SSTORE attack vector that H-11 closed for RevenueDistributor doesn't reach POL/SFR. So the doc claim is incorrect but the structural gap is not currently weaponizable.

**Minimal-surface fix shape (doc-only):** correct the comment in RevenueDistributor to say "as POLAccumulator + SwapFeeRouter would if they were hit by a 10k-stipend ETH push (currently they aren't)" OR add the same 1-wei pre-warm to POL + SFR for full symmetry. The defensive-symmetry argument favors the latter (~3 LoC each). No new machinery either way.

---

### S-8 [LOW] — TegridyTWAP.withdrawFees raw .call lacks WETH fallback

**File:line (vulnerable):** `contracts/src/TegridyTWAP.sol:884-891`
**File:line (sibling closed):**
- `contracts/src/POLAccumulator.sol:706` (`safeTransferETHOrWrap`)
- `contracts/src/RevenueDistributor.sol:531` (`safeTransferETHOrWrap`)
- `contracts/src/CommunityGrants.sol:929` (`safeTransferETHOrWrap`)

**Asymmetric pattern:** every other on-chain ETH-out path on owner-callable sweeps uses `WETHFallbackLib.safeTransferETHOrWrap` (which provides the 30k stipend + WETH fallback for revert-on-receive recipients). TegridyTWAP's `withdrawFees` (line 889) uses raw `to.call{value: amount}("")` with no stipend cap and no fallback. If `feeRecipient` rotates to a contract whose `receive()` reverts (or consumes more than the call frame allows), the path bricks permanently (no pull-pattern fallback either).

**Impact:** This is the same M-44 / M-40 pattern documented in EXECUTIVE_SUMMARY MEDIUM table. Ranked LOW here because (a) `withdrawFees` is `onlyOwner` so the threat surface is captured-owner only, (b) the existing `feeRecipient` setter is one-shot OR-rotatable so the recovery path exists. But the canonical sibling-port has been applied everywhere except this site.

**Minimal-surface fix shape:** swap the raw `.call` for `WETHFallbackLib.safeTransferETHOrWrap`. 1 LoC delta + 1 import:
```diff
-        (bool ok,) = to.call{value: amount}("");
-        require(ok, "WITHDRAW_FAILED");
+        WETHFallbackLib.safeTransferETHOrWrap(weth, to, amount);
```
TegridyTWAP would need a `weth` immutable wired through the constructor. ~5 LoC delta. No new machinery.

---

### S-9 [LOW] — TegridyTWAP.update refund leg uses raw .call (M-44 still open)

**File:line (vulnerable):** `contracts/src/TegridyTWAP.sol:401-410`

This is the previously-flagged M-44 from EXEC SUMMARY (`TegridyTWAP.update refund leg unbounded raw call`). On current HEAD it remains open: `(bool ok,) = msg.sender.call{value: excess, gas: 30000}("");` at line 403 with the failure path falling through to "bank as fee tip" (no WETH fallback).

**Sibling pattern of record:** SwapFeeRouter has analogous "excess refund" paths (e.g. `recoverCallerCredit` line 1833) that are NOT raw `.call` — they use the per-caller-credit pull pattern. TegridyTWAP's refund-on-fail "bank as fee" is structurally inconsistent.

**Minimal-surface fix shape:** replace with `WETHFallbackLib.safeTransferETHOrWrapNoRevert` returning `(success, mode)`; on `success == false || mode >= 2`, bank to fee-tip as today. No behavioral regression; structural symmetry restored. ~10 LoC delta.

---

## SECTION 3 — Out-of-Scope but Cross-Referenced

The following items show up as "asymmetric defenses" in passing during the scan but are by-design or already documented as accepted:

- **H-4 (post-snapshot pair-disable refund)** — STILL OPEN on `VoteIncentives.sol:1695` (relies on live `disabledPairs` rather than `epochSnapshotPairLive`). This is from the original audit's HIGH list and was not flagged for sibling-port — it requires a snapshot-time pair-live mapping which is **new machinery** by the minimal-surface mandate. Not a sibling-miss in the strict sense; it's an unfixed HIGH.
- **TegridyLending lacks `_graceWithPauseExtension`** for grace-extension. NFTLending has it (F-71-2). TegridyLending uses `effectiveDeadline` instead, which adds the entire `totalPausedDuration` (different design — covers the same case via different math). Design divergence, not sibling-miss.
- **GaugeController + RevenueDistributor + PremiumAccess have no admin sister contract** — `onlyOwner` direct. So the H-15 propose/execute/cancel rotation pattern is N/A. Owner rotation goes through `OwnableNoRenounce.transferOwnership` (2-step + cancel + length-23 reject for opt-in contracts).

---

## SECTION 4 — Summary Table

| ID  | Severity | File:line                                           | Sibling closed at                                         | Fix LoC | Status     |
| --- | -------- | --------------------------------------------------- | --------------------------------------------------------- | ------- | ---------- |
| M-1 | n/a      | `TegridyStaking.sol:1564-1583`                      | mirrors `_getReward` / `kick`                             | (closed)| **PASS**   |
| H-2 | n/a      | `TegridyStaking.sol:1069-1088`                      | mirrors `revalidateBoost`                                 | (closed)| **PASS**   |
| H-8 | n/a      | `TegridyNFTLending.sol:907-916`                     | sibling NOT applied to `TegridyLending` (S-6)             | (closed)| **PASS** + S-6 |
| H-13| n/a      | `TegridyTWAP.sol:518/568/622/640`                   | all 4 bypass branches stamped                             | (closed)| **PASS**   |
| H-15| HIGH     | TegridyLending closed; **VoteIncentives open (S-1)**| TegridyStaking / SwapFeeRouter / TegridyLending           | ~50     | **FAIL → S-1**|
| S-1 | HIGH     | `VoteIncentives.sol:145-151`                        | `TegridyLending.sol:197-236`                              | ~50     | NEW        |
| S-2 | MEDIUM   | 4 files (VoteInc/Referral/MemeBounty/Grants)        | `GaugeController.sol:1097-1104`                           | 8       | NEW        |
| S-3 | MEDIUM   | `TegridyLending.sol:1216-1219` (repayLoan)          | `TegridyNFTLending.sol:799-803` + same file claim path    | 1       | NEW        |
| S-4 | MEDIUM   | `TegridyLending.sol:797-817` (constructor)          | `TegridyNFTLending.sol:462-465`                           | 1       | NEW        |
| S-5 | MEDIUM   | `SwapFeeRouter.sol:532-537`                         | `TegridyNFTLending.sol:513-528`                           | 3       | NEW        |
| S-6 | MEDIUM   | `TegridyLending.sol:1396-1402` (cycle-pause)        | `TegridyNFTLending.sol:907-916,1512-1529`                 | ~50     | NEW (= CD-1)|
| S-7 | LOW/INFO | `RevenueDistributor.sol:352-353` doc claim          | POL/SFR don't have pre-warm; not currently exploitable    | 0-6     | NEW (doc-only) |
| S-8 | LOW      | `TegridyTWAP.sol:884-891` (withdrawFees raw .call)  | `POLAccumulator.sol:706` + others use WETHFallbackLib     | 5       | NEW        |
| S-9 | LOW      | `TegridyTWAP.sol:401-410` (update refund leg)       | M-44 from original audit; still open                      | 10      | NEW        |

---

## SECTION 5 — Verdict

- **4 of 5 known T-1 examples PASS** on current HEAD (M-1, H-2, H-8 NFTLending side, H-13).
- **1 of 5 known T-1 examples FAILS** (H-15 — only TegridyLending side closed; VoteIncentives still has one-shot setter).
- **9 NEW sibling-misses** identified on current HEAD: 1 HIGH (S-1), 5 MEDIUM (S-2 through S-6), 3 LOW/INFO (S-7 / S-8 / S-9).
- All 9 fix shapes are **minimal-surface sibling-ports**: total ~180 LoC across 8 files, no new machinery, every fix copies an existing in-tree primitive.
- The dominant theme is **TegridyLending vs TegridyNFTLending divergence** (S-3, S-4, S-6 — three of nine new findings) — the H-8 / F-71-x / F-14-1 wave was applied to NFTLending only. Backporting these closes a meaningful chunk of remaining captured-owner / L2-deploy gaps in one focused PR.
- The secondary theme is **F-60-2 EOA / 7702 reject not applied to every consumer** (S-2, S-5 — two of nine) — copying the GaugeController / TegridyNFTLending pattern verbatim closes both.

**Recommended order of fixes** (by impact-per-LoC):
1. **S-2** (8 LoC, MEDIUM, 4 files closed in one PR — captured-owner restaking-pointer brick).
2. **S-3** (1 LoC, MEDIUM — repayLoan staleness symmetry on TegridyLending).
3. **S-4** (1 LoC, MEDIUM — constructor sequencer-feed defense-in-depth on TegridyLending).
4. **S-5** (3 LoC, MEDIUM — SwapFeeRouter.setSequencerFeed F-60-2 retrofit).
5. **S-1** (~50 LoC, HIGH — VoteIncentives admin replacement; one-PR sibling-port from SwapFeeRouter).
6. **S-6** (~50 LoC, MEDIUM — TegridyLending cycle-pause cap; sibling-port from NFTLending).
7. **S-8** + **S-9** (15 LoC combined, LOW — TegridyTWAP WETHFallbackLib retrofits).
8. **S-7** (0-6 LoC, LOW/INFO — POL/SFR pre-warm OR doc-only correction).

Total: ~180 LoC delta across 8 files. No new abstractions. Every change cites an existing in-tree precedent verbatim.

*End of sibling-miss scan.*
