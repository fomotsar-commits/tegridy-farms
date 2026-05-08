# Agent 08 — TegridyLending Interest / Accrual Audit

Target: `contracts/src/TegridyLending.sol` (1972 lines)
Lens: kinked / jump-rate model, utilization math, accrual correctness, drift, admin-driven negative interest, view vs current divergence.

---

## TL;DR — Architecture Mismatch with Audit Lens

TegridyLending is **NOT** a Compound/Aave-style pool with a kinked / jump-rate IRM, utilization curves, supply caps, borrow caps, reserve factors, exchange rates, or a global `borrowIndex`. It is a **Gondi-style P2P NFT-collateralized lending protocol** with:

- **Per-offer fixed APR** chosen by the lender at offer creation (`aprBps` snapshotted into `LoanOffer.aprBps` and copied verbatim into `Loan.aprBps`).
- **Pro-rata simple interest** on the principal: `interest = principal * aprBps * elapsed / (BPS * SECONDS_PER_YEAR)`, computed via `Math.mulDiv` with `Ceil` rounding (TegridyLending.sol:1481-1499, 1517-1528).
- **No utilization, no kink, no rate slope, no cumulative borrow index, no exchange rate model.** A loan is a 1:1 ETH-out-now / ETH+interest-in-later pair against a single escrowed `TegridyStaking` ERC721.
- **No global accrual loop.** Each loan accrues independently from its own `startTime` / `aprBps` until repay or default. There is nothing to "drift."
- **No admin rate-setter on any in-flight loan.** APR is pinned in `Loan.aprBps` at acceptance and cannot be retroactively touched by governance.

Result: **most of the lens vectors don't exist here**. The handful that map to this design (overflow over years, view vs accrued divergence, admin-level rate-knob abuse, minimum-interest floor edge cases, pause-asymmetry siphons) are either already mitigated or addressed by prior audit fixes documented in-source. Below are the few residuals worth flagging plus the dead-ends that confirm the lens.

---

## F-08-K-01 — INFORMATIONAL — `calculateInterest` (public pure helper) reverts with opaque Panic on caller-overflow

### Location
TegridyLending.sol:1481-1499

### Detail
The public-pure helper `calculateInterest(_principal, _aprBps, _startTime, _currentTime)` is documented as a quoting helper but performs `_principal * _aprBps` in vanilla checked arithmetic *before* feeding into `Math.mulDiv`:

```solidity
interest = Math.mulDiv(
    _principal * _aprBps,   // <-- naive mul; caller-supplied; can panic
    elapsed,
    BPS * SECONDS_PER_YEAR,
    Math.Rounding.Ceil
);
```

The 512-bit safety promised in the comment ("removes the cap-ceiling overflow constraint") only kicks in *inside* mulDiv — the outer multiplication still runs in 256-bit checked math and reverts with `Panic(0x11)` for caller inputs where `_principal * _aprBps > 2^256-1`.

For the *internal* call sites (`calculateLoanInterest` line 1517-1528 and `repayLoan`/`getRepaymentAmount`), inputs are bounded by `MAX_PRINCIPAL_CEILING = 100_000 ether` (`1e23`) and `MAX_APR_BPS_CEILING = 100_000`, giving `1e23 * 1e5 = 1e28 << 2^256-1`. Internal callers are safe.

### Impact
Off-chain integrations (front-ends, indexers, arbitrage bots) that call `calculateInterest` directly with *unbounded* user-supplied values get an opaque `Panic(0x11)` instead of a typed revert. No on-chain economic impact. Pure UX/integration trap.

### Recommendation
Either route the outer multiplication through `Math.mulDiv(_principal, _aprBps * elapsed, BPS * SECONDS_PER_YEAR, ...)` so the 512-bit intermediate covers the full numerator, or document the input bounds explicitly in NatSpec so integrators learn from the comment rather than the reverting RPC.

### Severity Justification
Informational — internal accrual math is fully bounded; only the publicly exposed pure-quote helper is affected, and its only consequence is an opaque panic for caller-overflow inputs.

---

