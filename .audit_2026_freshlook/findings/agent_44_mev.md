# Agent 44/100 — MEV / Front-Running / Sandwich Audit

**Lens:** Front-running, sandwich, MEV vectors across all `contracts/src/*.sol`.
**Mandate:** No edits, no audit-history `.md` reads. Fresh eyes only.
**Date:** 2026-05-07
**Total LOC reviewed:** 27,551 across 30 contracts (excluding subdirs base/, lib/).

---

## Executive Summary

The protocol has been hardened against virtually every MEV vector I checked by
prior audit waves. Each surface I targeted carries explicit, named mitigations
referencing earlier batch-letter fixes (BATCH-N3, R014, R016, BATCH-L3, etc.):

- All swap entry points (`SwapFeeRouter`, `TegridyRouter`, `TegridyFeeHook`) take
  user-supplied `amountOutMin` AND `deadline`; the protocol-internal swap helpers
  (`POLAccumulator.accumulate`, `SwapFeeRouter.convertTokenFeesToETH`) are
  additionally TWAP-floor-anchored so the user's `minOut` only TIGHTENS the
  attacker-independent floor. `MIN_MULTIHOP_ETH_OUT_WEI = 1e14` floors caller-
  supplied minOut for owner-only multi-hop.
- All snapshots use `block.timestamp - SNAPSHOT_LOOKBACK` (1h) or `block.timestamp - 1`
  with `min(historical, current)` clamps to defeat flash-stake-then-snapshot.
- `VoteIncentives` ships commit-reveal active by default (`commitRevealEnabled = true`),
  closing the see-bribes-then-vote arbitrage that is the canonical MEV vector
  for this contract category. Bribe deposits are gated by `epochBribesFinalized`
  so a same-block deposit+advance+vote sequence cannot retroactively credit
  voters with a just-deposited pool.
- `GaugeController` likewise has commit-reveal voting; per-vote per-gauge cap of
  50% (`MAX_WEIGHT_PER_GAUGE_BPS = 5000`) prevents whale-flywheel concentration.
- TWAP (`TegridyTWAP`) bootstrap+dormancy-bypass observations are flagged; any
  `consult` whose lookup window contains a bypassed observation reverts
  `OracleRebootstrapping`. First-observation manipulation is closed via the
  FRESH-EYES H-3 self-mark-bypass logic.
- Liquidations (`TegridyLending.claimDefaultedCollateral`,
  `TegridyNFTLending.claimDefault`) include sequencer-outage buffer extensions
  symmetric on both repay and claim sides — borrower's repay window is not
  consumed by an L2 outage, lender's claim is not bypassed before grace expires.
- `TegridyPair.harvest()` (permissionless mint-fee materialisation — the most
  obvious MEV target on a V2 fork) has a 5-minute cadence gate AND a
  feeToSetter-only bootstrap branch that prevents a flash-loan-set kLast.
- `RevenueDistributor.distribute*()` is permissionless but rate-limited to 4h
  and stake-gated by `MIN_DISTRIBUTE_STAKE = 1000e18` — closing the
  kick-then-distribute concentration attack.

**Net outcome:** I did not find a freshly exploitable MEV, sandwich, or front-running
vector. All findings below are LOW or INFO-level observations of residual
surface that the protocol has explicitly accepted as bounded by economic /
operational constraints. They are documented for completeness, not as
remediation candidates.

---

## F-44-1 — Permissionless `RevenueDistributor.distributePermissionless` ordering

**Severity:** INFO (residual surface, accepted by design)
**File:** `contracts/src/RevenueDistributor.sol:346-357`
**Function:** `distributePermissionless()`
**MEV vector:** Race-to-trigger, NOT bribe-arbitrage.

The function lets anyone call it once new ETH lands in the contract (balance
> reserved). A caller earning rewards under the soon-to-be-snapshotted epoch
has economic incentive to trigger immediately — but they cannot retroactively
benefit because:
- `snapshotTime = block.timestamp - 1` — the caller's own staking checkpoint
  written in the same block is excluded by upperLookup(T-1).
