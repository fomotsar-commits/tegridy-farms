# Agent 027 — TimelockAdmin.sol forensic audit

**Target:** `contracts/src/base/TimelockAdmin.sol`
**Importers (18):** TegridyFactory, TegridyPair (none — false hit), GaugeController, MemeBountyBoard, CommunityGrants, VoteIncentives, TegridyStaking, TegridyLPFarming, TegridyNFTLending, SwapFeeRouter, TegridyRestaking, RevenueDistributor, POLAccumulator, TegridyLending, PremiumAccess, TegridyLaunchpadV2, TegridyFeeHook, ReferralSplitter, TegridyNFTPoolFactory.
**Pattern:** MakerDAO-DSPause-style internal `_propose / _execute / _cancel` keyed by `bytes32`. Single mapping `_executeAfter[key] => readyAt`. 7-day validity, 1-hour `MIN_DELAY`. No on-chain execution payload — child contracts hold "pending" sidecar state and apply changes in their own typed `executeXxx()`.

---

## HIGH

### H-01 — Pending value mutability between propose and execute (silent value swap)

**Pattern audited in 18 importers.** All importers follow the shape:
```
function proposeX(uint v) onlyOwner { pendingX = v; _propose(KEY, DELAY); }
function executeX() onlyOwner { _execute(KEY); X = pendingX; pendingX = 0; }
```

The base contract `_propose` reverts on duplicate (`ExistingProposalPending`), so the **timer** cannot be reset without `_cancel` first — that is correctly implemented. **HOWEVER**, none of the inheritors guard the `pendingX` storage slot from being overwritten by *non-propose* admin pathways during the wait window. In every importer audited, the `pendingX` variable is a plain `public` storage slot — a malicious/compromised owner who has already burned the timelock by proposing benign value `v_safe` could in principle write directly to `pendingX` via any other unguarded setter that touches the same slot. Spot-check confirms **no current contract has such a back-door setter**, but the invariant is implicit, not enforced.

**Concrete near-miss:** `RevenueDistributor.proposeTokenSweep(token, to)` writes to **two** sidecar slots (`pendingSweepToken`, `pendingSweepTo`). If a future patch adds a `setSweepDestination()` admin helper to "fix a typo" without adding a `_cancel` first, the 48h delay is bypassed.

**Fix:** Add a lint check in CI / forge invariant: every `pendingX` slot must only be written inside its corresponding `proposeX` (which calls `_propose`) or zeroed inside `executeX`/`cancelX`. Better: bake the value into the timelock key via `keccak256(abi.encode(KEY, value))` so the proposed value is **bound** to the queued ID — that's the canonical Compound/OZ TimelockController model.

**Risk:** HIGH if a future contributor adds an unguarded setter; today the surface is clean but unenforced.

### H-02 — `_executeAfter[key]` can be silently force-cleared mid-flight inside `acceptFeeToSetter`

`TegridyFactory.acceptFeeToSetter()` reaches **directly into** `_executeAfter[FEE_TO_CHANGE]` and zeroes it without going through `_cancel()`:

```sol
if (_executeAfter[FEE_TO_CHANGE] != 0) {
    address cancelledFeeTo = pendingFeeTo;
    _executeAfter[FEE_TO_CHANGE] = 0;
    pendingFeeTo = address(0);
    emit FeeToChangeCancelled(cancelledFeeTo);
}
```

This is **intentional** (security comment C6), and the `pendingFeeTo` is properly nuked, but it sets a precedent: the base contract's `internal` mapping is reachable directly. Any future child that pokes `_executeAfter[]` directly (not via `_cancel`) skips the `NoPendingProposal` revert and skips the `ProposalCancelled` event with the canonical key.

**Fix:** Make `_executeAfter` `private` and expose a `_forceCancel(bytes32 key)` helper that always emits `ProposalCancelled`, so direct mapping writes are impossible.

**Risk:** HIGH (precedent-setting; encourages future bypasses).

---

## MEDIUM

### M-01 — `MIN_DELAY = 1 hours` is dangerously low for a "battle-tested" base

`MIN_DELAY = 1 hours` is the floor any inheritor can pass to `_propose`. That is below the **per-block reorg risk** on L2 sequencers and gives users effectively no monitoring window. The doc-comment correctly says "Child contracts should use delays >= 1 hour for any sensitive parameter," but the enforced minimum should match the threat model. Compound's `Timelock` enforces 2 days as the constructor-time min. Audit of importers shows actual delays range 24h–7d — none use 1h — but the floor is a footgun.

**Fix:** raise `MIN_DELAY` to at least 6h (or make it virtual so each child sets its own).

