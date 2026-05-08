# Agent 38 — VoteIncentivesAdmin.sol (admin escalation surface for VoteIncentives)

Scope file: `contracts/src/VoteIncentivesAdmin.sol` (208 LOC)
Sister contract: `contracts/src/VoteIncentives.sol` (1789 LOC)
Base: `contracts/src/base/TimelockAdmin.sol`, `contracts/src/base/OwnableNoRenounce.sol`

Lens applied:
- Setter for gauge controller: not in admin (lives on VoteIncentives, one-shot `setGaugeController`).
- Whitelist add/remove (24h timelock).
- Min-bribe param manipulation (24h timelock).
- Emergency withdraw / sweep — not in admin (lives on VoteIncentives `sweepExcessETH` / `sweepToken`).
- Pause / claim window timing manipulation.
- Captured-owner monetization paths.
- Race vs timelock; cancel-and-replace.
- Permissionless `executeEnableCommitReveal` corner.

---

## F-38-1 — Pause is held by EOA owner, not the timelock admin (governance/operational)

Severity: Informational (design choice — already battle-tested pattern, but worth surfacing).

`VoteIncentivesAdmin` only fans out `apply*` mutators behind `TimelockAdmin._propose / _execute / _cancel`. It does NOT route the `pause()` / `unpause()` calls — those still live on `VoteIncentives` directly under `onlyOwner` (lines 1127-1128 of `VoteIncentives.sol`).

Consequence: a captured EOA owner of `VoteIncentives` can:
1. `pause()` the contract instantly.
2. While paused, every voter-facing path is dead: `vote`, `commitVote`, `revealVote`, `claimBribes`, `claimBribesBatch`, `depositBribe`, `depositBribeETH`, `advanceEpoch`, `sweepForfeitedBond`, `refundOrphanedBribe` (NOT actually paused — see below), `refundUnvotedBribe` (NOT paused), `refundSubQuorumBribe` (NOT paused).
3. The captured owner cannot drain bribes — `sweepExcessETH` / `sweepToken` are reserved against `totalUnclaimedBribes`, `totalUnclaimedETHBribes`, `totalPendingETH`, `totalPendingTokens`, plus `totalCommitBonds` for TOWELI — so active bribes are protected.
4. BUT the `claimBribes` / `claimBribesBatch` paths are gated `whenNotPaused`. Bribers and voters cannot claim until unpause. Voters who time-locked their stake into a particular epoch lose the entire claim window if pause persists past `revealDeadline + UNVOTED_REFUND_GRACE`.
5. Counterweight: the recovery paths `refundOrphanedBribe`, `refundUnvotedBribe`, `refundSubQuorumBribe` are NOT gated `whenNotPaused`, so original depositors can still pull their bonds back even while paused.

Net effect of indefinite pause:
- Voters (NOT depositors) cannot claim bribes for active pools while paused. There is no permissionless "claim while paused" escape hatch.
- The voter-side bribe is essentially held hostage until owner unpauses or the user gives up and forfeits.
- A 7-day claim window after `voteEnd` exists by virtue of the pool still being claimable when unpaused — but if the pause spans the whole `MAX_CLAIM_EPOCHS = 500` retention horizon, those bribes effectively go to whichever owner eventually unpauses (and those late claims will then race a possible re-pause).

Not exploitable by the current owner (Tegriddy multisig per project memos), but documenting as a captured-owner attack surface. The `pause` should probably be timelocked to `VoteIncentivesAdmin` symmetric to other apply-* setters, OR a separate `pauseGuardian` role should be cleanly split from `pause` so `unpause` can be permissionless after a `MAX_PAUSE_DURATION`. Pattern of record: Aave V3 `EmergencyAdmin` + cap.

Code refs:
- `VoteIncentives.sol:768` (`claimBribes ... whenNotPaused`)
- `VoteIncentives.sol:894` (`claimBribesBatch ... whenNotPaused`)
- `VoteIncentives.sol:1127-1128` (pause/unpause owner-gated, untimelocked)
- `VoteIncentives.sol:1180` (`refundOrphanedBribe` — NOT `whenNotPaused`, escape hatch holds)

Note: dead-end on "drain bribes via pause" because reserves protect the bribe pools. Worth flagging strictly because a pause is the only ungated owner power that touches voter funds.

