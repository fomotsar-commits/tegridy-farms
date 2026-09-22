# Agent 41 — Reentrancy Class Audit (Fresh-Eyes)

**Scope:** All Solidity files under `contracts/src/`.
**Lens:** Classic, cross-function, read-only, cross-contract reentrancy; NFT receiver hooks; flash-loan callbacks; ERC777; WETH fallback gas grants; per-account double-claim; loop-internal external calls.

---

## Executive Summary

The codebase demonstrates **mature reentrancy hygiene**:
- Every value-bearing entry point is wrapped in OZ `ReentrancyGuard.nonReentrant`.
- ETH transfers use `WETHFallbackLib.safeTransferETHOrWrap` with a 10k gas stipend (Solmate/Seaport pattern), or 50k stipend in narrow cases (with explicit reasoning in comments).
- ERC721 outbound returns to users from lending/restaking flows use **raw `transferFrom` via `SafeERC721Call.safeTransferFromBounded`** — bypassing the `onERC721Received` hook entirely on the trust-sensitive paths.
- Where `safeTransferFrom` IS used (e.g., `unrestake` → user, JBAC return → user), state is pre-cleared and outer `nonReentrant` blocks self-reentry.
- CEI ordering is consistent on all claim/withdraw/repay paths (state mutated before external interactions).

