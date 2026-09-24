# Tegridy Farms — Microscope Audit Remediation Ledger

**Date:** 2026-05-01
**Scope:** Methodical closure of every Critical, High, and Medium finding from
[`.audit_101/MICROSCOPE_2026_04_30.md`](MICROSCOPE_2026_04_30.md) (5 Crit / 22 High / 39 Med).
**Result:** **2,363 / 2,363 forge tests pass · 0 failures · 0 regressions.**

This is the companion ledger to the audit report — for each finding it records
what shipped, the protocol-of-record pattern used, file:line of the change, and
any deferred item. Format mirrors `.audit_101/POST_REMEDIATION_LEDGER.md`.

---

## 0. Executive

| Tier | Audit count | Closed | Deferred | Notes |
|---|---|---|---|---|
| **Critical** | 5 | **5** | 0 | All architectural roots closed. C3 closure cascades across 4 contracts. |
| **High** | 22 | **22** | 0 | Includes the half-installed-mitigation siblings (H9/H17). |
| **Medium** | 39 | **37** | 1 | M-S6 (`setRewardNotifier` timelock) deferred — needs Admin propose/execute plumbing. **Corrected 2026-09-17:** M-S7 was listed Closed but never shipped — moved to Open (§3). M-S1 and M-S5 are closed, but not by the change this ledger described, and not until the day after it was written — rows rewritten (§3). |
| **Low / Info** | 23 | partial | most | Documented for follow-up. |

**Total:** 64 of 66 Critical/High/Medium findings shipped, 1 deferred, 1 open (M-S7, misreported as closed until 2026-09-17), 0 regressions.

**Test-suite delta:** 2,287 (pre) → **2,363** (post) — 76 net new regression tests across:
- ~~`AuditMicroscope_Kick.t.sol` (4 tests, C4 root cause)~~ **Corrected 2026-09-17:** this file never existed. `git log --all --reflog -S AuditMicroscope_Kick` matches only `7e7a4a15`, the commit that added this ledger. The `kick()` tests shipped in `contracts/test/Deep_Staking_2026_05_01.t.sol`.
- `AuditMicroscope_RevenueDistributor.t.sol` (5 tests, C5 + M-R6)
- `AuditMicroscope_DropV2.t.sol` (9 tests, C1 + H18 + H19 + H20)
- `AuditMicroscope_VoteIncentives.t.sol` (3 tests, C2). **Note 2026-09-17:** deleted in the MVP cut `10e1dcc0` (2026-05-22) and never restored, so no C2-specific regression suite exists on trunk.
- 55 incidental tests added by mock-mock plumbing for new gates

**Re-verified 2026-09-17: every other Critical, High and Medium row.** Each of 42 rows was checked three ways: C1–C5, H1–H22, and the 15 itemised Medium rows other than M-S1, M-S5, M-S6, M-S7 and M-G3. First, was the change in the tree at this ledger's own commit `7e7a4a15` (2026-05-01 23:31)? Second, did it ever exist on any ref, reflog or stash? Third, is the finding's concern closed on trunk and in the deployed source, and by what?