---

## F-38-2 — `executeEnableCommitReveal` is permissionless; cancel-and-replace race is benign but worth noting

Severity: Informational (intentional design, not a bug — but interaction with `cancelEnableCommitReveal` is asymmetric).

`VoteIncentivesAdmin.executeEnableCommitReveal()` (line 201) is intentionally NOT `onlyOwner`, mirroring the pre-split semantic where any party could fire the timelocked enable once the 24h delay had elapsed. Comment on line 196-200 documents the rationale.

Race scenarios I tested:
1. Owner proposes (T0) → 24h elapses (T0+24h). At T0+24h, two competing transactions land in the same block:
   - Tx A: `executeEnableCommitReveal()` (anyone)
   - Tx B: `cancelEnableCommitReveal()` (owner only)
   - Whichever lands first wins. If A wins, the flag is flipped permanently (forward-only — `applyEnableCommitReveal` has `if (commitRevealEnabled) return;` idempotency on `VoteIncentives.sol:1772`).
   - If B wins, the proposal is cleared; owner must propose again and wait another 24h.
2. The asymmetry: an owner trying to BACK OUT after the 24h elapsed must outrun any other party. In a hostile relay, anyone monitoring the timelock can land `executeEnableCommitReveal` before the owner's `cancelEnableCommitReveal` and lock in the flag.
3. Documented intent: `comment line 184-186` explicitly says "One-way switch: once enabled there is no path to disable... flipping back would let an attacker race the toggle." So the asymmetry IS the design.

Not exploitable. Not even a meaningful race — the flag transition increases security (commit-reveal closes see-bribes-then-vote arbitrage). Documenting because the lens called for race-vs-timelock investigation.

Code refs:
- `VoteIncentivesAdmin.sol:201-204` (permissionless execute)
- `VoteIncentivesAdmin.sol:192-195` (owner-only cancel)
- `VoteIncentives.sol:1771-1775` (idempotent apply)

---

## F-38-3 — `proposeEnableCommitReveal` silently no-ops when already enabled, suppressing audit signal

Severity: Low (observability / monitor evasion).

```solidity
function proposeEnableCommitReveal() external onlyOwner {
    if (voteIncentives.commitRevealEnabled()) return; // idempotent
    _propose(COMMIT_REVEAL_ENABLE, COMMIT_REVEAL_ENABLE_DELAY);
    emit EnableCommitRevealProposed(_executeAfter[COMMIT_REVEAL_ENABLE]);
}
```

If a captured owner is fishing for off-chain monitor coverage gaps, calling `proposeEnableCommitReveal()` AFTER the flag is already `true` produces:
- Tx success.
- No revert.
- No `EnableCommitRevealProposed` event emitted (returns before emit).
- No `ProposalCreated` event from `_propose`.
- `_executeAfter[COMMIT_REVEAL_ENABLE]` is unchanged.

This is a benign no-op for the protocol but a useful "did the captured owner test their access?" probe surface. A defensive logger event (`AlreadyEnabled` or `ProposeNoOp`) would surface the probe to off-chain alerting. This is a deeply minor finding — flagging because the lens called out captured-owner monetization paths and this is a probe that doesn't pay anything but is useful intel for an attacker.

Counterargument: every `if-condition return` in the codebase has the same property; not unique to this function. Not worth fixing standalone.

Code ref: `VoteIncentivesAdmin.sol:187-191`

---

## F-38-4 — Lockout-via-DelayTooLong is bounded by `MAX_DELAY = 30 days` (already mitigated)

Severity: N/A (already mitigated upstream — verifying).

The lens called out "race vs timelock: cancel-and-replace." Considered the inverse: a captured owner spamming `propose*` with `delay = type(uint256).max` to lock the admin surface. `TimelockAdmin._propose` at line 139 enforces `if (delay > maxD) revert DelayTooLong(delay, maxD);` and `_maxDelay()` returns `MAX_DELAY = 30 days`.

But: `VoteIncentivesAdmin` calls `_propose(KEY, FEE_CHANGE_DELAY)` etc. with hardcoded constants (24h / 48h / 24h / 24h / 24h) — there is NO public path that passes a caller-supplied delay to `_propose`. So the `DelayTooLong` defense at the lib level is irrelevant here — the typed propose functions hardcode their delay. Captured owner CANNOT brick a key by re-proposing with a long delay; the worst they can do is propose with the canonical 24h/48h, and the `cancel*` path is also `onlyOwner`, so they can also unbrick.

