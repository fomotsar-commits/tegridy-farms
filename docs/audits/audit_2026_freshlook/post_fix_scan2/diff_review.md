# Diff Review under the Minimal-Surface Mandate

**Baseline:** `88b29c8` (pre-audit) → **HEAD:** `95ddbd7`
**Scope:** `contracts/src/` only. Tests, runbooks, docs, deploy scripts excluded.
**Mandate:** `memory/feedback_minimal_surface.md` — DELETE > REPLACE-WITH-CANONICAL > MINIMAL-TWEAK >> NEW-MACHINERY.

## Commits in scope (src-touching only)

| Commit | Title | Net src LoC | Posture |
|---|---|---|---|
| `8d8bac4` | Wave A — CRITICAL + 12 structural HIGHs | bulk | mostly canonical / sibling-port |
| `c490a84` | Wave B redo (REVERTED) | 0 net | reverted by `e441133` |
| `d04af18` | Wave B partial (REVERTED) | 0 net | reverted by `e441133` |
| `e441133` | Wave-B revert | -3500 | DELETE — perfectly mandate-strict |
| `6865982` | minimal MEDs | +14 | 4 conservative tweaks |
| `e2bcc3c` | H-9 deploy gate | (deploy-only) | not in scope |
| `e0ded36` | post-fix scan — 4 minimal tweaks | +15 | conservative tweaks |
| `95ddbd7` | H-18 revert (accept-as-design) | -8 | DELETE — perfectly mandate-strict |

The volume of the diff (~+3092 LoC over baseline) is driven almost entirely by `8d8bac4` (Wave A — CRITICAL + 12 HIGHs). Per the mandate's accepted-as-design list (POST_MANDATE_STATE.md), Wave A is the load-bearing fix surface; the question this review answers is whether each Wave-A delta lands on the mandate-allowed shapes and whether anything in the post-Wave-A commits regressed.

---

## Per-file classifications

### `base/OwnableNoRenounce.sol` (+97 LoC, ~10 net)

| Block | Classification | Notes |
|---|---|---|
| F-40-ONR-1: `OWNERSHIP_TRANSFER_EXPIRY = 14 days` constant | NEW-MACHINERY | Adds wall-clock expiry on top of OZ Ownable2Step. |
| F-40-ONR-1: `ownershipTransferExpiresAt` storage slot | NEW-MACHINERY | New state. |
| F-40-ONR-1: `OwnershipTransferExpired` / `NoPendingOwnershipTransfer` errors | NEW-MACHINERY (event surface) | New revert types. |
| F-40-ONR-1: `OwnershipTransferCancelled` event | NEW-MACHINERY | New event surface. |
| F-40-ONR-1: `transferOwnership` override stamping expiry | NEW-MACHINERY | Diverges from OZ verbatim. |
| F-40-ONR-1: `acceptOwnership` override checking expiry | NEW-MACHINERY | Diverges from OZ verbatim. |
| F-40-ONR-1: `cancelOwnershipTransfer(string reason)` | NEW-MACHINERY | New admin function. OZ Ownable2Step has no native cancel; the canonical recovery is `transferOwnership(newAddr)` which deletes pending. |

**Mandate verdict:** Direct violation of "Ownable2Step verbatim — `transferOwnership` + `acceptOwnership`" (memory line 94). The mandate explicitly lists "Custom rotation flow with code.length checks" as a temptation to be replaced with bare OZ `Ownable2Step`. This block introduces:
- new storage,
- new admin function (`cancelOwnershipTransfer`),
- new event surface,
- override of OZ's canonical functions.

**Mandate-strict alternative:** Revert all F-40-ONR-1 lines. The "stuck pending owner" concern is solved canonically by calling `transferOwnership(newAddr)` again — it overwrites `_pendingOwner` unconditionally per OZ source. No expiry, no cancel, no new event. Net change: -97 LoC.

---

### `base/TimelockAdmin.sol` (+53 LoC, ~16 effective)

| Block | Classification | Notes |
|---|---|---|
| F-75-9..15 negative-finding NatSpec | CONSERVATIVE-TWEAK (doc-only) | Pure documentation; zero code. |
| F-40-TLA-2 / F-40-TLA-3 NatSpec | CONSERVATIVE-TWEAK (doc-only) | Documentation. |
| F-40-TLA-1: floor `validityForEvent` to MIN_DELAY in event emit | CONSERVATIVE-TWEAK | 3-line floor against existing constant. View↔write parity fix. |

**Mandate verdict:** Clean. The only behavioural change is a tighter event-data floor using existing constants. No new state, no new admin path.

---

### `lib/SafeERC721Call.sol` (+58 LoC, ~30 effective)

| Block | Classification | Notes |
|---|---|---|
| F-40-S721-1: `DEFAULT_OWNER_OF_GAS_BUDGET = 50_000` constant | CONSERVATIVE-TWEAK | Constant bump (was 30k inline). Cites Aave V3 SafeERC20 cushion. |
| F-40-S721-1: 3-arg overload `safeOwnerOfBounded(coll, id, gasBudget)` | CONSERVATIVE-TWEAK | Adds an explicit overload to keep the 2-arg path stable; both flow into shared assembly. |

**Mandate verdict:** Acceptable. The default value bump (30k → 50k) is the load-bearing change. The overload is structurally optional but documented as the per-collection override path and consumers don't have to use it. **Borderline — could have been a 1-line constant change without the overload.**

**Mandate-strict alternative:** Drop the overload, keep the constant bump. Net change: -30 LoC.

---

### `lib/SequencerCheck.sol` (+83 LoC, ~30 effective)

| Block | Classification | Notes |
|---|---|---|
| H-9: revert `SequencerFeedNotConfigured()` when `feed == address(0)` on non-mainnet | SIBLING-PORT (Aave V3 PriceOracleSentinel) | Mandate explicitly cites this as the canonical L2-sequencer pattern. |
| M-34 / F-40-SEQ-2: return `type(uint256).max` instead of `0` on stale paths | CONSERVATIVE-TWEAK | Fail-closed sentinel; 4 lines of `return 0` → `return type(uint256).max`. |

**Mandate verdict:** Clean. Both changes are safety-rail tweaks against the existing canonical Chainlink reading pattern.

---

### `lib/VotePowerOracle.sol` (+140 LoC, ~80 effective)