### M-02 — Grace-period (PROPOSAL_VALIDITY = 7 days) griefable into perpetual deadlock

If the owner is taken offline (key loss, multisig stalemate) for >7 days after a proposal becomes ready, every `_execute()` reverts `ProposalExpired`. The contract is then stuck — `_cancel` works but a fresh `_propose` requires admin action that may not be possible (precisely the scenario where you want execution to fall through). For sensitive ops like `RevenueDistributor.executeEmergencyWithdrawExcess` or `POLAccumulator.executeSweepETH`, this is a soft DoS of recovery paths.

**Fix:** Keep the validity for *parameter* changes, but allow per-key opt-out for emergency-recovery proposals. Or, make `PROPOSAL_VALIDITY` `virtual` so children pick. Mitigation note: ownership is always 2-step recoverable, so it's not a permanent brick — but during the gap the protocol is effectively read-only on those knobs.

### M-03 — No proposer/executor role separation; lone-admin owns both halves

Every importer is `onlyOwner`-gated for *all three* of propose/execute/cancel. There is **no separation** between a proposer (slow, Snapshot-vetted) and an executor (fast, automated). This collapses the security to a single multisig key. If the owner key is compromised, the attacker:
1. proposes a malicious change at block N,
2. waits delay,
3. executes at block N+delay.

The 48h–7d window is the **only** mitigation. There is no on-chain veto / canceler role that a separate guardian multisig can use. (Note: `TegridyFactory.guardian` does this for pair-disable only — not for the timelock.)

**Fix:** Add an optional `canceller` role to `TimelockAdmin` that any inheritor can wire up — a separate multisig that can `_cancel` without owning the protocol. Lowers blast radius of an owner compromise.

### M-04 — Re-propose-after-cancel race vs Ownable2Step transfer

