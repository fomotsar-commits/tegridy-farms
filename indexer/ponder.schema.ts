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

export const stakingAction = onchainTable(
  "staking_action",
  (t) => ({
    id: t.text().primaryKey(),
    user: t.hex().notNull(),
    tokenId: t.bigint().notNull(),
    type: t.text().notNull(), // stake | withdraw | earlyWithdraw | claim | extend | increase
    amount: t.bigint().notNull(),
    timestamp: t.bigint().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({
    userIdx: index().on(table.user),
    tokenIdx: index().on(table.tokenId),
  }),
);

// ─── Restaking ───────────────────────────────────────────────────────────────

export const restakingPosition = onchainTable(
  "restaking_position",
  (t) => ({
    tokenId: t.bigint().primaryKey(),
    user: t.hex().notNull(),
    depositTime: t.bigint().notNull(),
  }),
  (table) => ({
    userIdx: index().on(table.user),
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

export const bribeDeposit = onchainTable(
  "bribe_deposit",
  (t) => ({
    id: t.text().primaryKey(),
    epoch: t.bigint().notNull(),
    pair: t.hex().notNull(),
    token: t.hex().notNull(),
    depositor: t.hex().notNull(),
    amount: t.bigint().notNull(),
    timestamp: t.bigint().notNull(),
  }),
  (table) => ({
    epochIdx: index().on(table.epoch),
    pairIdx: index().on(table.pair),
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