Conclusion: no lockout vector via delay in this admin. The library-level defense is belt-and-suspenders for hypothetical future child contracts that DO pass a caller-supplied delay.

Code refs:
- `VoteIncentivesAdmin.sol:86,109,133,160,189` (all hardcoded delays)
- `TimelockAdmin.sol:139` (DelayTooLong revert)

---

## F-38-5 — Pending state survives cancel emit (intentional, no replay risk)

Severity: Informational (verifying invariant).

Each typed `cancel*` clears the pending storage AFTER calling `_cancel(KEY)`:

```solidity
function cancelFeeChange() external onlyOwner {
    _cancel(FEE_CHANGE);
    uint256 cancelled = pendingFeeBps;
    pendingFeeBps = 0;
    emit FeeChangeCancelled(cancelled);
}
```

`_cancel` clears `_executeAfter[KEY] = 0`. Without a pending proposal in `_executeAfter`, a subsequent `executeFeeChange()` reverts `NoPendingProposal(FEE_CHANGE)`. So even though `pendingFeeBps` remains briefly populated between `_cancel` and the `pendingFeeBps = 0` line (which is in the same atomic tx so this is moot), it cannot be replayed.

Also verified `executeMinBribeAmount` / `cancelMinBribeAmount` — same pattern, `pendingMinBribeToken` and `pendingMinBribeAmount` are zeroed before exit.

Verified `cancelMinBribeAmount` (line 171-178) reads `token`/`amount` BEFORE `_cancel`, then zeros after — this is the safe order: read → cancel-effects → zero. Cancel emits `MinBribeAmountChangeCancelled(token, amount)` with the values before they're cleared. No bug.

No finding.

---

## F-38-6 — Whitelist propose-replace mid-flight (cancel + re-propose) is a 24h tax, not an exploit

Severity: Informational.

Considered: captured owner proposes `proposeWhitelistChange(USDC, true)` → user prepares depositBribe → owner cancels → re-proposes `proposeWhitelistChange(USDC, false)` (same key) → user is rugged when their tx lands after the swap.

Mitigation already in place: WHITELIST_CHANGE_DELAY = 24h. After a cancel, the new propose ALSO needs another 24h to mature. So the captured owner cannot pivot a whitelist change inside a 24h sandwich. The cancel itself is instant and observable on-chain, so a depositor who's monitoring can reschedule or back out.

Rugged-deposit scenario: even if owner flips USDC OFF mid-flight, in-flight `depositBribe(pair, USDC, amount)` calls land before the apply executes (apply requires another full 24h delay). After apply lands (epoch N+1), USDC bribes already in epoch N are unaffected — the whitelist check is at deposit time, not claim time. So existing bribes are NEVER stranded by a whitelist-remove.

Verified by reading `claimBribes` (line 768-887): the loop is over `epochBribeTokens[epoch][pair]` (the snapshotted list at deposit time); it does NOT re-check `whitelistedTokens` at claim. So whitelist-remove cannot strand bribes already deposited.

No finding. Documenting because the lens specifically called out "Token whitelist add/remove."

---

## F-38-7 — Min-bribe DoS bounded by MAX_MIN_BRIBE_AMOUNT = 1e24 (already mitigated)

Severity: N/A (already mitigated, verifying).

Captured-owner attack: set `minBribeAmounts[token] = type(uint256).max` to DoS all future deposits of that token. `applyMinBribeAmountChange` on `VoteIncentives.sol:1345-1351` enforces `if (amount > MAX_MIN_BRIBE_AMOUNT) revert ZeroAmount();`. Cap is `1e24` (1M tokens at 18 decimals). Already mitigated per BATCH-H M13 audit fix.

Subtler attack: set a min just BELOW `1e24` so that 6-decimal stablecoins (USDC/USDT, where `1e24` would mean $10^18 of value) are essentially uncapped DoS. But the attacker would need 24h propose+execute, owner-only path, and the owner could be replaced via `Ownable2Step` 2-step rotation in the meantime. Not a meaningful captured-owner monetization path because the attack pays nothing (just denies bribes); economically dead.