| Block | Classification | Notes |
|---|---|---|
| H-10: rename `powerOf` → `powerOfLiveUnsafe` with deprecated alias | NEW-MACHINERY (interface surface) | New named function; deprecated alias preserved. |
| H-10: `powerAtNow(user, staking, restaking)` snapshot helper | NEW-MACHINERY | Adds a new entry point. Wraps existing `powerAt(user, block.timestamp - 1, ...)`. |
| M-35: `RestakingPowerLookupFailed` event | NEW-MACHINERY | New event surface. |
| M-35: `powerOfWithEvent` / `powerAtWithEvent` non-view sister functions | NEW-MACHINERY | Adds two new functions that emit the event. |

**Mandate verdict:** Borderline. The semantic intent (close flash-stake amplification by snapshot read) IS the canonical Compound `getPriorVotes(t-1)` pattern, but the implementation adds **four new functions and one new event** to a library described in its own NatSpec as a "thin no-state lib." The H-10 fix could have been:

**Mandate-strict alternative for H-10:** Just modify consumers to call `powerAt(user, block.timestamp - 1, ...)` — a 1-3 line change at each call site (CommunityGrants, MemeBountyBoard, GaugeController, VoteIncentives). The library already exposes `powerAt`; no new lib code is needed.

**Mandate-strict alternative for M-35:** ACCEPT-AS-DESIGN. The `try/catch { }` silent-fail pattern is the canonical Solady / OZ optional-call shape; adding an event surface to the library, with non-view sister functions (which forces consumers to either use both shapes or live with view↔write divergence), is exactly the "harden by adding" anti-pattern. Off-chain monitors can derive "restaking is broken" from the absence of restaker payouts; the dedicated event has marginal value.

Reverting H-10 + M-35 lib-side: net -140 LoC.

---

### `lib/WETHFallbackLib.sol` (+149 LoC, ~80 effective)

| Block | Classification | Notes |
|---|---|---|
| M-36 / F-40-WFL-1: `ETH_TRANSFER_GAS_STIPEND = 30_000` constant + apply to all 3 transfer fns | CONSERVATIVE-TWEAK | Stipend bump (10k → 30k) using the canonical Aerodrome / Bunni distributor floor. |
| H-12: split mode==2 into mode==2 (stranded WETH in caller) and mode==3 (total fail) | NEW-MACHINERY (return-mode surface) | Adds a return enum value. The mandate explicitly cites "Custom multi-mode return enums for transfers" as a thing to AVOID and replace with single bool + revert. |
| H-12: `WETHTransferStuck` / `ETHWrapFailed` events | NEW-MACHINERY | New event surface. |

**Mandate verdict:** M-36 is clean. **H-12 is a direct hit on the mandate's "Concrete substitutions to default to" table:**

> | Custom multi-mode return enums for transfers | Single bool with revert; consumers don't branch on mode |

The pre-fix lib already had a 3-mode enum (0=ETH, 1=WETH, 2=fail); H-12 expanded it to 4 modes with 2 new events to disambiguate. The canonical pattern (`Address.sendValue` revert-on-fail, used everywhere by OZ) is the listed mandate-strict shape.

**Mandate-strict alternative for H-12:** Either (a) revert to a 3-mode enum (mandate already accepted that as a mild divergence pre-fix) and let consumers infer the post-state from `IWETH(weth).balanceOf(address(this))`, or (b) replace the entire `safeTransferETHOrWrapNoRevert` with `safeTransferETHOrWrap` (revert-on-fail) — the mandate's preferred shape. Net: -50..-150 LoC depending on path.

---

### `CommunityGrants.sol` (+5 LoC, +5 effective)

| Block | Classification | Notes |
|---|---|---|
| M-15 / F-15-K-01: add `whenNotPaused` to `executeCancelApproved` | SIBLING-PORT | Mirror of BATCH-E H12 fix on `lapseProposal` in the same file. |

**Mandate verdict:** Textbook sibling-port. One modifier, no new state. This is the gold-standard mandate-compliant fix.

---

### `MemeBountyBoard.sol` (+7 LoC, +5 effective)

| Block | Classification | Notes |
|---|---|---|
| M-42 / F-80-03: swap raw `.call{gas:50000}` for `WETHFallbackLib.safeTransferETHOrWrap` | REPLACE-WITH-CANONICAL | Uses the existing canonical lib function. |

**Mandate verdict:** Clean substitution. Matches the file's own `withdrawPayout` pattern.

---

### `PremiumAccess.sol` (+10 LoC, +6 effective)

| Block | Classification | Notes |
|---|---|---|
| M-19 / F-27-K-01: mirror `hasPremium`'s MIN_ACTIVATION_DELAY gate inside `getSubscription` view | SIBLING-PORT | Direct port of sister function's gate. No new state. |

**Mandate verdict:** Textbook sibling-port. Closes the view↔write divergence the mandate's substitution table calls out explicitly.

---

### `TegridyFeeHook.sol` (+31 LoC, ~10 effective)

| Block | Classification | Notes |
|---|---|---|
| M-40 / F-55-4: swap raw `.call` for `WETHFallbackLib.safeTransferETHOrWrap` in `sweepETH` | REPLACE-WITH-CANONICAL | Uses existing lib. |
| F-76-A: remove `pure` from 9 IHooks no-op stubs | CANONICAL (Uniswap V4 IHooks.sol verbatim) | DELETE 9 keywords, aligns with canonical `external` declaration. |

**Mandate verdict:** Both clean. F-76-A is a pure DELETE-to-align-with-canonical, the highest mandate value.

---

### `TegridyLaunchpadV2.sol` (+10 LoC, NatSpec only)

| Block | Classification | Notes |
|---|---|---|
| H-18 revert NatSpec note (sister mirror to Sudoswap V2 LSSVMPair posture) | CONSERVATIVE-TWEAK (doc-only) | Pure NatSpec. |

**Mandate verdict:** Clean. The `95ddbd7` revert correctly reverted the H-18 ADD, leaving only documentation.

---

### `TegridyNFTPool.sol` (+6 LoC, +1 effective)

| Block | Classification | Notes |
|---|---|---|
| F-62-1: mirror `proposeSpotPrice` cap at `initialize` | SIBLING-PORT | One-line require against existing `MAX_SPOT_PRICE` constant. |

**Mandate verdict:** Textbook sibling-port.

---

### `TegridyPair.sol` (+61 LoC, ~40 effective)

