# DEEP audit (PASS 2) — `contracts/src/{base,lib,Toweli}.sol` cluster

**Date:** 2026-05-01 (post-`ae45004` regression sweep)
**Scope:** TimelockAdmin, OwnableNoRenounce, SequencerCheck, WETHFallbackLib, Toweli — 5 files / ~640 LoC
**Method:** Re-read post-fix source line-by-line; verified each pass-1 finding closure; cross-checked all 17 importers for sibling regressions; reviewed the new Deep_LibBase_2026_05_01 test file and the +1284 LoC fix commit diff.
**Compile:** `forge build --use 0.8.26` clean (only pre-existing `erc20-unchecked-transfer` lint warnings on test files; no errors).

---

## Headline tally

- **Critical:** 0
- **High:** 0
- **Medium:** 2
- **Low:** 4
- **Info:** 2

The fixes from commit `ae45004` close every pass-1 finding cleanly. Two genuine regressions surfaced in the new code surface — both relate to "non-reverting" helpers that can still revert under arithmetic-underflow or test-warp paths the new tests don't exercise. Four lower-severity sharp edges and two info-level documentation drifts round out the list.

---

## [v2-LIB-M1] `tryCheckSequencerUp` and `getSequencerOutageBuffer` advertise "non-reverting" but underflow on future-dated `updatedAt` / `startedAt`
**Severity:** Medium
**File:** `contracts/src/lib/SequencerCheck.sol:183, 186, 224, 227`
**Category:** regression
**Pass-1 ref:** DEEP-LIB-M6 / DEEP-LIB-H2

**Bug:** The new `tryCheckSequencerUp(...)` and `getSequencerOutageBuffer(...)` helpers replace `revert` with `(false, reason)` / `return buffer` so view consumers can degrade gracefully. They MISS the underflow-on-checked-arithmetic case: `block.timestamp - updatedAt` and `block.timestamp - startedAt` revert with `Panic(0x11)` when the feed reports a timestamp greater than `block.timestamp`. The "non-reverting" promise is broken — the helpers DO revert, just with an opaque arithmetic panic rather than a typed `SequencerDown`/`SequencerGracePeriodNotOver`.

A Chainlink L2 sequencer feed with sub-second clock skew (or any bridged/relayed feed that posts `updatedAt = blockTime + 1` because the relay rounded up) will trip this on the very block the answer changes. Indexers and frontend simulators relying on the "soft fail" promise will see a hard revert in their `eth_call` and either alarm-loop or display "estimation error" — exactly the UX the M6 fix promised to eliminate.

**Attack / Impact:** During a sequencer-resume event where the relay clock posts `updatedAt = block.timestamp + 1` (commonly observed on Arbitrum/Base after a sequencer-replay), every consumer of `tryCheckSequencerUp` (planned future indexer / aggregator / quoter paths) reverts hard. `MemeBountyBoard._sequencerBuffer()` — which calls `getSequencerOutageBuffer` from `refundStaleBounty` and `emergencyForceCancel` — reverts with `Panic(0x11)` instead of returning a buffer, blocking honest refund/cancel calls during the very window the buffer was designed to widen. The pass-1 sequence (down → resume → grace) cannot be exercised because the resume tx itself can't be processed.

**Evidence:**
```
contracts/src/lib/SequencerCheck.sol:183
183        if (block.timestamp - updatedAt > staleness) return (false, TRY_KEEPER_LAPSED);
186        if (block.timestamp - startedAt < gracePeriod) return (false, TRY_IN_GRACE);
...
contracts/src/lib/SequencerCheck.sol:224
224        if (block.timestamp - updatedAt > MAX_FEED_STALENESS) return buffer; // keeper lapse
227        if (block.timestamp - startedAt < buffer) return buffer;             // within grace
```
The reverting `checkSequencerUp` has the same arithmetic shape (lines 128, 140) — but reverting on underflow there is *consistent* with its revert contract, so it's not a regression for that function. For the soft-fail siblings it IS a regression of the M6 promise.

