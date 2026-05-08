# Agent 98 — Test Coverage Gaps (Fresh-Eyes Audit)

**Lens:** What is NOT tested. Missing edges, missing attack contracts, missing
forks, missing fuzz, paths exercised only via mocks vs. real flow.

**Scope read:** `contracts/test/*.sol` (117 files, 16 invariant suites,
1 broken fuzz suite excluded from build) and `contracts/src/*.sol` for
function-to-test mapping.

**Severity legend:** `[CRIT]` = unknown could mask exploit · `[HIGH]` =
substantial uncovered surface · `[MED]` = isolated edge missing ·
`[LOW]` = nice-to-have hardening · `[INFO]` = housekeeping.

---

## F-98-A — `[CRIT]` ZERO fork tests against mainnet/L2 state

**Function/area:** entire suite — `forge test --match-contract Fork*` returns 0.

**Specific scenarios uncovered:**
- `TegridyFeeHook` integration with the real Uniswap V4 PoolManager
  (`0x000000000004444c5dc75cB358380D2e3dE08A90` on mainnet). All 7 hook test
  files (`TegridyFeeHook.t.sol`, `R031_TegridyFeeHook.t.sol`,
  `Audit195_PremiumHook.t.sol`, `PASS7_HOOK_01.t.sol`,
  `PASS8_HOOK_ALLOWLIST.t.sol`, `AuditR014_Misc.t.sol`,
  `Deep_AMM_2026_05_01.t.sol`) use a 9-line `MockPoolManager` whose
  `balanceOf` is a hand-set mapping. The real PoolManager's settlement,
  delta-tracking, and ERC-6909 mechanics are NEVER exercised.
- Real-WETH ETH/WETH unwrap behavior (`weth.withdraw()` reverting if
  contract has no ETH, etc.).
- Real Chainlink Sequencer Uptime feed shape — every test uses a mock
  that returns `(1, answer, startedAt, block.timestamp, 1)`. The real
  feed's `roundId` semantics, missed rounds, and L2-specific delays
  are not validated.
- L2 deployment compatibility (Arbitrum/Optimism) — `L2Compatibility.t.sol`
  exists but only tests timestamp-overflow boundary math, not actual L2
  RPC behavior on a fork.

**Search evidence:** `vm.createSelectFork`, `vm.createFork`,
`forkBlockNumber`, `forkUrl`, `MAINNET_WETH`, `POOL_MANAGER` constants —
**zero hits across all 117 test files**.

**Why this matters:** Hooks specifically have multiple known v4-core
integration foot-guns (delta accounting, `unlock()` callback ordering,
ERC-6909 claim direction). With zero fork tests, integration bugs cannot
surface in CI. The protocol is shipping to production against a mock
that the team controls — every assumption baked into the mock is unverified.

**Severity of unknown:** CRITICAL. A single integration bug here drains the
protocol on a real swap.

---

## F-98-B — `[CRIT]` `SequencerCheck` is wired into 8 contracts but only 3 have integration tests

**Functions:** `TegridyLending._positionETHValue` /
`TegridyNFTLending._positionETHValue` / `MemeBountyBoard._sequencerBuffer` /
`SwapFeeRouter._gateOnSequencerStatus` / `POLAccumulator.harvest*` /
`TegridyDropV2._currentDutchPrice` / `TegridyTWAP.consult`.

**What IS tested:** `R062_SequencerCheck.t.sol` covers TWAP, `Audit195_POL.t.sol`
covers POL accumulate, `Deep_DropLaunchpad_2026_05_01.t.sol` covers
DropV2 dutch auction.

**What is NOT tested (per direct grep on each test file):**
- `TegridyLending.t.sol` — 0 hits for `MockSequencerFeed`,
  `SequencerCheck`, or `SequencerDown`. The lending position-ETH-value
  read (the most security-critical sequencer gate in the protocol —
  it determines collateral solvency) has no per-contract integration
  test for the down path.
- `TegridyNFTLending.t.sol` — 0 hits. Same risk as above for NFT collateral.
- `MemeBountyBoard.t.sol` — 0 hits. Even though
  `MemeBountyBoard.sol` line 12 imports `SequencerCheck` and exposes
  `_sequencerBuffer`.
- `SwapFeeRouter.t.sol` — 0 hits. SFR has a sequencer-gate at
  `SwapFeeRouter.sol:1971` (`SequencerCheck.checkSequencerUp(sequencerFeed,
  SEQUENCER_GRACE_PERIOD)`) that's never exercised in the SFR-specific
  test suite.

