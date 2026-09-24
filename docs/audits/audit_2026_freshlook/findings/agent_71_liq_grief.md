# Agent 71 — Liquidation MEV / Griefing / First-Keeper Race

**Lens:** Liquidation MEV/grief vectors across all default flows in
TegridyLending.sol, TegridyNFTLending.sol, TegridyNFTPool.sol.

**Scope notes (architectural):**
- Both lending contracts implement a **lender-only liquidation** model
  (Gondi-pattern P2P lending). `claimDefault` / `claimDefaultedCollateral`
  reverts unless `msg.sender == lender`. There is **no public keeper, no
  bid mechanism, no liquidation bonus**. As a result, several agent-prompt
  scenarios (first-keeper race, identical-sandwich, bid front-running,
  liquidation bonus capture, partial-vs-full extraction) are
  **structurally inapplicable** — the lender is the sole authorized
  liquidator and there is no third-party reward.
- TegridyNFTPool is a Sudoswap-style NFT AMM (PoolType BUY/SELL/TRADE)
  with **no liquidation flow at all** — it has no debt, no collateral,
  no default. Out of scope for this lens.
- The two lending contracts therefore concentrate all liquidation-grief
  risk on **(a) the borrower-vs-lender repay/claim race**, **(b)
  pause asymmetry between repay and claim**, **(c) sequencer-outage
  boundary windows**, and **(d) grace/lockEnd boundary edge cases**.
  These are the surfaces examined below.

---

## F-71-1 — TegridyNFTLending.claimDefault is paused-blockable INDEFINITELY (vs TegridyLending's 7d cap)

**File:line:** `contracts/src/TegridyNFTLending.sol:729`
**Severity:** HIGH (griefing — infinite-pause weapon against lender)
**MEV/grief vector:** captured-key admin grief / lender DoS

```
function claimDefault(uint256 _loanId) external nonReentrant whenNotPaused {
```

`claimDefault` carries `whenNotPaused`. `repayLoan` (line 625) does **not**
carry `whenNotPaused`. This is intentional asymmetry per the comments —
"borrowers can still repay during pause" — but the sister contract
TegridyLending has a hard ceiling on this asymmetry that TegridyNFTLending
**lacks entirely**:

```solidity
// TegridyLending.sol:1202-1208 (claimDefaultedCollateral)
if (paused()) {
    require(
        pauseStartTime != 0 && block.timestamp > pauseStartTime + MAX_PAUSE_BLOCK_LIQUIDATION,
        "PausedShortOfBound"
    );
}
// MAX_PAUSE_BLOCK_LIQUIDATION = 7 days  (TegridyLending.sol:571)
```

