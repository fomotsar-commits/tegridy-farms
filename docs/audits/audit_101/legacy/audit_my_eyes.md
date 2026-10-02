# Audit — Read-It-Myself Pass (2026-04-20)

Verified by direct line-by-line read. Prior `.audit_findings.md` ignored. Battle-tested fixes cited.

Files read in full: SwapFeeRouter, GaugeController, TegridyNFTLending, TegridyLending, TegridyStaking,
TegridyPair, TegridyFactory (top), RevenueDistributor (key paths).

---

## On the user's "swaps give treasury $0" claim — VERIFIED, but with nuance

**True at default; capped at 50% even after governance.** Trace:

1. **TegridyPair `_mintFee` (TegridyPair.sol:269-287)** mints LP-token fee shares to `feeTo` at 1/6 of the
   0.3% LP fee (~0.05%). `feeTo` is enforced non-zero in TegridyFactory constructor
   (TegridyFactory.sol:71). **This part works** — protocol does capture the V2-style mint fee.
2. **SwapFeeRouter wrapper** takes a SECOND fee (default `feeBps`) on top, in ETH (or token, depending
   on path).
3. ETH fees collect in `accumulatedETHFees` and are split by `distributeFeesToStakers`
   (SwapFeeRouter.sol:806-852) using `stakerShareBps / polShareBps / treasury-remainder`.
4. **Defaults: `stakerShareBps = 10_000` (line 126), `polShareBps = 0` (line 130)** → treasury gets
   nothing until `proposeFeeSplit` is run. Even after governance, **`MIN_STAKER_SHARE_BPS = 5_000`**
   (line 141) **caps treasury at 50%**.

**That covers ETH-side flows. The hidden bleed is token-only swaps.**

---

# CRITICAL

## C1. Token-only swap fees never reach stakers (SwapFeeRouter.sol:425-432, 497-503, 611-614)

`swapExactTokensForTokens` and the FoT variants accumulate fees as `accumulatedTokenFees[token]`. The
ONLY exit path for those balances is `withdrawTokenFees(token)` (line 969), which sends 100% to
`treasury` directly — **bypassing `stakerShareBps` entirely**. There is no auto-conversion-to-ETH and
no staker share for token swaps.

**Loss scenario:** every USDC↔TOWELI, USDC↔USDT, TOWELI↔WBTC swap. Stakers earn 0 on these. As soon
as the protocol has stable-pair volume, the staker share collapses relative to total swap revenue.

**Battle-tested fix (Sushi MasterChef / Curve admin_fee):** before withdraw, swap the accumulated
token to WETH via the router (or accumulate against a permissionless `convertAndDistribute()`),
deposit into `accumulatedETHFees`, then run `distributeFeesToStakers`. Or simpler: have the
withdrawTokenFees path push into a `pendingTokenSplit[token]` struct with the same staker/pol/treasury
BPS and distribute on a second call once swapped.

---

## C2. GaugeController per-NFT vote uses owner-AGGREGATED voting power → quadratic weight for contract holders (GaugeController.sol:172-228, TegridyStaking.sol:324-343)

`vote()` checks `tegridyStaking.ownerOf(tokenId) == msg.sender` (per-NFT), then reads
`votingPowerAtTimestamp(msg.sender, ...)` which `Staking.votingPowerOf` defines as the **SUM across
all NFTs the owner holds** (line 333-342). The same sum is then re-applied for every NFT the holder
votes with.

EOAs are protected by `AlreadyHasPosition` (Staking.sol:797 — single NFT per EOA).
**Contracts (Gnosis Safe, Restaking, vaults) are NOT protected** — `MAX_POSITIONS_PER_HOLDER = 100`
(Staking.sol:125). A Safe with N staking NFTs gets **N × votingPower applied per vote × N votes =
N² total weight**. At the cap, a 100-NFT Safe controls **10,000× a single-NFT user's gauge weight**.

**Loss scenario:** any well-funded participant can gain disproportionate gauge weight by routing
multiple positions through one contract. They steer emissions, then claim outsized
RevenueDistributor share via the same checkpoint inflation path (via VoteIncentives bribes too).

**Battle-tested fix (Curve / Aerodrome):** make `vote()` per-USER not per-NFT. Either (a) sum the
user's voting power once and require a single vote() call per epoch, or (b) divide aggregated power
by the number of NFTs they hold so each NFT vote contributes its proportional slice. Curve enforces
one ve-balance → one vote.

---

## C3. RevenueDistributor lock-state check uses `userTokenId` (single pointer) for multi-NFT holders (RevenueDistributor.sol:545-563, 413-417)

`_getUserLockState(user)` calls `votingEscrow.userTokenId(user)` which returns only the LAST received
NFT (Staking.sol:829 overwrites). It then reads `positions(tokenId).amount` and `.lockEnd` from that
ONE NFT to decide `lockActive` / `inGracePeriod`.

For contracts holding multiple NFTs:
- If the most-recent NFT's lock has expired but earlier NFTs are still active → user is treated as
  "in grace period," eventually losing claims after `CLAIM_GRACE_PERIOD` even though they have
  active locked positions and active voting power via the checkpoint.
- If the most-recent NFT was withdrawn (userTokenId reset to 0) → revert NoLockedTokens, even if
  other NFTs still active.

So `votingPowerAtTimestamp` returns the SUM correctly (line 511) — but the gate before that **shuts
the door on multi-NFT contracts**.

**Battle-tested fix (Curve FeeDistributor):** drop the single-pointer check. Use
`votingPowerAtTimestamp(user, currentTime)` itself as the activeness signal. Anyone with non-zero
historical and current voting power at any epoch in range can claim that epoch.

---

## C4. SwapFeeRouter `distributeFeesToStakers` reverts if either staker or POL receiver fails the 50k-gas call (SwapFeeRouter.sol:826, 837)

```solidity
(bool okStaker,) = revenueDistributor.call{value: stakerAmount, gas: 50_000}("");
require(okStaker, "STAKER_TRANSFER_FAILED");
```

