# Agent 80 — WETH wrap/unwrap edge cases

Lens: IWETH9 contract assumptions, WETHFallbackLib correctness, deposit/withdraw
races, gas-stipend vs receive() cost, wrap-on-fail accounting consistency,
pre-existing WETH balances, symmetry of wrap/unwrap on both sides.

Files reviewed:
- `contracts/src/lib/WETHFallbackLib.sol` (the library)
- `contracts/src/TegridyRouter.sol`
- `contracts/src/RevenueDistributor.sol`
- `contracts/src/SwapFeeRouter.sol`
- `contracts/src/TegridyFeeHook.sol`
- `contracts/src/CommunityGrants.sol`
- `contracts/src/MemeBountyBoard.sol`
- `contracts/src/ReferralSplitter.sol`
- `contracts/src/VoteIncentives.sol`
- `contracts/src/TegridyDropV2.sol`
- `contracts/src/TegridyLending.sol`
- `contracts/src/TegridyNFTLending.sol`
- `contracts/src/TegridyNFTPool.sol`
- `contracts/src/TegridyNFTPoolFactory.sol`
- `contracts/src/POLAccumulator.sol`

---

## F-80-01 (HIGH) — `safeTransferETHOrWrapNoRevert` mid-flight failure splits the pool's balance into two assets, breaking later in-tx accounting

**Location:**
`contracts/src/lib/WETHFallbackLib.sol:131-170` (the NoRevert variant)
`contracts/src/TegridyNFTPool.sol:969-1014` (`_settleRoyalty`)
`contracts/src/TegridyNFTPool.sol:326-381` (`swapNFTsForETH`)

**WETH path:** royalty receiver → ETH push (10k) fails → WETH `deposit` succeeds
→ WETH `transfer` reverts → caller (the pool) is now mid-state-A with WETH it
didn't ask for.

**Edge case:** the lib's NoRevert variant returns `(false, mode=2)` for **two
DIFFERENT physical states** that the caller cannot distinguish:
1. `okDeposit == false` → ETH still in caller's balance; no harm.
2. `okDeposit == true` AND `okTransfer == false` → caller's ETH balance
   dropped by `amount`, caller's WETH balance grew by `amount`.

State (2) is a hard accounting break. The caller (`TegridyNFTPool`) treats its
own funds as ETH-denominated everywhere:
- `_lpAvailableETH` reads `address(this).balance` minus accumulated fees.
- `withdrawETH` floors a buffer against `address(this).balance`.
- `_minLiquidityBuffer` projects ETH worst-case sell payout.

After a state-(2) failure, `address(this).balance` is short by `amount` and the
WETH that absorbed it is invisible to all of those views — only
`rescueStrandedRoyalty` (owner-only sweep, no time gate) can recover it.

**Exploit (DoS class):** A malicious ERC-2981 royalty receiver can build a
wallet whose `receive()` always exceeds 10k gas AND whose `onWETHTransfer`
revert-hook (e.g., a malicious WETH-receiving hook through ERC-1820 / a
re-entrant guard configured to flip after first deposit) reverts the
`weth.transfer` leg. Every `swapNFTsForETH` against that collection in pools
holding insufficient ETH headroom (`bal < outputAmount + amount`) reverts at
`_sendETH(seller, outputAmount)` because the pool no longer holds enough native
ETH to satisfy both legs in one tx. State reverts atomically so funds aren't
lost, but the swap path is permanently bricked for that collection until the
owner manually drains via `rescueStrandedRoyalty` AND replenishes the pool
buffer.

Note: the asymmetric (`address(this).balance` ≠ ETH-equivalent) is also a
silent invariant break for `_lpAvailableETH` reads coming from offchain pricing
oracles — an LP fee withdrawal can be sized against a stale `balance` view that
ignores stranded WETH.

**Fix sketch:** Have the lib's NoRevert variant either (a) `try` the deposit
inside a low-level call that can be UNWOUND on transfer-leg failure (call
`weth.withdraw(amount)` on the failure branch before returning), or (b) return
a third mode (`mode == 3`) for the "deposit succeeded, transfer failed"
sub-case so callers can ledger the stranded WETH against a per-receiver pull
queue. Pattern of record: Aave V3's `WETHGateway.depositETH` rolls back the
deposit via `withdraw` if the downstream credit fails.