| Block | Classification | Notes |
|---|---|---|
| F-31-A / H-7: gate `kLast` refresh in `mint`/`burn` to "feeOn && kLast != 0 && !disabled" — bootstrap exclusively via `harvest` | CONSERVATIVE-TWEAK | Two `if` clauses against existing state. Closes the bootstrap-anchor gap. |
| F-31-B / M-23: skip `kLast` refresh when pair is disabled | CONSERVATIVE-TWEAK | Same line — combined with above. |
| F-31-D: split `to != token0 && to != token1` into directional checks | CONSERVATIVE-TWEAK | 2-line refinement against existing canonical Uniswap V2 `swap()`. |
| F-31-E: typed error `ReservesZeroPostRebase` on rebase-driven mint | CONSERVATIVE-TWEAK | Replaces silent `Panic(0x12)` with typed revert. |
| F-31-F: `ProtocolFeeHarvested` event on harvest | NEW-MACHINERY (event surface, marginal) | New event for off-chain monitoring distinguishing harvest path from incidental mint/burn `_mintFee`. |

**Mandate verdict:** F-31-A/B/D/E are clean conservative tweaks that delta minimally against canonical Uniswap V2. **F-31-F (new event) is borderline NEW-MACHINERY** — canonical Uniswap V2 has no such event; off-chain monitors can already detect harvest by tracking `_mintFee` LP-token-mint-to-feeTo. Marginal value.

**Mandate-strict alternative for F-31-F:** Revert. Net -8 LoC.

---

### `TegridyFactory.sol` (+170 LoC, ~110 effective)

| Block | Classification | Notes |
|---|---|---|
| H-16 / F-94-02: `MAX_EMERGENCY_DISABLES_PER_DAY = 3` rate limiter (storage + counter + day-rollover logic) | NEW-MACHINERY | New `uint8 emergencyDisablesToday`, `uint64 lastDisableDay` packed slot. New error. New rate-limit branch. Cites "Compound pause-guardian discipline pattern" but the implementation is custom. |
| H-16: require multisig-class guardian (`code.length > 0 && != 23`) | CONSERVATIVE-TWEAK | 2-line check using existing pattern. |
| F-30-1 / M-21: `if (!isPair[pair]) revert NotAPair()` on propose/emergency disable | CONSERVATIVE-TWEAK | One-line membership gate against existing mapping. |
| F-30-2 / M-22: extend `cancelFeeToChange` to guardian, change `FEE_TO_SETTER_DELAY` 48h → 24h | CONSERVATIVE-TWEAK | Constant change + auth expansion (1 line each). |
| F-30-9 / F-30-10: constructor `_guardian` parameter, force-cancel pending guardian-change on setter rotation | CONSERVATIVE-TWEAK / NEW-MACHINERY (cleanup hook) | Constructor change clean. Force-cancel hook adds 6 LoC of cleanup logic; mirrors existing FEE_TO_CHANGE force-cancel which sets the precedent. |
| F-30-5: `pendingTokenBlocks(token)` view helper | CONSERVATIVE-TWEAK (read-only) | Pure view onto existing storage. No new state. |

**Mandate verdict:** **H-16's per-day rate limiter is NEW-MACHINERY** — it adds packed storage (`emergencyDisablesToday`, `lastDisableDay`) + a counter-rollover branch with explicit day-bucket math. The mandate-cited Compound pause-guardian pattern uses **multisig governance** as the rate-limit, NOT on-chain counters. Other entries are clean.

**Mandate-strict alternative for H-16:** Require guardian to be a multisig (already in the diff!) and treat that as the rate limit (multisig threshold = social rate limit). Drop the per-day on-chain counter. Net: -40 LoC. Combined with already-present multisig requirement, the captured-key blast-radius story still works because the captured key is one signer of N.

---

### `GaugeController.sol` (+359 LoC, ~150 effective)

| Block | Classification | Notes |
|---|---|---|
| H-5 / F-17-1: O(n²) dedup in `vote()` | CONSERVATIVE-TWEAK | n ≤ 8 bounded. 4 lines. |
| H-6 / F-17-2: mirror per-gauge cap + dedup in `revealVote()` | SIBLING-PORT | Direct mirror of `vote()` semantics. |
| F-17-4: REMOVE `topWeightByEpoch` / `topGaugeByEpoch` / `_updateEpochTop` | DELETE | Pure DELETE — write-only dead state from V3 rewrite. Highest mandate value. |
| F-65-2: timelocked restaking-rotation ceremony — `RESTAKING_CHANGE` key, `pendingRestakingContract`, propose/execute/cancel + 3 events + 4 errors | NEW-MACHINERY | Replaces one-shot setter with full rotation flow. |
| F-69-2: `MIN_TOTAL_VOTE_WEIGHT_BPS = 500`, `MIN_VOTING_NFTS_PER_EPOCH = 3`, `distinctVotersPerEpoch` mapping, `quorumMet()` view | NEW-MACHINERY | New constant, new mapping, new view. New increment in `vote()` / `revealVote()`. |
| F-60-2: 7702-EOA filter (`code.length == 23`) on `proposeAddGauge` gauge + pair | CONSERVATIVE-TWEAK | Mirrors OwnableNoRenounce / TegridyFactory pattern. |

**Mandate verdict:** F-17-1, F-17-2, F-17-4, F-60-2 are all clean (sibling-port + DELETE). **F-65-2 and F-69-2 are NEW-MACHINERY.**

For F-65-2: the canonical pattern for "restakingContract is a one-shot pointer" is exactly that — one-shot. Mandate's pattern library cites Aerodrome `Voter` for gauge-controller logic; Aerodrome wires its restaking analog at construction and never rotates it. The mandate's `Concrete substitutions` table also lists "Custom rotation flow with code.length checks" as a thing to replace with `Ownable2Step`. The 48h timelock + propose/execute/cancel ceremony here is the mandate's archetypal anti-pattern.

For F-69-2: quorum is a real concern, but the canonical solution (cited in the diff itself) is `CommunityGrants.MIN_UNIQUE_VOTERS = 3` — which is the same numeric threshold but expressed inline with no separate `distinctVotersPerEpoch` mapping. Curve `GaugeController` itself has no quorum gate; emission distribution proceeds naturally on whatever votes were cast. The mandate-strict shape is to replicate Curve's posture exactly: ACCEPT-AS-DESIGN with operator-side monitoring, OR collapse to a one-line check using the existing `totalWeightByEpoch` slot (already present in storage) without adding a new mapping.

**Mandate-strict alternative for F-65-2:** Revert. The TegridyStakingAdmin sister already has the timelocked rotation; GaugeController.restakingContract can stay one-shot. Net: -100 LoC.

**Mandate-strict alternative for F-69-2:** ACCEPT-AS-DESIGN, mirroring Curve `GaugeController` posture. Net: -50 LoC.

---

