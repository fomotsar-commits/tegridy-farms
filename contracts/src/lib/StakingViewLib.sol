// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

/// @notice Staking position struct. Relocated to file level (from inside
///         TegridyStaking) during the EIP-170 split so the linked view library
///         below can operate on `positions` storage. Layout is byte-identical to
///         the original in-contract struct — the `positions` public-getter ABI is
///         unchanged.
struct Position {
    uint256 amount;
    uint256 boostedAmount;
    int256 rewardDebt;
    uint64 lockEnd;
    uint16 boostBps;
    uint32 lockDuration;
    bool autoMaxLock;
    bool hasJbacBoost;
    uint64 stakeTimestamp;
    uint256 jbacTokenId;
    bool jbacDeposited;
}

/// @title StakingViewLib
/// @notice EIP-170 split (C1): read-only view/math extracted from TegridyStaking
///         into a linked (delegatecall) library. PURE SIZE REDUCTION — behaviour is
///         byte-for-byte identical to the original in-contract functions. Every
///         function here is read-only (view/pure); because the library is invoked
///         via delegatecall it shares the caller's storage, but holding zero write
///         paths means it cannot corrupt staking state. The caller (TegridyStaking)
///         keeps thin wrappers that apply the restaking/lending carve-out guards
///         then delegate the iteration/math here.
library StakingViewLib {
    using EnumerableSet for EnumerableSet.UintSet;

    // Mirror of the TegridyStaking constants used by the extracted math. These are
    // universal protocol constants (must equal the contract's values).
    uint256 internal constant BOOST_PRECISION = 10000;
    uint256 internal constant ACC_PRECISION = 1e18;

    /// @dev Aggregated active voting power across every position in `set`.
    ///      Equivalent to the original TegridyStaking.votingPowerOf loop (post
    ///      restaking/lending carve-out, which the caller applies before delegating).
    function votingPowerOf(
        EnumerableSet.UintSet storage set,
        mapping(uint256 => Position) storage positions
    ) public view returns (uint256 total) {
        uint256 len = set.length();
        uint256 nowTs = block.timestamp;
        for (uint256 i; i < len; ++i) {
            Position storage p = positions[set.at(i)];
            uint256 amount = p.amount;
            if (amount == 0) continue;
            if (nowTs >= p.lockEnd) continue;
            total += (amount * p.boostBps) / BOOST_PRECISION;
        }
    }

    /// @dev Amount-weighted average active boostBps. Mirrors
    ///      TegridyStaking.aggregateActiveBoostBps (post carve-out).
    function aggregateActiveBoostBps(
        EnumerableSet.UintSet storage set,
        mapping(uint256 => Position) storage positions
    ) public view returns (uint256 weightedBps) {
        uint256 len = set.length();
        uint256 nowTs = block.timestamp;
        uint256 totalAmount;
        uint256 totalBoosted;
        for (uint256 i; i < len; ++i) {
            Position storage p = positions[set.at(i)];
            uint256 amt = p.amount;
            if (amt == 0) continue;
            if (nowTs >= p.lockEnd) continue;
            totalAmount += amt;
            totalBoosted += amt * p.boostBps;
        }
        if (totalAmount == 0) return 0;
        weightedBps = totalBoosted / totalAmount;
    }

    /// @dev Pending rewards for a position. Mirrors TegridyStaking.earned, including
    ///      the AUDIT FIX M-01 expired-position accrual semantics.
    function earned(
        Position storage p,
        uint256 rewardPerTokenStored,
        uint256 lastUpdateTime,
        uint256 rewardRate,
        uint256 totalBoostedStake
    ) public view returns (uint256) {
        if (p.boostedAmount == 0) return 0;
        uint256 currentAcc = rewardPerTokenStored;
        if (block.timestamp > lastUpdateTime && totalBoostedStake > 0) {
            currentAcc += ((block.timestamp - lastUpdateTime) * rewardRate * ACC_PRECISION) / totalBoostedStake;
        }
        int256 diff = int256((p.boostedAmount * currentAcc) / ACC_PRECISION) - p.rewardDebt;
        return diff > 0 ? uint256(diff) : 0;
    }
}