**Recommendation:** Wrap the subtraction in `unchecked` and check directional ordering first:
```solidity
// tryCheckSequencerUp staleness branch
if (updatedAt > block.timestamp) return (false, TRY_KEEPER_LAPSED); // future-dated
unchecked {
    if (block.timestamp - updatedAt > staleness) return (false, TRY_KEEPER_LAPSED);
}
// grace branch
if (startedAt > block.timestamp) return (false, TRY_IN_GRACE); // future-dated startedAt
unchecked {
    if (block.timestamp - startedAt < gracePeriod) return (false, TRY_IN_GRACE);
}
```
Mirror in `getSequencerOutageBuffer`. The reverting `checkSequencerUp` may keep checked-math semantics — its contract is "revert on anomaly" anyway. Add a unit test that calls `tryCheckSequencerUp` with `feed.updatedAt = block.timestamp + 1` and asserts `(false, TRY_KEEPER_LAPSED)` rather than panic.

---

## [v2-LIB-M2] `getSequencerOutageBuffer` hardcodes `MAX_FEED_STALENESS` — partial closure of DEEP-LIB-M3 (per-consumer staleness tuning)
**Severity:** Medium
**File:** `contracts/src/lib/SequencerCheck.sol:204-229`
**Category:** gap
**Pass-1 ref:** DEEP-LIB-M3 / DEEP-LIB-H2

**Bug:** DEEP-LIB-M3 added the `(feed, gracePeriod, staleness)` overload to both `checkSequencerUp` and `tryCheckSequencerUp`, letting consumers pick a tighter staleness window. The new `getSequencerOutageBuffer(feed, buffer)` helper introduced for DEEP-LIB-H2 silently uses the constant `MAX_FEED_STALENESS = 24 hours` (line 224) and offers NO overload. Consumers that legitimately need a tighter window (e.g. `MemeBountyBoard` short-deadline bounties where 24h staleness is generous relative to a 1h `SEQUENCER_OUTAGE_BUFFER`) cannot tune. The asymmetry is a consistency defect: the helper trio (`checkSequencerUp`, `tryCheckSequencerUp`, `getSequencerOutageBuffer`) should take the same staleness parameter set, or none of them should.

The only current consumer (`MemeBountyBoard._sequencerBuffer`) accepts the 24h default — but the API surface is inconsistent and a future caller (e.g. drop-rescue, premium-access lapse) inheriting the H2 helper will inherit the constant lock-in.

**Attack / Impact:** Operational only. A tighter-staleness consumer must either re-implement `getSequencerOutageBuffer` (re-introducing the M-Lib3 sibling-miss the H2 fix was supposed to eliminate) or accept the 24h staleness default. Today: harmless. Future-proofing risk: a single H2 sibling re-implementation would re-open the duplication problem the canonical helper just closed.

**Evidence:**
```
contracts/src/lib/SequencerCheck.sol:204-229
204    function getSequencerOutageBuffer(address feed, uint256 buffer)
205        internal view returns (uint256)
206    {
...
224        if (block.timestamp - updatedAt > MAX_FEED_STALENESS) return buffer; // keeper lapse
```
Compare `checkSequencerUp` lines 98-100 (constant default) + 110-143 (parametric overload). H2's helper has only the constant variant.

**Recommendation:** Add the symmetric overload:
```solidity
function getSequencerOutageBuffer(address feed, uint256 buffer)
    internal view returns (uint256)
{
    return getSequencerOutageBuffer(feed, buffer, MAX_FEED_STALENESS);
}

function getSequencerOutageBuffer(address feed, uint256 buffer, uint256 staleness)
    internal view returns (uint256)
{
    // existing body, replacing MAX_FEED_STALENESS with staleness
}
```
Same shape as the sibling functions; trivial change, restores API consistency.

---

## [v2-LIB-L1] `OwnableNoRenounce._transferOwnership` `address(0)` carve-out is dead code with an incorrect rationale comment
**Severity:** Low
**File:** `contracts/src/base/OwnableNoRenounce.sol:64-72`
**Category:** other
**Pass-1 ref:** DEEP-LIB-M1

**Bug:** The override `_transferOwnership(address newOwner)` allows `newOwner == address(0)` to flow through `super` un-checked, with the comment justifying it as "OZ's internal book-keeping (e.g. `delete _pendingOwner` on accept) isn't broken by our additional guard." That rationale is wrong: OZ `Ownable2Step._transferOwnership` calls `delete _pendingOwner` UNCONDITIONALLY — the address-zero passthrough has no bearing on it. The only path that reaches `_transferOwnership(0)` is `Ownable.renounceOwnership()`, which `OwnableNoRenounce.renounceOwnership` overrides to revert with `RENOUNCE_DISABLED`. The carve-out is therefore unreachable (dead code) AND its justification comment is factually incorrect.

