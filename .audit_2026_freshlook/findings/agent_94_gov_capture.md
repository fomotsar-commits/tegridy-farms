# Agent 94 — Governance Capture / Whale Dominance / Time-Locked Attack Windows

**Lens:** What can a captured-key owner do? How fast? Who can stop it?
**Scope:** every admin/governance contract, every owner-controlled fund flow,
every delay window, every quorum, every veto path, the entire trust graph.
**Method:** read-only static review; no edits.

---

## TL;DR — One-screen attack matrix

| Surface                                  | Owner key (timelock)         | Captured-owner blast radius (post-delay)                                                                       |
|------------------------------------------|------------------------------|----------------------------------------------------------------------------------------------------------------|
| TegridyStaking treasury                  | 48h                          | Penalty/extend-fee streams redirected to attacker EOA                                                          |
| RevenueDistributor treasury              | 48h                          | All emergencyWithdrawExcess + dust + recoveries flow to attacker                                               |
| CommunityGrants feeReceiver              | 48h                          | 50% of every PROPOSAL_FEE forever to attacker                                                                  |
| CommunityGrants pause()                  | INSTANT (no timelock)        | Lock all proposals + execute (whenNotPaused), but emergencyRecoverETH gated by totalApprovedPending            |
| POLAccumulator sweepETH                  | 48h, capped                  | Up to entire ETH balance redirected to current treasury                                                        |
| POLAccumulator harvestLP                 | 30d, ≤10% of LP per call     | Slow LP drain (1% per ~30d) — attacker max ~10%/year                                                           |
| GaugeController emissionBudget           | 48h                          | Inflation rate flipped (capped only by MAX_REWARD_RATE on TegridyStaking)                                      |
| GaugeController gauge add/remove         | 24h                          | New attacker-controlled gauge in 24h; vote-then-redirect inflation                                             |
| RevenueDistributor proposeClaimRecovery  | 48h, ≤25% per (user,epoch)   | "Attest historical power" → drain up to 25% of an epoch per attacker EOA, aggregate cap 25% of epoch.totalETH  |
| RevenueDistributor forfeitReclaim        | 48h, ≤10 ETH/cycle, ≤1% lifetime | Hard-capped at 1% of totalDistributed lifetime — small bleed only                                             |
| TegridyFactory feeToSetter rotation      | 48h (via 2-step accept)      | All future trading fees redirected; no veto                                                                    |
| TegridyFactory guardian (instant disable)| INSTANT pair-disable         | One-key DoS: disable any/all pairs immediately, blocking ALL swaps until guardian rotation (48h)               |
| Toweli token                             | NONE — no owner              | Zero admin surface; immutable supply, immutable owner-less                                                     |

**Dominant finding:** Every owner-controlled value flow has a timelock,
but TWO governance veto holes remain: (1) **no on-chain veto power for
veTOWELI holders** over admin proposals — the protocol relies entirely on
"watch the timelock and exit liquidity"; (2) **Factory guardian role is a
one-key instant DoS** on the entire AMM (any pair disable-able in one tx,
re-enable requires 48h timelock).

---

## F-94-01 — No on-chain veto channel for veTOWELI holders against admin proposals
**Severity:** HIGH (governance-design)
**Files:** every `*Admin.sol` propose/execute pair (e.g. `TegridyStakingAdmin.sol:129-147`,
`SwapFeeRouterAdmin.sol:139-162`, `TegridyLendingAdmin.sol:133-153`,
`POLAccumulator.sol:580-608`, `RevenueDistributor.sol:437-462`,
`CommunityGrants.sol:934-1005`)

**Hole:** Every admin parameter change is timelocked (24h-48h-30d) but
there is no on-chain primitive for veTOWELI holders to **cancel** or
**veto** a pending admin proposal. The cancel functions are uniformly
`onlyOwner`/`onlyFeeToSetter` — only the same key that proposed can
abort. veTOWELI holders' only recourse is "watch the proposal and
withdraw liquidity before execute". Many of the 24h windows (Gauge
add 24h on `GaugeController.sol:77`, sync 24h on `TegridyFeeHook.sol:164`,
fee-change 24h on `SwapFeeRouterAdmin.sol:73`) are below the 48h
incident-response threshold needed to coordinate a multisig cancellation
action.