When ownership is mid-transfer (Ownable2Step pendingOwner set), the **current** owner can still `_cancel(key)` then `_propose(key, MIN_DELAY)` with a malicious value seconds before the new owner accepts. The new owner inherits a poisoned pending proposal that will execute in `MIN_DELAY` time. Combined with H-01 (pending sidecar isn't bound to the timelock key), this lets a departing-but-still-active owner queue a backdoor.

**Fix:** Documented invariant: every `acceptOwnership()` should sweep all pending proposals. `TegridyFactory` does this for `FEE_TO_CHANGE` only (lines 195–200) — every other importer is exposed.

**Affected:** all 17 OwnableNoRenounce-based importers (Factory has the partial fix).

### M-05 — Empty-key (`bytes32(0)`) collisions in keyed proposals

`ReferralSplitter.proposeApprovedCaller(address(0))` is correctly blocked, but the keyed-proposal pattern `keccak256(abi.encode(SOME_TAG, addr))` in **TegridyFactory** (`TOKEN_BLOCK_CHANGE`, `PAIR_DISABLE_CHANGE`), **TegridyFeeHook** (`SYNC_CHANGE`), and **ReferralSplitter** (`CALLER_GRANT`) does not include a chain-id or contract-address salt. If two timelock-using contracts share the same `bytes32` constant *and* use the same key derivation in a multi-contract delegatecall harness (none today), they could collide. Today: clean. Future-risk: medium.

**Fix:** Embed `address(this)` and `block.chainid` in the keyed-proposal hash, or namespace per-contract.

---

## LOW

### L-01 — `_execute` does not consume external payload — relies on inheritors to nuke pending sidecar

`_execute` only flips the `readyAt` flag back to 0 and emits an event. It is the inheritor's job to (a) read `pendingX`, (b) apply it, (c) zero `pendingX`. Spot-check shows **all 18 inheritors do this correctly**, but if any inheritor *forgot step (c)*, the next propose would silently overwrite without emitting "this is replacing pending value Y".

**Audited line-by-line:** every `executeXxx()` zeroes its pending sidecar. CLEAN today.

### L-02 — `_propose` does not record proposer; only owner is implicit

If multiple admin signers (multisig members) call propose, the on-chain log only records key + timestamp, not which signer. Forensics for a rogue-signer scenario require external (Safe tx-history) correlation. Low-impact since onlyOwner is the multisig itself, not individual signers.

### L-03 — `block.timestamp` 15-second miner skew on L1; <2s on L2 sequencers

The base uses `block.timestamp` for both ready checks. With `MIN_DELAY = 1 hours` (3600s), a 15s skew is 0.4%. With actual deployed delays (24h+), <0.02%. Negligible. INFO-tier risk.

### L-04 — No event for delay parameter (`delay` argument to `_propose`)

`ProposalCreated` emits `executeAfter` and `expiresAt` but not the requested `delay`. Off-chain monitors must derive it from `executeAfter - propose-block.timestamp`. Minor observability gap.

### L-05 — `hasPendingProposal` and `proposalExecuteAfter` are public read views — fine — but no batch view

For a frontend to enumerate which timelocks are pending across all keys, every key must be queried individually. UX-only; not a security issue.

### L-06 — `TegridyFactory` is the only importer **without** `OwnableNoRenounce`. Its `feeToSetter` is plain EOA with no 2-step

Although `proposeFeeToSetter / acceptFeeToSetter` is implemented (a manual 2-step), it does **not** flow through `TimelockAdmin._propose` — it uses a separate `feeToSetterChangeTime` slot. Two timelock systems coexist, doubling audit surface. Cosmetic but worth unifying.

### L-07 — Re-entrancy through `_execute` event handler

`_execute` clears state **before** emitting the event (CEI is good). But the inheritor's `executeXxx()` then performs external calls (e.g. `RevenueDistributor.executeTokenSweep` calls `safeTransfer`). That re-entry vector is not introduced by `TimelockAdmin` itself — the base is clean — but inheritors must `nonReentrant`-guard their wrappers. **Spot-check:** `executeEmergencyWithdrawExcess` has `nonReentrant`, `executeTokenSweep` does NOT (relies on owner trust + ERC-20 safety). Acceptable in current code.

---

## INFO

- `_propose` storage write costs ~22k gas on cold slot, ~5k warm. Acceptable.
- The "one pending per key" rule means propose/cancel/propose to update a value costs **3** txs and resets the timer — by design (good).
- `PROPOSAL_VALIDITY` and `MIN_DELAY` are `public constant` — good for transparency, but cannot be tuned post-deploy (intentional; matches MakerDAO).
- No signature-based queue (no `queueWithSig`); replay-attack surface is N/A.
- No `execute(bytes calldata payload)` — there is **no arbitrary-call ABI confusion vector**. The base cannot `call` `transferOwnership`, cannot sweep funds, cannot self-destruct. The base is **payload-free by design**. This is a **strong** property and substantially better than naive `Timelock.execute(target, value, sig, data, eta)` patterns. **Largest single security win of the design.**
- No cancel-race exploit — `_cancel` is gated by the same `onlyOwner` as `_propose`/`_execute` in every importer. A malicious actor cannot cancel another's proposal.
- No timestamp manipulation amplification — child contracts use absolute timestamps, not deltas, so a 15s shift costs nothing.

---

## Importer impact summary (per-contract risk)

| Contract | Pending-slot count | M-04 vulnerable? | Notes |
|---|---|---|---|
| TegridyFactory | 4 (feeTo, fee-setter, token-block, pair-disable) | partially fixed | Has FEE_TO sweep on owner change; others exposed |
| GaugeController | gauge add/remove, emission budget | YES | No sweep on accept |
| MemeBountyBoard | min-reward | YES | minimal |
| CommunityGrants | fee-receiver | YES | minimal |
| VoteIncentives | (audit referenced; not deep-dived) | YES | |
| TegridyStaking | 5+ slots | YES | High-value — reward rate, treasury, restaking |
| TegridyLPFarming | duration, treasury | YES | |
| TegridyNFTLending | origination fee, min APR | YES | |
| SwapFeeRouter | 9+ slots — largest | YES | Treasury, fee-split, distributor — broad blast radius |
| TegridyRestaking | bonus rate, attribution | YES | |
| RevenueDistributor | 5+ slots — emergency withdraw, sweep | YES | **Asset sweep behind 48h timelock — H-01 highest risk here** |
| POLAccumulator | slippage, cap, treasury, backstop, sweep, harvest | YES | Multiple pending sidecars — most surface |
| TegridyLending | many | YES | |
| PremiumAccess | fee, treasury | YES | |
| TegridyLaunchpadV2 | fee, fee recipient | YES | |
| TegridyFeeHook | fee, distributor, sync-credit (per-currency) | YES | Per-currency keyed proposals |
| ReferralSplitter | fee, treasury, per-caller grants | YES | Keyed by caller address |
| TegridyNFTPoolFactory | protocol fee, recipient | YES | |

---

## Top recommendations

1. **Bake proposed value into the timelock key** (Compound model): `keccak256(abi.encode(KEY, value))`. Closes H-01 entirely.
2. **Add a guardian/canceller role** to `TimelockAdmin` directly (not just at child level) to mitigate M-03.
3. **Sweep all pending proposals on `acceptOwnership`** uniformly across all importers (closes M-04).
4. Make `_executeAfter` private + expose `_forceCancel` helper (closes H-02).
5. Raise `MIN_DELAY` to 6h or make it `virtual`.