- `MIN_DISTRIBUTE_STAKE = 1000e18` blocks low-stake racing.
- `MIN_DISTRIBUTE_INTERVAL = 4h` blocks epoch-splitting griefing.
- `MIN_DISTRIBUTE_AMOUNT = 1 ether` blocks dust-spam epochs.

**Tx sequence the attacker would attempt:**
1. Stake at block N.
2. In block N+1, see the SwapFeeRouter forward ETH (or any inflow that pushes
   `balance > reserved`). Frontrun other stakers' `distributePermissionless`
   calls — but their checkpoint must already be at ≤ T-1, same as yours.
**Profit:** Zero — denominator is taken at T-1, attacker's stake at T is excluded.

**Status:** Bounded; no remediation needed.

---

## F-44-2 — `VoteIncentives.advanceEpoch` permissionless trigger

**Severity:** INFO (residual surface)
**File:** `contracts/src/VoteIncentives.sol:528-570`
**Function:** `advanceEpoch()`

The epoch-advance is permissionless. A briber can frontrun an honest keeper to
finalize the bribe ledger at a time of their choosing. Mitigations already in
place:
- `MIN_EPOCH_INTERVAL = 7 days` — cannot be re-spammed.
- `SNAPSHOT_LOOKBACK = 1 hours` — flash-stake at T cannot grow VP at T-1.
- `epochBribesFinalized[newEpoch]` flips atomically — bribers cannot make a
  same-block deposit-then-advance-then-vote arbitrage land voters in their
  pool.
- `commitRevealEnabled = true` by default — voters reveal AFTER the
  bribe ledger is finalized AND after `commitDeadline` (40% of 7d = 2.8d
  into the epoch).

**Profit estimate:** Zero in commit-reveal mode (voters cannot see bribe pool
when committing). In legacy `vote()` epochs (pre-flag-flip) the attacker
could see-bribes-then-vote — but `commitRevealEnabled` defaults to true at
deploy.

**Status:** Bounded by commit-reveal default + 7-day cadence.

---

## F-44-3 — `TegridyPair.harvest()` permissionless 5-minute cadence

**Severity:** INFO (residual surface, structurally bounded)
**File:** `contracts/src/TegridyPair.sol:340-416`
**Function:** `harvest()`

The 1/6-of-fee protocol-LP mint is exposed to permissionless triggering with
a 5-minute cadence. A searcher could theoretically sandwich the harvest tx to
capture dilution from the freshly-minted protocol LP — but:
- Per the protocol's own NatSpec (line 326-338): MEV upside is bounded by
  protocol fee = 1/6 × 0.3% ≈ 0.05% of swap volume. Per-call extractable value
  is in the range of a few wei to a few cents on hot pairs.
- `HARVEST_INTERVAL = 5 minutes` caps at ~12 calls/hour.
- The bootstrap path (where `kLast == 0`) is gated to `feeToSetter` so an
  attacker cannot anchor `kLast` at flash-loan-manipulated reserves.

**Tx sequence:**
1. Sandwich front: large swap on the pair to inflate K.
2. Call `harvest()` → protocol LP minted at the inflated post-front state.
3. Sandwich back: reverse swap.
4. As an LP, you've kept the LP value but the protocol's freshly-minted slice
   was issued at a temporarily-inflated K, slightly overpaying the protocol
   relative to honest harvest cadence. Net to attacker: ~0 (you pay the
   sandwich gas + own price impact, capture only your LP-share of the dilution
   the protocol just took).

**Profit estimate:** Negative on any realistic block-space market. The protocol
explicitly acknowledged this trade-off at line 326-338.

**Status:** Bounded by structural fee economics; no remediation possible
without breaking the permissionless invariant.

---

## F-44-4 — `TegridyTWAP.update(pair)` permissionless observation cadence

**Severity:** INFO (residual surface, multi-layered defense)
**File:** `contracts/src/TegridyTWAP.sol:266-455`
**Function:** `update(address pair)`

Permissionless updates with `MIN_PERIOD = 15 minutes` cadence. An attacker
could time an `update()` call at the worst moment for downstream consumers
(POL accumulator, lending oracle), but cannot poison the cumulative because:
- `MAX_DEVIATION_BPS = 5000` (50%) gate rejects a single-tx >50% spot move.
- `lastSpot{0,1}` per-pair tracking enforces the gate from observation #2.
- Self-bootstrap grace: observations 1-3 are flagged `bypassed = true` and
  `consult()` refuses to serve any window that includes a bypassed
  observation (`OracleRebootstrapping`).