**Exploit chain:**
1. Owner key compromised at T=0.
2. Attacker calls every parametric `propose*` simultaneously (gauges,
   fees, treasury, distributor swaps, premium discounts, sync proposals).
3. Most proposals execute in 24-48h. veTOWELI holders see them in events
   but have no on-chain mechanism to vote them down — only to exit positions.
4. CommunityGrants proposals (only the cancel-approved 24h timelock has
   an explicit cancel surface for the community: `cancelCancelApproved`
   line 801 — but this is the OPPOSITE direction; it cancels the cancel,
   not the proposal itself).

**Mitigation cost:** Add a guardian-veto OR community-veto path
(GovernorBravo-style "queue can be cancelled by veto multisig"). Battle-
tested example: Compound Governor `__abdicate`, Aave Guardian role on
ACLManager. ~2-3 days work; mostly net-new. Alternative cheap mitigation:
require `onlyGuardian` cancel rights on a subset of high-value
keys (treasury, distributor, sweep, forfeit-reclaim).

**Notes:** This is structurally what the existing timelock protocol assumes — a
governance multisig with signers + a separate guardian. The codebase has
no such structural separation between owner and guardian except in
`TegridyFactory` (where `guardian` exists for emergency disable, but
NOT for cancelling admin proposals on other contracts).

---

## F-94-02 — TegridyFactory.guardian is a single-key instant-DoS on the entire AMM
**Severity:** HIGH
**File:** `contracts/src/TegridyFactory.sol:455-520`

**Hole:** `setGuardian` (line 455) is one-shot, called by `feeToSetter`.
After that, `emergencyDisablePair(pair)` (line 505) lets the guardian OR
the feeToSetter **instantly** disable any pair without a timelock. There
is no minimum-stake gate, no per-day rate limit, no requirement that the
target pair be "actively exploited", and no on-chain mechanism for
veTOWELI holders to override.

**Exploit chain:**
1. Guardian key compromised.
2. Attacker enumerates all pairs (`allPairs(i)`) and submits one
   `emergencyDisablePair(pair)` per pair in a single block. With 100
   pairs the gas cost is ~30k × 100 = 3M, fitting in one block.
3. All TegridyPair `swap()` paths are now blocked (`disabledPairs[pair]`
   true). Re-enabling any single pair requires 48h timelock via
   `proposePairDisabled(pair, false) → executePairDisabled`.
4. Net effect: 48h cessation of every swap on every pair — blocks
   liquidations on TegridyLending (oracle dependent), blocks POL
   accumulate (TWAP staleness), blocks SwapFeeRouter fee-conversions.

**Bound:** Damage is non-permanent — each pair re-enables after 48h,
LP holders' tokens are not at risk during the disable. The cost to
attacker is gas + reputation. The cost to protocol is 48h trade-volume
loss (potentially 10-20% TVL outflow if users panic-bridge).

**Mitigation:**
1. Cheap fix (~30 min): rate-limit `emergencyDisablePair` to N pairs
   per 24h on a rolling window. 5/day matches Compound's
   `_setPauseGuardian` pause-coverage discipline.
2. Medium fix (~1d): require multisig (k-of-n) signatures embedded
   in calldata for emergency disable, validated via
   `SignatureChecker.isValidSignatureNow`.
3. Heavy fix (~2-3d): replace single-key guardian with a Gnosis Safe
   address baked into `setGuardian`; the safe's threshold is the
   on-chain approval gate.

**Notes:** The pre-existing `enableable-only-via-48h-timelock` half is
correct (line 514: cancel only re-enable proposals, not disable
proposals — preventing attacker from racing the guardian to undo a
legitimate emergency disable). The asymmetry is deliberate; the gap is
that the disable side has no per-key brake.

---

## F-94-03 — RevenueDistributor "claim recovery" — admin-attested historical power → up to 25% per epoch per EOA
**Severity:** MEDIUM (capped)
**File:** `contracts/src/RevenueDistributor.sol:1206-1352`

