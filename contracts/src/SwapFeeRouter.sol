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
    // AUDIT M-6: Fee-on-transfer variants. Mirrors Uniswap V2 Router02 signatures exactly.
    // These return no amounts array — the canonical Uniswap impl relies on balance deltas
    // measured by the caller. We do the same in the wrapper below.
    function swapExactETHForTokensSupportingFeeOnTransferTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable;
    function swapExactTokensForETHSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external;
    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external;
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
    // AUDIT L-1: raised from 30 minutes to 2 hours. 30m bricks swaps during normal
    // Ethereum congestion (post-merge average 12s blocks, but fees can spike base-fee
    // beyond the user's maxPriorityFee for far longer than 30m on busy days).
    // 2h is a standard Uniswap UI default and still defends against very stale intents.
    uint256 public constant MAX_DEADLINE = 2 hours;
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

    // ─── V3: Three-way fee split (stakers / treasury / POL) ──────────
    /// @notice BPS of each distribution that flows to RevenueDistributor → stakers.
    ///         Remainder = (BPS - stakerShareBps - polShareBps) goes to treasury.
    ///         Initialised to 10000 (100% stakers) to preserve existing behaviour on
    ///         upgrade. Owner must propose a split change via timelock to start
    ///         funding treasury / POL.
    uint256 public stakerShareBps = 10_000;
    /// @notice BPS of each distribution that flows to polAccumulator for permanent
    ///         protocol-owned liquidity. Default 0. Combined with stakerShareBps
    ///         must total <= 10000.
    uint256 public polShareBps = 0;
    /// @notice Destination for the POL slice. Can be the POLAccumulator contract.
    address public polAccumulator;

    bytes32 public constant FEE_SPLIT_CHANGE = keccak256("FEE_SPLIT_CHANGE");
    bytes32 public constant POL_ACCUMULATOR_CHANGE = keccak256("POL_ACCUMULATOR_CHANGE");
    uint256 public constant FEE_SPLIT_CHANGE_DELAY = 48 hours;
    uint256 public constant POL_ACCUMULATOR_CHANGE_DELAY = 48 hours;
    /// @notice Guardrails: stakers get no less than 50% and POL no more than 25%.
    ///         Protects the "stakers earn fees" marketing story through any future
    ///         governance mis-step.
    uint256 public constant MIN_STAKER_SHARE_BPS = 5_000;
    uint256 public constant MAX_POL_SHARE_BPS = 2_500;

    uint256 public pendingStakerShareBps;
    uint256 public pendingPolShareBps;
    address public pendingPolAccumulator;

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
    event FeeSplitUpdated(uint256 stakerShareBps, uint256 polShareBps, uint256 treasuryShareBps);
    event FeeSplitChangeProposed(uint256 stakerShareBps, uint256 polShareBps, uint256 executeAfter);
    event FeeSplitChangeCancelled();
    event PolAccumulatorUpdated(address indexed oldAccumulator, address indexed newAccumulator);
    event PolAccumulatorChangeProposed(address indexed newAccumulator, uint256 executeAfter);
    event PolAccumulatorChangeCancelled(address indexed cancelled);
    event FeesDistributedSplit(uint256 stakerAmount, uint256 treasuryAmount, uint256 polAmount);

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
    error SplitInvalid();
    error StakerShareTooLow();
    error PolShareTooHigh();

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

        // Step 2: Apply premium discount if user has active premium subscription.
        // AUDIT M-2: this is a deliberate fail-open — if premiumAccess reverts (paused,
        // broken, upgraded mid-swap) the swap MUST still complete rather than brick the
        // DEX. Off-chain monitoring should poll isPremiumAccessHealthy() below so a
        // silent premium outage raises an alert even though we can't emit from here
        // (this function is view — events aren't allowed).
        if (baseFee > 0 && address(premiumAccess) != address(0)) {
            try premiumAccess.hasPremiumSecure(user) returns (bool isPremium) {
                if (isPremium && premiumDiscountBps > 0) {
                    uint256 discount = (baseFee * premiumDiscountBps) / BPS;
                    baseFee = baseFee > discount ? baseFee - discount : 0;
                }
            } catch {
                // Fail-open: user pays base fee without the discount. No revert.
            }
        }

        return baseFee;
    }

    /// @notice AUDIT M-2: off-chain health probe for the premiumAccess integration.
    /// @return healthy true if premiumAccess is unset (discount feature disabled) OR
    ///         the call to hasPremiumSecure completed without reverting. false signals a
    ///         silent outage — premium users are currently paying full fees.
    function isPremiumAccessHealthy() external view returns (bool healthy) {
        if (address(premiumAccess) == address(0)) return true;
        try premiumAccess.hasPremiumSecure(address(0)) returns (bool) {
            return true;
        } catch {
            return false;
        }
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

    // ─── Fee-on-Transfer Swap Variants (AUDIT M-6) ────────────────────
    //
    // These mirror Uniswap V2 Router02's *SupportingFeeOnTransferTokens helpers so users can
    // trade tokens with internal transfer fees (rebase / reflection / deflationary tokens).
    //
    // Pattern: pull input -> measure balance delta -> approve router -> have the router send
    // output back to THIS contract -> measure output delta -> take protocol fee from the
    // output side -> forward net to `to`.
    //
    // Why output-side fee on the FoT variants:
    //   With FoT input tokens, a fee on the input side gets hit twice by the FoT transfer
    //   (once when the user transfers in, again when we transfer to the router) which is both
    //   lossy and hard to account for. Taking the fee from the output delta is cleaner and
    //   avoids the critique 5.8 double-accounting concern. NOTE: this is an intentional
    //   asymmetry with the legacy non-FoT variants above, which keep their existing input-side
    //   (for token->token) or output-side (for token->ETH) fee treatment. Do NOT unify without
    //   a dedicated migration — that would change fee accounting mid-flight for all users.

    /// @notice ETH -> FoT token swap with protocol fee deducted from output tokens.
    /// @dev    Calls router.swapExactETHForTokensSupportingFeeOnTransferTokens with amountOutMin=0
    ///         internally; our own slippage check compares (received - fee) >= amountOutMin.
    function swapExactETHForTokensSupportingFeeOnTransferTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline,
        uint256 maxFeeBps
    ) external payable nonReentrant whenNotPaused {
        if (msg.value == 0) revert ZeroAmount();
        uint256 effectiveFee = _getEffectiveFeeBps(path[0], msg.sender);
        if (effectiveFee > maxFeeBps) revert FeeExceedsMax();
        if (deadline > block.timestamp + MAX_DEADLINE) revert DeadlineTooFar();
        if (path.length < 2 || path.length > 10) revert InvalidPath();
        if (path[0] != router.WETH()) revert PathStartMismatch();
        _validateNoDuplicates(path);
        if (to == address(0) || to == address(this)) revert InvalidRecipient();

        address outToken = path[path.length - 1];

        // Route output to THIS contract so we can measure the actual received amount
        // after the FoT token's internal transfer hook and take the protocol fee from it.
        uint256 balBefore = IERC20(outToken).balanceOf(address(this));
        router.swapExactETHForTokensSupportingFeeOnTransferTokens{value: msg.value}(
            0, path, address(this), deadline
        );
        uint256 received = IERC20(outToken).balanceOf(address(this)) - balBefore;

        uint256 fee = (received * effectiveFee) / BPS;
        if (fee == 0 && effectiveFee > 0) fee = 1;
        uint256 userAmount = received - fee;

        // Slippage check on the post-fee user amount (Uniswap's internal check was disabled
        // by passing 0 above; we do the real check here with full knowledge of fee + FoT haircut).
        if (userAmount < amountOutMin) revert SlippageExceeded();

        if (fee > 0) {
            // AUDIT M-6: book the fee on the OUTPUT token — that's what accumulated in this
            // contract. Using path[0] (WETH) here would misaccount against WETH balances the
            // contract never received, which was critique 5.8's concern.
            accumulatedTokenFees[outToken] += fee;
            totalTokenFees[outToken] += fee;
        }

        // Forward the user's share. Uses safeTransfer — outToken may apply its own
        // FoT haircut again here; the user receives the post-haircut amount which is
        // the expected behaviour for FoT tokens. (Uniswap's own Router02 has the same
        // observable behaviour.)
        IERC20(outToken).safeTransfer(to, userAmount);

        emit SwapExecuted(msg.sender, address(0), outToken, msg.value, fee);
    }

    /// @notice FoT token -> ETH swap with protocol fee deducted from output ETH.
    /// @dev    Pulls input, measures the actual-received delta (so FoT input is handled
    ///         correctly), has the router send unwrapped ETH back to us, takes fee in ETH,
    ///         forwards the remainder via WETHFallbackLib.
    function swapExactTokensForETHSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline,
        uint256 maxFeeBps
    ) external nonReentrant whenNotPaused {
        if (amountIn == 0) revert ZeroAmount();
        uint256 effectiveFee = _getEffectiveFeeBps(path[0], msg.sender);
        if (effectiveFee > maxFeeBps) revert FeeExceedsMax();
        if (deadline > block.timestamp + MAX_DEADLINE) revert DeadlineTooFar();
        if (path.length < 2 || path.length > 10) revert InvalidPath();
        if (path[path.length - 1] != router.WETH()) revert PathEndMismatch();
        _validateNoDuplicates(path);
        if (to == address(0) || to == address(this)) revert InvalidRecipient();

        // Pull input, measure balance delta to handle FoT input tokens correctly.
        uint256 tokenBalBefore = IERC20(path[0]).balanceOf(address(this));
        IERC20(path[0]).safeTransferFrom(msg.sender, address(this), amountIn);
        uint256 actualReceived = IERC20(path[0]).balanceOf(address(this)) - tokenBalBefore;
        IERC20(path[0]).forceApprove(address(router), actualReceived);

        uint256 ethBefore = address(this).balance;
        router.swapExactTokensForETHSupportingFeeOnTransferTokens(
            actualReceived, 0, path, address(this), deadline
        );
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

        // Safe ETH transfer with WETH fallback for contract recipients.
        WETHFallbackLib.safeTransferETHOrWrap(WETH, to, userAmount);

        emit SwapExecuted(msg.sender, path[0], address(0), amountIn, fee);
    }

    /// @notice FoT token -> FoT token (or any token) swap with protocol fee deducted from output.
    /// @dev    Routes output to this contract so we can meter the received delta, take fee,
    ///         then forward remainder to `to`.
    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline,
        uint256 maxFeeBps
    ) external nonReentrant whenNotPaused {
        if (amountIn == 0) revert ZeroAmount();
        uint256 effectiveFee = _getEffectiveFeeBps(path[0], msg.sender);
        if (effectiveFee > maxFeeBps) revert FeeExceedsMax();
        if (deadline > block.timestamp + MAX_DEADLINE) revert DeadlineTooFar();
        if (path.length < 2 || path.length > 10) revert InvalidPath();
        _validateNoDuplicates(path);
        if (to == address(0) || to == address(this)) revert InvalidRecipient();

        address outToken = path[path.length - 1];

        // Pull input, measure delta (handles FoT on the input side).
        uint256 inBalBefore = IERC20(path[0]).balanceOf(address(this));
        IERC20(path[0]).safeTransferFrom(msg.sender, address(this), amountIn);
        uint256 actualReceived = IERC20(path[0]).balanceOf(address(this)) - inBalBefore;
        IERC20(path[0]).forceApprove(address(router), actualReceived);

        // Route output to this contract so we can measure the delta after any FoT
        // hooks fire along the swap path.
        uint256 outBalBefore = IERC20(outToken).balanceOf(address(this));
        router.swapExactTokensForTokensSupportingFeeOnTransferTokens(
            actualReceived, 0, path, address(this), deadline
        );
        uint256 received = IERC20(outToken).balanceOf(address(this)) - outBalBefore;

        IERC20(path[0]).forceApprove(address(router), 0);

        uint256 fee = (received * effectiveFee) / BPS;
        if (fee == 0 && effectiveFee > 0) fee = 1;
        uint256 userAmount = received - fee;

        if (userAmount < amountOutMin) revert SlippageExceeded();

        if (fee > 0) {
            accumulatedTokenFees[outToken] += fee;
            totalTokenFees[outToken] += fee;
        }

        IERC20(outToken).safeTransfer(to, userAmount);

        emit SwapExecuted(msg.sender, path[0], outToken, amountIn, fee);
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

    /// @notice Permissionless: anyone can trigger fee distribution.
    ///         Pattern: Curve FeeDistributor — keeper/bot/user pushes accumulated fees forward.
    ///         Splits accumulatedETHFees across stakers (revenueDistributor), POL
    ///         (polAccumulator), and treasury based on the timelocked fee-split BPS.
    ///
    ///         Invariants enforced at propose-time:
    ///           stakerShareBps >= MIN_STAKER_SHARE_BPS (50%)
    ///           polShareBps    <= MAX_POL_SHARE_BPS    (25%)
    ///           staker + pol   <= BPS (treasury gets the remainder)
    ///
    ///         Backward compatibility: on upgrade, stakerShareBps defaults to 10000
    ///         which means pol/treasury slices are zero and behaviour is identical
    ///         to V2 (100% to stakers). Owner must propose a split change explicitly.
    function distributeFeesToStakers() external nonReentrant {
        if (revenueDistributor == address(0)) revert ZeroAddress();
        uint256 amount = accumulatedETHFees;
        if (amount == 0) revert ZeroAmount();
        accumulatedETHFees = 0;

        // Compute slices. Treasury is the remainder so the three slices always sum
        // to exactly `amount` — no dust can be lost or double-spent.
        uint256 stakerAmount = (amount * stakerShareBps) / BPS;
        uint256 polAmount = (amount * polShareBps) / BPS;
        uint256 treasuryAmount = amount - stakerAmount - polAmount;

        // AUDIT FIX M-4 (battle-tested): bound the gas forwarded to protocol-internal
        // destinations at 50_000. Unlimited `.call{}` gas widened the cross-contract
        // reentrancy surface for no benefit — both RevenueDistributor.receive() and
        // POLAccumulator.receive() are minimal (event emission) and fit comfortably under
        // 50k. Full WETHFallbackLib would switch to a 10k ETH stipend + WETH wrap, but a
        // WETH wrap on RevenueDistributor would strand the slice (distribute() reads
        // address(this).balance), so the middle-ground 50k stipend is the correct choice.
        if (stakerAmount > 0) {
            (bool okStaker,) = revenueDistributor.call{value: stakerAmount, gas: 50_000}("");
            require(okStaker, "STAKER_TRANSFER_FAILED");
        }

        // POL path: only run if we have a configured accumulator AND a non-zero slice.
        // If polShareBps > 0 but polAccumulator is unset, we fold the POL slice into
        // treasury rather than revert, so governance can't brick distribution by
        // forgetting to set the address.
        if (polAmount > 0) {
            if (polAccumulator != address(0)) {
                (bool okPol,) = polAccumulator.call{value: polAmount, gas: 50_000}("");
                require(okPol, "POL_TRANSFER_FAILED");
            } else {
                treasuryAmount += polAmount;
                polAmount = 0;
            }
        }

        // Treasury path: WETH fallback in case treasury is a contract that reverts on
        // plain ETH receive (consistent with other treasury flows in this contract).
        if (treasuryAmount > 0) {
            WETHFallbackLib.safeTransferETHOrWrap(WETH, treasury, treasuryAmount);
        }

        emit FeesDistributed(revenueDistributor, stakerAmount);
        emit FeesDistributedSplit(stakerAmount, treasuryAmount, polAmount);
    }

    // ─── V3: Fee-split governance (timelocked 48h) ────────────────────

    /// @notice Propose new staker/POL split. Treasury share is implicit (remainder).
    /// @dev    Both bounds checked here so a malformed proposal never enters the queue.
    function proposeFeeSplit(uint256 _stakerShareBps, uint256 _polShareBps) external onlyOwner {
        if (_stakerShareBps < MIN_STAKER_SHARE_BPS) revert StakerShareTooLow();
        if (_polShareBps > MAX_POL_SHARE_BPS) revert PolShareTooHigh();
        if (_stakerShareBps + _polShareBps > BPS) revert SplitInvalid();
        pendingStakerShareBps = _stakerShareBps;
        pendingPolShareBps = _polShareBps;
        _propose(FEE_SPLIT_CHANGE, FEE_SPLIT_CHANGE_DELAY);
        emit FeeSplitChangeProposed(_stakerShareBps, _polShareBps, _executeAfter[FEE_SPLIT_CHANGE]);
    }

    function executeFeeSplit() external onlyOwner {
        _execute(FEE_SPLIT_CHANGE);
        stakerShareBps = pendingStakerShareBps;
        polShareBps = pendingPolShareBps;
        pendingStakerShareBps = 0;
        pendingPolShareBps = 0;
        emit FeeSplitUpdated(stakerShareBps, polShareBps, BPS - stakerShareBps - polShareBps);
    }

    function cancelFeeSplit() external onlyOwner {
        _cancel(FEE_SPLIT_CHANGE);
        pendingStakerShareBps = 0;
        pendingPolShareBps = 0;
        emit FeeSplitChangeCancelled();
    }

    function feeSplitChangeTime() external view returns (uint256) { return _executeAfter[FEE_SPLIT_CHANGE]; }

    // ─── V3: POL accumulator governance (timelocked 48h) ──────────────

    function proposePolAccumulator(address _newAccumulator) external onlyOwner {
        // Zero address is allowed — that's how you disable the POL slice without
        // changing the BPS. When address is zero, POL share re-routes to treasury
        // in distributeFeesToStakers.
        pendingPolAccumulator = _newAccumulator;
        _propose(POL_ACCUMULATOR_CHANGE, POL_ACCUMULATOR_CHANGE_DELAY);
        emit PolAccumulatorChangeProposed(_newAccumulator, _executeAfter[POL_ACCUMULATOR_CHANGE]);
    }

    function executePolAccumulator() external onlyOwner {
        _execute(POL_ACCUMULATOR_CHANGE);
        address old = polAccumulator;
        polAccumulator = pendingPolAccumulator;
        pendingPolAccumulator = address(0);
        emit PolAccumulatorUpdated(old, polAccumulator);
    }

    function cancelPolAccumulator() external onlyOwner {
        _cancel(POL_ACCUMULATOR_CHANGE);
        address cancelled = pendingPolAccumulator;
        pendingPolAccumulator = address(0);
        emit PolAccumulatorChangeCancelled(cancelled);
    }

    function polAccumulatorChangeTime() external view returns (uint256) { return _executeAfter[POL_ACCUMULATOR_CHANGE]; }

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

    // AUDIT H-3 (battle-tested fix): withdrawFees() removed. Previously it bypassed the
    // MIN_STAKER_SHARE_BPS guardrail (enforced only at propose-time), allowing the owner to
    // redirect 100% of accumulated fees to treasury regardless of the governance-set split.
    // All fee outflow now routes through distributeFeesToStakers(), which applies the
    // timelocked staker/POL/treasury split atomically.

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
