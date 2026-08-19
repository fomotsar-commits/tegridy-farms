# Tegriddy Farms Roadmap

Reconciled against the repo on 2026-08-19. Each item carries a one-sentence scope, a
success metric, and a **Status** line that says what the tree actually contains.

Status vocabulary, used the same way in [`docs/BATTLE_PLAN.md`](docs/BATTLE_PLAN.md):

- **shipped** — the metric is met, on-chain or in production.
- **in the tree** — the code is merged and tested, but the metric names an outcome
  (a deploy, a migration, an epoch) that has not happened. Merged is not live.
- **not built** — no implementation exists.

Two horizons feed this file: [`docs/YEAR_PLAN_2026_2027.md`](docs/YEAR_PLAN_2026_2027.md)
is the operational plan for Sep 2026 → Aug 2027, and
[`docs/BATTLE_PLAN.md`](docs/BATTLE_PLAN.md) carries per-item build instructions. Where
this file and either of those disagree, they are newer. `V2_ROADMAP.md` remains the
backlog of technical issues feeding these quarters.

---

## Q2 2026 — Foundation Complete

Ship the last of the architectural fixes so the core stack (farming, lending, drop, gauge) is production-clean before turning the revenue taps on.

1. **TegridyLPFarming redeploy**
   - Scope: Redeploy the LP farming contract with the C-01 fixed accounting fix and migrate existing stakers via snapshot + claim window.
   - Metric: 100% of legacy LP stakers migrated (or explicitly opted out) within 30 days of cutover, with no reward-math reverts in post-deploy monitoring.
   - **Status: shipped (contract), open (migration).** The C-01 farming contract is live and wired in `frontend/src/lib/constants.ts`; the two prior deployments are recorded as superseded in `frontend/src/lib/docsAddressTruth.test.ts`. The staker-migration half has no completion record anywhere in the repo, and emissions are a standing question — the year plan's Q1 line is "restart emissions or say so in the UI".

2. **TegridyNFTLending grace period**
   - Scope: Add a fixed grace window between loan expiry and liquidation so borrowers have a chance to repay before collateral is seized.
   - Metric: Zero liquidations executed inside the grace window and <5% of loans liquidated overall across the first full month.
   - **Status: shipped (contract), unmeasured.** `contracts/src/TegridyNFTLending.sol` defines `GRACE_PERIOD = 1 hours` as a post-deadline repayment window, plus a separate sequencer grace and a pause-extended grace from later audit fixes. The V2 lending contract is live. The metric is a production statistic and nothing in the repo has measured it, so it is neither met nor missed.

3. **TegridyDropV2 cancelSale / refund**
   - Scope: Ship `cancelSale()` and buyer-side refund paths so a failed or paused drop returns ETH cleanly. (Lives on `TegridyDropV2` — V1 `TegridyDrop` source was deleted 2026-04-19.)
   - Metric: All refunds settle in a single tx with 100% of deposited ETH accounted for in automated invariant tests.
   - **Status: shipped.** `cancelSale()` and `refund()` are both on `contracts/src/TegridyDropV2.sol` with Foundry coverage.

4. **Commit-reveal gauge UI**
   - Scope: Front-end for H-2 commit-reveal voting (commit phase, reveal phase, nullifier tracking) wired to the new GaugeController.
   - Metric: >90% reveal rate across the first three epochs; <1% stuck commits needing manual resolution.
   - **Status: in the tree, dark.** `frontend/src/components/GaugeVoting.tsx` and `components/community/VoteIncentivesSection.tsx` implement both phases, but `GAUGE_CONTROLLER_ADDRESS` and `VOTE_INCENTIVES_ADDRESS` are still the zero address, so every surface renders its not-deployed gate. No epoch has run; there is no reveal rate to report. Un-gating is a year-plan Q2 operator item and the deployed-vs-wired distinction is pinned by `frontend/src/pages/deployClaimHonesty.test.ts`.

---

## Q3 2026 — Revenue Activation

Turn the protocol on as a revenue-generating machine. Fee plumbing, pair-level tuning, and a tier system that replaces the old Premium flag.

5. **Fee split activation**
   - Scope: Route the venue's fee lines through the deployed `SwapFeeRouter` → `ReferralSplitter` → `RevenueDistributor` / `POLAccumulator` stack and start the distribution clock.
   - Metric: Weekly distributions run autonomously (no manual forwarding) for 8 consecutive weeks with on-chain reconciliation matching off-chain accounting to the wei.
   - **Status: not built, and this item previously described a split that does not exist.** It named a fixed three-way allocation across stakers, treasury and POL, with a specific percentage on each leg. The figures are not reproduced here, because `FAQ.md` is guarded against exactly that shape (`frontend/src/lib/docsAddressTruth.test.ts`) and a correction that restates the number is still a number a reader can screenshot. What is real: the live router exposes a staker-share dial (presently at its ceiling) and a POL-share dial (presently zero), with a referral share taken ahead of both that the contracts refuse to let anyone zero out — so the arithmetic the old wording implied cannot occur. The ceilings the contract enforces are in `TOKENOMICS.md`. The operator sequence that moves either dial — propose, wait the timelock, execute, in a fixed order — is in `docs/YEAR_PLAN_2026_2027.md` under Q1 "First revenue". A separate venue fee layer for aggregator routes is in the tree and switched off; see `docs/BATTLE_PLAN.md` #3.

