// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import {Checkpoints} from "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {OwnableNoRenounce} from "./base/OwnableNoRenounce.sol";
import {TimelockAdmin} from "./base/TimelockAdmin.sol";

interface ITegridyStaking {
    function getReward(uint256 tokenId) external returns (uint256 claimed);
    function toggleAutoMaxLock(uint256 tokenId) external;
    function claimUnsettled() external;
    function unsettledRewards(address user) external view returns (uint256);
    /// @dev AUDIT FIX C-1: per-tokenId attribution claim. Pulls only the
    ///      `unsettledRewardsByTokenId[tokenId]` slice (capped by holder bucket
    ///      and reward pool) and transfers directly to `recipient`. Replaces
    ///      the racy `claimUnsettled()` / snapshot-delta flow so two restakers
    ///      with kick credits in the same bucket no longer race for each
    ///      other's share. Returns the actual amount transferred.
    function claimUnsettledForTokenId(uint256 tokenId, address recipient) external returns (uint256 paid);
    function earned(uint256 tokenId) external view returns (uint256);
    function revalidateBoost(uint256 tokenId) external; // M-26
    /// @dev AUDIT FIX: DEEP-DR-11 — defense-in-depth ownership check to mirror
    ///      the per-owner enumerable set added in M13. A future TegridyStaking
    ///      upgrade that wraps ownership through a proxy or share-token would
    ///      still pass `ownerOf` but may diverge from the staking contract's
    ///      authoritative `_positionsByOwner` set. Cheap belt-and-suspenders
    ///      for `restake`.
    function holdsToken(address user, uint256 tokenId) external view returns (bool);
    // AUDIT H-1 (2026-04-20): Position struct extended with jbacTokenId + jbacDeposited.
    function positions(uint256 tokenId) external view returns (
        uint256 amount,
        uint256 boostedAmount,
        int256 rewardDebt,
        uint256 lockEnd,
        uint256 boostBps,
        uint256 lockDuration,
        bool autoMaxLock,
        bool hasJbacBoost,
        uint256 stakeTimestamp,
        uint256 jbacTokenId,
        bool jbacDeposited
    );
}