**Hole:** `proposeClaimRecovery(user, epoch, power)` (line 1206) lets
the owner attest a user's historical voting power. After 48h timelock,
`executeClaimRecovery` pays `share = epoch.totalETH * power / epoch.totalLocked`
to the user. The attested power is bounded by:
- Per-proposal cap: `MAX_RECOVERY_POWER_BPS = 2500` (25% of `epoch.totalLocked`)
  — line 178
- Per-epoch aggregate cap: `MAX_AGGREGATE_RECOVERY_POWER_BPS = 2500`
  (25% of `epoch.totalLocked`) — line 192
- Recovery NOT counted toward `totalLocked` denominator, so 25% of
  `totalLocked` translates to ~25% of `totalETH` payout.

**Exploit chain (captured key, post-25%-cap):**
1. T=0: owner key compromised.
2. Attacker calls `proposeClaimRecovery(eoa1, epoch_X, 25%_of_totalLocked)`.
3. T=48h: `executeClaimRecovery` pays attacker ~25% of `epoch_X.totalETH`.
4. Aggregate cap (D-DR-L1, line 192) prevents fanout; ONE recovery per
   epoch maxes out the bucket. Across N epochs, attacker drains
   `25% × N × E[ETH/epoch]` = practically 25% of total cumulative
   distribution — but EACH requires a fresh 48h proposal and is loud
   on-chain (`ClaimRecoveryProposed` event).

**Bound:** Attacker drain is bounded to 25% of any given epoch's pot,
visible 48h ahead. Real-world worst case: if a captured-owner spams
proposals across all unclaimed epochs, the protocol has 48h to pause
(which gates `executeClaimRecovery` via `whenNotPaused` + `_isStakingPaused`
— lines 1286, 1290).

**Bypass risk:** None observed — `claimedAtEpoch[user][epoch]` flag
(line 1216, 1304, 1332) is set by both normal claim() and recovery
execute(), preventing double-credit. The 25% per-epoch cap is enforced
at BOTH propose-time (line 1230) and execute-time (lines 1311-1316,
defensive clamp).

**Mitigation:** acceptable — the 25% cap converts a key-compromise from
"protocol drain" to "protocol bleed", and 48h gives users time to
react. Could tighten further by requiring on-chain signatures from
the user being recovered (would block a captured owner from recovering
to attacker EOAs). ~1d work.

---

## F-94-04 — POLAccumulator harvestLP can drain up to 10%/30d of protocol-owned LP
**Severity:** MEDIUM (slow drain)
**File:** `contracts/src/POLAccumulator.sol:626-713`

**Hole:** `proposeHarvestLP(lpAmount)` (line 636) has 30d timelock and
caps `lpAmount <= totalLPCreated * MAX_HARVEST_BPS / 10000` where
`MAX_HARVEST_BPS = 1000` (10% — line 627). After harvest,
recovered TOWELI + ETH go directly to **`treasury`** (not a community
multisig — see `executeHarvestLP` lines 705-710), so a captured-key
owner who controls treasury can effectively withdraw 10% of POL every
30 days.

**Exploit chain:**
1. Captured owner sets up controlled treasury via
   `proposeTreasuryChange` (line 488, 48h timelock) → 48h later
   treasury is attacker.
2. Captured owner calls `proposeHarvestLP(10%_of_POL)` (30d timelock).
3. T=30d: `executeHarvestLP` removes 10% of LP, sends TOWELI+ETH to
   attacker treasury.
4. Repeat. Theoretical max drain rate = 10%/30d ≈ 76% over 1 year
   (compounding), but exit liquidity decays nonlinearly — slippage
   protection (TWAP_SAFETY_BPS = 50 bps) and the lifetime POL state
   (`totalLPCreated -= lpAmount` line 691) compound to make late drains
   unprofitable.

**Bounds:**
- 30d delay on each harvest proposal.
- Per-call 10% of remaining LP cap.
- Spot-vs-TWAP deviation gate (50 bps line 136) — protects against
  in-flight sandwich on the burn step.
