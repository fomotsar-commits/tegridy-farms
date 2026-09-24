# Agent 74 — L2 Sequencer Downtime / Grace Period Audit

Lens: `contracts/src/lib/SequencerCheck.sol` and every consumer that imports it.
Working dir: `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms`.
Scope: gating correctness on read AND write paths; borrower vs lender asymmetry; resume grace; multi-feed semantics; `feed == address(0)` silent disable; GRACE_PERIOD value sanity; time math off-by-one; stale uptime feed; negative / 1 / >1 answer handling; `startedAt = 0`.

Consumers reviewed (all verified):
- `contracts/src/TegridyLending.sol`
- `contracts/src/TegridyNFTLending.sol`
- `contracts/src/TegridyTWAP.sol`
- `contracts/src/POLAccumulator.sol`
- `contracts/src/SwapFeeRouter.sol`
- `contracts/src/TegridyDropV2.sol` (clone implementation)
- `contracts/src/TegridyLaunchpadV2.sol` (factory; threads feed into clones)
- `contracts/src/MemeBountyBoard.sol`

---

## F-74-1 — SwapFeeRouter and TegridyNFTLending one-shot `setSequencerFeed` is NEVER called by ANY deploy script

`contracts/src/SwapFeeRouter.sol:202` — `address public sequencerFeed;` (mutable, default `address(0)`).
`contracts/src/SwapFeeRouter.sol:532` — `setSequencerFeed(_feed)` is one-shot.
`contracts/src/TegridyNFTLending.sol:82` — `address public sequencerFeed;` (mutable, default `address(0)`).
`contracts/src/TegridyNFTLending.sol:390` — `setSequencerFeed(_sequencerFeed)` is one-shot.

Audit grep across `contracts/script/*.sol`: zero matches for `setSequencerFeed`, `swapRouter.setSequencer`, or `swapFeeRouter.setSequencer`. No deploy script wires the feed into either contract.

Result on every L2 deploy as scripts stand today (`DeployV2.s.sol`, `DeployFinal.s.sol`, `DeployRemaining.s.sol`, `DeployLaunchpadV2.s.sol`, `DeploySepolia.s.sol`, `DeployAuditFixes.s.sol`, `DeployTWAP.s.sol`):
- `SwapFeeRouter._enforceTWAPMinETHOut` line 1971 calls `SequencerCheck.checkSequencerUp(address(0), …)` → no-op.
- `TegridyNFTLending.repayLoan` line 649 / `claimDefault` line 744 call `SequencerCheck.*(address(0), …)` → no-op.

Owner key compromise during the post-deploy window (between deploy and a manual `setSequencerFeed` call) is the only line of defense. Any L2 outage in that window straight-up bypasses every protection clauses in the lib were written to provide.

Exploit during outage: SwapFeeRouter's per-token TWAP snapshot integrates straight across the outage window; `_enforceTWAPMinETHOut` derives the floor from pre-outage manipulated reserves; first post-resume conversion drains accumulated token fees into ETH at the attacker's chosen rate. NFTLending claim/repay symmetry is broken: lender can `claimDefault` immediately after resume even when the borrower's repay window was eaten by the outage.

Severity: **HIGH** (configuration). Fix: add an `assert(swapRouter.sequencerFeed() != address(0))` post-call guard in deploy scripts on L2; or convert both fields to constructor args immutable, removing the silent-default surface entirely.

---

## F-74-2 — `vm.envOr("SEQUENCER_FEED", address(0))` silently no-ops on every deploy script when env var unset

Every deploy script that takes a feed reads via `vm.envOr("SEQUENCER_FEED", address(0))`:
- `contracts/script/DeployV2.s.sol:144`
- `contracts/script/DeployFinal.s.sol:137,157`
- `contracts/script/DeployRemaining.s.sol:49`
- `contracts/script/DeployLaunchpadV2.s.sol:38`
- `contracts/script/DeploySepolia.s.sol:153,173`
- `contracts/script/DeployAuditFixes.s.sol:98`
- `contracts/script/DeployTWAP.s.sol:29`

