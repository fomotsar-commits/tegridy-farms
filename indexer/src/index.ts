import { ponder } from "ponder:registry";
import {
  stakingPosition,
  stakingAction,
  restakingPosition,
  restakingClaim,
  revenueEpoch,
  revenueClaim,
  gaugeVote,
  bribeDeposit,
  bribeClaim,
  swap,
  lpFarmAction,
  loanOffer,
  loan,
  proposal,
  proposalVote,
  bounty,
} from "ponder:schema";

// ─── TegridyStaking ──────────────────────────────────────────────────────────

ponder.on("TegridyStaking:Staked", async ({ event, context }) => {
  const { user, tokenId, amount, lockDuration, boostBps } = event.args;
  const ts = event.block.timestamp;

  await context.db.insert(stakingPosition).values({
    tokenId,
    user,
    amount,
    lockDuration,
    lockEnd: ts + lockDuration,
    boostBps,
    createdAt: ts,
    updatedAt: ts,
  });

  await context.db.insert(stakingAction).values({
    id: event.log.id,
    user,
    tokenId,
    type: "stake",
    amount,
    timestamp: ts,
    txHash: event.transaction.hash,
  });
});

ponder.on("TegridyStaking:Withdrawn", async ({ event, context }) => {
  const { user, tokenId, amount } = event.args;
  const ts = event.block.timestamp;

  await context.db
    .insert(stakingPosition)
    .values({
      tokenId,
      user,
      amount: 0n,
      lockDuration: 0n,
      lockEnd: 0n,
      boostBps: 0n,
      createdAt: ts,
      updatedAt: ts,
    })
    .onConflictDoUpdate({
      amount: 0n,
      updatedAt: ts,
    });

  await context.db.insert(stakingAction).values({
    id: event.log.id,
    user,
    tokenId,
    type: "withdraw",
    amount,
    timestamp: ts,
    txHash: event.transaction.hash,
  });
});

ponder.on("TegridyStaking:EarlyWithdrawn", async ({ event, context }) => {
  const { user, tokenId, amount } = event.args;
  const ts = event.block.timestamp;

  await context.db
    .insert(stakingPosition)
    .values({
      tokenId,
      user,
      amount: 0n,
      lockDuration: 0n,
      lockEnd: 0n,
      boostBps: 0n,
      createdAt: ts,
      updatedAt: ts,
    })
    .onConflictDoUpdate({
      amount: 0n,
      updatedAt: ts,
    });

  await context.db.insert(stakingAction).values({
    id: event.log.id,
    user,
    tokenId,
    type: "earlyWithdraw",
    amount,
    timestamp: ts,
    txHash: event.transaction.hash,
  });
});

ponder.on("TegridyStaking:RewardPaid", async ({ event, context }) => {
  const { user, tokenId, reward } = event.args;
  const ts = event.block.timestamp;

  await context.db.insert(stakingAction).values({
    id: event.log.id,
    user,
    tokenId,
    type: "claim",
    amount: reward,
    timestamp: ts,
    txHash: event.transaction.hash,
  });
});

// AUDIT INDEXER-H1: LockExtended / AmountIncreased only fire on positions
// that already exist (you can't extend a lock on a position that isn't there),
// so the prior "upsert with user=0x0" path was dead-insert code that would
// have polluted user-scoped queries if it ever actually ran. Use .update()
// directly on the existing row, and look up `user` from it for the action log.
ponder.on("TegridyStaking:LockExtended", async ({ event, context }) => {
  const { tokenId, newLockDuration, newLockEnd } = event.args;
  const ts = event.block.timestamp;

  const pos = await context.db.find(stakingPosition, { tokenId });
  if (!pos) return; // position must exist — otherwise the chain is inconsistent

  await context.db
    .update(stakingPosition, { tokenId })
    .set({
      lockDuration: newLockDuration,
      lockEnd: newLockEnd,
      updatedAt: ts,
    });

  await context.db.insert(stakingAction).values({
    id: event.log.id,
    user: pos.user,
    tokenId,
    type: "extend",
    amount: 0n,
    timestamp: ts,
    txHash: event.transaction.hash,
  });
});

