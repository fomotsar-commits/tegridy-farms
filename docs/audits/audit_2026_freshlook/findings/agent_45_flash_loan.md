# Agent 45/100 — Flash-Loan Amplification — Tegriddy Farms

Lens: atomic-tx amplification of governance / oracle / boost / liquidation /
share / bribe / LP-claim / Premium-NFT / DEX-K / pair-sync surfaces using
external (Aave / Balancer) or pair-internal flash loans.

Working dir: `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms`
Source scope: `contracts/src/**/*.sol` (28,282 LOC)

Audit history files NOT consulted, per fresh-eyes brief.

---

## Summary

The codebase has been hardened against the classic flash-loan amplification
patterns. Every governance read of voting power uses
`min(historical@T-1, currentLive)` so a flash-stake post-snapshot never exceeds
the historical anchor. Oracle reads route through `TegridyTWAP.consult` over a
30-minute window with deviation gates, bypass flags, sequencer checks, and
factory-pair authentication — single-block sandwich bend cannot move the
average enough to flip a decision. The pair contract refuses non-empty `data`
on `swap()` (line 217: `NO_FLASH_SWAPS`), eliminating Uniswap-V2-style flash
swaps. Lending/restaking are not LTV-driven so a flash price push cannot
trigger a liquidation cascade. PremiumAccess on-chain consumers correctly
route through `hasPremiumSecure` (subscription-only, multi-block). LP minting
requires both legs > 0 and ≥ 1000× MINIMUM_LIQUIDITY for the first deposit,
killing donate-inflation. `harvest()` bootstrap path is gated to the
feeToSetter so a flash-donate-then-sync cannot anchor `kLast` at an inflated
baseline.

I found **zero exploitable flash-loan amplification chains** under this lens.
What follows is the enumerated dead-end map plus three notes (N-45-1..3) — all
informational, all well-reasoned trade-offs. No findings rise to L/M/H/C.

---

## Exploit-Recipe Dead-Ends (negative findings)

### F-45-D1 — `voteForSubmission` / `castVote` / `vote` / `commitVote` / `revealVote` flash-stake amplification
**File:** `contracts/src/MemeBountyBoard.sol:483-487`,
`contracts/src/CommunityGrants.sol:458-462`,
`contracts/src/GaugeController.sol:351-358, 624-631`,
`contracts/src/VoteIncentives.sol:622-626, 1522-1526`
**Pattern checked:** flash-loan TOWELI within voter's tx → `stakeWithBoost` →
vote/commit → unstake (impossible since lock) → return loan.
**Why blocked:** every site reads BOTH `VotePowerOracle.powerAt(user, T-1)`
(historical, OZ Trace208 `upperLookup` at `epochStart - 1`) AND
`VotePowerOracle.powerOf(user, ...)` (live), then takes
`min(historical, current)`. A flash-stake at block T writes a Trace208
checkpoint at exactly `block.timestamp`; `upperLookup(T-1)` excludes it. The
clamp returns the historical value. Flash-stake adds zero new vote weight.
**Stake side check:** `TegridyStaking.votingPowerAtTimestamp` at line
555-557 calls `_checkpoints[user].upperLookup(SafeCast.toUint48(ts))`,
**Restake side check:** `TegridyRestaking._boostedAmountAt` at line 504-507
returns 0 if `info.depositTime > _timestamp`, so a same-block restake also
yields 0 at T-1.

### F-45-D2 — `_positionETHValue` collateral floor flash-bend (TegridyLending acceptOffer)
**File:** `contracts/src/TegridyLending.sol:1585-1628`
**Pattern checked:** lender flash-loans token0 → swaps to push reserves down →
borrower's `acceptOffer` reads spot collateral value below `minPositionETHValue`
→ revert (or vice versa: pump up to enable an undercollateralized loan).
**Why blocked:** `_positionETHValue` calls `twap.consult(pair, toweli,
amount, TWAP_PERIOD)` with `TWAP_PERIOD = 30 min` (line 1627). A 30-min TWAP
cannot be moved enough by a single-block sandwich to flip the
`minPositionETHValue` gate without locking ~30× the bend cost in held
reserves across multiple update-intervals. Plus: defense-in-depth staleness
gate, sequencer-uptime gate, dormancy-bypass cooldown
(`TWAP_PERIOD * 2 = 1h`), and the TWAP itself rejects observations beyond ±50%
deviation from prior `lastSpot`.

