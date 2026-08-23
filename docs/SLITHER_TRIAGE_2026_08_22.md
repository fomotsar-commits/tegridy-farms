# Slither triage — the 48 High/Medium findings that gate CI

Two passes, 2026-08-22. Five agents triaged all 48 against the Solidity; three more were then told to
**refute** every `FALSE_POSITIVE` verdict, because that is the verdict that makes work disappear.

## ⚠️ THE HEADLINE: DO NOT SUPPRESS. The refutation overturned the disposition.

The first pass returned **54 FALSE_POSITIVE, 2 REAL_BUT_ACCEPTED, 0 REAL_BUG** — a clean sweep, with
confident and heavily line-cited reasoning. **The refutation pass rejected 12 of those verdicts**,
including *all three* of the fee-router HIGH reentrancy findings that the first pass had argued down
most forcefully.

That gap is the entire value of this document. A clean sweep produced by careful agents, reading
real code and citing real line numbers, was still wrong about roughly a fifth of what it cleared.

### Refuted — the first pass was wrong about these

**ids 0, 3, 4, 15, 16, 19, 25, 26, 32, 33, 36, 42**

### Real defects the first pass buried under a suppression recommendation

These are pre-deploy catches. None is what the detector claimed; each was found while checking
whether the detector's claim was false.

1. **`TegridyFeeExecutorRouter.sol:253`** — the dust rule sets fee = 1 when the computed fee rounds
   to zero. If `received` (248) is 0 — a tokenIn that transfers nothing, or a 100%-fee-on-transfer
   token — line 253 computes `0 - 1` and panic-reverts. Safe direction, but it wants an explicit
   `if (received == 0) revert ZeroAmount();` and a test.
2. **`TegridyHarvestVault.sol:370 / :386`** — a **one-wei donation** floors `swapAmount` to zero and
   drives `harvest` into `NothingToCompound`. Griefable by anyone, for one wei.
3. **`RestakingMonitorView` (id 33)** — `_effectivePower` silently degrades to zero **three ways**: a
   reverting staking read, an unset `restakingContract` (**the default post-deploy state**), and a
   50,000-gas-capped restaking lookup. So `isSynced` returns **true for every un-registered
   restaker** — *"precisely the fabricated-data outcome its own natspec says it exists to prevent."*
   This is the house's cardinal sin sitting in a view contract.
4. **`TegridyFeeLocker` (id 36)** — the `amount == 0` short-circuit is where a corrupted fee delta
   becomes silent, and the delta is taken **with no reentrancy guard** against a balance pot shared
   with every other lock and every unclaimed beneficiary balance, while `currency1` is an arbitrary
   third-party ERC20 arriving through the Airlock.
5. **`NftfiPooledLendingVault.repay` (id 42)** — **not** revert-on-failure. It clamps and
   under-applies silently at `:386`, and `NftfiBnpl` has no rescue path. The safety rests on a
   two-contract arithmetic coincidence that a suppression comment would make the gate blind to.
6. **A `CLAIM_GRACE_PERIOD` contradiction** — a path blocks the staker's own `getReward()` while
   crystallising their ETH, contradicting the documented 7-day grace at `:218-221`. The test suite
   **cannot reach it** because `MockVE.userTokenId` is a public mapping that never clears and never
   reverts. Needs a human and its own PR.
7. **`WETHFallbackLib.sol:128-129`** runs on full gas against a `WETH` address the constructor never
   code-checks — contrary to that library's own warning at lines 87-88.
8. **`executePolAccumulator` (530-538)** omits the `_assertAllowable` re-assertion its sibling
   `executeAllowTarget` (453-454) performs by design.

### The group-level objection, which applies even where a verdict was right

> Landing eighteen inline suppressions would remove `uninitialized-local`, `incorrect-equality` and
> `unused-return` from the `fail-on: medium` gate across **nine contracts** — and those three are on
> `detectors_to_include`, the list `contracts/slither.config.json` itself labels *"Fund-loss detector
> class… run loud."* It would quietly undo the fix recorded at `_detectors_promoted_key_fix`, whose
> own post-mortem says the previously gutted detector set *"never bit because nothing loaded this
> file."*

**Given this repo's history of shipping gates that cannot fail, "suppress and move on" is the wrong
default here even where the underlying verdict is right.** Several of the upheld verdicts rest on
invariants — an intended sentinel, a cross-function non-empty guarantee — that belong in an
initializer or an assertion, **not in a comment above a silenced detector**.

### The tests that were supposed to back the suppressions do not all hold

An asymmetry worth naming: the HarvestVault suppressions are backed by **selector-precise reentrancy
tests with a disarmed-hook control** (`TegridyHarvestVaultReentrancy.t.sol:217-250`). The
FeeExecutorRouter ones are backed by a bare `vm.expectRevert()` **whose revert is swallowed by
`_execSwap` at line 343** — so the router's "we have a test for this" claim is itself unsound.
Every router finding needs a real guard test before anything is silenced.

### Proofs that need correcting before anyone leans on them again

Even among the 32 **upheld** verdicts, the refutation found reasoning errors:
id 40 misses a third writer of `rewards[]` at `:624` · id 38's "no caller can zero another account's
power" is **false** · id 34's "behaviourally identical" is wrong (in the safe direction) · id 7's
divergence figure is **3× high** · id 5's suppression should be replaced by the relative write
`escrowRewardsOwed[msg.sender] -= paid`.

## ▶ What to actually do

1. **Do not apply any suppression yet.** Fix the eight defects above first, each in its own PR with
   a test. Several are cheap; #3 and #5 are not, and #6 needs a human decision.
2. **Re-run Slither after the fixes.** The finding set will have moved and the remaining triage
   should be redone against the new report, not against this one.
3. **Then, for whatever genuinely survives**, prefer an assertion or an initializer over a comment.
   Reserve `// slither-disable-next-line <detector>` — with a reason, at the site, per the
   convention at `TegridyFeeExecutorRouter.sol:341` — for findings where the code truly cannot
   express the invariant.
4. ⛔ **Never** add `reentrancy-balance` or `incorrect-equality` to `detectors_to_exclude`, and
   **never** lower `fail-on` or add `continue-on-error`.

## Settled by measurement, and not in dispute

- Only **48 of 362** findings gate anything: `fail-on: medium` ignores the 200 Low and 114
  Informational. The split is 5 High / 43 Medium / 200 Low / 114 Informational.
- The **5 High** are all reentrancy, in exactly two files — `TegridyFeeExecutorRouter.sol` (3) and
  `vaults/TegridyHarvestVault.sol` (2). The 43 Medium spread across 16 files, dominated by
  `incorrect-equality` (21) and `uninitialized-local` (13).
- `contracts/slither.config.json` **does load and does work.** Zero of its 12 excluded detectors
  produced a finding, and detectors *not* on its promoted list (`costly-loop`, `cyclomatic-complexity`,
  `missing-inheritance`, `return-bomb`, `unused-state`) still fired — which disproves the failure mode
  its own comment feared, that `detectors_to_include` would silently gut the detector set.
- Its `_scope` note is **badly stale**: it names 15 in-scope contracts and 12 supposedly removed
  ones, and every file that actually fires appears on neither list. `_scope` is a comment and
  enforces nothing.
- **None of these contracts is deployed.** No finding here is live risk today; the value is catching
  a real bug at the cheapest possible moment — and this exercise caught eight.

## Reproducing

Report artifact: the `slither-report` artifact uploaded by CI run 32596140453 (head 2b8ccde8).

```
Workflow({scriptPath: ".../workflows/scripts/slither-48-triage-wf_8b438261-0c5.js",
          resumeFromRunId: "wf_8b438261-0c5"})
```

---

# Appendix A — the refutation pass, verbatim



## Refutation batch 1

I read both contracts in full, plus `WETHFallbackLib`, `TegridyRouter`, `TegridyPair`, `TimelockAdmin`, `OwnableNoRenounce`, `Toweli`, and every test the prior agent cited. Verdicts below.

---

**id 0: REFUTED** — `reentrancy-balance`, `TegridyFeeExecutorRouter.swapNative`, line 280.

The lead claim is a misreading of the line it cites. The prior agent writes that "Slither names `amountOut` as the stale variable, but `amountOut` is assigned at line 306 from `_selfBalance(tokenOut)` read AFTER the external call at 304." Line 306 is `amountOut = _selfBalance(tokenOut) - outBefore;`. `outBefore` (302) is a pre-call read and is an **operand of the value compared at 307**. The detector's premise — a balance sampled before the external call feeds a post-call condition — is literally, exactly true here. You cannot refute a premise that the code satisfies. What the agent actually demonstrated is that the *consequence* is benign, which is an accepted-risk verdict, not FALSE_POSITIVE.

Safety therefore rests entirely on one property: no re-entry. That property is real in the code — `nonReentrant` is on 240, 288, 366, 406, 417, and I confirmed OZ's `ReentrancyGuard` uses a single shared slot (`NOT_ENTERED`/`ENTERED` at ReentrancyGuard.sol:50-51). Note the agent named the wrong version: `contracts/lib/openzeppelin-contracts/package.json` says **5.6.1**, not 5.5.0.

The cited proof, however, is worthless. `test_malicious_reentrancy_reverts` (t.sol:444) uses a bare `vm.expectRevert()` with no selector, and the re-entrant revert is swallowed by `_execSwap`'s `if (!ok) revert SwapCallFailed();` (343), so the assertion only proves "the outer call reverted." Worse, the re-entrant call at t.sol:91-93 reverts *regardless of the guard*: `MaliciousAggregator` calls `router.swapERC20(tokenIn, 1, ...)` as `msg.sender`, holding no `tokenIn` and having granted the router no allowance, so `safeTransferFrom` at line 247 reverts on its own. **Delete the `nonReentrant` modifier and this test still passes.** That is precisely the shipped-gate-that-cannot-fail pattern, and it is the sole evidentiary basis offered for silencing a High.

The agent's own action text is also self-contradicting: it warns against a config-wide exclusion because that "would also silence findings 1 and 2 on TegridyHarvestVault, a different file that this triage did not examine" — while the same triage files verdicts on ids 1 and 2.

---

**id 3: REFUTED** — `reentrancy-balance`, `swapERC20`, line 229.

Same structural defect: `outBefore` (260) is an operand of the comparison at 269, so the premise holds. Same invalid test citation.

Additionally, one case the agent asserted away without checking. Its claim is that the delta necessarily excludes router holdings. `_preflight` (316-335) checks deadline, deadline-distance, `amountIn != 0`, `to != address(this)`, `allowedTarget`, `target != address(this)`, `target != tokenIn && target != tokenOut`, and the fee bounds — **it never rejects `tokenIn == tokenOut`**. With `tokenIn == tokenOut == T`, `outBefore` is read at 260, i.e. *after* the pull at 247, so the baseline silently includes the caller's own just-deposited principal rather than "the router's true holdings at entry" as claimed. I worked the arithmetic through and it still resolves to `amountOut = X - net`, so it is not a drain — but the invariant the FP verdict rests on holds by coincidence of the algebra, not by any check, and there is no test for `tokenIn == tokenOut` in the suite (test list at t.sol:180-539).

---

**id 4: REFUTED** — `reentrancy-eth`, `distributeFees`, line 366.

Much of this is sound and I re-verified it: `accumulatedETHFees = 0` at 369 precedes every call; my own grep confirms `pendingDistribution`/`totalPendingDistribution` appear only at 111, 112, 378, 379, 388, 389, 407, 409, 410, and `totalPendingDistribution` genuinely has no consumer beyond its getter; the `if (!ok)` credit cannot double-pay because a reverted `call{value:}` unwinds its own transfer along with the whole callee subtree. But two load-bearing sentences are wrong.

**(a)** "The trailing treasury leg at 399 goes through `WETHFallbackLib.safeTransferETHOrWrap` with a 30k stipend … also reentry-inert." The agent read the stipend (WETHFallbackLib.sol:56, 118) and stopped. If the raw send fails, lines **128-129** run `IWETH(weth).deposit{value: amount}()` and `IWETH(weth).transfer(to, amount)` **with all remaining gas**. And `WETH` here is a constructor parameter (191) checked only for `!= address(0)` (187) — never for code length, even though this same contract has `_assertAllowable` (483-490) enforcing exactly that on every other address it trusts. The library's own natspec spells out the requirement it is being used in violation of (WETHFallbackLib.sol:87-88): *"a malicious WETH could re-enter via deposit()."* So line 399 is a full-gas external call placed after the writes at 378/379/388/389 that slither is flagging. The guard still blocks re-entry — but the stated reason for the leg being safe is not the actual reason, and once again the actual reason is "the one guard."

**(b)** "polAccumulator is 48h-timelocked and `_assertAllowable`-gated (487)." `proposePolAccumulator` (524) does call it; `executePolAccumulator` (530-538) **does not re-assert**. Compare the sibling path, `executeAllowTarget` (453-454), which re-asserts with the explicit comment *"Re-assert at execute time (the address could have self-destructed since propose)."* The polAccumulator path has the exact staleness hole the neighbouring path documents and closes.

The agent then admits the queue path and the re-entrant-`distributeFees` path have **no tests**, and recommends suppressing today and testing later. Suppress after the tests exist, not before.

---

**id 26: REFUTED** — `incorrect-equality`, `fee == 0 && feeBps > 0`, line 252.

The core reasoning is right — this equality gates no authorization, and the `== 0` branch charges *more*. But the analysis surfaces a real defect on the flagged line and files it as noise anyway. When `received == 0` (a 100%-fee-on-transfer `tokenIn`), line 252 sets `fee = 1` and line 253 computes `0 - 1` → **Panic(0x11)**, an unnamed underflow. `_preflight` validates `amountIn != 0` (327), not `received != 0` (248) — so the contract's own deliberate FoT-safe delta accounting creates a state its arithmetic cannot express. The one-line fix the agent itself sketches (`if (received == 0) revert ZeroAmount();` after 248) is what makes the equality *provably* harmless; suppressing while leaving it in records the finding as noise when the detector's taint analysis walked past something real.

Second, unaddressed: the dust rule breaks the caller's own advertised bound. `feeBpsMax` is enforced at 334, but line 252 can raise the *effective* rate far above it — at `received == 1` with `feeBps == 25`, the effective rate is 10,000 bps against a stated ceiling of 25. Trivial in absolute value; still a bound the contract advertises and does not hold, on exactly the flagged line. The suite has a FoT test (t.sol:252) but it uses a 1% burn, so `received > 0` always; nothing exercises `received == 0` or the dust path.

---

**id 31: UPHELD** — `incorrect-equality`, `amountOut == 0`, line 353 in `_payout`.

This one refutes the premise from the code rather than from the consequence, which is the bar. `amountOut` is a `uint256`; `== 0` is bit-identical to `< 1`, and 0 is the bottom of the domain, so there is no adjacent band for an attacker to steer into — the detector's remedy (prefer a range comparison) is a literal no-op. That is a property of the type, not an appeal to detector noise. `_payout` (352-359) is internal with exactly two call sites, 271 and 309, both of which have already enforced `amountOut >= minOut` at 269/307; `_payout` writes no state, so the early return desynchronises nothing, and nothing follows either call site but the `SwapExecuted` event (272, 310). Both branches move zero tokens.

Minor correction that does not change the verdict: the guard is redundant on the ETH leg, since `WETHFallbackLib.safeTransferETHOrWrap` already short-circuits `amount == 0` at line 107.

---

**id 1: UPHELD** — `reentrancy-balance`, `TegridyHarvestVault.harvest`, line 352.

Unlike ids 0 and 3, the lead claim here is correct and the difference is decisive. `lpCompounded` is the **third return value** of `router.addLiquidity(...)` (394-403), not a delta over a pre-call read. The comparison at 404 (`lpCompounded < minLpOut`) contains no pre-call quantity at all. The reads slither cites — `pairedSide` (382) and `rewardSide` (381) — are passed *into* the call as `amountBDesired`/`amountADesired` (398/397) and never re-compared. The detector's premise is refuted on the code.

The reentrancy backstop is also genuinely proven here. `nonReentrant` is on `harvest` (354), `deposit` (262), `mint` (266), `withdraw` (270), `redeem` (274), `deployIdle` (299), `panic` (535); `TegridyRouter.addLiquidity` is independently `nonReentrant` (TegridyRouter.sol:105); `TegridyPair.mint` is `nonReentrant` (TegridyPair.sol:137) and the pair explicitly documents rejection of transfer-callback tokens (TegridyPair.sol:36-40). Critically, the vault's tests assert the **precise selector** `ReentrancyGuard.ReentrancyGuardReentrantCall` (TegridyHarvestVaultReentrancy.t.sol:217-239) *and* ship a disarmed-hook control test (243-250) proving the reverts are the guard and not harness noise. This is what id 0's evidence should have looked like and did not.

---

**id 2: UPHELD** — same function, `rewardSide` leg.

Identical disproof: `rewardSide` (381) is an input at 397, never re-compared; `lpCompounded` is the call's own return, bounded one line later at 404. One suppression above 352 covers both, as stated.

Correction to carry forward: "The reward token is Toweli, a plain OZ ERC20" is a **deploy-time property, not a code guarantee** — `rewardToken` is whatever `farm.rewardToken()` returns at construction (204-205), and the constructor never checks it. Same for `router`, verified only by `router.WETH()` succeeding (207). It does not change the verdict, because the guard argument does not depend on the token's behaviour and the reentrancy suite proves the hostile-reward-token case directly — but the sentence should not be repeated as a code fact.

---

**id 25: REFUTED** — `incorrect-equality`, `rewards == 0`, line 364.

The zero-compare argument is fine in isolation. But the agent's own analysis identifies a reachable defect on this exact line, calls it a nit, and suppresses. Trace it: an outsider can raise `rewards` but not lower it. A **1-wei TOWELI donation** when farm rewards are near zero gives `rewards = 1` → `fee = 0` (both fee gates closed by default) → `toConvert = 1` → `swapAmount = toConvert / 2 = 0` → the swap block at 371 is **skipped entirely** → `rewardSide = 1`, `pairedSide = 0` (the vault's only WETH source is the harvest swap itself, so zero is its resting state) → line 386 `revert NothingToCompound()`.

`rewards == 0` is precisely the guard that would have made this a clean no-op return, and one wei walks past it into a revert that also rolls back `farm.getReward()` at 358. A griefer can revert every keeper harvest attempt for as long as farm rewards stay under ~2 wei, at one wei of TOWELI per attempt. `test_harvest_withNoRewardsIsANoOp` (TegridyHarvestVault.t.sol:354-366) covers `rewards == 0` exactly and not `rewards == 1`, so the suite is blind to it. Apply the dust threshold the agent itself sketched, then suppress.

---

**id 32: REFUTED** — `incorrect-equality`, `toConvert == 0`, line 368.

The reachability proof is correct and I re-derived it: `MAX_PERFORMANCE_FEE_BPS = 1000` (110) < `BPS_DENOMINATOR = 10_000` (104), the cap is a `constant` in the bytecode of a non-upgradeable contract, enforced at propose (458) and re-checked against the value actually written at execute (471). So `fee <= rewards/10`, `toConvert >= 1` for all `rewards >= 1`, and `rewards == 0` already returned at 364. Line 368 is unreachable.

But that proves **dead code**, not a false positive — a different disposition, and one a human should sign off on rather than have buried in a comment. And the suppression is load-bearing on a constant nothing re-validates: the agent's own action text says *"If anyone later raises MAX_PERFORMANCE_FEE_BPS, delete the suppression and re-triage."* A `slither-disable-next-line` comment does not fail when that constant changes. Encoding a reachability proof in a comment that no check re-runs is the same shape as the three gates this repo has already shipped that cannot fail. If the branch is kept as defensive cover — and I agree it should be — the enforcement belongs in a test asserting `MAX_PERFORMANCE_FEE_BPS < BPS_DENOMINATOR`.

---

**id 34: UPHELD** — `incorrect-equality`, `fee == 0`, line 425 in `_chargePerformanceFee`.

`fee` at 424 is `(rewards * bps) / BPS_DENOMINATOR` — a pure local arithmetic result computed one line above the comparison, not a balance, not a timestamp, not a storage or external read at the comparison point. Both branches are semantically identical when `fee == 0`: the taken branch skips `totalFeesCharged += 0` (426) and a zero-value `safeTransfer` (427). There is no third behaviour to flip, which refutes the premise at premise level.

Two supporting claims I checked and confirmed: the gates are closed as shipped — neither `performanceFeeBps` nor `feeRecipient` is written in the constructor (189-227), so line 423 returns before 425 is reachable — and this function transfers only `rewardToken` (427), which the constructor forces to differ from the asset (224), so no depositor principal is reachable from either branch.

---

**id 44: UPHELD** — `unused-return`, `router.swapExactTokensForTokens`, line 378.

This is the one the brief told me to press hardest on, and it survives. The discarded return is **not** an ERC20 `bool`: `swapExactTokensForTokens` returns `uint256[] memory amounts` (interface at TegridyHarvestVault.sol:31-37; implementation at TegridyRouter.sol:223-241). The callee is not a third-party library but an in-repo contract compiled in this same build — `contracts/src/TegridyRouter.sol` — and it has **no failure return path**: `InvalidPath()` (227), `InvalidRecipient()` (228, 230, 232), `_validatePathNoCycles` (235), and decisively `if (amounts[amounts.length - 1] < amountOutMin) revert InsufficientOutputAmount();` (237). `minPairedOut` is enforced *inside* the callee, before any return value could be inspected, so the discarded value carries no failure information.

The instance checks hold too. `router` is `immutable` (119, set at 200), so it cannot be swapped for a permissive implementation post-deploy. The vault does not depend on the discarded quote: it re-reads `pairedToken.balanceOf(address(this))` at 382, a realised balance strictly stronger than the router's figure. And enforcement is proven against the production router rather than a mock — `test_harvest_respectsMinPairedOut` (TegridyHarvestVault.t.sol:402-408) asserts `TegridyRouter.InsufficientOutputAmount.selector`.

Caveat not affecting the verdict: `_router` is never verified in the constructor beyond `router.WETH()` succeeding (207), so "the callee reverts" is a property of the address the deploy script passes. A code-length check there is worth adding for the same reason `_assertAllowable` exists in the sibling contract.

---

**Summary.** I refute seven of the twelve: **ids 0, 3, 4, 26, 25, 32, and 41.** Ids 0 and 3 are refuted because the detector's premise is literally satisfied — `outBefore` (260/302) is an operand of the compared expression (269/307), so the correct verdict is accepted-risk, and the sole evidence offered, `test_malicious_reentrancy_reverts` at t.sol:444, passes with the `nonReentrant` modifier removed because the re-entrant call reverts on `safeTransferFrom` anyway. Id 4 is refuted on two falsified sentences: the `safeTransferETHOrWrap` leg is **not** stipend-bounded when the raw send fails (WETHFallbackLib.sol:128-129 runs on full gas against a `WETH` address the constructor never code-checks, contrary to that library's own warning at lines 87-88), and `executePolAccumulator` (530-538) omits the `_assertAllowable` re-assertion its sibling `executeAllowTarget` (453-454) performs by design. Ids 26, 25, and 41 are refuted because each triage identified a genuine reachable defect on the flagged line — the `received == 0` → `0 - 1` panic at 253, and the one-wei-donation grief that floors `swapAmount` to zero at 370 and drives harvest into `NothingToCompound` at 386 — and then recommended suppression before the fix and before any test covering it. Id 32 is refuted because its own proof establishes dead code, not a false positive, and pins the suppression to a constant that no check re-validates. I uphold **ids 1, 2, 31, 34, and 44**: those five refute the detector's premise from the code itself — `lpCompounded` is `addLiquidity`'s return value and not a pre-call delta (394-404); `== 0` on a `uint256` has no near-miss band at the bottom of the domain; `fee` at 425 is a pure local computed one line earlier; and `TegridyRouter.swapExactTokensForTokens` returns a `uint256[]` and reverts with `InsufficientOutputAmount` at TegridyRouter.sol:237, verified against the real router by TegridyHarvestVault.t.sol:402-408. The asymmetry is worth naming on its own: the HarvestVault suppressions are backed by selector-precise reentrancy tests with a disarmed-hook control (TegridyHarvestVaultReentrancy.t.sol:217-250), while the FeeExecutorRouter suppressions are backed by a bare `vm.expectRevert()` whose revert is swallowed by `_execSwap` at line 343 — so the five surviving suppressions all sit on the vault, and every router finding needs a real guard test before anything is silenced.


## Refutation batch 2

## Triage of the 18 FALSE_POSITIVE verdicts