ponder.on("TegridyStaking:AmountIncreased", async ({ event, context }) => {
  const { tokenId, addedAmount, newTotal } = event.args;
  const ts = event.block.timestamp;

  const pos = await context.db.find(stakingPosition, { tokenId });
  if (!pos) return;

  await context.db
    .update(stakingPosition, { tokenId })
    .set({
      amount: newTotal,
      updatedAt: ts,
    });

  await context.db.insert(stakingAction).values({
    id: event.log.id,
    user: pos.user,
    tokenId,
    type: "increase",
    amount: addedAmount,
    timestamp: ts,
    txHash: event.transaction.hash,
  });
});

// ─── TegridyRestaking ────────────────────────────────────────────────────────

ponder.on("TegridyRestaking:Restaked", async ({ event, context }) => {
  const { user, tokenId } = event.args;
  const ts = event.block.timestamp;

  await context.db
    .insert(restakingPosition)
    .values({
      tokenId,
      user,
      depositTime: ts,
    })
    .onConflictDoUpdate({
      user,
      depositTime: ts,
    });
});

ponder.on("TegridyRestaking:Unrestaked", async ({ event, context }) => {
  const { user, tokenId } = event.args;

  await context.db
    .insert(restakingPosition)
    .values({
      tokenId,
      user,
      depositTime: 0n,
    })
    .onConflictDoUpdate({
      depositTime: 0n,
    });
});

// AUDIT INDEXER-M2: track base + bonus restaking claims in restakingClaim.
ponder.on("TegridyRestaking:BonusClaimed", async ({ event, context }) => {
  const { user, bonusAmount } = event.args;
  await context.db.insert(restakingClaim).values({
    id: event.log.id,
    user,
    type: "bonus",
    amount: bonusAmount,
    timestamp: event.block.timestamp,
  });
});

ponder.on("TegridyRestaking:BaseClaimed", async ({ event, context }) => {
  const { user, baseAmount } = event.args;
  await context.db.insert(restakingClaim).values({
    id: event.log.id,
    user,
    type: "base",
    amount: baseAmount,
    timestamp: event.block.timestamp,
  });
});

// ─── RevenueDistributor ──────────────────────────────────────────────────────

ponder.on("RevenueDistributor:EpochDistributed", async ({ event, context }) => {
  const { epochId, ethAmount, totalLocked } = event.args;
  const ts = event.block.timestamp;

  await context.db.insert(revenueEpoch).values({
    epochId,
    ethAmount,
    totalLocked,
    timestamp: ts,
  });
});

ponder.on("RevenueDistributor:Claimed", async ({ event, context }) => {
  const { user, ethAmount, fromEpoch, toEpoch } = event.args;
  const ts = event.block.timestamp;

  await context.db.insert(revenueClaim).values({
    id: event.log.id,
    user,
    ethAmount,
    fromEpoch,
    toEpoch,
    timestamp: ts,
  });
});

// ─── VoteIncentives ──────────────────────────────────────────────────────────

ponder.on("VoteIncentives:GaugeVoted", async ({ event, context }) => {
  const { user, epoch, pair, power } = event.args;
  const ts = event.block.timestamp;

  await context.db.insert(gaugeVote).values({
    id: event.log.id,
    user,
    epoch,
    pair,
    power,
    timestamp: ts,
  });
});

ponder.on("VoteIncentives:BribeDeposited", async ({ event, context }) => {
  const { epoch, pair, token, depositor, amount } = event.args;
  const ts = event.block.timestamp;

  await context.db.insert(bribeDeposit).values({
    id: event.log.id,
    epoch,
    pair,
    token,
    depositor,
    amount,
    timestamp: ts,
  });
});

// AUDIT INDEXER-M2: track bribe claims in bribeClaim so per-user claim history
// is reconstructible alongside the existing bribeDeposit deposit flow.
ponder.on("VoteIncentives:BribeClaimed", async ({ event, context }) => {
  const { user, epoch, pair, token, amount } = event.args;
  await context.db.insert(bribeClaim).values({
    id: event.log.id,
    user,
    epoch,
    pair,
    token,
    amount,
    timestamp: event.block.timestamp,
  });
});

// ─── SwapFeeRouter ───────────────────────────────────────────────────────────

ponder.on("SwapFeeRouter:SwapExecuted", async ({ event, context }) => {
  const { user, tokenIn, tokenOut, amountIn, fee } = event.args;
  const ts = event.block.timestamp;

  await context.db.insert(swap).values({
    id: event.log.id,
    user,
    tokenIn,
    tokenOut,
    amountIn,
    fee,
    timestamp: ts,
    txHash: event.transaction.hash,
  });
});

