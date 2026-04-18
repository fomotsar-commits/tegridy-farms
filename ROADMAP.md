# Tegriddy Farms Roadmap

Forward-looking plan through 2027+. Each item lists a one-sentence scope and a success metric.
See `V2_ROADMAP.md` for the backlog of technical issues feeding into these quarters.

---

## Q2 2026 — Foundation Complete

Ship the last of the architectural fixes so the core stack (farming, lending, drop, gauge) is production-clean before turning the revenue taps on.

1. **TegridyLPFarming redeploy**
   - Scope: Redeploy the LP farming contract with the C-01 fixed accounting fix and migrate existing stakers via snapshot + claim window.
   - Metric: 100% of legacy LP stakers migrated (or explicitly opted out) within 30 days of cutover, with no reward-math reverts in post-deploy monitoring.

2. **TegridyNFTLending grace period**
   - Scope: Add a fixed grace window between loan expiry and liquidation so borrowers have a chance to repay before collateral is seized.
   - Metric: Zero liquidations executed inside the grace window and <5% of loans liquidated overall across the first full month.

3. **TegridyDrop cancelSale / refund**
   - Scope: Ship `cancelSale()` and buyer-side refund paths so a failed or paused drop returns ETH cleanly.
   - Metric: All refunds settle in a single tx with 100% of deposited ETH accounted for in automated invariant tests.

4. **Commit-reveal gauge UI**
   - Scope: Front-end for H-2 commit-reveal voting (commit phase, reveal phase, nullifier tracking) wired to the new GaugeController.
   - Metric: >90% reveal rate across the first three epochs; <1% stuck commits needing manual resolution.

---

## Q3 2026 — Revenue Activation

Turn the protocol on as a revenue-generating machine. Fee plumbing, pair-level tuning, and a tier system that replaces the old Premium flag.

5. **70/20/10 fee split**
   - Scope: Route swap + drop + lending fees into a splitter that sends 70% to stakers (RevenueDistributor), 20% to treasury, 10% to POL accumulator.
   - Metric: Weekly distributions run autonomously (no manual forwarding) for 8 consecutive weeks with on-chain reconciliation matching off-chain accounting to the wei.

6. **Pair-specific fees**
   - Scope: Per-pair fee override in the router so TOWELI pairs can run at 1% while blue-chip pairs stay at the default.
   - Metric: TOWELI-pair fee revenue at least 3× pre-change monthly baseline with no measurable volume loss on non-TOWELI pairs.

7. **Tier system replacing Premium**
   - Scope: Replace the binary Premium flag with a tiered system (e.g. Bronze/Silver/Gold) keyed off stake size × lock duration, unlocking fee discounts and boost multipliers.
   - Metric: >30% of active stakers fall into a paid tier; average lock duration increases by at least 2 weeks vs. Q2 baseline.

---

## Q4 2026 — Growth

Push the product out. Marketing, automation, and a credible L2 story.

8. **Launchpad bundle marketing**
   - Scope: Coordinated campaign packaging TegridyDrop + LP farming + lending as a one-stop launchpad for new tokens, with case studies and paid creator content.
   - Metric: At least 5 external projects launch via the bundle in Q4, with a combined drop TVL of $1M+.

9. **Keeper for DCA / LimitOrders**
   - Scope: Deploy an automated keeper (Gelato or Chainlink Automation) that executes DCA schedules and limit orders created through the UI.
   - Metric: 99% on-time execution rate across a rolling 1,000-order sample; median execution delay under 2 blocks past trigger.

10. **Base L2 deployment consideration**
    - Scope: Full deploy scripts, chain-specific router/WETH config, and a go/no-go review (gas + user demand) for launching core contracts on Base.
    - Metric: Ship-ready deploy scripts merged and a published decision memo; if launched, $500K+ TVL within 60 days of Base mainnet deploy.

---

## 2027+ — Long Horizon

Hand more of the protocol over to the community and widen the surface area.

11. **Governance v2**
    - Scope: Move from multisig + timelock to on-chain governance with IVotes-delegated veTOWELI voting power, Tally/Snapshot-onchain compatibility, and proposal templates for parameter changes.
    - Metric: First 5 executed proposals pass with >10% of circulating veTOWELI participating and zero critical admin actions left outside governance.

12. **Treasury grants**
    - Scope: Formalize a CommunityGrants program (funded from the treasury slice of the 70/20/10 split) with public applications, milestone payouts, and quarterly reporting.
    - Metric: At least 10 funded grants in the first year with 70%+ reaching their final milestone and a public dashboard showing every outflow.

13. **Community partnerships**
    - Scope: Integration and co-marketing deals with adjacent DeFi protocols (aggregators, perps, yield routers) that route volume or liquidity into Tegriddy pairs.
    - Metric: At least 3 signed partnerships delivering a combined 20%+ of monthly swap volume within 6 months of launch.

---

## Dependencies & Risk Notes

- Q3 revenue work assumes Q2 fee-routing fix (V2 item #1) has shipped — if it slips, the 70/20/10 split lags.
- Tier system (Q3 #7) depends on the `increaseAmount()` addition (V2 #4) so users can upgrade tiers without unstaking.
- L2 deploy (Q4 #10) requires the L2 deploy scripts from V2 #12 and chain-specific TWAP oracle work from V2 #14.
- Governance v2 (2027 #11) depends on voting-power delegation (V2 #9) and clean IVotes interface cleanup (V2 #15).
