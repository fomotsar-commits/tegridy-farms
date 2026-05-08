# Agent 01 — TegridyStaking Reentrancy / External-Call Ordering / Callback Abuse

Target: `contracts/src/TegridyStaking.sol` (2,224 lines, Solady ERC721 + OZ ReentrancyGuard).
Lens: classic reentrancy, cross-function reentrancy via JBAC ERC721 callbacks, read-only
reentrancy that affects veTOWELI consumers (gauge weight, revenue claim), cross-contract
reentrancy via Toweli token transfer hooks, ERC777 acceptance, reentrancy-guard placement,
order-of-ops (external call before state update), untrusted address calls, hook-callback abuse.

---

### F-01-A LOW Public ERC721 `transferFrom` / `safeTransferFrom` lack `nonReentrant` modifier
- Location: `contracts/src/TegridyStaking.sol` (inherited from Solady ERC721, lines 252 / 313 / 330 of `lib/solady/src/tokens/ERC721.sol`); used in TegridyStaking via the inherited public surface and the override hooks `_beforeTokenTransfer` (line 1305) + `_afterTokenTransfer` (line 1328).
- Class: cross-function reentrancy / defense-in-depth gap.
- Description: TegridyStaking inherits Solady's `transferFrom` / `safeTransferFrom` verbatim.
  Solady's implementation calls `_beforeTokenTransfer` → ownership swap → `_afterTokenTransfer`
  → `_checkOnERC721Received(to)` (only for `safeTransferFrom`). The `to.onERC721Received`
  callback fires AFTER all state mutations, but the staking contract's own `nonReentrant`
  flag is NOT engaged at that point — `transferFrom` and `safeTransferFrom` are not wrapped.
  This means a hostile recipient `to` can re-enter `staking.safeTransferFrom(self, X, id)` or
  any other unguarded surface without tripping the OZ `ReentrancyGuard._status` flag.
- Exploit: I traced every consequence and could not find a state-corruption exploit.
  Specifically: `_settleRewardsOnTransfer(id, from)` writes `p.rewardDebt = accumulated`
  BEFORE the ownership change, so a hostile `to.onERC721Received` callback that re-enters
  `getReward(id)` finds `accumulated - p.rewardDebt == 0` and gets nothing. The
  `unsettledRewards[from]` credit is owned by `from`, not the new holder. The attempted
  same-block re-transfer hits `lastTransferTime[id] = block.timestamp` (line 1318) and the
  TRANSFER_RATE_LIMIT gate at line 1315 — UNLESS the recipient is a lending contract
  (`lendingExempt`) or restaking-hop, in which case the rate-limit is bypassed by design.
  Even with bypass, the recipient already owns the NFT and calling `withdraw` /
  `earlyWithdraw` (which ARE `nonReentrant` and would block their own callback chain) just
  exits the position normally. No double-payment, no state-skew that I can convert into
  loss.
- Attacker profile: any contract receiving the staking NFT via `safeTransferFrom`.
- Impact: NONE TODAY. Defense-in-depth gap. If a future refactor adds a public mutating
  surface that doesn't carry `nonReentrant`, it would inherit this exposure.
- PoC sketch:
  ```solidity
  contract Hostile {
    function onERC721Received(address, address, uint256 id, bytes calldata) external returns (bytes4) {
      // Try to drain — this is the window where TegridyStaking's nonReentrant is NOT engaged.
      // Empirically every nonReentrant entry on TegridyStaking blocks us; safeTransferFrom
      // back to ourselves hits the rate-limit unless we're whitelisted as lending.
      try staking.safeTransferFrom(address(this), msg.sender, id) {} catch {}
      return IERC721Receiver.onERC721Received.selector;
    }
  }
  ```
- References: TegridyStaking inherits from Solady ERC721. Both Solmate and Solady leave
  `transferFrom` non-reentrant by default. OZ's ERC721 also doesn't wrap them. The codebase's
  `_beforeTokenTransfer` already settles rewards (correct order); the gap is purely
  defense-in-depth. Recommend wrapping `transferFrom` / `safeTransferFrom` overrides with
  `nonReentrant` for future-proofing — at the cost of ~40-60 gas per transfer and ~30B of
  bytecode.

---