A deployer who runs the L2 script without first exporting `SEQUENCER_FEED` deploys with feed = 0. There is no chain-id-vs-feed sanity guard. `DeployV2.s.sol` does have a `block.chainid == 1` mainnet-only guard at line 47 — that's good for that one script, but the other six scripts do not. The L2-targeting deploy scripts (`DeployLaunchpadV2`, `DeployRemaining`, `DeployFinal`, `DeployAuditFixes`, `DeployTWAP`, `DeploySepolia`) silently accept `address(0)` and burn the configuration mistake into immutable storage.

For the immutable-feed contracts (`TegridyLending`, `TegridyTWAP`, `POLAccumulator`, `MemeBountyBoard`, `TegridyLaunchpadV2`, all `TegridyDropV2` clones spawned by it), there is **no recovery path** other than a full redeploy.

Severity: **HIGH** (configuration / immutability trap). Fix: per-chain `require(block.chainid == 1 || SEQUENCER_FEED != address(0))` guard in every deploy script, or refuse `vm.envOr` default and force `vm.envAddress` so unset env aborts the deploy.

---

## F-74-3 — TegridyDropV2 dutch auction timeline is consumed by sequencer outages (no buffer / extension)

`contracts/src/TegridyDropV2.sol:624-634` — `_dutchAuctionPrice` reverts during outage and post-resume grace, but the price-decay clock at `contracts/src/TegridyDropV2.sol:642-647` continues to use raw `block.timestamp - dutchStartTime` against `dutchDuration`.

If an outage of duration `D` overlaps with the auction window:
- Mints during the outage are blocked (correct).
- After resume + 1h grace, the auction has aged by `D + 1h`. If `D + 1h >= dutchDuration`, the price has bottomed at `dutchEndPrice` and stays there permanently.
- Honest buyers who would have bid at intermediate prices during the outage have no path: the auction does not pause or extend.

There is no equivalent of `getSequencerOutageBuffer` extension here (which `TegridyLending` and `TegridyNFTLending` apply to repay/claim deadlines). The mitigation today is owner-driven `cancelSale()` → `refund()` (`contracts/src/TegridyDropV2.sol:1012,1031`), which depends on the owner choosing to run the rescue.

Exploit: a buyer who knows or guesses the outage will be longer than the auction's remaining decay can wait it out and mint everything at `dutchEndPrice` the moment grace lifts, capturing the entire decay surface that honest buyers were locked out of. The asymmetry favours patient capital and chain-status-monitoring snipers over normal bidders.

Severity: **MEDIUM**. Fix: pause the decay during outage by tracking `outageBuffer` against `dutchStartTime`, mirroring the lending-side `getSequencerOutageBuffer` pattern, OR extend `dutchDuration` by the buffer at quote time.

---

## F-74-4 — TegridyTWAP `consult()` and TegridyDropV2 `_dutchAuctionPrice` use 24h staleness on price-sensitive paths despite the lib comment recommending 4h

`contracts/src/lib/SequencerCheck.sol:64-67` — comment explicitly says: "Lending / drop pricing should pick a tighter window (e.g. 4h) so a Chainlink keeper outage trips earlier on price-sensitive paths."

But the actual call sites:
- `contracts/src/TegridyTWAP.sol:497` — `SequencerCheck.checkSequencerUp(sequencerFeed, SEQUENCER_GRACE_PERIOD);` (2-arg → 24h staleness).
- `contracts/src/TegridyDropV2.sol:632` — `SequencerCheck.checkSequencerUp(sequencerFeed, SEQUENCER_GRACE_PERIOD);` (2-arg → 24h).
- `contracts/src/TegridyDropV2.sol:607` — `SequencerCheck.tryCheckSequencerUp(sequencerFeed, SEQUENCER_GRACE_PERIOD);` (2-arg → 24h).
- `contracts/src/SwapFeeRouter.sol:1971` — `SequencerCheck.checkSequencerUp(sequencerFeed, SEQUENCER_GRACE_PERIOD);` (2-arg → 24h).

