// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IVotingEscrow {
    function votingPowerOf(address user) external view returns (uint256);
    function totalLocked() external view returns (uint256);
    function locks(address user) external view returns (uint256 amount, uint256 end);
}

/// @title RevenueDistributor
/// @notice Distributes ETH revenue to veTOWELI holders proportional to their locked amount.
///
///         How it works:
///         1. Protocol fees (ETH) are sent to this contract
///         2. Owner calls distribute() to snapshot a new epoch
///         3. Each epoch records: total ETH to distribute + total locked TOWELI at that moment
///         4. veTOWELI holders call claim() to receive their share across all unclaimed epochs
///         5. Share = (userLocked / totalLocked) * epochETH
///
///         Uses locked amount (not voting power) for fairer distribution —
///         someone locked for 7 days with 1000 tokens gets the same ETH as
///         someone locked for 4 years with 1000 tokens. Voting power is for governance;
///         revenue sharing is for commitment (locking any duration counts).
///
///         Design choices:
///         - Epoch-based (not streaming) for gas efficiency
///         - Uses locked amount not voting power (fairer for short lockers)
///         - Permissionless claim (users claim when they want)
///         - Unclaimed ETH persists — no expiry
contract RevenueDistributor is Ownable2Step, ReentrancyGuard {

    // ─── State ────────────────────────────────────────────────────────

    IVotingEscrow public immutable votingEscrow;
    address public treasury;

    struct Epoch {
        uint256 totalETH;         // ETH distributed in this epoch
        uint256 totalLocked;      // Total TOWELI locked at distribution time
        uint256 timestamp;        // When this epoch was created
    }

    Epoch[] public epochs;
    mapping(address => uint256) public lastClaimedEpoch; // Next epoch index to claim from
    mapping(address => bool) public hasRegistered; // Prevents retroactive claiming
    uint256 public totalDistributed;
    uint256 public totalClaimed;
    uint256 public totalEarmarked; // ETH allocated to epochs but not yet claimed

    // ─── Events ───────────────────────────────────────────────────────

    event EpochDistributed(uint256 indexed epochId, uint256 ethAmount, uint256 totalLocked);
    event Claimed(address indexed user, uint256 ethAmount, uint256 fromEpoch, uint256 toEpoch);
    event ETHReceived(address indexed sender, uint256 amount);
    event EmergencyWithdraw(address indexed treasury, uint256 amount);

    // ─── Errors ───────────────────────────────────────────────────────

    error ZeroAddress();
    error NoETHToDistribute();
    error NoLockedTokens();
    error NothingToClaim();
    error ETHTransferFailed();
    error NotRegistered();
    error StillHasLockedTokens();
    error NoETHToWithdraw();

    // ─── Constructor ──────────────────────────────────────────────────

    constructor(address _votingEscrow, address _treasury) Ownable(msg.sender) {
        if (_votingEscrow == address(0) || _treasury == address(0)) revert ZeroAddress();
        votingEscrow = IVotingEscrow(_votingEscrow);
        treasury = _treasury;
    }

    // ─── Receive ETH ──────────────────────────────────────────────────

    receive() external payable {
        emit ETHReceived(msg.sender, msg.value);
    }

    // ─── Distribution ─────────────────────────────────────────────────

    /// @notice Create a new distribution epoch with NEW ETH (not already earmarked).
    ///         Only owner can trigger distribution (e.g., weekly by admin or keeper).
    function distribute() external onlyOwner {
        uint256 newETH = address(this).balance - (totalEarmarked - totalClaimed);
        if (newETH == 0) revert NoETHToDistribute();

        uint256 locked = votingEscrow.totalLocked();
        if (locked == 0) revert NoLockedTokens();

        epochs.push(Epoch({
            totalETH: newETH,
            totalLocked: locked,
            timestamp: block.timestamp
        }));

        totalDistributed += newETH;
        totalEarmarked += newETH;

        emit EpochDistributed(epochs.length - 1, newETH, locked);
    }

    /// @notice Register for revenue sharing. Must be called BEFORE any epochs you want to claim.
    ///         Sets your starting epoch to the current epoch count, preventing retroactive claims.
    function register() external {
        if (hasRegistered[msg.sender]) return; // Idempotent
        hasRegistered[msg.sender] = true;
        lastClaimedEpoch[msg.sender] = epochs.length; // Start from current epoch, not 0
    }

    // ─── Emergency ───────────────────────────────────────────────────

    /// @notice Recover stuck ETH when ALL stakers have unlocked (totalLocked == 0).
    ///         Without this, distribute() reverts with NoLockedTokens and ETH is stuck forever.
    ///         Can ONLY be called when there are zero locked tokens — funds go to treasury.
    function emergencyWithdraw() external onlyOwner nonReentrant {
        uint256 locked = votingEscrow.totalLocked();
        if (locked != 0) revert StillHasLockedTokens();

        uint256 amount = address(this).balance;
        if (amount == 0) revert NoETHToWithdraw();

        (bool success,) = treasury.call{value: amount}("");
        if (!success) revert ETHTransferFailed();

        emit EmergencyWithdraw(treasury, amount);
    }

    /// @notice Update treasury address
    function setTreasury(address _treasury) external onlyOwner {
        if (_treasury == address(0)) revert ZeroAddress();
        treasury = _treasury;
    }

    // ─── Claiming ─────────────────────────────────────────────────────

    /// @notice Claim ETH for all unclaimed epochs (must register first).
    ///         User's share per epoch = (userLockedAmount / totalLocked) * epochETH
    function claim() external nonReentrant {
        if (!hasRegistered[msg.sender]) revert NotRegistered();
        uint256 startEpoch = lastClaimedEpoch[msg.sender];
        uint256 endEpoch = epochs.length;

        if (startEpoch >= endEpoch) revert NothingToClaim();

        // Get user's locked amount (constant across epochs since we use amount not power)
        (uint256 userLocked,) = votingEscrow.locks(msg.sender);
        if (userLocked == 0) revert NothingToClaim();

        uint256 totalOwed = 0;

        for (uint256 i = startEpoch; i < endEpoch; i++) {
            Epoch memory epoch = epochs[i];
            if (epoch.totalLocked > 0) {
                uint256 share = (epoch.totalETH * userLocked) / epoch.totalLocked;
                totalOwed += share;
            }
        }

        if (totalOwed == 0) revert NothingToClaim();

        lastClaimedEpoch[msg.sender] = endEpoch;
        totalClaimed += totalOwed;

        (bool success,) = msg.sender.call{value: totalOwed}("");
        if (!success) revert ETHTransferFailed();

        emit Claimed(msg.sender, totalOwed, startEpoch, endEpoch);
    }

    /// @notice Claim ETH for a limited number of epochs (gas-safe for many unclaimed epochs).
    function claimUpTo(uint256 maxEpochs) external nonReentrant {
        if (!hasRegistered[msg.sender]) revert NotRegistered();
        uint256 startEpoch = lastClaimedEpoch[msg.sender];
        uint256 endEpoch = epochs.length;
        if (startEpoch + maxEpochs < endEpoch) {
            endEpoch = startEpoch + maxEpochs;
        }

        if (startEpoch >= endEpoch) revert NothingToClaim();

        (uint256 userLocked,) = votingEscrow.locks(msg.sender);
        if (userLocked == 0) revert NothingToClaim();

        uint256 totalOwed = 0;
        for (uint256 i = startEpoch; i < endEpoch; i++) {
            Epoch memory epoch = epochs[i];
            if (epoch.totalLocked > 0) {
                totalOwed += (epoch.totalETH * userLocked) / epoch.totalLocked;
            }
        }

        if (totalOwed == 0) revert NothingToClaim();

        lastClaimedEpoch[msg.sender] = endEpoch;
        totalClaimed += totalOwed;

        (bool success,) = msg.sender.call{value: totalOwed}("");
        if (!success) revert ETHTransferFailed();

        emit Claimed(msg.sender, totalOwed, startEpoch, endEpoch);
    }

    // ─── View Functions ───────────────────────────────────────────────

    /// @notice Calculate pending ETH claimable by a user
    function pendingETH(address user) external view returns (uint256) {
        uint256 startEpoch = lastClaimedEpoch[user];
        uint256 endEpoch = epochs.length;

        if (startEpoch >= endEpoch) return 0;

        (uint256 userLocked,) = votingEscrow.locks(user);
        if (userLocked == 0) return 0;

        uint256 total = 0;
        for (uint256 i = startEpoch; i < endEpoch; i++) {
            Epoch memory epoch = epochs[i];
            if (epoch.totalLocked > 0) {
                total += (epoch.totalETH * userLocked) / epoch.totalLocked;
            }
        }
        return total;
    }

    /// @notice Total number of distribution epochs
    function epochCount() external view returns (uint256) {
        return epochs.length;
    }

    /// @notice Get epoch details
    function getEpoch(uint256 epochId) external view returns (uint256 totalETH, uint256 totalLocked, uint256 timestamp) {
        Epoch memory epoch = epochs[epochId];
        return (epoch.totalETH, epoch.totalLocked, epoch.timestamp);
    }
}