Counter: `proposeMinBribeAmount` does NOT check the cap (only `applyMinBribeAmountChange` does). So a 24h propose with `amount > 1e24` succeeds at propose time, then reverts at execute time. This means a captured owner could propose-fail-execute repeatedly, but each cycle is still owner-only and each cycle still takes 24h+. Not an exploit, just a wasted-gas + observability quirk.

Code refs:
- `VoteIncentives.sol:1343-1351` (cap + apply check)
- `VoteIncentivesAdmin.sol:156-162` (propose has NO cap check)

Recommendation (very minor): mirror the cap check in `proposeMinBribeAmount` to fail-fast at propose time. Saves the 24h timelock period of "we proposed an invalid amount and have to wait to find out." This is a UX improvement, not a security fix.

---

## F-38-8 — Treasury rotation race (front-run depositBribe fee skim)

Severity: Low — exists, but bounded by 48h timelock + on-chain visibility.

Scenario: captured owner proposes `proposeTreasuryChange(attackerWallet)`. After 48h, executes. Between the propose announcement (T0, on-chain) and the execute (T0+48h), legitimate bribers continue to deposit, paying `bribeFeeBps` (default 3%) to the live treasury. AFTER the execute lands (T0+48h+1), all subsequent bribe fees go to `attackerWallet` until governance re-proposes.

The race window is the 48h delay PLUS however long it takes the broader community to react to the on-chain `TreasuryChangeProposed` event. Realistic worst case: 48h + multisig reaction time. With a single-EOA captured owner and a slow community, the attacker can siphon 48-72h of bribe fees.

Defense in depth that already exists:
1. 48h timelock (longest delay in the contract — see line 48 `TREASURY_CHANGE_DELAY`).
2. On-chain `TreasuryChangeProposed` event with `executeAfter` timestamp (line 67 + line 110).
3. Off-chain monitor would alarm immediately.
4. Multi-sig key compromise is the precondition; if assumed, every other captured-owner finding applies too.

Existing fees in the contract at the moment of execute: `accumulatedTreasuryETH` is for ETH transfer fees (line 1147). Already-accumulated fees that haven't been withdrawn via `withdrawTreasuryFees()` are pull-pattern from `treasury` (the variable), so AFTER treasury rotates, the new treasury can pull all accumulated fees. So a captured owner who rotates the treasury can drain `accumulatedTreasuryETH` retroactively too. This compounds the ETH-fee-skim window.

Worth flagging as a Low/Med risk depending on how aggressive Tegriddy wants the captured-owner threat model to be. The audit-history NEW-G2 fix already removed the captured-owner sweep path for orphaned bribes; this is the residual treasury-rotation skim. Compound's `Comp` and Aave's `Treasury` use 7d delays for treasury rotation specifically because of this class of attack.

Recommendation: bump `TREASURY_CHANGE_DELAY` from 48h to 7 days. Makes captured-owner exploitation visible for a full week before any siphon can begin. Aerodrome / Velodrome use 7d for treasury changes. Code change is one constant.

Code refs:
- `VoteIncentivesAdmin.sol:48` (`TREASURY_CHANGE_DELAY = 48 hours`)
- `VoteIncentives.sol:1147-1152` (`withdrawTreasuryFees` pulls to current `treasury`, no protection against post-rotation pull)
- `VoteIncentives.sol:670-673` (every fresh deposit pays bribeFee to current treasury)

---

## Dead ends (negative results, useful context)

