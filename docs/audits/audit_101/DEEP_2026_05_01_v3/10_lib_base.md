# DEEP audit (PASS 3) — `contracts/src/{base,lib,Toweli}.sol` cluster

**Date:** 2026-05-02 (post-`7ed7939` v2-fix sweep)
**Scope:** TimelockAdmin, OwnableNoRenounce, SequencerCheck, WETHFallbackLib, Toweli — 5 files
**Method:** Re-read post-v2 source; verified each v2 finding closure in commit `7ed7939`; re-ran `Deep_LibBase_2026_05_01.t.sol` (all 24 pass); wrote disposable harness tests to validate the v2 hot-spots specified in the prompt (clock-skew, staleness param, permit typed-error, accessor duplication, ETH event symmetry).

**Compile:** `forge build --use 0.8.26` clean.
**Existing v2 tests:** 24 / 24 pass.

---

## Headline tally

- **Critical:** 0
- **High:** 0
- **Medium:** 1
- **Low:** 2
- **Info:** 1

The v2 fixes hold up cleanly. One genuine regression in pass-2's "clock-skew guard" closure (only the soft-fail siblings got the underflow guard — the reverting variant still panics, breaking typed-revert symmetry). Two micro side-effects + one info-tier dead-code observation surfaced during the deep re-read. No new highs/criticals.

---

## [v3-LIB-M1] Reverting `checkSequencerUp` panics with `Panic(0x11)` on future-dated `updatedAt` / `startedAt` — typed-revert symmetry of v2-LIB-M1 fix is incomplete
**Severity:** Medium
**File:** `contracts/src/lib/SequencerCheck.sol:135, 147`
**Pass-2 ref:** v2-LIB-M1

**Bug:** The pass-2 fix (v2-LIB-M1) added `if (updatedAt > block.timestamp) return (false, TRY_CLOCK_SKEW)` and `if (startedAt > block.timestamp) return (false, TRY_CLOCK_SKEW)` directional guards to **only** the soft-fail siblings (`tryCheckSequencerUp` lines 195/202 and `getSequencerOutageBuffer` lines 270/277). The reverting `checkSequencerUp` overload (lines 135/147) was deliberately left alone with the rationale "its contract is 'revert on anomaly' anyway" (v2 spec §M1 closing recommendation). That rationale is correct in spirit but **wrong in side-effect detail**: a `Panic(0x11)` (0x4e487b71 + 0x11 right-padded) is structurally NOT the same as a typed `SequencerDown()` revert (selector `0x86fd6b3e`).

Off-chain decoders that switch on the typed selector won't recognise the panic; wagmi/ethers/viem surface panics with a different error class (`PanicError` vs `ContractFunctionRevertedError`), which downstream UI / monitoring code branches on differently. The lib's own NatSpec at line 49 promises `SequencerDown` as the revert type for sequencer-down conditions; clock-skew tripping a panic instead violates that contract.

Empirically reproduced: a feed posting `updatedAt = block.timestamp + 1` (sub-second clock skew commonly observed on Arbitrum/Base after sequencer replay, or on bridged Chainlink relays that round timestamps up) panics in `checkSequencerUp` while `tryCheckSequencerUp` correctly returns `(false, TRY_CLOCK_SKEW)`.

**Attack / Impact:** During a sequencer-resume event with sub-second clock skew, every WRITE-path consumer (TegridyTWAP.consult-on-write paths, POLAccumulator.accumulate, TegridyLending.acceptOffer valuation, TegridyDropV2 dutch-price) reverts with `Panic(0x11)` rather than typed `SequencerDown`. Off-chain monitoring dashboards subscribed to `SequencerDown` selector traces will silently miss the event class, alarm the wrong way (panic = "system bug" in many decoder libs), and forensics that branch on revert-data type fall through. Also confuses the v2-LIB-M1 fix story — same input class produces typed revert on the soft-fail path and untyped panic on the reverting path.

**Evidence:**
```
contracts/src/lib/SequencerCheck.sol:135
135        if (block.timestamp - updatedAt > staleness) revert SequencerDown(); // keeper lapse
...
contracts/src/lib/SequencerCheck.sol:147
147        if (block.timestamp - startedAt < gracePeriod) {
148            revert SequencerGracePeriodNotOver();
149        }
```
Both subtractions use checked-math semantics. The pass-2 fix patched the same arithmetic shape on lines 197/204 (`tryCheckSequencerUp`) and lines 272/279 (`getSequencerOutageBuffer`) but left lines 135/147 unguarded.