If RevenueDistributor.receive() ever does anything heavier than emitting one event (it currently
emits `ETHReceived(sender, amount)` which fits in 50k), the entire distribute call reverts. ETH
stays accumulated and pendable. Worse, anyone wanting to grief the protocol can deploy a contract
that sets itself as polAccumulator (after a 48h gov passage) and whose `receive()` reverts → stops
all distribution permanently until polAccumulator is reset.

The treasury slice uses `WETHFallbackLib.safeTransferETHOrWrap` (line 847) which falls through to
WETH wrap on failure. **Staker and POL paths should also fall through** rather than revert.

**Battle-tested fix (Curve FeeDistributor / Aave Treasury):** convert push-with-revert to
push-with-WETH-fallback for all three legs. If staker leg fails, wrap to WETH and queue in a
`pendingDistribution[revenueDistributor]` slot for permissionless pull. Same for POL.

---

## C5. Lock extension and autoMaxLock toggle are completely free → silent dilution of all other stakers (TegridyStaking.sol:536-557, 562-582)

`extendLock` and `toggleAutoMaxLock`:
- Recompute boost (up to 4× + 0.5× JBAC = 4.5×).
- Update `boostedAmount` and `totalBoostedStake`.
- Write a fresh checkpoint → user's voting power immediately jumps.
- Cost: zero protocol fee.

Result: a whale with a 7-day lock can extend to 4 years anytime, capturing 10× higher revenue
share via RevenueDistributor (which weights by voting power) and 10× higher gauge weight. Every
other staker's % share dilutes. No protocol revenue offsets the dilution.

This is the classic "free boost" trap that Curve avoided by making boost decay over time — your
power leaks unless you actively re-lock, which costs gas + opportunity. Here, set-and-forget
autoMaxLock gives you 4× perpetually for one transaction.

**Battle-tested fix (Curve veCRV linear decay OR Convex fee on extend):**
- Option A (preferred): add `EXTEND_FEE_BPS = 50` (0.5%) of the position's `amount` taken in TOWELI
  on every extendLock / autoMaxLock-enable, sent to treasury for buyback or reward refund.
- Option B: switch boost to linear decay so boost(t) = boost_lockEnd × (lockEnd-t)/(lockEnd-stakeTimestamp).
  Auto-max-lock then becomes a perpetual gas burn rather than a free 4×.

---

## C6. Early-withdrawal penalty rots in treasury — never recycled (TegridyStaking.sol:660-665, 1049-1058)

25% penalty on early exit goes directly to `treasury` via `safeTransfer`. Treasury is a passive
address. Without manual `notifyRewardAmount()` from the same address, **the penalty never returns
to active stakers**. Effectively, exiters' loss is treasury gain, not staker gain.

The user's mental model ("rage-quit penalty boosts loyal stakers' APR") is broken silently.

**Battle-tested fix (Synthetix StakingRewards):** auto-route penalty into the reward pool. Replace
`rewardToken.safeTransfer(treasury, penalty)` with `_notifyReward(penalty)` (internal — no min
threshold for system-internal flows; bypass MIN_NOTIFY_AMOUNT). Or split: 50/50 between treasury
and reward pool.

---

## C7. Lending and NFTLending earn $0 on defaulted loans (TegridyLending.sol:485-503; TegridyNFTLending.sol:391-403)

Protocol fee (`protocolFeeBps × interest / BPS`) is calculated **only inside `repayLoan`**.
`claimDefaultedCollateral` (Lending.sol:519-546) and `claimDefault` (NFTLending.sol:418-441)
transfer the NFT to the lender and emit. **Zero ETH, zero token, zero fee accrues to the protocol
on default**.

Defaults are the largest-value flows in P2P lending. Loan principal stays with borrower; collateral
(usually worth more than principal+interest) moves to lender. If 30% of loans default and the
average defaulted collateral is 1.5× principal, the protocol misses ~45% of total transaction value.

Worse, this incentivizes lenders to set 0% APR + take attractive NFTs as collateral — a no-fee path
to acquire NFTs cheaply. The protocol becomes free escrow infrastructure.

**Battle-tested fix:**
- **Origination fee** (NFTfi pattern): `originationFeeBps = 100` (1% of principal) deducted from
  lender's deposit at `createOffer`, sent to treasury. Captures revenue on EVERY accepted loan
  regardless of repay/default outcome.
- **Default penalty / liquidation fee** (Aave / Compound pattern): on `claimDefault`, the lender
  pays a fee in ETH (e.g., 5% of principal) before receiving collateral. Or accrue a
  `pendingDefaultFee[lender]` that they must pay-then-claim atomically.
- **Min APR floor** to prevent zero-interest collateral acquisition: `MIN_APR_BPS = 100` (1%) so
  protocol always earns something on interest paths too.

---

## C8. NFT lending offer accepts arbitrary `_tokenId` with no lender ownership requirement (NFTLending.sol:240, 309)

`createOffer(_collateralContract, _tokenId)` only does `IERC721.ownerOf(_tokenId)` for existence —
the lender doesn't need to own the NFT. The check at acceptance (line 309) requires the BORROWER to
own it. So the offer is essentially "I'll loan ETH to whoever currently holds this specific NFT."

This is a marketing problem more than a security one — lenders need to know the SPECIFIC tokenId
that borrowers want to use as collateral. Most lenders don't know that. So very few offers will
ever match. **The collateral whitelist is effectively a 3-contract approved list, but the offer-form
restricts liquidity to a specific tokenId per offer.**

Battle-tested model: NFTfi lets lenders create COLLECTION-level offers (any tokenId from collection
X for principal Y, APR Z). Borrower picks any NFT from the collection at acceptance. This contract
needs collection-level offers to actually scale.

---

# HIGH

## H1. SwapFeeRouter referral path siphons up to 100% of every fee out of the staker/POL/treasury split (SwapFeeRouter.sol:248-256, 334, 393, 557)

