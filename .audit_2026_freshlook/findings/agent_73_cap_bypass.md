# Agent 73 — Cap Bypass via Splitting Audit

Lens: aggregate caps and per-user caps that can be bypassed by splitting across
addresses, timestamps, positions, token-IDs, or pools.

Working set: `contracts/src/*.sol` (all 28+ Solidity files inspected).

Format: `F-73-K`. Each finding states file:line, the cap, and the split-bypass.

---

## F-73-1 — TegridyDropV2.maxPerWallet bypassable by sybil EOAs (PUBLIC / DUTCH)

- File: `contracts/src/TegridyDropV2.sol`
- Lines: `185` (storage), `223` (`mintedPerWallet`), `515-517` (enforcement),
  `562` (write).
- Cap: `mintedPerWallet[msg.sender] + quantity <= maxPerWallet`.
- Split-bypass: the cap is keyed on `msg.sender` with NO additional gating
  (no merkle proof, no signature, no AML / sybil deterrent) on the
  `MintPhase.PUBLIC` and `MintPhase.DUTCH_AUCTION` paths. An attacker funds N
  EOAs and mints `maxPerWallet` from each; total acquisition is bounded only
  by `maxSupply` and per-tx `MAX_MINT_PER_TX = 50` (line 48). On public /
  dutch phases there is no allowlist leaf to bind quantity to a specific
  recipient.
- Severity intuition: this is the well-known free-mint cap class. Whether it
  matters depends on commercial intent: many drops accept it as the cost of
  permissionless minting. Worth flagging to creators in NatSpec /
  documentation; not a true protocol-invariant break.
- Mitigation already present: ALLOWLIST phase binds `(drop, minter,
  allowedAmount)` into the merkle leaf (lines 538-548) and `allowlistClaimed`
  is independent of `mintedPerWallet`, so the leaf-level cap holds even if
  `setMaxPerWallet` is bumped. PUBLIC / DUTCH have no equivalent.

## F-73-2 — TegridyDropV2.allowlistClaimed cap is per (msg.sender, leaf), still sybil-bypassable

- File: `contracts/src/TegridyDropV2.sol`
- Lines: `242` (`allowlistClaimed` mapping), `538-548` (leaf check + write).
- Cap: per-leaf `allowedAmount`; mapping keyed by `msg.sender`.
- Split-bypass: distinct addresses with distinct leaves can claim
  independently. If the off-chain merkle tree is constructed naively (one
  leaf per address with allocation N), nothing on-chain prevents a creator
  team / insider / collusion ring from listing N sybil addresses. The
  contract correctly enforces per-leaf consumption — the bypass surface is
  off-chain merkle construction, not on-chain logic.
- Treat as informational: documents the off-chain trust requirement.

## F-73-3 — TegridyStaking.MAX_POSITIONS_PER_HOLDER bounds count, not value

- File: `contracts/src/TegridyStaking.sol`
- Lines: `218` (`MAX_POSITIONS_PER_HOLDER = 50`), `1337` (enforcement),
  `204-214` (rationale).
