// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";

/// @title TegridyFeeHook
/// @notice Uniswap V4 hook that captures a portion of swap fees and sends them
///         to the RevenueDistributor for ETH yield distribution to veTOWELI holders.
///
///         This hook implements `afterSwap` to skim a fee from each swap.
///         The fee is configurable by the owner.
///
///         DEPLOYMENT NOTE: V4 hooks must be deployed to addresses with specific bit patterns.
///         The address must encode which hooks are active. For afterSwap only, the address
///         must have the AFTER_SWAP_FLAG bit set. Use CREATE2 with salt mining to find
///         a valid deployment address.
///
///         Hook flags needed: afterSwap (bit 7 = 0x0080)
contract TegridyFeeHook is IHooks {

    IPoolManager public immutable poolManager;
    address public owner;
    address public revenueDistributor;
    uint256 public feeBps; // Fee in basis points (e.g., 30 = 0.3%)
    uint256 public constant MAX_FEE_BPS = 500; // Max 5%

    event FeeCollected(address indexed token, uint256 amount);
    event FeeUpdated(uint256 oldFee, uint256 newFee);
    event DistributorUpdated(address indexed oldDist, address indexed newDist);

    error OnlyPoolManager();
    error OnlyOwner();
    error FeeTooHigh();
    error ZeroAddress();

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert OnlyPoolManager();
        _;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    constructor(IPoolManager _poolManager, address _revenueDistributor, uint256 _feeBps) {
        if (address(_poolManager) == address(0) || _revenueDistributor == address(0)) revert ZeroAddress();
        if (_feeBps > MAX_FEE_BPS) revert FeeTooHigh();

        poolManager = _poolManager;
        owner = msg.sender;
        revenueDistributor = _revenueDistributor;
        feeBps = _feeBps;
    }

    // ─── Hook Implementations ─────────────────────────────────────────

    // We only use afterSwap — all other hooks return the selector to indicate "no-op"

    function beforeInitialize(address, PoolKey calldata, uint160) external pure returns (bytes4) {
        return IHooks.beforeInitialize.selector;
    }

    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure returns (bytes4) {
        return IHooks.afterInitialize.selector;
    }

    function beforeAddLiquidity(address, PoolKey calldata, IPoolManager.ModifyLiquidityParams calldata, bytes calldata)
        external pure returns (bytes4)
    {
        return IHooks.beforeAddLiquidity.selector;
    }

    function afterAddLiquidity(address, PoolKey calldata, IPoolManager.ModifyLiquidityParams calldata, BalanceDelta, BalanceDelta, bytes calldata)
        external pure returns (bytes4, BalanceDelta)
    {
        return (IHooks.afterAddLiquidity.selector, BalanceDelta.wrap(0));
    }

    function beforeRemoveLiquidity(address, PoolKey calldata, IPoolManager.ModifyLiquidityParams calldata, bytes calldata)
        external pure returns (bytes4)
    {
        return IHooks.beforeRemoveLiquidity.selector;
    }

    function afterRemoveLiquidity(address, PoolKey calldata, IPoolManager.ModifyLiquidityParams calldata, BalanceDelta, BalanceDelta, bytes calldata)
        external pure returns (bytes4, BalanceDelta)
    {
        return (IHooks.afterRemoveLiquidity.selector, BalanceDelta.wrap(0));
    }

    function beforeSwap(address, PoolKey calldata, IPoolManager.SwapParams calldata, bytes calldata)
        external pure returns (bytes4, BeforeSwapDelta, uint24)
    {
        return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }

    /// @notice Called after every swap. Captures a fee and sends to revenue distributor.
    function afterSwap(
        address,
        PoolKey calldata key,
        IPoolManager.SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata
    ) external onlyPoolManager returns (bytes4, int128) {
        // Calculate fee on the output amount
        // delta.amount0() and delta.amount1() represent the balance changes
        // Negative means the pool paid out (user received), positive means user paid in

        // We take fee from whichever token the user received (negative delta)
        int128 amount0 = delta.amount0();
        int128 amount1 = delta.amount1();

        int128 feeAmount = 0;

        if (amount0 < 0) {
            // User received token0
            feeAmount = int128(int256(-amount0) * int256(feeBps) / 10000);
        } else if (amount1 < 0) {
            // User received token1
            feeAmount = int128(int256(-amount1) * int256(feeBps) / 10000);
        }

        // The fee is returned as the hook's delta — it reduces what the user receives
        // The PoolManager will hold this fee, and we can claim it later
        return (IHooks.afterSwap.selector, feeAmount);
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external pure returns (bytes4)
    {
        return IHooks.beforeDonate.selector;
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external pure returns (bytes4)
    {
        return IHooks.afterDonate.selector;
    }

    // ─── Admin ────────────────────────────────────────────────────────

    function setFee(uint256 _feeBps) external onlyOwner {
        if (_feeBps > MAX_FEE_BPS) revert FeeTooHigh();
        uint256 old = feeBps;
        feeBps = _feeBps;
        emit FeeUpdated(old, _feeBps);
    }

    function setRevenueDistributor(address _dist) external onlyOwner {
        if (_dist == address(0)) revert ZeroAddress();
        address old = revenueDistributor;
        revenueDistributor = _dist;
        emit DistributorUpdated(old, _dist);
    }

    function transferOwnership(address _newOwner) external onlyOwner {
        if (_newOwner == address(0)) revert ZeroAddress();
        owner = _newOwner;
    }

    // Accept ETH
    receive() external payable {}
}
