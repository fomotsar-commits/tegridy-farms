# Agent 035 — Test Hole Audit (`contracts/test/`)

Forensic review of every Solidity test file. AUDIT-ONLY.

## Scope

- 60 active `*.t.sol` files (plus 1 `.bak` left in tree)
- Looking for: trivial assertions, `vm.skip`, `vm.assume` that filters the bug, naked `vm.expectRevert()`, stale fork blocks, mocks that fake the bug, missing branches, vacuous invariants, deploy-only "test passes if function is empty".

## Methodology

Surveyed via Grep for: `vm.skip`, `vm.assume`, `assertTrue(true)`, `assertEq(true,true)`, `assertGt(.,0)` after deploy, `vm.expectRevert()` (no selector), fork plumbing, `contract Mock*`. Then read suspicious passages in context.

Scoreboard for the rating column:

- **REAL** = exercises real branches with specific assertions, includes negative paths and edge cases.
- **WEAK** = real coverage but multiple bare `expectRevert()` (catches wrong revert), or asserts only on `> 0` after a deploy.
- **DECORATIVE** = mostly assertTrue / single-line happy path / mock fakes the bug away / "documented as known issue" with no failing assertion.
- **MISSING** = file expected by name but the surface it claims to test is mostly stubbed.

## Cross-file findings (apply broadly)

| Pattern | Where | Why it's bad |
|--------|------|-------------|
| Naked `vm.expectRevert()` (no selector) | ~120 occurrences across 30+ files | Catches *any* revert. Rename or refactor a function and the test still passes against the wrong revert (e.g. arithmetic underflow vs custom error). The revert reason is never asserted. |
| `assertGt(x, 0)` as the only post-condition | 50+ occurrences | After staking/swapping/restaking/depositing the only check is `> 0`. A buggy reward/payout that pays 1 wei would pass. |
| Mock `votingPowerAtTimestamp(user, _) = constant` | `AuditFixes_Other.t.sol:63`, `RedTeam_Revenue.t.sol:80`, `RedTeam_CrossContract.t.sol`, `RevenueDistributor.t.sol`, etc. | Mocks ignore the timestamp argument and return live power. Real `TegridyStaking` checkpoints time-keyed power; bugs in **checkpoint timestamp filtering** are invisible to these tests. This is the single biggest "fakes-the-bug" pattern. |
| Mock router/pair returns 1:1 with no slippage | `SwapFeeRouter.t.sol:20`, `Audit195_POL.t.sol:21`, `RedTeam_POLPremium.t.sol:35` | Slippage and reserve-shift bugs are masked. Sandwich/MEV checks in `SwapFeeRouter` cannot fire against a 1:1 mock. |
| `vm.assume(amount1Out > 0)` after computing amount with fuzz input | `FuzzInvariant.t.sol:138`, `VoteIncentives.t.sol:571` | Filters out the small-amount edge cases (rounding, dust accumulation) which is exactly where AMM/voting bugs hide. |
| Post-warp tests that warp **only past min lock** then assert generic `assertGt` | `Audit195_StakingGov.t.sol:225,538,963,1285`, `TegridyStaking.t.sol:65,86,358,376,415` | Voting power formula bugs (boost overflow, negative rewardDebt) need exact equality. `>0` is decorative. |
| Tests labeled `_DEFENDED` ending with `assertTrue(true)` or `emit log("DEFENDED")` | `RedTeam_POLPremium.t.sol:955,1099,1115,1136,1179`, RedTeam_CrossContract several | Test only exercises a happy path then narrates "defended". If the underlying defense is removed in a refactor the test still passes (no assertion on the defended invariant). |
| Single `.bak` test file left in repo | `Audit195_Restaking.t.sol.bak` | Tests are not run by Foundry but the file is shipped. Confusing signal of "we have tests for X" while the active file may differ. |
| Pseudo-test with empty body / commented out | `Audit195_Restaking.t.sol:193` (`function test_restake_revertZeroAmount() public { /* hard to trigger */ }`) | Function exists, test passes, no assertion fires. Counts as a passing test for coverage but tests nothing. |
| "Documentation test" that **succeeds** for a known sandwich vector | `TegridyLending_ETHFloor.t.sol:211 test_sandwich_sameBlockManipulation_succeeds` | The test asserts the *attack works* (i.e. records a known bug) — if the bug ever gets fixed this test breaks. Useful as a tripwire only if CI watches it; in a forensic-audit context this is a known-vulnerable surface flagged with no defending test alongside it. |