`_recordReferralFee` forwards the **entire** fee to ReferralSplitter when it succeeds. Everything
the splitter does after that (referrer share, qualifying logic, treasury sweep) is OPAQUE to the
SwapFeeRouter's split governance. The `stakerShareBps / polShareBps / treasury` split only applies
to fees that fall through to `accumulatedETHFees` because the splitter call REVERTED.

So the practical fee flow for ETH-in/out swaps is:
- If user has a referrer who passes ReferralSplitter qualification → 100% of fee → ReferralSplitter
  controls the split (audit ReferralSplitter.recordFee). Stakers may get nothing.
- If no referrer / failed call → falls through to the timelocked split.

This means the documented "stakers get most of fees" story can be silently bypassed by referral-flow
volume.

**Fix:** SwapFeeRouter should split FIRST, then forward only the referral slice to ReferralSplitter.
Pseudocode:
```solidity
uint256 referralSlice = (fee * referralShareBps) / BPS;
uint256 protocolSlice = fee - referralSlice;
accumulatedETHFees += protocolSlice;       // governed split applies
_recordReferralFee(msg.sender, referralSlice);  // narrow surface
```

---

## H2. SwapFeeRouter.distributeFeesToStakers POL-failure does not unwind state (SwapFeeRouter.sol:808-810, 837)

`accumulatedETHFees = 0` happens at line 810 BEFORE any external call. If the staker call succeeds
and the POL call reverts, the require revert at line 837 unwinds everything to zero state — fine,
that's correct CEI. But: there's a subtle bug. `polAmount` is computed off `accumulatedETHFees`
PRE-zeroing. The `(amount * polShareBps) / BPS` is consistent. So actually OK — checked twice.

Skipping. (Initial concern was misread.)

---

## H3. `notifyRewardAmount` is permissionless and adds rewards immediately, with no per-caller rate limit (TegridyStaking.sol:1069-1074)

Anyone can fund rewards as long as `_amount >= MIN_NOTIFY_AMOUNT (1000e18)`. No timelock. No
event-based rate limiter. An attacker could:
- Fund a giant amount precisely when they're about to claim → grabs disproportionate share.
- Spam many small valid notifications to manipulate `rewardPerTokenStored` accrual timing.

Mitigation present: rewardRate is admin-set via timelock, so APR per-second is bounded. An attacker
adding tokens just sits in the balance and accrues at `rewardRate`. So this is more of a
front-running of the next `_accumulateRewards` cycle than direct theft. Still suboptimal.

**Fix:** Either restrict `notifyRewardAmount` to owner OR a whitelisted set of contracts (treasury,
RevenueDistributor, FeeRouter), OR add a 24h delay between fund-and-accrual so funders can't
sandwich a claim.

---

## H4. GaugeController allows expired-position vote arbitrage (GaugeController.sol:202-204)

`votingPower = votingPowerAtTimestamp(msg.sender, epochStartTime(epoch))` — historical lookup.
`amount > 0 && block.timestamp >= lockEnd` is the only LIVE check (line 203).

If a user voted at the very start of the epoch when their lock was still active, then early-exits
mid-epoch, their vote STAYS counted (snapshot already captured). They earned the gauge influence
without holding TVL through the epoch. Penalty (25% via earlyWithdraw) is the only cost — but if
their gauge gets emissions worth more than 25% of their position, profitable arbitrage.

**Fix (Curve approach):** retroactive vote slashing on early exit. When `earlyWithdraw` is called,
zero out the user's contributions to all current-epoch gauge weights by walking
`_tokenVotes[tokenId]` and subtracting from `gaugeWeightByEpoch`. Or: enforce that voting power
checkpoint cannot increase the same week it was used to vote AND the lock can't be exited in the
voted week without 100% slash.

---

## H5. NFT Lending allows `aprBps = 0` (NFTLending.sol:231) — combined with no protocol fee on default = lender uses protocol as free NFT acquisition channel

