# ADR-001 — Keeper choice for recurring swaps + limit orders

- **Status:** PROPOSED — awaiting ops + product decision.
- **Date opened:** 2026-05-14
- **Author:** frontend / 30-day UX push (P1-4)
- **Supersedes:** the localStorage-backed "Recurring Swap" / "Price
  Alert" tabs pulled in P1-4. Component files
  (`frontend/src/components/swap/DCATab.tsx`,
  `frontend/src/components/swap/LimitOrderTab.tsx`) stay on disk for
  the rebuild.

---

## Context

The Tegridy Farms swap surface shipped a "Recurring Swap" (DCA) and a
"Price Alert" (limit-order) flow that **persisted state only in browser
localStorage and only triggered while the user had the tab open**. The
UI implied automated execution; the implementation could not deliver
it. The 30-day UX push (P1-4) classified this as "the most dangerous
UX in the app" and pulled both tabs.

To bring the features back honestly, every "fires later" condition
needs to live somewhere that doesn't depend on the user's browser.
That means a keeper: a third-party (or self-hosted) bot that watches
chain state and pings the protocol when a user's condition is met.

## Decision

**Current state: option (D) — features remain off until an operator
picks one of options (A), (B), or (C) below.**

The frontend code path for both tabs is removed; the data hooks
(`useDCA`, `useLimitOrders`) stay on disk and continue to read their
historical localStorage entries so users with pending state can see
it; new entries are not surfaced from the dashboard. When this ADR is
accepted with a concrete option, the UI rebuild is mechanical.

## Options

### A — Gelato Network

- **Mechanism:** managed automation; the user signs a "create task"
  message; Gelato's keepers call the protocol method when the
  condition is met. Costs are paid in 1Balance or per-execution gas.
- **Pros:** zero-ops; broad chain support; battle-tested
  ($billions in volume); SDK + frontend integration is well-paved.
- **Cons:** non-trivial fees (gelato takes a slice + execution gas);
  some flexibility constraints around what a task can read.
- **Contract impact:** small wrapper contract that holds user
  intents and is callable only by Gelato's executor address (or a
  Gelato `IOps` integration).
- **Frontend impact:** wallet signs a "createTask" tx; UI shows
  status straight from chain.

### B — Chainlink Automation

- **Mechanism:** similar to Gelato but with Chainlink's keeper
  network; tasks are time-based or condition-based; the user funds
  a registry with LINK or a per-job fee.
- **Pros:** Chainlink brand + decentralised keepers; deep DeFi
  integration; conditional triggers via "Custom Logic" contracts.
- **Cons:** LINK funding adds a UX hop (users have to buy LINK or
  the UI does it via the SwapFeeRouter); Chainlink Automation v2.x
  recurring payments need careful design.
- **Contract impact:** moderate — `checkUpkeep` / `performUpkeep`
  interface, keeper-only `performUpkeep` modifier.
- **Frontend impact:** similar to Gelato; one extra step for LINK
  funding unless we abstract it.

### C — Self-hosted keeper bot

- **Mechanism:** a small Node service we run that watches chain +
  protocol storage and calls the protocol when conditions are met.
- **Pros:** zero third-party fees; full control over execution
  policy and timing; matches the existing `indexer/` deployment
  pattern.
- **Cons:** we eat the gas; key management for the keeper EOA is
  ops-critical; single-point-of-failure unless we run two regions;
  upstream RPC quotas become our problem.
- **Contract impact:** none if we whitelist a keeper EOA + multisig
  rotation; small if we move to a `Restricted` modifier with a
  pluggable executor.
- **Frontend impact:** identical to options (A) / (B) — wallet
  creates an intent on-chain; keeper picks it up.

### D — Keep features off (default until decided)

- **Mechanism:** no keeper. The localStorage-backed tabs stay
  removed. Frontend hides DCA + Limit Order tabs entirely; users see
  only on-chain primitives (Swap, Liquidity).
- **Pros:** zero new code paths to break; zero new attack surface;
  matches the user safety bar the 30-day push set.
- **Cons:** lose two CTAs that were on the page.

## Comparison

| Axis                       | (A) Gelato | (B) Chainlink Automation | (C) Self-hosted | (D) Off |
| -------------------------- | ---------- | ------------------------ | --------------- | ------- |
| Time-to-ship               | 2–3 days   | 3–5 days                 | 4–7 days        | 0 days  |
| Recurring per-tx cost      | medium     | medium                   | low (gas only)  | n/a     |
| Ops overhead               | low        | low                      | high            | none    |
| Decentralisation           | high       | highest                  | low             | n/a     |
| Contract change required   | small      | moderate                 | none / small    | none    |
| Migration if vendor exits  | painful    | painful                  | n/a             | n/a     |

## Recommendation

If we want the features back fastest with the lowest contract risk,
**option A (Gelato)** is the closest match. **Option C (self-hosted)**
is the right pick if the team already has a Node service runtime
(`indexer/` does — see `FRONTEND_BLOCKERS.md` B-1) and prefers
eating the gas to paying a vendor fee, especially for low-volume
limit orders.

This ADR doesn't pick; it lays out the decision. Operator: when ready,
fill in the **Decision** section at top, update the status to
**ACCEPTED**, and re-open the tabs in `TradePage.tsx`.

## References

- `FRONTEND_BLOCKERS.md` — B-5 (this feature pause), B-1 (indexer
  host, relevant to option C).
- `frontend/src/components/swap/DCATab.tsx`,
  `frontend/src/components/swap/LimitOrderTab.tsx` — preserved
  starting points for the UI rebuild.
- `frontend/src/hooks/useDCA.ts`, `frontend/src/hooks/useLimitOrders.ts`
  — localStorage adapters; keep until on-chain replacement ships.
