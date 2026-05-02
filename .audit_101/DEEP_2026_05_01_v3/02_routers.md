# DEEP Audit (Pass 3) — Router & Fee-Conversion Stack post-fix-da3f1c0

**Date:** 2026-05-02
**Mode:** AUDIT-ONLY · Re-audit of post-v2-fix code · Regressions, missed gaps, side effects
**Files audited (post-fix):**
- `contracts/src/TegridyRouter.sol` (570 lines)
- `contracts/src/SwapFeeRouter.sol` (1842 lines)
- `contracts/src/SwapFeeRouterAdmin.sol` (431 lines)

**Methodology:** Re-derive each pass-2 finding's invariant against `da3f1c0`. Verify the
patch didn't merely raise a threshold (DEEP-R2-H01) instead of fundamentally fixing the
class of bug. Hunt the explicitly-listed regression hot-spots (200k cap on referrer,
`minETHOut > 0`, `withdrawPendingDistribution` pause removal, global cooldown) plus
sibling-miss patterns inherited from the closure work.

**Severity counts:** 1 High · 2 Medium · 2 Low · 1 Info  (6 NEW findings)

**Closure status of pass-2 findings:**
- DEEP-R2-H01 → **PARTIALLY CLOSED** — see R3-H01 (200k still under-funds 50-position whales)
- DEEP-R2-M01 → **PARTIALLY CLOSED** — see R3-M01 (`minETHOut = 1` is a trivial bypass)
- DEEP-R2-M02 → CLOSED (whenNotPaused removed from `withdrawPendingDistribution`)
- DEEP-R2-M03 → CLOSED with caveat — see R3-L01 (first-caller-wins unfairness)
- DEEP-R2-L01 → CLOSED
- DEEP-R2-L02 → CLOSED (NatSpec doc added)
- DEEP-R2-I01 → CLOSED (DEPLOYER NOTE added in NatSpec)

---

## [DEEP-R3-H01] 200k gas cap on `_recordReferralFee` STILL silently demotes whale referrers (16+ staking positions)

**Severity:** High
**File:** `contracts/src/SwapFeeRouter.sol:480-494` × `contracts/src/ReferralSplitter.sol:324-391` × `contracts/src/TegridyStaking.sol:383-402`
**Category:** dos · referral · regression-residual
**Closes:** N/A (residual of DEEP-R2-H01)

**Bug:** The pass-2 fix raised the gas cap on the inner `recordFee` call from 50_000
to 200_000. The remediation NatSpec claims "200_000 covers ~10 cold positions plus the
splitter's own state mutation and event with safe headroom (well below the protocol's
observed real-world max of ~120k)". This claim has two problems:

1. **The "10 cold positions" estimate is an under-count.** Re-deriving with current
   storage prices on the cold path:
   - splitter pre-work (re-entrancy SSTORE, `setupComplete` SLOAD, `_user != 0`,
     `referrerOf[_user]` SLOAD, `referralFeeBps` SLOAD,
     `callerCredit[msg.sender]` cold-zero-to-non-zero SSTORE,
     `totalCallerCredit` cold-zero-to-non-zero SSTORE,
     `bannedReferrers[referrer]` SLOAD): ~62k.
   - 200_000 forwarded - 62k pre-work = 138k for `votingPowerOf`.
   - After EIP-150 forwarding inside the `try`, ~136k reaches `votingPowerOf`.
   - Each cold position: 3× cold SLOAD on `set.at(i)` + `positions[id].amount` +
     `positions[id].lockEnd` + `positions[id].boostBps` ≈ 8.4k gas.
   - 136k / 8.4k ≈ **~16 positions** before the inner staticcall OOGs.

2. **The protocol allows 50 positions per holder** —
   `TegridyStaking.MAX_POSITIONS_PER_HOLDER = 50`. A whale with ≥17 active staking
   positions still hits the same regression DEEP-R2-H01 was meant to close: the inner
   `try stakingContract.votingPowerOf(referrer)` OOGs, the splitter's catch silently
   marks `referrerQualified = false`, the entire `referrerShare` is rerouted to
   `accumulatedTreasuryETH`, and SwapFeeRouter's `_recordReferralFee` returns SUCCESS
   so `ReferralFeeRedirectedToTreasury` is NEVER emitted at the router. No on-chain
   alarm.