## F-08-K-02 — LOW — `MIN_INTEREST_DURATION` floor masks paused-loan refunds for ≥1d-paused windows

### Location
TegridyLending.sol:1040-1058 (repayLoan), 1539-1551 (getRepaymentAmount view)

### Detail
The minimum-interest floor logic gates on `pauseAdjustedElapsed > 0`:

```solidity
uint256 elapsed = pauseAdjustedElapsed(_loanId);
if (elapsed > 0) {
    uint256 minInterest = Math.mulDiv(
        principal * aprBps,
        MIN_INTEREST_DURATION,   // = 1 day
        BPS * SECONDS_PER_YEAR,
        Math.Rounding.Ceil
    );
    uint256 flatFloor = (principal * MIN_INTEREST_PRINCIPAL_BPS) / BPS;  // 5 bps
    if (minInterest < flatFloor) minInterest = flatFloor;
    if (interest < minInterest) interest = minInterest;
}
```

The DEEP-LD2-M2 comment in-source claims the floor is "skipped when loan was 100% paused since start." That claim is implemented via the `elapsed > 0` guard — but `pauseAdjustedElapsed` returns 0 only when the **paused window equals or exceeds** the raw elapsed time (line 1513: `pausedSinceStart >= raw ? 0 : raw - pausedSinceStart`).

The edge case: a borrower on a 30-day loan that was paused for 29.999999 days but had elapsed for 30 days has `pauseAdjustedElapsed > 0` (tiny positive), and `interest` is the tiny pro-rata accrual — but the **minimum-interest floor jumps it back up to 1-day-of-APR or 5 bps of principal**, whichever is larger. For a 100-ETH 50% APR loan that was effectively paused 99.99% of the way: actual accrual ~0.014 ETH, floor jumps to ~0.137 ETH (1-day at 50% APR) — a **~10x retroactive interest tax** on a borrower who suffered a multi-week governance pause.

The same shape appears at the *low* tail: a 0% APR loan repaid one block after a multi-week pause unpauses sees `minInterest = 0` (APR floor zero) but `flatFloor = principal * 5 / 10000 = 0.05% of principal` charged regardless.

### Impact
A long pause does not exempt borrowers from the 1-day floor; the LD3-H2 flat floor (5 bps) is also applied without an "actually-active-time" gate. This mostly hurts borrowers on near-fully-paused loans who repay in the first second after unpause.

This is structurally a borrower-side cost. It is bounded (`max 5 bps` flat or 1-day-of-APR) and well-known on the lender side, but not what the LD2-M2 comment leads readers to expect ("100% paused since start" is an unreachable threshold in practice — `pauseAdjustedElapsed > 0` triggers as soon as a single non-paused second elapses).

### Recommendation
Either tighten the elapsed-gate (e.g., `if (elapsed >= MIN_INTEREST_DURATION)`) so the 1-day floor only applies when the loan was *really* active for at least a day, or update the LD2-M2 comment so it stops promising a behavior the code doesn't deliver.

### Severity Justification
Low — not directly exploitable, but represents a hidden borrower-side cost during pause incidents that contradicts in-source documentation. Maximum harm is ~`min(1 day APR, 5 bps principal)` per loan against a borrower the protocol just paused.

---

## F-08-K-03 — INFORMATIONAL — `getRepaymentAmount` view returns interest *without* sequencer-outage buffer applied

### Location
TegridyLending.sol:1535-1553 (`getRepaymentAmount`), compare 1032-1038 (`repayLoan` deadline check)

### Detail
`repayLoan` extends the effective deadline by `SequencerCheck.getSequencerOutageBuffer(...)`:

```solidity
uint256 outageBuffer = SequencerCheck.getSequencerOutageBuffer(...);
if (block.timestamp > effectiveDeadline(_loanId) + GRACE_PERIOD + outageBuffer) {
    revert DeadlineExpired();
}
```

