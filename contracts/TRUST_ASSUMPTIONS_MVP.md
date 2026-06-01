# MVP Trust Assumptions

One-page-per-contract list of what each MVP contract assumes about its callers,
oracles, owner, tokens, and L1/L2 environment. Auditors ask this on day one —
this doc saves a billable week per firm engagement.

Scope: the 15 MVP contracts on the `mvp-launch` branch. Lending / NFTLending /
Gauges / VoteIncentives / Drop / Launchpad / FeeHook / LPFarming /
CommunityGrants / MemeBountyBoard / PremiumAccess are out of scope for this
release; their trust models will be re-documented in next-wave releases.

Authoritative as of branch `mvp-launch`. Drift check: `git log src/`
since the last update of this file should produce zero entries before audit
freeze.

---

## Toweli (ERC20)

- **Standard**: OpenZeppelin ERC20 + ERC20Permit. No transfer hooks, no fee on
  transfer, no rebasing. Decimals = 18.
- **Owner**: none — token is ownerless / pauseless post-deploy by design.
  Supply is fixed at constructor. No mint authority.
- **Trust model**: pure ERC20; every consumer assumes standard ERC20 semantics
  (return-true on success, revert on failure). No callbacks.
- **Threats out-of-scope**: ERC20 transfer-callback class (ERC-777, ERC-1363) —
  this token does not have callbacks; the AMM and staking contracts depend on
  that absence.

## TegridyFactory

- **Owner**: deployer EOA at deploy → transferred to MULTISIG via Ownable2Step
  during deploy. Owner manages `feeToSetter`, pair-disabling, and guardian
  rotation (separate from PAUSE_GUARDIAN). Two-step propose/execute with 48h
  timelock for feeTo changes.
- **Trust**: callers of `createPair` are NOT trusted. Pair creation is
  permissionless. Disabled pairs are tracked via `disabledPairs` and respected
  by TegridyRouter / TegridyTWAP / VoteIncentives (last is deferred).
- **Oracle**: none. Factory does not read prices.

## TegridyPair

- **Standard**: Uniswap V2 fork, adapted for Solidity 0.8.26. Constant product
  k = reserve0 × reserve1, 0.3% fee on swap (5/6 to LPs, 1/6 to feeTo).
- **Trust**: assumes tokens are standard ERC-20 with no transfer callbacks.
  ERC-777 and fee-on-transfer tokens are explicitly NOT supported.
  Documented in source.
- **Reentrancy**: `nonReentrant` on swap/mint/burn. Defense-in-depth only —
  transfer callbacks could re-enter sister pairs or router; whitelisting is
  the structural mitigation (factory.createPair is permissionless but
  governance disables pairs created against non-whitelisted tokens).
- **Block timestamp**: `_update` writes `blockTimestampLast` for UniV2 parity.
  Validator timestamp drift ~15s accepted as in canonical UniV2.

## TegridyRouter

- **State**: stateless besides immutable factory + WETH references.
- **Trust**: assumes Factory.getPair and Pair.swap behave like canonical UniV2.
  No upgrade authority, no pause.
- **MAX_DEADLINE**: 2 hours. Hard cap. Documented as incompatible with CowSwap,
  1inch Limit Order, multi-day Safe-multisig flows — those aggregators must
  re-sign with a fresh deadline at settlement.

## TegridyTWAP

- **Pattern**: Uniswap V2 time-weighted average price.
- **Owner**: MULTISIG. Sets update fee and feeRecipient.
- **Trust**: pairs MUST be from the wired Factory (verified via `factory.isPair`).
  Disabled pairs blocked from `update()`.
- **First-observation gate**: only owner can call `update()` for pairs with
  `observationCount <= 2`. Closes single-trader bootstrap manipulation.
- **Reserve floor**: per-pair `minReserveFloor`. `update()` reverts if either
  reserve below floor. Mitigates low-TVL pair single-trader grind.
- **MAX_STALENESS**: 2 hours. `consult()` reverts on stale data.
- **Bypass semantics**: `bypassed` flag on any observation taints the in-range
  cumulative. `consult` fails closed on bypass.
- **L2 sequencer gate**: optional via `sequencerFeed`. address(0) = mainnet,
  non-zero = L2 with Chainlink Sequencer Uptime Feed.

## TegridyStaking