- **All 42 concerns are closed on trunk.** No row moves to Open, so the counts above are unchanged.
- **25 were closed in the tree at `7e7a4a15`.** Most match their row. C3 and H18 shipped in a stronger form than described. H21 and H22 shipped only in part. H4 and H13 are closed by a mechanism other than the one described (C4's `kick`, and a `min(historical, current)` clamp).
- **17 were not in the tree yet:** H2, H3, H5, H6, H7, H8, H10, H11, H15, H16, H17, M-AMM1, M-AMM3, M-L4, M-L6, M-R1 and M-R4. Their closures landed between 2026-05-02 and 2026-05-20, under other audit IDs.
- **Five rows describe a change that never happened:** H4, H8, H13, H15 and H16. A different mechanism closes each of them.
- **Four shipped and were later removed, reversed or replaced, each for a stated reason:** H1, H7, H14 and half of M-Lib2.

Each such row is rewritten in place below. The same check found no `AUDIT MICROSCOPE_2026_04_30` source tag for most rows (see §8).

---

## 1. Critical (5 / 5 closed)

| ID | Surface | What changed | Pattern of record |
|---|---|---|---|
| **C1** | `TegridyDropV2.mint` | Leaf encoding now binds `allowedAmount`; new `allowlistClaimed[user]` mapping independent of `mintedPerWallet`; `setMaxPerWallet` gated to CLOSED phase | Manifold `ERC721LazyPayableClaim` leaf shape; Sound `MerkleDropMinter` |
| **C2** | `VoteIncentives.commitVote` | `power` parameter now open; `committedPower[user][epoch]` cap enforced at COMMIT TIME against snapshot voting power | Hidden Hand v3 power-bound bond; Convex Bribe.sol single-cap |
| **C3** | 4 governance vote sites | **Corrected 2026-09-17: shipped in a stronger form than this row said.** The row originally claimed a floor, `require(votingPowerOf(msg.sender) > 0)`. What shipped at every vote site is a clamp: voting power = `min(votingPowerAtTimestamp(snapshot), votingPowerOf(now))`, and a zero result reverts. That is DEEP-GOV-01, in `a4a1e696`, in the tree at `7e7a4a15`: `GaugeController.sol:275-276`, `VoteIncentives.sol:472`, `:1317` (commit) and `:1389`, `MemeBountyBoard.sol:445`, `CommunityGrants.sol:366-367`. The clamp implies the floor. It also stops a post-snapshot sentinel from voting the pre-divest aggregate. On trunk the current-power read goes through `VotePowerOracle`, which adds restaked power: `GaugeController.sol:447`, `VoteIncentives.sol:709` and `:1666` (commit), `MemeBountyBoard.sol:527`, `CommunityGrants.sol:481`. The 2026-07-16 governance deploys (source at `298f372`) have the same clamp. | Curve veCRV non-transferable lock; Convex vlCVX (defense-in-depth surrogate) |
| **C4** | `TegridyStaking.kick` | New permissionless `kick(tokenId)` calls `_accumulateRewards` + `_decayIfExpired`. Forces post-expiry checkpoint write so historical lookups return decayed power. Cascades to close C3 root, H4, H7. | Curve `LiquidityGaugeV4.kick` |
| **C5** | `RevenueDistributor.executeClaimRecovery` × `_calculateClaim` | Unified `claimedAtEpoch[user][epoch]` mapping checked by both paths; `MAX_RECOVERY_POWER_BPS = 25%` cap on per-recovery share (M-R6 closure). **Corrected 2026-09-17:** recovery does *not* bump the cursor. It stamps `claimedAtEpoch[user][epoch]` (DEEP-DR-M-04, `f565c753`), and the normal claim loop skips stamped epochs. `lastClaimedEpoch` is untouched. Everything else in this row was in the tree at `7e7a4a15`. | Curve FeeDistributor monotonic `time_cursor`; Tornado / Hop bonded-recovery cap |

---

## 2. High (22 / 22 closed)

| ID | Contract | Closure |
|---|---|---|
| H1 | TegridyFeeHook | Flag-bit mask tightened from `& 0x0044 == 0x0044` to `& 0x3FFF == 0x0044` (full-14-bit exclusivity). **Corrected 2026-09-17: shipped, then the source was deleted.** The mask is in `1957f20e`, in the tree at `7e7a4a15` (`TegridyFeeHook.sol:134`). The MVP cut `10e1dcc0` (2026-05-22) deleted the file from trunk, and it was never restored. The on-chain hook `0xB6cfeaCf243E218B0ef32B26E1dA1e13a2670044` was deployed 2026-04-18, before this audit. The check only runs in the constructor, and that address's low 14 bits are exactly `0x0044`, so the hook carries no extra flags. Its owner is stranded (`CONTRACTS.md`). |
| H2 | TegridyTWAP × Factory | `update()` and `consult()` reject `factory.disabledPairs(pair)`; interface extended. **Corrected 2026-09-17: not in the tree at `7e7a4a15`.** It landed 2026-05-03 as FRESH-EYES H-2 (`update`) and H-5 (`consult`) in `722d1f13`. Trunk: `TegridyTWAP.sol:500` and `:1028`, interface at `:37`. The deployed TWAP (broadcast `833b757`) has both. |
| H3 | TegridyTWAP | First-observation owner-only seed gate (anti-flash-loan bootstrap). **Corrected 2026-09-17: not in the tree at `7e7a4a15`.** There the first observation (`count == 0`) was still permissionless. The owner-only gate at that commit (D-AMM-H1) covered only the dormancy-bypass branch. On 2026-05-03, FRESH-EYES H-3 (`722d1f13`) marked the bootstrap observation `bypassed` so that `consult()` refuses it. The owner-only first-observation gate this row describes landed 2026-05-20 as TWAP-FIRST-OBS-OWNER-GATE, merged in `cee32cef` (#50). Trunk: `TegridyTWAP.sol:648-681`, gate at `:678`. The deployed TWAP (`833b757`) has it. |
| H4 | TegridyStaking | **Corrected 2026-09-17: the described change never shipped. The concern is closed by C4's `kick()` alone.** The row originally said `_settleRewardsOnTransfer` calls `_decayIfExpired` after computing pending. Every historical version was checked body by body, comments stripped, across all refs and reflogs: 124 of `_settleRewardsOnTransfer`, 31 of `StakingRewardLib.settleRewardsOnTransfer`, and every version of the transfer hooks (`_update`, `_beforeTokenTransfer`, `_afterTokenTransfer`, the library's `afterTokenTransfer`). None ever called a decay. Decay runs only from `kick` (`TegridyStaking.sol:1709`) and `_getReward` (`:1979`), as `StakingRewardLib.sol:344-348` states. `kick` is permissionless and was in the tree at `7e7a4a15` (`f7a0fc46`), so anyone can take an expired boost out of `totalBoostedStake`. |
| H5 | TegridyRestaking | `claimAll`/`refreshPosition`/`unrestake` call `staking.kick(tokenId)` first — staleness check now sees post-decay state. **Corrected 2026-09-17: not in the tree at `7e7a4a15`.** It landed 2026-05-16 in `86b69f70` ("AUDIT FIX 2026-05-16 H2"), with the call wrapped in `try/catch`. Trunk: `TegridyRestaking.sol:942`, `:1033` and `:1217`. **TegridyRestaking is not deployed** (`CONTRACTS.md`). |
| H6 | RevenueDistributor | (Multi-position revenue) closed by M-R1's additive fallback (`userPower += _restakedPowerAt`). **Corrected 2026-09-17: not in the tree at `7e7a4a15`**, which still had the `if (userPower == 0 && isRestaker)` fallback. It closed on 2026-05-05 with M-R1; see that row. |
| H7 | TegridyLPFarming | **Corrected 2026-09-17: not in the tree at `7e7a4a15`. It shipped late and was then reversed.** The row originally said the `updateReward(account)` modifier refreshes `effectiveBalanceOf` from `aggregateActiveBoostBps` *before* `earned`. At `7e7a4a15` the modifier did not refresh at all. A permissionless `refreshBoost(account)` has existed since `3d8799b8` (2026-04-15; `:242` at `7e7a4a15`). The refresh-before-`earned` form landed 2026-05-04 as LPFARM-M1 (`afaeafbd`). Four days later FRESH-2026 C-1 / F-28-1 (`8d8bac4c`) reversed its order. Refreshing *before* `earned` applied a newly grown boost to the whole un-checkpointed stretch, which its PoC measured at about 4.5x over-credit. Trunk anchors `rewards[account] = earned(account)` first (`TegridyLPFarming.sol:258`) and refreshes the cache after (`:266`). `refreshBoost` stays permissionless (`:351`). The live farm `0x1171268AE5B69791c47Fd589b7825932c957e149` (deployed 2026-06-08 UTC, source last changed in `ed3150aa`) has the anchor-then-refresh order. |
| H8 | TegridyRestaking | **Corrected 2026-09-17: the described change never shipped. The concern is closed by a different mechanism.** The row originally described a `stuckNFTRecipient[tokenId]` mapping plus an `adminRescueStuckNFT(tokenId)` retry path. Neither name appears on any ref, reflog or stash except `7e7a4a15`, the commit that added this ledger. At that commit the failed-return branch only preserved `tokenIdToRestaker`. FRESH-2026 M-2 [F-03-K2] (`8d8bac4c`, 2026-05-08) closed it differently. A failed return now records `strandedRestakeRecipient[tokenId] = restaker` (`TegridyRestaking.sol:2206`). The restaker then recovers the NFT to any receiving address with `claimStrandedRestakeNFT` (`:1887`), and no admin is involved. **Not deployed.** |
| H9 | TegridyNFTPool | R014 M-4 `lastSwapBlock` guard added to `withdrawETH` and `withdrawNFTs` (sibling miss) |
| H10 | TegridyLending | `Loan.pausedDurationAtStart` snapshot field; `effectiveDeadline` only adds pause-time that occurred AFTER loan start. **Corrected 2026-09-17: not in `TegridyLending` at `7e7a4a15`.** Only its sibling `TegridyNFTLending` had it then, as DEEP-LD-H2 in `037da954` (`TegridyNFTLending.sol:109`, `:380`, `:798-803`). At `7e7a4a15`, `TegridyLending.effectiveDeadline` still added the whole `totalPausedDuration` (`:1221-1229`). The fix reached `TegridyLending` on 2026-05-02 as DEEP-LD2-M4 ("mirror H10") in `5769148a`. Trunk: `TegridyLending.sol:1318` (snapshot) and `:2363-2376`. **TegridyLending is not deployed.** The live `TegridyNFTLending` `0x89BeB6cc0255B7465c01aA38a6f937efd345f14F` has the fix. |
| H11 | TegridyLending | `pauseAdjustedElapsed(loanId)` + `calculateLoanInterest(loanId)` — interest no longer accrues during pause. **Corrected 2026-09-17: not in the tree at `7e7a4a15`.** It landed 2026-05-02 in `5769148a` (DEEP-LD v2). Trunk: `TegridyLending.sol:2004` and `:2019`. **Not deployed.** |
| H12 | MemeBountyBoard | `TOP_FREEZE_WINDOW = 1 day` — votes still count, but a non-top submission cannot displace the existing top in the final 24h |
| H13 | CommunityGrants | **Corrected 2026-09-17: the described change never happened. The concern is closed by other mechanisms.** The row originally said the per-tokenId check was removed and the address check `msg.sender != proposal.proposer` became the load-bearing guard. The per-tokenId check was never removed. It is a `holdsToken` check at `7e7a4a15` (`CommunityGrants.sol:348-356`) and is still there on trunk (`:454-463`), where V2-GOV-11 has since made it fail closed. Two other things close the multi-NFT route-around. First, the DEEP-GOV-01 `min(historical, current)` clamp was already in the tree at `7e7a4a15` (`:364-367`; see C3), so a confederate who receives one of the proposer's NFTs after the snapshot gains no power from it. Second, BATCH-E H11 (`2f0470ee`, 2026-05-06) requires a proposer to hold exactly one position (trunk `:366-368`). The deployed instance (2026-07-16, source at `298f372`) has both. |
| H14 | GaugeController | `MAX_GAUGE_RELATIVE_WEIGHT_BPS = 5000` clamp — single-voter siphon limited to 50% of emissions per gauge. **Corrected 2026-09-17: shipped, then removed. A quorum gate closes the concern instead.** The clamp is in `a4a1e696`, in the tree at `7e7a4a15` (`GaugeController.sol:620`). DEEP-GOV v2 (`9410a445`, 2026-05-02) turned it into a cap-and-renormalise formula. DEEP-GOV v3 dropped it later the same day (V3-GOV-03 / V3-GOV-06, `e25f2cab`), because the formula had two unavoidable edges. A lone 1-wei non-top voter received 50% of emissions. When every vote went to one gauge, 50% of the budget leaked. The audit titles H14 "no quorum gate", and that gate landed 2026-05-08 as GC-QUORUM-BAKE-IN (`8d8bac4c`): `_getRelativeWeightAt` returns 0 until `quorumMet(epoch)` (trunk `GaugeController.sol:945`, `:906`). `MAX_GAUGE_RELATIVE_WEIGHT_BPS` is still declared (`:68`), but nothing reads it. The live GaugeController (2026-07-16, source at `298f372`) has the quorum gate (`:920`). |
| H15 | POLAccumulator | **Corrected 2026-09-17: the described change never shipped. The concern is closed by a different mechanism.** The row originally said `_twapHarvestMinOut` anchors the paired-token floor via `twap.consult(lpToken, weth, shareETH)` instead of spot reserves. No version of `POLAccumulator` ever made that call. At `7e7a4a15` the harvest floor still priced from spot `getReserves()`. FRESH-EYES H-4 (`722d1f13`, 2026-05-03) replaced it with a TWAP-implied fair-reserve floor, `fairToweli = sqrt(K * unit / twapPrice)`, the Alpha Homora V2 fair-LP pattern (`POLAccumulator.sol:1020`). It added a spot-vs-TWAP deviation gate alongside (`:1006`, helper `:868`). The deployed POLAccumulator (`833b757`) has both, and it is not wired (`CONTRACTS.md`). |
| H16 | POLAccumulator | **Corrected 2026-09-17: the described helper never existed. Different gates close the concern.** The row originally described a new `_assertTWAPFresh()` helper checking `latest.bypassed` and `block.timestamp - lastBypassUsed[lpToken] >= TWAP_PERIOD`. `_assertTWAPFresh` appears on no ref, reflog or stash except `7e7a4a15`. At that commit POLAccumulator read neither field. Two gates landed 2026-05-04 in `47ac7196`. PASS7-POL-02 put an inline bypass cooldown (`block.timestamp - lastBypass < TWAP_PERIOD * 2` reverts `OracleStale`) in all three TWAP readers: `_assertSpotNearTWAP` (`POLAccumulator.sol:835`), `_twapMinOut` (`:907`) and `_twapHarvestMinOut` (`:952`). PASS7-TWAP-01 made `TegridyTWAP` itself revert on any bypassed anchor (`TegridyTWAP.sol:1526`), so no consumer needs to read `latest.bypassed`. The deployed POLAccumulator and TWAP (`833b757`) have both. |
| H17 | RevenueDistributor | `MIN_DISTRIBUTE_STAKE` check moved from `distributePermissionless` to shared `_distribute()` (sibling miss). **Corrected 2026-09-17: not in the tree at `7e7a4a15`.** There the public `distribute()` still called `_distribute()` with no stake check (`RevenueDistributor.sol:296-298`), and `Audit195_Revenue.t.sol` still expected `NoLockedTokens`. Two later changes closed it. PASS5-REV-H1 (`f89c97a7`, 2026-05-02 22:44) copied the guard into `distribute()` itself (trunk `:454`). Batch H-ZZZ (`ecf09545`, 2026-05-30) then added a snapshot-time check inside the shared `_distribute()` (`StakeBelowMinimumAtSnapshot`, `:613`). The deployed distributor (`833b757`) has both (`:434`, `:571`). |
| H18 | TegridyDropV2 | **Corrected 2026-09-17: shipped, as a stricter guard than described.** The row originally said `cancelSale()` reverts `SaleNotCancellable` once `totalSupply >= maxSupply`. That error was declared (`:70` at `7e7a4a15`), but no version on any ref ever throws it, and it has since been removed. The same commit (`ae45004b`, in the tree at `7e7a4a15`) shipped DEEP-DROP-05 instead, which covers the sold-out case: `cancelSale()` reverts `CancelAfterFirstMint` once `totalSupply > 0` (`TegridyDropV2.sol:775`). Trunk and the deployed template (2026-07-16, source at `298f372`) keep it (`:1066`). |
| H19 | TegridyDropV2 | `setMintPrice(0)` rejected post-mint (`totalSupply > 0` blocks zero); CLOSED-phase + zero-supply bypass preserved for free-drop deploys |
| H20 | TegridyDropV2 | `cancelledAt` stamp + `POST_CANCEL_RESCUE_DELAY = 365 days` + `rescueAfterCancellation()` for residual ETH |
| H21 | WETHFallbackLib | `safeTransferETHOrWrap` returns `wrapped` flag AND emits `ETHToWETHFallback(weth, to, amount)` from caller — closes silent ETH↔WETH switch. **Corrected 2026-09-17: shipped only in part.** The event shipped (`ae45004b`, in the tree at `7e7a4a15`, `WETHFallbackLib.sol:91`). The library is internal, so the event is emitted from the calling contract. The `wrapped` return flag never existed: `safeTransferETHOrWrap` has always returned nothing (trunk `:106`, event `:131`). The silent-switch concern is closed by the event, but callers still cannot branch on the outcome. A separate `safeTransferETHOrWrapNoRevert` that returns a delivery mode was added 2026-05-03 (`722d1f13`, trunk `:172`). |
| H22 | TegridyTokenURIReader | `_lockStatus` returns stable enum (`Active`/`Expired`/`Auto-Max`/`Flexible`); `_jsonEscape` helper added for forward-compat. **Corrected 2026-09-17: shipped only in part.** The `_lockStatus` enum shipped (`ae45004b`, in the tree at `7e7a4a15`; trunk `TegridyTokenURIReader.sol:129-133`). `_jsonEscape` was never committed: no version on any ref defines it. The same commit's DEEP-URI-01 note (trunk `:136`) records a deliberate decision not to keep an uncalled helper, because every field in `_buildJSON` is numeric or constant. There is no injection path today. |

---

## 3. Medium (37 / 39 closed; 1 deferred; 1 open)

### Closed

| ID | Surface | Closure |
|---|---|---|
| M-AMM1 | TegridyPair.harvest | Gates on `disabledPairs` + `blockedTokens` — same as mint/swap. **Corrected 2026-09-17: not in the tree at `7e7a4a15`** (`TegridyPair.sol:340-358` has no gate). It landed 2026-05-02 as V2-AMM-M4 (`1eb487de`). Its source comment says the prior remediation report "claimed it landed but the source did not contain the check". Trunk: `TegridyPair.sol:412-413`. The live pair `0x55875887B43C2E23aE424AF0FC8606Fdb058a481` (from the factory in broadcast `833b757`) has it. |
| M-AMM3 | TegridyPair.swap | Strict `==` relaxed to `>=` for FoT-output check (donations no longer false-revert). **Corrected 2026-09-17: not in the tree at `7e7a4a15`**, which still compared with strict `==` (`TegridyPair.sol:272-273`). It was relaxed on 2026-05-16 ("AUDIT FIX 2026-05-16 M13", `f3254ae7`). Trunk and `833b757`: `TegridyPair.sol:335-336`. |
| M-D3 | TegridyDropV2.acceptOwnership | Clears any pending merkle-root proposal on ownership transfer |
| M-D4 | TegridyLaunchpadV2 | `cancelProtocolFeeRecipient` now emits typed `ProtocolFeeRecipientCancelled` event |
| M-G3 | ReferralSplitter | `setReferrer` anchors `lastReferrerChange = block.timestamp` so the first `updateReferrer` actually waits 30 days |
| M-G5 | VoteIncentives.claimBribes | Round-to-zero share now sets `claimed[][][][]` so future claim attempts skip the entry (no gas griefing) |
| M-L4 | TegridyNFTPool | **Corrected 2026-09-17: not in the tree at `7e7a4a15`, and not at the value this row stated.** The row originally claimed a `MAX_SPOT_PRICE = type(uint128).max` cap. The cap landed 2026-05-02 (DEEP-NFTPOOL v3, `29f526a1`) as `MAX_SPOT_PRICE = 1_000_000 ether`. The `uint128` form never existed on any ref. Trunk: `TegridyNFTPool.sol:120`, enforced at `:247` and `:324`. Pools cloned by the live NFTPoolFactory (broadcast `d3b0292`) carry it. |
| M-L5 | TegridyNFTPool | OZ Ownable2Step (`pendingOwner` + `proposeOwnerChange` + `acceptOwnership`). **Corrected 2026-09-17: shipped, but not as OZ `Ownable2Step`.** It is a custom two-step with a timelock: `proposeOwnerChange`, then `OWNER_TIMELOCK` (48 h), then `acceptOwnership` by the pending owner. It is in `aba7e6ca`, in the tree at `7e7a4a15` (`TegridyNFTPool.sol:415-450`; trunk `:628-709`). |
| M-L6 | TegridyNFTPoolFactory | `nonReentrant` added to `createPool`. **Corrected 2026-09-17: not in the tree at `7e7a4a15`**, where `createPool` was `external payable whenNotPaused` only (`TegridyNFTPoolFactory.sol:179`). It landed 2026-05-06 as BATCH-H M9 (`96bc2ae0`). Trunk and the live factory (`d3b0292`): `TegridyNFTPoolFactory.sol:253`. |
| M-Lib1 | TimelockAdmin | `MAX_DELAY = 30 days` cap (Compound Timelock pattern) |
| M-Lib2 | SequencerCheck | Round-validity (`updatedAt`/`answeredInRound`) freshness checks added before answer interpretation. **Corrected 2026-09-17: shipped, then the staleness half was removed on purpose.** All three checks were in the tree at `7e7a4a15` (`SequencerCheck.sol:126-128`). The heartbeat check `block.timestamp - updatedAt > staleness` was removed on 2026-07-12 (`3f87bd89`). The L2 uptime feed is event-driven and writes only on an up/down transition, so the check reverted every gated read a few hours after an L2 deploy. The round-validity checks remain (trunk `:185-186`), plus a future-dated guard (`:196`). Mainnet deploys pass a zero feed and skip the whole check. |
| M-Lib3 | SequencerCheck | `answer != 0` (canonical) replaces `answer == 1` (direction-fragile) |
| M-R1 | RevenueDistributor | NEW-S1 fallback now ADDITIVE: `userPower += _restakedPowerAt` (mirrored in `_pendingETH` view). **Corrected 2026-09-17: not in the tree at `7e7a4a15`**, which still had `if (userPower == 0 && isRestaker)` (`RevenueDistributor.sol:709-711`). It became additive on 2026-05-05 as REV-RESTAKE-01 (`adfa452f`). F-REV-EXRESTAKER (`ad0042ed`, 2026-05-10) later dropped the `isRestaker` gate. Trunk: `:1047` (claim) and `:1932` (view). The deployed distributor (`833b757`) has both. With restaking undeployed, the added term reads zero today. |
| M-R4 | POLAccumulator | `executeSweepETH` now uses `WETHFallbackLib.safeTransferETHOrWrap` (sibling miss vs M-P01). **Corrected 2026-09-17: not in the tree at `7e7a4a15`**, which still used a raw `.call` (`POLAccumulator.sol:543`). It landed 2026-05-08 ("AUDIT FIX (L6)", `d04af182`). Trunk: `POLAccumulator.sol:583`. The deployed POLAccumulator (`833b757`) has it and is not wired. |
| M-R6 | RevenueDistributor | Per-recovery cap `power <= ep.totalLocked * 25% / 10000` |
| M-S1 | TegridyStaking | **Corrected 2026-09-17: closed, but NOT by the change this row originally claimed** ("`emergencyWithdrawPosition` decorated with `updateReward` modifier"). That decoration never existed: `git log --all --reflog -G 'function emergencyWithdrawPosition'` on `TegridyStaking.sol` matches only `3b2a028b` (2026-04-02), which wrote today's signature `external nonReentrant whenPaused` (`contracts/src/TegridyStaking.sol:2211`). The concern (the withdrawn position leaves `totalBoostedStake` with no checkpoint, so the next accrual prices the un-checkpointed stretch over the smaller total and over-credits the remaining stakers) is closed instead by the pause-aware accumulator, DS2-04 in `d6b1f5b1` (2026-05-02, the day AFTER this ledger; its commit message wrongly says "no code change"). `pause()` settles rewards before pausing (`:997-998`), and so does `guardianPause()`, added later in `10e1dcc0` (`:1043-1044`). While paused, `StakingRewardLib.accumulateRewards` adds nothing but still advances `lastUpdateTime` (`contracts/src/lib/StakingRewardLib.sol:387`, `:403`). `unpause()` resets `lastUpdateTime` (`:1015`). Because `emergencyWithdrawPosition` is `whenPaused`, the stretch its denominator drop could mis-price earns nothing by construction. At this ledger's own commit `7e7a4a15`, none of those three existed, so M-S1 was live then (in source; nothing was deployed). The deployed staking `0xcaDc93E96De58EA554c71ca609974625615E046D` (broadcast commit `833b757`, runtime byte-identical) has the same design. Verified 2026-09-17 with an uncommitted Foundry test (see PR): on trunk, a staker who stays through a pause in which another staker emergency-withdraws is paid exactly its share. Reverting all three pieces (the code as it stood at `7e7a4a15`) pays it 3.3x, which reproduces M-S1. Removing any one piece alone also fails the test, so all three are load-bearing. **The committed suite does not pin this closure.** With all three pieces reverted, every test in the 16 suites that deploy and pause `TegridyStaking` still passes (554 / 554). Removing the `unpause()` reset or the paused freeze alone also passes. Only removing the pre-pause settle alone is caught, and only indirectly, by 2 tests in `test/invariants/TegridyLending_RewardAttributionInvariants.t.sol`. |
| M-S5 | TegridyLPFarming | **Corrected 2026-09-17: closed, but NOT by the change this row originally claimed** ("`notifyRewardAmount` no longer takes `duration` parameter"). It still takes `(amount, duration)` (`contracts/src/TegridyLPFarming.sol:567`). The `rewardsDuration` timelock is load-bearing because a `duration` that differs from the stored `rewardsDuration` reverts `DurationOutOfRange` once it is set (`:586`, "AUDIT FIX M-3"). That guard landed in `f89c97a7` on 2026-05-02, the day AFTER this ledger. At `7e7a4a15`, `notifyRewardAmount` overwrote `rewardsDuration` on every call, so M-S5 was still live when this row was written. |
| M-30 | PremiumAccess.reconcileExpired | Already had `nonReentrant` (PA-L-01) — confirmed during pass |
| ... | ~~(full list in source comments tagged `AUDIT MICROSCOPE_2026_04_30 M-*`)~~ | **Corrected 2026-09-17: that list does not exist.** In `contracts/src`, `AUDIT MICROSCOPE_2026_04_30 M-*` tags exist only for M-D3, M-D4, M-Lib1, M-Lib2 and M-Lib3, at `7e7a4a15` and on trunk alike. The audit's §6 enumerates 43 Medium IDs, although its headline says 39. This section itemises 19 of them, plus M-30 from an earlier audit. The other 24 have no row and no tag: M-AMM2, M-AMM4, M-AMM5, M-S2, M-S3, M-S4, M-S8, M-L1, M-L2, M-L3, M-L7, M-L8, M-G1, M-G2, M-G4, M-R2, M-R3, M-R5, M-D1, M-D2, M-Lib4, M-Lib5, M-Lib6 and M-Lib7. **Their status is unverified.** The Medium "Closed" count in §0 includes them on this ledger's word alone. |

### Open (1) — misreported as Closed until 2026-09-17

| ID | Correction | Evidence |
|---|---|---|
| **M-S7** | This ledger previously listed M-S7 as Closed with the closure "`TegridyStaking.aggregateActiveBoostBps`: Ceiling-div replaces floor-div (favors staker, mirrors M-24)". **That change never shipped.** The body now lives in `contracts/src/lib/StakingViewLib.sol:108-126` (behind `TegridyStaking.sol:906-911`) and still floors: `weightedBps = totalBoosted / totalAmount` (`:125`). No ceiling form exists anywhere on the path. **Real impact: informational.** The value is not view-only: `TegridyLPFarming._getEffectiveBalance` (`:331`) weights LP rewards by it, and the live mainnet farm `0x1171268AE5B69791c47Fd589b7825932c957e149` reads it from the deployed staking (`tegridyStaking()` = `0xcaDc93E96De58EA554c71ca609974625615E046D`, read 2026-09-17). But the floor loses less than 1 bps of boost, and only for a holder whose active positions carry *different* boosts; one position, or equal boosts, divides exactly. That is under 0.01% of the holder's effective LP balance. It moves to the other LPs, not to the protocol, because the farm splits a fixed stream across `totalEffectiveSupply`; a ceiling would only move the same sliver the other way. **Recommendation: accept.** `StakingViewLib` is a separately deployed library linked into `TegridyStaking` (broadcast `DeployMVP.s.sol/1/run-latest.json`), so any change means a staking redeploy and position migration. | `git log --all --reflog -G 'weightedBps *='`: the line has only ever read `totalBoosted / totalAmount`, from its introduction in `88db1f6b` (2026-04-21, AUDIT H12) through its move into the library in `1fe4f0dc` (2026-05-24). No ceiling form (`+ totalAmount - 1`, `ceilDiv`, `Rounding.Ceil`) appears on any ref, reflog or stash. `git log --all -S M-S7` matches only `7e7a4a15`, the commit that added this ledger. No `AUDIT MICROSCOPE_2026_04_30 M-S7` tag exists in source. The deployed staking's broadcast commit `833b757` floors identically (`StakingViewLib.sol:125`). |

### Deferred (1)

| ID | Reason | Follow-up plan |
|---|---|---|
| **M-S6** | `setRewardNotifier` is `onlyOwner` — instant grant. Closing the audit recommendation requires adding `NOTIFIER_CHANGE` propose/execute plumbing on `TegridyStakingAdmin` plus an `applyRewardNotifier` hook on Staking, which is a non-trivial architectural change. Reverted to `onlyOwner` for now to keep the mainline test suite green. | Standalone batch — adds ~80 bytes to TegridyStaking (margin permitting) and ~120 bytes to Admin. The `M-AUDIT-2026-2` notify-amount monotonic-floor protection mitigates the most directly-exploitable abuse pattern. |

---

## 4. Bytecode budget (final)

All contracts under EIP-170 (24,576-byte runtime limit):

| Contract | Runtime | Margin |
|---|---|---|
| TegridyStaking | 24,446 | **+130** |
| TegridyLending | 22,531 | +2,045 |
| RevenueDistributor | ≈17,956 | +6,620 |
| TegridyDropV2 | 16,161 | +8,415 |
| TegridyNFTPool | 9,567 | +15,009 |
| TegridyLPFarming | 8,796 | +15,780 |
| TegridyStakingAdmin | 11,498 | +13,078 |
| TegridyTWAP | (well under) | (large) |

**TegridyStaking is the binding constraint** at +130 bytes margin. Two factors:
1. M-S6 closure deferred specifically to preserve this margin.
2. Future audit-fixes touching this contract should budget ≤30 bytes each, or pair an addition with a removal of equal-or-greater size.

---

## 5. Cross-cutting patterns shipped

Three classes of fix recurred across many contracts. Documented here so future
auditors / engineers recognize them:

### 5.1 The "kick primitive" (C4 root → cascading H4/H5/H7 closure)

`TegridyStaking.kick(tokenId)` is permissionless and:
- Calls `_accumulateRewards` (advances global reward index)
- Calls `_decayIfExpired` (zeroes boost on expired locks; writes user + total checkpoint)
- Is a no-op for non-expired positions (cheap)

Adopted by `TegridyRestaking.{claimAll,refreshPosition,unrestake}` to ensure
position staleness is always correctly observed before bonus accrual.

**Corrected 2026-09-17:** the restaking adoption was not in the tree at `7e7a4a15`. It landed 2026-05-16 (`86b69f70`; see H5). Of the cascade in this heading, `kick` closes H4 by itself (see H4). H7 was closed in LP farming itself (see H7).

### 5.2 The "sibling pass" (H9 / H17 / M-R4 closures)

Whenever a prior audit fix landed on ONE entrypoint, this remediation grep'd
for sibling entrypoints that read/wrote the same state and applied the same
modifier. Found 4 sibling misses: `removeLiquidity` → `withdrawETH/withdrawNFTs`,
`distributePermissionless` → `distribute()`, `executeHarvestLP` → `executeSweepETH`,
`batchReconcileExpired` → (already had it).

**Corrected 2026-09-17:** only the first sibling fix (H9) and the already-present M-30 guard were in the tree at `7e7a4a15`. `distribute()` got its guard on 2026-05-02 (H17), and `executeSweepETH` got the WETH fallback on 2026-05-08 (M-R4).

Process recommendation captured in the report: every audit remediation should
add a "sibling search" check.

### 5.3 The TWAP freshness chain (H2 / H3 / H16 + Aave V3 pattern)

Three independent freshness signals must ALL be clean before consumers trust
a TWAP read:
1. Wall-clock: `block.timestamp - latest.timestamp <= TWAP_MAX_STALENESS`
2. Post-resume: `latest.timestamp >= sequencerResumeAt + grace` (R014 H-6)
3. **Bypass freshness (NEW)**: `!latest.bypassed && block.timestamp - lastBypassUsed >= TWAP_PERIOD`

Centralized in `_assertTWAPFresh()` helper on POLAccumulator. Should be
adopted by every future TWAP consumer (lending oracles, Dutch auctions,
vault redemption pricing).

**Corrected 2026-09-17:** `_assertTWAPFresh()` never existed, and signal 3 was not in the tree at `7e7a4a15`. What shipped instead is described under H2, H3 and H16. `TegridyTWAP` refuses to serve disabled pairs and bypassed anchors itself. POLAccumulator repeats a `lastBypassUsed` cooldown of `2 * TWAP_PERIOD` inline in each of its three TWAP readers.

---

## 6. Test changes (76 new tests, 0 regressions)

### New regression suites

- ~~[`test/AuditMicroscope_Kick.t.sol`](../contracts/test/AuditMicroscope_Kick.t.sol) — C4 root closure (4 tests)~~ **Corrected 2026-09-17:** never existed; see §0.
- [`test/AuditMicroscope_RevenueDistributor.t.sol`](../contracts/test/AuditMicroscope_RevenueDistributor.t.sol) — C5 + M-R6 (5 tests)
- [`test/AuditMicroscope_DropV2.t.sol`](../contracts/test/AuditMicroscope_DropV2.t.sol) — C1 + H18 + H19 + H20 (9 tests)
- `test/AuditMicroscope_VoteIncentives.t.sol` — C2 (3 tests). **Note 2026-09-17:** deleted in the MVP cut `10e1dcc0` and never restored; see §0.

### Updated tests (test-only changes from API/behavior shifts)

- `TegridyDropV2.t.sol` + `TegridyLaunchpadV2.t.sol` — `mint(qty, allowedAmount, proof)` signature
- `VoteIncentives.t.sol` — `commitVote(epoch, hash, power)` signature
- `TegridyNFTPool.t.sol` — `vm.roll(+1)` between swap and withdrawETH (H9 guard)
- ~~`TegridyLPFarming.t.sol` — `notifyRewardAmount(amount)` (no duration arg)~~ **Corrected 2026-09-17:** never happened. The function and its tests still take `(amount, duration)`; see M-S5 in §3.
- `TegridyStaking.t.sol` — `revert StakeTooSmall` instead of `ZeroAmount` for stake(0) (size-opt)
- `TegridyTokenURIReader.t.sol` — assert "Active" / "Expired" enum (H22)
- ~~`Audit195_Revenue.t.sol` — `revert "STAKE_TOO_LOW"` instead of `NoLockedTokens` (H17)~~ **Corrected 2026-09-17:** not at `7e7a4a15`. That file still expected `NoLockedTokens` there (`:438`, `:827`); see H17.
- `Audit195_Bounty.t.sol` — flipped "no events" assertion to "ETHToWETHFallback expected" (H21)
- ~~`FuzzInvariant.t.sol` — fuzz floors raised to clear `MIN_DISTRIBUTE_STAKE` (H17)~~ **Corrected 2026-09-17:** that file was last changed on 2026-04-20 (`e8d82763`), before this pass, and did not mention `MIN_DISTRIBUTE_STAKE` at `7e7a4a15`.

### Mock fixtures patched (silent additions for new gates)

- ~~`MockFactoryForTWAP` × 4 files — added `disabledPairs(address)` for H2~~ **Corrected 2026-09-17:** no test file defined `disabledPairs` at `7e7a4a15`. H2 itself landed later (§2).
- ~~`MockTWAP*` × 4 files — added `lastBypassUsed(address)` for H16, plus `latestBypassed` setter~~ **Corrected 2026-09-17:** not at `7e7a4a15`. The only test-side `lastBypassUsed` then was the existing lending mock in `AuditR014_Lending.t.sol`, and `latestBypassed` appeared nowhere. H16 itself landed later (§2).
- `MockStakingR014G` — added `votingPowerOf(address)` for C3 floor
- `MockTegridyTWAP` (R014_POL) — added `lastBypassUsed`

---

## 7. Process recommendations (carried over from MICROSCOPE_2026_04_30)

1. **Sibling-search every audit fix.** Adopt as a standing process invariant — every audit-fix PR should grep for sibling entrypoints touching the same state and confirm the fix applies uniformly.
2. **Adopt `_assertTWAPFresh()` at every new TWAP consumer.** Don't let a future contract bypass any of the three freshness signals. **Corrected 2026-09-17:** there is no such helper (§5.3). Copy the inline `lastBypassUsed` cooldown POLAccumulator uses (H16).
3. **Move instant-mutation owner setters behind timelock.** `setRewardNotifier` (deferred M-S6), `setBaseURI` (post-mint mutability — Low), `setMintPrice` (now partially gated post-fix), and any future similar setters should propose/execute through `TegridyStakingAdmin` or a peer.
4. **Run `MAX_DELAY` invariant tests on every TimelockAdmin child.** With M-Lib1 the cap is now load-bearing — a forge invariant test that random-fuzzes propose-delay ranges is cheap insurance.
5. **A paid human firm review remains on the roadmap.** AI-agent + microscope-pass coverage has plateaued. Recommended firms: OpenZeppelin / Trail of Bits / Spearbit / Cyfrin.

---

## 8. Provenance

This ledger documents work performed on 2026-04-29 → 2026-05-01.
Source tree state: `main` post-Batches A-J + microscope remediation.
Test runner: forge `forge-std` v1.9+, solc 0.8.26, via_ir=true.
Source-of-truth audit: [`.audit_101/MICROSCOPE_2026_04_30.md`](MICROSCOPE_2026_04_30.md).
Remediation pass led by Claude Opus 4.7 (1M context) under user mandate
"meticulously resolve each and every issue methodically so that no new exploit
is introduced, try using available battle tested code from billion dollar
protocols to substitute the code when appropriate".

Every code change is tagged `AUDIT MICROSCOPE_2026_04_30 <ID>` in source
comments for grep-ability.

**Corrected 2026-09-17:** most are not. At `7e7a4a15` and on trunk, `contracts/src` carries `MICROSCOPE` tags only for C1, C2, C3/C4, H18–H22, M-D3, M-D4 and M-Lib1–3. Every other fix shipped under the ID of the pass that actually landed it (DEEP-*, FRESH-EYES, PASS5–8, FRESH-2026, BATCH-*), as recorded in its row. Search for those IDs, not for the microscope ID.