The view helper `getRepaymentAmount` does NOT mirror this — it just returns `principal + interest` regardless of whether the loan is currently within the outage-extended grace window. A front-end / indexer that uses `getRepaymentAmount` to decide whether to surface a "repay" CTA will give borrowers a stale value during an L2-sequencer outage transition (they think they have to repay a different number than what the contract will actually accept).

There is no economic exploit — the value is just a view-side quote that doesn't account for the borrower's current liquidation-grace state. Any front-end that compounds this with `isDefaulted(_loanId)` (line 1557-1563, which DOES account for `effectiveDeadline + GRACE_PERIOD` but NOT the outage buffer either) gets the same divergence.

### Impact
Front-end / off-chain quote is "stale" but not in a way that loses funds. Borrowers who rely on `isDefaulted` view as a green-light to consider their loan defaulted may take action that the on-chain `claimDefaultedCollateral` will refuse.

### Recommendation
Document explicitly that view-helper outputs do not factor in the sequencer-outage buffer, OR add a parallel `effectiveGracePeriod(_loanId)` view that returns `GRACE_PERIOD + outageBuffer` so integrators have a single canonical source.

### Severity Justification
Informational — this is the "view returns stale data" pattern from the lens, applied to an L2-sequencer-grace edge rather than an interest-accrual edge. No funds at risk; only off-chain UX divergence.

---

## F-08-K-04 — DEAD-END — Lens vectors that do not apply to this contract

These lens questions were investigated and confirmed not applicable to TegridyLending's design:

### "Kinked / jump-rate model" — N/A
There is no IRM. APR is per-offer, picked by the lender, snapshot at offer creation (line 790 `aprBps: _aprBps` in the `LoanOffer` push), pinned at loan acceptance (line 938 `aprBps: aprBps` in the `Loan` push). The two governance knobs are:
- `minAprBps` (`MAX_MIN_APR_BPS = 1000`, i.e., max 10% min-APR floor)
- `maxAprBps` (`MAX_APR_BPS_CEILING = 100_000`, i.e., max 1000% max-APR ceiling)

Both are gated by typed errors at offer creation only. They cannot retroactively affect existing loans. There is no "kink" to misalign.

### "Compound vs simple over many blocks" — N/A
Interest is **simple, pro-rata, time-weighted**: `principal * aprBps * elapsed / (BPS * SECONDS_PER_YEAR)`. There is no compounding loop, no `_accrueInterest()` that updates a per-block index. Each loan independently computes accrual at repay/quote time directly from `(startTime, currentTime, principal, aprBps)`. Drift is impossible because there is no shared state to drift.

### "Per-block vs per-second drift" — N/A
The math is exclusively per-second (`elapsed = block.timestamp - startTime`, denominator is `SECONDS_PER_YEAR`). No per-block accrual surface exists.

### "Utilization division-by-zero when totalBorrows=0" — N/A
There is no `utilization = totalBorrows / totalSupply` calculation. The contract maintains `activeLoansAgainstCollateral[address]` and `totalEscrowRewardsOwed`, but neither is a divisor in interest math.

### "Borrow cap / supply cap bypass" — N/A
There are per-offer caps (`maxPrincipal`, `maxAprBps`, `minDuration`, `maxDuration`) but no global supply / borrow accumulator. Multiple lenders can independently fund offers up to `maxPrincipal` each.

### "Reserve factor siphon (rounding favoring reserve infinitely)" — Partial: protocol fee
The `protocolFeeBps` (default 5%, capped at `MAX_PROTOCOL_FEE_BPS = 1000` / 10%) is applied to `interest` in `repayLoan` (line 1082 `fee = (interest * effectiveFeeBps) / BPS`). Rounding favors the borrower (floor division on `interest`). Importantly, the BATCH-D H9 fix snapshots `protocolFeeBpsAtCreate` into the `LoanOffer` struct, so live governance changes cannot retroactively re-tax in-flight loans. **This is the one place where the lens partially applies, and it is already hardened against retroactive abuse.**

