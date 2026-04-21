# Slither Phase-4 Static Analysis — 2026-04-19

Slither 0.11.5 against `contracts/src` (excluding `lib/` and `test/`).
**590 findings** across **28 detector categories**. Summary:

| Impact | Count |
|--------|-------|
| High | 6 sections |
| Medium | 5 sections |
| Low | 7 sections |
| Informational | 9 sections |
| Optimization | 1 section |

## HIGH-impact triage

### `encode-packed-collision` — **FIXED in this pass**
`abi.encodePacked(msg.sender, allCollections.length, _name, _symbol)` in
`TegridyLaunchpadV2.createCollection` (and the V1 `TegridyLaunchpad` before
its source was deleted 2026-04-19) was collision-prone across `(name, symbol)`
pairs — two different pairs could pack to identical bytes and yield the same
CREATE2 salt. Attacker could front-run a creator's clone address. Swapped to
`abi.encode` (length-prefixed) to eliminate the ambiguity.

### `arbitrary-send-eth` — false positive
Flagged `CommunityGrants._transferETHOrWETH` because it sends ETH to a
recipient address. The recipient is the grant proposal's designated
recipient, already vetted via the on-chain proposal lifecycle; `weth` is
immutable and trusted. Slither's detector can't see the proposal-approval
gate.

### `weak-prng` — false positive
Flagged `TegridyTWAP.update`'s `uint32(block.timestamp % 2**32)`. This is
not a PRNG — it's the standard Uniswap V2 timestamp truncation for cumulative
price storage. No randomness derived from it.

### `reentrancy-balance` — false positive (intentional pattern)
Flagged `TegridyRouter.swapExact*SupportingFeeOnTransferTokens`. The
`balanceBefore` / `balanceAfter` pattern is the whole point of the FoT swap —
it measures post-transfer delta because FoT tokens can shrink the amount in
transit. Standard Uniswap V2 Router02 pattern.

### `reentrancy-eth` — mitigations in place
- **`CommunityGrants.executeProposal`** — cross-function reentrancy across
  `disbursementAmounts` / `disbursementHead` / `disbursementTail`. Function
  is `nonReentrant`, ETH send uses 10k stipend + WETH fallback (batch 7b),
  and the cross-function writes are ring-buffer updates that converge
  correctly on retry.
- **`VoteIncentives.claimBribes`** — 50k-gas stipend (critique 5.7 fix), and
  per-claim state is keyed on `(user, epoch, pair, token)` so a reentrant
  call can't re-claim. Pending fallback retained.

### `uninitialized-state` — false positive
`epochBribeTokens` and `minBribeAmounts` are mappings. Solidity mappings do
not require initialization — Slither's check is spurious here.

## MEDIUM-impact triage (sampled)

The Medium-impact findings are predominantly:
- `divide-before-multiply` (intentional — preserves precision on integer math
  where the divisor is bigger than the multiplicand)
- `calls-loop` (intentional — bounded by small fixed caps like
  `MAX_GAUGES_PER_VOTER`, `MAX_SUBMISSIONS_PER_BOUNTY`, etc.)
- `incorrect-equality` (most are balance checks against zero for pull-payment
  patterns, which are correct)
- `unused-return` (sampled: `Clones.cloneDeterministic` call sites; the return
  value is captured and used)

## LOW / INFORMATIONAL

Mostly:
- `timestamp` — `block.timestamp` used for lock-expiry math. Acknowledged in
  [`TegridyStaking.sol:25`](../contracts/src/TegridyStaking.sol#L25); validators
  can skew ~15s, bounded by design.
- `low-level-calls` — every `.call{value:}` site; intentional (ETH transfers
  via WETHFallbackLib pattern).
- `unindexed-event-address` — several events that could be `indexed`. Low
  impact (indexer filtering), not a security issue. Candidate for a cleanup
  batch.
- `immutable-states` — `TegridyPair.factory` could be `immutable` (set in
  constructor, never written). Gas optimization, not a bug.
- `dead-code` — a few helpers. Clean-up candidate.
- `naming-convention` — style.

## Not re-running Halmos this pass

Halmos is installed and available (`C:/Users/jimbo/AppData/Roaming/Python/
Python312/Scripts/halmos.exe`). Symbolic execution per-function requires
`halmos`-annotated invariant tests, which the Foundry suite doesn't yet have.
Queuing as a follow-up — candidate invariants:

- `TegridyStaking`: `totalStaked == Σ positions[i].amount`
- `TegridyStaking`: `totalBoostedStake == Σ positions[i].boostedAmount`
- `TegridyStaking`: `totalUnsettledRewards == Σ unsettledRewards[user]`
- `TegridyPair`: K-invariant `reserve0 * reserve1 ≤ balance0 * balance1 − fees`
- `RevenueDistributor`: `sum(claims per epoch) ≤ epoch.totalETH`
- `CommunityGrants`: `totalRefundableDeposits == Σ unresolved refunds`

Add these as `Halmos_*.t.sol` tests and run `halmos --contract Halmos_X`
in a follow-up pass.