`if (_aprBps > MAX_APR_BPS) revert AprTooHigh();` — only checks max. Lender can set 0% APR.
Combined with no fee on default, a lender can:
1. Pick a borrower with a desirable NFT.
2. Offer a low principal at 0% APR for a short duration.
3. Borrower accepts (free money in their eyes).
4. Lender hopes for default (if borrower can't repay 0% interest in time, lender keeps NFT).

Protocol earns nothing. Same as Lending.sol — no min APR.

**Fix:** add `MIN_APR_BPS = 100` (1%) to both contracts.

---

## H6. NFT Lending whitelist removal does not refund or unwind active loans (NFTLending.sol:567-575)

`executeRemoveCollection` flips `whitelistedCollections[collection] = false` instantly. Active
loans whose collateralContract was just delisted CONTINUE EXISTING — repayLoan doesn't check the
whitelist (line 355-412 has no whitelist check; only `acceptOffer` does at line 306). So loans
proceed to natural conclusion. **But** new offers stop, and the NFT is escrowed indefinitely if
the collection is now banned for other reasons (e.g., turned out to be fraud).

Worse: 24h timelock < MAX_DURATION (365 days). A scam collection can go through the whole admin
process while a 365-day loan is in flight using its NFTs as collateral.

**Fix:** track active-loan count per collection. Either prevent removal while active loans exist,
or extend grace period to longer than MAX_DURATION, or add an emergency-unwind path to settle and
return collateral atomically.

---

## H7. SwapFeeRouter FoT-output slippage check uses post-fee amount but router was called with `0` (SwapFeeRouter.sol:485, 495; same pattern at 543, 599)

`router.swapExactETHForTokensSupportingFeeOnTransferTokens{value: msg.value}(0, ...)`. Setting
`amountOutMin = 0` to the underlying router DISABLES Uniswap's slippage protection. Then we do our
own check at line 495: `if (userAmount < amountOutMin) revert SlippageExceeded();`.

What this means: between the `swap` call returning and the slippage check, **any reentrancy that
runs other state — e.g., a malicious FoT token's hook into other protocol contracts** — sees the
swap completed without slippage protection. nonReentrant on this contract blocks re-entry HERE,
but the FoT hook running mid-swap can re-enter ANY OTHER protocol contract (RevenueDistributor,
ReferralSplitter, Staking, etc.) using the protocol's now-altered token balances.

The underlying Uniswap V2 router pattern is the same way (V2 also exposes the
SupportingFeeOnTransfer variants with the slippage check delegated to the caller). So this is
inherited from Uniswap rather than a Tegridy-specific bug, BUT the wrapper amplifies the surface
because SwapFeeRouter is a STATEFUL contract that other protocol code reads from
(`accumulatedETHFees`, `accumulatedTokenFees`).

**Fix:** the router-return slippage check is correct, but tighten by passing a non-zero
`amountOutMin` to the underlying router computed as
`amountOutMin × (BPS - effectiveFee) / BPS` (i.e., what the router needs to deliver pre-fee for our
post-fee check to pass). That keeps the V2 router's own protection active as a defense-in-depth.

---

## H8. SwapFeeRouter Premium-discount path is fail-open (SwapFeeRouter.sol:277-286)

When `premiumAccess` reverts, the user pays full fee with no discount and no event emitted from
this view function (it's `view`, can't emit). The contract has `isPremiumAccessHealthy()` view but
nothing on-chain enforces a heartbeat. If the integration breaks for weeks, premium subscribers pay
double silently (full fee + monthly subscription).

**Fix:** add an off-chain monitoring requirement to the deploy checklist that polls
`isPremiumAccessHealthy()` and a contract-side counter incremented on the catch path of
`_getEffectiveFeeBps`. Even better: revert if premiumAccess is set but unhealthy, with a
`pausePremiumDiscount(bool)` admin override for emergencies.

---

# MEDIUM

## M1. GaugeController `pendingGaugeAdd` / `pendingGaugeRemove` single-slot race (GaugeController.sol:103-104, 421-468)

If owner runs `proposeAddGauge(A)` then `proposeAddGauge(B)` before executing, `pendingGaugeAdd` is
overwritten to B. The TimelockAdmin operation key (`GAUGE_ADD`) is shared, so the proposal-time
restart is what matters. Need to verify TimelockAdmin behavior — if `_propose` accepts a fresh
proposal while one is pending, the address slot drifts from the operation key's intent.
`executeAddGauge` reads the slot at execution time (line 432), so it always adds whatever happens
to be in the pending slot.

**Fix:** key the pending state on a hash of `(address, op)` instead of a single slot. Or reject
double-propose with `revert ProposalAlreadyPending`.

---

## M2. GaugeController low-participation epoch lets a single voter capture 100% of emissions (GaugeController.sol:380-393)

`getRelativeWeight = (gaugeWeightByEpoch[epoch][gauge] * BPS) / totalWeightByEpoch[epoch]`. If only
one voter voted in the epoch with even 1 wei of voting power, that gauge gets 100% of emissions —
regardless of total ecosystem stake.

**Fix (Curve):** require minimum participation (e.g., totalWeightByEpoch[epoch] >= X% of
`votingEscrow.totalBoostedStake()`) before any gauge gets emissions. Below the floor, distribute
emissions equally across all gauges or burn back to treasury.

---

## M3. Staking — `revalidateBoost` allows DOWNGRADE only by position owner or restaking; legacy positions stuck (TegridyStaking.sol:693-736)

For deposit-based positions (jbacDeposited=true), revalidateBoost reverts (line 707). Good.
For legacy positions (jbacDeposited=false, hasJbacBoost=true): only owner or restakingContract can
downgrade. **No one can permissionlessly clean up legacy boosts even if the user has long since
sold/lost their JBAC.** Stale boosts dilute everyone else's rewards.

**Fix:** allow ANY caller to call `revalidateBoost` for legacy positions ONLY (the deposit-based
path is already safe). Add `if (!p.jbacDeposited && p.hasJbacBoost) { /* permissionless */ }`.

---

## M4. NFTLending `transferFrom` instead of `safeTransferFrom` for collateral return (NFTLending.sol:395, 438)

When returning the NFT to a borrower or claiming for a lender, uses `transferFrom`. If the recipient
is a contract that doesn't implement IERC721Receiver, the NFT lands but isn't acknowledged. For
hot-potato NFTs (some marketplaces require receipt confirmation), this is silent loss of UX. Not a
fund-loss bug.

**Fix:** use `safeTransferFrom` and document that recipients must implement IERC721Receiver. OR add
a separate try-safe-then-fall-back-to-unsafe pattern.

---

## M5. Lending `createLoanOffer` missing `nonReentrant` (TegridyLending.sol:298-334)

The function is `payable whenNotPaused` but no reentrancy guard. Currently safe because no external
calls happen in the function body, but if future versions add a callback (notify lender, hook,
event-listener registration), this becomes reentrant. Also breaks the consistency convention where
all other state-mutating externals here are `nonReentrant`.

**Fix:** add `nonReentrant`.

---

## M6. Lending `_positionETHValue` spot-reserve oracle is sandwich-manipulable (TegridyLending.sol:674-683)

Documented in code comments (line 664-670). Risk is real — a sandwich attack against `acceptOffer`
when `minPositionETHValue > 0` lets a borrower trick the floor check via flash loan price spike.

Mitigant: optional per-offer flag (default 0 = disabled), so risk is opt-in by lenders. But anyone
opting in is exposed.

**Fix:** swap to TWAP from a Uniswap V3 oracle (when one exists for TOWELI/WETH) OR use the
existing TegridyTWAP contract. The right pattern is `IUniswapV3OracleConsumer.consult(pool, period)`
with a 30-min lookback.

---

## M7. RevenueDistributor `claim` 10k gas stipend may force pendingWithdrawals for legitimate contract recipients (RevenueDistributor.sol:431, 475)

10k gas is enough for plain ETH receive but NOT for any contract that emits an event in receive()
or does state writes. Those contracts get punted to `pendingWithdrawals`. Fine for safety, but adds
UX friction (extra tx required).

The withdrawPending() path uses WETHFallbackLib so it's eventually-safe. But high-frequency claimers
who happen to be smart contracts (DAOs, pools) effectively pay double gas.

**Fix:** add a `claimToWETH()` variant that always wraps and ERC20-transfers, avoiding the call
indirection entirely for contracts that don't need ETH.

---

# LOW

## L1. Staking `_accumulateRewards` advances `lastUpdateTime` even when totalBoostedStake==0 (TegridyStaking.sol:393-411)

Reward time advances during periods of no stakers, so emissions during empty periods are silently
forfeited. Consistent with Synthetix StakingRewards. Documented as intentional but worth noting:
during bootstrapping, the reward pool drains relative to lastUpdateTime even if no one was earning.

## L2. SwapFeeRouter `recoverCallerCredit` has no automatic accounting bridge (SwapFeeRouter.sol:991-1006)

Pulls ETH from ReferralSplitter into SwapFeeRouter's plain balance. Doesn't add to
`accumulatedETHFees`, so the recovered ETH is "stuck dust" that only `sweepETH` can move (and
sweepETH sends to treasury, NOT through the staker/POL split).

**Fix:** `accumulatedETHFees += recovered;` after the withdraw call.

## L3. SwapFeeRouter constructor allows `feeBps = 0` (line 235)

Constructor reverts only on `_feeBps > MAX_FEE_BPS`. Setting fee to 0 at deploy ships a fee-less
router. Acceptable if intentional (free-trading launch period), but no event makes this loud.

## L4. NFTLending hardcodes 3 collection addresses in constructor (lines 203-205)

JBAC, Nakamigos, GNSS Art whitelisted at deploy. No deploy parameter. Removes flexibility for
test/staging environments. Re-deploys required to change initial whitelist.

## L5. Staking `MAX_REWARD_RATE = 100e18` per second = 8.64M TOWELI per day cap

Theoretical max APR is ~3.15B TOWELI/year. With 1B max supply this is 315% APR before compounding.
The owner could sustain that for a few weeks before the reward pool empties. Bounded but high.

## L6. Staking `MIN_STAKE = 100e18` allows large numbers of positions per holder (Lending and Restaking call paths)

Combined with `MAX_POSITIONS_PER_HOLDER = 100`, a contract holder can own 100 positions of 100
TOWELI each = 10,000 TOWELI total but with full per-NFT vote amplification (see C2). This makes
the per-NFT vote bug practically exploitable at low capital cost.

---

# Cross-cutting silent killers (design, not bugs)

These are patterns that silently kill protocol economics without being "vulnerabilities":

1. **No fee on governance interactions.** Voting (GaugeController), claim (RevenueDistributor),
   lock-extend (Staking), enable-autoMaxLock (Staking), referral payout — all free. Curve charges
   implicit cost via decay; we don't.

2. **Penalty/forfeit flows are dead-letter to treasury.** Early-withdraw penalties, forfeited
   unsettled rewards (forfeited above the cap), failed-distribution dust — all land in treasury
   and require manual `notifyRewardAmount()` to recycle. Without owner discipline, every penalty
   the protocol collects is permanently sequestered from active stakers.

3. **The "treasury" is never used as a yielding vault.** It just receives. Compare Olympus
   (treasury bonds yield tokens), Aave reserve factor (treasury-owned aTokens yield), Curve
   (admin_fee pool earns alongside LPs). Tegridy's treasury is a bank account, not a productive
   asset.

4. **Token-side flows orthogonal to ETH-side fee distribution.** Token swaps fund treasury;
   ETH swaps fund stakers (mostly). No conversion bridge → stakers earn nothing on stable-pair
   volume. NFTLending repays in ETH but its protocol fee never feeds the staker pool either —
   it lands directly in `treasury` via WETHFallbackLib.

5. **Per-NFT vote amplification + multi-NFT contract holders + RevenueDistributor's
   `votingPowerAtTimestamp` reading the SUM**: combine the three and a well-funded Safe gets
   N²-amplified gauge weight AND N-amplified revenue share. Then they bribe themselves via
   VoteIncentives (which I didn't read; if it also reads votingPowerAtTimestamp the issue
   compounds).

---

# Recommended fix priority

1. **C1 token-fee → stakers conversion** — biggest revenue capture you're losing right now.
2. **C2 per-NFT vote → per-user vote** in GaugeController — biggest governance integrity issue.
3. **C3 RevenueDistributor lock-state check using userTokenId** — locks out multi-NFT contract
   holders from claiming.
4. **C7 origination fee + default penalty on lending** — single largest hidden flow with no
   capture.
5. **C5 lock-extend / autoMaxLock fee** — closes the free-boost trap.
6. **C6 penalty recycling to rewards** — turns rage-quitters into staker APR boost.
7. **C4 staker/POL transfer fallback** — operational hardening.
8. **H1 referral split ordering** — enforces governance over total fee flow.

Items M1-M7 and L1-L6 can ship as a polish batch.

---

# Wave 2 — All-contracts pass (2026-04-20)

Read every remaining contract in full. Findings below extend the priority-5 set.

## Retraction

- **M1 (GaugeController pendingGaugeAdd race) — INVALID.**
  [TimelockAdmin._propose:50](contracts/src/base/TimelockAdmin.sol:50) reverts with
  `ExistingProposalPending(key)` if a proposal already exists. Owner cannot overwrite
  pending state. Score this one as a non-finding.

---

## CRITICAL — extension of C1

### C1-extended: ReferralSplitter pull pattern siphons 90% of every fee out of the staker/POL/treasury split (ReferralSplitter.sol:240-302; SwapFeeRouter.sol:991-1006)

I previously called this H1. After reading ReferralSplitter end-to-end I'm upgrading to
CRITICAL — it's **the same class of bleed as the token-only-swap bug**. Trace:

1. Swap with referrer set → SwapFeeRouter sends **100%** of the fee via
   `referralSplitter.recordFee{value: fee}(_user)` ([SwapFeeRouter.sol:250](contracts/src/SwapFeeRouter.sol:250)).
2. Inside `recordFee` ([ReferralSplitter.sol:240-290](contracts/src/ReferralSplitter.sol:240)):
   - `referrerShare = msg.value × referralFeeBps / BPS` (default 10%) → goes to referrer's `pendingETH`
     OR (if unqualified / staking down) → `accumulatedTreasuryETH`.
   - **Remainder (90%) → `callerCredit[msg.sender]`** (= SwapFeeRouter's address) via pull pattern.
3. SwapFeeRouter calls `recoverCallerCredit()` ([SwapFeeRouter.sol:991](contracts/src/SwapFeeRouter.sol:991)) which pulls the 90% back into SwapFeeRouter's plain ETH balance — but does NOT add it to `accumulatedETHFees`. It just sits in `address(this).balance`.
4. The only path to drain that ETH is `sweepETH()` ([SwapFeeRouter.sol:956-963](contracts/src/SwapFeeRouter.sol:956)) which sends 100% to `treasury`. **Stakers get 0%, POL gets 0%, treasury gets 100%.**

So whenever a user has a referrer (on-chain registered):
- 10% to referrer (as designed)
- 90% **bypasses the timelocked staker/POL/treasury split entirely** and lands in treasury
- The only thing the staker share governance controls is the no-referrer flow

**Fix:** ReferralSplitter shouldn't take 100% of the fee. SwapFeeRouter should split the fee
FIRST (`referralShareBps × fee` to splitter, remainder to its own `accumulatedETHFees`), then
distribute via `distributeFeesToStakers`. Pseudocode in original H1.

---

## HIGH — new findings

### H9. TegridyDropV2 owner can drain mint funds before cancelling — refunders revert (TegridyDropV2.sol:372-388, 397-404)

`withdraw()` blocks on `mintPhase == CANCELLED` ([TegridyDropV2.sol:373](contracts/src/TegridyDropV2.sol:373)) but does NOT block on Active phases. So owner can:
1. Run mint → users pay, contract holds ETH, `paidPerWallet` populated
2. `withdraw()` while still Active → owner gets `balance × (1 - platformFeeBps)`, treasury gets the rest
3. `cancelSale()` → phase = CANCELLED
4. `refund()` → `WETHFallbackLib.safeTransferETHOrWrap(weth, msg.sender, owed)` reverts because contract balance < `paidPerWallet[msg.sender]`

Minters lose their entire payment. Owner pockets it as creator share + platform share.

**Fix:** Track refund-reservation. `withdraw()` should compute
`withdrawable = address(this).balance - sum(paidPerWallet)` and refuse to drain that pool.
Or: only allow `withdraw()` after sale is complete (totalSupply == maxSupply OR after a
post-mint window) AND not cancellable past that point.

### H10. CommunityGrants snapshotTimestamp can be 0 if SNAPSHOT_LOOKBACK > block.timestamp (CommunityGrants.sol:228)

```solidity
snapshotTimestamp: block.timestamp >= SNAPSHOT_LOOKBACK ? block.timestamp - SNAPSHOT_LOOKBACK : 0,
```

If deployed on a chain whose `block.timestamp` is ever < 1 hour (genesis fork, testnet),
proposals snap to timestamp 0. `votingPowerAtTimestamp(user, 0)` returns the
oldest checkpoint, which is what nobody had at any time the protocol was alive. So all votes
read back as 0 power and the proposal cannot pass.

This is unreachable in production on Ethereum mainnet (timestamps are always > 1 hour past
epoch by the time any contract gets deployed), but it's a footgun for forked test environments
and L2 deployments with non-standard time semantics. Same pattern in MemeBountyBoard:215.

**Fix:** revert in constructor if `block.timestamp < SNAPSHOT_LOOKBACK`. One-liner.

### H11. RevenueDistributor `_getUserLockState` (extension of C3) also affects `pendingETH` view (RevenueDistributor.sol:711-746)

C3 noted this for `claim()`. Re-reading: `pendingETH(user)` (line 701) and
`pendingETHPaginated(user)` both call `_getUserLockState` and return 0 if the multi-NFT
contract holder's `userTokenId`-pointed NFT isn't active. So **frontends will display 0
claimable** for these users even when the underlying voting power is non-zero. Compounds
the C3 user-impact and adds UX confusion (the on-chain claim would also fail with
`NoLockedTokens`).

Fix is the same as C3 — drop `_getUserLockState` and check via `votingPowerAtTimestamp`
directly.

### H12. TegridyLPFarming `userTokenId` single-pointer reliance silently undercounts boost (TegridyLPFarming.sol:188-200)

`_getEffectiveBalance` calls `tegridyStaking.userTokenId(user)` and reads only that one
position's boost. For multi-NFT contract holders (Safes), only the LATEST NFT's boost
applies. They should aggregate; instead they get a stale single-NFT view.

Same root cause as C2/C3/H11. The whole protocol's "look up user's current NFT" usage of
`userTokenId` needs replacement with multi-position aggregation.

`refreshBoost(account)` is permissionless ([TegridyLPFarming.sol:203](contracts/src/TegridyLPFarming.sol:203)) so anyone can force a refresh, but the underlying read still uses the broken pointer.

### H13. TegridyRestaking bonus pool funded only by admin — no automatic protocol revenue stream (TegridyRestaking.sol:591-596, 69-71)

`fundBonus(amount)` requires admin to push `bonusRewardToken` into the contract. There is no
automated path from SwapFeeRouter / RevenueDistributor / fees-flow into Restaking. Either:
- Admin keeps funding manually → marketing claim "extra yield from protocol fees" is hollow
  unless owner is disciplined
- Admin stops funding → restakers earn 0 bonus silently, no event signals the drought

`updateBonus` modifier ([TegridyRestaking.sol:191-211](contracts/src/TegridyRestaking.sol:191)) caps `reward = elapsed × bonusRewardPerSecond`
to actual `available` balance. If balance < expected, accrual silently truncates without
event. Restakers see APR drift downward with no on-chain indicator.

**Fix:** wire SwapFeeRouter / RevenueDistributor to feed Restaking bonus pool a protocol
fee share, OR emit a `BonusShortfall(elapsed, expected, actual)` event on the truncation
path so off-chain observability catches the drought.

### H14. NFT Lending `aprBps = 0` extension — NO MIN check in TegridyLending either (TegridyLending.sol:307)

I called this out for NFTLending (H5). Re-reading TegridyLending:
```solidity
if (_aprBps > maxAprBps) revert AprTooHigh();
```
Same — only `>` check, no MIN. Lender can offer 0% APR loans. Combined with C7 (no fee on
default) the protocol is identically vulnerable to free-collateral acquisition.

**Fix:** add `MIN_APR_BPS` constant (e.g., 100 bps = 1%) and reject `_aprBps < MIN`.

---

## MEDIUM — new findings

### M8. TegridyDropV2 `platformFeeBps` cap is 100% (DropV2.sol:154)

```solidity
if (p.platformFeeBps > 10000) revert InvalidFeeBps();
```

Bound is BPS (100%), not 10%. LaunchpadV2 enforces 10% before deploying clones, but
direct DropV2 deploys outside the launchpad have no protection. A creator could initialize
a clone with 100% platform fee siphoning all creator share. Mitigant: requires direct
clone deploy + creator buy-in. Low practical risk but inconsistent with the launchpad's
declared cap.

**Fix:** change `> 10000` to `> 1000` (10%) to match LaunchpadV2's `MAX_PROTOCOL_FEE_BPS`.

### M9. TegridyNFTPool `changeFee` is not timelocked (TegridyNFTPool.sol:363-369)

`spotPrice` and `delta` are 24h timelocked ([NFTPool.sol:301-360](contracts/src/TegridyNFTPool.sol:301)). `feeBps` is instant. Owner of a TRADE pool
can sandwich-MEV swappers by raising `feeBps` to 9000 (90%) right before a buy. Buyer
slippage protection (`maxTotalCost`) catches it, but the buyer's tx reverts and they lose
the gas. Spammable for a determined adversary.

**Fix:** add `feeBps` to the same 24h timelock pattern. Cheap consistency win.

### M10. PremiumAccess `cancelSubscription` blocks during pause (PremiumAccess.sol:247)

`whenNotPaused` modifier prevents users from cancelling their subscription when the contract
is paused. Combined with `withdrawToTreasury()` having no pause guard, owner can pause →
withdraw what they can → leave subscribers locked into paid state with no cancel path.
Mitigant: `withdrawToTreasury` already respects `totalRefundEscrow`, so funds are safe.
But the UX is broken — subscribers can't recover their funds while emergency pause is on.

**Fix:** drop `whenNotPaused` from `cancelSubscription`. Refunds should always be possible.

### M11. TegridyLPFarming emergencyWithdraw forfeits rewards into permanent dust (TegridyLPFarming.sol:292-308)

`emergencyWithdraw` zeros `rewards[user]` and sets `userRewardPerTokenPaid[user]` to current
rpt. The forfeited tokens stay in contract balance but become unaccrueable: the leftover
calculation in `notifyRewardAmount` ([LPFarming.sol:328](contracts/src/TegridyLPFarming.sol:328)) only carries `(periodFinish - block.timestamp) × rewardRate`, not the contract balance. `recoverERC20` blocks rewardToken ([line 395](contracts/src/TegridyLPFarming.sol:395)). So forfeited amounts permanently silt up the contract.

Over time, an LP farm with high turnover accumulates unrecoverable dust. Slow bleed, not a
single-event killer.

**Fix:** in `notifyRewardAmount`, replace the leftover formula with
`actualReward + (rewardToken.balanceOf - sum(rewards[u]))`. Or add a
`reclaimForfeitedRewards()` admin function that sweeps the difference between balance and
known-owed rewards back into the active period's `rewardRate`.

### M12. POLAccumulator LP tokens locked forever — no harvest path (POLAccumulator.sol:287)

`addLiquidityETH(..., to: address(this))` deposits LP tokens into the accumulator with no
removal function. POL position is one-way. Trading fees on those LP tokens accrue inside
the LP token itself but the protocol can never claim them — they reduce future LP value
relative to underlying tokens (which the protocol owns) but only realize on burn (which
never happens).

Effectively this is "donate liquidity to the pool forever, in exchange for token-supply
absorption." A real POL strategy (Olympus/Frax AMOs) periodically harvests fees back to
treasury.

**Fix:** add a 30-day timelocked `harvestLP(uint256 lpAmount)` that burns a small fraction
(say, max 5% of `totalLPCreated` per call), receives back TOWELI + ETH, sells the TOWELI
side back into the pool (recycling), and sends ETH to treasury. Or simpler: charge a
keeper to call once a quarter.

### M13. CommunityGrants `proposerTokenId` self-vote check uses single pointer (CommunityGrants.sol:230, 257)

`proposerTokenId` is captured at proposal-creation from `votingEscrow.userTokenId(msg.sender)`.
At vote time, voter's `userTokenId` is checked. **Multi-NFT contract holders bypass:** if
proposer's `userTokenId` was overwritten by a later-received NFT before voting, their
prior NFT (the one snapshotted) is no longer their `userTokenId` — but they still hold it
and could vote with `votingPowerAtTimestamp` returning aggregate power.

The address self-vote check on [line 255](contracts/src/CommunityGrants.sol:255) catches direct self-voting. So this only matters
if proposer wraps proposal-NFT into a separate Safe / vault, gives a confederate the new
Safe's `userTokenId` overlap, etc. — exotic but not impossible.

**Fix:** track `proposerOwner` AND `proposerTokenId`, reject if voter holds the snapshotted
tokenId in their `_positionsByOwner` set. Requires Staking to expose a view for that set.

---

## LOW — new findings

### L7. TegridyTWAP `update()` is permissionless and free — protocol pays gas via callers (TegridyTWAP.sol:67)
Mild silent killer: every TWAP consumer benefits while the protocol gets nothing.
Acceptable design choice — just note it as deferred revenue.

### L8. LaunchpadV2 / NFTPoolFactory / Drop / BountyBoard / Lending have no fee on `createX()`
Anyone can deploy collections, pools, drops, bounties, lending offers free. Spam vector
bounded by gas. Could add a small TOWELI deposit (like `CommunityGrants.PROPOSAL_FEE`) to
gate creation and capture revenue. Currently $0.

### L9. CommunityGrants disbursement uses 10k gas stipend — Safes get WETH not ETH (CommunityGrants.sol:622)
Smart-account grant recipients (Safe, Argent, EIP-4337) receive WETH instead of ETH. They
have to unwrap. Documented intentional in the comment. Just note it for grant communication.

### L10. MemeBountyBoard sweepExpiredRefund sends to `owner()` not `treasury` (MemeBountyBoard.sol:469)
Other contracts route to a configurable `treasury` slot. BountyBoard's expired refunds go
to `owner()` directly. If owner is a multisig that IS the treasury, fine. If they diverge
(e.g., owner = ops EOA), refunds skip the treasury accounting.

### L11. TegridyNFTPool initial protocolFeeBps could be 0 at deploy (NFTPool.sol:140-150)
Constructor allows `_protocolFeeBps = 0`. NFTPoolFactory's constructor ([NFTPoolFactory.sol:93](contracts/src/TegridyNFTPoolFactory.sol:93))
also allows 0. If deployed with zero fee, every NFT pool earns the protocol nothing. Same
"silent killer at default" footgun as SwapFeeRouter's stakerShareBps. Verify on-chain that
`protocolFeeBps` is set non-zero post-deploy.

### L12. ReferralSplitter `setupComplete` is one-way — can never re-open (ReferralSplitter.sol:333-337)
After `completeSetup()` is called, all caller grants must go through 24h timelock. No way
to re-enable the instant path even if an emergency requires it. Acceptable defensive
choice but note that operational mistakes (misconfigured caller) will require 24h to
correct.

### L13. TegridyRestaking `decayExpiredRestaker` reverts on no-change with `revert("NO_DECAY")` (TegridyRestaking.sol:1019)
Uses string revert instead of a custom error — minor inconsistency with the rest of the
codebase. Cosmetic.

### L14. VoteIncentives `enableCommitReveal` cannot be disabled (VoteIncentives.sol:1023-1027)
Forward-only switch. Documented intentional but worth noting: a buggy commit-reveal flow
cannot be reverted to the legacy path without redeploy.

---

## Cleanly-built contracts (verified, no findings beyond noted)

These I read end-to-end and found no bugs/silent-killers worth listing:

- **Toweli.sol** — fixed-supply ERC20+Permit, no admin surface. Clean.
- **base/OwnableNoRenounce.sol** — minimal wrapper. Clean.
- **base/TimelockAdmin.sol** — DSPause pattern, MIN_DELAY 1h, 7d validity, single-pending guard. Clean.
- **lib/WETHFallbackLib.sol** — 10k stipend + WETH wrap fallback. Clean.
- **TegridyTokenURIReader.sol** — view-only metadata. Clean.
- **TegridyTWAP.sol** — 50% deviation cap, 15-min MIN_PERIOD, 2h staleness, 48-obs ring buffer. Strong oracle.
- **TegridyFeeHook.sol** — V4 hook, properly gated `onlyPoolManager`, fail-safe pause behavior, 24h timelock for sync. Clean.
- **POLAccumulator.sol** — 48h sweep timelock, locked LP, slippage protection. Strong on safety; bleeds on lack-of-harvest (M12).
- **TegridyRouter.sol** — Uniswap V2 fork with cycle detection, FoT variants, deadline cap. Clean.
- **VoteIncentives.sol** — strongest design in the protocol: commit-reveal, gauge votes, anti-arbitrage. Bribe fee 3% (under Aerodrome's 5% — see L8 silent killer).

---

## Updated priority list (after full pass)

Bug-fix batch (no scope debate, ship now):
1. **C1 token-fee→staker conversion** — biggest bleed
2. **C1-extended (was H1) referral split ordering** — same class
3. **C3 + H11 RevenueDistributor multi-NFT lock-state** — locks contract holders out
4. **C2 + H12 + M13 multi-NFT vote/boost amplification** — touch GaugeController, LPFarming, CommunityGrants
5. **C4 staker/POL WETH-fallback** — operational hardening
6. **H9 DropV2 refund-drain** — protect minters
7. **H10 SNAPSHOT_LOOKBACK guard** — one-line safety
8. **H13 Restaking bonus shortfall event** — observability
9. **M8 DropV2 platformFeeBps cap → 10%** — match launchpad
10. **M9 NFTPool changeFee timelock** — consistency
11. **M10 PremiumAccess cancel during pause** — UX bug
12. **M11 LPFarming forfeit-dust reclaim** — slow bleed plug
13. **L2 SwapFeeRouter recoverCallerCredit accounting** — same root as C1-extended

Economic-design batch (need user yes/no on each):
- **C5** lock-extend / autoMaxLock fee
- **C6** penalty → reward recycling
- **C7 + H14 + H5** origination fee + min APR + default penalty in Lending/NFTLending
- **M12** POLAccumulator harvest path
- **L7** TWAP update fee
- **L8** create-X deposit gating

Total: 13 bug-fix items + 5 economic-design items spread across all 27 contracts.