Reproduced with a 5-line forge test:
```solidity
// updatedAt = block.timestamp + 1 (sub-second relay skew)
feed.set(0, block.timestamp - 2 hours, block.timestamp + 1);
SequencerCheck.checkSequencerUp(address(feed), 1 hours);
// → reverts with Panic(0x11), NOT SequencerDown()
```

**Recommendation:** Mirror the pass-2 directional guards on the reverting overload so the typed revert surface is symmetric across all three helpers:
```solidity
function checkSequencerUp(address feed, uint256 gracePeriod, uint256 staleness) internal view {
    ...
    if (updatedAt > block.timestamp) revert SequencerDown(); // clock skew → fail-closed
    unchecked {
        if (block.timestamp - updatedAt > staleness) revert SequencerDown();
    }
    ...
    if (startedAt > block.timestamp) revert SequencerGracePeriodNotOver(); // clock skew on grace
    unchecked {
        if (block.timestamp - startedAt < gracePeriod) {
            revert SequencerGracePeriodNotOver();
        }
    }
}
```
Same pattern as `tryCheckSequencerUp` lines 195-205 — restores typed-revert parity. Adds one branch + `unchecked` per overload. Add a unit test: `feed.updatedAt = block.timestamp + 1; vm.expectRevert(SequencerCheck.SequencerDown.selector); harness.check(feed, 1 hours);`.

The same fix should apply to `getResumeTimestamp` line 317 (`block.timestamp - updatedAt > MAX_FEED_STALENESS`) — though that helper returns 0 instead of reverting on stale, the underflow would still propagate to its callers as a panic.

---

## [v3-LIB-L1] `Toweli.permit` override drops `virtual` — locks all future subclasses to this exact permit logic
**Severity:** Low
**File:** `contracts/src/Toweli.sol:150`
**Pass-2 ref:** v2-LIB-L4

**Bug:** OZ's `ERC20Permit.permit` is declared `public virtual`, allowing further overrides. The Toweli override at line 150 is `public override` — the `virtual` keyword was dropped. Today Toweli is the leaf class (concrete, deployed once), so this has zero runtime impact. **But** Toweli's own NatSpec (lines 24-27) explicitly anticipates derivatives: "future Toweli derivative (rebases, fork-deployments, multi-chain bridge wrappers, v2 contracts) MUST keep `version = 1`..." A future v2 wrapper inheriting from Toweli to keep the EIP-712 domain compatible (a stated design goal) would now be unable to override `permit` — the entire v2-LIB-L4 typed-error logic would be inheritance-frozen.

This is a pure forward-compat tightening that the v2 fix didn't anticipate. The bigger lib-level concern — every other override-able ERC20Permit fork in the OZ ecosystem (USDC v2.2, DAI permit, etc.) keeps `virtual` — confirms this is a deviation from the canonical pattern.

**Attack / Impact:** None today. Forward-compat regression: a Toweli v2 contract or derivative cannot extend the permit logic (e.g. add a custom signature scheme, replay-protection layer, or 7702-aware path) without dropping the v2-LIB-L4 typed-error forwarding entirely.

**Evidence:**
```
contracts/src/Toweli.sol:142-150
142    function permit(
143        address owner,
...
150    ) public override {
```
Compare OZ `ERC20Permit.permit` (`token/ERC20/extensions/ERC20Permit.sol:50`): `public virtual`.

**Recommendation:** Add `virtual`:
```solidity
function permit(...) public virtual override {
```
One keyword. Preserves the OZ override surface for future derivatives.

---

## [v3-LIB-L2] `Toweli.permit` performs ECDSA recovery TWICE on the SCW path — gas regression vs OZ stock for ERC-1271 wallets
**Severity:** Low
**File:** `contracts/src/Toweli.sol:179-192`
**Pass-2 ref:** v2-LIB-L4

**Bug:** The v2-LIB-L4 fix prepends `ECDSA.tryRecover(hash, v, r, s)` to the permit logic to capture the typed ECDSA error before falling through to `SignatureChecker.isValidSignatureNow`. For an EOA owner, this is fine — the `tryRecover` IS the validation. But for a **smart contract wallet (SCW) owner** (the entire reason the v2 fix wrapped `SignatureChecker` in the first place), the path becomes:

1. `ECDSA.tryRecover(hash, v, r, s)` — full secp256k1 verification (~3000 gas) — result discarded since recovered ≠ contract owner address.
2. `SignatureChecker.isValidSignatureNow(owner, hash, sig)` — sees `owner.code.length > 0`, dispatches to `isValidERC1271SignatureNow` — staticcall to owner's `isValidSignature` — separate verification path inside the contract wallet.

The first ECDSA call is **wasted work** for every SCW permit. OZ's stock permit doesn't have this overhead because it's reverting-only; the v2 fix added it for the typed-error surface but didn't conditionally skip when the owner is a contract.

**Attack / Impact:** ~3000 gas tax per SCW permit call. Over Toweli's lifetime on a high-volume DEX integration, this is a meaningful aggregate cost. Not exploitable; pure efficiency regression that scales with SCW adoption (4337 wallets, Safe permit relays, etc.).

**Evidence:**
```
contracts/src/Toweli.sol:179-192
179        (address recovered, ECDSA.RecoverError ecdsaErr, bytes32 ecdsaErrArg) =
180            ECDSA.tryRecover(hash, v, r, s);
181        if (ecdsaErr == ECDSA.RecoverError.NoError && recovered == owner) {
182            // EOA fast path
...
192        if (!SignatureChecker.isValidSignatureNow(owner, hash, abi.encodePacked(r, s, v))) {
```
For `owner.code.length > 0`, the SignatureChecker call ignores the recovered EOA entirely — but the recovery already paid the gas.

**Recommendation:** Conditionally skip the ECDSA pre-validation when the owner is a contract:
```solidity
if (owner.code.length == 0) {
    (address recovered, ECDSA.RecoverError ecdsaErr, bytes32 ecdsaErrArg) =
        ECDSA.tryRecover(hash, v, r, s);
    if (ecdsaErr == ECDSA.RecoverError.NoError && recovered == owner) {
        _approve(owner, spender, value);
        return;
    }
    // EOA path failed → surface typed errors directly.
    if (ecdsaErr == ECDSA.RecoverError.InvalidSignatureS) revert ECDSA.ECDSAInvalidSignatureS(ecdsaErrArg);
    if (ecdsaErr == ECDSA.RecoverError.InvalidSignature)  revert ECDSA.ECDSAInvalidSignature();
    revert ERC2612InvalidSigner(recovered, owner);
}
// Contract owner — go straight to ERC-1271.
if (!SignatureChecker.isValidSignatureNow(owner, hash, abi.encodePacked(r, s, v))) {
    revert ERC2612InvalidSigner(address(0), owner);
}
_approve(owner, spender, value);
```
Saves ~3000 gas per SCW call. Note: also removes the dead `InvalidSignatureLength` branch on line 200 — that error is impossible from the `(v, r, s)` overload (only the `bytes` overload returns it; see OZ `ECDSA.sol:78`). Keeping it in is harmless but misleading audit-trail noise.

---

## [v3-LIB-I1] `_proposalReadyAt` and `_executeAfterOf` are still both present — v2-LIB-L2 documented but didn't deprecate
**Severity:** Info
**File:** `contracts/src/base/TimelockAdmin.sol:187, 200`
**Pass-2 ref:** v2-LIB-L2

**Bug:** The pass-2 fix updated the NatSpec to declare `_executeAfterOf` as canonical and `_proposalReadyAt` as a "back-compat alias", but kept BOTH functions with identical bodies. Three importers still call `_proposalReadyAt` (`CommunityGrants:658,711`, `TegridyFeeHook:331`, `TegridyTWAP:546,575`). The duplication is documented now (good) but the actual structural drift remains — a future refactor that demotes `_executeAfter` to `private` MUST update both accessors, and a future contributor inheriting from TimelockAdmin will encounter both names with no compile-time signal which is preferred.

**Attack / Impact:** None — pure code-clarity / future-maintainability concern. Both accessors return identical values. Already noted in v2 as "code-smell only"; re-confirmed here as not yet acted upon.