- **Standard**: ERC721 (Solady) for staking positions.
- **Owner**: MULTISIG via Ownable2Step.
- **Pause Guardian** (mvp-launch Phase 0.4): pause-only emergency role.
  PAUSE_GUARDIAN multisig can call `guardianPause()`. Unpause owner-only.
- **Stake caps** (mvp-launch Phase 0.7): `maxStakePerUser` and `maxTotalStaked`.
  Owner-set, raisable. Initial 50k / 5M TOWELI. Enforced on stake /
  stakeWithBoost / increaseAmount.
- **Trust**: TegridyRestaking address is set ONCE via TegridyStakingAdmin
  propose/execute (48h timelock). After set, only the restaking contract can
  receive position-NFT settle credits via the `unsettledRewardsByTokenId`
  per-tokenId attribution path (C-1 fix).
- **Block timestamp**: lock expiry uses block.timestamp; ~15s validator drift
  accepted since lock durations measure in days-to-years.
- **JBAC custody**: JBAC NFT deposit goes through TegridyStakingJbacVault
  (sister contract). Vault is one-shot wired at deploy.
- **Reward pool**: assumes admin funds via `notifyRewardAmount`. No callback
  fundability from external swap routers.

## TegridyStakingJbacVault

- **Owner**: none. Immutable bindings to `jbacNFT` and `staking`.
- **Trust**: only `staking` can call `returnJbac`. Pure custody role.
- **Threats**: stranded-JBAC reclaim recorded per-tokenId; outside the standard
  return path no other contract can touch the NFTs held here.

## TegridyStakingAdmin

- **Owner**: MULTISIG.
- **Trust**: holds timelock state (`_executeAfter`) for staking-side admin
  changes. Calls staking via `apply*` setters with `onlyAdmin` gating on
  staking side.
- **Pattern**: MakerDAO DSPause (propose / execute / cancel with 48h delay).

## TegridyRestaking

- **Owner**: MULTISIG.
- **Pause Guardian**: yes — Phase 0.4 role.
- **Battle-plan posture**: deployed PAUSED at launch (Phase 6). Opens only
  at Phase 7.0 after restaking-side audit cycle completes.
- **Trust**: reads/writes TegridyStaking via the wired interface. Receives
  position-NFTs via standard ERC721 safeTransferFrom; the
  `_settleRewardsOnTransfer` path on staking ensures inbound credits are
  attributed to `unsettledRewardsByTokenId[tokenId]` for the per-tokenId
  attribution invariant.

## RevenueDistributor

- **Owner**: MULTISIG.
- **Pause Guardian**: yes.
- **Trust**: reads voting power from TegridyStaking (`votingPowerAtTimestamp`,
  `totalBoostedStakeAtTimestamp`) at `epoch.timestamp - 1` to mitigate
  same-block dilution (REV-M-01 fix). Reads restaker power additively from
  TegridyRestaking via `_restakedPowerAt`.
- **Pattern**: Curve FeeDistributor-style auto-checkpoint, pull-based claim.
- **ETH/WETH**: uses WETHFallbackLib for transfers — fail-closed on receiver
  revert (no silent stranding).
- **Lifetime recovery cap**: `MAX_LIFETIME_RECOVERY_BPS = 100` (1% of
  `totalDistributed`). Closes the captured-owner unbounded-recovery surface.

## ReferralSplitter

- **Owner**: MULTISIG.
- **Trust**: only `approvedCaller` contracts (SwapFeeRouter is the canonical
  one) can record referral fees. After `completeSetup` is called the approval
  list is frozen.
- **Pull-claim**: referees claim ETH/WETH via pull; failed transfers fall back
  to pending withdraw bucket.

## SwapFeeRouter

- **Owner**: MULTISIG (Ownable2Step). SwapFeeRouterAdmin is the sister
  contract holding timelocked propose/execute for treasury / fee rate /
  premium-access changes.
- **Pause Guardian**: yes.
- **Trust**: wraps TegridyRouter swaps; collects fee in ETH or token; routes
  fee to stakers (via RevenueDistributor) and POLAccumulator.
- **PremiumAccess integration**: tolerates `address(0)` — fail-open in the
  premium-discount path. PremiumAccess deferred to next-wave; absence means
  every swap pays full protocol fee.