The pass-2 patch raised the silent-demotion threshold from 2 positions to ~16 — but
**the bug class is still the same**: cap-then-pray. A protocol that sells "stakers
earn referrals" cannot have a referrer-fee path that silently fails for the heaviest
stakers, who are exactly the marketing-sensitive class.

**Attack / Impact:** Same shape as DEEP-R2-H01 attacks 1 and 3:

1. **Honest whale referrer**: any influencer / community lead with 17+ positions
   (one per stake batch over many months) sees their referral cut silently rerouted
   to treasury. They can't tell from the splitter's events which ones are theirs vs
   genuinely-unregistered referees.
2. **No off-chain alarm**: `ReferralFeeRedirectedToTreasury` doesn't fire on this
   path — `recordFee` returns success to the router, the router records the call as
   "forwarded successfully", `accumulatedETHFees` is not bumped, and the splitter's
   `UnclaimableSentToTreasury` is the only signal — but that event also fires for
   ordinary unregistered referees so it doesn't disambiguate the OOG case.

The 50-position whale is the realistic test: a long-tenured staker who legitimately
held positions at every weekly cliff over one year accumulates close to that limit.
Pre-fix v2: silently demoted at ≥2 positions. Post-fix v2: silently demoted at ≥17.
Either way: silently demoted.

**Evidence:**
```solidity
// SwapFeeRouter.sol:482 — cap raised but bug shape unchanged
try referralSplitter.recordFee{value: _feeAmount, gas: 200_000}(_user) {
    return true;
}
```

`votingPowerOf` cost-floor (cold path):
```solidity
// TegridyStaking.sol:383-402
function votingPowerOf(address user) public view returns (uint256 total) {
    if (user == restakingContract) return 0;            // ~2.1k SLOAD
    EnumerableSet.UintSet storage set = _positionsByOwner[user];  // ~2.1k SLOAD
    uint256 len = set.length();                          // ~2.1k SLOAD
    uint256 nowTs = block.timestamp;
    for (uint256 i; i < len; ++i) {
        Position storage p = positions[set.at(i)];       // ~2.1k SLOAD per i
        uint256 amount = p.amount;                       // ~2.1k SLOAD per i
        if (amount == 0) continue;
        if (nowTs >= p.lockEnd) continue;                // ~2.1k SLOAD per i
        total += (amount * p.boostBps) / BOOST_PRECISION; // ~2.1k SLOAD per i
    }
}
```

That's 4× cold SLOADs per position = 8.4k. With `MAX_POSITIONS_PER_HOLDER = 50`,
the worst-case `votingPowerOf` call costs ~420k gas. The 200k cap covers ~16
positions worst-case, ~32 if all positions are warm (rare on first call of a tx).

**Recommendation:** Three options ranked by minimality:

(a) **Raise the cap to 500_000** (covers worst-case ~52 cold positions = above the
   50-position cap). One-line change. The recordFee path is a single trusted external
   call to a 48h-timelocked address; the practical bound on gas griefing is the
   block gas limit, not the gas-cap.

(b) **Remove the cap entirely** on `_recordReferralFee` and trust the 48 h
   `applyReferralSplitter` timelock as the trust boundary (same pattern the protocol
   uses for `revenueDistributor` and `polAccumulator` in `recoverCallerCreditFrom`,
   neither of which has a per-call gas cap). The original DEEP-R-M03 motivation was
   "buggy/malicious upgrade" — but the timelock IS the defence against that.

(c) **Push voting-power caching** into TegridyStaking so `votingPowerOf` is O(1).
   Out of scope for the routers cluster but the architecturally-correct fix.

(a) is the lightest patch. The "300k headroom for swap" worry is overblown — the
   inner Uniswap router swap already costs 80-150k on its own. A 500k cap on
   `recordFee` plus 150k swap plus 50k of fee bookkeeping fits comfortably under
   the typical 1M gas budget for a swap transaction.

---

