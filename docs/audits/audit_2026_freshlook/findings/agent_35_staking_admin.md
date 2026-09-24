# Agent 35 — Fresh-eyes audit of TegridyStakingAdmin.sol

Scope: `contracts/src/TegridyStakingAdmin.sol` (admin-side propose/execute/cancel for the
TegridyStaking parameter surface), and the `applyXxx` setters on
`contracts/src/TegridyStaking.sol` they dispatch to.

Lens: admin escalation, parameter limits, captured-owner attack surface.

------------------------------------------------------------------------

## F-35-1 — `applyRestakingContract` lacks the `balanceOf(old) > 0` guard that `applyLendingContract` has

Severity: MEDIUM (captured-owner exfiltration risk for in-flight restaker rewards;
denial-of-service for honest restakers via per-tokenId claim path)

Location: `contracts/src/TegridyStaking.sol:1967-1970`
(matched against the protected sister at `1983-1987`)

Description:
- `applyLendingContract(_lending, false)` REJECTS revoke while
  `balanceOf(_lending) > 0` (any staking NFT still escrowed). Comment at
  line 1973-1976 explains why: stranded escrow on revoke would brick the
  borrower's eventual repay/default round-trip back to them.
- The restaking analogue does NOT have this guard. After a 48h timelock
  via `proposeRestakingContract` -> `executeRestakingContract`, the
  `restakingContract` storage slot is unconditionally overwritten:
    `function applyRestakingContract(address _restaking) external onlyAdmin {
        if (_restaking == address(0)) revert ZeroAddress();
        restakingContract = _restaking;
    }`

Captured-owner consequence:
- After the swap, the OLD restaking contract address is no longer in
  `_isTrackedHolder()` (line 1682-1686 — only checks the CURRENT
  `restakingContract` slot or `isLendingContract[holder]`).
- Any positions still escrowed at the OLD restaker are now in a state
  where:
  - `claimUnsettledForTokenId(tokenId, recipient)` from the old restaker
    REVERTS with `Unauthorized` (line 1641 `if (!_isTrackedHolder(msg.sender)) revert Unauthorized();`).
    The per-tokenId reward attribution for those positions is
    inaccessible from the old restaker — restakers cannot pull THEIR slice.
  - `claimUnsettledFor(oldRestakingContract)` is now a STALE-OWNER path:
    after `USER_INACTIVITY_GATE` (90 days) the owner can `claimUnsettledFor`
    on the old address (since it's no longer tracked, the
    `_isTrackedHolder` revert at line 1591 no longer fires — it's a
    legacy address). The unsettled bucket pays out to the OLD restaker's
    own address. If that contract has any owner-controlled withdrawal,
    funds can leave the protocol entirely.
- Even WITHOUT a malicious old-restaker contract, the asymmetric brick
  causes restakers to lose access to per-tokenId reward attribution they
  legitimately earned pre-swap. They can still recover principal
  (`unrestake()` on the OLD restaker), but the attributed unsettled
  rewards bucket is bricked from the per-tokenId path.

Repro intent:
1. Restaker A and B both stake into restakingContract V1; both have
   pending unsettled credits attributed via `unsettledRewardsByTokenId`.
2. Owner proposes new restakingContract V2 (captured-owner scenario, or
   honest mistake). 48h elapses.
3. `executeRestakingContract` -> `applyRestakingContract(V2)`. Storage
   slot now points at V2. V1 still holds NFTs and still has
   `unsettledRewards[V1]` and `unsettledRewardsByTokenId[*]` populated.
4. V1.unrestake (or its analogue) calls `staking.claimUnsettledForTokenId(tokenId, recipient)`.
   Reverts `Unauthorized`. Per-tokenId path is bricked for every escrowed
   position at V1.

Recommendation: Mirror the `applyLendingContract` guard:
    `if (balanceOf(restakingContract) > 0) revert PendingRestakingPositions();`
i.e. REJECT the swap while the OLD `restakingContract` still holds any
staking NFTs. Or alternatively, require `unsettledRewards[oldRestaking] == 0`
before allowing the swap.

------------------------------------------------------------------------

## F-35-2 — `MAX_REWARD_RATE` is a hard `constant` (100e18) — captured owner can ramp emissions to ~3.15B TOWELI/year (3.15× total supply) within the 48h timelock

