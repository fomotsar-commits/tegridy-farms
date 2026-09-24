# DEEP Audit — Router & Fee-Conversion Stack (TegridyRouter, SwapFeeRouter, SwapFeeRouterAdmin)

**Date:** 2026-05-01
**Mode:** AUDIT-ONLY, NEW findings only
**Files audited:**
- `contracts/src/TegridyRouter.sol` (540 lines)
- `contracts/src/SwapFeeRouter.sol` (1558 lines)
- `contracts/src/SwapFeeRouterAdmin.sol` (431 lines)

**Methodology:** Triage MICROSCOPE_2026_04_30 already-known items. Re-derive
SFR-H-01 / SFR-M-01..M-04 invariants from current source. Hunt for sibling-miss
patterns, half-installed mitigations, and admin-replaceability edge cases the
prior auditors specifically deferred or didn't reach.

**Severity counts:** 2 High · 5 Medium · 3 Low · 1 Info  (11 NEW findings)

---

## [DEEP-R-H01] Multi-hop conversion path is structurally unreachable when the direct token/WETH pair is missing

**Severity:** High
**File:** `contracts/src/SwapFeeRouter.sol:1442-1479` (helper) × `:1186-1250` (entry) × `:1265-1319` (FoT entry)
**Category:** dos · math

**Bug:** Commit `ba56456` (SFR-M-01) added caller-supplied conversion paths so
"tokens that lack a direct token/WETH pair can still be converted via a multi-hop
route". The NatSpec at `SwapFeeRouter.sol:1170-1173` is explicit about this
intent. However, `convertTokenFeesToETH{,FoT}` calls
`_enforceTWAPMinETHOut(token, …)` which in turn calls `_readCurrentCumulative(token)`
which **first looks up `uniFactory.getPair(token, WETH)`** and reverts
`NoPairForToken()` if that is `address(0)`. Therefore the multi-hop feature
ONLY works for tokens that ALREADY have a direct token/WETH pair — which is
exactly the case where multi-hop is unnecessary. The "ALT-token → MID → WETH"
use-case the patch was written for is unreachable.

**Attack / Impact:** Tokens accumulated as fees that DO NOT have a direct
WETH pair on Uniswap V2 are now permanently uncovertable through
`convertTokenFeesToETH{,FoT}`. The keeper bot will see the call revert with
`NoPairForToken`, owner cannot work around it without redeploying SwapFeeRouter,
and the only remaining path (`withdrawTokenFees`) sends 100% to treasury
bypassing the timelocked staker / POL / treasury split — exactly the silent-killer
that AUDIT C1 was supposed to close. Net effect: stakers and POL receive 0% on
every "ALT" token's accumulated fees.

**Evidence:**
```solidity
// SwapFeeRouter.sol:1442-1448
function _readCurrentCumulative(address token)
    internal view
    returns (address pair, uint256 currentCum, uint32 currentTs)
{
    pair = uniFactory.getPair(token, WETH);
    if (pair == address(0)) revert NoPairForToken();   // ← reverts here even
                                                       //   if path[1] != WETH
    ...
```

```solidity
// SwapFeeRouter.sol:1496 — _enforceTWAPMinETHOut always invokes the helper above
(, currentCum, currentTs) = _readCurrentCumulative(token);
```

The test suite `R028_SwapFeeRouter_M_Findings.t.sol:140-164` registers a
`token/WETH` pair before every multi-hop test, masking the bug. There is no
test for `convertTokenFeesToETH(token, [token, MID, WETH], …)` when the
`token/WETH` pair is missing.

**Recommendation:** When `path.length > 2`, skip the direct-pair TWAP floor
(or read TWAP from the FIRST hop pair instead, e.g. `getPair(path[0], path[1])`).
Owner-only multi-hop already implies trust; either anchor against the first hop
or require an explicit `minETHOut` ≥ a parameterised floor. Concretely:

```solidity
// inside _enforceTWAPMinETHOut, branch on path.length
if (path.length > 2) {
    // anchor against first hop, OR fall back to caller-supplied floor only
    // (msg.sender == owner is already enforced upstream)
    return (callerMinETHOut, 0, currentTs);
}
```

---

## [DEEP-R-H02] `distributeFeesToStakers`, `withdrawPendingDistribution`, `recoverCallerCredit` bypass `whenNotPaused`