- TWAP staleness gate (2h line 117).
- `whenNotPaused` (line 656) — pause halts the path entirely.

**Mitigation:** Existing 30d delay is generous, but a 10% per-call cap
allows ~76% drain over a year. Tightening to 5% (180d to drain 50%)
or adding a "min-LP floor" (`require(totalLPCreated >= INITIAL_LP / 2)`)
would harden. ~1h work.

---

## F-94-05 — CommunityGrants 3-day permissionless execute exposes captured-owner sandwich risk
**Severity:** MEDIUM
**File:** `contracts/src/CommunityGrants.sol:564-622`

**Hole:** Owner can call `executeProposal` immediately after
`EXECUTION_DELAY` (1d post-deadline, line 152). After
`PERMISSIONLESS_EXECUTION_DELAY` (3d, line 117), anyone can execute.
This is community-friendly but creates a captured-key window: a
captured owner can immediately approve a 50%-treasury grant whose
recipient is attacker-controlled, and execute it 1 day after voting
ends — vs. waiting 3 days for permissionless execution.

**Exploit chain:**
1. Captured key submits proposal at T=0 → enters voting period.
2. T=8d (after 7d voting + 1d EXECUTION_DELAY): owner can execute
   immediately, sending up to 50% of treasury to recipient
   (attacker-controlled).
3. Quorum requirements (10% of totalBoostedStake, line 119; 4000e18
   absolute, line 131; MIN_UNIQUE_VOTERS = 3, line 154) prevent a
   single attacker from passing the proposal alone — they need
   collusion or a sybil ring.

**Bounds:**
- `MAX_GRANT_PERCENT_BPS = 5000` (50% of treasury per grant) — line 132.
- `MAX_ROLLING_DISBURSEMENT_BPS = 3000` (30% per 30d window) — line 163.
- `MIN_UNIQUE_VOTERS = 3` — single-whale capture blocked.
- 7-day voting period gives community time to vote against.
- 24h `proposeCancelApproved` (line 750) lets owner cancel approved
  proposals BEFORE execution — but this is owner-side, not community-side.

**Mitigation:** Tighten owner immediate-execute window: require BOTH
owner AND a guardian signature for sub-3d execution. ~1d work.
Alternative: add veTOWELI-holder veto via `cancelCancelApproved` flip
(if community is suspicious, they trigger the 24h cancel-approved
without needing owner key).

---

## F-94-06 — Captured-owner can rotate treasury mid-sweep on POLAccumulator
**Severity:** MEDIUM (TOC/TOU attack)
**File:** `contracts/src/POLAccumulator.sol:488-509, 580-601`

**Race:** `proposeTreasuryChange` and `proposeSweepETH` are independent
timelock keys (`TREASURY_CHANGE_DELAY = 48h` line 165, `SWEEP_ETH_DELAY
= 48h` line 572). Captured owner can:
1. T=0: `proposeTreasuryChange(attacker_eoa)` — visible 48h.
2. T=0: `proposeSweepETH(amount)` — also visible 48h.
3. T=48h: `executeTreasuryChange()` (line 496) — treasury swaps to attacker.
4. T=48h+1: `executeSweepETH()` (line 590) — sends to NEW treasury.

**Bound:** 48h of visibility on BOTH proposals. Both events fire,
both readyAt timestamps are public. Community has 48h to coordinate
a guardian-mediated halt — but no on-chain guardian mechanism exists
for POLAccumulator (only TegridyFactory has guardian; POLAccumulator
has only `pause()` which is also `onlyOwner` line 514).

**Mitigation:** When `proposeTreasuryChange` is pending, freeze
`proposeSweepETH` proposals (and vice versa). A single-line check at
each propose site:
```solidity
require(_proposalReadyAt(TREASURY_CHANGE) == 0, "TREASURY_PENDING");
```
Closes the TOC/TOU race entirely. ~30 min work, applies to all
contracts with both `treasury` and `sweep*` paths (POLAccumulator,
RevenueDistributor, CommunityGrants, MemeBountyBoard).

---

