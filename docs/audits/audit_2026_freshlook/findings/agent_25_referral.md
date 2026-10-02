# Agent 25/100 — ReferralSplitter.sol Fresh-Eyes Audit

**Scope:** `contracts/src/ReferralSplitter.sol` (~803 LoC) — referral
attribution, split logic, payout flow, anti-self-referral, Sybil
defenses, rebate / forfeiture lifecycle, banned-referrer ceremony,
sweep accounting, WETH-fallback payout. Library boundaries inspected:
`WETHFallbackLib`, `TimelockAdmin`, `OwnableNoRenounce`,
`IStakingForReferral`/`IRestakingForReferral` (read-only via STATICCALL).

**Method:** Fresh read of the source; did NOT consult prior audit `.md`
history. Inline comments reference earlier finding IDs (DEEP-DR-L-04,
DEEP-DR-M-07, DEEP-R3-H01, V2-DR-M-03, V2-DR-L-01/02, GOV-ECON-01 / C10,
H-04, M-05, M-17, R014, FRESH-EYES M-5, etc.). Each potential issue
below is rechecked against the inline mitigation and is reported only
where a residual gap, semantic regression, or operational hazard
remains.

---

## F-25-K-01 — `markBelowStake`/forfeit clock is non-self-resetting; a single one-time `markBelowStake` from years ago can satisfy the "7 days continuously below stake" gate after a brief stake dip (LOW-MEDIUM, semantic regression of the documented grace period)

**Where:**
- `markBelowStake` (lines 642-670): permissionless — anyone can call.
  Only writes `lastBelowStakeTime[_referrer]` when caller observes
  `power < MIN_REFERRAL_STAKE_POWER`. Resets to `0` only if caller
  observes `power >= MIN_REFERRAL_STAKE_POWER` at the moment of the
  call.
- `forfeitUnclaimedRewards` (lines 698-703): uses
  `lastBelowStakeTime[_referrer]` directly without any "freshness"
  check on the mark.

**Documented intent (line 672-674):**
> Forfeit unclaimed rewards for a referrer who has been below stake
> threshold for at least 7 days and hasn't claimed in 90 days.

**Mechanic:**

1. T=0: Referrer R is staked above threshold; accruing pendingETH.
2. T=100: R's lock expires + boost decays → power drops below
   `MIN_REFERRAL_STAKE_POWER` for one block.
3. T=101: anybody (e.g., a colluding bot) calls `markBelowStake(R)` →
   `lastBelowStakeTime[R] = 101`.
4. T=102: R re-stakes / lock-extends → power back above threshold.
   `lastBelowStakeTime[R]` is **not** reset because no one calls
   `markBelowStake(R)` again while R is above threshold — the function
   is the only writer to that slot, and it's nobody's job to call it
   "to reset."
5. T=110_000_000 (years later): R has been a healthy active referrer
   continuously since T=102, but has not claimed in 90+ days
   (accumulating pendingETH, see F-25-K-02 for the `lastClaimTime`
   wrinkle). R's lock expires + decays for one block at T=110_000_000.
6. owner (or captured owner) calls `forfeitUnclaimedRewards(R)`:
   - `referrerPower < MIN_REFERRAL_STAKE_POWER` ✓ (the live one-block dip)
   - `lastBelowStakeTime[R] != 0` ✓ (=101, set years ago)
   - `block.timestamp >= 101 + 7 days` ✓ (massively past)
   - `block.timestamp >= lastClaimTime[R] + 90 days` ✓ (per F-25-K-02
     ALL active-but-non-claiming referrers satisfy this)
   - All four predicates pass → forfeit fires; R's entire pendingETH
     balance accumulates to `accumulatedTreasuryETH`.

**Why this regresses the documented "7 days continuously below"
semantic:** the comment on line 105 names the constant
`BELOW_STAKE_GRACE_PERIOD` — the natural reading is "you must be
below threshold for 7 days continuously before forfeit." The code
reads as "you must have been observed below threshold ANY time more
than 7 days ago AND happen to be below threshold at the exact moment
of the forfeit call." A 7-day continuous-below check would require
either (a) snapshotting the highest observed power between mark and
forfeit, or (b) requiring the marker to re-attest at forfeit time.