// ─── LPFarming ───────────────────────────────────────────────────────────────

ponder.on("LPFarming:Staked", async ({ event, context }) => {
  const { user, amount } = event.args;
  const ts = event.block.timestamp;

  await context.db.insert(lpFarmAction).values({
    id: event.log.id,
    user,
    type: "stake",
    amount,
    timestamp: ts,
  });
});

ponder.on("LPFarming:Withdrawn", async ({ event, context }) => {
  const { user, amount } = event.args;
  const ts = event.block.timestamp;

  await context.db.insert(lpFarmAction).values({
    id: event.log.id,
    user,
    type: "withdraw",
    amount,
    timestamp: ts,
  });
});

ponder.on("LPFarming:RewardPaid", async ({ event, context }) => {
  const { user, reward } = event.args;
  const ts = event.block.timestamp;

  await context.db.insert(lpFarmAction).values({
    id: event.log.id,
    user,
    type: "claim",
    amount: reward,
    timestamp: ts,
  });
});

// ─── TegridyLending ──────────────────────────────────────────────────────────

ponder.on("TegridyLending:LoanOfferCreated", async ({ event, context }) => {
  const { offerId, lender, principal, aprBps, duration } = event.args;

  await context.db.insert(loanOffer).values({
    offerId,
    lender,
    principal,
    aprBps,
    duration,
  });
});

ponder.on("TegridyLending:LoanAccepted", async ({ event, context }) => {
  const { loanId, offerId, borrower, lender, tokenId, principal, deadline } =
    event.args;

  await context.db.insert(loan).values({
    loanId,
    offerId,
    borrower,
    lender,
    tokenId,
    principal,
    deadline,
    repaid: false,
    defaulted: false,
  });
});

// AUDIT INDEXER-H1: LoanRepaid / DefaultClaimed fire on existing loans; use
// update() and bail if the loan row is missing (chain inconsistency).
ponder.on("TegridyLending:LoanRepaid", async ({ event, context }) => {
  const { loanId } = event.args;
  const existing = await context.db.find(loan, { loanId });
  if (!existing) return;
  await context.db.update(loan, { loanId }).set({ repaid: true });
});

ponder.on("TegridyLending:DefaultClaimed", async ({ event, context }) => {
  const { loanId } = event.args;
  const existing = await context.db.find(loan, { loanId });
  if (!existing) return;
  await context.db.update(loan, { loanId }).set({ defaulted: true });
});

// ─── CommunityGrants ─────────────────────────────────────────────────────────

ponder.on("CommunityGrants:ProposalCreated", async ({ event, context }) => {
  const { id, proposer, recipient, amount, description } = event.args;

  await context.db.insert(proposal).values({
    id,
    proposer,
    recipient,
    amount,
    description,
    executed: false,
  });
});

// AUDIT INDEXER-H1: ProposalExecuted fires on an existing proposal; use update().
ponder.on("CommunityGrants:ProposalExecuted", async ({ event, context }) => {
  const { id } = event.args;
  const existing = await context.db.find(proposal, { id });
  if (!existing) return;
  await context.db.update(proposal, { id }).set({ executed: true });
});

// AUDIT INDEXER-M2: track per-user proposal votes so governance UI can show
// who voted which way and by how much power.
ponder.on("CommunityGrants:ProposalVoted", async ({ event, context }) => {
  const { id, voter, support, power } = event.args;
  await context.db.insert(proposalVote).values({
    id: event.log.id,
    proposalId: id,
    voter,
    support,
    power,
    timestamp: event.block.timestamp,
  });
});

// ─── MemeBountyBoard ─────────────────────────────────────────────────────────

ponder.on("MemeBountyBoard:BountyCreated", async ({ event, context }) => {
  const { id, creator, reward, description } = event.args;

  await context.db.insert(bounty).values({
    id,
    creator,
    reward,
    description,
    completed: false,
    winner: null,
  });
});

// AUDIT INDEXER-H1: BountyCompleted fires on an existing bounty; use update().
ponder.on("MemeBountyBoard:BountyCompleted", async ({ event, context }) => {
  const { bountyId, winner } = event.args;
  const existing = await context.db.find(bounty, { id: bountyId });
  if (!existing) return;
  await context.db.update(bounty, { id: bountyId }).set({ completed: true, winner });
});
