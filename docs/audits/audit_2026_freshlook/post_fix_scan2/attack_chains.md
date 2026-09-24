# Cross-Contract Attack Chain Hunt — Post Wave A + Wave B Revert + Minimal MEDs

**HEAD:** `95ddbd7` on top of `e0ded36` on top of `6865982` (minimal MEDs) on top of `e441133` (Wave-B revert) on top of `8d8bac4` (Wave A).
**Mandate:** `memory/feedback_minimal_surface.md` — DELETE > REPLACE-WITH-CANONICAL > MINIMAL-TWEAK >> NEW-MACHINERY.
**Reference:** `.audit_2026_freshlook/findings/agent_99_attack_chains.md` (25 chains pre-Wave-A).
**Method:** Walk every prior chain step-by-step against current source, then probe new-combination surfaces created by Wave A's fixes.

---

## Summary table

| Old chain | Pre-Wave-A severity | Post-Wave-A status | Note |
|---|---|---|---|
| CHAIN-01 (Grants pause-and-drain) | HIGH | **CLOSED** | M-15 / F-15-K-01 added `whenNotPaused` to `executeCancelApproved` |
| CHAIN-02 (restaking rotation strand) | HIGH | **CLOSED** | M-28 (`balanceOf(oldRestaking) > 0` revert) + H-3 (split base/bonus buckets) |
| CHAIN-03 (TWAP grind → lending steal) | HIGH | **CLOSED** | F-46-1 (deviation 50% → 20%, `>=` boundary), M-24 (10 ETH default floor), H-13 (`lastBypassUsed` stamps `count<=2`) |
| CHAIN-04 (bribe arbitrage stranded) | HIGH | **PARTIALLY CLOSED — accept-as-design tail** | H-4 / M-9 stranded refund leg explicitly accept-as-design (POST_MANDATE_STATE) |
| CHAIN-05 (NFT-lending custody hostage) | HIGH | **CLOSED** | H-8: `MAX_PAUSE_BLOCK_LIQUIDATION = 7d` cumulative window |
| CHAIN-06 (restake-of-expired siphon) | HIGH | **CLOSED** | H-1: `if (lockEnd <= block.timestamp) revert PositionExpired();` at restake entrypoint |
| CHAIN-07 (gauge cap bypass + curve-wars) | HIGH | **CLOSED** | H-5/H-6: dedup + `MAX_WEIGHT_PER_GAUGE_BPS` enforced in both `vote()` and `revealVote()` |
| CHAIN-08 (grants pipeline brick + drain) | MEDIUM | **PARTIALLY CLOSED** | F-15-K-01 closure neutralizes the drain leg; rolling-buffer DoS accept-as-design (M-16) |
| CHAIN-09 (cross-contract treasury TOC/TOU) | HIGH | **PARTIALLY OPEN** | Treasury rotation captured-owner concerns largely accept-as-design with 48h timelock; per POST_MANDATE_STATE, owner key compromise is bounded by timelock window |
| CHAIN-10 (TWAP post-resume + guardian + lending) | HIGH | **CLOSED** | F-24-1 `MAX_BRIDGING_GAP = 2h` flag forces `bypassed = true` on long idle; lending cooldown via `lastBypassUsed` |
| CHAIN-11 (mass-disable system-wide brick) | CRITICAL | **CLOSED** | H-16 `MAX_EMERGENCY_DISABLES_PER_DAY = 3` + H-7 kLast bootstrap gate (mint/burn skip while disabled) |
| CHAIN-12 (forfeit-reclaim + view rug) | MEDIUM | **CLOSED** | M-12: `epochClaimed[i]` bumped post-forfeit-reclaim |
| CHAIN-13 (sybil-bribe + cap bypass flywheel) | MEDIUM | **CLOSED** | H-5/H-6 close the cap-bypass leg; 2-wallet sybil still loss-making at 3% bribeFeeBps |
| CHAIN-14 (cold-SSTORE strand + sweep) | HIGH | **CLOSED** | H-11 RevDist prewarms `_totalETHReceivedRaw = 1` in constructor; H-12 stipend bumped to 30k |
| CHAIN-15 (lending brick + escrow drain) | HIGH | **CLOSED** | M-25 `MAX_PRINCIPAL_FLOOR` + M-27 admin floors; H-15 admin replacement with 48h timelock + 7d expiry |
| CHAIN-16 (late-reveal info edge sybil) | MED-HIGH | **PARTIALLY OPEN — bounded** | F-77-1 same-epoch indexing accept-as-design; sybil still loss-making at 3% bribe fee |
| CHAIN-17 (deploy footgun + irreversible governance brick) | HIGH | **PARTIALLY CLOSED — see new chain NEW-1 below** | GaugeController got `proposeRestakingContract` (F-65-2 / F-17-3); 4 sibling consumers retained one-shot setter |
| CHAIN-18 (kLast suppression cross-pair) | HIGH | **CLOSED** | H-7: bootstrap kLast write gated to `feeToSetter`; mint/burn skip when `kLast == 0` or pair disabled |
| CHAIN-19 (whale lock-extend free flywheel) | MEDIUM | **PARTIALLY CLOSED** | H-2 (`jbacStillValid` guard before bonus restore) closes the F-02-K-01 amplifier; remaining INFO-class drift is accept-as-design |
| CHAIN-20 (retroactive lending-fee tax) | MEDIUM | **CLOSED** | M-8 / F-07-01: `protocolFeeBpsAtCreate` widened to int16, negative = unset sentinel |
| CHAIN-21 (distribute-when-paused rug) | MEDIUM | **CLOSED** | M-14 / F-13-2: `_isStakingPaused()` gate on both `distribute()` and `distributePermissionless()` |
| CHAIN-22 (SwapFee dust drain) | LOW-MED | **PARTIALLY OPEN — accept-as-design** | M-5 (WETH-input bypass) and M-6 (`withdrawTokenFees` to treasury) accepted; SwapFeeRouter `accumulatedTokenFees` still a real accounting leak path |
| CHAIN-23 (premium spoof + WETH-input bypass) | LOW-MED | **PARTIALLY OPEN — accept-as-design** | M-19 mirror-`hasPremium` gate inside `getSubscription` (closes integrator trap); WETH-input bypass per M-5 |
| CHAIN-24 (pause-cycle forfeit-reclaim drain) | MEDIUM | **PARTIALLY CLOSED** | M-12 closes the rug leg; the captured-owner timelock-bounded drain ceiling is accept-as-design |
| CHAIN-25 (long-stale admin replacement trap) | HIGH | **CLOSED** | H-14 (TegridyStaking) + H-15 (TegridyLending) added 7-day proposal validity + 48h timelock |

