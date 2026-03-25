// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title TegridyPair — Constant Product AMM Pool
/// @notice Fork of Uniswap V2 Pair adapted for Solidity 0.8.26.
///         Each pair holds two tokens and facilitates swaps using x*y=k formula.
///
///         Fee structure:
///         - 0.3% total fee on every swap
///         - 0.25% goes to LPs (via accumulated reserves)
///         - 0.05% goes to protocol (feeTo address)
///
///         LP tokens (this contract is also an ERC20) represent share of pool.
contract TegridyPair is ERC20, ReentrancyGuard {

    address public factory;
    address public token0;
    address public token1;

    uint8 public decimals0;
    uint8 public decimals1;

    uint112 private reserve0;
    uint112 private reserve1;
    uint32 private blockTimestampLast;

    uint256 public kLast; // reserve0 * reserve1, as of immediately after the most recent liquidity event

    uint256 private constant MINIMUM_LIQUIDITY = 1000;

    event Mint(address indexed sender, uint256 amount0, uint256 amount1);
    event Burn(address indexed sender, uint256 amount0, uint256 amount1, address indexed to);
    event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to);
    event Sync(uint112 reserve0, uint112 reserve1);

    constructor() ERC20("Tegridy LP", "TGLP") {
        factory = msg.sender;
    }

    function initialize(address _token0, address _token1) external {
        require(msg.sender == factory, "FORBIDDEN");
        token0 = _token0;
        token1 = _token1;
        decimals0 = IERC20Metadata(_token0).decimals();
        decimals1 = IERC20Metadata(_token1).decimals();
    }

    function getReserves() public view returns (uint112 _reserve0, uint112 _reserve1, uint32 _blockTimestampLast) {
        _reserve0 = reserve0;
        _reserve1 = reserve1;
        _blockTimestampLast = blockTimestampLast;
    }

    // ─── Decimal normalization ────────────────────────────────────────
    /// @dev Normalize a raw token amount to 18-decimal scale for constant product math.
    ///      This ensures tokens with different decimals (e.g. USDC=6, TOWELI=18)
    ///      produce correct price ratios in the x*y=k formula.
    function _normalize0(uint256 amount) internal view returns (uint256) {
        if (decimals0 == 18) return amount;
        if (decimals0 < 18) return amount * 10 ** (18 - decimals0);
        return amount / 10 ** (decimals0 - 18);
    }

    function _normalize1(uint256 amount) internal view returns (uint256) {
        if (decimals1 == 18) return amount;
        if (decimals1 < 18) return amount * 10 ** (18 - decimals1);
        return amount / 10 ** (decimals1 - 18);
    }

    // ─── Mint LP tokens ───────────────────────────────────────────────

    function mint(address to) external nonReentrant returns (uint256 liquidity) {
        (uint112 _reserve0, uint112 _reserve1,) = getReserves();
        uint256 balance0 = IERC20(token0).balanceOf(address(this));
        uint256 balance1 = IERC20(token1).balanceOf(address(this));
        uint256 amount0 = balance0 - _reserve0;
        uint256 amount1 = balance1 - _reserve1;

        bool feeOn = _mintFee(_reserve0, _reserve1);
        uint256 _totalSupply = totalSupply();

        if (_totalSupply == 0) {
            // Use normalized amounts for initial liquidity to handle decimal differences
            uint256 norm0 = _normalize0(amount0);
            uint256 norm1 = _normalize1(amount1);
            liquidity = _sqrt(norm0 * norm1) - MINIMUM_LIQUIDITY;
            _mint(address(0xdead), MINIMUM_LIQUIDITY); // Lock minimum liquidity
        } else {
            liquidity = _min(
                (amount0 * _totalSupply) / _reserve0,
                (amount1 * _totalSupply) / _reserve1
            );
        }

        require(liquidity > 0, "INSUFFICIENT_LIQUIDITY_MINTED");
        _mint(to, liquidity);

        _update(balance0, balance1);
        if (feeOn) kLast = _normalize0(uint256(reserve0)) * _normalize1(uint256(reserve1));

        emit Mint(msg.sender, amount0, amount1);
    }

    // ─── Burn LP tokens ───────────────────────────────────────────────

    function burn(address to) external nonReentrant returns (uint256 amount0, uint256 amount1) {
        uint256 balance0 = IERC20(token0).balanceOf(address(this));
        uint256 balance1 = IERC20(token1).balanceOf(address(this));
        uint256 liquidity = balanceOf(address(this));

        bool feeOn = _mintFee(reserve0, reserve1);
        uint256 _totalSupply = totalSupply();

        amount0 = (liquidity * balance0) / _totalSupply;
        amount1 = (liquidity * balance1) / _totalSupply;
        require(amount0 > 0 && amount1 > 0, "INSUFFICIENT_LIQUIDITY_BURNED");

        _burn(address(this), liquidity);
        _safeTransfer(token0, to, amount0);
        _safeTransfer(token1, to, amount1);

        balance0 = IERC20(token0).balanceOf(address(this));
        balance1 = IERC20(token1).balanceOf(address(this));

        _update(balance0, balance1);
        if (feeOn) kLast = _normalize0(uint256(reserve0)) * _normalize1(uint256(reserve1));

        emit Burn(msg.sender, amount0, amount1, to);
    }

    // ─── Swap ─────────────────────────────────────────────────────────

    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata) external nonReentrant {
        require(amount0Out > 0 || amount1Out > 0, "INSUFFICIENT_OUTPUT_AMOUNT");
        (uint112 _reserve0, uint112 _reserve1,) = getReserves();
        require(amount0Out < _reserve0 && amount1Out < _reserve1, "INSUFFICIENT_LIQUIDITY");

        uint256 balance0;
        uint256 balance1;
        {
            require(to != token0 && to != token1, "INVALID_TO");
            if (amount0Out > 0) _safeTransfer(token0, to, amount0Out);
            if (amount1Out > 0) _safeTransfer(token1, to, amount1Out);
            balance0 = IERC20(token0).balanceOf(address(this));
            balance1 = IERC20(token1).balanceOf(address(this));
        }

        uint256 amount0In = balance0 > _reserve0 - amount0Out ? balance0 - (_reserve0 - amount0Out) : 0;
        uint256 amount1In = balance1 > _reserve1 - amount1Out ? balance1 - (_reserve1 - amount1Out) : 0;
        require(amount0In > 0 || amount1In > 0, "INSUFFICIENT_INPUT_AMOUNT");

        // Verify k invariant (with 1% total fee: 0.8% treasury + 0.2% LP)
        // Normalize to 18 decimals for correct constant product math across different-decimal pairs
        {
            uint256 normBal0 = _normalize0(balance0);
            uint256 normBal1 = _normalize1(balance1);
            uint256 normAmtIn0 = _normalize0(amount0In);
            uint256 normAmtIn1 = _normalize1(amount1In);
            uint256 normRes0 = _normalize0(uint256(_reserve0));
            uint256 normRes1 = _normalize1(uint256(_reserve1));

            uint256 balance0Adjusted = normBal0 * 1000 - normAmtIn0 * 10; // 1% = 10/1000
            uint256 balance1Adjusted = normBal1 * 1000 - normAmtIn1 * 10;
            require(balance0Adjusted * balance1Adjusted >= normRes0 * normRes1 * 1000000, "K");
        }

        _update(balance0, balance1);

        emit Swap(msg.sender, amount0In, amount1In, amount0Out, amount1Out, to);
    }

    // ─── Internal ─────────────────────────────────────────────────────

    function _update(uint256 balance0, uint256 balance1) private {
        require(balance0 <= type(uint112).max && balance1 <= type(uint112).max, "OVERFLOW");
        reserve0 = uint112(balance0);
        reserve1 = uint112(balance1);
        blockTimestampLast = uint32(block.timestamp % 2**32);
        emit Sync(reserve0, reserve1);
    }

    /// @dev Mint protocol fee (0.8% of 1% total = 80% of fees) to feeTo address.
    ///      LP providers keep 0.2% (20% of fees).
    ///      Formula: protocol gets 4/5 of fee growth, LPs keep 1/5.
    function _mintFee(uint112 _reserve0, uint112 _reserve1) private returns (bool feeOn) {
        address feeTo = ITegridyFactory(factory).feeTo();
        feeOn = feeTo != address(0);
        uint256 _kLast = kLast;
        if (feeOn) {
            if (_kLast != 0) {
                uint256 rootK = _sqrt(_normalize0(uint256(_reserve0)) * _normalize1(uint256(_reserve1)));
                uint256 rootKLast = _sqrt(_kLast);
                if (rootK > rootKLast) {
                    uint256 numerator = totalSupply() * (rootK - rootKLast) * 4; // 4/5 = 80%
                    uint256 denominator = rootK + rootKLast * 4;
                    uint256 liquidity = numerator / denominator;
                    if (liquidity > 0) _mint(feeTo, liquidity);
                }
            }
        } else if (_kLast != 0) {
            kLast = 0;
        }
    }

    function _safeTransfer(address token, address to, uint256 value) private {
        (bool success, bytes memory data) = token.call(abi.encodeWithSelector(IERC20.transfer.selector, to, value));
        require(success && (data.length == 0 || abi.decode(data, (bool))), "TRANSFER_FAILED");
    }

    function _sqrt(uint256 y) private pure returns (uint256 z) {
        if (y > 3) {
            z = y;
            uint256 x = y / 2 + 1;
            while (x < z) {
                z = x;
                x = (y / x + x) / 2;
            }
        } else if (y != 0) {
            z = 1;
        }
    }

    function _min(uint256 x, uint256 y) private pure returns (uint256) {
        return x < y ? x : y;
    }
}

interface ITegridyFactory {
    function feeTo() external view returns (address);
}