**Specific missing scenarios for each:**
- Sequencer just resumed → grace not over → `acceptOffer` /
  `claimDefault` / `recordFee` reverts (each contract has its own
  `SEQUENCER_GRACE_PERIOD` and sometimes a 4h staleness check; no
  test exercises these per-contract constants).
- Outage straddling a loan deadline — `SEQUENCER_OUTAGE_BUFFER`
  extension (vote-incentives constant `SEQUENCER_OUTAGE_BUFFER`,
  Lending `getSequencerOutageBuffer`).
- Round-not-initialized path (round-zero `latestRoundData`).

**Severity of unknown:** CRITICAL. Lending/NFTLending solvency depends on
fresh oracle reads. A bug in the per-contract gate (e.g., wrong
`SEQUENCER_GRACE_PERIOD` constant, wrong staleness window) is
not caught.

---

## F-98-C — `[CRIT]` Foundry invariant runs are not configured

**Evidence:** `foundry.toml` has no `[profile.default.invariant]` section.
There are 16 invariant test files defining ~30 invariant_* properties,
but Foundry's default `invariant_runs = 256, invariant_depth = 15` is
extremely shallow for protocols of this size (5+ external actors,
deep state machines).

**Specifically missing:**
- No `runs = 10000+` for production-quality invariant testing.
- No `[fuzz]` config — default `runs = 256` for fuzz tests.
- No `[invariant] fail_on_revert = true` to catch unexpected reverts as
  invariant violations.
- No `[invariant] dictionary_weight` tuning for the actor handler shape.

**Severity of unknown:** CRITICAL. Invariants exist on paper but are
under-stressed. The Pass-6 lending solvency invariant
(`Pass6_LendingSolvency.t.sol`) has 3 invariants gating the entire
lending economic security model — at 256 runs of 15 depth, the
search space is microscopic.

---

## F-98-D — `[HIGH]` No tests use 6-decimal (USDC-shape) tokens against fee-bearing flows

**Function/area:** Every contract that takes a generic ERC20:
`TegridyLending` (whitelist), `TegridyNFTLending`, `RevenueDistributor`
(distribute non-WETH token), `VoteIncentives.depositBribe` (whitelist),
`SwapFeeRouter` (fee accounting on FoT/decimal-mismatch tokens),
`TegridyPair` (creates pairs against any-decimal token).

**Evidence:** Search for `decimals = 6`, `_dec.*6`, `MockUSDT`,
`MockUSDC`, `setDecimals(6)`:
- Active test files: ZERO matches.
- Single match: `R032_WETHValidate.t.sol.broken` (line 62, the
  `.broken` file is excluded from the build per file extension).

Every active mock token is 18-decimal. Decimal scaling bugs that only
manifest when `token.decimals() != 18` (e.g., share-price math, fee BPS
on small absolute numbers, dust accumulation) are completely unexercised.

**Specific missing tests:**
- `RevenueDistributor.distribute(MockUSDC)` — does the per-share math
  round correctly when 1 USDC = 1e6 raw vs. 1 ETH = 1e18 raw?
- `VoteIncentives.depositBribe(MockUSDC, 100e6)` — bribe accounting
  with 6-decimal token.
- `TegridyPair` 18:6 decimal pair — first-deposit minimum-liquidity
  edge, K-invariant rounding, oracle math.
- `SwapFeeRouter.swapTokensForTokens` with USDC↔WETH path — fee
  accounting on the 6-decimal leg.
- `TegridyLending.acceptOffer` with USDC principal token (if supported).

**Severity of unknown:** HIGH. Decimal mismatch is one of the most
common DeFi bugs. The protocol is whitelist-gated, but post-launch
the team will whitelist USDC/USDT (currently the most-used stables);
the math has never been tested against either shape.

---

## F-98-E — `[HIGH]` Zero "captured-owner within timelock window" scenario tests

**Functions:** ALL timelocked owner-only paths across 25 contracts using
`TimelockAdmin`-derived bases.

**The scenario that's not tested:** Owner key is compromised at time
T. Attacker `propose*()` a malicious change (e.g., set treasury to
attacker-controlled address). Real owner regains control via
multi-sig rotation BEFORE `executeAfter` elapses. Real owner must be
able to `cancel*()` the pending proposal — and this cancel path
must work for EVERY proposal type in EVERY contract.

