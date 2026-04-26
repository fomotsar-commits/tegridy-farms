# Full-Force Audit — 2026-04-21

Fresh pass over all 25 smart contracts. Each of four parallel agents read assigned cluster end-to-end, verified prior claimed fixes, and hunted for NEW exploits beyond what Spartan / 300-agent / read-it-myself passes caught.

Prior fix commits audited: `88db1f6` (economic-design) + `986ed00` (13-fix bulletproof). Scope: `contracts/src/` + base/lib.

---

## Verdict on prior claimed fixes

| Claim | Status | Notes |
|---|---|---|
| C1 (token-fee → staker) | **REAL (policy-gated)** | `convertTokenFeesToETH` exists and folds to `accumulatedETHFees`. But `withdrawTokenFees` still present & owner-only — fix depends on keeper discipline, not code enforcement. |
| C1-extended (referral split ordering) | **NOT FIXED AS DOCUMENTED** | 100% of fee still sent to splitter; fix was redirected to `recoverCallerCredit` permissionless pull. Deferred-settlement workaround, not the documented ordering change. |
| C2 (per-NFT → per-user vote) | **REAL** | `hasUserVotedInEpoch[user][epoch]` enforced in `vote()` + `revealVote()`. |
| C3 (RevenueDistributor lock-state) | **REAL for EOAs; REGRESSION for restakers** | Aggregate voting power path works for multi-NFT holders, but **restakers silently lose 100% revenue share** — see NEW-S1 below. |
| C4 (staker/POL WETH fallback) | **REAL** | `pendingDistribution[recipient]` queue + `withdrawPendingDistribution` via WETHFallbackLib. |
| C5 (extend-lock fee) | **REAL** | `extendFeeBps` default 0, cap 200 bps, 48h timelock. |
| C6 (penalty recycle) | **REAL** | `_splitPenalty` / `_creditRewardPool` after `_clearPosition`. Default 0. |
| C7 (origination fee Lending) | **REAL** | 2% cap, 48h timelock, WETH fallback. |
| H5/H14 (min APR) | **REAL** | 10% cap, 48h timelock. |
| H6 (whitelist removal orphans loans) | **NOT FIXED** | Task brief listed as claimed; actual commits do not address it. Still open. |
| H9 (DropV2 refund drain) | **PARTIAL — BYPASSABLE** | `withdrawn` flag blocks cancel, but `withdraw()` is still callable repeatedly during active mint. Creator can drain batch-by-batch then permanently brick refund. |
| H10 (SNAPSHOT_LOOKBACK guard) | **REAL (cosmetic dead branch)** | Works; has dead `block.timestamp > 0 ? ...` branch. |
| H11 (pendingETH view) | **REAL** | Routes through aggregate lock-state. |
| H12 (LPFarming single-pointer boost) | **REAL** | Aggregate try/catch fallback, 4.5× ceiling retained. |
| H13 (BonusShortfall event) | **REAL (observability only)** | Event fires on truncation; truncation itself still silent. |
| L2 (recoverCallerCredit accounting) | **REAL** | Folds recovered ETH into `accumulatedETHFees`. |
| L7 (TWAP update fee) | **REAL** | Fee + refund path present. |
| M8 (DropV2 platformFeeBps cap) | **REAL** | 10% cap enforced. |
| M9 (NFTPool changeFee timelock) | **REAL (weak)** | 24h timelock present; lacks `ExistingProposalPending` guard + `PROPOSAL_VALIDITY` window that sibling contracts have. |
| M10 (PremiumAccess cancel during pause) | **REAL** | `whenNotPaused` removed. |
| M11 (LPFarming forfeit dust reclaim) | **REAL** | `reclaimForfeitedRewards` caps at safe diff. |
| M12 (POL harvest path) | **REAL** | Timelocked `harvestLP`. |
| M13 (CommunityGrants self-vote) | **REAL (with escape hatch)** | `holdsToken` check works when `proposerTokenId != 0`, but silently skipped when = 0. See NEW-G7 below. |

**Regressions / incomplete fixes to treat as open:** C1-extended, C3 (restaker path), H6, H9, M9.

---

## NEW findings by severity

### CRITICAL (7)

**NEW-S1 · `RevenueDistributor` silently pays 0 to every restaker for every epoch**
`TegridyStaking._update` zeroes the checkpoint when an NFT moves to `restakingContract`, and `restakingContract`'s own checkpoint is forced to 0 at aggregation time. `_calculateClaim` reads `votingPowerAtTimestamp(user, epoch.ts) = 0` → `totalOwed=0` → `claim()` reverts. **30% of TVL restaked × $1M/yr distributed = $300K/yr silent loss**, eventually reclaimable to treasury via `executeForfeitReclaim`.
Fix (Curve veCRV): preserve `from` user's voting power when `to == restakingContract`, or expose `TegridyRestaking.votingPowerAtTimestampFor(user, ts)` and have RevenueDistributor fall through to it.