6. **Pair-specific fees**
   - Scope: Per-pair fee override in the router so TOWELI pairs can run at 1% while blue-chip pairs stay at the default.
   - Metric: TOWELI-pair fee revenue at least 3× pre-change monthly baseline with no measurable volume loss on non-TOWELI pairs.
   - **Status: not built.** Neither `TegridyFactory` nor `TegridyPair` carries a per-pair fee override; the pair fee is a constant. This would be new immutable contract surface and therefore an audit wave, not a parameter change.

7. **Tier system replacing Premium**
   - Scope: Replace the binary Premium flag with a tiered system (e.g. Bronze/Silver/Gold) keyed off stake size × lock duration, unlocking fee discounts and boost multipliers.
   - Metric: >30% of active stakers fall into a paid tier; average lock duration increases by at least 2 weeks vs. Q2 baseline.
   - **Status: not built.** `PremiumAccess` is deployed and wired and remains binary. A tier concept does exist in the product, but it is the Heat tier read from the Jungle Bay Island oracle, which is a wallet-history score the venue reads and never computes — it is not a staking tier and must not be conflated with one. The nearest live consumer is launch pricing (`frontend/src/lib/launcher/launchPricing.ts`, default off).

---

## Q4 2026 — Growth

Push the product out. Marketing, automation, and a credible L2 story.

8. **Launchpad bundle marketing**
   - Scope: Coordinated campaign packaging TegridyDropV2 + LP farming + lending as a one-stop launchpad for new tokens, with case studies and paid creator content.
   - Metric: At least 5 external projects launch via the bundle in Q4, with a combined drop TVL of $1M+.
   - **Status: not started.** Community channels are not registered yet (`docs/COMMUNITY_LAUNCH.md` is written; the registrations are operator work in `docs/OPERATOR_NEXT.md`), and no external project has launched through the venue.

9. **Keeper for DCA / LimitOrders**
   - Scope: Deploy an automated keeper (Gelato or Chainlink Automation) that executes DCA schedules and limit orders created through the UI.
   - Metric: 99% on-time execution rate across a rolling 1,000-order sample; median execution delay under 2 blocks past trigger.
   - **Status: not built.** Limit/TWAP/DCA and the newer trigger orders are expressed as CoW conditional orders and executed by CoW's watchtower, which only serves ERC-1271 wallets and only the shapes its handlers can express. Everything else — every EOA, every trailing stop, all Solana — has no executor, and `frontend/src/lib/triggers/armState.ts` renders those cases as explicitly unarmed rather than pretending. The venue keeper is track F4 in `docs/BATTLE_PLAN.md`.

10. **Base L2 deployment consideration**
    - Scope: Full deploy scripts, chain-specific router/WETH config, and a go/no-go review (gas + user demand) for launching core contracts on Base.
    - Metric: Ship-ready deploy scripts merged and a published decision memo; if launched, $500K+ TVL within 60 days of Base mainnet deploy.
    - **Status: not started.** No memo, no Base deploy scripts. Carried forward as year-plan Q4 and as `docs/BATTLE_PLAN.md` #37.

---

## 2027+ — Long Horizon

Hand more of the protocol over to the community and widen the surface area.

11. **Governance v2**
    - Scope: Move from multisig + timelock to on-chain governance with IVotes-delegated veTOWELI voting power, Tally/Snapshot-onchain compatibility, and proposal templates for parameter changes.
    - Metric: First 5 executed proposals pass with >10% of circulating veTOWELI participating and zero critical admin actions left outside governance.
    - **Status: not built, and blocked upstream.** The prerequisite is custody: today one EOA owns the contract set and the Safe re-home is the year plan's critical path (`docs/SAFE_REHOME_RUNBOOK.md`). IVotes delegation is in the Q4 v2 batch.

12. **Treasury grants**
    - Scope: Formalize a CommunityGrants program with public applications, milestone payouts, and quarterly reporting.
    - Metric: At least 10 funded grants in the first year with 70%+ reaching their final milestone and a public dashboard showing every outflow.
    - **Status: contract in the tree, program not started.** `CommunityGrants` is deployed but not wired into `constants.ts`, so its UI is gated. House law forbids funding it out of capital the protocol has not earned, which makes item 5 its real precondition.

13. **Community partnerships**
    - Scope: Integration and co-marketing deals with adjacent DeFi protocols (aggregators, perps, yield routers) that route volume or liquidity into Tegriddy pairs.
    - Metric: At least 3 signed partnerships delivering a combined 20%+ of monthly swap volume within 6 months of launch.
    - **Status: not started.** Note that "perps" here means routing to someone else's venue; a native perps market is explicitly off the menu per `docs/YEAR_PLAN_2026_2027.md`.

---

## Dependencies & Risk Notes

- Q3 revenue work depends on the custody re-home landing first: every dial named in item 5 is moved by a timelocked proposal that only an owner can send, and the owner is being replaced.
- Tier system (Q3 #7) depends on the `increaseAmount()` addition (V2 #4) so users can upgrade tiers without unstaking.
- L2 deploy (Q4 #10) requires the L2 deploy scripts from V2 #12 and chain-specific TWAP oracle work from V2 #14.
- Governance v2 (2027 #11) depends on voting-power delegation (V2 #9) and clean IVotes interface cleanup (V2 #15).
- Several 2026 metrics above are production statistics that nothing in this repo measures. Until the indexer is hosted (`docs/BATTLE_PLAN.md` F1), "unmeasured" is the honest status for them, and it is not a synonym for "met".
