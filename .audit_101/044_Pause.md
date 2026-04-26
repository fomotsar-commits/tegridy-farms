# Agent 044 — Pause / Circuit-Breaker Discipline

Scope: contracts/src/ — 26 contracts, 18 with Pausable (~69%).

## Cross-Cutting Findings

| Concern | Status |
|---|---|
| Pause role separation (PAUSER_ROLE vs OWNER_ROLE) | NONE. All `pause()` is `onlyOwner`. Single-key emergency. |
| Pause expiration / max duration | NONE. Every pause is indefinite — no auto-unpause, no MAX_PAUSE constant, no timeout. |
| Pause-independent emergency exits for user funds | Partial (Staking C-05, Restaking, Lending repay, Drop refund, RevDist withdrawPending). |
| `whenPaused` on owner-only fund recovery | Mostly missing. Only CommunityGrants.emergencyRecoverETH + Restaking.emergencyForceReturn enforce it. |
| Pauser ≠ Owner role separation | NEVER implemented anywhere (no PAUSER_ROLE in repo). |

## Per-Contract Checklist

### TegridyPair.sol  [DESIGN RISK — NO PAUSE]
- Has-pause: NO. Uniswap-V2 fork — `swap`/`mint`/`burn`/`skim`/`sync` all public, no circuit breaker.
- Where-needed: A bug in TegridyFeeHook or oracle path is unrecoverable without pair pause. Acceptable per Uniswap design but flagged: TegridyFeeHook IS pausable (line 175 `if (paused()) skip`) so the fee hook can be neutered, but the pair itself never halts. Means a malicious/buggy fee hook can be detached but a bug in pair math cannot be paused.
- Block-users: N/A (no pause).

### TegridyRouter.sol & TegridyFactory.sol
- Has-pause: NO. Stateless routing/deploy. Acceptable.

### Toweli.sol (token)
- Has-pause: NO. ERC-20 — acceptable; transfers stay open.

### TegridyLending.sol
- Has-pause: YES (Pausable, line 51).
- whenNotPaused: createOffer (333), acceptOffer (406), claimDefaultedCollateral (560).
- repayLoan (488): EXPLICITLY pause-independent (good; comment line 484 confirms anti-grief intent).
- cancelOffer (379): pause-independent (good; lender always recoverable).
- ISSUE: claimDefaultedCollateral IS gated by pause. With no pause expiry + indefinite pause, owner can lock lenders out of collateral indefinitely after default. Borrower gets free option (still can repay since repayLoan is unpausable, but lender carries denied-claim risk). RUG SURFACE.
- recoverERC20/recoverETH: not present — clean.

### TegridyStaking.sol
- Has-pause: YES.
- whenNotPaused: stake, stakeWithBoost, toggleAutoMaxLock, extendLock, increaseAmount, withdraw, earlyWithdraw, getReward, revalidateBoost, claimUnsettled.
- whenPaused: emergencyWithdrawPosition (1078) — pause-only exit.
- emergencyExitPosition (1097) + requestEmergencyExit/executeEmergencyExit (1119/1142): pause-independent 7-day-delay path. STRONG — addresses indefinite-pause rug for lock-expired positions.
- ISSUE: revalidateBoost gated by pause is intended (M-21) but means pause CAN damage users by retaining stale boost during pause; fine.

### TegridyLPFarming.sol
- Has-pause: YES (line 56).
- whenNotPaused: stake (243) ONLY.
- withdraw (281), exit (270), getReward (311): NO whenNotPaused — STRONG (LP exit always works).
- emergencyWithdraw (335): pause-independent.
- pause is single-key.
- recoverERC20 (462): NOT gated by whenPaused. Owner can sweep arbitrary non-staking/reward tokens at any time. Low risk (excludes stake+reward) but missing belt-and-braces.

### POLAccumulator.sol
- Has-pause: YES (M-14 fix).
- whenNotPaused: accumulate (238) — only function gated.
- ISSUE: accumulate is `onlyOwner`-only anyway; pause is redundant. No user funds held in steady state — fine, low priority. No emergency recovery path for stuck ETH/LP if owner key compromised + paused; acceptable since owner keys are escrowed in timelock.

