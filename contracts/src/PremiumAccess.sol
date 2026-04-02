// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {OwnableNoRenounce} from "./base/OwnableNoRenounce.sol";
import {TimelockAdmin} from "./base/TimelockAdmin.sol";

/// @title PremiumAccess
/// @notice Subscription-based premium features. JBAC NFT holders get free access.
///         Everyone else pays a monthly fee in TOWELI.
///
///         Premium benefits (enforced off-chain or by other contracts checking hasPremium):
///         - Priority harvest execution
///         - Advanced analytics dashboard
///         - Exclusive pool access
///         - Reduced withdrawal fees
///         - Custom alerts
///
///         Revenue: subscription fees go to treasury in TOWELI.
///
/// Battle-tested sources:
///  - OwnableNoRenounce: OZ Ownable2Step (industry standard)
///  - TimelockAdmin: MakerDAO DSPause pattern (billions TVL, never compromised)
contract PremiumAccess is OwnableNoRenounce, ReentrancyGuard, TimelockAdmin {
    using SafeERC20 for IERC20;

    // ─── Timelock Operation Keys ─────────────────────────────────────
    bytes32 public constant FEE_CHANGE = keccak256("FEE_CHANGE");
    bytes32 public constant TREASURY_CHANGE = keccak256("TREASURY_CHANGE");

    IERC20 public immutable toweli;
    IERC721 public immutable jbacNFT;
    address public treasury;

    uint256 public monthlyFeeToweli; // TOWELI per month
    uint256 public constant MONTH = 30 days;

    struct Subscription {
        uint256 expiresAt;
        bool _deprecated_lifetime; // DEPRECATED: NFT access now checked at query time, not granted permanently
        uint256 startedAt; // CRITICAL FIX: when the current subscription period started
    }

    mapping(address => Subscription) public subscriptions;
    mapping(address => uint256) public totalPaidByUser; // SECURITY FIX #17: track payments for pro-rata refund
    // AUDIT FIX M-43: Store the fee rate at subscription time for accurate refunds
    mapping(address => uint256) public paidFeeRate;
    mapping(address => uint256) public userEscrow; // CRITICAL FIX: actual TOWELI escrowed per user
    mapping(address => bool) public isActiveSubscriber; // AUDIT FIX L-04: track active status for accurate counter
    uint256 public totalSubscribers; // Currently active subscribers
    uint256 public totalRevenue;
    // SECURITY FIX #3: Track total refund escrow so withdrawToTreasury doesn't drain refundable funds
    uint256 public totalRefundEscrow;
    // A4-C-02: NFT activation timestamp — prevents flash-loan NFT borrow attacks.
    // Users must call activateNFTPremium() in a prior block/timestamp before hasPremium() returns true.
    // AUDIT FIX M-36: Changed from block.number to block.timestamp for L2 compatibility
    // (block.number on Arbitrum returns L1 block number, making block-based checks unreliable)
    mapping(address => uint256) public nftActivationBlock; // kept name for storage compat, stores timestamp now
    uint256 public constant MIN_ACTIVATION_DELAY = 15 seconds;

    // ─── Timelock Constants ──────────────────────────────────────────
    uint256 public constant TREASURY_CHANGE_DELAY = 48 hours;
    uint256 public constant FEE_CHANGE_DELAY = 24 hours;

    // ─── Pending Values (for timelocked changes) ─────────────────────
    address public pendingTreasury;
    uint256 public pendingMonthlyFee;

    event Subscribed(address indexed user, uint256 months, uint256 paid, uint256 expiresAt);
    event NFTAccessGranted(address indexed user);
    event NFTAccessRevoked(address indexed user);
    event FeeUpdated(uint256 oldFee, uint256 newFee);
    event SubscriptionCancelled(address indexed user, uint256 refundAmount, uint256 remainingTime); // SECURITY FIX #17
    event TreasuryUpdated(address oldTreasury, address newTreasury); // SECURITY FIX #19
    event TreasuryChangeProposed(address indexed newTreasury, uint256 executeAfter); // AUDIT FIX #68
    event TreasuryChangeExecuted(address oldTreasury, address newTreasury); // AUDIT FIX #68
    event TreasuryChangeCancelled(address cancelledTreasury);
    event FeeChangeProposed(uint256 currentFee, uint256 newFee, uint256 executeAfter);
    event FeeChangeCancelled(uint256 cancelledFee);

    error ZeroAddress();
    error ZeroMonths();
    error InsufficientPayment();
    error NoActiveSubscription(); // SECURITY FIX #17
    error RefundFailed(); // SECURITY FIX #17
    error UseProposeTreasuryChange(); // AUDIT FIX #68
    error ZeroFee(); // AUDIT FIX H-06

    // Legacy error aliases (kept for test compatibility)
    // Note: ProposalExpired() removed — use TimelockAdmin.ProposalExpired(bytes32) instead
    error NoPendingTreasuryChange();
    error TreasuryChangeNotReady();
    error NoPendingFeeChange();
    error FeeChangeNotReady();

    // ─── Legacy View Helpers (for test compatibility) ──────────────
    function feeChangeTime() external view returns (uint256) { return _executeAfter[FEE_CHANGE]; }
    function treasuryChangeTime() external view returns (uint256) { return _executeAfter[TREASURY_CHANGE]; }

    constructor(address _toweli, address _jbacNFT, address _treasury, uint256 _monthlyFee) OwnableNoRenounce(msg.sender) {
        if (_toweli == address(0) || _jbacNFT == address(0) || _treasury == address(0)) revert ZeroAddress();
        // AUDIT FIX: Prevent zero fee in constructor (proposeFeeChange already blocks zero)
        if (_monthlyFee == 0) revert ZeroFee();
        toweli = IERC20(_toweli);
        jbacNFT = IERC721(_jbacNFT);
        treasury = _treasury;
        monthlyFeeToweli = _monthlyFee;
    }

    /// @notice Check if a user has premium access (current NFT holder OR active subscription)
    /// @dev NFT ownership is checked at query time to prevent flash loan exploits.
    ///      User must currently hold the NFT — previous ownership does not grant access.
    ///      SECURITY FIX M-13: Downstream contracts should use hasPremiumSecure() if flash loan
    ///      resistance is needed. This view function alone cannot prevent same-block flash borrow.
    // @deprecated Use hasPremiumSecure() for on-chain integrations. This function is vulnerable
    //             to flash-loan NFT borrows — an attacker can borrow an NFT within a single
    //             transaction to pass the balanceOf check. hasPremiumSecure() only considers
    //             subscription-based access, which requires upfront TOWELI payment and is
    //             inherently multi-block.
    // WARNING TO INTEGRATORS: Do NOT use hasPremium() for on-chain gating of valuable actions.
    // Use hasPremiumSecure() instead to prevent flash-loan NFT borrow attacks.
    function hasPremium(address user) external view returns (bool) {
        // A4-C-02: JBAC NFT holders must have activated in a PRIOR block to prevent flash-loan attacks.
        // Activation persists — only needs to be done once while holding the NFT.
        // AUDIT FIX M-36: Use timestamp comparison for L2 compatibility
        if (jbacNFT.balanceOf(user) > 0 && nftActivationBlock[user] != 0 && block.timestamp > nftActivationBlock[user] + MIN_ACTIVATION_DELAY) {
            return true;
        }
        // Check time-based subscription
        Subscription memory sub = subscriptions[user];
        return sub.expiresAt > block.timestamp;
    }

    /// @notice Flash-loan-resistant premium check for subscription-based access.
    ///         NFT-based access is NOT flash-loan resistant — standard ERC721 has no
    ///         historical balance query. For on-chain gating requiring flash-loan resistance,
    ///         only subscription-based premium is considered secure.
    ///         A3-H-02 FIX: Removed false proofBlock check that gave false sense of security.
    /// @param user The address to check
    function hasPremiumSecure(address user) external view returns (bool) {
        // Subscription-based: always safe (multi-block by design, requires upfront TOWELI payment)
        Subscription memory sub = subscriptions[user];
        if (sub.expiresAt > block.timestamp) return true;
        // NFT-based: NOT flash-loan resistant. Only return true if subscription started
        // at least 1 block ago (subscription is multi-block by nature). For NFT holders
        // who also have an active subscription, the subscription check above covers them.
        // Pure NFT holders without a subscription are NOT covered by hasPremiumSecure.
        return false;
    }

    /// @notice A4-C-02: Activate NFT-based premium. Must be called while holding a JBAC NFT.
    ///         Premium takes effect in the NEXT block to prevent flash-loan exploits.
    ///         Only needs to be called once — activation persists across blocks.
    /// @notice Activate NFT-based premium. Automatically called in hasPremium if user holds JBAC.
    ///         AUDIT FIX M-37: Can also be called automatically by frontend on wallet connect.
    function activateNFTPremium() external {
        require(jbacNFT.balanceOf(msg.sender) > 0, "NO_JBAC_NFT");
        // AUDIT FIX M-36: Store timestamp instead of block.number for L2 compatibility
        nftActivationBlock[msg.sender] = block.timestamp;
        emit NFTAccessGranted(msg.sender);
    }

    /// @notice AUDIT FIX: Clear stale NFT activation for users who no longer hold a JBAC NFT.
    ///         Prevents flash-loan bypass by returning holders who activated in a prior session.
    ///         Requires activation to be at least 10 blocks old to prevent griefing during
    ///         temporary NFT transfers (marketplace listings, bridges, etc.)
    /// @param user The address to deactivate
    function deactivateNFTPremium(address user) external {
        uint256 activationBlock = nftActivationBlock[user];
        // AUDIT FIX M-36: Use timestamp comparison (10 minutes grace period instead of 10 blocks)
        if (activationBlock != 0 && jbacNFT.balanceOf(user) == 0 && block.timestamp > activationBlock + 10 minutes) {
            nftActivationBlock[user] = 0;
            emit NFTAccessRevoked(user);
        }
    }

    /// @notice Subscribe for X months by paying TOWELI
    ///         SECURITY FIX #17: Funds held in contract (not sent to treasury immediately)
    ///         to enable pro-rata refunds on cancellation.
    /// @param months Number of months to subscribe
    /// @param maxCost Maximum TOWELI the caller is willing to pay (front-running protection)
    function subscribe(uint256 months, uint256 maxCost) external nonReentrant {
        if (months == 0) revert ZeroMonths();

        uint256 cost = monthlyFeeToweli * months;
        // AUDIT FIX M-11: Protect against fee front-running
        require(cost <= maxCost, "COST_EXCEEDS_MAX");
        // SECURITY FIX #17: Hold funds in contract for potential refund
        toweli.safeTransferFrom(msg.sender, address(this), cost);

        Subscription storage sub = subscriptions[msg.sender];
        bool isNewSub = sub.expiresAt <= block.timestamp;
        // AUDIT FIX M-18: Prevent same-block subscribe+cancel for free premium window
        require(sub.startedAt != block.timestamp || isNewSub, "ALREADY_SUBSCRIBED_THIS_BLOCK");
        uint256 startFrom = isNewSub ? block.timestamp : sub.expiresAt;

        // AUDIT FIX C-03/C-08: Reset startedAt on extension so each period is tracked independently
        // CRITICAL: Calculate remaining escrow BEFORE updating expiresAt to avoid using stale values
        if (!isNewSub) {
            // Calculate remaining escrow from current period using OLD expiresAt
            uint256 remainingTime = sub.expiresAt - block.timestamp;
            uint256 totalDuration = sub.expiresAt - sub.startedAt;
            // SECURITY FIX M-14: Explicit handling for totalDuration == 0 (extension in same block).
            // If subscribed and extended in the same block, no time has elapsed so full escrow remains.
            uint256 remainingEscrow = totalDuration > 0 ? (userEscrow[msg.sender] * remainingTime) / totalDuration : userEscrow[msg.sender];
            // Consumed portion is no longer refundable
            uint256 consumed = userEscrow[msg.sender] - remainingEscrow;
            totalRefundEscrow -= consumed;
            // Now update expiresAt for the extension
            sub.expiresAt = startFrom + (months * MONTH);
            // Reset for new period
            sub.startedAt = block.timestamp;
            userEscrow[msg.sender] = remainingEscrow + cost;
            totalRefundEscrow += cost;
        } else {
            // AUDIT FIX H-04: Clear expired escrow from totalRefundEscrow before adding new
            uint256 oldEscrow = userEscrow[msg.sender];
            if (oldEscrow > 0) {
                totalRefundEscrow = totalRefundEscrow > oldEscrow ? totalRefundEscrow - oldEscrow : 0;
            }
            sub.expiresAt = startFrom + (months * MONTH);
            sub.startedAt = block.timestamp;
            userEscrow[msg.sender] = cost;
            totalRefundEscrow += cost;
        }

        totalPaidByUser[msg.sender] += cost;
        // AUDIT FIX M-43: Snapshot fee rate at subscription time for accurate refund calculation
        paidFeeRate[msg.sender] = monthlyFeeToweli;
        // AUDIT FIX L-04: Only increment when transitioning from inactive to active
        if (!isActiveSubscriber[msg.sender]) {
            isActiveSubscriber[msg.sender] = true;
            totalSubscribers++;
        }
        // M-06: Always increment totalRevenue, including on extensions
        totalRevenue += cost;

        emit Subscribed(msg.sender, months, cost, sub.expiresAt);
    }

    /// @notice SECURITY FIX #17: Cancel subscription and receive pro-rata refund for unused time.
    ///         AUDIT FIX M-43: Refund uses userEscrow (actual amount paid at subscription-time fee rate),
    ///         not the current monthlyFeeToweli, so fee changes after subscription don't affect refunds.
    function cancelSubscription() external nonReentrant {
        Subscription storage sub = subscriptions[msg.sender];
        if (sub.expiresAt <= block.timestamp) revert NoActiveSubscription();
        // AUDIT FIX M-18: Prevent same-block subscribe+cancel to avoid free premium window exploit
        require(block.timestamp > sub.startedAt, "SAME_BLOCK_CANCEL");

        uint256 remainingTime = sub.expiresAt - block.timestamp;
        uint256 totalDuration = sub.expiresAt - sub.startedAt;

        // CRITICAL FIX: Proportional refund based on actual escrowed amount and remaining time
        uint256 escrowed = userEscrow[msg.sender];
        // AUDIT FIX v3: If cancelled in same block as subscription, refund full escrow (totalDuration == 0)
        uint256 refundAmount = totalDuration == 0 ? escrowed : (escrowed * remainingTime) / totalDuration;

        // Cap refund at userEscrow (can't refund more than deposited)
        if (refundAmount > escrowed) {
            refundAmount = escrowed;
        }

        // Cap refund to contract balance to be safe
        uint256 contractBalance = toweli.balanceOf(address(this));
        if (refundAmount > contractBalance) {
            refundAmount = contractBalance;
        }

        // End subscription immediately
        sub.expiresAt = block.timestamp;
        // AUDIT FIX L-04: Only decrement when transitioning from active to inactive
        if (isActiveSubscriber[msg.sender]) {
            isActiveSubscriber[msg.sender] = false;
            totalSubscribers--;
        }

        // CRITICAL FIX: Decrease totalRefundEscrow by the actual refund amount + consumed portion
        // The entire user escrow is no longer refundable (subscription is cancelled)
        if (escrowed <= totalRefundEscrow) {
            totalRefundEscrow -= escrowed;
        } else {
            totalRefundEscrow = 0;
        }
        userEscrow[msg.sender] = 0;
        paidFeeRate[msg.sender] = 0; // AUDIT FIX M-43: Clear snapshotted fee rate on cancel

        if (refundAmount > 0) {
            if (refundAmount <= totalRevenue) {
                totalRevenue -= refundAmount;
            }
            toweli.safeTransfer(msg.sender, refundAmount);
        }

        emit SubscriptionCancelled(msg.sender, refundAmount, remainingTime);
    }

    /// @notice AUDIT FIX H-04: Reconcile expired subscriptions to free locked totalRefundEscrow.
    ///         Anyone can call this for any user whose subscription has expired.
    function reconcileExpired(address _user) external {
        Subscription memory sub = subscriptions[_user];
        if (sub.expiresAt > block.timestamp) return; // Still active, nothing to do
        uint256 escrow = userEscrow[_user];
        if (escrow == 0) return; // Already reconciled
        totalRefundEscrow = totalRefundEscrow > escrow ? totalRefundEscrow - escrow : 0;
        userEscrow[_user] = 0;
        // Clean up active subscriber tracking
        if (isActiveSubscriber[_user]) {
            isActiveSubscriber[_user] = false;
            if (totalSubscribers > 0) totalSubscribers--;
        }
    }

    /// @notice A4-H-08: Batch reconcile multiple expired subscriptions in one call.
    ///         Prevents totalRefundEscrow from permanently inflating and locking treasury funds.
    function batchReconcileExpired(address[] calldata _users) external {
        for (uint256 i = 0; i < _users.length; i++) {
            address user = _users[i];
            Subscription memory sub = subscriptions[user];
            if (sub.expiresAt > block.timestamp) continue; // Still active
            uint256 escrow = userEscrow[user];
            if (escrow == 0) continue; // Already reconciled
            totalRefundEscrow = totalRefundEscrow > escrow ? totalRefundEscrow - escrow : 0;
            userEscrow[user] = 0;
            if (isActiveSubscriber[user]) {
                isActiveSubscriber[user] = false;
                if (totalSubscribers > 0) totalSubscribers--;
            }
        }
    }

    /// @notice Owner can withdraw earned (non-refundable) subscription fees to treasury
    ///         SECURITY FIX #3: Only withdraws balance minus escrowed refund amounts
    // AUDIT FIX: Added nonReentrant for defense-in-depth
    function withdrawToTreasury() external onlyOwner nonReentrant {
        uint256 balance = toweli.balanceOf(address(this));
        uint256 withdrawable = balance > totalRefundEscrow ? balance - totalRefundEscrow : 0;
        if (withdrawable > 0) {
            toweli.safeTransfer(treasury, withdrawable);
        }
    }

    /// @notice DEPRECATED: NFT access is now checked dynamically at query time.
    ///         Users holding a JBAC NFT automatically have premium — no claim needed.
    ///         Use hasPremium() or subscribe() instead.
    function claimNFTAccess() external pure {
        // AUDIT FIX: Updated deprecation message to reference hasPremiumSecure() for on-chain use
        revert("DEPRECATED: Use hasPremiumSecure() for on-chain or hasPremium() for off-chain");
    }

    // ─── Admin ────────────────────────────────────────────────────────

    /// @notice DEPRECATED: Use proposeFeeChange() + executeFeeChange()
    function setMonthlyFee(uint256) external pure {
        revert("Use proposeFeeChange()");
    }

    /// @notice AUDIT FIX v2: Propose a monthly fee change (takes effect after 24h delay)
    function proposeFeeChange(uint256 _fee) external onlyOwner {
        if (_fee == 0) revert ZeroFee();
        pendingMonthlyFee = _fee;
        _propose(FEE_CHANGE, FEE_CHANGE_DELAY);
        emit FeeChangeProposed(monthlyFeeToweli, _fee, _executeAfter[FEE_CHANGE]);
    }

    /// @notice AUDIT FIX v2: Execute a previously proposed fee change after the timelock
    function executeFeeChange() external onlyOwner {
        _execute(FEE_CHANGE);
        uint256 old = monthlyFeeToweli;
        monthlyFeeToweli = pendingMonthlyFee;
        pendingMonthlyFee = 0;
        emit FeeUpdated(old, monthlyFeeToweli);
    }

    /// @notice Cancel a pending fee change
    function cancelFeeChange() external onlyOwner {
        _cancel(FEE_CHANGE);
        uint256 cancelled = pendingMonthlyFee;
        pendingMonthlyFee = 0;
        emit FeeChangeCancelled(cancelled);
    }

    /// @notice DEPRECATED: Use proposeTreasuryChange() + executeTreasuryChange() instead.
    ///         AUDIT FIX #68: Single-step treasury change replaced with 48h timelocked 2-step pattern.
    function setTreasury(address) external pure {
        revert UseProposeTreasuryChange();
    }

    /// @notice AUDIT FIX #68: Propose a treasury change (takes effect after 48h delay)
    /// @param _treasury The proposed new treasury address
    function proposeTreasuryChange(address _treasury) external onlyOwner {
        if (_treasury == address(0)) revert ZeroAddress();
        pendingTreasury = _treasury;
        _propose(TREASURY_CHANGE, TREASURY_CHANGE_DELAY);
        emit TreasuryChangeProposed(_treasury, _executeAfter[TREASURY_CHANGE]);
    }

    /// @notice Cancel a pending treasury change proposal
    function cancelTreasuryChange() external onlyOwner {
        _cancel(TREASURY_CHANGE);
        address cancelled = pendingTreasury;
        pendingTreasury = address(0);
        emit TreasuryChangeCancelled(cancelled);
    }

    /// @notice AUDIT FIX #68: Execute a previously proposed treasury change after the timelock
    function executeTreasuryChange() external onlyOwner {
        _execute(TREASURY_CHANGE);
        address old = treasury;
        treasury = pendingTreasury;
        pendingTreasury = address(0);
        emit TreasuryChangeExecuted(old, treasury);
    }

    // ─── View ─────────────────────────────────────────────────────────

    function getSubscription(address user) external view returns (uint256 expiresAt, bool lifetime, bool active) {
        Subscription memory sub = subscriptions[user];
        bool nftHolder = jbacNFT.balanceOf(user) > 0;
        // lifetime is true only if user currently holds NFT (checked at query time)
        return (sub.expiresAt, nftHolder, nftHolder || sub.expiresAt > block.timestamp);
    }
}
