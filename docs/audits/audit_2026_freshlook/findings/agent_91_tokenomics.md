# Agent 91 — Tokenomics Audit (Fresh-Eyes)

Lens: TOWELI inflation, dilution, hidden mint paths, treasury siphons, emission schedule games.
Target: All TOWELI mint/burn paths, reward funding flows, treasury power, JBAC bonuses, MAX_REWARD_RATE.

---

## Executive Summary

Tegriddy Farms TOWELI is a **fixed-supply token (1B, 18 decimals) with a single bytecode-level mint path** in `Toweli.sol:107` (constructor). The `_update` override at `Toweli.sol:116` enforces this as an invariant of the bytecode, not just the source surface.

**No exploitable inflation path exists.** All reward payouts (TegridyStaking, TegridyLPFarming, TegridyRestaking) are funded externally via Synthetix-style `notifyRewardAmount(amount) -> safeTransferFrom(msg.sender, this)` patterns. The `MAX_REWARD_RATE = 100e18` ceilings are dispense rate caps; they do not authorise minting and are bounded by the funding contract's TOWELI balance.

POLAccumulator buys TOWELI from the Uniswap V2 market with ETH revenue; it does NOT mint. CommunityGrants disburses ETH (not TOWELI). RevenueDistributor distributes ETH to veTOWELI. GaugeController is a weight oracle — it does not move tokens.

The strongest finding is N-91-1: a **theoretical first-depositor exploit on the optional penalty-recycle pathway** when `penaltyRecycleBps > 0`, but this is gated by 48h timelocked governance and defaults to 0. All other findings are notes / dead-ends.

---

## F-91-1 — Single Mint Path Confirmed (NO FINDING)

**File:** `contracts/src/Toweli.sol:107` and `:116-122`

The only `_mint(...)` call to TOWELI on the entire codebase is the constructor:

```
contracts/src/Toweli.sol:107: _mint(recipient, TOTAL_SUPPLY);
```

The `_update(address from, address to, uint256 value)` override at `Toweli.sol:116-122` reverts with `MINT_DISABLED` on any subsequent `from == address(0)` flow:

```
if (from == address(0)) {
    require(!_initialMintDone, "MINT_DISABLED");
}
```

`_initialMintDone` is set in the constructor at line 108 immediately after the initial mint, before any external surface exists. There is no owner, no `Ownable`, no upgrade slot, no delegatecall, no assembly, no selfdestruct in `Toweli.sol`. The contract is non-upgradable and has no admin surface.