**Severity:** High
**File:** `contracts/src/SwapFeeRouter.sol:1009-1067` (distribute) · `:1337-1345` (pending) · `:1352-1361` (recover)
**Category:** admin · dos

**Bug:** SwapFeeRouter inherits OZ `Pausable`, and every user-facing swap
(including the FoT variants and `convertTokenFeesToETH{,FoT}`) is decorated
`whenNotPaused`. Three permissionless ETH-mutating functions — `distributeFeesToStakers`,
`withdrawPendingDistribution`, `recoverCallerCredit` — are NOT decorated.
Pause is therefore "user trade halt" instead of "protocol freeze". When the
owner pauses in response to an incident on a downstream consumer
(RevenueDistributor or POLAccumulator compromised, mid-upgrade, etc.) anyone
can still front the queue and shovel ETH at the dangerous destination.

**Attack / Impact:** Concrete sequence:

1. Auditor flags a discovered vulnerability in `RevenueDistributor.distribute()`
   — e.g. C-5 from MICROSCOPE_2026_04_30 (unified-claimedAtEpoch sibling miss).
2. Owner calls `pause()` on SwapFeeRouter to freeze the surface while the
   incident is investigated.
3. An on-chain MEV searcher (or the malicious actor exploiting C-5) front-runs
   by calling `distributeFeesToStakers()` — NOT paused — pushing the entire
   `accumulatedETHFees` into the buggy distributor.
4. Stakers either get under-paid (per the C-5 vector) or the funds are stranded
   in `pendingDistribution` if the distributor reverts.
5. The pause was effectively a no-op for the very contract it was called on.

Same shape attack with `withdrawPendingDistribution(victim)` — drains a queued
slice while the protocol believes the surface is frozen.

**Evidence:**
```solidity
// SwapFeeRouter.sol — note the missing whenNotPaused
1009:  function distributeFeesToStakers() external nonReentrant {
1337:  function withdrawPendingDistribution(address recipient) external nonReentrant {
1352:  function recoverCallerCredit() external nonReentrant {

// Compare with the user-facing surface (correctly paused):
469:   ) external payable nonReentrant whenNotPaused returns (uint256[] memory amounts) {
1192:       external nonReentrant whenNotPaused
1271:       external nonReentrant whenNotPaused
```

This is the same "half-installed mitigation" pattern flagged in
MICROSCOPE_2026_04_30 §4 (H9 R014 sibling miss, H17 M-12 sibling miss).

**Recommendation:** Add `whenNotPaused` to all three functions. Pause should
freeze every state-mutating ETH-flow primitive, not just the user-trade
entrypoints.

---

## [DEEP-R-M01] Admin-replacement proposal has no expiry — stale proposal can install old/compromised admin years later

**Severity:** Medium
**File:** `contracts/src/SwapFeeRouter.sol:846-902`
**Category:** admin

**Bug:** SFR-M-04 (commit `7301654`) added a 7-day timelock for replacing the
SwapFeeRouterAdmin contract. The propose/execute flow lives INLINE on
SwapFeeRouter (intentionally — so a broken admin can't block its own removal).
The inline implementation enforces a minimum delay (`block.timestamp >= readyAt`)
but provides NO upper bound — a proposal made years ago is still executable
today. This contradicts the protocol's own pattern: `TimelockAdmin` (used for
every other timelocked parameter) enforces a 7-day `PROPOSAL_VALIDITY` window
after the executable timestamp.

**Attack / Impact:**

1. Owner proposes admin replacement candidate `X` and forgets about it (e.g.
   the deployment plan changed; the candidate was never deployed-to-prod).
2. Months later, the address `X` becomes available for re-deployment by any
   party (CREATE2 with predictable salt; abandoned multisig; expired-key custody).
3. Anyone who controls `X` either persuades, coerces, or compromises the owner
   key just long enough to call `executeAdminReplacement()` (now no longer behind
   any cooldown — the 7 days elapsed long ago).
4. The compromised `X` becomes the live admin, gaining control of every
   `applyXxx` setter (fee, treasury, premium, fee-split, POL, revenueDistributor).

The single-call exploit window is much larger than for any other SFR admin
parameter (which all expire after 7 days post-ready).