**Evidence:**
```
contracts/src/base/TimelockAdmin.sol:187-202
187    function _proposalReadyAt(bytes32 key) internal view returns (uint256) {
188        return _executeAfter[key];
189    }
...
200    function _executeAfterOf(bytes32 key) internal view returns (uint256) {
201        return _executeAfter[key];
202    }
```
Three downstream importers still on `_proposalReadyAt`; zero on `_executeAfterOf` (the canonical one). The "preferred" accessor has zero callers.

**Recommendation:** Two acceptable closures:
1. **Mass-migrate the three importers** to `_executeAfterOf` and delete `_proposalReadyAt`. Three single-token edits + one base lib delete. Clean state.
2. **Accept the divergence** by removing `_executeAfterOf` (since it has no callers) and pinning `_proposalReadyAt` as canonical. Removes the "two accessors" question entirely.

The current state ("two accessors, one is documented preferred but unused") is the worst of both — pick one.

---

## Pass-2 verification summary

| v2 ID | Verified closure | Notes |
|---|---|---|
| v2-LIB-M1 (clock-skew on soft-fail helpers) | ✅ Closed for `tryCheckSequencerUp` + `getSequencerOutageBuffer` | **Side-effect surfaced as v3-LIB-M1**: reverting `checkSequencerUp` still panics on same input class. Symmetry break. |
| v2-LIB-M2 (per-call staleness on `getSequencerOutageBuffer`) | ✅ Closed cleanly | Three-arg overload added; default 24h preserved; consistent with `checkSequencerUp` / `tryCheckSequencerUp` API surface. No regressions. |
| v2-LIB-L1 (dead address(0) carve-out in `_transferOwnership`) | ✅ Closed cleanly | Carve-out removed; comment corrected; tests pass. |
| v2-LIB-L2 (`_proposalReadyAt` vs `_executeAfterOf`) | ⚠️ Partial — documented but not deprecated | **Re-surfaced as v3-LIB-I1.** No runtime impact; future-maintainability concern. |
| v2-LIB-L3 (bare `safeTransferETH` emits `ETHTransferred`) | ✅ Closed cleanly | Event emitted on success path; symmetric with `safeTransferETHOrWrap`. Existing `Audit195_Bounty.t.sol` test already accepts both event types. |
| v2-LIB-L4 (Toweli permit typed-error forwarding) | ✅ Closed for typed errors | **Side-effects v3-LIB-L1 + v3-LIB-L2**: dropped `virtual` keyword and SCW-path gas regression. Verified malleable-S signatures correctly forward `ECDSAInvalidSignatureS` (test passes). |
| v2-LIB-L5 (unreachable constructor checks in `OwnableNoRenounce`) | ✅ Closed cleanly | Body checks dropped; comment explains why. |
| v2-LIB-I1 (`onlyOwner` on `renounceOwnership`) | ✅ Closed cleanly | Modifier re-added; behaviour unchanged (still reverts unconditionally). |
| v2-LIB-I2 (Toweli EIP-712 v1 lock) | ✅ Documented | NatSpec block at lines 37-47 explicit; no code change needed. |

**Test coverage:** All 24 existing `Deep_LibBase_2026_05_01.t.sol` tests pass. v3-LIB-M1 reproducible with a 5-line forge harness (panic on `updatedAt = block.timestamp + 1`).

---

## Remediation priority (recommended order)

1. **v3-LIB-M1** — mirror the directional clock-skew guards on the reverting `checkSequencerUp` (and `getResumeTimestamp` line 317) to restore typed-revert parity. ~6 lines + 1 test. Closes the highest-leverage symmetry break.
2. **v3-LIB-L1** — add `virtual` to `Toweli.permit`. One keyword. Preserves derivative override surface.
3. **v3-LIB-L2** — gate the `ECDSA.tryRecover` pre-validation behind `owner.code.length == 0` so SCWs don't pay the wasted ~3000 gas per call.
4. **v3-LIB-I1** — pick one accessor (`_executeAfterOf` or `_proposalReadyAt`) and migrate / delete the other. Optional cosmetic cleanup.

**Net assessment:** Cluster is in a strong state; the v2 fixes hold up under pass-3 scrutiny. The single Medium is a clean follow-on of v2-LIB-M1 (symmetry completion). Two lows are forward-compat hardening on the Toweli permit path. Info is a pre-existing v2 dual-accessor that didn't get cleaned up. **No new High/Critical findings.**
