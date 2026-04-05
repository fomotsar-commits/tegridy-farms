// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {OwnableNoRenounce} from "./base/OwnableNoRenounce.sol";
import {TimelockAdmin} from "./base/TimelockAdmin.sol";
import {WETHFallbackLib, IWETH} from "./lib/WETHFallbackLib.sol";

interface IStakingForReferral {
    function votingPowerOf(address user) external view returns (uint256);
}

/// @title ReferralSplitter
/// @notice On-chain referral tracking. When a referred user's swap fee is received,
///         a percentage goes to the referrer automatically.
///
///         Flow:
///         1. User registers a referrer on-chain (one-time)
///         2. When the protocol collects fees, it calls recordFee(user, amount)
///         3. The referrer's share (default 10%) is credited
///         4. Referrers claim accumulated ETH anytime
///
///         SECURITY FIX #16: Referrers must have an active staking position to earn rewards.
///
/// Battle-tested sources:
///  - OwnableNoRenounce: OZ Ownable2Step (industry standard)
///  - TimelockAdmin: MakerDAO DSPause pattern (billions TVL, never compromised)
///  - WETHFallbackLib: Solmate SafeTransferLib + WETH fallback (Uniswap V3/V4, Seaport)
contract ReferralSplitter is OwnableNoRenounce, ReentrancyGuard, TimelockAdmin {

    // ─── Timelock Operation Keys ─────────────────────────────────────
    bytes32 public constant REFERRAL_FEE_CHANGE = keccak256("REFERRAL_FEE_CHANGE");
    bytes32 public constant TREASURY_CHANGE = keccak256("TREASURY_CHANGE");
    bytes32 public constant CALLER_GRANT = keccak256("CALLER_GRANT");

    // ─── State ────────────────────────────────────────────────────────

    IStakingForReferral public immutable stakingContract; // SECURITY FIX #16
    address public immutable weth; // WETH fallback for revert-on-receive addresses
    uint256 public constant MIN_REFERRAL_STAKE_POWER = 1000e18; // SECURITY FIX #16: must have 1000 TOWELI equivalent voting power

    address public treasury; // SECURITY FIX: treasury for unclaimable referral funds

    uint256 public referralFeeBps; // Referrer's share in bps (1000 = 10%)
    uint256 public constant MAX_REFERRAL_FEE = 3000; // Max 30%
    uint256 public constant BPS = 10000;

    mapping(address => address) public referrerOf;  // user => referrer
    mapping(address => uint256) public pendingETH;  // referrer => claimable ETH
    mapping(address => uint256) public totalReferred; // referrer => total users referred
    mapping(address => uint256) public totalEarned; // referrer => total ETH earned

    mapping(address => bool) public approvedCallers; // Approved fee recorders
    mapping(address => uint256) public lastReferrerChange; // Cooldown tracking for referrer updates
    mapping(address => uint256) public lastClaimTime; // Track last claim time for forfeiture
    uint256 public constant REFERRER_COOLDOWN = 30 days;
    uint256 public constant FORFEITURE_PERIOD = 90 days;

    uint256 public totalReferralsPaid;
    uint256 public totalPendingETH; // Total unclaimed referral ETH — protects against sweepUnclaimable
    uint256 public accumulatedTreasuryETH; // AUDIT FIX M-05: Pull-pattern for treasury-bound referral fees
    mapping(address => uint256) public callerCredit; // SECURITY FIX H-04: Pull-pattern for non-referral ETH returns
    uint256 public totalCallerCredit; // SECURITY FIX S2-H-01: Track total callerCredit to protect from sweepUnclaimable
    mapping(address => uint256) public lastBelowStakeTime; // Timestamp when referrer was marked below MIN_REFERRAL_STAKE_POWER
    uint256 public constant BELOW_STAKE_GRACE_PERIOD = 7 days; // Grace period before forfeiture allowed

    mapping(address => uint256) public referrerRegisteredAt; // When a referrer first gained a referral
    uint256 public constant MIN_REFERRAL_AGE = 7 days; // Referrer must wait 7 days before claiming

    // AUDIT FIX M-17: Once setup is complete, instant setApprovedCaller is disabled — only timelocked path works
    bool public setupComplete;

    // ─── Timelock Constants ──────────────────────────────────────────
    uint256 public constant TREASURY_CHANGE_DELAY = 48 hours;
    uint256 public constant FEE_CHANGE_DELAY = 24 hours;
    uint256 public constant CALLER_GRANT_DELAY = 24 hours;

    // ─── Pending Values (for timelocked changes) ─────────────────────
    address public pendingTreasury;
    uint256 public pendingReferralFee;
    // For caller grants, we use a per-address pending mapping
    mapping(address => bool) public pendingCallerGrant; // tracks which address has a pending grant

    // ─── Events ───────────────────────────────────────────────────────

    event ReferrerSet(address indexed user, address indexed referrer);
    event FeeRecorded(address indexed user, address indexed referrer, uint256 totalFee, uint256 referrerShare);
    event ReferralClaimed(address indexed referrer, uint256 amount);
    event ReferralFeeUpdated(uint256 oldFee, uint256 newFee);
    event ReferrerUpdated(address indexed user, address indexed oldReferrer, address indexed newReferrer);
    event ApprovedCallerSet(address indexed caller, bool approved);
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    event UnclaimableSentToTreasury(address indexed referrer, uint256 amount);
    event UnclaimedSwept(address indexed treasury, uint256 amount);
    event RewardsForfeited(address indexed referrer, uint256 amount);
    event TreasuryETHWithdrawn(address indexed treasury, uint256 amount); // AUDIT FIX M-05
    event ReferralRewardsPaidWETH(address indexed referrer, uint256 amount); // AUDIT FIX M-05/M-07: WETH fallback
    event TreasuryFeesPaidWETH(address indexed treasury, uint256 amount); // AUDIT FIX M-05/M-07: WETH fallback
    event SetupCompleted(); // AUDIT FIX M-17
    event ReferralFeeProposed(uint256 currentFee, uint256 proposedFee, uint256 executeAfter);
    event TreasuryChangeProposed(address currentTreasury, address proposedTreasury, uint256 executeAfter);
    event ReferralFeeCancelled(uint256 cancelledFee);
    event TreasuryChangeCancelled(address cancelledTreasury);
    event CallerGrantProposed(address indexed caller, uint256 executeAfter);
    event CallerGrantCancelled(address indexed caller);
    event BelowStakeMarked(address indexed referrer, uint256 timestamp);
    event CallerCreditPaidWETH(address indexed caller, uint256 amount);
    event UnclaimedSweptWETH(address indexed treasury, uint256 amount);

    // ─── Errors ───────────────────────────────────────────────────────

    error SelfReferral();
    error AlreadyReferred();
    error NothingToClaim();
    error ETHTransferFailed();
    error FeeTooHigh();
    error ZeroAddress();
    error ReferrerNotStaked(); // SECURITY FIX #16
    error NotApprovedCaller();
    error CooldownNotElapsed();
    error NoReferrerSet();
    error CircularReferral();
    error SameReferrer();
    error ForfeitureConditionsNotMet();
    error SetupAlreadyComplete(); // AUDIT FIX M-17
    error ReferralAgeTooRecent();

    // Legacy error aliases (kept for test compatibility)
    // Note: ProposalExpired() removed — use TimelockAdmin.ProposalExpired(bytes32) instead
    error NoPendingChange();
    error TimelockNotReady();

    // ─── Legacy View Helpers (for test compatibility) ──────────────
    function referralFeeChangeTime() external view returns (uint256) { return _executeAfter[REFERRAL_FEE_CHANGE]; }
    function treasuryChangeTime() external view returns (uint256) { return _executeAfter[TREASURY_CHANGE]; }
    function pendingCallerGrantTime(address _caller) external view returns (uint256) {
        // M-07: Per-address timelock key to prevent key collision between concurrent proposals.
        bytes32 key = keccak256(abi.encode("CALLER_GRANT", _caller));
        if (pendingCallerGrant[_caller]) return _executeAfter[key];
        return 0;
    }

    // ─── Constructor ──────────────────────────────────────────────────

    constructor(uint256 _referralFeeBps, address _stakingContract, address _treasury, address _weth) OwnableNoRenounce(msg.sender) {
        if (_referralFeeBps == 0) revert FeeTooHigh(); // S2-M-03: Disallow zero fee in constructor
        if (_referralFeeBps > MAX_REFERRAL_FEE) revert FeeTooHigh();
        if (_stakingContract == address(0)) revert ZeroAddress();
        if (_treasury == address(0)) revert ZeroAddress();
        if (_weth == address(0)) revert ZeroAddress();
        referralFeeBps = _referralFeeBps;
        stakingContract = IStakingForReferral(_stakingContract);
        treasury = _treasury;
        weth = _weth;
    }

    receive() external payable {}

    // ─── Modifiers ───────────────────────────────────────────────────

    modifier onlyApproved() {
        if (msg.sender != owner() && !approvedCallers[msg.sender]) revert NotApprovedCaller();
        _;
    }

    // ─── User Functions ───────────────────────────────────────────────

    /// @notice Register your referrer (one-time, permanent)
    /// @param _referrer The address of your referrer (cannot be yourself or zero address)
    function setReferrer(address _referrer) external {
        if (_referrer == msg.sender) revert SelfReferral();
        if (_referrer == address(0)) revert ZeroAddress();
        if (referrerOf[msg.sender] != address(0)) revert AlreadyReferred();
        // AUDIT FIX v3: Walk referral chain up to 5 levels to detect circular references (A→B→C→A)
        _checkCircularReferral(_referrer, msg.sender);

        referrerOf[msg.sender] = _referrer;
        totalReferred[_referrer] += 1;
        if (referrerRegisteredAt[_referrer] == 0) {
            referrerRegisteredAt[_referrer] = block.timestamp;
        }

        emit ReferrerSet(msg.sender, _referrer);
    }

    /// @notice Update referrer with a 30-day cooldown
    /// @param _newReferrer The new referrer address to replace the current one
    function updateReferrer(address _newReferrer) external {
        if (_newReferrer == msg.sender) revert SelfReferral();
        if (_newReferrer == address(0)) revert ZeroAddress();
        if (referrerOf[msg.sender] == address(0)) revert NoReferrerSet();
        // AUDIT FIX: Use custom error instead of require string for consistency
        if (_newReferrer == referrerOf[msg.sender]) revert SameReferrer();
        // AUDIT FIX v3: Walk referral chain up to 5 levels to detect circular references
        _checkCircularReferral(_newReferrer, msg.sender);
        if (block.timestamp < lastReferrerChange[msg.sender] + REFERRER_COOLDOWN) revert CooldownNotElapsed();

        address oldReferrer = referrerOf[msg.sender];
        referrerOf[msg.sender] = _newReferrer;
        lastReferrerChange[msg.sender] = block.timestamp;

        // AUDIT FIX: Guard against underflow if totalReferred is somehow already 0
        if (totalReferred[oldReferrer] > 0) totalReferred[oldReferrer] -= 1;
        totalReferred[_newReferrer] += 1;
        if (referrerRegisteredAt[_newReferrer] == 0) {
            referrerRegisteredAt[_newReferrer] = block.timestamp;
        }

        emit ReferrerUpdated(msg.sender, oldReferrer, _newReferrer);
    }

    /// @dev AUDIT FIX v3: Walk the referral chain to detect multi-level circular references
    /// A4-M-09: Reduced depth from 50 to 10 — deeper chains are extremely unlikely in practice,
    /// and 50 SLOADs creates a gas griefing vector. 10 levels is sufficient for real referral trees.
    function _checkCircularReferral(address _referrer, address _user) internal view {
        address current = _referrer;
        for (uint256 i = 0; i < 10; i++) {
            current = referrerOf[current];
            if (current == address(0)) break;
            if (current == _user) revert CircularReferral();
        }
    }

    /// @notice Record a fee event for a user. If they have a referrer, credit the referrer.
    ///         Called by authorized fee collectors (owner or approved contracts).
    ///         SECURITY FIX: If referrer is unregistered or doesn't meet min stake, send to treasury.
    ///         SECURITY FIX H-04: Non-referral ETH is credited via pull pattern (callerCredit)
    ///         instead of pushed back via .call to prevent reentrancy via callback.
    ///         A3-M-02 FIX: votingPowerOf wrapped in try/catch to prevent staking DoS.
    /// @param _user The user whose swap fee is being recorded
    function recordFee(address _user) external payable onlyApproved nonReentrant {
        require(_user != address(0), "ZERO_USER");
        if (msg.value == 0) return;

        address referrer = referrerOf[_user];
        uint256 referrerShare = (msg.value * referralFeeBps) / BPS;
        if (referrerShare == 0) {
            // SECURITY FIX H-04: Use pull pattern — credit caller instead of pushing ETH back
            callerCredit[msg.sender] += msg.value;
            totalCallerCredit += msg.value; // S2-H-01: Track total
            return;
        }

        // SECURITY FIX H-04: Credit non-referral portion to caller via pull pattern
        uint256 remainder = msg.value - referrerShare;
        if (remainder > 0) {
            callerCredit[msg.sender] += remainder;
            totalCallerCredit += remainder; // S2-H-01: Track total
        }

        // SECURITY FIX: If no referrer or referrer doesn't meet min stake, redirect to treasury
        // AUDIT FIX M-05: Use pull-pattern (accumulate) instead of push (direct send) to prevent
        // treasury contract DOS from blocking recordFee for all unqualified referrals.
        // A3-M-02: Wrap votingPowerOf in try/catch — if staking contract reverts, treat referrer
        // as unqualified (route to treasury) rather than blocking all fee recording.
        bool referrerQualified = false;
        if (referrer != address(0)) {
            try stakingContract.votingPowerOf(referrer) returns (uint256 power) {
                referrerQualified = power >= MIN_REFERRAL_STAKE_POWER;
            } catch {
                // Staking contract reverted — treat as unqualified
            }
        }
        if (!referrerQualified) {
            accumulatedTreasuryETH += referrerShare;
            emit UnclaimableSentToTreasury(referrer, referrerShare);
            return;
        }

        pendingETH[referrer] += referrerShare;
        totalPendingETH += referrerShare;
        totalEarned[referrer] += referrerShare;
        totalReferralsPaid += referrerShare;

        // Initialize lastClaimTime on first fee credit so forfeiture clock starts
        if (lastClaimTime[referrer] == 0) {
            lastClaimTime[referrer] = block.timestamp;
        }

        emit FeeRecorded(_user, referrer, msg.value, referrerShare);
    }

    /// @notice SECURITY FIX H-04: Withdraw credited ETH (pull pattern for non-referral returns).
    ///         Approved callers call this to retrieve their non-referral portion after recordFee.
    function withdrawCallerCredit() external nonReentrant {
        uint256 amount = callerCredit[msg.sender];
        if (amount == 0) revert NothingToClaim();
        callerCredit[msg.sender] = 0;
        totalCallerCredit -= amount; // S2-H-01: Decrement total
        // AUDIT FIX L-11: Use WETHFallbackLib directly — avoids redundant raw .call before WETH fallback
        WETHFallbackLib.safeTransferETHOrWrap(weth, msg.sender, amount);
        emit CallerCreditPaidWETH(msg.sender, amount);
    }

    /// @notice Claim accumulated referral earnings
    ///         SECURITY FIX #16: Referrer must have an active staking position to claim
    ///         A4-C-01 FIX: votingPowerOf wrapped in try/catch — if staking contract reverts,
    ///         claim is blocked (not silently allowed) but funds remain claimable once staking recovers.
    function claimReferralRewards() external nonReentrant {
        // SECURITY FIX H1: Removed voting power requirement from CLAIMING.
        // Stake check is enforced in recordFee() when EARNING new referrals.
        // Earned rewards must always be claimable regardless of current stake.
        // (Curve/Convex pattern — earned rewards are unconditionally claimable)
        if (referrerRegisteredAt[msg.sender] == 0 || block.timestamp < referrerRegisteredAt[msg.sender] + MIN_REFERRAL_AGE) revert ReferralAgeTooRecent();
        uint256 amount = pendingETH[msg.sender];
        if (amount == 0) revert NothingToClaim();

        pendingETH[msg.sender] = 0;
        totalPendingETH -= amount;
        lastClaimTime[msg.sender] = block.timestamp;

        // AUDIT FIX L-11: Use WETHFallbackLib directly — avoids redundant raw .call before WETH fallback
        WETHFallbackLib.safeTransferETHOrWrap(weth, msg.sender, amount);
        emit ReferralRewardsPaidWETH(msg.sender, amount);

        emit ReferralClaimed(msg.sender, amount);
    }

    // ─── Admin ────────────────────────────────────────────────────────

    /// @notice AUDIT FIX M-17: Permanently disable the instant setApprovedCaller path.
    ///         After calling this, only the timelocked proposeApprovedCaller() flow works.
    ///         Call this once initial deployment setup (approving SwapFeeRouter etc.) is done.
    function completeSetup() external onlyOwner {
        if (setupComplete) revert SetupAlreadyComplete();
        setupComplete = true;
        emit SetupCompleted();
    }

    /// @notice Set or revoke an approved fee recorder (owner-only, for initial setup only)
    /// @dev AUDIT FIX M-17: Reverts after completeSetup() is called — use timelocked path instead.
    ///      AUDIT FIX M5: For post-deployment changes, use proposeApprovedCaller() with 24h timelock.
    function setApprovedCaller(address _caller, bool _approved) external onlyOwner {
        if (setupComplete) revert SetupAlreadyComplete();
        if (_caller == address(0)) revert ZeroAddress();
        approvedCallers[_caller] = _approved;
        emit ApprovedCallerSet(_caller, _approved);
    }

    /// @notice AUDIT FIX M5: Propose granting approved caller status (24h timelock)
    /// @dev M-07: Uses per-address timelock key to prevent collision between concurrent proposals.
    function proposeApprovedCaller(address _caller) external onlyOwner {
        if (_caller == address(0)) revert ZeroAddress();
        // Must not have another caller grant pending for this address
        require(!pendingCallerGrant[_caller], "CANCEL_EXISTING_FIRST");
        bytes32 key = keccak256(abi.encode("CALLER_GRANT", _caller));
        require(_executeAfter[key] == 0, "CANCEL_EXISTING_FIRST");
        pendingCallerGrant[_caller] = true;
        _propose(key, CALLER_GRANT_DELAY);
        emit CallerGrantProposed(_caller, _executeAfter[key]);
    }

    /// @notice Execute a pending caller grant after timelock
    function executeApprovedCaller(address _caller) external onlyOwner {
        require(pendingCallerGrant[_caller], "NO_PENDING_GRANT");
        bytes32 key = keccak256(abi.encode("CALLER_GRANT", _caller));
        _execute(key);
        pendingCallerGrant[_caller] = false;
        approvedCallers[_caller] = true;
        emit ApprovedCallerSet(_caller, true);
    }

    /// @notice Cancel a pending caller grant
    function cancelApprovedCallerGrant(address _caller) external onlyOwner {
        require(pendingCallerGrant[_caller], "NO_PENDING_GRANT");
        bytes32 key = keccak256(abi.encode("CALLER_GRANT", _caller));
        _cancel(key);
        pendingCallerGrant[_caller] = false;
        emit CallerGrantCancelled(_caller);
    }

    /// @notice Instantly revoke an approved caller (no timelock for safety)
    function revokeApprovedCaller(address _caller) external onlyOwner {
        if (_caller == address(0)) revert ZeroAddress();
        approvedCallers[_caller] = false;
        emit ApprovedCallerSet(_caller, false);
    }

    /// @notice DEPRECATED: Use proposeReferralFee + executeReferralFee
    function setReferralFee(uint256) external pure {
        revert("Use proposeReferralFee()");
    }

    function proposeReferralFee(uint256 _feeBps) external onlyOwner {
        if (_feeBps > MAX_REFERRAL_FEE) revert FeeTooHigh();
        // SECURITY FIX M-16: Disallow setting fee to 0 — would cause all ETH to be credited
        // back to caller, making the referral system a no-op while still requiring gas.
        require(_feeBps > 0, "FEE_CANNOT_BE_ZERO");
        pendingReferralFee = _feeBps;
        _propose(REFERRAL_FEE_CHANGE, FEE_CHANGE_DELAY);
        emit ReferralFeeProposed(referralFeeBps, _feeBps, _executeAfter[REFERRAL_FEE_CHANGE]);
    }

    function executeReferralFee() external onlyOwner {
        _execute(REFERRAL_FEE_CHANGE);
        uint256 old = referralFeeBps;
        referralFeeBps = pendingReferralFee;
        pendingReferralFee = 0;
        emit ReferralFeeUpdated(old, referralFeeBps);
    }

    /// @notice Cancel a pending referral fee proposal
    function cancelReferralFee() external onlyOwner {
        _cancel(REFERRAL_FEE_CHANGE);
        uint256 cancelled = pendingReferralFee;
        pendingReferralFee = 0;
        emit ReferralFeeCancelled(cancelled);
    }

    /// @notice DEPRECATED: Use proposeTreasury + executeTreasury
    function setTreasury(address) external pure {
        revert("Use proposeTreasury()");
    }

    function proposeTreasury(address _treasury) external onlyOwner {
        if (_treasury == address(0)) revert ZeroAddress();
        pendingTreasury = _treasury;
        _propose(TREASURY_CHANGE, TREASURY_CHANGE_DELAY);
        emit TreasuryChangeProposed(treasury, _treasury, _executeAfter[TREASURY_CHANGE]);
    }

    function executeTreasury() external onlyOwner {
        _execute(TREASURY_CHANGE);
        address old = treasury;
        treasury = pendingTreasury;
        pendingTreasury = address(0);
        emit TreasuryUpdated(old, treasury);
    }

    /// @notice Cancel a pending treasury change proposal
    function cancelTreasury() external onlyOwner {
        _cancel(TREASURY_CHANGE);
        address cancelled = pendingTreasury;
        pendingTreasury = address(0);
        emit TreasuryChangeCancelled(cancelled);
    }

    /// @notice Mark a referrer as below MIN_REFERRAL_STAKE_POWER, starting the grace period clock.
    ///         Anyone can call this. Resets if the referrer is actually above threshold.
    /// @param _referrer The referrer to mark
    function markBelowStake(address _referrer) external {
        // A4-C-01: Wrap in try/catch — if staking reverts, treat as below threshold
        uint256 power;
        try stakingContract.votingPowerOf(_referrer) returns (uint256 p) {
            power = p;
        } catch {
            power = 0;
        }
        if (power >= MIN_REFERRAL_STAKE_POWER) {
            // Referrer is above threshold — reset the timer
            lastBelowStakeTime[_referrer] = 0;
            return;
        }
        // Only set if not already marked
        if (lastBelowStakeTime[_referrer] == 0) {
            lastBelowStakeTime[_referrer] = block.timestamp;
            emit BelowStakeMarked(_referrer, block.timestamp);
        }
    }

    /// @notice Forfeit unclaimed rewards for a referrer who has been below stake threshold
    ///         for at least 7 days and hasn't claimed in 90 days. Sends their pending ETH to treasury.
    /// @param _referrer The referrer whose rewards should be forfeited
    /// @dev A3-M-01 FIX: Uses pull-pattern (accumulate to treasury ETH) instead of pushing
    ///      ETH directly to treasury, preventing permanent DoS if treasury reverts.
    function forfeitUnclaimedRewards(address _referrer) external onlyOwner nonReentrant {
        uint256 amount = pendingETH[_referrer];
        if (amount == 0) revert NothingToClaim();
        // Must be below min stake for at least grace period AND inactive for 90 days
        // A4-C-01: Wrap in try/catch — if staking reverts, treat as below threshold (allow forfeiture)
        uint256 referrerPower;
        try stakingContract.votingPowerOf(_referrer) returns (uint256 p) {
            referrerPower = p;
        } catch {
            referrerPower = 0;
        }
        if (
            referrerPower >= MIN_REFERRAL_STAKE_POWER ||
            lastBelowStakeTime[_referrer] == 0 ||
            block.timestamp < lastBelowStakeTime[_referrer] + BELOW_STAKE_GRACE_PERIOD ||
            block.timestamp < lastClaimTime[_referrer] + FORFEITURE_PERIOD
        ) revert ForfeitureConditionsNotMet();

        pendingETH[_referrer] = 0;
        totalPendingETH -= amount;

        // A3-M-01: Accumulate instead of push — withdraw via withdrawTreasuryFees()
        accumulatedTreasuryETH += amount;

        emit RewardsForfeited(_referrer, amount);
    }

    /// @notice AUDIT FIX M-05: Withdraw accumulated treasury-bound referral fees (pull-pattern).
    ///         These fees were accumulated from recordFee when referrers were unqualified.
    function withdrawTreasuryFees() external onlyOwner nonReentrant {
        uint256 amount = accumulatedTreasuryETH;
        if (amount == 0) revert NothingToClaim();
        accumulatedTreasuryETH = 0;

        // AUDIT FIX L-11: Use WETHFallbackLib directly — avoids redundant raw .call before WETH fallback
        WETHFallbackLib.safeTransferETHOrWrap(weth, treasury, amount);
        emit TreasuryFeesPaidWETH(treasury, amount);

        emit TreasuryETHWithdrawn(treasury, amount);
    }

    /// @notice Sweep excess ETH (non-referral portion from fees) to treasury.
    ///         Protects pending referral ETH, accumulated treasury fees, and caller credits.
    function sweepUnclaimable() external onlyOwner nonReentrant {
        uint256 balance = address(this).balance;
        // S2-H-01: Include totalCallerCredit in reserved to prevent sweeping caller funds
        uint256 reserved = totalPendingETH + accumulatedTreasuryETH + totalCallerCredit;
        uint256 sweepable = balance > reserved ? balance - reserved : 0;
        if (sweepable == 0) revert NothingToClaim();

        // AUDIT FIX L-11: Use WETHFallbackLib directly — avoids redundant raw .call before WETH fallback
        WETHFallbackLib.safeTransferETHOrWrap(weth, treasury, sweepable);
        emit UnclaimedSweptWETH(treasury, sweepable);

        emit UnclaimedSwept(treasury, sweepable);
    }

    // ─── View ─────────────────────────────────────────────────────────

    /// @notice Get referral statistics for a referrer
    /// @param _referrer The referrer address to query
    /// @return referred Total number of users referred
    /// @return earned Total ETH earned historically
    /// @return pending Current claimable ETH balance
    function getReferralInfo(address _referrer) external view returns (
        uint256 referred, uint256 earned, uint256 pending
    ) {
        return (totalReferred[_referrer], totalEarned[_referrer], pendingETH[_referrer]);
    }
}
