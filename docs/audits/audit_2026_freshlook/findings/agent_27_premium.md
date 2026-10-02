# Agent 27/100 — PremiumAccess.sol Fresh-Eyes Audit

**Scope:** `contracts/src/PremiumAccess.sol` (~639 LoC) — TOWELI-paid subscription
gate, JBAC NFT free-access path, pro-rata refund and shortfall accounting,
treasury / fee timelock, batch reconciliation. Inline base contracts checked:
`OwnableNoRenounce`, `TimelockAdmin`. Downstream consumer cross-check:
`SwapFeeRouter` (uses `hasPremiumSecure`).

**Method:** Fresh read without consulting prior `.md` audit history. Inline
comments reference earlier finding IDs (M-13, M-14, M-18, M-36, M-43, H-04,
H-06, H-10, R014, R022, L-04, PA-M-01, PA-M-02, PA-L-01, PA-L-02, DEEP-DR-M-05,
DEEP-DR-M-06, DEEP-DR-L-05, V2-DR-L-03, V3-DR3-M-02, PASS5-PA-L1, A4-C-02,
A4-H-08). Every claim is re-checked against the present code; only issues with
a concrete code-path drift or new gap are reported.

---

## F-27-K-01 — `getSubscription()` returns flash-loan-spoofable `lifetime`/`active` flags that bypass the 15s activation gate enforced by `hasPremium()` (MEDIUM, integrator-trap)

**Where:**
- `getSubscription` (line 623-628):
  ```solidity
  bool nftHolder = jbacNFT.balanceOf(user) > 0;
  return (sub.expiresAt, nftHolder, nftHolder || sub.expiresAt > block.timestamp);
  ```
- vs. `hasPremium` (line 174-184) which requires
  `nftActivationBlock[user] != 0 && block.timestamp > activation + MIN_ACTIVATION_DELAY (15s)`.

**Mechanic:** the contract carefully gates NFT-based premium in `hasPremium` by
requiring a prior-block `activateNFTPremium()` call (the A4-C-02 mitigation —
"activation persists, only needs to be done once while holding the NFT"). The
purpose is documented at length: prevent a same-tx flash-borrow of the JBAC
NFT from trivially flipping `hasPremium` to true. `getSubscription`,
however, omits BOTH the activation-timestamp check AND the
`MIN_ACTIVATION_DELAY` gate — it returns `nftHolder = balanceOf > 0` directly.

**Consequence:** `getSubscription` is **strictly weaker** than the documented
`hasPremium` path. Specifically:
1. `lifetime` flag is true for any current `balanceOf > 0` holder including a
   same-tx flash-borrower who has NEVER called `activateNFTPremium`.
2. `active` flag inherits from `lifetime`, so it too is flash-spoofable.

**Why this matters:** the contract's H-10 NatSpec explicitly warns external
integrators "Do NOT use `hasPremium()` for on-chain gating of valuable
actions. Use `hasPremiumSecure()` instead." It does NOT carry the same
warning on `getSubscription`. A naive integrator reading the (publicly named,
documented) `getSubscription` view to gate fee discounts / yield boosts /
priority queue access would be flash-loan exploitable AND would lack even
the 15-second activation delay that `hasPremium` enforces.

**Severity:** MEDIUM — the function exists, is named like a primary integrator
view, has no flash-loan warning in its NatSpec, and is strictly worse than
`hasPremium`. The bound is the worst case across all integrators that
might use it; the in-tree `SwapFeeRouter` correctly uses `hasPremiumSecure`,
so present blast radius inside Tegriddy is zero. External integrators are
the population at risk.

**Suggested fix (one of):**
- (a) Mirror the `hasPremium` activation-and-delay check inside
  `getSubscription` so all three return slots agree.
- (b) Add a NatSpec @notice block on `getSubscription` matching H-10's
  prominent integrator-warning, and ideally rename the field from `lifetime`
  to `nftHolder` to remove the "permanent access" misimpression.
- (c) Most defensible: also expose the activation timestamp in the return
  tuple so integrators can apply their own staleness policy.

**Confidence:** HIGH on the divergence (it's literally three view paths with
different semantics). MEDIUM on impact, since it is integrator-conditional.

