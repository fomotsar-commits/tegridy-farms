# Staking — the look the operator asked for (2026-08-24)

*Operator flag: "staking needs a look at for sure." One read-only code audit
pass over the staking stack on `mvp-launch`, run 2026-08-24 alongside the
Jungle Bay bungalow work. Every claim was verified against code at file:line;
nothing below is repeated from docs without a code check. No files modified.*

**Bottom line:** the contract core is unusually well-audited and its known
economic quirk (perpetual rate vs. finite reserve) is handled with real
machinery — pool clamps, the IOU ledger, recovery-preserving debt accounting.
The sharpest live problems are on the **frontend boundary**: a stake flow that
promises a JBAC boost it never requests (§2.1), a depletion-day display that
regresses to a cumulative figure with nominal APR (§2.2), a guaranteed-revert
button (§2.3), and a claim receipt that can overstate payouts exactly when the
reserve matters (§2.5) — plus the standing 22-byte EIP-170 tripwire for anyone
who edits TegridyStaking.sol.

---

## 1. Architecture summary

**Core**: `contracts/src/TegridyStaking.sol` (2,792 lines) is a heavily
modified Synthetix-StakingRewards derivative with four deliberate departures:

- **No `periodFinish`, no notify-driven rate.** `rewardRate` is a standing
  owner parameter (48h timelock via sister, hard cap `MAX_REWARD_RATE = 1e18/s`,
  TegridyStaking.sol:349) emitting perpetually against whatever balance
  exists. Funding is decoupled (`notifyRewardAmount`, owner/notifier-gated,
  min 1,000 TOWELI — :2300-2312). This is the root of the reserve-runway
  topic (§6).
- **Positions are ERC-721s** (Solady ERC721, name `tsTOWELI` — :1827-1833)
  carrying `amount / boostedAmount / rewardDebt(int256) / lockEnd / boostBps`
  (struct in `lib/StakingViewLib.sol:20-32`). Boost is linear 0.4x→4.0x over
  7d→4y (`calculateBoost`, :753-760) plus a +0.5x JBAC bonus that requires
  **physical NFT deposit** via `stakeWithBoost` into
  `TegridyStakingJbacVault` (ApeCoin-staking pattern; plain `stake()`
  explicitly grants no JBAC boost — :995-998, 1011-1012).
- **Cliff decay + permissionless `kick`** (Curve `LiquidityGaugeV4.kick`
  pattern): expired locks are lazily zeroed (`_decayIfExpired` :739-746) and
  anyone can force it (:1625-1656).
- **A three-level IOU ledger** for rewards that couldn't be paid:
  `unsettledRewards[holder]`, `unsettledRewardsByTokenId[tokenId]`
  (aggregate), and `_unsettledByTokenIdHolder[tokenId][holder]` (the
  drainable entry — :291-329), maintained solely through
  `StakingRewardLib._creditByTokenId` (lib :278-287).

**EIP-170 satellite system** (the contract is 22 bytes under the limit —
§3.1): timelocked admin flows on `TegridyStakingAdmin.sol` (propose/execute/
cancel, all 48h, calling `onlyAdmin apply*` setters back on staking); heavy
views `earned`/`getPosition` on `StakingMonitorView.sol` (byte-identical
ABI); JBAC custody on `TegridyStakingJbacVault.sol`; live reward math in two
**delegatecall-linked libraries**, `lib/StakingRewardLib.sol` (900 lines —
accrual, getReward, kick, settle-on-transfer, unsettled claims, ERC721
bookkeeping) and `lib/StakingViewLib.sol` (voting power, earned, JBAC
revalidation).

