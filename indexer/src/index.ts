import { ponder } from "ponder:registry";
import {
  stakingPosition,
  stakingAction,
  restakingPosition,
  restakingClaim,
  restakingAdminAction,
  revenueEpoch,
  revenueClaim,
  gaugeVote,
  bribeDeposit,
  bribeClaim,
  voteIncentivesCommit,
  voteIncentivesEpoch,
  voteIncentivesRefund,
  swap,
  pairEvent,
  lpFarmAction,
  loanOffer,
  loan,
  proposal,
  proposalVote,
  bounty,
  gauge,
  gaugeEvent,
  gaugeVoteCommit,
  gaugeVoteRevealed,
  pauseState,
  pauseEvent,
  timelockProposal,
} from "ponder:schema";

// ─── Helpers ─────────────────────────────────────────────────────────────────

// AUDIT R054: shared pause-state writer so handler bodies stay 6 lines
// and the contract→logical-name mapping lives in exactly one place.
async function recordPauseState(
  context: { db: any },
  event: {
    log: { id: string };
    args: { account: `0x${string}` };
    block: { timestamp: bigint };
    transaction: { hash: `0x${string}` };
  },
  contractName: string,
  paused: boolean,
) {
  await context.db
    .insert(pauseEvent)
    .values({
      id: event.log.id,
      contract: contractName,
      type: paused ? "paused" : "unpaused",
      account: event.args.account,
      timestamp: event.block.timestamp,
      txHash: event.transaction.hash,
    })
    .onConflictDoNothing();

  await context.db
    .insert(pauseState)
    .values({
      contract: contractName,
      paused,
      updatedAt: event.block.timestamp,
    })
    .onConflictDoUpdate({ paused, updatedAt: event.block.timestamp });
}

// AUDIT R054: shared TimelockAdmin lifecycle writer. Idempotent on log id.
async function recordTimelockEvent(
  context: { db: any },
  event: {
    log: { id: string };
    args: any;
    block: { timestamp: bigint };
    transaction: { hash: `0x${string}` };
  },
  contractName: string,
  type: "created" | "executed" | "cancelled",
) {
  await context.db
    .insert(timelockProposal)
    .values({
      id: `${contractName}:${event.args.key}:${type}:${event.log.id}`,
      contract: contractName,
      key: event.args.key,
      type,
      executeAfter: type === "created" ? event.args.executeAfter : null,
      expiresAt: type === "created" ? event.args.expiresAt : null,
      timestamp: event.block.timestamp,
      txHash: event.transaction.hash,
    })
    .onConflictDoNothing();
}

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

  await context.db
    .insert(stakingAction)
    .values({
      id: event.log.id,
      user,
      tokenId,
      type: "stake",
      amount,
      timestamp: ts,
      txHash: event.transaction.hash,
    })
    .onConflictDoNothing();
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

  await context.db
    .insert(stakingAction)
    .values({
      id: event.log.id,
      user,
      tokenId,
      type: "withdraw",
      amount,
      timestamp: ts,
      txHash: event.transaction.hash,
    })
    .onConflictDoNothing();
});

// AUDIT R054 (Agent 084 IDX-H5): EarlyWithdrawn ABI declares 4 args; the
// previous handler dropped `penalty` silently. Now read all four and
// persist `penalty` on the action row.
ponder.on("TegridyStaking:EarlyWithdrawn", async ({ event, context }) => {
  const { user, tokenId, amount, penalty } = event.args;
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

  await context.db
    .insert(stakingAction)
    .values({
      id: event.log.id,
      user,
      tokenId,
      type: "earlyWithdraw",
      amount,
      penalty,
      timestamp: ts,
      txHash: event.transaction.hash,
    })
    .onConflictDoNothing();
});