**Search evidence:**
- `test.*[Hh]ostileOwner` — 0 matches.
- `test.*[Cc]aptured` — 0 matches.
- `test.*[Cc]ompromised` — 0 matches.
- `test.*[Mm]alicious[Oo]wner` — 0 matches.

**Per-contract cancel-path verification status:**
- `RevenueDistributor.cancelEmergencyWithdraw` — tested
  (`test_emergencyWithdrawExcess_canCancel`).
- `CommunityGrants.cancelProposal` — tested (multiple paths).
- `MemeBountyBoard.cancelMinBountyReward` — UNTESTED.
- `SwapFeeRouter.cancelFeeChange` — UNTESTED (only happy-path execute
  is tested).
- `SwapFeeRouter.cancelTreasuryChange` — UNTESTED.
- `POLAccumulator.cancelMaxSlippage` — tested.
- `POLAccumulator.cancelSweepETH` — UNCLEAR (only `propose` tested).
- `TegridyLending.cancelWhitelistChange` / similar — UNTESTED.
- `TegridyNFTLending.cancel*` — UNTESTED (NFT lending only tests
  whitelist propose+execute).
- `PremiumAccess.cancelTreasuryChange` — UNTESTED.
- `ReferralSplitter.cancelFeeChange` — UNTESTED.
- `VoteIncentives.cancelTreasuryChange` — UNTESTED.

**Severity of unknown:** HIGH. The ENTIRE security argument of timelocks
is "captured owner can be undone within the window." If any
`cancel*()` reverts when called by the (now-rotated, legitimate) owner,
the protocol cannot recover from a captured-key incident. Worse, if
any cancel path has its own ACL bug, the attacker can lock their
own malicious proposal in.

---

## F-98-F — `[HIGH]` Reentrancy attacker contracts exist for AMM/Lending/NFTPool/Revenue but NOT for Restaking, DropV2, Launchpad, VoteIncentives

**Files containing reentrancy attacker contracts:**
- `RedTeam_AMM.t.sol`, `RedTeam_Staking.t.sol`,
  `RedTeam_Revenue.t.sol`, `RedTeam_CrossContract.t.sol`,
  `TegridyLending_Reentrancy.t.sol`, `TegridyNFTPool_Reentrancy.t.sol`,
  `R064_PaginationBounds.t.sol`, `PASS8_ROYALTY.t.sol`.

**Files with NO reentrancy attacker test:**
- `TegridyRestaking.t.sol` — `TegridyRestaking.claimAll`,
  `unrestake`, `emergencyWithdrawNFT` all have CEI-sensitive reward
  payouts. The contract does have `nonReentrant` modifiers, but a
  dedicated reentrancy attacker that calls back via the NFT
  `onERC721Received` callback on `unrestake` is not tested.
- `TegridyDropV2.t.sol` — `mint` refunds overpayment via `call`;
  `refund` (post-cancellation) sends ETH; `withdraw` splits to creator
  + platform. No reentrant attacker test.
- `TegridyLaunchpadV2.t.sol` — `createCollection` deploys a clone and
  initializes it; no test verifies that a malicious initialize
  callback (e.g., on a hostile token contract used as the
  `paymentToken` in some future config) cannot reenter.
- `VoteIncentives.t.sol` — `claimBribes` and `claimBribesBatch` send
  ETH/tokens. The contract uses `nonReentrant`, but no integration
  test wires an attacker contract as the receiver and verifies the
  guard fires.

**Severity of unknown:** HIGH for Restaking and VoteIncentives (both
hand out tokens to user-controlled addresses); MEDIUM for Drop/Launchpad.

---

## F-98-G — `[HIGH]` Pause behavior untested across many state-changing functions

**Pattern:** Every contract using `PausableUpgradeable` /
`Pausable` / a custom paused flag must verify EVERY state-mutating
function reverts when paused (and conversely, state-reading or
emergency-exit functions can still be called). Many tests only check
1–2 functions per contract.

**Per-contract pause test gaps (from `test.*[pP]ause` grep):**