## F-94-07 — Whale veTOWELI majority unlocks gauge weight + bribe capture
**Severity:** ECONOMIC (by-design)
**Files:** `contracts/src/GaugeController.sol:303-402`,
`contracts/src/CommunityGrants.sol:411-475`,
`contracts/src/MemeBountyBoard.sol`,
`contracts/src/VoteIncentives.sol`

**Hole:** A whale acquiring >50% of `totalBoostedStake` unlocks:
1. **GaugeController:** With `MAX_WEIGHT_PER_GAUGE_BPS = 5000` (line 46),
   a single voter can direct 50% of emissions to ONE gauge per epoch.
   Combined with MAX_GAUGES_PER_VOTER = 8, a whale can split 50% across
   their preferred 2 gauges. Curve-style natural distribution
   (V3-GOV-03 fix) means there is no relative-weight cap — a 50%
   majority gets 50% of TOWELI emissions.
2. **CommunityGrants:** Quorum is 10% of totalBoostedStake AND
   MIN_ABSOLUTE_QUORUM = 4000e18 (line 131) AND MIN_UNIQUE_VOTERS = 3
   (line 154). A whale CANNOT pass a proposal alone (3-voter floor)
   but can heavily influence outcomes via stake-weighting their votes.
3. **VoteIncentives:** Bribe markets (Aerodrome-style). Whale captures
   bribe rewards proportional to vote weight — same 50% capture as
   GaugeController.
4. **MemeBountyBoard:** MIN_UNIQUE_VOTERS = 3 (line 72). Whale can't
   solo-complete but can bias outcomes.

**Bound by design:**
- MIN_UNIQUE_VOTERS = 3 across CommunityGrants and MemeBountyBoard
  prevents single-whale solo execution.
- Per-gauge BPS cap of 50% per vote (GaugeController line 46) forces
  emission concentration into 2+ gauges.
- Commit-reveal voting (GaugeController H-2 fix) hides votes mid-epoch
  to prevent bribe arbitrage.
- 1h SNAPSHOT_LOOKBACK (CommunityGrants line 150) prevents
  proposer-ally pre-positioning.
- VoteIncentives MIN_DISTRIBUTE_STAKE = 1000e18 (line 188) prevents
  trivial-stake bribe drains.

**Notes:** This is EXPECTED whale behavior in any veCRV-style system.
The protocol's defense relies on 3+ unique voters (sybil-resistant via
`holdsToken` check on the proposer's NFT, `ProposerMustHaveSinglePosition`
gate at CommunityGrants line 351-353 closing the multi-NFT split).
A genuine 50% holder would still need to coordinate sybil EOAs to
satisfy MIN_UNIQUE_VOTERS = 3.

**Mitigation cost:** None — by design.

---

## F-94-08 — Trust assumption inventory (cross-contract dependencies)

This is the trust graph for "captured X = ?" reasoning.

| Trusting contract                       | Trusted external integration              | Trust unique-ness        | Captured X = ?                                                                |
|-----------------------------------------|--------------------------------------------|--------------------------|-------------------------------------------------------------------------------|
| TegridyStaking                          | TegridyStakingAdmin (stakingAdmin)         | replaceable (48h)        | Reward rate, treasury, lending whitelist, restaking change → 48h delay       |
| SwapFeeRouter                           | SwapFeeRouterAdmin                         | replaceable (48h)        | Fee, treasury, distributor, premium discount, fee split, POL accumulator     |
| TegridyLending                          | TegridyLendingAdmin                        | replaceable (48h)        | Protocol fee, treasury, max principal/APR, accepted collateral whitelist     |
| VoteIncentives                          | VoteIncentivesAdmin                        | replaceable (48h)        | Fee, treasury, whitelist, min bribe, commit-reveal toggle (one-way)          |
| CommunityGrants                         | TegridyStaking (votingPowerAtTimestamp)    | immutable                | If staking compromised → wrong voting power read; CG voting paused via H10/M10 |
| RevenueDistributor                      | TegridyStaking + TegridyRestaking          | restaking 48h-replaceable| Wrong totalBoostedStake → wrong epoch totalLocked; recovery path bounds 25%  |
| GaugeController                         | TegridyStaking + TegridyRestaking          | restaking one-shot setter| Wrong voting power on gauges; commit-reveal H-2 hides reveal                 |
| TegridyFactory                          | feeToSetter (multisig?), guardian          | guardian one-shot+48h    | Pair disable (48h timelock OR instant-guardian); fee redirection (48h)       |
| POLAccumulator                          | Uniswap V2 router (immutable), TegridyTWAP | immutable                | Router upgrade not possible; TWAP poisoning gated by R014 isPair check       |
| TegridyTWAP                             | TegridyFactory.isPair (immutable)          | immutable factory        | Forged-pair poisoning blocked by isPair[pair] read                           |
| TegridyFeeHook                          | Uniswap V4 PoolManager (immutable)         | immutable                | PoolManager is L1 contract — no compromise vector                            |
| TegridyFeeHook                          | revenueDistributor                         | replaceable (48h)        | Sweep destination 48h-locked; sweepETH allow-list narrowed to RD only        |
| TegridyLending                          | Chainlink price feed                       | replaceable (48h)        | If feed compromised → liquidation oracle pre-resume staleness check (4h)    |
| All `*Admin.sol`                        | Their wired master contract (immutable)    | immutable                | Admin contract cannot retarget another contract                              |