Other `_mint(...)` callsites in the codebase mint different assets:
- `TegridyPair.sol:157, 165, 481` — Uniswap V2 LP token (the pair contract's own ERC20)
- `TegridyStaking.sol:771, 822` — ERC721 staking position NFTs
- `TegridyRouter.sol:112, 132` — calls `pair.mint` on V2 pair (not TOWELI)

**Conclusion:** TOWELI total supply is structurally fixed at 1,000,000,000 ether (1e27 wei). No inflation path exists.

---

## F-91-2 — TegridyStaking reward funding is external (NO FINDING)

**File:** `contracts/src/TegridyStaking.sol:1854-1866` (`notifyRewardAmount`)

```
function notifyRewardAmount(uint256 _amount) external nonReentrant whenNotPaused updateReward {
    if (msg.sender != owner() && !rewardNotifiers[msg.sender]) revert NotRewardNotifier();
    if (_amount < MIN_NOTIFY_AMOUNT) revert FundAmountTooSmall();
    uint256 balBefore = rewardToken.balanceOf(address(this));
    rewardToken.safeTransferFrom(msg.sender, address(this), _amount);   // PULL
    uint256 received = rewardToken.balanceOf(address(this)) - balBefore;
    if (received < MIN_NOTIFY_AMOUNT) revert FundAmountTooSmall();
    totalRewardsFunded += received;
    emit RewardAdded(received);
}
```

Funding source: pulled from `msg.sender` via `safeTransferFrom`. Caller must have approved + own pre-existing TOWELI. No mint anywhere in this path. The `updateReward` modifier crystallises pre-fund accruals so a notifier cannot back-run their own deposit (DEEP-DR-07 / NEW-S5).

Notifier set is gated to owner + explicit allowlist (`setRewardNotifier`, line 1832).

`MAX_REWARD_RATE = 100e18` (TegridyStaking.sol:271) is a dispense-rate cap on `applyRewardRate(uint256 _rate)` (line 1952). It does NOT authorise minting; it is the tap rate at which the externally-funded `rewardPool` drains. If the pool is empty, `_accumulateRewards` (line 672-693) clamps `reward = available - reserved` to zero, so no IOU accrues against unfunded liabilities.

---

## F-91-3 — TegridyLPFarming reward funding is external (NO FINDING)

**File:** `contracts/src/TegridyLPFarming.sol:460-496` (`notifyRewardAmount`)

```
rewardToken.safeTransferFrom(msg.sender, address(this), amount);
```

Same Synthetix `RewardsDistributionRecipient` pattern. Owner-only entry. `MAX_REWARD_RATE = 100e18` (line 60) again is a dispense cap, not a mint authorisation. Period-end reset prevents rate stacking; `MIN_REWARDS_DURATION = 1 day` and `MAX_REWARDS_DURATION = 90 days` bound the period.

Constructor rejects `rewardToken == stakingToken` (line 158) — closes the MasterChef-class footgun where `balanceOf(this)` would conflate user deposits with the reward pool.

`recoverERC20` (line 557-562) blocks both `stakingToken` and `rewardToken`. `forfeitedRewards` (M11) can be reclaimed to treasury via `reclaimForfeitedRewards` (line 436-451), but it is capped at `balance - owedFutureRewards` so it cannot strand active stakers.

---

## F-91-4 — TegridyRestaking bonus pool funding is external (NO FINDING)

**File:** `contracts/src/TegridyRestaking.sol:1309-1314` (`fundBonus`)

```
function fundBonus(uint256 _amount) external nonReentrant updateBonus {
    if (_amount == 0) revert ZeroAmount();
    bonusRewardToken.safeTransferFrom(msg.sender, address(this), _amount);
    totalBonusFunded += _amount;
    emit BonusFunded(_amount);
}
```

`MAX_BONUS_REWARD_RATE = 100e18` (line 180) — same dispense-cap semantic as TegridyStaking. No mint path.

---

## F-91-5 — POLAccumulator buys TOWELI from market (NO FINDING)

**File:** `contracts/src/POLAccumulator.sol:431-471` (`accumulate`)

```
uint256[] memory amounts = router.swapExactETHForTokens{value: halfETH}(
    swapMinOut,
    path,                       // path = [WETH, TOWELI]
    address(this),
    _deadline
);
```

POL acquires TOWELI via `swapExactETHForTokens` on the V2 router using ETH revenue. It does NOT mint. The acquired TOWELI is paired with the remaining half-ETH in `addLiquidityETH`; LP tokens are held permanently by the contract.

`maxAccumulateAmount` defaults to 10 ETH, capped at `MAX_ACCUMULATE_CAP = 100 ether`. `ACCUMULATE_COOLDOWN = 1 hour`. Caller (owner-only) cannot burst accumulate. TWAP-anchored `swapMinOut` defends against sandwich (R015).

POL **reduces** circulating supply (TOWELI moved from market into permanent LP), the opposite of inflation.

---

## F-91-6 — CommunityGrants disburses ETH only — 30%/30d cap is firm (NO FINDING)

**File:** `contracts/src/CommunityGrants.sol`

- `MAX_GRANT_PERCENT_BPS = 5000` (line 132) — max 50% of contract balance per grant
- `MAX_ROLLING_DISBURSEMENT_BPS = 3000` (line 163) — max 30% of treasury per 30-day rolling window
- `ROLLING_WINDOW = 30 days` (line 162)

`absoluteCap` is locked at proposal-creation time (line 395) and `rollingCapBalanceAtFinalize` is snapshotted at finalize-approve (line 538). Both checked at `executeProposal` (line 583, 599-602) and `retryExecution` (line 651, 661-664). Cannot be bypassed by a balance change between approval and execution.

The contract distributes ETH only; the only TOWELI flow is the **inbound** `PROPOSAL_FEE = 42_069 ether` charged on submission, which is forwarded to `feeReceiver` (treasury).

Even if the owner were captured, the 30%/30d cap requires 4 rolling windows (~120 days) to fully drain the contract — and each grant requires community approval (>50% quorum, 4000e18 minimum boosted votes, ≥3 unique voters).

---

## F-91-7 — RevenueDistributor: 100% of ETH to veTOWELI (NO FINDING)

**File:** `contracts/src/RevenueDistributor.sol:359-415` (`_distribute`)

The `epoch.totalETH` is the entire `newETH` (balance minus reserved). Treasury has no per-epoch share; it only receives:

- `emergencyWithdraw` (line 421): only callable when `totalBoostedStake == 0` (no stakers exist)
- `executeEmergencyWithdrawExcess` (line 449): 48h timelocked, takes only `balance - unclaimed - pendingWithdrawals`
- `sweepDust` (line 875): rounding dust only, capped at `balance - unclaimed - pendingWithdrawals`

Treasury cannot siphon any active staker's ETH share.

---

## F-91-8 — Treasury revenue cap on SwapFeeRouter is enforced (NO FINDING)

**File:** `contracts/src/SwapFeeRouter.sol`

- `stakerShareBps = 10_000` default (line 282) — 100% to stakers
- `polShareBps = 0` default (line 286)
- `MIN_STAKER_SHARE_BPS = 5_000` (line 294) — staker share floor 50%
- `MAX_POL_SHARE_BPS = 2_500` (line 295) — POL share ceiling 25%
- Treasury share = `BPS - stakerShareBps - polShareBps`, **at most 25%** of ETH fee revenue (`10000 - 5000 - 2500`)

`applyFeeSplit` (line 1373) gated by `onlyAdmin` (timelocked sister contract). Captured owner cannot spike treasury share above 25%.

---

## F-91-9 — VoteIncentives bribe fee capped at 5% (NO FINDING)

**File:** `contracts/src/VoteIncentives.sol`

- `MAX_FEE_BPS = 500` (line 158)
- `bribeFeeBps` default 300 (line 222)
- Bribes are funded entirely by external bribers via `safeTransferFrom`. No mint, no protocol-owned TOWELI involved.
- Fee goes to treasury (line 672). Max 5% leakage to treasury.

---

## F-91-10 — JBAC +0.5x bonus is share redistribution, not inflation (NO FINDING)

**File:** `contracts/src/TegridyStaking.sol:98` (`JBAC_BONUS_BPS = 5000`)

JBAC bonus is a multiplier on `boostedAmount` — a JBAC holder's share of the **already-pre-funded** reward pool grows at the expense of non-JBAC holders' shares. Total emission = `elapsed * rewardRate`, fixed by funding cycle. JBAC NFTs must be physically deposited (ApeCoin-Staking pattern, AUDIT H-1) — not flash-loanable.

`MAX_BOOST_BPS_CEILING = 45000` (4.5x) on TegridyLPFarming.sol:69 caps the JBAC-amplified boost. Reward pool is pre-funded, so total payout cannot exceed the funded amount regardless of boost composition.

---

## F-91-11 — Cross-system flow: lock → vote → bribe → emission (closed-loop NEUTRAL)

Tracing the full DeFi loop:

1. User locks TOWELI in TegridyStaking → receives veTOWELI position NFT with `boostedAmount`.
2. Voting power flows to:
   - GaugeController (weight allocation — but NO emission distributor exists; see F-91-12)
   - VoteIncentives (claim bribes from external bribers — these come from outside the protocol)
   - RevenueDistributor (claim ETH — fees from external swap activity)
   - CommunityGrants (vote on ETH disbursements — bounded by 30%/30d cap)
3. Bribes earned in TOWELI/ETH are paid by external bribers via `safeTransferFrom`. No protocol mint.
4. Revenue earned in ETH is paid by external swap traders via SwapFeeRouter fee accrual. No TOWELI flows to user.

**Net inflation per cycle: ZERO (no mint).** All "yield" is redistribution of fees paid by traders/bribers/early-exiters into the reward pools.

---

## F-91-12 — GaugeController is a weight oracle, not an emission distributor (NO FINDING)

**File:** `contracts/src/GaugeController.sol`

`emissionBudget` (line 196) is a `uint256` parameter that downstream consumers read to compute their share. There is NO emission distribution function on this contract — no `distributeEmissions`, `claim`, `notify`, or `_mint`.

Search confirmation:
```
grep "emissionBudget" contracts/src/ → only GaugeController.sol matches
```

The deployment as-is means gauge votes have no on-chain TOWELI consequence; they are advisory only. **This is by design** per the read of the code: governance designed the gauge as a vote signal, with emissions to be distributed by a downstream contract that has not yet been deployed (or is deployed off-chain by a multisig keeper). Any future emission distributor would be funded externally (by treasury TOWELI transfer) since Toweli has no mint surface.

---

## F-91-13 — MAX_REWARD_RATE annualised burn is bounded by funding (CONTEXT NOTE)

**Calculation:**
- `MAX_REWARD_RATE = 100e18` TOWELI/sec (TegridyStaking.sol:271, TegridyLPFarming.sol:60, TegridyRestaking.sol:180)
- Per year: 100 × 31,536,000 = **3,153,600,000 TOWELI/year**
- Total supply: 1,000,000,000 TOWELI

If sustained at the cap on a single contract, the entire supply would deplete in ~115.7 days. **This is unattainable** — the rate is bounded by the contract's TOWELI balance. The `_accumulateRewards` clamp `if (reward > rewardPool) reward = rewardPool` (TegridyStaking.sol:681) ensures the on-chain dispense never exceeds funded balance.

**Practical sustainable rate** is the TREASURY'S allocation divided by the desired emission lifetime. If treasury allocates 30% (300M TOWELI) over 4 years: ~2.378 TOWELI/sec — well within the 100 TOWELI/sec cap. The cap is an upper bound for emergency rate-up scenarios, not a sustained inflation guarantee.

**Recommendation (opinion, not an exploit):** Treasury should publicly commit to a sustainable emission schedule. The bytecode does not enforce this — it only enforces the 100/sec ceiling. Off-chain reputation and multisig discipline are the real constraints.

---

## F-91-14 — Negative-yield lock / penalty recycle: theoretical first-depositor extraction (LOW)

**File:** `contracts/src/TegridyStaking.sol:1000-1002, 2207-2211`

```
function _creditRewardPool(uint256 amount) internal {
    if (amount == 0 || totalBoostedStake == 0) return;
    rewardPerTokenStored += (amount * ACC_PRECISION) / totalBoostedStake;
    totalRewardsFunded += amount;
}
```

When `penaltyRecycleBps > 0`, the early-withdrawal penalty (25% of position) is split: `toTreasury` to treasury, `recycled` to active stakers via `_creditRewardPool`. The `_clearPosition` is called BEFORE `_creditRewardPool`, so the early-withdrawer's `boostedAmount` has been removed from `totalBoostedStake` by the time the recycle credits.

**Theoretical exploit (LOW, pre-conditions):**

1. Honest user has a 1000 TOWELI position with high boost (4x = 4000e18 boosted), `lockEnd` in future.
2. Attacker stakes 1 wei of TOWELI with min boost just before honest user calls `earlyWithdraw` (predicting via mempool).
3. Honest user's position cleared first → totalBoostedStake = (attacker's tiny boostedAmount).
4. 25% of 1000 TOWELI = 250 TOWELI penalty. With penaltyRecycleBps = 100%, `_creditRewardPool(250)` distributes 250/totalBoostedStake to attacker.
5. Attacker captures effectively the entire 250 TOWELI penalty.