### `RevenueDistributor.sol` (+346 LoC, ~210 effective)

| Block | Classification | Notes |
|---|---|---|
| H-11 / F-55-1: pre-warm `_totalETHReceivedRaw = 1` in constructor | CONSERVATIVE-TWEAK | Storage-pre-warm pattern (Solady-style). 1 SSTORE in constructor. |
| H-11: rename `totalETHReceived` slot → `_totalETHReceivedRaw` private + new public `totalETHReceived()` view subtracting 1 | CONSERVATIVE-TWEAK | View shim around the pre-warm offset. |
| M-14 / F-13-2: mirror `_isStakingPaused()` gate on `distribute()` / `distributePermissionless()` | SIBLING-PORT | Direct mirror of `claim()` / `claimUpTo()` / `executeClaimRecovery()` gate. |
| F-12-K-4: typed `StakingTotalBoostedStakeFailed` + try/catch on live fallback | CONSERVATIVE-TWEAK | Wraps existing call in try/catch. |
| M-38 / F-55-2: replace 3× raw `.call{value:}` with `WETHFallbackLib.safeTransferETHOrWrap` (emergencyWithdraw / emergencyWithdrawExcess / sweepDust) | REPLACE-WITH-CANONICAL | Uses existing lib. |
| F-50-8: gas cap (50_000) on `restakingContract.boostedAmountAt` call | CONSERVATIVE-TWEAK | Single `{gas: 50_000}` clause. |
| F-13-3: `MAX_RECLAIM_PAGE_SIZE = 250`, `reclaimEligibleAmountPaginated`, `_reclaimEligibleInRange` extraction | NEW-MACHINERY (paginated form) | New external view + 3 new errors + new internal helper. |
| M-12 / F-12-K-1: `_consumeEligibleAndBumpClaimed` + apply in `executeForfeitReclaim` | NEW-MACHINERY | New 30-line internal function with mirrored eligibility filter. Critical correctness fix. |
| M-13 / F-12-K-2 / F-13-1: ADDITIVE math in `pendingETHFor` (mirror `_calculateClaim`) | SIBLING-PORT | View↔write divergence fix mirroring sister `_calculateClaim`. |
| F-12-K-3: `protocolDustPool` mapping + reroute `autoReconcileDust` from `epochs[length-1].totalETH +=` to protocol pool + decrement `totalEarmarked` + bump `totalForfeited` | NEW-MACHINERY | New storage slot, new event `DustRoutedToProtocolPool`, new accounting branch. |
| F-13-4: `TokenSweepWETHDenied` + WETH deny in proposeTokenSweep + executeTokenSweep | CONSERVATIVE-TWEAK | One-line guard against existing state. |

**Mandate verdict:** H-11, M-14, M-38, F-50-8, F-13-4 are clean. **M-12 / F-12-K-1 is NEW-MACHINERY but unavoidable** — the F-12-K-1 finding is a real consistency hole between the view-side eligibility filter and the write-side `epochClaimed` bump; closing it requires the new `_consumeEligibleAndBumpClaimed` helper. The mandate-strict shape would be to extract a single internal that BOTH the view and the writer call, which is what this fix does.

**F-13-3 paginated form is borderline NEW-MACHINERY** — canonical Compound v3 / Aave V3 don't paginate this kind of off-chain-only view; they let `eth_call` gas budgets blow up at 5y if it ever happens. **Mandate-strict alternative:** Revert F-13-3 (legacy whole-history view stays for off-chain callers; a 5-year-out gas blowup is ACCEPT-AS-DESIGN). Net: -50 LoC.

**F-12-K-3 `protocolDustPool` is NEW-MACHINERY.** The fairness concern is real, but the canonical Curve pattern for "dust accumulates somewhere" is to leave it in the source epoch (claimers eventually drain), or sweep to treasury. The new storage slot + new event surface is more than the minimum intervention. **Mandate-strict alternative:** Either (a) directly bump `totalForfeited` (existing slot) and skip the `protocolDustPool` mirror, or (b) ACCEPT-AS-DESIGN the existing `epochs[destEpoch].totalETH +=` shape and document the timing-fairness asymmetry in NatSpec. Net: -40 LoC.

---

### `TegridyLPFarming.sol` (+182 LoC, ~110 effective)

| Block | Classification | Notes |
|---|---|---|
| C-1 / F-28-1: reorder `updateReward` modifier — anchor rewards FIRST, refresh boost cache SECOND | CANONICAL (Synthetix StakingRewards verbatim) | Critical fix. Restores canonical Synthetix anchor pattern, exactly as listed in mandate's pattern library. |
| F-28-2: drop `updateReward(msg.sender)` modifier from `emergencyWithdraw`, inline minimal state sync | SIBLING-PORT (MasterChef pattern) | Mandate cites MasterChef-class `emergencyWithdraw` makes ZERO external calls. |
| F-61-6: `MIN_STAKE = 100e18` floor mirroring TegridyStaking | SIBLING-PORT | Direct mirror of sister contract's MIN_STAKE. |
| F-93-2: `NOTIFY_COOLDOWN = 1 hours` + `lastNotifyTime` tracking | NEW-MACHINERY | New constant + new storage slot + new gate. The "private mempool relay" is a higher-tier defense; this on-chain cooldown is custom. |
| F-61-1: residue capture from `rewardRate = N / duration` integer-division into existing `forfeitedRewards` | CONSERVATIVE-TWEAK | Reuses existing slot. No new state. |
| F-28-3 / F-28-4 NatSpec | CONSERVATIVE-TWEAK (doc-only) | Documentation. |