- Pair-disabled state (`factory.disabledPairs(pair)`) gates BOTH `update` AND
  `consult`.
- `minReserveFloor[pair]` per-pair owner-set TVL floor blocks updates on
  thin-liquidity pairs that are single-trader-manipulable inside the ±50%
  envelope.
- `setMinReserveFloor` itself is `onlyOwner` (line 144).

**Tx sequence (best-case attacker):**
1. Flash-loan-pump pair within ±50% spot deviation.
2. Call `update()` to lock manipulated sample into the cumulative.
3. Consumer reads TWAP — but the cumulative is averaged over MIN_PERIOD,
   so a single observation only contributes its share of the TWAP_PERIOD
   window proportional to elapsed-time-since-prior-observation. The
   manipulation is amortized.

**Profit:** Bounded by the deviation-gate ceiling + TWAP smoothing. For a
60-minute TWAP_PERIOD with one manipulated observation 15 minutes after a
clean one, manipulated contribution ≈ 15/60 = 25% of the TWAP. Combined with
50% deviation cap, max TWAP shift ≈ 12.5%. Cost to flash-loan + manipulate +
unwind on a deep enough pair to satisfy `minReserveFloor` is typically
higher than 12.5% × position-size on the consumer side.

**Status:** Bounded by deviation gate, bypass cooldown, reserve floor, and
TWAP smoothing math. No fresh issue.

---

## F-44-5 — `TegridyDropV2.mint()` Dutch auction price decay timing

**Severity:** INFO (canonical Dutch auction property)
**File:** `contracts/src/TegridyDropV2.sol:496-584`
**Function:** `mint(quantity, allowedAmount, proof)` in DUTCH_AUCTION phase

By design, the price drops linearly from `dutchStartPrice` to `dutchEndPrice`
over `dutchDuration`. Searchers race to mint just below their target price.
This is not a bug — every Dutch auction has it. The protocol's mitigations:
- `mint()` reads `_dutchAuctionPrice()` directly, applying
  `SequencerCheck.checkSequencerUp` at mint time so a buyer cannot wait out
  an L2 outage and snipe the resumed cheapest price (V2-DROP-05 fix at
  `currentPrice` returns `type(uint256).max` sentinel during outages).
- `MAX_MINT_PER_TX = 50` caps single-tx capture.
- `maxPerWallet` cap prevents a sniper from monopolising via a single account.
- `paidPerWallet[msg.sender] += totalCost` and refund-on-overpayment via
  WETH fallback.

**Tx sequence:**
1. Watch mempool for buyer's mint at price P. Submit higher gas-priority mint
   at price P_now < P. Receive token before victim's mint lands.

**Profit:** = (P_victim - P_now) × quantity. Capped by MAX_MINT_PER_TX × decay
slope per block.

**Status:** Inherent to Dutch auctions; no remediation possible without
changing the sale mechanism (e.g., to fixed-price + allowlist or commit-
reveal mint).

---

## F-44-6 — `TegridyNFTPool.swapETHForNFTs` linear-curve sandwich

**Severity:** INFO (bounded by curve linearity)
**File:** `contracts/src/TegridyNFTPool.sol:257-324`
**Function:** `swapETHForNFTs(tokenIds, maxTotalCost, deadline)`

The bonding curve is linear: `spotPrice += delta * numItems` per buy. A
sandwicher can frontrun a buy with their own buy (driving spot up), then
immediately sell back. Mitigations:
- `maxTotalCost` parameter — buyer-supplied slippage protection.
- `if (block.timestamp == lastWithdrawBlock) revert WithdrawalLandedThisBlock`
  — gates same-block sandwich-around-withdraw flows.
- `_swapInFlight` flag prevents re-entrancy through ERC721 hooks.
- Linear delta means sandwich profitability decays with `numItems`; a 1-item
  sandwich barely covers gas.