TegridyLending caps the pause weapon at 7 days. After 7 days of
continuous pause, the lender can claim even while `paused() == true`.
This is the BATCH-J3 H10 fix referenced at line 1191-1199 ("MakerDAO
Emergency Shutdown Module similar bounded-grace design").

**TegridyNFTLending has no equivalent cap.** A captured-owner key (or a
malicious-but-still-onlyOwner upgrade) can call `pause()` and **block
every lender's claim forever**, while:

1. `repayLoan` continues to work (borrower path open),
2. `effectiveDeadline` continues to stretch (line 1218-1233 — pause
   extension), so the grace window is symmetric in time but
   asymmetric in *callability*,
3. The borrower can wait for an opportune moment (NFT floor recovery,
   stake unlock, market re-bidding) and choose to repay or not —
   while the lender is **unconditionally locked out**.

**Impact:** The lender's collateral exit is hostage to admin pause
state. Even if the borrower ends up never repaying, the lender cannot
seize the NFT until pause is lifted — which may never happen if the
admin key is captured. The same captured-key vector that BATCH-J3 H10
explicitly closed on TegridyLending is wide open on TegridyNFTLending.

**Liquidation-MEV angle:** A lender who suspects the borrower will
default has zero ability to time the market for the NFT seizure. They
cannot front-run a known floor crash. They cannot react to a known
collection-rug. The lender's *only* defense is "hope admin doesn't
pause" — there is no on-chain backstop.

**Fix shape (mirror TegridyLending):**
Add `MAX_PAUSE_BLOCK_LIQUIDATION = 7 days` constant + the same
`if (paused()) require(... pauseStartTime + 7d ...)` gate at the top
of `claimDefault`. The pause-aware `effectiveDeadline` already extends
the borrower's repay window symmetrically; the cap closes the
indefinite-block weapon without harming the legitimate
incident-response use case (7d > GRACE_PERIOD + reasonable incident
windows).

---

## F-71-2 — Lender-claim grace is asymmetric: borrower repay also gated on `whenNotPaused`-less surface, but interest still accrues during pause (TegridyLending)

**File:line:** `contracts/src/TegridyLending.sol:1006-1186` (repayLoan), `contracts/src/TegridyLending.sol:1500-1528` (pauseAdjustedElapsed / calculateLoanInterest)
**Severity:** MEDIUM (subtle but real grief on a long admin pause edge)
**MEV/grief vector:** lender-side coordination grief / borrower interest-tax

The pause-aware design pauses interest accrual:
```solidity
// TegridyLending.sol:1502-1514
function pauseAdjustedElapsed(uint256 _loanId) public view returns (uint256) {
    ...
    return pausedSinceStart >= raw ? 0 : raw - pausedSinceStart;
}
```

This is correct in steady state, BUT consider the following edge:

1. Borrower accepts offer at `t=0`, deadline `t=30d`.
2. At `t=29d 59m 0s`, admin pauses (legit incident response).
3. Pause runs for, say, 60 minutes (61m).
4. At `t=30d 0h 0m + 60m + 1s`, admin unpauses. `effectiveDeadline = 30d + 61m`.
   `block.timestamp` is `30d + 1h + 1s`.
5. Lender wakes up the moment unpause hits and calls `claimDefaultedCollateral`.
   `outageBuffer = 0` (sequencer was up). Gate:
   `block.timestamp <= effectiveDeadline + GRACE_PERIOD + outageBuffer`
   = `30d + 1h + 1s <= 30d + 61m + 1h + 0` = `30d + 1h + 1s <= 30d + 2h 1m`
   → reverts (lender too early — fine).
6. But now the borrower has only `30d + 2h 1m - (30d + 1h + 1s) = 1h - 1s`
   to repay. Pre-pause they would have had 1 full hour of grace.
   The pause **stole 1s** from them effectively, plus the 1m of
   `pauseStartTime → block.timestamp` clock skew if there's any.

**This is dust** in the `1h grace` case. The bigger surface is when
the pause spans the END of grace:

1. Borrower accepts at `t=0`, deadline `t=30d`, grace ends at `t=30d 1h`.
2. Admin pauses at `t=30d 30m` (mid-grace).
3. Pause runs 7 days. `effectiveDeadline = 30d + 7d`.
4. At `t=37d 30m + ε`, admin unpauses. Borrower's "remaining grace at
   resume" is `effectiveDeadline + grace - block.timestamp`
   = `(30d + 7d) + 1h - (37d 30m + ε)` = `30m - ε` — **half of the
   original grace was consumed by clock-time during pause**.

The `pauseStartTime → block.timestamp` extension applies only to
`effectiveDeadline`, not to the GRACE_PERIOD itself. Pre-fix, this was
the LD3-H1 sequencer-buffer concern; post-fix, it remains for *admin
pause*. The pause-extension formula is:

```
effectiveDeadline = base_deadline + (totalPausedDuration - pausedDurationAtStart)
                                  + (paused() ? block.timestamp - pauseStartTime : 0)
```

The `+ GRACE_PERIOD` is a constant 1h on top. So the effective repay
window post-deadline is `lender_can_claim_at - effectiveDeadline = GRACE_PERIOD`
exactly — but the borrower experienced `block.timestamp_when_unpaused -
pauseStartTime_when_pause_began_mid-grace` of clock-time inside the
grace window already. The remaining wall-clock is `pauseStartTime + 1h - block.timestamp_at_pause_start`,
which is less than 1h.

**Concrete attack:** captured-key admin pauses RIGHT at `deadline + 30m`
(mid-grace), keeps pause for 6d 23h 30m (just under the 7d cap, so the
lender stays blocked but the cap eventually lifts). Borrower's tx
queue assumes "I have at least 1h of grace post-deadline". Borrower
plans to repay at `deadline + 45m`. But pause+resume happens, and the
borrower's tx executes at a wall-clock past `deadline + grace_extension_minus_stolen_30m`,
where the stolen 30m means borrower's repay tx now lands AFTER the
gate `block.timestamp > effectiveDeadline + GRACE_PERIOD`, reverting
the repay → lender claims default the next block.

**Mitigation options:**
- (a) Extend `GRACE_PERIOD` by `pause_duration_inside_grace` so the
  borrower keeps a full 1h post-resume.
- (b) Extend `effectiveDeadline` by the *full* pause window measured
  from `pause_start` to `pause_end` regardless of where in the deadline
  cycle pause began (current behavior already does this, but the
  GRACE_PERIOD on top is a fixed constant — mid-grace pauses leak).

**Severity rationale:** the grief is bounded (≤1h max grace stolen),
but it is *systematically exploitable* by a captured admin who
specifically times pause to land mid-grace. Combined with F-71-1 it
weaponizes pause for forced default.

---

## F-71-3 — Sequencer-outage boundary: claim path uses `checkSequencerUp` (revert), repay uses `getSequencerOutageBuffer` (extension) — boundary race opens stale-claim window

**File:line:** `contracts/src/TegridyLending.sol:1223` (claim) vs `contracts/src/TegridyLending.sol:1032-1036` (repay); same shape on TegridyNFTLending.sol:744 vs :649-653.
**Severity:** LOW-MEDIUM (rare but real on chain re-bridge events)
**MEV/grief vector:** keeper-bridge timing / lender-claim race

The two paths use *different* SequencerCheck primitives:

```solidity
// claim path — REVERTING gate
SequencerCheck.checkSequencerUp(sequencerFeed, SEQUENCER_GRACE_PERIOD, 4 hours);
```

```solidity
// repay path — NON-REVERTING extension
uint256 outageBuffer = SequencerCheck.getSequencerOutageBuffer(
    sequencerFeed,
    SEQUENCER_GRACE_PERIOD
);
if (block.timestamp > effectiveDeadline(_loanId) + GRACE_PERIOD + outageBuffer) {
    revert DeadlineExpired();
}
```

This is correct steady-state behavior — the lender is hard-blocked
during outage; the borrower's window is auto-extended. But note the
**default staleness window mismatch**:

- `checkSequencerUp(feed, 1h, 4h)` — explicit 4h staleness on the
  reverting path (BATCH-L3 M4 fix).
- `getSequencerOutageBuffer(feed, 1h)` — uses the **default 24h** staleness
  via the 2-arg overload (SequencerCheck.sol:246-252):
  ```
  return getSequencerOutageBuffer(feed, buffer, MAX_FEED_STALENESS); // 24h
  ```

**Race window:** sequencer just resumed; Chainlink keeper has not yet
posted a fresh `latestRoundData` update. `block.timestamp - updatedAt`
is between 4h and 24h. Then:

- `claimDefault` reverts (`SequencerDown` — keeper-lapse branch trips
  on the 4h staleness).
- `repayLoan` does NOT revert and `getSequencerOutageBuffer` returns
  `0` (not the buffer) because the feed reports answer=0 (up) and the
  4h-vs-24h diff means `block.timestamp - updatedAt > staleness=4h` is
  TRUE on the reverting path but `> staleness=24h` is FALSE on the
  buffer path → buffer = 0.

So during this ~20h window:
- Borrower can repay (no extension applied).
- Lender cannot claim.
- After deadline+grace lapses, the borrower can lose their repay
  window even though *the keeper feed has not blessed sequencer
  uptime*, while the lender is also locked out — but the lender's
  lockout will lift the moment the keeper updates, while the borrower's
  lockout (deadline+grace expiry) is permanent past the boundary.

**This is the inverse-race of LD3-H1 / DEEP-LD2-H1.** The original fix
("symmetric outage handling") assumed both paths would use the same
staleness window. The 4h/24h mismatch reopens it on this specific
boundary.

**Liquidation-MEV angle:** an adversarial keeper (or an adversarially
timed observer) can engineer the boundary if they control the keeper
update cadence — withhold the keeper update for `4h < t < 24h` so the
lender's claim is locked but the borrower's repay window is not
extended, then push the keeper update right at the moment the borrower
misses repay → lender claims at the resumption.

**Fix:** call `getSequencerOutageBuffer(feed, buffer, 4 hours)` (the
3-arg overload) on the repay path so both paths share the same 4h
staleness gate. Mirrors the same staleness gate the audit already
applied to the claim path in BATCH-L3 M4.

Same fix needed on TegridyNFTLending.sol:649-653.

---

## F-71-4 — `LIQUIDATION_GRACE = 1 day` provides the LENDER zero usable seize-window after typical pause+sequencer-buffer extension

**File:line:** `contracts/src/TegridyLending.sol:262-274` (constant + natspec), `:919` (acceptOffer enforcement)
**Severity:** LOW (architectural — documented but worth flagging on a fresh-eyes pass)
**MEV/grief vector:** lender post-claim usability / borrower prevent-seize-by-stake-expiry

The acceptOffer gate requires `lockEnd >= deadline + LIQUIDATION_GRACE`
where `LIQUIDATION_GRACE = 1 day` (post-LD3-M2; was 7d). The natspec
explicitly acknowledges:

```
INFO LD3-INFO1: this buffer is enforced at acceptance only — see
claimDefaultedCollateral NatSpec for the 7d-vs-claim-time
distinction. Lender's actual usable post-claim window is
`lockEnd - block.timestamp_at_claim`, which can be anywhere
between `LIQUIDATION_GRACE - GRACE_PERIOD` and 0+.
```

**The "0+" lower bound is reachable** on a normal (non-pause) sequence:

1. Borrower accepts at `t=0`. Loan duration = 30 days. `lockEnd = 31d`.
2. Borrower waits to default deliberately. `effectiveDeadline = 30d`,
   no pause, no outage.
3. Lender calls claim at `t = 30d + 1h + 1s` (earliest valid). They
   receive an NFT whose stake unlocks at `t = 31d`. Window: `31d - (30d + 1h + 1s) = 23h - 1s`.
4. **But:** if the sequencer had a 1h outage during the loan
   period, `outageBuffer = 1h` is added to the gate (line 1245). The
   lender's earliest valid claim is `30d + 2h + 1s`, leaving
   `31d - 30d 2h 1s = 22h - 1s` of usable post-claim window.
5. **Stack with F-71-2 pause-grief:** if admin paused for 7d during
   the loan, `effectiveDeadline = 37d`, lender's earliest claim is
   `37d 1h 1s`. But `lockEnd = 31d` (unchanged). The lender claims
   an NFT whose stake has been unlocked for **6d 1h** already.

In step 5, the borrower can be the staking contract's `ownerOf` of
the position via the lending escrow. If the staking contract permits
withdrawal of unlocked positions only by the position-NFT owner
(typical pattern), the lender can withdraw immediately — this is
fine. **But:** any in-flight reward claim or compound loop the
lender intended to time gets compressed, and the lender may have to
emergency-exit on stale TWAP — exposing them to slippage MEV when
they swap the unlocked TOWELI for ETH.

**MEV vector:** an attacker watching the on-chain default sequence
can sandwich the lender's expected post-claim TOWELI→ETH swap
(if the lender is a contract / well-known wallet broadcasting their
unwind intent). This is a *post-liquidation* MEV but enabled by the
shrunken usable window.

**Severity:** LOW because:
- The mechanic is documented in the natspec.
- It's a UX concern more than an exploitable bug.
- The lender, being the sole liquidator with no fallback keeper,
  cannot be sandwich-frontrun by another *liquidator* (no race),
  only by a swap-MEV bot on the unwind.

**Possible improvement:** require `lockEnd >= deadline + LIQUIDATION_GRACE +
expected_max_pause` at acceptOffer, where `expected_max_pause` matches
`MAX_PAUSE_BLOCK_LIQUIDATION = 7d`. Trade-off: tightens the staking
position's required lock duration.

---

## F-71-5 — `block.timestamp == startTime` LoanTooRecent guard is only in repayLoan, not claimDefault — same-block default-claim is theoretically permitted (boundary)

**File:line:** `contracts/src/TegridyLending.sol:1023`, `contracts/src/TegridyNFTLending.sol:641` (repayLoan); claim paths lack the guard
**Severity:** INFORMATIONAL (the deadline+grace gate already prevents same-block claim)
**MEV/grief vector:** none in current implementation; flagged for completeness

`repayLoan` rejects `block.timestamp == startTime`:
```solidity
if (block.timestamp == startTime) revert LoanTooRecent();
```

`claimDefaultedCollateral` / `claimDefault` lack this guard. In practice
this is harmless because the gate
`block.timestamp <= effectiveDeadline + GRACE_PERIOD + outageBuffer`
fails for `block.timestamp == startTime` (since deadline = startTime + duration ≥ startTime + 4h, so the gate trivially holds and reverts).

The asymmetry is notable only as a code-shape concern — if a future
refactor lowers the duration floor or shortens the grace, the gate
becomes the only defense. Flagged as informational.

---

## F-71-6 — `isDefaulted` view leaks future state during pause / outage — bots can pre-stage liquidation-tx for the moment the gate opens

**File:line:** `contracts/src/TegridyLending.sol:1557-1563`, `contracts/src/TegridyNFTLending.sol:998-1003`
**Severity:** INFORMATIONAL (bot UX, not exploit)
**MEV/grief vector:** liquidation-tx pre-staging

```solidity
function isDefaulted(uint256 _loanId) external view returns (bool) {
    if (_loanId >= loans.length) revert InvalidLoanId();
    Loan memory l = loans[_loanId];
    return !l.repaid
        && !l.defaultClaimed
        && block.timestamp > effectiveDeadline(_loanId) + GRACE_PERIOD;
}
```

Note the view does NOT check the sequencer-up gate / pause gate. A
loan can read `isDefaulted == true` while `claimDefault` reverts
(sequencer down, paused). For the lender (sole liquidator) this is
just a UX bug. **But** off-chain bots scanning loans for default
signal can flag a loan, queue a `claimDefault` tx, and deliver it the
moment the sequencer resumes / pause lifts.

In a public-keeper liquidation model (which Tegriddy is NOT), this
would be a clear first-keeper race vector. In the lender-only model
here, it's an information-leak that gives the lender's bot a tighter
turnaround vs the borrower's bot trying to repay at the wire.
**Borrower-side defense:** the borrower's bot can read the same
view and queue a `repayLoan` tx for the same wake-up — and `repayLoan`
will land first if both txs are in the same block (it doesn't have
the sequencer revert gate, only the buffer extension).

**Net:** this favors the borrower, not the lender. So the
information-leak does not advantage liquidation MEV — it actually
mitigates it. Flagged for completeness.

---

## F-71-7 — Self-collateralized loan (lender == borrower): no check; lender uses lending pool as zero-cost escrow

**File:line:** TegridyLending.acceptOffer:857-996, TegridyNFTLending.acceptOffer:487-616
**Severity:** INFORMATIONAL (economic edge, not exploit)
**MEV/grief vector:** none from a 3rd party; "self-grief" only

Neither `acceptOffer` checks `lender != msg.sender`. A user can act as
both lender (via offer) and borrower (via accept) using the same EOA
or two wallets they control. The ledger ends up with:
- Lender (= self) deposited principal at offer creation.
- Borrower (= self) escrowed NFT at accept.
- Borrower receives the principal back (so the user has their ETH back
  and their NFT held by the contract).
- At repay: pays principal + interest to lender (= self), minus protocol
  fee. **Net cost = protocol fee on interest + origination fee.**
- At default: NFT returns to lender (= self). **Net cost = origination fee.**

This is a free-escrow vector: the user pays origination fee + protocol
fee for the privilege of having the lending contract hold their NFT,
during which time the position keeps accruing rewards (which the user
also receives). The protocol's `originationFee` (LD3-H3) and
`protocolFeeBps` are the only economic friction, and they cap at
2% + 10% of interest (not severe).

**Liquidation-MEV angle:** none — there is no third-party liquidator to
race. The "default" of a self-loan is just the user voluntarily
forfeiting collateral to themselves.

Flagged because the agent prompt asked specifically about
"Liquidation of self-collateralized loan." Confirmed: **no special
handling, no anti-self-loan guard, no observable exploit beyond the
documented free-escrow tax.** The protocol-fee + origination-fee
combination makes this economically uninteresting at typical sizes.

---

## F-71-8 — Two-step liquidation pattern is NOT present (sole step is `claimDefault`); first-keeper race IS not present (lender-only)

**File:line:** N/A — explicit design absence
**Severity:** N/A — confirms agent-prompt scenarios are inapplicable

The agent prompt asked about:
- "First-keeper race: identical sandwich" — N/A. Only `lender` can call.
- "Liquidate → repay-by-borrower race" — partially N/A. Both calls share
  the same gate `block.timestamp > effectiveDeadline + GRACE_PERIOD + buffer`,
  but with opposite inequality. There is exactly ONE block at which both
  could attempt to land: `block.timestamp == effectiveDeadline + GRACE_PERIOD + buffer + 1`.
  At that block, `repayLoan` REVERTS (gate is `>`, off-by-one trips on
  `block.timestamp > effDl + grace + buf`), and `claimDefault` PASSES
  (gate is `<=`, also trips against the same inequality). So **the
  borrower never has a co-block window with the lender's claim.** The
  off-by-one boundary makes them mutually exclusive by exactly 1 second.
- "Bid-front-running" — N/A. No bid surface.
- "Two-step (mark default + liquidate) racy" — N/A. Single-step claim.
- "Partial vs full liquidation choice" — N/A. Liquidation is binary
  (entire NFT seized or full repay).

These are explicit *non*-findings — confirming the design is hardened
on these surfaces by virtue of architectural choices, not just
patches.

---

## F-71-9 — `claimDefault` (TegridyNFTLending) lacks a same-block-as-unpause guard — captured-key can pause/unpause to time-pin the lender out

**File:line:** `contracts/src/TegridyNFTLending.sol:729-786`
**Severity:** LOW (compounds F-71-1)
**MEV/grief vector:** captured-key precision-grief

Combine F-71-1 with this: admin pauses RIGHT before the borrower's
deadline, keeps it paused through the entire grace window, then
unpauses — but the captured key can also pause/unpause/pause again to
fragment the lender's tx into the queue.

```
Step 1: pause at deadline-1m.
Step 2: unpause at deadline+grace+1s. effectiveDeadline = deadline + (grace+1m+1s).
        Lender broadcasts claim tx.
Step 3: re-pause at deadline+grace+1m (sees lender's mempool tx).
        Lender's claim reverts (whenNotPaused).
Step 4: borrower broadcasts repay tx (any pause-status).
Step 5: unpause again. effectiveDeadline now extended by step 1-3 + 4.
```

Each pause/unpause cycle adds friction without ever consuming the 7d
cap (because `pauseStartTime` resets each cycle). On TegridyNFTLending
there's no 7d cap, but even on TegridyLending the cap doesn't help
because `pauseStartTime` resets each pause — the 7d "consecutive
pause" cap can be evaded with cycles.

**Verification:**
```solidity
// TegridyLending.sol:1707-1719
function _pause() internal override {
    super._pause();
    pauseStartTime = block.timestamp;  // resets each pause
}
function _unpause() internal override {
    uint256 start = pauseStartTime;
    if (start != 0 && block.timestamp > start) {
        totalPausedDuration += block.timestamp - start;
    }
    pauseStartTime = 0;
    super._unpause();
}
```

`pauseStartTime` is reset to `block.timestamp` on each `_pause()`. The
7d MAX_PAUSE_BLOCK_LIQUIDATION gate at line 1205 is:

```solidity
require(
    pauseStartTime != 0 && block.timestamp > pauseStartTime + MAX_PAUSE_BLOCK_LIQUIDATION,
    "PausedShortOfBound"
);
```

This measures **consecutive** pause time, not cumulative. A captured
key can pause/unpause/pause/unpause indefinitely, giving the lender a
1-block window each unpause cycle and re-pausing if the lender's tx
lands. The **7d cap is never reached** because pauseStartTime resets.

**Fix:** track cumulative-pause-since-deadline-elapsed for the
liquidation-cap check, not just the consecutive window. Equivalently:
allow `claimDefault` if `(block.timestamp - effectiveDeadline) > 7d
+ grace`, regardless of current pause state.

Same fix shape applies to TegridyNFTLending if the F-71-1 cap is
added.

---

## Summary

| ID     | Severity | File                       | Surface                                                         |
| ------ | -------- | -------------------------- | --------------------------------------------------------------- |
| F-71-1 | HIGH     | TegridyNFTLending.sol:729  | `claimDefault` whenNotPaused — no 7d cap (vs TegridyLending)    |
| F-71-2 | MEDIUM   | TegridyLending.sol:1006-1186 | mid-grace pause steals borrower's wall-clock grace             |
| F-71-3 | LOW-MED  | TegridyLending.sol:1032; sister NFTLending:649 | Sequencer staleness mismatch (4h vs 24h) on repay path |
| F-71-4 | LOW      | TegridyLending.sol:262-274 | LIQUIDATION_GRACE=1d insufficient under stacked pause+outage    |
| F-71-5 | INFO     | TegridyLending.sol:1023; NFTLending:641 | LoanTooRecent on repay only — defense-in-depth shape  |
| F-71-6 | INFO     | TegridyLending.sol:1557; NFTLending:998 | isDefaulted view leaks future state — favors borrower |
| F-71-7 | INFO     | acceptOffer (both)         | Self-collateralized: documented free-escrow tax, no exploit     |
| F-71-8 | N/A      | architectural              | First-keeper / bid / partial / two-step scenarios inapplicable  |
| F-71-9 | LOW      | TegridyLending.sol:1707-1719; NFTLending:1204-1216 | pause-cycle bypass of 7d MAX_PAUSE cap |

**Top recommendations (ordered by severity):**

1. **F-71-1** — port `MAX_PAUSE_BLOCK_LIQUIDATION` cap from
   TegridyLending to TegridyNFTLending. This is a direct sister-fix
   miss in BATCH-J3 H10 — same captured-key indefinite-pause weapon
   exists on the NFT side.
2. **F-71-9** — change the cap measurement from "consecutive pause
   from current pauseStartTime" to "(block.timestamp - effectiveDeadline)"
   so cycle-pause cannot bypass the 7d cap.
3. **F-71-3** — call `getSequencerOutageBuffer(feed, 1h, 4h)` (3-arg
   overload) on the repay path to match the 4h staleness on the claim
   path. Symmetric sequencer staleness across both legs.
4. **F-71-2** — extend GRACE_PERIOD by `(pauseStart_inside_grace →
   pauseEnd_inside_grace)` so mid-grace pauses don't compress the
   borrower's wall-clock grace window.

**Notes / dead-ends:**

- Investigated TegridyNFTPool default flow — **none exists**. Pool is
  a Sudoswap AMM with no debt/collateral primitives. Not in scope.
- Investigated bid-front-running — **no bid surface in either
  contract**. Lender is sole liquidator at a deterministic gate.
- Investigated liquidation-bonus capture — **no liquidation bonus
  exists**. Lender takes the whole NFT minus reward-attribution.
- Investigated identical-sandwich first-keeper race — **structurally
  impossible** because msg.sender == lender check. The "one
  liquidator" model removes the race surface entirely.
- Verified the `block.timestamp > effDl+grace+buf` gate (claim) and
  `block.timestamp > effDl+grace+buf` revert (repay, with opposite
  semantics — repay reverts on TRUE, claim reverts on FALSE/EQUAL).
  The off-by-one means **at the exact boundary block, repay reverts
  AND claim reverts** if the equality holds (claim uses `<=`); only
  one block past the boundary opens the claim window. So borrower and
  lender never co-occupy a block at the boundary.