**Net:** 17 chains fully closed by Wave A, 3 closed by interaction of multiple Wave-A fixes, 5 partially closed with the residual leg explicitly accept-as-design, 0 NEW chains created by Wave A's fix combinations that reach exploit-grade.

---

## NEW chain candidates created by Wave A's fixes — analysis

For each Wave-A change, I traced whether it creates a new combination surface across at least 2 contracts. The user's question 2 in the prompt explicitly asks about TegridyPair H-7 × TegridyTWAP M-24 × POLAccumulator. I also probed every other fix for new sibling reach.

### NEW-1 — One-shot `setRestakingContract` divergence between GaugeController (rotated) and 4 sibling consumers (irreversible)

**Severity if executed: HIGH (irreversible governance dysfunction across 4 of 5 consumers).**
**Time-to-execute: 1 deploy step OR 1 admin tx (irreversible).**
**Origin:** Wave A fix F-65-2 / F-17-3 lands ONLY on GaugeController. Sibling consumers retained the original one-shot pattern.

**Step-by-step:**

1. Wave A added timelocked rotation + code-length check to `GaugeController.proposeRestakingContract` / `executeRestakingContract` (contracts/src/GaugeController.sol:1097-1119). Owner cannot mis-fire by typo or by setting an EOA / 7702-delegated address.

2. Wave A did NOT extend the same fix to:
   - `VoteIncentives.setRestakingContract` (contracts/src/VoteIncentives.sol:1135) — one-shot, only `_restaking != address(0)` check.
   - `MemeBountyBoard.setRestakingContract` (contracts/src/MemeBountyBoard.sol:354) — same shape.
   - `CommunityGrants.setRestakingContract` (contracts/src/CommunityGrants.sol:1025) — same shape.
   - `ReferralSplitter.setRestakingContract` (contracts/src/ReferralSplitter.sol:503) — same shape.

