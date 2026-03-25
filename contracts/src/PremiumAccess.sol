// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";

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
contract PremiumAccess is Ownable2Step {
    using SafeERC20 for IERC20;

    IERC20 public immutable toweli;
    IERC721 public immutable jbacNFT;
    address public treasury;

    uint256 public monthlyFeeToweli; // TOWELI per month
    uint256 public constant MONTH = 30 days;

    struct Subscription {
        uint256 expiresAt;
        bool _deprecated_lifetime; // DEPRECATED: NFT access now checked at query time, not granted permanently
    }

    mapping(address => Subscription) public subscriptions;
    uint256 public totalSubscribers;
    uint256 public totalRevenue;

    event Subscribed(address indexed user, uint256 months, uint256 paid, uint256 expiresAt);
    event NFTAccessGranted(address indexed user);
    event FeeUpdated(uint256 oldFee, uint256 newFee);

    error ZeroAddress();
    error ZeroMonths();
    error InsufficientPayment();

    constructor(address _toweli, address _jbacNFT, address _treasury, uint256 _monthlyFee) Ownable(msg.sender) {
        if (_toweli == address(0) || _jbacNFT == address(0) || _treasury == address(0)) revert ZeroAddress();
        toweli = IERC20(_toweli);
        jbacNFT = IERC721(_jbacNFT);
        treasury = _treasury;
        monthlyFeeToweli = _monthlyFee;
    }

    /// @notice Check if a user has premium access (current NFT holder OR active subscription)
    /// @dev NFT ownership is checked at query time to prevent flash loan exploits.
    ///      User must currently hold the NFT — previous ownership does not grant access.
    function hasPremium(address user) external view returns (bool) {
        // JBAC NFT holders have premium only while they hold the NFT
        if (jbacNFT.balanceOf(user) > 0) return true;
        // Check time-based subscription
        Subscription memory sub = subscriptions[user];
        return sub.expiresAt > block.timestamp;
    }

    /// @notice Subscribe for X months by paying TOWELI
    function subscribe(uint256 months) external {
        if (months == 0) revert ZeroMonths();

        uint256 cost = monthlyFeeToweli * months;
        toweli.safeTransferFrom(msg.sender, treasury, cost);

        Subscription storage sub = subscriptions[msg.sender];
        uint256 startFrom = sub.expiresAt > block.timestamp ? sub.expiresAt : block.timestamp;
        sub.expiresAt = startFrom + (months * MONTH);

        if (sub.expiresAt == 0) totalSubscribers++; // First-time subscriber
        totalRevenue += cost;

        emit Subscribed(msg.sender, months, cost, sub.expiresAt);
    }

    /// @notice DEPRECATED: NFT access is now checked dynamically at query time.
    ///         This function is kept for interface compatibility but is a no-op.
    ///         Users holding a JBAC NFT automatically have premium — no claim needed.
    function claimNFTAccess() external {
        require(jbacNFT.balanceOf(msg.sender) > 0, "Not NFT holder");
        // No-op: NFT access is now checked at query time in hasPremium()
        // to prevent flash loan attacks (borrow NFT -> claim lifetime -> return NFT)
        emit NFTAccessGranted(msg.sender);
    }

    // ─── Admin ────────────────────────────────────────────────────────

    function setMonthlyFee(uint256 _fee) external onlyOwner {
        uint256 old = monthlyFeeToweli;
        monthlyFeeToweli = _fee;
        emit FeeUpdated(old, _fee);
    }

    function setTreasury(address _treasury) external onlyOwner {
        if (_treasury == address(0)) revert ZeroAddress();
        treasury = _treasury;
    }

    // ─── View ─────────────────────────────────────────────────────────

    function getSubscription(address user) external view returns (uint256 expiresAt, bool lifetime, bool active) {
        Subscription memory sub = subscriptions[user];
        bool nftHolder = jbacNFT.balanceOf(user) > 0;
        // lifetime is true only if user currently holds NFT (checked at query time)
        return (sub.expiresAt, nftHolder, nftHolder || sub.expiresAt > block.timestamp);
    }
}
