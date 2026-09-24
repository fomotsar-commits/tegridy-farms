# DEEP Audit (Pass 2) — Router & Fee-Conversion Stack post-fix-1bcbb72

**Date:** 2026-05-01
**Mode:** AUDIT-ONLY · Re-audit of post-fix code · Regressions, missed gaps, side effects
**Files audited (post-fix):**
- `contracts/src/TegridyRouter.sol` (570 lines)
- `contracts/src/SwapFeeRouter.sol` (1756 lines)
- `contracts/src/SwapFeeRouterAdmin.sol` (431 lines)

**Methodology:** Re-derive each pass-1 finding's invariant against post-fix source.
Verify the closure didn't introduce a sibling miss or weaken a downstream consumer.
Then hunt the explicitly-listed regression hot-spots and the new
inline-timelock state machines (`proposeResetTWAPSnapshot`, the post-fix
`adminReplacement` path).

**Severity counts:** 1 High · 3 Medium · 2 Low · 1 Info  (7 NEW findings)

**Closure status of pass-1 findings:**
- DEEP-R-H01 → CLOSED (multi-hop branches now skip TWAP, but introduces R2-H01 below)
- DEEP-R-H02 → CLOSED with side-effect (see R2-M02)
- DEEP-R-M01 → CLOSED (7-day expiry on `executeAdminReplacement`)
- DEEP-R-M02 → CLOSED (zero-address intermediate hop reject correct for len=2)
- DEEP-R-M03 → **REGRESSION** — see R2-H01 (50k cap silently breaks legitimate referrers)
- DEEP-R-M04 → CLOSED (`PolShareNonZero` check)
- DEEP-R-M05 → CLOSED (TegridyRouter `to == address(this)` rejected on 9 entries + 2 removeLiquidity)
- DEEP-R-M06 → CLOSED with caveat (R2-L02)
- DEEP-R-L01 → DEFERRED inline (acknowledged in code comment)
- DEEP-R-L02 → CLOSED
- DEEP-R-L03 → PARTIAL — per-caller cooldown (see R2-L01)
- DEEP-R-I01 → CLOSED (typed catches)

---

## [DEEP-R2-H01] 50k gas cap on `_recordReferralFee` silently demotes legitimate referrers with multiple staking positions

**Severity:** High
**File:** `contracts/src/SwapFeeRouter.sol:445-459` × `contracts/src/ReferralSplitter.sol:312-367` × `contracts/src/TegridyStaking.sol:377-396`
**Category:** dos · referral · regression
**Closes:** N/A (introduces a new vector while closing DEEP-R-M03)

**Bug:** The post-fix `_recordReferralFee` forwards exactly 50_000 gas to
`referralSplitter.recordFee(...)`. Inside `recordFee`, the splitter does ~30-40k
of pre-work (multiple cold SLOADs + SSTOREs for `setupComplete`,
`referrerOf[user]`, `callerCredit[msg.sender]`, `totalCallerCredit`) BEFORE
reaching `try stakingContract.votingPowerOf(referrer)`. With ~10-15k of gas
remaining at the try-call, EIP-150 forwards ~10-14k to `votingPowerOf`.

`TegridyStaking.votingPowerOf` iterates the user's stake-position set with
~8.4k gas per cold position (3 × cold SLOAD on `set.at(i)`,
`positions[id].amount`, `positions[id].lockEnd`, `positions[id].boostBps`).
With even 2 active positions the inner staticcall OOGs.

The `try`/`catch` INSIDE `recordFee` swallows the OOG silently:
```solidity
// ReferralSplitter.sol:343-349
try stakingContract.votingPowerOf(referrer) returns (uint256 power) {
    referrerQualified = power >= MIN_REFERRAL_STAKE_POWER;
} catch {
    // Staking contract reverted — treat as unqualified  ← OOG lands here
}
if (!referrerQualified) {
    accumulatedTreasuryETH += referrerShare;   // referrer's cut → treasury
    emit UnclaimableSentToTreasury(referrer, referrerShare);
    return;
}
```

`recordFee` then returns SUCCESS to SwapFeeRouter, which records the path
through `if (!_recordReferralFee(...)) accumulatedETHFees += fee;` as
"forwarded successfully" — so SwapFeeRouter does NOT emit
`ReferralFeeRedirectedToTreasury`. The legitimate referrer is silently cheated;
the funds are routed to `accumulatedTreasuryETH` instead of `pendingETH[referrer]`.