**Mandate verdict:** C-1 is the gold-standard CANONICAL fix (cited explicitly in the mandate's pattern library). F-28-2, F-61-6, F-61-1 are clean.

**F-93-2 is NEW-MACHINERY** — canonical Synthetix `StakingRewards.notifyRewardAmount` has no cooldown. The mandate-cited MasterChef V2 has no cooldown. The diff itself acknowledges the fix is suboptimal and recommends private-mempool relay as the actual cure.

**Mandate-strict alternative for F-93-2:** Revert. Operational mitigation (private mempool / Flashbots Protect) is the canonical defense; the on-chain cooldown is the "harden by adding" anti-pattern. Net: -10 LoC.

---

### `TegridyLending.sol` (+289 LoC, ~190 effective)

| Block | Classification | Notes |
|---|---|---|
| F-60-2: 7702-EOA filter (`code.length == 23`) | CONSERVATIVE-TWEAK | Mirror of OwnableNoRenounce / TegridyFactory pattern. |
| H-15: `proposeLendingAdminReplacement` / `executeLendingAdminReplacement` / `cancelLendingAdminReplacement` (48h + 7d expiry) | SIBLING-PORT (TegridyStaking pattern) | Direct backport of TegridyStaking's existing rotation flow. Mandate explicitly classifies this kind of sibling-port as canonical-shape. |
| M-25 / F-33-1: `MAX_PRINCIPAL_FLOOR = 0.01 ether` + check at apply | SIBLING-PORT | Mirror of `MIN_DURATION_FLOOR` pattern in same file. |
| M-8 / F-07-01: `protocolFeeBpsAtCreate` widened from `uint16` to `int16`, negative as "unset" sentinel | CONSERVATIVE-TWEAK | Storage-layout-compatible reinterpretation. |
| F-95-K-2: `MAX_TOTAL_OFFERS = 10000`, `MAX_OFFERS_PER_LENDER = 100`, `activeOffersByLender` mapping | NEW-MACHINERY | New constants + new mapping + 4 new errors + increment/decrement at 3 sites. |
| F-08-K-01: `ParamOutOfBounds` typed error for `calculateInterest` | CONSERVATIVE-TWEAK | Single error decl. |
| F-95-K-7: `sweepUnsolicitedNFT(collection, tokenId, to)` admin function with bounded loans-scan | NEW-MACHINERY | New 30-line owner function, scans loans[] up to MAX_TOTAL_OFFERS. |
| F-33-4 / F-33-5: `resetCollateralRemovalRetryCount` + cancel-of-ADD reset | CONSERVATIVE-TWEAK | One-line reset call against existing state. |
| F-09-L1 NatSpec | CONSERVATIVE-TWEAK (doc-only) | Documentation. |

**Mandate verdict:** H-15, M-25, M-8, F-08-K-01 are clean. F-60-2 is clean.

**F-95-K-2 (offer caps) is NEW-MACHINERY.** Gondi's `MultiSourceLoan` (mandate's canonical reference for this contract) has no global offer cap and no per-lender offer cap — Gondi accepts the griefing surface as ACCEPT-AS-DESIGN because lender-spam economics are self-limiting (lenders pay gas to mint dust offers, and the same lender is rate-limited by their own ETH budget per offer). The 1-ETH attack budget cited in the diff comment hand-waves the economics.

**Mandate-strict alternative for F-95-K-2:** ACCEPT-AS-DESIGN per Gondi posture. The mandate explicitly cites Gondi as the canonical reference for `TegridyLending`. Net: -50 LoC.

**F-95-K-7 (sweepUnsolicitedNFT) is NEW-MACHINERY.** Gondi's `MultiSourceLoan` has no analogous admin sweep — unsolicited NFTs sit forever (cheap griefing for the attacker, no value lost). Adding an admin function that scans loans[] is exactly the kind of new admin surface the mandate cautions against.

**Mandate-strict alternative for F-95-K-7:** ACCEPT-AS-DESIGN per Gondi posture. Net: -60 LoC.

---

### `TegridyLendingAdmin.sol` (+73 LoC, ~30 effective)

| Block | Classification | Notes |
|---|---|---|
| M-25 / F-33-1: propose-time `MAX_PRINCIPAL_FLOOR` check | SIBLING-PORT | Mirror of MIN_DURATION_FLOOR. |
| M-26 / F-33-2: pin `_to == lending.treasury()` at propose-time on `proposeSweepDonatedToweli` | CONSERVATIVE-TWEAK | One-line propose-time check restoring chained 96h timelock. |
| F-33-4: cancel-of-ADD calls `lending.resetCollateralRemovalRetryCount(cancelled)` | CONSERVATIVE-TWEAK | Sibling-call against existing reset. |
| M-27 / F-33-3: `acceptedCollateralRemovalPending` view auto-clears on expiry | CONSERVATIVE-TWEAK | 3-line view-side change against existing `_proposalValidity()`. |

**Mandate verdict:** All clean. Sibling ports + view↔write parity tweaks. Textbook mandate-compliant.

---

### `TegridyNFTLending.sol` (+454 LoC, ~280 effective)

| Block | Classification | Notes |
|---|---|---|
| H-8 / F-71-1 / F-78-C / F-74-10: `MAX_PAUSE_BLOCK_LIQUIDATION = 7 days` cap on `claimDefault` (REMOVE `whenNotPaused`, add cumulative-pause cap) | SIBLING-PORT | Direct mirror of TegridyLending H-8 fix. |
| F-71-9: `CUMULATIVE_PAUSE_WINDOW = 30 days`, `PauseEpisode[] pauseHistory`, `_cumulativePausedInWindow()` | NEW-MACHINERY | New struct array + new function. Closes cycle-pause bypass. |
| F-71-2: `_graceWithPauseExtension(loanId)` summing pause-window overlaps with grace interval | NEW-MACHINERY | New 25-line internal function iterating `pauseHistory`. |
| F-71-3: pass 4h staleness on `getSequencerOutageBuffer` (3-arg overload) | CONSERVATIVE-TWEAK | One-line overload swap. |
| F-72-6: split `pauseAdjustedElapsed` / `effectiveDeadline` into view-clamp + strict `_..Strict` variants | NEW-MACHINERY | View↔write divergence resolution; doubles function count for these two. |
| F-95-K-2: `MAX_TOTAL_OFFERS = 10000`, `MAX_OFFERS_PER_LENDER = 100`, `openOffersOfLender` mapping | NEW-MACHINERY | Same as TegridyLending F-95-K-2 — same mandate concern. |
| F-95-K-7: `proposeSweepUnsolicitedNFT` + `executeSweepUnsolicitedNFT` + `cancelSweepUnsolicitedNFT` + `claimStrandedNFT` (24h timelock + stranded-recipient queue) | NEW-MACHINERY | New 100-LoC ceremony. |
| F-14-1: constructor `_sequencerFeed` parameter required | CONSERVATIVE-TWEAK | Constructor sig change + mainnet escape hatch. |
| F-14-2: `CollectionNotERC721` typed error | CONSERVATIVE-TWEAK | Single error decl. |
| F-60-2: 7702-EOA filter on sequencer feed | CONSERVATIVE-TWEAK | Mirror of standard pattern. |

**Mandate verdict:** H-8 sibling-port and F-14-1 / F-71-3 / F-60-2 are clean.

**F-71-9 / F-71-2 (cumulative-pause + grace-extension) is NEW-MACHINERY.** TegridyLending uses the simpler "pause counter + cap" without per-episode history. The diff implements an O(n) loop over `pauseHistory[]` for grace extension. The mandate-strict approach mirrors the sister contract: cap on cumulative pause, no per-episode array.

