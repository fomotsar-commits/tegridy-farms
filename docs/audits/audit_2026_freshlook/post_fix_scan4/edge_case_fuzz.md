# Edge-Case Input Fuzz Audit — HEAD (commit d5ca554)

Target commit: `d5ca554` ("test(fix): TegridyFeeHook syncAccruedFees — slot drift + on-chain credit seed")
Scope: every external/public state-mutating function across `contracts/src/**/*.sol`
Threat model: adversarial inputs hitting paths where existing audits did not cover the specific shape — looking for SILENT-NOOP / STATE-CORRUPTION classes (HARD-REVERT / PANIC-REVERT skipped per mandate).

---

## Summary

The codebase is heavily fuzz-resistant — virtually every external entry point validates zero/empty/dust/duplicate inputs with typed reverts. The audit found **no STATE-CORRUPTION** findings. Five SILENT-NOOP returns were identified; all are documented as design intent. They are listed below for completeness so future maintainers don't re-introduce a non-design version of the same shape.

The "hostile ERC20/ERC721" surface is well-handled via post-condition ownership checks (`CollateralNotEscrowed`, `_safeOutboundTransfer*`, `FOT_OUTPUT_*` checks on TegridyPair.swap, balance-diff measurement on FoT swap variants).

The "self-reference" (`to == address(this)`, `to == pair`) surface is well-gated on every router/swap entry point that takes a `to` arg. Non-routing entry points (e.g., `setReferrer`) accept any address by design — caller's choice.

The `Math.mulDiv` migration on TegridyLending interest math eliminates the user-input-driven panic on the largest dust attack surface.

---

## Methodology

Per the mandate the scan walked each external/public state-changing function and mentally executed the ten fuzz vectors:

1. Zero / empty inputs
2. Max-value inputs (`type(uint256).max`, etc.)
3. Dust / 1-wei inputs
4. Empty / single-element arrays
5. Self-reference inputs (`to == address(this)`, etc.)
6. Same-token-twice (`path = [WETH, WETH]`)
7. Hostile ERC20 / ERC721 (FoT, blacklist, paused, ERC777 hooks)
8. Boundary timestamps (`==` deadline, `==` lockEnd)
9. Re-entry as same-frame (view re-entry)
10. Replay-after-revert

Severity filter: only SILENT-NOOP / STATE-CORRUPTION are reported. HARD-REVERT and PANIC-REVERT cases were verified as clean and are not enumerated.

---

## Findings

| # | Contract | Function | Class | Status |
|---|---|---|---|---|
| F1 | `PremiumAccess` | `reconcileExpired(_user)` | SILENT-NOOP | DESIGN — early `return` on still-active or already-reconciled user |
| F2 | `PremiumAccess` | `batchReconcileExpired(_users)` | SILENT-NOOP | DESIGN — `continue` past entries that are still-active or already-reconciled |
| F3 | `PremiumAccess` | `deactivateNFTPremium(user)` | SILENT-NOOP | DESIGN — silent no-op when user still holds JBAC or grace period not elapsed |
| F4 | `VoteIncentives` | `applyEnableCommitReveal()` | SILENT-NOOP | DESIGN — explicit idempotent flag-flip, comment cites "mirrors pre-split semantic" |
| F5 | `ReferralSplitter` | `recordFee(_user)` | SILENT-NOOP | DESIGN — early `return` on `msg.value == 0` so SwapFeeRouter zero-fee swaps don't revert |
| F6 | `TegridyFeeHook` | `afterSwap(...)` | SILENT-NOOP | DESIGN — unapproved-pool / paused / zero-delta path returns `(selector, 0)` instead of reverting (would brick every swap on misconfigured pool) |
| F7 | `TegridyNFTPool` | `claimLPFees()` / `claimProtocolFees()` | SILENT-NOOP | DESIGN — early `return` on zero accumulated fees |
| F8 | `TegridyLPFarming` | `_getRewardInternal(user)` (called by `getReward()` / `exit()`) | SILENT-NOOP | DESIGN — `if (reward > 0)` gate; zero-reward call succeeds without event |
| F9 | `TegridyStakingJbacVault` | `returnJbac(stakingTokenId, jbacTokenId, to)` | SILENT-NOOP | DESIGN — `if (jbacTokenId == 0) return;` for positions without JBAC deposit |
| F10 | `TegridyNFTPool` | `syncNFTs(tokenIds[])` | SILENT-NOOP | DESIGN — admin batch-sync, individual entries that don't need sync silently skip |
| F11 | `TegridyStaking` | `_claimUnsettledInternal(user)` (via `claimUnsettled` / `claimUnsettledFor`) | SILENT-NOOP | DESIGN — when reward pool is empty, payout = 0, function succeeds without transfer/event |
| F12 | `TegridyFeeHook` | `claimFees(currency, amount=0)` | SILENT-NOOP | DESIGN — explicit health-check path emits `FeeCollected(currency, 0)` |
| F13 | `MemeBountyBoard` | `voteForSubmission` during freeze window | NOT-REALLY-NOOP | Vote IS counted on the per-submission tally; only the leader-tracking is gated by the freeze rule. Documented late-flip protection. |
| F14 | `TegridyTWAP` | `update(pair)` recording bypass observation | DESIGN | When `bridgingGapTrip` or `sequencerOutage` triggers, observation is recorded with `bypassed=true` AND `lastSpot{0,1}` is overwritten — consumers gate on `bypassed` flag, downstream cooldown via `lastBypassUsed`. Documented behaviour. |

