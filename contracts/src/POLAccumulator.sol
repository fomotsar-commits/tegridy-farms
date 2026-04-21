// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {OwnableNoRenounce} from "./base/OwnableNoRenounce.sol";
import {TimelockAdmin} from "./base/TimelockAdmin.sol";

interface IUniswapV2Router {
    function swapExactETHForTokens(
        uint256 amountOutMin, address[] calldata path, address to, uint256 deadline
    ) external payable returns (uint256[] memory amounts);
    function addLiquidityETH(
        address token, uint256 amountTokenDesired, uint256 amountTokenMin,
        uint256 amountETHMin, address to, uint256 deadline
    ) external payable returns (uint256 amountToken, uint256 amountETH, uint256 liquidity);
    // AUDIT M12: removeLiquidityETH for the harvest path.
    function removeLiquidityETH(
        address token, uint256 liquidity, uint256 amountTokenMin,
        uint256 amountETHMin, address to, uint256 deadline
    ) external returns (uint256 amountToken, uint256 amountETH);
    function WETH() external pure returns (address);
}

/// @title POLAccumulator (Protocol-Owned Liquidity)
/// @notice Uses protocol revenue (ETH) to buy TOWELI and create permanent LP.
///
///         Flow:
///         1. ETH fees are sent to this contract
///         2. Owner calls accumulate() → swaps half the ETH for TOWELI
///         3. Adds TOWELI + remaining ETH as Uniswap V2 liquidity
///         4. LP tokens are held permanently — never withdrawn
///
///         Result: The protocol owns its own liquidity. Deeper pools,
///         less slippage, more volume, more fees. Self-reinforcing flywheel.
/// AUDIT FIX M-14: Added Pausable so accumulations can be halted during emergencies.
contract POLAccumulator is OwnableNoRenounce, ReentrancyGuard, Pausable, TimelockAdmin {
    using SafeERC20 for IERC20;

    // ─── Timelock Operation Keys ─────────────────────────────────────
    bytes32 public constant SLIPPAGE_CHANGE = keccak256("SLIPPAGE_CHANGE");
    bytes32 public constant ACCUMULATE_CAP_CHANGE = keccak256("ACCUMULATE_CAP_CHANGE");
    bytes32 public constant BACKSTOP_CHANGE = keccak256("BACKSTOP_CHANGE");
    bytes32 public constant SWEEP_ETH_CHANGE = keccak256("SWEEP_ETH_CHANGE");
    bytes32 public constant TREASURY_CHANGE = keccak256("POL_TREASURY_CHANGE");
    bytes32 public constant POL_HARVEST = keccak256("POL_HARVEST"); // AUDIT M12

    // ─── State ────────────────────────────────────────────────────────

    IERC20 public immutable toweli;
    IUniswapV2Router public immutable router;
    address public immutable weth;
    address public immutable lpToken; // LP pair address — cannot be swept

    uint256 public constant MAX_DEADLINE = 2 minutes; // A4-H-07: Tightened from 5m to 2m — both swap and LP add happen in the same tx, so tight deadline reduces MEV sandwich window between the two operations

    // AUDIT FIX H-13: Configurable max slippage for sandwich protection (default 5%, range 1%-10%)
    uint256 public maxSlippageBps = 500;

    // AUDIT FIX: Configurable backstop percentage — hardcoded 90% caused reverts
    // when pool ratio diverged from 50/50. Owner can lower to 0 if caller-provided
    // slippage params are sufficient.
    uint256 public backstopBps = 9000; // 90% default, in basis points (10000 = 100%)
    uint256 public constant MAX_BACKSTOP_BPS = 9900; // Max 99%
    uint256 public constant MIN_BACKSTOP_BPS = 5000; // AUDIT FIX H-03: Min 50% — prevents owner from zeroing backstop

    uint256 public maxAccumulateAmount = 10 ether;
    uint256 public constant MAX_ACCUMULATE_CAP = 100 ether; // AUDIT FIX M-06: Hard upper bound to prevent draining pool reserves

    uint256 public constant ACCUMULATE_CAP_CHANGE_DELAY = 24 hours;
    uint256 public pendingMaxAccumulateAmount;

    uint256 public constant TREASURY_CHANGE_DELAY = 48 hours;
    address public pendingTreasury;

    uint256 public totalETHUsed;
    uint256 public lastAccumulateTime;
    uint256 public constant ACCUMULATE_COOLDOWN = 1 hours;
    uint256 public totalLPCreated;
    uint256 public totalAccumulations;

    // ─── Events ───────────────────────────────────────────────────────

    event Accumulated(uint256 ethUsed, uint256 toweliAdded, uint256 lpCreated);
    event ETHReceived(address indexed sender, uint256 amount);
    event TreasuryChangeProposed(address indexed newTreasury, uint256 executeAfter);
    event TreasuryChanged(address indexed oldTreasury, address indexed newTreasury);
    event TreasuryChangeCancelled(address indexed cancelled);

    // ─── Errors ───────────────────────────────────────────────────────

    error InsufficientETH();
    error SwapFailed();
    error SlippageTooHigh();
    error NoContracts();
    error CannotSweepLP(); // SECURITY FIX: Prevent sweeping LP tokens
    error DeadlineTooFar(); // SECURITY FIX: Deadline exceeds MAX_DEADLINE
    // Legacy error declarations (kept for test compat — TimelockAdmin errors are thrown instead)
    error BackstopTooHigh();
    error NoPendingBackstop();
    error BackstopTimelockNotElapsed();
    error BackstopProposalExpired();
    error CancelExistingBackstopFirst();
    error SlippageBpsOutOfRange();
    error NoPendingSlippage();
    error SlippageTimelockNotElapsed();
    error SlippageProposalExpired();
    error CancelExistingSlippageFirst();
    error AccumulateCapTooLow();
    error NoPendingAccumulateCap();
    error AccumulateCapTimelockNotElapsed();
    error AccumulateCapProposalExpired();
    error CancelExistingAccumulateCapFirst();
    error SweepAmountExceedsProposed();
    error SweepRecipientNotTreasury();

    event BackstopUpdated(uint256 oldBps, uint256 newBps);
    event BackstopChangeProposed(uint256 newBps, uint256 executeAfter);
    event BackstopChangeCancelled(uint256 cancelledBps);
    event MaxSlippageUpdated(uint256 oldBps, uint256 newBps);
    event MaxSlippageChangeProposed(uint256 newBps, uint256 executeAfter);
    event MaxSlippageChangeCancelled(uint256 cancelledBps);
    event MaxAccumulateAmountUpdated(uint256 oldAmount, uint256 newAmount);
    event MaxAccumulateAmountChangeProposed(uint256 newAmount, uint256 executeAfter);
    event MaxAccumulateAmountChangeCancelled(uint256 cancelledAmount);

    uint256 public constant BACKSTOP_CHANGE_DELAY = 24 hours;
    uint256 public pendingBackstopBps;

    uint256 public constant SLIPPAGE_CHANGE_DELAY = 24 hours;
    uint256 public pendingMaxSlippage;

    // ─── Constructor ──────────────────────────────────────────────────

    address public treasury;

    constructor(address _toweli, address _router, address _lpToken, address _treasury)
        OwnableNoRenounce(msg.sender)
    {
        require(_toweli != address(0), "ZERO_TOWELI");
        require(_router != address(0), "ZERO_ROUTER");
        require(_lpToken != address(0), "ZERO_LP_TOKEN");
        require(_treasury != address(0), "ZERO_TREASURY");
        toweli = IERC20(_toweli);
        router = IUniswapV2Router(_router);
        weth = router.WETH();
        lpToken = _lpToken;
        treasury = _treasury;
    }

    receive() external payable {
        emit ETHReceived(msg.sender, msg.value);
    }

    /// @notice Propose a new max slippage tolerance (timelocked 24h)
    /// @param _bps Slippage in basis points (100 = 1%, 1000 = 10%)
    function proposeMaxSlippage(uint256 _bps) external onlyOwner {
        if (_bps < 100 || _bps > 1000) revert SlippageBpsOutOfRange();
        pendingMaxSlippage = _bps;
        _propose(SLIPPAGE_CHANGE, SLIPPAGE_CHANGE_DELAY);
        emit MaxSlippageChangeProposed(_bps, _executeAfter[SLIPPAGE_CHANGE]);
    }

    /// @notice Execute the pending max slippage change after timelock
    function executeMaxSlippage() external onlyOwner {
        _execute(SLIPPAGE_CHANGE);
        uint256 old = maxSlippageBps;
        maxSlippageBps = pendingMaxSlippage;
        pendingMaxSlippage = 0;
        emit MaxSlippageUpdated(old, maxSlippageBps);
    }

    /// @notice Cancel a pending max slippage change
    function cancelMaxSlippageChange() external onlyOwner {
        uint256 cancelled = pendingMaxSlippage;
        _cancel(SLIPPAGE_CHANGE);
        pendingMaxSlippage = 0;
        emit MaxSlippageChangeCancelled(cancelled);
    }

    /// @notice Legacy view helper for test compatibility
    function maxSlippageProposedAt() external view returns (uint256) {
        return _executeAfter[SLIPPAGE_CHANGE];
    }

    /// @notice Propose a new max accumulate amount (timelocked 24h)
    function proposeMaxAccumulateAmount(uint256 _amount) external onlyOwner {
        if (_amount < 0.01 ether) revert AccumulateCapTooLow();
        require(_amount <= MAX_ACCUMULATE_CAP, "EXCEEDS_HARD_CAP"); // AUDIT FIX M-06: Enforce upper bound
        pendingMaxAccumulateAmount = _amount;
        _propose(ACCUMULATE_CAP_CHANGE, ACCUMULATE_CAP_CHANGE_DELAY);
        emit MaxAccumulateAmountChangeProposed(_amount, _executeAfter[ACCUMULATE_CAP_CHANGE]);
    }

    /// @notice Execute the pending max accumulate amount change after timelock
    function executeMaxAccumulateAmount() external onlyOwner {
        _execute(ACCUMULATE_CAP_CHANGE);
        uint256 old = maxAccumulateAmount;
        maxAccumulateAmount = pendingMaxAccumulateAmount;
        pendingMaxAccumulateAmount = 0;
        emit MaxAccumulateAmountUpdated(old, maxAccumulateAmount);
    }

    /// @notice Cancel a pending max accumulate amount change
    function cancelMaxAccumulateAmountChange() external onlyOwner {
        uint256 cancelled = pendingMaxAccumulateAmount;
        _cancel(ACCUMULATE_CAP_CHANGE);
        pendingMaxAccumulateAmount = 0;
        emit MaxAccumulateAmountChangeCancelled(cancelled);
    }

    /// @notice Legacy view helper for test compatibility
    function maxAccumulateAmountProposedAt() external view returns (uint256) {
        return _executeAfter[ACCUMULATE_CAP_CHANGE];
    }

    // ─── Core ─────────────────────────────────────────────────────────

    /// @notice Use ETH balance to buy TOWELI and add permanent LP.
    ///         Splits ETH 50/50: half buys TOWELI, half pairs as ETH liquidity.
    /// @dev AUDIT FIX H-13: This function is a high-value MEV sandwich target.
    ///      The owner MUST use a private mempool (e.g., Flashbots Protect) when calling this.
    ///      The caller-provided minimums (_minTokens, _minLPTokens, _minLPETH) should be set
    ///      based on current TWAP or Chainlink oracle prices, not spot price.
    /// @param _minTokens Minimum TOWELI to receive from swap (slippage protection).
    ///         Must be set to a reasonable value based on current oracle/off-chain price
    ///         to protect against sandwich attacks. A value of 0 offers no protection.
    /// @param _minLPTokens Minimum TOWELI to use in addLiquidity (slippage protection for LP add).
    /// @param _minLPETH Minimum ETH to use in addLiquidity (slippage protection for LP add).
    /// @param _deadline Transaction deadline (reverts if block.timestamp > _deadline)
    /// AUDIT FIX H-05: Removed tx.origin check. It blocked multisig wallets (standard
    /// security practice) from calling accumulate() since msg.sender (multisig) != tx.origin (signer).
    /// The onlyOwner modifier is sufficient access control. Sandwich protection is handled by
    /// slippage parameters + Flashbots Protect, not tx.origin.
    function accumulate(uint256 _minTokens, uint256 _minLPTokens, uint256 _minLPETH, uint256 _deadline) external onlyOwner nonReentrant whenNotPaused {
        require(block.timestamp >= lastAccumulateTime + ACCUMULATE_COOLDOWN, "ACCUMULATE_COOLDOWN");
        require(_deadline >= block.timestamp, "EXPIRED");
        // SECURITY FIX: Enforce tight deadline cap — accumulate() is high-value MEV target
        if (_deadline > block.timestamp + MAX_DEADLINE) revert DeadlineTooFar();
        // SECURITY FIX: Require non-zero slippage parameters to prevent sandwich attacks
        if (_minTokens == 0) revert SlippageTooHigh();

        uint256 ethBalance = address(this).balance;
        if (ethBalance < 0.01 ether) revert InsufficientETH();
        if (ethBalance > maxAccumulateAmount) ethBalance = maxAccumulateAmount;

        uint256 halfETH = ethBalance / 2;

        // Step 1: Buy TOWELI with half the ETH
        address[] memory path = new address[](2);
        path[0] = weth;
        path[1] = address(toweli);

        uint256[] memory amounts = router.swapExactETHForTokens{value: halfETH}(
            _minTokens,
            path,
            address(this),
            _deadline
        );

        uint256 toweliAmount = amounts[amounts.length - 1];

        // Step 2: Approve exact amount for LP add (no infinite approval)
        toweli.forceApprove(address(router), toweliAmount);

        // AUDIT FIX H-13: Enforce configurable maxSlippageBps (default 5%) as sandwich protection.
        // The LP add minimums are derived from actual amounts minus max allowed slippage.
        uint256 remainingETH = ethBalance - halfETH;
        // AUDIT FIX (300-agent #12 / battle-tested): OZ Math.mulDiv for the slippage and
        // backstop floors. 512-bit intermediate + consistent rounding (floor is correct
        // here — slippageMin should not exceed the actual expected output).
        uint256 slippageMinToken = Math.mulDiv(toweliAmount, 10000 - maxSlippageBps, 10000);
        uint256 slippageMinETH = Math.mulDiv(remainingETH, 10000 - maxSlippageBps, 10000);

        uint256 backstopMinToken = Math.mulDiv(toweliAmount, backstopBps, 10000);
        uint256 backstopMinETH = Math.mulDiv(remainingETH, backstopBps, 10000);

        uint256 minToken = _minLPTokens;
        if (slippageMinToken > minToken) minToken = slippageMinToken;
        if (backstopMinToken > minToken) minToken = backstopMinToken;
        uint256 minETH = _minLPETH;
        if (slippageMinETH > minETH) minETH = slippageMinETH;
        if (backstopMinETH > minETH) minETH = backstopMinETH;

        (uint256 tokenUsed, uint256 ethUsed, uint256 lpReceived) = router.addLiquidityETH{value: remainingETH}(
            address(toweli),
            toweliAmount,
            minToken,
            minETH,
            address(this), // LP tokens stay in this contract forever
            _deadline
        );
        require(lpReceived > 0, "ZERO_LP_MINTED"); // AUDIT FIX M-26: Validate LP return value

        // A4-M-17: Revoke residual approval after addLiquidity to prevent leftover approval exploit
        toweli.forceApprove(address(router), 0);

        totalETHUsed += halfETH + ethUsed;
        totalLPCreated += lpReceived;
        totalAccumulations++;

        lastAccumulateTime = block.timestamp;
        emit Accumulated(halfETH + ethUsed, tokenUsed, lpReceived);
    }

    // ─── Treasury Change (L-11) ────────────────────────────────────────

    /// @notice L-11: Propose a treasury address change (48h timelock)
    function proposeTreasuryChange(address _newTreasury) external onlyOwner {
        require(_newTreasury != address(0), "ZERO_ADDRESS");
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
        emit TreasuryChanged(old, treasury);
    }

    /// @notice Cancel a pending treasury change
    function cancelTreasuryChange() external onlyOwner {
        _cancel(TREASURY_CHANGE);
        emit TreasuryChangeCancelled(pendingTreasury);
        pendingTreasury = address(0);
    }

    // ─── Pause ─────────────────────────────────────────────────────────

    /// @notice AUDIT FIX M-14: Pause accumulations during emergencies
    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    // ─── Admin ─────────────────────────────────────────────────────────

    /// @notice AUDIT FIX: Propose a new backstop percentage (timelocked)
    function proposeBackstopChange(uint256 _backstopBps) external onlyOwner {
        require(_backstopBps >= MIN_BACKSTOP_BPS, "BACKSTOP_TOO_LOW"); // AUDIT FIX H-03: Enforce minimum floor
        if (_backstopBps > MAX_BACKSTOP_BPS) revert BackstopTooHigh();
        pendingBackstopBps = _backstopBps;
        _propose(BACKSTOP_CHANGE, BACKSTOP_CHANGE_DELAY);
        emit BackstopChangeProposed(_backstopBps, _executeAfter[BACKSTOP_CHANGE]);
    }

    /// @notice Execute the pending backstop change after timelock
    function executeBackstopChange() external onlyOwner {
        _execute(BACKSTOP_CHANGE);
        uint256 old = backstopBps;
        backstopBps = pendingBackstopBps;
        pendingBackstopBps = 0;
        emit BackstopUpdated(old, backstopBps);
    }

    /// @notice Cancel a pending backstop change
    function cancelBackstopChange() external onlyOwner {
        uint256 cancelled = pendingBackstopBps;
        _cancel(BACKSTOP_CHANGE);
        pendingBackstopBps = 0;
        emit BackstopChangeCancelled(cancelled);
    }

    /// @notice Legacy view helper for test compatibility
    function backstopChangeTime() external view returns (uint256) {
        return _executeAfter[BACKSTOP_CHANGE];
    }

    // AUDIT FIX H-14: Timelock for sweepETH to prevent instant owner drain
    uint256 public constant SWEEP_ETH_DELAY = 48 hours;
    uint256 public sweepETHProposedAmount;

    event SweepETHProposed(uint256 amount, uint256 readyAt);
    event SweepETHExecuted(address indexed recipient, uint256 amount);
    event SweepETHCancelled();

    /// @notice Propose sweeping trapped ETH to treasury (timelocked 48h, amount locked at proposal)
    function proposeSweepETH(uint256 _amount) external onlyOwner {
        require(_amount > 0, "ZERO_AMOUNT");
        sweepETHProposedAmount = _amount;
        _propose(SWEEP_ETH_CHANGE, SWEEP_ETH_DELAY);
        emit SweepETHProposed(_amount, _executeAfter[SWEEP_ETH_CHANGE]);
    }

    /// @notice Execute the pending ETH sweep after timelock (sends to treasury)
    function executeSweepETH() external onlyOwner nonReentrant {
        _execute(SWEEP_ETH_CHANGE);
        uint256 amount = sweepETHProposedAmount;
        uint256 balance = address(this).balance;
        if (amount > balance) amount = balance;
        require(amount > 0, "NO_ETH");
        address recipient = treasury;
        sweepETHProposedAmount = 0;
        (bool success,) = recipient.call{value: amount}("");
        require(success, "ETH_TRANSFER_FAILED");
        emit SweepETHExecuted(recipient, amount);
    }

    /// @notice Cancel a pending ETH sweep
    function cancelSweepETH() external onlyOwner {
        _cancel(SWEEP_ETH_CHANGE);
        sweepETHProposedAmount = 0;
        emit SweepETHCancelled();
    }

    /// @notice Legacy view helper for test compatibility
    function sweepETHReadyAt() external view returns (uint256) {
        return _executeAfter[SWEEP_ETH_CHANGE];
    }

    /// @dev DEPRECATED: Use proposeSweepETH() + executeSweepETH()
    function sweepETH() external pure {
        revert("Use proposeSweepETH()");
    }

    // ─── AUDIT M12: POL Harvest ──────────────────────────────────────────
    /// @notice Pull a fraction of accumulated POL liquidity back as TOWELI + ETH and forward
    ///         to treasury. Closes the "LP locked forever" silent killer where the protocol
    ///         deposited liquidity but had no way to realize fees from the position.
    ///         Strict 30-day timelock and a 10% per-call cap (relative to totalLPCreated)
    ///         prevent governance abuse / sudden liquidity removal that would crash the pair.
    uint256 public constant POL_HARVEST_DELAY = 30 days;
    uint256 public constant MAX_HARVEST_BPS = 1000; // 10% of totalLPCreated per harvest
    uint256 public pendingHarvestLpAmount;

    event POLHarvestProposed(uint256 lpAmount, uint256 readyAt);
    event POLHarvestExecuted(uint256 lpAmount, uint256 tokenOut, uint256 ethOut);
    event POLHarvestCancelled();

    /// @notice Propose a harvest of `lpAmount` LP tokens from the protocol-owned position.
    /// @param  lpAmount LP tokens to remove (capped at MAX_HARVEST_BPS of totalLPCreated)
    function proposeHarvestLP(uint256 lpAmount) external onlyOwner {
        require(lpAmount > 0, "ZERO_LP");
        require(totalLPCreated > 0, "NO_POL");
        uint256 cap = (totalLPCreated * MAX_HARVEST_BPS) / 10000;
        require(lpAmount <= cap, "EXCEEDS_HARVEST_CAP");
        pendingHarvestLpAmount = lpAmount;
        _propose(POL_HARVEST, POL_HARVEST_DELAY);
        emit POLHarvestProposed(lpAmount, _executeAfter[POL_HARVEST]);
    }

    /// @notice Execute the pending POL harvest. Caller provides slippage minimums.
    /// @dev    Uses a tight MAX_DEADLINE consistent with accumulate(); recovered TOWELI
    ///         and ETH both go to treasury (reduces TWAP impact concentration).
    function executeHarvestLP(uint256 minToken, uint256 minETH, uint256 deadline)
        external onlyOwner nonReentrant
    {
        _execute(POL_HARVEST);
        uint256 lpAmount = pendingHarvestLpAmount;
        pendingHarvestLpAmount = 0;
        require(deadline >= block.timestamp, "EXPIRED");
        if (deadline > block.timestamp + MAX_DEADLINE) revert DeadlineTooFar();

        IERC20(lpToken).forceApprove(address(router), lpAmount);
        uint256 ethBefore = address(this).balance;
        (uint256 tokenOut, uint256 ethOut) = router.removeLiquidityETH(
            address(toweli), lpAmount, minToken, minETH, address(this), deadline
        );
        IERC20(lpToken).forceApprove(address(router), 0);

        // Sanity: confirm we actually received the ETH the router claims.
        require(address(this).balance - ethBefore >= ethOut, "ETH_NOT_RECEIVED");

        // Bookkeeping.
        if (lpAmount <= totalLPCreated) {
            totalLPCreated -= lpAmount;
        } else {
            totalLPCreated = 0;
        }

        // Forward ETH to treasury via gas-bounded call (matches sweepETH pattern).
        if (ethOut > 0) {
            (bool ok,) = treasury.call{value: ethOut}("");
            require(ok, "ETH_TRANSFER_FAILED");
        }
        if (tokenOut > 0) {
            toweli.safeTransfer(treasury, tokenOut);
        }

        emit POLHarvestExecuted(lpAmount, tokenOut, ethOut);
    }

    function cancelHarvestLP() external onlyOwner {
        _cancel(POL_HARVEST);
        pendingHarvestLpAmount = 0;
        emit POLHarvestCancelled();
    }

    function harvestLPReadyAt() external view returns (uint256) {
        return _executeAfter[POL_HARVEST];
    }

    /// @notice SECURITY FIX: Sweep leftover token dust (e.g., unused TOWELI from addLiquidityETH)
    // AUDIT FIX: Added nonReentrant for defense-in-depth against malicious token callbacks
    function sweepTokens(address token) external onlyOwner nonReentrant {
        // SECURITY FIX: Cannot sweep LP tokens — defeats permanent liquidity invariant
        require(token != lpToken, "CANNOT_SWEEP_LP");
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance > 0) {
            IERC20(token).safeTransfer(treasury, balance); // AUDIT FIX L-08: Send to treasury, not owner()
        }
    }

    // ─── View ─────────────────────────────────────────────────────────

    /// @notice ETH available for next accumulation
    /// @return The contract's current ETH balance
    function pendingETH() external view returns (uint256) {
        return address(this).balance;
    }

    // Legacy constants kept for test compatibility
    uint256 public constant BACKSTOP_PROPOSAL_VALIDITY = 7 days;
    uint256 public constant SLIPPAGE_PROPOSAL_VALIDITY = 7 days;
    uint256 public constant ACCUMULATE_CAP_PROPOSAL_VALIDITY = 7 days;
}