---

## F-27-K-02 — `hasPremium()` 10-minute "marketplace grace window" documented in PA-L-02 is a no-op: `hasPremium` re-checks `balanceOf > 0` live, defeating the grace (DOC/CODE MISMATCH, LOW informational)

**Where:**
- `deactivateNFTPremium` (line 231-238): only allows clearing
  `nftActivationBlock` after `activationBlock + 10 minutes`.
- `hasPremium` (line 178): requires `jbacNFT.balanceOf(user) > 0` AS WELL AS
  the activation timestamp gate.
- PA-L-02 NatSpec (line 219-229): claims that during the 10-minute grace
  "after the user no longer holds the NFT, `hasPremium(user)` will still
  report true if their `nftActivationBlock` is past `MIN_ACTIVATION_DELAY`."

**Mechanic:** the doc claims marketplace-flow smoothing — list NFT, brief
escrow, hold — keeps premium active for 10 minutes despite balance==0. The
code does NOT match: the very first conjunct of `hasPremium` is
`balanceOf(user) > 0`. The moment balance drops to zero (NFT in marketplace
escrow contract), `hasPremium` returns false REGARDLESS of activation
timestamp. The 10-minute window only delays when ANOTHER party can clear
the user's `nftActivationBlock` slot, not when premium becomes inactive.

**Consequence:**
- The only observable effect of the 10-minute grace is that `nftActivationBlock`
  storage stays non-zero for 10 minutes after the user loses the NFT — which
  matters only in the (already documented as known-vulnerable) flash-loan
  re-borrow scenario described in H-10.
- A user listing on a marketplace WILL lose `hasPremium` immediately, contrary
  to the PA-L-02 NatSpec promise.
- This makes the entire 10-minute window's stated rationale ("don't yank a
  user's premium UX during an in-flight marketplace transaction") factually
  incorrect for `hasPremium` consumers.

**Severity:** LOW — pure documentation drift that misleads operators about
what user-flows are smoothed. Either remove the doc claim or move the
`balanceOf` check behind a `OR (within grace)` clause to actually deliver
the documented behaviour. (Note: doing the latter would re-open H-10's
flash-loan window during the grace, so the cleanest fix is to update the
docstring.)

**Confidence:** HIGH on the mismatch. Severity LOW because it doesn't cause
loss; it causes operator/integrator confusion.

---

## F-27-K-03 — JBAY Gold (0x6Aa03F42c5366E2664c887eb2e90844CA00B92F3) is documented in protocol scope as a free-access NFT but is NOT honored anywhere in PremiumAccess.sol (SCOPE/IMPLEMENTATION GAP, INFORMATIONAL)

**Where:**
- Constructor (line 136): only takes `_jbacNFT` as the NFT registry argument.
- `hasPremium` (line 178), `getSubscription` (line 625), `activateNFTPremium`
  (line 209), `deactivateNFTPremium` (line 234): all reference the single
  `jbacNFT` immutable.
- No second NFT registry slot exists; there is no `jbayGold` or equivalent.

**Mechanic:** the audit-task scope explicitly lists JBAY Gold
(0x6Aa03F42c5366E2664c887eb2e90844CA00B92F3) alongside JBAC as a documented
free-access path. The contract code in the present worktree implements only
JBAC. Either:
1. The scope description is stale and JBAY Gold was removed from the design
   intentionally — in which case the documentation should be updated.
2. JBAY Gold integration was forgotten and holders of that NFT will not get
   the documented premium access — a billing/UX bug, not a security bug per
   se, but worth flagging because it could create disputes when JBAY Gold
   holders find they are paying TOWELI fees they thought they wouldn't.

**Severity:** INFORMATIONAL — depends entirely on which side of the divergence
is "truth". If JBAY Gold should be honored, this is a missed feature, not a
vulnerability. If it shouldn't, the audit-scope doc / project README needs to
be corrected.

**Confidence:** HIGH on the absence in code. Confidence on whether-it-should-
exist is N/A (depends on product decision).

---

## F-27-K-04 — `cancelSubscription` `totalDuration == 0` branch (line 389, line 441) is unreachable in practice but documented as live behaviour (LOW informational, dead-code drift)