No STATE-CORRUPTION findings.

---

## Per-vector analysis (verified clean)

### Vector 1: Zero / empty inputs

- **`amount = 0`** — every value-moving entry rejects: `TegridyLending._createLoanOffer` (`ZeroPrincipal`), `TegridyStaking.stake` (`ZeroAmount`), `TegridyRestaking.restake` (`ZeroAmount`), `VoteIncentives.depositBribe` (`ZeroAmount`), `MemeBountyBoard.createBounty` (`InsufficientReward`), `SwapFeeRouter.swap*` (`ZeroAmount`), `TegridyDropV2.mint` (`ZeroQuantity`), `TegridyNFTPool.swap*` (`EmptySwap`), `TegridyLPFarming.stake` (`ZeroAmount` + `StakeBelowMinimum`), `TegridyTWAP.consult` (`InvalidAmount`).
- **`to = address(0)`** — every recipient-taking entry rejects: TegridyRouter `swap*` and `removeLiquidity*` all check `ZERO_TO`, SwapFeeRouter swaps check `InvalidRecipient`, TegridyPair `mint` / `burn` / `swap` / `skim` reject `INVALID_TO`. `TegridyStakingJbacVault.claimStrandedJbac` reverts `Unauthorized` when record's `to` is zero.
- **`tokenIds = []`** — `TegridyNFTPool.swap*` (`EmptySwap`), `TegridyNFTPool.removeLiquidity` (`for` over empty array is a no-op then `ethAmount > 0` branch runs separately — verified clean).
- **`path = []` / `path.length < 2`** — every router swap revert (`InvalidPath`), conversion paths reject (`InvalidConversionPath`).
- **Empty descriptions / URIs** — `MemeBountyBoard.createBounty` (`EmptyDescription`), `MemeBountyBoard.submitWork` enforces `URI_TOO_LONG` upper bound (no lower bound but caller's choice — submitting empty content is the caller's right).

### Vector 2: Max-value inputs

- **`amount = type(uint256).max`** — every multiplication path uses `Math.mulDiv` (TegridyLending interest, RevenueDistributor share, TegridyTWAP `consult`) or has explicit caps. `TegridyLending.createLoanOffer` enforces `_aprBps <= maxAprBps` and `principal <= maxPrincipal`, both bounded constants. `TegridyDropV2.mint` enforces `quantity <= MAX_MINT_PER_TX = 50` and `totalSupply + quantity <= maxSupply`.
- **`block.timestamp = type(uint64).max` (year 2106 wrap)** — `TegridyPair._update` and `TegridyTWAP._getCumulativePricesOverPeriod` use `unchecked` modular subtraction matching Uniswap V2 wrapping accumulator semantics. Documented as wrap-safe across the year-2106 boundary.
- **`int128.min` for V4 hook deltas** — `TegridyFeeHook.afterSwap` performs `if (swapAmount < 0) swapAmount = -swapAmount;`. `int128.min` would Panic(0x11) here (negation overflow), but that requires the upstream PoolManager to produce `int128.min` deltas — practically impossible on a legitimate swap.

### Vector 3: Dust / 1-wei inputs (denom-controlled mulDiv)