### F-01-B INFO `vault.returnJbac` swallows reverts via try/catch — receiver-controlled state-machine branch
- Location: `contracts/src/TegridyStakingJbacVault.sol:87-99` (`returnJbac`); called from
  `contracts/src/TegridyStaking.sol:2074` (inside `_clearPosition`).
- Class: hook-callback semantics / state-machine branching by recipient.
- Description: The vault wraps `jbacNFT.safeTransferFrom(this, to, jbacTokenId)` in
  try/catch. On revert, it records `strandedJbacOwner[stakingTokenId] = to` and
  `strandedJbacTokenId[stakingTokenId] = jbacTokenId`. The recipient `to` is the original
  staker's address (`msg.sender` of the staking-side withdraw call). If `to` is a contract
  that deliberately reverts in `onERC721Received` (out-of-gas, custom revert), the JBAC is
  intentionally stranded for later reclaim via `claimStrandedJbac(stakingTokenId)`.
- Exploit: I could not construct a value-extracting exploit. The principal TOWELI return
  happens in the calling function AFTER `_clearPosition` returns — independent of the JBAC
  branch. The CCR-01 invariant (the staking NFT is `_burn`'d before `vault.returnJbac` is
  invoked) is intact because `_burn` runs at line 2059 of `_clearPosition` BEFORE the JBAC
  external call at line 2075. So a reentrant `transferFrom` from inside the user's
  `onERC721Received` callback would revert on the now-empty `_ownerOf[id]` slot.
- Attacker profile: any user able to deploy a contract address that controls
  `onERC721Received` behaviour.
- Impact: NONE on protocol value. Possible UX nuance: a user who deliberately strands their
  own JBAC can later reclaim it; only consequence is they pay an extra tx. No third-party
  exposure.
- PoC sketch: N/A (cosmetic).
- References: Pattern matches `TegridyRestaking.unrestake` post-C-1 (line 1108) which also
  uses try/catch on the staking-NFT return. Codebase already battle-tests this shape.

---

### F-01-C INFO `_settleRewardsOnTransfer` writes `p.rewardDebt = accumulated` AFTER the cap-and-credit logic
- Location: `contracts/src/TegridyStaking.sol:1475-1538` (`_settleRewardsOnTransfer`).
- Class: order-of-ops; classic check-effects-interaction analog.
- Description: The function structure is:
  1. `_accumulateRewards()` (state-only)
  2. Compute `accumulated`, `diff`
  3. If `diff > 0`: cap to rewardPool, call `_settleUnsettled(from, capped)`, emit events
  4. **Line 1537: `p.rewardDebt = accumulated;`** (anchor advance)
  Steps 3 and 4 are split. If anything in step 3 made an untrusted external call, a
  reentrant `_settleRewardsOnTransfer(id, from)` could observe the OLD `p.rewardDebt` and
  re-credit the same `diff` to `unsettledRewards[from]` a second time.
- Exploit: I traced step 3 and found NO untrusted external calls:
  - `_accumulateRewards`: reads `rewardToken.balanceOf` (Toweli, fixed-supply ERC20, no
    callback), updates internal state.
  - `_settleUnsettled`: pure state mutation on `unsettledRewards[user]` and
    `totalUnsettledRewards`.
  - `_isTrackedHolder`: pure read.
  - `_touch(from)`: pure state mutation.
  - All event emits: no external call.
  So no reentrancy is possible in step 3. The order is safe.
- Attacker profile: N/A — would require a non-standard rewardToken with transfer hooks.
- Impact: NONE today. Defense-in-depth note: if the contract is ever migrated to a hook-
  enabled reward token (ERC777 or ERC20 with transfer fees that callback), step 3 would
  need to be split or `p.rewardDebt` advanced before `_settleUnsettled`.
- References: Line 113-119 NatSpec acknowledges modern-precision standards, but rewardToken
  is constrained to Toweli. `Toweli.sol` is a vanilla OZ ERC20 — no `_afterTokenTransfer`
  callbacks.

---

### F-01-D INFO ERC777 push/pull tokens accidentally accepted as rewardToken — protected by immutable wiring
- Location: `contracts/src/TegridyStaking.sol:148, 442-458` (constructor wiring of `rewardToken`).
- Class: ERC777 / hook-enabled reward token risk.
- Description: `rewardToken` is `IERC20 public immutable rewardToken` set at construction.
  If the deployer mistakenly wires an ERC777-style token, `safeTransferFrom` would invoke
  `tokensReceived` / `tokensToSend` hooks on `from` and `to`, opening reentrancy on every
  reward path.
