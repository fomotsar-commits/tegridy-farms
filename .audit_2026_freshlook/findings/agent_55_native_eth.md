# Agent 55 — Native ETH Handling Audit

Lens: ETH transfer mechanics, msg.value safety, selfdestruct force-feed,
WETHFallbackLib stipend calibration, refund griefing, raw-call success-check,
WETH wrap/unwrap boundaries, distribution loop DoS, dust accumulation.

Working dir: contracts/src/.
Read-only audit; no edits.

---

## Summary table

| ID    | Severity | Title                                                                  | File:Line                                          |
|-------|----------|------------------------------------------------------------------------|----------------------------------------------------|
| F-55-1 | HIGH     | TegridyFeeHook→RevenueDistributor: 10k stipend insufficient for cold SSTORE in receive(); silently routes to WETH wrap that strands ERC20-WETH at distributor (invisible to address(this).balance) | TegridyFeeHook.sol:516,520,614  +  RevenueDistributor.sol:315-318 |
| F-55-2 | MEDIUM   | RevenueDistributor: emergencyWithdraw / executeEmergencyWithdrawExcess / sweepDust send to treasury via raw `.call{value}` with `require(success)` and NO WETH fallback — divergent from sister contracts; bricks if treasury becomes contract with reverting receive | RevenueDistributor.sol:429,458,876            |
| F-55-3 | MEDIUM   | POLAccumulator.executeSweepETH: raw `recipient.call{value:amount}` (unbounded gas, no WETH fallback, require(success)) — 48h-timelocked sweep bricks if treasury reverts | POLAccumulator.sol:598-600                          |
| F-55-4 | MEDIUM   | TegridyFeeHook.sweepETH: raw `payable(to).call{value:balance}` to revenueDistributor without stipend or WETH fallback; if distributor's receive runs heavy, reverts | TegridyFeeHook.sol:842-843                       |
| F-55-5 | MEDIUM   | CommunityGrants._transferETHOrWETH: home-rolled WETH-fallback that DIVERGES from the canonical lib — `IWETH.transfer` reverts (USDT-style WETH variants) escape the try/catch and revert the entire executeProposal | CommunityGrants.sol:1086-1109                     |
| F-55-6 | MEDIUM   | MemeBountyBoard.cancelBounty / refundStaleBounty / emergencyCancel / emergencyForceCancel: 10k gas stipend + push pattern + pendingRefund fallback — but the same contract uses 50k stipend on completeBounty (line 604) and sweepExpiredPayout (line 639). Inconsistent stipend = inconsistent UX/fail-rates for SCWs | MemeBountyBoard.sol:692,732,753,785            |
| F-55-7 | MEDIUM   | TegridyNFTPool.rescueStrandedRoyalty: WETH stranded by `safeTransferETHOrWrapNoRevert` mode==2 is recoverable only by owner; the WETH amount is invisible to `_lpAvailableETH()` (which only subtracts ETH-denominated fee accumulators) — accounting drift can mask the orphan | TegridyNFTPool.sol:1029-1035 + 880-885 |
| F-55-8 | MEDIUM   | TegridyTWAP.update refund: `msg.sender.call{value:excess}("")` with `require(ok)` and unbounded gas; a contract caller's reverting receive on the refund leg bricks the entire TWAP `update()` for that caller | TegridyTWAP.sol:285-286                            |
| F-55-9 | LOW      | TegridyFeeHook.receive(): bare receive accepts ETH from any sender without tracking. address(this).balance reads in claimFees/sweepETH treat donated ETH as legitimate fee balance | TegridyFeeHook.sol:848 + 599,840             |
| F-55-10 | LOW      | TegridyNFTPoolFactory.receive(): bare receive, no tracker. `withdrawProtocolFees` reads address(this).balance — selfdestruct ETH counts as withdrawable protocol fees; rate-limited but no monotonic ingress counter for off-chain reconciliation | TegridyNFTPoolFactory.sol:676 + 594,623         |
| F-55-11 | LOW      | ReferralSplitter.receive() bare; donated ETH counts as `sweepable` to treasury via sweepUnclaimable. No `totalETHReceived` tracker for off-chain ingress reconciliation (sister contracts have one) | ReferralSplitter.sol:227 + 778-789           |
| F-55-12 | LOW      | VoteIncentives.receive() bare; rounding-dust drift on totalUnclaimedETHBribes (clamped to 0 on underflow) could cause sweepExcessETH to over-sweep into treasury territory if a future refactor breaks the dust invariant | VoteIncentives.sol:1451 + 853,1378          |
| F-55-13 | LOW      | RevenueDistributor: distributePermissionless / _distribute uses address(this).balance > reserved to detect "new ETH" — selfdestruct/coinbase ETH counts as legitimate epoch revenue. Honest donors only inflate stakers; attacker can use this to manipulate timing of MIN_DISTRIBUTE_AMOUNT crossing | RevenueDistributor.sol:332,346-356,363-365        |
| F-55-14 | INFO     | Cross-contract gas-stipend sprawl: 10k (lib + RD claims + CG executeProposal + CommunityGrants), 50k (SwapFeeRouter._distribute, MemeBountyBoard.completeBounty/sweepExpiredPayout, VoteIncentives.claimBribes), unbounded (PoLAccumulator.executeSweepETH, TegridyFeeHook.sweepETH, RevenueDistributor.emergencyWithdraw, TegridyTWAP refund/withdrawFees). No documented rationale for the per-site choice | (multiple)                                          |
| F-55-15 | INFO     | WETHFallbackLib.safeTransferETHOrWrapNoRevert: when the ETH leg fails AND the WETH-deposit succeeded but WETH-transfer fails, the lib returns `mode == 2` and the freshly-minted WETH stays in the LIBRARY USER's contract (the caller). Callers that don't sweep on mode==2 will accumulate stranded WETH | lib/WETHFallbackLib.sol:153-167                   |

