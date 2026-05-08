# Agent 32 — SwapFeeRouterAdmin Fresh-Eyes Audit

**Target:** `contracts/src/SwapFeeRouterAdmin.sol` (~431 lines)
**Related read:** `contracts/src/SwapFeeRouter.sol`, `contracts/src/base/TimelockAdmin.sol`, `contracts/src/base/OwnableNoRenounce.sol`, `contracts/script/DeploySwapFeeRouterV2.s.sol`
**Lens:** admin escalation, role inversion, timelock bypass, two-step ownership race, propose-with-bad-params, stale-proposal execute, permission delegation, centralization, fund-touching vs config functions, recipient drain via re-route, pause cascading, sweep/rescue.

## Summary

The admin contract is the most uniformly written file in the entire suite I have audited so far: every typed parameter has a propose/execute/cancel triplet, every triplet routes through `TimelockAdmin._propose / _execute / _cancel`, every external apply path is `onlyOwner` on the admin and `onlyAdmin` on the router. The library plumbing (TimelockAdmin) is hardened against zero/over-cap delays, expiration short-circuits, override-hook abuse, and direct-write bypass-of-cancel events — these were already remediated in prior batches (DEEP-LIB-H4/M5, M-Lib1, BATCH-H M30, FRESH-EYES L).

After fresh-eyes review I did **not** find a new economically-exploitable vulnerability local to this file. The only loaded observations are about (a) **two stale doc comments** that promise behaviour the router contradicts at execute-time and (b) a **governance-layout / split-brain centralization risk** where the admin contract's owner is structurally independent of the router's owner, and the timelocks favour the admin owner in a divergent-key compromise.

No new HIGH/CRITICAL findings. Two LOWs and one INFORMATIONAL recorded.

---

## F-32-1 — LOW: Misleading "Zero address allowed" comments on `proposePolAccumulator` and `proposeReferralSplitterChange`

**Severity:** LOW (footgun / operator-confusion, not directly exploitable)
**Location:** `SwapFeeRouterAdmin.sol:191-196` (`proposeReferralSplitterChange`), `SwapFeeRouterAdmin.sol:407-412` (`proposePolAccumulator`)

The propose-time entrypoints permit `_newSplitter == address(0)` and `_newAccumulator == address(0)` and explicitly comment that the zero address disables / re-routes:

```solidity
// proposeReferralSplitterChange
function proposeReferralSplitterChange(address _newSplitter) external onlyOwner {
    // address(0) allowed to disable
    pendingReferralSplitter = _newSplitter;
    _propose(REFERRAL_CHANGE, REFERRAL_CHANGE_DELAY);
    ...
}

// proposePolAccumulator
function proposePolAccumulator(address _newAccumulator) external onlyOwner {
    // Zero address allowed — re-routes POL slice to treasury without changing BPS
    pendingPolAccumulator = _newAccumulator;
    _propose(POL_ACCUMULATOR_CHANGE, POL_ACCUMULATOR_CHANGE_DELAY);
    ...
}
```

But the router-side apply functions reject `address(0)` whenever the live state still has a non-zero share / fee:

```solidity
// SwapFeeRouter.sol:1212-1223 (applyReferralSplitter)
if (_newSplitter == address(0) && old != address(0)) {
    if (IReferralSplitter(old).referralFeeBps() > 0) revert ReferralFeeNonZero();
}

// SwapFeeRouter.sol:1389-1394 (applyPolAccumulator)
function applyPolAccumulator(address _newAccumulator) external onlyAdmin {
    if (_newAccumulator == address(0) && polShareBps > 0) revert PolShareNonZero();
    ...
}
```

**Caller-visible effect:** an operator following the admin's NatSpec proposes `address(0)`, the propose call succeeds, the timelock starts. 24-48 h later the operator calls `executeXxx` and it reverts. To unblock, governance must `cancelXxx` (which works on a stuck-at-T0 proposal) and instead first execute the **prerequisite** zero-out:
- For POL: propose & execute `applyFeeSplit(staker, 0)` (48 h on its own timelock) THEN propose & execute `applyPolAccumulator(0)`.
- For Referral: zero out the splitter's `referralFeeBps` via the splitter's own timelocked path THEN unset the admin's splitter.