**Where:**
- `cancelSubscription` line 389:
  ```solidity
  uint256 refundAmount = totalDuration == 0 ? escrowed : (escrowed * remainingTime) / totalDuration;
  ```
- Line 441-443: identical short-circuit on `fullRefundable`.
- Inline AUDIT-FIX-v3 comment claims this handles "cancelled in same block as
  subscription".

**Mechanic:** `totalDuration = sub.expiresAt - sub.startedAt`. Trace both write
paths in `subscribe`:
- New-sub branch (line 349-350): `expiresAt = block.timestamp + months * MONTH`
  with `months >= 1` and `MONTH = 30 days`. `startedAt = block.timestamp`. So
  `expiresAt - startedAt = months * MONTH ≥ 30 days > 0`.
- Extension branch (line 339-340): `expiresAt = sub.expiresAt(old) + months * MONTH`
  where `sub.expiresAt(old) > block.timestamp` (extension requires non-expired).
  `startedAt = block.timestamp`. So
  `expiresAt - startedAt = (oldExpiresAt - block.timestamp) + months * MONTH > months * MONTH > 0`.

`cancelSubscription` requires `sub.expiresAt > block.timestamp` and
`block.timestamp >= sub.startedAt + MIN_HOLDING_PERIOD (= 1 day)`, so on
entry `totalDuration ≥ remainingTime + MIN_HOLDING_PERIOD > 0`.

**Consequence:** the `totalDuration == 0` branch in both line 389 and line
441 cannot fire under any reachable state. This is benign defense-in-depth
but the comment ("cancelled in same block as subscription") is FACTUALLY
WRONG since same-block cancellation is rejected by `SAME_BLOCK_CANCEL`
(line 377) and `MinHoldingNotMet` (line 381). A future refactor that
relaxes either guard could trigger surprising behaviour from this dead
branch (which would hand out FULL refund regardless of consumed time).

**Severity:** LOW — dead defensive code with misleading comment. Either:
- Drop the `totalDuration == 0 ? ...` ternary entirely (it is unreachable),
  OR
- Update the AUDIT-FIX-v3 comment to read "defensive guard for future
  refactors that relax the holding-period gate".

**Confidence:** HIGH on unreachability under current guards. Severity LOW
because it does not create exploit today.

---

## F-27-K-05 — `withdrawToTreasury` reverts hard if treasury address is a contract that fails `transfer`, requiring a 48h timelock cycle to recover (LOW operational, no fix recommended without product input)

**Where:**
- `withdrawToTreasury` (line 501-512):
  ```solidity
  if (withdrawable > 0) {
      toweli.safeTransfer(treasury, withdrawable);
  }
  ```
- Treasury rotation must go through `proposeTreasuryChange` (48h timelock,
  line 597-602) → `executeTreasuryChange` (line 613-619).

**Mechanic:** if the live `treasury` is a contract that reverts on
TOWELI receipt (paused, blacklisted, custom transfer hook), every call to
`withdrawToTreasury` reverts. Funds remain in the contract; the only way
to redirect is a 48-hour timelock cycle. During those 48 hours, NEW
subscription revenue continues to accumulate but is non-extractable.

**Consequence:** owner-side liveness DoS, recoverable in 48h. NOT a fund
loss — escrow accounting is unchanged and `claimShortfall` /
`cancelSubscription` still work because they call `safeTransfer` to
the user, not to the treasury.

**Severity:** LOW — recoverable, no fund loss, owner-only blast radius.

**Suggested mitigations (if product wants to harden):**
- Defensive try/catch in `withdrawToTreasury` so a single bad treasury
  rotation doesn't strand the call (would need design discussion — silent
  no-op vs. event-only signal).
- Validate treasury contract in `proposeTreasuryChange` via an EOA-or-
  accept-token sanity check.

**Confidence:** HIGH on the path. LOW priority.

---

## F-27-K-06 — `subscribe()` does not protect against fee-on-transfer behaviour on `toweli`; `userEscrow` over-credits if TOWELI is ever upgraded to a fee-on-transfer model (LOW, future-proofing)

**Where:**
- `subscribe` line 258: `toweli.safeTransferFrom(msg.sender, address(this), cost);`
- Subsequent line 351: `userEscrow[msg.sender] = cost;` — uses INPUT amount,
  not received amount.