- Exploit: requires deploy-time misconfiguration. Toweli is a vanilla OZ ERC20 (verified by
  cross-reading `Toweli.sol` references in the codebase context — protocol description in
  the prompt confirms "1B fixed-supply ERC20"). No exploit on a correct mainnet deploy.
- Attacker profile: deployer / governance.
- Impact: NONE on a correct deploy. A misconfigured deploy would compromise every reward
  path.
- References: Audit comment at line 148-158 affirms Toweli wiring intent. No on-chain
  enforcement of "vanilla ERC20" — relies on deploy discipline.

---

### F-01-E LOW `executeEmergencyExit` is `nonReentrant updateReward` but NOT `whenNotPaused` — `_creditRewardPool` may bump `rewardPerTokenStored` while emissions frozen
- Location: `contracts/src/TegridyStaking.sol:1778-1812` (`executeEmergencyExit`); helper
  `_creditRewardPool` at line 2207.
- Class: state mutation during pause window / accounting consistency.
- Description: `executeEmergencyExit` is intentionally pause-independent (so users can
  always exit). When `earlyExit == true` (lock not yet expired at execution time), the
  function calls `_splitPenalty(penalty)` and, if `recycled > 0`, calls
  `_creditRewardPool(recycled)`. `_creditRewardPool` directly bumps
  `rewardPerTokenStored`. If the contract is currently `paused()`, the natspec at
  line 689-693 says `_accumulateRewards` skips emission while paused. But
  `_creditRewardPool` writes UNCONDITIONALLY — bypassing the pause-aware emission throttle.
- Exploit: a pause is owner-triggered. While paused, an emergency exit by user A with
  `earlyExit=true` and non-zero `penaltyRecycleBps` credits `rewardPerTokenStored`. When
  the contract unpauses, the next reward-touching call by user B (who was holding through
  the pause) finds an inflated `rewardPerTokenStored` reflecting the recycled penalty —
  but `lastUpdateTime` was advanced to current `block.timestamp` (per line 727 in
  `unpause`). So user B's `accumulated - p.rewardDebt` correctly captures the recycle slice
  without double-counting. Net effect: the recycle distribution proceeds correctly even
  during pause.
- Attacker profile: governance-controlled (pause + penaltyRecycleBps both timelocked).
- Impact: NEGLIGIBLE. The pause window is supposed to freeze ALL state changes that affect
  reward accounting, but the recycle credit is functionally orthogonal — it's a one-shot
  credit, not an emission. Could surprise off-chain monitors that assume "paused = state
  static."
- References: Pattern is the same as `_creditRewardPool` calls in `earlyWithdraw` (line
  1002) and the `extendFee` recycle (line 2142). The recycle invariant is preserved.

---

### F-01-F INFO Cross-contract read-only reentrancy on `votingPowerOf` / `totalBoostedStakeAtTimestamp` is closed by checkpoint ordering
- Location: `contracts/src/TegridyStaking.sol:528-547, 571-573` (view functions); checkpoint
  writes at `_clearPosition:2069-2070`, `_writeCheckpoint`, `_writeTotalBoostedStakeCheckpoint`.
- Class: read-only reentrancy / consumer state consistency.
- Description: External consumers (RevenueDistributor, GaugeController, VoteIncentives,
  CommunityGrants, MemeBountyBoard, ReferralSplitter, SwapFeeRouter, TegridyLPFarming) call
  `votingPowerOf(user)`, `votingPowerAtTimestamp(user, ts)`, `aggregateActiveBoostBps(user)`,
  `totalBoostedStakeAtTimestamp(ts)`. Reentrancy concern: when a user/contract is mid-call
  inside TegridyStaking, can they re-enter a CONSUMER and have it read inconsistent state?