**Mandate-strict alternative for F-71-9 / F-71-2:** Mirror TegridyLending's simpler approach (`totalPausedDuration` counter + cap), accept the mid-grace-pause compression as ACCEPT-AS-DESIGN. Net: -80 LoC.

**F-72-6 (view-clamp / strict-revert split) is NEW-MACHINERY.** The pre-fix code reverted on invariant violation in both view and write paths. The fix doubles the function count to silently clamp views while preserving strict-revert in writers. The mandate-strict shape is to keep the strict-revert in both — view consumers can also revert cleanly; an invariant violation IS a reason to fail loud.

**Mandate-strict alternative for F-72-6:** Revert. Keep the strict-revert pre-fix shape. Net: -40 LoC.

**F-95-K-2 / F-95-K-7:** Same mandate concern as TegridyLending — Gondi-pattern accept-as-design. Net: -150 LoC.

---

### `TegridyRestaking.sol` (+417 LoC, ~250 effective)

| Block | Classification | Notes |
|---|---|---|
| H-1 / F-03-K1 / F-87-K-01 / F-93-1: `PositionExpired` revert on restake of expired-lock position | CONSERVATIVE-TWEAK | One typed error + one revert site. Real vulnerability close. |
| H-3 / F-04-1: `unforwardedBonusRewards` mapping + `totalUnforwardedBonus` + `_sweepUnforwardedBonus` + `claimPendingBonusPayout` (route bonus credits to bonus bucket, NOT base bucket) | NEW-MACHINERY | New mapping + new bookkeeping counter + 2 new functions + new state. Critical correctness fix (was paying bonus credits in TOWELI). |
| F-04-3: `proposeClearResidualClaimant` / `executeClearResidualClaimant` / `cancelClearResidualClaimant` (7d timelock, abandoned-claimant escape) | NEW-MACHINERY | New struct, new mapping, 3 new admin functions + 3 new events. |
| M-3 / F-03-K3 / M-4 / F-04-2: `proposeRescueNFT` / `executeRescueNFT` / `cancelRescueNFT` replacing instant `rescueNFT` (48h timelock, free `_to`) | NEW-MACHINERY | New struct, new constant `RESCUE_NFT_TIMELOCK = 48 hours`, 3 new admin functions + 3 new events. Pre-fix `rescueNFT` always reverted (`_to == staking` had no IERC721Receiver). |
| F-04-4: drop `staking.unsettledRewards(address(this))` external call in `restake()`, leave `unsettledSnapshot` field at 0 forever | CONSERVATIVE-TWEAK | Removes dead state without storage-layout break. |
| F-04-5: wrap user-side bonus transfer in try/catch via existing `_safeBonusTransferExt` self-call | SIBLING-PORT | Direct mirror of `decayExpiredRestaker` pattern. |
| F-04-7 / F-84-1: `bonusRewardTokenUnit` immutable (cached `decimals()` at construction), `MAX_BONUS_REWARD_RATE_MULTIPLIER`, `maxBonusRewardRate()` view | NEW-MACHINERY | New immutable + new constant + new view. Closes constructor↔propose cap asymmetry. |
| F-04-6: relax `recoverStuckPrincipal` to also sweep stuck base when `payout == 0` | CONSERVATIVE-TWEAK | One-line condition relax. |
| F-51-1: balance-delta accounting on `fundBonus` (defend against fee-on-transfer) | CONSERVATIVE-TWEAK | Mirror of `TegridyStaking.notifyRewardAmount`. |
| F-51-5: wrap `emergencyForceReturn` bonus transfer in try/catch | SIBLING-PORT | Mirror of decayExpiredRestaker. |
| M-2 / F-03-K2: `strandedRestakeRecipient[tokenId]` write in `emergencyForceReturn` catch arm | CONSERVATIVE-TWEAK | One-line write + one-line event. Brings emergencyForceReturn into parity with sister exit paths. |

**Mandate verdict:** H-1 is a textbook CONSERVATIVE-TWEAK. F-04-4 (DELETE) is excellent. F-51-1, F-04-5, F-04-6, F-51-5, M-2 are clean.

**H-3 / F-04-1 (separate bonus bucket) is NEW-MACHINERY but unavoidable** — the pre-fix code was actively wrong (paying bonus credits in TOWELI). The mandate's "DELETE before ADD" preference would be to remove the entire `unforwardedBaseRewards` deferral path — but that breaks live bonus claims. The fix is the smallest possible correct shape.

**F-04-3 (residual-claimant clear) and M-3/M-4 (rescueNFT timelocking) are NEW-MACHINERY.** Both add admin-rotation flows on top of an already-rotation-heavy contract. Per the POST_MANDATE_STATE.md ACCEPT-AS-DESIGN list, M-2/M-3/M-4 were already documented as accepted; the addition of timelocked replacements re-introduces them as ADD changes. **Mandate-strict alternative:** Revert F-04-3 + M-3/M-4 to the existing accept-as-design posture. Net: -100 LoC.

**F-04-7 / F-84-1 (decimal-scaled cap) is NEW-MACHINERY.** The pre-fix asymmetry (constructor 10e18, propose 100e18) is real, but the canonical fix is to align the two literal constants — not introduce decimals-cached-at-construction + multiplier + view machinery. **Mandate-strict alternative:** Drop the decimals cache; just lower `MAX_BONUS_REWARD_RATE` constant to 10e18 and use it in both sites. Net: -25 LoC.

---

### `TegridyTWAP.sol` (+340 LoC, ~190 effective)