### RevenueDistributor.sol
- Has-pause: YES.
- whenNotPaused: distribute (198), distributePermissionless (211), claim (423), claimUpTo (469).
- withdrawPending (624): pause-independent — STRONG (failed transfer recovery always works).
- ISSUE — **HIGH RUG SURFACE**: claim()/claimUpTo() are paused, AND they ALSO check `_isStakingPaused()` (line 427/471). Pausing EITHER staking OR distributor freezes ALL voter ETH claims. Two single-key pauses on user withdrawals, no expiry, no recovery path. If both indefinite-paused, voter ETH is rug-surface.
- No `whenPaused` on owner functions: owner does not control held ETH directly, but proposeXxx for fee/treasury changes need timelock, not pause.

### TegridyDropV2.sol
- Has-pause: YES (initializable; line 19).
- whenNotPaused: mint flow (line 268).
- refund (457): pause-independent — STRONG (cancelled-sale refund always works).
- withdraw (418): NOT gated by whenPaused. Owner withdraws creator+platform ETH at will. Combined with pause, owner can pause mints, withdraw funds, leave (refund still works pre-withdraw thanks to H9 lock). Acceptable: H9 logic at line 451 prevents post-withdraw cancel.

### TegridyLaunchpadV2.sol
- Has-pause: YES.
- whenNotPaused: createCollection (123) — only deploy is gated.
- No user funds held by Launchpad itself (factory). Pause is cosmetic for deploy-throttling. Fine.

### TegridyNFTPoolFactory.sol
- Has-pause: YES.
- whenNotPaused: createPool (128) — only.
- Pause cannot affect existing pools. Acceptable.

### TegridyNFTPool.sol  [HIGH RUG SURFACE]
- Has-pause: YES.
- whenNotPaused: swapETHForNFTs (188), swapNFTsForETH (236).
- ISSUE — **CRITICAL**: withdrawETH (410) and withdrawNFTs (417) are `onlyOwner nonReentrant` with NO whenPaused gating. Pool owner (LP provider) can:
  1. Pause swaps (locks counterparties out of buying/selling against the pool).
  2. Drain ETH + NFTs immediately.
  3. Leave protocol-fee accumulator empty for the factory.
- This is a textbook rug: owner-pauses + owner-drains. The factory's `claimProtocolFees` (466) can still execute regardless of pause — small mitigation. But no protection for the pool's mid-trade counterparties.
- syncNFTs (436) onlyOwner, no whenPaused — fine (recovery only adds to held set).

### TegridyNFTLending.sol
- Has-pause: YES.
- whenNotPaused: createOffer (262), acceptOffer (337), claimDefault (472).
- repayLoan (405): pause-independent (good).
- cancelOffer (312): pause-independent (good).
- SAME ISSUE as TegridyLending: claimDefault under pause = lender can be denied collateral indefinitely.

### TegridyRestaking.sol
- Has-pause: YES.
- whenNotPaused: restake (289).
- unrestake (470), emergencyWithdrawNFT (789): pause-independent — STRONG.
- emergencyForceReturn (873): `onlyOwner whenPaused` — properly gated. Rate-limited via FORCE_RETURN_COOLDOWN. Best example of pause discipline in repo.

### SwapFeeRouter.sol
- Has-pause: YES.
- whenNotPaused: all swap variants (349, 391, 457, 521, 584, 644, 1090, 1137).
- No user funds held (router pattern). Pausing simply blocks routing. Acceptable.

### VoteIncentives.sol
- Has-pause: YES.
- whenNotPaused: advanceEpoch, vote, depositBribe, depositBribeETH, claimBribes, claimBribesBatch, sweepForfeitedBond, commitVote, revealVote.
- ISSUE — **MEDIUM**: claimBribes / claimBribesBatch gated by pause. Voters can be denied bribes indefinitely. Cross-pause check on votingEscrow (982). Same shape as RevDist.
- No whenPaused-gated owner sweep. rescueOrphanedBribes (907) is `pure { revert }` — neutered. No owner ETH withdraw — clean.

### CommunityGrants.sol  [GOOD PATTERN]
- Has-pause: YES.
- whenNotPaused: createProposal, voteOnProposal, finalizeProposal, executeProposal.
- whenPaused: emergencyRecoverETH (565). PROPER GATING.
- Best treasury hygiene in repo. Note: a paused contract still allows owner to drain via emergencyRecoverETH — single-key risk remains, but the symmetry is correct.