- Exploit attempt: I traced every external-call exit point inside TegridyStaking:
  - `rewardToken.safeTransfer` / `safeTransferFrom`: Toweli is vanilla ERC20, no callbacks.
    Even if it had callbacks, all state mutations happen BEFORE the transfer in every path
    I checked (see tests at withdraw/earlyWithdraw/getReward/_clearPosition).
  - `vault.returnJbac` (in `_clearPosition`): the `_writeCheckpoint(msg.sender)` and
    `_writeTotalBoostedStakeCheckpoint()` are called BEFORE the vault external call (lines
    2069-2070, vault call at 2074). Inside the vault, the JBAC `safeTransferFrom` triggers
    `to.onERC721Received` (i.e., the user's own callback). At that callback moment:
    - `_positionsByOwner[user]` already has the burned token removed (Solady `_burn` runs
      `_afterTokenTransfer` which removes it).
    - `_checkpoints[user]` already updated (post-burn).
    - `_totalBoostedStakeCheckpoints` already updated (post-burn).
    So a consumer queried via re-entry sees the POST-BURN state, which is consistent. ✓
  - `jbacNFT.safeTransferFrom` (in `stakeWithBoost`): the recipient is the JBAC vault, not
    the user. The vault's `onERC721Received` only verifies `msg.sender == jbacNFT` and
    returns the magic value — no external call out, no reentrancy lift.
- Attacker profile: would need a hook-enabled token in the staking flow, which the codebase
  doesn't allow.
- Impact: NONE on the current architecture.
- References: Curve veCRV's classic read-only-reentrancy pattern (which led to the 2022
  multi-protocol drain) hinges on `totalSupply` / `balanceOf` being mutated AFTER an
  external call. TegridyStaking's pattern is the inverse — checkpoints commit before any
  external call.

---

### F-01-G LOW `_clearPosition` calls `vault.returnJbac` AFTER state changes, but the JBAC return failure path silently leaves `unsettledRewardsByTokenId[tokenId]` orphaned for the burned tokenId
- Location: `contracts/src/TegridyStaking.sol:2049-2077` (`_clearPosition`); the
  `unsettledRewardsByTokenId[tokenId]` mapping (line 256, 1130, 1148, 1527).