Compare to the consistent 4h staleness used in lending and POL paths:
- `contracts/src/TegridyLending.sol:1223,1595` — `…SEQUENCER_GRACE_PERIOD, 4 hours`.
- `contracts/src/TegridyNFTLending.sol:744` — `…SEQUENCER_GRACE_PERIOD, 4 hours`.
- `contracts/src/POLAccumulator.sol:406,663` — `…SEQUENCER_GRACE_PERIOD, 4 hours`.

Exploit window: a Chainlink keeper that has not pushed for >4h but ≤24h will pass TWAP `consult`, Drop dutch quotes, and the SwapFeeRouter min-out gate, even though the cached "up" answer may no longer reflect reality. The exact attack surface that the 4h tightening was meant to close — applied asymmetrically.

Severity: **MEDIUM** (consistency / defense-in-depth gap). Fix: switch the four call sites to the 3-arg overload with `4 hours`.

---

## F-74-5 — TegridyLending `acceptOffer` lacks a top-level sequencer gate; relies on `_positionETHValue` which is conditionally invoked

`contracts/src/TegridyLending.sol:857-995` — the `acceptOffer` function entry. No `SequencerCheck.checkSequencerUp` at the top.
`contracts/src/TegridyLending.sol:912-915` — `_positionETHValue(positionAmount)` is called only when `minPositionETHValue > 0`.
`contracts/src/TegridyLending.sol:1585-1595` — `_positionETHValue` carries the gate.

A lender who creates an offer with `minPositionETHValue == 0` (the documented backward-compatible default) places no ETH-floor on the collateral, and `acceptOffer` therefore never reaches `_positionETHValue`. A borrower can accept the offer mid-grace at any post-resume moment, locking in the lender's principal against a position whose TOWELI count is the only validated signal.

Note: this is partially mitigated because `acceptOffer` does not VALUE collateral when `minPositionETHValue == 0` — the lender opted out of the ETH-floor, accepting whatever the position represents. But the offer becomes accept-able again the instant the chain wakes up; the lender's intent (formed before the outage) is cashed against post-outage state.

Severity: **LOW** (lender opted out of pricing, reducing the impact). Worth a top-level `SequencerCheck.checkSequencerUp(sequencerFeed, SEQUENCER_GRACE_PERIOD, 4 hours)` at the entry of `acceptOffer` for symmetry with `_positionETHValue` and `claimDefaultedCollateral`.

---

## F-74-6 — SequencerCheck `updatedAt == 0` reverts with `SequencerGracePeriodNotOver` but `tryCheckSequencerUp` returns distinct `TRY_ROUND_UNINIT`

`contracts/src/lib/SequencerCheck.sol:133` — `if (updatedAt == 0) revert SequencerGracePeriodNotOver();` (round-uninit treated as in-grace).
`contracts/src/lib/SequencerCheck.sol:206` — `if (updatedAt == 0) return (false, TRY_ROUND_UNINIT);` (try variant has dedicated reason byte).

Off-chain consumers branching on the typed selector `SequencerGracePeriodNotOver` to distinguish "wait then retry" from "feed is broken / ignore this chain" cannot distinguish the two states from the reverting overload — they see grace-not-over for both, even though the underlying causes diverge.

Exploit: limited (cosmetic / DX). But UX path divergence between `tryCheckSequencerUp` and `checkSequencerUp` is a foot-gun for any future contributor reasoning about either variant.

Severity: **LOW** (cosmetic / parallelism). Fix: add `error SequencerRoundUninitialized();` and revert it on the round-uninit branch in `checkSequencerUp` (matching the byte distinction in `tryCheckSequencerUp`).

---

## F-74-7 — `getResumeTimestamp` returns 0 when `startedAt == 0` (answer == 0 path); silently bypasses freshness gates

`contracts/src/lib/SequencerCheck.sol:317-364` — code path at line 363 returns `startedAt` directly even when `startedAt == 0` (after the `answer != 0` guard at line 350 has passed).

Caller pattern across the codebase: `if (resumeAt != 0 && best.timestamp < resumeAt + GRACE) revert …`. Examples:
- `contracts/src/TegridyTWAP.sol:794-797`
- `contracts/src/SwapFeeRouter.sol:1983-1986`
- `contracts/src/POLAccumulator.sol:824-827, 864-867`