**Severity:** LOW-MEDIUM. Exploitation requires:
- Captured/colluding owner (operator-level threat). The forfeit path
  is `onlyOwner`.
- Victim has gone 90+ days without claiming (per F-25-K-02 this is
  the default state for any actively earning referrer).
- A timing window where the victim's live power is below threshold at
  the moment of the `forfeitUnclaimedRewards` call. Most TegridyStaking
  positions auto-decay near lock end; the attacker can simply wait for
  any victim to enter the unstake/expiry window.

The 90-day-since-claim gate is the dominant bound. But the spirit of
"7 days of below-stake behaviour" is materially weakened by the
non-self-resetting flag.

**Suggested mitigations (audit-only, not implementing):**
- In `forfeitUnclaimedRewards`, compute current power and require the
  marker to be no older than e.g. `MAX_MARK_AGE = 14 days` from
  `block.timestamp` so the operator can't dredge up an ancient mark.
- Or have `forfeitUnclaimedRewards` itself overwrite
  `lastBelowStakeTime[_referrer] = block.timestamp` when it observes
  current power below threshold and the prior mark is stale, then
  revert with a "come back in 7 days" error so the grace clock is
  always anchored to a fresh observation.
- Or require the referrer's stake to have been below threshold at
  every TegridyStaking checkpoint between `lastBelowStakeTime` and
  now (TegridyStaking exposes `votingPowerAtTimestamp` for this; see
  RevenueDistributor's existing `votingEscrow.votingPowerOf` ⇄
  `votingPowerAtTimestamp` symmetry).

---

## F-25-K-02 — `lastClaimTime` is anchored on first credit, not on continuing activity, so any referrer who accrues without claiming for 90 days satisfies the inactivity gate even though they are actively earning (LOW, semantic mismatch)

**Where:**
- `recordFee` lines 425-428: `lastClaimTime[referrer]` is initialized
  on FIRST fee credit but never updated on subsequent credits.
- `claimReferralRewards` line 473: `lastClaimTime[msg.sender] =
  block.timestamp` — only refreshes on actual claim.
- `forfeitUnclaimedRewards` line 702: predicate uses
  `lastClaimTime[_referrer] + FORFEITURE_PERIOD`.

**Documented intent (line 672-673):**
> a referrer who has been below stake threshold for at least 7 days
> and hasn't claimed in 90 days

**Mechanic:** the constant is named `FORFEITURE_PERIOD` but the
forfeit gate measures `lastClaim`, not "activity." A referrer who
EARNS daily but doesn't bother claiming sees their `lastClaimTime`
frozen at the first-credit timestamp. After 90 days from registration
/ first credit, the inactivity gate is trivially satisfied for the
rest of the contract's lifetime — every block.

**Why this matters:**
- A whale referrer who batch-claims every 6 months (gas-economical
  pattern from Convex / Aave) is permanently inside the inactivity
  window between their batched claims.
- Combined with F-25-K-01, the forfeit path simplifies to: "below
  stake right now AND was marked at any point in the past." The
  90-day claim gate, which is supposed to require true abandonment,
  is satisfied by ANY non-claiming referrer past their 90-day mark.

The doc on line 105 says
"BELOW_STAKE_GRACE_PERIOD" but neither doc mentions that "earning
without claiming" counts as inactivity. The reasonable user model
("if I'm earning, I'm not abandoned") is broken.

**Severity:** LOW. Exploitation requires a captured owner (the
forfeit path is `onlyOwner`). The 24h ban + 24h forfeit-trigger
ceremony, plus the 7-day below-stake grace, give some recovery time.
But the "90-day inactivity" claim in the docstring is misleading —
the on-chain gate is "90 days since last CLAIM."