---

## F-55-1 — HIGH — Cold-storage SSTORE in RevenueDistributor.receive() exceeds 10k stipend; ETH-leg fails; WETH wrap strands ERC20-WETH at distributor (invisible to balance reads)

**File / line**
- `contracts/src/TegridyFeeHook.sol:516,520,614`
- `contracts/src/RevenueDistributor.sol:315-318` (the receive() being targeted)
- `contracts/src/lib/WETHFallbackLib.sol:78-92` (the 10k stipend)

**ETH handling bug**
TegridyFeeHook delivers ETH to `revenueDistributor` via `WETHFallbackLib.safeTransferETHOrWrap(WETH, revenueDistributor, amount)` in three places (claimFees address(0) leg, claimFees WETH leg post-unwrap, convertERC20FeesToETH post-swap forward). The lib's ETH leg uses a 10000-gas stipend.

RevenueDistributor.receive() does:
```
unchecked { totalETHReceived += msg.value; }
emit ETHReceived(msg.sender, msg.value);
```

EIP-2929 cold-access pricing makes the FIRST cross-tx interaction with this slot expensive:
- cold SLOAD `totalETHReceived`: 2100 gas
- ADD: 3 gas
- non-zero→non-zero SSTORE: 5000 gas (warm) or 22100 gas (zero→non-zero, first ever ingress)
- LOG2 with one indexed (address) + 32-byte data: ~1500-1800 gas
- CALL overhead inside the stipend frame: ~700 gas + memory expansion

**For the very first ingress** (`totalETHReceived` slot still zero) the SSTORE alone is 22100 gas — far above the 10k stipend. The ETH leg fails, the lib falls back to wrapping as WETH, and the WETH lands inside RevenueDistributor as ERC20 balance.

The RevenueDistributor's `_distribute()` reads `uint256 balance = address(this).balance` (line 350, 363) — the ERC20 WETH balance is invisible. The only sweep path for ERC20 is the timelocked `proposeTokenSweep` → `executeTokenSweep` (line 890, 901), but `executeTokenSweep` sends the swept token to `pendingSweepTo`, NOT into the distribution path. **Stakers never see the WETH.**

Even on subsequent ingresses (warm slot), the SSTORE-non-zero→non-zero (5000-2900 gas depending on Berlin/London/Shanghai pricing) + LOG2 + ADD + cold SLOAD per fresh tx puts the receive body at roughly 7-9k gas. After the CALL frame's intrinsic cost the receive body has ~9k available — every ingress is on the borderline. Any future EVM repricing (e.g., a London-style SLOAD bump, or an EIP that increases LOG cost) flips this from "borderline" to "always fails."

**Exploit / impact path**
1. TegridyFeeHook.claimFees() runs after a swap accrues ETH-currency fee.
2. Lib calls `revenueDistributor.call{value: amount, gas: 10000}("")`.
3. RevenueDistributor.receive() runs out of gas (cold first-ingress, or borderline warm path).
4. Lib's `if (ok) return; ... IWETH.deposit{value:amount}(); IWETH.transfer(revenueDistributor, amount)` runs.
5. Now revenueDistributor holds WETH. `_distribute()` reads `address(this).balance` — sees zero. New ETH never enters an epoch. Stakers never claim it.
6. Off-chain monitoring of `totalETHReceived` won't fire either — the receive() body never executed (the failure aborted before the SSTORE).

The WETH sits permanently in RevenueDistributor unless the timelocked proposeTokenSweep is invoked — but that sends to a chosen address, NOT into the staker distribution. So even sweep recovers it only to a treasury, not to stakers.

**Recommendations**
- Either raise the lib's ETH-leg stipend to ~30k (matches Bunni v2 / Aerodrome pattern for distributor-style receivers that must keep an ingress counter), OR
- In RevenueDistributor, accept WETH fallback as a sibling currency and unwrap before computing the new-ETH-for-distribution figure (track WETH balance + ETH balance), OR
- Document the symptom and have an off-chain keeper periodically call IWETH.withdraw() through an explicit `unwrapStrandedWETH()` helper that folds the result back into the distribution lane.

The same pattern bears on POLAccumulator.receive() (line 308-318) but POL is fed by SwapFeeRouter._distribute which uses a 50k stipend — POL receives its ETH and the receive() body succeeds. The 10k-stipend hazard is specific to TegridyFeeHook's lib-mediated push.

---

## F-55-2 — MEDIUM — RevenueDistributor emergency/sweep paths use raw `.call` without WETH fallback; treasury contract upgrade can permanently brick the path

**File / line**
- `contracts/src/RevenueDistributor.sol:429` (emergencyWithdraw)
- `contracts/src/RevenueDistributor.sol:458` (executeEmergencyWithdrawExcess)
- `contracts/src/RevenueDistributor.sol:876` (sweepDust)

**ETH handling bug**
All three paths above issue:
```solidity
(bool success,) = treasury.call{value: ...}("");
if (!success) revert ETHTransferFailed();
```

This is unbounded gas (no stipend), no WETH fallback, and `require(success)`. The same contract uses `WETHFallbackLib.safeTransferETHOrWrap` for `withdrawPending` (line 858) and other user-facing paths. **Architectural divergence**: owner-side mutators are the LEAST robust ETH-egress paths in the contract.

Treasury is rotatable behind a 48h timelock. If a treasury rotation has just landed and the new treasury turns out to be a contract whose receive() reverts (e.g., misconfigured Safe with a guard that rejects unannotated ETH, paused multisig), `emergencyWithdraw` and `sweepDust` BOTH brick. To recover, owner must propose another treasury rotation and wait another 48 hours during the emergency.