**Evidence:**
```solidity
// SwapFeeRouter.sol:872-879
function proposeAdminReplacement(address _newAdmin) external onlyOwner {
    if (_newAdmin == address(0)) revert ZeroAddress();
    if (swapFeeRouterAdmin == address(0)) revert Unauthorized();
    if (adminReplacementReadyAt != 0) revert AdminReplacementUnavailable();
    pendingSwapFeeRouterAdmin = _newAdmin;
    adminReplacementReadyAt = block.timestamp + ADMIN_REPLACEMENT_TIMELOCK;
    emit SwapFeeRouterAdminReplacementProposed(_newAdmin, adminReplacementReadyAt);
}

// SwapFeeRouter.sol:882-893 — executeAdminReplacement
function executeAdminReplacement() external onlyOwner {
    uint256 readyAt = adminReplacementReadyAt;
    if (readyAt == 0) revert AdminReplacementUnavailable();
    if (block.timestamp < readyAt) revert AdminReplacementUnavailable();
    // ⚠ NO upper bound on (block.timestamp - readyAt) — could be 10 years
    address newAdmin = pendingSwapFeeRouterAdmin;
    ...
}
```

Compare with `base/TimelockAdmin.sol:79`:
```solidity
if (block.timestamp > readyAt + PROPOSAL_VALIDITY) revert ProposalExpired(key);
```

**Recommendation:** Add the same 7-day validity window:

```solidity
// SwapFeeRouter.sol:885 — add expiry guard
if (block.timestamp > readyAt + 7 days) revert AdminReplacementUnavailable();
```

Mirrors the canonical TimelockAdmin behaviour and keeps stale proposals from
becoming attack surface forever.

---

## [DEEP-R-M02] Caller-supplied conversion path's `_validateConversionPath` doesn't reject `address(0)` intermediate hops

**Severity:** Medium
**File:** `contracts/src/SwapFeeRouter.sol:1411-1423`
**Category:** other

**Bug:** `_validateConversionPath` correctly rejects path-length, path-start,
path-end, and duplicate-token violations. It does NOT reject `path[i] == address(0)`
for intermediate `i` (i.e. `1 <= i <= len-2`). For a path like
`[token, address(0), WETH]`: `path[0]=token`, `path[1]=0`, `path[2]=WETH` — none
of these are equal so the duplicate check passes; multi-hop is owner-only so
non-owners are gated; but the owner CAN smuggle a path with a zero-address
hop. The inner Uniswap V2 router computes `pairFor(token, address(0))` via
CREATE2, lands on a deterministic but normally-empty address, and the swap
either silently succeeds (no contract at the address) or reverts late after the
input-side `forceApprove` already happened.

**Attack / Impact:** Owner-trust assumption mostly contains this — multi-hop is
owner-restricted, so a non-malicious owner won't supply a zero-address hop. The
real risk is **owner mistake**: cut-paste error, off-chain script bug, or
interpolation gone wrong. Failure mode is "swap fails silently or reverts late
with a confusing error", but for the FoT variant (`convertTokenFeesToETHFoT`)
the output-side measurement happens AFTER the call, so if the empty hop
succeeds with zero output the contract reads `received = 0` and the swap path
completes with `accumulatedTokenFees[token] = 0` and `accumulatedETHFees += 0`
— **the entire token-fee balance is silently destroyed**.

The same shape applies to ANY non-WETH zero check on the swap path, not just
zero-address. `path[i] == path[i+1]` is also not caught directly (the duplicate
check uses i+1 in the inner loop so it does catch this case). Verified.

**Evidence:**
```solidity
function _validateConversionPath(address token, address[] calldata path) internal view {
    uint256 len = path.length;
    if (len < 2 || len > MAX_CONVERSION_PATH_LENGTH) revert InvalidConversionPath();
    if (path[0] != token) revert InvalidConversionPath();
    if (path[len - 1] != WETH) revert InvalidConversionPath();
    // Reject duplicates ...
    for (uint256 i = 0; i < len; i++) {
        for (uint256 j = i + 1; j < len; j++) {
            if (path[i] == path[j]) revert InvalidConversionPath();
        }
    }
    if (len > 2 && msg.sender != owner()) revert MultiHopOwnerOnly();
}
```

There is no `if (path[i] == address(0)) revert ...` for `1 <= i < len-1`.

**Recommendation:** Add an explicit zero-address guard inside the loop:

```solidity
for (uint256 i = 1; i < len - 1; i++) {
    if (path[i] == address(0)) revert InvalidConversionPath();
}
```

Cheap defence against owner-side script errors that would otherwise zero
accumulated fees with no visible revert.

---

## [DEEP-R-M03] `_recordReferralFee` and `_getEffectiveFeeBps` external calls have NO gas cap

