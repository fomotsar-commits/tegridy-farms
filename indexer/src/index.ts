import { ponder } from "ponder:registry";
import {
  stakingPosition,
  stakingAction,
  restakingPosition,
  revenueEpoch,
  revenueClaim,
  gaugeVote,
  bribeDeposit,
  swap,
  lpFarmAction,
  loanOffer,
  loan,
  proposal,
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

ponder.on("TegridyStaking:LockExtended", async ({ event, context }) => {
  const { tokenId, newLockDuration, newLockEnd } = event.args;
  const ts = event.block.timestamp;

  await context.db
    .insert(stakingPosition)
    .values({
      tokenId,
      user: "0x0000000000000000000000000000000000000000",
      amount: 0n,
      lockDuration: newLockDuration,
      lockEnd: newLockEnd,
      boostBps: 0n,
      createdAt: ts,
      updatedAt: ts,
    })
    .onConflictDoUpdate({
      lockDuration: newLockDuration,
      lockEnd: newLockEnd,
      updatedAt: ts,
    });

  await context.db.insert(stakingAction).values({
    id: event.log.id,
    user: "0x0000000000000000000000000000000000000000",
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

  await context.db
    .insert(stakingPosition)
    .values({
      tokenId,
      user: "0x0000000000000000000000000000000000000000",
      amount: newTotal,
      lockDuration: 0n,
      lockEnd: 0n,
      boostBps: 0n,
      createdAt: ts,
      updatedAt: ts,
    })
    .onConflictDoUpdate({
      amount: newTotal,
      updatedAt: ts,
    });

  await context.db.insert(stakingAction).values({
    id: event.log.id,
    user: "0x0000000000000000000000000000000000000000",
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

// BonusClaimed and BaseClaimed are claim-only events (no position mutation needed).
// We skip them since there's no dedicated claims table for restaking.

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

// BribeClaimed -- skip for now (no dedicated claims table; could be added later)

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

ponder.on("TegridyLending:LoanRepaid", async ({ event, context }) => {
  const { loanId } = event.args;

  await context.db
    .insert(loan)
    .values({
      loanId,
      offerId: 0n,
      borrower: "0x0000000000000000000000000000000000000000",
      lender: "0x0000000000000000000000000000000000000000",
      tokenId: 0n,
      principal: 0n,
      deadline: 0n,
      repaid: true,
      defaulted: false,
    })
    .onConflictDoUpdate({
      repaid: true,
    });
});

ponder.on("TegridyLending:DefaultClaimed", async ({ event, context }) => {
  const { loanId } = event.args;

  await context.db
    .insert(loan)
    .values({
      loanId,
      offerId: 0n,
      borrower: "0x0000000000000000000000000000000000000000",
      lender: "0x0000000000000000000000000000000000000000",
      tokenId: 0n,
      principal: 0n,
      deadline: 0n,
      repaid: false,
      defaulted: true,
    })
    .onConflictDoUpdate({
      defaulted: true,
    });
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

ponder.on("CommunityGrants:ProposalExecuted", async ({ event, context }) => {
  const { id } = event.args;

  await context.db
    .insert(proposal)
    .values({
      id,
      proposer: "0x0000000000000000000000000000000000000000",
      recipient: "0x0000000000000000000000000000000000000000",
      amount: 0n,
      description: "",
      executed: true,
    })
    .onConflictDoUpdate({
      executed: true,
    });
});

// ProposalVoted -- skip (would need a separate votes table; can add later)

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

ponder.on("MemeBountyBoard:BountyCompleted", async ({ event, context }) => {
  const { bountyId, winner } = event.args;

  await context.db
    .insert(bounty)
    .values({
      id: bountyId,
      creator: "0x0000000000000000000000000000000000000000",
      reward: 0n,
      description: "",
      completed: true,
      winner,
    })
    .onConflictDoUpdate({
      completed: true,
      winner,
    });
});