- **sweepETH**: 48h timelocked (PR #53 fix). Cannot drain instantly under
  owner compromise.

## SwapFeeRouterAdmin

- **Owner**: MULTISIG.
- **Trust**: holds timelocked propose/execute state for the sister
  SwapFeeRouter contract. Same DSPause pattern as TegridyStakingAdmin.

## POLAccumulator

- **Owner**: MULTISIG.
- **Pause Guardian**: yes.
- **Trust**: reads TegridyTWAP for slippage floor. Reverts if TWAP recently
  absorbed a bypass observation (bypass-cooldown defense). Routes accumulated
  ETH into TOWELI/WETH LP via TegridyRouter, mints LP to treasury.
- **L2 sequencer gate**: same as TWAP.

## TegridyTokenURIReader

- **Standard**: stateless view-only contract used by TegridyStaking.tokenURI.
- **Trust**: reads position data from TegridyStaking. No state, no auth.
- **Notes**: any future PR adding an attacker-controllable string field to
  `_buildJSON` MUST re-add `_jsonEscape` in the same PR or JSON injection
  silently regresses.

---

## Reward-pool funding (operational, not code)

The TegridyStaking reward pool emits at a constant `rewardRate` per second.
The contract does NOT bound emissions to the funded pool — `rewardPerTokenStored`
grows as `rewardRate * elapsed`, regardless of `rewardToken.balanceOf(staking)`.
This is the Synthetix StakingRewards pattern: rewards are "promised at constant
rate," and the operator MUST top up the pool faster than emissions deplete it.

If the operator falls behind, the contract still pays out rewards via
`getReward`, drawing from balance. Once balance drops to `totalStaked`, the
principal is still recoverable (INV-PRINCIPAL-RECOVERABLE, fuzzed at 256
runs × 500 calls in test/invariants/MVPLaunch_StakingInvariants.t.sol). But
late claimers face a race: the user who claims first gets paid, and the late
claimer gets DoSed by `_settleUnsettled` cap routes diverting to an
`unsettledRewards` bucket that may exceed available balance.

**Operational requirement at launch (Phase 6):**
- Pre-fund TOWELI reward pool with enough to cover 90+ days of emissions at
  the chosen rewardRate. At launch rate of ~0.82 TOWELI/s = ~2.13M
  TOWELI/month — minimum 6.4M TOWELI funded.
- Cron/keeper job to top up the pool monthly. Alert if `balance(staking) -
  totalStaked < 30 days * rewardRate`.

This is documented here because invariant fuzzing surfaced it loud — a
pool-exhaustion bug would otherwise present as "users randomly DoSed on
claim" in production, which is the hardest class of bug to diagnose under
load.

---

## Cross-cutting trust assumptions

These hold across the entire MVP set; if any one breaks, the threat map
shifts:

1. **Three-multisig diversity**: TREASURY ≠ MULTISIG ≠ PAUSE_GUARDIAN. Enforced
   address-level at deploy time (DeployMVP.s.sol require()). Signer-set
   diversity is operational — must be enforced by the multisig signers
   themselves (hardware vendor, jurisdiction, key-storage method).

2. **MULTISIG accepts ownership within 14 days**. OwnableNoRenounce enforces
   a 14-day pending-owner expiry. If the multisig misses the window, the
   deployer EOA permanently owns everything. VerifyMVP.s.sol INV-2 fails loud
   if not accepted at verify time.

3. **No pair below 10 ETH reserve floor whitelisted for sensitive consumers**
   (lending / POL slippage). Pure operator policy. Code defense exists but
   policy is the load-bearing piece. (Lending is deferred this wave.)

4. **TOWELI is a standard ERC20 without callbacks**. AMM/staking/router all
   assume this. Adding a callback to TOWELI in a future release would
   regress every consumer.

5. **Compiler version pinned to Solidity 0.8.26**. Curve lost $70M to a
   Vyper compiler bug. Bumps to 0.8.27+ require full re-audit.

6. **Optimizer settings**: runs=200, via_ir=true, cancun. Documented in
   foundry.toml. Changes to these settings change bytecode and require
   re-audit.

---

## Drift discipline

After audit freeze, the only changes allowed on `mvp-launch` are:

- Auditor-requested patches (own branch, own re-audit pass)
- Operational config changes via existing timelock surfaces (no code)

Any other edit invalidates this doc and the audit reports. Update this file
in the same PR as any source change that affects trust assumptions.