| Contract | Pause tests | Functions paused (src) | Coverage |
|---|---|---|---|
| `MemeBountyBoard` | 0 | `createBounty`, `submitWork`, `vote`, `cancelBounty`, `completeBounty`, `withdrawRefund`, `sweepExpiredPayout`, `sweepExpiredRefund` | NONE |
| `TegridyDropV2` | 0 | `mint`, `setMintPhase`, `cancelSale`, `refund`, `reveal`, `withdraw` | NONE |
| `POLAccumulator` | 0 | `accumulate`, `harvest*`, `executeHarvestLP` | NONE |
| `TegridyFeeHook` | 0 | swap/distribute hooks (some `whenNotPaused` exists) | NONE |
| `PremiumAccess` | 0 | `subscribe`, `cancelSubscription`, `withdrawToTreasury`, `reconcileExpired` | NONE |
| `TegridyRestaking` | 1 (only `unrestake_worksWhenPaused`) | `restake`, `claimAll`, `claimPendingUnsettled`, `claimResidualForTokenId` | PARTIAL |
| `VoteIncentives` | 2 (deposit) | `claimBribes`, `claimBribesBatch`, `vote`, `commit`/`reveal`, `sweepForfeitedBond` | PARTIAL |
| `CommunityGrants` | 2 (create+vote) | `executeProposal`, `cancelProposal`, `retryExecution` | PARTIAL |
| `TegridyLending` | 3 (offers+repay) | `cancelOffer` (paused?) | LIKELY OK |
| `TegridyStaking` | 3 (stake+revalidate+emergency) | many | OK |
| `RevenueDistributor` | 1 (claim) | `distribute`, `forfeitReclaim` | PARTIAL |

**Severity of unknown:** HIGH. The MOST common L1 mistake is "we
forgot to add `whenNotPaused` to function X." `MemeBountyBoard` and
`TegridyDropV2` having ZERO pause tests means regressions on this are
silent.

---

## F-98-H — `[HIGH]` Multi-user race-condition tests are sparse

**Search:** `test.*concurrent`, `test.*race`, `test.*[Mm]ultiUser`,
`Alice.*claim.*Bob.*claim`, etc.

**Hits:**
- `Audit195_StakingCore.t.sol` — `test_multiUser_stakeWithdrawEarlyWithdrawConsistency`
- `Audit195_Restaking.t.sol` — `test_multiUser_totalRestakedConsistency`
- `Audit195_PremiumHook.t.sol` — `test_P01_subscribeEscrowConsistency_multiUser`
- `RedTeam_Staking.t.sol` — `test_DEFENDED_concurrentTransfersUnsettledProtection`
- `Pass6_Regressions.t.sol` — one Alice/Bob interleaving.
- `PASS8_PHASE_1_6.t.sol` — one interleaving.

**Specific missing scenarios:**
- `RevenueDistributor.distribute` followed by Alice + Bob both calling
  `claim()` in the same block — does the cumulative reward shares math
  hold (cf. the H1 distribute-bypass PoC and the share-checkpoint logic)?
- `VoteIncentives` 2-user `commit` → both `reveal` in same block →
  verify both vote tallies are independent and bond accounting is
  correct.
- `TegridyLending` 2-lender same-tokenId race: both make offers, borrower
  accepts one — verify the OTHER lender's ETH is fully refundable via
  `cancelOffer`.
- `TegridyNFTPool` two simultaneous `swapTokensForExactNFTs` against the
  same pool (front-running scenario) — only `TegridyNFTPool_Sandwich.t.sol`
  has 1-2 such tests.
- `TegridyLPFarming` two stakers both call `getReward()` after
  `notifyRewardAmount` — total payout vs. allocated reward.
- `CommunityGrants` two voters, one with much higher voting power,
  vote on opposite sides exactly at `endBlock - 1` and `endBlock`
  boundary.

**Severity of unknown:** HIGH. Concurrency races are a primary class
of MEV exploit. With limited test coverage, the team cannot rule out
state-corruption from interleaved txs.

---

## F-98-I — `[HIGH]` `FuzzV3.t.sol.broken` — 18 disabled fuzz tests for NFTPool

**File:** `contracts/test/FuzzV3.t.sol.broken` (29 KB, file ext renamed
to disable from build).

**Tests it contains (per grep):**
- `testFuzz_buyQuoteMath`
- `testFuzz_buyQuoteMathTradePool`
- `testFuzz_sellQuoteMath`
- `testFuzz_buyThenSellRoundTrip`
- `testFuzz_spotPriceUpdateCorrectness`
- `testFuzz_spotPriceUpdateVariableParams`
- `testFuzz_interestCalculation`
- `testFuzz_interestZeroWhenNoTimeElapsed`
- `testFuzz_interestLinearScaling`
- `testFuzz_collateralSufficiency`
- `testFuzz_loanOfferBoundsEnforcement`
- `testFuzz_protocolFeeRange`
- `testFuzz_protocolFeePropagation`
- `testFuzz_protocolFeeChangeEnforcesBounds`
- `testFuzz_deltaRange`
- `testFuzz_deltaExceedsCap`
- `testFuzz_proposeDeltaEnforcesCap`

