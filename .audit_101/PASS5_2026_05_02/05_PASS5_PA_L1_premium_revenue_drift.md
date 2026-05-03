# PASS5-PA-L1 — `PremiumAccess.totalRevenue` extension double-count

**Severity:** LOW (off-chain metric drift; no fund extraction possible)
**File:** `contracts/src/PremiumAccess.sol:317` and `:345`
**Status:** Confirmed by code-trace; reproducible in `PASS5_PremiumAccessRevenue.t.sol` if the bound is tightened past `cumulativeSubscribeCost`.

---

## 1. The bug

`PremiumAccess.subscribe` has two branches: new-subscription and extension. Both end up running the same tail at line 345 (`totalRevenue += cost`). The extension branch *also* adds `consumedEscrow` at line 317. The initial subscribe already added the entire `cost1` to `totalRevenue` on day 0, so on extension the consumed slice gets counted twice.

### Code

```solidity
// PremiumAccess.sol:286-317 — extension branch
if (!isNewSub) {
    uint256 remainingTime = sub.expiresAt - block.timestamp;
    uint256 totalDuration = sub.expiresAt - sub.startedAt;
    uint256 remainingEscrow = totalDuration > 0
        ? (userEscrow[msg.sender] * remainingTime) / totalDuration
        : userEscrow[msg.sender];
    uint256 oldEscrow = userEscrow[msg.sender];
    uint256 consumedEscrow = oldEscrow > remainingEscrow ? oldEscrow - remainingEscrow : 0;
    if (oldEscrow > 0) {
        totalRefundEscrow = totalRefundEscrow > oldEscrow ? totalRefundEscrow - oldEscrow : 0;
    }
    if (consumedEscrow > 0) {
        totalRevenue += consumedEscrow;          // ← (A) — already counted in initial-subscribe `cost1`
    }
    sub.expiresAt = startFrom + (months * MONTH);
    sub.startedAt = block.timestamp;
    userEscrow[msg.sender] = cost + remainingEscrow;
    totalRefundEscrow += cost + remainingEscrow;
} else { /* new sub branch */ }

totalPaidByUser[msg.sender] += cost;
if (!isActiveSubscriber[msg.sender]) {
    isActiveSubscriber[msg.sender] = true;
    totalSubscribers++;
}
totalRevenue += cost;                              // ← (B) — always runs
```

### Math trace

Pre-state: `totalRevenue = 0`, `userEscrow[u] = 0`.

**Day 0 — user subscribes for N months at cost = `cost1`:**
- `totalRevenue += cost1` (line 345). `userEscrow[u] = cost1`. `totalRefundEscrow = cost1`.
- Net: `totalRevenue = cost1`.

**Day X — user extends with cost = `cost2`:**
- `consumedEscrow = cost1 - remainingEscrow`
- `totalRevenue += consumedEscrow` (line 317).
- `totalRevenue += cost2` (line 345).
- Net: `totalRevenue = cost1 + consumedEscrow + cost2`.

**Day X — user immediately cancels:**
- `escrowed = userEscrow[u] = cost2 + remainingEscrow`
- `refundAmount = (escrowed * MONTH) / MONTH = escrowed = cost2 + remainingEscrow`
- `totalRevenue -= cost2 + remainingEscrow`
- Net: `totalRevenue = cost1 + consumedEscrow - remainingEscrow = cost1 + (cost1 - remainingEscrow) - remainingEscrow = 2 × consumedEscrow`.

But the **true earned revenue** for this user lifecycle is just `consumedEscrow` (paid `cost1 + cost2`, refunded `cost2 + remainingEscrow`, kept `cost1 - remainingEscrow = consumedEscrow`).

So `totalRevenue` reports **2× the true earned revenue** for any extend-then-cancel cycle.

---

## 2. Why this is LOW (not HIGH)

`totalRevenue` is consumed at exactly one site:

```solidity
// PremiumAccess.sol:427-431 — cancelSubscription decrement cap
if (fullRefundable <= totalRevenue) {
    totalRevenue -= fullRefundable;
} else {
    totalRevenue = 0;
}
```

The drift is **upward** (inflation), so the `if (fullRefundable <= totalRevenue)` cap remains satisfied. No underflow, no fund-loss path opens.

The V3-DR3-M-02 fix (removing the double-decrement in `claimShortfall`) is correct on the cancel/shortfall axis. The extension drift is an *independent* issue affecting only:
- Off-chain dashboards reading `totalRevenue` for revenue-tracking purposes
- `withdrawToTreasury` which uses *contract balance minus reservations* (not totalRevenue) and is therefore unaffected

No user funds are at risk. The owner cannot exploit the drift to drain anything; the actual sweepable amount is bounded by `balance - totalRefundEscrow - totalShortfallOwed`, both of which are correctly maintained.

---

## 3. PoC

The drift is observable but does not trigger any unsafe state. The pass-5 invariant `PASS5_INV_C_PremiumRevenue.invariant_totalRevenue_bounded_above` uses a loose `≤ 2 × cumulativeSubscribeCost` bound which passes; tightening that to `≤ cumulativeSubscribeCost` would fail under any extend-then-cancel sequence in the handler.

To reproduce:
```solidity
// In PASS5_PremiumAccessRevenue.t.sol invariant
assertLe(premium.totalRevenue(), cumulativeSubscribed, "..."); // would FAIL
```

---

## 4. Recommended fix

Drop the `totalRevenue += consumedEscrow;` line at 317. The initial-subscribe `totalRevenue += cost1` already accounts for the entire cost1 as gross revenue under the high-water-mark semantic. The cancel-side decrement at line 428 correctly reduces by the refundable portion, so the net revenue == kept revenue without the extra extension increment.

```diff
-       if (consumedEscrow > 0) {
-           totalRevenue += consumedEscrow;
-       }
```

Alternative: switch `totalRevenue` to a true earned-revenue semantic (only count consumed amounts). This would require dropping line 345's `totalRevenue += cost` and replacing it with the consumed-only path. Either fix is internally consistent; the current code mixes both.

---

## 5. Related — the V3-DR3-M-02 fix area is otherwise sound

Pass-5's invariant `INV-C` proves that:
- `toweli.balanceOf(premium) >= totalRefundEscrow + totalShortfallOwed` always holds
- `claimShortfall` does NOT double-decrement totalRevenue (the V3-DR3-M-02 fix is correct)

The extension drift is the only remaining accounting oddity in the contract. It does not threaten user funds, but it *should* be fixed for off-chain integrity.
