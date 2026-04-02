// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import {OwnableNoRenounce} from "./base/OwnableNoRenounce.sol";
import {TimelockAdmin} from "./base/TimelockAdmin.sol";
import {WETHFallbackLib, IWETH} from "./lib/WETHFallbackLib.sol";

/// @dev Interface for TegridyStaking (voting escrow) — Curve-style checkpoint queries.
///      Same interface as RevenueDistributor uses.
interface IVotingEscrow {
    function votingPowerOf(address user) external view returns (uint256);
    function votingPowerAtTimestamp(address user, uint256 ts) external view returns (uint256);
    function totalLocked() external view returns (uint256);
    function totalBoostedStake() external view returns (uint256);
    function userTokenId(address user) external view returns (uint256);
    function positions(uint256 tokenId) external view returns (
        uint256 amount, uint256 boostedAmount, uint256 boostBps, uint256 lockEnd,
        uint256 lockDuration, bool autoMaxLock, int256 rewardDebt, uint256 lastStakeTime,
        bool jbacBoosted
    );
    function paused() external view returns (bool);
}

/// @dev Interface for TegridyFactory to validate pair addresses.
interface ITegridyFactory {
    function getPair(address tokenA, address tokenB) external view returns (address pair);
}

/// @dev Interface for TegridyPair to read token addresses (H-04 fix).
interface ITegridyPair {
    function token0() external view returns (address);
    function token1() external view returns (address);
}