## [DEEP-R3-M01] Multi-hop `minETHOut > 0` is a trivial bypass — `minETHOut = 1` admits the same drain

**Severity:** Medium
**File:** `contracts/src/SwapFeeRouter.sol:1429` × `:1521`
**Category:** admin · math · regression-residual
**Closes:** N/A (residual of DEEP-R2-M01)

**Bug:** The pass-2 fix added `if (minETHOut == 0) revert ZeroMinOut();` to both the
multi-hop branches of `convertTokenFeesToETH` and `convertTokenFeesToETHFoT`. The
NatSpec claims this "turns silent drain into a noisy revert that off-chain monitoring
catches". It does not — the check only rejects the literal zero. `minETHOut = 1`
satisfies the check and admits the SAME drain:

```solidity
// SwapFeeRouter.sol:1422-1430
if (path.length > 2) {
    if (minETHOut == 0) revert ZeroMinOut();
    effectiveMin = minETHOut;     // ← effectiveMin = 1
    emit ConversionTWAPFloor(token, effectiveMin, minETHOut, false);
}
...
router.swapExactTokensForETH(amount, effectiveMin, path, address(this), deadline);
if (ethReceived < effectiveMin) revert InsufficientOutput();   // ← `ethReceived >= 1` always passes
```

`InsufficientOutput()` only reverts if the multi-hop produces literal zero ETH — which
no realistic swap produces unless the entire input is consumed by FoT taxes or pool
fees. Anything ≥ 1 wei satisfies the floor.

The original DEEP-R2-M01 attack scenario ("Owner-key compromise: attacker drains
`accumulatedTokenFees[token]` for whatever ETH the sandwich-controllable multi-hop
produces") is unchanged. The attacker just supplies `minETHOut = 1` instead of
`minETHOut = 0` and gets identical behaviour. The off-chain monitor watching for
`ConversionTWAPFloor(... effectiveMin = 0, ...)` won't fire because the event
records `effectiveMin = 1` instead.

**Attack / Impact:** Two related vectors, both pre-existing the pass-2 fix:

1. **Temporarily compromised owner key**: attacker calls
   `convertTokenFeesToETH(token, [token, MID, WETH], 1, deadline)`. The multi-hop
   branch sets `effectiveMin = 1`. Sandwich-controlled multi-hop produces some ETH
   ≥ 1 wei, swap completes, full `accumulatedTokenFees[token]` balance drained.
   Off-chain alert subscribed to `effectiveMinETHOut == 0` does not fire.
2. **Honest operator script error**: a script that hardcodes `minETHOut = 1` "to
   bypass the new revert" admits the drain to a sandwich attacker.

Damage equals the entire `accumulatedTokenFees[token]` for the targeted token.
1h `CONVERSION_COOLDOWN` bounds repeat exploitation — but for a multi-week
USDC/WBTC accumulation the single drain IS the loss event.

**Evidence:**
```solidity
// SwapFeeRouter.sol:1419-1438 (and mirror at 1514-1529 for FoT variant)
uint256 effectiveMin;
uint256 currentCum;
uint32 currentTs;
if (path.length > 2) {
    if (minETHOut == 0) revert ZeroMinOut();    // ← rejects 0 only
    effectiveMin = minETHOut;                   // ← `1` is accepted
    emit ConversionTWAPFloor(token, effectiveMin, minETHOut, false);
}
...
router.swapExactTokensForETH(amount, effectiveMin, path, address(this), deadline);
if (ethReceived < effectiveMin) revert InsufficientOutput();   // ← `ethReceived >= 1` is always true
```

The pass-1 finding's recommendation specifically called out:
> If the team prefers minimal invasion, at minimum require `minETHOut > 0` for
> the multi-hop branch — that single check turns an owner-key-compromise drain
> into a noisy revert.

The pass-2 fix took this exact recommendation literally — `> 0` — but did not bound
it against the input amount or against any realistic floor. The fix sounds restrictive
but is functionally a no-op against an attacker who supplies any positive integer.

**Recommendation:** Three escalating options:

(a) **Floor against `amount`**: require `minETHOut >= amount * MIN_MULTIHOP_RATIO_BPS / BPS`
   for some sanity floor (e.g., `MIN_MULTIHOP_RATIO_BPS = 1` for 0.01% — covers
   tokens worth < 1e-4 ETH/unit). This is still trust-the-owner but rejects the
   1-wei-attack outright.

(b) **Anchor against the FIRST hop's TWAP** (pass-1 v2 recommendation, deferred
   then): use `getPair(token, path[1])` as the TWAP source, derive a
   first-hop-anchored floor, enforce
   `effectiveMin = max(callerMinETHOut, firstHopTwap * MAX_MULTIHOP_SLIPPAGE_BPS / BPS)`.
   Restores defence-in-depth.

