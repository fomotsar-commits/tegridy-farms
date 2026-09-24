# Tegriddy Farms — Fresh-Look Audit 2026 Executive Summary

**Aggregator:** Audit Agent 100/100
**Inputs:** 95 individual agent reports in `.audit_2026_freshlook/findings/agent_01..agent_95_*.md`
(Agents 96–99 were not produced — Agent 100 is final aggregator over the 95 that ran.)
**Date:** 2026-05-07
**Methodology:** Each upstream agent ran a single fresh-eyes lens against `contracts/src/`. This document de-duplicates cross-agent overlaps, picks a canonical instance per issue, and ranks for remediation impact.

---

## 1. Top-line Numbers

| Severity   | Count |
| ---------- | ----- |
| CRITICAL   | 1     |
| HIGH       | 17    |
| MEDIUM     | 49    |
| LOW        | 113   |
| INFO/ND/NA | 209   |

> Counts after de-duplication of cross-agent overlaps (e.g. F-03-K1 / F-93-1 / F-87-K-01 / F-65-K all reference the same expired-restake siphon — counted once at HIGH). Raw agent total before de-duplication: ~410 entries across 95 files. Severity reflects the highest assessment any agent gave the canonical issue, downgraded one band when a single agent inflated it without confirmation from sibling lenses.

---

## 2. CRITICAL Findings (1)

| ID  | Severity | File:Line                                            | Description                                                                                                                                                              | Source agents |
| --- | -------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- |
| C-1 | CRITICAL | `contracts/src/TegridyLPFarming.sol:189-242`         | `updateReward` modifier refreshes `effectiveBalanceOf` BEFORE `earned()`, retroactively crediting boost gains over the entire un-checkpointed period — Synthetix anti-pattern. | F-28-1        |

---

## 3. HIGH Findings (17)

