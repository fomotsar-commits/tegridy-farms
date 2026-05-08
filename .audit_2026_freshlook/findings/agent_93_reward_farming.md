# Agent 93/100 — Fresh-Eyes Reward Farming / Bot Extraction Audit

**Lens:** Reward farming and bot extraction across staking, restaking, LP farming, revenue distribution, and vote incentives.

**Targets:**
- `contracts/src/TegridyStaking.sol`
- `contracts/src/TegridyRestaking.sol`
- `contracts/src/TegridyLPFarming.sol`
- `contracts/src/RevenueDistributor.sol`
- `contracts/src/VoteIncentives.sol`

**Posture summary.** Most classic reward-farming vectors are aggressively defended by R014/DR/DS hardening (per-tokenId attribution, residual reservation, R017 stale-path settlement, kick-no-forfeit, autoMaxLock boost restoration, REV-M-01 historical denominator pin, NEW-G4 SNAPSHOT_LOOKBACK, BATCH-H M14 ClaimWindowNotOpen). The only material findings are (a) a window for restaking an already-expired un-kicked staking NFT into TegridyRestaking before its boost has been decayed (F-93-1), (b) the unbounded MEV window on `TegridyLPFarming.notifyRewardAmount` from owner-key signing in mempool (F-93-2), and (c) sybil-bribe self-dealing via wallet-rotation in VoteIncentives (F-93-3). Findings 4–8 are sub-medium / informational. Scenarios 1, 4, 5, 9, 10 are confirmed CLOSED by existing fixes.

---

## F-93-1 — Restake-of-expired-position siphons bonus rewards (HIGH)

**Files:**
- `contracts/src/TegridyRestaking.sol:596-659` (`restake()`)
- `contracts/src/TegridyStaking.sol:1305-1320` (`_beforeTokenTransfer` / `_settleRewardsOnTransfer`)
- `contracts/src/TegridyStaking.sol:482-489` (`_decayIfExpired`)

**Recipe.**
1. Stake N TOWELI at `MAX_LOCK_DURATION = 4 years`, with `JBAC_BONUS_BPS` for max effect. boostedAmount = N × 4.5 (max boost).
2. Let the lock expire naturally over 4 years. **Do not** call `withdraw`, `getReward`, `kick`, or transfer the NFT — none of these have been triggered, so `_decayIfExpired` has never run. `positions[tokenId].boostedAmount` is still the inflated `N × 4.5` value despite `block.timestamp >= lockEnd`.
3. Call `TegridyRestaking.restake(tokenId)`. Three things happen:
   - Line 628 reads `(uint256 amount, uint256 boostedAmount,,,,,,, , ,) = staking.positions(_tokenId)` — this is the **pre-decay** inflated boostedAmount.
   - Line 632 transfers the NFT. `_settleRewardsOnTransfer` runs (TegridyStaking.sol:1475-1538) — it accumulates rewards and updates `rewardDebt` against the inflated boost, but it **does not call `_decayIfExpired`**.
   - Line 651: `totalRestaked += boostedAmount` — TegridyRestaking now thinks the user has `N × 4.5` worth of denominator share.
4. Bonus emissions begin accruing to the attacker at the inflated denominator weight. With `MAX_BONUS_REWARD_RATE = 100e18` per second and the attacker's share of `totalRestaked`, this leaks bonus tokens until either the attacker themselves or a permissionless caller invokes `TegridyRestaking.decayExpiredRestaker(_restaker)`.
5. There is **no on-chain incentive** to call `decayExpiredRestaker` — it is not paid, not a keeper-incentivised hook, and griefs the caller with gas. In practice, no honest party calls it until another restaker notices the dilution.

**Capital / profit.**
- Capital required: gas only (the NFT was already locked and matured naturally — same capital outlay as any honest 4-year lock).
- Profit: bonus rewards proportional to `(N × 4.5) / totalRestaked` per second, until decay is triggered. If `bonusRewardPerSecond = 1e18` and totalRestaked = 1000 TOWELI, attacker with N = 100 TOWELI captures `(450/1450) × 1e18 = 0.31e18` TOWELI/sec on already-expired stake. Over even a 6-hour undisturbed window: ~6,700 TOWELI of bonus.
- Repeatable: each time the attacker is decayed-out, they unrestake, withdraw, re-stake fresh (paying time-cost again). But the FIRST window is free.

