// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title OwnableNoRenounce — Ownable2Step with renounceOwnership permanently disabled
/// @notice Universal best practice across all battle-tested DeFi protocols:
///         Convex, Aave, Curve gauges, and every Tegriddy contract disable renounceOwnership()
///         to prevent accidental admin bricking.
/// @dev Inherits OZ Ownable2Step (2-step transfer: propose → accept).
///      All 10 Tegriddy admin contracts previously overrode renounceOwnership individually.
///      This base contract eliminates that repetition.
abstract contract OwnableNoRenounce is Ownable2Step {
    constructor(address initialOwner) Ownable(initialOwner) {
        require(initialOwner != address(0), "ZERO_OWNER");
    }

    /// @notice Disabled. Cannot renounce ownership.
    function renounceOwnership() public pure override {
        revert("RENOUNCE_DISABLED");
    }
}