| ID   | File:Line                                                                                  | One-line description                                                                                                                                                           | Source agents                  |
| ---- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ |
| H-1  | `contracts/src/TegridyRestaking.sol:596-659` + `:872-917`                                  | Restake of **expired-lock** position copies inflated cached `boostedAmount` from staking; siphons bonus emission until decay fires (`postClaimBoosted > 0` re-sync guard hole). | F-03-K1, F-87-K-01, F-93-1     |
| H-2  | `contracts/src/TegridyStaking.sol:1031-1040`                                               | `getReward` autoMaxLock decay-restore branch silently re-grants stale JBAC bonus on legacy `hasJbacBoost && !jbacDeposited` positions; `revalidateBoost` LockExpired guard one-way only. | F-02-K-01                      |
| H-3  | `contracts/src/TegridyRestaking.sol:1965-1982`                                              | `decayExpiredRestaker` catch-arm credits `bonusPending` (bonus-token units) into `unforwardedBaseRewards` (rewardToken-denominated) — wrong-token redemption silently swaps WETH for TOWELI. | F-04-1                         |
| H-4  | `contracts/src/VoteIncentives.sol:777, 898, 1589, 1227-1264, 1297-1331, 1657-1725`         | Stranded bribes + stranded votes when factory disables a pair AFTER snapshot/reveal; no refund/forfeit path covers the post-snapshot disable case.                              | F-11-1                         |
| H-5  | `contracts/src/GaugeController.sol:366-399`                                                | Legacy `vote()` validation does not deduplicate `gauges[i]` — `MAX_WEIGHT_PER_GAUGE_BPS` cap fully bypassed via duplicate gauge entries.                                       | F-17-1                         |
| H-6  | `contracts/src/GaugeController.sol:634-641`                                                | `revealVote()` lacks the `weights[i] <= MAX_WEIGHT_PER_GAUGE_BPS` per-element check — cap bypass without needing duplicates.                                                   | F-17-2                         |
| H-7  | `contracts/src/TegridyPair.sol` (mint/burn/harvest paths)                                  | Permissionless `kLast` bootstrap via `mint()` / `burn()` defeats the `harvest()`-bootstrap gate; multi-year suppression of protocol fees.                                       | F-31-A                         |
| H-8  | `contracts/src/TegridyNFTLending.sol` (claimDefault, repayLoan)                            | `claimDefault` is paused-blockable INDEFINITELY; lender locked out of seizing collateral while interest accrues — no `MAX_PAUSE_BLOCK_LIQUIDATION` cap (vs `TegridyLending`'s 7d cap). | F-71-1, F-78-C, F-74-10        |
| H-9  | `contracts/src/lib/SequencerCheck.sol` + 6 deploy-script sites                             | `setSequencerFeed` is one-shot but deploy scripts pass `vm.envOr("SEQUENCER_FEED", address(0))`, silently shipping with feed disabled — sequencer-down protection inert on L2. | F-74-1, F-74-2                 |
| H-10 | `contracts/src/lib/VotePowerOracle.sol:64`                                                 | Library `powerOf` is a LIVE read used by 5 consumers (GaugeController:357, VoteIncentives:625/1525, …) — flash-stake amplification footgun by API name.                          | F-40-VPO-1                     |
| H-11 | `contracts/src/RevenueDistributor.sol:315-318` + `TegridyFeeHook.sol:516,520,614`          | First-ingress to RevenueDistributor: cold-storage SSTORE in `receive()` exceeds 10 k stipend; ETH-leg fails; WETH wrap strands ERC20-WETH at distributor invisible to `address(this).balance`. | F-55-1, F-80-02                |
| H-12 | `contracts/src/lib/WETHFallbackLib.sol:153-167`                                            | `safeTransferETHOrWrapNoRevert` mid-flight failure splits the pool's balance into two assets (ETH + ERC20-WETH); breaks later in-tx accounting; mode==2 leaves caller with stranded WETH. | F-80-01, F-40-WFL-2, F-55-15   |
| H-13 | `contracts/src/TegridyTWAP.sol` (count==0 vs count<=2 bypass paths)                        | `lastBypassUsed` sibling-miss: BATCH-M3 H7 self-bootstrap grace at observation 2/3 doesn't write `lastBypassUsed`, breaking consumer cooldowns when TWAP_PERIOD changes.        | F-89-K, F-46-2                 |
| H-14 | `contracts/src/TegridyStaking.sol:1923-1935`                                               | `executeAdminReplacement` has NO proposal validity expiry window — stale 48 h-ago proposals can be executed at any later block.                                                | F-75-1, F-43-A                 |
| H-15 | `contracts/src/TegridyLending.sol:134-140` + `VoteIncentives.sol:145-151`                  | `setLendingAdmin` / `setVoteIncentivesAdmin` are one-shot — no rotation path exists for buggy or compromised admin contracts.                                                  | F-75-2, F-43-D                 |
| H-16 | `contracts/src/TegridyFactory.sol:455-520`                                                 | `feeToSetter`/guardian instant `emergencyDisablePair` is single-key, no timelock, no rate limit — DoS the entire AMM by disabling all pairs.                                   | F-94-02                        |
| H-17 | every `*Admin.sol` propose/execute pair                                                    | No on-chain veto channel for veTOWELI holders against admin proposals — timelock model assumes off-chain coordination during a key compromise.                                 | F-94-01                        |
| H-18 | `contracts/src/TegridyLaunchpadV2.sol:185-263`                                             | Unbounded `allCollections` registry + free `createCollection` — anyone fills storage; downstream views/getters that iterate suffer permanent OOG.                              | F-95-K-1                       |

> H-18 is borderline HIGH/MEDIUM; included because the storage exhaustion is irreversible.

---

## 4. MEDIUM Findings (49)

| ID    | File:Line                                                 | Description                                                                                                                       | Source                          |
| ----- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| M-1   | `TegridyStaking.sol:1481-1538`                            | `_settleRewardsOnTransfer` silently drops reward-pool shortfall on NFT transfer (asymmetric with `_getReward` and `kick()`).      | F-02-K-02                       |
| M-2   | `TegridyRestaking.sol:1687-1807`                          | `emergencyForceReturn` strands NFT permanently when transfer fails — no `claimStrandedRestakeNFT` path on this branch.            | F-03-K2                         |
| M-3   | `TegridyRestaking.sol:1675-1679`                          | `rescueNFT` bypass: captured owner can rescue a stranded NFT into the staking-contract dead end after a user's stranded path.     | F-03-K3                         |
| M-4   | `TegridyRestaking.sol:1675-1679` (target receiver)        | `rescueNFT` constrained to `address(staking)` but staking does not implement `IERC721Receiver`; rescue path always reverts.       | F-04-2                          |
| M-5   | `SwapFeeRouter.sol` (`swapExactTokensForTokens` w/ WETH path[0]) | `path[0] = WETH` quietly bypasses the staker share — value leak.                                                            | F-06-A                          |
| M-6   | `SwapFeeRouter.sol` (`withdrawTokenFees`)                 | Owner can front-run permissionless `convertTokenFeesToETH` and bypass the staker share.                                            | F-06-B                          |
| M-7   | `SwapFeeRouter.sol` (`withdrawPendingDistribution`)       | Deferred-distribution strands WETH on RevenueDistributor / POLAccumulator after timelocked address rotation.                       | F-06-C                          |
| M-8   | `TegridyLending.sol` (`protocolFeeBpsAtCreate == 0`)      | Sentinel collides with legitimate 0-bps offers — BATCH-D H9 escape hatch is unintentionally broad.                                  | F-07-01                         |
| M-9   | `VoteIncentives.sol` `_validatePair` paths                | Re-reads `factory.disabledPairs(pair)` on every read; toggling pair-disable mid-window destroys claim/refund liveness.            | F-10-K-02                       |
| M-10  | `VoteIncentives.sol` (refund paths)                       | `refundUnvotedBribe` and `refundSubQuorumBribe` race against late voters — `totalGaugeVotes` not frozen at `voteEnd`.              | F-10-K-03                       |
| M-11  | `VoteIncentives.sol` `refundOrphanedBribe`                | Requires `epoch >= epochs.length`; perpetually-stalled keeper makes legitimate bribes refund-only.                                  | F-10-K-04                       |
| M-12  | `RevenueDistributor.sol` (forfeit-reclaim path)           | Forfeit-reclaim leaves `epochClaimed[i]` unchanged → still-locked late claimers can be rugged into unfundable `pendingWithdrawals`. | F-12-K-1                        |
| M-13  | `RevenueDistributor.sol` `_pendingETH` vs `_calculateClaim` | View/write divergence in restaker fallback — multi-source holders see understated claimable amount.                              | F-12-K-2, F-13-1                |
| M-14  | `RevenueDistributor.sol` `distribute*`                    | Not gated by `_isStakingPaused()` — inconsistent with the protocol's kill-switch posture.                                          | F-13-2                          |
| M-15  | `CommunityGrants.sol`                                     | Captured-owner can chain `pause` → `proposeCancelApproved` → `executeCancelApproved` → `emergencyRecoverETH` past M-G01/H12 defences. | F-15-K-01                       |
| M-16  | `CommunityGrants.sol` `_recordDisbursement`               | `MAX_DISBURSEMENTS = 100` ring-buffer is hard DoS surface against high-throughput attack on small grant cap.                       | F-15-K-02                       |
| M-17  | `GaugeController.sol` `setRestakingContract`              | Accepts EOA — irreversibly bricks restaker voting if mis-configured.                                                              | F-17-3                          |
| M-18  | `TegridyNFTPool.sol` (mode 2 / multi-rarity)              | Per-token-royalty bypass via `tokenIds[0]` anchoring; mode-2 stranded WETH silently erodes LP cushion.                            | F-19-1, F-19-2                  |
| M-19  | `PremiumAccess.sol` `getSubscription()`                   | Returns flash-loan-spoofable `lifetime`/`active` flags that bypass the 15s activation gate enforced by `hasPremium()`.             | F-27-K-01                       |
| M-20  | `TegridyLPFarming.sol` `emergencyWithdraw`                | Reverts if `tegridyStaking.aggregateActiveBoostBps` ABI breaks; users lose emergency exit.                                         | F-28-2                          |
| M-21  | `TegridyFactory.sol` `emergencyDisablePair`               | Allows arbitrary-address disabling — no factory-membership check.                                                                  | F-30-1                          |
| M-22  | `TegridyFactory.sol` (rotation race)                      | Compromised `feeToSetter` wins 48 h fee-redirection race even when rotation is in flight.                                          | F-30-2, F-75-4                  |
| M-23  | `TegridyPair.sol` `burn()` + disabled pairs               | `feeOn=true` cleanup on disabled pair re-arms `kLast = 0`; subsequent re-enabled `mint` resumes `_mintFee` against attacker reserves. | F-31-B                          |
| M-24  | `TegridyPair.sol` (cumulative on `sync`)                  | TWAP cumulative integration on `sync()` after donation poisons oracle baseline; ±50 % deviation gate is exploitable on low-liquidity pairs. | F-31-C                          |
| M-25  | `TegridyLendingAdmin.sol` (`MAX_PRINCIPAL_FLOOR`)         | Captured admin can brick offer creation by collapsing principal window to a single-wei range.                                       | F-33-1                          |
| M-26  | `TegridyLendingAdmin.sol` `proposeSweepDonatedToweli`     | Doesn't pin `_to` to current treasury; collapses claimed 96 h chained-timelock to 48 h.                                            | F-33-2                          |
| M-27  | `TegridyLendingAdmin.sol` (`acceptedCollateralRemovalPending`) | Ignores proposal expiry; expired-but-uncancelled proposal perma-blocks offer creation.                                       | F-33-3                          |
| M-28  | `TegridyStakingAdmin.sol` `applyRestakingContract`        | Lacks the `balanceOf(old) > 0` guard that `applyLendingContract` has — captured-owner exfil risk for in-flight restaker rewards.   | F-35-1                          |
| M-29  | `Toweli.sol`                                              | NatSpec promises "governance token" but contract has no ERC20Votes; consumer-side risk if integrators expect snapshots.            | F-36-01                         |
| M-30  | `TegridyStakingJbacVault.sol`                             | Vault is non-upgradeable; staking redeploy orphans all custodied JBACs.                                                            | F-39-4                          |
| M-31  | `base/OwnableNoRenounce.sol` `_transferOwnership`         | Bricked-rotation primitive: malicious pendingOwner can permanently freeze the owner slot.                                          | F-40-ONR-1                      |
| M-32  | `base/TimelockAdmin.sol` (`_minDelay` floor / `_executeAfter`) | `_minDelay` floor not applied to `_propose` validity-window; `_executeAfter` is internal — direct-write bypass possible from any inheriting child. | F-40-TLA-1, F-40-TLA-3      |
| M-33  | `lib/SafeERC721Call.sol` `safeOwnerOfBounded`             | 30 k gas budget can be hit by an honest collection with deep proxy chain — DoS on whitelisted but slow ERC721.                     | F-40-S721-1                     |
| M-34  | `lib/SequencerCheck.sol` `getResumeTimestamp`             | Returns 0 for stale feeds, but consumers compute `resumeAt + GRACE` and compare — H6 staleness gate silently bypassed.             | F-40-SEQ-2                      |
| M-35  | `lib/VotePowerOracle.sol` (restaking branch)              | Restaking try/catch silently treats failure as zero, no event emitted — silent disenfranchisement.                                 | F-40-VPO-2                      |
| M-36  | `lib/WETHFallbackLib.sol` (10 k stipend wrap)             | 10 k stipend forces wrapping for any contract recipient with > trivial logic — large fraction of legitimate downstream sweeps wrap. | F-40-WFL-1                      |
| M-37  | `lib/WETHFallbackLib.sol` (weth address verification)     | Does not verify `weth` is canonical WETH; a malicious immutable address would route fees to attacker.                              | F-40-WFL-4                      |
| M-38  | `RevenueDistributor.sol` emergency/sweep paths            | Use raw `.call` without WETH fallback; treasury-contract upgrade can permanently brick the path.                                   | F-55-2, F-80-06                 |
| M-39  | `POLAccumulator.sol` `executeSweepETH`                    | Unbounded raw call; 48 h-timelocked sweep bricks if treasury reverts; F-94-04 captured-owner can drain 10 %/30 d.                  | F-55-3, F-94-04                 |
| M-40  | `TegridyFeeHook.sol` `sweepETH`                           | Unbounded raw call — DoS hazard if revenueDistributor's receive consumes more than the call frame allows.                          | F-55-4                          |
| M-41  | `CommunityGrants.sol` `_transferETHOrWETH`                | Home-rolled WETH-fallback diverges from canonical lib; USDT-style WETH variants escape try/catch and revert `executeProposal`.     | F-55-5, F-80-04                 |
| M-42  | `MemeBountyBoard.sol` `sweepExpiredPayout`                | Lacks WETH fallback; can be permanently bricked if treasury is a contract whose `receive()` exceeds 50 k.                          | F-80-03                         |
| M-43  | `TegridyFeeHook.sol` (`currency == WETH` claim path)      | Double-wrap risk on the WETH-claim leg.                                                                                            | F-80-05                         |
| M-44  | `TegridyTWAP.sol` `update` refund leg                     | Unbounded-gas raw call; bricks `update` for contract callers whose `receive` reverts.                                              | F-55-8                          |
| M-45  | `TegridyTWAP.sol` `getLatestObservation(pair)`            | Reverts when no observation exists, breaking POL/Lending floor reads.                                                              | F-72-5                          |
| M-46  | `CommunityGrants.sol` `getProposalsInRange`               | No per-call page-size cap.                                                                                                         | F-72-1                          |
| M-47  | `TegridyDropV2.sol` Dutch-auction                         | Timeline consumed by sequencer outages — no buffer/extension; outage compresses real bidding window.                                | F-74-3                          |
| M-48  | `TegridyTWAP.sol` `consult()` + `TegridyDropV2.sol`       | 24 h staleness on price-sensitive paths despite lib comment recommending 4 h.                                                       | F-74-4                          |
| M-49  | `TegridyStaking.sol` (cross-state)                        | Restaking-contract rotation strands NFTs, rewards & per-tokenId buckets in old restaking contract; 5 governance consumers also one-shot. | F-65-1, F-65-2, F-43-E      |

---

## 5. Top 10 Highest-Priority Issues by Remediation Impact

Ranked by combination of (a) loss-magnitude if exploited, (b) ease of exploitation, (c) blast radius, (d) fix-cost vs payoff:

1. **C-1 (CRITICAL) — `TegridyLPFarming.updateReward` ordering** (`TegridyLPFarming.sol:189-242`)
   Synthetix-pattern violation: 5-line modifier reorder. Single PR. Directly exploitable by any LP farmer who times boost increases. Highest payoff per byte.
2. **H-1 — Restake-of-expired siphon** (`TegridyRestaking.sol:596-659`)
   Reject expired locks at `restake`, OR drop the `postClaimBoosted > 0` guard at L885. Three sibling agents converge on this — clear canonical fix.
3. **H-2 — Stale JBAC bonus restored via `getReward` autoMaxLock** (`TegridyStaking.sol:1031-1040`)
   Add `jbacStillValid` check (`p.jbacDeposited || balanceOf > 0`). Fix is one branch; symmetry with `revalidateBoost`.
4. **H-3 — Wrong-token credit on `decayExpiredRestaker` fallback** (`TegridyRestaking.sol:1965-1982`)
   Split `unforwardedBaseRewards` into two buckets, OR don't route bonus failures into base-reward bucket. Real value-divergence risk if bonus ≠ TOWELI in dollar terms.
5. **H-5 + H-6 — GaugeController weight-cap bypasses** (`GaugeController.sol:366-399, 634-641`)
   Single PR adds dedup + per-element cap mirror. Restores entire C4 mitigation.
6. **H-9 — Sequencer feed silently disabled at deploy** (deploy scripts + `lib/SequencerCheck.sol`)
   Add `require(block.chainid == 1 || SEQUENCER_FEED != address(0))` in deploy scripts; convert one-shot setters to constructor immutables. Configuration-class fix.
7. **H-11 / H-12 — First-ingress cold-SSTORE + WETH-fallback split** (`RevenueDistributor.sol:315-318`, `lib/WETHFallbackLib.sol:153-167`)
   Increase stipend on first-ingress sites OR pre-warm storage at deploy; teach mode==2 callers to sweep. Two related fixes; protects every WETH-fallback consumer.
8. **H-14 + H-15 — Admin-replacement validity expiry + Lending/VoteIncentives rotation gap** (`TegridyStaking.sol:1923`, `TegridyLending.sol:134`, `VoteIncentives.sol:145`)
   Add `proposalExpiry` window to TegridyStaking `executeAdminReplacement`; backport TegridyStaking's replacement flow to Lending and VoteIncentives admin pointers. Closes both `H-14` and `H-15` in one mini-PR cycle.
9. **H-16 — Factory guardian instant-DoS** (`TegridyFactory.sol:455-520`)
   Add per-day rate limit to `emergencyDisablePair`; require multisig-style `code.length > 0` on `setGuardian` first set. Closes single-key catastrophic surface.
10. **H-4 — Stranded bribes/votes on post-snapshot pair-disable** (`VoteIncentives.sol:1657-1725`)
    Add a refund/forfeit path that operates on `epochSnapshotPairLive[epoch][pair]` rather than live `disabledPairs[pair]`. Touches multiple sites but each is local.

---

## 6. Cross-Cutting Themes

The 95 agents independently rediscovered seven dominant patterns. Each appears across multiple unrelated contracts — they reflect protocol-wide design trade-offs more than local bugs.

### T-1 — "Sibling miss" / asymmetric defence-in-depth
Same-shape protection wired into one site but not its twin.
Examples: `_settleRewardsOnTransfer` shortfall routing missing while `_getReward` and `kick()` have it (M-1); `revalidateBoost` LockExpired guard but not in `getReward` autoMaxLock branch (H-2); pause-asymmetry on `claimDefault` vs `repayLoan` in TegridyNFTLending (H-8); `setLendingAdmin`/`setVoteIncentivesAdmin` one-shot but TegridyStaking/SwapFeeRouter have rotation (H-15); `lastBypassUsed` written on count==0 but not on the sibling count<=2 grace (H-13). Aggregated at agents 02, 04, 06, 11, 17, 28, 65, 71, 75, 78, 89, 95.

### T-2 — Captured-owner / single-key blast radius
Despite extensive timelock plumbing, several primitives let a captured owner dodge the timelock or chain it past defences.
Examples: pause→propose→execute→sweep chains (M-15); `executeAdminReplacement` no-expiry (H-14); `feeToSetter`/guardian instant disable (H-16); `applyRestakingContract` no `balanceOf > 0` guard (M-28); RevenueDistributor emergencyWithdraw (M-38). Also F-43-A through F-43-K, F-94-* family. The protocol explicitly adopted a "captured-owner" threat model (per `feedback_bulletproof_mandate.md`) — these are remaining gaps in that model.

### T-3 — First-ingress cold-SSTORE / 10 k-stipend WETH-wrap split
A single 10 k stipend isn't enough for the first-ever ETH-receive into RevenueDistributor / SwapFeeRouter / POLAccumulator (zero→non-zero SSTORE blows the budget). Falls into WETH-wrap path which itself can split balance into two assets, breaking later in-tx accounting.
Spotted by agents 40, 55, 67, 80, 94. Aggregated as H-11, H-12, M-36–M-44.

### T-4 — EIP-7702 retrofit gaps
EOA-as-contract delegation is checked in some places (`OwnableNoRenounce._transferOwnership` opt-in) but not others (`setLendingAdmin`, `setVoteIncentivesAdmin`, `setGaugeController`, `_afterTokenTransfer` "EOA-only AlreadyHasPosition" guard, ERC-1820 hook checks in `TegridyFactory._rejectERC777`). Captured at agent 60 (F-60-2 to F-60-5), F-40-ONR-2.

### T-5 — Stale rotation proposals / cross-contract restaking pointers
TegridyStaking has mutable `restakingContract` but 5 governance consumers (GaugeController, VoteIncentives, RevenueDistributor, and 2 others) wire their `restakingContract` immutable at deploy. Rotating staking-side strands NFTs/rewards in the old restaking and silently disenfranchises restakers across consumers (H-1 / M-49 / M-17).
Also: `TegridyTWAP.transferOwnership` no expiry (F-43-F); `TegridyDropV2.transferOwnership` no expiry (F-43-G); rotated owner inherits queued proposals (F-75-3).

### T-6 — Permissionless trigger / MEV residual surface
`distributePermissionless`, `advanceEpoch`, `harvest()`, `update(pair)`, `kick()`, `decayExpiredRestaker` are all permissionless. Each gets cross-checked by ≥2 agents and confirmed bounded — but they form an attack-surface map: any one of them is a candidate for MEV-frontrun if the bound is later loosened. Agents 17, 22, 41, 44, 46, 50, 64, 67, 88.

### T-7 — Unbounded view / unbounded array DoS
`getProposalsInRange`, `getAllPools`, `getHeldTokenIds`, `getWhitelistedTokens`, `allCollections`, `reclaimEligibleAmount`, `getProposalsByStatus`. Most are admin-only or off-chain-callable but a few (H-18 launchpad, M-45 TWAP `getLatestObservation` revert) are load-bearing. Agents 50, 72, 95.

### T-8 — Wrong-decimal / wrong-unit assumptions
Several caps assume 18-decimal tokens (`MAX_BONUS_REWARD_RATE`, `MAX_MIN_BRIBE_AMOUNT`, `DEFAULT_MIN_TOKEN_BRIBE`, `MIN_MULTIHOP_ETH_OUT_WEI`). Mostly informational / operational, but warrants a deploy-script policy check. Agents 51, 84.

---

## 7. Recommended Remediation Order

### Phase P0 — Ship before relaunch (target: 1 week, ≤ 200 LoC delta)
**The minimum bar for the protocol to be safe to redeploy.**

1. **C-1** — Reorder `TegridyLPFarming.updateReward` (5-line modifier reorder).
2. **H-1** — Reject expired locks at `TegridyRestaking.restake()` OR fix the `postClaimBoosted > 0` re-sync guard.
3. **H-2** — Add `jbacStillValid` check to `TegridyStaking.getReward` autoMaxLock branch.
4. **H-3** — Split `unforwardedBaseRewards` into two buckets in `TegridyRestaking`.
5. **H-5 + H-6** — Add dedup + per-element cap mirror to `GaugeController.vote()` and `revealVote()`.
6. **H-9** — Deploy-script + constructor invariant to make `sequencerFeed != address(0)` on L2 enforced at deploy.
7. **H-14 + H-15** — Add proposal-expiry window on `TegridyStaking.executeAdminReplacement` AND backport replacement flow to Lending + VoteIncentives admin pointers.
8. **H-11 + H-12** — Pre-warm RevenueDistributor / SwapFeeRouter / POLAccumulator first-ingress slot OR raise stipend; teach mode==2 callers to sweep.

### Phase P1 — Within 30 days post-relaunch
**Closes the majority of HIGH and high-impact MEDIUM findings.**

9. **H-4** — `VoteIncentives` post-snapshot pair-disable refund/forfeit path.
10. **H-7** — `TegridyPair.harvest()` bootstrap gate that's not bypassable via `mint`/`burn`.
11. **H-8** — `MAX_PAUSE_BLOCK_LIQUIDATION` cap on `TegridyNFTLending.claimDefault`.
12. **H-10** — Rename `VotePowerOracle.powerOf` → `powerOfLiveUnsafe` OR remove from public surface; force consumers onto `powerAt`.
13. **H-13** — Write `lastBypassUsed` on every TWAP bypass branch (count==0, count<=2, dormancy).
14. **H-16** — Per-day rate limit on `emergencyDisablePair`; multisig requirement on `setGuardian`.
15. **H-17** — On-chain veTOWELI veto channel for admin proposals (this is a larger change — flag for governance-design review, not a hot patch).
16. **H-18** — Cap on `TegridyLaunchpadV2.allCollections`; rate-limit `createCollection`.
17. **M-1, M-13, M-14, M-22 to M-28, M-31 to M-37** — assorted MEDIUMs.

### Phase P2 — Within 90 days (or accept as known-design)
**Defensive hardening + documentation cleanups.**

18. **M-2 to M-49** — ones not in P1.
19. EIP-7702 retrofit pass (T-4) — apply opt-in `_ownerMustBeContract` style to all admin-pointer setters.
20. Sweep all dead-state findings: `unsettledSnapshot`, `epochBribeFirstDeposit`, `topWeightByEpoch`/`topGaugeByEpoch`, `_deprecated_paidFeeRate_slot`, `unsettledRewardsByTokenId` non-deletion. Aggregate gas saving ~150 k per relevant tx.
21. WETH-fallback canonicalisation (T-3) — single library with documented stipend rationale; no home-rolled clones in `CommunityGrants` or others.
22. View-DoS cap pass (T-7) — add `MAX_VIEW_PAGE_SIZE` to every unbounded getter.
23. Doc-comment cleanup (the codebase carries ~30+ stale audit-batch references — F-22-K-04, F-23-17, F-27-K-02, F-32-1, F-37 family, F-83 family, etc.).

---

## 8. Coverage Map (which lens → which agents)

| Lens                                                           | Agents                              |
| -------------------------------------------------------------- | ----------------------------------- |
| Reentrancy (classic / cross-fn / cross-contract / hook)        | 01, 41, 53                          |
| Math / over-underflow / casts / rounding                       | 02, 23, 42, 61                      |
| Restaking accounting / share-debt                              | 03, 04, 87, 93                      |
| Swap-fee paths / accounting / admin                            | 05, 06, 32                          |
| Lending (liquidation / interest / oracle / admin)              | 07, 08, 09, 33, 71, 78              |
| Vote-incentives (bribes / snapshots / admin)                   | 10, 11, 38, 92                      |
| Revenue distribution (math / claims)                           | 12, 13                              |
| NFT-lending                                                    | 14, 71                              |
| Grants / Drop / Launchpad                                      | 15, 16, 34, 95                      |
| Gauge controller (weights / commit-reveal)                     | 17, 18, 69                          |
| NFTPool (curve / factory)                                      | 19, 26, 62                          |
| POL accumulator / treasury                                     | 20, 64                              |
| MemeBounty                                                     | 21                                  |
| FeeHook (V4) / V4 spec / V4 research                           | 22, 23, 76, 90                      |
| TWAP / oracle class                                            | 24, 46, 89                          |
| Referral splitter                                              | 25                                  |
| Premium                                                        | 27                                  |
| LP farming                                                     | 28, 93                              |
| Router / Factory / Pair                                        | 29, 30, 31, 88                      |
| Staking admin / Toweli / URI reader / JBAC vault / base-libs   | 35, 36, 37, 39, 40                  |
| Access control / governance / capture                          | 43, 69, 94                          |
| MEV / flash-loan / liquidation grief                           | 44, 45, 71, 95                      |
| Sig-replay / proxy-storage / init / DoS / weird-tokens / ERCs  | 47, 48, 49, 50, 51, 52, 53, 54      |
| Native ETH / WETH                                              | 55, 80                              |
| ECDSA / Merkle / approval / delegatecall / tx.origin           | 56, 57, 58, 59, 60                  |
| First-depositor / slippage / donations / cross-state           | 62, 63, 64, 65                      |
| Approve-race / timestamp / selectors / gov / storage-gap       | 66, 67, 68, 69, 70                  |
| View-DoS / cap-bypass / sequencer / timelock                   | 72, 73, 74, 75                      |
| V4 hook spec / Aero / Aave / Chainlink                         | 76, 77, 78, 79                      |
| WETH / ERC4626 / CREATE2 / permit-divergence / metadata        | 80, 81, 82, 83, 84                  |
| Cross-chain / recent-exploits                                  | 85, 86                              |
| Vault-staking-exploits / AMM-exploits / oracle-exploits        | 87, 88, 89                          |
| Tokenomics / vote-bribe-wash / reward-farming                  | 91, 92, 93                          |
| Liquidity griefing                                             | 95                                  |

Agents 96 / 97 / 98 / 99 — not produced. Agent 100 (this document) is the final aggregator.

---

## 9. Notes on De-duplication

The same vulnerability frequently surfaces in 2–4 agents. Canonical instances chosen:

- **Restake-of-expired siphon (H-1)**: F-03-K1 (canonical, with full PoC), F-87-K-01 (cross-references), F-93-1 (re-derives), F-04-3 (residual-claimant adjacency).
- **First-ingress cold SSTORE (H-11)**: F-55-1 (canonical), F-80-02 (independent confirmation).
- **WETH-fallback split (H-12)**: F-80-01 (canonical), F-40-WFL-2 (lib-side), F-55-15 (lib-side).
- **GaugeController cap bypass (H-5/H-6)**: F-17-1 + F-17-2 (canonical pair), confirmed clean elsewhere.
- **Pair-disable strands bribes/votes (H-4)**: F-11-1 (canonical), F-10-K-02 / F-10-K-03 / F-10-K-06 (downstream effects).
- **Admin-replacement gaps (H-14/H-15)**: F-75-1 + F-75-2 (canonical pair), F-43-A / F-43-D (cross-class confirmation).
- **Captured-owner chains (M-15, M-22, T-2)**: F-15-K-01, F-94-02, F-30-2, F-75-4 — different contracts, same pattern.
- **Sequencer feed deploy gap (H-9)**: F-74-1 + F-74-2 (deploy-script and immutability angle), F-79-* (constructor angle).
- **`unsettledSnapshot` dead-state**: F-03-K4 / F-04-4 — same field, two angles.

Every finding above traces to the original agent file via the `Source agents` column or the inline cross-reference.

---

*End of Executive Summary.*