### F-45-D3 — `claimDefaultedCollateral` flash-liquidation
**File:** `contracts/src/TegridyLending.sol:1202-1247`,
`contracts/src/TegridyNFTLending.sol` (claimDefault path)
**Pattern checked:** lender flash-loans, pumps collateral price down via
sandwich, claims default at deflated value to extract excess.
**Why blocked:** liquidation in TegridyLending is purely **time-gated**
(`block.timestamp > effectiveDeadline + GRACE_PERIOD + outageBuffer`). There
is **no LTV / oracle component** to the trigger. The collateral NFT goes to
the lender at default regardless of price; a flash-loan price move cannot
accelerate or amplify the trigger. Same for TegridyNFTLending.

### F-45-D4 — Vault first-deposit share inflation (donate-inflate-mint)
**File:** `contracts/src/TegridyPair.sol:149-156` (initial mint),
restaking + LP farming (no share token — direct accounting),
`TegridyStakingJbacVault.sol` (custody, not share-vault)
**Pattern checked:** attacker is first depositor, mints 1 wei of LP, donates
massive amount to pair, ratio inflated, second depositor's mint truncates to
≤ 1 wei.
**Why blocked:** TegridyPair line 154-156:
`require(rawLiquidity > MINIMUM_LIQUIDITY * 1000, "INSUFFICIENT_INITIAL_LIQUIDITY")` —
1,000,000 wei minimum initial sqrt(amount0 * amount1). MINIMUM_LIQUIDITY
(1000) burned to `0xdead`. First depositor cannot mint ≤ 1 wei. Inflation
attack economically infeasible per Uniswap V2 hardened pattern.
TegridyRestaking and TegridyLPFarming use direct per-user accounting (no
ERC4626-style share token), so no share inflation surface exists.

### F-45-D5 — External flash-loan (Aave/Balancer) → protocol → manipulate → return
**Pattern checked:** Aave flash-loan TOWELI/WETH → push pair reserves → call
into protocol surface that reads spot reserves → reverse swap → repay loan.
**Why blocked, end-to-end:**
- Spot reserve reads via `TegridyPair.getReserves()` exist only in
  `TegridyRouter` (for `getAmountsOut/In`, which is internal swap math, no
  decision branch on absolute price).
- All economic decisions (collateral value, LP fairness, fee discount,
  voting weight, premium gate) route through TWAP, snapshots, or
  subscription state.
- `TegridyPair.swap()` line 217 forbids flash-swap callbacks
  (`NO_FLASH_SWAPS`) — cannot borrow output before settling input.

### F-45-D6 — Bribe deposit, vote, withdraw — flash sequence
**File:** `contracts/src/VoteIncentives.sol:646-712, 768-893,
1227-1264, 1297-1340`
**Pattern checked:** attacker deposits bribe → flash-stakes to vote
maximally on own bribe → claims bribe back via majority-share + recover
deposit.
**Why blocked:**
1. Flash-stake never exceeds historical anchor (D1) — same-block stake
   contributes 0 to the vote.
2. `claimBribes` (line 805) `if (depositedOnPair[msg.sender][epoch][pair])
   revert SelfBribeClaimForbidden` — depositor is barred from claiming any
   token on their own bribe pool (BATCH-A self-bribe lockout).
3. Bribe refund paths
   (`refundOrphanedBribe`/`refundUnvotedBribe`/`refundSubQuorumBribe`)
   require `UNVOTED_REFUND_GRACE = 14 days` post-vote-deadline. No
   single-tx bond recovery surface.

### F-45-D7 — LP farming claim flash-amplified boost
**File:** `contracts/src/TegridyLPFarming.sol:189-242, 287-294`
**Pattern checked:** flash-loan TOWELI → `stakeWithBoost` to spike
`aggregateActiveBoostBps(user)` → `getReward()` reads inflated boost via
`updateReward` modifier → withdraw stake → return loan.
**Why blocked:**
- `stakeWithBoost` requires a lock duration ≥ `MIN_DURATION` (~7-30 days,
  per TegridyStaking constant). TOWELI sits in lock; cannot be returned in
  the same tx.
- `increaseAmount` on an existing position raises `boostedAmount`
  proportionally — `weightedBps = totalBoosted / totalAmount` is unchanged
  for same-`boostBps` adds (an n-NFT user adding amount to their highest-
  boost NFT can shift the average toward MAX, but the underlying TOWELI
  is still locked, so flash-return impossible).
- `MAX_BOOST_BPS_CEILING = 45000` clamps any aggregate read.
- `_getEffectiveBalance` is also re-derived inside `updateReward` BEFORE
  earned() (PASS7-LPFARM-M1 fix), so cache staleness over time is closed.

### F-45-D8 — PremiumAccess flash-buy NFT, hasPremium=true, action, sell
**File:** `contracts/src/PremiumAccess.sol:174-201`,
`contracts/src/SwapFeeRouter.sol:631-644`
**Pattern checked:** flash-borrow JBAC NFT → `activateNFTPremium` →
fee-discounted swap → return NFT.
**Why blocked:**
- On-chain consumers (SwapFeeRouter, line 632) call
  `hasPremiumSecure(user)` which is **subscription-only** (line 192-201).
  `hasPremiumSecure` for a pure NFT holder returns `false`.