**Tx sequence:**
1. Mempool sees buy(N items) with `maxTotalCost = X`.
2. Front: buy(1 item) → spot += delta. Cost = current_spot.
3. Victim's tx: buys N items at higher spot. Pays slightly more.
4. Back: sell(1 item) → receives current spot - lpFee. Net to attacker:
   `delta - 2*lpFee - 2*protocolFee - gas`.

**Profit:** Tiny per-trade; only viable on high-volume collections with
`delta` >> total fees.

**Status:** Bounded by curve type + per-trade fees. Buyer's `maxTotalCost`
is the primary defense and is mandatory.

---

## F-44-7 — `TegridyStaking.notifyRewardAmount` rate-shift timing

**Severity:** INFO (operational, not exploitable on its own)
**File:** `contracts/src/TegridyStaking.sol:1854-1866`
**Function:** `notifyRewardAmount(uint256 _amount)`

When a notifier (owner or whitelisted) calls `notifyRewardAmount`, the call
runs the `updateReward` modifier — which advances `rewardPerTokenStored` to
`block.timestamp` BEFORE the new funds bump `available`. So a notifier
cannot back-run their own funding to claim a fatter reward against
elapsed-but-not-yet-credited time (per audit DEEP-DS-08). However, an
external observer could:
1. Watch the mempool for a `notifyRewardAmount` call.
2. Stake immediately before it lands.
3. Call `getReward` after — earning rewards against the just-funded pool
   from the moment they staked.

This is the canonical Synthetix `notifyRewardAmount` MEV pattern. Mitigations:
- `MIN_NOTIFY_AMOUNT` floor blocks dust funding spam.
- `rewardNotifiers[msg.sender]` allowlist + owner gate restricts who can call.
- Rate is per-second emission, so frontrunner only earns from the moment they
  stake — they don't capture historical accrual.
- The `kick()` function exists to forcibly decay expired positions, leveling
  the playing field.

**Tx sequence:**
1. Mempool: large `notifyRewardAmount(1000 TOWELI)` from owner.
2. Front: `stake(X TOWELI, max_lock)` for max boost.
3. Wait for the notify, harvest over time.

**Profit:** Frontrunner earns proportional share of the new emission stream,
same as any honest staker who happens to stake at the same time. NOT a
free profit — they're now exposed to the lock duration.

**Status:** This is "rational behavior" not exploit. Honest stakers have the
same access to mempool data.

---

## F-44-8 — `SwapFeeRouter.convertTokenFeesToETH` MEV-protected via TWAP floor

**Severity:** INFO (defense-in-depth verified)
**File:** `contracts/src/SwapFeeRouter.sol:1510-1623`
**Function:** `convertTokenFeesToETH(token, path, minETHOut, deadline)`

This is the most attractive sandwich target on the protocol because it converts
accumulated fees into ETH on a publicly-callable path. Defenses verified:
- `_enforceConversionCooldown(token)` — 1 hour cooldown per token blocks the
  serial-sandwich pattern.
- `_enforceTWAPMinETHOut` for direct (length=2) paths — the actual `minOut`
  forwarded to the inner Uniswap router is `max(callerMinETHOut, twapMinETHOut)`.
  The TWAP floor is attacker-independent.
- `MIN_MULTIHOP_ETH_OUT_WEI = 1e14` floors caller-supplied `minETHOut` for
  owner-only multi-hop paths (no on-chain TWAP anchor available).
- `MIN_TOKEN_FEE_FOR_CONVERSION = 1e18` blocks dust-cooldown-griefing.
- `MAX_DEADLINE` cap plus explicit `deadline < block.timestamp` lower-bound.
- Multi-hop is gated on `msg.sender == owner()`.
- CEI: `accumulatedTokenFees[token] = 0` BEFORE the swap.
- HIGH-4 fix: multi-hop branches invalidate stale snapshots so the next
  direct 2-hop call re-bootstraps under owner control.

**Cannot be sandwiched** under current constraints unless either (a) attacker
has owner key (out of scope) or (b) attacker convinces a frontend bot to pass
a `minETHOut < twapMinETHOut` (the contract clamps to twapMinETHOut anyway).

**Status:** Verified hardened.

---

## F-44-9 — `POLAccumulator.accumulate` is owner-gated; sandwich impossible