- **Setter for gauge controller**: `gaugeController` is one-shot via `setGaugeController` on `VoteIncentives.sol:120` — captured owner cannot retarget. GOV-INT-01 mitigation already in place. Not in admin's surface anyway.
- **Voteincentives admin setter**: `setVoteIncentivesAdmin` is one-shot on `VoteIncentives.sol:145` — `voteIncentivesAdmin` cannot be rotated to a different admin contract. So even a captured owner of `VoteIncentivesAdmin` cannot point it at a different `VoteIncentives` (the admin itself stores `voteIncentives` as `immutable` on line 62 of admin). The pair is permanently bonded post-deploy.
- **Sweep functions**: live on `VoteIncentives.sol:1378` (sweepExcessETH) + 1389 (sweepToken). `onlyOwner` directly, NOT through admin. Reserves prevent draining of active bribes/bonds. Verified `totalCommitBonds` reservation (line 1395-1397) covers the TOWELI bond pool. No drain vector for active bribes, but a captured owner can sweep "excess" sent-by-mistake tokens to treasury — which would already be a captured-owner-controlled treasury after F-38-8. Combined risk surface but each individual call is gated.
- **Renounce ownership**: `OwnableNoRenounce.renounceOwnership` reverts unconditionally. Cannot brick admin via renounce.
- **MIN_DELAY hard floor**: `_minDelay()` in TimelockAdmin returns 1 hour. `_propose` enforces `MIN_DELAY` even if a child override returns 0. Not bypassable. Already mitigated FRESH-EYES L (line 130).
- **Reentrancy via apply* hooks**: each `apply*` setter on VoteIncentives is `onlyAdmin` (msg.sender check), and the admin's execute path is `_execute(KEY)` (clears _executeAfter[key] BEFORE calling apply*) so there is no re-entry path that re-executes the same key. Apply* setters do not call out to user-controlled code — `applyTreasuryChange` writes a state var, `applyWhitelistChange` writes mappings, `applyMinBribeAmountChange` writes a mapping, `applyEnableCommitReveal` flips a bool. No external calls from any apply* in VoteIncentives. So no reentrancy.
- **Cancel without pending → reverts**: `_cancel` reverts `NoPendingProposal(KEY)` when nothing is pending. Each typed `cancel*` calls `_cancel` first then zeros pending storage. No way to "double-cancel" or emit cancel without state change.
- **Constructor**: only validates `_voteIncentives != 0`. Does NOT validate `_voteIncentives.code.length > 0` (unlike `VoteIncentives.setVoteIncentivesAdmin` which DOES require contract). A deployer-typo could wire admin to an EOA, in which case all `apply*` calls would silently succeed at the admin level (just a vanilla call to a non-contract → no revert? Actually `IVoteIncentivesApply(...).applyFeeChange(v)` to an EOA WILL revert at the call site because Solidity's high-level calls require returndata for view/pure or void return. Actually for void external calls, Solidity high-level call still checks `extcodesize` on the target — if the target has no code, the call reverts. Verified — Solidity 0.8.x with `interface.fn()` syntax includes the extcodesize check. So a wired-to-EOA admin would brick on first execute, observable. Not exploitable, just deployer-foot-gun.
- **`pendingWhitelistAction = false` on cancel**: line 148 — important! Without this reset, a cancelled "ADD" proposal would leave `pendingWhitelistAction = true` in storage. On the next `proposeWhitelistChange(token, false)` (REMOVE), the propose flow sets `pendingWhitelistAction = false` correctly so the stale `true` would be overwritten anyway. Even without the reset, no stale-state replay (since `_executeAfter[KEY]` is cleared by `_cancel`, no execute can fire). Belt-and-suspenders hygiene per DEEP-GOV-16, fine as is.

---

## Summary

VoteIncentivesAdmin is a thin, well-ramped admin facade. The propose/execute/cancel flow inherits TimelockAdmin's MIN_DELAY/MAX_DELAY/PROPOSAL_VALIDITY guards, and each typed setter delays for a sensible duration (24h-48h). Captured-owner monetization paths in the admin itself are bounded and observable.

Notable findings:
- **F-38-1** (Informational): `pause()` is on `VoteIncentives` directly under `onlyOwner`, NOT routed through the admin timelock. Captured owner can hold bribe-claims hostage indefinitely. Refund paths remain open as the structural escape hatch.
- **F-38-8** (Low/Med): `TREASURY_CHANGE_DELAY = 48h` is short relative to industry norm (7d). A captured owner with 48h of warning can siphon bribe fees and drain `accumulatedTreasuryETH` retroactively. Recommend bumping to 7d.
- **F-38-2 / F-38-3 / F-38-4 / F-38-5 / F-38-6 / F-38-7**: informational / verifying — no exploit; documented for the audit record.

No critical or high findings. No replay, no reentrancy, no key-lockout via delay, no whitelist-strand, no min-bribe DoS-uncapped vector.

Format: F-38-K. Path: `.audit_2026_freshlook/findings/agent_38_voteinc_admin.md`.