/// @title VoteIncentives — Bribe Market for veTOWELI Voters
/// @notice External protocols deposit ETH or ERC20 bribes for specific pool pairs.
///         veTOWELI holders claim proportional to their votingPowerAtTimestamp().
///
///         How it works:
///         1. Protocols call depositBribe() or depositBribeETH() targeting a specific pair
///         2. Anyone calls advanceEpoch() to snapshot an epoch (permissionless, 1h cooldown)
///         3. Each epoch records: timestamp + totalBoostedStake at snapshot time
///         4. Users call claimBribes(epoch, pair) to receive their share of all bribe tokens
///         5. Share = (votingPowerAtTimestamp(user, epoch.timestamp) / epoch.totalPower) * bribeAmount
///
///         Design choices:
///         - Epoch-based (not streaming) for gas efficiency — Curve FeeDistributor pattern
///         - Per-pair bribes — Aerodrome/Velodrome model
///         - Whitelisted bribe tokens — prevents griefing with garbage tokens
///         - Bribe fee (default 3%) — sent to treasury
///         - Pull-pattern withdrawals for failed transfers — WETHFallbackLib
///         - Max 20 bribe tokens per pair per epoch — gas cap on claim iteration
///
/// Battle-tested sources:
///  - OwnableNoRenounce: OZ Ownable2Step (industry standard)
///  - TimelockAdmin: MakerDAO DSPause pattern (billions TVL, never compromised)
///  - WETHFallbackLib: Solmate SafeTransferLib + WETH fallback (Uniswap V3/V4, Seaport)
///  - Epoch claim pattern: Curve FeeDistributor (billions distributed)
///  - Bribe model: Aerodrome/Velodrome (>$100M TVL)
contract VoteIncentives is OwnableNoRenounce, ReentrancyGuard, Pausable, TimelockAdmin {
    using SafeERC20 for IERC20;

    // ─── Timelock Operation Keys ─────────────────────────────────────
    bytes32 public constant FEE_CHANGE = keccak256("BRIBE_FEE_CHANGE");
    bytes32 public constant TREASURY_CHANGE = keccak256("BRIBE_TREASURY_CHANGE");
    bytes32 public constant WHITELIST_CHANGE = keccak256("BRIBE_WHITELIST_CHANGE");

    // ─── Constants ───────────────────────────────────────────────────
    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_FEE_BPS = 500;         // Max 5% bribe fee
    uint256 public constant MAX_BRIBE_TOKENS = 20;     // Max unique tokens per pair per epoch
    uint256 public constant MAX_CLAIM_EPOCHS = 500;     // Same as RevenueDistributor
    uint256 public constant MIN_EPOCH_INTERVAL = 1 hours;
    uint256 public constant FEE_CHANGE_DELAY = 24 hours;
    uint256 public constant TREASURY_CHANGE_DELAY = 48 hours;
    uint256 public constant WHITELIST_CHANGE_DELAY = 24 hours;
    uint256 public constant MIN_DISTRIBUTE_STAKE = 1000e18; // Same as RevenueDistributor

    // ─── Immutables ──────────────────────────────────────────────────
    IVotingEscrow public immutable votingEscrow;
    IWETH public immutable weth;
    ITegridyFactory public immutable factory;

    // ─── State ───────────────────────────────────────────────────────
    address public treasury;
    uint256 public bribeFeeBps;  // Default 300 = 3%

    struct EpochInfo {
        uint256 totalPower;      // totalBoostedStake snapshot
        uint256 timestamp;       // Snapshot timestamp (block.timestamp - 1)
    }

    EpochInfo[] public epochs;
    uint256 public lastEpochTime;

    // epochBribes[epoch][pair][token] = total bribe amount (after fee)
    mapping(uint256 => mapping(address => mapping(address => uint256))) public epochBribes;

    // epochBribeTokens[epoch][pair] = list of bribe token addresses
    mapping(uint256 => mapping(address => address[])) public epochBribeTokens;

    // claimed[user][epoch][pair][token] = true if already claimed
    mapping(address => mapping(uint256 => mapping(address => mapping(address => bool)))) public claimed;

    // Token whitelist
    mapping(address => bool) public whitelistedTokens;
    address[] public whitelistedTokenList;

    // Pull-pattern pending withdrawals (for contracts that can't receive ETH)
    mapping(address => uint256) public pendingETHWithdrawals;
    mapping(address => mapping(address => uint256)) public pendingTokenWithdrawals;
    uint256 public totalPendingETH;

    // C-01/C-02 FIX: Track total unclaimed bribe amounts to prevent sweep from draining active bribes
    mapping(address => uint256) public totalUnclaimedBribes;  // token => total unclaimed amount
    uint256 public totalUnclaimedETHBribes;

    // C-02 FIX: Track first deposit timestamp per epoch for orphaned bribe rescue
    mapping(uint256 => uint256) public epochBribeFirstDeposit; // epoch => first deposit timestamp
    uint256 public constant BRIBE_RESCUE_DELAY = 30 days;

    // H-03 FIX: Accumulated treasury ETH fees (pull pattern)
    uint256 public accumulatedTreasuryETH;

    // ─── Pending Values (for timelocked changes) ─────────────────────
    uint256 public pendingFeeBps;
    address public pendingTreasury;
    address public pendingWhitelistToken;
    bool public pendingWhitelistAction; // true = add, false = remove

    // ─── Events ──────────────────────────────────────────────────────
    event EpochAdvanced(uint256 indexed epochId, uint256 totalPower, uint256 timestamp);
    event BribeDeposited(uint256 indexed epoch, address indexed pair, address indexed token, address depositor, uint256 amount, uint256 fee);
    event BribeDepositedETH(uint256 indexed epoch, address indexed pair, address indexed depositor, uint256 amount, uint256 fee);
    event BribeClaimed(address indexed user, uint256 indexed epoch, address indexed pair, address token, uint256 amount);
    event PendingETHCredited(address indexed user, uint256 amount);
    event PendingETHWithdrawn(address indexed user, uint256 amount);
    event PendingTokenWithdrawn(address indexed user, address indexed token, uint256 amount);
    event FeeUpdated(uint256 oldFee, uint256 newFee);
    event FeeChangeProposed(uint256 currentFee, uint256 proposedFee, uint256 executeAfter);
    event FeeChangeCancelled(uint256 cancelledFee);
    event TreasuryUpdated(address oldTreasury, address newTreasury);
    event TreasuryChangeProposed(address indexed newTreasury, uint256 executeAfter);
    event TreasuryChangeCancelled(address indexed cancelledTreasury);
    event TokenWhitelisted(address indexed token);
    event TokenRemovedFromWhitelist(address indexed token);
    event WhitelistChangeProposed(address indexed token, bool add, uint256 executeAfter);
    event WhitelistChangeCancelled(address indexed token);

    // ─── Errors ──────────────────────────────────────────────────────
    error ZeroAddress();
    error ZeroAmount();
    error FeeTooHigh();
    error TokenNotWhitelisted();
    error TooManyBribeTokens();
    error EpochTooSoon();
    error NoStakers();
    error NothingToClaim();
    error AlreadyClaimed();
    error InvalidEpoch();
    error InvalidPair();
    error NoPendingWithdrawal();
    error StakingPaused();
    error TooManyUnclaimedEpochs();

    // ─── Legacy View Helpers (for test/frontend compatibility) ───────
    function feeChangeTime() external view returns (uint256) { return _executeAfter[FEE_CHANGE]; }
    function treasuryChangeTime() external view returns (uint256) { return _executeAfter[TREASURY_CHANGE]; }
    function whitelistChangeTime() external view returns (uint256) { return _executeAfter[WHITELIST_CHANGE]; }

    // ─── Constructor ─────────────────────────────────────────────────

    constructor(
        address _votingEscrow,
        address _treasury,
        address _weth,
        address _factory,
        uint256 _bribeFeeBps
    ) OwnableNoRenounce(msg.sender) {
        if (_votingEscrow == address(0) || _treasury == address(0) || _weth == address(0) || _factory == address(0)) revert ZeroAddress();
        if (_bribeFeeBps > MAX_FEE_BPS) revert FeeTooHigh();
        votingEscrow = IVotingEscrow(_votingEscrow);
        weth = IWETH(_weth);
        factory = ITegridyFactory(_factory);
        treasury = _treasury;
        bribeFeeBps = _bribeFeeBps;
    }

    // ─── Epoch Management ────────────────────────────────────────────

    /// @notice Advance to a new epoch. Permissionless — anyone can call.
    ///         Snapshots totalBoostedStake at block.timestamp - 1 (same as RevenueDistributor).
    function advanceEpoch() external whenNotPaused {
        if (block.timestamp < lastEpochTime + MIN_EPOCH_INTERVAL) revert EpochTooSoon();

        uint256 totalPower = votingEscrow.totalBoostedStake();
        if (totalPower == 0) revert NoStakers();
        if (totalPower < MIN_DISTRIBUTE_STAKE) revert NoStakers();

        uint256 snapshotTime = block.timestamp > 0 ? block.timestamp - 1 : 0;

        epochs.push(EpochInfo({
            totalPower: totalPower,
            timestamp: snapshotTime
        }));

        lastEpochTime = block.timestamp;

        emit EpochAdvanced(epochs.length - 1, totalPower, snapshotTime);
    }

    /// @notice Get the current epoch index (next epoch that bribes deposit into).
    function currentEpoch() external view returns (uint256) {
        return epochs.length;
    }

    /// @notice Get total number of completed epochs.
    function epochCount() external view returns (uint256) {
        return epochs.length;
    }

    // ─── Bribe Deposits ──────────────────────────────────────────────

    /// @notice Deposit ERC20 bribe for a specific pair in the current (not-yet-snapshotted) epoch.
    ///         Uses balance-diff to handle fee-on-transfer tokens correctly.
    /// @param pair The pool pair address this bribe is for
    /// @param token The ERC20 token being deposited as bribe
    /// @param amount Amount of tokens to deposit
    function depositBribe(address pair, address token, uint256 amount) external nonReentrant whenNotPaused {
        if (pair == address(0)) revert InvalidPair();
        if (token == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (!whitelistedTokens[token]) revert TokenNotWhitelisted();
        _validatePair(pair);

        // Balance-diff for FoT tokens (same pattern as SwapFeeRouter)
        uint256 balBefore = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 actualReceived = IERC20(token).balanceOf(address(this)) - balBefore;
        if (actualReceived == 0) revert ZeroAmount();

        // Take bribe fee
        uint256 fee = (actualReceived * bribeFeeBps) / BPS;
        uint256 netBribe = actualReceived - fee;

        // Send fee to treasury
        if (fee > 0) {
            IERC20(token).safeTransfer(treasury, fee);
        }

        // Current epoch = epochs.length (the next epoch to be snapshotted)
        uint256 epoch = epochs.length;

        // Check token cap for this pair in this epoch
        address[] storage tokenList = epochBribeTokens[epoch][pair];
        if (epochBribes[epoch][pair][token] == 0) {
            // New token for this pair/epoch — check cap
            if (tokenList.length >= MAX_BRIBE_TOKENS) revert TooManyBribeTokens();
            tokenList.push(token);
        }

        epochBribes[epoch][pair][token] += netBribe;
        totalUnclaimedBribes[token] += netBribe;

        // C-02 FIX: Track first deposit timestamp for orphaned bribe rescue
        if (epochBribeFirstDeposit[epoch] == 0) {
            epochBribeFirstDeposit[epoch] = block.timestamp;
        }

        emit BribeDeposited(epoch, pair, token, msg.sender, netBribe, fee);
    }

    /// @notice Deposit ETH bribe for a specific pair in the current epoch.
    /// @param pair The pool pair address this bribe is for
    function depositBribeETH(address pair) external payable nonReentrant whenNotPaused {
        if (pair == address(0)) revert InvalidPair();
        if (msg.value == 0) revert ZeroAmount();
        _validatePair(pair);

        // Take bribe fee
        uint256 fee = (msg.value * bribeFeeBps) / BPS;
        uint256 netBribe = msg.value - fee;

        // H-03 FIX: Accumulate treasury fees (pull pattern) to prevent DoS if treasury rejects ETH
        if (fee > 0) {
            accumulatedTreasuryETH += fee;
        }

        // Current epoch = epochs.length
        uint256 epoch = epochs.length;

        // Use address(0) as the "token" for ETH bribes
        address[] storage tokenList = epochBribeTokens[epoch][pair];
        if (epochBribes[epoch][pair][address(0)] == 0) {
            if (tokenList.length >= MAX_BRIBE_TOKENS) revert TooManyBribeTokens();
            tokenList.push(address(0));
        }

        epochBribes[epoch][pair][address(0)] += netBribe;
        totalUnclaimedETHBribes += netBribe;

        // C-02 FIX: Track first deposit timestamp for orphaned bribe rescue
        if (epochBribeFirstDeposit[epoch] == 0) {
            epochBribeFirstDeposit[epoch] = block.timestamp;
        }

        emit BribeDepositedETH(epoch, pair, msg.sender, netBribe, fee);
    }

    // ─── Claiming ────────────────────────────────────────────────────

    /// @notice Claim all bribe tokens for a specific epoch and pair.
    ///         Share = (userPower / totalPower) * bribeAmount per token.
    /// @param epoch The epoch index to claim from
    /// @param pair The pool pair to claim bribes for
    function claimBribes(uint256 epoch, address pair) external nonReentrant whenNotPaused {
        if (_isStakingPaused()) revert StakingPaused();
        if (epoch >= epochs.length) revert InvalidEpoch();
        if (pair == address(0)) revert InvalidPair();

        EpochInfo memory ep = epochs[epoch];
        if (ep.totalPower == 0) revert NothingToClaim();

        uint256 userPower = votingEscrow.votingPowerAtTimestamp(msg.sender, ep.timestamp);
        if (userPower == 0) revert NothingToClaim();

        // Cap userPower to totalPower (same safety as RevenueDistributor)
        if (userPower > ep.totalPower) userPower = ep.totalPower;

        address[] memory tokens = epochBribeTokens[epoch][pair];
        bool anyClaimed = false;

        for (uint256 i = 0; i < tokens.length; i++) {
            address token = tokens[i];
            if (claimed[msg.sender][epoch][pair][token]) continue;

            uint256 bribeAmount = epochBribes[epoch][pair][token];
            if (bribeAmount == 0) continue;

            uint256 share = (bribeAmount * userPower) / ep.totalPower;
            if (share == 0) continue;

            claimed[msg.sender][epoch][pair][token] = true;
            anyClaimed = true;

            // C-01 FIX: Safe subtraction to prevent underflow from rounding dust
            if (token == address(0)) {
                totalUnclaimedETHBribes = totalUnclaimedETHBribes > share ? totalUnclaimedETHBribes - share : 0;
            } else {
                totalUnclaimedBribes[token] = totalUnclaimedBribes[token] > share ? totalUnclaimedBribes[token] - share : 0;
            }

            if (token == address(0)) {
                // ETH bribe — try direct transfer, fallback to pending
                (bool ok,) = msg.sender.call{value: share, gas: 10000}("");
                if (!ok) {
                    pendingETHWithdrawals[msg.sender] += share;
                    totalPendingETH += share;
                    emit PendingETHCredited(msg.sender, share);
                }
            } else {
                // ERC20 bribe — safe transfer
                IERC20(token).safeTransfer(msg.sender, share);
            }

            emit BribeClaimed(msg.sender, epoch, pair, token, share);
        }

        if (!anyClaimed) revert NothingToClaim();
    }

    /// @notice Batch claim bribes across multiple epochs for a single pair.
    /// @param epochStart First epoch to claim from (inclusive)
    /// @param epochEnd Last epoch to claim from (exclusive)
    /// @param pair The pool pair to claim bribes for
    function claimBribesBatch(uint256 epochStart, uint256 epochEnd, address pair) external nonReentrant whenNotPaused {
        if (_isStakingPaused()) revert StakingPaused();
        if (pair == address(0)) revert InvalidPair();
        if (epochEnd > epochs.length) epochEnd = epochs.length;
        if (epochStart >= epochEnd) revert NothingToClaim();
        if (epochEnd - epochStart > MAX_CLAIM_EPOCHS) revert TooManyUnclaimedEpochs();

        bool anyClaimed = false;

        for (uint256 e = epochStart; e < epochEnd; e++) {
            EpochInfo memory ep = epochs[e];
            if (ep.totalPower == 0) continue;

            uint256 userPower = votingEscrow.votingPowerAtTimestamp(msg.sender, ep.timestamp);
            if (userPower == 0) continue;
            if (userPower > ep.totalPower) userPower = ep.totalPower;

            address[] memory tokens = epochBribeTokens[e][pair];

            for (uint256 i = 0; i < tokens.length; i++) {
                address token = tokens[i];
                if (claimed[msg.sender][e][pair][token]) continue;

                uint256 bribeAmount = epochBribes[e][pair][token];
                if (bribeAmount == 0) continue;

                uint256 share = (bribeAmount * userPower) / ep.totalPower;
                if (share == 0) continue;

                claimed[msg.sender][e][pair][token] = true;
                anyClaimed = true;

                // C-01 FIX: Safe subtraction to prevent underflow from rounding dust
                if (token == address(0)) {
                    totalUnclaimedETHBribes = totalUnclaimedETHBribes > share ? totalUnclaimedETHBribes - share : 0;
                } else {
                    totalUnclaimedBribes[token] = totalUnclaimedBribes[token] > share ? totalUnclaimedBribes[token] - share : 0;
                }

                if (token == address(0)) {
                    (bool ok,) = msg.sender.call{value: share, gas: 10000}("");
                    if (!ok) {
                        pendingETHWithdrawals[msg.sender] += share;
                        totalPendingETH += share;
                        emit PendingETHCredited(msg.sender, share);
                    }
                } else {
                    IERC20(token).safeTransfer(msg.sender, share);
                }

                emit BribeClaimed(msg.sender, e, pair, token, share);
            }
        }

        if (!anyClaimed) revert NothingToClaim();
    }

    // ─── Pull-Pattern Withdrawals ────────────────────────────────────

    /// @notice Withdraw pending ETH that was credited due to a failed direct transfer.
    function withdrawPendingETH() external nonReentrant {
        uint256 amount = pendingETHWithdrawals[msg.sender];
        if (amount == 0) revert NoPendingWithdrawal();

        pendingETHWithdrawals[msg.sender] = 0;
        totalPendingETH -= amount;

        WETHFallbackLib.safeTransferETHOrWrap(address(weth), msg.sender, amount);

        emit PendingETHWithdrawn(msg.sender, amount);
    }

    // ─── View Functions ──────────────────────────────────────────────

    /// @notice Preview claimable bribe amounts for a user in a specific epoch/pair.
    function claimable(address user, uint256 epoch, address pair) external view returns (
        address[] memory tokens,
        uint256[] memory amounts
    ) {
        if (epoch >= epochs.length) return (new address[](0), new uint256[](0));

        EpochInfo memory ep = epochs[epoch];
        if (ep.totalPower == 0) return (new address[](0), new uint256[](0));

        uint256 userPower = votingEscrow.votingPowerAtTimestamp(user, ep.timestamp);
        if (userPower > ep.totalPower) userPower = ep.totalPower;

        tokens = epochBribeTokens[epoch][pair];
        amounts = new uint256[](tokens.length);

        for (uint256 i = 0; i < tokens.length; i++) {
            if (claimed[user][epoch][pair][tokens[i]]) continue;
            uint256 bribeAmount = epochBribes[epoch][pair][tokens[i]];
            if (bribeAmount > 0 && userPower > 0) {
                amounts[i] = (bribeAmount * userPower) / ep.totalPower;
            }
        }
    }

    /// @notice Get all bribe tokens for a given epoch and pair.
    function getEpochBribeTokens(uint256 epoch, address pair) external view returns (address[] memory) {
        return epochBribeTokens[epoch][pair];
    }

    /// @notice Get the list of all whitelisted tokens.
    function getWhitelistedTokens() external view returns (address[] memory) {
        return whitelistedTokenList;
    }

    // ─── Admin: Timelocked Fee Change (24h) ──────────────────────────

    function proposeFeeChange(uint256 newFee) external onlyOwner {
        if (newFee > MAX_FEE_BPS) revert FeeTooHigh();
        require(newFee > 0, "FEE_CANNOT_BE_ZERO"); // M-08 FIX
        pendingFeeBps = newFee;
        _propose(FEE_CHANGE, FEE_CHANGE_DELAY);
        emit FeeChangeProposed(bribeFeeBps, newFee, _executeAfter[FEE_CHANGE]);
    }

    function executeFeeChange() external onlyOwner {
        _execute(FEE_CHANGE);
        uint256 old = bribeFeeBps;
        bribeFeeBps = pendingFeeBps;
        pendingFeeBps = 0;
        emit FeeUpdated(old, bribeFeeBps);
    }

    function cancelFeeChange() external onlyOwner {
        _cancel(FEE_CHANGE);
        uint256 cancelled = pendingFeeBps;
        pendingFeeBps = 0;
        emit FeeChangeCancelled(cancelled);
    }

    // ─── Admin: Timelocked Treasury Change (48h) ─────────────────────

    function proposeTreasuryChange(address _newTreasury) external onlyOwner {
        if (_newTreasury == address(0)) revert ZeroAddress();
        pendingTreasury = _newTreasury;
        _propose(TREASURY_CHANGE, TREASURY_CHANGE_DELAY);
        emit TreasuryChangeProposed(_newTreasury, _executeAfter[TREASURY_CHANGE]);
    }

    function executeTreasuryChange() external onlyOwner {
        _execute(TREASURY_CHANGE);
        address old = treasury;
        treasury = pendingTreasury;
        pendingTreasury = address(0);
        emit TreasuryUpdated(old, treasury);
    }

    function cancelTreasuryChange() external onlyOwner {
        _cancel(TREASURY_CHANGE);
        address cancelled = pendingTreasury;
        pendingTreasury = address(0);
        emit TreasuryChangeCancelled(cancelled);
    }

    // ─── Admin: Timelocked Whitelist Change (24h) ────────────────────

    function proposeWhitelistChange(address token, bool add) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        pendingWhitelistToken = token;
        pendingWhitelistAction = add;
        _propose(WHITELIST_CHANGE, WHITELIST_CHANGE_DELAY);
        emit WhitelistChangeProposed(token, add, _executeAfter[WHITELIST_CHANGE]);
    }

    function executeWhitelistChange() external onlyOwner {
        _execute(WHITELIST_CHANGE);
        address token = pendingWhitelistToken;
        bool add = pendingWhitelistAction;
        pendingWhitelistToken = address(0);

        if (add) {
            if (!whitelistedTokens[token]) {
                whitelistedTokens[token] = true;
                whitelistedTokenList.push(token);
                emit TokenWhitelisted(token);
            }
        } else {
            if (whitelistedTokens[token]) {
                whitelistedTokens[token] = false;
                // Remove from list (swap-and-pop)
                for (uint256 i = 0; i < whitelistedTokenList.length; i++) {
                    if (whitelistedTokenList[i] == token) {
                        whitelistedTokenList[i] = whitelistedTokenList[whitelistedTokenList.length - 1];
                        whitelistedTokenList.pop();
                        break;
                    }
                }
                emit TokenRemovedFromWhitelist(token);
            }
        }
    }

    function cancelWhitelistChange() external onlyOwner {
        _cancel(WHITELIST_CHANGE);
        address cancelled = pendingWhitelistToken;
        pendingWhitelistToken = address(0);
        emit WhitelistChangeCancelled(cancelled);
    }

    // ─── Admin: Pause ────────────────────────────────────────────────

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    // ─── H-03 FIX: Pull-Pattern Treasury Fees ─────────────────────────

    /// @notice Withdraw accumulated treasury ETH fees (pull pattern).
    function withdrawTreasuryFees() external nonReentrant {
        uint256 amount = accumulatedTreasuryETH;
        require(amount > 0, "NO_FEES");
        accumulatedTreasuryETH = 0;
        (bool ok,) = treasury.call{value: amount}("");
        require(ok, "TRANSFER_FAILED");
    }

    // ─── C-02 FIX: Orphaned Bribe Rescue ────────────────────────────

    /// @notice Rescue bribes from an un-snapshotted epoch after BRIBE_RESCUE_DELAY.
    ///         Only callable if the epoch has NOT been snapshotted (i.e., epoch >= epochs.length).
    function rescueOrphanedBribes(uint256 epoch, address pair, address token) external onlyOwner nonReentrant {
        require(epoch >= epochs.length, "EPOCH_ALREADY_SNAPSHOTTED");
        require(epochBribeFirstDeposit[epoch] != 0, "NO_BRIBES_IN_EPOCH");
        require(block.timestamp >= epochBribeFirstDeposit[epoch] + BRIBE_RESCUE_DELAY, "RESCUE_TOO_EARLY");

        uint256 amount = epochBribes[epoch][pair][token];
        require(amount > 0, "NO_BRIBE");

        epochBribes[epoch][pair][token] = 0;
        if (token == address(0)) {
            totalUnclaimedETHBribes = totalUnclaimedETHBribes > amount ? totalUnclaimedETHBribes - amount : 0;
            (bool ok,) = treasury.call{value: amount}("");
            require(ok, "ETH_TRANSFER_FAILED");
        } else {
            totalUnclaimedBribes[token] = totalUnclaimedBribes[token] > amount ? totalUnclaimedBribes[token] - amount : 0;
            IERC20(token).safeTransfer(treasury, amount);
        }
    }

    // ─── Admin: Emergency Sweep ──────────────────────────────────────

    /// @notice Sweep stuck ETH beyond what's owed to claimers and active bribes.
    ///         Reserves: unclaimed ETH bribes + pending pull-pattern withdrawals + accumulated treasury fees.
    function sweepExcessETH() external onlyOwner nonReentrant {
        uint256 balance = address(this).balance;
        uint256 reserved = totalUnclaimedETHBribes + totalPendingETH + accumulatedTreasuryETH;
        uint256 sweepable = balance > reserved ? balance - reserved : 0;
        if (sweepable == 0) revert ZeroAmount();
        (bool ok,) = treasury.call{value: sweepable}("");
        require(ok, "SWEEP_FAILED");
    }

    /// @notice Sweep stuck ERC20 tokens beyond what's reserved as active bribes.
    ///         Only excess tokens (accidentally sent) can be swept — active bribes are protected.
    function sweepToken(address token) external onlyOwner nonReentrant {
        if (token == address(0)) revert ZeroAddress();
        uint256 balance = IERC20(token).balanceOf(address(this));
        uint256 reserved = totalUnclaimedBribes[token];
        uint256 sweepable = balance > reserved ? balance - reserved : 0;
        if (sweepable == 0) revert ZeroAmount();
        IERC20(token).safeTransfer(treasury, sweepable);
    }

    // ─── Internal ────────────────────────────────────────────────────

    /// @dev Validate that pair is a registered factory pair (H-04 fix).
    ///      Reads token0/token1 from the pair contract, then verifies with factory.getPair().
    ///      Prevents bribes to arbitrary/non-existent/unregistered addresses.
    function _validatePair(address pair) internal view {
        if (pair.code.length == 0) revert InvalidPair();
        // H-04 FIX: Verify pair is a registered factory pair by reading its tokens
        // and checking against factory.getPair()
        try ITegridyPair(pair).token0() returns (address t0) {
            try ITegridyPair(pair).token1() returns (address t1) {
                if (factory.getPair(t0, t1) != pair) revert InvalidPair();
            } catch {
                revert InvalidPair();
            }
        } catch {
            revert InvalidPair();
        }
    }

    /// @dev Check if the staking contract is paused (same pattern as RevenueDistributor).
    function _isStakingPaused() internal view returns (bool) {
        try votingEscrow.paused() returns (bool isPaused) {
            return isPaused;
        } catch {
            return false;
        }
    }

    receive() external payable {}
}
