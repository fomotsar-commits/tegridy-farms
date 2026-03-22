// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface ITegridyFarm {
    function fund(uint256 amount) external;
}

/// @title FeeDistributor
/// @notice Receives TOWELI fees from the Uniswap V4 hook (or other sources)
///         and forwards them to the TegridyFarm as additional rewards.
contract FeeDistributor is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable rewardToken;
    ITegridyFarm public farm;

    event FarmUpdated(address indexed oldFarm, address indexed newFarm);
    event FeesDistributed(uint256 amount);
    event TokensSwept(address indexed token, uint256 amount);
    event ETHSwept(address indexed to, uint256 amount);

    error ZeroAddress();
    error ZeroBalance();
    error FarmNotSet();
    error CannotSweepRewardToken();
    error ETHTransferFailed();
    error InvalidFarm();

    constructor(address _rewardToken) Ownable(msg.sender) {
        if (_rewardToken == address(0)) revert ZeroAddress();
        rewardToken = IERC20(_rewardToken);
    }

    /// @notice Set or update the farm address that receives distributed fees.
    ///         Validates that the target implements fund() by checking code size.
    function setFarm(address _farm) external onlyOwner {
        if (_farm == address(0)) revert ZeroAddress();
        // Verify _farm is a contract (has code deployed)
        uint256 codeSize;
        assembly { codeSize := extcodesize(_farm) }
        if (codeSize == 0) revert InvalidFarm();

        // Revoke approval on old farm before switching
        address oldFarm = address(farm);
        if (oldFarm != address(0)) {
            rewardToken.forceApprove(oldFarm, 0);
        }

        farm = ITegridyFarm(_farm);
        emit FarmUpdated(oldFarm, _farm);
    }

    /// @notice Distribute all accumulated fees to the farm.
    function distributeToFarm() external nonReentrant {
        if (address(farm) == address(0)) revert FarmNotSet();

        uint256 balance = rewardToken.balanceOf(address(this));
        if (balance == 0) revert ZeroBalance();

        // Use forceApprove to handle tokens that require zero-first approval
        rewardToken.forceApprove(address(farm), balance);

        uint256 balanceBefore = rewardToken.balanceOf(address(this));
        farm.fund(balance);
        uint256 balanceAfter = rewardToken.balanceOf(address(this));

        // Verify tokens were actually consumed
        uint256 consumed = balanceBefore - balanceAfter;
        require(consumed > 0, "Farm did not consume tokens");

        // Revoke any remaining approval
        if (balanceAfter > 0) {
            rewardToken.forceApprove(address(farm), 0);
        }

        emit FeesDistributed(consumed);
    }

    /// @notice Recover accidentally sent tokens (not the reward token).
    function sweep(address _token) external onlyOwner {
        if (_token == address(rewardToken)) revert CannotSweepRewardToken();

        uint256 balance = IERC20(_token).balanceOf(address(this));
        if (balance == 0) revert ZeroBalance();

        IERC20(_token).safeTransfer(owner(), balance);
        emit TokensSwept(_token, balance);
    }

    /// @notice Recover accidentally sent ETH.
    function sweepETH() external onlyOwner {
        uint256 balance = address(this).balance;
        if (balance == 0) revert ZeroBalance();

        (bool success,) = owner().call{value: balance}("");
        if (!success) revert ETHTransferFailed();
        emit ETHSwept(owner(), balance);
    }

    /// @notice View pending fees available for distribution.
    function pendingFees() external view returns (uint256) {
        return rewardToken.balanceOf(address(this));
    }

    /// @notice Accept ETH so it can be swept
    receive() external payable {}
}
