import { ponder } from "ponder:registry";
// AUDIT M5 (2026-05-24): imports for tables exclusively used by removed
// non-MVP subscriptions (restaking*/gaugeVote/bribe*/voteIncentives*/
// lpFarmAction/loanOffer/loan/proposal/proposalVote/bounty/gauge*) were
// pruned alongside those handlers + their schema tables.
import {
  stakingPosition,
  stakingAction,
  revenueEpoch,
  revenueClaim,
  factoryGuardianEvent,
  factoryEmergencyDisable,
  twapRebootstrap,
  swap,
  pairEvent,
  indexedPair,
  pauseState,
  pauseEvent,
  timelockProposal,
  polEvent,
  sweepEvent,
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

  // AUDIT FIX 2026-08-24: this was the ONLY write in the file without conflict
  // handling — a replayed Staked event (RPC fallback re-serve, reorg re-emit)
  // threw a primary-key violation, which Ponder retries and then halts the
  // whole sync on. Update-on-conflict matches the defensiveness every sibling
  // handler already has.
  await context.db
    .insert(stakingPosition)
    .values({
      tokenId,
      user,
      amount,
      lockDuration,
      lockEnd: ts + lockDuration,
      boostBps,
      createdAt: ts,
      updatedAt: ts,
    })
    .onConflictDoUpdate({
      user,
      amount,
      lockDuration,
      lockEnd: ts + lockDuration,
      boostBps,
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

  // AUDIT FIX 2026-05-26 [H-25]: reset ALL position metadata (lockDuration,
  // lockEnd, boostBps) on conflict — pre-fix only `amount` was zeroed, so
  // fully-unstaked positions kept their stale `lockEnd` and `boostBps`
  // values. Frontend "active positions" queries filtering on `lockEnd > now`
  // or computing voting power from `boostBps` mis-classified drained
  // positions as still active and over-counted boost.
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
      lockDuration: 0n,
      lockEnd: 0n,
      boostBps: 0n,
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

  // AUDIT FIX 2026-05-26 [H-25]: full metadata reset on conflict — same
  // class of fix as the Withdrawn handler above.
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
      lockDuration: 0n,
      lockEnd: 0n,
      boostBps: 0n,
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

// AUDIT FIX 2026-05-26 [H-24]: track ERC-721 Transfer events on the staking
// position NFT and update `stakingPosition.user` to the current owner.
// Pre-fix, `user` was set at mint time and never updated; any secondary-
// market trade or wallet rotation caused frontend "your positions" queries
// (filtering by `user = currentWallet`) to misattribute to the original
// minter. Mint (from == 0x0) is handled by `Staked`; burn (to == 0x0) by
// `Withdrawn`/`EarlyWithdrawn` — Transfer handles mid-lifecycle changes.
ponder.on("TegridyStaking:Transfer", async ({ event, context }) => {
  const { from, to, tokenId } = event.args;
  const ts = event.block.timestamp;

  if (from === "0x0000000000000000000000000000000000000000") return;
  if (to === "0x0000000000000000000000000000000000000000") return;

  // Defensive: position row may not exist yet if event ordering surprises us
  // (Ponder is in-order, but reorg-replay can re-fire). Use upsert pattern.
  const existing = await context.db.find(stakingPosition, { tokenId });
  if (existing) {
    await context.db
      .update(stakingPosition, { tokenId })
      .set({ user: to, updatedAt: ts });
  }
  // If no row exists, the `Staked` handler hasn't fired yet — Transfer-
  // before-Staked is structurally impossible (ERC-721 requires mint before
  // transfer), so this branch is purely defensive.

  await context.db
    .insert(stakingAction)
    .values({
      id: event.log.id,
      user: to,
      tokenId,
      type: "transfer",
      amount: 0n,
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

// AUDIT M5 (2026-05-24): TegridyRestaking handlers removed — DEFERRED to
// Phase 7, not in the MVP set. Its exclusive tables (restakingPosition/
// restakingClaim/restakingAdminAction) were dropped from ponder.schema.ts.

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

// AUDIT M5 (2026-05-24): VoteIncentives handlers removed — non-MVP. Its
// exclusive tables (gaugeVote/bribeDeposit/bribeClaim/voteIncentivesCommit/
// voteIncentivesEpoch/voteIncentivesRefund/voteIncentivesMinBribeChange)
// were dropped from ponder.schema.ts.

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

// The 48h-timelocked ETH sweep, all three lifecycle events. Registered late
// (see the `sweep_event` note in ponder.schema.ts): the ABI declared them from
// the Wave-2 timelock change onward, but with no handler Ponder never fetched
// the logs, so "the router has never swept" and "we never asked" were the same
// empty table.
ponder.on("SwapFeeRouter:SweepETHProposed", async ({ event, context }) => {
  await context.db.insert(sweepEvent).values({
    id: event.log.id,
    contract: "SwapFeeRouter",
    type: "proposed",
    amount: event.args.amount,
    readyAt: event.args.readyAt,
    timestamp: event.block.timestamp,
    txHash: event.transaction.hash,
  })
    .onConflictDoNothing();
});
ponder.on("SwapFeeRouter:SweepETHExecuted", async ({ event, context }) => {
  await context.db.insert(sweepEvent).values({
    id: event.log.id,
    contract: "SwapFeeRouter",
    type: "executed",
    amount: event.args.amount,
    timestamp: event.block.timestamp,
    txHash: event.transaction.hash,
  })
    .onConflictDoNothing();
});
ponder.on("SwapFeeRouter:SweepETHCancelled", async ({ event, context }) => {
  // No arguments on this one. `amount` stays null rather than 0n — a cancelled
  // proposal did not sweep nothing, it reported nothing.
  await context.db.insert(sweepEvent).values({
    id: event.log.id,
    contract: "SwapFeeRouter",
    type: "cancelled",
    timestamp: event.block.timestamp,
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

// AUDIT M5 (2026-05-24): LPFarming handlers removed — non-MVP. Its exclusive
// table (lpFarmAction) was dropped from ponder.schema.ts.

// AUDIT M5 (2026-05-24): TegridyLending handlers removed — non-MVP. Its
// exclusive tables (loanOffer/loan) were dropped from ponder.schema.ts. The
// stub `logEvent` handlers (LoanOfferCancelled/EscrowRewardsPaid/
// CollateralStuck/StuckCollateralClaimed) further down were removed too.

// AUDIT M5 (2026-05-24): CommunityGrants handlers removed — non-MVP. Its
// exclusive tables (proposal/proposalVote) were dropped from
// ponder.schema.ts.

// AUDIT M5 (2026-05-24): MemeBountyBoard handlers removed — non-MVP. Its
// exclusive table (bounty) was dropped from ponder.schema.ts.

// AUDIT M5 (2026-05-24): GaugeController handlers removed — non-MVP. Its
// exclusive tables (gauge/gaugeEvent/gaugeVoteCommit/gaugeVoteRevealed) were
// dropped from ponder.schema.ts.

// ─── TegridyPair (R054 / Agent 084 IDX-H2) ───────────────────────────────────

// AUDIT M4 (2026-05-24): pair-event poisoning — allowlist TOWELI/WETH pairs
// only.
//
// TegridyPair is subscribed via factory(TegridyFactory.PairCreated), so the
// indexer auto-tracks EVERY pair the factory ever creates. If pair creation is
// permissionless, an attacker can create junk pairs (e.g. ATTACK/SCAM) and
// spam Swap/Mint/Burn to poison indexed DEX volume + TVL. We index a pair's
// events ONLY if its token0 or token1 is a canonical protocol token.
//
// To avoid an RPC call per event we cache the per-pair token0/token1 + verdict
// in the `indexedPair` table: the first event for a pair triggers one
// readContract pair (token0()+token1()); every later event reads the cached
// row. `isPairAllowed` returns the cached/!computed verdict; handlers early-
// return when it is false.
const CANONICAL_TOKENS: ReadonlySet<string> = new Set([
  "0x420698cfdeddea6bc78d59bc17798113ad278f9d", // TOWELI
  "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", // WETH
]);

// Minimal Uniswap-V2-style pair ABI for the token0()/token1() reads.
const PairTokensAbi = [
  {
    type: "function",
    name: "token0",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "token1",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

// AUDIT FIX 2026-05-26 [H-27]: in-memory cache for pair-allowed lookups.
// Pre-fix, every first-event-for-a-pair fired a `context.db.find` (DB I/O)
// PLUS 2 serial readContract calls if not in DB. Spamming N junk pairs and
// firing one Swap each = 2N RPC calls + N DB hits per block, stalling sync
// indefinitely. The in-memory map is process-lifetime; on restart the DB
// cache catches up immediately. Negative-cache (false verdicts) is the key
// improvement — junk pairs were re-queried per restart pre-fix.
// Battle-tested pattern: per-process LRU cache (kept unbounded because the
// keyspace is bounded by TegridyFactory pair count — ~hundreds at most).
const _pairAllowedCache: Map<string, boolean> = new Map();

async function isPairAllowed(
  context: { db: any; client: { readContract: (args: any) => Promise<any> } },
  pair: `0x${string}`,
): Promise<boolean> {
  const id = pair.toLowerCase() as `0x${string}`;

  // Fastest path: in-memory verdict from a prior call this session.
  const memo = _pairAllowedCache.get(id);
  if (memo !== undefined) return memo;

  // Fast path: cached verdict from a prior event for this pair (DB).
  const cached = await context.db.find(indexedPair, { id });
  if (cached) {
    _pairAllowedCache.set(id, cached.allowed);
    return cached.allowed;
  }

  // Slow path (once per pair): resolve token0()/token1() over RPC, then cache.
  // If the read reverts (non-conforming contract), treat the pair as NOT a
  // canonical pair — fail closed so junk pairs can never poison the data.
  let token0: `0x${string}`;
  let token1: `0x${string}`;
  try {
    token0 = (await context.client.readContract({
      abi: PairTokensAbi,
      address: pair,
      functionName: "token0",
    })) as `0x${string}`;
    token1 = (await context.client.readContract({
      abi: PairTokensAbi,
      address: pair,
      functionName: "token1",
    })) as `0x${string}`;
  } catch {
    // AUDIT FIX 2026-05-26 [H-27]: memoize negative verdict so junk pairs
    // (revert on token0/token1) cannot re-trigger RPC each restart.
    _pairAllowedCache.set(id, false);
    await context.db
      .insert(indexedPair)
      .values({
        id,
        token0: "0x0000000000000000000000000000000000000000",
        token1: "0x0000000000000000000000000000000000000000",
        allowed: false,
      })
      .onConflictDoNothing();
    return false;
  }

  const allowed =
    CANONICAL_TOKENS.has(token0.toLowerCase()) ||
    CANONICAL_TOKENS.has(token1.toLowerCase());

  // AUDIT FIX 2026-05-26 [H-27]: memoize positive verdict too.
  _pairAllowedCache.set(id, allowed);

  await context.db
    .insert(indexedPair)
    .values({ id, token0, token1, allowed })
    .onConflictDoNothing();

  return allowed;
}

ponder.on("TegridyPair:Swap", async ({ event, context }) => {
  // AUDIT M4: skip events from non-canonical (potentially poisoned) pairs.
  if (!(await isPairAllowed(context, event.log.address))) return;
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
  // AUDIT M4: skip events from non-canonical (potentially poisoned) pairs.
  if (!(await isPairAllowed(context, event.log.address))) return;
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
  // AUDIT M4: skip events from non-canonical (potentially poisoned) pairs.
  if (!(await isPairAllowed(context, event.log.address))) return;
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

// AUDIT M5 (2026-05-24): PremiumAccess_Pause and TegridyNFTLending_Pause
// handlers removed — both contracts are non-MVP. POLAccumulator_Pause is
// retained (POLAccumulator is in the MVP set).
ponder.on("POLAccumulator_Pause:Paused", async ({ event, context }) => {
  await recordPauseState(context, event, "POLAccumulator", true);
});
ponder.on("POLAccumulator_Pause:Unpaused", async ({ event, context }) => {
  await recordPauseState(context, event, "POLAccumulator", false);
});

// ─── Wave-3 IDX-1 follow-up (2026-06-02): POLAccumulator business-event tables ─
//
// Previously these 6 events were log-only (a `logEvent` console trace), so POL /
// treasury activity wasn't GraphQL-queryable. Each now writes a discriminated
// `pol_event` row. Ponder requires a handler for every registered event;
// POLAccumulator is in the MVP set.

ponder.on("POLAccumulator_Business:Accumulated", async ({ event, context }) => {
  await context.db.insert(polEvent).values({
    id: event.log.id,
    type: "accumulated",
    ethUsed: event.args.ethUsed,
    toweliAdded: event.args.toweliAdded,
    lpCreated: event.args.lpCreated,
    timestamp: event.block.timestamp,
    txHash: event.transaction.hash,
  })
    .onConflictDoNothing();
});
ponder.on("POLAccumulator_Business:ETHReceived", async ({ event, context }) => {
  await context.db.insert(polEvent).values({
    id: event.log.id,
    type: "ethReceived",
    sender: event.args.sender,
    amount: event.args.amount,
    timestamp: event.block.timestamp,
    txHash: event.transaction.hash,
  })
    .onConflictDoNothing();
});
ponder.on("POLAccumulator_Business:SweepETHExecuted", async ({ event, context }) => {
  await context.db.insert(polEvent).values({
    id: event.log.id,
    type: "sweepEth",
    recipient: event.args.recipient,
    amount: event.args.amount,
    timestamp: event.block.timestamp,
    txHash: event.transaction.hash,
  })
    .onConflictDoNothing();
});
ponder.on("POLAccumulator_Business:POLHarvestExecuted", async ({ event, context }) => {
  await context.db.insert(polEvent).values({
    id: event.log.id,
    type: "polHarvest",
    lpAmount: event.args.lpAmount,
    tokenOut: event.args.tokenOut,
    ethOut: event.args.ethOut,
    timestamp: event.block.timestamp,
    txHash: event.transaction.hash,
  })
    .onConflictDoNothing();
});
ponder.on("POLAccumulator_Business:SweepTokensExecuted", async ({ event, context }) => {
  await context.db.insert(polEvent).values({
    id: event.log.id,
    type: "sweepTokens",
    token: event.args.token,
    recipient: event.args.recipient,
    amount: event.args.amount,
    timestamp: event.block.timestamp,
    txHash: event.transaction.hash,
  })
    .onConflictDoNothing();
});
ponder.on("POLAccumulator_Business:TreasuryChanged", async ({ event, context }) => {
  await context.db.insert(polEvent).values({
    id: event.log.id,
    type: "treasuryChanged",
    oldTreasury: event.args.oldTreasury,
    newTreasury: event.args.newTreasury,
    timestamp: event.block.timestamp,
    txHash: event.transaction.hash,
  })
    .onConflictDoNothing();
});

// AUDIT M5 (2026-05-24): PremiumAccess_Business stub handlers removed —
// PremiumAccess is non-MVP. TegridyLending stub handlers (LoanOfferCancelled/
// EscrowRewardsPaid/CollateralStuck/StuckCollateralClaimed) removed too —
// TegridyLending is non-MVP. These were log-only stubs with no DB tables.

// ─── TegridyFactory governance (post-Batch-J sweep) ──────────────────────────

ponder.on("TegridyFactory_Governance:GuardianSet", async ({ event, context }) => {
  const { oldGuardian, newGuardian } = event.args;
  await context.db
    .insert(factoryGuardianEvent)
    .values({
      id: event.log.id,
      type: "set",
      oldGuardian,
      newGuardian,
      timestamp: event.block.timestamp,
      txHash: event.transaction.hash,
    })
    .onConflictDoNothing();
});

ponder.on("TegridyFactory_Governance:GuardianChangeProposed", async ({ event, context }) => {
  const { currentGuardian, proposedGuardian, executeAfter } = event.args;
  await context.db
    .insert(factoryGuardianEvent)
    .values({
      id: event.log.id,
      type: "proposed",
      oldGuardian: currentGuardian,
      newGuardian: proposedGuardian,
      executeAfter,
      timestamp: event.block.timestamp,
      txHash: event.transaction.hash,
    })
    .onConflictDoNothing();
});

ponder.on("TegridyFactory_Governance:GuardianChangeExecuted", async ({ event, context }) => {
  const { oldGuardian, newGuardian } = event.args;
  await context.db
    .insert(factoryGuardianEvent)
    .values({
      id: event.log.id,
      type: "executed",
      oldGuardian,
      newGuardian,
      timestamp: event.block.timestamp,
      txHash: event.transaction.hash,
    })
    .onConflictDoNothing();
});

ponder.on("TegridyFactory_Governance:GuardianChangeCancelled", async ({ event, context }) => {
  const { cancelled } = event.args;
  await context.db
    .insert(factoryGuardianEvent)
    .values({
      id: event.log.id,
      type: "cancelled",
      newGuardian: cancelled,
      timestamp: event.block.timestamp,
      txHash: event.transaction.hash,
    })
    .onConflictDoNothing();
});

ponder.on("TegridyFactory_Governance:PairEmergencyDisabled", async ({ event, context }) => {
  const { pair, by } = event.args;
  await context.db
    .insert(factoryEmergencyDisable)
    .values({
      id: event.log.id,
      pair,
      by,
      timestamp: event.block.timestamp,
      txHash: event.transaction.hash,
    })
    .onConflictDoNothing();
});

// F1 2026-08-18: TegridyFactory inherits TimelockAdmin, so every timelocked
// factory change (pair disable/enable, token block, feeTo change, guardian
// rotation) also emits the keyed triplet. Routing it through the existing
// writer puts the factory's pending queue alongside the two Admin sisters
// under contract = "TegridyFactory"; see the ABI comment in ponder.config.ts
// for what the keyed rows can and cannot answer.
ponder.on("TegridyFactory_Governance:ProposalCreated", async ({ event, context }) => {
  await recordTimelockEvent(context, event, "TegridyFactory", "created");
});
ponder.on("TegridyFactory_Governance:ProposalExecuted", async ({ event, context }) => {
  await recordTimelockEvent(context, event, "TegridyFactory", "executed");
});
ponder.on("TegridyFactory_Governance:ProposalCancelled", async ({ event, context }) => {
  await recordTimelockEvent(context, event, "TegridyFactory", "cancelled");
});

// ─── TegridyTWAP rebootstrap (post-Batch-J sweep) ────────────────────────────

ponder.on("TegridyTWAP:DeviationBypassed", async ({ event, context }) => {
  const { pair, elapsed, spotPrice0, spotPrice1 } = event.args;
  await context.db
    .insert(twapRebootstrap)
    .values({
      id: event.log.id,
      pair,
      elapsed: BigInt(elapsed),
      spotPrice0,
      spotPrice1,
      timestamp: event.block.timestamp,
      txHash: event.transaction.hash,
    })
    .onConflictDoNothing();
});

// ─── TegridyStakingAdmin (post-2026-04-26 split) ─────────────────────────────
//
// AUDIT (commit 99eaf9b): timelocked admin triplets moved off TegridyStaking
// into TegridyStakingAdmin. ProposalCreated/Executed/Cancelled now fire from
// the admin contract; recordTimelockEvent writes to the existing
// timelockProposal table with contract = "TegridyStakingAdmin".
ponder.on("TegridyStakingAdmin:ProposalCreated", async ({ event, context }) => {
  await recordTimelockEvent(context, event, "TegridyStakingAdmin", "created");
});
ponder.on("TegridyStakingAdmin:ProposalExecuted", async ({ event, context }) => {
  await recordTimelockEvent(context, event, "TegridyStakingAdmin", "executed");
});
ponder.on("TegridyStakingAdmin:ProposalCancelled", async ({ event, context }) => {
  await recordTimelockEvent(context, event, "TegridyStakingAdmin", "cancelled");
});

// ─── SwapFeeRouterAdmin (post-2026-04-26 split) ──────────────────────────────
//
// AUDIT (commit cb3d12b): timelocked admin triplets moved off SwapFeeRouter
// into SwapFeeRouterAdmin. Same pattern as TegridyStakingAdmin.
ponder.on("SwapFeeRouterAdmin:ProposalCreated", async ({ event, context }) => {
  await recordTimelockEvent(context, event, "SwapFeeRouterAdmin", "created");
});
ponder.on("SwapFeeRouterAdmin:ProposalExecuted", async ({ event, context }) => {
  await recordTimelockEvent(context, event, "SwapFeeRouterAdmin", "executed");
});
ponder.on("SwapFeeRouterAdmin:ProposalCancelled", async ({ event, context }) => {
  await recordTimelockEvent(context, event, "SwapFeeRouterAdmin", "cancelled");
});