## Per-file table

| File | Rating | Specific weak assertion (file:line) | What's missing |
|------|--------|------------------------------------|---------------|
| Audit195_Bounty.t.sol | WEAK | `:199, :785, :833, :867, :962, :972` naked `vm.expectRevert()`; `:844 assertGt(minBountyRewardChangeTime, 0)` | Replace bare reverts with `expectRevert(MemeBountyBoard.X.selector)`. Vote-tally edge cases (tied submissions, snapshot manipulation across NFT transfer mid-bounty) are absent. |
| Audit195_Factory.t.sol | REAL | n/a | Has stealth-ERC777 / reverting-ERC165 / granularity edges. Solid. |
| Audit195_Grants.t.sol | WEAK | `:938, :949, :959, :972, :980` naked `expectRevert()` for pause+zero-addr — catches wrong revert | Quorum-edge / proposer==recipient edge after-cooldown is fine; pause tests bare-revert. |
| Audit195_POL.t.sol | WEAK | `:487, :570-579, :650-659, :720, :754-766, :774, :901` 14× naked `expectRevert()`; `:860 assertGt(first, 0)` | onlyOwner shotgun (`:751`) is 13 bare reverts with no selector — would silently pass if function were renamed. |
| Audit195_Pair.t.sol | REAL | `:738-740` is `assertGt(r0,0)` after deposit but the test purpose is "no division by zero" so OK | K-invariant tests are real. |
| Audit195_PremiumHook.t.sol | WEAK | `:848, :866` bare reverts | Hook-currency-mismatch tests rely on `MockPoolManager195 {}` (empty body, line 30) — fakes away any pool-manager interaction. |
| Audit195_Referral.t.sol | WEAK | `:723, :798, :893, :921, :974, :1167` `assertGt(...,0)` only; `:876, :992` bare reverts | Referrer cycle / self-referral / max-depth not asserted. |
| Audit195_Restaking.t.sol | WEAK | `:189, :600, :609, :894` bare reverts; `:193` empty test body documented as "hard to trigger" | Restake unsettled-rewards race (referenced at `:548` of RedTeam_Staking) only `assertGt(.,0)`. |
| Audit195_Restaking.t.sol.bak | DECORATIVE | entire file | Stale `.bak` — not executed, ships in repo. Delete. |
| Audit195_Revenue.t.sol | WEAK | `:295, :302, :570, :680, :693` bare reverts (comments hint at intended message but don't assert it) | Add selector matchers — comment says `"AMOUNT_TOO_SMALL"` but the assertion doesn't bind to it. |
| Audit195_Router.t.sol | WEAK | `:409` bare revert for "Arithmetic overflow" not bound; otherwise solid | Bind the panic selector or use `vm.expectRevert(stdError.arithmeticError)`. |
| Audit195_StakingCore.t.sol | REAL | `:209, :875` are intentionally bare (ownerOf reverts on burned NFT — implementation-defined) | Acceptable; comment justifies. |
| Audit195_StakingGov.t.sol | WEAK | 12× bare `vm.expectRevert()` on access-control + emergency paths (`:272,360,411,477,505,524,677,830,837,844,857,868,879`); 7× `assertGt(.,0)` | Largest concentration of bare reverts in any file. Critical governance surface. |
| Audit195_StakingRewards.t.sol | REAL | n/a | Reward-pool depletion / rewardDebt symmetry tested with exact equality. |
| Audit195_SwapFeeRouter.t.sol | WEAK | 22× bare `vm.expectRevert()` (`:236,565-654,782-794`) — covers full onlyOwner & pause surface but every revert is unmatched | Functions can be replaced with `revert();` and tests still pass. |
| AuditFixes_Other.t.sol | WEAK | Mocks ignore timestamp arg (`:63`) — see cross-file pattern | Real timestamp-keyed bugs invisible. |
| AuditFixes_Pair.t.sol | WEAK | `:201 test_router_hasNonReentrant` "verify by performing multiple swaps" with only `assertGt(amounts[1], 0)` | Comment admits "we can't directly test the nonReentrant modifier" — this is a decorative test of a security property. |
| AuditFixes_Staking.t.sol | WEAK | `:73, :128 assertGt(power, 0)` after stake; `:291` bare revert | Boost calculation correctness needs exact equality. |
| AuditFixes_SwapFeeRouter.t.sol | WEAK | `:221, :229 assertGt(amounts[last], 0)` against 1:1 mock router | Mock returns fixed output, so `>0` is trivially true. |
| CommunityGrants.t.sol | WEAK | `:374, :383` bare reverts on pause (catches `EnforcedPause` but unbound) | Otherwise good selector usage. |
| FinalAudit_AMM.t.sol | REAL | n/a | Long, exercises many invariants. |
| FinalAudit_POLPremium.t.sol | WEAK | Duplicates RedTeam_POLPremium "defended" pattern in places | See cross-file. |
| FinalAudit_Restaking.t.sol | REAL | n/a | |
| FinalAudit_Revenue.t.sol | REAL | n/a | |
| FinalAudit_Staking.t.sol | WEAK | `:867 vm.expectRevert(); // Pausable: not paused` — comment only, bare assertion | Bind `EnforcedPause()` selector. |
| FuzzInvariant.t.sol | WEAK | `:138 vm.assume(amount1Out > 0)` filters out the dust/rounding range; `:222` bare revert in firstDeposit fuzz | The interesting fuzz failures (amount1Out=0 edge) are filtered out. Invariant `_minimumLiquidityLocked` (`:336`) checks supply >= 1000 — set in setUp, so cannot break (vacuous). |
| FuzzV3.t.sol | REAL | n/a | Real fuzz against Uniswap-V3-like math. |
| GaugeCommitReveal.t.sol | REAL | n/a | Best file in suite — every revert binds a selector, replay/cross-epoch covered. |
| GaugeController.t.sol | WEAK | `:88` bare revert; `:101, :113-115 assertGt(getGaugeWeight, 0)` after vote — doesn't check vote weight is *correct*, only nonzero | Equal-stake split test (`:180`) is good; basic vote test is decorative. |
| L2Compatibility.t.sol | WEAK | `:176, :181 assertGt(power, 0)` after stake | Comment at `:111` honestly admits prior assertion used wrong uint64 bound — tests were wrong. New version uses uint48. Missing: voting-power-at-old-timestamp regression after L2 reorg. |
| MemeBountyBoard.t.sol | WEAK | `:445` bare revert | Tied-vote tie-break is not tested. |
| POLAccumulator.t.sol | WEAK | `:165, :264` bare reverts; `:204, :287 assertGt(proposedAt, 0)` | Slippage execution at exact threshold edges missing. |
| PremiumAccess.t.sol | WEAK | `:205` bare revert | NFT-flash-loan attack window (5b in RedTeam_POLPremium) is *acknowledged but not closed* — there's no failing test pinning the bug. |
| RedTeam_AMM.t.sol | REAL | n/a | Real fee-on-transfer / rebasing token attacks. |
| RedTeam_CrossContract.t.sol | WEAK | `:470` bare revert; `:836 assertGt(cachedBoosted, 0)`; mock VE returns constant power | Cross-contract racing tests rely on mocks that ignore timestamp. |
| RedTeam_POLPremium.t.sol | DECORATIVE for ATTACK 12, 13, 18, 19, 20 | `:955 assertTrue(true)` after "DEFENDED: Fee currency follows V4 unspecified-currency convention"; `:1115 assertTrue(true)` for ATTACK 18 pause-to-avoid-fees | The "DEFENDED" tests are the worst pattern — narrative, not assertion. If the defense is regressed the test still passes. |
| RedTeam_Revenue.t.sol | WEAK | Mock VE returns constant power regardless of timestamp (`:80`); reentrancy bot test asserts `assertLe(reentryCalls, 1)` which is true even if reentrancy is unprotected (calls=0 means *blocked*, calls=1 means *succeeded once*) | Wrong assertion — `assertEq(reentryCalls, 0)` would actually verify blocking. |
| RedTeam_Staking.t.sol | WEAK | `:346` bare revert; `:564, :565 assertGt(.,0)`; "INVESTIGATE" tests labeled `_DEFENDED` with no breaking probe | Race-condition test (`:555`) only asserts that bob's unsettled is `>0`, not that carol cannot claim it. |
| ReferralSplitter.t.sol | WEAK | `:169 assertGt(pending, 0)` | Self-referral / referrer-cycle edges absent. |
| RevenueDistributor.t.sol | WEAK | `:307, :378` bare reverts; `:378 assertGt(pendingWithdrawals, 0)` | Mock ETH-rejecter is good; double-claim & cross-epoch-replay missing. |
| SwapFeeRouter.t.sol | WEAK | Mock `MockUniRouter` (`:20`) returns 1:1 with no slippage → all positive-output assertions are trivially satisfied | The whole file's swap surface is tested against a no-slippage stub. |
| TegridyDropV2.t.sol | WEAK | `:481` bare revert on re-init | Mostly real; init-twice should bind `InvalidInitialization` selector. |
| TegridyFactory.t.sol | WEAK | `:134, :193 assertGt(pair.code.length, 0)` — verifies *deploy succeeded*, not that initializer wired storage | After CREATE2, also assert token0/token1/factory are set. |
| TegridyFeeHook.t.sol | REAL | n/a | Best timelock coverage in repo (selectors + cooldowns + reduction caps). |
| TegridyLPFarming.t.sol | WEAK | `:65 assertGt(effectiveBalanceOf, 0)` after stake; `:124, :195` bare reverts | Boost calculation correctness needs equality. |
| TegridyLaunchpadV2.t.sol | REAL | n/a | Fuzz `testFuzz_collectionConfig_no_panics` is well-designed. |
| TegridyLending.t.sol | REAL | `:737, :949 assertGt(.,0)` are minor | Strong interest-math + concurrent-loan coverage. |
| TegridyLending_ETHFloor.t.sol | DECORATIVE for sandwich path | `:211 test_sandwich_sameBlockManipulation_succeeds` — test asserts the **attack works**, no defending test alongside | The known sandwich vector has zero defensive coverage; the test pins the bug as a feature. Tracked in SECURITY_DEFERRED but no `assert` to fail when fix lands. |
| TegridyLending_Reentrancy.t.sol | REAL | n/a | |
| TegridyNFTLending.t.sol | WEAK | `:621, :654 assertGt(interest, 0)` — interest correctness needs equality | |
| TegridyNFTPool.t.sol | REAL | `:714, :896 assertGt(.,0)` minor | |
| TegridyNFTPoolFactory.t.sol | REAL | n/a | |
| TegridyNFTPool_Reentrancy.t.sol | REAL | n/a | Real attacker contracts, asserts attackCount. |
| TegridyNFTPool_Sandwich.t.sol | REAL | n/a | |
| TegridyPair.t.sol | WEAK | `:134, :195-196, :206, :217, :228-229, :321 assertGt(.,0)` after add/burn/swap | Reserve-equality after burn missing — `assertGt(.,0)` doesn't verify amounts. |
| TegridyRestaking.t.sol | WEAK | `:210-211, :253-254, :338-339 assertGt(.,0)` | Bonus-rate equality untested. |
| TegridyRouter.t.sol | WEAK | `:360 assertGt(amounts[1], 0)` after swap | Final-output exact-out equality should bind to `getAmountOut`. |
| TegridyStaking.t.sol | WEAK | `:65, :86, :358, :376, :415, :417 assertGt(.,0)` x6 | Voting-power-at-historical-timestamp tests assert nonzero only — exact value matters for governance. |
| TegridyTWAP.t.sol | REAL | n/a | Cumulative price equality, time-weighted math correct. |
| TegridyTokenURIReader.t.sol | REAL | n/a | Pure view layer, string-shape assertions are appropriate. |
| Toweli.t.sol | REAL | n/a | Token immutability tested via supply-after-roundtrip + selector-not-present probes. |
| VoteIncentives.t.sol | WEAK | `:571 vm.assume(amount > 1e18 && amount < 100_000e18)` discards small-amount fuzz inputs (the rounding edge) | Mocks (`MockVE/MockPair/MockFactory`) ignore real epoch-time semantics. |

## Counts

- 60 active test files (1 `.bak` excluded from runtime).
- **REAL: 17** (Toweli, GaugeCommitReveal, TegridyFeeHook, TegridyLaunchpadV2, TegridyLending, TegridyLending_Reentrancy, TegridyNFTPool_Reentrancy, TegridyNFTPool_Sandwich, TegridyTWAP, TegridyTokenURIReader, Audit195_Factory, Audit195_Pair, Audit195_StakingCore, Audit195_StakingRewards, FuzzV3, FinalAudit_AMM, FinalAudit_Restaking, FinalAudit_Revenue, RedTeam_AMM, TegridyNFTPoolFactory, TegridyNFTPool — call it **20** including borderline)
- **WEAK: 36+** (the bulk: bare `expectRevert()`, `assertGt(.,0)` only, mock-fakes-time, etc.)
- **DECORATIVE: 4** (RedTeam_POLPremium ATTACK 12/13/18 narrative tests, AuditFixes_Pair `test_router_hasNonReentrant`, TegridyLending_ETHFloor sandwich pin, Audit195_Restaking.t.sol.bak)
- **MISSING surfaces** flagged: NFT-flash-loan window, sandwich-floor, race-condition unsettled rewards, fee-currency cross-check.

## Top-5 weakest test files

1. **`RedTeam_POLPremium.t.sol`** — 5 named `_DEFENDED` tests end with `assertTrue(true)` or only emit a log line (`:955, :1099, :1115, :1136, :1179`). Removing the defense leaves these tests passing.
2. **`Audit195_StakingGov.t.sol`** — 12 bare `vm.expectRevert()` on the entire access-control + emergency-exit + reward-rate surface (`:272–:879`). 7 `assertGt(.,0)` post-stake. Largest single concentration of unbound reverts on the most safety-critical contract.
3. **`Audit195_SwapFeeRouter.t.sol`** — 22 bare `vm.expectRevert()` covering the full onlyOwner / pause surface. Functions could be replaced with `revert();` and every test still passes.
4. **`SwapFeeRouter.t.sol` + `AuditFixes_SwapFeeRouter.t.sol`** — both use `MockUniRouter` returning 1:1 fixed output. The MEV / sandwich / slippage surface is unreachable. `assertGt(amounts[last], 0)` is trivially true against a fixed-output mock.
5. **`AuditFixes_Other.t.sol` (mock layer)** — `MockVotingEscrow.votingPowerAtTimestamp(_, _)` ignores the timestamp argument (`:63`). All downstream RevenueDistributor / Grants / BountyBoard tests that flow through this mock cannot detect checkpoint-time bugs. This single mock pattern, replicated in `RedTeam_Revenue.t.sol:80`, `RedTeam_CrossContract.t.sol`, and elsewhere, makes the entire time-keyed governance test surface decorative.

## Quick-win remediation

1. Replace every bare `vm.expectRevert()` with `vm.expectRevert(<Custom>.selector)` — mechanical, catches wrong-revert regressions.
2. Replace `assertGt(x, 0)` post-action with `assertEq(x, expected)` where the math is computable in the test.
3. Make the `MockVotingEscrow.votingPowerAtTimestamp` mocks honour the timestamp arg (return checkpointed value, not live).
4. Delete `Audit195_Restaking.t.sol.bak`.
5. Replace the `_DEFENDED` narrative tests in `RedTeam_POLPremium` with assertions that *would fail* if the defense regresses (e.g. `assertEq(toweli.balanceOf(attacker), initialBalance)` after the would-be-extraction path).
6. Reword the `assertLe(reentryCalls, 1)` in `RedTeam_Revenue:361` to `assertEq(reentryCalls, 0)` — current bound passes when reentrancy succeeds once.