**Exploit / impact path**
- Captured-key scenarios are bounded by the timelock, but legitimate operational scenarios (multisig contract upgrade, treasury wallet refresh, multisig pausing for a security review) collide with these paths.
- `sweepDust` is owner-only and not on the critical path for staker claims, but `emergencyWithdraw` IS the recovery hatch for "all stakers have unstaked, get the dust out." If the dust hatch bricks during a real incident, this becomes a live operational issue.

**Recommendations**
- Replace all three with `WETHFallbackLib.safeTransferETHOrWrap(address(weth), treasury, amount)`. Same guard pattern as the user-facing `withdrawPending` in this very contract (line 858).
- The risk of a malicious WETH wrap path in OWNER-only flows is negligible — the recipient (treasury) is timelock-rotatable, and the lib's WETH-wrap leg requires the canonical WETH which is set in the constructor.

---

## F-55-3 — MEDIUM — POLAccumulator.executeSweepETH unbounded raw call to treasury can brick the 48h-timelocked sweep

**File / line**
- `contracts/src/POLAccumulator.sol:590-601`

**ETH handling bug**
```solidity
function executeSweepETH() external onlyOwner nonReentrant whenNotPaused {
    _execute(SWEEP_ETH_CHANGE);
    uint256 amount = sweepETHProposedAmount;
    uint256 balance = address(this).balance;
    if (amount > balance) amount = balance;
    require(amount > 0, "NO_ETH");
    address recipient = treasury;
    sweepETHProposedAmount = 0;
    (bool success,) = recipient.call{value: amount}("");
    require(success, "ETH_TRANSFER_FAILED");
    ...
}
```

Same shape as F-55-2: raw call, no stipend, no WETH fallback. Worse: this is a sweep that's already been timelocked for 48 hours. If at execute time the treasury reverts, the proposal is consumed (`_execute(SWEEP_ETH_CHANGE)` clears the timelock state) but the value-flow fails. Owner has to re-propose and wait another 48 hours.

The sister `executeHarvestLP` path on the SAME contract (line 705-707) DOES use `WETHFallbackLib.safeTransferETHOrWrap(weth, treasury, ethOut)` with full WETH fallback. The asymmetry is structural.

**Recommendations**
- Replace the raw `.call` at line 598 with `WETHFallbackLib.safeTransferETHOrWrap(weth, recipient, amount)`. This matches the pattern already adopted in `executeHarvestLP` on the same contract.

---

## F-55-4 — MEDIUM — TegridyFeeHook.sweepETH unbounded raw call — DoS hazard if revenueDistributor's receive consumes more than the call frame allows

**File / line**
- `contracts/src/TegridyFeeHook.sol:836-845`

**ETH handling bug**
```solidity
function sweepETH(address to) external onlyOwner {
    if (to != revenueDistributor) revert InvalidSweepRecipient();
    uint256 balance = address(this).balance;
    require(balance > 0, "NO_ETH");
    (bool success,) = payable(to).call{value: balance}("");
    if (!success) revert SweepFailed();
    emit ETHSwept(to, balance);
}
```

`payable(to).call{value: balance}("")` — unbounded gas, no WETH fallback, `if (!success) revert`. If the destination's receive() reverts (regardless of cause: revenueDistributor running out of stack at deep call depth, paused, post-upgrade selector mismatch), the entire balance becomes unsweepable until the distributor is rotated through the 48h DISTRIBUTOR_CHANGE timelock.

This contract uses `WETHFallbackLib.safeTransferETHOrWrap` everywhere else for ETH egress (line 516, 520, 614). The owner-only sweep path is the asymmetric outlier.

**Recommendations**
- Replace with `WETHFallbackLib.safeTransferETHOrWrap(WETH, to, balance)`. Allowed-recipient gate (line 839) already constrains the destination.

---

## F-55-5 — MEDIUM — CommunityGrants._transferETHOrWETH home-rolled WETH-fallback that diverges from the canonical lib

**File / line**
- `contracts/src/CommunityGrants.sol:1086-1109`

**ETH handling bug**
This contract reimplements the WETH-fallback pattern locally instead of calling `WETHFallbackLib.safeTransferETHOrWrap`:

```solidity
function _transferETHOrWETH(address recipient, uint256 amount) internal returns (bool) {
    (bool success,) = recipient.call{value: amount, gas: 10_000}("");
    if (success) return true;
    try IWETH(weth).deposit{value: amount}() {
        bool sent = IWETH(weth).transfer(recipient, amount);  // <-- NOT inside try/catch
        if (!sent) {
            IWETH(weth).withdraw(amount);
            return false;
        }
        return true;
    } catch {
        return false;
    }
}
```

Two divergences from the canonical lib:

1. **`IWETH(weth).transfer(recipient, amount)` is OUTSIDE the try/catch.** Canonical WETH9 returns bool and never reverts for in-balance transfers, so this is fine on Ethereum mainnet. But on chains with USDT-style WETH variants (some L2s use a custom WETH9 with blacklists or a paused-flag that REVERTS on `transfer` to a blacklisted recipient), the revert escapes the try/catch and reverts the entire `executeProposal` / `retryExecution`. The deposit is unwound by the outer revert, which is OK, but the proposal is now in a permanent FailedExecution state where retries also revert deterministically. Lib's `safeTransferETHOrWrap` reverts in this case too (`WETHTransferFailed` error), but the lib also has the `safeTransferETHOrWrapNoRevert` variant that the local re-implementation does not benefit from.

2. **Local-rolled code has its own audit history.** The lib has been hardened (DEEP-LIB-H1 zero-recipient guard, DEEP-LIB-L1 success-path event, M-6 NoRevert variant, DEEP-LIB-M2 stipend on safeTransferETH variant). Future hardening to the lib won't propagate to this local copy.