**Mechanic:** if TOWELI is or becomes a fee-on-transfer ERC-20 (e.g., through
a future upgrade or proxy swap), `safeTransferFrom(msg.sender, address(this), cost)`
will deliver `cost - feeOnTransfer` to the contract, but `userEscrow[msg.sender] = cost`
records the FULL input. `totalRefundEscrow += cost` likewise inflates. On
later cancel, the user is owed up to `cost` while only `cost - fee` is
actually held → contract becomes insolvent and `cancelSubscription`'s
`contractBalance` cap fires, recording shortfalls.

**Consequence:**
- Insolvency emerges quietly via the DEEP-DR-M-05 shortfall path. The
  `RefundShorted` event and shortfall queue are designed to handle short-
  term insolvency from accidental balance drains, BUT a chronic FoT model
  would route every cancellation through shortfall, eventually exceeding
  the contract's revenue float.
- User-perceived refunds would be reliably less than what `userEscrow`
  reports.

**Severity:** LOW — TOWELI is the protocol-native token and is NOT FoT today.
This is purely future-proofing (a token-upgrade footgun). The shortfall
queue at least makes the failure mode loud (RefundShorted event), so
this is monitorable rather than silent.

**Suggested fix (only if FoT TOWELI is a future possibility):** measure
balance pre/post safeTransferFrom and use `received = post - pre` as the
basis for `userEscrow`. Standard SushiSwap / Uniswap pattern.

**Confidence:** HIGH on the absence of FoT handling. LOW priority because
TOWELI's fee model is controlled by the same protocol.

---

## F-27-K-07 — `deactivateNFTPremium()` is permissionless and can grief NFT holders who momentarily lose balance (LOW griefing, recoverable)

**Where:**
- `deactivateNFTPremium` line 231-238: NO `onlyOwner`, NO holder check.
  Anyone can call for any user; only the
  `balanceOf(user) == 0 && now > activation + 10 min` predicate gates the
  state-clear.

**Mechanic:** Alice activates NFT-premium legitimately. Alice lists JBAC NFT
on a marketplace (escrow contract holds it briefly). After 10 minutes Alice
de-lists and reclaims the NFT. Bob, who has zero stake here, watches mempool
and front-runs the de-list with a `deactivateNFTPremium(alice)` call. Bob's
call succeeds (balanceOf(alice)=0 during list, 10 minutes elapsed). Alice
re-lists fail / Alice reclaims; Alice's `nftActivationBlock = 0`. Alice
must re-activate (≈30k gas, plus a 15-second wait before `hasPremium`
returns true again).

**Consequence:** transient (≤ ~30 seconds) loss of premium gating during
the next 15 seconds after Alice re-activates. Cost to Alice: one
`activateNFTPremium` tx (≈30k gas). Cost to Bob: one
`deactivateNFTPremium` tx (≈30k gas). 1:1 grief economy — UNECONOMICAL
for Bob unless Bob is racing a specific tx that Alice's premium would
otherwise gate.

**Severity:** LOW — the function is intentionally permissionless (cleanup
griefing-resistance, per PA-L-02 commentary), and the grief is reversible.
The narrow scenario where this matters is a user racing a high-MEV swap
through `SwapFeeRouter`'s premium discount path — but that path uses
`hasPremiumSecure` which IGNORES the NFT activation entirely (it's
subscription-only). So in-tree this attack has zero economic impact.

**Confidence:** HIGH on permissionlessness, LOW on impact (no in-tree
consumer of NFT-based `hasPremium` for valuable gating today).

---

## F-27-K-08 — `claimShortfall` reverts with `NothingToClaim()` when `available == 0` even though the user still has a non-zero `shortfallOwed`; semantics is "balance unavailable", not "nothing owed" (LOW UX/event-stream)

**Where:**
- `claimShortfall` line 525:
  ```solidity
  if (available == 0) revert NothingToClaim();
  ```
- The same error selector is used at line 520 for the genuine "owed == 0" case.