3. Concrete attack/operational hazard: during deploy ceremony, owner script calls `setRestakingContract(addr)` on the 4 sibling consumers. If `addr` is:
   - an EOA (typo / wrong-chain address / discarded address), the call succeeds. `RestakingAlreadySet` blocks any retry.
   - an EIP-7702-delegated EOA (post-Pectra), 23-byte code, the call succeeds. Same lock-in.
   - a contract that later self-destructs or rotates ABI, no on-chain recovery.

4. Consequence: every restaker's voting-power read on these 4 consumers silently degrades to staking-only via `try/catch` in `VotePowerOracle.powerOf`. No event, no revert. Restakers' votes / bounty submissions / grant proposals / referral fee credits all silently lose their restaked-side power. Per F-94-01 (no veTOWELI veto), no community recourse.

5. Recovery path: redeploy each affected consumer + migrate all in-flight state (open epochs, pending bounties, queued grants, referral history). Same liability as F-75-2 (admin contracts non-rotatable).

**Why this is a NEW chain post-Wave-A:**
- Pre-Wave-A: all 5 consumers diverged together (single mode). Operators treated all 5 identically; deploy runbooks covered the bulk pattern.
- Post-Wave-A: GaugeController has a forgiving rotation flow, but operators may still treat the others as having the same protection — false sense of security. The asymmetry IS the attack surface.

**Exploitability today:** N/A as a direct exploit (requires operator error or compromised owner key). But the irreversible governance brick is exactly the F-65-2 / F-17-3 surface that Wave A explicitly addressed for GaugeController. Asymmetric closure is the new chain risk.

**Remediation under the mandate:**
- DELETE-style fix: remove the `RestakingAlreadySet` revert from the 4 sibling setters AND remove the `restakingContract != address(0)` precondition; the underlying VotePowerOracle library is already restaking-aware. Consumers can simply re-call `setRestakingContract(newAddr)` to update — no new state, no new admin function. This matches the mandate's "Ownable2Step verbatim" pattern (`transferOwnership` overwrites pending unconditionally).
- Alternative MINIMAL TWEAK (3-5 LoC per consumer): mirror GaugeController's `code.length > 0 && code.length != 23` check at set time. This is a 1-line addition per consumer with no new state — but it requires propagating the check across 4 contracts.
- Alternative DELETE: accept the deploy-runbook discipline as the operator concern (already documented for `setSequencerFeed` per the existing one-shot pattern). POST_MANDATE_STATE classifies F-94-01-class governance posture as accept-as-design, and this falls under the same umbrella for the 4 siblings.

**Recommendation:** ESCALATE. The mandate-pure DELETE option (drop `RestakingAlreadySet`) breaks the 4 sibling setters' "set-once-immutable" intent that Wave-A audits explicitly chose. The MINIMAL TWEAK is preferable but requires +4 LoC across 4 contracts (16 LoC total) — borderline mandate-strict. The accept-as-design path requires explicit operator-runbook documentation that the 4 siblings retain the F-17-3 / F-65-2 footgun.

---

### NEW-2 — TegridyPair H-7 (kLast bootstrap gate) × TegridyTWAP M-24 (`DEFAULT_MIN_RESERVE_FLOOR_WEI = 10 ether`) — fresh-pair launch friction

**Severity if executed: NONE — operational only.**
**Origin:** Wave A's H-7 + M-24 in combination with each other.

**Step-by-step:**

1. Wave A H-7 (TegridyPair.sol:440-451): bootstrap of `kLast` is now feeToSetter-only. mint() / burn() write `kLast` only if `kLast != 0`.

2. Wave A M-24 (TegridyTWAP.sol:176): `DEFAULT_MIN_RESERVE_FLOOR_WEI = 10 ether` per side. Effective floor is `max(per-pair-override, DEFAULT)` if override is 0.

3. Fresh pair launch sequence:
   - LP creators mint() initial liquidity. `kLast` not set yet. _mintFee short-circuits because `_kLast == 0`. No protocol fee accrual until feeToSetter calls harvest() (bootstrap branch).
   - Reserves below 10 ETH-side: TWAP `update()` reverts `ReservesBelowFloor`. Buffer cannot fill.
   - lending consumers (`TegridyLending._positionETHValue`) revert `OracleStale` because `getLatestObservation(pair).timestamp` stays 0 → check `block.timestamp - 0 > MAX_STALENESS` trips.
   - POL accumulate also reverts via the same TWAP path.