- `hasPremium()` (the off-chain UI variant, line 174-184) requires
  `nftActivationBlock[user] != 0 && block.timestamp >
  nftActivationBlock[user] + MIN_ACTIVATION_DELAY` (15 s). A same-tx
  `activateNFTPremium` writes `block.timestamp`, then 15-s gate fails.
- `MIN_HOLDING_PERIOD = 1 day` blocks same-block subscribe-then-cancel
  refund-arb.
- ERC721 (JBAC) has no flash-borrow primitive in this protocol — would
  require an external NFT lender (e.g., NFTfi flash). Even with one,
  steps 1-3 above kill the chain.

### F-45-D9 — DEX swap into pair to manipulate K, liquidation cascade, reverse swap
**Pattern checked:** push K through swap → trigger price-driven downstream
action → reverse swap.
**Why blocked:**
- No price-driven liquidation exists (D3).
- POL `accumulate`/`executeHarvestLP` are `onlyOwner` and gate on
  TWAP-derived per-leg minOuts plus a 50bps spot-vs-TWAP deviation
  rejection (`HARVEST_TWAP_DEVIATION_BPS`, POLAccumulator.sol:935-936).
- LP harvest minOut floor in TegridyFeeHook is gated to `1e14 wei` minimum
  (line 572), protecting against owner-side capture but irrelevant to a
  permissionless flash chain.
- All consumer-side spot-vs-TWAP comparisons exist (POL line 935).

### F-45-D10 — Pair sync after donation flash bend → kLast manipulation
**File:** `contracts/src/TegridyPair.sol:312-316 (sync), 340-416 (harvest),
469-487 (_mintFee)`
**Pattern checked:** flash-loan token0+token1 → direct-transfer to pair →
`sync()` → `harvest()` to anchor `kLast` at inflated value, suppressing
future `_mintFee` accrual.
**Why blocked:**
- `harvest()` line 392-404 — bootstrap path (kLast == 0, first time fee
  becomes payable) is gated to `feeToSetter` only. A captured-key
  feeToSetter could anchor `kLast` high; a permissionless attacker cannot.
- The "normal" path requires `totalSupply() > supplyBefore` (`_mintFee`
  actually minted), so an attacker who pre-pumps reserves causes
  `_mintFee` to mint MORE protocol LP (rootK >> rootKLast → larger
  `numerator`), benefitting treasury, not attacker.
- After harvest, `kLast = reserve0 * reserve1` (post-update, line 414).
  The donated tokens are still in the pair as reserves — to recover them
  the attacker must `burn` LP they minted before donation, which dilutes
  with all existing LPs (donation went to ALL holders proportionally).
  Net donation cost not recoverable.
- `sync()` is gated on `disabledPairs`/`blockedTokens` (D-AMM-H2
  preserved, line 313-314), preventing cumulative-poison attack via the
  "donate-then-sync-on-disabled-pair" vector.

---

## Notes / Informational

### N-45-1 — `ReferralSplitter.recordFee` reads LIVE `votingPowerOf(referrer)`
**File:** `contracts/src/ReferralSplitter.sol:386-400, 647-656, 685-694`
**Observation:** at line 386, `stakingContract.votingPowerOf(referrer)` is
LIVE (no historical anchor) for the referrer-qualification gate. The
`referrerShare` accrual to `pendingETH[referrer]` happens in the same
function call.
**Could it be flash-amplified?** Trying:
1. Bob = referrer with 0 stake (normally unqualified).
2. Alice = user routes a swap through SwapFeeRouter → `recordFee` is invoked
   inside Alice's tx with `msg.sender = approvedCaller` and `referrer = Bob`.
3. For Bob's qualification to flip true within the call, Bob would need
   ≥ MIN_REFERRAL_STAKE_POWER live voting power at this exact instant.
**Why blocked anyway:** every path to acquire staking voting power requires
locking TOWELI for ≥ MIN_DURATION (7+ days). A flash-loan cannot return
locked TOWELI within the same tx. The NFT-transfer paths
(`stakeWithBoost`/`increaseAmount`/transfer-from-lending) all involve
TRANSFER_COOLDOWN (24 h) + TRANSFER_RATE_LIMIT (1 h) for non-lending hops,
or actual stake settlement for the mint path. **No same-tx amplification
exists.**
**Recommendation:** none required; live read is structurally safe. If the
team wants belt-and-braces symmetry with the governance consumers, switch to
`votingPowerAtTimestamp(referrer, block.timestamp - 1)` — but this trades
clarity for redundant defense. **No fix needed.**