**Severity:** Medium
**File:** `contracts/src/SwapFeeRouter.sol:394-402` × `:425-434`
**Category:** dos · admin

**Bug:** `try referralSplitter.recordFee{value: _feeAmount}(_user)` and
`try premiumAccess.hasPremiumSecure(user)` both forward 63/64 of remaining gas
(EIP-150 default). A malicious or buggy referralSplitter / premiumAccess can
burn the forwarded gas in an OOG path that, while caught by the surrounding
`try/catch`, leaves only ~1/64 of the original gas budget for the
post-catch logic plus the rest of the swap. For tightly-funded transactions
(small swaps; relayer-funded txs at the gas limit), the parent function will
itself OOG and revert. Worse: the OOG state happens AFTER the user's input
token has already been transferred into the contract via `safeTransferFrom`,
but BEFORE the inner Uniswap router executes the actual swap — so the user's
tokens are now in SwapFeeRouter with no clean exit (they're booked as
`accumulatedTokenFees[path[0]] += fee` in the legacy variant, or stuck in raw
balance in the FoT variant if the OOG happens between transferFrom and inner
swap).

**Attack / Impact:** Both contracts (referralSplitter, premiumAccess) are
owner-set behind a 48 h timelock — so this is mostly a "owner deploys broken
splitter" failure mode rather than a permissionless attack. However:

- During any 48 h window between `propose` and `execute`, anyone watching the
  timelock can craft a malicious splitter/premiumAccess at a deterministic
  address (CREATE2) and front-run governance to deploy it just before the
  execute.
- Even without adversarial intent, a buggy upgrade to either contract can
  brick all SwapFeeRouter swaps until the next 48 h timelock cycle rotates it
  back out.

**Evidence:**
```solidity
// SwapFeeRouter.sol:394-402
function _recordReferralFee(address _user, uint256 _feeAmount) internal returns (bool) {
    if (address(referralSplitter) == address(0) || _feeAmount == 0) return false;
    try referralSplitter.recordFee{value: _feeAmount}(_user) {  // ← no gas cap
        return true;
    } catch {
        emit ReferralFeeRedirectedToTreasury(_user, _feeAmount);
        return false;
    }
}

// SwapFeeRouter.sol:425-434
if (baseFee > 0 && address(premiumAccess) != address(0)) {
    try premiumAccess.hasPremiumSecure(user) returns (bool isPremium) {  // ← no gas cap
        ...
    } catch {
        // Fail-open
    }
}
```