(c) **Require a per-token explicit override** for multi-hop conversions: owner must
   first call `setMultiHopMinETHOutFor(token, floor)` behind a 24 h timelock, then
   subsequent multi-hop calls inherit that floor. Slow but immune to single-key
   compromise.

(a) is the cheapest patch that materially closes the attack. (b) is the architecturally
correct fix.

---

## [DEEP-R3-M02] `applyReferralSplitter(address(0))` silently disables referral routing — sibling miss with DEEP-R-M04

**Severity:** Medium
**File:** `contracts/src/SwapFeeRouter.sol:1083-1087`
**Category:** admin
**Closes:** N/A (sibling miss the DEEP-R-M04 fix didn't generalise)

**Bug:** DEEP-R-M04 closed the silent `polAccumulator = address(0)` re-routing by
adding `if (_newAccumulator == address(0) && polShareBps > 0) revert PolShareNonZero();`
to `applyPolAccumulator`. The same shape silent-killer exists for
`applyReferralSplitter(address(0))` and was NOT fixed in either pass.

```solidity
// SwapFeeRouter.sol:1083-1087 — no zero-address guard
function applyReferralSplitter(address _newSplitter) external onlyAdmin {
    address old = address(referralSplitter);
    referralSplitter = IReferralSplitter(_newSplitter);  // ← address(0) accepted silently
    emit ReferralSplitterUpdated(old, _newSplitter);
}
```

When `referralSplitter == address(0)`, every `_recordReferralFee` short-circuits:

```solidity
// SwapFeeRouter.sol:480-494
function _recordReferralFee(address _user, uint256 _feeAmount) internal returns (bool) {
    if (address(referralSplitter) == address(0) || _feeAmount == 0) return false;
    ...
}
```

`_recordReferralFee` returns `false`, so the caller folds the fee into
`accumulatedETHFees` instead of routing the `referrerShare` to `pendingETH[referrer]`
on the splitter. **Every existing referral relationship is silently terminated** —
existing `referrerOf[user]` mappings on the splitter still exist but are never read
again from the router side; new fees that would have credited the referrer instead
fund the staker/POL/treasury split.

This is the same "implicit governance via address-zero defaults" shape the
DEEP-R-M04 fix specifically called out as an attack vector. The pattern was closed
for `polAccumulator` but missed for `referralSplitter`.

**Attack / Impact:** The attack shape is identical to DEEP-R-M04:

1. Compromised owner waits 48 h, sets `applyReferralSplitter(address(0))` via timelock.
2. Every subsequent referred-user swap: the referrer's slice goes to `accumulatedETHFees`
   instead of `pendingETH[referrer]`.
3. Off-chain monitors that watch `ReferralSplitterUpdated` events catch the change,
   but the impact is `referrerShare` redirection — a distinct channel from the
   `feeSplit` BPS that governance can monitor against.

Difference from DEEP-R-M04: the `polShareBps` invariant is timelocked separately —
zero-ing the accumulator silently mutated the share. Here, there's no equivalent
"referralShareBps" invariant on the router side (the splitter holds it as
`referralFeeBps`). So the analogy isn't perfect: zero-ing `referralSplitter` doesn't
break a timelocked SwapFeeRouter parameter — it disables the integration.

But the marketing-promise impact IS real: the protocol promotes "stakers earn
referrals", and that promise is broken silently when the splitter is unset. The
fix is a one-liner mirroring DEEP-R-M04.

**Evidence:**
```solidity
// SwapFeeRouter.sol:1083-1087 — no guard
function applyReferralSplitter(address _newSplitter) external onlyAdmin {
    address old = address(referralSplitter);
    referralSplitter = IReferralSplitter(_newSplitter);
    emit ReferralSplitterUpdated(old, _newSplitter);
}

// Compare with the DEEP-R-M04 pattern at SwapFeeRouter.sol:1253-1258
function applyPolAccumulator(address _newAccumulator) external onlyAdmin {
    if (_newAccumulator == address(0) && polShareBps > 0) revert PolShareNonZero();
    ...
}
```

**Recommendation:** Add an explicit confirmation flag for the disable case so the
zero-address path is surfaced rather than silent:

```solidity
function applyReferralSplitter(address _newSplitter) external onlyAdmin {
    if (_newSplitter == address(0) && address(referralSplitter) != address(0)) {
        // Emit a distinct event so off-chain monitors can alert on referral-disable specifically.
        emit ReferralSplitterDisabled(address(referralSplitter));
    }
    ...
}
```

Or, mirroring DEEP-R-M04, add a hard guard requiring an explicit
`disableReferralSplitter()` two-step that emits a distinct event class. The lightest
fix is the explicit `Disabled` event so an off-chain alarm class has somewhere to
hook.

---

## [DEEP-R3-L01] Global `lastCallerCreditAt` cooldown enables permanent first-caller-wins griefing

**Severity:** Low
**File:** `contracts/src/SwapFeeRouter.sol:1615-1629`
**Category:** dos · regression-residual
**Closes:** N/A (acknowledged design trade-off in DEEP-R2-M03 fix comment)

**Bug:** The pass-2 fix replaced the per-msg.sender cooldown mapping with a single
global `lastCallerCreditAt` slot. This correctly closes the N-EOA bypass (pass-1
mis-recommendation) but introduces a NEW unfairness: every call resets the global
cooldown, so an attacker that calls every 30 s permanently locks the legitimate
keeper out for the entire window.

Unlike a per-caller cooldown (where each keeper gets independent windows), the global
cooldown means there's exactly ONE non-revert call per 30-second window. Whoever
wins the race wins the entire window. With ~12s L1 blocks, that's ~3 attacker txs to
permanently pin one window. Cost: ~62k gas/window (21k base + ~31k for the
recoverCallerCredit call body when the splitter has no credit and reverts —
actually, a reverting call rolls back the storage update, so the cooldown only sticks
on success).

Re-reading the contract: when `referralSplitter.withdrawCallerCredit()` reverts
(e.g., `NothingToClaim`), the entire transaction reverts and `lastCallerCreditAt`
is NOT updated. So the only way to set the cooldown is to actually pull credit. An
attacker would need to be the first one to pull non-zero credit each 30s window.
Since the recovered ETH goes to `accumulatedETHFees` (not the attacker), the
attacker has no economic incentive — only griefing intent.

The grief vector is real but bounded:

- Attacker pays ~62k gas per successful pull (vs ~31k for honest keeper).
- The attack BLOCKS the honest keeper from being the one to call — but the credit
  is still recovered, so the protocol's funds are not at risk.
- The only consumer-visible effect is which address shows up in the
  `CallerCreditRecovered(address indexed splitter, uint256 amount)` event as the
  first argument. The amount still ends up in `accumulatedETHFees`.

**Attack / Impact:** Negligible direct impact — protocol fees are still recovered
correctly, just with the attacker's address shown as the puller in the event. The
unfairness is symbolic (event-attribution griefing) rather than economic.

The pre-fix per-caller cooldown was strictly better here BECAUSE it allowed multiple
honest keepers to operate independently. The pass-2 fix optimised for the wrong
attack: the original DEEP-R-L03 grief vector was zero-amount events (already mitigated
by the splitter's `NothingToClaim` revert which rolls back the whole tx). The N-EOA
bypass concern raised in pass-2 was overblown — even the pre-fix version made each
EOA pay 21k+31k = 52k per attempt to spam the events. The "fix" actually made the
griefing CHEAPER per protocol-block.

**Recommendation:** Two options:

(a) **Probe before pull**: add a view method to ReferralSplitter
   (`pendingCallerCredit(address) view returns (uint256)`) and skip the external
   call when the result is zero. This eliminates the grief entirely (attacker can't
   even trigger the cooldown if there's nothing to pull):

   ```solidity
   if (referralSplitter.pendingCallerCredit(address(this)) == 0) return;
   ```

(b) **Revert the pass-2 change**: restore the per-msg.sender mapping. The N-EOA
   bypass was always negligible (each EOA pays ~52k per attempt), and the per-caller
   keying lets multiple legitimate keepers operate independently.

(a) is the architecturally cleaner fix and matches the pattern recommended in pass-1.
Defer-able because the impact is purely symbolic — but worth flagging that the
pass-2 patch traded one negligible griefing surface for another.

---

## [DEEP-R3-L02] `lastCallerCreditPullAt` mapping retained as dead storage — confuses indexers / future maintainers

**Severity:** Low
**File:** `contracts/src/SwapFeeRouter.sol:267`
**Category:** other · cosmetic

**Bug:** The pass-2 fix replaced the per-msg.sender mapping with a global slot, but
"RETAINED for storage-layout stability across the upgrade but NO LONGER READ".
SwapFeeRouter does NOT use a proxy pattern (no UUPS / TransparentUpgradeableProxy
imports; no `_initialize()` flow) — the contract is constructor-deployed standalone.
There is no upgrade scenario where storage layout matters for it.

The retained mapping is therefore dead storage forever. Concrete impact:

1. The public getter `lastCallerCreditPullAt(address)` resolves on the public ABI but
   always returns 0 (or stale pre-upgrade values from any caller that called before
   da3f1c0 — but da3f1c0 was a fresh deploy on the audit branch, so the mapping is
   uniformly empty).
2. Frontend / indexer code that subscribes to this mapping reads zeros forever and
   may report "no recoverCallerCredit history" — confusing operators.
3. New developers reading the contract will trip on the inconsistency between the
   mapping and the documented "RETAINED" comment.

**Attack / Impact:** None — informational only. Cosmetic confusion at the ABI layer.

**Evidence:**
```solidity
// SwapFeeRouter.sol:267
mapping(address => uint256) public lastCallerCreditPullAt;   // ← dead, never read
```

No proxy / upgrade pattern in the file:
```bash
$ grep -n "Initializable\|UUPS\|Proxy\|upgrade" contracts/src/SwapFeeRouter.sol
# (empty)
```

**Recommendation:** Delete the mapping AND its getter ABI entry — this is a
constructor-deployed singleton, storage layout stability is not a constraint:

```solidity
// Delete line 267 entirely.
```

If the team wants to play it safe in case a future migration uses a proxy, leave the
mapping but mark it `private` to drop it from the public ABI:

```solidity
mapping(address => uint256) private _legacyLastCallerCreditPullAt; // pre-da3f1c0 storage
```

Either way, the public-getter case is misleading.

---

## [DEEP-R3-I01] `applyReferralSplitter` and `applyPremiumAccess` lack the same DEEP-R-M04 sibling-miss audit

**Severity:** Info
**File:** `contracts/src/SwapFeeRouter.sol:1083-1087` × `:1150-1154`
**Category:** admin · pattern-completeness

**Observation:** The DEEP-R-M04 fix added a propose-time guard
(`PolShareNonZero` revert) on `applyPolAccumulator(address(0))` to defend against
silent fee-split mutation. The same sibling-miss audit was not run against the other
two `apply*(address)` setters that accept zero:

1. **`applyReferralSplitter(address(0))`** — covered by DEEP-R3-M02 above.
2. **`applyPremiumAccess(address(0))`** — disables premium-discount lookups silently.
   `_getEffectiveFeeBps` checks `if (... && address(premiumAccess) != address(0))`
   and skips the discount entirely when unset. So premium users will silently start
   paying full base fees with no event distinguishing this from "premiumAccess is
   genuinely degraded" (the existing `isPremiumAccessHealthy()` view returns true
   when address(0) — which is misleading: "unset" is reported as "healthy").

The premium downgrade is fail-OPEN (user pays MORE), so it's economically benign for
the user (just expensive). For the protocol it means treasury collects more than
governance intended. Off-chain monitors watching `PremiumAccessUpdated` catch the
change but `isPremiumAccessHealthy()` returning `true` for `address(0)` is a
documented quirk that contradicts the function's intent.

**Recommendation:** Two micro-fixes:

(a) `isPremiumAccessHealthy()` should return `false` (not `true`) when
   `premiumAccess == address(0)`. Off-chain monitors then treat
   "premium discount disabled" as a degraded state, not a healthy one.

(b) Emit a distinct `PremiumAccessDisabled(address oldAccess)` event when
   `applyPremiumAccess(address(0))` is called. Mirrors the recommended
   `ReferralSplitterDisabled` event in DEEP-R3-M02.

Both are low-priority cleanups; flagging here so the protocol's "no silent
disable" pattern (DEEP-R-M04) is consistently applied across the
`apply*(address)` family.

---

## Summary of patterns observed in this pass

1. **"Just raise the cap" is not a fix for cap-then-pray.** DEEP-R2-H01 raised the
   `_recordReferralFee` gas cap from 50k to 200k. This addresses the simplest
   referrer (1-2 positions) but the marketing-promised whale referrer (50 positions)
   is still silently demoted. The cap was raised by 4×, the position-coverage by ~8×
   — but the bug class is the same: cap-then-pray. Either remove the cap (timelock
   is the trust boundary) or make it bigger than the worst case (500k+ for 50
   positions).

2. **`> 0` is not a slippage floor.** DEEP-R2-M01 added `if (minETHOut == 0) revert
   ZeroMinOut();` to the multi-hop branch. `minETHOut = 1` admits the same drain.
   Patches that mechanically take "the minimum possible bound" rather than a
   parameter-meaningful floor are a recurring anti-pattern — see also the historical
   pattern of "require amount > 0" checks that don't bound against a price floor.

3. **Sibling-miss completeness check on the `apply*(address)`-accepting-zero family.**
   DEEP-R-M04 closed this for `polAccumulator` but the same shape lives on
   `applyReferralSplitter` and (informationally) `applyPremiumAccess`. A single
   protocol-wide audit pass over every "what if I pass `address(0)` here" entry
   would catch all three at once.

4. **First-caller-wins is a real grief vector** for permissionless cleanups. The
   pass-2 fix optimised for an N-EOA bypass that was already economically
   unattractive; the new global-slot pattern just shifted the grief from "spam logs"
   to "lock out competing keepers". Probe-before-pull (add a view method to the
   downstream contract) is the cleaner pattern.

5. **Dead storage from "upgrade-stable" comments**: the protocol has no proxy
   pattern but the team is writing storage as if it does. This is defensive but
   creates misleading ABI for indexers. A short check ("is this a proxy contract?")
   would resolve all such cases.

---

## Out-of-scope but worth flagging

- **Test gap**: the `Deep_Routers_2026_05_01.t.sol` suite does NOT have a regression
  test for whale referrers (16+ positions). The `Deep_R2_H01` regression closure was
  asserted via gas-budget arithmetic in the audit comment, not via an integration
  test that actually deploys 50-position TegridyStaking, registers a referrer, and
  measures the splitter's `pendingETH[referrer]` increment after a swap. Adding such
  a test would have caught DEEP-R3-H01 above.

- **`recoverCallerCreditFrom(oldSplitter)`** has no per-call gas cap on the inner
  `withdrawCallerCredit()` — same shape as the pre-fix `_recordReferralFee` but
  `onlyOwner`-gated, so the trust boundary is the owner key. Fine.

- **`isPremiumAccessHealthy()` returns `true` when `premiumAccess == address(0)`**.
  Documented behaviour but misleading — see DEEP-R3-I01 above.

- The `MAX_DEADLINE = 2 hours` constant is shared between TegridyRouter and
  SwapFeeRouter. On a future L2 deployment this may need per-chain tuning; the
  hardcoded constant prevents that without a redeploy. Worth a per-chain
  immutable rather than a `constant`.