ponder.on("TegridyStaking:RewardPaid", async ({ event, context }) => {
  const { user, tokenId, reward } = event.args;
  const ts = event.block.timestamp;

  await context.db
    .insert(stakingAction)
    .values({
      id: event.log.id,
      user,
      tokenId,
      type: "claim",
      amount: reward,
      timestamp: ts,
      txHash: event.transaction.hash,
    })
    .onConflictDoNothing();
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

  await context.db
    .insert(stakingAction)
    .values({
      id: event.log.id,
      user: pos.user,
      tokenId,
      type: "extend",
      amount: 0n,
      timestamp: ts,
      txHash: event.transaction.hash,
    })
    .onConflictDoNothing();
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

  await context.db
    .insert(stakingAction)
    .values({
      id: event.log.id,
      user: pos.user,
      tokenId,
      type: "increase",
      amount: addedAmount,
      timestamp: ts,
      txHash: event.transaction.hash,
    })
    .onConflictDoNothing();
});

// AUDIT R010: TimelockAdmin events (bytes32 key) — only one overload
// exists in TegridyStaking's ABI so the name-only form resolves cleanly.
ponder.on("TegridyStaking:ProposalCreated", async ({ event, context }) => {
  await recordTimelockEvent(context, event, "TegridyStaking", "created");
});
ponder.on("TegridyStaking:ProposalExecuted", async ({ event, context }) => {
  await recordTimelockEvent(context, event, "TegridyStaking", "executed");
});
ponder.on("TegridyStaking:ProposalCancelled", async ({ event, context }) => {
  await recordTimelockEvent(context, event, "TegridyStaking", "cancelled");
});

// AUDIT R054: pause-state handlers folded into the existing subscription.
ponder.on("TegridyStaking:Paused", async ({ event, context }) => {
  await recordPauseState(context, event, "TegridyStaking", true);
});
ponder.on("TegridyStaking:Unpaused", async ({ event, context }) => {
  await recordPauseState(context, event, "TegridyStaking", false);
});

// ─── TegridyRestaking ────────────────────────────────────────────────────────

// AUDIT R054 (Agent 084 IDX-M1): Restaked persists `positionAmount` so
// emergency reconciliation can compare on-chain reality against indexer
// state without re-reading the chain.
ponder.on("TegridyRestaking:Restaked", async ({ event, context }) => {
  const { user, tokenId, positionAmount } = event.args;
  const ts = event.block.timestamp;

  await context.db
    .insert(restakingPosition)
    .values({
      tokenId,
      user,
      depositTime: ts,
      positionAmount,
    })
    .onConflictDoUpdate({
      user,
      depositTime: ts,
      positionAmount,
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
      positionAmount: null,
    })
    .onConflictDoUpdate({
      depositTime: 0n,
      positionAmount: null,
    });
});

// AUDIT INDEXER-M2: track base + bonus restaking claims in restakingClaim.
ponder.on("TegridyRestaking:BonusClaimed", async ({ event, context }) => {
  const { user, bonusAmount } = event.args;
  await context.db
    .insert(restakingClaim)
    .values({
      id: event.log.id,
      user,
      type: "bonus",
      amount: bonusAmount,
      timestamp: event.block.timestamp,
    })
    .onConflictDoNothing();
});

ponder.on("TegridyRestaking:BaseClaimed", async ({ event, context }) => {
  const { user, baseAmount } = event.args;
  await context.db
    .insert(restakingClaim)
    .values({
      id: event.log.id,
      user,
      type: "base",
      amount: baseAmount,
      timestamp: event.block.timestamp,
    })
    .onConflictDoNothing();
});

// AUDIT R054 (Agent 084): admin reconciliation events.
ponder.on(
  "TegridyRestaking:PositionRefreshed",
  async ({ event, context }) => {
    const { user, tokenId, oldAmount, newAmount } = event.args;
    await context.db
      .insert(restakingAdminAction)
      .values({
        id: event.log.id,
        type: "positionRefreshed",
        restaker: user,
        tokenId,
        oldValue: oldAmount,
        newValue: newAmount,
        timestamp: event.block.timestamp,
        txHash: event.transaction.hash,
      })
      .onConflictDoNothing();
  },
);