3. The unwind (`IWETH.withdraw(amount)` on line 1102) calls back into THIS contract's receive(). Pattern is safe because this contract's receive is an event-only emit, but it composes a re-entrant boundary that the canonical lib does NOT have (the lib never calls `withdraw` after a deposit failure).

**Recommendations**
- Replace `_transferETHOrWETH` with a thin wrapper around `WETHFallbackLib.safeTransferETHOrWrapNoRevert` and translate `mode != 2` to the bool return. The lib's NoRevert variant has the exact "return success/failure for caller-side handling" semantics this code wants, with battle-tested defaults.

---

## F-55-6 — MEDIUM — MemeBountyBoard inconsistent gas-stipend choice across the same contract

**File / line**
- `contracts/src/MemeBountyBoard.sol:692,732,753,785` (10k stipend on cancelBounty / refundStaleBounty / emergencyCancel / emergencyForceCancel)
- `contracts/src/MemeBountyBoard.sol:604` (50k stipend on completeBounty winner payout)
- `contracts/src/MemeBountyBoard.sol:639` (50k stipend on sweepExpiredPayout)

**ETH handling bug**
The same contract uses a 10000-gas stipend for creator-side refunds and a 50000-gas stipend for winner payouts and treasury sweeps. The doc-comment on line 597-603 even calls out the rationale for the 50k bump: smart-contract wallets (Safe, Argent, EIP-4337) need more than 10k for receive() to succeed.

**Refunds to a Safe-protected creator address therefore land in pendingRefund** (the failure path) for legitimate bounty-canceller creators, while a Safe-protected winner DOES get paid directly. Inconsistency in the inverse direction also exists: a creator who is an EOA gets paid directly on cancel; a creator who is a Safe falls into pendingRefund and has to call withdrawRefund. Two separate UX tiers driven solely by the stipend choice.

The pendingRefund pull-pattern recovers (no funds lost), but the inconsistency creates support-load and exposes a tiny grief vector: a malicious creator could deploy a contract whose receive() passes 10k but reverts in some narrow case (not-yet-relevant input), forcing the cancel path into pendingRefund and slowing the cancel-then-restart cycle.

**Recommendations**
- Pick one stipend per contract. 50k matches the pattern used for VoteIncentives.claimBribes (50k, line 863) and SwapFeeRouter._distribute (50k, line 1334). 10k is the lib default for permissionless user-facing claims.
- Cancel-paths going to creators are RARE and high-value; the 50k stipend is the right choice (matches the paint-by-numbers in the same contract on completeBounty).

---

## F-55-7 — MEDIUM — TegridyNFTPool.rescueStrandedRoyalty: stranded WETH is invisible to liquidity accounting

**File / line**
- `contracts/src/TegridyNFTPool.sol:880-885` (_lpAvailableETH only subtracts ETH-denominated trackers)
- `contracts/src/TegridyNFTPool.sol:1029-1035` (rescueStrandedRoyalty: owner-only sweeps WETH balance)
- `contracts/src/TegridyNFTPool.sol:992-1010` (_settleRoyalty: mode==2 emits RoyaltyOrphaned but leaves WETH in pool)