Compare with `distributeFeesToStakers` line 1032 / 1046 which DO cap gas at
`50_000` for the same reason ("AUDIT FIX M-4 (battle-tested): bound the gas
forwarded to protocol-internal destinations at 50_000").

**Recommendation:** Cap gas on both calls. `recordFee` only needs to bump a
storage slot and emit an event (~30 k gas budget); `hasPremiumSecure` is a
pure view (~15 k gas budget). Apply the same 50 k stipend pattern as
`distributeFeesToStakers`:

```solidity
try referralSplitter.recordFee{value: _feeAmount, gas: 50_000}(_user) { ... }
```

Solidity 0.8.x permits the `gas:` modifier on `try` calls. Closes the OOG
griefing surface and matches the protocol's own pattern.

---

## [DEEP-R-M04] `polAccumulator = address(0)` silently breaks the timelocked fee-split invariant

**Severity:** Medium
**File:** `contracts/src/SwapFeeRouter.sol:1044-1057` × `:1081-1085`
**Category:** admin

**Bug:** `applyPolAccumulator(_newAccumulator)` is `onlyAdmin`-gated and lives
behind a 48 h timelock on `SwapFeeRouterAdmin` (key `POL_ACCUMULATOR_CHANGE`).
Setting `polAccumulator = address(0)` is documented as "re-routes POL to
treasury" — but this re-routing happens at `distributeFeesToStakers` time,
NOT at propose time. The timelocked `feeSplit` invariant
(`stakerShareBps + polShareBps + treasuryShareBps == BPS`,
`polShareBps <= MAX_POL_SHARE_BPS = 25%`) is enforced when applying a split,
but NOT when applying a POL-accumulator change. So:

1. Governance proposes & executes `feeSplit(stakerShareBps=50%, polShareBps=25%)`.
   Treasury share is implicit at 25%.
2. Later, governance proposes & executes `polAccumulator = address(0)`. No
   propose-time check on this against the active fee split.
3. Next `distributeFeesToStakers()` call: POL slice (25%) folds into treasury
   (line 1054). Treasury now silently gets 50%, double its committed share.

Stakers (the marketing-promised guardrail) still get their 50% so the strict
"min staker share" invariant is upheld. But the POL-versus-treasury split is
**effectively governed by `polAccumulator` value, not by any timelocked
parameter** — a 48 h timelock to flip a single address is the same window as
the timelock that protects the share BPS itself, but the address change is
not subject to the same on-chain bound.

**Attack / Impact:** The ATTACK shape is "compromised owner waits 48 h, sets
`polAccumulator = 0`, doubles treasury share without ever proposing a
fee-split change". Off-chain monitors that watch
`FeeSplitChangeProposed` events for governance changes will MISS this
because the affected variable is `polAccumulator`, not the share BPS.

**Evidence:**
```solidity
// SwapFeeRouter.sol:1040-1057 — POL slice fold-to-treasury logic
if (polAmount > 0) {
    if (polAccumulator != address(0)) {
        (bool okPol,) = polAccumulator.call{value: polAmount, gas: 50_000}("");
        ...
    } else {
        treasuryAmount += polAmount;   // ← silent fee-split mutation
        polAmount = 0;
    }
}

// SwapFeeRouter.sol:1081-1085 — applyPolAccumulator has NO bound check
function applyPolAccumulator(address _newAccumulator) external onlyAdmin {
    address old = polAccumulator;
    polAccumulator = _newAccumulator;
    emit PolAccumulatorUpdated(old, _newAccumulator);
}
```

**Recommendation:** Either:

(a) Reject `applyPolAccumulator(address(0))` whenever `polShareBps > 0` —
    forces governance to first explicitly zero the POL share via the proper
    `feeSplit` timelock; OR
(b) When `polAccumulator == address(0)`, REVERT in `distributeFeesToStakers`
    instead of folding to treasury — this surfaces the misconfiguration
    immediately and forces governance to propose a proper `feeSplit` zero-out.

(a) is the lighter change and matches the marketing claim that the fee split
is timelock-immutable.

---

## [DEEP-R-M05] Token-recipient `to == address(this)` is blocked on SwapFeeRouter swaps but NOT on TegridyRouter swaps

**Severity:** Medium
**File:** `contracts/src/TegridyRouter.sol:190-340` (9 entry-points)
**Category:** erc20

**Bug:** TegridyRouter's user-facing swap entries (`swapExactTokensForTokens`,
`swapExactETHForTokens`, `swapExactTokensForETH`, the three exact-output
variants, plus the three FoT variants) validate `to != address(0)` and
`to != _pairFor(path[length-2], path[length-1])` (the last-hop pair) but do
NOT validate `to != address(this)`. SwapFeeRouter's wrapper layer correctly
adds the check (`if (to == address(0) || to == address(this)) revert
InvalidRecipient();`).

This is the M-1 finding in `002_TegridyRouter.md` from a prior pass — but it
remains unfixed. Worth re-flagging because the SwapFeeRouter layer
demonstrates the protocol team already understands the pattern; the asymmetric
omission on TegridyRouter is an oversight, not a deliberate design choice.

**Attack / Impact:** A user (or aggregator routing through TegridyRouter
directly, NOT via SwapFeeRouter) that mistakenly passes `to = address(router)`
permanently strands the output token in the router. There is no `sweepTokens`
function on TegridyRouter (compare with SwapFeeRouter line 1322). Funds are
lost — not stealable, but also not recoverable.

Concrete scenario: a multisig-driven swap where the operator fills `to` with
the router address (a copy-paste of the contract address from the deployment
log). Output land in the router, no recovery path.

**Evidence:**
```solidity
// TegridyRouter.sol:190-206 — note the missing to == address(this) check
function swapExactTokensForTokens(
    uint256 amountIn, uint256 amountOutMin,
    address[] calldata path, address to, uint256 deadline
) external nonReentrant ensure(deadline) returns (uint256[] memory amounts) {
    if (path.length < 2) revert InvalidPath();
    if (to == address(0)) revert InvalidRecipient();
    if (to == _pairFor(path[path.length - 2], path[path.length - 1])) revert InvalidRecipient();
    // ⚠ NO check for `to == address(this)` — output stuck in router
    ...
}
```