**Suggested mitigation (audit-only):** track a separate
`lastActivityTime[referrer]` that's bumped on every credit AND every
claim, then use that in the forfeit predicate. Alternatively rename
the constant to `LAST_CLAIM_PERIOD` and update the docstring to
explicitly call out the "earning ≠ activity" semantic.

---

## F-25-K-03 — Referral attribution flows through the immediate caller of SwapFeeRouter, so a wrapper / aggregator contract front-runs all of its users' organic referral attributions (LOW, surface-area / UX issue)

**Where:**
- `SwapFeeRouter._recordReferralFee(msg.sender, fee)` — line 715, 781,
  966 of SwapFeeRouter.sol. Always passes the IMMEDIATE caller of the
  router as `_user` to `ReferralSplitter.recordFee`.
- `ReferralSplitter.recordFee` line 362: `referrer = referrerOf[_user]`.

**Mechanic:** Tegriddy's referral system is keyed on the EOA that
calls `SwapFeeRouter` directly. Any wrapper / aggregator contract that
bundles user transactions (1inch-style aggregator, batched DEX router,
intent-based solver, paymaster relayer, smart account in 4337/EIP-7702
mode that calls the router on behalf of the embedded EOA) breaks
referral attribution: the SPLITTER credits the REFERRER OF THE
WRAPPER, not the referrer-of-end-user.

Concrete consequence: if any wrapper contract `W` is deployed and
ever calls `SwapFeeRouter` (legitimately, on behalf of users):
- `referrerOf[W] = R_W` if W has bound a referrer (or address(0)).
- All users of W route through W → splitter sees `_user = W` →
  `referrer = referrerOf[W] = R_W` → `R_W` accrues 100% of all those
  users' referral shares.
- Each user's bound `referrerOf[user]` is silently ignored.

This is not an exploit per se — it's the natural consequence of
"ETH msg.sender" attribution on a chain where smart-wallets and 4337
are common. But it gives any wrapper deployer a structural edge:
if `W` binds itself to its own staked address `R_W`, the wrapper
captures ALL referral discount accruing through its users.

**Severity:** LOW. By design (and consistent with the SwapFeeRouter
interface that takes `address _user`). Documented nowhere in the
NatSpec; any front-end or aggregator integrator who rolls a wrapper
and doesn't realise this is a footgun for their users (users think
they're earning friend-referrals when in fact the wrapper is harvesting
them). 

**Suggested mitigations (audit-only):**
- Document on the public NatSpec of `recordFee` and `setReferrer`
  that referral attribution is keyed on the IMMEDIATE caller of the
  router, not `tx.origin` or any pass-through EOA. Front-ends should
  warn users binding a referrer that going through a wrapper aggregator
  bypasses the referral.
- Or add a `recordFeeFor(address _origUser, address _user)` overload
  protected by approved-caller list, allowing a trusted aggregator to
  declare the original end-user. Requires a different trust model
  for the aggregator.

---

## F-25-K-04 — `updateReferrer` initialises `referrerRegisteredAt` for a fresh new-referrer but does NOT seed `lastClaimTime`, leaving the FRESH-EYES M-5 invariant only half-applied (LOW, defensive-coding gap; not exploitable in practice)

**Where:**
- `setReferrer` lines 252-263: when first binding a new referrer,
  seeds BOTH `referrerRegisteredAt[_referrer] = block.timestamp` AND
  `lastClaimTime[_referrer] = block.timestamp`. The inline
  FRESH-EYES M-5 comment explicitly explains the rationale (avoid
  `block.timestamp < 0 + FORFEITURE_PERIOD` trivially-false semantic
  for a fresh registrant).
- `updateReferrer` lines 289-291: when migrating a user to a fresh
  new-referrer (`referrerRegisteredAt[_newReferrer] == 0`), seeds
  `referrerRegisteredAt[_newReferrer]` but NOT `lastClaimTime`.

**Mechanic:**

1. User A `setReferrer(R1)` at T=0. R1 fully seeded (`registeredAt =
   0`, `lastClaim = 0`).