**Why this is LOW (not exploitable in practice):**

- `penaltyRecycleBps` defaults to 0 (line 314 — no recycling). A 48h-timelocked governance proposal is required to enable it.
- Even with recycling enabled, the attacker must front-run a specific large early-exit. If the early-exit user could see the front-run, they could simply re-stake first or wait for a different block.
- `MIN_LOCK_DURATION = 7 days`, so `earlyWithdraw` is only profitable in narrow windows.
- The honest user may have an autoMaxLock, in which case `_decayIfExpired` already zeroes their boosted amount — no penalty to capture.

**Mitigation note:** The `_splitPenalty` function (line 2190-2201) does include a guard: if `totalBoostedStake == 0` after the early-exit, recycled is set to 0 and the entire amount goes to treasury. This blocks the case where the attacker has NOT yet staked at the time of the early-exit. So the attacker's prerequisite is very strict: stake within the same block (or just before) the victim's earlyWithdraw, with a tiny amount that doesn't dilute their share when the recycle hits.

**Battle-tested precedent:** Synthetix `RewardsDistributionRecipient` pattern has the same theoretical sandwich vector on `notifyRewardAmount`; in practice it is mitigated by the funding caller being a trusted distributor (the same pattern Tegridy uses via the rewardNotifiers allowlist).