| Block | Classification | Notes |
|---|---|---|
| F-46-1: tighten `MAX_DEVIATION_BPS` 5000 → 2000 + boundary `>` → `>=` | CONSERVATIVE-TWEAK | Constant change + 2-char boundary fix. |
| F-31-C / M-24: `DEFAULT_MIN_RESERVE_FLOOR_WEI = 10 ether` + `effectiveMinReserveFloor()` view | CONSERVATIVE-TWEAK | One constant + one fallback view onto existing mapping. |
| F-24-2: `minReserveFloor1` per-side mapping + `setMinReserveFloor1` + `effectiveMinReserveFloor1()` | NEW-MACHINERY | New mapping, new setter, new view, new event. |
| F-24-1: `MAX_BRIDGING_GAP = 2 hours` + `bridgingGapTrip` flag in update path | CONSERVATIVE-TWEAK | One constant + one boolean derivation against existing pair-touch read. |
| F-74-11: sequencer-outage observation marking via `tryCheckSequencerUp` | CONSERVATIVE-TWEAK | One try-call + one boolean. |
| F-95-K-4: `MIN_UPDATE_FEE = 1e14`, `updateFeeConfigured` flag | NEW-MACHINERY | New constant + new storage flag + new branch. Defaults effective fee to 1e14 wei until explicit owner config. |
| M-44 / F-55-8: bound refund `gas: 30000`, divert overflow to `accumulatedFees` on failure | CONSERVATIVE-TWEAK | Mirrors WETHFallbackLib gas-stipend pattern. |
| F-95-K-8: gate `withdrawFees` to `onlyOwner` | CONSERVATIVE-TWEAK | One modifier add. |
| F-24-4 / F-42-2: replace `(amountIn * priceDiff) / (uint256(elapsed) * Q112)` with `Math.mulDiv` | CANONICAL (Uniswap V3 OracleLibrary verbatim) | DELETE-and-replace; gold-standard mandate-compliant. |
| H-13 / F-89-K / F-46-2 / F-24-3: stamp `lastBypassUsed[pair]` on count<=2 grace branch | CONSERVATIVE-TWEAK | Two writes against existing mapping. |
| M-45 / F-72-5: `tryGetLatestObservation()` non-reverting sister | CONSERVATIVE-TWEAK | One new view function — direct mirror of `tryCheckSequencerUp` lib pattern. |
| M-48 / F-74-4: pass 4h staleness to `checkSequencerUp` | CONSERVATIVE-TWEAK | One arg add. |