**Why current defences miss it.**
- `decayExpiredRestaker` exists (line 1942) but it's permissionless and unincentivised — there's no `kick`-with-reward or auto-decay on restake.
- `_settleRewardsOnTransfer` runs `_accumulateRewards` and credits the user's `unsettledRewards`, but does NOT decay the boost — the comment at line 1429 explicitly says "Compute rewards BEFORE decay zeroes boostedAmount" (in `_getReward`), but `_settleRewardsOnTransfer` skips the decay step entirely (it only sets `p.rewardDebt = accumulated`).
- `restake()` validates `amount != 0` but not `lockEnd > block.timestamp`.

**Mitigation.** Either (a) add `if (lockEnd <= block.timestamp) revert LockExpired()` to `restake()` so expired positions can't enter the bonus pool, or (b) call `staking.kick(tokenId)` from inside `restake()` BEFORE reading `boostedAmount` to force decay if the lock has already expired. Option (a) is simpler and matches the documented "use it or lose it" model.

---

## F-93-2 — `TegridyLPFarming.notifyRewardAmount` mempool-MEV sandwich (MEDIUM)

**File:** `contracts/src/TegridyLPFarming.sol:460-496`

**Recipe.**
1. Owner signs `notifyRewardAmount(amount, duration)` and broadcasts to public mempool (treasury multisig signing → mempool transit).
2. Attacker bot watches mempool for the `notifyRewardAmount` selector at the LP farming address. Detects the impending rate bump.
3. Attacker front-runs with a large `stake(amount)` immediately before `notifyRewardAmount` lands. Their `effectiveBalanceOf` is added to `totalEffectiveSupply` BEFORE `_accumulateRewards` runs the new rate.
4. `notifyRewardAmount` lands, sets `rewardRate = (leftover + actualReward) / duration`, `periodFinish = block.timestamp + duration` (1–90 days).
5. Attacker accrues at the new boosted rate proportional to their `effectiveBalanceOf / totalEffectiveSupply` for the entire `duration`.
6. After ≥ duration elapses (or earlier — there's no exit lock on the LP farming side beyond the `nonReentrant` guard), attacker calls `exit()` — withdraws LP and claims the rewards in one tx.

**Capital / profit.**
- Capital: any amount of TOWELI/WETH LP. No minimum on `stake` (except `amount > 0`).
- Profit window: the FULL `duration` of the new period, since `rewardsDuration` is enforced equal between calls (the M-3 fix). At MIN_REWARDS_DURATION = 1 day with a 100k TOWELI fund: attacker with 50% of total supply captures ~50k TOWELI - dilution from honest stakers. At MAX_REWARDS_DURATION = 90 days, larger.
- Cost: LP capital is locked for the duration but earns at the inflated rate (so opportunity cost is recouped if attacker's share × emission > alternative yield).

**Why classic Synthetix `notifyRewardAmount` is sandwich-vulnerable.** The Synthetix StakingRewards pattern explicitly accepts this: rewards funded mid-period dilute existing stakers proportionally, and a fresh staker captures their share of the rest of the period. The standard mitigation is either (a) putting `notifyRewardAmount` behind a 24h+ timelock (so the rate is publicly known well before the funds arrive) or (b) having a private mempool relay (Flashbots Protect / MEV-blocker) for the owner's notify tx.

**Why TegridyStaking's sister `notifyRewardAmount` is NOT vulnerable to the same sandwich.** TegridyStaking decouples `rewardRate` (set via 48h-timelocked `applyRewardRate` on the admin contract — see `TegridyStakingAdmin.sol:129-141`) from the funding amount. So the rate change is publicly visible 48h ahead, and `notifyRewardAmount` only refills the balance pool — the per-second emission is unchanged at notify time. **TegridyLPFarming is the lone bypass** of this defence pattern.

**Mitigation.** Add a propose/execute timelock around rate changes on the LP farming side too (so the rate-change event window is publicly visible 24h+ ahead), OR require the owner to use a private mempool relay for every `notifyRewardAmount` tx. The current 24h `REWARDS_DURATION_TIMELOCK` only gates the duration, NOT the rate.

---

## F-93-3 — Self-dealing bribe arbitrage via sybil wallet rotation (MEDIUM)

**File:** `contracts/src/VoteIncentives.sol:646-711` (depositBribe), 768-887 (claimBribes), 327 (depositedOnPair)

**Recipe.**
1. Attacker controls Wallets A and B. Attacker LPs pair P (attacker is a meaningful liquidity provider on pool P).
2. Wallet A calls `depositBribeETH(P)` with 1 ETH. Per line 708, `depositedOnPair[A][epoch][P] = true`. Wallet A is now locked out of claiming on (epoch, P).
3. Wallet B holds ≥ `MIN_BRIBE_CLAIM_QUORUM = 100e18` voting power (e.g., 100 TOWELI staked at MIN_LOCK = 7d, boosted to ≥ 100e18 effective). Importantly: **Wallet B is a fresh wallet not linked on-chain to Wallet A**. `depositedOnPair[B][epoch][P] == false`.
4. Wait for `advanceEpoch` to finalize the epoch with the bribe (anyone can call after MIN_EPOCH_INTERVAL = 7 days).
5. During the commit-reveal voting window (which is 4d/3d), Wallet B commits + reveals 100 VP onto pair P.
6. After `revealDeadline`, Wallet B calls `claimBribes(epoch, P)`. If Wallet B is the ONLY voter (or a dominant voter) on pair P with the quorum met:
   - `userVoteForPair = 100`
   - `totalVotesForPair = 100 + (other voters)`
   - `share = (1 ETH × 100) / totalVotesForPair`. If no other voters arrive, attacker recovers ~97% of the bribe (3% fee already taken at deposit). If other voters arrive proportionally, attacker still recovers their proportional share.
7. Attacker's NET: pays 3% bribe fee on 1 ETH = 0.03 ETH. Recovers their ETH (proportional to vote share). Plus they've directed voters' attention to pair P, increasing trading volume → attacker's LP fees on the pair grow. Plus the pair gets weighted higher in any gauge / emissions distribution downstream of VoteIncentives.

**Capital / profit.**
- Direct loss to attacker: 3% bribe fee = 0.03 ETH.
- Indirect gains: increased LP fee revenue on attacker's pool position; gauge-emission slice if pair P is also weighted by emission decisions.
- ROI breakeven: as soon as attacker's LP-fee bump outpaces 3% of the bribe.
- Not direct theft — it's economic gaming. The protocol's bribe-fee revenue is the only honest take.

**Why current defences miss it.**
- `depositedOnPair[user][epoch][pair]` is per-`msg.sender`, so wallet-rotation bypasses (`SelfBribeClaimForbidden` only fires when the SAME address bribed and votes/claims).
- `MIN_BRIBE_CLAIM_QUORUM = 100e18` only requires aggregate voter VP to reach the floor — easily met by a single staked wallet. Doesn't differentiate "many independent voters" from "one sybil with 100 VP".
- Commit-reveal hides the vote choice, but post-reveal everything is on-chain — attacker just needs a wallet not flagged as the bribe depositor.

**Mitigation.**
- Hard mitigation requires off-chain sybil resistance (POAP gating, BrightID, etc.) — out of scope for a smart-contract layer.
- Soft mitigations: (a) raise `MIN_BRIBE_CLAIM_QUORUM` significantly (e.g., 5,000 VP) so a sybil-bribe needs serious capital commitment to clear the threshold; (b) require N distinct voter wallets for a bribe pool to be claimable; (c) add a per-(epoch, pair) "dominance cap" — no single wallet can claim more than X% of the bribe pool.

---

## F-93-4 — Inactive LP staker dilutes honest stakers via stale boost cache (LOW)

**File:** `contracts/src/TegridyLPFarming.sol:189-242` (`updateReward` modifier), 287-294 (`_getEffectiveBalance`), 297-307 (`refreshBoost`)

**Description.** When a user stakes LP and earns boosted yield via their TegridyStaking NFT's boost, their `effectiveBalanceOf` is cached. The PASS7-LPFARM-M1 fix re-derives boost inside `updateReward(account)` — but that only fires for the account itself. If a user stakes LP, sets a max-boost staking NFT, then DOES NOT TRANSACT and lets the staking-side lock decay or the NFT transfer out, their `effectiveBalanceOf` stays inflated until they themselves call any user-action OR until any third party calls `refreshBoost(account)`.

**Recipe.**
1. Stake 1000 LP in TegridyLPFarming.
2. Stake max-lock TOWELI position in TegridyStaking, achieving `aggregateActiveBoostBps = 45000` (4.5x cap).
3. Trigger LP-farming `stake` or `refreshBoost` so `effectiveBalanceOf = 1000 × 4.5 = 4500`. `totalEffectiveSupply += 4500`.
4. Transfer the staking NFT to a different wallet (after 24h TRANSFER_COOLDOWN). The user's `aggregateActiveBoostBps` drops to 0 (no positions). Their `effectiveBalanceOf` STAYS at 4500.
5. Never call any LP-farming action again (no claim, no refresh, no withdraw).
6. `totalEffectiveSupply` is permanently inflated by 4500 - 1000 = 3500 LP-equivalent. Honest stakers' share per second is diluted.
7. The inflated `effectiveBalanceOf[attacker]` is paired with `userRewardPerTokenPaid[attacker]` at the time the attacker last transacted. So when the attacker's subsequent `getReward` triggers `updateReward`, the modifier re-derives effective balance to the new (smaller) value, computes `earned()` on the OLD inflated value (per the documented sequence at lines 228-238), and shrinks `totalEffectiveSupply`.

**Profit / impact.**
- Attacker does not gain — when they finally transact, their accrued rewards use the OLD inflated balance (a small under-credit, per the documented R017 trade-off). They earn LESS than they would have.
- But the protocol leaks: while `totalEffectiveSupply` was inflated, every honest staker's share per second was diluted. The diluted reward ends up sitting in the LP-farming reward balance, eventually re-distributable via `notifyRewardAmount` as carry-over.
- This is more "slow grief / dilution" than direct theft. Capital cost = staked LP + staked TOWELI for time T.

**Mitigation note.** `refreshBoost` is permissionless, so a third-party keeper or another staker can sweep at any time. There's no on-chain incentive though — would benefit from a small kick-bounty (matching `kick()` on staking, but staking's `kick` also currently has no bounty).

---

## F-93-5 — `claimAll`/`unrestake` post-claim boost-restoration sequencing (LOW, defense-validated)

**File:** `contracts/src/TegridyRestaking.sol:872-917` (claimAll), 1024-1080 (unrestake)

**What was checked.** When `staking.getReward(tokenId)` runs inside `claimAll` and the position's `autoMaxLock` is set on a previously-decayed lock, the staking-side branch re-applies MAX_BOOST (TegridyStaking.sol:1031-1040). The restaking contract reads `staking.positions(tokenId)` AFTER `getReward` to detect this restoration (line 882-917) and updates `info.boostedAmount`, `_writeBoostCheckpoint`, `totalRestaked`, and `info.bonusDebt`.

**Verdict.** The post-claim re-read correctly handles the autoMaxLock boost restoration. The DR2-04 fix is in place (the `bonusDebt` is re-anchored at the current accBonusPerShare on the new boost so the restaker doesn't immediately accrue against emission they haven't earned). I traced the math:
- Pre-claim: `info.boostedAmount = 0` (decayed), `totalRestaked` reduced.
- `staking.getReward(tokenId)` triggers autoMaxLock branch → staking-side `boostedAmount` = MAX, `lockEnd = T + MAX_LOCK_DURATION`.
- Post-claim re-read: `postClaimBoosted = MAX`. `info.boostedAmount` updated to MAX. `totalRestaked += (MAX - 0) = MAX`. `bonusDebt = (MAX × accBonusPerShare) / 1e18`.
- Going forward, restaker correctly earns at MAX boost.

**No exploit found here.** Documenting that I checked, since the DR2-04 fix history mentions the autoMaxLock-induced restoration as the prior gap.

---

## F-93-6 — Boost-extension at lock-end pays 0 fee by default (LOW, design-by-default)

**File:** `contracts/src/TegridyStaking.sol:884-916` (`extendLock`), 2130-2146 (`_chargeExtendFee`)

**Description.** A user with an existing lock at MIN_BOOST (0.4x) can call `extendLock(tokenId, MAX_LOCK_DURATION)` 1 second BEFORE expiry to ratchet their boost from 0.4x to 4.0x. The new boost takes effect immediately for forward emission — the user did NOT pay 4.0x lock-time-cost on past emissions, but they didn't earn at 4.0x for those past emissions either. So this is the documented Curve veCRV pattern — extending lock pays for future yield at the new boost.

**Why it's listed.** The default `extendFeeBps = 0` means there's NO friction at all for ratcheting. The owner can set `extendFeeBps > 0` via 48h timelock (`TegridyStakingAdmin.proposeExtendFee` → `executeExtendFee`), capped at 200 BPS (2%). Until set, repeated extend-lock calls are economically free.

**Verdict.** Behavior matches Curve-style intent. Not an exploit — the ratchet only buys forward yield. But operators should set `extendFeeBps` to a non-zero value (mirroring Curve's `BOOST_WARMUP` friction) so repeated extends-to-max are not free arbitrage.

---

## F-93-7 — Sandwich the harvest swap (NOT APPLICABLE)

**Description.** None of the five target contracts contain a `swap`/`harvest` path that converts harvested rewards into a different token. Reward streams are paid in their native token (TOWELI for staking/restaking-base/LP-farming, ETH for RevenueDistributor, ERC20/ETH for VoteIncentives bribes). Cross-reference: this attack class lives on `SwapFeeRouter.sol` and `POLAccumulator.sol`, which are out of scope for this audit lens.

---

## F-93-8 — Reward index donation / direct transfer (CROSS-REFERENCE)

**Description.** Already covered by Agent 64 (`agent_64_donations.md`). The `_accumulateRewards` modifier in TegridyStaking, `notifyRewardAmount` in TegridyLPFarming, and the `accBonusPerShare` accrual in TegridyRestaking all use **internal counters** (`rewardRate × elapsed`, `actualReward = balance_after - balance_before`, `bonusRewardPerSecond × elapsed`) and reserve the staked principal via `_reserved()` on staking. Direct ERC20 transfers to the contract:
- TegridyStaking: `_reserved() = totalStaked + totalUnsettledRewards`. `_accumulateRewards` line 679-683 caps reward to `available - reserved`. Direct donation INCREASES `available - reserved`, which `_accumulateRewards` then distributes via `rewardPerTokenStored`. So direct ERC20 donation IS captured into the reward accumulator — this is **intended** at the staking layer (anyone can fund the pool with extra tokens).
- TegridyLPFarming: `notifyRewardAmount` uses balance-delta on the function call, but `rewardRate` is set explicitly. Direct LP-farming reward token transfers to the contract bump the `balance` but don't bump `rewardRate` — so the dust sits idle until the next `notifyRewardAmount` (where `balance / duration` capping at line 489 might catch it, leading to a higher `rewardRate` cap allowance). Not a direct exploit.
- TegridyRestaking: accBonusPerShare uses `bonusRewardPerSecond × elapsed`, capped at `bonusRewardToken.balanceOf(address(this))`. Direct donations of bonus token raise the cap, allowing more emission per second to be distributed. So direct bonus-token donation IS captured and distributed proportionally to current restakers — **intended**.

**No new finding here.** Cross-referenced as requested.

---

## F-93-9 — Synthetix-style empty-period rewards re-distribution (CONFIRMED CLOSED)

**File:** `contracts/src/TegridyLPFarming.sol:189-242`

**What was checked.** The DR2-03 fix is in place at line 195-198:

```
if (totalEffectiveSupply == 0 && lastUpdateTime < lastTimeRewardApplicable()) {
    uint256 forfeit = (lastTimeRewardApplicable() - lastUpdateTime) * rewardRate;
    if (forfeit > 0) emit RewardsForfeitedDuringEmptyPeriod(forfeit);
}
rewardPerTokenStored = rewardPerToken();
lastUpdateTime = lastTimeRewardApplicable();
```

`lastUpdateTime` advances unconditionally to the current applicable time, so the empty-period emission is forfeited (matches Synthetix StakingRewards reference behavior). The first staker after an empty period does NOT capture the empty-period emission as a windfall — they start accruing from `lastUpdateTime = block.timestamp`.

The TegridyRestaking sibling has the same defense at line 354-358 (DR-09 v2 / DEEP-DR-15): if `totalRestaked == 0`, advance `lastBonusRewardTime = block.timestamp` so empty-period bonus is forfeited.

The TegridyStaking sibling at line 672-693 (`_accumulateRewards`) is rate-driven (no Synthetix-style finite period), so the analogue does not apply. DS2-04 ensures pause-window emission is forfeited.

**Verdict:** **CLOSED.** No exploitable empty-period redistribution.

---

## F-93-10 — Boost-extension at lock end (CONFIRMED CLOSED for revival)

**File:** `contracts/src/TegridyStaking.sol:884-916` (extendLock), 841-876 (toggleAutoMaxLock), 1226-1274 (revalidateBoost)

**What was checked.** The DEEP-DS-06 / DS3-02 / DS2-07 fix family rejects the "revive an expired position by paying extend fee" pattern across THREE entrypoints:

- `extendLock` (line 894): `if (p.lockEnd > 0 && block.timestamp >= p.lockEnd) revert LockExpired();`
- `toggleAutoMaxLock` enable branch (line 852): `if (!wasOn && p.lockEnd > 0 && block.timestamp >= p.lockEnd) revert LockExpired();`
- `revalidateBoost` (line 1233): `if (p.lockEnd > 0 && block.timestamp >= p.lockEnd) revert LockExpired();`

So an expired position cannot be reanimated to MAX boost — the user MUST `withdraw` and re-stake fresh. The "boost shoots back up at lock end" attack is fully closed for the `extendLock` family.

The `getReward` autoMaxLock branch (line 1031-1040) DOES re-apply MAX boost on a freshly-decayed position — but only when `autoMaxLock == true` (already opted in) AND the user paid the `extendFeeBps` fee at toggle time. So this is the documented "set and forget" pattern, not a revival exploit.

**Verdict:** **CLOSED for revival.** The autoMaxLock holder gets free perpetual extends but they paid the toggle fee once. Already noted in F-93-6.

---

## F-93-1-EXTRA — Multi-position split to game per-position cap (NOT GAMEABLE)

**File:** `contracts/src/TegridyStaking.sol:218` (MAX_POSITIONS_PER_HOLDER), 528-547 (`votingPowerOf`), 598-615 (`aggregateActiveBoostBps`)

**What was checked.** A whale could split N TOWELI across 50 positions of `N/50` TOWELI each (capped by MIN_STAKE = 100e18 and MAX_POSITIONS_PER_HOLDER = 50). Both `votingPowerOf` and `aggregateActiveBoostBps` iterate the full position set and sum amount-weighted boost contributions — so the total boost is the SAME whether a user holds 1 position of N or K positions of N/K.

There's no per-position cap on amount. The only practical relevance of position-splitting is gas: more positions = more iteration work in `votingPowerOf` and `aggregateActiveBoostBps` reads (paid by every consumer — RevenueDistributor, VoteIncentives, MemeBountyBoard, CommunityGrants, ReferralSplitter). The MAX_POSITIONS_PER_HOLDER = 50 cap (AUDIT C-2) bounds this gas tax.

**Verdict:** **NOT GAMEABLE.** Position splitting doesn't unlock extra boost or extra rewards. The 50-position cap bounds gas-grief on consumers.

---

## F-93-1-EXTRA-2 — Stake right before reward notification, claim, unstake (NOT REPLICABLE on staking)

**File:** `contracts/src/TegridyStaking.sol:1854-1866` (`notifyRewardAmount`), `contracts/src/TegridyStakingAdmin.sol:129-141` (`proposeRewardRate`/`executeRewardRate`)

**What was checked.** TegridyStaking decouples rate-changes from funding. `notifyRewardAmount` only refills the balance pool — it does NOT change `rewardRate`. `rewardRate` changes are gated by a 48h timelock on `TegridyStakingAdmin.applyRewardRate`. So:

- 48 hours before rate change: anyone watching the chain sees the proposal. Honest stakers extend their locks / increase boost in advance — same opportunity as the attacker.
- An attacker who stakes at MIN_LOCK = 7 days at MIN_BOOST = 0.4x captures only 0.4x of their pro-rata share. They pay 7 days of capital opportunity cost.
- The `_accumulateRewards` modifier ensures rewards accrued at the OLD rate are crystallized BEFORE the rate is bumped (TegridyStakingAdmin's `applyRewardRate` calls `updateReward` first).
- `MIN_NOTIFY_AMOUNT = 1000e18` and `NEW-S5` notifier-allowlist gate `notifyRewardAmount` to owner + explicit allowlist, so a captured-EOA can't spam-notify to break the accounting boundary.

**Verdict:** **NOT REPLICABLE on TegridyStaking.** The 48h timelock + balance/rate decoupling + 7d MIN_LOCK_DURATION combined make stake-before-notify uneconomical. (LP-farming has a different pattern — see F-93-2.)

---

## F-93-1-EXTRA-3 — Stake tiny, boost cache reset, unstake (CONFIRMED CLOSED on LP farming)

**File:** `contracts/src/TegridyLPFarming.sol:189-242` (updateReward + boost re-derive)

**What was checked.** PASS7-LPFARM-M1 fix ensures `updateReward(account)` re-derives `_getEffectiveBalance(account, raw)` and rebalances `totalEffectiveSupply` BEFORE computing earned. So a tiny `stake(1)` call that triggers `updateReward(msg.sender)` re-anchors the user's effective balance and credits the previous-period rewards at the OLD effective balance.

The user-side path:
1. User stakes 1000 LP at 4.5x boost → effectiveBalanceOf = 4500.
2. User's TegridyStaking lock decays naturally (no transaction). Their `aggregateActiveBoostBps` drops from 45000 to (e.g.) 4000.
3. User calls `stake(1)` (or any user action). `updateReward` runs: `oldEff = 4500, newEff = 1001 × 0.4 = 400.4`. `totalEffectiveSupply` shrinks by 4099.6.
4. THEN `rewards[account] = earned(account)` — but `earned` uses the NEW (post-correction) `effectiveBalanceOf[account] = 400.4`. So the elapsed-period rewards from the LAST claim to NOW are credited at the LOWER 400.4 weight — an under-credit on the user.
5. This is the documented R017-style trade-off: under-credit honest user a tiny bit to avoid the much larger stale-cache over-credit attack.

**Verdict:** **CLOSED.** Tiny-stake-to-reset doesn't yield retro boost gain. The re-derive happens BEFORE the credit, and the credit uses the post-corrected (smaller) value.

---

## F-93-1-EXTRA-4 — Restaking auto-compound timing manipulation (CONFIRMED CLOSED)

**File:** `contracts/src/TegridyRestaking.sol:773-949` (claimAll), 1942-2042 (decayExpiredRestaker), 1305-1314 (fundBonus)

**What was checked.** Restaking accrues bonus rewards via `accBonusPerShare` (Curve MasterChef pattern). `bonusRewardPerSecond` is changed via 48h timelock + 24h cooldown (`proposeBonusRate` → `executeBonusRateChange`). `fundBonus` deposits bonus tokens and runs `updateBonus` first to crystallize accrued amounts before the new tokens land in the pool — the rate is unchanged at fund time, so the elapsed-period emission is divided by the OLD pool, then the new pool absorbs future emissions.

R017 ensures the `claimAll` / `unrestake` / `refreshPosition` / `decayExpiredRestaker` stale-paths settle the OLD boost at PRE-accrue accBonusPerShare, then shrink `totalRestaked`, then accrue against the corrected denominator. So an attacker can't time their claim around a `fundBonus` to siphon the elapsed-period emission against an inflated denominator.

DR2-04 + the post-claim re-read in `claimAll` close the autoMaxLock-induced boost-restoration window (already analyzed in F-93-5).

**Verdict:** **CLOSED.** Auto-compound timing manipulation is not exploitable — the R017 stale-path settlement orders denominator-shrink before fresh accrual.

---

## Summary Table

| # | Scenario | Status | Severity |
|---|---|---|---|
| 1 | Stake right before reward notification | CLOSED on staking; OPEN on LP-farming (F-93-2) | MEDIUM |
| 2 | Stake tiny → boost cache reset → unstake | CLOSED (F-93-1-EXTRA-3) | — |
| 3 | Restake auto-compound timing manipulation | CLOSED (F-93-1-EXTRA-4) | — |
| 4 | JBAC NFT bonus farming (flash JBAC) | CLOSED (deposit-based H-1 fix) | — |
| 5 | Multi-position split to game per-position cap | NOT GAMEABLE (F-93-1-EXTRA) | — |
| 6 | Voting to gauge you LP in — optimal | OPEN — sybil bypass (F-93-3) | MEDIUM |
| 7 | Sandwich the harvest swap | NOT APPLICABLE (F-93-7) | — |
| 8 | Reward index donation | Cross-ref Agent 64 (F-93-8) | — |
| 9 | Synthetix-style empty-period redistribution | CLOSED (F-93-9) | — |
| 10 | Boost-extension at lock end | CLOSED for revival (F-93-10); fee-default note (F-93-6) | LOW |
| - | Restake of expired un-kicked position | OPEN (F-93-1) | HIGH |
| - | Inactive LP staker stale boost dilution | OPEN (F-93-4) | LOW |
| - | autoMaxLock free-extend (no fee on getReward branch) | DESIGN INTENT (F-93-6) | INFO |

## Notes / dead-ends

- I attempted to chain F-93-1 (restake-of-expired) with `claimUnsettledForTokenId` to drain the per-tokenId attribution. But `_settleRewardsOnTransfer` does credit `unsettledRewards[restakingContract]` and `unsettledRewardsByTokenId[tokenId]` correctly when the position is transferred-in-while-rewards-pending. The C-1 fix family ensures the per-tokenId slice is the attacker's own pre-restake reward, not other restakers'. So no cross-restaker theft chains off F-93-1.
- I checked the `lastReconciledEpoch` / `pendingRecoveryCount` interaction in RevenueDistributor for race conditions where a recovery + autoReconcileDust might double-count — DEEP-DR-M-03 closes this. No finding.
- I checked whether `distributePermissionless` could be paired with `kick` to grief an unsettled-fee victim by zeroing `totalBoostedStake` mid-distribute — `MIN_DISTRIBUTE_STAKE = 1000e18` prevents distribute when total stake is below the threshold; PASS5-REV-H1 mirrors this guard on `distribute()` too. No finding.
- I checked the `BATCH-N2 M12` per-depositor refundOrphanedBribe clock vs. shared-key dust-extend — the fix is in place. No finding.
- I checked the `committedPower[user][epoch]` cap via MICROSCOPE C2 — voter cannot commit more total power than `min(historicalPower, currentPower)` at commit time. Multi-commit options-arbitrage is closed. No finding.
- I considered whether `TegridyLPFarming.exit()` could be MEV'd against `notifyRewardAmount` — the answer is yes (this is F-93-2's recipe), but the same recipe also covers the `withdraw` + `getReward` sequence. No separate finding.

---

**Path:** `.audit_2026_freshlook/findings/agent_93_reward_farming.md`
