// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IUniswapV2Router {
    function swapExactETHForTokens(
        uint256 amountOutMin, address[] calldata path, address to, uint256 deadline
    ) external payable returns (uint256[] memory amounts);
    function addLiquidityETH(
        address token, uint256 amountTokenDesired, uint256 amountTokenMin,
        uint256 amountETHMin, address to, uint256 deadline
    ) external payable returns (uint256 amountToken, uint256 amountETH, uint256 liquidity);
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
contract POLAccumulator is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── State ────────────────────────────────────────────────────────

    IERC20 public immutable toweli;
    IUniswapV2Router public immutable router;
    address public immutable weth;

    uint256 public totalETHUsed;
    uint256 public totalLPCreated;
    uint256 public totalAccumulations;

    // ─── Events ───────────────────────────────────────────────────────

    event Accumulated(uint256 ethUsed, uint256 toweliAdded, uint256 lpCreated);
    event ETHReceived(address indexed sender, uint256 amount);

    // ─── Errors ───────────────────────────────────────────────────────

    error InsufficientETH();
    error SwapFailed();

    // ─── Constructor ──────────────────────────────────────────────────

    constructor(address _toweli, address _router) Ownable(msg.sender) {
        toweli = IERC20(_toweli);
        router = IUniswapV2Router(_router);
        weth = router.WETH();

        // Approve router to spend TOWELI for adding liquidity
        IERC20(_toweli).approve(_router, type(uint256).max);
    }

    receive() external payable {
        emit ETHReceived(msg.sender, msg.value);
    }

    // ─── Core ─────────────────────────────────────────────────────────

    /// @notice Use ETH balance to buy TOWELI and add permanent LP.
    ///         Splits ETH 50/50: half buys TOWELI, half pairs as ETH liquidity.
    /// @param _minTokens Minimum TOWELI to receive from swap (slippage protection)
    function accumulate(uint256 _minTokens) external onlyOwner nonReentrant {
        uint256 ethBalance = address(this).balance;
        if (ethBalance < 0.01 ether) revert InsufficientETH();

        uint256 halfETH = ethBalance / 2;

        // Step 1: Buy TOWELI with half the ETH
        address[] memory path = new address[](2);
        path[0] = weth;
        path[1] = address(toweli);

        uint256[] memory amounts = router.swapExactETHForTokens{value: halfETH}(
            _minTokens,
            path,
            address(this),
            block.timestamp + 300
        );

        uint256 toweliAmount = amounts[amounts.length - 1];

        // Step 2: Add liquidity with TOWELI + remaining ETH
        // LP tokens sent to this contract (held permanently)
        // Use 95% minimums to protect against sandwich on the LP add
        uint256 minToken = (toweliAmount * 95) / 100;
        uint256 minETH = (address(this).balance * 95) / 100;

        (uint256 tokenUsed, uint256 ethUsed, uint256 lpReceived) = router.addLiquidityETH{value: address(this).balance}(
            address(toweli),
            toweliAmount,
            minToken,
            minETH,
            address(this), // LP tokens stay in this contract forever
            block.timestamp + 300
        );

        totalETHUsed += halfETH + ethUsed;
        totalLPCreated += lpReceived;
        totalAccumulations++;

        emit Accumulated(halfETH + ethUsed, tokenUsed, lpReceived);
    }

    // ─── View ─────────────────────────────────────────────────────────

    /// @notice ETH available for next accumulation
    function pendingETH() external view returns (uint256) {
        return address(this).balance;
    }
}
