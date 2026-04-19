import { createConfig } from "ponder";
import { http } from "viem";

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
] as const;

const CommunityGrantsAbi = [
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
] as const;

// ─── Config ──────────────────────────────────────────────────────────────────

// AUDIT INDEXER-M1: explicit RPC timeout + retry so a hung upstream doesn't
// stall indexer sync indefinitely. 30s is generous for mainnet eth_getLogs
// responses over a slow connection; 3 retries handles transient flakes.
const RPC_TRANSPORT_OPTS = { timeout: 30_000, retryCount: 3 } as const;

export default createConfig({
  chains: {
    mainnet: {
      id: 1,
      rpc: process.env.PONDER_RPC_URL_1
        ? http(process.env.PONDER_RPC_URL_1, RPC_TRANSPORT_OPTS)
        : http(undefined, RPC_TRANSPORT_OPTS),
    },
  },
  contracts: {
    TegridyStaking: {
      abi: TegridyStakingAbi,
      chain: "mainnet",
      // Canonical v2 (C-01 Spartan TF-01 fix migration) — the old
      // 0x65D8...a421 v1 is paused and has been superseded. See
      // docs/MIGRATION_HISTORY.md.
      address: "0x626644523d34B84818df602c991B4a06789C4819",
      startBlock: 24500000,
    },
    TegridyRestaking: {
      abi: TegridyRestakingAbi,
      chain: "mainnet",
      address: "0xfba4D340759Ae4c36DfFC6C773D171bf7BDCaEe4",
      startBlock: 24500000,
    },
    RevenueDistributor: {
      abi: RevenueDistributorAbi,
      chain: "mainnet",
      address: "0x332aaE555b1164eA45c2291fD7eDfa97aAA264D8",
      startBlock: 24500000,
    },
    VoteIncentives: {
      abi: VoteIncentivesAbi,
      chain: "mainnet",
      address: "0x417F44aee21Cc709262e71A7fdF6028cc17eCf1A",
      startBlock: 24500000,
    },
    LPFarming: {
      abi: LPFarmingAbi,
      chain: "mainnet",
      // Wave 0 2026-04-18: C-01 fix redeploy (MAX_BOOST_BPS_CEILING=45000)
      address: "0xa7EF711Be3662B9557634502032F98944eC69ec1",
      startBlock: 24910270,
    },
    TegridyLending: {
      abi: TegridyLendingAbi,
      chain: "mainnet",
      address: "0xd471e5675EaDbD8C192A5dA2fF44372D5713367f",
      startBlock: 24500000,
    },
    SwapFeeRouter: {
      abi: SwapFeeRouterAbi,
      chain: "mainnet",
      address: "0xea13Cd47a37cC5B59675bfd52BFc8fF8691937A0",
      startBlock: 24500000,
    },
    CommunityGrants: {
      abi: CommunityGrantsAbi,
      chain: "mainnet",
      address: "0x8f1Ba1eC97a932EE1332BA0f366BC6aDf60B3032",
      startBlock: 24500000,
    },
    MemeBountyBoard: {
      abi: MemeBountyBoardAbi,
      chain: "mainnet",
      address: "0x3457C2210be35bA7AF6F382a76247Ecd782BF0C9",
      startBlock: 24500000,
    },
    // MemeBountyBoardExtras + CommunityGrantsExtras + GaugeController
    // registrations deferred — see handler notes in src/index.ts.
  },
});
