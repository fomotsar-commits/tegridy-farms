# Agent 99/100 — Meta Attack Chains: Composing Prior Agents' Findings

**Lens:** META synthesis — combine findings F-01 through F-95 into multi-step attack
chains that produce more dangerous, larger-scale, or cheaper exploits than each
individual finding alone.

**Method:** Read every prior agent's findings file (agents 01–95; 96–98 do not
exist in this audit pass). Filtered for HIGH and MEDIUM severities; composed each
unique pair/triplet whose state interactions amplify each other. Each chain is
traced step-by-step to specific F-NN-K finding IDs at every link.

**Notation.** `F-NN-K` = finding K from agent NN's report. Chains numbered 1+.
Each step explicitly cites the finding ID it depends on.

---

## CHAIN-01 — Captured-Owner Pause-and-Drain on CommunityGrants (parallel to BATCH-E H12)

**Severity if executed: HIGH (full grant treasury siphon during pause window).**
**Time-to-execute: 24h after key compromise.**

The BATCH-E H12 fix added `whenNotPaused` to `lapseProposal` so a captured owner
could not pause→wait-30d→lapse→`emergencyRecoverETH` to drain the grant
treasury. The fix missed the parallel path through the cancel-approved timelock:

1. **Pre-condition:** owner key compromised. Per `F-94-01` (no veTOWELI veto),
   community has no on-chain power to abort pending owner actions.
2. **Step 1 (T+0):** captured owner calls `CommunityGrants.pause()` (instant, no
   timelock per `F-94-01`). All `executeProposal` and `retryExecution` paths
   freeze.
3. **Step 2 (T+0):** captured owner calls
   `proposeCancelApproved(victimProposalId)` for each Approved proposal. Per
   `F-15-K-01`, the propose path is `onlyOwner` with no pause guard. 24h
   timelock starts.
4. **Step 3 (T+24h):** `executeCancelApproved(victimProposalId)` — per
   `F-15-K-01`, this path is **permissionless** AND **lacks `whenNotPaused`**.
   Anyone (a sybil controlled by the attacker) calls it. Status flips
   Cancelled, `totalApprovedPending -= proposal.amount`. Frees the cap.
5. **Step 4 (T+24h+ε):** captured owner calls `emergencyRecoverETH(attacker)`
   while still paused. Per `F-15-K-01`, this is `whenPaused` and only checks
   `withdrawable = balance - totalApprovedPending`. Step 3 just freed the
   pending — the same balance is now classified as recoverable. ETH flows to
   attacker.
6. **Step 5 (repeat for every Approved proposal):** the loop drains 50%
   of treasury per cycle (`MAX_GRANT_PERCENT_BPS = 5000`).

**Why F-94 mitigations don't help:** `F-94-01` specifically calls out the
absence of veTOWELI veto. `F-94-09` documents BATCH-E H12 as the primary
defense — but H12's `whenNotPaused` only landed on `lapseProposal`. The
parallel `executeCancelApproved` path is the unfixed sibling, exactly the kind
of "fix-pass missed sibling" pattern shown in F-13-1 / F-13-2 / F-89-K.

**Cost amplification vs. base findings:**
- F-15-K-01 alone: documented as MEDIUM (24h delay, observable).
- Combined with F-94-01 (no veto): HIGH (no community power to abort).
- Combined with F-75-3 (rotated owner inherits pending state): if rotation
  happens between propose and execute, the rotated honest owner inherits the
  malicious queue and must remember to cancel each one individually (which the
  attacker already paused, so cancel is owner-only-while-paused per `F-15-K-01`
  — needs `cancelCancelApproved` which is also `onlyOwner`).

---

## CHAIN-02 — Restaking Rotation Strands NFTs + Per-tokenId Buckets + Wrong-Token Fallback Multiplier

**Severity if executed: HIGH (permanent NFT loss + wrong-token fund theft).**
**Time-to-execute: 48h after admin queues rotation.**

Combines four stranding/divergence holes into one cross-contract trap:

1. **Step 1 (T+0):** admin queues `proposeRestakingContract(newR)` per
   `F-65-1`. 48h timelock visible.
2. **Step 2 (T+48h):** admin executes `applyRestakingContract(newR)`. Per
   `F-65-1` (HIGH), `oldR` still holds N NFTs, has N `restakers[]` entries,
   non-zero `unsettledRewards[oldR]`, and per-tokenId bucket entries.
3. **Step 3 (T+48h+ε):** since per `F-65-2` (MEDIUM), 5 governance consumers
   (MemeBountyBoard, CommunityGrants, GaugeController, ReferralSplitter,
   VoteIncentives) have one-shot `setRestakingContract` setters, they all
   continue reading `oldR` for voting power; only `RevenueDistributor`
   correctly switches to `newR`. **Vote power on those 5 contracts is now
   stale.**
4. **Step 4 (user perspective):** any user holding an `oldR`-escrowed NFT
   tries `oldR.unrestake()`. Per `F-65-1`:
   - `oldR.claimUnsettledForTokenId` reverts `Unauthorized` (since
     `_isTrackedHolder(oldR) == false` after rotation). Per-tokenId rewards
     forfeited to the attacker / treasury sweeper later via the 90-day
     inactivity gate.
   - If user has staked a fresh position elsewhere, NFT return reverts
     `AlreadyHasPosition` per `F-65-1` step 3. **NFT permanently stranded.**
5. **Step 5 (decay-fallback exploit, F-04-1):** any expired position in
   `oldR` is now susceptible to `decayExpiredRestaker` via `F-04-1` (HIGH).
   Per `F-04-1`, the `_safeBonusTransferExt` self-call's catch-arm credits
   `unforwardedBaseRewards[user] += bonusPending` — but the "wrong token"
   bucket is denominated in `rewardToken` (TOWELI), while `bonusPending` is
   in the bonus token (e.g., WETH/USDC). User loses `bonusPending` units of
   bonus token AND receives only that nominal value in TOWELI (often
   pennies-on-the-dollar).
6. **Step 6 (final amplifier, F-65-1):** the `unsettledRewards[oldR]` bucket
   ages to 90 days untouched (per `_touch(oldR)` no longer firing because
   oldR is no longer tracked). Owner sweeps to treasury — silent value
   migration to the protocol/captured owner.

**Cross-chain dependency:** F-65-1 only requires admin action; F-04-1 only
requires the bonus token to have a blacklist or pause feature; F-65-2 is
pre-existing structural.

**Cost amplification:**
- F-65-1 alone: HIGH (NFT stranding for users holding two positions).
- F-65-2 alone: MEDIUM (governance vote-power desync).
- F-04-1 alone: HIGH (single user, blacklist case).
- Combined: MULTIPLIER — every legacy restaker becomes a sitting target for
  F-04-1 decay-fallback wrong-token theft (since the rotation makes the
  population of "stuck restakers in oldR" large), AND the 5 governance
  consumers misread power for them, AND the 90-day timer tilts unsettled
  rewards into treasury.

---

## CHAIN-03 — TWAP Multi-Step Grind → Lending Steal (low-TVL launch-day exploit)

**Severity if executed: HIGH at launch, decays as TVL grows.**
**Time-to-execute: 1 hour for grind + 1 borrow tx.**

Composes oracle weaknesses across the F-46 / F-89 family with the lending
consumer's lack of dispersion gate:

1. **Pre-condition (`F-46-1` MEDIUM, `F-89-H` MEDIUM):** TOWELI/WETH pair
   ships with default `minReserveFloor[pair] == 0`. No script in the codebase
   calls `setMinReserveFloor`. Launch-day TVL is low (e.g., $15K).
