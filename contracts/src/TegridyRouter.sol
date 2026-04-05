// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./TegridyPair.sol";
import {WETHFallbackLib, IWETH} from "./lib/WETHFallbackLib.sol";

interface ITegridyFactoryRouter {
    function getPair(address tokenA, address tokenB) external view returns (address pair);
    function disabledPairs(address pair) external view returns (bool);
}

/// @title TegridyRouter — Swap router for Tegridy DEX
/// @notice Routes swaps through native Tegridy pools.
///         Supports ETH wrapping/unwrapping, multi-hop paths, and liquidity operations.
///
///         All swaps go through Tegridy's own pools — protocol keeps all fees.
contract TegridyRouter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public immutable factory;
    address public immutable WETH;

    uint256 public constant MAX_DEADLINE = 30 minutes;

    // H-15: Events for all user-facing operations
    event Swap(address indexed sender, address[] path, uint256 amountIn, uint256 amountOut, address indexed to);
    event LiquidityAdded(address indexed provider, address tokenA, address tokenB, uint256 amountA, uint256 amountB, uint256 liquidity);
    event LiquidityRemoved(address indexed provider, address tokenA, address tokenB, uint256 amountA, uint256 amountB, uint256 liquidity);

    modifier ensure(uint256 deadline) {
        require(deadline >= block.timestamp, "EXPIRED");
        require(deadline <= block.timestamp + MAX_DEADLINE, "DEADLINE_TOO_FAR");
        _;
    }

    constructor(address _factory, address _WETH) {
        // AUDIT FIX v2: Zero-address checks prevent deploying a bricked router
        require(_factory != address(0), "ZERO_FACTORY");
        require(_WETH != address(0), "ZERO_WETH");
        factory = _factory;
        WETH = _WETH;
    }

    receive() external payable {
        require(msg.sender == WETH, "ONLY_WETH"); // L-08: replace assert with require
    }

    // ─── Liquidity ────────────────────────────────────────────────────

    function addLiquidity(
        address tokenA, address tokenB,
        uint256 amountADesired, uint256 amountBDesired,
        uint256 amountAMin, uint256 amountBMin,
        address to, uint256 deadline
    ) external nonReentrant ensure(deadline) returns (uint256 amountA, uint256 amountB, uint256 liquidity) {
        address pair = ITegridyFactoryRouter(factory).getPair(tokenA, tokenB);
        require(pair != address(0), "PAIR_NOT_FOUND");

        (amountA, amountB) = _calculateLiquidity(pair, tokenA, tokenB, amountADesired, amountBDesired, amountAMin, amountBMin);

        // SECURITY FIX: Prevent minting LP tokens to the pair itself, which would
        // donate the liquidity to all remaining LPs on the next burn() call.
        require(to != pair, "INVALID_TO");
        IERC20(tokenA).safeTransferFrom(msg.sender, pair, amountA);
        IERC20(tokenB).safeTransferFrom(msg.sender, pair, amountB);
        liquidity = TegridyPair(pair).mint(to);
        require(liquidity > 0, "INSUFFICIENT_LIQUIDITY_MINTED"); // AUDIT FIX M-25: Validate mint return
        emit LiquidityAdded(msg.sender, tokenA, tokenB, amountA, amountB, liquidity);
    }

    function addLiquidityETH(
        address token,
        uint256 amountTokenDesired, uint256 amountTokenMin, uint256 amountETHMin,
        address to, uint256 deadline
    ) external payable nonReentrant ensure(deadline) returns (uint256 amountToken, uint256 amountETH, uint256 liquidity) {
        address pair = ITegridyFactoryRouter(factory).getPair(token, WETH);
        require(pair != address(0), "PAIR_NOT_FOUND");

        (amountToken, amountETH) = _calculateLiquidity(pair, token, WETH, amountTokenDesired, msg.value, amountTokenMin, amountETHMin);

        // SECURITY FIX: Prevent minting LP tokens to the pair itself
        require(to != pair, "INVALID_TO");
        IERC20(token).safeTransferFrom(msg.sender, pair, amountToken);
        IWETH(WETH).deposit{value: amountETH}();
        require(IWETH(WETH).transfer(pair, amountETH), "WETH_TRANSFER_FAILED"); // L-08: replace assert with require
        liquidity = TegridyPair(pair).mint(to);
        require(liquidity > 0, "INSUFFICIENT_LIQUIDITY_MINTED"); // AUDIT FIX M-25: Validate mint return
        emit LiquidityAdded(msg.sender, token, WETH, amountToken, amountETH, liquidity);

        if (msg.value > amountETH) {
            uint256 refund = msg.value - amountETH;
            // SECURITY FIX M-03: If ETH refund fails (contract caller without receive()),
            // wrap as WETH and send instead to prevent permanently locking excess ETH.
            WETHFallbackLib.safeTransferETHOrWrap(WETH, msg.sender, refund);
        }
    }

    function removeLiquidity(
        address tokenA, address tokenB,
        uint256 liquidity, uint256 amountAMin, uint256 amountBMin,
        address to, uint256 deadline
    ) external nonReentrant ensure(deadline) returns (uint256 amountA, uint256 amountB) {
        address pair = ITegridyFactoryRouter(factory).getPair(tokenA, tokenB);
        require(pair != address(0), "PAIR_NOT_FOUND"); // L-07: pair existence check
        require(to != pair, "INVALID_TO");
        IERC20(pair).safeTransferFrom(msg.sender, pair, liquidity);
        (uint256 amount0, uint256 amount1) = TegridyPair(pair).burn(to);
        (address token0,) = _sortTokens(tokenA, tokenB);
        (amountA, amountB) = tokenA == token0 ? (amount0, amount1) : (amount1, amount0);
        require(amountA >= amountAMin, "INSUFFICIENT_A_AMOUNT");
        require(amountB >= amountBMin, "INSUFFICIENT_B_AMOUNT");
        emit LiquidityRemoved(msg.sender, tokenA, tokenB, amountA, amountB, liquidity);
    }

    /// @notice Remove liquidity and receive ETH instead of WETH (M-02)
    function removeLiquidityETH(
        address token,
        uint256 liquidity, uint256 amountTokenMin, uint256 amountETHMin,
        address to, uint256 deadline
    ) external nonReentrant ensure(deadline) returns (uint256 amountToken, uint256 amountETH) {
        require(to != address(0), "ZERO_TO");
        // Remove liquidity to this contract so we can unwrap WETH
        address pair = ITegridyFactoryRouter(factory).getPair(token, WETH);
        require(pair != address(0), "PAIR_NOT_FOUND");
        require(to != pair, "INVALID_TO");
        IERC20(pair).safeTransferFrom(msg.sender, pair, liquidity);
        (uint256 amount0, uint256 amount1) = TegridyPair(pair).burn(address(this));
        (address token0,) = _sortTokens(token, WETH);
        (amountToken, amountETH) = token == token0 ? (amount0, amount1) : (amount1, amount0);
        require(amountToken >= amountTokenMin, "INSUFFICIENT_TOKEN_AMOUNT");
        require(amountETH >= amountETHMin, "INSUFFICIENT_ETH_AMOUNT");

        emit LiquidityRemoved(msg.sender, token, WETH, amountToken, amountETH, liquidity);

        IERC20(token).safeTransfer(to, amountToken);
        IWETH(WETH).withdraw(amountETH);
        // SECURITY FIX M-03: If ETH transfer fails (contract caller without receive()),
        // wrap as WETH and send instead to prevent permanently locking user funds.
        WETHFallbackLib.safeTransferETHOrWrap(WETH, to, amountETH);
    }

    // ─── Exact-Input Swaps ─────────────────────────────────────────────

    function swapExactTokensForTokens(
        uint256 amountIn, uint256 amountOutMin,
        address[] calldata path, address to, uint256 deadline
    ) external nonReentrant ensure(deadline) returns (uint256[] memory amounts) {
        require(path.length >= 2, "INVALID_PATH");
        require(to != address(0), "ZERO_TO"); // L-18: to validation
        // H-09: Prevent swapping output to the pair itself
        require(to != _pairFor(path[path.length - 2], path[path.length - 1]), "INVALID_TO");
        // SECURITY FIX H5: Validate path BEFORE any token transfers to prevent
        // tokens getting stuck in pairs on cyclic path revert
        _validatePathNoCycles(path);
        amounts = getAmountsOut(amountIn, path);
        require(amounts[amounts.length - 1] >= amountOutMin, "INSUFFICIENT_OUTPUT_AMOUNT");
        IERC20(path[0]).safeTransferFrom(msg.sender, _pairFor(path[0], path[1]), amounts[0]);
        _swap(amounts, path, to);
        emit Swap(msg.sender, path, amounts[0], amounts[amounts.length - 1], to);
    }

    function swapExactETHForTokens(
        uint256 amountOutMin, address[] calldata path, address to, uint256 deadline
    ) external payable nonReentrant ensure(deadline) returns (uint256[] memory amounts) {
        require(path.length >= 2, "INVALID_PATH");
        require(path[0] == WETH, "INVALID_PATH");
        require(to != address(0), "ZERO_TO"); // L-18: to validation
        // H-09: Prevent swapping output to the pair itself
        require(to != _pairFor(path[path.length - 2], path[path.length - 1]), "INVALID_TO");
        _validatePathNoCycles(path); // SECURITY FIX H5
        amounts = getAmountsOut(msg.value, path);
        require(amounts[amounts.length - 1] >= amountOutMin, "INSUFFICIENT_OUTPUT_AMOUNT");
        IWETH(WETH).deposit{value: amounts[0]}();
        require(IWETH(WETH).transfer(_pairFor(path[0], path[1]), amounts[0]), "WETH_TRANSFER_FAILED"); // L-08
        _swap(amounts, path, to);
        emit Swap(msg.sender, path, amounts[0], amounts[amounts.length - 1], to);
    }

    function swapExactTokensForETH(
        uint256 amountIn, uint256 amountOutMin,
        address[] calldata path, address to, uint256 deadline
    ) external nonReentrant ensure(deadline) returns (uint256[] memory amounts) {
        require(path.length >= 2, "INVALID_PATH");
        require(path[path.length - 1] == WETH, "INVALID_PATH");
        require(to != address(0), "ZERO_TO"); // L-18: to validation
        // H-09: Prevent swapping output to the pair itself
        require(to != _pairFor(path[path.length - 2], path[path.length - 1]), "INVALID_TO");
        _validatePathNoCycles(path); // SECURITY FIX H5
        amounts = getAmountsOut(amountIn, path);
        require(amounts[amounts.length - 1] >= amountOutMin, "INSUFFICIENT_OUTPUT_AMOUNT");
        IERC20(path[0]).safeTransferFrom(msg.sender, _pairFor(path[0], path[1]), amounts[0]);
        _swap(amounts, path, address(this));
        IWETH(WETH).withdraw(amounts[amounts.length - 1]);
        // AUDIT FIX: WETH fallback for contracts that cannot receive ETH
        WETHFallbackLib.safeTransferETHOrWrap(WETH, to, amounts[amounts.length - 1]);
        emit Swap(msg.sender, path, amounts[0], amounts[amounts.length - 1], to);
    }

    // ─── Exact-Output Swaps (M-03) ────────────────────────────────────

    function swapTokensForExactTokens(
        uint256 amountOut, uint256 amountInMax,
        address[] calldata path, address to, uint256 deadline
    ) external nonReentrant ensure(deadline) returns (uint256[] memory amounts) {
        require(path.length >= 2, "INVALID_PATH");
        require(to != address(0), "ZERO_TO");
        // H-09: Prevent swapping output to the pair itself
        require(to != _pairFor(path[path.length - 2], path[path.length - 1]), "INVALID_TO");
        // SECURITY FIX M-2: Validate path before transfer (matching exact-input swap pattern)
        _validatePathNoCycles(path);
        amounts = getAmountsIn(amountOut, path);
        require(amounts[0] <= amountInMax, "EXCESSIVE_INPUT_AMOUNT");
        IERC20(path[0]).safeTransferFrom(msg.sender, _pairFor(path[0], path[1]), amounts[0]);
        _swap(amounts, path, to);
        emit Swap(msg.sender, path, amounts[0], amounts[amounts.length - 1], to);
    }

    function swapTokensForExactETH(
        uint256 amountOut, uint256 amountInMax,
        address[] calldata path, address to, uint256 deadline
    ) external nonReentrant ensure(deadline) returns (uint256[] memory amounts) {
        require(path.length >= 2, "INVALID_PATH");
        require(path[path.length - 1] == WETH, "INVALID_PATH");
        require(to != address(0), "ZERO_TO");
        // H-09: Prevent swapping output to the pair itself
        require(to != _pairFor(path[path.length - 2], path[path.length - 1]), "INVALID_TO");
        // SECURITY FIX M-2: Validate path before transfer (matching exact-input swap pattern)
        _validatePathNoCycles(path);
        amounts = getAmountsIn(amountOut, path);
        require(amounts[0] <= amountInMax, "EXCESSIVE_INPUT_AMOUNT");
        IERC20(path[0]).safeTransferFrom(msg.sender, _pairFor(path[0], path[1]), amounts[0]);
        _swap(amounts, path, address(this));
        IWETH(WETH).withdraw(amountOut);
        // AUDIT FIX: WETH fallback for contracts that cannot receive ETH
        WETHFallbackLib.safeTransferETHOrWrap(WETH, to, amountOut);
        emit Swap(msg.sender, path, amounts[0], amounts[amounts.length - 1], to);
    }

    function swapETHForExactTokens(
        uint256 amountOut, address[] calldata path, address to, uint256 deadline
    ) external payable nonReentrant ensure(deadline) returns (uint256[] memory amounts) {
        require(path.length >= 2, "INVALID_PATH");
        require(path[0] == WETH, "INVALID_PATH");
        require(to != address(0), "ZERO_TO");
        // H-09: Prevent swapping output to the pair itself
        require(to != _pairFor(path[path.length - 2], path[path.length - 1]), "INVALID_TO");
        // SECURITY FIX M-2: Validate path before transfer (matching exact-input swap pattern)
        _validatePathNoCycles(path);
        amounts = getAmountsIn(amountOut, path);
        require(amounts[0] <= msg.value, "EXCESSIVE_INPUT_AMOUNT");
        IWETH(WETH).deposit{value: amounts[0]}();
        require(IWETH(WETH).transfer(_pairFor(path[0], path[1]), amounts[0]), "WETH_TRANSFER_FAILED");
        _swap(amounts, path, to);
        emit Swap(msg.sender, path, amounts[0], amounts[amounts.length - 1], to);
        // Refund excess ETH
        if (msg.value > amounts[0]) {
            uint256 refund = msg.value - amounts[0];
            // SECURITY FIX M-03: If ETH refund fails (contract caller without receive()),
            // wrap as WETH and send instead to prevent permanently locking excess ETH.
            WETHFallbackLib.safeTransferETHOrWrap(WETH, msg.sender, refund);
        }
    }

    // ─── Fee-on-Transfer Swaps (H-17) ─────────────────────────────────

    /// @notice Swap exact tokens for tokens, supporting fee-on-transfer tokens.
    ///         Uses balance-before/after pattern instead of trusting amountIn.
    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amountIn, uint256 amountOutMin,
        address[] calldata path, address to, uint256 deadline
    ) external nonReentrant ensure(deadline) {
        require(path.length >= 2, "INVALID_PATH");
        require(path.length <= 10, "PATH_TOO_LONG");
        require(to != address(0), "ZERO_TO");
        require(to != _pairFor(path[path.length - 2], path[path.length - 1]), "INVALID_TO");
        IERC20(path[0]).safeTransferFrom(msg.sender, _pairFor(path[0], path[1]), amountIn);
        uint256 balanceBefore = IERC20(path[path.length - 1]).balanceOf(to);
        _swapSupportingFeeOnTransferTokens(path, to);
        uint256 amountOut = IERC20(path[path.length - 1]).balanceOf(to) - balanceBefore;
        require(amountOut >= amountOutMin, "INSUFFICIENT_OUTPUT_AMOUNT");
        emit Swap(msg.sender, path, amountIn, amountOut, to);
    }

    /// @notice Swap exact ETH for tokens, supporting fee-on-transfer tokens.
    function swapExactETHForTokensSupportingFeeOnTransferTokens(
        uint256 amountOutMin, address[] calldata path, address to, uint256 deadline
    ) external payable nonReentrant ensure(deadline) {
        require(path.length >= 2, "INVALID_PATH");
        require(path.length <= 10, "PATH_TOO_LONG");
        require(path[0] == WETH, "INVALID_PATH");
        require(to != address(0), "ZERO_TO");
        require(to != _pairFor(path[path.length - 2], path[path.length - 1]), "INVALID_TO");
        uint256 amountIn = msg.value;
        IWETH(WETH).deposit{value: amountIn}();
        require(IWETH(WETH).transfer(_pairFor(path[0], path[1]), amountIn), "WETH_TRANSFER_FAILED");
        uint256 balanceBefore = IERC20(path[path.length - 1]).balanceOf(to);
        _swapSupportingFeeOnTransferTokens(path, to);
        uint256 amountOut = IERC20(path[path.length - 1]).balanceOf(to) - balanceBefore;
        require(amountOut >= amountOutMin, "INSUFFICIENT_OUTPUT_AMOUNT");
        emit Swap(msg.sender, path, amountIn, amountOut, to);
    }

    /// @notice Swap exact tokens for ETH, supporting fee-on-transfer tokens.
    function swapExactTokensForETHSupportingFeeOnTransferTokens(
        uint256 amountIn, uint256 amountOutMin,
        address[] calldata path, address to, uint256 deadline
    ) external nonReentrant ensure(deadline) {
        require(path.length >= 2, "INVALID_PATH");
        require(path.length <= 10, "PATH_TOO_LONG");
        require(path[path.length - 1] == WETH, "INVALID_PATH");
        require(to != address(0), "ZERO_TO");
        require(to != _pairFor(path[path.length - 2], path[path.length - 1]), "INVALID_TO");
        IERC20(path[0]).safeTransferFrom(msg.sender, _pairFor(path[0], path[1]), amountIn);
        uint256 balanceBefore = IERC20(WETH).balanceOf(address(this));
        _swapSupportingFeeOnTransferTokens(path, address(this));
        uint256 amountOut = IERC20(WETH).balanceOf(address(this)) - balanceBefore;
        require(amountOut >= amountOutMin, "INSUFFICIENT_OUTPUT_AMOUNT");
        IWETH(WETH).withdraw(amountOut);
        WETHFallbackLib.safeTransferETHOrWrap(WETH, to, amountOut);
        emit Swap(msg.sender, path, amountIn, amountOut, to);
    }

    // ─── View Functions ───────────────────────────────────────────────

    function getAmountsOut(uint256 amountIn, address[] memory path) public view returns (uint256[] memory amounts) {
        require(path.length >= 2, "INVALID_PATH");
        require(path.length <= 10, "PATH_TOO_LONG"); // L-06: path length limit
        amounts = new uint256[](path.length);
        amounts[0] = amountIn;
        for (uint256 i = 0; i < path.length - 1; i++) {
            address pair = _pairFor(path[i], path[i + 1]);
            (uint112 reserveIn, uint112 reserveOut) = _getReserves(pair, path[i], path[i + 1]);
            amounts[i + 1] = _getAmountOut(amounts[i], reserveIn, reserveOut);
        }
    }

    function getAmountsIn(uint256 amountOut, address[] memory path) public view returns (uint256[] memory amounts) {
        require(path.length >= 2, "INVALID_PATH");
        require(path.length <= 10, "PATH_TOO_LONG"); // L-06: path length limit
        amounts = new uint256[](path.length);
        amounts[amounts.length - 1] = amountOut;
        for (uint256 i = path.length - 1; i > 0; i--) {
            address pair = _pairFor(path[i - 1], path[i]);
            (uint112 reserveIn, uint112 reserveOut) = _getReserves(pair, path[i - 1], path[i]);
            amounts[i - 1] = _getAmountIn(amounts[i], reserveIn, reserveOut);
        }
    }

    function quote(uint256 amountA, uint256 reserveA, uint256 reserveB) public pure returns (uint256 amountB) {
        require(amountA > 0, "INSUFFICIENT_AMOUNT");
        require(reserveA > 0 && reserveB > 0, "INSUFFICIENT_LIQUIDITY");
        amountB = (amountA * reserveB) / reserveA;
    }

    // ─── Internal ─────────────────────────────────────────────────────

    /// @dev SECURITY FIX H5: Validate path has no cyclic pairs BEFORE any token transfers.
    /// Prevents tokens getting stuck in pairs when cyclic path reverts after transfer.
    function _validatePathNoCycles(address[] memory path) internal view {
        uint256 hops = path.length - 1;
        if (hops < 2) return; // No cycles possible with 1 hop
        address[] memory pairs = new address[](hops);
        for (uint256 i = 0; i < hops; i++) {
            pairs[i] = _pairFor(path[i], path[i + 1]);
        }
        for (uint256 i = 0; i < hops; i++) {
            for (uint256 j = i + 1; j < hops; j++) {
                require(pairs[i] != pairs[j], "CYCLIC_PATH");
            }
        }
    }

    function _swap(uint256[] memory amounts, address[] memory path, address _to) internal {
        uint256 hops = path.length - 1;
        address[] memory pairs = new address[](hops);
        for (uint256 i = 0; i < hops; i++) {
            pairs[i] = _pairFor(path[i], path[i + 1]);
        }
        // SECURITY FIX H-02: Reject cyclic paths — no pair should appear twice in the same swap.
        for (uint256 i = 0; i < hops; i++) {
            for (uint256 j = i + 1; j < hops; j++) {
                require(pairs[i] != pairs[j], "CYCLIC_PATH");
            }
        }
        for (uint256 i = 0; i < hops; i++) {
            (address input, address output) = (path[i], path[i + 1]);
            require(input != output, "IDENTICAL_CONSECUTIVE_TOKENS");
            (address token0,) = _sortTokens(input, output);
            uint256 amountOut = amounts[i + 1];
            (uint256 amount0Out, uint256 amount1Out) = input == token0 ? (uint256(0), amountOut) : (amountOut, uint256(0));
            address to = i < hops - 1 ? pairs[i + 1] : _to;
            TegridyPair(pairs[i]).swap(amount0Out, amount1Out, to, "");
        }
    }

    /// @dev Fee-on-transfer swap: measures actual balances instead of trusting amounts (H-17)
    function _swapSupportingFeeOnTransferTokens(address[] memory path, address _to) internal {
        uint256 hops = path.length - 1;
        address[] memory pairs = new address[](hops);
        for (uint256 i = 0; i < hops; i++) {
            pairs[i] = _pairFor(path[i], path[i + 1]);
        }
        // SECURITY FIX H-02: Reject cyclic paths
        for (uint256 i = 0; i < hops; i++) {
            for (uint256 j = i + 1; j < hops; j++) {
                require(pairs[i] != pairs[j], "CYCLIC_PATH");
            }
        }
        for (uint256 i = 0; i < hops; i++) {
            (address input, address output) = (path[i], path[i + 1]);
            require(input != output, "IDENTICAL_CONSECUTIVE_TOKENS");
            (address token0,) = _sortTokens(input, output);
            address pair = pairs[i];
            uint256 amountInput;
            uint256 amountOutput;
            {
                (uint112 reserveIn, uint112 reserveOut) = _getReserves(pair, input, output);
                amountInput = IERC20(input).balanceOf(pair) - reserveIn;
                amountOutput = _getAmountOut(amountInput, reserveIn, reserveOut);
            }
            (uint256 amount0Out, uint256 amount1Out) = input == token0 ? (uint256(0), amountOutput) : (amountOutput, uint256(0));
            address to = i < hops - 1 ? pairs[i + 1] : _to;
            TegridyPair(pair).swap(amount0Out, amount1Out, to, "");
        }
    }

    /// @dev Uses factory lookup instead of CREATE2 address prediction.
    ///      This avoids coupling to the pair's init code hash, which would break
    ///      if TegridyPair bytecode changes. The factory lookup is a single STATICCALL
    ///      and keeps the router upgradeable without redeployment.
    function _pairFor(address tokenA, address tokenB) internal view returns (address pair) {
        pair = ITegridyFactoryRouter(factory).getPair(tokenA, tokenB);
        require(pair != address(0), "PAIR_NOT_FOUND"); // H-04: pair existence check
        require(!ITegridyFactoryRouter(factory).disabledPairs(pair), "PAIR_DISABLED");
    }

    function _getReserves(address pair, address tokenA, address tokenB) internal view returns (uint112 reserveA, uint112 reserveB) {
        (address token0,) = _sortTokens(tokenA, tokenB);
        (uint112 reserve0, uint112 reserve1,) = TegridyPair(pair).getReserves();
        (reserveA, reserveB) = tokenA == token0 ? (reserve0, reserve1) : (reserve1, reserve0);
    }

    /// @dev 0.3% total fee: amountIn * 997/1000
    function _getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut) internal pure returns (uint256 amountOut) {
        require(amountIn > 0, "INSUFFICIENT_INPUT_AMOUNT");
        require(reserveIn > 0 && reserveOut > 0, "INSUFFICIENT_LIQUIDITY");
        uint256 amountInWithFee = amountIn * 997; // 0.3% fee = 997/1000
        uint256 numerator = amountInWithFee * reserveOut;
        uint256 denominator = reserveIn * 1000 + amountInWithFee;
        amountOut = numerator / denominator;
    }

    /// @dev Inverse of _getAmountOut: given a desired output, compute the required input (M-03)
    function _getAmountIn(uint256 amountOut, uint256 reserveIn, uint256 reserveOut) internal pure returns (uint256 amountIn) {
        require(amountOut > 0, "INSUFFICIENT_OUTPUT_AMOUNT");
        require(reserveIn > 0 && reserveOut > 0, "INSUFFICIENT_LIQUIDITY");
        require(amountOut < reserveOut, "EXCESSIVE_OUTPUT_AMOUNT");
        uint256 numerator = reserveIn * amountOut * 1000;
        uint256 denominator = (reserveOut - amountOut) * 997;
        amountIn = (numerator / denominator) + 1;
    }

    function _sortTokens(address tokenA, address tokenB) internal pure returns (address token0, address token1) {
        require(tokenA != tokenB, "IDENTICAL_ADDRESSES");
        (token0, token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        require(token0 != address(0), "ZERO_ADDRESS");
    }

    function _calculateLiquidity(
        address pair, address tokenA, address tokenB,
        uint256 amountADesired, uint256 amountBDesired,
        uint256 amountAMin, uint256 amountBMin
    ) internal view returns (uint256 amountA, uint256 amountB) {
        (uint112 reserveA, uint112 reserveB) = _getReserves(pair, tokenA, tokenB);
        if (reserveA == 0 && reserveB == 0) {
            (amountA, amountB) = (amountADesired, amountBDesired);
        } else {
            uint256 amountBOptimal = quote(amountADesired, reserveA, reserveB);
            if (amountBOptimal <= amountBDesired) {
                require(amountBOptimal >= amountBMin, "INSUFFICIENT_B_AMOUNT");
                (amountA, amountB) = (amountADesired, amountBOptimal);
            } else {
                uint256 amountAOptimal = quote(amountBDesired, reserveB, reserveA);
                require(amountAOptimal <= amountADesired, "EXCESSIVE_A_AMOUNT"); // L-08: replace assert with require
                require(amountAOptimal >= amountAMin, "INSUFFICIENT_A_AMOUNT");
                (amountA, amountB) = (amountAOptimal, amountBDesired);
            }
        }
    }
}
