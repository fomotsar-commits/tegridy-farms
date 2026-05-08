# Agent 10/100 — VoteIncentives.sol Fresh-Eyes Audit

**Scope:** `contracts/src/VoteIncentives.sol` (1789 LoC) — bribe deposit/claim flow,
epoch transitions, reward token handling. Companion files
`VoteIncentivesAdmin.sol` and `GaugeController.sol` reviewed at the interface
boundary.

**Method:** Fresh read; did NOT consult prior audit `.md` files. Comments in the
contract reference past finding IDs (BATCH-A C1, R014 H-4, NEW-G2, MICROSCOPE C2,
DEEP-GOV-08, etc.) — every issue surfaced below is checked against the inline
mitigation that the comments claim is in place, and only re-reported if the
mitigation has a concrete bypass or a new gap.

---

## F-10-K-01 — `claimBribesBatch` self-bribe lockout disagrees with `claimBribes` semantic, leaving extra dust permanently locked (LOW)

**Where:** `claimBribesBatch` line 923 vs. `claimBribes` line 805.

**Mechanic:**
- `claimBribes` (single epoch) reverts `SelfBribeClaimForbidden` when the caller
  is in `depositedOnPair[user][epoch][pair]`.
- `claimBribesBatch` (multi-epoch) silently `continue`s on the same condition
  (line 923), and DOES NOT mark `claimed[user][e][pair][token] = true` for any
  token in the skipped epoch.

**Consequence:** A briber who deposited on a pair at epoch N+5 can NEVER
forward-resolve the `claimed` flag for that (user, epoch, pair, token) tuple.
The single-epoch `claimBribes` revert means there is no path that ever flips
those flags either. So the briber's row in the `claimed` mapping stays unflipped
forever for tokens they would have rounded to zero.

This is not a fund-loss — the briber correctly cannot claim. But the symmetry
break means a briber who ALSO held vote power on the pair (e.g., voted for it
before depositing later in the same epoch) has their (vote-share-based) claim
silently dropped on every batch call without ever "consuming" the slot, so
indexers / off-chain dashboards keep showing the row as "unclaimed forever."
The dust of the rounded-zero slot stays in `epochBribes[]` and is preserved by
the `dustOf()` invariant — but no event is emitted, no flag flipped, nothing
external can prove the briber exhausted their option.

**Severity:** LOW (cosmetic / accounting-trace only; solvency intact). Worth
flagging because every other "skip" path in the batch (`bribeAmount == 0`,
`share == 0`) flips the claimed flag for closure.

**Suggested fix:** In the batch branch, when `depositedOnPair[user][e][pair]`
short-circuits, also flip `claimed[user][e][pair][token] = true` for every
token in `epochBribeTokens[e][pair]` so the row is marked closed. Alternative:
do nothing (treat it as designed) but document that batch + self-bribe never
emits BribeClaimed and the indexer must treat depositor's batch-skip as
implicit close.

---

## F-10-K-02 — `_validatePair` re-reads `factory.disabledPairs(pair)` on every read path; toggling pair-disable mid-window destroys claim/refund liveness (MEDIUM)

**Where:** `_validatePair` line 1425-1440. Called from `vote`, `depositBribe`,
`depositBribeETH`, `claimBribes`, `claimBribesBatch`, `revealVote`.

**Mechanic:** The factory's `disabledPairs` flag is read at:
1. Deposit time — bribers can't deposit against a disabled pair.
2. Vote time / commit / reveal time — voters can't allocate to disabled pair.
3. **Claim time** — `claimBribes` / `claimBribesBatch` revert on a disabled pair.

The first two are correctly defensive (don't subsidize a dead pair, don't lock
your VP on a dead pair). The third is the gap.

**Attack scenario:**
1. Briber deposits 1000 USDC on pair P at epoch 5 (live, gauged, valid).
2. Voters honestly cast votes during VOTE_DEADLINE.
3. Just BEFORE the claim window opens (t = epoch.timestamp + VOTE_DEADLINE),
   the factory governance/guardian disables pair P (e.g., emergency-disable
   for unrelated security reason — pair P had a router exploit on a different
   chain, etc.).