Severity: LOW-MEDIUM (consequence is rapid exhaustion of the reward pool to existing
stakers — it does NOT exfiltrate to the owner directly, but it's a DoS-on-treasury-runway
attack and a noisy way to burn protocol value)

Location: `contracts/src/TegridyStaking.sol:271`
    `uint256 public constant MAX_REWARD_RATE = 100e18; // Cap maximum reward rate`

And admin-side cap-checked at `contracts/src/TegridyStakingAdmin.sol:130`
    `if (_rate > staking.MAX_REWARD_RATE()) revert RateTooHigh();`

Math:
- 100 TOWELI/sec × 86400 = 8.64M TOWELI/day
- Per year: 100 × 86400 × 365 = ~3.15B TOWELI
- TOWELI `TOTAL_SUPPLY = 1_000_000_000 ether` (per `Toweli.sol:50`).
- The MAX_REWARD_RATE cap is 3.15× the entire token supply per year.

Captured-owner consequence:
- Owner proposes rewardRate = MAX (100e18), waits 48h, executes. The
  reward pool — capped only by `rewardToken.balanceOf(this)` minus
  `_reserved()` — drains to active stakers in the order of seconds.
- This does NOT enrich the owner directly, BUT:
  - If the captured owner is also the largest staker (max boost +
    JBAC bonus, max lock), they capture a disproportionate share of
    the drain.
  - It bricks the reward runway for the ENTIRE protocol — every
    notifyRewardAmount-funded epoch is consumed in days.
  - Combined with `claimUnsettledFor` after 90-day inactivity, the
    captured owner can also drain stale users' rewards into the
    captured-owner-pre-pumped bucket.

Recommendation:
- Cap `MAX_REWARD_RATE` in production at a sane multiple of expected
  emissions, e.g. 1e18 (~31.5M/year, 3.15% of supply) instead of 100e18.
  Compound's `Comptroller` and Synthetix `StakingRewards` both bound
  emission rate to ~10% of staking-token-supply-per-year ceiling.
- OR add a SEPARATE timelocked `MAX_REWARD_RATE_CHANGE` so the cap
  itself is governance-mutable behind a longer (e.g., 14-day) timelock,
  decoupling routine rate adjustments from cap-raising.

Notes: This is a CONSTANT, not mutable, so the timelock-bypass is
in the constant-too-permissive sense rather than a setter-bypass.
Defense-in-depth via lower constant.

------------------------------------------------------------------------

## F-35-3 — `applyMaxUnsettledRewards` accepts cap up to `type(uint256).max` with only a 10_000e18 floor

Severity: INFORMATIONAL (no direct exploit observed — owner cannot redirect funds to
themselves, but the cap is a headline safety bound that becomes meaningless when
unbounded above)

Location:
- Admin propose: `contracts/src/TegridyStakingAdmin.sol:206-212`
    `if (_newCap < 10_000e18) revert CapTooLow();`
- Apply: `contracts/src/TegridyStaking.sol:2220-2223`
    `if (_cap < 10_000e18) revert CapTooLow();`

The cap was AUDIT FIX L-06 specifically to "Cap unbounded totalUnsettledRewards growth."
Captured-owner setting the cap to `type(uint256).max` REVERSES the intent of L-06 —
restoring the unbounded-growth state the original fix was meant to prevent.

Mitigating context: `_settleUnsettled` (line 2081-2099) post-fix never redirects
overflow-of-cap rewards to treasury. It just floors to `unsettledRoom`. Funds the
captured owner WANTS go to the legitimate user, not to the owner. So no direct exfil.

Recommendation: Add a sane upper bound on the propose path (e.g.,
`_newCap > 100_000_000e18` revert `CapTooHigh`). Compound's
`Comptroller.borrowCapGuardian` enforces a bounded ceiling for similar
"safety cap" parameters. With a hard ceiling, the cap stays the
documented safety bound that L-06 introduced.

------------------------------------------------------------------------

## F-35-4 — `sweepToken` routes recovered ERC-20s to mutable `treasury` address — captured-owner two-step exfil of any non-reward token sent to the contract

Severity: INFORMATIONAL / LOW (bounded to "tokens accidentally sent to staking", excludes
the staked principal because rewardToken == staked token is sweep-blocked at
`contracts/src/TegridyStaking.sol:1993`)

Location: `contracts/src/TegridyStaking.sol:1992-1997`

Flow:
1. Captured owner proposes treasury = attackerWallet via
   `proposeTreasuryChange` (48h timelock).