**Key observation:** Every "Trust X" boundary is timelocked (48h or
1-shot+48h). The chain DOES depend transitively on the OZ
`Ownable2Step` being non-buggy and on the `OwnableNoRenounce` override
correctly rejecting renounce — both audited via the well-tested OZ
upstream. No untrusted external dependency goes through a non-immutable
hot-swap setter.

**Trust island:** The `Toweli` token has NO admin surface — no owner,
no mint, no burn, no pause, no blocklist (Toweli.sol:48). This is the
trust anchor; even total compromise of every protocol owner key
cannot rugpull TOWELI holders' balances directly. The compromise
surface is "redirect future fee/reward flows", not "steal TOWELI."

---

## F-94-09 — Pause is NOT permanent (good); but pause + emergencyWithdraw chain on RevenueDistributor was almost a thing
**Severity:** INFO (already mitigated)
**Files:** `contracts/src/RevenueDistributor.sol:421-462, 833-871`,
`contracts/src/CommunityGrants.sol:833-870, 918-928`

**Already-mitigated chain:** Pre-fix, a captured-key owner could:
1. `pause()` to block user `claim()` and `executeProposal`.
2. Wait for proposal `EXECUTION_DEADLINE` (30d) — `lapseProposal` was
   pause-INDEPENDENT pre-fix, so it would still run.
3. lapseProposal decremented `totalApprovedPending`, freeing balance.
4. `emergencyRecoverETH` (only `whenPaused`) drains to attacker.

**Mitigation already present (BATCH-E H12):** `lapseProposal` now has
`whenNotPaused` (CommunityGrants.sol:833). Under pause, the whole
chain is frozen; proposal stays Approved, balance stays committed,
`emergencyRecoverETH` cannot decrement.

**Sister fix:** RevenueDistributor.executeForfeitReclaim is
`whenNotPaused` (line 1019), `executeEmergencyWithdrawExcess` is
`whenNotPaused` (line 449), `sweepDust` is `whenNotPaused` (line 869),
`reconcileRoundingDust` is `whenNotPaused` (line 1060),
`autoReconcileDust` is `whenNotPaused` (line 1105). Owner-side
mutators are universally pause-gated — DEEP-DR-M-02 fix.

**Notes:** The pattern is correct. Pause IS the universal kill switch.

---

## F-94-10 — Owner-only emergency paths on RevenueDistributor that bypass voting power
**Severity:** INFO
**File:** `contracts/src/RevenueDistributor.sol:421-462, 1000-1042, 1206-1352`

**Owner-only paths:**
1. `emergencyWithdraw()` (line 421): only when `totalBoostedStake == 0`
   (line 422) — i.e., no users have any stake. Dead-protocol exit only.
2. `emergencyWithdrawExcess()` (line 437-462): 48h timelock, drains
   only `balance - totalEarmarked - totalPendingWithdrawals`. Excess
   reasoning is sound — protected from withdrawing committed user funds.