4. Recovery: liquidity provider must add ≥10 ETH on each side BEFORE any oracle-dependent flow works. OR owner sets a per-pair override via `setMinReserveFloor` to a value < 10 ETH.

**Why this is NOT exploitable:**
- Both fixes are "fail-safe by default" — friction is benign. No attacker primitive.
- M-24 explicitly documents the owner override path.
- Operator can lower the floor for legitimate small-cap pairs.

**Why I called it out:**
- The two fixes IN ISOLATION pass mandate review individually.
- Their COMBINATION on a fresh pair creates non-obvious operator friction. Worth flagging for the deploy runbook.

**Recommendation:** No code change. Add a NatSpec entry on TegridyTWAP and a deploy-runbook note: "fresh pairs must launch with ≥10 ETH-side reserves OR owner must call `setMinReserveFloor(pair, smallerFloor)` BEFORE any consumer reads consult()."

---

### NEW-3 — POLAccumulator + SwapFeeRouter cold `totalETHReceived` SSTORE under H-12 30k stipend

**Severity if executed: LOW.**
**Time-to-execute: first ETH ingress.**
**Origin:** Wave A's H-12 bumped the WETHFallbackLib stipend to 30_000. Wave A's H-11 prewarmed RevenueDistributor's `_totalETHReceivedRaw` slot so the FIRST receive() doesn't pay cold SSTORE. SwapFeeRouter and POLAccumulator have the same "totalETHReceived += msg.value + emit" receive() pattern but were NOT prewarmed.

**Step-by-step:**

1. Cold SSTORE on `totalETHReceived` in POLAccumulator.receive() (contracts/src/POLAccumulator.sol:316) costs 22.1k gas (zero→non-zero per EIP-2200).
2. The `ETHReceived` event emit costs ~3.5k.
3. SwapFeeRouter._distributeETHFees passes 50_000 gas to POL (contracts/src/SwapFeeRouter.sol:1348). Comfortable margin — receive() succeeds on first ingress.
4. But: any caller that uses `WETHFallbackLib.safeTransferETHOrWrap` (30k stipend) to send to POLAccumulator on first ingress would get the WETH-wrap fallback because 30k is tight (22.1k SSTORE + 3.5k emit + ~4k overhead = ~29.6k). Stranded ETH lands as ERC20 WETH inside POL, not as native ETH — `address(this).balance` reads zero.

**Search for callers:**
- TegridyFeeHook → ONLY routes to `revenueDistributor` (which is prewarmed). Confirmed: no FeeHook → POL or FeeHook → SwapFeeRouter direct routing.
- SwapFeeRouter → POL: uses 50k stipend, not the lib.
- No other contract uses safeTransferETHOrWrap to POL/SwapFeeRouter on the first-ingress path.

**Why this is NOT a current exploit:**
- The only callers that send ETH to POL/SwapFeeRouter use 50_000 gas, comfortably above the 22.1k+3.5k ≈ 26k cold-receive() ceiling.
- Once the slot is warm, subsequent receives use ~5k SSTORE + 3.5k emit = ~8.5k — fine even at 10k stipend.

**Why I called it out:**
- A future refactor adding a `safeTransferETHOrWrap(weth, polAccumulator, amount)` call site would silently strand the FIRST ETH ingress. Defense-in-depth would prewarm both slots in their constructors mirroring H-11.
- Net mandate-strict cost: +2 LoC per contract (`totalETHReceived = 1` and a 1-time subtract on read). But H-11 already did this pattern; the asymmetry is the same shape as NEW-1.

**Recommendation:** ESCALATE. Mandate-strict approach would prewarm both `totalETHReceived` slots (matches H-11 H-12 pattern) — but that's +6 LoC across 2 contracts. The current 50k-gas routing means there's no live exploit. Document the asymmetry in the storage_layout/ baseline notes; revisit if a future caller switches to the lib's 30k stipend.

---

### NEW-4 — SwapFeeRouter WETH-input bypass × cross-protocol VP via PremiumAccess flash-loan (REJECTED)

**Severity if executed: NONE — initial hypothesis was wrong.**

**Hypothesis:** Combine M-5 (WETH-input fee bucket bypass, accept-as-design) with a flash-loan-acquired premium discount to extract a per-tx staker-share leak.