ponder.on(
  "TegridyRestaking:BoostRevalidated",
  async ({ event, context }) => {
    const { restaker, tokenId, oldBoosted, newBoosted } = event.args;
    await context.db
      .insert(restakingAdminAction)
      .values({
        id: event.log.id,
        type: "boostRevalidated",
        restaker,
        tokenId,
        oldValue: oldBoosted,
        newValue: newBoosted,
        timestamp: event.block.timestamp,
        txHash: event.transaction.hash,
      })
      .onConflictDoNothing();
  },
);

ponder.on(
  "TegridyRestaking:EmergencyForceReturn",
  async ({ event, context }) => {
    const { restaker, tokenId, nftReturned } = event.args;
    await context.db
      .insert(restakingAdminAction)
      .values({
        id: event.log.id,
        type: "emergencyForceReturn",
        restaker,
        tokenId,
        nftReturned,
        timestamp: event.block.timestamp,
        txHash: event.transaction.hash,
      })
      .onConflictDoNothing();
  },
);

ponder.on("TegridyRestaking:Paused", async ({ event, context }) => {
  await recordPauseState(context, event, "TegridyRestaking", true);
});
ponder.on("TegridyRestaking:Unpaused", async ({ event, context }) => {
  await recordPauseState(context, event, "TegridyRestaking", false);
});

// ─── RevenueDistributor ──────────────────────────────────────────────────────

ponder.on("RevenueDistributor:EpochDistributed", async ({ event, context }) => {
  const { epochId, ethAmount, totalLocked } = event.args;
  const ts = event.block.timestamp;

  await context.db
    .insert(revenueEpoch)
    .values({
      epochId,
      ethAmount,
      totalLocked,
      timestamp: ts,
    })
    .onConflictDoNothing();
});

ponder.on("RevenueDistributor:Claimed", async ({ event, context }) => {
  const { user, ethAmount, fromEpoch, toEpoch } = event.args;
  const ts = event.block.timestamp;

  await context.db
    .insert(revenueClaim)
    .values({
      id: event.log.id,
      user,
      ethAmount,
      fromEpoch,
      toEpoch,
      timestamp: ts,
    })
    .onConflictDoNothing();
});

ponder.on("RevenueDistributor:Paused", async ({ event, context }) => {
  await recordPauseState(context, event, "RevenueDistributor", true);
});
ponder.on("RevenueDistributor:Unpaused", async ({ event, context }) => {
  await recordPauseState(context, event, "RevenueDistributor", false);
});

// ─── VoteIncentives ──────────────────────────────────────────────────────────

ponder.on("VoteIncentives:GaugeVoted", async ({ event, context }) => {
  const { user, epoch, pair, power } = event.args;
  const ts = event.block.timestamp;

  await context.db
    .insert(gaugeVote)
    .values({
      id: event.log.id,
      user,
      epoch,
      pair,
      power,
      timestamp: ts,
    })
    .onConflictDoNothing();
});

ponder.on("VoteIncentives:BribeDeposited", async ({ event, context }) => {
  const { epoch, pair, token, depositor, amount, fee } = event.args;
  const ts = event.block.timestamp;

  await context.db
    .insert(bribeDeposit)
    .values({
      id: event.log.id,
      epoch,
      pair,
      token,
      depositor,
      amount,
      fee,
      timestamp: ts,
    })
    .onConflictDoNothing();
});

// AUDIT R054: ETH-bribe path. `token` is null to flag the deposit
// originated as native ETH (frontend renders WETH symbol fallback).
ponder.on("VoteIncentives:BribeDepositedETH", async ({ event, context }) => {
  const { epoch, pair, depositor, amount, fee } = event.args;
  const ts = event.block.timestamp;

  await context.db
    .insert(bribeDeposit)
    .values({
      id: event.log.id,
      epoch,
      pair,
      token: null,
      depositor,
      amount,
      fee,
      timestamp: ts,
    })
    .onConflictDoNothing();
});

