// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import {OwnableNoRenounce} from "./base/OwnableNoRenounce.sol";
import {TimelockAdmin} from "./base/TimelockAdmin.sol";
import {WETHFallbackLib} from "./lib/WETHFallbackLib.sol";

interface IUniswapV2Router02 {
    function swapExactETHForTokens(uint256 amountOutMin, address[] calldata path, address to, uint256 deadline)
        external payable returns (uint256[] memory amounts);
    function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline)
        external returns (uint256[] memory amounts);
    function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline)
        external returns (uint256[] memory amounts);
    function WETH() external pure returns (address);
}

interface IReferralSplitter {
    function recordFee(address _user) external payable;
    function withdrawCallerCredit() external;
}

interface IPremiumAccess {
    function hasPremiumSecure(address user) external view returns (bool);
}

/// @title SwapFeeRouter
/// @notice Wraps Uniswap V2 swaps with a protocol fee.
///         Users swap through this contract instead of directly on Uniswap.
///         A small fee (default 0.3%) is taken from the input before swapping.
///
///         Revenue: fees accumulate in this contract and can be withdrawn by owner.
///
/// Battle-tested sources:
///  - OwnableNoRenounce: OZ Ownable2Step (industry standard)
///  - TimelockAdmin: MakerDAO DSPause pattern (billions TVL, never compromised)
///  - WETHFallbackLib: Solmate SafeTransferLib + WETH fallback (Uniswap V3/V4, Seaport)
///  - Fee wrapper pattern: 1inch/Paraswap aggregator fee model
contract SwapFeeRouter is OwnableNoRenounce, ReentrancyGuard, Pausable, TimelockAdmin {
    using SafeERC20 for IERC20;

    // ─── Timelock Operation Keys ─────────────────────────────────────
    bytes32 public constant FEE_CHANGE = keccak256("FEE_CHANGE");
    bytes32 public constant TREASURY_CHANGE = keccak256("TREASURY_CHANGE");
    bytes32 public constant REFERRAL_CHANGE = keccak256("REFERRAL_CHANGE");
    bytes32 public constant PAIR_FEE_CHANGE = keccak256("PAIR_FEE_CHANGE");
    bytes32 public constant PREMIUM_DISCOUNT_CHANGE = keccak256("PREMIUM_DISCOUNT_CHANGE");
    bytes32 public constant PREMIUM_ACCESS_CHANGE = keccak256("PREMIUM_ACCESS_CHANGE");

    // ─── Immutables ──────────────────────────────────────────────────
    IUniswapV2Router02 public immutable router;
    address public immutable WETH;

    // ─── State ───────────────────────────────────────────────────────
    IReferralSplitter public referralSplitter;
    address public treasury;
    uint256 public feeBps; // Fee in basis points (30 = 0.3%)

    uint256 public constant MAX_FEE_BPS = 100; // Max 1%
    uint256 public constant BPS = 10000;
    uint256 public constant FEE_CHANGE_DELAY = 24 hours;
    uint256 public constant TREASURY_CHANGE_DELAY = 48 hours;
    uint256 public constant REFERRAL_CHANGE_DELAY = 48 hours;
    uint256 public constant PAIR_FEE_CHANGE_DELAY = 24 hours;
    uint256 public constant PREMIUM_DISCOUNT_CHANGE_DELAY = 24 hours;
    uint256 public constant PREMIUM_ACCESS_CHANGE_DELAY = 48 hours;
    uint256 public constant REV_DIST_CHANGE_DELAY = 48 hours;
    uint256 public constant MAX_DEADLINE = 30 minutes;
    uint256 public constant MAX_PREMIUM_DISCOUNT_BPS = 7500; // Max 75% discount

    uint256 public totalETHFees;
    mapping(address => uint256) public totalTokenFees;
    mapping(address => uint256) public accumulatedTokenFees;
    uint256 public accumulatedETHFees;

    // ─── Dynamic Fee Tiers (Uniswap V3-style per-pair overrides) ─────
    mapping(address => uint256) public pairFeeBps;
    mapping(address => bool) public hasPairFeeOverride;

    // ─── Premium Discount (Gold Card holders get reduced fees) ────────
    IPremiumAccess public premiumAccess;
    uint256 public premiumDiscountBps; // e.g. 5000 = 50% off fees

    // V2: Revenue pipeline — direct fee routing to RevenueDistributor
    address public revenueDistributor;
    bytes32 public constant REV_DIST_CHANGE = keccak256("REV_DIST_CHANGE");
    address public pendingRevenueDistributor;

    // ─── Pending Values (for timelocked changes) ─────────────────────
    uint256 public pendingFeeBps;
    address public pendingTreasury;
    address public pendingReferralSplitter;
    address public pendingPairFeeAddress;
    uint256 public pendingPairFeeBps;
    bool public pendingPairFeeRemoval;
    uint256 public pendingPremiumDiscountBps;
    address public pendingPremiumAccess;

    // ─── Events ──────────────────────────────────────────────────────
    event SwapExecuted(address indexed user, address tokenIn, address tokenOut, uint256 amountIn, uint256 fee);
    event FeeUpdated(uint256 oldFee, uint256 newFee);
    event FeeChangeProposed(uint256 currentFee, uint256 proposedFee, uint256 executeAfter);
    event FeeChangeCancelled(uint256 cancelledFee);
    event TreasuryUpdated(address oldTreasury, address newTreasury);
    event TreasuryChangeProposed(address indexed newTreasury, uint256 executeAfter);
    event TreasuryChangeCancelled(address cancelledTreasury);
    event FeesWithdrawn(address indexed to, uint256 amount);
    event ReferralFeeRedirectedToTreasury(address indexed user, uint256 amount);
    event ReferralSplitterUpdated(address indexed oldSplitter, address indexed newSplitter);
    event ReferralSplitterChangeProposed(address indexed newSplitter, uint256 executeAfter);
    event ReferralSplitterChangeCancelled(address indexed cancelled);
    event CallerCreditRecovered(address indexed splitter, uint256 amount);
    event PairFeeUpdated(address indexed pair, uint256 feeBps, bool removed);
    event PairFeeChangeProposed(address indexed pair, uint256 feeBps, bool removal, uint256 executeAfter);
    event PairFeeChangeCancelled(address indexed pair);
    event PremiumDiscountUpdated(uint256 oldDiscount, uint256 newDiscount);
    event PremiumDiscountChangeProposed(uint256 newDiscount, uint256 executeAfter);
    event PremiumDiscountChangeCancelled(uint256 cancelledDiscount);
    event PremiumAccessUpdated(address indexed oldAccess, address indexed newAccess);
    event PremiumAccessChangeProposed(address indexed newAccess, uint256 executeAfter);
    event PremiumAccessChangeCancelled(address indexed cancelledAccess);
    event FeesDistributed(address indexed distributor, uint256 amount);
    event RevenueDistributorUpdated(address indexed oldDistributor, address indexed newDistributor);
    event RevenueDistributorChangeProposed(address indexed newDistributor, uint256 executeAfter);
    event RevenueDistributorChangeCancelled(address indexed cancelledDistributor);

    // ─── Errors ──────────────────────────────────────────────────────
    error FeeTooHigh();
    error ZeroAddress();
    error ZeroAmount();
    error SlippageExceeded();
    error InvalidPath();
    error InvalidRecipient();
    error DeadlineTooFar();
    error FeeExceedsMax();
    error AdjustedMinOverflow();
    error PathStartMismatch();
    error PathEndMismatch();
    error InsufficientOutput();
    error DuplicateTokenInPath();

    // Legacy error aliases (kept for test compatibility during V2 migration)
    // Note: ProposalExpired() removed — use TimelockAdmin.ProposalExpired(bytes32) instead
    error NoPendingFeeChange();
    error FeeChangeNotReady();
    error UseProposeFeeChange();
    error NoPendingTreasuryChange();
    error TreasuryChangeNotReady();
    error UseProposeTreasuryChange();
    error NoPendingReferralChange();
    error ReferralChangeNotReady();

    // ─── Legacy View Helpers (for test compatibility) ──────────────
    function feeChangeTime() external view returns (uint256) { return _executeAfter[FEE_CHANGE]; }
    function treasuryChangeTime() external view returns (uint256) { return _executeAfter[TREASURY_CHANGE]; }
    function referralSplitterChangeTime() external view returns (uint256) { return _executeAfter[REFERRAL_CHANGE]; }
    function pairFeeChangeTime() external view returns (uint256) { return _executeAfter[PAIR_FEE_CHANGE]; }
    function premiumDiscountChangeTime() external view returns (uint256) { return _executeAfter[PREMIUM_DISCOUNT_CHANGE]; }
    function premiumAccessChangeTime() external view returns (uint256) { return _executeAfter[PREMIUM_ACCESS_CHANGE]; }
    function revenueDistributorChangeTime() external view returns (uint256) { return _executeAfter[REV_DIST_CHANGE]; }

    constructor(address _router, address _treasury, uint256 _feeBps, address _referralSplitter)
        OwnableNoRenounce(msg.sender)
    {
        if (_router == address(0) || _treasury == address(0)) revert ZeroAddress();
        if (_feeBps > MAX_FEE_BPS) revert FeeTooHigh();
        router = IUniswapV2Router02(_router);
        WETH = IUniswapV2Router02(_router).WETH();
        treasury = _treasury;
        feeBps = _feeBps;
        if (_referralSplitter != address(0)) {
            referralSplitter = IReferralSplitter(_referralSplitter);
        }
    }

    // ─── Internal Helpers ────────────────────────────────────────────

    /// @dev Forward fee ETH to referral splitter. Returns true if ETH was forwarded.
    function _recordReferralFee(address _user, uint256 _feeAmount) internal returns (bool) {
        if (address(referralSplitter) == address(0) || _feeAmount == 0) return false;
        try referralSplitter.recordFee{value: _feeAmount}(_user) {
            return true;
        } catch {
            emit ReferralFeeRedirectedToTreasury(_user, _feeAmount);
            return false;
        }
    }

    /// @dev Get the effective fee for a swap path and user, considering:
    ///      1. Per-pair fee override (if set for the first pair in path)
    ///      2. Premium discount (if user has Gold Card subscription)
    ///      Falls back to the global `feeBps` if no per-pair override exists.
    function _getEffectiveFeeBps(address pairOrToken, address user) internal view returns (uint256) {
        // Step 1: Determine base fee (per-pair override or global default)
        uint256 baseFee;
        if (hasPairFeeOverride[pairOrToken]) {
            baseFee = pairFeeBps[pairOrToken];
        } else {
            baseFee = feeBps;
        }

        // Step 2: Apply premium discount if user has active premium subscription
        if (baseFee > 0 && address(premiumAccess) != address(0)) {
            try premiumAccess.hasPremiumSecure(user) returns (bool isPremium) {
                if (isPremium && premiumDiscountBps > 0) {
                    uint256 discount = (baseFee * premiumDiscountBps) / BPS;
                    baseFee = baseFee > discount ? baseFee - discount : 0;
                }
            } catch {
                // If premiumAccess call fails, use base fee without discount
            }
        }

        return baseFee;
    }

    /// @notice View function for frontend: get effective fee for a pair/token and user.
    function getEffectiveFeeBps(address pairOrToken, address user) external view returns (uint256) {
        return _getEffectiveFeeBps(pairOrToken, user);
    }

    // ─── Swap Functions ──────────────────────────────────────────────

    /// @notice Swap ETH for tokens with protocol fee deducted from input ETH
    function swapExactETHForTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline,
        uint256 maxFeeBps
    ) external payable nonReentrant whenNotPaused returns (uint256[] memory amounts) {
        if (msg.value == 0) revert ZeroAmount();
        uint256 effectiveFee = _getEffectiveFeeBps(path[0], msg.sender);
        if (effectiveFee > maxFeeBps) revert FeeExceedsMax();
        if (deadline > block.timestamp + MAX_DEADLINE) revert DeadlineTooFar();
        if (path.length < 2 || path.length > 10) revert InvalidPath();
        if (path[0] != router.WETH()) revert PathStartMismatch();
        _validateNoDuplicates(path);
        if (to == address(0) || to == address(this)) revert InvalidRecipient();

        uint256 fee = (msg.value * effectiveFee) / BPS;
        if (fee == 0 && effectiveFee > 0) fee = 1;
        uint256 amountAfterFee = msg.value - fee;

        if (fee > 0) {
            totalETHFees += fee;
            if (!_recordReferralFee(msg.sender, fee)) {
                accumulatedETHFees += fee;
            }
        }

        amounts = router.swapExactETHForTokens{value: amountAfterFee}(amountOutMin, path, to, deadline);
        if (amounts[amounts.length - 1] < amountOutMin) revert InsufficientOutput();

        emit SwapExecuted(msg.sender, address(0), path[path.length - 1], msg.value, fee);
    }

    /// @notice Swap tokens for ETH with protocol fee deducted from output ETH
    function swapExactTokensForETH(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline,
        uint256 maxFeeBps
    ) external nonReentrant whenNotPaused returns (uint256[] memory amounts) {
        if (amountIn == 0) revert ZeroAmount();
        uint256 effectiveFee = _getEffectiveFeeBps(path[0], msg.sender);
        if (effectiveFee > maxFeeBps) revert FeeExceedsMax();
        if (deadline > block.timestamp + MAX_DEADLINE) revert DeadlineTooFar();
        if (path.length < 2 || path.length > 10) revert InvalidPath();
        if (path[path.length - 1] != router.WETH()) revert PathEndMismatch();
        _validateNoDuplicates(path);
        if (to == address(0) || to == address(this)) revert InvalidRecipient();

        uint256 balBefore = IERC20(path[0]).balanceOf(address(this));
        IERC20(path[0]).safeTransferFrom(msg.sender, address(this), amountIn);
        uint256 actualReceived = IERC20(path[0]).balanceOf(address(this)) - balBefore;
        IERC20(path[0]).forceApprove(address(router), actualReceived);

        uint256 adjustedMin;
        if (effectiveFee >= BPS) {
            revert AdjustedMinOverflow();
        } else if (amountOutMin <= type(uint256).max / BPS) {
            adjustedMin = (amountOutMin * BPS + BPS - effectiveFee - 1) / (BPS - effectiveFee);
        } else {
            // SECURITY FIX M-4: Revert instead of silently weakening slippage protection.
            // Previously fell through to unadjusted amountOutMin, defeating fee compensation.
            revert AdjustedMinOverflow();
        }

        uint256 ethBefore = address(this).balance;
        amounts = router.swapExactTokensForETH(actualReceived, adjustedMin, path, address(this), deadline);
        uint256 ethReceived = address(this).balance - ethBefore;

        IERC20(path[0]).forceApprove(address(router), 0);

        uint256 fee = (ethReceived * effectiveFee) / BPS;
        if (fee == 0 && effectiveFee > 0) fee = 1;
        uint256 userAmount = ethReceived - fee;

        if (userAmount < amountOutMin) revert SlippageExceeded();

        if (fee > 0) {
            totalETHFees += fee;
            if (!_recordReferralFee(msg.sender, fee)) {
                accumulatedETHFees += fee;
            }
        }

        // WETHFallbackLib: Safe ETH transfer with WETH fallback for contracts without receive()
        WETHFallbackLib.safeTransferETHOrWrap(WETH, to, userAmount);

        emit SwapExecuted(msg.sender, path[0], address(0), amountIn, fee);
    }

    /// @notice Swap tokens for tokens with protocol fee deducted from input tokens
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline,
        uint256 maxFeeBps
    ) external nonReentrant whenNotPaused returns (uint256[] memory amounts) {
        if (amountIn == 0) revert ZeroAmount();
        uint256 effectiveFee = _getEffectiveFeeBps(path[0], msg.sender);
        if (effectiveFee > maxFeeBps) revert FeeExceedsMax();
        if (deadline > block.timestamp + MAX_DEADLINE) revert DeadlineTooFar();
        if (path.length < 2 || path.length > 10) revert InvalidPath();
        _validateNoDuplicates(path);
        if (to == address(0) || to == address(this)) revert InvalidRecipient();

        uint256 balBefore = IERC20(path[0]).balanceOf(address(this));
        IERC20(path[0]).safeTransferFrom(msg.sender, address(this), amountIn);
        uint256 actualReceived = IERC20(path[0]).balanceOf(address(this)) - balBefore;

        uint256 fee = (actualReceived * effectiveFee) / BPS;
        if (fee == 0 && effectiveFee > 0) fee = 1;
        uint256 amountAfterFee = actualReceived - fee;

        if (fee > 0) {
            accumulatedTokenFees[path[0]] += fee;
            totalTokenFees[path[0]] += fee;
        }

        IERC20(path[0]).forceApprove(address(router), amountAfterFee);
        amounts = router.swapExactTokensForTokens(amountAfterFee, amountOutMin, path, to, deadline);

        IERC20(path[0]).forceApprove(address(router), 0);

        emit SwapExecuted(msg.sender, path[0], path[path.length - 1], amountIn, fee);
    }

    // ─── Deprecated Stubs (revert with helpful error) ─────────────
    function setFee(uint256) external pure { revert UseProposeFeeChange(); }
    function setTreasury(address) external pure { revert UseProposeTreasuryChange(); }

    // ─── Admin: Timelocked Changes (MakerDAO DSPause pattern) ────────

    /// @notice Propose a fee change (takes effect after 24h delay)
    function proposeFeeChange(uint256 newFee) external onlyOwner {
        if (newFee > MAX_FEE_BPS) revert FeeTooHigh();
        pendingFeeBps = newFee;
        _propose(FEE_CHANGE, FEE_CHANGE_DELAY);
        emit FeeChangeProposed(feeBps, newFee, _executeAfter[FEE_CHANGE]);
    }

    /// @notice Execute a previously proposed fee change after the timelock
    function executeFeeChange() external onlyOwner {
        _execute(FEE_CHANGE);
        uint256 old = feeBps;
        feeBps = pendingFeeBps;
        pendingFeeBps = 0;
        emit FeeUpdated(old, feeBps);
    }

    /// @notice Cancel a pending fee change proposal
    function cancelFeeChange() external onlyOwner {
        _cancel(FEE_CHANGE);
        uint256 cancelled = pendingFeeBps;
        pendingFeeBps = 0;
        emit FeeChangeCancelled(cancelled);
    }

    /// @notice Propose a treasury change (takes effect after 48h delay)
    function proposeTreasuryChange(address _newTreasury) external onlyOwner {
        if (_newTreasury == address(0)) revert ZeroAddress();
        pendingTreasury = _newTreasury;
        _propose(TREASURY_CHANGE, TREASURY_CHANGE_DELAY);
        emit TreasuryChangeProposed(_newTreasury, _executeAfter[TREASURY_CHANGE]);
    }

    /// @notice Execute a previously proposed treasury change after the timelock
    function executeTreasuryChange() external onlyOwner {
        _execute(TREASURY_CHANGE);
        address old = treasury;
        treasury = pendingTreasury;
        pendingTreasury = address(0);
        emit TreasuryUpdated(old, treasury);
    }

    /// @notice Cancel a pending treasury change proposal
    function cancelTreasuryChange() external onlyOwner {
        _cancel(TREASURY_CHANGE);
        address cancelled = pendingTreasury;
        pendingTreasury = address(0);
        emit TreasuryChangeCancelled(cancelled);
    }

    /// @notice Propose a referral splitter change (48h timelock)
    function proposeReferralSplitterChange(address _newSplitter) external onlyOwner {
        pendingReferralSplitter = _newSplitter; // address(0) allowed to disable
        _propose(REFERRAL_CHANGE, REFERRAL_CHANGE_DELAY);
        emit ReferralSplitterChangeProposed(_newSplitter, _executeAfter[REFERRAL_CHANGE]);
    }

    /// @notice Execute a previously proposed referral splitter change
    function executeReferralSplitterChange() external onlyOwner {
        _execute(REFERRAL_CHANGE);
        address old = address(referralSplitter);
        referralSplitter = IReferralSplitter(pendingReferralSplitter);
        pendingReferralSplitter = address(0);
        emit ReferralSplitterUpdated(old, address(referralSplitter));
    }

    /// @notice Cancel a pending referral splitter change
    function cancelReferralSplitterChange() external onlyOwner {
        _cancel(REFERRAL_CHANGE);
        address cancelled = pendingReferralSplitter;
        pendingReferralSplitter = address(0);
        emit ReferralSplitterChangeCancelled(cancelled);
    }

    // ─── Admin: Timelocked Pair Fee Override (24h) ────────────────────

    /// @notice Propose a per-pair fee override (or removal). Takes effect after 24h.
    /// @param pair The pair/token address to set a custom fee for
    /// @param newFeeBps The fee in basis points (ignored if removal is true)
    /// @param removal If true, removes the pair fee override (reverts to global default)
    function proposePairFeeChange(address pair, uint256 newFeeBps, bool removal) external onlyOwner {
        if (pair == address(0)) revert ZeroAddress();
        if (!removal && newFeeBps > MAX_FEE_BPS) revert FeeTooHigh();
        pendingPairFeeAddress = pair;
        pendingPairFeeBps = newFeeBps;
        pendingPairFeeRemoval = removal;
        _propose(PAIR_FEE_CHANGE, PAIR_FEE_CHANGE_DELAY);
        emit PairFeeChangeProposed(pair, newFeeBps, removal, _executeAfter[PAIR_FEE_CHANGE]);
    }

    function executePairFeeChange() external onlyOwner {
        _execute(PAIR_FEE_CHANGE);
        address pair = pendingPairFeeAddress;
        if (pendingPairFeeRemoval) {
            delete pairFeeBps[pair];
            delete hasPairFeeOverride[pair];
            emit PairFeeUpdated(pair, 0, true);
        } else {
            pairFeeBps[pair] = pendingPairFeeBps;
            hasPairFeeOverride[pair] = true;
            emit PairFeeUpdated(pair, pendingPairFeeBps, false);
        }
        pendingPairFeeAddress = address(0);
        pendingPairFeeBps = 0;
        pendingPairFeeRemoval = false;
    }

    function cancelPairFeeChange() external onlyOwner {
        _cancel(PAIR_FEE_CHANGE);
        address cancelled = pendingPairFeeAddress;
        pendingPairFeeAddress = address(0);
        pendingPairFeeBps = 0;
        pendingPairFeeRemoval = false;
        emit PairFeeChangeCancelled(cancelled);
    }

    // ─── Admin: Timelocked Premium Discount (24h) ────────────────────

    function proposePremiumDiscountChange(uint256 newDiscountBps) external onlyOwner {
        require(newDiscountBps <= MAX_PREMIUM_DISCOUNT_BPS, "DISCOUNT_TOO_HIGH");
        pendingPremiumDiscountBps = newDiscountBps;
        _propose(PREMIUM_DISCOUNT_CHANGE, PREMIUM_DISCOUNT_CHANGE_DELAY);
        emit PremiumDiscountChangeProposed(newDiscountBps, _executeAfter[PREMIUM_DISCOUNT_CHANGE]);
    }

    function executePremiumDiscountChange() external onlyOwner {
        _execute(PREMIUM_DISCOUNT_CHANGE);
        uint256 old = premiumDiscountBps;
        premiumDiscountBps = pendingPremiumDiscountBps;
        pendingPremiumDiscountBps = 0;
        emit PremiumDiscountUpdated(old, premiumDiscountBps);
    }

    function cancelPremiumDiscountChange() external onlyOwner {
        _cancel(PREMIUM_DISCOUNT_CHANGE);
        uint256 cancelled = pendingPremiumDiscountBps;
        pendingPremiumDiscountBps = 0;
        emit PremiumDiscountChangeCancelled(cancelled);
    }

    // ─── Admin: Timelocked Premium Access Change (48h) ───────────────

    function proposePremiumAccessChange(address _newAccess) external onlyOwner {
        // address(0) allowed to disable premium discount
        pendingPremiumAccess = _newAccess;
        _propose(PREMIUM_ACCESS_CHANGE, PREMIUM_ACCESS_CHANGE_DELAY);
        emit PremiumAccessChangeProposed(_newAccess, _executeAfter[PREMIUM_ACCESS_CHANGE]);
    }

    function executePremiumAccessChange() external onlyOwner {
        _execute(PREMIUM_ACCESS_CHANGE);
        address old = address(premiumAccess);
        premiumAccess = IPremiumAccess(pendingPremiumAccess);
        pendingPremiumAccess = address(0);
        emit PremiumAccessUpdated(old, address(premiumAccess));
    }

    function cancelPremiumAccessChange() external onlyOwner {
        _cancel(PREMIUM_ACCESS_CHANGE);
        address cancelled = pendingPremiumAccess;
        pendingPremiumAccess = address(0);
        emit PremiumAccessChangeCancelled(cancelled);
    }

    // ─── V2: Revenue Pipeline (Permissionless Fee Distribution) ─────

    /// @notice Permissionless: anyone can trigger fee distribution to RevenueDistributor.
    ///         Pattern: Curve FeeDistributor — keeper/bot/user pushes accumulated fees forward.
    ///         Sends all accumulatedETHFees to the configured revenueDistributor address.
    function distributeFeesToStakers() external nonReentrant {
        if (revenueDistributor == address(0)) revert ZeroAddress();
        uint256 amount = accumulatedETHFees;
        if (amount == 0) revert ZeroAmount();
        accumulatedETHFees = 0;
        (bool ok,) = revenueDistributor.call{value: amount}("");
        require(ok, "TRANSFER_FAILED");
        emit FeesDistributed(revenueDistributor, amount);
    }

    // ─── Admin: Timelocked Revenue Distributor Change (48h) ──────────

    /// @notice Propose a revenue distributor change (48h timelock, MakerDAO DSPause pattern)
    function proposeRevenueDistributor(address _newDistributor) external onlyOwner {
        if (_newDistributor == address(0)) revert ZeroAddress();
        pendingRevenueDistributor = _newDistributor;
        _propose(REV_DIST_CHANGE, REV_DIST_CHANGE_DELAY);
        emit RevenueDistributorChangeProposed(_newDistributor, _executeAfter[REV_DIST_CHANGE]);
    }

    /// @notice Execute a previously proposed revenue distributor change after the timelock
    function executeRevenueDistributor() external onlyOwner {
        _execute(REV_DIST_CHANGE);
        address old = revenueDistributor;
        revenueDistributor = pendingRevenueDistributor;
        pendingRevenueDistributor = address(0);
        emit RevenueDistributorUpdated(old, revenueDistributor);
    }

    /// @notice Cancel a pending revenue distributor change
    function cancelRevenueDistributor() external onlyOwner {
        _cancel(REV_DIST_CHANGE);
        address cancelled = pendingRevenueDistributor;
        pendingRevenueDistributor = address(0);
        emit RevenueDistributorChangeCancelled(cancelled);
    }

    // ─── Admin: Pause ────────────────────────────────────────────────

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    // ─── Admin: Fee Withdrawal ───────────────────────────────────────

    /// @notice Pull-pattern fee withdrawal to treasury
    /// SECURITY FIX H6: Use WETHFallbackLib to prevent ETH getting permanently stuck
    /// if treasury is a contract that can't receive ETH (same pattern used in swapExactTokensForETH)
    function withdrawFees() external onlyOwner nonReentrant {
        uint256 amount = accumulatedETHFees;
        if (amount == 0) revert ZeroAmount();
        accumulatedETHFees = 0;
        WETHFallbackLib.safeTransferETHOrWrap(WETH, treasury, amount);
        emit FeesWithdrawn(treasury, amount);
    }

    /// @notice Sweep any stuck ETH to treasury (non-fee dust)
    /// SECURITY FIX H6: Use WETHFallbackLib for same reason
    function sweepETH() external onlyOwner nonReentrant {
        uint256 balance = address(this).balance;
        if (balance == 0) revert ZeroAmount();
        uint256 sweepable = balance > accumulatedETHFees ? balance - accumulatedETHFees : 0;
        if (sweepable == 0) revert ZeroAmount();
        WETHFallbackLib.safeTransferETHOrWrap(WETH, treasury, sweepable);
        emit FeesWithdrawn(treasury, sweepable);
    }

    /// @notice Withdraw accumulated token fees to treasury (pull-pattern)
    ///         AUDIT FIX M-04: Zero out accounting before transfer to prevent phantom balance
    ///         with fee-on-transfer tokens. Previous approach left permanent non-zero dust
    ///         in accumulatedTokenFees when transfer fee caused actualTransferred < amount.
    function withdrawTokenFees(address token) external onlyOwner nonReentrant {
        if (token == address(0)) revert ZeroAddress();
        uint256 amount = accumulatedTokenFees[token];
        if (amount == 0) revert ZeroAmount();
        // AUDIT FIX M-04: Zero before transfer (CEI pattern). If token has transfer fee,
        // treasury receives less, but accounting is clean — no phantom dust remains.
        accumulatedTokenFees[token] = 0;
        IERC20(token).safeTransfer(treasury, amount);
        emit FeesWithdrawn(treasury, amount);
    }

    /// @notice Sweep any stuck ERC20 tokens to treasury (non-fee dust)
    function sweepTokens(address token) external onlyOwner nonReentrant {
        if (token == address(0)) revert ZeroAddress();
        uint256 balance = IERC20(token).balanceOf(address(this));
        uint256 reserved = accumulatedTokenFees[token];
        uint256 sweepable = balance > reserved ? balance - reserved : 0;
        if (sweepable == 0) revert ZeroAmount();
        IERC20(token).safeTransfer(treasury, sweepable);
    }

    /// @notice Recover stranded callerCredit ETH from the current ReferralSplitter
    function recoverCallerCredit() external onlyOwner nonReentrant {
        require(address(referralSplitter) != address(0), "NO_SPLITTER");
        uint256 balBefore = address(this).balance;
        referralSplitter.withdrawCallerCredit();
        uint256 recovered = address(this).balance - balBefore;
        emit CallerCreditRecovered(address(referralSplitter), recovered);
    }

    /// @notice Recover stranded callerCredit ETH from an old ReferralSplitter
    function recoverCallerCreditFrom(address oldSplitter) external onlyOwner nonReentrant {
        if (oldSplitter == address(0)) revert ZeroAddress();
        uint256 balBefore = address(this).balance;
        IReferralSplitter(oldSplitter).withdrawCallerCredit();
        uint256 recovered = address(this).balance - balBefore;
        emit CallerCreditRecovered(oldSplitter, recovered);
    }

    // ─── Internal ────────────────────────────────────────────────────

    /// @dev Validate that a swap path contains no duplicate tokens (cycles)
    function _validateNoDuplicates(address[] calldata path) internal pure {
        for (uint256 i = 0; i < path.length; i++) {
            for (uint256 j = i + 1; j < path.length; j++) {
                if (path[i] == path[j]) revert DuplicateTokenInPath();
            }
        }
    }

    receive() external payable {}
}