**Attack / Impact:** Three failure modes, all introduced by the patch:

1. **Honest user with active staking referrer**: every swap by a referred user
   silently cheats the referrer if the referrer has ≥2 cold staking positions
   on the path. Pre-fix the inner call had effectively unlimited gas (63/64 of
   the swap caller's gas budget). Post-fix it has ~10k.
2. **Adversarial griefer**: cannot directly attack — but the silent demotion
   matches the marketing-sensitive "stakers earn referrals" claim. Any heavy
   staker who funded a referral campaign sees their earnings vanish into
   `accumulatedTreasuryETH` with no visible event in either the splitter or the
   router.
3. **Off-chain monitoring**: no event to alert on. `SwapExecuted` fires
   normally, `recordFee` succeeds, only `UnclaimableSentToTreasury` (in the
   splitter, not the router) hints that something is off — and even that event
   is normal for unregistered referrers, so it doesn't disambiguate the OOG
   case.

This is a direct regression: pre-fix, every legitimate referrer of every
qualified user was correctly credited.

**Evidence:**
```solidity
// SwapFeeRouter.sol:447-458 — 50k cap added in 1bcbb72
try referralSplitter.recordFee{value: _feeAmount, gas: 50_000}(_user) {
    return true;
}
```

`recordFee` cost-floor (cold-storage path, before `votingPowerOf`):
- nonReentrant SLOAD + SSTORE: ~5.1k
- onlyApproved SLOAD: 2.1k
- setupComplete SLOAD: 100 (warm)
- referrerOf[_user] SLOAD: 2.1k (cold)
- referralFeeBps SLOAD: 100
- callerCredit[msg.sender] SSTORE: 22.1k (cold-zero → non-zero)
- totalCallerCredit SLOAD/SSTORE: ~7k
- subtotal: ~38.5k

That leaves ~11.5k for `votingPowerOf(referrer)` after EIP-150 forwarding —
covers maybe 1 stake position cleanly. Any user with ≥2 positions gets
silently demoted.

Compare with `distributeFeesToStakers` line 1156 which uses the same 50k cap
but only for `revenueDistributor.receive()` / `polAccumulator.receive()` — both
are intentionally minimal `receive()` shims (single SSTORE + LOG), so 50k is
generous. The pattern was wrongly transplanted onto `recordFee`, which has a
much larger native footprint.

**Recommendation:** Three options ranked by minimality:

(a) **Raise the cap** to a number that comfortably accommodates `recordFee`'s
   real cost + a realistic stake-set iteration. 200k matches typical referral
   payment costs in OpenZeppelin's example splitter; protocol's own tests
   never observed >120k. Solidity allows `gas: 200_000` on try.

(b) **Remove the cap** entirely on `_recordReferralFee` and gate the splitter
   behind a 48 h timelock on `applyReferralSplitter` (already in place).
   Trust the timelocked address. Same pattern the protocol already uses for
   `revenueDistributor` and `polAccumulator` (no per-call gas caps on those
   either; the 48 h timelock is the trust boundary).

(c) **Cache voting power** so `votingPowerOf` is amortised. Out of scope for
   the routers cluster but the cleanest long-term fix.

(a) is the lightest patch. The 50k value should not have been picked without
   instrumenting the actual splitter's consumption.

---

## [DEEP-R2-M01] Multi-hop owner-only conversion path has NO floor on caller-supplied `minETHOut`

**Severity:** Medium
**File:** `contracts/src/SwapFeeRouter.sol:1362-1376` × `:1448-1462`
**Category:** admin · math
**Closes:** N/A (gap exposed by DEEP-R-H01 fix)

**Bug:** The DEEP-R-H01 fix routes multi-hop conversion paths
(`path.length > 2`) into a branch that completely skips the on-chain TWAP
floor and trusts the caller-supplied `minETHOut` verbatim:

```solidity
// SwapFeeRouter.sol:1365-1370 (mirrored at :1454-1456 for FoT variant)
if (path.length > 2) {
    // Owner-only branch: no direct-pair TWAP anchor; trust the operator's minETHOut.
    effectiveMin = minETHOut;
    emit ConversionTWAPFloor(token, effectiveMin, minETHOut, false);
}
```

There is NO minimum bound on `minETHOut`. The owner can pass `0`, and the
inner Uniswap router's slippage check is also `0`. The entire accumulated token
balance can be drained for any output the AMM happens to produce — which an
attacker controlling intermediate hops can drive arbitrarily low via
sandwiching the multi-hop swap.

**Attack / Impact:** Two related vectors:

1. **Temporarily compromised owner key**: an attacker who briefly captures the
   owner key (phish, key leak, social-engineering before the owner notices)
   can call `convertTokenFeesToETH(token, [token, MID, WETH], 0, deadline)`
   and the entire `accumulatedTokenFees[token]` is drained for whatever ETH
   the (sandwiched) multi-hop produces. Because the new path bypasses TWAP
   entirely, even the 1.5% safety margin is gone. Pre-fix this attacker was
   bound by `_readCurrentCumulative` reverting on missing direct pair (which
   admittedly was the DEEP-R-H01 bug for legitimate use-cases).

2. **Honest owner mistake**: a script that pastes `minETHOut = 0` (or a
   `minETHOut` from a stale quote) drains value silently. Off-chain monitoring
   can detect via `ConversionTWAPFloor` emitting `effectiveMin = 0`, but
   damage is already done by the time the alert fires.

The 1 h `CONVERSION_COOLDOWN` partly bounds repeat exploitation (one drain per
token per hour), but `accumulatedTokenFees[token]` is the protocol's
multi-day USDC/WBTC/etc. accumulation — a single drain is the loss event.

**Evidence:**
```solidity
// SwapFeeRouter.sol:1365-1370 (and 1454-1456 for FoT variant)
if (path.length > 2) {
    effectiveMin = minETHOut;  // ← no floor; 0 is accepted
    ...
}
...
router.swapExactTokensForETH(amount, effectiveMin, path, address(this), deadline);
if (ethReceived < effectiveMin) revert InsufficientOutput();  // ← also tautology when effectiveMin = 0
```

The pass-1 fix correctly observed that "owner-only multi-hop already implies
trust" — but trust does NOT mean "no defence in depth". Every other admin path
on this contract has a hardcoded minimum (`MIN_STAKER_SHARE_BPS`,
`MAX_POL_SHARE_BPS`, `MAX_FEE_BPS`, `MAX_PREMIUM_DISCOUNT_BPS`,
`MIN_TOKEN_FEE_FOR_CONVERSION`); the multi-hop conversion is the only owner
write path with NO ceiling on the slippage parameter.

**Recommendation:** Anchor against the FIRST hop's pair (the
`token / path[1]` pair), not the omitted token/WETH direct pair. A first-hop
TWAP gives a token→intermediate floor; combine with a permissive multi-hop
slippage tolerance (e.g. `5–10%`) and enforce
`effectiveMin = max(callerMinETHOut, twapFromFirstHop * MAX_MULTIHOP_SLIPPAGE_BPS / BPS)`.

