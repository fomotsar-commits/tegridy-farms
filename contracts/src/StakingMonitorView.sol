// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Position, StakingViewLib} from "./lib/StakingViewLib.sol";

/// @dev Minimal external surface of TegridyStaking that the monitor sibling needs to
///      reconstruct off-chain views. Each method maps to a `public` storage variable on
///      TegridyStaking (auto-generated getter) — no new accessors required on the host.
interface ITegridyStakingMonitorRead {
    // Position storage — public mapping auto-getter returns fields in declaration order.
    function positions(uint256 tokenId) external view returns (
        uint256 amount,
        uint256 boostedAmount,
        int256 rewardDebt,
        uint64 lockEnd,
        uint16 boostBps,
        uint32 lockDuration,
        bool autoMaxLock,
        bool hasJbacBoost,
        uint64 stakeTimestamp,
        uint256 jbacTokenId,
        bool jbacDeposited
    );
    // Reward-math scalars.
    function rewardPerTokenStored() external view returns (uint256);
    function lastUpdateTime() external view returns (uint256);
    function rewardRate() external view returns (uint256);
    function totalBoostedStake() external view returns (uint256);
    function totalStaked() external view returns (uint256);
    function totalUnsettledRewards() external view returns (uint256);
    // Reward token (the auto-getter for the public IERC20 immutable returns the address).
    function rewardToken() external view returns (address);
    // Global stake cap (public storage auto-getter) — backs the two cap views below.
    function maxTotalStaked() external view returns (uint256);
}

interface IMonitorERC20Balance {
    function balanceOf(address account) external view returns (uint256);
}