When `startedAt == 0` (Chainlink round-uninit shape with `answer == 0` somehow set), `resumeAt = 0` → the `resumeAt != 0` short-circuit skips the freshness gate. Defense is restored only because every consumer ALSO calls `checkSequencerUp` first (which line 158 of the lib catches with `if (startedAt == 0) revert SequencerGracePeriodNotOver()`).

This works today, but is fragile: any new consumer that uses `getResumeTimestamp` without a prior `checkSequencerUp` gate inherits a silent bypass.

Severity: **INFO** (latent footgun for new consumers). Fix: in `getResumeTimestamp`, treat `startedAt == 0 && answer == 0` as the "unknown resume time" case explicitly, and either return a sentinel (`type(uint256).max`) or revert. Returning 0 cannot be distinguished by callers from "feed is mainnet no-op".

---

## F-74-8 — Year-2106 uint32 timestamp wrap breaks every `latest.timestamp < resumeAt + GRACE` post-resume freshness gate

The TWAP `Observation` struct in `TegridyTWAP.sol:97-102`, mirrored in `POLAccumulator.sol:44-49` and `TegridyLending.sol:74-79`, stores `timestamp` as `uint32`.

After Feb-2106 wrap of uint32, every site that does `uint256(observation.timestamp) < resumeAt + GRACE` will see a small post-wrap value on the LHS and a large unchanged uint256 on the RHS:
- `contracts/src/TegridyTWAP.sol:795`
- `contracts/src/SwapFeeRouter.sol:1984`
- `contracts/src/POLAccumulator.sol:825,865`

Consequence: permanent revert (`OracleRebootstrapping` / `TWAPBootstrapRequired` / `OracleObservationPredatesResume`) → permanent DoS on consult / harvest / accumulate / SwapFeeRouter conversions.

Same shape applies to the staleness guard `if (block.timestamp - latest.timestamp > TWAP_MAX_STALENESS)` at `POLAccumulator.sol:821,862` — uint32 implicit-upcast wraps in 2106 and the subtraction balloons.

`TegridyLending.sol:1607` got a directional fix (`if (latest.timestamp > block.timestamp) revert OracleStale();`). POLAccumulator did not — same surface, less hardened. Already covered via the entry-gate `checkSequencerUp` 4h staleness on POL today, but the pattern asymmetry persists.

Severity: **INFO** (year-2106 long tail). Fix: widen `Observation.timestamp` to `uint64` or apply uint32 modular subtraction throughout, mirroring `TegridyTWAP.canUpdate` line 561-573.

---

## F-74-9 — `MemeBountyBoard._sequencerBuffer` uses default 24h staleness, contradicting lib doc-comment for "short-deadline bounty refunds"

`contracts/src/lib/SequencerCheck.sol:241-245` — explicit comment: *"consumers that need a tighter staleness window (e.g. short-deadline bounty refunds) should use the 3-argument overload below"*.

`contracts/src/MemeBountyBoard.sol:333-335` uses the 2-argument overload → falls through to `MAX_FEED_STALENESS = 24 hours`.

`_sequencerBuffer` gates `refundStaleBounty` (line 725) and `emergencyForceCancel` (line 773). Both are time-window-sensitive: a 24h-stale "down" answer would extend the cancel deadline by 1h even if the sequencer was actually up the whole time. Inverse fail mode: 24h-stale "up" answer prevents the buffer from extending the cancel window when the sequencer is actually down. Both shapes harm honest participants relative to a 4h gate.

Severity: **LOW** (window of exposure is 4h-24h staleness). Fix: switch to the 3-arg overload with 4h staleness.

---

## F-74-10 — TegridyNFTLending `claimDefault` is `whenNotPaused` while `repayLoan` is not; pause-asymmetry compounds with sequencer grace