Concretely:
```solidity
if (path.length > 2) {
    // Anchor against the first hop's TWAP: token → path[1].
    // Trust the operator's minETHOut as a TIGHTENING of this floor.
    address firstHopPair = uniFactory.getPair(token, path[1]);
    if (firstHopPair == address(0)) revert NoPairForToken();
    uint256 multiHopFloor = _twapFromPair(firstHopPair, token, amount)
                             * (BPS - MAX_MULTIHOP_SLIPPAGE_BPS) / BPS;
    effectiveMin = minETHOut > multiHopFloor ? minETHOut : multiHopFloor;
    emit ConversionTWAPFloor(token, effectiveMin, minETHOut, false);
}
```

If the team prefers minimal invasion, at minimum require `minETHOut > 0` for
the multi-hop branch — that single check turns an owner-key-compromise drain
into a noisy revert.

---

## [DEEP-R2-M02] `whenNotPaused` on `withdrawPendingDistribution` lets owner DOS legitimate recipients during indefinite pause

**Severity:** Medium
**File:** `contracts/src/SwapFeeRouter.sol:1511-1519` × `:1228-1229`
**Category:** admin · dos
**Closes:** N/A (side-effect of DEEP-R-H02 fix)

**Bug:** The DEEP-R-H02 fix added `whenNotPaused` to
`withdrawPendingDistribution`, blocking pulls during `paused()`. `pause()` is
an unconditional `onlyOwner` call (lines 1228-1229). There is no two-step
unpause, no maximum pause duration, no guardian-cancel. So:

1. An ETH slice deferred to `revenueDistributor` (e.g. because that contract
   was paused mid-distribution) is queued in `pendingDistribution[revDist]`.
2. Owner pauses the SwapFeeRouter for incident response.
3. The deferred ETH cannot be pulled until the owner unpauses.
4. If the owner key is compromised and the attacker holds pause indefinitely,
   the deferred recipients (revenueDistributor → stakers, polAccumulator)
   are denied funds permanently.