**Reward feeds**: (a) TOWELI emissions from a one-time 6.4M seed (verified
§7.3); (b) an ETH lane that is wired but has never paid: native-route swap
fees → `SwapFeeRouter` sends 100% of fee ETH to `ReferralSplitter.recordFee`
at swap time (SwapFeeRouter.sol:707-714, 571-593); the ~80% non-referral
remainder returns only when someone calls `recoverCallerCredit()`
(:1826-1843) into `accumulatedETHFees`, which permissionless
`distributeFeesToStakers()` (:1355-1415) splits ≥50% (`stakerShareBps`,
propose-time floor :1344) to `RevenueDistributor` (deployed at `0xF993…3E17`,
holds 0). `ReferralSplitter` also reads staking `votingPowerOf` as a
referrer-eligibility gate (ReferralSplitter.sol:427-445, try/catch-guarded).

**Deployment state** (frontend/src/lib/constants.ts): staking `0xcaDc…046D`,
admin, monitor view, JBAC vault-era contracts live; **restaking = zero
address, deferred to Phase 7** (:23-24); **TegridyLending (staking-NFT
collateral) = zero** (:85); position market written but undeployed and
explicitly must never be lending-whitelisted (:160-168). So on the live
deployment the restaking/lending carve-outs are dormant code paths.

## 2. CONFIRMED defects (ranked)

### 2.1 HIGH — UI promises the +0.5x JBAC boost on a stake path that can never grant it
- FarmPage.tsx:120-122 adds `JBAC_BONUS_BPS` to the previewed boost when the
  wallet holds a JBAC; StakingCard.tsx:416-426 shows "Your Boost … Includes
  JBAC bonus +0.5x"; effective stake, voting power (:427-438) and Projected
  Earnings (:442-465) all include it; the stake receipt records the inflated
  figure (FarmPage.tsx:187, 209-221).
- But both submit paths call plain `stake(amount, lock)`:
  useFarmActions.ts:160-166 and the EIP-5792 batch in lib/stakeBatch.ts:26-32.
  `grep -rn stakeWithBoost frontend/src` → **zero hits**.
  `TegridyStaking.stake()` grants no JBAC boost (TegridyStaking.sol:1011-1012),
  and `revalidateBoost` can never upgrade a non-deposit position afterwards
  (:1694-1701).
- **Failure scenario**: a JBAC holder locks for 4 years expecting 4.5x,
  receives 4.0x on-chain, and the only exits are waiting out the lock or the
  25% penalty. The position card later shows the true boost, so the lie lives
  exactly in the window where the user decides.

### 2.2 HIGH — When the reserve runs dry, the Farm strip flips to a *cumulative* figure and keeps advertising nominal APR/emissions
- usePoolData.ts:44-46 computes the honest
  `rewardsRemaining = balanceOf − totalStaked − totalUnsettled` and runway.
  But FarmPage.tsx:135-138 renders `'–'` whenever that number is **0** — i.e.
  exactly when dry — and IncentivesStrip.tsx:58,70-74 then falls back to
  label **"Reward Pool"** with `stats.rewardPool` = **cumulative
  `totalRewardsFunded`** ("6,400,000 TOWELI", useFarmStats.ts:54). The runway
  sub-line silently disappears (`formatRunway` returns `''` for ≤0,
  IncentivesStrip.tsx:29-35,61) instead of reading 0.
- Meanwhile "Emissions APR" stays at the nominal
  `rewardRate·year/totalBoostedStake` (usePoolData.ts:56-66 — no dry-check)
  and "Daily Emissions" stays at `rewardRate·86400` (useFarmStats.ts:38,55),
  though actual accrual is clamped to zero (StakingRewardLib.sol:390-397).