`contracts/src/TegridyNFTLending.sol:625-655` — `repayLoan` has neither `whenNotPaused` nor a sequencer-revert gate (only the buffer extension).
`contracts/src/TegridyNFTLending.sol:729-744` — `claimDefault` has BOTH `whenNotPaused` and `SequencerCheck.checkSequencerUp(... 4 hours)`.

This symmetry was intentional in the parent `TegridyLending` (BATCH-J3 H10 documented capping the pause window), and `TegridyLending.claimDefaultedCollateral` line 1202-1207 carries the `MAX_PAUSE_BLOCK_LIQUIDATION = 7 days` logic explicitly. **TegridyNFTLending does not carry the same capped-pause check** — if the owner pauses, `claimDefault` is blocked indefinitely (modulo its own `whenNotPaused`). Combined with a sequencer outage, this stacks two block conditions on the lender while leaving the borrower's repay path open. Borrower can repay forever post-pause; lender can never claim.

Strictly outside the SequencerCheck lens, but it directly composes with sequencer grace: a 6-day outage + 1h grace + indefinite admin pause is a perfect storm where the lender is locked out symmetrically with the sequencer-buffer extension AND the unbounded pause, while the borrower has full access through both.

Severity: **MEDIUM** (asymmetric pause × sequencer grace). Fix: add a `MAX_PAUSE_BLOCK_LIQUIDATION` cap to `TegridyNFTLending.claimDefault`, mirroring `TegridyLending.claimDefaultedCollateral:1202-1207`.

---

## F-74-11 — TegridyTWAP `update()` is permitted during outage; observations seeded by attacker-controlled keepers are admitted into the buffer

`contracts/src/TegridyTWAP.sol:266` — `update(pair)` has no sequencer gate (by design, per docstring at lines 175-177). The intent is to let the buffer refresh during an outage.

But: an attacker who controls a keeper key (or runs their own keeper; `update()` is permissionless modulo `updateFee`) can submit observations DURING an outage that integrate against frozen, manipulated reserves. Those observations enter the buffer and become candidates for the post-resume `consult` window.

Defense: `consult` line 794-797 rejects any `best.timestamp < resumeAt + GRACE`. So a post-resume `consult` SKIPS attacker-seeded observations whose timestamp pre-dates `resumeAt + GRACE`. **This is correct.**

But `latest.timestamp` is read from the most-recent observation. If the latest legitimate observation pre-dates the outage, and the attacker seeds the next-latest observation during the outage, the buffer's "latest" pointer now points to the attacker observation — and `consult` will revert (because `latest.timestamp < resumeAt + GRACE`). DoS, not theft. But the buffer is stuck with the attacker observation as `latest`, blocking honest reads until enough honest updates push the attacker slot out of the buffer rotation.

Severity: **LOW** (DoS during recovery). Fix: refuse `update()` calls when `getSequencerOutageBuffer` returns non-zero, OR mark such observations with a "during-outage" bit and skip them in `_getCumulativePricesOverPeriod`'s `latest`/`best` selection.

---

## F-74-12 — `getSequencerOutageBuffer` returns the constant `buffer` regardless of outage length; week-long outage gets only 1h grace

`contracts/src/lib/SequencerCheck.sol:267-300` — the helper returns `buffer` whenever any failure mode is active, then 0 once steady-state. It does not scale with outage duration.

Consumers that use the buffer for deadline extension (`TegridyLending.repayLoan:1032-1038`, `TegridyLending.claimDefaultedCollateral:1241-1247`, `TegridyNFTLending.repayLoan:649-655`, `TegridyNFTLending.claimDefault:758-764`, `MemeBountyBoard._sequencerBuffer`) get a flat 1h extension regardless of whether the outage was 5 minutes or 5 days.

Real-world: Arbitrum has had multi-hour and (Aug 2024) ~78-min outages. A 78-min outage during a borrower's last hour of repay window would, with the current 1h buffer, leave only 12 honest minutes of repay opportunity — better than nothing but not symmetric with the actual lost time.

Severity: **MEDIUM** (incentive miscalibration). Fix: track `lastOutageStart` and return `block.timestamp - lastOutageStart + buffer` (clamped to a max), or simply `outageDuration` itself. Aave V3 took the same simple-flat path; this is a documented design choice rather than a strict bug, but it deserves explicit acknowledgement in audit.