Read-only throughout. No `.sol` file was edited, nothing committed, nothing pushed.

---

**id 12: UPHELD**

`C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\contracts\src\v4\TegridyFeeLocker.sol:168`

`uint256 total;` is a `+=` accumulator written at :180 and read once at :182. The loop at :170 is floored at one iteration by `if (beneficiaries.length == 0) revert NoBeneficiaries();` at :166 — that guard is in the *same function*, three lines up, so this needs no cross-contract reasoning to check. `BeneficiaryData.shares` is `uint96` (`contracts\src\v4\TegridyLiquidityMigrator.sol:63`), so a `uint256` sum cannot overflow at any array length that fits in a block. And the read is fail-closed: `total != WAD` with `WAD = 1e18` (:53) rejects the default 0 anyway. Detector premise (read at default) does not hold. Behaviour is covered by `test_rejectsSharesNotSummingToWad` (`contracts\test\v4\TegridyFeeLocker.t.sol:85`).

---

**id 19: REFUTED**

`contracts\src\v4\TegridyFeeLocker.sol:169`

The first agent's own reasoning contains the refutation: *"It is read on the first loop iteration at line 178."* That is precisely and exactly what `uninitialized-local` claims. `address previous;` is declared at :169 with no initializer and is read at :178 (`if (b.beneficiary <= previous)`) on iteration 0 before any assignment at :179 ever executes. The detector is factually correct. This is a **true positive with an intended value**, not a false positive, and the two are not interchangeable labels — one says the tool is wrong, the other says the tool is right and the author accepts it.

The distinction changes the remedy, which is the whole point. The recommended action is `// slither-disable-next-line uninitialized-local`. The correct remedy is `address previous = address(0);` — one token, zero behaviour change, removes the finding with no suppression at all, and writes the sentinel into the code instead of into a comment. Choosing suppression here keeps an implicit dependency (the zero-address rejection at :172 must stay above the sentinel comparison at :178) while silencing the only automated thing that points at the line.

I will note in fairness that the *behaviour* is well tested — `test_rejectsDuplicateBeneficiary` (:98) and `test_rejectsUnsortedBeneficiaries` (:108) both pass through this comparison. So this is a refutation of the verdict and the action, not a bug report. There is no bug here.

---

**id 17: UPHELD**

`contracts\src\v4\TegridyFeeLocker.sol:248`

I re-derived the underflow bound rather than taking it: for `i < n-1`, `distributed` sums `(amount * shares_i)/WAD` over shares totalling exactly `WAD - shares_{n-1}`, and `shares_{n-1} != 0` is forced at :173, so `distributed < amount` strictly and `amount - distributed` at :253 cannot underflow. Zero is not merely tolerated as the seed, it is what makes the remainder exact.

One correction to the record: the `n >= 1` guarantee here is **cross-function**, not local — it comes from `lockPosition`'s :166 guard plus the fact that `l.beneficiaries` is pushed only at :190, and `_credit` itself asserts nothing. I verified the chain (`collect` :209 gates on `!l.exists` at :211, `exists` is set only at :188 after the :166 check). It holds. But that is a different quality of evidence than id 12's, and a comment is a weaker place to record it than a test would be.

---

**id 13: UPHELD**

`contracts\src\RestakingMonitorView.sol:54`

Class A is correct and I checked the one way it could have been wrong: line :56 (`uint256 debt = r.totalUnforwardedBonus();`) is an external call sitting *inside the try's success block*. Solidity `try/catch` does not catch reverts raised in the success block — they propagate. So a revert there aborts the whole function rather than falling through to :59 with `available` unwritten. Either way the read at :61 is never reached at the default. Assignments at :57 and :59 are exhaustive.