The minor risk: a future custom subclass that adds a "soft-renounce" or "emergency mode" path calling `_transferOwnership(address(0))` directly would silently bypass the contract-only owner guard. Not exploitable today; future-safety lint.

**Attack / Impact:** None today. Latent risk: if a child contract opts in to `_ownerMustBeContract = true` AND adds an `_emergencyClearOwner()` helper that calls `_transferOwnership(address(0))`, the carve-out lets the call succeed even though the post-state (zero owner) directly contradicts the "owner must be a contract" invariant.

**Evidence:**
```
contracts/src/base/OwnableNoRenounce.sol:64-72
64    ///      OZ Ownable2Step calls `_transferOwnership` from `acceptOwnership`,
65    ///      so this guard catches both initial transfer and rotation. We
66    ///      explicitly allow `address(0)` to flow through `super` so OZ's
67    ///      internal book-keeping (e.g. `delete _pendingOwner` on accept)
68    ///      isn't broken by our additional guard.
69    function _transferOwnership(address newOwner) internal virtual override {
70        if (_ownerMustBeContract() && newOwner != address(0) && newOwner.code.length == 0) {
71            revert OwnerNotContract(newOwner);
72        }
```
OZ `Ownable2Step._transferOwnership` (`contracts/lib/openzeppelin-contracts/contracts/access/Ownable2Step.sol:52-55`):
```solidity
function _transferOwnership(address newOwner) internal virtual override {
    delete _pendingOwner;
    super._transferOwnership(newOwner);
}
```
`delete _pendingOwner` runs regardless of `newOwner`. The carve-out is unnecessary.

**Recommendation:** Remove the `address(0)` carve-out and update the comment:
```solidity
function _transferOwnership(address newOwner) internal virtual override {
    if (_ownerMustBeContract() && newOwner.code.length == 0) {
        revert OwnerNotContract(newOwner);
    }
    super._transferOwnership(newOwner);
}
```
`renounceOwnership` already reverts at the entrypoint, so disallowing `_transferOwnership(0)` here is harmless and tightens the invariant. If a future subclass legitimately needs zero-owner soft-renounce semantics, it can override or wrap the helper explicitly.

---

## [v2-LIB-L2] `TimelockAdmin` exposes two functionally-identical view accessors (`_proposalReadyAt` and `_executeAfterOf`)
**Severity:** Low
**File:** `contracts/src/base/TimelockAdmin.sol:184-196`
**Category:** other
**Pass-1 ref:** DEEP-LIB-H4 / DEEP-LIB-M5

**Bug:** The H4/M5 fix added `_executeAfterOf(bytes32)` as the "preferred read accessor" for child contracts. The pre-existing `_proposalReadyAt(bytes32)` (added in an earlier audit pass) has an identical body and identical signature. The doc comments label `_executeAfterOf` as "functionally identical" to `_proposalReadyAt` and direct migration to `_executeAfterOf`, but the legacy accessor isn't deprecated, removed, or even marked `@dev DEPRECATED`. Future contributors will pick whichever they encounter first, increasing accessor-name drift across the 17 importers and producing a per-contract style schism.

**Attack / Impact:** None — both accessors return the same value. Code-smell only; raises diff-cost of future audits ("which accessor is canonical?") and increases the chance a future migration to `private _executeAfter` accidentally leaves one accessor pointing at a dead slot.

**Evidence:**
```
contracts/src/base/TimelockAdmin.sol:181-196
184    function _proposalReadyAt(bytes32 key) internal view returns (uint256) {
185        return _executeAfter[key];
186    }
...
194    function _executeAfterOf(bytes32 key) internal view returns (uint256) {
195        return _executeAfter[key];
196    }
```
No importer currently calls either accessor (all 17 still read `_executeAfter[KEY]` directly), so the duplication has zero runtime cost — but it locks-in a future-migration footgun.

**Recommendation:** Pick one. Either:
- Mark `_proposalReadyAt` `@dev DEPRECATED — use _executeAfterOf` and remove in next major version, OR
- Delete `_executeAfterOf` and document `_proposalReadyAt` as canonical.

Either way, drop the second accessor in the next clean-up pass.

---

