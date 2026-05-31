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