- Cap: 50 positions per address.
- Split-bypass (intent-aligned): the cap is gas-budget protection, NOT an
  economic anti-whale cap. Per-position size is unbounded — a holder can
  stake `MAX_POSITIONS_PER_HOLDER × ∞` TOWELI by sizing each position large.
  This is documented as deliberate (line 207-211: "halving the worst-case
  gas...legitimate multi-position holders accumulate <10").
- Aggregate-value bypass: a whale who wants more than 50 positions can split
  ownership across N controlled addresses (each gets 50 positions). Not
  exploitable because rewards are per-position-amount and voting power
  aggregates from `_positionsByOwner[owner]` (line 206) — sybil splits buy
  zero economic advantage. NOT a real finding; documenting for completeness.

## F-73-4 — TegridyLending: NO per-borrower aggregate borrow cap

- File: `contracts/src/TegridyLending.sol`
- Lines: searched the full file — no `userBorrow*`, `borrowCap`,
  `loansByBorrower`, or aggregate borrower limit anywhere.
- Cap that DOES exist: per-offer `MAX_PRINCIPAL_CEILING` (constant per offer,
  not per borrower) and per-collateral-contract `activeLoansAgainstCollateral`
  (line 244 — counter, not value).
- Split-bypass: a single borrower can accept arbitrarily many offers
  simultaneously (one staking-NFT collateral per loan; staking is capped at
  50 positions per holder so practical max ≈ 50 loans). With 50 positions
  each backing a `MAX_PRINCIPAL_CEILING` loan, one borrower can extract up
  to `50 × MAX_PRINCIPAL_CEILING` in principal at once.
- Why this is design-OK: P2P lending — each loan is collateralized
  independently. A borrower CAN'T overborrow because each loan needs its own
  NFT collateral. Aggregate borrower exposure is bounded by aggregate
  collateral value. No aggregate borrower cap is required and adding one
  would just be UX friction.
- Verdict: not a finding; flagged because the prompt asked specifically for
  "per-user borrow cap → multiple positions per address" — confirmed absent
  by design.

## F-73-5 — TegridyNFTLending: same as F-73-4, per-NFT-collateral, no per-borrower aggregate cap

- File: `contracts/src/TegridyNFTLending.sol`
- Lines: structure mirrors `TegridyLending`. No `userBorrow*` / aggregate
  borrower cap.
- Split-bypass: one borrower with N whitelisted NFTs can take N loans
  simultaneously, principal capped only by per-loan `MAX_PRINCIPAL = 1000
  ether` (line 32).
- Same verdict as F-73-4: P2P lending against unique collateral; aggregate
  borrower cap is structurally unnecessary.

## F-73-6 — TegridyDropV2.MAX_MINT_PER_TX bypassable across transactions

- File: `contracts/src/TegridyDropV2.sol`
- Lines: `48` (`MAX_MINT_PER_TX = 50`), `508` (enforcement).
- Cap: 50 mints per transaction.
- Split-bypass: trivially split across multiple transactions. The aggregate
  is bounded by `maxPerWallet` (per-EOA — see F-73-1) and `maxSupply`
  (global). The per-tx cap is gas/indexer-budget protection, not an economic
  anti-whale cap.
- Verdict: working as intended; NatSpec at line 503-507 explicitly describes
  this as a self-DoS / indexer-bloat bound, not a sybil bound.

## F-73-7 — CommunityGrants.PROPOSAL_COOLDOWN bypassable by sybil proposers

- File: `contracts/src/CommunityGrants.sol`
- Lines: `115` (`PROPOSAL_COOLDOWN = 1 days`), `301-304` (enforcement),
  `403` (write).
- Cap: 1-day cooldown between proposals — keyed by `msg.sender` via
  `lastProposalTimestamp[msg.sender]`.
- Split-bypass: an attacker funds N sybil EOAs (each pays
  `PROPOSAL_FEE = 42_069 TOWELI`, half refundable on rejection) and runs N
  proposals concurrently to fill the `MAX_ACTIVE_PROPOSALS = 50` slot
  pipeline.
- Defense-in-depth that limits the impact:
  - `MAX_ACTIVE_PROPOSALS = 50` global cap (line 141).
  - `MIN_QUORUM_BPS = 1000` (10% of total stake, line 119) + `MIN_ABSOLUTE_QUORUM
    = 4000e18` (line 131) + `MIN_UNIQUE_VOTERS = 3` (line 154) all need to
    pass for ANY proposal — sybil-proposer doesn't help pass without sybil
    voters, and voters use snapshot-pinned voting power (line 150).
  - `lapseStaleProposal` (line 886) is permissionless after `deadline +
    EXECUTION_DEADLINE = 7d + 30d = 37d` — full proposal forfeit goes to
    feeReceiver. Sybil flooding burns 37 days × 50 slots × ½ × 42069 TOWELI
    in non-refundable fees per cycle.
  - `MAX_ROLLING_DISBURSEMENT_BPS = 3000` (30% of treasury per 30 days,
    line 163) caps approved disbursements anyway.
- Verdict: economically defended. The PROPOSAL_COOLDOWN is informational —
  primary defense is the proposal-fee + slot-pipeline + quorum trio.

## F-73-8 — VoteIncentives.MAX_BRIBE_TOKENS per-pair-per-epoch, splittable across pairs

- File: `contracts/src/VoteIncentives.sol`
- Lines: `159` (`MAX_BRIBE_TOKENS = 20`), `690` (enforcement on ERC20),
  `740` (enforcement on ETH).
- Cap: 20 unique tokens per (pair, epoch).
- Split-bypass: the cap is per pair and per epoch. An attacker bribing
  multiple pairs in the same epoch can deposit on each pair independently.
- Why this isn't a real finding: pairs must be GAUGED (line 652
  `_requireGaugedPair`), so the bribed pair must already exist and be
  whitelisted. A briber depositing across 100 gauged pairs is doing exactly
  what the system supports. The 20-token cap is anti-DoS-on-claim-loop
  (storage growth bound), not an anti-economic-domination cap.

