# Tegriddy Farms — Post-Minimal-Surface-Mandate State

**Date:** 2026-05-08
**HEAD:** `6865982` (minimal MEDs) on top of `e441133` (Wave-B revert) on top of `8d8bac4` (Wave A).
**Mandate:** `memory/feedback_minimal_surface.md` — custom code IS the exploit source; copy battle-tested billion-dollar protocols verbatim; DELETE before ADD.

## Summary by severity

| Severity | Total | Closed | Accepted-as-design | Net code added by closures |
|---|---|---|---|---|
| CRITICAL | 1 | 1 | 0 | ~5 LoC (Synthetix anchor reorder) |
| HIGH | 17 | 16 | 1 (H-4) | Wave A diff |
| MEDIUM | 49 | 33 | 16 | Wave A diff + ~14 LoC (4 minimal MEDs) |
| LOW | 113 | partial | majority | NatSpec / no-op |
| INFO | 209 | n/a | n/a | n/a |

## Closure mechanism

Every closed item used one of the four mandate-allowed shapes:

1. **DELETE** the feature (most preferred). Examples: kLast bootstrap gate (one condition removed), removing dead state in TegridyLPFarming.
2. **REPLACE-WITH-CANONICAL** — swap custom code for an OZ / Uniswap / Curve / Aave / Synthetix / Solmate primitive. Examples: M-40, M-42 → `WETHFallbackLib`; M-15 → `whenNotPaused` modifier mirroring sister fix; H-15 → backport of TegridyStaking's existing rotation pattern.
3. **MINIMAL TWEAK** — 1-3 line change against an already-canonical pattern. Examples: C-1 (Synthetix `updateReward` reorder), H-2 (one branch added to `getReward`), M-19 (mirror `hasPremium` gate inside `getSubscription`).
4. **ACCEPT-AS-DESIGN** — document operator concern; do not add code.

## Accepted-as-design — full list

Each entry below is open in the original 100-agent audit but **intentionally not patched** because the only available fix shape would be to add new mappings, claim flows, admin functions, or state machines — exactly the kind of compound machinery that introduced 2 NEW CRITs + 4 NEW HIGHs in the reverted Wave B.

### HIGH

- **H-4 — VoteIncentives stranded bribes/votes on post-snapshot pair-disable.** Closure would need a new refund leg + per-recipient stranded-bribe mapping (anti-pattern). Operational mitigation: drain bribes via `claimBribes` / `refundOrphanedBribe` BEFORE invoking `TegridyFactory.emergencyDisablePair`. Document in deploy runbook. Reference: Aerodrome's `BribeVotingReward` defers identical edge case to operator discipline.

### MEDIUM

- **M-2** TegridyRestaking `emergencyForceReturn` strands NFT — admin-only path, mitigated by `proposeRescueNFT` (Wave A); accept.
- **M-3** TegridyRestaking `rescueNFT` bypass — admin-only + 48h timelock; accept.
- **M-4** TegridyRestaking `rescueNFT` target = staking-no-receiver — admin chooses recipient via timelock; accept.
- **M-5** SwapFeeRouter WETH path bypasses staker share — operator concern; document, do not add gate (would force WETH-input users into a weird path).
- **M-6** SwapFeeRouter `withdrawTokenFees` can drain to treasury — `onlyOwner` + 48h treasury rotation timelock; mitigated by governance posture, not code.
- **M-9** VoteIncentives disabled-pair claim revert — same root as H-4; accept.
- **M-10** VoteIncentives refund races on `voteEnd` — closure needs frozen snapshot mapping (anti-pattern); accept. Consumers see deterministic state once epoch advances.
- **M-11** VoteIncentives orphan refund 30-day delay — operator can advance epoch sooner; accept.
- **M-16** CommunityGrants `MAX_DISBURSEMENTS = 100` ring buffer — DEEP-GOV-05's revert-on-full prevents silent bypass; operators wait for the rolling window to clear; accept.
- **M-18** TegridyNFTPool per-token royalty bypass via `tokenIds[0]` — Sudoswap V2 LSSVMPair has the same per-trade single-receiver behavior; per-token royalty tables are a creator-side concern documented in NatSpec; accept.
- **M-29** Toweli "governance token" doc drift — Toweli is utility/reward; voting power lives in TegridyStaking (veTOWELI). NatSpec-only fix already in Wave A; accept the "no ERC20Votes" design.
- **M-30** TegridyStakingJbacVault non-upgradeable — intentional immutability per security mandate. If staking ever redeploys, vault redeploy is part of the migration runbook; accept.
- **M-39** POLAccumulator captured-owner harvest 10%/30d — already meaningful constraint, 48h timelock on recipient. Tightening to a rolling annual cap would add new state (mandate violation); accept the documented bound.
- **M-41** CommunityGrants home-rolled `_transferETHOrWETH` — actually correct: the home-rolled version explicitly unwraps WETH back to ETH on final failure (line 1105), which the lib's `safeTransferETHOrWrapNoRevert` does NOT. Replacing with the lib would be a regression. Accept the divergence as intentional and *better* than the lib variant for this use case.
- **M-43** TegridyFeeHook double-wrap on WETH-claim leg — closed transitively by H-11 prewarm in RevenueDistributor (10k stipend now sufficient post-prewarm); no additional fix needed.
- **M-46** CommunityGrants `getProposalsInRange` unbounded — already documented as off-chain-indexer-only in NatSpec (lines 1186-1193). Adding a runtime cap would risk breaking subgraphs that batch in larger chunks. Accept; on-chain consumers must use `getProposalsByStatus` paginated form.
- **M-47** TegridyDropV2 Dutch auction during sequencer outage — auctions naturally progress; outage during the curve is symmetric to outage during a real-time market (bidders can't act either way). Accept.

### LOW (selected; full list in original findings files)

- All NatSpec drift, dead-state cleanup, doc-only items: accept; cleaning them up risks breaking off-chain consumers / event indexers for zero security gain.
- All "captured-owner can do X within timelock window" items where X is bounded by the timelock: accept (governance posture, not code).
- All "consumer should use newer view" items: NatSpec already documents.

## Outstanding work blocked by mandate

The following would close additional findings *but* require building new state machines, admin functions, or mapping accumulators — exactly the anti-pattern that Wave B revealed. Per `memory/feedback_minimal_surface.md`, these are escalations, not silent additions:

- VoteIncentives bribe-on-disabled-pair refund leg (H-4 / M-9)
- CommunityGrants `pendingStrandedGrantWETH` mapping + claim path (Wave-B-style pattern that the meta-review flagged as an anti-pattern itself)
- VoteIncentives EIP-170 size split into a sister contract (not actually a finding — the size only ballooned due to Wave B over-engineering, which is reverted)
- Per-token royalty iteration in TegridyNFTPool (would add gas cost + complexity to a hot path)

## Confidence statement

After Wave A + minimal-MED commit + Wave B revert, the codebase is consistent with the minimal-surface mandate. The reverted Wave B work is preserved in git history (`c490a84`, `d04af18`) for reference but is NOT on the deploy path. Future fixes to remaining findings must either DELETE the underlying feature, REPLACE with a canonical pattern, or be escalated for explicit user approval before custom code is written.