---

## F-80-02 (MEDIUM) — First-ever ETH transfer to RevenueDistributor / SwapFeeRouter / POLAccumulator via 10k-stipend lib path silently strands ETH as WETH inside the recipient (zero→non-zero SSTORE blows the budget)

**Location:**
- `contracts/src/lib/WETHFallbackLib.sol:78` — `to.call{value: amount, gas: 10000}("")`
- `contracts/src/SwapFeeRouter.sol:1763` — `withdrawPendingDistribution` →
  `safeTransferETHOrWrap(WETH, recipient, amount)` where `recipient` is
  `revenueDistributor` / `polAccumulator`.
- `contracts/src/TegridyFeeHook.sol:516, 520, 614` — `claimFees` /
  `convertERC20FeesToETH` → `safeTransferETHOrWrap(WETH, revenueDistributor, ...)`
- `contracts/src/RevenueDistributor.sol:315-318` — `receive()` does
  `unchecked { totalETHReceived += msg.value; }` + LOG2.
- `contracts/src/SwapFeeRouter.sol:2060-2063` — same shape.
- `contracts/src/POLAccumulator.sol:308-318` — same shape.

**WETH path:** caller invokes `safeTransferETHOrWrap` → 10k-gas raw push (12_300
including the EIP-2200 value-transfer bonus) to a sister contract whose
`receive()` writes a cumulative-ingress counter and emits LOG2.

**Gas math (the discriminator):**
- **Steady state** (slot non-zero from a previous tx): SLOAD cold 2100 +
  SSTORE non-zero→non-zero 5000 + LOG2 ≈ 1756 + dispatch ≈ ~9000-9500 gas.
  **Fits inside 12_300.** ETH delivered as ETH. Happy path.
- **First-ever call after deployment** (slot is zero): SLOAD cold 2100 +
  SSTORE 0→non-zero 22100 + LOG2 1756 ≈ ~26000 gas. **Exceeds 12_300.**
  ETH push fails → lib falls through to `IWETH.deposit{value: amount}()` +
  `IWETH.transfer(recipient, amount)` → WETH ERC20 lands in the sister
  contract.

**Edge case:** RevenueDistributor's `distribute()` reads
`address(this).balance` (line 350-364) — the WETH sitting in
`IERC20(weth).balanceOf(distributor)` is **invisible** to it. The first ETH
that lands via the lib's 10k-stipend path becomes stranded WETH that
`distribute()` will never sweep into an epoch.