Both router-side checks were added by AUDIT FIX `DEEP-R-M04` and `DEEP-R3-M02`. The fixes correctly tightened the router but the admin's NatSpec was not updated to reflect the new prerequisite. This is **not exploitable** — the worst outcome is one wasted timelock cycle plus governance re-planning — but is a foot-gun that costs an operator 24-48 h of dead-time during incident response.

**Recommendation:** Update the inline comments on both propose entries to read e.g. "Zero address allowed only when the existing live `polShareBps == 0`; otherwise execute will revert with `PolShareNonZero` — propose `applyFeeSplit(staker, 0)` first and execute that change before proposing `address(0)` here." A non-functional doc fix; no storage layout impact, no ABI surface change.

## F-32-2 — LOW: Admin contract owner is structurally independent of router owner; 48 h treasury rotation outpaces 7 d admin-replacement window in a divergent-key compromise

**Severity:** LOW (governance layout risk, requires divergent-ownership operating model)
**Location:** `SwapFeeRouterAdmin.sol:47, 133-136, 165-188` (treasury triplet); `SwapFeeRouter.sol:1043-1132` (`onlyAdmin` modifier + admin-replacement triplet)

`SwapFeeRouterAdmin` has its own `Ownable2Step` ownership (inherited via `OwnableNoRenounce`) that is separate from the router's. The router only checks `msg.sender == swapFeeRouterAdmin` (an address-identity check, NOT an ownership check):

```solidity
// SwapFeeRouter.sol:1043-1046
modifier onlyAdmin() {
    if (msg.sender != swapFeeRouterAdmin) revert Unauthorized();
    _;
}
```

This means the **admin contract's owner is the de-facto controller of every router parameter** — fee, treasury, referral splitter, per-input-token fee, premium discount, premium access, revenue distributor, fee-split, POL accumulator. The router's owner has only:
1. `pause()` / `unpause()` (immediate but reversible)
2. `sweepETH()` / `withdrawTokenFees()` / `sweepTokens()` (subject to current `treasury` recipient — see flow below)
3. `setSwapFeeRouterAdmin()` (one-shot — usable only when no admin is wired)
4. `proposeAdminReplacement` → `executeAdminReplacement` (**7-day timelock**)
5. `proposeResetTWAPSnapshot` (7-day timelock, narrow scope)

Compare to the admin's parameter timelocks: 24 h (fee, premium discount, per-token fee) and **48 h** (treasury, referral splitter, premium access, revenue distributor, fee-split, POL accumulator).

**Race window:** if `admin.owner` is compromised independently of `router.owner`, the attacker:
1. `proposeTreasuryChange(attacker_eoa)` → 48 h timelock starts.
2. The router's owner sees the on-chain event and calls `proposeAdminReplacement(new_admin)` → **7-day timelock starts**.
3. At T+48h the attacker calls `executeTreasuryChange()` → router's `treasury = attacker_eoa`.
4. Attacker (or any anyone, since `distributeFeesToStakers` is permissionless) calls `distributeFeesToStakers()` → 50%+ of accumulated ETH flows to the new attacker treasury.
5. `withdrawTokenFees(token)` is `onlyOwner` on the router (so only `router.owner` can fire it) — **but** the new treasury slot still routes accumulated TOKEN fees to the attacker once the router owner makes any honest call.
6. By T+7d the router owner can swap admin contracts, but the attacker has had a full 5 days to drain.

**Crucially, the router's owner has NO permission to cancel admin-side proposals.** `cancelTreasuryChange()` is `onlyOwner` on the **admin** contract — the router-owner multisig cannot abort the in-flight 48 h timelock from the router side. Their only defensive levers are:
- `pause()` — stops new fees accumulating, but does **not** stop `distributeFeesToStakers()` from flushing the existing `accumulatedETHFees` (it has `whenNotPaused`, but the attacker can simply trigger it BEFORE the pause lands).
- `proposeAdminReplacement` — 7 d > 48 h, loses the race.