**Severity:** INFO (verified)
**File:** `contracts/src/POLAccumulator.sol:400-483`
**Function:** `accumulate(_minTokens, _minLPTokens, _minLPETH, _deadline)`

The function is `onlyOwner`, so a public sandwicher cannot trigger it. If an
operator key were compromised:
- TWAP-derived swap floor (`internalSwapMinOut = twap.consult(weth → toweli, halfETH)`)
  is the source of truth; caller `_minTokens` only TIGHTENS.
- TWAP-derived LP-add token min anchored on TWAP-implied 50/50 ratio (not
  post-swap attacked spot — DEEP-DR-M-08 fix).
- `SequencerCheck.checkSequencerUp(sequencerFeed, SEQUENCER_GRACE_PERIOD, 4 hours)`
  gates against L2-outage replay.
- `ACCUMULATE_COOLDOWN` per call.
- `MAX_DEADLINE` cap.

**Status:** Verified hardened. Captured-key risk is bounded by TWAP staleness
+ deviation gate.

---

## F-44-10 — `CommunityGrants` execute-after-approval timelock predictability

**Severity:** INFO (canonical timelock property; no exploit found)
**File:** `contracts/src/CommunityGrants.sol:564-633`
**Function:** `executeProposal(uint256 _proposalId)`

The execution time is `proposal.deadline + EXECUTION_DELAY` (or
+`PERMISSIONLESS_EXECUTION_DELAY` for non-owner callers) — fully predictable
from on-chain state. This is canonical Compound Bravo / OZ TimelockController
behavior. A would-be frontrunner cannot benefit because:
- Proposals execute a treasury ETH transfer to a fixed `recipient` recorded
  at creation time.
- The recipient cannot change between approval and execution.
- The amount cannot change.
- The rolling 30-day cap (`MAX_ROLLING_DISBURSEMENT_BPS`) checks AT execute
  time against `rollingCapBalanceAtFinalize` (snapshot at approval — DEEP-CG-M1
  fix), so a balance drop between approval and execute does not let an
  attacker void the proposal mid-flight.

**Tx sequence (would-be exploiter):**
1. See approved proposal P with `deadline + EXECUTION_DELAY = T_exec`.
2. At T_exec - 1s, submit a different transaction that drops the balance.
3. Hope `executeProposal(P)` reverts.
**Result:** Reverts on `InsufficientFunds`, but DEEP-CG-M1 already snapshots
the cap denominator at finalize, so the rolling cap was satisfied. No drift.

**Status:** Verified hardened. Predictable execution time is a feature, not
a bug — by design, voters can see the queue and react during the delay.

---

## F-44-11 — `TegridyLending.acceptOffer` stale-quote race