Same shape across all 9 swap entry-points and `removeLiquidity*`.

**Recommendation:** Add `if (to == address(this)) revert InvalidRecipient();`
to every TegridyRouter public entry. One-line change. Mirrors SwapFeeRouter
line 484 (`if (to == address(0) || to == address(this)) revert InvalidRecipient();`).

---

## [DEEP-R-M06] No mechanism to re-bootstrap a corrupted `lastConversionSnapshot`

**Severity:** Medium
**File:** `contracts/src/SwapFeeRouter.sol:153-157` × `:1245` × `:1315` × `:1498-1525`
**Category:** admin · math

**Bug:** `lastConversionSnapshot[token]` is a one-shot bootstrap: `timestamp == 0`
selects the owner-only bootstrap path; any non-zero timestamp activates
permissionless TWAP-floor enforcement. There is NO setter to reset
`lastConversionSnapshot` back to zero. Once bootstrapped, the snapshot is
permanent. This means:

1. If the owner accidentally bootstraps when the token/WETH pair is mid-attack
   (e.g. low liquidity, wide spread, wrong-pool-routed trade), the recorded
   `cumulative` reflects that anomaly. Subsequent permissionless calls compute
   TWAP from `(currentCum - prev.cumulative) / elapsed`, anchored to the bad
   baseline.
2. If `uniFactory.getPair(token, WETH)` later changes (unlikely on Uniswap V2
   but possible if the protocol switches the immutable router constructor
   argument is updated via a redeploy), the cumulative is being read from a
   different pair than the snapshot was taken on — invalid math.

The 1.5% safety margin (`TWAP_SAFETY_BPS`) limits the per-call damage, but
over many conversions the accumulated bleed is real.

**Attack / Impact:** Realistic scenario: owner bootstraps `convertTokenFeesToETH`
for a low-liquidity token during off-peak hours. A small front-run + owner-swap
+ back-run sandwich seeds a snapshot at a manipulated cumulative. Every
subsequent permissionless conversion then computes TWAP against this poisoned
baseline. With `MIN_TWAP_PERIOD = 30 minutes` and `CONVERSION_COOLDOWN = 1 hour`,
the manipulation persists for 30 minutes minimum and fades only as new
swaps update Uniswap's `priceCumulativeLast`. Owner has no on-chain remediation
path.

**Evidence:**
```solidity
// SwapFeeRouter.sol — only writes are at the end of successful conversions
1245:  lastConversionSnapshot[token] = PriceSnapshot({timestamp: currentTs, cumulative: currentCum});
1315:  lastConversionSnapshot[token] = PriceSnapshot({timestamp: currentTs, cumulative: currentCum});

// No `delete lastConversionSnapshot[token]` anywhere.
```

**Recommendation:** Add an owner-only reset that clears the snapshot back to
zero, behind a 7-day timelock for parity with admin replacement:

```solidity
function proposeResetTWAPSnapshot(address token) external onlyOwner { ... }
function executeResetTWAPSnapshot() external onlyOwner {
    ...
    delete lastConversionSnapshot[pendingResetToken];
}
```

Or unconditionally allow the owner to reset behind the same 30-day MAX_DELAY
TimelockAdmin pattern (same as POL, fee-split, etc).

---

## [DEEP-R-L01] Stale `pendingDistribution[recipient]` state can be claimed by malicious successor at the same address

**Severity:** Low
**File:** `contracts/src/SwapFeeRouter.sol:1337-1345`
**Category:** admin

**Bug:** `withdrawPendingDistribution(recipient)` is permissionless — anyone
can drain the queue back to the recipient. ETH is sent via `WETHFallbackLib`
which falls back to WETH if the recipient cannot receive ETH. The function
keys on the literal `recipient` address. If the original `revenueDistributor`
or `polAccumulator` contract self-destructs or is replaced, and a new
contract is later deployed at the same address (CREATE2 with predictable salt),
the new contract — possibly hostile — can claim the queued slice.

**Attack / Impact:** Mostly hypothetical given that:
(a) `revenueDistributor` and `polAccumulator` are not CREATE2-deployed in the
    canonical setup; they are constructor-deployed singleton contracts.
(b) Even if they were CREATE2-redeployable, an attacker would need governance
    to install the new contract at the SwapFeeRouter level via the 48 h timelock,
    at which point they're already privileged.

The risk is realistic only if a future POL or revenue integration uses
CREATE2 metaproxies (mooncake / minimal-proxy patterns). Not a current
concern but a forward-defence note.