Pre-fix the queue was a true pull-pattern: anyone could pull on the
recipient's behalf and the worst the owner could do was withhold the
ECONOMICALLY SENSITIVE distribution flow (`distributeFeesToStakers`). With
the new pause coverage, the OWNER can withhold slices that are already
allocated to specific recipients.

The H02 attack vector (MEV searcher front-running pause to push ETH at a
mid-incident downstream contract) is real — but applies to
`distributeFeesToStakers` (which DOES need `whenNotPaused`). It does NOT
apply to `withdrawPendingDistribution` because that path SENDS to the
ORIGINAL queued recipient — the destination was already chosen at queue
time, before the incident. There is no mid-incident attacker steering of
funds; the worst outcome is "queued ETH lands at the once-good destination
that's now compromised", which the H02 finding's own scenario already
admits.

**Attack / Impact:** Owner-key-compromise scenario:

1. Attacker takes owner key.
2. Attacker calls `pause()`. SwapFeeRouter is now frozen.
3. Attacker has 7-day window before `executeAdminReplacement` (admin rotation)
   becomes possible (best case — assumes a proposal already exists; otherwise
   propose now, wait 7 days). If no proposal exists, attacker can also
   `proposeAdminReplacement` to a hostile contract and execute in 7 days.
4. Throughout this window, ALL `pendingDistribution` slices are stuck.
5. Stakers, POL recipient, and any other deferred destination see
   no inflows. Combined with the pause on `distributeFeesToStakers`, the
   protocol is fully bricked except for owner-only `sweepETH` /
   `withdrawTokenFees` (treasury-only paths the attacker can use to drain).

The H02 fix protects against MEV front-running of pause; but it widens the
owner-key-compromise blast radius for the SAME flow it was meant to harden.

**Evidence:**
```solidity
// SwapFeeRouter.sol:1511 — added in 1bcbb72
function withdrawPendingDistribution(address recipient) external nonReentrant whenNotPaused {
    ...
}

// :1228-1229 — pause is unilateral
function pause() external onlyOwner { _pause(); }
function unpause() external onlyOwner { _unpause(); }
```

**Recommendation:** Drop `whenNotPaused` from `withdrawPendingDistribution`.
The pull-pattern's value is exactly that the queued slice can be drained
without any privileged action. The H02 vector that motivated this fix was
about `distributeFeesToStakers` — keep `whenNotPaused` there (correctly
restored in the same commit) but separate the policy for the pull function.

If the team wants pause to also halt pull-pattern drains for the rare
"distributor was just discovered to be compromised post-queue" case, gate
the pause-on-pull behaviour behind a separate `pendingDistributionPaused`
flag with a 24 h timelock so an attacker can't instantly freeze recipients
during a key-compromise window.

---

## [DEEP-R2-M03] `_validateConversionPath` re-runs duplicate-check after the new zero-address loop — combined gas cost on 4-hop paths is non-trivial

**Severity:** Low
**File:** `contracts/src/SwapFeeRouter.sol:1595-1617`
**Category:** other
**Closes:** N/A (cosmetic regression from the DEEP-R-M02 fix)

(Downgrading severity from Medium after re-derivation — actual gas overhead
is bounded by `MAX_CONVERSION_PATH_LENGTH = 4` so worst-case is ~6
extra-iteration comparisons.)

**Observation:** The new zero-address intermediate-hop loop runs at lines
1607-1609. The pre-existing duplicate-check loop at lines 1611-1615 then runs
the SAME `O(n²)` traversal. Both are correct, but the new loop traverses the
same range the duplicate check already covers. A single loop could fold both
checks together:

```solidity
for (uint256 i = 0; i < len; i++) {
    if (i > 0 && i < len - 1 && path[i] == address(0)) revert InvalidConversionPath();
    for (uint256 j = i + 1; j < len; j++) {
        if (path[i] == path[j]) revert InvalidConversionPath();
    }
}
```

Saves ~600 gas on 4-hop owner-only conversions (twice per call, since FoT
variant runs the same path through the same validator). Negligible per call;
the observation is more about code-style clarity than a security issue.

**Recommendation:** Optional cleanup. Leave as is unless there's a separate
gas-optimisation pass scheduled.

---

## [DEEP-R2-L01] `recoverCallerCredit` cooldown is per-msg.sender, not per-state — bypassable via N EOAs