**NEW-A1 · TegridyPair FoT-output desync drains reserves** (TegridyPair.sol:218)
`_update(predictedBalance)` writes reserves BEFORE the transfer. A fee-on-transfer output token deducts more than `amount0Out`; actual balance < reserve. Future swaps compute `amount0In = 0` while K uses inflated `_reserve0` → slow drain of the WETH side. Factory's `_rejectERC777` is best-effort and bypassable by tokens that add hooks post-creation.
Fix (Uniswap V2 reference): reorder to transfer-then-read-actual-balance, or restrict pairs to the token blocklist at each swap.

**NEW-A2 · ERC-777 post-creation mutation bypass** (TegridyFactory.sol:213-248)
Token passes factory-time ERC-777 check, pair is created, then token is upgraded via proxy or flips to FoT mode. No runtime guard. 48h timelocked `disabledPairs` is too slow to react — attacker drains during the delay.
Fix (Compound/Aave emergency-pause role): add a guardian-controlled instant `emergencyDisablePair(pair)` path bypassing the 48h timelock.

**NEW-G1 · VoteIncentives bribe amounts fully visible during 2.8-day commit window**
Commit-reveal hides which gauge a voter chose, but `epochBribes[epoch][pair][token]` is public. A briber watches commits and top-ups bribes during the window. Voters who committed early are lockedin but future bribe totals inflate, skewing the incentive market.
Fix (Hidden-Hand / Warden): bribe-side commit-reveal or hard cutoff at `epochStartTime`.

**NEW-G2 · `VoteIncentives.rescueOrphanedBribes` drains user bribes to treasury**
Only guard is `epoch >= epochs.length` + 30-day delay since first deposit. Owner can delay `advanceEpoch` (permissionless but no keeper incentive) → after 30d, rescue the entire epoch's bribe pool to treasury. `BRIBE_RESCUE_DELAY` runs from FIRST deposit, so a tiny dust bribe at T-0 plus fresh bribes at T-29d all get swept together.
Fix (Curve): refund to original depositors via `depositorOf[epoch][pair][token][depositor]` tracking; key delay off LATEST deposit.

**NEW-G3 · VoteIncentives rounding-dust sweep drain** (VoteIncentives.sol:480-484)
When `share == 0` in `claimBribes`, `continue` skips decrementing `totalUnclaimedETHBribes`. Accumulated dust across millions of claims stays in `accumulatedTreasuryETH` and is sweep-drainable.
Fix (Velodrome): track `remainderBribes[epoch][pair][token]` explicitly, reclaimable by any voter, not swept to owner.

**NEW-L1 · TegridyDropV2 multi-`withdraw()` H9 bypass** (TegridyDropV2.sol:389-408)
`withdrawn` flag only blocks `cancelSale`, not repeat `withdraw()`. Creator collects 100 mints, withdraws, 500 more mints, withdraws again. By step 3 refund is permanently impossible because cancelSale reverts on `withdrawn`.
Fix (Thirdweb/Manifold): track refund reserve; `withdraw()` releases only `balance - Σ paidPerWallet`, or gate by `mintPhase == CLOSED`.

### HIGH (14)

**NEW-S2 · `revalidateBoostForRestaker` permissionless boost-strip grief** (TegridyRestaking.sol:927-968)
Attacker calls during victim's brief JBAC-less window → `TegridyStaking.revalidateBoost` permanently strips legacy JBAC boost. Cost: gas only.
Fix: match Staking's auth model — `msg.sender == user || msg.sender == owner()`.

**NEW-S3 · `decayExpiredRestaker` order-of-ops bonus dilution** (TegridyRestaking.sol:1022-1055)
`updateBonus` modifier accrues against stale-inflated `totalRestaked` BEFORE decay applies. Honest restakers subsidize the expired restaker's share for the entire stale window.
Fix (Synthetix): reorder — decay `totalRestaked` first, then accrue. Or pay a keeper bounty.

**NEW-S4 · LPFarming partial-withdraw rounding concentrates boost** (TegridyLPFarming.sol:285-296)
Proportional reduction `(eff * amount) / raw` truncates down; repeated 1-wei withdraws compress ratio above MAX_BOOST_BPS ceiling. Whale extracts excess rewards; all others dilute.
Fix (Curve LiquidityGaugeV4): recompute `effectiveBalanceOf` from scratch after withdraw, matching `stake()` pattern already in place.

**NEW-A3 · `swapExactETHForTokens` slippage asymmetry** (SwapFeeRouter.sol:361-362)
ETH-out variant correctly grosses up `amountOutMin`; ETH-in variant passes through the pre-fee router without adjustment. User's stated minimum applies to `amountAfterFee`, not `msg.value` — silent overpay.
Fix: symmetric gross-up logic on both ETH-direction variants.