**ETH handling bug**
`_settleRoyalty` calls `WETHFallbackLib.safeTransferETHOrWrapNoRevert(weth, receiver, amount)`. When `mode == 2` (the lib's "both legs failed" return), the lib has already called `weth.deposit{value: amount}` if the ETH-leg failed before the WETH-deposit also failed (or `IWETH.transfer` failed). In that scenario, **the WETH is now sitting in the lib's caller**, i.e. THIS pool. Lib comment at line 162-167 confirms this: "ETH is now stuck inside this lib's runtime as WETH. Caller MUST handle by sweeping `IWETH(weth).balanceOf(address(this))` to credit."

`rescueStrandedRoyalty` IS the sweep path. But:
1. The pool's bonding-curve accounting (`_lpAvailableETH`) reads only `address(this).balance` and subtracts `accumulatedProtocolFees + accumulatedLPFees`. The stranded WETH balance is never visible to this accounting.
2. The WETH balance can grow over time as repeated mode==2 events compound. Owner discovery is event-driven (RoyaltyOrphaned), so a non-monitoring owner accumulates orphan WETH indefinitely.
3. `rescueStrandedRoyalty` sends to `msg.sender` (the pool owner), bypassing the royalty receiver who should have received it. This is correct (the receiver couldn't receive it via either leg), but means the royalty contract on the destination side never sees the funds — a downstream royalty-distribution contract that depends on receipt has zero on-chain notification.

**Exploit / impact path**
- A malicious or buggy ERC-2981 royalty receiver that reverts on ETH receive AND can't accept WETH (or whose code rejects this pool's address) leaves WETH stranded in the pool.
- The pool keeps trading. `_lpAvailableETH` is unaware of the WETH balance — solvency math (line 877) is unchanged because the WETH isn't in `address(this).balance`.
- After many such trades, the pool owner notices via off-chain monitoring (or doesn't) and calls `rescueStrandedRoyalty`. The WETH goes to the owner, not the royalty receiver.

This is documented behavior, not a bug per se, but the asymmetry between "ETH is reserved by `accumulatedFees`" and "WETH is invisible until sweep" is a tripwire for any future code that adds WETH-denominated reserves (royalty pre-credit, LP-fee WETH branch, etc.).

**Recommendations**
- Add a `totalStrandedRoyaltyWETH` counter incremented on the mode==2 branch of `_settleRoyalty`. Expose it in a view so off-chain accounting can detect drift early.
- Document at the top of `rescueStrandedRoyalty` that the recipient is the pool owner (not the original royalty receiver). Add an event field that records the original-receiver for audit trail.

---

## F-55-8 — MEDIUM — TegridyTWAP.update refund leg has unbounded-gas raw call and require(ok) — bricks update for contract callers whose receive reverts

**File / line**
- `contracts/src/TegridyTWAP.sol:285-286`

**ETH handling bug**
```solidity
if (excess > 0) {
    (bool ok,) = msg.sender.call{value: excess}("");
    if (!ok) revert InsufficientFee();
}
```

If `msg.sender` is a contract whose receive() reverts on the refund leg, the entire `update()` call reverts. **TWAP observation does not advance** for that block.

If the same contract re-calls update (e.g. a keeper bot whose ETH-refund handling is broken), every update attempt reverts. The keeper rotates to a new address — fine. But if a HOSTILE actor wants to grief: they can call update() with `msg.value = updateFee + 1` from a contract whose receive reverts. The update() reverts, no state advances, but neither does any state move. **No real exploit** because the attacker is paying gas for their own self-grief.

The harder hazard: if this contract's `feeRecipient` is set to a contract whose receive reverts, `withdrawFees` (line 612-620) bricks. Recovery requires `setFeeRecipient` (no timelock) — minor.

**Recommendations**
- Replace the refund call with `WETHFallbackLib.safeTransferETHOrWrap(weth, msg.sender, excess)` if the TWAP contract has access to the canonical WETH (it doesn't currently; would require a constructor-time wire).
- OR add a 10000-gas stipend so EOAs and Safe-style receivers succeed but a hostile-revert receiver can't brick the path. With the stipend, on failure, accumulate the excess into `accumulatedFees` instead of reverting (the keeper paid more than required; effectively a tip).

---

## F-55-9 — LOW — TegridyFeeHook.receive() bare; address(this).balance reads in claimFees/sweepETH treat donated ETH as fee balance

**File / line**
- `contracts/src/TegridyFeeHook.sol:848` (bare `receive() external payable {}`)
- `contracts/src/TegridyFeeHook.sol:599-607` (claimFees ethBefore/ethReceived delta in convertERC20FeesToETH)
- `contracts/src/TegridyFeeHook.sol:840` (sweepETH balance read)

**ETH handling bug**
The receive() is bare — no event, no tracker. The contract uses `address(this).balance` reads in three places:
1. line 599-607: ethBefore/ethReceived delta around the swap. **Safe**: uses delta, donated ETH cancels out.
2. line 840 in sweepETH: full balance is swept to `revenueDistributor`. Safe (entire balance flows to the legitimate accounting destination).
3. The PoolManager-take primitive in afterSwap is the legitimate ingress — unrelated to receive().

The hazard is **off-chain reconciliation**: sister contracts (RevenueDistributor, POLAccumulator, SwapFeeRouter) have a `totalETHReceived` monotonic counter incremented in receive() so monitoring can detect ETH drift. TegridyFeeHook does not. A donor's selfdestruct ETH lands silently in the contract's balance and is forwarded to revenueDistributor on the next sweep — fine for solvency, but invisible to fee accounting telemetry.

**Recommendations**
- Add a `totalETHReceived` counter and an `ETHReceived(address sender, uint256 amount)` event in receive(). Mirrors RevenueDistributor.sol:313-318 pattern.

---

## F-55-10 — LOW — TegridyNFTPoolFactory.receive() bare; withdrawProtocolFees treats donations as protocol fees

**File / line**
- `contracts/src/TegridyNFTPoolFactory.sol:676` (bare receive)
- `contracts/src/TegridyNFTPoolFactory.sol:594` (withdrawProtocolFees reads address(this).balance)
- `contracts/src/TegridyNFTPoolFactory.sol:623` (withdrawProtocolFees(uint256) reads address(this).balance)

**ETH handling bug**
Bare `receive() external payable {}`. Pool fees flow in via `pool.claimProtocolFees()` (called from `claimPoolFees` and `claimPoolFeesBatch`). Donations / selfdestruct ETH commingle with legitimate protocol fees, and `withdrawProtocolFees` treats the entire `address(this).balance` as withdrawable.

Rate-limited via 24h MAX_DAILY_WITHDRAWAL — bounded blast radius. Owner-only — no permissionless drain. **Not directly exploitable**, but:
- A donor can inflate the factory's balance without any on-chain trace, bypassing the per-pool protocol-fee tracking that tools may rely on.
- Off-chain monitoring cannot reconcile `totalProtocolFeesReceived` against `withdrawnToday` because there is no monotonic ingress counter.

**Recommendations**
- Add a `totalETHReceived` counter incremented in receive() (donations-aware) AND a `totalProtocolFeesAccrued` counter incremented in `claimPoolFees`/`claimPoolFeesBatch` (legitimate-fee-only). Off-chain reconciliation of `(totalETHReceived - totalProtocolFeesAccrued)` flags donations.

---

## F-55-11 — LOW — ReferralSplitter.receive() bare; missing totalETHReceived tracker

**File / line**
- `contracts/src/ReferralSplitter.sol:227`
- `contracts/src/ReferralSplitter.sol:778-789` (sweepUnclaimable)

**ETH handling bug**
`receive() external payable {}` — bare, no event, no counter. SwapFeeRouter pushes ETH into `recordFee` (payable function) which DOES track via the explicit `callerCredit + pendingETH + accumulatedTreasuryETH` math. So legitimate flows go through `recordFee`, not `receive()`. The receive() exists only to absorb refunds from WETH-unwrap inside the lib (when the lib's WETH-wrap leg is exercised against this contract — which the lib never does since this contract is always a CALLER not a RECEIVER of safeTransferETHOrWrap; we're on the wrong side of the boundary).

Hazard: a selfdestruct donation lands in `address(this).balance` and `sweepUnclaimable` (line 778) computes `balance - reserved` — donations are sweepable to treasury. Same shape as F-55-10. No exploit — just a missing telemetry slot.

The ABSENCE of a counter is the gap: every other major ETH-receiving contract in the protocol has one (RevenueDistributor `totalETHReceived`, POLAccumulator `totalETHReceived`, SwapFeeRouter `totalETHReceived`). ReferralSplitter is the asymmetric outlier.

**Recommendations**
- Add `totalETHReceived` and `ETHReceived(address sender, uint256 amount)` event in receive() for parity with sister contracts.

---

## F-55-12 — LOW — VoteIncentives totalUnclaimedETHBribes saturates at 0 on rounding-dust drift; sweepExcessETH may then over-sweep

**File / line**
- `contracts/src/VoteIncentives.sol:853` (`totalUnclaimedETHBribes = totalUnclaimedETHBribes > share ? totalUnclaimedETHBribes - share : 0;`)
- `contracts/src/VoteIncentives.sol:957` (same shape in claimBribesBatch)
- `contracts/src/VoteIncentives.sol:1378-1384` (sweepExcessETH = balance - totalUnclaimedETHBribes - totalPendingETH - accumulatedTreasuryETH)
- `contracts/src/VoteIncentives.sol:1451` (bare receive)

**ETH handling bug**
`totalUnclaimedETHBribes` is decremented on each successful claim, with safe-subtract (saturates at 0). The DEFENSIVE saturation prevents underflow but **silently masks rounding-dust drift**: when sum(shares) exceeds bribeAmount due to FP rounding (it shouldn't with the integer division in line 818 since shares are floor'd; but a future refactor could break this), the running total drifts toward zero faster than the actual unclaimed pool empties.

If the running total is below the true unclaimed, `sweepExcessETH`'s `reserved` figure under-counts — meaning `sweepable` is over-counted — meaning `WETHFallbackLib.safeTransferETHOrWrap(weth, treasury, sweepable)` sends too much, and a future legitimate claimer hits insolvency.

The fallback (line 864-867 in claimBribes) credits to `pendingETHWithdrawals[msg.sender]` on push failure — this would suddenly stop working if the contract's balance is below the pending claim due to over-sweep.

The **explicit dust tracker** (`totalClaimedBribes[epoch][pair][token]`, line 849 + comment 842-848) is meant to defend exactly this — `sweepExcessETH` should use it to compute precise dust. But the sweep code at line 1380 only references the running total, not the per-(epoch,pair,token) dust map. **The dust-tracker exists, but the sweep doesn't read it.**

**Exploit / impact path**
Depends on a future refactor that breaks the floor invariant on shares. Today's code is safe by integer-floor. But the architectural soft-spot is real: the sweep checks the running total (which can drift), not the precise per-bribe dust map (which cannot).

**Recommendations**
- Either: change `sweepExcessETH` to iterate epochBribeTokens and compute `sum(epochBribes[e][p][t] - totalClaimedBribes[e][p][t])` for the exact reserved figure (gas-bounded by claimable epochs).
- OR: revert (instead of saturate) on the line-853 underflow case, so any future rounding bug surfaces immediately as a revert rather than a silent drift.

---

## F-55-13 — LOW — RevenueDistributor.distributePermissionless: address(this).balance > reserved counts force-fed ETH as legitimate epoch revenue

**File / line**
- `contracts/src/RevenueDistributor.sol:332-335` (distribute() — reads boostedStake then calls _distribute)
- `contracts/src/RevenueDistributor.sol:346-356` (distributePermissionless — same shape)
- `contracts/src/RevenueDistributor.sol:359-365` (_distribute computes newETH = balance - reserved)

**ETH handling bug**
`_distribute` computes new-epoch ETH as:
```solidity
uint256 reserved = (totalEarmarked > totalClaimed ? (totalEarmarked - totalClaimed) : 0) + totalPendingWithdrawals;
uint256 balance = address(this).balance;
uint256 newETH = balance > reserved ? balance - reserved : 0;
```

A `selfdestruct(address(distributor))` from any address — or a coinbase set, or a tx-included donation — increases `address(this).balance` without going through `receive()`. The next call to `distribute()` or `distributePermissionless()` will treat the donated amount as new fee revenue and credit it to stakers proportionally.

This is not an ATTACKER's exploit — the attacker is GIVING money to stakers. But it has two soft hazards:

1. **Timing manipulation**: an attacker can selfdestruct just enough ETH to push `newETH` over `MIN_DISTRIBUTE_AMOUNT`, force a distribute() that wouldn't otherwise trigger, and dilute future legitimate fee deliveries by inflating `epochs.length` (each future legitimate ETH delivery now spans more epochs).
2. **Telemetry pollution**: the legitimate `totalETHReceived` counter (incremented in receive(), line 316) does NOT reflect selfdestruct/coinbase ingress. Off-chain reconciliation that diffs `totalETHReceived` against the running balance to detect drift will see a constant divergence. Documented in the natspec at line 310-312 ("catches selfdestruct/coinbase ETH that bypasses receive() only when off-chain readers diff this counter against address(this).balance"). The line acknowledges the problem.

**Exploit / impact path**
Bounded — attacker is donating money to stakers. The timing-manipulation angle is also bounded by `MIN_DISTRIBUTE_INTERVAL` (1 hour, line 360) and the 1-block keeper cadence — an attacker can force at most one early epoch per hour.

**Recommendations**
None operationally urgent. If desired: switch `_distribute` to use `totalETHReceived - totalDistributed - reservedDistributed` instead of `balance - reserved` to pin the new-ETH figure to the receive()-tracked counter. That would close the timing-manipulation surface but creates a hard upgrade path (existing balance reconciliation breaks).

---

## F-55-14 — INFO — Cross-contract gas-stipend sprawl

**File / line** (multiple)

**Observation**
The protocol uses at least four distinct gas-stipend conventions for ETH egress:
- 10000 gas (canonical lib + RevenueDistributor user claims + CommunityGrants executeProposal)
- 50000 gas (SwapFeeRouter._distribute + MemeBountyBoard.completeBounty + MemeBountyBoard.sweepExpiredPayout + VoteIncentives.claimBribes)
- Unbounded (POLAccumulator.executeSweepETH + TegridyFeeHook.sweepETH + RevenueDistributor.emergencyWithdraw / executeEmergencyWithdrawExcess / sweepDust + TegridyTWAP refund / withdrawFees + TegridyNFTPoolFactory.createPool initial-liquidity push)
- 2300 gas (none observed — the Solidity `.transfer()` builtin is not used anywhere; good)

Per-call rationale exists in some sites (line 597-603 of MemeBountyBoard documents the 10k→50k bump for SCWs), but the choices are not consistent across contracts. Mostly cosmetic, but creates user-facing inconsistency:

- A Safe wallet that owns a bounty winner submission gets paid directly (50k stipend, completeBounty).
- The same Safe wallet that creates a bounty and cancels it falls into pendingRefund (10k stipend on cancelBounty) and has to call withdrawRefund.
- A Safe that claims ReferralSplitter rewards (line 476: WETHFallbackLib internal call → 10k stipend) likely receives WETH instead of ETH, again falling into the WETH-fallback path silently.

**Recommendations**
- Add a doc comment in each ETH-egress site that explains the stipend choice ("EOA-only refund" / "SCW-compatible payout" / "owner-side admin" / etc.).
- Consider a single global constant `STIPEND_USER_PAYOUT = 50_000` and `STIPEND_LIBRARY_FALLBACK = 10_000` and use one or the other consistently. The lib's 10k is correct as the "ALWAYS-FALLBACK" floor; user-facing pushes can be larger before the fallback engages.

---

## F-55-15 — INFO — WETHFallbackLib.safeTransferETHOrWrapNoRevert mode==2 leaves WETH in the caller after a successful deposit but failed transfer

**File / line**
- `contracts/src/lib/WETHFallbackLib.sol:153-167`

**Observation**
The NoRevert variant has three return modes:
- 0: ETH delivered.
- 1: WETH delivered (fallback).
- 2: both legs failed.

Inside the lib:
1. ETH `to.call{value:amount, gas:10000}("")` fails → continue.
2. `weth.call{value:amount}(deposit())` — if THIS fails, return mode==2. ETH stays in caller. OK.
3. `weth.call(transfer(to, amount))` — if THIS fails, return mode==2. **But the deposit already succeeded.** WETH now sits in the caller (the contract that invoked the lib), NOT in the recipient.

The lib's docstring comment (line 162-167) acknowledges this: "ETH is now stuck inside this lib's runtime as WETH. Caller MUST handle by sweeping `IWETH(weth).balanceOf(address(this))` to credit. Returning `mode = 2` signals the caller to do that."

Callers that USE the NoRevert variant:
- TegridyNFTPool._settleRoyalty (line 992-993) — yes, has a rescueStrandedRoyalty path (F-55-7).

NOT observed using NoRevert anywhere else in the audited surface. Most callers use the reverting `safeTransferETHOrWrap` which has only mode 0 (ETH) or revert-on-failure semantics — no stranded-WETH scenario.

**Recommendation**
Add a paragraph to the lib's safeTransferETHOrWrapNoRevert NatSpec explicitly stating: "On mode==2 return, the caller MUST EITHER (a) credit the amount to a pull-pattern slot keyed on `to` AND sweep `IWETH(weth).balanceOf(address(this))` to that slot's worth, OR (b) revert to roll back the failed deposit. Silent ignoring of mode==2 = stranded WETH in caller's runtime."

This is documentation only; the code is correct as-is.

---

## Notes / dead-ends

- **TegridyDropV2 has NO receive() function.** `mint()` is the only payable ingress. Selfdestruct-donated ETH stays unspendable except via `rescueAfterCancellation` (1-year delay post-cancel; gated on `mintPhase == CANCELLED`). `withdraw()` uses `totalProceeds` not `address(this).balance` — donations are explicitly excluded from creator/platform payouts. Solid design.

- **TegridyPair, TegridyFactory, TegridyStaking, TegridyRestaking, TegridyLPFarming, GaugeController, PremiumAccess** — no ETH paths. ERC20-only contracts.

- **TegridyNFTPool.receive() (line 804)** is gated `msg.sender == factory` — direct sends from EOAs revert. ETH ingresses only via `swapETHForNFTs` (msg.value validated) or `addLiquidity` (msg.value validated) or factory's createPool initial-liquidity push. **Selfdestruct still bypasses the gate** — but the bonding-curve math (line 880-885 `_lpAvailableETH`) doesn't read raw balance into pricing, only into solvency floor. Donations only relax the solvency floor (`bal > reserved` becomes more likely true). **Honest donor → harmless.**

- **SwapFeeRouter.receive() (line 2060)** with totalETHReceived tracker — acknowledged donation-aware design.

- **POLAccumulator.accumulate (line 412)** uses `address(this).balance` as the input bound, capped to `maxAccumulateAmount`. Selfdestruct-donated ETH is captured into the next accumulation — owner-only path with TWAP-anchored slippage means the donation is either swapped to TOWELI + paired into LP (locked forever by design), or held until cooldown. No exploit; documented as ETH-flow-into-protocol-LP, which is the contract's purpose.

- **No `transfer()` (gas:2300) anywhere.** All pushes use `.call{value}` or the lib. EIP-7702 / smart-contract-wallet compat is preserved across the codebase.

- **Multicall / batch surface**: no on-chain multicall in the audited contracts; msg.value cannot be double-counted across function calls inside a single tx (each external function reads msg.value as the same per-tx scalar but the audited functions never call each other reentrantly via internal payable invocations).

- **ETH refund leg in batch operations**: TegridyRouter's `swapETHForExactTokens` at line 337-342 refunds `msg.value - amounts[0]` via WETHFallbackLib. `addLiquidityETH` line 136-141 mirror. Both use `msg.sender` as the destination — correct (the original payer).

- **TegridyRouter.receive() (line 90-92)** is gated `msg.sender == WETH` — only the canonical WETH9 (set immutable in constructor) can deposit ETH into the router. Direct user/contract sends revert. Selfdestruct still bypasses, but the router's only ETH-flow path is `WETHFallbackLib.safeTransferETHOrWrap(WETH, msg.sender, refund)` (which uses balance-of-this for the deposit step) — donations don't leak into refunds because each leg of the lib opts into specific value paths.

- **TegridyNFTLending.acceptOffer / repayLoan** mirror TegridyLending's WETHFallbackLib usage on all three legs (lender, treasury, refund). Consistent.

- **CommunityGrants** uses its own `_transferETHOrWETH` (F-55-5 above) instead of the lib. The local copy is buggier (USDT-style WETH revert escape) but the contract's main exit path is gated by execution timelock + retry path, so a single failed transfer can be retried after fixing — soft-degradation rather than fund loss.

---

## Critical-path checklist (per task prompt)

1. ✅ Every contract with `receive()/fallback()`: surveyed. Bare receives in TegridyFeeHook, ReferralSplitter, VoteIncentives, TegridyNFTPoolFactory. Tracked receives in RevenueDistributor, POLAccumulator, SwapFeeRouter. Gated receive in TegridyRouter (WETH-only) and TegridyNFTPool (factory-only).

2. ✅ Force-feed via selfdestruct vs accounting: **F-55-13** documents the RevenueDistributor `address(this).balance > reserved` pattern. Documented natspec acknowledges. POLAccumulator's `accumulate` uses balance directly but is owner-gated. TegridyNFTPoolFactory's `withdrawProtocolFees` reads balance — F-55-10. ReferralSplitter's `sweepUnclaimable` reads balance - reserved — F-55-11. VoteIncentives `sweepExcessETH` reads balance - reserved — F-55-12. SwapFeeRouter `sweepETH` reads balance - reserved — safe (accumulatedETHFees is not balance-derived).

3. ✅ WETHFallbackLib gas stipend: 10k. **F-55-1** identifies the cold-SSTORE-overhead hazard against RevenueDistributor.receive(). All other receivers (POLAccumulator, treasury contracts) either fit comfortably or are not on the lib path.

4. ✅ msg.value validation: SwapFeeRouter `swapExactETHForTokens` line 693 (`if (msg.value == 0) revert`), TegridyDropV2.mint line 528 (`if (msg.value < totalCost) revert`), TegridyLending.makeOffer line 757-759 (range check), VoteIncentives.depositBribeETH line 717-719 (zero + min check), MemeBountyBoard.createBounty line 382 (min reward), CommunityGrants.createProposal — does NOT use msg.value (TOWELI-fee gated, not ETH-fee). POLAccumulator does not have a payable function for user input. All validated paths are sound.

5. ✅ msg.value consumed once: no multicall surface in audited contracts; each external payable function reads msg.value once. Refund logic uses `msg.value - usedAmount` which is single-consumption.

6. ✅ ETH refund safety: covered by F-55-8 (TegridyTWAP) and F-55-6 (MemeBountyBoard inconsistency). Most refund paths use WETHFallbackLib correctly.

7. ✅ Silent revert paths: TegridyTWAP.update refund (F-55-8) reverts loudly; that's not silent. The lib's `safeTransferETHOrWrap` reverts on both-legs-fail (`ETHTransferFailed` / `WETHTransferFailed`). NoRevert variant returns mode==2 (F-55-15) — not silent, but caller-handling-dependent.

8. ✅ Wrap/unwrap boundaries: TegridyRouter.swapExactETHForTokens line 235 wraps, line 257 unwraps. SwapFeeRouter `convertTokenFeesToETH` correctly unwraps post-swap via address(this).balance delta. TegridyFeeHook.claimFees line 519 unwraps WETH. **No double-wrap observed.**

9. ✅ ETH transfer in a loop: SwapFeeRouter.distributeFeesToStakers (line 1311) loops over three destinations (staker, POL, treasury). Failed legs route to `pendingDistribution` (pull pattern). VoteIncentives.claimBribes (line 810) loops over tokens; failed ETH leg routes to `pendingETHWithdrawals`. Both are DoS-resistant.

10. ✅ `transfer()` (gas:2300) not used anywhere in audited contracts. All pushes use `.call{value}`. Compatible with EIP-7702 / SCWs (subject to stipend choice — see F-55-6).

11. ✅ Dust accumulation in distribution: VoteIncentives explicitly tracks dust via `totalClaimedBribes` (line 849) but `sweepExcessETH` doesn't read it (F-55-12). RevenueDistributor's `_calculateClaim` integer-floor math leaves rounding dust permanently in the contract; sweepDust (line 869) treats it as sweepable to treasury — documented and bounded by the per-epoch math.

12. ✅ Distribute() ETH: SwapFeeRouter `distributeFeesToStakers` uses pull-pattern fallback (`pendingDistribution`) when push fails. RevenueDistributor `claim()` uses pull-pattern fallback (`pendingWithdrawals`) when push fails. **No push-only paths that DoS the entire distribution loop.** Consistent across the codebase.

---

End of agent_55_native_eth.md.