2. Executes `executeTreasuryChange` → treasury slot now points at attacker.
3. `sweepToken(token)` for any ERC-20 (other than rewardToken) sends
   `IERC20(token).balanceOf(address(this))` to attacker.

Captured-owner consequence:
- Bounded to "non-reward ERC-20s held by the staking contract." TOWELI is
  rewardToken AND staking token, so principal is sweep-blocked
  (`CannotSweepRewardToken` at line 1993). This is the tight invariant.
- Realistic exposure: tokens from accidental transfers, airdrops to the
  contract address, fee tokens from a future hook integration. Material
  amounts are unlikely but not zero.

Mitigation already in place:
- `rewardToken` is `immutable` (line 148) — captured owner CANNOT swap
  it. The principal/reward separation invariant holds.
- `sweepToken` is `nonReentrant` and `onlyOwner` — bounded blast radius.

Recommendation (defense-in-depth):
- Route `sweepToken` payout to a 2-of-N multisig address rather than
  the mutable `treasury` slot. Gnosis Safe's pattern is `sweep -> safe`.
- OR add a 48h timelock specifically on `sweepToken` so a captured-owner
  treasury swap + sweep race is detectable on-chain for that long.
- OR decline to sweep and just emit an event so off-chain can recover
  via a separate governance transaction.

------------------------------------------------------------------------

## F-35-5 — Emergency-withdraw + emergency-exit interaction: pause-asymmetric paths are coherent (positive observation, no finding)

Reviewed: `emergencyWithdrawPosition` (line 1712, `whenPaused`), and
`emergencyExitPosition` / `requestEmergencyExit` / `executeEmergencyExit`
(lines 1729, 1752, 1778, all PAUSE-INDEPENDENT).

Captured-owner pause-and-trap is BLOCKED:
- `requestEmergencyExit` and `executeEmergencyExit` are not gated by `whenNotPaused`.
- A captured owner cannot pause + revoke users' principal exit. Users with expired
  locks can `emergencyExitPosition` even while paused (line 1729 has no `whenPaused`
  modifier — it has `nonReentrant` + `updateReward` only — and falls through to
  `_clearPosition` and direct `safeTransfer(msg.sender, amount)`).
- Users with unexpired locks can `requestEmergencyExit` -> wait 7 days ->
  `executeEmergencyExit` (pays 25% penalty to treasury but principal is recoverable).

This is sound. Pause traps the protocol but cannot trap user principal — exactly the
escape-hatch invariant the C-05 audit fix introduced.

Note: 25% early-exit penalty during emergency would route to a CAPTURED treasury IF
the owner has already executed a 48h treasury swap. So a fully-captured owner can take
25% of fast-exiting users' principal during the pause window (treasury slot already
flipped). This is acknowledged in F-35-4 mitigation discussion above; the bounded
loss is 25% of opt-in early-exit principal, NOT full principal.

------------------------------------------------------------------------

## F-35-6 — Captured-owner reward-token swap impossible (positive observation)

Reviewed: `rewardToken` is declared `immutable` (line 148):
    `IERC20 public immutable rewardToken;`
There is NO `applyRewardToken` setter, NO migration entrypoint.

Combined with `sweepToken`'s reward-token block (line 1993), the staked principal token
is fully captured-owner-resistant on the swap dimension. This closes the obvious
"swap reward token mid-flight to a malicious one" attack class. Good.

Same for `jbacNFT` (immutable, line 158) — captured owner cannot swap the JBAC
collection out from under existing depositors.

------------------------------------------------------------------------

## F-35-7 — JBAC vault setter (`setJbacVault`) is one-shot — orphan-NFT risk closed

Reviewed: `contracts/src/TegridyStaking.sol:466-472`
    `if (jbacVault != address(0)) revert JbacVaultAlreadySet();`

Captured owner cannot point `jbacVault` at an attacker contract once set. The first-time
setter is owner-only, but cannot be re-invoked. This closes the "swap vault, orphan
all JBACs at the old vault" captured-owner path. Good.

------------------------------------------------------------------------

## F-35-8 — Timelock keys hardcoded; no key collision potential (positive observation)

Reviewed: timelock keys at `contracts/src/TegridyStakingAdmin.sol:64-72`. All eight
keys are distinct keccak256 of unique strings. The `_propose / _execute / _cancel`
single-key invariant in `TimelockAdmin` (line 140 `if (_executeAfter[key] != 0) revert
ExistingProposalPending(key);`) holds. No way to collision-overwrite a pending proposal.