- Class: state-cleanup / dangling-mapping risk on burn path.
- Description: When `_clearPosition` runs, the staking NFT is burned (`_burn(tokenId)`).
  However, `unsettledRewardsByTokenId[tokenId]` is NOT explicitly cleared. Per the
  attribution invariant (DS-08, line 1672-1686, `_isTrackedHolder`),
  `unsettledRewardsByTokenId[tokenId]` is only credited when the holder is a "tracked
  holder" (restaking contract or lending contract). For a regular user-held position, this
  mapping is never written, so there's nothing to clean up on user-side burns.
  But for a tracked holder — if a burn happens directly (e.g., the restaking contract or
  lending contract's burn path on its own held position), `unsettledRewardsByTokenId[id]`
  could persist. After burn, `tokenId` could be reused only via `_nextTokenId++` on a fresh
  stake (which is monotonically increasing), so collision is impossible. So the dangling
  mapping is a storage-cost concern, not a correctness bug.
- Exploit: none possible. The mapping is keyed by `tokenId` (uint256, monotone, non-
  reusable). Even if a stale entry persists for a burned tokenId, no future stake will
  re-occupy that ID.
- Attacker profile: N/A.
- Impact: NEGLIGIBLE — minor gas overhead from non-deletion. No double-claim possible.
- References: The codebase's burn flow (line 2057-2059) deletes `positions[tokenId]` and
  `_emergencyExitRequests[tokenId]` but not `unsettledRewardsByTokenId`. Adding a `delete
  unsettledRewardsByTokenId[tokenId]` to `_clearPosition` would be defense-in-depth.

---

### F-01-H INFO `setJbacVault` is one-shot but sets `jbacVault` to a contract address without verifying it implements `ITegridyStakingJbacVault`
- Location: `contracts/src/TegridyStaking.sol:466-472` (`setJbacVault`).
- Class: misconfiguration risk / interface verification gap.
- Description: `setJbacVault(_vault)` checks: non-zero, not already set, has code. It does
  NOT verify that `_vault` implements `ITegridyStakingJbacVault.returnJbac`. If the deployer
  wires a wrong contract (e.g., a different vault that doesn't implement `returnJbac`), the
  first JBAC withdraw would revert on the vault call, blocking exits for JBAC-deposit
  positions. The one-shot lock means recovery requires deploying a new staking contract.
- Exploit: requires deploy-time misconfiguration. Not a runtime attack.
- Attacker profile: deployer (governance).
- Impact: NONE on a correct deploy. A misconfigured deploy would softlock JBAC-deposit
  positions until governance migrates the contract.
- References: TegridyStakingJbacVault constructor (`vault.staking == address(this)`) is the
  pairing check from the vault side. The staking side doesn't verify the reverse pairing.

---

## Notes / dead-ends

1. **`_settleRewardsOnTransfer` order-of-ops** — the `p.rewardDebt = accumulated` write at
   line 1537 is at the END of the function, after `_settleUnsettled` and event emits. I
   verified that no untrusted external calls happen between the read of `p.rewardDebt` (line
   1483) and its write (line 1537). The order is safe under the current rewardToken model
   (Toweli, vanilla OZ ERC20). Listed as F-01-C for defense-in-depth visibility only.

2. **JBAC return reentrancy via user's `onERC721Received`** — verified that the staking
   contract's `nonReentrant` lock is engaged at every entry point that could be exploited.
   Specifically: `withdraw` / `earlyWithdraw` / `emergencyWithdrawPosition` /
   `emergencyExitPosition` / `executeEmergencyExit` are all `nonReentrant`. The JBAC return
   happens inside `_clearPosition` which is called from these functions, so the
   `_status = ENTERED` flag is set for the entire callback chain. ✓

3. **CCR-01 invariant** — the staking NFT `_burn(tokenId)` runs BEFORE
   `vault.returnJbac(tokenId, jbacId, to)`. Verified at line 2059 (burn) and line 2074
   (vault call). A reentrant `transferFrom(staking_nft, X, tokenId)` from inside the JBAC
   `safeTransferFrom` callback would revert on the empty `_ownerOf[id]` slot. ✓

4. **Toweli rewardToken is vanilla ERC20** — confirmed via the protocol description
   ("1B fixed-supply ERC20 governance/reward token"). No transfer hooks, no callbacks.
   Every `rewardToken.safeTransfer` / `safeTransferFrom` is non-reentrant.

5. **`updateReward` modifier ordering** — `updateReward()` runs `_accumulateRewards()`
   FIRST (before the function body). This is correct: pending rewards crystallize against
   the OLD `totalBoostedStake` BEFORE any state mutation in the function body. Consistent
   with Synthetix `StakingRewards` and Curve `LiquidityGauge`.

6. **`pause()` / `unpause()` are NOT `nonReentrant`** — owner-only, no external calls.
   Acceptable.

7. **`_creditRewardPool` is purely state-mutating** — no external calls; safe under
   `nonReentrant`.

8. **`safeTransferFrom` of staking NFT TO the staking contract itself is not possible** —
   the contract doesn't implement `IERC721Receiver` (per batch-14 NatSpec at line 38-40).
   Solady's `_checkOnERC721Received` would revert. ✓

9. **EIP-7702 delegated EOAs** — if a user with a 7702-delegated address has malicious
   delegate code, they could trigger `onERC721Received`-style reentrancy on the JBAC return
   leg. But the staking-side `nonReentrant` blocks any exploit. Listed as a defense-in-
   depth concern only.

10. **`emergencyWithdrawPosition` is `nonReentrant whenPaused`** but does NOT call
    `_getReward` first — by design (`AUDIT FIX #11` natspec). All pending rewards are
    forfeited as the cost of emergency exit during pause. State mutations all happen via
    `_clearPosition` → reward token transfer. Safe. ✓

11. **`kick()` reward-preservation hardening** (DS2-01/02/03) — verified that
    `revert KickWouldForfeit()` (line 1168) blocks any kick that would silently destroy a
    holder's slice. The kick path is `nonReentrant`, all credits route through
    `_settleUnsettled` (state-only, no external call). ✓

12. **Cross-function reentrancy via `claimUnsettledForTokenId`** — gated by
    `_isTrackedHolder(msg.sender)` (line 1641) so only restaking/lending contracts can
    drain the per-tokenId bucket. Both target contracts are `nonReentrant` at their
    drain-entry callsites. ✓

13. Did NOT find a concrete classic-reentrancy / cross-function-reentrancy / read-only-
    reentrancy / cross-contract-reentrancy / hook-callback-abuse exploit on TegridyStaking
    paths within the scope of this audit. The contract appears thoroughly hardened against
    reentrancy. The findings above are defense-in-depth notes; F-01-A and F-01-G are the
    only ones with even a theoretical future-refactor exposure.