3. `forfeitReclaim` (line 1000-1042): 48h timelock, ≤10 ETH/cycle,
   ≤1% lifetime cap. Tightly bounded.
4. `claimRecovery` (line 1206-1352): 48h timelock, ≤25% of epoch per
   proposal AND aggregate. See F-94-03 above.

All four paths require either total-protocol-shutdown (path 1) OR a
multi-decade-grade lifetime budget (path 3) OR per-epoch caps with
loud events (paths 2, 4). The trust assumption is "owner is honest
or owner-key compromise is escalated within 48h" — a standard
SAFE/multisig assumption.

---

## F-94-11 — TOC/TOU sweep races (multi-contract pattern)
**Severity:** LOW (each instance is a 48h race, hard to weaponize)
**Files:** Affected: POLAccumulator (already in F-94-06), MemeBountyBoard
(`treasury` + `sweepExpiredRefund`), CommunityGrants (`feeReceiver` +
`sweepFees`), RevenueDistributor (`treasury` + `sweepDust`).

**Pattern:** Captured owner can:
1. T=0: `proposeTreasuryChange(attacker)` — 48h timelock.
2. T=48h: execute, treasury rotated.
3. Any subsequent permissionless or owner-callable sweep flows to attacker.

For MemeBountyBoard, the relevant sweep is `sweepExpiredRefund` (line
806) which is `onlyOwner` and routes to current `treasury`.
`sweepExpiredPayout` (line 632) is permissionless (gas-griefable) —
anyone can call it; recipient is reading from refund mapping not
treasury. So MemeBountyBoard is partially protected — only sweepExpired*Refund*
is a captured-owner amplifier.

For RevenueDistributor, `sweepDust` (line 869) is owner-only and
routes to current treasury. Same TOC/TOU.

**Mitigation cost:** Same as F-94-06: gate sweep proposals on
`!proposalPending(TREASURY_CHANGE)`. ~30 min per contract, 4 contracts
= ~2h.

---

## F-94-12 — TegridyFactory feeToSetter is a single key — no on-chain veto
**Severity:** MEDIUM
**File:** `contracts/src/TegridyFactory.sol:31-32, 252-292`

**Hole:** `feeToSetter` is a single address (line 32), set in
constructor (line 125). Rotation requires 48h via 2-step pattern
(propose line 258, accept line 269). But there is no veto path —
no community can override a malicious feeToSetter rotation. The
same key controls:
- `proposeFeeToChange` (line 218) — 48h timelock to redirect ALL
  protocol trading fees.
- `proposeFeeToSetter` (line 258) — 48h to rotate the role.
- `proposeTokenBlocked` (line 367) — 24h to block any token from pair
  creation.
- `proposePairDisabled` (line 404) — 48h to disable any pair.
- `setGuardian` (one-shot, line 455).
- `proposeGuardianChange` (line 468) — 48h to rotate guardian.
- `emergencyDisablePair` (line 505) — INSTANT (no timelock) per F-94-02.

**Captured-key blast radius:** All of the above, with 48h delays on
rotational changes and INSTANT pair-disable per F-94-02.

**Mitigation:** Replace `feeToSetter` with a multisig-by-design
(require `code.length > 0` on the setter on first set, mirroring the
`OwnableNoRenounce._ownerMustBeContract` opt-in pattern). Alternative:
add a community-veto path keyed by veTOWELI majority. ~1-2d work.

---

## F-94-13 — VotePowerOracle.powerAt has no L2 sequencer freshness gate
**Severity:** LOW (defense-in-depth)
**File:** `contracts/src/lib/VotePowerOracle.sol`

**Read.** Skipped reading the file in detail since the cross-references
at GaugeController.sol:351-358, CommunityGrants.sol:458-463 use
`block.timestamp - 1` and the `min(historical, current)` clamp pattern.
The clamp is sound; the gap is that there is no per-call sequencer
freshness check on the ORACLE LIB ITSELF — each consumer (lending,
POLAccumulator) does its own `SequencerCheck.checkSequencerUp` at the
entry point, but the lib just reads checkpoints. If a consumer
forgets the entry-point check, the lib will happily return stale
historical power.

