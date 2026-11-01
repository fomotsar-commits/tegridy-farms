// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.21;

/// @title TwoStepOwned
/// @author Florida St
/// @notice This contract is used to transfer ownership of a contract in two steps.
abstract contract TwoStepOwned {
    event TransferOwnerRequested(address newOwner);
    event OwnershipTransferred(address indexed user, address indexed newOwner);

    error TooSoonError();
    error InvalidInputError();

    uint256 public immutable MIN_WAIT_TIME;

    address public pendingOwner;
    uint256 public pendingOwnerTime;
    address public owner;

    constructor(address _owner, uint256 _minWaitTime) {
        owner = _owner;
        pendingOwnerTime = type(uint256).max;
        MIN_WAIT_TIME = _minWaitTime;
    }

    /// @notice First step transferring ownership to the new owner.
    /// @param _newOwner The address of the new owner.
    function requestTransferOwner(address _newOwner) external onlyOwner {
        pendingOwner = _newOwner;
        pendingOwnerTime = block.timestamp;

        emit TransferOwnerRequested(_newOwner);
    }

    /// @notice Second step transferring ownership to the new owner.
    function transferOwnership() public {
        address newOwner = msg.sender;
        if (pendingOwnerTime + MIN_WAIT_TIME > block.timestamp) {
            revert TooSoonError();
        }
        if (newOwner != pendingOwner) {
            revert InvalidInputError();
        }
        address previousOwner = owner;
        owner = newOwner;
        pendingOwner = address(0);
        pendingOwnerTime = type(uint256).max;

        emit OwnershipTransferred(previousOwner, newOwner);
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "UNAUTHORIZED");

        _;
    }
}