------------------------------------------------------------------------

## F-35-9 — `proposeExtendFee` ceiling (200 BPS = 2%) and `proposePenaltyRecycle` ceiling (10000 BPS = 100%) are both bounded (positive observation)

`proposeExtendFee`: capped at 200 (2%) at line 261. Cannot inflate above 2% even with
captured owner + 48h wait.

`proposePenaltyRecycle`: capped at 10_000 BPS (100%) at line 287. 100% recycle to
stakers is the maximum. This is a positive direction for stakers (more recycle =
more reward). No exfil.

`proposeExtendFeeRecycle`: capped at 10_000 BPS at line 323. Same direction —
captured owner can only push MORE fee back to stakers, not less. Treasury-side
captured-owner can't redirect MORE to themselves than the C5 baseline (100% to
treasury). They can only push more fee BACK to stakers. Defensively safe.

------------------------------------------------------------------------

## Notes / dead-ends

- Reward rate setter to drain reserve: investigated, see F-35-2. Not a direct exfil
  path because rewards go to legitimate stakers; only an inflation/runway-burn DoS.
- Lock duration bounds setter: there is NO lock-duration setter on the admin contract.
  `MIN_LOCK_DURATION = 7 days` and `MAX_LOCK_DURATION = 4 * 365 days` are constants on
  the staking contract (lines 89-90). Captured owner cannot widen or narrow these.
  Good.
- Boost ceiling setter: NO setter — `MIN_BOOST_BPS = 4000`, `MAX_BOOST_BPS = 40000`,
  `JBAC_BONUS_BPS = 5000` all constants. Captured owner cannot inflate boost.
- Penalty BPS setter: `EARLY_WITHDRAWAL_PENALTY_BPS = 2500` constant. NOT mutable.
  Only the SPLIT (treasury vs. recycle to stakers) is mutable, and that direction is
  staker-favorable as captured owner pushes more recycle (F-35-9).
- JBAC bonus toggle (sudden re-eval of all positions): there is NO toggle. The bonus
  is applied at stake time and cached in `Position.boostBps`. `revalidateBoost`
  (line 1226) only allows DOWNGRADE for legacy `jbacDeposited=false` positions. No
  captured-owner upside to forcing re-eval.
- Migrate to new staking impl: NO migration entrypoint. Storage is non-upgradeable.
  Good.
- Admin replacement (`proposeAdminReplacement`, line 1914): timelocked 48h, on the
  staking contract itself (not on the admin contract), so a broken/captured admin
  cannot block its own removal. Good.
- `setStakingAdmin` (first-time, line 1878): one-shot; subsequent rotations require
  the propose/execute timelock. Has `code.length == 0` rejection (DEEP-DS-12) so
  cannot point at an EOA. Good.

------------------------------------------------------------------------

## Summary

Three actionable findings:
1. F-35-1 (MEDIUM): `applyRestakingContract` lacks the `balanceOf(old) > 0` revoke
   guard that `applyLendingContract` has — captured owner can swap the restaker
   while restakers' NFTs are still escrowed, bricking `claimUnsettledForTokenId`
   for every in-flight position.
2. F-35-2 (LOW-MEDIUM): `MAX_REWARD_RATE = 100e18` constant allows captured owner
   to ramp emissions to ~3.15× TOWELI total supply per year via 48h timelock —
   not a direct exfil but a runway-burn DoS.
3. F-35-3 (INFO): `applyMaxUnsettledRewards` has only a floor (10_000e18) and no
   ceiling — captured owner can set cap to `type(uint256).max`, reversing the
   AUDIT FIX L-06 unbounded-growth defense.

Plus F-35-4 (INFO/LOW) — `sweepToken` to mutable `treasury` is a two-step
captured-owner exfil for non-reward ERC-20s held by the staking contract.

Positive observations confirmed:
- Reward token / JBAC NFT / staking position storage layout are all immutable or
  one-shot; captured owner cannot swap them.
- Pause + emergency-exit are not mutually exclusive; user principal cannot be
  permanently trapped by pause.
- Penalty / extend-fee BPS ceilings are conservative and direction-of-flow
  favors stakers when captured-owner adjusts.
- `proposeAdminReplacement` is on the staking contract (not admin) so a broken
  admin cannot block its own removal.

Path: `.audit_2026_freshlook/findings/agent_35_staking_admin.md`