I found **no exploitable reentrancy vulnerabilities** in the production-path Solidity. Below are the surfaces I examined, several DEAD-END "near-misses" worth documenting (state shape that LOOKS exploitable but isn't), and one minor read-only oracle observation that does not constitute a finding but is worth noting for the security-design rationale.

---

## F-41-1: NEAR-DEAD-END — TegridyTWAP.update() unrestricted-gas refund

**File:** `contracts/src/TegridyTWAP.sol:285`
**Vulnerable function:** `update(address pair) external payable nonReentrant`
**External call:** `(bool ok,) = msg.sender.call{value: excess}("");` (UNRESTRICTED gas)

**State at the moment of the refund call:**
- `accumulatedFees += updateFee` already incremented (line 281).
- `observations[pair][...]` NOT yet written.
- `lastSpot0[pair]`, `lastSpot1[pair]` NOT yet written.
- `observationCount[pair]`, `observationIndex[pair]` NOT yet incremented.

**Reentrant entry point:** During the unrestricted-gas refund, `msg.sender` can call `consult(pair, ...)` (view, not `nonReentrant`). It would read the OLD observation buffer (this update's writes haven't landed yet).

**Why this is NOT exploitable:**
1. The deviation gate fires AFTER the refund, so the spot-price write is post-refund. Pre-refund state is identical to what `consult()` returned right before `update()` was called. There's no NEW information leaked.
2. The caller of `update()` is the one paying the fee — they can already control update timing.
3. `consult()` operates on the buffer that existed BEFORE this call, so no inter-step inconsistency exists from the consumer's perspective.
4. Outer `nonReentrant` blocks any state-mutating re-entry into `update()` itself.

**Recommendation (defense-in-depth, not a finding):** Move state mutations BEFORE the refund call. Currently the `accumulatedFees += updateFee` write at line 281 is PRE-call, but the observation/cumulative writes are POST-call. The full CEI-pure ordering would require restructuring the function. The current design is acceptable because the only post-call state change is the observation write, and that doesn't affect anyone EXCEPT this caller's future reads.

---

## F-41-2: DEAD-END — TegridyNFTPool.swapETHForNFTs buyer hook callback

**File:** `contracts/src/TegridyNFTPool.sol:288-293`
**Vulnerable surface (SUSPECTED):** `nftCollection.safeTransferFrom(address(this), msg.sender, tokenId)` inside the per-tokenId loop fires the buyer's `onERC721Received` callback while `_swapInFlight == true`, mid-batch, with OTHER tokenIds still in `_heldIds`.

**Why this is NOT exploitable:**
1. Outer function is `nonReentrant` — any re-entry into pool's `swapETHForNFTs`, `swapNFTsForETH`, `addLiquidity`, etc., reverts.
2. **The pool's own `onERC721Received` (line 777) is gated** — `authorizedSwapInflow = _swapInFlight && from == _swapCaller` is FALSE during the buyer-direction swap because `_swapCaller` is intentionally NOT set in `swapETHForNFTs` (V3-NFTPOOL-01 fix at line 274-280, explicitly retained the buyer-callback gap closure).
3. The buyer cannot deposit arbitrary tokenIds via the `onERC721Received` re-entry vector — `authorizedOperator` requires `operator == owner || operator == address(this) || operator == factory`, and the buyer is none of those.
4. View-only reads (`getHeldTokenIds`, `getBuyQuote`) during the callback see the post-loop-iteration state of THAT tokenId being already removed, plus the other tokenIds still present. This matches the actual mid-loop state — no cross-contract consumer relies on the atomicity of the loop.

**Status:** Already-fixed via V2-NFTPOOL-01 + V3-NFTPOOL-01 in earlier audit waves. Mechanism is correct.

---

## F-41-3: DEAD-END — TegridyRestaking.unrestake JBAC NFT return triggers user callback

**File:** `contracts/src/TegridyRestaking.sol:1108`
**Vulnerable surface (SUSPECTED):** `stakingNFT.safeTransferFrom(address(this), msg.sender, tokenId)` triggers the user's `onERC721Received` callback while:
- `restakers[msg.sender]` already deleted (line 1078)
- `tokenIdToRestaker[tokenId]` already deleted (line 1077)
- `_writeBoostCheckpoint(msg.sender, 0)` already written (line 1079)
- `bonusRewardToken` and `rewardToken` already paid out

**Why this is NOT exploitable:**
1. Outer `nonReentrant` blocks re-entry into `restake`, `unrestake`, `claimAll`, `refreshPosition`, `claimResidualForTokenId`, `emergencyWithdrawNFT`, `claimStrandedRestakeNFT`, `claimPendingUnsettled`.
2. **Cross-contract VOTE-POWER reads return correct values:**
   - `staking.votingPowerOf(user)` returns the user's NEW positions (now they own the just-transferred NFT). Correct.
   - `restaking.votingPowerOf(user)` returns 0 (`restakers[user].tokenId == 0`). Correct.
   - Sum across staking + restaking = staking-side only. NO double-count.
3. `staking.claimUnsettledForTokenId(tokenId, ...)` is gated by `_isTrackedHolder(msg.sender)` — only callable by `restakingContract` itself or whitelisted lending. The user's hook cannot call it.
4. `_settleRewardsOnTransfer(tokenId, address(this))` runs INSIDE staking's `_beforeTokenTransfer` BEFORE the user-side hook fires — credits land in `unsettledRewards[restakingContract]` and `unsettledRewardsByTokenId[tokenId]`. Both are protected from the user's reach.

**Confirmed safe pattern.**

---

## F-41-4: DEAD-END — TegridyStaking.withdraw → JBAC return → user callback

**File:** `contracts/src/TegridyStaking.sol:957-977` (`withdraw`) → `_clearPosition` → `vault.returnJbac` → `jbacNFT.safeTransferFrom(vault, user, jbacId)`

**State at the moment of the user's `onERC721Received` (during JBAC return):**
- Staking position deleted (`delete positions[tokenId]`).
- Staking NFT burned (`_burn(tokenId)`).
- `userTokenId[msg.sender]` re-pointed to surviving position (or 0).
- `_writeCheckpoint(msg.sender)` written (post-position-clear value).
- `totalStaked` and `totalBoostedStake` decremented.
- TOWELI principal NOT yet sent (sent at line 974 AFTER `_clearPosition` returns).

**Why this is NOT exploitable:**
1. Outer `nonReentrant` blocks all staking nonReentrant entrypoints.
2. The user cannot re-enter `getReward` / `withdraw` / `kick` / `extendLock` / `increaseAmount` / `claimUnsettled` / `claimUnsettledFor` / `claimUnsettledForTokenId` — all `nonReentrant`.
3. Read-only inconsistency surface during the callback:
   - `_reserved() = totalStaked + totalUnsettledRewards`. After `_clearPosition` decrements `totalStaked`, the _real_ ERC20 balance of staking is INFLATED relative to `_reserved()` — but no one can call a state-mutating reward path during the callback (all `nonReentrant`).
4. Cross-contract reads of `votingPowerOf(msg.sender)` correctly reflect ONLY surviving positions — no double-count.
5. JBAC vault's `returnJbac` is `onlyStaking`-gated; cross-contract re-entry from the JBAC NFT's hook into vault's `returnJbac` reverts on `NotStaking`.

**The CCR-01 invariant is explicitly preserved (code comment at line 1294-1298):** `_burn` clears `_ownerOf` slot BEFORE `_afterTokenTransfer` fires, so any reentrant `transferFrom`/`acceptOffer` from inside the JBAC return-callback reverts on the empty `_ownerOf` slot. Belt-and-suspenders.

**Confirmed safe pattern.**

---

## F-41-5: DEAD-END — TegridyDropV2.mint loop with `_safeMint`

**File:** `contracts/src/TegridyDropV2.sol:575-577`
**Vulnerable surface (SUSPECTED):** `for (...) { _safeMint(msg.sender, startId + i); }` fires `onERC721Received` on each iteration if msg.sender is a contract.

**State BEFORE the loop:**
- `totalSupply += quantity` (line 561)
- `mintedPerWallet[msg.sender] += quantity` (line 562)
- `paidPerWallet[msg.sender] += totalCost` (line 563)
- `totalProceeds += totalCost` (line 565)
- `allowlistClaimed[msg.sender] += quantity` (line 548, allowlist phase only)

**Why this is NOT exploitable:**
1. Outer `nonReentrant` blocks `mint`, `refund`, `withdraw`, `rescueAfterCancellation` — all the value-bearing surface.
2. State counters are FULLY-UPDATED before the first `_safeMint` fires — pre-call hook sees a coherent post-mint snapshot. CEI is correct (R023 / M-02 fix is intentional).
3. The hook can call `currentPrice()`, `tokenURI(...)`, `mintedPerWallet(...)`, `totalSupply()` — all correct values.
4. Mid-loop hook sees `ownerOf(startId + i)` populated for the JUST-minted token, and zeros for unminted future iterations. This is the natural mid-loop state and matches what any Solady/OZ ERC721 mint loop produces.

**Confirmed safe pattern.**

---

## F-41-6: DEAD-END — VoteIncentives.claimBribes 50k-gas ETH push

**File:** `contracts/src/VoteIncentives.sol:863`
**Surface:** `(bool ok,) = msg.sender.call{value: share, gas: 50000}("");` inside the per-token claim loop.

**State BEFORE the call:**
- `claimed[msg.sender][epoch][pair][token] = true` (line 832)
- `totalClaimedBribes[epoch][pair][token] += share` (line 849)
- `totalUnclaimedETHBribes -= share` (line 853)

**Reentrant entry possibilities and outcomes:**
1. `claimBribes`, `claimBribesBatch`, `depositBribe`, `depositBribeETH`, `withdrawPendingETH`, `withdrawPendingToken` — ALL `nonReentrant`. Blocked.
2. `vote` is NOT `nonReentrant`. The user's hook CAN re-enter `vote(epoch', pair', power)` for a DIFFERENT epoch.
   - `vote` requires `userTotalVotes[msg.sender][epoch] + power <= userPower`. Cannot create more voting power than the user has.
   - It cannot retroactively change the user's vote on the CURRENT being-claimed epoch (already locked in).
   - **No double-claim, no over-vote, no power inflation.**
3. The user's hook can read `claimable(user, otherEpoch, otherPair)` and see correct values (those mappings are unaffected by THIS claim).
4. Mid-loop, the user's hook sees `claimed[msg.sender][epoch][pair][tokens[0]] = true` while `claimed[msg.sender][epoch][pair][tokens[1]] = false`. This is correct mid-loop state — but no external contract reads `claimed` to make value-flow decisions, so no read-only reentrancy consequence.

**Confirmed safe pattern.** The 50k stipend is documented (line 859-862) as bumped from 10k specifically for Safe/Argent/EIP-4337 compatibility, with the reasoning that `nonReentrant` makes it safe.

---

## F-41-7: DEAD-END — MemeBountyBoard.completeBounty 50k-gas reward push

**File:** `contracts/src/MemeBountyBoard.sol:604`
**Surface:** `(bool success,) = winner.call{value: reward, gas: 50000}("");`

**State BEFORE the call:**
- `bounty.winner = winner` (line 588)
- `totalPaidOut += reward` (line 592)
- `bounty.status = BountyStatus.Completed` (line 593)

**Why this is NOT exploitable:**
1. Outer `nonReentrant` blocks all MemeBountyBoard nonReentrant entrypoints.
2. State is fully consistent before the external call.
3. Cross-contract reads (e.g., `bounties[id].status` from indexers) see Completed correctly.
4. Winner's hook can call into staking/restaking/lending — but those have their own guards and don't depend on MemeBountyBoard state for value flow.

**Confirmed safe pattern.** D-MEME-M1 fix bumped 10k → 50k with explicit safety analysis in comments (lines 596-603).

---

## F-41-8: DEAD-END — RevenueDistributor.claim 10k-gas push to msg.sender

**File:** `contracts/src/RevenueDistributor.sol:631, 687, 1342`
**Surface:** `(bool success,) = msg.sender.call{value: totalOwed, gas: 10000}("");`

**State BEFORE the call:**
- `lastClaimedEpoch[msg.sender] = actualEndEpoch` (line 606 / 678)
- `claimedAtEpoch[user][i] = true` for every iterated epoch (inside `_calculateClaim`, line 746)
- `epochClaimed[i] += share` for paid epochs (line 782)

**Why this is NOT exploitable:**
1. 10k gas is enough for `receive() { emit X(...) }` and not much else. Not enough for cross-contract calls or storage writes.
2. Outer `nonReentrant` blocks claim/claimUpTo/withdrawPending/executeClaimRecovery.
3. `totalClaimed += totalOwed` happens AFTER the call only on success, but this is purely an accounting counter (used for `_isReserved` invariant checks); there's no second-order exploit.
4. Failed transfer routes to `pendingWithdrawals[msg.sender]` — the documented Synthetix pull-pattern fallback.

**Confirmed safe pattern.** Reasoning explicitly retained in code comments (lines 612-630).

---

## F-41-9: DEAD-END — TegridyLending.repayLoan multi-step external interaction

**File:** `contracts/src/TegridyLending.sol:1006-1186`
**Surface:** Multiple sequential external calls inside `repayLoan`:
1. `staking.claimUnsettledForTokenId(tokenId, address(this))` (line 1120)
2. `_safeOutboundTransferStaking(...)` → `SafeERC721Call.safeTransferFromBounded` (line 1126) — **raw `transferFrom`, NOT `safeTransferFrom`**, so NO `onERC721Received` callback fires.
3. `staking.claimUnsettledForTokenId(tokenId, address(this))` again (line 1132)
4. `staking.unsettledRewardsByTokenId(tokenId)` view (line 1155)
5. `IERC20(toweli).safeTransfer(borrower, myShare)` (line 1143)
6. `WETHFallbackLib.safeTransferETHOrWrap(...)` (lines 1167, 1171, 1182)

**Why this is NOT exploitable:**
1. `loan.repaid = true` set at line 1063 BEFORE any external interaction (CEI).
2. The outbound NFT transfer uses raw `transferFrom` via `SafeERC721Call` (with bounded returndata), so no ERC721 receiver callback fires. The borrower cannot re-enter via ERC721 hook.
3. Solady's internal `_beforeTokenTransfer` / `_afterTokenTransfer` hooks fire, but they only do internal state mutation in TegridyStaking — no external calls.
4. The `staking.claimUnsettledForTokenId` calls are to a TRUSTED contract; even if it called back, all reentrant entrypoints in TegridyLending have `nonReentrant`.
5. State increments to `escrowRewardsOwed[_loanId]` and `totalEscrowRewardsOwed` happen AFTER all the external calls, but the affected mappings are only consumed by `pullEscrowRewards` (also `nonReentrant`) and the borrower has no way to drain them mid-flow.

**Confirmed safe pattern.** PASS7-LENDING-02 fix explicitly chose `transferFrom` over `safeTransferFrom` for this reason.

---

## F-41-10: DEAD-END — RevenueDistributor.emergencyWithdraw unrestricted gas to treasury

**File:** `contracts/src/RevenueDistributor.sol:429`
**Surface:** `(bool success,) = treasury.call{value: withdrawable}("");` (UNRESTRICTED gas)

**Why this is NOT exploitable:**
1. `onlyOwner` modifier — the owner is the trust root that set the treasury address.
2. `nonReentrant` modifier blocks reentry to all RevenueDistributor nonReentrant functions.
3. Other contracts have their own guards. Treasury cannot meaningfully exploit cross-contract state.
4. Same pattern at `executeEmergencyWithdrawExcess` (line 458) and `sweepDust` (line 876).

Same reasoning applies to:
- `POLAccumulator.executeSweepETH` (line 598) — owner-only, timelocked.
- `SwapFeeRouter.distributeFeesToStakers` 50k-gas pushes to fixed `revenueDistributor` and `polAccumulator` (lines 1334, 1348) — both contracts have minimal `receive()`.

**Confirmed safe pattern.**

---

## Items checked and dismissed (not findings)

### Cross-contract via VotePowerOracle
`VotePowerOracle.powerOf(user, staking, restaking)` performs two staticcalls. During any function that fires this lib internally (vote, claim, etc.), if the staking or restaking contracts are mid-state-change (e.g., during a hook callback in restaking's `unrestake`), would the oracle return inconsistent values?

**Dismissed:** All consumers (`GaugeController.vote`, `VoteIncentives.vote`, `RevenueDistributor._calculateClaim`, `ReferralSplitter.recordFee`) call this from inside their own `nonReentrant` functions OR they read at a historical timestamp. The atomic window during a hook callback in `unrestake` is bounded — restaker-side state is already fully cleared before the user's hook fires, and staking-side state correctly reflects the new owner. No double-count, no zero-vote.

### TegridyPair (V2 fork) callback reentrancy
ERC777-style hooks are explicitly defended against by the factory's `_rejectERC777` (best-effort but covers all three ERC1820 interface variants), and `swap()` is `nonReentrant`. CEI ordering for swap (`_update` reserves BEFORE `safeTransfer` outputs) is correct — no read-only reentrancy via `getReserves()` during a token callback.

### TegridyFeeHook V4 PoolManager unlock callbacks
The hook's `claimFees` settles the hook's positive delta inline via `poolManager.take()` (PASS7-HOOK-01 fix), no callback to user code. `convertERC20FeesToETH` is `onlyOwner` + `nonReentrant`.

### Toweli (token contract)
Standard OZ ERC20Permit; no callback hooks. Not a vector.

### CommunityGrants ETH push paths
All ETH pushes (executeProposal, retryExecution, executeCancelApproved, etc.) go through `_transferETHOrWETH` with 10k stipend. State mutations happen AFTER successful return (CEI-flexed: state is set to FailedExecution OR fully-Executed depending on result). No reentrancy concern.

### Solady ERC721 _mint (vs _safeMint) on TegridyStaking.stake
`stake` uses `_mint`, not `_safeMint` — no `onERC721Received` callback fires on mint. Confirmed by Solady ERC721 source semantics.

### TegridyNFTPoolFactory.createPool / WETH unwrap paths
Factory's pool creation uses `clones` library; no value flow. No reentrancy surface.

### VoteIncentives.commitVote → revealVote
Commit-reveal is purely state-mutating, no value flow. Reveal phase processes votes against snapshot data; no callback.

---

## Summary

**No reentrancy findings of severity HIGH or above.** No findings of severity MEDIUM either. The codebase has consistently applied the OZ ReentrancyGuard pattern, paired with gas-stipend defense (10k Solmate, 50k for smart-account compatibility where outer `nonReentrant` makes it safe) and CEI ordering. The decision in lending/restaking flows to use raw `transferFrom` via `SafeERC721Call.safeTransferFromBounded` (rather than `safeTransferFrom`) for outbound NFT returns is the correct security tradeoff — it eliminates the entire receiver-hook reentrancy surface on the trust-sensitive paths while preserving recovery via `claimStuckCollateral` for hostile collections.

The single observation worth keeping in the security log is **F-41-1** (TegridyTWAP.update unrestricted-gas refund before observation writes). It's not exploitable under the current consumer model, but a future change that lets a third-party contract atomically write a TWAP-derived value during the same transaction as `update()` could open a window. Recommend documenting this assumption in the SequencerCheck/oracle README.