## [v2-LIB-L3] `WETHFallbackLib.safeTransferETH` (bare variant) does NOT emit `ETHTransferred` — asymmetric with the wrap variant's success-path event
**Severity:** Low
**File:** `contracts/src/lib/WETHFallbackLib.sol:106-111`
**Category:** side-effect
**Pass-1 ref:** DEEP-LIB-L1 / DEEP-LIB-M2

**Bug:** The DEEP-LIB-L1 fix added `event ETHTransferred(address,uint256)` and emits it on the success path of `safeTransferETHOrWrap` (line 83). The same event is NOT emitted on the success path of the bare `safeTransferETH` variant — even though both functions deliver ETH and both could be observed by the same off-chain accounting infrastructure. Since L1's stated motivation was "off-chain accounting is missing positive ack on the success path", the asymmetry re-creates exactly that gap whenever a future caller picks the bare variant.

Today only test code uses bare `safeTransferETH` (no production callsite), so the asymmetry is dormant — but the lib is the protocol's reusable transfer primitive and the inconsistency will bite a future contributor.

**Attack / Impact:** None today. Future-safety: a new caller picking `safeTransferETH` (e.g. a refund path that explicitly chooses the no-fallback variant) will silently emit no breadcrumb, regressing L1's accounting promise.

**Evidence:**
```
contracts/src/lib/WETHFallbackLib.sol:106-111
106    function safeTransferETH(address to, uint256 amount) internal {
107        if (amount == 0) return;
108        if (to == address(0)) revert ZeroRecipient();
109        (bool ok,) = to.call{value: amount, gas: 10000}("");
110        if (!ok) revert ETHTransferFailed();
111    }
```
No `emit ETHTransferred(to, amount)`.

**Recommendation:** Add the success-path emit for symmetry:
```solidity
function safeTransferETH(address to, uint256 amount) internal {
    if (amount == 0) return;
    if (to == address(0)) revert ZeroRecipient();
    (bool ok,) = to.call{value: amount, gas: 10000}("");
    if (!ok) revert ETHTransferFailed();
    emit ETHTransferred(to, amount);
}
```
Single line; restores L1's contract.

---

## [v2-LIB-L4] `Toweli.permit` override silently swallows OZ's typed `ECDSAInvalidSignatureS` revert and surfaces a generic `ERC2612InvalidSigner(0x0, owner)` instead
**Severity:** Low
**File:** `contracts/src/Toweli.sol:135-161`
**Category:** side-effect
**Pass-1 ref:** DEEP-LIB-L3

**Bug:** OZ's stock `ERC20Permit.permit` calls `ECDSA.recover(hash, v, r, s)`, which reverts with the typed errors `ECDSAInvalidSignatureS(s)`, `ECDSAInvalidSignatureLength(len)`, or `ECDSAInvalidSignature()` depending on which validation step fails. The new override calls `SignatureChecker.isValidSignatureNow(...)`, which internally invokes `ECDSA.tryRecover` — a `try` variant that returns `RecoverError` and does NOT revert — and then converts ANY failure into `ERC2612InvalidSigner(address(0), owner)`. Off-chain tooling that switches on the typed ECDSA errors (wagmi, ethers, viem all surface them) loses information: a malleable-S signature, a 64-vs-65-byte length mismatch, and a flat-out-wrong signer all collapse to the same opaque error.

This is a structural side-effect of the L3 fix (which replaced a reverting helper with a returning one). Not exploitable; pure DX/forensics regression.

**Attack / Impact:** UX/forensics. Client-side error handling that previously distinguished "signature is malleable, retry with normalized S" from "signature signer doesn't match owner" can no longer do so. Frontend retry logic in wagmi templates that handle `ECDSAInvalidSignatureS` specifically will fall through to a generic-failure branch and either prompt the user to re-sign or show "permit failed" with no diagnostic.

**Evidence:**
```
contracts/src/Toweli.sol:155-158
155        // SignatureChecker dispatches to ECDSA.recover for EOAs and to
156        // ERC-1271 staticcall (`isValidSignature`) for contract wallets.
157        if (!SignatureChecker.isValidSignatureNow(owner, hash, abi.encodePacked(r, s, v))) {
158            revert ERC2612InvalidSigner(address(0), owner);
```
Compare OZ `ERC20Permit.permit` (`token/ERC20/extensions/ERC20Permit.sol:59-62`):
```solidity
address signer = ECDSA.recover(hash, v, r, s); // reverts with typed errors
if (signer != owner) {
    revert ERC2612InvalidSigner(signer, owner);
}
```