### N-45-2 — TegridyTWAP first observation deliberately marked `bypassed`
**File:** `contracts/src/TegridyTWAP.sol:332-354 (FRESH-EYES H-3)`
**Observation:** the very first observation on a freshly-bootstrapped pair
is marked `bypassed = true`, so `consult()` refuses to serve a TWAP that
includes it (per `_getCumulativePricesOverPeriod` line 781 + the latest-
observation guard line 528-535). This is an intentional self-bricking
behavior that recovers automatically once two non-bypass observations have
overwritten the bootstrap and the bootstrap rolls out of the lookup window.
**Could it be flash-amplified?** Tried: attacker creates a fresh pair with
manipulated initial reserves, calls update() to write a poisoned anchor,
then waits for honest consults to read it. Blocked by the bypass flag —
ALL downstream consults revert OracleRebootstrapping until two clean
observations are present, and the BATCH-M3 H7 self-bootstrap grace
(observations 2 and 3 also marked bypassed) extends this protection.
**No exploit; protection working as designed.**

### N-45-3 — `TegridyPair.harvest()` is permissionless (intended)
**File:** `contracts/src/TegridyPair.sol:340-416`
**Observation:** `harvest()` is permissionless on the normal-fee-mint path
(non-bootstrap, non-cleanup). The function NatSpec at line 326-338 already
addresses the MEV concern: per-call dilution is bounded to the 1/6th
protocol-fee share of the 0.3% swap fee (~0.05% of swap volume) and
HARVEST_INTERVAL = 5 minutes caps cadence. Combined, MEV upside is
uneconomic vs. searcher gas + priority-fee.
**Confirmed:** the `bootstrap` branch is feeToSetter-gated (line 402-404),
the `cleanup` branch only zeroes a stale kLast (no manipulation benefit),
and the normal-fee-mint branch only credits LP if K actually grew. Flash-
amplification would require a same-block reserve push (donate + sync),
but the donation goes proportionally to all LPs — net negative for the
attacker.
**No exploit.**

---

## What I checked (positive coverage)

- All 12 governance/voting entrypoints reading `VotePowerOracle.powerAt`/
  `powerOf` — every site uses `min(historical, current)` clamp.
- `RevenueDistributor._distribute` and `_calculateClaim` — both use
  `totalBoostedStakeAtTimestamp(T-1)` denominator paired with
  `votingPowerAtTimestamp(T-1)` numerator (REV-M-01).
- `TegridyLending` — collateral valuation via 30-min TWAP; liquidation by
  deadline only.
- `TegridyNFTLending` — no oracle dependency; deadline-only liquidation.
- `TegridyTWAP` — deviation gate, bypass flag, sequencer check, factory
  authentication, per-window bypass-anchor revert.
- `TegridyPair` — flash-swap rejected, K-invariant raw, sync/skim/mint/burn
  gated on disabled/blocked, harvest bootstrap feeToSetter-gated,
  initial-mint inflation guard.
- `TegridyFactory` — pair-create authenticity, MAX_PAIRS bound.
- `POLAccumulator` — owner-only; TWAP-anchored minOut floors;
  spot-vs-TWAP deviation reject.
- `PremiumAccess` — on-chain consumers correctly use `hasPremiumSecure`.
- `TegridyLPFarming` — `aggregateActiveBoostBps` is bounded by
  MAX_BOOST_BPS_CEILING; raw amount adds don't shift weighted bps.
- `TegridyStaking` — TRANSFER_COOLDOWN, TRANSFER_RATE_LIMIT,
  MIN_DURATION lock; `_writeCheckpoint` on every state change; lending
  exemption is unidirectional (escrow flow) and cannot be weaponized.
- `TegridyRestaking` — `_boostedAmountAt` returns 0 for `depositTime > ts`;
  clamped against staking-side current; autoMaxLock kick carve-out
  (DR2-02).
- `TegridyFeeHook` — V4 hook fee conversion is owner-only; minETHOut
  floor 1e14 wei (BATCH-L4 M6).
- `VoteIncentives` — bribe deposit/claim/refund paths gated by epoch
  finalization + 14-day grace + self-bribe lockout.
- `MemeBountyBoard`, `CommunityGrants`, `GaugeController` — voting and
  proposal gates use historical clamp + creator-suppression +
  unique-voter-quorum.

---

## Final verdict

No exploitable flash-loan amplification chain exists under the brief's
ten lenses. The codebase has been deliberately and successfully hardened
against this class of attack. All ten dead-ends are intentional design
defenses, not coincidental gaps. No findings rise to L/M/H/C.

— Agent 45/100, fresh-eyes flash-loan amplification audit, 2026-05-07