2. **Step 1 (`F-89-K` HIGH defense-in-depth):** the `lastBypassUsed` sibling-
   miss in the BATCH-M3 H7 grace branch means observation #2 and #3 don't
   stamp `lastBypassUsed`. Lending's `lastBypass != 0 &&
   block.timestamp - lastBypass < TWAP_PERIOD * 2` cooldown elapses at t=60min
   relying on lucky alignment with bootstrap timing. The lending consumer
   accepts data sooner than the safety property would otherwise allow.
3. **Step 2 (`F-89-I` HIGH launch-only / `F-46-1`):** attacker grinds 4
   consecutive observations at +50% deviation each (`MAX_DEVIATION_BPS = 5000`,
   strict `>` per `F-46-1` recommendation). After 4 observations across 1
   hour, TWAP is ~5x off market. Cost per push on $15K pair: ~$50-200 per
   `MIN_UPDATE_INTERVAL = 15 min` step.
4. **Step 3 (`F-31-A` HIGH suppression layer):** during the grind, attacker
   ALSO writes `kLast` via permissionless `mint()` / `burn()` (per `F-31-A`)
   to anchor the protocol-fee accumulator at the manipulated reserves. Future
   `_mintFee` accruals are suppressed for years.
5. **Step 4 (`F-89-D` LOW lending consumer gap):** lending's
   `_positionETHValue` does NOT compare TWAP to live reserves (no
   `HARVEST_TWAP_DEVIATION_BPS` analog). Per `F-89-D`, POLAccumulator has the
   check but lending does not. Attacker borrows against a position whose
   true value is N TOWELI ≈ X ETH but whose TWAP read is 5x ETH.
6. **Step 5 (combine with `F-09-INFO1`):** lending bears full collateral
   price-decline risk (Gondi pattern). Lender's `minPositionETHValue` check
   passes at the manipulated read. Loan settles. Attacker repays nothing,
   defaults — but by then they've already pulled `5x` worth of principal
   against `1x` of collateral.

**Cost amplification:**
- F-46-1 alone: MEDIUM (grind exists but capped by deviation gate).
- F-89-K alone: HIGH defense-in-depth (lucky alignment can break).
- F-89-I alone: HIGH at launch only.
- F-31-A alone: HIGH (multi-year fee suppression).
- COMBINED: launch-day single-attacker steal of lender principal AT PRICE
  COLLAR (5x) AS WELL AS multi-year suppression of protocol revenue, with
  the same $200 budget covering BOTH attacks since the manipulated
  reserves serve both purposes (oracle grind + kLast anchoring).

---

## CHAIN-04 — Bribe Indexing + Permissionless `advanceEpoch` + Pair-Disable = Trapped Bribe + Stranded Vote + Rugged Voter

**Severity if executed: HIGH (trapped bribes + stranded voter VP).**
**Time-to-execute: bounded by 7-day epoch cadence.**

Triple-stack of governance design weaknesses combine to create a primitive
where bribes deposited into one epoch cannot be recovered AND voter VP is
silently lost:

1. **Step 1 (`F-77-1` HIGH bribe indexing):** bribes target the SAME epoch
   they're claimed in (vs. Aerodrome's n+1 lag). Briber deposits 1 ETH on
   pair P at epoch e while a permissionless `advanceEpoch()` is pending (per
   `F-77-3` MEDIUM no post-finalize cooldown).
2. **Step 2 (`F-77-3`):** attacker (briber's accomplice) front-runs honest
   voters with `advanceEpoch()`. The bribe is now finalized into epoch e's
   bucket — voters who already committed via commit-reveal had committed
   BEFORE seeing the bribe, so their `committedPower` is anchored to other
   pairs. Attacker's accomplice (a separate wallet from the briber to bypass
   `F-69-3` / `F-77-5` `SelfBribeClaimForbidden`) commits last with full
   power on pair P.
3. **Step 3 (`F-77-2` MEDIUM-HIGH):** the 2.8d commit window's
   `committedPower` increments are public per `F-77-2`. Briber waits to see
   honest commit power on pair P, then deposits exactly enough to overshoot
   them via accomplice's reveal weight, ensuring accomplice gets the
   majority bribe slice.
4. **Step 4 (factory disable):** governance disables pair P AFTER snapshot.
   Per `F-11-1` (HIGH stranded bribes/votes when factory disables) AND
   `F-10-K-02` (MEDIUM `_validatePair` re-reads `factory.disabledPairs`
   on every read path):
   - `claimBribes(epoch, P)` reverts `PairDisabled`.
   - `refundUnvotedBribe` reverts `PAIR_HAS_VOTES` (since accomplice voted).
   - `refundSubQuorumBribe` reverts `NOT_SUB_QUORUM` (quorum cleared).
   - `forfeitCommitOnDisabledPair` only handles UN-revealed commits, not
     post-reveal. Voters who already revealed are stranded.
5. **Step 5:** voters' `userTotalVotes[user][epoch]` is monotonic per
   `F-11-3` (INFO) and cannot be redirected. Voter VP is locked, bribe is
   locked, briber accomplice gained reveal-time arbitrage advantage, and
   the protocol now has indefinite stranded value.

**Cost amplification:**
- F-77-1 alone: HIGH (direct same-epoch arbitrage).
- F-11-1 alone: HIGH (stranding).
- F-10-K-02 alone: MEDIUM (single-path).
- F-77-2 + F-77-3 alone: MEDIUM (commit-reveal info leak).
- COMBINED: full attack: briber gets reveal-time intel + arbitrage win, AND
  if combined with a captured guardian (`F-94-02`) who instant-disables the
  pair after rewards have already been routed, the briber's accomplice has
  already won and the disabled pair traps EVERYONE ELSE'S claim while the
  attacker has already extracted.

---

## CHAIN-05 — Captured Owner + Pause + No Cap on NFT Lending = Permanent Lender Lockout

**Severity if executed: HIGH (full lender NFT custody hostage).**
**Time-to-execute: instant.**

NFT lending pause weapon plus borrower-friendly asymmetry:

1. **Step 1 (`F-71-1` HIGH):** captured owner calls `pause()` on
   TegridyNFTLending. `claimDefault` is `whenNotPaused` per `F-71-1`, but
   `repayLoan` is NOT (per design). Unlike TegridyLending which has a 7-day
   `MAX_PAUSE_BLOCK_LIQUIDATION` cap (BATCH-J3 H10), TegridyNFTLending has
   no cap.
2. **Step 2 (`F-71-2` MEDIUM):** even on TegridyLending where the cap exists,
   captured owner can time the pause RIGHT AT `deadline + 30m` mid-grace,
   stealing up to 1h of grace from the borrower per the F-71-2 mid-grace
   pause weapon. The grace stays as a constant `GRACE_PERIOD = 1h`,
   unaffected by pause-extension semantics.
3. **Step 3 (`F-94-01` HIGH governance design):** no on-chain veTOWELI veto
   over `pause()` (which is admin-only with no timelock per `F-94-01`).
   Off-chain coordination needed for guardian rotation through the 48h
   `proposeFeeToSetter` flow.
4. **Step 4 (lender impact):** lender CANNOT seize collateral while paused.
   Borrower can always wait — when borrower senses NFT floor crash about
   to happen, they let it default by NOT repaying, and the lender takes
   the loss because collateral never gets to lender's wallet.
5. **Step 5 (compound exploit):** combine with `F-94-02` (HIGH guardian
   instant-disable): captured guardian (or feeToSetter) can also
   `emergencyDisablePair` on the TOWELI/WETH pair to brick the lending
   oracle. Lender now has neither claim path NOR price discovery to
   negotiate off-chain. Dual lock-out.

**Cost amplification:**
- F-71-1 alone: HIGH (lender DoS).
- F-71-2 alone: MEDIUM (1h grace theft).
- F-94-01 alone: HIGH governance.
- F-94-02 alone: HIGH AMM DoS.
- COMBINED: captured admin holds lender's principal AND collateral indefinitely
  with zero on-chain recovery, until guardian rotation (which itself is
  48h-locked and can be raced by another feeToSetter capture).

---

## CHAIN-06 — Restake of Expired + Inflated Cache + Rotation = Permanent Bonus Siphon

**Severity if executed: HIGH (silent bonus drain to attacker).**
**Time-to-execute: instant for setup, perpetual leak.**

The restake-of-expired primitive composes with the rotation primitive to
create a perpetual silent-leak path that survives admin rotation:

1. **Step 1 (`F-93-1` HIGH / `F-03-K1` HIGH):** attacker holds an expired,
   un-kicked staking NFT with cached boostedAmount = N×4.5 (max). Per
   `F-93-1`, `restake()` reads pre-decay inflated boost, copies it to
   `restakers[attacker]`, and bumps `totalRestaked` by the inflated amount.
2. **Step 2 (`F-03-K1` claim path):** `claimAll()` re-reads
   `staking.positions(...)` AFTER calling `staking.getReward(tokenId)` —
   but the `postClaimBoosted > 0 && postClaimBoosted != info.boostedAmount`
   guard at the resync site SKIPS the resync when postClaimBoosted == 0
   (zeroed by decay). `info.boostedAmount` STAYS inflated.
3. **Step 3 (`F-93-1` repeats):** attacker calls `claimAll()` periodically.
   Each call extracts `inflated_share / totalRestaked × Δt × bonusRate`.
4. **Step 4 (`F-65-1` HIGH defense rotation race):** if admin attempts to
   rotate the restaking contract per F-65-1, the attacker's stale entries
   in `oldR` are NOT migrated. The leak transfers to the new restaking
   contract via the user's still-present claim path on `oldR` (since `oldR`
   still functions as a contract). The 90-day inactivity gate in
   `unsettledRewards[oldR]` doesn't fire because the attacker keeps
   `_touch(oldR)`-ing it via repeated `claimAll()`s.
5. **Step 5 (`F-04-1` HIGH wrong-token amplifier):** when attacker becomes
   blacklisted on bonus token (or chooses to engineer a self-revert), the
   `decayExpiredRestaker` fallback per `F-04-1` credits `bonusPending` units
   into `unforwardedBaseRewards` (TOWELI-denominated bucket), trading
   bonus-token units for TOWELI units — attacker can pre-position so
   their bonus-token loss is structurally cheaper than the TOWELI gain.

**Cost amplification:**
- F-93-1 / F-03-K1 alone: HIGH (single-attacker bonus siphon).
- F-65-1 alone: HIGH (rotation stranding).
- F-04-1 alone: HIGH (wrong-token theft).
- COMBINED: an attacker who patiently held a max-boost lock to expiry can
  perpetually drain bonus emissions WHILE the protocol attempts admin
  rotation, AND can convert the bonus-token loss into TOWELI gain via the
  wrong-token bucket if blacklist conditions emerge.

---

## CHAIN-07 — Gauge Cap Bypass + Curve-Wars + Single-Voter Capture = 100% Emission Direction

**Severity if executed: HIGH at low engagement, MEDIUM at high engagement.**
**Time-to-execute: 1 epoch for setup.**

Triple-stack of GaugeController weaknesses defeats the documented 50%-per-vote
cap entirely:

1. **Step 1 (`F-17-1` HIGH duplicate dedup miss):** legacy `vote()` accepts
   duplicate gauge entries — `gauges = [G,G,G,G,G,G,G,G]` with
   `weights = [1250]*8` cleanly puts 100% on a single gauge despite
   `MAX_WEIGHT_PER_GAUGE_BPS = 5000`.
2. **Step 2 (`F-17-2` HIGH revealVote miss):** `revealVote()` doesn't
   enforce the per-element cap at all. Attacker can vote `[G]` with
   `[10000]` — 100% to one gauge in one element. Even simpler than F-17-1.
3. **Step 3 (`F-69-2` MEDIUM single-voter capture):** `_getRelativeWeightAt`
   has no minimum total-weight or distinct-voter gate. With low engagement,
   one 1-wei voter can hold 100% of `totalWeight`. Attacker with 100 TOWELI
   at 0.4x boost can become the dominant voter on quiet epochs.
4. **Step 4 (`F-92-5` LOW curve-wars flywheel - by design):** attacker
   recursively re-locks captured emission to amplify next epoch's vote
   weight. With F-17-1/F-17-2 defeating the per-vote cap, the flywheel
   converges 100% of every emission cycle to the attacker until other
   voters notice.
5. **Step 5 (`F-93-2` MEDIUM LP-farming MEV):** when emissions land on the
   captured gauge's LP pool via owner-signed `notifyRewardAmount`,
   attacker mempool-front-runs with a large LP stake (per `F-93-2`),
   capturing the boosted period at high effective balance.

**Cost amplification:**
- F-17-1 / F-17-2 alone: HIGH (cap defeated).
- F-69-2 alone: MEDIUM (low-engagement-only).
- F-93-2 alone: MEDIUM (period-only capture).
- COMBINED: captured emission share scales with attacker's compounding stake;
  the F-92 lens analysis bounds this at 50% per-vote with the cap intact,
  but F-17-1/F-17-2 erase the cap. Combined with F-93-2's LP-side capture,
  the attacker takes 100% of attention AND 100% of the LP-side boosted
  yield — full emission monopoly.

---

## CHAIN-08 — `lapseProposal` + Rolling Buffer DoS = Indefinite Grant Pipeline Brick

**Severity if executed: MEDIUM (full grant pipeline halt).**
**Time-to-execute: 1 sybil burst + 30d.**

Combines the rolling-buffer DoS with the staleness/expiry gap:

1. **Step 1 (`F-15-K-02` LOW-MEDIUM):** attacker pays
   50 × `PROPOSAL_FEE = 42_069 TOWELI` per attempt (~$0.001 / TOWELI =
   ~$2k for a sybil burst) to fully saturate the active queue. Drives ~50
   approved-and-executed grants in one pipeline cycle.
2. **Step 2 (high-throughput protocol use):** legitimate community
   proposals also fill the pipeline. Combined with attacker's burst,
   100+ disbursements land within 30d — `_recordDisbursement` ring buffer
   fills and reverts `RollingBufferFull` per `F-15-K-02` (LOW-MEDIUM).
3. **Step 3 (`F-15-K-04` LOW dry-run):** simultaneously, attacker uses a
   captured key to propose a new feeReceiver that passes the 1-wei dry-run
   but reverts on the actual `nonRefundable` fee transfer. After 48h
   timelock, every new proposal `createProposal` reverts. Pipeline brick.
4. **Step 4 (`F-15-K-01` parallel siphon):** during the brick window, the
   captured owner runs CHAIN-01 (above) on already-Approved proposals,
   freeing their cap and draining via `emergencyRecoverETH`.

**Cost amplification:**
- F-15-K-02 alone: LOW-MEDIUM (high-throughput only).
- F-15-K-04 alone: LOW (rare receiver shapes only).
- F-15-K-01 alone: MEDIUM (drain-via-pause).
- COMBINED: pipeline freeze EVENT WINDOW becomes the attacker's drain
  window, and recovery requires fee-receiver re-rotation through 48h. The
  brick is a force-multiplier turning F-15-K-01's MEDIUM into HIGH.

---

## CHAIN-09 — Captured-Key Treasury TOC/TOU + Sweep Race Across Multiple Contracts

**Severity if executed: HIGH (cross-contract drain in 48h).**
**Time-to-execute: 48h.**

Synchronized treasury rotation across all sweep paths:

1. **Step 1 (`F-94-06` MEDIUM TOC/TOU):** captured owner queues
   `proposeTreasuryChange(attacker)` AND `proposeSweepETH(MAX)` in the same
   block on POLAccumulator. Both 48h timelocks visible.
2. **Step 2 (`F-94-11` LOW pattern across contracts):** captured owner
   simultaneously queues:
   - `MemeBountyBoard.proposeSweepExpiredRefund` (TOC/TOU pair).
   - `CommunityGrants.proposeFeeReceiver` per `F-15-K-04` if also captured.
   - `RevenueDistributor.proposeForfeitReclaim(MAX 10 ETH/cycle)` per
     `F-12-K-1` (MEDIUM).
   - `RevenueDistributor.proposeClaimRecovery(attackerEOA, epoch_X, 25%)`
     per `F-94-03` (MEDIUM 25% per-epoch cap).
   - `RevenueDistributor.proposeEmergencyWithdrawExcess` per `F-94-10`.
3. **Step 3 (T+48h):** captured owner executes treasury rotation FIRST, then
   sweep / forfeit / recovery in same tx. New treasury (attacker) receives:
   - POL ETH balance.
   - Bounty refunds (if any expired).
   - Forfeit-reclaimed ETH from ALL eligible-dust epochs (bounded by 1%
     lifetime cap per `F-12-K-1` but `F-12-K-1` ALSO documents that the
     reclaim leaves `epochClaimed[i]` unchanged, so subsequent late
     claimers get rugged into unfundable `pendingWithdrawals`).
   - Up to 25% of one chosen epoch via claim-recovery.
4. **Step 4 (`F-12-K-1` rug late claimers):** subsequent late claimers
   compute their owed share against immutable `epoch.totalETH` and
   `epochClaimed[i]`, but balance is now insufficient. `WETHFallbackLib`
   wrap fallback fails (out-of-funds revert). Late claimer permanently
   stuck per `F-12-K-1`.
5. **Step 5 (`F-94-12` MEDIUM):** captured `feeToSetter` can also race the
   factory-side guardian rotation (single-key per F-94-12) to prevent
   guardian intervention, giving the captured owner exclusive 48h drain
   window across all sweep flows.

**Cost amplification:**
- F-94-06 alone: MEDIUM (one contract).
- F-12-K-1 alone: MEDIUM (1% lifetime).
- F-94-03 alone: MEDIUM (25% per epoch).
- F-94-11 alone: LOW.
- COMBINED: 48h synchronized siphon across POL + bounties + forfeit + claim
  recovery = a meaningful fraction of total protocol value, with the late-
  claimer rug operating as a multiplier (locking honest stakers' shares
  permanently into pendingWithdrawals).

---

## CHAIN-10 — TWAP Post-Resume Bridging + Captured Guardian + Lending Steal

**Severity if executed: HIGH (oracle-poisoning lender drain).**
**Time-to-execute: 1 disable cycle.**

TWAP post-resume reserve poisoning combines with the guardian abuse path:

1. **Step 1 (`F-46-1` MEDIUM low-TVL grind):** attacker pre-positions
   reserves at manipulated `spot_M` on TOWELI/WETH (default
   `minReserveFloor == 0`).
2. **Step 2 (`F-94-02` HIGH guardian instant disable):** captured guardian
   (or feeToSetter) calls `factory.emergencyDisablePair(pair)`. Pair is
   instantly disabled. Reserves frozen at `spot_M`.
3. **Step 3 (`F-24-1` MEDIUM post-resume bridging):** during disable_duration,
   attacker waits (no swap costs because pair is frozen). At
   `T_resume`, multisig executes the timelocked re-enable. Disable lasted
   say 12 hours.
4. **Step 4 (`F-24-1` poisoning):** attacker front-runs ANY organic swap
   with `TWAP.update(pair)` at T_resume + 1s. Per F-24-1, the bridge
   integrates `spot_M × disable_duration ≈ 12h × spot_M` into the
   cumulative. Deviation gate passes (lastSpot0 still equals spot_M from
   pre-disable — gate sees 0 deviation). Observation lands as non-bypass.
5. **Step 5 (`F-89-K` HIGH cooldown gap):** lending consumer's
   `lastBypassUsed` cooldown already elapsed (per F-89-K analysis at t=60min
   post-bootstrap), so lending now reads the manipulated TWAP as fresh
   data.
6. **Step 6 (`F-09-INFO1` lender bears risk):** attacker borrows against a
   position whose true value is X but whose TWAP reads `spot_M`. Default
   path leaves lender with an underwater NFT.

**Cost amplification:**
- F-46-1 alone: MEDIUM (single-block grind not feasible).
- F-94-02 alone: HIGH (AMM DoS).
- F-24-1 alone: MEDIUM (requires disable event).
- F-89-K alone: HIGH defense-in-depth.
- COMBINED: captured guardian creates the disable event (no need to wait
  for legitimate disable), enabling the F-24-1 post-resume poison without
  a coincidental disable. The cooldown gap of F-89-K means lending consumes
  the poison without the safety property kicking in.

---

## CHAIN-11 — Captured Factory + Disabled Pairs + Stranded Bribes + Stranded Votes (Coordinated Mass Sabotage)

**Severity if executed: CRITICAL (system-wide governance + AMM DoS).**
**Time-to-execute: 1 block + 48h.**

Single-key guardian instant-disable combined with bribe/vote mid-window
stranding produces system-wide brick:

1. **Step 1 (`F-94-02` HIGH guardian instant disable, no rate limit):**
   captured guardian enumerates all 100 pairs and calls
   `emergencyDisablePair(pair)` once each in a single block. ~30k gas × 100
   = 3M gas, fits in one block.
2. **Step 2 (`F-11-1` HIGH stranded bribes/votes):** all in-flight bribes
   on those pairs are now permanently stranded (claim/refund all revert per
   F-11-1 / F-10-K-02). Voters who cast votes on those pairs are silently
   disenfranchised — `userTotalVotes[user][epoch]` is monotonic and locked
   per F-11-3.
3. **Step 3 (`F-31-A` HIGH kLast bootstrap):** while pair is disabled,
   donations to the pair persist. Re-enable triggers F-31-A — first mint/burn
   anchors `kLast` against donation-poisoned reserves (per F-31-B MEDIUM).
   Multi-year suppression of protocol fees for every pair.
4. **Step 4 (`F-46-2` LOW-DOC):** attacker can spam-update pairs to keep
   them in bootstrap-bypass mode (3-observation grace) per F-46-2,
   permanently bricking new TWAP consult on all pairs at gas-only cost
   ($3-15/day per pair, $300-1500/day for all 100 pairs).
5. **Step 5 (`F-94-02` recovery analysis):** re-enable per pair requires
   48h timelock. Attacker's $300/day bot can keep disabling RE-ENABLES
   indefinitely if the original guardian is still captured. Recovery
   requires guardian rotation via 48h `proposeGuardianChange`. During the
   48h+ recovery window:
   - All swaps blocked (AMM DoS).
   - All TWAP-dependent reads brick (lending, POL).
   - All bribes mid-flight stranded.
   - All voter VP locked on disabled pairs.
   - All `_mintFee` accruals zeroed for the suppression window.

**Cost amplification:**
- F-94-02 alone: HIGH (48h reversible).
- F-11-1 alone: HIGH (per-pair).
- F-31-A alone: HIGH (per-pair, multi-year).
- COMBINED: simultaneous attack across all pairs converts a 48h reversible
  inconvenience into multi-year economic damage (kLast suppression PER
  PAIR remains permanent post-recovery), AND all in-flight governance
  state on the disabled pairs is permanently lost.

---

## CHAIN-12 — Synthetix Empty-Period + Restake Migration Race + Late-Claimer Rug

**Severity if executed: MEDIUM (slow drain plus rug of late claimers).**
**Time-to-execute: protocol lifetime.**

Composes the documented Synthetix-style empty-period forfeiture (which is
correctly closed) with the F-12-K-1 forfeit-reclaim accounting drift:

1. **Step 1 (`F-93-9` CLOSED, but adjacent path open):** TegridyLPFarming
   correctly forfeits empty-period rewards. But long-locked stakers who
   wait for monthly claims are still subject to F-12-K-1 (MEDIUM) forfeit-
   reclaim accounting drift.
2. **Step 2 (`F-12-K-1`):** owner runs `proposeForfeitReclaim` per epoch.
   `executeForfeitReclaim` reduces `totalEarmarked` and bumps
   `totalForfeitedReclaimed` but does NOT touch `epochClaimed[i]`. Eligible
   epochs continue to compute correct user shares against immutable
   `epoch.totalETH` and `epochClaimed[i]`.
3. **Step 3 (sweep dust):** owner calls `sweepDust()`. The `unclaimed =
   totalEarmarked - totalClaimed` figure is artificially smaller (since
   `totalEarmarked` was reduced by forfeit). Larger fraction treated as
   dust, swept to treasury.
4. **Step 4 (rug):** late long-locked staker calls `claim()`.
   `_calculateClaim` returns full owed share (math unchanged). `claim()`
   advances `lastClaimedEpoch[A]` and tries
   `A.call{value: 0.3 ETH, gas: 10000}`. Contract balance is now
   insufficient → `success=false` → `pendingWithdrawals[A] += 0.3 ETH`.
5. **Step 5 (`F-12-K-1` no recovery):** A calls `withdrawPending()`.
   `WETHFallbackLib.safeTransferETHOrWrap(weth, A, 0.3 ETH)` invokes
   `IWETH.deposit{value: 0.3 ETH}()` which **reverts** with out-of-funds.
   Whole tx reverts. A is permanently stuck.
6. **Step 6 (`F-13-1` view divergence amplifier):** A's frontend calling
   `pendingETH(A)` shows the wrong amount per F-13-1 (MEDIUM view/write
   restaker fallback divergence) — A doesn't even know they were rugged
   until they try to claim.

**Cost amplification:**
- F-12-K-1 alone: MEDIUM (1% lifetime cap).
- F-13-1 alone: MEDIUM (UX/integrator).
- COMBINED: late claimers are rugged silently, frontend understates
  pending share, and recovery requires manual owner re-funding (which
  captured owner won't do). Lifetime cap is per-cycle, not per-victim, so
  individual whale can be fully drained.

---

## CHAIN-13 — Self-Bribe Wash-Trade + Fresh Wallet + Sub-Quorum Self-Vote

**Severity if executed: MEDIUM (subsidy farming, not direct theft).**
**Time-to-execute: 7 days.**

Combines the depositor lockout bypass with the per-vote per-gauge cap miss
on revealVote:

1. **Step 1 (`F-69-3` MEDIUM / `F-77-5` LOW-MEDIUM):** attacker controls two
   wallets. Wallet S deposits 10000 USDC bribe on pair X. Wallet A holds
   100 TOWELI staked. `depositedOnPair[S] = true`, `depositedOnPair[A] = false`.
2. **Step 2 (`F-93-3` MEDIUM):** A votes pair X with full power. With low
   engagement on epoch e, `gaugeVotes[A][e][X] / totalGaugeVotes[e][X] ≈ 1`.
3. **Step 3 (`F-17-2` HIGH if commit-reveal):** if commit-reveal mode,
   A.revealVote skips the per-element MAX_WEIGHT_PER_GAUGE_BPS check,
   admitting 100% on pair X without needing duplicates.
4. **Step 4 (`F-93-3` claim):** after voteEnd, A claims ~9700 USDC (3% fee
   loss). Net cost: 300 USDC bribe fee. Net gain: directional control of
   pair X's gauge AND emission slice for that epoch.
5. **Step 5 (`F-92-5` flywheel):** A re-locks captured emission to amplify
   next epoch's vote weight. With F-17-2 erasing the per-vote cap, A
   monopolizes the emission cycle. A's LP fees on pair X grow. Compounds.

**Cost amplification:**
- F-69-3 / F-77-5 / F-93-3 alone: MEDIUM (individually).
- F-17-2 alone: HIGH (cap defeated).
- F-92-5 alone: by design.
- COMBINED: instead of "subsidy that costs 3%," attacker now monopolizes
  100% of an emission cycle's directional control AND recovers most of
  their bribe. Fees from bribing actually become an investment in
  governance capture at a 3% discount per epoch.

---

## CHAIN-14 — Captured Owner + ETH-Stipend Strand + Multi-Path Brick of RevenueDistributor

**Severity if executed: HIGH (RevDist permanent ERC20-WETH strand).**
**Time-to-execute: 1 transfer + treasury rotation.**

The 10k-stipend cold-SSTORE bug compounds with treasury rotation lock-in:

1. **Step 1 (`F-55-1` HIGH cold-init SSTORE):** TegridyFeeHook delivers ETH
   to `revenueDistributor` via 10k-stipend lib. RevenueDistributor's
   `receive()` does cold SSTORE on `totalETHReceived` (22100 gas) which
   exceeds the budget. ETH leg fails. Lib falls back to WETH wrap.
2. **Step 2 (`F-80-02` MEDIUM):** WETH lands as ERC20 inside
   RevenueDistributor. `_distribute()` reads `address(this).balance` which
   sees zero. New ETH never enters epochs. **Stakers never see this ETH.**
3. **Step 3 (`F-55-2` MEDIUM emergency paths brick):** captured owner now
   needs to recover the WETH. The `executeTokenSweep` path requires
   pending sweep proposal. Captured owner queues
   `proposeTokenSweep(WETH, attacker)` per `F-55-2`. 48h timelock.
4. **Step 4 (`F-94-06` TOC/TOU):** simultaneously,
   `proposeTreasuryChange(attacker)` is also queued. Both 48h.
5. **Step 5 (T+48h):** execute treasury change first, then token sweep.
   Stranded WETH from F-55-1 + ANY other ERC20 swept to attacker.
6. **Step 6 (`F-12-K-1` accounting drift):** if forfeit-reclaim was running
   in parallel, the rugged late claimers from CHAIN-12 also have their
   slices in-flight. Combined drain.

**Cost amplification:**
- F-55-1 / F-80-02 alone: HIGH (silent strand on first ingress).
- F-55-2 alone: MEDIUM (sweep gating).
- F-94-06 alone: MEDIUM (TOC/TOU).
- COMBINED: stranded WETH grows over time (every ETH-fee tx that triggers
  the cold-SSTORE retry) — by the time captured admin acts, the stranded
  total is meaningful. Single 48h drain captures ALL of it plus
  forfeit-reclaim flows AND permanent broken receive() path going forward.

---

## CHAIN-15 — Captured Admin + Lending Brick (Principal Floor Collapse) + Existing Loans Locked

**Severity if executed: HIGH (lending market frozen + active loans
unrecoverable).**
**Time-to-execute: 48h after captured admin acts.**

Lending admin floor-less brick combined with sequencer asymmetry:

1. **Step 1 (`F-33-1` HIGH MAX_PRINCIPAL_FLOOR missing):** captured admin
   queues:
   - `proposeMinPrincipal(MAX_MIN_PRINCIPAL = 1 ether)`.
   - `proposeMaxPrincipal(1 wei)`.
2. **Step 2 (T+48h):** both execute. `_createLoanOffer` requires
   `msg.value >= 1 ether AND msg.value <= 1 wei` — unsatisfiable.
   **Lending market frozen for new offers.**
3. **Step 3 (`F-33-3` MEDIUM expired-but-uncancelled proposal):** captured
   admin also runs `proposeAcceptedCollateral(stakingX, false)` (remove
   proposal). Per F-33-3, `acceptedCollateralRemovalPending` ignores
   expiry. Even after the 7d validity window passes (proposal
   un-executable), the view still returns true — perma-blocking new offers
   even on collaterals the captured admin couldn't actually remove.
4. **Step 4 (`F-33-2` MEDIUM 96h→48h chained-timelock collapse):** captured
   admin in parallel runs:
   - `proposeTreasuryChange(X)`.
   - `proposeSweepDonatedToweli(X, MAX)` (per F-33-2 not pinned at propose
     time).
   Both 48h, executable in same block. Per F-33-2, the documented 96h
   defense collapses to 48h since `_to` isn't pinned. Drains escrow surplus.
5. **Step 5 (`F-71-1` HIGH NFT lending pause):** in parallel, captured
   admin pauses NFT lending. Existing lenders cannot claim defaults.
   Combined with the new-offer brick from F-33-1, BOTH primary and
   secondary lending markets are now frozen for the captured admin's drain
   window.
6. **Step 6 (`F-69-1` MEDIUM sequencer-asymmetry):** if L2 sequencer
   outage hits during recovery, GaugeController + VoteIncentives + CG lack
   sequencer-grace per F-69-1. Recovery via off-chain coordination is
   itself bricked.

**Cost amplification:**
- F-33-1 alone: HIGH bricking.
- F-33-3 alone: MEDIUM perma-block.
- F-33-2 alone: MEDIUM 48h drain.
- F-71-1 alone: HIGH lender DoS.
- F-69-1 alone: MEDIUM recovery brick.
- COMBINED: complete lending shutdown (primary + secondary), TOWELI escrow
  drain via F-33-2, and sequencer-coupled recovery brick all in one 48h
  campaign. Multiplied loss vs. single-finding scenarios.

---

## CHAIN-16 — Sybil-Bribe Self + Late-Reveal Information Edge

**Severity if executed: MEDIUM-HIGH (self-bribe wash with information
advantage).**
**Time-to-execute: 7 days.**

Combines the F-77-2 information-leak with the F-69-3 / F-93-3 sybil bypass:

1. **Step 1 (`F-77-2` MEDIUM-HIGH committedPower leak):** during the 2.8d
   commit window, `committedPower[address]` is publicly readable per
   F-77-2. Attacker reads aggregate commit power on all pairs in real
   time.
2. **Step 2 (`F-77-3` MEDIUM permissionless advanceEpoch):** attacker waits
   until commitDeadline - 1h. By then they have full visibility on which
   pairs have what aggregate committed power.
3. **Step 3 (deposit late):** with this info, attacker (via wallet S, per
   F-69-3) deposits a bribe targeting a pair where they have a guaranteed
   reveal-time advantage. Wallet A reveals high power on the chosen pair.
4. **Step 4 (claim share):** after revealDeadline, A calls `claimBribes(e, P)`.
   Per F-93-3 / F-69-3, A's `depositedOnPair == false` (different wallet
   from S), so claim succeeds with high share fraction.
5. **Step 5 (`F-77-1` HIGH same-epoch indexing):** because bribes target
   the same epoch they're claimed in (per F-77-1), the briber has just
   coordinated a deposit-then-claim wash with full information advantage —
   honest voters who committed BEFORE the briber's deposit had no chance to
   shift their commits.

**Cost amplification:**
- F-77-1 alone: HIGH (indexing).
- F-77-2 alone: MEDIUM-HIGH (info leak).
- F-69-3 / F-93-3 alone: MEDIUM (sybil).
- COMBINED: not just self-bribe, but self-bribe with 1+ days of advance
  intelligence on honest commit positions. Briber's expected wash-cycle
  EV approaches 100% recovery minus 3% fee. Curve-wars flywheel runs at
  near-zero net cost.

---

## CHAIN-17 — `setRestakingContract` EOA Footgun + One-Shot Setters + Permanent Restaker Brick

**Severity if executed: HIGH (irreversible governance dysfunction).**
**Time-to-execute: 1 deploy step + 1 admin tx.**

The one-shot EOA-acceptance setter creates an irreversible brick path:

1. **Step 1 (`F-17-3` MEDIUM EOA acceptance):** during deploy ceremony,
   admin script calls `GaugeController.setRestakingContract(EOA)` (typo,
   wrong address, wrong-chain address, etc.). Setter validates non-zero
   but per F-17-3 does NOT verify code length.
2. **Step 2 (`F-65-2` MEDIUM one-shot setters across 5 contracts):**
   simultaneously, MemeBountyBoard / CommunityGrants / ReferralSplitter /
   VoteIncentives are wired to the same EOA. Same one-shot pattern per
   F-65-2 — `RestakingAlreadySet` blocks re-setting.
3. **Step 3 (impact):** all 5 contracts now silently swallow the
   restaking-side voting power read in `VotePowerOracle.powerOf` /
   `powerAt` try/catch. Restakers' aggregated voting power is permanently
   zero on these consumers.
4. **Step 4 (`F-94-01` no veto):** per F-94-01, no on-chain veTOWELI veto
   to abort. No way to redeploy without breaking every loan / bribe /
   bounty / grant proposal that relies on continuity.
5. **Step 5 (`F-75-2` HIGH admin contracts can't be rotated):** if the
   issue is found post-deploy, F-75-2 says TegridyLending and
   VoteIncentives admin contracts can't be replaced either. Recovery
   requires full redeploy.

**Cost amplification:**
- F-17-3 / F-65-2 alone: MEDIUM each.
- F-75-2 alone: HIGH (no admin rotation).
- F-94-01 alone: HIGH (no veto).
- COMBINED: a single 30-second deploy mistake (or compromised deploy
  script) creates an irreversible governance brick affecting all
  restakers across 5 governance surfaces, with no on-chain remediation
  short of redeploying 5+ contracts and migrating all in-flight state.

---

## CHAIN-18 — `harvest()` Bootstrap Bypass + `kLast` Anchoring + Persistent Fee Suppression Across Pairs

**Severity if executed: HIGH (multi-year revenue loss).**
**Time-to-execute: 1 flash loan per pair.**

The pair-side mint/burn permissionless kLast bootstrap composes with TWAP
poisoning and the disabled-pair lifecycle:

1. **Step 1 (`F-31-A` HIGH defeated bootstrap gate):** per F-31-A, mint()
   and burn() unconditionally write `kLast = R0*R1`. Bootstrap gate on
   harvest() is bypassable.
2. **Step 2 (`F-31-B` MEDIUM disabled-pair):** attacker times the attack
   right after the protocol enables `feeOn` (or after a fee-disable→re-enable
   cycle). Per F-31-B, attacker donates tokens during the disabled window,
   then calls `burn()` on re-enable to anchor `kLast` against the
   donation-poisoned reserves.
3. **Step 3 (`F-31-C` MEDIUM TWAP cumulative integration):** attacker uses
   `sync()` to push donation into `(R0, R1)` snapshot. The next TWAP
   `update()` integrates `spot * elapsed` using the manipulated reserves.
   On low-TVL pairs, this slips through the ±50% deviation gate per F-46-1.
4. **Step 4 (`F-94-02` HIGH):** captured guardian disables target pair;
   attacker exploits per F-31-B re-enable cleanup; flow repeats per pair.
5. **Step 5 (multi-pair scaling):** repeat across all 100 factory pairs.
   Each pair's `_mintFee` is suppressed for years while the inflated
   `kLast` baseline waits for natural K growth. Protocol revenue dies for
   the whole AMM.

**Cost amplification:**
- F-31-A alone: HIGH (multi-year suppression per pair).
- F-31-B alone: MEDIUM (per-pair disabled cycle).
- F-31-C alone: MEDIUM (TWAP poisoning).
- F-94-02 alone: HIGH (guardian instant disable).
- COMBINED: single captured guardian + flash loan campaign suppresses
  protocol fees across all pairs simultaneously, AND poisons all TWAP
  consumers (lending, POL) at the same time. Multiplicative damage.

---

## CHAIN-19 — Late-Lock-Extend + No `extendFeeBps` + Curve-Wars Whale

**Severity if executed: MEDIUM (whale subsidy at lock-end).**
**Time-to-execute: 4 years (continuous).**

Default `extendFeeBps = 0` combined with the increaseAmount fee bypass:

1. **Step 1 (`F-93-6` LOW design intent):** `extendFeeBps` defaults to 0.
   Owner has not set it post-deploy.
2. **Step 2 (`F-02-K-04` LOW):** whale stakes 1M TOWELI for 4y at MAX
   boost. After 3y 11mo, lock has 1mo remaining. Whale calls
   `increaseAmount(500k)`. Per F-02-K-04, the new principal earns at the
   ORIGINAL boostBps (4.0x) for the remaining 1mo — no fee. Bob (a fresh
   staker) would have paid `extendFeeBps * 500k`, but extendFeeBps is 0
   anyway, AND Whale doesn't even pay that.
3. **Step 3 (`F-02-K-03` LOW):** whale wants to refresh MAX lock. Per
   F-02-K-03, `extendLock` rejects all `_newLockDuration <= p.lockDuration`
   even when conceptually the new lockEnd would push forward. Whale
   workaround: `toggleAutoMaxLock(true)`. Per F-02-K-06 (INFO), this
   rewrites `lockDuration = MAX_LOCK_DURATION` permanently — locking in
   retroactive MAX boost on any future `revalidateBoost` downgrade.
4. **Step 4 (`F-02-K-01` HIGH stale JBAC bonus):** whale obtained JBAC
   originally; then sold it. Per F-02-K-01, the autoMaxLock decay-restore
   branch in `getReward` silently restores stale JBAC bonus when lock
   has just decayed. Whale's `hasJbacBoost` flag is never cleared.
5. **Step 5 (`F-92-5` flywheel):** whale's 4.5x boost (from F-02-K-01 JBAC
   restoration) runs CHAIN-07 (gauge cap bypass + curve-wars) for an
   amplified emission monopoly.

**Cost amplification:**
- F-93-6 / F-02-K-03 / F-02-K-04 / F-02-K-06 alone: LOW each.
- F-02-K-01 alone: HIGH.
- F-92-5 alone: by design.
- COMBINED: whale runs a no-cost flywheel forever. The F-02-K-01 JBAC
  restoration adds 0.5x to their boost without backing — silent dilution
  of all honest stakers compounds across epochs.

---

## CHAIN-20 — Cross-Chain Retroactive Tax via `protocolFeeBpsAtCreate == 0` Sentinel

**Severity if executed: MEDIUM (silent retroactive tax on legacy offers).**
**Time-to-execute: 96h after captured admin acts.**

Per `F-07-01` MEDIUM the sentinel ambiguity affects offers minted while
`protocolFeeBps = 0`:

1. **Step 1 (`F-07-01`):** legitimate launch UX — admin sets
   `protocolFeeBps = 0` for promotional period via 48h timelock. Lenders
   post offers expecting 100% net of interest (they see 0 fee).
2. **Step 2 (`F-07-01`):** offers accumulate. Each LoanOffer has
   `protocolFeeBpsAtCreate = uint16(protocolFeeBps) = 0`. **Sentinel
   ambiguity:** indistinguishable from "captured at zero" vs "captured at
   pre-fix unset."
3. **Step 3:** admin proposes raising `protocolFeeBps` to 1000 (10%) via
   48h timelock. After execution, `protocolFeeBps = 1000`.
4. **Step 4:** borrower repays a loan against a step-1 offer. Per F-07-01
   the snapshot logic checks `snapBps == 0 ? protocolFeeBps : uint256(snapBps)`.
   `snapBps == 0` so fallback to live 1000. **10% of interest siphoned to
   treasury** without lender consent.
5. **Step 5 (`F-94-06` TOC/TOU compound):** simultaneously,
   `proposeTreasuryChange(attacker)` queued in parallel. By the time
   borrower repays, treasury is attacker. Lender's expected net is
   silently halved AND routed to attacker.

**Cost amplification:**
- F-07-01 alone: MEDIUM (retroactive tax on legacy offers).
- F-94-06 alone: MEDIUM (TOC/TOU 48h race).
- COMBINED: legacy lenders silently donate 10% of all interest to attacker
  during the 96h captured-admin window. Compounds across many in-flight
  loans with no on-chain notification to lenders.

---

## CHAIN-21 — Forfeit-Reclaim Drift + Distribute-When-Paused = Permanent Reward Theft From Stakers

**Severity if executed: MEDIUM (slow drain + post-incident strand).**
**Time-to-execute: lifetime.**

Bridges F-13-2 (distribute path missing pause guard) with F-12-K-1 (forfeit
reclaim drift) for a compound rug:

1. **Step 1 (`F-13-2` MEDIUM staking pause gap):** `distribute()` /
   `distributePermissionless()` lack `_isStakingPaused()` per F-13-2. If
   staking contract is paused due to a discovered exploit, distribute can
   still cement corrupt-state denominators into new epochs.
2. **Step 2 (attacker exploits staking):** attacker exploits TegridyStaking
   to inflate their `votingPowerOf`. Protocol pauses staking. While paused,
   attacker calls `distributePermissionless()`. New epoch cemented with
   the corrupted denominator AND attacker has voting power for that
   epoch.
3. **Step 3 (post-recovery):** staking unpauses. Attacker claims via
   normal `claim()` path against the corrupt epoch. Outsized share.
4. **Step 4 (`F-12-K-1` rug late claimers):** subsequent late claimers find
   the rug from the rest of CHAIN-12 amplified by the corrupt epoch.
5. **Step 5 (`F-13-1` UX hides):** `pendingETH(user)` view is wrong per
   F-13-1, so victims don't even notice the rug until they try to
   `claim()` and revert.

**Cost amplification:**
- F-13-2 alone: MEDIUM (depends on staking exploit).
- F-12-K-1 alone: MEDIUM (drift).
- F-13-1 alone: MEDIUM (UX).
- COMBINED: attacker who exploits staking gets a "free" cemented epoch via
  F-13-2 (which the kill-switch was supposed to prevent), then victims
  get rugged silently per F-12-K-1, with the F-13-1 view hiding the
  damage.

---

## CHAIN-22 — Permissionless `recoverCallerCredit` + Captured Owner Mid-Distribute = Dust Theft

**Severity if executed: LOW (per-cycle dust stealing).**
**Time-to-execute: per emission cycle.**

(Reference CHAIN: SwapFeeRouter dust + treasury rotation race.)

1. **Step 1 (`F-06-A` HIGH WETH-input bypass):** users routing through
   `swapExactTokensForTokens` with `path[0] = WETH` silently bypass the
   staker share per F-06-A. Fees accrue in `accumulatedTokenFees[WETH]`
   instead of `accumulatedETHFees`.
2. **Step 2 (`F-06-B` MEDIUM):** captured owner front-runs permissionless
   `convertTokenFeesToETH(token, [token, WETH], ...)` keeper calls with
   `withdrawTokenFees(token)` per F-06-B. 100% to treasury (which is
   captured), bypassing 50% staker share.
3. **Step 3 (`F-06-C` MEDIUM):** SwapFeeRouter's
   `withdrawPendingDistribution` strands WETH on RevenueDistributor /
   POLAccumulator's cold-init `receive()` per F-06-C. ERC20-WETH
   accumulates, invisible to balance reads.
4. **Step 4 (`F-06-I` LOW):** captured owner rotates revenueDistributor
   per F-06-I. Old distributor's `pendingDistribution` slot is keyed on
   old address — anyone can drain to old address (which is now
   decommissioned). Total loss for stakers if old contract was actually
   destroyed.
5. **Step 5 (CHAIN-09):** captured owner runs CHAIN-09 to drain treasury,
   pulling the F-06-A/B/C accumulated theft.

**Cost amplification:**
- F-06-A alone: HIGH-leaning (silent staker bypass).
- F-06-B alone: MEDIUM (front-run).
- F-06-C alone: MEDIUM (strand).
- F-06-I alone: LOW (rotation race).
- COMBINED: every WETH-input swap silently shovels fees to attacker AND
  the rotation race creates terminal value loss when old distributor is
  decommissioned. The dust adds up over time and is bulk-extracted at
  treasury rotation.

---

## CHAIN-23 — Premium Spoof + Lending Premium Discount = Free Discount

**Severity if executed: LOW-MEDIUM (per-tx discount theft).**
**Time-to-execute: instant.**

1. **Step 1 (`F-27-K-01` MEDIUM integrator-trap):** `getSubscription()`
   returns flash-loan-spoofable `lifetime`/`active` flags. Integrators
   that read this view to gate access mistakenly grant premium status to
   attackers who hold premium tokens momentarily via a flash loan.
2. **Step 2 (premium discount paths):** SwapFeeRouter `_premiumDiscount`
   (and similar premium-aware paths) lookup `getSubscription` (rather
   than `hasPremiumSecure`). Attacker flash-loans premium tokens, calls
   the swap, gets discount, repays.
3. **Step 3 (compound with `F-06-A`):** combined with F-06-A WETH-input
   bypass, the attacker pays even less than the premium-discount fee
   because their fee ends up in WETH-token-bucket which captured owner
   later steals via F-06-B.

**Cost amplification:**
- F-27-K-01 alone: MEDIUM (integrator-trap).
- F-06-A alone: HIGH-leaning.
- COMBINED: per-tx discount theft + bypass of even the discounted staker
  share. Each swap leaks 100% of fees instead of just the discount delta.

---

## CHAIN-24 — Captured Owner Pause + Forfeit-Reclaim Cap-Bypass + Empty Pool Rug

**Severity if executed: MEDIUM (whole protocol pause-and-drain).**
**Time-to-execute: 30 days + 48h.**

1. **Step 1 (captured owner pauses RevDist):** since `executeForfeitReclaim`
   is `whenNotPaused` per F-12-K-1 / F-94-09, captured owner pauses, then
   waits.
2. **Step 2 (during pause):** users cannot claim. Long-locked stakers'
   eligible-dust epochs accumulate.
3. **Step 3 (unpause + immediate forfeit-reclaim):** captured owner
   unpauses for one block, queues `proposeForfeitReclaim(MAX 10 ETH)`
   (per F-12-K-1 cycle cap). 48h timelock.
4. **Step 4 (T+48h):** execute forfeit-reclaim. `totalEarmarked` decremented.
   Late claimers rugged into unfundable pendingWithdrawals per F-12-K-1.
5. **Step 5 (repeat):** loop until 1% lifetime cap (`MAX_LIFETIME_FORFEIT_BPS`)
   reached. Each cycle: 10 ETH drained, late claimers rugged.
6. **Step 6 (post-cap):** captured owner switches to F-94-03
   `claimRecovery` path (25% per epoch). Drains ANOTHER 25% of any chosen
   epoch by attesting attacker EOA's historical power.
7. **Step 7 (CHAIN-09):** simultaneously runs CHAIN-09 sweep race for
   final cleanup.

**Cost amplification:**
- F-12-K-1 alone: MEDIUM (1% lifetime).
- F-94-03 alone: MEDIUM (25% per epoch).
- COMBINED: lifetime cap is by-cycle not by-victim; combined with claim-
  recovery (25% epoch cap), captured owner can drain a meaningful
  fraction of lifetime distributions. Rug compounds across cycles.

---

## CHAIN-25 — Captured Admin + No Validity Window + Long-Stale Admin Replacement Trap

**Severity if executed: HIGH (long-tail trap).**
**Time-to-execute: years.**

Per `F-75-1` HIGH `executeAdminReplacement` has no validity window:

1. **Step 1 (`F-75-1`):** original owner proposes
   `pendingStakingAdmin = X` where X is a today-friendly multisig. Years
   pass. X is decommissioned.
2. **Step 2 (years later):** X's address gets reused via CREATE2 collision
   (or signers' keys leaked to attacker, or X is destroyed and re-deployed
   under attacker control on the same address).
3. **Step 3:** anyone observing the long-stale `pendingStakingAdmin` slot
   can co-opt the discarded address. Owner — even a fresh, honest one —
   calls `executeAdminReplacement()` (assuming they don't notice the
   forgotten proposal). Admin authority transfers to now-hostile
   contract.
4. **Step 4 (compound CHAIN-15):** attacker now controls staking admin.
   Run CHAIN-15 (lending brick + drain).
5. **Step 5 (`F-75-3` MEDIUM):** owner rotation does NOT cancel queued
   proposals. Attacker also has visibility into all OTHER stale proposals
   per F-75-3 — same trap can fire on multiple admins simultaneously.

**Cost amplification:**
- F-75-1 alone: HIGH (long-tail).
- F-75-3 alone: MEDIUM (rotation doesn't cancel).
- COMBINED: governance time-bomb that can fire years post-deploy when
  abandoned proposals collide with discarded address reuse. Multi-contract
  scope per F-75-3.

---

## Summary Table

| Chain | Severity | Primary Findings | Mechanism |
|-------|----------|------------------|-----------|
| 01 | HIGH | F-15-K-01 + F-94-01 + F-75-3 | Pause+cancelApproved drain CommunityGrants |
| 02 | HIGH | F-65-1 + F-65-2 + F-04-1 | Restaking rotation + wrong-token strand |
| 03 | HIGH | F-46-1 + F-89-K + F-89-I + F-31-A + F-09-INFO1 | TWAP grind + lending steal + fee suppression |
| 04 | HIGH | F-77-1 + F-77-2 + F-77-3 + F-11-1 + F-10-K-02 | Bribe arbitrage + stranded post-snapshot |
| 05 | HIGH | F-71-1 + F-71-2 + F-94-01 + F-94-02 | NFT lender custody hostage |
| 06 | HIGH | F-93-1 + F-03-K1 + F-65-1 + F-04-1 | Restake-of-expired + rotation + wrong-token |
| 07 | HIGH | F-17-1 + F-17-2 + F-69-2 + F-92-5 + F-93-2 | Gauge cap bypass + curve-wars + LP MEV |
| 08 | MEDIUM | F-15-K-02 + F-15-K-04 + F-15-K-01 | Grant pipeline brick + drain |
| 09 | HIGH | F-94-06 + F-94-11 + F-12-K-1 + F-94-03 + F-94-12 | Cross-contract treasury TOC/TOU |
| 10 | HIGH | F-46-1 + F-94-02 + F-24-1 + F-89-K + F-09-INFO1 | TWAP post-resume + guardian + lending |
| 11 | CRITICAL | F-94-02 + F-11-1 + F-31-A + F-46-2 | Mass-disable system-wide brick |
| 12 | MEDIUM | F-12-K-1 + F-13-1 + F-93-9 | Forfeit reclaim + view divergence rug |
| 13 | MEDIUM | F-69-3 + F-77-5 + F-93-3 + F-17-2 + F-92-5 | Sybil bribe + cap bypass flywheel |
| 14 | HIGH | F-55-1 + F-80-02 + F-55-2 + F-94-06 | Cold-SSTORE strand + sweep treasury |
| 15 | HIGH | F-33-1 + F-33-3 + F-33-2 + F-71-1 + F-69-1 | Lending brick + escrow drain + sequencer |
| 16 | MED-HIGH | F-77-1 + F-77-2 + F-69-3 + F-93-3 | Late-reveal info edge sybil |
| 17 | HIGH | F-17-3 + F-65-2 + F-75-2 + F-94-01 | Deploy footgun irreversible |
| 18 | HIGH | F-31-A + F-31-B + F-31-C + F-94-02 + F-46-1 | kLast suppression cross-pair |
| 19 | MEDIUM | F-93-6 + F-02-K-03/04/06 + F-02-K-01 + F-92-5 | Whale lock-extend free flywheel |
| 20 | MEDIUM | F-07-01 + F-94-06 | Retroactive lending-fee tax |
| 21 | MEDIUM | F-13-2 + F-12-K-1 + F-13-1 | Distribute-when-paused + drift rug |
| 22 | LOW-MED | F-06-A + F-06-B + F-06-C + F-06-I | SwapFee dust accumulating drain |
| 23 | LOW-MED | F-27-K-01 + F-06-A | Premium spoof + WETH-input bypass |
| 24 | MEDIUM | F-12-K-1 + F-94-03 + F-94-09 | Pause-cycle forfeit-reclaim drain |
| 25 | HIGH | F-75-1 + F-75-3 | Long-stale admin replacement trap |

---

## Cross-Chain Patterns

Three structural primitives appear across multiple chains and warrant
priority attention:

**Pattern A — Captured Owner Toolkit (chains 01, 05, 09, 14, 15, 24, 25).**
The protocol's defense model relies on 24h-48h timelocks observable to
veTOWELI holders, but the lack of veTOWELI veto (F-94-01) plus a single
guardian instant-disable lever (F-94-02) means a captured owner can synchronize
multiple drain primitives within one timelock window. Eight chains exploit
this composition.

**Pattern B — Fix-Pass Sibling Misses (chains 01, 03, 12, 13, 21).** Several
HIGH/MEDIUM findings represent fixes that landed on one path but missed a
sibling path with identical exploitability: F-13-1 (write fix not mirrored to
view), F-13-2 (claim pause-gate not mirrored to distribute), F-89-K
(`lastBypassUsed` not stamped in BATCH-M3 H7 grace branch), F-15-K-01
(H12 fix not mirrored to executeCancelApproved path), F-06-A (staker share
fix not applied to WETH-input swap variant). These are the single highest-
ROI fixes available.

**Pattern C — Permissionless Atomic Trapping (chains 02, 04, 06, 11).** The
combination of (a) permissionless `update`/`advanceEpoch`/`restake`/`harvest`
calls and (b) state-cleanup gaps lets attackers create traps that survive
admin rotation. F-65-1, F-77-1/F-77-3, F-93-1, F-31-A all enable persistent
exploit primitives that cannot be cleaned up via simple admin action.

---

## Recommendations Priority Order

Highest-ROI fixes that close MULTIPLE chains simultaneously:

1. **Add `whenNotPaused` to `CommunityGrants.executeCancelApproved`**
   (F-15-K-01) — closes CHAIN-01, ratifies BATCH-E H12 intent.
2. **Add `balanceOf(restakingContract) > 0` revert to
   `applyRestakingContract`** (F-65-1) — closes CHAIN-02, CHAIN-06.
3. **Set `minReserveFloor` at deploy time AND tighten deviation gate
   from 50% to 20%** (F-46-1, F-89-I) — closes CHAIN-03, CHAIN-10,
   partially CHAIN-18.
4. **Soften `_validatePair` for read-only paths AND add fourth refund leg
   for post-snapshot pair-disable** (F-11-1, F-10-K-02) — closes CHAIN-04,
   partially CHAIN-11.
5. **Cap NFT lending pause at 7d (mirror F-71-1's TegridyLending fix)** —
   closes CHAIN-05.
6. **Add `lockEnd <= block.timestamp` revert to `restake()`** (F-93-1) —
   closes CHAIN-06.
7. **Fix `MAX_WEIGHT_PER_GAUGE_BPS` enforcement in revealVote AND add
   dedup check** (F-17-1, F-17-2) — closes CHAIN-07.
8. **Pin `_to` at propose time on POLAccumulator/RevDist/CG sweep
   functions** (F-94-06, F-33-2, F-94-11) — closes CHAIN-09, partially
   CHAIN-14, CHAIN-15.
9. **Stamp `lastBypassUsed[pair]` in BATCH-M3 H7 grace branch** (F-89-K) —
   closes CHAIN-03 defense-in-depth, CHAIN-10.
10. **Mirror `whenNotPaused` to `distribute()`/`distributePermissionless()`**
    (F-13-2) — closes CHAIN-21.
11. **Backport additive restaker lookup to `_pendingETH` view** (F-13-1) —
    closes CHAIN-12 UX-side rug.
12. **Sync per-epoch `epochClaimed[i]` post-forfeit-reclaim** (F-12-K-1) —
    closes CHAIN-12, partially CHAIN-21, CHAIN-24.
13. **Raise stipend on RevDist/POL/SwapFeeRouter receive() to 30k** (F-55-1)
    — closes CHAIN-14, F-80-02 strand.
14. **Add `MAX_PRINCIPAL_FLOOR` to TegridyLendingAdmin** (F-33-1) — closes
    CHAIN-15.
15. **Add validity window on TegridyStaking.executeAdminReplacement**
    (F-75-1) — closes CHAIN-25.
16. **Add code.length check on all 5 governance consumers'
    setRestakingContract** (F-17-3, F-65-2) — closes CHAIN-17.

---

**End of Agent 99 Meta-Analysis.**