**Recommendation:** Document publicly that `penaltyRecycleBps` should remain at 0 unless there is a demonstrated UX need. If activated, monitor for staking-anomaly signals (sub-1e18 stakes appearing immediately before known early-exits).

---

## F-91-15 — Owner-as-attacker: emission siphon via rewardNotifier (NO FINDING)

**Threat:** Owner adds themselves as `rewardNotifier`, then runs `notifyRewardAmount` immediately before `getReward` to capture the just-deposited reward.

**File:** `contracts/src/TegridyStaking.sol:1854` (`notifyRewardAmount`)

The `updateReward` modifier (line 695-698) calls `_accumulateRewards` BEFORE the `safeTransferFrom`. Pre-fund accruals are crystallised against the OLD reward pool. The owner's own claim then settles against the new (post-fund) `rewardPerTokenStored` proportionally to their `boostedAmount` — same as every other staker. The owner gets only their fair share.

A pause-asymmetry attack (kick + notify mid-pause) was closed by `whenNotPaused` on `notifyRewardAmount` (line 1854) — DEEP-DS-05. The pause-aware accumulator (DS2-04, line 672-693) advances `lastUpdateTime` while NOT advancing `rewardPerTokenStored` during pause, so post-unpause emission cannot be captured retroactively.

---

## F-91-16 — Treasury revenue capture surface map (CONTEXT NOTE)

