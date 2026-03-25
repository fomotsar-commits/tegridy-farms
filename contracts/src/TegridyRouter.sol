// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./TegridyPair.sol";

interface ITegridyFactoryRouter {
    function getPair(address tokenA, address tokenB) external view returns (address pair);
}

interface IWETH {
    function deposit() external payable;
    function withdraw(uint256) external;
    function transfer(address to, uint256 value) external returns (bool);
}

/// @title TegridyRouter — Swap router for Tegridy DEX
/// @notice Routes swaps through native Tegridy pools.
///         Supports ETH wrapping/unwrapping, multi-hop paths, and liquidity operations.
///
///         All swaps go through Tegridy's own pools — protocol keeps all fees.
contract TegridyRouter {
    using SafeERC20 for IERC20;

    address public immutable factory;
    address public immutable WETH;

    modifier ensure(uint256 deadline) {
        require(deadline >= block.timestamp, "EXPIRED");
        _;
    }

    constructor(address _factory, address _WETH) {
        factory = _factory;
        WETH = _WETH;
    }

    receive() external payable {
        assert(msg.sender == WETH);
    }

    // ─── Liquidity ────────────────────────────────────────────────────

    function addLiquidity(
        address tokenA, address tokenB,
        uint256 amountADesired, uint256 amountBDesired,
        uint256 amountAMin, uint256 amountBMin,
        address to, uint256 deadline
    ) external ensure(deadline) returns (uint256 amountA, uint256 amountB, uint256 liquidity) {
        address pair = ITegridyFactoryRouter(factory).getPair(tokenA, tokenB);
        require(pair != address(0), "PAIR_NOT_FOUND");

        (amountA, amountB) = _calculateLiquidity(pair, tokenA, tokenB, amountADesired, amountBDesired, amountAMin, amountBMin);

        IERC20(tokenA).safeTransferFrom(msg.sender, pair, amountA);
        IERC20(tokenB).safeTransferFrom(msg.sender, pair, amountB);
        liquidity = TegridyPair(pair).mint(to);
    }

    function addLiquidityETH(
        address token,
        uint256 amountTokenDesired, uint256 amountTokenMin, uint256 amountETHMin,
        address to, uint256 deadline
    ) external payable ensure(deadline) returns (uint256 amountToken, uint256 amountETH, uint256 liquidity) {
        address pair = ITegridyFactoryRouter(factory).getPair(token, WETH);
        require(pair != address(0), "PAIR_NOT_FOUND");

        (amountToken, amountETH) = _calculateLiquidity(pair, token, WETH, amountTokenDesired, msg.value, amountTokenMin, amountETHMin);

        IERC20(token).safeTransferFrom(msg.sender, pair, amountToken);
        IWETH(WETH).deposit{value: amountETH}();
        assert(IWETH(WETH).transfer(pair, amountETH));
        liquidity = TegridyPair(pair).mint(to);

        if (msg.value > amountETH) {
            (bool ok,) = msg.sender.call{value: msg.value - amountETH}("");
            require(ok, "ETH_REFUND_FAILED");
        }
    }

    function removeLiquidity(
        address tokenA, address tokenB,
        uint256 liquidity, uint256 amountAMin, uint256 amountBMin,
        address to, uint256 deadline
    ) external ensure(deadline) returns (uint256 amountA, uint256 amountB) {
        address pair = ITegridyFactoryRouter(factory).getPair(tokenA, tokenB);
        IERC20(pair).safeTransferFrom(msg.sender, pair, liquidity);
        (uint256 amount0, uint256 amount1) = TegridyPair(pair).burn(to);
        (address token0,) = _sortTokens(tokenA, tokenB);
        (amountA, amountB) = tokenA == token0 ? (amount0, amount1) : (amount1, amount0);
        require(amountA >= amountAMin, "INSUFFICIENT_A_AMOUNT");
        require(amountB >= amountBMin, "INSUFFICIENT_B_AMOUNT");
    }

    // ─── Swaps ────────────────────────────────────────────────────────

    function swapExactTokensForTokens(
        uint256 amountIn, uint256 amountOutMin,
        address[] calldata path, address to, uint256 deadline
    ) external ensure(deadline) returns (uint256[] memory amounts) {
        amounts = getAmountsOut(amountIn, path);
        require(amounts[amounts.length - 1] >= amountOutMin, "INSUFFICIENT_OUTPUT_AMOUNT");
        IERC20(path[0]).safeTransferFrom(msg.sender, _pairFor(path[0], path[1]), amounts[0]);
        _swap(amounts, path, to);
    }

    function swapExactETHForTokens(
        uint256 amountOutMin, address[] calldata path, address to, uint256 deadline
    ) external payable ensure(deadline) returns (uint256[] memory amounts) {
        require(path[0] == WETH, "INVALID_PATH");
        amounts = getAmountsOut(msg.value, path);
        require(amounts[amounts.length - 1] >= amountOutMin, "INSUFFICIENT_OUTPUT_AMOUNT");
        IWETH(WETH).deposit{value: amounts[0]}();
        assert(IWETH(WETH).transfer(_pairFor(path[0], path[1]), amounts[0]));
        _swap(amounts, path, to);
    }

    function swapExactTokensForETH(
        uint256 amountIn, uint256 amountOutMin,
        address[] calldata path, address to, uint256 deadline
    ) external ensure(deadline) returns (uint256[] memory amounts) {
        require(path[path.length - 1] == WETH, "INVALID_PATH");
        amounts = getAmountsOut(amountIn, path);
        require(amounts[amounts.length - 1] >= amountOutMin, "INSUFFICIENT_OUTPUT_AMOUNT");
        IERC20(path[0]).safeTransferFrom(msg.sender, _pairFor(path[0], path[1]), amounts[0]);
        _swap(amounts, path, address(this));
        IWETH(WETH).withdraw(amounts[amounts.length - 1]);
        (bool ok,) = to.call{value: amounts[amounts.length - 1]}("");
        require(ok, "ETH_TRANSFER_FAILED");
    }

    // ─── View Functions ───────────────────────────────────────────────

    function getAmountsOut(uint256 amountIn, address[] memory path) public view returns (uint256[] memory amounts) {
        require(path.length >= 2, "INVALID_PATH");
        amounts = new uint256[](path.length);
        amounts[0] = amountIn;
        for (uint256 i = 0; i < path.length - 1; i++) {
            address pair = _pairFor(path[i], path[i + 1]);
            (uint112 reserveIn, uint112 reserveOut) = _getReserves(pair, path[i], path[i + 1]);
            amounts[i + 1] = _getAmountOut(amounts[i], reserveIn, reserveOut);
        }
    }

    function quote(uint256 amountA, uint256 reserveA, uint256 reserveB) public pure returns (uint256 amountB) {
        require(amountA > 0, "INSUFFICIENT_AMOUNT");
        require(reserveA > 0 && reserveB > 0, "INSUFFICIENT_LIQUIDITY");
        amountB = (amountA * reserveB) / reserveA;
    }

    // ─── Internal ─────────────────────────────────────────────────────

    function _swap(uint256[] memory amounts, address[] memory path, address _to) internal {
        for (uint256 i = 0; i < path.length - 1; i++) {
            (address input, address output) = (path[i], path[i + 1]);
            (address token0,) = _sortTokens(input, output);
            uint256 amountOut = amounts[i + 1];
            (uint256 amount0Out, uint256 amount1Out) = input == token0 ? (uint256(0), amountOut) : (amountOut, uint256(0));
            address to = i < path.length - 2 ? _pairFor(output, path[i + 2]) : _to;
            TegridyPair(_pairFor(input, output)).swap(amount0Out, amount1Out, to, "");
        }
    }

    function _pairFor(address tokenA, address tokenB) internal view returns (address) {
        return ITegridyFactoryRouter(factory).getPair(tokenA, tokenB);
    }

    function _getReserves(address pair, address tokenA, address tokenB) internal view returns (uint112 reserveA, uint112 reserveB) {
        (address token0,) = _sortTokens(tokenA, tokenB);
        (uint112 reserve0, uint112 reserve1,) = TegridyPair(pair).getReserves();
        (reserveA, reserveB) = tokenA == token0 ? (reserve0, reserve1) : (reserve1, reserve0);
    }

    /// @dev 1% total fee: amountIn * 990/1000 (0.8% treasury + 0.2% LP)
    function _getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut) internal pure returns (uint256 amountOut) {
        require(amountIn > 0, "INSUFFICIENT_INPUT_AMOUNT");
        require(reserveIn > 0 && reserveOut > 0, "INSUFFICIENT_LIQUIDITY");
        uint256 amountInWithFee = amountIn * 990; // 1% fee = 990/1000
        uint256 numerator = amountInWithFee * reserveOut;
        uint256 denominator = reserveIn * 1000 + amountInWithFee;
        amountOut = numerator / denominator;
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
                assert(amountAOptimal <= amountADesired);
                require(amountAOptimal >= amountAMin, "INSUFFICIENT_A_AMOUNT");
                (amountA, amountB) = (amountAOptimal, amountBDesired);
            }
        }
    }
}