// AUDIT INDEXER-M2: track bribe claims in bribeClaim so per-user claim history
// is reconstructible alongside the existing bribeDeposit deposit flow.
ponder.on("VoteIncentives:BribeClaimed", async ({ event, context }) => {
  const { user, epoch, pair, token, amount } = event.args;
  await context.db
    .insert(bribeClaim)
    .values({
      id: event.log.id,
      user,
      epoch,
      pair,
      token,
      amount,
      timestamp: event.block.timestamp,
    })
    .onConflictDoNothing();
});

// AUDIT R054 (R020/R021): commit-reveal vote flow.
ponder.on("VoteIncentives:VoteCommitted", async ({ event, context }) => {
  const { user, epoch, commitIndex, commitHash } = event.args;
  await context.db
    .insert(voteIncentivesCommit)
    .values({
      id: event.log.id,
      user,
      epoch,
      commitIndex,
      commitHash,
      timestamp: event.block.timestamp,
    })
    .onConflictDoNothing();
});

ponder.on("VoteIncentives:VoteRevealed", async ({ event, context }) => {
  const { user, epoch, commitIndex, pair, power } = event.args;
  // Reveal lands as a separate row keyed by log id; the original commit
  // remains queryable for forensic purposes (commit→reveal latency etc).
  await context.db
    .insert(voteIncentivesCommit)
    .values({
      id: event.log.id,
      user,
      epoch,
      commitIndex,
      revealedAt: event.block.timestamp,
      revealedPair: pair,
      revealedPower: power,
      timestamp: event.block.timestamp,
    })
    .onConflictDoNothing();
});

ponder.on("VoteIncentives:EpochAdvanced", async ({ event, context }) => {
  const { epochId, totalPower, timestamp } = event.args;
  await context.db
    .insert(voteIncentivesEpoch)
    .values({
      epochId,
      totalPower,
      timestamp,
    })
    .onConflictDoNothing();
});

// AUDIT R054 (NEW-G2): per-depositor orphaned-bribe pull refund.
ponder.on("VoteIncentives:OrphanedBribeRefunded", async ({ event, context }) => {
  const { epoch, pair, token, depositor, amount } = event.args;
  await context.db
    .insert(voteIncentivesRefund)
    .values({
      id: event.log.id,
      type: "orphaned",
      epoch,
      pair,
      token,
      depositor,
      amount,
      timestamp: event.block.timestamp,
    })
    .onConflictDoNothing();
});

ponder.on("VoteIncentives:Paused", async ({ event, context }) => {
  await recordPauseState(context, event, "VoteIncentives", true);
});
ponder.on("VoteIncentives:Unpaused", async ({ event, context }) => {
  await recordPauseState(context, event, "VoteIncentives", false);
});

// ─── SwapFeeRouter ───────────────────────────────────────────────────────────

ponder.on("SwapFeeRouter:SwapExecuted", async ({ event, context }) => {
  const { user, tokenIn, tokenOut, amountIn, fee } = event.args;
  const ts = event.block.timestamp;

  await context.db
    .insert(swap)
    .values({
      id: event.log.id,
      user,
      tokenIn,
      tokenOut,
      amountIn,
      fee,
      timestamp: ts,
      txHash: event.transaction.hash,
    })
    .onConflictDoNothing();
});

ponder.on("SwapFeeRouter:Paused", async ({ event, context }) => {
  await recordPauseState(context, event, "SwapFeeRouter", true);
});
ponder.on("SwapFeeRouter:Unpaused", async ({ event, context }) => {
  await recordPauseState(context, event, "SwapFeeRouter", false);
});

// ─── LPFarming ───────────────────────────────────────────────────────────────