/// @title  StakingMonitorView
/// @notice EIP-170 sibling for TegridyStaking: re-exposes the heaviest off-chain views
///         (`earned`, `getPosition`) so the host can drop them from its bytecode. The
///         ABI signatures are byte-identical to the original on-host versions, so off-
///         chain consumers migrate by pointing at this contract's address instead of
///         the staking contract's.
///
///         Pure read-only — never writes state, holds no funds, has no privileged role.
///         The TegridyStaking reference is `immutable`, set once at construction.
///
/// @dev    DRY discipline: the per-position math lives in `StakingViewLib.earnedFromMem`
///         (a memory variant of the storage `earned` already used by the host). Both
///         the storage and memory variants must stay in lockstep — any future audit fix
///         to one MUST land in the other (the compiler does not share bodies).
contract StakingMonitorView {
    ITegridyStakingMonitorRead public immutable staking;

    // ─── Protocol bounds re-exposed for integrators ───────────────────────
    //
    // EIP-170 golf (2026-07-23): these five dropped to `internal` on TegridyStaking to
    // reclaim their auto-getter bytecode. TegridyStaking remains the SOURCE OF TRUTH;
    // the copies below exist only so the values stay readable on-chain, with ABI
    // signatures byte-identical to the removed host getters.
    //
    // LOCKSTEP DISCIPLINE: the compiler cannot link these to the host's constants
    // (they are `internal` there), so any change to a bound on TegridyStaking MUST be
    // mirrored here in the same commit. `StakingMonitorViewConstants.t.sol` pins the
    // two boost bounds to the host's live `calculateBoost` curve, which fails the build
    // if either side drifts; the lock bounds are pinned through the same curve.
    uint256 public constant MIN_LOCK_DURATION = 7 days;
    uint256 public constant MAX_LOCK_DURATION = 4 * 365 days;
    uint256 public constant MIN_BOOST_BPS = 4000;   // 0.4x
    uint256 public constant MAX_BOOST_BPS = 40000;  // 4.0x
    uint256 public constant JBAC_BONUS_BPS = 5000;  // +0.5x

    constructor(address _staking) {
        require(_staking != address(0), "StakingMonitorView: zero staking");
        staking = ITegridyStakingMonitorRead(_staking);
    }

    /// @notice Pending rewards for a position. Byte-identical ABI to the removed
    ///         `TegridyStaking.earned(uint256)`.
    /// @dev    Inflates the Position struct from the public mapping tuple, pulls the
    ///         reward-math scalars, then defers to `StakingViewLib.earnedFromMem`.
    function earned(uint256 tokenId) external view returns (uint256) {
        Position memory p = _loadPosition(tokenId);
        ITegridyStakingMonitorRead s = staking;
        uint256 available = IMonitorERC20Balance(s.rewardToken()).balanceOf(address(s));
        return StakingViewLib.earnedFromMem(
            p,
            s.rewardPerTokenStored(),
            s.lastUpdateTime(),
            s.rewardRate(),
            s.totalBoostedStake(),
            available,
            s.totalStaked(),
            s.totalUnsettledRewards()
        );
    }

    /// @notice Position details. Byte-identical ABI to the removed
    ///         `TegridyStaking.getPosition(uint256)`.
    function getPosition(uint256 tokenId) external view returns (
        uint256 amount,
        uint256 boostBps,
        uint256 lockEnd,
        uint256 lockDuration,
        bool autoMaxLock,
        bool canWithdraw
    ) {
        // AUDIT 2026-05-30 [slither unused-return]: tuple destructuring with intentionally
        // skipped fields (boostedAmount, rewardDebt, hasJbacBoost, stakeTimestamp,
        // jbacTokenId, jbacDeposited) — this view only exposes the 6 fields its public
        // signature returns. Standard Solidity tuple-skip pattern; the detector flags any
        // tuple destructuring where any field is dropped.
        // slither-disable-next-line unused-return
        (
            uint256 amt,
            ,                  // boostedAmount
            ,                  // rewardDebt
            uint64 lockEndV,
            uint16 boostBpsV,
            uint32 lockDurV,
            bool autoMaxLockV,
            ,                  // hasJbacBoost
            ,                  // stakeTimestamp
            ,                  // jbacTokenId
                               // jbacDeposited
        ) = staking.positions(tokenId);
        return (
            amt,
            boostBpsV,
            uint256(lockEndV),
            uint256(lockDurV),
            autoMaxLockV,
            amt > 0 && block.timestamp >= uint256(lockEndV)
        );
    }

    /// @notice Current global-stake-cap utilization in basis points.
    /// @dev    mvp-launch Phase 0.7 monitoring helper. Forta + Defender
    ///         alert at 8000 bps (80%) to trigger Phase 7 cap-raise review.
    ///         Returns 10000 (100%) if the cap is fully consumed; 0 if no
    ///         stakes yet; saturates at 10000 (cannot exceed because
    ///         stake() reverts above cap).
    /// @dev    EIP-170 sibling (2026-07-23): moved verbatim off TegridyStaking.
    ///         Byte-identical ABI to the removed `TegridyStaking.stakeCapUtilizationBps()`.
    function stakeCapUtilizationBps() external view returns (uint256) {
        ITegridyStakingMonitorRead s = staking;
        uint256 cap = s.maxTotalStaked();
        if (cap == 0 || cap == type(uint256).max) return 0;
        uint256 staked = s.totalStaked();
        if (staked >= cap) return 10000;
        return (staked * 10000) / cap;
    }

    /// @notice Remaining headroom under the global stake cap, in TOWELI wei.
    /// @dev    Front-end consumes this to gate the "stake max" affordance.
    ///         Returns 0 if cap is reached or unset-as-max sentinel.
    /// @dev    EIP-170 sibling (2026-07-23): moved verbatim off TegridyStaking.
    ///         Byte-identical ABI to the removed `TegridyStaking.stakeCapHeadroom()`.
    function stakeCapHeadroom() external view returns (uint256) {
        ITegridyStakingMonitorRead s = staking;
        uint256 cap = s.maxTotalStaked();
        if (cap == type(uint256).max) return type(uint256).max;
        uint256 staked = s.totalStaked();
        return staked >= cap ? 0 : cap - staked;
    }

    // ─── Internal helpers ─────────────────────────────────────────────────

    /// @dev Pack the auto-getter tuple back into a Position memory struct so the lib's
    ///      memory-variant of `earned` can be reused without inlining its math here.
    function _loadPosition(uint256 tokenId) internal view returns (Position memory p) {
        (
            uint256 amount,
            uint256 boostedAmount,
            int256 rewardDebt,
            uint64 lockEnd,
            uint16 boostBps,
            uint32 lockDuration,
            bool autoMaxLock,
            bool hasJbacBoost,
            uint64 stakeTimestamp,
            uint256 jbacTokenId,
            bool jbacDeposited
        ) = staking.positions(tokenId);
        p.amount = amount;
        p.boostedAmount = boostedAmount;
        p.rewardDebt = rewardDebt;
        p.lockEnd = lockEnd;
        p.boostBps = boostBps;
        p.lockDuration = lockDuration;
        p.autoMaxLock = autoMaxLock;
        p.hasJbacBoost = hasJbacBoost;
        p.stakeTimestamp = stakeTimestamp;
        p.jbacTokenId = jbacTokenId;
        p.jbacDeposited = jbacDeposited;
    }
}