**NEW-A4 · SwapFeeRouter missing `deadline >= block.timestamp` lower bound** (SwapFeeRouter.sol:344)
Inner Uniswap router catches it but only after fee accumulation. Defense-in-depth gap.
Fix: add explicit lower-bound require matching TegridyRouter's `ensure()` modifier.

**NEW-A5 · `convertTokenFeesToETH` permissionless sandwich** (SwapFeeRouter.sol:1038-1065)
Caller-supplied `minETHOut` protects the caller, not the protocol. Attacker manipulates USDC/WETH pool mid-bundle, calls converter, unwinds.
Fix (Curve admin_fee): TWAP-gate via TegridyTWAP (revert if spot deviates >1% from 30m TWAP) OR keeper-allowlist OR per-token rate limit.

**NEW-A6 · Token unblock doesn't force per-pair re-enable** (TegridyFactory.sol)
`disabledPairs` and `blockedTokens` are independent maps. Unblocking a token activates every existing pair silently.
Fix (Curve gauge-add): explicit per-pair reactivation after parameter change.

**NEW-L2 · Lending EOA double-stake permanently locks collateral** (TegridyLending.sol × TegridyStaking.sol:885)
Borrower stakes A → accepts loan with A as collateral (A moves to Lending, `userTokenId[borrower]=0`) → stakes again → `userTokenId[borrower]=B`. `repayLoan` triggers `transferFrom(Lending, borrower, A)` → EOA-guard reverts `AlreadyHasPosition`. If lender is also EOA-with-position, `claimDefaultedCollateral` also reverts — **NFT permanently stuck in Lending**.
Fix (NFTfi): allowlist lending contracts past the EOA guard: `!isLendingContract[from]`.

**NEW-L3 · NFTLending whitelist removal still orphans active loans** (TegridyNFTLending.sol:604-612)
24h WHITELIST_TIMELOCK < 365d MAX_DURATION. Delisted collections' active loans run to natural conclusion with no recourse.
Fix: per-collection active-loan counter; block removal while active loans exist, or add atomic unwind path.

**NEW-G4 · VoteIncentives `ep.timestamp = block.timestamp - 1` front-runnable** (VoteIncentives.sol:328)
Attacker stakes max-boost + triggers permissionless `advanceEpoch` in same or next block → their new checkpoint is captured in `ep.timestamp`. Contrast GaugeController's deterministic `epochStartTime(epoch)`.
Fix: deterministic epoch timestamp + SNAPSHOT_LOOKBACK (1h) like CommunityGrants.

**NEW-G5 · `enableCommitReveal` no timelock → front-run lock-in of one legacy epoch** (VoteIncentives.sol:1023)
Attacker sees `enableCommitReveal()` in mempool → front-runs with `advanceEpoch()` to create one more legacy epoch. Has 7 days of mempool-visible voting after the flip.
Fix: 24h timelock on the flip; pause legacy `vote()` for all epochs created after the proposal is queued.

**NEW-G6 · `TegridyTWAP` uint32 timestamp rollover** (TegridyTWAP.sol:137)
At 2106 (U32 rollover) or sooner on chains with offset epochs, deviation check is bypassed for a 15-min window. Consumers (Lending `minPositionETHValue`) fed manipulated prices.
Fix (Uniswap V3 Oracle): uint256 timestamps; explicit wrap handling.

**NEW-G7 · CommunityGrants `proposerTokenId=0` bypasses self-vote check** (CommunityGrants.sol:239, 271)
Multi-NFT Safe or restakingContract proposer has `userTokenId=0` → `if (proposerTokenId != 0)` branch skipped. Only address-equality guards remain; attacker uses different controlled address to self-fund grant.
Fix: require `proposerTokenId > 0` at proposal creation, OR snapshot full `_positionsByOwner(proposer)` set.

**NEW-G8 · `MIN_EPOCH_INTERVAL = 1h` advance-spam** (VoteIncentives.sol)
168 epochs/week possible. Attacker spams `advanceEpoch` to split bribe pool into dust shares, each rounds to 0 → all sweep-drainable.
Fix (Aerodrome): `MIN_EPOCH_INTERVAL = 7 days`; deterministic epochs.

### MEDIUM (10)

