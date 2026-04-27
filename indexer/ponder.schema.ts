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

// AUDIT R054 (Agent 084 IDX-M1): nullable `positionAmount` column so
// `Restaked` rows persist the restake size for emergency reconciliation
// (Agent 039 H-EVT-03). Field is nullable to keep migration painless.
export const restakingPosition = onchainTable(
  "restaking_position",
  (t) => ({
    tokenId: t.bigint().primaryKey(),
    user: t.hex().notNull(),
    depositTime: t.bigint().notNull(),
    positionAmount: t.bigint(), // nullable — null until first Restaked row writes it
  }),
  (table) => ({
    userIdx: index().on(table.user),
  }),
);

// AUDIT R054 (Agent 084 finding): per agent 084, `PositionRefreshed`,
// `BoostRevalidated`, `EmergencyForceReturn` were silent. New table
// unifies all three via a `type` discriminator so the dashboard can
// render the admin-action timeline.
export const restakingAdminAction = onchainTable(
  "restaking_admin_action",
  (t) => ({
    id: t.text().primaryKey(),
    type: t.text().notNull(), // positionRefreshed | boostRevalidated | emergencyForceReturn
    restaker: t.hex().notNull(),
    tokenId: t.bigint().notNull(),
    oldValue: t.bigint(),
    newValue: t.bigint(),
    nftReturned: t.boolean(),
    timestamp: t.bigint().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({
    restakerIdx: index().on(table.restaker),
    tokenIdx: index().on(table.tokenId),
    typeIdx: index().on(table.type),
  }),
);

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

export const gaugeVote = onchainTable(
  "gauge_vote",
  (t) => ({
    id: t.text().primaryKey(),
    user: t.hex().notNull(),
    epoch: t.bigint().notNull(),
    pair: t.hex().notNull(),
    power: t.bigint().notNull(),
    timestamp: t.bigint().notNull(),
  }),
  (table) => ({
    userIdx: index().on(table.user),
    epochIdx: index().on(table.epoch),
  }),
);

// AUDIT R054: includes the ETH-bribe path. `token` is null when the
// underlying deposit was native ETH (BribeDepositedETH).
export const bribeDeposit = onchainTable(
  "bribe_deposit",
  (t) => ({
    id: t.text().primaryKey(),
    epoch: t.bigint().notNull(),
    pair: t.hex().notNull(),
    token: t.hex(), // nullable — null for ETH bribes
    depositor: t.hex().notNull(),
    amount: t.bigint().notNull(),
    fee: t.bigint(),
    timestamp: t.bigint().notNull(),
  }),
  (table) => ({
    epochIdx: index().on(table.epoch),
    pairIdx: index().on(table.pair),
    depositorIdx: index().on(table.depositor),
  }),
);

// AUDIT INDEXER-M2: bribe claim tracking so frontend can reconcile per-user
// claim history, not just deposit flow.
export const bribeClaim = onchainTable(
  "bribe_claim",
  (t) => ({
    id: t.text().primaryKey(),
    user: t.hex().notNull(),
    epoch: t.bigint().notNull(),
    pair: t.hex().notNull(),
    token: t.hex().notNull(),
    amount: t.bigint().notNull(),
    timestamp: t.bigint().notNull(),
  }),
  (table) => ({
    userIdx: index().on(table.user),
    epochIdx: index().on(table.epoch),
  }),
);

// AUDIT R054 (R020/R021): VoteIncentives commit-reveal vote history.
// `pair`/`power` are populated only on reveal; commit rows have them null.
export const voteIncentivesCommit = onchainTable(
  "vote_incentives_commit",
  (t) => ({
    id: t.text().primaryKey(),
    user: t.hex().notNull(),
    epoch: t.bigint().notNull(),
    commitIndex: t.bigint().notNull(),
    commitHash: t.hex(),
    revealedAt: t.bigint(),
    revealedPair: t.hex(),
    revealedPower: t.bigint(),
    timestamp: t.bigint().notNull(),
  }),
  (table) => ({
    userIdx: index().on(table.user),
    epochIdx: index().on(table.epoch),
  }),
);

// AUDIT R054: VoteIncentives epoch boundary events.
export const voteIncentivesEpoch = onchainTable("vote_incentives_epoch", (t) => ({
  epochId: t.bigint().primaryKey(),
  totalPower: t.bigint().notNull(),
  timestamp: t.bigint().notNull(),
}));

// AUDIT R054 (NEW-G2): refund table. Originally only `orphaned` was emitted
// by the contract; Batch B (commit 1b7ad2f) added `unvoted` for snapshotted
// zero-vote epochs. The `type` discriminator covers both.
export const voteIncentivesRefund = onchainTable(
  "vote_incentives_refund",
  (t) => ({
    id: t.text().primaryKey(),
    type: t.text().notNull(), // "orphaned" | "unvoted"
    epoch: t.bigint().notNull(),
    pair: t.hex().notNull(),
    token: t.hex().notNull(),
    depositor: t.hex().notNull(),
    amount: t.bigint().notNull(),
    timestamp: t.bigint().notNull(),
  }),
  (table) => ({
    depositorIdx: index().on(table.depositor),
    epochIdx: index().on(table.epoch),
  }),
);

// AUDIT R020 H-3 (Batch B, commit 1b7ad2f): per-token min-bribe governance
// lifecycle. Records propose/execute/cancel events so the frontend timelock
// UI can show the active queue and history without re-scanning logs.
export const voteIncentivesMinBribeChange = onchainTable(
  "vote_incentives_min_bribe_change",
  (t) => ({
    id: t.text().primaryKey(),
    action: t.text().notNull(), // "proposed" | "executed" | "cancelled"
    token: t.hex().notNull(),
    amount: t.bigint().notNull(),
    previousAmount: t.bigint(), // only set on "executed"
    executeAfter: t.bigint().notNull(),
    timestamp: t.bigint().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({
    tokenIdx: index().on(table.token),
    actionIdx: index().on(table.action),
  }),
);

// AUDIT INDEXER-M2: proposal vote tracking so governance UI can show per-user
// voting patterns, not just final proposal outcomes.
export const proposalVote = onchainTable(
  "proposal_vote",
  (t) => ({
    id: t.text().primaryKey(),
    proposalId: t.bigint().notNull(),
    voter: t.hex().notNull(),
    support: t.boolean().notNull(),
    power: t.bigint().notNull(),
    timestamp: t.bigint().notNull(),
  }),
  (table) => ({
    proposalIdx: index().on(table.proposalId),
    voterIdx: index().on(table.voter),
  }),
);

// AUDIT INDEXER-M2: restaking claim tracking — base + bonus reward streams
// need per-user records for the dashboard to show total claimed.
export const restakingClaim = onchainTable(
  "restaking_claim",
  (t) => ({
    id: t.text().primaryKey(),
    user: t.hex().notNull(),
    type: t.text().notNull(), // "base" | "bonus"
    amount: t.bigint().notNull(),
    timestamp: t.bigint().notNull(),
  }),
  (table) => ({
    userIdx: index().on(table.user),
  }),
);

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

// ─── LP Farming ──────────────────────────────────────────────────────────────

export const lpFarmAction = onchainTable(
  "lp_farm_action",
  (t) => ({
    id: t.text().primaryKey(),
    user: t.hex().notNull(),
    type: t.text().notNull(), // stake | withdraw | claim
    amount: t.bigint().notNull(),
    timestamp: t.bigint().notNull(),
  }),
  (table) => ({
    userIdx: index().on(table.user),
  }),
);

// ─── Lending ─────────────────────────────────────────────────────────────────

export const loanOffer = onchainTable(
  "loan_offer",
  (t) => ({
    offerId: t.bigint().primaryKey(),
    lender: t.hex().notNull(),
    principal: t.bigint().notNull(),
    aprBps: t.bigint().notNull(),
    duration: t.bigint().notNull(),
  }),
  (table) => ({
    lenderIdx: index().on(table.lender),
  }),
);

export const loan = onchainTable(
  "loan",
  (t) => ({
    loanId: t.bigint().primaryKey(),
    offerId: t.bigint().notNull(),
    borrower: t.hex().notNull(),
    lender: t.hex().notNull(),
    tokenId: t.bigint().notNull(),
    principal: t.bigint().notNull(),
    deadline: t.bigint().notNull(),
    repaid: t.boolean().notNull(),
    defaulted: t.boolean().notNull(),
  }),
  (table) => ({
    borrowerIdx: index().on(table.borrower),
    lenderIdx: index().on(table.lender),
  }),
);

// ─── Community Grants ────────────────────────────────────────────────────────

export const proposal = onchainTable("proposal", (t) => ({
  id: t.bigint().primaryKey(),
  proposer: t.hex().notNull(),
  recipient: t.hex().notNull(),
  amount: t.bigint().notNull(),
  description: t.text().notNull(),
  executed: t.boolean().notNull(),
  cancelled: t.boolean().notNull().default(false),
}));

// ─── Meme Bounty Board ──────────────────────────────────────────────────────

export const bounty = onchainTable("bounty", (t) => ({
  id: t.bigint().primaryKey(),
  creator: t.hex().notNull(),
  reward: t.bigint().notNull(),
  description: t.text().notNull(),
  completed: t.boolean().notNull(),
  winner: t.hex(),
}));

// ─── Gauge Controller (R054 / Agent 084 IDX-H1) ──────────────────────────────

// Lifecycle state for each gauge (current).
export const gauge = onchainTable(
  "gauge",
  (t) => ({
    address: t.hex().primaryKey(),
    status: t.text().notNull(), // proposedAdd | active | proposedRemove | removed
    proposedAt: t.bigint(),
    addedAt: t.bigint(),
    removeProposedAt: t.bigint(),
    removedAt: t.bigint(),
    updatedAt: t.bigint().notNull(),
  }),
  (table) => ({
    statusIdx: index().on(table.status),
  }),
);

// Audit trail of every gauge lifecycle event for forensic queries.
export const gaugeEvent = onchainTable(
  "gauge_event",
  (t) => ({
    id: t.text().primaryKey(),
    type: t.text().notNull(), // proposed | added | removeProposed | removed | budgetProposed | budgetUpdated
    gauge: t.hex(),
    valueA: t.bigint(),
    valueB: t.bigint(),
    timestamp: t.bigint().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({
    typeIdx: index().on(table.type),
    gaugeIdx: index().on(table.gauge),
  }),
);

// GaugeController commit-reveal vote tracking.
// `gauges`/`weights` are stored as JSON-encoded strings for pglite
// portability (pglite arrays of decoded bigints don't round-trip cleanly).
export const gaugeVoteCommit = onchainTable(
  "gauge_vote_commit",
  (t) => ({
    id: t.text().primaryKey(),
    voter: t.hex().notNull(),
    tokenId: t.bigint().notNull(),
    epoch: t.bigint().notNull(),
    commitmentHash: t.hex().notNull(),
    timestamp: t.bigint().notNull(),
  }),
  (table) => ({
    voterIdx: index().on(table.voter),
    epochIdx: index().on(table.epoch),
  }),
);

export const gaugeVoteRevealed = onchainTable(
  "gauge_vote_revealed",
  (t) => ({
    id: t.text().primaryKey(),
    voter: t.hex().notNull(),
    tokenId: t.bigint().notNull(),
    epoch: t.bigint().notNull(),
    gauges: t.text().notNull(), // JSON: address[]
    weights: t.text().notNull(), // JSON: string[] (bigints)
    timestamp: t.bigint().notNull(),
  }),
  (table) => ({
    voterIdx: index().on(table.voter),
    epochIdx: index().on(table.epoch),
  }),
);

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
