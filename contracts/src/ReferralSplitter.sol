// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title ReferralSplitter
/// @notice On-chain referral tracking. When a referred user's swap fee is received,
///         a percentage goes to the referrer automatically.
///
///         Flow:
///         1. User registers a referrer on-chain (one-time)
///         2. When the protocol collects fees, it calls recordFee(user, amount)
///         3. The referrer's share (default 10%) is credited
///         4. Referrers claim accumulated ETH anytime
contract ReferralSplitter is Ownable2Step, ReentrancyGuard {

    // ─── State ────────────────────────────────────────────────────────

    uint256 public referralFeeBps; // Referrer's share in bps (1000 = 10%)
    uint256 public constant MAX_REFERRAL_FEE = 3000; // Max 30%
    uint256 public constant BPS = 10000;

    mapping(address => address) public referrerOf;  // user => referrer
    mapping(address => uint256) public pendingETH;  // referrer => claimable ETH
    mapping(address => uint256) public totalReferred; // referrer => total users referred
    mapping(address => uint256) public totalEarned; // referrer => total ETH earned

    uint256 public totalReferralsPaid;

    // ─── Events ───────────────────────────────────────────────────────

    event ReferrerSet(address indexed user, address indexed referrer);
    event FeeRecorded(address indexed user, address indexed referrer, uint256 totalFee, uint256 referrerShare);
    event ReferralClaimed(address indexed referrer, uint256 amount);
    event ReferralFeeUpdated(uint256 oldFee, uint256 newFee);

    // ─── Errors ───────────────────────────────────────────────────────

    error SelfReferral();
    error AlreadyReferred();
    error NothingToClaim();
    error ETHTransferFailed();
    error FeeTooHigh();
    error ZeroAddress();

    // ─── Constructor ──────────────────────────────────────────────────

    constructor(uint256 _referralFeeBps) Ownable(msg.sender) {
        if (_referralFeeBps > MAX_REFERRAL_FEE) revert FeeTooHigh();
        referralFeeBps = _referralFeeBps;
    }

    receive() external payable {}

    // ─── User Functions ───────────────────────────────────────────────

    /// @notice Register your referrer (one-time, permanent)
    function setReferrer(address _referrer) external {
        if (_referrer == msg.sender) revert SelfReferral();
        if (_referrer == address(0)) revert ZeroAddress();
        if (referrerOf[msg.sender] != address(0)) revert AlreadyReferred();

        referrerOf[msg.sender] = _referrer;
        totalReferred[_referrer] += 1;

        emit ReferrerSet(msg.sender, _referrer);
    }

    /// @notice Record a fee event for a user. If they have a referrer, credit the referrer.
    ///         Called by authorized fee collectors (owner or approved contracts).
    function recordFee(address _user) external payable onlyOwner {
        if (msg.value == 0) return;

        address referrer = referrerOf[_user];
        if (referrer == address(0)) return; // No referrer, fee stays in contract

        uint256 referrerShare = (msg.value * referralFeeBps) / BPS;
        if (referrerShare > 0) {
            pendingETH[referrer] += referrerShare;
            totalEarned[referrer] += referrerShare;
            totalReferralsPaid += referrerShare;

            emit FeeRecorded(_user, referrer, msg.value, referrerShare);
        }
    }

    /// @notice Claim accumulated referral earnings
    function claimReferralRewards() external nonReentrant {
        uint256 amount = pendingETH[msg.sender];
        if (amount == 0) revert NothingToClaim();

        pendingETH[msg.sender] = 0;

        (bool success,) = msg.sender.call{value: amount}("");
        if (!success) revert ETHTransferFailed();

        emit ReferralClaimed(msg.sender, amount);
    }

    // ─── Admin ────────────────────────────────────────────────────────

    function setReferralFee(uint256 _feeBps) external onlyOwner {
        if (_feeBps > MAX_REFERRAL_FEE) revert FeeTooHigh();
        uint256 old = referralFeeBps;
        referralFeeBps = _feeBps;
        emit ReferralFeeUpdated(old, _feeBps);
    }

    // ─── View ─────────────────────────────────────────────────────────

    function getReferralInfo(address _referrer) external view returns (
        uint256 referred, uint256 earned, uint256 pending
    ) {
        return (totalReferred[_referrer], totalEarned[_referrer], pendingETH[_referrer]);
    }
}