2. T=30 days: user A `updateReferrer(R2)` where R2 has never been a
   referrer (`referrerRegisteredAt[R2] == 0`).
3. Per `updateReferrer` line 289-291: `referrerRegisteredAt[R2] =
   30days`, but `lastClaimTime[R2]` stays `0`.
4. R2 stakes well below threshold (or doesn't stake). Fees route to
   treasury (R2 unqualified). `lastClaimTime[R2]` remains `0` because
   `recordFee` line 426 only seeds it on actual pendingETH credit
   (gated on `referrerQualified == true`).
5. Per the FRESH-EYES M-5 comment, the forfeit predicate at this
   point reads `block.timestamp < 0 + FORFEITURE_PERIOD` — trivially
   false past 90 days post-genesis.

**Why this is not exploitable in practice:**

Forfeit reverts on `pendingETH[_referrer] == 0` (line 681), so the
`lastClaimTime[R2] == 0` window is always paired with `pendingETH ==
0`. The first time `pendingETH > 0`, line 426-428 sets `lastClaimTime[R2] =
block.timestamp`, and the M-5 invariant is restored. So the gap is
a defensive-coding regression, not a live exploit.

**Why it should still be fixed:**
- The whole point of FRESH-EYES M-5 is "structural defense against
  captured-owner starve-out of fresh registrants." `updateReferrer`
  is the OTHER path that creates a fresh registrant — symmetry
  argues both paths should seed `lastClaimTime`.
- Future refactor that loosens the `pendingETH == 0` revert (e.g.,
  to allow forfeiting accumulator-routed shares) would reopen the
  starve-out window for the `updateReferrer` path.

**Severity:** LOW (defensive-coding, no live exploit).

**Suggested mitigation (audit-only):** in `updateReferrer`, mirror
the `setReferrer` block:
```solidity
if (referrerRegisteredAt[_newReferrer] == 0) {
    referrerRegisteredAt[_newReferrer] = block.timestamp;
    lastClaimTime[_newReferrer] = block.timestamp;  // mirror setReferrer
}
```

---

## F-25-K-05 — Banned referrer with active stake has their pendingETH permanently stuck unless owner unbans; `forfeitUnclaimedRewards` cannot fire because the `referrerPower >= threshold` predicate vetos forfeit (LOW, operational hazard documented incompletely)

**Where:**
- `proposeBanReferrer` / `executeBanReferrer` (lines 732-753):
  flips `bannedReferrers[banned] = true`. No pendingETH movement at
  ban time.
- `claimReferralRewards` line 462: banned referrer cannot claim.
- `forfeitUnclaimedRewards` line 698-703: requires
  `referrerPower < MIN_REFERRAL_STAKE_POWER` AND prior `markBelowStake`
  AND 7-day grace AND 90-day inactivity. A banned referrer who is
  actively staked has `referrerPower >= MIN_REFERRAL_STAKE_POWER` →
  forfeit reverts.

**Mechanic:**

1. R has accrued pendingETH = X over time and is staked
   (qualifies for the threshold).
2. Owner (legitimately) bans R via the 24h timelock.
3. R can no longer claim (line 462 — V2-DR-M-03).
4. R can no longer ACCRUE new earnings (line 411-413 — V2-DR-M-03).
5. R's pre-ban pendingETH = X stays in `pendingETH[R]`. Owner cannot
   `forfeitUnclaimedRewards(R)` because R is staked, predicate
   on line 699 fires (`referrerPower >= threshold` → revert
   `ForfeitureConditionsNotMet`).
6. Funds stuck in `pendingETH[R]` until either (a) R unstakes
   voluntarily AND the operator runs the markBelowStake → 7-day grace
   → 90-day inactivity ceremony, or (b) owner calls `unbanReferrer(R)`
   to release the freeze (which lets R claim).

**Why this is a hazard:**
- The NatSpec block on lines 454-462 says ban semantics are "post-ban
  no new earnings, pre-ban balance frozen pending owner-side
  forfeitUnclaimedRewards." That's only true if the banned referrer
  voluntarily unstakes. In practice, a bad-faith referrer who knows
  they're going to be banned has incentive to KEEP their stake locked
  (to deny the protocol the forfeiture).
- Even more concerning: the `MIN_REFERRAL_STAKE_POWER = 1000e18`
  threshold can be met with a multi-month TegridyStaking lock. A
  banned referrer who locks 1000e18 for 1 year can deny the protocol
  forfeiture for the entire year.

**Severity:** LOW. The funds are stuck, not lost — owner can always
unban to release them, but that re-enables earning + claiming, which
defeats the ban's purpose. It's a recoverable governance trap.

**Suggested mitigations (audit-only):**
- Drop the `referrerPower >= threshold` veto specifically for banned
  referrers in `forfeitUnclaimedRewards`: a banned referrer's stake
  is irrelevant to the "should we forfeit?" decision (they're already
  being forfeited via the ban ceremony).
- Or add a separate `forfeitBannedReferrer(address)` path with its
  own dedicated 7-day cooldown post-ban-execution. Doesn't need the
  stake-grace + inactivity gate because the ban itself is the
  governance signal.

---

## F-25-K-06 — `referrerOf` is keyed on the IMMEDIATE caller of the splitter, but the splitter's `setReferrer` accepts any address as `_referrer` including a contract that always reverts on receive — DoS vector for the referrer's claim only (LOW, no impact on referee's swaps)

**Where:**
- `setReferrer` line 240: accepts any non-zero, non-self,
  non-banned, non-cyclic address.
- `claimReferralRewards` line 476: uses `WETHFallbackLib.safeTransferETHOrWrap`
  which 10k-gas .call's first, then WETH-wraps on failure.

**Mechanic:** A referrer can be a contract that:
1. Reverts in `receive()` AND
2. Reverts in its WETH `transfer` callback (i.e., it's an ERC777-style
   token holder that hooks into the sender side, OR it's a contract
   whose token balance is held internally with a revert-on-mint).

For (1), the WETH-fallback kicks in and converts to WETH. For (2),
WETH transfer to that contract still completes (WETH is plain ERC20,
no transfer hooks on the receiver side beyond the sender's permit).
So actually... the WETH-transfer leg always succeeds for a plain
contract recipient. The ERC777-style angle isn't reachable here
because WETH is plain ERC20.

So a "revert on receive" referrer just gets WETH instead of ETH.
**No DoS, no fund loss** — `safeTransferETHOrWrap` always completes
for any contract that is reached by a token transfer.

**No finding.** This was an initial false-positive lens hit; the
WETH fallback does correctly defang the "revert-on-receive" DoS class.
Recording here as dead-end so future fresh-eyes don't redo it.

---

## F-25-K-07 — Ring-cycle detection at depth >100 is incomplete by design (referral chain longer than 100 hops can hide a tail cycle), but no economic exploit (INFORMATIONAL)

**Where:**
- `_checkCircularReferral` line 315-344: walks at most
  `CIRCULAR_DEPTH = 100` steps with an in-memory visited list.
- The visited-list check correctly catches ANY cycle within the
  first 100 hops.

**Mechanic:** an attacker can build a chain
A → B → C → ... → Z(101 nodes) where Z's referrer is some node beyond
position 100. The walker exits the loop at i=100 without detecting the
cycle. But:

1. ReferralSplitter only credits the IMMEDIATE referrer (`referrerOf[user]`,
   single hop). It does NOT walk the chain at credit time. So an
   undetected chain cycle at depth 150 has no effect on payouts.
2. The chain walk is only used for cycle-DETECTION at `setReferrer` /
   `updateReferrer`. An undetected cycle means a future user can bind
   into a chain that loops back further down. No economic effect.

**Severity:** INFORMATIONAL. Documented in the ring-detection
commentary on lines 296-313 ("R014: depth raised 25 → 100 with
visited-set check"). The visited-set defeats the closer cycles; the
remaining gap is the deep-tail cycle which has no reward path.

**No finding.** Recorded so the next fresh-eyes doesn't redo the
trace.

---

## F-25-K-08 — Sweep arithmetic invariant is intact (verified) — `sweepUnclaimable` cannot drain referrer pendingETH, treasury accumulator, or caller credits (NEGATIVE finding, verified)

**Where:** `sweepUnclaimable` lines 777-789.

```solidity
uint256 reserved = totalPendingETH + accumulatedTreasuryETH + totalCallerCredit;
uint256 sweepable = balance > reserved ? balance - reserved : 0;
```

**Verification:** traced every state mutator for additions /
subtractions to the three reserved totals:

| Mutator | totalPendingETH | accumulatedTreasuryETH | totalCallerCredit | balance |
|---|---|---|---|---|
| recordFee (qualified ref) | += S | — | += V-S | += V |
| recordFee (unqualified) | — | += S | += V-S | += V |
| recordFee (S=0 dust) | — | — | += V | += V |
| claimReferralRewards | -= P | — | — | -= P |
| withdrawCallerCredit | — | — | -= C | -= C |
| forfeitUnclaimedRewards | -= F | += F | — | — |
| withdrawTreasuryFees | — | -= A | — | -= A |
| sweepUnclaimable | — | — | — | -= (balance-reserved) |

After every mutator, `balance >= totalPendingETH +
accumulatedTreasuryETH + totalCallerCredit`. ✓ no finding.

The S2-H-01 / M-05 / H-04 fix-tags inline already capture this and
the trace confirms each is in place.

**No finding.**

---

## F-25-K-09 — Reentrancy surface inspection: every external-call site is `nonReentrant` AND uses CEI; staking / restaking calls are STATICCALL via the `view`-typed interface so they cannot reenter even on a malicious staking contract (NEGATIVE finding, verified)

**Verification:**

- `recordFee` is `nonReentrant`. The two outbound calls
  (`stakingContract.votingPowerOf` and
  `IRestakingForReferral.votingPowerOf`) are declared `view` in the
  interfaces (lines 11, 20) so Solidity emits STATICCALL — the
  staking contract cannot write state. Even if it could, all state
  mutations in `recordFee` happen BEFORE these calls except the
  pendingETH add (which is fine — read first then write). The
  try/catch correctly fail-closed (treats reverts as 0 power → unqualified).
- `claimReferralRewards` is `nonReentrant`. The `WETHFallbackLib`
  call uses 10k-gas stipend (`H-02` mitigation) so a malicious
  recipient cannot reenter even via the receive-side ETH hook. State
  is zeroed BEFORE the transfer (lines 471-473 → 476). CEI ✓.
- `withdrawCallerCredit`, `withdrawTreasuryFees`,
  `forfeitUnclaimedRewards`, `sweepUnclaimable`: all `nonReentrant`,
  all CEI, all use `safeTransferETHOrWrap` with 10k-gas stipend.
- `setReferrer` / `updateReferrer`: pure storage writes, no external
  calls.
- Admin paths (`proposeXxx`, `executeXxx`, `cancelXxx`, `setApprovedCaller`,
  `revokeApprovedCaller`, `setRestakingContract`, `completeSetup`,
  `unbanReferrer`): pure storage writes, no value transfer.

The 10k-gas stipend specifically defeats the "reenter via WETH
deposit() callback" surface that DEEP-LIB-H1 / H-02 documents in the
WETHFallbackLib commentary. Verified.

**No finding.**

---

## F-25-K-10 — Self-referral via different-EOA is structurally permitted, but every non-trivial economic gain requires meeting `MIN_REFERRAL_STAKE_POWER = 1000e18` voting power — by-design Sybil bound (INFORMATIONAL)

**Mechanic:**

1. Attacker controls EOAs E1, E2.
2. E1 calls `setReferrer(E2)` — passes the SelfReferral check
   (E2 != msg.sender), passes the chain-cycle check (E2 has no
   upstream).
3. E1 swaps via SwapFeeRouter, paying fees. Splitter credits E2 with
   10% of E1's fees.
4. E2 (the attacker's other EOA) needs to stake 1000e18 TOWELI
   voting-power-equivalent to actually claim. So the Sybil cost is
   (a) one EOA's gas, (b) 1000e18 TOWELI staked-and-locked.

**Why this is by design:** every referral system on EVM has this
shape (Curve / Convex / Velodrome / Aerodrome / Aave / etc.). The
defense is the staking gate, NOT the same-EOA check. This contract
correctly applies:
- 7-day age gate on the referrer (line 467) — anti-flash-Sybil.
- 1000e18 stake-power gate on credit (line 400) — Sybil-cost floor.
- 30-day cooldown on referrer changes (line 280) — anti-grief.
- Banned-referrer list (line 246) — post-detection cleanup.

The remaining "self-Sybil for own discount" is the documented design
consequence of any referral system: anyone with 1000e18 TOWELI staked
gets a 10% rebate on their own swaps (via a self-controlled second
EOA bound as referrer). That's a feature, not a bug — it incentivises
TOWELI staking, which is a protocol goal.

**No finding.**

---

## F-25-K-11 — Front-running referral bind: not exploitable because `setReferrer` keys on `msg.sender` and only the user's own signature can submit it (NEGATIVE finding, verified)

**Verification:**
- `setReferrer(_referrer)` line 240: `referrerOf[msg.sender] =
  _referrer`. msg.sender is the user themselves; no path lets a
  third party set someone else's referrer.
- No `setReferrerFor(address user, address referrer)` overload exists.
- No EIP-712 / permit-style flow for referrer binding.
- No approved-caller path can mutate `referrerOf[other_user]`.

The classic "front-run bind" attack (attacker sees user's pending
`setReferrer(friend)` tx in mempool, replaces with
`setReferrer(attacker)`) is structurally impossible because only the
user signs.

**No finding.**

---

## F-25-K-12 — Permanent-referrer "switch silently" attack: not exploitable because `updateReferrer` requires both 30-day cooldown AND the user's own signature (NEGATIVE finding, verified)

**Verification:**
- `updateReferrer` is `external`, msg.sender keyed (line 271,
  `_newReferrer != msg.sender`).
- 30-day cooldown enforced on line 280.
- Banned-target check (line 277).
- Cycle-detection (line 279).

A referrer cannot be silently switched out from under a user — the
user is the only authorized writer.

**No finding.**

---

## F-25-K-13 — Per-token attribution: contract is ETH-only (no per-token attribution surface) (N/A)

The lens prompt mentions "per-token attribution edge cases" but
ReferralSplitter only handles ETH (`pendingETH`, `accumulatedTreasuryETH`,
`callerCredit` are all ETH-denominated; payouts use
`WETHFallbackLib.safeTransferETHOrWrap`). No ERC20 fee-paying path,
no per-token referrer state. **Scope mismatch.** N/A.

---

## F-25-K-14 — Token whitelist / blacklist circumvention: not applicable (ETH-only) (N/A)

Same as F-25-K-13 — contract has no token-allowlist or denylist
surface. N/A.

---

## F-25-K-15 — Split BPS overflow: bounded at 30%, no overflow surface (NEGATIVE finding, verified)

**Verification:**
- `MAX_REFERRAL_FEE = 3000` (line 85).
- `proposeReferralFee` reverts if `_feeBps > MAX_REFERRAL_FEE`
  (line 586).
- `proposeReferralFee` reverts if `_feeBps == 0` (line 589) —
  M-16 fix.
- `recordFee` line 363: `referrerShare = (msg.value * referralFeeBps)
  / BPS`. Worst case: `msg.value = type(uint256).max`,
  `referralFeeBps = 3000`. `msg.value * 3000` overflows iff
  `msg.value > 2^256 / 3000 ≈ 3.86e73`. Not reachable on any chain.
- `BPS = 10000` constant. Division never zero-divides.
- No accumulator at risk of overflow because msg.value itself is
  bounded by the EVM's 2^256 ETH supply ceiling.

**No finding.**

---

## F-25-K-16 — Cooldown / minimum-payout accumulator inflation: no per-claim cooldown OR min-payout floor — `claimReferralRewards` accepts any non-zero pending balance (NEGATIVE finding, verified)

**Verification:**
- `claimReferralRewards` line 469: `if (amount == 0) revert NothingToClaim()`.
  No min floor; even 1 wei pending is claimable.
- No "wait N hours between claims" cooldown.
- `MIN_REFERRAL_AGE = 7 days` is a one-time gate from
  registration, NOT per-claim.

So the typical "accumulator inflation" attack (force the referrer to
let pendingETH grow before claim, then someone else's call drains it
during the gap) doesn't apply here because:
1. There's no batched-credit flow that other parties can race.
2. `pendingETH` is per-referrer; nobody else can claim on their
   behalf.
3. The `forfeitUnclaimedRewards` path is `onlyOwner` and gated on
   90-day inactivity + below-stake → not an accumulator-race vector.

**No finding.**

---

## Lens Coverage Summary

| Lens | Status | Finding |
|---|---|---|
| Self-referral bypass (different EOA / contract / proxy) | By design (Sybil-bounded by stake gate) | F-25-K-10 (info) |
| Sybil farming via thousands of referrers | Bounded by 1000e18 stake-power per claiming referrer | F-25-K-10 (info) |
| Referral chain (multi-level) loop / cycle | Defended at depth ≤100 with visited-set | F-25-K-07 (info, deep-tail cycle benign) |
| Front-run referral bind | Structurally impossible (msg.sender keyed) | F-25-K-11 (verified, no finding) |
| Referral bind after the fact / race | Structurally impossible | F-25-K-11 (verified, no finding) |
| Permanent referrer — switch silently / griefable | Defended by 30-day cooldown + msg.sender keying | F-25-K-12 (verified, no finding) |
| Per-token attribution edge cases | N/A — ETH-only | F-25-K-13 (scope mismatch) |
| Stuck rebate (referee leaves, referrer rebate orphaned) | Recoverable via forfeit ceremony except F-25-K-05 | F-25-K-05 (LOW) |
| Sweep function siphoning rebates | Sweep math invariant verified | F-25-K-08 (verified, no finding) |
| Cooldown / minimum payout — accumulator inflation | No surface | F-25-K-16 (verified, no finding) |
| Reentrancy in payout | All paths nonReentrant + CEI + 10k-gas stipend | F-25-K-09 (verified, no finding) |
| Referrer is contract that reverts → DoS for referees | WETH fallback defangs DoS | F-25-K-06 (verified dead-end) |
| Token whitelist / blacklist circumvention | N/A — ETH-only | F-25-K-14 (scope mismatch) |
| Split BPS overflow | Capped at 30%, no overflow surface | F-25-K-15 (verified, no finding) |

## Live findings (severity ≥ LOW)

- **F-25-K-01**: `markBelowStake` flag is non-self-resetting; ancient
  marks satisfy the "7 days continuously below" gate. (LOW-MEDIUM)
- **F-25-K-02**: `lastClaimTime` is anchored on first credit, not on
  continuing activity, so any active-but-non-claiming referrer
  trivially satisfies the 90-day inactivity gate. (LOW)
- **F-25-K-03**: Referral attribution is keyed on the immediate
  caller of SwapFeeRouter; smart-wallet / aggregator wrappers harvest
  their users' organic referrals. (LOW, undocumented)
- **F-25-K-04**: `updateReferrer` does not seed `lastClaimTime` for a
  fresh new-referrer (FRESH-EYES M-5 invariant only half-applied;
  defensive-coding gap, no live exploit).
- **F-25-K-05**: Banned referrer with active stake has pendingETH
  permanently stuck unless owner unbans (governance trap). (LOW)

---

End of report.
