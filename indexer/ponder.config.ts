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
  // AUDIT FIX 2026-05-26 [H-24]: canonical ERC-721 Transfer event. Solady
  // ERC721 emits this signature verbatim per EIP-721. Adding it to the
  // event-only ABI lets the indexer subscribe to staking-position NFT
  // transfers and update `stakingPosition.user` on secondary-market trades
  // / wallet rotations — pre-fix, "your positions" misattributed to the
  // original minter forever.
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "tokenId", type: "uint256", indexed: true },
    ],
  },
] as const;

// AUDIT M5 (2026-05-24): TegridyRestakingAbi removed — TegridyRestaking is
// DEFERRED to Phase 7 and is not in the MVP set. Subscription + handlers +
// exclusive schema tables (restakingPosition/restakingClaim/
// restakingAdminAction) were pruned alongside it.

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

// AUDIT M5 (2026-05-24): VoteIncentivesAbi and LPFarmingAbi removed — both
// contracts are non-MVP. Subscriptions + handlers + their exclusive schema
// tables (gaugeVote/bribeDeposit/bribeClaim/voteIncentives*/lpFarmAction)
// were pruned alongside them.

// AUDIT M5 (2026-05-24): TegridyLendingAbi removed — TegridyLending is
// non-MVP. Subscription + handlers + its exclusive schema tables
// (loanOffer/loan) were pruned alongside it.

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
  // Wave-2 (2026-05-20): sweepETH is now 48h-timelocked.
  // Mirror the sister POLAccumulator SweepETH* observability surface so
  // off-chain monitors see the full propose/execute/cancel lifecycle.
  {
    type: "event",
    name: "SweepETHProposed",
    inputs: [
      { name: "amount", type: "uint256", indexed: false },
      { name: "readyAt", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "SweepETHExecuted",
    inputs: [{ name: "amount", type: "uint256", indexed: false }],
  },
  {
    type: "event",
    name: "SweepETHCancelled",
    inputs: [],
  },
] as const;

// AUDIT M5 (2026-05-24): CommunityGrantsAbi, MemeBountyBoardAbi, and
// GaugeControllerAbi removed — all three contracts are non-MVP.
// Subscriptions + handlers + their exclusive schema tables
// (proposal/proposalVote, bounty, gauge/gaugeEvent/gaugeVoteCommit/
// gaugeVoteRevealed) were pruned alongside them.

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

// AUDIT (post-Batch-J sweep): TegridyFactory governance lifecycle. The
// guardian rotation timelock (Batch A, commit 393b084) emits a propose/execute/
// cancel triplet that the timelock UI needs to render the active queue.
// Pair-disable governance also emits PairDisableProposed/Executed.
const TegridyFactoryGovernanceAbi = [
  {
    type: "event",
    name: "GuardianSet",
    inputs: [
      { name: "oldGuardian", type: "address", indexed: true },
      { name: "newGuardian", type: "address", indexed: true },
    ],
  },
  {
    type: "event",
    name: "GuardianChangeProposed",
    inputs: [
      { name: "currentGuardian", type: "address", indexed: true },
      { name: "proposedGuardian", type: "address", indexed: true },
      { name: "executeAfter", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "GuardianChangeExecuted",
    inputs: [
      { name: "oldGuardian", type: "address", indexed: true },
      { name: "newGuardian", type: "address", indexed: true },
    ],
  },
  {
    type: "event",
    name: "GuardianChangeCancelled",
    inputs: [
      { name: "cancelled", type: "address", indexed: true },
    ],
  },
  {
    type: "event",
    name: "PairEmergencyDisabled",
    inputs: [
      { name: "pair", type: "address", indexed: true },
      { name: "by", type: "address", indexed: true },
    ],
  },
] as const;

// AUDIT (post-Batch-J sweep): TegridyTWAP rebootstrap visibility. Batch J
// (commit 5fad774) added DeviationBypassed so consumers can detect the
// rebootstrap window after >24h dormancy. Indexed table lets lending
// integrators query "was this pair rebootstrapped in the last hour?"
// efficiently instead of scanning logs.
const TegridyTWAPAbi = [
  {
    type: "event",
    name: "DeviationBypassed",
    inputs: [
      { name: "pair", type: "address", indexed: true },
      { name: "elapsed", type: "uint32", indexed: false },
      { name: "spotPrice0", type: "uint256", indexed: false },
      { name: "spotPrice1", type: "uint256", indexed: false },
    ],
  },
] as const;

// AUDIT (2026-04-26 splits, commits 99eaf9b + cb3d12b): TegridyStakingAdmin and
// SwapFeeRouterAdmin both inherit TimelockAdmin and emit the standard
// ProposalCreated/Executed/Cancelled events. Subscribing here lets the
// existing `timelockProposal` table track the admin lifecycle without needing
// per-triplet event handlers.
const TimelockAdminMinimalAbi = [
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
] as const;

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

// Wave-3 IDX-1: business-event ABIs for POLAccumulator, PremiumAccess, and
// TegridyLending. The pre-existing `*_Pause` subscriptions cover pause-state
// only; these new subscriptions capture the orphaned business events that
// wave-3 verification surfaced as unindexed. Handlers live in src/index.ts
// and currently emit console.log traces; future schema additions can wire
// these into typed DB rows without changing the subscription shape.
const POLAccumulatorBusinessAbi = [
  {
    type: "event",
    name: "Accumulated",
    inputs: [
      { name: "ethUsed", type: "uint256", indexed: false },
      { name: "toweliAdded", type: "uint256", indexed: false },
      { name: "lpCreated", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "ETHReceived",
    inputs: [
      { name: "sender", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "SweepETHExecuted",
    inputs: [
      { name: "recipient", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "POLHarvestExecuted",
    inputs: [
      { name: "lpAmount", type: "uint256", indexed: false },
      { name: "tokenOut", type: "uint256", indexed: false },
      { name: "ethOut", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "SweepTokensExecuted",
    inputs: [
      { name: "token", type: "address", indexed: true },
      { name: "recipient", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "TreasuryChanged",
    inputs: [
      { name: "oldTreasury", type: "address", indexed: true },
      { name: "newTreasury", type: "address", indexed: true },
    ],
  },
] as const;

// AUDIT M5 (2026-05-24): PremiumAccessBusinessAbi removed — PremiumAccess is
// non-MVP (both its _Pause and _Business subscriptions were pruned). The
// _Business handlers were stub `logEvent` traces with no schema tables, so
// no DB table removal was required for it.

// CodeQL-renamed `TegridyLendingAbiV2` block was DELETED post-merge: it was
// a duplicate of the pre-existing `TegridyLendingAbi` (line ~390) plus four
// new events. The four new events are now merged into the pre-existing
// declaration above; the duplicate-ABI + duplicate-subscription that the
// merge introduced have been removed to keep Ponder from crashing on
// "duplicate handler" at startup. See indexer/src/index.ts where the
// four new handlers (LoanOfferCancelled, EscrowRewardsPaid,
// CollateralStuck, StuckCollateralClaimed) attach to the canonical
// `TegridyLending` subscription.

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
// own. GraphQL is served on the same port (default 42069).
//
// AUDIT M3 (2026-05-24) — GraphQL serve hardening / OPERATOR RUNBOOK:
// Ponder's HTTP server has NO built-in authentication and NO rate-limiting;
// `ponder serve` (and dev/start) expose the GraphQL API openly on the bound
// port. This is an ops/reverse-proxy responsibility — it CANNOT be fully
// solved in indexer code. Mandatory deploy requirements:
//   1. NEVER expose the Ponder HTTP port directly to the public internet.
//   2. Put the endpoint behind a reverse proxy / API gateway (nginx,
//      Cloudflare, etc.) that enforces request + connection RATE-LIMITING.
//   3. If the API is meant to be private, the proxy MUST enforce AUTH
//      (Ponder provides none).
// Defense-in-depth that IS done in code: src/api/index.ts re-mounts the
// GraphQL middleware with tightened query depth/alias/token limits (see that
// file). Those limits cap query complexity but do NOT rate-limit or
// authenticate — the proxy controls above are still required.
// See https://ponder.sh/docs/advanced/self-hosting for the full surface.

// AUDIT R054: per-contract deploy blocks pulled from
// `contracts/broadcast/*/1/run-latest.json`. Replaces the prior shared
// `24500000` floor so historical sync skips ~316k blocks of empty
// responses for post-DeployV2 contracts. Two legacy contracts
// (TegridyFactory) keep the conservative 24500000 floor until ops verify
// their broadcast files.
const TEGRIDY_STAKING_START = 24808994; // DeployAuditFixes.s.sol/1/run-latest.json (C-01 fix redeploy)
const REVENUE_DISTRIBUTOR_START = 24816810; // DeployV2
const SWAP_FEE_ROUTER_START = 24816811; // DeployV2
const POL_ACCUMULATOR_START = 24808997; // DeployAuditFixes
const TEGRIDY_FACTORY_START = 24500000; // legacy — verify before tightening
// AUDIT M5 (2026-05-24): start-block consts for removed non-MVP subscriptions
// (TegridyRestaking/VoteIncentives/LPFarming/TegridyLending/CommunityGrants/
// MemeBountyBoard/GaugeController/PremiumAccess/TegridyNFTLending) were pruned
// alongside their subscriptions.

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
    // AUDIT M5 (2026-05-24): TegridyRestaking subscription removed —
    // DEFERRED to Phase 7, not in the MVP set.
    RevenueDistributor: {
      abi: RevenueDistributorAbi,
      network: "mainnet",
      address: "0x332aaE555b1164eA45c2291fD7eDfa97aAA264D8",
      startBlock: REVENUE_DISTRIBUTOR_START,
    },
    // AUDIT M5 (2026-05-24): VoteIncentives, LPFarming, and TegridyLending
    // subscriptions removed — all three are non-MVP.
    SwapFeeRouter: {
      abi: SwapFeeRouterAbi,
      network: "mainnet",
      address: "0xea13Cd47a37cC5B59675bfd52BFc8fF8691937A0",
      startBlock: SWAP_FEE_ROUTER_START,
    },
    // AUDIT M5 (2026-05-24): CommunityGrants, MemeBountyBoard, and
    // GaugeController subscriptions removed — all three are non-MVP.
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
    // AUDIT R054 (Agent 084 IDX-H4): pause-only filter for POLAccumulator,
    // whose only currently-relevant surface is the pause-state transition.
    // The frontend uses the pauseState table to render protocol-paused
    // banners.
    // AUDIT M5 (2026-05-24): PremiumAccess_Pause and TegridyNFTLending_Pause
    // subscriptions removed — both contracts are non-MVP.
    POLAccumulator_Pause: {
      abi: PausableOnlyAbi,
      network: "mainnet",
      address: "0x17215f0dfA5E97c33c025E0560eeddffaD87B7Ca",
      startBlock: POL_ACCUMULATOR_START,
    },
    // Wave-3 IDX-1: business-event subscription for POLAccumulator (was
    // previously pause-only). Handlers in src/index.ts emit console.log
    // traces today; a future PR can wire them into typed DB rows.
    // AUDIT M5 (2026-05-24): PremiumAccess_Business subscription removed —
    // PremiumAccess is non-MVP.
    POLAccumulator_Business: {
      abi: POLAccumulatorBusinessAbi,
      network: "mainnet",
      address: "0x17215f0dfA5E97c33c025E0560eeddffaD87B7Ca",
      startBlock: POL_ACCUMULATOR_START,
    },
    // AUDIT (post-Batch-J sweep): track TegridyFactory governance lifecycle.
    // Separate from the TegridyPair factory subscription above (which uses the
    // PairCreated event to enumerate child contracts). This entry tracks the
    // factory's OWN governance events.
    TegridyFactory_Governance: {
      abi: TegridyFactoryGovernanceAbi,
      network: "mainnet",
      address: "0x8B786163aA3beb97822d480a0c306DfD6dEbdCB6",
      startBlock: TEGRIDY_FACTORY_START,
    },
    // AUDIT (post-Batch-J sweep): TegridyTWAP rebootstrap detection.
    TegridyTWAP: {
      abi: TegridyTWAPAbi,
      network: "mainnet",
      address: "0xddbe4cd58faf4b0b93e4e03a2493327ee3bb4995",
      startBlock: TEGRIDY_FACTORY_START,
    },
    // AUDIT (2026-04-26 split, commit 99eaf9b): TegridyStakingAdmin sister
    // contract. Holds all 7 timelocked admin triplets after the EIP-170
    // split. ProposalCreated/Executed/Cancelled events fire from here, NOT
    // from the parent TegridyStaking.
    //
    // OPERATOR TODO: replace 0x000... with the deployed TegridyStakingAdmin
    // address after running the deploy script + setStakingAdmin wiring.
    // Until then, this subscription is a no-op (matches no logs).
    TegridyStakingAdmin: {
      abi: TimelockAdminMinimalAbi,
      network: "mainnet",
      address: (process.env.TEGRIDY_STAKING_ADMIN_ADDRESS as `0x${string}` | undefined)
        ?? "0x0000000000000000000000000000000000000000",
      startBlock: TEGRIDY_STAKING_START,
    },
    // AUDIT (2026-04-26 split, commit cb3d12b): SwapFeeRouterAdmin sister
    // contract. Holds all 9 timelocked admin triplets after the EIP-170
    // split. ProposalCreated/Executed/Cancelled events fire from here, NOT
    // from the parent SwapFeeRouter.
    //
    // OPERATOR TODO: replace 0x000... with the deployed SwapFeeRouterAdmin
    // address after running the deploy script + setSwapFeeRouterAdmin wiring.
    SwapFeeRouterAdmin: {
      abi: TimelockAdminMinimalAbi,
      network: "mainnet",
      address: (process.env.SWAP_FEE_ROUTER_ADMIN_ADDRESS as `0x${string}` | undefined)
        ?? "0x0000000000000000000000000000000000000000",
      startBlock: SWAP_FEE_ROUTER_START,
    },
  },
});
