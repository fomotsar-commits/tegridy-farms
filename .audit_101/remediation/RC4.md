# RC4 — Indexer Recovery Pass (re-applies R005 + R010 + R054)

**Date:** 2026-04-26
**Trigger:** Earlier indexer edits were reverted; this pass re-applies all
three remediations in a single coherent batch.

## R005 — Ponder 0.8.x key drift (re-applied)

`indexer/ponder.config.ts` `createConfig` block:
- `chains:` → `networks:` (top-level)
- `id:` → `chainId:`, `rpc:` → `transport:` (network entry)
- 9× `chain: "mainnet"` → `network: "mainnet"` (per contract)

## R010 — TimelockAdmin event overloads (re-applied)

Inline ABIs in `ponder.config.ts` now include `(bytes32 indexed key, ...)`
overloads for `ProposalCreated/Executed/Cancelled` on `TegridyStakingAbi`,
`TegridyLendingAbi`, and `CommunityGrantsAbi`. CommunityGrants additionally
keeps the explicit `(uint256 id)` grant-lifecycle overloads. Handlers in
`src/index.ts` use full Solidity-signature notation only where Ponder
needs disambiguation (CommunityGrants has both overloads); Staking and
Lending use the bare name since only the bytes32 form exists in their ABI.

## R054 — Subscription coverage (re-applied)

New subscriptions in `ponder.config.ts`:
- `TegridyPair:Swap/Mint/Burn` via `factory()` keyed on
  `TegridyFactory.PairCreated(token0, token1, pair, allPairsLength)`,
  parameter `pair`. Address `0x8B786163aA3beb97822d480a0c306DfD6dEbdCB6`.
- `Pausable:Paused/Unpaused` folded into the existing primary
  subscription for 10 contracts. Three (`PremiumAccess_Pause`,
  `POLAccumulator_Pause`, `TegridyNFTLending_Pause`) get dedicated
  `PausableOnly` filter contracts so the pause surface ships even before
  the primary surface is indexed.
- `GaugeController` full surface: `Voted, VoteCommitted, VoteRevealed,
  GaugeAddProposed, GaugeAdded, GaugeRemoveProposed, GaugeRemoved,
  EmissionBudgetProposed, EmissionBudgetUpdated`. (`GaugeFrozen`,
  `VoteCommitNftOwnerSnapshot` from the spec do not exist in the
  current Solidity source — flagged in source as not-yet-implemented.)
- `VoteIncentives`: `VoteCommitted, VoteRevealed, EpochAdvanced,
  BribeDepositedETH, OrphanedBribeRefunded` added to existing
  `BribeDeposited, BribeClaimed, GaugeVoted`. (`UnvotedBribeRefunded`
  named in spec doesn't exist in source; only `OrphanedBribeRefunded`
  is emitted today.)
- `TegridyRestaking`: `PositionRefreshed, BoostRevalidated,
  EmergencyForceReturn` admin reconciliation events.

`src/index.ts` schema fixes:
- `EarlyWithdrawn` handler reads all 4 args (`{ user, tokenId, amount,
  penalty }`); `penalty` persists on `stakingAction.penalty` (nullable).
- `Restaked` handler stores `positionAmount` on `restakingPosition`
  (nullable column added to schema).
- All inserts call `.onConflictDoNothing()` keyed on `event.log.id`,
  making reorg replays idempotent.

`ponder.schema.ts` additions:
- `pairEvent` (swap/mint/burn discriminator)
- `pauseState` + `pauseEvent`
- `gauge` + `gaugeEvent` + `gaugeVoteCommit` + `gaugeVoteRevealed`
- `voteIncentivesCommit` + `voteIncentivesEpoch` + `voteIncentivesRefund`
- `restakingAdminAction`
- `timelockProposal`
- `proposal.cancelled` boolean (for grant-lifecycle ProposalCancelled)

## Per-contract `startBlock`

Replaced shared `24500000` floor with deploy-block constants pulled from
`contracts/broadcast/*/1/run-latest.json`. Each value is named
(`TEGRIDY_STAKING_START`, etc.) and cited inline.

| Contract | Block | Source |
|---|---|---|
| TegridyStaking | 24808994 | DeployAuditFixes (C-01 fix redeploy) |
| TegridyRestaking | 24816809 | DeployV2 |
| RevenueDistributor | 24816810 | DeployV2 |
| VoteIncentives | 24816808 | DeployV2 |
| LPFarming | 24910270 | Wave 0 LPF redeploy |
| TegridyLending | 24875534 | DeployV3Features |
| SwapFeeRouter | 24816811 | DeployV2 |
| CommunityGrants | 24816812 | DeployV2 |
| MemeBountyBoard | 24816814 | DeployV2 |
| GaugeController | 24910192 | DeployGaugeController |
| PremiumAccess | 24816815 | DeployV2 |
| POLAccumulator | 24808997 | DeployAuditFixes |
| TegridyNFTLending | 24910182 | DeployNFTLending |
| TegridyFactory (pair child) | 24500000 | legacy — kept conservative |

## Verification

`cd indexer && npx tsc --noEmit`:
- 34 total errors, all pre-existing vendor noise in
  `node_modules/{drizzle-orm, @electric-sql/pglite, pg, ponder}`.
- **0 user-code errors** in `ponder.config.ts`, `ponder.schema.ts`,
  `src/index.ts`.
- The single `ponder-env.d.ts(12,3) TS2439` is the same pre-existing
  auto-generated-file error called out in R005's verification table.

## Files touched

- `indexer/ponder.config.ts` — networks/contracts rewrite, factory
  subscription, GaugeController + 3 pause-only filters, deploy-block
  constants.
- `indexer/ponder.schema.ts` — 11 new tables + nullable columns.
- `indexer/src/index.ts` — schema fixes (EarlyWithdrawn/Restaked),
  idempotent inserts, GaugeController + Pair + Pausable handlers,
  TimelockAdmin lifecycle handlers.

## Notes for the next deploy

- Schema additions are nullable / additive only — no migration of
  existing rows needed.
- TegridyFactory's address (`0x8B786163aA3beb97822d480a0c306DfD6dEbdCB6`)
  was never in the indexer before; first sync will scan from block
  24500000. Tightening this to the actual factory deploy block is a
  follow-up once ops verify the broadcast file.
- If `UnvotedBribeRefunded` or `GaugeFrozen` events ever ship in source,
  add the ABI entries + handlers — currently they're spec-only.