4. `claimBribes(5, P)` and `claimBribesBatch(.., P)` now revert at
   `_validatePair` line 1439 with `PairDisabled` for ALL voters.
5. `refundUnvotedBribe` requires `totalGaugeVotes == 0` — fails (voters voted).
6. `refundSubQuorumBribe` requires `< QUORUM` — fails if voters cleared quorum.
7. Bribers got no refund path; voters got no bribe.

**Result:** All bribe deposits on the disabled pair, and all voter-side
expected payouts, are permanently locked. The protocol correctly stops issuing
*new* bribes for the disabled pair, but in-flight bribes (already settled into
`epochBribes[]`) become stranded. This is the "disabled pair retroactive
trap" — the trustless `refundSubQuorumBribe` (BATCH-A C1) closed the
sub-quorum hole but did NOT close the post-snapshot pair-disable hole.

**Why the earlier audits missed it:** The DEEP-GOV-08 fix (line 599) and R016
M-1 fix (line 1438) both correctly added the `disabledPairs` gate. The
finding-thread that motivated them was "voters waste VP on dead pair." The
opposite asymmetry — "pair becomes dead AFTER votes are committed" — was not
modeled.

**Severity:** MEDIUM. Requires a factory governance action between epoch-snapshot
and claim-window-open (a 7-day window). The on-call guardian path is
specifically meant for emergency disable, so the action is probable, not
hypothetical.

**Suggested fix:** Differentiate read paths. At claim/refund time, ONLY check
that the pair was registered with the factory at deposit time (which is
already true because deposit-time `_validatePair` enforced it). Skip the
`factory.disabledPairs(pair)` check on read paths, OR add a fourth refund path
`refundOnPostSnapshotDisabledPair(epoch, pair, token)` that mirrors
`refundUnvotedBribe`'s grace-window semantics for this case.

The simplest patch: split `_validatePair` into `_validatePairForDeposit` (full
gate) and `_validatePairForRead` (registration only). This matches the
Velodrome v2 / Aerodrome pattern where `kill_gauge` does not retroactively
freeze claim flow, just stops new emissions/bribes.

---

## F-10-K-03 — `refundUnvotedBribe` and `refundSubQuorumBribe` race against late voters because `totalGaugeVotes` isn't frozen at `voteEnd` (MEDIUM)

**Where:** `refundUnvotedBribe` line 1227, `refundSubQuorumBribe` line 1297.

**Mechanic:** Both refund paths read `totalGaugeVotes[epoch][pair]` LIVE at
refund time, after the `voteEnd + UNVOTED_REFUND_GRACE` (= 21 days
post-snapshot) gate has elapsed.

But the contract has NO mechanism that prevents a vote being cast LATE. Look
at the legacy `vote()` path:
```
if (block.timestamp > ep.timestamp + VOTE_DEADLINE) revert VoteDeadlinePassed();
```
This is correctly enforced. Reveal path also checks `revealDeadline`. So in
practice late votes should not be possible.

However, `refundUnvotedBribe` requires `totalGaugeVotes == 0` AT refund call.
If a voter manages to vote in the very last block of VOTE_DEADLINE — bumping
`totalGaugeVotes` from 0 to N — that voter then has 21 days during which the
briber's refund attempt reverts `PAIR_HAS_VOTES`. Fine.

But: **there is no mechanism that converts the live `totalGaugeVotes` value
into a "frozen at vote-end" snapshot.** If a future fork / governance flip
extends VOTE_DEADLINE per-epoch (no such code exists today, but the constant
is `public` and could be replaced via an upgrade), the briber's refund-time
check could see a different value than the claim-time check did.

This is a softer concern than F-10-K-02 — it's a code-shape risk for future
maintainers, not an exploitable today.

**Mitigation already in place:** The fact that `VOTE_DEADLINE` is a `constant`
(line 176) and not a storage slot means a contract upgrade would be required
to change it. Acceptable for the current version.

**Severity:** LOW (informational; depends on future refactor).