- **Failure scenario (post ~2026-10-11)**: the strip reads "Emissions APR: N%
  · Reward Pool: 6,400,000 TOWELI · Daily Emissions: 71,220 / day" while real
  emission is 0. This directly contradicts the operator's 2026-08-23
  runway-downgrade rationale (docs/TODO_OPERATOR.md, commit `62d22acc`: "a
  dry pool reads as a real zero"). Two of that note's four verification legs
  are wrong: the strip does not show 0, and it cites a monitoring event that
  doesn't exist (§2.7). TokenomicsPage is only half-honest when dry: "Period
  ended" at :186, but `'–'` (not 0) at :229,237 and a still-nominal "Emission
  Rate / day" at :233.

### 2.3 MEDIUM — "Revalidate Boost" button renders only in the state where the tx always reverts
- StakingCard.tsx:118-125 renders the button when
  `pos.hasPosition && !pos.isLocked && pos.boostMultiplier > 1` — i.e. only
  on **expired** locks (`isLocked = lockEnd > now`, useUserPosition.ts:81;
  cached `boostBps` survives decay, so `boostMultiplier > 1` holds).
- `revalidateBoost` reverts `LockExpired()` on any expired position
  (TegridyStaking.sol:1691-1692, DS2-07 guard). On active locks — the only
  state where the call succeeds — the button never renders.
- **Failure scenario**: every click of this button costs gas and reverts. It
  can never succeed.

### 2.4 MEDIUM — Reward over-allocation: aggregate `earned()` can exceed the payable pool (accepted-by-design, but it is the load-bearing accounting fact)
- `accumulateRewards` clamps each tick's allocation to the *current* pool but
  never reserves what it already allocated: allocated-but-unclaimed rewards
  stay in `balanceOf` and are re-counted next tick (StakingRewardLib.sol:
  387-401). The contract's own comment calls under-funding "the routine state
  for this deployment, where … `accumulateRewards` re-allocates the same
  unclaimed tokens on every tick" (TegridyStaking.sol:2589-2597).
- Consequences, all verified in code: claims are first-come-first-served
  (`_creditGetReward` caps to pool, lib :493-497); losers get IOUs via
  `_settleUnsettled` capped by `maxUnsettledRewards` = 100,000e18
  (TegridyStaking.sol:333, lib :353-370); past the cap, non-expired positions
  "forfeit" but keep the claim alive because `rewardDebt` advances only by
  the credited slice (H-05, lib :565-569); expired positions and `kick`
  **bypass the cap entirely** (lib :549-558 and :790-810), so
  `totalUnsettledRewards` can grow unbounded in unbacked IOUs.
- **Failure scenario**: with claims lagging, promises grow at the full rate
  while the pool doesn't shrink; near depletion the displayed "Claimable" is
  honest per-position but not jointly satisfiable; a claim then pays partial,
  and a later refill must first cover the IOU backlog before live emission
  resumes (reserve formula counts `totalUnsettledRewards`, lib :391).

### 2.5 MEDIUM — Claim receipt reports the submit-time snapshot, not what was actually paid
- FarmPage.tsx:229-240 shows `rewardAmount: submittedAmountRef.current` (the
  pending figure at click time, StakingCard.tsx:225). Under a pool shortfall
  the on-chain transfer is `min(pending, pool)` (StakingRewardLib.sol:497-504)
  — possibly 0 — with the rest booked to unsettled.
- **Failure scenario**: pool dry, pending 500: user clicks Claim, tx
  succeeds, full-screen receipt says "claimed 500 TOWELI", wallet received 0.
  The unsettled line (StakingCard.tsx:230-240) later shows the IOU, but the
  receipt lied. (The claim button's own gate `pendingFormatted < 0.01` —
  StakingCard.tsx:226 — reads `earned()`, which does not check pool
  sufficiency for *this* claim against competing claims.)

### 2.6 LOW/MEDIUM — `tokenURI` returns `""` for every position; the deployed renderer is unwired [TOKENURI-UNWIRED]
- TegridyStaking.sol:1853-1855 returns `""`; the full byte-ledger of why the
  ~341B wire does not fit in the 22B of EIP-170 headroom, plus the prescribed
  extraction (move the inline admin-replacement timelock cluster out first),
  is at :653-699 and :2364-2391. `TegridyTokenURIReader` is deployed
  (constants.ts:90) with nothing pointing at it.
- **Failure scenario**: every tsTOWELI (a tradeable position potentially
  worth its locked principal) renders as an untitled blank on
  OpenSea/Blur/wallets, suppressing the secondary-market exit the NFT design
  exists to provide.

### 2.7 LOW — Stale copy and stale observability claims around auto-max-lock and kick
- BoostScheduleTable.tsx:106-109 still says "Disable anytime to let it expire
  naturally" — flagged as false in the contract's own natspec on 2026-08-12
  (TegridyStaking.sol:1140-1169: enabling writes a 4-year `lockEnd` that
  nothing ever shortens; every early exit costs 25%). The suggested
  replacement copy in the natspec was never landed.
- `RewardsForfeitedDuringKick` exists only in a stale comment
  (TegridyStaking.sol:1602) and in the operator runbook's monitoring plan
  (docs/TODO_OPERATOR.md:1103) — the event is neither declared nor emitted
  anywhere; post-[KICK-DoS] `kick` never forfeits at all (lib :758-810). A
  monitor built per that doc watches nothing.
- useUserPosition.ts:96-115: the live "Claimable" interpolator ticks at the
  nominal rate with no pool-dry clamp (checks pause but not
  `rewardsRemaining`), producing up to 45s (`MAX_ACCRUAL_DRIFT_SEC`, :15) of
  phantom accrual per 30s cycle once dry — a permanent tick-up-snap-back
  sawtooth, under a tooltip claiming it reproduces "the contract's own
  arithmetic exactly" (:38-39, 93).

## 3. Risks & unfinished work

1. **EIP-170: 22 bytes of headroom, verified current.** Ledger at
   TegridyStaking.sol:663-674 (24,554 B measured 2026-08-12); `git log
   --since=2026-08-20` shows **zero commits** touching TegridyStaking.sol,
   StakingRewardLib.sol, StakingViewLib.sol, TegridyStakingAdmin.sol, or
   TegridyStakingJbacVault.sol (last touches: 2026-08-12 / 08-08 / 05-30). CI
   hard-fails past 24,576 (`.github/workflows/contracts-ci.yml:181-292`,
   `FLOOR_EXCEPTIONS="TegridyStaking VoteIncentives"` :240). The funding
   extraction (admin-replacement cluster → sister) is designed in comments
   but unbuilt. Any one-line edit to this file risks an undeployable
   artifact; two prior getter-golfs bricked live callers
   (scripts/check-interface-selectors.mjs preamble).
2. **Reserve refill/rate-cut is slow by construction.** Refill =
   owner/notifier `notifyRewardAmount` (instant); rate cut = 48h timelock
   (`TegridyStakingAdmin.proposeRewardRate` :114-127). A cut that must land
   before depletion has to be proposed ≥48h ahead.
3. **Pause blocks IOU recovery.** `claimUnsettled`/`claimUnsettledFor`/
   `claimUnsettledForTokenId` and `kick` are all `whenNotPaused`
   (TegridyStaking.sol:1972, 1996, 2051, 1625); a kick moves a holder's
   rewards from directly-claimable to pause-blockable unsettled (documented,
   :1618-1624). Guardian (pause-only, cannot thaw; owner≠guardian enforced
   :972-980) can therefore freeze all reward recovery — accepted
   nuisance-pause risk per base/PauseGuardian.sol:1-45.
4. **The `applyLendingContract` carve-out is a skeleton key** — a whitelisted
   address (48h timelock, admin sister :230-256; apply at
   TegridyStaking.sol:2541-2553) is exempted from: the 24h transfer cooldown
   AND 1h rate limit on either side of a transfer (:1778-1785); the
   50-position holder cap (StakingRewardLib.sol:860-867); the
   `AlreadyHasPosition` single-position EOA guard on round-trips (lib
   :870-878); and the autoMaxLock reset on ownership change (lib :880-891).
   It gets `votingPowerOf = 0` (:790) and tracked-holder status (drain via
   `claimUnsettledForTokenId` only, barred from the plain paths — :1980,
   2012-2014). Revocation is guarded against strands (`PendingLendingPositions`
   :2543, `PendingLendingResidue` :2548). **Currently the whitelist is empty
   and `restakingContract` unset** (constants.ts:24, 85 — zero addresses).
   The deploy-notice that `TegridyPositionMarket` must never be whitelisted
   (constants.ts:163-167) is a standing operator trap.
5. **Restaking (`TegridyRestaking.sol`, 2,475 lines + admin + ERC-4626
   auto-compounder, last touched 2026-08-19) is finished code with no
   deployment** — Phase 7. Meanwhile TegridyStaking carries live special-case
   logic for it (rate-limit exemption :1779-1784, votingPowerOf carve-out,
   JBAC depositor resolution through `tokenIdToRestaker`), all currently dead
   paths — untestable in production until wired.
6. **The ETH yield lane is wired end-to-end but has never moved:** fee ETH
   sits as `callerCredit` at ReferralSplitter behind an uncalled
   permissionless `recoverCallerCredit()`; `RevenueDistributor.
   totalDistributed() == 0` (TOKENOMICS.md:47-52). Adjacent forward risk
   logged 2026-08-23 (`f8cff50a`, docs/TODO_OPERATOR.md:1115+): the **v2**
   StreamingRevenueDistributor can permissionlessly confiscate restakers' ETH
   (`_lockEndOf == 0` by construction for restakers; paid-to-attack via
   re-streaming), its fix branch is REFUTED, and v1's real exposure is
   `pendingETH` reading a fabricated 0 after unstake — mitigated in-app by
   the forfeit warning `pendingEthGuard` (useFarmActions.ts:169-180, applied
   to withdraw/earlyWithdraw/emergencyExit).
7. **Two retired staking deployments still hold user funds**
   (constants.ts:13-22: 1,000 + 100 TOWELI, verified on-chain 2026-07-22) —
   withdraw-only surface `LegacyStakingExit` renders for affected wallets
   only.
8. **Storage-layout coupling in tests is real but self-defended**:
   `POSITIONS_SLOT = 18` (test/FRESH2026_F3_StakingJbacRestakerLookup.t.sol:
   150) and `LEDGER_SLOT = 28` (test/invariants/StakingInvariants.t.sol:366)
   drive raw `vm.store`; StakingInvariants pins its slot with a staleness
   assertion (:611-627); the natspec mandates appending new storage last
   (TegridyStaking.sol:2364-2377).

## 4. Frontend honesty issues

The confirmed ones are §2.1, §2.2, §2.3, §2.5, §2.7. Additional notes:

- **Projected Earnings ignores runway on the Farm page**:
  StakingCard.tsx:442-465 projects 30/90/365-day earnings at the current APR
  with no clamp or warning, while the reserve dies in ~7 weeks — the 1-year
  figure is ~7-8x reality at current funding. DashboardPage has exactly the
  missing guard ("beyond ~Nd runway", DashboardPage.tsx:1111-1125), so this
  is an internal inconsistency, not an unknown pattern.
- **What is genuinely honest** (credit where verified): `rewardsRemaining`
  derivation matches the contract formula (usePoolData.ts:36-46); `earned`
  display is pool-capped on-chain (StakingViewLib.sol:176-184 mirrors the
  accrual clamp); APR division-by-zero is guarded (usePoolData.ts:56, 102
  test); wrong-chain reads are pinned (`chainId: CHAIN_ID` everywhere, R043
  H-062-02); tx success requires `receipt.status === 'success'`, reverted txs
  get an explicit "nothing was staked" toast (useFarmActions.ts:56-66,
  107-125); failed reads render "–" not zeros (useFarmStats.ts:26-31); the
  unsettled bucket is surfaced with its own claim button (StakingCard.tsx:
  230-240); stake form pre-blocks cap/min reverts with on-chain-read caps
  (StakingCard.tsx:73-94); the bootstrap-APR disclaimer exists
  (IncentivesStrip.tsx:43-49); RealYieldProof self-gates until the first real
  ETH distribution and distinguishes "read failed" from "zero"
  (RealYieldProof.tsx:47-49, 103-104); FAQ/knowledge copy states rewards come
  from the one-time 6.4M seed (FAQPage.tsx:41, towelieKnowledge.ts:45-47).
- **Price staleness**: farm surfaces use TOWELI price only for TVL-USD and
  fall back to TOWELI-only display on outage (useFarmStats.ts:43-50) — no
  staking action depends on price. Not a lie vector today.

## 5. Test coverage gaps

**Contracts — strong.** ~390 test functions across 26 staking-named suites
(TegridyStaking.t.sol: 84, Audit195_StakingGov: 96, Audit195_StakingCore: 50,
Audit195_StakingRewards: 38, RedTeam_Staking: 34,
MVPLaunch_StakeCapsAndGuardian: 27, FinalAudit_Staking: 24, plus dated
regression suites) and five invariant suites, including the C-1 attribution
triangle (`MVPLaunch_RewardTriangleInvariants.t.sol` — 256 runs × 500 calls)
and targeted regressions for the two 2026-08 fixes
(`KickForfeitDoS_2026_08.t.sol`, `StakingBoostResidual_2026_08_12.t.sol`,
`C1_L1_GetRewardShortfallAttribution.t.sol`). Under-funded-pool behavior IS
unit-tested (30+ files match shortfall/rewardPool patterns).

**e2e — thin on money paths.** `frontend/e2e/stake.spec.ts` (4 tests):
connect gate, render, input typing, and one Anvil leg that does approve→stake
and proves the position exists (:109-120) — but **claim and unstake are only
asserted as visible buttons** (:122-128; comments admit rewards may be 0 on a
fresh fork and cooldown may block). Nothing e2e covers: claim payout, unstake
round-trip, early-withdraw penalty math, unsettled claim, emergency exit,
extend/auto-max lock, pause states, dry-reserve rendering, or any JBAC path
(which cannot be tested — it isn't wired, §2.1).

**Frontend units — display-logic gaps.** usePoolData.test.ts covers APR
guards/formatting but never stubs the `balanceOf` leg to test
`rewardsRemaining`/`secondsRemaining` derivation or the dry state;
useUserPosition.test.ts covers basics but not the `pendingLive` interpolator
(no pool-dry clamp test — the missing clamp is §2.7); no test renders
IncentivesStrip in the dry state (only `feeShareLabel` is tested), so the
§2.2 fallback regression has no net under it. FarmPage.boostAndBatch.test.tsx
tests LP-boost staleness and batching, not the single-asset JBAC preview
(§2.1 has no failing test to catch it).

## 6. Reserve runway math as implemented

- **Reserve (one formula, five copies)**: `rewardPool =
  rewardToken.balanceOf(staking) − totalStaked − totalUnsettledRewards` —
  accrual StakingRewardLib.sol:390-396; getReward :493-497; claimUnsettled
  :131-135; transfer-settle :602-605; kick :712-715; view
  StakingViewLib.sol:148-150,182-184; frontend usePoolData.ts:44.
- **Emission per accrual tick**: `min(elapsed × rewardRate, rewardPool)`,
  only while `totalBoostedStake > 0` and not paused; **when the pool is empty
  the accrual silently emits nothing** — no event exists on the accrual path;
  shortfall events fire only at claim/transfer/kick time
  (`KickRewardPoolShortfall` lib :718, `TransferRewardPoolShortfall` :608,
  `RewardsForfeited` :560).
- **Deployed rate**: `REWARD_PER_SECOND = 0.8243e18`
  (contracts/script/DeployMVP.s.sol:46) ⇒ 71,219.5 TOWELI/day ⇒ the 6.4M
  seed is **89.9 emission-days** of allocation, funded 2026-06-07. The
  calendar dry date is later (~2026-10-11 per docs/TODO_OPERATOR.md:441,951)
  because `balanceOf` only falls on actual payouts — the pool depletes at the
  *claim* rate, while **promises** accrue at the full emission rate
  regardless (§2.4). Runway as displayed (`rewardsRemaining / rewardRate`,
  usePoolData.ts:46) is therefore an upper bound on solvent time, not on
  honest-APR time.
- **After dry**: accrual = 0 (silent); claims pay `min(pending, 0) = 0` and
  book IOUs — capped at `maxUnsettledRewards` (100k, TegridyStaking.sol:333)
  on polite paths, **uncapped** on expiry/kick paths (lib :549-558,
  :790-810). IOUs count into the reserve formula, so a refill must exceed
  `totalUnsettledRewards` before any live emission resumes. Caps on damage:
  `MAX_REWARD_RATE = 1e18/s` (:349), rate changes 48h-timelocked,
  `applyMaxUnsettledRewards` bounded 10k…1e10 (:2764-2769).

## 7. Known-context verification verdicts

1. **"Zero staker payouts have ever occurred"** — **VERIFIED for the ETH
   lane, and that is what the claim means**: TOKENOMICS.md:47-52,
   docs/TODO_OPERATOR.md:1171-1172 (RevenueDistributor holds 0, never
   received a distribution), RealYieldProof gates on `totalDistributed > 0`
   (RealYieldProof.tsx:29,55). TOWELI-emission claims by stakers are a
   separate lane the repo does not claim to be zero (claim buttons live, seed
   funded).
2. **"ETH swap-fee rewards turn on when a native pool goes live"** —
   **directionally true, imprecise in code terms.** There is no code flag
   gating on a pool; fees accrue only from native-route swaps, and fee ETH
   **has already been collected** — it is parked at ReferralSplitter as
   `callerCredit` behind two never-made permissionless calls
   (`recoverCallerCredit()` SwapFeeRouter.sol:1826-1843, then
   `distributeFeesToStakers()` :1355-1415). Frontend copy (FAQPage.tsx:41)
   compresses this to "when the native pool launches."
3. **"One-time 6.4M TOWELI seed funds current rewards"** — **VERIFIED**:
   on-chain funding event 2026-06-07, Dune Q4 validated at exactly 6,400,000
   (docs/DUNE_QUERIES.md:13,190); surfaced as cumulative `totalRewardsFunded`;
   frontend copy consistent (towelieKnowledge.ts:45-47, ChangelogPage.tsx:296).
4. **"~22 bytes of EIP-170 headroom, measured 2026-08-21; any commits
   since?"** — **VERIFIED, and no commits since touched it**: ledger 24,554 B
   / 22 B headroom (TegridyStaking.sol:663-674); zero commits after
   2026-08-20 on any staking .sol file; CI hard gate active
   (contracts-ci.yml:181,240).
5. **"Reserve runs out ~2026-10-11"** — plausible operator estimate,
   **behavior-dependent** (§6); the failure mode at that date is as analyzed
   in §2.2/§2.4, and the operator's 2026-08-23 "the app already shows this
   honestly" downgrade is **partially refuted by code** (the strip's
   dry-state fallback and nominal APR/emissions chips, plus the nonexistent
   monitoring event).

## 8. Recommended fix order (all agent-buildable except where noted)

1. **§2.1 JBAC boost** — either wire `stakeWithBoost` (NFT approval + vault
   deposit flow in the stake form) or stop previewing the +0.5x on the plain
   path. The second is a one-file honesty fix and can ship first.
2. **§2.2 + §2.7 dry-state honesty** — clamp the strip, APR, daily emissions
   and the live interpolator to the `rewardsRemaining` read; delete the
   cumulative fallback; land the natspec's replacement auto-max-lock copy;
   add the missing IncentivesStrip dry-state test.
3. **§2.3** — fix the render condition (show on active locks, hide on
   expired) or drop the button.
4. **§2.5** — read the claim receipt amount from the tx logs
   (`RewardPaid`-equivalent event) instead of the submit-time snapshot.
5. **§2.6 tokenURI** — blocked on the EIP-170 extraction (operator-adjacent:
   a redeploy ceremony); keep frozen until that is scheduled.
6. **Reserve decision (operator)** — refill amount/date or a rate cut
   proposed ≥48h ahead of dry; and the two permissionless ETH-lane calls
   (`recoverCallerCredit`, `distributeFeesToStakers`) that would produce the
   first real staker payout ever.