**Recommendation:** Either (a) have the override pre-validate using `ECDSA.tryRecover` and surface the typed error directly when an EOA path fails, falling through to ERC-1271 only for contract signers; OR (b) document the error-collapse in the NatSpec so client teams know to expect a single error code:
```solidity
/// @dev Note: clients that previously branched on `ECDSAInvalidSignatureS` /
///      `ECDSAInvalidSignatureLength` MUST collapse all signature-validation
///      failures to `ERC2612InvalidSigner(0x0, owner)` for this token. The
///      SignatureChecker-based override does not surface the upstream typed
///      ECDSA errors.
```
Option (a) is cleaner; option (b) is the docs-only stopgap.

---

## [v2-LIB-L5] `OwnableNoRenounce` constructor body's contract-only check is unreachable defense-in-depth (already enforced via `_transferOwnership` override)
**Severity:** Low
**File:** `contracts/src/base/OwnableNoRenounce.sol:33-48`
**Category:** other
**Pass-1 ref:** DEEP-LIB-M1

**Bug:** OZ's `Ownable(initialOwner)` constructor calls `_transferOwnership(initialOwner)` BEFORE `OwnableNoRenounce`'s constructor body runs. Solidity's virtual dispatch correctly routes `_transferOwnership` through the most-derived contract's override even during construction, so the `_ownerMustBeContract && code.length == 0` check inside the override (line 69) fires FIRST and reverts with `OwnerNotContract`. The duplicate check inside the constructor body (lines 45-47) is structurally unreachable — by the time control reaches it, either `super` has already reverted (EOA case) or the override accepted the contract (success case). Both branches result in the body check being dead code.

The `// defense-in-depth` comment is misleading. The single source of truth is the `_transferOwnership` override; the constructor-body check adds zero coverage and slightly confuses the audit trail.

**Attack / Impact:** None. Pure code-clarity issue; a 12-line dead-code block sits in a security-critical base contract and reads as defense-in-depth when it isn't.

**Evidence:**
```
contracts/src/base/OwnableNoRenounce.sol:33-48
33    constructor(address initialOwner) Ownable(initialOwner) {
34        require(initialOwner != address(0), "ZERO_OWNER");
...
45        if (_ownerMustBeContract() && initialOwner.code.length == 0) {
46            revert OwnerNotContract(initialOwner);
47        }
```
The OZ `Ownable` constructor (`access/Ownable.sol:38-43`) calls `_transferOwnership(initialOwner)` immediately, which dispatches through our override at line 68. By the time line 45 runs, the override has already accepted or rejected the address.

