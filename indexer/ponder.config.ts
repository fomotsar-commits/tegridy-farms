import { createConfig, factory } from "ponder";
import { fallback, http, parseAbiItem } from "viem";

// ─── Inline ABIs (event-only) ────────────────────────────────────────────────

const TegridyStakingAbi = [
  {
    type: "event",
    name: "Staked",
    inputs: [
      { name: "user", type: "address", indexed: true },
      { name: "tokenId", type: "uint256", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "lockDuration", type: "uint256", indexed: false },
      { name: "boostBps", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Withdrawn",
    inputs: [
      { name: "user", type: "address", indexed: true },
      { name: "tokenId", type: "uint256", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "EarlyWithdrawn",
    inputs: [
      { name: "user", type: "address", indexed: true },
      { name: "tokenId", type: "uint256", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "penalty", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "RewardPaid",
    inputs: [
      { name: "user", type: "address", indexed: true },
      { name: "tokenId", type: "uint256", indexed: true },
      { name: "reward", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "LockExtended",
    inputs: [
      { name: "tokenId", type: "uint256", indexed: true },
      { name: "newLockDuration", type: "uint256", indexed: false },
      { name: "newLockEnd", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "AmountIncreased",
    inputs: [
      { name: "tokenId", type: "uint256", indexed: true },
      { name: "addedAmount", type: "uint256", indexed: false },
      { name: "newTotal", type: "uint256", indexed: false },
    ],
  },
  // AUDIT R010: TimelockAdmin event overloads (bytes32 key) — re-added.
  // CommunityGrants/Lending/Staking all inherit TimelockAdmin which emits
  // ProposalCreated/Executed/Cancelled keyed by `bytes32`. Without these
  // overloads the indexer cannot distinguish staking-admin proposals from
  // grant-lifecycle proposals (the latter use `uint256 id`).
  {
    type: "event",
    name: "ProposalCreated",
    inputs: [
      { name: "key", type: "bytes32", indexed: true },
      { name: "executeAfter", type: "uint256", indexed: false },
      { name: "expiresAt", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "ProposalExecuted",
    inputs: [{ name: "key", type: "bytes32", indexed: true }],
  },
  {
    type: "event",
    name: "ProposalCancelled",
    inputs: [{ name: "key", type: "bytes32", indexed: true }],
  },
  // AUDIT R054: Pausable surface folded into primary subscription.
  {
    type: "event",
    name: "Paused",
    inputs: [{ name: "account", type: "address", indexed: false }],
  },
  {
    type: "event",
    name: "Unpaused",
    inputs: [{ name: "account", type: "address", indexed: false }],
  },
] as const;

const TegridyRestakingAbi = [
  {
    type: "event",
    name: "Restaked",
    inputs: [
      { name: "user", type: "address", indexed: true },
      { name: "tokenId", type: "uint256", indexed: true },
      { name: "positionAmount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Unrestaked",
    inputs: [
      { name: "user", type: "address", indexed: true },
      { name: "tokenId", type: "uint256", indexed: true },
    ],
  },
  {
    type: "event",
    name: "BonusClaimed",
    inputs: [
      { name: "user", type: "address", indexed: true },
      { name: "bonusAmount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "BaseClaimed",
    inputs: [
      { name: "user", type: "address", indexed: true },
      { name: "baseAmount", type: "uint256", indexed: false },
    ],
  },
  // AUDIT R054: admin reconciliation events (PositionRefreshed C-05,
  // BoostRevalidated M-26, EmergencyForceReturn H-05).
  {
    type: "event",
    name: "PositionRefreshed",
    inputs: [
      { name: "user", type: "address", indexed: true },
      { name: "tokenId", type: "uint256", indexed: true },
      { name: "oldAmount", type: "uint256", indexed: false },
      { name: "newAmount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "BoostRevalidated",
    inputs: [
      { name: "restaker", type: "address", indexed: true },
      { name: "tokenId", type: "uint256", indexed: true },
      { name: "oldBoosted", type: "uint256", indexed: false },
      { name: "newBoosted", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "EmergencyForceReturn",
    inputs: [
      { name: "restaker", type: "address", indexed: true },
      { name: "tokenId", type: "uint256", indexed: true },
      { name: "nftReturned", type: "bool", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Paused",
    inputs: [{ name: "account", type: "address", indexed: false }],
  },
  {
    type: "event",
    name: "Unpaused",
    inputs: [{ name: "account", type: "address", indexed: false }],
  },
] as const;

const RevenueDistributorAbi = [
  {
    type: "event",
    name: "EpochDistributed",
    inputs: [
      { name: "epochId", type: "uint256", indexed: true },
      { name: "ethAmount", type: "uint256", indexed: false },
      { name: "totalLocked", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Claimed",
    inputs: [
      { name: "user", type: "address", indexed: true },
      { name: "ethAmount", type: "uint256", indexed: false },
      { name: "fromEpoch", type: "uint256", indexed: false },
      { name: "toEpoch", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Paused",
    inputs: [{ name: "account", type: "address", indexed: false }],
  },
  {
    type: "event",
    name: "Unpaused",
    inputs: [{ name: "account", type: "address", indexed: false }],
  },
] as const;

const VoteIncentivesAbi = [
  {
    type: "event",
    name: "EpochAdvanced",
    inputs: [
      { name: "epochId", type: "uint256", indexed: true },
      { name: "totalPower", type: "uint256", indexed: false },
      { name: "timestamp", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "BribeDeposited",
    inputs: [
      { name: "epoch", type: "uint256", indexed: true },
      { name: "pair", type: "address", indexed: true },
      { name: "token", type: "address", indexed: true },
      { name: "depositor", type: "address", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
      { name: "fee", type: "uint256", indexed: false },
    ],
  },
  // AUDIT R054: ETH-bribe path was missed previously.
  {
    type: "event",
    name: "BribeDepositedETH",
    inputs: [
      { name: "epoch", type: "uint256", indexed: true },
      { name: "pair", type: "address", indexed: true },
      { name: "depositor", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "fee", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "BribeClaimed",
    inputs: [
      { name: "user", type: "address", indexed: true },
      { name: "epoch", type: "uint256", indexed: true },
      { name: "pair", type: "address", indexed: true },
      { name: "token", type: "address", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "GaugeVoted",
    inputs: [
      { name: "user", type: "address", indexed: true },
      { name: "epoch", type: "uint256", indexed: true },
      { name: "pair", type: "address", indexed: true },
      { name: "power", type: "uint256", indexed: false },
    ],
  },
  // AUDIT R054 (R020/R021): commit-reveal vote path.
  {
    type: "event",
    name: "VoteCommitted",
    inputs: [
      { name: "user", type: "address", indexed: true },
      { name: "epoch", type: "uint256", indexed: true },
      { name: "commitIndex", type: "uint256", indexed: false },
      { name: "commitHash", type: "bytes32", indexed: false },
    ],
  },
  {
    type: "event",
    name: "VoteRevealed",
    inputs: [
      { name: "user", type: "address", indexed: true },
      { name: "epoch", type: "uint256", indexed: true },
      { name: "commitIndex", type: "uint256", indexed: false },
      { name: "pair", type: "address", indexed: true },
      { name: "power", type: "uint256", indexed: false },
    ],
  },
  // AUDIT R054 (NEW-G2): orphaned-bribe pull refund.
  {
    type: "event",
    name: "OrphanedBribeRefunded",
    inputs: [
      { name: "epoch", type: "uint256", indexed: true },
      { name: "pair", type: "address", indexed: true },
      { name: "token", type: "address", indexed: true },
      { name: "depositor", type: "address", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Paused",
    inputs: [{ name: "account", type: "address", indexed: false }],
  },
  {
    type: "event",
    name: "Unpaused",
    inputs: [{ name: "account", type: "address", indexed: false }],
  },
] as const;

const LPFarmingAbi = [
  {
    type: "event",
    name: "Staked",
    inputs: [
      { name: "user", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Withdrawn",
    inputs: [
      { name: "user", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "RewardPaid",
    inputs: [
      { name: "user", type: "address", indexed: true },
      { name: "reward", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Paused",
    inputs: [{ name: "account", type: "address", indexed: false }],
  },
  {
    type: "event",
    name: "Unpaused",
    inputs: [{ name: "account", type: "address", indexed: false }],
  },
] as const;

const TegridyLendingAbi = [
  {
    type: "event",
    name: "LoanOfferCreated",
    inputs: [
      { name: "offerId", type: "uint256", indexed: true },
      { name: "lender", type: "address", indexed: true },
      { name: "principal", type: "uint256", indexed: false },
      { name: "aprBps", type: "uint256", indexed: false },
      { name: "duration", type: "uint256", indexed: false },
      { name: "collateralContract", type: "address", indexed: false },
      { name: "minPositionValue", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "LoanAccepted",
    inputs: [
      { name: "loanId", type: "uint256", indexed: true },
      { name: "offerId", type: "uint256", indexed: true },
      { name: "borrower", type: "address", indexed: true },
      { name: "lender", type: "address", indexed: false },
      { name: "tokenId", type: "uint256", indexed: false },
      { name: "principal", type: "uint256", indexed: false },
      { name: "deadline", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "LoanRepaid",
    inputs: [
      { name: "loanId", type: "uint256", indexed: true },
      { name: "borrower", type: "address", indexed: true },
      { name: "principal", type: "uint256", indexed: false },
      { name: "interest", type: "uint256", indexed: false },
      { name: "protocolFee", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "DefaultClaimed",
    inputs: [
      { name: "loanId", type: "uint256", indexed: true },
      { name: "lender", type: "address", indexed: true },
      { name: "tokenId", type: "uint256", indexed: false },
    ],
  },
  // AUDIT R010: TimelockAdmin overloads (bytes32 key).
  {
    type: "event",
    name: "ProposalCreated",
    inputs: [
      { name: "key", type: "bytes32", indexed: true },
      { name: "executeAfter", type: "uint256", indexed: false },
      { name: "expiresAt", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "ProposalExecuted",
    inputs: [{ name: "key", type: "bytes32", indexed: true }],
  },
  {
    type: "event",
    name: "ProposalCancelled",
    inputs: [{ name: "key", type: "bytes32", indexed: true }],
  },
  {
    type: "event",
    name: "Paused",
    inputs: [{ name: "account", type: "address", indexed: false }],
  },
  {
    type: "event",
    name: "Unpaused",
    inputs: [{ name: "account", type: "address", indexed: false }],
  },
] as const;

const SwapFeeRouterAbi = [
  {
    type: "event",
    name: "SwapExecuted",
    inputs: [
      { name: "user", type: "address", indexed: true },
      { name: "tokenIn", type: "address", indexed: false },
      { name: "tokenOut", type: "address", indexed: false },
      { name: "amountIn", type: "uint256", indexed: false },
      { name: "fee", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Paused",
    inputs: [{ name: "account", type: "address", indexed: false }],
  },
  {
    type: "event",
    name: "Unpaused",
    inputs: [{ name: "account", type: "address", indexed: false }],
  },
] as const;

const CommunityGrantsAbi = [
  // AUDIT R010: explicit Solidity-signature notation in handlers. The grant
  // proposal lifecycle uses `uint256 id`; the inherited TimelockAdmin path
  // uses `bytes32 key`. Both must be tracked separately.
  {
    type: "event",
    name: "ProposalCreated",
    inputs: [
      { name: "id", type: "uint256", indexed: true },
      { name: "proposer", type: "address", indexed: true },
      { name: "recipient", type: "address", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
      { name: "description", type: "string", indexed: false },
    ],
  },
  {
    type: "event",
    name: "ProposalVoted",
    inputs: [
      { name: "id", type: "uint256", indexed: true },
      { name: "voter", type: "address", indexed: true },
      { name: "support", type: "bool", indexed: false },
      { name: "power", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "ProposalExecuted",
    inputs: [
      { name: "id", type: "uint256", indexed: true },
      { name: "recipient", type: "address", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  // AUDIT R010: explicit grant-lifecycle ProposalCancelled overload (uint256 id)
  // alongside the TimelockAdmin (bytes32 key) overload below.
  {
    type: "event",
    name: "ProposalCancelled",
    inputs: [{ name: "id", type: "uint256", indexed: true }],
  },
  // AUDIT R010: TimelockAdmin overloads (bytes32 key).
  {
    type: "event",
    name: "ProposalCreated",
    inputs: [
      { name: "key", type: "bytes32", indexed: true },
      { name: "executeAfter", type: "uint256", indexed: false },
      { name: "expiresAt", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "ProposalExecuted",
    inputs: [{ name: "key", type: "bytes32", indexed: true }],
  },
  {
    type: "event",
    name: "ProposalCancelled",
    inputs: [{ name: "key", type: "bytes32", indexed: true }],
  },
  {
    type: "event",
    name: "Paused",
    inputs: [{ name: "account", type: "address", indexed: false }],
  },
  {
    type: "event",
    name: "Unpaused",
    inputs: [{ name: "account", type: "address", indexed: false }],
  },
] as const;

const MemeBountyBoardAbi = [
  {
    type: "event",
    name: "BountyCreated",
    inputs: [
      { name: "id", type: "uint256", indexed: true },
      { name: "creator", type: "address", indexed: true },
      { name: "reward", type: "uint256", indexed: false },
      { name: "description", type: "string", indexed: false },
    ],
  },
  {
    type: "event",
    name: "BountyCompleted",
    inputs: [
      { name: "bountyId", type: "uint256", indexed: true },
      { name: "winner", type: "address", indexed: true },
      { name: "reward", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Paused",
    inputs: [{ name: "account", type: "address", indexed: false }],
  },
  {
    type: "event",
    name: "Unpaused",
    inputs: [{ name: "account", type: "address", indexed: false }],
  },
] as const;

// AUDIT R054: GaugeController — full surface (per Agent 084 IDX-H1).
const GaugeControllerAbi = [
  {
    type: "event",
    name: "Voted",
    inputs: [
      { name: "voter", type: "address", indexed: true },
      { name: "tokenId", type: "uint256", indexed: true },
      { name: "epoch", type: "uint256", indexed: true },
      { name: "gauges", type: "address[]", indexed: false },
      { name: "weights", type: "uint256[]", indexed: false },
    ],
  },
  {
    type: "event",
    name: "VoteCommitted",
    inputs: [
      { name: "voter", type: "address", indexed: true },
      { name: "tokenId", type: "uint256", indexed: true },
      { name: "epoch", type: "uint256", indexed: true },
      { name: "commitmentHash", type: "bytes32", indexed: false },
    ],
  },
  {
    type: "event",
    name: "VoteRevealed",
    inputs: [
      { name: "voter", type: "address", indexed: true },
      { name: "tokenId", type: "uint256", indexed: true },
      { name: "epoch", type: "uint256", indexed: true },
      { name: "gauges", type: "address[]", indexed: false },
      { name: "weights", type: "uint256[]", indexed: false },
    ],
  },
  {
    type: "event",
    name: "GaugeAddProposed",
    inputs: [
      { name: "gauge", type: "address", indexed: false },
      { name: "executeAfter", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "GaugeAdded",
    inputs: [{ name: "gauge", type: "address", indexed: false }],
  },
  {
    type: "event",
    name: "GaugeRemoveProposed",
    inputs: [
      { name: "gauge", type: "address", indexed: false },
      { name: "executeAfter", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "GaugeRemoved",
    inputs: [{ name: "gauge", type: "address", indexed: false }],
  },
  {
    type: "event",
    name: "EmissionBudgetProposed",
    inputs: [
      { name: "newBudget", type: "uint256", indexed: false },
      { name: "executeAfter", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "EmissionBudgetUpdated",
    inputs: [
      { name: "oldBudget", type: "uint256", indexed: false },
      { name: "newBudget", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Paused",
    inputs: [{ name: "account", type: "address", indexed: false }],
  },
  {
    type: "event",
    name: "Unpaused",
    inputs: [{ name: "account", type: "address", indexed: false }],
  },
] as const;

// AUDIT R054 (Agent 039 H-EVT-02 / Agent 084 IDX-H2): TegridyPair core DEX
// surface, subscribed via factory(TegridyFactory.PairCreated) so every
// child pair flows through automatically.
const TegridyPairAbi = [
  {
    type: "event",
    name: "Swap",
    inputs: [
      { name: "sender", type: "address", indexed: true },
      { name: "amount0In", type: "uint256", indexed: false },
      { name: "amount1In", type: "uint256", indexed: false },
      { name: "amount0Out", type: "uint256", indexed: false },
      { name: "amount1Out", type: "uint256", indexed: false },
      { name: "to", type: "address", indexed: true },
    ],
  },
  {
    type: "event",
    name: "Mint",
    inputs: [
      { name: "sender", type: "address", indexed: true },
      { name: "amount0", type: "uint256", indexed: false },
      { name: "amount1", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Burn",
    inputs: [
      { name: "sender", type: "address", indexed: true },
      { name: "amount0", type: "uint256", indexed: false },
      { name: "amount1", type: "uint256", indexed: false },
      { name: "to", type: "address", indexed: true },
    ],
  },
] as const;

// AUDIT R054: TegridyFactory.PairCreated — factory event used to enumerate
// child TegridyPair contracts at runtime.
const TegridyFactoryPairCreatedEvent = parseAbiItem(
  "event PairCreated(address indexed token0, address indexed token1, address pair, uint256 pairCount)",
);

// AUDIT R054: dedicated PausableOnly ABI for the 3 contracts that we want
// to watch ONLY for pause-state transitions (no other event surface yet).
const PausableOnlyAbi = [
  {
    type: "event",
    name: "Paused",
    inputs: [{ name: "account", type: "address", indexed: false }],
  },
  {
    type: "event",
    name: "Unpaused",
    inputs: [{ name: "account", type: "address", indexed: false }],
  },
] as const;

// ─── Config ──────────────────────────────────────────────────────────────────

// AUDIT INDEXER-M1: explicit RPC timeout + retry so a hung upstream doesn't
// stall indexer sync indefinitely. 30s is generous for mainnet eth_getLogs
// responses over a slow connection; 3 retries handles transient flakes.
const RPC_TRANSPORT_OPTS = { timeout: 30_000, retryCount: 3 } as const;

// AUDIT INDEXER-SEC: RPC fallback list. The previous config read a single
// PONDER_RPC_URL_1 env var and stalled hard if that one provider had an
// outage. Now we accept up to four URLs (PONDER_RPC_URL_1..4) and wrap them
// in viem's `fallback` transport so Ponder transparently rotates to the
// next when one fails. If no URLs are configured we fall back to viem's
// default public-node transport (only safe for local dev — public nodes
// rate-limit eth_getLogs aggressively).
const RPC_URLS = [
  process.env.PONDER_RPC_URL_1,
  process.env.PONDER_RPC_URL_2,
  process.env.PONDER_RPC_URL_3,
  process.env.PONDER_RPC_URL_4,
].filter((u): u is string => typeof u === "string" && u.length > 0);

if (RPC_URLS.length === 0 && process.env.NODE_ENV === "production") {
  console.warn(
    "[ponder] No PONDER_RPC_URL_1..4 configured; falling back to public RPC. " +
    "Set at least one authenticated RPC endpoint in your deploy env to avoid " +
    "rate-limit stalls on historical sync."
  );
}

const rpcTransport = RPC_URLS.length > 0
  ? fallback(RPC_URLS.map((url) => http(url, RPC_TRANSPORT_OPTS)))
  : http(undefined, RPC_TRANSPORT_OPTS);

// AUDIT INDEXER-OBS: Ponder's built-in HTTP server already exposes /health
// and /ready endpoints for liveness/readiness probes — no need to add our
// own. GraphQL is served on the same port (default 42069); lock it down at
// the reverse-proxy layer if running in a multi-tenant VPC. See
// https://ponder.sh/docs/advanced/self-hosting for the full surface.

// AUDIT R054: per-contract deploy blocks pulled from
// `contracts/broadcast/*/1/run-latest.json`. Replaces the prior shared
// `24500000` floor so historical sync skips ~316k blocks of empty
// responses for post-DeployV2 contracts. Two legacy contracts
// (TegridyFactory) keep the conservative 24500000 floor until ops verify
// their broadcast files.
const TEGRIDY_STAKING_START = 24808994; // DeployAuditFixes.s.sol/1/run-latest.json (C-01 fix redeploy)
const TEGRIDY_RESTAKING_START = 24816809; // DeployV2.s.sol/1/run-latest.json
const REVENUE_DISTRIBUTOR_START = 24816810; // DeployV2
const VOTE_INCENTIVES_START = 24816808; // DeployV2
const LP_FARMING_START = 24910270; // Wave 0 2026-04-18 redeploy (MAX_BOOST_BPS_CEILING=45000)
const TEGRIDY_LENDING_START = 24875534; // DeployV3Features
const SWAP_FEE_ROUTER_START = 24816811; // DeployV2
const COMMUNITY_GRANTS_START = 24816812; // DeployV2
const MEME_BOUNTY_BOARD_START = 24816814; // DeployV2
const POL_ACCUMULATOR_START = 24808997; // DeployAuditFixes
const PREMIUM_ACCESS_START = 24816815; // DeployV2
const TEGRIDY_NFT_LENDING_START = 24910182; // DeployNFTLending
const GAUGE_CONTROLLER_START = 24910192; // DeployGaugeController
const TEGRIDY_FACTORY_START = 24500000; // legacy — verify before tightening

export default createConfig({
  // AUDIT R005: Ponder 0.8.x expects top-level `networks` (not `chains`)
  // with entries shaped `{ chainId, transport }` (not `{ id, rpc }`). The
  // drift resolved the registry to `never` and broke the typecheck across
  // every handler in src/index.ts. See node_modules/ponder/dist/index.d.ts
  // L100-181.
  networks: {
    mainnet: {
      chainId: 1,
      transport: rpcTransport,
    },
  },
  contracts: {
    TegridyStaking: {
      abi: TegridyStakingAbi,
      network: "mainnet",
      // Canonical v2 (C-01 Spartan TF-01 fix migration) — the old
      // 0x65D8...a421 v1 is paused and has been superseded. See
      // docs/MIGRATION_HISTORY.md.
      address: "0x626644523d34B84818df602c991B4a06789C4819",
      startBlock: TEGRIDY_STAKING_START,
    },
    TegridyRestaking: {
      abi: TegridyRestakingAbi,
      network: "mainnet",
      address: "0xfba4D340759Ae4c36DfFC6C773D171bf7BDCaEe4",
      startBlock: TEGRIDY_RESTAKING_START,
    },
    RevenueDistributor: {
      abi: RevenueDistributorAbi,
      network: "mainnet",
      address: "0x332aaE555b1164eA45c2291fD7eDfa97aAA264D8",
      startBlock: REVENUE_DISTRIBUTOR_START,
    },
    VoteIncentives: {
      abi: VoteIncentivesAbi,
      network: "mainnet",
      address: "0x417F44aee21Cc709262e71A7fdF6028cc17eCf1A",
      startBlock: VOTE_INCENTIVES_START,
    },
    LPFarming: {
      abi: LPFarmingAbi,
      network: "mainnet",
      // Wave 0 2026-04-18: C-01 fix redeploy (MAX_BOOST_BPS_CEILING=45000)
      address: "0xa7EF711Be3662B9557634502032F98944eC69ec1",
      startBlock: LP_FARMING_START,
    },
    TegridyLending: {
      abi: TegridyLendingAbi,
      network: "mainnet",
      address: "0xd471e5675EaDbD8C192A5dA2fF44372D5713367f",
      startBlock: TEGRIDY_LENDING_START,
    },
    SwapFeeRouter: {
      abi: SwapFeeRouterAbi,
      network: "mainnet",
      address: "0xea13Cd47a37cC5B59675bfd52BFc8fF8691937A0",
      startBlock: SWAP_FEE_ROUTER_START,
    },
    CommunityGrants: {
      abi: CommunityGrantsAbi,
      network: "mainnet",
      address: "0x8f1Ba1eC97a932EE1332BA0f366BC6aDf60B3032",
      startBlock: COMMUNITY_GRANTS_START,
    },
    MemeBountyBoard: {
      abi: MemeBountyBoardAbi,
      network: "mainnet",
      address: "0x3457C2210be35bA7AF6F382a76247Ecd782BF0C9",
      startBlock: MEME_BOUNTY_BOARD_START,
    },
    // AUDIT R054 (Agent 084 IDX-H1): GaugeController full surface — was
    // commented "deferred"; gauge governance is core to value flow.
    GaugeController: {
      abi: GaugeControllerAbi,
      network: "mainnet",
      address: "0xb93264aB0AF377F7C0485E64406bE9a9b1df0Fdb",
      startBlock: GAUGE_CONTROLLER_START,
    },
    // AUDIT R054 (Agent 084 IDX-H2): TegridyPair via factory pattern —
    // every child pair is auto-tracked from `TegridyFactory.PairCreated`
    // without manual address bookkeeping. Without this DEX volume + TVL
    // is unrecoverable from indexer (frontend would have to fall back to
    // raw RPC and hit rate-limit cliffs under load).
    TegridyPair: {
      abi: TegridyPairAbi,
      network: "mainnet",
      address: factory({
        address: "0x8B786163aA3beb97822d480a0c306DfD6dEbdCB6",
        event: TegridyFactoryPairCreatedEvent,
        parameter: "pair",
      }),
      startBlock: TEGRIDY_FACTORY_START,
    },
    // AUDIT R054 (Agent 084 IDX-H4): pause-only filters for the 3
    // contracts whose only currently-relevant surface is the pause-state
    // transition. The frontend uses the pauseState table to render
    // protocol-paused banners.
    PremiumAccess_Pause: {
      abi: PausableOnlyAbi,
      network: "mainnet",
      address: "0xaA16dF3dC66c7A6aD7db153711329955519422Ad",
      startBlock: PREMIUM_ACCESS_START,
    },
    POLAccumulator_Pause: {
      abi: PausableOnlyAbi,
      network: "mainnet",
      address: "0x17215f0dfA5E97c33c025E0560eeddffaD87B7Ca",
      startBlock: POL_ACCUMULATOR_START,
    },
    TegridyNFTLending_Pause: {
      abi: PausableOnlyAbi,
      network: "mainnet",
      address: "0x05409880aDFEa888F2c93568B8D88c7b4aAdB139",
      startBlock: TEGRIDY_NFT_LENDING_START,
    },
  },
});