ponder.on("LPFarming:Staked", async ({ event, context }) => {
  const { user, amount } = event.args;
  const ts = event.block.timestamp;

  await context.db
    .insert(lpFarmAction)
    .values({
      id: event.log.id,
      user,
      type: "stake",
      amount,
      timestamp: ts,
    })
    .onConflictDoNothing();
});

ponder.on("LPFarming:Withdrawn", async ({ event, context }) => {
  const { user, amount } = event.args;
  const ts = event.block.timestamp;

  await context.db
    .insert(lpFarmAction)
    .values({
      id: event.log.id,
      user,
      type: "withdraw",
      amount,
      timestamp: ts,
    })
    .onConflictDoNothing();
});

ponder.on("LPFarming:RewardPaid", async ({ event, context }) => {
  const { user, reward } = event.args;
  const ts = event.block.timestamp;

  await context.db
    .insert(lpFarmAction)
    .values({
      id: event.log.id,
      user,
      type: "claim",
      amount: reward,
      timestamp: ts,
    })
    .onConflictDoNothing();
});

ponder.on("LPFarming:Paused", async ({ event, context }) => {
  await recordPauseState(context, event, "LPFarming", true);
});
ponder.on("LPFarming:Unpaused", async ({ event, context }) => {
  await recordPauseState(context, event, "LPFarming", false);
});

// ─── TegridyLending ──────────────────────────────────────────────────────────

ponder.on("TegridyLending:LoanOfferCreated", async ({ event, context }) => {
  const { offerId, lender, principal, aprBps, duration } = event.args;

  await context.db
    .insert(loanOffer)
    .values({
      offerId,
      lender,
      principal,
      aprBps,
      duration,
    })
    .onConflictDoNothing();
});