**Mechanic:** two distinct conditions ("user is owed nothing" vs. "user is
owed something but contract is currently insolvent for that amount") return
the same revert selector. Off-chain monitoring / Tenderly alerts cannot
distinguish these without re-reading `shortfallOwed[user]`.

**Consequence:** UX confusion + monitoring gap. A user with a pending
shortfall will see `claimShortfall` revert with the same reason as a user
who never had one, even though their state is fundamentally different (the
contract still owes them, they should re-try later).

**Severity:** LOW — pure UX / event-stream issue. No accounting drift,
no fund loss, no exploit.

**Suggested fix:** add a distinct error type, e.g.,
`error InsufficientContractBalance(uint256 owed, uint256 available);`
emitted on the `available == 0` path. Front-end can then show "shortfall
pending — contract balance too low, retry later" instead of conflating
with "you have no shortfall".

**Confidence:** HIGH.

---

## F-27-K-09 — `_deprecated_paidFeeRate_slot` legacy mapping is exposed via `getDeprecatedPaidFeeRate` (line 636-638) but is never written by the current code, so on a fresh deployment it ALWAYS returns 0 — the comment claims "off-chain analytics can use this to recover historical fee-rate data for legacy subscribers", which is true only on a CONTRACT-UPGRADED-FROM-OLDER instance, not a freshly deployed one (LOW, doc/clarity)

**Where:**
- Storage slot declared private at line 64.
- View at line 636-638 reads the slot.
- PA-M-02 commit removed all WRITES to this slot. New deployments will have
  it always-zero.

**Mechanic:** the comment on line 630-635 ("read-only view onto the
orphaned `_deprecated_paidFeeRate_slot`...legacy subscribers") implies
the view is meaningful. On a freshly deployed instance, no user will
have a non-zero value here because no code path ever writes to it.

**Consequence:** confusion for off-chain dashboards that wire this view,
expecting it to populate over time. It will never populate on fresh
deployments. On an upgrade-in-place scenario, it preserves pre-upgrade
data only.

**Severity:** LOW — minor doc clarity. No security impact.

**Suggested fix:** clarify in the NatSpec that this view is meaningful
ONLY on instances that were upgraded from a pre-PA-M-02 deployment;
fresh deployments will return zero for all addresses.

**Confidence:** HIGH on the always-zero behaviour; severity LOW.

---

## Notes / Dead-Ends Investigated (no finding)

The following candidate vectors were checked and found correctly mitigated.
Listed for completeness so a reviewer can confirm the negatives:

1. **Same-block subscribe-then-cancel free-premium window**:
   `SAME_BLOCK_CANCEL` guard (line 377) plus `MIN_HOLDING_PERIOD = 1 days`
   (line 381 / R014) closes both same-block and next-block cancel-arbitrage.
   The R014 fix is the load-bearing one; SAME_BLOCK_CANCEL alone was
   bypassable by waiting one block.

2. **Extension at lower fee → cancel at refund-windfall** (rate-lock
   arbitrage): mitigated by DEEP-DR-L-05 — extensions inherit the same
   24-hour MIN_HOLDING_PERIOD.

3. **`totalRevenue` double-decrement across `cancelSubscription` →
   `claimShortfall`**: V3-DR3-M-02 fix correctly drops the second decrement.
   Traced: cancel decrements by full `fullRefundable` (not just immediate
   payout), and `claimShortfall` no longer touches `totalRevenue`. Counter
   is consistent — every TOWELI in is counted once at first ingress.

4. **Extension `totalRevenue` over-counting on consumedEscrow**: PASS5-PA-L1
   correctly removes the duplicate increment. Original `cost1` is counted
   at first subscribe; extension adds `cost2`; consumed slice is NOT
   double-counted.

5. **Extension formula refund-windfall (DEEP-DR-M-06)**: traced numerically.
   `userEscrow = cost + remainingEscrow` with new `(startedAt, expiresAt)`
   anchor produces a refund-on-immediate-cancel that matches per-period
   pro-rata of the new period — the unconsumed pre-extension portion is
   correctly carried forward, not minted as a windfall.

6. **`reconcileExpired` race with `cancelSubscription`**: both functions are
   `nonReentrant`, mutate the same slots. Worst case: cancel beats
   reconcile and refund happens; reconcile's idempotent early-exit
   (`if (escrow == 0) return;`) prevents double-decrement of
   `totalRefundEscrow`. PA-L-01 added `nonReentrant` to `reconcileExpired`
   for parity.

7. **`subscribe` `months` overflow / rounding to year-9999**: BATCH-I M23
   caps `months <= 120`. Realistic prepayment horizon covered; overflow
   blocked.

8. **`maxCost` front-running (M-11)**: `cost <= maxCost` check is present
   (line 256). No bypass via signed messages or signatures.

9. **Flash-loan NFT borrow → `hasPremium = true`** (H-10): explicitly
   documented as a known accepted limitation. Internal consumers
   (`SwapFeeRouter`) correctly use `hasPremiumSecure`. External integrators
   are warned in the H-10 NatSpec — though see F-27-K-01 above for
   `getSubscription`'s missing equivalent warning.

10. **Subscribe with extension while paused**: `subscribe` is
    `whenNotPaused`; `cancelSubscription` is intentionally NOT paused
    (M10 — subscribers can always recover refund during emergencies).
    Verified the asymmetry is intentional and consistent with refund
    invariant.

11. **`activateNFTPremium` re-call to extend grace**: confirmed it merely
    resets `nftActivationBlock` to `block.timestamp`, requiring another
    15-second wait for `hasPremium` to flip true again. Not exploitable.

12. **`receive()` / `fallback()` ETH path**: NEITHER is declared, so direct
    ETH sends revert. Good.

13. **Treasury / fee timelock bypass via `MAX_DELAY` evasion**:
    `FEE_CHANGE_DELAY = 24h`, `TREASURY_CHANGE_DELAY = 48h`, both within
    the `[1 hour, 30 days]` band enforced by TimelockAdmin's `_propose`
    floor/ceiling. No bypass.

14. **`pause()` → infinite admin lockout**: `unpause()` is owner-controlled
    and not subject to timelock. The `OwnableNoRenounce` base correctly
    blocks `renounceOwnership()`. Owner cannot brick admin.

15. **Subscriber counter drift**: traced multi-cycle (subscribe → expire →
    re-subscribe without reconcile, subscribe → cancel → re-subscribe,
    reconcileExpired idempotency). All paths preserve
    `totalSubscribers` invariant. L-04 fix is intact.

16. **Ghost subscription via direct TOWELI donation**: a malicious user
    transferring TOWELI directly to the contract does NOT update any
    user's `userEscrow` or subscription state — no spoofing path. The
    donation just feeds `withdrawToTreasury`'s withdrawable balance
    (after `reserved = totalRefundEscrow + totalShortfallOwed` is
    carved out).

17. **`tx.origin` use**: confirmed absent. All subscriber-attribution uses
    `msg.sender` (no phishing-style origin spoofing).

18. **Gift subscription**: not implemented. `subscribe` always credits
    `msg.sender`. No DoS-via-wrong-recipient vector exists because no
    such param exists.

19. **Receive ETH**: not payable. ETH cannot be sent to the contract
    accidentally.

20. **Tier upgrade rounding**: no tiered subscription model — single fee
    rate, single subscription type. No tier rounding to attack.

---

## Summary

PremiumAccess.sol is the most-iterated contract in the protocol per its
inline-comment density (40+ named audit fixes referenced), and the
high-severity attack surface (math drift, flash-loan, refund accounting,
timelock bypass) is correctly mitigated. The remaining issues are
**MEDIUM** at most and concentrated in:

1. **F-27-K-01 (MEDIUM)**: `getSubscription` view diverges from `hasPremium`
   gating, exposing external integrators to flash-loan spoofing without an
   inline integrator-warning. The single most actionable item.
2. **F-27-K-02 (LOW)**: 10-minute marketplace grace window described in
   PA-L-02 is a no-op due to the live `balanceOf` check in `hasPremium`.
3. **F-27-K-03 (INFO)**: JBAY Gold (per audit-task scope) is not
   implemented. Product decision required.
4. F-27-K-04 through F-27-K-09: dead-code / UX / future-proofing /
   doc-clarity issues. Each is independently low-priority but worth
   batching into a "PA polish" pass.

No high-severity, no fund-loss, no critical bypass found.
