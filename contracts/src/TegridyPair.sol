// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {FixedPointMathLib} from "solmate/utils/FixedPointMathLib.sol";

/// @title TegridyPair — Constant Product AMM Pool
/// @notice Fork of Uniswap V2 Pair adapted for Solidity 0.8.26.
///         Each pair holds two tokens and facilitates swaps using x*y=k formula.
///
///         Fee structure:
///         - 0.3% total fee on every swap (3/1000)
///         - 5/6 (~0.25%) goes to LPs (via accumulated reserves)
///         - 1/6 (~0.05%) goes to protocol (feeTo address, ~16.7% of total fees)
///
///         LP tokens (this contract is also an ERC20) represent share of pool.
///
/// @dev AUDIT NOTE #64: TWAP (time-weighted average price) accumulators are intentionally not
///      implemented. Price oracle functionality is out of scope for this AMM. External consumers
///      requiring TWAP should use Chainlink oracles or an off-chain indexer.
/// @dev AUDIT NOTE #65: EIP-2612 permit is not supported on LP tokens. Adding permit would require
///      inheriting ERC20Permit, which is deferred to a future version to avoid redeployment risk.
/// @dev AUDIT FIX C-01/C-02: Removed decimal normalization entirely. K-invariant now uses raw
///      reserves exactly like Uniswap V2, eliminating normalization inconsistency between swap()
///      and mint()/burn().
/// @dev AUDIT FIX L-03/G-03: Removed unused blockTimestampLast since TWAP is not implemented.
/// @dev SECURITY NOTE: ERC-777 tokens and tokens with transfer callbacks are NOT supported.
///      The swap() function follows the Uniswap V2 pattern of transferring tokens out before
///      updating reserves. While nonReentrant prevents re-entering THIS pair, tokens with
///      transfer hooks could callback into other protocol contracts (router, other pairs) using
///      stale reserve state. Only use standard ERC-20 tokens without transfer callbacks.
/// @dev SECURITY NOTE: Fee-on-transfer tokens are NOT supported. The router does not have
///      dedicated *SupportingFeeOnTransferTokens variants. Using FoT tokens will cause reverts
///      or silent value loss.
contract TegridyPair is ERC20, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bool private _initialized;

    address public factory;
    address public token0;
    address public token1;

    uint112 private reserve0;
    uint112 private reserve1;

    uint256 public kLast; // reserve0 * reserve1, as of immediately after the most recent liquidity event

    uint256 private constant MINIMUM_LIQUIDITY = 1000;

    event Mint(address indexed sender, uint256 amount0, uint256 amount1);
    event Burn(address indexed sender, uint256 amount0, uint256 amount1, address indexed to);
    event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to);
    event Sync(uint112 reserve0, uint112 reserve1);
    event Skim(address indexed to, uint256 amount0, uint256 amount1);
    /// @dev AUDIT FIX L-04: Emit event from initialize() for off-chain indexers.
    event Initialize(address indexed token0, address indexed token1);

    constructor() ERC20("Tegridy LP", "TGLP") {
        factory = msg.sender;
    }

    /// @dev AUDIT FIX L-04: Emits Initialize event.
    function initialize(address _token0, address _token1) external {
        require(msg.sender == factory, "FORBIDDEN");
        require(!_initialized, "ALREADY_INITIALIZED");
        require(_token0 != address(0) && _token1 != address(0), "ZERO_ADDRESS"); // AUDIT FIX L-38
        _initialized = true;
        token0 = _token0;
        token1 = _token1;
        emit Initialize(_token0, _token1);
    }

    /// @notice Returns the current reserve balances and last update timestamp.
    /// @dev AUDIT FIX I-01: _blockTimestampLast is intentionally zero. This pair does NOT support
    ///      TWAP (time-weighted average price) oracles. The field is retained solely for interface
    ///      compatibility with the Uniswap V2 IUniswapV2Pair interface. Third-party contracts
    ///      relying on cumulative price accumulators (price0CumulativeLast, price1CumulativeLast)
    ///      will NOT work with this pair. Use Chainlink or another oracle for price data.
    function getReserves() public view returns (uint112 _reserve0, uint112 _reserve1, uint32 _blockTimestampLast) {
        _reserve0 = reserve0;
        _reserve1 = reserve1;
        _blockTimestampLast = 0;
    }

    // ─── Mint LP tokens ───────────────────────────────────────────────

    function mint(address to) external nonReentrant returns (uint256 liquidity) {
        // SECURITY FIX M-1: Block minting on disabled/blocked pairs (matching swap() lines 165-167).
        // Without this, users can add liquidity to dead pairs and lose their tokens.
        require(!ITegridyFactory(factory).disabledPairs(address(this)), "PAIR_DISABLED");
        require(!ITegridyFactory(factory).blockedTokens(token0) && !ITegridyFactory(factory).blockedTokens(token1), "TOKEN_BLOCKED");
        (uint112 _reserve0, uint112 _reserve1,) = getReserves();
        uint256 balance0 = IERC20(token0).balanceOf(address(this));
        uint256 balance1 = IERC20(token1).balanceOf(address(this));
        uint256 amount0 = balance0 - _reserve0;
        uint256 amount1 = balance1 - _reserve1;

        bool feeOn = _mintFee(_reserve0, _reserve1);
        uint256 _totalSupply = totalSupply();

        if (_totalSupply == 0) {
            require(amount0 >= 1000 && amount1 >= 1000, "MIN_INITIAL_TOKENS");
            // AUDIT FIX C-01: Use raw amounts (no normalization), exactly like Uniswap V2.
            uint256 rawLiquidity = FixedPointMathLib.sqrt(amount0 * amount1);
            // Require initial liquidity to be at least 1000x MINIMUM_LIQUIDITY to make
            // first-depositor inflation attacks economically infeasible.
            require(rawLiquidity > MINIMUM_LIQUIDITY * 1000, "INSUFFICIENT_INITIAL_LIQUIDITY");
            liquidity = rawLiquidity - MINIMUM_LIQUIDITY;
            _mint(address(0xdead), MINIMUM_LIQUIDITY); // Lock minimum liquidity
        } else {
            uint256 liq0 = (amount0 * _totalSupply) / _reserve0;
            uint256 liq1 = (amount1 * _totalSupply) / _reserve1;
            liquidity = liq0 < liq1 ? liq0 : liq1;
        }

        require(liquidity > 0, "INSUFFICIENT_LIQUIDITY_MINTED");
        _mint(to, liquidity);

        _update(balance0, balance1);
        // AUDIT FIX C-02: kLast stores raw reserve0 * reserve1 (no normalization).
        if (feeOn) kLast = uint256(reserve0) * uint256(reserve1);

        emit Mint(msg.sender, amount0, amount1);
    }

    // ─── Burn LP tokens ───────────────────────────────────────────────

    // AUDIT NOTE M-02: Read-only reentrancy window exists between token transfers and _update().
    // External contracts should not rely on getReserves() during callbacks.
    /// @dev AUDIT FIX L-01: Added `to` address validation.
    function burn(address to) external nonReentrant returns (uint256 amount0, uint256 amount1) {
        require(to != address(0) && to != address(this), "INVALID_TO");

        uint256 balance0 = IERC20(token0).balanceOf(address(this));
        uint256 balance1 = IERC20(token1).balanceOf(address(this));
        uint256 liquidity = balanceOf(address(this));

        bool feeOn = _mintFee(reserve0, reserve1);
        uint256 _totalSupply = totalSupply();

        amount0 = (liquidity * balance0) / _totalSupply;
        amount1 = (liquidity * balance1) / _totalSupply;
        require(amount0 > 0 && amount1 > 0, "INSUFFICIENT_LIQUIDITY_BURNED");

        _burn(address(this), liquidity);

        // AUDIT FIX M-02: Update reserves BEFORE outbound transfers (CEI pattern).
        // Prevents read-only reentrancy where a token callback reads stale getReserves().
        _update(balance0 - amount0, balance1 - amount1);
        if (feeOn) kLast = uint256(reserve0) * uint256(reserve1);

        // Transfer tokens AFTER reserves are updated
        IERC20(token0).safeTransfer(to, amount0);
        IERC20(token1).safeTransfer(to, amount1);

        emit Burn(msg.sender, amount0, amount1, to);
    }

    // ─── Swap ─────────────────────────────────────────────────────────

    /// @dev AUDIT FIX L-02: Added `to` address validation (address(0) and address(this)).
    /// @dev AUDIT NOTE M-04 (router): The `bytes calldata` param is unused but kept for
    ///      interface compatibility with Uniswap V2 (flash swap callback pattern).
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external nonReentrant {
        require(!ITegridyFactory(factory).disabledPairs(address(this)), "PAIR_DISABLED");
        // AUDIT FIX L-05: Check blockedTokens at swap time, not just pair creation
        require(!ITegridyFactory(factory).blockedTokens(token0) && !ITegridyFactory(factory).blockedTokens(token1), "TOKEN_BLOCKED");
        // AUDIT FIX: Flash swaps are not supported — reject non-empty callback data
        require(data.length == 0, "NO_FLASH_SWAPS");
        require(amount0Out > 0 || amount1Out > 0, "INSUFFICIENT_OUTPUT_AMOUNT");
        require(to != address(0) && to != address(this), "INVALID_TO");
        (uint112 _reserve0, uint112 _reserve1,) = getReserves();
        require(amount0Out < _reserve0 && amount1Out < _reserve1, "INSUFFICIENT_LIQUIDITY");

        // SECURITY FIX H-01: Verify input tokens arrived BEFORE transferring output.
        // Read balances to compute amountIn from pre-transfer state, validate K-invariant,
        // and update reserves BEFORE any outbound transfers (checks-effects-interactions).
        // This prevents ERC-777 / callback tokens from reading stale reserves via getReserves().
        require(to != token0 && to != token1, "INVALID_TO");

        // Compute expected post-swap balances to derive input amounts
        uint256 balance0 = IERC20(token0).balanceOf(address(this));
        uint256 balance1 = IERC20(token1).balanceOf(address(this));

        uint256 amount0In = balance0 > _reserve0 ? balance0 - _reserve0 : 0;
        uint256 amount1In = balance1 > _reserve1 ? balance1 - _reserve1 : 0;
        require(amount0In > 0 || amount1In > 0, "INSUFFICIENT_INPUT_AMOUNT");

        // Compute post-swap balances (after output is transferred)
        uint256 postBalance0 = balance0 - amount0Out;
        uint256 postBalance1 = balance1 - amount1Out;

        // AUDIT FIX C-01: K-invariant check uses raw reserves (no normalization),
        // exactly like Uniswap V2.
        {
            uint256 balance0Adjusted = postBalance0 * 1000 - amount0In * 3; // 0.3% = 3/1000
            uint256 balance1Adjusted = postBalance1 * 1000 - amount1In * 3;
            require(
                balance0Adjusted * balance1Adjusted >= uint256(_reserve0) * uint256(_reserve1) * 1000000,
                "K"
            );
        }

        // SECURITY FIX H-01: Update reserves BEFORE transfers (CEI pattern).
        // Prevents cross-contract reentrancy via ERC-777 transfer callbacks
        // reading stale getReserves() on other pairs/router.
        _update(postBalance0, postBalance1);

        // Transfer output tokens AFTER reserves are updated
        if (amount0Out > 0) IERC20(token0).safeTransfer(to, amount0Out);
        if (amount1Out > 0) IERC20(token1).safeTransfer(to, amount1Out);

        emit Swap(msg.sender, amount0In, amount1In, amount0Out, amount1Out, to);
    }

    // ─── Skim & Sync ──────────────────────────────────────────────────

    /// @notice AUDIT FIX H-01: Force balances to match reserves by sending excess to `to`.
    /// @dev AUDIT NOTE M-05: skim() is permissionless (matches Uniswap V2). Tokens sent to the
    ///      pair in a separate transaction (not via Router) can be skimmed by anyone before mint().
    ///      Always use the Router for atomic transfers + mints. Direct pair interaction is unsafe.
    function skim(address to) external nonReentrant {
        require(to != address(0) && to != address(this), "INVALID_TO");
        address _token0 = token0;
        address _token1 = token1;
        uint256 amount0 = IERC20(_token0).balanceOf(address(this)) - reserve0;
        uint256 amount1 = IERC20(_token1).balanceOf(address(this)) - reserve1;
        if (amount0 > 0) IERC20(_token0).safeTransfer(to, amount0);
        if (amount1 > 0) IERC20(_token1).safeTransfer(to, amount1);
        // AUDIT FIX H-16: Emit event for off-chain monitoring
        emit Skim(to, amount0, amount1);
    }

    /// @notice AUDIT FIX H-02: Force reserves to match balances.
    function sync() external nonReentrant {
        _update(IERC20(token0).balanceOf(address(this)), IERC20(token1).balanceOf(address(this)));
    }

    // ─── Internal ─────────────────────────────────────────────────────

    /// @dev Update reserves. Balances are truncated to uint112 (max ~5.19e33).
    ///      Tokens with supply exceeding uint112.max are not supported.
    /// @dev AUDIT FIX L-03/G-03: Removed blockTimestampLast assignment (TWAP not implemented).
    function _update(uint256 balance0, uint256 balance1) private {
        require(balance0 <= type(uint112).max && balance1 <= type(uint112).max, "OVERFLOW");
        reserve0 = uint112(balance0);
        reserve1 = uint112(balance1);
        emit Sync(reserve0, reserve1);
    }

    /// @dev Mint protocol fee: 1/6 (~16.7%) of total 0.3% fee goes to feeTo address.
    ///      LP providers keep 5/6 (~0.25%) of each swap fee.
    ///      Standard Uniswap V2 formula: numerator = totalSupply * (rootK - rootKLast),
    ///      denominator = rootK * 5 + rootKLast.
    /// @dev AUDIT FIX C-02: Uses raw reserves for rootK (no normalization).
    function _mintFee(uint112 _reserve0, uint112 _reserve1) private returns (bool feeOn) {
        address feeTo = ITegridyFactory(factory).feeTo();
        feeOn = feeTo != address(0);
        uint256 _kLast = kLast;
        if (feeOn) {
            if (_kLast != 0) {
                uint256 rootK = FixedPointMathLib.sqrt(uint256(_reserve0) * uint256(_reserve1));
                uint256 rootKLast = FixedPointMathLib.sqrt(_kLast);
                if (rootK > rootKLast) {
                    uint256 numerator = totalSupply() * (rootK - rootKLast);
                    uint256 denominator = rootK * 5 + rootKLast;
                    uint256 liquidity = numerator / denominator;
                    if (liquidity > 0) _mint(feeTo, liquidity);
                }
            }
        } else if (_kLast != 0) {
            kLast = 0;
        }
    }

    // Math: Solmate FixedPointMathLib.sqrt() — battle-tested in Uniswap V3/V4, Seaport
    // Transfers: OZ SafeERC20.safeTransfer() — industry standard
    // Min: inlined as ternary operator
}

interface ITegridyFactory {
    function feeTo() external view returns (address);
    function disabledPairs(address pair) external view returns (bool);
    function blockedTokens(address token) external view returns (bool); // AUDIT FIX L-05
}