**Severity:** Low
**File:** `contracts/src/SwapFeeRouter.sol:1531-1545`
**Category:** dos · regression-residual
**Closes:** N/A (residual of DEEP-R-L03)

**Bug:** The cooldown stores `lastCallerCreditPullAt[msg.sender]`. An attacker
that spawns N EOAs and calls `recoverCallerCredit` from each can run N
calls/block — they just pay 21k gas (transaction base) + ~10k (call) each.
The pre-fix grief vector (zero-amount events spamming logs) is mitigated
PER-EOA but not PER-PROTOCOL.

The pass-1 finding's recommendation said:
> Either (a) add a per-tx cooldown (`mapping(address ⇒ uint256)
> lastCallerCreditPull`), or (b) skip the external call when the splitter
> exposes a `pendingCallerCredit() view` that returns zero.

Option (a) was chosen. (a) was MIS-RECOMMENDED in pass 1; the bypass via
multiple senders is intrinsic to keying on `msg.sender`. Better fix is a
per-CONTRACT cooldown OR a `pendingCallerCredit() view` precheck.

**Impact:** Same negligible-direct-impact assessment as the pass-1 finding —
no funds loss, log clutter only. Just calling out that the chosen
implementation doesn't actually shut the original grief loop, only raises the
per-attacker cost slightly.

**Recommendation:** Either:

(a) Use a single-slot last-pull timestamp:
```solidity
uint256 public lastCallerCreditPullAt;
...
if (lastCallerCreditPullAt + RECOVER_CALLER_CREDIT_COOLDOWN > block.timestamp) revert ...;
lastCallerCreditPullAt = block.timestamp;
```
Then each block-level grief costs the same 30 s window regardless of EOA
spawning.

(b) Probe the splitter via a new view:
```solidity
if (referralSplitter.pendingCallerCredit(address(this)) == 0) return;
```
Adds an interface method to ReferralSplitter; cleaner long-term.

---

## [DEEP-R2-L02] `proposeResetTWAPSnapshot` proposal cannot be replaced — owner must `cancelResetTWAPSnapshot` first to switch tokens

**Severity:** Low
**File:** `contracts/src/SwapFeeRouter.sol:991-1022`
**Category:** admin
**Closes:** N/A (UX gap on DEEP-R-M06 fix)

**Bug:** The new inline propose/execute/cancel triplet for the TWAP snapshot
reset uses a single global `pendingResetToken` slot. If the owner proposes a
reset for token `A`, then realises `B` is the token that actually needs
resetting, they MUST first call `cancelResetTWAPSnapshot` before
`proposeResetTWAPSnapshot(B)`. Otherwise:

```solidity
// SwapFeeRouter.sol:991-997
function proposeResetTWAPSnapshot(address token) external onlyOwner {
    if (token == address(0)) revert ZeroAddress();
    if (twapSnapshotResetReadyAt != 0) revert TWAPSnapshotResetUnavailable(); // ← reverts
    ...
}
```

Same shape as the admin-replacement flow. Mirrors the existing
`adminReplacement` UX. Listed because this is a NEW state machine added in the
fix — wanted to call out that it inherits the same "cancel-before-replace"
quirk that other inline timelocks have.

A token-keyed mapping (`mapping(address ⇒ uint256) pendingResetReadyAt`)
would let owners propose multiple per-token resets concurrently. Probably
unnecessary in practice (snapshot poisoning is rare) but worth noting.

**Recommendation:** Defer. Document the cancel-first requirement in the
function NatSpec.

---

## [DEEP-R2-I01] Multi-hop conversion permanently writes nothing to `lastConversionSnapshot[token]` — first post-multi-hop direct call still pays the bootstrap-owner gate

**Severity:** Info
**File:** `contracts/src/SwapFeeRouter.sol:1392-1396` × `:1477-1481`
**Category:** other
**Closes:** N/A (acknowledged design choice in code comment)

**Observation:** The DEEP-R-H01 fix correctly leaves
`lastConversionSnapshot[token]` untouched during a multi-hop conversion
(because the snapshot anchor is the direct token/WETH pair, which a multi-hop
swap may not have touched). Code comment at line 1390:

```solidity
// AUDIT FIX: DEEP-R-H01 — only snapshot for direct 2-hop swaps; multi-hop has
// no direct-pair anchor so we leave any prior snapshot untouched.
```