Treasury (multisig) eligible inflows from across the protocol:

| Source | Cap | Mechanism | Gating |
|---|---|---|---|
| SwapFeeRouter swap fee | ≤25% of fee revenue | `_distributeProtocolFees` (line 1316-1370) | `applyFeeSplit` 24h timelock + MIN_STAKER_SHARE_BPS floor |
| TegridyStaking penalty | ≤100% of 25% penalty | `earlyWithdraw` (line 1001) | `penaltyRecycleBps` 48h timelock cap |
| TegridyStaking extend fee | ≤2% of position | `_chargeExtendFee` (line 2130-2146) | `extendFeeBps` 48h timelock cap |
| TegridyLPFarming forfeited rewards | bounded | `reclaimForfeitedRewards` (line 436) | `balance - owedFutureRewards` cap |
| RevenueDistributor emergency | only when stakers all unlocked | `emergencyWithdraw` (line 421) | `totalBoostedStake == 0` |
| RevenueDistributor excess | bounded to "excess only" | `executeEmergencyWithdrawExcess` (line 449) | 48h timelock + balance gate |
| RevenueDistributor dust | rounding only | `sweepDust` (line 875) | balance - unclaimed - pendingWithdrawals |
| VoteIncentives bribe fee | ≤5% of bribe | `depositBribe` (line 672) | `MAX_FEE_BPS = 500` |
| CommunityGrants proposal fee | per-proposal `42_069 TOWELI` | `submitProposal` | per-proposer 1-day cooldown |
| POLAccumulator harvest LP | bounded by LP holdings | `executeHarvestLP` (line 655) | 48h timelock + TWAP deviation gate |
| MemeBountyBoard expired refund sweep | bounded | line 639, 814 | per-creditor expiry timer |
| SwapFeeRouter sweep | bounded | line 1427 | bal-vs-tracked accounting |
| PremiumAccess sweep | bounded | line 510 | unsold premium balance only |