These cover the bonding-curve math, loan offer bounds, protocol fee
propagation, delta validation — the EXACT mathematics that bugs in
NFTPool/Lending tend to live in. They were last edited 2026-04-26.

**Severity of unknown:** HIGH. Disabling these without a replacement
removes a substantial test surface. No comment in the file or repo
explains why they were disabled.

---

## F-98-J — `[HIGH]` `R032_WETHValidate.t.sol.broken` — disabled WETH-validation tests

**File:** `R032_WETHValidate.t.sol.broken` (8.8 KB).

**Risk:** The single token shape with a `decimals()` of 6 lives in this
file (line 62: `uint8 public decimals = 6;`). Renamed to `.broken`,
the file is excluded from the build, so the protocol literally has no
6-decimal token shape exercised in CI. The file also has a token
returning a revert from `decimals()` (line 71) which is the canonical
shape that breaks naive `IERC20Metadata.decimals()` callers.

**Severity of unknown:** HIGH. Combined with F-98-D, this confirms
6-decimal handling is not just under-tested — it's been actively
disabled and not replaced.

---

## F-98-K — `[MED]` Boundary tests at exact `block.timestamp == lockEnd`

**What IS tested:**
- `Audit195_StakingGov.t.sol:212-216` — `vm.warp(lockEnd-1)` and
  `vm.warp(lockEnd)`.
- `FinalAudit_Staking.t.sol:153-163` — same boundary.

**What is NOT tested:**
- `TegridyLending.acceptOffer` / `claimDefault` at exact deadline
  boundary. Test file warps to `deadline` once (line 1286) but doesn't
  systematically check `>=` vs `>` semantics.
- `MemeBountyBoard.completeBounty` exactly at deadline.
- `CommunityGrants.finalizeProposal` at exact `endBlock`.
- `TegridyDropV2` dutch-auction price at exact `dutchStartTime` and
  `dutchStartTime + dutchDuration`.
- `VoteIncentives.advanceEpoch` at exact `nextEpochAt`.
- `TegridyRestaking.unrestake` at exact `lockEnd`.
- `PremiumAccess` subscription boundary at `expiresAt`.

**Severity of unknown:** MED. Off-by-one (`<` vs `<=`) bugs at boundary
timestamps are common; the protocol relies on exact semantic
consistency across all timelocked paths.

---

## F-98-L — `[MED]` Donation-attack coverage uneven

**Tested:**
- `TegridyPair` first-deposit MIN_LIQUIDITY (multiple files).
- `TegridyRestaking` external-transfer protection
  (`test_claimAll_notInflatedByExternalTransfer`,
  `test_unrestake_notInflatedByExternalTransfer`).
- `Audit195_Pair.t.sol` skim/sync.

**Untested donation-attack vectors:**
- `RevenueDistributor` — what happens if attacker transfers raw ETH
  or token directly to the contract (not via `distribute()`)?
  `sweepDust` exists, but no test verifies that direct-transfer
  cannot perturb the per-share accounting.
- `VoteIncentives` — direct ERC20 transfer to contract bypassing
  `depositBribe`. Does anything claim it? `sweepToken` exists but
  test doesn't model the attack.
- `TegridyLending` — direct ETH/Toweli transfer. Tested partially via
  `Pass7_LendingExtSolvency.t.sol` invariant, but not as a directed
  attacker scenario.
- `TegridyLPFarming` — direct LP-token transfer (changes
  `balanceOf(this)` without going through `stake`).
- `CommunityGrants` — direct token donation between proposals.
- `MemeBountyBoard` — direct token donation to inflate prize-pool
  appearance.
- `ReferralSplitter` — direct ETH/WETH transfer between fee
  recordings.

**Severity of unknown:** MED. Most contracts have explicit
share/balance accounting that's invariant to balance, but per-contract
PoC of "I transfer 1 ETH directly, then call X — does anything break?"
is missing for 7 contracts.

---

## F-98-M — `[MED]` Decimal-mismatch in pair-creation untested

**Function:** `TegridyFactory.createPair(tokenA, tokenB)` with mismatched
`decimals()`.