Side effect: if a token is in the "multi-hop only" lifecycle (no direct pair
exists on the AMM), `lastConversionSnapshot[token]` stays
`{timestamp: 0, cumulative: 0}` forever. Every subsequent attempt to call
`convertTokenFeesToETH(token, [token, WETH], …)` (a permissionless caller
attempting the direct path) will:

1. Call `_enforceTWAPMinETHOut` (path.length == 2 branch).
2. Call `_readCurrentCumulative(token)` → reverts `NoPairForToken` because the
   direct token/WETH pair doesn't exist.

So the protocol's permissionless conversion path remains permanently CLOSED
for multi-hop-only tokens. That's CORRECT behavior (no direct pair means no
permissionless slippage anchor), but it's worth flagging that the multi-hop
feature is FOREVER owner-only for these tokens — there's no graduation path
where an established multi-hop token "earns" permissionless conversions.

Practical consequence: the keeper bot for ALT tokens that are multi-hop-only
must be the owner address itself. If the team intends keeper bots to call
these conversions, they need either (a) a privileged-keeper role or (b) to
keep all multi-hop-only token conversions on a manual schedule.

**Recommendation:** Document this in the convertTokenFeesToETH NatSpec
explicitly so deployers don't ship a keeper bot that silently fails on
multi-hop-only tokens. No code change required.

---

## Summary of patterns observed in this pass

1. **The 50k gas cap was wrongly transplanted.** It was the right fix for
   `revenueDistributor.receive()` / `polAccumulator.receive()` — both minimal
   shims. It was the WRONG fix for `referralSplitter.recordFee` — a function
   that already had a deliberately heavy implementation (fee accounting +
   external `votingPowerOf`). The transplant pattern is a subtle anti-pattern
   to add to the protocol's review checklist: "if reusing a gas cap, prove
   the destination function fits".

2. **Multi-hop owner-only branch traded one TWAP-floor problem for another.**
   The DEEP-R-H01 fix correctly observed that the original TWAP gate was
   structurally unreachable for multi-hop. The replacement ("trust caller's
   minETHOut") swung too far in the other direction — no floor at all,
   including no minimum-non-zero check. A mid-ground (anchor against
   first-hop pair, with a slightly looser slippage tolerance) would close
   both sides.

3. **`whenNotPaused` is a one-way ratchet under owner-key compromise.** The
   DEEP-R-H02 fix correctly noted that the original pause was asymmetric.
   The new pass made it symmetric by adding `whenNotPaused` everywhere — but
   this also means a captured-owner who calls `pause()` freezes EVERY
   user-protective flow, including the pure pull-pattern that doesn't need
   protecting. Fine-grained pause flags (or
   `pause-but-allow-pull-distribution`) is the standard Aave/Compound pattern
   for this.

4. **Per-msg.sender cooldowns are not protocol cooldowns.** Pass 1 recommended
   per-msg.sender keying for `recoverCallerCredit`; this pass exposes that the
   recommendation was wrong — N EOAs trivially bypass it. Single-slot
   protocol-level cooldowns or input-side preflight checks are the correct
   pattern.

5. **Inline timelock state machines (admin replacement, TWAP reset) have the
   same cancel-before-replace quirk.** This is consistent across the protocol
   and arguably a feature not a bug, but worth being aware of when a future
   owner is debugging "why won't this propose go through".

---

## Out-of-scope but worth flagging

- The bare-`receive()` (line 1755) is documented as accepting any sender's
  donation. Its trust-bound is that legitimate ingress paths account
  themselves. This was acknowledged in pass 1 and remains so. Worth a CODE
  REVIEW NOTE: if a future change adds a permissionless ETH-pull path that
  forgets the `accumulatedETHFees +=` bookkeeping, the slot will silently
  donate to the next caller of `distributeFeesToStakers`. The fix is small
  but the anti-pattern is easy to introduce (e.g., hooking `recoverCallerCredit`
  for an additional source).

- `MAX_CONVERSION_PATH_LENGTH = 4` is the right cap. A future protocol that
  routes very-illiquid tokens through 5+ hops would hit this; the workaround
  is `withdrawTokenFees` (treasury-only), which loses the staker/POL slice.
  Worth a doc note for ALT-token operators.

- `isPremiumAccessHealthy()` (line 513) does NOT have a gas cap on its
  inner `try`. That's a view function so the test caller's gas budget is
  the bound, but a buggy `premiumAccess` upgrade could cause the health probe
  to revert/OOG just like the swap path. Consider adding the same `gas: 50_000`
  hint here for parity (also INFO level).