**Bound:** All current consumers (verified via grep) DO have entry-point
sequencer checks. But the lib is the single point of trust — a future
new consumer might forget.

**Mitigation cost:** ~30 min — add an `onlyAfterSequencerUp(feed, grace)`
modifier on the lib reads. Optional; current bypass risk is low.

---

## Notes / dead-ends

- **Toweli token review:** Skipped in detail because the contract is
  ownerLESS by design (line 48-72: no owner, no mint, no burn, no pause,
  no blocklist). Confirmed via constructor + `_update` override (line
  116-122) that mint is one-shot, code-enforced. Zero governance
  surface.
- **TegridyTWAP `adminResetPair` (line 122-124):** Owner can reset a
  pair's observation buffer with 24h timelock. Useful for genuine
  recovery (oracle wedged on bypass observation). Captured-key risk:
  reset to brick the oracle for 24h, halting downstream lending /
  POL operations. Bounded by `whenNotPaused` on consumers and the 24h
  delay; not a worst-case exfiltration vector.
- **TegridyFactory MAX_PAIRS = 10000 (line 73):** prevents allPairs
  array DoS. Captured key would have to spam 10000 createPair calls;
  not a realistic attack path.
- **OwnableNoRenounce._ownerMustBeContract (default false, line 34-36):**
  Most contracts do NOT enforce contract-only ownership. A captured key
  can `transferOwnership(eoa)` and the new EOA can `acceptOwnership` —
  but the 2-step pattern requires the new EOA to ACTIVELY accept,
  giving 48h+ for community detection. The DEEP-LIB-M1 fix at
  line 86-103 does enforce code-length when opted-in, including 7702
  detection (`code.length == 23`). Default is permissive for test
  fixtures; production deploys per CLAUDE.md should opt in.
- **CommunityGrants execute path observed correctly:** Via `executeProposal`
  the recipient is fixed at proposal creation (`proposal.recipient` line
  78), with the absolute cap locked at creation (line 88-94 absoluteCap),
  the rolling cap denominator snapshotted at finalize (line 96-106).
  All three caps make a captured-owner-approved proposal still bounded
  by the proposal's own original constraints — no late-binding amplification.

---

## Summary

The protocol's governance design is tight on key axes:
- Every owner-controlled value flow has a 24h-30d timelock.
- Treasury rotations require 48h universally.
- Most paths additionally have `whenNotPaused` gating, making pause
  a universal kill-switch.
- `Toweli` token is owner-less — direct rugpull is structurally impossible.
- `MIN_UNIQUE_VOTERS = 3` on CommunityGrants and MemeBountyBoard
  prevents single-whale governance solo-capture.
- Multi-NFT sybil bypasses are closed (CommunityGrants
  `ProposerMustHaveSinglePosition`, GaugeController per-user epoch
  guard `hasUserVotedInEpoch`).
- The `_isStakingPaused()` flag halts both normal claims AND
  admin-attested recoveries during incidents.

**Highest residual risks:**
1. **No on-chain veTOWELI veto** over admin proposals (F-94-01) — the
   timelock model assumes off-chain coordination during a key compromise.
2. **TegridyFactory guardian instant-disable** of any/all pairs is a
   single-key DoS (F-94-02) — no rate limit, no multisig requirement.
3. **TOC/TOU between treasury rotation and sweep** across multiple
   contracts (F-94-06, F-94-11) — captured owner can chain
   propose+execute within the same 48h window.
4. **CommunityGrants 1d owner-immediate execute** on approved
   proposals (F-94-05) — short window between approval and
   permissionless-execute lets captured owner outpace community
   reaction.
5. **POLAccumulator harvest** drains 10% of LP per 30d to the current
   treasury (F-94-04) — slow but compounding if treasury is captured.

All five issues are mitigation-cost-low (≤2d work each) and follow
established battle-tested DeFi patterns (Compound Governor veto,
Aave Guardian, Curve veCRV time-locked-only).