**Why this is LOW (not HIGH):**
- Standard deploy script `DeploySwapFeeRouterV2.s.sol:54-58` transfers BOTH ownerships to the **same** multisig:
  ```solidity
  if (multisig != address(0)) {
      sfr.transferOwnership(multisig);
      sfrAdmin.transferOwnership(multisig);
  }
  ```
  When ownerships are merged, a divergent-key compromise is structurally impossible — a multisig compromise is single-point and the router-owner powers are also lost simultaneously.
- The risk only materializes if a future operator decides to delegate admin-owner to a "guardian / parameter committee" while keeping router-owner on the cold multisig (or vice versa). This is a foot-gun that the codebase passively allows.
- The split is intentional in the original design: admin holds parameter timelocks, router holds emergency levers. The asymmetric timelocks are the bug — admin parameter delays should exceed the admin-replacement timelock if the two ownerships are ever expected to diverge.

**Mitigation options:**
1. **Doc-only:** Add an explicit operational warning to `SwapFeeRouterAdmin.sol` and the deploy script reading "ownerships of `SwapFeeRouter` and `SwapFeeRouterAdmin` MUST be held by the same multisig; divergent ownership permits a 48 h treasury-rotation drain before the 7 d admin-replacement window closes."
2. **Structural:** Add a router-owner-callable `freezeAdminProposals()` lever that pauses `_execute` on the admin contract (would require admin ↔ router back-reference). Heavier change but converts the LOW into a no-op.
3. **Timelock raise:** Increase `TREASURY_CHANGE_DELAY` (and `REV_DIST_CHANGE_DELAY`, `FEE_SPLIT_CHANGE_DELAY`, `POL_ACCUMULATOR_CHANGE_DELAY`, `PREMIUM_ACCESS_CHANGE_DELAY`) to **at least 7 days + ε** so any admin-side recipient/reroute change is always slower than the router's admin-swap path. This is the cheapest structural fix and doesn't require new code paths.

I recommend Option 1 immediately and Option 3 in the next size-budget revision.

## F-32-3 — INFORMATIONAL: Stale `pendingXxx` storage slots persist after proposal expiration; require explicit cancel before re-propose

**Severity:** INFO (operational, not exploitable)
**Location:** `SwapFeeRouterAdmin.sol` (every executeXxx); `TimelockAdmin.sol:149-161` (`_execute` clears `_executeAfter[key]` only on success)

When a proposal expires (i.e., is not executed within `_proposalValidity() = 7 days` after `readyAt`):
- `_executeAfter[key]` remains non-zero (only `_execute` and `_cancel` zero it).
- `pendingXxx` storage slots remain populated with the stale-but-now-unenforceable values.

Side effects:
1. `proposeXxx` reverts with `ExistingProposalPending(key)` because `_executeAfter[key] != 0`.
2. `executeXxx` reverts with `ProposalExpired(key)` because `block.timestamp > readyAt + validity`.
3. **Recovery requires an explicit `cancelXxx` call** which works because `_cancel` only checks `_executeAfter[key] != 0` (does not check expiration). After cancel, `pendingXxx` slots are zeroed and a fresh propose can land.

This is by-design but **non-obvious to a new operator** who reads the propose function and assumes the proposal "auto-expires." During incident response, an operator who sees a stale proposal blocking their re-propose may not realize they have to call cancel first.

The stale `pendingXxx` slot itself is benign: it's never read by any path other than `executeXxx` (which short-circuits on expiration). So the stale data does not leak into router state.

**No code change recommended.** Optionally add NatSpec on `proposeXxx` reading "if a previous proposal expired without being executed, call `cancelXxx` first to clear the stale state before re-proposing."

---

## Notes / Dead-ends (no findings)