**Suggested fix (optional):** Snapshot `totalGaugeVotes[epoch][pair]` at the
first `refundUnvotedBribe`/`refundSubQuorumBribe` call into a per-(epoch, pair)
storage cache, so even if a future change made `totalGaugeVotes` writable
post-deadline, the refund-side accounting wouldn't drift. Pure defense-in-depth.

---

## F-10-K-04 — `refundOrphanedBribe` requires `epoch >= epochs.length` but a perpetually-stalled keeper makes legitimate bribes refund-only (MEDIUM-grade design issue)

**Where:** `refundOrphanedBribe` line 1180-1207.

**Mechanic:** The orphan path is gated on `epoch >= epochs.length` — i.e., the
epoch was NEVER advanced. In tandem with `BRIBE_RESCUE_DELAY = 30 days` from
the depositor's last deposit, this means:

1. Briber deposits on epoch 5 at t=0.
2. Keepers stop calling `advanceEpoch()` (perfectly possible: it's
   permissionless but un-incentivised — the only `msg.sender`-side reward is
   gas-free if the call is from a relay; otherwise it's pure altruism).
3. At t = 30 days, briber calls `refundOrphanedBribe(5, P, T)`. Succeeds —
   bribe is fully refunded.

Now the bigger picture: any time the keeper bot has a sustained outage of >30
days, ALL bribers on the in-flight epoch can pull their deposits, leaving the
voters who staked + voted with NO bribes for that period. The voters' VP is
not refunded; only the bribers' tokens are.

This is by design — but it creates a perverse equilibrium where bribers are
incentivised to grief honest keepers. If a briber deposits big, then
private-mempool-front-runs the next `advanceEpoch()` call with a more lucrative
private bribe to validators to NOT include the advance tx, they can extend
"epoch 5 is in-flight" beyond 30 days and pull their deposit while voters
have already locked their VP for the snapshotted-but-never-settled pre-epoch.

**Severity:** MEDIUM (requires sustained validator-bribe collusion, which is
expensive but not impossible). Low likelihood, high impact (full bribe pool
grief).

**Why earlier audits accepted it:** The finding NEW-G2 thread correctly
established "permissionless pull, per-depositor" as the safe pattern. The
asymmetry — voter VP is locked but briber can withdraw — was not modeled.

**Suggested fix:** Either (a) make `advanceEpoch` keeper-incentivised (small
fixed reward in TOWELI from the protocol treasury, capped at max-frequency to
prevent spam), or (b) gate `refundOrphanedBribe` on a longer delay than
`BRIBE_RESCUE_DELAY` if the global-keeper-stall has lasted past the maximum
expected outage (e.g., scale `BRIBE_RESCUE_DELAY` proportional to time since
`lastEpochTime`). Option (a) is the standard Velodrome pattern.

---

## F-10-K-05 — Self-bribe lockout flag (`depositedOnPair`) is never cleared even after refund paths run, locking honest dust-only depositors out of unrelated tokens (LOW)

**Where:** `depositedOnPair[msg.sender][epoch][pair]` set at line 708 / 756 in
deposit paths; never cleared.

**Mechanic:** Once you've deposited *any* bribe on (epoch, pair), you are
locked out of claiming *any* token's bribes on that (epoch, pair) — even after
`refundOrphanedBribe`/`refundUnvotedBribe`/`refundSubQuorumBribe` refunds your
deposit.

This is correct semantically (a depositor should never claim their own bribe).
But consider the interaction with the orphan-rescue path:

1. Alice deposits 1 USDC on (epoch=5, pair=P, token=USDC) at t=0.
2. Alice realises this was a mistake (wrong pair, wrong token, wrong amount).
3. Alice waits 30 days, calls `refundOrphanedBribe(5, P, USDC)`. Refund
   successful.
4. **Alice's `depositedOnPair[alice][5][P]` is STILL TRUE.**
5. Now, ALSO at epoch 5, Bob deposits 1000 DAI on (5, P, DAI). Pair attracts
   honest votes including Alice's. Pair clears quorum.
6. Alice tries to claim her DAI share. `claimBribes(5, P)` reverts
   `SelfBribeClaimForbidden` even though Alice has already withdrawn her
   USDC and never deposited DAI.

Alice loses her DAI claim entitlement entirely. The bribe-vote lockout was
designed to defeat self-arbitrage, but the lockout is per-pair-per-epoch and
doesn't differentiate "still has a deposit" from "deposit was refunded."

**Severity:** LOW (Alice's DAI dust would have been her vote-share of Bob's
bribe — small slice, and Alice arguably forfeited her claim by misallocating
on the same pair). But the rule is sneakier than the natspec implies and may
trip honest users who experiment with small bribes.

**Suggested fix:** Decrement / clear the `depositedOnPair` flag inside each
refund path when `bribeDeposits[epoch][pair][token][msg.sender] = 0` AND the
caller has no other live deposits on (epoch, pair). The accounting cost is
non-trivial because `depositedOnPair` is a single-bool per (user, epoch, pair)
rather than per (token); fixing this needs a counter:

```
mapping(user => epoch => pair => count) liveDepositsOnPair;
```
incremented on deposit, decremented on each refund path. `depositedOnPair`
becomes `liveDepositsOnPair > 0`.

---

## F-10-K-06 — `commitVote` accepts disabled pair indirectly (commit hash is opaque), but `forfeitCommitOnDisabledPair` only refunds if pair is CURRENTLY disabled — voter is stranded if pair is re-enabled (LOW-MEDIUM)

**Where:** `commitVote` line 1504 (cannot validate pair — commit hash is
opaque), `forfeitCommitOnDisabledPair` line 1657-1725 (requires
`factory.disabledPairs(pair) == true` at line 1695).

**Mechanic:** Suppose a pair is disabled at commit time → voter unwittingly
commits hash for the disabled pair (the contract cannot see inside the hash,
and the natspec at V2-GOV-02 confirms this is by design).

1. t = 0: Pair P is disabled. Voter V commits H = hash(addr(this), V, 5, P,
   power, salt) with 10 TOWELI bond.
2. t = 0+δ: Factory governance RE-ENABLES pair P (e.g., the emergency disable
   was a false alarm).
3. Voter V realises they committed against P and now needs to either:
   - **Reveal:** at `revealVote` line 1589, `_validatePair(P)` succeeds
     (pair is now live). Reveal proceeds. Vote is cast. Bond is refunded.
   - **Forfeit:** at `forfeitCommitOnDisabledPair` line 1695,
     `factory.disabledPairs(P) == false` → reverts `PairNotDisabled`.

So the voter's only path is to reveal — meaning their vote is cast on the
re-enabled pair even if they no longer want it cast (e.g., they committed
under duress / by mistake during the disable window). The "forfeit" escape
hatch is closed once the pair is re-enabled.

**Severity:** LOW-MEDIUM (depends on the operational pattern of factory
re-enables — if rare, this is fine; if a normal "false alarm → re-enable"
flow exists, voters lose their escape hatch).

**Suggested fix:** Introduce an additional escape path
`forfeitCommitWithBondLoss(...)` that lets a voter unwind a commit on a LIVE
pair at the cost of forfeiting the 10 TOWELI bond to treasury (instead of the
permissioned-disable refund). This restores voter agency: if you really don't
want your vote cast, you can pay 10 TOWELI to escape. Today the only forced
exit is the sweep path which is bond-loss anyway, but the vote IS cast first
unless you actively skip the reveal — in which case the bond is forfeited
(via `sweepForfeitedBond`) but the vote is NEVER cast either, so the voter
already has this exit. So actually F-10-K-06 reduces to a UX issue: the path
exists (just don't reveal), but it's not documented as such, and the
"commit-was-mistake-unwind-cleanly" path doesn't exist.

Confirmed: voter has the natural escape (don't reveal → bond forfeited at
`sweepForfeitedBond` after revealDeadline → vote is never cast). So this is
purely UX/docstring. Downgrading to **INFORMATIONAL.**

---

## F-10-K-07 — `_safeTransferExternal` is callable only by `address(this)`, but the gas-cost asymmetry between `try`-success and `try`-catch creates a non-uniform claim cost across token pairs (INFORMATIONAL)

**Where:** `_safeTransferExternal` line 1407, called via `try this._safeTransferExternal(token, msg.sender, share)` at line 874 / 978.

**Mechanic:** Solidity `try`/`catch` on an external self-call has a
non-trivial gas premium (~1500 gas overhead vs. a direct internal call). When
batch-claiming across many tokens, this overhead multiplies.

Combined with `MAX_BATCH_ITERATIONS = 200` (line 162), the per-token gas cost
puts a hard cap on how many tokens can be in the bribe set across all epochs
in one call. With 200 iterations and ~50k base + 1.5k overhead per
non-blacklisted token, the cap is around 10M gas — fine for L2 but tight on
L1 mainnet.

**Severity:** INFORMATIONAL. Aerodrome's claim path uses the same try/catch
shape. Not a vulnerability.

---

## F-10-K-08 — `applyMinBribeAmountChange` accepts `amount = 0` which silently restores `DEFAULT_MIN_TOKEN_BRIBE` for tokens previously configured (LOW)

**Where:** `applyMinBribeAmountChange` line 1345; read path `depositBribe`
line 662.

**Mechanic:** The deposit path computes:
```
uint256 tokenMin = minBribeAmounts[token];
uint256 effectiveMin = tokenMin > 0 ? tokenMin : DEFAULT_MIN_TOKEN_BRIBE;
```
So if an admin proposes `applyMinBribeAmountChange(USDC, 0)`, the effective
floor reverts to `DEFAULT_MIN_TOKEN_BRIBE = 1e15`, which is 1e9 USDC (i.e.,
0.001 USDC if treated as 1e6 decimals — but `1e15` against USDC's 6 decimals
is 1e9 USDC = 1000 USDC). This is OFF by 9 orders of magnitude.

Practically: a careless admin setting min to 0 for USDC restores a 1000-USDC
floor where the previous admin-set value was likely 1 USDC = 1e6.

**Severity:** LOW (admin action with timelocked propose/execute, so will be
visible 24h before it lands). Worth flagging.

**Suggested fix:** Validate `amount != 0` in `applyMinBribeAmountChange`
unless an explicit "delete this configuration" flag is set. OR: track a
separate `bool minBribeSet[token]` so 0 means "literally zero floor" rather
than "unset."

---

## F-10-K-09 — `executeEnableCommitReveal` is permissionless on the admin contract (line 201 in `VoteIncentivesAdmin.sol`), letting anyone race the flip after the 24h delay elapses (INFORMATIONAL)

**Where:** `VoteIncentivesAdmin.sol` line 201.

**Mechanic:** Admin's `executeEnableCommitReveal()` is INTENTIONALLY
permissionless (the natspec confirms this — line 196-200). The reasoning
("preserves the original contract's behavior where any party could fire the
timelocked enable once the delay had elapsed") is a faithful preservation of
prior semantics.

Verified: the only side-effect is calling `applyEnableCommitReveal` on the
gated VoteIncentives, which idempotently sets `commitRevealEnabled = true`.
Permissionless execute with one-way idempotent target is fine.

**No issue.** Logged so future maintainers don't trip on the asymmetry with
the other propose/execute pairs which ARE owner-only (lines 89, 112, 136, 163).

---

## F-10-K-10 — Self-bribe lockout interacts oddly with `claimBribesBatch` skipping epochs: depositor on ONE epoch loses unrelated-epoch claims silently (LOW)

**Where:** `claimBribesBatch` line 923.

**Mechanic:** The batch path checks
`depositedOnPair[msg.sender][e][pair]` per-epoch and skips. Correct semantics
within an epoch.

But: a depositor who deposited on (epoch=5, pair=P) and ALSO has a vote-share
claim on (epoch=10, pair=P) (where they did NOT deposit — different epoch)
will see their epoch-10 claim succeed via the batch (since `depositedOnPair`
is keyed by epoch). Good.

However, the `bribeDeposits` map is keyed (epoch, pair, token, depositor)
which is more granular than `depositedOnPair`. So a depositor of token-A on
(5, P) is locked out of token-B on (5, P) too — because `depositedOnPair` is
per-(user, epoch, pair) without token granularity.

This is documented in the natspec at line 322 ("even a depositor who only
bribed token A is locked out of token B claims on the same pair") and is the
intended strict interpretation.

**Severity:** No issue — design choice, documented, defensible.

---

## F-10-K-11 — `epochBribeFirstDeposit` is set on first deposit but never read except in the (now-deprecated) `rescueOrphanedBribes` revert (DEAD CODE)

**Where:** `epochBribeFirstDeposit` write at line 698 / 749, never read.

**Mechanic:** The pre-NEW-G2 design used `epochBribeFirstDeposit` for the
"30 days from first deposit" rescue clock. NEW-G2 swapped to per-depositor
clocks via `lastBribeDepositPerUser`. The first-deposit storage slot is now
written but never read.

**Severity:** Dead code. Costs a SSTORE on first deposit per epoch (~22k gas
on cold slot, ~5k on warm). Worth removing for gas + clarity.

**Suggested fix:** Remove `epochBribeFirstDeposit` mapping and the
two write sites (line 697-700 in `depositBribe`, line 748-750 in
`depositBribeETH`).

---

## F-10-K-12 — `withdrawTreasuryFees` uses `WETHFallbackLib.safeTransferETHOrWrap` (10k gas) but treasury-side accounting tracks `accumulatedTreasuryETH` separately from `totalUnclaimedETHBribes` — sweep paths reserve both, fine — BUT `withdrawTreasuryFees` doesn't decrement before transfer in CEI order (LOW)

**Where:** `withdrawTreasuryFees` line 1147-1152.

**Mechanic:**
```
function withdrawTreasuryFees() external onlyOwner nonReentrant {
    uint256 amount = accumulatedTreasuryETH;
    require(amount > 0, "NO_FEES");
    accumulatedTreasuryETH = 0;          // ← state cleared first ✓
    WETHFallbackLib.safeTransferETHOrWrap(address(weth), treasury, amount);
}
```

CEI is correct. The `nonReentrant` guard is also in place. The `WETHFallbackLib`
uses 10k gas stipend with WETH fallback. Treasury cannot re-enter into other
protocol contracts via the 10k-gas window.

**No issue.** Logged because I initially flagged this as a CEI concern;
detailed read shows it's properly ordered.

---

## F-10-K-13 — `vote` does not check that `_voteEnd > block.timestamp` strict inequality; same-block vote at `t == voteEnd` is rejected, preventing legitimate last-second votes (INFORMATIONAL)

**Where:** `vote` line 613.

```
if (block.timestamp > ep.timestamp + VOTE_DEADLINE) revert VoteDeadlinePassed();
```

This uses `>` not `>=`, so `block.timestamp == ep.timestamp + VOTE_DEADLINE`
is still allowed. Compared against the claim path (line 791):

```
if (block.timestamp <= _voteEnd) revert ClaimWindowNotOpen();
```

which uses `<=`, meaning claims can fire at `_voteEnd + 1`. The two are
consistent: vote allowed at exactly `voteEnd`, claim opens one second later.

**No issue.** Off-by-one symmetry verified.

---

## NOTES / DEAD-ENDS / NON-FINDINGS (verified safe)

### N-01 — Fee-on-Transfer / Rebase token handling
- **Verified safe.** `depositBribe` uses balance-diff at line 655-657. Bribe
  amount stored is `actualReceived - fee`, where `fee` is computed from
  `actualReceived` (line 667). FoT tokens correctly net out the rebase delta.
- Caveat: for *positive-rebase* tokens (rare, e.g., AMPL), the contract holds
  excess after rebase. `sweepToken` reserves `totalUnclaimedBribes[token]`
  which doesn't track positive rebase; admin can sweep the rebase delta. This
  is correct (it's not a depositor's funds — it's protocol accrual on held
  tokens).

### N-02 — Reentrancy on claim
- **Verified safe.** Both `claimBribes` and `claimBribesBatch` have
  `nonReentrant` modifier. ETH path uses 50k gas stipend, ERC20 path uses
  `try/catch` on `_safeTransferExternal` which is itself in the same contract
  — the self-call goes through the `nonReentrant` lock, so re-entry on `claim*`
  is blocked. ERC20 callbacks (e.g., ERC777) cannot re-enter the same
  `claimBribes` invocation.

### N-03 — Signature replay across epochs
- **Verified safe.** No signature-based claim function. Every claim is
  `msg.sender`-keyed.

### N-04 — Bribe withdrawal by briber after votes are cast
- **Verified safe.** `refundOrphanedBribe` requires `epoch >= epochs.length`
  (epoch never advanced), so post-snapshot pull is impossible.
  `refundUnvotedBribe` requires `totalGaugeVotes == 0` (zero votes), and
  `refundSubQuorumBribe` requires sub-quorum — no path to pull bribes after
  votes cleared the quorum.

### N-05 — Whitelist on bribe tokens
- **Verified safe.** `whitelistedTokens[token]` checked in `depositBribe`
  line 650. ETH path `depositBribeETH` does NOT need a whitelist check (ETH
  is implicitly whitelisted). Whitelist is timelocked (24h) via admin.

### N-06 — Bribe top-up after epoch lock
- **Verified safe.** `epochBribesFinalized[epoch]` is set atomically with
  the epoch push in `advanceEpoch` line 565. Both `depositBribe` and
  `depositBribeETH` revert with `EPOCH_FINALIZED` if the live bucket is
  finalized (lines 684, 735). The current epoch (=`epochs.length`) is by
  construction always the un-finalized live bucket.

### N-07 — Vote-weight snapshot manipulability via flash deposit
- **Verified safe.** `SNAPSHOT_LOOKBACK = 1 hours` (line 175). Snapshot
  timestamp = `block.timestamp - SNAPSHOT_LOOKBACK`. Combined with the
  Curve-style `votingPowerAtTimestamp` (returns checkpoint strictly before
  `ts`), a flash-deposited stake at `t` cannot influence epoch advanced at
  `t` or later within the 1-hour cooldown. Fast-forward attack via "mint at
  t, advance immediately" is closed by the lookback.

### N-08 — Self-vote-self-bribe wash
- **Verified safe.** Combined defenses:
  1. `MIN_BRIBE_CLAIM_QUORUM = 100e18` — pool needs at least 100 VP of
     aggregate votes before any claim flows.
  2. `depositedOnPair[user][epoch][pair]` — depositor cannot claim on
     same (epoch, pair).
  3. Snapshot lookback 1h — can't flash-stake into the snapshot.

  An attacker who deposits a bribe and tries to claim it back is locked out
  by (2). An attacker who deposits via wallet A and votes via wallet B can
  satisfy (2) via separation, but to claim ≥quorum power they need 100 VP of
  honest stake either A or B has held >1h before snapshot, which is the cost
  of the attack. With `MIN_DISTRIBUTE_STAKE = 1000e18` minimum total, attacker
  share is bounded.

### N-09 — Per-gauge per-token mapping collision
- **Verified safe.** `epochBribes[epoch][pair][token]` uses three-deep
  mapping with full address keys. Collision space is 2^160 per dimension —
  no realistic collision.

### N-10 — Per-user / per-epoch claim limit bypass
- **Verified safe.** `claimed[user][epoch][pair][token]` is per-token, so
  cross-token wash claim in the same `claimBribes` call doesn't double-credit.
  Solvency check: `sum_users(share) ≤ bribeAmount` because
  `sum(gaugeVotes[u][e][p]) = totalGaugeVotes[e][p]` and each share is
  floor-divided. Dust stays in the contract (tracked by `totalClaimedBribes`).

### N-11 — Cross-contract gauge controller race
- **Verified safe at interface level.** VoteIncentives reads
  `pairToGauge(pair)` from GaugeController to gate deposit (line 132). The
  GaugeController side has its own timelocked add/remove flow. A pair removal
  on the gauge side after a bribe was deposited at epoch N would prevent
  NEW deposits on epoch N+1 but preserve the epoch-N pool. Voter VP is
  still allocatable via `vote(N, P, pwr)` because that path doesn't re-check
  gauge mapping.

  Asymmetry: this is opposite to F-10-K-02 — gauge mapping removal is
  forward-only-affecting, while pair-disable is retroactively-affecting. The
  asymmetry is deliberate per natspec at line 113, but worth noting.

### N-12 — TOWELI commit-bond accounting drift
- **Verified safe.** `totalCommitBonds` is incremented on commit, decremented
  on reveal-refund or sweep-forfeit. `sweepToken(toweli)` reserves
  `totalCommitBonds`. If a future bug double-decrements (e.g., a refund path
  that misses the decrement), `sweepToken` would temporarily over-allow
  sweeping, but only by 10 TOWELI per buggy refund — bounded. Currently no
  drift detected.

### N-13 — Per-block / front-running on `advanceEpoch`
- **Verified safe.** Permissionless + 7-day cadence + 1h lookback =
  no exploitable front-run. The mempool watcher who sees a pending
  `advanceEpoch` cannot stake new VP that will count for the next epoch
  because of the 1-hour lookback. Bribers who try to deposit
  in the same block as `advanceEpoch` either land before (live bucket) or
  after (revert via EPOCH_FINALIZED). Atomicity preserved.

### N-14 — `MIN_BRIBE_CLAIM_QUORUM` = 100e18 → easy to overcome by single 100-token stake
- This was a deliberate design call (10% of `MIN_DISTRIBUTE_STAKE`). The
  combined `depositedOnPair` lockout means a self-vote with 100 VP doesn't
  enable claiming your own bribe — you'd need a partner-vote of 100 VP from
  a different address. Standard collusion model; acceptable.

### N-15 — `epochBribeLastDeposit` (epoch-shared) still written but mostly unused
- Written at line 704 / 753 but only read in the deprecated rescue path.
  Same dead-code observation as F-10-K-11 but the storage cost is per-deposit
  not per-epoch-first-deposit, so larger gas cost. Worth removing alongside
  `epochBribeFirstDeposit`.

---

## SUMMARY

| ID | Severity | Title |
|----|----------|-------|
| F-10-K-01 | LOW | claimBribesBatch self-bribe lockout asymmetry leaves dust trace |
| F-10-K-02 | **MEDIUM** | Pair-disable mid-window strands all post-snapshot bribes |
| F-10-K-03 | LOW | `totalGaugeVotes` not frozen at vote-end (defense-in-depth) |
| F-10-K-04 | **MEDIUM** | Validator-bribe collusion on `advanceEpoch` enables briber rug |
| F-10-K-05 | LOW | `depositedOnPair` flag never cleared after refund |
| F-10-K-06 | INFO | Voter has natural escape (don't reveal); UX-only |
| F-10-K-07 | INFO | Try/catch gas premium on `_safeTransferExternal` |
| F-10-K-08 | LOW | `applyMinBribeAmountChange(0)` falls back to wrong default |
| F-10-K-09 | INFO | Permissionless `executeEnableCommitReveal` is intentional |
| F-10-K-10 | INFO | Self-bribe per-pair-not-per-token lockout is documented |
| F-10-K-11 | DEAD CODE | `epochBribeFirstDeposit` written but never read |
| F-10-K-12 | INFO | `withdrawTreasuryFees` CEI is correct |
| F-10-K-13 | INFO | Off-by-one `>` vs `<=` is symmetric |

**Top items to address:**
1. **F-10-K-02** (pair-disable retroactive trap) — needs a fourth refund path
   or read-side relaxation of `_validatePair`.
2. **F-10-K-04** (validator-bribe rug on `advanceEpoch`) — needs keeper
   incentive or scaled rescue delay.
3. **F-10-K-05** (`depositedOnPair` doesn't clear) — needs counter-based
   tracking instead of single bool.
4. **F-10-K-08** (admin foot-gun on min-bribe = 0) — needs `amount != 0` check
   or explicit "unset" flag.

No critical finding — protocol surface is well-defended in depth, with most
classes of attack (flash-stake, reentrancy, cross-epoch replay, self-bribe
wash, dust-grief) closed by named prior fixes (NEW-G2 thru NEW-G9, BATCH-A C1,
DEEP-GOV-08, R014 H-4). The two MEDIUM items are cross-contract / cross-time
gaps that fall outside the single-flow defenses.