(Also unreachable: `require(initialOwner != address(0), "ZERO_OWNER");` on line 34 — OZ's `Ownable` constructor reverts with the typed `OwnableInvalidOwner(address(0))` BEFORE invoking `_transferOwnership`.)

**Recommendation:** Drop both unreachable checks and replace with a one-liner pointing to the canonical enforcement:
```solidity
constructor(address initialOwner) Ownable(initialOwner) {
    // Enforcement (zero-owner + contract-only) lives in `_transferOwnership`,
    // which Ownable's constructor invokes via virtual dispatch BEFORE this
    // body runs. Adding checks here would be unreachable.
}
```
Or leave a comment-only stub. Saves ~50 deployed bytes and clarifies the audit story.

---

## [v2-LIB-I1] `OwnableNoRenounce.renounceOwnership` override silently dropped the inherited `onlyOwner` modifier
**Severity:** Info
**File:** `contracts/src/base/OwnableNoRenounce.sol:55-57`
**Category:** side-effect
**Pass-1 ref:** DEEP-LIB-L2

**Bug:** OZ's `Ownable.renounceOwnership` is `public virtual onlyOwner`. The L2 fix that changed `pure → view` also dropped the `onlyOwner` modifier (the override has no modifier list). The function still reverts unconditionally with `RENOUNCE_DISABLED`, so the access-control change has no exploitable consequence — but anyone (not just the owner) can now invoke the function. A future subclass that overrides this further (e.g., to add the telemetry event L2 was prepared for) might inherit "callable by anyone" without realising the parent silently dropped the gate.

**Attack / Impact:** None today (function reverts unconditionally). Latent risk: a future subclass override that emits an event before the revert would log the event for ANY caller (e.g., an attacker spamming the function to flood the event stream). Trivial to exploit if the telemetry-event path ever lands; trivial to fix proactively.

**Evidence:**
```
contracts/src/base/OwnableNoRenounce.sol:55-57
55    function renounceOwnership() public view override {
56        revert("RENOUNCE_DISABLED");
57    }
```
Compare OZ `Ownable.renounceOwnership` (`access/Ownable.sol:76`): `public virtual onlyOwner`.

**Recommendation:** Re-add `onlyOwner` (compatible with `view` since `_checkOwner` is view):
```solidity
function renounceOwnership() public view override onlyOwner {
    revert("RENOUNCE_DISABLED");
}
```
Preserves OZ's contract surface and prevents the future-telemetry footgun.

---

## [v2-LIB-I2] `Toweli` constructor's `_initialMintDone` flag adds a permanent ~2100-gas cold-SLOAD per ERC-20 transfer (forever, every transfer, on first-touch)
**Severity:** Info
**File:** `contracts/src/Toweli.sol:65, 109-115`
**Category:** side-effect
**Pass-1 ref:** none (introduced by AUDIT R014 — re-audited here for cluster-wide impact)

**Bug:** The R014 immutable-supply guard reads `_initialMintDone` from storage on every `_update` call (every mint/burn/transfer), even though after the constructor returns the value is permanently `true` and the read result has no observable effect on legitimate transfers (`from != address(0)` short-circuits before reaching the require). Every cold-SLOAD costs 2100 gas (warm 100 gas); applied to every transfer of TOWELI forever. On a high-volume DEX router this is a multi-million-gas tax over the token's lifetime relative to the alternative (no override, immutable post-constructor).

The flag's only purpose is to revert future mint paths, but `ERC20._mint` is non-virtual and there's no admin function that can call it post-deploy. The defensive guard is in place for "what if a future child contract tries to mint" — but Toweli is concrete (not `abstract`) and nobody can extend it without a redeploy. The guard's marginal protection over "rely on ERC20._mint not being callable post-deploy" is approximately zero.

**Attack / Impact:** None — pure gas cost. Aggregate impact: ~2100 gas × every cold-storage-touch transfer × 1B-token lifetime → meaningful only at very high volumes. Reasonable design tradeoff per the existing R014 finding doc, but worth flagging in the cluster re-read.

**Evidence:**
```
contracts/src/Toweli.sol:109-115
109    function _update(address from, address to, uint256 value) internal override {
110        if (from == address(0)) {
111            // Mint path. Allowed exactly once, before _initialMintDone is set.
112            require(!_initialMintDone, "MINT_DISABLED");
113        }
114        super._update(from, to, value);
115    }
```
The `if (from == address(0))` short-circuits before the SLOAD on every legitimate transfer, but the cold-SLOAD still happens once (Solidity does not lazily defer storage reads inside a branch — but `_initialMintDone` is read INSIDE the `if`, so transfers DON'T pay the SLOAD). On second read of the source, this is correct: legitimate transfers (from != 0) skip the SLOAD entirely. The branch enters only on `_mint`-path attempts (which are unreachable post-construction). **So this is not a regression — the gas tax does NOT apply to normal transfers. Downgraded to info-only.**

**Recommendation:** No action required; this finding is a re-confirmation that the R014 design has zero gas cost on the hot path. Documentation could explicitly note "the SLOAD is gated behind `from == address(0)`, so legitimate transfers pay nothing" to head off the same false alarm in the next audit pass.

---

## Sibling-search re-summary (cross-cluster impact)

| Pass-1 ID | Closure | Notes |
|---|---|---|
| DEEP-LIB-H1 (zero recipient) | ✅ Closed cleanly | `ZeroRecipient` revert added to both `safeTransferETHOrWrap` and `safeTransferETH`. All 12 importers inherit the guard. Test coverage present. |
| DEEP-LIB-H2 (MemeBountyBoard duplicate sequencer logic) | ✅ Closed cleanly | `_sequencerBuffer` now delegates to `getSequencerOutageBuffer`. **Side-effect surfaced as v2-LIB-M1 + v2-LIB-M2** (underflow + missing staleness overload). |
| DEEP-LIB-H3 (lending claimDefault gap) | ⏭️ Out of scope this pass | Lives in TegridyLending/NFTLending (cluster 6 / 7). Re-audit those clusters. |
| DEEP-LIB-H4 (timelock value binding) | ✅ Closed at lint-tier | `_executeAfter` stays `internal`; `_forceCancel` + `_executeAfterOf` added. Compound-style value binding deliberately not adopted (acceptable per pass-1 recommendation option-b). |
| DEEP-LIB-M1 (contract-only owner) | ✅ Closed (opt-in) | `_ownerMustBeContract` virtual hook works. **Side-effects v2-LIB-L1 + v2-LIB-L5** (dead code + incorrect comment). No importer opts in yet — verified across all 17 callsites. |
| DEEP-LIB-M2 (bare safeTransferETH gas cap) | ✅ Closed | 10000-gas stipend mirrored. No production caller affected (only test code). **Side-effect v2-LIB-L3** (asymmetric event emission). |
| DEEP-LIB-M3 (per-consumer staleness) | ✅ Partially closed | `checkSequencerUp` and `tryCheckSequencerUp` get the overload. `getSequencerOutageBuffer` doesn't — surfaced as v2-LIB-M2. |
| DEEP-LIB-M4 (Toweli contract-only recipient) | ⏭️ Deferred per spec | DEFERRED-tagged in source per the pass-1 recommendation. Tests would break. Acceptable. |
| DEEP-LIB-M5 (TegridyFactory direct-write) | ✅ Closed cleanly | `_forceCancel(FEE_TO_CHANGE)` replaces direct write. Canonical event emits. Sibling search confirms no other contract direct-writes `_executeAfter`. |
| DEEP-LIB-M6 (consult/view soft-fail) | ✅ Closed for view path | `tryCheckSequencerUp` works. **Underflow regression surfaced as v2-LIB-M1.** Reverting `consult` paths still revert in TegridyTWAP/POL — that's intended. |
| DEEP-LIB-L1 (success event) | ✅ Closed for `safeTransferETHOrWrap` | **Asymmetric for `safeTransferETH`** — surfaced as v2-LIB-L3. |
| DEEP-LIB-L2 (renounce mutability) | ✅ Closed (`view`) | **Side-effect v2-LIB-I1** (dropped `onlyOwner`). |
| DEEP-LIB-L3 (Toweli SCW permit) | ✅ Closed | `SignatureChecker.isValidSignatureNow` works with both EOA and ERC-1271 wallets. No malleability re-introduced (tryRecover still rejects high-S). **Side-effect v2-LIB-L4** (typed-error collapse). |
| DEEP-LIB-L4 (MAX_DELAY virtual) | ✅ Closed | `_maxDelay()` virtual hook works. Test coverage present. |
| DEEP-LIB-L5 (PROPOSAL_VALIDITY virtual) | ✅ Closed | `_proposalValidity()` virtual hook works. Test coverage present. |
| DEEP-LIB-I1 (WETH balance check) | ⏭️ Documented as not-worth-the-gas | No fix applied; the pass-1 recommendation accepted deploy-time review as the practical defense. |
| DEEP-LIB-I2 (Toweli EIP-712 v1 lock) | ✅ Documented | Doc-only fix per pass-1 recommendation. NatSpec block added at lines 30-40. |

**Net assessment:** Cluster is in a much stronger state post-fix than pre-fix. Two genuine regressions worth fixing (M1 + M2). Five low/info-tier sharp edges that are easy single-line cleanups. No new High/Critical findings.

---

## Remediation priority (recommended order)

1. **v2-LIB-M1** — wrap underflow in `unchecked` for both `tryCheckSequencerUp` and `getSequencerOutageBuffer`. Restores the soft-fail promise.
2. **v2-LIB-M2** — add the `(feed, buffer, staleness)` overload to `getSequencerOutageBuffer` for symmetry.
3. **v2-LIB-I1** — re-add `onlyOwner` to `renounceOwnership` (one keyword).
4. **v2-LIB-L3** — emit `ETHTransferred` from `safeTransferETH` (one line).
5. **v2-LIB-L1 + L5** — clean up the dead `address(0)` carve-out in `_transferOwnership` and the unreachable constructor-body checks in `OwnableNoRenounce` (cosmetic; saves bytes).
6. **v2-LIB-L2** — pick one accessor between `_proposalReadyAt` and `_executeAfterOf`; deprecate the other.
7. **v2-LIB-L4** — document the typed-ECDSA-error collapse in Toweli's permit NatSpec, OR add explicit `tryRecover` pre-validation for the EOA path.

I-tier (v2-LIB-I2) is a re-confirmation, not actionable.