**Mandate verdict:** Most are clean. F-46-1, F-24-1, F-74-11, M-44, F-95-K-8, F-24-4 are textbook conservative tweaks (especially F-24-4 swapping to OZ `Math.mulDiv` — exact mandate-cited canonical pattern). F-31-C is borderline-clean (uses fallback view onto existing storage; doesn't add a new mapping).

**F-24-2 (`minReserveFloor1` per-side) is NEW-MACHINERY.** The cited concern (cross-decimal pairs) is real for FUTURE pairs but has zero impact on the current 18:18 TOWELI/WETH deployment. The mandate's pattern library cites Uniswap V2 cumulative price as the canonical TWAP shape — V2 has no per-side reserve floor. **Mandate-strict alternative:** ACCEPT-AS-DESIGN with NatSpec note that cross-decimal pairs are not supported by current oracle config. Net: -25 LoC.

**F-95-K-4 (MIN_UPDATE_FEE default) is NEW-MACHINERY.** Pre-fix the default was 0 (canonical Uniswap V2 oracle behaviour — no fee). The fix introduces a `MIN_UPDATE_FEE` floor that engages by default and a `updateFeeConfigured` flag to track whether the owner has set explicitly. Two new state-bearing concepts. Canonical Uniswap V2 / Uniswap V3 oracle reads have no fee; the mandate-strict path is to either accept the keeper-grief surface (mandate-cited) OR collapse to a simple `setUpdateFee` call at deploy.

**Mandate-strict alternative for F-95-K-4:** Revert. Document deploy-runbook step "set updateFee = 1e14 immediately post-deploy." Net: -15 LoC.

---

### `TegridyStaking.sol` (+134 LoC, ~80 effective)

| Block | Classification | Notes |
|---|---|---|
| F-35-2: `MAX_REWARD_RATE` 100e18 → 1e18 | CONSERVATIVE-TWEAK | Constant change. Tightens captured-owner runway. |
| F-02-K-03: `extendLock` compares against resulting lockEnd, not original duration | CONSERVATIVE-TWEAK | One-line compare semantic fix. |
| F-02-K-04: clamp boost in `increaseAmount` to remaining-lock-justified | CONSERVATIVE-TWEAK | 5-line clamp against existing `calculateBoost`. |
| H-2 / F-02-K-01: `jbacStillValid` gate before bonus restore in autoMaxLock | CONSERVATIVE-TWEAK | One-line balance check, mirrors revalidateBoost. Cited in mandate's pattern library as a sibling-port. |
| F-60-3: 7702-EOA filter (`code.length == 23`) on transfer guard | CONSERVATIVE-TWEAK | Mirror of standard pattern. |
| F-60-2: 7702-EOA filter on `setStakingAdmin` / `proposeAdminReplacement` | CONSERVATIVE-TWEAK | Mirror of standard pattern. |
| H-14 / F-75-1 / F-43-A: 7-day validity window on `executeAdminReplacement` | SIBLING-PORT | Direct backport from SwapFeeRouter's existing pattern. |
| M-1 / F-02-K-02: route rewardPool shortfall through `_settleUnsettled` in `_update` | CONSERVATIVE-TWEAK | Mirror of `_getReward` and `kick` pattern in same file. |
| M-28 / F-35-1 / F-65-1: symmetric guard on `applyRestakingContract` (block while old escrow holds NFTs) | SIBLING-PORT | Direct mirror of `applyLendingContract` PendingLendingPositions. |
| F-35-3: `MAX_MAX_UNSETTLED = 1e10 ether` sanity ceiling on `applyMaxUnsettledRewards` | CONSERVATIVE-TWEAK | One constant + one revert. |

**Mandate verdict:** All clean. Every block is either a constant change, a sibling-port, or a one-line semantic refinement against existing primitives. Textbook mandate-compliant.

---

### `TegridyStakingAdmin.sol` (+16 LoC, +12 effective)

| Block | Classification | Notes |
|---|---|---|
| F-43-C / F-60-2: 7702-EOA filter on `proposeRestakingContract` | SIBLING-PORT | Mirror of staking-side pattern. |
| F-35-3: propose-time `MAX_MAX_UNSETTLED` sanity ceiling | SIBLING-PORT | Mirror of staking-side apply-time check. |

**Mandate verdict:** Clean sibling-ports.

---

## Aggregate counts

| Classification | Block-level count | Comment |
|---|---|---|
| **CANONICAL** | 5 | C-1 (Synthetix), F-24-4 (UniV3 OracleLibrary), F-76-A (UniV4 IHooks), H-9 (Aave V3 PriceOracleSentinel), F-17-4 DELETE |
| **SIBLING-PORT** | ~30 | M-15, M-19, F-62-1, F-71-3, H-2, M-28, M-1, F-43-C, H-14, F-95-K-7-cancelreset, M-13, M-3-stranded-emergency, etc. |
| **CONSERVATIVE-TWEAK** | ~50 | M-40, M-42, M-38, M-25, M-26, M-27, F-31-A/B/D/E, F-46-1, F-24-1, F-30-1, F-30-9, F-30-10, F-30-5, F-50-8, F-13-4, F-04-6, F-51-1, F-04-7-cap-only path, F-60-2/3 across many files, F-08-K-01, F-33-4/5, F-35-2/3, F-02-K-01/03/04, M-44, F-95-K-8, M-45, M-48, H-13, F-04-4, etc. |
| **NEW-MACHINERY** | **17** | (see list below) |

### NEW-MACHINERY entries — mandate concerns

The 17 NEW-MACHINERY entries, in approximate order of mandate severity:

| # | Finding | File | Mandate-strict alternative | LoC saved |
|---|---|---|---|---|
| 1 | F-40-ONR-1 | OwnableNoRenounce | REVERT — re-call `transferOwnership(newAddr)` is canonical OZ pattern. | -97 |
| 2 | H-12 mode-split | WETHFallbackLib | REVERT — mandate's substitution table explicitly rejects multi-mode return enums. Use single bool + revert OR keep 3-mode. | -50 |
| 3 | H-10 / M-35 lib expansion | VotePowerOracle | REVERT — call `powerAt(user, t-1, ...)` from consumers; ACCEPT M-35 silent-fail per Solady. | -140 |
| 4 | H-16 per-day rate limiter | TegridyFactory | REVERT — multisig guardian (already in diff) is the rate limit. | -40 |
| 5 | F-65-2 timelocked restaking rotation | GaugeController | REVERT — keep one-shot pointer. | -100 |
| 6 | F-69-2 quorum mapping | GaugeController | REVERT — Curve GaugeController has no quorum gate; ACCEPT-AS-DESIGN. | -50 |
| 7 | F-13-3 paginated reclaim | RevenueDistributor | REVERT — 5y eth_call blowup is ACCEPT-AS-DESIGN. | -50 |
| 8 | F-12-K-3 protocolDustPool | RevenueDistributor | Replace with direct `totalForfeited` bump only; drop the dedicated mapping + event. | -40 |
| 9 | F-93-2 NOTIFY_COOLDOWN | TegridyLPFarming | REVERT — private mempool relay is canonical. | -10 |
| 10 | F-95-K-2 offer caps | TegridyLending + TegridyNFTLending | REVERT — Gondi has no offer caps (mandate-cited canonical reference). | -100 |
| 11 | F-95-K-7 sweepUnsolicitedNFT | TegridyLending + TegridyNFTLending | REVERT — Gondi has no analogous admin sweep. | -210 |
| 12 | F-71-9 / F-71-2 cumulative-pause + grace-extension | TegridyNFTLending | REVERT — mirror sister TegridyLending simple cap; ACCEPT mid-grace compression. | -80 |
| 13 | F-72-6 view-clamp / strict-revert split | TegridyNFTLending | REVERT — keep strict-revert in both view and write paths. | -40 |
| 14 | F-04-3 timelocked residual-clear | TegridyRestaking | REVERT — already on the ACCEPT-AS-DESIGN list. | -50 |
| 15 | M-3/M-4 timelocked rescueNFT | TegridyRestaking | REVERT — already on the ACCEPT-AS-DESIGN list. | -50 |
| 16 | F-04-7 / F-84-1 decimal-scaled cap | TegridyRestaking | Drop decimals cache; align constants only. | -25 |
| 17 | H-3 / F-04-1 unforwardedBonusRewards | TegridyRestaking | UNAVOIDABLE — pre-fix was actively wrong. Smallest correct shape. | 0 |
| 18 | M-12 / F-12-K-1 _consumeEligibleAndBumpClaimed | RevenueDistributor | UNAVOIDABLE — view↔write parity restoration. Smallest correct shape. | 0 |
| 19 | F-31-F ProtocolFeeHarvested event | TegridyPair | REVERT — incidental observability; canonical UniV2 has no such event. | -8 |
| 20 | F-24-2 per-side reserve floor | TegridyTWAP | ACCEPT-AS-DESIGN — current 18:18 deployment unaffected. | -25 |
| 21 | F-95-K-4 MIN_UPDATE_FEE | TegridyTWAP | REVERT — canonical UniV2 oracle has no fee; deploy-runbook step. | -15 |

**Total LoC reclaimable by reverting the mandate-violating NEW-MACHINERY:** ~**1,180 LoC** (~38% of the 3,092 net add).

---

## Summary

- The **Wave-A baseline (8d8bac4)** is the dominant src delta. ~80% of its blocks are CANONICAL, SIBLING-PORT, or CONSERVATIVE-TWEAK — clean against the mandate.
- The **post-Wave-A commits (6865982, e0ded36, 95ddbd7)** are all clean. `e441133` (Wave-B revert) and `95ddbd7` (H-18 revert) are the gold-standard mandate moves (DELETE).
- The **mandate-violating NEW-MACHINERY** is concentrated in Wave A in 4 spots that should be escalated:
  1. `OwnableNoRenounce` F-40-ONR-1 (full ownership-expiry/cancel ceremony) — most direct violation of the mandate's pattern library.
  2. `WETHFallbackLib` H-12 (4-mode return enum + 2 new events) — directly listed in the mandate's "substitutions to default to" anti-pattern table.
  3. `VotePowerOracle` H-10 + M-35 (4 new functions + 1 new event in a previously thin no-state lib).
  4. `TegridyLending` + `TegridyNFTLending` F-95-K-2 / F-95-K-7 (offer caps + admin sweep) — both diverge from Gondi, the mandate's explicit canonical reference.
- A handful of smaller NEW-MACHINERY blocks (F-65-2, F-69-2, F-13-3, F-93-2, F-71-9, F-72-6, F-04-3, M-3/M-4, F-04-7, F-95-K-4, F-24-2, F-31-F) are either over-engineered relative to mandate-cited canonical patterns or duplicate concerns already on the ACCEPT-AS-DESIGN list (POST_MANDATE_STATE.md).
- Two NEW-MACHINERY entries are **UNAVOIDABLE** (H-3 / F-04-1 wrong-token bug and M-12 / F-12-K-1 view↔write parity) — smallest correct shape.

**Net opportunity:** Reverting the 21 listed mandate-violating NEW-MACHINERY entries reclaims ~1,180 LoC and brings the diff to ~1,910 net adds — almost all of which is CANONICAL / SIBLING-PORT / CONSERVATIVE-TWEAK and consistent with the mandate.

Path: `.audit_2026_freshlook/post_fix_scan2/diff_review.md`