## F-73-9 — TegridyNFTPoolFactory.MAX_DAILY_WITHDRAWAL is owner-only — sybil-irrelevant

- File: `contracts/src/TegridyNFTPoolFactory.sol`
- Lines: `41` (`MAX_DAILY_WITHDRAWAL = 1000 ether`), `637` (enforcement),
  `593-642` (full path).
- Cap: 1000 ETH/day on protocol-fee withdrawals.
- Split-bypass: function is `onlyOwner`. Splitting across owner-controlled
  callers is a no-op (still owner-only). 24h window is rolled inside
  `_withdrawWithRateLimit` (line 630) — a single owner cannot mint a fake
  window crossing.
- Verdict: not splittable.

## F-73-10 — TegridyNFTPoolFactory.MAX_POOLS_PER_COLLECTION = 200 is per-collection, not per-creator

- File: `contracts/src/TegridyNFTPoolFactory.sol`
- Lines: `53` (constant), `212` (enforcement).
- Cap: 200 pools per NFT collection.
- Split-bypass attempt: an attacker launching a CLONE collection with
  identical metadata could spawn 200 pools per clone. But the cap protects
  router discovery for ONE collection — discovery for the clone collection is
  a separate enumeration, so cross-collection splitting just creates separate
  router-discovery surfaces without weakening the single-collection cap.
- Verdict: cap target is preserved.

## F-73-11 — ReferralSplitter: MIN_REFERRAL_STAKE_POWER + circular check, but not a value cap

- File: `contracts/src/ReferralSplitter.sol`
- Cap: there is NO per-referrer earnings cap or daily/aggregate cap. Earnings
  accrue indefinitely until claimed. Staking-power gate
  (`MIN_REFERRAL_STAKE_POWER`) is a per-claim eligibility filter, not a value
  cap.
- Split-bypass: N/A — no cap to split. Per-account `pendingETH` is
  unbounded by design (matches Curve / Convex earned-rewards-unconditionally-
  claimable pattern).
