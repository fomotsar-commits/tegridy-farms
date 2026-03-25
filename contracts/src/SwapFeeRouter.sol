// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IUniswapV2Router02 {
    function swapExactETHForTokens(uint256 amountOutMin, address[] calldata path, address to, uint256 deadline)
        external payable returns (uint256[] memory amounts);
    function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline)
        external returns (uint256[] memory amounts);
    function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline)
        external returns (uint256[] memory amounts);
    function WETH() external pure returns (address);
}

/// @title SwapFeeRouter
/// @notice Wraps Uniswap V2 swaps with a protocol fee.
///         Users swap through this contract instead of directly on Uniswap.
///         A small fee (default 0.3%) is taken from the input before swapping.
///
///         Revenue: fees accumulate in this contract and can be withdrawn by owner.
contract SwapFeeRouter is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IUniswapV2Router02 public immutable router;
    address public treasury;
    uint256 public feeBps; // Fee in basis points (30 = 0.3%)
    uint256 public constant MAX_FEE_BPS = 100; // Max 1%
    uint256 public constant BPS = 10000;

    uint256 public totalETHFees;
    mapping(address => uint256) public totalTokenFees; // token address => total fees collected
    uint256 public totalSwaps;

    event SwapExecuted(address indexed user, address tokenIn, address tokenOut, uint256 amountIn, uint256 fee);
    event FeeUpdated(uint256 oldFee, uint256 newFee);
    event TreasuryUpdated(address oldTreasury, address newTreasury);
    event FeesWithdrawn(address indexed to, uint256 amount);

    error FeeTooHigh();
    error ZeroAddress();
    error ZeroAmount();

    constructor(address _router, address _treasury, uint256 _feeBps) Ownable(msg.sender) {
        if (_router == address(0) || _treasury == address(0)) revert ZeroAddress();
        if (_feeBps > MAX_FEE_BPS) revert FeeTooHigh();
        router = IUniswapV2Router02(_router);
        treasury = _treasury;
        feeBps = _feeBps;
    }

    /// @notice Swap ETH for tokens with protocol fee
    function swapExactETHForTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable nonReentrant returns (uint256[] memory amounts) {
        if (msg.value == 0) revert ZeroAmount();

        // Take fee from ETH input
        uint256 fee = (msg.value * feeBps) / BPS;
        uint256 amountAfterFee = msg.value - fee;

        // Send fee to treasury
        if (fee > 0) {
            (bool ok,) = treasury.call{value: fee}("");
            require(ok, "Fee transfer failed");
            totalETHFees += fee;
        }

        // Execute swap with remaining amount
        amounts = router.swapExactETHForTokens{value: amountAfterFee}(amountOutMin, path, to, deadline);
        totalSwaps++;

        emit SwapExecuted(msg.sender, address(0), path[path.length - 1], msg.value, fee);
    }

    /// @notice Swap tokens for ETH with protocol fee (fee taken from output ETH)
    function swapExactTokensForETH(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external nonReentrant returns (uint256[] memory amounts) {
        if (amountIn == 0) revert ZeroAmount();

        // Transfer tokens from user
        IERC20(path[0]).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(path[0]).approve(address(router), amountIn);

        // Swap to this contract first (to take fee from ETH output)
        amounts = router.swapExactTokensForETH(amountIn, amountOutMin, path, address(this), deadline);

        uint256 ethReceived = amounts[amounts.length - 1];
        uint256 fee = (ethReceived * feeBps) / BPS;
        uint256 userAmount = ethReceived - fee;

        // Send fee to treasury
        if (fee > 0) {
            (bool ok1,) = treasury.call{value: fee}("");
            require(ok1, "Fee transfer failed");
            totalETHFees += fee;
        }

        // Send remaining ETH to user
        (bool ok2,) = to.call{value: userAmount}("");
        require(ok2, "ETH transfer failed");

        totalSwaps++;
        emit SwapExecuted(msg.sender, path[0], address(0), amountIn, fee);
    }

    /// @notice Swap tokens for tokens with protocol fee (fee taken from input)
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external nonReentrant returns (uint256[] memory amounts) {
        if (amountIn == 0) revert ZeroAmount();

        // Transfer tokens from user
        IERC20(path[0]).safeTransferFrom(msg.sender, address(this), amountIn);

        // Take fee from input tokens (send to treasury)
        uint256 fee = (amountIn * feeBps) / BPS;
        uint256 amountAfterFee = amountIn - fee;

        if (fee > 0) {
            IERC20(path[0]).safeTransfer(treasury, fee);
            totalTokenFees[path[0]] += fee;
        }

        // Approve and swap
        IERC20(path[0]).approve(address(router), amountAfterFee);
        amounts = router.swapExactTokensForTokens(amountAfterFee, amountOutMin, path, to, deadline);

        totalSwaps++;
        emit SwapExecuted(msg.sender, path[0], path[path.length - 1], amountIn, fee);
    }

    // ─── Admin ────────────────────────────────────────────────────────

    function setFee(uint256 _feeBps) external onlyOwner {
        if (_feeBps > MAX_FEE_BPS) revert FeeTooHigh();
        uint256 old = feeBps;
        feeBps = _feeBps;
        emit FeeUpdated(old, _feeBps);
    }

    function setTreasury(address _treasury) external onlyOwner {
        if (_treasury == address(0)) revert ZeroAddress();
        address old = treasury;
        treasury = _treasury;
        emit TreasuryUpdated(old, _treasury);
    }

    receive() external payable {}
}