### "Skipped accrual on first borrow → free interest" — N/A
There is a `LoanTooRecent` guard (line 1023) that reverts repay in the same block as `acceptOffer`. Interest naturally accrues from `block.timestamp == startTime + 1` onward. The `MIN_INTEREST_DURATION` (1 day) and `MIN_INTEREST_PRINCIPAL_BPS` (5 bps) floors plug the LD-H2 / LD3-H2 same-block flash-borrow vector. No "free first-block interest" surface remains.

### "Huge utilization (>100%) — does math wrap?" — N/A
No utilization metric exists. The internal multiplication in `calculateLoanInterest` is bounded by `MAX_PRINCIPAL_CEILING * MAX_APR_BPS_CEILING = 1e23 * 1e5 = 1e28`, far below the uint256 ceiling. `Math.mulDiv` provides 512-bit safety on the elapsed-multiplication leg.

### "Rate jump after kink — verifiable monotone, no negative rates" — N/A
No kink. APR is a single fixed value per loan. `aprBps` is bounded `[minAprBps, maxAprBps]` at creation, and `minAprBps >= 0` (no negative-APR encoding possible — uint256 unsigned). The LD3-H2 flat floor (5 bps) ensures even a 0-APR offer accrues *some* interest — there is no "negative" surface.

### "Negative interest possible via param manipulation by admin?" — N/A
Admin cannot touch in-flight loans' APR. The `applyMaxAprBpsChange` and `applyMinAprChange` functions only affect future `createLoanOffer` validations. Existing loans pin `aprBps` in the `Loan` struct at acceptance.

### "Cumulative index drift / overflow over years" — N/A
No cumulative index. Each loan has a self-contained `startTime` (`block.timestamp` at acceptance) and is repaid/defaulted within `[minDuration, maxDuration]` = `[4 hours, 3650 days]`. Even at `MAX_DURATION_CEILING` (10 years) and the cap-ceiling extremes, the multiplication stays well within uint256 bounds.

### "'Reset' of borrow index on admin call — leftover drift exploits old positions" — N/A
No borrow index exists. Closest analog: `pauseStartTime` / `totalPausedDuration` accounting. `_pause` snapshots `pauseStartTime`, `_unpause` accumulates the elapsed delta into `totalPausedDuration`, and per-loan `pausedDurationAtStart` (DEEP-LD2-M4 fix, line 944) ensures pre-loan pauses cannot retroactively extend a new loan's deadline. The math is monotonic and battle-tested by prior agent waves.

### "exchangeRateStored vs exchangeRateCurrent inconsistency (cToken-style)" — N/A
There is no exchange rate. Lenders deposit raw ETH into individual offers; redemption is via `cancelOffer` (refund principal + held origination fee, line 825-841) or via `repayLoan` (lender receives `principal + interest - protocolFee`, line 1083). No share-token / liquidity-token abstraction.

### "View functions return stale data without accrual" — Partial: see F-08-K-03
The closest analog is `getRepaymentAmount` and `isDefaulted`, which compute against `effectiveDeadline + GRACE_PERIOD` but *not* the L2 sequencer-outage buffer. Surfaced as F-08-K-03 above.

---

## Notes / Methodology

- Read TegridyLending.sol top-to-bottom (constructor, offer flow, accept flow, repay flow, default flow, escrow rewards, view helpers, admin apply hooks, pause hooks).
- Cross-checked `LoanOffer` and `Loan` struct lifecycles to confirm `aprBps` is pinned at acceptance and no admin path can mutate it.
- Verified `calculateInterest` / `calculateLoanInterest` math against the documented invariants (Ceil rounding, 512-bit mulDiv, pro-rata simple interest).
- Verified the minimum-interest floor (`MIN_INTEREST_DURATION` + `MIN_INTEREST_PRINCIPAL_BPS`) gates and the LD3-H2 / DEEP-LD-M6 / LD2-H2 fix lineage.
- Verified BATCH-D H9 (`protocolFeeBpsAtCreate` snapshot) closes the retroactive-tax siphon on in-flight loans.
- Verified DEEP-LD2-M4 (`pausedDurationAtStart`) closes the pre-loan-pause-extension siphon.
- Did **not** read `*.md` audit history per scope.
- Did **not** modify any source files.