---

## Notes / dead-ends

- **Negative answer / answer > 1**: `contracts/src/lib/SequencerCheck.sol:154` strict `if (answer != 0)` catches all non-zero values including signed-bit traps. Verified clean.
- **`startedAt > block.timestamp` clock skew**: handled at `contracts/src/lib/SequencerCheck.sol:144,162,213,220,288,295,341,361`. All four helpers (`checkSequencerUp`, `tryCheckSequencerUp`, `getSequencerOutageBuffer`, `getResumeTimestamp`) treat future-dated as fail-closed. Verified clean.
- **`answeredInRound < roundId` stale round**: handled at lines 134, 207, 282, 334. Verified clean.
- **MAX_FEED_STALENESS = 24 hours**: matches Aave V3 stable-asset default. Reasonable lib default; per-call tightening is the correct primitive.
- **GRACE_PERIOD = 1 hours**: consistent across all 7 consumer constants. Matches Aave V3. Reasonable.
- **Asymmetry borrower-repay vs lender-liquidate**: verified that `TegridyLending` and `TegridyNFTLending` repay paths use buffer-extension (non-blocking) and claim paths use both `checkSequencerUp` (blocking) AND buffer-extension. Symmetric on the deadline; intentionally asymmetric on the gate (lender blocked during grace, borrower not). Correct behaviour per the BATCH-J3/L3 audit fix history.
- **Multiple sequencer feeds (Aave-style multi-feed)**: not used in this protocol — a single per-deploy `sequencerFeed` is propagated to every consumer. No multi-feed disagreement surface.
- **Test coverage**: `contracts/test/R062_SequencerCheck.t.sol`'s `MockSequencerFeed` only varies `answer` and `startedAt`, hard-coding `roundId=1`, `answeredInRound=1`, `updatedAt=block.timestamp`. The `updatedAt == 0`, `answeredInRound < roundId`, future-dated `updatedAt`, and stale `updatedAt > MAX_FEED_STALENESS` branches are NOT tested. Lib branches exist; tests do not. Documented; not security-critical because the behaviours are exercised via the call-site flows.

---

## Summary

12 findings ranked by severity:
- **HIGH (2)**: F-74-1 (no deploy script wires `setSequencerFeed` on SwapFeeRouter / NFTLending → silent disable on every L2 deploy), F-74-2 (every deploy script defaults `SEQUENCER_FEED` env to `address(0)` without chain-id sanity guard).
- **MEDIUM (4)**: F-74-3 (Drop dutch auction timeline consumed by outage with no buffer), F-74-4 (4 call sites use 24h staleness on price-sensitive paths despite lib comment recommending 4h), F-74-10 (NFTLending lacks pause-cap, compounds with sequencer grace), F-74-12 (1h flat buffer regardless of outage length).
- **LOW (3)**: F-74-5 (TegridyLending.acceptOffer lacks top-level sequencer gate), F-74-6 (revert variant lumps `updatedAt==0` with grace-not-over while try variant has distinct reason), F-74-9 (MemeBountyBoard 24h staleness against lib doc-comment), F-74-11 (TWAP update during outage admits attacker observations).
- **INFO (2)**: F-74-7 (`getResumeTimestamp` returns 0 on `startedAt==0` silently bypasses gates for any future consumer that doesn't pre-gate), F-74-8 (year-2106 uint32 wrap permanent DoS).

Top fixes by ROI:
1. F-74-1 + F-74-2 together: add to every L2 deploy script `require(block.chainid == 1 || SEQUENCER_FEED != address(0))` and explicit `swapRouter.setSequencerFeed(SEQUENCER_FEED)` + `nftLending.setSequencerFeed(SEQUENCER_FEED)` calls.
2. F-74-4: switch the four call sites in TWAP / Drop / SwapFeeRouter to the 3-arg overload with `4 hours`.
3. F-74-3: extend `dutchDuration` by `getSequencerOutageBuffer(...)` at quote time so the auction timeline is preserved across outages.