I also verified the containment claim independently rather than accepting it: `RestakingMonitorView` has zero on-chain consumers. The only other mentions anywhere in `contracts\src\` are prose comments (`TegridyRestaking.sol:593`, `LaunchLockView.sol:6`) — no import, no interface declaration, no stored address. The claim is true today; it is a property of the current call graph, not of the file, so it should be re-checked if anything ever wires this view into a contract.

---

**id 14: UPHELD**

`contracts\src\LaunchRugEscrow.sol:672`

Stronger than the agent stated. The catch arm at :675-677 does not fall through — it executes `return (false, 0);` at :676. So the read at :682 is not merely *preceded by* an assignment, it is **unreachable from the catch entirely**. Only the success path at :674 reaches it. There is no path on which `live` is read at its default.

---

**id 18: UPHELD**

`contracts\src\LaunchRugEscrow.sol:685`

This is the one where a skipped loop would have been serious (`(true, 0)` = maximum breach on an unmeasured covenant, feeding `confirmCovenantBreach` at :443-445 into a seizure), so I verified reachability from scratch instead of trusting the write-up. `grep` over the file confirms `_covenants` has exactly one push site (:373), no pop, no delete, and `_publishCovenant` has exactly one caller (:358). The `h == 0` revert at :371 fires *before* the push at :373, so no Covenant can be constructed with an empty holder set; holders are pushed at :389 before the first `_readCovenantBps` call at :392. `n >= 1` at every invocation. Each balance read is separately fail-closed — a reverting `balanceOf` returns `(false, 0)` at :691 rather than skipping a holder and under-counting.

---

**id 15: REFUTED**

`contracts\src\v2\StreamingRevenueDistributor.sol:524`

Same mislabel as id 19, and here it is not arguable. `pendingWindow` is read at its zero default on **two live paths**: `totalEffectiveSupply == 0` (guard at :525 skips the assignment) and `applicable <= lastUpdateTime` (guard at :527 skips it). Both reach the read at :534. Slither has mis-modelled nothing. Compare `remaining` at :520, which carries a ternary initializer and is correctly not flagged — the detector is discriminating exactly as designed.

On substance I agree the zero is right, and I re-derived it rather than inheriting it: `_updateReward`'s empty-supply branch at :390-398 emits `RewardsForfeitedDuringEmptyPeriod` and pointedly never touches `totalStreamed`, so there is nothing owed to reserve; `totalStreamed +=` happens only in the `else if` at :399-401. I also checked the post-condition at :594 (`if (address(this).balance < reservedETH()) revert ScheduleUnfunded()`) holds immediately after a notify, since :588 sets `lastUpdateTime = block.timestamp` and drives `pendingWindow` to 0 on that path by construction.

So: no bug, but the verdict is wrong. This is an accepted true positive, and calling it a detector error is the thing that makes the accepted-risk register disappear.

---

**id 16: REFUTED — and there is a real, unrelated-to-the-detector bug underneath it**

`contracts\src\v2\StreamingRevenueDistributor.sol:436`

I concede the narrow dataflow point: `power` is assigned on both try/catch arms (:438, :440) before the read at :442, exhaustively. On the literal `uninitialized-local` question the first agent is right.

I refute the verdict package, because its `exploitPath` does not stop there — it affirmatively clears the surrounding fallback (*"The code treats that as a considered trade… `isSynced()` at 460 is provided as the gate a UI must call"*) and its `action` is "no code change." Both are wrong, and the reason is that `_effectivePower` returning 0 is **not a display concern**. It is consumed on-chain at :411 inside `_updateReward`, where it writes `effectiveBalanceOf[account]` and `totalEffectiveSupply` (:413-414). `isSynced()` is an `external view`; it cannot prevent anything. Following that consumption one function further finds this:

`_syncAndMaybeRecycle` (:490-504), reachable by **anyone** via the permissionless `sync(address)` at :468:

- :491 `_updateReward(account)` → :411 sets `effectiveBalanceOf[account] = 0` when `_effectivePower` returns 0.
- :493 `if (effectiveBalanceOf[account] != 0) return;` — no longer returns.
- :496 `if (_isRestaked(account)) return;` — `_isRestaked` returns `false` on catch (:655) and `false` when `restakingContract` is unset (:648).
- :498 `uint256 lockEnd = _lockEndOf(account);` — **`_lockEndOf` returns 0 when `userTokenId(account) == 0` (:666), and 0 on either read reverting (:674, :677).**
- :499 `if (lockEnd != 0 && block.timestamp < lockEnd + CLAIM_GRACE_PERIOD) return;` — short-circuits **false** when `lockEnd == 0`, so the grace guard is skipped entirely.
- :501-503 `rewards[account] = 0; totalForfeitedToPool += owed;` — the account's already-crystallised ETH is confiscated to the pool, permanently.

Meanwhile the victim's own escape is shut in the same state: `getReward` at :614-618 computes `inGrace = lockEnd > 0 && …`, which is `false`, and reverts `NoLockedTokens()`. **Fail-open on the confiscation path, fail-closed on the claim path.**

This needs no outage and no attacker sophistication. `contracts\src\lib\StakingRewardLib.sol:890` sets `userTokenId[from] = 0` on every outbound transfer including burn, and `TegridyStaking.sol:226` documents `0 = no position`. So the ordinary sequence — staker accrues streaming ETH, unstakes or transfers their veNFT, has not yet claimed — puts them in exactly this state, where any passer-by can zero their balance in the same block and they cannot claim it themselves. The protocol's own runbook step M5 (:165-171) instructs a keeper to sweep the staker set with `syncMany`.

This directly contradicts the documented contract at :218-221: *"crystallised accrual stays claimable for this long before `sync` may recycle it."* The 7-day `CLAIM_GRACE_PERIOD` protects only the expired-but-still-held case, where `userTokenId` is still non-zero.

The test suite cannot see it. `MockVE` (`contracts\test\v2\StreamingRevenueDistributor.t.sol:11-47`) exposes `userTokenId` as a public mapping that is never cleared and that ignores the `reverting` flag, so `_lockEndOf` always returns a real non-zero value in tests. `test_…` at :560-570 sets `ve.setReverting(true)`, syncs, and asserts `assertGt(dist.rewards(alice), 0, "accrual before the outage was lost")` — an assertion that passes only because the mock's lock-end read stays up. In production `votingPowerOf` and `userTokenId` are the same contract.

I am reporting this rather than acting on it, per the read-only scope. It is a code change for a separate PR, and it belongs to a human: the minimal fix is to make `_lockEndOf` distinguish "no data" from "no lock" (`(bool readable, uint256 lockEnd)`) and to have :499 refuse to recycle when the read was unreadable — the same pattern `LaunchRugEscrow._readCovenantBps` already uses correctly.

---

**id 21: UPHELD**

`contracts\src\TegridyLockVault.sol:204`

`received` is a delta of two self-reads (:201, :203) around the caller's own `safeTransferFrom` (:202), inside a `nonReentrant` call (:194), and every downstream write uses `received` rather than `amount` (:206, :207, :208). I checked the angle the write-up skipped: this vault commingles many locks of the same token, so `balanceOf(address(this))` is not this depositor's money. It does not matter — `withdraw` is also `nonReentrant` (:232), so no balance can leave between :201 and :203, and a balance *decrease* across the pair would underflow-panic at :203 rather than mis-credit. The zero branch reverts, so the guard fails closed.

---

**id 22: UPHELD — on a stronger proof than the one given**

`contracts\src\v2\StreamingRevenueDistributor.sol:586`

The agent argued about donation direction. The decisive argument is arithmetic, and it makes the branch unreachable rather than merely benign: `newETH >= MIN_NOTIFY_AMOUNT = 1 ether` is enforced at :573 (:211), and `duration = rewardsDuration` is bounded to `MAX_REWARDS_DURATION = 90 days` at construction (:324) and again at every timelocked change (:708). So `rewardRate = budget / duration >= 1e18 / 7_776_000 ≈ 1.29e11`, always strictly positive. `rewardRate == 0` at :586 is dead defensive code. Also worth stating plainly: the storage write at :585 preceding the revert is irrelevant — a revert rolls the whole transaction back.

---

**id 23: UPHELD**

`contracts\src\VestingFactory.sol:189`

The pre-funding concern is real in shape and neutralised by ordering: the wallet is deployed at :176-178 and `balanceBefore` is read at :186, *after* the CREATE, so anything an attacker pre-sent to the deterministic address sits in both reads and cancels out of `funded`. `totalVestedInflow[token] += funded` (:190) therefore measures this transfer and not the gift. `nonReentrant` at :156. Zero branch reverts `NoFundsReceived`.

---

**id 24: UPHELD — strongest of the set**

`contracts\src\nftfi\NftfiPooledLendingVault.sol:542`

The equality carries no protection whatsoever, so no manipulation of either operand can subvert anything: the formula at :543 is `(principal * aprBps * elapsed) / (365 days * BPS)`, which evaluates to 0 when `elapsed == 0`. Taking the branch and falling through are behaviourally identical; it is a gas short-circuit. I confirmed `lastAccrualAt` has exactly two writers, both `uint64(block.timestamp)` — loan creation at :349 and `_accrue` at :564 — so `elapsed` at :541 cannot underflow, and monotonic timestamps mean no validator nudge produces `elapsed == 0` across a real gap.

---

**id 26: UPHELD on the equality; one claim in the write-up is overstated**

`contracts\src\TegridyFeeExecutorRouter.sol:252`

The branch is the mitigation, not the defect: when `(received * feeBps) / BPS` truncates to zero it forces `fee = 1`, and `received` is itself a delta of two self-reads (:246, :248) inside a `nonReentrant` call (:240). `feeBps` is storage bounded by `MAX_FEE_BPS` and re-checked at :334. Correct verdict.

Two corrections. First, "DEFEATED" overstates it — a 1-wei floor does not price out slicing on its own; per-call gas does. That is an economic argument, not a code one, and it should be labelled as such. Second, the underflow the agent noted at :253 (`received == 0 && feeBps > 0` → `fee = 1` → `0 - 1` panics `0x11`) is real; I confirm it fails closed and moves no value. Neither point refutes the verdict.

---

**id 27: UPHELD**

`contracts\src\markets\TegridyPositionMarket.sol:490`

`owed > 0` is forced at :484, so with `paid = owed > bal ? bal : owed` at :489, `paid == 0` iff `bal == 0`. The equality protects nothing a balance nudge could subvert because the ledger is exact on every branch (:492-493). I verified the invariant the agent asserted: `escrowRewardsOwed` and `totalEscrowRewardsOwed` move in lockstep at every one of their write sites — `+=` together at :469/:470 and :524/:525, `-=` together at :492/:493, and nowhere else in the file. So `totalEscrowRewardsOwed == sum(escrowRewardsOwed)` exactly, and :493 cannot underflow. Raising `bal` by donation converts a revert into a correct partial payment at the donor's expense; lowering it is only possible by another seller claiming their own entitlement, which leaves the victim's entry fully owed.

---

**id 28: UPHELD**

`contracts\src\TegridyAirdropDistributor.sol:182`

`amount` at :181 is a raw `balanceOf` and is donatable, but the equality cannot redirect anything because there is exactly one caller and exactly one destination and they are the same address: `msg.sender != creator` reverts at :177, `block.timestamp < deadline` reverts at :179, and the transfer at :184 goes to `creator` — never to a caller-supplied address. No branch splits a non-zero balance. Flipping the comparison by donating means gifting the creator tokens.

---

**id 29: UPHELD**

`contracts\src\markets\TegridyPositionMarket.sol:589`

What protects sellers is the saturating subtraction in `surplusRewards()` at :537, not this equality, and that subtraction is sound precisely because of the lockstep invariant verified under id 27 — `totalEscrowRewardsOwed` cannot drift below the true sum of seller entries, so it cannot overstate the surplus. Because the expression already saturates at 0, `amount == 0` is exactly "no surplus." Note the agent mentions `onlyOwner` (:585) but does not lean on it; its actual argument is the subtraction, which is the right one. The prompt's warning about treating `onlyOwner` as safety does not bite here.

---

**id 30: UPHELD**

`contracts\src\AirdropFactory.sol:316`

Pure array bookkeeping with no balance, timestamp, or supply on either side. `end` is clamped to `total` at :311, so `end <= total` by construction and the equality is exact. `campaigns` is pushed only at :184 and read only at :314 — grep-verified, no pop, no delete, so `total` moves in one direction and only by a funded `createCampaign`. One thing the agent did not state and should have: `end = offset + limit` at :310 uses caller-supplied `uint256` operands, but 0.8.26 checked arithmetic makes an overflow *panic* rather than wrap to a value below `total`, so there is no way to forge a spurious `end == total`. The function is `external view` and nothing branches on the result on-chain.

---

**id 31: UPHELD**

`contracts\src\TegridyFeeExecutorRouter.sol:353`

I checked the thing the agent asserted but did not verify: `_payout` has exactly two call sites, :271 and :309, and nothing else in the file calls it. Both compute `amountOut` as their own measured delta (:268 against :260; :306 against :302) inside `nonReentrant` calls (:240, :288), and both enforce `amountOut >= minOut` at :269 and :307 *before* calling. The early return skips a zero-value transfer and is outcome-identical to falling through.

---

## Summary

I refute three of the eighteen: **15, 16, and 19**. Ids 15 and 19 are mislabels — in both, the flagged local is genuinely read at its uninitialized default on a live path (`previous` at `TegridyFeeLocker.sol:178` on loop iteration 0; `pendingWindow` at `StreamingRevenueDistributor.sol:534` whenever `totalEffectiveSupply == 0` or no time has elapsed), so Slither is factually correct and these are accepted true positives, not detector errors; for id 19 the correct remedy is `address previous = address(0);`, which costs one token and needs no suppression at all. Id 16 is the serious one: the Class A dataflow claim about `power` is correct, but the verdict's exploit analysis affirmatively cleared the surrounding fallback as a display-only "considered trade" gated by `isSynced()`, and that is wrong — `_effectivePower` returning 0 is consumed on-chain at :411, and following it into `_syncAndMaybeRecycle` shows that `_lockEndOf` returning 0 (which happens with no outage at all, whenever `userTokenId == 0`, i.e. after any staker unstakes or transfers their veNFT — `StakingRewardLib.sol:890`) short-circuits the grace guard at :499 and lets **any** caller permanently confiscate that staker's crystallised ETH at :501-503, while :617-618 simultaneously blocks the staker's own `getReward()`. That contradicts the documented 7-day `CLAIM_GRACE_PERIOD` at :218-221, and the test suite cannot reach it because `MockVE.userTokenId` is a public mapping that never clears and never reverts. That is a pre-deploy catch worth the whole exercise, and it needs a human and a separate PR.

The remaining fifteen I verified independently and upheld, several on stronger proofs than were offered (id 22's branch is arithmetically *unreachable*, not merely benign; id 24's branch is behaviourally identical to falling through; id 30 is safe against `offset + limit` overflow by 0.8.26 checked arithmetic). But one group-level objection applies to all eighteen regardless of verdict: every recommended action is an inline `slither-disable-next-line`. `contracts\slither.config.json:36` lists `uninitialized-local`, `incorrect-equality` and `unused-return` on `detectors_to_include` — the list the file itself labels the "Fund-loss detector class… run loud." Landing eighteen inline suppressions would remove exactly those detectors from the `fail-on: medium` gate across nine contracts while leaving no trace in the file that documents the gate, quietly undoing the fix recorded at `_detectors_promoted_key_fix` — a post-mortem on a previously gutted detector set that, in its own words, "never bit because nothing loaded this file." Given this repo's history of shipping gates that cannot fail, "suppress and move on" is the wrong default here even where the underlying verdict is right; ids 15, 17, 19 and 18 in particular rest on invariants (an intended sentinel, a cross-function non-empty guarantee) that belong in an initializer or an assertion rather than in a comment above a silenced detector.


## Refutation batch 3

## Verdicts

**id 32: UPHELD** — `toConvert == 0` at `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\contracts\src\vaults\TegridyHarvestVault.sol:368` is provably dead. I checked the thing the first agent only asserted: who *writes* `performanceFeeBps`. A repo-wide grep returns exactly one write site — `:472`, inside `executePerformanceFee`, immediately preceded by the cap re-check at `:471` (`if (next > MAX_PERFORMANCE_FEE_BPS) revert FeeAboveCap()`); `:466` is a read and `:422` is a read. There is no constructor assignment and `TimelockAdmin` touches no fee state. With `bps <= 1000` and `rewards >= 1` (guard at `:364`), `fee = floor(rewards*bps/10_000) <= floor(rewards/10) <= rewards - 1`, so `toConvert >= 1` on every reachable input. The detector's premise (a manipulable equality) cannot hold on an unreachable branch. The latent-hazard note is worth keeping: if the cap ever moved to 10000, this `return 0` fires *after* `_chargePerformanceFee` has already transferred at `:427` and incremented `totalFeesCharged` at `:426` — the fee-against-nothing outcome the comment at `:383-385` says the design forbids.

**id 33: REFUTED** — the FP rests on a sub-claim that the code contradicts. `_effectivePower` (`contracts/src/v2/StreamingRevenueDistributor.sol:435-453`) returns 0 in three ways that do **not** mean "this account has no power": the staking read reverting (`:439-441`), `restakingContract == address(0)` (`:447`), and the restaking read reverting *or* exceeding its `{gas: 50_000}` budget (`:448-452`). The second of those is the default state, not an edge case — `restakingContract` ships unset and needs a 48h timelock to arm (`:275-276`, `:732-744`), and the contract's own header says that without the fallback "every restaker mirrors in at zero and is silently paid nothing" (`:28-30`, `:444-446`). For any restaker in that window, `effectiveBalanceOf[account]` is 0 and `_effectivePower(account)` is 0, so `isSynced` at `:461` returns **true**. That is exactly the state the natspec at `:455-459` says must read false: "a zero from an account that has staked but never synced is an un-registered account, NOT 'no revenue yet', and rendering it as the latter is the fabricated-data failure this protocol gates against." The first agent's exploit path says the opposite in as many words ("staked but never synced — has power > 0 against a zero mirror and correctly reads false"); it checked only the never-staked `0 == 0` case and missed the degradation cases. The gas cap is not hypothetical either: `TegridyRestaking._boostedAmountAt` (`contracts/src/TegridyRestaking.sol:684-741`) does a six-slot `RestakeInfo` read, a `Trace208` `upperLookup`, and an external `staking.positions(tokenId)` call decoding an eleven-field struct — a cold-path cost in the same order as 50,000 gas. "No on-chain consumers" is true (grep finds only `contracts/test/v2/StreamingRevenueDistributor.t.sol:235-240` and a comment in `contracts/script/DeployStreamingDistributor.s.sol:47`) and it does bound the blast radius, but a view whose entire job is honesty, and which reports "synced" for the un-registered population, is a failed check, not a false positive.

**id 34: UPHELD, with a correction to the reasoning** — `fee == 0` at `TegridyHarvestVault.sol:425` is a rounding short-circuit with no protective role, so no manipulation of `rewards` changes which branch guards value: a larger `rewards` yields a larger fee, never a skipped one, and the only way into the branch is truncation. The first agent's stated reason is wrong in one detail — falling through is *not* behaviourally identical, because `SafeERC20.safeTransfer(recipient, 0)` at `:427` reverts on tokens that reject zero-value transfers. That makes the branch protective rather than dangerous, which strengthens rather than weakens the verdict.

**id 35: UPHELD, on a different ground than the one given** — `received == 0` at `contracts/src/TegridyLockVault.sol:167`. The donation-cancels argument is correct (`balanceBefore` at `:164`, `safeTransferFrom` at `:165`, `balanceAfter` at `:166`, all inside `nonReentrant` at `:145`), but the load-bearing fact is that the branch **reverts** `NoFundsReceived` and the *measured delta* — not the caller's `amount` — is what becomes the lock principal at `:175` and the `totalLocked` increment at `:177`. I checked the reentrant-donation angle the agent hand-waved: the only functions that move tokens (`lock` `:145`, `increase` `:194`, `withdraw` `:232`, `extend` `:216`) all carry `nonReentrant`; the three unguarded functions (`proposeLockOwner` `:254`, `cancelLockOwnerTransfer` `:264`, `acceptLockOwner` `:274`) move no value. There is no equality outcome that grants an advantage.

**id 36: REFUTED** — the FP is built on a premise the same agent admits it could not verify, and the code confirms the gap. `TegridyFeeLocker.collect` (`C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\contracts\src\v4\TegridyFeeLocker.sol:209`) carries **no** reentrancy guard and no access control, and neither does `claim` (`:270`). `_balanceOf` (`:319-323`) reads the contract's **total** balance in a currency — a pot commingled across every lock's undistributed fees and every beneficiary's unclaimed balance — so the delta at `:229-230` is faithful only if nothing else moves that pot during `positionManager.modifyLiquidities` at `:227`. During that call `TAKE_PAIR` (`:219`, `:225`) transfers each currency into this contract, which executes the *token's* code for an ERC20 leg; and `currency1` is the launch `asset` handed in through the Doppler Airlock (`contracts/src/v4/TegridyLiquidityMigrator.sol:313-316`, `initialize` gated only by `onlyAirlock` at `:199-200`), i.e. an arbitrary third-party ERC20, not a protocol-controlled token. A hook on that token calling `claim(currency)` for an address it controls makes the post-call balance lower than the collect implies: strictly-lower gives an underflow revert at `:229/:230` (collect DoS), and an exactly-matching claim makes `amount` zero, at which point `_credit`'s `amount == 0` at `:245` returns silently while `FeesCollected(tokenId, 0, 0)` is emitted at `:235`. Those fees are then unreachable forever — nothing in this contract can move a balance that was never credited (no sweep, no owner, no rescue). The `== 0` is the swallow point for a corrupted delta, which is the detector's premise, not its refutation. The first agent routed the delta's provenance to "needs a human on the V4 hook call path" and *in the same breath* recommended suppressing the line where the corruption goes silent. That is the gate-that-cannot-fail pattern. Consequence is griefing/stranding rather than direct theft, but the verdict is wrong.

**id 37: UPHELD** — `amount == 0` at `contracts/src/LockerClaimer.sol:207`. Verified: `revenueDistributor` is `immutable` (`:120`, set at `:146`), `_forwardETH` forwards the entire balance unconditionally, and its only callers are `claim` (`:168`, `nonReentrant`) and `forwardETH` (`:178`, `nonReentrant`). Raising the balance routes the donor's own ETH to the same fixed sink; lowering it is impossible for a third party because this function is the only ETH exit and there is no caller-supplied recipient anywhere in the file. Neither branch has a second destination, so nothing can be gained by flipping it. A failed push reverts at `:209`, so locker credit is never consumed without delivery.

**id 38: UPHELD, but one supporting claim is false** — `totalEffectiveSupply == 0` at `StreamingRevenueDistributor.sol:365` is a division guard for `:367`, and grep confirms the variable has exactly one writer, `:413` inside `_updateReward`; it is not a balance and there is no donation path into it. `== 0` and `> 0` totally partition the domain, so there is no near-miss value to engineer — the detector's premise fails. The agent's exploit path, however, asserts "no caller can zero another account's power," and that is wrong: `sync` is permissionless (`:468`) and `_effectivePower` degrades to 0 whenever the staking read reverts or `restakingContract` is unset (see id 33), so a third party can absolutely force a re-read that mirrors a live account in at zero. It does not change the verdict on *this equality* — the branch is still a correct guard, and the "unsynced accrues nothing" consequence is documented and accepted in the header at `:108-129` — but the stated proof should not be carried forward as fact.

**id 39: UPHELD** — `funded == 0` at `contracts/src/AirdropFactory.sol:195`. The ordering the argument depends on checks out: the distributor is deployed at `:177-179`, and `balanceBefore` is read at `:192` **after** that, so a pre-funded CREATE address is captured on both sides and cancels. `createCampaign` is `nonReentrant` (`:158`), so a token re-entering on `transferFrom` cannot open a second campaign mid-measure. The zero branch reverts `NoFundsReceived`, failing closed, and `funded` feeds only the event at `:197-199` — it is never written to state and never gates a transfer, so even a wrong value cannot move money.

**id 40: UPHELD, with a corrected writer set** — `owed == 0` at `StreamingRevenueDistributor.sol:495`. The conclusion holds: `rewards[account]` is contract-written state with no external write path, an attacker cannot write another account's entry, and reaching the recycle below still requires `effectiveBalanceOf[account] == 0` (`:493`), not restaked (`:496`), and past grace (`:499`), with the wei going back to the staker pool at `:502` rather than to a treasury. But the enumeration is wrong: there are **three** writers, not two — `:407`, `:501`, and `:624` (`rewards[msg.sender] = 0` inside `getReward`), which the agent missed. All three are in-contract and self-scoped, so the verdict survives; the proof as written does not.

**id 5: UPHELD, but the recommended action is wrong** — `claimEscrowRewards` at `contracts/src/markets/TegridyPositionMarket.sol:482`. I re-ran the enumeration the FP depends on rather than trusting it. A repo-wide grep for `escrowRewardsOwed` returns, in this contract, only `:180` (declaration), `:469` (in the `private` `_release`), `:492` (here), and `:524` (in `kickEscrowed`) — the hits in `contracts/src/TegridyLending.sol` are a separately-declared mapping in a different contract. `_release` is `private` and reachable only from `cancel` (`:324`) and `fill` (`:354`), both `nonReentrant`; `kickEscrowed` (`:516`) and this function (`:482`) both carry it; and OZ `ReentrancyGuard` is genuinely in the chain (import at `:4`, inherited at `:118`), so the lock is contract-wide and is held across the call at `:486`. There is no `delegatecall` in the file. So the pre-call read at `:483` cannot go stale, and the only unguarded reader is the compiler-generated getter for the public mapping — a view, which matches the finding's own cross-function list naming only the declaration and no function. The exploitability premise fails. What I do not accept is the proposed disposition: the stale-read-plus-absolute-write shape (`escrowRewardsOwed[msg.sender] = owed - paid`) is only safe because three separate modifiers stay where they are, and a `slither-disable-next-line` blinds the gate to the exact regression that would break it. Changing `:492` to the relative form `escrowRewardsOwed[msg.sender] -= paid` removes the finding with no suppression and no dependence on that invariant.

**id 6: UPHELD** — `contracts/src/nftfi/NftfiBnpl.sol:232/235`. The arithmetic is exact, and I checked it against the money path rather than taking it on trust. With `financedWei = 3q + r`, `r ∈ {0,1,2}`, the loop at `:234-237` produces legs `q`, `q`, `financedWei - 2q = q + r`, summing to `financedWei` for every `r`. `openPlan` stores `principalPerInstalment = financedWei / INSTALMENTS` — the same `q` — at `:303`, and `payInstalment` pays legs 1 and 2 at `q` and the final leg at `principalDue` (`:325`), which is `q + r`. Quote and money path agree, and hoisting the multiplication would move the remainder off the final instalment and desynchronise them. This is the remainder-correction idiom, not precision loss; the detector's premise does not hold.

**id 7: UPHELD, with the arithmetic corrected** — same division at `:232`, reported through `:236`. Note `:236` itself is correctly shaped (all multiplications before the single division). The divergence from exact rational thirds is `ΔW = r` in principal×interval units, i.e. `r * apr * INSTALMENT_INTERVAL / (365 days * BPS)` — at the repo's pinned `aprBps = 1500` (back-solved from `contracts/test/nftfi/NftfiBnpl.t.sol:86-91`) and worst case `r = 2` that is `2*1500*2592000 / (31536000*10000) ≈ 0.025 wei`, not the 0.074 wei quoted (the agent weighted the residue at `k=3` rather than at one interval). The error is in the conservative direction and both figures are sub-wei. More decisively, `interestWei` moves no money: its one on-chain consumer is `openPlan` at `:266`, which destructures `(depositWei, financedWei, originationWei,,)` and discards it; every actual charge is recomputed live from `vault.quoteRepay` at `:321`.

**id 42: REFUTED** — `vault.repay(p.loanId, paid)` at `NftfiBnpl.sol:332`. The prompt's own test settles this: **the callee is not revert-on-failure.** `NftfiPooledLendingVault.repay` (`C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\contracts\src\nftfi\NftfiPooledLendingVault.sol:380-403`) clamps at `:386` — `paid = amount > due ? due : amount` — and then pulls only `paid` at `:387`. It applies less than it was handed, silently, and the discarded return is the sole signal that it did. The invariant does hold today: `quoteRepay` at `:409-413` folds in `_pendingInterest`, `_accrue` at `:383` folds in the identical term off the identical storage at the identical timestamp, so `due == principalDue + interestDue`, and `principalLeg` is clamped to `principalDue` at `NftfiBnpl.sol:326` — I verified each link. But "provable today across two contracts" is not the same as "the detector is wrong." The consequence if the invariant ever breaks is permanent: I read `NftfiBnpl.sol` end to end and there is no sweep, rescue, or owner withdrawal anywhere in the file, so stranded WETH stays stranded. The first agent's own preferred action was a code change (capture the return, revert on mismatch) — which is inconsistent with a FALSE_POSITIVE verdict, because the verdict licenses the suppression alternative it offered instead. Take the one-comparison check; do not suppress.

**id 43: UPHELD, and the host-side re-check is verified in code, not from the comment** — `(uint256 tokenId,,,,,) = restaking.restakers(_restaker)` at `contracts/src/TegridyRestakingAdmin.sol:213`. `RestakeInfo` really does have six fields (`TegridyRestaking.sol:140-150`), `unsettledSnapshot` really is documented as permanently 0 post-fix (`:146-149`), and `tokenId` is bound and used at `:214`. There is no ERC-20 success bool and no amount here — a public-mapping getter cannot fail, and Slither's `unused-return` flags every index of a tuple that is not unpacked, so `(uint256 tokenId,,,,,)` is unavoidably reported no matter how it is written. I did not take the natspec's word on the execute-time re-check: `TegridyRestaking.applyAttributeStuckRewards` at `:1885-1898` re-reads `restakers[_restaker].tokenId == 0` and recomputes the unattributed cap from `rewardToken.balanceOf(address(this))` against `totalUnforwardedBase + totalActivePrincipal + totalPendingUnsettled` before crediting. The propose-side read is genuinely advisory.

**id 44: UPHELD** — `router.swapExactTokensForTokens(...)` at `TegridyHarvestVault.sol:378`. The enforcement claim checks out at the cited lines: `contracts/src/TegridyRouter.sol:236-237` computes `amounts = getAmountsOut(amountIn, path)` and reverts `InsufficientOutputAmount()` if the last element is below `amountOutMin`, **before** any transfer at `:238`. So the callee reverts rather than returning short, and there is no partial-fill concept — `_swap` moves exactly the amounts it validated. Independently, the vault does not need the figure: it re-reads realised balances at `:381-382` and takes its actual bound on the LP minted at `:404` (`if (lpCompounded < minLpOut) revert SlippageTooHigh()`), which is strictly more truthful than a returned quote. The router is `immutable` (`:119`, assigned `:200`) and cross-checked at construction against the LP's two legs (`:207-220`), so it is not an owner-swappable target. The one caveat worth recording is that the constructor check only proves `router.WETH()` matches a pair leg — it does not prove the router enforces its own `amountOutMin` — so this verdict is contingent on the deployer wiring `TegridyRouter`, which is a deploy-time trust assumption rather than an attacker-controlled surface.

## Summary

I refuted three of the fifteen: **33, 36, and 42**. Id 33 because `_effectivePower` silently degrades to zero in three ways — a reverting staking read, an unset `restakingContract` (the default post-deploy state), and a 50,000-gas-capped restaking lookup — so `isSynced` returns *true* for every un-registered restaker, which is precisely the fabricated-data outcome its own natspec says it exists to prevent; the first agent's exploit path asserts the opposite. Id 36 because the `amount == 0` short-circuit is the point at which a corrupted fee delta becomes silent, and the delta is taken with no reentrancy guard against a balance pot shared with every other lock and every unclaimed beneficiary balance, while `currency1` is an arbitrary third-party ERC20 arriving through the Airlock — the same agent conceded it could not clear that path and recommended suppression anyway. Id 42 because `NftfiPooledLendingVault.repay` is not revert-on-failure — it clamps and under-applies silently at `:386`, `NftfiBnpl` has no rescue path, and the safety rests on a two-contract arithmetic coincidence that a suppression comment would make the gate blind to; the fix the first agent listed as "preferred" is the right disposition and is incompatible with the verdict it filed. The other twelve survive scrutiny, though several proofs need correcting before anyone leans on them again: id 40 misses a third writer of `rewards[]` at `:624`, id 38's "no caller can zero another account's power" is false, id 34's "behaviourally identical" is wrong in the safe direction, id 7's divergence figure is 3× high, and id 5's suppression should be replaced by the relative write `escrowRewardsOwed[msg.sender] -= paid`.


---

# Appendix B — the first pass, verbatim


> ⚠️ Twelve of the verdicts below were **refuted**: ids 0, 3, 4, 15, 16, 19, 25, 26, 32,
> 33, 36, 42. Read Appendix A before acting on any of them.


## Group: `fee-router-HIGH`

All 5 findings in contracts/src/TegridyFeeExecutorRouter.sol are FALSE_POSITIVE, each disproved from code rather than from "slither is noisy". The disproofs rest on three facts I verified rather than assumed:

(1) The reentrancy guard actually covers the flagged paths. I enumerated the contract's ENTIRE external/public surface (grep, 25 declarations). Every state-mutating, value-touching entrypoint — swapERC20 (240), swapNative (288), distributeFees (366), withdrawPendingDistribution (406), sweepTokenFee (417) — carries `nonReentrant`. Everything else is onlyOwner, onlyPauseGuardian, or `acceptOwnership` (pendingOwner-gated via OZ Ownable2Step, and it touches only timelock slots). The only ungated entrypoint is `receive()` at line 214, whose body is empty. The installed guard is OZ v5.5.0 storage ReentrancyGuard (contracts/lib/openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol) — ONE shared slot, so cross-function re-entry between any two of those five is impossible, not merely same-function re-entry.

(2) The `bytes swapData` / caller-supplied-target concern — which the task rightly flags as the strongest reason to believe these findings — does not produce a reentrancy path here, because `target` is not free: it must be on a 48h-timelocked allowlist (329), may not be the router (332), may not be tokenIn or tokenOut (333), and `_assertAllowable` (483-490) forbids WETH / revenueDistributor / treasury / polAccumulator. A hostile allowlisted target can still be handed arbitrary calldata, but every door it could knock on is locked by (1).

(3) On the two balance-delta findings, slither's own text names `amountOut` as the "stale variable". It is not stale: it is computed at 268/306 from a balance read taken AFTER the external call at 264/304. `outBefore` (260/302) is a deliberate pre-call baseline. That is the recommended DEFENSE against balance manipulation, and the detector has flagged the defense as the bug.

Two residual issues I am recording rather than burying, because neither is what the detector claims and neither should be silently absorbed by a suppression comment:
  - ADJACENT (liveness, fail-closed): the dust rule at 252 sets fee = 1 when the computed fee rounds to zero. If `received` (248) is 0 — a tokenIn that transfers nothing, or a 100%-fee-on-transfer token — line 253 computes `0 - 1` and panic-reverts. Safe direction, but it deserves a test, and an explicit `if (received == 0) revert ZeroAmount();` after 248 would make the failure legible. Not a fix I applied (read-only) and not a gate item.
  - ACCEPTED-BY-DESIGN (worth a human eye before deploy, but not a reentrancy): because swapData is opaque, the measured output delta will also capture any tokenOut that happens to be sitting idle in the allowlisted aggregator if the calldata can be shaped to send it here. That is a drain of the AGGREGATOR's dust, not of this router, and it is inherent to the arbitrary-calldata design the contract documents at 21-41. I flag it so the FALSE_POSITIVE verdicts are not read as "this contract has no arbitrary-calldata risk".

On the gate: the honest fix is five per-line suppressions with the reason at the code site (the file already uses this convention at line 341), NOT adding reentrancy-balance or incorrect-equality to slither.config.json's `detectors_to_exclude`. A global exclusion would also silence reentrancy-balance on TegridyHarvestVault (findings 1 and 2), which is a different file, a different group, and unexamined by me. Note also that `reentrancy-balance` reaches CI only via `exclude_high: false` — it is absent from the config's `detectors_to_include` promoted list.

Deployment context confirmed relevant: nothing here is live, so none of this is standing risk; the value was in checking before deploy, and the check came back clean on these five.

### [FALSE_POSITIVE] `reentrancy-balance` — contracts/src/TegridyFeeExecutorRouter.sol:280  _(if real: high)_

**Reasoning.** The detector's premise — that the value in the post-call condition is stale — is contradicted by the source. Slither names `amountOut` as the stale variable, but `amountOut` is assigned at line 306 from `_selfBalance(tokenOut)` read AFTER the external call at 304, then compared at 307. `outBefore` (302) is the pre-call baseline of a delta, which is the standard defense against exactly this class, not an instance of it. Independently, the callee cannot mutate router state at all during the call: swapNative is `nonReentrant` (288), and the guard is OZ v5.5.0 storage ReentrancyGuard (contracts/lib/openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol) with a SINGLE shared slot, so it locks swapERC20 (240), distributeFees (366), withdrawPendingDistribution (406) and sweepTokenFee (417) too. I enumerated the full external surface: the remainder are onlyOwner/onlyPauseGuardian or pendingOwner-gated acceptOwnership (573); the only ungated entrypoint is the empty `receive()` at 214. CEI already holds — `accumulatedETHFees += fee` at 298 precedes the call at 304. Also note line 292 rejects `tokenOut == ETH`, so `_selfBalance` (346-348) resolves to an ERC20 `balanceOf`, never `address(this).balance`, in this function. The re-enter-mid-swap path is exercised by test_malicious_reentrancy_reverts at contracts/test/TegridyFeeExecutorRouter.t.sol:444 with the MaliciousAggregator Reenter mode at t.sol:90-93.

**Why no exploit path.** No path exists. A profitable re-entry needs one of two things. (a) Mutate router state during _execSwap: impossible — every mutating entrypoint (240, 288, 366, 406, 417) is nonReentrant under one shared OZ guard, the rest are owner/guardian/pendingOwner gated, and receive() at 214 has an empty body. (b) Make the baseline `outBefore` (302) read low so the delta over-counts tokenOut the router already holds: impossible — 302 executes before any external call in the frame, so it captures the router's true holdings at entry and the delta necessarily excludes them. Inflating the post-call read at 306 is possible only by actually sending tokenOut in, which pays the recipient with the sender's own tokens — a donation, not a theft. A malicious caller-supplied tokenOut with a lying balanceOf gains nothing either: _payout (352-358) transfers only tokenOut itself, so a fake balance produces a fake transfer of the attacker's own worthless token while their msg.value is consumed.

**Action.** No code change. Suppress at the finding site with the file's existing convention (see line 341). Insert immediately ABOVE the `function swapNative(` declaration at line 280:
// slither-disable-next-line reentrancy-balance
Reason line to put above it: `outBefore` at 302 is a deliberate pre-call baseline and `amountOut` at 306 is read AFTER the call, so the compared value is fresh; re-entry is additionally impossible because every state-mutating entrypoint shares one OZ nonReentrant guard. Do NOT add reentrancy-balance to detectors_to_exclude in contracts/slither.config.json — that would also silence findings 1 and 2 on TegridyHarvestVault, a different file that this triage did not examine.

### [FALSE_POSITIVE] `reentrancy-balance` — contracts/src/TegridyFeeExecutorRouter.sol:229  _(if real: high)_

**Reasoning.** Same structural disproof as id 0, on the ERC20 leg. `amountOut` is assigned at 268 from a balance read taken AFTER the call at 264 and compared at 269; `outBefore` (260) is the pre-call baseline. swapERC20 is `nonReentrant` (240) under the same single-slot OZ v5.5.0 guard, so no router state can change during _execSwap. CEI holds: `accumulatedTokenFees[tokenIn] += fee` at 255 precedes the call. Two extra facts specific to this path that I checked because they are the ones that would matter: (i) the approval window at 263-266 grants the spender exactly `net` via forceApprove and resets to 0 with an explicit `ResidualAllowance` assertion, so a hostile allowlisted spender can pull at most `net` and cannot reach `accumulatedTokenFees[tokenIn]` sitting in the same balance — covered by test_malicious_drainOtherToken_reverts (contracts/test/TegridyFeeExecutorRouter.t.sol:419-441, which asserts `router balance untouched`) and the OverPull mode at t.sol:83-85; (ii) swapERC20 is non-payable, so when `tokenOut == ETH` the baseline at 260 is not polluted by msg.value, and because the baseline already includes accumulatedETHFees and totalPendingDistribution, the ETH delta cannot reach queued or accrued protocol ETH.

**Why no exploit path.** No path exists. To steal, a re-entering callee would have to either mutate router state mid-call (blocked: 240/288/366/406/417 all nonReentrant on one shared slot; everything else owner-, guardian-, or pendingOwner-gated; receive() at 214 empty) or depress the baseline at 260 (impossible: it is read before any external call in the frame). Pulling more than the scoped approval fails because forceApprove(spender, net) at 263 is exact and 266 asserts zero residual. Setting tokenOut to a token the router holds fees in gains nothing, because those holdings are inside `outBefore` and therefore excluded from the delta; and the only way to raise the post-call read is to genuinely send tokenOut in. Recorded separately and NOT covered by this suppression: because swapData is opaque, the delta can also capture idle tokenOut held by the allowlisted aggregator — that drains the aggregator, not this router, and is an accepted consequence of the design documented at lines 21-41.

**Action.** No code change. Insert immediately ABOVE the `function swapERC20(` declaration at line 229:
// slither-disable-next-line reentrancy-balance
Reason line to put above it: `outBefore` at 260 is a pre-call baseline and `amountOut` at 268 is read AFTER the call, so the compared value is fresh; re-entry is blocked by the single shared OZ nonReentrant guard and the spender's allowance is scoped to `net` and zero-asserted at 266. Keep the suppression per-line rather than config-wide, for the reason given on id 0.

### [FALSE_POSITIVE] `reentrancy-eth` — contracts/src/TegridyFeeExecutorRouter.sol:366  _(if real: high)_

**Reasoning.** I treated this as the one to be most sceptical of dismissing and worked the three shapes that would make it real; all three are closed in code. First, the fund-bearing slot is already CEI-clean: `accumulatedETHFees` is zeroed at 369 before any call at 376/386/399. Second, the two slots slither names as cross-function-reentrancy targets have a fully enumerable footprint — a grep over the file shows `pendingDistribution` and `totalPendingDistribution` appear only at 111, 112, 378, 379, 388, 389, 407, 409, 410. The only reader is withdrawPendingDistribution (406), which is itself `nonReentrant` and zeroes at 409 before sending at 411; `totalPendingDistribution` is consumed by NOTHING except its public getter — no solvency check, no access decision — so even a momentarily stale value has no consumer to mislead. Third, the credit at 378/388 sits inside `if (!ok)`, and a reverted `call{value:}` also reverts its value transfer, so queued wei is exactly wei that stayed in the contract; a push-and-queue double credit is not constructible. Trust of the callees is bounded too: revenueDistributor and treasury are immutable (61-62), polAccumulator is 48h-timelocked and `_assertAllowable`-gated (487) so it can never be the router, WETH, revenueDistributor or treasury. The 50k stipends (376, 386) leave enough gas to ATTEMPT a re-entry, but the shared guard turns the attempt into `ok == false`, i.e. the recoverable pull queue. The trailing treasury leg at 399 goes through WETHFallbackLib.safeTransferETHOrWrap with a 30k stipend and a canonical-WETH wrap fallback (lib/WETHFallbackLib.sol:106-132) — also reentry-inert.

**Why no exploit path.** No path exists. (i) Re-enter distributeFees to spend accumulatedETHFees twice: blocked twice over — the slot is already 0 at 369 before the first external call, so the re-entrant frame would hit `revert ZeroAmount()` at 368 even if the nonReentrant guard at 366 did not revert it first. (ii) Re-enter withdrawPendingDistribution to pull a queued amount twice: blocked by nonReentrant (406) and by the zero-before-send at 409-411. (iii) Obtain both the ETH push and the queue credit for the same wei: unreachable, because the credit at 378/388 is inside `if (!ok)` and a failed `call{value:}` unwinds its own value transfer. The best a hostile revenueDistributor or polAccumulator can achieve is to force its own share into pendingDistribution and then collect it via withdrawPendingDistribution — an extra self-inflicted step, no loss to any party. Cross-function reach is also empty in the general case: the full external surface is five nonReentrant functions, the owner/guardian admin set, pendingOwner-gated acceptOwnership (573), and an empty receive() (214).

**Action.** No code change. Insert immediately ABOVE the `function distributeFees()` declaration at line 366:
// slither-disable-next-line reentrancy-eth
Reason line to put above it: accumulatedETHFees is zeroed at 369 before any external call, the post-call writes at 378/379/388/389 are reachable only when the value transfer itself reverted, and the only reader of those slots (withdrawPendingDistribution, 406) shares the same single-slot OZ nonReentrant guard. Recommended alongside the suppression, as tests not code: assert the queue path with a receiver that reverts, and assert that a receiver which re-enters distributeFees produces `ok == false` plus a correct pendingDistribution credit — the existing suite covers swap-path re-entry but not this one.

### [FALSE_POSITIVE] `incorrect-equality` — contracts/src/TegridyFeeExecutorRouter.sol:229  _(if real: medium)_

**Reasoning.** The flagged node is `if (fee == 0 && feeBps > 0) fee = 1;` at 252. The detector's premise is that a strict equality on a balance-derived value lets an attacker flip a security check. The taint half is real — `fee` at 251 derives from `received` (248), a genuine balance delta — but there is no check to flip. Both branches charge the caller, and the `== 0` branch charges MORE: it rounds a fee that divided to zero up to the 1-wei dust minimum. There is no zero-fee branch to steer into; the only way to leave 253 with fee == 0 is `feeBps == 0`, an owner-set global (86, settable only via setFeeBps at 430-434 under MAX_FEE_BPS), which no caller can influence. Downstream, `fee` feeds exactly two things — `accumulatedTokenFees[tokenIn] += fee` (255) and `net = received - fee` (253) — neither of which is a privileged decision. The identical construct at 295 in swapNative was not flagged, which is consistent with the taint being the only thing the detector saw.

**Why no exploit path.** No path exists. Flipping the equality in either direction still charges the caller: fee == 0 leads to fee = 1 at 252, fee > 0 leaves the computed fee standing. Manipulating `received` (248) to drive the division to zero therefore makes the attacker pay 1 wei instead of 0 — the opposite of a bypass — and buys no state change anywhere else. The one edge worth recording is liveness rather than loss, and it is fail-closed: if `received` is 0 (a tokenIn that transfers nothing, or a 100%-fee-on-transfer token), the dust rule sets fee = 1 and line 253 computes `0 - 1`, which panic-reverts under 0.8 checked arithmetic. No value moves.

**Action.** No code change required for the finding. Insert immediately ABOVE line 252 (the `if (fee == 0 && feeBps > 0) fee = 1;` statement):
// slither-disable-next-line incorrect-equality
Reason line to put above it: this equality selects the 1-wei dust minimum rather than gating any security check — the `== 0` branch charges more, not less, and reaching a zero fee requires feeBps == 0, which only the owner sets. If the suppression does not take at the statement, move the same comment above the `function swapERC20(` declaration at line 229, which is where slither anchors the finding. Separately, and optionally: adding `if (received == 0) revert ZeroAmount();` after line 248 would turn the received==0 underflow into a named revert instead of a panic. That is a readability hardening, not a gate item, and I did not apply it (read-only triage).

### [FALSE_POSITIVE] `incorrect-equality` — contracts/src/TegridyFeeExecutorRouter.sol:352  _(if real: medium)_

**Reasoning.** The flagged node is `if (amountOut == 0) return;` at 353, the first line of _payout (352-359). On a uint, `== 0` is exactly `< 1`; the detector's usual remedy — prefer a range comparison over a strict equality so an attacker cannot steer a value to just miss it — is a no-op here, because 0 is the bottom of the domain and there is no adjacent band to land in. The guard is an early return on a zero-value transfer, not an authorization or accounting check. I checked both call sites: _payout is invoked only at 271 and 309, in each case after the caller has already enforced `amountOut >= minOut` (269, 307), and in each case nothing follows the call except the SwapExecuted event — so the early return skips no bookkeeping and cannot desynchronise state. Reaching amountOut == 0 at all requires the caller to have supplied minOut == 0.

**Why no exploit path.** No path exists. The equality decides only whether a transfer of zero is executed or skipped; both branches move zero tokens. The taken branch avoids a pointless SafeERC20 transfer (and avoids reverting on the tokens that reject zero-value transfers); the untaken branch would transfer zero. An attacker who drives amountOut to 0 receives nothing while their input has already been spent — self-harm — and can only get there by passing minOut == 0 themselves, since 269 and 307 would otherwise revert with InsufficientOutput. No counter, flag, or balance elsewhere in the router is written by _payout, so skipping it leaves nothing inconsistent.

**Action.** No code change. Insert immediately ABOVE line 353 (the `if (amountOut == 0) return;` statement inside _payout):
// slither-disable-next-line incorrect-equality
Reason line to put above it: on a uint, `== 0` is identical to `< 1`, so there is no near-miss band to manipulate; this is an early return on a zero-value transfer, and both call sites (271, 309) have already enforced amountOut >= minOut with no bookkeeping after the call. If the suppression does not take at the statement, move the same comment above the `function _payout(` declaration at line 352.


## Group: `harvest-vault`

All 8 findings in contracts/src/vaults/TegridyHarvestVault.sol clear. No code change recommended; 8 targeted suppressions across 6 sites (the two HIGHs share one directive). I edited nothing, committed nothing, pushed nothing.

WHY THE TWO HIGHs COLLAPSE. They are one detector mis-attribution reported twice (once per pre-call balance read). The detector names `lpCompounded` (line 404) as a stale variable carrying a pre-call balance. It is not — `lpCompounded` is the third return value of the very call at lines 394-403, assigned when that call returns. The pre-call reads it points at, `rewardSide` (381) and `pairedSide` (382), are never compared after the call; they are passed INTO `addLiquidity` as amountADesired/amountBDesired (397-398), which is the correct use of a live balance. Structurally there is also no reentrancy window: `harvest` is nonReentrant (354) and so is every other value-moving entry point — deposit 262, mint 266, withdraw 270, redeem 274, deployIdle 299, panic 535 — all sharing one OZ ReentrancyGuard status word. The only unguarded state writers are onlyOwner admin/timelock setters and inherited ERC20 share transfers, none of which touch `totalAssets()` (241-243 = live LP balance + farm.rawBalanceOf), and the vault caches no share price anywhere. TegridyRouter.addLiquidity is itself nonReentrant (contracts/src/TegridyRouter.sol:105). And this is not theory: contracts/test/vaults/TegridyHarvestVaultReentrancy.t.sol:217-239 arms a reward token with a transfer hook that re-enters harvest() and deposit() mid-harvest and asserts ReentrancyGuardReentrantCall on both, with a disarmed control case at 243-251.

WHY THE FOUR incorrect-equality FINDINGS COLLAPSE. All four are `== 0` on a uint256. The hazard this detector models is `==` against a target an attacker can land on exactly, flipping a branch; against zero on an unsigned value `== 0` is bit-identical to `<= 0` and there is no near-miss band. Direction also matters: an attacker can only raise the vault's token balances (donate), never lower them, and the reward token is Toweli — a plain OZ ERC20 whose only override is a mint-lock in `_update` (contracts/src/Toweli.sol:123-129), so no fee-on-transfer or rebase can move a balance silently.

WHY THE TWO unused-return FINDINGS COLLAPSE. The parent's specific worry was an ignored ERC20 success bool. Neither is one. `swapExactTokensForTokens` returns `uint256[] memory amounts` and `addLiquidity` returns a `(uint256,uint256,uint256)` tuple whose load-bearing component IS captured. Every ERC20 movement in harvest that could silently fail does check: the fee transfer uses SafeERC20 `safeTransfer` (427), approvals use `forceApprove`.

OBSERVATIONS SLITHER DID NOT RAISE — none blocking, all worth a human's eye before deploy:
1. The `NothingToCompound` branch (386) has no test. Related liveness nit: when farm rewards are zero but a 1-wei reward-token donation sits in the vault and the paired balance happens to be zero, line 364's intended `return 0` no-op becomes a revert at 386. Wasted keeper gas, no fund impact, self-clearing on the next real harvest. A dust threshold instead of `== 0` at 364 would close it.
2. `rewards` at 363 is the whole balance, so reward-token residue rolled over from a prior harvest is fee-charged again on each subsequent harvest. Geometric decay on dust, not a loss path, but the natspec at 360-362 calls the residue "yield" without noting the repeat fee.
3. The entire economic protection of harvest rests on keeper-supplied `minPairedOut`/`minLpOut`; a keeper passing (0,0) can be sandwiched, since the per-leg minimums at 399-400 are deliberately zero. Documented as an accepted trust assumption at 339-351 — confirm contracts/TRUST_ASSUMPTIONS_MVP.md names it.

TWO PROCESS CAVEATS, stated so nothing here becomes another gate that cannot fail:
- Scope: TegridyHarvestVault.sol appears on NEITHER list in contracts/slither.config.json `_scope`. I treated that comment as stale and relied on none of it, and none of the `detectors_to_exclude` rationale (which cites files that are not this one) fed any verdict above.
- Detector name: `reentrancy-balance` is not among the reentrancy detectors in the config's `detectors_to_include` (which lists reentrancy-eth/no-eth/benign/events/unlimited-gas); it runs only because `exclude_high: false` lets defaults through. It appears 4x in the raw slither-report.json. Before trusting the suppressions I recommend, re-run slither locally with them in place and confirm the finding count actually drops — do not assume the pinned version honours `slither-disable-next-line reentrancy-balance` for that check name. A suppression that silently does nothing is the same failure mode as the echo-satisfied CI check.

### [FALSE_POSITIVE] `reentrancy-balance` — contracts/src/vaults/TegridyHarvestVault.sol:352  _(if real: high)_

**Reasoning.** The detector's premise is that `lpCompounded` at line 404 is a stale value read before the external call. Read the assignment: `(,, lpCompounded) = router.addLiquidity(...)` spans lines 394-403 — lpCompounded IS the third return value of that call, written when it returns, so it cannot be stale with respect to it. The pre-call read the detector cites, `pairedSide = pairedToken.balanceOf(address(this))` (382), is never compared after the call; it is passed into addLiquidity as amountBDesired at line 398. Independently, no reentrancy window exists at all: harvest is nonReentrant (354), as are deposit (262), mint (266), withdraw (270), redeem (274), deployIdle (299) and panic (535) — one shared OZ ReentrancyGuard word covers every value-moving path. Unguarded functions are only onlyOwner admin/timelock setters and inherited ERC20 share transfers; none touch totalAssets() (241-243, a live read of LP balance + farm.rawBalanceOf), and no share price is cached. TegridyRouter.addLiquidity is itself nonReentrant (contracts/src/TegridyRouter.sol:105).

**Why no exploit path.** No path exists. An exploit would need a callback fired during addLiquidity that changes the vault's paired-token balance or its share accounting between line 382 and line 404. Re-entering any vault function that moves value reverts on the shared guard; re-entering the router reverts on the router's own guard (TegridyRouter.sol:105); a reentrant share transfer changes neither totalSupply nor totalAssets, so it cannot shift the harvest math. Even granting a mid-call balance drop, TegridyRouter pulls with safeTransferFrom (TegridyRouter.sol:126-127) and requires liquidity > 0 (129) — the vault reverts rather than under-accounting. contracts/test/vaults/TegridyHarvestVaultReentrancy.t.sol:229-239 drives exactly this shape (reward token with a transfer hook re-entering deposit during harvest) and asserts ReentrancyGuardReentrantCall.

**Action.** No code change. Add immediately above `function harvest(uint256 minPairedOut, uint256 minLpOut)` at contracts/src/vaults/TegridyHarvestVault.sol:352 the two lines: `// lpCompounded is addLiquidity's return value, not a pre-call balance read; harvest and every value-moving entry point share one nonReentrant guard (proved by TegridyHarvestVaultReentrancy.t.sol).` then `// slither-disable-next-line reentrancy-balance`. This one directive also covers finding id 2 (same function, same call, other balance leg). After adding it, re-run slither and confirm the High count drops by 2 — do not assume the suppression took.

### [FALSE_POSITIVE] `reentrancy-balance` — contracts/src/vaults/TegridyHarvestVault.sol:352  _(if real: high)_

**Reasoning.** Identical mis-attribution to id 1, differing only in which pre-call read is cited: here `rewardSide = rewardToken.balanceOf(address(this))` at line 381. That value is not compared after the external call — it is passed into addLiquidity as amountADesired at line 397, which is the correct use of a live balance for an add-liquidity desired amount. The variable the detector calls stale, `lpCompounded`, is assigned from that same call's return at 394-403 and bounded one line later at 404 (`if (lpCompounded < minLpOut) revert SlippageTooHigh()`), which is exactly where a min-out check belongs. The nonReentrant coverage argument from id 1 applies unchanged: harvest 354, deposit 262, mint 266, withdraw 270, redeem 274, deployIdle 299, panic 535 all share one guard, and totalAssets() (241-243) is computed from live balances with no cached share price.

**Why no exploit path.** No path exists. The reward token is Toweli, a plain OZ ERC20 whose only override is a constructor mint-lock in `_update` (contracts/src/Toweli.sol:123-129) — no ERC-777 hook, no fee-on-transfer, so a transfer of it cannot hand control to an attacker in the first place. Even substituting a hostile reward token, TegridyHarvestVaultReentrancy.t.sol:217-227 does precisely that and asserts the reentrant harvest() reverts on the guard. And a balance that moved mid-call would make TegridyRouter's safeTransferFrom (TegridyRouter.sol:126) revert, not under-deliver, so there is no state in which the vault credits LP it did not receive.

**Action.** No code change. Covered by the single `// slither-disable-next-line reentrancy-balance` directive placed above line 352 for finding id 1 — do not add a second one. Verify by re-running slither that both High findings disappear together.

### [FALSE_POSITIVE] `incorrect-equality` — contracts/src/vaults/TegridyHarvestVault.sol:352  _(if real: medium)_

**Reasoning.** The flagged node is `rewards == 0` at line 364, where `rewards` is `rewardToken.balanceOf(address(this))` (363). The hazard incorrect-equality models is an `==` against a target an attacker can land on exactly to flip a branch. The target here is zero on a uint256, where `== 0` is bit-identical to `<= 0` — there is no near-miss band to land in. Direction rules out the rest: an attacker can only RAISE this balance by donating TOWELI; nothing in the contract or in Toweli lets them lower it (contracts/src/Toweli.sol:123-129 is a plain OZ ERC20 with a mint-lock override only — no fee-on-transfer, no rebase, so the balance never moves silently either).

**Why no exploit path.** No profitable path. Pushing `rewards` off zero with a donation reaches exactly two outcomes, both harmless: the donated tokens are compounded into LP that belongs to depositors (a gift to the vault), or line 386 reverts NothingToCompound and the entire transaction rolls back including the fee transfer at 427 — the behaviour deliberately documented at 383-385. There is no branch whose skipping or taking transfers value to the donor: harvest has no path that withdraws principal from the farm or sends the asset out of the contract. The zero-rewards branch is covered by test_harvest_withNoRewardsIsANoOp (contracts/test/vaults/TegridyHarvestVault.t.sol:354-366), which asserts lp == 0, totalAssets unchanged, and lastHarvestTimestamp still 0.

**Action.** No code change required for the security claim. Add above line 364: `// Zero-compare on a uint balance an attacker can only raise, never lower; both outcomes of raising it are benign (compound the gift, or revert at 386).` then `// slither-disable-next-line incorrect-equality`. Separately, a non-blocking hardening a human may want: when farm rewards are zero but a 1-wei donated residue exists and the paired balance is zero, this `== 0` lets flow reach 386 and revert instead of the intended no-op return, burning keeper gas. Replacing 364 with a small dust threshold would close that; it is a liveness nit with no fund impact.

### [FALSE_POSITIVE] `incorrect-equality` — contracts/src/vaults/TegridyHarvestVault.sol:352  _(if real: medium)_

**Reasoning.** The flagged node is `toConvert == 0` at line 368. This branch is unreachable, and a branch no input can reach cannot be a manipulable strict equality. Proof from the code: toConvert = rewards - fee (367); fee is returned by _chargePerformanceFee as (rewards * bps) / BPS_DENOMINATOR (424) with BPS_DENOMINATOR = 10_000 (104) and bps = performanceFeeBps, which is bounded by MAX_PERFORMANCE_FEE_BPS = 1000 (110) — enforced both at proposal (458) and re-checked against the value actually written at execution (471). So fee <= rewards/10 and toConvert >= rewards - rewards/10 >= 1 for every rewards >= 1, while rewards == 0 has already returned at 364. On top of that, the comparison is `== 0` on a uint256, identical to `<= 0`, with no near-miss band.

**Why no exploit path.** No path. Reaching this branch requires fee == rewards exactly, which requires performanceFeeBps >= BPS_DENOMINATOR; the constant cap at line 110 is a `constant` in the bytecode of a non-upgradeable contract, so it cannot be raised by the owner, by timelock, or by any caller. An attacker donating reward tokens moves `rewards` up, which moves `toConvert` up too — further from the compared value, not toward it. The guard is nevertheless correct defensive code: it becomes live and necessary if MAX_PERFORMANCE_FEE_BPS is ever raised to BPS_DENOMINATOR in a refactor, so it should be kept, not deleted.

**Action.** No code change. Add above line 368: `// Unreachable while MAX_PERFORMANCE_FEE_BPS (1000) < BPS_DENOMINATOR (10_000): fee <= rewards/10, so toConvert >= 1 whenever rewards >= 1. Kept as defensive cover if that cap is ever raised.` then `// slither-disable-next-line incorrect-equality`. If anyone later raises MAX_PERFORMANCE_FEE_BPS, delete the suppression and re-triage this line — the reachability proof above is what makes it safe.

### [FALSE_POSITIVE] `incorrect-equality` — contracts/src/vaults/TegridyHarvestVault.sol:420  _(if real: medium)_

**Reasoning.** The flagged node is `fee == 0` at line 425 inside _chargePerformanceFee. `fee` is not a balance or a timestamp — it is a pure local arithmetic result computed one line earlier at 424 as (rewards * bps) / BPS_DENOMINATOR. The guard only skips a zero-value safeTransfer at 427 and a `totalFeesCharged += 0` at 426, so both sides of the branch are semantically identical when fee == 0; there is no behaviour to flip. The upstream quantity slither taints this through is `rewards`, a balance an attacker can only increase, and increasing it can only push fee ABOVE zero — i.e. make the attacker's own donated tokens pay a fee. As shipped the line is not even reached: performanceFeeBps defaults to 0 (133) and feeRecipient to address(0) (136), so line 423 returns first, and opening either gate costs a separate 48h timelock (114-115, 457-495).

**Why no exploit path.** No path. To exploit a strict equality an attacker must be able to force the compared value to or away from the target for gain. Forcing fee to exactly 0 means the fee recipient receives nothing — but that is already the state on a fresh deploy and it is a loss to the protocol's fee sink, never to depositors, whose principal is the LP asset and is never touched by this function. Forcing fee off 0 requires donating reward tokens and results in the donor funding the fee. Neither direction moves depositor principal: _chargePerformanceFee transfers only rewardToken (427), and the constructor rejects reward == asset at line 224.

**Action.** No code change. Add above line 425: `// fee is a local arithmetic result, not a balance; == 0 only skips a zero-value transfer, so both branches are equivalent. Gate is closed by default (feeRecipient == address(0)).` then `// slither-disable-next-line incorrect-equality`.

### [FALSE_POSITIVE] `incorrect-equality` — contracts/src/vaults/TegridyHarvestVault.sol:352  _(if real: medium)_

**Reasoning.** The flagged node is `rewardSide == 0 || pairedSide == 0` at line 386, over the two balanceOf reads at 381-382. Same zero-comparison argument as ids 25/32: `== 0` on a uint256 is identical to `<= 0`, with no near-miss band an attacker can land on, and both balances can only be raised by an outsider (donation), never lowered — the vault is the only holder able to spend them and rewardToken is Toweli, a plain OZ ERC20 (contracts/src/Toweli.sol:123-129). Crucially, crossing this guard does not bypass the economic protection: `minLpOut` is still enforced at 404, and TegridyRouter.addLiquidity independently requires `liquidity > 0` (contracts/src/TegridyRouter.sol:129), so a compound seeded by dust either mints real LP for depositors or reverts.

**Why no exploit path.** No path. To profit an attacker would need the guard to pass on a state where the compound loses depositor value. Donating reward or paired tokens to push a side off zero contributes the attacker's own tokens to LP minted to the vault (394-403, `to = address(this)`), which increases totalAssets (241-243) for existing shareholders — a gift, not an extraction. Making a side exactly zero is not available to an attacker at all, and when it happens naturally the guard reverts the whole transaction, rolling back the fee transfer at 427 exactly as intended per the comment at 383-385. Note the guard's own revert branch (NothingToCompound) is not exercised by any test in contracts/test/vaults/TegridyHarvestVault.t.sol.

**Action.** No code change. Add above line 386: `// Zero-compares on balances an attacker can only raise; raising them contributes their own tokens to depositor LP, and minLpOut (404) plus the router's liquidity > 0 check still bound the outcome.` then `// slither-disable-next-line incorrect-equality`. Separately worth doing before deploy: add a test covering the NothingToCompound revert (dust-only reward balance with a zero paired balance) — it is currently the only untested branch in harvest().

### [FALSE_POSITIVE] `unused-return` — contracts/src/vaults/TegridyHarvestVault.sol:352  _(if real: medium)_

**Reasoning.** Checked the specific concern raised: the ignored return is NOT an ERC20 bool. `swapExactTokensForTokens` returns `uint256[] memory amounts` — see the interface declaration at contracts/src/vaults/TegridyHarvestVault.sol:31-37 and the implementation at contracts/src/TegridyRouter.sol:223-241. That router signals failure by reverting, never by a return value: InvalidPath (227), InvalidRecipient (228, 230, 232), and decisively `if (amounts[amounts.length - 1] < amountOutMin) revert InsufficientOutputAmount()` at line 237. So minPairedOut is enforced INSIDE the call, before any return value would be inspected. The vault then re-reads `pairedToken.balanceOf(address(this))` at line 382, which is a strictly stronger measure than the router's quoted amounts because it is the realised balance. Every ERC20 movement in harvest that could silently fail does check its return: the fee transfer uses SafeERC20 safeTransfer (427) and all approvals use forceApprove (375, 388, 389, 408, 409).

**Why no exploit path.** No path. A missing success check is only exploitable if the call can return failure without reverting; TegridyRouter has no such return path on this function, and `router` is immutable, set once in the constructor (200), so it cannot be swapped for a permissive one post-deploy. A swap that silently under-delivers is caught twice over: by amountOutMin inside the router (237) and by the balanceOf re-read at 382 feeding the `pairedSide == 0` guard at 386 and the minLpOut bound at 404. test_harvest_respectsMinPairedOut (contracts/test/vaults/TegridyHarvestVault.t.sol:402-411) asserts the real TegridyRouter.InsufficientOutputAmount revert against the production router, not a mock.

**Action.** No code change. Add above line 378: `// Return is uint256[] amounts, not an ERC20 success bool; TegridyRouter reverts on failure and enforces minPairedOut internally (TegridyRouter.sol:237). The realised balance is re-read at 382.` then `// slither-disable-next-line unused-return`.

### [FALSE_POSITIVE] `unused-return` — contracts/src/vaults/TegridyHarvestVault.sol:352  _(if real: medium)_

**Reasoning.** The load-bearing return value is captured, not ignored: line 394 is `(,, lpCompounded) = router.addLiquidity(...)` and lpCompounded is bounded immediately at 404 against minLpOut. Only amountA and amountB are dropped, and the vault has no need of them — the unconsumed remainder of whichever leg was over-supplied stays in the contract and is picked up by the NEXT harvest's live balance reads (rewardToken at 363, pairedToken at 382), while the standing allowance that remainder would otherwise leave is explicitly zeroed at 408-409. The failure case the detector guards against also cannot hide here: TegridyRouter.addLiquidity reverts rather than returning a failure, and requires `liquidity > 0` at contracts/src/TegridyRouter.sol:129, so a zero-mint is impossible to miss. The return is a (uint256,uint256,uint256) tuple, not an ERC20 bool.

**Why no exploit path.** No path. For the dropped amountA/amountB to cause loss, the residue they represent would have to be stranded or double-counted. It is neither: totalAssets() (241-243) counts only LP — idle balance plus farm.rawBalanceOf — so unconverted reward/paired residue is never priced into shares, and the residue is provably carried forward by test_harvest_leavesOnlyRatioDustUnconverted (contracts/test/vaults/TegridyHarvestVault.t.sol:333-352), which asserts the residue is under totalHarvested/20 and that a second harvest raises totalAssets ('residue is carried forward, not lost'). test_harvest_neverReducesTotalAssets (413-426) asserts monotonic assets across five consecutive harvests.

**Action.** No code change. Add above line 394: `// lpCompounded (the return component that matters) is captured and bounded at 404; amountA/amountB are intentionally dropped because the residue rolls into the next harvest via the balance reads at 363/382, and the allowances it leaves are zeroed at 408-409.` then `// slither-disable-next-line unused-return`.


## Group: `uninitialized-local`

All 13 are FALSE_POSITIVE, and I want to be explicit about why that is not me making work disappear.

They split into two distinct classes, and I did NOT use the same proof for both:

CLASS A — every path assigns before the read (5 findings: #10 prePaid, #13 available, #14 live, #16 power, #17 distributed's sibling pattern... precisely #10, #13, #14, #16). These are pure try/catch modelling failures: Slither does not treat the catch arm as an assignment. Each verdict cites the two line numbers that assign. Nothing subtle here.

CLASS B — the default IS read on a live path, and the default is the CORRECT value (9 findings: #8, #9, #11, #12, #15, #17, #18, #19, #20). Your rule said "if any path reaches a use with the variable still at its default, that is a REAL_BUG". I deliberately did not apply that mechanically, because it would have produced nine false REAL_BUGs: a `+=` accumulator starting at 0 and an ascending-order sentinel starting at address(0) reach their use at the default BY DESIGN. For each of these I proved the default is right rather than asserting it — e.g. #11 preBonus is arithmetically identical to what the skipped branch would have computed because I verified every one of the 14 `bonusDebt` writes in TegridyRestaking.sol is `_safeInt256(uint256)` or `0`, so `bonusDebt >= 0` is an invariant and `0 - bonusDebt` can never be positive; and #15 pendingWindow's `totalEffectiveSupply != 0` guard is the exact mirror of `_updateReward`'s empty-window forfeit branch (line 390), so a zero there is consistent with the wei genuinely not being reserved.

Two loop-bound cases needed a reachability check rather than a hand-wave, and I did them: #18 held could have returned `(true, 0)` — an outage reading as a legitimate zero, which is exactly the failure mode the house forbids — if a Covenant could have an empty holders array; LaunchRugEscrow.sol:371 reverts `HolderCountOutOfRange` on `h == 0` and line 373 is the ONLY `_covenants[...].push()` in the file, so `n >= 1` always. #17 distributed / #12 total are likewise floored at one iteration by TegridyFeeLocker.sol:166.

ADJACENT CONCERNS THIS DETECTOR DOES NOT COVER — flagging so they are not lost inside a wall of FPs. These are NOT uninitialized-local bugs (the variables are explicitly assigned), but they are the same silent-zero family and live in files with no audit coverage:
  1. RestakingMonitorView.pendingBonus (contracts/src/RestakingMonitorView.sol:58-60): if `bonusRewardToken().balanceOf()` reverts, the catch sets `available = 0`, which caps `reward` to 0 and drops the pending accrual since `lastBonusRewardTime`. The view returns a plain uint256 with no readable/stale flag, so a token outage renders as a smaller-but-plausible number. Worth a human decision on whether this view needs the `(bool readable, ...)` shape LaunchRugEscrow._readCovenantBps uses for exactly this reason.
  2. StreamingRevenueDistributor._effectivePower (contracts/src/v2/StreamingRevenueDistributor.sol:439-441, 450-451): if BOTH the votingEscrow and restaking reads revert, the function returns 0 and the account mirrors in at zero power. The code comments at 429-432 and 444-446 show this was a considered trade, and `isSynced()` at 460 exists as the UI gate, so I am not calling it a bug — but the mitigation is a view a frontend must remember to call, which is weaker than a fail-closed revert.

ON THE GATE: `uninitialized-local` is not incidental noise here — it is explicitly promoted in contracts/slither.config.json's `detectors_to_include` list. So the honest remediation is 13 targeted `// slither-disable-next-line uninitialized-local` lines each carrying its one-sentence reason, NOT adding the detector to `detectors_to_exclude`. Excluding it wholesale would turn off the detector that actually catches a wrong-default read, in a repo whose stated failure mode is a silent zero. Each `action` below gives the exact comment to place above the exact declaration. That clears 13 of the 48 gating findings without weakening the gate. Note also that the config's `_scope` note is stale exactly as you said: NONE of these six files (TegridyRestaking is the sole exception, and it IS on the in-scope list) appears on either the in-scope or the moved-off list, so five of the six were analysed by CI with no audit rationale behind them.

### [FALSE_POSITIVE] `uninitialized-local` — contracts/src/TegridyRestaking.sol:339

**Reasoning.** CLASS B — the default IS read, and false is the correct value. `bool delivered;` (339) is assigned `true` ONLY in the try-success arm (341); the catch arm (342-345) deliberately leaves it at `false` and instead records `strandedRestakeRecipient[tokenId] = recipient` + emits `RestakeNFTStranded`. The single read is `if (delivered)` at 347, gating the post-transfer-hook claim. `false` there means precisely 'the safeTransferFrom reverted, so the NFT never moved' — which is exactly the state the catch arm just recorded. A bool from a try/catch where the failure arm is the default is the intended idiom, not an omission; Slither flags it because it does not model the catch arm as a definition site.

**Why no exploit path.** No path exists. The only read (line 347) is reached with `delivered == false` exclusively via the catch arm at 342, where the transfer demonstrably failed — so skipping the post-transfer claim at 348 is correct: no NFT moved, therefore no transfer-hook credit was generated to claim. The stranded NFT is not lost either; line 343 arms self-recovery via claimStrandedRestakeNFT.

**Action.** No code change. Add above line 339: `// slither-disable-next-line uninitialized-local` with the reason `// `delivered` intentionally stays false on the catch arm — that IS the 'transfer reverted' signal read at line 347.`

### [FALSE_POSITIVE] `uninitialized-local` — contracts/src/TegridyRestaking.sol:333

**Reasoning.** CLASS A — every path assigns before any read. `uint256 prePaid;` (333) is assigned on BOTH arms of the try/catch: line 335 (`prePaid = _p;`) on success, line 337 (`prePaid = 0;`) on revert. The first read is at line 354 (`totalUnsettled = prePaid + postPaid;`), which is unreachable without passing through one of those two arms. Slither's dataflow does not treat a catch-block assignment as a definition, which is the entire basis of this finding.

**Why no exploit path.** No path exists. Lines 335 and 337 exhaustively cover the try/catch, so the default 0 is never observed at the read on line 354. Even the catch value is an explicit, deliberate 0 meaning 'the staking-side claim reverted, nothing was paid pre-transfer' — the same number the default would have carried, so no caller-visible difference exists either way.

**Action.** No code change. Add above line 333: `// slither-disable-next-line uninitialized-local` with the reason `// assigned on both try/catch arms (lines 335, 337) before the read at 354.`

### [FALSE_POSITIVE] `uninitialized-local` — contracts/src/TegridyRestaking.sol:308

**Reasoning.** CLASS B — the default is read when `oldBoosted == 0`, and 0 is provably the same value the branch would have computed. `uint256 preBonus;` (308) is assigned only inside `if (oldBoosted > 0)` at line 312; the read is `if (preBonus > 0)` at 315. Had the branch run with oldBoosted == 0, it would compute `preAccum = _safeInt256((0 * accBonusPerShare)/ACC_PRECISION) = 0`, then `preDiff = 0 - info.bonusDebt`, then `preBonus = preDiff > 0 ? uint256(preDiff) : 0`. I verified the sign invariant rather than assuming it: every write to `bonusDebt` in this file (lines 285, 313, 856, 945, 1041, 1043, 1095, 1188, 1190, 2160, 2181, 2183, 2329) is either `_safeInt256(<uint256>)`, a copy of such a value, or a literal `0`, so `bonusDebt >= 0` always. Therefore `preDiff <= 0` and `preBonus` would be 0 regardless. The skipped branch and the default agree exactly.

**Why no exploit path.** No path exists. With oldBoosted == 0 the position holds no boosted stake, so no bonus can have accrued against it; the default 0 reaching line 315 means 'pay nothing', which is correct, and is arithmetically identical to the branch result given `bonusDebt >= 0` (proven from all 13 write sites). All three callers (lines 919, 1006, 1168) pass `oldBoosted = info.boostedAmount` read immediately prior, so a zero there is a genuinely unboosted position, not a stale read. Note the one real behavioural difference — `info.bonusDebt` is not re-anchored to 0 on the skip — is a no-op for payout and is outside this detector's claim.

**Action.** No code change. Add above line 308: `// slither-disable-next-line uninitialized-local` with the reason `// oldBoosted==0 skips the branch, but preBonus would be 0 there anyway since bonusDebt is non-negative at every write site.`

### [FALSE_POSITIVE] `uninitialized-local` — contracts/src/TegridyRestaking.sol:346

**Reasoning.** CLASS B — the default is read on the stranded path, and 0 is the correct value. `uint256 postPaid;` (346) is assigned only inside `if (delivered)` (347), on both arms of the inner try/catch (349 and 351). When `delivered == false` the block is skipped and the default 0 flows to `totalUnsettled = prePaid + postPaid;` at 354. That is correct by construction: `postPaid` exists solely to capture credit generated by the NFT's transfer hook, and on the catch path of line 340 no transfer occurred, so there is no such credit. A non-zero value there would be the bug.

**Why no exploit path.** No path exists. The default 0 is read only when the safeTransferFrom at 340 reverted, in which case no transfer-hook credit was created and 0 is the true amount. The return value feeds the caller's `UnsettledRecovered` accounting (callers at 1267 and 1730), so the reported total on the stranded path is `prePaid` alone — which is exactly what was actually drained. No user funds are skipped: the un-transferred NFT's residue is separately reserved by `_reserveResidual(tokenId, recipient)` at 355, which runs unconditionally on both paths.

**Action.** No code change. Add above line 346: `// slither-disable-next-line uninitialized-local` with the reason `// 0 is correct when !delivered — no transfer happened, so no post-transfer-hook credit exists to claim.`

### [FALSE_POSITIVE] `uninitialized-local` — contracts/src/nftfi/NftfiBnpl.sol:233

**Reasoning.** CLASS B — `uint256 acc;` (233) is a `+=` loop accumulator whose zero default is the required additive identity. The loop at 234 runs `for (uint256 k = 1; k <= INSTALMENTS; k++)` where `INSTALMENTS` is `uint256 public constant INSTALMENTS = 3` (line 87), so it always executes exactly 3 iterations — the 'loop never ran' path Slither implicitly worries about does not exist. Separately, even a hypothetical `INSTALMENTS == 0` could not reach the read with a spurious zero, because line 232 (`financedWei / INSTALMENTS`) would panic on division by zero first. The read is `interestWei = acc;` at 238.

**Why no exploit path.** No path exists. With INSTALMENTS fixed at 3 the accumulator is written on every one of 3 iterations before the read at 238, and starting at 0 is the only correct seed for a summation. A zero `interestWei` can still legitimately arise if `vault.aprBps()` returns 0 (line 231), but that is a real zero-APR pool, not an uninitialized read — and note it cannot mask an outage, because `vault.aprBps()` is an unguarded external call whose revert reverts the whole quote rather than degrading to 0.

**Action.** No code change. Add above line 233: `// slither-disable-next-line uninitialized-local` with the reason `// summation accumulator; 0 is the additive identity and INSTALMENTS is a non-zero constant (line 87) so the loop always runs.`

### [FALSE_POSITIVE] `uninitialized-local` — contracts/src/v4/TegridyFeeLocker.sol:168

**Reasoning.** CLASS B — `uint256 total;` (168) is a `+=` accumulator (line 180) whose zero default is the additive identity. The loop at 170 is floored at one iteration by line 166 (`if (beneficiaries.length == 0) revert NoBeneficiaries();`), so it cannot be skipped. The read is `if (total != WAD) revert SharesMustSumToWad(total);` at 182 — which is itself fail-closed: even in an impossible zero-iteration world, `total` at its default 0 would not equal `WAD` (1e18, line 53) and the call would revert rather than register a mispaying lock.

**Why no exploit path.** No path exists, and the failure mode is doubly guarded. An empty beneficiary list reverts at 166 before the declaration is even reached in effect; and were the loop somehow skipped, the default 0 fails the `total != WAD` check at 182 and reverts. There is no path on which a default-valued `total` results in a registered lock, so no lock can exist with a share split that does not sum to WAD.

**Action.** No code change. Add above line 168: `// slither-disable-next-line uninitialized-local` with the reason `// share-sum accumulator; 0 is the additive identity, the loop is floored at one iteration by line 166, and a default 0 would fail the WAD check at 182 anyway.`

### [FALSE_POSITIVE] `uninitialized-local` — contracts/src/v4/TegridyFeeLocker.sol:169

**Reasoning.** CLASS B — `address previous;` (169) is a deliberate `address(0)` sentinel, and the default is not merely tolerated but load-bearing. It is read on the first loop iteration at line 178 (`if (b.beneficiary <= previous) revert DuplicateOrUnsortedBeneficiary();`) and reassigned at 179 (`previous = b.beneficiary;`) on every iteration thereafter. address(0) is the correct low sentinel for an ascending-order check: it is the minimum possible address, so the first real beneficiary always passes, and any candidate that would fail against it (`b.beneficiary <= address(0)`, i.e. exactly zero) has already been rejected one line earlier at 172 (`if (b.beneficiary == address(0)) revert ZeroAddress();`). Seeding it with anything other than 0 would break the check.

**Why no exploit path.** No path exists. The default address(0) is read exactly once, on iteration 0, where it correctly means 'no predecessor yet'. It cannot let a duplicate or out-of-order entry through: for any non-zero `b.beneficiary`, `b.beneficiary <= address(0)` is false, which is the intended pass; and the zero case is already reverted at 172. The comparison chain from iteration 1 onward uses real values written at 179, so the ascending-with-no-repeats invariant — which line 174-177 documents as the defence against a duplicate silently doubling a beneficiary's take — holds across the whole array.

**Action.** No code change. Add above line 169: `// slither-disable-next-line uninitialized-local` with the reason `// address(0) is the intended low sentinel for the ascending-order check at 178; the zero-beneficiary case it would collide with is already reverted at 172.`

### [FALSE_POSITIVE] `uninitialized-local` — contracts/src/v4/TegridyFeeLocker.sol:248

**Reasoning.** CLASS B — `uint256 distributed;` (248) is a `+=` accumulator (256) whose zero default is the additive identity, read at 253 (`share = amount - distributed;`) for the final beneficiary. I checked the two things that could make this wrong. (1) Zero iterations: `n = l.beneficiaries.length` (247) is >= 1 because `l.beneficiaries` is written only at line 190 inside `lockPosition`, which reverts on an empty list at 166, and `_credit` is called only from `collect` (232-233) after `if (!l.exists) revert UnknownPosition()` at 211 — so no lock with zero beneficiaries can exist. (2) Underflow at 253: for `i < n-1`, `distributed` sums `(amount * b.shares)/WAD` over shares that total strictly less than WAD (the full set sums to exactly WAD per line 182, and the excluded last entry has `shares != 0` per 173), so `distributed < amount` and the subtraction is safe. In the n==1 case the single beneficiary correctly receives `amount - 0 == amount`.

**Why no exploit path.** No path exists. Starting at 0 is required for the remainder arithmetic to be correct — the last beneficiary receives `amount - distributed`, which with a non-zero seed would under-pay them and strand the difference. The n==0 path that would leave the accumulator unread is unreachable per lockPosition's guard at 166, and `amount == 0` returns early at 245 before the declaration matters.

**Action.** No code change. Add above line 248: `// slither-disable-next-line uninitialized-local` with the reason `// running-total accumulator; 0 is the additive identity and is what makes the last beneficiary's `amount - distributed` remainder exact.`

### [FALSE_POSITIVE] `uninitialized-local` — contracts/src/RestakingMonitorView.sol:54

**Reasoning.** CLASS A — every path assigns before the read. `uint256 available;` (54) is assigned on BOTH arms: line 57 (`available = bal > debt ? bal - debt : 0;`) on try-success and line 59 (`available = 0;`) in the catch. The only read is `if (reward > available) reward = available;` at 61, unreachable without traversing one of those arms. Slither is not modelling the catch assignment. Note this is a read-only view contract (no state writes anywhere in the file), so even a wrong value here could not corrupt accounting.

**Why no exploit path.** No path exists for the detector's claim — lines 57 and 59 exhaustively cover the try/catch. Separately worth a human eye but NOT this finding: the catch arm's explicit `available = 0` caps `reward` to 0 at line 61, so a reverting `balanceOf` silently drops the accrual since `lastBonusRewardTime` and `pendingBonus` returns an understated number with no readable/stale flag for the caller to notice. That is a design question about outage-vs-zero in a display view, not an uninitialized-local defect, and I have raised it in groupNotes rather than smuggling it into this verdict.

**Action.** No code change for this finding. Add above line 54: `// slither-disable-next-line uninitialized-local` with the reason `// assigned on both try/catch arms (lines 57, 59) before the read at 61.` Separately, a human should decide whether pendingBonus needs a `(bool readable, uint256)` return so a bonus-token outage cannot render as a smaller-but-plausible pending figure.

### [FALSE_POSITIVE] `uninitialized-local` — contracts/src/LaunchRugEscrow.sol:672

**Reasoning.** CLASS A — the only reaching path assigns. `uint256 live;` (672) is assigned at line 674 (`live = supply;`) on try-success; the catch arm at 675-677 does NOT fall through — it executes `return (false, 0);`, so control never reaches the read. The read is at 682 (`uint256 denom = live < snapshot ? live : snapshot;`), reachable exclusively via the success arm. This is the strongest possible refutation of the detector's premise: the default is not merely overwritten, it is unreachable at any read.

**Why no exploit path.** No path exists. The catch arm terminates the function with the explicit no-data signal `(false, 0)` before line 682, so `live` is never read at its default. This is also the correct security behaviour and the whole point of the function's contract (documented at 662-665): a read failure returns `readable == false`, and all three consumers refuse to act on it — `flagCovenantBreach` reverts `CovenantUnreadable` at 418, `confirmCovenantBreach` at 445 with the comment that seizing on an unreadable asset would convert a token outage into a confiscation, and `covenantStatus` propagates the flag at 607-608.

**Action.** No code change. Add above line 672: `// slither-disable-next-line uninitialized-local` with the reason `// assigned at 674 on success; the catch arm returns (false, 0) at 676 rather than falling through to the read at 682.`

### [FALSE_POSITIVE] `uninitialized-local` — contracts/src/LaunchRugEscrow.sol:685

**Reasoning.** CLASS B — `uint256 held;` (685) is a `+=` accumulator (689) whose zero default is the additive identity, read at 694 (`return (true, (held * BPS) / denom);`). This is the one finding in the group where the bad case would have been serious, so I checked reachability rather than assuming: if `c.holders.length` could be 0 the loop would be skipped and the function would return `(true, 0)` — a confident 'zero bps held', i.e. maximum breach, on a covenant nobody had ever measured, which would let `confirmCovenantBreach` seize an escrow. It cannot happen. Line 371 reverts `HolderCountOutOfRange` when `h == 0 || h > MAX_HOLDERS_PER_COVENANT`, and line 373 (`_covenants[escrowId].push()`) is the ONLY Covenant construction site in the file, with holders pushed at 389 before the first `_readCovenantBps` call at 392. So `n >= 1` at every invocation.

**Why no exploit path.** No path exists. The dangerous `(true, 0)` return requires `c.holders.length == 0`, which `_publishCovenant` makes unconstructable at line 371; every stored Covenant carries 1..20 holders. Each individual balance read is fail-closed anyway — a reverting `balanceOf` returns `(false, 0)` at 691 rather than skipping a holder and under-counting `held`, so a partial outage cannot forge a breach either. The zero seed is simply the correct start for summing balances.

**Action.** No code change. Add above line 685: `// slither-disable-next-line uninitialized-local` with the reason `// balance-sum accumulator; 0 is the additive identity and holders.length >= 1 is enforced at 371, so the loop cannot be skipped into a false (true, 0) breach reading.`

### [FALSE_POSITIVE] `uninitialized-local` — contracts/src/v2/StreamingRevenueDistributor.sol:524

**Reasoning.** CLASS B — `uint256 pendingWindow;` (524) is read at its default on two real paths, and 0 is correct on both because the guards mirror the accrual core exactly. Assigned only at 528, inside `if (totalEffectiveSupply != 0)` (525) and `if (applicable > lastUpdateTime)` (527); read at 534 (`return remaining + pendingWindow + outstanding;`). I verified both guards against `_updateReward`: line 390 (`if (totalEffectiveSupply == 0)`) takes the Synthetix-forfeit branch that emits `RewardsForfeitedDuringEmptyPeriod` and pointedly does NOT add to `totalStreamed`, while the `else if (applicable > lastUpdateTime)` arm is the only place `totalStreamed +=` happens. `rewardPerToken()` at 365 short-circuits on the same condition. So a window with no effective supply credits nobody, and reserving nothing for it is right — the state comment at 254-257 says so explicitly and calls that non-reservation the thing that makes the wei re-streamable.

**Why no exploit path.** No path exists in either direction. If `totalEffectiveSupply == 0`, no per-token accrual advanced (rewardPerToken line 365 returns the stored value unchanged), so there is nothing owed to reserve; if `applicable <= lastUpdateTime`, zero time elapsed and zero emission accrued. The under-reservation this would otherwise cause is the consequence that matters here — `distributable()` (543) subtracts `reservedETH()` from the balance and feeds `notifyRewardAmount` — but since the omitted window is emission that `_updateReward` deliberately forfeits and never credits to any account, re-streaming it is the intended behaviour, not a double-spend of reserved wei.

**Action.** No code change. Add above line 524: `// slither-disable-next-line uninitialized-local` with the reason `// 0 is correct: both guards mirror _updateReward (line 390) exactly, and emission accrued while totalEffectiveSupply==0 is Synthetix-forfeit — deliberately unreserved so it re-streams.`

### [FALSE_POSITIVE] `uninitialized-local` — contracts/src/v2/StreamingRevenueDistributor.sol:436

**Reasoning.** CLASS A — every path assigns before the read. `uint256 power;` (436) is assigned on BOTH try/catch arms: line 438 (`power = p;`) and line 440 (`power = 0;`). The only read is `if (power > 0) return power;` at 442, unreachable without one of those two assignments. Slither's non-modelling of catch-arm definitions is the whole finding.

**Why no exploit path.** No path exists for the detector's claim — lines 438 and 440 exhaustively cover the try/catch before the read at 442. Not this finding, but noted for the group: when the catch sets 0 the function falls through to a second guarded read (`restakingContract.boostedAmountAt` at 448) whose own catch returns 0 at 451, so a double outage mirrors an account in at zero power. The code treats that as a considered trade — comments at 429-432 and 444-446 explain the fallback exists precisely because restakers read 0 from votingEscrow, and `isSynced()` at 460 is provided as the gate a UI must call before rendering an earnings number. I flag it in groupNotes rather than converting a proven-FP verdict into a bug report.

**Action.** No code change for this finding. Add above line 436: `// slither-disable-next-line uninitialized-local` with the reason `// assigned on both try/catch arms (lines 438, 440) before the read at 442.` Separately, a human should confirm the double-outage-mirrors-zero fallback at 448-452 is acceptable given its only mitigation is a view (isSynced) that consumers must remember to call.


## Group: `incorrect-equality`

21 findings, all read at source. The cluster splits cleanly by WHAT is compared, and 19 of 21 are not the exploit shape the detector is named for.

Three structural facts decided most of them:
1. `x == 0` on a uint is a TOTAL partition with `x > 0`. The classic break (`balance == expected` defeated by a 1-wei donation) needs a NON-ZERO expected value to near-miss. 17 of these 21 are `== 0` guards, so there is no near-miss to engineer; the only question left is whether flipping the branch buys anything, which I checked case by case.
2. Donation is ONE-DIRECTIONAL. An outsider can raise a contract's token/ETH balance but never lower it. So for every `balanceOf(...) == 0` guard in this group the only reachable manipulation is OPENING the gate, and opening it always requires the attacker to actually deliver the value. There is no path where a third party forces a balance DOWN to trip a zero-branch.
3. Delta vs raw. Most of these compare a delta (`balanceAfter - balanceBefore`) measured by two self-reads inside one `nonReentrant` call — TegridyLockVault 21/35, VestingFactory 23, AirdropFactory 39, FeeExecutorRouter 26/31, FeeLocker 36. A donation lands in BOTH reads (or in the prior tx, hence in `balanceBefore`) and cancels. Those are structurally immune and I called them FALSE_POSITIVE with the line numbers of both reads.

Only TegridyHarvestVault compares RAW donatable balances (25: `rewards`, 41: `rewardSide`/`pairedSide`). Those two I did NOT dismiss — the detector's premise genuinely holds, the consequence is just bounded, so they are REAL_BUT_ACCEPTED with the bound named (onlyKeeper at :355, `minLpOut` at :404, and `totalAssets()` at :241-242 deliberately excluding rewardToken so a donation cannot move the share price).

One finding is dead code, not a false premise: 32 (`toConvert == 0`) is unreachable because MAX_PERFORMANCE_FEE_BPS is 1000 and that cap is enforced at both and only writers of `performanceFeeBps` (:458, :471-472). Recorded because if that cap is ever raised to 10000 the branch `return 0`s AFTER `_chargePerformanceFee` already transferred the fee (:427) and bumped `totalFeesCharged` (:426) — banking a fee against nothing compounded, the exact outcome the comment at :383-385 says the design forbids. Latent, not live.

MAKING THE GATE HONEST — do NOT add `incorrect-equality` to `detectors_to_exclude` in contracts/slither.config.json. That would delete a detector whose premise really does hold in TegridyHarvestVault. Every verdict below carries a per-line `// slither-disable-next-line incorrect-equality` plus a one-sentence reason, which is the convention this repo already uses at contracts/src/TegridyRestaking.sol:686-687. Per-line suppression keeps the detector live for the next contract; a config exclusion is another gate that cannot fail.

ADJACENT — NOT MY GROUP, NOT IN THE 48, WORTH A HUMAN: contracts/src/v4/TegridyFeeLocker.sol:209 `function collect(uint256 tokenId) external` has NO `nonReentrant`, and `_credit` splits a delta measured against `_balanceOf(currency)` (:216-217, :229-230) which is the contract's TOTAL balance in that currency, shared across every lock. The pool key is chosen by whoever locks a position, so a lock in a pool with an attacker-controlled hook takes control during `modifyLiquidities` (:227). A reentrant `collect(otherTokenId)` there would pull a second lock's fees into the contract mid-call, so the inner call credits them to the victim AND the outer delta re-credits the same wei to the attacker's beneficiaries — the contract would then owe more than it holds and `claim` (:270) is first-come-first-served. I did not confirm a hook can reach this contract's `collect` on the V4 call path, so this is a lead, not a finding. It has no slither finding in the 48 at all, which is the more interesting fact.

### [FALSE_POSITIVE] `incorrect-equality` — contracts/src/TegridyLockVault.sol:204  _(if real: low)_

**Reasoning.** `received` is not a balance, it is a delta this contract computes itself: balanceBefore at :201, safeTransferFrom at :202, balanceAfter at :203, all inside one call carrying `nonReentrant` (:194). Both operands of the subtraction are written by this contract's own two balanceOf reads. The accounting downstream uses `received`, never the caller's `amount` (:206 l.amount, :208 totalLocked) — that is the fee-on-transfer-correct pattern, not a victim of one.

**Why no exploit path.** No path. A donation made in a prior transaction is already inside `balanceBefore` (:201) and cancels in the subtraction; a donation made in the same transaction requires a token callback during safeTransferFrom, and it would land in `balanceAfter` only by actually delivering tokens the vault then credits to the depositor who paid for them. To drive `received` to exactly 0 an attacker would have to stop the caller's own transferFrom from arriving, which SafeERC20 reverts on first. The zero branch reverts, so the guard fails closed.

**Action.** Suppress in place, no code change. Above :204 add: `// `received` is a delta of two self-reads inside one nonReentrant call; a donation lands in both and cancels.` then `// slither-disable-next-line incorrect-equality`.

### [FALSE_POSITIVE] `incorrect-equality` — contracts/src/v2/StreamingRevenueDistributor.sol:586  _(if real: low)_

**Reasoning.** `rewardRate` is written by this contract one line earlier (:585 `rewardRate = budget / duration`). Both operands are contract-computed: `budget = leftover + newETH` (:582) and `duration = rewardsDuration` (:575). The comparison is a rounding guard rejecting a budget smaller than the duration in wei — it is the same shape as the `divide-before-multiply` suppression the authors already wrote at :584.

**Why no exploit path.** No path. `newETH` comes from `distributable()` (:572), which is balance-derived and therefore donatable, but a donation only makes `budget` LARGER, i.e. moves strictly away from the reverting branch, and funding the stream is what the branch wants. Driving `rewardRate` to 0 requires shrinking the balance, which no outsider can do. `== 0` on a uint has no near-miss: the complement is exactly `> 0`.

**Action.** Suppress in place, no code change. Above :586 add: `// Guards the integer-division residue on a rate this function just wrote at :585; donations can only raise the budget.` then `// slither-disable-next-line incorrect-equality`.

### [FALSE_POSITIVE] `incorrect-equality` — contracts/src/VestingFactory.sol:189  _(if real: low)_

**Reasoning.** `funded` is a self-measured delta on the freshly deployed wallet: balanceBefore at :186, safeTransferFrom at :187, balanceAfter at :188, inside a `nonReentrant` call (:156). It is the value actually used for accounting (`totalVestedInflow[token] += funded` at :190) and for the event (:200), rather than the requested `amount`.

**Why no exploit path.** No path. The wallet address is a deterministic CREATE address and an attacker CAN pre-fund it, but `balanceBefore` is read at :186 which is AFTER the deployment at :176-178, so any pre-funding sits in both reads and cancels. A same-transaction donation via a token callback would have to actually deliver tokens into the beneficiary's own vesting wallet. The zero branch reverts NoFundsReceived, so the guard fails closed on a 100%-fee-on-transfer token.

**Action.** Suppress in place, no code change. Above :189 add: `// Delta of two self-reads around the fund transfer; pre-funding the CREATE address is captured by balanceBefore at :186.` then `// slither-disable-next-line incorrect-equality`.

### [FALSE_POSITIVE] `incorrect-equality` — contracts/src/nftfi/NftfiPooledLendingVault.sol:542  _(if real: low)_

**Reasoning.** `loan.lastAccrualAt` has exactly two writers, both `uint64(block.timestamp)`: loan creation at :349 and `_accrue` at :564. So `elapsed` (:541) can never underflow and equals 0 only when this read happens in the same block as the last accrual. Decisively, the zero branch is behaviourally IDENTICAL to falling through: the formula at :543 is `(principal * aprBps * elapsed) / (365 days * BPS)`, which is 0 when elapsed is 0. The comparison is a gas short-circuit carrying no protection.

**Why no exploit path.** No path. To reach the branch a caller must already be in the same block as the last accrual, in which case the interest genuinely is zero by the formula itself — there is nothing to skip. Block timestamps are monotonic, so no validator nudge drives `elapsed` to 0 across a real time gap; nudging it upward only accrues MORE interest against the borrower.

**Action.** Suppress in place, no code change. Above :542 add: `// Same-block short-circuit; the formula at :543 returns 0 for elapsed==0 anyway, and lastAccrualAt is only ever set to block.timestamp (:349, :564).` then `// slither-disable-next-line incorrect-equality`.

### [REAL_BUT_ACCEPTED] `incorrect-equality` — contracts/src/vaults/TegridyHarvestVault.sol:364  _(if real: low)_

**Reasoning.** This is one of only two in the group where the detector's premise actually holds. `rewards` at :363 is a RAW `rewardToken.balanceOf(address(this))`, not a delta — any address can raise it with a direct transfer and flip the branch. I am not calling it a false positive on that basis. The consequence is what bounds it: harvest is `onlyKeeper` (:355); `_deployIdle()` on the deposit and withdraw paths (:280, :300) never calls harvest, so a reverting harvest cannot block a deposit, a withdrawal, or `panic()`; `totalAssets()` (:241-242) counts only the LP asset plus the farm balance and deliberately excludes rewardToken, so a donation cannot move the share price until a keeper converts it; and the constructor re-asserts rewardToken != stakingToken (:222), so `rewards` can never capture idle LP principal.

**Why no exploit path.** Griefing only, no value extraction. Attacker sends 1 wei of rewardToken while real rewards are zero. `rewards == 0` is now false so harvest does not return early; `_chargePerformanceFee` yields fee 0, `toConvert` is 1, `swapAmount = toConvert / 2` is 0 so no swap runs, and `pairedSide` (:382) can be 0, reverting NothingToCompound at :386. Net effect is a wasted keeper transaction on dust harvests, self-healing the moment real rewards accrue enough to make `swapAmount` non-zero. A LARGE donation is simply compounded into LP for existing depositors at the donor's expense. Who bounds it: the keeper allow-list on the only entry point, and the fact that no user-facing path depends on harvest succeeding.

**Action.** Accept, no comparison change — a `>= floor` form would trade the grief for a permanently stranded-dust rule. Above :364 add: `// Raw donatable balance by design (every reward-token unit here is yield); bounded by onlyKeeper and by totalAssets() excluding rewardToken, so a donation cannot move the share price.` then `// slither-disable-next-line incorrect-equality`. Separately, add one line to the harvest natspec telling keeper operators that a NothingToCompound revert on a near-zero harvest means a dust donation, not a farm failure.

### [FALSE_POSITIVE] `incorrect-equality` — contracts/src/TegridyFeeExecutorRouter.sol:252  _(if real: low)_

**Reasoning.** This comparison IS the anti-rounding mitigation, not a victim of one. `fee = (received * feeBps) / BPS` at :251, where `received` is a delta of two self-reads around the caller's own transferFrom (:246-248) inside a `nonReentrant` call (:240). When a caller sizes `amountIn` so the fee truncates to zero, the branch forces `fee = 1` — it closes exactly the dust-evasion a reader might fear. `feeBps` is contract storage, bounded by MAX_FEE_BPS at :334.

**Why no exploit path.** No path — the manipulation worth worrying about here (splitting one swap into many slices each of which rounds the fee to zero) is DEFEATED by this branch, which charges a 1-wei minimum on every slice. Separately noted and checked: if a token delivers `received == 0` while `amountIn > 0` (a 100%-fee-on-transfer or a no-op transferFrom), :253 `net = received - fee` underflows and panics 0x11. That fails closed and moves no value, but it surfaces as a panic rather than a typed error — the same complaint VestingFactory:164-167 raises against itself.

**Action.** Suppress in place. Above :252 add: `// Dust rule: forces a 1-wei minimum when the fee truncates to zero, which is the fix for fee-rounding evasion rather than an instance of it.` then `// slither-disable-next-line incorrect-equality`. Optional hardening for a separate PR (a code change, not part of this triage): `if (received == 0) revert ZeroAmount();` before :251, to turn the underflow panic into a typed revert.

### [FALSE_POSITIVE] `incorrect-equality` — contracts/src/markets/TegridyPositionMarket.sol:490  _(if real: low)_

**Reasoning.** `paid = owed > bal ? bal : owed` (:489) with `owed > 0` already forced at :484, so `paid == 0` iff `bal == 0`. `bal` (:488) is a raw balance and therefore nudgeable, but the equality protects nothing that a nudge could subvert: the ledger stays exact on every branch via `escrowRewardsOwed[msg.sender] = owed - paid` (:492) and `totalEscrowRewardsOwed -= paid` (:493), so an unpaid remainder stays owed. This is the documented pay-what-is-on-hand design at :478-481.

**Why no exploit path.** No path that yields value. Raising `bal` by donating turns a revert into a correct partial payment and costs the attacker the donation while paying the victim. Lowering `bal` is impossible for a third party — the only way the balance drops is another seller claiming their OWN `escrowRewardsOwed`, which is the first-come-first-served behaviour the natspec already describes, and it leaves the victim's entry fully owed rather than zeroed. No branch of this comparison lets any caller take more than `escrowRewardsOwed[msg.sender]`.

**Action.** Suppress in place, no code change. Above :490 add: `// Zero means nothing on hand; the ledger at :492-493 preserves the unpaid remainder on every branch, so neither direction of a balance nudge changes what anyone is owed.` then `// slither-disable-next-line incorrect-equality`.

### [FALSE_POSITIVE] `incorrect-equality` — contracts/src/TegridyAirdropDistributor.sol:182  _(if real: low)_

**Reasoning.** `amount` at :181 is a raw balanceOf and so is donatable — but this contract sends its entire token balance to exactly one address on exactly one branch: `creator`, only after expiry, gated by `msg.sender != creator` at :177 and `block.timestamp < deadline` at :179, transferring to `creator` at :184 and never to a caller-supplied address (natspec :171-174). Flipping the comparison cannot redirect anything because there is no second destination and no path that splits a non-zero balance.

**Why no exploit path.** No path. The only nudge available is a donation, and the donation's destination is the same `creator` whichever branch is taken — the attacker simply gifts the creator tokens. Nobody can lower the balance to force the NothingToReclaim revert except leaf accounts claiming their own entitlement before expiry, which is the intended flow and not an attack.

**Action.** Suppress in place, no code change. Above :182 add: `// Sole caller and sole destination are both `creator`, so donating to flip this branch only adds to what the creator already sweeps.` then `// slither-disable-next-line incorrect-equality`.

### [FALSE_POSITIVE] `incorrect-equality` — contracts/src/markets/TegridyPositionMarket.sol:589  _(if real: low)_

**Reasoning.** `amount = surplusRewards()` (:588), defined at :535-537 as `bal > totalEscrowRewardsOwed ? bal - totalEscrowRewardsOwed : 0`. What protects sellers is that subtraction — every outstanding ledger entry is removed before the owner sees a sweepable figure — not this equality. Because the expression already saturates at 0, `amount == 0` is exactly and only `no surplus`. The function is `onlyOwner` (:585) and `_pullUnsettled()` at :587 is best-effort.

**Why no exploit path.** No path to owed funds. To make `amount` non-zero an attacker must donate reward tokens that were owed to nobody, which the owner then sweeps — the donor's loss. To make it zero they would have to inflate `totalEscrowRewardsOwed`, which is written only at :469-470 and :524-525 from deltas measured against TegridyStaking's own unsettled bucket; succeeding would only strand the owner's rescue, never move a seller's balance, since the subtraction at :537 is what keeps owed yield out of reach regardless of which branch runs.

**Action.** Suppress in place, no code change. Above :589 add: `// surplusRewards() already saturates at zero after subtracting every seller's entry, so this is exactly "no surplus" and is not what protects owed yield.` then `// slither-disable-next-line incorrect-equality`.

### [FALSE_POSITIVE] `incorrect-equality` — contracts/src/AirdropFactory.sol:316  _(if real: low)_

**Reasoning.** Pure array bookkeeping with no balance, timestamp or supply anywhere in it. `total = campaigns.length` (:308) and `end = offset + limit` clamped to `total` at :311. The clamp makes `end == total` exact by construction — `end` cannot exceed `total`, so the comparison is precisely "this page reached the end". `campaigns` is written only by `campaigns.push(distributor)` at :184 inside `createCampaign`.

**Why no exploit path.** No path. Neither side is externally writable to a near-miss value: an attacker can only grow `campaigns.length` by creating a real campaign (which costs a funded token transfer at :193 and moves both sides together), and `end` is derived from caller-supplied `offset`/`limit` that are already bounded by the clamp and by the early return at :309. The function is `external view` and returns a page plus a cursor — nothing branches on it on-chain.

**Action.** Suppress in place, no code change. Above :316 add: `// Pagination cursor over an array length; `end` is clamped to `total` at :311 so the equality is exact by construction.` then `// slither-disable-next-line incorrect-equality`.

### [FALSE_POSITIVE] `incorrect-equality` — contracts/src/TegridyFeeExecutorRouter.sol:353  _(if real: low)_

**Reasoning.** `amountOut` reaching `_payout` is the caller's own measured output delta — `_selfBalance(tokenOut) - outBefore` at :268 (swapERC20) and :306 (swapNative), against `outBefore` read at :260 and :302, all inside `nonReentrant` calls (:240, :288). The zero branch merely skips a zero-value transfer or WETH wrap. Both callers have ALREADY enforced `amountOut >= minOut` (:269, :307) before calling, so the value arriving here has passed the caller's own bound.

**Why no exploit path.** No path. A zero here means the caller passed `minOut == 0` and received nothing — identical in outcome to the other branch, which would transfer 0. An attacker cannot force someone else's `amountOut` to 0 because each swap's delta is measured inside one nonReentrant call; forcing it non-zero requires actually delivering tokenOut to the router, which is then paid straight out to the recipient at :355/:357.

**Action.** Suppress in place, no code change. Above :353 add: `// Skips a zero-value transfer; callers already enforced amountOut >= minOut at :269 and :307 before reaching here.` then `// slither-disable-next-line incorrect-equality`.

### [FALSE_POSITIVE] `incorrect-equality` — contracts/src/vaults/TegridyHarvestVault.sol:368  _(if real: medium)_

**Reasoning.** Unreachable, provably. `toConvert = rewards - fee` (:367) with `rewards >= 1` guaranteed by the guard at :364, and `fee = (rewards * bps) / BPS_DENOMINATOR` (:424) with `bps <= MAX_PERFORMANCE_FEE_BPS = 1000` (:110). That cap is enforced at both and only writers of `performanceFeeBps` — the propose path at :458 and the execute path at :471-472. So `fee <= rewards / 10 < rewards` and `toConvert >= 1` for every reachable input. Dead branch.

**Why no exploit path.** No path — no input makes `toConvert` zero while the 10% cap holds. Recorded as a latent hazard rather than a live bug: IF that cap were ever raised to 10000, this branch would `return 0` AFTER `_chargePerformanceFee` had already transferred the fee out at :427 and incremented `totalFeesCharged` at :426, banking a full fee against nothing compounded — precisely the outcome the comment at :383-385 says the design forbids (it explains that the sibling guard reverts rather than returns so a dust harvest can never charge a fee against nothing).

**Action.** Suppress in place, no code change. Above :368 add: `// Unreachable while MAX_PERFORMANCE_FEE_BPS is 1000 (:110, enforced at :458 and :471); kept because a 100% cap would make this return 0 after the fee at :427 already left.` then `// slither-disable-next-line incorrect-equality`. Human decision worth taking now: either drop the dead branch or add that cap-coupling comment, so a future cap change cannot silently convert it into a fee-against-nothing path.

### [FALSE_POSITIVE] `incorrect-equality` — contracts/src/v2/StreamingRevenueDistributor.sol:461  _(if real: low)_

**Reasoning.** The one non-zero comparison in the group, so I checked it hardest. LHS `effectiveBalanceOf[account]` is written only by this contract at :414 inside `_updateReward`. RHS `_effectivePower` (:435-453) resolves to TegridyStaking.votingPowerOf → StakingViewLib.votingPowerOf (:90-103 of contracts/src/lib/StakingViewLib.sol), which sums `(amount * boostBps) / BOOST_PRECISION` over positions where `nowTs < p.lockEnd` — a STEP function, constant between stake/boost/lockEnd events, NOT a per-second decay. The restaking fallback is `_boostedAmountAt` (contracts/src/TegridyRestaking.sol:684+), an OZ checkpoint `upperLookup`, also piecewise-constant. So both sides are the same unit, the equality is stable between events, and it means exactly what its name says. Grep across contracts/ finds no on-chain caller: only contracts/test/v2/StreamingRevenueDistributor.t.sol:235-240, which asserts false-before-sync and true-after, and a frontend note in contracts/script/DeployStreamingDistributor.s.sol:47.

**Why no exploit path.** No path. `external view` with zero on-chain consumers, so no state transition branches on the result and there is nothing to corrupt by flipping it. A caller can flip it only for their own account by changing their own staking position — which is precisely the desync the view exists to report. I also checked the 0 == 0 case: an address that never staked reads true, which is correct (its mirror does match reality), while the case the natspec at :455-459 actually cares about — staked but never synced — has power > 0 against a zero mirror and correctly reads false.

**Action.** Suppress in place, no code change. Above :461 add: `// Mirror-vs-source comparison in the same unit; votingPowerOf is a step function (StakingViewLib:100), not a decaying one, and this view has no on-chain consumers.` then `// slither-disable-next-line incorrect-equality`.

### [FALSE_POSITIVE] `incorrect-equality` — contracts/src/vaults/TegridyHarvestVault.sol:425  _(if real: low)_

**Reasoning.** `fee = (rewards * bps) / BPS_DENOMINATOR` (:424) is a pure product of a balance and an owner-set constant capped at 1000 (:110). The zero branch (`return 0`) is behaviourally IDENTICAL to falling through with fee 0: the fall-through would execute `totalFeesCharged += 0` (:426) and `safeTransfer(recipient, 0)` (:427). Nothing is protected by the comparison, so no manipulation of `rewards` can produce a different outcome through it.

**Why no exploit path.** No path. Both branches yield fee == 0 and the same resulting state. A griefer nudging `rewards` upward by donating changes the fee MAGNITUDE, not which branch protects value — a larger `rewards` produces a larger fee, never a skipped one. The only way to reach the zero branch is a rewards amount so small the fee truncates, and truncated-to-zero is what the branch reports.

**Action.** Suppress in place, no code change. Above :425 add: `// Rounding short-circuit; falling through would transfer 0 and add 0, so this branch is a gas saving with no protective role.` then `// slither-disable-next-line incorrect-equality`.

### [FALSE_POSITIVE] `incorrect-equality` — contracts/src/TegridyLockVault.sol:167  _(if real: low)_

**Reasoning.** Same structure as finding 21 in the sibling function. `received` is a delta computed by this contract: balanceBefore at :164, safeTransferFrom at :165, balanceAfter at :166, inside a `nonReentrant` call (:145). The measured delta — not the caller's `amount` — is what gets stored as the lock's principal at :175 and added to `totalLocked` at :177, so the fee-on-transfer case records the truth rather than the request.

**Why no exploit path.** No path. A prior-transaction donation is captured by `balanceBefore` at :164 and cancels in the subtraction. A same-transaction donation would require a token callback during safeTransferFrom and would only credit the depositor with tokens someone actually delivered. Driving `received` to 0 means the caller's own transfer did not arrive, which SafeERC20 reverts on first; and the zero branch itself reverts NoFundsReceived, so the guard fails closed.

**Action.** Suppress in place, no code change. Above :167 add: `// `received` is a delta of two self-reads inside one nonReentrant call; a donation lands in both and cancels.` then `// slither-disable-next-line incorrect-equality`.

### [FALSE_POSITIVE] `incorrect-equality` — contracts/src/v4/TegridyFeeLocker.sol:245  _(if real: low)_

**Reasoning.** `amount` arrives as `amount0`/`amount1`, deltas measured across the `modifyLiquidities` call — `before0`/`before1` at :216-217, differenced at :229-230, passed in at :232-233. A balance already sitting in the contract before the call is captured by both reads and cancels. The zero branch (`return`) is behaviourally identical to running the loop with amount 0: every computed `share` would be 0, the `share > 0` guard at :258 would credit nothing, and the last-beneficiary remainder `amount - distributed` at :253 would also be 0.

**Why no exploit path.** No path through this equality — both branches leave `claimable` untouched when the collect returned nothing, so there is no gate to open or close. (Separate concern, outside this detector and outside the 48 findings, flagged in groupNotes: `collect` at :209 carries no `nonReentrant` while the delta at :229-230 is taken against the contract's TOTAL balance in that currency, shared across all locks. That is a reentrancy question about the delta's provenance, not about this `== 0` comparison, and it needs a human on the V4 hook call path.)

**Action.** Suppress in place, no code change. Above :245 add: `// Delta measured across the collect at :216-217/:229-230; the loop below is a no-op for amount 0 anyway, so this is a gas short-circuit.` then `// slither-disable-next-line incorrect-equality`. Separately, route the `collect` reentrancy question in groupNotes to whoever owns the reentrancy cluster.

### [FALSE_POSITIVE] `incorrect-equality` — contracts/src/LockerClaimer.sol:207  _(if real: low)_

**Reasoning.** `amount = address(this).balance` (:206) is forcibly increasable — selfdestruct and coinbase payments bypass any receive hook — so the value is nudgeable in the raise direction. But the destination is fixed and singular: `revenueDistributor` at :208, and this function forwards the WHOLE balance unconditionally. The zero branch is a documented silent no-op so a keeper batching `claim` across several positions is not reverted by an empty one (:199-204), and a failed push reverts the entire transaction at :209 so credit is never consumed without the ETH arriving.

**Why no exploit path.** No path. Raising the balance routes the attacker's own ETH to the same immutable revenue distributor it was always going to. Lowering it to suppress a forward is impossible — this function is the only ETH exit, and no third party can withdraw from it. Neither branch has a second destination or a caller-supplied recipient.

**Action.** Suppress in place, no code change. Above :207 add: `// Whole-balance forward to an immutable sink; donating to flip this branch only sends the donor's ETH to that same sink.` then `// slither-disable-next-line incorrect-equality`.

### [FALSE_POSITIVE] `incorrect-equality` — contracts/src/v2/StreamingRevenueDistributor.sol:365  _(if real: low)_

**Reasoning.** `totalEffectiveSupply` is not a token balance and not a supply anyone can mint into — it is a mirror sum written exclusively by this contract at :413 (`totalEffectiveSupply = totalEffectiveSupply - oldEff + newEff`) inside `_updateReward`. No external party can donate into it. The comparison is the division-by-zero guard for the `/ totalEffectiveSupply` at :367, paired with the empty-period forfeit branch at :390-398 that deliberately does not bank emission while nobody is staked.

**Why no exploit path.** No path. Moving it to zero requires every mirrored account's veTOWELI power to be zero, and no caller can zero another account's power — `_updateReward` only ever recomputes the power of the account passed to it, from that account's own staking position. Moving it off zero requires actually holding boosted stake. `== 0` here is a total partition with `> 0`, so there is no near-miss value to engineer.

**Action.** Suppress in place, no code change. Above :365 add: `// Div-by-zero guard on a mirror sum written only by _updateReward at :413; not a donatable balance.` then `// slither-disable-next-line incorrect-equality`.

### [FALSE_POSITIVE] `incorrect-equality` — contracts/src/AirdropFactory.sol:195  _(if real: low)_

**Reasoning.** `funded` is a self-measured delta on the just-deployed distributor: balanceBefore at :192, safeTransferFrom at :193, balanceAfter at :194, inside a `nonReentrant` call (:158). The authors' own comment at :189-191 states the intent — measure rather than assume, so the event carries the truth for fee-on-transfer tokens. The factory itself custodies no funds; tokens go straight to the campaign contract.

**Why no exploit path.** No path. The distributor is a deterministic CREATE address and can be pre-funded, but `balanceBefore` is read at :192, AFTER the deployment at :177-179, so pre-funding sits in both reads and cancels. A same-transaction donation via a token callback would have to actually deliver tokens into the campaign, increasing what claimants can draw. The zero branch reverts NoFundsReceived, so it fails closed.

**Action.** Suppress in place, no code change. Above :195 add: `// Delta of two self-reads around the funding transfer; pre-funding the CREATE address is captured by balanceBefore at :192.` then `// slither-disable-next-line incorrect-equality`.

### [FALSE_POSITIVE] `incorrect-equality` — contracts/src/v2/StreamingRevenueDistributor.sol:495  _(if real: low)_

**Reasoning.** `owed = rewards[account]` (:494) is contract-written state with exactly two writers, both in this file: `rewards[account] = earned(account)` at :407 inside `_updateReward`, and `rewards[account] = 0` at :501 in this same function. No balance, no external write path. The comparison is an early return meaning "this account has nothing crystallised to recycle", ahead of the three further conditions at :496-499 (still restaked, still inside grace).

**Why no exploit path.** No path. An attacker cannot write another account's `rewards` entry — `_updateReward(account)` computes it from that account's own mirrored balance and the global accumulator. Flipping the branch by making `owed` non-zero requires the account to have genuinely accrued, and reaching the recycle below still requires `effectiveBalanceOf[account] == 0` (:493), not restaked (:496), and past the grace window (:499). The recycled wei goes back to the staker pool (:502), never to a treasury.

**Action.** Suppress in place, no code change. Above :495 add: `// rewards[account] is written only at :407 and :501 in this contract; zero means nothing crystallised to recycle.` then `// slither-disable-next-line incorrect-equality`.

### [REAL_BUT_ACCEPTED] `incorrect-equality` — contracts/src/vaults/TegridyHarvestVault.sol:386  _(if real: low)_

**Reasoning.** The second genuine one. Both operands are RAW balanceOf reads on tokens anyone can transfer in — `rewardSide` at :381, `pairedSide` at :382 — so the detector's premise holds and I am not dismissing it. What bounds it is that manipulation is one-directional: an outsider can only RAISE a balance, never lower it, so the only reachable effect is opening this gate, never closing it to block a legitimate harvest. Standing behind the gate is `minLpOut` checked at :404 plus `minPairedOut` on the swap at :378, both supplied by an allow-listed keeper (`onlyKeeper`, :355).

**Why no exploit path.** Griefing and ratio-skew only, no extraction. Donating 1 wei of pairedToken while `rewardSide` is dust lets the call past :386 into `addLiquidity` (:394-403) at a badly skewed ratio; the LP actually minted is then measured against `minLpOut` at :404, so a keeper passing a real minimum reverts safely and only a keeper passing 0 is exposed — and the vault's own natspec at :340-346 already argues that slippage bounds from an untrusted source are not bounds, which is why the trigger is allow-listed. In the other direction there is no path at all: forcing either side to 0 to block harvest would require removing tokens from the vault, and only `_chargePerformanceFee` (:427) and the router approvals move them. Who bounds it: the keeper allow-list, and `minLpOut`.

**Action.** Accept, no comparison change. Above :386 add: `// Raw donatable balances; a third party can only open this gate, never close it, and minLpOut at :404 is the bound that actually protects depositors.` then `// slither-disable-next-line incorrect-equality`. Human decision for a separate PR, not this triage: reject `minLpOut == 0` in the signature so an allow-listed keeper cannot disable the one remaining bound — that is the durable fix and it is a contract change.


## Group: `unused-return-and-math`

9 findings triaged: 6 unused-return (42-47), 2 divide-before-multiply (6, 7), 1 reentrancy-no-eth (5). All 9 come out FALSE_POSITIVE, and I am uneasy handing back a clean sweep, so here is exactly what each proof rests on and where a human should still look.

THE THREE LOAD-BEARING PROOFS (each is a code fact, not a "slither is noisy" claim):

1. id 44 (`router.swapExactTokensForTokens` return ignored) hinged entirely on whether `minPairedOut` is enforced anywhere. It is: contracts/src/TegridyRouter.sol:237 — `if (amounts[amounts.length - 1] < amountOutMin) revert InsufficientOutputAmount();` — inside the router, before any transfer. Had that line not existed, the harvest swap would have had NO slippage bound at all and this would have been the real version of the detector. I checked it specifically because that is the failure mode the group brief describes.

2. id 42 (`vault.repay` return ignored) hinged on whether the vault can apply less than it was handed. It cannot, at this call site: NftfiPooledLendingVault.repay:386 computes `paid = amount > due ? due : amount` where `due` is taken AFTER `_accrue`, and `_accrue` (561-565) adds exactly `_pendingInterest` (539-544) — the same quantity `quoteRepay` (409-413) already folded in eleven lines earlier in the same transaction. So `due == principalDue + interestDue` and NftfiBnpl passes `principalLeg + interestDue` with `principalLeg <= principalDue` (NftfiBnpl.sol:326). amount <= due always; repay pulls exactly amount. This matters because NftfiBnpl has NO token-rescue function — any WETH the vault declined to apply would be stranded permanently. The invariant holds, but it is proved rather than enforced, which is why I recommend the one-line assert instead of a suppression.

3. id 5 (reentrancy-no-eth) hinged on which functions can write `escrowRewardsOwed` during `staking.claimUnsettled()`. Grep across contracts/ gives exactly three write sites — TegridyPositionMarket.sol:469, 492, 524 — reachable only via `cancel` (324), `fill` (354), `kickEscrowed` (516), `claimEscrowRewards` (482), every one of them `nonReentrant` off the single OZ ReentrancyGuard lock. The stale-read-then-absolute-write at 483/492 therefore cannot be raced. The only unguarded reader is the compiler-generated getter for the `public` mapping at line 180 — which is why slither's "cross function reentrancies" list names the VARIABLE and no function at all. It is a view; it cannot write. No non-test on-chain consumer of that getter exists in the repo.

WHAT I AM NOT CLAIMING: none of these verdicts rest on "it's behind onlyOwner" or on the stale `_scope` note in contracts/slither.config.json. I did not inherit that file's 2026-05-31 FP conclusions; none of the six files here appear in its evidence list. Four of the nine (43, 46, 47, and the divide-before-multiply pair) are the genuinely cheap kind: partial tuple destructuring of a public getter where the used fields are used, and a remainder-correction idiom that is the fix for precision loss rather than an instance of it.

ONE THING A HUMAN SHOULD DECIDE, ADJACENT TO id 45 AND NOT DETECTED BY IT: TegridyHarvestVault.harvest re-reads the FULL rewardToken balance at line 363 and runs `_chargePerformanceFee(rewards)` over it. Reward tokens that addLiquidity did not consume on the previous harvest are still sitting there, so they are fee-charged a second time, and `totalHarvested += rewards` (411) double-counts them. The code acknowledges the rollover at lines 360-362 and calls it yield; it is not, it is already-fee'd principal-of-yield. The effect is bounded by MAX_PERFORMANCE_FEE_BPS (10%) applied to a leftover that is typically well under 1% of a harvest, and the remedy is a fee watermark, not capturing addLiquidity's return — so it does not change my verdict on id 45. Flagging it because it is the only thing in this group that looked like a defect once I had the file open.

CI CONSEQUENCE: suppressing all 9 as directed removes them from the `fail-on: medium` gate without silencing a detector globally. Seven of the nine want a one-line `slither-disable-next-line` at a specific line; two (42, 44/45's sibling concern) are better served by turning the proof into an assert. Per-line suppressions keep the detector live for every other call site in the repo, which the config's blanket `detectors_to_exclude` does not.

PLACEMENT CAVEAT for ids 6 and 7: both anchor on the FUNCTION `quote` (source mapping 214-240, hence the reported line 214), not on the division at 232. A `slither-disable-next-line` must therefore sit immediately above line 214 — between the closing natspec line 213 and the declaration — which can detach the natspec block from the function in solc's devdoc output. Prefer wrapping with `// slither-disable-start divide-before-multiply` / `// slither-disable-end` placed before the natspec block at line 201. One suppression covers both findings; they are the same division reported through two different multiplication sites.

Read-only throughout: no .sol file was edited, nothing committed, nothing pushed.

### [FALSE_POSITIVE] `reentrancy-no-eth` — contracts/src/markets/TegridyPositionMarket.sol:482  _(if real: high)_

**Reasoning.** claimEscrowRewards (482-496) does read `owed` at 483 BEFORE the external call at 486 and then performs an ABSOLUTE write `escrowRewardsOwed[msg.sender] = owed - paid` at 492 after it. That shape is genuinely dangerous, so the question is only whether anything can change that slot during `staking.claimUnsettled()` (505). Grep over all of contracts/ returns exactly three write sites for escrowRewardsOwed in this contract: 469 (in the private `_release`), 492 (here), 524 (in `kickEscrowed`). `_release` is private and reachable only from `cancel` (324, nonReentrant) and `fill` (354, nonReentrant); `kickEscrowed` is nonReentrant (516); this function is nonReentrant (482). All four sit on the single OZ ReentrancyGuard lock imported at line 4 and inherited at 118, and this function holds that lock across 486. A reentrant call into any writer reverts, and because the reentry happens inside staking, the revert is caught by the try/catch at 505 and rolls back everything the callee did — so the swallow cannot leave a half-applied credit either. The 'cross function reentrancies' list in the finding names only the variable declaration at line 180 and no function, which is slither's signature for the compiler-generated getter of a `public` mapping being the reentrant reader. That getter is a view and cannot write, and grep shows no non-test on-chain consumer of it. The payout itself is already CEI-correct: 492 and 493 precede the transfer at 494. totalEscrowRewardsOwed -= paid at 493 cannot underflow because paid <= owed <= the sum, and every += at 469/524 is paired with a += to the total at 470/525.

**Why no exploit path.** No path. Draining requires escrowRewardsOwed[msg.sender] to be incremented between the SLOAD at 483 and the SSTORE at 492, which would make 492 overwrite the new credit (a loss to the seller, not a gain to the attacker) or, run the other way, requires a second claim to observe the pre-decrement value and pay twice. Both need reentry into cancel/fill/kickEscrowed/claimEscrowRewards while claimEscrowRewards holds the single nonReentrant lock; all four carry the modifier, so every such attempt reverts inside the try at 505 and rolls back. The only reader that runs unguarded is the auto-generated public getter for the mapping at line 180, which is a view function and writes nothing, and no contract in this repo reads it.

**Action.** Suppress, do not modify the code. Insert directly above line 482 (`function claimEscrowRewards() external nonReentrant returns (uint256 paid) {`):

    // SLITHER: every writer of escrowRewardsOwed (469/492/524) is behind the same nonReentrant lock this function holds, so the pre-call read at 483 cannot go stale; the only unguarded reader is the public mapping's auto-getter, which is a view.
    // slither-disable-next-line reentrancy-no-eth

Matching the house pattern already used at contracts/src/TegridyRestaking.sol:1099-1100 and contracts/src/TegridyRouter.sol:383-384 (rationale comment, then the disable line). Note the function-level anchor: if slither still reports after this, move the pair to sit immediately above line 486 (`_pullUnsettled();`) instead. Re-run slither on this file alone to confirm the finding clears before assuming the gate is green.

### [FALSE_POSITIVE] `divide-before-multiply` — contracts/src/nftfi/NftfiBnpl.sol:214  _(if real: medium)_

**Reasoning.** The flagged pair is `slice = financedWei / INSTALMENTS` (232) feeding `principalForLeg = financedWei - slice * (INSTALMENTS - 1)` (235). INSTALMENTS is a constant 3 (line 87). Write financedWei = 3q + r with q = slice = floor(financedWei/3) and r in {0,1,2}. The three legs the loop produces are q, q, and financedWei - 2q = q + r. Their sum is exactly 3q + r = financedWei, for every r, with zero wei lost. This is not an instance of precision loss; it is the standard remainder-correction idiom whose entire purpose is to prevent the loss that `slice * INSTALMENTS` would cause (that form would understate the total by r wei). The quote also matches the schedule the contract actually enforces: openPlan stores principalPerInstalment = financedWei / INSTALMENTS (303) — the same q — and payInstalment pays legs 1 and 2 at q (325) while the final leg takes `principalDue`, the whole remaining principal (325, `next >= INSTALMENTS ? principalDue : p.principalPerInstalment`), which is q + r. So the r wei lands on the last instalment in both the quote and the money path, and they agree. Losing the divide-before-multiply here would break that agreement, not fix it.

**Why no exploit path.** No path, and the loss is provably zero rather than merely small. Arithmetic: legs are q, q, financedWei - 2q; sum = financedWei exactly for r in {0,1,2}. Concretely at the repo's own pinned vector (contracts/test/nftfi/NftfiBnpl.t.sol:86-91), price 4 ether gives financedWei = 3e18, r = 0, legs 1e18/1e18/1e18. At a worst-case r=2 — e.g. priceWei = 50000000000000002 wei, depositBps 2500, financedWei = 37500000000000002 — legs are 12500000000000000, 12500000000000000, 12500000000000002: sum 37500000000000002, exact. No wei is stranded and no wei is over-collected on any input.

**Action.** Suppress. Both this finding and id 7 anchor on the function `quote` (source mapping 214-240), so ONE suppression clears both. Insert before the natspec block at line 201, and close it after line 240:

    // SLITHER: `slice` is divided first on purpose — the last leg takes `financedWei - slice*(INSTALMENTS-1)` so the remainder is carried rather than truncated, and the three legs sum to financedWei exactly.
    // slither-disable-start divide-before-multiply
    ... natspec + function quote ...
    // slither-disable-end

Use the start/end pair rather than `// slither-disable-next-line divide-before-multiply` above line 214: a line comment wedged between the closing natspec at 213 and the declaration at 214 can detach the natspec from the function in solc's devdoc output. Do not restructure the arithmetic — hoisting the multiplication would move the remainder off the final instalment and desynchronise quote() from payInstalment().

### [FALSE_POSITIVE] `divide-before-multiply` — contracts/src/nftfi/NftfiBnpl.sol:214  _(if real: low)_

**Reasoning.** Same division at 232 (`slice = financedWei / INSTALMENTS`), reported through the interest accumulation at 236: `acc += (principalForLeg * apr * (k * INSTALMENT_INTERVAL)) / (365 days * BPS)`. Note the shape of 236 itself is correct — all multiplications happen before the single division. The only divide-before-multiply is slice, and its effect on the interest total is bounded and sub-wei. Exact comparison against ideal rational thirds: the actual principal-weighted sum over the loop is q*1 + q*2 + (q+r)*3 = 6q + 3r, while exact thirds give (financedWei/3)*(1+2+3) = 2*financedWei = 6q + 2r. The divergence is r units of principal carried at the k=3 rate, i.e. r * apr * 90 days / (365 days * BPS) wei. The repo's own pinned vector fixes apr: contracts/test/nftfi/NftfiBnpl.t.sol:86-91 asserts interest = 73972602739726026 on financedWei = 3e18, which back-solves to aprBps = 1500. At apr 1500 and worst case r = 2 that divergence is 2 * 1500 * 7776000 / (31536000 * 10000) = 0.074 wei — below one wei, so it can shift the floored result by at most 1 wei and usually by 0. Even at an absurd apr of 10000 bps it is 0.49 wei. Beyond being negligible it is also not a money path: interestWei has exactly one on-chain consumer, openPlan at line 266, which destructures `(depositWei, financedWei, originationWei,,)` and discards interestWei and totalWei entirely. Nothing charges a buyer from this number; payInstalment reads live interest from vault.quoteRepay (321). The natspec at 204-208 already labels it an estimate, and the test at 105-118 pins it against real payments with a 3-wei tolerance that the vault's own per-instalment flooring dominates.

**Why no exploit path.** No path. Worst-case divergence from exact-rational arithmetic is under 1 wei on `interestWei` (0.074 wei at the deployed apr of 1500 bps with r=2; 0.49 wei at a 100% APR), and `interestWei` never moves funds — openPlan (266) discards it, and every actual instalment charge is recomputed live by vault.quoteRepay (321) against elapsed time. A caller cannot steer r either: r = financedWei mod 3 is a deterministic function of the seller's listed price and the owner's depositBps, and shifting it changes the displayed estimate by at most one wei in the buyer's own favour or against it, with no corresponding change in what is charged.

**Action.** Already covered — the single `slither-disable-start divide-before-multiply` / `slither-disable-end` pair around `quote` described for id 6 suppresses both findings, since both carry the same function-level source mapping (214-240). Do not add a second suppression. If a reviewer wants belt-and-braces on the estimate itself, the correct change is documentary, not arithmetic: the natspec at 204-208 could state that interestWei may differ from the realised total by a few wei from per-leg flooring.

### [FALSE_POSITIVE] `unused-return` — contracts/src/nftfi/NftfiBnpl.sol:319  _(if real: medium)_

**Reasoning.** `NftfiPooledLendingVault.repay(uint256,uint256)` (380) returns `uint256 paid` — the amount it ACTUALLY applied, computed at 386 as `paid = amount > due ? due : amount`. So the return matters only if `due` can be less than the amount handed over, in which case the vault pulls only `due` at 387 and the excess stays in NftfiBnpl — which would be permanent, since NftfiBnpl has no sweep or rescue function anywhere in the file. It cannot happen at this call site. In repay, `due = loan.accruedInterest + loan.principal` (385) is read after `_accrue(loan)` (383), and _accrue (561-565) adds exactly `_pendingInterest(loan)` (539-544). Eleven lines earlier in the same transaction, payInstalment called `vault.quoteRepay(p.loanId)` (321), which returns principal = loan.principal and interest = loan.accruedInterest + _pendingInterest(loan) (409-413) — the identical quantity, at the identical block.timestamp, off the identical storage. Therefore due == principalDue + interestDue. What payInstalment passes is `paid = principalLeg + interestDue` (327) where principalLeg is clamped to principalDue at 326 (`if (principalLeg > principalDue) principalLeg = principalDue;`). Hence amount <= due unconditionally, the vault applies the full amount, and the ignored return is provably equal to the argument. Nothing can intervene between 321 and 332: payInstalment is nonReentrant (319), vault.repay is nonReentrant (380), and the only external call in between is WETH transferFrom/approve on the immutable `_weth` set at construction and cross-checked against vault.asset() at 163. Degenerate cases are covered too — a fully cleared loan is rejected at 322, and principalLeg is non-zero because MIN_PRICE 0.05 ether with depositBps capped at 8000 leaves financedWei >= 0.01 ether, so principalPerInstalment > 0.

**Why no exploit path.** No path. For the ignored return to matter, vault.repay would have to apply less than it was passed, stranding WETH in NftfiBnpl (which has no rescue function, so it would be permanent). That requires due < amount, i.e. principalDue + interestDue < principalLeg + interestDue, i.e. principalLeg > principalDue — explicitly excluded by the clamp at NftfiBnpl.sol:326. The two figures are computed from the same loan storage at the same timestamp by two functions that fold in the same _pendingInterest term, so they cannot drift within one transaction, and both entry points are nonReentrant.

**Action.** Preferred: turn the proof into an enforced invariant rather than suppressing. Replace line 332 `vault.repay(p.loanId, paid);` with a checked form — capture the return into a local (e.g. `uint256 applied = vault.repay(p.loanId, paid);`) and revert if `applied != paid`, reusing a typed error. This costs one comparison, removes the finding outright, and closes the permanent-stranding consequence that exists because NftfiBnpl has no rescue path — worth it on a money path even though the invariant holds today. If a code change is off the table, insert directly above line 332:

    // SLITHER: repay's return is the amount applied; quoteRepay at 321 and _accrue at vault 383 fold in the same _pendingInterest term at the same timestamp, so due >= paid always and the vault applies the full amount.
    // slither-disable-next-line unused-return

### [FALSE_POSITIVE] `unused-return` — contracts/src/TegridyRestakingAdmin.sol:212  _(if real: low)_

**Reasoning.** This is partial tuple destructuring of a public-mapping getter, not a discarded status code. `restaking.restakers(address)` returns the six fields of RestakeInfo (TegridyRestaking.sol:140-150): tokenId, positionAmount, boostedAmount, bonusDebt, depositTime, unsettledSnapshot. Line 213 binds tokenId and discards five, and tokenId is then used at 214 (`if (tokenId == 0) revert NotRestaked();`) — the only thing this function needs. There is no ERC20 success bool and no amount here; a getter cannot fail silently. The five discarded fields are irrelevant to a propose-side existence check: the function only records a pending attribution (216) and starts the timelock (217). The natspec at 208-211 is explicit that this check is advisory and can go stale across the 24h window, and that `host.applyAttributeStuckRewards` re-checks it and recomputes the F-2 unattributed cap against LIVE host balances at execute time — so even a wrong answer here cannot authorise a bad transfer. One of the discarded fields, unsettledSnapshot, is documented at TegridyRestaking.sol:146-149 as permanently 0 post-fix, retained only for ABI compatibility.

**Why no exploit path.** No path. The one value the function needs, tokenId, is bound and used at 214. The five discarded fields feed no branch, no arithmetic and no transfer in this function, which writes only `pendingAttribution` (216) and the timelock stamp (217). The consequential re-check happens host-side at execute time against live balances (natspec 208-211), so a stale or ignored propose-side read cannot move value.

**Action.** Suppress. Insert directly above line 213 (`(uint256 tokenId,,,,,) = restaking.restakers(_restaker);`):

    // SLITHER: intentional tuple destructure; only tokenId is needed for this advisory pre-check and the host re-validates at execute time.
    // slither-disable-next-line unused-return

This is verbatim the pattern the repo already uses for the same situation at contracts/src/TegridyRestaking.sol:1099-1101.

### [FALSE_POSITIVE] `unused-return` — contracts/src/vaults/TegridyHarvestVault.sol:352  _(if real: high)_

**Reasoning.** This is the one finding in the group that could have been real, so I checked the enforcement rather than assuming it. The discarded return is `uint256[] memory amounts` from IHarvestRouter.swapExactTokensForTokens (declared at 31-37). If nothing enforced minPairedOut, the harvest swap would have had no slippage bound at all. It is enforced, inside the router, before any token moves: contracts/src/TegridyRouter.sol:236-237 computes `amounts = getAmountsOut(amountIn, path)` and then `if (amounts[amounts.length - 1] < amountOutMin) revert InsufficientOutputAmount();`. The call reverts rather than returning a short amount, so the caller has nothing to inspect. The vault also does not need the figure: at 381-382 it re-reads `rewardToken.balanceOf(address(this))` and `pairedToken.balanceOf(address(this))` and works from realised balances, which is strictly more truthful than a returned quote (it also picks up any rollover dust). Those balances are then bounded again by `minLpOut` at 404. The router is immutable (119, assigned at 200) and cross-checked at construction — WETH() at 207 against the LP's two legs at 208-220, reverting PairLegMismatch otherwise — so it is not an owner-swappable target. Even a misbehaving router cannot silently under-deliver: taking the approved rewards and returning nothing leaves pairedSide == 0 and the harvest reverts NothingToCompound at 386. The comment at 376-377 already states the intent correctly — the deadline is a staleness guard and minPairedOut is the only price protection.

**Why no exploit path.** No path. The sandwich the natspec at 340-346 worries about is blocked twice over: harvest is onlyKeeper (355, modifier at 177-180) so an untrusted caller cannot supply minPairedOut = 0, and the bound that is supplied is enforced by a revert at TegridyRouter.sol:237 before any transfer, so no execution continues past a bad price. The discarded `amounts` array is redundant with the balance reads at 381-382, and the value that actually determines what depositors receive, lpCompounded, is separately bounded at 404.

**Action.** Suppress. Insert directly above line 378 (`router.swapExactTokensForTokens(swapAmount, minPairedOut, path, address(this), block.timestamp);`):

    // SLITHER: the returned amounts array is redundant — minPairedOut is enforced router-side (TegridyRouter.sol:237 reverts InsufficientOutputAmount), and 381-382 read realised balances rather than trusting a quote.
    // slither-disable-next-line unused-return

Do not silence `unused-return` repo-wide in slither.config.json to clear this; the per-line form keeps the detector live for call sites where an ignored amountOut would be real.

### [FALSE_POSITIVE] `unused-return` — contracts/src/vaults/TegridyHarvestVault.sol:352  _(if real: medium)_

**Reasoning.** Partial destructure: `(,, lpCompounded) = router.addLiquidity(...)` at 394-403 binds `liquidity` and discards `amountA`/`amountB` (interface at 38-47). The value that governs what depositors receive IS captured and IS checked — `if (lpCompounded < minLpOut) revert SlippageTooHigh();` at 404 — which is the opposite of the failure mode this detector describes. The discarded amountA/amountB are the amounts of reward/paired token the router actually consumed; the unconsumed remainder of whichever leg was over-supplied simply stays in the vault, exactly as the comment at 390-393 says. Nothing downstream needs those figures: totalAssets() (241-243) is `asset().balanceOf(this) + farm.rawBalanceOf(this)`, i.e. LP only, so unconverted reward/paired dust is deliberately outside the share price (natspec 234-239); totalHarvested (411) is keyed off `rewards`; _deployIdle (414, 303-317) re-reads the LP balance itself. The leftovers are not stranded either — the next harvest reads full balances at 363 and 382 and folds them in. The router is immutable and constructor-validated (200, 207-220), and a router that minted nothing would trip the minLpOut check at 404 or fail the `liquidity > 0` require in TegridyRouter.sol:129.

**Why no exploit path.** No path via the ignored returns. amountA/amountB feed no branch, no accounting and no transfer in this contract: the share price (241-243) counts LP only, and the LP figure that sets it is captured in lpCompounded and floor-checked at 404. Un-consumed reward/paired remainder stays in the vault and is swept into the next harvest by the full-balance reads at 363 and 382, so no value escapes and none is stranded.

**Action.** Suppress. Insert directly above line 394 (the `(,, lpCompounded) = router.addLiquidity(` statement):

    // SLITHER: intentional partial destructure — lpCompounded is the only consequential return and is bounded at 404; the discarded amountA/amountB are leg remainders that stay in the vault and roll into the next harvest.
    // slither-disable-next-line unused-return

SEPARATELY, and not as a fix for this finding, put in front of a human: because 363 re-reads the FULL rewardToken balance, reward tokens that addLiquidity did not consume on the previous harvest are passed through _chargePerformanceFee (366, 420-428) a second time, and totalHarvested (411) double-counts them. The comment at 360-362 treats that rollover as fresh yield; it is already-fee'd yield. Bounded by MAX_PERFORMANCE_FEE_BPS (110) on a typically sub-1% remainder, and the remedy is a fee watermark, not capturing addLiquidity's return — so it should be tracked as its own item rather than folded into this suppression.

### [FALSE_POSITIVE] `unused-return` — contracts/src/RestakingMonitorView.sol:43  _(if real: low)_

**Reasoning.** Partial destructure of the six-field getter declared at line 5: `(uint256 tokenId,,, int256 bonusDebt,,) = r.restakers(_user)` at 45 binds the two fields the calculation needs and discards positionAmount, boostedAmount, depositTime and unsettledSnapshot. Both bound values are used — tokenId at 46 (`if (tokenId == 0) return 0;`) and bonusDebt at 67 (`int256 diff = accumulated - bonusDebt;`). Each discarded field is not merely unneeded but correctly avoided. boostedAmount is the CACHED boost, which goes stale as boost decays; the function deliberately reads `r.boostedAmountAt(_user, block.timestamp)` at 65 instead, and TegridyRestaking._boostedAmountAt (689-696) shows why that is a strict improvement — it falls back to info.boostedAmount only when no checkpoint exists, otherwise using the checkpointed value. Using the raw cached field here would be the bug. depositTime is already consumed inside _boostedAmountAt at 689. unsettledSnapshot is documented at TegridyRestaking.sol:146-149 as always 0 post-fix, kept only for ABI compatibility. positionAmount is principal and plays no part in bonus accrual, which is boost-weighted. This is a `view` function with no state and no transfers, and the contract natspec at 20-27 records that it is a byte-for-byte relocation of the host's prior implementation.

**Why no exploit path.** No path. The function is `view`, writes nothing and moves nothing; the worst possible consequence of a wrong read is a misreported display figure. Both fields the bonus arithmetic depends on are bound and used (46, 67), and the one discarded field that could plausibly have been wanted — boostedAmount — is deliberately superseded by the lazy-decay-safe boostedAmountAt at line 65, which reads the checkpointed value rather than the stale cache.

**Action.** Suppress. Insert directly above line 45 (`(uint256 tokenId,,, int256 bonusDebt,,) = r.restakers(_user);`):

    // SLITHER: intentional tuple destructure; only tokenId and bonusDebt are needed, and the cached boostedAmount is deliberately superseded by boostedAmountAt at line 65.
    // slither-disable-next-line unused-return

Same pattern as contracts/src/TegridyRestaking.sol:1099-1101.

### [FALSE_POSITIVE] `unused-return` — contracts/src/RestakingMonitorView.sol:71  _(if real: low)_

**Reasoning.** The thinnest case in the group. pendingBase (71-76) destructures `(uint256 tokenId,,,,,) = r.restakers(_user)` at 73, uses tokenId at 74 as an existence check (`if (tokenId == 0) return 0;`), and then returns `IStakingMonitorEarned(r.monitor()).earned(tokenId)` at 75. The whole function is a two-hop lookup keyed on tokenId; the other five fields of RestakeInfo (TegridyRestaking.sol:140-150) — positionAmount, boostedAmount, bonusDebt, depositTime, unsettledSnapshot — have no role in a base-reward query, which the monitor computes from the tokenId alone. There is no ERC20 success bool and no amount being dropped: the ignored values come from a public-mapping getter that cannot fail silently. The function is `view`, holds no state, and per the contract natspec at 20-27 has zero on-chain consumers by design.

**Why no exploit path.** No path. `view` function, no state writes, no transfers, no value at risk. The single field the lookup depends on, tokenId, is bound at 73 and used at both 74 and 75; the five discarded struct members feed no branch and no arithmetic anywhere in the function's six lines.

**Action.** Suppress. Insert directly above line 73 (`(uint256 tokenId,,,,,) = r.restakers(_user);`):

    // SLITHER: intentional tuple destructure; the base-reward lookup is keyed on tokenId alone.
    // slither-disable-next-line unused-return

Same pattern as contracts/src/TegridyRestaking.sol:1099-1101. Note this file will need two such suppressions, one here and one at line 45 for id 46.


## Group: `config-and-gate`

CONFIG-AND-GATE AUDIT. Empty `verdicts` by design — this group owns the meta-question. Everything below is proven from slither-analyzer 0.11.5 source installed at C:/Users/jimbo/AppData/Roaming/Python/Python312/site-packages/slither, from the committed files, and from the report itself. No .sol was edited; nothing was committed or pushed.

=====================================================================
Q1. IS `detectors_to_include` A REAL SLITHER CONFIG KEY?
=====================================================================
YES. It is real, and it is applied AFTER the exclusions exactly as the config claims. Proof:
  - slither/utils/command_line.py:50 — `"detectors_to_include": None` is in `defaults_flag_in_config`. That dict is the whitelist: read_config_file (command_line.py:93-100) logs "unknown key" and SKIPS any config key not in it.
  - slither/__main__.py:411-417 — CLI flag `--include-detectors`, `dest="detectors_to_include"`.
  - slither/__main__.py:224-227 — inside choose_detectors, applied AFTER the severity filter (line 217) and AFTER detectors_to_exclude (219-222).
  - Contrast __main__.py:199-205: `detectors_to_run != "all"` → builds the set and `return`s early, skipping every filter. The config's account of the OLD key is also correct.
So the `_detectors_promoted_key_fix` note is factually right on both halves. The feared catastrophe (a silently gutted detector set) is NOT happening.

BUT THE LIST IS A NO-OP. I replicated choose_detectors line-for-line against the committed config. The 43 promoted names add back ZERO detectors — `addback == []`. Two reasons, both verified:
  - Zero overlap between the 43 include names and the 12 exclude names.
  - The only active severity exclusion is `exclude_optimization: true`, and none of the 43 is Optimization impact.
Deleting the entire `detectors_to_include` line would change nothing about which detectors run. It is decorative. (Also: it is 43 names, not 44.)

It is not entirely harmless, though — it is a live TRIPWIRE. `__include_detectors` (__main__.py:233-246) does `raise ValueError(f"Error: {detector} is not a detector")` on any unrecognized name. All 43 resolve against 0.11.5 today. One typo, or one slither upgrade that renames/removes a detector, and slither aborts. That aborts outside the `except SlitherException` handler, so it exits non-zero — fail-CLOSED, i.e. red. Acceptable, but the comment should say that is what the list is for, because it is not doing what the comment currently claims.

Two further facts that undercut the "fund-loss detector class, run loud" framing:
  - 14 of the 43 are Low/Informational impact and therefore can NEVER fail `fail-on: medium`: reentrancy-unlimited-gas, reentrancy-events, reentrancy-benign, boolean-equal, shadowing-builtin, shadowing-local, missing-zero-check, calls-loop, events-access, events-maths, incorrect-modifier, deprecated-standards, void-cst, function-init-state.
  - The list OMITS `reentrancy-balance` — a High detector that produced 4 of the 5 High findings in this very report — plus `unchecked-transfer` (High), `suicidal` (High), `divide-before-multiply` (Medium, 2 of the gating findings), `unchecked-lowlevel`, `unchecked-send`, `write-after-write`. All run anyway because the base set is "all". This is a list nobody maintains, not a curation.

CROSS-CHECK AGAINST THE REPORT: the config demonstrably DID load. Not one of the 12 excluded detectors appears anywhere in the 362 findings. My simulation says 87 detectors run; the CI log says 88 — consistent with CI's slither carrying 102 installed detectors to my 101, same 14 dropped. Only 20 detectors actually fired.

=====================================================================
Q1b. WHAT IS ACTUALLY BROKEN IN THE DETECTOR CONFIG
=====================================================================
(a) `detectors_to_exclude` DOES NOT SPLIT ON COMMAS. __main__.py:219-222 is
      `[d for d in detectors_to_run if d.ARGUMENT not in args.detectors_to_exclude]`
    where `args.detectors_to_exclude` is the RAW STRING. `d.ARGUMENT not in <str>` is SUBSTRING containment. The `_schema_note` in contracts/slither.config.json explicitly asserts "it calls .split(',') on them" — that is FALSE for detectors_to_exclude. (It IS true for detectors_to_include, line 238.) Today this causes no collateral drops — I verified the dropped set equals the intended set — but any future exclude entry that is a substring of another detector's name will silently disable extra detectors, and the committed note tells the next reader that cannot happen.

(b) `similar-names` IS NOT A DETECTOR in 0.11.5 (the only near name is `name-reused`). That exclusion is a no-op and its rationale line documents a suppression that suppresses nothing. Mechanically harmless — exclusion does not raise, unlike include.

(c) NEEDS A HUMAN: `incorrect-shift` is IMPACT=High, CONFIDENCE=High, and it is switched off under a fail-on: medium gate. Its rationale is "False positives on SafeMath patterns", which does not describe what the detector does (it flags reversed operand order in assembly shl/shr). This exclusion was inherited verbatim from the stale root config of 2026-05-03. It is the one exclusion I would not carry forward without someone looking.

Full set of 14 detectors NOT running: assembly, cache-array-length, constable-states, dead-code, external-function, immutable-states, incorrect-shift, low-level-calls, naming-convention, pragma, solc-version, timestamp, too-many-digits, var-read-using-this. Only incorrect-shift (High) and timestamp (Low) are outside Informational/Optimization.

=====================================================================
Q2. IS THE `_scope` NOTE ACCURATE? NO — IT IS WRONG ON ALL 12 REMOVAL CLAIMS
=====================================================================
The note asserts 12 contracts "have been moved off this branch and are NOT in scope". All twelve are present AND git-tracked on mvp-launch right now:
  TegridyLending(2 files), TegridyNFTLending(2), TegridyNFTPool(2), GaugeController(1), VoteIncentives(2), TegridyDropV2(1), TegridyLaunchpadV2(1), DecayingFeeHook(1), TegridyLPFarming(1), CommunityGrants(1), MemeBountyBoard(1), PremiumAccess(1).
They are not merely present, they are producing findings: CommunityGrants 44, TegridyLending 45, TegridyNFTPool 34, VoteIncentives 32, MemeBountyBoard 25, TegridyLaunchpadV2 13, GaugeController 12, PremiumAccess 11.

Scale of the drift: the note names 15 + 3 base + 3 lib = 21 files. contracts/src/ actually holds 68 .sol (43 directly in src/, the rest under base/ lib/ markets/ nftfi/ v2/ v4/ vaults/ vendor/). The note does not mention TegridyRestakingAdmin, StakingMonitorView, RestakingMonitorView, LockerClaimer, LaunchLockView, TegridyLockVault, TegridyNativeBuyRouter, TegridyVestingWallet, TegridyAirdropDistributor, AirdropFactory, VestingFactory, LaunchRugEscrow, TegridyFeeExecutorRouter, any of v2/ v4/ vaults/ markets/ nftfi/ vendor/, or the five lib/ files beyond the three it names.

The sharpest way to put it: OF THE 48 GATING FINDINGS, EXACTLY 4 ARE IN A CONTRACT THE NOTE DECLARES IN SCOPE (TegridyRestaking). The other 44 are in files the note either says are gone or never mentions. The gate is red almost entirely on code the config says it is not looking at.

=====================================================================
Q3. DOES `filter_paths` DO WHAT THE SCOPE NOTE IMPLIES? NO
=====================================================================
It does not narrow scope at all, and it silently deletes coverage of the project's own libraries.

Mechanics, proven: parse_filter_paths (__main__.py:278-282) splits on COMMA; the value is PIPE-delimited with no commas, so it becomes ONE element. That element goes to `re.search` (slither_core.py:492) after `_relative_path_format` (slither_core.py:32-36 = `path.split("..")[-1].strip(".").strip("/")`), which only strips the trailing slash. Effective regex:
  lib/|node_modules/|test/|script/|out/|cache/|broadcast/|.audit_2026_freshlook/|.audit_101/|.spartan_unpacked
Because it is regex-matched, the pipes work as alternation — so it functions, but by accident of the matching mode, not by the comma-splitting the author assumed.

What it does NOT do: it filters FINDINGS by source path. It does not restrict what is compiled or analysed, and it contains no entry for any of the 12 "removed" contracts. It implements none of the _scope note.

COLLATERAL DAMAGE — this is a real coverage hole, not a nit. The bare `lib/` alternative matches `contracts/src/lib/`, the project's own library directory. I evaluated the actual regex against actual paths: src/lib/SequencerCheck.sol, src/lib/WETHFallbackLib.sol, src/lib/VotePowerOracle.sol and src/lib/StakingRewardLib.sol are all FILTERED. `_scope` explicitly declares SequencerCheck, WETHFallbackLib and VotePowerOracle IN SCOPE. Confirmed empirically: zero of the 51 files appearing in the 362-finding report lie under src/lib/ — all 8 files there are invisible to the gate.
Worse, slither_core.py:490-503 tests `any(...)` across a finding's source-mapping elements and then drops the WHOLE finding. So a finding spanning src/TegridyStaking.sol AND src/lib/StakingRewardLib.sol is discarded entirely, in-scope half included. contracts/foundry.toml documents StakingRewardLib as "the live reward-accounting cluster" and StakingViewLib as holding votingPowerOf/earned math extracted from TegridyStaking — i.e. this is suppressing findings on exactly the money math that was refactored out of the flagship contract to fit EIP-170.
And the entry is redundant for its intended purpose: `exclude_dependencies: true` already drops foundry's contracts/lib/ (slither_core.py:512-514). Minimal fix: delete the `lib/` alternative, or anchor it to `contracts/lib/`.

=====================================================================
Q4. CAN THE JOB REPORT GREEN WITHOUT HAVING ANALYSED ANYTHING? YES — A FOURTH ONE
=====================================================================
First, credit where due, because this matters for not over-correcting: .github/workflows/slither.yml is markedly better than the three prior vacuous gates and several of its choices are exactly right. Dropping `paths:` from `pull_request` so only ONE check run ever exists under this name is the correct fix for the PR #205 double-check failure. The `analyze` job's `if: !cancelled() && (needs.scope.result != 'success' || needs.scope.outputs.run == 'true')` is fail-OPEN. The scope script is fail-open throughout: `set -uo pipefail` without `-e`, empty file list → true, API cap → true, unrecognized verdict → true. Every action is SHA-pinned, there is no continue-on-error, and the threshold was not lowered to buy green.

The hole is in slither itself, not the YAML. __main__.py:904-905:
    if number_contracts == 0:
        logger.warning(red("No contract was analyzed"))
That is a WARNING. `output_error` is initialized None at line 785 and assigned ONLY inside `except SlitherException` at line 918. So with zero contracts analysed: output_error is None, results_detectors is empty, fail_on=MEDIUM → `fail_on_detection = any([]) = False` → line 965 `if output_error or fail_on_detection` is False → line 968 `sys.exit(0)`. GREEN.

So at the exit code, "compiled fine, found no contracts to analyse" is INDISTINGUISHABLE from "analysed 250 contracts, nothing at or above Medium". A hard compile failure IS red — I confirmed locally that a missing-solc InvalidCompilation exits 1 — but a SUCCESSFUL build yielding nothing analysable is green. Plausible triggers: the `src` key in contracts/foundry.toml changing, a remappings change that makes forge build emit nothing, crytic-compile selecting a different framework, or filter_paths growing an entry that swallows src/ — note it ALREADY swallows src/lib/, so that failure mode is not hypothetical, only currently partial.
The workflow asserts nothing about contract count, finding count, or report non-emptiness. The debug artifact step is `if-no-files-found: warn`, so even "slither wrote no report at all" surfaces as a warning. Compare .github/scripts/npm-advisory-gate.mjs:45-64 `assertUsableReport`, whose comment names precisely this shape — an outage rendering as a clean bill of health — and treats it as a hard error. The slither gate has no equivalent.
(Caveat I could not close: slither-action v0.4.2's entrypoint is not vendored here, so I could not read how it maps `fail-on: medium` or whether it adds a guard. It does translate correctly — slither's real flag is `--fail-medium`, not `--fail-on medium`, and the run clearly gated at Medium. I found no evidence the action adds a contract-count check.)

SECOND, SMALLER TRAP: the root slither.config.json (last touched 2026-05-03) STILL EXISTS. CI no longer loads it, but slither auto-loads ./slither.config.json from the CWD (command_line.py:83-85), so anyone running slither locally from the repo root silently gets the STALE config — different exclusions (no dead-code, no timestamp) and four keys that are not valid config keys at all (`fail_pedantic`, `fail_high`, `fail_medium`, `fail_low`; none is in defaults_flag_in_config, the valid key is `fail_on`). Local and CI therefore disagree, and the next person to "verify a finding locally" will verify against the wrong file. Delete it or make it a pointer.

=====================================================================
Q5. RECOMMENDED GATE DESIGN
=====================================================================
Copy the npm-advisory-gate shape; it already solves this exact problem in this repo.

STABLE IDENTITY OF A FINDING — line numbers move, so do not key on them:
  - Slither's own `id` field is a hash already used for dedup (slither_core.py:466-468) and triage (`_previous_results_ids`), BUT it derives from the description text, which embeds line numbers — so it likely moves on reformat. Verify before relying on it.
  - SARIF `partialFingerprints` (slither/utils/sarif.py) is the purpose-built mechanism; I did not verify slither populates it. Check first — if it does, use it.
  - The key I would actually ship: `check` + repo-relative `file` + enclosing contract + enclosing function, all available in `elements[].type_specific_fields`. Survives line movement and reformatting; breaks only on rename, which is the right moment to re-triage. Collapses two same-detector findings in one function into one key — check that against this report before adopting.

FILES, mirroring the precedent:
  - `.github/slither-allowlist.json` with the same two lists and the same semantics as .github/npm-advisory-allowlist.json: `baseline` (recorded verbatim at arming, one shared `expires`, NO invented reasons) and `accepted` (per-finding, `reason` >= 10 chars, own `expires`; no reason = blocking, no expiry = expired, expired = blocking).
  - `.github/scripts/slither-gate.mjs` reading slither-report.json, with an `assertUsableReport` equivalent — and THIS is the fix for Q4: hard-fail unless the report parses, carries a results.detectors array, AND the run analysed > 0 contracts. Slither's JSON does not expose the contract count directly, so assert on something positive: request `--json-types` including `console` and parse the "analyzed (N contracts with M detectors)" line, or assert the set of files appearing in the report covers at least N known src/ paths. The npm gate's principle applies verbatim — an empty result must be PROVEN clean, never assumed clean.
  - `frontend/src/test/slitherGate.test.ts` mirroring npmAdvisoryGate.test.ts: expired baseline blocks, acceptance without a written reason blocks, stale suppressions are reported but never fatal, and — the direct analogue of that suite's GHSA-not-package rule — suppressing one finding must NOT suppress the next finding in the same file. Add a test that the committed allowlist parses and carries an expiry.
  - Extend frontend/src/test/ciGateIntegrity.test.ts (it already scans ci.yml for swallowers and all workflows for SHA pinning) to assert slither.yml's analyze job invokes the gate script and that fail-on has not been moved to high/none without it.

WORKFLOW CHANGE: let the gate script own the verdict, as npm-advisories.yml already does — npmAdvisoryGate.test.ts:280 literally asserts "runs npm audit so its exit code cannot end the step". IMPORTANT CAVEAT: if you set slither's fail-on to none so the step always completes, a slither CRASH stops reddening the build via exit code. That makes the script's usability assertion load-bearing rather than belt-and-braces — which is exactly why the contract-count check is not optional.

ONE JUDGEMENT CALL ON BASELINING: baselining all 48 today is defensible only because nothing is deployed. But the sibling agents are triaging these findings RIGHT NOW, and `baseline` in this repo's own doctrine means "nobody has looked at this". Triaged findings belong in `accepted` with real reasons; only what triage cannot settle should be baselined, on a short expiry (the npm baseline used 90 days). Otherwise the arming commit re-creates the thing this repo keeps shipping: a gate that reports and reports nothing.

=====================================================================
FILES READ (all absolute)
=====================================================================
  C:/Users/jimbo/OneDrive/Desktop/tegriddy farms/contracts/slither.config.json
  C:/Users/jimbo/OneDrive/Desktop/tegriddy farms/slither.config.json  (stale root config, still present)
  C:/Users/jimbo/OneDrive/Desktop/tegriddy farms/.github/workflows/slither.yml
  C:/Users/jimbo/OneDrive/Desktop/tegriddy farms/.github/scripts/npm-advisory-gate.mjs
  C:/Users/jimbo/OneDrive/Desktop/tegriddy farms/.github/npm-advisory-allowlist.json
  C:/Users/jimbo/OneDrive/Desktop/tegriddy farms/contracts/foundry.toml
  C:/Users/jimbo/AppData/Roaming/Python/Python312/site-packages/slither/__main__.py
  C:/Users/jimbo/AppData/Roaming/Python/Python312/site-packages/slither/utils/command_line.py
  C:/Users/jimbo/AppData/Roaming/Python/Python312/site-packages/slither/core/slither_core.py
  C:/Users/jimbo/AppData/Local/Temp/claude/C--Users-jimbo-OneDrive-Desktop-bayla/4aef0c32-7a81-4000-b867-d0d1b3cb26fc/scratchpad/slither/{high-medium.json,slither-report.json}
Verification scripts I wrote (scratchpad only, no repo files touched): chk.py, sim.py, rep.py, paths.py, filt.py under .../scratchpad/.