/// @title TegridyRestaking — Restake your tsTOWELI NFT for additional yield
/// @notice Deposit your TegridyStaking NFT (tsTOWELI) to earn BONUS rewards
///         on top of your base staking rewards.
///
///         How it works:
///         1. You stake TOWELI in TegridyStaking → get tsTOWELI NFT
///         2. You deposit that NFT here → this contract holds it
///         3. You earn base staking rewards (auto-claimed by this contract)
///            PLUS bonus restaking rewards from a separate reward pool
///         4. Withdraw anytime → get your NFT back
///
///         The bonus yield comes from protocol fees, incentive programs,
///         or funded reward pools — separate from base staking emissions.
///
///         Think of it like:
///         - Base staking = earning interest on a savings account
///         - Restaking = lending your savings certificate for extra yield
contract TegridyRestaking is OwnableNoRenounce, ReentrancyGuard, Pausable, IERC721Receiver, TimelockAdmin {
    using SafeERC20 for IERC20;

    // ─── Constants ──────────────────────────────────────────────────
    uint256 private constant ACC_PRECISION = 1e12;

    // ─── TimelockAdmin Keys ──────────────────────────────────────────
    bytes32 public constant BONUS_RATE_CHANGE = keccak256("BONUS_RATE_CHANGE");
    bytes32 public constant ATTRIBUTION_CHANGE = keccak256("ATTRIBUTION_CHANGE");

    // ─── State ──────────────────────────────────────────────────────
    IERC20 public immutable rewardToken;       // TOWELI
    IERC20 public immutable bonusRewardToken;  // ETH (WETH) or any ERC20 for bonus
    ITegridyStaking public immutable staking;  // TegridyStaking contract
    IERC721 public immutable stakingNFT;       // tsTOWELI NFT (same address as staking)

    uint256 public bonusRewardPerSecond;
    uint256 public lastBonusRewardTime;
    uint256 public accBonusPerShare;
    uint256 public totalRestaked;              // Sum of all deposited boosted amounts (used for bonus reward distribution)

    struct RestakeInfo {
        uint256 tokenId;          // The tsTOWELI NFT token ID
        uint256 positionAmount;   // Amount of TOWELI in the position (cached)
        uint256 boostedAmount;    // Boosted amount (cached for reward calc)
        int256 bonusDebt;         // Bonus reward debt
        uint256 depositTime;      // When NFT was deposited
        uint256 unsettledSnapshot;// AUDIT H-06: TegridyStaking.unsettledRewards(this) at deposit time.
                                  // Used for unrestake/emergencyWithdrawNFT delta attribution,
                                  // replacing the race-prone before/after read pattern.
    }

    mapping(address => RestakeInfo) public restakers;
    mapping(uint256 => address) public tokenIdToRestaker; // reverse lookup

    /// @notice AUDIT H-8 (HIGH): per-restaker historical boost checkpoints. Without
    ///         this, boostedAmountAt(_user, _ts) was returning the CURRENT (already
    ///         decayed) cached boostedAmount for any historical timestamp — silently
    ///         under-crediting restakers in RevenueDistributor when their lock decays
    ///         between epoch creation and claim time. Trace208.upperLookup gives the
    ///         actual value at `_ts`. Pattern matches TegridyStaking._checkpoints.
    using Checkpoints for Checkpoints.Trace208;
    mapping(address => Checkpoints.Trace208) private _boostCheckpoints;

    /// @dev H-8: write a new boost checkpoint for `user` with the given value.
    ///      Called from every site that mutates info.boostedAmount.
    function _writeBoostCheckpoint(address user, uint256 newBoost) internal {
        _boostCheckpoints[user].push(SafeCast.toUint48(block.timestamp), SafeCast.toUint208(newBoost));
    }

    uint256 public totalBonusFunded;
    uint256 public totalBonusDistributed;
    mapping(address => uint256) public unforwardedBaseRewards; // AUDIT FIX H-02: Track base rewards arriving outside claimAll
    uint256 public totalUnforwardedBase; // SECURITY FIX: Track total unforwarded to cap attribution
    mapping(address => uint256) public pendingUnsettledRewards;
    uint256 public totalPendingUnsettled; // SECURITY FIX: Track total pending unsettled for recoverStuckPrincipal
    /// @notice AUDIT H-1: running sum of active restakers' original principal amounts.
    ///         Reserved from recoverStuckPrincipal's recoverable pool so late callers
    ///         can't get shortchanged by earlier callers who already drained it.
    uint256 public totalActivePrincipal;

    // SECURITY FIX #13: Timelock for reward rate changes
    uint256 public constant BONUS_RATE_TIMELOCK = 48 hours;
    uint256 public constant MAX_BONUS_REWARD_RATE = 100e18;
    uint256 public pendingBonusRate;

    // SECURITY FIX: Timelock for attributeStuckBaseRewards
    uint256 public constant ATTRIBUTE_TIMELOCK = 24 hours;
    struct PendingAttribution {
        address restaker;
        uint256 amount;
    }
    PendingAttribution public pendingAttribution;

    // H-01 FIX: Track per-user recovery to prevent race condition in recoverStuckPrincipal
    mapping(address => bool) public hasRecoveredPrincipal;
    uint256 public totalRecoveredPrincipal;

    // H-02 FIX: Rate-limit emergencyForceReturn to prevent rapid sequential draining
    uint256 public lastForceReturnTime;
    uint256 public constant FORCE_RETURN_COOLDOWN = 1 hours;

    // AUDIT FIX: DEEP-DR-07 — cooldown between bonus-rate propose/cancel sequences
    // so a captured-key signer cannot churn the rate-change state indefinitely
    // (preventing legitimate signers from enacting a counter-rate during an
    // incident). Tracks the timestamp of the most recent propose OR cancel; the
    // next propose/cancel pair is gated by `BONUS_RATE_ACTION_COOLDOWN`.
    uint256 public lastBonusRateActionAt;
    uint256 public constant BONUS_RATE_ACTION_COOLDOWN = 24 hours;

    // ─── Events ─────────────────────────────────────────────────────
    event Restaked(address indexed user, uint256 indexed tokenId, uint256 positionAmount);
    event Unrestaked(address indexed user, uint256 indexed tokenId);
    event BonusClaimed(address indexed user, uint256 bonusAmount);
    event BaseClaimed(address indexed user, uint256 baseAmount);
    event BonusFunded(uint256 amount);
    event BonusRateUpdated(uint256 newRate);
    event EmergencyWithdraw(address indexed user, uint256 indexed tokenId); // SECURITY FIX #12
    event BonusRateProposed(uint256 newRate, uint256 executeAfter); // SECURITY FIX #13
    event BonusRateExecuted(uint256 newRate); // SECURITY FIX #13
    event BaseClaimFailed(uint256 indexed tokenId, address indexed user); // SECURITY FIX #21
    event BonusRateCancelled(uint256 cancelledRate); // M-03: Cancel mechanism
    event PositionRefreshed(address indexed user, uint256 indexed tokenId, uint256 oldAmount, uint256 newAmount); // C-05
    event StuckBaseRewardsAttributed(address indexed restaker, uint256 amount); // AUDIT FIX: attribute external base rewards
    event AttributionProposed(address indexed restaker, uint256 amount, uint256 executeAfter);
    event AttributionCancelled(address indexed restaker, uint256 amount);
    event UnsettledRecovered(address indexed user, uint256 amount); // AUDIT FIX: recover unsettled from NFT transfer
    event EmergencyForceReturn(address indexed restaker, uint256 indexed tokenId, bool nftReturned); // H-05
    event BoostRevalidated(address indexed restaker, uint256 indexed tokenId, uint256 oldBoosted, uint256 newBoosted); // M-26
    /// @notice AUDIT H13: emitted when the bonus reward pool cannot cover the expected
    ///         elapsed * bonusRewardPerSecond accrual. Restakers silently earn less than
    ///         the advertised rate; off-chain monitors must surface this so the pool can
    ///         be refunded before users notice their APR drift.
    event BonusShortfall(uint256 elapsed, uint256 shortfall);

    // ─── Errors ─────────────────────────────────────────────────────
    error NotRestaked();
    error AlreadyRestaked();
    error NotNFTOwner();
    error InvalidNFT();
    error ZeroAmount();
    // Legacy error aliases (kept for test compatibility — TimelockAdmin errors are thrown instead)
    // Note: ProposalExpired() removed — use TimelockAdmin.ProposalExpired(bytes32) instead
    error TimelockNotElapsed(); // SECURITY FIX #13
    error RateTooHigh(); // SECURITY FIX #13
    error NoPendingRateChange(); // SECURITY FIX #13
    error CannotSweepBonusToken(); // SECURITY FIX: Prevent sweeping bonus reward pool
    error CannotSweepRewardToken(); // SECURITY FIX: Prevent sweeping base reward token
    error NoPendingAttribution();
    error AttributionTimelockNotElapsed();
    error AttributionExpired();
    error ExistingAttributionPending();
    error RewardTokenMatchesBonusToken(); // SECURITY FIX: Constructor validation
    error ZeroAddress(); // L-01: Zero-address validation
    error OnlyStakingNFT(); // L-03: Custom error for onERC721Received
    error Int256Overflow(); // M-27: Safe int256 cast guard
    error NotRestakedToken(); // M-26: Token not restaked in this contract
    error Unauthorized(); // AUDIT NEW-S2: restrict revalidate-boost helpers to owner/restaker
    /// @notice R014 RETRY: emitted by `_accrueBonusChecked` when an `_accrueBonus`
    ///         override decreases `accBonusPerShare`. The accumulator is monotonically
    ///         non-decreasing by construction; any overriding subclass that violates
    ///         this invariant is malicious and must trip this assertion.
    error AccrueNotMonotone();
    /// @notice AUDIT NFT-CL-M4: typed-error replacement for the legacy
    ///         `revert("NO_DECAY")` string in `decayExpiredRestaker`. Raised when
    ///         the cached boost matches the current staking-side boost (i.e., no
    ///         decay has happened yet — the helper has nothing to do).
    error NoDecay();
    /// @notice AUDIT FIX: DEEP-DR-07 — propose/cancel of bonus rate must be at
    ///         least `BONUS_RATE_ACTION_COOLDOWN` apart so a captured-signer key
    ///         cannot churn rate-change state continuously.
    error BonusRateActionCooldown();
    /// @notice AUDIT FIX: DR2-08 — distinct typed error for the staking-side
    ///         per-owner-set divergence check (DR-11 fix). Pre-DR2-08, this
    ///         shared `NotNFTOwner()` with the ERC721 ownership check, so
    ///         off-chain monitors couldn't distinguish "ERC721 ownership
    ///         mismatch" from "TegridyStaking per-owner-set divergence" — the
    ///         latter being a future-compat tripwire that signals a TegridyStaking
    ///         ABI/semantics drift. Distinct typed error makes the failure
    ///         surface diagnosable for Tenderly alerts.
    error StakingOwnershipDesync();

    // ─── Constructor ────────────────────────────────────────────────
    constructor(
        address _staking,
        address _rewardToken,
        address _bonusRewardToken,
        uint256 _bonusRewardPerSecond
    ) OwnableNoRenounce(msg.sender) {
        // L-01: Zero-address validation for all constructor params
        if (_staking == address(0)) revert ZeroAddress();
        if (_rewardToken == address(0)) revert ZeroAddress();
        if (_bonusRewardToken == address(0)) revert ZeroAddress();
        if (_rewardToken == _bonusRewardToken) revert RewardTokenMatchesBonusToken();
        // AUDIT FIX M-20: Bounds check for bonusRewardPerSecond to prevent extreme values
        require(_bonusRewardPerSecond <= 10e18, "BONUS_RATE_TOO_HIGH");
        staking = ITegridyStaking(_staking);
        stakingNFT = IERC721(_staking); // TegridyStaking IS the ERC721
        rewardToken = IERC20(_rewardToken);
        bonusRewardToken = IERC20(_bonusRewardToken);
        bonusRewardPerSecond = _bonusRewardPerSecond;
        lastBonusRewardTime = block.timestamp;
    }

    // ─── Legacy View Helpers (for test compatibility) ──────────────
    function bonusRateChangeTime() external view returns (uint256) { return _executeAfter[BONUS_RATE_CHANGE]; }
    function attributionExecuteAfter() external view returns (uint256) { return _executeAfter[ATTRIBUTION_CHANGE]; }

    // ─── Modifiers ──────────────────────────────────────────────────
    modifier updateBonus() {
        if (block.timestamp > lastBonusRewardTime && totalRestaked > 0) {
            uint256 elapsed = block.timestamp - lastBonusRewardTime;
            uint256 reward = elapsed * bonusRewardPerSecond;
            uint256 available;
            try bonusRewardToken.balanceOf(address(this)) returns (uint256 bal) {
                available = bal;
            } catch {
                available = 0;
            }
            // AUDIT H13: surface bonus-pool drought so off-chain monitors can refund the
            // pool before restakers see APR drift. The truncation behavior itself is
            // preserved (reward = available) — this only adds observability.
            if (reward > available) {
                emit BonusShortfall(elapsed, reward - available);
                reward = available;
            }
            if (reward > 0) {
                accBonusPerShare += (reward * ACC_PRECISION) / totalRestaked;
            }
            lastBonusRewardTime = block.timestamp;
        } else if (totalRestaked == 0) {
            // AUDIT FIX H-01: Always advance lastBonusRewardTime when totalRestaked == 0
            // to prevent first-restaker reward dump after a gap period.
            // Rewards during empty periods are forfeited (no one to distribute to).
            lastBonusRewardTime = block.timestamp;
        }
        _;
    }

    // ─── View Functions ─────────────────────────────────────────────

    /// @notice Check pending bonus rewards for a user
    /// @dev AUDIT FIX: DEEP-DR-08 — route through the clamped historical boost
    ///      view so frontends/integrators see a value consistent with what the
    ///      RevenueDistributor (or a `claimAll` after `staking.kick`) would
    ///      actually settle. Pre-fix, between staking-side lock expiry and the
    ///      next restaking-side mutation, this view returned the inflated cached
    ///      `info.boostedAmount` — users would see a "100 TOWELI pending" toast
    ///      that silently shrinks to ~30 TOWELI on claim because `claimAll`'s
    ///      stale path correctly clamps to the current staking boost.
    function pendingBonus(address _user) public view returns (uint256) {
        RestakeInfo memory info = restakers[_user];
        if (info.tokenId == 0) return 0;

        uint256 currentAcc = accBonusPerShare;
        if (block.timestamp > lastBonusRewardTime && totalRestaked > 0) {
            uint256 elapsed = block.timestamp - lastBonusRewardTime;
            uint256 reward = elapsed * bonusRewardPerSecond;
            // AUDIT FIX: DR2-06 — wrap `bonusRewardToken.balanceOf` in try/catch
            // for parity with `_accrueBonus` (which DR-06 fix made tolerant).
            // Without this, a hostile/paused/blacklisted bonus token would
            // revert this view, breaking every frontend dashboard, off-chain
            // indexer, and integrator that reads `pendingBonus`/`pendingTotal`.
            // The mutator path tolerates it; the view should too.
            uint256 available;
            try bonusRewardToken.balanceOf(address(this)) returns (uint256 bal) {
                available = bal;
            } catch {
                available = 0;
            }
            if (reward > available) reward = available;
            currentAcc += (reward * ACC_PRECISION) / totalRestaked;
        }

        // AUDIT FIX: DEEP-DR-08 — use the staleness-clamped boost (min(cached,
        // current)) instead of the raw cached `info.boostedAmount`. Same fix as
        // DEEP-DR-04 applied to the pendingBonus view surface.
        uint256 effectiveBoost = _boostedAmountAt(_user, block.timestamp);
        // M-27: Safe int256 cast via _safeInt256 helper
        int256 accumulated = _safeInt256((effectiveBoost * currentAcc) / ACC_PRECISION);
        int256 diff = accumulated - info.bonusDebt;
        return diff > 0 ? uint256(diff) : 0;
    }

    /// @notice Check pending base staking rewards for the deposited NFT
    function pendingBase(address _user) public view returns (uint256) {
        RestakeInfo memory info = restakers[_user];
        if (info.tokenId == 0) return 0;
        return staking.earned(info.tokenId);
    }

    /// @notice Total pending rewards (base + bonus) for display
    function pendingTotal(address _user) external view returns (uint256 base, uint256 bonus) {
        base = pendingBase(_user);
        bonus = pendingBonus(_user);
    }

    /// @notice AUDIT NEW-S1 (CRITICAL): voting-power source for RevenueDistributor.
    ///         When an NFT is transferred into this contract, TegridyStaking zeroes the
    ///         user's voting-power checkpoint (the NFT no longer belongs to them on the
    ///         staking side). RevenueDistributor.votingPowerAtTimestamp(user, ts) therefore
    ///         reads 0 for every epoch during the user's restake window, silently paying
    ///         them $0 of protocol revenue — the exact opposite of the intent.
    ///
    ///         This view exposes the restaker's boosted-amount at a given timestamp so the
    ///         distributor can fall through when the staking checkpoint is zero. Returns
    ///         the current `boostedAmount` if the user held a restaked position at or
    ///         before `_timestamp` (i.e., `depositTime <= _timestamp`), zero otherwise.
    ///
    ///         Note: the current boostedAmount is a lower bound for the power the user
    ///         actually held at `_timestamp` (boost can only decay between then and now),
    ///         so this is a safe proxy — never over-credits. Users who unrestake without
    ///         claiming first will forfeit their share for epochs distributed during the
    ///         restake window; frontends should surface a "claim before unrestake" hint.
    function boostedAmountAt(address _user, uint256 _timestamp) external view returns (uint256) {
        return _boostedAmountAt(_user, _timestamp);
    }

    /// @dev AUDIT FIX: DEEP-DR-04 / DEEP-DR-08 / DEEP-DR-10 — internal helper used
    ///      by the public `boostedAmountAt` view AND by `pendingBonus` so both
    ///      surface the same lazy-decay-safe value.
    ///
    ///      The trace-checkpoint cache on this side is only updated by RESTAKING-
    ///      side mutations (restake / unrestake / refresh / decayExpiredRestaker /
    ///      revalidateBoost / emergency exits). When TegridyStaking's
    ///      permissionless `kick(tokenId)` is invoked from the outside (Curve-
    ///      style decay sweeper) or via `withdraw`/`unstake`, the staking-side
    ///      `boostedAmount` is zeroed/decayed but our cache and Trace208 stay
    ///      stuck on the pre-expiry inflated value. RevenueDistributor (and other
    ///      consumers) calling `boostedAmountAt(user, ts)` with `ts` after the
    ///      kick used to receive the inflated checkpoint, over-crediting the user.
    ///
    ///      Fix: clamp the checkpointed value with the CURRENT staking-side
    ///      `boostedAmount`. Boost monotonically decays over time, so the current
    ///      value is a safe upper bound for any past timestamp ≤ now. Wrapping
    ///      the staking call in try/catch keeps the view robust if the staking
    ///      contract is ever upgraded with a temporarily-incompatible ABI.
    function _boostedAmountAt(address _user, uint256 _timestamp) internal view returns (uint256) {
        RestakeInfo memory info = restakers[_user];
        if (info.tokenId == 0) return 0;
        if (info.depositTime > _timestamp) return 0;

        uint256 cached;
        if (_boostCheckpoints[_user].length() == 0) {
            cached = info.boostedAmount;
        } else {
            cached = _boostCheckpoints[_user].upperLookup(SafeCast.toUint48(_timestamp));
        }

        // AUDIT FIX: DEEP-DR-04 — clamp by current staking-side boost. `min(cached,
        // current)` guarantees no over-credit even when the cache is lazy: the
        // value can only ever be too HIGH due to staleness, never too low.
        // try/catch defends against future staking ABI breakage.
        //
        // AUDIT FIX: DR2-02 — the `min(cached, current)` clamp rests on the
        // assumption that boost monotonically decays over time, so the current
        // value is a safe upper bound for any past timestamp. That assumption
        // is FALSE for `autoMaxLock` positions: after `staking.kick(tokenId)`
        // zeroes `boostedAmount`, the next `staking.getReward(tokenId)` (which
        // claimAll calls) detects `p.autoMaxLock && p.boostedAmount == 0` and
        // RE-APPLIES MAX_BOOST. The staking-side `boostedAmount` jumps from 0
        // back to MAX in the same transaction — non-monotonic restoration.
        //
        // Without this carve-out, RevenueDistributor's `_boostedAmountAt`
        // lookup for an epoch in the kick-window returns
        // `min(prev_checkpoint_X, MAX) = X` (the inflated pre-kick value)
        // instead of the correct 0 — reopening the DR-04 over-credit attack
        // via the user's own `claimAll` trigger.
        //
        // Fix: when staking-side `autoMaxLock` is true, the per-checkpoint
        // historical Trace208 lookup IS the authoritative answer (it was
        // written at each restaking-side mutation, including the post-kick
        // claimAll stale-path which correctly recorded the post-kick value).
        // Skip the live-current clamp and trust the checkpoint.
        uint256 current;
        uint256 liveLockEnd;
        try staking.positions(info.tokenId) returns (
            uint256, uint256 stakingBoosted, int256, uint256 lockEnd_, uint256, uint256, bool, bool, uint256, uint256, bool
        ) {
            current = stakingBoosted;
            liveLockEnd = lockEnd_;
        } catch {
            // If the staking call reverts, fall back to the cached value rather
            // than zeroing — the cache is at worst stale-inflated, never stale-
            // deflated, and zero would over-penalize honest users.
            return cached;
        }

        // AUDIT FIX DR3-01: lockEnd-anchored clamp. The DR2-02 carve-out
        // (`if (autoMaxLock) return cached;`) was a NET REGRESSION: it
        // returned the stale-inflated cache during the kick-window for
        // autoMaxLock positions, reopening exactly the DR-04 over-credit
        // attack. Replacement: when the live lock has EXPIRED
        // (`block.timestamp >= liveLockEnd`), the position is in the
        // kick-window and `current` is conservative (0 if not yet restored,
        // post-kick MAX if restored — either way `min(cached, current)`
        // bounds the over-credit). When the live lock is ACTIVE
        // (`block.timestamp < liveLockEnd`), the user has a live position —
        // the per-checkpoint Trace208 cache is the authoritative historical
        // record, so return `cached` directly (avoids the DR2-07 edge case
        // for unrestake → restake-smaller flows where current would
        // under-credit historical epochs).
        if (block.timestamp >= liveLockEnd) {
            return cached < current ? cached : current;
        }
        return cached;
    }

    // ─── User Functions ─────────────────────────────────────────────

    /// @notice Deposit your tsTOWELI NFT to earn bonus yield
    /// @dev Transfers the NFT from caller to this contract
    function restake(uint256 _tokenId) external nonReentrant whenNotPaused updateBonus {
        if (restakers[msg.sender].tokenId != 0) revert AlreadyRestaked();

        // Verify caller owns the NFT
        if (stakingNFT.ownerOf(_tokenId) != msg.sender) revert NotNFTOwner();
        // AUDIT FIX: DEEP-DR-11 — additionally enforce the staking-side per-owner
        // enumerable set as the authoritative source of truth (M13 pattern). For
        // present semantics this is redundant with `ownerOf`, but if a future
        // staking upgrade ever wraps ownership through a proxy or share-token,
        // this check guarantees the restaking contract still tracks the staking
        // contract's authoritative ownership view.
        // AUDIT FIX: DR2-08 — distinct typed error so off-chain monitors can
        // distinguish this future-compat divergence from a plain ERC721
        // ownership mismatch. If it ever fires it indicates a TegridyStaking
        // ABI/semantics drift and should page the team.
        if (!staking.holdsToken(msg.sender, _tokenId)) revert StakingOwnershipDesync();

        // Get position data from TegridyStaking
        (uint256 amount, uint256 boostedAmount,,,,,,, , ,) = staking.positions(_tokenId);
        if (amount == 0) revert ZeroAmount();

        // Transfer NFT to this contract — M-16: safeTransferFrom for safe NFT handling
        stakingNFT.safeTransferFrom(msg.sender, address(this), _tokenId);

        // Record restaking info
        // M-27: Safe int256 cast via _safeInt256 helper
        uint256 debtUint = (boostedAmount * accBonusPerShare) / ACC_PRECISION;
        // AUDIT H-06: snapshot unsettledRewards[this] at deposit time so the per-user
        // delta on unrestake is computed against a stable baseline rather than a racy
        // before/after read pair that a concurrent claimUnsettled() can corrupt.
        uint256 unsettledAtDeposit = staking.unsettledRewards(address(this));
        restakers[msg.sender] = RestakeInfo({
            tokenId: _tokenId,
            positionAmount: amount,
            boostedAmount: boostedAmount,
            bonusDebt: _safeInt256(debtUint),
            depositTime: block.timestamp,
            unsettledSnapshot: unsettledAtDeposit
        });

        tokenIdToRestaker[_tokenId] = msg.sender;
        totalRestaked += boostedAmount;
        // AUDIT H-1: track active principal so recoverStuckPrincipal can reserve it.
        totalActivePrincipal += amount;
        // AUDIT H-8: write initial boost checkpoint so RevenueDistributor / other
        // consumers can read historical boost via boostedAmountAt.
        _writeBoostCheckpoint(msg.sender, boostedAmount);

        emit Restaked(msg.sender, _tokenId, amount);
    }

    /// @notice C-05: Refresh cached position data from TegridyStaking
    /// @dev Re-reads staking.positions(tokenId) and updates positionAmount and totalRestaked.
    ///      AUDIT FIX: Claims pending bonus before resetting debt to prevent silent forfeiture.
    /// @dev R014 RETRY (R017): the prior implementation used the `updateBonus`
    ///      modifier which ran `_accrueBonus()` BEFORE the body. When the caller's
    ///      cached boost was stale (e.g., lock decayed in TegridyStaking but not
    ///      yet synced here), the elapsed-period emission was minted into
    ///      `accBonusPerShare` against an INFLATED `totalRestaked` denominator —
    ///      letting the caller siphon honest restakers' share. Fix: drop the
    ///      modifier and branch on `stale`. Stale path settles pending bonus on
    ///      the OLD boost at the PRE-accrue `accBonusPerShare`, anchors
    ///      `bonusDebt` BEFORE transfer (CEI), shrinks `totalRestaked`, then
    ///      runs `_accrueBonusChecked` against the corrected denominator and
    ///      re-anchors `bonusDebt` at the POST-accrue `accBonusPerShare`.
    function refreshPosition() external nonReentrant {
        RestakeInfo storage info = restakers[msg.sender];
        if (info.tokenId == 0) revert NotRestaked();

        uint256 oldAmount = info.positionAmount;
        uint256 oldBoosted = info.boostedAmount;

        // Re-read current position from staking contract
        (uint256 newAmount, uint256 newBoostedAmount,,,,,,, , ,) = staking.positions(info.tokenId);

        // AUDIT FIX: Prevent setting positionAmount to zero (would break bonus calculations)
        if (newAmount == 0) revert ZeroAmount();

        bool stale = (newAmount != info.positionAmount || newBoostedAmount != info.boostedAmount);

        if (stale) {
            // R014 RETRY step 1 — settle pending bonus on OLD boost at the
            // PRE-accrue `accBonusPerShare`. Anchor `info.bonusDebt` BEFORE the
            // external transfer (CEI) so a hostile bonus token cannot re-enter.
            uint256 preBonus;
            if (oldBoosted > 0) {
                int256 preAccum = _safeInt256((oldBoosted * accBonusPerShare) / ACC_PRECISION);
                int256 preDiff = preAccum - info.bonusDebt;
                preBonus = preDiff > 0 ? uint256(preDiff) : 0;
                info.bonusDebt = preAccum; // CEI: anchor BEFORE external call
            }
            if (preBonus > 0) {
                bonusRewardToken.safeTransfer(msg.sender, preBonus);
                totalBonusDistributed += preBonus;
                emit BonusClaimed(msg.sender, preBonus);
            }

            // R014 RETRY step 2 — update cached values and adjust
            // `totalRestaked` (shrink, in the typical decay case).
            // AUDIT FIX: DR2-01 — sync `totalActivePrincipal` to the new
            // cached principal BEFORE overwrite. DR-02 fix sibling-port: every
            // site that overwrites `info.positionAmount` must adjust the
            // running `totalActivePrincipal` total by the delta, otherwise
            // force-closed positions (where `newAmount == 0`) leak `oldAmount`
            // worth of principal into the reservation pool — silently DOS'ing
            // `recoverStuckPrincipal` for honest force-closed users.
            if (oldAmount >= newAmount) {
                uint256 principalDelta = oldAmount - newAmount;
                if (principalDelta <= totalActivePrincipal) {
                    totalActivePrincipal -= principalDelta;
                } else {
                    totalActivePrincipal = 0;
                }
            } else {
                totalActivePrincipal += (newAmount - oldAmount);
            }
            info.positionAmount = newAmount;
            info.boostedAmount = newBoostedAmount;
            _writeBoostCheckpoint(msg.sender, newBoostedAmount); // AUDIT H-8
            totalRestaked = totalRestaked - oldBoosted + newBoostedAmount;

            // R014 RETRY step 3 — accrue against the corrected (smaller)
            // denominator. This is the key reordering: the elapsed-period
            // emission is now divided by the honest `totalRestaked`.
            _accrueBonusChecked();

            // R014 RETRY step 4 — re-anchor `bonusDebt` at POST-accrue on the
            // NEW boost so residual rounding cannot credit emission the caller
            // is no longer entitled to share in.
            uint256 newDebtUint = (newBoostedAmount * accBonusPerShare) / ACC_PRECISION;
            info.bonusDebt = _safeInt256(newDebtUint);
        } else {
            // Non-stale path: cached boost matches the staking contract. Run
            // accrual first, then claim against the user's actual boost at the
            // current `accBonusPerShare`. Behavior matches pre-R014 semantics.
            _accrueBonusChecked();

            int256 accumulated = _safeInt256((info.boostedAmount * accBonusPerShare) / ACC_PRECISION);
            int256 diff = accumulated - info.bonusDebt;
            uint256 bonusPending = diff > 0 ? uint256(diff) : 0;
            info.bonusDebt = accumulated; // CEI: anchor BEFORE external call
            if (bonusPending > 0) {
                bonusRewardToken.safeTransfer(msg.sender, bonusPending);
                totalBonusDistributed += bonusPending;
                emit BonusClaimed(msg.sender, bonusPending);
            }
        }

        emit PositionRefreshed(msg.sender, info.tokenId, oldAmount, newAmount);
    }

    /// @notice Claim base staking rewards + bonus restaking rewards
    /// @dev SECURITY FIX H-03: Auto-refreshes cached position data from TegridyStaking
    ///      before calculating bonus rewards, preventing stale position exploitation.
    /// @dev R014 RETRY (R017): the prior implementation used the `updateBonus`
    ///      modifier which ran `_accrueBonus()` BEFORE the body. With a stale
    ///      cached boost the elapsed-period emission was minted into
    ///      `accBonusPerShare` against an INFLATED `totalRestaked` denominator —
    ///      letting the caller siphon honest restakers' share. Fix: drop the
    ///      modifier and branch on `stale`. The stale path settles the OLD boost
    ///      at PRE-accrue, anchors `bonusDebt` BEFORE transfer (CEI), shrinks
    ///      `totalRestaked`, then runs `_accrueBonusChecked` against the
    ///      corrected denominator and re-anchors `bonusDebt` POST-accrue.
    function claimAll() external nonReentrant {
        RestakeInfo storage info = restakers[msg.sender];
        if (info.tokenId == 0) revert NotRestaked();

        // SECURITY FIX H-03: Auto-refresh cached position data before bonus calculation.
        // Prevents earning bonus rewards on phantom capital after underlying position changes.
        // AUDIT FIX M-07: Also refresh when boostedAmount changes (e.g., JBAC revalidation,
        // lock extension) even if positionAmount is unchanged. Previously boost-only changes
        // were invisible to auto-refresh, allowing stale bonus accrual.
        {
            (uint256 currentAmount, uint256 currentBoosted,,,,,,, , ,) = staking.positions(info.tokenId);
            bool stale = (currentAmount != info.positionAmount || currentBoosted != info.boostedAmount);

            if (stale) {
                // R014 RETRY step 1 — settle pending bonus on the OLD boost at
                // the PRE-accrue `accBonusPerShare`. Anchor `info.bonusDebt`
                // BEFORE the external transfer (CEI).
                uint256 oldBoosted = info.boostedAmount;
                uint256 preBonus;
                if (oldBoosted > 0) {
                    int256 preAccum = _safeInt256((oldBoosted * accBonusPerShare) / ACC_PRECISION);
                    int256 preDiff = preAccum - info.bonusDebt;
                    preBonus = preDiff > 0 ? uint256(preDiff) : 0;
                    info.bonusDebt = preAccum; // CEI: anchor BEFORE external call
                }
                if (preBonus > 0) {
                    bonusRewardToken.safeTransfer(msg.sender, preBonus);
                    totalBonusDistributed += preBonus;
                    emit BonusClaimed(msg.sender, preBonus);
                }

                // R014 RETRY step 2 — update cached values + adjust
                // `totalRestaked` (shrink in typical decay case). Handles both
                // the position-zeroed (force-closed) sub-case and the normal
                // refresh sub-case in a single arithmetic update.
                uint256 oldAmt = info.positionAmount;
                // AUDIT FIX: DR2-01 — sync `totalActivePrincipal` to the new
                // cached `info.positionAmount` BEFORE the overwrite. Pre-fix,
                // `info.positionAmount = currentAmount` (where currentAmount = 0
                // for force-closed positions) would orphan `oldAmt` worth of
                // principal in `totalActivePrincipal`, silently DOS'ing
                // `recoverStuckPrincipal` for honest force-closed users (the
                // entrypoint's `othersPrincipal` reservation grows unbounded).
                // DR-02 fixed this for `emergencyForceReturn`; DR2-01 ports the
                // same pattern to all four sibling stale-paths.
                if (oldAmt >= currentAmount) {
                    uint256 principalDelta = oldAmt - currentAmount;
                    if (principalDelta <= totalActivePrincipal) {
                        totalActivePrincipal -= principalDelta;
                    } else {
                        totalActivePrincipal = 0;
                    }
                } else {
                    totalActivePrincipal += (currentAmount - oldAmt);
                }
                info.positionAmount = currentAmount;
                info.boostedAmount = currentBoosted;
                _writeBoostCheckpoint(msg.sender, currentBoosted); // AUDIT H-8
                totalRestaked = totalRestaked - oldBoosted + currentBoosted;

                // R014 RETRY step 3 — accrue against the corrected (smaller)
                // denominator. The micro-period elapsed since
                // `lastBonusRewardTime` is now divided by the honest
                // `totalRestaked`, so honest restakers earn their fair share.
                _accrueBonusChecked();

                // R014 RETRY step 4 — re-anchor `bonusDebt` at POST-accrue on
                // the NEW boost so residual rounding cannot credit emission the
                // caller is no longer entitled to share in.
                if (currentBoosted > 0) {
                    uint256 newDebtUint = (currentBoosted * accBonusPerShare) / ACC_PRECISION;
                    info.bonusDebt = _safeInt256(newDebtUint);
                } else {
                    info.bonusDebt = 0;
                }

                emit PositionRefreshed(msg.sender, info.tokenId, oldAmt, currentAmount);
            } else {
                // Non-stale path: cached boost matches the staking contract.
                // Run accrual first; the post-accrue claim further down uses
                // the resulting `accBonusPerShare` against the user's actual
                // boost. Behavior matches pre-R014 semantics.
                _accrueBonusChecked();
            }
        }

        // 1. Claim base rewards from TegridyStaking (wrapped in try/catch so bonus still works)
        // Uses the return value from claim() instead of balance deltas to prevent
        // MEV sandwich attacks that inflate rewards via concurrent transfers.
        try staking.getReward(info.tokenId) returns (uint256 baseEarned) {
            // Forward base rewards to user
            if (baseEarned > 0) {
                rewardToken.safeTransfer(msg.sender, baseEarned);
                emit BaseClaimed(msg.sender, baseEarned);
            }
        } catch {
            emit BaseClaimFailed(info.tokenId, msg.sender);
        }

        // AUDIT FIX: DR2-04 — re-read staking-side `boostedAmount` AFTER
        // `staking.getReward` to detect autoMaxLock-induced boost restoration.
        // When a previously-decayed autoMaxLock position has its lock extended
        // by `getReward`, the staking-side branch re-applies MAX_BOOST. Pre-fix,
        // the stale-path above had just zeroed `info.boostedAmount` and
        // dropped the user from `totalRestaked`, so the user silently earned
        // ZERO bonus emission until they manually called `refreshPosition`.
        // The discovery surface is poor: `pendingBonus` returns 0 honestly,
        // and most users wouldn't notice the APR drop. Re-syncing here keeps
        // the restaker in the bonus accrual loop without manual intervention.
        try staking.positions(info.tokenId) returns (
            uint256, uint256 postClaimBoosted, int256, uint256, uint256, uint256, bool, bool, uint256, uint256, bool
        ) {
            if (postClaimBoosted > 0 && postClaimBoosted != info.boostedAmount) {
                uint256 oldB = info.boostedAmount;
                info.boostedAmount = postClaimBoosted;
                _writeBoostCheckpoint(msg.sender, postClaimBoosted);
                totalRestaked = totalRestaked - oldB + postClaimBoosted;
                // Re-anchor bonusDebt at current accBonusPerShare on the new
                // boost so the restaker doesn't immediately accrue against
                // emission they haven't earned (the upcoming bonus claim
                // would otherwise mint a phantom delta).
                info.bonusDebt = _safeInt256((postClaimBoosted * accBonusPerShare) / ACC_PRECISION);
                // Sync positionAmount as well in case the staking-side mutated
                // it during getReward (defensive — typical autoMaxLock branch
                // doesn't, but keeps the restaking cache consistent).
                (uint256 postClaimAmount,,,,,,,,, ,) = staking.positions(info.tokenId);
                if (postClaimAmount != info.positionAmount) {
                    uint256 oldP = info.positionAmount;
                    if (oldP >= postClaimAmount) {
                        uint256 delta = oldP - postClaimAmount;
                        if (delta <= totalActivePrincipal) {
                            totalActivePrincipal -= delta;
                        } else {
                            totalActivePrincipal = 0;
                        }
                    } else {
                        totalActivePrincipal += (postClaimAmount - oldP);
                    }
                    info.positionAmount = postClaimAmount;
                }
            }
        } catch {
            // If the post-claim re-read reverts, leave the cache as-is — the
            // user can always call refreshPosition manually.
        }

        // AUDIT FIX H-02: Forward any unforwarded base rewards (from revalidateBoost or other external calls)
        uint256 unforwarded = unforwardedBaseRewards[msg.sender];
        if (unforwarded > 0) {
            uint256 available = rewardToken.balanceOf(address(this));
            uint256 actual = unforwarded > available ? available : unforwarded;
            // AUDIT FIX v3: Only subtract the amount actually transferred to prevent silent reward loss
            unforwardedBaseRewards[msg.sender] = unforwarded - actual;
            // SECURITY FIX: Track total unforwarded for attribution cap
            if (totalUnforwardedBase >= actual) totalUnforwardedBase -= actual;
            if (actual > 0) {
                rewardToken.safeTransfer(msg.sender, actual);
                emit BaseClaimed(msg.sender, actual);
            }
        }

        // 2. Claim bonus rewards (skip if auto-refresh above already settled and reset debt)
        // SECURITY FIX C4: Explicit guard — only claim if debt drift exists after refresh
        // M-27: Safe int256 cast via _safeInt256 helper
        if (info.boostedAmount > 0) {
            int256 accumulated = _safeInt256((info.boostedAmount * accBonusPerShare) / ACC_PRECISION);
            int256 diff = accumulated - info.bonusDebt;
            info.bonusDebt = accumulated;
            uint256 bonusPending = diff > 0 ? uint256(diff) : 0;

            if (bonusPending > 0) {
                bonusRewardToken.safeTransfer(msg.sender, bonusPending);
                totalBonusDistributed += bonusPending;
                emit BonusClaimed(msg.sender, bonusPending);
            }
        }
    }

    /// @notice Withdraw your NFT and stop restaking
    /// @dev R014 RETRY (R017): the prior implementation used the `updateBonus`
    ///      modifier which ran `_accrueBonus()` BEFORE the body. With a stale
    ///      cached boost the elapsed-period emission was minted into
    ///      `accBonusPerShare` against an INFLATED `totalRestaked` denominator —
    ///      letting the caller siphon honest restakers' share at exit time.
    ///      Fix: drop the modifier and branch on `stale`. Stale path settles the
    ///      OLD boost at PRE-accrue, anchors `bonusDebt` BEFORE transfer (CEI),
    ///      shrinks `totalRestaked`, then runs `_accrueBonusChecked` against the
    ///      corrected denominator and re-anchors `bonusDebt` POST-accrue.
    function unrestake() external nonReentrant {
        RestakeInfo storage info = restakers[msg.sender];
        if (info.tokenId == 0) revert NotRestaked();

        // AUDIT FIX: DR2-01 — capture the cached principal BEFORE the stale-path
        // can overwrite it. The post-stale-block `totalActivePrincipal -= ...`
        // decrement (~50 lines below) must use this captured value, not the
        // post-overwrite `info.positionAmount` (which may be 0 for force-closed
        // positions, leaking the original principal into `totalActivePrincipal`).
        uint256 cachedPrincipalAtEntry = info.positionAmount;

        // S2-03: Auto-refresh cached position data before bonus calculation (same as claimAll)
        // AUDIT FIX M-07: Also compare boostedAmount to catch boost-only changes
        {
            (uint256 currentAmount, uint256 currentBoosted,,,,,,, , ,) = staking.positions(info.tokenId);
            bool stale = (currentAmount != info.positionAmount || currentBoosted != info.boostedAmount);

            if (stale) {
                // R014 RETRY step 1 — settle pending bonus on OLD boost at the
                // PRE-accrue `accBonusPerShare`. Anchor `info.bonusDebt` BEFORE
                // the external transfer (CEI).
                uint256 oldBoosted = info.boostedAmount;
                uint256 preBonus;
                if (oldBoosted > 0) {
                    int256 preAccum = _safeInt256((oldBoosted * accBonusPerShare) / ACC_PRECISION);
                    int256 preDiff = preAccum - info.bonusDebt;
                    preBonus = preDiff > 0 ? uint256(preDiff) : 0;
                    info.bonusDebt = preAccum; // CEI: anchor BEFORE external call
                }
                if (preBonus > 0) {
                    bonusRewardToken.safeTransfer(msg.sender, preBonus);
                    totalBonusDistributed += preBonus;
                    emit BonusClaimed(msg.sender, preBonus);
                }

                // R014 RETRY step 2 — update cached values + adjust
                // `totalRestaked` (shrink in typical decay case).
                uint256 oldAmount = info.positionAmount;
                info.positionAmount = currentAmount;
                info.boostedAmount = currentBoosted;
                _writeBoostCheckpoint(msg.sender, currentBoosted); // AUDIT H-8
                totalRestaked = totalRestaked - oldBoosted + currentBoosted;

                // R014 RETRY step 3 — accrue against the corrected (smaller)
                // denominator.
                _accrueBonusChecked();

                // R014 RETRY step 4 — re-anchor `bonusDebt` at POST-accrue on
                // the NEW boost.
                if (currentBoosted > 0) {
                    uint256 newDebtUint = (currentBoosted * accBonusPerShare) / ACC_PRECISION;
                    info.bonusDebt = _safeInt256(newDebtUint);
                } else {
                    info.bonusDebt = 0;
                }
                emit PositionRefreshed(msg.sender, info.tokenId, oldAmount, currentAmount);
            } else {
                // Non-stale path: run accrual first, then claim against current
                // `accBonusPerShare` with the user's actual boost.
                _accrueBonusChecked();
            }
        }

        uint256 tokenId = info.tokenId;
        uint256 totalBaseEarned = 0;

        // Disable autoMaxLock before withdrawing to prevent perpetual lock extension trap
        // AUDIT FIX H-01: Wrapped in try/catch so unrestake() works even if staking is paused
        // (toggleAutoMaxLock has whenNotPaused modifier). Without this, paused staking
        // would force users into emergencyWithdrawNFT() which forfeits bonus rewards.
        (,,,,,, bool autoMaxLock,,,,) = staking.positions(tokenId);
        if (autoMaxLock) {
            try staking.toggleAutoMaxLock(tokenId) {} catch {
                emit BaseClaimFailed(tokenId, msg.sender);
            }
        }

        // Claim any remaining base rewards (wrapped in try/catch so unrestake works even if staking is paused)
        // Uses the return value from claim() instead of balance deltas to prevent
        // MEV sandwich attacks that inflate rewards via concurrent transfers.
        try staking.getReward(tokenId) returns (uint256 baseEarned) {
            totalBaseEarned = baseEarned;
        } catch { emit BaseClaimFailed(tokenId, msg.sender); }

        // Forward base rewards to user
        if (totalBaseEarned > 0) {
            rewardToken.safeTransfer(msg.sender, totalBaseEarned);
            emit BaseClaimed(msg.sender, totalBaseEarned);
        }

        // Claim bonus rewards
        // M-27: Safe int256 cast via _safeInt256 helper
        int256 accumulated = _safeInt256((info.boostedAmount * accBonusPerShare) / ACC_PRECISION);
        int256 diff = accumulated - info.bonusDebt;
        info.bonusDebt = accumulated;
        uint256 bonusPending = diff > 0 ? uint256(diff) : 0;
        if (bonusPending > 0) {
            bonusRewardToken.safeTransfer(msg.sender, bonusPending);
            totalBonusDistributed += bonusPending;
            emit BonusClaimed(msg.sender, bonusPending);
        }

        // Update state
        // AUDIT H-1: release this user's principal reservation before transferring the NFT.
        // AUDIT FIX: DR2-01 — use the principal captured BEFORE the stale-path
        // mutated `info.positionAmount`. Pre-fix, when the stale-path overwrote
        // `info.positionAmount = currentAmount` (== 0 for force-closed
        // positions), this decrement subtracted 0 and the original principal
        // leaked into `totalActivePrincipal` permanently — silently DOS'ing
        // `recoverStuckPrincipal` for honest force-closed users.
        if (cachedPrincipalAtEntry <= totalActivePrincipal) {
            totalActivePrincipal -= cachedPrincipalAtEntry;
        } else {
            totalActivePrincipal = 0;
        }
        totalRestaked -= info.boostedAmount;
        delete tokenIdToRestaker[tokenId];
        delete restakers[msg.sender];
        _writeBoostCheckpoint(msg.sender, 0); // AUDIT H-8: zero historical boost on unrestake

        // AUDIT FIX C-1: pull this tokenId's pre-transfer kick credits BEFORE
        // returning the NFT. Per-tokenId attribution (added to TegridyStaking)
        // ensures we drain ONLY this tokenId's share of the
        // `unsettledRewards[restakingContract]` bucket — not other restakers'
        // shares as the prior snapshot/delta path did under multi-restaker
        // contention. `claimUnsettledForTokenId` transfers directly to msg.sender
        // and is a no-op (returns 0) when there's nothing attributed.
        uint256 prePaid;
        try staking.claimUnsettledForTokenId(tokenId, msg.sender) returns (uint256 _p) {
            prePaid = _p;
        } catch {
            prePaid = 0;
        }

        // Return NFT to user. The transfer triggers `_settleRewardsOnTransfer`
        // on the staking side, which credits any final-period accrual to BOTH
        // the holder bucket AND `unsettledRewardsByTokenId[tokenId]` (for the
        // restakingContract → user transfer leg).
        stakingNFT.safeTransferFrom(address(this), msg.sender, tokenId);

        // AUDIT FIX C-1: pull the just-credited per-tokenId share from the
        // transfer hook, again going directly to msg.sender. Two-step claim
        // (pre + post) is what makes per-tokenId attribution exact.
        uint256 postPaid;
        try staking.claimUnsettledForTokenId(tokenId, msg.sender) returns (uint256 _p2) {
            postPaid = _p2;
        } catch {
            postPaid = 0;
        }

        uint256 totalUnsettled = prePaid + postPaid;

        // Recover any previously deferred share from a prior under-funded
        // claim. `pendingUnsettledRewards` is preserved as a deferred-payment
        // mechanism — orthogonal to the per-tokenId attribution fix. We pull
        // from this contract's own balance (not from the staking bucket) since
        // that balance was funded by an earlier per-tokenId pull that the
        // staking pool couldn't fully service.
        uint256 priorPending = pendingUnsettledRewards[msg.sender];
        if (priorPending > 0) {
            pendingUnsettledRewards[msg.sender] = 0;
            totalPendingUnsettled -= priorPending;
            uint256 localBal = rewardToken.balanceOf(address(this));
            uint256 paid = priorPending > localBal ? localBal : priorPending;
            uint256 stillOwed = priorPending - paid;
            if (stillOwed > 0) {
                pendingUnsettledRewards[msg.sender] = stillOwed;
                totalPendingUnsettled += stillOwed;
            }
            if (paid > 0) {
                rewardToken.safeTransfer(msg.sender, paid);
                totalUnsettled += paid;
            }
        }

        if (totalUnsettled > 0) {
            emit UnsettledRecovered(msg.sender, totalUnsettled);
        }

        // Forward any unforwarded base rewards for this user (from revalidateBoost or other external calls)
        uint256 userUnforwarded = unforwardedBaseRewards[msg.sender];
        if (userUnforwarded > 0) {
            uint256 remainingBase = rewardToken.balanceOf(address(this));
            uint256 actual = userUnforwarded > remainingBase ? remainingBase : userUnforwarded;
            unforwardedBaseRewards[msg.sender] -= actual;
            if (totalUnforwardedBase >= actual) totalUnforwardedBase -= actual;
            if (actual > 0) {
                rewardToken.safeTransfer(msg.sender, actual);
                emit BaseClaimed(msg.sender, actual);
            }
        }

        emit Unrestaked(msg.sender, tokenId);
    }

    /// @notice Recover unsettled rewards that could not be forwarded during a prior unrestake
    ///         (e.g., because another user's concurrent unrestake drained the shared bucket first).
    /// @dev AUDIT FIX: DEEP-DR-01 — mirror `recoverStuckPrincipal`'s reservation
    ///      logic. Pre-fix, this entrypoint paid `min(owed, balance)` directly,
    ///      with no protection for other users' attributed `unforwardedBaseRewards`
    ///      or for still-active restakers' principal. An attacker (or unlucky
    ///      sequencing) could drain rewardToken earmarked for honest users:
    ///      Bob has `unforwardedBaseRewards` after `proposeAttributeStuckRewards`,
    ///      Carol has shortfall in `pendingUnsettledRewards`, and Carol's
    ///      `claimPendingUnsettled` payout is computed as `min(owed, balance)` —
    ///      drains Bob's attributed share AND every active restaker's principal
    ///      reservation. The fix subtracts `totalUnforwardedBase + totalActivePrincipal`
    ///      from `available` BEFORE payout. Caller's own pending share is
    ///      decremented from `totalPendingUnsettled` AFTER computing `available`
    ///      to keep the reservation honest in the multi-claimer race.
    function claimPendingUnsettled() external nonReentrant {
        uint256 owed = pendingUnsettledRewards[msg.sender];
        if (owed == 0) revert ZeroAmount();

        uint256 currentUnsettled = staking.unsettledRewards(address(this));
        if (currentUnsettled > 0) {
            try staking.claimUnsettled() {} catch {}
        }

        // AUDIT FIX: DEEP-DR-01 — reserve attributions and active principal so
        // this caller cannot drain rewardToken earmarked for other users. The
        // reservation INTENTIONALLY does not subtract the caller's own
        // `pendingUnsettledRewards` share — `totalPendingUnsettled` already
        // INCLUDES this caller, and the payout below is what releases it.
        uint256 balance = rewardToken.balanceOf(address(this));
        uint256 reserved = totalUnforwardedBase + totalActivePrincipal;
        uint256 available = balance > reserved ? balance - reserved : 0;
        uint256 payout = owed > available ? available : owed;
        pendingUnsettledRewards[msg.sender] = owed - payout;
        // SECURITY FIX: Decrement totalPendingUnsettled by the amount paid out
        if (payout > 0) {
            totalPendingUnsettled -= payout;
            rewardToken.safeTransfer(msg.sender, payout);
            emit UnsettledRecovered(msg.sender, payout);
        }
    }

    // ─── Admin ──────────────────────────────────────────────────────

    /// @notice Fund the bonus reward pool
    /// M-01, M-04: Added updateBonus and nonReentrant modifiers
    function fundBonus(uint256 _amount) external nonReentrant updateBonus {
        if (_amount == 0) revert ZeroAmount();
        bonusRewardToken.safeTransferFrom(msg.sender, address(this), _amount);
        totalBonusFunded += _amount;
        emit BonusFunded(_amount);
    }

    /// @notice DEPRECATED: Use proposeBonusRate + executeBonusRateChange instead.
    function setBonusRewardPerSecond(uint256) external pure {
        revert("DEPRECATED: use proposeBonusRate()");
    }

    /// @notice SECURITY FIX #13: Propose a new bonus reward rate (subject to 48h timelock)
    /// @dev AUDIT FIX: DEEP-DR-07 — gate proposals behind a 24h cooldown shared
    ///      with `cancelBonusRateProposal` so a captured signer cannot loop
    ///      propose+cancel to keep rate-change state churning indefinitely.
    ///      Order of checks:
    ///        1. RateTooHigh (input validation)
    ///        2. _propose's ExistingProposalPending (legacy back-compat — preserves
    ///           audit195 test suite expectations)
    ///        3. cooldown gate (only relevant after a previous propose+cancel)
    ///      The cooldown only applies AFTER the first action (lastBonusRateActionAt
    ///      is left zero at deploy so the first rate proposal is unblocked).
    function proposeBonusRate(uint256 _rate) external onlyOwner updateBonus {
        if (_rate > MAX_BONUS_REWARD_RATE) revert RateTooHigh();
        // _propose handles the ExistingProposalPending check internally.
        // We delay the cooldown check until AFTER that so the legacy
        // "second propose reverts with ExistingProposalPending" test passes.
        if (lastBonusRateActionAt != 0 &&
            _executeAfter[BONUS_RATE_CHANGE] == 0 &&
            block.timestamp < lastBonusRateActionAt + BONUS_RATE_ACTION_COOLDOWN) {
            revert BonusRateActionCooldown();
        }
        pendingBonusRate = _rate;
        lastBonusRateActionAt = block.timestamp;
        _propose(BONUS_RATE_CHANGE, BONUS_RATE_TIMELOCK);
        emit BonusRateProposed(_rate, _executeAfter[BONUS_RATE_CHANGE]);
    }

    /// @notice SECURITY FIX #13: Execute pending bonus rate change after timelock
    function executeBonusRateChange() external onlyOwner updateBonus {
        _execute(BONUS_RATE_CHANGE);
        bonusRewardPerSecond = pendingBonusRate;
        emit BonusRateExecuted(pendingBonusRate);
        pendingBonusRate = 0;
    }

    /// @notice M-03: Cancel a pending bonus rate proposal
    /// @dev AUDIT FIX: DR2-05 — REMOVED the cooldown gate from
    ///      `cancelBonusRateProposal`. The DR-07 v1 fix gated BOTH propose and
    ///      cancel behind the same 24h cooldown. While that stopped the
    ///      propose+cancel churn loop, it also blocked the FIRST cancel within
    ///      24h of a propose — halving the multisig's defensive responsiveness
    ///      against a captured-signer malicious propose. The asymmetric trade
    ///      was wrong: defensive cancel is exactly the action the multisig
    ///      MUST be able to take immediately when it spots a hostile proposal.
    ///
    ///      Fix: cancel is now always allowed. Anti-churn protection remains
    ///      via the propose-side cooldown — a compromised signer cannot
    ///      indefinitely re-propose at sub-24h cadence even if they cancel
    ///      between proposes. Pattern of record: OZ TimelockController allows
    ///      cancel without cooldown; only propose is rate-limited.
    function cancelBonusRateProposal() external onlyOwner {
        _cancel(BONUS_RATE_CHANGE);
        uint256 cancelledRate = pendingBonusRate;
        pendingBonusRate = 0;
        // AUDIT FIX: DR2-05 — still update `lastBonusRateActionAt` on cancel so
        // the propose-side cooldown observes this cancel as a recent action.
        // The next propose remains gated by the 24h window from this cancel
        // (anti-churn). Defensive cancel itself is unblocked.
        lastBonusRateActionAt = block.timestamp;
        emit BonusRateCancelled(cancelledRate);
    }

    /// @notice AUDIT FIX H-02: Sweep stuck reward tokens (from revalidateBoost or other external calls).
    ///         Base reward tokens (rewardToken) may arrive outside of claimAll flows and become stuck.
    ///         Cannot sweep bonusRewardToken to protect the bonus reward pool.
    function sweepStuckRewards(address _token) external onlyOwner {
        if (_token == address(bonusRewardToken)) revert CannotSweepBonusToken();
        // AUDIT FIX v2: Block sweeping base reward token to protect user rewards in transit
        if (_token == address(rewardToken)) revert CannotSweepRewardToken();
        uint256 balance = IERC20(_token).balanceOf(address(this));
        if (balance > 0) {
            IERC20(_token).safeTransfer(owner(), balance);
        }
    }

    /// @notice AUDIT FIX H-06: Recover stuck principal TOWELI when the underlying staking
    ///         position was force-closed (e.g., via emergencyExitPosition) while the NFT was
    ///         held by this contract. The principal is sent to the restaking contract as the
    ///         NFT owner, but the original restaker has no path to retrieve it.
    ///         Callable by a restaker whose position amount dropped to zero.
    function recoverStuckPrincipal() external nonReentrant {
        RestakeInfo storage info = restakers[msg.sender];
        if (info.tokenId == 0) revert NotRestaked();

        // H-01 FIX: Prevent duplicate recovery
        require(!hasRecoveredPrincipal[msg.sender], "ALREADY_RECOVERED");

        // Verify the underlying position is actually zeroed out (force-closed)
        (uint256 currentAmount,,,,,,,,, , ) = staking.positions(info.tokenId);
        require(currentAmount == 0, "POSITION_STILL_ACTIVE");

        // Calculate how much rewardToken (TOWELI) this contract has beyond tracked obligations.
        // SECURITY FIX: Include totalPendingUnsettled in reserved amount to protect other
        // users' unclaimed rewards.
        // AUDIT H-1: also reserve the principal of all still-active restakers so a burst
        // of force-closed users competing for the recoverable pool can't let the first
        // callers drain everything and leave later callers with zero. We subtract the
        // caller's own positionAmount from the reservation because they're about to be
        // paid out of that very amount; if we didn't subtract, a solo recoverer would
        // see payout=0. The subtraction is safe because info.positionAmount <=
        // totalActivePrincipal (invariant maintained by restake/unrestake/emergencyWithdrawNFT).
        uint256 originalAmount = info.positionAmount;
        uint256 balance = rewardToken.balanceOf(address(this));
        uint256 othersPrincipal = totalActivePrincipal >= originalAmount
            ? totalActivePrincipal - originalAmount
            : 0;
        uint256 reserved = totalUnforwardedBase + totalPendingUnsettled + othersPrincipal;
        uint256 recoverable = balance > reserved ? balance - reserved : 0;

        // Cap to the user's original position amount (they shouldn't get more than they staked)
        uint256 payout = recoverable > originalAmount ? originalAmount : recoverable;

        // C-01 FIX: Require non-zero payout. Without this, calling when balance is fully reserved
        // sets hasRecoveredPrincipal=true and deletes state, permanently locking out the user.
        require(payout > 0, "NO_RECOVERABLE_BALANCE");

        // H-01 FIX: Mark as recovered before transfer (CEI pattern)
        hasRecoveredPrincipal[msg.sender] = true;

        // H-02 FIX: Clear restaker state to prevent repeated drains.
        // Must be done BEFORE the transfer (CEI pattern).
        uint256 boosted = info.boostedAmount;
        if (boosted <= totalRestaked) {
            totalRestaked -= boosted;
        }
        // AUDIT H-1: release this user's principal reservation (guarded against underflow
        // in the exotic case where totalActivePrincipal got out of sync).
        if (originalAmount <= totalActivePrincipal) {
            totalActivePrincipal -= originalAmount;
        } else {
            totalActivePrincipal = 0;
        }
        delete tokenIdToRestaker[info.tokenId];
        delete restakers[msg.sender];
        _writeBoostCheckpoint(msg.sender, 0); // AUDIT H-8

        if (payout > 0) {
            totalRecoveredPrincipal += payout;
            rewardToken.safeTransfer(msg.sender, payout);
            emit BaseClaimed(msg.sender, payout);
        }
    }

    /// @notice SECURITY FIX: Propose attributing stuck base rewards (24h timelock).
    ///         When revalidateBoost() is called externally on a restaked NFT, _getReward()
    ///         sends TOWELI to this contract with no way to identify the recipient.
    ///         Owner proposes attribution, then executes after 24h delay.
    /// @param _restaker The restaker address to credit
    /// @param _amount The amount of rewardToken to attribute
    function proposeAttributeStuckRewards(address _restaker, uint256 _amount) external onlyOwner {
        if (restakers[_restaker].tokenId == 0) revert NotRestaked();
        if (_amount == 0) revert ZeroAmount();
        pendingAttribution = PendingAttribution({
            restaker: _restaker,
            amount: _amount
        });
        _propose(ATTRIBUTION_CHANGE, ATTRIBUTE_TIMELOCK);
        emit AttributionProposed(_restaker, _amount, _executeAfter[ATTRIBUTION_CHANGE]);
    }

    /// @notice Execute a previously proposed stuck reward attribution after the 24h timelock.
    function executeAttributeStuckRewards() external onlyOwner {
        _execute(ATTRIBUTION_CHANGE);
        PendingAttribution memory p = pendingAttribution;
        if (restakers[p.restaker].tokenId == 0) revert NotRestaked();
        // Cap attribution to actual unattributed rewardToken balance.
        uint256 balance = rewardToken.balanceOf(address(this));
        uint256 unattributed = balance > totalUnforwardedBase ? balance - totalUnforwardedBase : 0;
        require(p.amount <= unattributed, "EXCEEDS_UNATTRIBUTED");
        unforwardedBaseRewards[p.restaker] += p.amount;
        totalUnforwardedBase += p.amount;
        delete pendingAttribution;
        emit StuckBaseRewardsAttributed(p.restaker, p.amount);
    }

    /// @notice Cancel a pending stuck reward attribution proposal.
    function cancelAttributeStuckRewards() external onlyOwner {
        _cancel(ATTRIBUTION_CHANGE);
        PendingAttribution memory p = pendingAttribution;
        delete pendingAttribution;
        emit AttributionCancelled(p.restaker, p.amount);
    }

    /// @notice SECURITY FIX #12: Emergency withdraw NFT without attempting reward calculations.
    ///         Forfeits all pending bonus rewards. Use if reward math is broken.
    /// H-02: Added updateBonus modifier so accBonusPerShare is current before state changes
    /// @dev AUDIT FIX: Removed updateBonus modifier — if bonusRewardToken is paused/blacklisted,
    ///      updateBonus would revert on balanceOf(), permanently bricking this emergency exit.
    ///      User forfeits bonus anyway, so skipping the update is safe.
    function emergencyWithdrawNFT() external nonReentrant {
        RestakeInfo storage info = restakers[msg.sender];
        if (info.tokenId == 0) revert NotRestaked();

        uint256 tokenId = info.tokenId;
        // AUDIT H-1: release this user's principal reservation.
        totalActivePrincipal -= info.positionAmount;
        totalRestaked -= info.boostedAmount;
        delete tokenIdToRestaker[tokenId];
        delete restakers[msg.sender];
        _writeBoostCheckpoint(msg.sender, 0); // AUDIT H-8

        // AUDIT FIX C-1: pull per-tokenId pre-transfer kick credits before
        // returning the NFT. Same exact pattern as `unrestake()` — per-NFT
        // attribution on the staking side (`unsettledRewardsByTokenId`)
        // prevents the prior multi-restaker race where the snapshot/delta
        // path drained other restakers' shares from the shared
        // `unsettledRewards[restakingContract]` bucket.
        uint256 prePaid;
        try staking.claimUnsettledForTokenId(tokenId, msg.sender) returns (uint256 _p) {
            prePaid = _p;
        } catch {
            prePaid = 0;
        }

        // Return NFT to user. The transfer triggers `_settleRewardsOnTransfer`
        // which credits any final-period accrual to BOTH holder bucket AND
        // `unsettledRewardsByTokenId[tokenId]`.
        stakingNFT.safeTransferFrom(address(this), msg.sender, tokenId);

        uint256 postPaid;
        try staking.claimUnsettledForTokenId(tokenId, msg.sender) returns (uint256 _p2) {
            postPaid = _p2;
        } catch {
            postPaid = 0;
        }

        uint256 totalUnsettled = prePaid + postPaid;

        // Recover any previously deferred share. Same logic as `unrestake()`.
        uint256 priorPending = pendingUnsettledRewards[msg.sender];
        if (priorPending > 0) {
            pendingUnsettledRewards[msg.sender] = 0;
            totalPendingUnsettled -= priorPending;
            uint256 localBal = rewardToken.balanceOf(address(this));
            uint256 paid = priorPending > localBal ? localBal : priorPending;
            uint256 stillOwed = priorPending - paid;
            if (stillOwed > 0) {
                pendingUnsettledRewards[msg.sender] = stillOwed;
                totalPendingUnsettled += stillOwed;
            }
            if (paid > 0) {
                rewardToken.safeTransfer(msg.sender, paid);
                totalUnsettled += paid;
            }
        }

        if (totalUnsettled > 0) {
            emit UnsettledRecovered(msg.sender, totalUnsettled);
        }

        // S2-05: Forward any unforwarded base rewards before clearing state
        uint256 userUnforwarded = unforwardedBaseRewards[msg.sender];
        if (userUnforwarded > 0) {
            uint256 remainingBase = rewardToken.balanceOf(address(this));
            uint256 actual = userUnforwarded > remainingBase ? remainingBase : userUnforwarded;
            unforwardedBaseRewards[msg.sender] -= actual;
            if (totalUnforwardedBase >= actual) totalUnforwardedBase -= actual;
            if (actual > 0) {
                rewardToken.safeTransfer(msg.sender, actual);
                emit BaseClaimed(msg.sender, actual);
            }
        }

        emit EmergencyWithdraw(msg.sender, tokenId);
    }

    // ─── Pause ────────────────────────────────────────────────────────

    /// @notice AUDIT FIX: Pause restaking to halt new deposits during emergencies
    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    // ─── Rescue ──────────────────────────────────────────────────────

    /// @notice AUDIT FIX: Rescue NFTs accidentally sent via safeTransferFrom (not through restake())
    /// @param _tokenId The NFT token ID to rescue
    /// @param _to The address to send the NFT to
    function rescueNFT(uint256 _tokenId, address _to) external onlyOwner {
        require(tokenIdToRestaker[_tokenId] == address(0), "ACTIVELY_RESTAKED");
        require(_to != address(0), "ZERO_ADDRESS");
        stakingNFT.safeTransferFrom(address(this), _to, _tokenId); // M-16: safeTransferFrom for NFT returns
    }

    // ─── H-05: Emergency Force Return ──────────────────────────────

    /// @notice H-05: Emergency force-return a staking NFT to the restaker even if the staking contract is broken.
    /// @dev onlyOwner + whenPaused. Uses try/catch on the NFT transfer — if transfer fails,
    ///      the restaking position is still cleaned up so the user's bonus rewards are settled.
    /// @param tokenId The tsTOWELI NFT token ID to force-return
    function emergencyForceReturn(uint256 tokenId) external onlyOwner whenPaused nonReentrant {
        // H-02 FIX: Rate-limit emergency force returns
        require(block.timestamp >= lastForceReturnTime + FORCE_RETURN_COOLDOWN, "FORCE_RETURN_COOLDOWN");
        lastForceReturnTime = block.timestamp;

        address restaker = tokenIdToRestaker[tokenId];
        if (restaker == address(0)) revert NotRestakedToken();

        RestakeInfo storage info = restakers[restaker];

        // AUDIT FIX: DEEP-DR-03 / DEEP-DR-06 — delegate accrual to
        // `_accrueBonusChecked()` instead of inlining the unguarded logic.
        // The wrapped path:
        //   - is monotonicity-checked (any subclass that decrements
        //     accBonusPerShare trips `AccrueNotMonotone()` — DEEP-DR-03), and
        //   - wraps `bonusRewardToken.balanceOf` in try/catch via `_accrueBonus`
        //     (so a hostile or paused bonus token cannot brick the emergency
        //     exit — DEEP-DR-06).
        // Pre-fix, both protections existed in the modifier path but were absent
        // from this critical-path inline copy.
        _accrueBonusChecked();

        // Settle any pending bonus rewards for the restaker
        if (info.boostedAmount > 0) {
            int256 accumulated = _safeInt256((info.boostedAmount * accBonusPerShare) / ACC_PRECISION);
            int256 diff = accumulated - info.bonusDebt;
            uint256 bonusPending = diff > 0 ? uint256(diff) : 0;
            if (bonusPending > 0) {
                bonusRewardToken.safeTransfer(restaker, bonusPending);
                totalBonusDistributed += bonusPending;
                emit BonusClaimed(restaker, bonusPending);
            }
        }

        // Forward any unforwarded base rewards
        uint256 userUnforwarded = unforwardedBaseRewards[restaker];
        if (userUnforwarded > 0) {
            uint256 remainingBase = rewardToken.balanceOf(address(this));
            uint256 actual = userUnforwarded > remainingBase ? remainingBase : userUnforwarded;
            unforwardedBaseRewards[restaker] -= actual;
            if (totalUnforwardedBase >= actual) totalUnforwardedBase -= actual;
            if (actual > 0) {
                rewardToken.safeTransfer(restaker, actual);
                emit BaseClaimed(restaker, actual);
            }
        }

        // Clean up restaking state
        totalRestaked -= info.boostedAmount;
        // AUDIT FIX: DEEP-DR-02 — release this user's principal reservation. Pre-fix,
        // `emergencyForceReturn` was the ONLY NFT-exit path that omitted this update,
        // leaving `totalActivePrincipal` permanently inflated by the force-returned
        // user's principal. The phantom reservation then drove `recoverStuckPrincipal`'s
        // `othersPrincipal` calculation upward, silently DOS'ing legitimate force-closed
        // recoveries. Underflow guard mirrors `recoverStuckPrincipal`.
        if (info.positionAmount <= totalActivePrincipal) {
            totalActivePrincipal -= info.positionAmount;
        } else {
            totalActivePrincipal = 0;
        }

        // Attempt to return the NFT — if staking contract is broken, this may fail
        bool nftReturned;
        try stakingNFT.safeTransferFrom(address(this), restaker, tokenId) {
            nftReturned = true;
        } catch {
            // AUDIT FIX M-04: NFT transfer failed — preserve tokenIdToRestaker mapping
            // so rescueNFT can only send to the original restaker, preventing theft.
            nftReturned = false;
        }

        if (nftReturned) {
            // Full cleanup only if NFT was successfully returned
            delete tokenIdToRestaker[tokenId];
            delete restakers[restaker];
        } else {
            // NFT stuck — clear position data but preserve tokenIdToRestaker
            // so rescueNFT knows who owns it. restakers mapping cleared for bonus accounting.
            delete restakers[restaker];
        }
        _writeBoostCheckpoint(restaker, 0); // AUDIT H-8: zero historical boost on emergency return

        emit EmergencyForceReturn(restaker, tokenId, nftReturned);
    }

    // ─── M-26: Revalidate Boost Proxy ───────────────────────────────

    /// @notice M-26 + AUDIT NEW-S2: Revalidate the JBAC boost for a restaked position.
    /// @dev AUDIT NEW-S2 (HIGH): TegridyStaking.revalidateBoost is restricted to
    ///      owner/restakingContract to prevent permissionless boost-strip griefing
    ///      of legacy positions (a user whose JBAC is temporarily in a different
    ///      wallet). The prior permissionless wrapper in this contract punched
    ///      straight through that gate — an attacker could watch the JBAC market
    ///      and call this during any transfer-window to permanently strip a
    ///      victim's legacy JBAC boost. Now restricted to the restaker themselves
    ///      or the owner. Refreshes the cached boostedAmount after revalidation.
    /// @param tokenId The tsTOWELI NFT token ID to revalidate
    function revalidateBoostForRestaked(uint256 tokenId) external nonReentrant updateBonus {
        address restaker = tokenIdToRestaker[tokenId];
        if (restaker == address(0)) revert NotRestakedToken();
        // AUDIT NEW-S2: match Staking's auth model — only the position owner or
        // the restaking-contract owner can revalidate. Previously permissionless.
        if (msg.sender != restaker && msg.sender != owner()) revert Unauthorized();

        RestakeInfo storage info = restakers[restaker];

        // AUDIT FIX M-08: Use balance delta instead of staking.earned() snapshot.
        // Previously, earned() was credited as unforwardedBaseRewards regardless of whether
        // revalidateBoost actually triggered _getReward(). If boost was unchanged, no rewards
        // were transferred but the full earned() amount was phantom-credited.
        uint256 balBefore = rewardToken.balanceOf(address(this));

        // Call revalidateBoost on the staking contract
        staking.revalidateBoost(tokenId);

        // AUDIT FIX M-08: Only credit actually received tokens (balance delta)
        uint256 received = rewardToken.balanceOf(address(this)) - balBefore;
        if (received > 0) {
            unforwardedBaseRewards[restaker] += received;
            totalUnforwardedBase += received;
        }

        // Settle pending bonus before changing boostedAmount
        uint256 oldBoosted = info.boostedAmount;
        if (oldBoosted > 0) {
            int256 accumulated = _safeInt256((oldBoosted * accBonusPerShare) / ACC_PRECISION);
            int256 diff = accumulated - info.bonusDebt;
            uint256 bonusPending = diff > 0 ? uint256(diff) : 0;
            if (bonusPending > 0) {
                bonusRewardToken.safeTransfer(restaker, bonusPending);
                totalBonusDistributed += bonusPending;
            }
        }

        // Refresh cached boostedAmount from staking contract
        (, uint256 newBoostedAmount,,,,,,, , ,) = staking.positions(tokenId);
        info.boostedAmount = newBoostedAmount;
        _writeBoostCheckpoint(restaker, newBoostedAmount); // AUDIT H-8
        totalRestaked = totalRestaked - oldBoosted + newBoostedAmount;
        info.bonusDebt = _safeInt256((newBoostedAmount * accBonusPerShare) / ACC_PRECISION);

        emit BoostRevalidated(restaker, tokenId, oldBoosted, newBoostedAmount);
    }

    /// @notice #23/M-26 + AUDIT NEW-S2: Revalidate the JBAC boost for a restaked
    ///         position by user address.
    /// @dev Looks up the user's restaked tokenId and calls revalidateBoost via the
    ///      staking contract. AUDIT NEW-S2 (HIGH): restricted to the user themselves
    ///      or the owner — see revalidateBoostForRestaked above for the full
    ///      grief rationale.
    /// @param _user The restaker address whose boost should be revalidated
    function revalidateBoostForRestaker(address _user) external nonReentrant updateBonus {
        RestakeInfo storage info = restakers[_user];
        if (info.tokenId == 0) revert NotRestaked();
        // AUDIT NEW-S2: only the restaker or owner may trigger revalidation.
        if (msg.sender != _user && msg.sender != owner()) revert Unauthorized();

        uint256 tokenId = info.tokenId;

        // AUDIT FIX M-08: Use balance delta instead of staking.earned() snapshot
        uint256 balBefore = rewardToken.balanceOf(address(this));

        // Call revalidateBoost on the staking contract
        staking.revalidateBoost(tokenId);

        // AUDIT FIX M-08: Only credit actually received tokens (balance delta)
        uint256 received = rewardToken.balanceOf(address(this)) - balBefore;
        if (received > 0) {
            unforwardedBaseRewards[_user] += received;
            totalUnforwardedBase += received;
        }

        // Settle pending bonus before changing boostedAmount
        uint256 oldBoosted = info.boostedAmount;
        if (oldBoosted > 0) {
            int256 accumulated = _safeInt256((oldBoosted * accBonusPerShare) / ACC_PRECISION);
            int256 diff = accumulated - info.bonusDebt;
            uint256 bonusPending = diff > 0 ? uint256(diff) : 0;
            if (bonusPending > 0) {
                bonusRewardToken.safeTransfer(_user, bonusPending);
                totalBonusDistributed += bonusPending;
            }
        }

        // Refresh cached boostedAmount from staking contract
        (, uint256 newBoostedAmount,,,,,,, , ,) = staking.positions(tokenId);
        info.boostedAmount = newBoostedAmount;
        _writeBoostCheckpoint(_user, newBoostedAmount); // AUDIT H-8
        totalRestaked = totalRestaked - oldBoosted + newBoostedAmount;
        info.bonusDebt = _safeInt256((newBoostedAmount * accBonusPerShare) / ACC_PRECISION);

        emit BoostRevalidated(_user, tokenId, oldBoosted, newBoostedAmount);
    }

    // ─── SECURITY FIX: Decay Expired Restaker ─────────────────────
    /// @notice Permissionless: force-refresh a restaker whose staking lock has expired.
    /// @dev Without this, a restaker whose lock expires continues earning bonus rewards
    ///      at their full boosted rate because TegridyRestaking's cached `totalRestaked`
    ///      and per-user `boostedAmount` are never updated when TegridyStaking decays them.
    ///      This function reads the current position from TegridyStaking (where boostedAmount
    ///      is decayed to 0 on expiry) and syncs the cached values here.
    /// @param _restaker The restaker address to decay
    ///
    /// @dev AUDIT NEW-S3 (HIGH): the `updateBonus` modifier accrues bonus based on
    ///      the current `totalRestaked` BEFORE this function body runs. When a
    ///      restaker's lock expires, their cached `boostedAmount` stays inflated
    ///      until someone calls this helper — during which time `totalRestaked`
    ///      overstates the true denominator. Accrual against the inflated
    ///      denominator mints less `accBonusPerShare` per unit, so honest
    ///      restakers earn less, and the expired restaker's own pending bonus at
    ///      settlement is computed against the inflated cached amount — they
    ///      siphon the delta from honest users.
    ///
    ///      Fix: settle the expired restaker and update totalRestaked FIRST, then
    ///      run the bonus accrual against the corrected denominator. The period
    ///      immediately before this call still used the stale denominator (that
    ///      part of the past is sunk), but every future elapsed unit from now on
    ///      accrues fairly.
    function decayExpiredRestaker(address _restaker) external nonReentrant {
        RestakeInfo storage info = restakers[_restaker];
        if (info.tokenId == 0) revert NotRestaked();

        // Read current position from staking contract (where decay has been applied)
        (, uint256 currentBoosted,,,,,,, , ,) = staking.positions(info.tokenId);

        // Only proceed if the cached value differs (i.e., decay happened).
        // AUDIT NFT-CL-M4: typed error replaces legacy revert("NO_DECAY") string.
        if (currentBoosted == info.boostedAmount) revert NoDecay();

        uint256 oldBoosted = info.boostedAmount;

        // R017 RETRY step 1 — settle the expired restaker on the stale (cached)
        // oldBoosted against the CURRENT accBonusPerShare (reflects accrual up
        // to lastBonusRewardTime ONLY — NOT yet to block.timestamp). This pays
        // them their fair share under the accounting that was actually in
        // effect for prior periods. Anchor bonusDebt BEFORE transfer (CEI).
        if (oldBoosted > 0) {
            int256 accumulated = _safeInt256((oldBoosted * accBonusPerShare) / ACC_PRECISION);
            int256 diff = accumulated - info.bonusDebt;
            uint256 bonusPending = diff > 0 ? uint256(diff) : 0;
            info.bonusDebt = accumulated; // CEI: anchor BEFORE external call
            if (bonusPending > 0) {
                bonusRewardToken.safeTransfer(_restaker, bonusPending);
                totalBonusDistributed += bonusPending;
                emit BonusClaimed(_restaker, bonusPending);
            }
        }

        // R017 RETRY step 2 — shrink totalRestaked and update cached
        // boostedAmount BEFORE running fresh accrual. The micro-period from
        // lastBonusRewardTime to block.timestamp will be divided by the
        // corrected (smaller) denominator, so honest restakers earn their
        // fair share for every future second.
        info.boostedAmount = currentBoosted;
        _writeBoostCheckpoint(_restaker, currentBoosted); // AUDIT H-8
        totalRestaked = totalRestaked - oldBoosted + currentBoosted;

        // R017 RETRY step 3 — accrue the elapsed period against the corrected
        // denominator. This is the key reordering: previously, _accrueBonus
        // ran BEFORE the totalRestaked shrink, so the elapsed-period emission
        // was minted into accBonusPerShare against the inflated denominator —
        // letting the expired restaker siphon the delta from honest users.
        // AUDIT FIX: DEEP-DR-03 — use the monotonicity-checked wrapper so a
        // malicious subclass overriding `_accrueBonus` (the function is
        // explicitly `virtual` to bait such overrides per AUDIT NFT-CL-L5)
        // cannot decrement `accBonusPerShare` from this permissionless
        // entrypoint. The wrapper reverts with `AccrueNotMonotone()`.
        _accrueBonusChecked();

        // R017 RETRY step 4 — re-anchor expired restaker's bonusDebt to the
        // post-accrue accBonusPerShare so residual rounding can't credit them
        // for emission they no longer share in.
        info.bonusDebt = _safeInt256((currentBoosted * accBonusPerShare) / ACC_PRECISION);

        // Also refresh positionAmount
        (uint256 currentAmount,,,,,,,,, , ) = staking.positions(info.tokenId);
        // AUDIT FIX: DR2-01 — sync `totalActivePrincipal` to the new cached
        // principal BEFORE overwrite. Permissionless entrypoint, highest
        // leverage of the four sibling sites.
        // AUDIT FIX DR3-05: skip the totalActivePrincipal/positionAmount sync
        // entirely when currentAmount == 0 (force-closed staking position).
        // The pass-2 fix above eagerly synced positionAmount → 0, which broke
        // `recoverStuckPrincipal` for force-closed users (the recovery path
        // needs the ORIGINAL deposit amount to know what's recoverable; once
        // positionAmount is zeroed by a permissionless `decayExpiredRestaker`
        // call, the principal anchor is lost forever). The correct semantic
        // for force-closed positions is "unrestake / emergencyForceReturn
        // owns the cleanup"; this permissionless decay primitive only resyncs
        // when there's a non-zero principal to sync against.
        if (currentAmount > 0) {
            uint256 oldPositionAmount = info.positionAmount;
            if (oldPositionAmount >= currentAmount) {
                uint256 principalDelta = oldPositionAmount - currentAmount;
                if (principalDelta <= totalActivePrincipal) {
                    totalActivePrincipal -= principalDelta;
                } else {
                    totalActivePrincipal = 0;
                }
            } else {
                totalActivePrincipal += (currentAmount - oldPositionAmount);
            }
            info.positionAmount = currentAmount;
        }

        emit PositionRefreshed(_restaker, info.tokenId, oldBoosted, currentBoosted);
    }

    /// @dev AUDIT NEW-S3: extract the `updateBonus` modifier body into a reusable
    ///      internal function so `decayExpiredRestaker` can run accrual at a
    ///      specific step of the decay workflow instead of at the modifier's
    ///      fixed always-first position.
    /// @dev R014 RETRY: marked `virtual` so audit/red-team subclasses can override
    ///      to demonstrate that the `_accrueBonusChecked` wrapper traps any
    ///      `accBonusPerShare` decrement.
    /// @dev AUDIT NFT-CL-L5 (2026-04-28): the `virtual` modifier here is part of a
    ///      DEFENSIVE PATTERN — by exposing `_accrueBonus` as overridable, the
    ///      `_accrueBonusChecked` wrapper below becomes a meaningful runtime
    ///      tripwire. The base implementation is monotonically non-decreasing
    ///      by construction (it only writes via `accBonusPerShare += ...`),
    ///      so any override that decrements is, by definition, malicious or
    ///      buggy. This is NOT an extension hook for new product features —
    ///      it is bait for misbehaving subclasses, and the wrapper is the
    ///      enforcement mechanism. If you ever need a legitimate accrual
    ///      reset, do it through a NEW function, not by overriding this one.
    function _accrueBonus() internal virtual {
        if (block.timestamp > lastBonusRewardTime && totalRestaked > 0) {
            uint256 elapsed = block.timestamp - lastBonusRewardTime;
            uint256 reward = elapsed * bonusRewardPerSecond;
            uint256 available;
            try bonusRewardToken.balanceOf(address(this)) returns (uint256 bal) {
                available = bal;
            } catch {
                available = 0;
            }
            if (reward > available) {
                emit BonusShortfall(elapsed, reward - available);
                reward = available;
            }
            if (reward > 0) {
                accBonusPerShare += (reward * ACC_PRECISION) / totalRestaked;
            }
            lastBonusRewardTime = block.timestamp;
        } else if (totalRestaked == 0) {
            lastBonusRewardTime = block.timestamp;
        }
    }

    /// @notice R014 RETRY: monotonicity-checked wrapper around `_accrueBonus`.
    /// @dev `accBonusPerShare` is monotonically non-decreasing by construction
    ///      (`_accrueBonus` only ever performs `accBonusPerShare += ...`). This
    ///      wrapper snapshots the value before the call and reverts with
    ///      `AccrueNotMonotone()` if the post-call value is strictly less. It is
    ///      a runtime tripwire for malicious or buggy subclasses that override
    ///      `_accrueBonus` to siphon emission. Replace every direct call to
    ///      `_accrueBonus()` in stale-path / R017 code paths with this wrapper.
    /// @dev AUDIT NFT-CL-L5 (2026-04-28): co-designed with the `virtual` marker
    ///      on `_accrueBonus` above. Together they form a "trust but verify"
    ///      pattern — subclasses are PERMITTED to override (the `virtual` lets
    ///      them), but their override is BOUND by this wrapper to remain
    ///      monotonic. Any subclass that decrements `accBonusPerShare` (e.g.,
    ///      to siphon already-accrued share back to itself) trips the
    ///      `AccrueNotMonotone()` revert and is unable to settle the
    ///      transaction. This is one of two defense-in-depth layers protecting
    ///      restaker accounting; the other is the post-hoc settlement-side
    ///      cap on per-position payouts.
    function _accrueBonusChecked() internal {
        uint256 snapshotPre = accBonusPerShare;
        _accrueBonus();
        if (accBonusPerShare < snapshotPre) revert AccrueNotMonotone();
    }

    // ─── M-27: Safe Int256 Helper ───────────────────────────────────

    /// @notice M-27: Safe cast from uint256 to int256, reverts on overflow
    function _safeInt256(uint256 value) internal pure returns (int256) {
        if (value > uint256(type(int256).max)) revert Int256Overflow();
        return int256(value);
    }

    // ─── ERC721 Receiver ────────────────────────────────────────────

    /// L-03: Replace require string with custom error
    function onERC721Received(address, address, uint256, bytes calldata) external view override returns (bytes4) {
        if (msg.sender != address(staking)) revert OnlyStakingNFT();
        return IERC721Receiver.onERC721Received.selector;
    }
}