**Aggregate ceiling:** Treasury captures at most ~25% of swap fee ETH plus the timelock-gated TOWELI flows. There is no path to drain the protocol-owned pools (RevenueDistributor unclaimed ETH, TegridyStaking reward pool, LP Farming reward pool) without triggering visible, publicly-watchable timelock proposals.

---

## Notes / Dead Ends

**N-91-A — Shared TWAP / spot-deviation bypass on POL** — Not in tokenomics scope (oracle layer). Already addressed by HARVEST_TWAP_DEVIATION_BPS = 50 (POLAccumulator.sol:136).

**N-91-B — Cross-pool reentrancy via TOWELI fee-on-transfer hook** — TOWELI is plain ERC20+permit, no transfer hook (Toweli.sol:48 — only OZ ERC20 + ERC20Permit, no extensions). No reentrancy surface from the token itself.

**N-91-C — Permit signature replay** — Out of tokenomics scope; covered by ERC20Permit nonces. The custom permit override at Toweli.sol:149 preserves OZ nonce semantics.

**N-91-D — Reward pool over-commit detection** — TegridyStaking _accumulateRewards clamps `reward = available - reserved` (line 681). Under-funded pools surface via `RewardPoolUnderfunded` events (per code comments at 1076), giving off-chain monitors a clean signal. Not exploitable, just an operational concern.

**N-91-E — Restaking voting power double-count** — TegridyRestaking.boostedAmountAt is added to TegridyStaking.votingPowerAtTimestamp in the restakingContract callsites (RevenueDistributor, VoteIncentives, GaugeController, CommunityGrants). The staking-side power for a restaked NFT is 0 (NFT held by restaking contract), so the addition does not double-count. Verified by reading restaker fallback comments at NEW-S1 (RevenueDistributor.sol:40-46).

**N-91-F — Token sweep on TegridyStaking** — `sweepToken` blocks `rewardToken` (line 1993) — TOWELI cannot be drained by accidental-airdrop-recovery path. The `_reserved()` accounting (totalStaked + totalUnsettledRewards) protects principal from being credited as reward.

---

## Summary

| Path | Status |
|---|---|
| Toweli single-mint constructor invariant | VERIFIED |
| TegridyStaking reward funding | EXTERNAL TRANSFER, NO MINT |
| TegridyLPFarming reward funding | EXTERNAL TRANSFER, NO MINT |
| TegridyRestaking bonus funding | EXTERNAL TRANSFER, NO MINT |
| POLAccumulator funding | MARKET BUY VIA SWAP, NO MINT |
| CommunityGrants disbursement | ETH ONLY, 30%/30d CAP FIRM |
| RevenueDistributor distribution | 100% TO veTOWELI, NO TREASURY SHARE |
| Treasury cap on swap fee | ≤25% (FLOOR-PROTECTED) |
| Bribe fee | ≤5% (CAPPED) |
| JBAC bonus | SHARE REDISTRIBUTION ONLY |
| GaugeController | WEIGHT ORACLE, NO TOKEN MOVES |
| MAX_REWARD_RATE inflation | BOUNDED BY POOL BALANCE |
| Penalty-recycle first-depositor | LOW, GATED BY 48h TIMELOCK |
| Owner emission siphon | CLOSED BY updateReward CRYSTALLISATION |

**No exploitable inflation or treasury-drain path identified.** The protocol's tokenomics surface is structurally constrained by Toweli's bytecode-level fixed supply and the Synthetix/Curve-style external-fund-only emission patterns.