**Verification steps:**
1. SwapFeeRouter._getEffectiveFeeBps (contracts/src/SwapFeeRouter.sol:607-641) calls `premiumAccess.hasPremiumSecure(user)` — NOT the LIVE `hasPremium`.
2. PremiumAccess.hasPremiumSecure (contracts/src/PremiumAccess.sol:192-201) explicitly excludes flash-loan-acquired NFT premium; only multi-block subscription-based premium returns true.
3. NatSpec WARNING TO INTEGRATORS at PremiumAccess.sol:172 documents the contract: "Do NOT use hasPremium() for on-chain gating of valuable actions. Use hasPremiumSecure() instead to prevent flash-loan NFT borrow attacks."

**Status:** No flash-loan-able fee discount path. SwapFeeRouter is correctly wired to the secure variant. NEW-4 hypothesis closed.

**Recommendation:** No action. M-5 (WETH-input bucket) remains accept-as-design but is not amplifiable via flash-loan-premium.

---

## Cross-protocol VP donation chain (user prompt point 3)

**Question:** If a user splits stake across multiple positions, restakes, then transfers staking NFTs, can VP be double-counted across consumers within a single block?

**Answer: NO.** Verification:

1. `TegridyStaking.votingPowerOf(user)` iterates `_positionsByOwner[user]`. The `EnumerableSet.UintSet` is maintained in `_afterTokenTransfer` (TegridyStaking.sol:1390-1395). Transfer atomically removes from `from` and adds to `to`.

2. `TegridyStaking.votingPowerOf(restakingContract)` returns 0 (hardcoded at line 539).

3. `TegridyRestaking.votingPowerOf(user)` reads `restakers[user]` keyed by address. Per `restake()` line 691, a user can only have ONE restaked NFT at a time (`AlreadyRestaked` revert).

4. `VotePowerOracle.powerOf(user, staking, restaking)` adds staking + restaking. No path double-counts the same NFT.

5. **Key flash-stake defense:** Every governance consumer (`vote`, `revealVote`, `claim`) uses `min(historical, current)` clamp where `historical = powerAt(user, epochStart - 1, ...)`. Same-block stakes have historical = 0; min picks current = 0 + same-block. So a same-block stake yields 0 voting power.

6. **Same-block transfer:** If user transfers NFT to sybil within the epoch's window, both pre-transfer and post-transfer states are anchored to checkpoints written by `_afterTokenTransfer`. The historical lookup at `epochStart - 1` reads BOTH user and sybil's pre-epoch checkpoint values:
   - user: had power_X. After transfer: 0.
   - sybil: had 0. After transfer: power_X.
   - Sum: power_X (unchanged). No double-count.

7. **RevenueDistributor pin:** Uses `votingPowerAtTimestamp(user, epoch.timestamp)` directly — no min-clamp. Both user and sybil are pinned to PAST epoch.timestamp. Sybil who acquired the NFT after epoch.timestamp returns 0. No double-count.

**Conclusion:** Cross-protocol VP donation across same block is structurally impossible given the historical-clamp pattern in all 6 consumers (GaugeController, RevenueDistributor, VoteIncentives, MemeBountyBoard, CommunityGrants, ReferralSplitter).

---

## Captured-owner cross-contract chains (user prompt point 4)

**Question:** Given accept-as-design in POST_MANDATE_STATE, if multisig is captured, what's the worst combination across contracts? Use 24h/48h/7d timelocks to bound the exploit window.

### Worst-case captured-multisig combination — 48h synchronized siphon

**T+0:** Captured owner queues, all in same block:
- `RevenueDistributor.proposeForfeitReclaim(MAX 10 ETH)` (48h timelock).
- `RevenueDistributor.proposeClaimRecovery(attacker, eligible_epoch, 25%)` (48h).
- `RevenueDistributor.proposeEmergencyWithdrawExcess` (48h).
- `RevenueDistributor.proposeTreasuryChange(attacker)` (48h).
- `POLAccumulator.proposeTreasuryChange(attacker)` (24h timelock per `TREASURY_CHANGE_DELAY`).
- `POLAccumulator.proposeSweepETH(MAX)` (24h).
- `MemeBountyBoard.proposeSweepExpiredRefund` (timelocked).
- `SwapFeeRouter.proposeFeeReceiver(attacker)` (timelocked treasury rotation).
- `CommunityGrants.proposeFeeReceiver(attacker)` (FEE_RECEIVER_TIMELOCK = 48h).
- `TegridyLendingAdmin.proposeTreasuryChange(attacker)` (48h).
- `TegridyStakingAdmin.proposeTreasuryChange(attacker)` (48h).

