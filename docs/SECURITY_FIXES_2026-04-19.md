# Security Fixes — Bulletproof Pass (2026-04-19)

Autonomous security hardening pass on branch `bulletproof/batch-1-mechanical`.
Every commit keeps the full `forge test` suite green (2009/2009).

## Fixes applied

| # | Sev | Item | Source | Commit |
|---|-----|------|--------|--------|
| 1 | HIGH | H-3 `SwapFeeRouter.withdrawFees()` removed — bypassed `MIN_STAKER_SHARE_BPS` (50%) guardrail. All ETH fee outflow now routes through `distributeFeesToStakers`. | 2026-04-20 audit | [991a5c6](../commit/991a5c6) |
| 2 | HIGH | H-4 `TegridyStaking.totalLocked` — state variable returning 0 → view function proxying `totalStaked`. Third-party integrators now read correct TVL. | 2026-04-20 audit | [991a5c6](../commit/991a5c6) |
| 3 | MEDIUM | critique 5.6 `TegridyPair.blockTimestampLast` — restored Uniswap V2 timestamp write. `getReserves()` no longer returns `0` (1970) for freshness-checking integrators. | April 2026 critique | [991a5c6](../commit/991a5c6) |
| 4 | MEDIUM | M-7 `TegridyLending.acceptOffer` — unlimited-gas `.call` → `WETHFallbackLib` (10k stipend + WETH wrap). Matches NFTLending pattern. | 2026-04-20 audit | [e9f5572](../commit/e9f5572) |
| 5 | LOW | critique 5.7 `VoteIncentives` — 10k → 50k gas stipend on bribe claim ETH transfers. Handles Safe / Argent / EIP-4337 smart accounts without the two-tx pending-fallback dance. Pending path retained as belt-and-suspenders. | April 2026 critique | [e9f5572](../commit/e9f5572) |
| 6 | MEDIUM | 300-agent #3 `TegridyLending.calculateInterest` — naive `_principal * _aprBps * elapsed / (BPS * SECONDS_PER_YEAR)` replaced with OZ `Math.mulDiv(..., Rounding.Ceil)`. 512-bit intermediate removes cap-ceiling overflow dependency. `_ceilDiv` helper deleted. | 300-agent audit | [d989b19](../commit/d989b19) |
| 7 | MEDIUM | 300-agent #12 `POLAccumulator` — four `(amount * bps) / 10000` slippage / backstop computations converted to `Math.mulDiv`. Floor rounding retained. | 300-agent audit | [d989b19](../commit/d989b19) |
| 8 | MEDIUM | M-1 proposer-ally snapshot lookback — `block.timestamp - 1` → `block.timestamp - SNAPSHOT_LOOKBACK` (1 hour) in `CommunityGrants.createProposal` + `MemeBountyBoard.createBounty`. Closes the pre-positioning frontrun. | 2026-04-20 audit | [27e4cac](../commit/27e4cac) |
| 9 | MEDIUM | M-3 forfeit-to-treasury redirect removed (`TegridyStaking._settleUnsettled`). Overage above `maxUnsettledRewards` now stays unreserved in the reward pool and re-accrues to all stakers. The cap is now genuinely honored. | 2026-04-20 audit | [594e50b](../commit/594e50b) |
| 10 | HIGH | critique 5.1 `TegridyStaking._getReward` — silent insolvency fixed. Shortfall above available `rewardPool` now routes through `_settleUnsettled` (mirroring `_settleRewardsOnTransfer`) so the user can reclaim on the next reward cycle. `RewardsForfeited` event emitted if cap exhausted. | April 2026 critique | [8495acd](../commit/8495acd) |
| 11 | MEDIUM | M-2 `CommunityGrants._transferETHOrWETH` — 100_000 → 10_000 gas stipend. Existing WETH fallback handles smart-account recipients. | 2026-04-20 audit | [5371f3a](../commit/5371f3a) |
| 12 | MEDIUM | M-4 `SwapFeeRouter.distributeFeesToStakers` — unlimited gas → 50_000 gas cap on staker + POL paths. Treasury path already used `WETHFallbackLib`. | 2026-04-20 audit | [8f6e927](../commit/8f6e927) |
| 13 | MEDIUM | M-5 `TegridyStaking._update` — loud `MultipleNFTsAtAddress` event emitted when a non-Restaking contract receives a second+ staking NFT. Off-chain alerting for integrators that silently lose vote power. | 2026-04-20 audit (Option B) | [545308c](../commit/545308c) |
| 14 | HIGH | H-2 DCA / Limit Orders — honest-UX rename (Option C from audit). Tab labels "DCA" → "Recurring Swap", "Limit" → "Price Alert". Intro copy aligned with existing "Browser-only feature" warning banner. Internal ids preserved. | 2026-04-20 audit | [70fb2a4](../commit/70fb2a4) |

**Net effect:** 4 HIGH + 8 MEDIUM + 2 LOW security findings addressed; 2009 tests
remain green; branch is single-commit-per-batch and reviewable.

## False positives ruled out

Prior agent-driven audits flagged three issues that current code already addressed;
kept here to prevent re-flagging:

- **`MemeBountyBoard` balanceOf-based voting.** Phase 3 sweep claimed this was
  flash-loan-exploitable. The contract already uses
  `stakingContract.votingPowerAtTimestamp(msg.sender, bounty.snapshotTimestamp)`
  ([`MemeBountyBoard.sol:266`](../contracts/src/MemeBountyBoard.sol#L266)).
- **`TegridyNFTLending` deadline race.** Phase 1 recon claimed `>` / `<=` mismatch
  between repay and claim paths. Both paths use correctly disjoint
  `GRACE_PERIOD` comparisons ([`TegridyNFTLending.sol:365`](../contracts/src/TegridyNFTLending.sol#L365) and [`:421`](../contracts/src/TegridyNFTLending.sol#L421)).
- **`TegridyLending` deadline race.** Same pattern — confirmed correct at
  [`TegridyLending.sol:425`](../contracts/src/TegridyLending.sol#L425) and [`:476`](../contracts/src/TegridyLending.sol#L476).
- **`TegridyRestaking` unsettled-reward delta race (300-agent #6).** Phase 3 echoed this without
  re-verifying. Current code uses `unsettledSnapshot` captured at deposit time
  ([`TegridyRestaking.sol:77`](../contracts/src/TegridyRestaking.sol#L77) / [`:505`](../contracts/src/TegridyRestaking.sol#L505) / [`:759`](../contracts/src/TegridyRestaking.sol#L759)) — the racy before/after pattern was
  already replaced.

## See also

- [`SECURITY_DEFERRED.md`](./SECURITY_DEFERRED.md) — items intentionally not
  shipped in this pass (architectural rewrites, external dependencies).