- Sybil ring detection: `_checkCircularReferral` (line 314, depth=100) +
  in-memory visited set (line 315-) blocks A→B→…→A cycles up to depth 100.
  Sybil rings of 101+ addresses can technically still build a non-detected
  cycle but each new sybil costs gas + the per-claim
  `MIN_REFERRAL_STAKE_POWER` gate (must hold staked TOWELI to claim each
  sybil's earnings).
- Verdict: not a cap-splitting finding.

## F-73-12 — MemeBountyBoard.MAX_SUBMISSIONS_PER_BOUNTY is per-bounty, splittable across bounties

- File: `contracts/src/MemeBountyBoard.sol`
- Lines: `81` (constant = 100), `434` (enforcement).
- Cap: 100 submissions per bounty.
- Split-bypass: a creator running N bounties accepts up to N×100 submissions
  total. But the cap target is per-bounty griefing
  (`MaxSubmissionsReached`) — splitting across bounties is the legitimate
  use of the system, not a bypass.
- Per-submitter gating: `hasSubmitted[bountyId][submitter]` (line 157)
  enforces ONE submission per address per bounty (line 437); per-submitter
  splitting across bounties is unconstrained because bounties are
  independent jobs.
- Verdict: cap target preserved. Not a splitting finding.

## F-73-13 — Per-bounty `hasVotedOnBounty` cap bypassable by sybil voters

- File: `contracts/src/MemeBountyBoard.sol`
- Lines: `145` (storage), `458` (enforcement).
- Cap: one vote per address per bounty.
- Split-bypass: N sybil EOAs can each vote once. Defense:
  - `MIN_VOTE_BALANCE = 1000 TOWELI` (line 69) — every sybil needs 1000
    staked TOWELI worth of voting power. Snapshot-pinned to
    `bounties[id].snapshotTimestamp` (line 92-93, 250-block lookback) —
    flash-stake amplification doesn't help.
  - `MIN_UNIQUE_VOTERS = 3` (line 72) is UNDER-CAPPED relative to whale
    capture but flips on the sybil — three sybil voters are exactly what
    closes the gate; the M-G02-class fix relies on `MIN_COMPLETION_VOTES =
    3000e18` (line 71) which IS stake-weighted.
  - `SubmitterCannotVote` (line 471) blocks the submit-cross-vote ring (3
    sybil submitters voting for each other).
- Verdict: defended by stake-weight + voter-diversity quorum stack. Sybil
  splits don't economically break it.

## F-73-14 — TegridyRestaking: no per-user restake cap; `AlreadyRestaked` is the splitter

- File: `contracts/src/TegridyRestaking.sol`
- Lines: `597` (`AlreadyRestaked` check).
- Cap: ONE restake per address (`restakers[msg.sender].tokenId != 0`).
- Split-bypass: N sybil EOAs each restake one NFT. Each sybil consumes a
  staking-side NFT (which they had to acquire by staking TOWELI of their
  own — sybils provide their own collateral). Bonus reward share is
  proportional to `boostedAmount`, so sybil-restaking N small NFTs is
  exactly equivalent to one big restake of the same total stake.
- Verdict: not exploitable. Restake-per-address bound is a single-pointer
  bookkeeping constraint, not an economic cap.

## F-73-15 — CommunityGrants.MAX_ROLLING_DISBURSEMENT_BPS = 30% / 30d is GLOBAL, not per-recipient

- File: `contracts/src/CommunityGrants.sol`
- Lines: `163` (constant), `601` (enforcement).
- Cap: 30% of treasury balance disbursable per 30-day rolling window
  (anchored to finalize-time balance per D-CG-M1 fix at line 538).
- Split-bypass: an attacker who controls multiple sybil RECIPIENTS still
  rolls against the same global counter — 30%/30d holds regardless of how
  the funds are split across recipients.
- Per-PROPOSAL split: each proposal is also bounded by `MAX_GRANT_PERCENT_BPS
  = 5000` (50% of available, line 132) and `proposal.absoluteCap` locked at
  creation (line 395). So one big proposal can't sneak past either.
- Verdict: global cap holds against splitting. Confirmed defended.

## F-73-16 — PremiumAccess: no per-address subscription cap; subscriptions are sybil-orthogonal

- File: `contracts/src/PremiumAccess.sol`
- Cap: per-address subscription state. No aggregate per-user cap on extension.
- Split-bypass: N sybil EOAs each pay monthlyFeeToweli for N subscriptions.
  No discount or per-address quota that scales sublinearly — each sub costs
  exactly N × monthlyFee. Splitting is exactly net-zero.
- Verdict: not a cap-splitting finding.

## F-73-17 — GaugeController.hasUserVotedInEpoch enforces per-user cap (not splittable across NFTs)

- File: `contracts/src/GaugeController.sol`
- Lines: `155` (mapping), `324` (enforcement).
- Cap: one vote per (user, epoch).
- Split-bypass attempted: a multi-NFT holder COULD historically vote N times
  per epoch, once per NFT, multiplying their gauge weight. AUDIT C2 (line
  145-155) closed this exact split: per-USER mapping `hasUserVotedInEpoch`
  added. A user splitting NFTs across multiple addresses still pays the cost
  of the split — each address holds only its own snapshot voting power, so
  total weight cast is conserved.
- Verdict: per-user cap is splitter-resistant by design (snapshot + per-user
  flag).

---

## Notes / Dead-Ends

- **No daily/hourly per-user throttle** anywhere in the codebase.
  `lastProposalTimestamp` (CommunityGrants), `lastClaimTime` (ReferralSplitter),
  `lastReferrerChange` (ReferralSplitter), `lastBribeDepositPerUser`
  (VoteIncentives) are all inactivity / cooldown stamps, not "X per Y
  window" rate limits where the X is a value/count quota. Standard
  before/after-threshold timestamp splits (sleep just over the threshold,
  sleep just under) don't apply.
- **TegridyLPFarming**: zero per-user staking cap. Designed Synthetix-style
  with proportional reward share — no cap to split. `aggregateActiveBoostBps`
  reads boost from staking; multi-NFT holders use the AGGREGATE which is
  attacker-neutral.
- **TegridyNFTPool / TegridyNFTPoolFactory**: rate-limited withdrawals are
  owner-side. No user-side rate limits.
- **TegridyRestaking.MAX_BONUS_REWARD_RATE = 100e18** (line 180) is owner-set,
  protected by 48h timelock + 24h action cooldown. Not splittable.
- **TegridyStaking.maxUnsettledRewards = 100_000e18** (line 260) is a GLOBAL
  forfeit cap, not per-user. Once cap is hit, excess goes to treasury on
  reconcile. Not a per-user cap.
- **TegridyFactory.MAX_PAIRS = 10000** (line 73) is global Uniswap-style
  pair-creation cap. Per-creator splitting across factory deploys would just
  create separate factories — cap target preserved per-factory.
- The ALLOWLIST per-leaf cap (TegridyDropV2 line 545) is FIRMLY enforced
  on-chain. The trust assumption migrates off-chain to the merkle-tree
  builder, which is a known design tradeoff and is documented at line 540:
  `leaf = keccak256( bytes.concat( keccak256( abi.encode(drop, minter,
  amount) ) ) )`.

---

## Summary

Out of 17 candidate caps reviewed under the splitting lens, ZERO are real
in-scope vulnerabilities:

- F-73-1, F-73-2 (Drop sybil mints): permissionless mint phases by design;
  off-chain merkle responsibility for allowlist sybils; not a protocol bug.
- F-73-3 (staking position cap): documented as gas-budget bound, not anti-whale.
- F-73-4, F-73-5 (lending: no aggregate borrower cap): correct for P2P,
  per-loan collateralization is the right model.
- F-73-6 (per-tx mint cap): documented self-DoS bound; intentional.
- F-73-7 (proposal cooldown): defended by fee + slot-pipeline + quorum stack.
- F-73-8, F-73-12, F-73-13 (per-X caps splittable across pairs/bounties):
  cap target is per-X by design, splitting is the system's intended use.
- F-73-9 (factory daily cap): owner-only, sybil-orthogonal.
- F-73-10 (pools per collection): cap target preserved.
- F-73-11, F-73-14, F-73-16 (no caps): no caps to split.
- F-73-15 (rolling disbursement): global cap, sybil-recipient-orthogonal.
- F-73-17 (gauge vote cap): per-user flag closes the multi-NFT split (AUDIT C2).

The protocol's defensive posture against cap-splitting is consistently strong.
The historical AUDIT C2 (multi-NFT vote split) and AUDIT M13 / NEW-G7 /
BATCH-E H11 (proposer multi-NFT sybil-vote on CommunityGrants) fixes show
the team has already swept this attack class methodically. No new
exploitable splits identified.