- **Two-step ownership transfer race:** `Ownable2Step` lets the OLD owner retain full power until `acceptOwnership()` is called by the new owner. So during the transfer pendency window OLD owner can `proposeFeeChange(MAX)` (24 h timelock). New owner inherits the pending proposal on accept and can immediately `cancelFeeChange()`. No drain window, just hand-off hygiene. Not a finding.
- **Per-input-token fee CRITICAL pattern:** `proposeInputTokenFeeChange` rejects `inputToken == address(0)` and caps `newFeeBps <= MAX_FEE_BPS` (when `removal == false`). Removal path bypasses the cap correctly (deletes the override entirely on the router side, falling back to `feeBps`). Both legacy `proposePairFee*` aliases hard-revert with `DeprecatedUseInputTokenFee` (per SFR-M-03), preserving ABI but blocking silent regression.
- **Reentrancy on execute:** every `executeXxx` clears its `pendingXxx` slot **before** calling `router.applyXxx(...)`. Storage-then-effects-then-interaction (CEI). The router-side apply functions only set state and emit events (no external calls), so re-entry into `_execute` would `_executeAfter[key] == 0 → NoPendingProposal`. Even if a malicious router could re-enter, the proposal is single-shot. Not a finding.
- **Stale proposal after admin replacement:** `proposeAdminReplacement → executeAdminReplacement` swaps the wired admin contract. The OLD admin's `_executeAfter` and `pendingXxx` slots persist in storage on the OLD admin instance, but the OLD admin is no longer the router's `swapFeeRouterAdmin`, so any execute attempt on the OLD admin's `applyXxx` paths reverts via the router's `onlyAdmin` modifier. The new admin starts with an empty pending state. Not a finding.
- **Validity-window expiry on admin replacement:** `executeAdminReplacement` enforces `block.timestamp <= readyAt + 7 days` (DEEP-R-M01 fix). Mirrors the lib's `PROPOSAL_VALIDITY` semantics. Stale admin proposals cannot lurk indefinitely. Not a finding.
- **Sweep / rescue functions:** the admin contract has **none** — sweep paths live exclusively on the router (`sweepETH`, `withdrawTokenFees`, `sweepTokens`) gated by the router's `onlyOwner`. The admin owner cannot drain ERC20s mistakenly sent to either contract. Good.
- **Pause cascading:** the admin contract is **not** Pausable. Propose/execute/cancel are not gated by `whenNotPaused`. This is intentional — the owner needs the ability to mutate parameters during a paused-router incident (e.g., zero the fee and propose a recovery treasury). Not a finding.
- **Permission delegation to module:** the admin does not delegate any of its `onlyOwner` flows; every triplet is direct. No module-escalation surface.
- **Bad-params propose (overflow, zero):** every typed propose validates type-specific bounds before storing pending state — `feeChange ≤ MAX_FEE_BPS`, `treasury != address(0)`, `discount ≤ MAX_PREMIUM_DISCOUNT_BPS`, `staker ≥ MIN_STAKER_SHARE_BPS`, `pol ≤ MAX_POL_SHARE_BPS`, sum check. The two zero-allowed paths (referral, POL accumulator) are validated downstream at execute-time on the router (see F-32-1).
- **Stale proposal re-execute by re-create with same id:** the lib uses `bytes32 key` constants — keys are not re-creatable in a way that would let `_execute` see an old proposal. Each propose re-writes `_executeAfter[KEY] = block.timestamp + delay` and zeros happen on success/cancel; an "id collision" is not a primitive in this design.
- **Admin contract `transferOwnership` to contract-only check:** `OwnableNoRenounce._ownerMustBeContract()` defaults to `false` — the admin allows EOA ownership. Not a finding (deploy script overrides via multisig transfer; matches every other Tegriddy admin contract). A potential hardening would be an opt-in override to `_ownerMustBeContract() = true` after deploy script's multisig handover, but this is out of scope for this audit.
- **Router-side `setSwapFeeRouterAdmin` bypass:** one-shot only when `swapFeeRouterAdmin == address(0)`. Subsequent rotation must go through `proposeAdminReplacement → executeAdminReplacement`. Closes the SFR-M-04 single-point-of-rotation issue. Not a finding.
- **Emergency-cancel by router owner:** confirmed not possible — see F-32-2 above.

---

## Aggregate

| Severity | Count |
|----------|-------|
| CRITICAL | 0 |
| HIGH     | 0 |
| MEDIUM   | 0 |
| LOW      | 2 |
| INFO     | 1 |

Net: this admin contract is a thin, well-disciplined wrapper around `TimelockAdmin`. The two LOWs (F-32-1 doc drift, F-32-2 governance-layout asymmetry) are operational hygiene issues; neither is exploitable under the documented ownership-merged deployment shape. F-32-3 is a property of the lib that should be operationally documented but is not a code defect.
