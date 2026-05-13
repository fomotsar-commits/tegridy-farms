# Changelog

All notable changes to Tegriddy Farms are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Ongoing investor-polish and audit-closure work. Lands on `main` as it ships;
a tagged release will cut from here once Wave 0 redeploys are complete.

### Security — Monster Audit + adversarial sweep (2026-05-09 → 2026-05-10)

7-cluster fresh-eyes adversarial audit on the post-scan6 codebase plus a
post-fix adversarial sweep on the just-shipped batches. Surfaced **13 NEW
findings** atop the ~693 cumulative prior-pass closures (3 HIGH + 5 MEDIUM
+ 3 LOW + 1 INFO on-chain; 3 HIGH + 2 MEDIUM off-chain) **plus 3 fresh
regressions** caught by the post-fix sweep in batches 1+2. Total **16/16
findings closed** across 5 batch commits on `claude/festive-hofstadter-92bccd`.

Per the minimal-surface mandate: every fix is sibling-canonical or
deletion-only. Custom code additions across the entire batch lineage:
~6 LoC (typed errors + helper flags). Everything else is a verbatim port.

Full per-finding ledger:
[`FIX_STATUS.md` § Monster Audit](FIX_STATUS.md#-monster-audit-2026-05-09--2026-05-10).

Highlights:
- **F1** (HIGH) RevenueDistributor ex-restaker silent loss — dropped the
  `_isRestaker` short-circuit, gated `claimedAtEpoch` seal on
  `userPower > 0`. Pattern: Curve `FeeDistributor.claim`.
- **F-LD** (HIGH) TegridyLending pullEscrowRewards cross-loan drain —
  pull-then-cap pattern (Aave V3): pull to lending, transfer
  `min(received, escrowRewardsOwed[loanId])` to recipient, excess feeds
  the legacy pro-rata path.
- **F10** (MED) Orderbook Seaport fill verification structurally
  broken — pre-fix `topics[1]` matched the indexed offerer (not the
  orderHash). Added migration `005_add_seaport_order_hash.sql` storing
  Seaport's canonical EIP-712 OrderComponents hash; ABI-decode of
  OrderFulfilled's `data` field for verification.
- **Frontend hardening** — JWT revocation fail-closed in prod/preview
  (Auth0 / Okta pattern); CORS allowlist consolidation across 8 endpoints
  (Vercel next-cors / AWS API Gateway pattern); shared cookie builder
  module (Express `res.clearCookie()` flag-mirror).

Post-fix adversarial sweep run on the new code (5 parallel agents): clean
verdict across all attack surfaces. F-FRESH-1 / F-FRESH-2 (frontend
NODE_ENV/VERCEL_ENV gates) + F3-PERMA-STRIP (`lookupOk` flag preserves
cached `hasJbacBoost` on transient restaking-lookup failure) all surfaced
and closed in the same lineage.

Test posture:
- **Foundry: 2593 / 2593 passing** across 149 suites (3 independent
  sweeps, identical results)
- **Frontend vitest: 191 / 191 passing** across 14 files
- 4 new Foundry PoC regression tests under
  [`contracts/test/FRESH2026_*.t.sol`](contracts/test/)
- 22-test vitest regression suite at
  [`frontend/api/__tests__/orderbook.fill.test.js`](frontend/api/__tests__/orderbook.fill.test.js)

Battle-tested anchors per category:
| Class | Canonical reference |
|---|---|
| Reward distribution | Curve `FeeDistributor` |
| Pull-then-cap | Aave V3 pull-pattern |
| EIP-712 struct hashing | Seaport SDK `getOrderHash` / viem `hashStruct` |
| JWT prod-token requirements | Auth0 / Okta `jti` mandatory |
| CORS allowlist | Vercel next-cors / AWS API Gateway / Cloudflare |
| Cookie clear/issue symmetry | Express `res.clearCookie()` |
| L2 sequencer staleness | Aave V3 `PriceOracleSentinel` |
| ERC721-bounded callbacks | Nomad ExcessivelySafeCall |
| EIP-7702 detection | `code.length == 23` carve-out (post-Pectra) |

Per `AUDITS.md` honest TL;DR, the in-house adversarial budget has reached
saturation across 8 prior passes + scan2-scan8 + this monster-audit
lineage. The documented next escalation is a paid human audit firm
(OpenZeppelin / Trail of Bits / Spearbit / Cyfrin / Code4rena).


### Security — pass-8 adversarial 100-agent audit + remediation (2026-05-04 → ongoing)

100-agent fresh-eye adversarial pass run end-to-end against the full source
tree (no prior-audit-doc consultation), organized as five waves: 30 per-contract
deep audits + 40 vulnerability-class scans + 15 cross-contract integration
audits + 10 economic / MEV / game-theory + 5 specialized (compiler / toolchain
/ size / test-coverage / latest-2026-exploit-pattern web research). Surfaced
**~675 raw findings → ~275 unique after dedup**, with **10 Critical / ~140 High
/ ~165 Medium / ~110 Low / ~250 Info**. Master report and full per-agent output:
[`.audit_101/PASS8_2026_05_04.md`](./.audit_101/PASS8_2026_05_04.md).

Remediation organized into 6 phases. Owner-trust findings (admin treasury
rotation, captured-key drain paths, single-key pause, etc.) deferred to Phase 6
per multisig-policy lane.

#### Pass-8 Batch 1 — additive foundations (2026-05-05)

Lowest-blast-radius fixes that unblock later phases. All additive — no edits
to existing function logic, no breaking ABI changes, no semantic shifts.

- **LD-04** — `TegridyNFTLending` now floors `createOffer._principal` at
  `MIN_PRINCIPAL = 0.001 ether`, mirroring [`TegridyLending.minPrincipal`](contracts/src/TegridyLending.sol#L190).
  Pre-fix, sub-2000-wei principals made both `MIN_INTEREST_PRINCIPAL_BPS`
  and the duration-based interest floor round to zero, enabling free
  same-block flash-loan round-trips against dust offers. Closed at
  [TegridyNFTLending.sol:351-357](contracts/src/TegridyNFTLending.sol#L351)
  + new constant
  [TegridyNFTLending.sol:38-46](contracts/src/TegridyNFTLending.sol#L38)
  + new `PrincipalTooSmall` error
  [TegridyNFTLending.sol:262-263](contracts/src/TegridyNFTLending.sol#L262).
- **GOV-ECON-01 (a.k.a. C10) — foundation layer** — added new
  [`contracts/src/lib/VotePowerOracle.sol`](contracts/src/lib/VotePowerOracle.sol)
  (`internal` library, no deploy footprint) that sums staking-side and
  restaking-side voting power into a single read. Pattern reference:
  Frax veFXS + Convex `veFXSStrategy`. Plus
  [`TegridyRestaking.votingPowerOf`](contracts/src/TegridyRestaking.sol)
  /
  [`votingPowerAtTimestamp`](contracts/src/TegridyRestaking.sol)
  aliases delegating to the existing `_boostedAmountAt` lazy-decay-safe
  reader (preserves DEEP-DR-04 / DR2-02 / autoMaxLock carve-outs verbatim).
  Library + aliases are additive only — no consumer is wired yet. Batch 2
  will rewire `GaugeController` / `VoteIncentives` / `MemeBountyBoard` /
  `CommunityGrants` / `ReferralSplitter` / `RevenueDistributor` to use
  `VotePowerOracle.powerAt(...)` in place of the staking-side-only reads
  that silently disenfranchise restakers across all four governance
  consumers today.
- **EIP170-01/02/03/04 — CI infrastructure** — bytecode size-budget
  guard added to
  [`.github/workflows/contracts-ci.yml`](.github/workflows/contracts-ci.yml).
  Enforces a 24,000-byte safety floor (576-byte EIP-170 headroom) on
  every src/ contract; the four currently-overflowing contracts
  (`TegridyLending` 27,242 / `TegridyStaking` 26,912 / `VoteIncentives`
  25,977 / `TegridyRestaking` 24,011) are tracked-exception warnings until
  Phase 0 contract-splits land. Build step also split: compile-only first
  (real errors block), then size-budget step (with allowlist), so CI no
  longer dies on `forge build --sizes` before anything else gets a chance
  to run.

#### Pass-8 Batch 2 — restaker disenfranchisement closed across 6 governance consumers (2026-05-05)

Wires [`lib/VotePowerOracle`](contracts/src/lib/VotePowerOracle.sol) into
every governance / fee-eligibility consumer so a user who restakes their
staking NFT (custody → `TegridyRestaking`) is no longer silently
disenfranchised. Pre-fix, the restaker's per-owner enumerable set in
TegridyStaking went to zero AND a 0-checkpoint was written at deposit
time, making `staking.votingPower*(restaker)` return 0 across the board.
Five of six consumers had no fallback at all; the sixth used an
OR-fallback that silently dropped restaked share for multi-NFT holders.

Per-consumer changes (each adds a `restakingContract` state var + `onlyOwner`
one-shot `setRestakingContract(address)` setter, mirroring the
`setSequencerFeed` pattern in SwapFeeRouter; existing call sites switched
from direct `staking.votingPower*` reads to `VotePowerOracle.power*` so
power becomes additive across staking + restaking):

- **REV-RESTAKE-01** — `RevenueDistributor._calculateClaim`: changed the
  OR-fallback `if (userPower == 0 && isRestaker)` to additive `if (isRestaker)
  userPower += _restakedPowerAt(...)`. Multi-NFT holders (direct NFT-A staked
  + NFT-B restaked) no longer have the restaked share silently dropped when
  staking-side power happens to be non-zero. Closed at
  [RevenueDistributor.sol:741-754](contracts/src/RevenueDistributor.sol#L741).
- **GOV-ECON-01 / C10** — `ReferralSplitter._recordReferralFee` /
  `markBelowStake` / `forfeitUnclaimedRewards`: every
  `stakingContract.votingPowerOf(referrer)` read (3 sites) now additively
  includes restaked power via a parallel try/catch on
  `IRestakingForReferral(restakingContract).votingPowerOf`. A referrer who
  restakes their staking NFT no longer fails the `MIN_REFERRAL_STAKE_POWER`
  gate. Closed at
  [ReferralSplitter.sol:373-389](contracts/src/ReferralSplitter.sol#L373) +
  [:618-632](contracts/src/ReferralSplitter.sol#L618) +
  [:651-666](contracts/src/ReferralSplitter.sol#L651).
- **GOV-ECON-01 / C10** — `MemeBountyBoard.submitWork` /
  `voteForSubmission`: switched both vote-power read sites to
  `VotePowerOracle.powerAt` / `.powerOf` so restakers can submit and vote
  again. Closed at
  [MemeBountyBoard.sol:419-426](contracts/src/MemeBountyBoard.sol#L419) +
  [:466-475](contracts/src/MemeBountyBoard.sol#L466).
- **GOV-ECON-01 / C10** — `CommunityGrants.voteOnProposal`: vote-power
  read switched to additive (preserves DEEP-GOV-01 min-clamp). Closed at
  [CommunityGrants.sol:417-426](contracts/src/CommunityGrants.sol#L417).
- **GOV-ECON-01 / C10** — `GaugeController.vote` / `revealVote`: both
  vote-power sites switched to additive. Closed at
  [GaugeController.sol:317-326](contracts/src/GaugeController.sol#L317) +
  [:572-581](contracts/src/GaugeController.sol#L572).
- **GOV-ECON-01 / C10** — `VoteIncentives.vote` / `commitVote`: both
  vote-power sites switched to additive. Closed at
  [VoteIncentives.sol:506-516](contracts/src/VoteIncentives.sol#L506) +
  [:1373-1382](contracts/src/VoteIncentives.sol#L1373).

`VotePowerOracle` library was also refactored from typed-interface
parameters to plain `address` parameters so each consumer can keep its own
local staking interface name (`IVotingEscrow`, `ITegridyStakingGauge`,
`IStakingVote`, `IVotingEscrowGrants`) without forcing a cross-cutting
interface rename. Library is `internal`-linkage only; functions inline
into every consumer with negligible deploy-footprint overhead.

Operational note: after deploy, owner must call `setRestakingContract` on
each of the 5 consumers that didn't already have a restaking pointer. The
setter is one-shot, so a future restaking-contract migration would require
a fresh consumer deploy — same liability budget as the existing one-shot
setters in the codebase. The guard fails closed: a consumer with
`restakingContract == address(0)` reads only the staking side (current
behavior) until the setter fires.

#### Pass-8 Batch 3 — surgical exploit-by-anyone fixes across 5 contracts (2026-05-05)

Five fixes touching disjoint files (NFTPoolFactory / NFTLending / Lending /
MemeBountyBoard / NFTPool) — minimizes interaction risk while closing 1
Critical, 1 High, and 3 Mediums reachable by any user without special
permissions.

- **C5 / LOOP-01** — `TegridyNFTPoolFactory`: hard cap on
  `_poolsByCollection[c].length` at `MAX_POOLS_PER_COLLECTION = 200`, plus
  raised `MIN_DEPOSIT` floor from 0.01 ETH to 0.05 ETH. Pre-fix, an attacker
  could spam `createPool` for a target collection (≤0.01 ETH each) until the
  per-collection list exceeded the eth_call gas budget, bricking router
  discovery (`getBestBuyPool` / `getBestSellPool`) and any aggregator that
  depends on enumeration. The combo (count cap + raised cost floor) raises
  the spam attack from ~$5k to ~$25k per collection AND structurally caps
  the worst case. Pattern reference: Sudoswap V2's per-collection pool
  ceiling. Closed at
  [TegridyNFTPoolFactory.sol:43-67](contracts/src/TegridyNFTPoolFactory.sol#L43)
  +
  [:188-198](contracts/src/TegridyNFTPoolFactory.sol#L188).
- **NFTLEND-WL-1** — `TegridyNFTLending.proposeWhitelistCollection`:
  `IERC165.supportsInterface(0x80ac58cd)` preflight added to reject EOAs and
  contracts that don't claim ERC721 support. Wrapped in try/catch so legacy
  pre-ERC165 ERC721s (CryptoPunks v1, Sandbox v1) are still admittable;
  the typo / malicious-paste case where `_collection` is a non-ERC721 (e.g.
  an ERC20 or an arbitrary EOA) is rejected at propose-time, before the 24h
  timelock burns. Pattern reference: standard OZ ERC165 detection. Closed
  at
  [TegridyNFTLending.sol:945-967](contracts/src/TegridyNFTLending.sol#L945).
- **GAS-01** — new
  [`contracts/src/lib/SafeERC721Call.sol`](contracts/src/lib/SafeERC721Call.sol)
  library + applied to `_safeOutboundTransfer` (NFTLending) and
  `_safeOutboundTransferStaking` (Lending). Pre-fix, Solidity's `try/catch`
  ALWAYS performs `returndatacopy(0, 0, returndatasize())` before the catch
  block fires — the `gas:` modifier bounds inner gas but does NOT bound the
  copy. A malicious whitelisted ERC721 returning 16 MB of returndata
  OOG-griefs every caller, bricking `claimDefault` /
  `claimStuckCollateral` permanently and causing total lender principal
  loss. The library uses inline assembly to cap returndata at 0 bytes
  (`safeTransferFromBounded` — return value unused) and 32 bytes
  (`safeOwnerOfBounded` — single address). Pattern references: Nomad's
  `ExcessivelySafeCall`, Solady's `LibCall.callContract`. Library is
  `internal`-linkage only (~85 bytes deployed footprint). Closed at
  [TegridyNFTLending.sol:781-812](contracts/src/TegridyNFTLending.sol#L781) +
  [TegridyLending.sol:1170-1199](contracts/src/TegridyLending.sol#L1170).
- **MBB-VOTE-01** — `MemeBountyBoard.voteForSubmission`: any voter who has
  submitted ANY work to the same bounty is now disqualified from voting on
  ANY submission in that bounty (was: only blocked from voting on OWN
  submission). Pre-fix, three colluding submitters (A, B, C) could each
  submit then cross-vote a confederate's submission (A→B, B→C, C→A) and
  trivially clear `MIN_UNIQUE_VOTERS=3` quorum without any honest voters.
  One-line check via the existing `hasSubmitted[bountyId][voter]` map.
  Closed at
  [MemeBountyBoard.sol:471-477](contracts/src/MemeBountyBoard.sol#L471).
- **CLK-02** — `TegridyNFTPool` cooldowns: every `block.number`-based gate
  (`lastSwapBlock`, `lastWithdrawBlock`, `WITHDRAW_NFT_COOLDOWN_BLOCKS=50`)
  switched to `block.timestamp` semantics. Pre-fix, the "50-block ≈ 10
  minute" cooldown comment held only on Ethereum mainnet (12s blocks).
  On Optimism / Base / opBNB (`block.number` is L2 ≈ 2s/block), 50 blocks
  collapsed to ~100 seconds — a 6× degradation that let an owner sandwich
  trader liquidity in a fraction of the intended window. Constant value
  changed from 50 (blocks) to 600 (seconds = 10 minutes); storage and
  constant NAMES preserved for ABI continuity (autogenerated getters
  still respond at the same selectors). To be renamed in the next major
  version. Pattern reference: Aave v3 timestamp-based cooldowns universally.
  Closed at
  [TegridyNFTPool.sol:45-83](contracts/src/TegridyNFTPool.sol#L45) +
  every read/write site.

Bytecode deltas:
- TegridyNFTPoolFactory: 10,097 → 10,267 (+170)
- TegridyNFTLending: 17,390 → 18,773 (+1,383 — IERC165 import + assembly inlining)
- TegridyLending: 27,242 → 28,177 (+935 — assembly inlining; Phase 0 split now MORE urgent)
- MemeBountyBoard: 14,634 → 14,681 (+47)
- TegridyNFTPool: 11,561 (unchanged — semantic-only refactor)
- New SafeERC721Call: 85 bytes deployed (internal library, inlines)

#### Pass-8 Batch 4 — Phase 0.1: TegridyLending → TegridyLending + TegridyLendingAdmin split (2026-05-05)

EIP-170 unblock for the largest size offender. TegridyLending was 28,177 bytes
of runtime bytecode (3,601 bytes over the 24,576 EIP-170 mainnet limit) AFTER
the batch 3 GAS-01 / SafeERC721Call addition. Splitting the propose/execute/
cancel/pending-state surface out into a sister contract — mirroring the precise
pattern used for SwapFeeRouterAdmin in the 2026-04-26 size-reduction sprint —
brought TegridyLending down to **17,658 bytes (saved 10,519, 6,342-byte EIP-170
headroom)**.

- **EIP170-01** — new
  [`contracts/src/TegridyLendingAdmin.sol`](contracts/src/TegridyLendingAdmin.sol)
  (574 LoC) holds the timelock propose/execute/cancel triplets + `pending*`
  storage + `*Proposed` / `*Cancelled` events for **11 parameter groups**
  (protocol fee, treasury, max principal, max APR, min duration, max duration,
  origination fee, min APR, min principal, sweep donated TOWELI, accepted
  collateral whitelist). Inherits `OwnableNoRenounce + TimelockAdmin`.
  Constructor takes the lending address; reads validation constants
  (ceilings, floors) and current values from lending via interface
  (`MAX_PROTOCOL_FEE_BPS()`, `protocolFeeBps()`, `maxAprBps()`, etc.).
- **TegridyLending changes** —
  removed `TimelockAdmin` inheritance; removed all 11 admin parameter group
  triplets (33 functions) + their `pending*` storage + `*Proposed` / `*Cancelled`
  events + view-helper `*ChangeReadyAt()` getters; added `address public lendingAdmin`
  one-shot setter, `onlyAdmin` modifier, and 11 `applyXxx*` setters that admin
  calls after consuming a timelocked proposal. Each `applyXxx*` re-validates
  against the local constant ceilings/floors as defense in depth (same checks
  the admin performed pre-call).
- **Cross-contract reads** — `TegridyLending.createOffer` previously read
  `pendingAcceptedCollateral`, `pendingAcceptedCollateralAdd`, and
  `_executeAfter[ACCEPTED_COLLATERAL_CHANGE]` directly to short-circuit offer
  creation against pending-removal collaterals. Replaced with a single
  `lendingAdmin.acceptedCollateralRemovalPending(_collateralContract)` view
  call. Reverts with `LendingAdminNotSet` if called pre-`setLendingAdmin`.
- **Cancel-rate-limit invariant preserved** — LD3-M3 cancel-rate-limit on
  REMOVAL proposals was previously a single-contract storage read; now split
  across both contracts (admin invokes
  `lending.bumpCollateralRemovalRetryCount(coll)` on each live cancel; the
  reset-on-successful-removal still happens inside `applyAcceptedCollateralChange`).
- **CI guard** — TegridyLending removed from the bytecode-budget exception
  list in
  [`.github/workflows/contracts-ci.yml`](.github/workflows/contracts-ci.yml).
  Future regressions over 24,000 bytes hard-fail CI.

Operational note: after deploy, owner must call `lending.setLendingAdmin(adminAddr)`
(one-shot, set-once-immutable thereafter) before any user can create an offer.
Setter requires the admin to be a contract (`code.length > 0`) — the
`require()` precludes wiring an EOA. Admin contract owner is independent of
lending owner; both must point at the trusted multisig.

Pattern reference: identical shape to `SwapFeeRouter` ↔ `SwapFeeRouterAdmin`
already in production. Compound v2 Comptroller + ComptrollerStorage uses the
same separation; Aave v3 splits Pool from PoolConfigurator on the same
principle. Both have billions of TVL and have never been compromised via the
split surface.

Bytecode deltas:
- TegridyLending: **28,177 → 17,658 (saved 10,519 bytes; now under EIP-170)**
- TegridyLendingAdmin: **15,875 bytes (new contract; well under EIP-170)**
- Total system increased by 5,356 bytes across the two — gain in deployability
  outweighs the modest sum increase.

3 Phase 0 split exceptions remain: TegridyStaking (26,912), VoteIncentives
(26,350), TegridyRestaking (24,011 — only 11B over budget; Phase 0.4
pre-emptive). These are scheduled for follow-up batches.

#### Pass-8 Batch 5 — Phase 0.3: VoteIncentives → VoteIncentives + VoteIncentivesAdmin split (2026-05-05)

Second EIP-170 unblock. VoteIncentives was 26,350 bytes (1,774 over EIP-170)
AFTER batch 2's GOV-ECON-01 wiring added 373 bytes. Same split pattern as
TegridyLending Phase 0.1: propose/execute/cancel/pending state moved to
sister contract. VoteIncentives dropped to **21,665 bytes (saved 4,685,
2,911-byte EIP-170 headroom restored)**.

- **EIP170-03** — new
  [`contracts/src/VoteIncentivesAdmin.sol`](contracts/src/VoteIncentivesAdmin.sol)
  (~225 LoC) holds the timelock propose/execute/cancel triplets + pending
  storage + Proposed/Cancelled events for **5 parameter groups**:
  bribe fee, treasury, whitelist, per-token min-bribe amount, and the
  one-way commit-reveal enable. Inherits `OwnableNoRenounce + TimelockAdmin`.
  Constructor takes the VoteIncentives address; reads `MAX_FEE_BPS`,
  `bribeFeeBps`, `commitRevealEnabled` for validation.
- **VoteIncentives changes** — removed `TimelockAdmin` inheritance; removed
  all 5 admin parameter group triplets (15 functions) + `pending*` storage
  + Proposed/Cancelled events + view-helper `*ChangeTime()` getters; added
  `voteIncentivesAdmin` one-shot setter, `onlyAdmin` modifier, and 5
  `applyXxx*` setters (`applyFeeChange`, `applyTreasuryChange`,
  `applyWhitelistChange`, `applyMinBribeAmountChange`,
  `applyEnableCommitReveal`). Each `applyXxx*` re-validates against local
  invariants as defense in depth (FEE_CANNOT_BE_ZERO M-08 fix preserved,
  `whitelistedTokenList` swap-and-pop preserved on removal, idempotent
  commit-reveal toggle preserved).
- **Permissionless execute preserved for commit-reveal** — pre-split,
  `executeEnableCommitReveal` was `external` (NOT `onlyOwner`) so any party
  could fire the timelocked enable once delay had elapsed. Mirrored on the
  admin contract — `executeEnableCommitReveal` is permissionless on admin,
  but the underlying `applyEnableCommitReveal` on VoteIncentives is
  `onlyAdmin`. End-to-end gating preserved (only the immutably-wired admin
  can ever invoke the apply path).
- **CI guard** — VoteIncentives removed from the bytecode-budget exception
  list. 2 Phase 0 splits remain (Staking, Restaking).

Operational note: after deploy, owner must call
`voteIncentives.setVoteIncentivesAdmin(adminAddr)` (one-shot,
set-once-immutable). Until called, every `applyXxx` reverts
`NotVoteIncentivesAdmin`.

Bytecode deltas:
- VoteIncentives: **26,350 → 21,665 (saved 4,685; now under EIP-170 by 2,911 bytes)**
- VoteIncentivesAdmin: **7,420 bytes (new contract)**
- Total system increased by 2,735 bytes — gain in deployability outweighs
  the modest sum increase.

2 Phase 0 split exceptions remain: TegridyStaking (26,912 — Phase 0.2),
TegridyRestaking (24,011 — Phase 0.4 pre-emptive).

#### Pass-8 Batch 6 — Phase 0.2 (partial) + Phase 0.4 (full): TegridyStaking trim + TegridyRestaking under budget (2026-05-05)

**Phase 0.2 (partial)** — TegridyStaking is unusual relative to Lending /
VoteIncentives: TegridyStakingAdmin already exists from the 2026-04-26
sprint, so the propose/execute/cancel surface that drove the prior splits is
already extracted. The remaining bytecode is core ERC721 + lock/reward/JBAC
logic — no obvious large extraction targets without breaking ABI or
restructuring storage. This batch ships the **safe partial reductions** that
shave ~240 bytes; the remaining ~2KB clearance to fit EIP-170 requires a
dedicated follow-up batch.

- **EIP170-02 (partial)** — visibility lowered from `public` to `internal`
  on 5 mappings with zero on-chain consumers across the codebase
  (verified by grep over all `contracts/src/*.sol`):
  - `lastTransferTime` ([line 60](contracts/src/TegridyStaking.sol#L60))
  - `emergencyExitRequests` ([line ~182](contracts/src/TegridyStaking.sol#L182))
  - `strandedJbacOwner` ([line ~201](contracts/src/TegridyStaking.sol#L201))
  - `strandedJbacTokenId` ([line ~202](contracts/src/TegridyStaking.sol#L202))
  - `rewardNotifiers` ([line ~1688](contracts/src/TegridyStaking.sol#L1688))

  Each removed autogenerated `public` getter saves ~80 bytes. Off-chain
  readers query via existing events (`EmergencyExit*`, `JbacStranded`,
  `RewardNotifierUpdated`).

- **EIP170-02 (partial)** — replaced the dual auto-getters for
  `strandedJbacOwner` + `strandedJbacTokenId` with a single explicit
  `getStrandedJbac(uint256 tokenId) returns (address owner, uint256 jbacId)`
  combined getter. Net savings: ~130 bytes (2 × ~80B getters → 1 × ~30B
  combined getter).

- **TegridyStaking total delta:** 26,912 → 26,674 (−238 bytes). Still
  2,098 over EIP-170. Documented remaining options in
  [`.github/workflows/contracts-ci.yml`](.github/workflows/contracts-ci.yml):
    - **(a) Solady ERC721 swap** — replace OZ ERC721 with Solady's lighter
      implementation (~3KB savings). Trade-off: ABI/event differences require
      coordinated frontend + indexer migration.
    - **(b) External library extraction of `kick(uint256)`** — move the
      110-line cold-path cleanup function to a separate library called via
      DELEGATECALL (~3-4KB savings). Trade-off: ~2,600 extra gas per kick
      (cold delegatecall) and complex storage-pointer plumbing for the
      library to access TegridyStaking's storage layout. Acceptable for a
      permissionless cleanup that runs only when expired positions need
      decay.
  Either approach clears the remaining ~2KB. Both are dedicated batches
  with isolated test migration.

**Phase 0.4 (full)** — TegridyRestaking was 11B over the 24,000-byte budget
floor (and 565B under EIP-170 — already deployable, just not under the
safety cap). Trimmed ~150 bytes by lowering visibility on 2 internal-use
mappings:
  - `residualClaimant` ([line ~128](contracts/src/TegridyRestaking.sol#L128))
  - `hasRecoveredPrincipal` ([line ~170](contracts/src/TegridyRestaking.sol#L170))

  Both have zero on-chain consumers; off-chain readers can subscribe to
  `ResidualClaimant*` and `PrincipalRecovered` events.

- **TegridyRestaking delta:** 24,011 → 23,865 (−146 bytes). Now 711 bytes
  under EIP-170 AND under the 24,000 CI budget. Removed from the
  exception list.

**Phase 0 progress (after this batch):**

| Contract | Pre-fix | Post-fix | Status |
|---|---:|---:|---|
| TegridyLending | 28,177 | 17,658 | ✅ Phase 0.1 split landed |
| VoteIncentives | 26,350 | 21,665 | ✅ Phase 0.3 split landed |
| TegridyRestaking | 24,011 | 23,865 | ✅ Phase 0.4 trim landed |
| TegridyStaking | 26,912 | **26,674** | ⏳ Phase 0.2 partial; needs Solady-ERC721 swap OR `kick` external-library extraction for full clearance |

**1 Phase 0 exception remains: TegridyStaking** (still 2,098 over EIP-170;
documented next-batch options in CI workflow comment).

#### Pass-8 Batch 7 — Phase 0.2: Solmate ERC721 swap on TegridyStaking (2026-05-05)

Replaces OpenZeppelin ERC721 with Solmate's minimalist ERC721 to further
reduce TegridyStaking's runtime bytecode. **TegridyStaking 26,674 → 26,079
(saved 595 bytes; cumulative pass-8 savings: 833 bytes).** Solmate's
implementation lacks the IERC4906 / Errors integration of OZ v5.6.1 and uses
inline assembly in the hot transferFrom/balanceOf paths. Battle-tested at
scale by Uniswap V3 NFT positions (Position Manager NFT), Sudoswap, and
Friend.tech.

- **EIP170-02 (Solmate swap)** — base class change in
  [TegridyStaking.sol](contracts/src/TegridyStaking.sol):
  `import "@openzeppelin/contracts/token/ERC721/ERC721.sol"` →
  `import {ERC721} from "solmate/tokens/ERC721.sol"`.
- **`_update` override removed; replaced with three overrides**:
  - `transferFrom(from, to, id)` — handles pre-transfer cooldown +
    rate-limit + lending/restaking exemption + `_settleRewardsOnTransfer`,
    then calls `super.transferFrom` then `_postTokenTransition`.
  - `_mint(to, id)` — calls `super._mint` then
    `_postTokenTransition(0, to, id)`.
  - `_burn(id)` — captures `from = _ownerOf[id]` BEFORE `super._burn`
    (Solmate clears the mapping in `_burn`), then calls
    `_postTokenTransition(from, 0, id)`.
  - New internal `_postTokenTransition(from, to, id)` helper centralizes
    the `_positionsByOwner` updates, `userTokenId` writes,
    `_writeCheckpoint`, autoMaxLock reset, `emergencyExitRequests` cleanup,
    and the `MultipleNFTsAtAddress` event emission. Logic preserved
    verbatim from the prior `_update` second-half body.
- **`tokenURI(uint256)` override added** — Solmate makes this `abstract`
  (OZ provided a default empty implementation). Returns `""` to match the
  prior behaviour. Frontends/marketplaces still resolve metadata via
  TegridyTokenURIReader off-chain per the existing architecture.
- **`supportsInterface(bytes4)` override added** — Solmate's default
  declares ERC165 + ERC721 + ERC721Metadata. We additionally declare
  `0x150b7a02` (ERC721TokenReceiver) since this contract IS a receiver
  (the JBAC inbound path via `onERC721Received`).
- **`_ownerOf` access pattern** — Solmate exposes `_ownerOf` as an
  `internal mapping`, not a `function`. The single call-site in the prior
  `_update` (`from = _ownerOf(tokenId)`) was naturally removed when
  `_update` was deleted. Inside `_burn` override, the pattern is
  `address from = _ownerOf[id]` before `super._burn`.

**Behaviour preservation:**
- ABI-identical for all standard ERC721 surfaces (`transferFrom`,
  `safeTransferFrom`, `ownerOf`, `balanceOf`, `approve`,
  `setApprovalForAll`, `getApproved`, `isApprovedForAll`, `name`,
  `symbol`, `supportsInterface`).
- Standard `Transfer` / `Approval` / `ApprovalForAll` events are
  byte-identical (same indexed signatures).
- `safeTransferFrom` automatically routes through our overridden
  `transferFrom` (Solmate calls `transferFrom` from `safeTransferFrom`
  internally — no separate override needed).

**Storage layout (breaking change for fresh deploy only):**
- OZ used `_owners`, `_balances`, `_tokenApprovals`, `_operatorApprovals`.
- Solmate uses `_ownerOf`, `_balanceOf`, `getApproved`, `isApprovedForAll`.
- Live deployed contracts (using OZ slots) cannot be upgraded in place.
- This migration applies to **fresh deploys only**. Documented in the
  import-block comment.

**Reverts:**
- Solmate uses string requires (`"NOT_MINTED"`, `"WRONG_FROM"`,
  `"INVALID_RECIPIENT"`, etc.) instead of OZ's typed errors.
- Off-chain tooling that filtered on `ERC721NonexistentToken` /
  `ERC721IncorrectOwner` etc. needs updating to match the string reasons.
- All Tegridy custom errors (`TransferCooldownActive`, `TooManyPositions`,
  `AlreadyHasPosition`) preserved verbatim on the override paths.

**Honest remaining gap:** TegridyStaking still 1,503 bytes over EIP-170
after this batch. OZ ERC721 v5.6.1 was already heavily optimized; the
Solmate swap delivered 595B not the ~3KB I projected.

**Phase 0 progress (after this batch):**

| Contract | Pre-pass-8 | Post-pass-8 | Status |
|---|---:|---:|---|
| TegridyLending | 28,177 | 17,658 | ✅ Phase 0.1 split |
| VoteIncentives | 26,350 | 21,665 | ✅ Phase 0.3 split |
| TegridyRestaking | 24,011 | 23,865 | ✅ Phase 0.4 trim |
| **TegridyStaking** | 26,912 | **26,079** | ⏳ Phase 0.2 partial; needs `kick` extraction for full EIP-170 clearance |

Files touched:
- `contracts/src/TegridyStaking.sol` (Solmate import + `_update` →
  `transferFrom`/`_mint`/`_burn`/`_postTokenTransition` refactor +
  `tokenURI` override + `supportsInterface` override)
- `.github/workflows/contracts-ci.yml` (updated remaining-options
  documentation)

#### Pass-8 Batch 8 — Phase 0.2 final-state assessment (2026-05-05)

After investigating multiple bytecode-reduction levers on TegridyStaking,
documenting the empirical reality:

**Attempts that did NOT save bytecode (measured):**

- **Solmate `ReentrancyGuard` swap:** +135 bytes vs OZ. OZ v5's
  transient-storage variant (`TLOAD` / `TSTORE` on Cancun) is more
  bytecode-efficient than Solmate's `string require("REENTRANCY")` —
  the ABI string + revert encoding is heavier than OZ's typed-error
  selector. Reverted.
- **Inline minimalist Pausable** (replacing OZ inheritance): +46 bytes.
  OZ `Pausable` v5.6.1 is already very compact; inheritance overhead is
  smaller than the custom-error selectors + event topic hashes the
  inline copy adds. Reverted.

**Why Phase 0.2 cannot be fully closed in this batch:**

OZ Contracts v5.6.1 has already squeezed out most obvious optimization
targets — the typed errors + transient-storage idioms it uses are
genuinely byte-efficient. The Solmate ERC721 swap delivered 595B not
the ~3KB the audit's plan projected, and follow-on Solmate utility
swaps measured worse than OZ.

**The remaining 1,503-byte gap requires one of three dedicated paths
(documented in
[`.github/workflows/contracts-ci.yml`](.github/workflows/contracts-ci.yml)):**

1. **Add Solady as a Foundry dependency and swap ERC721 to Solady's
   implementation.** Solady is ~200-500B smaller than Solmate (more
   inline assembly in hot paths). Requires `forge install
   Vectorized/solady` and matching test-fixture updates. Likely the
   cleanest path remaining.
2. **Migrate state to ERC-7201 namespaced storage + extract large
   helpers (`kick`, `_settleRewardsOnTransfer`, etc.) to external
   library via DELEGATECALL** with storage-pointer args. Major refactor;
   storage layout breaks live deploy compatibility (acceptable since
   the Solmate ERC721 swap already broke layout).
3. **Split out non-ERC721 logic (JBAC management, stranded-NFT state,
   emergency-exit flow)** to a sister contract holding its own state,
   with TegridyStaking calling via privileged hooks. Larger surface
   change; preserves storage layout but introduces cross-contract gas
   overhead.

**Honest end-state of Phase 0:**

| Contract | Pre-pass-8 | Post-pass-8 | EIP-170 Status |
|---|---:|---:|---|
| TegridyLending | 28,177 | 17,658 | ✅ Cleared (Phase 0.1) |
| VoteIncentives | 26,350 | 21,665 | ✅ Cleared (Phase 0.3) |
| TegridyRestaking | 24,011 | 23,865 | ✅ Cleared (Phase 0.4) |
| **TegridyStaking** | 26,912 | **26,079** | ⏳ −833B; still 1,503B over |

**3 of 4 Phase 0 contracts are now deployable on mainnet.** The fourth
(TegridyStaking) requires a dedicated deep-refactor batch with one of
the three documented paths.

**Updated 2026-05-04 (pass-8 batch-9):** TegridyStaking grew to **26,312 B**
after the CCR-01 reorder + ABI shims (+233 B over the 26,079 figure
above; 1,736 B over EIP-170). TegridyRestaking landed at **24,011 B**
(11 B over the local 24,000-floor; 565 B under EIP-170). Both
re-added to the CI bytecode-budget exception list.

#### Pass-8 Batch 9 — CCR-01 cross-contract JBAC reentry + test/script migration (2026-05-04)

**Verification (forge test results post-batch):**

- TegridyStaking: 84 / 84 pass (incl. all 5 JBAC exit paths)
- VoteIncentives: 60 / 60 pass
- TegridyRestaking: 36 / 36 pass
- AuditR014_Lending: 9 / 9 pass
- PASS7_LENDING_01-04: 4 / 4 pass
- Pass6_Regressions: 4 / 4 pass
- Full unit suite (excluding invariants): **2,483 pass / 20 fail**.
  All 20 failures are pre-existing fallout from pass-8 batch-3 (raised
  `MIN_DEPOSIT` on TegridyNFTPoolFactory + `block.number` →
  `block.timestamp` cooldown switch on TegridyNFTPool); the test
  fixtures still encode the pre-batch-3 constants. Tracked for a
  dedicated NFTPool test-fixture refresh batch.


**Critical (1) — closed:**

- **CCR-01 / C4 — JBAC return-callback cross-contract reentrancy.** Pre-fix,
  every TegridyStaking exit path (`withdraw`, `earlyWithdraw`,
  `emergencyWithdrawPosition`, `emergencyExitPosition`, `executeEmergencyExit`)
  ran `_returnJbacIfDeposited(...)` BEFORE `_clearPosition(...)`. The JBAC
  `safeTransferFrom` callback fires user-controlled code with the staking NFT
  still owned by the attacker — re-entering `TegridyLending.acceptOffer(...)`
  succeeds (transferFrom pulls the staking NFT from attacker; lending pays
  principal ETH). When the callback returns, the outer `_clearPosition`
  burns the staking NFT — burning the lender's collateral and permanently
  trapping their principal. Closed by reordering all 5 exit paths so
  `_clearPosition` (which calls `_burn`) runs BEFORE the JBAC return; helper
  refactored from `_returnJbacIfDeposited(tokenId, to)` to `_returnJbac(tokenId, jbacId, to)`
  with the JBAC id captured pre-clear (since `_clearPosition` deletes the
  Position struct). After the reorder, Solmate's `_ownerOf[tokenId] == address(0)`
  post-burn means any cross-contract `transferFrom`/`safeTransferFrom`/`acceptOffer`
  attempt during the JBAC callback reverts on `from != _ownerOf[id]` — closes
  the parallel ghost-restake attack on TegridyRestaking (CCR-02) by the same
  defense.

  Files changed:
  - [TegridyStaking.sol:912](contracts/src/TegridyStaking.sol#L912) — `withdraw` reorder
  - [TegridyStaking.sol:932](contracts/src/TegridyStaking.sol#L932) — `earlyWithdraw` reorder
  - [TegridyStaking.sol:1647](contracts/src/TegridyStaking.sol#L1647) — `emergencyWithdrawPosition` reorder
  - [TegridyStaking.sol:1671](contracts/src/TegridyStaking.sol#L1671) — `emergencyExitPosition` reorder
  - [TegridyStaking.sol:1726](contracts/src/TegridyStaking.sol#L1726) — `executeEmergencyExit` reorder
  - [TegridyStaking.sol:1956](contracts/src/TegridyStaking.sol#L1956) — `_returnJbac(tokenId, jbacId, to)` helper

**Toolchain follow-ons that landed alongside the CCR-01 reorder (no
runtime semantic change — compilability + auto-getter ABI shims for
the audit/test surface):**

- **Solmate ERC721 import alias.** [TegridyStaking.sol:28](contracts/src/TegridyStaking.sol#L28)
  changed from `import {ERC721}` to `import {ERC721 as SolmateERC721}` so other
  units that wildcard-import `../src/TegridyStaking.sol` (every script + several
  tests) don't surface a colliding `ERC721` symbol against OZ's. Inheritance and
  constructor renamed accordingly.
- **ABI shims for newly-internal mappings.** Re-exposed
  `emergencyExitRequests(uint256)`, `strandedJbacOwner(uint256)`,
  `strandedJbacTokenId(uint256)` ([TegridyStaking.sol:255-258](contracts/src/TegridyStaking.sol#L255))
  and `residualClaimant(uint256)` + `hasRecoveredPrincipal(address)`
  ([TegridyRestaking.sol:451-454](contracts/src/TegridyRestaking.sol#L451)) as
  external view functions, with the underlying state slots renamed to leading
  underscore. Net effect: Pass-8 EIP170-02/04 visibility-trim savings preserved
  on the assignment/read sites; off-chain readers and the audit test suite
  retain the auto-getter ABI shape.

**Test + deploy-script migration to admin sister contracts (Pass-8 Phase 0
splits):**

- **VoteIncentives → VoteIncentivesAdmin** wiring added (or callsites
  redirected) in:
  [test/VoteIncentives.t.sol](contracts/test/VoteIncentives.t.sol),
  [test/AuditDemonstration.t.sol](contracts/test/AuditDemonstration.t.sol),
  [test/AuditR014_VoteIncentives.t.sol](contracts/test/AuditR014_VoteIncentives.t.sol),
  [test/AuditR016_AMMGov.t.sol](contracts/test/AuditR016_AMMGov.t.sol),
  [test/Deep_Governance_2026_05_01.t.sol](contracts/test/Deep_Governance_2026_05_01.t.sol),
  [test/R020_VoteIncentives.t.sol](contracts/test/R020_VoteIncentives.t.sol),
  [test/invariants/VoteIncentivesShares.t.sol](contracts/test/invariants/VoteIncentivesShares.t.sol),
  [script/DeployVoteIncentives.s.sol](contracts/script/DeployVoteIncentives.s.sol),
  [script/DeployV2.s.sol](contracts/script/DeployV2.s.sol).
- **TegridyLending → TegridyLendingAdmin** wiring added (or callsites
  redirected) in:
  [test/AuditR014_Lending.t.sol](contracts/test/AuditR014_Lending.t.sol),
  [test/PASS7_LENDING_01.t.sol](contracts/test/PASS7_LENDING_01.t.sol),
  [test/PASS7_LENDING_02.t.sol](contracts/test/PASS7_LENDING_02.t.sol),
  [test/PASS7_LENDING_03.t.sol](contracts/test/PASS7_LENDING_03.t.sol),
  [test/PASS7_LENDING_04.t.sol](contracts/test/PASS7_LENDING_04.t.sol),
  [test/Pass6_Regressions.t.sol](contracts/test/Pass6_Regressions.t.sol),
  [test/TegridyLending.t.sol](contracts/test/TegridyLending.t.sol),
  [test/TegridyLending_ETHFloor.t.sol](contracts/test/TegridyLending_ETHFloor.t.sol),
  [test/TegridyLending_Reentrancy.t.sol](contracts/test/TegridyLending_Reentrancy.t.sol),
  [test/invariants/LendingInvariants.t.sol](contracts/test/invariants/LendingInvariants.t.sol),
  [test/invariants/Pass6_LendingSolvency.t.sol](contracts/test/invariants/Pass6_LendingSolvency.t.sol),
  [test/invariants/Pass6_RestakingResidualCrossProto.t.sol](contracts/test/invariants/Pass6_RestakingResidualCrossProto.t.sol),
  [test/invariants/Pass7_LendingExtSolvency.t.sol](contracts/test/invariants/Pass7_LendingExtSolvency.t.sol).

  Migration shape: each test/script now `new`'s the `*Admin` sister immediately
  after the underlying contract, calls `set*Admin(address(<sister>))` on the
  inheriting contract, and redirects every `propose*`/`execute*`/`cancel*`/`pending*`
  callsite from the underlying contract to the admin sister. Mirrors the
  production wiring path from [DeployVoteIncentives.s.sol](contracts/script/DeployVoteIncentives.s.sol)
  and [DeployV2.s.sol](contracts/script/DeployV2.s.sol).

#### Pass-8 Batch 10 — TF-INT-02: TegridyFeeHook ERC20 fee stranding closed (2026-05-04)

**Critical (1) — closed:**

- **TF-INT-02 / hook ERC20 fee stranding.** Pre-fix, `TegridyFeeHook.afterSwap`
  collected fees from V4 swaps into `accruedFees[currency]` for any pool
  currency (TOWELI, USDC, WETH, …) and the permissionless `claimFees` then
  `safeTransfer`'d the ERC20 to `RevenueDistributor`. But `RevenueDistributor`
  is ETH-only — its `distribute()` snapshots `address(this).balance`, with no
  per-currency epoch path — so non-WETH ERC20 fees and even raw WETH (sitting
  as an ERC20 transfer) flowed in but never reached veTOWELI holders. Audit
  finding documented at
  [docs/audits/archive/SECURITY_AUDIT_200_AGENT.md:60](docs/audits/archive/SECURITY_AUDIT_200_AGENT.md#L60).

  Closed by:

  1. **Constructor accepts canonical WETH9** (immutable). Set at deploy time
     so a captured owner cannot redirect the unwrap target. New deploy script
     env var `WETH` documented in
     [DeployTegridyFeeHook.s.sol](contracts/script/DeployTegridyFeeHook.s.sol).
  2. **`claimFees` restricted to the WETH path.** Now unwraps `amount` of
     WETH on the hook side via `IWETH(WETH).withdraw(amount)` and forwards
     native ETH to `revenueDistributor` via
     `WETHFallbackLib.safeTransferETHOrWrap` (10k-gas-stipend ETH leg with
     WETH-wrap fallback). Non-WETH currencies revert
     `MustConvertERC20First()` — directing callers to the conversion path
     below. Closed at
     [TegridyFeeHook.sol:418-447](contracts/src/TegridyFeeHook.sol#L418).
  3. **New `convertERC20FeesToETH(currency, router, path, minETHOut, deadline)`.**
     Owner-gated. Drains the on-hand ERC20 balance through the supplied
     Uniswap V2-compatible router via `swapExactTokensForETH`, then forwards
     the resulting ETH to `revenueDistributor` via the same WETHFallbackLib
     path. Mirrors `SwapFeeRouter.convertTokenFeesToETH` shape — caller
     supplies `minETHOut` floor; path validation requires `path[0] == currency`
     and `path[end] == hook.WETH` AND `router.WETH() == hook.WETH` (so a
     forked-chain router with a different WETH variant cannot redirect the
     swap). Sync-proposal lockout mirrors `claimFees` so a pending sync
     can't be raced to drain the ERC20 balance during the 24h timelock.
     CEI ordering: `accruedFees[currency]` adjusted before the swap.
     Closed at
     [TegridyFeeHook.sol:467-525](contracts/src/TegridyFeeHook.sol#L467).
  4. **New typed errors** for the conversion path:
     `MustConvertERC20First`, `InsufficientETHOut`, `InvalidConversionPath`,
     `DeadlineOutOfRange`, `NothingToConvert`. Plus `ERC20FeesConverted`
     event for off-chain accounting (records the realized `ethReceived`
     post-swap, NOT just the caller-supplied `minETHOut`).

  Trust model: owner-gated path (sandwich risk on `minETHOut` is bounded by
  the immutable destination — captured owner can route value at swap-time
  slippage cost but the destination remains `revenueDistributor`).
  RevenueDistributor.distribute() will pick up the new ETH on the next
  epoch automatically.

  Files changed:
  - [contracts/src/TegridyFeeHook.sol](contracts/src/TegridyFeeHook.sol)
    (constructor +1 param, new immutable `WETH`, new errors + event,
    `claimFees` rewritten, new `convertERC20FeesToETH`, ~+2,668 B)
  - [contracts/script/DeployTegridyFeeHook.s.sol](contracts/script/DeployTegridyFeeHook.s.sol)
    (new `WETH` env var, updated CREATE2 init-code-hash recipe to include
    the 5th constructor arg)
  - 4 test files updated for the new constructor param (sentinel WETH OK
    for paths that don't exercise the unwrap/convert legs):
    [test/TegridyFeeHook.t.sol](contracts/test/TegridyFeeHook.t.sol),
    [test/Audit195_PremiumHook.t.sol](contracts/test/Audit195_PremiumHook.t.sol),
    [test/Deep_AMM_2026_05_01.t.sol](contracts/test/Deep_AMM_2026_05_01.t.sol),
    [test/PASS7_HOOK_01.t.sol](contracts/test/PASS7_HOOK_01.t.sol),
    [test/R031_TegridyFeeHook.t.sol](contracts/test/R031_TegridyFeeHook.t.sol),
    [test/AuditR014_Misc.t.sol](contracts/test/AuditR014_Misc.t.sol).

  **Verification:**
  - 10 new tests in
    [test/TegridyFeeHook.t.sol](contracts/test/TegridyFeeHook.t.sol)
    covering happy path, minETHOut floor, owner-gating, path-end-must-be-WETH,
    router/WETH mismatch, currency=WETH rejection, zero-balance, past-deadline,
    far-future-deadline, claimFees(WETH) unwrap.
  - Existing PASS7-HOOK-03 regression
    (`test_PASS7_HOOK_01_claimFeesRevertsManagerLocked`) updated to bind
    `WETH = TOKEN0` so it exercises the new unwrap path; new sibling test
    `test_PASS8_TF_INT_02_claimFeesRejectsNonWETH` validates the
    `MustConvertERC20First` revert.
  - TegridyFeeHook bytecode: 8,763 B → 11,431 B (+2,668 B; under 24,000 B
    budget with 12,569 B headroom).
  - Full unit suite (excluding invariants): 2,495 pass / 20 fail (+12 vs.
    pre-batch-10's 2,483 pass; the same 20 pre-existing batch-3 NFTPool
    fixture failures remain).

#### Pass-8 Batch 11 — GOV-INT-01: GaugeController ↔ VoteIncentives decoupling closed (2026-05-06)

**Critical (1) — closed:**

- **GOV-INT-01 / C8 — disjoint gauge / bribe registries.** Pre-fix,
  `GaugeController` and `VoteIncentives` were two completely separate
  registries with no shared notion of pair ↔ gauge identity. A briber
  could call `VoteIncentives.depositBribe(pair, …)` on any factory-validated
  pair, regardless of whether GaugeController had a gauge for that pair —
  and the bond would sit in the contract with no recovery path because no
  voter had any reason to allocate emission weight to a pair that lacked
  an emission distributor. Velodrome / Aerodrome's `Voter` contract has
  enforced a pair → gauge mapping at gauge-creation time since v2; this
  fix mirrors that pattern.

  Closed by:

  1. **`pairToGauge` / `gaugeToPair` mappings on GaugeController.** Bidirectional
     so the deletion path can clear `pairToGauge[gaugeToPair[gauge]]` without
     an O(n) scan. Stored at
     [GaugeController.sol:91-107](contracts/src/GaugeController.sol#L91).
  2. **`proposeAddGauge(address gauge, address pair)` — new mandatory `pair`
     arg.** Pair must be non-zero, must be a contract, and must not already be
     mapped to a different gauge (`PairAlreadyMapped` error). The pair is
     captured in `pendingPairForAdd` alongside the existing `pendingGaugeAdd`
     and committed atomically inside `executeAddGauge`. Defensive re-check on
     `pairToGauge[pair] == 0` at execute time guards against a parallel admin
     path racing the same pair onto a different gauge between propose and
     execute. Closed at
     [GaugeController.sol:777-812](contracts/src/GaugeController.sol#L777).
  3. **Pair mapping cleared on every removal path** — `executeRemoveGauge`
     (synchronous), `executeRemoveGaugeNextEpoch` (deferred-prune), and
     `cancelAddGauge` (pre-execute abort). The next-epoch path deliberately
     clears `pairToGauge` immediately even though `gaugeList` cleanup defers
     to `executeRemoveGaugeFinalize` — this disarms VoteIncentives bribes the
     moment governance flips `isGauge` to false.
  4. **Events updated** — `GaugeAddProposed(gauge, pair, executeAfter)`,
     `GaugeAdded(gauge, pair)`, `GaugeRemoved(gauge, pair)` carry the pair
     argument so off-chain indexers see (gauge, pair) coupling at every state
     transition.
  5. **`VoteIncentives.gaugeController` + one-shot `setGaugeController`.**
     Mirrors the existing `setVoteIncentivesAdmin` / `setRestakingContract`
     one-shot patterns. Locked once set; rejects address(0) and EOAs. Closed
     at
     [VoteIncentives.sol:115-142](contracts/src/VoteIncentives.sol#L115).
  6. **`_requireGaugedPair(pair)` check** on both `depositBribe` and
     `depositBribeETH`. Conditional: when `gaugeController == address(0)`
     (pre-wiring), the check is a no-op for backwards compat with fixtures.
     Once a GC is wired (production deploy), every bribe deposit must target
     a pair with a registered gauge or revert `NoGaugeForPair()`. Closed at
     [VoteIncentives.sol:548 + 620](contracts/src/VoteIncentives.sol#L548).
  7. **Deploy path documented** — `DeployGaugeController.s.sol` step 4 now
     directs the operator to wire the GaugeController on VoteIncentives:
     `voteIncentives.setGaugeController(<gc>)`.

  Trust model: owner-trusted (`setGaugeController` is `onlyOwner`, one-shot,
  rejects EOAs and address(0)). Once wired, the constraint is enforced
  unconditionally for all bribe deposits.

  Files changed:
  - [contracts/src/GaugeController.sol](contracts/src/GaugeController.sol)
    (mapping pair, `pendingPairForAdd`, propose/execute/cancel/remove paths
    + new `InvalidPair` / `PairAlreadyMapped` errors, +749 B → 14,617 B)
  - [contracts/src/VoteIncentives.sol](contracts/src/VoteIncentives.sol)
    (`gaugeController` + setter, `_requireGaugedPair`, error +
    `IGaugeControllerPairs` interface, +421 B → 22,086 B; under budget with
    1,914 B headroom)
  - [contracts/script/DeployGaugeController.s.sol](contracts/script/DeployGaugeController.s.sol)
    (NEXT STEPS updated for the new arg + new wiring directive)
  - 8 test files updated to pass the new `pair` arg to `proposeAddGauge`
    (helpers etch minimal bytecode at the derived pair address):
    [test/GaugeController.t.sol](contracts/test/GaugeController.t.sol),
    [test/AuditR014_Governance.t.sol](contracts/test/AuditR014_Governance.t.sol),
    [test/Deep_Governance_2026_05_01.t.sol](contracts/test/Deep_Governance_2026_05_01.t.sol),
    [test/GaugeCommitReveal.t.sol](contracts/test/GaugeCommitReveal.t.sol),
    [test/R021_GaugeController.t.sol](contracts/test/R021_GaugeController.t.sol),
    [test/AuditR016_AMMGov.t.sol](contracts/test/AuditR016_AMMGov.t.sol),
    [test/PASS7_GAUGE_01.t.sol](contracts/test/PASS7_GAUGE_01.t.sol),
    [test/invariants/PASS5_GaugeWeightConservation.t.sol](contracts/test/invariants/PASS5_GaugeWeightConservation.t.sol).

  **Verification:**
  - 12 new tests in
    [test/PASS8_GOV_INT_01.t.sol](contracts/test/PASS8_GOV_INT_01.t.sol)
    covering: pre-wiring permissive (legacy compat), post-wiring revert on
    ungauged pair (ERC20 + ETH), success on gauged pair, post-remove
    de-arming, `setGaugeController` one-shot / EOA-rejection / zero-rejection,
    plus GaugeController-side validations
    (`PairAlreadyMapped`, zero pair, EOA pair, cancel clears
    `pendingPairForAdd`).
  - All existing gauge / bribe / governance suites unchanged: GaugeController
    12/12, PASS7_GAUGE_01 2/2, VoteIncentives 60/60, AuditR014_Governance
    5/5, AuditR016_AMMGov 6/6, Deep_Governance 3/3, GaugeCommitReveal 14/14,
    R021_GaugeController 12/12.
  - Full unit suite (excluding invariants): **2,507 pass / 20 fail** (+12 vs.
    pre-batch-11's 2,495 pass; the 20 pre-existing batch-3 NFTPool fixture
    failures remain).

#### Pass-8 Batch 12 — Phase 1.6: VoteIncentives self-bribe arbitrage + min-quorum on claims (2026-05-06)

**High (1) — closed:**

- **Phase 1.6 / VoteIncentives self-bribe arbitrage + sub-quorum claim.**
  Pre-fix, two related bugs let a briber profitably round-trip their own bond:

  1. **Self-bribe arbitrage.** A briber could deposit a bribe on (epoch, pair),
     vote with their own VP on the same (epoch, pair), and claim a share
     proportional to `userVP / totalVotesForPair` of the bribe. When the
     briber's VP dominated the pair's `totalGaugeVotes`, they pocketed up
     to `(1 - protocolFeeBps) * bribeAmount` of their own bond — the
     protocol fee was the only spread separating self-bribe from a
     pure-round-trip drain.
  2. **Sub-quorum claim.** Claims succeeded against any non-zero
     `totalGaugeVotes`. A briber could deposit a bribe, vote with a 1-wei
     VP themselves, and claim ~100% of the bribe back via
     `share = bribeAmount * 1 / 1`.

  Closed by:

  1. **`depositedOnPair[user][epoch][pair]` mapping.** Set on every
     successful `depositBribe` / `depositBribeETH`. Read by `claimBribes`
     (revert) and `claimBribesBatch` (silent skip). Strict per-(epoch, pair)
     granularity — depositors are barred from claiming ANY token on the
     pair they bribed, not just the token they deposited. Closed at
     [VoteIncentives.sol:308-321](contracts/src/VoteIncentives.sol#L308) +
     deposit hooks
     [VoteIncentives.sol:631-636 + 750-754](contracts/src/VoteIncentives.sol#L631).
  2. **`MIN_BRIBE_CLAIM_QUORUM = 100e18` constant.** 10% of the existing
     `MIN_DISTRIBUTE_STAKE` (1000e18). `claimBribes` reverts
     `BribePoolBelowQuorum` when `totalGaugeVotes[epoch][pair]` is below
     this; `claimBribesBatch` silently skips the offending epoch.
     Constant publicly exposed so off-chain tooling can mirror the gate
     without re-deriving it. Closed at
     [VoteIncentives.sol:189-205](contracts/src/VoteIncentives.sol#L189) +
     claim sites.
  3. **New typed errors:** `SelfBribeClaimForbidden`,
     `BribePoolBelowQuorum`. Both carry verbose natspec describing the
     close path.

  Trust model: enforced unconditionally on every claim (no admin / wiring
  prerequisite). Unlike GOV-INT-01's optional GaugeController gate, the
  self-bribe lockout activates the moment any deposit lands.

  **Verification:**

  - 9 new tests in [test/PASS8_PHASE_1_6.t.sol](contracts/test/PASS8_PHASE_1_6.t.sol)
    covering: above-quorum non-depositor success, self-bribe revert
    (single token), self-bribe lockout spans all tokens on the pair,
    sub-quorum revert, batch claim skipping blocked epochs, batch claim
    happy path, depositor flag persisting across multiple deposits,
    depositor flag set on ETH bribe path, public constant exposure.
  - Existing VoteIncentives.t.sol tests refactored to route deposits
    through a new `briber` address (separate from voters), so legacy
    coverage of `claimBribes_proportional`, `claimBribes_ETH`,
    `claimBribesBatch`, `double_claim_prevented`, `testFuzz_depositAndClaim`
    continues to validate the proportional-payout / double-claim
    semantics without tripping the new lockout.
  - Bytecode: VoteIncentives 22,086 B → 22,447 B (+361 B; under budget
    with 1,553 B headroom).
  - Targeted suites: VoteIncentives 60/60, PASS8_PHASE_1_6 9/9.
  - Full unit suite (excluding invariants): **2,516 pass / 20 fail** (+9
    vs. pre-batch-12's 2,507 pass; the 20 pre-existing batch-3 NFTPool
    fixture failures remain).

#### Pass-8 Batch 13 — NFTPool test fixture refresh (2026-05-06)

**Test debt cleanup — clears the 20 pre-existing failures from batch 3.**

Batch 3 raised `MIN_DEPOSIT` on `TegridyNFTPoolFactory` (0.01 → 0.05 ETH)
and migrated `lastSwapBlock` / `lastWithdrawBlock` /
`WITHDRAW_NFT_COOLDOWN_BLOCKS` on `TegridyNFTPool` from `block.number` to
`block.timestamp` semantics (CLK-02). Constant *names* were preserved
for ABI continuity, but every test fixture that exercised these surfaces
was still calling `createPool{value: 0.01 ether}` or using `vm.roll` to
advance past the cooldown — both broken post-batch-3.

This batch refreshes 5 test files mechanically:

- **MIN_DEPOSIT bump** — `createPool{value: 0.01 ether}` →
  `createPool{value: 0.05 ether}` across:
  [test/TegridyNFTPoolFactory.t.sol](contracts/test/TegridyNFTPoolFactory.t.sol),
  [test/R064_PaginationBounds.t.sol](contracts/test/R064_PaginationBounds.t.sol),
  [test/Deep_NFTPool_2026_05_01.t.sol](contracts/test/Deep_NFTPool_2026_05_01.t.sol).
  The intentional below-floor revert test
  (`test_createPool_revertsOnBelowMinDeposit`) at `0.009 ETH` still fires
  the `MIN_DEPOSIT` revert correctly under the raised floor.
- **Cooldown semantics** — `vm.roll(block.number + N)` patterns swapped
  to `vm.warp(block.timestamp + N)` in:
  [test/Deep_NFTPool_2026_05_01.t.sol](contracts/test/Deep_NFTPool_2026_05_01.t.sol)
  (`test_DEEP01_swapNextBlockOK`,
   `test_DEEP01_lastWithdrawBlockTracksETHWithdraw`,
   `test_L4_withdrawNFTs_succeedsAfterCooldown`),
  [test/TegridyNFTPool.t.sol](contracts/test/TegridyNFTPool.t.sol)
  (`test_withdrawETH_respectsProtocolFees`),
  [test/AuditR014_NFT.t.sol](contracts/test/AuditR014_NFT.t.sol)
  (`test_M4_removeLiquidity_succeedsInNextBlock`).
  `lastWithdrawBlock` assertions also re-targeted to `block.timestamp`
  since the storage slot now records timestamp.

No source-side changes — pure test-fixture refresh.

**Verification:**

- Full unit suite (excluding invariants): **2,536 pass / 0 fail**
  (+20 vs. pre-batch-13's 2,516 pass; full suite green for the first
  time since pass-7). No source contracts changed; no bytecode delta.

#### Pass-8 Batch 14 — Phase 0.2 finish: TegridyStaking under EIP-170 (2026-05-06)

**Deploy unblocker — TegridyStaking finally fits within mainnet's
24,576-byte runtime bytecode limit.**

Pre-batch-14 status: TegridyStaking sat at 26,312 B, **1,736 B over EIP-170**.
The contract literally could not be redeployed on mainnet. Three documented
forward paths existed (Solady ERC721 / ERC-7201 namespaced storage / JBAC
sister split). This batch uses the **first and third paths combined**, plus
a final pass of public→internal constant trims, to close the gap.

**Composite reductions (1,768 B saved overall):**

1. **Solady ERC721 swap** (–621 B). Replaced
   `import {ERC721} from "solmate/tokens/ERC721.sol"` with Solady's ERC721
   ([lib/solady](contracts/lib/solady)). Solady consolidates the
   `transferFrom` / `_mint` / `_burn` post-processing into a single
   `_afterTokenTransfer(from, to, id)` hook (Solmate required three
   separate overrides). The collapse + Solady's tighter assembly cut 621 B.
   `name()` / `symbol()` are now constant `pure` overrides (Solady has no
   constructor-args surface for them); `tokenURI()` and `supportsInterface`
   updated to match Solady's abstract surface.
2. **JBAC sister-vault split** (–712 B). Created
   [`contracts/src/TegridyStakingJbacVault.sol`](contracts/src/TegridyStakingJbacVault.sol)
   to custody JBAC NFTs and own the stranded-reclaim bookkeeping. Removed
   from `TegridyStaking`: `_strandedJbacOwner` / `_strandedJbacTokenId`
   mappings, `_returnJbac` / `claimStrandedJbac` / `getStrandedJbac`
   functions, the two ABI shims (`strandedJbacOwner` / `strandedJbacTokenId`),
   `onERC721Received` (no longer a token receiver), `IERC721Receiver`
   inheritance + import, the `JbacReturned` / `JbacStranded` events, and
   the `OnlyJbacNFT` error. Wiring: one-shot
   `staking.setJbacVault(address)` post-deploy. UX preserved — users still
   approve TegridyStaking for their JBAC; `stakeWithBoost` now does
   `jbacNFT.safeTransferFrom(user, vault, jbacId)` so the JBAC lands at
   the vault via `vault.onERC721Received` (gated to the configured JBAC
   sender). CCR-01 invariant carried over verbatim — `_clearPosition`
   calls `vault.returnJbac(...)` AFTER `_burn`, and the vault's
   try/catch falls back to stranded-bookkeeping on a reverting JBAC
   contract.
3. **Inlined CCR-01 capture-and-return into `_clearPosition`** (–80 B).
   The 5 exit paths previously each had a one-line inline
   `uint256 jbacId = p.jbacDeposited ? p.jbacTokenId : 0;` capture and a
   trailing `_returnJbac(...)` call. Both moved inside `_clearPosition`,
   which now captures pre-`delete` and calls `vault.returnJbac` post-`_burn`.
   The CCR-01 ordering invariant is now a property of the helper itself
   rather than a discipline at every callsite.
4. **`supportsInterface` override removed** (–27 B). Pre-batch-14 the
   override added `0x150b7a02` (ERC721TokenReceiver) since
   TegridyStaking implemented `IERC721Receiver` for JBAC inbound. After the
   custody split this contract is no longer a receiver, so Solady's base
   `supportsInterface` (ERC165 + ERC721 + ERC721Metadata) is correct as-is.
5. **`optimizer_runs` 10 → 1** (–15 B). Lower runs prioritise deploy-size
   over runtime-gas — exactly what's needed to land Phase 0.2.
6. **Public → internal constant trims** (–~280 B). Lowered visibility on
   constants with no external readers (or external readers that can
   trivially hardcode the value): `BPS`, `BOOST_PRECISION`,
   `MIN_NOTIFY_AMOUNT`, `MIN_STAKE`, `TRANSFER_COOLDOWN`,
   `TRANSFER_RATE_LIMIT`, `EMERGENCY_EXIT_DELAY`, `USER_INACTIVITY_GATE`,
   `MAX_POSITIONS_PER_HOLDER`, `ADMIN_REPLACEMENT_TIMELOCK`,
   `EXTEND_FEE_BPS_CEILING`. Each public→internal saves ~30 B (auto-getter
   selector + assembly stub). `TegridyStakingAdmin`'s two cross-contract
   reads (`BPS()`, `EXTEND_FEE_BPS_CEILING()`) hardcode the values
   inline; tests that read `MAX_POSITIONS_PER_HOLDER` /
   `USER_INACTIVITY_GATE` / `ADMIN_REPLACEMENT_TIMELOCK` similarly
   hardcode (with inline `/* CONSTANT_NAME; internal in batch-14 */`
   tags).

**Final size: 24,544 B — 32 B under EIP-170.**

| Contract | Pre-batch-14 | Post-batch-14 | EIP-170 |
|---|---:|---:|---|
| **TegridyStaking** | 26,312 | **24,544** | ✅ Cleared by 32 B |
| TegridyStakingJbacVault | — (new) | 1,615 | ✅ |

**File changes:**

- [contracts/foundry.toml](contracts/foundry.toml) — added `solady`
  remapping, lowered `optimizer_runs` from 10 to 1.
- [contracts/lib/solady](contracts/lib/solady) — new dependency
  (Vectorized/solady v0.1.26).
- [contracts/src/TegridyStakingJbacVault.sol](contracts/src/TegridyStakingJbacVault.sol) — new sister contract.
- [contracts/src/TegridyStaking.sol](contracts/src/TegridyStaking.sol) — Solady swap, vault wiring, hook
  collapse, constant trims.
- [contracts/src/TegridyStakingAdmin.sol](contracts/src/TegridyStakingAdmin.sol) — hardcoded `BPS` / `EXTEND_FEE_BPS_CEILING`
  cross-contract reads.
- [.github/workflows/contracts-ci.yml](.github/workflows/contracts-ci.yml) — bytecode-budget guard updated:
  TegridyRestaking removed from exceptions (now under both EIP-170 and the
  24,000 floor); TegridyStaking remains an exception ("hugging the line"
  at 24,544 B / 32 B EIP-170 headroom / 544 B over the 24,000 local
  floor).
- 6 test files (TegridyStaking.t.sol, TegridyRestaking.t.sol,
  AuditFixes_Staking.t.sol, FinalAudit_Staking.t.sol, RedTeam_Staking.t.sol,
  Audit195_StakingCore.t.sol): wire JBAC vault in setUp + redirect JBAC
  custody assertions from `address(staking)` to `address(vault)`.
- 2 test files (Audit195_StakingGov.t.sol, AuditR014_StakingAdmin.t.sol):
  hardcode the now-internal constants.
- 1 test file (Pass6_Regressions.t.sol): rebase the
  `unsettledRewardsByTokenId` storage-slot constant from 21 → 22 (Solady
  swap freed 6 leading slots; vault split removed 2 stranded mappings;
  added 1 `jbacVault` slot — net layout shift documented inline).
- 1 test file (AuditFixes_Staking.t.sol): redirect
  `staking.claimStrandedJbac` / `staking.strandedJbacOwner` /
  `staking.strandedJbacTokenId` to `vault.*`.

**Verification:**

- Bytecode budget: TegridyStaking 24,544 B (32 B under EIP-170).
  Vault 1,615 B. All other src/ contracts under 24,000 floor.
- Full unit suite (excluding invariants): **2,536 pass / 0 fail**
  (no regressions from batch-13's all-green baseline).
- All 6 staking-affected suites still green: TegridyStaking 84/84,
  TegridyRestaking 36/36, AuditFixes_Staking, FinalAudit_Staking,
  RedTeam_Staking, Audit195_StakingCore — all pass.

**Mainnet deployability achieved.** All 4 Phase 0 contracts (TegridyLending,
VoteIncentives, TegridyRestaking, **TegridyStaking**) now fit under EIP-170.
This unblocks the long-stalled Wave 0 redeploy.

#### Pass-8 Batch 15 — Phase 3.5: TegridyLending offer expiry (2026-05-06)

**Medium (1) — closed:**

- **Phase 3.5 / TegridyLending offer expiry.** Pre-fix, an active loan offer
  on TegridyLending could be accepted indefinitely — the `LoanOffer` struct
  had no `expiry` field, `createLoanOffer` accepted no deadline, and
  `acceptOffer` performed no timestamp check. A lender's quote at favorable
  terms (e.g., when ETH was 4,000 USD) remained accept-able after market
  drift; the lender's only escape was to remember to `cancelOffer`. Pattern
  of record: BendDAO, NFTfi, ParaSpace all gate offer acceptance on a
  per-offer expiry.

  Closed by:
  1. New `uint64 expiry` field on `LoanOffer` struct.
  2. **`createLoanOffer(...)` (5-arg, backward-compat)** auto-defaults
     expiry to `block.timestamp + MAX_OFFER_VALIDITY` (90 days). All 14
     existing test/script callsites continue working without modification —
     the change is a strict improvement over the prior unbounded behavior.
  3. **`createLoanOfferWithExpiry(...)` (6-arg, explicit)** for lenders
     wanting a tighter expiry. Bounds:
     `[now + MIN_OFFER_VALIDITY, now + MAX_OFFER_VALIDITY]` (1 hour → 90 days).
     1-hour minimum blocks pure-spam expiries; 90-day maximum caps stale-quote
     attack window.
  4. `acceptOffer` reverts `OfferExpired()` once `block.timestamp > offer.expiry`.
     `cancelOffer` is intentionally NOT gated on expiry — lender can recover
     principal + held origination fee from an expired offer at any time.
  5. New typed errors: `InvalidOfferExpiry`, `OfferExpired`.

  Verification: 10 new tests in
  [test/PASS8_PHASE_3_5.t.sol](contracts/test/PASS8_PHASE_3_5.t.sol).
  Full unit suite: **2,546 pass / 0 fail** (+10 vs. pre-batch-15).
  Bytecode: TegridyLending 17,658 → 18,292 (+634 B; under EIP-170 with
  6,284 B headroom).

#### Pass-8 Batch 16 — TegridyFeeHook PoolKey allowlist (2026-05-06)

**High (1) — closed:**

- **TegridyFeeHook PoolKey allowlist.** Pre-fix, `afterSwap` accepted ANY
  PoolKey from any pool that attached this hook. The V4 PoolManager only
  enforces an address-bit pattern on hooks; it does NOT gate which pools
  can use a given hook contract. An attacker could deploy a V4 pool with
  attacker-controlled tokens (e.g. an ERC20 with `transferFrom` no-op'd),
  attach this hook to the new pool, trigger a swap, and watch the hook
  credit `accruedFees[<malicious token>]` against itself. Combined with
  the existing owner-gated `convertERC20FeesToETH` path, the attacker
  could then route the fake fees through a routing path of their choice
  if a captured-owner / routing-curve manipulation was layered on. Even
  without the drain leg, fake fee accrual corrupts the protocol's fee
  accounting and makes legitimate `claimFees` calls under-recover.

  Closed by:
  1. New `mapping(bytes32 poolKeyHash => bool) public approvedPools`.
  2. Owner-gated single-step `approvePool(PoolKey)` and `revokePool(PoolKey)`.
     No timelock — adding a pool is additive (creates a new fee stream)
     and revoking is defensive (cuts off a misbehaving pool); 24h delay
     would be counterproductive on either path.
  3. `afterSwap` first check: `if (!approvedPools[_poolKeyHash(key)])`
     return zero-fee. Crucially, the path does NOT revert — that would
     brick every swap on a misconfigured pool. The swap completes for the
     user; the hook simply contributes nothing to the swap delta.
  4. New `PoolApproved(hash, currency0, currency1)` and `PoolRevoked(hash)`
     events for off-chain indexing.
  5. New typed error `PoolNotApproved` (currently unused — the silent-
     zero-fee path is preferred — but kept declared for future strict-mode
     deploys that may want to reject swaps outright).

  Files changed:
  - [contracts/src/TegridyFeeHook.sol](contracts/src/TegridyFeeHook.sol)
    (mapping, helper, approve/revoke, gate; ~+670 B → 12,106 B; under
    EIP-170 with 12,470 B headroom).
  - [contracts/test/PASS8_HOOK_ALLOWLIST.t.sol](contracts/test/PASS8_HOOK_ALLOWLIST.t.sol)
    (new — 6 dedicated tests covering: unapproved → zero-fee, approved →
    accrues, revoked → stops accruing, events emitted, only-owner gating,
    different fee-tier PoolKeys are distinct allowlist entries).
  - [contracts/test/PASS7_HOOK_01.t.sol](contracts/test/PASS7_HOOK_01.t.sol)
    + [contracts/test/R031_TegridyFeeHook.t.sol](contracts/test/R031_TegridyFeeHook.t.sol):
    setUp now calls `hook.approvePool(_key())` / `hook.approvePool(_mkKey())`
    so the existing post-fix regressions still validate against an
    approved pool.

  **Verification:** 6 new tests pass; full unit suite **2,552 pass / 0 fail**
  (+6 vs. pre-batch-16).

#### Pass-8 Batch 17 — TegridyNFTPool ERC-2981 royalty enforcement (2026-05-06)

**Medium (1) — closed:**

- **TegridyNFTPool ERC-2981 royalty enforcement.** Pre-fix, both swap
  paths bypassed creator royalties entirely — the contract didn't import
  `IERC2981` nor query `royaltyInfo` on any code path. Mainstream NFT
  marketplaces (Blur, OpenSea Pro, Sudoswap V2) honor on-chain royalty
  enforcement; this pool deviated silently from the marketplace norm,
  exposing the protocol to creator-community pushback and potential
  ecosystem blacklisting.

  Closed by:
  1. New minimal `IERC2981` interface (single `royaltyInfo(tokenId,
     salePrice) → (receiver, royaltyAmount)` function).
  2. New private `_settleRoyalty(totalSale, firstTokenId)` helper that
     try-calls the collection's `royaltyInfo`, validates the response
     (rejects zero receiver, zero amount, or amount ≥ totalSale as
     pathological), and forwards via `WETHFallbackLib.safeTransferETHOrWrapNoRevert`.
     Misbehaving receivers (e.g. revert on `receive()`) cannot brick a
     sale — both ETH and WETH legs failing silently skip the royalty.
  3. **`swapETHForNFTs`** — royalty deducted from pool spot-revenue
     (after protocol fee + LP fee). Buyer pays `inputAmount` regardless
     of royalty; pool's net retained piece shrinks.
  4. **`swapNFTsForETH`** — royalty deducted from seller's payout
     (after protocol fee + LP fee). Seller receives `outputAmount −
     royalty`.
  5. New events: `RoyaltyPaid(receiver, amount, tokenId)` and
     `RoyaltyFallbackToWETH(receiver, amount, tokenId)` for indexers
     tracking royalty flow vs. WETH-fallback-on-receiver-revert.

  Anchoring on `tokenIds[0]` for the royaltyInfo query is faithful to
  the dominant ERC-2981 implementation pattern (single rate per
  collection); tokens with per-token royalty curves are an ERC-2981
  edge case that this implementation explicitly trades against batch-gas
  efficiency.

  Files changed:
  - [contracts/src/TegridyNFTPool.sol](contracts/src/TegridyNFTPool.sol)
    (interface, helper, swap-path integrations, events; ~+800 B → 12,402 B).
  - [contracts/test/PASS8_ROYALTY.t.sol](contracts/test/PASS8_ROYALTY.t.sol)
    (new — 5 dedicated tests).

  **Verification:**
  - 5 new tests covering: BUY path pays royalty out of pool revenue, SELL
    path pays royalty out of seller payout, non-ERC-2981 collection pays
    zero (back-compat), misbehaving receiver doesn't brick the sale,
    pathological 100% royalty rate is refused.
  - Full unit suite: **2,557 pass / 0 fail** (+5 vs. pre-batch-17).

#### Pass-8 Batch 18 — ETH-ingress counters on POLAccumulator + SwapFeeRouter (2026-05-06)

**Low (1) — closed:**

- **ETH-ingress accounting on POLAccumulator + SwapFeeRouter.** Pre-fix,
  both contracts had bare `receive()` paths that accepted ETH without
  any per-deposit accounting trail. POLAccumulator emitted an
  `ETHReceived(sender, amount)` event but did not track a cumulative
  total; SwapFeeRouter had no event at all. Combined with the
  bare-`receive()` design, "donated" / accidental / mistransferred ETH
  drifted into the contract balance with no way for off-chain monitoring
  to distinguish legitimate fee inflow from anomalous deposits — a
  weak signal but a real reconciliation gap.

  Closed by:

  1. **`uint256 public totalETHReceived`** on both contracts. Monotonic
     counter — incremented in `receive()`, never decremented. Distribution
     outflows are tracked on the receiving contracts (RevenueDistributor /
     ReferralSplitter / etc.); this counter is a one-way ETH-ingress
     witness.
  2. **POLAccumulator**: existing `ETHReceived(sender, amount)` event
     preserved; counter increment added at the head of `receive()`.
  3. **SwapFeeRouter**: bare `receive()` upgraded to emit a new
     `ETHReceived(sender, amount)` event AND increment the counter.
     Pre-fix, SwapFeeRouter's `receive()` was completely silent — no
     event, no counter — making indexer-driven anomaly detection
     impossible.

  MemeBountyBoard intentionally has no `receive()` (donated ETH literally
  cannot land), so it's not in scope. The audit-recon flagged it as a
  gap but the underlying mechanism (no-receive) is itself a stronger
  defense than a counter would provide.

  Files changed:
  - [contracts/src/POLAccumulator.sol](contracts/src/POLAccumulator.sol)
    (+ counter declaration + increment).
  - [contracts/src/SwapFeeRouter.sol](contracts/src/SwapFeeRouter.sol)
    (+ counter declaration + event + increment).
  - [contracts/test/PASS8_ETH_COUNTERS.t.sol](contracts/test/PASS8_ETH_COUNTERS.t.sol)
    (new — 4 dedicated tests using a minimal harness with the same
    `receive()` shape as both contracts).

  **Verification:**
  - 4 new tests covering: increment on first deposit, monotonic
    accumulation across multiple deposits, event emission, zero-value
    no-op, monotonic-on-drain (counter does NOT decrement on outflow).
  - Full unit suite: **2,561 pass / 0 fail** (+4 vs. pre-batch-18).

#### Pass-8 final closure — open queue resolution

The remaining audit master-plan items resolved as follows:

- **Phase 1.7 (single-VP across consumers)** — investigated; **NOT a
  bug**. Each governance consumer (RevenueDistributor, VoteIncentives,
  MemeBountyBoard, CommunityGrants) operates an independent reward pool;
  a staker's VP is a *claim* on each pool's distinct budget, not a
  fungible resource that gets "spent." This is the standard Curve /
  Aerodrome / Velodrome / Balancer pattern. None of the per-contract
  audit reports (017 VoteIncentives, 019 CommunityGrants,
  020 MemeBountyBoard, 024 RevenueDistributor) flagged simultaneous
  VP usage as a finding. No code change required.
- **Phase 2.6 / LD-01 (origination-fee live read)** — already fixed.
  `acceptOffer` re-derives the fee from gross deposit using the LIVE
  `originationFeeBps`, honoring fee CUTS between create and accept;
  fee snapshot is NOT stored on the offer.
- **TWAP first-observation hardening** — already closed in pass-6
  HIGH-3 + pass-7 PASS7-TWAP-01. First observation stamped
  `bypassed = true`; consult-time and per-window guards both refuse a
  bypassed-anchor lookup.
- **TegridyDropV2 reveal force-resolve** — by design. Drop is a
  standard mint-then-reveal ERC721, NOT a commit-reveal raffle.
  Reveal is an optional one-shot owner action with no expiry; under-
  reveal cannot brick the drop. Cancellation is pre-mint only
  (DEEP-DROP-05) which prevents the only stuck-funds scenario by
  construction. No fix required.

**All open items from the pass-8 master plan are now resolved.**

### Security — pass-7 adversarial multi-agent audit + remediation (2026-05-03 → 2026-05-04)

Three parallel worktree agents (oracle/AMM/fees, staking/governance, lending/NFT)
attacked the ground claimed closed by the 6 prior internal passes + Spartan,
plus the pass-6 invariant suite (13 props × 1.664M calls). Surfaced **1 Critical
+ 6 Highs + 4 Mediums + 1 Low + 1 Info** (13 NEW findings), all with runnable
Foundry PoCs. **All 13 closed in same-week remediation** using battle-tested
patterns mirrored from existing in-codebase fixes plus the canonical V4 hook
reference (`lib/v4-core/src/test/FeeTakingHook.sol:48`). Master report:
[`.audit_101/PASS7_2026_05_03.md`](./.audit_101/PASS7_2026_05_03.md).

#### Fixed — Critical (1)

- **PASS7-HOOK-01** — `TegridyFeeHook.afterSwap` now calls
  `poolManager.take(feeCurrency, address(this), feeUint)` inside the unlock
  context to settle the hook's positive `hookDelta`. Pre-fix, every V4 swap
  routed through the hook would have reverted `CurrencyNotSettled` because
  the returned `feeAmount` registered a positive delta with no corresponding
  `take()` call. Hook was undeployed (latent), but `script/DeployTegridyFeeHook.s.sol`
  is ready and would have bricked all V4 pools on day one. Pattern:
  [`lib/v4-core/src/test/FeeTakingHook.sol:48`](contracts/lib/v4-core/src/test/FeeTakingHook.sol#L48).
  Closed at [TegridyFeeHook.sol:282-302](contracts/src/TegridyFeeHook.sol#L282).

#### Fixed — Contract Highs (6)

- **PASS7-TWAP-01** — dropped the V3-AMM-L1 `&& found` carve-out at
  [TegridyTWAP.sol:738](contracts/src/TegridyTWAP.sol#L738). Pre-fix, the
  `!found` fallback path on sparse pairs anchored on the bypassed bootstrap
  and returned a poisoned price (PoC: 1e14 wei vs ~1 ETH fair value).
  Post-fix, ANY bypassed anchor reverts `OracleRebootstrapping` —
  fail-closed, exactly the FRESH-EYES H-3 invariant intent.
- **PASS7-GAUGE-H1** — `proposeAddGauge` now reverts `GaugeRemovePending`
  while `pendingGaugeRemove == gauge`, blocking the `executeRemoveNextEpoch
  → proposeAddGauge → executeAddGauge` cycle that previously stranded
  `pendingGaugeRemove`, duplicated the gauge in `gaugeList`, and bricked
  ALL future gauge removals permanently. Closed at
  [GaugeController.sol:743-765](contracts/src/GaugeController.sol#L743).
- **PASS7-LENDING-01** — `TegridyLending.acceptOffer` now post-condition
  checks `staking.ownerOf(_tokenId) == address(this)` after the inbound
  `transferFrom` and reverts `CollateralNotEscrowed` if the staking contract
  no-op'd. Sister to TegridyNFTLending L506-508; closes the lending-side
  parity gap pass-6 LD-NEW-H2 left open. Closed at
  [TegridyLending.sol:824-834](contracts/src/TegridyLending.sol#L824).
- **PASS7-LENDING-02** — `TegridyLending.repayLoan` /
  `claimDefaultedCollateral` now wrap outbound `staking.transferFrom` in
  new `_safeOutboundTransferStaking` helper + `stuckCollateralRecipient` map
  + new `claimStuckCollateral(loanId)` recovery function — full mirror of
  TegridyNFTLending's L743-L793 + L721-L741 + L176 pattern. On no-op
  detection: `stuckCollateralRecipient[loanId] = recipient`, emits
  `CollateralStuck`. Recipient retries via `claimStuckCollateral` once the
  collateral becomes honest. Closed across
  [TegridyLending.sol:993-1163](contracts/src/TegridyLending.sol#L993).
- **PASS7-LENDING-03** — settled-vs-settled cross-loan drain via shared
  per-tokenId reward bucket. `acceptOffer` now snapshots
  `unsettledRewardsByTokenId[tokenId]` into `loanRewardsSnapshot[loanId]`.
  At settlement, `repayLoan` / `claimDefaultedCollateral` drain to LENDING
  (not directly to recipient) and split: `priorShare = min(totalDrained,
  snapshot)` stays in lending balance for prior-holder recovery via
  `pullEscrowRewards`; `myShare = totalDrained - priorShare` forwarded to
  current recipient. On try/catch deferral, the un-claimable slice is
  recorded into `escrowRewardsOwed[loanId]`. Closes the cross-loan
  attribution gap that pass-6 LD-NEW-H1 only defended on the active-vs-
  settled axis. Closed across
  [TegridyLending.sol:840-851 + L955-L1028 + L1108-L1149](contracts/src/TegridyLending.sol#L840).
- **PASS7-NFTLENDING-01** — `TegridyNFTLending.claimStuckCollateral` now
  retries the transfer under `_safeOutboundTransfer` with post-condition
  check and reverts `StuckCollateralStillStuck` if the collection still
  no-ops. Pre-fix, the function deleted the recovery mapping BEFORE issuing
  a raw `transferFrom`, so a still-malicious collection silently consumed
  the recovery right (mapping zero, NFT permanently stuck). Closed at
  [TegridyNFTLending.sol:721-744](contracts/src/TegridyNFTLending.sol#L721).

#### Fixed — Contract Mediums (4)

- **PASS7-POL-02** — `POLAccumulator._twapMinOut` and `_twapHarvestMinOut`
  now mirror TegridyLending's bypass-cooldown defense: refuse any TWAP read
  for `TWAP_PERIOD * 2 = 60 minutes` after a bypass observation. Closes
  the defense-in-depth gap that compounded with PASS7-TWAP-01 to enable
  ~99.5% MEV bleed per accumulate during the bypass window. Closed at
  [POLAccumulator.sol:813-822 + L838-L847](contracts/src/POLAccumulator.sol#L813).
- **PASS7-HOOK-03** — `TegridyFeeHook.claimFees` no longer calls
  `poolManager.take()` outside the unlock context (which always reverted
  `ManagerLocked`). Now does plain `IERC20(currency).safeTransfer(
  revenueDistributor, amount)` against the hook's own ERC20 balance —
  works in any tx context. Auto-resolved by the PASS7-HOOK-01 fix
  (`take()` inside afterSwap means fees live in the hook contract balance
  going forward). Closed at
  [TegridyFeeHook.sol:354-366](contracts/src/TegridyFeeHook.sol#L354).
- **PASS7-LPFARM-M1** — `TegridyLPFarming.updateReward` modifier now
  re-derives `effectiveBalanceOf[account]` from the live staking-side
  boost on every interaction. Pre-fix, the cache was only refreshed on
  user-initiated `stake / withdraw / refreshBoost`; after lock expiry or
  staking-NFT transfer, the cache stayed inflated, letting attackers earn
  at the legacy boost ratio (~29% over-credit on 1y lock, ~300% at MAX_BOOST).
  Pattern of record: Synthetix `StakingRewards` checkpoint-at-every-
  interaction. Closed at
  [TegridyLPFarming.sol:204-241](contracts/src/TegridyLPFarming.sol#L204).
- **PASS7-NFTLENDING-02** — `TegridyNFTLending.cancelRemoveCollection` now
  mirrors TegridyLending's FRESH-EYES L still-live carve-out: only count
  cancels of STILL-LIVE proposals against the retry budget. Pre-fix, three
  propose → expire → cancel cycles permanently bricked the removal lever
  for a flagged collection. Closed at
  [TegridyNFTLending.sol:996-1018](contracts/src/TegridyNFTLending.sol#L996).

#### Fixed — Low (1) + Info (1)

- **PASS7-DOC-04** — `Pass6_TWAPFirstObsBypass.t.sol` invariant updated to
  reflect the post-PASS7-TWAP-01 contract-level guard that makes
  "successful consult ⇒ non-bypassed anchor" hold by construction.
  `FIX_STATUS.md` now narrows the TWAP HIGH-3 closure description to
  acknowledge the V3-AMM-L1 carve-out gap pass-7 closed.
- **PASS7-SFR-05** — `SwapFeeRouter` now declares `address public sequencerFeed`
  + `uint256 public constant SEQUENCER_GRACE_PERIOD = 1 hours` + a one-shot
  `setSequencerFeed(address)` owner setter. `_enforceTWAPMinETHOut` calls
  `SequencerCheck.checkSequencerUp(sequencerFeed, SEQUENCER_GRACE_PERIOD)`
  and a post-resume freshness gate. Mainnet zero-impact (sequencerFeed
  defaults to address(0), all helpers no-op); L2 deploys call
  `setSequencerFeed(...)` once before the first conversion. One-shot
  pattern preserves the existing 4-arg constructor signature so 17 in-tree
  test/script call sites don't need updates. Closed at
  [SwapFeeRouter.sol:172-201 + L494-L515 + L1923-L1946](contracts/src/SwapFeeRouter.sol#L172).

#### Tests

- New regression suite under
  [`contracts/test/PASS7_*.t.sol`](contracts/test/) — 9 files, 15 tests,
  all converted from "asserts exploit" → "asserts fix". Each PoC keeps
  the original adversarial flow but flips assertions to verify the new
  revert behavior (`vm.expectRevert(NewError.selector)`) or correct
  recovery semantics. Run: `forge test --match-path "test/PASS7_*.t.sol"`.
- Patched 5 in-tree mock TWAPs (`POLAccumulator.t.sol`, `Audit195_POL.t.sol`,
  `AuditR014_POL.t.sol`, `FinalAudit_POLPremium.t.sol`,
  `RedTeam_POLPremium.t.sol`, `invariants/LendingInvariants.t.sol`) with
  the new `lastBypassUsed(address) returns (uint256)` getter required by
  the POL bypass-cooldown gate. Mocks return 0 (no-bypass-observed) so
  legacy tests are no-op against the new path.
- `test_consult_succeedsAtMaxPeriod` updated for fail-closed bypassed-anchor
  semantics (seeds 49 observations to overwrite the bypassed bootstrap
  before max-period consult).

#### Sign-off (PASS7 §6)

- **$1M TVL — ACCEPTABLE with operational guardrails.** All 13 fixes
  shipped. Hook still operationally undeployed; if/when V4 deploy lands,
  external V4-hook-specialist review recommended before mainnet.
- **$10M TVL — Need paid-firm engagement (Spearbit / OpenZeppelin /
  ChainSecurity caliber) targeting the architectural cluster (per-tokenId
  attribution, V4 hook semantics, boost-cache lifetime).**
- **$100M TVL — Above PLUS post-firm invariant-suite re-run with targets
  ≥ 5M calls per surface.**

### Security — post-pass-7 invariant-driven hardening (2026-05-04)

Net-new stateful invariant suite extending pass-6's `Pass6_LendingSolvency`
with pause/unpause + claimStuckCollateral handler actions. Ran Slither
v0.11.5 + Foundry invariant fuzzer against the post-pass-7 tree. Slither
surfaced zero new actionable findings vs the pass-6 triage baseline; the
new invariant suite **caught 1 net-new HIGH** introduced by the
PASS7-LENDING-03 closure itself.

#### Fixed — Contract Highs (1)

- **PASS7-LENDING-04** — directPaid + legacy double-claim regression in
  `TegridyLending.pullEscrowRewards`. The PASS7-LENDING-03 deferral-tracker
  records `escrowRewardsOwed[loanId] += myDeferred` when a paused-staking
  try/catch leaves a slice in the per-tokenId bucket. When staking later
  unpaused and the recipient called `pullEscrowRewards`, the `directPaid`
  branch drained the slice from the staking bucket DIRECTLY to the recipient
  but the legacy ledger never reconciled — `payout = 0` because lending's
  TOWELI balance was 0 — leaving `escrowRewardsOwed[loanId]` and
  `totalEscrowRewardsOwed` at the deferred amount. Any subsequent TOWELI
  inflow to lending (donation, sibling loan's `priorShare`, sweep return)
  became double-claimable via a second `pullEscrowRewards` call against the
  legacy pro-rata branch. Trigger preconditions are operational not
  adversarial: any admin pause on staking that coincides with a loan
  settlement auto-arms the desync. Fix: reconcile both per-loan and global
  counters by `min(directPaid, owed)` immediately after computing
  `directPaid`, so the two payout legs decrement in lockstep. Closed at
  [TegridyLending.sol:1845-1869](contracts/src/TegridyLending.sol#L1845).
  Master writeup:
  [`.audit_101/PASS7_LENDING_04.md`](./.audit_101/PASS7_LENDING_04.md).

#### Tests

- **New stateful invariant suite**:
  [`contracts/test/invariants/Pass7_LendingExtSolvency.t.sol`](contracts/test/invariants/Pass7_LendingExtSolvency.t.sol)
  — extends `Pass6_LendingSolvency` with pause/unpause cycles on both
  staking AND lending + `claimStuckCollateral` handler action. Three
  properties:
  - **P7A-1** ETH solvency holds across pause cycles (mirrors Pass6 E1
    under wider sequence space)
  - **P7A-2** TOWELI backing for `totalEscrowRewardsOwed`
    (`toweli.balanceOf(lending) + staking.unsettledRewards(lending) >=
    totalEscrowRewardsOwed`) — the property that surfaced LENDING-04
  - **P7A-3** `stuckCollateralRecipient[loanId] != 0 ⇒ loan settled` —
    locks down LENDING-02's recovery slot semantics
  3/3 invariants × ~10k handler calls each × 13 actions ≈ 130k total
  randomized sequences, 0 reverts post-fix.
- **PoC test**:
  [`contracts/test/PASS7_LENDING_04.t.sol`](contracts/test/PASS7_LENDING_04.t.sol)
  — 7-step deterministic reproduction (open loan → pause → repay defers →
  unpause → first pull → donate → second pull). Pre-fix demonstrated full
  double-claim of a 10k-ether slice; post-fix the second pull reverts
  `NoEscrowRewards` and the donation is untouched.

#### Static analysis

- **Slither v0.11.5** — 603 findings (vs pass-6's 597). 22 High / 155
  Medium, all classes documented as known false-positives in
  [`.audit_101/PASS6_SLITHER_2026_05_03.md`](./.audit_101/PASS6_SLITHER_2026_05_03.md)
  (timestamp PRNG truncation, FoT-pattern reentrancy-balance,
  `nonReentrant`-protected paths Slither's CEI heuristic can't see, strict
  uint equality on counters). Zero net-new actionable findings vs pass-6
  baseline; the LENDING-04 bug is a semantic state-desync that static
  analysis cannot detect — only stateful invariant testing surfaces it.
- **Aderyn** — installation blocked by Windows AppControl on the dev
  workstation; deferred. Slither remains the canonical static-analysis
  surface; the new stateful invariant suite covers what static analysis
  cannot.

### Security — pass-6 fresh-eyes audit (2026-05-03)

Meta-audit informed by 2024-2026 DeFi exploit retrospectives (Curve / Euler /
Conic / KyberSwap Elastic / Onyx / Penpie / Jimbos / Radiant / BonqDAO /
Hundred / Velocore / Atlantis / Munchables / BlueBerry / Pendle / Sturdy /
Inverse / Platypus / Poly Network) re-aimed at the cumulative 388-finding
history of passes 1–5. Surfaced 5 NEW contract HIGHs + 5 NEW contract MEDs +
1 frontend CRIT + 5 frontend HIGHs + 1 frontend LOW — all closed. Master report:
[`.audit_101/PASS6_2026_05_03.md`](./.audit_101/PASS6_2026_05_03.md).

#### Fixed — Contract HIGHs (5)

- **LD-NEW-H1** — `TegridyLending.pullEscrowRewards` no longer drains a NEW
  active loan's per-tokenId rewards via a stale `loanId` on the same tokenId.
  Closed by `staking.ownerOf(loan.tokenId) == address(this)` gate at
  [TegridyLending.sol:1620-1633](contracts/src/TegridyLending.sol#L1620). Commit `722d1f1`.
- **LD-NEW-H1 mirror** — `TegridyRestaking.claimResidualForTokenId` refuses
  to drain `unsettledRewardsByTokenId` while the NFT is escrowed at another
  tracked holder (lending). Returns 0 paid + emits
  `ResidualPullDeferredCrossHolder`. Closed at
  [TegridyRestaking.sol:1163-1195](contracts/src/TegridyRestaking.sol#L1163). Commit `8266289`.
- **LD-NEW-H2** — `TegridyNFTLending` outbound NFT leg
  (`repayLoan` / `claimDefault`) verifies the NFT actually moved
  post-`transferFrom`. Silent no-op malicious collections trigger
  `stuckCollateralRecipient` + `CollateralRedirected` event. New
  `_safeOutboundTransfer` helper at
  [TegridyNFTLending.sol:755-771](contracts/src/TegridyNFTLending.sol#L755);
  call sites at [L620 + L697](contracts/src/TegridyNFTLending.sol#L620). Commit `722d1f1`.
- **TWAP HIGH-2** — `consult()` reverts `PairDisabled` when the factory has
  `disabledPairs[pair] = true`. Closed at
  [TegridyTWAP.sol:472](contracts/src/TegridyTWAP.sol#L472). Commit `722d1f1`.
- **TWAP HIGH-3** — first observation on a new pair is now stamped
  `bypassed = true` so the bootstrap rolls out of any consult lookup window
  before consumers trust it. Closed at
  [TegridyTWAP.sol:309-331](contracts/src/TegridyTWAP.sol#L309). Commit `722d1f1`.
- **SwapFeeRouter HIGH-4** — multi-hop branches in `convertTokenFeesToETH`
  (and the FoT variant) invalidate `lastConversionSnapshot[token]`. Forces
  the next 2-hop call into the bootstrap (owner-only) path. Closed at
  [SwapFeeRouter.sol:1554-1563](contracts/src/SwapFeeRouter.sol#L1554) and
  [SwapFeeRouter.sol:1652-1660](contracts/src/SwapFeeRouter.sol#L1652). Commit `722d1f1`.

#### Fixed — Contract MEDs (5)

- **PASS5-PA-L1** (promoted from pass-5 LOW) — `PremiumAccess.subscribe`
  extension no longer double-counts `consumedEscrow` into `totalRevenue`.
  Closed at [PremiumAccess.sol:309-330](contracts/src/PremiumAccess.sol#L309). Commit `722d1f1`.
- **N-1 GaugeController orphan** — `proposeRemoveGauge` reverts with new
  `error GaugeRemovePending()` when a prior `executeRemoveGaugeNextEpoch`
  left `pendingGaugeRemove != 0`. Closed at
  [GaugeController.sol:201,788](contracts/src/GaugeController.sol#L201). Commit `722d1f1`.
- **F-1 Restaking under-credit** — `_boostedAmountAt` historical lookups for
  `_timestamp < liveLockEnd` now return `cached` directly. Restores honest
  historical accounting in the kick-window without reopening DR-04
  over-credit. Closed at
  [TegridyRestaking.sol:486-512](contracts/src/TegridyRestaking.sol#L486). Commit `722d1f1`.
- **F-2 Restaking attribute-cap** — `executeAttributeStuckRewards` subtracts
  `totalActivePrincipal` AND `totalPendingUnsettled` from the unattributed
  pool, not just `totalUnforwardedBase`. Closed at
  [TegridyRestaking.sol:1389-1408](contracts/src/TegridyRestaking.sol#L1389). Commit `722d1f1`.
- **LD-NEW-M4** — `TegridyLending` TWAP staleness gates add directional
  pre-checks (`latest.timestamp > block.timestamp` → typed `OracleStale`)
  so clock-skewed feeds do not underflow checked-math. Closed at
  [TegridyLending.sol:1245,1256](contracts/src/TegridyLending.sol#L1245). Commit `722d1f1`.
- **MEDIUM-5** — `POLAccumulator.HARVEST_TWAP_DEVIATION_BPS` narrowed
  200 → 50 bps to align with `TWAP_SAFETY_BPS`. Closed at
  [POLAccumulator.sol:131](contracts/src/POLAccumulator.sol#L131). Commit `722d1f1`.

#### Fixed — Frontend (1 CRIT + 5 HIGH + 1 LOW)

- **FE-HIGH-01** — TegridyDropV2 `mint()` ABI corrected from 2-arg to
  3-arg (`mint(uint256 quantity, uint256 allowedAmount, bytes32[] proof)`).
  `useNFTDropV2.mint()` accepts an optional `allowedAmount` (default 0
  preserves PUBLIC-mint callers). Closed in
  [frontend/src/lib/contracts.ts:420-421](frontend/src/lib/contracts.ts#L420)
  and [frontend/src/hooks/useNFTDropV2.ts](frontend/src/hooks/useNFTDropV2.ts). Commit `b1fb6d4`.
- **FE-HIGH-02** — SIWE client sets `expirationTime` (5-min) and `notBefore`
  (30s skew tolerance) so the server's `verifySignature` accepts payloads
  instead of returning HTTP 400. Closed in
  [frontend/src/nakamigos/lib/siweAuth.js:41-60](frontend/src/nakamigos/lib/siweAuth.js#L41). Commit `b1fb6d4`.
- **FE-LOW-04** — `useLPFarming` + `useNFTDropV2`
  `useWaitForTransactionReceipt` pin `chainId: CHAIN_ID`. Commit `b1fb6d4`.
- **FE-CRIT-01** — Seven `vercel.json` aggregator open-proxy rewrites
  (`/api/{odos,cow,lifi,kyber,openocean,paraswap,swapapi}/*`) replaced by
  Vercel serverless wrappers under `frontend/api/{provider}/[...path].js`.
  Shared infra at `frontend/api/_lib/aggregator-proxy.js` enforces seven
  gates: method allowlist, origin allowlist (fail-closed in prod), Upstash
  sliding rate limit (60/min/IP), exact-prefix path allowlist with
  decode-then-check (`%2F..%2F`-safe), 32 KB body cap + 5 MB response cap,
  per-provider query allowlist (no apiKey/cookie/auth forward), response
  cleanup (no Set-Cookie/Authorization echo, opaque 502 on upstream non-2xx).
  53 NEW tests in `frontend/api/__tests__/aggregator-proxy.test.js`; full
  api/ suite green (13 files, 169 tests). Commit `975e5af`.
- **FE-HIGH-03** — SwapAPI quote routed through same-origin `/api/swapapi/*`
  so the third party no longer sees user wallet/IP/referer. Closed in
  [frontend/src/lib/aggregator.ts:86](frontend/src/lib/aggregator.ts#L86). Commit `4b3a47f`.
- **FE-HIGH-04** — DCA hardcoded 5% slippage replaced by per-schedule
  `slippageBps` field bounded to `[10, 300]` bps (0.1%-3%) and defaulted to
  50 bps. UI presets+custom input + storage validator updated. Closed in
  [frontend/src/hooks/useDCA.ts](frontend/src/hooks/useDCA.ts) and
  [frontend/src/components/swap/DCATab.tsx](frontend/src/components/swap/DCATab.tsx). Commit `4b3a47f`.
- **FE-HIGH-05** — Limit-order minOut now derived from on-chain
  `getAmountsOut` re-quote at execute-time:
  `minOut = min(targetDerivedMinOut, onChainOut * (1 - slippage))`. Stale-
  target gate aborts unsatisfiable orders. Default slippage lowered 5% → 1%.
  Closed in
  [frontend/src/hooks/useLimitOrders.ts:284](frontend/src/hooks/useLimitOrders.ts#L284). Commit `4b3a47f`.
- **FE-HIGH-06** — Custom-token decimals/symbol verified via
  `publicClient.readContract` on hydration + add; mismatches evicted with
  toast. `useSwapAllowance` refuses `approve(MAX_UINT256)` for tokens NOT in
  `DEFAULT_TOKENS` (falls back to exact-amount approval). Permanent
  unverified-token banner. Closed in
  [frontend/src/hooks/useSwap.ts](frontend/src/hooks/useSwap.ts),
  [frontend/src/hooks/useSwapAllowance.ts](frontend/src/hooks/useSwapAllowance.ts),
  [frontend/src/pages/TradePage.tsx](frontend/src/pages/TradePage.tsx). Commit `4b3a47f`.

#### Tests

- New regression suite at
  [`contracts/test/Pass6_Regressions.t.sol`](contracts/test/Pass6_Regressions.t.sol)
  — 4 unit-style PoCs covering the 3 NEW HIGHs:
  `test_LD_NEW_H1_oldLoanCannotDrainNewLoanCredits`,
  `test_LD_NEW_H1_mirror_residualClaimantBlockedByLendingEscrow`,
  `test_LD_NEW_H2_silentNoOpRepay_marksStuck`,
  `test_TWAP_HIGH_2_consultRevertsWhenPairDisabled`. Commit `21db70b`.
- New invariant suites at
  [`contracts/test/invariants/Pass6_*.t.sol`](contracts/test/invariants/) — 4 NEW
  files containing 13 stateful-invariant tests locking down the pass-6 fix
  surfaces under randomized adversarial sequences (256 runs × 500 calls each):
  - `Pass6_LendingSolvency.t.sol` — INV-E (3 invariants)
  - `Pass6_DropV2SupplyConservation.t.sol` — INV-G (5 invariants)
  - `Pass6_RestakingResidualCrossProto.t.sol` — INV-H (2 invariants)
  - `Pass6_TWAPFirstObsBypass.t.sol` — INV-I (3 invariants)
  - **1.664M total stateful calls · 0 reverts · ~210s wall clock** · commit `7889f25`.
- 198 affected-scope tests pass for the unit suite.

#### Polish / cleanup (commits `378d70d`, `eed1c65`)

- Deleted two confirmed dead-code helpers — `CommunityGrants._countActiveProposals`
  and `RevenueDistributor._getRestakedAmount` — flagged by the slither pass and
  verified zero-callers via repo-wide `Grep`. Per
  `contracts/src/.slither.deadcode-suppress.md`'s own "delete it, do not suppress"
  guidance.
- Cleaned `slither.config.json` schema — stripped 7 documentary `_*` keys + an
  inert 43-entry `detectors_to_run` array that Slither v0.11.5 rejects as
  "unknown key". Rationale moved verbatim to a new `slither.config.notes.md`
  audit-trail doc. Eliminates "unknown key" warnings on every CI run.
- `AUDITS.md` "Internal AI-agent reviews" count corrected `8 → 10` (pass-5 +
  pass-6); lineage line enumerates the 6 modern passes.
- `FIX_STATUS.md` framing refreshed to acknowledge the 6-pass audit lineage
  and surface the cumulative 405-finding closure count near the top.

#### Deferred

None — every initially-deferred item from `b1fb6d4`'s commit body
(FE-CRIT-01, FE-HIGH-3/4/5/6) landed during the same pass via parallel-agent
commits `975e5af` and `4b3a47f`. Pass-6 closes its scope cleanly.

### 2026-04-26 — Post-remediation audit campaign (3 Crit + 7 High + 5 Med + 2 EIP-170 splits)

#### Summary

A focused multi-pass audit + remediation campaign that discovered the prior
R017/R020/R023/R028 doc-claimed remediations had not actually shipped to
`main`, then closed those gaps plus 4 additional confirmed Mediums plus 2
EIP-170 deployability blockers (TegridyStaking + SwapFeeRouter both exceeded
the 24,576-byte mainnet limit). Reference
[`.audit_101/POST_REMEDIATION_LEDGER.md`](./.audit_101/POST_REMEDIATION_LEDGER.md)
for the full per-finding breakdown.

#### Critical (3)

- **C-1** TegridyDropV2: legacy single-step `setMerkleRoot(bytes32)` replaced
  with timelocked `proposeMerkleRoot` / `executeMerkleRoot(bytes32)` /
  `cancelMerkleRoot` (24h delay, value-bound, phase-gated to CLOSED /
  CANCELLED / paused only). Replaces R023 H-01 doc-claimed-but-unshipped fix.
- **C-2** TegridyStaking: `MAX_POSITIONS_PER_HOLDER` lowered 100 → 50 to halve
  every external integrator's `votingPowerOf` gas cost (ReferralSplitter,
  RevenueDistributor checkpoint-fallback path, governance consumers).
- **C-4** VoteIncentives: zero-vote epoch bribes were permanently locked
  (refundOrphanedBribe required un-snapshotted epoch; claimBribes rejected
  on zero votes). Added `refundUnvotedBribe(epoch, pair, token)` —
  permissionless per-depositor pull, gated by 14-day grace after revealDeadline.
  Replaces R020 H-1.

#### High (7)

- **H-1 / H-1b** TegridyFactory: `setGuardian` was a 1-step setter with no
  validation. Replaced with `proposeGuardianChange` / `executeGuardianChange`
  (48h timelock); legacy `setGuardian` remains for the initial post-deploy
  set only (`guardian == address(0)` gate). Replaces R028 H-01.
- **H-2** TegridyFactory: `emergencyDisablePair` previously cancelled ANY
  pending PAIR_DISABLE_CHANGE proposal — including governance-queued disables.
  Now only cancels pending RE-ENABLE proposals; pending DISABLEs are
  preserved (governance audit trail intact, circuit-breaker still effective).
- **H-5** TegridyFeeHook: `executeSyncAccruedFees` legacy
  `if (actualCredit > old) revert SyncReductionTooLarge()` blocked all
  upward sync corrections, leaving no recovery path for accruedFees drifting
  below true PoolManager balance. Now allows upward sync bounded by
  `IPoolManager.balanceOf(this, currencyId)` (tamper-proof on-chain credit).
- **H-7** TegridyRestaking: `decayExpiredRestaker` reordered per R017 RETRY
  (settle → shrink `totalRestaked` → `_accrueBonus()` → re-anchor). Honest
  restakers no longer underearn during the lock-expiry window. CEI tightened
  (bonusDebt anchored before transfer). Replaces R017 H-3.
- **H-8** TegridyRestaking: per-restaker boost checkpoints via
  `Checkpoints.Trace208`. `boostedAmountAt(_user, _ts)` now returns the
  historical value at `_ts` (via `upperLookup`) instead of the current
  decayed cache. RevenueDistributor restakers no longer silently
  undercompensated post-decay.
- **H-12 / H-12b** VoteIncentives: ERC20 dust deposits (1 wei) could fill
  MAX_BRIBE_TOKENS slots and DoS legitimate bribes. Added
  `DEFAULT_MIN_TOKEN_BRIBE = 1e15` enforced when no per-token min is
  configured. Per-token override via timelocked
  `proposeMinBribeAmount` / `executeMinBribeAmount` (24h delay).
  Replaces R020 H-3.

#### Medium (5)

- **M-2** TegridyTWAP: `DeviationBypassed` event + `lastBypassUsed[pair]`
  mapping surface the rebootstrap-after-dormancy window so consumers (lending,
  POL accumulator, dutch-auction price) can cool-off / require a confirming
  observation.
- **M-16** POLAccumulator: `MIN_BACKSTOP_BPS` raised 5000 → 9000. Caps
  slippage at 10% on the addLiquidityETH leg (was effectively 50%, no
  protection against sandwich attacks).
- **M-24** TegridyStaking: `_splitPenalty` now uses ceiling division so
  sub-wei dust on small early-exit penalties favors stakers (recycle pool)
  rather than treasury.
- **M-28** MemeBountyBoard: `emergencyForceCancel` aggregate-votes branch
  (`totalBountyVotes >= 2x quorum`) now also requires
  `uniqueVoterCount >= MIN_UNIQUE_VOTERS`. Whales alone can no longer
  deadlock bounties.
- **M-30** PremiumAccess: `nonReentrant` added to `batchReconcileExpired`
  for parity with `cancelSubscription`.

#### Architectural fixes (2 EIP-170 splits)

- **TegridyStaking → TegridyStaking + TegridyStakingAdmin**: 29,461 → 22,492
  bytes (saved 6,953; +2,084 margin under EIP-170). All 7 timelocked admin
  triplets moved to the sister contract. Wired via `staking.setStakingAdmin(addr)`.
- **SwapFeeRouter → SwapFeeRouter + SwapFeeRouterAdmin**: 25,930 → 16,735
  bytes (saved 9,195; +7,841 margin). All 9 timelocked admin triplets moved.
  Wired via `router.setSwapFeeRouterAdmin(addr)`.

#### Frontend / indexer integrations

- Restored + extended `frontend/scripts/extract-missing-abis.mjs` to
  generate `TEGRIDY_STAKING_ADMIN_ABI` + `SWAP_FEE_ROUTER_ADMIN_ABI`
  alongside the 8 prior ABIs. Output written to
  `frontend/src/lib/abi-supplement.ts`.
- `frontend/src/lib/constants.ts`: added
  `TEGRIDY_STAKING_ADMIN_ADDRESS` + `SWAP_FEE_ROUTER_ADMIN_ADDRESS`
  placeholders (operators populate post-deploy).
- Indexer subscribes to both admin contracts via shared
  `TimelockAdminMinimalAbi`. ProposalCreated / Executed / Cancelled events
  written to existing `timelockProposal` table with discriminator. Addresses
  sourced from `TEGRIDY_STAKING_ADMIN_ADDRESS` /
  `SWAP_FEE_ROUTER_ADMIN_ADDRESS` env vars.
- `useLPFarming().refreshBoost(target)` action exposed.
  `useAutoRefreshBoost` hook detects boost-not-applied (holdsJBAC && stake &&
  effective < raw * 1.4) and surfaces / auto-fires refresh. Closes F-7.

#### Operator follow-ups

1. Deploy `TegridyStakingAdmin(staking)` + call
   `staking.setStakingAdmin(admin)` (one-shot).
2. Deploy `SwapFeeRouterAdmin(router)` + call
   `router.setSwapFeeRouterAdmin(admin)` (one-shot).
3. Update `frontend/src/lib/constants.ts` admin placeholders with deployed
   addresses.
4. Set indexer env vars `TEGRIDY_STAKING_ADMIN_ADDRESS` +
   `SWAP_FEE_ROUTER_ADMIN_ADDRESS` for production sync.
5. Update `contracts/script/ConfigureFeePolicy.s.sol`
   `SWAP_FEE_ROUTER_ADMIN` constant.

### 2026-04-25 — Wave 1–4 bulletproofing (~80 R-fixes)

#### Summary

Wave 1–4 bulletproofing — ~80 R-fixes; build green; tests pass. Reference
[`.audit_101/MASTER_REPORT.md`](./.audit_101/MASTER_REPORT.md) +
[`.audit_101/DETAILED_REPORT.md`](./.audit_101/DETAILED_REPORT.md) +
[`.audit_101/remediation/REMEDIATION_REPORT.md`](./.audit_101/remediation/REMEDIATION_REPORT.md).
Per-fix change logs at [`.audit_101/remediation/R001.md`](./.audit_101/remediation/R001.md)
through [`R076.md`](./.audit_101/remediation/R076.md).

#### Breaking constructor / behaviour changes (require redeploy)

- **R003** — `TegridyLending` constructor adds `_twap` arg (5→6 args). ETH
  collateral floor now reads `TegridyTWAP.consult()` instead of spot reserves.
- **R015** — `POLAccumulator` constructor adds `_twap` arg (4→5 args) +
  `LPMismatch` factory check that the LP token matches the pair the TWAP watches.
- **R020** — `VoteIncentives` constructor adds `_commitRevealFromGenesis`
  boolean (6→7 args); also adds `refundUnvotedBribe()` (closes Spartan TF-13).
- **R029** — `TegridyNFTLending` no longer auto-whitelists collections at
  construction. Post-deploy must call `proposeWhitelistCollection(addr)` →
  24h timelock → `executeWhitelistCollection(addr)` per collection
  (JBAC / Nakamigos / GNSS).

#### Wave 0 still pending

Per memory `project_wave0_pending.md`: `VoteIncentives` + `V3Features` +
`FeeHook-patch` redeploys plus multisig `acceptOwnership` on 3 contracts
(LP Farming, Gauge Controller, NFT Lending) by Safe
`0x0c41e76D2668143b9Dbe6292D34b7e5dE7b28bfe`. Tracked in
[`docs/WAVE_0_TODO.md`](./docs/WAVE_0_TODO.md) §3.

#### Docs

R008 + R076 + RC3 doc-truth-up sweep across `FAQ.md`, `REVENUE_ANALYSIS.md`,
`SECURITY.md`, `README.md`, `FIX_STATUS.md`, `DEPLOY_RUNBOOK.md`,
`DEPLOY_CHEAT_SHEET.md`, `NEXT_SESSION.md`, `AUDITS.md` — removed fictional
claims (no `burn()` in `Toweli.sol`; no `SWAP_FEE_BPS = 50` constant on
`SwapFeeRouter`; no live Immunefi page; deleted `redeploy-patched-3.sh`),
flagged Wave-0 multisig migration as PENDING.

### 2026-04-19 — Batch 7d: ETH-denominated collateral floor on `TegridyLending`

#### Added

- **`LoanOffer.minPositionETHValue`** — optional ETH floor alongside the
  existing TOWELI floor (addresses audit critique 5.4). `createLoanOffer`
  takes a 5th arg; zero preserves the pre-batch behaviour. `acceptOffer`
  reads `TegridyPair.getReserves()` and reverts `InsufficientCollateralValue`
  when the borrower's position values below the threshold.
- **`ITegridyPair` interface + `pair` / `toweli` immutables** on
  `TegridyLending`. Constructor takes a 4th `_pair` arg; TOWELI orientation
  is resolved at deploy time.
- **`contracts/test/TegridyLending_ETHFloor.t.sol`** — zero-floor no-op,
  floor-met, floor-breached-reverts, same-block sandwich documentation test,
  and a token0/token1 orientation test.
- **`DeployV3Features.s.sol`** — reads `TOWELI_WETH_PAIR` env override for
  the new constructor arg.

#### Notes

- V3Features redeploy is still pending per `docs/WAVE_0_TODO.md`, so the
  breaking ABI change is acceptable and `docs/SECURITY_DEFERRED.md` now
  marks critique 5.4 as partially addressed (spot-reserve risk acknowledged,
  TWAP upgrade still pending).

### 2026-04-19 — Wave 0 status surfaced on /contracts + tracking issue

#### Added

- **Wave 0 status badges** on [`ContractsPage`](frontend/src/pages/ContractsPage.tsx).
  New `redeploy` (orange) and `multisig` (sky-blue) badge types alongside the
  existing `pending` (amber) / `deprecated` (grey) pills, each with a
  one-liner explaining what the user is looking at. A legend block at the
  top of the page mirrors the runbook.
  - **`pending deploy`** — `TegridyLaunchpadV2`. Not yet broadcast; placeholder
    `0x0…0` in `constants.ts`.
  - **`redeploy queued`** — `TegridyFeeHook` (owner stranded on Arachnid
    CREATE2 proxy; constructor patched to accept `_owner`),
    `VoteIncentives` (needs to partner the Wave 0 commit-reveal
    GaugeController), `TegridyLending`, `TegridyLaunchpad (V1)`,
    `TegridyNFTPoolFactory` (V3Features bundle with the H-10 refund-flow
    patch on the TegridyDrop template).
  - **`awaiting multisig`** — `LP Farming`, `Gauge Controller`, `NFT Lending`
    (Wave 0 redeploys live, but the multisig
    `0x0c41e76D2668143b9Dbe6292D34b7e5dE7b28bfe` still has to call
    `acceptOwnership()` on each).
- **`TegridyFeeHook`** now surfaced in the DEX group on `/contracts` (was
  previously only linked from MIGRATION_HISTORY). Constant
  `TEGRIDY_FEE_HOOK_ADDRESS` imported explicitly.
- **Wave 0 outstanding-work section** on MIGRATION_HISTORY.md with the same
  four-bucket breakdown (pending, redeploy-queued, multisig-accept, post-
  deploy wiring) so the UI and doc can't drift.
- **`docs/WAVE_0_TODO.md`** — tick-box checklist mirroring the contracts-
  page badges. Written in GitHub-flavoured Markdown so the body pastes
  straight into a tracking issue labelled `await-wave0` without
  reformatting. Referenced from the `/contracts` legend and from
  `WAVE_0_RUNBOOK.md`.

#### Changed

- `ContractEntry` status union extended from `'pending' | 'deprecated'` to
  `'pending' | 'deprecated' | 'redeploy' | 'multisig'`, plus an optional
  `note` rendered under the contract label for the two new states.

#### Fixed

- **Liquidity pool-stats card transparent** ([LiquidityTab.tsx](frontend/src/components/swap/LiquidityTab.tsx)) —
  removed the full-bleed `ArtImg` backdrop and the `rgba(16,185,129,0.05)`
  emerald tint from the "Your share / Rate / Your LP tokens" card. Border
  stays, card fill is now transparent so the page background shows through.
- **Token Lending tab bar** ([LendingSection.tsx `TabNav`](frontend/src/components/nftfinance/LendingSection.tsx)) —
  `Lend / Borrow / My Loans` were rendered as bare text over the mascot
  art, with the active tab using `text-black` that vanished against dark
  backgrounds. Rewrote to match the NFT Lending pattern: solid black
  container (`rgba(0,0,0,0.85)`), `flex-1` buttons, full-pill `var(--color-stan)`
  background on the active tab, white text on both states.
- **NFT Lending tab bar** ([NFTLendingSection.tsx](frontend/src/components/nftfinance/NFTLendingSection.tsx)) —
  container background bumped from `rgba(13,21,48,0.4)` to
  `rgba(0,0,0,0.85)` for the same reason.

### 2026-04-18 — Wave 0 deploys + V2 launchpad build-out

#### Added

- **Wave 0 mainnet redeploys (6 of 8 contracts)**:
  - `TegridyLPFarming` `0xa7EF711Be3662B9557634502032F98944eC69ec1` — C-01 `MAX_BOOST_BPS_CEILING=45000` live.
  - `TegridyNFTLending` `0x05409880aDFEa888F2c93568B8D88c7b4aAdB139` — C-02 1h grace period live.
  - `GaugeController` `0xb93264aB0AF377F7C0485E64406bE9a9b1df0Fdb` — H-2 commit-reveal live on-chain.
  - `TegridyTokenURIReader` `0xfec9aea42ea966c9382eeb03f63a784579841eb2` — points at v2 staking.
  - `TegridyTWAP` `0xddbe4cd58faf4b0b93e4e03a2493327ee3bb4995` — new 30-min oracle.
  - `TegridyFeeHook` `0xB6cfeaCf243E218B0ef32B26E1dA1e13a2670044` — B7 closed; address ends `0x0044` for V4 `AFTER_SWAP`+`AFTER_SWAP_RETURNS_DELTA` permissions. **Caveat:** initial deploy via Arachnid CREATE2 proxy stranded ownership; constructor patched to accept `_owner` (see Fixed). Redeploy pending.
  - Pending: `VoteIncentives` + `V3Features` (5 contracts) — blocked on deployer ETH top-up.
- **V2 Launchpad contracts (compiled + tested, deploy pending)**:
  - [TegridyDropV2.sol](contracts/src/TegridyDropV2.sol) — ERC-7572 `contractURI()`, single `InitParams` struct for atomic clone-init, `ContractURIUpdated` event, `setContractURI` setter.
  - [TegridyLaunchpadV2.sol](contracts/src/TegridyLaunchpadV2.sol) — click-deploy factory. `createCollection(CollectionConfig)` wires name/symbol/supply/royalty/placeholderURI/contractURI/merkleRoot/dutch-auction/initialPhase in one tx. Preserves legacy `CollectionCreated` event topic + emits `CollectionCreatedV2`.
  - [DeployLaunchpadV2.s.sol](contracts/script/DeployLaunchpadV2.s.sol) + [TegridyLaunchpadV2.t.sol](contracts/test/TegridyLaunchpadV2.t.sol) (11 tests pass).
- **NFT Launchpad creator wizard** under `frontend/src/components/launchpad/wizard/` — 5 steps (Connect → Upload → Preview → Fund+Arweave → Deploy), single-reducer state machine, virtualized preview grid via `@tanstack/react-virtual`, per-token `TraitEditor` modal, responsive `WizardStepper`. 45 Vitest reducer tests.
- **Arweave integration via Irys** — permanent storage, artist pays ETH in one session:
  - [irysClient.ts](frontend/src/lib/irysClient.ts) — `WebUploader(WebEthereum).withProvider(window.ethereum)`.
  - [useIrysUpload.ts](frontend/src/hooks/useIrysUpload.ts) — `quote`, `fund`, `uploadFolder`, `uploadJsonFolder` with progress + retry-friendly errors.
  - [useWizardPersist.ts](frontend/src/hooks/useWizardPersist.ts) — throttled localStorage draft; partial-upload resume (re-funding skipped, completed sub-uploads skipped).
  - [nftMetadata.ts](frontend/src/lib/nftMetadata.ts) — CSV parser (Thirdweb headers, 16-attribute pairs), OpenSea token + contractURI builders, validators (25 Vitest tests).
  - [frontend/public/sample-collection.csv](frontend/public/sample-collection.csv) + "Download template" link in Step 2.
  - npm: `@irys/web-upload`, `@irys/web-upload-ethereum`, `@tanstack/react-virtual`, `papaparse`.
- **V2 detail + admin surfaces**:
  - [useNFTDropV2.ts](frontend/src/hooks/useNFTDropV2.ts) — parallel v1 hook with Arweave `contractURI()` fetch, 8s AbortController timeout, graceful fallback.
  - [CollectionDetailV2.tsx](frontend/src/components/launchpad/CollectionDetailV2.tsx) — banner hero from Arweave JSON, phase indicator, paused banner, mint panel with allowlist proof, owner-only admin.
  - [OwnerAdminPanelV2.tsx](frontend/src/components/launchpad/OwnerAdminPanelV2.tsx) — setContractURI, Dutch auction builder, pause/unpause, ownership transfer.
- **Tabbed pages** (TradePage pattern):
  - [LearnPage.tsx](frontend/src/pages/LearnPage.tsx) — Tokenomics / Lore / Security / FAQ under one route.
  - [ActivityPage.tsx](frontend/src/pages/ActivityPage.tsx) — Points / Gold Card / History / Changelog under one route.
- **V2 wagmi hooks** — [wagmi.config.ts](frontend/wagmi.config.ts) includes `TegridyLaunchpadV2` + `TegridyDropV2`. `TEGRIDY_LAUNCHPAD_V2_ABI` + `TEGRIDY_DROP_V2_ABI` exported. `TEGRIDY_LAUNCHPAD_V2_ADDRESS` placeholder until broadcast; frontend gates reads on `isDeployed()` so no reads fire at zero address.
- **Docs**: [LAUNCHPAD_GUIDE.md](docs/LAUNCHPAD_GUIDE.md) (creator walkthrough), [LAUNCHPAD_V2_ARCHITECTURE.md](docs/LAUNCHPAD_V2_ARCHITECTURE.md) (dev reference), [LAUNCHPAD_V2_NOTES.md](docs/LAUNCHPAD_V2_NOTES.md) (post-deploy flip checklist).

#### Changed

- **Nav IA**: Top nav "Lending" → "NFT Finance". "More" dropdown pruned to Gallery / Tokenomics / Changelog (Points, Gold Card, History, FAQ, Lore, Security still URL-reachable via their tabbed host pages).
- **Top bar theme**: Black in dark mode (default), orange in light mode. Artwork covers full viewport behind the bar.
- **Collateral filter pills** in NFT Lending Borrow tab — resized to aspect-square cards with name + symbol labels, matching the Lend-tab selector.
- **LaunchpadSection** — lists v1 + v2 collections from both factories, `V1`/`V2` chips, detail routing by version tag.
- **Tabbed page hosts** — top padding bumped to `pt-32` on TokenomicsPage, SecurityPage, FAQPage, LeaderboardPage, PremiumPage, HistoryPage, ChangelogPage so content headings clear the sticky tab bar.
- **CONTRACTS.md / README.md / MIGRATION_HISTORY.md** — Wave 0 addresses updated with deprecated→canonical pairs and FeeHook ownership caveat.
- **indexer/ponder.config.ts** — `LPFarming` address swapped to Wave 0 redeploy.

#### Fixed

- **TegridyFeeHook constructor** now accepts `address _owner` instead of `msg.sender` from `OwnableNoRenounce`. Prevents CREATE2-proxy deploys from stranding ownership on the Arachnid factory (which was the failure mode of the 2026-04-18 broadcast at `0xB6cfeaCf…0044`). Tests + 3 audit-t files updated.
- **DeployTegridyFeeHook.s.sol** — rewritten to consume pre-computed `CREATE2_SALT` mined off-chain via `cast create2 --ends-with 0044`, bypassing the in-EVM miner's `MemoryOOG` at ~180k iterations. Runs in milliseconds; includes `require(hook.owner() == hookOwner)` post-deploy check.
- **LaunchpadSection `CARD_BG` undefined** — referenced in two JSX blocks but never declared; crashed the Launchpad tab. Added `const CARD_BG = 'rgba(6, 12, 26, 0.80)'`.

### Added
- **Commit-reveal voting at the contract layer** ([GaugeController.sol](contracts/src/GaugeController.sol)) —
  `commitVote`, `revealVote`, `computeCommitment`, `isRevealWindowOpen` with
  24h reveal window. Hash binds voter + tokenId + gauges + weights + salt +
  epoch; only the committer can reveal; NFT transfer forfeits vote. 14 new
  tests in [GaugeCommitReveal.t.sol](contracts/test/GaugeCommitReveal.t.sol).
  Closes audit H-2.
- **Commit-reveal UI** in [GaugeVoting.tsx](frontend/src/components/GaugeVoting.tsx)
  with mode toggle, localStorage salt persistence, pending-reveal banner,
  missing-salt warning.
- **Drop refund UI** on [CollectionDetail.tsx](frontend/src/components/launchpad/CollectionDetail.tsx)
  when sale is cancelled. Red banner + Claim Refund button bound to
  `paidByUser > 0`. Closes H10.
- **TegridyTWAP third-oracle leg** in [useToweliPrice](frontend/src/hooks/useToweliPrice.ts) —
  30-minute TWAP cross-checks pair-reserve spot price; divergence beyond 2%
  flips to TWAP (manipulation-resistant). `twapOverrideActive` signal exposed
  to consumers.
- **GitHub surface:** LICENSE (MIT), NOTICE.md (third-party attributions +
  South Park fair-use statement), HALL_OF_FAME.md, .gitattributes, .nvmrc,
  FUNDING.yml, dependabot.yml, CodeQL workflow, Slither workflow, contracts-ci
  workflow, release workflow.
- **Docs:** MIGRATION_HISTORY.md (canonical vs deprecated addresses),
  DEPRECATED_CONTRACTS.md (orphans: TegridyFarm, FeeDistributor, WithdrawalFee),
  TOKEN_DEPLOY.md (how TOWELI was deployed + CREATE2 vanity notes),
  GOVERNANCE.md (admin-key threat model + multisig roadmap), DEVELOPING.md,
  DEPLOYMENT.md, API.md, SOCIAL_PREVIEW_SPEC.md (tracked).
- **Toweli.sol source** ([contracts/src/Toweli.sol](contracts/src/Toweli.sol)) +
  reference [DeployToweli.s.sol](contracts/script/DeployToweli.s.sol). Closes
  the biggest audit-trail gap: the live token at `0x420698…78F9D` now has a
  verifiable source in-repo.
- **ConnectPrompt** primitive for wallet-gated empty states on Farm / Lending /
  Trade / Governance surfaces.
- **YieldCalculator** — wallet-less estimator on HomePage so first-time
  visitors see expected yield before committing.
- **Icon primitive** under `components/ui/Icon.tsx` with locked stroke-width.
- **copy.ts** — centralises every character-named string (Randy / Towelie /
  DEA / Cartman) so a rebrand is a single-file diff.
- **Social preview banner** at [docs/banner.svg](docs/banner.svg) +
  `frontend/public/og.svg`; README renders it as hero.
- **README badges:** CI / CodeQL / Slither / License / Solidity / Chain.
- **Scripts:** `redeploy-patched-3.sh`, `diff-addresses.ts`,
  `extract-missing-abis.mjs`.
- **ABI supplement** ([frontend/src/lib/abi-supplement.ts](frontend/src/lib/abi-supplement.ts)) —
  8 missing contracts extracted from forge artifacts.
- **txErrors helper** with viem `UserRejectedRequestError` handling +
  `shortMessage` extraction.
- **Vercel security headers:** HSTS → 2y + preload, X-Permitted-Cross-Domain-
  Policies, Cross-Origin-Opener-Policy, Cross-Origin-Resource-Policy,
  extended Permissions-Policy opt-out.

### Changed
- **Nav IA:** top nav cut from 21 routes to 5 primary (Dashboard / Farm /
  Trade / Lending / Governance); mobile mirrors desktop; Footer organised
  into Product / Resources / Community / Legal columns.
- **Meme voice shipped across product** via copy.ts: receipt labels
  ("LOCKED DOWN, WITH TEGRIDY", "HARVEST COMPLETE", "TEGRIDY REGISTERED"),
  lock durations ("The Taste Test" → "Till Death Do Us Farm"), penalty
  reframe ("DEA Raid Tax — for the kids' college fund"),
  [VoteIncentives](frontend/src/components/community/VoteIncentivesSection.tsx)
  section → "Cartman's Market — Totally Not Bribes", FAQ opener rewritten.
- **Nav link contrast** fixed: `#d4a843` (2.8:1, fails WCAG AA) →
  `#f5e4b8` (13.5:1, AAA). Light mode → `#4c1d95` (10.4:1, AAA).
- **Mobile tables → cards** below 480px on BoostScheduleTable and
  ContractsPage with 44×44 tap targets.
- **TransactionReceipt** labels re-sourced from [copy.ts](frontend/src/lib/copy.ts).
- **HomePage audit badge** with link to `/security`.
- **iPhone 14 Pro safe-area:** new `.pb-safe` utility using
  `env(safe-area-inset-bottom)`.
- **isPending guards** on AMMSection (3 buttons); NFTLendingSection already
  had them.
- **useToweliPrice** silent `.catch(() => {})` replaced with scoped
  `console.warn` (ignoring expected AbortError).
- **README rewritten** as an investor-grade reference with elevator pitch,
  TOC, user flow, dev flow, honest audit status.
- **FAQ boost claim** corrected from stale "2.5×" to accurate "0.4×–4.0× +
  0.5× JBAC = 4.5× ceiling".
- **Manifest icon** fixed: broken `skeleton.jpg` refs replaced with existing
  `/splash/icon-192.png` + `/splash/icon-512.png` (added `any maskable`).
- **Sitemap.xml** gets `lastmod` + `changefreq` on every URL; `/contracts`
  and `/treasury` added.
- **usePageTitle** extended with canonical `<link>`, `og:url`, `twitter:url`,
  `twitter:title`, `twitter:description`, and per-page `og:image` override
  (backward-compatible signature).
- **TegridyDrop ABI fix:** `currentPhase` → `mintPhase` (contract-canonical;
  the prior entry reverted on-chain). Added `cancelSale`, `refund`,
  `paidPerWallet`.
- **Indexer TegridyStaking address** fixed from stale v1 `0x65D8…a421` to
  canonical v2 `0x6266…4819` in [ponder.config.ts](indexer/ponder.config.ts).
- **Frontend package.json + indexer/package.json:** added `"license": "MIT"`
  and `"engines": { "node": ">=20.0.0" }`.
- **OwnerAdminPanel Danger Zone** — `cancelSale()` wired with
  `window.confirm` double-prompt.

### Fixed
- Stale contract addresses in 4 deploy scripts (Gap A sed — `0x65D8…` →
  `0x6266…`).
- `TegridyLPFarming.exit()` added — frontend's existing `useLPFarming.exit()`
  call no longer reverts.
- `TegridyNFTLending` added `GRACE_PERIOD = 1 hours` to `repayLoan` +
  `claimDefault`.
- `TegridyDrop`: added `MintPhase.CANCELLED`, `cancelSale()`, `refund()`,
  `paidPerWallet` tracking, `SaleCancelledEvent` + `Refunded` events.
- `ConstantsPage` navigation link routes corrected to SPA `<Link>`.
- `HistoryPage`: fetch cap raised 50 → 500, added 25-per-page pagination,
  resets on wallet change.
- `SecurityPage`: removed the inflated "5C/13H/26M/38L — all resolved"
  block; replaced with honest links to audit files.
- `ChangelogPage`: softened "Fixed all v4 audit findings" claim.
- `useLPFarming`: chain-id guard + proactive allowance check.
- `useSwapQuote`: `useChainId` wired so quotes don't fire on non-mainnet.
- Supabase migration 002: creates `native_orders`, `trade_offers`,
  `push_subscriptions` (tables were referenced but never created).

### Deferred
- **Indexer expansion** (GaugeController events, bounty submissions/votes,
  grants cancel/lapse/refund, restaking tombstone fix) — blocked by
  pre-existing Ponder `Virtual.Registry` TypeScript inference ceiling.
  Comment-form scaffolding retained for future re-enable. Consumers query
  contract state directly via wagmi until then.
- **Full nonce-based CSP** — requires Vite plugin tooling to inject nonces
  per inline script. Deferred in favour of additional security headers that
  don't break the build.
- **OG banner PNG export** — SVG ships now for modern social crawlers;
  PNG conversion for legacy compatibility is a follow-up.

### Removed
- `contracts/src/LPFarming.sol`, `DeployLPFarming.s.sol`, `LPFarming.t.sol`
  (superseded by `TegridyLPFarming`).
- `frontend/src/assets/{hero.png, react.svg, vite.svg}` (Vite starter
  cruft).
- `frontend/src/components/PageTransition.tsx` (unimported).

## [v3.0.0-pre] - 2026-04-17

Scope: fee split + NFT lending grace + drop refund + Gap-A sed sweep + Gap-B
LP farming selection + H-2 commit-reveal voting + Upstash rate limiting.

### Added
- Commit-reveal voting implementation (H-2) in contracts (a2cdcad).
- Real per-IP API rate limiting via Upstash Redis (API-M1) (dd1cf22).
- `DeployTegridyLPFarming` script for C-01 fixed farm (batch 23) (2e0eeae).
- `DeployTokenURIReader` folded into Gap A sed sweep (4f323fe).
- Paste-ready deploy cheat sheet (batch 22) (9c1d713).
- Pre-deploy runbook for audit remediation (batch 17) (414f489).
- TradePage E2E spec and overlay dismiss fixture (batch 16) (25014a0).
- E2E wallet-integrated test foundation (C-05) (d4967ad).
- H-2 commit-reveal design spike and API/indexer audit docs (895bd86).

### Changed
- Gap B locked to B2 — `TegridyLPFarming` selected as canonical farm (fca56a6).
- Gap A locked to A1 — `TokenURIReader` folded into the sed sweep (4f323fe).
- `framer-motion` refactored to `LazyMotion` across 45 files for bundle size
  reduction (batch 19) (a1f6afe).
- `ParticleBackground` and `GlitchTransition` lazy-loaded (batch 15) (3741cf2).
- Lending safety caps moved to timelocked state (TF-06 + H-05) (c0be03d).
- NFT Finance tab added to mobile nav; dashboard outstanding loans surfaced
  (9e8d667).

### Deprecated
- Legacy `LPFarming.sol` deprecated in favor of `TegridyLPFarming.sol`
  (Gap B decision, fca56a6).

### Removed
- `LPFarming.sol`, `DeployLPFarming.s.sol`, `LPFarming.t.sol` removed during
  Gap B consolidation (working tree).
- Inner `Suspense` that broke CSS preload on Nakamigos page (85eda15).
- `modulePreload` polyfill disabled to fix CSS preload crash (1c2ad9d).

### Fixed
- API batch 18: M2 filter regex + M8 SameSite cookie tightening (adcf5d4).
- Indexer batch 14: INDEXER-H1/M1/M2 fixes (3f2dac1).
- API batch 13: six API fixes from `API_INDEXER_AUDIT.md` (4859a4d).
- Frontend batch 12: E2E foundation runs (2 baseline + 1 new-spec) (a200130).
- Frontend batch 10: Spartan TF-03 claim-before-withdraw + contrast sweep
  (45a353d).
- Contracts batch 9: lending safety caps timelocked (TF-06 + H-05) (c0be03d).
- Contracts batch 8: five Spartan MEDIUM/LOW quick-win fixes (6e818e9).
- Contracts batch 7: six HIGH/MEDIUM fixes across Restaking, Factory, Lending,
  Routers (c782293).
- Contracts batch 6: cleared all 16 pre-existing test failures, 1 real bug
  fix (6ed299a).
- Contracts batch 5: lending transfer-gate whitelist (H-01), drop hardening
  (H-10/H-11) (3a6c198).
- Frontend batch 4: Privacy Policy accuracy (C-03) + SecurityPage audit
  links (2cf5135).
- Frontend batch 3: modal aria, tooltip keyboard, mint re-entry, targeted
  contrast (e30df41).
- Contracts batch 2: `TegridyLPFarming` ABI mismatch (C-01), `createOffer`
  guard (ab16308).
- Frontend batch 1: chain-aware explorer, validation, a11y, focus trap
  (434a4ab).
- Step-circle centering and dashboard outstanding loans fixed (9e8d667).
- Nakamigos CSS preload crash: CSS import moved to main bundle (714d839).
- `CommunityPage` crash: missing `Suspense` import (ed93506).
- Browser QA: Suspense tag, loader cleanup, text visibility (ae690eb).
- Seven broken lazy imports from deleted pages — `TradePage` swap UI
  rebuilt (bc9cc6b).

### Security
- All security audit findings cleared: C-01, H-01, H-02, M-01–M-04, L-01
  (2f06f84).
- `TegridyRestaking` and `ReferralSplitter` wired up (eab6e4b).
- 100-agent security scan remediation (1493904).
- `GaugeController` deployed to mainnet at
  `0xb6E4CFCb83D846af159b9c653240426841AEB414` (f217b13).
- Immunefi bounty program added alongside Vitest and deploy scripts (d0ac056).

## [v2.x] - earlier

### Added
- Major UX overhaul, security hardening, new contracts, and full audit fixes
  (3d8799b).
- Full NFT Lending UI with 3-tab interface (d578069).
- `NFTLending` + TWAP deployed; audit M-02 WETH fallback on `acceptOffer`
  fixed (629721a).
- Dark/light mode, 138 frontend tests, mobile responsive fixes (fefa250).
- Gauge voting, CSV export, Immunefi bounty, Vitest, deploy scripts (d0ac056).
- Art backgrounds on NFT Finance intro cards (ed0da44).
- Ten strategic recommendations for conversion optimization (5fdcdd4).

### Changed
- Restake combined into Token Lending tab (0f33c02).
- Marketplace splash renamed from Nakamigos to Tradermigos (7fc4bd5).
- Full audit remediation: 17 issues fixed, CI/CD added, wagmi codegen, new
  community UI (8cd9234).

### Fixed
- NFT Lending mobile responsiveness (050e27b).
- Mobile grid layouts collapse to single column on small screens (5f18a96).
- All v4 audit findings: C-02, C-03, C-04, H-01, H-03, M-01, M-04 (4b4d5d3).

[v3.0.0-pre]: https://github.com/fomotsar-commits/tegriddy-farms/tree/main
[v2.x]: https://github.com/fomotsar-commits/tegriddy-farms/commits/main