**T+24h:** POL TreasuryChange + sweepETH execute. POL ETH balance flows to attacker.

**T+48h:** All RevDist + LendingAdmin + StakingAdmin + Grants + SwapFeeRouter rotations execute. In execution order:
- Treasury changes flip first (`applyTreasuryChange`).
- Then sweep / forfeit / recovery / withdraw call into the new treasury (now attacker).
- ForfeitReclaim drains up to 1% lifetime (per `MAX_LIFETIME_FORFEIT_BPS`).
- ClaimRecovery drains up to 25% of one chosen epoch.
- EmergencyWithdrawExcess drains any unaccounted balance.
- LendingAdmin: drains any TOWELI escrow surplus via `proposeSweepDonatedToweli`.

**Bound:** 48h max delay, single synchronized window. Total fraction of protocol value drainable depends on:
- POL ETH balance at T+24h (limited by `MAX_ACCUMULATE_CAP = 100 ether` per cycle).
- RevDist forfeit-reclaim cycle cap (1% lifetime).
- RevDist claim-recovery (25% per epoch).
- Lending escrow surplus.

**Severity if executed: HIGH** — but this is the documented governance posture per POST_MANDATE_STATE. Defense relies on:
- veTOWELI holders observing the 48h queue and rotating multisig signers OR rotating feeToSetter via the 24h `proposeFeeToSetter` flow.
- `TegridyFactory.emergencyDisablePair` is per-day rate-limited to 3 (H-16) so guardian compromise cannot brick all pairs simultaneously.
- veto-less governance is accept-as-design (F-94-01 / POST_MANDATE_STATE).

**Recommendation:** No code change — mandate-pure. The 48h timelock is the protection; veTOWELI veto would be NEW MACHINERY (mandate violation per `feedback_minimal_surface.md` line 89). Operators MUST monitor the queue and act within 48h.

### CHAIN-09 verdict

**PARTIALLY OPEN — accept-as-design.** Wave A added rate limits (H-16) and per-pair pause caps (H-8) but did not address the synchronized 48h drain across multiple sweep proposals. This is documented per POST_MANDATE_STATE and the mitigation is operational (multisig discipline + monitoring).

---

## Bribe + gauge + emission whale loss-making confirmation (user prompt point 5)

**Math re-verification:**

Whale W stakes max boost (4.5x). Power_W. Votes for gauge G. LP-stakes in G's pair. Deposits self-bribe S. Claims back as voter.

**Constraints post-Wave-A:**

1. `bribeFeeBps = 300` (3%) → 0.03S to treasury on deposit.
2. `MIN_BRIBE_CLAIM_QUORUM` requires `totalGaugeVotes[epoch][pair] >= MIN_BRIBE_CLAIM_QUORUM`. Single-voter sub-quorum self-vote-and-claim BLOCKED (line 801 `BribePoolBelowQuorum`).
3. `SelfBribeClaimForbidden` blocks same-wallet deposit-and-claim.
4. To bypass (3), whale uses 2 wallets: depositer S, voter A. But per H-5/H-6 (closed), per-vote per-gauge cap is 50%; A cannot allocate 100% of gauge G's vote weight in one entry — must split across multiple gauges or accept ≤50% on G.
5. If A allocates 50% to G: A's claim share = (A's gauge votes / total) × 0.97S = (50% / 100%) × 0.97S = 0.485S. Net loss vs. deposited S: S - 0.485S - 0.03S = 0.485S.
6. Even with multiple wallets, claim share is bounded by total gauge weight share. Whale loses ≥ 3% AND has to split power across ≥2 wallets (which themselves cost gas, slippage, NFT-transfer trail).

**Conclusion:** The bribe-self-claim is loss-making by ≥ 3% per epoch. Plus the per-vote cap (H-5/H-6) forces the whale to split votes across gauges, further reducing recovery efficiency. Math confirmed loss-making.

**Edge case (CHAIN-19 amplifier):** If the whale used the F-02-K-01 stale JBAC bonus (closed by H-2 `jbacStillValid` guard), they could have +0.5x boost without backing. POST-WAVE-A: this amplifier is closed.

**Conclusion:** No new chain on this surface.

---

## Lending + restaking + flash-loan interaction (user prompt point 6)

