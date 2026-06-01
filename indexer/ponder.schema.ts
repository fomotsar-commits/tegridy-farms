import { onchainTable, index } from "ponder";

// ─── Staking ─────────────────────────────────────────────────────────────────

export const stakingPosition = onchainTable(
  "staking_position",
  (t) => ({
    tokenId: t.bigint().primaryKey(),
    user: t.hex().notNull(),
    amount: t.bigint().notNull(),
    lockDuration: t.bigint().notNull(),
    lockEnd: t.bigint().notNull(),
    boostBps: t.bigint().notNull(),
    createdAt: t.bigint().notNull(),
    updatedAt: t.bigint().notNull(),
  }),
  (table) => ({
    userIdx: index().on(table.user),
  }),
);

// AUDIT R054: nullable `penalty` column added so `EarlyWithdrawn` rows
// preserve the slashing penalty actually charged. Non-early-withdraw
// actions stay `null` (additive migration — no existing rows touched).
export const stakingAction = onchainTable(
  "staking_action",
  (t) => ({
    id: t.text().primaryKey(),
    user: t.hex().notNull(),
    tokenId: t.bigint().notNull(),
    type: t.text().notNull(), // stake | withdraw | earlyWithdraw | claim | extend | increase
    amount: t.bigint().notNull(),
    penalty: t.bigint(), // nullable — only set for earlyWithdraw rows
    timestamp: t.bigint().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({
    userIdx: index().on(table.user),
    tokenIdx: index().on(table.tokenId),
  }),
);

// ─── Restaking ───────────────────────────────────────────────────────────────

// AUDIT M5 (2026-05-24): restakingPosition / restakingAdminAction (and
// restakingClaim, defined further below) removed — TegridyRestaking is
// DEFERRED to Phase 7 and out of the MVP set. No kept handler references
// these tables.

// ─── Revenue Distribution ────────────────────────────────────────────────────

export const revenueEpoch = onchainTable("revenue_epoch", (t) => ({
  epochId: t.bigint().primaryKey(),
  ethAmount: t.bigint().notNull(),
  totalLocked: t.bigint().notNull(),
  timestamp: t.bigint().notNull(),
}));

export const revenueClaim = onchainTable(
  "revenue_claim",
  (t) => ({
    id: t.text().primaryKey(),
    user: t.hex().notNull(),
    ethAmount: t.bigint().notNull(),
    fromEpoch: t.bigint().notNull(),
    toEpoch: t.bigint().notNull(),
    timestamp: t.bigint().notNull(),
  }),
  (table) => ({
    userIdx: index().on(table.user),
  }),
);

// ─── Vote Incentives ─────────────────────────────────────────────────────────

// AUDIT M5 (2026-05-24): all VoteIncentives tables removed (non-MVP):
// gaugeVote, bribeDeposit, bribeClaim, voteIncentivesCommit,
// voteIncentivesEpoch, voteIncentivesRefund, voteIncentivesMinBribeChange.
// Also removed from this section: proposalVote (CommunityGrants — non-MVP)
// and restakingClaim (TegridyRestaking — DEFERRED to Phase 7). None of these
// are referenced by any kept handler.

// ─── Swaps ───────────────────────────────────────────────────────────────────

export const swap = onchainTable(
  "swap",
  (t) => ({
    id: t.text().primaryKey(),
    user: t.hex().notNull(),
    tokenIn: t.hex().notNull(),
    tokenOut: t.hex().notNull(),
    amountIn: t.bigint().notNull(),
    fee: t.bigint().notNull(),
    timestamp: t.bigint().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({
    userIdx: index().on(table.user),
  }),
);

// AUDIT R054 (Agent 084 IDX-H2): TegridyPair Swap/Mint/Burn discriminated
// by `type`. amount0In/Out only populated for swaps; mint/burn rows use
// amount0/amount1 with In=0n. Lets one table back the per-pool history,
// volume, and TVL queries the frontend currently can't render.
export const pairEvent = onchainTable(
  "pair_event",
  (t) => ({
    id: t.text().primaryKey(),
    type: t.text().notNull(), // swap | mint | burn
    pair: t.hex().notNull(),
    sender: t.hex().notNull(),
    to: t.hex(),
    amount0: t.bigint().notNull(),
    amount1: t.bigint().notNull(),
    amount0In: t.bigint(),
    amount1In: t.bigint(),
    amount0Out: t.bigint(),
    amount1Out: t.bigint(),
    timestamp: t.bigint().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({
    pairIdx: index().on(table.pair),
    typeIdx: index().on(table.type),
    timeIdx: index().on(table.timestamp),
  }),
);

// AUDIT M4 (2026-05-24): pair-event poisoning allowlist cache.
// TegridyPair is subscribed via the factory(TegridyFactory.PairCreated)
// pattern, so the indexer auto-tracks EVERY pair the factory creates. If pair
// creation is permissionless, an attacker can spin up junk pairs to poison the
// indexed Swap/Mint/Burn data. We only index pairs whose token0 or token1 is a
// canonical protocol token (TOWELI/WETH). This table caches the one-time
// token0()/token1() lookup per pair plus the allow/deny verdict so we do at
// most one RPC round-trip per pair (not per event). See src/index.ts.
export const indexedPair = onchainTable(
  "indexed_pair",
  (t) => ({
    id: t.hex().primaryKey(), // pair address (lowercased)
    token0: t.hex().notNull(),
    token1: t.hex().notNull(),
    allowed: t.boolean().notNull(),
  }),
);

// AUDIT M5 (2026-05-24): the following sections were removed as non-MVP, with
// no kept handler referencing any of these tables:
//   LP Farming      → lpFarmAction
//   Lending         → loanOffer, loan
//   Community Grants → proposal
//   Meme Bounty Board → bounty
//   Gauge Controller → gauge, gaugeEvent, gaugeVoteCommit, gaugeVoteRevealed

// ─── Pause State (R054 / Agent 084 IDX-H4) ───────────────────────────────────

// Current pause state for fast UI lookup.
export const pauseState = onchainTable(
  "pause_state",
  (t) => ({
    contract: t.text().primaryKey(), // logical contract name e.g. "TegridyStaking"
    paused: t.boolean().notNull(),
    updatedAt: t.bigint().notNull(),
  }),
);

// Immutable audit trail of every pause/unpause event.
export const pauseEvent = onchainTable(
  "pause_event",
  (t) => ({
    id: t.text().primaryKey(),
    contract: t.text().notNull(),
    type: t.text().notNull(), // paused | unpaused
    account: t.hex().notNull(),
    timestamp: t.bigint().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({
    contractIdx: index().on(table.contract),
  }),
);

// ─── TimelockAdmin (R010 / R054) ─────────────────────────────────────────────

// Audit trail of every TimelockAdmin proposal lifecycle event across the
// 4 contracts that inherit it (Staking/Lending/CommunityGrants — extras
// fold here too if/when subscribed). Discriminated by `contract` + `key`.
export const timelockProposal = onchainTable(
  "timelock_proposal",
  (t) => ({
    id: t.text().primaryKey(), // `${contract}:${key}:${type}:${logId}`
    contract: t.text().notNull(),
    key: t.hex().notNull(),
    type: t.text().notNull(), // created | executed | cancelled
    executeAfter: t.bigint(),
    expiresAt: t.bigint(),
    timestamp: t.bigint().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({
    contractIdx: index().on(table.contract),
    keyIdx: index().on(table.key),
  }),
);

// ─── Factory governance (post-Batch-J sweep) ─────────────────────────────────

// AUDIT (Batch A, commit 393b084): TegridyFactory.setGuardian initial-set +
// the propose/execute/cancel triplet for guardian rotation. Plus the
// emergencyDisablePair circuit-breaker fires.
export const factoryGuardianEvent = onchainTable(
  "factory_guardian_event",
  (t) => ({
    id: t.text().primaryKey(),
    type: t.text().notNull(), // "set" | "proposed" | "executed" | "cancelled"
    oldGuardian: t.hex(),
    newGuardian: t.hex(),
    executeAfter: t.bigint(),
    timestamp: t.bigint().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({
    typeIdx: index().on(table.type),
  }),
);

export const factoryEmergencyDisable = onchainTable(
  "factory_emergency_disable",
  (t) => ({
    id: t.text().primaryKey(),
    pair: t.hex().notNull(),
    by: t.hex().notNull(),
    timestamp: t.bigint().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({
    pairIdx: index().on(table.pair),
  }),
);

// ─── TWAP rebootstrap (post-Batch-J sweep) ───────────────────────────────────

// AUDIT M-2 (Batch J, commit 5fad774): TegridyTWAP DeviationBypassed.
// Lending integrators can query "was this pair rebootstrapped recently?" to
// require a confirming observation before trusting the new baseline.
export const twapRebootstrap = onchainTable(
  "twap_rebootstrap",
  (t) => ({
    id: t.text().primaryKey(),
    pair: t.hex().notNull(),
    elapsed: t.bigint().notNull(),
    spotPrice0: t.bigint().notNull(),
    spotPrice1: t.bigint().notNull(),
    timestamp: t.bigint().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({
    pairIdx: index().on(table.pair),
  }),
);