**Severity:** INFO (residual; depends on borrower's tx ordering)
**File:** `contracts/src/TegridyLending.sol` (acceptOffer flow ~L900s)
**Function:** Borrower's `acceptOffer`

When a borrower accepts a lending offer, the position's ETH-equivalent value
is computed via `_positionETHValue(toweliAmount)` which calls
`twap.consult(...)` over `TWAP_PERIOD = 30 minutes`. A lender could
theoretically frontrun the acceptance with an `update()` on the TWAP and a
small swap to nudge the average up — but:
- `MAX_DEVIATION_BPS = 5000` ceiling.
- `TWAP_MAX_STALENESS = 2 hours` at the consult side.
- `lastBypassUsed[pair]` + `TWAP_PERIOD * 2 = 60min` cooldown.
- The lender's offer already committed their max principal/APR/duration.
  Inflating the position's value via TWAP shifts the LTV ratio in the
  borrower's favor (more borrowing capacity), not the lender's. So the
  expected attacker is the BORROWER, not the lender.

**Tx sequence (borrower trying to inflate ETH-floor):**
1. Mint or pull a small LP at high spot to push pair reserves.
2. Call `twap.update(pair)`.
3. Call `acceptOffer` — get a higher principal allowance.
**Result:** Deviation gate blocks anything > 50% spot move. TWAP averages
over 30 min, so a single 50% pump contributes ≤ 25% TWAP shift assuming
prior observation was clean. Combined with `MIN_PERIOD = 15 minutes`
between updates, attacker cannot stack multiple manipulated observations
quickly. Plus the per-pair `minReserveFloor` rejects updates on thin pairs.

**Profit estimate:** On a deep pair, the cost to flash-loan-pump 50% exceeds
the LTV gain. On a thin pair, `minReserveFloor` blocks the attempt.

**Status:** Bounded by TWAP smoothing + deviation gate + reserve floor.

---

## F-44-12 — `MemeBountyBoard.completeBounty` predictable settlement window

**Severity:** INFO (designed visibility)
**File:** `contracts/src/MemeBountyBoard.sol:566-584+`
**Function:** `completeBounty(uint256 _bountyId)`

Settlement is callable after `deadline + DISPUTE_PERIOD` by the creator, or
after additionally `+ GRACE_PERIOD` by anyone. Top-submission selection is
already finalized via the `topSubmissionVotes` cache + 24h `TOP_FREEZE_WINDOW`.
A late-flipping attacker cannot displace an established leader during freeze
unless they themselves cross `MIN_COMPLETION_VOTES` (V2-GOV-08 fix, line
540). The remaining residual surface — predictable settlement timing — is a
feature: it gives the disputed window for off-chain dispute resolution.

**Status:** Designed property; no remediation possible.

---

## F-44-13 — `TegridyRestaking.fundBonus` doesn't affect `accBonusPerShare`

**Severity:** INFO (verified)
**File:** `contracts/src/TegridyRestaking.sol:1309-1314`
**Function:** `fundBonus(uint256 _amount)`

I checked whether `fundBonus` could be sandwiched — it cannot. The function
just transfers tokens in and increments `totalBonusFunded`; bonus accrual is
rate-based via the `updateBonus` modifier (not balance-derived). A restaker
cannot mint/restake right before a `fundBonus` to capture historical
accrual because:
- New restaker's `bonusDebt = boostedAmount * accBonusPerShare / ACC_PRECISION`
  is anchored at deposit time.
- They can only earn the delta from `accBonusPerShare(deposit) →
  accBonusPerShare(claim)`.
- `fundBonus` does NOT advance `accBonusPerShare`; only the time-based
  `updateBonus` modifier does, and it's gated by the `bonusRewardToken.balanceOf`
  check.

If `bonusRewardPerSecond` is updated (timelocked path), the change applies
prospectively; pre-update emission is already crystallized into
`accBonusPerShare`.

**Status:** Verified — no MEV vector via fund/restake interplay.

---

## F-44-14 — `GaugeController.commitVote` cancellation timing window

**Severity:** INFO (already addressed by R014-HIGH per-user-active-commit guard)
**File:** `contracts/src/GaugeController.sol:457-514`

Multi-NFT holders cannot commit with NFT-A, observe vote distribution / bribe
markets, then commit with NFT-B and abandon NFT-A — the
`userActiveCommit[msg.sender][epoch]` check at line 481 forbids it. Cancel is
only allowed inside the commit window (`block.timestamp + REVEAL_GRACE <
revealOpens`), so a voter cannot use post-reveal-window observation to retract.

**Status:** Verified hardened. No fresh exploit.

---

## F-44-15 — `PremiumAccess.subscribe` fee-change frontrun

**Severity:** INFO (mitigation verified)
**File:** `contracts/src/PremiumAccess.sol:245-372`

A user could see a `proposeFeeChange`-then-`executeFeeChange` cycle in the
mempool and try to subscribe at the OLD rate before execution. The contract
defends via:
- `maxCost` parameter (M-11 fix, line 256) — caller-supplied upper bound on
  total cost.
- 24h timelock means users have a full day to subscribe at the old rate
  legitimately.
- `MIN_HOLDING_PERIOD` (DEEP-DR-L-05 fix, line 270) blocks rate-lock arbitrage
  via subscribe + immediate extend + cancel pattern.

**Status:** Verified hardened.

---

## F-44-16 — `TegridyDropV2.mint` allowlist-amount-baked-into-leaf

**Severity:** INFO (canonical fix verified)
**File:** `contracts/src/TegridyDropV2.sol:530-549`

A would-be exploiter cannot reuse an old proof against a `setMaxPerWallet`
bump — `allowedAmount` is part of the Merkle leaf
(`keccak256(abi.encode(address(this), msg.sender, allowedAmount))`),
double-hashed per OZ pattern. Off-chain tree construction enforces this.

**Status:** Verified hardened.

---

## F-44-17 — `TegridyTWAP` first-observation-after-pair-creation manipulation

**Severity:** INFO (FRESH-EYES H-3 fix verified)
**File:** `contracts/src/TegridyTWAP.sol:332-354`

The first observation on a pair is auto-flagged `bypassed = true` at line 352,
and `consult()` rejects any TWAP whose lookup window contains a bypassed
observation (`OracleRebootstrapping` revert, line 533). Subsequent observations
2 and 3 are also auto-bypassed (line 388 — BATCH-M3 H7 fix) to allow self-
correction from a bad bootstrap.

**Status:** Verified — closes the canonical "create pool at 1:100, fund
asymmetrically, lock manipulated baseline" attack.

---

## Notes / Dead Ends

### Checked, no finding
- **NFT pool factory `getBestBuyPool` / `getBestSellPool`** — view-only, no MEV.
- **`Toweli`** — fixed-supply ERC20, no admin surface, no MEV.
- **`TegridyLaunchpadV2`** — deployment factory only, no mutation paths affecting
  pricing.
- **`TegridyStaking.kick`** — confirmed permissionless poke, but kick + distribute
  attack is closed by `MIN_DISTRIBUTE_STAKE = 1000e18` guard on
  `distribute()` AND `distributePermissionless()` (PASS5-REV-H1 fix).
- **`TegridyLending.repayLoan`** — sequencer-outage buffer extends BOTH borrower
  AND lender symmetrically (DEEP-LD2-H1 fix); cannot be timed.
- **`TegridyNFTLending.claimDefault`** — same outage-buffer treatment.
- **`TegridyFeeHook.convertERC20FeesToETH`** — owner-only, 1e14 minETHOut floor,
  sync-pending lockout. No MEV.
- **`TegridyLPFarming.notifyRewardAmount`** — owner-only, timelocked rewards-
  duration changes (REWARDS_DURATION_TIMELOCK = 24h). No MEV.
- **`TegridyRestaking.unrestake`** — checked; bonusDebt anchored CEI-style
  before transfer, no rewards-leakage MEV.
- **`SwapFeeRouter.swapExact*`** — every variant has `amountOutMin`, `deadline`,
  `MAX_DEADLINE` caps, `_validateNoDuplicates` on path, `path[0]` and
  `path[length-1]` shape checks for ETH paths.
- **`TegridyRouter.swap*`** — pure Uniswap V2 router shape; user supplies
  `amountOutMin` and `deadline`. No protocol-internal MEV vectors.

### Tangential observations (NOT MEV per se)
- The protocol's overall hardening posture is clearly the result of many audit
  passes; almost every state-changing path I checked carries explicit
  attribution (BATCH-X, PASS-Y, DEEP-Z, FRESH-EYES, MICROSCOPE) for prior
  fixes. This makes a fresh-eyes MEV finding unlikely without deep behavior
  fuzzing.
- The commit-reveal mode being default-on (`commitRevealEnabled = true`) is
  the single largest de-MEV improvement — without it, the legacy `vote()`
  path is the canonical see-bribes-then-vote arbitrage primitive that
  Hidden Hand v1 / classic Curve gauge bribery exposed.

---

## Conclusion

No exploitable MEV / front-running / sandwich finding above LOW severity. All
17 surfaces examined are bounded by explicit, named mitigations with prior
audit attribution. The protocol's MEV posture is materially stronger than a
typical V2-fork DEX or gauge-bribe system.

**Recommended action:** None for code. If considering future hardening, the
only direction with marginal value would be:
1. Migrate `TegridyDropV2` Dutch auction to a commit-reveal mint (eliminates
   F-44-5 by design — but disrupts standard NFT mint UX).
2. Add an explicit per-pair `lastBypassUsed` cooldown UI / dashboard so
   integrators can monitor TWAP rebootstrap windows in real time.

Neither is necessary for safety.