- **`Math.mulDiv(amount, num, denom)` where denom is user-controlled** — verified across TegridyLending interest, TegridyTWAP consult, RevenueDistributor share. None of the `denom` values are user-controlled — they're all either constants (`BPS * SECONDS_PER_YEAR`), oracle-derived (`uint256(elapsed) * Q112` with min-elapsed gate), or sum-of-stake (fail-closed at zero via explicit `if (totalBoostedStake == 0) return;`).
- **`MIN_INTEREST_PRINCIPAL_BPS = 5` floor + `MIN_INTEREST_DURATION = 1 days` floor on TegridyLending repay** prevents zero-interest dust loans even at 0% APR. Sister fix on TegridyNFTLending.

### Vector 4: Empty arrays / single-element arrays

- **Single-element loops**: TegridyNFTPool `swapETHForNFTs` numItems=1, TegridyDropV2 mint quantity=1, TegridyNFTPoolFactory `createPool` initialTokenIds.length=1 — all execute one loop iteration cleanly.
- **`path.length == 2`**: every swap router enforces `path.length >= 2` then iterates `path.length - 1` hops. With length=2, single hop via `pairs[0]`. Verified clean.
- **`gauges.length == 0` on GaugeController.vote**: passes `ArrayLengthMismatch` check (gauges and weights both 0) but then `for` loop executes 0 times, `totalWeight = 0`, then `if (totalWeight != BPS) revert WeightsMustSumToBPS();` correctly rejects.

### Vector 5: Self-reference inputs

- **`to == address(this)`** — explicitly rejected in `TegridyRouter.swap*`, `SwapFeeRouter.swap*`, `TegridyRouter.removeLiquidity*`. TegridyPair's `swap` rejects `to == token0` / `to == token1` for the OUTPUT side (preserving F-31-D fix that allowed input-side coincidence).
- **`recipient = msg.sender` in payout** — common and intentional (refund flows). Not a corruption surface.
- **NFT recipient = the contract itself** — TegridyPair.mint rejects `to != address(this)` (closes the V2 mint-to-pair footgun). TegridyRouter.addLiquidity rejects `to != pair`. TegridyNFTPool.swapETHForNFTs's `_swapInFlight` flag combined with the `_swapCaller`-only `onERC721Received` gate prevents arbitrary NFT injection.

### Vector 6: Same-token-twice

- **`path = [WETH, WETH]`** — `TegridyRouter._validatePathNoCycles` (1-hop case `if (hops < 2) return;` — but `_swap` has `require(input != output, "IDENTICAL_CONSECUTIVE_TOKENS");` which catches it). `SwapFeeRouter._validateNoDuplicates` rejects directly in O(n²). `SwapFeeRouter._validateConversionPath` rejects via the same duplicate scan.
- **Round-trip `[A, B, A]`** — TegridyRouter `_validatePathNoCycles` derives pair-array, checks pairs[0] != pairs[1] (since the same A↔B pair is referenced twice by ordered tokens), reverts `CyclicPath`.
- **TegridyNFTPool same-tokenId-twice in `swapETHForNFTs`/`swapNFTsForETH`** — first iteration succeeds, second iteration's `_idToIndex[tokenId] == 0` (just cleared) reverts `NFTNotHeld`.

### Vector 7: Hostile ERC20 / ERC721

- **Fee-on-Transfer ERC20**: TegridyPair.swap has explicit `FOT_OUTPUT_0` / `FOT_OUTPUT_1` post-condition asserts, which loud-revert FoT outputs that would desync reserves. SwapFeeRouter has FoT-supporting variants for each swap shape that measure actual balance delta. VoteIncentives.depositBribe uses balance-diff for FoT.
- **Blacklist-on-transfer**: TegridyLending wraps NFT transfer in `_safeOutboundTransfer` with post-condition ownership check. TegridyNFTLending mirrors. TegridyPair uses SafeERC20.safeTransfer (reverts on `false` return).
- **Paused-on-transfer**: Same `_safeOutboundTransfer` handles via try/catch — populates `stuckCollateralRecipient` for later retry.
- **ERC777 hooks**: TegridyPair.sol explicitly comments `SECURITY NOTE: ERC-777 tokens and tokens with transfer callbacks are NOT supported.` Factory's `_rejectERC777` is creation-time gated. Per-swap `FOT_OUTPUT_*` post-condition catches post-creation upgrade-to-FoT.
- **Silent-no-op transferFrom on whitelisted NFT**: TegridyLending `_safeOutboundTransferStaking` + TegridyNFTLending `_safeOutboundTransfer` both use `SafeERC721Call.safeOwnerOfBounded` post-condition. `claimStuckCollateral` retries under same detector.