**NEW-S5** · `notifyRewardAmount` permissionless — funder-sandwich own claim (TegridyStaking.sol:1161). Fix: Synthetix `RewardsDistributionRecipient` allowlist.
**NEW-S6** · LPFarming `emergencyWithdraw` no `updateReward` → accounting drift after low-activity period (TegridyLPFarming.sol:317-338). Fix: add modifier.
**NEW-S7** · `_writeCheckpoint` no-op writes (TegridyStaking.sol:1007). Fix: compare-before-push.
**NEW-A7** · TegridyPair `_mintFee` only on mint/burn events; no permissionless harvest (TegridyPair.sol:109, 274). Fix (Balancer V2/Curve): add `harvest()`.
**NEW-A8** · `sync()` permissionless — grief direct-pair integrations (TegridyPair.sol:246). Fix: document or restrict.
**NEW-A9** · Factory `_rejectERC777` incomplete — checks `ERC777Token` only, misses `ERC777TokensSender`/`Recipient` hooks (TegridyFactory.sol:217-247). Fix: check all three.
**NEW-A10** · TegridyPair `mint()` accepts `to == address(this)` (TegridyPair.sol:98). Add `INVALID_TO` check matching `burn()`.
**NEW-L4** · NFTPool unsafe `transferFrom` orphans NFTs (no `onERC721Received` → `_idToIndex`=0 → stuck). Fix (Sudoswap): add `syncNFTs(uint256[])`.
**NEW-L5** · DropV2 Merkle leaf single-hashed (TegridyDropV2.sol:279). Fix (OpenZeppelin v4.9+): double-hash.
**NEW-L6** · NFTPool propose/execute lacks `ExistingProposalPending` guard + `PROPOSAL_VALIDITY` window (TegridyNFTPool.sol:309-406). Fix: align with `TimelockAdmin` pattern used by siblings.

### LOW (10)

**NEW-S8..S10** · Restaking `hasRecoveredPrincipal` one-way; `claimUnsettled` paused-stranding; `recoverERC20` → treasury vs owner inconsistency.
**NEW-A11..A13** · Same-value fee proposals allowed; `pairFeeBps` key ambiguity (pair vs token); unrestricted `receive()`.
**NEW-L7** · DropV2 royalty cap 100% (should be ≤10%).
**NEW-L8** · NFTPool initial `protocolFeeBps=0` footgun.
**NEW-G9** · VoteIncentives `sweepToken(toweli)` can drain active commit bonds. Fix: track `totalCommitBonds` in reserved.
**NEW-G10** · POLAccumulator harvest → treasury `safeTransfer` with no WETH-fallback: compromised treasury DoSes harvest for 30d/cycle.
**NEW-G11** · POLAccumulator 10% harvest × 12mo ≈ 67% POL drain possible. Fix (Olympus AMO): lifetime cap or 5%/quarter.

### INFO

**NEW-I1** · H10 dead-code branch (`block.timestamp > 0 ? ...`).
**NEW-I2** · GaugeController commits lack chainid + address binding (unlike VoteIncentives).
**NEW-I3** · Uint16 epoch counter approaches ceiling at ~7.5 yr at 1h cadence.
**NEW-I4** · Duplicate `"INVALID_TO"` error strings in TegridyPair.
**NEW-I5** · `feeToSetter` single role controls all Factory admin actions (no separation of duties).

---

## Fix-batch priority (recommended order)

**Batch A — Critical user-fund paths** (4 fixes)
- NEW-S1 restaker revenue claim
- NEW-A1 FoT-output desync (reorder `_update`)
- NEW-L1 DropV2 refund-drain H9 bypass
- NEW-G2 rescueOrphanedBribes → depositor refund

**Batch B — Critical governance integrity** (3 fixes)
- NEW-G1 bribe-side commit-reveal OR deposit cutoff
- NEW-G3 rounding-dust drain (track `remainderBribes`)
- NEW-G7 CommunityGrants proposerTokenId=0 escape

**Batch C — High-severity structural** (8 fixes)
- NEW-L2 EOA double-stake collateral lock
- NEW-G4 VoteIncentives deterministic epoch timestamp
- NEW-G5 enableCommitReveal timelock
- NEW-G8 MIN_EPOCH_INTERVAL → 7d
- NEW-S2 revalidateBoostForRestaker auth
- NEW-S3 decayExpiredRestaker reorder
- NEW-S4 LPFarming recompute-from-scratch on withdraw
- NEW-A2 factory guardian emergency-pause

**Batch D — High-severity hardening** (6 fixes)
- NEW-A3 swapExactETHForTokens slippage symmetry
- NEW-A4 SwapFeeRouter deadline lower bound
- NEW-A5 convertTokenFeesToETH TWAP gate
- NEW-A6 per-pair re-enable on token unblock
- NEW-L3 whitelist-removal active-loan guard
- NEW-G6 TWAP uint256 timestamp migration

**Batch E — Medium** (10 fixes)
All M-tier items.

**Batch F — Low + info**
Polish pass.

Total: 40 new findings, of which 7 CRITICAL, 14 HIGH, 10 MEDIUM, 10 LOW, 5 INFO, plus 5 unresolved/regressed claimed fixes (C1-ext, C3-restaker, H6, H9, M9-partial).