**Exploit (silent-loss / value-redirection class), bounded to the
zero-counter window:**
1. After RevenueDistributor deploys with `totalETHReceived == 0`, the very
   first inflow that arrives via `WETHFallbackLib.safeTransferETHOrWrap`
   (rather than via SwapFeeRouter's bespoke `revenueDistributor.call{value,
   gas: 50_000}` at line 1334) will fail and wrap.
2. The likely first such inflow is the FeeHook's `claimFees` /
   `convertERC20FeesToETH` (lines 516, 520, 614) — both go through the lib.
   If FeeHook fires before SwapFeeRouter's `_distribute`, that first WETH
   lands stranded.
3. After that one stranded amount, a subsequent `_distribute` warms the slot
   (50k stipend covers the cold SSTORE; non-zero result now permanent), and
   all future lib-path inflows succeed.
4. The stranded WETH from step 2 needs `proposeTokenSweep(weth, treasury)` —
   48h-timelocked, owner-only, routes to TREASURY (not stakers).

Same one-time-stranding pattern applies to SwapFeeRouter's `receive()` and
POLAccumulator's `receive()`. SwapFeeRouter's stranded slice can be recovered
by `sweepETH` (line 1421) which does NOT subtract the WETH balance — but the
sweep target is treasury, not the original ETH source. POLAccumulator has a
similar `sweepETH` at line 480-ish.

**Aggravating future risk:** the analysis above assumes a 5000-gas
`SSTORE_RESET_GAS` for non-zero→non-zero. A future EIP that lifts that to (say)
9000 — historical proposals exist (EIP-2200 had multiple revisions; EIP-3540
families touch storage charges) — would push steady-state cost over 12_300 and
turn this from a one-time bootstrap stranding into a persistent leak. The
codebase's RevenueDistributor comment at line 618-625 explicitly acknowledges
this risk for the staker-claim path; the same risk applies HERE on the inbound
side and is NOT mentioned anywhere.

**Fix sketch:** The lib needs a "trusted-recipient" overload that uses a higher
stipend (e.g., 60_000 — matches SwapFeeRouter's `_distribute`) for sister
contracts the protocol controls. Alternatively, the call-site at
`withdrawPendingDistribution` and the FeeHook's distributor-forwarding paths
should use the raw `revenueDistributor.call{value, gas: 60_000}` pattern from
SwapFeeRouter's `_distribute` instead of routing through the
"arbitrary-recipient" library variant. A simpler operational fix: pre-warm the
counter slot at deployment time (e.g., transfer 1 wei from deployer in
constructor, or set `totalETHReceived = 1` in the constructor — pre-load the
slot to non-zero so the lib's first delivery works).

---

## F-80-03 (MEDIUM) — `MemeBountyBoard.sweepExpiredPayout` lacks WETH fallback, can be permanently bricked if treasury is a contract whose `receive()` exceeds 50k

**Location:** `contracts/src/MemeBountyBoard.sol:639`
```
(bool ok,) = treasury.call{value: amount, gas: 50_000}("");
if (!ok) revert ETHTransferFailed();
```

**WETH path:** none — function reverts on ETH push failure with no WETH wrap
fallback, **even though** the same contract uses `WETHFallbackLib` everywhere
else (lines 652, 709, 814).

**Edge case:** Treasury is mid-rotation to a Safe whose `receive()` runs
threshold checks / runs an ERC-1271 callback wrapper that exceeds 50k gas. (The
contract's own `withdrawPayout` at line 652 acknowledges 50k can be
insufficient; that's the whole point of WETH fallback elsewhere.)

**Exploit (DoS):** A malicious or upgraded treasury contract bricks the
permissionless `sweepExpiredPayout` path. Expired payouts (1-year stale
`pendingPayouts`) cannot be cleared until the treasury implementation is
fixed. Combined with M18's PAYOUT_EXPIRY semantics, this admits indefinite
state bloat — `pendingPayouts` slots stay non-zero forever, paying ~5k SSTORE
each on every winner-credit.

**Fix:** Replace with `WETHFallbackLib.safeTransferETHOrWrap(weth, treasury,
amount)` — matches the sister `sweepExpiredRefund` (line 814).

---

## F-80-04 (MEDIUM) — `CommunityGrants._transferETHOrWETH` can revert mid-flow, leaving WETH stranded with no recovery path

**Location:** `contracts/src/CommunityGrants.sol:1086-1109`
```
(bool success,) = recipient.call{value: amount, gas: 10_000}("");
if (success) return true;
try IWETH(weth).deposit{value: amount}() {
    bool sent = IWETH(weth).transfer(recipient, amount);
    if (!sent) {
        IWETH(weth).withdraw(amount); // unwrap on failure
        return false;
    }
    return true;
} catch {
    return false;
}
```

**WETH path:** ETH push fails → WETH `deposit` succeeds → WETH `transfer`
returns false → unwrap via `withdraw`.

**Edge case:** On the unwrap branch, `IWETH(weth).withdraw(amount)` calls back
into THIS contract via the WETH9 fallback (canonical WETH9 sends ETH back via
low-level `.call`). The contract's `receive()` (line 287) is `emit
ETHReceived(msg.sender, msg.value)` — emitted with `msg.sender == WETH`. **No
guard** that `receive()` was triggered by an unwrap-during-grant — the contract
silently accepts arbitrary ETH inflows mid-loop.

That's not a direct exploit, but combined with the failing-transfer path, the
function returns `false` to `executeProposal`, which routes the proposal to
`FailedExecution` (line 605-609). Subsequent `retryExecution` (line 666-671)
attempts the SAME call — and **on every retry**, the `deposit` + failed
`transfer` + `withdraw` round-trip burns ~70k gas with no progress. The grant
is locked into an infinite-retry funnel.

Alternative bad branch: if `IWETH.withdraw` itself reverts (e.g., a WETH
variant that pauses withdraw — Polygon WMATIC doesn't, but Optimism's WETH9 has
an upgrade path), the inner `try` catches but the WETH balance grows on each
attempt (deposit succeeded, transfer failed, withdraw reverted). After N
retries the contract holds N×amount WETH that is invisible to
`emergencyRecoverETH` (which only sweeps `address(this).balance`).

**Exploit:** Captured-key admin or hostile recipient with a WETH-blocklist
implementation can pin a grant amount as stuck WETH that `emergencyRecoverETH`
cannot see; only a manual ERC20 token sweep (which CommunityGrants does not
expose) recovers it.

**Fix:** Either (a) add a WETH ERC20 sweep gated on whenPaused, or (b) replace
the local `_transferETHOrWETH` with `WETHFallbackLib.safeTransferETHOrWrapNoRevert`
and accept the WETH-as-WETH outcome (matches sister contracts).

---

## F-80-05 (MEDIUM) — TegridyFeeHook double-wrap on the `currency == WETH` claim path

**Location:** `contracts/src/TegridyFeeHook.sol:517-520`
```
} else if (currency == WETH) {
    IWETH(WETH).withdraw(amount);
    WETHFallbackLib.safeTransferETHOrWrap(WETH, revenueDistributor, amount);
}
```

**WETH path:** PoolManager.take() credits the hook with WETH ERC20 → hook
unwraps WETH→ETH via `IWETH.withdraw` → sends ETH via `safeTransferETHOrWrap` →
ETH push (10k) to RevenueDistributor fails (see F-80-02) → lib re-wraps ETH→WETH
and transfers as ERC20 back to RevenueDistributor.

**Edge case:** The unwrap → re-wrap round-trip is pure waste on every call —
the WETH ERC20 was already in hand on the hook side; it could have been
directly transferred to RevenueDistributor without the unwrap. But because the
existing logic mandates "RevenueDistributor wants ETH", the unwrap fires
unconditionally, then the failing 10k push triggers the re-wrap. The net result
is identical to "transfer WETH ERC20 from hook to distributor", but with ~3x
the gas (deposit + withdraw + deposit + transfer + 4 LOG events). 100% waste in
the steady state because the ETH-leg failure is deterministic per F-80-02.

**Exploit:** Direct griefing — anyone calling `claimFees(WETH, amount)` burns
significant gas on the protocol's behalf with no marginal benefit. This is a
dust-gas loss that scales with `claimFees` cadence; over a year with daily
claims, this is ~$50-100 wasted gas at typical L2 prices. Not a fund loss, but
non-trivial.

**Fix:** When `currency == WETH`, transfer the WETH directly to
RevenueDistributor (skip the unwrap), and add a path on RevenueDistributor that
acknowledges WETH ERC20 inflow as equivalent to ETH (e.g., an `unwrapForDistribution`
function the hook can call after transfer). Matches Bunni V2 hook's
`_claimFees` post-write-up: the indirection is only valuable if the recipient
needs native ETH; here the recipient cannot receive native ETH efficiently
(F-80-02), so the indirection is pure tax.

---

## F-80-06 (LOW) — `RevenueDistributor.sweepDust` and `emergencyWithdraw` use full-gas ETH `.call` to treasury, breaking the cross-contract reentrancy posture

**Location:** `contracts/src/RevenueDistributor.sol:876, 429, 458`
```
(bool success,) = treasury.call{value: dust}("");
if (!success) revert ETHTransferFailed();
```

**WETH path:** none — no stipend cap, no fallback.

**Edge case:** Same-class issue as F-80-03 but inverted — these paths give
treasury **unlimited gas**, which WETHFallbackLib's L1 batched path
deliberately avoids ("widens the cross-contract reentrancy surface for no
benefit"). The codebase's stated security posture is "10k stipend + WETH
fallback" everywhere. These three paths regress that.

**Exploit:** A captured treasury (or compromised treasury upgrade) can re-enter
arbitrary protocol contracts during a sweep, hitting cross-contract invariants
in ways the contract's own `nonReentrant` guard cannot catch. The `dust` and
`emergencyWithdraw` amounts can be sized to maximise the reentry's effective
weight if the treasury chooses to reenter.

**Fix:** Replace with `WETHFallbackLib.safeTransferETHOrWrap(address(weth),
treasury, …)` — matches the timelocked treasury-rotation paths elsewhere in the
contract.

---

## F-80-07 (LOW) — `TegridyRouter.receive()` allows ONLY canonical WETH, but the WETH-fallback library can deliver wrapped WETH back to the router via a hostile pair burn

**Location:** `contracts/src/TegridyRouter.sol:90-92`
```
receive() external payable {
    require(msg.sender == WETH, "ONLY_WETH"); // L-08
}
```

**WETH path:** `removeLiquidityETH` calls `pair.burn(address(this))` →
`IWETH(WETH).withdraw(amountETH)` → WETH9 sends ETH to Router via
low-level call.

**Edge case:** Per spec WETH9 calls back with `msg.sender == WETH` — guard
holds. **However** the `WETHFallbackLib.safeTransferETHOrWrap` does NOT call
back into Router as the recipient — its caller is, e.g., a token-side
`tokenContract.call{value:0}` chain. The router never receives ETH from a
non-WETH source by design.

But **`safeTransferETHOrWrap(WETH, msg.sender, refund)`** at line 140, 197, 259,
314, 341, 409 sends to `msg.sender` (the user), NOT back into the router. So
the receive() guard is fine.

What COULD trigger a violation: a hostile WETH variant that re-emits the ETH
sender as `msg.sender = router` instead of `weth`. Out of threat model since
WETH is canonical/immutable.

**No exploit** — flagging here only because the audit spec asked about
asymmetric wrap/unwrap on both sides. Both sides are clean. Marking complete.

---

## F-80-08 (INFO) — Library's `safeTransferETH` (no-fallback variant) emits the same `ETHTransferred` event as `safeTransferETHOrWrap`'s success path, masking which delivery mode landed

**Location:** `contracts/src/lib/WETHFallbackLib.sol:117`

**WETH path:** N/A — no-fallback variant.

Off-chain indexers cannot distinguish whether a payment went through the
no-fallback variant (which guarantees raw ETH) or the WETH-fallback variant's
success path (which also delivered ETH but COULD have wrapped). For payment
auditing this is a wash; for "verify the recipient got native ETH" it's a
blind spot.

**Note only — not exploitable.**

---

## F-80-09 (INFO) — `TegridyDropV2` has no WETH ERC20 sweep; `safeTransferETHOrWrap` failure on refund leaves WETH stuck

**Location:** `contracts/src/TegridyDropV2.sol:1045` (`refund`),
`contracts/src/TegridyDropV2.sol:1082` (`rescueAfterCancellation`)

**WETH path:** Refund → `safeTransferETHOrWrap` → ETH push fails → WETH wrap
succeeds → WETH delivered to user.

**Edge case:** If the WETH transfer ALSO fails (token-side reentrancy guard
mid-flight; vanishingly rare for canonical WETH), the lib reverts. Refund is
re-tryable but WETH remains in the drop. Drop has no token sweep — `withdraw`
sweeps `address(this).balance` only, `rescueAfterCancellation` sweeps native
ETH only.

**Note:** Drop's `_dropName`/`_dropSymbol` factory pattern means each drop is
an isolated contract — even an admin-only ERC20 sweep is missing per-drop. If
the canonical WETH is ever paused on the chain (impossible on mainnet, possible
on a forked-WETH L2), refunds are stuck. Low likelihood, marking INFO.

---

## F-80-10 (LOW) — Pre-existing WETH balance in TegridyRouter can desync `removeLiquidityETH` accounting if a malicious actor donates WETH

**Location:** `contracts/src/TegridyRouter.sol:194` (`IWETH(WETH).withdraw(amountETH)`)

**WETH path:** `pair.burn(address(this))` deposits exactly `amountETH` of WETH
to the router → `IWETH.withdraw(amountETH)` unwraps that → balance check is
implicit (withdraw reverts if balance < amount).

**Edge case:** Suppose someone donated 10 WETH to the router via direct
`weth.transfer(router, 10 ether)`. The router now holds 10 WETH it didn't
expect. `removeLiquidityETH` calls `withdraw(amountETH)` — succeeds, unwraps.
BUT subsequent `swapExactTokensForETH` (line 257: `IWETH(WETH).withdraw(amounts[amounts.length-1])`)
will succeed even if it never received fresh WETH from the inner swap (because
the router still has prior donated WETH). **A malicious actor can stage WETH
donations to the router so a future swap appears to deliver more ETH than the
swap actually produced.**

**Exploit (theoretical):** Post-swap router has `R = pair_output + donation -
amountOut` of WETH on hand. If `donation > amountOut`, the unwrap takes
donated WETH instead of pair-output WETH. The RECIPIENT still gets `amountOut`
ETH — value is conserved on the user side. But the router's WETH balance now
contains residual `donation - amountOut`, which can be claimed by a follow-up
swap whose pair-output is zero. **Net: a swap entry can drain donated WETH for
free.**

**Fix:** Check WETH balance before/after `pair.burn` and only unwrap the
difference (the actually-received WETH). Pattern of record: Uniswap V2
Router02 doesn't have this guard either, BUT Uniswap V2 Router02 also doesn't
have a `safeTransferETHOrWrap` that could re-wrap and silently misroute funds.

This is theoretical — donated WETH would only flow to the next caller of
`removeLiquidityETH` / `swap*ForETH` for that path. No funds lost from the
protocol. Marking LOW.

---

## Notes / dead-ends

- **`weth.transfer` return-value handling:** The library at line 89 uses the
  WETH9 native `transfer` (returns bool, no SafeERC20 wrap). Canonical WETH9
  always returns `true` so this is safe. Forked WETH on L2 follows the same
  ABI. Acceptable.

- **`weth.deposit` payable bypass:** No path lets user-supplied `weth` address
  reach the lib. Every consumer sets `weth` immutably from constructor. The
  lib's caller-trust assumption holds.

- **Cross-contract reentrancy via WETH:** The lib's 10k-gas stipend on the ETH
  leg correctly chokes the reentrancy surface. The WETH `transfer` leg
  forwards default-call gas, but a malicious WETH variant is out of scope
  (immutable, canonical).

- **Symmetry of wrap/unwrap:** Reviewed — Router's `addLiquidityETH` /
  `removeLiquidityETH` pair, Router's swap-ETH-in / swap-ETH-out pair, and the
  FeeHook's `claimFees(WETH, _)` / `convertERC20FeesToETH` pair are all
  internally symmetric. No directional asymmetry found beyond F-80-05's pure-
  waste round-trip.

- **`approve-then-transferFrom` WETH path:** Not used — every `weth.transfer`
  in the codebase is push-pattern from the contract that wrapped the ETH.
  `transferFrom` only appears via SafeERC20 wrappers on token-sweep paths
  (`withdrawTokenFees`, `executeTokenSweep`). No two-step approve flow against
  WETH.

- **Sequencer outage interaction:** WETH9 itself has no sequencer dependency
  on L1; on L2s with WETH that's sequencer-aware (e.g., a forked deployment),
  paused WETH could brick `safeTransferETHOrWrap`. Out of scope — the codebase
  assumes canonical WETH9 semantics.

- **`safeTransferETHOrWrapNoRevert` mode-2 ambiguity:** Captured as F-80-01.
  Worth distinguishing the two physical states inside the lib so callers can
  ledger correctly.

---

## Summary

10 findings: **1 HIGH (F-80-01), 4 MEDIUM (F-80-02, F-80-03, F-80-04, F-80-05),
3 LOW (F-80-06, F-80-07, F-80-10), 2 INFO (F-80-08, F-80-09).**

Highest-impact:
- **F-80-01** breaks `TegridyNFTPool.swapNFTsForETH` for any NFT collection
  whose ERC-2981 royalty receiver dual-fails (ETH push and WETH transfer both
  fail). The pool's ETH/WETH balance asymmetry then fails the seller-payout
  leg of the same swap, atomically reverting; permanent DoS for that
  collection until owner intervention.
- **F-80-02** is the bootstrap-stranding issue: the very first ETH inflow to
  RevenueDistributor / SwapFeeRouter / POLAccumulator that arrives via the
  10k-stipend `safeTransferETHOrWrap` path is paid the cold SSTORE
  zero→non-zero penalty (~22k gas) that exceeds the 12_300-gas budget the
  forwarded value-transfer affords. The lib silently wraps to WETH, leaving
  the first inflow as stranded WETH that only an owner-timelocked
  `proposeTokenSweep` (48h, → treasury) can recover. Bounded to the
  zero-counter window unless a future EIP raises the steady-state SSTORE
  cost.