**Evidence:**
```solidity
function withdrawPendingDistribution(address recipient) external nonReentrant {
    if (recipient == address(0)) revert ZeroAddress();
    uint256 amount = pendingDistribution[recipient];
    if (amount == 0) revert ZeroAmount();
    pendingDistribution[recipient] = 0;
    totalPendingDistribution -= amount;
    WETHFallbackLib.safeTransferETHOrWrap(WETH, recipient, amount);  // ← sends to whoever's at `recipient` NOW
    emit PendingDistributionWithdrawn(recipient, amount);
}
```

**Recommendation:** Track the recipient's CREATION/registration block alongside
the queue entry; reject withdrawals if the contract code at `recipient` has
changed since the slice was queued. Implementation:

```solidity
struct DeferredEntry { uint256 amount; bytes32 codeHashAtQueue; }
mapping(address => DeferredEntry) public pendingDistribution;

// In distributeFeesToStakers, on the failure path:
pendingDistribution[recipient] = DeferredEntry({
    amount: existing.amount + slice,
    codeHashAtQueue: recipient.codehash
});

// In withdrawPendingDistribution:
if (recipient.codehash != entry.codeHashAtQueue) revert RecipientCodeChanged();
```

This is defence-in-depth; LOW priority unless CREATE2 metaproxies are
introduced.

---

## [DEEP-R-L02] `TegridyRouter.removeLiquidity` non-ETH variant doesn't validate `to != address(0)`

**Severity:** Low
**File:** `contracts/src/TegridyRouter.sol:144-159`
**Category:** erc20

**Bug:** `removeLiquidityETH` (line 162-186) explicitly validates
`require(to != address(0), "ZERO_TO")`. The non-ETH variant `removeLiquidity`
(line 144-159) does NOT — it only checks `to != pair`. Sending `to = address(0)`
results in `TegridyPair.burn(address(0))` which then attempts
`safeTransfer(0x0, ...)`. OZ's SafeERC20 reverts on zero-address transfers,
but the revert message is opaque. Inconsistent with the ETH-variant sibling.

This is L-4 in `002_TegridyRouter.md` — re-flagging because it's the same
"sibling miss" pattern as the to==address(this) finding above and worth
batching into a one-line cleanup.

**Attack / Impact:** Inconvenience only — funds aren't lost (revert), but
opaque error message complicates frontend debugging and is asymmetric with
the well-validated `removeLiquidityETH`.

**Evidence:**
```solidity
// TegridyRouter.sol:144-159 — missing zero-to check
function removeLiquidity(...) external nonReentrant ensure(deadline) returns (uint256 amountA, uint256 amountB) {
    address pair = ITegridyFactoryRouter(factory).getPair(tokenA, tokenB);
    require(pair != address(0), "PAIR_NOT_FOUND");
    require(to != pair, "INVALID_TO");
    // ⚠ no `require(to != address(0), "ZERO_TO");`
    ...
}

// Compare TegridyRouter.sol:162-167:
function removeLiquidityETH(...) {
    require(to != address(0), "ZERO_TO");   // ← present
    ...
}
```

**Recommendation:** Add `require(to != address(0), "ZERO_TO");` to
`removeLiquidity` for parity.

---

## [DEEP-R-L03] `recoverCallerCredit` silently consumes nothing on a non-credited splitter — gas griefing

**Severity:** Low
**File:** `contracts/src/SwapFeeRouter.sol:1352-1361`
**Category:** dos

**Bug:** `recoverCallerCredit` is permissionless. It calls
`referralSplitter.withdrawCallerCredit()` on every invocation, regardless of
whether there's any credit to recover. The splitter's `withdrawCallerCredit`
typically does an SLOAD + (in zero-credit case) an early return — total ~2.5 k
gas per call. An attacker can spam this in a tight loop to grief — burning
their own gas at zero direct cost to the protocol, but consuming block-space.

**Attack / Impact:** Negligible direct impact. Indirect impact: clutters
event logs (`CallerCreditRecovered(splitter, 0)` per call), confusing off-chain
monitors. Costs the attacker enough gas to make this an unattractive
permanent grief vector.