### Vector 8: Boundary timestamps

- **`block.timestamp == lockEnd`**: TegridyStaking.withdraw uses `block.timestamp < p.lockEnd` (strict less-than → boundary equals "lock expired, can withdraw"). TegridyStaking.earlyWithdraw uses `block.timestamp >= p.lockEnd` (must use withdraw). Sister `extendLock` uses `block.timestamp + _newLockDuration <= p.lockEnd` (must extend strictly past current end). All boundaries consistent.
- **`block.timestamp == voteEnd`**: VoteIncentives.claimBribes uses `block.timestamp <= _voteEnd` for `ClaimWindowNotOpen`. So block.timestamp == voteEnd reverts (must be strictly past). GaugeController revealVote uses `< revealOpens` and `> revealCloses` boundaries.
- **`block.timestamp == deadline + GRACE`**: TegridyLending.repayLoan uses `block.timestamp > effectiveDeadline + GRACE_PERIOD + outageBuffer` (== boundary IS still repayable). claimDefaultedCollateral uses `block.timestamp <= effectiveDeadline + GRACE + outageBuffer` (== boundary still rejects claim). Mirror-symmetric, no off-by-one.

### Vector 9: Re-entry as same-frame (view re-entry)

- **TegridyPair `getReserves()` during swap callback**: blocked by CEI ordering — `_update(postBalance0, postBalance1)` runs BEFORE outbound transfer (lines 305-309). Documented in `AUDIT NOTE M-02`.
- **TegridyStaking `votingPowerOf()` during NFT transfer callback**: covered by `_settleRewardsOnTransfer` AT `_beforeTokenTransfer` so any callback observer reads the post-settle state.
- **TegridyRestaking `pendingBonus()` during external callback**: not a state-mutating path; reads cached `info.boostedAmount` against current `accBonusPerShare`.

### Vector 10: Replay-after-revert

- **State writes before external calls**: every cancel/repay/claim pattern follows CEI. TegridyLending.repayLoan flips `loan.repaid = true` BEFORE the NFT transfer try/catch, so a re-entrant retry hits `LoanAlreadyRepaid` immediately.
- **Storage rollback on revert**: standard EVM behaviour — partial state mutations are rolled back together. The only at-risk pattern would be a contract calling itself via `try`/`catch` with state mutations between try-call and the catch — this codebase uses `try/catch` only around external token operations (claim deferrals, transfer-failed pending queues), and in every case the catch branch records a recovery slot rather than re-issuing the call inline.

---

## Narrow follow-ups

The findings catalogued above are all DESIGN, not BUG. Two minor observations that don't rise to a finding but are worth documenting for future maintainers:

1. **`TegridyTWAP.update`'s `lastSpot{0,1}` overwrite under `bridgingGapTrip` / `sequencerOutage`** — the bypass-flagged observation still updates `lastSpot{0,1}`, which means the NEXT honest observation's deviation gate compares against this potentially-stale spot. By design (admit bridging-gap as bypass anchor, let subsequent observations re-converge); the `bypassed=true` flag protects readers via `consult` rejecting any window containing a bypass slot. Worth a NatSpec stamp explicitly noting "post-bypass deviation baseline is intentional rebootstrap source".

2. **`TegridyStaking._claimUnsettledInternal` payout-zero silent return** — currently when `unsettledRewards[user] > 0` but `rewardPool == 0` (under-funded contract), the function succeeds and `unsettledRewards[user]` retains the same value. Acceptable design (user retains claim) but a `PartialClaim(user, 0, owed)` event would aid off-chain monitoring. Pure observability win, not a fix.

---

## Verdict

No SILENT-NOOP or STATE-CORRUPTION introduced by adversarial inputs that wasn't already a documented design choice. The fuzz surface is well-handled.

The minimal-surface mandate is upheld here: existing checks are conservative, every entry validates inputs against typed errors, and no custom edge-case-handling logic was identified that diverges from canonical battle-tested patterns (Uniswap V2 swap CEI, Synthetix StakingRewards `getReward`, Curve `kick`, Aerodrome bribe accounting, OZ `Ownable2Step`, etc).