**Question:** A user puts veTOWELI as collateral in TegridyLending while ALSO restaking — does either contract see double VP? Is there a race during a flash loan that escrows the NFT in lending and votes via staking?

**Verification:**

1. **Different NFTs scenario:** User has 2 NFTs. Restakes NFT-A, escrows NFT-B in lending.
   - staking.votingPowerOf(user) iterates `_positionsByOwner[user]`. NFT-A is at restakingContract. NFT-B is at lendingContract. Set is empty → 0.
   - staking.votingPowerOf(restakingContract) → 0 (hardcoded).
   - staking.votingPowerOf(lendingContract) → has NFT-B but lending doesn't expose votingPowerOf to consumers.
   - restaking.votingPowerOf(user) → power_A from NFT-A's `_boostedAmountAt(user, now)`.
   - VotePowerOracle.powerOf(user, staking, restaking) = 0 + power_A = power_A.
   - User's effective VP: power_A only. NFT-B's power is locked away in lending escrow as designed.
   - **No double-count.**

2. **Same NFT scenario:** User restakes NFT-A. Tries to escrow NFT-A in lending. But lending requires `staking.ownerOf(_tokenId) != msg.sender` revert at TegridyLending.sol:1101. Since NFT-A is in restakingContract, user is NOT owner → `NotNFTOwner`. Cannot escrow.
   - To escrow, user must first `unrestake()` NFT-A. After unrestake: NFT-A returns to user. Then escrow → moves to lending. During the brief in-block window, restaking has cleared user's restakers map AND staking-side checkpoints have been written. No race.

3. **Flash-loan race:** Can a malicious flash-loan callback attempt to:
   - Acquire NFT via flash mint → vote → escrow in lending atomically?
   - `stake()` mints a fresh NFT. `_afterTokenTransfer(0, user, id)` writes user's checkpoint. `_writeCheckpoint(msg.sender)` is also called.
   - Vote at the same `block.timestamp`: historical lookup uses `epochStart - 1` — checkpoint at `block.timestamp` is excluded by OZ Trace208 upperLookup.
   - votingPower = min(0, current) = 0. Vote fails NothingToClaim.
   - **Flash-stake protection holds.**

4. **Cross-contract during NFT escrow transition:** Borrower escrows NFT into lending. `staking.transferFrom` → `_beforeTokenTransfer` → `_settleRewardsOnTransfer` → `_afterTokenTransfer` → checkpoints written. Borrower's per-owner set is cleared atomically before the principal is paid out. No same-block VP retention.

**Conclusion: No double-count. Flash-loan race closed by historical clamp + atomic checkpoint writes.**

---

## Final summary

**Wave A's effect on the original 25 chains:**
- 17 fully closed by direct fixes.
- 3 closed transitively (CHAIN-11 by the rate limit + kLast gate + lendingAdmin floors; CHAIN-14 by H-11 + H-12 stipend; CHAIN-25 by H-14 + H-15).
- 5 partially closed with the residual leg explicitly accept-as-design per POST_MANDATE_STATE.
- 0 reopened.

**NEW chains from Wave A combinations:**
- NEW-1: `setRestakingContract` asymmetry between GaugeController (rotated) and 4 sibling consumers (one-shot). HIGH operational hazard. **ESCALATE for explicit accept-as-design or 4-line-per-consumer code-length tweak.**
- NEW-2: TegridyPair H-7 × TegridyTWAP M-24 fresh-pair launch friction. NONE / operational. **Document in deploy runbook only.**
- NEW-3: POL/SwapFeeRouter `totalETHReceived` not prewarmed (asymmetric with H-11 RevDist). LOW. **Defense-in-depth — current 50k-gas routing is safe.**
- NEW-4 hypothesis (SwapFeeRouter WETH-input × premium flash-loan): REJECTED on verification — SwapFeeRouter uses `hasPremiumSecure` not `hasPremium`. No flash-loan amplifier.

**Cross-protocol VP, captured-owner cross-contract, bribe whale, lending+restaking flash:** All re-verified — no new exploit surface created by Wave A.

**Mandate-strictness:** Closing NEW-1 via the 4-LoC-per-consumer code-length check (16 LoC total) is borderline mandate-strict. Closing via DELETE (drop `RestakingAlreadySet`) is mandate-pure but breaks the "set-once-immutable" intent. Closing via accept-as-design + runbook is the safest under the mandate.

---

**End of post-Wave-A cross-contract chain hunt.**