**Evidence:**
```solidity
function recoverCallerCredit() external nonReentrant {
    require(address(referralSplitter) != address(0), "NO_SPLITTER");
    uint256 balBefore = address(this).balance;
    referralSplitter.withdrawCallerCredit();   // ← always runs, even when 0 credit
    uint256 recovered = address(this).balance - balBefore;
    if (recovered > 0) {
        accumulatedETHFees += recovered;
    }
    emit CallerCreditRecovered(address(referralSplitter), recovered);   // ← emitted with 0
}
```

**Recommendation:** Either (a) add a per-tx cooldown (`mapping(address ⇒ uint256)
lastCallerCreditPull`), or (b) skip the external call when the splitter exposes
a `pendingCallerCredit() view` that returns zero. Likely deferrable as
INFO-level — the 2.5 k gas floor is itself a soft rate-limit.

---

## [DEEP-R-I01] `_recordReferralFee` and `try premiumAccess.hasPremiumSecure` swallow ALL revert kinds — including invariant violations

**Severity:** Info
**File:** `contracts/src/SwapFeeRouter.sol:394-402` × `:425-434`
**Category:** other

**Observation:** Both try/catch blocks use the bare `catch { … }` form, which
catches every revert reason — including assertion failures (`Panic(0x01)`),
arithmetic overflow / underflow (`Panic(0x11)`), out-of-bound access
(`Panic(0x32)`), and outright `revert` calls. This is the documented
fail-open pattern (per the in-source comment). However it also means that an
upgrade to either contract that introduces a critical INVARIANT violation
(`assert(invariant)`) is silently swallowed by SwapFeeRouter. The user
continues paying full fees and the broken contract is not surfaced to the
user even though the protocol invariant is violated.

The protocol's `isPremiumAccessHealthy()` view exists specifically to give
off-chain monitoring a probe — but no on-chain alarm. If `premiumAccess` is
a registry that's holding broken assert state (e.g. expected supply parity
violated), the protocol would continue swapping until off-chain monitors
catch it.

**Recommendation:** Defensively, narrow the `catch` to `catch Error(string memory)
{ ... } catch Panic(uint256) { ... } catch (bytes memory) { ... }` so an
asserted invariant is at least distinguishable from a normal revert. Optional
hardening; current behaviour matches the documented intent.

---

## Summary of patterns observed

1. **Half-installed mitigations** continue to dominate. SFR-M-01 (multi-hop
   conversion path) was added without considering that the TWAP helper itself
   demands a direct token/WETH pair — defeats the whole purpose of multi-hop
   for tokens lacking that pair. SFR-M-04 (admin replacement) has the
   propose/execute flow but skipped the proposal-validity window that
   `TimelockAdmin` enforces for every other parameter. These are
   sibling-miss patterns (MICROSCOPE_2026_04_30 §4).

2. **Pause asymmetry**: user-facing entry-points are paused; cleanup /
   distribution / recovery primitives are NOT. Same pattern as the M-30
   `PremiumAccess.batchReconcileExpired` finding. Should be a standing
   review-time check: every public function that mutates ETH or accumulated-fee
   state should respect `whenNotPaused`.

3. **Implicit governance via address-zero defaults**: `polAccumulator = 0`
   silently reroutes the POL share to treasury, bypassing the `feeSplit`
   timelock invariant. Same shape as the historical R014-style "instant
   override behind a permissioned setter" pattern.

4. **Owner-trust assumptions are leaky**: the multi-hop conversion path puts
   trust in the owner's path choice but doesn't sanity-check intermediate
   hops. Most protocols assume owner doesn't shoot themselves; the fix here
   is cheap defensive validation, not full mistrust modelling.

5. **TWAP snapshot is one-shot**: no remediation path if the bootstrap is
   compromised. Compounds with the 1.5% safety margin to create a
   slow-bleed surface.

---

## Out-of-scope but worth flagging in next pass

- TegridyRouter has no admin / pause / sweep functions — no recovery from the
  `to == address(this)` strand (DEEP-R-M05). Consider adding an emergency
  sweep with proportional fee pre-share (donate to LPs of the strand pool).
- SwapFeeRouter's `MAX_DEADLINE = 2 hours` was raised from 30 min for L1
  congestion. On a future L2 deployment this may need tuning per chain;
  worth a per-chain immutable rather than a single global constant.
- The `inputTokenFeeBps` / `hasInputTokenFeeOverride` storage was renamed for
  clarity but the legacy `pairFeeBps` getter is still public ABI. New
  integrators may assume per-pair semantics; doc-only fix tracked in
  SFR-M-03 commit but the legacy getter is still alive.