### MemeBountyBoard.sol
- Has-pause: YES.
- whenNotPaused: createBounty, submitWork, voteForSubmission, completeBounty.
- ISSUE: completeBounty (303) gated. Bounty winner can be denied payout indefinitely under pause. Bounty creator's ETH is held in contract — no emergency claw-back if pause is indefinite. RUG SURFACE.

### GaugeController.sol
- Has-pause: YES.
- whenNotPaused: vote (189), commitVote (303), revealVote (342). No fund custody. Acceptable.

### PremiumAccess.sol
- Has-pause: YES.
- whenNotPaused: subscribe (186).
- No refund/withdraw method. Subscribers pay → owner sweeps. Pause stops new subs. Acceptable but no user recovery.

### TegridyFeeHook.sol  [GOOD PATTERN]
- Has-pause: YES.
- Pause CHECK INSIDE hook (line 175): `if (paused()) { return; }` — gracefully skips fee logic. STRONG: doesn't break the swap when fee path is broken, just disables fees.

### ReferralSplitter.sol
- Has-pause: NO Pausable inheritance.
- Holds caller-credit + referrer-rewards ETH. withdrawCallerCredit (294) + claimReferralRewards (308) — no pause gating means always callable; positive.
- forfeitUnclaimedRewards (475), withdrawTreasuryFees (504), sweepUnclaimable (518): all `onlyOwner`, no pause. Sweep paths exist but timelock-gated (TimelockAdmin not present here? — need to confirm). LOW. Owner could drain but it's the splitter's stated purpose. Flag: NO emergency pause means a bug in splitter logic is unfixable without redeploy.

## Severity Ranking

| # | Severity | Contract | Issue |
|---|---|---|---|
| 1 | HIGH | TegridyNFTPool | `withdrawETH`/`withdrawNFTs` lack `whenPaused` — owner can pause swaps and drain pool liquidity in same tx. Rug-pull surface for AMM-style NFT pool. |
| 2 | HIGH | RevenueDistributor | `claim()`/`claimUpTo()` gated by both own pause AND staking pause. Two single-key indefinite freezes on voter ETH revenue. |
| 3 | MEDIUM | TegridyLending / TegridyNFTLending | `claimDefaultedCollateral` / `claimDefault` gated by `whenNotPaused` — owner can indefinitely deny defaulted lenders their collateral while borrower's `repayLoan` stays open. |
| 4 | MEDIUM | TegridyPair | No pause despite holding LP funds and being root of all swap/mint/burn flows. Bug in invariant unfixable without migration. |
| 5 | MEDIUM | MemeBountyBoard | `completeBounty` gated. Winner payout can be indefinitely denied; no emergency-refund path for creators. |
| 6 | LOW | All 18 pausable contracts | No PAUSER_ROLE separation — single owner key holds emergency power. |
| 7 | LOW | All 18 pausable contracts | No pause expiration / max-duration. Indefinite pauses possible. |
| 8 | LOW | TegridyLPFarming | `recoverERC20` not whenPaused-gated (owner sweep of unrelated tokens unrestricted, even mid-pause). |
| 9 | INFO | ReferralSplitter | No Pausable inheritance despite holding user ETH credits. |
| 10 | INFO | TegridyFeeHook | EXEMPLAR — fee logic short-circuits on pause without breaking parent pair. Reference pattern. |

## Recommendations

1. Add `whenPaused` to TegridyNFTPool.withdrawETH/withdrawNFTs. Consider 24-72h timelock on withdraws even unpaused.
2. Drop `whenNotPaused` from claimDefault paths in both lending contracts; users with on-chain default proofs deserve unconditional collateral access. Pause should halt NEW loans, not enforcement of existing terms.
3. RevenueDistributor: do not double-gate claim() with both own pause AND staking pause. Pick one.
4. Add MAX_PAUSE_DURATION (e.g. 30 days) with auto-unpause; require multisig+timelock to extend.
5. Introduce PAUSER_ROLE distinct from owner — let any of {treasury multisig, monitoring keeper EOA} pause; only owner+timelock can unpause.
6. Consider Pausable for TegridyPair (or factory-level pause that all pairs respect via call-back). Or document as accepted Uniswap-V2 risk.
7. MemeBountyBoard.completeBounty: drop pause gate or add emergency creator-refund.