**Single found test:** `Audit195_Pair.t.sol` defines `AuditMockERC20`
with configurable decimals BUT every test calls it with `dec_=18`.
The decimal field is never exercised at non-18 in pair tests.

**Specific missing:**
- 18-decimal token vs. 6-decimal token pair creation.
- 18 vs. 8 (WBTC-shape).
- Pair where `token0.decimals() == 18` and `token1.decimals() == 0`
  (REP-shape, exotic).

**Severity of unknown:** MED. The pair K-invariant math is
decimal-agnostic in theory, but rounding artifacts and the
MIN_LIQUIDITY (1000 wei) floor have known interactions with very
small-decimal tokens.

---

## F-98-N — `[MED]` `TegridyLaunchpadV2.t.sol` has only 10 tests for a factory contract

**Coverage list (all 10):**
1. `createCollection` happy-path.
2. Empty merkle.
3. Dutch phase requires dutch params.
4. Rollback on invalid royalty.
5. `contractURI` getter.
6. `setContractURI` only-owner.
7. PUBLIC phase allows mint immediately.
8. Allowlist requires merkle root.
9. Legacy event shape preserved.
10. Fuzz `collectionConfig_no_panics`.

**Missing:**
- 2 different creators creating with the same name/symbol — name
  collision behavior (shouldn't matter, but unverified).
- Re-entrant `createCollection` (Launchpad calls `Clones.clone()` and
  `initialize()`; if a future version takes hostile config, can
  initialize callback do anything?).
- Ownership flow: launchpad owner is a separate role from clone
  creator — admin-rotation interactions untested.
- Pause flow on launchpad itself.
- Platform fee accounting under multi-creator stress.
- Gas cost / EIP-170 size of resulting clones (not strictly a fuzz
  concern, but no measurement test).

**Severity of unknown:** MED. The launchpad is a deployer of customer
collections; bugs here mean every drop on the protocol launches with
the bug.

---

## F-98-O — `[MED]` `Toweli.t.sol` has 14 tests for the protocol's primary token — minimal but acceptable since Toweli is purely fixed-supply ERC20+permit

**Coverage:** constructor, metadata, immutability, no mint/burn/owner,
basic transfer, permit (3 tests).

**Gaps:**
- Permit signature malleability (s-value, v-value).
- Permit with `deadline = type(uint256).max`.
- Permit with `value = type(uint256).max` (infinite approval flow).
- Domain-separator chainId-rotation behavior (would require fork).

**Severity of unknown:** MED. Toweli is the gas token and the
governance/rewards token. EIP-2612 permit edge cases on a token this
critical should be exhaustive.

---

## F-98-P — `[MED]` Hook tests entirely against `MockPoolManager`, never against canonical `PoolManager.sol`

**Restated of F-98-A but specific to hook semantics:**

The `MockPoolManager` in `TegridyFeeHook.t.sol` (lines 12–22) is
22 lines; it implements `balanceOf(address, uint256) returns (uint256)`
backed by a settable mapping. The real PoolManager has:
- `unlock()` callback flow with delta accounting.
- ERC-6909 mint/burn semantics.
- Slot-0 sqrt-price interactions.
- Hook permission validation against the `uint160` address-mask.
- The actual `IUnlockCallback` invocation order.

None of these are exercised in any test.

**Severity of unknown:** MED-to-HIGH. The protocol's audit history
(per commit log: many "TegridyFeeHook" related fixes) suggests
hook integration is non-trivial. Mocks elide exactly the
integration gotchas.

---

## F-98-Q — `[LOW]` Permissionless-caller paths under-stressed

**Functions designed to be called by anyone (in src):**
- `RevenueDistributor.distribute()` — anyone can trigger; cooldown gates.
- `POLAccumulator.accumulate()` — anyone can sweep ETH→LP.
- `SwapFeeRouter.harvest()` — anyone can flush fees.
- `TegridyPair.skim`, `TegridyPair.sync` — anyone.
- `MemeBountyBoard.sweepExpiredPayout` (anyone after grace).
- `MemeBountyBoard.completeBounty` (anyone after grace).
- `Audit195_Bounty.t.sol:test_complete_permissionlessAfterGrace` —
  one direct test.
- `Audit195_Referral.t.sol:test_forfeitRewards*` — direct test.
- `R026_RevenueDistributor.t.sol:test_forfeitReclaim_PerEpochGraceGate` —
  direct test.

**What's under-stressed:**
- Permissionless caller is INCENTIVIZED in some cases (caller-credit
  in `SwapFeeRouter` — `withdrawCallerCredit` test exists in
  `ReferralSplitter.t.sol` but not at the SwapFeeRouter level).
- Gas griefing by permissionless caller — caller-credit large enough to
  attract bots, but bots calling on every block. No DoS-style
  stress test.
- Permissionless caller calling DURING a paused state for the
  surrounding system (e.g., `distribute()` while RevenueDistributor is
  paused but Toweli token transfers still work — no test).

**Severity of unknown:** LOW-to-MED. Permissionless calls are
intended; the bug class would be "caller can extract more value than
intended" or "caller can DoS the function for everyone else."

---

## F-98-R — `[LOW]` `amount = 0` and `amount = 1 wei` boundary coverage uneven

**Tested:**
- `TegridyLPFarming.test_stake_zeroReverts`.
- `SwapFeeRouter.test_revert_swapZeroAmount`.
- `VoteIncentives.test_depositBribe_reverts_zero_amount`.
- `TegridyDropV2.test_mint_revertsOnZeroQuantity`.

**Specific missing:**
- `TegridyStaking.stake(0, lockDays)` — does it revert cleanly?
- `TegridyRestaking.restake(0)` — N/A (takes NFT, not amount).
- `RevenueDistributor.distribute(0)` — minimum amount gate exists, but
  exact-0 vs. just-below-minimum boundary?
- `MemeBountyBoard.createBounty(.., reward=0)` — minimum gate, but
  exactly-0 case?
- `CommunityGrants.createProposal(amount=0)` — what happens?

**Severity of unknown:** LOW. Most have implicit revert via downstream
checks but explicit zero-amount tests are best-practice for
defense-in-depth.

---

## F-98-S — `[LOW]` `type(uint256).max` / overflow boundary tests rare

**Found:**
- `Audit195_Pair.t.sol:141, 677` — `type(uint112).max` for reserves.
- `FinalAudit_Staking.t.sol` — boost calc at max boost.
- `L2Compatibility.t.sol:113` — uint64 timestamp boundary.

**Specific missing:**
- `TegridyLending.acceptOffer` with `principal = type(uint128).max`.
- `VoteIncentives.depositBribe` with `amount = type(uint96).max`
  (`amount` is `uint96` per `R028_*` finding history).
- `RevenueDistributor.distribute` with `amount = type(uint96).max`.
- `MemeBountyBoard.createBounty` with `reward = type(uint96).max`.
- Any `TegridyPair` swap with `amount0Out` close to `uint112.max`
  (overflow protection at `_update`).

**Severity of unknown:** LOW. Most arithmetic is checked-overflow by
default in 0.8.x, but explicit bound tests would surface
`uint96` truncation bugs and slot-packing assumptions.

---

## F-98-T — `[INFO]` Functions called only via test mocks, not real flow

**Identified by test-only invocation pattern:**
- `MockPoolManager.setCredit` — test-only.
- `MockSequencerFeed.setStatus` — test-only.
- `MockToweli_Reentry.setReentry` — test-only.

These are mocks (correct). Of more concern: PRODUCTION paths only
exercised via the mock surface — see F-98-A and F-98-P. Examples:
- `TegridyFeeHook.afterSwap` integration with the real `unlock` /
  delta accounting flow — only ever tested via the 22-line
  `MockPoolManager`.
- `TegridyLending` ETH-floor consultation against the real TWAP +
  real Sequencer Uptime feed combination — tested via mocks at each
  layer but never end-to-end on a fork.

---

## F-98-U — `[INFO]` Test-suite hygiene flags

- `.broken` files (`FuzzV3.t.sol.broken`, `R032_WETHValidate.t.sol.broken`)
  are kept in-tree. Either fix or delete; their continued presence
  suggests "we'll get back to it" debt.
- `foundry.toml` lacks invariant config — invariant runs default to
  256 (very low for a protocol this size).
- 16 invariant files but the suite doesn't surface a single
  consolidated `--match-contract Invariant` runner setup; CI must
  be invoking these correctly to actually run.
- Test files reference 7+ different "audit pass" names (Audit195,
  AuditR014, R018-R032, R062-R064, PASS5-PASS8, Deep_*, RedTeam_*,
  FinalAudit_*, AuditDemonstration). Coverage maps differently per
  pass, so coverage gaps in one round may have been filled by
  another. Without a coverage-report tool run, a reviewer cannot
  confirm functional coverage.

---

## Notes / Dead Ends

- I did not run `forge coverage` — the user's instructions said no edits.
  Without that, function-by-function coverage percentages can only be
  inferred from grep, not confirmed.
- I did not read any `.audit_*.md` history per task constraints; some
  of the gaps above may be intentional design choices documented
  there. Confidence is therefore "uncovered in tests" not "definitely
  uncovered in audit thinking."
- The `Pass7_LendingExtSolvency` and `Pass6_*` invariants exist and
  cover meaningful properties. Coverage of invariant TARGETS is good;
  coverage of invariant DEPTH (foundry runs/depth) is bad.
- `R062_SequencerCheck.t.sol` is well-built and serves as a reference.
  Cloning its pattern to Lending/NFTLending/SFR/MBB would close
  F-98-B.
- `RedTeam_*.t.sol` files are the strongest test surface — adversarial
  scenarios with attacker contracts. There's NO equivalent for
  Restaking/Drop/Launchpad/VoteIncentives.
- I confirmed `foundry.lock` exists but `foundry.toml` has no
  invariant block. The 16 invariant files will run, but at default
  parameters.

---

## Summary table — gap density per contract

| Contract | Pause | Reentr | MultiUser | Decimal | Sequencer | Fork | Fuzz | Cancel-Path |
|---|---|---|---|---|---|---|---|---|
| TegridyStaking | OK | OK | OK | -- | n/a | -- | partial | OK |
| TegridyLending | OK | OK | -- | -- | NONE | -- | broken | -- |
| TegridyNFTLending | partial | -- | -- | -- | NONE | -- | -- | -- |
| TegridyRestaking | partial | -- | partial | -- | n/a | -- | -- | -- |
| TegridyPair/Factory | n/a | OK | partial | partial | n/a | -- | OK | OK |
| TegridyRouter | OK | -- | -- | -- | n/a | -- | -- | n/a |
| TegridyNFTPool | OK | OK | OK | -- | n/a | -- | broken | OK |
| TegridyDropV2 | NONE | NONE | -- | -- | partial | -- | -- | -- |
| TegridyLaunchpadV2 | -- | -- | -- | -- | n/a | -- | 1 | -- |
| TegridyFeeHook | NONE | -- | -- | -- | n/a | -- | -- | -- |
| RevenueDistributor | partial | OK | -- | -- | n/a | -- | -- | OK |
| VoteIncentives | partial | -- | -- | -- | n/a | -- | 1 | -- |
| GaugeController | -- | -- | -- | -- | n/a | -- | -- | -- |
| SwapFeeRouter | OK | OK | -- | -- | NONE | -- | -- | -- |
| POLAccumulator | NONE | -- | -- | -- | OK | -- | -- | OK |
| PremiumAccess | NONE | -- | partial | -- | n/a | -- | -- | -- |
| ReferralSplitter | -- | -- | -- | -- | n/a | -- | -- | -- |
| CommunityGrants | OK | -- | -- | -- | n/a | -- | -- | OK |
| MemeBountyBoard | NONE | -- | -- | -- | NONE | -- | -- | -- |
| TegridyTWAP | n/a | n/a | n/a | n/a | OK | -- | -- | n/a |
| Toweli | n/a | n/a | n/a | n/a | n/a | -- | -- | n/a |

`OK` = covered, `partial` = some functions covered, `--` = not tested,
`NONE` = explicitly empty, `n/a` = not applicable for that contract.

---

## Top three actionable items, in priority order

1. **(F-98-B + F-98-A)** Add a single per-contract sequencer-down test
   to each of `TegridyLending.t.sol`, `TegridyNFTLending.t.sol`,
   `MemeBountyBoard.t.sol`, `SwapFeeRouter.t.sol`. Re-use
   `R062_SequencerCheck.t.sol`'s `MockSequencerFeed`. ETA: 1 day.
2. **(F-98-D + F-98-J)** Either revive `R032_WETHValidate.t.sol.broken`
   or write a fresh 6-decimal-token integration suite covering at
   minimum `TegridyPair`, `RevenueDistributor.distribute`, and
   `VoteIncentives.depositBribe`. ETA: 2-3 days.
3. **(F-98-C)** Add `[invariant]` config to `foundry.toml` with
   `runs = 10000, depth = 50, fail_on_revert = true`. Run the existing
   16 invariant suites under the new config. Triage any new failures.
   ETA: 0.5 day for config, unbounded for triage.