ponder.on("TegridyLending:LoanAccepted", async ({ event, context }) => {
  const { loanId, offerId, borrower, lender, tokenId, principal, deadline } =
    event.args;

  await context.db
    .insert(loan)
    .values({
      loanId,
      offerId,
      borrower,
      lender,
      tokenId,
      principal,
      deadline,
      repaid: false,
      defaulted: false,
    })
    .onConflictDoNothing();
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

// AUDIT R010: TimelockAdmin events (bytes32 key) — only one overload
// exists in TegridyLending's ABI so the name-only form resolves cleanly.
ponder.on("TegridyLending:ProposalCreated", async ({ event, context }) => {
  await recordTimelockEvent(context, event, "TegridyLending", "created");
});
ponder.on("TegridyLending:ProposalExecuted", async ({ event, context }) => {
  await recordTimelockEvent(context, event, "TegridyLending", "executed");
});
ponder.on("TegridyLending:ProposalCancelled", async ({ event, context }) => {
  await recordTimelockEvent(context, event, "TegridyLending", "cancelled");
});

ponder.on("TegridyLending:Paused", async ({ event, context }) => {
  await recordPauseState(context, event, "TegridyLending", true);
});
ponder.on("TegridyLending:Unpaused", async ({ event, context }) => {
  await recordPauseState(context, event, "TegridyLending", false);
});

// ─── CommunityGrants ─────────────────────────────────────────────────────────

// AUDIT R010: full Solidity-signature notation disambiguates the
// grant-lifecycle (uint256 id) overloads from the inherited TimelockAdmin
// (bytes32 key) overloads.
ponder.on(
  "CommunityGrants:ProposalCreated(uint256 indexed id, address indexed proposer, address recipient, uint256 amount, string description)",
  async ({ event, context }) => {
    const { id, proposer, recipient, amount, description } = event.args;

    await context.db
      .insert(proposal)
      .values({
        id,
        proposer,
        recipient,
        amount,
        description,
        executed: false,
        cancelled: false,
      })
      .onConflictDoNothing();
  },
);

// AUDIT INDEXER-H1: ProposalExecuted fires on an existing proposal; use update().
ponder.on(
  "CommunityGrants:ProposalExecuted(uint256 indexed id, address recipient, uint256 amount)",
  async ({ event, context }) => {
    const { id } = event.args;
    const existing = await context.db.find(proposal, { id });
    if (!existing) return;
    await context.db.update(proposal, { id }).set({ executed: true });
  },
);

ponder.on(
  "CommunityGrants:ProposalCancelled(uint256 indexed id)",
  async ({ event, context }) => {
    const { id } = event.args;
    const existing = await context.db.find(proposal, { id });
    if (!existing) return;
    await context.db.update(proposal, { id }).set({ cancelled: true });
  },
);

// AUDIT INDEXER-M2: track per-user proposal votes so governance UI can show
// who voted which way and by how much power.
ponder.on("CommunityGrants:ProposalVoted", async ({ event, context }) => {
  const { id, voter, support, power } = event.args;
  await context.db
    .insert(proposalVote)
    .values({
      id: event.log.id,
      proposalId: id,
      voter,
      support,
      power,
      timestamp: event.block.timestamp,
    })
    .onConflictDoNothing();
});

// AUDIT R010: TimelockAdmin overloads (bytes32 key).
ponder.on(
  "CommunityGrants:ProposalCreated(bytes32 indexed key, uint256 executeAfter, uint256 expiresAt)",
  async ({ event, context }) => {
    await recordTimelockEvent(context, event, "CommunityGrants", "created");
  },
);
ponder.on(
  "CommunityGrants:ProposalExecuted(bytes32 indexed key)",
  async ({ event, context }) => {
    await recordTimelockEvent(context, event, "CommunityGrants", "executed");
  },
);
ponder.on(
  "CommunityGrants:ProposalCancelled(bytes32 indexed key)",
  async ({ event, context }) => {
    await recordTimelockEvent(context, event, "CommunityGrants", "cancelled");
  },
);

ponder.on("CommunityGrants:Paused", async ({ event, context }) => {
  await recordPauseState(context, event, "CommunityGrants", true);
});
ponder.on("CommunityGrants:Unpaused", async ({ event, context }) => {
  await recordPauseState(context, event, "CommunityGrants", false);
});

// ─── MemeBountyBoard ─────────────────────────────────────────────────────────

ponder.on("MemeBountyBoard:BountyCreated", async ({ event, context }) => {
  const { id, creator, reward, description } = event.args;

  await context.db
    .insert(bounty)
    .values({
      id,
      creator,
      reward,
      description,
      completed: false,
      winner: null,
    })
    .onConflictDoNothing();
});

// AUDIT INDEXER-H1: BountyCompleted fires on an existing bounty; use update().
ponder.on("MemeBountyBoard:BountyCompleted", async ({ event, context }) => {
  const { bountyId, winner } = event.args;
  const existing = await context.db.find(bounty, { id: bountyId });
  if (!existing) return;
  await context.db.update(bounty, { id: bountyId }).set({ completed: true, winner });
});

ponder.on("MemeBountyBoard:Paused", async ({ event, context }) => {
  await recordPauseState(context, event, "MemeBountyBoard", true);
});
ponder.on("MemeBountyBoard:Unpaused", async ({ event, context }) => {
  await recordPauseState(context, event, "MemeBountyBoard", false);
});

// ─── GaugeController (R054 / Agent 084 IDX-H1) ───────────────────────────────

ponder.on("GaugeController:Voted", async ({ event, context }) => {
  const { voter, tokenId, epoch, gauges, weights } = event.args;
  // Folded into gaugeVoteRevealed for symmetry with VoteIncentives flow:
  // legacy `Voted` events are equivalent to a same-block commit+reveal.
  await context.db
    .insert(gaugeVoteRevealed)
    .values({
      id: event.log.id,
      voter,
      tokenId,
      epoch,
      gauges: JSON.stringify(gauges),
      weights: JSON.stringify(weights.map((w) => w.toString())),
      timestamp: event.block.timestamp,
    })
    .onConflictDoNothing();
});

ponder.on("GaugeController:VoteCommitted", async ({ event, context }) => {
  const { voter, tokenId, epoch, commitmentHash } = event.args;
  await context.db
    .insert(gaugeVoteCommit)
    .values({
      id: event.log.id,
      voter,
      tokenId,
      epoch,
      commitmentHash,
      timestamp: event.block.timestamp,
    })
    .onConflictDoNothing();
});

ponder.on("GaugeController:VoteRevealed", async ({ event, context }) => {
  const { voter, tokenId, epoch, gauges, weights } = event.args;
  await context.db
    .insert(gaugeVoteRevealed)
    .values({
      id: event.log.id,
      voter,
      tokenId,
      epoch,
      gauges: JSON.stringify(gauges),
      weights: JSON.stringify(weights.map((w) => w.toString())),
      timestamp: event.block.timestamp,
    })
    .onConflictDoNothing();
});

ponder.on("GaugeController:GaugeAddProposed", async ({ event, context }) => {
  const { gauge: gaugeAddr, executeAfter } = event.args;
  const ts = event.block.timestamp;
  await context.db
    .insert(gauge)
    .values({
      address: gaugeAddr,
      status: "proposedAdd",
      proposedAt: ts,
      updatedAt: ts,
    })
    .onConflictDoUpdate({
      status: "proposedAdd",
      proposedAt: ts,
      updatedAt: ts,
    });
  await context.db
    .insert(gaugeEvent)
    .values({
      id: event.log.id,
      type: "proposed",
      gauge: gaugeAddr,
      valueA: executeAfter,
      timestamp: ts,
      txHash: event.transaction.hash,
    })
    .onConflictDoNothing();
});

ponder.on("GaugeController:GaugeAdded", async ({ event, context }) => {
  const { gauge: gaugeAddr } = event.args;
  const ts = event.block.timestamp;
  await context.db
    .insert(gauge)
    .values({
      address: gaugeAddr,
      status: "active",
      addedAt: ts,
      updatedAt: ts,
    })
    .onConflictDoUpdate({
      status: "active",
      addedAt: ts,
      updatedAt: ts,
    });
  await context.db
    .insert(gaugeEvent)
    .values({
      id: event.log.id,
      type: "added",
      gauge: gaugeAddr,
      timestamp: ts,
      txHash: event.transaction.hash,
    })
    .onConflictDoNothing();
});

ponder.on("GaugeController:GaugeRemoveProposed", async ({ event, context }) => {
  const { gauge: gaugeAddr, executeAfter } = event.args;
  const ts = event.block.timestamp;
  await context.db
    .insert(gauge)
    .values({
      address: gaugeAddr,
      status: "proposedRemove",
      removeProposedAt: ts,
      updatedAt: ts,
    })
    .onConflictDoUpdate({
      status: "proposedRemove",
      removeProposedAt: ts,
      updatedAt: ts,
    });
  await context.db
    .insert(gaugeEvent)
    .values({
      id: event.log.id,
      type: "removeProposed",
      gauge: gaugeAddr,
      valueA: executeAfter,
      timestamp: ts,
      txHash: event.transaction.hash,
    })
    .onConflictDoNothing();
});

ponder.on("GaugeController:GaugeRemoved", async ({ event, context }) => {
  const { gauge: gaugeAddr } = event.args;
  const ts = event.block.timestamp;
  await context.db
    .insert(gauge)
    .values({
      address: gaugeAddr,
      status: "removed",
      removedAt: ts,
      updatedAt: ts,
    })
    .onConflictDoUpdate({
      status: "removed",
      removedAt: ts,
      updatedAt: ts,
    });
  await context.db
    .insert(gaugeEvent)
    .values({
      id: event.log.id,
      type: "removed",
      gauge: gaugeAddr,
      timestamp: ts,
      txHash: event.transaction.hash,
    })
    .onConflictDoNothing();
});

ponder.on(
  "GaugeController:EmissionBudgetProposed",
  async ({ event, context }) => {
    const { newBudget, executeAfter } = event.args;
    await context.db
      .insert(gaugeEvent)
      .values({
        id: event.log.id,
        type: "budgetProposed",
        valueA: newBudget,
        valueB: executeAfter,
        timestamp: event.block.timestamp,
        txHash: event.transaction.hash,
      })
      .onConflictDoNothing();
  },
);

ponder.on(
  "GaugeController:EmissionBudgetUpdated",
  async ({ event, context }) => {
    const { oldBudget, newBudget } = event.args;
    await context.db
      .insert(gaugeEvent)
      .values({
        id: event.log.id,
        type: "budgetUpdated",
        valueA: oldBudget,
        valueB: newBudget,
        timestamp: event.block.timestamp,
        txHash: event.transaction.hash,
      })
      .onConflictDoNothing();
  },
);

ponder.on("GaugeController:Paused", async ({ event, context }) => {
  await recordPauseState(context, event, "GaugeController", true);
});
ponder.on("GaugeController:Unpaused", async ({ event, context }) => {
  await recordPauseState(context, event, "GaugeController", false);
});

// ─── TegridyPair (R054 / Agent 084 IDX-H2) ───────────────────────────────────

ponder.on("TegridyPair:Swap", async ({ event, context }) => {
  const { sender, amount0In, amount1In, amount0Out, amount1Out, to } =
    event.args;
  await context.db
    .insert(pairEvent)
    .values({
      id: event.log.id,
      type: "swap",
      pair: event.log.address,
      sender,
      to,
      amount0: amount0In + amount0Out,
      amount1: amount1In + amount1Out,
      amount0In,
      amount1In,
      amount0Out,
      amount1Out,
      timestamp: event.block.timestamp,
      txHash: event.transaction.hash,
    })
    .onConflictDoNothing();
});

ponder.on("TegridyPair:Mint", async ({ event, context }) => {
  const { sender, amount0, amount1 } = event.args;
  await context.db
    .insert(pairEvent)
    .values({
      id: event.log.id,
      type: "mint",
      pair: event.log.address,
      sender,
      amount0,
      amount1,
      timestamp: event.block.timestamp,
      txHash: event.transaction.hash,
    })
    .onConflictDoNothing();
});

ponder.on("TegridyPair:Burn", async ({ event, context }) => {
  const { sender, amount0, amount1, to } = event.args;
  await context.db
    .insert(pairEvent)
    .values({
      id: event.log.id,
      type: "burn",
      pair: event.log.address,
      sender,
      to,
      amount0,
      amount1,
      timestamp: event.block.timestamp,
      txHash: event.transaction.hash,
    })
    .onConflictDoNothing();
});

// ─── Pause-only contracts (R054 / Agent 084 IDX-H4) ──────────────────────────

ponder.on("PremiumAccess_Pause:Paused", async ({ event, context }) => {
  await recordPauseState(context, event, "PremiumAccess", true);
});
ponder.on("PremiumAccess_Pause:Unpaused", async ({ event, context }) => {
  await recordPauseState(context, event, "PremiumAccess", false);
});

ponder.on("POLAccumulator_Pause:Paused", async ({ event, context }) => {
  await recordPauseState(context, event, "POLAccumulator", true);
});
ponder.on("POLAccumulator_Pause:Unpaused", async ({ event, context }) => {
  await recordPauseState(context, event, "POLAccumulator", false);
});

ponder.on("TegridyNFTLending_Pause:Paused", async ({ event, context }) => {
  await recordPauseState(context, event, "TegridyNFTLending", true);
});
ponder.on("TegridyNFTLending_Pause:Unpaused", async ({ event, context }) => {
  await recordPauseState(context, event, "TegridyNFTLending", false);
});
